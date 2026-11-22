import useSWR from 'swr'
import { loadTeamWorkItemHierarchies } from './teamWorkItemHierarchies'

// Reading several whole Team trees is heavy, so focusing the window does not re-read them.
const hierarchiesQueryConfig = {
  dedupingInterval: 5_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Lists each Team ID once, sorted, so the same Teams share one cache entry in any order.
 *
 * @param teamIds - Team IDs, possibly repeated.
 * @returns Distinct Team IDs in ascending order.
 */
export function normalizeHierarchyTeamIds(teamIds: Iterable<string>): string[] {
  return [...new Set(teamIds)].filter(Boolean).sort()
}

/**
 * Builds the cache key of the hierarchies of several Teams.
 *
 * @param accessToken - Access token for the Work Item API.
 * @param teamIds - Teams whose hierarchies are read; repeats and order do not matter.
 * @returns The key, or `null` without a token or Team.
 */
export function createTeamWorkItemHierarchiesKey(
  accessToken: string | undefined,
  teamIds: Iterable<string>,
) {
  const normalizedTeamIds = normalizeHierarchyTeamIds(teamIds)
  return accessToken && normalizedTeamIds.length > 0
    ? ['team-work-item-hierarchies', accessToken, ...normalizedTeamIds] as const
    : null
}

/**
 * Reads the hierarchies of every Team a cross-Team view shows.
 *
 * @param accessToken - Access token for the Work Item API.
 * @param teamIds - Teams whose hierarchies are read; repeats and order do not matter.
 * @param enabled - Whether the query runs.
 * @returns SWR state of the hierarchies; a Team that fails is reported in `errorsByTeam`.
 */
export function useTeamWorkItemHierarchies(
  accessToken: string | undefined,
  teamIds: Iterable<string>,
  enabled = true,
) {
  const key = enabled ? createTeamWorkItemHierarchiesKey(accessToken, teamIds) : null
  return useSWR(
    key,
    ([, token, ...currentTeamIds]) => loadTeamWorkItemHierarchies(currentTeamIds, token),
    hierarchiesQueryConfig,
  )
}
