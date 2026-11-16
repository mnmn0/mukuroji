import {
  DEFAULT_WORK_ITEM_PROGRESS_MODE,
  deriveWorkItemProgressPercent,
  deriveWorkItemRemainingEffortMinutes,
  type WorkItemConfiguration,
  type WorkItemEffortFields,
} from '@mukuroji/contracts'

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
