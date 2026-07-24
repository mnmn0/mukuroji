import useSWR from 'swr'
import { getNotificationPreferences } from '../api/preferences'

/**
 * Identifies the notification-preference operation that owns a session-error report.
 */
export type NotificationPreferencesSessionErrorSource = 'query' | 'save'

/**
 * Reports or clears one notification-preference operation's session error.
 */
export type NotificationPreferencesSessionErrorReporter = (
  source: NotificationPreferencesSessionErrorSource,
  error?: unknown,
) => void

/**
 * Current userのnotification delivery preferencesを取得します。
 *
 * @param accessToken - Notifications API の access token です。
 * @param enabled - Settings viewを表示しているかどうかです。
 * @param onSessionError - Reports or clears the query's shared session-policy error.
 * @returns Notification preferences の SWR state です。
 */
export function useNotificationPreferencesQuery(
  accessToken?: string,
  enabled = true,
  onSessionError?: NotificationPreferencesSessionErrorReporter,
) {
  const key = accessToken && enabled
    ? ['notification-preferences', accessToken] as const
    : null

  return useSWR(
    key,
    ([, token]) => getNotificationPreferences(token),
    {
      dedupingInterval: 5_000,
      onError: (error: unknown) => onSessionError?.('query', error),
      onSuccess: () => onSessionError?.('query'),
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}
