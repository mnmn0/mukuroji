import { describe, expect, test } from 'bun:test'
import type { PutRecordBatchCommand } from '@aws-sdk/client-firehose'
import { createActiveAgentRun, finishAgentRun } from './domain/agent-run'
import {
  AGENT_ANALYTICS_MAX_RECORDS_PER_BATCH,
  agentAnalyticsMemberKey,
  agentAnalyticsWorkspaceKey,
  batchAgentAnalyticsRecords,
  buildAgentAnalyticsRunStartRow,
  buildAgentAnalyticsRunStateRow,
  deriveAgentAnalyticsBatchId,
  packAgentAnalyticsRecords,
  readAgentAnalyticsCompareFields,
} from './domain/agent-telemetry-analytics'
import {
  AgentTelemetryAnalyticsWriteError,
  FirehoseAgentTelemetryAnalyticsSink,
  type AgentTelemetryAnalyticsFirehoseClient,
} from './adapter-out/firehose/agent-telemetry-analytics-sink'
import { InMemoryAgentTelemetryAnalyticsSink } from './adapter-out/in-memory/agent-telemetry-analytics-sink'
import { InMemoryAgentRunUsageStore } from './adapter-out/in-memory/agent-run-usage-store'
import { DynamoDbAgentRunUsageStore, type AgentRunUsageDocumentClient } from './adapter-out/dynamodb/agent-run-usage-store'
import { runAgentAnalyticsDailyExport } from './adapter-in/schedules/agent-analytics-daily-export'
import { createAgentTelemetryAnalyticsSink } from '../../app/composition/agent-telemetry-analytics'

const startedAt = new Date('2026-11-20T03:00:00.000Z')

/**
 * Creates a run of the fixture Workspace.
 *
 * @param runId - Run ID.
 * @param workItemId - Work Item ID.
 * @returns Active run.
 */
function run(runId: string, workItemId = 'task-1') {
  return createActiveAgentRun({
    directoryId: 'user#owner@example.com',
    teamId: 'core',
    workItemId,
    assigneeUserId: 'owner@example.com',
    start: { runtime: 'claude-code', agentName: 'Claude Code', instanceIdHash: 'a'.repeat(64) },
    credentialId: 'key-1',
    startRevision: 2,
    leaseMinutes: 30,
    now: startedAt,
    runId,
  })
}

describe('analytics rows', () => {
  test('give exports that differ only in usage values different batch IDs', () => {
    const request = {
      name: 'api_request' as const,
      instanceIdHash: 'instance',
      occurredAtMs: 1_000,
      sessionHash: 'session',
      model: 'model-a',
      inputTokens: 10,
      outputTokens: 5,
    }
    const batchId = deriveAgentAnalyticsBatchId('member', [request])
    expect(deriveAgentAnalyticsBatchId('member', [{ ...request }])).toBe(batchId)
    expect(deriveAgentAnalyticsBatchId('member', [{ ...request, model: 'model-b' }])).not.toBe(batchId)
    expect(deriveAgentAnalyticsBatchId('member', [{ ...request, outputTokens: 6 }])).not.toBe(batchId)
    expect(deriveAgentAnalyticsBatchId('member', [{ ...request, costMicroUsd: 1 }])).not.toBe(batchId)
  })

  test('keep level-like custom fields only, and name the Workspace and member by keys', () => {
    const definitions = [
      { id: 'size', type: 'select' as const },
      { id: 'tags', type: 'multi-select' as const },
      { id: 'notes', type: 'text' as const },
      { id: 'owner', type: 'person' as const },
      { id: 'points', type: 'number' as const },
    ]
    expect(readAgentAnalyticsCompareFields({ size: 'm', tags: ['b', 'a'], notes: 'private', owner: 'someone', points: 3 }, definitions))
      .toBe(JSON.stringify({ size: 'm', tags: ['a', 'b'], points: 3 }))
    expect(readAgentAnalyticsCompareFields({ notes: 'private', tags: [] }, definitions)).toBeUndefined()

    const memberKey = agentAnalyticsMemberKey('1'.repeat(64), 'user#owner@example.com', 'owner@example.com')
    expect(memberKey).toMatch(/^[0-9a-f]{32}$/u)
    expect(agentAnalyticsMemberKey('2'.repeat(64), 'user#owner@example.com', 'owner@example.com')).not.toBe(memberKey)
    const row = buildAgentAnalyticsRunStartRow(
      run('run_1'),
      { statusCategory: 'started', workItemTypeId: 'bug', schedule: { plannedEffortMinutes: 90 }, priority: 'high', customFieldValues: { notes: 'private', size: 'm' } },
      definitions,
      memberKey,
      startedAt,
    )
    expect(row).toEqual({
      workspace_key: agentAnalyticsWorkspaceKey('user#owner@example.com'),
      run_id: 'run_1',
      record_kind: 'started',
      recorded_at_ms: startedAt.getTime(),
      team_id: 'core',
      work_item_id: 'task-1',
      instance_hash: 'a'.repeat(64),
      runtime: 'claude-code',
      started_at_ms: startedAt.getTime(),
      member_key: memberKey,
      work_item_type_id: 'bug',
      planned_effort_minutes: 90,
      size_band: 'up-to-2h',
      priority: 'high',
      compare_fields_json: JSON.stringify({ size: 'm' }),
    })
    expect(JSON.stringify(row)).not.toContain('owner@example.com')
    const finished = buildAgentAnalyticsRunStateRow(finishAgentRun(run('run_1'), 'completed', 'agent', new Date(startedAt.getTime() + 60_000)), startedAt)
    expect(finished).toMatchObject({ record_kind: 'daily', state: 'finished', outcome: 'completed', finished_at_ms: startedAt.getTime() + 60_000 })
    expect(finished).not.toHaveProperty('member_key')
  })

  test('pack rows into newline-separated records and batches within the Firehose limits', () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({ id: index }))
    const records = packAgentAnalyticsRecords(rows)
    expect(records.map((record) => Buffer.from(record).toString())).toEqual(['{"id":0}\n{"id":1}\n{"id":2}\n'])
    const large = Array.from({ length: 3 }, () => ({ text: 'x'.repeat(400 * 1024) }))
    expect(packAgentAnalyticsRecords(large)).toHaveLength(2)
    // Firehose splits at most 500 JSON rows out of one record.
    const small = Array.from({ length: 1_201 }, (_, index) => ({ id: index }))
    const smallRecords = packAgentAnalyticsRecords(small).map((record) => Buffer.from(record).toString().split('\n').length - 1)
    expect(smallRecords).toEqual([500, 500, 201])
    const many = Array.from({ length: AGENT_ANALYTICS_MAX_RECORDS_PER_BATCH + 1 }, () => new Uint8Array(1))
    expect(batchAgentAnalyticsRecords(many).map((batch) => batch.length)).toEqual([AGENT_ANALYTICS_MAX_RECORDS_PER_BATCH, 1])
  })
})

