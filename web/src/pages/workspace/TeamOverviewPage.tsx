import { useMemo } from 'react'
import { useParams } from 'react-router'
import type { ProjectDirectoryProject } from '../../projects/api'
import { useWorkspaceProjectMembers } from '../../projects/queries/useProjectMembers'
import { TeamOverviewView } from '../../projects/ui/TeamOverviewView'
import { createTranslator } from '../../shared/i18n/i18n'
import { getUniqueWorkspaceProjectIds } from '../../work-items/model/workspaceWorkItems'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import { WorkspaceTaskLoadNotice } from '../../workspace/ui/WorkspaceDataNotices'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

const emptyTeamProjects: ProjectDirectoryProject[] = []

/**
 * Renders the URL-specific Team overview route.
 *
 * @returns Team overview content rendered inside the shared Workspace shell.
 */
export function TeamOverviewPage() {
  const workspace = useWorkspaceRouteContext()
  const params = useParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const activeTeam = workspace.teams.find((team) => team.id === params.teamId)
  const projects = activeTeam?.projects ?? emptyTeamProjects
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  const projectMembers = useWorkspaceProjectMembers(
    workspace.accessToken,
    activeTeam?.id,
    projects,
    workspace.canLoadWorkspaceData && Boolean(activeTeam),
  )
  const failedProjectCount = workItems.workItemsError
    ? getUniqueWorkspaceProjectIds(workspace.teams).length
    : 0
  const isLoading = Boolean(
    workItems.workItemsKey && workItems.isWorkItemsLoading,
  ) || Boolean(
    workItems.configurationsKey && workItems.isConfigurationsLoading,
  )

  return (
    <WorkspaceRouteContent
      isLoading={isLoading}
      sessionErrors={[
        workItems.workItemsError,
        workItems.configurationsError,
        ...workItems.configurationErrors,
        projectMembers.error,
        ...(projectMembers.data?.errors ?? []),
      ]}
    >
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice failedProjectCount={failedProjectCount} t={t} />
        <TeamOverviewView
          isTeamProjectMembersLoading={Boolean(
            projectMembers.key && projectMembers.isLoading,
          )}
          onOpenTask={workspace.onOpenTask}
          onSelectProject={workspace.onSelectProject}
          t={t}
          tasks={workItems.tasks}
          team={activeTeam}
          teamProjectMembers={projectMembers.data?.members ?? []}
          teamProjectMembersFailedProjectIds={projectMembers.data?.failedProjectIds ?? []}
          workItemConfigurationsByTeam={workItems.configurationsByTeam}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
