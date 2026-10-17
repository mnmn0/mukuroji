import {
  type PlanningEntity,
  type PlanningSnapshot,
  type PlanningUpdateTargetSummary,
  type PlanningUpdateTarget,
  type PlanningWorkItemSummary,
  type WorkItemDependencyEndpoint,
  type EnterprisePermissionId,
} from '@mukuroji/contracts'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import {
  normalizeProjectMemberKey,
  ProjectDataError,
  type ProjectAccessEntry,
  type ProjectDirectoryResponse,
  type ProjectRole,
} from '../../modules/directory'
import {
  createWorkItemDependencyKey,
  isTeamIssueNotFoundError,
  type TeamIssueResponseItem,
  type WorkItemAuthorizationSnapshot,
} from '../../modules/work-items'
import {
  WorkspaceAccessError,
  type WorkspaceMember,
} from '../../modules/workspace-access/workspace-access'
import { type NotificationItem } from '../../modules/notifications/notifications'
import { evaluateEnterpriseAccess } from '../../modules/enterprise-identity'
import {
  createPlanningWorkItemDependencySummary,
  PlanningError,
  type PlanningCallerAuthorizationConditionCheck,
  type PlanningWorkItemState,
} from '../../modules/planning'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { WORK_ITEMS_TEAM_READ_LIMIT } from './constants'
import { toCognitoDirectoryErrorResponse } from './enterprise-access'
import {
  getEffectiveProjectAccessList,
  type ProjectPrincipal,
  requireProjectPermission,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessRead,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from './project-access'
import { getEnv } from './runtime-config'
import { stableDigestStringify } from './value-guards'
import {
  addAggregateWorkItem,
  createWorkItemAuthorizationSnapshot,
  createWorkItemListLimitExceededError,
  loadAuthorizedTeamIssue,
  readCanonicalTeamIssuesForAggregate,
  type WorkItemsResponse,
} from './work-item-access'
import {
  projectAccessAllows,
  type TeamPermissionContext,
  type TeamPermissionReadContext,
} from './workspace-access'

/**
 * Reads a trimmed planning identifier and rejects invalid input.
 *
 * @param value - Raw input value.
 * @param label - Field label used in validation messages.
 * @returns The validated identifier.
 */
export function readPlanningIdentifier(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 256
  ) {
    throw new PlanningError(400, 'InvalidPlanningInput', `${label} is required.`)
  }
  return value
}

/** Returns whether Planning history reads must authorize every captured Project scope. */
export function shouldEvaluateAllPlanningHistoryScopes(context?: Context): boolean {
  return context?.req.method === 'GET' && (
    context.req.path === '/api/planning/updates' ||
    context.req.path === '/api/planning/updates/export'
  )
}

/**
 * Converts planning failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toPlanningErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (
    error instanceof WorkspaceAccessError ||
    error instanceof ProjectDataError ||
    isTeamIssueNotFoundError(error)
  ) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof PlanningError)) {
    console.error(error)
    return c.json({ message: 'Planning data is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Requires a current Workspace-scoped route for Workspace-scoped Planning data.
 *
 * Enterprise permissions are resource-bound.  A caller authorized only at a
 * Team or Project resource may still carry a read-capable permission, but that
 * permission must not unlock immutable Planning context captured while an
 * Initiative was Workspace-scoped.
 *
 * @param principal - Current authenticated Workspace principal.
 */
export function requirePlanningWorkspaceScopeRead(principal: WorkspacePrincipal): void {
  requireWorkspaceBusinessRead(principal)
  if (
    principal.enterprisePermissions !== undefined &&
    !(
      principal.enterpriseRouteAuthorizedAtResource === true &&
      principal.enterpriseAuthorizationResource?.kind === 'workspace'
    )
  ) {
    throw new PlanningError(
      403,
      'PlanningUpdateScopeAccessDenied',
      'Workspace-scoped Planning access requires Workspace permission.',
    )
  }
}

/**
 * Requires Team and assigned-Project permission for one Work Item dependency endpoint.
 *
 * @param principal - Authenticated Workspace principal.
 * @param endpoint - Qualified Work Item endpoint.
 * @param minimumRole - Required role at both Team and assigned Project scopes.
 * @returns Strongly read authorized Work Item detail.
 */
