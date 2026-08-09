import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
  ResolvedWorkItemConfiguration,
  WorkItemPatch,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  Fragment,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import type { ProjectTask, TaskPriority } from '../api/tasks'
import type { ProjectMember } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { MoreHorizontalIcon } from '../../shared/ui/icons'
import type { WorkItemPersonOption } from '../../work-items/ui/WorkItemFieldsEditor'
import type { TaskViewPresentationSettings } from '../../task-views/model/taskViewPresentation'
import {
  groupTaskViewItems,
  resolveTaskViewTableColumnPlacements,
  type TaskViewGroupValue,
  type TaskViewTableColumnPlacement,
} from '../../task-views/model/taskViewPresentation'
import {
  resolveWorkItemDependencySummary,
  type WorkItemDependencySummary,
} from '../../work-items/model/workItemDependencies'
import { WorkItemDependencyChips } from '../../work-items/ui/WorkItemDependencyChips'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
  resolveEditableWorkflowStatuses,
  resolveWorkItemWorkflowStatusLabel,
} from '../../work-items/model/workItemDisplay'
import {
  BulkOperationToolbar,
  type BulkOperationProjectOption,
  type BulkOperationSelection,
  type BulkOperationTaskActionRequest,
} from '../../bulk-operations/ui/BulkOperationToolbar'
import {
  createTaskKey,
  isTaskOverdue,
  resolveProjectTaskConfiguration,
  resolveTaskCustomFieldEntries,
  resolveTaskPriority,
  taskPriorities,
  type TaskCreateContext,
} from '../model/taskView'
import {
  formatTaskScheduleRange,
  replaceTaskDeadlineSchedule,
  resolveTaskSchedule,
  taskScheduleModeLabelKeys,
} from '../model/taskSchedule'
import { TaskInlineField } from './TaskInlineField'
import { TaskInlineCustomFields } from './TaskInlineCustomFields'
import { WorkItemAssigneeAvatar } from '../../work-items/ui/WorkItemAssigneeAvatar'
import { resolveWorkflowStatusCategory } from '../../work-items/model/workItemDisplay'
import {
  TaskCustomFieldSummary,
  TaskStatusBadge,
  TaskViewFlagIcon,
  TaskViewPlusIcon,
} from './TaskViewPrimitives'
import type { ProjectTaskActionMenuOpenHandler } from './projectTaskActionMenu'

/** Resolves a localized task-table message. */
type TaskTableTranslator = (key: MessageKey) => string

/** Width reserved for row-level create and action-menu controls. */
const taskTableActionColumnWidth = 96

/** Props for the independent project task table view. */
export type TaskTableViewProps = {
  /** Active Project members available to inline assignee editors. */
  assigneeOptions?: ProjectMember[]
  /** Projects available as bulk-operation move targets. */
  bulkProjectOptions: BulkOperationProjectOption[]
  /** Workspace identifier included in bulk-operation requests. */
  bulkWorkspaceId: string
  /** Canonical Project action requested by another action entrance. */
  bulkTaskActionRequest?: BulkOperationTaskActionRequest
  /** Stable key epoch retained after the current canonical action request is consumed. */
  bulkTaskActionEpoch?: number
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team-scoped resolved configurations used by individual rows. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Locale used to format custom-field values. */
  locale: Locale
  /** Dependency summaries keyed by canonical Team/Work Item identity. */
  dependencySummaries?: Readonly<Record<string, WorkItemDependencySummary>>
  /** Person options available to custom-field editors. */
  personOptions?: WorkItemPersonOption[]
  /** Mapping from person identifiers to display names. */
  personLabels: Readonly<Record<string, string>>
  /** Visible fields, density, wrapping, and grouping selected by the effective view. */
  presentation?: TaskViewPresentationSettings
  /** Project identifier used to reset bulk-operation toolbar state. */
  projectId: string
  /** Bulk-operation snapshots selected across visible and hidden rows. */
  selectedBulkItems: BulkOperationSelection[]
  /** Composite key of the task selected in the detail pane. */
  selectedDetailTaskKey?: string
  /** Composite keys of rows selected for a bulk operation. */
  selectedTaskKeys: string[]
  /** Localized task-list loading error. */
  taskErrorMessage?: string
  /** Filtered and sorted tasks displayed by the table. */
  tasks: ProjectTask[]
  /** Translator used for table labels. */
  t: TaskTableTranslator
  /** Bulk-operation snapshots corresponding to currently visible rows. */
  visibleBulkItems: BulkOperationSelection[]
  /** Applies a validated bulk operation. */
  onBulkApply?: (
    request: BulkOperationRequest,
    preview: BulkOperationPreview,
  ) => Promise<BulkOperation>
  /** Receives a completed bulk operation so succeeded selections can be cleared. */
  onBulkOperationComplete: (operation: BulkOperation) => void
  /** Routes parameterized bulk entrances through the canonical Project action registry. */
  onBulkTaskActionRequest?: (
    actionId: BulkOperationTaskActionRequest['actionId'],
  ) => Promise<boolean>
  /** Acknowledges one canonical action request after the toolbar consumes it. */
  onBulkTaskActionRequestConsumed?: (requestId: number) => void
  /** Validates a bulk operation before applying it. */
  onBulkPreview?: (request: BulkOperationRequest) => Promise<BulkOperationPreview>
  /** Retries retryable items from a bulk operation. */
  onBulkRetry?: (operationId: string) => Promise<BulkOperation>
  /** Undoes succeeded items from a bulk operation. */
  onBulkUndo?: (operationId: string) => Promise<BulkOperation>
  /** Opens the create-task form when task creation is available. */
  onCreateTaskOpen?: (context?: TaskCreateContext) => void
  /** Updates a row through the common Work Item action. */
  onUpdateTask?: (task: ProjectTask, input: WorkItemPatch) => Promise<ProjectTask>
  /** Selects a task for the detail pane. */
  onSelectTask: (task: ProjectTask) => void
  /** Opens the canonical action menu for one rendered row. */
  onTaskActionMenuOpen?: ProjectTaskActionMenuOpenHandler
  /** Updates one row's bulk-selection state. */
  onTaskSelectionChange: (taskKey: string, selected: boolean) => void
  /** Updates bulk selection for all currently visible rows. */
  onVisibleTaskSelectionChange: (selectionKeys: string[], selected: boolean) => void
}

