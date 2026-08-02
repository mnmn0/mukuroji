import useSWR from 'swr'
import type { CapacityPlanningGranularity } from '@mukuroji/contracts'
import { getTeamWorkload } from '../api'
import { createWorkloadDateRange } from '../model/dateRange'

const workloadQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/** Loads the current Team workload for the selected display granularity. */
export function useTeamWorkload(
  accessToken: string | undefined,
  teamId: string | undefined,
  granularity: CapacityPlanningGranularity,
  enabled: boolean,
) {
  const range = createWorkloadDateRange(new Date(), granularity === 'month' ? 31 : 14)
  const key = accessToken && teamId && enabled
    ? ['team-workload', accessToken, teamId, range.fromDate, range.toDate, granularity] as const
    : null
  const query = useSWR(
    key,
    ([, token, currentTeamId, fromDate, toDate, currentGranularity]) =>
      getTeamWorkload(token, currentTeamId, { fromDate, toDate, granularity: currentGranularity }),
    workloadQueryConfig,
  )
  return { ...query, range, key }
}
