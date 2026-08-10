import type {
  FocusQueueResponse,
  ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import { getFocusQueueItems } from '../../features/focus-queue/model/focusQueue'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  MetricCard,
  ProgressBar,
  SectionHeader,
} from '../../shared/ui/WorkbenchPrimitives'
import type { ProjectTask } from '../../tasks/api'
import {
  calculateWorkspaceProgress,
  createWorkspacePortfolioProjects,
  resolveWorkspaceTaskConfiguration,
  type WorkspacePortfolioProject,
  type WorkspaceSummary,
} from '../../work-items/model/workspaceWorkItems'
import { TaskListRow } from '../../work-items/ui/WorkspaceWorkItemPrimitives'

/**
 * Props for the Workspace dashboard view.
 */
export type DashboardWorkspaceViewProps = {
  /** Server-ranked Focus queue used by the decision preview. */
  focusQueue?: FocusQueueResponse
  /** Whether Focus metrics and previews are unavailable rather than empty. */
  isFocusUnavailable?: boolean
  /** Optional callback that opens a selected Work Item. */
  onOpenTask?: (task: ProjectTask) => void
  /** Summary metrics displayed at the top of the dashboard. */
  summary: WorkspaceSummary
  /** Translator used for dashboard labels. */
  t: (key: MessageKey) => string
  /** Workspace Work Items used for progress and decision queues. */
  tasks: readonly ProjectTask[]
  /** Workspace directory used to build portfolio rows. */
  teams: readonly ProjectDirectoryTeam[]
  /** Resolved Work Item configurations indexed by Team ID. */
  workItemConfigurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
}

/**
 * Maps a portfolio risk value to its translated Workspace message key.
 *
 * @param risk - Portfolio risk returned by the Workspace Work Item model.
 * @returns Translation key for the risk label.
 */
function resolvePortfolioRiskMessageKey(
  risk: WorkspacePortfolioProject['risk'],
): MessageKey {
  const riskMessageKeys: Record<WorkspacePortfolioProject['risk'], MessageKey> = {
    clear: 'workspace.risk.clear',
    low: 'workspace.risk.low',
    watch: 'workspace.risk.watch',
  }

  return riskMessageKeys[risk]
}

/**
 * Renders Workspace portfolio metrics, progress, and the decision queue.
 *
 * @param props - Workspace summary, directory, Work Items, and optional task action.
 * @returns The Workspace dashboard view.
 */
export function DashboardWorkspaceView({
  focusQueue,
  isFocusUnavailable = false,
  onOpenTask,
  summary,
  t,
  tasks,
  teams,
  workItemConfigurationsByTeam,
}: DashboardWorkspaceViewProps) {
  const decisionTasks = [
    ...getFocusQueueItems(focusQueue, 'now'),
    ...getFocusQueueItems(focusQueue, 'next'),
  ].slice(0, 5)
  const projects = createWorkspacePortfolioProjects(teams, tasks)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="teal" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard
          label={t('workspace.metric.blocked')}
          srValue={isFocusUnavailable ? t('workspace.focus.previewUnavailable') : undefined}
          testId="workspace-focus-blocked-metric"
          value={isFocusUnavailable ? '—' : summary.blocked}
          tone="red"
        />
        <MetricCard label={t('workspace.reports.metric.completion')} value={`${calculateWorkspaceProgress(tasks)}%`} tone="amber" />
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
                  <td className="px-5 py-4">{t(resolvePortfolioRiskMessageKey(project.risk))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="workbench-panel">
        <SectionHeader
          title={t('workspace.dashboard.decisionTitle')}
          meta={isFocusUnavailable
            ? undefined
            : t('workspace.dashboard.decisionMeta').replace(
                '{count}',
                String(decisionTasks.length),
              )}
        />
        <div className="divide-y divide-slate-100">
          {decisionTasks.map((item) => (
            <TaskListRow
              configuration={resolveWorkspaceTaskConfiguration(item.workItem, workItemConfigurationsByTeam)}
              key={item.id}
              t={t}
              task={item.workItem}
              onOpenTask={onOpenTask}
            />
          ))}
          {isFocusUnavailable ? (
            <p
              className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]"
              data-testid="workspace-focus-preview-unavailable"
            >
              {t('workspace.focus.previewUnavailable')}
            </p>
          ) : decisionTasks.length === 0 ? (
            <p className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]">
              {t('workspace.empty.tasks')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
