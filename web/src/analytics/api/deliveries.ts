import type { AnalyticsDelivery, AnalyticsDeliveryListResponse } from '@mukuroji/contracts'
import { AnalyticsApiError } from './errors'
import { readRecord } from '../../shared/api/jsonValidation'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

const analyticsApiBaseUrl = resolveApiBaseUrl()

const defaultAnalyticsApiErrorMessage = 'Unable to complete the analytics request.'

/**
 * Reads one page of the scheduled report deliveries to the current user, newest first.
 *
 * @param accessToken - Access token for the Authorization header.
 * @param cursor - Cursor of the previous page.
 * @param signal - Signal that aborts the request.
 * @returns The deliveries of reports the user can read now, and the next cursor.
 */
export async function getAnalyticsDeliveries(
  accessToken: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<AnalyticsDeliveryListResponse> {
  const search = new URLSearchParams({ limit: '20' })
  if (cursor !== undefined) search.set('cursor', cursor)
  const response = await fetch(`${analyticsApiBaseUrl}/analytics/deliveries?${search.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  const record = readRecord(body)
  if (!response.ok) {
    throw new AnalyticsApiError(
      response.status,
      typeof record.message === 'string' ? record.message : defaultAnalyticsApiErrorMessage,
      typeof record.code === 'string' ? record.code : undefined,
    )
  }
  const deliveries = Array.isArray(record.deliveries)
    ? record.deliveries.flatMap((value) => {
        const delivery = readAnalyticsDelivery(value)
        return delivery === undefined ? [] : [delivery]
      })
    : []
  return {
    deliveries,
    ...(typeof record.nextCursor === 'string' && record.nextCursor
      ? { nextCursor: record.nextCursor }
      : {}),
  }
}

/**
 * Reads one delivery from the response, leaving out malformed entries.
 *
 * @param value - Response entry.
 * @returns The delivery, or undefined when the entry is malformed.
 */
function readAnalyticsDelivery(value: unknown): AnalyticsDelivery | undefined {
  const record = readRecord(value)
  if (
    typeof record.reportId !== 'string' ||
    typeof record.reportName !== 'string' ||
    typeof record.snapshotId !== 'string' ||
    (record.format !== 'csv' && record.format !== 'pdf') ||
    typeof record.deliveredAt !== 'string'
  ) {
    return undefined
  }
  return {
    reportId: record.reportId,
    reportName: record.reportName,
    snapshotId: record.snapshotId,
    format: record.format,
    deliveredAt: record.deliveredAt,
  }
}
