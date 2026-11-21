import {
  countWorkItemCalendarDaysBetween,
  readWorkItemPlannedEndDate,
  readWorkItemPlannedStartDate,
} from './work-item-actual-dates'
import type { CanonicalWorkItem, WorkItemSchedule } from './work-items'

/** Most Work Items one Project schedule baseline may hold. */
export const PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES = 1000

/**
 * Most named baselines one Project keeps. Saving one more drops the oldest baseline that is not
 * the active one.
 */
export const PROJECT_SCHEDULE_BASELINE_MAX_SAVED = 20

/** Longest baseline name, in UTF-16 code units, after trimming. */
export const PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH = 80

/** Planned dates of one Work Item frozen when its Project baseline was captured. */
export type ProjectScheduleBaselineEntry = {
  /** Work Item ID within the owning Team. */
  workItemId: string
  /** Planned start date at capture time; absent for deadline-only and unscheduled items. */
  startDate?: string
  /** Planned end date or deadline at capture time; absent for unscheduled items. */
  endDate?: string
  /** Planned effort in minutes at capture time; absent when the Work Item had no estimate. */
  plannedEffortMinutes?: number
}

/** One schedule baseline of a Project: the active one or a saved named one. */
export type ProjectScheduleBaseline = {
  /**
   * Revision of the Project's active baseline when this baseline was written. It increments each
   * time a baseline is saved or another saved baseline is made active.
   */
  revision: number
  /**
   * Baseline ID. Absent only for a baseline saved before named baselines existed, until the next
   * save or switch keeps it under a `legacy-r<revision>` ID.
   */
  id?: string
  /** Name the Project manager gave the baseline; absent when none was given. */
  name?: string
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** Frozen planned dates of the Work Items the reader may see. */
  entries: ProjectScheduleBaselineEntry[]
}

/** What the baseline list shows about one saved baseline, without its entries. */
export type SavedProjectScheduleBaseline = {
  /** Baseline ID. */
  id: string
  /** Name the Project manager gave the baseline; absent when none was given. */
  name?: string
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** Number of Work Items the baseline holds, including ones the reader cannot see. */
  entryCount: number
}

/** Response of the Project schedule baseline read, capture, and switch endpoints. */
export type ProjectScheduleBaselineResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the baseline belongs to. */
  projectId: string
  /**
   * The requested baseline: the active one unless a saved baseline was asked for by ID, or
   * `null` when none has been captured.
   */
  baseline: ProjectScheduleBaseline | null
  /**
   * ID of the active baseline that the Gantt, the tables, Focus, and Planning updates compare
   * against. Absent when the Project has no baseline.
   */
  activeBaselineId?: string
  /** Saved baselines of the Project, newest first, including the active one. */
  savedBaselines: SavedProjectScheduleBaseline[]
}

/** Body of a baseline capture request. */
export type CaptureProjectScheduleBaselineRequest = {
  /** Optional name; blank names are treated as no name. */
  name?: string
}

/** Body of a request that makes a saved baseline the active one. */
export type ActivateProjectScheduleBaselineRequest = {
  /** Saved baseline to make active. */
  baselineId: string
  /** Revision of the active baseline the caller read; the switch fails if it changed. */
  expectedRevision: number
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
  /**
   * Minutes the planned effort grew since the baseline. Positive means more effort, negative
   * less. Absent unless both the baseline and the current plan have an estimate.
   */
  effortDeltaMinutes?: number
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
  const { plannedEffortMinutes } = schedule
  return {
    workItemId,
    ...(startDate === undefined ? {} : { startDate }),
    ...(endDate === undefined ? {} : { endDate }),
    ...(plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }),
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
  const effortDeltaMinutes =
    baseline.plannedEffortMinutes === undefined || schedule.plannedEffortMinutes === undefined
      ? undefined
      : schedule.plannedEffortMinutes - baseline.plannedEffortMinutes
  return {
    ...(startSlipDays === undefined ? {} : { startSlipDays }),
    ...(endSlipDays === undefined ? {} : { endSlipDays }),
    ...(effortDeltaMinutes === undefined ? {} : { effortDeltaMinutes }),
  }
}

/** Work Item fields that decide how far it ends behind its baseline. */
export type WorkItemBaselineDelaySource = Pick<CanonicalWorkItem, 'schedule' | 'statusCategory' | 'actualEndDate'>

/**
 * Counts how many calendar days a Work Item ends after its baseline end, the "delay" that the
 * weekly summary, the Gantt baseline overlay, and the Team table share.
 *
 * A completed Work Item is measured by its actual end date, an open one by its current planned
 * end. A canceled Work Item, a completed one without an actual end, and a baseline entry without
 * an end have no delay.
 *
 * @param baseline - Frozen planned dates of the Work Item.
 * @param workItem - Current schedule, status category, and actual end date.
 * @returns Signed days; positive means behind the baseline, negative ahead of it.
 */
