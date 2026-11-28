import { describe, expect, test } from 'bun:test'
import { AGENT_ACTIVITY_MAX_WAIT_MS, workItemSizeBand } from '@mukuroji/contracts'
import {
  classifyAgentTool,
  layoutAgentActivityRows,
  summarizeAgentActivity,
  type AgentActivityEvent,
} from './domain/agent-run-activity'
import { compareFactoryWorkItems, summarizeFactoryActivity, type AgentRunComparisonEntry } from './domain/agent-run-comparison'
import { DynamoDbAgentRunUsageStore, type AgentRunUsageDocumentClient } from './adapter-out/dynamodb/agent-run-usage-store'

const base = Date.parse('2026-11-22T17:05:00.000Z')

/**
 * Builds an activity event of one session.
 *
 * @param kind - Event kind.
 * @param offsetMs - Milliseconds after the base time.
 * @param extra - Other fields.
 * @returns Activity event.
 */
function event(kind: AgentActivityEvent['kind'], offsetMs: number, extra: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return { kind, instanceIdHash: 'laptop', occurredAtMs: base + offsetMs, sessionHash: 's1', ...extra }
}

describe('agent tool classification', () => {
  test('names MCP tools by server and tool, skills by skill name, and keeps built-in tools', () => {
    expect(classifyAgentTool('mcp__github__get_issue', {})).toEqual({ kind: 'mcp', name: 'github/get_issue' })
    expect(classifyAgentTool('mcp_tool', { toolParameters: '{"mcp_server_name":"linear","mcp_tool_name":"list_issues"}' }))
      .toEqual({ kind: 'mcp', name: 'linear/list_issues' })
    expect(classifyAgentTool('mcp_tool', {})).toEqual({ kind: 'mcp', name: 'unknown/unknown' })
    expect(classifyAgentTool('Skill', { toolParameters: '{"skill_name":"review","command":"secret"}' })).toEqual({ kind: 'skill', name: 'review' })
    expect(classifyAgentTool('Skill', {})).toEqual({ kind: 'builtin', name: 'Skill' })
    expect(classifyAgentTool('Bash', { toolParameters: '{"bash_command":"rm -rf /"}' })).toEqual({ kind: 'builtin', name: 'Bash' })
    expect(classifyAgentTool('Ba#sh\u0000', {})).toEqual({ kind: 'builtin', name: 'Bash' })
    expect(classifyAgentTool(undefined, {})).toBeUndefined()
    expect(classifyAgentTool('Bash', { toolParameters: 'not json' })).toEqual({ kind: 'builtin', name: 'Bash' })
  })
})

