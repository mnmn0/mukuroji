import type { DashboardSummary } from '../../../auth/api'
import type { MessageKey } from '../../../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../../../projects/api'
import type { ProjectTask } from '../../../tasks/api'
import { workspacePresentation } from '../presentation'
import {
  MetricCard,
  ProgressBar,
  SectionHeader,
  TaskListRow,
} from './WorkspaceViewComponents'

/**
 * Workspace portfolio の進捗と判断待ちタスクを描画します。
 */
export function DashboardWorkspaceView({
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
  const decisionTasks = workspacePresentation.createActionQueueTasks(tasks).slice(0, 5)
  const projects = teams.flatMap((team) =>
    team.projects.map((project) => {
      const projectTasks = workspacePresentation.filterTasksByProjectIds(tasks, [project.id])

      return {
        progress: workspacePresentation.calculateProjectProgress(projectTasks),
        id: `${team.id}-${project.id}`,
        name: project.name,
        teamName: team.name,
        riskKey: workspacePresentation.resolvePortfolioRiskKey(projectTasks),
      }
    }),
  )

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="teal" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.reports.metric.completion')} value={`${workspacePresentation.calculateProjectProgress(tasks)}%`} tone="amber" />
      </div>

      <section className="workbench-table overflow-hidden">
        <SectionHeader title={t('workspace.dashboard.portfolioTitle')} meta={t('workspace.dashboard.portfolioMeta')} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse text-left">
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">{t('workspace.column.project')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.team')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.progress')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.risk')}</th>
              </tr>
            </thead>
            <tbody>
              {projects.slice(0, 6).map((project) => (
                <tr className="border-b border-slate-100 text-sm font-medium text-[var(--workbench-text)]" key={project.id}>
                  <td className="px-5 py-4">{project.name}</td>
                  <td className="px-5 py-4 text-[var(--workbench-muted)]">{project.teamName}</td>
                  <td className="px-5 py-4">
                    <ProgressBar
                      label={`${project.name} ${t('workspace.column.progress')}`}
                      value={project.progress}
                    />
                  </td>
                  <td className="px-5 py-4">{t(project.riskKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="workbench-panel">
        <SectionHeader
          title={t('workspace.dashboard.decisionTitle')}
          meta={t('workspace.dashboard.decisionMeta').replace('{count}', String(decisionTasks.length))}
        />
        <div className="divide-y divide-slate-100">
          {decisionTasks.map((task) => (
            <TaskListRow
              key={workspacePresentation.createWorkspaceTaskKey(task)}
              t={t}
              task={task}
              onOpenTask={onOpenTask}
            />
          ))}
          {decisionTasks.length === 0 ? (
            <p className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]">
              {t('workspace.empty.tasks')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
