/**
 * Cognito login で API が受け付ける MFA challenge 名です。
 */
export type CognitoMfaChallengeName =
  | 'SOFTWARE_TOKEN_MFA'
  | 'SMS_MFA'
  | 'SMS_OTP'
  | 'EMAIL_OTP'

/**
 * Untrusted challenge 名を supported MFA challenge へ絞り込みます。
 */
export function readCognitoMfaChallengeName(
  value: unknown,
): CognitoMfaChallengeName | undefined {
  if (
    value === 'SOFTWARE_TOKEN_MFA' ||
    value === 'SMS_MFA' ||
    value === 'SMS_OTP' ||
    value === 'EMAIL_OTP'
  ) return value
  return undefined
}

/**
 * Supported challenge を Cognito challenge response parameter 名へ変換します。
 */
export function resolveCognitoMfaResponseKey(
  challenge: CognitoMfaChallengeName,
): string {
  if (challenge === 'SOFTWARE_TOKEN_MFA') return 'SOFTWARE_TOKEN_MFA_CODE'
  if (challenge === 'SMS_MFA') return 'SMS_MFA_CODE'
  if (challenge === 'SMS_OTP') return 'SMS_OTP_CODE'
  return 'EMAIL_OTP_CODE'
}
