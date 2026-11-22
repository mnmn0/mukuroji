import type { Context, Hono } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError, type TeamSearchSource } from '../../modules/directory'
import { createTeamWorkspaceSearchDocument } from '../../modules/workspace-search/workspace-search'
import {
  isDirectoryTeamMemberRole,
  type AddDirectoryTeamMemberResponse,
} from '@mukuroji/contracts'
import { authenticationDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { isRecord } from '../shared/value-guards'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  createApiMutationContext,
  requireWorkspaceAdministration,
  toProjectDataErrorResponse,
} from '../shared/project-access'
import { readDirectoryArchiveImpact } from '../shared/directory-archive-impact'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { syncDirectorySearchDocumentBestEffort } from '../shared/search-access'
import { projectProjectSearchDocumentBestEffort } from './project-charter-routes'

/**
 * Registers the endpoints that rename, restore, and reorder Teams and Projects.
 *
 * Every endpoint requires Workspace administration, the same as creating or archiving a Team or
 * Project. IDs never change, so URLs and links keep working after a rename.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerDirectoryAdministrationRoutes(routeApp: Hono): void {
  /** Lists every Team and Project, archived ones included, with both localized names. */
  routeApp.get('/api/teams/directory', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) =>
      await workspaceDependencies.projectDirectory.getDirectoryAdministration(
        principal.directoryId,
      ))
  })

  /** Counts what archiving an active Team affects, before the archive is confirmed. */
  routeApp.get('/api/teams/:teamId/archive-impact', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) =>
      await readDirectoryArchiveImpact(principal.directoryId, {
        kind: 'team',
        teamId: readRouteIdentifier(c, 'teamId'),
      }))
  })

  /** Counts what archiving an active Project affects, before the archive is confirmed. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/archive-impact', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) =>
      await readDirectoryArchiveImpact(principal.directoryId, {
        kind: 'project',
        teamId: readRouteIdentifier(c, 'teamId'),
        projectId: readRouteIdentifier(c, 'projectId'),
      }))
  })

  /** Sets the display order of every active Team. */
  routeApp.put('/api/teams/order', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const body = await readJson<unknown>(c.req)
      return await workspaceDependencies.projectDirectory.reorderTeams(
        principal.directoryId,
        body,
        createApiMutationContext(c, principal, body ?? {}),
      
        createDirectoryAuthorizationChecks(principal),
      )
    })
  })

  /** Renames an active Team. */
  routeApp.patch('/api/teams/:teamId', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const body = await readJson<unknown>(c.req)
      const renamed = await workspaceDependencies.projectDirectory.renameTeam(
        principal.directoryId,
        teamId,
        body,
        createApiMutationContext(c, principal, { teamId, body }),
      
        createDirectoryAuthorizationChecks(principal),
      )
      await projectTeamSearchDocumentBestEffort(principal.directoryId, teamId, 'team rename')
      return renamed
    })
  })

  /** Replaces the description and leader of an active Team. */
  routeApp.patch('/api/teams/:teamId/profile', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const body = await readJson<unknown>(c.req)
      const leaderMemberKey = isRecord(body) && typeof body.leaderMemberKey === 'string'
        ? await readActiveWorkspaceMemberKey(principal.directoryId, body.leaderMemberKey)
        : undefined
      const input = isRecord(body) && leaderMemberKey !== undefined ? { ...body, leaderMemberKey } : body
      return await workspaceDependencies.projectDirectory.updateTeamProfile(
        principal.directoryId,
        teamId,
        input,
        createApiMutationContext(c, principal, { teamId, body: input }),
        createDirectoryAuthorizationChecks(principal),
      )
    })
  })

  /**
   * Adds one Workspace member to every active Project of an active Team. Projects the member
   * already belongs to keep their role, so a retry after a partial failure adds only the rest.
   */
  routeApp.post('/api/teams/:teamId/members', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const body = await readJson<unknown>(c.req)
      if (!isRecord(body) || typeof body.memberKey !== 'string' || !isDirectoryTeamMemberRole(body.role)) {
        throw new ProjectDataError(400, 'InvalidProjectWrite', 'memberKey and role are required.')
      }
      const role = body.role
      const profile = await readMemberProfile(body.memberKey)
      const directory = await workspaceDependencies.projectDirectory.getDirectoryAdministration(
        principal.directoryId,
      )
      const team = directory.teams.find((candidate) =>
        candidate.id === teamId && candidate.archivedAt === undefined
      )
      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const response: AddDirectoryTeamMemberResponse = {
        teamId,
        memberKey: profile.id,
        addedProjectIds: [],
        existingProjectIds: [],
      }
      for (const project of team.projects) {
        if (project.archivedAt !== undefined) continue
        const members = await workspaceDependencies.projectDirectory.getProjectMembers(
          principal.directoryId,
          project.id,
          teamId,
        )
        // Project member rows store the key normalized, the same as `updateProjectMember`.
        const storedMemberKey = profile.id.trim().toLowerCase()
        if (members.members.some((member) => member.id === storedMemberKey)) {
          response.existingProjectIds.push(project.id)
          continue
        }
        // Each grant advances the member's version, so it is read again before every Project.
        const workspaceMember = await requireActiveWorkspaceMember(principal.directoryId, profile.id)
        await workspaceDependencies.projectDirectory.updateProjectMember(
          principal.directoryId,
          project.id,
          profile.id,
          { role, email: profile.email, name: profile.name },
          workspaceMember.version,
          createApiMutationContext(c, principal, {
            teamId,
            projectId: project.id,
            memberKey: profile.id,
            role,
          }),
        )
        response.addedProjectIds.push(project.id)
      }
      return response
    })
  })

  /** Restores an archived Team. */
  routeApp.patch('/api/teams/:teamId/restore', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const restored = await workspaceDependencies.projectDirectory.restoreTeam(
        principal.directoryId,
        teamId,
        createApiMutationContext(c, principal, { teamId }),
      
        createDirectoryAuthorizationChecks(principal),
      )
      await projectTeamSearchDocumentBestEffort(principal.directoryId, teamId, 'team restore')
      return restored
    })
  })

  /** Sets the display order of every active Project of one Team. */
  routeApp.put('/api/teams/:teamId/project-order', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const body = await readJson<unknown>(c.req)
      return await workspaceDependencies.projectDirectory.reorderProjects(
        principal.directoryId,
        teamId,
        body,
        createApiMutationContext(c, principal, { teamId, body }),
      
        createDirectoryAuthorizationChecks(principal),
      )
    })
  })

  /** Renames an active Project or changes its color. */
  routeApp.patch('/api/teams/:teamId/projects/:projectId', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const projectId = readRouteIdentifier(c, 'projectId')
      const body = await readJson<unknown>(c.req)
      const response = await workspaceDependencies.projectDirectory.renameProject(
        principal.directoryId,
        teamId,
        projectId,
        body,
        createApiMutationContext(c, principal, { teamId, projectId, body }),
      
        createDirectoryAuthorizationChecks(principal),
      )
      await projectProjectSearchDocumentBestEffort(
        principal.directoryId,
        teamId,
        projectId,
        'project rename or restore',
      )
      return response
    })
  })

  /** Restores an archived Project of an active Team. */
  routeApp.patch('/api/teams/:teamId/projects/:projectId/restore', async (c) => {
    return await handleDirectoryAdministration(c, async (principal) => {
      const teamId = readRouteIdentifier(c, 'teamId')
      const projectId = readRouteIdentifier(c, 'projectId')
      const response = await workspaceDependencies.projectDirectory.restoreProject(
        principal.directoryId,
        teamId,
        projectId,
        createApiMutationContext(c, principal, { teamId, projectId }),
      
        createDirectoryAuthorizationChecks(principal),
      )
      await projectProjectSearchDocumentBestEffort(
        principal.directoryId,
        teamId,
        projectId,
        'project rename or restore',
      )
      return response
    })
  })
}

