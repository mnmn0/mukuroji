import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NotificationSettingsPanel } from '../src/notifications/ui/NotificationSettingsPanel'
import { notificationPreferencesControllerFixture, notificationPreferencesFixture } from '../src/notifications/fixtures'

describe('Slack notification preference', () => {
  test('offers an accessible, initially unchecked opt-in for legacy preferences', () => {
    const html = renderToStaticMarkup(<NotificationSettingsPanel locale="en" controller={notificationPreferencesControllerFixture} />)
    expect(html).toContain('notification-channel-slack')
    expect(html).toContain('Administrator setup is required')
    const checkbox = html.match(/<input[^>]*data-testid="notification-channel-slack"[^>]*>/)?.[0]
    expect(checkbox).toBeDefined()
    expect(checkbox).not.toContain('checked')
  })
  test('renders the saved Slack opt-in in Japanese', () => {
    const html = renderToStaticMarkup(<NotificationSettingsPanel locale="ja" controller={{
      ...notificationPreferencesControllerFixture,
      preferences: { ...notificationPreferencesFixture, channels: { ...notificationPreferencesFixture.channels, slack: true } },
    }} />)
    expect(html).toContain('同じ通知を自分のSlack送信先にも配信します')
    expect(html.match(/<input[^>]*data-testid="notification-channel-slack"[^>]*>/)?.[0]).toContain('checked')
  })
})
