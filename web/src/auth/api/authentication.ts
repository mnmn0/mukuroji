import type { AuthSession } from '../session'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ApiError } from './errors'

/**
 * Cognito が初回パスワード変更を要求したときのログイン結果です。
 */
export type NewPasswordRequiredChallenge = {
  /**
   * LoginPage が切り替える Cognito challenge 名です。
   */
  challenge: 'NEW_PASSWORD_REQUIRED'
  /**
   * challenge 完了 API に返す Cognito session です。
   */
  session: string
  /**
   * challenge 対象の正規化済みメールアドレスです。
   */
  email: string
}

/**
 * Cognito が追加確認に使用する MFA challenge 名です。
 */
export type MfaChallengeName =
  | 'SOFTWARE_TOKEN_MFA'
  | 'SMS_MFA'
  | 'SMS_OTP'
  | 'EMAIL_OTP'

/**
 * Cognito が one-time code を要求したときの認証 challenge です。
 */
export type MfaRequiredChallenge = {
  /** MFA endpoint へ返す Cognito challenge 名です。 */
  challenge: MfaChallengeName
  /** Challenge 対象の正規化済み email address です。 */
  email: string
  /** MFA 完了 API へ返す Cognito session です。 */
  session: string
  /** Cognito が code を送信した宛先の masked 表示です。 */
  deliveryDestination?: string
  /** Code delivery channel の安全な表示値です。 */
  deliveryMedium?: string
}

/**
 * Login flow が継続表示できる Cognito challenge です。
 */
export type AuthenticationChallenge =
  | NewPasswordRequiredChallenge
  | MfaRequiredChallenge

/**
 * 通常 token または続行可能な Cognito challenge を返すログイン結果です。
 */
export type LoginResult = AuthSession | AuthenticationChallenge

/**
 * パスワードログインで送信する資格情報です。
 */
type LoginWithPasswordParams = {
  /**
   * Cognito ユーザーのメールアドレスです。
   */
  email: string
  /**
   * Cognito ユーザーのパスワードです。
   */
  password: string
  /**
   * セッションを localStorage に保持するかどうかです。
   */
  remember: boolean
}

/**
 * NEW_PASSWORD_REQUIRED challenge 完了 API の入力です。
 */
type CompleteNewPasswordChallengeParams = {
  /**
   * challenge 対象のメールアドレスです。
   */
  email: string
  /**
   * ユーザーが設定する新しいパスワードです。
   */
  newPassword: string
  /**
   * login API から受け取った Cognito session です。
   */
  session: string
  /**
   * 完了後の token を localStorage に保持するかどうかです。
   */
  remember: boolean
}

/**
 * MFA challenge 完了 API の入力です。
 */
export type CompleteMfaChallengeParams = {
  /** Challenge 対象の email address です。 */
  email: string
  /** Cognito が要求した MFA challenge 名です。 */
  challenge: MfaChallengeName
  /** User が入力した one-time code です。 */
  code: string
  /** Cognito が発行した challenge session です。 */
  session: string
  /** 完了後の token を localStorage に保持するかどうかです。 */
  remember: boolean
}

const apiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

/**
 * メールアドレスとパスワードでログインし、保存可能な認証セッションを返します。
 */
export async function loginWithPassword({
  email,
  password,
  remember,
}: LoginWithPasswordParams, mutationContext: MutationRequestContext): Promise<LoginResult> {
  const response = await apiFetch<unknown>('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    body: JSON.stringify({ email, password }),
  })

  if (isAuthenticationChallenge(response)) {
    return response
  }

  return parseAuthSession(response, remember)
}

/**
 * NEW_PASSWORD_REQUIRED challenge を完了し、保存可能な認証セッションを返します。
 */
export async function completeNewPasswordChallenge({
  email,
  newPassword,
  remember,
  session,
}: CompleteNewPasswordChallengeParams, mutationContext: MutationRequestContext): Promise<AuthSession | MfaRequiredChallenge> {
  const response = await apiFetch<unknown>('/auth/challenge/new-password', {
    body: JSON.stringify({ email, newPassword, session }),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method: 'POST',
  })

  if (isMfaRequiredChallenge(response)) {
    return response
  }

  return parseAuthSession(response, remember)
}

/**
 * One-time code を Cognito MFA challenge と交換します。
 */
export async function completeMfaChallenge({
  remember,
  ...input
}: CompleteMfaChallengeParams, mutationContext: MutationRequestContext): Promise<AuthSession | MfaRequiredChallenge> {
  const response = await apiFetch<unknown>(
    '/auth/challenge/mfa',
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )

  if (isMfaRequiredChallenge(response)) {
    return response
  }

  return parseAuthSession(response, remember)
}

async function apiFetch<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const data = await readJson<{ code?: string; message?: string } | T>(response)

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
        ? data.message
        : 'API request failed.'

    const code =
      typeof data === 'object' &&
      data !== null &&
      'code' in data &&
      typeof data.code === 'string'
        ? data.code
        : undefined

    throw new ApiError(response.status, message, code)
  }

  return data as T
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

function isAuthenticationChallenge(
  response: unknown,
): response is AuthenticationChallenge {
  return isNewPasswordRequiredChallenge(response) ||
    isMfaRequiredChallenge(response)
}

function isNewPasswordRequiredChallenge(
  response: unknown,
): response is NewPasswordRequiredChallenge {
  return isRecord(response) &&
    response.challenge === 'NEW_PASSWORD_REQUIRED' &&
    typeof response.email === 'string' &&
    Boolean(response.email) &&
    typeof response.session === 'string' &&
    Boolean(response.session)
}

function isMfaRequiredChallenge(
  response: unknown,
): response is MfaRequiredChallenge {
  return isRecord(response) &&
    (
      response.challenge === 'SOFTWARE_TOKEN_MFA' ||
      response.challenge === 'SMS_MFA' ||
      response.challenge === 'SMS_OTP' ||
      response.challenge === 'EMAIL_OTP'
    ) &&
    typeof response.email === 'string' &&
    Boolean(response.email) &&
    typeof response.session === 'string' &&
    Boolean(response.session) &&
    (
      response.deliveryDestination === undefined ||
      typeof response.deliveryDestination === 'string'
    ) &&
    (
      response.deliveryMedium === undefined ||
      typeof response.deliveryMedium === 'string'
    )
}

function parseAuthSession(
  response: unknown,
  remember: boolean,
): AuthSession {
  if (
    !isRecord(response) ||
    typeof response.accessToken !== 'string' ||
    !response.accessToken ||
    typeof response.expiresAt !== 'number' ||
    !Number.isFinite(response.expiresAt) ||
    typeof response.tokenType !== 'string' ||
    !response.tokenType ||
    (
      response.idToken !== undefined &&
      typeof response.idToken !== 'string'
    ) ||
    (
      response.refreshToken !== undefined &&
      typeof response.refreshToken !== 'string'
    )
  ) {
    throw new ApiError(502, 'Authentication response is malformed.')
  }

  return {
    accessToken: response.accessToken,
    expiresAt: response.expiresAt,
    idToken:
      typeof response.idToken === 'string' ? response.idToken : undefined,
    refreshToken:
      typeof response.refreshToken === 'string'
        ? response.refreshToken
        : undefined,
    remember,
    tokenType: response.tokenType,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
