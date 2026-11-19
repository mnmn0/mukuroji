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
  CanonicalWorkItem,
} from '@mukuroji/contracts'
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
  resolveTaskScheduleEndDate,
  resolveTaskSchedulePrimaryDate,
  resolveTaskScheduleStartDate,
  taskScheduleInstantToLocalDate,
  tryAddTaskTimelineDays,
} from '../model/taskSchedule'
import {
  createTaskKey,
  resolveProjectTaskConfiguration,
  type TaskCreateContext,
} from '../model/taskView'
import {
  TaskStatusBadge,
  TaskWorkItemTypeBadge,
  TaskViewHeading,
} from './TaskViewPrimitives'
import { TaskGanttPeriodNavigation } from './TaskScheduleWindowToolbar'
import {
  createTaskGanttWindow,
  getCurrentTaskDate,
  getCurrentTaskMonth,
  listTaskScheduleWindowDates,
  type TaskScheduleWindow,
} from '../model/taskScheduleWindow'
import { TaskSchedulePreviewMetadata } from './TaskSchedulePreviewMetadata'
import {
  createTaskGanttRows,
  type TaskGanttGrouping,
  type TaskGanttOutlineSource,
  type TaskGanttRow,
  type TaskGanttTaskRow,
} from '../model/taskGanttRows'
import { ChevronIcon } from '../../shared/ui/icons'
import { ShowMoreItemsButton } from '../../shared/ui/ShowMoreItemsButton'
import { useIncrementalRender } from '../../shared/ui/useIncrementalRender'
import { formatShowMoreLabel, TASK_TABLE_RENDER_STEP } from '../model/taskListRendering'
import { resolveWorkItemEffortColumnValue } from '../../work-items/model/workItemEffort'
import {
  createTaskGanttScaledColumns,
  isTaskGanttScale,
  resolveTaskGanttColumnWidth,
  resolveTaskGanttDateSpan,
  resolveTaskGanttProgressPointX,
  taskGanttScales,
  type TaskGanttDateRange,
  type TaskGanttScale,
  type TaskGanttTimelineAxis,
  type TaskGanttTimelineColumn as GanttTimelineColumn,
} from '../model/taskGanttTimeline'

const GANTT_TABLE_WIDTH = 360
/** Height of a group heading row. */
const GANTT_GROUP_ROW_HEIGHT = 40
/** Indentation per outline level in the task column. */
const GANTT_OUTLINE_INDENT = 14
/** Deepest indentation, so deep outlines keep room for the title in the fixed task column. */
const GANTT_OUTLINE_MAX_INDENT_LEVELS = 6
const GANTT_EXTERNAL_STUB_HEIGHT = 44
/** Narrowest planned or actual bar, so a short range stays visible on a coarse scale. */
const GANTT_MIN_BAR_WIDTH = 12

/** Vertical geometry of a task row and the bars inside it. */
type GanttRowLayout = {
  /** Height of a task row. */
  rowHeight: number
  /** Vertical offset of a parent's summary bar, above the planned bar. */
  summaryBarTop: number
  /** Vertical offset of the planned bar. */
  barTop: number
  /** Height of the planned bar. */
  barHeight: number
  /** Vertical offset of the actual bar, just below the planned bar. */
  actualBarTop: number
}

/** Row geometry of the standard layout, with the schedule editors under each title. */
const GANTT_STANDARD_ROW_LAYOUT: GanttRowLayout = {
  actualBarTop: 70,
  barHeight: 36,
  barTop: 28,
  rowHeight: 124,
  summaryBarTop: 10,
}

/** Row geometry of the one-line layout, which fits many rows on one screen. */
const GANTT_COMPACT_ROW_LAYOUT: GanttRowLayout = {
  actualBarTop: 36,
  barHeight: 22,
  barTop: 12,
  rowHeight: 48,
  summaryBarTop: 2,
}

/** Paper sizes offered for printing the Gantt chart, always in landscape. */
type GanttPrintPaper = 'a3' | 'a4'

/** Printable width in CSS pixels of each landscape paper size, inside 8mm margins. */
const ganttPrintableWidths: Readonly<Record<GanttPrintPaper, number>> = {
  // (420mm - 16mm) and (297mm - 16mm) at 96 CSS pixels per inch.
  a3: 1_526,
  a4: 1_062,
}
const MAX_GANTT_TIMELINE_COLUMNS = 180
const MILLISECONDS_PER_CALENDAR_DAY = 86_400_000
/**
 * Theme-aware dependency connector colors. The variables are defined for the light and dark
 * themes in `index.css`, so links and their arrow markers keep contrast on either surface.
 */
const ganttLinkColors = {
  conflict: 'var(--workbench-gantt-link-conflict)',
  critical: 'var(--workbench-gantt-link-critical)',
  default: 'var(--workbench-gantt-link)',
}

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
type GanttTaskRow = TaskGanttTaskRow

/** Outline shown by the Gantt chart: hierarchy, collapsed rows, and the collapse toggle. */
export type TaskGanttOutline = TaskGanttOutlineSource & {
  /** Shows or hides the rows nested under a Work Item. */
  onToggleCollapsed: (task: CanonicalWorkItem) => void
}

