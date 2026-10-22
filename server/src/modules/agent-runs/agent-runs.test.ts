import { describe, expect, test } from 'bun:test'
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  DynamoDbAgentRunStore,
  type AgentRunDocumentClient,
} from './adapter-out/dynamodb/agent-run-store'
import { InMemoryAgentRunStore } from './adapter-out/in-memory/agent-run-store'
import {
  createActiveAgentRun,
  finishAgentRun,
  hashAgentInstanceId,
  isAgentRunStalled,
  readAgentRunMutationFence,
  readFinishAgentRunRequest,
  readStartAgentRunRequest,
  readUpdateAgentSettingsRequest,
  splitAgentRunMutationFence,
  toAgentRun,
  type StoredAgentRun,
} from './domain/agent-run'
import { AgentRunError } from './domain/agent-run-error'

const now = new Date('2026-10-22T00:00:00.000Z')
const startInput = {
  expectedRevision: 3,
  workflowStatusId: 'in-progress',
  runtime: 'claude-code',
  agentName: 'Claude Code',
  instanceId: 'laptop-1',
} as const

/**
 * Creates an active run fixture.
 *
 * @param overrides - Fields to replace.
 * @returns Stored run.
 */
function createRun(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    ...createActiveAgentRun({
      directoryId: 'workspace-1',
      teamId: 'core',
      workItemId: 'task-1',
      assigneeUserId: 'member-1',
      start: readStartAgentRunRequest(startInput),
      credentialId: 'key-1',
      startRevision: 4,
      leaseMinutes: 30,
      now,
      runId: 'run_00000000-0000-4000-8000-000000000001',
    }),
    ...overrides,
  }
}

/**
 * Captures commands and returns queued responses.
 *
 * @param responses - Responses returned in order; a function may throw.
 * @returns Fake client and the captured commands.
 */
function createClient(responses: Array<Awaited<ReturnType<AgentRunDocumentClient['send']>> | (() => never)> = []) {
  const commands: Array<GetCommand | QueryCommand | UpdateCommand | TransactWriteCommand> = []
  const client: AgentRunDocumentClient = {
    async send(command) {
      commands.push(command)
      const next = responses.shift()
      if (typeof next === 'function') return next()
      return next ?? {}
    },
  }
  return { client, commands }
}

describe('Agent Run domain', () => {
  test('validates a start request and hashes the instance ID', () => {
    const start = readStartAgentRunRequest(startInput)
    expect(start).toEqual({
      expectedRevision: 3,
      workflowStatusId: 'in-progress',
      runtime: 'claude-code',
      agentName: 'Claude Code',
      instanceIdHash: hashAgentInstanceId('laptop-1'),
    })
    expect(start.instanceIdHash).not.toContain('laptop-1')
    expect(start.instanceIdHash).toMatch(/^[0-9a-f]{64}$/u)
  })

  test('rejects unknown fields, unknown runtimes, unsafe names, and control characters', () => {
    const invalid = [
      { ...startInput, extra: true },
      { ...startInput, runtime: 'cursor' },
      { ...startInput, agentName: 'bad/name' },
      { ...startInput, agentName: 'x'.repeat(65) },
      { ...startInput, instanceId: 'with\nnewline' },
      { ...startInput, instanceId: ' padded' },
      { ...startInput, expectedRevision: 0 },
      null,
    ]
    for (const input of invalid) {
      expect(() => readStartAgentRunRequest(input)).toThrow(AgentRunError)
    }
  })

  test('derives stalled from the lease at read time without changing the state', () => {
    const run = createRun()
    expect(run.leaseExpiresAt).toBe('2026-10-22T00:30:00.000Z')
    expect(isAgentRunStalled(run, new Date('2026-10-22T00:29:59.000Z'))).toBe(false)
    expect(isAgentRunStalled(run, new Date('2026-10-22T00:30:01.000Z'))).toBe(true)
    expect(toAgentRun(run, new Date('2026-10-22T01:00:00.000Z'))).toMatchObject({ state: 'active', stalled: true })
    const finished = finishAgentRun(run, 'completed', 'agent', new Date('2026-10-22T01:00:00.000Z'))
    expect(isAgentRunStalled(finished, new Date('2026-10-22T02:00:00.000Z'))).toBe(false)
  })

  test('never exposes the instance hash or credential in the public projection', () => {
    const projected = toAgentRun(createRun(), now)
    expect(JSON.stringify(projected)).not.toContain(hashAgentInstanceId('laptop-1'))
    expect(JSON.stringify(projected)).not.toContain('key-1')
    expect(projected).not.toHaveProperty('directoryId')
  })

  test('requires an instance ID with a run ID and splits fence fields from a body', () => {
    expect(readAgentRunMutationFence({})).toBeUndefined()
    expect(() => readAgentRunMutationFence({ agentRunId: 'run_00000000-0000-4000-8000-000000000001' })).toThrow(AgentRunError)
    expect(() => readAgentRunMutationFence({ agentRunId: 'not-a-run', agentInstanceId: 'laptop-1' })).toThrow(AgentRunError)
    expect(readAgentRunMutationFence({ agentInstanceId: 'laptop-1' })).toEqual({ instanceIdHash: hashAgentInstanceId('laptop-1') })
    expect(splitAgentRunMutationFence({ title: 'x', agentInstanceId: 'laptop-1' })).toEqual({
      rest: { title: 'x' },
      fence: { agentInstanceId: 'laptop-1' },
    })
  })

  test('accepts only agent finish outcomes and bounded settings', () => {
    expect(readFinishAgentRunRequest({ outcome: 'paused' })).toBe('paused')
    expect(() => readFinishAgentRunRequest({ outcome: 'released' })).toThrow(AgentRunError)
    expect(readUpdateAgentSettingsRequest({ expectedRevision: 0, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false }))
      .toEqual({ expectedRevision: 0, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false })
    for (const leaseMinutes of [4, 241, 30.5]) {
      expect(() => readUpdateAgentSettingsRequest({ expectedRevision: 0, leaseMinutes, allowTakeoverAfterLeaseExpiry: false }))
        .toThrow(AgentRunError)
    }
  })
})

