import useSWR from 'swr'
import { getCycleScheduleBaseline } from '../api/cycleBaselines'

const cycleScheduleBaselineQueryConfig = {
  dedupingInterval: 10_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Builds the SWR key of one Cycle baseline read.
 *
 * @param accessToken - Planning API access token.
 * @param cycleId - Cycle ID.
 * @param baselineId - Saved baseline ID, or empty for the newest one.
 * @returns The key.
 */
export function cycleScheduleBaselineKey(accessToken: string, cycleId: string, baselineId = '') {
  return ['cycle-schedule-baseline', accessToken, cycleId, baselineId] as const
}

/**
 * Reads the newest, or one chosen, schedule baseline of a Cycle.
 *
 * @param accessToken - Planning API access token; nothing is read without one.
 * @param cycleId - Cycle whose baseline is read.
 * @param baselineId - Saved baseline to read instead of the newest one.
 * @returns The SWR query of the baseline response.
 */
export function useCycleScheduleBaseline(accessToken: string | undefined, cycleId: string, baselineId?: string) {
  return useSWR(
    accessToken ? cycleScheduleBaselineKey(accessToken, cycleId, baselineId) : null,
    ([, token, id, selected]) => getCycleScheduleBaseline(token, id, selected || undefined),
    cycleScheduleBaselineQueryConfig,
  )
}
