import { useState } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import type { WorkItemKeyLookupResponse } from '@mukuroji/contracts'
import { getWorkItemByKey, type TeamIssue } from '../api/workItems'
import { loadTeamIssues } from './scopedWorkItemLoader'
import { createTeamIssuesKey } from './useWorkItems'

/** Counts mounted lookups, so each mount gets its own cache entry. */
let lookupCount = 0

/** The parts of the SWR cache that a key lookup reads and writes. */
interface TeamIssueListCache {
  /** Reads the cached Team Work Item list stored under a serialized SWR key. */
  readTeamIssues: (serializedKey: string) => readonly TeamIssue[] | undefined
  /** Stores a freshly loaded Team Work Item list under an SWR key. */
  storeTeamIssues: (
    key: ReturnType<typeof createTeamIssuesKey>,
    issues: Promise<TeamIssue[]>,
  ) => Promise<unknown>
}

/**
 * Resolves a Work Item key and makes sure the Team Issue screen will be able to select it.
 * The Team Issue screen selects from its cached Team list and falls back to the first item,
 * so a list cached before the Work Item existed would open an unrelated Work Item. When the
 * cached list lacks the resolved Work Item, the list is loaded again before the redirect.
 *
 * @param workItemKey - Canonical key to resolve.
 * @param accessToken - Work Item API access token.
 * @param cache - Reads and writes the cached Team Work Item list.
 * @returns The Team and Work Item the key names now.
 */
export async function loadWorkItemKeyLocation(
  workItemKey: string,
  accessToken: string,
  cache: TeamIssueListCache,
): Promise<WorkItemKeyLookupResponse> {
  const location = await getWorkItemByKey(workItemKey, accessToken)
  const listKey = createTeamIssuesKey(accessToken, location.teamId, true)
  const cachedIssues = cache.readTeamIssues(unstable_serialize(listKey))
  if (cachedIssues && !cachedIssues.some((issue) => issue.id === location.workItemId)) {
    await cache.storeTeamIssues(listKey, loadTeamIssues(location.teamId, accessToken, true))
  }
  return location
}

/**
 * Resolves a Work Item key, such as `PT-12`, to the Team and Work Item it names now.
 * Each mounted page looks the key up afresh, so a cached answer from an earlier visit never
 * redirects to a Work Item that has since been deleted or replaced.
 *
 * @param accessToken - Work Item API access token.
 * @param workItemKey - Canonical key, or undefined when the URL did not hold one.
 * @param enabled - Whether the lookup may run yet.
 * @returns The SWR state of the lookup. Call `mutate()` to retry after a failure.
 */
export function useWorkItemKeyLocation(
  accessToken: string | undefined,
  workItemKey: string | undefined,
  enabled = true,
) {
  const { cache, mutate } = useSWRConfig()
  const [lookupId] = useState(() => ++lookupCount)
  const key = accessToken && workItemKey && enabled
    ? ['work-item-key-location', accessToken, workItemKey, lookupId] as const
    : null

  return useSWR(
    key,
    ([, token, currentKey]) => loadWorkItemKeyLocation(currentKey, token, {
      readTeamIssues: (serializedKey) =>
        cache.get(serializedKey)?.data as readonly TeamIssue[] | undefined,
      storeTeamIssues: (listKey, issues) => mutate(listKey, issues, { revalidate: false }),
    }),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  )
}