describe('DynamoDB Agent Run store', () => {
  test('creates the run and claim with conditions that admit one active run per Work Item', () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const [runPut, claimPut] = store.createStartItems(createRun())
    expect(runPut?.Put).toMatchObject({
      TableName: 'AgentRuns',
      ConditionExpression: 'attribute_not_exists(recordKey)',
      Item: {
        directoryTeamId: 'workspace-1#team#core',
        recordKey: 'agent-run#run_00000000-0000-4000-8000-000000000001',
        workspaceId: 'workspace-1',
        workItemRunKey: 'workspace-1#team#core#task-1',
        activeRunPartition: 'workspace-1#team#core',
        activeRunSortKey: '2026-10-22T00:30:00.000Z#run_00000000-0000-4000-8000-000000000001',
      },
    })
    expect(runPut?.Put?.Item).not.toHaveProperty('directoryId')
    expect(claimPut?.Put).toMatchObject({
      ConditionExpression: 'attribute_not_exists(recordKey)',
      Item: { recordKey: 'agent-run-claim#task-1', runId: 'run_00000000-0000-4000-8000-000000000001', workspaceId: 'workspace-1' },
    })
  })

  test('fences a held run by extending its lease and checking the claim', () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const run = createRun()
    const later = new Date('2026-10-22T00:10:00.000Z')
    const [lease, claim] = store.createMutationFenceItems({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', instanceIdHash: run.instanceIdHash, run, now: later,
    })
    expect(lease?.Update).toMatchObject({
      ConditionExpression: '#state = :active AND #workItemId = :workItemId AND #instanceIdHash = :instanceIdHash',
      ExpressionAttributeValues: { ':leaseExpiresAt': '2026-10-22T00:40:00.000Z', ':workItemId': 'task-1' },
    })
    expect(claim?.ConditionCheck).toMatchObject({
      ConditionExpression: '#runId = :runId AND #instanceIdHash = :instanceIdHash',
      ExpressionAttributeValues: { ':runId': run.runId },
    })
    const [unclaimed] = store.createMutationFenceItems({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', instanceIdHash: run.instanceIdHash, now: later,
    })
    expect(unclaimed?.ConditionCheck?.ConditionExpression).toBe('attribute_not_exists(#recordKey) OR #instanceIdHash = :instanceIdHash')
  })

  test('closes a run only while it is active and only removes its own claim', () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const finished = finishAgentRun(createRun(), 'released', 'member-2', now)
    const [update, remove] = store.createCloseItems(finished)
    expect(update?.Update?.ConditionExpression).toBe('#state = :active')
    expect(update?.Update?.UpdateExpression).toContain('REMOVE #activeRunPartition, #activeRunSortKey')
    expect(remove?.Delete).toMatchObject({ ConditionExpression: '#runId = :runId', Key: { recordKey: 'agent-run-claim#task-1' } })
    expect(() => store.createCloseItems(createRun())).toThrow(TypeError)
  })

  test('reads runs strictly and fails closed on rows from another Team', async () => {
    const run = createRun()
    const item = store().createStartItems(run)[0]?.Put?.Item
    const { client } = createClient([{ Item: item }, { Item: { ...item, teamId: 'other' } }])
    const reader = new DynamoDbAgentRunStore(client, 'AgentRuns')
    expect(await reader.getRun('workspace-1', 'core', run.runId)).toEqual(run)
    await expect(reader.getRun('workspace-1', 'core', run.runId)).rejects.toMatchObject({ category: 'temporarily_unavailable' })

    /**
     * Creates a store whose client is never used.
     * @returns Store.
     */
    function store() {
      return new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    }
  })

  test('pages Work Item history newest first and rejects a cursor for another Work Item', async () => {
    const { client, commands } = createClient([{ Items: [], LastEvaluatedKey: { workItemRunKey: 'workspace-1#team#core#task-1', directoryTeamId: 'x', recordKey: 'y', workItemRunSortKey: 'z' } }])
    const store = new DynamoDbAgentRunStore(client, 'AgentRuns')
    const page = await store.listWorkItemRuns('workspace-1', 'core', 'task-1', undefined, 20)
    expect(commands[0]?.input).toMatchObject({ IndexName: 'WorkItemRunIndex', ScanIndexForward: false, Limit: 20 })
    expect(page.nextCursor).toBeString()
    await expect(store.listWorkItemRuns('workspace-1', 'core', 'task-2', page.nextCursor, 20)).rejects.toBeInstanceOf(AgentRunError)
  })

  test('rate-limits explicit heartbeats and reports a finished run as not active', async () => {
    const run = createRun({ lastHeartbeatRequestAt: '2026-10-22T00:00:05.000Z' })
    const item = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns').createStartItems(run)[0]?.Put?.Item
    const conditionalFailure = () => {
      throw Object.assign(new Error('failed'), { name: 'ConditionalCheckFailedException' })
    }
    const limited = createClient([conditionalFailure, { Item: item }])
    await expect(new DynamoDbAgentRunStore(limited.client, 'AgentRuns').heartbeat(run, new Date('2026-10-22T00:00:08.000Z')))
      .rejects.toMatchObject({ category: 'rate_limited', retryAfterSeconds: 7 })
    const finishedItem = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
      .createStartItems(run)[0]?.Put?.Item
    const finished = createClient([conditionalFailure, { Item: { ...finishedItem, state: 'finished', outcome: 'completed', finishedAt: now.toISOString(), finishedBy: 'agent' } }])
    await expect(new DynamoDbAgentRunStore(finished.client, 'AgentRuns').heartbeat(run, new Date('2026-10-22T00:01:00.000Z')))
      .rejects.toMatchObject({ reason: 'agent_run_not_active' })
  })

  test('saves settings with revision CAS and reports a lost update as a conflict', async () => {
    const cancelled = () => {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      })
    }
    const { client, commands } = createClient([{}, cancelled])
    const store = new DynamoDbAgentRunStore(client, 'AgentRuns')
    const saved = await store.saveSettings('workspace-1', 'core', { expectedRevision: 0, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: true }, 'member-1', now, [])
    expect(saved).toMatchObject({ revision: 1, leaseMinutes: 45, updatedBy: 'member-1' })
    expect(commands[0]?.input).toMatchObject({ TransactItems: [{ Put: { ConditionExpression: 'attribute_not_exists(recordKey)' } }] })
    await expect(store.saveSettings('workspace-1', 'core', { expectedRevision: 1, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: true }, 'member-1', now, []))
      .rejects.toMatchObject({ category: 'conflict' })
  })
})