export function deriveWorkItemBaselineEndDelayDays(
  baseline: ProjectScheduleBaselineEntry,
  workItem: WorkItemBaselineDelaySource,
): number | undefined {
  if (workItem.statusCategory === 'canceled') return undefined
  const measuredEnd = workItem.statusCategory === 'completed'
    ? workItem.actualEndDate
    : readWorkItemPlannedEndDate(workItem.schedule)
  return countWorkItemCalendarDaysBetween(baseline.endDate, measuredEnd)
}

/**
 * Days a Work Item must end behind its Project baseline before its assignee is notified. It
 * matches the default Focus `slipped` threshold.
 */
export const WORK_ITEM_BASELINE_SLIP_NOTIFICATION_DAYS = 3

/** How one change moved an open Work Item further behind its Project's active baseline. */
export type WorkItemBaselineSlipChange = {
  /** Revision of the active baseline the delay was measured against. */
  baselineRevision: number
  /** Planned end the baseline froze for the Work Item. */
  baselineEndDate: string
  /** Days behind the baseline before the change; absent when it had no comparable end. */
  previousDelayDays?: number
  /** Days behind the baseline after the change; always at least one. */
  delayDays: number
}

/**
 * Detects a change that leaves an open Work Item later behind its baseline than before.
 *
 * A change only counts when the Work Item is still open afterwards and now ends at least one day
 * after the baseline end, later than it did before. Completing, canceling, or pulling the end in
 * never counts, so the weekly summary's completed delays do not raise new alerts.
 *
 * @param baselineRevision - Revision of the active baseline holding the entry.
 * @param baseline - Frozen planned dates of the Work Item.
 * @param before - Work Item before the change; `undefined` when it had no place in this baseline,
 *   such as a Work Item that just moved into the Project.
 * @param after - Work Item after the change.
 * @returns The slip, or `undefined` when the change did not make the Work Item later.
 */
export function deriveWorkItemBaselineSlipChange(
  baselineRevision: number,
  baseline: ProjectScheduleBaselineEntry,
  before: WorkItemBaselineDelaySource | undefined,
  after: WorkItemBaselineDelaySource,
): WorkItemBaselineSlipChange | undefined {
  if (baseline.endDate === undefined) return undefined
  if (after.statusCategory === 'completed' || after.statusCategory === 'canceled') return undefined
  const delayDays = deriveWorkItemBaselineEndDelayDays(baseline, after)
  if (delayDays === undefined || delayDays < 1) return undefined
  const previousDelayDays = before === undefined
    ? undefined
    : deriveWorkItemBaselineEndDelayDays(baseline, before)
  if (previousDelayDays !== undefined && previousDelayDays >= delayDays) return undefined
  return {
    baselineRevision,
    baselineEndDate: baseline.endDate,
    ...(previousDelayDays === undefined ? {} : { previousDelayDays }),
    delayDays,
  }
}

/**
 * Tells whether a slip moved the Work Item from under a threshold to at or over it.
 *
 * @param slip - Slip recorded for one change.
 * @param thresholdDays - Days behind the baseline that count as slipped.
 * @returns Whether this change is the one that crossed the threshold.
 */
export function crossesWorkItemBaselineSlipThreshold(
  slip: Pick<WorkItemBaselineSlipChange, 'previousDelayDays' | 'delayDays'>,
  thresholdDays: number,
): boolean {
  return slip.delayDays >= thresholdDays &&
    (slip.previousDelayDays === undefined || slip.previousDelayDays < thresholdDays)
}

/**
 * Validates a slip read back from stored or streamed event metadata.
 *
 * @param value - Untrusted metadata value.
 * @returns The slip, or `undefined` when any part is malformed.
 */
