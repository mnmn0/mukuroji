import type { MutationAuditContext } from '../../audit'
import type { ReconcileDirectoryWorkspaceMemberInput, WorkspaceMember } from '../workspace-access'
import type { MemberCredentialRevoker } from './member-credential-revoker'

/** Ports the directory member reconciliation needs. */
export type DirectoryMemberReconciliationPorts = {
  /** Creates or updates a directory-managed member, reactivating a deactivated one. */
  reconcileDirectoryMember(
    workspaceId: string,
    input: ReconcileDirectoryWorkspaceMemberInput,
    auditContext: MutationAuditContext | undefined,
  ): Promise<WorkspaceMember>
  /** Revokes every API key and OAuth application the member created. */
  revokeMemberCredentials: MemberCredentialRevoker
}

/** Input of {@link reconcileDirectoryMemberAccess}. */
export type DirectoryMemberReconciliationInput = {
  /** Workspace of the member. */
  workspaceId: string
  /** Member row read before the reconciliation, or undefined for a new member. */
  existing: WorkspaceMember | undefined
  /** Directory state the member converges to. */
  member: ReconcileDirectoryWorkspaceMemberInput
  /** Audit context of the directory change; its actor is recorded on the revocation. */
  auditContext: MutationAuditContext
}

/**
 * Converges a member to the directory's state, revoking old credentials before a reactivation.
 *
 * The access expiry job deactivates without revoking, so a member the directory brings back
 * would otherwise find the API keys and OAuth applications they had before still working
 * (ADR 0095). Revoking before the reactivation, as an administrator's reactivation does, keeps a
 * failed reconciliation safe to repeat.
 *
 * @param ports - Member and credential ports.
 * @param input - Member before the change, the directory state, and the audit context.
 * @returns The reconciled member.
 */
export async function reconcileDirectoryMemberAccess(
  ports: DirectoryMemberReconciliationPorts,
  input: DirectoryMemberReconciliationInput,
): Promise<WorkspaceMember> {
  if (input.existing?.status === 'deactivated') {
    await ports.revokeMemberCredentials(input.workspaceId, input.existing.memberKey, input.auditContext.actor.id)
  }
  return await ports.reconcileDirectoryMember(input.workspaceId, input.member, input.auditContext)
}
