import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useReleaseFactoryBoardRun } from '../../features/factory-board/mutations/useReleaseFactoryBoardRun'
import { useFactoryBoardReports, useTeamAgentRunBoard } from '../../features/factory-board/queries/useFactoryBoard'
import { FactoryBoard } from '../../features/factory-board/ui/FactoryBoard'
import { createFactoryBoardLabels } from '../../features/factory-board/ui/factoryBoardLabels'
import { createProjectIssuesPath, createTeamIssuesPath } from '../../shared/routing/paths'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders one Team's Factory board inside the persistent Workspace shell.
 *
 * @returns Factory board content.
 */
export function TeamFactoryBoardPage() {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const params = useParams()
  const teamId = params.teamId
  const activeTeam = workspace.teams.find((team) => team.id === teamId)
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string>()
  const enabled = workspace.canLoadWorkspaceData && activeTeam !== undefined
  const accessToken = enabled ? workspace.accessToken : undefined
  const board = useTeamAgentRunBoard(accessToken, teamId)
  const reports = useFactoryBoardReports(accessToken, teamId, selectedWorkItemId)
  const onRelease = useReleaseFactoryBoardRun(accessToken, teamId, () => Promise.all([board.mutate(), reports.mutate()]))
  const labels = useMemo(() => createFactoryBoardLabels(workspace.locale), [workspace.locale])
  const formatDateTime = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(workspace.locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
    return (value: string) => formatter.format(new Date(value))
  }, [workspace.locale])
  const projectNames = useMemo(
    () => Object.fromEntries((activeTeam?.projects ?? []).map((project) => [project.id, project.name])),
    [activeTeam],
  )

  return (
    <WorkspaceRouteContent isLoading={board.isLoading} sessionErrors={[board.error, reports.error]}>
      <div className="px-[clamp(16px,3vw,34px)] py-5">
        <FactoryBoard
          board={board.data}
          errorMessage={board.error ? labels.loadError : undefined}
          formatDateTime={formatDateTime}
          getWorkItemHref={(item) => item.workItem.assignedProjectId && teamId
            ? createProjectIssuesPath(item.workItem.assignedProjectId, teamId, item.workItem.id)
            : createTeamIssuesPath(teamId ?? '', item.workItem.id)}
          isLoading={board.isLoading}
          isRefreshing={board.isValidating}
          key={teamId}
          labels={labels}
          onNavigate={(href) => { void navigate(href) }}
          onRefresh={() => { void board.mutate() }}
          onRelease={onRelease}
          onSelect={setSelectedWorkItemId}
          projectNames={projectNames}
          reports={{
            ...(reports.data ? { items: reports.data.items, hasMore: reports.data.hasMore } : {}),
            isLoading: reports.isLoading,
            ...(reports.error ? { errorMessage: labels.reportsError } : {}),
            onRetry: () => { void reports.mutate() },
          }}
          selectedWorkItemId={selectedWorkItemId}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
