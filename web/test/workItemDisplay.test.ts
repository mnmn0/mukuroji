import { describe, expect, test } from 'bun:test'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../src/issues/workItemDisplay'

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
})