/** A preview waiting for the user to confirm or cancel it. */
type PendingGanttScheduleChange = {
  /** Task whose schedule operation was previewed. */
  task: CanonicalWorkItem
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
  allProjectTasks?: CanonicalWorkItem[]
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageScheduleDependencyEndpoint?: (endpoint: WorkItemDependencyEndpoint) => boolean
  /** Project receiving contextual Gantt creates. */
  projectId?: string
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team-scoped resolved configurations used by task statuses. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Tasks displayed in schedule order. */
  tasks: CanonicalWorkItem[]
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
  onSelectTask?: (task: CanonicalWorkItem) => void
  /** Starts a canonical Schedule action and returns its exact preview controller. */
  onRequestScheduleChange?: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => ProjectTaskDirectScheduleHandle
  /** Updates a canonical Work Item schedule dependency rule. */
  onUpdateScheduleDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
  /**
   * First month of the visible period, in `YYYY-MM` form.
   *
   * When set, the timeline spans exactly that period and bars outside it are clipped. Without
   * it, the timeline spans every loaded schedule.
   */
  windowStartMonth?: string
  /** Moves the period to start at another month. Shown as navigation with `windowStartMonth`. */
  onWindowStartMonthChange?: (month: string) => void
  /**
   * Hierarchy shown as an outline: rows follow the WBS order with WBS numbers, parents get a
   * summary bar over their descendants' dates, and parents can be collapsed.
   */
  outline?: TaskGanttOutline
  /** Groups the rows, such as by Project, under heading rows. */
  group?: TaskGanttGrouping
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
  group,
  onCreateTaskOpen,
  onCreateScheduleDependency,
  onDeleteScheduleDependency,
  onRequestScheduleChange,
  onSelectTask,
  onUpdateScheduleDependency,
  onWindowStartMonthChange,
  outline,
  planningSnapshot,
  projectId,
  t,
  tasks,
  windowStartMonth,
}: TaskGanttViewProps) {
  const timelineWindow = useMemo(
    () => windowStartMonth ? createTaskGanttWindow(windowStartMonth) : undefined,
    [windowStartMonth],
  )
  const projectTasks = useMemo(() => {
    const loadedTasks = allProjectTasks ?? tasks
    if (!timelineWindow || !projectId || !planningSnapshot) return loadedTasks
    // A windowed list holds only the period's Work Items, so the Project's other Work Items
    // come from the Planning snapshot. Their endpoints then stay local instead of external.
    const loadedKeys = new Set(loadedTasks.map((task) =>
      createWorkItemDependencyEndpointKey({ teamId: task.teamId, workItemId: task.id })
    ))
    return [
      ...loadedTasks,
      ...planningSnapshot.workItems
        .filter((item) =>
          item.projectId === projectId &&
          !loadedKeys.has(createWorkItemDependencyEndpointKey({
            teamId: item.teamId,
            workItemId: item.id,
          }))
        )
        .map((item) => ({ id: item.id, teamId: item.teamId })),
    ]
  }, [allProjectTasks, planningSnapshot, projectId, tasks, timelineWindow])
  const outlineHierarchies = outline?.hierarchies
  const outlineCollapsedKeys = outline?.collapsedKeys
  const displayRows = useMemo(() => createTaskGanttRows(tasks, {
    ...(outlineHierarchies && outlineCollapsedKeys
      ? { outline: { hierarchies: outlineHierarchies, collapsedKeys: outlineCollapsedKeys } }
      : {}),
    ...(group ? { group } : {}),
  }), [group, outlineCollapsedKeys, outlineHierarchies, tasks])
  const rows = useMemo(
    () => displayRows.filter((row): row is GanttTaskRow => row.kind === 'task'),
    [displayRows],
  )
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
  const [scale, setScale] = useState<TaskGanttScale>('auto')
  const [isCompact, setIsCompact] = useState(false)
  const [showsProgressLine, setShowsProgressLine] = useState(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  /** Whether a move to today waits for the period containing today to render. */
  const todayScrollPendingRef = useRef(false)
  const printRootRef = useRef<HTMLElement>(null)
  const rowLayout = isCompact ? GANTT_COMPACT_ROW_LAYOUT : GANTT_STANDARD_ROW_LAYOUT
  const barCenterOffset = rowLayout.barTop + rowLayout.barHeight / 2
  const timelineRange = useMemo(
    () => timelineWindow
      ? { endDate: timelineWindow.to, startDate: timelineWindow.from }
      : createGanttTimelineRange(
          [
            ...rows.map((row) => row.schedule),
            ...dependencyRows.flatMap((row) => [
              ...(row.predecessor ? [row.predecessor.schedule] : []),
              ...(row.successor ? [row.successor.schedule] : []),
            ]),
          ],
          // Actual work and summary bars outside the planned horizon still widen the timeline.
          rows.flatMap((row) => {
            const range = resolveGanttActualDateRange(row.task, row.schedule)
            const rollup = row.outline?.node?.rollup
            return [
              ...(range ? [range.startDate, range.endDate] : []),
              ...(rollup?.startDate && rollup.endDate ? [rollup.startDate, rollup.endDate] : []),
            ]
          }),
        ),
    [dependencyRows, rows, timelineWindow],
  )
  const scaledTimeline = useMemo(
    () => scale === 'auto' ? undefined : createTaskGanttScaledColumns(timelineRange, scale),
    [scale, timelineRange],
  )
  const timelineColumns = useMemo(
    () => scaledTimeline?.columns ?? (timelineWindow
      ? createGanttWindowColumns(timelineWindow)
      : createGanttAutoColumns(timelineRange)),
    [scaledTimeline, timelineRange, timelineWindow],
  )
  const columnWidth = resolveTaskGanttColumnWidth(scaledTimeline?.scale ?? 'auto')
  const timelineAxis = useMemo<TaskGanttTimelineAxis>(
    () => ({ columnWidth, columns: timelineColumns }),
    [columnWidth, timelineColumns],
  )
  const timelineWidth = timelineColumns.length * columnWidth
  const today = getCurrentTaskDate()
  const todaySpan = resolveTaskGanttDateSpan(timelineAxis, today)
  const todayX = todaySpan ? (todaySpan.left + todaySpan.right) / 2 : undefined
  // Thousands of rows are rendered in steps; connectors are laid out for rendered rows only.
  const {
    renderedItems: renderedRows,
    hiddenCount: hiddenRowCount,
    showMore: showMoreRows,
  } = useIncrementalRender(displayRows, TASK_TABLE_RENDER_STEP)
  const renderedRowTops = useMemo(
    () => createGanttRowTops(renderedRows, rowLayout.rowHeight),
    [renderedRows, rowLayout.rowHeight],
  )
  const renderedRowsHeight = renderedRowTops.at(-1) ?? 0
  const dependencyLayout = useMemo(
    () => createGanttDependencyLayout(
      dependencyRows,
      renderedRows,
      renderedRowTops,
      timelineAxis,
      projectTaskKeys,
      barCenterOffset,
    ),
    [barCenterOffset, dependencyRows, projectTaskKeys, renderedRowTops, renderedRows, timelineAxis],
  )
  const progressLinePoints = useMemo(
    () => showsProgressLine && todayX !== undefined
      ? createGanttProgressLinePoints({
          barCenterOffset,
          configuration,
          configurationsByTeam,
          rowHeight: rowLayout.rowHeight,
          rowTops: renderedRowTops,
          rows: renderedRows,
          axis: timelineAxis,
          today,
          todayX,
          topOffset: dependencyLayout.externalLaneHeight,
        })
      : undefined,
    [
      barCenterOffset,
      configuration,
      configurationsByTeam,
      dependencyLayout.externalLaneHeight,
      renderedRowTops,
      renderedRows,
      rowLayout.rowHeight,
      showsProgressLine,
      timelineAxis,
      today,
      todayX,
    ],
  )

  /** Moves to today, first switching a windowed chart to the period containing today. */
  const moveToToday = () => {
    if (todayX !== undefined) {
      scrollGanttToX(scrollContainerRef.current, todayX)
      return
    }
    if (onWindowStartMonthChange) {
      todayScrollPendingRef.current = true
      onWindowStartMonthChange(getCurrentTaskMonth())
    }
  }

  useEffect(() => {
    if (!todayScrollPendingRef.current || todayX === undefined) return
    todayScrollPendingRef.current = false
    scrollGanttToX(scrollContainerRef.current, todayX)
  }, [todayX])

  /**
   * Prints only the Gantt chart on landscape paper, scaled down to the paper width.
   *
   * @param paper - Paper size to print on.
   */
  const printChart = (paper: GanttPrintPaper) => {
    const root = printRootRef.current
    if (!root) return
    const contentWidth = Math.max(
      root.scrollWidth,
      scrollContainerRef.current?.scrollWidth ?? 0,
    )
    const zoom = contentWidth > 0 ? Math.min(1, ganttPrintableWidths[paper] / contentWidth) : 1
    const documentElement = document.documentElement
    /** Restores the screen layout after the print dialog closes. */
    const restore = () => {
      delete documentElement.dataset.printTarget
      delete root.dataset.printPaper
      root.style.removeProperty('zoom')
    }
    documentElement.dataset.printTarget = 'task-gantt'
    root.dataset.printPaper = paper
    root.style.setProperty('zoom', String(zoom))
    window.addEventListener('afterprint', restore, { once: true })
    window.print()
  }
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
    task: CanonicalWorkItem,
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
      data-print-root="task-gantt"
      ref={printRootRef}
    >
      <TaskViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey="tasks.view.gantt"
      />
      {windowStartMonth && onWindowStartMonthChange ? (
        <div data-print-hidden="">
          <TaskGanttPeriodNavigation
            onStartMonthChange={onWindowStartMonthChange}
            startMonth={windowStartMonth}
            t={t}
          />
        </div>
      ) : null}
      <GanttDisplayToolbar
        canMoveToToday={todayX !== undefined || onWindowStartMonthChange !== undefined}
        effectiveScale={scaledTimeline?.scale}
        isCompact={isCompact}
        onCompactChange={setIsCompact}
        onMoveToToday={moveToToday}
        onPrint={printChart}
        onProgressLineChange={setShowsProgressLine}
        onScaleChange={setScale}
        scale={scale}
        showsProgressLine={showsProgressLine}
        t={t}
      />
      {dependencyRows.length > 0 ? (
        <ul
          aria-label={t('workItems.dependencies.title')}
          className="grid gap-1 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3"
          data-print-hidden=""
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
                className={`flex flex-wrap items-center gap-2 rounded-md border bg-surface px-3 py-2 text-xs font-semibold ${row.conflicts.length > 0
                  ? 'border-red-300 text-fg-red-700'
                  : row.critical
                    ? 'border-amber-300 text-fg-amber-800'
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
        <details className="border-b border-[var(--workbench-border)] bg-surface px-4 py-3" data-print-hidden="">
          <summary className="cursor-pointer text-sm font-semibold text-[var(--workbench-primary-text)]">
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
        <div className="flex justify-end border-b border-tone-e4e7ec px-4 py-2" data-print-hidden="">
          <button
            className="text-sm font-semibold text-[var(--workbench-primary-text)] hover:underline"
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
        <p className="border-b border-tone-fecaca bg-tone-fef2f2 px-4 py-2 text-sm font-medium text-fg-b42318" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div
          className="overflow-x-auto"
          data-print-overflow=""
          data-testid="task-gantt-scroll"
          ref={scrollContainerRef}
          role="grid"
        >
          <div
            className="grid min-w-max border-b border-tone-d8dde5 bg-tone-f8fafb"
            role="row"
            style={{ gridTemplateColumns: `${GANTT_TABLE_WIDTH}px ${timelineWidth}px` }}
          >
            <div className="sticky left-0 z-20 border-r border-tone-d8dde5 bg-tone-f8fafb px-4 py-2 text-xs font-bold uppercase tracking-wide text-fg-667085" role="columnheader">
              {t('tasks.gantt.owner')}
            </div>
            <div
              className="grid"
              style={{ gridTemplateColumns: `repeat(${timelineColumns.length}, ${columnWidth}px)` }}
            >
              {timelineColumns.map((column) => {
                const isTodayColumn = column.startDate <= today && today <= column.endDate
                return (
                  <div
                    aria-current={isTodayColumn ? 'date' : undefined}
                    aria-label={column.startDate === column.endDate
                      ? column.startDate
                      : `${column.startDate} – ${column.endDate}`}
                    className={`border-r border-tone-e4e7ec px-1 py-2 text-center text-[10px] font-semibold ${isTodayColumn
                      ? 'bg-[var(--workbench-danger-surface)] text-[var(--workbench-danger)]'
                      : 'text-fg-667085'}`}
                    data-testid={isTodayColumn ? 'task-gantt-today-column' : undefined}
                    key={column.startDate}
                    role="columnheader"
                    title={column.startDate === column.endDate
                      ? column.startDate
                      : `${column.startDate} – ${column.endDate}`}
                  >
                    {column.label}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="relative min-w-max">
            {dependencyLayout.externalLaneHeight > 0 ? (
              <div
                className="grid min-w-max border-b border-tone-d8dde5 bg-tone-f8fafb"
                data-testid="task-gantt-external-lane"
                style={{
                  gridTemplateColumns: `${GANTT_TABLE_WIDTH}px ${timelineWidth}px`,
                  height: `${dependencyLayout.externalLaneHeight}px`,
                }}
              >
                <div className="sticky left-0 z-10 border-r border-tone-d8dde5 bg-tone-f8fafb px-4 py-3 text-xs font-bold uppercase tracking-wide text-fg-667085">
                  {t('workItems.dependencies.externalLane')}
                </div>
                <div className="relative bg-surface">
                  {dependencyLayout.externalStubs.map((stub) => (
                    <div
                      className="absolute z-[2] max-w-[220px] -translate-x-1/2 truncate rounded-full border border-tone-98a2b3 bg-surface px-2 py-1 text-[11px] font-bold text-fg-344054 shadow-sm"
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
          {renderedRows.map((row) => {
            if (row.kind === 'group') {
              return (
                <div
                  className="grid min-w-max border-b border-tone-d8dde5 bg-tone-f8fafb"
                  data-testid={`task-gantt-group-${row.key}`}
                  key={`group:${row.key}`}
                  role="row"
                  style={{
                    gridTemplateColumns: `${GANTT_TABLE_WIDTH}px ${timelineWidth}px`,
                    height: `${GANTT_GROUP_ROW_HEIGHT}px`,
                  }}
                >
                  <div
                    className="sticky left-0 z-10 flex items-center gap-2 border-r border-tone-d8dde5 bg-tone-f8fafb px-4 text-sm font-bold text-[var(--workbench-text)]"
                    role="rowheader"
                  >
                    <span className="truncate">{row.label}</span>
                    <span className="font-medium text-[var(--workbench-muted)]">({row.count})</span>
                  </div>
                  <div aria-hidden="true" role="gridcell" />
                </div>
              )
            }
            const taskKey = createTaskKey(row.task)
            const outlinePlacement = row.outline
            const outlineIndent = outlinePlacement
              ? Math.min(outlinePlacement.depth, GANTT_OUTLINE_MAX_INDENT_LEVELS) * GANTT_OUTLINE_INDENT
              : 0
            const summaryRollup = outlinePlacement?.node?.rollup
            const summaryBar = summaryRollup?.startDate && summaryRollup.endDate
              ? createGanttDateRangeBar(summaryRollup.startDate, summaryRollup.endDate, timelineAxis)
              : undefined
            const summaryBarLabel = summaryRollup?.startDate && summaryRollup.endDate
              ? t('tasks.gantt.summaryBar')
                  .replace('{start}', summaryRollup.startDate)
                  .replace('{end}', summaryRollup.endDate)
              : undefined
            const taskTitle = resolveWorkItemTitle(row.task)
            const isBusy = busyTaskKey === taskKey
            const bar = createGanttBar(row.schedule, timelineAxis)
            const actualBar = createGanttActualBar(row.task, row.schedule, timelineAxis)
            const actualBarLabel = row.task.actualStartDate
              ? t('tasks.gantt.actualBar')
                  .replace('{start}', row.task.actualStartDate)
                  .replace('{end}', row.task.actualEndDate ?? t('tasks.gantt.actualInProgress'))
              : undefined
            const progressPercent = resolveWorkItemEffortColumnValue(
              row.task,
              'progress',
              resolveProjectTaskConfiguration(row.task, configurationsByTeam, configuration),
            )
            return (
              <article
                className="grid min-w-max border-b border-tone-e4e7ec last:border-b-0"
                key={taskKey}
                role="row"
                style={{
                  gridTemplateColumns: `${GANTT_TABLE_WIDTH}px ${timelineWidth}px`,
                  height: `${rowLayout.rowHeight}px`,
                }}
              >
                <div
                  className={`sticky left-0 z-10 min-h-0 border-r border-tone-d8dde5 bg-surface px-4 ${isCompact
                    ? 'flex items-center overflow-hidden'
                    : 'grid gap-2 overflow-y-auto py-3'}`}
                  role="gridcell"
                  style={outlinePlacement ? { paddingInlineStart: `${16 + outlineIndent}px` } : undefined}
                >
                  <div className={`flex min-w-0 justify-between gap-3 ${isCompact ? 'flex-1 items-center' : 'items-start'}`}>
                    {outlinePlacement ? (
                      outlinePlacement.hasChildren ? (
                        <button
                          aria-expanded={!outlinePlacement.collapsed}
                          aria-label={`${t(outlinePlacement.collapsed ? 'issues.outline.expand' : 'issues.outline.collapse')}: ${taskTitle}`}
                          className="-my-1 grid h-7 w-6 flex-none place-items-center rounded text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--workbench-primary)]"
                          data-testid={`task-gantt-outline-toggle-${row.task.id}`}
                          onClick={() => outline?.onToggleCollapsed(row.task)}
                          type="button"
                        >
                          <ChevronIcon className={`h-4 w-4 fill-none stroke-current stroke-2 transition-transform ${outlinePlacement.collapsed ? '-rotate-90' : ''}`} />
                        </button>
                      ) : <span aria-hidden="true" className="w-6 flex-none" />
                    ) : null}
                    <div className={`min-w-0 flex-1 ${isCompact ? 'flex items-baseline gap-2' : ''}`}>
                      {outlinePlacement ? (
                        <span className="sr-only">
                          {`${t('issues.outline.level').replace('{level}', String(outlinePlacement.depth + 1))} `}
                        </span>
                      ) : null}
                      {outlinePlacement?.node ? (
                        <p
                          className="font-mono text-xs font-semibold tabular-nums text-[var(--workbench-muted)]"
                          data-testid={`task-gantt-wbs-${row.task.id}`}
                        >
                          <span className="sr-only">{`${t('issues.outline.wbs')} `}</span>
                          {outlinePlacement.node.wbsNumber}
                        </p>
                      ) : null}
                      {onSelectTask ? (
                        <button
                          className="block max-w-full truncate text-left text-sm font-semibold text-fg-1c1d1f hover:text-[var(--workbench-primary-text)]"
                          data-task-action="open"
                          data-task-team-id={row.task.teamId}
                          data-task-work-item-id={row.task.id}
                          onClick={() => onSelectTask(row.task)}
                          type="button"
                        >
                          {resolveWorkItemTitle(row.task)}
                        </button>
                      ) : (
                        <p className="truncate text-sm font-semibold text-fg-1c1d1f">{resolveWorkItemTitle(row.task)}</p>
                      )}
                      {isCompact ? null : (
                        <>
                          <p className="mt-1 truncate text-xs font-medium text-fg-5f6874">
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
                        </>
                      )}
                    </div>
                    <span className="flex items-center gap-2">
                      {onCreateTaskOpen && !isCompact ? (
                        <button
                          aria-label={`${t('tasks.gantt.add')}: ${resolveWorkItemTitle(row.task)}`}
                          className="rounded px-2 py-1 text-lg font-semibold text-[var(--workbench-primary-text)] hover:bg-tone-e5f7f4"
                          data-testid={`task-gantt-add-${row.task.id}`}
                          onClick={() => onCreateTaskOpen({
                            ...(row.task.assigneeUserId ? { assigneeUserId: row.task.assigneeUserId } : {}),
                            projectId: projectId ?? row.task.assignedProjectId ?? '',
                            schedule: row.schedule,
                            source: 'gantt',
                            teamId: row.task.teamId,
                            workItemTypeId: row.task.workItemTypeId ?? 'default',
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
                      {isCompact ? null : (
                        <TaskWorkItemTypeBadge
                          configuration={resolveProjectTaskConfiguration(
                            row.task,
                            configurationsByTeam,
                            configuration,
                          )}
                          task={row.task}
                        />
                      )}
                    </span>
                  </div>
                  {isCompact ? null : (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor={`gantt-mode-${taskKey}`}>{t('tasks.schedule.mode')}</label>
                      <select
                        className="rounded border border-tone-cfd5de bg-surface px-2 py-1 text-xs font-semibold text-fg-344054 disabled:cursor-not-allowed disabled:opacity-60"
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
                      {isBusy ? <span className="text-xs text-fg-667085" role="status">{t('bulk.previewing')}</span> : null}
                    </div>
                  )}
                </div>
                <div
                  aria-label={`${resolveWorkItemTitle(row.task)}: ${describeSchedule(row.schedule, t)}`}
                  className="relative min-h-0 bg-surface"
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
                    backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${columnWidth - 1}px, var(--workbench-gantt-grid) ${columnWidth - 1}px, var(--workbench-gantt-grid) ${columnWidth}px)`,
                  }}
                >
                  {summaryBar && summaryBarLabel ? (
                    // The summary bar spans the descendants' earliest start to latest end, above
                    // the parent's own planned bar.
                    <div
                      aria-label={summaryBarLabel}
                      className="absolute z-[2] h-2 rounded-sm bg-[var(--workbench-gantt-link)]"
                      data-testid={`task-gantt-summary-${row.task.id}`}
                      role="img"
                      style={{
                        left: `${summaryBar.left}px`,
                        top: `${rowLayout.summaryBarTop}px`,
                        width: `${summaryBar.width}px`,
                      }}
                      title={summaryBarLabel}
                    />
                  ) : null}
                  {bar ? (
                    <div
                      className={`absolute z-[2] overflow-visible text-xs font-bold shadow-sm ${resolveGanttBarClass(row.schedule.mode)}`}
                      style={{
                        height: `${rowLayout.barHeight}px`,
                        left: `${bar.left}px`,
                        top: `${rowLayout.barTop}px`,
                        width: `${bar.width}px`,
                      }}
                    >
                      {progressPercent !== undefined && progressPercent > 0 ? (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-y-0 left-0 bg-black/15"
                          data-testid={`task-gantt-progress-${row.task.id}`}
                          style={{ width: `${progressPercent}%` }}
                        />
                      ) : null}
                      <button
                        aria-label={`${canEditSchedule && !isBusy
                          ? t('tasks.schedule.moveA11y').replace(
                              '{task}',
                              resolveWorkItemTitle(row.task),
                            )
                          : `${resolveWorkItemTitle(row.task)}: ${describeSchedule(row.schedule, t)}`}${
                          progressPercent === undefined
                            ? ''
                            : `, ${t('workItems.effort.progress')} ${progressPercent}%`
                        }`}
                        className="flex h-full w-full items-center px-2 text-left focus:outline-none focus:ring-2 focus:ring-[var(--workbench-primary)]"
                        data-task-action="open"
                        data-task-open-variant="bar"
                        data-task-team-id={row.task.teamId}
                        data-task-work-item-id={row.task.id}
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
                        <span className="pointer-events-none truncate">
                          {resolveGanttBarText(row.schedule, t)}
                          {progressPercent === undefined ? '' : ` · ${progressPercent}%`}
                        </span>
                      </button>
                      {row.schedule.mode === 'date-range' ? (
                        <button
                          aria-label={t('tasks.schedule.resizeA11y').replace(
                            '{task}',
                            resolveWorkItemTitle(row.task),
                          )}
                          className="absolute -right-1 top-0 h-full w-3 cursor-ew-resize rounded bg-tone-087c70 focus:outline-none focus:ring-2 focus:ring-white"
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
                    <span
                      className="absolute left-3 z-[1] rounded border border-dashed border-tone-98a2b3 bg-surface px-2 py-0.5 text-xs font-semibold text-fg-667085"
                      style={{ top: `${rowLayout.barTop + 2}px` }}
                    >
                      {/* A scheduled row without a bar lies outside the visible period. */}
                      {row.schedule.mode === 'unscheduled'
                        ? t('tasks.calendar.empty')
                        : t('tasks.gantt.outsideWindow')}
                    </span>
                  )}
                  {actualBar && actualBarLabel ? (
                    // The actual bar sits below the planned bar so the plan and the result line up.
                    <div
                      aria-label={actualBarLabel}
                      className={`absolute z-[2] h-2.5 rounded-sm ${
                        row.task.actualEndDate
                          ? 'bg-tone-087c70'
                          : 'border border-dashed border-tone-087c70 bg-tone-ccfbea'
                      }`}
                      data-testid={`task-gantt-actual-bar-${row.task.id}`}
                      role="img"
                      style={{
                        left: `${actualBar.left}px`,
                        top: `${rowLayout.actualBarTop}px`,
                        width: `${actualBar.width}px`,
                      }}
                      title={actualBarLabel}
                    />
                  ) : null}
                </div>
              </article>
            )
          })}
            {hiddenRowCount > 0 ? (
              <div className="sticky left-0 p-3" style={{ width: `${GANTT_TABLE_WIDTH}px` }}>
                <ShowMoreItemsButton
                  label={formatShowMoreLabel(t, TASK_TABLE_RENDER_STEP, hiddenRowCount)}
                  onShowMore={showMoreRows}
                  testId="task-gantt-show-more"
                />
              </div>
            ) : null}
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute top-0 z-[1] overflow-visible"
              data-testid="task-gantt-connector-overlay"
              height={dependencyLayout.externalLaneHeight + renderedRowsHeight}
              style={{ left: `${GANTT_TABLE_WIDTH}px` }}
              width={timelineWidth}
            >
              <defs>
                <marker id="gantt-dependency-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
                  <path d="M0 0 L7 3.5 L0 7 Z" style={{ fill: ganttLinkColors.default }} />
                </marker>
                <marker id="gantt-dependency-arrow-critical" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
                  <path d="M0 0 L7 3.5 L0 7 Z" style={{ fill: ganttLinkColors.critical }} />
                </marker>
                <marker id="gantt-dependency-arrow-conflict" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
                  <path d="M0 0 L7 3.5 L0 7 Z" style={{ fill: ganttLinkColors.conflict }} />
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
                  strokeDasharray={connector.conflictCount > 0 ? '5 3' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={connector.critical || connector.conflictCount > 0 ? 2.5 : 2}
                  style={{
                    stroke: connector.conflictCount > 0
                      ? ganttLinkColors.conflict
                      : connector.critical
                        ? ganttLinkColors.critical
                        : ganttLinkColors.default,
                  }}
                />
              ))}
            </svg>
            {todayX !== undefined ? (
              // Today's line runs over every rendered row, above the bars and below the task column.
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-0 z-[3] w-0.5 -translate-x-1/2 bg-[var(--workbench-danger)]"
                data-testid="task-gantt-today-line"
                style={{
                  height: `${dependencyLayout.externalLaneHeight + renderedRowsHeight}px`,
                  left: `${GANTT_TABLE_WIDTH + todayX}px`,
                }}
              />
            ) : null}
            {progressLinePoints ? (
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute top-0 z-[3] overflow-visible"
                data-testid="task-gantt-progress-line"
                height={dependencyLayout.externalLaneHeight + renderedRowsHeight}
                style={{ left: `${GANTT_TABLE_WIDTH}px` }}
                width={timelineWidth}
              >
                <polyline
                  fill="none"
                  points={progressLinePoints.map((point) => `${point.x},${point.y}`).join(' ')}
                  strokeLinejoin="round"
                  strokeWidth={2}
                  style={{ stroke: 'var(--workbench-danger)' }}
                />
              </svg>
            ) : null}
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
        <label className="text-xs font-semibold text-fg-667085" htmlFor={`gantt-create-${taskKey}`}>
          {t('tasks.schedule.createBarDate')}
        </label>
        <input
          className="w-[122px] rounded border border-tone-cfd5de px-2 py-1 text-xs disabled:opacity-60"
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
          className="w-[122px] rounded border border-tone-cfd5de px-2 py-1 text-xs disabled:opacity-60"
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
        <span aria-hidden="true" className="text-fg-98a2b3">–</span>
        <label className="sr-only" htmlFor={`gantt-end-${taskKey}`}>{t('tasks.schedule.endDate')}</label>
        <input
          className="w-[122px] rounded border border-tone-cfd5de px-2 py-1 text-xs disabled:opacity-60"
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
        className="w-[122px] rounded border border-tone-cfd5de px-2 py-1 text-xs disabled:opacity-60"
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-tone-101828/45 p-4">
      <div
        aria-labelledby="gantt-schedule-preview-title"
        aria-modal="true"
        className="max-h-[min(680px,90vh)] w-full max-w-xl overflow-y-auto rounded-xl bg-surface p-5 shadow-2xl"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="text-lg font-bold text-fg-101828" id="gantt-schedule-preview-title">
          {t('bulk.preview.title')}
        </h2>
        <p className="mt-1 text-sm text-fg-667085">{resolveWorkItemTitle(pending.task)}</p>
        <ul className="mt-4 grid gap-3">
          {pending.controller.preview.impacts.map((impact) => (
            <li className="rounded-lg border border-tone-d8dde5 bg-tone-f8fafb p-3" key={`${impact.teamId}:${impact.workItemId}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs font-semibold text-fg-344054">{impact.workItemId}</span>
                <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-fg-667085">
                  {t(`tasks.schedule.impact.${impact.kind}`)}
                </span>
              </div>
              <p className="mt-2 text-sm text-fg-475467">
                <span className="sr-only">{t('tasks.schedule.before')}: </span>
                <span className="line-through">{describeSchedule(impact.before, t)}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only">{t('tasks.schedule.after')}: </span>
                <span className="font-semibold text-fg-101828">{describeSchedule(impact.after, t)}</span>
              </p>
            </li>
          ))}
        </ul>
        <TaskSchedulePreviewMetadata preview={pending.controller.preview} t={t} />
        {pending.controller.preview.warnings.length > 0 ? (
          <div className="mt-4 rounded-lg border border-tone-f4d38b bg-tone-fffaeb p-3" role="status">
            <p className="text-xs font-bold uppercase tracking-wide text-fg-93370d">
              {t('tasks.schedule.warnings')}
            </p>
            <ul className="mt-1 list-disc pl-5 text-sm text-fg-93370d">
              {pending.controller.preview.warnings.map((warning) => (
                <li key={warning}>{resolveScheduleWarning(warning, t)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-md border border-tone-cfd5de bg-surface px-4 py-2 text-sm font-semibold text-fg-344054 disabled:opacity-60"
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
 * Calculates where each rendered row starts, below any external lane.
 *
 * @param rows - Rendered rows in display order.
 * @param rowHeight - Height of a task row in the current layout.
 * @returns The top offset of each row, followed by the total height of all rows.
 */
function createGanttRowTops(rows: readonly TaskGanttRow[], rowHeight: number): number[] {
  const tops = [0]
  for (const row of rows) {
    tops.push((tops.at(-1) ?? 0) + (row.kind === 'group' ? GANTT_GROUP_ROW_HEIGHT : rowHeight))
  }
  return tops
}

/** One vertex of the progress line, in timeline coordinates. */
type GanttProgressLinePoint = {
  /** Horizontal offset from the first timeline date. */
  x: number
  /** Vertical offset from the top of the rows area. */
  y: number
}

/** Inputs for laying out the progress line over the rendered rows. */
type GanttProgressLineInput = {
  /** Timeline columns and their width. */
  axis: TaskGanttTimelineAxis
  /** Vertical center of a planned bar inside its row. */
  barCenterOffset: number
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team-scoped resolved configurations that define progress. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Height of a task row. */
  rowHeight: number
  /** Top offset of each rendered row. */
  rowTops: readonly number[]
  /** Rendered rows in display order, including group headings. */
  rows: readonly TaskGanttRow[]
  /** Today's date. */
  today: string
  /** Horizontal center of today. */
  todayX: number
  /** Height of the external lane above the rows. */
  topOffset: number
}

/**
 * Lays out the progress line (イナズマ線): it runs down today's line and, in each task row,
 * bends to the row's progress point, so a bend to the left marks a row that is behind.
 *
 * @param input - Rendered rows, their geometry, and today's position.
 * @returns Polyline vertices from the top of the first row to the bottom of the last row.
 */
function createGanttProgressLinePoints(input: GanttProgressLineInput): GanttProgressLinePoint[] {
  const { axis, barCenterOffset, rowHeight, rows, rowTops, today, todayX, topOffset } = input
  const points: GanttProgressLinePoint[] = [{ x: todayX, y: topOffset }]
  rows.forEach((row, index) => {
    if (row.kind !== 'task') return
    const top = topOffset + (rowTops[index] ?? 0)
    const progressPercent = resolveWorkItemEffortColumnValue(
      row.task,
      'progress',
      resolveProjectTaskConfiguration(row.task, input.configurationsByTeam, input.configuration),
    )
    const startDate = resolveTaskScheduleStartDate(row.schedule) ?? resolveTaskScheduleEndDate(row.schedule)
    const endDate = resolveTaskScheduleEndDate(row.schedule) ?? startDate
    const x = resolveTaskGanttProgressPointX({
      axis,
      today,
      todayX,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(progressPercent === undefined ? {} : { progressPercent }),
    })
    points.push({ x: todayX, y: top }, { x, y: top + barCenterOffset }, { x: todayX, y: top + rowHeight })
  })
  points.push({ x: todayX, y: topOffset + (rowTops.at(-1) ?? 0) })
  return points
}

/**
 * Scrolls the chart so a timeline position sits in the middle of the visible timeline.
 *
 * @param container - Horizontally scrolling chart, when it is rendered.
 * @param x - Horizontal offset from the first timeline date.
 */
function scrollGanttToX(container: HTMLElement | null, x: number): void {
  if (!container) return
  container.scrollLeft = Math.max(0, x - (container.clientWidth - GANTT_TABLE_WIDTH) / 2)
}

/** Props for the Gantt display settings toolbar. */
type GanttDisplayToolbarProps = {
  /** Whether today's line can be shown, now or after moving the period. */
  canMoveToToday: boolean
  /** Scale actually rendered when a long range made the requested scale coarser. */
  effectiveScale?: TaskGanttScale
  /** Whether rows use the one-line layout. */
  isCompact: boolean
  /** Turns the one-line layout on or off. */
  onCompactChange: (isCompact: boolean) => void
  /** Brings today's line into view. */
  onMoveToToday: () => void
  /** Prints the chart on landscape paper. */
  onPrint: (paper: GanttPrintPaper) => void
  /** Shows or hides the progress line. */
  onProgressLineChange: (showsProgressLine: boolean) => void
  /** Changes the timeline scale. */
  onScaleChange: (scale: TaskGanttScale) => void
  /** Requested timeline scale. */
  scale: TaskGanttScale
  /** Whether the progress line is shown. */
  showsProgressLine: boolean
  /** Translator used for labels. */
  t: TaskGanttTranslator
}

/**
 * Renders the scale, today, one-line, progress line, and print controls of the Gantt chart.
 *
 * @param props - Current display settings and their change callbacks.
 * @returns The display settings toolbar.
 */
function GanttDisplayToolbar({
  canMoveToToday,
  effectiveScale,
  isCompact,
  onCompactChange,
  onMoveToToday,
  onPrint,
  onProgressLineChange,
  onScaleChange,
  scale,
  showsProgressLine,
  t,
}: GanttDisplayToolbarProps) {
  const buttonClassName = 'rounded-md border border-[var(--workbench-border)] bg-surface px-2.5 py-1 text-xs font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)] disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:border-[var(--workbench-primary)] aria-pressed:text-[var(--workbench-primary-text)]'
  return (
    <div
      aria-label={t('tasks.gantt.display')}
      className="flex flex-wrap items-center gap-2 border-b border-[var(--workbench-border)] bg-surface px-4 py-2"
      data-print-hidden=""
      data-testid="task-gantt-display"
      role="group"
    >
      <label className="flex items-center gap-2 text-xs font-semibold text-[var(--workbench-text)]">
        {t('tasks.gantt.scale')}
        <select
          className="rounded border border-tone-cfd5de bg-surface px-2 py-1 text-xs font-semibold text-fg-344054"
          data-testid="task-gantt-scale"
          onChange={(event) => {
            const value = event.currentTarget.value
            if (isTaskGanttScale(value)) onScaleChange(value)
          }}
          value={scale}
        >
          {taskGanttScales.map((option) => (
            <option key={option} value={option}>{t(`tasks.gantt.scale.${option}`)}</option>
          ))}
        </select>
      </label>
      {effectiveScale && effectiveScale !== scale ? (
        <p className="text-xs font-medium text-[var(--workbench-muted)]" role="status">
          {t('tasks.gantt.scaleCoarsened').replace('{scale}', t(`tasks.gantt.scale.${effectiveScale}`))}
        </p>
      ) : null}
      <button
        className={buttonClassName}
        data-testid="task-gantt-today"
        disabled={!canMoveToToday}
        onClick={onMoveToToday}
        type="button"
      >
        {t('tasks.gantt.today')}
      </button>
      <button
        aria-pressed={isCompact}
        className={buttonClassName}
        data-testid="task-gantt-compact"
        onClick={() => onCompactChange(!isCompact)}
        type="button"
      >
        {t('tasks.gantt.compact')}
      </button>
      <button
        aria-pressed={showsProgressLine}
        className={buttonClassName}
        data-testid="task-gantt-progress-line-toggle"
        onClick={() => onProgressLineChange(!showsProgressLine)}
        type="button"
      >
        {t('tasks.gantt.progressLine')}
      </button>
      <button
        className={buttonClassName}
        data-testid="task-gantt-print-a3"
        onClick={() => onPrint('a3')}
        type="button"
      >
        {t('tasks.gantt.printA3')}
      </button>
      <button
        className={buttonClassName}
        data-testid="task-gantt-print-a4"
        onClick={() => onPrint('a4')}
        type="button"
      >
        {t('tasks.gantt.printA4')}
      </button>
    </div>
  )
}

/**
 * Builds the inclusive range around every canonical schedule and actual date.
 *
 * @param schedules - Schedules rendered on the Gantt chart.
 * @param actualDates - Actual start and end dates that the timeline must also cover.
 * @returns The range covering the planned horizon and the actual work.
 */
function createGanttTimelineRange(
  schedules: readonly WorkItemSchedule[],
  actualDates: readonly string[] = [],
): TaskGanttDateRange {
  const today = getCurrentTaskDate()
  // Without planned dates the range starts from the first actual date instead of today.
  return extendGanttTimelineDateRange(
    createTaskTimelineDateRange(schedules, actualDates[0] ?? today),
    actualDates,
  )
}

/**
 * Builds a bounded inclusive timeline for the automatic scale.
 *
 * Long planning horizons aggregate adjacent dates into at most a fixed number of columns. Exact
 * dates remain available through the row editors and through pointer position within a column.
 *
 * @param range - Inclusive range the timeline covers.
 * @returns Ordered timeline columns covering the range.
 */
function createGanttAutoColumns(range: TaskGanttDateRange): GanttTimelineColumn[] {
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
 * Widens a planned timeline range so it also covers the given actual dates.
 *
 * @param range - Range derived from the planned schedules.
 * @param actualDates - Actual dates to cover.
 * @returns The inclusive range covering both.
 */
function extendGanttTimelineDateRange(
  range: { startDate: string, endDate: string },
  actualDates: readonly string[],
): { startDate: string, endDate: string } {
  return actualDates.reduce(
    (current, date) => ({
      startDate: date < current.startDate ? date : current.startDate,
      endDate: current.endDate < date ? date : current.endDate,
    }),
    range,
  )
}

/**
 * Builds one column per date of a visible Gantt period.
 *
 * @param window - Inclusive visible period.
 * @returns Ordered single-date columns covering the period.
 */
function createGanttWindowColumns(window: TaskScheduleWindow): GanttTimelineColumn[] {
  return listTaskScheduleWindowDates(window).map((date) => ({
    endDate: date,
    label: formatGanttTimelineColumnLabel(date, date),
    startDate: date,
  }))
}

/**
 * Builds deterministic connector geometry for local bars and one-sided cross-Project edges.
 *
 * @param dependencies - Dependency rows touching at least one local task.
 * @param rows - Rendered Gantt rows in display order, including group headings.
 * @param rowTops - Top offset of each rendered row.
 * @param axis - Current bounded timeline columns and their width.
 * @param projectTaskKeys - Unfiltered task identities that belong to the current Project.
 * @param barCenterOffset - Vertical center of a planned bar inside its row.
 * @returns Overlay paths, external stubs, and the lane height required above local rows.
 */
function createGanttDependencyLayout(
  dependencies: readonly WorkItemDependencyRow[],
  rows: readonly TaskGanttRow[],
  rowTops: readonly number[],
  axis: TaskGanttTimelineAxis,
  projectTaskKeys: ReadonlySet<string>,
  barCenterOffset: number,
): GanttDependencyLayout {
  const columnWidth = axis.columnWidth
  const chartWidth = Math.max(columnWidth, axis.columns.length * columnWidth)
  const localRowsByKey = new Map(rows.flatMap((row, rowIndex) => row.kind === 'task'
    ? [[
        createWorkItemDependencyEndpointKey({ teamId: row.task.teamId, workItemId: row.task.id }),
        { bar: createGanttBar(row.schedule, axis), top: rowTops[rowIndex] ?? 0 },
      ] as const]
    : []))
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
      row.predecessor ? createGanttBar(row.predecessor.schedule, axis) : undefined
    )
    const successorBar = localSuccessor?.bar ?? (
      row.successor ? createGanttBar(row.successor.schedule, axis) : undefined
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
        localPredecessor ? 12 : localFallbackX - columnWidth * 2,
      ),
      chartWidth,
    )
    const successorX = clampGanttConnectorX(
      resolveGanttDependencyAnchorX(
        row.dependency,
        'successor',
        successorBar,
        localSuccessor ? chartWidth - 12 : localFallbackX + columnWidth * 2,
      ),
      chartWidth,
    )
    const externalIndex = externalIndexByDependencyId.get(row.dependency.id)
    const externalY = externalIndex === undefined
      ? undefined
      : externalIndex * GANTT_EXTERNAL_STUB_HEIGHT + GANTT_EXTERNAL_STUB_HEIGHT / 2
    const predecessorY = localPredecessor
      ? externalLaneHeight + localPredecessor.top + barCenterOffset
      : externalY
    const successorY = localSuccessor
      ? externalLaneHeight + localSuccessor.top + barCenterOffset
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
 * @param axis - Ordered bounded timeline columns and their width.
 * @returns Bar geometry, or undefined for an unscheduled or out-of-axis item.
 */
function createGanttBar(
  schedule: WorkItemSchedule,
  axis: TaskGanttTimelineAxis,
): GanttBar | undefined {
  const startDate = resolveTaskScheduleStartDate(schedule) ?? resolveTaskScheduleEndDate(schedule)
  const endDate = resolveTaskScheduleEndDate(schedule) ?? startDate
  if (!startDate || !endDate) {
    return undefined
  }
  return createGanttDateRangeBar(startDate, endDate, axis)
}

/**
 * Resolves the date range the actual bar covers: the recorded start to the actual end, or to
 * today while the work is still in progress.
 *
 * Only a `started` Work Item is in progress: a canceled or reopened-to-unstarted Work Item keeps
 * its recorded start without an end, so it gets no open-ended range.
 *
 * @param task - Work Item with recorded actual dates.
 * @param schedule - Schedule whose calendar policy defines today.
 * @returns The inclusive actual range, or undefined before work starts or without ongoing work.
 */
function resolveGanttActualDateRange(
  task: CanonicalWorkItem,
  schedule: WorkItemSchedule,
): { startDate: string, endDate: string } | undefined {
  if (!task.actualStartDate) return undefined
  if (!task.actualEndDate && task.statusCategory !== 'started') return undefined
  const endDate = task.actualEndDate ??
    taskScheduleInstantToLocalDate(new Date(), schedule.calendarPolicy)
  if (endDate < task.actualStartDate) return undefined
  return { startDate: task.actualStartDate, endDate }
}

/**
 * Calculates the actual bar for the range from `resolveGanttActualDateRange`.
 *
 * @param task - Work Item with recorded actual dates.
 * @param schedule - Schedule whose calendar policy defines today.
 * @param axis - Ordered bounded timeline columns and their width.
 * @returns Bar geometry, or undefined without an actual range or outside the visible period.
 */
function createGanttActualBar(
  task: CanonicalWorkItem,
  schedule: WorkItemSchedule,
  axis: TaskGanttTimelineAxis,
): GanttBar | undefined {
  const range = resolveGanttActualDateRange(task, schedule)
  return range ? createGanttDateRangeBar(range.startDate, range.endDate, axis) : undefined
}

/**
 * Calculates bar geometry for an inclusive date range.
 *
 * Each date takes an equal share of its column, so a short range on a week, month, or quarter
 * column keeps its position inside the column instead of filling it.
 *
 * @param startDate - Inclusive first date.
 * @param endDate - Inclusive last date.
 * @param axis - Ordered bounded timeline columns and their width.
 * @returns Bar geometry, or undefined for an out-of-axis range.
 */
function createGanttDateRangeBar(
  startDate: string,
  endDate: string,
  axis: TaskGanttTimelineAxis,
): GanttBar | undefined {
  const firstDate = axis.columns[0]?.startDate
  const lastDate = axis.columns.at(-1)?.endDate
  if (!firstDate || !lastDate || endDate < firstDate || lastDate < startDate) {
    return undefined
  }
  // A windowed timeline clips bars that start before or end after the visible period.
  const startSpan = resolveTaskGanttDateSpan(axis, startDate < firstDate ? firstDate : startDate)
  const endSpan = resolveTaskGanttDateSpan(axis, lastDate < endDate ? lastDate : endDate)
  if (!startSpan || !endSpan || endSpan.right < startSpan.left) {
    return undefined
  }
  const spanWidth = endSpan.right - startSpan.left
  // Day columns keep the 4px gap on each side; narrower spans shrink the gap with them.
  const inset = Math.min(4, spanWidth / 4)
  return {
    left: startSpan.left + inset,
    width: Math.max(GANTT_MIN_BAR_WIDTH, spanWidth - inset * 2),
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
      return 'rounded-md border border-tone-0e9384 bg-tone-ccfbea text-fg-085d55'
    case 'milestone':
      return 'rotate-45 rounded-sm border border-tone-7f56d9 bg-tone-ebe9fe text-fg-53389e'
    case 'due-date':
      return 'rounded-full border-2 border-dashed border-tone-dc6803 bg-tone-fffaeb text-fg-93370d'
    case 'unscheduled':
      return 'border border-dashed border-tone-98a2b3 bg-surface text-fg-667085'
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
  task: CanonicalWorkItem,
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
