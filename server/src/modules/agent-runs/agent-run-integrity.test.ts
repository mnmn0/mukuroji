import { describe, expect, test } from 'bun:test'
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import {
  checkAgentRunPartition,
  runAgentRunsIntegrityCheck,
  summarizeAgentRunIntegrityFindings,
  type AgentRunIntegrityClient,
  type AgentRunIntegrityFailureCode,
} from './adapter-out/dynamodb/agent-run-integrity'
import {
  DynamoDbAgentRunStore,
  createAgentRunPartition,
  serializeRun,
  stallWatermarkRecordKey,
} from './adapter-out/dynamodb/agent-run-store'
import {
  createActiveAgentRun,
  finishAgentRun,
  readStartAgentRunRequest,
  type StoredAgentRun,
} from './domain/agent-run'

const team = { directoryId: 'workspace-1', teamId: 'core' }
const partition = createAgentRunPartition(team.directoryId, team.teamId)
const startedAt = new Date('2026-10-22T00:00:00.000Z')
const finishedAt = new Date('2026-10-22T00:10:00.000Z')
const builder = new DynamoDbAgentRunStore({
  send: async () => {
    throw new Error('The fixture builder does not send commands.')
  },
}, 'agent-runs')

/**
 * Builds a run ID from a number.
 *
 * @param index - Number from 1 to 9.
 * @returns Run ID.
 */
function runId(index: number): string {
  return `run_00000000-0000-4000-8000-00000000000${index}`
}

/**
 * Creates an active run fixture.
 *
 * @param index - Run number.
 * @param workItemId - Work Item ID.
 * @param instanceId - Agent instance ID before hashing.
 * @returns Stored run.
 */
function createRun(index: number, workItemId: string, instanceId = 'laptop-1'): StoredAgentRun {
  return createActiveAgentRun({
    directoryId: team.directoryId,
    teamId: team.teamId,
    workItemId,
    assigneeUserId: 'member-secret-1',
    start: readStartAgentRunRequest({
      expectedRevision: 3,
      workflowStatusId: 'in-progress',
      runtime: 'claude-code',
      agentName: 'Claude Code',
      instanceId,
    }),
    credentialId: 'key-1',
    startRevision: 4,
    leaseMinutes: 30,
    now: startedAt,
    runId: runId(index),
  })
}

/**
 * Returns the item of a Put transaction entry.
 *
 * @param entry - Transaction entry.
 * @returns The put item.
 */
function putItem(entry: ReturnType<DynamoDbAgentRunStore['createStartItems']>[number] | undefined): Record<string, unknown> {
  const item = entry?.Put?.Item
  if (item === undefined) throw new Error('Expected a Put entry.')
  return { ...item }
}

/**
 * Builds the rows a start writes: run, claim, and newest-run row.
 *
 * @param run - Active run.
 * @returns Rows keyed by kind.
 */
function startRows(run: StoredAgentRun) {
  const items = builder.createStartItems(run)
  return { run: putItem(items[0]), claim: putItem(items[1]), latest: putItem(items[3]) }
}

/**
 * Builds the rows of a healthy partition: an active run, a released run with its revocation, a
 * failed run waiting in the Triage outbox, a watermark, a report, and settings.
 *
 * @returns Rows of the partition.
 */
function healthyRows(): Record<string, unknown>[] {
  const active = createRun(1, 'task-1')
  const activeRows = startRows(active)

  const released = finishAgentRun(createRun(2, 'task-2'), 'released', 'person', finishedAt)
  const revocation = putItem(builder.createCloseItems(released)[2])

  const failed = finishAgentRun(createRun(3, 'task-3'), 'failed', 'agent', finishedAt)
  const failedRow = {
    ...serializeRun(failed),
    triageIndexPartition: 'triage-failed-run',
    triageIndexSortKey: `${finishedAt.toISOString()}#${partition}#${failed.runId}`,
  }

  return [
    activeRows.run,
    activeRows.claim,
    activeRows.latest,
    serializeRun(released),
    revocation,
    startRows(createRun(2, 'task-2')).latest,
    failedRow,
    {
      directoryTeamId: partition,
      recordKey: stallWatermarkRecordKey,
      workspaceId: team.directoryId,
      teamId: team.teamId,
      watermark: `${active.leaseExpiresAt}#${active.runId}`,
    },
    { directoryTeamId: partition, recordKey: 'agent-run-report#abc#2026-10-22T00:01:00.000Z#run#000001' },
    { directoryTeamId: partition, recordKey: 'agent-settings' },
    { directoryTeamId: partition, recordKey: 'agent-settings-mutation#key' },
  ]
}

