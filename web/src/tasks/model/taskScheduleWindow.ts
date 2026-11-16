import {
  workItemScheduleOverlapsWindow,
  type WorkItemSchedule,
} from '@mukuroji/contracts'

/** Number of months one Gantt period shows. */
export const TASK_GANTT_WINDOW_MONTHS = 3

/** Inclusive local date window that a Project calendar or Gantt reads and renders. */
export type TaskScheduleWindow = {
  /** Inclusive first local date in `YYYY-MM-DD` form. */
  from: string
  /** Inclusive last local date in `YYYY-MM-DD` form. */
  to: string
}

/** Project layouts that read only the Work Items of their visible period. */
export type TaskScheduleWindowLayout = 'calendar' | 'gantt'

/**
 * Returns the viewer's current local month.
 *
 * @param now - Instant to read the month from.
 * @returns The month in `YYYY-MM` form.
 */
export function getCurrentTaskMonth(now: Date = new Date()): string {
  return formatTaskMonth(now.getFullYear(), now.getMonth() + 1)
}

/**
 * Moves a month by a signed number of months.
 *
 * @param month - Month in `YYYY-MM` form.
 * @param delta - Signed number of months to move.
 * @returns The moved month in `YYYY-MM` form.
 */
export function shiftTaskMonth(month: string, delta: number): string {
  const { year, monthNumber } = parseTaskMonth(month)
  const index = year * 12 + (monthNumber - 1) + delta
  return formatTaskMonth(Math.floor(index / 12), (index % 12 + 12) % 12 + 1)
}

/**
 * Creates the window of one calendar month.
 *
 * @param month - Month in `YYYY-MM` form.
 * @returns The first and last date of the month.
 */
export function createTaskCalendarMonthWindow(month: string): TaskScheduleWindow {
  return createTaskMonthsWindow(month, 1)
}

/**
 * Creates the window of one Gantt period starting at a month.
 *
 * @param startMonth - First month of the period in `YYYY-MM` form.
 * @returns The first date of `startMonth` through the last date of its
 *   {@link TASK_GANTT_WINDOW_MONTHS}-month period.
 */
export function createTaskGanttWindow(startMonth: string): TaskScheduleWindow {
  return createTaskMonthsWindow(startMonth, TASK_GANTT_WINDOW_MONTHS)
}

/**
 * Lists every date of a window in order.
 *
 * @param window - Inclusive local date window.
 * @returns Dates in `YYYY-MM-DD` form from `from` through `to`.
 */
export function listTaskScheduleWindowDates(window: TaskScheduleWindow): string[] {
  const dates: string[] = []
  const end = toUtcTime(window.to)
  for (let time = toUtcTime(window.from); time <= end; time += 86_400_000) {
    dates.push(new Date(time).toISOString().slice(0, 10))
  }
  return dates
}

/**
 * Decides whether a schedule touches a window, as the server's `scheduledFrom` filter does.
 *
 * @param schedule - Canonical Work Item schedule.
 * @param window - Inclusive local date window.
 * @returns Whether the schedule is placed on at least one date of the window.
 */
export function isTaskScheduleInWindow(
  schedule: WorkItemSchedule,
  window: TaskScheduleWindow,
): boolean {
  return workItemScheduleOverlapsWindow(schedule, window.from, window.to)
}

/**
 * Creates a window spanning whole months.
 *
 * @param startMonth - First month in `YYYY-MM` form.
 * @param months - Number of months, at least one.
 * @returns The first date of `startMonth` through the last date of the final month.
 */
function createTaskMonthsWindow(startMonth: string, months: number): TaskScheduleWindow {
  const { year, monthNumber } = parseTaskMonth(startMonth)
  // Day 0 of the month after the period is the period's last day.
  const last = new Date(Date.UTC(year, monthNumber - 1 + months, 0))
  return {
    from: `${startMonth}-01`,
    to: last.toISOString().slice(0, 10),
  }
}

/**
 * Parses a `YYYY-MM` month.
 *
 * @param month - Month in `YYYY-MM` form.
 * @returns The year and the 1-based month number.
 * @throws RangeError when the value is not a month.
 */
function parseTaskMonth(month: string): { year: number; monthNumber: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  const year = Number(match?.[1])
  const monthNumber = Number(match?.[2])
  if (!match || monthNumber < 1 || monthNumber > 12) {
    throw new RangeError(`Invalid task month: ${month}`)
  }
  return { year, monthNumber }
}

/**
 * Formats a year and month number as `YYYY-MM`.
 *
 * @param year - Four-digit year.
 * @param monthNumber - 1-based month number.
 * @returns The month in `YYYY-MM` form.
 */
function formatTaskMonth(year: number, monthNumber: number): string {
  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`
}

/**
 * Converts a `YYYY-MM-DD` date to UTC midnight.
 *
 * @param date - Local calendar date.
 * @returns Milliseconds since the Unix epoch at UTC midnight of the date.
 */
function toUtcTime(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`)
}

/** Visible periods of the Project calendar and Gantt, owned by the route that reads them. */
export type TaskScheduleWindowNavigation = {
  /** Month the calendar shows, in `YYYY-MM` form. */
  calendarMonth: string
  /** Moves the calendar to another month. */
  onCalendarMonthChange: (month: string) => void
  /** First month of the Gantt period, in `YYYY-MM` form. */
  ganttStartMonth: string
  /** Moves the Gantt period to start at another month. */
  onGanttStartMonthChange: (month: string) => void
}