describe('Firehose analytics sink', () => {
  test('sends refused records again and fails when Firehose keeps refusing them', async () => {
    const sent: number[] = []
    let refuse = 1
    const client: AgentTelemetryAnalyticsFirehoseClient = {
      /**
       * Accepts the batch except the first record while refusals remain.
       * @param command - Batch.
       * @returns Per-record results.
       */
      async send(command: PutRecordBatchCommand) {
        const records = command.input.Records ?? []
        sent.push(records.length)
        if (refuse === 0) return { FailedPutCount: 0, RequestResponses: records.map(() => ({})) }
        refuse -= 1
        return { FailedPutCount: 1, RequestResponses: records.map((_, index) => index === 0 ? { ErrorCode: 'ServiceUnavailableException' } : {}) }
      },
    }
    const sink = new FirehoseAgentTelemetryAnalyticsSink(client, { events: 'e', runs: 'r', workItems: 'w' }, undefined)
    expect(sink.memberPseudonym('workspace', 'member')).toBeUndefined()
    // Two large rows do not fit one record, so the batch carries two records.
    const rows = Array.from({ length: 2 }, () => ({ ...buildAgentAnalyticsRunStateRow(run('run_1'), startedAt), outcome: 'x'.repeat(500 * 1024) }))
    await sink.putRuns(rows)
    expect(sent).toEqual([2, 1])
    refuse = 10
    sent.length = 0
    await expect(sink.putRuns(rows)).rejects.toBeInstanceOf(AgentTelemetryAnalyticsWriteError)
    expect(sent).toEqual([2, 1, 1])
  })

  test('is created only when every stream is configured', () => {
    expect(createAgentTelemetryAnalyticsSink({}).enabled).toBe(false)
    expect(createAgentTelemetryAnalyticsSink({ AGENT_ANALYTICS_EVENTS_STREAM_NAME: 'e', AGENT_ANALYTICS_RUNS_STREAM_NAME: 'r' }).enabled).toBe(false)
    const sink = createAgentTelemetryAnalyticsSink({
      AGENT_ANALYTICS_EVENTS_STREAM_NAME: 'e',
      AGENT_ANALYTICS_RUNS_STREAM_NAME: 'r',
      AGENT_ANALYTICS_WORK_ITEMS_STREAM_NAME: 'w',
      MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY: 'not-a-key',
    })
    expect(sink.enabled).toBe(true)
    // A malformed key is not used, so no row names a member.
    expect(sink.memberPseudonym('workspace', 'member')).toBeUndefined()
  })
})

