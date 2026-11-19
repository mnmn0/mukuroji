import type { CompleteConnectorOAuthOutput } from '@mukuroji/contracts'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import { completeDeveloperConnectorOAuth } from '../api/connectors'
import {
  readConnectorOAuthCallbackFragment,
  type ConnectorOAuthCallbackFragment,
} from '../mutations/connectorAuthorization'
import { ConnectorOAuthCallbackView } from './ConnectorOAuthCallbackView'

/** Inputs for the connector OAuth callback container. */
export type ConnectorOAuthCallbackContainerProps = {
  /** Access token of the signed-in member, once the session is ready. */
  accessToken?: string
  /** Resolves interface copy in the active locale. */
  t: (key: MessageKey) => string
}

/** Settings destination shown when the flow cannot be finished. */
const connectorSettingsPath = '/settings?developerSection=connectors'

/**
 * Completion requests keyed by signed state, so a re-run effect or a refreshed access token
 * reuses the request already sent instead of spending the single-use state twice.
 */
const completionsByState = new Map<string, Promise<CompleteConnectorOAuthOutput>>()

/**
 * Sends the callback values once per signed state.
 *
 * @param accessToken - Access token of the signed-in member.
 * @param callback - State with either the authorization code or a cancellation marker.
 * @returns The outcome and the application-relative URL to return to.
 */
function completeOnce(accessToken: string, callback: ConnectorOAuthCallbackFragment) {
  const existing = completionsByState.get(callback.state)
  if (existing) return existing
  const completion = completeDeveloperConnectorOAuth(
    accessToken,
    callback,
    createMutationRequestContext(),
  )
  completionsByState.set(callback.state, completion)
  return completion
}

/**
 * Finishes a connector OAuth flow with the signed-in member's session.
 *
 * The server hands the provider callback values to this page in the URL fragment. Completing the
 * flow here, with the member's access token, lets the server require that the member who started
 * the flow is the one finishing it.
 *
 * @param props - Session and copy for the callback page.
 * @returns Progress while the flow completes, or an error with a way back to settings.
 */
export function ConnectorOAuthCallbackContainer({
  accessToken,
  t,
}: ConnectorOAuthCallbackContainerProps) {
  const navigate = useNavigate()
  const [callback] = useState(() => readConnectorOAuthCallbackFragment(window.location.hash))
  const [failed, setFailed] = useState(callback === undefined)

  const location = useLocation()
  const hasFragment = location.hash !== ''

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
    completeOnce(accessToken, callback).then(
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
    <ConnectorOAuthCallbackView
      settingsPath={connectorSettingsPath}
      status={failed ? 'failed' : 'completing'}
      t={t}
    />
  )
}
