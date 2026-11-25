/**
 * Workspace 全体で member に付与される canonical role です。
 */
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'

/**
 * Reports whether an actor's Workspace role may change a member's role or status.
 *
 * An owner manages everyone. An admin manages members and guests, and may give them only the
 * member or guest role.
 *
 * @param actorRole - Workspace role of the actor.
 * @param targetRole - Current Workspace role of the member.
 * @param nextRole - Workspace role the member has after the change.
 * @returns Whether the change is within the actor's authority.
 */
export function canWorkspaceRoleManageMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  nextRole: WorkspaceRole,
): boolean {
  if (actorRole === 'owner') return true
  return actorRole === 'admin' &&
    (targetRole === 'member' || targetRole === 'guest') &&
    (nextRole === 'member' || nextRole === 'guest')
}
