import type { WorkflowStatusDefinition, WorkItemConfiguration } from '@mukuroji/contracts'
import { type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { type TeamIssue } from '../api'
import type { WorkItemPriority } from '../../tasks/api'
import {
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
  resolveWorkflowStatusDefinition,
} from '../../work-items/model/workItemDisplay'
import { resolveIssueCustomFieldEntries } from '../model/teamIssueDisplay'

/**
 * Renders the workflow status badge of a Work Item.
 *
 * @param props - Badge props.
 * @returns The status badge.
 */
export function IssueStatusBadge({
  configuration,
  issue,
  status,
}: {
  /** Status definition の解決に使う configuration です。 */
  configuration?: WorkItemConfiguration
  /** 一覧で status を表示する Issue です。 */
  issue?: TeamIssue
  /** Board column で直接表示する status definition です。 */
  status?: WorkflowStatusDefinition
}) {
  const resolvedStatus = status ?? (issue
    ? resolveWorkflowStatusDefinition(issue, configuration)
    : undefined)
  const category = resolvedStatus?.category ?? (issue
    ? resolveWorkflowStatusCategory(issue)
    : 'backlog')
  const label = resolvedStatus?.name ?? (issue
    ? resolveWorkItemWorkflowStatusLabel(issue, configuration)
    : '')

  return (
    <span className={resolveWorkflowCategoryToneClassName(category)}>
      {label}
    </span>
  )
}

/**
 * Renders a compact summary of a Work Item's custom field values.
 *
 * @param props - Summary props.
 * @returns The custom field summary, or nothing when no value is set.
 */
export function IssueCustomFieldSummary({
  configuration,
  issue,
  locale,
  personLabels,
}: {
  /** Custom field definition を含む configuration です。 */
  configuration?: WorkItemConfiguration
  /** 表示対象 Issue です。 */
  issue: TeamIssue
  /** 値の format locale です。 */
  locale: Locale
  /** Person field ID を表示名へ解決する map です。 */
  personLabels: Readonly<Record<string, string>>
}) {
  const values = resolveIssueCustomFieldEntries(issue, configuration, locale, personLabels)

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
      {values.length > 2 ? (
        <span className="workbench-badge">+{values.length - 2}</span>
      ) : null}
    </div>
  )
}

/**
 * Renders the priority badge of a Work Item.
 *
 * @param props - Badge props.
 * @returns The priority badge.
 */
export function IssuePriorityBadge({ priority, t }: { priority: WorkItemPriority; t: (key: MessageKey) => string }) {
  const classes: Record<WorkItemPriority, string> = {
    high: 'workbench-badge-danger',
    low: 'workbench-badge-success',
    medium: 'workbench-badge-warning',
  }

  return (
    <span className={classes[priority]}>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}
