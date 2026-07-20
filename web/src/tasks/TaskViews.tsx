import type { ReactNode } from 'react'
import { ChevronIcon } from '../components/icons'
import type { MessageKey } from '../i18n'
import type { ProjectTask, TaskPriority, TaskStatus } from './api'
import { FlagIcon, PlusIcon } from './TaskIcons'
import {
  createTaskCalendarDays,
  createTaskKey,
  isTaskOverdue,
  resolveTaskAssignee,
  resolveTaskTitle,
  sortTasksByDueDate,
} from './taskPresentation'
import { taskStatuses, type TaskTab } from './taskViewTypes'

const viewLabelKeys: Record<TaskTab, MessageKey> = {
  table: 'tasks.view.table',
  board: 'tasks.view.board',
  gantt: 'tasks.view.gantt',
  calendar: 'tasks.view.calendar',
  file: 'tasks.view.file',
  permissions: 'tasks.view.permissions',
}

/**
 * 上部の進捗サマリーに表示する指標です。
 */
type ProjectMetric = {
  /**
   * 指標ラベルを解決する i18n key です。
   */
  labelKey: MessageKey
  /**
   * 指標値として表示する文字列です。
   */
  value: string
  /**
   * 指標バーの進捗率です。
   */
  progressPercent: number
  /**
   * 下線アクセントに使う Tailwind class です。
   */
  accentClassName: string
}

/** タスクを選択可能なテーブルとして描画します。 */
export function TaskTable({
  selectedDetailTaskId,
  selectedTaskIds,
  onCreateTaskOpen,
  onSelectTask,
  onTaskSelectionChange,
  t,
  taskErrorMessage,
  tasks,
}: {
  selectedDetailTaskId?: string
  selectedTaskIds: string[]
  onCreateTaskOpen?: () => void
  onSelectTask: (task: ProjectTask) => void
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  t: (key: MessageKey) => string
  taskErrorMessage?: string
  tasks: ProjectTask[]
}) {
  const hasTaskRows = !taskErrorMessage && tasks.length > 0

  return (
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
                <TaskRow
                  key={createTaskKey(task)}
                  rowIndex={index}
                  onTaskSelectionChange={onTaskSelectionChange}
                  onSelectTask={onSelectTask}
                  selectedForDetail={selectedDetailTaskId === task.id}
                  selected={selectedTaskIds.includes(task.id)}
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
            <PlusIcon className="h-5 w-5" />
            {t('tasks.addTask')}
          </button>
        ) : <span />}
        <span className="text-[#5f6874]" data-testid="tasks-count">
          {t('tasks.count').replace('{count}', String(tasks.length))}
        </span>
      </div>
    </section>
  )
}

