import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type {
  WorkItemSchedule,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import type { CanonicalWorkItem } from '../api/tasks'
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
  createDefaultDateRangeTaskSchedule,
  createDefaultDueDateTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
  createMoveTaskScheduleOperation,
  createReplaceTaskScheduleOperation,
  formatTaskScheduleRange,
  resolveTaskSchedule,
  resolveTaskSchedulePrimaryDate,
  tryAddTaskTimelineDays,
  unscheduleTaskSchedule,
} from '../model/taskSchedule'
import { createTaskKey, type TaskCreateContext } from '../model/taskView'
import { TaskViewHeading } from './TaskViewPrimitives'
import { TaskSchedulePreviewMetadata } from './TaskSchedulePreviewMetadata'

/** Resolves a localized task-calendar message. */
type TaskCalendarTranslator = (key: MessageKey) => string

/** Context used when a task is created from a schedule-aware calendar selection. */
type CalendarTaskCreateContext = TaskCreateContext & {
  /** Canonical schedule selected by a single date or date range. */
  schedule?: WorkItemSchedule
}

/** One task paired with its resolved canonical schedule. */
type CalendarTaskEntry = {
  /** Task placed on the calendar. */
  task: CanonicalWorkItem
  /** Canonical schedule rendered for the task. */
  schedule: WorkItemSchedule
}

/** One visible calendar day and the tasks anchored to it. */
type CanonicalCalendarDay = {
  /** ISO calendar date represented by the cell. */
  date: string
  /** Tasks whose canonical primary date matches the cell. */
  entries: CalendarTaskEntry[]
}

/** Canonical calendar model with explicit unscheduled entries. */
type CanonicalCalendarModel = {
  /** Ordered date cells around all scheduled tasks. */
  days: CanonicalCalendarDay[]
  /** Tasks retaining the explicit unscheduled mode. */
  unscheduledEntries: CalendarTaskEntry[]
}

/** A Calendar preview waiting for confirmation. */
type PendingCalendarScheduleChange = {
  /** Task whose operation created the preview. */
  task: CanonicalWorkItem
  /** Exact canonical invocation controlling preview confirmation and cancellation. */
  controller: ProjectTaskDirectScheduleController
}

/** Props for the independent project task calendar view. */
export type TaskCalendarViewProps = {
  /** Project receiving contextual Calendar creates. */
  projectId?: string
  /** Filtered and sorted tasks displayed by canonical primary date. */
  tasks: CanonicalWorkItem[]
  /** Translator used for calendar labels. */
  t: TaskCalendarTranslator
  /** Opens the create panel with a date or date-range context. */
  onCreateTaskOpen?: (context?: CalendarTaskCreateContext) => void
  /** Selects a task in the shared detail pane. */
  onSelectTask?: (task: CanonicalWorkItem) => void
  /** Starts a canonical Schedule action and returns its exact preview controller. */
  onRequestScheduleChange?: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => ProjectTaskDirectScheduleHandle
}

/** Props for the Calendar schedule-preview dialog. */
type CalendarSchedulePreviewProps = {
  /** Preview and target task waiting for confirmation. */
  pending: PendingCalendarScheduleChange
  /** Whether the confirmed schedule is being persisted. */
  isApplying: boolean
  /** Translator used by dialog actions. */
  t: TaskCalendarTranslator
  /** Applies the previewed schedule. */
  onConfirm: () => void
  /** Discards the preview. */
  onCancel: () => void
}

/**
 * Renders Work Items by canonical primary date with drag and keyboard rescheduling.
 *
 * A scheduled card is moved through the same server preview flow as Gantt. Unscheduled cards
 * remain in a distinct bucket and can be dropped onto a date to create a deadline-only schedule.
 *
 * @param props - Tasks, localization, contextual create, and schedule mutation callbacks.
 * @returns The independent project task calendar view.
 */
