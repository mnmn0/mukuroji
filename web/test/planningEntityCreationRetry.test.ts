import { describe, expect, test } from 'bun:test'
import { PlanningApiError } from '../src/planning/api/errors'
import {
  createPlanningEntityCreationRetryTracker,
  isUncertainPlanningEntityCreationFailure,
} from '../src/planning/mutations/entityCreationRetry'

describe('createPlanningEntityCreationRetryTracker', () => {
  test('keeps the first revision for retries while the outcome is unknown', async () => {
    const tracker = createPlanningEntityCreationRetryTracker()
    expect(tracker.resolveRevision('create', 4)).toBe(4)

    await expect(tracker.track('create', 4, async () => {
      throw new TypeError('Failed to fetch')
    })).rejects.toThrow('Failed to fetch')
    // A refreshed snapshot must not change the body of the retry.
    expect(tracker.resolveRevision('create', 7)).toBe(4)
    expect(tracker.resolveRevision('other', 7)).toBe(7)

    await expect(tracker.track('create', 4, async () => 'created')).resolves.toBe('created')
    expect(tracker.resolveRevision('create', 7)).toBe(7)
  })

  test('forgets the revision after a definite rejection', async () => {
    const tracker = createPlanningEntityCreationRetryTracker()
    await expect(tracker.track('create', 4, async () => {
      throw new PlanningApiError(409, 'Stale.', 'PlanningRevisionConflict')
    })).rejects.toBeInstanceOf(PlanningApiError)
    expect(tracker.resolveRevision('create', 7)).toBe(7)
  })
})

describe('isUncertainPlanningEntityCreationFailure', () => {
  test('treats server, transport, and in-progress failures as unknown outcomes', () => {
    expect(isUncertainPlanningEntityCreationFailure(new TypeError('Failed to fetch'))).toBe(true)
    expect(isUncertainPlanningEntityCreationFailure(new PlanningApiError(503, 'Down.'))).toBe(true)
    expect(isUncertainPlanningEntityCreationFailure(
      new PlanningApiError(409, 'Running.', 'PlanningEntityIdempotencyInProgress'),
    )).toBe(true)
    expect(isUncertainPlanningEntityCreationFailure(
      new PlanningApiError(400, 'Invalid.', 'PlanningTitleInvalid'),
    )).toBe(false)
  })
})
