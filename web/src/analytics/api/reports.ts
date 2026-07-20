import type { AnalyticsReport, AnalyticsReportListResponse, CreateAnalyticsReportInput, UpdateAnalyticsReportInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { AnalyticsApiError } from './errors'

const analyticsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultAnalyticsApiErrorMessage = 'Unable to complete the analytics request.'

/**
 * 現在 user が参照できる saved analytics report を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param signal - Request を中断する AbortSignal です。
 * @returns Personal、Team、shared report の一覧です。
 */
export async function getAnalyticsReports(
  accessToken: string,
  signal?: AbortSignal,
) {
  const reports: AnalyticsReport[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let pageCount = 0

  do {
    const search = new URLSearchParams({ limit: '200' })
    if (cursor !== undefined) search.set('cursor', cursor)
    const response = await requestJson<unknown>(
      `${analyticsApiBaseUrl}/analytics/reports?${search.toString()}`,
      accessToken,
      { signal },
    )
    const record = asRecord(response)
    reports.push(...(
      Array.isArray(record.reports)
        ? record.reports as AnalyticsReport[]
        : []
    ))
    const nextCursor = typeof record.nextCursor === 'string' &&
        record.nextCursor.trim()
      ? record.nextCursor
      : undefined
    pageCount += 1
    if (pageCount > 6 || reports.length > 1_000) {
      throw new TypeError('Analytics report pagination exceeded its safe limit.')
    }
    if (nextCursor !== undefined && seenCursors.has(nextCursor)) {
      throw new TypeError('Analytics report pagination cursor repeated.')
    }
    if (nextCursor !== undefined) seenCursors.add(nextCursor)
    cursor = nextCursor
  } while (cursor !== undefined)

  return {
    reports,
  } satisfies AnalyticsReportListResponse
}

/**
 * Analytics report を保存します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Report 名、共有範囲、filter、widget です。
 * @param mutationContext - Retry 間で維持する mutation context です。
 * @returns 作成された report です。
 */
export async function createAnalyticsReport(
  accessToken: string,
  input: CreateAnalyticsReportInput,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<unknown>(
    `${analyticsApiBaseUrl}/analytics/reports`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )

  return unwrapRecord<AnalyticsReport>(response, 'report')
}

/**
 * Saved analytics report を revision 付きで更新します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param reportId - 更新対象 report ID です。
 * @param input - Expected revision と patch です。
 * @param mutationContext - Retry 間で維持する mutation context です。
 * @returns 更新された report です。
 */
export async function updateAnalyticsReport(
  accessToken: string,
  reportId: string,
  input: UpdateAnalyticsReportInput,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<unknown>(
    createReportPath(reportId),
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PATCH',
    },
  )

  return unwrapRecord<AnalyticsReport>(response, 'report')
}

/**
 * Saved analytics report を削除します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param reportId - 削除対象 report ID です。
 * @param expectedRevision - 読み込み時点の report revision です。
 * @param mutationContext - Retry 間で維持する mutation context です。
 */
export async function deleteAnalyticsReport(
  accessToken: string,
  reportId: string,
  expectedRevision: number,
  mutationContext: MutationRequestContext,
) {
  await requestJson<unknown>(
    createReportPath(reportId),
    accessToken,
    {
      body: JSON.stringify({ expectedRevision }),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'DELETE',
    },
  )
}

function createReportPath(reportId: string) {
  return `${analyticsApiBaseUrl}/analytics/reports/${encodeURIComponent(reportId)}`
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
