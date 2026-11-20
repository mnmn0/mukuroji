import { describe, expect, test } from 'bun:test'
import {
  createAnalyticsPresetPeriod,
  findAnalyticsPeriodPreset,
  isAnalyticsPeriodPreset,
  type AnalyticsPeriodCalendar,
} from '../src/analytics/model/periodPresets'

/** April fiscal year and Sunday weeks, the settings the presets must follow. */
const aprilSundayCalendar: AnalyticsPeriodCalendar = { fiscalYearStartMonth: 4, weekStartDay: 0 }

describe('Analytics period presets', () => {
  test('lays out the fiscal year and quarter from the Workspace fiscal year start', () => {
    // 2026-11-20 05:00 UTC is 14:00 on Friday 2026-11-20 in Tokyo.
    const now = new Date('2026-11-20T05:00:00.000Z')
    expect(createAnalyticsPresetPeriod('this-fiscal-year', now, 'Asia/Tokyo', aprilSundayCalendar)).toEqual({
      from: '2026-03-31T15:00:00.000Z',
      to: '2027-03-31T14:59:59.999Z',
    })
    expect(createAnalyticsPresetPeriod('this-fiscal-quarter', now, 'Asia/Tokyo', aprilSundayCalendar)).toEqual({
      from: '2026-09-30T15:00:00.000Z',
      to: '2026-12-31T14:59:59.999Z',
    })
  })

  test('starts weeks on the Workspace week start day in the report time zone', () => {
    // 2026-11-21 16:00 UTC is still Saturday in UTC but already Sunday 2026-11-22 in Tokyo.
    const now = new Date('2026-11-21T16:00:00.000Z')
    expect(createAnalyticsPresetPeriod('this-week', now, 'UTC', aprilSundayCalendar)).toEqual({
      from: '2026-11-15T00:00:00.000Z',
      to: '2026-11-21T23:59:59.999Z',
    })
    expect(createAnalyticsPresetPeriod('this-week', now, 'Asia/Tokyo', aprilSundayCalendar)).toEqual({
      from: '2026-11-21T15:00:00.000Z',
      to: '2026-11-28T14:59:59.999Z',
    })
    expect(createAnalyticsPresetPeriod('last-week', now, 'Asia/Tokyo', aprilSundayCalendar)).toEqual({
      from: '2026-11-14T15:00:00.000Z',
      to: '2026-11-21T14:59:59.999Z',
    })
  })

  test('recognizes the preset that covers the same local dates and reports custom otherwise', () => {
    const now = new Date('2026-11-20T05:00:00.000Z')
    const quarter = createAnalyticsPresetPeriod('last-fiscal-quarter', now, 'Asia/Tokyo', aprilSundayCalendar)
    expect(findAnalyticsPeriodPreset(quarter, now, 'Asia/Tokyo', aprilSundayCalendar)).toBe('last-fiscal-quarter')
    expect(findAnalyticsPeriodPreset(
      { from: '2026-10-31T15:00:00.000Z', to: '2026-11-20T14:59:59.999Z' },
      now,
      'Asia/Tokyo',
      aprilSundayCalendar,
    )).toBeUndefined()
    expect(isAnalyticsPeriodPreset('this-fiscal-year')).toBeTrue()
    expect(isAnalyticsPeriodPreset('custom')).toBeFalse()
  })
})