export async function requirePlanningWorkItemEndpointPermission(
  principal: WorkspacePrincipal,
  endpoint: WorkItemDependencyEndpoint,
  minimumRole: Extract<ProjectRole, 'viewer' | 'member' | 'manager'>,
) {
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation && !principal.isSystemAdmin) {
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
      principal.directoryId,
      'ja',
    )
    const team = directory.teams.find((candidate) => candidate.id === endpoint.teamId)
    if (!team) {
      throw new ProjectDataError(404, 'TeamNotFound', 'Schedule dependency Team was not found.')
    }
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      endpoint.teamId,
      endpoint.workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    const assignedProjectId = detail.issue.assignedProjectId
    if (
      assignedProjectId &&
      !team.projects.some((project) => project.id === assignedProjectId)
    ) {
      throw new ProjectDataError(
        409,
        'PlanningWorkItemScopeMismatch',
        'Schedule dependency Work Item assignment does not match its owning Team.',
      )
    }
    const permission: EnterprisePermissionId = minimumRole === 'viewer'
      ? 'work-items.read'
      : minimumRole === 'member'
        ? 'work-items.write'
        : 'planning.manage'
    const allowed = evaluateEnterpriseAccess({
      permission,
      principal: evaluation.principal,
      assignments: evaluation.assignments,
      customRoles: evaluation.snapshot.customRoles,
      groupMappings: evaluation.groupMappings,
      resource: assignedProjectId
        ? {
            workspaceId: principal.directoryId,
            kind: 'project',
            targetId: assignedProjectId,
            parentTeamId: endpoint.teamId,
          }
        : {
            workspaceId: principal.directoryId,
            kind: 'team',
            targetId: endpoint.teamId,
          },
    }).allowed
    if (!allowed) {
      throw new ProjectDataError(
        403,
        'WorkItemScheduleDependencyAccessDenied',
        'Schedule dependency impact cannot be evaluated within the current access scope.',
      )
    }
    const role = minimumRole
    return {
      context: {
        team,
        directory,
        projectAccesses: assignedProjectId
          ? [{ projectId: assignedProjectId, teamId: endpoint.teamId, role }]
          : [],
      } satisfies TeamPermissionContext,
      detail,
    }
  }
  return loadAuthorizedTeamIssue(
    principal,
    endpoint.teamId,
    endpoint.workItemId,
    minimumRole,
  )
}

/**
 * Authorizes one Project/Initiative update target against its current canonical scope.
 *
 * @param principal - Authenticated Workspace principal.
 * @param snapshot - Current Planning snapshot used for Initiative scope resolution.
 * @param target - Validated Project or Initiative target.
 * @param minimumRole - Minimum Project-style role required by the operation.
 * @param readContext - Optional request-local directory and ACL read cache.
 * @returns The matching Initiative entity for Initiative targets, otherwise undefined.
 */
export async function requirePlanningUpdateTargetPermission(
  principal: WorkspacePrincipal,
  snapshot: PlanningSnapshot,
  target: PlanningUpdateTarget,
  minimumRole: ProjectRole,
  readContext?: TeamPermissionReadContext,
) {
  if (target.type === 'project') {
    await requirePlanningUpdateProjectPermission(
      principal,
      target.teamId,
      target.projectId,
      minimumRole,
      readContext,
    )
    return undefined
  }

  const entity = snapshot.entities.find((candidate) => candidate.id === target.entityId)
  if (!entity || entity.type !== 'initiative') {
    throw new PlanningError(
      404,
      'PlanningUpdateTargetNotFound',
      'Planning Initiative update target was not found.',
    )
  }
  if (entity.teamId && entity.projectId) {
    await requirePlanningUpdateProjectPermission(
      principal,
      entity.teamId,
      entity.projectId,
      minimumRole,
      readContext,
    )
  } else if (entity.projectId) {
    await requireProjectPermission(principal, entity.projectId, minimumRole)
  } else if (entity.teamId) {
    await requirePlanningUpdateTeamPermission(principal, entity.teamId, minimumRole, readContext)
  } else {
    requirePlanningWorkspaceScopeRead(principal)
    if (minimumRole === 'manager') requireWorkspaceAdministration(principal)
  }
  return entity
}

/**
 * Authorizes a Team-scoped update target without trusting ambiguous Project IDs.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team that owns the Initiative target.
 * @param minimumRole - Required role on at least one Project in that Team.
 * @param readContext - Optional request-local directory and ACL read cache.
 */
