import { describe, expect, test } from 'bun:test'
import { hasWorkItemAcceptanceCriteria } from '@mukuroji/contracts'
import {
  WorkItemAcceptanceCriteriaError,
  applyAcceptanceCriteriaMarks,
  changesOnlyCriterionSatisfaction,
  normalizeAcceptanceCriteria,
} from './acceptance-criteria'

const existing = [
  { id: 'a'.repeat(32), text: 'Tests pass', satisfied: false },
  { id: 'b'.repeat(32), text: 'Docs updated', satisfied: true },
]

describe('acceptance criteria', () => {
  test('keeps existing IDs, assigns new ones, and trims text', () => {
    let next = 0
    const normalized = normalizeAcceptanceCriteria(
      [{ id: existing[1]?.id, text: 'Docs updated', satisfied: false }, { text: '  Deployed  ', satisfied: true }],
      { existing, createCriterionId: () => `${next++}`.padStart(32, 'f') },
    )
    expect(normalized).toEqual([
      { id: 'b'.repeat(32), text: 'Docs updated', satisfied: false },
      { id: `${'f'.repeat(31)}0`, text: 'Deployed', satisfied: true },
    ])
    expect(() => normalizeAcceptanceCriteria([{ id: 'c'.repeat(32), text: 'Invented' }], { existing, createCriterionId: () => 'x' }))
      .toThrow(WorkItemAcceptanceCriteriaError)
  })

  test('applies marks to the stored list and rejects marks that name no single criterion', () => {
    expect(applyAcceptanceCriteriaMarks([{ id: 'a'.repeat(32), satisfied: true }], existing)).toEqual([
      { ...existing[0], satisfied: true }, existing[1],
    ])
    for (const marks of [
      [],
      [{ id: 'c'.repeat(32), satisfied: true }],
      [{ id: 'a'.repeat(32), satisfied: true }, { id: 'a'.repeat(32), satisfied: false }],
      [{ id: 'a'.repeat(32), satisfied: 'yes' }],
      [{ id: 'a'.repeat(32), satisfied: true, text: 'Reworded' }],
      'a',
    ]) {
      expect(() => applyAcceptanceCriteriaMarks(marks, existing)).toThrow(WorkItemAcceptanceCriteriaError)
    }
  })

  test('tells a satisfaction-only change from an edit of the list', () => {
    const marked = existing.map((criterion) => ({ ...criterion, satisfied: !criterion.satisfied }))
    expect(changesOnlyCriterionSatisfaction(marked, existing)).toBe(true)
    expect(changesOnlyCriterionSatisfaction([...existing].reverse(), existing)).toBe(false)
    expect(changesOnlyCriterionSatisfaction([existing[0] ?? existing[1]], existing)).toBe(false)
    expect(changesOnlyCriterionSatisfaction(existing.map((criterion) => ({ ...criterion, text: `${criterion.text}!` })), existing)).toBe(false)
  })

  test('counts canonical criteria first and otherwise a non-empty custom field value', () => {
    expect(hasWorkItemAcceptanceCriteria({ acceptanceCriteria: existing })).toBe(true)
    expect(hasWorkItemAcceptanceCriteria({ customFieldValues: { acceptance: 'Ship it' } })).toBe(false)
    expect(hasWorkItemAcceptanceCriteria({ customFieldValues: { acceptance: 'Ship it' } }, 'acceptance')).toBe(true)
    expect(hasWorkItemAcceptanceCriteria({ customFieldValues: { acceptance: ['', 'Ship it'] } }, 'acceptance')).toBe(true)
    expect(hasWorkItemAcceptanceCriteria({ customFieldValues: { acceptance: '  ' } }, 'acceptance')).toBe(false)
    expect(hasWorkItemAcceptanceCriteria({ customFieldValues: { acceptance: 3 } }, 'acceptance')).toBe(false)
    expect(hasWorkItemAcceptanceCriteria({ customFieldValues: {} }, 'toString')).toBe(false)
  })
})
