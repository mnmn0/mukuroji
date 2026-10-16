import type { WorkItemConfiguration } from '@mukuroji/contracts'
import { Fragment, type CSSProperties } from 'react'
import { MoreHorizontalIcon } from '../../shared/ui/icons'
import { type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { type TeamIssue } from '../api'
import { type ProjectDirectoryTeam } from '../../projects/api'
import { TaskWorkItemTypeBadge } from '../../tasks/ui/TaskViewPrimitives'
import type { WorkspaceMember } from '../../workspace/api'
import {
  resolveWorkItemDependencySummary,
  type WorkItemDependencySummary,
} from '../../work-items/model/workItemDependencies'
import { WorkItemDependencyChips } from '../../work-items/ui/WorkItemDependencyChips'
import { resolveWorkItemAssignee } from '../../work-items/model/workItemDisplay'
import {
  groupTaskViewItems,
  resolveTaskViewTableColumnPlacements,
  type TaskViewPresentationSettings,
  type TaskViewTableColumnPlacement,
} from '../../task-views/model/taskViewPresentation'
import { createTaskViewItemKey } from '../../task-views/model/taskViewSelection'
import { WorkItemAssigneeAvatar } from '../../work-items/ui/WorkItemAssigneeAvatar'
import {
  resolveAssignedProjectName,
  resolveIssueCustomFieldEntries,
  resolveIssueTitle,
  resolveTeamIssueGroupValue,
} from '../model/teamIssueDisplay'
import { IssueCustomFieldSummary, IssuePriorityBadge, IssueStatusBadge } from './TeamIssueBadges'
import { type TeamIssueActionMenuOpenHandler } from './teamIssueScreenShared'

/**
 * Renders the Team Work Items as a grouped, keyboard-navigable table.
 *
 * @param props - Table props.
 * @returns The Work Item table.
 */
export function IssueTable({
  activeTeam,
  configuration,
  dependencySummaries,
  focusedIssueKey,
  issues,
  isAiOperationPending,
  locale,
  onIssueActionMenuOpen,
  onOpenIssue,
  presentation,
  selectedIssueKeys,
  selectedIssueId,
  t,
  workspaceMembers,
}: {
  activeTeam?: ProjectDirectoryTeam
  configuration?: WorkItemConfiguration
  dependencySummaries: Readonly<Record<string, WorkItemDependencySummary>>
  focusedIssueKey?: string
  issues: TeamIssue[]
  /** Whether Team Issue navigation and row actions are fenced during an AI operation. */
  isAiOperationPending: boolean
  locale: Locale
  /** Opens the canonical action menu for one Team Issue row. */
  onIssueActionMenuOpen?: TeamIssueActionMenuOpenHandler
  onOpenIssue?: (issue: TeamIssue) => void
  presentation?: TaskViewPresentationSettings
  selectedIssueKeys: readonly string[]
  selectedIssueId?: string
  t: (key: MessageKey) => string
  workspaceMembers: WorkspaceMember[]
}) {
  const personLabels = Object.fromEntries(
    workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
  )
  const visibleColumns = (presentation?.columns ?? [
    { field: 'title' },
    { field: 'project' },
    { field: 'assignee' },
    { field: 'status' },
    { field: 'customFields' },
    { field: 'dueDate' },
    { field: 'priority' },
  ]).filter((column) => isSupportedTeamIssueColumn(column.field))
  const renderedColumns = visibleColumns.some((column) => column.field === 'title')
    ? visibleColumns
    : [{ field: 'title' }, ...visibleColumns]
  const tableColumnPlacements = resolveTaskViewTableColumnPlacements(renderedColumns)
  const tableMinimumWidth = Math.max(
    720,
    tableColumnPlacements.reduce((total, placement) => total + placement.width, 0),
  )
  const cellPadding = resolveIssueTableCellPadding(presentation?.density)
  const titleCellPadding = resolveIssueTableCellPadding(presentation?.density, true)
  const wrapText = presentation?.display.wrapTitles ?? false
  const showAssigneeAvatar = presentation?.display.showAssigneeAvatars ?? false
  const groups = presentation?.groupBy
    ? groupTaskViewItems(
        issues,
        presentation.groupBy,
        (issue, field) => resolveTeamIssueGroupValue(issue, field, configuration, activeTeam, t),
        presentation.groupDirection,
      )
    : undefined

  /** Renders one Team Issue row under its current table presentation. */
  const renderIssueRow = (issue: TeamIssue) => {
    const issueKey = createTaskViewItemKey(issue.teamId, issue.id)
    const focusedForAction = focusedIssueKey === issueKey
    const selectedForAction = selectedIssueKeys.includes(issueKey)
    const customFieldEntries = new Map(
      resolveIssueCustomFieldEntries(issue, configuration, locale, personLabels).map(
        (entry) => [entry.definition.id, entry.value],
      ),
    )
    return (
      <tr
        className={`border-b border-slate-100 transition last:border-b-0 ${
          selectedIssueId === issue.id ? 'workbench-row-selected' : ''
        } ${selectedForAction ? 'bg-blue-50/70' : ''} ${
          focusedForAction ? 'outline outline-2 -outline-offset-2 outline-blue-500/40' : ''
        }`}
        data-task-view-focused={focusedForAction ? 'true' : 'false'}
        data-task-view-selected={selectedForAction ? 'true' : 'false'}
        key={issue.id}
        onContextMenu={(event) => {
          if (isAiOperationPending || !onIssueActionMenuOpen) return
          event.preventDefault()
          onIssueActionMenuOpen(
            issue,
            { x: event.clientX, y: event.clientY },
            event.currentTarget,
          )
        }}
        tabIndex={-1}
      >
        {tableColumnPlacements.map((placement) => {
          const field = placement.column.field
          const columnCellProps = {
            'data-column-field': field,
            'data-column-pin': placement.column.pin,
            style: resolveIssueTableColumnCellStyle(placement),
          }
          switch (field) {
            case 'title': return (
              <td {...columnCellProps} className={`${titleCellPadding} text-sm font-semibold text-[var(--workbench-text)]`} key={field}>
                <div className="flex min-w-0 items-start gap-2">
                  <button
                    aria-pressed={selectedForAction || selectedIssueId === issue.id}
                    className={`min-w-0 flex-1 rounded-sm text-left font-semibold transition hover:text-[var(--workbench-primary-text)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-tone-2563eb/10 disabled:cursor-default disabled:text-[var(--workbench-text)] ${
                      wrapText ? 'whitespace-normal break-words' : 'truncate'
                    }`}
                    data-testid={`issue-row-${issue.id}`}
                    disabled={isAiOperationPending || !onOpenIssue}
                    onClick={() => onOpenIssue?.(issue)}
                    type="button"
                  >
                    {resolveIssueTitle(issue, t)}
                  </button>
                  {onIssueActionMenuOpen ? (
                    <button
                      aria-label={`${t('tasks.action.more')}: ${resolveIssueTitle(issue, t)}`}
                      className="grid h-9 w-9 flex-none place-items-center rounded text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary-text)] max-[640px]:h-11 max-[640px]:w-11"
                      data-testid={`team-issue-row-actions-${issue.id}`}
                      disabled={isAiOperationPending}
                      onClick={(event) => {
                        if (isAiOperationPending) return
                        const returnFocusElement = event.currentTarget
                        const bounds = returnFocusElement.getBoundingClientRect()
                        onIssueActionMenuOpen(
                          issue,
                          { x: bounds.right, y: bounds.bottom },
                          returnFocusElement,
                        )
                      }}
                      type="button"
                    >
                      <MoreHorizontalIcon className="h-5 w-5" />
                    </button>
                  ) : null}
                </div>
                <WorkItemDependencyChips
                  className="pt-2"
                  summary={resolveWorkItemDependencySummary(
                    dependencySummaries,
                    { teamId: issue.teamId, workItemId: issue.id },
                  )}
                  t={t}
                />
              </td>
            )
            case 'project': return (
              <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                {resolveAssignedProjectName(issue, activeTeam, t)}
              </td>
            )
            case 'assignee': return (
              <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                <div className="flex min-w-0 items-center gap-2">
                  {showAssigneeAvatar ? (
                    <WorkItemAssigneeAvatar label={resolveWorkItemAssignee(issue)} />
                  ) : null}
                  <span className="truncate">{resolveWorkItemAssignee(issue)}</span>
                </div>
              </td>
            )
            case 'status': return (
              <td {...columnCellProps} className={cellPadding} key={field}>
                <IssueStatusBadge configuration={configuration} issue={issue} />
              </td>
            )
            case 'workItemType': return (
              <td {...columnCellProps} className={cellPadding} key={field}>
                <TaskWorkItemTypeBadge configuration={configuration} task={issue} />
              </td>
            )
            case 'customFields': return (
              <td {...columnCellProps} className={`max-w-64 ${cellPadding}`} key={field}>
                <IssueCustomFieldSummary
                  configuration={configuration}
                  issue={issue}
                  locale={locale}
                  personLabels={personLabels}
                />
              </td>
            )
            case 'dueDate': return (
              <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                {issue.dueDate}
              </td>
            )
            case 'priority': return (
              <td {...columnCellProps} className={cellPadding} key={field}>
                <IssuePriorityBadge priority={issue.priority} t={t} />
              </td>
            )
            case 'team': return (
              <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                {issue.teamId}
              </td>
            )
            default: {
              const customFieldId = field.slice('custom:'.length)
              return (
                <td {...columnCellProps} className={`${cellPadding} text-sm font-medium text-[var(--workbench-muted)]`} key={field}>
                  {customFieldEntries.get(customFieldId) ?? '—'}
                </td>
              )
            }
          }
        })}
      </tr>
    )
  }

  return (
    <section className="workbench-table mt-5 overflow-hidden">
      <div className="overflow-x-auto">
        <table
          className="w-full table-fixed border-collapse"
          style={{ minWidth: tableMinimumWidth }}
        >
          <colgroup>
            {tableColumnPlacements.map((placement) => (
              <col key={placement.column.field} style={{ width: placement.width }} />
            ))}
          </colgroup>
          <thead>
            <tr className="workbench-table-head text-left">
              {tableColumnPlacements.map((placement) => (
                <th
                  className={`${placement.column.field === 'title' ? 'px-5 py-3' : 'px-4 py-3'} ${
                    placement.column.pin ? 'bg-[var(--workbench-surface-muted)]' : ''
                  }`}
                  data-column-field={placement.column.field}
                  data-column-pin={placement.column.pin}
                  key={placement.column.field}
                  scope="col"
                  style={resolveIssueTableColumnCellStyle(placement, true)}
                >
                  {resolveIssueTableColumnLabel(placement.column.field, configuration, t)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {issues.length > 0 ? (
              groups ? groups.map((group) => {
                const subgroups = presentation?.subgroupBy
                  ? groupTaskViewItems(
                      group.items,
                      presentation.subgroupBy,
                      (issue, field) => resolveTeamIssueGroupValue(
                        issue,
                        field,
                        configuration,
                        activeTeam,
                        t,
                      ),
                      presentation.subgroupDirection,
                    )
                  : undefined
                return (
                  <Fragment key={group.key}>
                    <IssueTableGroupRow columnCount={tableColumnPlacements.length} count={group.items.length} label={group.label} />
                    {subgroups ? subgroups.map((subgroup) => (
                      <Fragment key={`${group.key}:${subgroup.key}`}>
                        <IssueTableGroupRow columnCount={tableColumnPlacements.length} count={subgroup.items.length} label={subgroup.label} secondary />
                        {subgroup.items.map(renderIssueRow)}
                      </Fragment>
                    )) : group.items.map(renderIssueRow)}
                  </Fragment>
                )
              }) : issues.map(renderIssueRow)
            ) : (
              <tr>
                <td className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]" colSpan={tableColumnPlacements.length} data-testid="team-issues-empty">
                  {t('issues.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t border-[var(--workbench-border)] px-5 py-3 text-sm font-medium text-[var(--workbench-muted)]" data-testid="team-issues-count">
        {t('issues.count').replace('{count}', String(issues.length))}
      </div>
    </section>
  )
}

/** Props for one primary or secondary Team Issue table group heading. */
type IssueTableGroupRowProps = {
  /** Number of visible columns spanned by the heading. */
  columnCount: number
  /** Number of Issues in the group. */
  count: number
  /** Human-readable group value. */
  label: string
  /** Whether the heading represents a subgroup. */
  secondary?: boolean
}

/** Renders an accessible count-bearing Team Issue group heading. */
function IssueTableGroupRow({
  columnCount,
  count,
  label,
  secondary = false,
}: IssueTableGroupRowProps) {
  return (
    <tr data-testid={secondary ? 'team-issue-table-subgroup' : 'team-issue-table-group'}>
      <th
        className={secondary
          ? 'bg-slate-50 px-7 py-2 text-left text-xs font-semibold text-[var(--workbench-muted)]'
          : 'border-y border-[var(--workbench-border)] bg-tone-f2f8f7 px-5 py-2.5 text-left text-sm font-bold text-[var(--workbench-text)]'}
        colSpan={columnCount}
        scope="rowgroup"
      >
        {label} <span className="font-medium text-[var(--workbench-muted)]">({count})</span>
      </th>
    </tr>
  )
}

/** Reports whether a canonical field can be rendered as a Team Issue table column. */
function isSupportedTeamIssueColumn(field: string): boolean {
  return [
    'title',
    'project',
    'assignee',
    'status',
    'customFields',
    'dueDate',
    'priority',
    'workItemType',
    'team',
  ].includes(field) || field.startsWith('custom:')
}

/** Resolves the localized or configured heading for one supported Team Issue table field. */
function resolveIssueTableColumnLabel(
  field: string,
  configuration: WorkItemConfiguration | undefined,
  t: (key: MessageKey) => string,
): string {
  switch (field) {
    case 'title': return t('issues.column.title')
    case 'project': return t('issues.column.project')
    case 'assignee': return t('tasks.column.assignee')
    case 'status': return t('tasks.column.status')
    case 'customFields': return t('workItems.fields.title')
    case 'dueDate': return t('tasks.column.dueDate')
    case 'priority': return t('tasks.column.priority')
    case 'workItemType': return t('tasks.column.workItemType')
    case 'team': return t('workspace.column.team')
    default: {
      const customFieldId = field.slice('custom:'.length)
      return configuration?.customFields.find((item) => item.id === customFieldId)?.name ??
        customFieldId
    }
  }
}

/** Resolves table-cell padding from the effective Team Issue density. */
function resolveIssueTableCellPadding(
  density: TaskViewPresentationSettings['density'] | undefined,
  titleCell = false,
): string {
  const horizontalPadding = titleCell ? 'px-5' : 'px-4'
  const verticalPadding = density === 'compact'
    ? 'py-2'
    : density === 'spacious'
      ? 'py-5'
      : 'py-3'
  return `${horizontalPadding} ${verticalPadding}`
}

/**
 * Resolves width and sticky-edge styles for a persisted Team Issue table column.
 *
 * @param placement - Column width and cumulative pin offsets.
 * @param header - Whether the style is applied to a table heading.
 * @returns Inline table-cell styles that reproduce the saved layout.
 */
function resolveIssueTableColumnCellStyle(
  placement: TaskViewTableColumnPlacement,
  header = false,
): CSSProperties {
  const width = `${placement.width}px`
  const baseStyle: CSSProperties = { maxWidth: width, minWidth: width, width }
  if (placement.column.pin === 'start') {
    return {
      ...baseStyle,
      backgroundColor: 'inherit',
      left: placement.startOffset ?? 0,
      position: 'sticky',
      zIndex: header ? 20 : 10,
    }
  }
  if (placement.column.pin === 'end') {
    return {
      ...baseStyle,
      backgroundColor: 'inherit',
      position: 'sticky',
      right: placement.endOffset ?? 0,
      zIndex: header ? 20 : 10,
    }
  }
  return baseStyle
}