describe('agent activity layout', () => {
  test('adds tool time, and measures waits from the previous event or the stored cursor', () => {
    const events = [
      event('request', 0),
      event('decision', 4_000, { byPerson: true }),
      event('tool', 7_000, { tool: { kind: 'builtin', name: 'Bash' }, durationMs: 3_000 }),
      event('decision', 8_000, { byPerson: false }),
      event('tool', 9_000, { tool: { kind: 'builtin', name: 'Read' }, durationMs: 100, failed: true }),
      event('prompt', 30_000),
    ]
    const layout = layoutAgentActivityRows(events, events, new Map([['laptop#s1', base - 1_000]]), 10)
    const rows = layout.slots.filter((slot) => slot !== undefined)
    expect(rows).toEqual([
      { bucketStart: '2026-11-22T17:05:00Z', instanceIdHash: 'laptop', kind: 'tool', name: 'builtin:Bash', count: 1, durationMs: 3_000, failureCount: 0 },
      { bucketStart: '2026-11-22T17:05:00Z', instanceIdHash: 'laptop', kind: 'tool', name: 'builtin:Read', count: 1, durationMs: 100, failureCount: 1 },
      { bucketStart: '2026-11-22T17:05:00Z', instanceIdHash: 'laptop', kind: 'wait', name: 'approval', count: 1, durationMs: 4_000, failureCount: 0 },
      { bucketStart: '2026-11-22T17:05:30Z', instanceIdHash: 'laptop', kind: 'wait', name: 'prompt', count: 1, durationMs: 21_000, failureCount: 0 },
    ])
    expect(layout.cursors).toEqual([{ sessionKey: 'laptop#s1', lastEventAtMs: base + 30_000 }])
  })

  test('counts no wait without a previous event, beyond the longest wait, or before an older cursor', () => {
    const first = [event('prompt', 0)]
    const fresh = layoutAgentActivityRows(first, first, new Map(), 10)
    expect(fresh.slots).toEqual([undefined])
    expect(fresh.cursors).toEqual([{ sessionKey: 'laptop#s1', lastEventAtMs: base }])
    const away = layoutAgentActivityRows(first, first, new Map([['laptop#s1', base - AGENT_ACTIVITY_MAX_WAIT_MS - 1]]), 10)
    expect(away.slots).toEqual([undefined])
    // A retry after the cursor moved keeps the same slots and adds no wait.
    const retried = layoutAgentActivityRows(first, first, new Map([['laptop#s1', base]]), 10)
    expect(retried.slots).toHaveLength(1)
    expect(retried.cursors).toEqual([])
    // Events without a session add no wait slot.
    const anonymous = [event('prompt', 0, { sessionHash: undefined })]
    expect(layoutAgentActivityRows(anonymous, anonymous, new Map(), 10).slots).toEqual([])
  })

  test('keeps a slot for an event outside the accepted window, so a retry keeps its chunks', () => {
    const events = [event('tool', 0, { tool: { kind: 'builtin', name: 'Bash' }, durationMs: 1 })]
    expect(layoutAgentActivityRows(events, [], new Map(), 10).slots).toEqual([undefined])
  })

  test('summarizes rows longest tool first, with waits apart', () => {
    const summary = summarizeAgentActivity([
      { bucketStart: 'a', instanceIdHash: 'x', kind: 'tool', name: 'builtin:Read', count: 2, durationMs: 200, failureCount: 0 },
      { bucketStart: 'b', instanceIdHash: 'x', kind: 'tool', name: 'mcp:github/get_issue', count: 1, durationMs: 900, failureCount: 1 },
      { bucketStart: 'c', instanceIdHash: 'x', kind: 'tool', name: 'builtin:Read', count: 1, durationMs: 100, failureCount: 0 },
      { bucketStart: 'c', instanceIdHash: 'x', kind: 'wait', name: 'prompt', count: 1, durationMs: 5_000, failureCount: 0 },
      { bucketStart: 'c', instanceIdHash: 'x', kind: 'tool', name: 'malformed', count: 1, durationMs: 5, failureCount: 0 },
    ], false)
    expect(summary).toEqual({
      toolCount: 4,
      toolDurationMs: 1_200,
      toolFailureCount: 1,
      tools: [
        { kind: 'mcp', name: 'github/get_issue', count: 1, durationMs: 900, failureCount: 1 },
        { kind: 'builtin', name: 'Read', count: 3, durationMs: 300, failureCount: 0 },
      ],
      approvalWait: { count: 0, durationMs: 0 },
      promptWait: { count: 1, durationMs: 5_000 },
      hasMore: false,
    })
    expect(summarizeAgentActivity([], false)).toBeUndefined()
    expect(summarizeAgentActivity([], true)?.hasMore).toBe(true)
  })
})

