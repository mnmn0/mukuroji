import { describe, expect, test } from 'bun:test'
import { hashAgentInstanceId } from './domain/agent-run'
import {
  AgentTelemetryFormatError,
  agentUsageRunBucketRange,
  combineAgentRunUsage,
  deriveAgentTelemetryBatchId,
  formatUsageBucketStart,
  groupAgentUsageBuckets,
  isAgentUsageBucketInRun,
  parseAgentTelemetryLogs,
  summarizeAgentUsage,
  summarizeFactoryUsage,
  UNKNOWN_AGENT_INSTANCE_HASH,
} from './domain/agent-run-usage'
import { DynamoDbAgentRunUsageStore, type AgentRunUsageDocumentClient } from './adapter-out/dynamodb/agent-run-usage-store'
import { InMemoryAgentRunUsageStore } from './adapter-out/in-memory/agent-run-usage-store'

const now = new Date('2026-11-22T18:00:00.000Z')

/**
 * Converts a time to the OTLP nanosecond string.
 *
 * @param iso - ISO 8601 time.
 * @returns Epoch nanoseconds as a decimal string.
 */
function nanos(iso: string): string {
  return `${BigInt(Date.parse(iso)) * 1_000_000n}`
}

/**
 * Builds one Claude Code `api_request` log record in the OTLP JSON encoding.
 *
 * @param iso - Request time.
 * @param overrides - Attribute values to replace or add.
 * @returns OTLP `LogRecord`.
 */
function apiRequest(iso: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {
    'event.name': { stringValue: 'api_request' },
    model: { stringValue: 'claude-sonnet-5-5' },
    input_tokens: { intValue: '120' },
    output_tokens: { intValue: '30' },
    cache_read_tokens: { intValue: '1000' },
    cache_creation_tokens: { intValue: '0' },
    cost_usd: { doubleValue: 0.0125 },
    prompt: { stringValue: 'secret prompt text' },
    ...overrides,
  }
  return {
    timeUnixNano: nanos(iso),
    body: { stringValue: 'claude_code.api_request' },
    attributes: Object.entries(values).map(([key, value]) => ({ key, value })),
  }
}

/**
 * Wraps log records in an export for one agent instance.
 *
 * @param records - Log records.
 * @param instanceId - Raw `mukuroji.agent_instance` value, or null to omit it.
 * @returns OTLP `ExportLogsServiceRequest`.
 */
function exportOf(records: unknown[], instanceId: string | null = 'laptop'): Record<string, unknown> {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          ...(instanceId === null ? [] : [{ key: 'mukuroji.agent_instance', value: { stringValue: instanceId } }]),
        ],
      },
      scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: records }],
    }],
  }
}

