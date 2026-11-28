import { PullRequestInboxContainer } from '../../features/github-reviews/ui/PullRequestInboxContainer'
import { settingsPanelPath } from '../../workspace/model/settingsSections'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the `/reviews` route: the GitHub pull requests the member opened or was asked to review
 * (#775).
 *
 * @returns The review inbox inside the shared Workspace shell.
 */
export function ReviewsPage() {
  const workspace = useWorkspaceRouteContext()
  return (
    <WorkspaceRouteContent>
      <div className="px-[clamp(20px,3vw,34px)] py-5">
        <PullRequestInboxContainer
          accessToken={workspace.canLoadWorkspaceData ? workspace.accessToken : undefined}
          locale={workspace.locale}
          loginSettingsPath={settingsPanelPath('personal', 'github')}
          teams={workspace.teams}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