/** Props for one row in the project task table. */
type TaskTableRowProps = {
  /** Active Project members available to inline assignee editors. */
  assigneeOptions: ProjectMember[]
  /** Configuration used to render workflow and custom-field values. */
  configuration?: WorkItemConfiguration
  /** Locale used to format custom-field values. */
  locale: Locale
  /** Canonical dependency state for this row. */
  dependencySummary?: WorkItemDependencySummary
  /** Person options available to custom-field editors. */
  personOptions: WorkItemPersonOption[]
  /** Mapping from person identifiers to display names. */
  personLabels: Readonly<Record<string, string>>
  /** Effective density and text-wrapping settings. */
  presentation?: TaskViewPresentationSettings
  /** Project receiving contextual creates from this row. */
  projectId: string
  /** Zero-based position after filtering and sorting. */
  rowIndex: number
  /** Whether the row is selected for a bulk operation. */
  selected: boolean
  /** Whether the row is selected in the detail pane. */
  selectedForDetail: boolean
  /** Whether bulk selection is unavailable. */
  selectionReadOnly: boolean
  /** Selects the row's task for the detail pane. */
  onSelectTask: (task: ProjectTask) => void
  /** Opens the canonical action menu for this row. */
  onTaskActionMenuOpen?: ProjectTaskActionMenuOpenHandler
  /** Opens the create panel with the row's Work Item context. */
  onCreateTaskOpen?: (context?: TaskCreateContext) => void
  /** Updates the row through the common Work Item action. */
  onUpdateTask?: (task: ProjectTask, input: WorkItemPatch) => Promise<ProjectTask>
  /** Updates the row's bulk-selection state. */
  onTaskSelectionChange: (taskKey: string, selected: boolean) => void
  /** Work item rendered by the row. */
  task: ProjectTask
  /** Translator used for row labels. */
  t: TaskTableTranslator
  /** Ordered visible columns rendered by this row. */
  visibleColumns: readonly TaskViewTableColumnPlacement[]
}

/**
 * Renders the task table together with its bulk-operation toolbar.
 *
 * @param props - Table data, selection state, and action callbacks.
 * @returns The independent project task table view.
 */
