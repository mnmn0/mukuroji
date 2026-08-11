/* eslint-disable react-refresh/only-export-components -- Work Item test ID helpers share this component module. */
import type {
  WorkflowStatusDefinition,
  WorkItemConfiguration,
  TaskViewDensity,
} from '@mukuroji/contracts'
import { useRef, type DragEvent } from 'react'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { MoreHorizontalIcon } from '../../shared/ui/icons'
import type { ViewportAnchorPoint } from '../../shared/lib/viewportAnchor'
import type { ProjectTask, TaskPriority } from '../../tasks/api'
import {
  formatCustomFieldValue,
  isCustomFieldApplicable,
  sortCustomFieldDefinitions,
} from '../model/customFields'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
  resolveWorkItemWorkflowStatusId,
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
} from '../model/workItemDisplay'
import { isOpenableWorkspaceTask } from '../model/workspaceWorkItems'
import { WorkItemAssigneeAvatar } from './WorkItemAssigneeAvatar'

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
  /** Whether the card currently owns task-view keyboard focus. */
  focused?: boolean
  /** Whether the card is currently being dragged. */
  isDragging?: boolean
  /** Whether a status mutation is currently pending for the Work Item. */
  isMoving?: boolean
  /** Locale used to format typed custom-field values. */
  locale?: Locale
  /** Optional callback invoked when a native drag interaction ends. */
  onDragEnd?: () => void
  /** Optional callback invoked when a native drag interaction starts. */
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  /** Row spacing selected by the effective task view. */
  density?: TaskViewDensity
  /** Opens the responsive canonical action menu for this Work Item. */
  onOpenActionMenu?: (
    anchorPoint: ViewportAnchorPoint,
    returnFocusElement: HTMLElement,
  ) => void
  /** Optional callback that opens the selected Work Item. */
  onOpenTask?: (task: ProjectTask) => void
  /** Optional callback that requests a workflow status change. */
  onStatusChange?: (workflowStatusId: string) => void
  /** Cancels a revealed canonical status action when its selector loses focus unchanged. */
  onStatusActionCancel?: () => void
  /** Translator used for Workspace and priority labels. */
  t: (key: MessageKey) => string
  /** Work Item displayed by the card. */
  task: ProjectTask
  /** Team-qualified key used to resolve this card from a canonical action target. */
  taskViewItemKey?: string
  /** Optional test identifier for the card and its interactive controls. */
  testId?: string
  /** Visible Project label shown when the Project field is enabled. */
  projectLabel?: string
  /** Visible Team label shown when the Team field is enabled. */
  teamLabel?: string
  /** Person identities mapped to labels for person custom fields. */
  personLabels?: Readonly<Record<string, string>>
  /** Whether the canonical Move entrance reveals the status selector outside visible columns. */
  revealStatusControl?: boolean
  /** Whether an assignee initial is rendered beside the assignee label. */
  showAssigneeAvatar?: boolean
  /** Whether the Work Item is selected through the shared task-view reducer. */
  selected?: boolean
  /** Fields whose metadata remains visible on the card. */
  visibleFields?: readonly string[]
  /** Whether long Work Item titles may wrap instead of truncating. */
  wrapText?: boolean
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
  density = 'comfortable',
  draggable = false,
  focused = false,
  isDragging = false,
  isMoving = false,
  locale = 'ja',
  onDragEnd,
  onDragStart,
  onOpenActionMenu,
  onOpenTask,
  onStatusActionCancel,
  onStatusChange,
  t,
  task,
  taskViewItemKey,
  testId,
  projectLabel,
  teamLabel,
  personLabels = {},
  revealStatusControl = false,
  showAssigneeAvatar = false,
  selected = false,
  visibleFields = ['title', 'status', 'dueDate', 'priority'],
  wrapText = false,
  workflowStatuses = [],
}: CompactTaskCardProps) {
  const statusActionCommittedRef = useRef(false)
  const taskTitle = resolveWorkItemTitle(task)
  const statusSelectLabel = t('workspace.myTasks.moveStatusLabel').replace(
    '{title}',
    taskTitle,
  )
  const cardPadding = density === 'compact'
    ? 'p-2.5'
    : density === 'spacious'
      ? 'p-5'
      : 'p-4'
  const customFieldEntries = configuration
    ? sortCustomFieldDefinitions(configuration.customFields).flatMap((definition) => {
        const value = task.customFieldValues[definition.id]
        if (value === undefined || !isCustomFieldApplicable(definition, task.assignedProjectId)) {
          return []
        }
        return [{
          id: definition.id,
          label: definition.name,
          value: formatCustomFieldValue(definition, value, {
            durationUnitLabels: {
              days: t('workItems.durationUnit.days'),
              hours: t('workItems.durationUnit.hours'),
              minutes: t('workItems.durationUnit.minutes'),
            },
            falseLabel: t('workItems.fields.booleanFalse'),
            locale,
            personLabels,
            trueLabel: t('workItems.fields.booleanTrue'),
          }),
        }]
      })
    : []
  const customFieldEntriesById = new Map(customFieldEntries.map((entry) => [entry.id, entry]))
  const selectedCustomFieldEntries = visibleFields.flatMap((field) => {
    if (!field.startsWith('custom:')) return []
    const fieldId = field.slice('custom:'.length)
    return [customFieldEntriesById.get(fieldId) ?? {
      id: fieldId,
      label: configuration?.customFields.find((definition) => definition.id === fieldId)?.name ?? fieldId,
      value: '—',
    }]
  })

  return (
    <article
      aria-current={focused || undefined}
      aria-grabbed={isDragging || undefined}
      className={`min-w-0 w-full rounded-lg border border-slate-200 ${
        selected ? 'bg-blue-50/70' : 'bg-white'
      } ${cardPadding} transition ${
        draggable ? 'cursor-grab hover:border-[#99d7cf] hover:shadow-[0_1px_2px_rgba(23,32,29,0.06)] active:cursor-grabbing' : ''
      } ${focused ? 'ring-2 ring-blue-500/40' : ''} ${
        isDragging ? 'opacity-50 ring-2 ring-[#99d7cf]' : ''
      } ${isMoving ? 'opacity-70' : ''}`}
      data-task-view-focused={focused ? 'true' : 'false'}
      data-task-view-item-key={taskViewItemKey}
      data-task-view-selected={selected ? 'true' : 'false'}
      data-testid={testId}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      onContextMenu={(event) => {
        if (!onOpenActionMenu) return
        event.preventDefault()
        onOpenActionMenu(
          { x: event.clientX, y: event.clientY },
          event.currentTarget,
        )
      }}
      tabIndex={onOpenActionMenu ? -1 : undefined}
    >
      {selected ? <span className="sr-only">{t('tasks.row.selected')}</span> : null}
      <div className="flex min-w-0 items-start gap-2">
        {onOpenTask ? (
          <button
            className={`min-w-0 flex-1 text-left text-sm font-semibold leading-6 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)] disabled:hover:text-[var(--workbench-text)] ${
              wrapText ? 'whitespace-normal break-words' : 'truncate'
            }`}
            data-testid={testId ? `${testId}-open` : undefined}
            disabled={!isOpenableWorkspaceTask(task)}
            onClick={() => onOpenTask(task)}
            type="button"
          >
            {taskTitle}
          </button>
        ) : (
          <p className={`min-w-0 flex-1 text-sm font-semibold leading-6 text-[var(--workbench-text)] ${
            wrapText ? 'whitespace-normal break-words' : 'truncate'
          }`}>{taskTitle}</p>
        )}
        {onOpenActionMenu ? (
          <button
            aria-label={`${t('tasks.action.more')}: ${taskTitle}`}
            className="grid h-9 w-9 flex-none place-items-center rounded text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] max-[640px]:h-11 max-[640px]:w-11"
            data-testid={testId ? `${testId}-actions` : undefined}
            onClick={(event) => {
              const returnFocusElement = event.currentTarget
              const bounds = returnFocusElement.getBoundingClientRect()
              onOpenActionMenu(
                { x: bounds.right, y: bounds.bottom },
                returnFocusElement,
              )
            }}
            type="button"
          >
            <MoreHorizontalIcon className="h-5 w-5" />
          </button>
        ) : null}
      </div>
      {visibleFields.includes('assignee') ? (
        <div className="mt-2 flex min-w-0 items-center gap-2 text-xs font-medium text-[var(--workbench-muted)]">
          {showAssigneeAvatar ? (
            <WorkItemAssigneeAvatar label={resolveWorkItemAssignee(task)} />
          ) : null}
          <span className="truncate">{resolveWorkItemAssignee(task)}</span>
        </div>
      ) : null}
      {visibleFields.includes('dueDate') ? (
        <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {task.dueDate}
        </p>
      ) : null}
      {visibleFields.includes('status') || visibleFields.includes('priority') ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {visibleFields.includes('status') ? <StatusPill configuration={configuration} task={task} /> : null}
          {visibleFields.includes('priority') ? <PriorityPill priority={task.priority} t={t} /> : null}
        </div>
      ) : null}
      {visibleFields.includes('project') && projectLabel ? (
        <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{projectLabel}</p>
      ) : null}
      {visibleFields.includes('team') && teamLabel ? (
        <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">{teamLabel}</p>
      ) : null}
      {visibleFields.includes('customFields') && customFieldEntries.length > 0 ? (
        <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
          {customFieldEntries.slice(0, 2).map((entry) => (
            <span
              className="workbench-badge max-w-full truncate"
              key={entry.id}
              title={`${entry.label}: ${entry.value}`}
            >
              {entry.label}: {entry.value}
            </span>
          ))}
          {customFieldEntries.length > 2 ? (
            <span className="workbench-badge">+{customFieldEntries.length - 2}</span>
          ) : null}
        </div>
      ) : null}
      {selectedCustomFieldEntries.length > 0 ? (
        <dl className="mt-3 grid gap-1.5 text-xs text-[var(--workbench-muted)]">
          {selectedCustomFieldEntries.map((entry) => (
            <div className="flex min-w-0 items-baseline justify-between gap-2" key={entry.id}>
              <dt className="truncate font-semibold">{entry.label}</dt>
              <dd className={wrapText ? 'break-words text-right' : 'truncate text-right'}>
                {entry.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {(visibleFields.includes('status') || revealStatusControl) && onStatusChange ? (
        <select
          aria-label={statusSelectLabel}
          className="workbench-input mt-3 h-9 w-full px-3 text-xs disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
          data-testid={testId ? `${testId}-status-select` : undefined}
          disabled={isMoving}
          onBlur={() => {
            if (!statusActionCommittedRef.current) onStatusActionCancel?.()
            statusActionCommittedRef.current = false
          }}
          value={resolveWorkItemWorkflowStatusId(task)}
          onChange={(event) => {
            const nextStatus = workflowStatuses.find(
              (status) => status.id === event.target.value,
            )

            if (nextStatus) {
              statusActionCommittedRef.current = true
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
