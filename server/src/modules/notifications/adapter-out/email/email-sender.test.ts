import { describe, expect, test } from 'bun:test'
import type { ChannelDelivery } from '../../application/channel-delivery'
import { createEmailNotificationSender, renderEmailNotification, type EmailMessage, type EmailRecipientLookup } from './email-sender'

const delivery: ChannelDelivery = {
  workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
  notificationKey: 'key', attempts: 0, version: 1, nextAttemptAt: '2026-09-26T12:00:00.000Z', expiresAt: 2_000_000_000,
  notification: { id: 'notification-1', eventId: 'event-1', eventType: 'comment.created', reasons: ['mention'],
    title: 'Review\r\nBcc: attacker@example.test', summary: 'Please review', deepLink: '/teams/core/issues/CORE-1',
    occurredAt: '2026-09-26T11:00:00.000Z', state: 'unread' },
}

/** Creates a sender with a fixed recipient and a recording or failing provider. */
function sender(recipient: EmailRecipientLookup | Error, failure?: Error) {
  const messages: EmailMessage[] = []
  const send = createEmailNotificationSender({
    sender: 'notify@example.test', appOrigin: 'https://app.example.test',
    readRecipient: async () => { if (recipient instanceof Error) throw recipient; return recipient },
    sendEmail: async (message) => { if (failure) throw failure; messages.push(message) },
  })
  return { send, messages }
}

/** Creates a provider error with the AWS SDK error name. */
function named(name: string): Error {
  const error = new Error('provider')
  error.name = name
  return error
}

describe('Email notification sender', () => {
  test('mails the verified address a bilingual plain-text message with the Inbox deep link', async () => {
    const f = sender({ kind: 'verified', address: ' member@example.test ' })
    expect(await f.send(delivery)).toEqual({ succeeded: true, retryable: false })
    expect(f.messages[0]).toMatchObject({ from: 'notify@example.test', to: 'member@example.test' })
    expect(f.messages[0]?.subject).toBe('[mukuroji] Review Bcc: attacker@example.test')
    expect(f.messages[0]?.text).toContain('https://app.example.test/teams/core/issues/CORE-1')
    expect(f.messages[0]?.text).toContain('通知設定で Email を無効')
    expect(f.messages[0]?.text).toContain('Turn Email off')
  })
  test('never links outside the application origin', () => {
    for (const deepLink of ['//evil.example.test/x', 'https://evil.example.test/', '/\\evil.example.test', undefined]) {
      const text = renderEmailNotification({ ...delivery, notification: { ...delivery.notification, deepLink } }, 'https://app.example.test').text
      expect(text).toContain('Open in mukuroji: https://app.example.test/\n')
      expect(text).not.toContain('evil')
    }
  })
  test('prefixes the Work Item key and links its key page', () => {
    const rendered = renderEmailNotification({
      ...delivery,
      notification: { ...delivery.notification, title: 'Review', workItemKey: 'CORE-12' },
    }, 'https://app.example.test/ignored')
    expect(rendered.subject).toBe('[mukuroji] CORE-12 Review')
    expect(rendered.text.split('\n')[0]).toBe('CORE-12 Review')
    expect(rendered.text).toContain('CORE-12: https://app.example.test/browse/CORE-12')
  })
  test('ignores a stored key that is not canonical', () => {
    const rendered = renderEmailNotification({
      ...delivery,
      notification: { ...delivery.notification, title: 'Review', workItemKey: 'core-12' },
    }, 'https://app.example.test')
    expect(rendered.subject).toBe('[mukuroji] Review')
    expect(rendered.text).not.toContain('/browse/')
  })
  test('suppresses missing and unverified recipients and retries identity failures', async () => {
    expect(await sender({ kind: 'missing' }).send(delivery)).toMatchObject({ suppressed: true, code: 'EmailRecipientMissing' })
    expect(await sender({ kind: 'unverified' }).send(delivery)).toMatchObject({ suppressed: true, code: 'EmailRecipientUnverified' })
    expect(await sender({ kind: 'verified', address: 'a@b.test, c@d.test' }).send(delivery)).toMatchObject({ suppressed: true })
    expect(await sender(new Error('Cognito down')).send(delivery)).toEqual({ succeeded: false, retryable: true, code: 'EmailRecipientUnavailable' })
  })
  test('never sends after a recipient lookup outlives the deadline', async () => {
    const messages: EmailMessage[] = []
    const send = createEmailNotificationSender({
      sender: 'notify@example.test', appOrigin: 'https://app.example.test', deadlineMs: 5,
      readRecipient: async () => {
        await Bun.sleep(30)
        return { kind: 'verified', address: 'member@example.test' }
      },
      sendEmail: async (message, signal) => { signal.throwIfAborted(); messages.push(message) },
    })
    expect(await send(delivery)).toEqual({ succeeded: false, retryable: true, code: 'EmailRecipientUnavailable' })
    expect(messages).toEqual([])
  })
  test('classifies provider errors without exposing their messages', async () => {
    const verified: EmailRecipientLookup = { kind: 'verified', address: 'member@example.test' }
    expect(await sender(verified, named('MessageRejected')).send(delivery)).toEqual({ succeeded: false, retryable: false, code: 'EmailDeliveryRejected' })
    expect(await sender(verified, named('TooManyRequestsException')).send(delivery)).toEqual({ succeeded: false, retryable: true, code: 'EmailRateLimited' })
    expect(await sender(verified, new Error('socket hang up')).send(delivery)).toEqual({ succeeded: false, retryable: true, code: 'EmailDeliveryUnavailable' })
  })
  test('writes a coded summary in the recipient language and keeps a plain stored summary', async () => {
    const coded: ChannelDelivery = { ...delivery, notification: { ...delivery.notification, title: undefined,
      summary: 'Work Item "Release" is overdue.', message: { code: 'work-item.overdue', params: { title: 'Release' } } } }
    const english = renderEmailNotification(coded, 'https://app.example.test', 'en')
    const japanese = renderEmailNotification(coded, 'https://app.example.test', 'ja')
    expect(english.subject).toBe('[mukuroji] Work Item "Release" is overdue.')
    expect(japanese.subject).toBe('[mukuroji] 「Release」は期限を過ぎています。')
    expect(japanese.text).toContain('「Release」は期限を過ぎています。')
    expect(renderEmailNotification(coded, 'https://app.example.test').text).toContain('「Release」は期限を過ぎています。')
    expect(renderEmailNotification(delivery, 'https://app.example.test', 'en').text).toContain('Please review')
    const messages: EmailMessage[] = []
    const send = createEmailNotificationSender({
      sender: 'notify@example.test', appOrigin: 'https://app.example.test',
      readRecipient: async () => ({ kind: 'verified', address: 'member@example.test' }),
      readLocale: async (recipient) => recipient.memberKey === 'member@example.test' ? 'en' : 'ja',
      sendEmail: async (message) => { messages.push(message) },
    })
    expect(await send(coded)).toEqual({ succeeded: true, retryable: false })
    expect(messages[0]?.text).toContain('Work Item "Release" is overdue.')
  })
  test('retries without sending when the recipient language cannot be read', async () => {
    const send = createEmailNotificationSender({
      sender: 'notify@example.test', appOrigin: 'https://app.example.test',
      readRecipient: async () => ({ kind: 'verified', address: 'member@example.test' }),
      readLocale: async () => { throw new Error('directory unavailable') },
      sendEmail: async () => { throw new Error('Must not send') },
    })
    expect(await send(delivery)).toEqual({ succeeded: false, retryable: true, code: 'NotificationLocaleUnavailable' })
  })
})
