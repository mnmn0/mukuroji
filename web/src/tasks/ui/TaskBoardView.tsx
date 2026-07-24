import type {
  ResolvedWorkItemConfiguration,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { ProjectTask } from '../api/tasks'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../issues/model/workItemDisplay'
import {
  createProjectStatusTestToken,
  createTaskKey,
  isTaskInProjectStatusColumn,
  resolveProjectTaskConfiguration,
  type ProjectTaskStatusColumn,
} from '../model/taskView'
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
}

/**
 * Renders project tasks in team-scoped workflow columns.
 *
 * @param props - Board tasks, status columns, configuration state, and selection callback.
 * @returns The independent project task board view.
 */
export function TaskBoardView({
  configuration,
  configurationsByTeam,
  configurationFailedTeamIds,
  locale,
  personLabels,
  selectedDetailTaskKey,
  onSelectTask,
  t,
  tasks,
  statusColumns,
}: TaskBoardViewProps) {
  const unavailableTasks = tasks.filter((task) =>
    configurationFailedTeamIds.includes(task.teamId),
  )

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
            className="workbench-panel min-h-[420px]"
            data-testid={`project-task-column-${createProjectStatusTestToken(column.key)}`}
            key={column.key}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5">
              <span className="grid gap-0.5">
                <TaskStatusBadge configuration={columnConfiguration} status={column.status} />
                <span className="text-[11px] font-semibold text-[var(--workbench-muted)]">
                  {column.label}
                </span>
              </span>
              <span className="text-sm font-semibold text-[#5f6874]">
                {t('tasks.board.columnCount').replace('{count}', String(statusTasks.length))}
              </span>
            </div>
            <div className="grid gap-2 p-2.5">
              {statusTasks.length > 0 ? (
                statusTasks.map((task) => (
                  <button
                    className={`rounded-md border p-3 text-left transition focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 ${
                      selectedDetailTaskKey === createTaskKey(task)
                        ? 'border-[#99d7cf] bg-[#e5f7f4] shadow-[inset_3px_0_0_var(--workbench-primary)]'
                        : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                    }`}
                    key={createTaskKey(task)}
                    onClick={() => onSelectTask(task)}
                    type="button"
                  >
                    <p className="text-sm font-semibold leading-5 text-[#1c1d1f]">{resolveWorkItemTitle(task)}</p>
                    <p className="mt-2 truncate text-xs font-medium text-[#5f6874]">
                      {resolveWorkItemAssignee(task)}
                    </p>
                    <TaskCustomFieldSummary
                      configuration={resolveProjectTaskConfiguration(
                        task,
                        configurationsByTeam,
                        configuration,
                      )}
                      locale={locale}
                      personLabels={personLabels}
                      t={t}
                      task={task}
                    />
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
