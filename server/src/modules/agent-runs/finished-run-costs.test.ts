import { describe, expect, test } from 'bun:test'
import type { StoredAgentRun } from './domain/agent-run'
import type { AgentUsageBucket } from './domain/agent-run-usage'
import { readFinishedAgentRunCosts, type FinishedRunCostReadPorts } from './application/read-finished-run-costs'

/**
 * Builds a finished run row.
 *
 * @param runId - Run ID.
 * @param workItemId - Work Item of the run.
 * @param finishedAt - Finish time.
 * @returns The run.
 */
function run(runId: string, workItemId: string, finishedAt: string): StoredAgentRun {
  return {
    schemaVersion: 1,
    runId,
    directoryId: 'w',
    teamId: 't',
    workItemId,
    assigneeUserId: 'member',
    runtime: 'claude-code',
    agentName: 'agent',
    instanceIdHash: `hash-${runId}`,
    credentialId: 'credential',
    state: 'finished',
    outcome: 'completed',
    startRevision: 1,
    leaseMinutes: 30,
    startedAt: new Date(Date.parse(finishedAt) - 600_000).toISOString(),
    lastHeartbeatAt: finishedAt,
    leaseExpiresAt: finishedAt,
    finishedAt,
    reportCount: 0,
  }
}

/**
 * Builds a usage bucket.
 *
 * @param bucketStart - Bucket start.
 * @param instanceIdHash - Agent instance hash.
 * @param costMicroUsd - Cost.
 * @returns The bucket.
 */
function bucket(bucketStart: string, instanceIdHash: string, costMicroUsd: number): AgentUsageBucket {
  return {
    bucketStart,
    instanceIdHash,
    model: 'model',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costMicroUsd,
    requestCount: 1,
  }
}

/** Runs of the Team keyed by ID. */
const runs = new Map([
  ['r1', run('r1', 'a', '2026-01-05T01:00:00.000Z')],
  ['r2', run('r2', 'other', '2026-01-05T02:00:00.000Z')],
  ['r3', run('r3', 'a', '2026-01-05T03:00:00.000Z')],
])

/**
 * Builds ports over the fixed runs.
 *
 * @param bucketsHaveMore - Whether every usage read reports more buckets.
 * @returns The ports.
 */
function ports(bucketsHaveMore = false): FinishedRunCostReadPorts {
  return {
    listFinishedRunsByTime: async (_directoryId, _teamId, group) => ({
      runs: group === 'other'
        ? [...runs.values()].reverse().map((entry) => ({ runId: entry.runId, workItemId: entry.workItemId, finishedAt: entry.finishedAt ?? '' }))
        : [],
    }),
    getRun: async (_directoryId, _teamId, runId) => runs.get(runId),
    listMemberBuckets: async (_directoryId, _memberKey, instanceIdHash, from) => ({
      buckets: [
        bucket(from, instanceIdHash, 1_000_000),
        // Another instance of the same member is not the run's usage.
        bucket(from, 'someone-else', 9_000_000),
      ],
      hasMore: bucketsHaveMore,
    }),
  }
}

describe('readFinishedAgentRunCosts', () => {
  test('reads the cost of runs on the given Work Items, newest first', async () => {
    const costs = await readFinishedAgentRunCosts(ports(), {
      workspaceId: 'w',
      teamId: 't',
      workItemIds: new Set(['a']),
      until: '2026-01-06T00:00:00.000Z',
      maxRuns: 10,
    })

    expect(costs).toEqual({
      runs: [
        { finishedAt: '2026-01-05T03:00:00.000Z', costMicroUsd: 1_000_000 },
        { finishedAt: '2026-01-05T01:00:00.000Z', costMicroUsd: 1_000_000 },
      ],
      truncated: false,
    })
  })

  test('marks the read truncated at the run limit and when a run has more usage', async () => {
    const limited = await readFinishedAgentRunCosts(ports(), {
      workspaceId: 'w',
      teamId: 't',
      workItemIds: new Set(['a', 'other']),
      since: '2026-01-05T00:00:00.000Z',
      until: '2026-01-06T00:00:00.000Z',
      maxRuns: 1,
    })
    expect(limited.runs).toHaveLength(1)
    expect(limited.truncated).toBe(true)

    const more = await readFinishedAgentRunCosts(ports(true), {
      workspaceId: 'w',
      teamId: 't',
      workItemIds: new Set(['a']),
      until: '2026-01-06T00:00:00.000Z',
      maxRuns: 10,
    })
    expect(more.truncated).toBe(true)
  })

  test('fails when a run row does not match its index entry', async () => {
    const base = ports()
    await expect(readFinishedAgentRunCosts({
      ...base,
      getRun: async () => run('r1', 'b', '2026-01-05T01:00:00.000Z'),
    }, { workspaceId: 'w', teamId: 't', workItemIds: new Set(['a']), until: '2026-01-06T00:00:00.000Z', maxRuns: 10 }))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })
})

describe('readFinishedAgentRunCosts ordering and bounds', () => {
  test('merges both groups by finish time before the run limit', async () => {
    const failed = run('f1', 'a', '2026-01-05T00:30:00.000Z')
    const newer = run('o1', 'a', '2026-01-05T05:00:00.000Z')
    const rows = new Map([[failed.runId, failed], [newer.runId, newer]])
    const base = ports()
    const costs = await readFinishedAgentRunCosts({
      ...base,
      listFinishedRunsByTime: async (_directoryId, _teamId, group) => {
        const entry = group === 'failed' ? failed : newer
        return { runs: [{ runId: entry.runId, workItemId: entry.workItemId, finishedAt: entry.finishedAt ?? '' }] }
      },
      getRun: async (_directoryId, _teamId, runId) => rows.get(runId),
    }, { workspaceId: 'w', teamId: 't', workItemIds: new Set(['a']), until: '2026-01-06T00:00:00.000Z', maxRuns: 1 })

    expect(costs.runs).toEqual([{ finishedAt: '2026-01-05T05:00:00.000Z', costMicroUsd: 1_000_000 }])
    expect(costs.truncated).toBe(true)
  })

  test('reads nothing for a range that ends before it starts', async () => {
    const calls: string[] = []
    const base = ports()
    const costs = await readFinishedAgentRunCosts({
      ...base,
      listFinishedRunsByTime: async (...args) => {
        calls.push(String(args[2]))
        return await base.listFinishedRunsByTime(...args)
      },
    }, { workspaceId: 'w', teamId: 't', workItemIds: new Set(['a']), since: '2026-02-01T00:00:00.000Z', until: '2026-01-06T00:00:00.000Z', maxRuns: 10 })

    expect(costs).toEqual({ runs: [], truncated: false })
    expect(calls).toEqual([])
  })
})
