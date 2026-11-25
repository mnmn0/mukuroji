import type { EnterpriseMemberRoleAssignmentScope } from '../../security/api'

/** Role that is assigned directly to a member, as the member list shows it. */
export type MemberRoleAssignmentLabel = {
  /** Assignment ID, unique within the Workspace. */
  id: string
  /** Display name of the role, or its ID when the role is not listed. */
  roleName: string
  /** Resource level the role applies to. */
  scopeType: EnterpriseMemberRoleAssignmentScope
}

/** Parts of the security snapshot that name each member's direct roles. */
export type MemberRoleAssignmentSource = {
  /** Roles assigned directly to members. */
  memberRoleAssignments: ReadonlyArray<{
    /** Assignment ID. */
    id: string
    /** Member who holds the role. */
    memberKey: string
    /** Assigned role. */
    roleId: string
    /** Resource level of the assignment. */
    scopeType: EnterpriseMemberRoleAssignmentScope
  }>
  /** Role definitions, for their display names. */
  roles: ReadonlyArray<{
    /** Role ID. */
    id: string
    /** Display name. */
    name: string
  }>
}

/**
 * Groups the direct role assignments by member, with role names, for the member list.
 *
 * @param source - Assignments and role definitions from the security snapshot.
 * @returns Each member's direct roles, broadest scope first (Workspace, OrgUnit, Team, Project).
 */
export function groupMemberRoleAssignments(
  source: MemberRoleAssignmentSource,
): Map<string, MemberRoleAssignmentLabel[]> {
  const roleNames = new Map(source.roles.map((role) => [role.id, role.name]))
  const scopeOrder: Record<EnterpriseMemberRoleAssignmentScope, number> = {
    workspace: 0,
    // An OrgUnit covers the Teams under it, so its roles come before a single Team's.
    'org-unit': 1,
    team: 2,
    project: 3,
  }
  const grouped = new Map<string, MemberRoleAssignmentLabel[]>()
  for (const assignment of source.memberRoleAssignments) {
    const labels = grouped.get(assignment.memberKey) ?? []
    labels.push({
      id: assignment.id,
      roleName: roleNames.get(assignment.roleId) ?? assignment.roleId,
      scopeType: assignment.scopeType,
    })
    grouped.set(assignment.memberKey, labels)
  }
  for (const labels of grouped.values()) {
    labels.sort((left, right) =>
      scopeOrder[left.scopeType] - scopeOrder[right.scopeType] ||
      left.roleName.localeCompare(right.roleName)
    )
  }
  return grouped
}
