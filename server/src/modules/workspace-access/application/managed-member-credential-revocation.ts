import type { MutationAuditContext } from '../../audit'
import { canWorkspaceRoleManageMember, type WorkspaceRole } from '../domain/workspace-role'
import {
  WorkspaceAccessError,
  type MemberCredentialRevocationRecord,
  type WorkspaceMember,
} from '../workspace-access'
import type { MemberCredentialRevoker, RevokedMemberCredentials } from './member-credential-revoker'

/** Ports an administrator's revocation of a member's credentials needs. */
export type ManagedMemberCredentialRevocationPorts = {
  /** Reads a member row, deactivated members included. */
  getMember(workspaceId: string, memberKey: string): Promise<WorkspaceMember | undefined>
  /** Lists the IDs of the active API keys and OAuth applications the member created. */
  listMemberCredentials(workspaceId: string, memberKey: string): Promise<RevokedMemberCredentials>
  /** Revokes the API keys and OAuth applications the member created, or only the given ones. */
  revokeMemberCredentials: MemberCredentialRevoker
  /**
   * Durable receipts keyed by the request's idempotency key; without them every request lists
   * the member's credentials again.
   */
  receipts?: {
    /** Reads the credentials an earlier request with the same key set out to revoke. */
    find(
      workspaceId: string,
      memberKey: string,
      auditContext: MutationAuditContext,
    ): Promise<MemberCredentialRevocationRecord | undefined>
    /** Records the credentials this request revokes, returning the set recorded under the key. */
    record(
      workspaceId: string,
      memberKey: string,
      credentials: MemberCredentialRevocationRecord,
      auditContext: MutationAuditContext,
    ): Promise<MemberCredentialRevocationRecord | undefined>
  }
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
  /** Audit context of the request; its idempotency key names the receipt. */
  auditContext?: MutationAuditContext
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
 * @param input - Actor, member, and audit context.
 * @returns The revoked credentials; a replay returns the set the first request recorded.
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
  const { receipts } = ports
  const { auditContext } = input
  if (!receipts || !auditContext) {
    return await ports.revokeMemberCredentials(input.workspaceId, member.memberKey, input.actorMemberKey)
  }
  // The set is recorded under the idempotency key before anything is revoked, so a replay after a
  // lost response or a partial failure revokes that same set, not credentials created since.
  const recorded = await receipts.find(input.workspaceId, member.memberKey, auditContext) ??
    await recordListedCredentials(ports, receipts, input.workspaceId, member.memberKey, auditContext)
  const planned = {
    revokedApiKeyIds: recorded.apiKeyIds,
    revokedOAuthAppIds: recorded.oauthAppIds,
  }
  await ports.revokeMemberCredentials(input.workspaceId, member.memberKey, input.actorMemberKey, planned)
  return planned
}

/**
 * Lists the member's active credentials and records them as the set this request revokes.
 *
 * @param ports - Credential ports.
 * @param receipts - Receipt store.
 * @param workspaceId - Workspace of the member.
 * @param memberKey - Member whose credentials are revoked.
 * @param auditContext - Audit context of the request.
 * @returns The set recorded under the request's idempotency key.
 */
async function recordListedCredentials(
  ports: ManagedMemberCredentialRevocationPorts,
  receipts: NonNullable<ManagedMemberCredentialRevocationPorts['receipts']>,
  workspaceId: string,
  memberKey: string,
  auditContext: MutationAuditContext,
): Promise<MemberCredentialRevocationRecord> {
  const listed = await ports.listMemberCredentials(workspaceId, memberKey)
  const recorded = await receipts.record(workspaceId, memberKey, {
    apiKeyIds: listed.revokedApiKeyIds,
    oauthAppIds: listed.revokedOAuthAppIds,
  }, auditContext)
  // Without audit events there is no receipt, and the listed set is revoked as before.
  return recorded ?? { apiKeyIds: listed.revokedApiKeyIds, oauthAppIds: listed.revokedOAuthAppIds }
}
