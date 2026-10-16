import type { Hono } from 'hono'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { createWorkItemRevisionConditionCheck } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  CustomerError,
  createCustomerRouter,
  type CustomerAuthorizationScope,
  type CustomerAuthorizationConditionChecks,
  type CustomerPrincipal,
} from '../../modules/customers'
import { TriageError, type TriageAuthorizationConditionChecks } from '../../modules/triage'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { hasCustomerManagementAccess, hasCustomerReadAccess } from '../shared/customer-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  requireAssignedProjectPermission,
  requireProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  createTriageProjectAuthorizationConditionChecks,
  mergeTriageConditionChecks,
} from '../shared/request-intake-access'
import { getTeamIssuesTableName } from '../shared/work-item-access'
import { toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

/** Builds commit-time Team, Project, and actor fences for Customer mutations.
 *
 * @param principal Authenticated Workspace principal performing the mutation.
 * @param teamId Team whose live authorization must remain valid.
 * @param projectIds Projects whose live ownership and authorization must remain valid.
 * @returns DynamoDB condition checks to join to the Customer transaction.
 */
const createCustomerTriageAuthorizationConditionChecks = async (
  principal: WorkspacePrincipal & CustomerPrincipal,
  teamId: string,
  projectIds: readonly (string | undefined)[],
): Promise<TriageAuthorizationConditionChecks> => {
  const teamContext = await requireTeamPermission(principal, teamId, 'member')
  const createActiveReferenceConditionChecks = workspaceDependencies.projectDirectory
    .createActiveReferenceConditionChecks
  if (!createActiveReferenceConditionChecks) {
    throw new TriageError(
      503,
      'TriageAuthorizationFenceUnavailable',
      'Triage authorization fencing is unavailable. Retry the request.',
    )
  }
  const checks: TriageAuthorizationConditionChecks = []
  const uniqueProjectIds = new Set(projectIds.filter((projectId): projectId is string => projectId !== undefined))
  for (const projectId of uniqueProjectIds) {
    checks.push(...await createActiveReferenceConditionChecks.call(
      workspaceDependencies.projectDirectory,
      principal.directoryId,
      teamId,
      projectId,
    ))
    checks.push(...await createTriageProjectAuthorizationConditionChecks(
      principal,
      teamContext,
      principal.directoryId,
      teamId,
      projectId,
    ))
  }
  if (uniqueProjectIds.size === 0) {
    checks.push(...await createActiveReferenceConditionChecks.call(
      workspaceDependencies.projectDirectory,
      principal.directoryId,
      teamId,
    ))
    checks.push(...await createTriageProjectAuthorizationConditionChecks(
      principal,
      teamContext,
      principal.directoryId,
      teamId,
      undefined,
    ))
  }
  return mergeTriageConditionChecks(checks)
}

/** Converts Customer, authorization, and persistence failures into the API envelope. */
function toCustomerErrorResponse(context: Context, error: unknown) {
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(context, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(context, error)
  if (error instanceof ProjectDataError) return toProjectDataErrorResponse(context, error)
  if (!(error instanceof CustomerError)) {
    console.error(error)
    return context.json({ code: 'CustomerUnavailable', message: 'Customer data is unavailable.' }, 503)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 || error.status === 401 || error.status === 403 ||
      error.status === 404 || error.status === 409 || error.status === 413 ||
      error.status === 422 || error.status === 429 || error.status === 503
    ? error.status
    : 502
  return context.json({ code: error.code, message: error.message }, status)
}

/** Authenticates a Customer route and applies its Workspace-level capability. */
async function requireCustomerWorkspaceAccess(
  context: Context,
  minimum: 'read' | 'write' | 'manage',
  scope?: CustomerAuthorizationScope,
): Promise<WorkspacePrincipal & CustomerPrincipal> {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new WorkspaceAccessError(401, 'WorkspaceAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  if (minimum === 'manage') {
    requireCustomerManagement(principal, scope)
  } else if (minimum === 'write') {
    requireWorkspaceBusinessWrite(principal)
    if (principal.enterprisePermissions === undefined) {
      requireCustomerManagement(principal, scope)
    } else {
      requireCustomerReadAccess(principal, scope)
    }
  } else {
    requireWorkspaceBusinessRead(principal)
    requireCustomerReadAccess(principal, scope)
  }
  return {
    ...principal,
    canViewSensitiveData: hasCustomerManagementAccess(principal, scope),
  }
}

/** Requires the Workspace-scoped Customer read capability. */
function requireCustomerReadAccess(
  principal: WorkspacePrincipal,
  scope?: CustomerAuthorizationScope,
): void {
  if (hasCustomerReadAccess(principal, scope)) return
  throw new WorkspaceAccessError(
    403,
    'CustomerReadDenied',
    'Customer read permission is required.',
  )
}

/** Requires Customer merge, export, and deletion management authority. */
function requireCustomerManagement(
  principal: WorkspacePrincipal,
  scope?: CustomerAuthorizationScope,
): void {
  if (hasCustomerManagementAccess(principal, scope)) return
  throw new WorkspaceAccessError(
    403,
    'CustomerManagementDenied',
    'Customer management permission is required.',
  )
}

/**
 * Registers the customers HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerCustomersRoutes(routeApp: Hono): void {
  routeApp.route('/', createCustomerRouter<WorkspacePrincipal & CustomerPrincipal>({
    getCustomers: () => workspaceDependencies.customers,
    requireWorkspaceAccess: requireCustomerWorkspaceAccess,
    verifyTriageAccess: async (principal, teamId, minimum) => {
      await requireTeamPermission(principal, teamId, minimum)
    },
    verifyCustomerOwner: async (principal, ownerUserId): Promise<CustomerAuthorizationConditionChecks> => {
      const owner = await workspaceDependencies.workspaceAccess.getActiveMember(
        principal.directoryId,
        ownerUserId,
      )
      if (!owner || owner.role === 'guest') {
        throw new CustomerError(
          409,
          'CustomerOwnerInactive',
          'Customer owner must be an active non-guest Workspace member.',
        )
      }
      const createActiveMemberConditionCheck = workspaceDependencies.workspaceAccess
        .createActiveMemberConditionCheck
      if (!createActiveMemberConditionCheck) {
        throw new CustomerError(
          503,
          'CustomerOwnerAuthorizationFenceUnavailable',
          'Customer owner authorization fencing is unavailable. Retry the request.',
        )
      }
      const conditionCheck = await createActiveMemberConditionCheck.call(
        workspaceDependencies.workspaceAccess,
        principal.directoryId,
        owner.memberKey,
        { allowedRoles: ['owner', 'admin', 'member'] },
      )
      if (!conditionCheck) {
        throw new CustomerError(
          409,
          'CustomerOwnerInactive',
          'Customer owner must be an active non-guest Workspace member.',
        )
      }
      return [conditionCheck]
    },
    createTriageAuthorizationConditionChecks: createCustomerTriageAuthorizationConditionChecks,
    verifyWorkItemAccess: async (principal, teamId, workItemId, minimum) => {
      const context = await requireTeamPermission(principal, teamId, minimum)
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        workItemId,
        { consistentIssueRead: true, includeEvents: false },
      )
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, minimum)
      const authorizationConditionChecks = minimum === 'member'
        ? [
            ...await createCustomerTriageAuthorizationConditionChecks(
              principal,
              teamId,
              [detail.issue.assignedProjectId],
            ),
            createWorkItemRevisionConditionCheck(
              getTeamIssuesTableName(),
              principal.directoryId,
              teamId,
              workItemId,
              detail.issue.revision,
            ),
          ]
        : undefined
      return detail.issue.assignedProjectId
        ? {
            projectId: detail.issue.assignedProjectId,
            isCompleted: detail.issue.statusCategory === 'completed',
            ...(authorizationConditionChecks ? { authorizationConditionChecks } : {}),
          }
        : {
            isCompleted: detail.issue.statusCategory === 'completed',
            ...(authorizationConditionChecks ? { authorizationConditionChecks } : {}),
          }
    },
    verifyProjectAccess: async (principal, projectId, minimum) => {
      await requireProjectPermission(principal, projectId, minimum)
      if (minimum === 'viewer') return {}
      const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
        principal.directoryId,
        'ja',
        true,
      )
      const ownerTeams = directory.teams.filter((team) =>
        team.projects.some((project) => project.id === projectId)
      )
      if (ownerTeams.length === 0) {
        throw new ProjectDataError(404, 'ProjectNotFound', 'The Project was not found.')
      }
      if (ownerTeams.length > 1) {
        throw new ProjectDataError(
          409,
          'AmbiguousProjectOwnerTeam',
          'The Project has multiple active owner Teams.',
        )
      }
      const ownerTeam = ownerTeams[0]
      if (!ownerTeam) {
        throw new ProjectDataError(404, 'ProjectNotFound', 'The Project was not found.')
      }
      return {
        authorizationConditionChecks: await createCustomerTriageAuthorizationConditionChecks(
          principal,
          ownerTeam.id,
          [projectId],
        ),
      }
    },
    getTriage: () => workItemDependencies.triage,
    readJson,
    mapError: toCustomerErrorResponse,
  }))
}
