import { describe, expect, test } from 'bun:test'
import { revalidatePlanningUpdateHistoryAfterPublish } from '../src/planning/queries/usePlanningUpdates'

describe('Planning update query coordination', () => {
  test('does not turn a post-publish history refresh failure into a publish failure', async () => {
    expect(await revalidatePlanningUpdateHistoryAfterPublish(
      async () => { throw new Error('history unavailable') },
    )).toBe(false)
    expect(await revalidatePlanningUpdateHistoryAfterPublish(
      async () => undefined,
    )).toBe(true)
  })
})
