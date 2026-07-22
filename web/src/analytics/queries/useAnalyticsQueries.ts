import useSWR from 'swr'
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
