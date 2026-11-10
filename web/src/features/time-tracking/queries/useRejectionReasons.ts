import useSWR from 'swr'
import type { TimeEntry } from '@mukuroji/contracts'
import { listTimeEntryHistory } from '../api/timeEntries'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads the latest rejection reason of each rejected entry from its history.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param entries - Entries whose rejected members need a reason.
 * @returns SWR state of the reasons keyed by entry identifier.
 */
export function useRejectionReasons(accessToken: string | undefined, entries: readonly TimeEntry[]) {
  const rejected = entries.filter((entry) => entry.status === 'rejected')
  const identity = rejected.map((entry) => `${entry.teamId}\u0000${entry.id}\u0000${entry.revision}`).join('\u0001')
  const key = accessToken && rejected.length > 0
    ? [timeTrackingQueryKeyRoot, 'rejection-reasons', accessToken, identity] as const
    : null
  return useSWR(
    key,
    async ([, , token]) => {
      const reasons = await Promise.all(rejected.map(async (entry) => {
        const history = await listTimeEntryHistory(token, entry.teamId, entry.id)
        const rejection = history
          .filter((record) => record.action === 'rejected')
          .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
          .at(-1)
        return [entry.id, rejection?.reason ?? ''] as const
      }))
      return Object.fromEntries(reasons)
    },
    timeTrackingQueryConfig,
  )
}