/**
 * Lists the codes found in rows.
 *
 * @param rows - Partition rows.
 * @returns Sorted unique codes.
 */
function codes(rows: Record<string, unknown>[]): AgentRunIntegrityFailureCode[] {
  return summarizeAgentRunIntegrityFindings(checkAgentRunPartition(team, rows).findings).map((failure) => failure.code)
}

/**
 * Replaces the row whose sort key matches.
 *
 * @param rows - Partition rows.
 * @param recordKey - Sort key of the row to replace.
 * @param update - Builds the replacement, or undefined to drop the row.
 * @returns New rows.
 */
function replaceRow(
  rows: Record<string, unknown>[],
  recordKey: string,
  update: (row: Record<string, unknown>) => Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!rows.some((row) => row.recordKey === recordKey)) throw new Error(`No row ${recordKey}.`)
  return rows.flatMap((row) => {
    if (row.recordKey !== recordKey) return [row]
    const next = update(row)
    return next === undefined ? [] : [next]
  })
}

/**
 * Finds the sort key of the first row with a prefix.
 *
 * @param rows - Partition rows.
 * @param prefix - Sort key prefix.
 * @returns The sort key.
 */
function recordKeyWith(rows: Record<string, unknown>[], prefix: string): string {
  const recordKey = rows.find((row) => typeof row.recordKey === 'string' && row.recordKey.startsWith(prefix))?.recordKey
  if (typeof recordKey !== 'string') throw new Error(`No row with ${prefix}.`)
  return recordKey
}

