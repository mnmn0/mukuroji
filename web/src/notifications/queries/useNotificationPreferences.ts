import useSWR from 'swr'
import { getNotificationPreferences } from '../api/preferences'

/**
 * Identifies the notification-preference operation that owns a session-error report.
 */
export type NotificationPreferencesSessionErrorSource = 'query' | 'save'

/**
 * Reports or clears one notification-preference operation's session error.
 *
 * @param source - Notification-preference operation that owns the error slot.
 * @param error - Current error, or `undefined` after the operation recovers.
 * @returns Nothing.
 */
export type NotificationPreferencesSessionErrorReporter = (
  source: NotificationPreferencesSessionErrorSource,
  error?: unknown,
) => void

/**
 * Loads the current user's notification delivery preferences.
 *
 * @param accessToken - Access token used by the Notifications API.
 * @param enabled - Whether the Settings query may run.
 * @param onSessionError - Reports or clears the query's shared session-policy error.
 * @returns SWR state for the current notification preferences.
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
