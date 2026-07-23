import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import type { MessageKey } from '../src/shared/i18n/i18n'
import {
  resolveWorkItemAssignee as resolveIssueWorkItemAssignee,
  resolveWorkItemTitle as resolveIssueWorkItemTitle,
} from '../src/issues/model/workItemDisplay'
import {
  createCustomFieldErrorMessages,
  filterWorkItemsByTeam,
  readSelectedRelationGraphRevision,
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../src/work-items/model/workItemDisplay'

describe('Work Item display helpers', () => {
  test('uses the canonical literal title', () => {
    expect(resolveWorkItemTitle(createCanonicalWorkItem())).toBe('Canonical title')
  })

  test('resolves the canonical assignee fallback order', () => {
    expect(resolveWorkItemAssignee(createCanonicalWorkItem({
      assigneeEmail: 'member@example.com',
      assigneeName: 'Member Name',
      assigneeUserId: 'member-id',
    }))).toBe('Member Name')
    expect(resolveWorkItemAssignee(createCanonicalWorkItem({
      assigneeEmail: 'member@example.com',
      assigneeName: undefined,
      assigneeUserId: 'member-id',
    }))).toBe('member@example.com')
    expect(resolveWorkItemAssignee(createCanonicalWorkItem({
      assigneeEmail: undefined,
      assigneeName: undefined,
      assigneeUserId: 'member-id',
    }))).toBe('member-id')
  })

  test('keeps the Issues display helper exports compatible', () => {
    const workItem = createCanonicalWorkItem({
      assigneeName: 'Member Name',
    })

    expect(resolveIssueWorkItemTitle(workItem)).toBe(resolveWorkItemTitle(workItem))
    expect(resolveIssueWorkItemAssignee(workItem)).toBe(resolveWorkItemAssignee(workItem))
  })

  test('filters project Work Items by the explicitly selected Team', () => {
    expect(filterWorkItemsByTeam([
      { id: 'issue-a', teamId: 'team-a' },
      { id: 'issue-b', teamId: 'team-b' },
    ], 'team-b')).toEqual([{ id: 'issue-b', teamId: 'team-b' }])
  })

  test('translates and combines custom field validation messages', () => {
    const definitions = [{
      id: 'estimate',
      name: 'Estimate',
      required: true,
      sortOrder: 0,
      type: 'number' as const,
    }]
    const errors = [
      { code: 'required' as const, fieldId: 'estimate' },
      { code: 'min' as const, fieldId: 'estimate' },
      { code: 'required' as const, fieldId: 'removed-field' },
    ]

    expect(createCustomFieldErrorMessages(errors, definitions, 'ja')).toEqual({
      estimate: '入力が必要です。 最小値以上で入力してください。',
    })
    expect(createCustomFieldErrorMessages(errors, definitions, 'en')).toEqual({
      estimate: 'A value is required. Enter a value at or above the minimum.',
    })
  })

  test('uses the active locale when relation graph detail is not loaded', () => {
    const translate = (key: MessageKey) =>
      key === 'workItems.relations.graphNotLoaded' ? '関係を再読み込みしてください。' : key

    expect(() => readSelectedRelationGraphRevision(undefined, 'issue-a', translate))
      .toThrow('関係を再読み込みしてください。')
    expect(readSelectedRelationGraphRevision({
      issue: { id: 'issue-a' },
      relationGraphRevision: 4,
    }, 'issue-a', translate)).toBe(4)
  })

})

function createCanonicalWorkItem(
  overrides: Partial<CanonicalWorkItem> = {},
): CanonicalWorkItem {
  return {
    assigneeUserId: 'member-id',
    creatorMemberKey: 'creator-id',
    createdAt: '2026-07-01T00:00:00.000Z',
    customFieldValues: {},
    dueDate: '2026/07/31',
    id: 'work-item-1',
    priority: 'medium',
    relationIds: [],
    revision: 1,
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    source: 'dynamodb',
    statusCategory: 'started',
    teamId: 'team-1',
    title: 'Canonical title',
    updatedAt: '2026-07-01T00:00:00.000Z',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'active',
    ...overrides,
  }
}
