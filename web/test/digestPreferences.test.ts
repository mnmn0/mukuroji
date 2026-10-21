import { expect, test } from 'bun:test'
import type { UpdateFeedDigestPreferences } from '@mukuroji/contracts'
import { normalizeDigestPreferences, sameDigestPreferences } from '../src/features/update-feed/model/digestPreferences'

test('semantic source equality ignores selection order but preserves consent and collection revision', () => {
  const preferences: UpdateFeedDigestPreferences = { enabled: true, frequency: 'daily', views: ['at-risk', 'recent'], savedFeeds: { revision: 3, ids: ['z', 'a'] } }
  const before = structuredClone(preferences)
  const normalized = normalizeDigestPreferences(preferences)
  expect(normalized).toEqual({ enabled: true, frequency: 'daily', views: ['recent', 'at-risk'], savedFeeds: { revision: 3, ids: ['a', 'z'] } })
  expect(preferences).toEqual(before)
  expect(sameDigestPreferences(preferences, normalized)).toBe(true)
  expect(sameDigestPreferences(preferences, { ...normalized, savedFeeds: { revision: 4, ids: ['a', 'z'] } })).toBe(false)
  expect(sameDigestPreferences(preferences, { ...normalized, enabled: false })).toBe(false)
  expect(sameDigestPreferences(preferences, { ...normalized, frequency: 'weekly' })).toBe(false)
})
