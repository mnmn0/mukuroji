import { canWorkspaceRoleManageMember, type WorkspaceRole } from '../domain/workspace-role'
import { WorkspaceAccessError, type WorkspaceMember } from '../workspace-access'
import type { MemberCredentialRevoker, RevokedMemberCredentials } from './member-credential-revoker'

/** Ports an administrator's revocation of a member's credentials needs. */
export type ManagedMemberCredentialRevocationPorts = {
  /** Reads a member row, deactivated members included. */
  getMember(workspaceId: string, memberKey: string): Promise<WorkspaceMember | undefined>
  /** Revokes every API key and OAuth application the member created. */
  revokeMemberCredentials: MemberCredentialRevoker
}

/** Input of {@link revokeManagedMemberCredentials}. */
export type ManagedMemberCredentialRevocationInput = {
  /** Workspace of the actor and the member. */
  workspaceId: string
  /** Member key of the administrator. */
  actorMemberKey: string
  /** Workspace role of the administrator. */
  actorRole: WorkspaceRole
  /** Member whose credentials are revoked. */
  memberKey: string
}

/**
 * Revokes every API key and OAuth application a member created, for an administrator who may
 * manage that member.
 *
 * Deactivation already does this; an administrator can do it beforehand, or finish it when the
 * deactivation succeeded but the revocation did not. The authority matches role changes and
 * deactivation: owners act on everyone, admins on members and guests.
 *
 * @param ports - Member and credential ports.
 * @param input - Actor and member.
 * @returns The revoked credentials.
 * @throws WorkspaceAccessError 404 when the member is missing, 403 when the actor may not manage them.
 */
export async function revokeManagedMemberCredentials(
  ports: ManagedMemberCredentialRevocationPorts,
  input: ManagedMemberCredentialRevocationInput,
): Promise<RevokedMemberCredentials> {
  const member = await ports.getMember(input.workspaceId, input.memberKey)
  if (!member) {
    throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
  }
  if (!canWorkspaceRoleManageMember(input.actorRole, member.role, member.role)) {
    throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'The Workspace role cannot manage this member.')
  }
  return await ports.revokeMemberCredentials(input.workspaceId, member.memberKey, input.actorMemberKey)
}
