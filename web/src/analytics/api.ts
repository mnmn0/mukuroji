import type {
  AnalyticsEvidenceInput,
  AnalyticsEvidenceResponse,
  AnalyticsExportInput,
  AnalyticsQueryInput,
  AnalyticsReport,
  AnalyticsReportListResponse,
  AnalyticsSnapshot,
  AnalyticsSnapshotRecord,
  CreateAnalyticsReportInput,
  UpdateAnalyticsReportInput,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../api/mutationHeaders'

/**
 * Analytics export で生成できるファイル形式です。
 */
export type AnalyticsExportFormat = 'csv' | 'pdf'

/**
 * Browser download に渡す analytics export artifact です。
 */
export type AnalyticsExportArtifact = {
  /**
   * API が生成した file body です。
   */
  blob: Blob
  /**
   * Content-Disposition または既定値から解決した filename です。
   */
  filename: string
}

/**
 * Viewer と同じ source を固定した analytics export input を作成します。
 *
 * @param format - 生成する artifact 形式です。
 * @param locale - Export label に利用する locale です。
 * @param query - Live viewer の再現可能な query です。
 * @param snapshotId - 表示中 immutable snapshot の任意 ID です。
 * @returns Snapshot または live query の一方だけを参照する export input です。
 */
export function createAnalyticsExportInput(
  format: AnalyticsExportFormat,
  locale: string,
  query: AnalyticsQueryInput,
  snapshotId?: string,
): AnalyticsExportInput {
  return snapshotId
    ? { format, locale, snapshotId }
    : { format, locale, query }
}

/**
 * Analytics API が返した失敗を表す例外です。
 */
export class AnalyticsApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した機械判定用の安定 error code です。
   */
  readonly code?: string

  /**
   * Analytics API error を生成します。
   *
   * @param status - HTTP status code です。
   * @param message - Error response の message です。
   * @param code - Error response の安定 code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AnalyticsApiError'
    this.status = status
    this.code = code
  }
}

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
  const response = await requestJson<unknown>(
    `${analyticsApiBaseUrl}/analytics/reports`,
    accessToken,
    { signal },
  )
  const record = asRecord(response)

  return {
    reports: Array.isArray(record.reports)
      ? record.reports as AnalyticsReport[]
      : [],
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

/**
 * Report に保存された immutable snapshot を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param reportId - Snapshot を所有する report ID です。
 * @param signal - Request を中断する AbortSignal です。
 * @returns 新しい順の snapshot record です。
 */
export async function getAnalyticsSnapshots(
  accessToken: string,
  reportId: string,
  signal?: AbortSignal,
) {
  const response = await requestJson<unknown>(
    `${createReportPath(reportId)}/snapshots`,
    accessToken,
    { signal },
  )
  const record = asRecord(response)

  return Array.isArray(record.snapshots)
    ? record.snapshots as AnalyticsSnapshotRecord[]
    : Array.isArray(response)
      ? response as AnalyticsSnapshotRecord[]
      : []
}

/**
 * 現在の query 結果を report revision に紐づく snapshot として保存します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param reportId - Snapshot を保存する report ID です。
 * @param query - Snapshot の filter、widget、timezone です。
 * @param mutationContext - Retry 間で維持する mutation context です。
 * @returns 保存された snapshot record です。
 */
export async function createAnalyticsSnapshot(
  accessToken: string,
  reportId: string,
  query: AnalyticsQueryInput,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<unknown>(
    `${createReportPath(reportId)}/snapshots`,
    accessToken,
    {
      body: JSON.stringify(query),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )

  return unwrapRecord<AnalyticsSnapshotRecord>(response, 'snapshotRecord')
}

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

/**
 * Analytics query と同じ snapshot semantics で CSV または PDF を生成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Snapshot、report、ad-hoc query のいずれかと出力形式です。
 * @returns Browser download に使う artifact です。
 */
export async function exportAnalytics(
  accessToken: string,
  input: AnalyticsExportInput,
) {
  const response = await fetch(`${analyticsApiBaseUrl}/analytics/export`, {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })

  if (!response.ok) {
    await throwAnalyticsResponseError(response)
  }

  return {
    blob: await response.blob(),
    filename: readDownloadFilename(response.headers.get('Content-Disposition')) ??
      `mukuroji-analytics.${input.format}`,
  } satisfies AnalyticsExportArtifact
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

function readDownloadFilename(contentDisposition: string | null) {
  if (!contentDisposition) {
    return undefined
  }

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }

  return contentDisposition.match(/filename="?([^";]+)"?/i)?.[1]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
