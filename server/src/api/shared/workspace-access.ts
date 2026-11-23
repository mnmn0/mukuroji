import { type RequestFormRoutingTarget, type WorkItemConfiguration } from '@mukuroji/contracts'
import type { Context } from 'hono'
import { TenantAdministrationError } from '../../modules/tenant-administration'
import {
  projectRoleWeights,
  type ProjectAccessEntry,
  type ProjectDirectoryResponse,
  type ProjectDirectoryTeamResponse,
  type ProjectRole,
} from '../../modules/directory'
import { type AuditActorKind } from '../../modules/audit/audit'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { RequestIntakeError } from '../../modules/request-intake/request-intake'
import {
  resolveWorkItemType,
  resolveWorkflowStatus,
} from '../../modules/work-items/work-item-configuration'
import {
  ambientAutomationActionExecutorDependencies,
  type AutomationActionExecutorDependencies,
  initializeLegacyTenantAdministration,
  workItemDependencies,
  workspaceDependencies,
} from './app-dependencies'
import { createRequestMutationContext, toTenantLifecycleBoundaryError } from './http'

/**
 * Creates the audit mutation context for a Workspace mutation performed by an explicit actor.
 *
 * @param c - Hono request context.
 * @param workspaceId - Workspace that scopes the operation.
 * @param actorId - Actor ID recorded in the audit context.
 * @param displayName - Actor display name recorded in the audit context.
 * @param body - Request body recorded in the audit context.
 * @param idempotencyKeyOverride - Idempotency key that replaces the request header.
 * @param actorKind - Audit actor kind.
 * @param correlationIdOverride - Correlation ID that replaces the request header.
 * @returns The mutation audit context.
 */
export function createWorkspaceMutationContextForActor(
  c: Context,
  workspaceId: string,
  actorId: string,
  displayName: string,
  body: unknown,
  idempotencyKeyOverride?: string,
  actorKind: AuditActorKind = 'user',
  correlationIdOverride?: string,
) {
  try {
    return createRequestMutationContext(
      c,
      workspaceId,
      actorId,
      displayName,
      body,
      idempotencyKeyOverride,
      actorKind,
      correlationIdOverride,
    )
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new WorkspaceAccessError(
        400,
        'InvalidWorkspaceMutation',
        error.message,
      )
    }

    throw error
  }
}

/**
 * Normalizes a Workspace email address and rejects invalid input.
 *
 * @param value - Raw input value.
 * @returns The trimmed, lower-cased email address.
 */
export function readWorkspaceEmail(value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''

  if (!email || !email.includes('@')) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceEmail', 'A valid email address is required.')
  }

  return email
}

/**
 * Enforces current Workspace lifecycle state on public and asynchronous surfaces.
 * @param workspaceId - Server-resolved Workspace identifier.
 * @returns Resolves only while normal Workspace access is permitted.
 */
export async function enforceActiveTenantForWorkspace(workspaceId: string): Promise<void> {
  try {
    await workspaceDependencies.tenantLifecycleEnforcement.assertActive(workspaceId)
  } catch (error) {
    if (!(error instanceof TenantAdministrationError) || error.code !== 'TenantAdministrationNotInitialized') {
      throw toTenantLifecycleBoundaryError(error)
    }
    await initializeLegacyTenantAdministration(workspaceId)
    try {
      await workspaceDependencies.tenantLifecycleEnforcement.assertActive(workspaceId)
    } catch (retryError) {
      throw toTenantLifecycleBoundaryError(retryError)
    }
  }
}

/**
 * Converts Workspace access failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toWorkspaceAccessErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof WorkspaceAccessError)) {
    console.error(error)
    return c.json({ message: 'Workspace access is unavailable.' }, 502)
  }

  if (error.status >= 500) {
    console.error(error)
  }

  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 413 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 503
    ? error.status
    : 502

  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Validates a Request routing target against the active Team directory and workflow.
 *
 * @param workspaceId - Workspace that owns the routing target.
 * @param target - Routing target to validate.
 * @param workflowTypeId - Optional Work Item Type whose workflow owns an explicit status override.
 * @param configurationOverride - Candidate configuration to validate instead of the persisted one.
 * @returns The resolved Team Work Item configuration.
 */
export async function validateRequestRoutingTarget(
  workspaceId: string,
  target: RequestFormRoutingTarget,
  workflowTypeId?: string,
  configurationOverride?: WorkItemConfiguration,
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
  const team = directory.teams.find((candidate) => candidate.id === target.teamId)
  if (!team) {
    throw new RequestIntakeError(400, 'InvalidRequestRouting', 'Request routing Team is inactive.')
  }
  if (target.projectId && !team.projects.some((project) => project.id === target.projectId)) {
    throw new RequestIntakeError(400, 'InvalidRequestRouting', 'Request routing Project is inactive.')
  }
  await requireActiveWorkspaceAssignee(workspaceId, target.assigneeUserId)
  const resolved = configurationOverride
    ? undefined
    : await workItemDependencies.workItemConfigurations.getTeamConfiguration(workspaceId, target.teamId)
  const workItemTypeId = workflowTypeId ?? target.workItemTypeId
  const configuration = configurationOverride ?? resolved?.configuration
  if (!configuration) {
    throw new RequestIntakeError(
      503,
      'RequestRoutingUnavailable',
      `Configuration for Team "${target.teamId}" is unavailable.`,
    )
  }
  resolveWorkItemType(configuration, workItemTypeId)
  resolveWorkflowStatus(configuration, target.workflowStatusId, workItemTypeId)
  return {
    configuration,
    ...(resolved ? { resolvedConfiguration: resolved } : {}),
  }
}

