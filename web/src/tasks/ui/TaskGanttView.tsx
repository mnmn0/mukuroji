import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type {
  PlanningSnapshot,
  ResolvedWorkItemConfiguration,
  WorkItemDependencyEndpoint,
  WorkItemConfiguration,
  WorkItemSchedule,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
} from '@mukuroji/contracts'
import type { ProjectTask } from '../api/tasks'
import { TeamIssuesApiError } from '../../issues/api'
import type { MessageKey } from '../../shared/i18n/i18n'
import { useModalFocus } from '../../shared/ui/useModalFocus'
import {
  isProjectTaskDirectScheduleCancelled,
  type ProjectTaskDirectScheduleController,
  type ProjectTaskDirectScheduleHandle,
} from '../../task-views/model/projectTaskDirectActionRequest'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../work-items/model/workItemDisplay'
import {
  createWorkItemDependencyEndpointKey,
  createWorkItemDependencyRows,
  createWorkItemDependencySummaries,
  resolveWorkItemDependencySummary,
  type WorkItemDependencyCreateDraft,
  type WorkItemDependencyRow,
} from '../../work-items/model/workItemDependencies'
import { WorkItemDependencyChips } from '../../work-items/ui/WorkItemDependencyChips'
import {
  WorkItemDependencyPanel,
} from '../../work-items/ui/WorkItemDependencyPanel'
import {
  addTaskTimelineDays,
  createMoveTaskScheduleOperation,
  createReplaceTaskScheduleOperation,
  createResizeTaskScheduleOperation,
  createTaskTimelineDateRange,
  formatTaskScheduleRange,
  resolveTaskSchedule,
  resolveTaskScheduleEndDate,
  resolveTaskSchedulePrimaryDate,
  resolveTaskScheduleStartDate,
  tryAddTaskTimelineDays,
} from '../model/taskSchedule'
import {
  createTaskKey,
  resolveProjectTaskConfiguration,
  type TaskCreateContext,
} from '../model/taskView'
import {
  TaskStatusBadge,
  TaskViewHeading,
} from './TaskViewPrimitives'
import { TaskSchedulePreviewMetadata } from './TaskSchedulePreviewMetadata'

const GANTT_DAY_WIDTH = 42
const GANTT_TABLE_WIDTH = 360
const GANTT_ROW_HEIGHT = 124
const GANTT_BAR_CENTER_OFFSET = 46
const GANTT_EXTERNAL_STUB_HEIGHT = 44
const MAX_GANTT_TIMELINE_COLUMNS = 180
const MILLISECONDS_PER_CALENDAR_DAY = 86_400_000

/** Formats a signed dependency offset without losing lead semantics. */
function formatSignedLag(lagDays: number, t: TaskGanttTranslator): string {
  return `${lagDays > 0 ? '+' : ''}${lagDays}${t('workItems.dependencies.daySuffix')}`
}

/** Resolves a localized task Gantt-view message. */
type TaskGanttTranslator = (key: MessageKey) => string

/** Context used when a task is created from a schedule-aware surface. */
type TaskScheduleCreateContext = TaskCreateContext & {
  /** Optional canonical schedule selected by a date-range interaction. */
  schedule?: WorkItemSchedule
}

/** A task paired with the canonical schedule rendered in its Gantt row. */
type GanttTaskRow = {
  /** Work Item rendered in the row. */
  task: ProjectTask
  /** Canonical schedule rendered for the task. */
  schedule: WorkItemSchedule
}

/** One bounded Gantt column that may aggregate several calendar dates. */
type GanttTimelineColumn = {
  /** Inclusive first date represented by the column. */
  startDate: string
  /** Inclusive final date represented by the column. */
  endDate: string
  /** Compact visible label for the timeline header. */
  label: string
}

/** A preview waiting for the user to confirm or cancel it. */
type PendingGanttScheduleChange = {
  /** Task whose schedule operation was previewed. */
  task: ProjectTask
  /** Exact canonical invocation controlling preview confirmation and cancellation. */
  controller: ProjectTaskDirectScheduleController
}

/** Drag operation carried from a Gantt bar or resize handle to a date cell. */
type GanttDragChange = {
  /** Stable composite key of the dragged Work Item. */
  taskKey: string
  /** Schedule operation selected by the drag source. */
  type: 'move' | 'resize'
}

/** One external endpoint rendered in the dedicated cross-Project lane. */
type GanttExternalEndpointStub = {
  /** Dependency that owns the external endpoint. */
  dependencyId: string
  /** Visible endpoint title or identifier fallback. */
  label: string
  /** Horizontal anchor on the timeline. */
  x: number
  /** Vertical center inside the external lane. */
  y: number
}

/** SVG connector joining two local bars or one local bar and an external stub. */
type GanttDependencyConnector = {
  /** Whether the edge belongs to the authoritative critical path. */
  critical: boolean
  /** Number of authoritative conflicts reported for this edge. */
  conflictCount: number
  /** Canonical dependency identifier. */
  dependencyId: string
  /** Orthogonal SVG path between endpoint anchors. */
  path: string
}

/** Complete overlay layout for dependency connectors and external endpoint stubs. */
type GanttDependencyLayout = {
  /** In-chart dependency connectors. */
  connectors: GanttDependencyConnector[]
  /** Height reserved above local task rows for cross-Project endpoints. */
  externalLaneHeight: number
  /** External endpoint labels rendered in the reserved lane. */
  externalStubs: GanttExternalEndpointStub[]
}

/** Props for the independent project task Gantt view. */
export type TaskGanttViewProps = {
  /** Unfiltered tasks used to distinguish Project membership from the rendered filter result. */
  allProjectTasks?: ProjectTask[]
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageScheduleDependencyEndpoint?: (endpoint: WorkItemDependencyEndpoint) => boolean
  /** Project receiving contextual Gantt creates. */
  projectId?: string
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team-scoped resolved configurations used by task statuses. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Tasks displayed in schedule order. */
  tasks: ProjectTask[]
  /** Authoritative dependency graph used for lines and row indicators. */
  planningSnapshot?: PlanningSnapshot
  /** Translator used for Gantt-view labels. */
  t: TaskGanttTranslator
  /** Opens the create panel with a planning-date context. */
  onCreateTaskOpen?: (context?: TaskScheduleCreateContext) => void
  /** Creates a canonical Work Item schedule dependency. */
  onCreateScheduleDependency?: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Deletes a canonical Work Item schedule dependency. */
  onDeleteScheduleDependency?: (dependency: WorkItemScheduleDependency) => void | Promise<void>
  /** Selects a task in the shared detail pane. */
  onSelectTask?: (task: ProjectTask) => void
  /** Starts a canonical Schedule action and returns its exact preview controller. */
  onRequestScheduleChange?: (
    task: ProjectTask,
    operation: WorkItemScheduleOperation,
  ) => ProjectTaskDirectScheduleHandle
  /** Updates a canonical Work Item schedule dependency rule. */
  onUpdateScheduleDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
}

/** Props for the Gantt schedule-preview dialog. */
type GanttSchedulePreviewProps = {
  /** Preview and target task waiting for confirmation. */
  pending: PendingGanttScheduleChange
  /** Whether the confirmed schedule is being persisted. */
  isApplying: boolean
  /** Translator used by dialog actions. */
  t: TaskGanttTranslator
  /** Applies the previewed schedule. */
  onConfirm: () => void
  /** Discards the preview. */
  onCancel: () => void
}

/**
 * Renders an editable task table and date-axis Gantt bars from canonical schedules.
 *
 * Every move, resize, or left-table edit is previewed by the server. The returned canonical
 * schedule is only persisted after the user confirms the before/after view.
 *
 * @param props - Tasks, workflow configurations, and schedule mutation callbacks.
 * @returns The independent project task Gantt view.
 */
