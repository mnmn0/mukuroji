import useSWR from 'swr'
import { getNotificationPreferences } from '../api/preferences'

/**
 * Current userのnotification delivery preferencesを取得します。
 *
 * @param accessToken - Notifications API の access token です。
 * @param enabled - Settings viewを表示しているかどうかです。
 * @returns Notification preferences の SWR state です。
 */
export function useNotificationPreferencesQuery(
  accessToken?: string,
  enabled = true,
) {
  const key = accessToken && enabled
    ? ['notification-preferences', accessToken] as const
    : null

  return useSWR(
    key,
    ([, token]) => getNotificationPreferences(token),
    {
      dedupingInterval: 5_000,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}
