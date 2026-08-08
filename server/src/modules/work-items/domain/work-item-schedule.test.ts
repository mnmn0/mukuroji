import { expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  WORK_ITEM_SCHEDULE_MAX_HOLIDAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type WorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import {
  WorkItemScheduleError,
  addWorkItemScheduleCalendarDays,
  applyWorkItemScheduleOperation,
  calculateWorkItemScheduleDurationDays,
  calculateWorkItemScheduleEndDate,
  calculateWorkItemScheduleStartDate,
  deriveWorkItemScheduleDueDate,
  isWorkItemSchedule,
  normalizeWorkItemSchedule,
  normalizeWorkItemScheduleOperation,
  previewWorkItemScheduleChange,
  workItemScheduleInstantToLocalDate,
} from './work-item-schedule'

const calendarPolicy: WorkItemScheduleCalendarPolicy = {
  timeZone: 'UTC',
  workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  holidays: ['2026-03-09'],
}

test('normalizes calendar ordering, duplicates, and optional effort', () => {
  expect(normalizeWorkItemSchedule({
    mode: 'due-date',
    calendarPolicy: {
      timeZone: 'utc',
      workingWeekdays: ['friday', 'monday', 'friday', 'wednesday'],
      holidays: ['2026-12-31', '2026-01-01', '2026-12-31'],
    },
    dueDate: '2026-08-05',
    plannedEffortMinutes: 0,
  })).toEqual({
    mode: 'due-date',
    calendarPolicy: {
      timeZone: 'UTC',
      workingWeekdays: ['monday', 'wednesday', 'friday'],
      holidays: ['2026-01-01', '2026-12-31'],
    },
    dueDate: '2026-08-05',
    plannedEffortMinutes: 0,
  })
})

test('enforces distinct schedule state invariants', () => {
  const unscheduled = normalizeWorkItemSchedule({
    mode: 'unscheduled',
    calendarPolicy,
  })
  const dueDate = normalizeWorkItemSchedule({
    mode: 'due-date',
    calendarPolicy,
    dueDate: '2026-02-28',
  })
  const dateRange = normalizeWorkItemSchedule({
    mode: 'date-range',
    calendarPolicy,
    startDate: '2026-03-06',
    endDate: '2026-03-10',
    durationDays: 2,
  })
  const milestone = normalizeWorkItemSchedule({
    mode: 'milestone',
    calendarPolicy,
    startDate: '2026-03-08',
    endDate: '2026-03-08',
    durationDays: 0,
  })

  expect(unscheduled.mode).toBe('unscheduled')
  expect(dueDate.mode).toBe('due-date')
  expect(dateRange).toMatchObject({ mode: 'date-range', durationDays: 2 })
  expect(milestone).toMatchObject({ mode: 'milestone', durationDays: 0 })

  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'unscheduled',
      calendarPolicy,
      dueDate: '2026-08-05',
    }),
    'InvalidWorkItemSchedule',
  )
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'milestone',
      calendarPolicy,
      startDate: '2026-08-05',
      endDate: '2026-08-06',
      durationDays: 0,
    }),
    'InvalidWorkItemSchedule',
  )
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'date-range',
      calendarPolicy,
      startDate: '2026-03-06',
      endDate: '2026-03-10',
      durationDays: 3,
    }),
    'WorkItemScheduleDurationMismatch',
  )
})

