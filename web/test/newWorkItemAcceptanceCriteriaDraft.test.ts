import { expect, test } from 'bun:test'
import {
  createNewWorkItemAcceptanceCriteriaDraft,
  keepInheritedAcceptanceCriteria,
} from '../src/work-items/ui/useAcceptanceCriteriaDraft'

test('starts a create draft with the inherited criteria as open rows', () => {
  expect(createNewWorkItemAcceptanceCriteriaDraft([])).toEqual({ nextRowNumber: 1 })
  expect(createNewWorkItemAcceptanceCriteriaDraft(['Tests pass'])).toEqual({
    rows: [{ key: 'new-1', text: 'Tests pass', satisfied: false }],
    nextRowNumber: 2,
  })
})

test('restores the inherited criteria when a create draft edit is canceled', () => {
  const edited = { rows: [{ key: 'new-3', text: 'Edited', satisfied: false }], nextRowNumber: 4 }

  expect(keepInheritedAcceptanceCriteria(edited, ['Tests pass'])).toBe(edited)
  expect(keepInheritedAcceptanceCriteria({ nextRowNumber: 4 }, ['Tests pass'])).toEqual({
    rows: [{ key: 'new-1', text: 'Tests pass', satisfied: false }],
    nextRowNumber: 4,
  })
  expect(keepInheritedAcceptanceCriteria({ nextRowNumber: 4 }, [])).toEqual({ nextRowNumber: 4 })
})
