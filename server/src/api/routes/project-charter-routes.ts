import type { Context, Hono } from 'hono'
import type { ProjectCharterPerson, ProjectCharterState } from '@mukuroji/contracts'
import { CognitoServiceError } from '../../modules/authentication'
import {
  createProjectCharter,
  decideProjectLifecycleTransition,
  createProjectCharterPerson,
  ProjectDataError,
  readProjectCharterUpdate,
  readProjectLifecycleTransition,
  type ProjectDirectoryProjectResponse,
  type ProjectDirectoryTeamResponse,
} from '../../modules/directory'
import {
  WorkspaceAccessError,
  type WorkspaceAccessTransactWriteItem,
} from '../../modules/workspace-access/workspace-access'

/** Commit-time proof that a charter person is still an active Workspace member. */
type ProjectCharterPersonConditionCheck = WorkspaceAccessTransactWriteItem
import { authenticationDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { createProjectSearchDocument } from '../shared/document-access'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  createApiMutationContext,
  hasEnterprisePermissionAtWorkspace,
  requireProjectPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { projectWorkspaceSearchDocumentBestEffort } from '../shared/search-access'

/**
 * Registers the Project charter and lifecycle endpoints.
 *
 * Reads require viewer access to the Project. Charter edits and lifecycle transitions require a
 * Workspace administrator or a manager of the Project; deciding on a `proposed` Project requires
 * a Workspace administrator because it is the approval step.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerProjectCharterRoutes(routeApp: Hono): void {
  /** Returns the charter and lifecycle state of one Team-owned Project. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/charter', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)

    try {
      const { teamId, projectId } = readProjectRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      await requireProjectPermission(principal, projectId, 'viewer')
      return c.json(await workspaceDependencies.projectDirectory.getProjectCharter(
        principal.directoryId,
        teamId,
        projectId,
      ) satisfies ProjectCharterState)
    } catch (error) {
      return toProjectCharterErrorResponse(c, error)
    }
  })

  /** Replaces the charter of one Team-owned Project. */
  routeApp.put('/api/teams/:teamId/projects/:projectId/charter', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)

    try {
      const { teamId, projectId } = readProjectRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectCharterManagement(principal, projectId)
      const body = await readJson<unknown>(c.req)
      const update = readProjectCharterUpdate(body)
      if (!update.ok) throw new ProjectDataError(400, update.code, update.message)
      const [owner, sponsor] = await Promise.all([
        resolveCharterPerson(principal.directoryId, update.value.ownerUserId),
        resolveCharterPerson(principal.directoryId, update.value.sponsorUserId),
      ])
      const charter = createProjectCharter(update.value, {
        ...(owner === undefined ? {} : { owner: owner.person }),
        ...(sponsor === undefined ? {} : { sponsor: sponsor.person }),
      })
      // One check per member row: DynamoDB rejects a transaction naming one item twice.
      const personConditionChecks = [...new Map(
        [owner, sponsor].flatMap((resolved) =>
          resolved?.conditionCheck === undefined ? [] : [[resolved.person.userId, resolved.conditionCheck] as const]
        ),
      ).values()]
      const state = await workspaceDependencies.projectDirectory.updateProjectCharter(
        principal.directoryId,
        teamId,
        projectId,
        update.value.expectedRevision,
        charter,
        createApiMutationContext(c, principal, { teamId, projectId, ...update.value }),
        personConditionChecks,
      )
      await projectCharterSearchDocumentBestEffort(principal.directoryId, state)
      return c.json(state satisfies ProjectCharterState)
    } catch (error) {
      return toProjectCharterErrorResponse(c, error)
    }
  })

  /** Moves one Team-owned Project to another lifecycle state. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/lifecycle', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)

    try {
      const { teamId, projectId } = readProjectRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const transition = readProjectLifecycleTransition(await readJson<unknown>(c.req))
      if (!transition.ok) throw new ProjectDataError(400, transition.code, transition.message)
      await requireProjectCharterManagement(principal, projectId)
      const current = await workspaceDependencies.projectDirectory.getProjectCharter(
        principal.directoryId,
        teamId,
        projectId,
      )
      if (current.lifecycleState === 'proposed') requireProjectProposalDecision(principal)
      const decision = decideProjectLifecycleTransition(current, transition.value)
      if (!decision.ok) throw new ProjectDataError(409, decision.code, decision.message)
      return c.json(await workspaceDependencies.projectDirectory.transitionProjectLifecycle(
        principal.directoryId,
        teamId,
        projectId,
        transition.value.expectedRevision,
        decision.to,
        createApiMutationContext(c, principal, { teamId, projectId, ...transition.value }),
      ) satisfies ProjectCharterState)
    } catch (error) {
      return toProjectCharterErrorResponse(c, error)
    }
  })
}

/**
 * Reads the Team and Project identifiers of a charter route.
 *
 * @param c - Hono request context.
 * @returns Validated route identifiers.
 */
