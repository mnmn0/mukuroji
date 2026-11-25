import { describe, expect, test } from 'bun:test'
import type { WorkflowDefinition } from '@mukuroji/contracts'
import { resolveConnectorStateStatus } from './connector-state-status'

const workflow: Pick<WorkflowDefinition, 'statuses' | 'transitions'> = {
  statuses: [
    { id: 'backlog', name: 'Backlog', category: 'backlog', sortOrder: 0 },
    { id: 'todo', name: 'Todo', category: 'unstarted', sortOrder: 1 },
    { id: 'doing', name: 'Doing', category: 'started', sortOrder: 2 },
    { id: 'shipped', name: 'Shipped', category: 'completed', sortOrder: 3 },
    { id: 'done', name: 'Done', category: 'completed', sortOrder: 4 },
    { id: 'dropped', name: 'Dropped', category: 'canceled', sortOrder: 5 },
  ],
  transitions: [
    { fromStatusId: 'todo', toStatusId: 'doing' },
    { fromStatusId: 'doing', toStatusId: 'done' },
    { fromStatusId: 'done', toStatusId: 'doing' },
    { fromStatusId: 'dropped', toStatusId: 'backlog' },
  ],
}

describe('connector state status', () => {
  test('keeps a status whose category already agrees with the resource', () => {
    expect(resolveConnectorStateStatus(workflow, 'doing', 'open')).toBeUndefined()
    expect(resolveConnectorStateStatus(workflow, 'done', 'closed')).toBeUndefined()
    expect(resolveConnectorStateStatus(workflow, 'dropped', 'closed')).toBeUndefined()
  })

  test('closes into the completed status the workflow allows from the current status', () => {
    expect(resolveConnectorStateStatus(workflow, 'doing', 'closed')).toBe('done')
  })

  test('reopens into the earliest reachable open category', () => {
    expect(resolveConnectorStateStatus(workflow, 'done', 'open')).toBe('doing')
    expect(resolveConnectorStateStatus(workflow, 'dropped', 'open')).toBe('backlog')
  })

  test('falls back to the first status of the category and leaves the rejection to the workflow rules', () => {
    expect(resolveConnectorStateStatus(workflow, 'todo', 'closed')).toBe('shipped')
  })
})
