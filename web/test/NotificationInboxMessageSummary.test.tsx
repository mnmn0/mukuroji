import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InboxNotification } from '../src/notifications/api'
import { notificationInboxControllerFixture, overdueMessageNotificationFixture } from '../src/notifications/fixtures'
import { NotificationInbox } from '../src/notifications/ui/NotificationInbox'
import type { Locale } from '../src/shared/i18n/i18n'

/** Overdue Work Item notification that carries its summary as a message code. */
const overdueNotification = overdueMessageNotificationFixture

/**
 * Renders the Inbox with one notification.
 *
 * @param notification - Notification to show.
 * @param locale - Reader's language.
 * @returns Static markup of the Inbox.
 */
function render(notification: InboxNotification, locale: Locale) {
  return renderToStaticMarkup(
    <NotificationInbox
      controller={{
        ...notificationInboxControllerFixture,
        notifications: [notification],
        availableEventTypes: [notification.eventType],
      }}
      locale={locale}
    />,
  )
}

describe('notification summary from a message code', () => {
  test('writes the summary in the reader language', () => {
    expect(render(overdueNotification, 'ja')).toContain('「リリース手順を作る」は期限を過ぎています。')
    expect(render(overdueNotification, 'ja')).not.toContain('is overdue.')
    expect(render(overdueNotification, 'en')).toContain('Work Item &quot;リリース手順を作る&quot; is overdue.')
  })

  test('falls back to the stored text for rows without a code', () => {
    const { message: _message, ...withoutCode } = overdueNotification
    expect(render(withoutCode, 'ja')).toContain('Work Item &quot;リリース手順を作る&quot; is overdue.')
  })
})
