import type { RequestRequesterReplyReceipt, RequestRequesterReplyInput, RequestRequesterThread } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { RequestIntakeApiError } from './errors'

const requestsApiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

const defaultRequestApiErrorMessage = 'Unable to complete the request intake operation.'

/**
 * Requester が opaque thread token で staff message を取得します。
 */
export function getRequestThread(threadToken: string) {
  return requestJson<RequestRequesterThread>(
    `${requestsApiBaseUrl}/request-threads/${encodeURIComponent(threadToken)}`,
  )
}

/**
 * Requester が signed thread token で追加情報を返信します。
 */
export function replyToRequestThread(
  threadToken: string,
  input: RequestRequesterReplyInput,
  context: MutationRequestContext,
) {
  return requestJson<RequestRequesterReplyReceipt>(
    `${requestsApiBaseUrl}/request-threads/${encodeURIComponent(threadToken)}/replies`,
    {
      init: {
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          ...createMutationHeaders(context),
        },
        method: 'POST',
      },
    },
  )
}

/**
 * Request API 共通 fetch helper の入力です。
 */
type RequestJsonOptions = {
  /** Request に付与する任意 access token です。 */
  accessToken?: string
  /** Fetch request options です。 */
  init?: RequestInit
}

async function requestJson<T>(url: string, options: RequestJsonOptions = {}) {
  const response = await fetch(url, {
    ...options.init,
    headers: {
      ...(options.accessToken
        ? { Authorization: `Bearer ${options.accessToken}` }
        : {}),
      ...options.init?.headers,
    },
  })
  const data = await readJson(response)

  if (!response.ok) {
    const error = readApiError(data)
    const retryAfterSeconds = readRetryAfterSeconds(response.headers.get('Retry-After'))

    throw new RequestIntakeApiError(
      response.status,
      error.message,
      error.code,
      retryAfterSeconds,
    )
  }

  return data as T
}

function readApiError(data: unknown) {
  const record = asRecord(data)
  const message = typeof record.message === 'string' && record.message.trim()
    ? record.message
    : defaultRequestApiErrorMessage
  const code = typeof record.code === 'string' && record.code.trim()
    ? record.code
    : undefined

  return { code, message }
}

async function readJson(response: Response) {
  const text = await response.text()

  if (!text) return {}

  try {
    return JSON.parse(text) as unknown
  } catch {
    return {}
  }
}

function readRetryAfterSeconds(value: string | null) {
  if (!value) return undefined

  const seconds = Number(value)

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
