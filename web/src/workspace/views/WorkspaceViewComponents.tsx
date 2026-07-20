import type { DragEvent } from 'react'
import type { MessageKey } from '../../i18n'
import type {
  ProjectTask,
  TaskPriority,
  TaskStatus,
} from '../../tasks/api'
import { workspacePresentation } from '../workspacePresentation'

const myTaskKanbanStatuses = ['todo', 'in-progress', 'review', 'done'] as const satisfies readonly TaskStatus[]

/**
 * Team member 取得状態を通知するメッセージを描画します。
 */
export function TeamMembersNotice({
  failedProjectIds,
  isLoading,
  t,
}: {
  failedProjectIds: string[]
  isLoading: boolean
  t: (key: MessageKey) => string
}) {
  if (isLoading) {
    return (
      <p className="rounded-lg border border-[#99d7cf] bg-[#e5f7f4] px-4 py-3 text-sm font-semibold text-[var(--workbench-primary)]">
        {t('workspace.members.loading')}
      </p>
    )
  }

  if (failedProjectIds.length === 0) {
    return null
  }

  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
      {t('workspace.members.partialError').replace('{count}', String(failedProjectIds.length))}
    </p>
  )
}

/**
 * Workspace の集計指標カードを描画します。
 */
export function MetricCard({
  label,
  testId,
  tone,
  value,
}: {
  label: string
  testId?: string
  tone: 'amber' | 'teal' | 'emerald' | 'red'
  value: number | string
}) {
  const toneClassNames = {
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    teal: 'bg-[#e5f7f4] text-[var(--workbench-primary)] border-[#99d7cf]',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red: 'bg-red-50 text-red-700 border-red-200',
  } as const

  return (
    <section
      className={`rounded-lg border bg-white p-4 shadow-[0_1px_2px_rgba(23,32,29,0.04)] ${toneClassNames[tone]}`}
      data-testid={testId}
    >
      <p className="text-xs font-semibold text-[var(--workbench-text)]">{label}</p>
      <p className="mt-2 text-3xl font-semibold leading-none text-current">{value}</p>
    </section>
  )
}

/**
 * Workspace panel の共通見出しを描画します。
 */
export function SectionHeader({ meta, title }: { meta?: string; title: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{title}</h2>
      {meta ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{meta}</p> : null}
    </div>
  )
}

/**
 * Workspace の共通タスク一覧行を描画します。
 */
export function TaskListRow({
  onOpenTask,
  t,
  task,
}: {
  onOpenTask?: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  task: ProjectTask
}) {
  const canOpenTask = Boolean(onOpenTask) && workspacePresentation.isOpenableWorkspaceTask(task)

  return (
    <button
      className="grid w-full grid-cols-[1fr_140px_110px_96px] items-center gap-4 p-5 text-left text-sm font-medium transition hover:bg-[var(--workbench-surface-muted)] disabled:hover:bg-transparent max-[900px]:grid-cols-1"
      disabled={!canOpenTask}
      onClick={() => onOpenTask?.(task)}
      type="button"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">{workspacePresentation.resolveTaskTitle(task, t)}</p>
        <p className="mt-1 text-[var(--workbench-muted)]">{workspacePresentation.resolveTaskAssignee(task, t)}</p>
      </div>
      <StatusPill status={task.status} t={t} />
      <span className="text-[var(--workbench-muted)]">{task.dueDate}</span>
      <span className="workbench-badge justify-self-end max-[900px]:justify-self-start">
        {t('workspace.action.openTask')}
      </span>
    </button>
  )
}

/**
 * Kanban 用のコンパクトなタスクカードを描画します。
 */
