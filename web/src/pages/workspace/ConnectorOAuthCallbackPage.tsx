import { useMemo } from 'react'
import { ConnectorOAuthCallbackContainer } from '../../developer-platform/ui/ConnectorOAuthCallbackContainer'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the page an external service returns to after the member approves a connector.
 *
 * @returns Connector completion content rendered inside the shared Workspace shell.
 */
export function ConnectorOAuthCallbackPage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <ConnectorOAuthCallbackContainer
          {...(workspace.accessToken ? { accessToken: workspace.accessToken } : {})}
          t={t}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
