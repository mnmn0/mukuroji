import { type CuratedContextActorSnapshot, type EnterprisePermissionId } from '@mukuroji/contracts'
import type { Context } from 'hono'
import { type AppDependencies } from '../../app/composition/app-dependencies'
import {
  ProjectDataError,
  projectRoleWeights,
  type ProjectAccessEntry,
  type ProjectDirectoryResponse,
  type ProjectRole,
} from '../../modules/directory'
import { type AuditActorKind, type MutationAuditContext } from '../../modules/audit/audit'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import {
  WorkspaceAccessError,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '../../modules/workspace-access/workspace-access'
import { type CustomerAuthorizationScope } from '../../modules/customers'
import { type TriageAuthorizationConditionChecks } from '../../modules/triage'
import {
  evaluateEnterpriseAccess,
  type EnterpriseAuthorizationResource,
  type EnterprisePrincipalContext,
} from '../../modules/enterprise-identity'
import { type DocumentAccessContext, type DocumentProjectRole } from '../../modules/documents'
import { workspaceDependencies } from './app-dependencies'
import {
  type EnterpriseAuthorizationEvaluationSnapshot,
  type EnterpriseProjectScopeAccess,
  type EnterpriseTeamAccess,
  isSameEnterpriseAuthorizationResource,
  resolveEnterpriseDocumentRole,
} from './enterprise-access'
import { createRequestMutationContext } from './http'
import { getEnv } from './runtime-config'
import {
  createWorkspaceMutationContextForActor,
  projectAccessAllows,
  type TeamPermissionContext,
  type TeamPermissionReadContext,
  toWorkspaceAccessErrorResponse,
} from './workspace-access'

/**
 * プロジェクトデータへのアクセス範囲を表す認可済み principal です。
 */
export type ProjectPrincipal = {
  /**
   * Cognito user から解決した directory partition key です。
   */
  directoryId: string
  /**
   * ログやエラー調査で参照するユーザー識別子です。
   */
  userKey: string
  /**
   * Audit actor に使う Cognito sub または immutable username です。
   */
  actorId: string
  /**
   * Cognito グループでシステム管理者として扱うかどうかです。
   */
  isSystemAdmin: boolean
  /**
   * access token に含まれていた Cognito グループ名です。
   */
  groups: string[]
  /**
   * Interactive user、service account、break-glass の区別です。
   */
  principalKind?: EnterprisePrincipalContext['kind']
  /**
   * Break-glass elevation 中の audit correlation に使う activation ID です。
   */
  enterpriseBreakGlassActivationId?: string
  /**
   * Access token を plaintext 保存せず session-bound elevation に使う SHA-256 digest です。
   */
  enterpriseAuthenticationSessionId?: string
  /**
   * Current route/resource 上で有効な enterprise permission です。
   */
  enterprisePermissions?: EnterprisePermissionId[]
  /**
   * 認証・認可時に読んだ Enterprise CONTROL revision です。
   */
  enterpriseIdentityControlRevision?: number
  /**
   * Current request の enterprise authorization で評価した resource です。
   */
  enterpriseAuthorizationResource?: EnterpriseAuthorizationResource
  /**
   * Current request の route を許可した enterprise permission です。
   */
  enterpriseGrantedRoutePermission?: EnterprisePermissionId
  /**
   * Current request の route 候補として実際に許可された enterprise permission 一覧です。
   */
  enterpriseGrantedRoutePermissions?: EnterprisePermissionId[]
  /**
   * Current request を URL/resource そのものの scope で許可したかどうかです。
   */
  enterpriseRouteAuthorizedAtResource?: boolean
  /**
   * Current request の permission でアクセスできる Project と相当 role です。
   */
  enterpriseProjectAccesses?: ProjectAccessEntry[]
  /**
   * Current request permission set for each Team-qualified Project scope.
   */
  enterpriseProjectScopeAccesses?: EnterpriseProjectScopeAccess[]
  /**
   * Current request の permission で独立してアクセスできる Team ID 一覧です。
   */
  enterpriseAuthorizedTeamIds?: string[]
  /**
   * Current request で Team ごとに有効な enterprise permission です。
   */
  enterpriseTeamAccesses?: EnterpriseTeamAccess[]
  /**
   * Enterprise directory/assignment が legacy Project ACL より権威を持つかどうかです。
   */
  enterpriseLegacyProjectAccessSuppressed?: boolean
  /**
   * Search/notification など current route と異なる resource permission を安全に再評価する snapshot です。
   */
  enterpriseAuthorizationEvaluation?: EnterpriseAuthorizationEvaluationSnapshot
  /**
   * Team-qualified Project access for a principal whose content authorization is delegated to legacy ACLs.
   */
  legacyProjectScopeAccesses?: ProjectAccessEntry[]
  /**
   * Whether a principal delegated to legacy ACLs can read Workspace-scoped Planning content.
   */
  legacyWorkspaceScopeReadable?: boolean
}

/**
 * active Workspace membership を検証済みの principal です。
 */
export type WorkspacePrincipal = ProjectPrincipal & {
  /**
   * DynamoDB から検証した active Workspace member です。
   */
  workspaceMember: WorkspaceMember
  /**
   * Workspace 全体で付与された role です。
   */
  workspaceRole: WorkspaceRole
  /**
   * 認証時点の Workspace member status です。
   */
  workspaceMemberStatus: WorkspaceMemberStatus
}

/** Short-lived document Project role caches keyed by dependency graph. */
export const documentProjectRolesCaches = new WeakMap<
  Readonly<AppDependencies>,
  Map<string, {
    /** Cache entry の失効時刻です。 */
    expiresAt: number
    /** Role snapshot と同時に確認した Workspace member version です。 */
    workspaceMemberVersion: number
    /** Active Project hierarchy を直列化する Planning revision です。 */
    planningRevision: number
    /** Project role read の共有中または解決済み promise です。 */
    value: Promise<Record<string, DocumentProjectRole>>
  }>
>()

/** Lifetime of a document Project role cache entry in milliseconds. */
export const documentProjectRolesCacheTtlMs = 1_000

/** Workspace resource そのものに Enterprise permission があるか判定します。 */
export function hasEnterpriseWorkspacePermission(
  principal: WorkspacePrincipal,
  permission: EnterprisePermissionId,
) {
  return principal.enterpriseRouteAuthorizedAtResource === true &&
    principal.enterpriseAuthorizationResource?.kind === 'workspace' &&
    principal.enterprisePermissions?.includes(permission) === true
}

/**
 * Creates the audit mutation context for an API mutation and maps invalid headers to a data error.
 *
 * @param c - Hono request context.
 * @param principal - Authenticated Workspace principal.
 * @param body - Request body recorded in the audit context.
 * @param idempotencyKeyOverride - Idempotency key that replaces the request header.
 * @returns The mutation audit context.
 */
export function createApiMutationContext(
  c: Context,
  principal: ProjectPrincipal,
  body: unknown,
  idempotencyKeyOverride?: string,
): MutationAuditContext {
  try {
    return createRequestMutationContext(
      c,
      principal.directoryId,
      principal.actorId,
      principal.userKey,
      body,
      idempotencyKeyOverride,
      resolveEnterpriseAuditActorKind(principal),
      principal.enterpriseBreakGlassActivationId,
    )
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new ProjectDataError(400, 'InvalidProjectWrite', error.message)
    }

    throw error
  }
}

