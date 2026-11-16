import type { WorkflowStatusCategory } from '@mukuroji/contracts'

/** Recorded actual dates of one Work Item. */
export type WorkItemActualDates = {
  /** Local date when the Work Item first entered the started or completed category. */
  actualStartDate?: string
  /** Local date of the latest effective completion. */
  actualEndDate?: string
}

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
 * Checks a real `YYYY-MM-DD` calendar date.
 *
 * @param value - Candidate date.
 * @returns True when the value round-trips through UTC calendar arithmetic.
 */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}
