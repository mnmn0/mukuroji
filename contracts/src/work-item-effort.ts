/**
 * How a Team derives the progress percentage of its Work Items.
 *
 * - `status-category`: backlog and unstarted are 0, started is 50, completed is 100.
 * - `remaining-effort`: `(planned - remaining) / planned`, from the canonical planned effort
 *   (`schedule.plannedEffortMinutes`) and the recorded remaining effort.
 * - `manual`: the percentage people record on the Work Item (`progressPercent`).
 *
 * Every mode reports completed Work Items as 100 and canceled Work Items as not measured, and
 * falls back to `status-category` when its own inputs are missing.
 */
export type WorkItemProgressMode = 'status-category' | 'remaining-effort' | 'manual'

/** Progress modes in the order settings screens present them. */
export const WORK_ITEM_PROGRESS_MODES: readonly WorkItemProgressMode[] = [
  'status-category',
  'remaining-effort',
  'manual',
]

/** Progress mode used when a Work Item configuration does not choose one. */
export const DEFAULT_WORK_ITEM_PROGRESS_MODE: WorkItemProgressMode = 'status-category'

/** Progress percentage reported for a started Work Item under the `status-category` mode. */
export const WORK_ITEM_STARTED_PROGRESS_PERCENT = 50

/** The Work Item fields that effort and progress derivation reads. */
export type WorkItemEffortFields = {
  /** Standard workflow status category (`backlog`, `unstarted`, `started`, `completed`, `canceled`). */
  statusCategory: string
  /** Canonical schedule; `plannedEffortMinutes` is the single source of the estimate. */
  schedule: {
    /** Canonical planned effort (estimate) in minutes. */
    plannedEffortMinutes?: number
  }
  /** Recorded remaining effort in minutes. */
  remainingEffortMinutes?: number
  /** Manually recorded progress percentage. */
  progressPercent?: number
}

/**
 * Returns whether a value is a valid effort amount in minutes.
 *
 * @param value - Candidate value.
 * @returns Whether it is a nonnegative safe integer.
 */
export function isWorkItemEffortMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Returns whether a value is a valid recorded progress percentage.
 *
 * @param value - Candidate value.
 * @returns Whether it is an integer from 0 to 100.
 */
export function isWorkItemProgressPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
}

/**
 * Returns whether a value is a supported progress mode.
 *
 * @param value - Candidate value.
 * @returns Whether it names one of {@link WORK_ITEM_PROGRESS_MODES}.
 */
export function isWorkItemProgressMode(value: unknown): value is WorkItemProgressMode {
  return typeof value === 'string' && WORK_ITEM_PROGRESS_MODES.some((mode) => mode === value)
}

/**
 * Derives the effort still remaining on a Work Item.
 *
 * Completed and canceled Work Items have no remaining effort. Otherwise the recorded remaining
 * effort wins, and an item without one has its whole planned effort remaining.
 *
 * @param item - Work Item effort fields.
 * @returns Remaining minutes, or `undefined` when neither remaining nor planned effort is known.
 */
export function deriveWorkItemRemainingEffortMinutes(item: WorkItemEffortFields): number | undefined {
  if (item.statusCategory === 'completed' || item.statusCategory === 'canceled') return 0
  return item.remainingEffortMinutes ?? item.schedule.plannedEffortMinutes
}

/**
 * Derives a Work Item's progress percentage under a Team progress mode.
 *
 * @param item - Work Item effort fields.
 * @param mode - Team progress mode; the default mode applies when omitted.
 * @returns An integer from 0 to 100, or `undefined` for a canceled Work Item.
 */
export function deriveWorkItemProgressPercent(
  item: WorkItemEffortFields,
  mode: WorkItemProgressMode = DEFAULT_WORK_ITEM_PROGRESS_MODE,
): number | undefined {
  if (item.statusCategory === 'canceled') return undefined
  if (item.statusCategory === 'completed') return 100
  if (mode === 'manual' && item.progressPercent !== undefined) return item.progressPercent
  const planned = item.schedule.plannedEffortMinutes
  if (mode === 'remaining-effort' && planned !== undefined && planned > 0 && item.remainingEffortMinutes !== undefined) {
    const done = planned - Math.min(planned, item.remainingEffortMinutes)
    return Math.round((done * 100) / planned)
  }
  return item.statusCategory === 'started' ? WORK_ITEM_STARTED_PROGRESS_PERCENT : 0
}