/**
 * Creates the audit mutation context for a Workspace mutation performed by the principal.
 *
 * @param c - Hono request context.
 * @param principal - Authenticated Workspace principal.
 * @param body - Request body recorded in the audit context.
 * @param idempotencyKeyOverride - Idempotency key that replaces the request header.
 * @returns The mutation audit context.
 */
export function createWorkspaceMutationContext(
  c: Context,
  principal: ProjectPrincipal,
  body: unknown,
  idempotencyKeyOverride?: string,
) {
  return createWorkspaceMutationContextForActor(
    c,
    principal.directoryId,
    principal.actorId,
    principal.userKey,
    body,
    idempotencyKeyOverride,
    resolveEnterpriseAuditActorKind(principal),
    principal.enterpriseBreakGlassActivationId,
  )
}

/**
 * Resolves the audit actor kind for the principal.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns The audit actor kind.
 */
export function resolveEnterpriseAuditActorKind(principal: ProjectPrincipal): AuditActorKind {
  if (principal.principalKind === 'service-account') return 'service'
  if (principal.principalKind === 'break-glass') return 'break-glass'
  return 'user'
}

/**
 * Creates the document scope restriction derived from enterprise permissions.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns The document scope boundary.
 */
export function createDocumentEnterpriseScopeBoundary(
  principal: WorkspacePrincipal,
): Pick<
  DocumentAccessContext,
  'restrictToAuthorizedScopes' | 'workspaceScopeRole'
> {
  if (principal.enterprisePermissions === undefined) return {}
  const workspaceScopeRole =
    principal.enterpriseRouteAuthorizedAtResource
      ? resolveEnterpriseDocumentRole(
          principal.enterprisePermissions,
        )
      : undefined
  return {
    restrictToAuthorizedScopes: true,
    ...(workspaceScopeRole === undefined
      ? {}
      : { workspaceScopeRole }),
  }
}

