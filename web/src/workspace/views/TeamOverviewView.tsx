import type { MessageKey } from '../../i18n'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { ProjectTask } from '../../tasks/api'
import { workspacePresentation } from '../workspacePresentation'
import type { TeamProjectMemberAccess } from '../workspaceTypes'
import {
  MetricCard,
  ProgressBar,
  SectionHeader,
  TeamMembersNotice,
} from './WorkspaceViewComponents'

/**
 * 選択中 Team のプロジェクト指標を描画します。
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
}: {
  isTeamProjectMembersLoading: boolean
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  team?: ProjectDirectoryTeam
  teamProjectMembers: TeamProjectMemberAccess[]
  teamProjectMembersFailedProjectIds: string[]
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  const projects = team?.projects ?? []
  const projectIds = projects.map((project) => project.id)
  const teamTasks = workspacePresentation.filterTasksByTeamProjectIds(tasks, projectIds, team?.id)
  const projectSummaries = workspacePresentation.createTeamProjectSummaries(projects, tasks, teamProjectMembers, team?.id)
  const memberCount = workspacePresentation.countUniqueTeamMembers(teamProjectMembers)
  const attentionTaskCount = teamTasks.filter(workspacePresentation.isAttentionWorkspaceTask).length

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
          value={teamTasks.filter((task) => task.status !== 'done').length}
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
          <table className="w-full min-w-[980px] border-collapse text-left" data-testid="team-overview-project-table">
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.project')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.progress')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.open')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.review')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.attention')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.members')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.nextAction')}</th>
              </tr>
            </thead>
            <tbody>
              {projectSummaries.map((project) => (
                <tr
                  className="border-b border-slate-100 align-top text-sm font-medium text-[var(--workbench-text)] last:border-b-0"
                  data-testid={`team-overview-project-${workspacePresentation.createWorkspaceTaskTestToken(project.id)}`}
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
                    <span className={project.attentionTaskCount > 0 ? 'workbench-badge-danger' : 'workbench-badge-success'}>
                      {project.attentionTaskCount}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <div className="grid gap-1">
                      <span>{t('workspace.teamOverview.memberCount').replace('{count}', String(project.memberCount))}</span>
                      <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                        {t('workspace.teamOverview.managerCount').replace('{count}', String(project.managerCount))}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    {project.nextTask ? (
                      <button
                        className="grid max-w-[280px] gap-1 text-left hover:text-[var(--workbench-primary)] disabled:hover:text-[var(--workbench-text)]"
                        disabled={!onOpenTask || !workspacePresentation.isOpenableWorkspaceTask(project.nextTask)}
                        type="button"
                        onClick={() => onOpenTask?.(project.nextTask as ProjectTask)}
                      >
                        <span className="line-clamp-2 font-semibold">
                          {workspacePresentation.resolveTaskTitle(project.nextTask, t)}
                        </span>
                        <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                          {project.nextTask.dueDate} / {t(`tasks.status.${project.nextTask.status}`)}
                        </span>
                      </button>
                    ) : (
                      <span className="text-sm font-semibold text-[var(--workbench-muted)]">
                        {t('workspace.teamOverview.noNextAction')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
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
