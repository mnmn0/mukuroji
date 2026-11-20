import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  notificationFixtures,
  notificationInboxControllerFixture,
} from '../src/notifications/fixtures'
import {
  resolveSelectedNotifications,
  settleWithConcurrency,
  updateNotificationSelection,
} from '../src/notifications/model/selection'
import { NotificationInbox } from '../src/notifications/ui/NotificationInbox'

describe('notification Inbox bulk selection', () => {
  test('keeps only selected notifications that are still loaded, in list order', () => {
    const [first, second] = notificationFixtures
    const selected = new Set([second?.id ?? '', 'left-the-list', first?.id ?? ''])

    expect(resolveSelectedNotifications(selected, notificationFixtures).map((item) => item.id))
      .toEqual(notificationFixtures.slice(0, 2).map((item) => item.id))
  })

  test('toggles one notification without mutating the previous selection', () => {
    const previous = new Set(['a'])
    const added = updateNotificationSelection(previous, 'b', true)
    const removed = updateNotificationSelection(added, 'a', false)

    expect([...previous]).toEqual(['a'])
    expect([...added]).toEqual(['a', 'b'])
    expect([...removed]).toEqual(['b'])
  })

  test('settles every task in order without exceeding the concurrency limit', async () => {
    let inFlight = 0
    let maximumInFlight = 0
    const results = await settleWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      inFlight += 1
      maximumInFlight = Math.max(maximumInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      if (value === 3) {
        throw new Error('failed')
      }
      return value * 10
    })

    expect(maximumInFlight).toBe(2)
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ])
    expect(results[5]).toEqual({ status: 'fulfilled', value: 60 })
  })

  test('returns no results for an empty list', async () => {
    expect(await settleWithConcurrency([], 4, async () => 1)).toEqual([])
  })

  test('renders a select-all control and one labelled checkbox per notification', () => {
    const markup = renderToStaticMarkup(
      <NotificationInbox controller={notificationInboxControllerFixture} locale="ja" />,
    )

    expect(markup).toContain('data-testid="notification-bulk-bar"')
    expect(markup).toContain('表示中の通知をすべて選択')
    expect(markup).toContain('通知を選ぶとまとめて操作できます')
    for (const notification of notificationFixtures) {
      expect(markup).toContain(`${notification.title ?? ''} を選択`)
    }
    expect(markup).not.toContain('data-testid="notification-bulk-archive"')
  })
})
