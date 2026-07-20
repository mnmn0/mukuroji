import useSWR from 'swr'
import { getCurrentUser } from '../api/currentUser'

const currentUserQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * 認証済みユーザーを取得します。
 *
 * @param accessToken - Current user API の access token です。
 * @param enabled - Query を実行できる認証状態かどうかです。
 * @param loader - Storybook やテストで差し替える取得関数です。
 * @returns Current user の SWR state と共有 key です。
 */
export function useCurrentUser(
  accessToken?: string,
  enabled = true,
  loader = getCurrentUser,
) {
  const key = accessToken && enabled
    ? ['current-user', accessToken] as const
    : null
  const query = useSWR(
    key,
    ([, token]) => loader(token),
    currentUserQueryConfig,
  )

  return {
    ...query,
    key,
  }
}
