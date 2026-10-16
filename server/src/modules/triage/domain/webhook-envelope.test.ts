import { expect, test } from 'bun:test'
import { readWebhookTriageEnvelope } from './webhook-envelope'

test('normalizes the envelope content', () => {
  expect(readWebhookTriageEnvelope({
    eventId: ' evt-1 ',
    title: ' Checkout errors ',
    body: 'Customers see 500.',
    requester: { name: 'Status page', email: ' Alerts@Example.com ' },
  })).toEqual({
    eventId: 'evt-1',
    title: 'Checkout errors',
    body: 'Customers see 500.',
    requesterDisplayName: 'Status page',
    requesterEmail: 'alerts@example.com',
  })
})

test('rejects routing, owner, and other fields the payload must not control', () => {
  const valid = { eventId: 'evt-1', title: 'T', body: 'B', requester: { name: 'N' } }
  for (const value of [
    { ...valid, teamId: 'other-team' },
    { ...valid, ownerUserId: 'someone@example.com' },
    { ...valid, requester: { name: 'N', guest: false } },
    { ...valid, title: ' ' },
    { ...valid, eventId: 1 },
    { ...valid, body: 'x'.repeat(8_001) },
    { ...valid, requester: { name: 'N', email: 'not-an-address' } },
    { ...valid, requester: { name: 'N', email: 'a b@example.com' } },
    [],
    null,
  ]) {
    expect(() => readWebhookTriageEnvelope(value)).toThrow()
  }
})
