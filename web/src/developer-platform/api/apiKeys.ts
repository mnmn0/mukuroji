import type { ApiKeySummary } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type {
  CreateDeveloperApiKeyInput,
  IssuedApiKeySecret,
} from '../model/credentials'
import { DeveloperPlatformApiError } from './errors'

export type {
  CreateDeveloperApiKeyInput,
  IssuedApiKeySecret,
} from '../model/credentials'

const developerApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

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
  input: CreateDeveloperApiKeyInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedApiKeySecret>(
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
  return requestJson<IssuedApiKeySecret>(
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

function createJsonMutation(
  method: 'PATCH' | 'POST',
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

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
