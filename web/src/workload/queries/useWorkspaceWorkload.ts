import useSWR from 'swr'
import type { CapacityPlanningGranularity } from '@mukuroji/contracts'
import { getWorkspaceWorkload } from '../api'
import { createWorkloadDateRange } from '../model/dateRange'

const workspaceWorkloadQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Loads the workload across Teams for a range that starts today and fits the granularity.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param granularity - Display granularity.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the Workspace workload snapshot.
 */
export function useWorkspaceWorkload(
  accessToken: string | undefined,
  granularity: CapacityPlanningGranularity,
  enabled: boolean,
) {
  const range = createWorkloadDateRange(new Date(), granularity === 'month' ? 62 : granularity === 'week' ? 28 : 14)
  const key = accessToken && enabled
    ? ['workspace-workload', accessToken, range.fromDate, range.toDate, granularity] as const
    : null
  return useSWR(
    key,
    ([, token, fromDate, toDate, currentGranularity]) =>
      getWorkspaceWorkload(token, { fromDate, toDate, granularity: currentGranularity }),
    workspaceWorkloadQueryConfig,
  )
}
