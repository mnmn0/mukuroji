import type { InboxNotification } from '../api'

/** Number of per-notification requests a bulk Inbox action keeps in flight at once. */
export const notificationBulkActionConcurrency = 4

/**
 * Resolves the selection against the loaded Inbox list, dropping rows that left it.
 *
 * @param selectedIds - IDs the user selected, possibly including rows that left the list.
 * @param notifications - Notifications currently rendered by the Inbox.
 * @returns Selected notifications that are still rendered, in list order.
 */
export function resolveSelectedNotifications(
  selectedIds: ReadonlySet<string>,
  notifications: readonly InboxNotification[],
) {
  return notifications.filter((notification) => selectedIds.has(notification.id))
}

/**
 * Adds or removes one notification from the Inbox selection.
 *
 * @param selectedIds - Current selection.
 * @param notificationId - Notification whose checkbox changed.
 * @param selected - Whether the notification should be selected.
 * @returns A new selection set.
 */
export function updateNotificationSelection(
  selectedIds: ReadonlySet<string>,
  notificationId: string,
  selected: boolean,
) {
  const next = new Set(selectedIds)

  if (selected) {
    next.add(notificationId)
  } else {
    next.delete(notificationId)
  }

  return next
}

/**
 * Runs one task per item with a bounded number of concurrent tasks and never rejects.
 *
 * @param items - Items to process; results keep this order.
 * @param concurrency - Maximum tasks in flight; values below 1 are treated as 1.
 * @param task - Async work for one item.
 * @returns Settled results aligned with `items`.
 */
export async function settleWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  task: (item: TItem) => Promise<TResult>,
) {
  const results: PromiseSettledResult<TResult>[] = []
  let nextIndex = 0

  /** Pulls the next unclaimed item until the list is exhausted. */
  async function work() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)))
  await Promise.all(Array.from({ length: workerCount }, () => work()))

  return results
}
