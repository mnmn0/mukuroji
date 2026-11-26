import { describe, expect, test } from 'bun:test'
import { readTimeBudget } from '../src/features/time-tracking/api/timeReport'

/** Project budget as the API returns it. */
const stored = {
  schemaVersion: 1,
  workspaceId: 'w',
  teamId: 't',
  scopeType: 'project',
  scopeId: 'p',
  amountMinor: 100_000,
  currency: 'JPY',
  revision: 1,
  updatedAt: '2026-11-26T00:00:00.000Z',
}

describe('budget alert percentage', () => {
  test('reads the alert percentage of a Project budget and refuses an invalid one', () => {
    expect(readTimeBudget({ ...stored, alertPercent: 80 })).toMatchObject({ alertPercent: 80 })
    expect(readTimeBudget(stored)).not.toHaveProperty('alertPercent')
    for (const alertPercent of [0, 1001, 12.5, '80']) {
      expect(readTimeBudget({ ...stored, alertPercent })).toBeUndefined()
    }
  })
})
