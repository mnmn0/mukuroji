import type {
  ResolvedWorkItemConfiguration,
  WorkItemConfiguration,
  WorkItemPatch,
} from '@mukuroji/contracts'
import { useState, type DragEvent } from 'react'
import type { ProjectTask } from '../api/tasks'
import type { ProjectMember } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkItemPersonOption } from '../../work-items/ui/WorkItemFieldsEditor'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../work-items/model/workItemDisplay'
import {
  createProjectStatusTestToken,
  createTaskKey,
  isTaskInProjectStatusColumn,
  resolveProjectTaskConfiguration,
  resolveTaskPriority,
  taskPriorities,
  type TaskCreateContext,
  type ProjectTaskStatusColumn,
} from '../model/taskView'
import {
  resolveEditableWorkflowStatuses,
  resolveWorkItemWorkflowStatusLabel,
} from '../../work-items/model/workItemDisplay'
import { TaskInlineField } from './TaskInlineField'
import { TaskInlineCustomFields } from './TaskInlineCustomFields'
import {
  TaskCustomFieldSummary,
  TaskPriorityBadge,
  TaskStatusBadge,
  TaskViewHeading,
} from './TaskViewPrimitives'

/** Resolves a localized task-board message. */
type TaskBoardTranslator = (key: MessageKey) => string

/** Props for the independent project task board view. */
export type TaskBoardViewProps = {
  /** Active Project members available to inline assignee editors. */
  assigneeOptions?: ProjectMember[]
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team identifiers whose configurations could not be loaded. */
  configurationFailedTeamIds: string[]
  /** Team-scoped resolved configurations used by columns and cards. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Locale used to format custom-field values. */
  locale: Locale
  /** Mapping from person identifiers to display names. */
  personLabels: Readonly<Record<string, string>>
  /** Person options available to custom-field editors. */
  personOptions?: WorkItemPersonOption[]
  /** Project receiving contextual Board creates. */
  projectId?: string
  /** Composite key of the task selected in the detail pane. */
  selectedDetailTaskKey?: string
  /** Team-scoped workflow columns displayed by the board. */
  statusColumns: ProjectTaskStatusColumn[]
  /** Filtered tasks displayed by the board. */
  tasks: ProjectTask[]
  /** Translator used for board labels. */
  t: TaskBoardTranslator
  /** Selects a task for the detail pane. */
  onSelectTask: (task: ProjectTask) => void
  /** Opens the create panel with Board-column context. */
  onCreateTaskOpen?: (context?: TaskCreateContext) => void
  /** Updates or moves a task through the shared Work Item action. */
  onUpdateTask?: (task: ProjectTask, input: WorkItemPatch) => Promise<ProjectTask>
}

/**
 * Renders project tasks in team-scoped workflow columns.
 *
 * @param props - Board tasks, status columns, configuration state, and selection callback.
 * @returns The independent project task board view.
 */
