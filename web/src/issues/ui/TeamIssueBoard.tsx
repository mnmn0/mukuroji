import type { WorkItemConfiguration } from '@mukuroji/contracts'
import { DEFAULT_WORK_ITEM_TYPE_ID } from '@mukuroji/contracts'
import { Fragment, useState, type DragEvent } from 'react'
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
import {
  resolveEditableWorkflowStatuses,
  resolveWorkItemAssignee,
  resolveWorkItemTypeDefinition,
  resolveWorkItemWorkflowStatusId,
  type WorkItemTypeWorkflowStatus,
} from '../../work-items/model/workItemDisplay'
import {
  groupTaskViewItems,
  type TaskViewPresentationSettings,
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

/** Creates a collision-safe identity for one Team Board workflow column. */
function createTeamIssueStatusColumnKey(column: WorkItemTypeWorkflowStatus): string {
  return [column.workItemTypeId, column.status.id].join('\u0000')
}

/** Creates a stable DOM token for one Team Board workflow column. */
function createTeamIssueStatusTestToken(column: WorkItemTypeWorkflowStatus): string {
  const value = column.workItemTypeId === DEFAULT_WORK_ITEM_TYPE_ID
    ? column.status.id
    : `${column.workItemTypeId}-${column.status.id}`
  return value.replaceAll(/[^a-z0-9-]+/giu, '-').toLowerCase()
}

/**
 * Renders the Team Work Items as a status board with drag-and-drop moves.
 *
 * @param props - Board props.
 * @returns The Work Item board.
 */
export function IssueBoard({
  activeTeam,
  canMoveIssueStatus,
  configuration,
  dependencySummaries,
  focusedIssueKey,
  issues,
  isAiOperationPending,
  locale,
  onCreateIssueOpen,
  onIssueActionMenuOpen,
  onMoveIssueStatus,
  onOpenIssue,
  presentation,
  selectedIssueKeys,
  selectedIssueId,
  t,
  workflowStatuses,
  workspaceMembers,
}: {
  activeTeam?: ProjectDirectoryTeam
  /** Checks whether one Team Issue belongs to a server-authorized status mutation scope. */
  canMoveIssueStatus?: (issue: TeamIssue) => boolean
  configuration?: WorkItemConfiguration
  dependencySummaries: Readonly<Record<string, WorkItemDependencySummary>>
  focusedIssueKey?: string
  issues: TeamIssue[]
  /** Whether Team Issue navigation and board actions are fenced during an AI operation. */
  isAiOperationPending: boolean
  locale: Locale
  onCreateIssueOpen?: (workflowStatusId: string, workItemTypeId: string) => void
  /** Opens the canonical action menu for one Team Issue card. */
  onIssueActionMenuOpen?: TeamIssueActionMenuOpenHandler
  /** Routes one Board status selection or drop through the canonical Move action. */
  onMoveIssueStatus?: (issue: TeamIssue, workflowStatusId: string) => Promise<void>
  onOpenIssue?: (issue: TeamIssue) => void
  presentation?: TaskViewPresentationSettings
  selectedIssueKeys: readonly string[]
  selectedIssueId?: string
  t: (key: MessageKey) => string
  workflowStatuses: readonly WorkItemTypeWorkflowStatus[]
  workspaceMembers: WorkspaceMember[]
}) {
  const personLabels = Object.fromEntries(
    workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
  )
  const [draggedIssueId, setDraggedIssueId] = useState<string>()
  const [dropTargetColumnKey, setDropTargetColumnKey] = useState<string>()
  const [movingIssueIds, setMovingIssueIds] = useState<ReadonlySet<string>>(() => new Set())
  /** Checks the Board callback and the current issue-specific write scope together. */
  const canMoveIssue = (issue: TeamIssue) => Boolean(
    !isAiOperationPending && onMoveIssueStatus && (canMoveIssueStatus?.(issue) ?? true),
  )
  const visibleFields = new Set((presentation?.columns ?? [
    { field: 'title' },
    { field: 'project' },
    { field: 'assignee' },
    { field: 'status' },
    { field: 'dueDate' },
    { field: 'priority' },
  ]).map((column) => column.field))
  const cardPadding = presentation?.density === 'compact'
    ? 'p-2.5'
    : presentation?.density === 'spacious'
      ? 'p-5'
      : 'p-4'
  const cardListSpacing = presentation?.density === 'compact'
    ? 'gap-2 p-2'
    : presentation?.density === 'spacious'
      ? 'gap-4 p-4'
      : 'gap-3 p-3'
  const wrapText = presentation?.display.wrapTitles ?? false
  const showAssigneeAvatars = presentation?.display.showAssigneeAvatars ?? false
  const showEmptyGroups = presentation?.display.showEmptyGroups ?? true
  const showTypeName = new Set(workflowStatuses.map(({ workItemTypeId }) => workItemTypeId)).size > 1
  const visibleWorkflowStatuses = showEmptyGroups
    ? workflowStatuses
    : workflowStatuses.filter(({ status, workItemTypeId }) =>
        issues.some((issue) =>
          (issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID) === workItemTypeId &&
          resolveWorkItemWorkflowStatusId(issue) === status.id,
        )
      )

  /** Validates and requests a Team workflow status change. */
  const moveIssueToStatus = (issue: TeamIssue, workflowStatus: WorkItemTypeWorkflowStatus) => {
    const issueWorkItemTypeId = issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID
    if (
      !onMoveIssueStatus ||
      !canMoveIssue(issue) ||
      issueWorkItemTypeId !== workflowStatus.workItemTypeId ||
      issue.workflowStatusId === workflowStatus.status.id
    ) {
      return
    }

    const editableStatuses = resolveEditableWorkflowStatuses(issue, configuration)

    if (!editableStatuses.some((status) => status.id === workflowStatus.status.id)) {
      return
    }

    const issueId = issue.id
    setMovingIssueIds((currentIds) => new Set(currentIds).add(issueId))
    void onMoveIssueStatus(issue, workflowStatus.status.id)
      .catch(() => undefined)
      .finally(() => {
        setMovingIssueIds((currentIds) => {
          const nextIds = new Set(currentIds)
          nextIds.delete(issueId)
          return nextIds
        })
      })
  }

  /** Starts a native drag for a Team Work Item. */
  const handleDragStart = (event: DragEvent<HTMLElement>, issue: TeamIssue) => {
    if (!canMoveIssue(issue)) {
      return
    }

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-mukuroji-team-issue-id', issue.id)
    event.dataTransfer.setData('text/plain', issue.id)
    setDraggedIssueId(issue.id)
  }

  /** Resolves a dropped Team Work Item and requests a validated status change. */
  const handleDrop = (event: DragEvent<HTMLElement>, workflowStatus: WorkItemTypeWorkflowStatus) => {
    event.preventDefault()
    if (isAiOperationPending) {
      setDraggedIssueId(undefined)
      setDropTargetColumnKey(undefined)
      return
    }
    const issueId = event.dataTransfer.getData('application/x-mukuroji-team-issue-id') ||
      event.dataTransfer.getData('text/plain') ||
      draggedIssueId
    const issue = issueId ? issues.find((candidate) => candidate.id === issueId) : undefined

    setDraggedIssueId(undefined)
    setDropTargetColumnKey(undefined)

    if (issue) {
      moveIssueToStatus(issue, workflowStatus)
    }
  }

  return (
    <section className="mt-5 grid min-w-0 gap-3">
      <div className="flex min-w-0 gap-4 overflow-x-auto pb-2">
        {visibleWorkflowStatuses.map((workflowStatus) => {
          const { status, workItemTypeId } = workflowStatus
          const columnKey = createTeamIssueStatusColumnKey(workflowStatus)
          const statusTestToken = createTeamIssueStatusTestToken(workflowStatus)
          const workItemTypeName = resolveWorkItemTypeDefinition(configuration, workItemTypeId)?.name ??
            workItemTypeId
          const columnIssues = issues.filter(
            (issue) =>
              (issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID) === workItemTypeId &&
              resolveWorkItemWorkflowStatusId(issue) === status.id,
          )
          const primaryCardGroupField = presentation?.groupBy === 'status'
            ? presentation.subgroupBy
            : presentation?.groupBy
          const secondaryCardGroupField = presentation?.groupBy !== 'status'
            ? presentation?.subgroupBy
            : undefined
          const primaryCardGroups = primaryCardGroupField
            ? groupTaskViewItems(
                columnIssues,
                primaryCardGroupField,
                (issue, field) => resolveTeamIssueGroupValue(
                  issue,
                  field,
                  configuration,
                  activeTeam,
                  t,
                ),
                presentation?.groupBy === 'status'
                  ? presentation.subgroupDirection
                  : presentation?.groupDirection,
              )
            : []
          const orderedColumnIssues: TeamIssue[] = []
          const primaryHeadingByIssueId = new Map<string, (typeof primaryCardGroups)[number]>()
          const secondaryHeadingByIssueId = new Map<string, string>()
          for (const primaryGroup of primaryCardGroups) {
            const firstIssue = primaryGroup.items[0]
            if (firstIssue) primaryHeadingByIssueId.set(firstIssue.id, primaryGroup)
            const secondaryGroups = secondaryCardGroupField
              ? groupTaskViewItems(
                  primaryGroup.items,
                  secondaryCardGroupField,
                  (issue, field) => resolveTeamIssueGroupValue(
                    issue,
                    field,
                    configuration,
                    activeTeam,
                    t,
                  ),
                  presentation?.subgroupDirection,
                )
              : []
            if (secondaryGroups.length > 0) {
              for (const secondaryGroup of secondaryGroups) {
                const firstSecondaryIssue = secondaryGroup.items[0]
                if (firstSecondaryIssue) {
                  secondaryHeadingByIssueId.set(
                    firstSecondaryIssue.id,
                    `${secondaryGroup.label} (${secondaryGroup.items.length})`,
                  )
                }
                orderedColumnIssues.push(...secondaryGroup.items)
              }
            } else {
              orderedColumnIssues.push(...primaryGroup.items)
            }
          }
          if (primaryCardGroups.length === 0) orderedColumnIssues.push(...columnIssues)

          return (
            <div
              className={`workbench-panel min-h-[420px] w-[min(320px,82vw)] flex-none transition ${dropTargetColumnKey === columnKey ? 'border-[#99d7cf] bg-[#e5f7f4] ring-2 ring-[#99d7cf]/40' : ''}`}
              data-testid={`team-issue-column-${statusTestToken}`}
              key={columnKey}
              onDragLeave={() => setDropTargetColumnKey(undefined)}
              onDragOver={(event) => {
                if (isAiOperationPending || !onMoveIssueStatus || !draggedIssueId) {
                  return
                }

                const issue = issues.find((candidate) => candidate.id === draggedIssueId)

                if (
                  !issue ||
                  !canMoveIssue(issue) ||
                  (issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID) !== workItemTypeId ||
                  !resolveEditableWorkflowStatuses(issue, configuration).some(
                    (candidate) => candidate.id === status.id,
                  )
                ) {
                  return
                }

                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTargetColumnKey(columnKey)
              }}
              onDrop={(event) => handleDrop(event, workflowStatus)}
            >
              <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-4 py-3">
                <span className="grid min-w-0 gap-0.5">
                  <IssueStatusBadge status={status} />
                  {showTypeName ? (
                    <span className="truncate text-[11px] font-semibold text-[var(--workbench-muted)]">
                      {workItemTypeName}
                    </span>
                  ) : null}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--workbench-muted)]">{columnIssues.length}</span>
                  {onCreateIssueOpen && resolveWorkItemTypeDefinition(configuration, workItemTypeId)?.status === 'active' ? (
                    <button
                      aria-label={`${t('tasks.board.addInColumn')}: ${showTypeName ? `${workItemTypeName} · ` : ''}${status.name}`}
                      className="grid h-7 w-7 place-items-center rounded-md border border-[var(--workbench-border-strong)] bg-white text-lg leading-none text-[var(--workbench-primary)] hover:border-[#99d7cf] hover:bg-[#e5f7f4]"
                      data-testid={`team-issue-add-${statusTestToken}`}
                      disabled={isAiOperationPending}
                      onClick={() => onCreateIssueOpen(status.id, workItemTypeId)}
                      type="button"
                    >
                      +
                    </button>
                  ) : null}
                </div>
              </div>
              <div className={`grid ${cardListSpacing}`}>
                {columnIssues.length > 0 ? (
                  orderedColumnIssues.map((issue) => {
                    const issueKey = createTaskViewItemKey(issue.teamId, issue.id)
                    const focusedForAction = focusedIssueKey === issueKey
                    const selectedForAction = selectedIssueKeys.includes(issueKey)
                    const isMoving = movingIssueIds.has(issue.id)
                    const editableStatuses = resolveEditableWorkflowStatuses(issue, configuration)
                    const canMoveCurrentIssue = canMoveIssue(issue)
                    const primaryHeading = primaryHeadingByIssueId.get(issue.id)
                    const secondaryHeading = secondaryHeadingByIssueId.get(issue.id)
                    const customFieldEntries = new Map(
                      resolveIssueCustomFieldEntries(
                        issue,
                        configuration,
                        locale,
                        personLabels,
                      ).map((entry) => [entry.definition.id, entry.value]),
                    )
                    const customColumns = [...visibleFields].flatMap((field) => {
                      if (!field.startsWith('custom:')) return []
                      const fieldId = field.slice('custom:'.length)
                      return [{
                        id: fieldId,
                        label: configuration?.customFields.find(
                          (definition) => definition.id === fieldId,
                        )?.name ?? fieldId,
                        value: customFieldEntries.get(fieldId) ?? '—',
                      }]
                    })

                    return (
                      <Fragment key={issue.id}>
                      {primaryHeading ? (
                        <h3 className="rounded bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-[var(--workbench-muted)]">
                          {primaryHeading.label} ({primaryHeading.items.length})
                        </h3>
                      ) : null}
                      {secondaryHeading ? (
                        <h4 className="px-2.5 py-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
                          {secondaryHeading}
                        </h4>
                      ) : null}
                      <article
                        aria-grabbed={draggedIssueId === issue.id || undefined}
                        className={`rounded-lg border ${cardPadding} text-left transition ${
                          selectedIssueId === issue.id
                            ? 'border-[#99d7cf] bg-[#e5f7f4]'
                            : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                        } ${selectedForAction ? 'bg-blue-50/70' : ''} ${
                          focusedForAction ? 'ring-2 ring-blue-500/40' : ''
                        } ${draggedIssueId === issue.id ? 'opacity-50 ring-2 ring-[#99d7cf]' : ''} ${isMoving ? 'opacity-70' : ''}`}
                        data-task-view-focused={focusedForAction ? 'true' : 'false'}
                        data-task-view-selected={selectedForAction ? 'true' : 'false'}
                        data-testid={`team-issue-card-${issue.id}`}
                        draggable={canMoveCurrentIssue && !isMoving}
                        onDragEnd={() => {
                          setDraggedIssueId(undefined)
                          setDropTargetColumnKey(undefined)
                        }}
                        onDragStart={(event) => handleDragStart(event, issue)}
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
                        <div className="flex min-w-0 items-start gap-2">
                          <button
                            aria-pressed={selectedForAction || selectedIssueId === issue.id}
                            className={`min-w-0 flex-1 text-left text-sm font-semibold leading-6 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)] disabled:cursor-default disabled:text-[var(--workbench-text)] ${
                              wrapText ? 'whitespace-normal break-words' : 'truncate'
                            }`}
                            disabled={isAiOperationPending || !onOpenIssue}
                            onClick={() => onOpenIssue?.(issue)}
                            type="button"
                          >
                            {resolveIssueTitle(issue, t)}
                          </button>
                          {onIssueActionMenuOpen ? (
                            <button
                              aria-label={`${t('tasks.action.more')}: ${resolveIssueTitle(issue, t)}`}
                              className="grid h-9 w-9 flex-none place-items-center rounded text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] max-[640px]:h-11 max-[640px]:w-11"
                              data-testid={`team-issue-card-actions-${issue.id}`}
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
                          className="mt-2"
                          summary={resolveWorkItemDependencySummary(
                            dependencySummaries,
                            { teamId: issue.teamId, workItemId: issue.id },
                          )}
                          t={t}
                        />
                        {visibleFields.has('workItemType') ? (
                          <div className="mt-2 w-fit">
                            <TaskWorkItemTypeBadge configuration={configuration} task={issue} />
                          </div>
                        ) : null}
                        {visibleFields.has('project') ? (
                          <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{resolveAssignedProjectName(issue, activeTeam, t)}</p>
                        ) : null}
                        {!presentation || visibleFields.has('customFields') ? <div className="mt-3">
                          <IssueCustomFieldSummary
                            configuration={configuration}
                            issue={issue}
                            locale={locale}
                            personLabels={personLabels}
                          />
                        </div> : null}
                        {customColumns.length > 0 ? (
                          <dl className="mt-3 grid gap-1.5 text-xs text-[var(--workbench-muted)]">
                            {customColumns.map((item) => (
                              <div className="flex min-w-0 items-baseline justify-between gap-2" key={item.id}>
                                <dt className="truncate font-semibold">{item.label}</dt>
                                <dd className={wrapText ? 'break-words text-right' : 'truncate text-right'}>
                                  {item.value}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                        {visibleFields.has('assignee') ? (
                          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs font-medium text-[var(--workbench-muted)]">
                            {showAssigneeAvatars ? (
                              <WorkItemAssigneeAvatar label={resolveWorkItemAssignee(issue)} />
                            ) : null}
                            <span className="truncate">{resolveWorkItemAssignee(issue)}</span>
                          </div>
                        ) : null}
                        {visibleFields.has('priority') || visibleFields.has('dueDate') ? (
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            {visibleFields.has('priority') ? <IssuePriorityBadge priority={issue.priority} t={t} /> : null}
                            {visibleFields.has('dueDate') ? <span className="text-xs font-semibold text-[var(--workbench-muted)]">{issue.dueDate}</span> : null}
                          </div>
                        ) : null}
                        {visibleFields.has('team') ? (
                          <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{issue.teamId}</p>
                        ) : null}
                        {visibleFields.has('status') && canMoveCurrentIssue && editableStatuses.length > 0 ? (
                          <select
                            aria-label={`${resolveIssueTitle(issue, t)}: ${t('tasks.column.status')}`}
                            className="workbench-input mt-3 h-8 w-full px-2 text-xs"
                            disabled={isAiOperationPending || isMoving}
                            onChange={(event) => {
                              const issueWorkItemTypeId = issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID
                              const nextWorkflowStatus = workflowStatuses.find((candidate) =>
                                candidate.workItemTypeId === issueWorkItemTypeId &&
                                candidate.status.id === event.target.value,
                              )
                              if (nextWorkflowStatus) moveIssueToStatus(issue, nextWorkflowStatus)
                            }}
                            value={issue.workflowStatusId}
                          >
                            {editableStatuses.map((editableStatus) => (
                              <option key={editableStatus.id} value={editableStatus.id}>
                                {editableStatus.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {canMoveCurrentIssue ? (
                          <p className="mt-2 text-[11px] font-medium text-[var(--workbench-muted)]">
                            {t('tasks.board.dragHint')}
                          </p>
                        ) : null}
                      </article>
                      </Fragment>
                    )
                  })
                ) : (
                  <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
                    {t('tasks.board.empty')}
                  </p>
                )}
              </div>
            </div>
          )
        })}
        {visibleWorkflowStatuses.length === 0 ? (
          <p className="w-full rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('tasks.board.empty')}
          </p>
        ) : null}
      </div>
    </section>
  )
}
