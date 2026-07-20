import { useState } from 'react'
import type { MessageKey } from '../../i18n'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type {
  ProjectTask,
  TaskPriority,
  TaskStatus,
} from '../../tasks/api'
import { workspacePresentation } from '../workspacePresentation'
import {
  MetricCard,
  ProgressBar,
  SectionHeader,
  TaskListRow,
} from './WorkspaceViewComponents'

const reportStatusOrder = ['todo', 'in-progress', 'review', 'done'] as const satisfies readonly TaskStatus[]
const reportPriorityOrder = ['high', 'medium', 'low'] as const satisfies readonly TaskPriority[]

/**
 * Workspace のプロジェクト集計と CSV export UI を描画します。
 */
export function ReportsView({
  onOpenTask,
  onSelectProject,
  t,
  tasks,
  teams,
}: {
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
}) {
  const [projectSearchQuery, setProjectSearchQuery] = useState('')
  const [showAttentionOnly, setShowAttentionOnly] = useState(false)
  const openTasks = tasks.filter((task) => task.status !== 'done')
  const attentionTasks = workspacePresentation.createInboxTasks(tasks)
  const projectRows = workspacePresentation.createReportProjectRows(teams, tasks)
  const normalizedProjectSearchQuery = workspacePresentation.normalizeWorkspaceSearchText(projectSearchQuery)
  const filteredProjectRows = projectRows.filter((project) => {
    if (showAttentionOnly && project.attentionTaskCount === 0) {
      return false
    }

    return !normalizedProjectSearchQuery ||
      workspacePresentation.normalizeWorkspaceSearchText(`${project.name} ${project.teamName}`).includes(normalizedProjectSearchQuery)
  })
  const statusItems = reportStatusOrder.map((status) => ({
    count: tasks.filter((task) => task.status === status).length,
    id: status,
    label: t(`tasks.status.${status}`),
  }))
  const priorityItems = reportPriorityOrder.map((priority) => ({
    count: openTasks.filter((task) => task.priority === priority).length,
    id: priority,
    label: t(`tasks.priority.${priority}`),
  }))
  const attentionProjectCount = projectRows.filter((project) => project.attentionTaskCount > 0).length

  return (
    <div className="grid gap-6" data-testid="reports-workbench">
      <section className="workbench-toolbar flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workspace.reports.snapshotTitle')}
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
            {t('workspace.reports.snapshotDescription')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-10 px-4"
          data-testid="reports-export-csv"
          onClick={() => workspacePresentation.downloadWorkspaceReportCsv(filteredProjectRows, t)}
          type="button"
        >
          {t('workspace.reports.exportCsv')}
        </button>
      </section>

      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard
          label={t('workspace.reports.metric.open')}
          testId="reports-metric-open"
          value={openTasks.length}
          tone="teal"
        />
        <MetricCard
          label={t('workspace.reports.metric.completion')}
          testId="reports-metric-completion"
          value={`${workspacePresentation.calculateProjectProgress(tasks)}%`}
          tone="emerald"
        />
        <MetricCard
          label={t('workspace.reports.metric.attention')}
          testId="reports-metric-attention"
          value={attentionTasks.length}
          tone="red"
        />
        <MetricCard
          label={t('workspace.reports.metric.projects')}
          testId="reports-metric-projects"
          value={attentionProjectCount}
          tone="amber"
        />
      </div>

      <div className="grid grid-cols-2 gap-5 max-[980px]:grid-cols-1">
        <section className="workbench-panel overflow-hidden">
          <SectionHeader
            title={t('workspace.reports.statusTitle')}
            meta={t('workspace.reports.statusMeta')}
          />
          <div className="grid gap-4 border-t border-[var(--workbench-border)] p-5">
            {statusItems.map((item) => (
              <ReportDistributionRow
                count={item.count}
                key={item.id}
                label={item.label}
                toneClassName={workspacePresentation.resolveReportStatusToneClassName(item.id)}
                total={tasks.length}
              />
            ))}
          </div>
        </section>

        <section className="workbench-panel overflow-hidden">
          <SectionHeader
            title={t('workspace.reports.priorityTitle')}
            meta={t('workspace.reports.priorityMeta')}
          />
          <div className="grid gap-4 border-t border-[var(--workbench-border)] p-5">
            {priorityItems.map((item) => (
              <ReportDistributionRow
                count={item.count}
                key={item.id}
                label={item.label}
                toneClassName={workspacePresentation.resolveReportPriorityToneClassName(item.id)}
                total={openTasks.length}
              />
            ))}
          </div>
        </section>
      </div>

      <section className="workbench-table overflow-hidden">
        <div className="grid gap-4 p-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--workbench-text)]">
                {t('workspace.reports.projectsTitle')}
              </h2>
              <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
                {t('workspace.reports.projectsMeta')
                  .replace('{visible}', String(filteredProjectRows.length))
                  .replace('{total}', String(projectRows.length))}
              </p>
            </div>
            <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-white px-3 text-sm font-semibold text-[var(--workbench-text)]">
              <input
                checked={showAttentionOnly}
                className="h-4 w-4 accent-[var(--workbench-primary)]"
                data-testid="reports-attention-only"
                type="checkbox"
                onChange={(event) => setShowAttentionOnly(event.target.checked)}
              />
              {t('workspace.reports.attentionOnly')}
            </label>
          </div>
          <label className="grid max-w-[520px] gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
            {t('workspace.reports.projectSearchLabel')}
            <input
              aria-label={t('workspace.reports.projectSearchLabel')}
              className="workbench-input min-h-11 px-3 normal-case tracking-normal"
              data-testid="reports-project-search"
              placeholder={t('workspace.reports.projectSearchPlaceholder')}
              type="search"
              value={projectSearchQuery}
              onChange={(event) => setProjectSearchQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
          <table className="w-full min-w-[980px] border-collapse text-left" data-testid="reports-project-table">
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">{t('workspace.column.project')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.team')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.progress')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.open')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.review')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.attention')}</th>
                <th className="px-5 py-3 text-right" scope="col">{t('workspace.reports.column.action')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjectRows.map((project) => (
                <tr
                  className="border-b border-[var(--workbench-border)] text-sm font-medium text-[var(--workbench-text)] last:border-b-0"
                  data-testid={`reports-project-${workspacePresentation.createWorkspaceTaskTestToken(`${project.teamId}-${project.projectId}`)}`}
                  key={`${project.teamId}-${project.projectId}`}
                >
                  <td className="px-5 py-4 font-semibold">{project.name}</td>
                  <td className="px-5 py-4 text-[var(--workbench-muted)]">{project.teamName}</td>
                  <td className="min-w-[170px] px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className="min-w-[110px] flex-1">
                        <ProgressBar
                          label={`${project.name} ${t('workspace.column.progress')}`}
                          value={project.progress}
                        />
                      </div>
                      <span className="text-xs font-semibold tabular-nums text-[var(--workbench-muted)]">
                        {project.progress}%
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4 tabular-nums">{project.openTaskCount}</td>
                  <td className="px-5 py-4 tabular-nums">{project.reviewTaskCount}</td>
                  <td className="px-5 py-4">
                    <span className={project.attentionTaskCount > 0 ? 'workbench-badge-danger' : 'workbench-badge-success'}>
                      {project.attentionTaskCount}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button
                      className="workbench-button-secondary min-h-9 px-3"
                      disabled={!onSelectProject}
                      onClick={() => onSelectProject?.(project.projectId, project.teamId)}
                      type="button"
                    >
                      {t('workspace.reports.openProject')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredProjectRows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm font-semibold text-[var(--workbench-muted)]">
              {t('workspace.reports.emptyProjects')}
            </p>
          ) : null}
        </div>
      </section>

      <section className="workbench-panel overflow-hidden">
        <SectionHeader
          title={t('workspace.reports.attentionTitle')}
          meta={t('workspace.reports.attentionMeta')}
        />
        <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
          {attentionTasks.slice(0, 6).map((task) => (
            <TaskListRow
              key={workspacePresentation.createWorkspaceTaskKey(task)}
              t={t}
              task={task}
              onOpenTask={onOpenTask}
            />
          ))}
          {attentionTasks.length === 0 ? (
            <p className="px-5 py-8 text-sm font-semibold text-[var(--workbench-muted)]">
              {t('workspace.empty.tasks')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function ReportDistributionRow({
  count,
  label,
  toneClassName,
  total,
}: {
  count: number
  label: string
  toneClassName: string
  total: number
}) {
  const percentage = total > 0 ? Math.round((count / total) * 100) : 0

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-semibold text-[var(--workbench-text)]">{label}</span>
        <span className="text-sm font-semibold tabular-nums text-[var(--workbench-muted)]">
          {count} · {percentage}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--workbench-surface-muted)]">
        <div
          className={`h-full rounded-full ${toneClassName}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}