/** Checks one Customer capability against the same Enterprise resource as the route. */
export function hasEnterpriseCustomerPermission(
  principal: WorkspacePrincipal,
  permission: EnterprisePermissionId,
  scope?: CustomerAuthorizationScope,
): boolean {
  const resource: EnterpriseAuthorizationResource = scope === undefined
    ? {
        workspaceId: principal.directoryId,
        kind: 'workspace',
      }
    : 'teamId' in scope
      ? {
          workspaceId: principal.directoryId,
          kind: 'team',
          targetId: scope.teamId,
        }
      : {
          workspaceId: principal.directoryId,
          kind: 'project',
          targetId: scope.projectId,
          ...(principal.enterpriseAuthorizationResource?.kind === 'project' &&
            principal.enterpriseAuthorizationResource.targetId === scope.projectId &&
            principal.enterpriseAuthorizationResource.parentTeamId !== undefined
            ? { parentTeamId: principal.enterpriseAuthorizationResource.parentTeamId }
            : {}),
        }
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation !== undefined) {
    return evaluateEnterpriseAccess({
      permission,
      principal: evaluation.principal,
      assignments: evaluation.assignments,
      customRoles: evaluation.snapshot.customRoles,
      groupMappings: evaluation.groupMappings,
      resource,
    }).allowed
  }
  if (!scope) return hasEnterpriseWorkspacePermission(principal, permission)
  return principal.enterpriseRouteAuthorizedAtResource === true &&
    isSameEnterpriseAuthorizationResource(principal.enterpriseAuthorizationResource, resource) &&
    principal.enterprisePermissions?.includes(permission) === true
}

/** Re-evaluates one Project's full Triage role from the authenticated Enterprise snapshot.
 *
 * The request-level Project list is intentionally derived from the GET route permission and can
 * therefore collapse a stronger write grant to viewer. Re-evaluating the write/manage permissions
 * against the same immutable authorization snapshot preserves the effective role without trusting
 * client state or performing a second directory read.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Parent Team for the Project resource.
 * @param projectId - Project whose Triage role is being projected.
 * @returns The strongest Enterprise Project role, or undefined when no Triage grant applies.
 */
export function resolveTriageEnterpriseProjectRole(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
): ProjectRole | undefined {
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (!evaluation) return undefined
  const resource: EnterpriseAuthorizationResource = {
    workspaceId: principal.directoryId,
    kind: 'project',
    targetId: projectId,
    parentTeamId: teamId,
  }
  const allows = (permission: EnterprisePermissionId) =>
    evaluateEnterpriseAccess({
      permission,
      principal: evaluation.principal,
      assignments: evaluation.assignments,
      customRoles: evaluation.snapshot.customRoles,
      groupMappings: evaluation.groupMappings,
      resource,
    }).allowed
  if (allows('teams.write')) {
    return allows('teams.manage') ? 'manager' : 'member'
  }
  return allows('teams.read') ? 'viewer' : undefined
}

/**
 * Returns whether current Enterprise authorization covers the routed Team itself.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team route identifier.
 * @returns Whether Team-wide Enterprise permissions are authoritative for this request.
 */
export function isEnterpriseTriageTeamScope(
  principal: WorkspacePrincipal,
  teamId: string,
): boolean {
  return principal.enterpriseRouteAuthorizedAtResource === true &&
    (
      principal.enterpriseAuthorizationResource?.kind === 'workspace' ||
      principal.enterpriseAuthorizationResource?.kind === 'team' &&
        principal.enterpriseAuthorizationResource.targetId === teamId
    )
}

/** Creates the commit-time Enterprise authorization generation fence for a Triage action.
 *
 * @param principal The Enterprise-authorized Workspace principal.
 * @returns A CONTROL condition check when the Enterprise table is configured, or undefined for
 * local in-memory Enterprise authorization.
 */
export function createEnterpriseControlAuthorizationConditionCheck(
  principal: WorkspacePrincipal,
): TriageAuthorizationConditionChecks[number] | undefined {
  const enterpriseTableName = getEnv('ENTERPRISE_IDENTITY_TABLE_NAME')?.trim()
  const controlRevision = principal.enterpriseIdentityControlRevision
  if (!enterpriseTableName) return undefined
  if (controlRevision === undefined) {
    throw new ProjectDataError(
      503,
      'EnterpriseAuthorizationUnavailable',
      'Enterprise authorization state is unavailable for this Triage mutation.',
    )
  }
  const expressionAttributeNames: Record<string, string> = {
    '#controlRevision': 'controlRevision',
    '#entryType': 'entryType',
  }
  if (controlRevision === 0) expressionAttributeNames['#scopeKey'] = 'scopeKey'
  return {
    ConditionCheck: {
      TableName: enterpriseTableName,
      Key: {
        scopeKey: `WORKSPACE#${principal.directoryId}`,
        recordKey: 'CONTROL',
      },
      ConditionExpression: controlRevision === 0
        ? '(attribute_not_exists(#scopeKey) OR ' +
          '(#entryType = :controlEntryType AND #controlRevision = :expectedControlRevision))'
        : '#entryType = :controlEntryType AND #controlRevision = :expectedControlRevision',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: {
        ':controlEntryType': 'enterprise-identity-control',
        ':expectedControlRevision': controlRevision,
      },
    },
  }
}

