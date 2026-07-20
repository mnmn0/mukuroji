import type { InboxNotification } from '../api'

/**
 * Inbox UI で選択できる snooze option です。
 */
export type NotificationSnoozeOption = 'one-hour' | 'tomorrow' | 'next-week'

/**
 * 日付見出しと通知一覧の組です。
 */
export type NotificationDateGroup = {
  /**
   * i18n 見出しの識別子です。
   */
  key: 'today' | 'yesterday' | 'earlier'
  /**
   * グループに含まれる通知です。
   */
  notifications: InboxNotification[]
}

/**
 * 通知を発生日の Today / Yesterday / Earlier にまとめます。
 *
 * @param notifications - 発生日時の降順で取得した通知です。
 * @param now - 日付境界の基準時刻です。
 * @returns 空グループを除いた日付グループです。
 */
export function groupNotificationsByDate(
  notifications: InboxNotification[],
  now = new Date(),
): NotificationDateGroup[] {
  const groups = new Map<NotificationDateGroup['key'], InboxNotification[]>([
    ['today', []],
    ['yesterday', []],
    ['earlier', []],
  ])

  for (const notification of notifications) {
    const occurredAt = new Date(notification.occurredAt)
    const key = isSameLocalDate(occurredAt, now)
      ? 'today'
      : isSameLocalDate(occurredAt, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
        ? 'yesterday'
        : 'earlier'

    groups.get(key)?.push(notification)
  }

  return Array.from(groups, ([key, groupedNotifications]) => ({
    key,
    notifications: groupedNotifications,
  })).filter((group) => group.notifications.length > 0)
}

/**
 * snooze option から再表示日時を作ります。
 *
 * @param option - UI で選択された snooze option です。
 * @param now - 加算元の時刻です。
 * @returns API へ送る ISO 8601 timestamp です。
 */
export function createSnoozedUntil(
  option: NotificationSnoozeOption,
  now = new Date(),
) {
  if (option === 'one-hour') {
    return new Date(now.getTime() + 60 * 60 * 1_000).toISOString()
  }

  const result = new Date(now)

  if (option === 'tomorrow') {
    result.setDate(result.getDate() + 1)
    result.setHours(9, 0, 0, 0)
  } else {
    result.setDate(result.getDate() + 7)
  }

  return result.toISOString()
}

function isSameLocalDate(first: Date, second: Date) {
  return first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
}