test('rejects malformed dates, timezone policies, effort, and empty working weeks', () => {
  expect(createDefaultDueDateWorkItemSchedule(
    `${WORK_ITEM_SCHEDULE_MIN_YEAR}-01-01`,
  ).dueDate).toBe('1000-01-01')
  expect(() => createDefaultDueDateWorkItemSchedule('0999-12-31')).toThrow(RangeError)
  for (const effort of [-1, 1.5, Number.NaN]) {
    expect(() => createDefaultUnscheduledWorkItemSchedule(effort)).toThrow(RangeError)
  }
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'due-date',
      calendarPolicy,
      dueDate: '2026-02-29',
    }),
    'InvalidWorkItemScheduleDate',
  )
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'due-date',
      calendarPolicy: { ...calendarPolicy, timeZone: 'Mars/Olympus_Mons' },
      dueDate: '2026-08-05',
    }),
    'InvalidWorkItemScheduleTimeZone',
  )
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'due-date',
      calendarPolicy,
      dueDate: '0999-12-31',
    }),
    'InvalidWorkItemScheduleDate',
  )
  expectScheduleError(
    () => calculateWorkItemScheduleDurationDays(
      '1000-01-01',
      '9999-12-31',
      calendarPolicy,
    ),
    'InvalidWorkItemScheduleRange',
  )
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'due-date',
      calendarPolicy: { ...calendarPolicy, workingWeekdays: [] },
      dueDate: '2026-08-05',
    }),
    'InvalidWorkItemScheduleCalendarPolicy',
  )
  const maximumHolidays = Array.from(
    { length: WORK_ITEM_SCHEDULE_MAX_HOLIDAYS },
    (_, index) => addWorkItemScheduleCalendarDays('2026-01-01', index),
  )
  expect(normalizeWorkItemSchedule({
    mode: 'due-date',
    calendarPolicy: { ...calendarPolicy, holidays: maximumHolidays },
    dueDate: '2026-08-05',
  }).calendarPolicy.holidays).toHaveLength(WORK_ITEM_SCHEDULE_MAX_HOLIDAYS)
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'due-date',
      calendarPolicy,
      dueDate: '2026-08-05',
      plannedEffortMinutes: 1.5,
    }),
    'InvalidWorkItemScheduleEffort',
  )
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'due-date',
      calendarPolicy: {
        ...calendarPolicy,
        workingWeekdays: [
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday',
          'sunday',
          'monday',
        ],
      },
      dueDate: '2026-08-05',
    }),
    'InvalidWorkItemScheduleCalendarPolicy',
  )
  expectScheduleError(
    () => normalizeWorkItemSchedule({
      mode: 'due-date',
      calendarPolicy: {
        ...calendarPolicy,
        holidays: Array.from(
          { length: WORK_ITEM_SCHEDULE_MAX_HOLIDAYS + 1 },
          (_, index) => addWorkItemScheduleCalendarDays('2026-01-01', index),
        ),
      },
      dueDate: '2026-08-05',
    }),
    'InvalidWorkItemScheduleCalendarPolicy',
  )
  expect(isWorkItemSchedule({
    mode: 'due-date',
    calendarPolicy,
    dueDate: '2026/08/05',
  })).toBe(false)
})

test('counts inclusive working dates and resolves an end across holidays', () => {
  expect(calculateWorkItemScheduleDurationDays(
    '2026-03-06',
    '2026-03-10',
    calendarPolicy,
  )).toBe(2)
  expect(calculateWorkItemScheduleDurationDays(
    '2026-03-07',
    '2026-03-08',
    calendarPolicy,
  )).toBe(0)
  expect(calculateWorkItemScheduleEndDate(
    '2026-03-06',
    2,
    calendarPolicy,
  )).toBe('2026-03-10')
  expect(calculateWorkItemScheduleStartDate(
    '2026-03-10',
    2,
    calendarPolicy,
  )).toBe('2026-03-06')
  expectScheduleError(
    () => calculateWorkItemScheduleDurationDays(
      '2026-03-10',
      '2026-03-06',
      calendarPolicy,
    ),
    'InvalidWorkItemScheduleRange',
  )
})

test('moves a range without changing duration and resizes by recomputing it', () => {
  const before: WorkItemSchedule = {
    mode: 'date-range',
    calendarPolicy,
    startDate: '2026-03-06',
    endDate: '2026-03-10',
    durationDays: 2,
    plannedEffortMinutes: 480,
  }

  expect(applyWorkItemScheduleOperation(before, {
    type: 'move',
    targetDate: '2026-03-12',
  })).toEqual({
    mode: 'date-range',
    calendarPolicy,
    startDate: '2026-03-12',
    endDate: '2026-03-13',
    durationDays: 2,
    plannedEffortMinutes: 480,
  })
  expect(applyWorkItemScheduleOperation(before, {
    type: 'resize',
    endDate: '2026-03-12',
  })).toEqual({
    mode: 'date-range',
    calendarPolicy,
    startDate: '2026-03-06',
    endDate: '2026-03-12',
    durationDays: 4,
    plannedEffortMinutes: 480,
  })
})

test('strictly normalizes operations from an untrusted transport boundary', () => {
  expect(normalizeWorkItemScheduleOperation({
    type: 'move',
    targetDate: '2026-08-05',
  })).toEqual({ type: 'move', targetDate: '2026-08-05' })
  expectScheduleError(
    () => normalizeWorkItemScheduleOperation({
      type: 'move',
      targetDate: '2026-08-05',
      durationDays: 2,
    }),
    'InvalidWorkItemScheduleOperation',
  )
})

