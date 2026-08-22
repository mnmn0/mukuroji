import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  deriveWorkItemScheduleDueDate,
} from '@mukuroji/contracts'
import type { ProjectMemberRole } from '../src/projects/api'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import {
  countUniqueTeamMembers,
  createTeamMemberRows,
  createTeamProjectSummaries,
  type TeamProjectMemberAccess,
} from '../src/projects/model/teamInsights'
import type { CanonicalWorkItem } from '../src/tasks/api'
import { referoTaskFixtures } from '../src/tasks/fixtures'

const baseTask = referoTaskFixtures.find((task) => task.id === 'wireframe')
const coreTeam = projectDirectoryFixtures.find((team) => team.id === 'core-team')

if (!baseTask || !coreTeam) {
  throw new Error('Expected the shared Work Item and Team fixtures.')
}

/**
 * Creates a canonical Team Work Item fixture with focused overrides.
 *
 * @param overrides - Fields that differ from the shared base fixture.
 * @returns A complete CanonicalWorkItem fixture.
 */
function createTask(overrides: Omit<Partial<CanonicalWorkItem>, 'dueDate'>): CanonicalWorkItem {
  const schedule = overrides.schedule ?? baseTask.schedule
  return {
    ...baseTask,
    dueDate: deriveWorkItemScheduleDueDate(schedule),
    schedule,
    ...overrides,
  }
}

/**
 * Creates a Project-scoped member access fixture.
 *
 * @param projectId - Project that grants the member access.
 * @param projectName - User-facing Project name.
 * @param role - Member role within the Project.
 * @returns A TeamProjectMemberAccess fixture for the same person.
 */
function createMemberAccess(
  projectId: string,
  projectName: string,
  role: ProjectMemberRole,
): TeamProjectMemberAccess {
  return {
    member: {
      email: 'demo@example.com',
      id: 'demo@example.com',
      name: 'Demo User',
      role,
      updatedAt: '2026-07-20T00:00:00.000Z',
    },
    projectId,
    projectName,
  }
}

describe('Team insights model', () => {
  const referenceDate = new Date('2026-07-20T12:00:00.000Z')
  const memberAccesses = [
    createMemberAccess('refero', 'Refero', 'member'),
    createMemberAccess('product-roadmap', 'プロダクトロードマップ', 'manager'),
  ]

  test('deduplicates members and selects their strongest Project role', () => {
    const tasks = [
      createTask({
        assigneeEmail: 'demo@example.com',
        assigneeName: 'Demo User',
        assigneeUserId: 'demo@example.com',
        id: 'refero-task',
        schedule: createDefaultDueDateWorkItemSchedule('2026-07-21'),
        assignedProjectId: 'refero',
        teamId: 'core-team',
      }),
      createTask({
        assigneeEmail: 'demo@example.com',
        assigneeName: 'Demo User',
        assigneeUserId: 'demo@example.com',
        id: 'roadmap-task',
        assignedProjectId: 'product-roadmap',
        priority: 'high',
        schedule: createDefaultDueDateWorkItemSchedule('2026-07-19'),
        teamId: 'core-team',
      }),
      createTask({
        assigneeEmail: 'demo@example.com',
        assigneeUserId: 'demo@example.com',
        id: 'other-team-task',
        assignedProjectId: 'shared-launch',
        teamId: 'design-team',
      }),
    ]

    expect(countUniqueTeamMembers(memberAccesses)).toBe(1)
    expect(createTeamMemberRows(
      coreTeam.projects,
      tasks,
      memberAccesses,
      referenceDate,
      coreTeam.id,
    )).toEqual([
      expect.objectContaining({
        attentionTaskCount: 2,
        id: 'demo@example.com',
        nextDueDate: '2026-07-19',
        openTaskCount: 2,
        projectAccess: [
          expect.objectContaining({ projectId: 'refero', role: 'member' }),
          expect.objectContaining({ projectId: 'product-roadmap', role: 'manager' }),
        ],
        role: 'manager',
        taskCount: 2,
      }),
    ])
  })

  test('ignores unscheduled tasks when selecting a member next due date', () => {
    const tasks = [
      createTask({
        assignedProjectId: 'refero',
        assigneeEmail: 'demo@example.com',
        assigneeName: 'Demo User',
        assigneeUserId: 'demo@example.com',
        id: 'undated-task',
        priority: 'low',
        schedule: createDefaultUnscheduledWorkItemSchedule(),
        statusCategory: 'unstarted',
        teamId: 'core-team',
        workflowStatusId: 'todo',
      }),
      createTask({
        assignedProjectId: 'refero',
        assigneeEmail: 'demo@example.com',
        assigneeName: 'Demo User',
        assigneeUserId: 'demo@example.com',
        id: 'second-undated-task',
        priority: 'low',
        schedule: createDefaultUnscheduledWorkItemSchedule(),
        statusCategory: 'unstarted',
        teamId: 'core-team',
        workflowStatusId: 'todo',
      }),
      createTask({
        assignedProjectId: 'product-roadmap',
        assigneeEmail: 'demo@example.com',
        assigneeName: 'Demo User',
        assigneeUserId: 'demo@example.com',
        id: 'dated-task',
        priority: 'low',
        schedule: createDefaultDueDateWorkItemSchedule('2026-07-21'),
        statusCategory: 'unstarted',
        teamId: 'core-team',
        workflowStatusId: 'todo',
      }),
    ]

    expect(createTeamMemberRows(
      coreTeam.projects,
      tasks,
      memberAccesses,
      referenceDate,
      coreTeam.id,
    )[0]?.nextDueDate).toBe('2026-07-21')
  })

  test('builds Team-scoped Project summaries with member and next-action data', () => {
    const tasks = [
      createTask({
        assignedProjectId: 'refero',
        id: 'core-risk',
        priority: 'high',
        schedule: createDefaultDueDateWorkItemSchedule('2026-07-19'),
        teamId: 'core-team',
      }),
      createTask({
        assignedProjectId: 'refero',
        id: 'design-duplicate-project',
        priority: 'high',
        teamId: 'design-team',
      }),
    ]
    const summaries = createTeamProjectSummaries(
      coreTeam.projects,
      tasks,
      memberAccesses,
      referenceDate,
      coreTeam.id,
    )
    const refero = summaries.find((summary) => summary.id === 'refero')

    expect(refero).toEqual(expect.objectContaining({
      attentionTaskCount: 1,
      managerCount: 0,
      memberCount: 1,
      nextTask: expect.objectContaining({ id: 'core-risk' }),
      openTaskCount: 1,
    }))
  })
})