describe('in-memory Agent Run store', () => {
  test('admits one active run per Work Item and frees the claim on close', () => {
    const store = new InMemoryAgentRunStore()
    const first = createRun()
    store.applyTransactItems(store.createStartItems(first))
    const second = createRun({ runId: 'run_00000000-0000-4000-8000-000000000002', instanceIdHash: hashAgentInstanceId('laptop-2') })
    expect(() => store.applyTransactItems(store.createStartItems(second))).toThrow('Transaction cancelled.')
    store.applyTransactItems(store.createCloseItems(finishAgentRun(first, 'released', 'member-2', now)))
    store.applyTransactItems(store.createStartItems(second))
    expect(store.state.claims.get('workspace-1|core|task-1')?.runId).toBe(second.runId)
  })

  test('rejects a fence from another instance and accepts the holder', () => {
    const store = new InMemoryAgentRunStore()
    const run = createRun()
    store.seed(run)
    const fence = (instanceIdHash: string, held?: StoredAgentRun) => store.createMutationFenceItems({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', instanceIdHash, ...(held ? { run: held } : {}), now,
    })
    expect(() => store.applyTransactItems(fence(hashAgentInstanceId('laptop-2')))).toThrow('Transaction cancelled.')
    store.applyTransactItems(fence(run.instanceIdHash, run))
    store.applyTransactItems(fence(run.instanceIdHash))
  })
})
