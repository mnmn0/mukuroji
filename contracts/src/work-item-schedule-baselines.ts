import {
  countWorkItemCalendarDaysBetween,
  readWorkItemPlannedEndDate,
  readWorkItemPlannedStartDate,
} from './work-item-actual-dates'
import type { WorkItemSchedule } from './work-items'

/** Most Work Items one Project schedule baseline may hold. */
export const PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES = 1000

/** Planned dates of one Work Item frozen when its Project baseline was captured. */
export type ProjectScheduleBaselineEntry = {
  /** Work Item ID within the owning Team. */
  workItemId: string
  /** Planned start date at capture time; absent for deadline-only and unscheduled items. */
  startDate?: string
  /** Planned end date or deadline at capture time; absent for unscheduled items. */
  endDate?: string
}

/** The latest schedule baseline captured for one Project. */
export type ProjectScheduleBaseline = {
  /** Increments each time the baseline is captured again. */
  revision: number
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** Frozen planned dates of the Work Items the reader may see. */
  entries: ProjectScheduleBaselineEntry[]
}

/** Response of the Project schedule baseline read and capture endpoints. */
export type ProjectScheduleBaselineResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the baseline belongs to. */
  projectId: string
  /** Latest baseline, or `null` when none has been captured. */
  baseline: ProjectScheduleBaseline | null
}

/** Signed difference between a Work Item's current plan and its baseline. */
export type WorkItemScheduleSlip = {
  /**
   * Calendar days the planned start moved since the baseline. Positive means later, negative
   * earlier. Absent unless both the baseline and the current plan have a start date.
   */
  startSlipDays?: number
  /**
   * Calendar days the planned end moved since the baseline. Positive means later, negative
   * earlier. Absent unless both the baseline and the current plan have an end date.
   */
  endSlipDays?: number
}

/**
 * Freezes the planned dates of a Work Item schedule as a baseline entry.
 *
 * @param workItemId - Work Item ID.
 * @param schedule - Current Work Item schedule.
 * @returns The entry holding only the dates the schedule has.
 */
export function createProjectScheduleBaselineEntry(
  workItemId: string,
  schedule: WorkItemSchedule,
): ProjectScheduleBaselineEntry {
  const startDate = readWorkItemPlannedStartDate(schedule)
  const endDate = readWorkItemPlannedEndDate(schedule)
  return {
    workItemId,
    ...(startDate === undefined ? {} : { startDate }),
    ...(endDate === undefined ? {} : { endDate }),
  }
}

/**
 * Derives how far a Work Item's current plan moved from its baseline.
 *
 * @param baseline - Frozen planned dates of the Work Item.
 * @param schedule - Current Work Item schedule.
 * @returns Signed start and end slips that both sides support.
 */
export function deriveWorkItemScheduleSlip(
  baseline: ProjectScheduleBaselineEntry,
  schedule: WorkItemSchedule,
): WorkItemScheduleSlip {
  const startSlipDays = countWorkItemCalendarDaysBetween(
    baseline.startDate,
    readWorkItemPlannedStartDate(schedule),
  )
  const endSlipDays = countWorkItemCalendarDaysBetween(
    baseline.endDate,
    readWorkItemPlannedEndDate(schedule),
  )
  return {
    ...(startSlipDays === undefined ? {} : { startSlipDays }),
    ...(endSlipDays === undefined ? {} : { endSlipDays }),
  }
}

/**
 * Validates an untrusted Project schedule baseline response.
 *
 * @param value - Parsed response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseProjectScheduleBaselineResponse(
  value: unknown,
): ProjectScheduleBaselineResponse | undefined {
  if (!isRecord(value)) return undefined
  const { teamId, projectId, baseline } = value
  if (typeof teamId !== 'string' || typeof projectId !== 'string') return undefined
  if (baseline === null) return { teamId, projectId, baseline: null }
  if (!isRecord(baseline)) return undefined
  const { revision, capturedAt, entries } = baseline
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !isProjectScheduleBaselineCapturedAt(capturedAt) ||
    !Array.isArray(entries) ||
    entries.length > PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES
  ) {
    return undefined
  }
  const parsedEntries: ProjectScheduleBaselineEntry[] = []
  for (const entry of entries) {
    const parsed = parseProjectScheduleBaselineEntry(entry)
    if (!parsed) return undefined
    parsedEntries.push(parsed)
  }
  return { teamId, projectId, baseline: { revision, capturedAt, entries: parsedEntries } }
}

/**
 * Validates one untrusted baseline entry.
 *
 * @param value - Candidate entry.
 * @returns The entry, or `undefined` when it is malformed.
 */
export function parseProjectScheduleBaselineEntry(
  value: unknown,
): ProjectScheduleBaselineEntry | undefined {
  if (!isRecord(value)) return undefined
  const { workItemId, startDate, endDate } = value
  if (typeof workItemId !== 'string' || workItemId.length === 0) return undefined
  if (startDate !== undefined && !isCalendarDate(startDate)) return undefined
  if (endDate !== undefined && !isCalendarDate(endDate)) return undefined
  return {
    workItemId,
    ...(typeof startDate === 'string' ? { startDate } : {}),
    ...(typeof endDate === 'string' ? { endDate } : {}),
  }
}

/**
 * Reports whether a value is a baseline capture time: a UTC ISO timestamp as
 * `Date.prototype.toISOString` writes it.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a real capture timestamp.
 */
export function isProjectScheduleBaselineCapturedAt(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

/**
 * Reports whether a value is a real `YYYY-MM-DD` calendar date.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a date string naming a day that exists.
 */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

/**
 * Reports whether a value is a non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