export function CompactTaskCard({
  draggable = false,
  isDragging = false,
  isMoving = false,
  onDragEnd,
  onDragStart,
  onOpenTask,
  onStatusChange,
  t,
  task,
  testId,
}: {
  draggable?: boolean
  isDragging?: boolean
  isMoving?: boolean
  onDragEnd?: () => void
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onOpenTask?: (task: ProjectTask) => void
  onStatusChange?: (status: TaskStatus) => void
  t: (key: MessageKey) => string
  task: ProjectTask
  testId?: string
}) {
  const taskTitle = workspacePresentation.resolveTaskTitle(task, t)
  const statusSelectLabel = t('workspace.myTasks.moveStatusLabel').replace(
    '{title}',
    taskTitle,
  )

  return (
    <article
      aria-grabbed={isDragging || undefined}
      className={`rounded-lg border border-slate-200 bg-white p-4 transition ${
        draggable ? 'cursor-grab hover:border-[#99d7cf] hover:shadow-[0_1px_2px_rgba(23,32,29,0.06)] active:cursor-grabbing' : ''
      } ${isDragging ? 'opacity-50 ring-2 ring-[#99d7cf]' : ''} ${isMoving ? 'opacity-70' : ''}`}
      data-testid={testId}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      {onOpenTask ? (
        <button
          className="w-full text-left text-sm font-semibold leading-6 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)] disabled:hover:text-[var(--workbench-text)]"
          data-testid={testId ? `${testId}-open` : undefined}
          disabled={!workspacePresentation.isOpenableWorkspaceTask(task)}
          onClick={() => onOpenTask(task)}
          type="button"
        >
          {taskTitle}
        </button>
      ) : (
        <p className="text-sm font-semibold leading-6 text-[var(--workbench-text)]">{taskTitle}</p>
      )}
      <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{task.dueDate}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill status={task.status} t={t} />
        <PriorityPill priority={task.priority} t={t} />
      </div>
      {onStatusChange ? (
        <select
          aria-label={statusSelectLabel}
          className="workbench-input mt-3 h-9 w-full px-3 text-xs disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
          data-testid={testId ? `${testId}-status-select` : undefined}
          disabled={isMoving}
          value={task.status}
          onChange={(event) => {
            const nextStatus = workspacePresentation.readMyTaskKanbanStatus(event.target.value)

            if (nextStatus) {
              onStatusChange(nextStatus)
            }
          }}
        >
          {myTaskKanbanStatuses.map((status) => (
            <option key={status} value={status}>
              {t(`tasks.status.${status}`)}
            </option>
          ))}
        </select>
      ) : null}
    </article>
  )
}

function StatusPill({ status, t }: { status: TaskStatus; t: (key: MessageKey) => string }) {
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

function PriorityPill({ priority, t }: { priority: TaskPriority; t: (key: MessageKey) => string }) {
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

/**
 * 集計値を百分率で示す進捗バーの props です。
 */
type ProgressBarProps = {
  /**
   * 進捗バーが表す対象のアクセシブルネームです。
   */
  label: string
  /**
   * 0 から 100 の範囲へ補正して表示する進捗値です。
   */
  value: number
}

/**
 * 集計値を百分率で示す進捗バーを描画します。
 */
export function ProgressBar({ label, value }: ProgressBarProps) {
  const normalizedValue = Math.max(0, Math.min(100, value))

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={normalizedValue}
      aria-valuetext={`${normalizedValue}%`}
      className="h-2 overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
    >
      <div
        aria-hidden="true"
        className="h-full rounded-full bg-[var(--workbench-primary)]"
        style={{ width: `${normalizedValue}%` }}
      />
    </div>
  )
}

/**
 * 設定項目などの説明カードをグリッド表示します。
 */
export function InfoGrid({
  items,
  t,
}: {
  items: Array<[MessageKey, MessageKey]>
  t: (key: MessageKey) => string
}) {
  return (
    <div className="grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
      {items.map(([titleKey, descriptionKey]) => (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)]" key={titleKey}>
          <h2 className="text-lg font-semibold text-[#0d1833]">{t(titleKey)}</h2>
          <p className="mt-3 text-sm font-bold leading-6 text-[#526381]">{t(descriptionKey)}</p>
        </section>
      ))}
    </div>
  )
}
