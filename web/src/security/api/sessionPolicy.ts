import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'

/**
 * MFA、session、IP、guest/external collaborator policy です。
 */
export type EnterpriseSessionPolicy = {
  /** Human member に MFA を必須とするかどうかです。 */
  mfaRequired: boolean
  /** Interactive session lifetime の分数です。 */
  sessionLifetimeMinutes: number
  /** User activity がない session を終了するまでの分数です。 */
  idleTimeoutMinutes: number
  /** 通常 session で再認証を求める経過分数です。 */
  reauthenticationMinutes: number
  /** Sensitive operation で再認証を求める経過分数です。 */
  sensitiveActionReauthenticationMinutes: number
  /** Workspace access を許可する CIDR 一覧です。 */
  ipAllowlist: string[]
  /** Guest/external collaborator を許可するかどうかです。 */
  guestsAllowed: boolean
  /** Verified domain 外の member collaborator を許可するかどうかです。 */
  externalCollaboratorsAllowed: boolean
  /** Guest interactive session の最大有効時間（分）です。 */
  guestSessionLifetimeMinutes: number
  /** Guest として許可する email domain 一覧です。 */
  allowedGuestDomains: string[]
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Session/security policy 更新 API の入力です。
 */
export type UpdateEnterpriseSessionPolicyInput = {
  /** Human member に MFA を必須とするかどうかです。 */
  mfaRequired: boolean
  /** Interactive session lifetime の分数です。 */
  sessionLifetimeMinutes: number
  /** User activity がない session を終了するまでの分数です。 */
  idleTimeoutMinutes: number
  /** 通常 session の再認証 interval 分数です。 */
  reauthenticationMinutes: number
  /** Sensitive operation の再認証 interval 分数です。 */
  sensitiveActionReauthenticationMinutes: number
  /** Workspace access を許可する CIDR 一覧です。 */
  ipAllowlist: string[]
  /** Guest/external collaborator を許可するかどうかです。 */
  guestsAllowed: boolean
  /** Verified domain 外の member collaborator を許可するかどうかです。 */
  externalCollaboratorsAllowed: boolean
  /** Guest interactive session の最大有効時間（分）です。 */
  guestSessionLifetimeMinutes: number
  /** Guest として許可する email domain 一覧です。 */
  allowedGuestDomains: string[]
  /** 読み込み時点の version です。 */
  expectedVersion: number
  /** Caller IP を allowlist から除外する変更を確認済みであることを示す短時間 token です。 */
  callerIpConfirmationToken?: string
}

/**
 * Session/security policy の保存前 caller IP impact です。
 */
export type EnterpriseSessionPolicyImpact = {
  /** Server が信頼できる transport source から解決した caller IP です。 */
  callerIp?: string
  /** 更新後の allowlist が caller IP を許可するかどうかです。 */
  callerAllowed: boolean
  /** 保存前に明示確認が必要かどうかです。 */
  requiresConfirmation: boolean
  /** 管理者が確認すべき安全上の警告です。 */
  warnings: string[]
  /** Caller IP 除外を確認した場合だけ PUT へ渡す短時間 token です。 */
  confirmationToken?: string
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Session/security policy の caller IP impact を mutation なしで確認します。
 */
export function previewEnterpriseSessionPolicy(
  accessToken: string,
  input: UpdateEnterpriseSessionPolicyInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/policy/preview',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseSessionPolicyImpact)
}

/**
 * MFA、session、IP、guest policy を保存します。
 */
export function updateEnterpriseSessionPolicy(
  accessToken: string,
  input: UpdateEnterpriseSessionPolicyInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/policy',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseSessionPolicy>(data, 'policy'),
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

function parseEnterpriseSessionPolicyImpact(
  data: unknown,
): EnterpriseSessionPolicyImpact {
  if (!isRecord(data) || !isRecord(data.impact)) {
    throw createMalformedResponseError()
  }

  const impact = data.impact
  if (
    (impact.callerIp !== undefined && typeof impact.callerIp !== 'string') ||
    typeof impact.callerAllowed !== 'boolean' ||
    typeof impact.requiresConfirmation !== 'boolean' ||
    !Array.isArray(impact.warnings) ||
    !impact.warnings.every((warning) => typeof warning === 'string') ||
    (impact.confirmationToken !== undefined &&
      typeof impact.confirmationToken !== 'string') ||
    (impact.requiresConfirmation &&
      (typeof impact.confirmationToken !== 'string' ||
        !impact.confirmationToken))
  ) {
    throw createMalformedResponseError()
  }

  return impact as EnterpriseSessionPolicyImpact
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