describe('agent telemetry parsing', () => {
  test('reads only usage fields of api_request records and drops other events and content', () => {
    const parsed = parseAgentTelemetryLogs(exportOf([
      apiRequest('2026-11-22T17:05:12.500Z'),
      { timeUnixNano: nanos('2026-11-22T17:05:13Z'), body: { stringValue: 'claude_code.user_prompt' }, attributes: [{ key: 'prompt', value: { stringValue: 'x' } }] },
    ]), now)
    expect(parsed.rejectedRecords).toBe(0)
    expect(parsed.events).toEqual([{
      instanceIdHash: hashAgentInstanceId('laptop'),
      occurredAtMs: Date.parse('2026-11-22T17:05:12.500Z'),
      model: 'claude-sonnet-5-5',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 1000,
      cacheCreationTokens: 0,
      costMicroUsd: 12_500,
    }])
    expect(JSON.stringify(parsed)).not.toContain('secret prompt text')
  })

  test('accepts numeric strings and event.timestamp, and a record attribute instance over the resource', () => {
    const record = apiRequest('2026-11-22T17:05:12Z', {
      input_tokens: { stringValue: '7' },
      cost_usd: { stringValue: '0.5' },
      'mukuroji.agent_instance': { stringValue: 'desktop' },
      'event.timestamp': { stringValue: '2026-11-22T17:06:00.000Z' },
    })
    delete record.timeUnixNano
    const [event] = parseAgentTelemetryLogs(exportOf([record]), now).events
    expect(event).toMatchObject({
      inputTokens: 7,
      costMicroUsd: 500_000,
      instanceIdHash: hashAgentInstanceId('desktop'),
      occurredAtMs: Date.parse('2026-11-22T17:06:00.000Z'),
    })
  })

  test('prefers cost_usd_micros over cost_usd', () => {
    const [event] = parseAgentTelemetryLogs(exportOf([apiRequest('2026-11-22T17:05:12Z', { cost_usd_micros: { intValue: '12345' } })]), now).events
    expect(event?.costMicroUsd).toBe(12_345)
  })

  test('marks usage without an instance as unknown', () => {
    const [event] = parseAgentTelemetryLogs(exportOf([apiRequest('2026-11-22T17:05:12Z')], null), now).events
    expect(event?.instanceIdHash).toBe(UNKNOWN_AGENT_INSTANCE_HASH)
  })

  test('rejects malformed usage and records outside the time window', () => {
    const parsed = parseAgentTelemetryLogs(exportOf([
      apiRequest('2026-11-22T17:05:12Z', { input_tokens: { intValue: '-1' } }),
      apiRequest('2026-11-22T17:05:12Z', { output_tokens: { doubleValue: 1.5 } }),
      apiRequest('2026-11-22T17:05:12Z', { cost_usd: { stringValue: 'NaN' } }),
      apiRequest('2026-11-10T00:00:00Z'),
      apiRequest('2026-11-22T19:00:00Z'),
      'not a record',
      apiRequest('2026-11-22T17:05:12Z'),
    ]), now)
    expect(parsed.rejectedRecords).toBe(6)
    expect(parsed.events).toHaveLength(1)
  })

  test('refuses bodies that are not log exports', () => {
    expect(() => parseAgentTelemetryLogs([], now)).toThrow(AgentTelemetryFormatError)
    expect(() => parseAgentTelemetryLogs({ resourceLogs: 'x' }, now)).toThrow(AgentTelemetryFormatError)
    const tooMany = Array.from({ length: 2_001 }, () => apiRequest('2026-11-22T17:05:12Z'))
    expect(() => parseAgentTelemetryLogs(exportOf(tooMany), now)).toThrow(AgentTelemetryFormatError)
  })

  test('strips the key separator and control characters from model names', () => {
    const [event] = parseAgentTelemetryLogs(exportOf([apiRequest('2026-11-22T17:05:12Z', { model: { stringValue: 'a#b\u0000c' } })]), now).events
    expect(event?.model).toBe('abc')
  })
})

describe('agent usage buckets and run attribution', () => {
  const events = parseAgentTelemetryLogs(exportOf([
    apiRequest('2026-11-22T17:05:01Z'),
    apiRequest('2026-11-22T17:05:09.999Z'),
    apiRequest('2026-11-22T17:05:10Z'),
  ]), now).events

  test('adds events together per 10-second bucket', () => {
    expect(formatUsageBucketStart(Date.parse('2026-11-22T17:05:19.999Z'))).toBe('2026-11-22T17:05:10Z')
    const buckets = groupAgentUsageBuckets(events)
    expect(buckets.map((bucket) => [bucket.bucketStart, bucket.requestCount, bucket.inputTokens])).toEqual([
      ['2026-11-22T17:05:00Z', 2, 240],
      ['2026-11-22T17:05:10Z', 1, 120],
    ])
  })

  test('gives a shared boundary bucket to the later of two consecutive runs only', () => {
    const instanceIdHash = hashAgentInstanceId('laptop')
    const first = { instanceIdHash, startedAt: '2026-11-22T17:00:00.000Z', finishedAt: '2026-11-22T17:05:04.000Z' }
    const second = { instanceIdHash, startedAt: '2026-11-22T17:05:06.000Z' }
    const boundary = { bucketStart: '2026-11-22T17:05:00Z', instanceIdHash }
    expect(isAgentUsageBucketInRun(boundary, first)).toBe(false)
    expect(isAgentUsageBucketInRun(boundary, second)).toBe(true)
    expect(isAgentUsageBucketInRun({ bucketStart: '2026-11-22T17:04:50Z', instanceIdHash }, first)).toBe(true)
    expect(isAgentUsageBucketInRun({ ...boundary, instanceIdHash: 'other' }, second)).toBe(false)
    expect(agentUsageRunBucketRange(first)).toEqual({ from: '2026-11-22T17:00:00Z', until: '2026-11-22T17:05:00Z' })
  })

  test('hides the cost unless asked, and combines runs', () => {
    const buckets = groupAgentUsageBuckets(events)
    const withoutCost = summarizeAgentUsage(buckets, false, false)
    expect(withoutCost).toEqual({
      inputTokens: 360, outputTokens: 90, cacheReadTokens: 3000, cacheCreationTokens: 0, requestCount: 3,
      models: ['claude-sonnet-5-5'], hasMore: false,
    })
    const withCost = summarizeAgentUsage(buckets, true, true)
    expect(withCost?.estimatedCostMicroUsd).toBe(37_500)
    expect(summarizeAgentUsage([], true, false)).toBeUndefined()
    expect(combineAgentRunUsage([withCost, undefined, withCost])).toMatchObject({ inputTokens: 720, estimatedCostMicroUsd: 75_000, hasMore: true })
    expect(combineAgentRunUsage([undefined])).toBeUndefined()
  })

  test('derives the same batch ID for a retried export and a different one for other events', () => {
    expect(deriveAgentTelemetryBatchId('member', events)).toBe(deriveAgentTelemetryBatchId('member', [...events]))
    expect(deriveAgentTelemetryBatchId('member', events)).not.toBe(deriveAgentTelemetryBatchId('other', events))
    expect(deriveAgentTelemetryBatchId('member', events)).not.toBe(deriveAgentTelemetryBatchId('member', events.slice(1)))
  })
})