export async function requirePlanningUpdateTeamPermission(
  principal: WorkspacePrincipal,
  teamId: string,
  minimumRole: ProjectRole,
  readContext?: TeamPermissionReadContext,
): Promise<void> {
  const directPlanningRead = minimumRole === 'viewer' && (
    principal.enterpriseTeamAccesses?.some((access) => access.teamId === teamId && access.permissions.includes('planning.read')) ||
    principal.enterpriseRouteAuthorizedAtResource && principal.enterprisePermissions?.includes('planning.read') && (
      principal.enterpriseAuthorizationResource?.kind === 'workspace' ||
      principal.enterpriseAuthorizationResource?.kind === 'team' && principal.enterpriseAuthorizationResource.targetId === teamId
    )
  )
  if (directPlanningRead) {
    const directory = readContext?.directory ?? await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja', true)
    if (!directory.teams.some((team) => team.id === teamId)) throw new PlanningError(404, 'TeamNotFound', 'The Planning Team was not found.')
    return
  }
  const context = await requireTeamPermission(principal, teamId, minimumRole, readContext)
  if (principal.isSystemAdmin || context.directTeamGrant || context.projectAccesses === undefined) return
  const hasQualifiedAccess = context.team.projects.some((project) =>
    context.projectAccesses?.some((access) =>
      planningProjectAccessMatchesQualifiedScope(
        access,
        context.directory,
        teamId,
        project.id,
      ) && projectAccessAllows(access, minimumRole)
    ) ?? false
  )
  if (!hasQualifiedAccess) {
    throw new PlanningError(
      403,
      'ProjectAccessDenied',
      'Current Team permission does not allow this Planning update operation.',
    )
  }
}

/**
 * Authorizes a Team-qualified Project and rejects a mismatched directory hierarchy.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Owning Team identifier.
 * @param projectId - Team-local Project identifier.
 * @param minimumRole - Required Project role.
 * @param readContext - Optional request-local directory and ACL read cache.
 */
export async function requirePlanningUpdateProjectPermission(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
  minimumRole: ProjectRole,
  readContext?: TeamPermissionReadContext,
) {
  const context = await requireTeamPermission(principal, teamId, minimumRole, readContext)
  if (!context.team.projects.some((project) => project.id === projectId)) {
    throw new PlanningError(
      404,
      'PlanningUpdateTargetNotFound',
      'Planning Project update target was not found.',
    )
  }
  if (principal.isSystemAdmin || context.projectAccesses === undefined) return
  const access = context.projectAccesses.find((candidate) =>
    planningProjectAccessMatchesQualifiedScope(
      candidate,
      context.directory,
      teamId,
      projectId,
    )
  )
  if (!access || !projectAccessAllows(access, minimumRole)) {
    throw new PlanningError(
      403,
      'ProjectAccessDenied',
      'Current Project permission does not allow this Planning update operation.',
    )
  }
}

/**
 * Matches one Project access entry to an exact Team-qualified Project identity.
 *
 * @param access - Current member access entry.
 * @param directory - Current active Team/Project hierarchy.
 * @param teamId - Required owner Team.
 * @param projectId - Required Team-local Project ID.
 * @returns Whether the access is explicitly qualified or safely inferable from a unique owner Team.
 */
export function planningProjectAccessMatchesQualifiedScope(
  access: ProjectAccessEntry,
  directory: ProjectDirectoryResponse,
  teamId: string,
  projectId: string,
): boolean {
  if (access.projectId !== projectId) return false
  if (access.teamId !== undefined) return access.teamId === teamId
  const ownerTeamIds = directory.teams
    .filter((team) => team.projects.some((project) => project.id === projectId))
    .map((team) => team.id)
  return ownerTeamIds.length === 1 && ownerTeamIds[0] === teamId
}

/**
 * Rejects removing a Workspace member who still owns planning entities.
 *
 * @param directoryId - Workspace directory ID.
 * @param memberKey - Workspace member key.
 * @returns The planning authorization revision that was checked.
 */
export async function requireWorkspaceMemberHasNoOwnedPlanningEntities(
  directoryId: string,
  memberKey: string,
) {
  const authorizationState = await workItemDependencies.planning.getAuthorizationState(directoryId)
  const ownedEntity = authorizationState.entities.find(
    (entity) => !entity.archivedAt && entity.ownerMemberKey === memberKey,
  )
  if (ownedEntity) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceMemberOwnsPlanningEntities',
      'Transfer or archive all owned Planning entities before deactivating this member.',
    )
  }
  return authorizationState.revision
}