describe('daily analytics export', () => {
  test('writes the state of noted runs and their Work Items, skipping closed Workspaces and missing rows', async () => {
    const usage = new InMemoryAgentRunUsageStore()
    const sink = new InMemoryAgentTelemetryAnalyticsSink()
    const runs = new Map([
      ['run_1', finishAgentRun(run('run_1'), 'completed', 'agent', new Date(startedAt.getTime() + 60_000))],
      ['run_2', run('run_2')],
      ['run_3', run('run_3', 'task-gone')],
    ])
    for (const runId of ['run_1', 'run_2', 'run_3', 'run_missing']) {
      await usage.watchRunForAnalytics({ directoryId: 'user#owner@example.com', teamId: 'core', runId }, startedAt)
    }
    await usage.watchRunForAnalytics({ directoryId: 'closed', teamId: 'core', runId: 'run_9' }, startedAt)
    // Older than the window.
    await usage.watchRunForAnalytics({ directoryId: 'user#owner@example.com', teamId: 'core', runId: 'run_old' }, new Date('2026-10-01T00:00:00Z'))
    const read: string[] = []
    const result = await runAgentAnalyticsDailyExport({
      usage,
      async readRun(_directoryId, _teamId, runId) {
        read.push(runId)
        return runs.get(runId)
      },
      async readWorkItem(_directoryId, _teamId, workItemId) {
        return workItemId === 'task-gone' ? undefined : { statusCategory: 'completed', actualEndDate: '2026-11-21', schedule: { plannedEffortMinutes: 600 } }
      },
      isWorkspaceActive: async (workspaceId) => workspaceId !== 'closed',
      sink,
      now: new Date('2026-11-28T00:00:00.000Z'),
    })
    expect(result).toEqual({ runs: 2, workItems: 1, skipped: 3 })
    expect(read.sort()).toEqual(['run_1', 'run_2', 'run_3', 'run_missing'])
    expect(sink.runs.map((row) => [row.run_id, row.state, row.outcome])).toEqual(expect.arrayContaining([
      ['run_1', 'finished', 'completed'],
      ['run_2', 'active', undefined],
    ]))
    expect(sink.workItems).toEqual([expect.objectContaining({
      work_item_id: 'task-1', status_category: 'completed', size_band: 'up-to-3d', actual_end_date: '2026-11-21', archived: false,
    })])
  })
})

describe('daily analytics export paging', () => {
  test('exports every noted run across pages and writes each Work Item once', async () => {
    const usage = new InMemoryAgentRunUsageStore()
    const sink = new InMemoryAgentTelemetryAnalyticsSink()
    const ids = Array.from({ length: 1_203 }, (_, index) => `run_${String(index).padStart(4, '0')}`)
    for (const runId of ids) await usage.watchRunForAnalytics({ directoryId: 'w', teamId: 'core', runId }, startedAt)
    const result = await runAgentAnalyticsDailyExport({
      usage,
      readRun: async (_directoryId, _teamId, runId) => run(runId),
      readWorkItem: async () => ({ statusCategory: 'started' }),
      isWorkspaceActive: async () => true,
      sink,
      now: new Date('2026-11-28T00:00:00.000Z'),
    })
    expect(result).toEqual({ runs: 1_203, workItems: 1, skipped: 0 })
    expect(new Set(sink.runs.map((row) => row.run_id)).size).toBe(1_203)
    expect(sink.workItems).toHaveLength(1)
  })
})

describe('DynamoDB analytics watches', () => {
  test('note runs in the partition of their start day with a TTL, and page through a day', async () => {
    const sent: unknown[] = []
    const client: AgentRunUsageDocumentClient = {
      /**
       * Records the command and returns one page of notes.
       * @param command - Command.
       * @returns A page.
       */
      async send(command) {
        sent.push(command.input)
        return {
          Items: [{ workspaceId: 'w1', teamId: 'core', runId: 'run_1', recordKey: 'w1#core#run_1' }],
          LastEvaluatedKey: { directoryTeamId: 'agent-analytics-watch#2026-11-20', recordKey: 'w1#core#run_1' },
        }
      },
    }
    const store = new DynamoDbAgentRunUsageStore(client, 'runs')
    await store.watchRunForAnalytics({ directoryId: 'w1', teamId: 'core', runId: 'run_1' }, startedAt)
    expect(sent[0]).toMatchObject({
      TableName: 'runs',
      Item: {
        directoryTeamId: 'agent-analytics-watch#2026-11-20',
        recordKey: 'w1#core#run_1',
        usageExpiresAt: Math.floor(startedAt.getTime() / 1_000) + 32 * 86_400,
      },
    })
    const page = await store.listAnalyticsWatches('2026-11-20', 'w0#core#run_0', 10)
    expect(page).toEqual({ watches: [{ directoryId: 'w1', teamId: 'core', runId: 'run_1' }], nextCursor: 'w1#core#run_1' })
    expect(sent[1]).toMatchObject({ ExclusiveStartKey: { directoryTeamId: 'agent-analytics-watch#2026-11-20', recordKey: 'w0#core#run_0' }, Limit: 10 })
  })
})
