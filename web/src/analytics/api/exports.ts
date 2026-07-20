import type { AnalyticsExportInput, AnalyticsQueryInput } from '@mukuroji/contracts'
import { AnalyticsApiError } from './errors'

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

const analyticsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultAnalyticsApiErrorMessage = 'Unable to complete the analytics request.'

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
