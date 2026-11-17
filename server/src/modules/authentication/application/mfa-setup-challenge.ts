/** Error code of an authenticator registration inside the sign-in MFA_SETUP challenge. */
export type MfaSetupChallengeErrorCode =
  | 'UnsupportedAuthenticationChallenge'
  | 'AccountSecurityUnavailable'

/** Raised when the sign-in MFA_SETUP challenge cannot register an authenticator or sign in. */
export class MfaSetupChallengeError extends Error {
  /** HTTP status the route answers with. */
  readonly status: 409 | 503
  /** Stable error code for clients. */
  readonly code: MfaSetupChallengeErrorCode

  /**
   * @param status - HTTP status the route answers with.
   * @param code - Stable error code for clients.
   * @param message - Description for clients.
   */
  constructor(status: 409 | 503, code: MfaSetupChallengeErrorCode, message: string) {
    super(message)
    this.name = 'MfaSetupChallengeError'
    this.status = status
    this.code = code
  }
}

/** Result of answering the MFA_SETUP challenge after the authenticator is verified. */
export type MfaSetupChallengeAnswer<TTokens> = {
  /** Tokens of the finished sign-in, when the identity provider issued them. */
  tokens?: TTokens
  /** Next challenge the identity provider asked for instead of finishing the sign-in. */
  nextChallenge?: string
}

/**
 * Identity provider operations of the sign-in MFA_SETUP challenge. Each operation carries the
 * challenge session forward. An operation this deployment cannot perform throws
 * {@link MfaSetupChallengeError} 503.
 *
 * @typeParam TTokens - Tokens of a finished sign-in.
 */
export type MfaSetupChallengePorts<TTokens> = {
  /** Issues a shared secret for the user's authenticator app. */
  associate(session: string): Promise<{ secretCode: string; session?: string }>
  /** Checks a code from the app against the issued secret. */
  verify(session: string, code: string): Promise<{ session?: string }>
  /** Answers the challenge once the app is verified, which finishes the sign-in. */
  respond(email: string, session: string): Promise<MfaSetupChallengeAnswer<TTokens>>
}

/** A sign-in that must register an authenticator app before it finishes. */
export type MfaSetupChallengeSignIn = {
  /** Normalized email address of the user. */
  email: string
  /** Session the identity provider returned with the MFA_SETUP challenge. */
  session: string
}

/**
 * Starts registering an authenticator app inside the sign-in MFA_SETUP challenge.
 *
 * @param ports - Identity provider operations.
 * @param signIn - The sign-in waiting for MFA setup.
 * @returns The shared secret to show as a QR code, and the session to continue with.
 */
export async function startMfaSetupChallenge<TTokens>(
  ports: MfaSetupChallengePorts<TTokens>,
  signIn: MfaSetupChallengeSignIn,
) {
  const association = await ports.associate(signIn.session)
  return {
    secretCode: association.secretCode,
    session: association.session ?? signIn.session,
  }
}

/**
 * Finishes registering an authenticator app inside the MFA_SETUP challenge and signs in.
 *
 * The code is checked before the challenge is answered, so a wrong code leaves the sign-in
 * waiting for MFA setup.
 *
 * @param ports - Identity provider operations.
 * @param signIn - The sign-in waiting for MFA setup.
 * @param code - Code shown by the authenticator app.
 * @returns Tokens of the finished sign-in.
 * @throws MfaSetupChallengeError 409 when the identity provider asks for another challenge.
 */
export async function confirmMfaSetupChallenge<TTokens>(
  ports: MfaSetupChallengePorts<TTokens>,
  signIn: MfaSetupChallengeSignIn,
  code: string,
): Promise<TTokens> {
  const verified = await ports.verify(signIn.session, code)
  const answer = await ports.respond(signIn.email, verified.session ?? signIn.session)
  if (answer.tokens === undefined) {
    throw new MfaSetupChallengeError(
      409,
      'UnsupportedAuthenticationChallenge',
      answer.nextChallenge
        ? `Unsupported Cognito challenge: ${answer.nextChallenge}`
        : 'Cognito did not return an access token.',
    )
  }
  return answer.tokens
}
