import { AGENT_RUN_USAGE_MAX_BUCKETS_PER_RUN, type AgentRunActivity, type AgentRunUsage } from '@mukuroji/contracts'
import {
  agentUsageRunBucketRange,
  summarizeAgentActivity,
  isAgentUsageBucketInRun,
  summarizeAgentUsage,
  type StoredAgentRun,
} from '../../modules/agent-runs'
import { workItemDependencies } from './app-dependencies'

/**
 * Reads the telemetry usage attributed to a run: the buckets of the run's member and instance that
 * start between the run's start and finish (ADR 0061). The caller has already authorized the viewer
 * for the run's Work Item.
 *
 * @param directoryId - Workspace ID.
 * @param run - Run.
 * @param includeCost - Whether the viewer may see the estimated cost.
 * @returns The run's usage, or undefined when none arrived.
 */
export async function readAgentRunUsage(directoryId: string, run: StoredAgentRun, includeCost: boolean): Promise<AgentRunUsage | undefined> {
  const range = agentUsageRunBucketRange(run)
  const page = await workItemDependencies.agentRunUsage.listMemberBuckets(
    directoryId,
    run.assigneeUserId,
    run.instanceIdHash,
    range.from,
    range.until,
    AGENT_RUN_USAGE_MAX_BUCKETS_PER_RUN,
  )
  return summarizeAgentUsage(page.buckets.filter((bucket) => isAgentUsageBucketInRun(bucket, run)), includeCost, page.hasMore)
}

/**
 * Reads the tool time and estimated waits attributed to a run, with the same member, instance, and
 * bucket range as its usage (ADR 0117). The caller has already authorized the viewer for the run's
 * Work Item.
 *
 * @param directoryId - Workspace ID.
 * @param run - Run.
 * @param maxTools - Largest number of tools to list; Factory analytics passes no limit so period totals stay whole.
 * @returns The run's activity, or undefined when none arrived.
 */
export async function readAgentRunActivity(
  directoryId: string,
  run: StoredAgentRun,
  maxTools?: number,
): Promise<AgentRunActivity | undefined> {
  const range = agentUsageRunBucketRange(run)
  const page = await workItemDependencies.agentRunUsage.listMemberActivity(
    directoryId,
    run.assigneeUserId,
    run.instanceIdHash,
    range.from,
    range.until,
    AGENT_RUN_USAGE_MAX_BUCKETS_PER_RUN,
  )
  return summarizeAgentActivity(page.rows.filter((row) => isAgentUsageBucketInRun(row, run)), page.hasMore, maxTools)
}
