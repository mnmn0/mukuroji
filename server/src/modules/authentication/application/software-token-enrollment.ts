/** Error code of an authenticator registration that cannot go ahead. */
export type SoftwareTokenEnrollmentErrorCode =
  | 'MfaManagedBySso'
  | 'MfaAlreadyEnabled'
  | 'AccountSecurityUnavailable'

/** Raised when the signed-in user cannot register an authenticator app (TOTP). */
export class SoftwareTokenEnrollmentError extends Error {
  /** HTTP status the route answers with. */
  readonly status: 409 | 503
  /** Stable error code for clients. */
  readonly code: SoftwareTokenEnrollmentErrorCode

  /**
   * @param status - HTTP status the route answers with.
   * @param code - Stable error code for clients.
   * @param message - Description for clients.
   */
  constructor(status: 409 | 503, code: SoftwareTokenEnrollmentErrorCode, message: string) {
    super(message)
    this.name = 'SoftwareTokenEnrollmentError'
    this.status = status
    this.code = code
  }
}

/**
 * Identity provider operations that register an authenticator app for a signed-in user. An
 * operation this deployment cannot perform throws {@link SoftwareTokenEnrollmentError} 503.
 */
export type SoftwareTokenEnrollmentPorts = {
  /** Issues a new shared secret for the user's authenticator app. */
  associate(accessToken: string): Promise<{ secretCode: string }>
  /** Checks a code from the app against the issued secret. */
  verify(accessToken: string, code: string): Promise<void>
  /** Turns the registered app on as the user's MFA method. */
  enable(accessToken: string): Promise<void>
}

/** The signed-in user who registers an authenticator app. */
export type SoftwareTokenEnrollee = {
  /** Access token of the sign-in, which may be the setup token of an MFA_SETUP challenge. */
  accessToken: string
  /** Whether the sign-in came through an identity provider (SSO). */
  ssoSession: boolean
  /** Whether an authenticator app is already registered. */
  softwareTokenEnabled: boolean
}

/**
 * Requires that the user may register an authenticator app.
 *
 * An identity provider manages MFA for an SSO sign-in. A registered app is replaced only by
 * turning it off first, or by an administrator reset, so that a stolen session cannot swap it.
 *
 * @param enrollee - The signed-in user.
 * @throws SoftwareTokenEnrollmentError 409 when registration does not apply.
 */
function assertCanEnroll(enrollee: SoftwareTokenEnrollee) {
  if (enrollee.ssoSession) {
    throw new SoftwareTokenEnrollmentError(
      409,
      'MfaManagedBySso',
      'Your identity provider manages MFA for this account.',
    )
  }
  if (enrollee.softwareTokenEnabled) {
    throw new SoftwareTokenEnrollmentError(
      409,
      'MfaAlreadyEnabled',
      'An authenticator app is already registered. Turn it off first.',
    )
  }
}

/**
 * Starts registering an authenticator app and returns the shared secret to show as a QR code.
 *
 * @param ports - Identity provider operations.
 * @param enrollee - The signed-in user.
 * @returns The shared secret.
 * @throws SoftwareTokenEnrollmentError 409 when registration does not apply.
 */
export async function startSoftwareTokenEnrollment(
  ports: SoftwareTokenEnrollmentPorts,
  enrollee: SoftwareTokenEnrollee,
) {
  assertCanEnroll(enrollee)
  return await ports.associate(enrollee.accessToken)
}

/**
 * Finishes registering an authenticator app with a code from it, and turns it on.
 *
 * The code is checked before the app is turned on, so a wrong code leaves MFA unchanged.
 *
 * @param ports - Identity provider operations.
 * @param enrollee - The signed-in user.
 * @param code - Code shown by the authenticator app.
 * @throws SoftwareTokenEnrollmentError 409 when registration does not apply.
 */
export async function confirmSoftwareTokenEnrollment(
  ports: SoftwareTokenEnrollmentPorts,
  enrollee: SoftwareTokenEnrollee,
  code: string,
) {
  assertCanEnroll(enrollee)
  await ports.verify(enrollee.accessToken, code)
  await ports.enable(enrollee.accessToken)
}
