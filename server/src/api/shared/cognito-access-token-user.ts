import {
  CognitoServiceError,
  type GetUserResponse,
  type VerifiedAccessTokenUser,
} from '../../modules/authentication'
import { isEnterpriseSsoAuthenticationMethod } from '../../modules/enterprise-identity/enterprise-sso'
import { EnterpriseSessionActivityError } from '../../modules/enterprise-identity/enterprise-session-activity'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { authenticationDependencies, workspaceDependencies } from './app-dependencies'
import {
  createEnterpriseAuthenticationSessionId,
  getVerifiedEnterpriseAuthenticationMethods,
  type CognitoAccessTokenClaims,
} from './enterprise-access'
import { getEnv } from './runtime-config'
import { decodeJwtPayload } from './token-claims'

/**
 * Returns the enterprise SSO app client ID when an access token was issued to it.
 *
 * The claim is read without verifying the token; it only chooses how the token is verified.
 *
 * @param accessToken - Bearer access token, if any.
 * @returns The SSO app client ID, or undefined for any other token.
 */
export function resolveEnterpriseSsoAccessTokenClientId(accessToken: string | undefined) {
  const ssoClientId = getEnv('COGNITO_SSO_CLIENT_ID')?.trim()
  if (!ssoClientId || !accessToken) return undefined
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  return claims?.client_id === ssoClientId ? ssoClientId : undefined
}

/**
 * Reads the Cognito user behind an access token.
 *
 * @remarks
 * Password sign-in tokens go to Cognito `GetUser`, which also rejects revoked tokens. Enterprise
 * SSO tokens lack the `aws.cognito.signin.user.admin` scope `GetUser` requires, so they are
 * verified against the user pool signing keys and read with `AdminGetUser` instead. Such a check
 * cannot see Cognito-side revocation: a bearer SSO token must also pass
 * {@link requireEnterpriseSsoSessionAttestation}.
 *
 * @param accessToken - Access token to read the user for.
 * @returns The Cognito user; for an SSO token it also carries the verified token claims.
 */
export async function readCognitoAccessTokenUser(
  accessToken: string,
): Promise<GetUserResponse | VerifiedAccessTokenUser> {
  const cognito = authenticationDependencies.cognito
  const ssoClientId = resolveEnterpriseSsoAccessTokenClientId(accessToken)
  if (!ssoClientId) return await cognito.getUser(accessToken)
  if (!cognito.getUserFromVerifiedAccessToken) {
    throw new CognitoServiceError(
      503,
      'CognitoAccessTokenVerificationUnavailable',
      'Enterprise SSO access tokens cannot be verified by the configured Cognito client.',
    )
  }
  return await cognito.getUserFromVerifiedAccessToken(accessToken, ssoClientId)
}

/**
 * Requires that a bearer enterprise SSO access token belongs to a sign-in the API completed.
 *
 * @remarks
 * Nonce, `email_verified` and the email-to-state match are only checked by
 * `/api/auth/sso/exchange`, which then records an SSO marker for the token. A token obtained from
 * Cognito `/oauth2/token` directly has no marker and is refused here, as is a token whose sign-in
 * was signed out. Other tokens pass unchanged.
 *
 * @param accessToken - Bearer access token whose signature was already verified.
 * @param workspaceId - Workspace of the token's user.
 * @returns The server-verified authentication methods of an SSO token, or undefined for any other
 *   token.
 */
export async function requireEnterpriseSsoSessionAttestation(
  accessToken: string,
  workspaceId: string,
) {
  if (!resolveEnterpriseSsoAccessTokenClientId(accessToken)) return undefined
  const verifiedAuthenticationMethods = await getVerifiedEnterpriseAuthenticationMethods(
    workspaceId,
    createEnterpriseAuthenticationSessionId(accessToken),
  )
  const sessionActivity = workspaceDependencies.enterpriseSessionActivity
  if (
    !verifiedAuthenticationMethods.some(isEnterpriseSsoAuthenticationMethod) ||
    await isSignInRevoked(workspaceId, readSignInId(accessToken), sessionActivity)
  ) {
    throw new WorkspaceAccessError(
      401,
      'EnterpriseSsoSessionRequired',
      'Single sign-on is required for this Workspace account.',
    )
  }
  return verifiedAuthenticationMethods
}

