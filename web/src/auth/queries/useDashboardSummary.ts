import useSWR from 'swr'
import { getDashboardSummary } from '../api/dashboard'

const dashboardSummaryQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Dashboard summary を取得します。
 *
 * @param accessToken - Dashboard API の access token です。
 * @param enabled - Current user の確認後に取得を有効にするかどうかです。
 * @param loader - Storybook やテストで差し替える取得関数です。
 * @returns Dashboard summary の SWR state です。
 */
export function useDashboardSummary(
  accessToken?: string,
  enabled = true,
  loader = getDashboardSummary,
) {
  const key = accessToken && enabled
    ? ['dashboard-summary', accessToken] as const
    : null

  return useSWR(
    key,
    ([, token]) => loader(token),
    dashboardSummaryQueryConfig,
  )
}