export function TaskBoardView({
  assigneeOptions = [],
  configuration,
  configurationsByTeam,
  configurationFailedTeamIds,
  locale,
  personLabels,
  personOptions = [],
  projectId,
  selectedDetailTaskKey,
  onCreateTaskOpen,
  onSelectTask,
  onUpdateTask,
  t,
  tasks,
  statusColumns,
}: TaskBoardViewProps) {
  const [draggedTaskKey, setDraggedTaskKey] = useState<string>()
  const [dropTargetColumnKey, setDropTargetColumnKey] = useState<string>()
  const [movingTaskKeys, setMovingTaskKeys] = useState<ReadonlySet<string>>(() => new Set())
  const unavailableTasks = tasks.filter((task) =>
    configurationFailedTeamIds.includes(task.teamId),
  )
  /** Validates and sends a status transition for one project task. */
  const moveTaskToStatus = async (task: ProjectTask, workflowStatusId: string) => {
    if (!onUpdateTask || task.workflowStatusId === workflowStatusId) {
      return
    }

    const taskConfiguration = resolveProjectTaskConfiguration(task, configurationsByTeam, configuration)
    const editableStatuses = resolveEditableWorkflowStatuses(task, taskConfiguration)

    if (!editableStatuses.some((status) => status.id === workflowStatusId)) {
      return
    }

    const taskKey = createTaskKey(task)
    setMovingTaskKeys((currentKeys) => new Set(currentKeys).add(taskKey))
    setDraggedTaskKey(undefined)
    setDropTargetColumnKey(undefined)
    try {
      await onUpdateTask(task, { workflowStatusId })
    } finally {
      setMovingTaskKeys((currentKeys) => {
        const nextKeys = new Set(currentKeys)
        nextKeys.delete(taskKey)
        return nextKeys
      })
    }
  }

  /** Starts a native drag interaction carrying the task's composite key. */
  const handleDragStart = (event: DragEvent<HTMLElement>, task: ProjectTask) => {
    if (!onUpdateTask) {
      return
    }

    const taskKey = createTaskKey(task)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-mukuroji-task-key', taskKey)
    event.dataTransfer.setData('text/plain', taskKey)
    setDraggedTaskKey(taskKey)
  }

  /** Resolves a dropped task and requests the destination column transition. */
  const handleDrop = (event: DragEvent<HTMLElement>, column: ProjectTaskStatusColumn) => {
    event.preventDefault()
    const taskKey = event.dataTransfer.getData('application/x-mukuroji-task-key') ||
      event.dataTransfer.getData('text/plain') ||
      draggedTaskKey
    const task = taskKey ? tasks.find((candidate) => createTaskKey(candidate) === taskKey) : undefined

    setDraggedTaskKey(undefined)
    setDropTargetColumnKey(undefined)

    if (task && task.teamId === column.teamId) {
      void moveTaskToStatus(task, column.status.id).catch(() => undefined)
    }
  }

  return (
    <section
      aria-label={t('tasks.view.board')}
      className="mt-3 grid min-w-0 gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))' }}
    >
      <TaskViewHeading
        className="col-span-full"
        count={tasks.length}
        t={t}
        titleKey="tasks.view.board"
      />
      {statusColumns.map((column) => {
        const statusTasks = tasks.filter((task) => isTaskInProjectStatusColumn(task, column))
        const columnConfiguration = configurationsByTeam[column.teamId]?.configuration ?? configuration

        return (
          <div
            className={`workbench-panel min-h-[420px] transition ${
              dropTargetColumnKey === column.key
                ? 'border-[#99d7cf] bg-[#e5f7f4] ring-2 ring-[#99d7cf]/40'
                : ''
            }`}
            data-testid={`project-task-column-${createProjectStatusTestToken(column.key)}`}
            key={column.key}
            onDragLeave={() => setDropTargetColumnKey(undefined)}
            onDragOver={(event) => {
              const draggedTask = draggedTaskKey
                ? tasks.find((candidate) => createTaskKey(candidate) === draggedTaskKey)
                : undefined

              if (!onUpdateTask || !draggedTask || draggedTask.teamId !== column.teamId) {
                return
              }

              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropTargetColumnKey(column.key)
            }}
            onDrop={(event) => handleDrop(event, column)}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5">
              <span className="grid gap-0.5">
                <TaskStatusBadge configuration={columnConfiguration} status={column.status} />
                <span className="text-[11px] font-semibold text-[var(--workbench-muted)]">
                  {column.label}
                </span>
              </span>
              <div className="flex items-center gap-2">
                {onCreateTaskOpen ? (
                  <button
                    aria-label={`${t('tasks.board.addInColumn')}: ${column.label}`}
                    className="rounded px-1.5 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-white"
                    data-testid={`project-task-add-${createProjectStatusTestToken(column.key)}`}
                    onClick={() => onCreateTaskOpen({
                      projectId: projectId ?? tasks[0]?.assignedProjectId ?? '',
                      source: 'board',
                      teamId: column.teamId,
                      workflowStatusId: column.status.id,
                    })}
                    type="button"
                  >
                    +
                  </button>
                ) : null}
                <span className="text-sm font-semibold text-[#5f6874]">
                  {t('tasks.board.columnCount').replace('{count}', String(statusTasks.length))}
                </span>
              </div>
            </div>
            <div className="grid gap-2 p-2.5">
              {statusTasks.length > 0 ? (
                statusTasks.map((task) => {
                  const taskKey = createTaskKey(task)
                  const taskConfiguration = resolveProjectTaskConfiguration(
                    task,
                    configurationsByTeam,
                    configuration,
                  )
                  const editableStatuses = resolveEditableWorkflowStatuses(task, taskConfiguration)
                  const isMoving = movingTaskKeys.has(taskKey)
                  const memberOptions = assigneeOptions.map((member) => ({
                    label: `${member.name ?? member.email} / ${member.email}`,
                    value: member.id,
                  }))
                  const inlineAssigneeOptions = task.assigneeUserId &&
                    !memberOptions.some((option) => option.value === task.assigneeUserId)
                    ? [
                        { label: resolveWorkItemAssignee(task), value: task.assigneeUserId },
                        ...memberOptions,
                      ]
                    : task.assigneeUserId
                      ? memberOptions
                      : [
                          { label: t('tasks.detail.unassigned'), value: '' },
                          ...memberOptions,
                        ]

                  return (
                    <article
                      aria-grabbed={draggedTaskKey === taskKey || undefined}
                      className={`rounded-md border p-3 text-left transition ${
                        selectedDetailTaskKey === taskKey
                          ? 'border-[#99d7cf] bg-[#e5f7f4] shadow-[inset_3px_0_0_var(--workbench-primary)]'
                          : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                      } ${draggedTaskKey === taskKey ? 'opacity-50 ring-2 ring-[#99d7cf]' : ''} ${isMoving ? 'opacity-70' : ''}`}
                      data-testid={`project-task-card-${task.id}`}
                      draggable={Boolean(onUpdateTask) && !isMoving}
                      key={taskKey}
                      onDragEnd={() => {
                        setDraggedTaskKey(undefined)
                        setDropTargetColumnKey(undefined)
                      }}
                      onDragStart={(event) => handleDragStart(event, task)}
                    >
                      <div className="flex items-start gap-2">
                        {onUpdateTask ? (
                          <TaskInlineField
                            ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.name')}`}
                            displayValue={resolveWorkItemTitle(task)}
                            testId={`task-inline-title-${task.id}`}
                            value={resolveWorkItemTitle(task)}
                            onCommit={(value) => onUpdateTask(task, { title: value }).then(() => undefined)}
                          />
                        ) : (
                          <button
                            className="min-w-0 flex-1 text-left text-sm font-semibold leading-5 text-[#1c1d1f] hover:text-[var(--workbench-primary)]"
                            onClick={() => onSelectTask(task)}
                            type="button"
                          >
                            {resolveWorkItemTitle(task)}
                          </button>
                        )}
                        {onUpdateTask ? (
                          <button
                            aria-label={resolveWorkItemTitle(task)}
                            className="rounded px-1 text-xs text-[var(--workbench-muted)] hover:bg-white hover:text-[var(--workbench-primary)]"
                            onClick={() => onSelectTask(task)}
                            type="button"
                          >
                            ↗
                          </button>
                        ) : null}
                      </div>
                      {onUpdateTask && editableStatuses.length > 0 ? (
                        <TaskInlineField
                          ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.status')}`}
                          displayValue={resolveWorkItemWorkflowStatusLabel(task, taskConfiguration)}
                          kind="select"
                          options={editableStatuses.map((status) => ({
                            label: status.name,
                            value: status.id,
                          }))}
                          testId={`task-inline-status-${task.id}`}
                          value={task.workflowStatusId}
                          onCommit={(value) => moveTaskToStatus(task, value)}
                        />
                      ) : null}
                      {onUpdateTask && inlineAssigneeOptions.length > 0 ? (
                        <TaskInlineField
                          ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.assignee')}`}
                          displayValue={resolveWorkItemAssignee(task)}
                          kind="select"
                          options={inlineAssigneeOptions}
                          testId={`task-inline-assignee-${task.id}`}
                          value={task.assigneeUserId}
                          onCommit={(value) => onUpdateTask(task, { assigneeUserId: value }).then(() => undefined)}
                        />
                      ) : (
                        <p className="mt-2 truncate text-xs font-medium text-[#5f6874]">
                          {resolveWorkItemAssignee(task)}
                        </p>
                      )}
                      {onUpdateTask ? (
                        <TaskInlineCustomFields
                          configuration={taskConfiguration}
                          locale={locale}
                          onUpdateTask={onUpdateTask}
                          personLabels={personLabels}
                          personOptions={personOptions}
                          t={t}
                          task={task}
                        />
                      ) : (
                        <TaskCustomFieldSummary
                          configuration={taskConfiguration}
                          locale={locale}
                          personLabels={personLabels}
                          t={t}
                          task={task}
                        />
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {onUpdateTask ? (
                          <TaskInlineField
                            ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.priority')}`}
                            displayValue={t(`tasks.priority.${task.priority}`)}
                            kind="select"
                            options={taskPriorities.map((priority) => ({
                              label: t(`tasks.priority.${priority}`),
                              value: priority,
                            }))}
                            testId={`task-inline-priority-${task.id}`}
                            value={task.priority}
                            onCommit={(value) => onUpdateTask(task, { priority: resolveTaskPriority(value) }).then(() => undefined)}
                          />
                        ) : <TaskPriorityBadge priority={task.priority} t={t} />}
                        {onUpdateTask ? (
                          <TaskInlineField
                            ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.dueDate')}`}
                            displayValue={task.dueDate || t('tasks.calendar.empty')}
                            kind="date"
                            testId={`task-inline-due-date-${task.id}`}
                            value={task.dueDate.replaceAll('/', '-')}
                            onCommit={(value) => onUpdateTask(task, { dueDate: value.replaceAll('-', '/') }).then(() => undefined)}
                          />
                        ) : (
                          <span className="text-xs font-semibold text-[#5f6874]">{task.dueDate}</span>
                        )}
                      </div>
                      <p className="mt-2 text-[11px] font-medium text-[var(--workbench-muted)]">
                        {t('tasks.board.dragHint')}
                      </p>
                    </article>
                  )
                })
              ) : (
                <p className="rounded-md border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
                  {t('tasks.board.empty')}
                </p>
              )}
            </div>
          </div>
        )
      })}
      {unavailableTasks.length > 0 ? (
        <div
          className="workbench-panel min-h-[420px] border-red-200"
          data-testid="project-task-configuration-unavailable-column"
        >
          <div className="border-b border-red-200 bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700">
            {t('workItems.configuration.loadError')}
          </div>
          <div className="grid gap-2 p-2.5">
            {unavailableTasks.map((task) => (
              <button
                className="rounded-md border border-red-100 bg-white p-3 text-left transition hover:border-red-200"
                key={createTaskKey(task)}
                onClick={() => onSelectTask(task)}
                type="button"
              >
                <p className="text-sm font-semibold leading-5 text-[var(--workbench-text)]">
                  {resolveWorkItemTitle(task)}
                </p>
                <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">
                  {resolveWorkItemAssignee(task)} · {task.workflowStatusId}
                </p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
