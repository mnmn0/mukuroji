import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  notificationFixtures,
  notificationInboxControllerFixture,
} from '../src/notifications/fixtures'
import { NotificationInbox } from '../src/notifications/ui/NotificationInbox'

describe('notification Work Item key', () => {
  test('shows the key before the title only when the notification has one', () => {
    const markup = renderToStaticMarkup(
      <NotificationInbox controller={notificationInboxControllerFixture} locale="ja" />,
    )
    const keyed = notificationFixtures.filter((notification) => notification.workItemKey)
    expect(keyed.length).toBeGreaterThan(0)
    for (const notification of keyed) {
      expect(markup).toMatch(new RegExp(`>${notification.workItemKey}</span>${notification.title}<`))
    }
    expect(markup.match(/data-testid="notification-key-/g)?.length).toBe(keyed.length)
  })
})
