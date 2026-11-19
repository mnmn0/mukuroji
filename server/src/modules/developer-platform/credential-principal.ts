import type { AuthenticatedDeveloperCredential } from './application/ports'

/**
 * Returns the stable caller identity used for Public API rate limits and idempotency.
 *
 * OAuth access tokens get a new ID on every issuance, so keying on the token would let a
 * client reset its rate-limit bucket and lose idempotency by fetching another token. Tokens
 * are therefore grouped by their issuing OAuth app. API keys keep their ID across rotation,
 * so they continue to use the credential ID unchanged. The token ID stays the audit actor.
 */
export function readCredentialPrincipalKey(
  credential: Pick<AuthenticatedDeveloperCredential, 'kind' | 'credentialId' | 'oauthAppId'>,
) {
  if (credential.kind === 'oauth-token') {
    if (!credential.oauthAppId) {
      throw new Error('OAuth token credential is missing its OAuth app ID.')
    }
    return `oauth-app:${credential.oauthAppId}`
  }
  return credential.credentialId
}
