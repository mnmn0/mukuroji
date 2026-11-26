import type { EnterpriseIdentitySnapshot, EnterpriseRoleAssignment } from '@mukuroji/contracts'
import {
  evaluateEnterpriseAccess,
  resolveEnterpriseDirectoryPrincipal,
  resolveEnterpriseRolePermissions,
} from './enterprise-authorization'

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

/** Whether an Enterprise role decides that a member manages a Project, as far as a background job can tell. */
export type EnterpriseProjectManagerStatus =
  /** No Enterprise role governs the member, so the Project member rows decide. */
  | 'not-governed'
  /** An Enterprise role grants `projects.manage` on the Project. */
  | 'manager'
  /** The member's Enterprise roles do not grant `projects.manage` on the Project. */
  | 'not-manager'
  /** The answer depends on directory groups known only from the member's sign-in. */
  | 'unknown'

/**
 * Evaluates, without the member's sign-in, whether the Enterprise roles that govern a member make
 * them a manager of a Project. It applies the same authority rule as notification delivery: a
 * member is governed once the directory manages them, a role is assigned to them, or one of their
 * directory groups is mapped. Directory group memberships synchronized by SCIM are known here;
 * groups that come only from a sign-in are not, so a refusal that such a group could change is
 * reported as unknown (ADR 0105).
 *
 * @param snapshot - Enterprise state of the Workspace.
 * @param memberKey - Member key.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The status.
 */
export function evaluateEnterpriseProjectManager(
  snapshot: EnterpriseIdentitySnapshot,
  memberKey: string,
  teamId: string,
  projectId: string,
): EnterpriseProjectManagerStatus {
  const normalized = memberKey.trim().toLowerCase()
  if (!normalized) return 'not-manager'
  const principal = resolveEnterpriseDirectoryPrincipal(snapshot, normalized, [])
  if (principal.deprovisioned) return 'not-manager'
  const signInGroupAssignments = snapshot.roleAssignments.some((assignment) =>
    assignment.principalKind === 'directory-group' && assignment.source !== 'directory-mapping')
  const governed = principal.directoryManaged ||
    principal.compatibleRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' && assignment.principalId.trim().toLowerCase() === normalized ||
      assignment.principalKind === 'directory-group' && assignment.source === 'directory-mapping') ||
    principal.compatibleGroupMappings.some((mapping) => mapping.enabled)
  if (!governed) return signInGroupAssignments ? 'unknown' : 'not-governed'
  const { allowed } = evaluateEnterpriseAccess({
    permission: 'projects.manage',
    principal: {
      kind: 'member',
      principalId: normalized,
      directoryGroupIds: principal.directoryGroupIds,
      directoryGroupMemberships: principal.directoryGroupMemberships,
      includeWorkspaceRolePermissions: false,
      directPermissions: ['workspace.read'],
      systemAdministrator: false,
    },
    assignments: principal.compatibleRoleAssignments,
    customRoles: snapshot.customRoles,
    groupMappings: principal.compatibleGroupMappings,
    resource: { workspaceId: snapshot.workspaceId, kind: 'project', targetId: projectId, parentTeamId: teamId },
  })
  if (allowed) return 'manager'
  return signInGroupAssignments ? 'unknown' : 'not-manager'
}
