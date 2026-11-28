import { useParams } from 'react-router'
import { TeamDecisionLogView } from '../../projects/ui/TeamDecisionLogView'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the Team decision log route: decisions and decided change requests across the Team's
 * Projects, with the decision notes kept on Work Items (ADR 0114).
 *
 * @returns Team decision log content rendered inside the shared Workspace shell.
 */
export function TeamDecisionLogPage() {
  const workspace = useWorkspaceRouteContext()
  const teamId = useParams().teamId
  const team = workspace.teams.find((candidate) => candidate.id === teamId)
  return (
    <WorkspaceRouteContent isLoading={false} sessionErrors={[]}>
      <div className="px-[clamp(16px,3vw,34px)] py-5">
        {team ? (
          <TeamDecisionLogView
            // A new Team starts with its own filters and without the previous Team's results.
            key={team.id}
            accessToken={workspace.canLoadWorkspaceData ? workspace.accessToken : undefined}
            locale={workspace.locale}
            team={team}
          />
        ) : null}
      </div>
    </WorkspaceRouteContent>
  )
}
