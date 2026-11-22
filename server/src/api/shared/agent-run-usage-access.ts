import { AGENT_RUN_USAGE_MAX_BUCKETS_PER_RUN, type AgentRunUsage } from '@mukuroji/contracts'
import {
  agentUsageRunBucketRange,
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
    range.from,
    range.until,
    AGENT_RUN_USAGE_MAX_BUCKETS_PER_RUN,
  )
  return summarizeAgentUsage(page.buckets.filter((bucket) => isAgentUsageBucketInRun(bucket, run)), includeCost, page.hasMore)
}
