import {
  AccountCredentialChangeError,
  CognitoServiceError,
  type CognitoClient,
  type PasswordChangePorts,
  type PasswordResetPorts,
  type SoftwareTokenRemovalPorts,
} from '../../modules/authentication'

/**
 * Creates the error for a credential operation the configured client does not provide.
 *
 * @returns The error.
 */
function createUnavailableError() {
  return new AccountCredentialChangeError(
    503,
    'AccountSecurityUnavailable',
    'This sign-in operation is not available.',
  )
}

/**
 * Cognito errors of a reset request that must not reveal whether the account exists.
 *
 * @param code - Cognito error code.
 * @returns Whether the request still counts as accepted.
 */
function isUndisclosedResetFailure(code: string) {
  return code === 'UserNotFoundException' ||
    code === 'NotAuthorizedException' ||
    code === 'InvalidParameterException' ||
    code === 'CodeDeliveryFailureException'
}

/**
 * Cognito errors of a reset confirmation that mean the code does not apply.
 *
 * @param code - Cognito error code.
 * @returns Whether the confirmation answers `PasswordResetCodeInvalid`.
 */
function isInvalidResetCode(code: string) {
  return code === 'CodeMismatchException' ||
    code === 'ExpiredCodeException' ||
    code === 'UserNotFoundException' ||
    code === 'NotAuthorizedException'
}

/**
 * Connects the self-service password reset use cases to Cognito.
 *
 * @param cognito - Cognito client of the request.
 * @returns The ports. Each answers 503 when the configured client lacks its operation.
 */
export function createPasswordResetPorts(cognito: CognitoClient): PasswordResetPorts {
  const { requestPasswordReset, confirmPasswordReset } = cognito

  return {
    async sendCode(email) {
      if (!requestPasswordReset) throw createUnavailableError()
      try {
        await requestPasswordReset.call(cognito, email)
      } catch (error) {
        if (!(error instanceof CognitoServiceError) || !isUndisclosedResetFailure(error.code)) {
          throw error
        }
        if (error.code === 'CodeDeliveryFailureException') {
          console.error('Password reset code delivery failed:', error)
        }
      }
    },
    async confirm(email, code, newPassword) {
      if (!confirmPasswordReset) throw createUnavailableError()
      try {
        await confirmPasswordReset.call(cognito, email, code, newPassword)
      } catch (error) {
        if (error instanceof CognitoServiceError && isInvalidResetCode(error.code)) {
          throw new AccountCredentialChangeError(
            400,
            'PasswordResetCodeInvalid',
            'The code is invalid or expired. Request a new code.',
          )
        }
        throw error
      }
    },
  }
}

/**
 * Connects the password change use case to Cognito.
 *
 * @param cognito - Cognito client of the request.
 * @returns The ports. They answer 503 when the configured client cannot change passwords.
 */
export function createPasswordChangePorts(cognito: CognitoClient): PasswordChangePorts {
  const { changePassword } = cognito

  return {
    async changePassword(accessToken, currentPassword, newPassword) {
      if (!changePassword) throw createUnavailableError()
      try {
        await changePassword.call(cognito, accessToken, currentPassword, newPassword)
      } catch (error) {
        // The caller's access token was just accepted by GetUser, so a rejection is the password.
        if (error instanceof CognitoServiceError && error.code === 'NotAuthorizedException') {
          throw new AccountCredentialChangeError(
            400,
            'CurrentPasswordIncorrect',
            'The current password is incorrect.',
          )
        }
        throw error
      }
    },
  }
}

/**
 * Connects the authenticator removal use case to Cognito.
 *
 * @param cognito - Cognito client of the request.
 * @returns The ports. They answer 503 when the configured client cannot change MFA settings.
 */
export function createSoftwareTokenRemovalPorts(cognito: CognitoClient): SoftwareTokenRemovalPorts {
  const { setSoftwareTokenMfaEnabled } = cognito

  return {
    async disable(accessToken) {
      if (!setSoftwareTokenMfaEnabled) throw createUnavailableError()
      await setSoftwareTokenMfaEnabled.call(cognito, accessToken, false)
    },
  }
}
