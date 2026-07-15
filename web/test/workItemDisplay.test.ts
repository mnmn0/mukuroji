import { describe, expect, test } from 'bun:test'
import type { MessageKey } from '../src/i18n'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../src/issues/workItemDisplay'
import {
  createCustomFieldErrorMessages,
  filterWorkItemsByTeam,
  readSelectedRelationGraphRevision,
} from '../src/work-items/workItemDisplay'

describe('Work Item display helpers', () => {
  test('prefers a literal title and translates titleKey only as a fallback', () => {
    const translate = (key: string) => `translated:${key}`

    expect(resolveWorkItemTitle({
      id: 'work-item-1',
      title: 'Canonical title',
      titleKey: 'tasks.item.wireframe',
    }, translate)).toBe('Canonical title')
    expect(resolveWorkItemTitle({
      id: 'work-item-1',
      titleKey: 'tasks.item.wireframe',
    }, translate)).toBe('translated:tasks.item.wireframe')
    expect(resolveWorkItemTitle({
      id: 'work-item-1',
      title: 'tasks.item.wireframe',
      titleKey: 'tasks.item.wireframe',
    }, translate)).toBe('translated:tasks.item.wireframe')
    expect(resolveWorkItemTitle({ id: 'work-item-1' }, translate)).toBe('work-item-1')
  })

  test('keeps the existing assignee fallback order and optional key translation', () => {
    expect(resolveWorkItemAssignee({
      assignee: 'Legacy assignee',
      assigneeEmail: 'member@example.com',
      assigneeKey: 'tasks.assignee.sato',
      assigneeName: 'Member Name',
      assigneeUserId: 'member-id',
    })).toBe('Member Name')
    expect(resolveWorkItemAssignee({
      assignee: 'Legacy assignee',
      assigneeKey: 'tasks.assignee.sato',
    })).toBe('Legacy assignee')
    expect(resolveWorkItemAssignee(
      { assigneeKey: 'tasks.assignee.sato' },
      (key) => `translated:${key}`,
    )).toBe('translated:tasks.assignee.sato')
    expect(resolveWorkItemAssignee({ assigneeKey: 'tasks.assignee.sato' }))
      .toBe('tasks.assignee.sato')
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
