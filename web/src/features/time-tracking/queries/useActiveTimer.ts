import useSWR from 'swr'
import { getActiveTimer } from '../api/timers'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads the signed-in member's running timer, refreshing it when the window regains focus or
 * the connection returns so a timer started elsewhere or before going offline reappears.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the running timer; `null` data means no timer is running.
 */
export function useActiveTimer(accessToken: string | undefined, enabled = true) {
  const key = accessToken && enabled ? [timeTrackingQueryKeyRoot, 'active-timer', accessToken] as const : null
  return useSWR(key, ([, , token]) => getActiveTimer(token), { ...timeTrackingQueryConfig, revalidateOnFocus: true })
}
