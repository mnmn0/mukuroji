import type { NotificationBulkAction, NotificationBulkFailure } from '@mukuroji/contracts'
import { NotificationError } from '../domain/notification-error'
import type { NotificationClient, NotificationItem, NotificationVisibilityFilter } from '../notifications'

/** Notifications a bulk request changes at the same time. */
const bulkConcurrency = 4

/** A validated bulk Inbox change for one recipient. */
export type BulkNotificationUpdateInput = {
  /** Canonical Workspace ID of the authenticated recipient. */
  workspaceId: string
  /** Authenticated Workspace member key. */
  memberKey: string
  /** Action applied to every notification. */
  action: NotificationBulkAction
  /** Unique opaque notification IDs, in request order. */
  notificationIds: readonly string[]
  /** Current-permission filter every changed notification must pass. */
  isVisible: NotificationVisibilityFilter
}

/** Outcome of a bulk Inbox change. */
export type BulkNotificationUpdateResult = {
  /** Changed notifications, in request order. */
  notifications: NotificationItem[]
  /** Notifications that could not be changed, in request order. */
  failures: NotificationBulkFailure[]
  /** Unread count after the change. */
  unreadCount: number
}

/**
 * Applies one action to each notification, a few at a time, and collects per-notification
 * failures instead of failing the whole change, so a client can keep the failed ones selected.
 * Each change runs the same ownership, visibility, and version checks as a single update.
 * @param notifications - Notification store bound to the current request.
 * @param input - Recipient, action, IDs, and current-permission filter.
 * @returns Changed notifications, failures, and the unread count afterwards.
 * @throws The first error that is not a NotificationError, such as a storage outage.
 */
export async function updateNotificationsInBulk(
  notifications: NotificationClient,
  input: BulkNotificationUpdateInput,
): Promise<BulkNotificationUpdateResult> {
  const results: Array<{ notification?: NotificationItem, failure?: NotificationBulkFailure }> = []
  for (let start = 0; start < input.notificationIds.length; start += bulkConcurrency) {
    const chunk = input.notificationIds.slice(start, start + bulkConcurrency)
    results.push(...await Promise.all(chunk.map(async (id) => {
      try {
        return {
          notification: await notifications.update({
            workspaceId: input.workspaceId,
            memberKey: input.memberKey,
            notificationId: id,
            action: input.action,
            isVisible: input.isVisible,
          }),
        }
      } catch (error) {
        if (error instanceof NotificationError) {
          return { failure: { id, status: error.status, code: error.code } }
        }
        throw error
      }
    })))
  }
  const unreadCount = await notifications.countUnread({
    workspaceId: input.workspaceId,
    memberKey: input.memberKey,
    isVisible: input.isVisible,
  })
  return {
    notifications: results.flatMap((result) => result.notification ? [result.notification] : []),
    failures: results.flatMap((result) => result.failure ? [result.failure] : []),
    unreadCount,
  }
}
