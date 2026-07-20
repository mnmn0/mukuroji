import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'

/**
 * Service account の lifecycle 状態です。
 */
export type EnterpriseServiceAccountStatus = 'active' | 'revoked'

/**
 * Interactive user と分離して管理する service account です。
 */
export type EnterpriseServiceAccount = {
  /** Service account の一意な ID です。 */
  id: string
  /** 管理 UI に表示する名称です。 */
  name: string
  /** Service account の lifecycle 状態です。 */
  status: EnterpriseServiceAccountStatus
  /** 付与されている role ID です。 */
  roleId: string
  /** Credential がアクセスできる resource scope の種類です。 */
  scopeType: 'workspace' | 'team' | 'project'
  /** Team/Project scope の ID です。 */
  scopeId?: string
  /** Rotate 後も維持する credential lifetime policy の日数です。 */
  credentialLifetimeDays: number
  /** Current/last credential が失効する ISO 8601 timestamp です。 */
  credentialExpiresAt?: string
  /** Credential の利用を許可する source CIDR 一覧です。 */
  allowedSourceCidrs: string[]
  /** Credential generation です。 */
  credentialGeneration: number
  /** 最後に API access した ISO 8601 timestamp です。 */
  lastUsedAt?: string
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Service account 作成 API の入力です。
 */
export type CreateEnterpriseServiceAccountInput = {
  /** Service account の名称です。 */
  name: string
  /** Service account に付与する role ID です。 */
  roleId: string
  /** Credential がアクセスできる resource scope の種類です。 */
  scopeType: 'workspace' | 'team' | 'project'
  /** Team/Project scope の ID です。 */
  scopeId?: string
  /** Credential の有効期間（1〜365日）です。 */
  credentialLifetimeDays: number
  /** Credential の利用を許可する source CIDR 一覧です。 */
  allowedSourceCidrs: string[]
}

/**
 * Service account credential create/rotate response です。
 */
export type EnterpriseServiceAccountCredentialResponse = {
  /** 作成または更新した service account です。 */
  serviceAccount: EnterpriseServiceAccount
  /** Create/rotate response で一回だけ返す bearer token です。 */
  token: string
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Service account と一回限りの credential を作成します。
 */
export function createEnterpriseServiceAccount(
  accessToken: string,
  input: CreateEnterpriseServiceAccountInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/service-accounts',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseServiceAccountCredentialResponse)
}

/**
 * Service account credential を rotate して一回だけ返します。
 */
export function rotateEnterpriseServiceAccountCredential(
  accessToken: string,
  serviceAccount: EnterpriseServiceAccount,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/service-accounts/${encodeURIComponent(serviceAccount.id)}/rotate`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion: serviceAccount.version }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseServiceAccountCredentialResponse)
}

/**
 * Service account とその credential を失効させます。
 */
export function revokeEnterpriseServiceAccount(
  accessToken: string,
  serviceAccount: EnterpriseServiceAccount,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/service-accounts/${encodeURIComponent(serviceAccount.id)}/revoke`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion: serviceAccount.version }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
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

function parseEnterpriseServiceAccountCredentialResponse(
  data: unknown,
): EnterpriseServiceAccountCredentialResponse {
  if (
    !isRecord(data) ||
    !isRecord(data.serviceAccount) ||
    typeof data.token !== 'string' ||
    !data.token
  ) {
    throw createMalformedResponseError()
  }

  return data as EnterpriseServiceAccountCredentialResponse
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
