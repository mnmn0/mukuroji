import { describe, expect, test } from 'bun:test'
import {
  revalidateScheduleConfirmationCachesBestEffort,
} from '../src/tasks/mutations/scheduleConfirmationCache'

describe('schedule confirmation cache revalidation', () => {
  test('restores committed state without rejecting after a failed GET', async () => {
    const refreshError = new Error('Project Work Item GET failed.')
    const observedErrors: unknown[] = []
    let preserveCount = 0

    await revalidateScheduleConfirmationCachesBestEffort([
      {
        preserveConfirmedState: async () => {
          preserveCount += 1
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
  })
})
