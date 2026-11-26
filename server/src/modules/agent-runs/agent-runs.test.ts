import { describe, expect, test } from 'bun:test'
import { PUBLIC_API_OPENAPI_DOCUMENT } from '@mukuroji/contracts'
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
  readResumeAgentRunRequest,
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

  test('documents the agent name and instance ID rules on every request schema that takes them', () => {
    const documented: string[] = []
    for (const [name, schema] of Object.entries(PUBLIC_API_OPENAPI_DOCUMENT.components.schemas)) {
      if (!name.endsWith('Request') || !('properties' in schema)) continue
      for (const [field, property] of Object.entries(schema.properties)) {
        if (field !== 'agentName' && field !== 'instanceId' && field !== 'agentInstanceId') continue
        // Generated clients check only the length, so the description must name what the server also rejects.
        expect(property).toMatchObject({ description: expect.stringContaining('rejected with validation_failed') })
        documented.push(`${name}.${field}`)
      }
    }
    expect(documented).toEqual(expect.arrayContaining([
      'StartAgentRunRequest.agentName',
      'StartAgentRunRequest.instanceId',
      'TakeOverAgentRunRequest.agentName',
      'TakeOverAgentRunRequest.instanceId',
      'ResumeAgentRunRequest.agentName',
      'ResumeAgentRunRequest.instanceId',
      'HeartbeatAgentRunRequest.instanceId',
      'FinishAgentRunRequest.instanceId',
      'ReportAgentRunRequest.instanceId',
    ]))
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
      .toEqual({ expectedRevision: 0, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false, readyStatusIds: [], resumableStatusIds: [], requireAcceptanceCriteria: false, projectBriefs: {}, fileFailedRunsToTriage: false, fileStalledRunsToTriage: false, notifyAssigneeOfRunEvents: false, acceptNewRuns: true })
    // The switch is on unless a save turns it off; anything but a boolean is refused.
    expect(readUpdateAgentSettingsRequest({ expectedRevision: 1, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false, acceptNewRuns: false }))
      .toMatchObject({ acceptNewRuns: false })
    expect(() => readUpdateAgentSettingsRequest({ expectedRevision: 1, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false, acceptNewRuns: 'no' }))
      .toThrow(AgentRunError)
    // Ready statuses and briefs are optional; empty briefs are dropped.
    expect(readUpdateAgentSettingsRequest({
      expectedRevision: 2, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false,
      readyStatusIds: ['ready'], brief: 'Run bun test.', projectBriefs: { web: 'Use Storybook.', cdk: '  ' },
    })).toEqual({
      expectedRevision: 2, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false,
      readyStatusIds: ['ready'], resumableStatusIds: [], requireAcceptanceCriteria: false, brief: 'Run bun test.', projectBriefs: { web: 'Use Storybook.' },
      fileFailedRunsToTriage: false, fileStalledRunsToTriage: false, notifyAssigneeOfRunEvents: false, acceptNewRuns: true,
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
    // Only a failed finish joins the Triage outbox, in the same write that closes the run.
    expect(update?.Update?.UpdateExpression).not.toContain('#triageIndexPartition')
    const [failedUpdate] = store.createCloseItems(finishAgentRun(createRun(), 'failed', 'agent', now))
    expect(failedUpdate?.Update?.UpdateExpression).toContain('#triageIndexPartition = :triageIndexPartition')
    expect(failedUpdate?.Update?.ExpressionAttributeValues).toMatchObject({
      ':triageIndexPartition': 'triage-failed-run',
      ':triageIndexSortKey': `${now.toISOString()}#workspace-1#team#core#run_00000000-0000-4000-8000-000000000001`,
    })
  })

  test('indexes a closed run by finish time, with failed runs in their own partition', async () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const runId = 'run_00000000-0000-4000-8000-000000000001'
    const [released] = store.createCloseItems(finishAgentRun(createRun(), 'released', 'member-2', now))
    expect(released?.Update?.UpdateExpression).toContain('#finishedRunPartition = :finishedRunPartition, #finishedRunSortKey = :finishedRunSortKey')
    expect(released?.Update?.ExpressionAttributeValues).toMatchObject({
      ':finishedRunPartition': 'workspace-1#team#core#finished-run',
      ':finishedRunSortKey': `${now.toISOString()}#${runId}`,
    })
    const [failed] = store.createCloseItems(finishAgentRun(createRun(), 'failed', 'agent', now))
    expect(failed?.Update?.ExpressionAttributeValues).toMatchObject({ ':finishedRunPartition': 'workspace-1#team#core#failed-run' })

    const entry = {
      directoryTeamId: 'workspace-1#team#core', recordKey: `agent-run#${runId}`, runId, workItemId: 'task-1', outcome: 'completed',
      finishedAt: now.toISOString(), finishedRunPartition: 'workspace-1#team#core#finished-run', finishedRunSortKey: `${now.toISOString()}#${runId}`,
    }
    const listed = createClient([{ Items: [entry], LastEvaluatedKey: { finishedRunPartition: entry.finishedRunPartition, finishedRunSortKey: entry.finishedRunSortKey, directoryTeamId: entry.directoryTeamId, recordKey: entry.recordKey } }])
    const page = await new DynamoDbAgentRunStore(listed.client, 'AgentRuns')
      .listFinishedRunsByTime('workspace-1', 'core', 'other', '2026-10-21T00:00:00.000Z', undefined, 100)
    expect(page.runs).toEqual([{ runId, workItemId: 'task-1', outcome: 'completed', finishedAt: now.toISOString() }])
    expect(listed.commands[0]?.input).toMatchObject({
      IndexName: 'FinishedRunIndex',
      KeyConditionExpression: '#finishedRunPartition = :partition AND #finishedRunSortKey >= :since',
      ExpressionAttributeValues: { ':partition': 'workspace-1#team#core#finished-run', ':since': '2026-10-21T00:00:00.000Z' },
      ScanIndexForward: false,
    })
    // An end bound keeps every run that finished at it and skips later runs inside the query.
    const bounded = createClient()
    await new DynamoDbAgentRunStore(bounded.client, 'AgentRuns')
      .listFinishedRunsByTime('workspace-1', 'core', 'other', '2026-10-21T00:00:00.000Z', undefined, 100, '2026-10-22T00:00:00.000Z')
    expect(bounded.commands[0]?.input).toMatchObject({
      KeyConditionExpression: '#finishedRunPartition = :partition AND #finishedRunSortKey BETWEEN :since AND :until',
      ExpressionAttributeValues: { ':since': '2026-10-21T00:00:00.000Z', ':until': '2026-10-22T00:00:00.000Z#~' },
    })
    const untilOnly = createClient()
    await new DynamoDbAgentRunStore(untilOnly.client, 'AgentRuns')
      .listFinishedRunsByTime('workspace-1', 'core', 'failed', undefined, undefined, 100, '2026-10-22T00:00:00.000Z')
    expect(untilOnly.commands[0]?.input).toMatchObject({ KeyConditionExpression: '#finishedRunPartition = :partition AND #finishedRunSortKey <= :until' })
    await expect(new DynamoDbAgentRunStore(createClient().client, 'AgentRuns').listFinishedRunsByTime('workspace-1', 'core', 'other', undefined, undefined, 100, 'yesterday'))
      .rejects.toMatchObject({ category: 'validation_failed' })
    // The cursor continues only the same Team and group.
    const next = createClient()
    await new DynamoDbAgentRunStore(next.client, 'AgentRuns').listFinishedRunsByTime('workspace-1', 'core', 'other', undefined, page.nextCursor, 100)
    expect(next.commands[0]?.input).toMatchObject({ KeyConditionExpression: '#finishedRunPartition = :partition', ExclusiveStartKey: { recordKey: entry.recordKey } })
    await expect(new DynamoDbAgentRunStore(createClient().client, 'AgentRuns').listFinishedRunsByTime('workspace-1', 'core', 'failed', undefined, page.nextCursor, 100))
      .rejects.toMatchObject({ category: 'validation_failed' })
    // A failed run in the other partition, or a key that disagrees with the run, fails closed.
    const misplaced = createClient([{ Items: [{ ...entry, outcome: 'failed' }] }])
    await expect(new DynamoDbAgentRunStore(misplaced.client, 'AgentRuns').listFinishedRunsByTime('workspace-1', 'core', 'other', undefined, undefined, 100))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
    const forged = createClient([{ Items: [{ ...entry, finishedRunSortKey: `${now.toISOString()}#run_other` }] }])
    await expect(new DynamoDbAgentRunStore(forged.client, 'AgentRuns').listFinishedRunsByTime('workspace-1', 'core', 'other', undefined, undefined, 100))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })

  test('lists finished runs by time in memory the same way, newest first and failed runs apart', async () => {
    const store = new InMemoryAgentRunStore()
    const later = new Date(now.getTime() + 60_000)
    store.seed(finishAgentRun(createRun({ runId: 'run_00000000-0000-4000-8000-000000000001', workItemId: 'task-1' }), 'completed', 'agent', now))
    store.seed(finishAgentRun(createRun({ runId: 'run_00000000-0000-4000-8000-000000000002', workItemId: 'task-2' }), 'released', 'member-2', later))
    store.seed(finishAgentRun(createRun({ runId: 'run_00000000-0000-4000-8000-000000000003', workItemId: 'task-3' }), 'failed', 'agent', now))
    const other = await store.listFinishedRunsByTime('workspace-1', 'core', 'other', undefined, undefined, 100)
    expect(other.runs.map((run) => run.workItemId)).toEqual(['task-2', 'task-1'])
    const recent = await store.listFinishedRunsByTime('workspace-1', 'core', 'other', later.toISOString(), undefined, 100)
    expect(recent.runs.map((run) => run.workItemId)).toEqual(['task-2'])
    const earlier = await store.listFinishedRunsByTime('workspace-1', 'core', 'other', undefined, undefined, 100, now.toISOString())
    expect(earlier.runs.map((run) => run.workItemId)).toEqual(['task-1'])
    const failed = await store.listFinishedRunsByTime('workspace-1', 'core', 'failed', undefined, undefined, 100)
    expect(failed.runs).toEqual([{ runId: 'run_00000000-0000-4000-8000-000000000003', workItemId: 'task-3', outcome: 'failed', finishedAt: now.toISOString() }])
  })

  test('clears the Triage outbox without ever creating a row for a run deleted since it was listed', async () => {
    const missing = createClient([() => {
      throw Object.assign(new Error('missing'), { name: 'ConditionalCheckFailedException' })
    }])
    const store = new DynamoDbAgentRunStore(missing.client, 'AgentRuns')
    await store.clearFailedRunTriage({ directoryId: 'workspace-1', teamId: 'core', runId: 'run_1' })
    expect(missing.commands[0]?.input).toMatchObject({
      Key: { directoryTeamId: 'workspace-1#team#core', recordKey: 'agent-run#run_1' },
      ConditionExpression: 'attribute_exists(#recordKey)',
    })
    const deferred = createClient()
    await new DynamoDbAgentRunStore(deferred.client, 'AgentRuns').deferFailedRunTriage({ directoryId: 'workspace-1', teamId: 'core', runId: 'run_1' }, now)
    expect(deferred.commands[0]?.input).toMatchObject({
      ConditionExpression: '#triageIndexPartition = :triageIndexPartition',
      ExpressionAttributeValues: { ':triageIndexPartition': 'triage-failed-run', ':triageIndexSortKey': `${now.toISOString()}#workspace-1#team#core#run_1` },
    })
    // The outbox lists failed runs oldest first and rejects a row whose keys disagree with its IDs.
    const listed = createClient([{ Items: [{ directoryTeamId: 'workspace-1#team#core', recordKey: 'agent-run#run_1', workspaceId: 'workspace-1', teamId: 'core', runId: 'run_1' }] }])
    expect(await new DynamoDbAgentRunStore(listed.client, 'AgentRuns').listFailedRunsToTriage(50))
      .toEqual([{ directoryId: 'workspace-1', teamId: 'core', runId: 'run_1' }])
    expect(listed.commands[0]?.input).toMatchObject({ IndexName: 'AgentRunTriageIndex', ExpressionAttributeValues: { ':partition': 'triage-failed-run' } })
    const forged = createClient([{ Items: [{ directoryTeamId: 'workspace-2#team#core', recordKey: 'agent-run#run_1', workspaceId: 'workspace-1', teamId: 'core', runId: 'run_1' }] }])
    await expect(new DynamoDbAgentRunStore(forged.client, 'AgentRuns').listFailedRunsToTriage(50)).rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })

  test('keeps the stall sweep checkpoints monotonic and removable with the Workspace', async () => {
    const run = createRun()
    const passed = createClient([() => {
      throw Object.assign(new Error('behind'), { name: 'ConditionalCheckFailedException' })
    }])
    // An overlapping sweep that already passed a later run keeps its watermark.
    await new DynamoDbAgentRunStore(passed.client, 'AgentRuns').saveStallWatermark(run)
    expect(passed.commands[0]?.input).toMatchObject({
      Key: { directoryTeamId: 'workspace-1#team#core', recordKey: 'agent-run-triage-stall-watermark' },
      ConditionExpression: 'attribute_not_exists(#watermark) OR #watermark < :watermark',
      ExpressionAttributeValues: { ':workspaceId': 'workspace-1', ':teamId': 'core', ':watermark': `${run.leaseExpiresAt}#${run.runId}` },
    })
    const listed = createClient()
    await new DynamoDbAgentRunStore(listed.client, 'AgentRuns').listStallCandidates({ directoryId: 'workspace-1', teamId: 'core' }, 'mark', undefined, 100)
    expect(listed.commands[0]?.input).toMatchObject({
      IndexName: 'ActiveRunIndex',
      KeyConditionExpression: '#activeRunPartition = :partition AND #activeRunSortKey > :after',
      ExpressionAttributeValues: { ':partition': 'workspace-1#team#core', ':after': 'mark' },
    })
    const forged = createClient([{ Item: { workspaceId: 'workspace-2', teamId: 'core', watermark: 'mark' } }])
    await expect(new DynamoDbAgentRunStore(forged.client, 'AgentRuns').readStallPosition({ directoryId: 'workspace-1', teamId: 'core' }))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })

    const cleared = createClient([() => {
      throw Object.assign(new Error('no resume'), { name: 'ConditionalCheckFailedException' })
    }])
    // Clearing a resume position that is already gone never creates a row.
    await new DynamoDbAgentRunStore(cleared.client, 'AgentRuns').saveStallResume({ directoryId: 'workspace-1', teamId: 'core' }, undefined)
    expect(cleared.commands[0]?.input).toMatchObject({ UpdateExpression: 'REMOVE #resume', ConditionExpression: 'attribute_exists(#resume)' })

    const resume = createClient([{}, { Item: { directoryTeamId: 'agent-run-triage-sweep', recordKey: 'resume-team' } }])
    const resumeStore = new DynamoDbAgentRunStore(resume.client, 'AgentRuns')
    await resumeStore.listTriageTeams(undefined, 100, { directoryId: 'workspace-1', teamId: 'core' })
    expect(resume.commands[0]?.input).toMatchObject({
      KeyConditionExpression: '#triageIndexPartition = :partition AND #triageIndexSortKey >= :start',
      ExpressionAttributeValues: { ':partition': 'triage-filing-team', ':start': 'workspace-1#team#core' },
    })
    // A cleared resume row keeps no Workspace ID, so it reads as starting from the first Team.
    expect(await resumeStore.readTriageSweepResumeTeam()).toBeUndefined()
  })

  test('takes over only a stalled run and replaces its claim in place', () => {
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const later = new Date(now.getTime() + 31 * 60_000)
    const superseded = finishAgentRun(createRun(), 'superseded', 'member-1', later)
    const successor = createRun({
      runId: 'run_00000000-0000-4000-8000-000000000002', instanceIdHash: hashAgentInstanceId('laptop-2'),
      // The start time sits after a stalled run whose clock was ahead; the lease is still compared with
      // the real time of the take over.
      startedAt: new Date(later.getTime() + 60_000).toISOString(), lastHeartbeatAt: later.toISOString(),
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

  test('records the newest run with every start and reads it strongly', async () => {
    const run = createRun()
    const builder = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const latest = builder.createStartItems(run)[3]?.Put
    expect(latest).toMatchObject({ Item: { entityType: 'agent-run-latest', workItemId: run.workItemId, runId: run.runId } })
    expect(latest).not.toHaveProperty('ConditionExpression')
    expect(builder.createStartItems(run, { runId: undefined })[3]?.Put?.ConditionExpression).toBe('attribute_not_exists(recordKey)')
    expect(builder.createStartItems(run, { runId: 'run_00000000-0000-4000-8000-0000000000aa' })[3]?.Put).toMatchObject({
      ConditionExpression: '#runId = :latestRunId', ExpressionAttributeValues: { ':latestRunId': 'run_00000000-0000-4000-8000-0000000000aa' },
    })
    const { client, commands } = createClient([{ Item: latest?.Item }, {}, { Item: { ...latest?.Item, runId: 'not-a-run' } }])
    const reader = new DynamoDbAgentRunStore(client, 'AgentRuns')
    expect(await reader.getLatestRunId('workspace-1', 'core', run.workItemId)).toBe(run.runId)
    expect(commands[0]?.input).toMatchObject({ ConsistentRead: true })
    expect(await reader.getLatestRunId('workspace-1', 'core', run.workItemId)).toBeUndefined()
    await expect(reader.getLatestRunId('workspace-1', 'core', run.workItemId)).rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })

  test('keeps the run a resume links to and fails closed on a malformed link', async () => {
    const resumed = { ...createRun(), resumedFromRunId: 'run_00000000-0000-4000-8000-0000000000aa' }
    const item = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns').createStartItems(resumed)[0]?.Put?.Item
    expect(item).toMatchObject({ resumedFromRunId: resumed.resumedFromRunId })
    const { client } = createClient([
      { Item: item },
      { Item: { ...item, resumedFromRunId: 'not-a-run' } },
      { Item: { ...item, resumedFromRunId: resumed.runId } },
    ])
    const reader = new DynamoDbAgentRunStore(client, 'AgentRuns')
    expect(await reader.getRun('workspace-1', 'core', resumed.runId)).toEqual(resumed)
    await expect(reader.getRun('workspace-1', 'core', resumed.runId)).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    await expect(reader.getRun('workspace-1', 'core', resumed.runId)).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    expect(readResumeAgentRunRequest({ expectedRevision: 4, runtime: 'kiro', agentName: 'Kiro', instanceId: 'laptop-1' }))
      .toEqual({ expectedRevision: 4, runtime: 'kiro', agentName: 'Kiro', instanceIdHash: hashAgentInstanceId('laptop-1') })
    expect(() => readResumeAgentRunRequest({ runtime: 'kiro', agentName: 'Kiro', instanceId: 'laptop-1' })).toThrow(AgentRunError)
    expect(readResumeAgentRunRequest({ expectedRevision: 4, runtime: 'kiro', agentName: 'Kiro', instanceId: 'laptop-1', expectedPreviousRunId: resumed.runId }))
      .toMatchObject({ expectedPreviousRunId: resumed.runId })
    expect(() => readResumeAgentRunRequest({ expectedRevision: 4, runtime: 'kiro', agentName: 'Kiro', instanceId: 'laptop-1', expectedPreviousRunId: 'run-1' }))
      .toThrow(AgentRunError)
    expect(() => readResumeAgentRunRequest({ expectedRevision: 4, runtime: 'kiro', agentName: 'Kiro', instanceId: 'laptop-1', workflowStatusId: 'doing' }))
      .toThrow(AgentRunError)
    expect(readUpdateAgentSettingsRequest({ expectedRevision: 0, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false, resumableStatusIds: ['doing'] }))
      .toMatchObject({ resumableStatusIds: ['doing'] })
    expect(() => readUpdateAgentSettingsRequest({ expectedRevision: 0, leaseMinutes: 5, allowTakeoverAfterLeaseExpiry: false, resumableStatusIds: ['doing', 'doing'] }))
      .toThrow(AgentRunError)
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

  test('puts the strongly read newest run first when the history index has not caught up', async () => {
    const builder = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const older = finishAgentRun(createRun(), 'paused', 'agent', now)
    const newer = finishAgentRun(createRun({ runId: 'run_00000000-0000-4000-8000-000000000002', startedAt: '2026-10-22T01:00:00.000Z' }), 'failed', 'agent', now)
    const [olderPut] = builder.createStartItems(older)
    const [newerPut, , , latestPut] = builder.createStartItems(newer)
    const olderItem = olderPut?.Put?.Item
    const newerItem = newerPut?.Put?.Item
    const latestItem = latestPut?.Put?.Item
    if (!olderItem || !newerItem || !latestItem) throw new Error('The start items need run and newest-run puts.')
    // The index returns only the older run; the newest-run row names the newer one.
    const responses = () => [{ Items: [olderItem] }, { Item: olderItem }, { Item: latestItem }, { Item: newerItem }]
    const full = await new DynamoDbAgentRunStore(createClient(responses()).client, 'AgentRuns')
      .listWorkItemRuns('workspace-1', 'core', 'task-1', undefined, 20)
    expect(full.runs.map((run) => [run.runId, run.outcome])).toEqual([[newer.runId, 'failed'], [older.runId, 'paused']])
    expect(full.nextCursor).toBeUndefined()
    // A full page keeps its size and continues after the newest run, so the older one comes next.
    const { client, commands } = createClient([...responses(), { Items: [olderItem] }, { Item: olderItem }])
    const reader = new DynamoDbAgentRunStore(client, 'AgentRuns')
    const first = await reader.listWorkItemRuns('workspace-1', 'core', 'task-1', undefined, 1)
    expect(first.runs.map((run) => run.runId)).toEqual([newer.runId])
    const second = await reader.listWorkItemRuns('workspace-1', 'core', 'task-1', first.nextCursor, 1)
    expect(commands[4]?.input).toMatchObject({ ExclusiveStartKey: { recordKey: `agent-run#${newer.runId}`, workItemRunSortKey: `${newer.startedAt}#${newer.runId}` } })
    expect(second.runs.map((run) => run.runId)).toEqual([older.runId])
  })

  test('keeps the history order when the newest-run row names a run that started earlier', async () => {
    const builder = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const earlier = finishAgentRun(createRun(), 'paused', 'agent', now)
    const later = finishAgentRun(createRun({ runId: 'run_00000000-0000-4000-8000-000000000002', startedAt: '2026-10-22T01:00:00.000Z' }), 'paused', 'agent', now)
    const [earlierPut, , , latestPut] = builder.createStartItems(earlier)
    const [laterPut] = builder.createStartItems(later)
    const earlierItem = earlierPut?.Put?.Item
    const laterItem = laterPut?.Put?.Item
    const latestItem = latestPut?.Put?.Item
    if (!earlierItem || !laterItem || !latestItem) throw new Error('The start items need run and newest-run puts.')
    // The index returns only the later run; the newest-run row names the run that started earlier.
    const responses = () => [{ Items: [laterItem] }, { Item: laterItem }, { Item: latestItem }, { Item: earlierItem }]
    const full = await new DynamoDbAgentRunStore(createClient(responses()).client, 'AgentRuns')
      .listWorkItemRuns('workspace-1', 'core', 'task-1', undefined, 20)
    expect(full.runs.map((run) => run.runId)).toEqual([later.runId, earlier.runId])
    // A page of one keeps the index order, and its cursor continues with the earlier run instead of skipping the later one.
    const { client, commands } = createClient([...responses(), { Items: [earlierItem] }, { Item: earlierItem }])
    const reader = new DynamoDbAgentRunStore(client, 'AgentRuns')
    const first = await reader.listWorkItemRuns('workspace-1', 'core', 'task-1', undefined, 1)
    expect(first.runs.map((run) => run.runId)).toEqual([later.runId])
    const second = await reader.listWorkItemRuns('workspace-1', 'core', 'task-1', first.nextCursor, 1)
    expect(commands[4]?.input).toMatchObject({ ExclusiveStartKey: { workItemRunSortKey: `${later.startedAt}#${later.runId}` } })
    expect(second.runs.map((run) => run.runId)).toEqual([earlier.runId])
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
      .toEqual({ schemaVersion: 1, teamId: 'core', revision: 3, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: true, readyStatusIds: [], resumableStatusIds: [], requireAcceptanceCriteria: false, projectBriefs: {}, fileFailedRunsToTriage: false, fileStalledRunsToTriage: false, notifyAssigneeOfRunEvents: false, acceptNewRuns: true, updatedAt: now.toISOString(), updatedBy: 'member-1', workspaceDefaultsRevision: 0 })
    // An explicit null is corrupt rather than absent: it must not lift the Ready gate.
    for (const corrupt of [{ readyStatusIds: [7] }, { readyStatusIds: null }, { resumableStatusIds: [''] }, { resumableStatusIds: null }, { requireAcceptanceCriteria: 'yes' }, { acceptNewRuns: 'no' }, { acceptNewRuns: null }, { acceptanceCriteriaFieldId: '' }, { brief: '' }, { brief: null }, { projectBriefs: { web: 3 } }, { projectBriefs: [] }, { projectBriefs: null }]) {
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
    const update = { expectedRevision: 0, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: true, readyStatusIds: ['ready'], resumableStatusIds: ['doing'], requireAcceptanceCriteria: true, acceptanceCriteriaFieldId: 'acceptance', brief: 'Brief', projectBriefs: { web: 'Web brief' }, fileFailedRunsToTriage: true, fileStalledRunsToTriage: false, notifyAssigneeOfRunEvents: false, acceptNewRuns: true }
    const saved = await new DynamoDbAgentRunStore(first.client, 'AgentRuns').saveSettings('workspace-1', 'core', update, 'member-1', now, 'key-1', [])
    expect(saved).toMatchObject({ revision: 1, leaseMinutes: 45, updatedBy: 'member-1' })
    const command = first.commands[0]
    if (!(command instanceof TransactWriteCommand)) throw new Error('The save must be a transaction.')
    expect(command.input).toMatchObject({ TransactItems: [
      // A Team that files runs to Triage is listed for the worker.
      { Put: { Item: { recordKey: 'agent-settings', triageIndexPartition: 'triage-filing-team', triageIndexSortKey: 'workspace-1#team#core' }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
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

describe('Workspace agent defaults', () => {
  test('saves the defaults with revision CAS and applies them to a Team without settings', async () => {
    const first = createClient([{}])
    const update = { expectedRevision: 0, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: true, requireAcceptanceCriteria: true, brief: 'Workspace brief' }
    const saved = await new DynamoDbAgentRunStore(first.client, 'AgentRuns').saveWorkspaceAgentDefaults('workspace-1', update, 'admin-1', now, 'key-1', [])
    expect(saved).toEqual({ schemaVersion: 1, revision: 1, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: true, requireAcceptanceCriteria: true, brief: 'Workspace brief', updatedAt: now.toISOString(), updatedBy: 'admin-1' })
    const command = first.commands[0]
    if (!(command instanceof TransactWriteCommand)) throw new Error('The save must be a transaction.')
    // The Workspace row lives outside every Team partition.
    expect(command.input).toMatchObject({ TransactItems: [
      { Put: { Item: { directoryTeamId: 'workspace-1#workspace', recordKey: 'agent-defaults', entityType: 'agent-defaults' }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
      { Put: { Item: { recordKey: 'agent-defaults-mutation#key-1', entityType: 'agent-defaults-mutation' }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
    ] })
    const row = command.input.TransactItems?.[0]?.Put?.Item

    // A Team without settings reads the Workspace values at revision 0; a saved Team keeps its own.
    const unsaved = createClient([{}, { Item: row }])
    expect(await new DynamoDbAgentRunStore(unsaved.client, 'AgentRuns').getSettings('workspace-1', 'core')).toMatchObject({
      revision: 0, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: true, requireAcceptanceCriteria: true, workspaceBrief: 'Workspace brief',
    })
    const teamRow = {
      directoryTeamId: 'workspace-1#team#core', recordKey: 'agent-settings', entityType: 'agent-settings', workspaceId: 'workspace-1',
      schemaVersion: 1, teamId: 'core', revision: 2, leaseMinutes: 15, allowTakeoverAfterLeaseExpiry: false,
      updatedAt: now.toISOString(), updatedBy: 'member-1',
    }
    const savedTeam = createClient([{ Item: teamRow }, { Item: row }])
    expect(await new DynamoDbAgentRunStore(savedTeam.client, 'AgentRuns').getSettings('workspace-1', 'core')).toMatchObject({
      revision: 2, leaseMinutes: 15, allowTakeoverAfterLeaseExpiry: false, requireAcceptanceCriteria: false, workspaceBrief: 'Workspace brief',
    })
    // A run of a Team that inherits the defaults is fenced on them too; a saved Team only on its own row.
    const fence = new DynamoDbAgentRunStore(createClient([]).client, 'AgentRuns')
    expect(fence.createSettingsRevisionChecks('workspace-1', 'core', { revision: 0, workspaceDefaultsRevision: 3 })).toMatchObject([
      { ConditionCheck: { Key: { directoryTeamId: 'workspace-1#team#core', recordKey: 'agent-settings' }, ConditionExpression: 'attribute_not_exists(#recordKey)' } },
      { ConditionCheck: { Key: { directoryTeamId: 'workspace-1#workspace', recordKey: 'agent-defaults' }, ConditionExpression: '#revision = :revision', ExpressionAttributeValues: { ':revision': 3 } } },
    ])
    expect(fence.createSettingsRevisionChecks('workspace-1', 'core', { revision: 0, workspaceDefaultsRevision: 0 })[1])
      .toMatchObject({ ConditionCheck: { ConditionExpression: 'attribute_not_exists(#recordKey)' } })
    expect(fence.createSettingsRevisionChecks('workspace-1', 'core', { revision: 2, workspaceDefaultsRevision: 3 })).toHaveLength(1)
    // A corrupt Workspace row is not read as defaults.
    const corrupt = createClient([{ Item: { ...row, leaseMinutes: 'long' } }])
    await expect(new DynamoDbAgentRunStore(corrupt.client, 'AgentRuns').getWorkspaceAgentDefaults('workspace-1'))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
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