/**
 * Longest access token validity Cognito allows (one day), in seconds. Every access token of a
 * sign-in was issued before its refresh token was revoked, so none outlives this bound.
 */
const maximumCognitoAccessTokenLifetimeSeconds = 24 * 60 * 60

/**
 * Reads the user behind the enterprise SSO access token presented at sign-out.
 *
 * The token may already be expired: another tab can hold a newer access token of the same
 * sign-in, so the sign-in must still be named. The signature, issuer and app client are verified.
 *
 * @param accessToken - Bearer access token of the session being signed out.
 * @returns The user and verified token claims, or undefined for a token of another app client.
 */
export async function readEnterpriseSsoSignOutUser(accessToken: string) {
  const ssoClientId = resolveEnterpriseSsoAccessTokenClientId(accessToken)
  if (!ssoClientId) return undefined
  const cognito = authenticationDependencies.cognito
  if (!cognito.getUserFromVerifiedAccessToken) {
    throw new CognitoServiceError(
      503,
      'CognitoAccessTokenVerificationUnavailable',
      'Enterprise SSO access tokens cannot be verified by the configured Cognito client.',
    )
  }
  return await cognito.getUserFromVerifiedAccessToken(accessToken, ssoClientId, {
    allowExpired: true,
  })
}

/**
 * Remembers that the sign-in of an enterprise SSO access token was signed out.
 *
 * Cognito `RevokeToken` does not reach tokens the API verifies locally, so every access token of
 * the sign-in is refused through this record. It is kept for the longest access token validity
 * Cognito allows, which covers tokens refreshed after the presented one.
 *
 * @param accessToken - Access token of the session being signed out, already verified.
 * @param workspaceId - Workspace of the token's user.
 */
export async function revokeEnterpriseSsoSignIn(accessToken: string, workspaceId: string) {
  const sessionActivity = workspaceDependencies.enterpriseSessionActivity
  if (!sessionActivity.revokeSignIn) {
    throw new CognitoServiceError(
      503,
      'AuthenticationRevocationUnavailable',
      'Session revocation is not available.',
    )
  }
  await sessionActivity.revokeSignIn.call(sessionActivity, {
    workspaceId,
    signInId: readSignInId(accessToken),
    expiresAt: Math.floor(Date.now() / 1_000) + maximumCognitoAccessTokenLifetimeSeconds,
  })
}

/**
 * Reads the identifier shared by every access token of one sign-in.
 *
 * @param accessToken - Access token whose signature was already verified.
 * @returns Cognito `origin_jti`, or the token digest when Cognito did not set one.
 */
function readSignInId(accessToken: string) {
  const originJti = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)?.origin_jti
  return typeof originJti === 'string' && originJti.trim()
    ? originJti.trim()
    : createEnterpriseAuthenticationSessionId(accessToken)
}

/**
 * Checks the sign-out record of a sign-in.
 *
 * @param workspaceId - Workspace that scopes the sign-in.
 * @param signInId - Sign-in identifier from {@link readSignInId}.
 * @param sessionActivity - Session activity store of the request.
 * @returns Whether the sign-in was signed out; fails closed when the store cannot tell.
 */
async function isSignInRevoked(
  workspaceId: string,
  signInId: string,
  sessionActivity: typeof workspaceDependencies.enterpriseSessionActivity,
) {
  if (!sessionActivity.isSignInRevoked) {
    throw new WorkspaceAccessError(
      503,
      'EnterpriseSessionActivityUnavailable',
      'Sign-out state could not be verified.',
    )
  }
  try {
    return await sessionActivity.isSignInRevoked.call(sessionActivity, workspaceId, signInId)
  } catch (error) {
    if (error instanceof EnterpriseSessionActivityError) {
      throw new WorkspaceAccessError(error.status, error.code, error.message, { cause: error })
    }
    throw error
  }
}
