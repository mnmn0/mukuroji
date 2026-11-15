import { describe, expect, test } from 'bun:test'
import { mutate } from 'swr'
import type { CanonicalWorkItem } from '@mukuroji/contracts'
import {
  assertConfirmedScheduleRevisionsObserved,
  findConfirmedItemsMovedOutOfList,
} from '../src/tasks/mutations/createTaskScheduleMutationController'
import {
  refreshScheduleConfirmationCache,
  revalidateScheduleConfirmationCachesBestEffort,
} from '../src/tasks/mutations/scheduleConfirmationCache'
import { createDefaultDueDateTaskSchedule } from '../src/tasks/model/taskSchedule'
import { taskViewStoryTasks } from '../src/tasks/ui/TaskView.stories.fixtures'

describe('schedule confirmation cache revalidation', () => {
  test('rejects an old 200 projection until every Team-qualified revision is observed', () => {
    const confirmedSchedules = [{
      dueDate: '2026-08-08',
      id: 'shared-id',
      revision: 4,
      schedule: createDefaultDueDateTaskSchedule('2026-08-08'),
      teamId: 'core-team',
    }]

    expect(() => assertConfirmedScheduleRevisionsObserved(
      [{ id: 'shared-id', revision: 10, teamId: 'other-team' }],
      confirmedSchedules,
      'Planning snapshot',
    )).toThrow('has not observed the confirmed schedule revisions yet')
    expect(() => assertConfirmedScheduleRevisionsObserved(
      [{ id: 'shared-id', revision: 4, teamId: 'core-team' }],
      confirmedSchedules,
      'Planning snapshot',
    )).not.toThrow()
  })

  test('restores committed state without rejecting after a failed GET', async () => {
    const refreshError = new Error('Project Work Item GET failed.')
    const observedErrors: unknown[] = []
    let preserveCount = 0
    let refreshCount = 0

    await revalidateScheduleConfirmationCachesBestEffort([
      {
        preserveConfirmedState: async () => {
          preserveCount += 1
        },
        refresh: async () => {
          refreshCount += 1
          throw refreshError
        },
      },
    ], (error) => {
      observedErrors.push(error)
    })

    expect(observedErrors).toEqual([refreshError])
    expect(preserveCount).toBe(2)
    expect(refreshCount).toBe(3)
  })

  test('retries a transient GET and restores committed state after success', async () => {
    const observedErrors: unknown[] = []
    let preserveCount = 0
    let refreshCount = 0

    await revalidateScheduleConfirmationCachesBestEffort([
      {
        preserveConfirmedState: async () => {
          preserveCount += 1
        },
        refresh: async () => {
          refreshCount += 1
          if (refreshCount === 1) throw new Error('Transient Planning GET failure.')
        },
      },
    ], (error) => {
      observedErrors.push(error)
    })

    expect(observedErrors).toEqual([])
    expect(preserveCount).toBe(2)
    expect(refreshCount).toBe(2)
  })

  test('retries explicit GET failures and stale responses before publishing through SWR', async () => {
    const cacheKey = `schedule-confirmation-refresh:${crypto.randomUUID()}`
    const transientError = new Error('Transient Planning GET failure.')
    const observedErrors: unknown[] = []
    let readCount = 0

    await mutate(cacheKey, { revision: 1 }, { revalidate: false })
    await revalidateScheduleConfirmationCachesBestEffort([
      {
        preserveConfirmedState: async () => undefined,
        refresh: () => refreshScheduleConfirmationCache(
          async () => {
            readCount += 1
            if (readCount === 1) throw transientError
            return { revision: readCount === 2 ? 1 : 2 }
          },
          (value) => {
            if (value.revision < 2) throw new Error('Planning snapshot is still stale.')
          },
          (value) => mutate(cacheKey, value, { revalidate: false }),
        ),
      },
    ], (error) => {
      observedErrors.push(error)
    })

    expect(observedErrors).toEqual([])
    expect(readCount).toBe(3)
    await expect(mutate(cacheKey)).resolves.toEqual({ revision: 2 })
  })

  test('excuses only confirmed items that a newer revision moved out of a windowed list', async () => {
    const confirmed = (id: string) => ({
      assignedProjectId: 'launch',
      dueDate: '2026-11-10',
      id,
      revision: 6,
      schedule: createDefaultDueDateTaskSchedule('2026-11-10'),
      teamId: 'core-team',
    })
    const current: Record<string, Pick<CanonicalWorkItem, 'assignedProjectId' | 'revision' | 'schedule'>> = {
      // Moved to December by a later update.
      'moved-later': {
        assignedProjectId: 'launch',
        revision: 7,
        schedule: createDefaultDueDateTaskSchedule('2026-12-10'),
      },
      // Still in November: the list is stale, not the item.
      'stale-list': {
        assignedProjectId: 'launch',
        revision: 6,
        schedule: createDefaultDueDateTaskSchedule('2026-11-10'),
      },
      // Moved to another Project by a later update.
      reassigned: {
        assignedProjectId: 'other',
        revision: 8,
        schedule: createDefaultDueDateTaskSchedule('2026-11-10'),
      },
    }
    const reads: string[] = []
    const movedAway = await findConfirmedItemsMovedOutOfList({
      expected: ['listed', 'moved-later', 'stale-list', 'reassigned'].map(confirmed),
      listedTasks: [{ id: 'listed', teamId: 'core-team' }],
      projectId: 'launch',
      readCurrent: async (item) => {
        reads.push(item.id)
        const state = current[item.id]
        if (!state) throw new Error(`Unexpected detail read: ${item.id}`)
        const base: CanonicalWorkItem = taskViewStoryTasks[0]!
        return { ...base, id: item.id, teamId: item.teamId, ...state }
      },
      scheduleWindow: { from: '2026-11-01', to: '2026-11-30' },
    })

    expect(reads).toEqual(['moved-later', 'stale-list', 'reassigned'])
    expect([...movedAway]).toEqual([
      JSON.stringify(['core-team', 'moved-later']),
      JSON.stringify(['core-team', 'reassigned']),
    ])
  })
})
