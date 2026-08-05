import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  type WorkItemSchedule,
} from '@mukuroji/contracts'
import {
  areTaskSchedulesEqual,
  addTaskTimelineDays,
  countTaskSchedulePolicyWorkingDays,
  countTaskScheduleWorkingDays,
  createDefaultDateRangeTaskSchedule,
  createDefaultDueDateTaskSchedule,
  createDefaultMilestoneTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
  createMoveTaskScheduleOperation,
  createReplaceTaskScheduleOperation,
  createResizeTaskScheduleOperation,
  createTaskTimelineDateRange,
  deriveTaskScheduleDueDate,
  formatTaskScheduleRange,
  listTaskTimelineDates,
  resolveTaskSchedule,
  resolveTaskScheduleEndDate,
  resolveTaskScheduleMode,
  resolveTaskSchedulePrimaryDate,
  resolveTaskScheduleStartDate,
  resolveTaskScheduleSummary,
  replaceTaskDeadlineSchedule,
  tryAddTaskTimelineDays,
  unscheduleTaskSchedule,
} from '../src/tasks/model/taskSchedule'

describe('default task schedule construction', () => {
  test('keeps every schedule state explicit under independent UTC weekday policies', () => {
    const unscheduled = createDefaultUnscheduledTaskSchedule()
    const dueDate = createDefaultDueDateTaskSchedule('2026-07-31', 240)
    const dateRange = createDefaultDateRangeTaskSchedule('2026-07-31', '2026-08-04')
    const milestone = createDefaultMilestoneTaskSchedule('2026-08-03')

    expect(unscheduled).toEqual({
      calendarPolicy: {
        holidays: [],
        timeZone: 'UTC',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
      mode: 'unscheduled',
    })
    expect(dueDate).toMatchObject({
      dueDate: '2026-07-31',
      mode: 'due-date',
      plannedEffortMinutes: 240,
    })
    expect(dateRange).toMatchObject({
      durationDays: 3,
      endDate: '2026-08-04',
      mode: 'date-range',
      startDate: '2026-07-31',
    })
    expect(milestone).toMatchObject({
      durationDays: 0,
      endDate: '2026-08-03',
      mode: 'milestone',
      startDate: '2026-08-03',
    })
    expect(unscheduled.calendarPolicy).not.toBe(dueDate.calendarPolicy)
    expect(dueDate.calendarPolicy.workingWeekdays).not.toBe(
      dateRange.calendarPolicy.workingWeekdays,
    )
  })

  test('counts inclusive weekdays for drafts without applying holiday rescheduling', () => {
    expect(countTaskScheduleWorkingDays('2026-07-31', '2026-08-04')).toBe(3)
    expect(countTaskScheduleWorkingDays('2026-08-01', '2026-08-02')).toBe(0)
    expect(countTaskScheduleWorkingDays('2026-08-04', '2026-07-31')).toBe(0)
    expect(countTaskSchedulePolicyWorkingDays('2026-07-31', '2026-08-04', {
      holidays: ['2026-08-03'],
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'friday', 'saturday'],
    })).toBe(3)
  })

  test('uses the shared supported year range for schedule dates', () => {
    expect(() => createDefaultDueDateTaskSchedule('0999-12-31')).toThrow(RangeError)
    expect(createDefaultDueDateTaskSchedule('1000-01-01').dueDate).toBe('1000-01-01')
    expect(() => createDefaultUnscheduledTaskSchedule(-1)).toThrow(RangeError)
  })
})

describe('task schedule selectors', () => {
  test('does not infer a start date or duration for a deadline-only schedule', () => {
    const schedule = createDefaultDueDateTaskSchedule('2026-08-07', 90)

    expect(resolveTaskScheduleStartDate(schedule)).toBeUndefined()
    expect(resolveTaskScheduleEndDate(schedule)).toBe('2026-08-07')
    expect(resolveTaskSchedulePrimaryDate(schedule)).toBe('2026-08-07')
    expect(resolveTaskScheduleSummary(schedule)).toEqual({
      dueDate: '2026-08-07',
      mode: 'due-date',
      plannedEffortMinutes: 90,
    })
    expect(formatTaskScheduleRange(schedule)).toBe('2026-08-07')
  })

  test('keeps unscheduled, ranged, and milestone presentations structurally distinct', () => {
    const unscheduled = createDefaultUnscheduledTaskSchedule(30)
    const dateRange = createDefaultDateRangeTaskSchedule('2026-08-03', '2026-08-05')
    const milestone = createDefaultMilestoneTaskSchedule('2026-08-06')

    expect(resolveTaskScheduleSummary(unscheduled)).toEqual({
      mode: 'unscheduled',
      plannedEffortMinutes: 30,
    })
    expect(formatTaskScheduleRange(unscheduled)).toBeUndefined()
    expect(resolveTaskScheduleSummary(dateRange)).toEqual({
      durationDays: 3,
      endDate: '2026-08-05',
      mode: 'date-range',
      startDate: '2026-08-03',
    })
    expect(formatTaskScheduleRange(dateRange)).toBe('2026-08-03 – 2026-08-05')
    expect(resolveTaskScheduleSummary(milestone)).toEqual({
      durationDays: 0,
      endDate: '2026-08-06',
      mode: 'milestone',
      startDate: '2026-08-06',
    })
    expect(formatTaskScheduleRange(milestone)).toBe('2026-08-06')
  })

  test('uses only the explicit schedule and derives its deadline projection', () => {
    const dueDateSchedule = createDefaultDueDateTaskSchedule('2026-08-07')
    const explicitUnscheduled = createDefaultUnscheduledTaskSchedule()

    expect(resolveTaskSchedule({ schedule: dueDateSchedule })).toBe(dueDateSchedule)
    expect(resolveTaskScheduleMode({ schedule: dueDateSchedule })).toBe('due-date')
    expect(deriveTaskScheduleDueDate(dueDateSchedule)).toBe('2026-08-07')
    expect(deriveTaskScheduleDueDate(explicitUnscheduled)).toBe('')
    expect(() => createDefaultDueDateTaskSchedule('2026/08/07')).toThrow()
  })
})

