import type { MfaSetupChallenge } from '@mukuroji/contracts'
import {
  FlociCognitoClient,
  type AuthTokenSet,
  type GetUserResponse,
  type InitiateAuthResponse,
} from '../../modules/authentication'
import {
  authenticationDependencies,
  requireAppDependencies,
  workspaceDependencies,
} from './app-dependencies'
import { toProjectPrincipal } from './authentication-session'
import { isEnterpriseExternalMember, type CognitoAccessTokenClaims } from './enterprise-access'
import { getEnv } from './runtime-config'
import { decodeJwtPayload, readNumericClaim } from './token-claims'

/**
 * Checks whether a Cognito user has any MFA method enabled.
 *
 * @param user - Cognito GetUser response.
 * @returns Whether an MFA method is enabled.
 */
export function hasEnabledMfa(user: GetUserResponse) {
  return Boolean(
    user.PreferredMfaSetting?.trim() ||
    user.UserMFASettingList?.some((setting) => Boolean(setting.trim())),
  )
}

/**
 * Checks whether an access token belongs to an enterprise SSO session.
 *
 * SSO users have no mukuroji password and get MFA from their identity provider.
 *
 * @param accessToken - Cognito access token of the request.
 * @returns Whether the token was issued to the SSO app client.
 */
export function isSsoSessionAccessToken(accessToken: string) {
  const ssoClientId = getEnv('COGNITO_SSO_CLIENT_ID')?.trim()
  if (!ssoClientId) return false
  return decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)?.client_id === ssoClientId
}

/**
 * Reads whether the user's Workspace security policy requires MFA from this user.
 *
 * It applies the same rule as session validation: MFA is required when the policy requires it
 * for everyone, or when the user is external (a guest, or outside every verified domain) and
 * the external-access policy requires it.
 *
 * @param user - Cognito GetUser response.
 * @param accessToken - Access token of the user.
 * @returns The policy, and whether it requires MFA from the user.
 */
export async function readMfaRequirement(user: GetUserResponse, accessToken: string) {
  const principal = toProjectPrincipal(user, accessToken)
  const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(
    principal.directoryId,
  )
  const policy = snapshot.policy
  if (!policy) return { policy, mfaRequired: false }
  if (policy.mfaRequirement === 'required') return { policy, mfaRequired: true }
  if (!policy.externalAccess.requireMfa) return { policy, mfaRequired: false }
  const member = await workspaceDependencies.workspaceAccess.getActiveMember(
    principal.directoryId,
    principal.userKey,
  )
  return {
    policy,
    mfaRequired: member !== undefined && isEnterpriseExternalMember(snapshot, member),
  }
}

/**
 * Checks whether the user signed in recently enough for a sensitive account change.
 *
 * @param accessToken - Access token of the user.
 * @param maximumAgeMinutes - Longest time since sign-in that still counts as recent.
 * @param nowMilliseconds - Current time.
 * @returns Whether the token's `auth_time` (or `iat`) is within the limit.
 */
export function isRecentlyAuthenticated(
  accessToken: string,
  maximumAgeMinutes: number,
  nowMilliseconds = Date.now(),
) {
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const authenticatedAt = readNumericClaim(claims?.auth_time) ?? readNumericClaim(claims?.iat)
  const nowSeconds = Math.floor(nowMilliseconds / 1000)
  return authenticatedAt !== undefined &&
    authenticatedAt <= nowSeconds &&
    nowSeconds - authenticatedAt <= maximumAgeMinutes * 60
}

/**
 * Reads Cognito's own MFA_SETUP challenge from a sign-in step.
 *
 * Cognito asks for it when the user pool requires MFA and the user has none.
 *
 * @param response - Response of a Cognito sign-in step.
 * @param email - Normalized email address of the user.
 * @returns The challenge, or undefined when Cognito asked for something else.
 */
export function readCognitoMfaSetupChallenge(
  response: InitiateAuthResponse,
  email: string,
): MfaSetupChallenge | undefined {
  if (response.ChallengeName !== 'MFA_SETUP' || !response.Session) return undefined
  return { challenge: 'MFA_SETUP', email, session: response.Session }
}

/**
 * Decides whether a password-only sign-in must register an authenticator app first.
 *
 * The user pool keeps MFA optional, so Cognito completes a sign-in without MFA when the user
 * has none. If the Workspace policy requires MFA, that session would be rejected by every
 * Workspace API. Instead of the tokens, the sign-in returns an MFA_SETUP challenge carrying the
 * access token, which the authenticator endpoints accept. The refresh token is not returned, so
 * the session cannot be kept; the user signs in again with the new code.
 *
 * @param tokens - Tokens of a completed password sign-in.
 * @param email - Normalized email address of the user.
 * @returns The challenge when the user must register first; otherwise the Cognito user it read,
 *   so that the sign-in response does not read it again.
 */
export async function resolvePolicyMfaSetupChallenge(
  tokens: AuthTokenSet,
  email: string,
): Promise<{ challenge: MfaSetupChallenge } | { user?: GetUserResponse }> {
  const accessToken = tokens.AccessToken
  if (!accessToken) return {}
  if (
    requireAppDependencies().authentication.cognito instanceof FlociCognitoClient &&
    accessToken.split('.').length !== 3
  ) {
    return {}
  }
  const user = await authenticationDependencies.cognito.getUser(accessToken)
  if (hasEnabledMfa(user) || !(await readMfaRequirement(user, accessToken)).mfaRequired) {
    return { user }
  }
  return { challenge: { challenge: 'MFA_SETUP', email, setupAccessToken: accessToken } }
}
