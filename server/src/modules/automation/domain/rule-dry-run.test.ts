import { expect, test } from 'bun:test'
import { dryRunAutomationRule } from './rule-dry-run'

test('plans each action against the Work Item the earlier actions leave', () => {
  const result = dryRunAutomationRule({
    name: 'Bounce priority',
    enabled: false,
    trigger: { type: 'status', toStatusId: 'done' },
    actions: [
      { type: 'update', patch: { priority: 'high' } },
      { type: 'update', patch: { priority: 'low' } },
      { type: 'update', patch: { priority: 'low' } },
    ],
  }, 'workspace-1', { id: 'item-1', priority: 'low' })

  expect(result.actions.map((action) => action.changes)).toEqual([
    [{ field: 'priority', before: 'low', after: 'high' }],
    [{ field: 'priority', before: 'high', after: 'low' }],
    [],
  ])
})

test('flags conditions that read the trigger event and runs no action when they do not match', () => {
  const result = dryRunAutomationRule({
    name: 'Needs reason',
    enabled: false,
    trigger: { type: 'status' },
    conditions: [{ type: 'field', field: 'event.metadata.reason', operator: 'exists' }],
    actions: [{ type: 'comment', body: 'Hello' }],
  }, 'workspace-1', { id: 'item-1' })

  expect(result).toEqual({
    matched: false,
    triggerType: 'status',
    conditions: [{ index: 0, matched: false, readsEventFields: true }],
    actions: [],
  })
})
