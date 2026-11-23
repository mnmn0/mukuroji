import { describe, expect, test } from 'bun:test'
import { isSummaryMonth, shiftSummaryMonth, summaryMonthPeriod } from '../src/weekly-summaries'

describe('summary months', () => {
  test('accepts only calendar months', () => {
    expect(isSummaryMonth('2026-11')).toBe(true)
    for (const value of ['2026-00', '2026-13', '0999-01', '2026-1', '2026-11-01', 202611, undefined]) {
      expect(isSummaryMonth(value)).toBe(false)
    }
  })

  test('returns the first and last day, leap years included', () => {
    expect(summaryMonthPeriod('2026-11')).toEqual({ periodStart: '2026-11-01', periodEnd: '2026-11-30' })
    expect(summaryMonthPeriod('2028-02')).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-02-29' })
    expect(summaryMonthPeriod('2026-12')).toEqual({ periodStart: '2026-12-01', periodEnd: '2026-12-31' })
  })

  test('moves across years', () => {
    expect(shiftSummaryMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftSummaryMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftSummaryMonth('2026-11', 0)).toBe('2026-11')
  })
})