describe('agent usage stores', () => {
  const buckets = groupAgentUsageBuckets(parseAgentTelemetryLogs(exportOf([
    apiRequest('2026-11-22T17:05:01Z'),
    apiRequest('2026-11-22T17:05:11Z'),
    apiRequest('2026-11-22T17:05:21Z'),
  ]), now).events)

  test('the in-memory store adds batches once and reads half-open ranges', async () => {
    const store = new InMemoryAgentRunUsageStore()
    expect(await store.recordBatch('ws', 'member', 'batch', buckets)).toBe('recorded')
    expect(await store.recordBatch('ws', 'member', 'batch', buckets)).toBe('duplicate')
    expect(await store.recordBatch('ws', 'member', 'batch-2', buckets.slice(0, 1))).toBe('recorded')
    const laptop = hashAgentInstanceId('laptop')
    const page = await store.listMemberBuckets('ws', 'member', laptop, '2026-11-22T17:05:00Z', '2026-11-22T17:05:20Z', 10)
    expect(page.buckets.map((bucket) => [bucket.bucketStart, bucket.requestCount])).toEqual([
      ['2026-11-22T17:05:00Z', 2],
      ['2026-11-22T17:05:10Z', 1],
    ])
    expect((await store.listMemberBuckets('ws', 'member', laptop, '2026-11-22T17:05:00Z', undefined, 2)).hasMore).toBe(true)
    expect((await store.listMemberBuckets('ws', 'other', laptop, '2026-11-22T17:05:00Z', undefined, 2)).buckets).toEqual([])
    expect((await store.listMemberBuckets('ws', 'member', hashAgentInstanceId('desktop'), '2026-11-22T17:05:00Z', undefined, 2)).buckets).toEqual([])
  })

  test('the DynamoDB store writes a receipt with ADD updates and treats a receipt conflict as a duplicate', async () => {
    const sent: unknown[] = []
    let conflict = false
    const client: AgentRunUsageDocumentClient = {
      async send(command) {
        sent.push(command.input)
        if (conflict) {
          throw Object.assign(new Error('cancelled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
          })
        }
        return {}
      },
    }
    const store = new DynamoDbAgentRunUsageStore(client, 'runs')
    expect(await store.recordBatch('ws', 'member', 'batch', buckets, now)).toBe('recorded')
    const input = sent[0]
    expect(input).toMatchObject({
      TransactItems: [
        {
          Put: {
            TableName: 'runs',
            Item: { directoryTeamId: 'ws#agent-usage-batch#member#member', recordKey: 'batch#0', workspaceId: 'ws' },
            ConditionExpression: 'attribute_not_exists(recordKey)',
          },
        },
        {
          Update: {
            Key: { directoryTeamId: 'ws#agent-usage#member#member', recordKey: `2026-11-22T17:05:00Z#${hashAgentInstanceId('laptop')}#claude-sonnet-5-5` },
            ExpressionAttributeValues: { ':workspaceId': 'ws', ':inputTokens': 120, ':costMicroUsd': 12_500 },
          },
        },
        {},
        {},
      ],
    })
    expect(JSON.stringify(input)).toContain('ADD #inputTokens :inputTokens')
    conflict = true
    expect(await store.recordBatch('ws', 'member', 'batch', buckets, now)).toBe('duplicate')
  })

  test('the DynamoDB store reads a member range and stops at the limit', async () => {
    const instanceIdHash = hashAgentInstanceId('laptop')
    const item = (bucketStart: string, instance = instanceIdHash) => ({
      directoryTeamId: 'ws#agent-usage#member#member',
      recordKey: `${bucketStart}#${instance}#m`,
      bucketStart, instanceIdHash: instance, model: 'm',
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, costMicroUsd: 5, requestCount: 1,
    })
    const queries: unknown[] = []
    const client: AgentRunUsageDocumentClient = {
      async send(command) {
        queries.push(command.input)
        return { Items: [item('2026-11-22T17:05:00Z'), item('2026-11-22T17:05:10Z')] }
      },
    }
    const store = new DynamoDbAgentRunUsageStore(client, 'runs')
    const page = await store.listMemberBuckets('ws', 'member', instanceIdHash, '2026-11-22T17:05:00Z', '2026-11-22T17:06:00Z', 1)
    expect(page).toMatchObject({ hasMore: true, buckets: [{ bucketStart: '2026-11-22T17:05:00Z', costMicroUsd: 5 }] })
    expect(queries[0]).toMatchObject({
      ExpressionAttributeValues: { ':partition': 'ws#agent-usage#member#member', ':from': '2026-11-22T17:05:00Z', ':until': '2026-11-22T17:06:00Z' },
    })
    expect(await store.listMemberBuckets('ws', 'member', instanceIdHash, '2026-11-22T17:05:00Z', '2026-11-22T17:05:00Z', 1)).toEqual({ buckets: [], hasMore: false })
  })

  test('the DynamoDB store skips other instances and reports a partial read when they fill the scan bound', async () => {
    const own = hashAgentInstanceId('laptop')
    const other = hashAgentInstanceId('desktop')
    const item = (second: number, instance: string) => {
      const bucketStart = `2026-11-22T17:${String(5 + Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}Z`
      return {
        directoryTeamId: 'ws#agent-usage#member#member',
        recordKey: `${bucketStart}#${instance}#m`,
        bucketStart, instanceIdHash: instance, model: 'm',
        inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costMicroUsd: 0, requestCount: 1,
      }
    }
    let items = [item(0, other), item(10, own), item(20, other)]
    const client: AgentRunUsageDocumentClient = { async send() { return { Items: items } } }
    const store = new DynamoDbAgentRunUsageStore(client, 'runs')
    expect(await store.listMemberBuckets('ws', 'member', own, '2026-11-22T17:05:00Z', undefined, 2)).toMatchObject({
      hasMore: false,
      buckets: [{ bucketStart: '2026-11-22T17:05:10Z', instanceIdHash: own }],
    })
    // With a limit of 1 the read passes over at most 5 rows; 6 rows of another instance stop it as partial.
    items = [0, 10, 20, 30, 40, 50].map((second) => item(second, other))
    expect(await store.listMemberBuckets('ws', 'member', own, '2026-11-22T17:05:00Z', undefined, 1)).toEqual({ buckets: [], hasMore: true })
  })
})

