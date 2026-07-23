import useSWR from 'swr'
import { getNotificationPreferences } from '../api/preferences'

/**
 * Current userのnotification delivery preferencesを取得します。
 *
 * @param accessToken - Notifications API の access token です。
 * @param enabled - Settings viewを表示しているかどうかです。
 * @param onSessionError - Reports or clears an error for shared session policy handling.
 * @returns Notification preferences の SWR state です。
 */
export function useNotificationPreferencesQuery(
  accessToken?: string,
  enabled = true,
  onSessionError?: (error?: unknown) => void,
) {
  const key = accessToken && enabled
    ? ['notification-preferences', accessToken] as const
    : null

  return useSWR(
    key,
    ([, token]) => getNotificationPreferences(token),
    {
      dedupingInterval: 5_000,
      onError: (error: unknown) => onSessionError?.(error),
      onSuccess: () => onSessionError?.(),
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}
