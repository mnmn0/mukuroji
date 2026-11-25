/** Credentials a revocation of a member's developer credentials revoked. */
export type RevokedMemberCredentials = {
  /** IDs of the API keys revoked. */
  revokedApiKeyIds: string[]
  /** IDs of the OAuth applications revoked. */
  revokedOAuthAppIds: string[]
}

/**
 * Revokes every API key and OAuth application a member created. Repeating it is harmless.
 *
 * Workspace Access owns this port so its use cases stay independent of the developer platform
 * module; the composition root connects it.
 *
 * @param workspaceId - Workspace of the member.
 * @param memberKey - Member whose credentials are revoked.
 * @param actorId - Member or service that asked for the revocation.
 * @returns The revoked credentials.
 */
export type MemberCredentialRevoker = (
  workspaceId: string,
  memberKey: string,
  actorId: string,
) => Promise<RevokedMemberCredentials>
