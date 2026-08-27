import { describe, expect, test } from 'bun:test'
import {
  createEditableAiSearchFilters,
  hasReviewableAiSearchCustomFields,
  hasReviewableAiSearchFilterBounds,
  hasReviewableAiSearchFilters,
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
    }
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

  test('requires values for non-empty custom-field operators before applying', () => {
    expect(hasReviewableAiSearchCustomFields({
      customFields: [{ fieldId: 'risk', operator: 'equals' }],
    })).toBe(false)
    expect(hasReviewableAiSearchCustomFields({
      customFields: [{ fieldId: 'risk', operator: 'equals', value: 'high' }],
    })).toBe(true)
    expect(hasReviewableAiSearchCustomFields({
      customFields: [{ fieldId: 'risk', operator: 'is-empty' }],
    })).toBe(true)
    expect(hasReviewableAiSearchCustomFields({
      customFields: [{ fieldId: 'risk', operator: 'contains', value: '' }],
    })).toBe(false)
    expect(hasReviewableAiSearchCustomFields({
      customFields: [{ fieldId: 'risk', operator: 'contains', value: ['high', ' '] }],
    })).toBe(false)
    expect(hasReviewableAiSearchCustomFields({
      customFields: [{ fieldId: 'risk', operator: 'equals', value: '' }],
    })).toBe(false)
    expect(hasReviewableAiSearchCustomFields({
      customFields: [{ fieldId: 'risk', operator: 'not-equals', value: '   ' }],
    })).toBe(false)
  })

  test('rejects reversed or invalid edited date ranges before approval', () => {
    expect(hasReviewableAiSearchFilters({
      date: { field: 'updatedAt', from: '2026-08-31', to: '2026-08-01' },
    })).toBe(false)
    expect(hasReviewableAiSearchFilters({
      date: { field: 'updatedAt', from: '2026-02-29' },
    })).toBe(false)
    expect(hasReviewableAiSearchFilters({
      date: { field: 'updatedAt', from: '2028-02-29', to: '2028-03-01' },
    })).toBe(true)
    expect(hasReviewableAiSearchFilters({
      date: { field: 'updatedAt' },
    })).toBe(true)
  })

  test('keeps locally edited filters within the server contract before approval', () => {
    expect(hasReviewableAiSearchFilterBounds({ keyword: 'x'.repeat(257) })).toBe(false)
    expect(hasReviewableAiSearchFilterBounds({ statuses: Array.from({ length: 101 }, (_, index) => `status-${index}`) })).toBe(false)
    expect(hasReviewableAiSearchFilterBounds({ teamIds: [' team-with-padding '] })).toBe(false)
    expect(hasReviewableAiSearchFilterBounds({
      customFields: [{ fieldId: 'risk', operator: 'greater-than', value: 'high' }],
    })).toBe(false)
    expect(hasReviewableAiSearchFilters({
      customFields: [{ fieldId: 'risk', operator: 'greater-than', value: 3 }],
    })).toBe(true)
    expect(hasReviewableAiSearchFilterBounds({ statuses: ['in progress'] })).toBe(false)
    expect(hasReviewableAiSearchFilterBounds({ statuses: ['x'.repeat(129)] })).toBe(false)
    expect(hasReviewableAiSearchFilterBounds({
      teamIds: Array.from({ length: 20 }, (_, index) => `team-${index}-${'x'.repeat(400)}`),
    })).toBe(false)
  })

  test('parses repeated identifiers and supported custom values without widening the contract', () => {
    expect(parseAiSearchList('core, design, core')).toEqual(['core', 'design'])
    expect(parseAiSearchCustomFieldValue('["web","mobile"]')).toEqual(['web', 'mobile'])
    expect(parseAiSearchCustomFieldValue('true')).toBe(true)
    expect(parseAiSearchCustomFieldValue('12')).toBe(12)
    expect(parseAiSearchCustomFieldValue('1.5')).toBe(1.5)
    expect(parseAiSearchCustomFieldValue('01')).toBe('01')
    expect(parseAiSearchCustomFieldValue('1.0')).toBe('1.0')
    expect(parseAiSearchCustomFieldValue('-0')).toBe('-0')
    expect(parseAiSearchCustomFieldValue('1e3')).toBe('1e3')
    expect(parseAiSearchCustomFieldValue('0x1f')).toBe('0x1f')
    expect(parseAiSearchCustomFieldValue('9007199254740993')).toBe('9007199254740993')
  })
})