describe('Factory comparison', () => {
  /**
   * Builds a Work Item with one run of the given minutes and tokens.
   *
   * @param id - Work Item ID.
   * @param minutes - Run minutes.
   * @param tokens - Input tokens.
   * @param value - Axis value.
   * @returns Comparison entry.
   */
  const entry = (id: string, minutes: number, tokens: number, value = 'up-to-1d'): AgentRunComparisonEntry => ({
    workItemId: id,
    title: `Title ${id}`,
    workItemTypeId: 'task',
    value,
    runs: [{
      runtime: 'claude-code',
      assigneeUserId: 'member',
      startedAt: '2026-11-22T10:00:00.000Z',
      finishedAt: new Date(Date.parse('2026-11-22T10:00:00.000Z') + minutes * 60_000).toISOString(),
      rework: id === 'slow',
      usage: {
        inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 1,
        estimatedCostMicroUsd: tokens, models: ['m'], aiDurationMs: 1_000,
        byModel: [{ model: 'm', inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 1, aiDurationMs: 1_000, estimatedCostMicroUsd: tokens }],
        hasMore: false,
      },
    }],
  })

  test('lists Work Items at twice their group median and counts the unsized ones', () => {
    const comparison = compareFactoryWorkItems({ kind: 'size' }, [
      entry('a', 60, 1_000),
      entry('b', 60, 1_100),
      entry('slow', 200, 1_000),
      entry('loose', 600, 90_000, 'none'),
      entry('only', 600, 90_000, 'up-to-3d'),
      { ...entry('no-telemetry', 999, 0), runs: [{ ...entry('x', 999, 0).runs[0]!, usage: undefined }] },
    ], false)
    expect(comparison?.groups[0]).toEqual({
      workItemTypeId: 'task',
      value: 'up-to-1d',
      workItemCount: 3,
      medianRunMinutes: 60,
      medianTokens: 1_000,
      models: [{ model: 'm', workItemCount: 3, medianTokens: 1_000, medianAiDurationMs: 1_000 }],
    })
    expect(comparison?.outliers).toEqual([expect.objectContaining({
      workItemId: 'slow', runMinutes: 200, ratio: 3.3, reworkRuns: 1, runtimes: ['claude-code'], models: ['m'], assigneeUserId: 'member',
    })])
    expect(JSON.stringify(comparison)).not.toContain('estimatedCostMicroUsd')
    expect(comparison?.unsizedWorkItems).toBe(1)
    expect(compareFactoryWorkItems({ kind: 'size' }, [], true)).toBeUndefined()
  })

  test('size bands follow the effort estimate', () => {
    expect([undefined, 0, 120, 121, 480, 1_440, 1_441].map(workItemSizeBand))
      .toEqual(['none', 'none', 'up-to-2h', 'up-to-1d', 'up-to-1d', 'up-to-3d', 'over-3d'])
  })

  test('the activity summary compares agent work with waits', () => {
    const summary = summarizeFactoryActivity([entry('a', 1, 1).runs[0]!.usage], [{
      toolCount: 1, toolDurationMs: 3_000, toolFailureCount: 0, tools: [{ kind: 'builtin', name: 'Bash', count: 1, durationMs: 3_000, failureCount: 0 }],
      approvalWait: { count: 1, durationMs: 1_000 }, promptWait: { count: 1, durationMs: 3_000 }, hasMore: false,
    }], false)
    expect(summary).toMatchObject({ aiDurationMs: 1_000, agentWorkShare: 50, topTools: [{ name: 'Bash' }] })
    expect(summarizeFactoryActivity([undefined], [undefined], false)).toBeUndefined()
  })
})

describe('DynamoDB activity store', () => {
  test('writes activity with its own receipts, and moves cursors forward only', async () => {
    const sent: { name: string; input: unknown }[] = []
    const client: AgentRunUsageDocumentClient = {
      async send(command) {
        sent.push({ name: command.constructor.name, input: command.input })
        if (command.constructor.name === 'UpdateCommand' && sent.filter((entry) => entry.name === 'UpdateCommand').length === 2) {
          throw Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' })
        }
        if (command.constructor.name === 'BatchGetCommand') {
          return { Responses: { runs: [{ recordKey: 'laptop#s1', lastEventAtMs: 5 }] } }
        }
        return {}
      },
    }
    const store = new DynamoDbAgentRunUsageStore(client, 'runs')
    const now = new Date('2026-11-22T18:00:00.000Z')
    expect(await store.recordActivityBatch('ws', 'member', 'batch', [
      undefined,
      { bucketStart: '2026-11-22T17:05:00Z', instanceIdHash: 'laptop', kind: 'tool', name: 'builtin:Bash', count: 1, durationMs: 3, failureCount: 0 },
    ], now)).toBe('recorded')
    expect(sent[0]?.input).toMatchObject({
      TransactItems: [
        { Put: { Item: { directoryTeamId: 'ws#agent-usage-batch#member#member', recordKey: 'activity#batch#0' } } },
        {
          Update: {
            Key: { directoryTeamId: 'ws#agent-activity#member#member', recordKey: '2026-11-22T17:05:00Z#laptop#tool#builtin:Bash' },
            ExpressionAttributeValues: { ':count': 1, ':durationMs': 3, ':activityKind': 'tool' },
          },
        },
      ],
    })
    expect(await store.readSessionCursors('ws', 'member', ['laptop#s1', 'laptop#s1'])).toEqual(new Map([['laptop#s1', 5]]))
    await store.advanceSessionCursors('ws', 'member', [{ sessionKey: 'laptop#s1', lastEventAtMs: 9 }, { sessionKey: 'laptop#s2', lastEventAtMs: 1 }], now)
    expect(sent.filter((entry) => entry.name === 'UpdateCommand')).toHaveLength(2)
    expect(sent.find((entry) => entry.name === 'UpdateCommand')?.input).toMatchObject({
      Key: { directoryTeamId: 'ws#agent-session#member#member', recordKey: 'laptop#s1' },
      ConditionExpression: 'attribute_not_exists(#lastEventAtMs) OR #lastEventAtMs < :lastEventAtMs',
    })
  })
})
