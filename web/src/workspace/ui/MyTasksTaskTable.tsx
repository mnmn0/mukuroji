import type {
  CanonicalWorkItem,
  ResolvedWorkItemConfiguration,
  WorkItemPriority,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { TeamIssuesApiError } from '../../issues/api'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { MoreHorizontalIcon } from '../../shared/ui/icons'
import type { TaskActionContextMenuAnchorPoint } from '../../task-views/model/taskActionContextMenu'
import {
  isProjectTaskDirectScheduleCancelled,
  type ProjectTaskDirectScheduleHandle,
} from '../../task-views/model/projectTaskDirectActionRequest'
import type { TaskViewPresentationSettings } from '../../task-views/model/taskViewPresentation'
import { createTaskViewItemKey } from '../../task-views/model/taskViewSelection'
import {
  createReplaceTaskScheduleOperation,
  formatTaskScheduleRange,
  replaceTaskDeadlineSchedule,
  resolveTaskSchedule,
  taskScheduleModeLabelKeys,
} from '../../tasks/model/taskSchedule'
import {
  isTaskOverdue,
  resolveTaskCustomFieldEntries,
  resolveTaskPriority,
  taskPriorities,
} from '../../tasks/model/taskView'
import {
  CalendarSchedulePreview,
  type PendingCalendarScheduleChange,
} from '../../tasks/ui/TaskCalendarView'
import { resolveCalendarScheduleError } from '../../tasks/model/taskScheduleChangeError'
import { TaskInlineField } from '../../tasks/ui/TaskInlineField'
import {
  TaskCustomFieldSummary,
  TaskPriorityBadge,
  TaskStatusBadge,
  TaskWorkItemTypeBadge,
} from '../../tasks/ui/TaskViewPrimitives'
import {
  resolveWorkflowStatusCategory,
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../work-items/model/workItemDisplay'
import { createWorkspaceTaskKey } from '../../work-items/model/workspaceWorkItems'
import { createWorkspaceTaskTestId } from '../../work-items/ui/WorkspaceWorkItemPrimitives'
import { resolveMyTaskProjectLabel } from '../model/myTaskGrouping'
import {
  createMyTasksTableSections,
  resolveMyTasksTableColumns,
} from '../model/myTaskTable'

/** Props for the My Tasks table. */
export type MyTasksTaskTableProps = {
  /** Checks whether the person may edit one row's due date and priority in place. */
  canEditTask?: (task: CanonicalWorkItem) => boolean
  /** Resolved Work Item configurations indexed by Team ID. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Workspace task keys of Work Items the user contributes to without owning them. */
  contributorTaskKeys?: ReadonlySet<string>
  /** Team-qualified key that currently owns keyboard focus. */
  focusedTaskKey?: string
  /** Locale used to format custom-field values. */
  locale: Locale
  /** Opens a Work Item. */
  onOpenTask?: (task: CanonicalWorkItem) => void
  /**
   * Starts a due-date change; the table shows its preview and confirms it. The due date is
   * edited in place only with this callback.
   */
  onRequestScheduleChange?: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => ProjectTaskDirectScheduleHandle
  /** Saves a new priority; the priority is edited in place only with this callback. */
  onUpdatePriority?: (task: CanonicalWorkItem, priority: WorkItemPriority) => Promise<void>
  /** Opens the canonical action menu for one row. */
  onTaskActionMenuOpen?: (
    task: CanonicalWorkItem,
    anchorPoint: TaskActionContextMenuAnchorPoint,
    returnFocusElement: HTMLElement,
  ) => void
  /** Person identities mapped to labels for person custom fields. */
  personLabels: Readonly<Record<string, string>>
  /** Visible columns, density, wrapping, and grouping selected by the effective view. */
  presentation?: TaskViewPresentationSettings
  /** Team-qualified keys selected through the shared task-view reducer. */
  selectedTaskKeys: readonly string[]
  /** Translator used for labels. */
  t: (key: MessageKey) => string
  /** Filtered and sorted Work Items, listed in this order. */
  tasks: readonly CanonicalWorkItem[]
  /** Workspace directory used for Team and Project labels. */
  teams: readonly ProjectDirectoryTeam[]
}

/**
 * Renders the current user's Work Items as a table across Teams and Projects.
 *
 * Rows follow the effective view's sort, which is the due date for the built-in view, and its
 * grouping. Selecting a title opens the Work Item; the row menu offers the shared actions. The
 * due date and the priority of a writable row can be changed in place; a due-date change is
 * confirmed in the same schedule preview as the calendar, with any dependency ripple.
 *
 * @param props - Work Items, configurations, presentation, and open callbacks.
 * @returns The My Tasks table.
 */
export function MyTasksTaskTable({
  canEditTask,
  configurationsByTeam,
  contributorTaskKeys,
  focusedTaskKey,
  locale,
  onOpenTask,
  onRequestScheduleChange,
  onTaskActionMenuOpen,
  onUpdatePriority,
  personLabels,
  presentation,
  selectedTaskKeys,
  t,
  tasks,
  teams,
}: MyTasksTaskTableProps) {
  const columns = resolveMyTasksTableColumns(presentation)
  const sections = useMemo(
    () => createMyTasksTableSections(tasks, presentation, configurationsByTeam, teams, t),
    [configurationsByTeam, presentation, t, tasks, teams],
  )
  const columnCount = columns.length + 1
  const cellPadding = presentation?.density === 'compact'
    ? 'px-3 py-1.5'
    : presentation?.density === 'spacious'
      ? 'px-3 py-3.5'
      : 'px-3 py-2.5'
  const wrapText = presentation?.display.wrapTitles ?? false
  const textOverflow = wrapText ? 'whitespace-normal break-words' : 'truncate'
  const [pendingScheduleChange, setPendingScheduleChange] = useState<PendingCalendarScheduleChange>()
  const [isApplyingSchedule, setIsApplyingSchedule] = useState(false)
  const [editErrorMessage, setEditErrorMessage] = useState<string>()
  const activeScheduleHandleRef = useRef<ProjectTaskDirectScheduleHandle | undefined>(undefined)
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => () => {
    activeScheduleHandleRef.current?.cancel()
  }, [])

  /**
   * Previews a new due date and opens the confirmation dialog.
   *
   * @param task - Work Item of the row.
   * @param dueDate - New due date, or an empty string to remove it.
   * @returns Nothing once the preview is shown; rejects when it cannot be shown.
   */
  const commitDueDate = async (task: CanonicalWorkItem, dueDate: string) => {
    if (!onRequestScheduleChange) throw new Error('Due date editing is unavailable.')
    setEditErrorMessage(undefined)
    activeScheduleHandleRef.current?.cancel()
    let handle: ProjectTaskDirectScheduleHandle
    try {
      handle = onRequestScheduleChange(
        task,
        createReplaceTaskScheduleOperation(
          replaceTaskDeadlineSchedule(resolveTaskSchedule(task), dueDate),
        ),
      )
    } catch (error) {
      setEditErrorMessage(t('tasks.schedule.invalid'))
      throw error
    }
    activeScheduleHandleRef.current = handle
    try {
      const controller = await handle.preview
      if (activeScheduleHandleRef.current?.token !== handle.token) {
        handle.cancel()
        return
      }
      setPendingScheduleChange({ controller, task })
    } catch (error) {
      if (activeScheduleHandleRef.current?.token === handle.token) {
        activeScheduleHandleRef.current = undefined
      }
      if (!isProjectTaskDirectScheduleCancelled(error)) {
        setEditErrorMessage(resolveCalendarScheduleError(error, t))
      }
      throw error
    }
  }

  /** Persists the previewed due date and returns focus to the row's due-date control. */
  const confirmScheduleChange = async () => {
    const pending = pendingScheduleChange
    if (!pending) return
    setIsApplyingSchedule(true)
    setEditErrorMessage(undefined)
    try {
      await pending.controller.confirm()
    } catch (error) {
      if (!isProjectTaskDirectScheduleCancelled(error)) {
        setEditErrorMessage(resolveCalendarScheduleError(error, t))
      }
    } finally {
      if (activeScheduleHandleRef.current?.token === pending.controller.token) {
        activeScheduleHandleRef.current = undefined
      }
      setPendingScheduleChange(undefined)
      setIsApplyingSchedule(false)
      focusDueDateControl(sectionRef.current, pending.task)
    }
  }

  /** Discards the previewed due date. */
  const cancelScheduleChange = () => {
    const pending = pendingScheduleChange
    if (!pending || isApplyingSchedule) return
    pending.controller.cancel()
    if (activeScheduleHandleRef.current?.token === pending.controller.token) {
      activeScheduleHandleRef.current = undefined
    }
    setPendingScheduleChange(undefined)
    focusDueDateControl(sectionRef.current, pending.task)
  }

  /**
   * Saves a new priority for one row.
   *
   * @param task - Work Item of the row.
   * @param value - Selected priority.
   * @returns Nothing once saved; rejects so the editor stays open on failure.
   */
  const commitPriority = async (task: CanonicalWorkItem, value: string) => {
    if (!onUpdatePriority) throw new Error('Priority editing is unavailable.')
    setEditErrorMessage(undefined)
    try {
      await onUpdatePriority(task, resolveTaskPriority(value))
    } catch (error) {
      setEditErrorMessage(
        error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict'
          ? t('tasks.action.conflict')
          : t('workspace.myTasks.updateError'),
      )
      throw error
    }
  }

  /**
   * Opens the action menu of one row from its overflow button.
   *
   * @param event - Click on the overflow button.
   * @param task - Work Item of the row.
   */
  const openActionMenuFromButton = (event: MouseEvent<HTMLButtonElement>, task: CanonicalWorkItem) => {
    if (!onTaskActionMenuOpen) return
    const returnFocusElement = event.currentTarget
    const bounds = returnFocusElement.getBoundingClientRect()
    onTaskActionMenuOpen(task, { x: bounds.right, y: bounds.bottom }, returnFocusElement)
  }

  /**
   * Renders one cell of a row.
   *
   * @param field - Column field.
   * @param task - Work Item of the row.
   * @returns The table cell.
   */
  const renderCell = (field: string, task: CanonicalWorkItem) => {
    const configuration = configurationsByTeam[task.teamId]?.configuration
    switch (field) {
      case 'title': {
        const title = resolveWorkItemTitle(task)
        return (
          <td className={`${cellPadding} pl-5`} key={field}>
            <div className="flex min-w-[220px] items-center gap-2">
              {onOpenTask ? (
                <button
                  className={`min-w-0 text-left font-semibold text-[var(--workbench-text)] hover:text-[var(--workbench-primary-text)] max-[640px]:min-h-11 ${textOverflow}`}
                  data-testid={`my-tasks-table-open-${createWorkspaceTaskTestId(task)}`}
                  onClick={() => onOpenTask(task)}
                  type="button"
                >
                  {title}
                </button>
              ) : (
                <span className={`min-w-0 font-semibold text-[var(--workbench-text)] ${textOverflow}`}>{title}</span>
              )}
              {contributorTaskKeys?.has(createWorkspaceTaskKey(task)) ? (
                <span className="workbench-badge flex-none">
                  {t('workspace.myTasks.involvement.contributor')}
                </span>
              ) : null}
            </div>
          </td>
        )
      }
      case 'status': return (
        <td className={`${cellPadding} whitespace-nowrap`} key={field}>
          <TaskStatusBadge configuration={configuration} task={task} />
        </td>
      )
      case 'assignee': return (
        <td className={`${cellPadding} ${textOverflow} text-fg-505967`} key={field}>
          {resolveWorkItemAssignee(task)}
        </td>
      )
      case 'dueDate': {
        const schedule = resolveTaskSchedule(task)
        const range = formatTaskScheduleRange(schedule)
        const display = range ?? t(taskScheduleModeLabelKeys[schedule.mode])
        const tone = resolveWorkflowStatusCategory(task) === 'completed'
          ? 'text-fg-8f99a8 line-through'
          : isTaskOverdue(task) ? 'text-fg-red-700' : 'text-fg-505967'
        // Ranges and milestones keep their own editors in the detail and the Gantt chart.
        const canEditDueDate = onRequestScheduleChange !== undefined &&
          (canEditTask?.(task) ?? false) &&
          (schedule.mode === 'due-date' || schedule.mode === 'unscheduled')
        return (
          <td
            className={`${cellPadding} whitespace-nowrap ${tone}`}
            data-testid={`my-tasks-table-due-${createWorkspaceTaskTestId(task)}`}
            key={field}
          >
            {canEditDueDate ? (
              <TaskInlineField
                ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.dueDate')} (${resolveWorkItemTitle(task)})`}
                displayValue={display}
                fieldKey="dueDate"
                kind="date"
                testId={`my-tasks-table-due-edit-${createWorkspaceTaskTestId(task)}`}
                value={schedule.mode === 'due-date' ? schedule.dueDate : ''}
                onCommit={(value) => commitDueDate(task, value)}
              />
            ) : display}
          </td>
        )
      }
      case 'priority': return (
        <td className={`${cellPadding} whitespace-nowrap`} key={field}>
          {onUpdatePriority && (canEditTask?.(task) ?? false) ? (
            <TaskInlineField
              ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.priority')} (${resolveWorkItemTitle(task)})`}
              displayValue={t(`tasks.priority.${task.priority}`)}
              fieldKey="priority"
              kind="select"
              options={taskPriorities.map((priority) => ({
                label: t(`tasks.priority.${priority}`),
                value: priority,
              }))}
              testId={`my-tasks-table-priority-edit-${createWorkspaceTaskTestId(task)}`}
              value={task.priority}
              onCommit={(value) => commitPriority(task, value)}
            />
          ) : (
            <TaskPriorityBadge priority={task.priority} t={t} />
          )}
        </td>
      )
      case 'workItemType': return (
        <td className={`${cellPadding} whitespace-nowrap`} key={field}>
          <TaskWorkItemTypeBadge configuration={configuration} task={task} />
        </td>
      )
      case 'project': return (
        <td className={`${cellPadding} ${textOverflow} text-fg-505967`} key={field}>
          {resolveMyTaskProjectLabel(task, teams) ?? '—'}
        </td>
      )
      case 'team': return (
        <td className={`${cellPadding} ${textOverflow} text-fg-505967`} key={field}>
          {teams.find((team) => team.id === task.teamId)?.name ?? task.teamId}
        </td>
      )
      case 'customFields': return (
        <td className={cellPadding} key={field}>
          <TaskCustomFieldSummary
            configuration={configuration}
            locale={locale}
            personLabels={personLabels}
            t={t}
            task={task}
          />
        </td>
      )
      default: {
        const customFieldId = field.slice('custom:'.length)
        const entry = resolveTaskCustomFieldEntries(task, configuration, locale, personLabels, t)
          .find((candidate) => candidate.definition.id === customFieldId)
        return (
          <td className={`${cellPadding} ${textOverflow} text-fg-505967`} key={field}>
            {entry?.value ?? '—'}
          </td>
        )
      }
    }
  }

  return (
    <section
      aria-label={t('workspace.myTasks.title')}
      className="workbench-table relative min-w-0 overflow-hidden"
      data-testid="my-tasks-table"
      ref={sectionRef}
    >
      {editErrorMessage ? (
        <p
          className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-fg-red-700"
          data-testid="my-tasks-table-edit-error"
          role="alert"
        >
          {editErrorMessage}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="workbench-table-head text-left">
              {columns.map((field) => (
                <th
                  className={`${field === 'title' ? 'pl-5 pr-3' : 'px-3'} py-2.5 whitespace-nowrap`}
                  data-column-field={field}
                  key={field}
                  scope="col"
                >
                  {resolveMyTasksTableColumnLabel(field, configurationsByTeam, t)}
                </th>
              ))}
              <th className="w-14 px-2 py-2.5" scope="col">
                <span className="sr-only">{t('tasks.action.more')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr>
                <td
                  className="px-5 py-7 text-sm font-medium text-fg-5f6874"
                  colSpan={columnCount}
                  data-testid="my-tasks-table-empty"
                >
                  {t('tasks.board.empty')}
                </td>
              </tr>
            ) : sections.map((section) => (
              <Fragment key={section.key}>
                {section.heading ? (
                  <tr className="border-b border-tone-e4e7ec">
                    <th
                      className={`${section.heading.secondary ? 'pl-9 text-[11px]' : 'pl-5 text-xs'} bg-[var(--workbench-surface-muted)] py-1.5 text-left font-bold text-[var(--workbench-muted)]`}
                      colSpan={columnCount}
                      scope="rowgroup"
                    >
                      {section.heading.label} ({section.heading.count})
                    </th>
                  </tr>
                ) : null}
                {section.items.map((task) => {
                  const taskViewKey = createTaskViewItemKey(task.teamId, task.id)
                  const focused = focusedTaskKey === taskViewKey
                  const selected = selectedTaskKeys.includes(taskViewKey)
                  return (
                    <tr
                      aria-current={focused || undefined}
                      className={`border-b border-tone-e4e7ec font-medium text-fg-1c1d1f last:border-b-0 ${
                        selected ? 'workbench-row-selected' : 'hover:bg-[var(--workbench-surface-muted)]'
                      } ${focused ? 'outline outline-2 -outline-offset-2 outline-blue-500/40' : ''}`}
                      data-task-view-focused={focused ? 'true' : 'false'}
                      data-task-view-item-key={taskViewKey}
                      data-task-view-selected={selected ? 'true' : 'false'}
                      data-testid={`my-tasks-table-row-${createWorkspaceTaskTestId(task)}`}
                      key={taskViewKey}
                      // Focusable from script only, so a menu opened by right-click returns focus here.
                      tabIndex={-1}
                      onContextMenu={onTaskActionMenuOpen
                        ? (event) => {
                            event.preventDefault()
                            onTaskActionMenuOpen(
                              task,
                              { x: event.clientX, y: event.clientY },
                              event.currentTarget,
                            )
                          }
                        : undefined}
                    >
                      {columns.map((field) => renderCell(field, task))}
                      <td className="px-2 py-1 text-center">
                        {onTaskActionMenuOpen ? (
                          <button
                            aria-label={`${t('tasks.action.more')}: ${resolveWorkItemTitle(task)}`}
                            className="grid h-9 w-9 place-items-center rounded text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary-text)] max-[640px]:h-11 max-[640px]:w-11"
                            data-testid={`my-tasks-table-actions-${createWorkspaceTaskTestId(task)}`}
                            onClick={(event) => openActionMenuFromButton(event, task)}
                            type="button"
                          >
                            <MoreHorizontalIcon className="h-5 w-5" />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p
        className="border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-3 text-right text-sm font-medium text-fg-5f6874"
        data-testid="my-tasks-table-count"
      >
        {t('tasks.count').replace('{count}', String(tasks.length))}
      </p>
      {pendingScheduleChange ? (
        <CalendarSchedulePreview
          isApplying={isApplyingSchedule}
          onCancel={cancelScheduleChange}
          onConfirm={() => void confirmScheduleChange()}
          pending={pendingScheduleChange}
          t={t}
        />
      ) : null}
    </section>
  )
}

/**
 * Returns focus to a row's due-date control after its preview dialog closes.
 *
 * @param container - Table section that holds the rows.
 * @param task - Work Item whose due date was previewed.
 */
function focusDueDateControl(container: HTMLElement | null, task: CanonicalWorkItem): void {
  requestAnimationFrame(() => {
    const row = [...container?.querySelectorAll<HTMLElement>('[data-task-view-item-key]') ?? []]
      .find((candidate) => candidate.dataset.taskViewItemKey === createTaskViewItemKey(task.teamId, task.id))
    row?.querySelector<HTMLElement>('[data-task-field="dueDate"]')?.focus()
  })
}

/**
 * Resolves the heading of one My Tasks table column.
 *
 * @param field - Column field, either built-in or `custom:<fieldId>`.
 * @param configurationsByTeam - Team configurations that define custom fields.
 * @param t - Translator used for built-in headings.
 * @returns The column heading.
 */
function resolveMyTasksTableColumnLabel(
  field: string,
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  t: (key: MessageKey) => string,
): string {
  switch (field) {
    case 'title': return t('tasks.column.name')
    case 'status': return t('tasks.column.status')
    case 'assignee': return t('tasks.column.assignee')
    case 'dueDate': return t('tasks.column.dueDate')
    case 'priority': return t('tasks.column.priority')
    case 'workItemType': return t('tasks.column.workItemType')
    case 'project': return t('workspace.column.project')
    case 'team': return t('workspace.column.team')
    case 'customFields': return t('workItems.fields.title')
    default: {
      const customFieldId = field.slice('custom:'.length)
      return Object.values(configurationsByTeam)
        .flatMap((resolved) => resolved.configuration.customFields)
        .find((definition) => definition.id === customFieldId)?.name ?? customFieldId
    }
  }
}
