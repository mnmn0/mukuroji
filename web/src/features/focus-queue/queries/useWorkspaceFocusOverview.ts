import type { FocusQueueResponse } from '@mukuroji/contracts'
import { FocusQueueApiError } from '../api/focusQueue'
import { getFocusBlockedCount } from '../model/focusMetrics'
import { useFocusQueue } from './useFocusQueue'

/**
 * Resolves whether cached Focus data remains safe to show after a refresh failure.
 *
 * @param response - Last successfully loaded Focus snapshot.
 * @param error - Latest Focus query failure.
 * @returns Visible response and unavailable state for overview surfaces.
 */
export function resolveWorkspaceFocusOverviewState(
  response: FocusQueueResponse | undefined,
  error: unknown,
) {
  const authorizationFailed = error instanceof FocusQueueApiError &&
    (error.status === 401 || error.status === 403)
  const visibleResponse = authorizationFailed ? undefined : response

  return {
    isUnavailable: Boolean(error && !visibleResponse),
    response: visibleResponse,
  }
}

/**
 * Loads the shared Focus overview projection used by Home and Dashboard.
 *
 * @param accessToken - Session bearer token.
 * @param enabled - Whether Workspace data may be loaded.
 * @returns Focus query, safe snapshot, metrics, loading state, and notice props.
 */
export function useWorkspaceFocusOverview(
  accessToken: string | undefined,
  enabled: boolean,
) {
  const query = useFocusQueue(accessToken, enabled)
  const state = resolveWorkspaceFocusOverviewState(query.data, query.error)

  return {
    blockedCount: getFocusBlockedCount(state.response),
    isLoading: Boolean(query.key && query.isLoading),
    isUnavailable: state.isUnavailable,
    noticeProps: {
      hasCachedData: Boolean(state.response),
      hasError: Boolean(query.error),
      onRetry: () => void query.mutate(),
    },
    query,
    response: state.response,
  }
}
