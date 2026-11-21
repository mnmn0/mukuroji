import type { Context } from 'hono'
import { workspaceDependencies } from './app-dependencies'
import {
  type CognitoAccessTokenClaims,
  createEnterpriseAuthenticationSessionId,
  readCognitoAuthenticationMethods,
  resolveEnterpriseClientIp,
} from './enterprise-access'
import { decodeJwtPayload, readNumericClaim } from './token-claims'

/** Authentication facts a realtime ticket records so the socket follows the session policy. */
export type RealtimeAuthenticationContext = {
  /** Cognito `auth_time`, or `iat` when absent, in epoch seconds. */
  authenticatedAt: number
  /** Access token `exp` in epoch seconds. */
  tokenExpiresAt: number
  /** SHA-256 digest of the access token that binds session-scoped elevation. */
  authenticationSessionId: string
  /** Authentication methods from the token and the verified session activity. */
  authenticationMethods: string[]
  /** Trusted client IP of the ticket request. */
  clientIp: string
}

/**
 * Reads the authentication facts of an already authenticated request for a realtime ticket.
 *
 * @param accessToken - Verified Cognito access token of the request.
 * @param workspaceId - Canonical Workspace ID of the principal.
 * @param context - Hono request context that resolves the trusted client IP.
 * @returns Authentication facts to store on the ticket.
 */
export async function readRealtimeAuthenticationContext(
  accessToken: string,
  workspaceId: string,
  context: Context,
): Promise<RealtimeAuthenticationContext> {
  const tokenClaims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const issuedAt = readNumericClaim(tokenClaims?.iat) ?? Math.floor(Date.now() / 1_000)
  const authenticatedAt = readNumericClaim(tokenClaims?.auth_time) ?? issuedAt
  const tokenExpiresAt = readNumericClaim(tokenClaims?.exp) ?? issuedAt + 60 * 60
  const authenticationSessionId = createEnterpriseAuthenticationSessionId(accessToken)
  const verifiedAuthenticationMethods =
    await workspaceDependencies.enterpriseSessionActivity.getAuthenticationMethods(
      workspaceId,
      authenticationSessionId,
    )

  return {
    authenticatedAt,
    tokenExpiresAt,
    authenticationSessionId,
    authenticationMethods: [
      ...new Set([
        ...readCognitoAuthenticationMethods(tokenClaims),
        ...verifiedAuthenticationMethods,
      ]),
    ],
    clientIp: resolveEnterpriseClientIp(context),
  }
}
