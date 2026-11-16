import {
  SoftwareTokenEnrollmentError,
  type CognitoClient,
  type SoftwareTokenEnrollmentPorts,
} from '../../modules/authentication'

/**
 * Creates the error for an authenticator operation the configured client does not provide.
 *
 * @returns The error.
 */
function createUnavailableError() {
  return new SoftwareTokenEnrollmentError(
    503,
    'AccountSecurityUnavailable',
    'This sign-in operation is not available.',
  )
}

/**
 * Connects the authenticator registration use case to Cognito.
 *
 * @param cognito - Cognito client of the request.
 * @returns The ports. Each answers 503 when the configured client lacks the operations it needs.
 */
export function createSoftwareTokenEnrollmentPorts(cognito: CognitoClient): SoftwareTokenEnrollmentPorts {
  const { associateSoftwareToken, verifySoftwareToken, setSoftwareTokenMfaEnabled } = cognito

  return {
    async associate(accessToken) {
      if (!associateSoftwareToken) throw createUnavailableError()
      return await associateSoftwareToken.call(cognito, { accessToken })
    },
    async verify(accessToken, code) {
      // Turning the app on follows a verified code, so both must exist before the code is used.
      if (!verifySoftwareToken || !setSoftwareTokenMfaEnabled) throw createUnavailableError()
      await verifySoftwareToken.call(cognito, { accessToken }, code)
    },
    async enable(accessToken) {
      if (!setSoftwareTokenMfaEnabled) throw createUnavailableError()
      await setSoftwareTokenMfaEnabled.call(cognito, accessToken, true)
    },
  }
}
