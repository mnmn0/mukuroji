import type { AnalyticsSnapshotListResponse } from '@mukuroji/contracts'
import useSWRInfinite from 'swr/infinite'
import { getAnalyticsSnapshots } from '../api/snapshots'

/**
 * Report snapshot history を cursor pagination で取得します。
 *
 * @param accessToken - Analytics API の access token です。
 * @param reportId - 取得対象の Report ID です。
 * @returns Analytics snapshot page の SWR Infinite state です。
 */
export function useAnalyticsSnapshots(
  accessToken: string | undefined,
  reportId: string | undefined,
) {
  return useSWRInfinite(
    (
      pageIndex,
      previousPage: AnalyticsSnapshotListResponse | null,
    ) => {
      if (!accessToken || !reportId) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'analytics-snapshots',
        accessToken,
        reportId,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, currentReportId, cursor]) =>
      getAnalyticsSnapshots(token, currentReportId, cursor || undefined),
    {
      dedupingInterval: 10_000,
      shouldRetryOnError: false,
    },
  )
}
