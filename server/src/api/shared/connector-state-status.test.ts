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
    expect(resolveConnectorStateStatus(workflow, 'doing', 'open')).toEqual({ kind: 'unchanged' })
    expect(resolveConnectorStateStatus(workflow, 'done', 'closed')).toEqual({ kind: 'unchanged' })
    expect(resolveConnectorStateStatus(workflow, 'dropped', 'closed')).toEqual({ kind: 'unchanged' })
  })

  test('closes into the completed status the workflow allows from the current status', () => {
    expect(resolveConnectorStateStatus(workflow, 'doing', 'closed')).toEqual({ kind: 'status', statusId: 'done' })
  })

  test('reopens into the earliest reachable open category', () => {
    expect(resolveConnectorStateStatus(workflow, 'done', 'open')).toEqual({ kind: 'status', statusId: 'doing' })
    expect(resolveConnectorStateStatus(workflow, 'dropped', 'open')).toEqual({ kind: 'status', statusId: 'backlog' })
  })

  test('reports a state the workflow cannot reach from the current status as unavailable', () => {
    expect(resolveConnectorStateStatus(workflow, 'todo', 'closed')).toEqual({ kind: 'unavailable' })
  })

  test('reports a state the workflow has no status for as unavailable', () => {
    const openOnly = { statuses: workflow.statuses.filter((status) => status.category !== 'completed'), transitions: [] }
    expect(resolveConnectorStateStatus(openOnly, 'doing', 'closed')).toEqual({ kind: 'unavailable' })
    const closedOnly = { statuses: workflow.statuses.filter((status) => status.category === 'completed'), transitions: [] }
    expect(resolveConnectorStateStatus(closedOnly, 'done', 'open')).toEqual({ kind: 'unavailable' })
  })
})
