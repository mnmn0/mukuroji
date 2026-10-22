import type { WorkItemAgentRunsResponse } from '@mukuroji/contracts'
import useSWR from 'swr'
import { listWorkItemAgentRuns } from '../api/agentRuns'

/** Interval for picking up runs that agents start or finish while the detail stays open. */
const agentRunsRefreshInterval = 30_000

/** Shortest delay before the refresh that shows an expiring lease as stalled. */
const minimumLeaseRefreshDelay = 5_000

/**
 * Chooses when to read the runs again: at the regular interval, or sooner when the active run's
 * lease expires first, so the server-derived stalled state appears without a reload.
 *
 * @param latest - Latest response, if any.
 * @param now - Current time in milliseconds.
 * @returns Delay in milliseconds.
 */
export function readAgentRunsRefreshDelay(latest: WorkItemAgentRunsResponse | undefined, now: number): number {
  const active = latest?.items.find((run) => run.state === 'active' && !run.stalled)
  if (!active) return agentRunsRefreshInterval
  const untilExpiry = Date.parse(active.leaseExpiresAt) - now + 1_000
  if (!Number.isFinite(untilExpiry)) return agentRunsRefreshInterval
  return Math.min(agentRunsRefreshInterval, Math.max(minimumLeaseRefreshDelay, untilExpiry))
}

/**
 * Reads the newest Agent Runs of a Work Item and keeps them current while the detail is open.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns SWR state of the run history.
 */
export function useWorkItemAgentRuns(
  accessToken: string | undefined,
  teamId: string,
  workItemId: string,
) {
  return useSWR(
    accessToken ? ['work-item-agent-runs', accessToken, teamId, workItemId] as const : null,
    ([, token, currentTeamId, currentWorkItemId]) =>
      listWorkItemAgentRuns(token, currentTeamId, currentWorkItemId),
    {
      dedupingInterval: 10_000,
      refreshInterval: (latest) => readAgentRunsRefreshDelay(latest, Date.now()),
      shouldRetryOnError: false,
    },
  )
}
