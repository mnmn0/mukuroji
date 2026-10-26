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
  readHeartbeatAgentRunRequest,
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
    expect(readFinishAgentRunRequest({ outcome: 'paused', instanceId: 'laptop-1' }))
      .toEqual({ outcome: 'paused', instanceIdHash: hashAgentInstanceId('laptop-1') })
    expect(() => readFinishAgentRunRequest({ outcome: 'released', instanceId: 'laptop-1' })).toThrow(AgentRunError)
    expect(() => readFinishAgentRunRequest({ outcome: 'paused' })).toThrow(AgentRunError)
    expect(readHeartbeatAgentRunRequest({ instanceId: 'laptop-1' })).toBe(hashAgentInstanceId('laptop-1'))
    expect(() => readHeartbeatAgentRunRequest({})).toThrow(AgentRunError)
    expect(() => readHeartbeatAgentRunRequest(undefined)).toThrow(AgentRunError)
    expect(readUpdateAgentSettingsRequest({ expectedRevision: 0, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false }))
      .toEqual({ expectedRevision: 0, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false, readyStatusIds: [], requireAcceptanceCriteria: false, projectBriefs: {} })
    // Ready statuses and briefs are optional; empty briefs are dropped.
    expect(readUpdateAgentSettingsRequest({
      expectedRevision: 2, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false,
      readyStatusIds: ['ready'], brief: 'Run bun test.', projectBriefs: { web: 'Use Storybook.', cdk: '  ' },
    })).toEqual({
      expectedRevision: 2, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false,
      readyStatusIds: ['ready'], requireAcceptanceCriteria: false, brief: 'Run bun test.', projectBriefs: { web: 'Use Storybook.' },
    })
    const base = { expectedRevision: 0, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false }
    // A `__proto__` key stays an own entry instead of replacing the prototype.
    const proto = readUpdateAgentSettingsRequest({ ...base, projectBriefs: JSON.parse('{"__proto__":"Brief"}') })
    expect(Object.hasOwn(proto.projectBriefs, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(proto.projectBriefs)).toBe(Object.prototype)
    for (const [invalid, pointer] of [
      [{ readyStatusIds: ['ready', 'ready'] }, '/readyStatusIds'],
      [{ readyStatusIds: [''] }, '/readyStatusIds/0'],
      [{ readyStatusIds: Array.from({ length: 51 }, (_, index) => `s${index}`) }, '/readyStatusIds'],
      [{ brief: 'é'.repeat(8193) }, '/brief'],
      [{ brief: 7 }, '/brief'],
      [{ projectBriefs: { 'a/b': 'x', '..': 'y' } }, '/projectBriefs/..'],
      [{ projectBriefs: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`p${index}`, 'x'])) }, '/projectBriefs'],
      [{ brief: 'a'.repeat(16384), projectBriefs: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`p${index}`, 'a'.repeat(16384)])) }, '/projectBriefs'],
    ] as const) {
      expect(() => readUpdateAgentSettingsRequest({ ...base, ...invalid })).toThrow(expect.objectContaining({ pointer }))
    }
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

  test('fences a held run by checking the run and the claim without writing the lease', () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const run = createRun()
    const later = new Date('2026-10-22T00:10:00.000Z')
    const [held, claim] = store.createMutationFenceConditionChecks({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', assigneeUserId: run.assigneeUserId, instanceIdHash: run.instanceIdHash, run, now: later,
    })
    expect(held?.ConditionCheck).toMatchObject({
      ConditionExpression: '#state = :active AND #workItemId = :workItemId AND #instanceIdHash = :instanceIdHash',
      ExpressionAttributeValues: { ':workItemId': 'task-1' },
    })
    expect(claim?.ConditionCheck).toMatchObject({
      ConditionExpression: '#runId = :runId AND #instanceIdHash = :instanceIdHash',
      ExpressionAttributeValues: { ':runId': run.runId },
    })
    const [unclaimed] = store.createMutationFenceConditionChecks({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', assigneeUserId: run.assigneeUserId, instanceIdHash: run.instanceIdHash, now: later,
    })
    expect(unclaimed?.ConditionCheck?.ConditionExpression)
      .toBe('attribute_not_exists(#recordKey) OR (#instanceIdHash = :instanceIdHash AND #assigneeUserId = :assigneeUserId)')
  })

  test('closes a run only while it is active and only removes its own claim', () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const finished = finishAgentRun(createRun(), 'released', 'member-2', now)
    const [update, remove] = store.createCloseItems(finished)
    expect(update?.Update?.ConditionExpression).toBe('#state = :active')
    expect(update?.Update?.UpdateExpression).toContain('REMOVE #activeRunPartition, #activeRunSortKey')
    expect(remove?.Delete).toMatchObject({ ConditionExpression: '#runId = :runId', Key: { recordKey: 'agent-run-claim#task-1' } })
    const [agentUpdate] = store.createCloseItems(finished, finished.instanceIdHash)
    expect(agentUpdate?.Update).toMatchObject({
      ConditionExpression: '#state = :active AND #instanceIdHash = :instanceIdHash',
      ExpressionAttributeValues: { ':instanceIdHash': finished.instanceIdHash },
    })
    expect(() => store.createCloseItems(createRun())).toThrow(TypeError)
  })

  test('takes over only a stalled run and replaces its claim in place', () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const later = new Date(now.getTime() + 31 * 60_000)
    const superseded = finishAgentRun(createRun(), 'superseded', 'member-1', later)
    const successor = createRun({
      runId: 'run_00000000-0000-4000-8000-000000000002', instanceIdHash: hashAgentInstanceId('laptop-2'),
      startedAt: later.toISOString(), lastHeartbeatAt: later.toISOString(),
    })
    const [update, claim, revoke, put, unrevoke] = store.createTakeOverItems(superseded, successor)
    expect(update?.Update).toMatchObject({
      ConditionExpression: '#state = :active AND #instanceIdHash = :instanceIdHash AND #leaseExpiresAt < :takenOverAt',
      ExpressionAttributeValues: { ':takenOverAt': later.toISOString(), ':outcome': 'superseded' },
    })
    expect(claim?.Put).toMatchObject({
      ConditionExpression: '#runId = :supersededRunId AND #instanceIdHash = :supersededInstanceIdHash AND #assigneeUserId = :supersededAssigneeUserId',
      ExpressionAttributeValues: {
        ':supersededRunId': superseded.runId,
        ':supersededInstanceIdHash': superseded.instanceIdHash,
        ':supersededAssigneeUserId': superseded.assigneeUserId,
      },
      Item: { recordKey: 'agent-run-claim#task-1', runId: successor.runId, instanceIdHash: successor.instanceIdHash },
    })
    expect(revoke?.Put?.Item).toMatchObject({ instanceIdHash: superseded.instanceIdHash })
    expect(put?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(recordKey)', Item: { runId: successor.runId } })
    expect(unrevoke?.Delete).toBeDefined()
    expect(() => store.createTakeOverItems(superseded, { ...successor, instanceIdHash: superseded.instanceIdHash })).toThrow(TypeError)
    expect(() => store.createTakeOverItems(finishAgentRun(createRun(), 'released', 'member-2', later), successor)).toThrow(TypeError)
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

  test('re-reads Work Item history from the base table so a just-closed run is not shown as active', async () => {
    const run = createRun()
    const item = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns').createStartItems(run)[0]?.Put?.Item
    if (!item) throw new Error('The start items need a run put.')
    const closed = { ...item, state: 'finished', outcome: 'released', finishedAt: now.toISOString(), finishedBy: 'sato@example.com' }
    const { client, commands } = createClient([{ Items: [item] }, { Item: closed }])
    const page = await new DynamoDbAgentRunStore(client, 'AgentRuns').listWorkItemRuns('workspace-1', 'core', 'task-1', undefined, 20)
    expect(page.runs).toMatchObject([{ runId: run.runId, state: 'finished', outcome: 'released' }])
    expect(commands[1]?.input).toMatchObject({ ConsistentRead: true, Key: { recordKey: `agent-run#${run.runId}` } })
  })

  test('rate-limits explicit heartbeats and reports a finished run as not active', async () => {
    const run = createRun({ lastHeartbeatRequestAt: '2026-10-22T00:00:05.000Z' })
    const [runPut, claimPut] = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns').createStartItems(run)
    const item = runPut?.Put?.Item
    const claimItem = claimPut?.Put?.Item
    /**
     * Simulates a heartbeat transaction whose run update failed its condition.
     *
     * @returns Never; always throws.
     */
    const runConditionFailed = () => {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      })
    }
    const limited = createClient([runConditionFailed, { Item: item }, { Item: claimItem }])
    await expect(new DynamoDbAgentRunStore(limited.client, 'AgentRuns').heartbeat(run, run.instanceIdHash, new Date('2026-10-22T00:00:08.000Z')))
      .rejects.toMatchObject({ category: 'rate_limited', retryAfterSeconds: 7 })
    expect(limited.commands[0]?.input).toMatchObject({
      TransactItems: [
        { Update: { Key: { recordKey: `agent-run#${run.runId}` } } },
        { ConditionCheck: { Key: { recordKey: 'agent-run-claim#task-1' }, ConditionExpression: '#runId = :runId AND #instanceIdHash = :instanceIdHash' } },
      ],
    })
    const assignment = { ConditionCheck: { TableName: 'WorkItems', Key: { issueId: 'task-1' }, ConditionExpression: 'revision = :expectedRevision' } }
    const fenced = createClient([{}])
    await new DynamoDbAgentRunStore(fenced.client, 'AgentRuns').heartbeat(run, run.instanceIdHash, new Date('2026-10-22T00:01:00.000Z'), [assignment])
    expect(fenced.commands[0]?.input).toMatchObject({ TransactItems: [{}, {}, assignment] })
    const finished = createClient([runConditionFailed, { Item: { ...item, state: 'finished', outcome: 'completed', finishedAt: now.toISOString(), finishedBy: 'agent' } }])
    await expect(new DynamoDbAgentRunStore(finished.client, 'AgentRuns').heartbeat(run, run.instanceIdHash, new Date('2026-10-22T00:01:00.000Z')))
      .rejects.toMatchObject({ reason: 'agent_run_not_active' })
    const renewed = createClient([runConditionFailed, { Item: { ...item, lastHeartbeatAt: '2026-10-22T00:02:00.000Z' } }, { Item: claimItem }])
    expect(await new DynamoDbAgentRunStore(renewed.client, 'AgentRuns').heartbeat(run, run.instanceIdHash, new Date('2026-10-22T00:01:00.000Z')))
      .toMatchObject({ lastHeartbeatAt: '2026-10-22T00:02:00.000Z' })
    const other = createClient([runConditionFailed, { Item: item }])
    await expect(new DynamoDbAgentRunStore(other.client, 'AgentRuns').heartbeat(run, hashAgentInstanceId('laptop-2'), new Date('2026-10-22T00:01:00.000Z')))
      .rejects.toMatchObject({ reason: 'agent_run_not_active' })
  })

  test('refuses to keep alive an active run that no longer holds its claim', async () => {
    const run = createRun()
    const item = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns').createStartItems(run)[0]?.Put?.Item
    /**
     * Simulates a heartbeat transaction whose claim check failed.
     *
     * @returns Never; always throws.
     */
    const claimConditionFailed = () => {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      })
    }
    const orphaned = createClient([claimConditionFailed, { Item: item }, {}])
    await expect(new DynamoDbAgentRunStore(orphaned.client, 'AgentRuns').heartbeat(run, run.instanceIdHash, new Date('2026-10-22T00:01:00.000Z')))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
    const memory = new InMemoryAgentRunStore()
    memory.state.runs.set(`workspace-1|core|${run.runId}`, run)
    await expect(memory.heartbeat(run, run.instanceIdHash, new Date('2026-10-22T00:01:00.000Z')))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })

  test('revokes a released instance until the same member and instance start again', () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const run = createRun()
    const startItems = store.createStartItems(run)
    expect(startItems[2]?.Delete?.Key?.recordKey).toMatch(/^agent-run-revoked#task-1#[0-9a-f]{64}$/u)
    const released = store.createCloseItems(finishAgentRun(run, 'released', 'member-2', now))
    expect(released[2]?.Put?.Item).toMatchObject({
      entityType: 'agent-run-revocation',
      workItemId: 'task-1',
      assigneeUserId: run.assigneeUserId,
      instanceIdHash: run.instanceIdHash,
      runId: run.runId,
    })
    expect(released[2]?.Put?.Item?.recordKey).toBe(startItems[2]?.Delete?.Key?.recordKey)
    // An agent's own finish does not revoke its instance.
    expect(store.createCloseItems(finishAgentRun(run, 'completed', 'agent', now))).toHaveLength(2)
    const [, revocationCheck] = store.createMutationFenceConditionChecks({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', assigneeUserId: run.assigneeUserId, instanceIdHash: run.instanceIdHash, now,
    })
    expect(revocationCheck?.ConditionCheck).toMatchObject({
      Key: { recordKey: startItems[2]?.Delete?.Key?.recordKey },
      ConditionExpression: 'attribute_not_exists(#recordKey)',
    })
    // Another member using the same instance ID has a different revocation key.
    const [, otherMemberCheck] = store.createMutationFenceConditionChecks({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', assigneeUserId: 'member-9', instanceIdHash: run.instanceIdHash, now,
    })
    expect(otherMemberCheck?.ConditionCheck?.Key?.recordKey).not.toBe(startItems[2]?.Delete?.Key?.recordKey)
  })

  test('reads settings saved before ready statuses and briefs existed with their defaults', async () => {
    const legacy = {
      directoryTeamId: 'workspace-1#core', recordKey: 'agent-settings', entityType: 'agent-settings', workspaceId: 'workspace-1',
      schemaVersion: 1, teamId: 'core', revision: 3, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: true,
      updatedAt: now.toISOString(), updatedBy: 'member-1',
    }
    const old = createClient([{ Item: legacy }])
    expect(await new DynamoDbAgentRunStore(old.client, 'AgentRuns').getSettings('workspace-1', 'core'))
      .toEqual({ schemaVersion: 1, teamId: 'core', revision: 3, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: true, readyStatusIds: [], requireAcceptanceCriteria: false, projectBriefs: {}, updatedAt: now.toISOString(), updatedBy: 'member-1' })
    // An explicit null is corrupt rather than absent: it must not lift the Ready gate.
    for (const corrupt of [{ readyStatusIds: [7] }, { readyStatusIds: null }, { requireAcceptanceCriteria: 'yes' }, { acceptanceCriteriaFieldId: '' }, { brief: '' }, { brief: null }, { projectBriefs: { web: 3 } }, { projectBriefs: [] }, { projectBriefs: null }]) {
      const client = createClient([{ Item: { ...legacy, ...corrupt } }])
      await expect(new DynamoDbAgentRunStore(client.client, 'AgentRuns').getSettings('workspace-1', 'core'))
        .rejects.toMatchObject({ category: 'temporarily_unavailable' })
    }
  })

  test('saves settings with revision CAS and reports a lost update as a conflict', async () => {
    /**
     * Simulates a cancelled transaction.
     *
     * @returns Never; always throws.
     */
    const cancelled = () => {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      })
    }
    const first = createClient([{}])
    const update = { expectedRevision: 0, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: true, readyStatusIds: ['ready'], requireAcceptanceCriteria: true, acceptanceCriteriaFieldId: 'acceptance', brief: 'Brief', projectBriefs: { web: 'Web brief' } }
    const saved = await new DynamoDbAgentRunStore(first.client, 'AgentRuns').saveSettings('workspace-1', 'core', update, 'member-1', now, 'key-1', [])
    expect(saved).toMatchObject({ revision: 1, leaseMinutes: 45, updatedBy: 'member-1' })
    const command = first.commands[0]
    if (!(command instanceof TransactWriteCommand)) throw new Error('The save must be a transaction.')
    expect(command.input).toMatchObject({ TransactItems: [
      { Put: { Item: { recordKey: 'agent-settings' }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
      { Put: { Item: { recordKey: 'agent-settings-mutation#key-1', entityType: 'agent-settings-mutation', revision: 1 }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
    ] })
    const receipt = command.input.TransactItems?.[1]?.Put?.Item

    // A retry of the committed save replays its receipt; other values under that key, or a lost update, are conflicts.
    const replay = createClient([cancelled, { Item: receipt }])
    expect(await new DynamoDbAgentRunStore(replay.client, 'AgentRuns').saveSettings('workspace-1', 'core', update, 'member-1', now, 'key-1', []))
      .toEqual(saved)
    expect(replay.commands[1]?.input).toMatchObject({ Key: { recordKey: 'agent-settings-mutation#key-1' }, ConsistentRead: true })
    const otherValues = createClient([cancelled, { Item: receipt }])
    await expect(new DynamoDbAgentRunStore(otherValues.client, 'AgentRuns').saveSettings('workspace-1', 'core', { ...update, expectedRevision: 3 }, 'member-1', now, 'key-1', []))
      .rejects.toThrow('already used for a different settings save')
    const lostUpdate = createClient([cancelled, {}])
    await expect(new DynamoDbAgentRunStore(lostUpdate.client, 'AgentRuns').saveSettings('workspace-1', 'core', update, 'member-1', now, 'key-2', []))
      .rejects.toMatchObject({ category: 'conflict', pointer: '/expectedRevision' })
    const next = createClient([{}])
    await new DynamoDbAgentRunStore(next.client, 'AgentRuns').saveSettings('workspace-1', 'core', { ...update, expectedRevision: 1 }, 'member-1', now, 'key-2', [])
    expect(next.commands[0]?.input).toMatchObject({ TransactItems: [{ Put: {
      ConditionExpression: '#revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': 1 },
    } }, { Put: { Item: { recordKey: 'agent-settings-mutation#key-2' } } }] })
  })
})