export function parseWorkItemBaselineSlipChange(value: unknown): WorkItemBaselineSlipChange | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const baselineRevision: unknown = Reflect.get(value, 'baselineRevision')
  const baselineEndDate: unknown = Reflect.get(value, 'baselineEndDate')
  const previousDelayDays: unknown = Reflect.get(value, 'previousDelayDays')
  const delayDays: unknown = Reflect.get(value, 'delayDays')
  if (typeof baselineRevision !== 'number' || !Number.isSafeInteger(baselineRevision) || baselineRevision < 1) return undefined
  if (typeof baselineEndDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(baselineEndDate)) return undefined
  if (typeof delayDays !== 'number' || !Number.isSafeInteger(delayDays) || delayDays < 1) return undefined
  if (previousDelayDays !== undefined && (
    typeof previousDelayDays !== 'number' ||
    !Number.isSafeInteger(previousDelayDays) ||
    previousDelayDays >= delayDays
  )) return undefined
  return {
    baselineRevision,
    baselineEndDate,
    ...(typeof previousDelayDays === 'number' ? { previousDelayDays } : {}),
    delayDays,
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
  const { teamId, projectId, baseline, activeBaselineId, savedBaselines } = value
  if (typeof teamId !== 'string' || typeof projectId !== 'string') return undefined
  if (activeBaselineId !== undefined && !isProjectScheduleBaselineId(activeBaselineId)) return undefined
  // Servers before named baselines sent no list.
  const saved = savedBaselines === undefined ? [] : parseSavedProjectScheduleBaselines(savedBaselines)
  if (!saved) return undefined
  const list = { ...(activeBaselineId === undefined ? {} : { activeBaselineId }), savedBaselines: saved }
  if (baseline === null) return { teamId, projectId, baseline: null, ...list }
  const parsed = parseProjectScheduleBaseline(baseline)
  return parsed ? { teamId, projectId, baseline: parsed, ...list } : undefined
}

/**
 * Validates one untrusted baseline with its entries.
 *
 * @param value - Candidate baseline.
 * @returns The baseline, or `undefined` when any part is malformed.
 */
export function parseProjectScheduleBaseline(value: unknown): ProjectScheduleBaseline | undefined {
  if (!isRecord(value)) return undefined
  const { revision, id, name, capturedAt, entries } = value
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (id !== undefined && !isProjectScheduleBaselineId(id)) ||
    (name !== undefined && !isProjectScheduleBaselineName(name)) ||
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
  return {
    revision,
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    capturedAt,
    entries: parsedEntries,
  }
}

/**
 * Validates an untrusted list of saved baselines.
 *
 * @param value - Candidate list.
 * @returns The list, or `undefined` when it is malformed, too long, or repeats an ID.
 */
export function parseSavedProjectScheduleBaselines(value: unknown): SavedProjectScheduleBaseline[] | undefined {
  // The active baseline of a legacy row is listed once more than the saved limit while it waits
  // to be kept under its own ID.
  if (!Array.isArray(value) || value.length > PROJECT_SCHEDULE_BASELINE_MAX_SAVED + 1) return undefined
  const parsed: SavedProjectScheduleBaseline[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const { id, name, capturedAt, entryCount } = item
    if (
      !isProjectScheduleBaselineId(id) ||
      ids.has(id) ||
      (name !== undefined && !isProjectScheduleBaselineName(name)) ||
      !isProjectScheduleBaselineCapturedAt(capturedAt) ||
      typeof entryCount !== 'number' ||
      !Number.isSafeInteger(entryCount) ||
      entryCount < 0 ||
      entryCount > PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES
    ) {
      return undefined
    }
    ids.add(id)
    parsed.push({ id, ...(typeof name === 'string' ? { name } : {}), capturedAt, entryCount })
  }
  return parsed
}

/**
 * Normalizes a requested baseline name.
 *
 * @param value - Raw name from the request.
 * @returns The trimmed name, `undefined` for no name, or `null` when the name is invalid.
 */
export function normalizeProjectScheduleBaselineName(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return isProjectScheduleBaselineName(trimmed) ? trimmed : null
}

/**
 * Reports whether a value is a stored baseline name: trimmed, 1 to 80 code units, and free of
 * control characters.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a valid name.
 */
export function isProjectScheduleBaselineName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value)
  )
}

/**
 * Reports whether a value is a baseline ID: 1 to 64 letters, digits, `-`, or `_`.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a valid baseline ID.
 */
export function isProjectScheduleBaselineId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value)
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
  const { workItemId, startDate, endDate, plannedEffortMinutes } = value
  if (typeof workItemId !== 'string' || workItemId.length === 0) return undefined
  if (startDate !== undefined && !isCalendarDate(startDate)) return undefined
  if (endDate !== undefined && !isCalendarDate(endDate)) return undefined
  if (
    plannedEffortMinutes !== undefined &&
    (typeof plannedEffortMinutes !== 'number' || !Number.isSafeInteger(plannedEffortMinutes) || plannedEffortMinutes < 0)
  ) {
    return undefined
  }
  return {
    workItemId,
    ...(typeof startDate === 'string' ? { startDate } : {}),
    ...(typeof endDate === 'string' ? { endDate } : {}),
    ...(typeof plannedEffortMinutes === 'number' ? { plannedEffortMinutes } : {}),
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