/** Authenticated principal passed to a directory administration handler. */
type DirectoryAdministrationPrincipal = Awaited<ReturnType<typeof authenticateWorkspacePrincipal>>

/**
 * Authenticates a Workspace administrator, runs the handler, and maps failures to responses.
 *
 * @param c - Hono request context.
 * @param handler - Work to run for the authenticated administrator.
 * @returns The JSON response.
 */
async function handleDirectoryAdministration(
  c: Context,
  handler: (principal: DirectoryAdministrationPrincipal) => Promise<object>,
) {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    return c.json(await handler(principal))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    if (error instanceof ProjectDataError) {
      const status = directoryAdministrationErrorStatuses[error.code]
      if (status !== undefined) {
        return c.json({ code: error.code, message: error.message }, status)
      }
    }

    return toProjectDataErrorResponse(c, error)
  }
}

/**
 * Expected directory administration failures, answered with their status and stable code so the
 * client can tell a stale list or a concurrent change from an infrastructure failure.
 */
const directoryAdministrationErrorStatuses: Partial<Record<string, 400 | 403 | 409 | 413 | 503>> = {
  InvalidDirectoryOrder: 400,
  InvalidProjectWrite: 400,
  WorkspaceMemberInactive: 409,
  WorkspaceMemberVersionConflict: 409,
  DirectoryAuthorizationChanged: 403,
  DirectoryOrderConflict: 409,
  TeamNotArchived: 409,
  ProjectNotArchived: 409,
  TeamArchived: 409,
  IdempotencyKeyConflict: 409,
  DirectoryArchiveCleanupPending: 409,
  DirectoryOrderLimitExceeded: 413,
  PlanningUnavailable: 503,
}

