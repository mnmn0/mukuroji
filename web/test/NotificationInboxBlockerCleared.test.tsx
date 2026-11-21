import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  blockerClearedNotificationFixture as blockerClearedNotification,
  notificationInboxControllerFixture,
} from '../src/notifications/fixtures'
import { NotificationInbox } from '../src/notifications/ui/NotificationInbox'
import type { Locale } from '../src/shared/i18n/i18n'

describe('cleared blocker notification', () => {
  test('shows a localized label and summary instead of the stored English summary', () => {
    const cases: Array<[Locale, string, string]> = [
      ['ja', 'ブロック解除', 'この Work Item をブロックしていた項目が解除されました。'],
      ['en', 'Blocker cleared', 'A blocker of this work item was removed.'],
    ]
    for (const [locale, label, summary] of cases) {
      const markup = renderToStaticMarkup(
        <NotificationInbox
          controller={{
            ...notificationInboxControllerFixture,
            notifications: [blockerClearedNotification],
            availableEventTypes: [blockerClearedNotification.eventType],
          }}
          locale={locale}
        />,
      )

      expect(markup).toContain(label)
      expect(markup).toContain(summary)
      expect(markup).toContain('リリース手順を作る')
      expect(markup).not.toContain('A blocker was removed.')
    }
  })
})