describe('period usage summary', () => {
  /**
   * Builds a usage summary with input tokens only.
   *
   * @param inputTokens - Input tokens.
   * @returns Usage with the cost included.
   */
  const usage = (inputTokens: number) => ({
    inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 1,
    estimatedCostMicroUsd: inputTokens, models: ['m'], hasMore: false,
  })

  test('ranks Projects and Work Items by tokens and keeps only the top Work Items', () => {
    const summary = summarizeFactoryUsage([
      { workItemId: 'a', title: 'A', projectId: 'p1', usage: usage(100) },
      { workItemId: 'a', title: 'A', projectId: 'p1', usage: usage(50) },
      { workItemId: 'b', title: 'B', usage: usage(400) },
      { workItemId: 'c', title: 'C', projectId: 'p1', usage: usage(10) },
    ], 2, true)
    expect(summary?.total).toMatchObject({ inputTokens: 560, estimatedCostMicroUsd: 560, requestCount: 4 })
    expect(summary?.projects.map((project) => [project.projectId, project.usage.inputTokens])).toEqual([[undefined, 400], ['p1', 160]])
    expect(summary?.workItems.map((workItem) => [workItem.workItemId, workItem.usage.inputTokens])).toEqual([['b', 400], ['a', 150]])
    expect(summary?.runsHasMore).toBe(true)
    expect(summarizeFactoryUsage([], 2, false)).toBeUndefined()
  })
})
