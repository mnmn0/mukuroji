import { describe, expect, test } from 'bun:test'
import { isCanonicalWorkItemKey, parseWorkItemKey } from '@mukuroji/contracts'
import {
  createWorkItemKeyPrefixCandidates,
  deriveWorkItemKeyPrefix,
} from './work-item-key'

describe('Work Item key grammar', () => {
  test('parses keys case-insensitively into their canonical form', () => {
    expect(parseWorkItemKey(' abc-123 ')).toEqual({ prefix: 'ABC', number: 123, key: 'ABC-123' })
    expect(parseWorkItemKey('PT2-1')).toEqual({ prefix: 'PT2', number: 1, key: 'PT2-1' })
  })

  test.each([
    'A-1',
    'ABCDEFGHIJK-1',
    '1AB-1',
    'ABC-0',
    'ABC-01',
    'ABC-1000000000',
    'ABC_1',
    'ABC-1-2',
    'ＡＢＣ-1',
    '',
  ])('rejects %p', (value) => {
    expect(parseWorkItemKey(value)).toBeUndefined()
  })

  test('treats only the uppercase form as canonical', () => {
    expect(isCanonicalWorkItemKey('ABC-123')).toBe(true)
    expect(isCanonicalWorkItemKey('abc-123')).toBe(false)
    expect(isCanonicalWorkItemKey(123)).toBe(false)
  })
})

describe('Work Item key prefix derivation', () => {
  test.each([
    ['platform-team', 'PT'],
    ['customer-success-ops', 'CSO'],
    ['backend', 'BACK'],
    ['web', 'WEB'],
    ['team-1a2b3c4d5e6f', 'TEAM'],
    ['2026-roadmap', 'ROAD'],
    ['a', 'WI'],
    ['チーム', 'WI'],
  ])('derives a prefix from %p', (teamId, prefix) => {
    expect(deriveWorkItemKeyPrefix(teamId)).toBe(prefix)
    expect(parseWorkItemKey(`${prefix}-1`)?.prefix).toBe(prefix)
  })

  test('numbers the fallbacks and keeps them within the prefix length limit', () => {
    expect(createWorkItemKeyPrefixCandidates('platform-team', 3)).toEqual(['PT', 'PT2', 'PT3'])
    const candidates = createWorkItemKeyPrefixCandidates('backend', 20)
    expect(new Set(candidates).size).toBe(20)
    for (const candidate of candidates) {
      expect(parseWorkItemKey(`${candidate}-1`)?.prefix).toBe(candidate)
    }
  })
})
