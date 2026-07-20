import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'

/**
 * SCIM directory connection の状態です。
 */
export type EnterpriseScimStatus = 'disabled' | 'ready' | 'syncing' | 'error'

/**
 * SCIM user/group provisioning の接続情報です。
 */
export type EnterpriseScimConfiguration = {
  /** SCIM credential を関連付ける identity provider ID です。 */
  identityProviderId: string
  /** SCIM connection の現在状態です。 */
  status: EnterpriseScimStatus
  /** Identity provider が呼び出す SCIM base URL です。 */
  endpointUrl: string
  /** 現在の bearer token generation です。 */
  tokenGeneration: number
  /** 保存済み bearer token の末尾4文字です。 */
  tokenLastFour?: string
  /** 最後に同期が成功した ISO 8601 timestamp です。 */
  lastSyncAt?: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Provisioning operation の状態です。
 */
export type EnterpriseProvisioningLogStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'

/**
 * SCIM または reconciliation operation の安全な表示履歴です。
 */
export type EnterpriseProvisioningLog = {
  /** Provisioning log の一意な ID です。 */
  id: string
  /** 実行された operation 名です。 */
  operation: 'scim' | 'dry-run' | 'reconcile' | 'deprovision'
  /** Operation の現在状態です。 */
  status: EnterpriseProvisioningLogStatus
  /** 管理 UI に表示できる安全な要約です。 */
  summary: string
  /** Operation が開始された ISO 8601 timestamp です。 */
  createdAt: string
  /** Operation が完了した ISO 8601 timestamp です。 */
  completedAt?: string
  /** 同じ logical operation を再試行できるかどうかです。 */
  retryable: boolean
  /** Audit event と照合する correlation ID です。 */
  correlationId?: string
  /** 現在までの試行回数です。 */
  attempts: number
}

/**
 * Reconciliation dry-run が返す変更件数です。
 */
export type EnterpriseProvisioningImpactCounts = {
  /** 新規作成する user 件数です。 */
  usersCreated: number
  /** 属性または role を更新する user 件数です。 */
  usersUpdated: number
  /** 利用停止する user 件数です。 */
  usersDeactivated: number
  /** 新規作成する group 件数です。 */
  groupsCreated: number
  /** 更新する group 件数です。 */
  groupsUpdated: number
  /** 失効させる session/token 件数です。 */
  sessionsRevoked: number
}

/**
 * Reconciliation または deprovision の適用前 preview です。
 */
export type EnterpriseProvisioningImpact = {
  /** Apply API に渡す一回限りの preview ID です。 */
  previewId: string
  /** Preview が失効する ISO 8601 timestamp です。 */
  expiresAt: string
  /** Apply 時に発生する変更件数です。 */
  counts: EnterpriseProvisioningImpactCounts
  /** 管理者が確認すべき warning 文言です。 */
  warnings: string[]
  /** Preview が差分を含むかどうかです。 */
  hasChanges: boolean
  /** 保護対象への影響により Apply を禁止するかどうかです。 */
  blocking: boolean
}

/**
 * SCIM token rotate response です。
 */
export type EnterpriseScimTokenResponse = {
  /** Rotate 後の SCIM configuration です。 */
  scim: EnterpriseScimConfiguration
  /** Rotate response で一回だけ返す bearer token です。 */
  token: string
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * SCIM bearer token を発行または rotate します。
 */
export function rotateEnterpriseScimToken(
  accessToken: string,
  expectedVersion: number,
  identityProviderId: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/scim/token',
    accessToken,
    {
      body: JSON.stringify({
        expectedVersion,
        identityProviderId,
      }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseScimTokenResponse)
}

/**
 * Provisioning reconciliation の dry-run preview を作成します。
 */
export function previewEnterpriseProvisioning(
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/provisioning/preview',
    accessToken,
    {
      body: JSON.stringify({ mode: 'reconcile' }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseProvisioningImpact)
}

/**
 * 確認済み preview を使って provisioning reconciliation を適用します。
 */
export function reconcileEnterpriseProvisioning(
  accessToken: string,
  impact: EnterpriseProvisioningImpact,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/provisioning/reconcile',
    accessToken,
    {
      body: JSON.stringify({
        previewId: impact.previewId,
        previewExpiresAt: impact.expiresAt,
      }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

/**
 * Provisioning operation log の新しい順一覧を取得します。
 */
export function getEnterpriseProvisioningLogs(
  accessToken: string,
  signal?: AbortSignal,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/provisioning/logs',
    accessToken,
    { signal },
  ).then((data) => {
    if (!isRecord(data) || !Array.isArray(data.logs)) {
      throw createMalformedResponseError()
    }

    return data.logs as EnterpriseProvisioningLog[]
  })
}

/**
 * Retry 可能な provisioning operation を再実行します。
 */
export function retryEnterpriseProvisioningLog(
  accessToken: string,
  logId: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/provisioning/logs/${encodeURIComponent(logId)}/retry`,
    accessToken,
    {
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

function parseEnterpriseScimTokenResponse(
  data: unknown,
): EnterpriseScimTokenResponse {
  if (
    !isRecord(data) ||
    !isEnterpriseScimConfiguration(data.scim) ||
    typeof data.token !== 'string' ||
    !data.token ||
    data.scim.tokenLastFour === undefined ||
    data.scim.tokenLastFour !== data.token.slice(-4)
  ) {
    throw createMalformedResponseError()
  }

  return data as EnterpriseScimTokenResponse
}

function parseEnterpriseProvisioningImpact(
  data: unknown,
): EnterpriseProvisioningImpact {
  const impact = readResponseProperty<unknown>(data, 'impact')

  if (
    !isRecord(impact) ||
    typeof impact.previewId !== 'string' ||
    !impact.previewId ||
    typeof impact.expiresAt !== 'string' ||
    !impact.expiresAt ||
    !isRecord(impact.counts) ||
    !Array.isArray(impact.warnings) ||
    !impact.warnings.every((warning) => typeof warning === 'string') ||
    typeof impact.hasChanges !== 'boolean' ||
    typeof impact.blocking !== 'boolean'
  ) {
    throw createMalformedResponseError()
  }

  return impact as EnterpriseProvisioningImpact
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

function isEnterpriseScimConfiguration(
  value: unknown,
): value is EnterpriseScimConfiguration {
  return (
    isRecord(value) &&
    typeof value.identityProviderId === 'string' &&
    (
      value.status === 'disabled' ||
      value.status === 'ready' ||
      value.status === 'syncing' ||
      value.status === 'error'
    ) &&
    typeof value.endpointUrl === 'string' &&
    Number.isSafeInteger(value.tokenGeneration) &&
    Number(value.tokenGeneration) >= 0 &&
    (
      value.tokenLastFour === undefined ||
      typeof value.tokenLastFour === 'string' &&
        /^[A-Za-z0-9_-]{4}$/.test(value.tokenLastFour)
    ) &&
    (
      value.lastSyncAt === undefined ||
      typeof value.lastSyncAt === 'string' &&
        Number.isFinite(Date.parse(value.lastSyncAt))
    ) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 0
  )
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
