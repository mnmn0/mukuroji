import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
  ResolvedWorkItemConfiguration,
  WorkItemPatch,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { ProjectTask, TaskPriority } from '../api/tasks'
import type { ProjectMember } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkItemPersonOption } from '../../work-items/ui/WorkItemFieldsEditor'
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
} from '../../bulk-operations/ui/BulkOperationToolbar'
import {
  createTaskKey,
  isTaskOverdue,
  resolveProjectTaskConfiguration,
  resolveTaskPriority,
  taskPriorities,
  type TaskCreateContext,
} from '../model/taskView'
import { TaskInlineField } from './TaskInlineField'
import { TaskInlineCustomFields } from './TaskInlineCustomFields'
import { resolveWorkflowStatusCategory } from '../../work-items/model/workItemDisplay'
import {
  TaskCustomFieldSummary,
  TaskStatusBadge,
  TaskViewFlagIcon,
  TaskViewPlusIcon,
} from './TaskViewPrimitives'

/** Resolves a localized task-table message. */
type TaskTableTranslator = (key: MessageKey) => string

/** Props for the independent project task table view. */
export type TaskTableViewProps = {
  /** Active Project members available to inline assignee editors. */
  assigneeOptions?: ProjectMember[]
  /** Projects available as bulk-operation move targets. */
  bulkProjectOptions: BulkOperationProjectOption[]
  /** Workspace identifier included in bulk-operation requests. */
  bulkWorkspaceId: string
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team-scoped resolved configurations used by individual rows. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Locale used to format custom-field values. */
  locale: Locale
  /** Person options available to custom-field editors. */
  personOptions?: WorkItemPersonOption[]
  /** Mapping from person identifiers to display names. */
  personLabels: Readonly<Record<string, string>>
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
  /** Person options available to custom-field editors. */
  personOptions: WorkItemPersonOption[]
  /** Mapping from person identifiers to display names. */
  personLabels: Readonly<Record<string, string>>
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
  bulkWorkspaceId,
  configuration,
  configurationsByTeam,
  locale,
  personOptions = [],
  personLabels,
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
  onBulkPreview,
  onBulkRetry,
  onBulkUndo,
  onCreateTaskOpen,
  onSelectTask,
  onUpdateTask,
  onTaskSelectionChange,
  onVisibleTaskSelectionChange,
}: TaskTableViewProps) {
  const selectionReadOnly = !bulkWorkspaceId || !onBulkPreview || !onBulkApply
  const hasTaskRows = !taskErrorMessage && tasks.length > 0
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
    void runBatchTaskUpdates(
      selectedTasks.slice(1).map((task) => ({
        patch: createTaskFillPatch(sourceTask, fieldKey),
        task,
      })),
      t('tasks.action.fill'),
    )
  }

  return (
    <>
      <BulkOperationToolbar
        key={projectId}
        projectOptions={bulkProjectOptions}
        readOnly={selectionReadOnly}
        selectedItems={selectedBulkItems}
        t={t}
        visibleItems={visibleBulkItems}
        workspaceId={bulkWorkspaceId}
        onApply={onBulkApply}
        onOperationComplete={onBulkOperationComplete}
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
          <table className={`w-full table-fixed border-collapse ${hasTaskRows ? 'min-w-[720px]' : 'min-w-0'}`}>
            {hasTaskRows ? (
              <colgroup>
                <col className="w-[34%]" />
                <col className="w-[20%]" />
                <col className="w-[13%]" />
                <col className="w-[15%]" />
                <col className="w-[14%]" />
                <col className="w-[4%]" />
              </colgroup>
            ) : null}
            {hasTaskRows ? (
              <thead>
                <tr className="workbench-table-head text-left">
                  <th className="px-5 py-2.5" scope="col">
                    <span className="inline-flex items-center gap-2">
                      {t('tasks.column.name')}
                      <span aria-hidden="true" className="text-[#8f99a8]">
                        ↕
                      </span>
                    </span>
                  </th>
                  <th className="px-3 py-2.5" scope="col">
                    {t('tasks.column.assignee')}
                  </th>
                  <th className="px-3 py-2.5" scope="col">
                    {t('tasks.column.status')}
                  </th>
                  <th className="px-3 py-2.5" scope="col">
                    {t('tasks.column.dueDate')}
                  </th>
                  <th className="px-3 py-2.5" scope="col">
                    {t('tasks.column.priority')}
                  </th>
                  <th className="px-3 py-2.5 text-center text-lg text-[#8f99a8]" scope="col">
                    +
                  </th>
                </tr>
              </thead>
            ) : null}
            <tbody>
              {taskErrorMessage ? (
                <tr>
                  <td
                    className="break-words px-5 py-7 text-sm font-semibold text-red-700"
                    colSpan={6}
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
                tasks.map((task, index) => (
                  <TaskTableRow
                    assigneeOptions={assigneeOptions}
                    configuration={resolveProjectTaskConfiguration(
                      task,
                      configurationsByTeam,
                      configuration,
                    )}
                    key={createTaskKey(task)}
                    locale={locale}
                    personOptions={personOptions}
                    personLabels={personLabels}
                    projectId={projectId}
                    rowIndex={index}
                    onTaskSelectionChange={onTaskSelectionChange}
                    onSelectTask={onSelectTask}
                    onCreateTaskOpen={onCreateTaskOpen}
                    onUpdateTask={onUpdateTask}
                    selectedForDetail={selectedDetailTaskKey === createTaskKey(task)}
                    selected={selectedTaskKeys.includes(createTaskKey(task))}
                    selectionReadOnly={selectionReadOnly}
                    t={t}
                    task={task}
                  />
                ))
              ) : (
                <tr>
                  <td
                    className="px-5 py-7 text-sm font-medium text-[#5f6874]"
                    colSpan={6}
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

/**
 * Renders one selectable project task row.
 *
 * @param props - Row data, selection state, and callbacks.
 * @returns A task table row.
 */
function TaskTableRow({
  assigneeOptions,
  configuration,
  locale,
  personOptions,
  personLabels,
  projectId,
  rowIndex,
  selected,
  selectedForDetail,
  selectionReadOnly,
  onSelectTask,
  onCreateTaskOpen,
  onUpdateTask,
  onTaskSelectionChange,
  task,
  t,
}: TaskTableRowProps) {
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'workbench-badge-danger',
    medium: 'workbench-badge-warning',
    low: 'workbench-badge-success',
  }
  const taskTitle = resolveWorkItemTitle(task)
  const overdue = isTaskOverdue(task)
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
      className={`border-b border-[#e4e7ec] text-sm font-medium text-[#1c1d1f] last:border-b-0 ${
        selectedForDetail ? 'workbench-row-selected' : 'hover:bg-[var(--workbench-surface-muted)]'
      }`}
      data-row-index={rowIndex}
      data-selected={selected ? 'true' : 'false'}
      data-testid={`task-row-${task.id}`}
    >
      <td className="px-5 py-2.5">
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
              onCommit={(value) => commitPatch({ title: value })}
            />
          ) : (
            <button
              className="min-w-0 truncate text-left font-semibold text-[var(--workbench-text)] transition hover:text-[var(--workbench-primary)]"
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
          {selected ? (
            <span className="workbench-badge-primary">
              {t('tasks.row.selected')}
            </span>
          ) : null}
        </div>
      </td>
      <td className="truncate px-3 py-2.5 text-[#505967]">
        {onUpdateTask && inlineAssigneeOptions.length > 0 ? (
          <TaskInlineField
            ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.assignee')}`}
            displayValue={resolveWorkItemAssignee(task)}
            fieldKey="assigneeUserId"
            kind="select"
            options={inlineAssigneeOptions}
            testId={`task-inline-assignee-${task.id}`}
            value={task.assigneeUserId}
            onCommit={(value) => commitPatch({ assigneeUserId: value })}
          />
        ) : resolveWorkItemAssignee(task)}
      </td>
      <td className="px-3 py-2.5">
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
      <td
        className={`whitespace-nowrap px-3 py-2.5 ${
          resolveWorkflowStatusCategory(task) === 'completed'
            ? 'text-[#8f99a8] line-through'
            : overdue ? 'text-red-700' : 'text-[#505967]'
        }`}
      >
        {onUpdateTask ? (
          <TaskInlineField
            ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.dueDate')}`}
            displayValue={task.dueDate || t('tasks.calendar.empty')}
            fieldKey="dueDate"
            kind="date"
            testId={`task-inline-due-date-${task.id}`}
            value={task.dueDate.replaceAll('/', '-')}
            onCommit={(value) => commitPatch({ dueDate: value.replaceAll('-', '/') })}
          />
        ) : task.dueDate}
      </td>
      <td className="px-3 py-2.5">
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
      <td className="px-3 py-2.5 text-center">
        {onCreateTaskOpen ? (
          <button
            aria-label={`${t('tasks.addTask')}: ${taskTitle}`}
            className="rounded px-2 py-1 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-[var(--workbench-surface-muted)]"
            data-testid={`task-row-add-${task.id}`}
            onClick={() => onCreateTaskOpen({
              ...(task.assigneeUserId ? { assigneeUserId: task.assigneeUserId } : {}),
              ...(task.dueDate ? { dueDate: task.dueDate } : {}),
              projectId,
              source: 'table',
              teamId: task.teamId,
              workflowStatusId: task.workflowStatusId,
            })}
            type="button"
          >
            +
          </button>
        ) : null}
      </td>
    </tr>
  )
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
    const normalizedDueDate = dueDate.replaceAll('-', '/')

    if (!isValidPastedTaskDueDate(normalizedDueDate)) {
      return undefined
    }

    patch.dueDate = normalizedDueDate
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

/** Returns whether a pasted task due date is a real YYYY/MM/DD calendar date. */
function isValidPastedTaskDueDate(value: string) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value)

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
  task: ProjectTask,
  fieldKey: string,
): WorkItemPatch {
  if (fieldKey.startsWith('customField:')) {
    const fieldId = fieldKey.slice('customField:'.length)
    return {
      customFieldValues: {
        [fieldId]: task.customFieldValues[fieldId] ?? null,
      },
    }
  }

  switch (fieldKey) {
    case 'assigneeUserId':
      return { assigneeUserId: task.assigneeUserId }
    case 'dueDate':
      return { dueDate: task.dueDate }
    case 'priority':
      return { priority: task.priority }
    case 'workflowStatusId':
      return { workflowStatusId: task.workflowStatusId }
    case 'title':
    default:
      return { title: task.title }
  }
}
