import type { AuthSession } from './session'
import { createMutationHeaders, type MutationRequestContext } from '../api/mutationHeaders'
import type { WorkspaceMemberStatus, WorkspaceRole } from '../workspace/api'

/**
 * API から返るログインレスポンスです。
 */
type LoginResponse = Omit<AuthSession, 'remember'>

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
 * 通常 token または初回パスワード変更 challenge を返すログイン結果です。
 */
export type LoginResult = AuthSession | NewPasswordRequiredChallenge

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
  /**
   * Cognito access token に含まれるグループ名です。
   */
  groups: string[]
  /**
   * システム管理者として扱われるかどうかです。
   */
  isSystemAdmin: boolean
  /**
   * Workspace 全体で現在のユーザーに付与された role です。
   */
  workspaceRole: WorkspaceRole
  /**
   * Workspace membership の利用状態です。
   */
  workspaceMemberStatus: WorkspaceMemberStatus
}

/**
 * 現在の Workspace role がチームとプロジェクトの構成を管理できるか判定します。
 */
export function canManageWorkspaceStructure(user?: CurrentUser | null) {
  return user?.workspaceRole === 'owner' || user?.workspaceRole === 'admin'
}

/**
 * 現在の Workspace role が Issue、タスク、コメント、project member を更新できるか判定します。
 */
export function canMutateWorkspaceContent(user?: CurrentUser | null) {
  return user?.workspaceRole !== undefined && user.workspaceRole !== 'guest'
}

/**
 * DynamoDB から取得するダッシュボード集計値です。
 */
export type DashboardSummary = {
  /**
   * 進行中プロジェクト数です。
   */
  projects: number
  /**
   * 未完了タスク数です。
   */
  tasks: number
  /**
   * 要確認タスク数です。
   */
  blocked: number
  /**
   * 集計値を更新した ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * 集計値の取得元です。
   */
  source: 'dynamodb'
}

/**
 * API からエラーレスポンスが返ったときに投げる例外です。
 */
export class ApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
   */
  readonly status: number
  /**
   * API が返した機械判定用の安定した error code です。
   */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
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
}: LoginWithPasswordParams, mutationContext: MutationRequestContext): Promise<LoginResult> {
  const response = await apiFetch<LoginResponse | NewPasswordRequiredChallenge>('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    body: JSON.stringify({ email, password }),
  })

  if (isNewPasswordRequiredChallenge(response)) {
    return response
  }

  return {
    ...response,
    remember,
  }
}

/**
 * NEW_PASSWORD_REQUIRED challenge を完了し、保存可能な認証セッションを返します。
 */
export async function completeNewPasswordChallenge({
  email,
  newPassword,
  remember,
  session,
}: CompleteNewPasswordChallengeParams, mutationContext: MutationRequestContext): Promise<AuthSession> {
  const response = await apiFetch<LoginResponse>('/auth/challenge/new-password', {
    body: JSON.stringify({ email, newPassword, session }),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method: 'POST',
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

/**
 * アクセストークンを使ってダッシュボード集計値を取得します。
 */
export function getDashboardSummary(accessToken: string, signal?: AbortSignal) {
  return apiFetch<DashboardSummary>('/dashboard/summary', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
  })
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

function isNewPasswordRequiredChallenge(
  response: LoginResponse | NewPasswordRequiredChallenge,
): response is NewPasswordRequiredChallenge {
  return 'challenge' in response && response.challenge === 'NEW_PASSWORD_REQUIRED'
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