describe('Agent Run commits', () => {
  test('reports a cancelled run write as not active and any other cancellation as retryable', async () => {
    /**
     * Creates a client response that cancels a transaction with the given reasons.
     *
     * @param codes - Cancellation reason codes, one per item.
     * @returns Response that always throws.
     */
    const cancelled = (codes: string[]) => () => {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: codes.map((Code) => ({ Code })),
      })
    }
    const finished = finishAgentRun(createRun(), 'completed', 'agent', now)
    const runFailed = new DynamoDbAgentRunStore(createClient([cancelled(['ConditionalCheckFailed', 'None', 'None'])]).client, 'AgentRuns')
    await expect(runFailed.commit([...runFailed.createCloseItems(finished), { Put: { TableName: 'Receipts', Item: {} } }], 2))
      .rejects.toMatchObject({ reason: 'agent_run_not_active' })
    const receiptFailed = new DynamoDbAgentRunStore(createClient([cancelled(['None', 'None', 'ConditionalCheckFailed'])]).client, 'AgentRuns')
    await expect(receiptFailed.commit([...receiptFailed.createCloseItems(finished), { Put: { TableName: 'Receipts', Item: {} } }], 2))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
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
    /**
     * Builds a mutation fence for the fixture task.
     *
     * @param instanceIdHash - Hash of the caller instance ID.
     * @param held - Run the caller holds, if any.
     * @returns Fence items.
     */
    const fence = (instanceIdHash: string, held?: StoredAgentRun) => store.createMutationFenceConditionChecks({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', assigneeUserId: run.assigneeUserId, instanceIdHash, ...(held ? { run: held } : {}), now,
    })
    expect(() => store.applyTransactItems(fence(hashAgentInstanceId('laptop-2')))).toThrow('Transaction cancelled.')
    store.applyTransactItems(fence(run.instanceIdHash, run))
    store.applyTransactItems(fence(run.instanceIdHash))
    // The same instance ID configured by another member does not share the holder's claim.
    expect(() => store.applyTransactItems(store.createMutationFenceConditionChecks({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', assigneeUserId: 'member-9', instanceIdHash: run.instanceIdHash, now,
    }))).toThrow('Transaction cancelled.')
    // After a person releases the run, the same instance is fenced out while other instances are not.
    store.applyTransactItems(store.createCloseItems(finishAgentRun(run, 'released', 'member-2', now)))
    expect(() => store.applyTransactItems(fence(run.instanceIdHash))).toThrow('Transaction cancelled.')
    store.applyTransactItems(fence(hashAgentInstanceId('laptop-2')))
    // Another member that happens to use the released instance ID is not fenced out by that release.
    store.applyTransactItems(store.createMutationFenceConditionChecks({
      directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', assigneeUserId: 'member-9', instanceIdHash: run.instanceIdHash, now,
    }))
  })
})
