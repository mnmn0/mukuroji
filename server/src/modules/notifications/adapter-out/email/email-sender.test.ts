import { describe, expect, test } from 'bun:test'
import type { ChannelDelivery } from '../../application/channel-delivery'
import { createEmailDigestSender, createEmailNotificationSender, renderEmailNotification, type EmailMessage, type EmailRecipientLookup } from './email-sender'
import { hashEmailAddress, type EmailSuppression } from '../../domain/email-suppression'

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

describe('Email digest sender and suppression', () => {
  const second: ChannelDelivery = {
    ...delivery, notificationKey: 'key-2',
    notification: { ...delivery.notification, id: 'notification-2', eventId: 'event-2', title: 'Approve budget', summary: undefined,
      deepLink: '/projects/p-1', occurredAt: '2026-09-26T10:00:00.000Z' },
  }

  /** Creates a digest sender with a verified address and an optional stored suppression. */
  function digestSender(suppression?: EmailSuppression | Error) {
    const messages: EmailMessage[] = []
    const options = {
      sender: 'notify@example.test', appOrigin: 'https://app.example.test',
      readRecipient: async (): Promise<EmailRecipientLookup> => ({ kind: 'verified', address: 'Member@Example.test' }),
      readSuppression: async () => { if (suppression instanceof Error) throw suppression; return suppression },
      sendEmail: async (message: EmailMessage) => { messages.push(message) },
    }
    return { digest: createEmailDigestSender(options), single: createEmailNotificationSender(options), messages }
  }

  test('lists every notification oldest first in one bilingual message tagged with the recipient', async () => {
    const f = digestSender()
    expect(await f.digest([delivery, second])).toEqual({ succeeded: true, retryable: false })
    expect(f.messages).toHaveLength(1)
    const message = f.messages[0]!
    expect(message).toMatchObject({ to: 'Member@Example.test', recipientKey: 'workspace-1#member@example.test',
      subject: '[mukuroji] 通知のまとめ（2 件） / Notification digest (2)' })
    expect(message.text.indexOf('1. Approve budget')).toBeLessThan(message.text.indexOf('2. Review Bcc: attacker@example.test'))
    expect(message.text).toContain('   https://app.example.test/projects/p-1')
    expect(message.text).toContain('   https://app.example.test/teams/core/issues/CORE-1')
    expect(message.text).toContain('Turn Email off')
    expect(message.text.split('\n').some((line) => line.startsWith('Bcc:'))).toBe(false)
  })
  test('renders a digest of one as the ordinary message and rejects mixed recipients', async () => {
    const f = digestSender()
    await f.digest([delivery])
    expect(f.messages[0]?.subject).toBe('[mukuroji] Review Bcc: attacker@example.test')
    await expect(f.digest([delivery, { ...second, recipientKey: 'workspace-1#other@example.test' }])).rejects.toThrow()
    await expect(f.digest([])).rejects.toThrow()
  })
  test('suppresses only the address that bounced or complained, and retries when the suppression cannot be read', async () => {
    const bounced = digestSender({ addressHash: hashEmailAddress(' member@example.TEST '), reason: 'bounce', suppressedAt: '2026-09-26T11:30:00.000Z' })
    expect(await bounced.single(delivery)).toEqual({ succeeded: false, retryable: false, suppressed: true, code: 'EmailRecipientSuppressed' })
    expect(await bounced.digest([delivery, second])).toMatchObject({ suppressed: true, code: 'EmailRecipientSuppressed' })
    expect(bounced.messages).toEqual([])
    const changed = digestSender({ addressHash: hashEmailAddress('old@example.test'), reason: 'complaint', suppressedAt: '2026-09-26T11:30:00.000Z' })
    expect(await changed.single(delivery)).toEqual({ succeeded: true, retryable: false })
    expect(await digestSender(new Error('unavailable')).single(delivery)).toEqual({ succeeded: false, retryable: true, code: 'EmailSuppressionUnavailable' })
  })
})
