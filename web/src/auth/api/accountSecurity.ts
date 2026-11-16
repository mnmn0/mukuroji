import type {
  AccountSecurityStatus,
  MfaSetupChallenge,
  SoftwareTokenSetupStart,
} from '@mukuroji/contracts'
import type { AuthSession } from '../session'
import { isRecord } from '../../shared/api/jsonValidation'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { ApiError } from './errors'
import { parseAuthSession } from './authentication'

export type { AccountSecurityStatus, MfaSetupChallenge, SoftwareTokenSetupStart }

/** Input that sets a new password with an emailed reset code. */
export type ConfirmPasswordResetInput = {
  /** Email address of the account. */
  email: string
  /** Code from the reset email. */
  code: string
  /** New password. */
  newPassword: string
}

/** Input that changes the signed-in user's password. */
export type ChangePasswordInput = {
  /** Current password. */
  currentPassword: string
  /** New password. */
  newPassword: string
}

const apiBaseUrl = resolveApiBaseUrl()

/**
 * Asks the API to email a password reset code.
 *
 * The API answers the same way whether or not the account exists.
 *
 * @param email - Email address of the account.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await sendRequest('/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

/**
 * Sets a new password with the emailed reset code.
 *
 * @param input - Email address, code, and new password.
 */
export async function confirmPasswordReset(input: ConfirmPasswordResetInput): Promise<void> {
  await sendRequest('/auth/password-reset/confirm', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/**
 * Reads how the signed-in user signs in.
 *
 * @param accessToken - Access token of the session.
 * @returns Password and authenticator state.
 */
export async function getAccountSecurity(accessToken: string): Promise<AccountSecurityStatus> {
  const data = await sendRequest('/auth/account-security', {}, accessToken)
  if (
    !isRecord(data) ||
    typeof data.passwordManaged !== 'boolean' ||
    typeof data.softwareTokenMfaEnabled !== 'boolean' ||
    typeof data.mfaRequiredByPolicy !== 'boolean'
  ) {
    throw createMalformedResponseError()
  }
  return {
    passwordManaged: data.passwordManaged,
    softwareTokenMfaEnabled: data.softwareTokenMfaEnabled,
    mfaRequiredByPolicy: data.mfaRequiredByPolicy,
  }
}

/**
 * Changes the signed-in user's password.
 *
 * @param accessToken - Access token of the session.
 * @param input - Current and new passwords.
 */
export async function changePassword(
  accessToken: string,
  input: ChangePasswordInput,
): Promise<void> {
  await sendRequest('/auth/password/change', {
    method: 'POST',
    body: JSON.stringify(input),
  }, accessToken)
}

/**
 * Starts authenticator app registration for a signed-in user or an MFA_SETUP setup token.
 *
 * @param accessToken - Access token of the session or the challenge's setup token.
 * @returns The shared secret and account name.
 */
export async function startSoftwareTokenSetup(
  accessToken: string,
): Promise<SoftwareTokenSetupStart> {
  return parseSoftwareTokenSetupStart(
    await sendRequest('/auth/mfa/totp/associate', { method: 'POST', body: '{}' }, accessToken),
  )
}

/**
 * Finishes authenticator app registration and turns MFA on.
 *
 * @param accessToken - Access token of the session or the challenge's setup token.
 * @param code - Code shown by the authenticator app.
 */
export async function verifySoftwareTokenSetup(accessToken: string, code: string): Promise<void> {
  await sendRequest('/auth/mfa/totp/verify', {
    method: 'POST',
    body: JSON.stringify({ code }),
  }, accessToken)
}

/**
 * Turns the signed-in user's authenticator app off.
 *
 * @param accessToken - Access token of the session.
 */
export async function disableSoftwareToken(accessToken: string): Promise<void> {
  await sendRequest('/auth/mfa/totp', { method: 'DELETE' }, accessToken)
}

/**
 * Starts authenticator registration inside Cognito's sign-in MFA_SETUP challenge.
 *
 * @param challenge - Challenge returned by sign-in, carrying a Cognito session.
 * @returns The shared secret and the updated session.
 */
export async function startMfaSetupChallenge(
  challenge: Pick<MfaSetupChallenge, 'email'> & { session: string },
): Promise<SoftwareTokenSetupStart> {
  return parseSoftwareTokenSetupStart(
    await sendRequest('/auth/challenge/mfa-setup/associate', {
      method: 'POST',
      body: JSON.stringify({ email: challenge.email, session: challenge.session }),
    }),
  )
}

/**
 * Finishes authenticator registration inside the MFA_SETUP challenge and signs in.
 *
 * @param input - Email, the session from {@link startMfaSetupChallenge}, the code, and whether
 *   to keep the session across browser restarts.
 * @returns The new session.
 */
export async function completeMfaSetupChallenge(input: {
  email: string
  session: string
  code: string
  remember: boolean
}): Promise<AuthSession> {
  const data = await sendRequest('/auth/challenge/mfa-setup/verify', {
    method: 'POST',
    body: JSON.stringify({ email: input.email, session: input.session, code: input.code }),
  })
  return parseAuthSession(data, input.remember)
}

/**
 * Builds the `otpauth://` URI that authenticator apps read from the QR code.
 *
 * @param setup - Shared secret and account name.
 * @returns The key URI.
 */
export function createTotpKeyUri(setup: Pick<SoftwareTokenSetupStart, 'secretCode' | 'accountName'>) {
  const issuer = 'mukuroji'
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(setup.accountName)}`
  const parameters = new URLSearchParams({ secret: setup.secretCode, issuer })
  return `otpauth://totp/${label}?${parameters.toString()}`
}

/**
 * Validates the response that starts authenticator registration.
 *
 * @param data - Parsed response body.
 * @returns The setup start.
 */
function parseSoftwareTokenSetupStart(data: unknown): SoftwareTokenSetupStart {
  if (
    !isRecord(data) ||
    typeof data.secretCode !== 'string' ||
    !data.secretCode ||
    typeof data.accountName !== 'string' ||
    (data.session !== undefined && typeof data.session !== 'string')
  ) {
    throw createMalformedResponseError()
  }
  return {
    secretCode: data.secretCode,
    accountName: data.accountName,
    ...(typeof data.session === 'string' ? { session: data.session } : {}),
  }
}

/**
 * Sends a JSON request to the API and throws {@link ApiError} for an error response.
 *
 * @param path - API path without the base URL.
 * @param init - Request options.
 * @param accessToken - Optional bearer access token.
 * @returns The parsed body, or undefined for an empty body.
 */
async function sendRequest(path: string, init: RequestInit, accessToken?: string) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  })
  const text = await response.text()
  let data: unknown
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      throw createMalformedResponseError()
    }
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      isRecord(data) && typeof data.message === 'string' ? data.message : 'API request failed.',
      isRecord(data) && typeof data.code === 'string' ? data.code : undefined,
    )
  }
  return data
}

/**
 * Creates the error for a response body the Web cannot read.
 *
 * @returns The error.
 */
function createMalformedResponseError() {
  return new ApiError(502, 'Account security response is malformed.')
}
