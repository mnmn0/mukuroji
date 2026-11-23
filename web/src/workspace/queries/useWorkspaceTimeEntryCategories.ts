import useSWR from 'swr'
import type { WorkspaceTimeEntryCategorySettings } from '@mukuroji/contracts'
import { getWorkspaceTimeEntryCategories } from '../api/tenantAdministration'

/** First element of every Workspace work category cache key. */
const workspaceTimeEntryCategoriesKeyPrefix = 'workspace-time-entry-categories'

const workspaceTimeEntryCategoriesQueryConfig = {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Matches the cache keys of {@link useWorkspaceTimeEntryCategories}, so a settings change can
 * update every reader regardless of the access token in the key.
 *
 * @param key - SWR cache key.
 * @returns Whether the key belongs to the Workspace work category query.
 */
export function isWorkspaceTimeEntryCategoriesKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === workspaceTimeEntryCategoriesKeyPrefix
}

/** State of the Workspace work category read. */
export type WorkspaceTimeEntryCategoriesQuery = {
  /** Categories from the server; undefined until the read succeeds. */
  settings: WorkspaceTimeEntryCategorySettings | undefined
  /** Failure of the latest read, if any. */
  error: unknown
  /** Reads the categories again. */
  retry: () => void
}

/**
 * Loads the Workspace work categories for any member.
 *
 * @param accessToken - Bearer token used for the read.
 * @param enabled - Whether the query may run.
 * @returns The categories once loaded, the latest error, and a retry action.
 */
export function useWorkspaceTimeEntryCategories(
  accessToken?: string,
  enabled = true,
): WorkspaceTimeEntryCategoriesQuery {
  const key = accessToken && enabled
    ? [workspaceTimeEntryCategoriesKeyPrefix, accessToken] as const
    : null
  const query = useSWR(
    key,
    ([, token]) => getWorkspaceTimeEntryCategories(token),
    workspaceTimeEntryCategoriesQueryConfig,
  )
  return { settings: query.data, error: query.error, retry: () => { void query.mutate().catch(() => undefined) } }
}
