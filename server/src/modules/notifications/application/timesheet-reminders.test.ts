import { describe, expect, test } from 'bun:test'
import { DEFAULT_TIMESHEET_REMINDER_HOUR, isTimesheetReminderHour } from './timesheet-reminders'

describe('isTimesheetReminderHour', () => {
  test('reads the hour on the Workspace clock, Asia/Tokyo by default', () => {
    expect(DEFAULT_TIMESHEET_REMINDER_HOUR).toBe(9)
    expect(isTimesheetReminderHour(new Date('2026-07-12T00:00:00.000Z'), 9)).toBe(true)
    expect(isTimesheetReminderHour(new Date('2026-07-12T00:59:59.999Z'), 9)).toBe(true)
    expect(isTimesheetReminderHour(new Date('2026-07-12T01:00:00.000Z'), 9)).toBe(false)
    expect(isTimesheetReminderHour(new Date('2026-07-12T09:00:00.000Z'), 9)).toBe(false)
    expect(isTimesheetReminderHour(new Date('2026-07-11T15:00:00.000Z'), 0)).toBe(true)
  })

  test('keeps the same local hour across a daylight saving change', () => {
    // New York is UTC-4 in summer and UTC-5 in winter.
    expect(isTimesheetReminderHour(new Date('2026-07-01T13:00:00.000Z'), 9, 'America/New_York')).toBe(true)
    expect(isTimesheetReminderHour(new Date('2026-12-01T14:00:00.000Z'), 9, 'America/New_York')).toBe(true)
    expect(isTimesheetReminderHour(new Date('2026-12-01T13:00:00.000Z'), 9, 'America/New_York')).toBe(false)
  })
})