/**
 * Detects notifications whose visibility depends on current Planning update cadence state.
 *
 * Metadata-bearing non-Planning events are included so malformed persisted rows fail closed.
 *
 * @param notification - Persisted Inbox notification candidate.
 * @returns Whether the notification requires current Planning revalidation.
 */
export function requiresCurrentPlanningUpdateTarget(notification: NotificationItem) {
  return notification.eventType.startsWith('planning-update.') ||
    notification.planningTargetType !== undefined ||
    notification.planningTargetId !== undefined ||
    notification.planningTargetRecordKey !== undefined ||
    notification.planningNextDueAt !== undefined ||
    notification.planningNotificationKind !== undefined
}

/** Optional Team/Project envelope used to bound a canonical Work Item read. */
export type PlanningWorkItemReadScope = {
  /** Team whose Work Item partition should be read. */
  teamId?: string
  /** Project whose assigned Work Items should be retained. */
  projectId?: string
}

/**
 * Reads every Work Item the principal can access across its Teams.
 *
 * @param principal - Authenticated Workspace principal.
 * @param includeArchived - Whether archived Work Items are included.
 * @param scope - Optional planning read scope.
 * @returns The accessible Work Items.
 */
export async function readAccessibleWorkItems(
  principal: ProjectPrincipal,
  includeArchived = false,
  scope?: PlanningWorkItemReadScope,
): Promise<WorkItemsResponse> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await getEffectiveProjectAccessList(principal)
  const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  const selectedTeams = scope?.teamId === undefined
    ? directory.teams
    : directory.teams.filter((team) => team.id === scope.teamId)
  const contexts: TeamPermissionContext[] = selectedTeams.flatMap((team) => {
    if (principal.isSystemAdmin) {
      return [{ team, directory } satisfies TeamPermissionContext]
    }

    const teamProjectIds = new Set(team.projects.map((project) => project.id))
    const teamProjectAccesses = (projectAccesses ?? []).filter((access) =>
      teamProjectIds.has(access.projectId) &&
      (scope?.projectId === undefined || access.projectId === scope.projectId)
    )
    if (
      !authorizedTeamIds.has(team.id) &&
      !teamProjectAccesses.some((access) => projectAccessAllows(access, 'viewer'))
    ) {
      return []
    }

    return [{ team, directory, projectAccesses: teamProjectAccesses } satisfies TeamPermissionContext]
  })
  if (contexts.length > WORK_ITEMS_TEAM_READ_LIMIT) {
    throw createWorkItemListLimitExceededError(
      `Workspace has more than ${WORK_ITEMS_TEAM_READ_LIMIT} accessible Teams.`,
    )
  }

  const workItemsById = new Map<string, TeamIssueResponseItem>()

  for (const context of contexts) {
    const response = await readCanonicalTeamIssuesForAggregate(
      principal.directoryId,
      context,
      principal,
      includeArchived,
    )
    for (const workItem of response.issues) {
      if (scope?.projectId !== undefined && workItem.assignedProjectId !== scope.projectId) {
        continue
      }
      addAggregateWorkItem(workItemsById, workItem)
    }
  }

  return { workItems: [...workItemsById.values()] }
}

/**
 * Reads the Work Item state that planning views need for the principal.
 *
 * @param principal - Authenticated Workspace principal.
 * @param scope - Optional planning read scope.
 * @returns The planning Work Item state.
 */
export async function readPlanningWorkItemState(
  principal: ProjectPrincipal,
  scope?: PlanningWorkItemReadScope,
): Promise<PlanningWorkItemState> {
  const response = await readAccessibleWorkItems(principal, false, scope)
  return {
    workItems: response.workItems.map((workItem) => ({
      id: workItem.id,
      revision: workItem.revision,
      teamId: workItem.teamId,
      title: workItem.title,
      ...(workItem.assignedProjectId
        ? { projectId: workItem.assignedProjectId }
        : {}),
      statusCategory: workItem.statusCategory,
      dueDate: workItem.dueDate,
      schedule: workItem.schedule,
    } satisfies PlanningWorkItemSummary)),
  }
}

