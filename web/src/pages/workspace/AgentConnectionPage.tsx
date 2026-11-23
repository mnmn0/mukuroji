import { useMemo } from 'react'
import { AgentConnectionPanelContainer } from '../../developer-platform/ui/AgentConnectionPanelContainer'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the page where a member issues their own agent token and copies a client configuration.
 * Without Software factory the configuration uses the Workspace MCP profile, which only reads.
 *
 * @returns Agent connection content rendered inside the shared Workspace shell.
 */
export function AgentConnectionPage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const teams = useMemo(
    () => workspace.teams.map((team) => ({ id: team.id, name: team.name })),
    [workspace.teams],
  )

  // The profile follows the deployment switch, so wait for it instead of flashing the wrong one.
  if (workspace.isLoading) return <WorkspaceRouteContent isLoading>{null}</WorkspaceRouteContent>

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        {workspace.accessToken ? (
          <AgentConnectionPanelContainer
            accessToken={workspace.accessToken}
            locale={workspace.locale}
            profile={workspace.softwareFactoryEnabled ? 'tasks' : 'workspace'}
            t={t}
            teams={teams}
          />
        ) : null}
      </div>
    </WorkspaceRouteContent>
  )
}
