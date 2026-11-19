import useSWR from 'swr'
import { getProjectQuickAccess } from '../api/quickAccess'

/** Project quick-access query loader used by tests and Storybook. */
export type ProjectQuickAccessLoader = (
  accessToken: string,
) => ReturnType<typeof getProjectQuickAccess>

/** Inputs accepted by the authenticated Project quick-access query. */
export type UseProjectQuickAccessOptions = {
  /** Cognito access token. */
  accessToken?: string
  /** Whether the current authentication state permits the request. */
  enabled: boolean
  /** Optional loader override for tests and stories. */
  loadProjectQuickAccess?: ProjectQuickAccessLoader
}

/** First element of every Project quick-access query key. */
const projectQuickAccessKeyPrefix = 'project-quick-access'

/**
 * Checks whether an SWR key belongs to a Project quick-access query.
 *
 * @param key - SWR cache key.
 * @returns Whether the key is a quick-access key.
 */
export function isProjectQuickAccessKey(key: unknown) {
  return Array.isArray(key) && key[0] === projectQuickAccessKeyPrefix
}

/**
 * Loads and caches the authenticated viewer's Project shortcuts.
 *
 * @param options - Authentication state and optional loader override.
 * @returns SWR state and its active key.
 */
export function useProjectQuickAccess({
  accessToken,
  enabled,
  loadProjectQuickAccess = getProjectQuickAccess,
}: UseProjectQuickAccessOptions) {
  const key: readonly [typeof projectQuickAccessKeyPrefix, string] | null = accessToken && enabled
    ? [projectQuickAccessKeyPrefix, accessToken]
    : null
  const query = useSWR(
    key,
    ([, token]) => loadProjectQuickAccess(token),
    {
      dedupingInterval: 10_000,
      shouldRetryOnError: false,
    },
  )

  return { ...query, key }
}