describe('checkAgentRunPartition', () => {
  test('passes a partition written by the store', () => {
    const result = checkAgentRunPartition(team, healthyRows())
    expect(result.findings).toEqual([])
    expect(result.counts).toEqual({
      rows: 11,
      runs: 3,
      activeRuns: 1,
      finishedRuns: 2,
      legacyFinishedRunsWithoutIndexKeys: 0,
      claims: 1,
      latestRuns: 2,
      revocations: 1,
      reports: 1,
      watermarks: 1,
      settings: 2,
    })
  })

  test('counts a finished run closed before the finished-run index keys, without failing', () => {
    const rows = replaceRow(healthyRows(), `agent-run#${runId(2)}`, (row) => {
      const { finishedRunPartition: _partition, finishedRunSortKey: _sortKey, ...rest } = row
      return rest
    })
    const result = checkAgentRunPartition(team, rows)
    expect(result.findings).toEqual([])
    expect(result.counts.legacyFinishedRunsWithoutIndexKeys).toBe(1)
  })

  test('detects two active runs on one Work Item', () => {
    const second = startRows(createRun(4, 'task-1', 'laptop-2'))
    expect(codes([...healthyRows(), second.run])).toEqual(['AGENT_RUN_MULTIPLE_ACTIVE_RUNS', 'AGENT_RUN_ACTIVE_RUN_UNCLAIMED', 'AGENT_RUN_LATEST_RUN_INVALID'])
  })

  test('detects a claim whose run is missing', () => {
    const rows = healthyRows().filter((row) => row.recordKey !== `agent-run#${runId(1)}`)
    expect(codes(rows)).toEqual(['AGENT_RUN_CLAIM_RUN_MISSING', 'AGENT_RUN_LATEST_RUN_INVALID', 'AGENT_RUN_WATERMARK_INVALID'])
  })

  test('detects a claim left on a finished run', () => {
    const run = createRun(5, 'task-5')
    const rows = [...healthyRows(), serializeRun(finishAgentRun(run, 'completed', 'agent', finishedAt)), startRows(run).claim]
    expect(codes(rows)).toEqual(['AGENT_RUN_CLAIM_RUN_NOT_ACTIVE'])
  })

  test('detects a claim whose holder differs from its run', () => {
    const rows = replaceRow(healthyRows(), 'agent-run-claim#task-1', (row) => ({ ...row, instanceIdHash: 'other-instance' }))
    expect(codes(rows)).toEqual(['AGENT_RUN_CLAIM_HOLDER_MISMATCH'])
  })

  test('detects an active run without a claim', () => {
    const rows = healthyRows().filter((row) => row.recordKey !== 'agent-run-claim#task-1')
    expect(codes(rows)).toEqual(['AGENT_RUN_ACTIVE_RUN_UNCLAIMED'])
  })

  test.each([
    ['history index key', (row: Record<string, unknown>) => ({ ...row, workItemRunKey: `${partition}#task-9` })],
    ['active index key', (row: Record<string, unknown>) => ({ ...row, activeRunSortKey: `2026-10-21T00:00:00.000Z#${runId(1)}` })],
    ['missing active index key', (row: Record<string, unknown>) => {
      const { activeRunPartition: _partition, ...rest } = row
      return rest
    }],
    ['finished index key on an active run', (row: Record<string, unknown>) => ({ ...row, finishedRunPartition: `${partition}#finished-run` })],
  ])('detects a %s that differs from the run', (_name, update) => {
    expect(codes(replaceRow(healthyRows(), `agent-run#${runId(1)}`, update))).toEqual(['AGENT_RUN_INDEX_KEYS_MISMATCH'])
  })

  test('detects an active index key left on a finished run', () => {
    const rows = replaceRow(healthyRows(), `agent-run#${runId(2)}`, (row) => ({ ...row, activeRunPartition: partition }))
    expect(codes(rows)).toEqual(['AGENT_RUN_INDEX_KEYS_MISMATCH'])
  })

  test('detects an outbox key on a run that did not fail', () => {
    const rows = replaceRow(healthyRows(), `agent-run#${runId(2)}`, (row) => ({
      ...row,
      triageIndexPartition: 'triage-failed-run',
      triageIndexSortKey: `${finishedAt.toISOString()}#${partition}#${runId(2)}`,
    }))
    expect(codes(rows)).toEqual(['AGENT_RUN_OUTBOX_KEY_INVALID'])
  })

  test('detects an outbox key that names another run', () => {
    const rows = replaceRow(healthyRows(), `agent-run#${runId(3)}`, (row) => ({
      ...row,
      triageIndexSortKey: `${finishedAt.toISOString()}#${partition}#${runId(9)}`,
    }))
    expect(codes(rows)).toEqual(['AGENT_RUN_OUTBOX_KEY_INVALID'])
  })

  test('detects a revocation whose run is missing or was not released', () => {
    const missing = healthyRows().filter((row) => row.recordKey !== `agent-run#${runId(2)}`)
    expect(codes(missing)).toEqual(['AGENT_RUN_REVOCATION_ORPHANED', 'AGENT_RUN_LATEST_RUN_INVALID'])
    const completed = replaceRow(healthyRows(), `agent-run#${runId(2)}`, (row) => ({
      ...row,
      outcome: 'completed',
      finishedRunSortKey: `${finishedAt.toISOString()}#${runId(2)}`,
    }))
    expect(codes(completed)).toEqual(['AGENT_RUN_REVOCATION_ORPHANED'])
  })

  test('detects a revocation that the same instance started past', () => {
    const restarted = startRows(createRun(6, 'task-2'))
    const rows = [
      ...replaceRow(healthyRows(), 'agent-run-latest#task-2', () => restarted.latest),
      restarted.run,
      restarted.claim,
    ]
    expect(codes(rows)).toEqual(['AGENT_RUN_REVOCATION_BLOCKS_ACTIVE_RUN'])
  })

  test('detects a newest-run row that names a run of another Work Item', () => {
    const rows = replaceRow(healthyRows(), 'agent-run-latest#task-2', (row) => ({ ...row, runId: runId(3) }))
    expect(codes(rows)).toEqual(['AGENT_RUN_LATEST_RUN_INVALID'])
  })

  test('detects a watermark past the run lease or naming a missing run', () => {
    const ahead = replaceRow(healthyRows(), stallWatermarkRecordKey, (row) => ({ ...row, watermark: `2099-01-01T00:00:00.000Z#${runId(1)}` }))
    expect(codes(ahead)).toEqual(['AGENT_RUN_WATERMARK_INVALID'])
    const missing = replaceRow(healthyRows(), stallWatermarkRecordKey, (row) => ({ ...row, resume: `2026-10-22T00:00:00.000Z#${runId(9)}` }))
    expect(codes(missing)).toEqual(['AGENT_RUN_WATERMARK_INVALID'])
    const malformed = replaceRow(healthyRows(), stallWatermarkRecordKey, (row) => ({ ...row, watermark: 'not-a-position' }))
    expect(codes(malformed)).toEqual(['AGENT_RUN_WATERMARK_INVALID'])
  })

  test('detects malformed and unrecognized rows', () => {
    const revocationKey = recordKeyWith(healthyRows(), 'agent-run-revoked#')
    const malformed = replaceRow(healthyRows(), revocationKey, (row) => ({ ...row, assigneeUserId: 'someone-else' }))
    expect(codes(malformed)).toEqual(['AGENT_RUN_ROW_MALFORMED'])
    expect(codes([...healthyRows(), { directoryTeamId: partition, recordKey: 'something-else' }])).toEqual(['AGENT_RUN_ROW_UNRECOGNIZED'])
  })

  test('never reports a member ID or an instance hash', () => {
    const run = createRun(5, 'task-5')
    const rows = [
      ...replaceRow(healthyRows(), recordKeyWith(healthyRows(), 'agent-run-revoked#'), (row) => ({ ...row, runId: runId(8) })),
      startRows(run).claim,
    ]
    const serialized = JSON.stringify(summarizeAgentRunIntegrityFindings(checkAgentRunPartition(team, rows).findings))
    expect(serialized).not.toContain('member-secret-1')
    expect(serialized).not.toContain(run.instanceIdHash)
    expect(serialized).not.toContain('agent-run-revoked#')
  })
})

