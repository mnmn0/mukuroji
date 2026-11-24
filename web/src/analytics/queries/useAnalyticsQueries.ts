import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import type { AnalyticsDeliveryListResponse } from '@mukuroji/contracts'
import { getRecentAnalyticsDeliveries } from '../api/deliveries'
import { getAnalyticsReports } from '../api/reports'

const analyticsQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * 保存済み Analytics report 一覧を取得します。
 *
 * @param accessToken - Analytics API の access token です。
 * @param enabled - Current user の確認後に取得を有効にするかどうかです。
 * @returns Analytics report page の SWR state です。
 */
export function useAnalyticsReports(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['analytics-reports', accessToken] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => getAnalyticsReports(token),
    analyticsQueryConfig,
  )

  return { ...query, key }
}

/**
 * Reads the scheduled deliveries to the current user, newest first, one page at a time.
 *
 * The server leaves out deliveries of reports the user can no longer read, so a page can be empty
 * while older deliveries remain; `hasMore` stays true and `loadMore` reads on.
 *
 * @param accessToken - Analytics API access token.
 * @param enabled - Whether to read once the current user is known.
 * @returns The deliveries read so far, whether more remain, the error, and the load and retry actions.
 */
export function useAnalyticsDeliveries(accessToken?: string, enabled = true) {
  const query = useSWRInfinite(
    (pageIndex, previousPage: AnalyticsDeliveryListResponse | null) => {
      if (!accessToken || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'analytics-deliveries',
        accessToken,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] satisfies [string, string, string]
    },
    ([, token, cursor]) => getRecentAnalyticsDeliveries(token, cursor || undefined),
    { ...analyticsQueryConfig, revalidateFirstPage: true },
  )
  const pages = query.data
  const deliveriesError: unknown = query.error
  return {
    deliveries: pages?.flatMap((page) => page.deliveries),
    error: deliveriesError,
    hasMore: Boolean(pages?.at(-1)?.nextCursor),
    loadMore: () => query.setSize(query.size + 1),
    retry: () => query.mutate(),
  }
}

/**
 * 再現可能な Analytics query を実行します。
 *
 * @param accessToken - Analytics API の access token です。
 * @param serializedQuery - Filterを反映した直列化済みqueryです。
 * @param enabled - Query を実行するかどうかです。
 * @param loader - Abort制御を含むAnalytics query runnerです。
 * @returns Analytics query result の SWR state です。
 */
export function useAnalyticsQuery<TResult>(
  accessToken: string | undefined,
  serializedQuery: string,
  enabled = true,
  loader: (accessToken: string, serializedQuery: string) => Promise<TResult>,
) {
  const key = accessToken && enabled
    ? ['analytics-query', accessToken, serializedQuery] as const
    : null

  const query = useSWR(
    key,
    ([, token, currentSerializedQuery]) => loader(token, currentSerializedQuery),
    analyticsQueryConfig,
  )

  return {
    ...query,
    key,
  }
}
