import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
  ResolvedWorkItemConfiguration,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { ProjectTask, TaskPriority } from '../api/tasks'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../issues/model/workItemDisplay'
import {
  BulkOperationToolbar,
  type BulkOperationProjectOption,
  type BulkOperationSelection,
} from '../../bulk-operations/ui/BulkOperationToolbar'
import {
  createTaskKey,
  isTaskOverdue,
  resolveProjectTaskConfiguration,
} from '../model/taskView'
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
  onCreateTaskOpen?: () => void
  /** Selects a task for the detail pane. */
  onSelectTask: (task: ProjectTask) => void
  /** Updates one row's bulk-selection state. */
  onTaskSelectionChange: (taskKey: string, selected: boolean) => void
  /** Updates bulk selection for all currently visible rows. */
  onVisibleTaskSelectionChange: (selectionKeys: string[], selected: boolean) => void
}

/** Props for one row in the project task table. */
type TaskTableRowProps = {
  /** Configuration used to render workflow and custom-field values. */
  configuration?: WorkItemConfiguration
  /** Locale used to format custom-field values. */
  locale: Locale
  /** Mapping from person identifiers to display names. */
  personLabels: Readonly<Record<string, string>>
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
  bulkProjectOptions,
  bulkWorkspaceId,
  configuration,
  configurationsByTeam,
  locale,
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
  onTaskSelectionChange,
  onVisibleTaskSelectionChange,
}: TaskTableViewProps) {
  const selectionReadOnly = !bulkWorkspaceId || !onBulkPreview || !onBulkApply
  const hasTaskRows = !taskErrorMessage && tasks.length > 0

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
      >
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
                    configuration={resolveProjectTaskConfiguration(
                      task,
                      configurationsByTeam,
                      configuration,
                    )}
                    key={createTaskKey(task)}
                    locale={locale}
                    personLabels={personLabels}
                    rowIndex={index}
                    onTaskSelectionChange={onTaskSelectionChange}
                    onSelectTask={onSelectTask}
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
              onClick={onCreateTaskOpen}
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
  configuration,
  locale,
  personLabels,
  rowIndex,
  selected,
  selectedForDetail,
  selectionReadOnly,
  onSelectTask,
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
          <button
            className="min-w-0 truncate text-left font-semibold text-[var(--workbench-text)] transition hover:text-[var(--workbench-primary)]"
            onClick={() => onSelectTask(task)}
            type="button"
          >
            {taskTitle}
          </button>
          <TaskCustomFieldSummary
            configuration={configuration}
            locale={locale}
            personLabels={personLabels}
            task={task}
          />
          {selected ? (
            <span className="workbench-badge-primary">
              {t('tasks.row.selected')}
            </span>
          ) : null}
        </div>
      </td>
      <td className="truncate px-3 py-2.5 text-[#505967]">{resolveWorkItemAssignee(task)}</td>
      <td className="px-3 py-2.5">
        <TaskStatusBadge configuration={configuration} task={task} />
      </td>
      <td
        className={`whitespace-nowrap px-3 py-2.5 ${
          resolveWorkflowStatusCategory(task) === 'completed'
            ? 'text-[#8f99a8] line-through'
            : overdue ? 'text-red-700' : 'text-[#505967]'
        }`}
      >
        {task.dueDate}
      </td>
      <td className="px-3 py-2.5">
        <span className={`${priorityClasses[task.priority]} whitespace-nowrap`}>
          <TaskViewFlagIcon />
          {t(`tasks.priority.${task.priority}`)}
        </span>
      </td>
      <td className="px-3 py-2.5" />
    </tr>
  )
}
