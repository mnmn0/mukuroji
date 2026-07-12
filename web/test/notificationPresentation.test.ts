import { describe, expect, test } from 'bun:test'
import type { InboxNotification } from '../src/notifications/api'
import {
  createSnoozedUntil,
  groupNotificationsByDate,
} from '../src/notifications/presentation'
import { mergeNotifications } from '../src/notifications/useNotifications'

describe('notification presentation', () => {
  test('groups cursor-ordered notifications by local day without reordering them', () => {
    const notifications = [
      createNotification('today-1', '2026-07-12T11:00:00+09:00'),
      createNotification('yesterday-1', '2026-07-11T20:00:00+09:00'),
      createNotification('earlier-1', '2026-07-01T09:00:00+09:00'),
    ]

    expect(groupNotificationsByDate(notifications, new Date('2026-07-12T12:00:00+09:00')))
      .toEqual([
        { key: 'today', notifications: [notifications[0]] },
        { key: 'yesterday', notifications: [notifications[1]] },
        { key: 'earlier', notifications: [notifications[2]] },
      ])
  })

  test('deduplicates a notification repeated across cursor pages', () => {
    const first = createNotification('notification-1', '2026-07-12T00:00:00.000Z')

    expect(mergeNotifications([first, first, createNotification('notification-2', first.occurredAt)]))
      .toEqual([first, expect.objectContaining({ id: 'notification-2' })])
  })

  test('creates deterministic snooze dates from the selected option', () => {
    const now = new Date('2026-07-12T08:15:00.000Z')

    expect(createSnoozedUntil('one-hour', now)).toBe('2026-07-12T09:15:00.000Z')
    expect(new Date(createSnoozedUntil('next-week', now)).getTime() - now.getTime())
      .toBe(7 * 24 * 60 * 60 * 1_000)
  })
})

function createNotification(id: string, occurredAt: string): InboxNotification {
  return {
    eventType: 'comment.created',
    id,
    occurredAt,
    reasons: ['watcher'],
    state: 'unread',
  }
}
