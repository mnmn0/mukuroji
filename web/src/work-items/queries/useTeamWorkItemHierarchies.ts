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
  const normalizedTeamIds = normalizeHierarchyTeamIds(teamIds)
  const key = accessToken && enabled && normalizedTeamIds.length > 0
    ? ['team-work-item-hierarchies', accessToken, ...normalizedTeamIds] as const
    : null
  return useSWR(
    key,
    ([, token, ...currentTeamIds]) => loadTeamWorkItemHierarchies(currentTeamIds, token),
    hierarchiesQueryConfig,
  )
}