export function TaskGanttView({
  allProjectTasks,
  canManageScheduleDependencyEndpoint,
  configuration,
  configurationsByTeam,
  onCreateTaskOpen,
  onCreateScheduleDependency,
  onDeleteScheduleDependency,
  onRequestScheduleChange,
  onSelectTask,
  onUpdateScheduleDependency,
  planningSnapshot,
  projectId,
  t,
  tasks,
}: TaskGanttViewProps) {
  const projectTasks = allProjectTasks ?? tasks
  const rows = useMemo(() => createGanttRows(tasks), [tasks])
  const dependencySummaries = useMemo(
    () => createWorkItemDependencySummaries(planningSnapshot),
    [planningSnapshot],
  )
  const visibleTaskKeys = useMemo(() => new Set(tasks.map((task) =>
    createWorkItemDependencyEndpointKey({ teamId: task.teamId, workItemId: task.id })
  )), [tasks])
  const projectTaskKeys = useMemo(() => new Set(projectTasks.map((task) =>
    createWorkItemDependencyEndpointKey({ teamId: task.teamId, workItemId: task.id })
  )), [projectTasks])
  const projectScopeEndpoints = useMemo(() => projectTasks.map((task) => ({
    teamId: task.teamId,
    workItemId: task.id,
  })), [projectTasks])
  const dependencyRows = useMemo(() => {
    return createWorkItemDependencyRows(planningSnapshot).filter((row) =>
      visibleTaskKeys.has(createWorkItemDependencyEndpointKey(row.dependency.predecessor)) ||
      visibleTaskKeys.has(createWorkItemDependencyEndpointKey(row.dependency.successor))
    )
  }, [planningSnapshot, visibleTaskKeys])
  const timelineColumns = useMemo(
    () => createGanttTimelineColumns([
      ...rows.map((row) => row.schedule),
      ...dependencyRows.flatMap((row) => [
        ...(row.predecessor ? [row.predecessor.schedule] : []),
        ...(row.successor ? [row.successor.schedule] : []),
      ]),
    ]),
    [dependencyRows, rows],
  )
  const dependencyLayout = useMemo(
    () => createGanttDependencyLayout(
      dependencyRows,
      rows,
      timelineColumns,
      projectTaskKeys,
    ),
    [dependencyRows, projectTaskKeys, rows, timelineColumns],
  )
  const [dragChange, setDragChange] = useState<GanttDragChange>()
  const dragChangeRef = useRef<GanttDragChange | undefined>(undefined)
  const [busyTaskKey, setBusyTaskKey] = useState<string>()
  const [pendingChange, setPendingChange] = useState<PendingGanttScheduleChange>()
  const [isApplying, setIsApplying] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()
  const isMountedRef = useRef(true)
  const activeScheduleHandleRef = useRef<ProjectTaskDirectScheduleHandle | undefined>(undefined)
  const pendingChangeRef = useRef<PendingGanttScheduleChange | undefined>(undefined)
  const nextScheduleRequestSequenceRef = useRef(0)
  const canEditSchedule = onRequestScheduleChange !== undefined

  useEffect(() => {
    pendingChangeRef.current = pendingChange
  }, [pendingChange])
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      nextScheduleRequestSequenceRef.current += 1
      activeScheduleHandleRef.current?.cancel()
    }
  }, [])

  /** Requests the server-owned before/after schedule preview. */
  const previewScheduleChange = async (
    task: ProjectTask,
    operation: WorkItemScheduleOperation,
  ) => {
    if (!onRequestScheduleChange) {
      return
    }

    const sequence = nextScheduleRequestSequenceRef.current + 1
    nextScheduleRequestSequenceRef.current = sequence
    activeScheduleHandleRef.current?.cancel()
    pendingChangeRef.current?.controller.cancel()
    pendingChangeRef.current = undefined
    setPendingChange(undefined)
    const handle = onRequestScheduleChange(task, operation)
    activeScheduleHandleRef.current = handle
    const taskKey = createTaskKey(task)
    setBusyTaskKey(taskKey)
    setErrorMessage(undefined)
    try {
      const controller = await handle.preview
      if (!isMountedRef.current || nextScheduleRequestSequenceRef.current !== sequence) {
        handle.cancel()
        if (activeScheduleHandleRef.current?.token === handle.token) {
          activeScheduleHandleRef.current = undefined
        }
        return
      }
      const pending = { controller, task }
      pendingChangeRef.current = pending
      setPendingChange(pending)
    } catch (error) {
      if (
        isMountedRef.current &&
        nextScheduleRequestSequenceRef.current === sequence &&
        !isProjectTaskDirectScheduleCancelled(error)
      ) setErrorMessage(resolveScheduleActionError(error, t))
      if (activeScheduleHandleRef.current?.token === handle.token) {
        activeScheduleHandleRef.current = undefined
      }
    } finally {
      if (isMountedRef.current && nextScheduleRequestSequenceRef.current === sequence) {
        setBusyTaskKey(undefined)
      }
    }
  }

  /** Persists the direct canonical result from the current preview. */
  const confirmScheduleChange = async () => {
    if (!pendingChange) {
      return
    }

    const schedule = findDirectPreviewSchedule(
      pendingChange.controller.preview,
      pendingChange.task,
    )
    if (!schedule) {
      pendingChange.controller.cancel()
      if (activeScheduleHandleRef.current?.token === pendingChange.controller.token) {
        activeScheduleHandleRef.current = undefined
      }
      pendingChangeRef.current = undefined
      setPendingChange(undefined)
      setErrorMessage(t('tasks.action.updateError'))
      return
    }

    setIsApplying(true)
    setErrorMessage(undefined)
    try {
      await pendingChange.controller.confirm()
    } catch (error) {
      if (isMountedRef.current && !isProjectTaskDirectScheduleCancelled(error)) {
        setErrorMessage(resolveScheduleActionError(error, t))
      }
    } finally {
      if (pendingChangeRef.current?.controller.token === pendingChange.controller.token) {
        pendingChangeRef.current = undefined
      }
      if (activeScheduleHandleRef.current?.token === pendingChange.controller.token) {
        activeScheduleHandleRef.current = undefined
      }
      if (isMountedRef.current) {
        setPendingChange((current) =>
          current?.controller.token === pendingChange.controller.token ? undefined : current
        )
        setIsApplying(false)
      }
    }
  }

  /** Converts one row mode through a complete schedule replacement preview. */
  const previewModeChange = (row: GanttTaskRow, mode: WorkItemSchedule['mode']) => {
    if (row.schedule.mode === mode) {
      return
    }
    if (row.schedule.mode === 'unscheduled' && mode !== 'unscheduled') {
      setErrorMessage(t('tasks.schedule.selectDateFirst'))
      return
    }
    const fallbackDate = mode === 'due-date'
      ? resolveTaskScheduleEndDate(row.schedule)
      : resolveTaskSchedulePrimaryDate(row.schedule)
    if (!fallbackDate) {
      return
    }
    void previewScheduleChange(
      row.task,
      createReplaceTaskScheduleOperation(createModeReplacement(row.schedule, mode, fallbackDate)),
    )
  }

  /** Starts an HTML drag carrying a schedule move or resize intent. */
  const startDrag = (
    event: DragEvent<HTMLElement>,
    row: GanttTaskRow,
    type: GanttDragChange['type'],
  ) => {
    const nextDragChange = { taskKey: createTaskKey(row.task), type }
    dragChangeRef.current = nextDragChange
    setDragChange(nextDragChange)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', nextDragChange.taskKey)
    event.dataTransfer.setData('application/x-mukuroji-gantt-change', type)
  }

  /** Previews the drag operation against the date beneath the pointer. */
  const dropOnDate = (
    row: GanttTaskRow,
    date: string,
    transferredTaskKey: string,
    transferredType: string,
  ) => {
    const taskKey = createTaskKey(row.task)
    const activeDragChange = dragChangeRef.current ?? dragChange
    const type = activeDragChange?.taskKey === taskKey
      ? activeDragChange.type
      : transferredTaskKey === taskKey
        ? readGanttDragChangeType(transferredType)
        : undefined
    if (!type) {
      return
    }

    const operation = type === 'resize'
      ? createResizeTaskScheduleOperation(date)
      : createMoveTaskScheduleOperation(date)
    dragChangeRef.current = undefined
    setDragChange(undefined)
    void previewScheduleChange(row.task, operation)
  }

  return (
    <section
      aria-label={t('tasks.view.gantt')}
      className="workbench-table mt-3 overflow-hidden"
    >
      <TaskViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey="tasks.view.gantt"
      />
      {dependencyRows.length > 0 ? (
        <ul
          aria-label={t('workItems.dependencies.title')}
          className="grid gap-1 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3"
          data-testid="task-gantt-dependencies"
        >
          {dependencyRows.map((row) => {
            const hasExternalEndpoint = !projectTaskKeys.has(
              createWorkItemDependencyEndpointKey(row.dependency.predecessor),
            ) || !projectTaskKeys.has(
              createWorkItemDependencyEndpointKey(row.dependency.successor),
            )
            return (
              <li
                className={`flex flex-wrap items-center gap-2 rounded-md border bg-white px-3 py-2 text-xs font-semibold ${row.conflicts.length > 0
                  ? 'border-red-300 text-red-700'
                  : row.critical
                    ? 'border-amber-300 text-amber-800'
                    : 'border-[var(--workbench-border)] text-[var(--workbench-text)]'}`}
                data-testid={`task-gantt-dependency-${row.dependency.id}`}
                key={row.dependency.id}
              >
                <svg aria-hidden="true" className="h-4 w-10 shrink-0" viewBox="0 0 40 16">
                  <path d="M1 8h33" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path d="m30 3 7 5-7 5" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
                <span>
                  <span className="sr-only">{t('workItems.dependencies.predecessor')}: </span>
                  {row.predecessor?.title ?? row.dependency.predecessor.workItemId}
                </span>
                <span aria-hidden="true">→</span>
                <span>
                  <span className="sr-only">{t('workItems.dependencies.successor')}: </span>
                  {row.successor?.title ?? row.dependency.successor.workItemId}
                </span>
                {hasExternalEndpoint ? (
                  <span className="workbench-badge">{t('workItems.dependencies.external')}</span>
                ) : null}
                {row.critical ? (
                  <span className="workbench-badge-danger">{t('workItems.dependencies.critical')}</span>
                ) : null}
                {row.conflicts.length > 0 ? (
                  <span className="workbench-badge-danger">
                    {t('workItems.dependencies.conflictsCount').replace(
                      '{count}',
                      String(row.conflicts.length),
                    )}
                  </span>
                ) : null}
                <span className="workbench-badge">
                  {t('workItems.dependencies.type')}: {t(`workItems.dependencies.type.${row.dependency.type}`)}
                </span>
                <span className="workbench-badge">
                  {t('workItems.dependencies.lagDays')}: {formatSignedLag(row.dependency.lagDays, t)}
                </span>
                <span className="workbench-badge">
                  {t('workItems.dependencies.constraint')}:{' '}
                  {row.dependency.constraint
                    ? `${t(`workItems.dependencies.constraint.kind.${row.dependency.constraint.kind}`)} · ${t(`workItems.dependencies.constraint.anchor.${row.dependency.constraint.anchor}`)} · ${row.dependency.constraint.date}`
                    : t('workItems.dependencies.constraint.none')}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {planningSnapshot ? (
        <details className="border-b border-[var(--workbench-border)] bg-white px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-[var(--workbench-primary)]">
            {t('workItems.dependencies.title')}
          </summary>
          <div className="mt-4">
            <WorkItemDependencyPanel
              canManageEndpoint={canManageScheduleDependencyEndpoint}
              onCreate={onCreateScheduleDependency}
              onDelete={onDeleteScheduleDependency}
              onUpdate={onUpdateScheduleDependency}
              scopeEndpoints={projectScopeEndpoints}
              snapshot={planningSnapshot}
              t={t}
            />
          </div>
        </details>
      ) : null}
      {onCreateTaskOpen ? (
        <div className="flex justify-end border-b border-[#e4e7ec] px-4 py-2">
          <button
            className="text-sm font-semibold text-[var(--workbench-primary)] hover:underline"
            onClick={() => onCreateTaskOpen({
              ...(projectId ? { projectId } : {}),
              source: 'gantt',
            })}
            type="button"
          >
            + {t('tasks.gantt.add')}
          </button>
        </div>
      ) : null}
      {errorMessage ? (
        <p className="border-b border-[#fecaca] bg-[#fef2f2] px-4 py-2 text-sm font-medium text-[#b42318]" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto" role="grid">
          <div
            className="grid min-w-max border-b border-[#d8dde5] bg-[#f8fafb]"
            role="row"
            style={{ gridTemplateColumns: `${GANTT_TABLE_WIDTH}px ${timelineColumns.length * GANTT_DAY_WIDTH}px` }}
          >
            <div className="sticky left-0 z-20 border-r border-[#d8dde5] bg-[#f8fafb] px-4 py-2 text-xs font-bold uppercase tracking-wide text-[#667085]" role="columnheader">
              {t('tasks.gantt.owner')}
            </div>
            <div
              className="grid"
              style={{ gridTemplateColumns: `repeat(${timelineColumns.length}, ${GANTT_DAY_WIDTH}px)` }}
            >
              {timelineColumns.map((column) => (
                <div
                  aria-label={column.startDate === column.endDate
                    ? column.startDate
                    : `${column.startDate} – ${column.endDate}`}
                  className="border-r border-[#e4e7ec] px-1 py-2 text-center text-[10px] font-semibold text-[#667085]"
                  key={column.startDate}
                  role="columnheader"
                  title={column.startDate === column.endDate
                    ? column.startDate
                    : `${column.startDate} – ${column.endDate}`}
                >
                  {column.label}
                </div>
              ))}
            </div>
          </div>
          <div className="relative min-w-max">
            {dependencyLayout.externalLaneHeight > 0 ? (
              <div
                className="grid min-w-max border-b border-[#d8dde5] bg-[#f8fafb]"
                data-testid="task-gantt-external-lane"
                style={{
                  gridTemplateColumns: `${GANTT_TABLE_WIDTH}px ${timelineColumns.length * GANTT_DAY_WIDTH}px`,
                  height: `${dependencyLayout.externalLaneHeight}px`,
                }}
              >
                <div className="sticky left-0 z-10 border-r border-[#d8dde5] bg-[#f8fafb] px-4 py-3 text-xs font-bold uppercase tracking-wide text-[#667085]">
                  {t('workItems.dependencies.externalLane')}
                </div>
                <div className="relative bg-white">
                  {dependencyLayout.externalStubs.map((stub) => (
                    <div
                      className="absolute z-[2] max-w-[220px] -translate-x-1/2 truncate rounded-full border border-[#98a2b3] bg-white px-2 py-1 text-[11px] font-bold text-[#344054] shadow-sm"
                      data-testid={`task-gantt-external-${stub.dependencyId}`}
                      key={stub.dependencyId}
                      style={{ left: `${stub.x}px`, top: `${stub.y - 14}px` }}
                      title={t('workItems.dependencies.externalEndpoint').replace('{title}', stub.label)}
                    >
                      {t('workItems.dependencies.externalEndpoint').replace('{title}', stub.label)}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          {rows.map((row) => {
            const taskKey = createTaskKey(row.task)
            const isBusy = busyTaskKey === taskKey
            const bar = createGanttBar(row.schedule, timelineColumns)
            return (
              <article
                className="grid min-w-max border-b border-[#e4e7ec] last:border-b-0"
                key={taskKey}
                role="row"
                style={{
                  gridTemplateColumns: `${GANTT_TABLE_WIDTH}px ${timelineColumns.length * GANTT_DAY_WIDTH}px`,
                  height: `${GANTT_ROW_HEIGHT}px`,
                }}
              >
                <div className="sticky left-0 z-10 grid min-h-0 gap-2 overflow-y-auto border-r border-[#d8dde5] bg-white px-4 py-3" role="gridcell">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      {onSelectTask ? (
                        <button
                          className="block max-w-full truncate text-left text-sm font-semibold text-[#1c1d1f] hover:text-[var(--workbench-primary)]"
                          onClick={() => onSelectTask(row.task)}
                          type="button"
                        >
                          {resolveWorkItemTitle(row.task)}
                        </button>
                      ) : (
                        <p className="truncate text-sm font-semibold text-[#1c1d1f]">{resolveWorkItemTitle(row.task)}</p>
                      )}
                      <p className="mt-1 truncate text-xs font-medium text-[#5f6874]">
                        {resolveWorkItemAssignee(row.task)}
                      </p>
                      <WorkItemDependencyChips
                        className="mt-1"
                        summary={resolveWorkItemDependencySummary(
                          dependencySummaries,
                          { teamId: row.task.teamId, workItemId: row.task.id },
                        )}
                        t={t}
                      />
                    </div>
                    <span className="flex items-center gap-2">
                      {onCreateTaskOpen ? (
                        <button
                          aria-label={`${t('tasks.gantt.add')}: ${resolveWorkItemTitle(row.task)}`}
                          className="rounded px-2 py-1 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-[#e5f7f4]"
                          data-testid={`task-gantt-add-${row.task.id}`}
                          onClick={() => onCreateTaskOpen({
                            ...(row.task.assigneeUserId ? { assigneeUserId: row.task.assigneeUserId } : {}),
                            projectId: projectId ?? row.task.assignedProjectId ?? '',
                            schedule: row.schedule,
                            source: 'gantt',
                            teamId: row.task.teamId,
                            workflowStatusId: row.task.workflowStatusId,
                          })}
                          type="button"
                        >
                          +
                        </button>
                      ) : null}
                      <TaskStatusBadge
                        configuration={resolveProjectTaskConfiguration(
                          row.task,
                          configurationsByTeam,
                          configuration,
                        )}
                        task={row.task}
                      />
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`gantt-mode-${taskKey}`}>{t('tasks.schedule.mode')}</label>
                    <select
                      className="rounded border border-[#cfd5de] bg-white px-2 py-1 text-xs font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={!canEditSchedule || isBusy}
                      id={`gantt-mode-${taskKey}`}
                      onChange={(event) => {
                        const mode = readScheduleMode(event.currentTarget.value)
                        if (mode) {
                          previewModeChange(row, mode)
                        }
                      }}
                      value={row.schedule.mode}
                    >
                      <option value="unscheduled">{t('tasks.schedule.unscheduled')}</option>
                      <option value="due-date">{t('tasks.schedule.dueDate')}</option>
                      <option value="date-range">{t('tasks.schedule.dateRange')}</option>
                      <option value="milestone">{t('tasks.schedule.milestone')}</option>
                    </select>
                    <GanttDateEditor
                      disabled={!canEditSchedule || isBusy}
                      onPreview={(operation) => void previewScheduleChange(row.task, operation)}
                      schedule={row.schedule}
                      t={t}
                      taskKey={taskKey}
                    />
                    {isBusy ? <span className="text-xs text-[#667085]" role="status">{t('bulk.previewing')}</span> : null}
                  </div>
                </div>
                <div
                  aria-label={`${resolveWorkItemTitle(row.task)}: ${describeSchedule(row.schedule, t)}`}
                  className="relative min-h-0 bg-white"
                  data-testid={`task-gantt-timeline-${row.task.id}`}
                  onDragOver={(event) => {
                    if ((dragChangeRef.current ?? dragChange)?.taskKey === taskKey) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const date = resolveGanttDropDate(event, timelineColumns)
                    if (date) {
                      dropOnDate(
                        row,
                        date,
                        event.dataTransfer.getData('text/plain'),
                        event.dataTransfer.getData('application/x-mukuroji-gantt-change'),
                      )
                    }
                  }}
                  role="gridcell"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${GANTT_DAY_WIDTH - 1}px, #eef0f3 ${GANTT_DAY_WIDTH - 1}px, #eef0f3 ${GANTT_DAY_WIDTH}px)`,
                  }}
                >
                  {bar ? (
                    <div
                      className={`absolute top-7 z-[2] h-9 overflow-visible text-xs font-bold shadow-sm ${resolveGanttBarClass(row.schedule.mode)}`}
                      style={{
                        left: `${bar.left}px`,
                        width: `${bar.width}px`,
                      }}
                    >
                      <button
                        aria-label={canEditSchedule && !isBusy
                          ? t('tasks.schedule.moveA11y').replace(
                              '{task}',
                              resolveWorkItemTitle(row.task),
                            )
                          : `${resolveWorkItemTitle(row.task)}: ${describeSchedule(row.schedule, t)}`}
                        className="flex h-full w-full items-center px-2 text-left focus:outline-none focus:ring-2 focus:ring-[var(--workbench-primary)]"
                        data-testid={`task-gantt-bar-${row.task.id}`}
                        draggable={canEditSchedule && !isBusy}
                        onClick={() => onSelectTask?.(row.task)}
                        onDragEnd={() => {
                          dragChangeRef.current = undefined
                          setDragChange(undefined)
                        }}
                        onDragStart={(event) => startDrag(event, row, 'move')}
                        onKeyDown={(event) => {
                          if (canEditSchedule && !isBusy) {
                            handleMoveKey(event, row.schedule, (date) => {
                              void previewScheduleChange(row.task, createMoveTaskScheduleOperation(date))
                            })
                          }
                        }}
                        type="button"
                      >
                        <span className="pointer-events-none truncate">{resolveGanttBarText(row.schedule, t)}</span>
                      </button>
                      {row.schedule.mode === 'date-range' ? (
                        <button
                          aria-label={t('tasks.schedule.resizeA11y').replace(
                            '{task}',
                            resolveWorkItemTitle(row.task),
                          )}
                          className="absolute -right-1 top-0 h-full w-3 cursor-ew-resize rounded bg-[#087c70] focus:outline-none focus:ring-2 focus:ring-white"
                          data-testid={`task-gantt-resize-${row.task.id}`}
                          disabled={!canEditSchedule || isBusy}
                          draggable={canEditSchedule && !isBusy}
                          onClick={(event) => event.stopPropagation()}
                          onDragEnd={() => {
                            dragChangeRef.current = undefined
                            setDragChange(undefined)
                          }}
                          onDragStart={(event) => {
                            event.stopPropagation()
                            startDrag(event, row, 'resize')
                          }}
                          onKeyDown={(event) => handleResizeKey(event, row.schedule, (date) => {
                            void previewScheduleChange(row.task, createResizeTaskScheduleOperation(date))
                          })}
                          type="button"
                        />
                      ) : null}
                    </div>
                  ) : (
                    <span className="absolute left-3 top-9 z-[1] rounded border border-dashed border-[#98a2b3] bg-white px-2 py-1 text-xs font-semibold text-[#667085]">
                      {t('tasks.calendar.empty')}
                    </span>
                  )}
                </div>
              </article>
            )
          })}
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute top-0 z-[1] overflow-visible"
              data-testid="task-gantt-connector-overlay"
              height={dependencyLayout.externalLaneHeight + rows.length * GANTT_ROW_HEIGHT}
              style={{ left: `${GANTT_TABLE_WIDTH}px` }}
              width={timelineColumns.length * GANTT_DAY_WIDTH}
            >
              <defs>
                <marker id="gantt-dependency-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
                  <path d="M0 0 L7 3.5 L0 7 Z" fill="#475467" />
                </marker>
                <marker id="gantt-dependency-arrow-critical" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
                  <path d="M0 0 L7 3.5 L0 7 Z" fill="#b54708" />
                </marker>
                <marker id="gantt-dependency-arrow-conflict" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
                  <path d="M0 0 L7 3.5 L0 7 Z" fill="#b42318" />
                </marker>
              </defs>
              {dependencyLayout.connectors.map((connector) => (
                <path
                  d={connector.path}
                  data-critical={connector.critical ? 'true' : 'false'}
                  data-conflict={connector.conflictCount > 0 ? 'true' : 'false'}
                  data-testid={`task-gantt-connector-${connector.dependencyId}`}
                  fill="none"
                  key={connector.dependencyId}
                  markerEnd={`url(#${connector.conflictCount > 0
                    ? 'gantt-dependency-arrow-conflict'
                    : connector.critical
                      ? 'gantt-dependency-arrow-critical'
                      : 'gantt-dependency-arrow'})`}
                  stroke={connector.conflictCount > 0
                    ? '#b42318'
                    : connector.critical
                      ? '#b54708'
                      : '#475467'}
                  strokeDasharray={connector.conflictCount > 0 ? '5 3' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={connector.critical || connector.conflictCount > 0 ? 2.5 : 2}
                />
              ))}
            </svg>
          </div>
        </div>
      ) : (
        <p className="border-t border-[var(--workbench-border)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('tasks.empty')}
        </p>
      )}
      {pendingChange ? (
        <GanttSchedulePreview
          isApplying={isApplying}
          onCancel={() => {
            if (isApplying) return
            pendingChange.controller.cancel()
            if (activeScheduleHandleRef.current?.token === pendingChange.controller.token) {
              activeScheduleHandleRef.current = undefined
            }
            pendingChangeRef.current = undefined
            setPendingChange(undefined)
          }}
          onConfirm={() => void confirmScheduleChange()}
          pending={pendingChange}
          t={t}
        />
      ) : null}
    </section>
  )
}

/** Props for the compact date editor shown in one Gantt table row. */
type GanttDateEditorProps = {
  /** Whether preview controls are disabled. */
  disabled: boolean
  /** Requests a schedule operation preview. */
  onPreview: (operation: WorkItemScheduleOperation) => void
  /** Schedule edited by the controls. */
  schedule: WorkItemSchedule
  /** Translator used by input labels. */
  t: TaskGanttTranslator
  /** Stable task key used to associate labels and inputs. */
  taskKey: string
}

/**
 * Renders mode-specific date inputs without inferring missing schedule dates.
 *
 * @param props - Schedule, disabled state, and preview callback.
 * @returns Compact date controls for one Gantt row.
 */
function GanttDateEditor({ disabled, onPreview, schedule, t, taskKey }: GanttDateEditorProps) {
  if (schedule.mode === 'unscheduled') {
    return (
      <span className="flex items-center gap-2">
        <label className="text-xs font-semibold text-[#667085]" htmlFor={`gantt-create-${taskKey}`}>
          {t('tasks.schedule.createBarDate')}
        </label>
        <input
          className="w-[122px] rounded border border-[#cfd5de] px-2 py-1 text-xs disabled:opacity-60"
          data-testid={`task-gantt-create-${taskKey}`}
          disabled={disabled}
          id={`gantt-create-${taskKey}`}
          onChange={(event) => {
            if (event.currentTarget.value) {
              onPreview(createReplaceTaskScheduleOperation(createModeReplacement(
                schedule,
                'date-range',
                event.currentTarget.value,
              )))
            }
          }}
          type="date"
          value=""
        />
      </span>
    )
  }

  if (schedule.mode === 'date-range') {
    return (
      <span className="flex items-center gap-1">
        <label className="sr-only" htmlFor={`gantt-start-${taskKey}`}>{t('tasks.schedule.startDate')}</label>
        <input
          className="w-[122px] rounded border border-[#cfd5de] px-2 py-1 text-xs disabled:opacity-60"
          disabled={disabled}
          id={`gantt-start-${taskKey}`}
          onChange={(event) => {
            if (event.currentTarget.value) {
              onPreview(createMoveTaskScheduleOperation(event.currentTarget.value))
            }
          }}
          type="date"
          value={schedule.startDate}
        />
        <span aria-hidden="true" className="text-[#98a2b3]">–</span>
        <label className="sr-only" htmlFor={`gantt-end-${taskKey}`}>{t('tasks.schedule.endDate')}</label>
        <input
          className="w-[122px] rounded border border-[#cfd5de] px-2 py-1 text-xs disabled:opacity-60"
          disabled={disabled}
          id={`gantt-end-${taskKey}`}
          onChange={(event) => {
            if (event.currentTarget.value) {
              onPreview(createResizeTaskScheduleOperation(event.currentTarget.value))
            }
          }}
          type="date"
          value={schedule.endDate}
        />
      </span>
    )
  }

  const date = schedule.mode === 'due-date' ? schedule.dueDate : schedule.startDate
  return (
    <span>
      <label className="sr-only" htmlFor={`gantt-date-${taskKey}`}>
        {schedule.mode === 'milestone' ? t('tasks.schedule.milestoneDate') : t('tasks.schedule.dueDate')}
      </label>
      <input
        className="w-[122px] rounded border border-[#cfd5de] px-2 py-1 text-xs disabled:opacity-60"
        disabled={disabled}
        id={`gantt-date-${taskKey}`}
        onChange={(event) => {
          if (event.currentTarget.value) {
            onPreview(createMoveTaskScheduleOperation(event.currentTarget.value))
          }
        }}
        type="date"
        value={date}
      />
    </span>
  )
}

/**
 * Renders the server preview, including direct and ripple impacts, in an accessible dialog.
 *
 * @param props - Pending preview and confirm/cancel actions.
 * @returns A modal schedule preview.
 */
function GanttSchedulePreview({
  isApplying,
  onCancel,
  onConfirm,
  pending,
  t,
}: GanttSchedulePreviewProps) {
  const dialogRef = useModalFocus<HTMLDivElement>(onCancel)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#101828]/45 p-4">
      <div
        aria-labelledby="gantt-schedule-preview-title"
        aria-modal="true"
        className="max-h-[min(680px,90vh)] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-5 shadow-2xl"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="text-lg font-bold text-[#101828]" id="gantt-schedule-preview-title">
          {t('bulk.preview.title')}
        </h2>
        <p className="mt-1 text-sm text-[#667085]">{resolveWorkItemTitle(pending.task)}</p>
        <ul className="mt-4 grid gap-3">
          {pending.controller.preview.impacts.map((impact) => (
            <li className="rounded-lg border border-[#d8dde5] bg-[#f8fafb] p-3" key={`${impact.teamId}:${impact.workItemId}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs font-semibold text-[#344054]">{impact.workItemId}</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#667085]">
                  {t(`tasks.schedule.impact.${impact.kind}`)}
                </span>
              </div>
              <p className="mt-2 text-sm text-[#475467]">
                <span className="sr-only">{t('tasks.schedule.before')}: </span>
                <span className="line-through">{describeSchedule(impact.before, t)}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only">{t('tasks.schedule.after')}: </span>
                <span className="font-semibold text-[#101828]">{describeSchedule(impact.after, t)}</span>
              </p>
            </li>
          ))}
        </ul>
        <TaskSchedulePreviewMetadata preview={pending.controller.preview} t={t} />
        {pending.controller.preview.warnings.length > 0 ? (
          <div className="mt-4 rounded-lg border border-[#f4d38b] bg-[#fffaeb] p-3" role="status">
            <p className="text-xs font-bold uppercase tracking-wide text-[#93370d]">
              {t('tasks.schedule.warnings')}
            </p>
            <ul className="mt-1 list-disc pl-5 text-sm text-[#93370d]">
              {pending.controller.preview.warnings.map((warning) => (
                <li key={warning}>{resolveScheduleWarning(warning, t)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-md border border-[#cfd5de] bg-white px-4 py-2 text-sm font-semibold text-[#344054] disabled:opacity-60"
            disabled={isApplying}
            onClick={onCancel}
            type="button"
          >
            {t('tasks.create.cancel')}
          </button>
          <button
            className="rounded-md bg-[var(--workbench-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            data-modal-initial-focus
            disabled={isApplying || pending.controller.preview.conflicts.length > 0}
            onClick={onConfirm}
            type="button"
          >
            {isApplying ? t('bulk.applying') : t('bulk.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Resolves and schedule-sorts the task rows without mutating the source array.
 *
 * @param tasks - Work Items shown in the Gantt view.
 * @returns Rows ordered by primary schedule date and stable task identity.
 */
function createGanttRows(tasks: readonly ProjectTask[]): GanttTaskRow[] {
  return tasks
    .map((task) => ({ schedule: resolveTaskSchedule(task), task }))
    .toSorted((left, right) => {
      const leftDate = resolveTaskSchedulePrimaryDate(left.schedule) ?? '9999-12-31'
      const rightDate = resolveTaskSchedulePrimaryDate(right.schedule) ?? '9999-12-31'
      return leftDate.localeCompare(rightDate) || createTaskKey(left.task).localeCompare(createTaskKey(right.task))
    })
}

/**
 * Builds a bounded inclusive timeline around every canonical schedule.
 *
 * Long planning horizons aggregate adjacent dates into at most a fixed number of columns. Exact
 * dates remain available through the row editors and through pointer position within a column.
 *
 * @param schedules - Schedules rendered on the Gantt chart.
 * @returns Ordered timeline columns covering the complete observed planning horizon.
 */
function createGanttTimelineColumns(
  schedules: readonly WorkItemSchedule[],
): GanttTimelineColumn[] {
  const today = new Date().toISOString().slice(0, 10)
  const range = createTaskTimelineDateRange(schedules, today)
  const totalDays = differenceGanttCalendarDays(range.startDate, range.endDate) + 1
  const daysPerColumn = Math.max(
    1,
    Math.ceil(totalDays / MAX_GANTT_TIMELINE_COLUMNS),
  )
  const columnCount = Math.ceil(totalDays / daysPerColumn)

  return Array.from({ length: columnCount }, (_, index) => {
    const startOffset = index * daysPerColumn
    const endOffset = Math.min(totalDays - 1, startOffset + daysPerColumn - 1)
    const startDate = addTaskTimelineDays(range.startDate, startOffset)
    const endDate = addTaskTimelineDays(range.startDate, endOffset)
    return {
      endDate,
      label: formatGanttTimelineColumnLabel(startDate, endDate),
      startDate,
    }
  })
}

/**
 * Builds deterministic connector geometry for local bars and one-sided cross-Project edges.
 *
 * @param dependencies - Dependency rows touching at least one local task.
 * @param rows - Local Gantt task rows in their rendered order.
 * @param columns - Current bounded timeline columns.
 * @param projectTaskKeys - Unfiltered task identities that belong to the current Project.
 * @returns Overlay paths, external stubs, and the lane height required above local rows.
 */
function createGanttDependencyLayout(
  dependencies: readonly WorkItemDependencyRow[],
  rows: readonly GanttTaskRow[],
  columns: readonly GanttTimelineColumn[],
  projectTaskKeys: ReadonlySet<string>,
): GanttDependencyLayout {
  const chartWidth = Math.max(GANTT_DAY_WIDTH, columns.length * GANTT_DAY_WIDTH)
  const localRowsByKey = new Map(rows.map((row, rowIndex) => [
    createWorkItemDependencyEndpointKey({ teamId: row.task.teamId, workItemId: row.task.id }),
    { bar: createGanttBar(row.schedule, columns), rowIndex },
  ]))
  const externalDependencies = dependencies.filter((row) => {
    const predecessorKey = createWorkItemDependencyEndpointKey(row.dependency.predecessor)
    const successorKey = createWorkItemDependencyEndpointKey(row.dependency.successor)
    const predecessorIsVisible = localRowsByKey.has(
      predecessorKey,
    )
    const successorIsVisible = localRowsByKey.has(
      successorKey,
    )
    return (predecessorIsVisible && !projectTaskKeys.has(successorKey)) ||
      (successorIsVisible && !projectTaskKeys.has(predecessorKey))
  })
  const externalLaneHeight = externalDependencies.length > 0
    ? externalDependencies.length * GANTT_EXTERNAL_STUB_HEIGHT + 8
    : 0
  const externalIndexByDependencyId = new Map(
    externalDependencies.map((row, index) => [row.dependency.id, index]),
  )
  const externalStubs: GanttExternalEndpointStub[] = []
  const connectors: GanttDependencyConnector[] = []

  for (const row of dependencies) {
    const predecessorKey = createWorkItemDependencyEndpointKey(row.dependency.predecessor)
    const successorKey = createWorkItemDependencyEndpointKey(row.dependency.successor)
    const localPredecessor = localRowsByKey.get(predecessorKey)
    const localSuccessor = localRowsByKey.get(successorKey)
    if (!localPredecessor && !localSuccessor) continue

    const predecessorBar = localPredecessor?.bar ?? (
      row.predecessor ? createGanttBar(row.predecessor.schedule, columns) : undefined
    )
    const successorBar = localSuccessor?.bar ?? (
      row.successor ? createGanttBar(row.successor.schedule, columns) : undefined
    )
    const localFallbackX = localPredecessor
      ? resolveGanttDependencyAnchorX(row.dependency, 'predecessor', predecessorBar, 12)
      : resolveGanttDependencyAnchorX(
          row.dependency,
          'successor',
          successorBar,
          Math.max(12, chartWidth - 12),
        )
    const predecessorX = clampGanttConnectorX(
      resolveGanttDependencyAnchorX(
        row.dependency,
        'predecessor',
        predecessorBar,
        localPredecessor ? 12 : localFallbackX - GANTT_DAY_WIDTH * 2,
      ),
      chartWidth,
    )
    const successorX = clampGanttConnectorX(
      resolveGanttDependencyAnchorX(
        row.dependency,
        'successor',
        successorBar,
        localSuccessor ? chartWidth - 12 : localFallbackX + GANTT_DAY_WIDTH * 2,
      ),
      chartWidth,
    )
    const externalIndex = externalIndexByDependencyId.get(row.dependency.id)
    const externalY = externalIndex === undefined
      ? undefined
      : externalIndex * GANTT_EXTERNAL_STUB_HEIGHT + GANTT_EXTERNAL_STUB_HEIGHT / 2
    const predecessorY = localPredecessor
      ? externalLaneHeight + localPredecessor.rowIndex * GANTT_ROW_HEIGHT + GANTT_BAR_CENTER_OFFSET
      : externalY
    const successorY = localSuccessor
      ? externalLaneHeight + localSuccessor.rowIndex * GANTT_ROW_HEIGHT + GANTT_BAR_CENTER_OFFSET
      : externalY
    if (predecessorY === undefined || successorY === undefined) continue

    if (externalY !== undefined) {
      const externalIsPredecessor = !localPredecessor
      externalStubs.push({
        dependencyId: row.dependency.id,
        label: externalIsPredecessor
          ? row.predecessor?.title ?? row.dependency.predecessor.workItemId
          : row.successor?.title ?? row.dependency.successor.workItemId,
        x: externalIsPredecessor ? predecessorX : successorX,
        y: externalY,
      })
    }

    const middleX = predecessorX + (successorX - predecessorX) / 2
    connectors.push({
      conflictCount: row.conflicts.length,
      critical: row.critical,
      dependencyId: row.dependency.id,
      path: `M ${predecessorX} ${predecessorY} H ${middleX} V ${successorY} H ${successorX}`,
    })
  }

  return { connectors, externalLaneHeight, externalStubs }
}

/** Resolves the schedule boundary used by one dependency endpoint. */
function resolveGanttDependencyAnchorX(
  dependency: WorkItemScheduleDependency,
  endpoint: 'predecessor' | 'successor',
  bar: GanttBar | undefined,
  fallback: number,
): number {
  if (!bar) return fallback
  const useStart = endpoint === 'predecessor'
    ? dependency.type === 'start-to-start' || dependency.type === 'start-to-finish'
    : dependency.type === 'finish-to-start' || dependency.type === 'start-to-start'
  return useStart ? bar.left : bar.left + bar.width
}

/** Keeps one SVG or external-stub anchor inside the visible timeline. */
function clampGanttConnectorX(value: number, chartWidth: number): number {
  return Math.min(Math.max(value, 12), Math.max(12, chartWidth - 12))
}

/** Pixel geometry for a schedule bar on the current date axis. */
type GanttBar = {
  /** Horizontal offset from the first timeline date. */
  left: number
  /** Inclusive schedule width. */
  width: number
}

/**
 * Calculates one schedule bar without creating dates for an unscheduled task.
 *
 * @param schedule - Canonical schedule represented by the bar.
 * @param columns - Ordered bounded timeline columns.
 * @returns Bar geometry, or undefined for an unscheduled or out-of-axis item.
 */
function createGanttBar(
  schedule: WorkItemSchedule,
  columns: readonly GanttTimelineColumn[],
): GanttBar | undefined {
  const startDate = resolveTaskScheduleStartDate(schedule) ?? resolveTaskScheduleEndDate(schedule)
  const endDate = resolveTaskScheduleEndDate(schedule) ?? startDate
  if (!startDate || !endDate) {
    return undefined
  }
  const startIndex = findGanttTimelineColumnIndex(columns, startDate)
  const endIndex = findGanttTimelineColumnIndex(columns, endDate)
  if (startIndex < 0 || endIndex < startIndex) {
    return undefined
  }
  return {
    left: startIndex * GANTT_DAY_WIDTH + 4,
    width: Math.max(GANTT_DAY_WIDTH - 8, (endIndex - startIndex + 1) * GANTT_DAY_WIDTH - 8),
  }
}

/**
 * Resolves a native drop coordinate to an exact date inside its bounded timeline column.
 *
 * @param event - Drop event received by the complete timeline row.
 * @param columns - Ordered bounded timeline columns.
 * @returns The date represented beneath the pointer, when layout information is available.
 */
function resolveGanttDropDate(
  event: DragEvent<HTMLElement>,
  columns: readonly GanttTimelineColumn[],
): string | undefined {
  if (columns.length === 0) {
    return undefined
  }

  const bounds = event.currentTarget.getBoundingClientRect()
  if (bounds.width <= 0) {
    return undefined
  }

  const horizontalOffset = Math.min(
    Math.max(event.clientX - bounds.left, 0),
    bounds.width - Number.EPSILON,
  )
  const renderedColumnWidth = bounds.width / columns.length
  const columnIndex = Math.min(
    columns.length - 1,
    Math.floor(horizontalOffset / renderedColumnWidth),
  )
  const column = columns[columnIndex]
  if (!column) {
    return undefined
  }

  const columnDayCount = differenceGanttCalendarDays(column.startDate, column.endDate) + 1
  const offsetWithinColumn = horizontalOffset - columnIndex * renderedColumnWidth
  const dayOffset = Math.min(
    columnDayCount - 1,
    Math.floor((offsetWithinColumn / renderedColumnWidth) * columnDayCount),
  )
  return addTaskTimelineDays(column.startDate, dayOffset)
}

/**
 * Narrows the serialized HTML drag payload to a supported Gantt operation.
 *
 * @param value - Serialized drag type from `DataTransfer`.
 * @returns Supported move or resize type, or no value for an unrelated drag.
 */
function readGanttDragChangeType(value: string): GanttDragChange['type'] | undefined {
  return value === 'move' || value === 'resize' ? value : undefined
}

/**
 * Finds the bounded timeline column containing one canonical ISO date.
 *
 * @param columns - Ordered inclusive timeline columns.
 * @param date - Canonical date to locate.
 * @returns The containing column index, or -1 when the date is outside the timeline.
 */
function findGanttTimelineColumnIndex(
  columns: readonly GanttTimelineColumn[],
  date: string,
): number {
  return columns.findIndex((column) => column.startDate <= date && date <= column.endDate)
}

/**
 * Calculates a signed UTC calendar-day distance between canonical ISO dates.
 *
 * @param startDate - First ISO calendar date.
 * @param endDate - Second ISO calendar date.
 * @returns Signed whole-day distance from the first date to the second.
 */
function differenceGanttCalendarDays(startDate: string, endDate: string): number {
  const startTime = new Date(`${startDate}T00:00:00.000Z`).getTime()
  const endTime = new Date(`${endDate}T00:00:00.000Z`).getTime()
  return Math.round((endTime - startTime) / MILLISECONDS_PER_CALENDAR_DAY)
}

/**
 * Formats one exact or aggregated timeline column for its compact header.
 *
 * @param startDate - Inclusive first date represented by the column.
 * @param endDate - Inclusive final date represented by the column.
 * @returns A compact date, month, or year label appropriate to the aggregation span.
 */
function formatGanttTimelineColumnLabel(startDate: string, endDate: string): string {
  if (startDate === endDate) {
    return startDate.slice(5)
  }

  const spanDays = differenceGanttCalendarDays(startDate, endDate) + 1
  if (spanDays <= 7) {
    return `${startDate.slice(5)}–${endDate.slice(5)}`
  }
  if (startDate.slice(0, 4) === endDate.slice(0, 4)) {
    return startDate.slice(0, 7)
  }
  return startDate.slice(0, 4)
}

/**
 * Creates a full replacement when the user deliberately changes schedule mode.
 *
 * @param current - Current canonical schedule.
 * @param mode - Explicit target mode.
 * @param fallbackDate - Date used only for target modes that require one.
 * @returns A complete schedule candidate for server preview.
 */
function createModeReplacement(
  current: WorkItemSchedule,
  mode: WorkItemSchedule['mode'],
  fallbackDate: string,
): WorkItemSchedule {
  const plannedEffortMinutes = current.plannedEffortMinutes
  const calendarPolicy = {
    holidays: [...current.calendarPolicy.holidays],
    timeZone: current.calendarPolicy.timeZone,
    workingWeekdays: [...current.calendarPolicy.workingWeekdays],
  }
  const effort = plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }
  if (mode === 'unscheduled') {
    return {
      calendarPolicy,
      mode: 'unscheduled',
      ...effort,
    }
  }
  if (mode === 'due-date') {
    return {
      calendarPolicy,
      dueDate: fallbackDate,
      mode: 'due-date',
      ...effort,
    }
  }
  if (mode === 'milestone') {
    return {
      calendarPolicy,
      durationDays: 0,
      endDate: fallbackDate,
      mode: 'milestone',
      startDate: fallbackDate,
      ...effort,
    }
  }
  return {
    calendarPolicy,
    durationDays: 1,
    endDate: fallbackDate,
    mode: 'date-range',
    startDate: fallbackDate,
    ...effort,
  }
}

/**
 * Narrows a select value to one explicit schedule mode.
 *
 * @param value - Raw select value.
 * @returns The recognized mode or undefined.
 */
function readScheduleMode(value: string): WorkItemSchedule['mode'] | undefined {
  return value === 'unscheduled' || value === 'due-date' || value === 'date-range' || value === 'milestone'
    ? value
    : undefined
}

/**
 * Handles day-by-day keyboard movement for a scheduled bar.
 *
 * @param event - Keyboard event from the focused bar.
 * @param schedule - Schedule being moved.
 * @param onMove - Callback receiving the next primary date.
 */
function handleMoveKey(
  event: KeyboardEvent<HTMLElement>,
  schedule: WorkItemSchedule,
  onMove: (date: string) => void,
) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
    return
  }
  const date = resolveTaskSchedulePrimaryDate(schedule)
  if (!date) {
    return
  }
  const targetDate = tryAddTaskTimelineDays(
    date,
    event.key === 'ArrowLeft' ? -1 : 1,
  )
  if (!targetDate) {
    return
  }
  event.preventDefault()
  onMove(targetDate)
}

/**
 * Handles day-by-day keyboard resizing for a date-range end handle.
 *
 * @param event - Keyboard event from the focused resize handle.
 * @param schedule - Date-range schedule being resized.
 * @param onResize - Callback receiving the next end date.
 */
function handleResizeKey(
  event: KeyboardEvent<HTMLButtonElement>,
  schedule: WorkItemSchedule,
  onResize: (date: string) => void,
) {
  if (
    schedule.mode !== 'date-range' ||
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
  ) {
    return
  }
  const targetDate = tryAddTaskTimelineDays(
    schedule.endDate,
    event.key === 'ArrowLeft' ? -1 : 1,
  )
  if (!targetDate) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  onResize(targetDate)
}

/**
 * Returns distinct visual treatment for ranges, milestones, and deadline-only schedules.
 *
 * @param mode - Explicit schedule mode.
 * @returns Tailwind class list for the bar.
 */
function resolveGanttBarClass(mode: WorkItemSchedule['mode']): string {
  switch (mode) {
    case 'date-range':
      return 'rounded-md border border-[#0e9384] bg-[#ccfbea] text-[#085d55]'
    case 'milestone':
      return 'rotate-45 rounded-sm border border-[#7f56d9] bg-[#ebe9fe] text-[#53389e]'
    case 'due-date':
      return 'rounded-full border-2 border-dashed border-[#dc6803] bg-[#fffaeb] text-[#93370d]'
    case 'unscheduled':
      return 'border border-dashed border-[#98a2b3] bg-white text-[#667085]'
  }
}

/**
 * Chooses concise text rendered inside a Gantt bar.
 *
 * @param schedule - Schedule represented by the bar.
 * @param t - Translator used for the deadline-only label.
 * @returns Explicit mode or duration text.
 */
function resolveGanttBarText(
  schedule: WorkItemSchedule,
  t: TaskGanttTranslator,
): string {
  switch (schedule.mode) {
    case 'date-range':
      return `${schedule.durationDays}d`
    case 'milestone':
      return '◆'
    case 'due-date':
      return t('tasks.schedule.dueDate')
    case 'unscheduled':
      return ''
  }
}

/**
 * Formats an explicit schedule state for assistive text and preview comparisons.
 *
 * @param schedule - Schedule to describe.
 * @param t - Translator used for the unscheduled label.
 * @returns A compact mode-preserving description.
 */
function describeSchedule(schedule: WorkItemSchedule, t: TaskGanttTranslator): string {
  const range = formatTaskScheduleRange(schedule)
  if (!range) {
    return t('tasks.calendar.empty')
  }
  if (schedule.mode === 'date-range') {
    return `${t('tasks.schedule.dateRange')}: ${range} (${schedule.durationDays}d)`
  }
  if (schedule.mode === 'milestone') {
    return `${t('tasks.schedule.milestone')}: ${range}`
  }
  return t('tasks.gantt.window').replace('{date}', range)
}

/**
 * Finds the direct schedule replacement validated for the target Work Item.
 *
 * @param preview - Server preview containing direct and optional dependency impacts.
 * @param task - Target task that initiated the preview.
 * @returns The direct after-schedule or undefined for a malformed preview.
 */
function findDirectPreviewSchedule(
  preview: WorkItemScheduleChangePreview,
  task: ProjectTask,
): WorkItemSchedule | undefined {
  return preview.impacts.find((impact) =>
    impact.kind === 'direct' &&
    impact.teamId === task.teamId &&
    impact.workItemId === task.id
  )?.after
}

/**
 * Preserves permission and revision details exposed by the parent callback.
 *
 * @param error - Unknown callback failure.
 * @param t - Translator used for the generic fallback.
 * @returns A safe message for the view-level alert.
 */
function resolveScheduleActionError(error: unknown, t: TaskGanttTranslator): string {
  if (error instanceof TeamIssuesApiError) {
    if (isSchedulePreviewStaleCode(error.code)) {
      return t('tasks.schedule.previewStale')
    }
    if (error.code === 'WorkItemRevisionConflict') {
      return t('tasks.action.conflict')
    }
    if (error.status === 403) {
      return t('tasks.action.permission')
    }
    if (error.status === 400) {
      return t('tasks.schedule.invalid')
    }
  }
  return t('tasks.action.updateError')
}

/** Returns whether a stable API code means the user must obtain a new preview. */
function isSchedulePreviewStaleCode(code: string | undefined): boolean {
  return code === 'WorkItemSchedulePreviewStale' ||
    code === 'PlanningRevisionConflict' ||
    code === 'WorkItemRelationGraphConflict' ||
    code === 'WorkItemAuthorizationChanged' ||
    code === 'WorkItemScheduleDependencyConflict' ||
    code === 'WorkItemScheduleCascadeConflict'
}

/**
 * Maps stable server warning codes to localized review guidance.
 *
 * @param warning - Warning code returned by schedule preview.
 * @param t - Translator used for known and generic warning text.
 * @returns Localized warning copy without exposing raw server identifiers.
 */
function resolveScheduleWarning(warning: string, t: TaskGanttTranslator): string {
  if (warning === 'DependencyRippleRequiresReview') {
    return t('tasks.schedule.warning.dependencyRipple')
  }
  return warning === 'SemanticBlockRelationsDoNotReschedule'
    ? t('tasks.schedule.warning.semanticBlocks')
    : t('tasks.schedule.warning.generic')
}
