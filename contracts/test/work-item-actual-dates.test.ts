import { describe, expect, test } from 'bun:test'
import {
  countWorkItemCalendarDaysBetween,
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  deriveWorkItemScheduleVariance,
  isWorkItemCompletedLate,
  isWorkItemStartedLate,
  type WorkItemSchedule,
} from '../src/index'

const rangeSchedule: WorkItemSchedule = {
  mode: 'date-range',
  calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] },
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  durationDays: 5,
}

describe('Work Item actual dates', () => {
  test('derives signed start and completion delays against the plan', () => {
    expect(deriveWorkItemScheduleVariance({
      schedule: rangeSchedule,
      actualStartDate: '2026-11-04',
      actualEndDate: '2026-11-05',
    })).toEqual({
      plannedStartDate: '2026-11-02',
      plannedEndDate: '2026-11-06',
      startDelayDays: 2,
      completionDelayDays: -1,
    })
  })

  test('uses the deadline as the planned end of a due-date schedule', () => {
    const workItem = {
      schedule: createDefaultDueDateWorkItemSchedule('2026-11-10'),
      actualStartDate: '2026-11-01',
      actualEndDate: '2026-11-13',
    }
    expect(deriveWorkItemScheduleVariance(workItem)).toEqual({
      plannedEndDate: '2026-11-10',
      completionDelayDays: 3,
    })
    expect(isWorkItemCompletedLate(workItem)).toBe(true)
    expect(isWorkItemStartedLate(workItem)).toBe(false)
  })

  test('leaves the variance empty without actual dates or a plan', () => {
    expect(deriveWorkItemScheduleVariance({ schedule: rangeSchedule })).toEqual({
      plannedStartDate: '2026-11-02',
      plannedEndDate: '2026-11-06',
    })
    expect(deriveWorkItemScheduleVariance({
      schedule: createDefaultUnscheduledWorkItemSchedule(),
      actualStartDate: '2026-11-01',
      actualEndDate: '2026-11-02',
    })).toEqual({})
    expect(isWorkItemCompletedLate({ schedule: rangeSchedule })).toBe(false)
  })

  test('counts calendar days across month and leap boundaries', () => {
    expect(countWorkItemCalendarDaysBetween('2028-02-28', '2028-03-01')).toBe(2)
    expect(countWorkItemCalendarDaysBetween('2026-11-10', '2026-11-03')).toBe(-7)
    expect(countWorkItemCalendarDaysBetween('2026-02-30', '2026-03-01')).toBeUndefined()
  })
})
