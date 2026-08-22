import type { WorkItemConfiguration, WorkflowStatusDefinition } from '@mukuroji/contracts'
import type { CanonicalWorkItem, WorkItemPriority } from '../api/tasks'
import {
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
  resolveWorkflowStatusDefinition,
} from '../../work-items/model/workItemDisplay'
import {
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import { resolveTaskCustomFieldEntries } from '../model/taskView'

/** Resolves a localized task-view message. */
type TaskTranslator = (key: MessageKey) => string

/** Props for a heading shared by the project task views. */
export type TaskViewHeadingProps = {
  /** Additional classes applied to the heading container. */
  className?: string
  /** Number of work items represented by the view. */
  count: number
  /** Optional supporting text displayed below the heading. */
  meta?: string
  /** Translator used for localized labels. */
  t: TaskTranslator
  /** Message key for the view title. */
  titleKey: MessageKey
}

/**
 * Renders the common title, item count, and optional metadata for a task view.
 *
 * @param props - Heading content and localization inputs.
 * @returns The task-view heading.
 */
export function TaskViewHeading({
  className = '',
  count,
  meta,
  t,
  titleKey,
}: TaskViewHeadingProps) {
  return (
    <div className={`border-b border-[#e4e7ec] bg-white px-4 py-3 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[#1c1d1f]">{t(titleKey)}</h2>
        <p className="text-sm font-medium text-[#5f6874]">
          {t('tasks.count').replace('{count}', String(count))}
        </p>
      </div>
      {meta ? <p className="mt-1 text-sm font-medium text-[#5f6874]">{meta}</p> : null}
    </div>
  )
}

/** Props for a workflow-status badge in a project task view. */
export type TaskStatusBadgeProps = {
  /** Configuration used to resolve a task's workflow status. */
  configuration?: WorkItemConfiguration
  /** Explicit status definition used by a board column. */
  status?: WorkflowStatusDefinition
  /** Work item whose status should be displayed. */
  task?: CanonicalWorkItem
}

/**
 * Renders a workflow status with the tone associated with its category.
 *
 * @param props - Status definition or task and its configuration.
 * @returns The workflow-status badge, or `null` when no status source is supplied.
 */
export function TaskStatusBadge({
  configuration,
  status,
  task,
}: TaskStatusBadgeProps) {
  if (!status && !task) {
    return null
  }

  const resolvedStatus = status ?? (task
    ? resolveWorkflowStatusDefinition(task, configuration)
    : undefined)
  const category = resolvedStatus?.category ?? (task
    ? resolveWorkflowStatusCategory(task)
    : 'backlog')
  const label = resolvedStatus?.name ?? (task
    ? resolveWorkItemWorkflowStatusLabel(task, configuration)
    : '')

  return (
    <span className={resolveWorkflowCategoryToneClassName(category)}>
      {label}
    </span>
  )
}

/** Props for a task-priority badge. */
export type TaskPriorityBadgeProps = {
  /** Priority represented by the badge. */
  priority: WorkItemPriority
  /** Translator used for the priority label. */
  t: TaskTranslator
}

/**
 * Renders a localized task priority with its existing visual tone.
 *
 * @param props - Priority and localization inputs.
 * @returns The task-priority badge.
 */
export function TaskPriorityBadge({
  priority,
  t,
}: TaskPriorityBadgeProps) {
  const priorityClasses: Record<WorkItemPriority, string> = {
    high: 'workbench-badge-danger',
    medium: 'workbench-badge-warning',
    low: 'workbench-badge-success',
  }

  return (
    <span className={priorityClasses[priority]}>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}

/** Props for the compact custom-field summary shown on task rows and cards. */
export type TaskCustomFieldSummaryProps = {
  /** Configuration containing the custom-field definitions. */
  configuration?: WorkItemConfiguration
  /** Locale used to format custom-field values. */
  locale: Locale
  /** Mapping from person identifiers to display names. */
  personLabels: Readonly<Record<string, string>>
  /** Translator reused for custom-field value labels. */
  t: TaskTranslator
  /** Work item whose custom fields should be summarized. */
  task: CanonicalWorkItem
}

/**
 * Renders up to two custom-field values and an overflow count for a task.
 *
 * @param props - Task, configuration, locale, and person labels.
 * @returns The custom-field summary, or `null` when no values are visible.
 */
export function TaskCustomFieldSummary({
  configuration,
  locale,
  personLabels,
  t,
  task,
}: TaskCustomFieldSummaryProps) {
  const values = resolveTaskCustomFieldEntries(
    task,
    configuration,
    locale,
    personLabels,
    t,
  )

  if (values.length === 0) {
    return null
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {values.slice(0, 2).map(({ definition, value }) => (
        <span
          className="workbench-badge max-w-full truncate"
          key={definition.id}
          title={`${definition.name}: ${value}`}
        >
          {definition.name}: {value}
        </span>
      ))}
      {values.length > 2 ? <span className="workbench-badge">+{values.length - 2}</span> : null}
    </div>
  )
}

/**
 * Renders the plus glyph used by the table's add-task action.
 *
 * @returns The plus glyph.
 */
export function TaskViewPlusIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/**
 * Renders the flag glyph used by the table's priority cell.
 *
 * @returns The flag glyph.
 */
export function TaskViewFlagIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M5 21V5" />
      <path d="M5 5h12l-1.5 4L17 13H5" />
    </svg>
  )
}
