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
  const key: readonly ['project-quick-access', string] | null = accessToken && enabled
    ? ['project-quick-access', accessToken]
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