/**
 * チーム Issue 操作で使う directory context です。
 */
export type TeamPermissionContext = {
  /** The requested role is granted directly on this Team, independently of child Projects. */
  directTeamGrant?: boolean
  /**
   * active team 行です。
   */
  team: ProjectDirectoryTeamResponse
  /**
   * active team/project 一覧です。
   */
  directory: ProjectDirectoryResponse
  /**
   * 現在ユーザーが team 配下 project に対して持つ role 一覧です。
   * system admin の場合は全 project を扱えるため undefined です。
   */
  projectAccesses?: ProjectAccessEntry[]
}

/** Request-local directory and lazily resolved effective ACLs for aggregate authorization. */
export type TeamPermissionReadContext = {
  /** Current active directory, never reused across requests. */
  directory: ProjectDirectoryResponse
  /** Current effective ACLs, resolved at most once within this request. */
  readProjectAccesses(): Promise<ProjectAccessEntry[]>
}

/**
 * Checks whether a Project access entry grants at least the given role.
 *
 * @param access - Project access entry.
 * @param minimumRole - Minimum role the principal must hold.
 * @returns `true` when the access entry satisfies the role.
 */
export function projectAccessAllows(access: ProjectAccessEntry, minimumRole: ProjectRole) {
  return access.role !== undefined && projectRoleAllows(access.role, minimumRole)
}

/**
 * Checks whether a Project access entry can apply to a Team.
 *
 * A Team-qualified entry applies only to its own Team, so a grant on `other-team/refero` never
 * authorizes `core-team/refero`. An unqualified entry comes from a context its builder already
 * narrowed to the Team's Projects, and keeps applying.
 *
 * @param access - Project access entry.
 * @param teamId - Team that owns the resource.
 * @returns `true` unless the entry is qualified for another Team.
 */
export function projectAccessAppliesToTeam(access: ProjectAccessEntry, teamId: string) {
  return access.teamId === undefined || access.teamId === teamId
}

/**
 * Finds the principal's access entry for one Project of the context's Team.
 *
 * @param context - Team permission context of the principal.
 * @param projectId - Project owned by the context's Team.
 * @returns The access entry, ignoring entries qualified for another Team.
 */
export function findTeamProjectAccess(context: TeamPermissionContext, projectId: string) {
  return context.projectAccesses?.find((access) =>
    access.projectId === projectId && projectAccessAppliesToTeam(access, context.team.id)
  )
}

function projectRoleAllows(role: ProjectRole, minimumRole: ProjectRole) {
  return projectRoleWeights[role] >= projectRoleWeights[minimumRole]
}

/**
 * Requires an assignee to be an active Workspace member with a Cognito profile.
 *
 * @param directoryId - Owning Workspace directory identifier.
 * @param userId - Candidate assignee identifier.
 * @param dependencies - Ports used to read membership and identity state.
 * @returns The current Cognito profile, with the display name from the Workspace member row.
 */
export async function requireActiveWorkspaceAssignee(
  directoryId: string,
  userId: string,
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  const member = await dependencies.workspaceAccess.getActiveMember(directoryId, userId)

  if (!member || member.role === 'guest') {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceAssigneeInactive',
      'Only active non-guest Workspace members can be assigned.',
    )
  }

  const profile = await dependencies.cognito.getUserProfile(userId)
  // The member row holds the display name members set (ADR 0074); Cognito keeps the sign-up name.
  const name = member.name?.trim()
  const { name: _signUpName, ...identity } = profile
  return name ? { ...identity, name } : identity
}

/**
 * Reads the display names of a Workspace's members, deactivated ones included, keyed by lower-cased member key.
 *
 * Members rename themselves on their Workspace member row (ADR 0074), so Project member rows and
 * Cognito keep the name they had when they were written. Readers that show names prefer this map
 * and fall back to their own value only for a member missing from it.
 *
 * @param directoryId - Workspace ID.
 * @returns Name per member; undefined means the member has no name and is shown by email.
 */
export async function readWorkspaceMemberNames(
  directoryId: string,
): Promise<Map<string, string | undefined>> {
  // Deactivated members stay on Work Items and reports, so their names are read too.
  const workspaceAccess = workspaceDependencies.workspaceAccess
  const members = workspaceAccess.listMembers
    ? await workspaceAccess.listMembers(directoryId)
    : await workspaceAccess.listActiveMembers(directoryId)
  return new Map(members.map((member) => [
    member.memberKey.trim().toLowerCase(),
    member.name?.trim() || undefined,
  ]))
}
