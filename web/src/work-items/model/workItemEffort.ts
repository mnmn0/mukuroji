import {
  DEFAULT_WORK_ITEM_PROGRESS_MODE,
  deriveWorkItemProgressPercent,
  deriveWorkItemRemainingEffortMinutes,
  type WorkItemConfiguration,
  type WorkItemEffortFields,
  type WorkItemPatch,
  type WorkItemSchedule,
} from '@mukuroji/contracts'

/** Effort and progress values a person changed; null clears a value, and absent values are unchanged. */
export type WorkItemEffortProgressChange = {
  /** Canonical estimate in minutes, written into the schedule, or null to clear it. */
  plannedEffortMinutes?: number | null
  /** Recorded remaining minutes, or null to clear it. */
  remainingEffortMinutes?: number | null
  /** Manually recorded progress, or null to clear it. */
  progressPercent?: number | null
}

/**
 * Converts an effort and progress change into a Work Item update.
 *
 * The estimate is the schedule's `plannedEffortMinutes`, so changing it replaces the schedule with
 * the same placement; the server then needs no dependency confirmation.
 *
 * @param change - Changed values.
 * @param schedule - Current canonical schedule of the Work Item.
 * @returns Update fields for the Work Item.
 */
export function toWorkItemEffortPatch(
  change: WorkItemEffortProgressChange,
  schedule: WorkItemSchedule,
): Pick<WorkItemPatch, 'schedule' | 'remainingEffortMinutes' | 'progressPercent'> {
  const { plannedEffortMinutes, ...fields } = change
  if (plannedEffortMinutes === undefined) return fields
  const placement = { ...schedule }
  delete placement.plannedEffortMinutes
  return {
    ...fields,
    schedule: plannedEffortMinutes === null ? placement : { ...placement, plannedEffortMinutes },
  }
}

/** Task view column fields that show a Work Item's estimate, remaining effort, and progress. */
export const WORK_ITEM_EFFORT_COLUMN_FIELDS = ['estimate', 'remainingEffort', 'progress'] as const

/** One of {@link WORK_ITEM_EFFORT_COLUMN_FIELDS}. */
export type WorkItemEffortColumnField = (typeof WORK_ITEM_EFFORT_COLUMN_FIELDS)[number]

/**
 * Returns whether a task view column field is an effort column.
 *
 * @param field - Column field.
 * @returns Whether it names an effort column.
 */
export function isWorkItemEffortColumnField(field: string): field is WorkItemEffortColumnField {
  return WORK_ITEM_EFFORT_COLUMN_FIELDS.some((candidate) => candidate === field)
}

/**
 * Resolves the sortable value of an effort column: minutes for effort, percent for progress.
 *
 * @param item - Work Item effort fields.
 * @param field - Effort column.
 * @param configuration - Work Item configuration that selects the progress mode.
 * @returns The value, or undefined when it is unknown.
 */
export function resolveWorkItemEffortColumnValue(
  item: WorkItemEffortFields,
  field: WorkItemEffortColumnField,
  configuration?: Pick<WorkItemConfiguration, 'progressMode'>,
): number | undefined {
  switch (field) {
    case 'estimate': return item.schedule.plannedEffortMinutes
    case 'remainingEffort': return deriveWorkItemRemainingEffortMinutes(item)
    case 'progress': return deriveWorkItemProgressPercent(item, configuration?.progressMode ?? DEFAULT_WORK_ITEM_PROGRESS_MODE)
  }
}

/**
 * Returns the remaining effort a person recorded, read as zero once the Work Item is completed or
 * canceled, as everywhere else that shows remaining effort.
 *
 * Unlike {@link deriveWorkItemRemainingEffortMinutes}, an open Work Item without a recorded value
 * stays undefined, so a view may fall back to the estimate minus actual time.
 *
 * @param item - Work Item status category and recorded remaining effort.
 * @returns The recorded minutes, 0 for a finished Work Item, or undefined when not recorded.
 */
export function resolveRecordedRemainingEffortMinutes(
  item: Pick<WorkItemEffortFields, 'statusCategory' | 'remainingEffortMinutes'>,
): number | undefined {
  if (item.statusCategory === 'completed' || item.statusCategory === 'canceled') return 0
  return item.remainingEffortMinutes
}

/** The Work Item a detail form's drafts started from, and the revision those drafts are keyed by. */
export type WorkItemDraftBase<T> = {
  /** Work Item the forms last rendered. */
  item: T
  /** Revision that keys the forms' unsaved input. */
  revision: number
}

/**
 * Resolves the revision that keys a detail form's unsaved input.
 *
 * Saving only the estimate, remaining effort, or progress bumps the Work Item revision; the other
 * forms keep their drafts, such as a typed title or a chosen Project or Work Item Type, unless a
 * field they edit changed or another Work Item is shown.
 *
 * @param base - Work Item and revision the drafts started from.
 * @param item - Work Item now shown.
 * @param draftFields - Picks the fields the forms edit, compared as JSON.
 * @returns The revision the drafts keep, or the current revision when they must reset.
 */
export function resolveWorkItemDraftRevision<T extends { id: string; revision: number }>(
  base: WorkItemDraftBase<T>,
  item: T,
  draftFields: (item: T) => unknown,
): number {
  if (base.item === item) return base.revision
  const isSameDraft = base.item.id === item.id &&
    JSON.stringify(draftFields(base.item)) === JSON.stringify(draftFields(item))
  return isSameDraft ? base.revision : item.revision
}
