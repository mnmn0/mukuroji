import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { useMemo, useState, type DragEvent } from 'react'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { MessageKey } from '../../shared/i18n/i18n'
import { SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import type { ProjectTask } from '../../tasks/api'
import {
  createWorkspaceTaskKey,
  createWorkspaceTaskStatusColumns,
  findWorkspaceTaskByKey,
  isTaskInWorkspaceStatusColumn,
  type WorkspaceTaskStatusColumn,
} from '../../work-items/model/workspaceWorkItems'
import { resolveEditableWorkflowStatuses } from '../../work-items/model/workItemDisplay'
import {
  CompactTaskCard,
  createWorkspaceTaskTestId,
  createWorkspaceTaskTestToken,
} from '../../work-items/ui/WorkspaceWorkItemPrimitives'

/**
 * Props for the Workspace personal task board.
 */
export type MyTasksWorkspaceViewProps = {
  /** Team IDs whose Work Item configurations could not be loaded. */
  configurationFailedTeamIds: readonly string[]
  /** Resolved Work Item configurations indexed by Team ID. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Optional callback that requests a Work Item workflow status change. */
  onMoveTaskStatus?: (task: ProjectTask, workflowStatusId: string) => Promise<void>
  /** Optional callback that opens a selected Work Item. */
  onOpenTask?: (task: ProjectTask) => void
  /** Translator used for Workspace labels. */
  t: (key: MessageKey) => string
  /** Optional status mutation error displayed above the board. */
  taskMoveErrorMessage?: string
  /** Work Items assigned to the current user. */
  tasks: readonly ProjectTask[]
  /** Workspace directory used to label Team-scoped workflow columns. */
  teams: readonly ProjectDirectoryTeam[]
}

/**
 * Renders the current user's Team-scoped kanban board with drag-and-drop status changes.
 *
 * @param props - Assigned Work Items, Team configurations, and board actions.
 * @returns The personal Workspace task board.
 */
export function MyTasksWorkspaceView({
  configurationFailedTeamIds,
  configurationsByTeam,
  onOpenTask,
  t,
  taskMoveErrorMessage,
  tasks,
  teams,
  onMoveTaskStatus,
}: MyTasksWorkspaceViewProps) {
  const [draggedTaskKey, setDraggedTaskKey] = useState<string | undefined>()
  const [dropTargetColumnKey, setDropTargetColumnKey] = useState<string | undefined>()
  const [movingTaskKeys, setMovingTaskKeys] = useState<ReadonlySet<string>>(() => new Set())
  const canMoveTasks = Boolean(onMoveTaskStatus)
  const statusColumns = useMemo(
    () => createWorkspaceTaskStatusColumns(tasks, configurationsByTeam, teams),
    [configurationsByTeam, tasks, teams],
  )
  const configurationUnavailableTasks = useMemo(
    () => tasks.filter((task) => configurationFailedTeamIds.includes(task.teamId)),
    [configurationFailedTeamIds, tasks],
  )

  /**
   * Validates and requests a Work Item status change while tracking pending state.
   *
   * @param task - Work Item to move.
   * @param workflowStatusId - Destination workflow status ID.
   * @returns Nothing.
   */
  const moveTaskToStatus = (task: ProjectTask, workflowStatusId: string) => {
    if (!onMoveTaskStatus || task.workflowStatusId === workflowStatusId) {
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
  const handleDragStart = (event: DragEvent<HTMLElement>, task: ProjectTask) => {
    if (!canMoveTasks) {
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
      !canMoveTasks ||
      !carriesTaskKey ||
      (draggedTask && column.teamId !== draggedTask.teamId)
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

    if (column.teamId === task.teamId) {
      moveTaskToStatus(task, column.status.id)
    }
  }

  return (
    <div className="grid gap-4">
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
        {statusColumns.map((column) => {
          const columnTasks = tasks.filter((task) => isTaskInWorkspaceStatusColumn(task, column))
          const isDropTarget = dropTargetColumnKey === column.key

          return (
            <section
              aria-label={column.label}
              className={`workbench-panel min-h-[420px] min-w-[260px] transition ${
                isDropTarget ? 'border-[#99d7cf] bg-[#e5f7f4] ring-2 ring-[#99d7cf]/40' : ''
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
              <div className="grid gap-3 px-4 pb-4">
                {columnTasks.map((task) => {
                  const taskKey = createWorkspaceTaskKey(task)
                  const isMoving = movingTaskKeys.has(taskKey)
                  const configuration = configurationsByTeam[task.teamId]?.configuration
                  const editableStatuses = resolveEditableWorkflowStatuses(task, configuration)

                  return (
                    <CompactTaskCard
                      configuration={configuration}
                      draggable={canMoveTasks && !isMoving}
                      isDragging={draggedTaskKey === taskKey}
                      isMoving={isMoving}
                      key={taskKey}
                      t={t}
                      task={task}
                      testId={`my-tasks-card-${createWorkspaceTaskTestId(task)}`}
                      onDragEnd={handleDragEnd}
                      onDragStart={(event) => handleDragStart(event, task)}
                      onOpenTask={onOpenTask}
                      onStatusChange={!onMoveTaskStatus
                        ? undefined
                        : (nextStatus) => moveTaskToStatus(task, nextStatus)}
                      workflowStatuses={editableStatuses}
                    />
                  )
                })}
                {columnTasks.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-white px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
                    {t('tasks.board.empty')}
                  </p>
                ) : null}
              </div>
            </section>
          )
        })}
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
                  key={createWorkspaceTaskKey(task)}
                  t={t}
                  task={task}
                  testId={`my-tasks-card-${createWorkspaceTaskTestId(task)}`}
                  onOpenTask={onOpenTask}
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
