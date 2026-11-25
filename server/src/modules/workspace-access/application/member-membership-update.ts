import type { MutationAuditContext } from '../../audit'
import { canWorkspaceRoleManageMember, type WorkspaceRole } from '../domain/workspace-role'
import type {
  UpdateWorkspaceMemberInput,
  WorkspaceMember,
} from '../workspace-access'

/** Ports the Workspace member role and status update use case needs. */
export type MemberMembershipUpdatePorts = {
  /** Reads a member row, deactivated members included. */
  getMember(workspaceId: string, memberKey: string): Promise<WorkspaceMember | undefined>
  /** Applies the role and status change, checking the actor's authority and the expected version. */
  updateMember(
    workspaceId: string,
    actorMemberKey: string,
    memberKey: string,
    input: UpdateWorkspaceMemberInput,
    auditContext: MutationAuditContext | undefined,
  ): Promise<WorkspaceMember>
  /** Revokes every API key and OAuth app the member created; repeating it is harmless. */
  revokeMemberCredentials(workspaceId: string, memberKey: string, actorMemberKey: string): Promise<void>
}

/** Input of {@link updateMemberMembership}. */
export type MemberMembershipUpdateInput = {
  /** Workspace of the actor and the member. */
  workspaceId: string
  /** Member key of the administrator. */
  actorMemberKey: string
  /** Workspace role of the administrator. */
  actorRole: WorkspaceRole
  /** Member whose role or status changes. */
  memberKey: string
  /** Role and status change with the revisions it was authorized against. */
  update: UpdateWorkspaceMemberInput
  /** Audit context of the request. */
  auditContext?: MutationAuditContext
}

/**
 * Changes a Workspace member's role or status and keeps their developer credentials in step.
 *
 * API keys and OAuth apps act as their creator, so they are revoked when the member is
 * deactivated and stay revoked when the member comes back (ADR 0095). The access expiry job
 * deactivates without revoking, so a reactivation the actor may make revokes first; doing it
 * before the update keeps a failed reactivation safe to repeat. A deactivation revokes after the
 * update, and repeating the request after a failed revocation finishes it.
 *
 * @param ports - Member and credential ports.
 * @param input - Actor, member, change, and audit context.
 * @returns The updated member.
 * @throws WorkspaceAccessError when the update is refused.
 */
export async function updateMemberMembership(
  ports: MemberMembershipUpdatePorts,
  input: MemberMembershipUpdateInput,
): Promise<WorkspaceMember> {
  if (input.update.status === 'active') {
    const current = await ports.getMember(input.workspaceId, input.memberKey)
    // Only a reactivation the actor may make revokes anything; the update refuses the rest.
    if (
      current?.status === 'deactivated' &&
      canWorkspaceRoleManageMember(input.actorRole, current.role, input.update.role ?? current.role)
    ) {
      await ports.revokeMemberCredentials(input.workspaceId, current.memberKey, input.actorMemberKey)
    }
  }

  const member = await ports.updateMember(
    input.workspaceId,
    input.actorMemberKey,
    input.memberKey,
    input.update,
    input.auditContext,
  )
  if (member.status === 'deactivated') {
    await ports.revokeMemberCredentials(input.workspaceId, member.memberKey, input.actorMemberKey)
  }
  return member
}
