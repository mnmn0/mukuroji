import type { Context, Hono } from 'hono'
import type { ProjectCharterState, ProjectCharterViewerCapabilities } from '@mukuroji/contracts'
import { CognitoServiceError } from '../../modules/authentication'
import {
  createProjectCharterPerson,
  ProjectDataError,
  transitionProjectLifecycleUseCase,
  updateProjectCharterUseCase,
  type ProjectCharterCallerAuthorization,
  type ProjectSearchSource,
  type ResolvedProjectCharterPerson,
} from '../../modules/directory'
import {
  WorkspaceAccessError,
  type WorkspaceAccessTransactWriteItem,
} from '../../modules/workspace-access/workspace-access'

/** Commit-time proof that a charter person is still an active Workspace member. */
type ProjectCharterPersonConditionCheck = WorkspaceAccessTransactWriteItem
import { authenticationDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { createProjectSearchDocument } from '../shared/document-access'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  canWorkspaceBusinessWrite,
  createApiMutationContext,
  hasEnterprisePermissionAtResource,
  hasEnterprisePermissionAtWorkspace,
  requireProjectPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { syncDirectorySearchDocumentBestEffort } from '../shared/search-access'

/**
 * Registers the Project charter and lifecycle endpoints.
 *
 * Reads require viewer access to the Project or Workspace administration. Charter edits and lifecycle transitions require a
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
      await requireProjectCharterRead(principal, projectId)
      const [state, viewer] = await Promise.all([
        workspaceDependencies.projectDirectory.getProjectCharter(principal.directoryId, teamId, projectId),
        describeProjectCharterViewer(principal, teamId, projectId),
      ])
      return c.json({ ...state, viewer } satisfies ProjectCharterState)
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
      const state = await updateProjectCharterUseCase(
        {
          store: workspaceDependencies.projectDirectory,
          resolvePerson: resolveCharterPerson,
          projectSearchDocument: projectCharterSearchDocumentBestEffort,
          callerAuthorization: createCharterCallerAuthorization(principal),
        },
        { workspaceId: principal.directoryId, teamId, projectId },
        await readJson<unknown>(c.req),
        (update) => createApiMutationContext(c, principal, update),
      )
      return c.json({ ...state, viewer: await describeProjectCharterViewer(principal, teamId, projectId) } satisfies ProjectCharterState)
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
      await requireProjectCharterManagement(principal, projectId)
      const state = await transitionProjectLifecycleUseCase(
        {
          store: workspaceDependencies.projectDirectory,
          requireProposalDecision: () => requireProjectProposalDecision(principal),
          callerAuthorization: createCharterCallerAuthorization(principal),
        },
        { workspaceId: principal.directoryId, teamId, projectId },
        await readJson<unknown>(c.req),
        (transition) => createApiMutationContext(c, principal, transition),
      )
      return c.json({ ...state, viewer: await describeProjectCharterViewer(principal, teamId, projectId) } satisfies ProjectCharterState)
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
 * Requires the principal to read the charter of a Project.
 *
 * Workspace administrators may edit any charter without a Project role, so they may also read
 * it; everyone else needs viewer access to the Project.
 *
 * @param principal - Authenticated Workspace principal.
 * @param projectId - Project whose charter is read.
 */
async function requireProjectCharterRead(principal: WorkspacePrincipal, projectId: string) {
  try {
    requireWorkspaceAdministration(principal)
    return
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error
  }
  await requireProjectPermission(principal, projectId, 'viewer')
}

/**
 * Builds the commit-time fences of the caller's authorization.
 *
 * The caller's membership row is pinned at the version read for this request, and Project role
 * changes advance that version, so a downgraded manager fails the write. Enterprise principals
 * also pin the Workspace CONTROL revision, which every role or assignment change advances.
 * Service accounts have no membership row, so only the CONTROL revision applies to them.
 *
 * @param principal - Principal the route authorized.
 * @returns The fences and the member key they pin.
 */
function createCharterCallerAuthorization(
  principal: WorkspacePrincipal,
): ProjectCharterCallerAuthorization<ProjectCharterPersonConditionCheck> {
  const isMember = principal.principalKind !== 'service-account'
  return {
    ...(isMember ? { memberKey: principal.userKey } : {}),
    fences: createPlanningCallerAuthorizationConditionChecks(principal, [], isMember),
  }
}

/**
 * Decides which charter actions the principal may take, as the write routes would decide them.
 *
 * The current request is a read, so its route authorization proves only `projects.read`. Enterprise
 * principals are therefore re-evaluated for `projects.manage` at this Project, and other principals
 * go through the same role checks as the write routes.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose charter is shown.
 * @returns The viewer's charter capabilities.
 */
async function describeProjectCharterViewer(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
): Promise<ProjectCharterViewerCapabilities> {
  const allowed = async (check: () => unknown) => {
    try {
      await check()
      return true
    } catch (error) {
      if (isPermissionDenial(error)) return false
      throw error
    }
  }
  const canEdit = canWorkspaceBusinessWrite(principal) && (
    principal.enterprisePermissions === undefined
      ? await allowed(() => requireProjectCharterManagement(
          { ...principal, enterpriseRouteAuthorizedAtResource: false },
          projectId,
        ))
      : hasEnterprisePermissionAtResource(principal, 'projects.manage', {
          workspaceId: principal.directoryId,
          kind: 'project',
          targetId: projectId,
          parentTeamId: teamId,
        })
  )
  return {
    canEdit,
    canDecideProposal: canEdit && await allowed(() => requireProjectProposalDecision(principal)),
  }
}

/** Checks whether an authorization helper rejected the principal rather than failing. */
function isPermissionDenial(error: unknown) {
  return (error instanceof WorkspaceAccessError || error instanceof ProjectDataError) && error.status === 403
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
 * The returned fence proves the member is still active, at the version read here, when the
 * charter write commits, so a concurrent deactivation cannot be saved as owner or sponsor.
 *
 * @param workspaceId - Workspace that owns the Project.
 * @param userId - Member key from the request.
 * @returns The person snapshot and its membership fence.
 */
async function resolveCharterPerson(
  workspaceId: string,
  userId: string,
): Promise<ResolvedProjectCharterPerson<ProjectCharterPersonConditionCheck>> {
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
  const fence = await workspaceAccess.createActiveMemberConditionCheck.call(
    workspaceAccess,
    workspaceId,
    profile.id,
  )
  if (!fence) throw inactive()
  return { person, fence }
}

/**
 * Re-projects the Project search document so its charter text becomes searchable.
 *
 * @param workspaceId - Workspace that owns the Project.
 * @param state - Committed charter state; only its Team and Project identify the document.
 */
export async function projectCharterSearchDocumentBestEffort(workspaceId: string, state: ProjectCharterState) {
  await projectProjectSearchDocumentBestEffort(
    workspaceId,
    state.teamId,
    state.projectId,
    'project charter update',
  )
}

/**
 * Brings the Project search document in line with one strongly consistent read of the Project.
 *
 * The charter, the names, and the source revision come from the same snapshot. The source
 * revision is the charter revision plus the rename count plus the archive and restore count, so
 * a slower projection of an older state cannot overwrite the document of a newer one, and an
 * archived Project's document is removed.
 *
 * @param workspaceId - Workspace that owns the Project.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param operation - Operation label used when logging a projection failure.
 */
export async function projectProjectSearchDocumentBestEffort(
  workspaceId: string,
  teamId: string,
  projectId: string,
  operation: string,
) {
  await syncDirectorySearchDocumentBestEffort(
    workspaceId,
    'project',
    `team/${teamId}/project/${projectId}`,
    () => workspaceDependencies.projectDirectory.getProjectSearchSource(workspaceId, teamId, projectId),
    (source: ProjectSearchSource) => createProjectSearchDocument(
      workspaceId,
      teamId,
      source.project,
      source.creatorUserId,
      source.englishName !== source.project.name ? source.englishName : undefined,
      source.state.charter,
      source.sourceRevision > 0 ? source.sourceRevision : undefined,
    ),
    operation,
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
