import { describe, expect, test } from 'bun:test'
import type {
  ConfirmedWorkItemSchedule,
  PlanningSnapshot,
} from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import type { ProjectTask } from '../src/tasks/api'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import {
  applyConfirmedSchedulesToPlanningSnapshot,
  applyConfirmedSchedulesToTasks,
  revalidateScheduleConfirmationCachesBestEffort,
} from '../src/tasks/model/scheduleConfirmation'
import {
  createDefaultDateRangeTaskSchedule,
  createDefaultDueDateTaskSchedule,
} from '../src/tasks/model/taskSchedule'

describe('schedule confirmation cache projection', () => {
  test('applies every compact cascade result to task and Planning caches', () => {
    const directSchedule = createDefaultDateRangeTaskSchedule('2026-06-02', '2026-06-04')
    const propagatedSchedule = createDefaultDueDateTaskSchedule('2026-06-06')
    const confirmedSchedules = [
      {
        assignedProjectId: 'refero',
        dueDate: '2026-06-04',
        id: 'wireframe',
        revision: 2,
        schedule: directSchedule,
        teamId: 'core-team',
      },
      {
        assignedProjectId: 'refero',
        dueDate: '2026-06-06',
        id: 'brand-guideline',
        revision: 2,
        schedule: propagatedSchedule,
        teamId: 'core-team',
      },
    ] satisfies ConfirmedWorkItemSchedule[]
    const duplicateTeamTask = {
      ...referoTaskFixtures[0],
      assignedProjectId: 'brand-refresh',
      teamId: 'design-team',
    } satisfies ProjectTask
    const tasks = applyConfirmedSchedulesToTasks(
      [...referoTaskFixtures, duplicateTeamTask],
      confirmedSchedules,
    )

    expect(tasks.find((task) => task.id === 'wireframe' && task.teamId === 'core-team'))
      .toMatchObject({ dueDate: '2026-06-04', revision: 2, schedule: directSchedule })
    expect(tasks.find((task) => task.id === 'brand-guideline' && task.teamId === 'core-team'))
      .toMatchObject({ dueDate: '2026-06-06', revision: 2, schedule: propagatedSchedule })
    expect(tasks.find((task) => task.id === 'wireframe' && task.teamId === 'design-team'))
      .toBe(duplicateTeamTask)

    const planningSnapshot = {
      ...planningSnapshotFixture,
      workItems: referoTaskFixtures.slice(0, 2).map((task) => ({
        dueDate: task.dueDate,
        id: task.id,
        projectId: task.assignedProjectId,
        revision: task.revision,
        schedule: task.schedule,
        statusCategory: task.statusCategory,
        teamId: task.teamId,
        title: task.title,
      })),
    } satisfies PlanningSnapshot
    const updatedPlanningSnapshot = applyConfirmedSchedulesToPlanningSnapshot(
      planningSnapshot,
      confirmedSchedules,
    )

    expect(updatedPlanningSnapshot?.workItems).toEqual([
      expect.objectContaining({ dueDate: '2026-06-04', revision: 2, schedule: directSchedule }),
      expect.objectContaining({
        dueDate: '2026-06-06',
        revision: 2,
        schedule: propagatedSchedule,
      }),
    ])
  })

  test('keeps a newer cached revision while restoring committed state after a failed GET', async () => {
    const newerTask = {
      ...referoTaskFixtures[0],
      dueDate: '2026-06-10',
      revision: 3,
      schedule: createDefaultDueDateTaskSchedule('2026-06-10'),
    } satisfies ProjectTask
    const olderConfirmation = [{
      assignedProjectId: 'refero',
      dueDate: '2026-06-04',
      id: newerTask.id,
      revision: 2,
      schedule: createDefaultDateRangeTaskSchedule('2026-06-02', '2026-06-04'),
      teamId: newerTask.teamId,
    }] satisfies ConfirmedWorkItemSchedule[]
    const refreshError = new Error('Project Work Item GET failed.')
    const observedErrors: unknown[] = []
    let preserveCount = 0
    let preservedTasks: ProjectTask[] | undefined

    await revalidateScheduleConfirmationCachesBestEffort([
      {
        preserveConfirmedState: async () => {
          preserveCount += 1
          preservedTasks = applyConfirmedSchedulesToTasks([newerTask], olderConfirmation)
        },
        refresh: async () => {
          throw refreshError
        },
      },
    ], (error) => {
      observedErrors.push(error)
    })

    expect(observedErrors).toEqual([refreshError])
    expect(preserveCount).toBe(2)
    expect(preservedTasks).toEqual([newerTask])
  })
})
