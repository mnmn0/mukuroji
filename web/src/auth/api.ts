import type { AuthSession } from './session'

/**
 * API から返るログインレスポンスです。
 */
type LoginResponse = Omit<AuthSession, 'remember'>

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
 * Cognito で認証された現在のユーザー情報を表します。
 */
export type CurrentUser = {
  /**
   * Cognito のユーザー名です。
   */
  username: string
  /**
   * Cognito から返されたユーザー属性です。
   */
  attributes: Record<string, string>
}

/**
 * API からエラーレスポンスが返ったときに投げる例外です。
 */
export class ApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
   */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const apiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

/**
 * メールアドレスとパスワードでログインし、保存可能な認証セッションを返します。
 */
export async function loginWithPassword({
  email,
  password,
  remember,
}: LoginWithPasswordParams): Promise<AuthSession> {
  const response = await apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })

  return {
    ...response,
    remember,
  }
}

/**
 * アクセストークンを使って認証済みユーザー情報を取得します。
 */
export function getCurrentUser(accessToken: string) {
  return apiFetch<CurrentUser>('/auth/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

async function apiFetch<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const data = await readJson<{ message?: string } | T>(response)

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
        ? data.message
        : 'API request failed.'

    throw new ApiError(response.status, message)
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

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
