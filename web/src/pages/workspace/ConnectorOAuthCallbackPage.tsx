import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { completeConnectorOAuthOnce } from '../../developer-platform/mutations/completeConnectorOAuth'
import { readConnectorOAuthCallbackFragment } from '../../developer-platform/mutations/connectorAuthorization'
import { ConnectorOAuthCallbackView } from '../../developer-platform/ui/ConnectorOAuthCallbackView'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/** Settings destination shown when the flow cannot be finished. */
const connectorSettingsPath = '/settings?developerSection=connectors'

/**
 * Renders the page an external service returns to after the member approves a connector.
 *
 * The server hands the provider callback values to this page in the URL fragment. Completing the
 * flow here, with the member's access token, lets the server require that the member who started
 * the flow is the one finishing it.
 *
 * @returns Connector completion progress or failure inside the shared Workspace shell.
 */
export function ConnectorOAuthCallbackPage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const location = useLocation()
  const navigate = useNavigate()
  const [callback] = useState(() => readConnectorOAuthCallbackFragment(location.hash))
  const [failed, setFailed] = useState(callback === undefined)
  const hasFragment = location.hash !== ''
  const accessToken = workspace.accessToken

  useEffect(() => {
    // Keep the authorization code out of browser history and router state once it has been read,
    // so later redirects that copy the current location cannot carry it along.
    if (hasFragment) {
      void navigate({ pathname: location.pathname, search: location.search }, { replace: true })
    }
  }, [hasFragment, location.pathname, location.search, navigate])

  useEffect(() => {
    if (!callback || !accessToken) return undefined
    let active = true
    completeConnectorOAuthOnce(accessToken, callback).then(
      (result) => {
        if (active) void navigate(result.returnUrl, { replace: true })
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [accessToken, callback, navigate])

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <ConnectorOAuthCallbackView
          settingsPath={connectorSettingsPath}
          status={failed ? 'failed' : 'completing'}
          t={t}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
