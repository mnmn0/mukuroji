import useSWR from 'swr'
import type { TimeEntryStatus } from '@mukuroji/contracts'
import { listTimeEntries } from '../api/timeEntries'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads a Team's time entries in a period.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the entries.
 * @param period - Inclusive start and exclusive end as ISO instants.
 * @param filters - Optional member and lifecycle filters.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the entries.
 */
export function useTimeEntries(
  accessToken: string | undefined,
  teamId: string | undefined,
  period: { from: string; to: string },
  filters: { userId?: string; status?: TimeEntryStatus } = {},
  enabled = true,
) {
  const key = accessToken && teamId && enabled
    ? [timeTrackingQueryKeyRoot, 'entries', accessToken, teamId, period.from, period.to, filters.userId ?? '', filters.status ?? ''] as const
    : null
  return useSWR(
    key,
    ([, , token, team, from, to, userId, status]) => listTimeEntries(token, team, {
      from,
      to,
      ...(userId ? { userId } : {}),
      ...(status ? { status } : {}),
    }),
    timeTrackingQueryConfig,
  )
}
