import type { AuthSession } from '../session'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ApiError } from './errors'

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

const apiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
