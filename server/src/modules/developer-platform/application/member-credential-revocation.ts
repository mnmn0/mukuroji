import type { ApiKeySummary, OAuthAppSummary } from '@mukuroji/contracts'
import type { ApiKeyPort, OAuthCredentialPort } from './ports/credential-port'

/** Credential ports the revocation of a member's credentials uses. */
export type MemberCredentialRevocationPorts = {
  /** API key listing and revocation. */
  apiKeys: Pick<ApiKeyPort, 'listApiKeys' | 'revokeApiKey'>
  /** OAuth application listing and revocation. */
  oauthCredentials: Pick<OAuthCredentialPort, 'listOAuthApps' | 'revokeOAuthApp'>
}

/** Credentials a member created that still authenticate. */
export type MemberActiveCredentials = {
  /** Active API keys, Workspace and personal, the member created. */
  apiKeys: ApiKeySummary[]
  /** Active OAuth applications the member created; revoking one revokes its tokens. */
  oauthApps: OAuthAppSummary[]
}

/** Result of revoking a member's credentials. */
export type MemberCredentialRevocationResult = {
  /** IDs of the API keys revoked. */
  revokedApiKeyIds: string[]
  /** IDs of the OAuth applications revoked. */
  revokedOAuthAppIds: string[]
}

/**
 * Lists the credentials a member created that still authenticate.
 *
 * API keys and OAuth tokens act as their creator, so these stop working when the member leaves.
 *
 * @param ports - Credential ports.
 * @param workspaceId - Workspace of the member.
 * @param memberKey - Member whose credentials are listed.
 * @returns Active API keys and OAuth applications created by the member.
 */
export async function listMemberActiveCredentials(
  ports: MemberCredentialRevocationPorts,
  workspaceId: string,
  memberKey: string,
): Promise<MemberActiveCredentials> {
  const [apiKeys, oauthApps] = await Promise.all([
    ports.apiKeys.listApiKeys(workspaceId),
    ports.oauthCredentials.listOAuthApps(workspaceId),
  ])
  return {
    apiKeys: apiKeys.filter((apiKey) =>
      apiKey.status === 'active' && apiKey.createdByUserId === memberKey
    ),
    oauthApps: oauthApps.filter((oauthApp) =>
      oauthApp.status === 'active' && oauthApp.createdByUserId === memberKey
    ),
  }
}

/**
 * Revokes every active API key and OAuth application a member created.
 *
 * Used when the member is deactivated, so the credentials stay unusable even if the member is
 * reactivated later. Revocation is idempotent, so a retry after a partial failure finishes it.
 *
 * @param ports - Credential ports.
 * @param workspaceId - Workspace of the member.
 * @param memberKey - Member whose credentials are revoked.
 * @param actorUserId - Administrator or system actor recorded in the audit events.
 * @param limitTo - When given, only the member's credentials with these IDs are revoked, so a
 *   repeated request revokes the set it recorded and not credentials created since.
 * @returns The IDs of the credentials revoked.
 */
export async function revokeMemberCredentials(
  ports: MemberCredentialRevocationPorts,
  workspaceId: string,
  memberKey: string,
  actorUserId: string,
  limitTo?: MemberCredentialRevocationResult,
): Promise<MemberCredentialRevocationResult> {
  const active = await listMemberActiveCredentials(ports, workspaceId, memberKey)
  const credentials = limitTo
    ? {
        apiKeys: active.apiKeys.filter((apiKey) => limitTo.revokedApiKeyIds.includes(apiKey.id)),
        oauthApps: active.oauthApps.filter((oauthApp) => limitTo.revokedOAuthAppIds.includes(oauthApp.id)),
      }
    : active
  for (const apiKey of credentials.apiKeys) {
    await ports.apiKeys.revokeApiKey({ workspaceId, apiKeyId: apiKey.id, actorUserId })
  }
  for (const oauthApp of credentials.oauthApps) {
    await ports.oauthCredentials.revokeOAuthApp({ workspaceId, oauthAppId: oauthApp.id, actorUserId })
  }
  return {
    revokedApiKeyIds: credentials.apiKeys.map((apiKey) => apiKey.id),
    revokedOAuthAppIds: credentials.oauthApps.map((oauthApp) => oauthApp.id),
  }
}
