import { describe, expect, test } from 'bun:test'
import {
  createUniqueTriageConfigurationId,
  replaceTriageRotationMembers,
} from '../src/triage/model/configurationDraft'

describe('Triage configuration drafts', () => {
  test('allocates a collision-resistant identifier after items are removed', () => {
    const suffixes = ['collision', 'new-policy']
    expect(createUniqueTriageConfigurationId(
      'sla',
      ['sla-collision', 'priority-chat'],
      () => suffixes.shift() ?? 'unexpected',
    )).toBe('sla-new-policy')
  })

  test('keeps the next member while normalizing a shrunken rotation', () => {
    const rotation = {
      id: 'support',
      memberUserIds: ['first@example.com', 'next@example.com'],
      name: 'Support',
      nextIndex: 1,
    }

    expect(replaceTriageRotationMembers(rotation, ['next@example.com']))
      .toEqual({
        ...rotation,
        memberUserIds: ['next@example.com'],
        nextIndex: 0,
      })
    expect(replaceTriageRotationMembers(rotation, ['first@example.com']))
      .toEqual({
        ...rotation,
        memberUserIds: ['first@example.com'],
        nextIndex: 0,
      })
  })
})
