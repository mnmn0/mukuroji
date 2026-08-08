import { describe, expect, test } from 'bun:test'
import { mutate } from 'swr'
import {
  assertConfirmedScheduleRevisionsObserved,
} from '../src/tasks/mutations/createTaskScheduleMutationController'
import {
  refreshScheduleConfirmationCache,
  revalidateScheduleConfirmationCachesBestEffort,
} from '../src/tasks/mutations/scheduleConfirmationCache'
import { createDefaultDueDateTaskSchedule } from '../src/tasks/model/taskSchedule'

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
})
