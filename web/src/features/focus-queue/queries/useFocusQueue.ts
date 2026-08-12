import useSWR from 'swr'
import { FocusQueueApiError, getFocusQueue } from '../api/focusQueue'

const focusQueueRefreshInterval = 15_000

/**
 * Creates the private SWR key for one authenticated Focus snapshot.
 *
 * @param accessToken - Session bearer token.
 * @param enabled - Whether the current route may load Workspace data.
 * @returns The Focus key or null while loading is disabled.
 */
export function createFocusQueueKey(
  accessToken: string | undefined,
  enabled: boolean,
): readonly ['focus-queue', string] | null {
  return accessToken && enabled ? ['focus-queue', accessToken] : null
}

/**
 * Removes cached Focus data after an authorization failure.
 *
 * @param response - Last successfully loaded Focus snapshot.
 * @param error - Latest Focus query failure.
 * @returns Focus snapshot that is safe to expose to the current principal.
 */
export function resolveFocusQueueResponse(
  response: Awaited<ReturnType<typeof getFocusQueue>> | undefined,
  error: unknown,
) {
  const authorizationFailed = error instanceof FocusQueueApiError &&
    (error.status === 401 || error.status === 403)
  return authorizationFailed ? undefined : response
}

/**
 * Loads and refreshes the caller's permission-filtered Focus queue.
 *
 * @param accessToken - Session bearer token.
 * @param enabled - Whether the current route may load Workspace data.
 * @returns Focus data, loading state, error, key, and cache mutator.
 */
export function useFocusQueue(
  accessToken: string | undefined,
  enabled: boolean,
) {
  const key = createFocusQueueKey(accessToken, enabled)
  const query = useSWR(
    key,
    ([, token]) => getFocusQueue(token),
    {
      dedupingInterval: 2_000,
      refreshInterval: focusQueueRefreshInterval,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )

  return {
    ...query,
    data: resolveFocusQueueResponse(query.data, query.error),
    key,
  }
}
