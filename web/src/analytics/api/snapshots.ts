import type { AnalyticsQueryInput, AnalyticsSnapshotListResponse, AnalyticsSnapshotRecord } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { AnalyticsApiError } from './errors'

const analyticsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultAnalyticsApiErrorMessage = 'Unable to complete the analytics request.'

/**
 * Report に保存された immutable snapshot を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param reportId - Snapshot を所有する report ID です。
 * @param cursor - より古い snapshot page を指す opaque cursor です。
 * @param signal - Request を中断する AbortSignal です。
 * @returns 新しい順の snapshot record と検査件数、次 cursor です。
 */
export async function getAnalyticsSnapshots(
  accessToken: string,
  reportId: string,
  cursor?: string,
  signal?: AbortSignal,
) {
  const search = new URLSearchParams()
  if (cursor !== undefined) search.set('cursor', cursor)
  const response = await requestJson<unknown>(
    `${createReportPath(reportId)}/snapshots${
      search.size > 0 ? `?${search.toString()}` : ''
    }`,
    accessToken,
    { signal },
  )
  const record = asRecord(response)

  return {
    inspectedCount: typeof record.inspectedCount === 'number'
      ? record.inspectedCount
      : 0,
    snapshots: Array.isArray(record.snapshots)
      ? record.snapshots as AnalyticsSnapshotRecord[]
      : [],
    ...(typeof record.nextCursor === 'string' && record.nextCursor.trim()
      ? { nextCursor: record.nextCursor }
      : {}),
  } satisfies AnalyticsSnapshotListResponse
}

/**
 * Cursor page の snapshot をAPI順のままIDで重複排除します。
 *
 * @param pages - 新しいpageから順に読み込まれたsnapshot responseです。
 * @returns 最初に現れたrecordを保持したsnapshot一覧です。
 */
export function collectAnalyticsSnapshotPages(
  pages: readonly AnalyticsSnapshotListResponse[],
) {
  const snapshots = new Map<string, AnalyticsSnapshotRecord>()
  for (const page of pages) {
    for (const snapshot of page.snapshots) {
      if (!snapshots.has(snapshot.id)) snapshots.set(snapshot.id, snapshot)
    }
  }
  return [...snapshots.values()]
}

/**
 * 現在の query 結果を report revision に紐づく snapshot として保存します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param reportId - Snapshot を保存する report ID です。
 * @param query - Report definition へ適用する snapshot の `asOf` です。
 * @param mutationContext - Retry 間で維持する mutation context です。
 * @returns 保存された snapshot record です。
 */
export async function createAnalyticsSnapshot(
  accessToken: string,
  reportId: string,
  query: Pick<AnalyticsQueryInput, 'asOf'>,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<unknown>(
    `${createReportPath(reportId)}/snapshots`,
    accessToken,
    {
      body: JSON.stringify({ asOf: query.asOf }),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )

  return unwrapRecord<AnalyticsSnapshotRecord>(response, 'snapshotRecord')
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
