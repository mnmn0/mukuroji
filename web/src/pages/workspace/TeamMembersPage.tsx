import { useMemo, useState } from 'react'
import { useParams } from 'react-router'
import type { CapacityPlanningGranularity } from '@mukuroji/contracts'
import { useWorkspaceWorkItems } from '../../issues/queries/useWorkItems'
import type { ProjectDirectoryProject } from '../../projects/api'
import { useWorkspaceProjectMembers } from '../../projects/queries/useProjectMembers'
import { TeamMembersView } from '../../projects/ui/TeamMembersView'
import { createTranslator } from '../../shared/i18n/i18n'
import type { ProjectTask } from '../../tasks/api'
import { getUniqueWorkspaceProjectIds } from '../../work-items/model/workspaceWorkItems'
import { WorkspaceTaskLoadNotice } from '../../workspace/ui/WorkspaceDataNotices'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'
import { useTeamWorkload } from '../../workload/queries/useTeamWorkload'
import { TeamWorkloadView } from '../../workload/ui/TeamWorkloadView'

const emptyTeamProjects: ProjectDirectoryProject[] = []
const emptyWorkspaceTasks: ProjectTask[] = []

/**
 * Renders the URL-specific Team member directory route.
 *
 * @returns Team member content rendered inside the shared Workspace shell.
 */
export function TeamMembersPage() {
  const workspace = useWorkspaceRouteContext()
  const params = useParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const activeTeam = workspace.teams.find((team) => team.id === params.teamId)
  const projects = activeTeam?.projects ?? emptyTeamProjects
  const workItems = useWorkspaceWorkItems(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  const tasks = workItems.data ?? emptyWorkspaceTasks
  const projectMembers = useWorkspaceProjectMembers(
    workspace.accessToken,
    activeTeam?.id,
    projects,
    workspace.canLoadWorkspaceData && Boolean(activeTeam),
  )
  const [granularity, setGranularity] = useState<CapacityPlanningGranularity>('day')
  const workload = useTeamWorkload(
    workspace.accessToken,
    activeTeam?.id,
    granularity,
    workspace.canLoadWorkspaceData && Boolean(activeTeam),
  )
  const failedProjectCount = workItems.error
    ? getUniqueWorkspaceProjectIds(workspace.teams).length
    : 0

  return (
    <WorkspaceRouteContent
      isLoading={Boolean(workItems.key && workItems.isLoading)}
      sessionErrors={[
        workItems.error,
        projectMembers.error,
        ...(projectMembers.data?.errors ?? []),
        workload.error,
      ]}
    >
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice failedProjectCount={failedProjectCount} t={t} />
        <TeamMembersView
          isTeamProjectMembersLoading={Boolean(
            projectMembers.key && projectMembers.isLoading,
          )}
          onSelectProject={workspace.onSelectProject}
          t={t}
          tasks={tasks}
          team={activeTeam}
          teamProjectMembers={projectMembers.data?.members ?? []}
          teamProjectMembersFailedProjectIds={projectMembers.data?.failedProjectIds ?? []}
        />
        <TeamWorkloadView
          error={workload.error}
          granularity={granularity}
          isLoading={Boolean(workload.key && workload.isLoading)}
          onGranularityChange={setGranularity}
          onRetry={() => { void workload.mutate() }}
          snapshot={workload.data}
          t={t}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