/** タスクをステータス別のボードとして描画します。 */
export function TaskBoard({
  selectedDetailTaskId,
  onSelectTask,
  t,
  tasks,
}: {
  selectedDetailTaskId?: string
  onSelectTask: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  return (
    <section
      aria-label={t(viewLabelKeys.board)}
      className="mt-3 grid min-w-0 gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))' }}
    >
      <ViewHeading
        className="col-span-full"
        count={tasks.length}
        t={t}
        titleKey={viewLabelKeys.board}
      />
      {taskStatuses.map((status) => {
        const statusTasks = tasks.filter((task) => task.status === status)

        return (
          <div
            className="workbench-panel min-h-[420px]"
            key={status}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5">
              <TaskStatusBadge status={status} t={t} />
              <span className="text-sm font-semibold text-[#5f6874]">
                {t('tasks.board.columnCount').replace('{count}', String(statusTasks.length))}
              </span>
            </div>
            <div className="grid gap-2 p-2.5">
              {statusTasks.length > 0 ? (
                statusTasks.map((task) => (
                  <button
                    className={`rounded-md border p-3 text-left transition focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 ${
                      selectedDetailTaskId === task.id
                        ? 'border-[#99d7cf] bg-[#e5f7f4] shadow-[inset_3px_0_0_var(--workbench-primary)]'
                        : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                    }`}
                    key={createTaskKey(task)}
                    onClick={() => onSelectTask(task)}
                    type="button"
                  >
                    <p className="text-sm font-semibold leading-5 text-[#1c1d1f]">{resolveTaskTitle(task, t)}</p>
                    <p className="mt-2 truncate text-xs font-medium text-[#5f6874]">
                      {resolveTaskAssignee(task, t)}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <TaskPriorityBadge priority={task.priority} t={t} />
                      <span className="text-xs font-semibold text-[#5f6874]">{task.dueDate}</span>
                    </div>
                  </button>
                ))
              ) : (
                <p className="rounded-md border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
                  {t('tasks.board.empty')}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </section>
  )
}

/** タスクを期限順の一覧として描画します。 */
export function TaskGantt({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const sortedTasks = sortTasksByDueDate(tasks, 'due-date-asc')

  return (
    <section
      aria-label={t(viewLabelKeys.gantt)}
      className="workbench-table mt-3 overflow-hidden"
    >
      <ViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey={viewLabelKeys.gantt}
      />
      {sortedTasks.length > 0 ? (
        <div className="divide-y divide-[#e4e7ec]">
          {sortedTasks.map((task) => (
            <article
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 max-[640px]:grid-cols-1"
              key={createTaskKey(task)}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[#1c1d1f]">
                  {resolveTaskTitle(task, t)}
                </p>
                <p className="mt-1 text-xs font-medium text-[#5f6874]">
                  {resolveTaskAssignee(task, t)}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 max-[640px]:justify-start">
                <TaskStatusBadge status={task.status} t={t} />
                <span className="text-xs font-semibold text-[#5f6874]">
                  {task.dueDate
                    ? t('tasks.gantt.window').replace('{date}', task.dueDate)
                    : t('tasks.calendar.empty')}
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="border-t border-[var(--workbench-border)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('tasks.empty')}
        </p>
      )}
    </section>
  )
}

/** タスクを期限日ごとのカレンダーとして描画します。 */
export function TaskCalendar({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const taskCalendarDays = createTaskCalendarDays(tasks)
  const unscheduledTasks = tasks.filter((task) => !task.dueDate.trim())

  return (
    <section
      aria-label={t(viewLabelKeys.calendar)}
      className="workbench-table mt-3 overflow-hidden"
    >
      <ViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey={viewLabelKeys.calendar}
      />
      {tasks.length > 0 ? (
        <div
          className="grid"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))' }}
        >
          {taskCalendarDays.map((day) => {
            const dayTasks = tasks.filter((task) => task.dueDate === day.date)

            return (
              <div className="min-h-[190px] border-b border-r border-[#e4e7ec] p-3" key={day.id}>
                <p className="text-sm font-semibold text-[#1c1d1f]">{day.label}</p>
                <div className="mt-3 grid gap-2">
                  {dayTasks.map((task) => (
                    <article className="rounded-md border border-[#99d7cf] bg-[#e5f7f4] p-3" key={createTaskKey(task)}>
                      <p className="text-sm font-semibold leading-5 text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
                      <p className="mt-2 text-xs font-medium text-[var(--workbench-primary)]">{resolveTaskAssignee(task, t)}</p>
                    </article>
                  ))}
                </div>
              </div>
            )
          })}
          {unscheduledTasks.length > 0 ? (
            <div className="min-h-[190px] border-b border-r border-[#e4e7ec] p-3">
              <p className="text-sm font-semibold text-[#1c1d1f]">{t('tasks.calendar.empty')}</p>
              <div className="mt-3 grid gap-2">
                {unscheduledTasks.map((task) => (
                  <article className="rounded-md border border-[var(--workbench-border)] bg-white p-3" key={createTaskKey(task)}>
                    <p className="text-sm font-semibold leading-5 text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
                    <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{resolveTaskAssignee(task, t)}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="border-t border-[var(--workbench-border)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('tasks.empty')}
        </p>
      )}
    </section>
  )
}

/** タスクに関連するファイル機能の準備状態を描画します。 */
export function TaskFileList({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  return (
    <section
      aria-label={t(viewLabelKeys.file)}
      className="workbench-table mt-3 overflow-hidden"
    >
      <ViewHeading
        count={tasks.length}
        meta={t('tasks.file.description')}
        t={t}
        titleKey={viewLabelKeys.file}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="workbench-table-head">
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.name')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.owner')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.column.dueDate')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.status')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr className="border-b border-[#e4e7ec] text-sm font-medium text-[#1c1d1f] last:border-b-0" key={createTaskKey(task)}>
                <td className="px-4 py-3 font-semibold">{resolveTaskTitle(task, t)}</td>
                <td className="px-4 py-3 text-[#505967]">{resolveTaskAssignee(task, t)}</td>
                <td className="px-4 py-3 text-[#5f6874]">{task.dueDate}</td>
                <td className="px-4 py-3">
                  <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                    {t(`tasks.status.${task.status}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ViewHeading({
  className = '',
  count,
  meta,
  t,
  titleKey,
}: {
  className?: string
  count: number
  meta?: string
  t: (key: MessageKey) => string
  titleKey: MessageKey
}) {
  return (
    <div className={`border-b border-[#e4e7ec] bg-white px-4 py-3 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[#1c1d1f]">{t(titleKey)}</h2>
        <p className="text-sm font-medium text-[#5f6874]">
          {t('tasks.count').replace('{count}', String(count))}
        </p>
      </div>
      {meta ? <p className="mt-1 text-sm font-medium text-[#5f6874]">{meta}</p> : null}
    </div>
  )
}

function TaskStatusBadge({ status, t }: { status: TaskStatus; t: (key: MessageKey) => string }) {
  const statusClasses: Record<TaskStatus, string> = {
    'in-progress': 'workbench-badge-primary',
    review: 'workbench-badge-warning',
    todo: 'workbench-badge',
    done: 'workbench-badge-success',
  }

  return (
    <span className={statusClasses[status]}>
      {t(`tasks.status.${status}`)}
    </span>
  )
}

/** タスク優先度を色付きバッジとして描画します。 */
export function TaskPriorityBadge({
  priority,
  t,
}: {
  priority: TaskPriority
  t: (key: MessageKey) => string
}) {
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'workbench-badge-danger',
    medium: 'workbench-badge-warning',
    low: 'workbench-badge-success',
  }

  return (
    <span className={priorityClasses[priority]}>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}

/** タスクの進捗サマリーをヘッダー向けに描画します。 */
export function SummaryCard({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const totalCount = tasks.length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const inProgressCount = tasks.filter((task) => task.status === 'in-progress').length
  const completionRate = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0
  const projectMetrics: ProjectMetric[] = [
    {
      labelKey: 'tasks.metric.inProgress',
      value: String(inProgressCount),
      progressPercent: totalCount > 0 ? Math.round((inProgressCount / totalCount) * 100) : 0,
      accentClassName: 'bg-[var(--workbench-primary)]',
    },
    {
      labelKey: 'tasks.metric.done',
      value: String(doneCount),
      progressPercent: completionRate,
      accentClassName: 'bg-emerald-500',
    },
  ]

  return (
    <section
      aria-label={t('tasks.summary.aria')}
      className="flex min-w-[390px] items-center gap-3 border-l border-[#e4e7ec] py-2 pl-4 max-[1400px]:hidden"
    >
      {projectMetrics.map((metric) => (
        <div className="min-w-[96px]" key={metric.labelKey}>
          <p className="text-xs font-semibold text-[#5f6874]">{t(metric.labelKey)}</p>
          <p className="mt-1 text-lg font-semibold leading-none text-[#1c1d1f]">{metric.value}</p>
          <div className="mt-2 h-1 rounded-full bg-[#e4e7ec]">
            <div
              className={`h-1 rounded-full ${metric.accentClassName}`}
              style={{ width: `${metric.progressPercent}%` }}
            />
          </div>
        </div>
      ))}
      <div>
        <p className="text-xs font-semibold text-[#5f6874]">{t('tasks.metric.completionRate')}</p>
        <p className="mt-1 text-lg font-semibold leading-none text-[#1c1d1f]">{completionRate}%</p>
      </div>
      <div className="relative h-10 w-10">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(var(--workbench-primary) 0 ${completionRate}%, var(--workbench-border) ${completionRate}% 100%)`,
          }}
        />
        <div className="absolute inset-[6px] rounded-full bg-white" />
      </div>
    </section>
  )
}

/** タスク絞り込み操作に使う共通ボタンです。 */
export function FilterButton({
  active = false,
  ariaControls,
  ariaExpanded,
  ariaHaspopup,
  icon,
  id,
  label,
  onClick,
}: {
  active?: boolean
  ariaControls?: string
  ariaExpanded?: boolean
  ariaHaspopup?: 'menu'
  icon: ReactNode
  id?: string
  label: string
  onClick?: () => void
}) {
  return (
    <button
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      aria-label={label}
      className={`inline-flex h-9 min-w-[104px] items-center justify-between gap-2 rounded-md border bg-white px-3 text-sm font-semibold transition focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 ${
        active
          ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary)]'
          : 'border-[var(--workbench-border-strong)] text-[var(--workbench-text)] hover:border-[var(--workbench-primary)] hover:text-[var(--workbench-primary)]'
      }`}
      id={id}
      onClick={onClick}
      type="button"
    >
      <span className="inline-flex items-center gap-2">
        {icon}
        {label}
      </span>
      <ChevronIcon className="h-4 w-4" />
    </button>
  )
}

function TaskRow({
  rowIndex,
  selected,
  selectedForDetail,
  onSelectTask,
  onTaskSelectionChange,
  task,
  t,
}: {
  rowIndex: number
  selected: boolean
  selectedForDetail: boolean
  onSelectTask: (task: ProjectTask) => void
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  task: ProjectTask
  t: (key: MessageKey) => string
}) {
  const statusClasses: Record<TaskStatus, string> = {
    'in-progress': 'workbench-badge-primary',
    review: 'workbench-badge-warning',
    todo: 'workbench-badge',
    done: 'workbench-badge-success',
  }
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'workbench-badge-danger',
    medium: 'workbench-badge-warning',
    low: 'workbench-badge-success',
  }
  const taskTitle = resolveTaskTitle(task, t)
  const isOverdue = isTaskOverdue(task)

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
            onChange={(event) => onTaskSelectionChange(task.id, event.target.checked)}
            type="checkbox"
          />
          <button
            className="min-w-0 truncate text-left font-semibold text-[var(--workbench-text)] transition hover:text-[var(--workbench-primary)]"
            onClick={() => onSelectTask(task)}
            type="button"
          >
            {taskTitle}
          </button>
          {selected ? (
            <span className="workbench-badge-primary">
              {t('tasks.row.selected')}
            </span>
          ) : null}
        </div>
      </td>
      <td className="truncate px-3 py-2.5 text-[#505967]">{resolveTaskAssignee(task, t)}</td>
      <td className="px-3 py-2.5">
        <span className={statusClasses[task.status]}>
          {t(`tasks.status.${task.status}`)}
        </span>
      </td>
      <td
        className={`whitespace-nowrap px-3 py-2.5 ${
          task.status === 'done' ? 'text-[#8f99a8] line-through' : isOverdue ? 'text-red-700' : 'text-[#505967]'
        }`}
      >
        {task.dueDate}
      </td>
      <td className="px-3 py-2.5">
        <span
          className={`${priorityClasses[task.priority]} whitespace-nowrap`}
        >
          <FlagIcon className="h-4 w-4" />
          {t(`tasks.priority.${task.priority}`)}
        </span>
      </td>
      <td className="px-3 py-2.5" />
    </tr>
  )
}
