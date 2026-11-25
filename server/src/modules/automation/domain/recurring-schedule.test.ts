import { describe, expect, test } from 'bun:test'
import type { RecurringSchedule } from '@mukuroji/contracts'
import {
  getBusinessDayWakeUp,
  getFirstRecurringWakeUp,
  getNextRecurringOccurrence,
  getRecurringOccurrences,
  selectCatchUpOccurrences,
  validateRecurringSchedule,
} from './recurring-schedule'

describe('Automation recurring schedule domain', () => {
  test('preserves bounded-integer messages at the extracted validation boundary', () => {
    expect(() => validateRecurringSchedule({
      frequency: 'daily',
      interval: 0,
      timeZone: 'UTC',
      localTime: '09:00',
      startDate: '2026-07-01',
      catchUpPolicy: 'latest',
    })).toThrow('Recurring interval must be an integer between 1 and 365.')
  })

  test('validates and normalizes weekly input without AWS or Hono', () => {
    expect(validateRecurringSchedule({
      frequency: 'weekly',
      interval: 1,
      timeZone: 'Asia/Tokyo',
      localTime: '09:30',
      startDate: '2026-07-01',
      daysOfWeek: [5, 1],
      catchUpPolicy: 'latest',
    })).toEqual({
      frequency: 'weekly',
      interval: 1,
      timeZone: 'Asia/Tokyo',
      localTime: '09:30',
      startDate: '2026-07-01',
      daysOfWeek: [1, 5],
      catchUpPolicy: 'latest',
    })
  })

  test('calculates a next local-time occurrence as UTC', () => {
    const next = getNextRecurringOccurrence({
      frequency: 'daily',
      interval: 1,
      timeZone: 'Asia/Tokyo',
      localTime: '09:00',
      startDate: '2026-07-01',
      catchUpPolicy: 'all',
    }, new Date('2026-07-21T23:59:59.000Z'))

    expect(next?.toISOString()).toBe('2026-07-22T00:00:00.000Z')
  })

  test('handles DST gaps and catch-up selection deterministically', () => {
    const occurrences = getRecurringOccurrences({
      frequency: 'daily',
      interval: 1,
      timeZone: 'America/New_York',
      localTime: '02:30',
      startDate: '2026-03-07',
      catchUpPolicy: 'all',
    }, new Date('2026-03-07T00:00:00.000Z'), new Date('2026-03-10T23:59:59.000Z'))

    expect(occurrences.map((value) => value.toISOString())).toContain(
      '2026-03-08T07:00:00.000Z',
    )
    expect(selectCatchUpOccurrences(occurrences, 'latest')).toEqual([
      occurrences[occurrences.length - 1],
    ])
  })
})

describe('monthly day rules', () => {
  const monthly = {
    frequency: 'monthly',
    interval: 1,
    timeZone: 'UTC',
    localTime: '09:00',
    startDate: '2026-01-01',
    catchUpPolicy: 'all',
  } as const

  test('runs a last-day schedule on each month end, including February', () => {
    const occurrences = getRecurringOccurrences(
      validateRecurringSchedule({ ...monthly, monthlyDay: 'last-day' }),
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-04-01T00:00:00.000Z'),
    )
    expect(occurrences.map((occurrence) => occurrence.toISOString().slice(0, 10)))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })

  test('counts business days on the work calendar, and calendar days without one', () => {
    const schedule = validateRecurringSchedule({ ...monthly, monthlyDay: 'business-day', dayOfMonth: 3 })
    const calendar = { workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set(['2026-02-02']) }
    expect(getRecurringOccurrences(
      schedule,
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-03-01T00:00:00.000Z'),
      calendar,
    ).map((occurrence) => occurrence.toISOString().slice(0, 10)))
      // January: Thu 1, Fri 2, Mon 5. February: Mon 2 is a holiday, so Tue 3, Wed 4, Thu 5.
      .toEqual(['2026-01-05', '2026-02-05'])
    expect(getNextRecurringOccurrence(schedule, new Date('2026-01-01T00:00:00.000Z'))?.toISOString())
      .toBe('2026-01-03T09:00:00.000Z')
  })

  test('rejects day settings that do not fit the monthly day rule', () => {
    expect(() => validateRecurringSchedule({ ...monthly, monthlyDay: 'last-day', dayOfMonth: 31 }))
      .toThrow('A last-day recurring schedule cannot define dayOfMonth.')
    expect(() => validateRecurringSchedule({ ...monthly, monthlyDay: 'business-day', dayOfMonth: 24 }))
      .toThrow('Recurring business day must be an integer between 1 and 23.')
    expect(() => validateRecurringSchedule({ ...monthly, monthlyDay: 'weekday', dayOfMonth: 1 }))
      .toThrow('Recurring monthly day rule is invalid.')
    expect(() => validateRecurringSchedule({
      ...monthly,
      frequency: 'daily',
      monthlyDay: 'last-day',
    })).toThrow('Only monthly recurring schedules can define monthlyDay.')
    expect(validateRecurringSchedule({ ...monthly, monthlyDay: 'day-of-month', dayOfMonth: 5 }))
      .not.toHaveProperty('monthlyDay')
  })
})

describe('business-day wake-ups', () => {
  const schedule: RecurringSchedule = {
    frequency: 'monthly',
    interval: 1,
    timeZone: 'Asia/Tokyo',
    localTime: '09:00',
    startDate: '2026-01-01',
    dayOfMonth: 3,
    monthlyDay: 'business-day',
    catchUpPolicy: 'skip',
  }

  test('wakes the next day for a business-day schedule created between day n and business day n', () => {
    expect(getFirstRecurringWakeUp(schedule, new Date('2026-08-03T01:00:00.000Z'))?.toISOString())
      .toBe('2026-08-04T00:00:00.000Z')
    expect(getFirstRecurringWakeUp(
      { ...schedule, monthlyDay: 'day-of-month' },
      new Date('2026-08-03T01:00:00.000Z'),
    )?.toISOString()).toBe('2026-09-03T00:00:00.000Z')
    expect(getFirstRecurringWakeUp(schedule, new Date('2026-08-01T01:00:00.000Z'))?.toISOString())
      .toBe('2026-08-03T00:00:00.000Z')
  })

  test('wakes daily while the business-day run is in the current month, and on day n otherwise', () => {
    expect(getBusinessDayWakeUp(
      schedule,
      new Date('2026-08-03T01:00:00.000Z'),
      new Date('2026-08-05T00:00:00.000Z'),
    ).toISOString()).toBe('2026-08-04T00:00:00.000Z')
    expect(getBusinessDayWakeUp(
      schedule,
      new Date('2026-08-01T01:00:00.000Z'),
      new Date('2026-08-05T00:00:00.000Z'),
    ).toISOString()).toBe('2026-08-03T00:00:00.000Z')
    expect(getBusinessDayWakeUp(
      schedule,
      new Date('2026-08-20T01:00:00.000Z'),
      new Date('2026-09-03T00:00:00.000Z'),
    ).toISOString()).toBe('2026-09-03T00:00:00.000Z')
  })
})
