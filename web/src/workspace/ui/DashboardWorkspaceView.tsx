import type {
  PlanningHealth,
  PlanningUpdateState,
  PlanningUpdateTargetSummary,
  ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
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
  createWorkspaceActionQueue,
  createWorkspacePortfolioProjects,
  createWorkspaceTaskKey,
  resolveWorkspaceTaskConfiguration,
  type WorkspacePortfolioProject,
  type WorkspaceSummary,
} from '../../work-items/model/workspaceWorkItems'
import { TaskListRow } from '../../work-items/ui/WorkspaceWorkItemPrimitives'
import { formatPlanningUpdateDate } from '../../planning/model/date'

/**
 * Props for the Workspace dashboard view.
 */
export type DashboardWorkspaceViewProps = {
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
  /** Project update cadence/latest projections from the Planning snapshot. */
  planningUpdateTargets?: readonly PlanningUpdateTargetSummary[]
  /** Non-blocking message shown when Planning update projections could not be loaded. */
  planningUpdatesErrorMessage?: string
  /** Opens the selected Project's Planning update detail. */
  onOpenPlanningUpdate?: (teamId: string, projectId: string) => void
}

/** Existing badge tokens used for update-delivery freshness. */
const updateStateClassNames: Record<PlanningUpdateState, string> = {
  'not-configured': 'border-slate-200 bg-slate-50 text-slate-600',
  missing: 'border-slate-300 bg-white text-slate-700',
  current: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  stale: 'border-amber-200 bg-amber-50 text-amber-800',
  overdue: 'border-red-200 bg-red-50 text-red-700',
}

/** Existing badge tokens used for reported health. */
const updateHealthClassNames: Record<PlanningHealth, string> = {
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
  'on-track': 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'at-risk': 'border-amber-200 bg-amber-50 text-amber-800',
  'off-track': 'border-red-200 bg-red-50 text-red-700',
}

/** Translation keys for Planning update freshness on the dashboard. */
const updateStateMessageKeys: Record<PlanningUpdateState, MessageKey> = {
  'not-configured': 'workspace.planningUpdate.state.notConfigured',
  missing: 'workspace.planningUpdate.state.missing',
  current: 'workspace.planningUpdate.state.current',
  stale: 'workspace.planningUpdate.state.stale',
  overdue: 'workspace.planningUpdate.state.overdue',
}

/** Translation keys for latest reported health on the dashboard. */
const updateHealthMessageKeys: Record<PlanningHealth, MessageKey> = {
  unknown: 'workspace.planningUpdate.health.unknown',
  'on-track': 'workspace.planningUpdate.health.onTrack',
  'at-risk': 'workspace.planningUpdate.health.atRisk',
  'off-track': 'workspace.planningUpdate.health.offTrack',
}

/** Finds a Team-qualified Project update projection without cross-Team ID collisions. */
function findProjectUpdateTarget(
  targets: readonly PlanningUpdateTargetSummary[],
  teamId: string,
  projectId: string,
) {
  return targets.find((candidate) =>
    candidate.target.type === 'project' &&
    candidate.target.teamId === teamId &&
    candidate.target.projectId === projectId
  )
}

