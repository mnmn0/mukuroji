import { useMemo, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../../../projects/api'
import type { ProjectTask } from '../../../tasks/api'
import { workspacePresentation } from '../presentation'
import type {
  TeamMemberRoleFilter,
  TeamProjectMemberAccess,
} from '../types'
import {
  MetricCard,
  ProgressBar,
  SectionHeader,
  TeamMembersNotice,
} from './WorkspaceViewComponents'

/**
 * 選択中 Team のメンバーディレクトリを描画します。
 */
export function TeamMembersView({
  isTeamProjectMembersLoading,
  onSelectProject,
  team,
  teamProjectMembers,
  teamProjectMembersFailedProjectIds,
  t,
  tasks,
}: {
  isTeamProjectMembersLoading: boolean
  onSelectProject?: (projectId: string, teamId: string) => void
  team?: ProjectDirectoryTeam
  teamProjectMembers: TeamProjectMemberAccess[]
  teamProjectMembersFailedProjectIds: string[]
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<TeamMemberRoleFilter>('all')
  const members = useMemo(
    () => workspacePresentation.createTeamMemberRows(
      team?.projects ?? [],
      tasks,
      teamProjectMembers,
      team?.id,
      t,
    ),
    [team?.projects, tasks, teamProjectMembers, team?.id, t],
  )
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const filteredMembers = members.filter((member) => {
    const matchesRole = roleFilter === 'all' || member.role === roleFilter
    const matchesSearch = normalizedSearchQuery.length === 0 ||
      member.name.toLowerCase().includes(normalizedSearchQuery) ||
      member.email.toLowerCase().includes(normalizedSearchQuery) ||
      member.projectAccess.some((project) =>
        project.projectName.toLowerCase().includes(normalizedSearchQuery),
      )

    return matchesRole && matchesSearch
  })
  const managerCount = members.filter((member) => member.role === 'manager').length
  const openTaskCount = members.reduce((total, member) => total + member.openTaskCount, 0)
  const attentionTaskCount = members.reduce(
    (total, member) => total + member.attentionTaskCount,
    0,
  )

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.members.metric.members')} value={members.length} tone="teal" />
        <MetricCard label={t('workspace.members.metric.managers')} value={managerCount} tone="amber" />
        <MetricCard label={t('workspace.reports.metric.attention')} value={attentionTaskCount} tone="red" />
        <MetricCard label={t('workspace.members.metric.open')} value={openTaskCount} tone="emerald" />
      </div>

      <TeamMembersNotice
        failedProjectIds={teamProjectMembersFailedProjectIds}
        isLoading={isTeamProjectMembersLoading}
        t={t}
      />

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <div className="border-b border-slate-100">
          <SectionHeader title={t('workspace.members.directoryTitle')} meta={team?.name ?? t('workspace.team.missing')} />
          <div className="grid grid-cols-[minmax(0,1fr)_220px] gap-3 px-5 pb-5 max-[760px]:grid-cols-1">
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {t('workspace.members.searchLabel')}
              <input
                className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold normal-case tracking-normal text-[var(--workbench-text)] outline-none transition placeholder:text-slate-400 focus:border-[#6fbfb4] focus:ring-4 focus:ring-[#dff5f1]"
                data-testid="team-members-search"
                placeholder={t('workspace.members.searchPlaceholder')}
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {t('workspace.members.roleFilter')}
              <select
                className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold normal-case tracking-normal text-[var(--workbench-text)] outline-none transition focus:border-[#6fbfb4] focus:ring-4 focus:ring-[#dff5f1]"
                data-testid="team-members-role-filter"
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value as TeamMemberRoleFilter)}
              >
                <option value="all">{t('workspace.members.role.all')}</option>
                <option value="manager">{t('workspace.permissions.role.manager')}</option>
                <option value="member">{t('workspace.permissions.role.member')}</option>
                <option value="viewer">{t('workspace.permissions.role.viewer')}</option>
              </select>
            </label>
          </div>
        </div>

        <div className="grid divide-y divide-slate-100" data-testid="team-members-directory">
          {filteredMembers.map((member) => (
            <div
              className="grid grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_minmax(260px,1fr)] items-center gap-5 p-5 max-[980px]:grid-cols-1"
              data-testid={`team-member-row-${workspacePresentation.createWorkspaceTaskTestToken(member.id)}`}
              key={member.id}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-[#0d1833]">{member.name}</p>
                  <span className="workbench-badge">
                    {member.role ? t(`workspace.permissions.role.${member.role}`) : t('workspace.members.role.none')}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm font-medium text-[var(--workbench-muted)]">{member.email}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {member.projectAccess.map((project) => (
                    <button
                      className="rounded-full border border-[#99d7cf] bg-[#e5f7f4] px-3 py-1 text-xs font-semibold text-[var(--workbench-primary)] transition hover:bg-[#d6f0ec]"
                      data-testid={`team-member-project-${workspacePresentation.createWorkspaceTaskTestToken(member.id)}-${workspacePresentation.createWorkspaceTaskTestToken(project.projectId)}`}
                      key={project.projectId}
                      type="button"
                      onClick={() => {
                        if (team) {
                          onSelectProject?.(project.projectId, team.id)
                        }
                      }}
                    >
                      {project.projectName}
                    </button>
                  ))}
                  {member.projectAccess.length === 0 ? (
                    <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                      {t('workspace.members.noProjects')}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#69758a]">
                    {t('workspace.members.metric.open')}
                  </p>
                  <p className="text-sm font-semibold text-[#0d1833]">{member.openPercent}%</p>
                </div>
                <ProgressBar
                  label={`${member.name} ${t('workspace.members.metric.open')}`}
                  value={member.openPercent}
                />
                <p className="text-xs font-semibold text-[var(--workbench-muted)]">
                  {member.nextDueDate
                    ? t('workspace.members.nextDue').replace('{date}', member.nextDueDate)
                    : t('workspace.members.noAssignedTasks')}
                </p>
              </div>
              <div className="grid gap-2 text-sm font-bold leading-6 text-[#526381]">
                <p>{t('workspace.members.taskCount').replace('{count}', String(member.taskCount))}</p>
                <div className="flex flex-wrap gap-2">
                  <span className="workbench-badge">
                    {t('workspace.members.openTaskCount').replace('{count}', String(member.openTaskCount))}
                  </span>
                  <span className="workbench-badge-warning">
                    {t('workspace.members.reviewTaskCount').replace('{count}', String(member.reviewTaskCount))}
                  </span>
                  <span className={member.attentionTaskCount > 0 ? 'workbench-badge-danger' : 'workbench-badge-success'}>
                    {t('workspace.members.attentionTaskCount').replace('{count}', String(member.attentionTaskCount))}
                  </span>
                </div>
              </div>
            </div>
          ))}
          {filteredMembers.length === 0 ? (
            <p className="px-5 py-8 text-sm font-bold text-[#526381]">
              {t('workspace.members.empty')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
