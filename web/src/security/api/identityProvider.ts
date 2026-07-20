import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'

/**
 * Workspace に設定できる enterprise identity provider protocol です。
 */
export type EnterpriseIdentityProtocol = 'saml' | 'oidc'

/**
 * Enterprise identity provider の接続状態です。
 */
export type EnterpriseIdentityProviderStatus =
  | 'not-configured'
  | 'draft'
  | 'verified'
  | 'error'

/**
 * SAML/OIDC identity provider の保存済み設定です。
 */
export type EnterpriseIdentityProvider = {
  /** Provider binding に使用する identity provider ID です。 */
  id: string
  /** Identity provider の接続状態です。 */
  status: EnterpriseIdentityProviderStatus
  /** 設定済み protocol です。 */
  protocol: EnterpriseIdentityProtocol
  /** 管理者向け表示名です。 */
  displayName: string
  /** SAML entity ID または OIDC issuer URL です。 */
  issuer: string
  /** Login redirect で使用する SSO URL です。 */
  ssoUrl: string
  /** OIDC client ID または SAML audience です。 */
  clientId: string
  /** SAML metadata XML を取得して署名設定を検証する HTTPS URL です。 */
  metadataUrl?: string
  /** 接続テストが最後に成功したかどうかです。 */
  lastTestSucceeded: boolean
  /** 最後に接続テストを実行した ISO 8601 timestamp です。 */
  lastTestedAt?: string
  /** Managed domain に SSO login を強制するかどうかです。 */
  enforced: boolean
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Identity provider 設定更新 API の入力です。
 */
export type UpdateEnterpriseIdentityProviderInput = {
  /** 更新する protocol です。 */
  protocol: EnterpriseIdentityProtocol
  /** 管理者向け表示名です。 */
  displayName: string
  /** SAML entity ID または OIDC issuer URL です。 */
  issuer: string
  /** Login redirect に使用する SSO URL です。 */
  ssoUrl: string
  /** OIDC client ID または SAML audience です。 */
  clientId: string
  /** SAML metadata XML を取得して署名設定を検証する HTTPS URL です。 */
  metadataUrl: string
  /** 読み込み時点の version です。 */
  expectedVersion: number
}

/**
 * SSO enforcement 更新 API の入力です。
 */
export type UpdateEnterpriseSsoEnforcementInput = {
  /** Managed domain に SSO を強制するかどうかです。 */
  enforced: boolean
  /** 読み込み時点の identity provider version です。 */
  expectedVersion: number
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Identity provider 設定を保存し、任意で接続テストを実行します。
 */
export function updateEnterpriseIdentityProvider(
  accessToken: string,
  input: UpdateEnterpriseIdentityProviderInput & {
    /** 保存時に接続テストも実行するかどうかです。 */
    testConnection?: boolean
  },
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/identity-provider',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseIdentityProvider>(data, 'identityProvider'),
  )
}

/**
 * Managed domain の SSO enforcement を更新します。
 */
export function updateEnterpriseSsoEnforcement(
  accessToken: string,
  input: UpdateEnterpriseSsoEnforcementInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/identity-provider',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseIdentityProvider>(data, 'identityProvider'),
  )
}

async function sendEnterpriseSecurityRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${enterpriseSecurityApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    throw new EnterpriseSecurityApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }

  return data as T
}

function readResponseProperty<T>(
  data: unknown,
  property: string,
): T {
  if (!isRecord(data) || !(property in data) || !isRecord(data[property])) {
    throw createMalformedResponseError()
  }

  return data[property] as T
}

function createMalformedResponseError() {
  return new EnterpriseSecurityApiError(
    502,
    'Enterprise security API returned an invalid response.',
    'EnterpriseSecurityInvalidResponse',
  )
}

function readErrorCode(data: unknown) {
  return isRecord(data) && typeof data.code === 'string'
    ? data.code
    : undefined
}

function readErrorMessage(data: unknown) {
  return isRecord(data) && typeof data.message === 'string'
    ? data.message
    : 'Enterprise security request failed.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw createMalformedResponseError()
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
