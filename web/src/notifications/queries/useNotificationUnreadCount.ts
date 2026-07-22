import useSWR from 'swr'
import { getNotificationUnreadCount } from '../api/inbox'

const notificationRefreshInterval = 15_000

/**
 * 通知未読件数用の共有 SWR key を生成します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @returns 全画面で共有する SWR key です。
 */
export function createNotificationUnreadCountKey(accessToken: string) {
  return ['notification-unread-count', accessToken] as const
}

/**
 * 全画面で共有する通知未読件数を取得します。
 *
 * @param accessToken - Notifications API の access token です。
 * @param enabled - Current user の確認後に取得を有効にするかどうかです。
 * @param loader - Storybook やテストで差し替える取得関数です。
 * @returns 未読件数の SWR state です。
 */
export function useNotificationUnreadCount(
  accessToken?: string,
  enabled = true,
  loader = getNotificationUnreadCount,
) {
  const key = accessToken && enabled
    ? createNotificationUnreadCountKey(accessToken)
    : null

  return useSWR(
    key,
    ([, token]) => loader(token),
    {
      dedupingInterval: 5_000,
      refreshInterval: notificationRefreshInterval,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}
