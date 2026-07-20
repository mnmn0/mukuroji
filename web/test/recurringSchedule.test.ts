import { describe, expect, test } from 'bun:test'
import {
  createRecurringSchedule,
  currentDateInTimeZone,
  dayOfMonthFromLocalDate,
  isRecurringCadenceConfigurationValid,
  weekdayFromLocalDate,
} from '../src/automation/model/recurringSchedule'

const baseInput = {
  catchUpPolicy: 'latest' as const,
  localTime: '09:00',
  startDate: '2026-07-16',
  timeZone: 'Asia/Tokyo',
}

describe('recurring schedule builder', () => {
  test('derives a required weekday from the local start date', () => {
    const schedule = createRecurringSchedule({ ...baseInput, frequency: 'weekly' })

    expect(schedule.daysOfWeek).toEqual([4])
    expect(schedule.dayOfMonth).toBeUndefined()
  })

  test('derives a required day of month from the local start date', () => {
    const schedule = createRecurringSchedule({ ...baseInput, frequency: 'monthly' })

    expect(schedule.dayOfMonth).toBe(16)
    expect(schedule.daysOfWeek).toBeUndefined()
  })

  test('uses explicit weekly and monthly editor selections', () => {
    expect(createRecurringSchedule({
      ...baseInput,
      dayOfWeek: 1,
      frequency: 'weekly',
    }).daysOfWeek).toEqual([1])
    expect(createRecurringSchedule({
      ...baseInput,
      dayOfMonth: 31,
      frequency: 'monthly',
    }).dayOfMonth).toBe(31)
  })

  test('validates cadence fields and local ISO dates without device timezone conversion', () => {
    expect(isRecurringCadenceConfigurationValid('weekly', 0, 1)).toBe(true)
    expect(isRecurringCadenceConfigurationValid('weekly', 7, 1)).toBe(false)
    expect(isRecurringCadenceConfigurationValid('monthly', 0, 31)).toBe(true)
    expect(isRecurringCadenceConfigurationValid('monthly', 0, 32)).toBe(false)
    expect(weekdayFromLocalDate('2026-03-01')).toBe(0)
    expect(dayOfMonthFromLocalDate('2026-03-01')).toBe(1)
    expect(() => weekdayFromLocalDate('2026-02-30')).toThrow(RangeError)
    expect(() => createRecurringSchedule({
      ...baseInput,
      dayOfMonth: 32,
      frequency: 'monthly',
    })).toThrow(RangeError)
  })

  test('derives different local dates for the same instant across IANA time zones', () => {
    const now = new Date('2026-07-16T02:00:00.000Z')

    expect(currentDateInTimeZone('America/Los_Angeles', now)).toBe('2026-07-15')
    expect(currentDateInTimeZone('Asia/Tokyo', now)).toBe('2026-07-16')
  })
})