/** Returns whether the current principal may perform mutable Workspace business operations. */
export function canWorkspaceBusinessWrite(principal: WorkspacePrincipal) {
  return (
    principal.workspaceRole !== 'guest' &&
    (
      !principal.enterprisePermissions ||
      principal.enterprisePermissions.some((permission) =>
        permission.endsWith('.write') ||
        permission.endsWith('.manage') ||
        permission === 'files.approve'
      )
    )
  )
}

/** Returns whether the current route grants Task View mutation capability. */
export function canWriteTaskViews(principal: WorkspacePrincipal) {
  if (principal.workspaceRole === 'guest') return false
  if (principal.enterprisePermissions === undefined) return true
  return principal.enterprisePermissions.includes('work-items.write') ||
    hasEnterpriseWorkspacePermission(principal, 'workspace.write')
}

/**
 * Requires business write access and rejects guest members.
 *
 * @param principal - Authenticated Workspace principal.
 */
export function requireWorkspaceBusinessWrite(principal: WorkspacePrincipal) {
  if (canWorkspaceBusinessWrite(principal)) return

  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'Guest members have read-only Workspace access.',
  )
}

/**
 * Requires a non-guest Workspace member for business data reads.
 *
 * Enterprise-scoped requests must carry a read-capable permission as well as an
 * active membership.  This guard is intentionally narrower than a generic
 * workspace authentication check so workspace-scoped Planning history cannot
 * be read by guests.
 *
 * @param principal - Current authenticated Workspace principal.
 */
export function requireWorkspaceBusinessRead(principal: WorkspacePrincipal) {
  if (principal.workspaceRole === 'guest') {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'Guest members have read-only access to business data.',
    )
  }
  if (
    principal.enterprisePermissions !== undefined &&
    !principal.enterprisePermissions.some((permission) =>
      permission.endsWith('.read') ||
      permission.endsWith('.write') ||
      permission.endsWith('.manage') ||
      permission === 'files.approve'
    )
  ) {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'A read-capable Workspace permission is required.',
    )
  }
}

/**
 * Requires Workspace administration rights and throws a 403 error otherwise.
 *
 * @param principal - Authenticated Workspace principal.
 */
export function requireWorkspaceAdministration(principal: WorkspacePrincipal) {
  if (principal.enterpriseRouteAuthorizedAtResource) {
    return
  }
  if (
    principal.enterprisePermissions === undefined &&
    (
      principal.workspaceRole === 'owner' ||
      principal.workspaceRole === 'admin'
    )
  ) {
    return
  }

  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'Workspace owner or admin access is required.',
  )
}

/**
 * Requires the principal to administer the Team configuration.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team that owns the resource.
 */
export async function requireTeamConfigurationAdministration(
  principal: WorkspacePrincipal,
  teamId: string,
) {
  if (
    principal.enterpriseRouteAuthorizedAtResource &&
    (
      principal.enterpriseAuthorizationResource?.kind === 'workspace' ||
      principal.enterpriseAuthorizationResource?.kind === 'team' &&
        principal.enterpriseAuthorizationResource.targetId === teamId
    )
  ) {
    return
  }
  if (principal.enterprisePermissions !== undefined) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Enterprise permission is required for this Team operation.',
    )
  }
  if (
    principal.isSystemAdmin ||
    principal.workspaceRole === 'owner' ||
    principal.workspaceRole === 'admin'
  ) {
    await requireTeamPermission(principal, teamId, 'viewer')
    return
  }
  await requireTeamPermission(principal, teamId, 'manager')
}

/**
 * Rejects removing a Workspace member who still manages Projects.
 *
 * @param directoryId - Workspace directory ID.
 * @param memberKey - Workspace member key.
 */
export async function requireWorkspaceMemberHasNoManagedProjects(
  directoryId: string,
  memberKey: string,
) {
  const managedProject = (await workspaceDependencies.projectDirectory.getProjectAccessList(directoryId, memberKey))
    .find((access) => access.role === 'manager')

  if (managedProject) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceMemberManagesProjects',
      'Transfer or remove all active project manager roles before deactivating this member.',
    )
  }
}

