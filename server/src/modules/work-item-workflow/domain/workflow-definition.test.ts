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

  test('keeps transition actor roles and status required fields in display order, dropping empty lists', () => {
    expect(validateWorkflowDefinition({
      id: 'default',
      name: 'Default',
      initialStatusId: 'todo',
      statuses: [
        { id: 'todo', name: 'To do', category: 'unstarted', sortOrder: 0, requiredFields: [] },
        {
          id: 'done',
          name: 'Done',
          category: 'completed',
          sortOrder: 1,
          requiredFields: ['acceptance-criteria', 'due-date'],
          requiredCustomFieldIds: ['review-note'],
        },
      ],
      transitions: [
        { fromStatusId: 'todo', toStatusId: 'done', allowedActorRoles: ['assignee', 'project-manager'] },
        { fromStatusId: 'done', toStatusId: 'todo', allowedActorRoles: [] },
      ],
    })).toEqual({
      id: 'default',
      name: 'Default',
      initialStatusId: 'todo',
      statuses: [
        { id: 'todo', name: 'To do', category: 'unstarted', sortOrder: 0 },
        {
          id: 'done',
          name: 'Done',
          category: 'completed',
          sortOrder: 1,
          requiredFields: ['due-date', 'acceptance-criteria'],
          requiredCustomFieldIds: ['review-note'],
        },
      ],
      transitions: [
        { fromStatusId: 'todo', toStatusId: 'done', allowedActorRoles: ['project-manager', 'assignee'] },
        { fromStatusId: 'done', toStatusId: 'todo' },
      ],
    })
  })

  test('rejects unknown actor roles and required fields', () => {
    const base = {
      id: 'default',
      name: 'Default',
      initialStatusId: 'todo',
      statuses: [{ id: 'todo', name: 'To do', category: 'unstarted', sortOrder: 0 }],
      transitions: [],
    }
    expect(() => validateWorkflowDefinition({
      ...base,
      statuses: [
        ...base.statuses,
        { id: 'done', name: 'Done', category: 'completed', sortOrder: 1 },
      ],
      transitions: [{ fromStatusId: 'todo', toStatusId: 'done', allowedActorRoles: ['owner'] }],
    })).toThrow(WorkflowDefinitionValidationError)
    expect(() => validateWorkflowDefinition({
      ...base,
      statuses: [{ ...base.statuses[0], requiredFields: ['assignee'] }],
    })).toThrow(WorkflowDefinitionValidationError)
    expect(() => validateWorkflowDefinition({
      ...base,
      statuses: [{ ...base.statuses[0], requiredCustomFieldIds: ['a', 'a'] }],
    })).toThrow(WorkflowDefinitionValidationError)
  })
})