/** Planning publish reads that share the target envelope resolved from the current snapshot. */
type PlanningPublishReadState = {
  /** Current principal-visible Planning Work Item state. */
  workItemState: PlanningWorkItemState
  /** Current unfiltered Planning snapshot used for route authorization. */
  snapshot: PlanningSnapshot
  /** Target envelope used to bound canonical Work Item reads. */
  targetScope?: PlanningWorkItemReadScope
}

/**
 * Resolves the canonical Work Item envelope for a Project or Initiative target.
 *
 * @param snapshot - Planning snapshot containing the current target entity.
 * @param target - Validated Project or Initiative target.
 * @returns Team/Project envelope, or undefined for a Workspace-scoped Initiative.
 */
function resolvePlanningPublishTargetScope(
  snapshot: PlanningSnapshot,
  target: PlanningUpdateTarget,
): PlanningWorkItemReadScope | undefined {
  if (target.type === 'project') {
    return { teamId: target.teamId, projectId: target.projectId }
  }

  const entity = snapshot.entities.find((candidate) =>
    candidate.id === target.entityId && candidate.type === 'initiative'
  )
  if (!entity) {
    throw new PlanningError(
      404,
      'PlanningUpdateTargetNotFound',
      'Planning Initiative update target was not found.',
    )
  }
  if (entity.projectId !== undefined && entity.teamId === undefined) {
    throw new PlanningError(
      409,
      'PlanningUpdateScopeInvalid',
      'A Project-scoped Planning Initiative requires its owning Team scope.',
    )
  }
  if (entity.teamId === undefined && entity.projectId === undefined) return undefined
  return {
    ...(entity.teamId === undefined ? {} : { teamId: entity.teamId }),
    ...(entity.projectId === undefined ? {} : { projectId: entity.projectId }),
  }
}

/**
 * Compares two optional Planning publish envelopes without conflating workspace scope.
 *
 * @param first - First optional Team/Project envelope.
 * @param second - Second optional Team/Project envelope.
 * @returns Whether both envelopes describe the same scope.
 */
function planningPublishScopesEqual(
  first: PlanningWorkItemReadScope | undefined,
  second: PlanningWorkItemReadScope | undefined,
): boolean {
  return first?.teamId === second?.teamId && first?.projectId === second?.projectId
}

/**
 * Resolves the target envelope before reading Work Items for a Planning publish.
 *
 * Initiative scope is stored in the Planning graph, so an empty Work Item projection is used
 * only to resolve that envelope before the bounded canonical read.
 *
 * @param principal - Authenticated Workspace principal.
 * @param target - Validated Project or Initiative publish target.
 * @returns Planning snapshot and Work Item state read within the target envelope.
 */
export async function readPlanningPublishState(
  principal: ProjectPrincipal,
  target: PlanningUpdateTarget,
): Promise<PlanningPublishReadState> {
  let targetScope: PlanningWorkItemReadScope | undefined
  if (target.type === 'project') {
    targetScope = { teamId: target.teamId, projectId: target.projectId }
  } else {
    const preliminarySnapshot = await workItemDependencies.planning.get(
      principal.directoryId,
      { workItems: [] },
    )
    targetScope = resolvePlanningPublishTargetScope(preliminarySnapshot, target)
  }

  let workItemState = await readPlanningWorkItemState(principal, targetScope)
  let snapshot = await workItemDependencies.planning.get(
    principal.directoryId,
    workItemState,
  )
  const currentTargetScope = resolvePlanningPublishTargetScope(snapshot, target)
  if (!planningPublishScopesEqual(targetScope, currentTargetScope)) {
    targetScope = currentTargetScope
    workItemState = await readPlanningWorkItemState(principal, targetScope)
    snapshot = await workItemDependencies.planning.get(
      principal.directoryId,
      workItemState,
    )
  }
  return { workItemState, snapshot, targetScope }
}

/**
 * Compares two qualified Planning update targets without relying on object identity.
 *
 * @param first - First target.
 * @param second - Second target.
 * @returns Whether both targets have the same type and qualified identifiers.
 */
export function planningUpdateTargetsEqual(
  first: PlanningUpdateTarget,
  second: PlanningUpdateTarget,
): boolean {
  return stableDigestStringify(first) === stableDigestStringify(second)
}

/**
 * Creates an unambiguous Team-owned Project scope key for authorization filtering.
 *
 * @param teamId - Canonical owner Team identifier.
 * @param projectId - Team-local Project identifier.
 * @returns Qualified key that does not collide across Teams.
 */
