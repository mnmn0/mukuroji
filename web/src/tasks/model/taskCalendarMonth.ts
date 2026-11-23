import {
  workspaceWeekContaining,
  type CanonicalWorkItem,
  type WorkspaceWeekStartDay,
} from '@mukuroji/contracts'
import { resolveTaskSchedule, resolveTaskSchedulePrimaryDate } from './taskSchedule'
import {
  createTaskCalendarMonthWindow,
  listTaskScheduleWindowDates,
} from './taskScheduleWindow'
import { createTaskKey } from './taskView'

/**
 * Lists the Work Items a monthly calendar shows, in the order its cards appear.
 *
 * The calendar places a Work Item on its schedule's primary date and keeps unscheduled Work Items
 * in a bucket after the dates, so keyboard navigation and action targets match the shown cards:
 * Work Items dated outside the month are left out.
 *
 * @param tasks - Filtered Work Items given to the calendar.
 * @param month - Month the calendar shows, in `YYYY-MM` form.
 * @returns The Work Items dated in the month by date, then the unscheduled ones.
 */
export function listTaskCalendarMonthTasks<Task extends CanonicalWorkItem>(
  tasks: readonly Task[],
  month: string,
): Task[] {
  const monthDates = new Set(listTaskScheduleWindowDates(createTaskCalendarMonthWindow(month)))
  const scheduledTasks = tasks.flatMap((task) => {
    const date = resolveTaskSchedulePrimaryDate(resolveTaskSchedule(task))
    return date && monthDates.has(date) ? [{ date, task }] : []
  })
  const unscheduledTasks = tasks.filter((task) => resolveTaskSchedule(task).mode === 'unscheduled')
  return [
    ...scheduledTasks
      .toSorted((left, right) =>
        left.date.localeCompare(right.date) || compareTaskKeys(left.task, right.task))
      .map(({ task }) => task),
    ...unscheduledTasks.toSorted(compareTaskKeys),
  ]
}

/**
 * Orders two Work Items the way the calendar orders the cards of one cell.
 *
 * @param left - First Work Item.
 * @param right - Second Work Item.
 * @returns A negative, zero, or positive comparison result.
 */
function compareTaskKeys(left: CanonicalWorkItem, right: CanonicalWorkItem): number {
  return createTaskKey(left).localeCompare(createTaskKey(right))
}

/** Dates of one Workspace week that a calendar shows under one week heading. */
export type TaskCalendarWeek<Day extends { date: string }> = {
  /** First date of the Workspace week, which may be before the first shown date. */
  weekStartDate: string
  /** Last date of the Workspace week, which may be after the last shown date. */
  weekEndDate: string
  /** Shown days of the week, in date order. */
  days: Day[]
}

/** Short weekday label keys, indexed the way `Date#getUTCDay()` numbers weekdays. */
const taskCalendarWeekdayKeys = [
  'tasks.calendar.day.sun',
  'tasks.calendar.day.mon',
  'tasks.calendar.day.tue',
  'tasks.calendar.day.wed',
  'tasks.calendar.day.thu',
  'tasks.calendar.day.fri',
  'tasks.calendar.day.sat',
] as const

/** Message key of a short weekday label. */
export type TaskCalendarWeekdayKey = (typeof taskCalendarWeekdayKeys)[number]

/**
 * Groups calendar days into Workspace weeks, so a month reads week by week starting on the
 * Workspace week start day.
 *
 * @param days - Days in ascending date order.
 * @param weekStartDay - Day the Workspace week starts on.
 * @returns The weeks that hold at least one day, in date order.
 */
export function groupTaskCalendarDaysByWeek<Day extends { date: string }>(
  days: readonly Day[],
  weekStartDay: WorkspaceWeekStartDay,
): TaskCalendarWeek<Day>[] {
  const weeks: TaskCalendarWeek<Day>[] = []
  for (const day of days) {
    const week = workspaceWeekContaining(day.date, weekStartDay)
    // A week past year 9999 has no four-digit date, so it is named by its shown date instead.
    const weekStartDate = isTaskCalendarFourDigitDate(week.from) ? week.from : day.date
    const weekEndDate = isTaskCalendarFourDigitDate(week.to) ? week.to : day.date
    const current = weeks.at(-1)
    if (current?.weekStartDate === weekStartDate) {
      current.days.push(day)
      if (!isTaskCalendarFourDigitDate(week.to)) current.weekEndDate = day.date
    } else {
      weeks.push({ days: [day], weekEndDate, weekStartDate })
    }
  }
  return weeks
}

/**
 * Tells whether a date has the four-digit `YYYY-MM-DD` form screens show.
 *
 * @param date - Candidate date text.
 * @returns Whether the text is a four-digit-year date.
 */
function isTaskCalendarFourDigitDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(date)
}

/**
 * Finds the short weekday label of a date.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @returns The message key of the weekday's short label.
 */
export function resolveTaskCalendarWeekdayKey(date: string): TaskCalendarWeekdayKey {
  return taskCalendarWeekdayKeys[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? 'tasks.calendar.day.sun'
}