/**
 * Converts project and Work Item data failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toProjectDataErrorResponse(c: Context, error: unknown) {
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }

  if (isTeamIssueNotFoundError(error)) {
    return c.json({ message: 'Issue was not found.' }, 404)
  }

  if (!(error instanceof ProjectDataError)) {
    console.error(error)
    return c.json({ message: 'Project data is unavailable.' }, 502)
  }

  if (error.code === 'InvalidWorkItemRevision') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'InvalidProjectQuickAccessInput') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'InvalidWorkItemArchiveUpdate') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'InvalidContributorAssignments') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'InvalidWorkItemQuery') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (
    error.code.startsWith('InvalidWorkItemSchedule') ||
    error.code === 'WorkItemScheduleDurationMismatch'
  ) {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'WorkItemListLimitExceeded') {
    return c.json({ code: error.code, message: error.message }, 413)
  }

  if (error.code === 'WorkItemScheduleCascadeLimitExceeded') {
    return c.json({ code: error.code, message: error.message }, 413)
  }

  if (error.code === 'PlanningProjectScopeDependencyLimitExceeded') {
    return c.json({ code: error.code, message: error.message }, 413)
  }

  if (error.code === 'InvalidProjectWrite' ||
    error.code === 'InvalidWorkItemConfiguration' ||
    error.code === 'InvalidCustomFieldValue' ||
    error.code === 'InvalidAuditQuery' ||
    error.code === 'InvalidCommentMention' ||
    error.code === 'InvalidPlanningRevision' ||
    error.code === 'InvalidTeamIssueCursor') {
    return c.json({ message: error.message }, 400)
  }

  if (error.code === 'TeamNotFound') {
    return c.json({ message: 'Team was not found.' }, 404)
  }

  if (error.code === 'ProjectNotFound') {
    return c.json({ message: 'Project was not found.' }, 404)
  }

  if (error.code === 'ProjectMemberNotFound') {
    return c.json({ message: 'Project member was not found.' }, 404)
  }

  if (error.code === 'ConditionalCheckFailedException') {
    return c.json({ message: 'The same item already exists.' }, 409)
  }

  if (error.code === 'WorkItemRevisionConflict') {
    return c.json({
      code: error.code,
      message: 'Work Item changed. Reload and try again.',
    }, 409)
  }

  if (error.code === 'WorkItemConfigurationRevisionConflict') {
    return c.json({
      code: error.code,
      message: 'Work Item configuration changed. Reload and try again.',
    }, 409)
  }

  if (error.code === 'PlanningRevisionConflict') {
    return c.json({ code: error.code, message: error.message }, 409)
  }

  if (error.code === 'PlanningWorkItemScopeMismatch') {
    return c.json({ code: error.code, message: error.message }, 409)
  }

  if (
    error.code === 'WorkItemRelationGraphConflict' ||
    error.code === 'WorkItemScheduleDependencyConflict' ||
    error.code === 'WorkItemScheduleCascadeConflict' ||
    error.code === 'PlanningWorkItemArchived' ||
    error.code === 'WorkItemAuthorizationChanged'
  ) {
    return c.json({ code: error.code, message: error.message }, 409)
  }

  if (
    error.code === 'WorkItemScheduleCascadeUnavailable' ||
    error.code === 'WorkItemScheduleCascadeTransactionUnavailable'
  ) {
    console.error(error)
    return c.json({ code: error.code, message: error.message }, 503)
  }

  if (error.code === 'ProjectQuickAccessConflict') {
    return c.json({ code: error.code, message: error.message }, 409)
  }

  if (
    error.code === 'AmbiguousProjectOwnerTeam' ||
    error.code === 'AmbiguousProjectWorkItem'
  ) {
    return c.json({ code: error.code, message: error.message }, 409)
  }

  if (error.code === 'ProjectLastManager') {
    return c.json({ message: 'At least one project manager is required.' }, 409)
  }

  if (error.code === 'WorkspaceMemberInactive') {
    return c.json({ message: 'Only active Workspace members can be assigned to a project.' }, 409)
  }

  if (error.code === 'WorkspaceMemberVersionConflict') {
    return c.json({ message: 'Workspace member changed. Reload and try again.' }, 409)
  }

  if (error.code === 'ResourceNotFoundException') {
    console.error(error)
    return c.json({ message: 'Project data is not initialized.' }, 503)
  }

  if (
    error.code === 'InvalidProjectDirectory' ||
    error.code === 'InvalidProjectQuickAccess' ||
    error.code === 'InvalidTeamIssue'
  ) {
    console.error(error)
    return c.json({ message: 'Project data is invalid.' }, 503)
  }

  if (error.code === 'ProjectDirectoryMismatch') {
    return c.json({ message: 'Cognito workspace does not match the configured workspace.' }, 403)
  }

  if (error.code === 'ProjectPrincipalMissing' || error.code === 'ProjectAccessDenied') {
    return c.json({ message: 'Project access is denied.' }, 403)
  }

  if (error.code === 'WorkItemScheduleDependencyAccessDenied') {
    return c.json({
      code: error.code,
      message: 'Schedule dependency impact cannot be evaluated within the current access scope.',
    }, 403)
  }

  console.error(error)
  return c.json({ message: 'Project data is unavailable.' }, 502)
}

/**
 * Requires the principal to hold at least the given role on a Project.
 *
 * @param principal - Authenticated Workspace principal.
 * @param projectId - Project that scopes the operation.
 * @param minimumRole - Minimum role the principal must hold.
 */
