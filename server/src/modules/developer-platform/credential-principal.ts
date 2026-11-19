import type { AuthenticatedDeveloperCredential } from './application/ports'

/**
 * Returns the stable caller identity used for Public API rate limits and idempotency.
 *
 * OAuth access tokens get a new ID on every issuance, so keying on the token would let a
 * client reset its rate-limit bucket and lose idempotency by fetching another token.
 * Token authentication therefore sets `principalId` to the issuing OAuth app. API keys
 * keep their ID across rotation, so they use the credential ID. The token ID stays the
 * audit actor.
 *
 * @param credential - Authenticated developer credential.
 * @returns The caller identity for rate-limit buckets and idempotency scopes.
 */
export function readCredentialPrincipalKey(
  credential: Pick<AuthenticatedDeveloperCredential, 'credentialId' | 'principalId'>,
) {
  return credential.principalId ?? credential.credentialId
}
