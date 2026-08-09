import type {
  PlanningEntity,
  PlanningUpdateTarget,
  PlanningUpdateTargetSummary,
  PlanningWorkItemSummary,
  WorkItemDependencyEndpoint,
  WorkItemScheduleDependency,
} from '@mukuroji/contracts'
import type { CurrentUser } from '../../auth/api'
import type {
  ProjectDirectoryTeam,
  ProjectMemberRole,
} from '../../projects/api'

/**
 * Planning UI が現在ユーザーの project role を判定するための access snapshot です。
 */
export type PlanningAccessSnapshot = {
  /** Project IDs that occur under more than one Team and cannot use unqualified roles safely. */
  ambiguousProjectIds: ReadonlySet<string>
  /** Project ID ごとの現在ユーザーの role です。 */
  projectRoles: Readonly<Record<string, ProjectMemberRole>>
  /** Team ID ごとの active Project ID 一覧です。 */
  projectIdsByTeamId: Readonly<Record<string, readonly string[]>>
}

/**
 * Planning scope の権限判定に必要な Team / Project 参照です。
 */
export type PlanningScope = {
  /** Team scope の Team ID です。 */
  teamId?: string
  /** Project scope の Project ID です。 */
  projectId?: string
}

/**
 * Project directory と現在ユーザーの role から Planning access snapshot を構築します。
 *
 * @param teams - Active Team / Project directory です。
 * @param projectRoles - Project ID ごとの現在ユーザーの role です。
 * @returns Planning scope 判定用の immutable snapshot です。
 */
export function createPlanningAccessSnapshot(
  teams: readonly ProjectDirectoryTeam[],
  projectRoles: Readonly<Record<string, ProjectMemberRole>>,
): PlanningAccessSnapshot {
  const projectIdCounts = new Map<string, number>()
  for (const project of teams.flatMap((team) => team.projects)) {
    projectIdCounts.set(project.id, (projectIdCounts.get(project.id) ?? 0) + 1)
  }
  return {
    ambiguousProjectIds: new Set(
      [...projectIdCounts]
        .filter(([, count]) => count > 1)
        .map(([projectId]) => projectId),
    ),
    projectRoles,
    projectIdsByTeamId: Object.fromEntries(
      teams.map((team) => [team.id, team.projects.map((project) => project.id)]),
    ),
  }
}

/**
 * 現在ユーザーが指定 Planning scope の構造を管理できるか判定します。
 *
 * @param user - Current user です。
 * @param scope - 判定対象の Team / Project scope です。
 * @param access - Current user の Project role snapshot です。
 * @returns Backend の manager 要件を満たす場合は true です。
 */
export function canManagePlanningScope(
  user: CurrentUser | null | undefined,
  scope: PlanningScope,
  access: PlanningAccessSnapshot,
) {
  return canUsePlanningScope(user, scope, access, 'manager', false)
}

/**
 * 現在ユーザーが指定 Planning entity に status update を投稿できるか判定します。
 *
 * @param user - Current user です。
 * @param entity - 判定対象の Planning entity です。
 * @param access - Current user の Project role snapshot です。
 * @returns Backend の member 要件を満たす場合は true です。
 */
export function canUpdatePlanningEntityStatus(
  user: CurrentUser | null | undefined,
  entity: PlanningEntity,
  access: PlanningAccessSnapshot,
) {
  return canUsePlanningScope(user, entity, access, 'member', false)
}

/**
 * Determines whether the current user may configure one Project or Initiative update cadence.
 *
 * @param user - Current authenticated user.
 * @param target - Project or Initiative update target.
 * @param entities - Visible Planning entities used to resolve Initiative scope.
 * @param access - Current user's Project role snapshot.
 * @returns True when the target scope satisfies the manager requirement.
 */
export function canManagePlanningUpdateTarget(
  user: CurrentUser | null | undefined,
  target: PlanningUpdateTarget,
  entities: readonly PlanningEntity[],
  access: PlanningAccessSnapshot,
) {
  const scope = resolvePlanningUpdateTargetScope(target, entities)
  return scope ? canManagePlanningScope(user, scope, access) : false
}

/**
 * Determines whether the current user may comment or react on one update target.
 *
 * @param user - Current authenticated user.
 * @param target - Project or Initiative update target.
 * @param entities - Visible Planning entities used to resolve Initiative scope.
 * @param access - Current user's Project role snapshot.
 * @returns True when the target scope satisfies the member requirement.
 */
