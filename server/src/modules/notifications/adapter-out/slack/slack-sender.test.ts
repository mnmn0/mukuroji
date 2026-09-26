import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createSlackNotificationSender, slackNotificationSecretId } from './slack-sender'
import type { SlackDelivery } from '../../application/slack-delivery'

const url = 'https://hooks.slack.com/services/TTEST/BTEST/TESTTOKEN'
const delivery: SlackDelivery = {
  workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
  notificationKey: '2026-09-26T00:00:00.000Z#event-1', attempts: 0, version: 1,
  nextAttemptAt: '2026-09-26T00:00:00.000Z', expiresAt: 2_000_000_000,
  notification: { id: 'id', eventId: 'event-1', eventType: 'comment.created', reasons: ['mention'],
    title: '<!channel> & <@U123>', summary: 'Please review', occurredAt: '2026-09-26T00:00:00.000Z', state: 'unread' },
}
const secretSpy = mock(async (_secretId: string): Promise<string | undefined> => url)
afterEach(() => secretSpy.mockReset())

describe('Slack transport', () => {
  test('binds secret IDs to normalized members and workspaces', () => {
    expect(slackNotificationSecretId('workspace-1', ' MEMBER@example.test ')).toBe(slackNotificationSecretId('workspace-1', 'member@example.test'))
    expect(slackNotificationSecretId('workspace-1', 'a')).not.toBe(slackNotificationSecretId('workspace-2', 'a'))
    expect(slackNotificationSecretId('workspace-1', 'a')).not.toBe(slackNotificationSecretId('workspace-1', 'b'))
    expect(slackNotificationSecretId('workspace-1', 'a')).not.toContain('workspace-1')
    expect(slackNotificationSecretId('workspace-1', 'a').split('/').slice(-2, -1)).toEqual(['slack'])
  })
  test('sends bounded plain-text notification contents and validates the acknowledgement', async () => {
    secretSpy.mockResolvedValue(url)
    let sent = false
    const result = await createSlackNotificationSender(secretSpy, async (endpoint, request) => {
      sent = true
      expect(endpoint.toString()).toBe(url)
      expect(request.redirect).toBe('error')
      expect(request.signal).toBeInstanceOf(AbortSignal)
      const payload = JSON.parse(String(request.body))
      expect(payload.text).toContain('&lt;!channel&gt; &amp; &lt;@U123&gt;')
      expect(payload.blocks[0].text.type).toBe('plain_text')
      expect(payload.unfurl_links).toBe(false)
      expect(String(request.body)).not.toContain('TESTTOKEN')
      return new Response('ok', { status: 200 })
    })(delivery)
    expect(sent).toBe(true)
    expect(result.succeeded).toBe(true)
  })
  test('rejects non-Slack hosts, URL credentials, alternate ports, query strings and fragments before HTTP', async () => {
    for (const endpoint of [url.replace('https:', 'http:'), url.replace('hooks.slack.com', '127.0.0.1'),
      url.replace('hooks.slack.com', 'hooks.slack.com.evil.test'), url.replace('hooks.slack.com', 'u:p@hooks.slack.com'),
      url.replace('hooks.slack.com', 'hooks.slack.com:8443'), url + '?token=x', url + '#fragment',
      url.replace('/services/', '/other/../services/'), 'x'.repeat(2_049)]) {
      secretSpy.mockResolvedValue(endpoint)
      const result = await createSlackNotificationSender(secretSpy, async () => { throw new Error('Must not send') })(delivery)
      expect(result).toEqual({ succeeded: false, retryable: false, code: 'SlackDestinationInvalid' })
    }
  })
  test('supports GovSlack and handles rate limits, redirects, permanent failures and server errors', async () => {
    secretSpy.mockResolvedValue(url.replace('slack.com', 'slack-gov.com'))
    for (const status of [200, 302, 400, 403, 404, 410, 429, 500]) {
      const result = await createSlackNotificationSender(secretSpy, async () => new Response('ok', {
        status, headers: { 'Retry-After': '120' },
      }))(delivery)
      expect(result.succeeded).toBe(status === 200)
      expect(result.retryable).toBe(status === 429 || status === 500)
      if (result.retryable) expect(result.retryAfterMs).toBe(120_000)
    }
  })
  test('does not accept malformed success or leak errors containing a secret URL', async () => {
    secretSpy.mockResolvedValue(url)
    for (const body of ['', 'not_ok', 'x'.repeat(10_000)]) {
      expect((await createSlackNotificationSender(secretSpy, async () => new Response(body))(delivery)).succeeded).toBe(false)
    }
    const result = await createSlackNotificationSender(secretSpy, async () => { throw new Error(url) })(delivery)
    expect(result).toEqual({ succeeded: false, retryable: true, code: 'SlackDeliveryUnavailable' })
    secretSpy.mockRejectedValue(new Error(url))
    expect(await createSlackNotificationSender(secretSpy)(delivery)).toEqual({ succeeded: false, retryable: true, code: 'SlackDestinationUnavailable' })
  })
})
