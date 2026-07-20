import type { AuthSession } from './session'
import { createMutationHeaders, type MutationRequestContext } from '../api/mutationHeaders'
import type { WorkspaceMemberStatus, WorkspaceRole } from '../workspace/api'

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
 * Enterprise SSO authorization 開始 API の入力です。
 */
export type StartEnterpriseSsoInput = {
  /** SSO policy の対象を解決する email address です。 */
  email: string
  /** Login 完了後に戻す検証済み app path です。 */
  returnTo?: string
}

/**
 * Claimed domain に適用される enterprise identity provider の安全な表示情報です。
 */
export type EnterpriseSsoDiscoveryProvider = {
  /** Identity provider の安定した ID です。 */
  id: string
  /** Federation protocol です。 */
  kind: 'saml' | 'oidc'
  /** Login UI に表示できる provider 名です。 */
  displayName: string
}

/**
 * Password login を続行できる未管理 domain の discovery 結果です。
 */
export type EnterprisePasswordLoginDiscovery = {
  /** Enterprise SSO が強制されていないことを表します。 */
  ssoRequired: false
  /** UI が password login を表示できる login mode です。 */
  loginMode: 'password-or-sso'
}

/**
 * Claimed domain で Enterprise SSO が必須の discovery 結果です。
 */
export type EnterpriseRequiredSsoDiscovery = {
  /** Enterprise SSO が強制されていることを表します。 */
  ssoRequired: true
  /** UI が password field を表示してはいけない login mode です。 */
  loginMode: 'sso-for-claimed-domains'
  /** SSO policy が適用された正規化済み domain です。 */
  domain: string
  /** Login UI に表示できる identity provider 情報です。 */
  provider: EnterpriseSsoDiscoveryProvider
}

/**
 * Email domain ごとの password/SSO login discovery 結果です。
 */
export type EnterpriseSsoDiscoveryResult =
  | EnterprisePasswordLoginDiscovery
  | EnterpriseRequiredSsoDiscovery

/**
 * Enterprise SSO authorization 開始 API の応答です。
 */
export type StartEnterpriseSsoResult = {
  /** App が遷移する authorization server URL です。 */
  authorizationUrl: string
  /** Callback と pending request を対応付ける一回限り state です。 */
  state: string
  /** Browser callback が code exchange に返す PKCE verifier です。 */
  codeVerifier: string
  /** Pending authorization request が失効する Unix time milliseconds です。 */
  expiresAt: number
  /** Server が state と結び付けた login 後の戻り先です。 */
  returnTo: string
}

/**
 * Enterprise SSO authorization code exchange API の入力です。
 */
export type ExchangeEnterpriseSsoInput = {
  /** Authorization callback が返した code です。 */
  code: string
  /** Authorization 開始時に作成した PKCE verifier です。 */
  codeVerifier: string
  /** Authorization callback が返した state です。 */
  state: string
  /** Browser session を localStorage に保持するかどうかです。 */
  remember: boolean
}

/**
 * Enterprise SSO code exchange 後の session と戻り先です。
 */
export type ExchangeEnterpriseSsoResult = {
  /** 保存可能な認証 session です。 */
  session: AuthSession
  /** Server が state と結び付けた login 後の戻り先です。 */
  returnTo: string
}

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
 * Active な Workspace membership と role が Issue、タスク、コメント、
 * project member を更新できるか判定します。
 */
export function canMutateWorkspaceContent(user?: CurrentUser | null) {
  return (
    user?.workspaceMemberStatus === 'active' &&
    user.workspaceRole !== 'guest'
  )
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
 * Email domain の login policy を確認し、password field を表示してよいか判定します。
 */
export async function discoverEnterpriseSso(
  email: string,
): Promise<EnterpriseSsoDiscoveryResult> {
  const response = await apiFetch<unknown>(
    `/auth/sso/discovery?email=${encodeURIComponent(email.trim().toLowerCase())}`,
  )

  if (
    isRecord(response) &&
    response.ssoRequired === false &&
    response.loginMode === 'password-or-sso'
  ) {
    return {
      loginMode: 'password-or-sso',
      ssoRequired: false,
    }
  }

  if (
    !isRecord(response) ||
    response.ssoRequired !== true ||
    response.loginMode !== 'sso-for-claimed-domains' ||
    typeof response.domain !== 'string' ||
    !response.domain ||
    !isRecord(response.provider) ||
    typeof response.provider.id !== 'string' ||
    !response.provider.id ||
    (
      response.provider.kind !== 'saml' &&
      response.provider.kind !== 'oidc'
    ) ||
    typeof response.provider.displayName !== 'string' ||
    !response.provider.displayName
  ) {
    throw new ApiError(502, 'Enterprise SSO discovery response is malformed.')
  }

  return {
    domain: response.domain,
    loginMode: 'sso-for-claimed-domains',
    provider: {
      displayName: response.provider.displayName,
      id: response.provider.id,
      kind: response.provider.kind,
    },
    ssoRequired: true,
  }
}

/**
 * Enterprise SSO authorization を PKCE challenge 付きで開始します。
 */
export async function startEnterpriseSso(
  input: StartEnterpriseSsoInput,
  mutationContext: MutationRequestContext,
): Promise<StartEnterpriseSsoResult> {
  const response = await apiFetch<unknown>('/auth/sso/start', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method: 'POST',
  })

  if (
    !isRecord(response) ||
    typeof response.authorizationUrl !== 'string' ||
    !response.authorizationUrl ||
    typeof response.state !== 'string' ||
    !response.state ||
    typeof response.codeVerifier !== 'string' ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(response.codeVerifier) ||
    typeof response.expiresAt !== 'number' ||
    !Number.isFinite(response.expiresAt) ||
    typeof response.returnTo !== 'string'
  ) {
    throw new ApiError(502, 'Enterprise SSO start response is malformed.')
  }

  return {
    authorizationUrl: response.authorizationUrl,
    codeVerifier: response.codeVerifier,
    expiresAt: response.expiresAt,
    returnTo: response.returnTo,
    state: response.state,
  }
}

/**
 * Enterprise SSO authorization code を PKCE verifier と交換します。
 */
export async function exchangeEnterpriseSso({
  remember,
  ...input
}: ExchangeEnterpriseSsoInput, mutationContext: MutationRequestContext): Promise<ExchangeEnterpriseSsoResult> {
  const response = await apiFetch<unknown>('/auth/sso/exchange', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method: 'POST',
  })

  if (
    !isRecord(response) ||
    typeof response.accessToken !== 'string' ||
    !response.accessToken ||
    typeof response.expiresAt !== 'number' ||
    !Number.isFinite(response.expiresAt) ||
    typeof response.tokenType !== 'string' ||
    !response.tokenType ||
    typeof response.returnTo !== 'string'
  ) {
    throw new ApiError(502, 'Enterprise SSO exchange response is malformed.')
  }

  return {
    returnTo: response.returnTo,
    session: {
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
    },
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
