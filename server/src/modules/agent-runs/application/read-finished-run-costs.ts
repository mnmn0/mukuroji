import { AGENT_RUN_USAGE_MAX_BUCKETS_PER_RUN } from '@mukuroji/contracts'
import { createAgentRunIntegrityError } from '../domain/agent-run-error'
import type { StoredAgentRun } from '../domain/agent-run'
import {
  agentUsageRunBucketRange,
  isAgentUsageBucketInRun,
  type AgentUsageBucket,
} from '../domain/agent-run-usage'

/** Largest page the finished-run index returns. */
const FINISHED_RUN_INDEX_PAGE_SIZE = 100

/** Most finished-run index pages one read passes over, across both groups. */
const MAX_FINISHED_RUN_INDEX_PAGES = 100

/** Concurrent run and usage reads. */
const FINISHED_RUN_COST_READ_CONCURRENCY = 10

/** Finished-run groups of the index; together they hold every finished run. */
const FINISHED_RUN_GROUPS = ['failed', 'other'] as const

/** Reads of the Agent Runs table that the cost read needs. */
export type FinishedRunCostReadPorts = {
  /** Lists one page of a Team's finished-run index, newest finish first. */
  listFinishedRunsByTime(
    directoryId: string,
    teamId: string,
    group: (typeof FINISHED_RUN_GROUPS)[number],
    since: string | undefined,
    cursor: string | undefined,
    limit: number,
    until?: string,
  ): Promise<{
    /** Finished runs on the page. */
    runs: readonly {
      /** Run ID. */
      runId: string
      /** Work Item of the run. */
      workItemId: string
      /** Finish time. */
      finishedAt: string
    }[]
    /** Continuation for the next page; absent on the last page. */
    nextCursor?: string
  }>
  /** Strongly reads one run. */
  getRun(directoryId: string, teamId: string, runId: string): Promise<StoredAgentRun | undefined>
  /** Reads a member's usage buckets of one agent instance in a bucket range. */
  listMemberBuckets(
    directoryId: string,
    memberKey: string,
    instanceIdHash: string,
    from: string,
    until: string | undefined,
    limit: number,
  ): Promise<{
    /** Buckets in start order. */
    buckets: readonly AgentUsageBucket[]
    /** Whether more buckets existed than the limit allowed. */
    hasMore: boolean
  }>
}

/** What a finished-run cost read returns. */
export type FinishedRunCosts = {
  /** Runs with a reported cost, newest finish first. */
  runs: {
    /** UTC ISO 8601 finish time from the run row. */
    finishedAt: string
    /** Estimated cost in millionths of a US dollar. */
    costMicroUsd: number
  }[]
  /**
   * True when the read stopped at its run or index page limit, or a run had more usage than one
   * read returns, so the cost is a lower bound.
   */
  truncated: boolean
}

/**
 * Reads the estimated cost of the Agent Runs of a Team that finished within an instant range on
 * given Work Items, attributing usage to each run the same way as ADR 0061. Runs without a reported
 * cost are left out. The read stops after `maxRuns` runs with a cost or
 * {@link MAX_FINISHED_RUN_INDEX_PAGES} index pages and then marks itself truncated; the index lists
 * the newest runs first, so a cut read keeps the most recent runs.
 *
 * The caller has already decided the viewer may see the cost of these Work Items (ADR 0119).
 *
 * @param ports - Agent Runs table reads.
 * @param input - Team, Work Items, instant range, and run limit.
 * @returns The runs' costs.
 * @throws AgentRunError when a run row does not match its index entry.
 */
export async function readFinishedAgentRunCosts(
  ports: FinishedRunCostReadPorts,
  input: {
    /** Workspace directory ID. */
    workspaceId: string
    /** Team ID. */
    teamId: string
    /** Work Items whose runs count. */
    workItemIds: ReadonlySet<string>
    /** Inclusive lower finish instant, or undefined for no lower bound. */
    since?: string
    /** Inclusive upper finish instant. */
    until: string
    /** Most runs with a cost to return. */
    maxRuns: number
  },
): Promise<FinishedRunCosts> {
  const sinceAt = input.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(input.since)
  const untilAt = Date.parse(input.until)
  const references: { runId: string; workItemId: string }[] = []
  let truncated = false
  let pagesLeft = MAX_FINISHED_RUN_INDEX_PAGES
  for (const group of FINISHED_RUN_GROUPS) {
    let cursor: string | undefined
    do {
      if (pagesLeft <= 0) {
        truncated = true
        break
      }
      pagesLeft -= 1
      const page = await ports.listFinishedRunsByTime(
        input.workspaceId,
        input.teamId,
        group,
        input.since,
        cursor,
        FINISHED_RUN_INDEX_PAGE_SIZE,
        input.until,
      )
      for (const entry of page.runs) {
        const finishedAt = Date.parse(entry.finishedAt)
        if (!(finishedAt >= sinceAt && finishedAt <= untilAt) || !input.workItemIds.has(entry.workItemId)) continue
        references.push({ runId: entry.runId, workItemId: entry.workItemId })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
  }
  const runs: FinishedRunCosts['runs'] = []
  // Runs are read in batches so the limit stops reading once enough runs with a cost are found.
  for (let start = 0; start < references.length; start += FINISHED_RUN_COST_READ_CONCURRENCY) {
    if (runs.length >= input.maxRuns) {
      truncated = true
      break
    }
    const batch = references.slice(start, start + FINISHED_RUN_COST_READ_CONCURRENCY)
    const costs = await Promise.all(batch.map(async (reference) => await readRunCost(ports, input.workspaceId, input.teamId, reference)))
    for (const cost of costs) {
      if (cost === undefined) continue
      if (cost.hasMore) truncated = true
      if (runs.length >= input.maxRuns) {
        truncated = true
        break
      }
      runs.push({ finishedAt: cost.finishedAt, costMicroUsd: cost.costMicroUsd })
    }
  }
  return { runs, truncated }
}

/**
 * Reads one run and the cost of the usage attributed to it.
 *
 * @param ports - Agent Runs table reads.
 * @param workspaceId - Workspace ID.
 * @param teamId - Team ID.
 * @param reference - Index entry of the run.
 * @returns The cost, or undefined when the run is gone, unfinished, or has no usage.
 * @throws AgentRunError when the run row does not match its index entry.
 */
async function readRunCost(
  ports: FinishedRunCostReadPorts,
  workspaceId: string,
  teamId: string,
  reference: { runId: string; workItemId: string },
): Promise<{ finishedAt: string; costMicroUsd: number; hasMore: boolean } | undefined> {
  const run = await ports.getRun(workspaceId, teamId, reference.runId)
  // The index is eventually consistent; a run it lists but the table no longer holds adds nothing.
  if (run === undefined) return undefined
  if (run.teamId !== teamId || run.workItemId !== reference.workItemId) throw createAgentRunIntegrityError()
  if (run.finishedAt === undefined || !Number.isFinite(Date.parse(run.finishedAt))) return undefined
  const range = agentUsageRunBucketRange(run)
  const page = await ports.listMemberBuckets(
    workspaceId,
    run.assigneeUserId,
    run.instanceIdHash,
    range.from,
    range.until,
    AGENT_RUN_USAGE_MAX_BUCKETS_PER_RUN,
  )
  let costMicroUsd = 0
  let counted = false
  for (const bucket of page.buckets) {
    if (!isAgentUsageBucketInRun(bucket, run)) continue
    costMicroUsd += bucket.costMicroUsd
    counted = true
  }
  if (!counted && !page.hasMore) return undefined
  return { finishedAt: run.finishedAt, costMicroUsd, hasMore: page.hasMore }
}
