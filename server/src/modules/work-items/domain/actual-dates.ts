import {
  applyWorkItemStatusTransitionToActualDates,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type WorkItemActualDates,
  type WorkflowStatusCategory,
} from '@mukuroji/contracts'

export { applyWorkItemStatusTransitionToActualDates, type WorkItemActualDates }

/** Manager correction of the recorded actual dates; null removes a date. */
export type WorkItemActualDateCorrection = {
  /** Corrected actual start date, or null to remove it. */
  actualStartDate?: string | null
  /** Corrected actual end date, or null to remove it. */
  actualEndDate?: string | null
}

/** Actual date fields stored on a canonical Work Item row. */
export const WORK_ITEM_ACTUAL_DATE_FIELDS = ['actualStartDate', 'actualEndDate'] as const

/** Rejected manager correction of the actual dates. */
export class WorkItemActualDateError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'InvalidWorkItemActualDates'

  /**
   * Creates the error with a client-facing message.
   *
   * @param message - Explanation of the rejected correction.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkItemActualDateError'
  }
}

/**
 * Applies a manager correction on top of the actual dates after any status transition.
 *
 * @param current - Actual dates after the status transition of the same update.
 * @param correction - Requested corrections; omitted fields stay unchanged.
 * @param category - Status category after the update.
 * @param today - Current local date; actual dates cannot lie in the future.
 * @returns The corrected actual dates.
 * @throws WorkItemActualDateError when the correction is invalid.
 */
export function correctWorkItemActualDates(
  current: WorkItemActualDates,
  correction: WorkItemActualDateCorrection,
  category: WorkflowStatusCategory,
  today: string,
): WorkItemActualDates {
  const next: WorkItemActualDates = { ...current }
  for (const field of WORK_ITEM_ACTUAL_DATE_FIELDS) {
    if (!(field in correction)) continue
    const value = correction[field]
    if (value === null) {
      delete next[field]
      continue
    }
    if (!isCalendarDate(value)) {
      throw new WorkItemActualDateError(`${field} must be a YYYY-MM-DD date or null.`)
    }
    if (value > today) {
      throw new WorkItemActualDateError(`${field} cannot be in the future.`)
    }
    next[field] = value
  }
  if (next.actualEndDate !== undefined) {
    if (category !== 'completed') {
      throw new WorkItemActualDateError('Only a completed Work Item can have an actual end date.')
    }
    if (next.actualStartDate === undefined) {
      throw new WorkItemActualDateError('An actual end date requires an actual start date.')
    }
    if (next.actualStartDate > next.actualEndDate) {
      throw new WorkItemActualDateError('The actual start date cannot be after the actual end date.')
    }
  }
  return next
}

/**
 * Checks whether a stored value is a canonical actual date.
 *
 * @param value - Candidate stored value.
 * @returns True when absent or a real `YYYY-MM-DD` date.
 */
export function isOptionalWorkItemActualDate(value: unknown): value is string | undefined {
  return value === undefined || isCalendarDate(value)
}

/**
 * Checks a real `YYYY-MM-DD` calendar date inside the supported canonical date range.
 *
 * @param value - Candidate date.
 * @returns True when the year is at least `WORK_ITEM_SCHEDULE_MIN_YEAR` and the value round-trips
 *   through UTC calendar arithmetic.
 */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  // Schedules and the Gantt timeline reject earlier years, so actual dates use the same range.
  if (Number(value.slice(0, 4)) < WORK_ITEM_SCHEDULE_MIN_YEAR) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}
