import type { PlanningEntity, PlanningWorkItemSummary } from '@mukuroji/contracts'
import type { CurrentUser } from '../auth/api'
import type {
  ProjectDirectoryTeam,
  ProjectMemberRole,
} from '../projects/api'

/**
 * Planning UI が現在ユーザーの project role を判定するための access snapshot です。
 */
export type PlanningAccessSnapshot = {
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
  return {
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
  return Object.values(access.projectRoles).some((role) => role === 'manager')
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
    !scopedProjectIds.some((projectId) => roleAllows(access.projectRoles[projectId], minimumRole))
  ) {
    return false
  }
  if (scope.projectId) {
    if (!roleAllows(access.projectRoles[scope.projectId], minimumRole)) return false
    if (scope.teamId && !scopedProjectIds.includes(scope.projectId)) return false
  }
  if (!scope.teamId && !scope.projectId) {
    return allowWorkspaceScopeMember || isWorkspaceAdministrator(user)
  }
  return true
}

function canWritePlanning(
  user: CurrentUser | null | undefined,
): user is CurrentUser {
  return user !== null && user !== undefined && user.workspaceRole !== 'guest'
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
