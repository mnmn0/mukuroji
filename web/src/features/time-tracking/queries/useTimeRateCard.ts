import useSWR from 'swr'
import { getTimeRateCard, getTimeTrackingTeamSettings } from '../api/timeRateCard'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads a Team's time tracking settings: the Workspace currency and whether the caller may manage
 * the rate card.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team to read.
 * @returns SWR state of the settings.
 */
export function useTimeTrackingTeamSettings(accessToken: string | undefined, teamId: string | undefined) {
  const key = accessToken && teamId ? [timeTrackingQueryKeyRoot, 'team-settings', accessToken, teamId] as const : null
  return useSWR(key, ([, , token, team]) => getTimeTrackingTeamSettings(token, team), timeTrackingQueryConfig)
}

/**
 * Loads a Team's confidential rate card.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team to read.
 * @param enabled - Whether the caller may read it, so a member never requests it.
 * @returns SWR state of the rate card.
 */
export function useTimeRateCard(accessToken: string | undefined, teamId: string | undefined, enabled: boolean) {
  const key = accessToken && teamId && enabled ? [timeTrackingQueryKeyRoot, 'rate-card', accessToken, teamId] as const : null
  return useSWR(key, ([, , token, team]) => getTimeRateCard(token, team), timeTrackingQueryConfig)
}
