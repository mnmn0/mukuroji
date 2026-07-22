import useSWR from 'swr'
import { getPlanningSnapshot } from '../api/snapshot'

const planningQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Workspace planning snapshot を取得します。
 *
 * @param accessToken - Planning API の access token です。
 * @param enabled - Current user の確認後に取得を有効にするかどうかです。
 * @returns Planning snapshot の SWR state です。
 */
export function usePlanningSnapshot(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['planning-snapshot', accessToken] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => getPlanningSnapshot(token),
    planningQueryConfig,
  )

  return {
    ...query,
    key,
  }
}