function createPlanningProjectScopeKey(teamId: string, projectId: string): string {
  return `${teamId}\0${projectId}`
}

/**
 * Removes a latest update summary when its immutable captured scope is unavailable now.
 *
 * @param updateTarget - Candidate target summary from the canonical Planning snapshot.
 * @param currentScope - Current scope of the target entity, or the qualified Project target.
 * @param projectScopeKeys - Team-qualified Project scopes readable by the principal.
 * @param teamIds - Team scopes readable by the principal.
 * @param workspaceScopeReadable - Whether a Workspace-scoped target is readable.
 * @returns Target summary with only currently readable latest content.
 */
function filterPlanningLatestUpdateSummaryForPrincipal(
  updateTarget: PlanningUpdateTargetSummary,
  currentScope: Pick<PlanningEntity, 'teamId' | 'projectId'> | undefined,
  projectScopeKeys?: ReadonlySet<string>,
  teamIds?: ReadonlySet<string>,
  workspaceScopeReadable = false,
): PlanningUpdateTargetSummary {
  if (updateTarget.latestUpdate === undefined) return updateTarget

  const capturedScope = updateTarget.latestUpdate.capturedScope
  const currentScopeMatches = capturedScope !== undefined && currentScope !== undefined &&
    capturedScope.teamId === currentScope.teamId &&
    capturedScope.projectId === currentScope.projectId
  const principalScopeMatches = projectScopeKeys === undefined || teamIds === undefined
    ? true
    : capturedScope !== undefined && (
        capturedScope.projectId !== undefined
          ? capturedScope.teamId !== undefined && projectScopeKeys.has(
              createPlanningProjectScopeKey(capturedScope.teamId, capturedScope.projectId),
            )
          : capturedScope.teamId !== undefined
            ? teamIds.has(capturedScope.teamId)
            : workspaceScopeReadable
      )
  const filtered = structuredClone(updateTarget)
  if (!currentScopeMatches || !principalScopeMatches) {
    delete filtered.latestUpdate
    return filtered
  }
  if (filtered.latestUpdate) delete filtered.latestUpdate.capturedScope
  return filtered
}

/**
 * Removes server-only captured-scope metadata from a readable latest summary.
 *
 * @param updateTarget - Target summary whose response representation is being detached.
 * @returns Target summary without server-only captured-scope metadata.
 */
function stripPlanningLatestUpdateCapturedScope(
  updateTarget: PlanningUpdateTargetSummary,
): PlanningUpdateTargetSummary {
  const filtered = structuredClone(updateTarget)
  if (filtered.latestUpdate) delete filtered.latestUpdate.capturedScope
  return filtered
}

/**
 * Removes Planning records outside the principal's current Team and Project scope.
 *
 * @param principal - Authenticated principal whose current access bounds the response.
 * @param snapshot - Complete Planning snapshot loaded from the canonical store.
 * @returns A detached snapshot containing only authorized Planning and Work Item records.
 */
