import {
  isProjectScheduleBaselineCapturedAt,
  isProjectScheduleBaselineId,
  isProjectScheduleBaselineName,
  parseProjectScheduleBaselineEntry,
  PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES,
  type ProjectScheduleBaselineEntry,
} from './work-item-schedule-baselines'

/** Most Work Items one Cycle schedule baseline may hold. */
export const CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES = PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES

/** Most named baselines one Cycle keeps. Saving one more drops the oldest one. */
export const CYCLE_SCHEDULE_BASELINE_MAX_SAVED = 10

/** Planned dates and effort of one Work Item frozen when its Cycle baseline was captured. */
export type CycleScheduleBaselineEntry = ProjectScheduleBaselineEntry & {
  /** Team that owns the Work Item; a Cycle may hold Work Items of several Teams. */
  teamId: string
}

/** One named schedule baseline of a Cycle: the committed scope and plan at capture time. */
export type CycleScheduleBaseline = {
  /** Baseline ID. */
  id: string
  /** Name the Cycle manager gave the baseline; absent when none was given. */
  name?: string
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** Number of Work Items the baseline holds, including ones the reader cannot see. */
  entryCount: number
  /** Frozen plan of the Work Items the reader may currently see. */
  entries: CycleScheduleBaselineEntry[]
}

/** What the baseline list shows about one saved Cycle baseline, without its entries. */
export type SavedCycleScheduleBaseline = {
  /** Baseline ID. */
  id: string
  /** Name the Cycle manager gave the baseline; absent when none was given. */
  name?: string
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** Number of Work Items the baseline holds, including ones the reader cannot see. */
  entryCount: number
}

/** Response of the Cycle schedule baseline read and capture endpoints. */
export type CycleScheduleBaselineResponse = {
  /** Cycle the baselines belong to. */
  cycleId: string
  /**
   * Revision of the Cycle's baseline list; 0 before the first capture. It increments on each
   * capture.
   */
  revision: number
  /**
   * The requested baseline: the newest one unless a saved baseline was asked for by ID, or
   * `null` when none has been captured.
   */
  baseline: CycleScheduleBaseline | null
  /** Saved baselines of the Cycle, newest first. */
  savedBaselines: SavedCycleScheduleBaseline[]
}

/** Body of a Cycle baseline capture request. */
export type CaptureCycleScheduleBaselineRequest = {
  /** Optional name; blank names are treated as no name. */
  name?: string
}

/**
 * Validates an untrusted Cycle schedule baseline response.
 *
 * @param value - Parsed response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseCycleScheduleBaselineResponse(value: unknown): CycleScheduleBaselineResponse | undefined {
  if (!isRecord(value)) return undefined
  const { cycleId, revision, baseline, savedBaselines } = value
  if (typeof cycleId !== 'string' || cycleId.length === 0) return undefined
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return undefined
  const saved = parseSavedCycleScheduleBaselines(savedBaselines)
  if (!saved) return undefined
  if (baseline === null) return { cycleId, revision, baseline: null, savedBaselines: saved }
  const parsed = parseCycleScheduleBaseline(baseline)
  return parsed ? { cycleId, revision, baseline: parsed, savedBaselines: saved } : undefined
}

/**
 * Validates one untrusted Cycle baseline with its entries.
 *
 * @param value - Candidate baseline.
 * @returns The baseline, or `undefined` when any part is malformed.
 */
export function parseCycleScheduleBaseline(value: unknown): CycleScheduleBaseline | undefined {
  const summary = parseSavedCycleScheduleBaseline(value)
  if (!summary || !isRecord(value)) return undefined
  const { entries } = value
  if (!Array.isArray(entries) || entries.length > summary.entryCount) return undefined
  const parsed: CycleScheduleBaselineEntry[] = []
  const keys = new Set<string>()
  for (const entry of entries) {
    const item = parseCycleScheduleBaselineEntry(entry)
    if (!item) return undefined
    const key = JSON.stringify([item.teamId, item.workItemId])
    if (keys.has(key)) return undefined
    keys.add(key)
    parsed.push(item)
  }
  return { ...summary, entries: parsed }
}

/**
 * Validates an untrusted list of saved Cycle baselines.
 *
 * @param value - Candidate list.
 * @returns The list, or `undefined` when it is malformed, too long, or repeats an ID.
 */
export function parseSavedCycleScheduleBaselines(value: unknown): SavedCycleScheduleBaseline[] | undefined {
  if (!Array.isArray(value) || value.length > CYCLE_SCHEDULE_BASELINE_MAX_SAVED) return undefined
  const parsed: SavedCycleScheduleBaseline[] = []
  const ids = new Set<string>()
  for (const item of value) {
    const summary = parseSavedCycleScheduleBaseline(item)
    if (!summary || ids.has(summary.id)) return undefined
    ids.add(summary.id)
    parsed.push(summary)
  }
  return parsed
}

/**
 * Validates one untrusted Cycle baseline entry.
 *
 * @param value - Candidate entry.
 * @returns The entry, or `undefined` when it is malformed.
 */
export function parseCycleScheduleBaselineEntry(value: unknown): CycleScheduleBaselineEntry | undefined {
  if (!isRecord(value)) return undefined
  const { teamId } = value
  if (typeof teamId !== 'string' || teamId.length === 0) return undefined
  const entry = parseProjectScheduleBaselineEntry(value)
  return entry ? { teamId, ...entry } : undefined
}

/**
 * Validates the list fields of one saved Cycle baseline.
 *
 * @param value - Candidate value.
 * @returns The list entry, or `undefined` when it is malformed.
 */
function parseSavedCycleScheduleBaseline(value: unknown): SavedCycleScheduleBaseline | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, capturedAt, entryCount } = value
  if (
    !isProjectScheduleBaselineId(id) ||
    (name !== undefined && !isProjectScheduleBaselineName(name)) ||
    !isProjectScheduleBaselineCapturedAt(capturedAt) ||
    typeof entryCount !== 'number' ||
    !Number.isSafeInteger(entryCount) ||
    entryCount < 0 ||
    entryCount > CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES
  ) {
    return undefined
  }
  return { id, ...(typeof name === 'string' ? { name } : {}), capturedAt, entryCount }
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
