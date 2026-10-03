import { expect, test } from 'bun:test'
import type { UpdateFeedDigestState } from '@mukuroji/contracts'
import { digestAttemptsExhausted } from '../src/features/update-feed/model/digestAttempts'

test('attempt cap follows cadence and UTC interval, preserves completed replay and ignores source edits', () => {
  const state: UpdateFeedDigestState = { revision: 4, preferences: { enabled: true, frequency: 'daily', views: ['recent'] }, history: [{ id: 'daily:2026-10-04', attempts: 3, status: 'failed', token: 'claim', count: 0, leaseUntil: 0 }] }
  expect(digestAttemptsExhausted(state, Date.parse('2026-10-04T23:59:59Z'))).toBe(true)
  state.preferences.views = ['for-me']
  expect(digestAttemptsExhausted(state, Date.parse('2026-10-04T23:59:59Z'))).toBe(true)
  expect(digestAttemptsExhausted(state, Date.parse('2026-10-05T00:00:00Z'))).toBe(false)
  state.preferences.frequency = 'weekly'
  expect(digestAttemptsExhausted(state, Date.parse('2026-10-04T23:59:59Z'))).toBe(false)
  state.history[0]!.id = 'weekly:2026-09-28'
  expect(digestAttemptsExhausted(state, Date.parse('2026-10-04T23:59:59Z'))).toBe(true)
  expect(digestAttemptsExhausted(state, Date.parse('2026-10-05T00:00:00Z'))).toBe(false)
  state.history[0]!.status = 'completed'
  expect(digestAttemptsExhausted(state, Date.parse('2026-10-04T23:59:59Z'))).toBe(false)
})