/**
 * Builds the guards that the administrator is still an active member with the same membership
 * version and Enterprise control revision when a directory change commits, so privileges revoked
 * after authentication cannot authorize the write.
 *
 * @param principal - Authenticated administrator.
 * @returns Condition checks added to the directory transaction.
 */
function createDirectoryAuthorizationChecks(principal: DirectoryAdministrationPrincipal) {
  return createPlanningCallerAuthorizationConditionChecks(
    principal,
    [],
    principal.principalKind !== 'service-account',
  )
}

/**
 * Resolves a member key to the identity of an active Workspace member.
 *
 * @param directoryId - Workspace identifier.
 * @param memberKey - Untrusted member key from the request.
 * @returns The stored member key of the active member.
 */
async function readActiveWorkspaceMemberKey(directoryId: string, memberKey: string) {
  const profile = await readMemberProfile(memberKey)
  await requireActiveWorkspaceMember(directoryId, profile.id)
  return profile.id
}

/**
 * Reads the Cognito profile of a member chosen by an administrator. An unknown or malformed
 * member is refused like an inactive one, so it is never answered as a failed sign-in.
 *
 * @param memberKey - Untrusted member key from the request.
 * @returns The member profile.
 */
async function readMemberProfile(memberKey: string) {
  try {
    return await authenticationDependencies.cognito.getUserProfile(memberKey)
  } catch (error) {
    if (
      error instanceof CognitoServiceError &&
      (error.code === 'UserNotFoundException' || error.code === 'InvalidParameterException')
    ) {
      throw new ProjectDataError(
        409,
        'WorkspaceMemberInactive',
        'Only active Workspace members can lead a Team or be added to its Projects.',
      )
    }
    throw error
  }
}

/**
 * Reads an active Workspace member, refusing a deactivated or missing one.
 *
 * @param directoryId - Workspace identifier.
 * @param memberKey - Stored member key.
 * @returns The active member.
 */
async function requireActiveWorkspaceMember(directoryId: string, memberKey: string) {
  const member = await workspaceDependencies.workspaceAccess.getActiveMember(directoryId, memberKey)
  if (!member) {
    throw new ProjectDataError(
      409,
      'WorkspaceMemberInactive',
      'Only active Workspace members can lead a Team or be added to its Projects.',
    )
  }
  return member
}

/**
 * Reads a required, trimmed route parameter.
 *
 * @param c - Hono request context.
 * @param name - Route parameter name.
 * @returns The parameter value.
 */
function readRouteIdentifier(c: Context, name: 'teamId' | 'projectId') {
  const value = c.req.param(name)?.trim()

  if (!value) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', `${name} is required.`)
  }

  // Matches the reorder list bound, and keeps an oversized key from reaching DynamoDB as a 500.
  if (value.length > DIRECTORY_ROUTE_IDENTIFIER_MAX_LENGTH || /\p{Cc}/u.test(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', `${name} is invalid.`)
  }

  return value
}

/** Longest Team or Project identifier a directory administration route accepts. */
const DIRECTORY_ROUTE_IDENTIFIER_MAX_LENGTH = 256

/**
 * Brings the Team search document in line with one strongly consistent read of the Team.
 *
 * The source revision is the rename count plus the archive and restore count, so a delayed
 * projection of an older name or lifecycle cannot replace the document of a newer one, and an
 * archived Team's document is removed. Teams created before the row recorded its creator keep
 * the creator projected at creation.
 *
 * @param workspaceId - Workspace that owns the Team.
 * @param teamId - Team identifier.
 * @param operation - Operation label used when logging a projection failure.
 */
export async function projectTeamSearchDocumentBestEffort(
  workspaceId: string,
  teamId: string,
  operation: string,
) {
  await syncDirectorySearchDocumentBestEffort(
    workspaceId,
    'team',
    `team/${teamId}`,
    () => workspaceDependencies.projectDirectory.getTeamSearchSource(workspaceId, teamId),
    (source: TeamSearchSource) => createTeamWorkspaceSearchDocument({
      workspaceId,
      teamId,
      title: source.nameJa,
      ...(source.nameEn === source.nameJa ? {} : { subtitle: source.nameEn }),
      ...(source.sourceRevision > 0 ? { sourceRevision: source.sourceRevision } : {}),
      ...(source.creatorUserId ? { creatorUserId: source.creatorUserId } : {}),
    }),
    operation,
  )
}
