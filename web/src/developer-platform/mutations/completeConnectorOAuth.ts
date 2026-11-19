import type { CompleteConnectorOAuthOutput } from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import { completeDeveloperConnectorOAuth } from '../api/connectors'
import type { ConnectorOAuthCallbackFragment } from './connectorAuthorization'

/**
 * Completion requests keyed by signed state, so a re-run effect or a refreshed access token
 * reuses the request already sent instead of spending the single-use state twice.
 */
const completionsByState = new Map<string, Promise<CompleteConnectorOAuthOutput>>()

/**
 * Finishes a connector OAuth flow once per signed state with the signed-in member's session.
 *
 * @param accessToken - Access token of the signed-in member.
 * @param callback - State with either the authorization code or a cancellation marker.
 * @returns The outcome and the application-relative URL to return to.
 */
export function completeConnectorOAuthOnce(
  accessToken: string,
  callback: ConnectorOAuthCallbackFragment,
) {
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
