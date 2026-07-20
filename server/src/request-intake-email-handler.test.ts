import { afterEach, expect, test } from 'bun:test'
import type { RequestEmailEnvelope, RequestRequesterReplyReceipt } from '@mukuroji/contracts'
import type { RequestIntakeClient } from './request-intake'
import {
  REQUEST_EMAIL_SIGNATURE_TOLERANCE_SECONDS,
  configureRequestEmailClientForTest,
  createRequestEmailSignature,
  handler,
  resetRequestEmailClientForTest,
  validateSignedEmailEvent,
} from './request-intake-email-handler'

const secret = 'request-email-handler-test-secret-000000000000'
const timestamp = 1_784_191_200
const now = new Date(timestamp * 1_000)
const envelope = {
  threadToken: 'T'.repeat(43),
  messageId: '<message-1@example.com>',
  fromAddress: 'requester@example.com',
  subject: 'Re: request details',
  textBody: 'Here is the requested information.',
  receivedAt: now.toISOString(),
} satisfies RequestEmailEnvelope

const originalSecret = Bun.env.REQUEST_EMAIL_WEBHOOK_SECRET

afterEach(() => {
  resetRequestEmailClientForTest()
  if (originalSecret === undefined) {
    delete Bun.env.REQUEST_EMAIL_WEBHOOK_SECRET
  } else {
    Bun.env.REQUEST_EMAIL_WEBHOOK_SECRET = originalSecret
  }
})

test('accepts a fresh deterministic HMAC regardless of envelope key insertion order', () => {
  const signature = createRequestEmailSignature(timestamp, envelope, secret)
  const reorderedEnvelope: RequestEmailEnvelope = {
    receivedAt: envelope.receivedAt,
    textBody: envelope.textBody,
    fromAddress: envelope.fromAddress,
    messageId: envelope.messageId,
    threadToken: envelope.threadToken,
    subject: envelope.subject,
  }
  expect(createRequestEmailSignature(timestamp, reorderedEnvelope, secret)).toBe(signature)
  expect(() => validateSignedEmailEvent({ timestamp, envelope, signature }, secret, now))
    .not.toThrow()
})

test('rejects tampered, malformed, and expired email signatures', () => {
  const signature = createRequestEmailSignature(timestamp, envelope, secret)
  expect(() => validateSignedEmailEvent({
    timestamp,
    envelope: { ...envelope, textBody: 'Tampered body.' },
    signature,
  }, secret, now)).toThrow('Email event signature is invalid.')
  expect(() => validateSignedEmailEvent({
    timestamp,
    envelope,
    signature: 'not-hex',
  }, secret, now)).toThrow('Email event signature is invalid.')
  expect(() => validateSignedEmailEvent({ timestamp, envelope, signature }, secret, new Date(
    (timestamp + REQUEST_EMAIL_SIGNATURE_TOLERANCE_SECONDS + 1) * 1_000,
  ))).toThrow('Email event signature has expired.')
})

test('requires a sufficiently long email webhook secret', () => {
  expect(() => createRequestEmailSignature(timestamp, envelope, 'too-short'))
    .toThrow('REQUEST_EMAIL_WEBHOOK_SECRET must contain at least 32 characters.')
})

test('invokes the ingestion client only after validating the configured signature', async () => {
  Bun.env.REQUEST_EMAIL_WEBHOOK_SECRET = secret
  const currentTimestamp = Math.floor(Date.now() / 1_000)
  const calls: RequestEmailEnvelope[] = []
  const receipt: RequestRequesterReplyReceipt = {
    replyId: 'reply-1',
    receivedAt: now.toISOString(),
  }
  configureRequestEmailClientForTest({
    async ingestEmail(input) {
      calls.push(input)
      return receipt
    },
  } as RequestIntakeClient)
  const signature = createRequestEmailSignature(currentTimestamp, envelope, secret)

  await expect(handler({ timestamp: currentTimestamp, envelope, signature })).resolves.toEqual(receipt)
  expect(calls).toEqual([envelope])

  await expect(handler({
    timestamp: currentTimestamp,
    envelope: { ...envelope, textBody: 'Tampered body.' },
    signature,
  })).rejects.toMatchObject({ status: 401, code: 'RequestEmailSignatureInvalid' })
  expect(calls).toEqual([envelope])
})
