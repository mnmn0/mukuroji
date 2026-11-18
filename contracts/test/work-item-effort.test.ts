import { describe, expect, test } from 'bun:test'
import {
  deriveWorkItemProgressPercent,
  deriveWorkItemRemainingEffortMinutes,
  isWorkItemEffortMinutes,
  isWorkItemProgressMode,
  isWorkItemProgressPercent,
  type WorkItemEffortFields,
} from '../src/work-item-effort'

/**
 * Builds Work Item effort fields for derivation tests.
 *
 * @param overrides - Fields replacing the started, unestimated defaults.
 * @returns Effort fields of one Work Item.
 */
function item(overrides: Partial<WorkItemEffortFields> = {}): WorkItemEffortFields {
  return { statusCategory: 'started', schedule: {}, ...overrides }
}

describe('Work Item effort contracts', () => {
  test('validates effort amounts, progress percentages, and progress modes', () => {
    expect([0, 1, 480].every(isWorkItemEffortMinutes)).toBe(true)
    expect([-1, 1.5, '60', null, Number.MAX_SAFE_INTEGER + 1].some(isWorkItemEffortMinutes)).toBe(false)
    expect([0, 50, 100].every(isWorkItemProgressPercent)).toBe(true)
    expect([-1, 101, 12.5, '50'].some(isWorkItemProgressPercent)).toBe(false)
    expect(['status-category', 'remaining-effort', 'manual'].every(isWorkItemProgressMode)).toBe(true)
    expect(isWorkItemProgressMode('points')).toBe(false)
  })

  test('derives remaining effort from the recorded value, then the canonical estimate', () => {
    expect(deriveWorkItemRemainingEffortMinutes(item({ schedule: { plannedEffortMinutes: 480 } }))).toBe(480)
    expect(deriveWorkItemRemainingEffortMinutes(item({ schedule: { plannedEffortMinutes: 480 }, remainingEffortMinutes: 60 }))).toBe(60)
    expect(deriveWorkItemRemainingEffortMinutes(item())).toBeUndefined()
    expect(deriveWorkItemRemainingEffortMinutes(item({ statusCategory: 'completed', remainingEffortMinutes: 60 }))).toBe(0)
    expect(deriveWorkItemRemainingEffortMinutes(item({ statusCategory: 'canceled', schedule: { plannedEffortMinutes: 60 } }))).toBe(0)
  })

  test('derives progress per mode and falls back to the status category when inputs are missing', () => {
    const estimated = item({ schedule: { plannedEffortMinutes: 400 }, remainingEffortMinutes: 100, progressPercent: 10 })
    expect(deriveWorkItemProgressPercent(estimated)).toBe(50)
    expect(deriveWorkItemProgressPercent(estimated, 'remaining-effort')).toBe(75)
    expect(deriveWorkItemProgressPercent(estimated, 'manual')).toBe(10)
    expect(deriveWorkItemProgressPercent(item({ schedule: { plannedEffortMinutes: 60 }, remainingEffortMinutes: 90 }), 'remaining-effort')).toBe(0)
    expect(deriveWorkItemProgressPercent(item({ remainingEffortMinutes: 30 }), 'remaining-effort')).toBe(50)
    expect(deriveWorkItemProgressPercent(item({ statusCategory: 'unstarted' }), 'manual')).toBe(0)
    expect(deriveWorkItemProgressPercent(item({ statusCategory: 'completed', progressPercent: 20 }), 'manual')).toBe(100)
    expect(deriveWorkItemProgressPercent(item({ statusCategory: 'canceled' }))).toBeUndefined()
  })
})
