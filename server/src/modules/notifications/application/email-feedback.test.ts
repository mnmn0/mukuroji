import { describe, expect, test } from 'bun:test'
import { drainEmailFeedback, parseEmailFeedback, type EmailFeedbackMessage } from './email-feedback'
import { decodeEmailRecipientTag, encodeEmailRecipientTag, hashEmailAddress, type EmailSuppression } from '../domain/email-suppression'

const recipientKey = 'workspace-1#member@example.test'
const tag = encodeEmailRecipientTag(recipientKey)

/** Builds an EventBridge SES event with the given type-specific fields. */
function sesEvent(detail: Record<string, unknown>, tags: Record<string, unknown> = { 'mukuroji-recipient': [tag] }): string {
  return JSON.stringify({
    source: 'aws.ses', 'detail-type': 'Email Bounced',
    detail: { mail: { timestamp: '2026-09-26T11:59:00.000Z', tags: { 'ses:configuration-set': ['set'], ...tags } }, ...detail },
  })
}

const permanentBounce = sesEvent({
  eventType: 'Bounce',
  bounce: { bounceType: 'Permanent', timestamp: '2026-09-26T12:00:00.000Z', bouncedRecipients: [{ emailAddress: 'Member <Member@Example.test>' }] },
})

describe('Email feedback parsing', () => {
  test('suppresses the tagged recipient on a permanent bounce or a complaint, storing only the address hash', () => {
    expect(parseEmailFeedback(permanentBounce)).toEqual({
      kind: 'suppress', recipientKey,
      suppression: { addressHash: hashEmailAddress('member@example.test'), reason: 'bounce', suppressedAt: '2026-09-26T12:00:00.000Z' },
    })
    const complaint = parseEmailFeedback(JSON.stringify({
      notificationType: 'Complaint', mail: { timestamp: '2026-09-26T11:59:00.000Z', tags: { 'mukuroji-recipient': [tag] } },
      complaint: { complainedRecipients: [{ emailAddress: 'member@example.test' }] },
    }))
    expect(complaint).toMatchObject({ kind: 'suppress', suppression: { reason: 'complaint', suppressedAt: '2026-09-26T11:59:00.000Z' } })
  })
  test('ignores transient bounces, not-spam feedback, other event types, and mail without the recipient tag', () => {
    for (const body of [
      sesEvent({ eventType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'member@example.test' }] } }),
      sesEvent({ eventType: 'Complaint', complaint: { complaintFeedbackType: 'not-spam', complainedRecipients: [] } }),
      sesEvent({ eventType: 'Delivery', delivery: {} }),
      sesEvent({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'member@example.test' }] } }, {}),
    ]) expect(parseEmailFeedback(body)).toEqual({ kind: 'ignore' })
  })
  test('flags malformed events for the dead-letter queue', () => {
    for (const body of [
      'not json', '[]', JSON.stringify({ source: 'aws.ses', detail: {} }),
      sesEvent({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [] } }),
      sesEvent({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@x' }, { emailAddress: 'b@x' }] } }),
      sesEvent({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'member@example.test' }] } }, { 'mukuroji-recipient': ['%%'] }),
    ]) expect(parseEmailFeedback(body)).toEqual({ kind: 'invalid' })
  })
  test('round-trips recipient tags and rejects values that are not one', () => {
    expect(tag).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeEmailRecipientTag(tag)).toBe(recipientKey)
    for (const value of [encodeEmailRecipientTag('no-separator'), encodeEmailRecipientTag('#member'), `${tag}=`, 42]) {
      expect(decodeEmailRecipientTag(value)).toBeUndefined()
    }
  })
})

describe('Email feedback drain', () => {
  /** Creates a queue holding the given bodies and a recording store. */
  function drainFixture(bodies: string[], failingStore = false) {
    const queued: EmailFeedbackMessage[] = bodies.map((body, index) => ({ handle: `h-${index}`, body }))
    const acknowledged: string[] = []
    const recorded: Array<{ recipientKey: string, suppression: EmailSuppression }> = []
    const events: string[] = []
    let received = false
    const dependencies = {
      queue: {
        receive: async () => { if (received) return []; received = true; return queued },
        acknowledge: async (messages: EmailFeedbackMessage[]) => { acknowledged.push(...messages.map((message) => message.handle)) },
      },
      store: { record: async (key: string, suppression: EmailSuppression) => {
        if (failingStore) throw new Error('unavailable')
        recorded.push({ recipientKey: key, suppression })
      } },
      telemetry: { reportSuppression: (reason: string) => { events.push(reason) }, reportInvalid: () => { events.push('invalid') } },
      now: () => new Date('2026-09-26T12:00:00.000Z'),
    }
    return { dependencies, acknowledged, recorded, events }
  }

  test('records suppressions, acknowledges handled messages, and leaves malformed ones queued', async () => {
    const f = drainFixture([permanentBounce, 'not json', sesEvent({ eventType: 'Delivery' })])
    expect(await drainEmailFeedback(f.dependencies)).toBe(1)
    expect(f.recorded.map((entry) => entry.recipientKey)).toEqual([recipientKey])
    expect(f.acknowledged).toEqual(['h-0', 'h-2'])
    expect(f.events).toEqual(['bounce', 'invalid'])
  })
  test('keeps a message queued and fails the run when the suppression cannot be written', async () => {
    const f = drainFixture([permanentBounce], true)
    await expect(drainEmailFeedback(f.dependencies)).rejects.toThrow('Email feedback processing requires attention.')
    expect(f.acknowledged).toEqual([])
  })
})
