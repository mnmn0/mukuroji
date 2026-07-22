import { describe, expect, test } from 'bun:test'
import {
  validateWorkflowDefinition,
  WorkflowDefinitionValidationError,
} from './workflow-definition'

describe('Work Item workflow definition domain', () => {
  test('normalizes a valid workflow without persistence dependencies', () => {
    expect(validateWorkflowDefinition({
      id: 'default',
      name: 'Default',
      initialStatusId: 'todo',
      statuses: [
        { id: 'todo', name: 'To do', category: 'unstarted', sortOrder: 0 },
        { id: 'done', name: 'Done', category: 'completed', sortOrder: 1 },
      ],
      transitions: [{ fromStatusId: 'todo', toStatusId: 'done' }],
    })).toMatchObject({
      id: 'default',
      initialStatusId: 'todo',
      statuses: [{ id: 'todo' }, { id: 'done' }],
    })
  })

  test('rejects transitions to undefined statuses with a stable pure error', () => {
    expect(() => validateWorkflowDefinition({
      id: 'default',
      name: 'Default',
      initialStatusId: 'todo',
      statuses: [
        { id: 'todo', name: 'To do', category: 'unstarted', sortOrder: 0 },
      ],
      transitions: [{ fromStatusId: 'todo', toStatusId: 'missing' }],
    })).toThrow(WorkflowDefinitionValidationError)
  })
})