export function canAnnotatePlanningUpdateTarget(
  user: CurrentUser | null | undefined,
  target: PlanningUpdateTarget,
  entities: readonly PlanningEntity[],
  access: PlanningAccessSnapshot,
) {
  const scope = resolvePlanningUpdateTargetScope(target, entities)
  return scope ? canUsePlanningScope(user, scope, access, 'member', true) : false
}

/**
 * Determines whether the current user may publish a manual Project or Initiative update.
 *
 * @param user - Current authenticated user.
 * @param target - Project or Initiative update target.
 * @param entities - Visible Planning entities used to resolve Initiative scope.
 * @param updateTargets - Cadence summaries used to enforce owner-only publishing.
 * @param access - Current user's Project role snapshot.
 * @returns True for the cadence owner or a target manager override.
 */
export function canPublishPlanningUpdateTarget(
  user: CurrentUser | null | undefined,
  target: PlanningUpdateTarget,
  entities: readonly PlanningEntity[],
  updateTargets: readonly PlanningUpdateTargetSummary[],
  access: PlanningAccessSnapshot,
) {
  const cadence = updateTargets.find((candidate) => planningUpdateTargetsMatch(
    candidate.target,
    target,
  ))?.cadence
  if (!cadence) return false
  const scope = resolvePlanningUpdateTargetScope(target, entities)
  if (!scope) return false
  const currentMemberKey = (user?.attributes.email ?? user?.username ?? '')
    .trim()
    .toLowerCase()
  if (cadence.updateOwnerMemberKey.trim().toLowerCase() === currentMemberKey) {
    return canUsePlanningScope(user, scope, access, 'member', true)
  }
  return canUsePlanningScope(user, scope, access, 'manager', false)
}

/**
 * 現在ユーザーが Work Item の Planning link を更新できるか判定します。
 *
 * @param user - Current user です。
 * @param workItem - 判定対象の canonical Work Item です。
 * @param access - Current user の Project role snapshot です。
 * @returns Work Item の Team / Project scope で member 要件を満たす場合は true です。
 */
export function canUpdatePlanningWorkItemLink(
  user: CurrentUser | null | undefined,
  workItem: PlanningWorkItemSummary,
  access: PlanningAccessSnapshot,
) {
  return canUsePlanningScope(user, workItem, access, 'member', false)
}

/**
 * Determines whether the current user can manage one canonical dependency endpoint.
 *
 * @param user - Current authenticated user.
 * @param endpoint - Team-qualified Work Item endpoint to authorize.
 * @param workItems - Visible Work Item projections from the authoritative Planning snapshot.
 * @param access - Current user's Project role snapshot.
 * @returns True when the endpoint is visible and its Team and assigned Project scopes satisfy the manager requirement.
 */
export function canManagePlanningWorkItemDependencyEndpoint(
  user: CurrentUser | null | undefined,
  endpoint: WorkItemDependencyEndpoint,
  workItems: readonly PlanningWorkItemSummary[],
  access: PlanningAccessSnapshot,
) {
  const workItem = workItems.find((candidate) =>
    candidate.teamId === endpoint.teamId && candidate.id === endpoint.workItemId
  )
  return workItem ? canManagePlanningScope(user, workItem, access) : false
}

/**
 * Determines whether the current user can mutate a dependency whose two endpoints are server-authorized independently.
 *
 * @param user - Current authenticated user.
 * @param dependency - Canonical Work Item dependency to authorize.
 * @param workItems - Visible Work Item projections from the authoritative Planning snapshot.
 * @param access - Current user's Project role snapshot.
 * @returns True only when both predecessor and successor satisfy the manager requirement.
 */
export function canManagePlanningWorkItemDependency(
  user: CurrentUser | null | undefined,
  dependency: Pick<WorkItemScheduleDependency, 'predecessor' | 'successor'>,
  workItems: readonly PlanningWorkItemSummary[],
  access: PlanningAccessSnapshot,
) {
  return canManagePlanningWorkItemDependencyEndpoint(
    user,
    dependency.predecessor,
    workItems,
    access,
  ) && canManagePlanningWorkItemDependencyEndpoint(
    user,
    dependency.successor,
    workItems,
    access,
  )
}

/**
 * 現在ユーザーが Work Item link から指定 Planning entity を参照できるか判定します。
 *
 * @param user - Current user です。
 * @param entity - Link 対象の Planning entity です。
 * @param access - Current user の Project role snapshot です。
 * @returns Entity scope で member 要件を満たす場合は true です。
 */
export function canLinkPlanningEntity(
  user: CurrentUser | null | undefined,
  entity: PlanningEntity,
  access: PlanningAccessSnapshot,
) {
  return canUsePlanningScope(user, entity, access, 'member', true)
}

