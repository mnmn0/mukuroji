import { describe, expect, test } from 'bun:test'
import type { ProjectTask } from '../src/tasks/api'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { createDefaultDueDateTaskSchedule } from '../src/tasks/model/taskSchedule'
import {
  createWorkspaceInboxReasons,
  createWorkspaceInboxTasks,
} from '../src/notifications/model/workspaceInbox'

const baseTask = referoTaskFixtures.find((task) => task.id === 'wireframe')

if (!baseTask) {
  throw new Error('Expected the wireframe task fixture.')
}

/**
 * Creates a canonical Inbox Work Item fixture with focused overrides.
 *
 * @param overrides - Fields that differ from the shared base fixture.
 * @returns A complete ProjectTask fixture.
 */
function createTask(overrides: Partial<ProjectTask>): ProjectTask {
  return {
    ...baseTask,
    ...overrides,
  }
}

describe('Workspace Inbox model', () => {
  const referenceDate = new Date('2026-07-20T12:00:00.000Z')

  test('returns stable reason order and replaces generic approval with overdue approval', () => {
    const task = createTask({
      approvalSummary: {
        approvedCount: 0,
        changesRequestedCount: 0,
        overdueCount: 1,
        pendingCount: 2,
        rejectedCount: 0,
      },
      dueDate: '2026-07-01',
      priority: 'high',
      schedule: createDefaultDueDateTaskSchedule('2026-07-01'),
      workflowStatusId: 'review',
    })

    expect(createWorkspaceInboxReasons(task, referenceDate)).toEqual([
      'overdue',
      'high-priority',
      'review',
      'approval-overdue',
    ])
  })

  test('uses watch fallback for a queue item without a stronger reason', () => {
    const task = createTask({
      dueDate: '2026-07-30',
      priority: 'medium',
      schedule: createDefaultDueDateTaskSchedule('2026-07-30'),
      workflowStatusId: 'todo',
    })

    expect(createWorkspaceInboxReasons(task, referenceDate)).toEqual(['watch'])
  })

  test('includes only high, review, overdue, or approval-attention items', () => {
    const ordinary = createTask({
      dueDate: '2026-07-30',
      id: 'ordinary',
      priority: 'medium',
      schedule: createDefaultDueDateTaskSchedule('2026-07-30'),
      workflowStatusId: 'todo',
    })
    const highPriority = createTask({
      dueDate: '2026-07-30',
      id: 'high-priority',
      priority: 'high',
      schedule: createDefaultDueDateTaskSchedule('2026-07-30'),
      workflowStatusId: 'todo',
    })
    const review = createTask({
      dueDate: '2026-07-30',
      id: 'review',
      priority: 'low',
      schedule: createDefaultDueDateTaskSchedule('2026-07-30'),
      workflowStatusId: 'review',
    })
    const overdue = createTask({
      dueDate: '2026-07-19',
      id: 'overdue',
      priority: 'low',
      schedule: createDefaultDueDateTaskSchedule('2026-07-19'),
      workflowStatusId: 'todo',
    })
    const approval = createTask({
      approvalSummary: {
        approvedCount: 0,
        changesRequestedCount: 0,
        overdueCount: 0,
        pendingCount: 1,
        rejectedCount: 0,
      },
      dueDate: '2026-07-30',
      id: 'approval',
      priority: 'low',
      schedule: createDefaultDueDateTaskSchedule('2026-07-30'),
      workflowStatusId: 'todo',
    })

    expect(createWorkspaceInboxTasks([
      ordinary,
      highPriority,
      review,
      overdue,
      approval,
    ], referenceDate).map((task) => task.id).sort()).toEqual([
      'approval',
      'high-priority',
      'overdue',
      'review',
    ])
  })
})
