import type {
  ResolvedWorkItemConfiguration,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { ProjectTask } from '../api/tasks'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../work-items/model/workItemDisplay'
import {
  createTaskKey,
  resolveProjectTaskConfiguration,
  sortTasksByDueDate,
  type TaskCreateContext,
} from '../model/taskView'
import {
  TaskStatusBadge,
  TaskViewHeading,
} from './TaskViewPrimitives'

/** Resolves a localized task Gantt-view message. */
type TaskGanttTranslator = (key: MessageKey) => string

/** Props for the independent project task Gantt view. */
export type TaskGanttViewProps = {
  /** Project receiving contextual Gantt creates. */
  projectId?: string
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team-scoped resolved configurations used by task statuses. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Tasks displayed in ascending due-date order. */
  tasks: ProjectTask[]
  /** Translator used for Gantt-view labels. */
  t: TaskGanttTranslator
  /** Opens the create panel with a planning-date context. */
  onCreateTaskOpen?: (context?: TaskCreateContext) => void
  /** Selects a task in the shared detail pane. */
  onSelectTask?: (task: ProjectTask) => void
}

/**
 * Renders the existing due-date-ordered task list used as the Gantt view.
 *
 * @param props - Tasks, workflow configurations, and localization inputs.
 * @returns The independent project task Gantt view.
 */
export function TaskGanttView({
  configuration,
  configurationsByTeam,
  onCreateTaskOpen,
  onSelectTask,
  projectId,
  t,
  tasks,
}: TaskGanttViewProps) {
  const sortedTasks = sortTasksByDueDate(tasks, 'due-date-asc')

  return (
    <section
      aria-label={t('tasks.view.gantt')}
      className="workbench-table mt-3 overflow-hidden"
    >
      <TaskViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey="tasks.view.gantt"
      />
      {onCreateTaskOpen ? (
        <div className="flex justify-end border-b border-[#e4e7ec] px-4 py-2">
          <button
            className="text-sm font-semibold text-[var(--workbench-primary)] hover:underline"
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
      {sortedTasks.length > 0 ? (
        <div className="divide-y divide-[#e4e7ec]">
          {sortedTasks.map((task) => (
            <article
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 max-[640px]:grid-cols-1"
              key={createTaskKey(task)}
            >
              <div className="min-w-0">
                {onSelectTask ? (
                  <button
                    className="truncate text-left text-sm font-semibold text-[#1c1d1f] hover:text-[var(--workbench-primary)]"
                    onClick={() => onSelectTask(task)}
                    type="button"
                  >
                    {resolveWorkItemTitle(task)}
                  </button>
                ) : <p className="truncate text-sm font-semibold text-[#1c1d1f]">{resolveWorkItemTitle(task)}</p>}
                <p className="mt-1 text-xs font-medium text-[#5f6874]">
                  {resolveWorkItemAssignee(task)}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 max-[640px]:justify-start">
                {onCreateTaskOpen ? (
                  <button
                    aria-label={`${t('tasks.gantt.add')}: ${resolveWorkItemTitle(task)}`}
                    className="rounded px-2 py-1 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-[#e5f7f4]"
                    data-testid={`task-gantt-add-${task.id}`}
                    onClick={() => onCreateTaskOpen({
                      ...(task.assigneeUserId ? { assigneeUserId: task.assigneeUserId } : {}),
                      ...(task.dueDate ? { dueDate: task.dueDate } : {}),
                      projectId: projectId ?? task.assignedProjectId ?? '',
                      source: 'gantt',
                      teamId: task.teamId,
                      workflowStatusId: task.workflowStatusId,
                    })}
                    type="button"
                  >
                    +
                  </button>
                ) : null}
                <TaskStatusBadge
                  configuration={resolveProjectTaskConfiguration(
                    task,
                    configurationsByTeam,
                    configuration,
                  )}
                  task={task}
                />
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