/** Returns the compact ISO calendar date used by the dense portfolio ledger. */
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
  onOpenTask,
  onOpenPlanningUpdate,
  planningUpdateTargets = [],
  planningUpdatesErrorMessage,
  summary,
  t,
  tasks,
  teams,
  workItemConfigurationsByTeam,
}: DashboardWorkspaceViewProps) {
  const referenceDate = new Date()
  const decisionTasks = createWorkspaceActionQueue(tasks, referenceDate).slice(0, 5)
  const projects = createWorkspacePortfolioProjects(teams, tasks)
  const reportingAttentionCount = projects.filter((project) => {
    const update = findProjectUpdateTarget(
      planningUpdateTargets,
      project.teamId,
      project.projectId,
    )
    return !update || update.updateState === 'not-configured' || update.updateState === 'missing' ||
      update.updateState === 'stale' || update.updateState === 'overdue'
  }).length

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-5 gap-4 max-[1320px]:grid-cols-3 max-[900px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="teal" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.reports.metric.completion')} value={`${calculateWorkspaceProgress(tasks)}%`} tone="amber" />
        <MetricCard
          label={t('workspace.planningUpdate.metric.attention')}
          testId="dashboard-update-attention"
          tone={reportingAttentionCount > 0 ? 'red' : 'emerald'}
          value={reportingAttentionCount}
        />
      </div>

      {planningUpdatesErrorMessage ? (
        <p
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"
          role="status"
        >
          {planningUpdatesErrorMessage}
        </p>
      ) : null}

      <section className="workbench-table overflow-hidden">
        <SectionHeader title={t('workspace.dashboard.portfolioTitle')} meta={t('workspace.dashboard.portfolioMeta')} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-full border-collapse text-left min-[761px]:min-w-[1180px]">
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">{t('workspace.column.project')}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{t('workspace.column.team')}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{t('workspace.column.progress')}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{t('workspace.column.risk')}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{t('workspace.planningUpdate.column.health')}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{t('workspace.planningUpdate.column.freshness')}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{t('workspace.planningUpdate.column.latest')}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{t('workspace.planningUpdate.column.nextDue')}</th>
              </tr>
            </thead>
            <tbody>
              {projects.slice(0, 6).map((project) => {
                const updateTarget = findProjectUpdateTarget(
                  planningUpdateTargets,
                  project.teamId,
                  project.projectId,
                )
                const updateState = updateTarget?.updateState ?? 'not-configured'
                const health = updateTarget?.latestUpdate?.health ?? 'unknown'
                const nextDueAt = updateTarget?.cadence?.nextDueAt
                const nextDueTimeZone = updateTarget?.cadence?.timeZone
                return (
                  <tr
                    className="border-b border-slate-100 text-sm font-medium text-[var(--workbench-text)]"
                    key={`${project.teamId}\0${project.projectId}`}
                  >
                    <td className="w-full px-5 py-4">
                      {onOpenPlanningUpdate ? (
                        <button
                          className="min-h-10 rounded-md text-left font-semibold underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)] focus:ring-offset-2"
                          type="button"
                          onClick={() => onOpenPlanningUpdate(project.teamId, project.projectId)}
                        >
                          {project.name}
                        </button>
                      ) : <span className="font-semibold">{project.name}</span>}
                      <p className="mt-1 hidden truncate text-xs text-[var(--workbench-muted)] max-[760px]:block">
                        {project.teamName}
                      </p>
                      <div
                        className="mt-3 hidden min-w-0 gap-2 max-[760px]:grid"
                        data-testid={`dashboard-update-summary-${project.teamId}-${project.projectId}`}
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${updateHealthClassNames[health]}`}>
                            {t(updateHealthMessageKeys[health])}
                          </span>
                          <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${updateStateClassNames[updateState]}`}>
                            {t(updateStateMessageKeys[updateState])}
                          </span>
                        </div>
                        {updateTarget?.latestUpdate ? (
                          <div className="grid min-w-0 gap-0.5">
                            <p className="truncate text-xs font-semibold">{updateTarget.latestUpdate.summary}</p>
                            <p className="truncate text-xs text-[var(--workbench-muted)]">
                              {updateTarget.latestUpdate.authorMemberKey} ·{' '}
                              <time dateTime={updateTarget.latestUpdate.createdAt}>
                                {formatPlanningUpdateDate(
                                  updateTarget.latestUpdate.createdAt,
                                  updateTarget.cadence?.timeZone,
                                )}
                              </time>
                            </p>
                          </div>
                        ) : <span className="text-xs text-[var(--workbench-muted)]">—</span>}
                        <p className="text-xs font-medium tabular-nums text-[var(--workbench-muted)]">
                          {t('workspace.planningUpdate.column.nextDue')}: {' '}
                          {nextDueAt ? (
                            <time dateTime={nextDueAt}>
                              {formatPlanningUpdateDate(nextDueAt, nextDueTimeZone)}
                            </time>
                          ) : (
                            formatPlanningUpdateDate(undefined, nextDueTimeZone)
                          )}
                        </p>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-[var(--workbench-muted)] max-[760px]:hidden">{project.teamName}</td>
                    <td className="px-5 py-4 max-[760px]:hidden">
                      <ProgressBar
                        label={`${project.name} ${t('workspace.column.progress')}`}
                        value={project.progress}
                      />
                    </td>
                    <td className="px-5 py-4 max-[760px]:hidden">{t(resolvePortfolioRiskMessageKey(project.risk))}</td>
                    <td className="px-5 py-4 max-[760px]:hidden">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${updateHealthClassNames[health]}`}>
                        {t(updateHealthMessageKeys[health])}
                      </span>
                    </td>
                    <td className="px-5 py-4 max-[760px]:hidden">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${updateStateClassNames[updateState]}`}>
                        {t(updateStateMessageKeys[updateState])}
                      </span>
                    </td>
                    <td className="max-w-[240px] px-5 py-4 max-[760px]:hidden">
                      {updateTarget?.latestUpdate ? (
                        <div className="grid gap-1">
                          <p className="truncate font-semibold">{updateTarget.latestUpdate.summary}</p>
                          <p className="text-xs text-[var(--workbench-muted)]">
                            {updateTarget.latestUpdate.authorMemberKey} ·{' '}
                            <time dateTime={updateTarget.latestUpdate.createdAt}>
                              {formatPlanningUpdateDate(
                                updateTarget.latestUpdate.createdAt,
                                updateTarget.cadence?.timeZone,
                              )}
                            </time>
                          </p>
                        </div>
                      ) : <span className="text-[var(--workbench-muted)]">—</span>}
                    </td>
                    <td className="px-5 py-4 tabular-nums text-[var(--workbench-muted)] max-[760px]:hidden">
                      {nextDueAt ? (
                        <time dateTime={nextDueAt}>
                          {formatPlanningUpdateDate(nextDueAt, nextDueTimeZone)}
                        </time>
                      ) : (
                        formatPlanningUpdateDate(undefined, nextDueTimeZone)
                      )}
                    </td>
                  </tr>
                )
              })}
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
              configuration={resolveWorkspaceTaskConfiguration(task, workItemConfigurationsByTeam)}
              key={createWorkspaceTaskKey(task)}
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