export function filterPlanningSnapshotForPrincipal(
  principal: ProjectPrincipal,
  snapshot: PlanningSnapshot,
): PlanningSnapshot {
  if (
    principal.isSystemAdmin ||
    principal.enterpriseRouteAuthorizedAtResource &&
      principal.enterpriseAuthorizationResource?.kind === 'workspace'
  ) {
    return {
      ...snapshot,
      updateTargets: snapshot.updateTargets.map(stripPlanningLatestUpdateCapturedScope),
    }
  }
  if (principal.enterprisePermissions === undefined) {
    const projectScopeKeys = new Set(
      (principal.legacyProjectScopeAccesses ?? []).flatMap((access) =>
        access.teamId && projectAccessAllows(access, 'viewer')
          ? [createPlanningProjectScopeKey(access.teamId, access.projectId)]
          : []
      ),
    )
    const teamIds = new Set(
      (principal.legacyProjectScopeAccesses ?? []).flatMap((access) =>
        access.teamId && projectAccessAllows(access, 'viewer')
          ? [access.teamId]
          : []
      ),
    )
    const workspaceScopeReadable = principal.legacyWorkspaceScopeReadable === true
    /** Returns whether one Planning scope is readable through the legacy ACL boundary. */
    const isLegacyPlanningScopeVisible = (
      scope: Pick<PlanningEntity, 'teamId' | 'projectId'>,
    ): boolean => {
      if (scope.projectId !== undefined) {
        return scope.teamId !== undefined && projectScopeKeys.has(
          createPlanningProjectScopeKey(scope.teamId, scope.projectId),
        )
      }
      if (scope.teamId !== undefined) return teamIds.has(scope.teamId)
      return workspaceScopeReadable
    }
    const updateTargets = snapshot.updateTargets
      .filter((updateTarget) => {
        const target = updateTarget.target
        if (target.type === 'initiative') {
          const entity = snapshot.entities.find((candidate) =>
            candidate.id === target.entityId
          )
          return entity !== undefined && isLegacyPlanningScopeVisible(entity)
        }
        return projectScopeKeys.has(createPlanningProjectScopeKey(
          target.teamId,
          target.projectId,
        ))
      })
      .map((updateTarget) => {
        const target = updateTarget.target
        const currentScope = target.type === 'initiative'
          ? snapshot.entities.find((entity) => entity.id === target.entityId)
          : target
        return filterPlanningLatestUpdateSummaryForPrincipal(
          updateTarget,
          currentScope,
          projectScopeKeys,
          teamIds,
          workspaceScopeReadable,
        )
      })
      .map(stripPlanningLatestUpdateCapturedScope)
    return {
      ...snapshot,
      updateTargets,
    }
  }

  const projectScopeKeys = new Set(
    (principal.enterpriseProjectAccesses ?? []).flatMap((access) =>
      access.teamId
        ? [createPlanningProjectScopeKey(access.teamId, access.projectId)]
        : []
    ),
  )
  const teamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  const entities = snapshot.entities
    .filter((entity) => entity.projectId !== undefined
      ? entity.teamId !== undefined && projectScopeKeys.has(
          createPlanningProjectScopeKey(entity.teamId, entity.projectId),
        )
      : entity.teamId !== undefined && teamIds.has(entity.teamId))
  const entityIds = new Set(entities.map((entity) => entity.id))
  const scopedEntities = entities.map((entity) => (
    entity.parentId && !entityIds.has(entity.parentId)
      ? { ...entity, parentId: undefined }
      : entity
  ))
  const dependencies = snapshot.dependencies.filter((dependency) =>
    entityIds.has(dependency.predecessorId) && entityIds.has(dependency.successorId)
  )
  const workItems = snapshot.workItems.filter((workItem) =>
    workItem.projectId !== undefined
      ? projectScopeKeys.has(
          createPlanningProjectScopeKey(workItem.teamId, workItem.projectId),
        )
      : teamIds.has(workItem.teamId)
  )
  const workItemKeys = new Set(workItems.map((workItem) =>
    createWorkItemDependencyKey({ teamId: workItem.teamId, workItemId: workItem.id })
  ))
  const workItemDependencies = snapshot.workItemDependencies.filter((dependency) =>
    workItemKeys.has(createWorkItemDependencyKey(dependency.predecessor)) &&
    workItemKeys.has(createWorkItemDependencyKey(dependency.successor))
  )
  const workItemLinks = snapshot.workItemLinks
    .filter((link) => link.projectId !== undefined
      ? projectScopeKeys.has(
          createPlanningProjectScopeKey(link.teamId, link.projectId),
        )
      : teamIds.has(link.teamId))
    .filter((link) => workItemKeys.has(createWorkItemDependencyKey({
      teamId: link.teamId,
      workItemId: link.workItemId,
    })))
    .map((link) => ({
      ...link,
      ...(link.cycleId && entityIds.has(link.cycleId)
        ? {}
        : { cycleId: undefined }),
      ...(link.milestoneId && entityIds.has(link.milestoneId)
        ? {}
        : { milestoneId: undefined }),
      goalIds: link.goalIds.filter((goalId) => entityIds.has(goalId)),
    }))
  const updateTargets = snapshot.updateTargets
    .filter((updateTarget) =>
      updateTarget.target.type === 'initiative'
        ? entityIds.has(updateTarget.target.entityId)
        : projectScopeKeys.has(createPlanningProjectScopeKey(
            updateTarget.target.teamId,
            updateTarget.target.projectId,
          ))
    )
    .map((updateTarget) => {
      const target = updateTarget.target
      const currentScope = target.type === 'initiative'
        ? entities.find((entity) => entity.id === target.entityId)
        : target
      return filterPlanningLatestUpdateSummaryForPrincipal(
        updateTarget,
        currentScope,
        projectScopeKeys,
        teamIds,
      )
    })
    .map(stripPlanningLatestUpdateCapturedScope)
  const criticalEntityIds = snapshot.criticalPath.entityIds.filter((entityId) =>
    entityIds.has(entityId)
  )
  const slackByEntityId = Object.fromEntries(
    Object.entries(snapshot.criticalPath.slackByEntityId)
      .filter(([entityId]) => entityIds.has(entityId)),
  )

  return {
    ...snapshot,
    entities: scopedEntities,
    dependencies,
    workItemDependencies,
    workItemLinks,
    updateTargets,
    workItems,
    criticalPath: {
      entityIds: criticalEntityIds,
      totalDurationDays: criticalEntityIds.length === snapshot.criticalPath.entityIds.length
        ? snapshot.criticalPath.totalDurationDays
        : 0,
      slackByEntityId,
    },
    workItemDependencySummary: createPlanningWorkItemDependencySummary(
      workItemDependencies,
      workItems,
      workItemLinks,
    ),
  }
}

