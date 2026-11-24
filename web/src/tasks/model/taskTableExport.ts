import {
  deriveWorkItemBaselineEndDelayDays,
  deriveWorkItemScheduleVariance,
  type CanonicalWorkItem,
  type ProjectScheduleBaselineEntry,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { TaskViewExportTable } from '../../task-views/model/taskViewExport'
import { formatPlannedEffortHours } from '../../work-items/model/contributorAssignments'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
  resolveWorkItemTypeLabel,
  resolveWorkItemWorkflowStatusLabel,
} from '../../work-items/model/workItemDisplay'
import {
  resolveWorkItemEffortColumnValue,
  WORK_ITEM_EFFORT_COLUMN_FIELDS,
  type WorkItemEffortColumnField,
} from '../../work-items/model/workItemEffort'
import { WORK_ITEM_BASELINE_END_DELAY_COLUMN } from '../../work-items/model/workItemScheduleBaselines'
import { formatTaskScheduleVariance } from './taskActualDates'
import {
  formatTaskScheduleRange,
  resolveTaskSchedule,
  taskScheduleModeLabelKeys,
} from './taskSchedule'
import { resolveTaskCustomFieldEntries } from './taskView'

/** Resolves a localized task-table message. */
type TaskTableExportTranslator = (key: MessageKey) => string

/** What the table export needs to write cells as the table shows them. */
export type TaskTableExportContext = {
  /** Heading of a column, as the table labels it. */
  columnLabel: (field: string) => string
  /** Configuration of the Team that owns a Work Item. */
  configurationFor: (task: CanonicalWorkItem) => WorkItemConfiguration | undefined
  /** Active schedule baseline entry of a Work Item, while the table reads baselines. */
  scheduleBaselineFor?: (task: CanonicalWorkItem) => ProjectScheduleBaselineEntry | undefined
  /** Locale used by typed custom-field values; without it custom-field cells are empty. */
  locale?: Locale
  /** Person identities mapped to display labels. */
  personLabels?: Readonly<Record<string, string>>
  /** Translator the table uses. */
  t: TaskTableExportTranslator
  /** Cell text of a column that this table shows differently, or undefined to use the default. */
  cellOverride?: (field: string, task: CanonicalWorkItem) => string | undefined
}

/**
 * Builds the export table of a task table: its columns, and its rows in display order.
 *
 * @param tasks - Rows in the order the table shows them.
 * @param fields - Column fields in the order the table shows them.
 * @param context - Labels and lookups the table uses.
 * @returns Headings and one text cell per column for each row.
 */
export function createTaskTableExportTable(
  tasks: readonly CanonicalWorkItem[],
  fields: readonly string[],
  context: TaskTableExportContext,
): TaskViewExportTable {
  return {
    columns: fields.map(context.columnLabel),
    rows: tasks.map((task) => {
      const configuration = context.configurationFor(task)
      return fields.map((field) =>
        context.cellOverride?.(field, task) ??
          resolveTaskTableExportCell(field, task, configuration, context))
    }),
  }
}

/**
 * Writes one cell as the table shows it, without the dash of an empty cell.
 *
 * @param field - Column field.
 * @param task - Row.
 * @param configuration - Configuration of the row's Team.
 * @param context - Labels and lookups the table uses.
 * @returns Cell text; `''` when the table shows no value.
 */
function resolveTaskTableExportCell(
  field: string,
  task: CanonicalWorkItem,
  configuration: WorkItemConfiguration | undefined,
  context: TaskTableExportContext,
): string {
  const { t } = context
  switch (field) {
    case 'title': return resolveWorkItemTitle(task)
    case 'assignee': return task.assigneeUserId ? resolveWorkItemAssignee(task) : ''
    case 'status': return resolveWorkItemWorkflowStatusLabel(task, configuration)
    case 'workItemType': return resolveWorkItemTypeLabel(task, configuration)
    case 'dueDate': {
      const schedule = resolveTaskSchedule(task)
      const range = formatTaskScheduleRange(schedule)
      return `${t(taskScheduleModeLabelKeys[schedule.mode])}${range ? `: ${range}` : ''}`
    }
    case 'actualStartDate':
    case 'actualEndDate': return task[field] ?? ''
    case 'startDelayDays':
    case 'completionDelayDays': return formatDelay(deriveWorkItemScheduleVariance(task)[field], t)
    case WORK_ITEM_BASELINE_END_DELAY_COLUMN: {
      const baseline = context.scheduleBaselineFor?.(task)
      return formatDelay(baseline ? deriveWorkItemBaselineEndDelayDays(baseline, task) : undefined, t)
    }
    case 'priority': return t(`tasks.priority.${task.priority}`)
    case 'project': return task.assignedProjectId ?? ''
    case 'team': return task.teamId
    case 'customFields':
      return listCustomFieldEntries(task, configuration, context)
        .map((entry) => `${entry.definition.name}: ${entry.value}`)
        .join('; ')
    default: {
      if (isEffortField(field)) return formatEffort(task, field, configuration, t)
      if (!field.startsWith('custom:')) return ''
      const customFieldId = field.slice('custom:'.length)
      return listCustomFieldEntries(task, configuration, context)
        .find((entry) => entry.definition.id === customFieldId)?.value ?? ''
    }
  }
}

/**
 * Lists a row's custom-field values as the table shows them.
 *
 * @param task - Row.
 * @param configuration - Configuration of the row's Team.
 * @param context - Labels and lookups the table uses.
 * @returns The populated fields, or none when the table has no locale for typed values.
 */
function listCustomFieldEntries(
  task: CanonicalWorkItem,
  configuration: WorkItemConfiguration | undefined,
  context: TaskTableExportContext,
) {
  if (!context.locale) return []
  return resolveTaskCustomFieldEntries(task, configuration, context.locale, context.personLabels ?? {}, context.t)
}

/**
 * Formats a signed delay in days, leaving an unknown delay empty.
 *
 * @param days - Delay, or undefined when it is unknown.
 * @param t - Translator.
 * @returns The label, or `''`.
 */
function formatDelay(days: number | undefined, t: TaskTableExportTranslator): string {
  return days === undefined ? '' : formatTaskScheduleVariance(days, t)
}

/**
 * Formats an estimate or remaining effort in hours, or progress in percent.
 *
 * @param task - Row.
 * @param field - Effort column.
 * @param configuration - Configuration that selects the progress mode.
 * @param t - Translator.
 * @returns The value, or `''` when it is unknown.
 */
function formatEffort(
  task: CanonicalWorkItem,
  field: WorkItemEffortColumnField,
  configuration: WorkItemConfiguration | undefined,
  t: TaskTableExportTranslator,
): string {
  const value = resolveWorkItemEffortColumnValue(task, field, configuration)
  if (value === undefined) return ''
  return field === 'progress'
    ? `${value}%`
    : t('workItems.effort.hours').replace('{hours}', formatPlannedEffortHours(value))
}

/**
 * Reports whether a column field is an effort column.
 *
 * @param field - Column field.
 * @returns Whether the field is an estimate, remaining-effort, or progress column.
 */
function isEffortField(field: string): field is WorkItemEffortColumnField {
  return WORK_ITEM_EFFORT_COLUMN_FIELDS.some((effortField) => effortField === field)
}
