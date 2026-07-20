import type { AnalyticsEvidenceInput, AnalyticsEvidenceResponse } from '@mukuroji/contracts'
import { AnalyticsApiError } from './errors'

const analyticsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultAnalyticsApiErrorMessage = 'Unable to complete the analytics request.'

/**
 * Metric、filter、timezone を固定して根拠 Work Item / event を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Metric、filter、as-of、timezone と任意 cursor です。
 * @param signal - Request を中断する AbortSignal です。
 * @returns 根拠 item と次 cursor です。
 */
export async function getAnalyticsEvidence(
  accessToken: string,
  input: AnalyticsEvidenceInput,
  signal?: AbortSignal,
) {
  const response = await requestJson<unknown>(
    `${analyticsApiBaseUrl}/analytics/evidence`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal,
    },
  )

  return response as AnalyticsEvidenceResponse
}

async function requestJson<T>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })

  if (!response.ok) {
    await throwAnalyticsResponseError(response)
  }

  const text = await response.text()
  return (text ? JSON.parse(text) : {}) as T
}

async function throwAnalyticsResponseError(response: Response): Promise<never> {
  let body: unknown

  try {
    const text = await response.text()
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }

  const record = asRecord(body)
  throw new AnalyticsApiError(
    response.status,
    typeof record.message === 'string'
      ? record.message
      : defaultAnalyticsApiErrorMessage,
    typeof record.code === 'string' ? record.code : undefined,
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
