import {
  completeMfaSetupChallenge,
  startMfaSetupChallenge,
  startSoftwareTokenSetup,
  verifySoftwareTokenSetup,
  type MfaSetupChallenge,
  type SoftwareTokenSetupStart,
} from '../../../auth/api'
import { saveAuthSession } from '../../../auth/session'

/**
 * How a finished sign-in registration continues.
 *
 * - `signed-in`: Cognito's own challenge issued the session, which is saved
 * - `sign-in-again`: a setup token only registered the app; the user signs in again with a code
 */
export type LoginAuthenticatorSetupResult = 'signed-in' | 'sign-in-again'

/**
 * Registers an authenticator app while signing in, for either kind of MFA_SETUP challenge.
 *
 * @param challenge - MFA_SETUP challenge of the sign-in.
 * @param remember - Whether the session should be remembered on this device.
 * @returns Actions that start and finish the registration.
 */
export function useLoginAuthenticatorSetup(challenge: MfaSetupChallenge, remember: boolean) {
  return {
    /**
     * Issues the shared secret to show as a QR code.
     *
     * @returns The secret and, during Cognito's challenge, the updated session.
     */
    start(): Promise<SoftwareTokenSetupStart> {
      return challenge.setupAccessToken
        ? startSoftwareTokenSetup(challenge.setupAccessToken)
        : startMfaSetupChallenge({ email: challenge.email, session: challenge.session ?? '' })
    },
    /**
     * Confirms the registration with a code from the app.
     *
     * @param code - Code shown by the authenticator app.
     * @param session - Session returned when the registration started, if any.
     * @returns How the sign-in continues.
     */
    async verify(code: string, session: string | undefined): Promise<LoginAuthenticatorSetupResult> {
      if (challenge.setupAccessToken) {
        await verifySoftwareTokenSetup(challenge.setupAccessToken, code)
        return 'sign-in-again'
      }
      saveAuthSession(await completeMfaSetupChallenge({
        code,
        email: challenge.email,
        remember,
        session: session ?? challenge.session ?? '',
      }))
      return 'signed-in'
    },
  }
}
