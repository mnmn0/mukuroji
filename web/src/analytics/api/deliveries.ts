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
 * @throws AnalyticsApiError when the request fails or the response is malformed.
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
  // A malformed success response is a failure, so the page shows its retry instead of an empty list.
  if (!Array.isArray(record.deliveries)) throw invalidDeliveriesResponse()
  const deliveries = record.deliveries.map((value) => {
    const delivery = readAnalyticsDelivery(value)
    if (delivery === undefined) throw invalidDeliveriesResponse()
    return delivery
  })
  return {
    deliveries,
    ...(typeof record.nextCursor === 'string' && record.nextCursor
      ? { nextCursor: record.nextCursor }
      : {}),
  }
}

/** Pages read at most while skipping pages whose deliveries are all of unreadable reports. */
const maxSkippedDeliveryPages = 5

/**
 * Reads the next page that holds a delivery, following the cursor past pages the server emptied
 * because the user can no longer read their reports.
 *
 * The read stops after a bounded number of empty pages and keeps the cursor, so the screen can
 * offer to read on instead of hiding older deliveries.
 *
 * @param accessToken - Access token for the Authorization header.
 * @param cursor - Cursor of the previous page; omitted for the newest deliveries.
 * @param signal - Signal that aborts the requests.
 * @returns The first non-empty page, or the last page read when none holds a delivery.
 * @throws AnalyticsApiError when a request fails or a response is malformed.
 */
export async function getRecentAnalyticsDeliveries(
  accessToken: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<AnalyticsDeliveryListResponse> {
  let page = await getAnalyticsDeliveries(accessToken, cursor, signal)
  for (
    let skipped = 1;
    page.deliveries.length === 0 && page.nextCursor !== undefined && skipped < maxSkippedDeliveryPages;
    skipped += 1
  ) {
    page = await getAnalyticsDeliveries(accessToken, page.nextCursor, signal)
  }
  return page
}

/**
 * Creates the error for a success response that does not hold a valid delivery list.
 *
 * @returns The error to throw.
 */
function invalidDeliveriesResponse() {
  return new AnalyticsApiError(
    502,
    'Analytics API returned an invalid response.',
    'InvalidAnalyticsResponse',
  )
}

/**
 * Reads one delivery from the response.
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