describe('task timeline date helpers', () => {
  test('builds padded inclusive boundaries and lists dates across a month boundary', () => {
    const schedules = [
      createDefaultUnscheduledTaskSchedule(),
      createDefaultMilestoneTaskSchedule('2026-07-30'),
      createDefaultDueDateTaskSchedule('2026-07-31'),
      createDefaultDateRangeTaskSchedule('2026-08-03', '2026-08-05'),
    ]
    const range = createTaskTimelineDateRange(schedules, '2026-01-01', 1)

    expect(range).toEqual({
      endDate: '2026-08-06',
      startDate: '2026-07-29',
    })
    expect(listTaskTimelineDates(range)).toEqual([
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
    ])
  })

  test('uses the fallback only for empty timelines and performs UTC leap-day arithmetic', () => {
    expect(createTaskTimelineDateRange([
      createDefaultUnscheduledTaskSchedule(),
    ], '2024-02-29', 1)).toEqual({
      endDate: '2024-03-01',
      startDate: '2024-02-28',
    })
    expect(addTaskTimelineDays('2024-02-28', 2)).toBe('2024-03-01')
    expect(addTaskTimelineDays('2024-03-01', -2)).toBe('2024-02-28')
    expect(listTaskTimelineDates({
      endDate: '2026-08-01',
      startDate: '2026-08-02',
    })).toEqual([])
  })

  test('does not shift timeline interactions outside supported schedule dates', () => {
    expect(() => addTaskTimelineDays('1000-01-01', -1)).toThrow(RangeError)
    expect(() => addTaskTimelineDays('9999-12-31', 1)).toThrow(RangeError)
    expect(tryAddTaskTimelineDays('1000-01-01', -1)).toBeUndefined()
    expect(tryAddTaskTimelineDays('9999-12-31', 1)).toBeUndefined()
    expect(tryAddTaskTimelineDays('1000-01-01', 1)).toBe('1000-01-02')
  })

  test('bounds client-side daily iteration to the shared planning horizon', () => {
    const startDate = '2026-01-01'
    const maximumEndDate = addTaskTimelineDays(
      startDate,
      WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS - 1,
    )
    const excessiveEndDate = addTaskTimelineDays(
      startDate,
      WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
    )

    expect(countTaskScheduleWorkingDays(startDate, maximumEndDate)).toBeGreaterThan(0)
    expect(() => countTaskScheduleWorkingDays(startDate, excessiveEndDate)).toThrow(RangeError)
    expect(listTaskTimelineDates({
      endDate: maximumEndDate,
      startDate,
    })).toHaveLength(WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS)
    expect(() => listTaskTimelineDates({
      endDate: excessiveEndDate,
      startDate,
    })).toThrow(RangeError)
  })
})

describe('task schedule operations', () => {
  test('compares canonical schedules independently of object key order', () => {
    const first = createDefaultDueDateTaskSchedule('2026-08-10', 240)
    const reordered = {
      plannedEffortMinutes: 240,
      mode: 'due-date',
      dueDate: '2026-08-10',
      calendarPolicy: {
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        timeZone: 'UTC',
        holidays: [],
      },
    } satisfies WorkItemSchedule

    expect(areTaskSchedulesEqual(first, reordered)).toBe(true)
    expect(areTaskSchedulesEqual(
      first,
      { ...reordered, dueDate: '2026-08-11' },
    )).toBe(false)
  })

  test('describes replace, move, and resize intent without client-side rescheduling', () => {
    const replacement = createDefaultDateRangeTaskSchedule('2026-08-03', '2026-08-05')

    expect(createReplaceTaskScheduleOperation(replacement)).toEqual({
      schedule: replacement,
      type: 'replace',
    })
    expect(createMoveTaskScheduleOperation('2026-08-10')).toEqual({
      targetDate: '2026-08-10',
      type: 'move',
    })
    expect(createResizeTaskScheduleOperation('2026-08-12')).toEqual({
      endDate: '2026-08-12',
      type: 'resize',
    })
  })

  test('edits only deadline-compatible modes without losing policy or effort', () => {
    const current = {
      calendarPolicy: {
        holidays: ['2026-06-12'],
        timeZone: 'Asia/Tokyo',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
      dueDate: '2026-06-10',
      mode: 'due-date',
      plannedEffortMinutes: 480,
    } satisfies WorkItemSchedule

    expect(replaceTaskDeadlineSchedule(current, '2026-06-15')).toEqual({
      ...current,
      dueDate: '2026-06-15',
    })
    expect(replaceTaskDeadlineSchedule(current, '')).toEqual({
      calendarPolicy: current.calendarPolicy,
      mode: 'unscheduled',
      plannedEffortMinutes: 480,
    })
    expect(() => replaceTaskDeadlineSchedule(
      createDefaultDateRangeTaskSchedule('2026-06-15', '2026-06-16'),
      '2026-06-17',
    )).toThrow('mode-specific schedule edits')
    expect(unscheduleTaskSchedule({
      ...createDefaultDateRangeTaskSchedule('2026-06-15', '2026-06-16', 120),
      calendarPolicy: current.calendarPolicy,
    })).toEqual({
      calendarPolicy: current.calendarPolicy,
      mode: 'unscheduled',
      plannedEffortMinutes: 120,
    })
  })
})
