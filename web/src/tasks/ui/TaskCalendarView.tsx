import type { ProjectTask } from '../api/tasks'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../work-items/model/workItemDisplay'
import { createTaskCalendarModel, createTaskKey, type TaskCreateContext } from '../model/taskView'
import {
  TaskViewHeading,
} from './TaskViewPrimitives'

/** Resolves a localized task-calendar message. */
type TaskCalendarTranslator = (key: MessageKey) => string

/** Props for the independent project task calendar view. */
export type TaskCalendarViewProps = {
  /** Project receiving contextual Calendar creates. */
  projectId?: string
  /** Filtered and sorted tasks displayed by calendar day. */
  tasks: ProjectTask[]
  /** Translator used for calendar labels. */
  t: TaskCalendarTranslator
  /** Opens the create panel with a due-date context. */
  onCreateTaskOpen?: (context?: TaskCreateContext) => void
  /** Selects a task in the shared detail pane. */
  onSelectTask?: (task: ProjectTask) => void
}

/**
 * Renders project tasks grouped by due date with a separate unscheduled bucket.
 *
 * @param props - Tasks and localization inputs.
 * @returns The independent project task calendar view.
 */
export function TaskCalendarView({
  onCreateTaskOpen,
  onSelectTask,
  projectId,
  t,
  tasks,
}: TaskCalendarViewProps) {
  const calendar = createTaskCalendarModel(tasks)

  return (
    <section
      aria-label={t('tasks.view.calendar')}
      className="workbench-table mt-3 overflow-hidden"
    >
      <TaskViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey="tasks.view.calendar"
      />
      {tasks.length > 0 ? (
        <div
          className="grid"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))' }}
        >
          {calendar.days.map((day) => (
            <div className="min-h-[190px] border-b border-r border-[#e4e7ec] p-3" key={day.id}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-[#1c1d1f]">{day.label}</p>
                {onCreateTaskOpen ? (
                  <button
                    aria-label={`${t('tasks.calendar.addOnDate')}: ${day.label}`}
                    className="rounded px-1.5 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-[#e5f7f4]"
                    onClick={() => onCreateTaskOpen({
                      dueDate: day.date,
                      ...(projectId ? { projectId } : {}),
                      source: 'calendar',
                    })}
                    type="button"
                  >
                    +
                  </button>
                ) : null}
              </div>
              <div className="mt-3 grid gap-2">
                {day.items.map((task) => (
                  <article className="rounded-md border border-[#99d7cf] bg-[#e5f7f4] p-3" key={createTaskKey(task)}>
                    {onSelectTask ? (
                      <button
                        className="text-left text-sm font-semibold leading-5 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)]"
                        onClick={() => onSelectTask(task)}
                        type="button"
                      >
                        {resolveWorkItemTitle(task)}
                      </button>
                    ) : <p className="text-sm font-semibold leading-5 text-[var(--workbench-text)]">{resolveWorkItemTitle(task)}</p>}
                    <p className="mt-2 text-xs font-medium text-[var(--workbench-primary)]">{resolveWorkItemAssignee(task)}</p>
                  </article>
                ))}
              </div>
            </div>
          ))}
          {calendar.unscheduledTasks.length > 0 ? (
            <div className="min-h-[190px] border-b border-r border-[#e4e7ec] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-[#1c1d1f]">{t('tasks.calendar.empty')}</p>
                {onCreateTaskOpen ? (
                  <button
                    aria-label={t('tasks.calendar.addWithoutDate')}
                    className="rounded px-1.5 text-lg font-semibold text-[var(--workbench-primary)] hover:bg-[#e5f7f4]"
                    onClick={() => onCreateTaskOpen({
                      ...(projectId ? { projectId } : {}),
                      source: 'calendar',
                    })}
                    type="button"
                  >
                    +
                  </button>
                ) : null}
              </div>
              <div className="mt-3 grid gap-2">
                {calendar.unscheduledTasks.map((task) => (
                  <article className="rounded-md border border-[var(--workbench-border)] bg-white p-3" key={createTaskKey(task)}>
                    {onSelectTask ? (
                      <button
                        className="text-left text-sm font-semibold leading-5 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)]"
                        onClick={() => onSelectTask(task)}
                        type="button"
                      >
                        {resolveWorkItemTitle(task)}
                      </button>
                    ) : <p className="text-sm font-semibold leading-5 text-[var(--workbench-text)]">{resolveWorkItemTitle(task)}</p>}
                    <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{resolveWorkItemAssignee(task)}</p>
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
