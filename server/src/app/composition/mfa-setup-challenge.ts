import {
  MfaSetupChallengeError,
  type CognitoClient,
  type InitiateAuthResponse,
  type MfaSetupChallengePorts,
} from '../../modules/authentication'

/** Tokens of a sign-in that Cognito finished. */
type CognitoAuthenticationTokens = NonNullable<InitiateAuthResponse['AuthenticationResult']>

/**
 * Creates the error for a challenge operation the configured client does not provide.
 *
 * @returns The error.
 */
function createUnavailableError() {
  return new MfaSetupChallengeError(
    503,
    'AccountSecurityUnavailable',
    'This sign-in operation is not available.',
  )
}

/**
 * Connects the sign-in MFA_SETUP challenge use cases to Cognito.
 *
 * @param cognito - Cognito client of the request.
 * @returns The ports. Each answers 503 when the configured client lacks the operations it needs.
 */
export function createMfaSetupChallengePorts(
  cognito: CognitoClient,
): MfaSetupChallengePorts<CognitoAuthenticationTokens> {
  const { associateSoftwareToken, verifySoftwareToken, respondToMfaSetupChallenge } = cognito

  return {
    async associate(session) {
      if (!associateSoftwareToken) throw createUnavailableError()
      return await associateSoftwareToken.call(cognito, { session })
    },
    async verify(session, code) {
      // Answering the challenge follows a verified code, so both must exist before the code is used.
      if (!verifySoftwareToken || !respondToMfaSetupChallenge) throw createUnavailableError()
      return await verifySoftwareToken.call(cognito, { session }, code)
    },
    async respond(email, session) {
      if (!respondToMfaSetupChallenge) throw createUnavailableError()
      const response = await respondToMfaSetupChallenge.call(cognito, email, session)
      const tokens = response.AuthenticationResult
      return tokens?.AccessToken
        ? { tokens }
        : { nextChallenge: response.ChallengeName }
    },
  }
}
