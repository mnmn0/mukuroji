import type {
  ApiKeyOneTimeSecretOutput,
  ApiKeySummary,
  CreateApiKeyInput,
  CreatePersonalApiKeyInput,
  PersonalAgentCredentialOverview,
  PersonalCredentialAdministration,
  PersonalCredentialPolicy,
  RotatePersonalApiKeyInput,
  UpdatePersonalCredentialPolicyInput,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DeveloperPlatformApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

const developerApiBaseUrl = resolveApiBaseUrl('workspaceWithoutProjects')

const defaultDeveloperApiErrorMessage =
  'Unable to complete the Developer Platform request.'

/**
 * Scoped API key を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - API key 名、scope、有効期限です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 一度だけ表示できる secret と API key metadata です。
 */
export function createDeveloperApiKey(
  accessToken: string,
  input: CreateApiKeyInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ApiKeyOneTimeSecretOutput>(
    '/developer/api-keys',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * API key secret を rotation します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param apiKeyId - Rotation 対象 API key ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 新しい one-time secret と API key metadata です。
 */
export function rotateDeveloperApiKey(
  accessToken: string,
  apiKeyId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ApiKeyOneTimeSecretOutput>(
    `/developer/api-keys/${encodeURIComponent(apiKeyId)}/rotate`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * API key を revoke します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param apiKeyId - Revoke 対象 API key ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Revoke 後の API key metadata です。
 */
export function revokeDeveloperApiKey(
  accessToken: string,
  apiKeyId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ApiKeySummary>(
    `/developer/api-keys/${encodeURIComponent(apiKeyId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

/**
 * 現在の member 自身の agent 接続情報と自分用 API key を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Member ID、発行可否、policy、自分用 API key です。
 */
export function getPersonalAgentConnection(accessToken: string) {
  return requestJson<PersonalAgentCredentialOverview>(
    '/developer/me/agent-connection',
    accessToken,
  )
}

/**
 * Coding agent 用の自分用 API key を発行します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Key 名、有効期限、scope です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 一度だけ表示できる secret と API key metadata です。
 */
export function createPersonalApiKey(
  accessToken: string,
  input: CreatePersonalApiKeyInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ApiKeyOneTimeSecretOutput>(
    '/developer/me/api-keys',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * 自分用 API key の secret を新しい有効期限で rotation します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param apiKeyId - Rotation 対象 API key ID です。
 * @param input - 新しい有効期限です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 新しい one-time secret と API key metadata です。
 */
export function rotatePersonalApiKey(
  accessToken: string,
  apiKeyId: string,
  input: RotatePersonalApiKeyInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ApiKeyOneTimeSecretOutput>(
    `/developer/me/api-keys/${encodeURIComponent(apiKeyId)}/rotate`,
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * 自分用 API key を失効します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param apiKeyId - 失効する API key ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 失効後の API key metadata です。
 */
export function revokePersonalApiKey(
  accessToken: string,
  apiKeyId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ApiKeySummary>(
    `/developer/me/api-keys/${encodeURIComponent(apiKeyId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

/**
 * Member による自分用 API key 発行の policy と、発行済みの自分用 API key の ID を取得します。管理者だけが実行できます。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Policy と自分用 API key の ID です。
 */
export function getPersonalCredentialAdministration(accessToken: string) {
  return requestJson<PersonalCredentialAdministration>(
    '/developer/credential-policy',
    accessToken,
  )
}

/**
 * Member による自分用 API key 発行の policy を変更します。管理者だけが実行できます。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - 自分用 API key の発行を許可するかどうかです。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 変更後の policy です。
 */
export function updatePersonalCredentialPolicy(
  accessToken: string,
  input: UpdatePersonalCredentialPolicyInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<PersonalCredentialPolicy>(
    '/developer/credential-policy',
    accessToken,
    createJsonMutation('PUT', input, mutationContext),
  )
}

function createJsonMutation(
  method: 'PATCH' | 'POST' | 'PUT',
  body: unknown,
  mutationContext: MutationRequestContext,
): RequestInit {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method,
  }
}

async function requestJson<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  allowEmptyResponse = false,
) {
  const response = await fetch(`${developerApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(
    response,
    allowEmptyResponse || !response.ok,
    response.ok,
  )

  if (!response.ok) {
    const errorData = readErrorResponse(data)

    throw new DeveloperPlatformApiError(
      response.status,
      errorData?.message?.trim() ||
        errorData?.detail?.trim() ||
        defaultDeveloperApiErrorMessage,
      errorData?.code,
      isRetryableDeveloperApiResponse(response.status, errorData),
      readRetryAfterSeconds(response),
    )
  }

  return data as T
}

function readRetryAfterSeconds(response: Response) {
  const value = response.headers.get('Retry-After')?.trim()
  if (!value) return undefined
  if (/^\d+$/u.test(value)) {
    return Math.min(Number(value), 300)
  }
  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.min(Math.max(Math.ceil((retryAt - Date.now()) / 1_000), 0), 300)
}

function readErrorResponse(
  value: unknown,
): {
  code?: string
  detail?: string
  message?: string
  retryable?: boolean
} | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

function isRetryableDeveloperApiResponse(
  status: number,
  error: ReturnType<typeof readErrorResponse>,
) {
  return error?.retryable === true || status === 429 || status >= 500
}

async function readJson<T>(
  response: Response,
  allowEmpty: boolean,
  rejectMalformed: boolean,
): Promise<T> {
  const text = await response.text()

  if (!text) {
    if (allowEmpty) {
      return {} as T
    }

    throw new DeveloperPlatformApiError(
      response.status,
      'Developer Platform API returned an empty JSON response.',
      'InvalidDeveloperPlatformResponse',
      response.ok ||
        isRetryableDeveloperApiResponse(response.status, undefined),
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    if (!rejectMalformed) {
      return {} as T
    }

    throw new DeveloperPlatformApiError(
      response.status,
      'Developer Platform API returned invalid JSON.',
      'InvalidDeveloperPlatformResponse',
      response.ok ||
        isRetryableDeveloperApiResponse(response.status, undefined),
    )
  }
}
