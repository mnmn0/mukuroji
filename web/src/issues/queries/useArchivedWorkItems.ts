import { useCallback } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import type { TeamIssue } from '../api/workItems'
import { selectArchivedWorkItems } from '../model/archivedWorkItems'
import { loadProjectIssues, loadTeamIssues } from './scopedWorkItemLoader'

/** First element of every archived Work Item list SWR key. */
const archivedWorkItemsKeyPrefix = 'archived-work-items'

/** Team or Project whose archived Work Items are listed. */
export type ArchivedWorkItemScope = {
  /** Whether the scope is a Team (owned Work Items) or a Project (assigned Work Items). */
  kind: 'team' | 'project'
  /** Team ID or Project ID, matching `kind`. */
  id: string
}

/**
 * Loads the archived Work Items of one Team or Project.
 *
 * The scoped list endpoints return archived Work Items only together with active ones, so the
 * hook reads every page with archived ones included and keeps the archived ones.
 *
 * @param accessToken - Work Item API access token.
 * @param scope - Team or Project to read.
 * @param enabled - Whether to read now; the list is read only while it is shown.
 * @returns The archived Work Items, newest archive first, with the SWR state.
 */
export function useArchivedWorkItems(
  accessToken: string | undefined,
  scope: ArchivedWorkItemScope | undefined,
  enabled: boolean,
) {
  const key = accessToken && scope && enabled
    ? [archivedWorkItemsKeyPrefix, accessToken, scope.kind, scope.id] as const
    : null
  const query = useSWR(
    key,
    async ([, token, kind, id]): Promise<TeamIssue[]> => selectArchivedWorkItems(
      kind === 'team'
        ? await loadTeamIssues(id, token, true)
        : (await loadProjectIssues(id, token, true)).issues,
    ),
    { shouldRetryOnError: false },
  )
  return query
}

/**
 * Returns a function that reads every shown archived Work Item list again.
 *
 * Archiving from the detail pane adds a Work Item to the archived list, which has its own cache.
 *
 * @returns A function that revalidates the archived lists.
 */
export function useArchivedWorkItemsRefresh() {
  const { mutate } = useSWRConfig()
  return useCallback(
    () => mutate(
      (key) => Array.isArray(key) && key[0] === archivedWorkItemsKeyPrefix,
    ).then(() => undefined),
    [mutate],
  )
}