export function TaskCalendarView({
  onCreateTaskOpen,
  onRequestScheduleChange,
  onSelectTask,
  projectId,
  t,
  tasks,
}: TaskCalendarViewProps) {
  const calendar = useMemo(() => createCanonicalCalendarModel(tasks), [tasks])
  const [draggedTaskKey, setDraggedTaskKey] = useState<string>()
  const [rangeStartDate, setRangeStartDate] = useState<string>()
  const [busyTaskKey, setBusyTaskKey] = useState<string>()
  const [pendingChange, setPendingChange] = useState<PendingCalendarScheduleChange>()
  const [isApplying, setIsApplying] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()
  const calendarSectionRef = useRef<HTMLElement>(null)
  const isMountedRef = useRef(true)
  const activeScheduleHandleRef = useRef<ProjectTaskDirectScheduleHandle | undefined>(undefined)
  const pendingFocusTaskKeyRef = useRef<string | undefined>(undefined)
  const pendingChangeRef = useRef<PendingCalendarScheduleChange | undefined>(undefined)
  const nextScheduleRequestSequenceRef = useRef(0)
  const canEditSchedule = onRequestScheduleChange !== undefined
  const entries = [...calendar.days.flatMap((day) => day.entries), ...calendar.unscheduledEntries]

  useEffect(() => {
    const taskKey = pendingFocusTaskKeyRef.current
    if (pendingChange || !taskKey) {
      return
    }
    if (focusCalendarTaskCard(calendarSectionRef.current, taskKey)) {
      pendingFocusTaskKeyRef.current = undefined
    }
  }, [calendar, pendingChange])
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
      ) setErrorMessage(resolveCalendarScheduleError(error, t))
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

    const schedule = findCalendarDirectPreviewSchedule(
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
    const taskToFocus = pendingChange.task
    try {
      await pendingChange.controller.confirm()
    } catch (error) {
      if (isMountedRef.current && !isProjectTaskDirectScheduleCancelled(error)) {
        setErrorMessage(resolveCalendarScheduleError(error, t))
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
        pendingFocusTaskKeyRef.current = createTaskKey(taskToFocus)
      }
    }
  }

  /** Moves a dragged task to one date or schedules an explicitly unscheduled task there. */
  const dropTaskOnDate = (date: string) => {
    if (!draggedTaskKey) {
      return
    }
    const entry = entries.find((candidate) => createTaskKey(candidate.task) === draggedTaskKey)
    setDraggedTaskKey(undefined)
    if (!entry) {
      return
    }
    const operation = entry.schedule.mode === 'unscheduled'
      ? createReplaceTaskScheduleOperation(createDueDateScheduleAt(entry.schedule, date))
      : createMoveTaskScheduleOperation(date)
    void previewScheduleChange(entry.task, operation)
  }

  /** Previews removal of calendar placement for a task dropped into the unscheduled bucket. */
  const dropTaskOnUnscheduled = () => {
    if (!draggedTaskKey) {
      return
    }
    const entry = entries.find((candidate) => createTaskKey(candidate.task) === draggedTaskKey)
    setDraggedTaskKey(undefined)
    if (!entry || entry.schedule.mode === 'unscheduled') {
      return
    }
    void previewScheduleChange(
      entry.task,
      createReplaceTaskScheduleOperation(unscheduleTaskSchedule(entry.schedule)),
    )
  }

  /** Opens either a one-day create or completes a two-click range create. */
  const openCreateForDate = (date: string, range: boolean) => {
    if (!onCreateTaskOpen) {
      return
    }
    if (!range) {
      onCreateTaskOpen({
        ...(projectId ? { projectId } : {}),
        schedule: createDefaultDueDateTaskSchedule(date),
        source: 'calendar',
      })
      return
    }
    if (!rangeStartDate) {
      setRangeStartDate(date)
      return
    }
    const startDate = rangeStartDate < date ? rangeStartDate : date
    const endDate = rangeStartDate < date ? date : rangeStartDate
    onCreateTaskOpen({
      ...(projectId ? { projectId } : {}),
      schedule: createDefaultDateRangeTaskSchedule(startDate, endDate),
      source: 'calendar',
    })
    setRangeStartDate(undefined)
  }

  return (
    <section
      aria-label={t('tasks.view.calendar')}
      className="workbench-table mt-3 overflow-hidden"
      ref={calendarSectionRef}
    >
      <TaskViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey="tasks.view.calendar"
      />
      {errorMessage ? (
        <p className="border-b border-[#fecaca] bg-[#fef2f2] px-4 py-2 text-sm font-medium text-[#b42318]" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {rangeStartDate ? (
        <div className="flex items-center justify-between gap-3 border-b border-[#f4d38b] bg-[#fffaeb] px-4 py-2 text-sm text-[#93370d]" role="status">
          <span>{t('tasks.schedule.rangeStart').replace('{date}', rangeStartDate)}</span>
          <button className="font-semibold underline" onClick={() => setRangeStartDate(undefined)} type="button">
            {t('tasks.create.cancel')}
          </button>
        </div>
      ) : null}
      <div
        className="grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))' }}
      >
        {calendar.days.map((day) => (
          <div
            className="min-h-[210px] border-b border-r border-[#e4e7ec] p-3 transition-colors"
            data-testid={`task-calendar-day-${day.date}`}
            key={day.date}
            onDragOver={(event) => {
              if (draggedTaskKey) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }
            }}
            onDrop={(event) => {
              event.preventDefault()
              dropTaskOnDate(day.date)
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <time className="text-sm font-semibold text-[#1c1d1f]" dateTime={day.date}>{day.date}</time>
              {onCreateTaskOpen ? (
                <span className="flex items-center gap-1">
                  <button
                    aria-label={`${t('tasks.calendar.addOnDate')}: ${day.date}`}
                    className="rounded px-1.5 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-[#e5f7f4]"
                    onClick={() => openCreateForDate(day.date, false)}
                    type="button"
                  >
                    +
                  </button>
                  <button
                    aria-label={t('tasks.schedule.rangeCreate').replace('{date}', day.date)}
                    aria-pressed={rangeStartDate === day.date}
                    className="rounded px-1.5 py-1 text-xs font-bold text-[var(--workbench-primary)] hover:bg-[#e5f7f4] aria-pressed:bg-[#ccfbea]"
                    onClick={() => openCreateForDate(day.date, true)}
                    type="button"
                  >
                    ↔
                  </button>
                </span>
              ) : null}
            </div>
            <div className="mt-3 grid gap-2">
              {day.entries.map((entry) => (
                <CalendarTaskCard
                  busy={busyTaskKey === createTaskKey(entry.task)}
                  canEditSchedule={canEditSchedule}
                  entry={entry}
                  key={createTaskKey(entry.task)}
                  onDragEnd={() => setDraggedTaskKey(undefined)}
                  onDragStart={(event) => {
                    const taskKey = createTaskKey(entry.task)
                    setDraggedTaskKey(taskKey)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', taskKey)
                  }}
                  onMove={(date) => void previewScheduleChange(
                    entry.task,
                    createMoveTaskScheduleOperation(date),
                  )}
                  onSelectTask={onSelectTask}
                  onUnschedule={() => void previewScheduleChange(
                    entry.task,
                    createReplaceTaskScheduleOperation(unscheduleTaskSchedule(entry.schedule)),
                  )}
                  t={t}
                />
              ))}
            </div>
          </div>
        ))}
        <div
          className="min-h-[210px] border-b border-r border-[#e4e7ec] bg-[#f8fafb] p-3"
          data-testid="task-calendar-unscheduled"
          onDragOver={(event) => {
            if (draggedTaskKey) {
              event.preventDefault()
            }
          }}
          onDrop={(event) => {
            event.preventDefault()
            dropTaskOnUnscheduled()
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-[#1c1d1f]">{t('tasks.calendar.empty')}</p>
            {onCreateTaskOpen ? (
              <button
                aria-label={t('tasks.calendar.addWithoutDate')}
                className="rounded px-1.5 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-[#e5f7f4]"
                onClick={() => onCreateTaskOpen({
                  ...(projectId ? { projectId } : {}),
                  schedule: createDefaultUnscheduledTaskSchedule(),
                  source: 'calendar',
                })}
                type="button"
              >
                +
              </button>
            ) : null}
          </div>
          <div className="mt-3 grid gap-2">
            {calendar.unscheduledEntries.map((entry) => (
              <CalendarTaskCard
                busy={busyTaskKey === createTaskKey(entry.task)}
                canEditSchedule={canEditSchedule}
                entry={entry}
                key={createTaskKey(entry.task)}
                onDragEnd={() => setDraggedTaskKey(undefined)}
                onDragStart={(event) => {
                  const taskKey = createTaskKey(entry.task)
                  setDraggedTaskKey(taskKey)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', taskKey)
                }}
                onMove={(date) => void previewScheduleChange(
                  entry.task,
                  createReplaceTaskScheduleOperation(createDueDateScheduleAt(
                    entry.schedule,
                    date,
                  )),
                )}
                onSelectTask={onSelectTask}
                t={t}
              />
            ))}
          </div>
        </div>
      </div>
      {pendingChange ? (
        <CalendarSchedulePreview
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

/** Props for one draggable Calendar task card. */
type CalendarTaskCardProps = {
  /** Whether this task is waiting for a preview response. */
  busy: boolean
  /** Whether schedule mutation callbacks are available. */
  canEditSchedule: boolean
  /** Task and canonical schedule rendered by the card. */
  entry: CalendarTaskEntry
  /** Clears drag state after native dragging ends. */
  onDragEnd: () => void
  /** Starts native HTML dragging. */
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  /** Requests a keyboard move to a new primary date. */
  onMove: (date: string) => void
  /** Selects the task in the shared detail pane. */
  onSelectTask?: (task: CanonicalWorkItem) => void
  /** Moves a scheduled task to the explicit unscheduled state. */
  onUnschedule?: () => void
  /** Translator used by schedule labels. */
  t: TaskCalendarTranslator
}

/**
 * Renders a mode-distinct task card with native drag and arrow-key movement.
 *
 * @param props - Task entry and interaction callbacks.
 * @returns One Calendar task card.
 */
function CalendarTaskCard({
  busy,
  canEditSchedule,
  entry,
  onDragEnd,
  onDragStart,
  onMove,
  onSelectTask,
  onUnschedule,
  t,
}: CalendarTaskCardProps) {
  const primaryDate = resolveTaskSchedulePrimaryDate(entry.schedule)
  const scheduleRange = formatTaskScheduleRange(entry.schedule)
  return (
    <article className={`rounded-md border p-3 ${resolveCalendarCardClass(entry.schedule.mode)}`}>
      <button
        aria-label={canEditSchedule && primaryDate
          ? t('tasks.schedule.calendarMoveA11y')
              .replace('{task}', resolveWorkItemTitle(entry.task))
              .replace('{schedule}', describeCalendarSchedule(entry.schedule, t))
          : `${resolveWorkItemTitle(entry.task)}: ${describeCalendarSchedule(entry.schedule, t)}`}
        className="block w-full text-left focus:outline-none focus:ring-2 focus:ring-[var(--workbench-primary)]"
        data-task-calendar-key={createTaskKey(entry.task)}
        data-testid={`task-calendar-item-${entry.task.id}`}
        disabled={busy || (!onSelectTask && !canEditSchedule)}
        draggable={canEditSchedule && !busy}
        onClick={() => onSelectTask?.(entry.task)}
        onDragEnd={onDragEnd}
        onDragStart={onDragStart}
        onKeyDown={canEditSchedule
          ? (event) => handleCalendarMoveKey(event, primaryDate, onMove)
          : undefined}
        type="button"
      >
        <span className="block text-sm font-semibold leading-5 text-[var(--workbench-text)]">
          {resolveWorkItemTitle(entry.task)}
        </span>
        <span className="mt-1 block text-[11px] font-bold uppercase tracking-wide">
          {resolveCalendarModeLabel(entry.schedule.mode, t)}
        </span>
        {scheduleRange ? (
          <span className="mt-1 block text-xs font-semibold">{scheduleRange}</span>
        ) : null}
        <span className="mt-2 block text-xs font-medium text-[var(--workbench-primary)]">
          {resolveWorkItemAssignee(entry.task)}
        </span>
        {busy ? <span className="mt-1 block text-xs" role="status">{t('bulk.previewing')}</span> : null}
      </button>
      {canEditSchedule && !primaryDate ? (
        <label className="mt-2 grid gap-1 text-xs font-semibold text-[#667085]">
          {t('tasks.schedule.scheduleOnDate').replace(
            '{task}',
            resolveWorkItemTitle(entry.task),
          )}
          <input
            className="rounded border border-[#cfd5de] bg-white px-2 py-1"
            disabled={busy}
            onChange={(event) => {
              if (event.currentTarget.value) {
                onMove(event.currentTarget.value)
              }
            }}
            type="date"
            value=""
          />
        </label>
      ) : null}
      {canEditSchedule && onUnschedule ? (
        <button
          className="mt-2 text-xs font-semibold underline underline-offset-2"
          disabled={busy}
          onClick={onUnschedule}
          type="button"
        >
          {t('tasks.schedule.moveToUnscheduled').replace(
            '{task}',
            resolveWorkItemTitle(entry.task),
          )}
        </button>
      ) : null}
    </article>
  )
}

/**
 * Renders direct and ripple schedule changes before Calendar persists them.
 *
 * @param props - Pending preview and confirm/cancel actions.
 * @returns An accessible modal schedule preview.
 */
function CalendarSchedulePreview({
  isApplying,
  onCancel,
  onConfirm,
  pending,
  t,
}: CalendarSchedulePreviewProps) {
  const dialogRef = useModalFocus<HTMLDivElement>(onCancel)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#101828]/45 p-4">
      <div
        aria-labelledby="calendar-schedule-preview-title"
        aria-modal="true"
        className="max-h-[min(680px,90vh)] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-5 shadow-2xl"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="text-lg font-bold text-[#101828]" id="calendar-schedule-preview-title">
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
                <span className="line-through">{describeCalendarSchedule(impact.before, t)}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only">{t('tasks.schedule.after')}: </span>
                <span className="font-semibold text-[#101828]">{describeCalendarSchedule(impact.after, t)}</span>
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
                <li key={warning}>{resolveCalendarScheduleWarning(warning, t)}</li>
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
 * Groups tasks by canonical primary date and retains a separate unscheduled bucket.
 *
 * @param tasks - Work Items displayed by Calendar.
 * @returns A deterministic date grid and explicit unscheduled entries.
 */
function createCanonicalCalendarModel(tasks: readonly CanonicalWorkItem[]): CanonicalCalendarModel {
  const entries = tasks.map((task) => ({ schedule: resolveTaskSchedule(task), task }))
  const scheduledEntries = entries.filter(hasCalendarPrimaryDate)
  const today = new Date().toISOString().slice(0, 10)
  const primaryDates = scheduledEntries.flatMap((entry) => {
    const primaryDate = resolveTaskSchedulePrimaryDate(entry.schedule)
    return primaryDate ? [primaryDate] : []
  })
  const anchors = primaryDates.length > 0 ? primaryDates : [today]
  const dates = [...new Set(anchors.flatMap((anchor) =>
    [-3, -2, -1, 0, 1, 2, 3].flatMap((offset) => {
      const shiftedDate = tryAddTaskTimelineDays(anchor, offset)
      return shiftedDate ? [shiftedDate] : []
    })
  ))].toSorted()
  return {
    days: dates.map((date) => ({
      date,
      entries: scheduledEntries
        .filter((entry) => resolveTaskSchedulePrimaryDate(entry.schedule) === date)
        .toSorted((left, right) => createTaskKey(left.task).localeCompare(createTaskKey(right.task))),
    })),
    unscheduledEntries: entries
      .filter((entry) => entry.schedule.mode === 'unscheduled')
      .toSorted((left, right) => createTaskKey(left.task).localeCompare(createTaskKey(right.task))),
  }
}

/**
 * Narrows a Calendar entry to one with a canonical primary date.
 *
 * @param entry - Candidate task and schedule pair.
 * @returns True when the schedule is explicitly placed on a date.
 */
function hasCalendarPrimaryDate(entry: CalendarTaskEntry): boolean {
  return resolveTaskSchedulePrimaryDate(entry.schedule) !== undefined
}

/**
 * Creates a deadline-only replacement when an unscheduled card is dropped on a date.
 *
 * @param schedule - Existing unscheduled schedule whose calendar policy is retained.
 * @param date - Target ISO date.
 * @returns A deadline-only canonical schedule candidate.
 */
function createDueDateScheduleAt(
  schedule: WorkItemSchedule,
  date: string,
): WorkItemSchedule {
  return {
    calendarPolicy: schedule.calendarPolicy,
    dueDate: date,
    mode: 'due-date',
    ...(schedule.plannedEffortMinutes === undefined
      ? {}
      : { plannedEffortMinutes: schedule.plannedEffortMinutes }),
  }
}

/**
 * Handles day-by-day keyboard movement for a scheduled Calendar card.
 *
 * @param event - Keyboard event from the focused task card.
 * @param primaryDate - Current deadline, milestone date, or range start.
 * @param onMove - Callback receiving the new target date.
 */
function handleCalendarMoveKey(
  event: KeyboardEvent<HTMLButtonElement>,
  primaryDate: string | undefined,
  onMove: (date: string) => void,
) {
  if (
    !primaryDate ||
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
  ) {
    return
  }
  const targetDate = tryAddTaskTimelineDays(
    primaryDate,
    event.key === 'ArrowLeft' ? -1 : 1,
  )
  if (!targetDate) {
    return
  }
  event.preventDefault()
  onMove(targetDate)
}

/**
 * Returns distinct Calendar card treatment for every explicit schedule state.
 *
 * @param mode - Canonical schedule mode.
 * @returns Tailwind class list for the card.
 */
function resolveCalendarCardClass(mode: WorkItemSchedule['mode']): string {
  switch (mode) {
    case 'date-range':
      return 'border-[#99d7cf] bg-[#e5f7f4] text-[#085d55]'
    case 'milestone':
      return 'border-[#bdb4fe] bg-[#f4f3ff] text-[#53389e]'
    case 'due-date':
      return 'border-dashed border-[#f4b740] bg-[#fffaeb] text-[#93370d]'
    case 'unscheduled':
      return 'border-[#d8dde5] bg-white text-[#667085]'
  }
}

/**
 * Resolves an explicit mode label without treating a deadline as a duration task.
 *
 * @param mode - Canonical schedule mode.
 * @param t - Translator used for the unscheduled label.
 * @returns A short visible mode label.
 */
function resolveCalendarModeLabel(
  mode: WorkItemSchedule['mode'],
  t: TaskCalendarTranslator,
): string {
  switch (mode) {
    case 'date-range':
      return t('tasks.schedule.dateRange')
    case 'milestone':
      return t('tasks.schedule.milestone')
    case 'due-date':
      return t('tasks.schedule.dueDate')
    case 'unscheduled':
      return t('tasks.calendar.empty')
  }
}

/**
 * Formats a canonical schedule for card assistive text and preview comparisons.
 *
 * @param schedule - Schedule to describe.
 * @param t - Translator used for the unscheduled label.
 * @returns A mode-preserving schedule description.
 */
function describeCalendarSchedule(
  schedule: WorkItemSchedule,
  t: TaskCalendarTranslator,
): string {
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
function findCalendarDirectPreviewSchedule(
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
 * @returns A safe message for the Calendar alert.
 */
function resolveCalendarScheduleError(error: unknown, t: TaskCalendarTranslator): string {
  if (error instanceof TeamIssuesApiError) {
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

/**
 * Maps stable preview warning codes to localized Calendar guidance.
 *
 * @param warning - Warning code returned by schedule preview.
 * @param t - Translator used for known and generic warning text.
 * @returns Localized warning copy.
 */
function resolveCalendarScheduleWarning(
  warning: string,
  t: TaskCalendarTranslator,
): string {
  if (warning === 'DependencyRippleRequiresReview') {
    return t('tasks.schedule.warning.dependencyRipple')
  }
  return warning === 'SemanticBlockRelationsDoNotReschedule'
    ? t('tasks.schedule.warning.semanticBlocks')
    : t('tasks.schedule.warning.generic')
}

/**
 * Focuses the newly rendered Calendar card for a stable composite task key.
 *
 * @param container - Calendar surface containing the potentially reparented card.
 * @param taskKey - Composite Work Item key stored on Calendar task buttons.
 * @returns True when a matching focus target was found.
 */
function focusCalendarTaskCard(container: HTMLElement | null, taskKey: string): boolean {
  const cards = container?.querySelectorAll<HTMLButtonElement>('[data-task-calendar-key]') ?? []
  for (const card of cards) {
    if (card.dataset.taskCalendarKey === taskKey) {
      card.focus()
      return true
    }
  }
  return false
}
