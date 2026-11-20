import { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { useTeamAgentRunBoard } from '../../features/factory-board/queries/useFactoryBoard'
import { TeamIssuesApiError } from '../../issues/api'
import { useProjectIssues } from '../../issues/queries/useWorkItems'
import { usePlanningSnapshot } from '../../planning/queries/usePlanningSnapshot'
import { isActiveProjectAssignmentCandidate, ProjectDirectoryApiError } from '../../projects/api'
import {
  findProjectOverviewUpdateTarget,
  selectProjectOverviewSchedule,
  summarizeProjectOverviewAgentRuns,
  summarizeProjectOverviewMembers,
  summarizeProjectOverviewWorkItems,
} from '../../projects/model/projectOverview'
import { useProjectMembers } from '../../projects/queries/useProjectMembers'
import {
  ProjectOverviewView,
  type ProjectOverviewAgentRunsError,
  type ProjectOverviewMembersError,
  type ProjectOverviewWorkItemsError,
} from '../../projects/ui/ProjectOverviewView'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkItemConfigurationApiError } from '../../work-items/api/errors'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the Team-qualified Project overview route.
 *
 * The overview reads the Project's Work Items, the Planning snapshot, and the Project members
 * in parallel through the existing read APIs, so each widget shows its own loading or failure
 * state and a failed read never hides the others.
 *
 * @returns Project overview content rendered inside the shared Workspace shell.
 */
export function ProjectOverviewPage() {
  const workspace = useWorkspaceRouteContext()
  const params = useParams()
  const [searchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const projectId = params.projectId
  const teamId = searchParams.get('teamId') ?? undefined
  const team = workspace.teams.find((candidate) => candidate.id === teamId)
  const project = team?.projects.find((candidate) => candidate.id === projectId)
  const canRead = workspace.canLoadWorkspaceData && Boolean(team && project)
  const workItems = useProjectIssues(workspace.accessToken, projectId, canRead)
  const planning = usePlanningSnapshot(workspace.accessToken, canRead)
  const members = useProjectMembers(workspace.accessToken, projectId, canRead, team?.id)
  const agentRunBoard = useTeamAgentRunBoard(canRead ? workspace.accessToken : undefined, team?.id)
  const workItemSummary = useMemo(
    () => workItems.data && team
      ? summarizeProjectOverviewWorkItems(workItems.data, team.id, new Date())
      : undefined,
    [team, workItems.data],
  )
  const workItemsError: ProjectOverviewWorkItemsError | undefined = workItems.error
    ? workItems.error instanceof TeamIssuesApiError && workItems.error.code === 'WorkItemListLimitExceeded'
      ? 'limit'
      : 'load'
    : undefined
  const membersError: ProjectOverviewMembersError | undefined = members.error
    ? members.error instanceof ProjectDirectoryApiError && members.error.status === 403
      ? 'denied'
      : 'load'
    : undefined
  const agentRunsError: ProjectOverviewAgentRunsError | undefined = agentRunBoard.error
    ? agentRunBoard.error instanceof WorkItemConfigurationApiError && agentRunBoard.error.status === 403
      ? 'denied'
      : 'load'
    : undefined
  const agentRuns = useMemo(
    () => agentRunBoard.data && projectId
      ? summarizeProjectOverviewAgentRuns(agentRunBoard.data, projectId)
      : undefined,
    [agentRunBoard.data, projectId],
  )
  const updateTarget = team && projectId && planning.data
    ? findProjectOverviewUpdateTarget(planning.data.updateTargets, team.id, projectId)
    : undefined
  const schedule = useMemo(
    () => team && projectId && planning.data
      ? selectProjectOverviewSchedule(planning.data.entities, team.id, projectId)
      : undefined,
    [planning.data, projectId, team],
  )
  const memberSummary = useMemo(
    () => members.data
      ? summarizeProjectOverviewMembers(members.data.filter(isActiveProjectAssignmentCandidate))
      : undefined,
    [members.data],
  )

  return (
    <WorkspaceRouteContent
      isLoading={workspace.isLoading}
      sessionErrors={[workItems.error, planning.error, members.error, agentRunBoard.error]}
    >
      <div className="px-[clamp(16px,3vw,34px)] py-5">
        <ProjectOverviewView
          agentRuns={agentRuns}
          agentRunsError={agentRunsError}
          isAgentRunsLoading={agentRunBoard.isLoading}
          isMembersLoading={Boolean(members.key) && members.data === undefined && !members.error}
          isPlanningError={Boolean(planning.error)}
          isPlanningLoading={Boolean(planning.key) && planning.data === undefined && !planning.error}
          isWorkItemsLoading={workItems.isLoading}
          locale={workspace.locale}
          members={memberSummary}
          membersError={membersError}
          onRetryAgentRuns={() => void agentRunBoard.mutate()}
          onRetryMembers={() => void members.mutate()}
          onRetryPlanning={() => void planning.mutate()}
          onRetryWorkItems={() => void workItems.mutate()}
          project={project}
          schedule={schedule}
          t={t}
          team={team}
          updateTarget={updateTarget}
          workItemSummary={workItemSummary}
          workItemsError={workItemsError}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
