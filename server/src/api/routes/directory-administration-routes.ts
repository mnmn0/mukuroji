import type { Context, Hono } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { createTeamWorkspaceSearchDocument } from '../../modules/workspace-search/workspace-search'
import { workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  createApiMutationContext,
  requireWorkspaceAdministration,
  toProjectDataErrorResponse,
} from '../shared/project-access'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  deleteWorkspaceSearchDocumentBestEffort,
  isWorkspaceSearchProjectionEnabled,
  projectWorkspaceSearchDocumentBestEffort,
} from '../shared/search-access'
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
      await projectTeamSearchDocument(
        principal.directoryId,
        teamId,
        renamed.response.nameJa,
        renamed.response.nameEn,
        renamed.nameRevision,
        'team rename',
        renamed.creatorUserId,
      )
      return renamed.response
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
      await projectTeamSearchDocument(
        principal.directoryId,
        teamId,
        restored.nameJa,
        restored.nameEn,
        restored.nameRevision,
        'team restore',
        restored.creatorUserId,
      )
      return restored.response
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
  DirectoryAuthorizationChanged: 403,
  DirectoryOrderConflict: 409,
  TeamNotArchived: 409,
  ProjectNotArchived: 409,
  TeamArchived: 409,
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

  return value
}

/**
 * Re-projects a Team search document after its names became visible or changed.
 *
 * The rename count fences the write, so a delayed projection of an older name cannot replace the
 * document of a newer rename. A never-renamed Team leaves a renamed document alone.
 *
 * @param workspaceId - Workspace that owns the Team.
 * @param teamId - Team identifier.
 * @param nameJa - Japanese display name.
 * @param nameEn - English display name.
 * @param nameRevision - Rename count stored with these names.
 * @param operation - Operation label used when logging a projection failure.
 * @param creatorUserId - Creator recorded on the Team row; without it the stored creator is kept.
 */
export async function projectTeamSearchDocument(
  workspaceId: string,
  teamId: string,
  nameJa: string,
  nameEn: string,
  nameRevision: number,
  operation: string,
  creatorUserId?: string,
) {
  const sourceRevision = nameRevision > 0 ? nameRevision : undefined
  await projectWorkspaceSearchDocumentBestEffort(
    () => createTeamWorkspaceSearchDocument({
      workspaceId,
      teamId,
      title: nameJa,
      ...(nameEn === nameJa ? {} : { subtitle: nameEn }),
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      ...(creatorUserId ? { creatorUserId } : {}),
    }),
    operation,
    // Teams created before the row recorded its creator keep the creator projected at creation.
    sourceRevision === undefined
      ? { preserveCreator: true, unrevisioned: true }
      : { preserveCreator: true, sourceRevision },
  )
}

/**
 * Deletes the search document of an archived Team, then projects it again if a restore committed
 * meanwhile.
 *
 * A restore that commits after the archive can project its document before this delete runs; the
 * strongly consistent re-read after the delete sees that restore, and any later restore projects
 * after the re-read on its own.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Archived Team identifier.
 */
export async function deleteArchivedTeamSearchDocument(workspaceId: string, teamId: string) {
  if (!isWorkspaceSearchProjectionEnabled()) return
  await deleteWorkspaceSearchDocumentBestEffort(workspaceId, 'team', `team/${teamId}`, 'team archive')
  try {
    const source = await workspaceDependencies.projectDirectory.getTeamSearchSource(workspaceId, teamId)
    if (!source) return
    await projectTeamSearchDocument(
      workspaceId,
      teamId,
      source.nameJa,
      source.nameEn,
      source.nameRevision,
      'team restore during archive',
      source.creatorUserId,
    )
  } catch (error) {
    console.error('Workspace search projection failed after team archive.', error)
  }
}

/**
 * Deletes the search document of an archived Project, then projects it again if a restore
 * committed meanwhile.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Team that owns the Project.
 * @param projectId - Archived Project identifier.
 */
export async function deleteArchivedProjectSearchDocument(
  workspaceId: string,
  teamId: string,
  projectId: string,
) {
  if (!isWorkspaceSearchProjectionEnabled()) return
  await deleteWorkspaceSearchDocumentBestEffort(
    workspaceId,
    'project',
    `team/${teamId}/project/${projectId}`,
    'project archive',
  )
  // Reads the Project consistently and projects it only when it is active again.
  await projectProjectSearchDocumentBestEffort(
    workspaceId,
    teamId,
    projectId,
    'project restore during archive',
  )
}
