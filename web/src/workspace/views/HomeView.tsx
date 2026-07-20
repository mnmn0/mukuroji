import type { DashboardSummary } from '../../auth/api'
import type { MessageKey } from '../../i18n'
import type { ProjectDirectoryTeam } from '../../projects/api'
import { resolveProjectTaskStatus, type ProjectTask } from '../../tasks/api'
import { workspacePresentation } from '../workspacePresentation'
import {
  MetricCard,
  SectionHeader,
  TaskListRow,
} from './WorkspaceViewComponents'

/**
 * Workspace home の指標と優先タスクを描画します。
 */
export function HomeView({
  onOpenTask,
  summary,
  t,
  tasks,
  teams,
}: {
  onOpenTask?: (task: ProjectTask) => void
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
}) {
  const nextTasks = workspacePresentation.createActionQueueTasks(tasks).slice(0, 3)
  const attentionTasks = workspacePresentation.createInboxTasks(tasks).slice(0, 3)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="teal" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.metric.teams')} value={teams.length} tone="amber" />
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)] gap-6 max-[1080px]:grid-cols-1">
        <section className="workbench-panel">
          <SectionHeader title={t('workspace.home.focusTitle')} meta={t('workspace.home.focusMeta')} />
          <div className="divide-y divide-slate-100">
            {nextTasks.map((task) => (
              <TaskListRow
                key={workspacePresentation.createWorkspaceTaskKey(task)}
                t={t}
                task={task}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        </section>

        <section className="workbench-panel">
          <SectionHeader
            title={t('workspace.reports.attentionTitle')}
            meta={t('workspace.reports.attentionMeta')}
          />
          <div className="grid gap-3 px-5 pb-5">
            {attentionTasks.map((task) => (
              <button
                className="rounded-lg border border-[var(--workbench-border)] bg-white p-4 text-left transition hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)] disabled:hover:border-[var(--workbench-border)] disabled:hover:bg-white"
                disabled={!onOpenTask || !workspacePresentation.isOpenableWorkspaceTask(task)}
                key={workspacePresentation.createWorkspaceTaskKey(task)}
                onClick={() => onOpenTask?.(task)}
                type="button"
              >
                <p className="text-sm font-semibold text-[var(--workbench-text)]">{workspacePresentation.resolveTaskTitle(task, t)}</p>
                <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {workspacePresentation.resolveTaskAssignee(task, t)} / {t(`tasks.status.${resolveProjectTaskStatus(task)}`)} / {task.dueDate}
                </p>
              </button>
            ))}
            {attentionTasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm font-bold text-[#526381]">
                {t('workspace.empty.tasks')}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
