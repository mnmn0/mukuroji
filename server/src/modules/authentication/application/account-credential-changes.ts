/** Error code of a password reset, password change, or authenticator removal that fails. */
export type AccountCredentialChangeErrorCode =
  | 'PasswordResetCodeInvalid'
  | 'PasswordManagedBySso'
  | 'CurrentPasswordIncorrect'
  | 'MfaRequiredByPolicy'
  | 'RecentSignInRequired'
  | 'AccountSecurityUnavailable'

/** HTTP status of an {@link AccountCredentialChangeError}. */
export type AccountCredentialChangeErrorStatus = 400 | 403 | 409 | 503

/** Raised when a user cannot reset or change the password, or remove the authenticator app. */
export class AccountCredentialChangeError extends Error {
  /** HTTP status the route answers with. */
  readonly status: AccountCredentialChangeErrorStatus
  /** Stable error code for clients. */
  readonly code: AccountCredentialChangeErrorCode

  /**
   * @param status - HTTP status the route answers with.
   * @param code - Stable error code for clients.
   * @param message - Description for clients.
   */
  constructor(
    status: AccountCredentialChangeErrorStatus,
    code: AccountCredentialChangeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AccountCredentialChangeError'
    this.status = status
    this.code = code
  }
}

/**
 * Identity provider operations that reset a forgotten password with an emailed code. An
 * operation this deployment cannot perform throws {@link AccountCredentialChangeError} 503.
 */
export type PasswordResetPorts = {
  /**
   * Emails a reset code. Resolves without a code for an address that has no account, or that
   * cannot receive one, so that the answer does not reveal which accounts exist.
   */
  sendCode(email: string): Promise<void>
  /**
   * Sets the new password. A wrong, expired, or unknown code, and an unknown account, throw
   * {@link AccountCredentialChangeError} 400 `PasswordResetCodeInvalid`.
   */
  confirm(email: string, code: string, newPassword: string): Promise<void>
}

/**
 * Emails a password reset code to an address that signs in with a password.
 *
 * The caller checks first that the address does not belong to an SSO domain.
 *
 * @param ports - Identity provider operations.
 * @param email - Normalized email address.
 */
export async function requestAccountPasswordReset(ports: PasswordResetPorts, email: string) {
  await ports.sendCode(email)
}

/**
 * Sets a new password with the emailed reset code.
 *
 * @param ports - Identity provider operations.
 * @param email - Normalized email address.
 * @param code - Code from the reset email.
 * @param newPassword - Password to sign in with from now on.
 * @throws AccountCredentialChangeError 400 `PasswordResetCodeInvalid` when the code does not apply.
 */
export async function confirmAccountPasswordReset(
  ports: PasswordResetPorts,
  email: string,
  code: string,
  newPassword: string,
) {
  await ports.confirm(email, code, newPassword)
}

/**
 * Identity provider operation that changes the signed-in user's password. A wrong current
 * password throws {@link AccountCredentialChangeError} 400 `CurrentPasswordIncorrect`, and an
 * operation this deployment cannot perform throws it with 503.
 */
export type PasswordChangePorts = {
  /** Replaces the password after the identity provider checks the current one. */
  changePassword(accessToken: string, currentPassword: string, newPassword: string): Promise<void>
}

/** The signed-in user who changes the password. */
export type PasswordChanger = {
  /** Access token of the sign-in. */
  accessToken: string
  /** Whether the sign-in came through an identity provider (SSO). */
  ssoSession: boolean
}

/**
 * Changes the signed-in user's password.
 *
 * An identity provider manages the password of an SSO sign-in, so mukuroji does not change it.
 *
 * @param ports - Identity provider operation.
 * @param changer - The signed-in user.
 * @param currentPassword - Password the user signs in with now.
 * @param newPassword - Password to sign in with from now on.
 * @throws AccountCredentialChangeError 409 `PasswordManagedBySso` for an SSO sign-in.
 */
export async function changeAccountPassword(
  ports: PasswordChangePorts,
  changer: PasswordChanger,
  currentPassword: string,
  newPassword: string,
) {
  if (changer.ssoSession) {
    throw new AccountCredentialChangeError(
      409,
      'PasswordManagedBySso',
      'Your identity provider manages this password.',
    )
  }
  await ports.changePassword(changer.accessToken, currentPassword, newPassword)
}

/**
 * Identity provider operation that turns the signed-in user's authenticator app off. An
 * operation this deployment cannot perform throws {@link AccountCredentialChangeError} 503.
 */
export type SoftwareTokenRemovalPorts = {
  /** Turns the authenticator app off as the user's MFA method. */
  disable(accessToken: string): Promise<void>
}

/** The signed-in user who removes the authenticator app. */
export type SoftwareTokenRemover = {
  /** Access token of the sign-in. */
  accessToken: string
  /** Whether a Workspace security policy requires MFA of the user. */
  mfaRequiredByPolicy: boolean
  /** Whether the user signed in within the policy's re-authentication window. */
  recentlyAuthenticated: boolean
}

/**
 * Turns the signed-in user's authenticator app off.
 *
 * A policy that requires MFA keeps it on. Only a recent sign-in may remove it, so that a stolen
 * access token is not enough to remove the second factor.
 *
 * @param ports - Identity provider operation.
 * @param remover - The signed-in user.
 * @throws AccountCredentialChangeError 409 `MfaRequiredByPolicy` or 403 `RecentSignInRequired`.
 */
export async function removeSoftwareToken(
  ports: SoftwareTokenRemovalPorts,
  remover: SoftwareTokenRemover,
) {
  if (remover.mfaRequiredByPolicy) {
    throw new AccountCredentialChangeError(
      409,
      'MfaRequiredByPolicy',
      'The Workspace security policy requires MFA.',
    )
  }
  if (!remover.recentlyAuthenticated) {
    throw new AccountCredentialChangeError(
      403,
      'RecentSignInRequired',
      'Sign in again before turning off the authenticator app.',
    )
  }
  await ports.disable(remover.accessToken)
}
