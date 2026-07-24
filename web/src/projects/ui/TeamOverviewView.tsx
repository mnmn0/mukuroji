import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  MetricCard,
  ProgressBar,
  SectionHeader,
} from '../../shared/ui/WorkbenchPrimitives'
import type { ProjectTask } from '../../tasks/api'
import {
  isOpenWorkItem,
  resolveWorkItemTitle,
  resolveWorkItemWorkflowStatusLabel,
} from '../../work-items/model/workItemDisplay'
import {
  filterTasksByTeamProjectIds,
  isAttentionWorkspaceTask,
  isOpenableWorkspaceTask,
  resolveWorkspaceTaskConfiguration,
} from '../../work-items/model/workspaceWorkItems'
import { createWorkspaceTaskTestToken } from '../../work-items/ui/WorkspaceWorkItemPrimitives'
import type { ProjectDirectoryTeam } from '../api/directory'
import {
  countUniqueTeamMembers,
  createTeamProjectSummaries,
  type TeamProjectMemberAccess,
} from '../model/teamInsights'

/**
 * Props for the pure Team overview view.
 */
export type TeamOverviewViewProps = {
  /** Whether Project member data is still loading. */
  isTeamProjectMembersLoading: boolean
  /** Opens a Work Item selected as the next Project action. */
  onOpenTask?: (task: ProjectTask) => void
  /** Opens a Project selected from the Team overview. */
  onSelectProject?: (projectId: string, teamId: string) => void
  /** The Team represented by this overview, when it exists. */
  team?: ProjectDirectoryTeam
  /** Member records collected from Projects in the Team. */
  teamProjectMembers: readonly TeamProjectMemberAccess[]
  /** Project IDs whose member requests failed. */
  teamProjectMembersFailedProjectIds: readonly string[]
  /** Resolves localized Workspace labels. */
  t: (key: MessageKey) => string
  /** Workspace Work Items used by Team summaries. */
  tasks: readonly ProjectTask[]
  /** Resolved Work Item configurations keyed by Team ID. */
  workItemConfigurationsByTeam: Readonly<
    Record<string, ResolvedWorkItemConfiguration>
  >
}

/**
 * Renders Team-level Project, Work Item, and member summaries.
 *
 * @param props - Team overview data, actions, and localized labels.
 * @returns The pure Team overview view.
 */