export async function requireProjectPermission(
  principal: ProjectPrincipal,
  projectId: string,
  minimumRole: ProjectRole,
) {
  if (principal.isSystemAdmin) {
    return
  }

  const enterpriseProjectAccess = principal.enterpriseProjectAccesses?.find((access) =>
    access.projectId === projectId
  )
  if (
    enterpriseProjectAccess &&
    projectAccessAllows(enterpriseProjectAccess, minimumRole)
  ) {
    return
  }

  const projectAccess = principal.enterpriseLegacyProjectAccessSuppressed
    ? undefined
    : await workspaceDependencies.projectDirectory.getProjectAccess(
        principal.directoryId,
        projectId,
        principal.userKey,
      )
  if (
    !projectAccess ||
    !projectAccessAllows(projectAccess, minimumRole)
  ) {
    throw new ProjectDataError(
      403,
      'ProjectAccessDenied',
      `User "${principal.userKey}" with role "${projectAccess?.role ?? 'none'}" cannot access project "${projectId}".`,
    )
  }
}

/**
 * Reads effective Project roles while retaining an available owner Team qualifier.
 *
 * @param principal - Authenticated principal whose direct and enterprise access is merged.
 * @param requestDirectory - Optional current directory already loaded by the request.
 * @returns Strongest role per Team-qualified or legacy-unqualified Project identity.
 */
export async function getEffectiveProjectScopeAccessList(
  principal: ProjectPrincipal,
  requestDirectory?: ProjectDirectoryResponse,
): Promise<ProjectAccessEntry[]> {
  const directAccesses = principal.enterpriseLegacyProjectAccessSuppressed
    ? []
    : await workspaceDependencies.projectDirectory.getProjectAccessList(
        principal.directoryId,
        principal.userKey,
      )
  const enterpriseAccesses = principal.enterpriseProjectAccesses ?? []
  const accessDirectory = [...directAccesses, ...enterpriseAccesses].some((access) =>
    access.teamId === undefined
  )
    ? requestDirectory ?? await workspaceDependencies.projectDirectory.getProjectDirectory(
        principal.directoryId,
        'ja',
        true,
      )
    : undefined
  /**
   * Adds the sole active owner Team to a legacy-unqualified access entry.
   *
   * @param access - Direct or enterprise Project access entry.
   * @returns Team-qualified access when ownership is unique, otherwise the original scope.
   */
  const qualifyAccess = (access: ProjectAccessEntry): ProjectAccessEntry => {
    if (access.teamId || !accessDirectory) return { ...access }
    const teamId = resolveProjectAccessTeamId(access, accessDirectory)
    return teamId ? { ...access, teamId } : { ...access }
  }
  /**
   * Retains the strongest role when direct and enterprise access share a scope.
   *
   * @param current - Existing access for the scope, when present.
   * @param incoming - Access entry being merged into the scope.
   * @returns The access entry with the strongest available role.
   */
  const mergeAccess = (
    current: ProjectAccessEntry | undefined,
    incoming: ProjectAccessEntry,
  ): ProjectAccessEntry => {
    if (!current) return incoming
    const currentRole = current.role
    const incomingRole = incoming.role
    if (
      incomingRole &&
      (!currentRole || projectRoleWeights[incomingRole] > projectRoleWeights[currentRole])
    ) {
      return { ...current, role: incomingRole }
    }
    return current
  }
  const enterpriseScopesByProject = new Map<string, ProjectAccessEntry[]>()
  for (const enterpriseAccessValue of enterpriseAccesses) {
    if (enterpriseAccessValue.teamId === undefined) continue
    const projectAccesses = enterpriseScopesByProject.get(enterpriseAccessValue.projectId) ?? []
    projectAccesses.push(qualifyAccess(enterpriseAccessValue))
    enterpriseScopesByProject.set(enterpriseAccessValue.projectId, projectAccesses)
  }
  const unresolvedLegacyRoleByProject = new Map<string, ProjectRole | undefined>()
  const accessByScope = new Map<string, ProjectAccessEntry>()
  for (const access of directAccesses) {
    const qualifiedAccess = qualifyAccess(access)
    if (
      access.teamId === undefined &&
      qualifiedAccess.teamId === undefined &&
      enterpriseScopesByProject.has(access.projectId)
    ) {
      const currentRole = unresolvedLegacyRoleByProject.get(access.projectId)
      if (
        !unresolvedLegacyRoleByProject.has(access.projectId) ||
        access.role && (!currentRole || projectRoleWeights[access.role] > projectRoleWeights[currentRole])
      ) {
        unresolvedLegacyRoleByProject.set(access.projectId, access.role)
      }
      continue
    }
    const scopeKey = `${qualifiedAccess.teamId ?? ''}\0${qualifiedAccess.projectId}`
    accessByScope.set(scopeKey, mergeAccess(accessByScope.get(scopeKey), qualifiedAccess))
  }
  for (const enterpriseAccessValue of enterpriseAccesses) {
    const enterpriseAccess = qualifyAccess(enterpriseAccessValue)
    const unresolvedLegacyRole = unresolvedLegacyRoleByProject.get(enterpriseAccess.projectId)
    const mergedEnterpriseAccess = unresolvedLegacyRoleByProject.has(enterpriseAccess.projectId) &&
      unresolvedLegacyRole !== undefined
      ? { ...enterpriseAccess, role: unresolvedLegacyRole && enterpriseAccess.role &&
          projectRoleWeights[unresolvedLegacyRole] > projectRoleWeights[enterpriseAccess.role]
          ? unresolvedLegacyRole
          : enterpriseAccess.role ?? unresolvedLegacyRole }
      : enterpriseAccess
    const scopeKey = `${mergedEnterpriseAccess.teamId ?? ''}\0${mergedEnterpriseAccess.projectId}`
    accessByScope.set(
      scopeKey,
      mergeAccess(accessByScope.get(scopeKey), mergedEnterpriseAccess),
    )
  }
  return [...accessByScope.values()]
}