export function TaskTableView({
  assigneeOptions = [],
  bulkProjectOptions,
  bulkTaskActionEpoch = 0,
  bulkTaskActionRequest,
  bulkWorkspaceId,
  configuration,
  configurationsByTeam,
  dependencySummaries = {},
  locale,
  personOptions = [],
  personLabels,
  presentation,
  projectId,
  selectedBulkItems,
  selectedDetailTaskKey,
  selectedTaskKeys,
  taskErrorMessage,
  tasks,
  t,
  visibleBulkItems,
  onBulkApply,
  onBulkOperationComplete,
  onBulkTaskActionRequest,
  onBulkTaskActionRequestConsumed,
  onBulkPreview,
  onBulkRetry,
  onBulkUndo,
  onCreateTaskOpen,
  onSelectTask,
  onTaskActionMenuOpen,
  onUpdateTask,
  onTaskSelectionChange,
  onVisibleTaskSelectionChange,
}: TaskTableViewProps) {
  const selectionReadOnly = !bulkWorkspaceId || !onBulkPreview || !onBulkApply
  const hasTaskRows = !taskErrorMessage && tasks.length > 0
  const visibleColumns = (presentation?.columns ?? [
    { field: 'title' },
    { field: 'assignee' },
    { field: 'status' },
    { field: 'dueDate' },
    { field: 'priority' },
  ]).filter((column) => isSupportedProjectTaskColumn(column.field))
  const renderedColumns = visibleColumns.some((column) => column.field === 'title')
    ? visibleColumns
    : [{ field: 'title' }, ...visibleColumns]
  const tableColumnPlacements = resolveTaskViewTableColumnPlacements(renderedColumns)
  const tableColumnCount = tableColumnPlacements.length + 1
  const tableMinimumWidth = Math.max(
    720,
    tableColumnPlacements.reduce(
      (total, placement) => total + placement.width,
      taskTableActionColumnWidth,
    ),
  )
  const groupedTasks = presentation?.groupBy
    ? groupTaskViewItems(
        tasks,
        presentation.groupBy,
        (task, field) => resolveProjectTaskGroupValue(
          task,
          field,
          resolveProjectTaskConfiguration(task, configurationsByTeam, configuration),
          t,
        ),
        presentation.groupDirection,
      )
    : undefined
  const [tableAction, setTableAction] = useState<{
    kind: 'success' | 'error'
    message: string
  }>()

  /** Runs pasted or fill-down updates through the same Work Item mutation callback as inline edits. */
  const runBatchTaskUpdates = async (
    updates: readonly { task: ProjectTask; patch: WorkItemPatch }[],
    successMessage: string,
    invalidCount = 0,
  ) => {
    if (!onUpdateTask) {
      return
    }

    setTableAction(undefined)
    const results = await Promise.allSettled(
      updates.map(({ patch, task }) => onUpdateTask(task, patch)),
    )
    const failedCount = invalidCount + results.filter((result) => result.status === 'rejected').length

    if (failedCount > 0) {
      setTableAction({
        kind: 'error',
        message: t('tasks.action.partial').replace('{count}', String(failedCount)),
      })
      return
    }

    setTableAction({
      kind: 'success',
      message: successMessage.replace('{count}', String(updates.length)),
    })
  }

  /** Handles multi-cell clipboard input for selected or focused table rows. */
  const handleTablePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (!onUpdateTask || isInlineEditorTarget(event.target)) {
      return
    }

    const rows = event.clipboardData.getData('text/plain')
      .split(/\r?\n/)
      .map((row) => row.split('\t').map((cell) => cell.trim()))
      .filter((cells) => cells.some(Boolean))

    if (rows.length === 0 || (rows.length === 1 && rows[0].length === 1)) {
      return
    }

    const selectedTasks = selectedTaskKeys.flatMap((taskKey) => {
      const task = tasks.find((candidate) => createTaskKey(candidate) === taskKey)
      return task ? [task] : []
    })
    const targetElement = event.target instanceof HTMLElement ? event.target : undefined
    const rowElement = targetElement?.closest<HTMLElement>('[data-row-index]')
    const focusedRowIndex = rowElement ? Number(rowElement.dataset.rowIndex) : undefined

    if (
      selectedTasks.length === 0 &&
      (focusedRowIndex === undefined || !Number.isInteger(focusedRowIndex) || focusedRowIndex < 0)
    ) {
      return
    }

    event.preventDefault()
    const targetTasks = selectedTasks.length > 0
      ? selectedTasks
      : tasks.slice(focusedRowIndex ?? 0)
    const updates: Array<{ task: ProjectTask; patch: WorkItemPatch }> = []
    let invalidCount = Math.max(0, rows.length - targetTasks.length)

    rows.forEach((cells, index) => {
      const task = targetTasks[index]
      if (!task) {
        return
      }

      const patch = createTaskPatchFromPastedCells(
        cells,
        task,
        resolveProjectTaskConfiguration(task, configurationsByTeam, configuration),
        assigneeOptions,
      )

      if (!patch) {
        invalidCount += 1
        return
      }

      updates.push({ patch, task })
    })

    void runBatchTaskUpdates(updates, t('tasks.action.paste'), invalidCount)
  }

  /** Handles keyboard fill-down for the selected table rows without requiring a pointer. */
  const handleTableKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      !onUpdateTask ||
      isInlineEditorTarget(event.target) ||
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== 'd'
    ) {
      return
    }

    const selectedTasks = selectedTaskKeys.flatMap((taskKey) => {
      const task = tasks.find((candidate) => createTaskKey(candidate) === taskKey)
      return task ? [task] : []
    })

    if (selectedTasks.length < 2) {
      return
    }

    event.preventDefault()
    const sourceTask = selectedTasks[0]
    const targetElement = event.target instanceof HTMLElement ? event.target : undefined
    const fieldKey = targetElement?.closest<HTMLElement>('[data-task-field]')?.dataset.taskField ?? 'title'
    const updates = selectedTasks.slice(1).flatMap((task) => {
      const patch = createTaskFillPatch(sourceTask, task, fieldKey)
      return patch ? [{ patch, task }] : []
    })
    void runBatchTaskUpdates(
      updates,
      t('tasks.action.fill'),
      selectedTasks.length - 1 - updates.length,
    )
  }

  /** Renders one configured row while preserving its index in the complete result set. */
  const renderTaskRow = (task: ProjectTask) => (
    <TaskTableRow
      assigneeOptions={assigneeOptions}
      configuration={resolveProjectTaskConfiguration(
        task,
        configurationsByTeam,
        configuration,
      )}
      key={createTaskKey(task)}
      locale={locale}
      dependencySummary={resolveWorkItemDependencySummary(
        dependencySummaries,
        { teamId: task.teamId, workItemId: task.id },
      )}
      personOptions={personOptions}
      personLabels={personLabels}
      presentation={presentation}
      projectId={projectId}
      rowIndex={tasks.findIndex((candidate) => createTaskKey(candidate) === createTaskKey(task))}
      onTaskSelectionChange={onTaskSelectionChange}
      onSelectTask={onSelectTask}
      onTaskActionMenuOpen={onTaskActionMenuOpen}
      onCreateTaskOpen={onCreateTaskOpen}
      onUpdateTask={onUpdateTask}
      selectedForDetail={selectedDetailTaskKey === createTaskKey(task)}
      selected={selectedTaskKeys.includes(createTaskKey(task))}
      selectionReadOnly={selectionReadOnly}
      t={t}
      task={task}
      visibleColumns={tableColumnPlacements}
    />
  )
  const scopedBulkTaskActionRequest = bulkTaskActionRequest?.projectId === projectId
    ? bulkTaskActionRequest
    : undefined

  return (
    <>
      <BulkOperationToolbar
        key={`${projectId}:${bulkTaskActionEpoch}`}
        projectOptions={bulkProjectOptions}
        readOnly={selectionReadOnly}
        selectedItems={selectedBulkItems}
        taskActionRequest={scopedBulkTaskActionRequest}
        t={t}
        visibleItems={visibleBulkItems}
        workspaceId={bulkWorkspaceId}
        onApply={onBulkApply}
        onOperationComplete={onBulkOperationComplete}
        onTaskActionRequest={onBulkTaskActionRequest}
        onTaskActionRequestConsumed={onBulkTaskActionRequestConsumed}
        onPreview={onBulkPreview}
        onRetry={onBulkRetry}
        onUndo={onBulkUndo}
        onVisibleSelectionChange={onVisibleTaskSelectionChange}
      />
      <section
        aria-label={t('tasks.table.aria')}
        className="workbench-table mt-3 overflow-hidden"
        onKeyDown={handleTableKeyDown}
        onPaste={handleTablePaste}
      >
        {tableAction ? (
          <p
            className={`border-b px-5 py-3 text-sm font-semibold ${tableAction.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-[#99d7cf] bg-[#e5f7f4] text-[var(--workbench-primary)]'}`}
            data-testid="task-table-action-feedback"
            role={tableAction.kind === 'error' ? 'alert' : 'status'}
          >
            {tableAction.message}
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table
            className="w-full table-fixed border-collapse"
            style={{ minWidth: hasTaskRows ? tableMinimumWidth : 0 }}
          >
            {hasTaskRows ? (
              <colgroup>
                {tableColumnPlacements.map((placement) => (
                  <col key={placement.column.field} style={{ width: placement.width }} />
                ))}
                <col style={{ width: taskTableActionColumnWidth }} />
              </colgroup>
            ) : null}
            {hasTaskRows ? (
              <thead>
                <tr className="workbench-table-head text-left">
                  {tableColumnPlacements.map((placement) => (
                    <th
                      className={`${placement.column.field === 'title' ? 'px-5 py-2.5' : 'px-3 py-2.5'} ${
                        placement.column.pin ? 'bg-[var(--workbench-surface-muted)]' : ''
                      }`}
                      data-column-field={placement.column.field}
                      data-column-pin={placement.column.pin}
                      key={placement.column.field}
                      scope="col"
                      style={resolveTaskViewColumnCellStyle(
                        placement,
                        taskTableActionColumnWidth,
                        true,
                      )}
                    >
                      {resolveTaskTableColumnLabel(
                        placement.column.field,
                        configurationsByTeam,
                        configuration,
                        t,
                      )}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-center text-[#8f99a8]" scope="col">
                    <span className="sr-only">{t('tasks.action.more')}</span>
                    <MoreHorizontalIcon className="mx-auto h-5 w-5" />
                  </th>
                </tr>
              </thead>
            ) : null}
            <tbody>
              {taskErrorMessage ? (
                <tr>
                  <td
                    className="break-words px-5 py-7 text-sm font-semibold text-red-700"
                    colSpan={tableColumnCount}
                    data-testid="tasks-error"
                  >
                    <span role="alert">
                      {taskErrorMessage === t('tasks.error.loading')
                        ? taskErrorMessage
                        : `${t('tasks.error.loading')}: ${taskErrorMessage}`}
                    </span>
                  </td>
                </tr>
              ) : tasks.length > 0 ? (
                groupedTasks ? groupedTasks.map((group) => {
                  const subgroups = presentation?.subgroupBy
                    ? groupTaskViewItems(
                        group.items,
                        presentation.subgroupBy,
                        (task, field) => resolveProjectTaskGroupValue(
                          task,
                          field,
                          resolveProjectTaskConfiguration(
                            task,
                            configurationsByTeam,
                            configuration,
                          ),
                          t,
                        ),
                        presentation.subgroupDirection,
                      )
                    : undefined
                  return (
                    <Fragment key={group.key}>
                      <TaskTableGroupRow
                        columnCount={tableColumnCount}
                        count={group.items.length}
                        label={group.label}
                      />
                      {subgroups ? subgroups.map((subgroup) => (
                        <Fragment key={`${group.key}:${subgroup.key}`}>
                          <TaskTableGroupRow
                            columnCount={tableColumnCount}
                            count={subgroup.items.length}
                            label={subgroup.label}
                            secondary
                          />
                          {subgroup.items.map(renderTaskRow)}
                        </Fragment>
                      )) : group.items.map(renderTaskRow)}
                    </Fragment>
                  )
                }) : tasks.map(renderTaskRow)
              ) : (
                <tr>
                  <td
                    className="px-5 py-7 text-sm font-medium text-[#5f6874]"
                    colSpan={tableColumnCount}
                    data-testid="tasks-empty"
                  >
                    {t('tasks.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-3 text-sm font-medium">
          {onCreateTaskOpen ? (
            <button
              className="inline-flex items-center gap-2 text-[var(--workbench-primary)] transition hover:text-[var(--workbench-primary-hover)]"
              onClick={() => onCreateTaskOpen({ projectId, source: 'table' })}
              type="button"
            >
              <TaskViewPlusIcon />
              {t('tasks.addTask')}
            </button>
          ) : <span />}
          <span className="text-[#5f6874]" data-testid="tasks-count">
            {t('tasks.count').replace('{count}', String(tasks.length))}
          </span>
        </div>
      </section>
    </>
  )
}

/** Props for one primary or secondary task table group heading. */
type TaskTableGroupRowProps = {
  /** Number of rendered table columns spanned by the heading. */
  columnCount: number
  /** Number of Work Items in the group. */
  count: number
  /** Human-readable group value. */
  label: string
  /** Whether the heading represents a subgroup. */
  secondary?: boolean
}

/** Renders an accessible count-bearing group heading inside the task table. */
function TaskTableGroupRow({
  columnCount,
  count,
  label,
  secondary = false,
}: TaskTableGroupRowProps) {
  return (
    <tr data-testid={secondary ? 'task-table-subgroup' : 'task-table-group'}>
      <th
        className={secondary
          ? 'bg-slate-50 px-7 py-2 text-left text-xs font-semibold text-[var(--workbench-muted)]'
          : 'border-y border-[var(--workbench-border)] bg-[#f2f8f7] px-5 py-2.5 text-left text-sm font-bold text-[var(--workbench-text)]'}
        colSpan={columnCount}
        scope="rowgroup"
      >
        {label} <span className="font-medium text-[var(--workbench-muted)]">({count})</span>
      </th>
    </tr>
  )
}

/** Resolves a stable key and visible label for one project task grouping field. */
function resolveProjectTaskGroupValue(
  task: ProjectTask,
  field: string,
  configuration: WorkItemConfiguration | undefined,
  t: TaskTableTranslator,
): TaskViewGroupValue {
  let value: string
  switch (field) {
    case 'title': value = resolveWorkItemTitle(task); break
    case 'status': value = resolveWorkItemWorkflowStatusLabel(task, configuration); break
    case 'assignee': value = resolveWorkItemAssignee(task); break
    case 'dueDate': value = task.dueDate || '—'; break
    case 'priority': value = t(`tasks.priority.${task.priority}`); break
    case 'project': value = task.assignedProjectId ?? '—'; break
    case 'team': value = task.teamId; break
    default: {
      const customValue = field.startsWith('custom:')
        ? task.customFieldValues[field.slice('custom:'.length)]
        : undefined
      value = Array.isArray(customValue)
        ? customValue.join(', ')
        : customValue === undefined || customValue === null || customValue === ''
          ? '—'
          : String(customValue)
    }
  }
  return { key: value, label: value }
}

/**
 * Renders one selectable project task row.
 *
 * @param props - Row data, selection state, and callbacks.
 * @returns A task table row.
 */
function TaskTableRow({
  assigneeOptions,
  configuration,
  dependencySummary,
  locale,
  personOptions,
  personLabels,
  presentation,
  projectId,
  rowIndex,
  selected,
  selectedForDetail,
  selectionReadOnly,
  onSelectTask,
  onCreateTaskOpen,
  onUpdateTask,
  onTaskSelectionChange,
  onTaskActionMenuOpen,
  task,
  t,
  visibleColumns,
}: TaskTableRowProps) {
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'workbench-badge-danger',
    medium: 'workbench-badge-warning',
    low: 'workbench-badge-success',
  }
  const taskTitle = resolveWorkItemTitle(task)
  const schedule = resolveTaskSchedule(task)
  const scheduleRange = formatTaskScheduleRange(schedule)
  const scheduleDisplay = `${t(taskScheduleModeLabelKeys[schedule.mode])}${scheduleRange ? `: ${scheduleRange}` : ''}`
  const overdue = isTaskOverdue(task)
  const cellPadding = resolveTaskTableCellPadding(presentation?.density)
  const titleCellPadding = resolveTaskTableCellPadding(presentation?.density, true)
  const wrapText = presentation?.display.wrapTitles ?? false
  const showAssigneeAvatar = presentation?.display.showAssigneeAvatars ?? false
  const assigneeLabel = resolveWorkItemAssignee(task)
  const customFieldEntries = new Map(
    resolveTaskCustomFieldEntries(task, configuration, locale, personLabels, t).map(
      (entry) => [entry.definition.id, entry.value],
    ),
  )
  const editableStatuses = resolveEditableWorkflowStatuses(task, configuration)
  const memberOptions = assigneeOptions.map((member) => ({
    label: `${member.name ?? member.email} / ${member.email}`,
    value: member.id,
  }))
  const inlineAssigneeOptions = task.assigneeUserId && !assigneeOptions.some(
    (member) => member.id === task.assigneeUserId,
  )
    ? [
        {
          label: resolveWorkItemAssignee(task),
          value: task.assigneeUserId,
        },
        ...memberOptions,
      ]
    : task.assigneeUserId
      ? memberOptions
      : [
          { label: t('tasks.detail.unassigned'), value: '' },
          ...memberOptions,
        ]
  /** Sends one row edit through the shared Work Item mutation. */
  const commitPatch = async (patch: WorkItemPatch) => {
    await onUpdateTask?.(task, patch)
  }

  return (
    <tr
      className={`cursor-pointer border-b border-[#e4e7ec] text-sm font-medium text-[#1c1d1f] last:border-b-0 ${
        selectedForDetail ? 'workbench-row-selected' : 'hover:bg-[var(--workbench-surface-muted)]'
      }`}
      data-row-index={rowIndex}
      data-selected={selected ? 'true' : 'false'}
      data-task-action="open"
      data-testid={`task-row-${task.id}`}
      onClick={(event) => {
        if (!isInteractiveTaskRowTarget(event.target)) onSelectTask(task)
      }}
      onContextMenu={(event) => {
        if (!onTaskActionMenuOpen) return
        event.preventDefault()
        onTaskActionMenuOpen(
          task,
          { x: event.clientX, y: event.clientY },
          event.currentTarget,
        )
      }}
      tabIndex={-1}
    >
      {visibleColumns.map((placement) => {
        const field = placement.column.field
        const columnCellProps = {
          'data-column-field': field,
          'data-column-pin': placement.column.pin,
          style: resolveTaskViewColumnCellStyle(placement, taskTableActionColumnWidth),
        }
        switch (field) {
          case 'title': return (
            <td {...columnCellProps} className={titleCellPadding} key={field}>
              <div className="flex min-w-0 items-center gap-3">
                <input
                  aria-label={taskTitle}
                  checked={selected}
                  className="h-4 w-4 rounded border-[var(--workbench-border-strong)] text-[var(--workbench-primary)]"
                  onChange={(event) => onTaskSelectionChange(createTaskKey(task), event.target.checked)}
                  disabled={selectionReadOnly}
                  type="checkbox"
                />
                {onUpdateTask ? (
                  <TaskInlineField
                    ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.name')}`}
                    displayValue={taskTitle}
                    fieldKey="title"
                    testId={`task-inline-title-${task.id}`}
                    value={taskTitle}
                    wrapText={wrapText}
                    onCommit={(value) => commitPatch({ title: value })}
                  />
                ) : (
                  <button
                    className={`min-w-0 text-left font-semibold text-[var(--workbench-text)] transition hover:text-[var(--workbench-primary)] ${
                      wrapText ? 'whitespace-normal break-words' : 'truncate'
                    }`}
                    onClick={() => onSelectTask(task)}
                    type="button"
                  >
                    {taskTitle}
                  </button>
                )}
                {onUpdateTask ? (
                  <button
                    aria-label={`${t('tasks.detail.title')}: ${taskTitle}`}
                    className="rounded px-1 text-xs text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)]"
                    data-testid={`task-open-detail-${task.id}`}
                    onClick={() => onSelectTask(task)}
                    type="button"
                  >
                    ↗
                  </button>
                ) : null}
                {!presentation && onUpdateTask ? (
                  <TaskInlineCustomFields
                    configuration={configuration}
                    locale={locale}
                    onUpdateTask={onUpdateTask}
                    personLabels={personLabels}
                    personOptions={personOptions}
                    t={t}
                    task={task}
                  />
                ) : !presentation ? (
                  <TaskCustomFieldSummary
                    configuration={configuration}
                    locale={locale}
                    personLabels={personLabels}
                    t={t}
                    task={task}
                  />
                ) : null}
                {selected ? (
                  <span className="workbench-badge-primary">
                    {t('tasks.row.selected')}
                  </span>
                ) : null}
                <WorkItemDependencyChips summary={dependencySummary} t={t} />
              </div>
            </td>
          )
          case 'assignee': return (
            <td {...columnCellProps} className={`${wrapText ? 'break-words' : 'truncate'} ${cellPadding} text-[#505967]`} key={field}>
              <div className="flex min-w-0 items-center gap-2">
                {showAssigneeAvatar ? <WorkItemAssigneeAvatar label={assigneeLabel} /> : null}
                {onUpdateTask && inlineAssigneeOptions.length > 0 ? (
                  <TaskInlineField
                    ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.assignee')}`}
                    displayValue={assigneeLabel}
                    fieldKey="assigneeUserId"
                    kind="select"
                    options={inlineAssigneeOptions}
                    testId={`task-inline-assignee-${task.id}`}
                    value={task.assigneeUserId}
                    onCommit={(value) => commitPatch({ assigneeUserId: value })}
                  />
                ) : assigneeLabel}
              </div>
            </td>
          )
          case 'status': return (
            <td {...columnCellProps} className={cellPadding} key={field}>
              {onUpdateTask && editableStatuses.length > 0 ? (
                <TaskInlineField
                  ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.status')}`}
                  displayValue={resolveWorkItemWorkflowStatusLabel(task, configuration)}
                  fieldKey="workflowStatusId"
                  kind="select"
                  options={editableStatuses.map((status) => ({
                    label: status.name,
                    value: status.id,
                  }))}
                  testId={`task-inline-status-${task.id}`}
                  value={task.workflowStatusId}
                  onCommit={(value) => commitPatch({ workflowStatusId: value })}
                />
              ) : <TaskStatusBadge configuration={configuration} task={task} />}
            </td>
          )
          case 'dueDate': return (
            <td
              {...columnCellProps}
              className={`${wrapText ? 'break-words' : 'whitespace-nowrap'} ${cellPadding} ${
                resolveWorkflowStatusCategory(task) === 'completed'
                  ? 'text-[#8f99a8] line-through'
                  : overdue ? 'text-red-700' : 'text-[#505967]'
              }`}
              key={field}
            >
              {onUpdateTask && (schedule.mode === 'due-date' || schedule.mode === 'unscheduled') ? (
                <TaskInlineField
                  ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.dueDate')}`}
                  displayValue={scheduleDisplay}
                  fieldKey="dueDate"
                  kind="date"
                  testId={`task-inline-due-date-${task.id}`}
                  value={schedule.mode === 'due-date' ? schedule.dueDate : ''}
                  onCommit={(value) => commitPatch({
                    schedule: replaceTaskDeadlineSchedule(schedule, value),
                  })}
                />
              ) : <span>{scheduleDisplay}</span>}
            </td>
          )
          case 'priority': return (
            <td {...columnCellProps} className={cellPadding} key={field}>
              {onUpdateTask ? (
                <TaskInlineField
                  ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.priority')}`}
                  displayValue={t(`tasks.priority.${task.priority}`)}
                  fieldKey="priority"
                  kind="select"
                  options={taskPriorities.map((priority) => ({
                    label: t(`tasks.priority.${priority}`),
                    value: priority,
                  }))}
                  testId={`task-inline-priority-${task.id}`}
                  value={task.priority}
                  onCommit={(value) => commitPatch({ priority: resolveTaskPriority(value) })}
                />
              ) : (
                <span className={`${priorityClasses[task.priority]} whitespace-nowrap`}>
                  <TaskViewFlagIcon />
                  {t(`tasks.priority.${task.priority}`)}
                </span>
              )}
            </td>
          )
          case 'project': return (
            <td {...columnCellProps} className={`${cellPadding} ${wrapText ? 'break-words' : 'truncate'} text-[#505967]`} key={field}>
              {task.assignedProjectId ?? '—'}
            </td>
          )
          case 'team': return (
            <td {...columnCellProps} className={`${cellPadding} ${wrapText ? 'break-words' : 'truncate'} text-[#505967]`} key={field}>
              {task.teamId}
            </td>
          )
          case 'customFields': return (
            <td {...columnCellProps} className={cellPadding} key={field}>
              {onUpdateTask ? (
                <TaskInlineCustomFields
                  configuration={configuration}
                  locale={locale}
                  onUpdateTask={onUpdateTask}
                  personLabels={personLabels}
                  personOptions={personOptions}
                  t={t}
                  task={task}
                />
              ) : (
                <TaskCustomFieldSummary
                  configuration={configuration}
                  locale={locale}
                  personLabels={personLabels}
                  t={t}
                  task={task}
                />
              )}
            </td>
          )
          default: {
            const customFieldId = field.slice('custom:'.length)
            return (
              <td {...columnCellProps} className={`${cellPadding} ${wrapText ? 'break-words' : 'truncate'} text-[#505967]`} key={field}>
                {customFieldEntries.get(customFieldId) ?? '—'}
              </td>
            )
          }
        }
      })}
      <td className="px-2 py-2 text-center">
        <div className="flex items-center justify-center gap-1">
        {onCreateTaskOpen ? (
          <button
            aria-label={`${t('tasks.addTask')}: ${taskTitle}`}
            className="grid h-9 w-9 place-items-center rounded text-lg font-semibold text-[var(--workbench-primary)] hover:bg-[var(--workbench-surface-muted)] max-[640px]:h-11 max-[640px]:w-11"
            data-testid={`task-row-add-${task.id}`}
            onClick={() => onCreateTaskOpen({
              ...(task.assigneeUserId ? { assigneeUserId: task.assigneeUserId } : {}),
              projectId,
              schedule,
              source: 'table',
              teamId: task.teamId,
              workflowStatusId: task.workflowStatusId,
            })}
            type="button"
          >
            +
          </button>
        ) : null}
        {onTaskActionMenuOpen ? (
          <button
            aria-label={`${t('tasks.action.more')}: ${taskTitle}`}
            className="grid h-9 w-9 place-items-center rounded text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] max-[640px]:h-11 max-[640px]:w-11"
            data-testid={`task-row-actions-${task.id}`}
            onClick={(event) => {
              event.stopPropagation()
              const returnFocusElement = event.currentTarget
              const bounds = returnFocusElement.getBoundingClientRect()
              onTaskActionMenuOpen(
                task,
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
      </td>
    </tr>
  )
}

/** Reports whether a row click belongs to an embedded control that keeps its own behavior. */
function isInteractiveTaskRowTarget(target: EventTarget): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(
    'button, input, select, textarea, a, [contenteditable="true"], [role="button"]',
  ))
}

/** Reports whether a canonical field can be rendered as a project task table column. */
function isSupportedProjectTaskColumn(field: string): boolean {
  return [
    'title',
    'assignee',
    'status',
    'dueDate',
    'priority',
    'project',
    'team',
    'customFields',
  ].includes(field) || field.startsWith('custom:')
}

/** Resolves a localized or configured heading for one supported project task table field. */
function resolveTaskTableColumnLabel(
  field: string,
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  configuration: WorkItemConfiguration | undefined,
  t: TaskTableTranslator,
): string {
  switch (field) {
    case 'title': return t('tasks.column.name')
    case 'assignee': return t('tasks.column.assignee')
    case 'status': return t('tasks.column.status')
    case 'dueDate': return t('tasks.column.dueDate')
    case 'priority': return t('tasks.column.priority')
    case 'project': return t('workspace.column.project')
    case 'team': return t('workspace.column.team')
    case 'customFields': return t('workItems.fields.title')
    default: {
      const customFieldId = field.slice('custom:'.length)
      for (const candidate of [
        configuration,
        ...Object.values(configurationsByTeam).map((resolved) => resolved.configuration),
      ]) {
        const definition = candidate?.customFields.find((item) => item.id === customFieldId)
        if (definition) return definition.name
      }
      return customFieldId
    }
  }
}

/** Resolves table-cell padding from the effective task-view density. */
function resolveTaskTableCellPadding(
  density: TaskViewPresentationSettings['density'] | undefined,
  titleCell = false,
): string {
  const horizontalPadding = titleCell ? 'px-5' : 'px-3'
  const verticalPadding = density === 'compact'
    ? 'py-1.5'
    : density === 'spacious'
      ? 'py-4'
      : 'py-2.5'
  return `${horizontalPadding} ${verticalPadding}`
}

/**
 * Resolves width and sticky-edge styles for one persisted table column.
 *
 * @param placement - Column width and cumulative pin offsets.
 * @param endOffsetBase - Additional trailing width reserved after end-pinned columns.
 * @param header - Whether the style is applied to a table heading.
 * @returns Inline table-cell styles that reproduce the saved layout.
 */
function resolveTaskViewColumnCellStyle(
  placement: TaskViewTableColumnPlacement,
  endOffsetBase = 0,
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
      right: (placement.endOffset ?? 0) + endOffsetBase,
      zIndex: header ? 20 : 10,
    }
  }
  return baseStyle
}

/**
 * Converts tab-separated table cells into a validated standard Work Item patch.
 *
 * Cells map to title, assignee, status, due date, and priority in that order.
 * A single-cell row is treated as a title-only update.
 */
function createTaskPatchFromPastedCells(
  cells: readonly string[],
  task: ProjectTask,
  configuration: WorkItemConfiguration | undefined,
  assigneeOptions: readonly ProjectMember[],
): WorkItemPatch | undefined {
  const patch: WorkItemPatch = {}
  const title = cells[0]

  if (title) {
    patch.title = title
  }

  const assignee = cells[1]
  if (assignee) {
    const normalizedAssignee = assignee.toLowerCase()
    const member = assigneeOptions.find((candidate) =>
      candidate.id.toLowerCase() === normalizedAssignee ||
      candidate.email.toLowerCase() === normalizedAssignee ||
      candidate.name?.toLowerCase() === normalizedAssignee,
    )

    if (!member) {
      return undefined
    }

    patch.assigneeUserId = member.id
  }

  const status = cells[2]
  if (status) {
    const normalizedStatus = status.toLowerCase()
    const editableStatus = resolveEditableWorkflowStatuses(task, configuration).find((candidate) =>
      candidate.id.toLowerCase() === normalizedStatus ||
      candidate.name.toLowerCase() === normalizedStatus,
    )

    if (!editableStatus) {
      return undefined
    }

    patch.workflowStatusId = editableStatus.id
  }

  const dueDate = cells[3]
  if (dueDate) {
    const normalizedDueDate = dueDate.trim()
    const schedule = resolveTaskSchedule(task)

    if (
      !isValidPastedTaskDueDate(normalizedDueDate) ||
      schedule.mode === 'date-range' ||
      schedule.mode === 'milestone'
    ) {
      return undefined
    }

    patch.schedule = replaceTaskDeadlineSchedule(schedule, normalizedDueDate)
  }

  const priority = cells[4]
  if (priority) {
    const normalizedPriority = priority.toLowerCase()
    if (!taskPriorities.some((candidate) => candidate === normalizedPriority)) {
      return undefined
    }
    patch.priority = resolveTaskPriority(normalizedPriority)
  }

  return Object.keys(patch).length > 0 ? patch : undefined
}

/**
 * Checks whether a pasted task deadline is a real ISO calendar date.
 *
 * @param value - Candidate `YYYY-MM-DD` value.
 * @returns True when the value round-trips through UTC calendar arithmetic.
 */
function isValidPastedTaskDueDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
}

/** Returns true when an event originates from an active inline editor control. */
function isInlineEditorTarget(target: EventTarget | null) {
  return target instanceof HTMLElement &&
    Boolean(target.closest('input, select, textarea, [contenteditable="true"]'))
}

/** Creates the common mutation patch used by table fill-down for one field. */
function createTaskFillPatch(
  sourceTask: ProjectTask,
  targetTask: ProjectTask,
  fieldKey: string,
): WorkItemPatch | undefined {
  if (fieldKey.startsWith('customField:')) {
    const fieldId = fieldKey.slice('customField:'.length)
    return {
      customFieldValues: {
        [fieldId]: sourceTask.customFieldValues[fieldId] ?? null,
      },
    }
  }

  switch (fieldKey) {
    case 'assigneeUserId':
      return { assigneeUserId: sourceTask.assigneeUserId }
    case 'dueDate': {
      const sourceSchedule = resolveTaskSchedule(sourceTask)
      const targetSchedule = resolveTaskSchedule(targetTask)
      if (
        sourceSchedule.mode === 'date-range' ||
        sourceSchedule.mode === 'milestone' ||
        targetSchedule.mode === 'date-range' ||
        targetSchedule.mode === 'milestone'
      ) {
        return undefined
      }
      return {
        schedule: replaceTaskDeadlineSchedule(
          targetSchedule,
          sourceSchedule.mode === 'due-date' ? sourceSchedule.dueDate : '',
        ),
      }
    }
    case 'priority':
      return { priority: sourceTask.priority }
    case 'workflowStatusId':
      return { workflowStatusId: sourceTask.workflowStatusId }
    case 'title':
    default:
      return { title: sourceTask.title }
  }
}
