import { expect, test } from 'bun:test'
import { normalizeExternalChatRetryAt } from './external-chat-retry-schedule'

const now = '2026-08-06T03:00:00.000Z'

test('keeps retry jitter deterministic while honoring a valid provider floor', () => {
  const providerRetryAt = '2026-08-06T03:05:00.000Z'
  const first = normalizeExternalChatRetryAt(now, 'operation-stable', providerRetryAt)
  const replay = normalizeExternalChatRetryAt(now, 'operation-stable', providerRetryAt)
  expect(first).toBe(replay)
  expect(first > providerRetryAt).toBe(true)
  expect(first <= '2026-08-07T03:00:00.000Z').toBe(true)
})

test('clamps a provider schedule at the maximum horizon after jitter', () => {
  const providerRetryAt = '2026-08-07T03:00:00.000Z'
  const retryAt = normalizeExternalChatRetryAt(now, 'operation-clamp', providerRetryAt)
  expect(retryAt).toBe(providerRetryAt)
})

test('replaces malformed, past, and unbounded provider schedules with a safe local delay', () => {
  for (const candidate of [
    'not-a-timestamp',
    '2026-08-06T02:59:59.999Z',
    '2027-08-06T03:00:00.000Z',
  ]) {
    const retryAt = normalizeExternalChatRetryAt(now, `operation-${candidate}`, candidate, 10_000)
    expect(retryAt > '2026-08-06T03:00:10.000Z').toBe(true)
    expect(retryAt < '2026-08-06T03:00:12.000Z').toBe(true)
  }
})

test('bounds invalid local fallbacks and rejects an invalid scheduler clock', () => {
  const retryAt = normalizeExternalChatRetryAt(now, 'operation-invalid-fallback', undefined, 0)
  expect(retryAt > '2026-08-06T03:00:30.000Z').toBe(true)
  expect(() => normalizeExternalChatRetryAt('invalid', 'operation-invalid-clock'))
    .toThrow('The retry scheduler clock is invalid.')
})
