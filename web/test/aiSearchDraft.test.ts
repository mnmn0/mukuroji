import { describe, expect, test } from 'bun:test'
import {
  createEditableAiSearchFilters,
  normalizeAiSearchFilters,
  parseAiSearchCustomFieldValue,
  parseAiSearchList,
} from '../src/search/model/aiSearchDraft'

describe('AI Search draft model', () => {
  test('copies generated filters before local review edits', () => {
    const source = {
      entityTypes: ['work-item'],
      statuses: ['todo'],
      customFields: [{ fieldId: 'risk', operator: 'equals', value: ['high'] }],
    } as const
    const draft = createEditableAiSearchFilters(source)

    draft.statuses?.push('review')
    const firstCustomValue = draft.customFields?.[0]?.value
    if (Array.isArray(firstCustomValue)) firstCustomValue.push('critical')

    expect(source.statuses).toEqual(['todo'])
    expect(source.customFields[0].value).toEqual(['high'])
  })

  test('normalizes only the reviewed structured values at explicit apply time', () => {
    const filters = normalizeAiSearchFilters({
      keyword: '  launch review  ',
      statuses: ['todo', ' ', 'review'],
      teamIds: [],
      date: { field: 'updatedAt', from: '', to: '2026-08-31' },
    })

    expect(filters.keyword).toBe('launch review')
    expect(filters.statuses).toEqual(['todo', 'review'])
    expect(filters.teamIds).toBeUndefined()
    expect(filters.date).toEqual({ field: 'updatedAt', from: undefined, to: '2026-08-31' })
  })

  test('parses repeated identifiers and supported custom values without widening the contract', () => {
    expect(parseAiSearchList('core, design, core')).toEqual(['core', 'design'])
    expect(parseAiSearchCustomFieldValue('["web","mobile"]')).toEqual(['web', 'mobile'])
    expect(parseAiSearchCustomFieldValue('true')).toBe(true)
    expect(parseAiSearchCustomFieldValue('12')).toBe(12)
  })
})