/**
 * Collapses Team-qualified access to the strongest legacy role per bare Project ID.
 *
 * @param accesses - Team-qualified and legacy-unqualified Project access entries.
 * @returns Strongest role for each Project ID expected by legacy authorization consumers.
 */
export function collapseProjectAccessesById(
  accesses: readonly ProjectAccessEntry[],
): ProjectAccessEntry[] {
  const roleByProjectId = new Map<string, ProjectRole | undefined>()
  for (const access of accesses) {
    const currentRole = roleByProjectId.get(access.projectId)
    if (
      !roleByProjectId.has(access.projectId) ||
      access.role && (!currentRole || projectRoleWeights[access.role] > projectRoleWeights[currentRole])
    ) {
      roleByProjectId.set(access.projectId, access.role)
    }
  }
  return [...roleByProjectId].map(([projectId, role]) => ({ projectId, role }))
}

/**
 * Finds Project identifiers with exactly one active owner Team in the current directory.
 *
 * @param directory - Current active Team and Project hierarchy.
 * @returns Project IDs that are safe to authorize without a Team qualifier.
 */
export function getGloballyUniqueProjectIds(directory: ProjectDirectoryResponse): ReadonlySet<string> {
  const ownerCountByProjectId = new Map<string, number>()
  for (const team of directory.teams) {
    for (const project of team.projects) {
      ownerCountByProjectId.set(
        project.id,
        (ownerCountByProjectId.get(project.id) ?? 0) + 1,
      )
    }
  }
  return new Set(
    [...ownerCountByProjectId].flatMap(([projectId, ownerCount]) =>
      ownerCount === 1 ? [projectId] : []
    ),
  )
}

/**
 * Resolves an access entry to one active owner Team without guessing across duplicate IDs.
 *
 * @param access - Direct or enterprise Project access entry.
 * @param directory - Current active Team and Project hierarchy.
 * @returns Canonical owner Team, or undefined for missing or ambiguous legacy ownership.
 */
export function resolveProjectAccessTeamId(
  access: ProjectAccessEntry,
  directory: ProjectDirectoryResponse,
): string | undefined {
  if (access.teamId) {
    return directory.teams.some((team) =>
      team.id === access.teamId &&
      team.projects.some((project) => project.id === access.projectId)
    )
      ? access.teamId
      : undefined
  }
  const ownerTeams = directory.teams.filter((team) =>
    team.projects.some((project) => project.id === access.projectId)
  )
  return ownerTeams.length === 1 ? ownerTeams[0]?.id : undefined
}

/**
 * Reads legacy Project ACLs and qualifies every entry against the current directory.
 *
 * @param principal - Principal whose legacy ACLs should be loaded.
 * @returns Only active, unambiguous Team-qualified Project access entries.
 */
export async function readLegacyProjectScopeAccesses(
  principal: Pick<ProjectPrincipal, 'directoryId' | 'userKey'>,
): Promise<ProjectAccessEntry[]> {
  const accesses = await workspaceDependencies.projectDirectory.getProjectAccessList(
    principal.directoryId,
    principal.userKey,
  )
  if (accesses.length === 0) return []
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
    true,
  )
  return accesses.flatMap((access) => {
    const teamId = resolveProjectAccessTeamId(access, directory)
    return teamId ? [{ ...access, teamId }] : []
  })
}

