import { useState, type DragEvent } from 'react'
import type { MessageKey } from '../../i18n'
import type { ProjectTask, TaskStatus } from '../../tasks/api'
import { workspacePresentation } from '../workspacePresentation'
import {
  CompactTaskCard,
  SectionHeader,
} from './WorkspaceViewComponents'

const myTaskKanbanStatuses = ['todo', 'in-progress', 'review', 'done'] as const satisfies readonly TaskStatus[]

/**
 * 現在ユーザーのタスクを状態別 Kanban で描画します。
 */
export function MyTasksView({
  onOpenTask,
  t,
  taskMoveErrorMessage,
  tasks,
  onMoveTaskStatus,
}: {
  onOpenTask?: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  taskMoveErrorMessage?: string
  tasks: ProjectTask[]
  onMoveTaskStatus?: (task: ProjectTask, status: TaskStatus) => Promise<void>
}) {
  const [draggedTaskKey, setDraggedTaskKey] = useState<string | undefined>()
  const [dropTargetStatus, setDropTargetStatus] = useState<TaskStatus | undefined>()
  const [movingTaskKeys, setMovingTaskKeys] = useState<ReadonlySet<string>>(() => new Set())
  const canMoveTasks = Boolean(onMoveTaskStatus)

  const moveTaskToStatus = (task: ProjectTask, status: TaskStatus) => {
    if (!onMoveTaskStatus || task.status === status || workspacePresentation.isLegacyWorkspaceTask(task)) {
      return
    }

    const taskKey = workspacePresentation.createWorkspaceTaskKey(task)

    setDraggedTaskKey(undefined)
    setDropTargetStatus(undefined)
    setMovingTaskKeys((currentTaskKeys) => new Set(currentTaskKeys).add(taskKey))
    void onMoveTaskStatus(task, status)
      .catch(() => undefined)
      .finally(() => {
        setMovingTaskKeys((currentTaskKeys) => {
          const nextTaskKeys = new Set(currentTaskKeys)

          nextTaskKeys.delete(taskKey)
          return nextTaskKeys
        })
      })
  }

  const handleDragStart = (event: DragEvent<HTMLElement>, task: ProjectTask) => {
    if (!canMoveTasks || workspacePresentation.isLegacyWorkspaceTask(task)) {
      return
    }

    const taskKey = workspacePresentation.createWorkspaceTaskKey(task)

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-mukuroji-task-key', taskKey)
    event.dataTransfer.setData('text/plain', taskKey)
    setDraggedTaskKey(taskKey)
  }

  const handleDragEnd = () => {
    setDraggedTaskKey(undefined)
    setDropTargetStatus(undefined)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>, status: TaskStatus) => {
    const carriesTaskKey = draggedTaskKey ||
      event.dataTransfer.types.includes('application/x-mukuroji-task-key') ||
      event.dataTransfer.types.includes('text/plain')

    if (!canMoveTasks || !carriesTaskKey) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetStatus(status)
  }

  const handleDrop = (event: DragEvent<HTMLElement>, status: TaskStatus) => {
    event.preventDefault()

    if (!onMoveTaskStatus) {
      return
    }

    const taskKey =
      event.dataTransfer.getData('application/x-mukuroji-task-key') ||
      event.dataTransfer.getData('text/plain') ||
      draggedTaskKey
    const task = taskKey ? workspacePresentation.findWorkspaceTaskByKey(tasks, taskKey) : undefined

    if (!task) {
      return
    }

    moveTaskToStatus(task, status)
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
        className="grid grid-cols-[repeat(4,minmax(260px,1fr))] gap-4 overflow-x-auto pb-2 max-[900px]:grid-cols-1 max-[900px]:overflow-visible max-[900px]:pb-0"
        data-testid="my-tasks-kanban"
      >
        {myTaskKanbanStatuses.map((status) => {
          const columnTasks = tasks.filter((task) => task.status === status)
          const isDropTarget = dropTargetStatus === status

          return (
            <section
              aria-label={t(`tasks.status.${status}`)}
              className={`workbench-panel min-h-[420px] min-w-[260px] transition ${
                isDropTarget ? 'border-[#99d7cf] bg-[#e5f7f4] ring-2 ring-[#99d7cf]/40' : ''
              }`}
              data-testid={`my-tasks-column-${status}`}
              key={status}
              onDragLeave={() => setDropTargetStatus(undefined)}
              onDragOver={(event) => handleDragOver(event, status)}
              onDrop={(event) => handleDrop(event, status)}
            >
              <SectionHeader
                title={t(`tasks.status.${status}`)}
                meta={t('tasks.board.columnCount').replace('{count}', String(columnTasks.length))}
              />
              <div className="grid gap-3 px-4 pb-4">
                {columnTasks.map((task) => {
                  const taskKey = workspacePresentation.createWorkspaceTaskKey(task)
                  const isMoving = movingTaskKeys.has(taskKey)
                  const isLegacyTask = workspacePresentation.isLegacyWorkspaceTask(task)

                  return (
                    <CompactTaskCard
                      draggable={canMoveTasks && !isMoving && !isLegacyTask}
                      isDragging={draggedTaskKey === taskKey}
                      isMoving={isMoving}
                      key={taskKey}
                      t={t}
                      task={task}
                      testId={`my-tasks-card-${workspacePresentation.createWorkspaceTaskTestId(task)}`}
                      onDragEnd={handleDragEnd}
                      onDragStart={(event) => handleDragStart(event, task)}
                      onOpenTask={onOpenTask}
                      onStatusChange={isLegacyTask || !onMoveTaskStatus
                        ? undefined
                        : (nextStatus) => moveTaskToStatus(task, nextStatus)}
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
      </div>
    </div>
  )
}
