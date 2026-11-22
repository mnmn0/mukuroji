import { useCallback } from 'react'
import { unstable_serialize, useSWRConfig } from 'swr'
import { loadTeamWorkItemHierarchies } from '../queries/teamWorkItemHierarchies'
import {
  createTeamWorkItemHierarchiesKey,
  normalizeHierarchyTeamIds,
} from '../queries/useTeamWorkItemHierarchies'

/**
 * Refreshes the cached hierarchies of several Teams after a write that changes their roll-ups,
 * such as a confirmed schedule change on a cross-Team view.
 *
 * The Teams are fixed when the page renders the handler, so the entry read when the write
 * started is the one refreshed even if the view's Teams change before it returns. Hierarchies
 * nobody read are not cached and are left alone. The pending read is handed to SWR, which drops
 * it when a later write to the entry started after it. A read in which any Team failed rejects
 * and leaves the previous hierarchies in place, so the caller can retry it.
 *
 * @param accessToken - Access token of the signed-in person.
 * @param teamIds - Teams the view shows hierarchies for.
 * @returns Refreshes those hierarchies; rejects when a Team's read fails.
 */
export function useTeamWorkItemHierarchiesRefresh(
  accessToken: string | undefined,
  teamIds: Iterable<string>,
) {
  const { cache, mutate } = useSWRConfig()
  // Joined so the callback stays the same while the same Teams are shown in any order.
  const teamIdsKey = normalizeHierarchyTeamIds(teamIds).join('\n')
  return useCallback(async (
    guardRequest: <Result>(request: Promise<Result>) => Promise<Result> = (request) => request,
  ) => {
    const currentTeamIds = teamIdsKey ? teamIdsKey.split('\n') : []
    const key = createTeamWorkItemHierarchiesKey(accessToken, currentTeamIds)
    if (!key || !accessToken || cache.get(unstable_serialize(key)) === undefined) return
    const read = guardRequest(loadTeamWorkItemHierarchies(currentTeamIds, accessToken))
      .then((hierarchies) => {
        const [failure] = hierarchies.errorsByTeam.values()
        if (hierarchies.errorsByTeam.size > 0) throw failure
        return hierarchies
      })
    await mutate(key, read, { revalidate: false, rollbackOnError: true })
  }, [accessToken, cache, mutate, teamIdsKey])
}
