import type { ProjectMemberRole } from '../../../projects/api/members'
import type { TeamProjectMemberAccess } from '../../../projects/model/teamInsights'

/** The viewer facts that decide whether time can be recorded against a Work Item. */
export type TimeEntryWriter = {
  /** Whether the viewer is an active, non-guest Workspace member. */
  canMutate: boolean
  /** Whether the viewer is a system administrator, who bypasses Project roles. */
  isSystemAdmin: boolean
  /** Normalized member key used by Project membership records. */
  userKey?: string
}

/** The Work Item fields needed to decide write access. */
export type TimeEntryWritableCandidate = {
  /** Project the Work Item is assigned to, if any. */
  assignedProjectId?: string
}

/**
 * Collects the viewer's role in each Project of a Team.
 *
 * @param members - Project members of the Team, tagged with their Project.
 * @param userKey - Normalized key of the viewer.
 * @returns Viewer role keyed by Project ID.
 */
export function readViewerProjectRoles(
  members: readonly TeamProjectMemberAccess[],
  userKey: string | undefined,
): ReadonlyMap<string, ProjectMemberRole> {
  const roles = new Map<string, ProjectMemberRole>()
  if (!userKey) return roles
  for (const access of members) {
    if (access.member.id.trim().toLowerCase() === userKey) {
      roles.set(access.projectId, access.member.role)
    }
  }
  return roles
}

/**
 * Decides whether the viewer may record time against a Work Item, mirroring the server's write rule.
 *
 * A guest never writes and a system administrator always does. An item in a Project needs the
 * `member` or `manager` role there; an item without a Project needs that role in any Project of the
 * Team.
 *
 * @param item - Work Item to check.
 * @param writer - Viewer facts.
 * @param projectRoles - Viewer role keyed by Project ID within the item's Team.
 * @returns Whether a time entry for the item would be accepted.
 */
export function canRecordTimeOnWorkItem(
  item: TimeEntryWritableCandidate,
  writer: TimeEntryWriter,
  projectRoles: ReadonlyMap<string, ProjectMemberRole>,
): boolean {
  if (!writer.canMutate) return false
  if (writer.isSystemAdmin) return true
  if (item.assignedProjectId) {
    return isWritingRole(projectRoles.get(item.assignedProjectId))
  }
  return [...projectRoles.values()].some(isWritingRole)
}

/**
 * Checks whether a Project role may write Work Items.
 *
 * @param role - Role to check.
 * @returns Whether the role is `member` or `manager`.
 */
function isWritingRole(role: ProjectMemberRole | undefined): boolean {
  return role === 'member' || role === 'manager'
}
