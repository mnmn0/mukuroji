import { describe, expect, test } from 'bun:test'
import { proposeCycleDateRange } from '../src/planning/model/cycles'

describe('proposed Cycle dates', () => {
  test('starts weekly Cycles on the next Workspace week start', () => {
    // 2026-11-18 is a Wednesday.
    expect(proposeCycleDateRange('2026-11-18', { count: 2, unit: 'week' }, 1))
      .toEqual({ endDate: '2026-12-06', startDate: '2026-11-23' })
    expect(proposeCycleDateRange('2026-11-18', { count: 1, unit: 'week' }, 0))
      .toEqual({ endDate: '2026-11-28', startDate: '2026-11-22' })
    expect(proposeCycleDateRange('2026-11-23', { count: 1, unit: 'week' }, 1))
      .toEqual({ endDate: '2026-11-29', startDate: '2026-11-23' })
  })

  test('starts monthly Cycles on the next first of the month', () => {
    expect(proposeCycleDateRange('2026-11-18', { count: 2, unit: 'month' }, 1))
      .toEqual({ endDate: '2027-01-31', startDate: '2026-12-01' })
    expect(proposeCycleDateRange('2026-12-01', { count: 1, unit: 'month' }, 1))
      .toEqual({ endDate: '2026-12-31', startDate: '2026-12-01' })
  })

  test('treats a count below one as one and caps a huge count', () => {
    expect(proposeCycleDateRange('2026-11-23', { count: 0, unit: 'week' }, 1))
      .toEqual({ endDate: '2026-11-29', startDate: '2026-11-23' })
    expect(proposeCycleDateRange('2026-11-23', { count: 1e12, unit: 'month' }, 1).endDate)
      .toBe('2110-03-31')
  })
})