test('moves deadlines and milestones without inferring another schedule mode', () => {
  const dueDate: WorkItemSchedule = {
    mode: 'due-date',
    calendarPolicy,
    dueDate: '2026-03-06',
  }
  const milestone: WorkItemSchedule = {
    mode: 'milestone',
    calendarPolicy,
    startDate: '2026-03-06',
    endDate: '2026-03-06',
    durationDays: 0,
  }

  expect(applyWorkItemScheduleOperation(dueDate, {
    type: 'move',
    targetDate: '2026-03-12',
  })).toMatchObject({ mode: 'due-date', dueDate: '2026-03-12' })
  expect(applyWorkItemScheduleOperation(milestone, {
    type: 'move',
    targetDate: '2026-03-12',
  })).toMatchObject({
    mode: 'milestone',
    startDate: '2026-03-12',
    endDate: '2026-03-12',
    durationDays: 0,
  })
  expectScheduleError(
    () => applyWorkItemScheduleOperation({
      mode: 'unscheduled',
      calendarPolicy,
    }, {
      type: 'move',
      targetDate: '2026-03-12',
    }),
    'InvalidWorkItemScheduleOperation',
  )
})

test('maps instants to local dates across DST without elapsed-day arithmetic', () => {
  const newYorkPolicy: WorkItemScheduleCalendarPolicy = {
    ...calendarPolicy,
    timeZone: 'America/New_York',
  }

  expect(workItemScheduleInstantToLocalDate(
    '2026-03-08T04:30:00.000Z',
    newYorkPolicy,
  )).toBe('2026-03-07')
  expect(workItemScheduleInstantToLocalDate(
    '2026-03-08T07:30:00.000Z',
    newYorkPolicy,
  )).toBe('2026-03-08')
  expect(addWorkItemScheduleCalendarDays('2024-02-28', 1)).toBe('2024-02-29')
  expect(addWorkItemScheduleCalendarDays('2024-03-01', -1)).toBe('2024-02-29')
  expectScheduleError(
    () => workItemScheduleInstantToLocalDate(
      '2026-03-08T07:30:00',
      newYorkPolicy,
    ),
    'InvalidWorkItemScheduleInstant',
  )
})

test('derives deadline projections and builds a self-only preview', () => {
  const before: WorkItemSchedule = {
    mode: 'date-range',
    calendarPolicy,
    startDate: '2026-03-06',
    endDate: '2026-03-10',
    durationDays: 2,
  }
  const preview = previewWorkItemScheduleChange(
    'team-1',
    'work-item-1',
    7,
    before,
    { type: 'move', targetDate: '2026-03-12' },
  )

  expect(preview).toEqual({
    expectedRevision: 7,
    impacts: [{
      teamId: 'team-1',
      workItemId: 'work-item-1',
      kind: 'direct',
      expectedRevision: 7,
      before,
      after: {
        mode: 'date-range',
        calendarPolicy,
        startDate: '2026-03-12',
        endDate: '2026-03-13',
        durationDays: 2,
      },
      dateDeltaDays: 3,
    }],
    evaluatedRevisions: [{
      teamId: 'team-1',
      workItemId: 'work-item-1',
      expectedRevision: 7,
    }],
    conflicts: [],
    affectedProjects: [],
    affectedProjectIds: [],
    affectedMilestoneIds: [],
    requiresConfirmation: false,
    warnings: [],
  })
  expect(deriveWorkItemScheduleDueDate({
    mode: 'unscheduled',
    calendarPolicy,
  })).toBe('')
  expect(deriveWorkItemScheduleDueDate({
    mode: 'due-date',
    calendarPolicy,
    dueDate: '2026-08-05',
  })).toBe('2026-08-05')
  expect(deriveWorkItemScheduleDueDate(before)).toBe('2026-03-10')
  expectScheduleError(
    () => previewWorkItemScheduleChange(
      'team-1',
      'work-item-1',
      0,
      before,
      { type: 'move', targetDate: '2026-03-12' },
    ),
    'InvalidWorkItemSchedulePreview',
  )
})

/**
 * Asserts a stable 400 schedule-domain error.
 *
 * @param callback - Operation expected to fail.
 * @param code - Expected stable error code.
 */
function expectScheduleError(callback: () => unknown, code: string): void {
  let thrown: unknown
  try {
    callback()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(WorkItemScheduleError)
  expect(thrown).toMatchObject({ status: 400, code })
}