/**
 * Reads effective legacy Project roles collapsed by bare Project ID.
 *
 * @param principal - Authenticated principal whose direct and enterprise access is merged.
 * @returns Strongest role for each legacy Project identifier.
 */
export async function getEffectiveProjectAccessList(principal: ProjectPrincipal) {
  return collapseProjectAccessesById(await getEffectiveProjectScopeAccessList(principal))
}

/**
 * Requires the principal to hold at least the given role on a Team.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team that owns the resource.
 * @param minimumRole - Minimum role the principal must hold.
 * @param readContext - Pre-read directory context.
 * @returns The Team permission context used by later authorization checks.
 */
export async function requireTeamPermission(
  principal: ProjectPrincipal,
  teamId: string,
  minimumRole: ProjectRole,
  readContext?: TeamPermissionReadContext,
): Promise<TeamPermissionContext> {
  const directory = readContext?.directory ?? await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const team = directory.teams.find((candidate) => candidate.id === teamId)

  if (!team) {
    throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
  }

  if (principal.isSystemAdmin) {
    return { team, directory }
  }

  const enterprisePermission = minimumRole === 'manager'
    ? 'teams.manage'
    : minimumRole === 'member'
      ? 'teams.write'
      : 'teams.read'
  if (
    principal.enterpriseTeamAccesses?.some((access) =>
      access.teamId === teamId && access.permissions.includes(enterprisePermission)
    ) ||
    principal.enterpriseRouteAuthorizedAtResource &&
      (
        principal.enterpriseAuthorizationResource?.kind === 'workspace' ||
        principal.enterpriseAuthorizationResource?.kind === 'team' &&
          principal.enterpriseAuthorizationResource.targetId === teamId
      ) &&
      principal.enterprisePermissions?.includes(enterprisePermission)
  ) {
    const role = minimumRole === 'manager'
      ? 'manager'
      : minimumRole === 'member'
        ? 'member'
        : 'viewer'
    return {
      team,
      directory,
      directTeamGrant: true,
      projectAccesses: team.projects.map((project) => ({
        teamId,
        projectId: project.id,
        role,
      })),
    }
  }

  const teamProjectIds = new Set(team.projects.map((project) => project.id))
  const projectAccesses = (await (readContext?.readProjectAccesses() ?? getEffectiveProjectScopeAccessList(principal)))
    .filter((projectAccess) => teamProjectIds.has(projectAccess.projectId))

  for (const projectAccess of projectAccesses) {
    if (projectAccess && projectAccessAllows(projectAccess, minimumRole)) {
      return { team, directory, projectAccesses }
    }
  }

  throw new ProjectDataError(
    403,
    'ProjectAccessDenied',
    `User "${principal.userKey}" cannot access team "${teamId}".`,
  )
}

/**
 * Requires the principal to hold at least the given role on the Work Item's assigned Project.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Team permission context of the principal.
 * @param assignedProjectId - Project the Work Item is assigned to.
 * @param minimumRole - Minimum role the principal must hold.
 */
export function requireAssignedProjectPermission(
  principal: ProjectPrincipal,
  context: TeamPermissionContext,
  assignedProjectId: string | null | undefined,
  minimumRole: ProjectRole,
) {
  if (!assignedProjectId || principal.isSystemAdmin) {
    return
  }

  const projectAccess = context.projectAccesses?.find((access) => access.projectId === assignedProjectId)

  if (!projectAccess || !projectAccessAllows(projectAccess, minimumRole)) {
    throw new ProjectDataError(
      403,
      'ProjectAccessDenied',
      `User "${principal.userKey}" cannot access assigned project "${assignedProjectId}".`,
    )
  }
}

/**
 * Checks whether the principal can access the Work Item's assigned Project.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Team permission context of the principal.
 * @param assignedProjectId - Project the Work Item is assigned to.
 * @param minimumRole - Minimum role the principal must hold.
 * @returns `true` when the principal holds the required role.
 */
export function canAccessAssignedProject(
  principal: ProjectPrincipal,
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
  minimumRole: ProjectRole,
) {
  if (!assignedProjectId || principal.isSystemAdmin) {
    return true
  }

  const projectAccess = context.projectAccesses?.find((access) => access.projectId === assignedProjectId)

  return projectAccess !== undefined && projectAccessAllows(projectAccess, minimumRole)
}

/**
 * Captures a display-safe actor identity for collaboration history.
 *
 * @param principal - Current authenticated Workspace principal.
 * @returns Actor snapshot safe to retain in curated-context history.
 */
export function createCuratedContextActorSnapshot(
  principal: WorkspacePrincipal,
): CuratedContextActorSnapshot {
  return {
    id: principal.userKey,
    displayName: principal.workspaceMember.name?.trim() || principal.userKey,
  }
}
