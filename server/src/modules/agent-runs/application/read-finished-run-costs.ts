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

/** Read progress of one finished-run group. */
type FinishedRunGroupRead = {
  /** Group of the index. */
  group: (typeof FINISHED_RUN_GROUPS)[number]
  /** Continuation of the next page; absent before the first page and after the last. */
  cursor?: string
  /** Whether the last page was read. */
  done: boolean
  /** Oldest finish time the group returned so far, epoch milliseconds. */
  oldestRead: number
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
 * cost are left out. Both finished-run groups are merged by finish time, newest first. The read
 * stops after `maxRuns` runs with a cost or {@link MAX_FINISHED_RUN_INDEX_PAGES} index pages and
 * then marks itself truncated, keeping the most recent runs.
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
  // A range that ends before it starts, such as a report period after today, has no runs, and the
  // index query would reject the reversed bounds.
  if (!(sinceAt <= untilAt)) return { runs: [], truncated: false }
  const references: { runId: string; workItemId: string; finishedAt: number }[] = []
  let truncated = false
  let pagesLeft = MAX_FINISHED_RUN_INDEX_PAGES
  // Both groups are read a page at a time in turn, so neither uses up the page allowance before
  // the other, and their runs are merged by finish time afterwards.
  const groups = FINISHED_RUN_GROUPS.map((group): FinishedRunGroupRead => ({
    group,
    done: false,
    oldestRead: Number.POSITIVE_INFINITY,
  }))
  while (groups.some((state) => !state.done)) {
    for (const state of groups) {
      if (state.done) continue
      if (pagesLeft <= 0) {
        truncated = true
        break
      }
      pagesLeft -= 1
      const page = await ports.listFinishedRunsByTime(
        input.workspaceId,
        input.teamId,
        state.group,
        input.since,
        state.cursor,
        FINISHED_RUN_INDEX_PAGE_SIZE,
        input.until,
      )
      for (const entry of page.runs) {
        const finishedAt = Date.parse(entry.finishedAt)
        if (finishedAt < state.oldestRead) state.oldestRead = finishedAt
        if (!(finishedAt >= sinceAt && finishedAt <= untilAt) || !input.workItemIds.has(entry.workItemId)) continue
        references.push({ runId: entry.runId, workItemId: entry.workItemId, finishedAt })
      }
      state.cursor = page.nextCursor
      state.done = page.nextCursor === undefined
    }
    if (pagesLeft <= 0 && groups.some((state) => !state.done)) {
      truncated = true
      break
    }
  }
  // When a group was cut, runs older than the oldest run it returned may be missing from it, so
  // only runs at or after that point are kept and the kept runs are the newest ones of both groups.
  const cutAt = Math.max(...groups.filter((state) => !state.done).map((state) => state.oldestRead), Number.NEGATIVE_INFINITY)
  references.sort((left, right) => right.finishedAt - left.finishedAt)
  const kept = references.filter((reference) => reference.finishedAt >= cutAt)
  const runs: FinishedRunCosts['runs'] = []
  // Runs are read in batches so the limit stops reading once enough runs with a cost are found.
  for (let start = 0; start < kept.length; start += FINISHED_RUN_COST_READ_CONCURRENCY) {
    if (runs.length >= input.maxRuns) {
      truncated = true
      break
    }
    const batch = kept.slice(start, start + FINISHED_RUN_COST_READ_CONCURRENCY)
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
  reference: { runId: string; workItemId: string; finishedAt: number },
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
