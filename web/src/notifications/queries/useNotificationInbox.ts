import type {
  NotificationFilter,
  NotificationPage,
} from '../api/inbox'
import useSWRInfinite from 'swr/infinite'
import { getNotifications } from '../api/inbox'

const notificationPageSize = 30
const notificationRefreshInterval = 15_000

/**
 * Notification inboxをcursor paginationで取得します。
 *
 * @param accessToken - Notifications API の access token です。
 * @param enabled - Inbox viewを表示しているかどうかです。
 * @param filter - Notification state filterです。
 * @param eventType - Notification event type filterです。
 * @returns Notification page の SWR Infinite state です。
 */
export function useNotificationInboxPages(
  accessToken: string | undefined,
  enabled: boolean,
  filter: NotificationFilter,
  eventType?: string,
) {
  return useSWRInfinite(
    (pageIndex, previousPage: NotificationPage | null) => {
      if (!accessToken || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null

      return [
        'notifications',
        accessToken,
        filter,
        eventType ?? '',
        previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, currentFilter, currentEventType, cursor]) =>
      getNotifications(token, {
        cursor: cursor || undefined,
        filter: currentFilter,
        limit: notificationPageSize,
        type: currentEventType || undefined,
      }),
    {
      dedupingInterval: 2_000,
      refreshInterval: notificationRefreshInterval,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateFirstPage: true,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}
