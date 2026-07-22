import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'

/**
 * Workspace が所有を確認する domain の状態です。
 */
export type EnterpriseDomainStatus = 'pending' | 'verified' | 'conflict'

/**
 * Enterprise login policy に使用する domain claim です。
 */
export type EnterpriseDomainClaim = {
  /** Domain claim の一意な ID です。 */
  id: string
  /** 小文字へ正規化された domain 名です。 */
  domain: string
  /** Domain ownership の確認状態です。 */
  status: EnterpriseDomainStatus
  /** DNS TXT record を設定する record name です。 */
  verificationRecordName: string
  /** Domain ownership を確認した ISO 8601 timestamp です。 */
  verifiedAt?: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Domain claim 作成時に一度だけ返す DNS verification challenge です。
 */
export type EnterpriseDomainVerificationChallenge = {
  /** 作成された domain claim です。 */
  domain: EnterpriseDomainClaim
  /** DNS TXT record に設定し、一度だけ表示する verification value です。 */
  verificationRecordValue: string
}

/**
 * Domain claim 作成 API の入力です。
 */
export type CreateEnterpriseDomainClaimInput = {
  /** Claim する domain 名です。 */
  domain: string
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Enterprise login に使用する domain claim を作成します。
 */
export function createEnterpriseDomainClaim(
  accessToken: string,
  input: CreateEnterpriseDomainClaimInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/domains',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseDomainVerificationChallenge)
}

/**
 * DNS record を再確認して domain ownership を検証します。
 */
export function verifyEnterpriseDomainClaim(
  accessToken: string,
  domain: string,
  expectedVersion: number,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/domains/${encodeURIComponent(domain)}/verify`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then((data) => readResponseProperty<EnterpriseDomainClaim>(data, 'domain'))
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

function parseEnterpriseDomainVerificationChallenge(
  data: unknown,
): EnterpriseDomainVerificationChallenge {
  if (
    !isRecord(data) ||
    !isRecord(data.domain) ||
    typeof data.domain.verificationRecordName !== 'string' ||
    !data.domain.verificationRecordName ||
    typeof data.verificationRecordValue !== 'string' ||
    !data.verificationRecordValue
  ) {
    throw createMalformedResponseError()
  }

  return data as EnterpriseDomainVerificationChallenge
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
