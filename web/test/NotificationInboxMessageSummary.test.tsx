import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InboxNotification } from '../src/notifications/api'
import { notificationInboxControllerFixture } from '../src/notifications/fixtures'
import { NotificationInbox } from '../src/notifications/ui/NotificationInbox'
import type { Locale } from '../src/shared/i18n/i18n'

/** Overdue Work Item notification that carries its summary as a message code. */
const overdueNotification: InboxNotification = {
  id: 'notification-overdue-1',
  eventId: 'event-overdue-1',
  eventType: 'work-item.overdue',
  reasons: ['assignee'],
  title: 'リリース手順を作る',
  summary: 'Work Item "リリース手順を作る" is overdue.',
  message: { code: 'work-item.overdue', params: { title: 'リリース手順を作る' } },
  occurredAt: '2026-07-12T03:20:00.000Z',
  state: 'unread',
}

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

  test('falls back to the stored text for rows without a code or with a code the client does not know', () => {
    const { message: _message, ...withoutCode } = overdueNotification
    expect(render(withoutCode, 'ja')).toContain('Work Item &quot;リリース手順を作る&quot; is overdue.')
    // A newer server can send a code this client has no text for.
    const unknownCode: InboxNotification = { ...overdueNotification }
    Reflect.set(unknownCode, 'message', { code: 'work-item.future' })
    expect(render(unknownCode, 'ja')).toContain('Work Item &quot;リリース手順を作る&quot; is overdue.')
  })
})
