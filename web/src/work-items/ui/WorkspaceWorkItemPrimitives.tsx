/* eslint-disable react-refresh/only-export-components -- Work Item test ID helpers share this component module. */
import type {
  WorkflowStatusDefinition,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { DragEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ProjectTask, TaskPriority } from '../../tasks/api'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
  resolveWorkItemWorkflowStatusId,
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
} from '../model/workItemDisplay'
import { isOpenableWorkspaceTask } from '../model/workspaceWorkItems'

/**
 * Props for a Work Item row in a Workspace action list.
 */
export type TaskListRowProps = {
  /** Resolved Work Item configuration used to label the current status. */
  configuration?: WorkItemConfiguration
  /** Optional callback that opens the selected Work Item. */
  onOpenTask?: (task: ProjectTask) => void
  /** Translator used for Workspace labels. */
  t: (key: MessageKey) => string
  /** Work Item displayed by the row. */
  task: ProjectTask
}

/**
 * Renders an actionable Work Item row with status and due date details.
 *
 * @param props - Work Item display data and optional open action.
 * @returns A button row for the supplied Work Item.
 */
export function TaskListRow({
  configuration,
  onOpenTask,
  t,
  task,
}: TaskListRowProps) {
  const canOpenTask = Boolean(onOpenTask) && isOpenableWorkspaceTask(task)

  return (
    <button
      className="grid w-full grid-cols-[1fr_140px_110px_96px] items-center gap-4 p-5 text-left text-sm font-medium transition hover:bg-[var(--workbench-surface-muted)] disabled:hover:bg-transparent max-[900px]:grid-cols-1"
      disabled={!canOpenTask}
      onClick={() => onOpenTask?.(task)}
      type="button"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">
          {resolveWorkItemTitle(task)}
        </p>
        <p className="mt-1 text-[var(--workbench-muted)]">{resolveWorkItemAssignee(task)}</p>
      </div>
      <StatusPill configuration={configuration} task={task} />
      <span className="text-[var(--workbench-muted)]">{task.dueDate}</span>
      <span className="workbench-badge justify-self-end max-[900px]:justify-self-start">
        {t('workspace.action.openTask')}
      </span>
    </button>
  )
}

/**
 * Props for a compact Workspace Work Item card.
 */
export type CompactTaskCardProps = {
  /** Resolved Work Item configuration used to label the current status. */
  configuration?: WorkItemConfiguration
  /** Whether native drag interactions are enabled for the card. */
  draggable?: boolean
  /** Whether the card is currently being dragged. */
  isDragging?: boolean
  /** Whether a status mutation is currently pending for the Work Item. */
  isMoving?: boolean
  /** Optional callback invoked when a native drag interaction ends. */
  onDragEnd?: () => void
  /** Optional callback invoked when a native drag interaction starts. */
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  /** Optional callback that opens the selected Work Item. */
  onOpenTask?: (task: ProjectTask) => void
  /** Optional callback that requests a workflow status change. */
  onStatusChange?: (workflowStatusId: string) => void
  /** Translator used for Workspace and priority labels. */
  t: (key: MessageKey) => string
  /** Work Item displayed by the card. */
  task: ProjectTask
  /** Optional test identifier for the card and its interactive controls. */
  testId?: string
  /** Workflow statuses available in the card's status selector. */
  workflowStatuses?: readonly WorkflowStatusDefinition[]
}

/**
 * Renders a compact draggable Work Item card for Workspace boards.
 *
 * @param props - Work Item details, drag state, and available actions.
 * @returns A compact Work Item card.
 */
export function CompactTaskCard({
  configuration,
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
  workflowStatuses = [],
}: CompactTaskCardProps) {
  const taskTitle = resolveWorkItemTitle(task)
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
          disabled={!isOpenableWorkspaceTask(task)}
          onClick={() => onOpenTask(task)}
          type="button"
        >
          {taskTitle}
        </button>
      ) : (
        <p className="text-sm font-semibold leading-6 text-[var(--workbench-text)]">{taskTitle}</p>
      )}
      <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {task.dueDate}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill configuration={configuration} task={task} />
        <PriorityPill priority={task.priority} t={t} />
      </div>
      {onStatusChange ? (
        <select
          aria-label={statusSelectLabel}
          className="workbench-input mt-3 h-9 w-full px-3 text-xs disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
          data-testid={testId ? `${testId}-status-select` : undefined}
          disabled={isMoving}
          value={resolveWorkItemWorkflowStatusId(task)}
          onChange={(event) => {
            const nextStatus = workflowStatuses.find(
              (status) => status.id === event.target.value,
            )

            if (nextStatus) {
              onStatusChange(nextStatus.id)
            }
          }}
        >
          {workflowStatuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      ) : null}
    </article>
  )
}

/**
 * Props for a Work Item workflow status pill.
 */
export type StatusPillProps = {
  /** Resolved Work Item configuration used to label the current status. */
  configuration?: WorkItemConfiguration
  /** Work Item whose workflow status is displayed. */
  task: ProjectTask
}

/**
 * Renders a category-colored Work Item workflow status label.
 *
 * @param props - Work Item and optional resolved configuration.
 * @returns A workflow status pill.
 */
export function StatusPill({ configuration, task }: StatusPillProps) {
  return (
    <span className={resolveWorkflowCategoryToneClassName(resolveWorkflowStatusCategory(task))}>
      {resolveWorkItemWorkflowStatusLabel(task, configuration)}
    </span>
  )
}

/**
 * Props for a Work Item priority pill.
 */
export type PriorityPillProps = {
  /** Work Item priority represented by the pill. */
  priority: TaskPriority
  /** Translator used for the priority label. */
  t: (key: MessageKey) => string
}

/**
 * Renders a tone-coded Work Item priority label.
 *
 * @param props - Priority value and translator.
 * @returns A priority pill.
 */
export function PriorityPill({ priority, t }: PriorityPillProps) {
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
 * Converts an arbitrary identifier into a stable lowercase test token.
 *
 * @param value - Identifier to normalize for a test ID.
 * @returns A lowercase token containing only alphanumeric characters and hyphens.
 */
export function createWorkspaceTaskTestToken(value: string) {
  return value.replaceAll(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

/**
 * Creates the stable card test ID segment for a Workspace Work Item.
 *
 * @param task - Work Item whose test ID segment is required.
 * @returns A normalized Project and Work Item identifier.
 */
export function createWorkspaceTaskTestId(task: ProjectTask) {
  return createWorkspaceTaskTestToken(`${task.assignedProjectId ?? 'unassigned'}:${task.id}`)
}
