import { describe, expect, test } from 'bun:test'
import { mergeAnalyticsAssigneeDraft } from '../src/analytics/model/assigneeFilter'

describe('mergeAnalyticsAssigneeDraft', () => {
  test('keeps all assignees when nothing was filtered and nothing is typed', () => {
    expect(mergeAnalyticsAssigneeDraft(undefined, [], '', '')).toBeUndefined()
  })

  test('keeps an empty selection apart from all assignees', () => {
    expect(mergeAnalyticsAssigneeDraft([], [], '', '')).toEqual([])
  })

  test('combines picked members with typed assignees', () => {
    expect(mergeAnalyticsAssigneeDraft(['alice'], ['alice'], 'former, former', ''))
      .toEqual(['alice', 'former'])
  })

  test('drops an assignee the user removed from the text after members arrived', () => {
    // Alice was in the text before members loaded; the user replaced her with Bob.
    expect(mergeAnalyticsAssigneeDraft(['alice'], ['alice'], 'bob', 'alice')).toEqual(['bob'])
  })
})
