import type { WorkflowStatusCategory } from './work-item-configuration'
import type { CanonicalWorkItem, WorkItemSchedule } from './work-items'

/** Work Item fields needed to compare the plan with the recorded actual dates. */
export type WorkItemActualDateSource = Pick<
  CanonicalWorkItem,
  'schedule' | 'actualStartDate' | 'actualEndDate'
>

/** Plan-versus-actual comparison derived when a Work Item is read. */
export type WorkItemScheduleVariance = {
  /** Planned start date of a date-range or milestone schedule. */
  plannedStartDate?: string
  /** Planned end date or deadline; absent for an unscheduled Work Item. */
  plannedEndDate?: string
  /**
   * Signed calendar days between the planned and actual start. Positive means the work started
   * late, negative means early. Absent unless both dates exist.
   */
  startDelayDays?: number
  /**
   * Signed calendar days between the planned end and the actual end. Positive means the work
   * finished late, negative means early. Absent unless both dates exist.
   */
  completionDelayDays?: number
}

/**
 * Returns the planned start date of a schedule.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns The planned start date, or undefined for deadline-only and unscheduled items.
 */
export function readWorkItemPlannedStartDate(schedule: WorkItemSchedule): string | undefined {
  return schedule.mode === 'date-range' || schedule.mode === 'milestone'
    ? schedule.startDate
    : undefined
}

/**
 * Returns the planned end date of a schedule.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns The deadline or inclusive end date, or undefined for an unscheduled item.
 */
export function readWorkItemPlannedEndDate(schedule: WorkItemSchedule): string | undefined {
  switch (schedule.mode) {
    case 'unscheduled':
      return undefined
    case 'due-date':
      return schedule.dueDate
    case 'date-range':
    case 'milestone':
      return schedule.endDate
  }
}

/**
 * Derives start and completion delays from the plan and the recorded actual dates.
 *
 * @param workItem - Work Item schedule and actual dates.
 * @returns The plan, the actual dates, and the signed delays that both sides support.
 */
export function deriveWorkItemScheduleVariance(
  workItem: WorkItemActualDateSource,
): WorkItemScheduleVariance {
  const plannedStartDate = readWorkItemPlannedStartDate(workItem.schedule)
  const plannedEndDate = readWorkItemPlannedEndDate(workItem.schedule)
  const startDelayDays = countWorkItemCalendarDaysBetween(plannedStartDate, workItem.actualStartDate)
  const completionDelayDays = countWorkItemCalendarDaysBetween(plannedEndDate, workItem.actualEndDate)
  return {
    ...(plannedStartDate === undefined ? {} : { plannedStartDate }),
    ...(plannedEndDate === undefined ? {} : { plannedEndDate }),
    ...(startDelayDays === undefined ? {} : { startDelayDays }),
    ...(completionDelayDays === undefined ? {} : { completionDelayDays }),
  }
}

/**
 * Reports whether a Work Item finished after its planned end date.
 *
 * @param workItem - Work Item schedule and actual dates.
 * @returns True when the actual end date is later than the planned end date.
 */
export function isWorkItemCompletedLate(workItem: WorkItemActualDateSource): boolean {
  const { completionDelayDays } = deriveWorkItemScheduleVariance(workItem)
  return completionDelayDays !== undefined && completionDelayDays > 0
}

/**
 * Reports whether a Work Item started after its planned start date.
 *
 * @param workItem - Work Item schedule and actual dates.
 * @returns True when the actual start date is later than the planned start date.
 */
export function isWorkItemStartedLate(workItem: WorkItemActualDateSource): boolean {
  const { startDelayDays } = deriveWorkItemScheduleVariance(workItem)
  return startDelayDays !== undefined && startDelayDays > 0
}

/**
 * Counts signed whole calendar days from one local date to another.
 *
 * @param from - Earlier reference date in `YYYY-MM-DD` form.
 * @param to - Compared date in `YYYY-MM-DD` form.
 * @returns `to - from` in days, or undefined when either date is missing or invalid.
 */
export function countWorkItemCalendarDaysBetween(
  from: string | undefined,
  to: string | undefined,
): number | undefined {
  if (from === undefined || to === undefined) return undefined
  const fromTime = parseUtcCalendarDate(from)
  const toTime = parseUtcCalendarDate(to)
  if (fromTime === undefined || toTime === undefined) return undefined
  return Math.round((toTime - fromTime) / 86_400_000)
}

/**
 * Parses a `YYYY-MM-DD` value as a UTC midnight epoch.
 *
 * @param value - Candidate calendar date.
 * @returns Epoch milliseconds, or undefined when the value is not a real date.
 */
function parseUtcCalendarDate(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    return undefined
  }
  return time
}

/** Recorded actual dates of one Work Item. */
export type WorkItemActualDates = Pick<CanonicalWorkItem, 'actualStartDate' | 'actualEndDate'>

/**
 * Records the actual dates implied by a status category transition.
 *
 * The first entry into `started` or `completed` records the start. Every entry into `completed`
 * records the end, so a reopened and completed again Work Item keeps its latest completion. Leaving
 * `completed` removes the end because the completion is no longer effective; the start stays.
 * An update that keeps the category leaves the dates unchanged.
 *
 * @param current - Actual dates before the transition; empty for a new Work Item.
 * @param previousCategory - Status category before the transition; undefined for a new Work Item.
 * @param nextCategory - Status category after the transition.
 * @param transitionDate - Local date of the transition in the schedule calendar timezone.
 * @returns The actual dates after the transition.
 */
export function applyWorkItemStatusTransitionToActualDates(
  current: WorkItemActualDates,
  previousCategory: WorkflowStatusCategory | undefined,
  nextCategory: WorkflowStatusCategory,
  transitionDate: string,
): WorkItemActualDates {
  const next: WorkItemActualDates = { ...current }
  // Rows recorded before actual dates existed keep their state until the category changes.
  if (previousCategory === nextCategory) return next
  if ((nextCategory === 'started' || nextCategory === 'completed') && !next.actualStartDate) {
    next.actualStartDate = transitionDate
  }
  if (nextCategory === 'completed') {
    const actualEndDate = transitionDate
    next.actualEndDate = actualEndDate
    if (next.actualStartDate && next.actualStartDate > actualEndDate) {
      // A corrected start cannot fall after the completion that just happened.
      next.actualStartDate = actualEndDate
    }
  } else {
    delete next.actualEndDate
  }
  return next
}

/**
 * Actual start and end dates of one Work Item, returned by
 * `GET /api/v1/work-items/{workItemId}/actual-dates`; the closed public Work Item schema omits them.
 */
export type PublicWorkItemActualDates = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item the dates belong to. */
  workItemId: string
  /** Work Item revision the dates were read at. */
  revision: number
  /**
   * Local `YYYY-MM-DD` date, in the schedule calendar timezone, when the Work Item first entered
   * the `started` or `completed` category; absent until work starts.
   */
  actualStartDate?: string
  /**
   * Local `YYYY-MM-DD` date of the latest effective completion; present only while the Work Item is
   * completed.
   */
  actualEndDate?: string
}