function readProjectRoute(c: Context) {
  const teamId = c.req.param('teamId')?.trim()
  const projectId = c.req.param('projectId')?.trim()
  if (!teamId || !projectId) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Team ID and Project ID are required.')
  }
  return { teamId, projectId }
}

/**
 * Requires a Workspace administrator or a manager of the Project.
 *
 * @param principal - Authenticated Workspace principal.
 * @param projectId - Project whose charter is changed.
 */
async function requireProjectCharterManagement(principal: WorkspacePrincipal, projectId: string) {
  try {
    requireWorkspaceAdministration(principal)
    return
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error
  }
  await requireProjectPermission(principal, projectId, 'manager')
}

/**
 * Requires Workspace-level administration to approve or reject a proposed Project.
 *
 * A proposal decision is the approval step, so it must come from the Workspace rather than from
 * a grant scoped to this Project or its Team. Enterprise principals need `projects.manage` or
 * `workspace.manage` evaluated at the Workspace resource.
 *
 * @param principal - Authenticated Workspace principal.
 */
function requireProjectProposalDecision(principal: WorkspacePrincipal) {
  const allowed = principal.enterprisePermissions === undefined
    ? principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
    : hasEnterprisePermissionAtWorkspace(principal, 'projects.manage') ||
      hasEnterprisePermissionAtWorkspace(principal, 'workspace.manage')
  if (!allowed) {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'Only a Workspace administrator can approve or reject a proposed Project.',
    )
  }
}

/**
 * Resolves a charter person to an active Workspace member with a display snapshot.
 *
 * The returned condition check proves the member is still active, at the version read here,
 * when the charter write commits, so a concurrent deactivation cannot be saved as owner or
 * sponsor.
 *
 * @param workspaceId - Workspace that owns the Project.
 * @param userId - Optional member key from the request.
 * @returns The person snapshot and its membership fence, or undefined when no person is named.
 */
async function resolveCharterPerson(
  workspaceId: string,
  userId: string | undefined,
): Promise<{ person: ProjectCharterPerson; conditionCheck?: ProjectCharterPersonConditionCheck } | undefined> {
  if (userId === undefined) return undefined
  const profile = await authenticationDependencies.cognito.getUserProfile(userId)
  const workspaceAccess = workspaceDependencies.workspaceAccess
  const inactive = () => new ProjectDataError(
    409,
    'ProjectCharterPersonInactive',
    'The Project manager and sponsor must be active Workspace members.',
  )
  const person = createProjectCharterPerson(profile.id, profile.name, profile.email)
  if (!workspaceAccess.createActiveMemberConditionCheck) {
    if (!await workspaceAccess.getActiveMember(workspaceId, profile.id)) throw inactive()
    return { person }
  }
  const conditionCheck = await workspaceAccess.createActiveMemberConditionCheck.call(
    workspaceAccess,
    workspaceId,
    profile.id,
  )
  if (!conditionCheck) throw inactive()
  return { person, conditionCheck }
}

/**
 * Re-projects the Project search document so its charter text becomes searchable.
 *
 * @param workspaceId - Workspace that owns the Project.
 * @param state - Committed charter state.
 */
async function projectCharterSearchDocumentBestEffort(workspaceId: string, state: ProjectCharterState) {
  let names: { name: string; englishName?: string; project: ProjectDirectoryProjectResponse } | undefined
  try {
    const [japanese, english] = await Promise.all([
      workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja'),
      workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'en'),
    ])
    const findProject = (teams: readonly ProjectDirectoryTeamResponse[]) => teams
      .find((team) => team.id === state.teamId)
      ?.projects.find((project) => project.id === state.projectId)
    const project = findProject(japanese.teams)
    if (project) {
      const englishName = findProject(english.teams)?.name
      names = {
        name: project.name,
        project,
        ...(englishName && englishName !== project.name ? { englishName } : {}),
      }
    }
  } catch (error) {
    console.error('Workspace search projection failed after project charter update.', error)
    return
  }
  if (!names) return
  const resolved = names
  await projectWorkspaceSearchDocumentBestEffort(
    () => createProjectSearchDocument(
      workspaceId,
      state.teamId,
      resolved.project,
      undefined,
      resolved.englishName,
      state.charter,
    ),
    'project charter update',
  )
}

/**
 * Maps charter route failures to HTTP responses.
 *
 * @param c - Hono request context.
 * @param error - Failure raised by the route.
 * @returns The HTTP error response.
 */
function toProjectCharterErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    if (error.code === 'UserNotFoundException') {
      return c.json({
        code: 'ProjectCharterPersonInactive',
        message: 'The Project manager and sponsor must be active Workspace members.',
      }, 409)
    }
    if (error.code === 'NotAuthorizedException' || error.code === 'CognitoAccessTokenInvalid') {
      return toAuthErrorResponse(c, error)
    }
    return toCognitoDirectoryErrorResponse(c, error)
  }
  return toProjectDataErrorResponse(c, error)
}
