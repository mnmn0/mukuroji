import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'

/**
 * Break-glass administrator の lifecycle 状態です。
 */
export type EnterpriseBreakGlassStatus = 'active' | 'disabled'

/**
 * 通常の IdP login から分離した break-glass administrator です。
 */
export type EnterpriseBreakGlassAdministrator = {
  /** Break-glass administrator の一意な ID です。 */
  id: string
  /** Login に使用する email address です。 */
  email: string
  /** Break-glass account の lifecycle 状態です。 */
  status: EnterpriseBreakGlassStatus
  /** MFA enrollment が完了しているかどうかです。 */
  mfaConfigured: boolean
  /** 最後に access test を完了した ISO 8601 timestamp です。 */
  lastTestedAt?: string
  /** 最後に利用した ISO 8601 timestamp です。 */
  lastUsedAt?: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Current member に有効な短時間 recovery elevation です。
 */
export type EnterpriseActiveBreakGlassActivation = {
  /** Recovery elevation が自動失効する ISO 8601 timestamp です。 */
  expiresAt: string
}

/**
 * Break-glass administrator 事前登録 API の入力です。
 */
export type RegisterEnterpriseBreakGlassAdministratorInput = {
  /** Break-glass login に使用する email address です。 */
  email: string
}

/**
 * 現在の member が短時間の recovery access を開始するときの入力です。
 */
export type ActivateEnterpriseBreakGlassInput = {
  /** Audit log に保存する具体的な復旧理由です。 */
  reason: string
  /** Recovery access を有効にする分数です。 */
  durationMinutes: number
}

/**
 * Current member に発行された期限付き recovery access です。
 */
export type EnterpriseBreakGlassActivation = {
  /** Activation の一意な ID です。 */
  id: string
  /** 事前登録済み break-glass account の ID です。 */
  accountId: string
  /** Recovery access を開始した ISO 8601 timestamp です。 */
  startedAt: string
  /** Recovery access が自動終了する ISO 8601 timestamp です。 */
  expiresAt: string
}

/**
 * Break-glass administrator status 更新 API の入力です。
 */
export type UpdateEnterpriseBreakGlassAdministratorInput = {
  /** 更新後の lifecycle 状態です。 */
  status: EnterpriseBreakGlassStatus
  /** 読み込み時点の version です。 */
  expectedVersion: number
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Break-glass administrator account を管理者が事前登録します。
 */
export function registerEnterpriseBreakGlassAdministrator(
  accessToken: string,
  input: RegisterEnterpriseBreakGlassAdministratorInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/accounts',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseBreakGlassAdministrator>(
      data,
      'breakGlassAdministrator',
    ),
  )
}

/**
 * 現在の break-glass session から recovery access test を記録します。
 */
export function testEnterpriseBreakGlassAccess(
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/test',
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseBreakGlassAdministrator>(
      data,
      'breakGlassAdministrator',
    ),
  )
}

/**
 * 事前登録済みの current member が期限付き recovery access を開始します。
 */
export function activateEnterpriseBreakGlassAccess(
  accessToken: string,
  input: ActivateEnterpriseBreakGlassInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/activate',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseBreakGlassActivationResponse)
}

/**
 * Current member の有効な recovery access を期限前に終了します。
 */
export function revokeEnterpriseBreakGlassAccess(
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/revoke-activation',
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

/**
 * Break-glass administrator を無効化します。
 */
export function deactivateEnterpriseBreakGlassAdministrator(
  accessToken: string,
  administrator: EnterpriseBreakGlassAdministrator,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/deactivate',
    accessToken,
    {
      body: JSON.stringify({
        administratorId: administrator.id,
        expectedVersion: administrator.version,
      }),
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

function parseEnterpriseBreakGlassActivationResponse(
  data: unknown,
): EnterpriseBreakGlassActivation {
  const activation = readResponseProperty<unknown>(data, 'activation')

  if (
    !isRecord(activation) ||
    typeof activation.id !== 'string' ||
    !activation.id ||
    typeof activation.accountId !== 'string' ||
    !activation.accountId ||
    typeof activation.startedAt !== 'string' ||
    !activation.startedAt ||
    typeof activation.expiresAt !== 'string' ||
    !activation.expiresAt
  ) {
    throw createMalformedResponseError()
  }

  return activation as EnterpriseBreakGlassActivation
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