export function TeamOverviewView({
  isTeamProjectMembersLoading,
  onOpenTask,
  onSelectProject,
  team,
  teamProjectMembers,
  teamProjectMembersFailedProjectIds,
  t,
  tasks,
  workItemConfigurationsByTeam,
}: TeamOverviewViewProps) {
  const referenceDate = new Date()
  const projects = team?.projects ?? []
  const projectIds = projects.map((project) => project.id)
  const teamTasks = filterTasksByTeamProjectIds(tasks, projectIds, team?.id)
  const projectSummaries = createTeamProjectSummaries(
    projects,
    tasks,
    teamProjectMembers,
    referenceDate,
    team?.id,
  )
  const memberCount = countUniqueTeamMembers(teamProjectMembers)
  const attentionTaskCount = teamTasks.filter((task) =>
    isAttentionWorkspaceTask(task, referenceDate)
  ).length

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard
          label={t('workspace.metric.projects')}
          testId="team-overview-projects"
          value={projects.length}
          tone="teal"
        />
        <MetricCard
          label={t('workspace.metric.openTasks')}
          testId="team-overview-open-tasks"
          value={teamTasks.filter((task) => isOpenWorkItem(task)).length}
          tone="emerald"
        />
        <MetricCard
          label={t('workspace.metric.blocked')}
          testId="team-overview-blocked"
          value={attentionTaskCount}
          tone="red"
        />
        <MetricCard
          label={t('workspace.teamOverview.memberMetric')}
          testId="team-overview-members"
          value={memberCount}
          tone="amber"
        />
      </div>

      <TeamMembersNotice
        failedProjectIds={teamProjectMembersFailedProjectIds}
        isLoading={isTeamProjectMembersLoading}
        t={t}
      />

      <section className="workbench-table overflow-hidden">
        <SectionHeader
          title={t('workspace.teamOverview.projectsTitle')}
          meta={team?.name ?? t('workspace.team.missing')}
        />
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[980px] border-collapse text-left"
            data-testid="team-overview-project-table"
          >
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">
                  {t('workspace.teamOverview.column.project')}
                </th>
                <th className="px-5 py-3" scope="col">
                  {t('workspace.teamOverview.column.progress')}
                </th>
                <th className="px-5 py-3" scope="col">
                  {t('workspace.teamOverview.column.open')}
                </th>
                <th className="px-5 py-3" scope="col">
                  {t('workspace.teamOverview.column.review')}
                </th>
                <th className="px-5 py-3" scope="col">
                  {t('workspace.teamOverview.column.attention')}
                </th>
                <th className="px-5 py-3" scope="col">
                  {t('workspace.teamOverview.column.members')}
                </th>
                <th className="px-5 py-3" scope="col">
                  {t('workspace.teamOverview.column.nextAction')}
                </th>
              </tr>
            </thead>
            <tbody>
              {projectSummaries.map((project) => {
                const nextTask = project.nextTask

                return (
                  <tr
                    className="border-b border-slate-100 align-top text-sm font-medium text-[var(--workbench-text)] last:border-b-0"
                    data-testid={`team-overview-project-${createWorkspaceTaskTestToken(project.id)}`}
                    key={project.id}
                  >
                    <td className="px-5 py-4">
                      <div className="min-w-[180px]">
                        <p className="font-semibold">{project.name}</p>
                        <button
                          className="mt-2 text-xs font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
                          type="button"
                          onClick={() => {
                            if (team) {
                              onSelectProject?.(project.id, team.id)
                            }
                          }}
                        >
                          {t('workspace.teamOverview.openProject')}
                        </button>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="grid min-w-[160px] gap-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                            {project.progress}%
                          </span>
                        </div>
                        <ProgressBar
                          label={`${project.name} ${t('workspace.teamOverview.column.progress')}`}
                          value={project.progress}
                        />
                      </div>
                    </td>
                    <td className="px-5 py-4">{project.openTaskCount}</td>
                    <td className="px-5 py-4">{project.reviewTaskCount}</td>
                    <td className="px-5 py-4">
                      <span
                        className={project.attentionTaskCount > 0
                          ? 'workbench-badge-danger'
                          : 'workbench-badge-success'}
                      >
                        {project.attentionTaskCount}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="grid gap-1">
                        <span>
                          {t('workspace.teamOverview.memberCount').replace(
                            '{count}',
                            String(project.memberCount),
                          )}
                        </span>
                        <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                          {t('workspace.teamOverview.managerCount').replace(
                            '{count}',
                            String(project.managerCount),
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      {nextTask ? (
                        <button
                          className="grid max-w-[280px] gap-1 text-left hover:text-[var(--workbench-primary)] disabled:hover:text-[var(--workbench-text)]"
                          disabled={!onOpenTask || !isOpenableWorkspaceTask(nextTask)}
                          type="button"
                          onClick={() => onOpenTask?.(nextTask)}
                        >
                          <span className="line-clamp-2 font-semibold">
                            {resolveWorkItemTitle(nextTask)}
                          </span>
                          <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                            {nextTask.dueDate} / {resolveWorkItemWorkflowStatusLabel(
                              nextTask,
                              resolveWorkspaceTaskConfiguration(
                                nextTask,
                                workItemConfigurationsByTeam,
                              ),
                            )}
                          </span>
                        </button>
                      ) : (
                        <span className="text-sm font-semibold text-[var(--workbench-muted)]">
                          {t('workspace.teamOverview.noNextAction')}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {projectSummaries.length === 0 ? (
            <p className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]">
              {t('workspace.teamOverview.emptyProjects')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

/**
 * Props for the Team member loading and partial-error notice.
 */
export type TeamMembersNoticeProps = {
  /** Project IDs whose member requests failed. */
  failedProjectIds: readonly string[]
  /** Whether Project member data is still loading. */
  isLoading: boolean
  /** Resolves localized Workspace labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders Team member loading or partial-error feedback when applicable.
 *
 * @param props - Team member request state and localized labels.
 * @returns A loading notice, a partial-error notice, or nothing.
 */
export function TeamMembersNotice({
  failedProjectIds,
  isLoading,
  t,
}: TeamMembersNoticeProps) {
  if (isLoading) {
    return (
      <p className="rounded-lg border border-[#99d7cf] bg-[#e5f7f4] px-4 py-3 text-sm font-semibold text-[var(--workbench-primary)]">
        {t('workspace.members.loading')}
      </p>
    )
  }

  if (failedProjectIds.length === 0) {
    return null
  }

  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
      {t('workspace.members.partialError').replace(
        '{count}',
        String(failedProjectIds.length),
      )}
    </p>
  )
}
