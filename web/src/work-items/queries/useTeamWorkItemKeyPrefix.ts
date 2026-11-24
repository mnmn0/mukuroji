import useSWR from 'swr'
import { getTeamWorkItemKeyPrefix } from '../../issues/api'

/** First element of every Team key prefix cache key. */
const TEAM_WORK_ITEM_KEY_PREFIX_KEY = 'team-work-item-key-prefix'

/**
 * Builds the SWR key of one Team's Work Item key prefix setting.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team ID.
 * @returns The scope-bound cache key.
 */
export function teamWorkItemKeyPrefixKey(accessToken: string, teamId: string) {
  return [TEAM_WORK_ITEM_KEY_PREFIX_KEY, accessToken, teamId] as const
}

/**
 * Reads the Work Item key prefix setting of one Team.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team ID; reading is skipped without it.
 * @returns SWR state of the setting.
 */
export function useTeamWorkItemKeyPrefix(accessToken: string, teamId: string | undefined) {
  return useSWR(
    teamId ? teamWorkItemKeyPrefixKey(accessToken, teamId) : null,
    ([, token, id]) => getTeamWorkItemKeyPrefix(id, token),
    { revalidateOnFocus: false },
  )
}
