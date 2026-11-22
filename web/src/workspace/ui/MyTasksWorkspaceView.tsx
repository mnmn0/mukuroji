import {
  type CanonicalWorkItem,
  DEFAULT_WORK_ITEM_TYPE_ID,
  type ResolvedWorkItemConfiguration,
  type WorkItemPriority,
  type WorkItemScheduleCalendarPolicy,
  type WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import { Fragment, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import {
  groupTaskViewItems,
  type TaskViewPresentationSettings,
} from '../../task-views/model/taskViewPresentation'
import type { TaskActionContextMenuAnchorPoint } from '../../task-views/model/taskActionContextMenu'
import type { ProjectTaskDirectScheduleHandle } from '../../task-views/model/projectTaskDirectActionRequest'
import { createTaskViewItemKey } from '../../task-views/model/taskViewSelection'
import {
  resolveEditableWorkflowStatuses,
} from '../../work-items/model/workItemDisplay'
import {
  createWorkspaceTaskKey,
  createWorkspaceTaskStatusColumns,
  findWorkspaceTaskByKey,
  isTaskInWorkspaceStatusColumn,
  type WorkspaceTaskStatusColumn,
} from '../../work-items/model/workspaceWorkItems'
import {
  CompactTaskCard,
  createWorkspaceTaskTestId,
  createWorkspaceTaskTestToken,
} from '../../work-items/ui/WorkspaceWorkItemPrimitives'
import { TaskGanttView, type TaskGanttOutline } from '../../tasks/ui/TaskGanttView'
import { createTaskGanttDisplayBinding } from '../../tasks/model/taskGanttDisplay'
import type { TaskCalendarPeriods } from '../../tasks/model/taskGanttTimeline'
import { TaskCalendarView } from '../../tasks/ui/TaskCalendarView'
import { MyTasksTaskTable } from './MyTasksTaskTable'
import { getCurrentTaskMonth } from '../../tasks/model/taskScheduleWindow'
import {
  createMyTasksGanttGrouping,
  resolveMyTaskGroupValue,
  resolveMyTaskProjectLabel,
} from '../model/myTaskGrouping'

/** Layouts of the My Tasks view. */
export type MyTasksViewMode = 'board' | 'table' | 'gantt' | 'calendar'

/**
 * Props for the Workspace personal task board.
 */
export type MyTasksWorkspaceViewProps = {
  /** Checks whether one permission-pruned Work Item exposes status mutation controls. */
  canMoveTaskStatus?: (task: CanonicalWorkItem) => boolean
  /** Checks whether the table may edit one Work Item's due date and priority in place. */
  canEditTask?: (task: CanonicalWorkItem) => boolean
  /**
   * Starts a schedule change from the calendar, the Gantt chart, or the table's due date. The
   * view shows the returned preview and confirms it; schedules are read-only without it.
   */
  onRequestScheduleChange?: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => ProjectTaskDirectScheduleHandle
  /** Saves a priority chosen in the table; the priority is read-only without it. */
  onUpdatePriority?: (task: CanonicalWorkItem, priority: WorkItemPriority) => Promise<void>
  /** Workspace task keys of Work Items the user contributes to without owning them. */
  contributorTaskKeys?: ReadonlySet<string>
  /** Team IDs whose Work Item configurations could not be loaded. */
  configurationFailedTeamIds: readonly string[]
  /** Resolved Work Item configurations indexed by Team ID. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Locale used to format typed custom-field values. */
  locale?: Locale
  /** Team-qualified key that currently owns keyboard focus. */
  focusedTaskKey?: string
  /** Optional callback that requests a Work Item workflow status change. */
  onMoveTaskStatus?: (task: CanonicalWorkItem, workflowStatusId: string) => Promise<void>
  /** Optional callback that opens a selected Work Item. */
  onOpenTask?: (task: CanonicalWorkItem) => void
  /** Opens the canonical action menu for one personal Work Item card. */
  onTaskActionMenuOpen?: (
    task: CanonicalWorkItem,
    anchorPoint: TaskActionContextMenuAnchorPoint,
    returnFocusElement: HTMLElement,
  ) => void
  /** Clears a status-action entrance after its selector commits a change. */
  onStatusActionConsumed?: (task: CanonicalWorkItem) => void
  /** Cancels a revealed status action when its selector is dismissed unchanged. */
  onStatusActionCancelled?: (task: CanonicalWorkItem) => void
  /** Visible card fields, density, wrapping, and grouping selected by the effective view. */
  presentation?: TaskViewPresentationSettings
  /** Applies presentation settings changed inside a layout, such as the Gantt scale. */
  onPresentationChange?: (settings: TaskViewPresentationSettings) => void
  /** Team-qualified key whose status selector was revealed by the canonical Move action. */
  revealedStatusTaskKey?: string
  /** Person identities mapped to labels for person custom fields. */
  personLabels?: Readonly<Record<string, string>>
  /** Translator used for Workspace labels. */
  t: (key: MessageKey) => string
  /** Optional status mutation error displayed above the board. */
  taskMoveErrorMessage?: string
  /** Shared saved-view lifecycle and display controls. */
  taskViewToolbar?: ReactNode
  /** Team-qualified keys selected through the shared task-view reducer. */
  selectedTaskKeys?: readonly string[]
  /** Active layout; the board is shown when omitted. */
  viewMode?: MyTasksViewMode
  /** Switches the layout; the layout switch is hidden when omitted. */
  onViewModeChange?: (mode: MyTasksViewMode) => void
  /** Hierarchy shown as an outline by the Gantt chart. */
  ganttOutline?: TaskGanttOutline
  /** Workspace working calendar whose days off the Gantt shades; nothing is shaded when omitted. */
  workingCalendar?: WorkItemScheduleCalendarPolicy
  /** Workspace week start and fiscal year start that the Gantt and Calendar headings follow. */
  calendarPeriods?: TaskCalendarPeriods
  /** Month the calendar shows, in `YYYY-MM` form; the view keeps its own month when omitted. */
  calendarMonth?: string
  /** Moves the calendar to another month, together with `calendarMonth`. */
  onCalendarMonthChange?: (month: string) => void
  /** Notice about the outline, such as loading or Teams shown without it. */
  outlineNotice?: ReactNode
  /** Work Items the current user owns or contributes to. */
  tasks: readonly CanonicalWorkItem[]
  /** Workspace directory used to label Team-scoped workflow columns. */
  teams: readonly ProjectDirectoryTeam[]
}

/**
 * Renders the current user's Team-scoped kanban board with drag-and-drop status changes, or
 * the same Work Items as a table, a Gantt chart, or a monthly calendar.
 *
 * @param props - Owned and contributed Work Items, Team configurations, and board actions.
 * @returns The personal Workspace task board.
 */
export function MyTasksWorkspaceView({
  canEditTask,
  canMoveTaskStatus,
  onRequestScheduleChange,
  onUpdatePriority,
  contributorTaskKeys,
  configurationFailedTeamIds,
  configurationsByTeam,
  focusedTaskKey,
  locale = 'ja',
  onOpenTask,
  onTaskActionMenuOpen,
  onStatusActionConsumed,
  onStatusActionCancelled,
  personLabels = {},
  presentation,
  onPresentationChange,
  revealedStatusTaskKey,
  t,
  taskMoveErrorMessage,
  taskViewToolbar,
  selectedTaskKeys = [],
  tasks,
  teams,
  onMoveTaskStatus,
  viewMode = 'board',
  onViewModeChange,
  ganttOutline,
  workingCalendar,
  calendarPeriods,
  calendarMonth: controlledCalendarMonth,
  onCalendarMonthChange,
  outlineNotice,
}: MyTasksWorkspaceViewProps) {
  const ganttGroupBy = presentation?.groupBy
  const ganttGroupDirection = presentation?.groupDirection
  const ganttGroup = useMemo(
    () => createMyTasksGanttGrouping(ganttGroupBy, ganttGroupDirection, configurationsByTeam, teams, t),
    [configurationsByTeam, ganttGroupBy, ganttGroupDirection, t, teams],
  )
  const ganttTasks = useMemo(() => [...tasks], [tasks])
  const [localCalendarMonth, setLocalCalendarMonth] = useState(() => getCurrentTaskMonth())
  const calendarMonth = controlledCalendarMonth ?? localCalendarMonth
  /** Moves the calendar, reporting the month to the owner when it controls the month. */
  const changeCalendarMonth = (month: string) => {
    setLocalCalendarMonth(month)
    onCalendarMonthChange?.(month)
  }
  const [draggedTaskKey, setDraggedTaskKey] = useState<string | undefined>()
  const [dropTargetColumnKey, setDropTargetColumnKey] = useState<string | undefined>()
  const [movingTaskKeys, setMovingTaskKeys] = useState<ReadonlySet<string>>(() => new Set())
  /** Checks both the route handler and the exact server-authoritative Work Item scope. */
  const canMoveTask = (task: CanonicalWorkItem) => Boolean(
    onMoveTaskStatus && (canMoveTaskStatus?.(task) ?? true),
  )
  const statusColumns = useMemo(
    () => createWorkspaceTaskStatusColumns(tasks, configurationsByTeam, teams),
    [configurationsByTeam, tasks, teams],
  )
  const configurationUnavailableTasks = useMemo(
    () => tasks.filter((task) => configurationFailedTeamIds.includes(task.teamId)),
    [configurationFailedTeamIds, tasks],
  )
  const visibleStatusColumns = presentation?.display.showEmptyGroups ?? true
    ? statusColumns
    : statusColumns.filter((column) =>
        tasks.some((task) => isTaskInWorkspaceStatusColumn(task, column))
      )
  const cardListSpacing = presentation?.density === 'compact'
    ? 'gap-2 px-3 pb-3'
    : presentation?.density === 'spacious'
      ? 'gap-4 px-5 pb-5'
      : 'gap-3 px-4 pb-4'

  /**
   * Validates and requests a Work Item status change while tracking pending state.
   *
   * @param task - Work Item to move.
   * @param workflowStatusId - Destination workflow status ID.
   * @returns Nothing.
   */
  const moveTaskToStatus = (task: CanonicalWorkItem, workflowStatusId: string) => {
    if (!onMoveTaskStatus || !canMoveTask(task) || task.workflowStatusId === workflowStatusId) {
      return
    }

    const configuration = configurationsByTeam[task.teamId]?.configuration
    const allowedStatuses = resolveEditableWorkflowStatuses(task, configuration)

    if (!allowedStatuses.some((status) => status.id === workflowStatusId)) {
      return
    }

    const taskKey = createWorkspaceTaskKey(task)

    setDraggedTaskKey(undefined)
    setDropTargetColumnKey(undefined)
    setMovingTaskKeys((currentTaskKeys) => new Set(currentTaskKeys).add(taskKey))
    void onMoveTaskStatus(task, workflowStatusId)
      .catch(() => undefined)
      .finally(() => {
        setMovingTaskKeys((currentTaskKeys) => {
          const nextTaskKeys = new Set(currentTaskKeys)

          nextTaskKeys.delete(taskKey)
          return nextTaskKeys
        })
      })
  }

  /**
   * Starts a native Work Item drag interaction.
   *
   * @param event - Native drag event carrying the Work Item key.
   * @param task - Work Item being dragged.
   * @returns Nothing.
   */
  const handleDragStart = (event: DragEvent<HTMLElement>, task: CanonicalWorkItem) => {
    if (!canMoveTask(task)) {
      return
    }

    const taskKey = createWorkspaceTaskKey(task)

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-mukuroji-task-key', taskKey)
    event.dataTransfer.setData('text/plain', taskKey)
    setDraggedTaskKey(taskKey)
  }

  /**
   * Clears native Work Item drag state.
   *
   * @returns Nothing.
   */
  const handleDragEnd = () => {
    setDraggedTaskKey(undefined)
    setDropTargetColumnKey(undefined)
  }

  /**
   * Enables a valid Team-scoped workflow column as the current drop target.
   *
   * @param event - Native drag event over the destination column.
   * @param column - Candidate destination workflow column.
   * @returns Nothing.
   */
  const handleDragOver = (
    event: DragEvent<HTMLElement>,
    column: WorkspaceTaskStatusColumn,
  ) => {
    const carriesTaskKey = draggedTaskKey ||
      event.dataTransfer.types.includes('application/x-mukuroji-task-key') ||
      event.dataTransfer.types.includes('text/plain')

    const draggedTask = draggedTaskKey
      ? findWorkspaceTaskByKey(tasks, draggedTaskKey)
      : undefined

    if (
      !onMoveTaskStatus ||
      !carriesTaskKey ||
      (draggedTask && !canMoveTask(draggedTask)) ||
      (draggedTask && column.teamId !== draggedTask.teamId) ||
      (draggedTask &&
        column.workItemTypeId !== (draggedTask.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID))
    ) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetColumnKey(column.key)
  }

  /**
   * Resolves a dropped Work Item and requests a valid Team-scoped status change.
   *
   * @param event - Native drop event carrying the Work Item key.
   * @param column - Destination workflow column.
   * @returns Nothing.
   */
  const handleDrop = (
    event: DragEvent<HTMLElement>,
    column: WorkspaceTaskStatusColumn,
  ) => {
    event.preventDefault()

    if (!onMoveTaskStatus) {
      return
    }

    const taskKey =
      event.dataTransfer.getData('application/x-mukuroji-task-key') ||
      event.dataTransfer.getData('text/plain') ||
      draggedTaskKey
    const task = taskKey ? findWorkspaceTaskByKey(tasks, taskKey) : undefined

    if (!task) {
      return
    }

    if (
      column.teamId === task.teamId &&
      column.workItemTypeId === (task.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID)
    ) {
      moveTaskToStatus(task, column.status.id)
    }
  }

  const viewModeSwitch = onViewModeChange ? (
    <div
      aria-label={t('workspace.myTasks.layout')}
      className="inline-flex h-9 w-fit overflow-hidden rounded-[7px] border border-[var(--workbench-border-strong)] bg-surface"
      role="group"
    >
      {(['board', 'table', 'gantt', 'calendar'] as const).map((mode) => (
        <button
          aria-pressed={viewMode === mode}
          className={`px-3.5 text-sm font-semibold transition ${
            viewMode === mode ? 'bg-[var(--workbench-primary)] text-white' : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
          }`}
          data-testid={`my-tasks-view-${mode}`}
          key={mode}
          onClick={() => onViewModeChange(mode)}
          type="button"
        >
          {t(`issues.view.${mode}`)}
        </button>
      ))}
    </div>
  ) : null

  if (viewMode === 'calendar') {
    return (
      <div className="grid gap-4">
        {taskViewToolbar}
        {viewModeSwitch}
        <TaskCalendarView
          calendarPeriods={calendarPeriods}
          configurationsByTeam={configurationsByTeam}
          month={calendarMonth}
          monthNote="shown-month"
          onMonthChange={changeCalendarMonth}
          onRequestScheduleChange={onRequestScheduleChange}
          onSelectTask={onOpenTask}
          t={t}
          tasks={ganttTasks}
        />
      </div>
    )
  }

  if (viewMode === 'table') {
    return (
      <div className="grid min-w-0 gap-4">
        {taskViewToolbar}
        {viewModeSwitch}
        <MyTasksTaskTable
          canEditTask={canEditTask}
          configurationsByTeam={configurationsByTeam}
          contributorTaskKeys={contributorTaskKeys}
          focusedTaskKey={focusedTaskKey}
          locale={locale}
          onOpenTask={onOpenTask}
          onRequestScheduleChange={onRequestScheduleChange}
          onTaskActionMenuOpen={onTaskActionMenuOpen}
          onUpdatePriority={onUpdatePriority}
          personLabels={personLabels}
          presentation={presentation}
          selectedTaskKeys={selectedTaskKeys}
          t={t}
          tasks={tasks}
          teams={teams}
        />
      </div>
    )
  }

  if (viewMode === 'gantt') {
    return (
      <div className="grid gap-4">
        {taskViewToolbar}
        {viewModeSwitch}
        {outlineNotice}
        <TaskGanttView
          configurationsByTeam={configurationsByTeam}
          group={ganttGroup}
          onRequestScheduleChange={onRequestScheduleChange}
          onSelectTask={onOpenTask}
          outline={ganttOutline}
          t={t}
          tasks={ganttTasks}
          workingCalendar={workingCalendar}
          calendarPeriods={calendarPeriods}
          {...createTaskGanttDisplayBinding(presentation, onPresentationChange)}
        />
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      {taskViewToolbar}
      {viewModeSwitch}
      {taskMoveErrorMessage ? (
        <p
          className="workbench-badge-danger rounded-lg px-4 py-3 text-sm"
          data-testid="my-tasks-move-error"
          role="alert"
        >
          {taskMoveErrorMessage}
        </p>
      ) : null}
      <div
        aria-label={t('workspace.myTasks.title')}
        className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2 max-[900px]:grid-flow-row max-[900px]:grid-cols-1 max-[900px]:overflow-visible max-[900px]:pb-0"
        data-testid="my-tasks-kanban"
      >
        {visibleStatusColumns.map((column) => {
          const columnTasks = tasks.filter((task) => isTaskInWorkspaceStatusColumn(task, column))
          const isDropTarget = dropTargetColumnKey === column.key
          const primaryCardGroupField = presentation?.groupBy === 'status'
            ? presentation.subgroupBy
            : presentation?.groupBy
          const secondaryCardGroupField = presentation?.groupBy !== 'status'
            ? presentation?.subgroupBy
            : undefined
          const primaryCardGroups = primaryCardGroupField
            ? groupTaskViewItems(
                columnTasks,
                primaryCardGroupField,
                (task, field) => resolveMyTaskGroupValue(
                  task,
                  field,
                  configurationsByTeam,
                  teams,
                  t,
                ),
                presentation?.groupBy === 'status'
                  ? presentation.subgroupDirection
                  : presentation?.groupDirection,
              )
            : []
          const orderedColumnTasks: CanonicalWorkItem[] = []
          const primaryHeadingByTaskKey = new Map<string, (typeof primaryCardGroups)[number]>()
          const secondaryHeadingByTaskKey = new Map<string, string>()
          for (const primaryGroup of primaryCardGroups) {
            const secondaryGroups = secondaryCardGroupField
              ? groupTaskViewItems(
                  primaryGroup.items,
                  secondaryCardGroupField,
                  (task, field) => resolveMyTaskGroupValue(
                    task,
                    field,
                    configurationsByTeam,
                    teams,
                    t,
                  ),
                  presentation?.subgroupDirection,
                )
              : []
            const orderedPrimaryItems = secondaryGroups.length > 0
              ? secondaryGroups.flatMap((secondaryGroup) => secondaryGroup.items)
              : primaryGroup.items
            const firstTask = orderedPrimaryItems[0]
            if (firstTask) primaryHeadingByTaskKey.set(createWorkspaceTaskKey(firstTask), primaryGroup)
            if (secondaryGroups.length > 0) {
              for (const secondaryGroup of secondaryGroups) {
                const firstSecondaryTask = secondaryGroup.items[0]
                if (firstSecondaryTask) {
                  secondaryHeadingByTaskKey.set(
                    createWorkspaceTaskKey(firstSecondaryTask),
                    `${secondaryGroup.label} (${secondaryGroup.items.length})`,
                  )
                }
                orderedColumnTasks.push(...secondaryGroup.items)
              }
            } else {
              orderedColumnTasks.push(...primaryGroup.items)
            }
          }
          if (primaryCardGroups.length === 0) orderedColumnTasks.push(...columnTasks)

          return (
            <section
              aria-label={column.label}
              className={`min-h-[420px] min-w-[260px] rounded-lg border transition-colors ${
                isDropTarget
                  ? 'border-tone-99d7cf bg-tone-e5f7f4 ring-2 ring-tone-99d7cf/40'
                  : 'border-transparent bg-[var(--workbench-surface-muted)]'
              }`}
              data-testid={`my-tasks-column-${createWorkspaceTaskTestToken(column.key)}`}
              key={column.key}
              onDragLeave={() => setDropTargetColumnKey(undefined)}
              onDragOver={(event) => handleDragOver(event, column)}
              onDrop={(event) => handleDrop(event, column)}
            >
              <SectionHeader
                title={column.label}
                meta={t('tasks.board.columnCount').replace('{count}', String(columnTasks.length))}
              />
              <div className={`grid ${cardListSpacing}`}>
                {orderedColumnTasks.map((task) => {
                  const taskKey = createWorkspaceTaskKey(task)
                  const taskViewKey = createTaskViewItemKey(task.teamId, task.id)
                  const isMoving = movingTaskKeys.has(taskKey)
                  const configuration = configurationsByTeam[task.teamId]?.configuration
                  const editableStatuses = resolveEditableWorkflowStatuses(task, configuration)
                  const canMoveCurrentTask = canMoveTask(task)
                  const primaryHeading = primaryHeadingByTaskKey.get(taskKey)
                  const secondaryHeading = secondaryHeadingByTaskKey.get(taskKey)

                  return (
                    <Fragment key={taskKey}>
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
                    <CompactTaskCard
                      configuration={configuration}
                      density={presentation?.density}
                      draggable={canMoveCurrentTask && !isMoving}
                      isDragging={draggedTaskKey === taskKey}
                      isMoving={isMoving}
                      focused={focusedTaskKey === taskViewKey}
                      involvementLabel={contributorTaskKeys?.has(taskKey)
                        ? t('workspace.myTasks.involvement.contributor')
                        : undefined}
                      projectLabel={resolveMyTaskProjectLabel(task, teams)}
                      locale={locale}
                      personLabels={personLabels}
                      showAssigneeAvatar={presentation?.display.showAssigneeAvatars}
                      selected={selectedTaskKeys.includes(taskViewKey)}
                      t={t}
                      task={task}
                      testId={`my-tasks-card-${createWorkspaceTaskTestId(task)}`}
                      teamLabel={teams.find((team) => team.id === task.teamId)?.name ?? task.teamId}
                      visibleFields={presentation?.columns.map((column) => column.field)}
                      wrapText={presentation?.display.wrapTitles}
                      onDragEnd={handleDragEnd}
                      onDragStart={(event) => handleDragStart(event, task)}
                      onOpenActionMenu={onTaskActionMenuOpen
                        ? (anchorPoint, returnFocusElement) => onTaskActionMenuOpen(
                            task,
                            anchorPoint,
                            returnFocusElement,
                          )
                        : undefined}
                      onOpenTask={onOpenTask}
                      onStatusChange={!canMoveCurrentTask
                        ? undefined
                        : (nextStatus) => {
                            moveTaskToStatus(task, nextStatus)
                            onStatusActionConsumed?.(task)
                          }}
                      onStatusActionCancel={
                        revealedStatusTaskKey === taskViewKey && onStatusActionCancelled
                          ? () => onStatusActionCancelled(task)
                          : undefined
                      }
                      revealStatusControl={revealedStatusTaskKey === taskViewKey}
                      workflowStatuses={editableStatuses}
                      taskViewItemKey={taskViewKey}
                    />
                    </Fragment>
                  )
                })}
                {columnTasks.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-surface px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
                    {t('tasks.board.empty')}
                  </p>
                ) : null}
              </div>
            </section>
          )
        })}
        {visibleStatusColumns.length === 0 && configurationUnavailableTasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-surface px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('tasks.board.empty')}
          </p>
        ) : null}
        {configurationUnavailableTasks.length > 0 ? (
          <section
            aria-label={t('workItems.configuration.loadError')}
            className="workbench-panel min-h-[420px] min-w-[260px] border-amber-200"
            data-testid="my-tasks-configuration-unavailable-column"
          >
            <SectionHeader
              title={t('workItems.configuration.loadError')}
              meta={t('tasks.board.columnCount').replace(
                '{count}',
                String(configurationUnavailableTasks.length),
              )}
            />
            <div className="grid gap-3 px-4 pb-4">
              {configurationUnavailableTasks.map((task) => (
                <CompactTaskCard
                  draggable={false}
                  density={presentation?.density}
                  focused={focusedTaskKey === createTaskViewItemKey(task.teamId, task.id)}
                  involvementLabel={contributorTaskKeys?.has(createWorkspaceTaskKey(task))
                    ? t('workspace.myTasks.involvement.contributor')
                    : undefined}
                  key={createWorkspaceTaskKey(task)}
                  locale={locale}
                  personLabels={personLabels}
                  showAssigneeAvatar={presentation?.display.showAssigneeAvatars}
                  selected={selectedTaskKeys.includes(
                    createTaskViewItemKey(task.teamId, task.id),
                  )}
                  t={t}
                  task={task}
                  testId={`my-tasks-card-${createWorkspaceTaskTestId(task)}`}
                  projectLabel={resolveMyTaskProjectLabel(task, teams)}
                  teamLabel={teams.find((team) => team.id === task.teamId)?.name ?? task.teamId}
                  visibleFields={presentation?.columns.map((column) => column.field)}
                  wrapText={presentation?.display.wrapTitles}
                  onOpenTask={onOpenTask}
                  onOpenActionMenu={onTaskActionMenuOpen
                    ? (anchorPoint, returnFocusElement) => onTaskActionMenuOpen(
                        task,
                        anchorPoint,
                        returnFocusElement,
                      )
                    : undefined}
                  taskViewItemKey={createTaskViewItemKey(task.teamId, task.id)}
                  workflowStatuses={[]}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
