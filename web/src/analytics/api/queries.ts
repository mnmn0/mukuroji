import type { AnalyticsQueryInput, AnalyticsSnapshot } from '@mukuroji/contracts'
import { AnalyticsApiError } from './errors'

const analyticsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultAnalyticsApiErrorMessage = 'Unable to complete the analytics request.'

/**
 * Filter、widget、timezone を固定して analytics snapshot を実行します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param query - 再現可能な filter と widget 定義です。
 * @param signal - Request を中断する AbortSignal です。
 * @returns Permission filter 適用済み analytics snapshot です。
 */
export async function queryAnalytics(
  accessToken: string,
  query: AnalyticsQueryInput,
  signal?: AbortSignal,
) {
  const response = await requestJson<unknown>(
    `${analyticsApiBaseUrl}/analytics/query`,
    accessToken,
    {
      body: JSON.stringify(query),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal,
    },
  )

  return unwrapRecord<AnalyticsSnapshot>(response, 'snapshot')
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

function unwrapRecord<T>(value: unknown, key: string) {
  const record = asRecord(value)
  return (record[key] ?? value) as T
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
