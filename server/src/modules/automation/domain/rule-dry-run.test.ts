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

test('includes the assignee of the tested Work Item in an assignee notification', () => {
  const result = dryRunAutomationRule({
    name: 'Due soon',
    enabled: false,
    trigger: { type: 'status' },
    actions: [{ type: 'notify', recipientMemberKeys: ['member-1'], notifyAssignee: true, title: 'Due' }],
  }, 'workspace-1', { id: 'item-1', assigneeUserId: 'member-2' })

  expect(result.actions).toEqual([{ index: 0, type: 'notify', recipientMemberKeys: ['member-1', 'member-2'] }])
})

test('notifies the assignee the Work Item had when the rule fired, like execution', () => {
  const result = dryRunAutomationRule({
    name: 'Reassign and notify',
    enabled: false,
    trigger: { type: 'status' },
    actions: [
      { type: 'assign', assigneeMemberKey: 'member-3' },
      { type: 'notify', recipientMemberKeys: [], notifyAssignee: true, title: 'Assigned' },
    ],
  }, 'workspace-1', { id: 'item-1', assigneeUserId: 'member-2' })

  expect(result.actions[1]).toEqual({ index: 1, type: 'notify', recipientMemberKeys: ['member-2'] })
})