/**
 * 現在ユーザーが少なくとも1つの Planning scope を管理できるか判定します。
 *
 * @param user - Current user です。
 * @param access - Current user の Project role snapshot です。
 * @returns Workspace 管理者または Project manager の場合は true です。
 */
export function canManageAnyPlanningScope(
  user: CurrentUser | null | undefined,
  access: PlanningAccessSnapshot,
) {
  if (!canWritePlanning(user)) return false
  if (user?.isSystemAdmin || isWorkspaceAdministrator(user)) return true
  return Object.entries(access.projectRoles).some(([projectId, role]) =>
    !access.ambiguousProjectIds.has(projectId) && role === 'manager'
  )
}

/**
 * Entity 作成時に現在ユーザーが選べる Team / Project scope だけを返します。
 *
 * @param user - Current user です。
 * @param teams - Active Team / Project directory です。
 * @param access - Current user の Project role snapshot です。
 * @returns Team scope と、その配下で管理可能な Project だけを含む directory です。
 */
export function filterManageablePlanningScopeTeams(
  user: CurrentUser | null | undefined,
  teams: readonly ProjectDirectoryTeam[],
  access: PlanningAccessSnapshot,
) {
  return teams.flatMap((team) => {
    if (!canManagePlanningScope(user, { teamId: team.id }, access)) return []

    return [{
      ...team,
      projects: team.projects.filter((project) =>
        canManagePlanningScope(user, {
          teamId: team.id,
          projectId: project.id,
        }, access)),
    }]
  })
}

function canUsePlanningScope(
  user: CurrentUser | null | undefined,
  scope: PlanningScope,
  access: PlanningAccessSnapshot,
  minimumRole: Extract<ProjectMemberRole, 'manager' | 'member'>,
  allowWorkspaceScopeMember: boolean,
) {
  if (!canWritePlanning(user)) return false
  if (user?.isSystemAdmin) return true

  const scopedProjectIds = scope.teamId
    ? access.projectIdsByTeamId[scope.teamId] ?? []
    : []
  if (
    scope.teamId &&
    !scopedProjectIds.some((projectId) =>
      !access.ambiguousProjectIds.has(projectId) &&
      roleAllows(access.projectRoles[projectId], minimumRole)
    )
  ) {
    return false
  }
  if (scope.projectId) {
    if (access.ambiguousProjectIds.has(scope.projectId)) return false
    if (!roleAllows(access.projectRoles[scope.projectId], minimumRole)) return false
    if (scope.teamId && !scopedProjectIds.includes(scope.projectId)) return false
  }
  if (!scope.teamId && !scope.projectId) {
    return allowWorkspaceScopeMember || isWorkspaceAdministrator(user)
  }
  return true
}

/**
 * Compares canonical Project and Initiative update target identities.
 *
 * @param left - First target identity.
 * @param right - Second target identity.
 * @returns True when both targets refer to the same Team-qualified Project or Initiative.
 */
function planningUpdateTargetsMatch(
  left: PlanningUpdateTarget,
  right: PlanningUpdateTarget,
) {
  if (left.type === 'initiative' && right.type === 'initiative') {
    return left.entityId === right.entityId
  }
  if (left.type === 'project' && right.type === 'project') {
    return left.teamId === right.teamId && left.projectId === right.projectId
  }
  return false
}

/**
 * Resolves the authorization scope represented by an update target.
 *
 * @param target - Project or Initiative update target.
 * @param entities - Visible Planning entities used to resolve Initiative scope.
 * @returns Team and Project scope, or undefined when the Initiative is not visible.
 */
function resolvePlanningUpdateTargetScope(
  target: PlanningUpdateTarget,
  entities: readonly PlanningEntity[],
): PlanningScope | undefined {
  if (target.type === 'project') {
    return { projectId: target.projectId, teamId: target.teamId }
  }
  return entities.find((entity) =>
    entity.type === 'initiative' && entity.id === target.entityId
  )
}

function canWritePlanning(
  user: CurrentUser | null | undefined,
): user is CurrentUser {
  return user !== null && user !== undefined &&
    user.workspaceMemberStatus === 'active' && user.workspaceRole !== 'guest'
}

function isWorkspaceAdministrator(user: CurrentUser) {
  return user.workspaceRole === 'owner' || user.workspaceRole === 'admin'
}

function roleAllows(
  role: ProjectMemberRole | undefined,
  minimumRole: Extract<ProjectMemberRole, 'manager' | 'member'>,
) {
  if (role === 'manager') return true
  return minimumRole === 'member' && role === 'member'
}