/**
 * Builds a fake client that serves pages per partition and records each command.
 *
 * @param partitions - Rows by partition key.
 * @param pageSize - Items per page the fake returns.
 * @returns Client and sent commands.
 */
function createFakeClient(partitions: Record<string, Record<string, unknown>[]>, pageSize = 2) {
  const commands: Array<QueryCommand | ScanCommand> = []
  const page = (items: Record<string, unknown>[], startKey: Record<string, unknown> | undefined) => {
    const offset = typeof startKey?.offset === 'number' ? startKey.offset : 0
    const next = offset + pageSize
    return { Items: items.slice(offset, next), ...(next < items.length ? { LastEvaluatedKey: { offset: next } } : {}) }
  }
  const client: AgentRunIntegrityClient = {
    async send(command) {
      commands.push(command)
      if (command instanceof ScanCommand) {
        const all = Object.entries(partitions).flatMap(([key, rows]) => rows.map(() => ({ directoryTeamId: key })))
        return page(all, command.input.ExclusiveStartKey)
      }
      const key = command.input.ExpressionAttributeValues?.[':partition']
      return page(typeof key === 'string' ? partitions[key] ?? [] : [], command.input.ExclusiveStartKey)
    },
  }
  return { client, commands }
}

describe('runAgentRunsIntegrityCheck', () => {
  const bounds = { pageSize: 2, maxPages: 100, maxItems: 200 }
  const now = new Date('2026-11-20T00:00:00.000Z')

  test('discovers Teams, reads each partition strongly, and passes healthy data', async () => {
    const other = createAgentRunPartition('workspace-2', 'web')
    const { client, commands } = createFakeClient({
      [partition]: healthyRows(),
      [other]: [{ directoryTeamId: other, recordKey: 'agent-settings' }],
      'agent-run-triage-sweep': [{ directoryTeamId: 'agent-run-triage-sweep', recordKey: 'resume-team' }],
    })
    const evidence = await runAgentRunsIntegrityCheck({ client, tableName: 'agent-runs', bounds, correlationId: 'corr-1', now })
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      check: 'agent-runs-integrity',
      correlationId: 'corr-1',
      checkedAt: now.toISOString(),
      status: 'pass',
      failures: [],
      counts: { partitions: 2, runs: 3, claims: 1 },
    })
    expect(evidence.incompleteReason).toBeUndefined()
    const queries = commands.filter((command) => command instanceof QueryCommand)
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every((command) => command.input.ConsistentRead === true && command.input.Limit === 2)).toBe(true)
    expect(commands.filter((command) => command instanceof ScanCommand).every((command) => command.input.ConsistentRead === true)).toBe(true)
  })

  test('reports violations with counts and samples', async () => {
    const rows = healthyRows().filter((row) => row.recordKey !== 'agent-run-claim#task-1')
    const { client } = createFakeClient({ [partition]: rows })
    const evidence = await runAgentRunsIntegrityCheck({ client, tableName: 'agent-runs', teams: [team], bounds, correlationId: 'corr-2', now })
    expect(evidence.status).toBe('fail')
    expect(evidence.failures).toEqual([{
      code: 'AGENT_RUN_ACTIVE_RUN_UNCLAIMED',
      count: 1,
      samples: [{ directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', runId: runId(1) }],
    }])
    expect(JSON.stringify(evidence)).not.toContain('member-secret-1')
  })

  test('stops at the page bound without judging the partition it cut short', async () => {
    const rows = healthyRows().filter((row) => row.recordKey !== 'agent-run-claim#task-1')
    const { client } = createFakeClient({ [partition]: rows })
    const evidence = await runAgentRunsIntegrityCheck({
      client,
      tableName: 'agent-runs',
      teams: [team],
      bounds: { pageSize: 2, maxPages: 3, maxItems: 6 },
      correlationId: 'corr-3',
      now,
    })
    expect(evidence.status).toBe('incomplete')
    expect(evidence.incompleteReason).toBe('page-limit')
    expect(evidence.counts.partitions).toBe(0)
    expect(evidence.failures).toEqual([])
  })

  test('stops when a page repeats its continuation key', async () => {
    const client: AgentRunIntegrityClient = {
      send: async () => ({ Items: [], LastEvaluatedKey: { offset: 1 } }),
    }
    const evidence = await runAgentRunsIntegrityCheck({ client, tableName: 'agent-runs', teams: [team], bounds, correlationId: 'corr-4', now })
    expect(evidence.status).toBe('incomplete')
    expect(evidence.incompleteReason).toBe('cursor-repeated')
  })

  test('reports a partition key it cannot resolve', async () => {
    const { client } = createFakeClient({
      'no-team-separator': [{ directoryTeamId: 'no-team-separator', recordKey: 'x' }, { directoryTeamId: 'no-team-separator', recordKey: 'y' }],
    })
    const evidence = await runAgentRunsIntegrityCheck({ client, tableName: 'agent-runs', bounds, correlationId: 'corr-5', now })
    expect(evidence.failures).toEqual([{ code: 'AGENT_RUN_PARTITION_UNRESOLVED', count: 1, samples: [{}] }])
  })

  test('rejects invalid bounds before reading', async () => {
    const { client, commands } = createFakeClient({})
    await expect(runAgentRunsIntegrityCheck({
      client,
      tableName: 'agent-runs',
      bounds: { pageSize: 10, maxPages: 1, maxItems: 11 },
      correlationId: 'corr-6',
      now,
    })).rejects.toThrow(RangeError)
    expect(commands).toEqual([])
  })
})
