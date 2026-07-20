import { describe, expect, test } from 'bun:test'
import {
  analyticsCalendarDateBoundaryToInstant,
  formatAnalyticsCalendarDate,
} from '../src/analytics/model/timeZone'

describe('Analytics calendar date boundaries', () => {
  test('converts an Asia/Tokyo local day to inclusive UTC instants', () => {
    expect(analyticsCalendarDateBoundaryToInstant(
      '2026-07-18',
      'Asia/Tokyo',
      'start',
    )).toBe('2026-07-17T15:00:00.000Z')
    expect(analyticsCalendarDateBoundaryToInstant(
      '2026-07-18',
      'Asia/Tokyo',
      'end',
    )).toBe('2026-07-18T14:59:59.999Z')
    expect(formatAnalyticsCalendarDate(
      '2026-07-17T15:00:00.000Z',
      'Asia/Tokyo',
    )).toBe('2026-07-18')
  })

  test('uses the 23-hour local day across a spring DST transition', () => {
    expect(analyticsCalendarDateBoundaryToInstant(
      '2026-03-08',
      'America/Los_Angeles',
      'start',
    )).toBe('2026-03-08T08:00:00.000Z')
    expect(analyticsCalendarDateBoundaryToInstant(
      '2026-03-08',
      'America/Los_Angeles',
      'end',
    )).toBe('2026-03-09T06:59:59.999Z')
  })

  test('uses the 25-hour local day across an autumn DST transition', () => {
    expect(analyticsCalendarDateBoundaryToInstant(
      '2026-11-01',
      'America/Los_Angeles',
      'start',
    )).toBe('2026-11-01T07:00:00.000Z')
    expect(analyticsCalendarDateBoundaryToInstant(
      '2026-11-01',
      'America/Los_Angeles',
      'end',
    )).toBe('2026-11-02T07:59:59.999Z')
  })
})
