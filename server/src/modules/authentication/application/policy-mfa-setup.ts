/**
 * Ports the policy-driven MFA setup decision needs.
 *
 * @typeParam TUser - Identity provider user the ports read.
 */
export type PolicyMfaSetupPorts<TUser> = {
  /**
   * Reads the signed-in user, or undefined when this deployment cannot read a user from this
   * access token, in which case the sign-in finishes without the policy check.
   */
  readUser(accessToken: string): Promise<TUser | undefined>
  /** Tells whether the user has any MFA method enabled. */
  hasEnabledMfa(user: TUser): boolean
  /** Tells whether the user's Workspace security policy requires MFA from the user. */
  isMfaRequiredByPolicy(user: TUser, accessToken: string): Promise<boolean>
}

/**
 * Result of {@link decidePolicyMfaSetup}.
 *
 * @typeParam TUser - Identity provider user the ports read.
 */
export type PolicyMfaSetupDecision<TUser> =
  | {
    /** The user must register an authenticator app before the sign-in returns tokens. */
    setupRequired: true
    /** Access token that the authenticator endpoints accept during the registration. */
    setupAccessToken: string
  }
  | {
    /** The sign-in may return its tokens. */
    setupRequired: false
    /** User the decision read, so that the sign-in response does not read it again. */
    user?: TUser
  }

/**
 * Decides whether a password-only sign-in must register an authenticator app first.
 *
 * The user pool keeps MFA optional, so the identity provider completes a sign-in without MFA
 * when the user has none. If the Workspace policy requires MFA, that session would be rejected
 * by every Workspace API, so the sign-in must register an app instead of returning tokens.
 *
 * @param ports - Identity provider and Workspace policy ports.
 * @param accessToken - Access token of the completed password sign-in.
 * @returns Whether setup is required, with the access token to set up with, or the user read.
 */
export async function decidePolicyMfaSetup<TUser>(
  ports: PolicyMfaSetupPorts<TUser>,
  accessToken: string | undefined,
): Promise<PolicyMfaSetupDecision<TUser>> {
  if (!accessToken) return { setupRequired: false }
  const user = await ports.readUser(accessToken)
  if (user === undefined) return { setupRequired: false }
  if (ports.hasEnabledMfa(user) || !(await ports.isMfaRequiredByPolicy(user, accessToken))) {
    return { setupRequired: false, user }
  }
  return { setupRequired: true, setupAccessToken: accessToken }
}
