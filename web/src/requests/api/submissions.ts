import type { RequestSubmission, RequestSubmissionActionInput, RequestSubmissionPage, RequestSubmissionStatus } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { RequestIntakeApiError } from './errors'

/**
 * Request queue の cursor page 取得条件です。
 */
export type GetRequestQueueOptions = {
  /**
   * API が返した opaque cursor です。
   */
  cursor?: string
  /**
   * 1 page で取得する最大件数です。
   */
  limit?: number
  /**
   * Submission status の完全一致 filter です。
   */
  status?: RequestSubmissionStatus
}

const requestsApiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

const defaultRequestApiErrorMessage = 'Unable to complete the request intake operation.'

/**
 * 認証済み user が参照できる request queue page を取得します。
 */
export function getRequestQueue(
  accessToken: string,
  options: GetRequestQueueOptions = {},
) {
  const query = new URLSearchParams()

  if (options.cursor) query.set('cursor', options.cursor)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.status) query.set('status', options.status)

  return requestJson<RequestSubmissionPage>(
    `${requestsApiBaseUrl}/request-queue${query.size ? `?${query}` : ''}`,
    { accessToken },
  )
}

/**
 * Request submission の versioned answer、thread、trace を取得します。
 */
export function getRequestSubmission(submissionId: string, accessToken: string) {
  return requestJson<RequestSubmission>(
    `${requestsApiBaseUrl}/request-submissions/${encodeURIComponent(submissionId)}`,
    { accessToken },
  )
}

/**
 * Request submission へ assign/reject/more-info/duplicate/convert action を適用します。
 */
export function applyRequestSubmissionAction(
  submissionId: string,
  input: RequestSubmissionActionInput,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<RequestSubmission>(
    `${requestsApiBaseUrl}/request-submissions/${encodeURIComponent(submissionId)}/actions`,
    {
      accessToken,
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
