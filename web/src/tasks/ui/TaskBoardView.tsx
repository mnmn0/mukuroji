import {
  DEFAULT_WORK_ITEM_TYPE_ID,
  type ResolvedWorkItemConfiguration,
  type WorkItemConfiguration,
  type WorkItemPatch,
} from '@mukuroji/contracts'
import { Fragment, useState, type DragEvent } from 'react'
import type { CanonicalWorkItem } from '../api/tasks'
import type { ProjectMember } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { MoreHorizontalIcon } from '../../shared/ui/icons'
import type { WorkItemPersonOption } from '../../work-items/ui/WorkItemFieldsEditor'
import {
  groupTaskViewItems,
  type TaskViewGroupValue,
  type TaskViewPresentationSettings,
} from '../../task-views/model/taskViewPresentation'
import {
  resolveWorkItemDependencySummary,
  type WorkItemDependencySummary,
} from '../../work-items/model/workItemDependencies'
import { WorkItemDependencyChips } from '../../work-items/ui/WorkItemDependencyChips'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
  resolveWorkItemTypeDefinition,
  resolveWorkItemTypeLabel,
} from '../../work-items/model/workItemDisplay'
import {
  createProjectStatusTestToken,
  createTaskKey,
  isTaskInProjectStatusColumn,
  resolveProjectTaskConfiguration,
  resolveTaskCustomFieldEntries,
  resolveTaskPriority,
  taskPriorities,
  type TaskCreateContext,
  type ProjectTaskStatusColumn,
} from '../model/taskView'
import {
  formatTaskScheduleRange,
  replaceTaskDeadlineSchedule,
  resolveTaskSchedule,
  taskScheduleModeLabelKeys,
} from '../model/taskSchedule'
import {
  resolveEditableWorkflowStatuses,
  resolveWorkItemWorkflowStatusLabel,
} from '../../work-items/model/workItemDisplay'
import { TaskInlineField } from './TaskInlineField'
import { TaskInlineCustomFields } from './TaskInlineCustomFields'
import { WorkItemAssigneeAvatar } from '../../work-items/ui/WorkItemAssigneeAvatar'
import {
  TaskCustomFieldSummary,
  TaskPriorityBadge,
  TaskStatusBadge,
  TaskViewHeading,
  TaskWorkItemTypeBadge,
} from './TaskViewPrimitives'
import type { ProjectTaskActionMenuOpenHandler } from './projectTaskActionMenu'

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
  /** Checks exact Team-qualified Project write scope for one concrete Work Item. */
  canMutateTask?: (task: CanonicalWorkItem) => boolean
  /** Team-scoped resolved configurations used by columns and cards. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Locale used to format custom-field values. */
  locale: Locale
  /** Dependency summaries keyed by canonical Team/Work Item identity. */
  dependencySummaries?: Readonly<Record<string, WorkItemDependencySummary>>
  /** Mapping from person identifiers to display names. */
  personLabels: Readonly<Record<string, string>>
  /** Visible card fields, density, wrapping, and grouping selected by the effective view. */
  presentation?: TaskViewPresentationSettings
  /** Person options available to custom-field editors. */
  personOptions?: WorkItemPersonOption[]
  /** Project receiving contextual Board creates. */
  projectId?: string
  /** Composite key of the task selected in the detail pane. */
  selectedDetailTaskKey?: string
  /** Team-scoped workflow columns displayed by the board. */
  statusColumns: ProjectTaskStatusColumn[]
  /** Filtered tasks displayed by the board. */
  tasks: CanonicalWorkItem[]
  /** Translator used for board labels. */
  t: TaskBoardTranslator
  /** Selects a task for the detail pane. */
  onSelectTask: (task: CanonicalWorkItem) => void
  /** Opens the canonical action menu for one rendered card. */
  onTaskActionMenuOpen?: ProjectTaskActionMenuOpenHandler
  /** Opens the create panel with Board-column context. */
  onCreateTaskOpen?: (context?: TaskCreateContext) => void
  /** Updates or moves a task through the shared Work Item action. */
  onUpdateTask?: (task: CanonicalWorkItem, input: WorkItemPatch) => Promise<CanonicalWorkItem>
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
  canMutateTask,
  dependencySummaries = {},
  locale,
  personLabels,
  presentation,
  personOptions = [],
  projectId,
  selectedDetailTaskKey,
  onCreateTaskOpen,
  onSelectTask,
  onTaskActionMenuOpen,
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
  const visibleFields = new Set((presentation?.columns ?? [
    { field: 'title' },
    { field: 'status' },
    { field: 'workItemType' },
    { field: 'assignee' },
    { field: 'dueDate' },
    { field: 'priority' },
  ]).map((column) => column.field))
  const cardPadding = presentation?.density === 'compact'
    ? 'p-2.5'
    : presentation?.density === 'spacious'
      ? 'p-4'
      : 'p-3'
  const cardGap = presentation?.density === 'compact'
    ? 'gap-1.5 p-2'
    : presentation?.density === 'spacious'
      ? 'gap-3 p-3.5'
      : 'gap-2 p-2.5'
  const wrapText = presentation?.display.wrapTitles ?? false
  const showAssigneeAvatars = presentation?.display.showAssigneeAvatars ?? false
  const showEmptyGroups = presentation?.display.showEmptyGroups ?? true
  /** Returns whether one card may expose inline Work Item mutation controls. */
  const canEditTask = (task: CanonicalWorkItem) => Boolean(
    onUpdateTask && (canMutateTask?.(task) ?? true),
  )
  /** Sends one card edit only when its exact Work Item scope is writable. */
  const updateTask = async (task: CanonicalWorkItem, input: WorkItemPatch): Promise<CanonicalWorkItem> => {
    if (!canEditTask(task) || !onUpdateTask) return task
    return onUpdateTask(task, input)
  }
  const visibleStatusColumns = showEmptyGroups
    ? statusColumns
    : statusColumns.filter((column) =>
        tasks.some((task) => isTaskInProjectStatusColumn(task, column))
      )
  /** Validates and sends a status transition for one project task. */
  const moveTaskToStatus = async (task: CanonicalWorkItem, workflowStatusId: string) => {
    if (!canEditTask(task) || task.workflowStatusId === workflowStatusId) {
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
      await updateTask(task, { workflowStatusId })
    } finally {
      setMovingTaskKeys((currentKeys) => {
        const nextKeys = new Set(currentKeys)
        nextKeys.delete(taskKey)
        return nextKeys
      })
    }
  }

  /** Starts a native drag interaction carrying the task's composite key. */
  const handleDragStart = (event: DragEvent<HTMLElement>, task: CanonicalWorkItem) => {
    if (!canEditTask(task)) {
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

    if (
      task &&
      task.teamId === column.teamId &&
      (task.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID) === column.workItemTypeId
    ) {
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
      {visibleStatusColumns.map((column) => {
        const statusTasks = tasks.filter((task) => isTaskInProjectStatusColumn(task, column))
        const columnConfiguration = configurationsByTeam[column.teamId]?.configuration ?? configuration
        const canCreateInColumn = resolveWorkItemTypeDefinition(
          columnConfiguration,
          column.workItemTypeId,
        )?.status === 'active'
        const subgroups = presentation?.subgroupBy
          ? groupTaskViewItems(
              statusTasks,
              presentation.subgroupBy,
              (task, field) => resolveProjectBoardGroupValue(
                task,
                field,
                resolveProjectTaskConfiguration(task, configurationsByTeam, configuration),
                t,
              ),
              presentation.subgroupDirection,
            )
          : []
        const orderedStatusTasks = subgroups.length > 0
          ? subgroups.flatMap((group) => group.items)
          : statusTasks
        const subgroupByFirstTaskKey = new Map<string, (typeof subgroups)[number]>()
        for (const group of subgroups) {
          const firstTask = group.items[0]
          if (firstTask) subgroupByFirstTaskKey.set(createTaskKey(firstTask), group)
        }

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

              if (
                !draggedTask ||
                !canEditTask(draggedTask) ||
                draggedTask.teamId !== column.teamId ||
                (draggedTask.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID) !== column.workItemTypeId
              ) {
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
                {onCreateTaskOpen && canCreateInColumn ? (
                  <button
                    aria-label={`${t('tasks.board.addInColumn')}: ${column.label}`}
                    className="rounded px-1.5 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-white"
                    data-testid={`project-task-add-${createProjectStatusTestToken(column.key)}`}
                    onClick={() => onCreateTaskOpen({
                      projectId: projectId ?? tasks[0]?.assignedProjectId ?? '',
                      source: 'board',
                      teamId: column.teamId,
                      workItemTypeId: column.workItemTypeId,
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
            <div className={`grid ${cardGap}`}>
              {statusTasks.length > 0 ? (
                orderedStatusTasks.map((task) => {
                  const taskKey = createTaskKey(task)
                  const schedule = resolveTaskSchedule(task)
                  const scheduleRange = formatTaskScheduleRange(schedule)
                  const scheduleDisplay = `${t(taskScheduleModeLabelKeys[schedule.mode])}${scheduleRange ? `: ${scheduleRange}` : ''}`
                  const taskConfiguration = resolveProjectTaskConfiguration(
                    task,
                    configurationsByTeam,
                    configuration,
                  )
                  const editableStatuses = resolveEditableWorkflowStatuses(task, taskConfiguration)
                  const isMoving = movingTaskKeys.has(taskKey)
                  const dependencySummary = resolveWorkItemDependencySummary(
                    dependencySummaries,
                    { teamId: task.teamId, workItemId: task.id },
                  )
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
                  const customFieldEntries = new Map(
                    resolveTaskCustomFieldEntries(
                      task,
                      taskConfiguration,
                      locale,
                      personLabels,
                      t,
                    ).map((entry) => [entry.definition.id, entry.value]),
                  )
                  const customColumns = [...visibleFields].flatMap((field) => {
                    if (!field.startsWith('custom:')) return []
                    const fieldId = field.slice('custom:'.length)
                    return [{
                      id: fieldId,
                      label: taskConfiguration?.customFields.find(
                        (definition) => definition.id === fieldId,
                      )?.name ?? fieldId,
                      value: customFieldEntries.get(fieldId) ?? '—',
                    }]
                  })

                  const subgroup = subgroupByFirstTaskKey.get(taskKey)
                  return (
                    <Fragment key={taskKey}>
                    {subgroup ? (
                      <h3 className="rounded bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-[var(--workbench-muted)]">
                        {subgroup.label} ({subgroup.items.length})
                      </h3>
                    ) : null}
                    <article
                      aria-grabbed={draggedTaskKey === taskKey || undefined}
                      className={`rounded-md border ${cardPadding} text-left transition ${
                        selectedDetailTaskKey === taskKey
                          ? 'border-[#99d7cf] bg-[#e5f7f4] shadow-[inset_3px_0_0_var(--workbench-primary)]'
                          : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                      } ${draggedTaskKey === taskKey ? 'opacity-50 ring-2 ring-[#99d7cf]' : ''} ${isMoving ? 'opacity-70' : ''}`}
                      data-testid={`project-task-card-${task.id}`}
                      draggable={canEditTask(task) && !isMoving}
                      onDragEnd={() => {
                        setDraggedTaskKey(undefined)
                        setDropTargetColumnKey(undefined)
                      }}
                      onDragStart={(event) => handleDragStart(event, task)}
                      onContextMenu={(event) => {
                        if (!onTaskActionMenuOpen) return
                        event.preventDefault()
                        onTaskActionMenuOpen(
                          task,
                          { x: event.clientX, y: event.clientY },
                          event.currentTarget,
                        )
                      }}
                      tabIndex={-1}
                    >
                      <div className="flex items-start gap-2">
                        {canEditTask(task) ? (
                          <TaskInlineField
                            ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.name')}`}
                            displayValue={resolveWorkItemTitle(task)}
                            testId={`task-inline-title-${task.id}`}
                            value={resolveWorkItemTitle(task)}
                            wrapText={wrapText}
                            onCommit={(value) => updateTask(task, { title: value }).then(() => undefined)}
                          />
                        ) : (
                          <button
                            className={`min-w-0 flex-1 text-left text-sm font-semibold leading-5 text-[#1c1d1f] hover:text-[var(--workbench-primary)] ${
                              wrapText ? 'whitespace-normal break-words' : 'truncate'
                            }`}
                            data-task-action="open"
                            data-task-team-id={task.teamId}
                            data-task-work-item-id={task.id}
                            onClick={() => onSelectTask(task)}
                            type="button"
                          >
                            {resolveWorkItemTitle(task)}
                          </button>
                        )}
                        {canEditTask(task) ? (
                          <button
                            aria-label={`${t('tasks.detail.title')}: ${resolveWorkItemTitle(task)}`}
                            className="rounded px-1 text-xs text-[var(--workbench-muted)] hover:bg-white hover:text-[var(--workbench-primary)]"
                            data-task-action="open"
                            data-task-team-id={task.teamId}
                            data-task-work-item-id={task.id}
                            onClick={() => onSelectTask(task)}
                            type="button"
                          >
                            ↗
                          </button>
                        ) : null}
                        {onTaskActionMenuOpen ? (
                          <button
                            aria-label={`${t('tasks.action.more')}: ${resolveWorkItemTitle(task)}`}
                            className="grid h-8 w-8 flex-none place-items-center rounded text-[var(--workbench-muted)] hover:bg-white hover:text-[var(--workbench-primary)] max-[640px]:h-11 max-[640px]:w-11"
                            data-testid={`task-card-actions-${task.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              const returnFocusElement = event.currentTarget
                              const bounds = returnFocusElement.getBoundingClientRect()
                              onTaskActionMenuOpen(
                                task,
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
                      <WorkItemDependencyChips
                        className="mt-2"
                        summary={dependencySummary}
                        t={t}
                      />
                      {visibleFields.has('status') && canEditTask(task) && editableStatuses.length > 0 ? (
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
                      {visibleFields.has('workItemType') ? (
                        <TaskWorkItemTypeBadge
                          configuration={taskConfiguration}
                          task={task}
                        />
                      ) : null}
                      {visibleFields.has('assignee') ? (
                        <div className="mt-2 flex min-w-0 items-center gap-2 text-xs font-medium text-[#5f6874]">
                          {showAssigneeAvatars ? (
                            <WorkItemAssigneeAvatar label={resolveWorkItemAssignee(task)} />
                          ) : null}
                          {canEditTask(task) && inlineAssigneeOptions.length > 0 ? (
                            <TaskInlineField
                              ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.assignee')}`}
                              displayValue={resolveWorkItemAssignee(task)}
                              kind="select"
                              options={inlineAssigneeOptions}
                              testId={`task-inline-assignee-${task.id}`}
                              value={task.assigneeUserId}
                              onCommit={(value) => updateTask(task, { assigneeUserId: value }).then(() => undefined)}
                            />
                          ) : (
                            <span className="truncate">{resolveWorkItemAssignee(task)}</span>
                          )}
                        </div>
                      ) : null}
                      {(!presentation || visibleFields.has('customFields')) && canEditTask(task) ? (
                        <TaskInlineCustomFields
                          configuration={taskConfiguration}
                          locale={locale}
                          onUpdateTask={updateTask}
                          personLabels={personLabels}
                          personOptions={personOptions}
                          t={t}
                          task={task}
                        />
                      ) : !presentation || visibleFields.has('customFields') ? (
                        <TaskCustomFieldSummary
                          configuration={taskConfiguration}
                          locale={locale}
                          personLabels={personLabels}
                          t={t}
                          task={task}
                        />
                      ) : null}
                      {customColumns.length > 0 ? (
                        <dl className="mt-2 grid gap-1.5 text-xs text-[var(--workbench-muted)]">
                          {customColumns.map((item) => (
                            <div className="flex min-w-0 items-baseline justify-between gap-2" key={item.id}>
                              <dt className="truncate font-semibold">{item.label}</dt>
                              <dd className={wrapText ? 'break-words text-right' : 'truncate text-right'}>
                                {item.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                      {visibleFields.has('priority') || visibleFields.has('dueDate') ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                        {visibleFields.has('priority') && canEditTask(task) ? (
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
                            onCommit={(value) => updateTask(task, { priority: resolveTaskPriority(value) }).then(() => undefined)}
                          />
                        ) : visibleFields.has('priority') ? <TaskPriorityBadge priority={task.priority} t={t} /> : null}
                        {visibleFields.has('dueDate') && canEditTask(task) && (schedule.mode === 'due-date' || schedule.mode === 'unscheduled') ? (
                          <TaskInlineField
                            ariaLabel={`${t('tasks.inline.edit')}: ${t('tasks.column.dueDate')}`}
                            displayValue={scheduleDisplay}
                            kind="date"
                            testId={`task-inline-due-date-${task.id}`}
                            value={schedule.mode === 'due-date' ? schedule.dueDate : ''}
                            onCommit={(value) => updateTask(task, {
                              schedule: replaceTaskDeadlineSchedule(schedule, value),
                            }).then(() => undefined)}
                          />
                        ) : visibleFields.has('dueDate') ? (
                          <span className="text-xs font-semibold text-[#5f6874]">{scheduleDisplay}</span>
                        ) : null}
                        </div>
                      ) : null}
                      {visibleFields.has('project') ? (
                        <p className="mt-2 text-[11px] font-medium text-[var(--workbench-muted)]">
                          {t('workspace.column.project')}: {task.assignedProjectId ?? '—'}
                        </p>
                      ) : null}
                      {visibleFields.has('team') ? (
                        <p className="mt-1 text-[11px] font-medium text-[var(--workbench-muted)]">
                          {t('workspace.column.team')}: {task.teamId}
                        </p>
                      ) : null}
                      <p className="mt-2 text-[11px] font-medium text-[var(--workbench-muted)]">
                        {t('tasks.board.dragHint')}
                      </p>
                    </article>
                    </Fragment>
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
      {visibleStatusColumns.length === 0 && unavailableTasks.length === 0 ? (
        <p className="col-span-full rounded-md border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('tasks.board.empty')}
        </p>
      ) : null}
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
              <article
                className="rounded-md border border-red-100 bg-white p-3 text-left transition hover:border-red-200"
                key={createTaskKey(task)}
                onContextMenu={(event) => {
                  if (!onTaskActionMenuOpen) return
                  event.preventDefault()
                  onTaskActionMenuOpen(
                    task,
                    { x: event.clientX, y: event.clientY },
                    event.currentTarget,
                  )
                }}
                tabIndex={-1}
              >
                <div className="flex items-start gap-2">
                  <button
                    className="min-w-0 flex-1 text-left text-sm font-semibold leading-5 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)]"
                    data-task-action="open"
                    data-task-team-id={task.teamId}
                    data-task-work-item-id={task.id}
                    onClick={() => onSelectTask(task)}
                    type="button"
                  >
                    {resolveWorkItemTitle(task)}
                  </button>
                  {onTaskActionMenuOpen ? (
                    <button
                      aria-label={`${t('tasks.action.more')}: ${resolveWorkItemTitle(task)}`}
                      className="grid h-8 w-8 flex-none place-items-center rounded text-[var(--workbench-muted)] hover:bg-red-50 hover:text-[var(--workbench-primary)] max-[640px]:h-11 max-[640px]:w-11"
                      data-testid={`task-card-actions-${task.id}`}
                      onClick={(event) => {
                        const returnFocusElement = event.currentTarget
                        const bounds = returnFocusElement.getBoundingClientRect()
                        onTaskActionMenuOpen(
                          task,
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
                <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">
                  {resolveWorkItemAssignee(task)} · {task.workflowStatusId}
                </p>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

/** Resolves a stable key and visible label for one project board subgroup field. */
function resolveProjectBoardGroupValue(
  task: CanonicalWorkItem,
  field: string,
  configuration: WorkItemConfiguration | undefined,
  t: TaskBoardTranslator,
): TaskViewGroupValue {
  let value: string
  switch (field) {
    case 'title': value = resolveWorkItemTitle(task); break
    case 'status': value = resolveWorkItemWorkflowStatusLabel(task, configuration); break
    case 'assignee': value = resolveWorkItemAssignee(task); break
    case 'dueDate': value = task.dueDate || '—'; break
    case 'priority': value = t(`tasks.priority.${task.priority}`); break
    case 'workItemType': value = resolveWorkItemTypeLabel(task, configuration); break
    case 'project': value = task.assignedProjectId ?? '—'; break
    case 'team': value = task.teamId; break
    default: {
      const customValue = field.startsWith('custom:')
        ? task.customFieldValues[field.slice('custom:'.length)]
        : undefined
      value = Array.isArray(customValue)
        ? customValue.join(', ')
        : customValue === undefined || customValue === null || customValue === ''
          ? '—'
          : String(customValue)
    }
  }
  return { key: value, label: value }
}