/**
 * Captures the Planning revision that serializes a Work Item Project assignment with archive.
 *
 * @param principal - Principal authorized to mutate the Work Item.
 * @returns Authorization snapshot bound to the current unfiltered Planning revision.
 */
export async function createPlanningFencedWorkItemAuthorizationSnapshot(
  principal: WorkspacePrincipal,
): Promise<WorkItemAuthorizationSnapshot> {
  const planningState = await workItemDependencies.planning.getAuthorizationState(
    principal.directoryId,
  )
  return createWorkItemAuthorizationSnapshot(principal, planningState.revision)
}

/**
 * Creates transaction checks for caller authorization sources outside the Planning graph.
 *
 * Planning META is intentionally excluded because the Planning client's own revision CAS already
 * fences it. Project ACL writes advance the active Workspace member version, while enterprise
 * role and assignment writes advance the optional CONTROL revision.
 *
 * @param principal - Principal whose endpoint-manager permissions were evaluated.
 * @param additionalMembers - Additional active members whose future permissions are required.
 * @param includePrincipalMembership - Whether the caller has a persisted membership row; false for service-account feed state.
 * @returns Workspace member and optional enterprise CONTROL condition checks.
 */
export function createPlanningCallerAuthorizationConditionChecks(
  principal: WorkspacePrincipal,
  additionalMembers: readonly Pick<WorkspaceMember, 'memberKey' | 'version'>[] = [],
  includePrincipalMembership = true,
): PlanningCallerAuthorizationConditionCheck[] {
  const members = new Map<string, Pick<WorkspaceMember, 'memberKey' | 'version'>>()
  const principalMembers = includePrincipalMembership ? [principal.workspaceMember] : []
  for (const member of [...principalMembers, ...additionalMembers]) {
    const memberKey = normalizeProjectMemberKey(member.memberKey)
    if (!members.has(memberKey)) members.set(memberKey, member)
  }
  const workspaceMemberChecks = [...members.values()].map((member) => ({
    ConditionCheck: {
      TableName:
        getEnv('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
        getEnv('WORKSPACE_ACCESS_TABLE_NAME') ??
        'mukuroji-workspace-access-local',
      Key: {
        workspaceId: principal.directoryId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(member.memberKey)}`,
      },
      ConditionExpression:
        '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#status': 'status',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':memberEntryType': 'workspace-member',
        ':active': 'active',
        ':expectedVersion': member.version,
      },
    },
  } satisfies PlanningCallerAuthorizationConditionCheck))
  const enterpriseTableName = getEnv('ENTERPRISE_IDENTITY_TABLE_NAME')?.trim()
  const controlRevision = principal.enterpriseIdentityControlRevision
  if (!enterpriseTableName || controlRevision === undefined) return workspaceMemberChecks

  const expressionAttributeNames: Record<string, string> = {
    '#controlRevision': 'controlRevision',
    '#entryType': 'entryType',
  }
  if (controlRevision === 0) expressionAttributeNames['#scopeKey'] = 'scopeKey'
  const enterpriseControlCheck = {
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
  } satisfies PlanningCallerAuthorizationConditionCheck
  return [...workspaceMemberChecks, enterpriseControlCheck]
}
