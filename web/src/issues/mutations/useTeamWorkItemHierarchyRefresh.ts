import { useCallback } from 'react'
import { useSWRConfig } from 'swr'
import { getTeamWorkItemHierarchy } from '../../work-items/api'
import { createTeamWorkItemHierarchyKey } from '../../work-items/queries/useTeamWorkItemHierarchy'
import { refreshCachedHierarchy } from './hierarchyMoveCacheRefresh'

/**
 * Refreshes a Team's cached hierarchy after a write that changes it, such as a relation edit,
 * a status change that feeds a roll-up, or a new Work Item.
 *
 * The Team is fixed when the page renders the handler that saves, so the hierarchy of the Team
 * the write went to is refreshed even if the person switches Team or closes the outline before
 * the save returns. A Team whose hierarchy was never read has nothing cached and is left alone.
 * A cached hierarchy is read again and written to the cache; when that read fails, the old
 * hierarchy is cleared instead of being shown with numbers from before the write.
 *
 * @param accessToken - Access token of the signed-in person.
 * @param teamId - Team the page writes to.
 * @returns Refreshes that Team's hierarchy; resolves once the cache holds the new one or is cleared.
 */
export function useTeamWorkItemHierarchyRefresh(accessToken: string | undefined, teamId: string) {
  const { cache, mutate } = useSWRConfig()
  return useCallback(async () => {
    if (!accessToken) return
    await refreshCachedHierarchy(
      cache,
      mutate,
      createTeamWorkItemHierarchyKey(accessToken, teamId),
      () => getTeamWorkItemHierarchy(teamId, accessToken),
    )
  }, [accessToken, cache, mutate, teamId])
}
