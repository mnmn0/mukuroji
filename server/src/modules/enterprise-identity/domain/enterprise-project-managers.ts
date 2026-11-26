import type { EnterpriseIdentitySnapshot, EnterpriseRoleAssignment } from '@mukuroji/contracts'
import { resolveEnterpriseRolePermissions } from './enterprise-authorization'

/**
 * Tells whether a role assignment makes a member a manager of one Project: a direct member
 * assignment of a role that grants `projects.manage` on that Project or on the Team that owns it.
 *
 * A directory group assignment is left out because group membership is known only from the
 * member's current sign-in, which a background job does not have.
 *
 * @param snapshot - Enterprise state of the Workspace.
 * @param assignment - Role assignment to test.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Whether the assignment grants manager access to the Project.
 */
function grantsProjectManagement(
  snapshot: Pick<EnterpriseIdentitySnapshot, 'customRoles'>,
  assignment: EnterpriseRoleAssignment,
  teamId: string,
  projectId: string,
) {
  if (assignment.principalKind !== 'member') return false
  const { scope } = assignment
  const inScope = scope.kind === 'project'
    ? scope.targetId === projectId && scope.parentTeamId === teamId
    : scope.kind === 'team' && scope.targetId === teamId
  return inScope && resolveEnterpriseRolePermissions(snapshot.customRoles, assignment.roleId).includes('projects.manage')
}

/**
 * Lists the members an Enterprise role makes managers of a Project (ADR 0105).
 *
 * @param snapshot - Enterprise state of the Workspace.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Member keys of the managers, without duplicates.
 */
export function listEnterpriseProjectManagerKeys(
  snapshot: Pick<EnterpriseIdentitySnapshot, 'customRoles' | 'roleAssignments'>,
  teamId: string,
  projectId: string,
): string[] {
  return [...new Set(snapshot.roleAssignments
    .filter((assignment) => grantsProjectManagement(snapshot, assignment, teamId, projectId))
    .map((assignment) => assignment.principalId))]
}
