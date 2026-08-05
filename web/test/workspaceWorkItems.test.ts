import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  deriveWorkItemScheduleDueDate,
} from '@mukuroji/contracts'
import type { ProjectTask } from '../src/tasks/api'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import {
  calculateWorkspaceActionScore,
  calculateWorkspaceProgress,
  createWorkspaceActionQueue,
  createWorkspacePortfolioProjects,
  createWorkspaceSummary,
  createWorkspaceTaskKey,
  isWorkspaceTaskAssignedToUser,
  parseWorkspaceTaskDueDate,
  resolveWorkspacePortfolioRisk,
} from '../src/work-items/model/workspaceWorkItems'

const baseTask = referoTaskFixtures.find((task) => task.id === 'wireframe')

if (!baseTask) {
  throw new Error('Expected the wireframe task fixture.')
}

/**
 * Creates a canonical Work Item fixture with focused field overrides.
 *
 * @param overrides - Fields that differ from the shared base fixture.
 * @returns A complete ProjectTask fixture.
 */
function createTask(overrides: Omit<Partial<ProjectTask>, 'dueDate'>): ProjectTask {
  const schedule = overrides.schedule ?? baseTask.schedule
  return {
    ...baseTask,
    dueDate: deriveWorkItemScheduleDueDate(schedule),
    schedule,
    ...overrides,
  }
}

describe('Workspace Work Item model', () => {
  const referenceDate = new Date('2026-07-20T12:00:00.000Z')

  test('orders action queue by score and due date using an explicit reference date', () => {
    const overdueHigh = createTask({
      id: 'overdue-high',
      priority: 'high',
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-01'),
      workflowStatusId: 'todo',
    })
    const approvalOverdue = createTask({
      approvalSummary: {
        approvedCount: 0,
        changesRequestedCount: 0,
        overdueCount: 1,
        pendingCount: 1,
        rejectedCount: 0,
      },
      id: 'approval-overdue',
      priority: 'low',
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-30'),
      statusCategory: 'completed',
      workflowStatusId: 'done',
    })
    const sameScoreEarlier = createTask({
      id: 'same-score-earlier',
      priority: 'medium',
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-21'),
      workflowStatusId: 'todo',
    })
    const sameScoreLater = createTask({
      id: 'same-score-later',
      priority: 'medium',
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-22'),
      workflowStatusId: 'todo',
    })

    expect(calculateWorkspaceActionScore(overdueHigh, referenceDate)).toBe(13)
    expect(calculateWorkspaceActionScore(approvalOverdue, referenceDate)).toBe(12)
    expect(createWorkspaceActionQueue([
      sameScoreLater,
      approvalOverdue,
      sameScoreEarlier,
      overdueHigh,
    ], referenceDate).map((task) => task.id)).toEqual([
      'overdue-high',
      'approval-overdue',
      'same-score-earlier',
      'same-score-later',
    ])
  })

  test('keeps Team identity in task keys and user assignment matching', () => {
    const coreTask = createTask({
      assignedProjectId: 'shared-launch',
      assigneeEmail: 'Person@Example.com',
      assigneeUserId: 'member-1',
      id: 'duplicate',
      teamId: 'core-team',
    })
    const designTask = createTask({
      assignedProjectId: 'shared-launch',
      id: 'duplicate',
      teamId: 'design-team',
    })

    expect(createWorkspaceTaskKey(coreTask)).not.toBe(createWorkspaceTaskKey(designTask))
    expect(isWorkspaceTaskAssignedToUser(coreTask, [' person@example.com '])).toBe(true)
    expect(isWorkspaceTaskAssignedToUser(coreTask, ['someone@example.com'])).toBe(false)
  })

  test('scopes duplicate Project IDs to their owning Team in portfolio rows', () => {
    const coreCompleted = createTask({
      assignedProjectId: 'shared-launch',
      id: 'core-completed',
      priority: 'low',
      statusCategory: 'completed',
      teamId: 'core-team',
      workflowStatusId: 'done',
    })
    const designRisk = createTask({
      assignedProjectId: 'shared-launch',
      id: 'design-risk',
      priority: 'high',
      statusCategory: 'started',
      teamId: 'design-team',
      workflowStatusId: 'active',
    })
    const rows = createWorkspacePortfolioProjects(
      projectDirectoryFixtures,
      [coreCompleted, designRisk],
    )
    const coreRow = rows.find((row) => row.id === 'core-team-shared-launch')
    const designRow = rows.find((row) => row.id === 'design-team-shared-launch')

    expect(coreRow?.progress).toBe(100)
    expect(coreRow?.risk).toBe('low')
    expect(designRow?.progress).toBe(0)
    expect(designRow?.risk).toBe('watch')
  })

  test('parses only exact ISO calendar dates', () => {
    const leapDay = parseWorkspaceTaskDueDate('2024-02-29')

    expect(leapDay?.getFullYear()).toBe(2024)
    expect(leapDay?.getMonth()).toBe(1)
    expect(leapDay?.getDate()).toBe(29)
    expect([
      '',
      '2023-02-29',
      '2026-02-30',
      '2026-04-31',
      '2026-13-01',
      '2026-7-20',
      '2026-07-20T00:00:00Z',
      '2026/07/20',
    ].map(parseWorkspaceTaskDueDate)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
  })

  test('does not report an empty Project portfolio as low risk', () => {
    expect(resolveWorkspacePortfolioRisk([])).toBe('clear')
  })

  test('creates summary and progress without transport-only metadata', () => {
    const completed = createTask({
      id: 'completed',
      priority: 'low',
      statusCategory: 'completed',
      workflowStatusId: 'done',
    })
    const openHigh = createTask({ id: 'open-high', priority: 'high' })

    expect(calculateWorkspaceProgress([completed, openHigh])).toBe(50)
    expect(createWorkspaceSummary(projectDirectoryFixtures, [completed, openHigh])).toEqual({
      blocked: 1,
      projects: 4,
      tasks: 1,
    })
  })
})
