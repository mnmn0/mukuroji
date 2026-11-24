import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { updateNotificationPreferences } from '../src/notifications/api'
import { NotificationSettingsPanel } from '../src/notifications/ui/NotificationSettingsPanel'
import { notificationPreferencesControllerFixture, notificationPreferencesFixture } from '../src/notifications/fixtures'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Renders the panel with a server transport report.
 * @param transports - Report from the server, or undefined for an older server.
 * @returns Rendered markup.
 */
function render(transports?: { email: boolean, push: boolean }) {
  return renderToStaticMarkup(<NotificationSettingsPanel locale="ja" controller={{
    ...notificationPreferencesControllerFixture,
    preferences: {
      ...notificationPreferencesFixture,
      channels: { ...notificationPreferencesFixture.channels, email: true, push: true },
      ...(transports ? { transports } : {}),
    },
  }} />)
}

describe('notification transport availability', () => {
  test('marks Email and push off when the deployment cannot send them', () => {
    const html = render({ email: false, push: true })
    expect(html).toContain('notification-channel-email-unavailable')
    expect(html).not.toContain('notification-channel-push-unavailable')
    expect(html).toContain('この環境では送信元が設定されていないため送信されません')
  })

  test('marks nothing for a server that does not report transports', () => {
    expect(render()).not.toContain('-unavailable')
  })

  test('never sends the server-owned report back when saving', async () => {
    let body = ''
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = typeof init?.body === 'string' ? init.body : ''
      return new Response(JSON.stringify(notificationPreferencesFixture), { status: 200 })
    }, { preconnect: originalFetch.preconnect })
    await updateNotificationPreferences('token', { ...notificationPreferencesFixture, transports: { email: false, push: false } }, {
      idempotencyKey: 'key', correlationId: 'correlation',
    })
    expect(JSON.parse(body)).not.toHaveProperty('transports')
  })
})
