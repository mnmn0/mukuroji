import { describe, expect, test } from 'bun:test'
import {
  AGENT_RUN_ARTIFACT_STATUS_SCHEMA_VERSION,
  artifactRefreshRecordKey,
  artifactStatusRecordKey,
} from './adapter-out/dynamodb/agent-run-artifact-status-store'
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import {
  checkAgentRunPartition,
  runAgentRunsIntegrityCheck,
  summarizeAgentRunIntegrityFindings,
  type AgentRunIntegrityClient,
  type AgentRunIntegrityFailureCode,
  type AgentRunWorkItemLookup,
  type AgentRunWorkItemReference,
  type AgentRunWorkItemState,
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
      artifactStatuses: 0,
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

  test('accepts pull request artifact status and refresh rows, and checks them against their keys', () => {
    const url = 'https://github.com/org/repo/pull/1'
    const status = {
      url, provider: 'github', repository: 'org/repo', number: 1, verification: 'unverified',
      unverifiedReason: 'no-connector', checkedAt: '2026-11-26T00:00:00.000Z',
    }
    const statusRow = {
      directoryTeamId: partition, recordKey: artifactStatusRecordKey('task-1', url), schemaVersion: AGENT_RUN_ARTIFACT_STATUS_SCHEMA_VERSION,
      workspaceId: team.directoryId, workItemId: 'task-1', artifactStatus: status, checkedAt: status.checkedAt,
    }
    const refreshRow = {
      directoryTeamId: partition, recordKey: artifactRefreshRecordKey('task-1'), workspaceId: team.directoryId,
      workItemId: 'task-1', refreshedAt: '2026-11-26T00:00:00.000Z',
    }
    const result = checkAgentRunPartition(team, [...healthyRows(), statusRow, refreshRow])
    expect(result.findings).toEqual([])
    expect(result.counts.artifactStatuses).toBe(2)
    expect(codes([...healthyRows(), { ...statusRow, workItemId: 'task-2' }])).toEqual(['AGENT_RUN_ROW_MALFORMED'])
    expect(codes([...healthyRows(), { ...refreshRow, refreshedAt: 'soon' }])).toEqual(['AGENT_RUN_ROW_MALFORMED'])
    // The refresh count is optional for rows claimed before it existed, and a positive integer otherwise.
    expect(checkAgentRunPartition(team, [...healthyRows(), { ...refreshRow, refreshCount: 4 }]).findings).toEqual([])
    expect(codes([...healthyRows(), { ...refreshRow, refreshCount: 0 }])).toEqual(['AGENT_RUN_ROW_MALFORMED'])
    expect(codes([...healthyRows(), { ...refreshRow, refreshCount: '4' }])).toEqual(['AGENT_RUN_ROW_MALFORMED'])
    // Tenant export and deletion find rows by Workspace, so a row naming another one, or none, is malformed.
    expect(codes([...healthyRows(), { ...statusRow, workspaceId: 'other-workspace' }])).toEqual(['AGENT_RUN_ROW_MALFORMED'])
    expect(codes([...healthyRows(), { ...refreshRow, workspaceId: 'other-workspace' }])).toEqual(['AGENT_RUN_ROW_MALFORMED'])
    expect(codes([...healthyRows(), { ...refreshRow, workspaceId: undefined }])).toEqual(['AGENT_RUN_ROW_MALFORMED'])
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
  const commands: Array<QueryCommand | ScanCommand | GetCommand> = []
  const page = (items: Record<string, unknown>[], startKey: Record<string, unknown> | undefined, limit: number | undefined) => {
    const offset = typeof startKey?.offset === 'number' ? startKey.offset : 0
    const next = offset + Math.min(pageSize, limit ?? pageSize)
    return { Items: items.slice(offset, next), ...(next < items.length ? { LastEvaluatedKey: { offset: next } } : {}) }
  }
  const client: AgentRunIntegrityClient = {
    async send(command) {
      commands.push(command)
      if (command instanceof ScanCommand) {
        const all = Object.entries(partitions).flatMap(([key, rows]) => rows.map(() => ({ directoryTeamId: key })))
        return page(all, command.input.ExclusiveStartKey, command.input.Limit)
      }
      if (command instanceof GetCommand) {
        const key = command.input.Key
        const rows = typeof key?.directoryTeamId === 'string' ? partitions[key.directoryTeamId] ?? [] : []
        const item = rows.find((row) => row.recordKey === key?.recordKey)
        return item === undefined ? {} : { Item: item }
      }
      const key = command.input.ExpressionAttributeValues?.[':partition']
      return page(typeof key === 'string' ? partitions[key] ?? [] : [], command.input.ExclusiveStartKey, command.input.Limit)
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
      // Agent usage rows and export receipts belong to members and are not Team partitions.
      'workspace-1#agent-usage#member#demo@example.com': [{ directoryTeamId: 'workspace-1#agent-usage#member#demo@example.com', recordKey: 'bucket' }],
      'workspace-1#agent-usage-batch#member#demo@example.com': [{ directoryTeamId: 'workspace-1#agent-usage-batch#member#demo@example.com', recordKey: 'batch#0' }],
      // The Workspace agent defaults belong to the Workspace.
      'workspace-1#workspace': [{ directoryTeamId: 'workspace-1#workspace', recordKey: 'agent-defaults' }],
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

  test('reports a violation only when a second read of the partition shows it too', async () => {
    const healthy = healthyRows()
    const unclaimed = healthy.filter((row) => row.recordKey !== 'agent-run-claim#task-1')
    let reads = 0
    const client: AgentRunIntegrityClient = {
      // The first read sees a claim missing, as a concurrent finish between pages can make it look.
      send: async () => ({ Items: reads++ === 0 ? unclaimed : healthy }),
    }
    const evidence = await runAgentRunsIntegrityCheck({
      client,
      tableName: 'agent-runs',
      teams: [team],
      bounds: { pageSize: 100, maxPages: 10, maxItems: 1000 },
      correlationId: 'corr-7',
      now,
    })
    expect(evidence.status).toBe('pass')
    expect(evidence.failures).toEqual([])
    expect(evidence.counts).toMatchObject({ partitions: 1, recheckedPartitions: 1, unconfirmedFindings: 1, claims: 1 })
  })

  test('confirms a persistent violation with a second read', async () => {
    const rows = healthyRows().filter((row) => row.recordKey !== 'agent-run-claim#task-1')
    const { client, commands } = createFakeClient({ [partition]: rows }, 100)
    const evidence = await runAgentRunsIntegrityCheck({
      client,
      tableName: 'agent-runs',
      teams: [team],
      bounds: { pageSize: 100, maxPages: 10, maxItems: 1000 },
      correlationId: 'corr-8',
      now,
    })
    expect(evidence.status).toBe('fail')
    expect(evidence.counts).toMatchObject({ recheckedPartitions: 1, unconfirmedFindings: 0 })
    expect(commands).toHaveLength(2)
  })

  test('never requests more items than the item budget has left', async () => {
    const { client, commands } = createFakeClient({ [partition]: healthyRows() }, 1000)
    const evidence = await runAgentRunsIntegrityCheck({
      client,
      tableName: 'agent-runs',
      teams: [team],
      bounds: { pageSize: 1000, maxPages: 1, maxItems: 1 },
      correlationId: 'corr-9',
      now,
    })
    expect(evidence.status).toBe('incomplete')
    expect(evidence.reads.items).toBe(1)
    expect(commands.filter((command) => command instanceof QueryCommand).map((command) => command.input.Limit)).toEqual([1])
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

/**
 * Builds a Work Item lookup that serves fixed states and records each read.
 *
 * @param states - State by Work Item ID; Work Items not listed are open.
 * @returns Lookup and the reads it served.
 */
function createWorkItemLookup(states: Record<string, AgentRunWorkItemState>) {
  const reads: AgentRunWorkItemReference[] = []
  const lookup: AgentRunWorkItemLookup = {
    async read(workItem) {
      reads.push(workItem)
      return states[workItem.workItemId] ?? { kind: 'present', archived: false }
    },
  }
  return { lookup, reads }
}

describe('runAgentRunsIntegrityCheck with the Work Item check', () => {
  const bounds = { pageSize: 100, maxPages: 100, maxItems: 1000 }
  const now = new Date('2026-11-20T00:00:00.000Z')
  const activeSample = { directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1', runId: runId(1) }

  test('reads the Work Item of each active run and passes an open one', async () => {
    const { client, commands } = createFakeClient({ [partition]: healthyRows() }, 100)
    const { lookup, reads } = createWorkItemLookup({})
    const evidence = await runAgentRunsIntegrityCheck({
      client, tableName: 'agent-runs', teams: [team], bounds, correlationId: 'corr-w1', now, workItems: lookup,
    })
    expect(evidence.status).toBe('pass')
    expect(evidence.counts).toMatchObject({ activeRuns: 1, workItemsChecked: 1, unconfirmedFindings: 0 })
    expect(reads).toEqual([{ directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1' }])
    expect(commands.some((command) => command instanceof GetCommand)).toBe(false)
  })

  test.each<[string, AgentRunWorkItemState, AgentRunIntegrityFailureCode]>([
    ['deleted', { kind: 'missing' }, 'AGENT_RUN_ACTIVE_RUN_WORK_ITEM_DELETED'],
    ['archived', { kind: 'present', archived: true }, 'AGENT_RUN_ACTIVE_RUN_WORK_ITEM_ARCHIVED'],
  ])('reports an active run on a %s Work Item after reading the run again', async (_name, state, code) => {
    const { client, commands } = createFakeClient({ [partition]: healthyRows() }, 100)
    const { lookup } = createWorkItemLookup({ 'task-1': state })
    const evidence = await runAgentRunsIntegrityCheck({
      client, tableName: 'agent-runs', teams: [team], bounds, correlationId: 'corr-w2', now, workItems: lookup,
    })
    expect(evidence.status).toBe('fail')
    expect(evidence.failures).toEqual([{ code, count: 1, samples: [activeSample] }])
    const gets = commands.filter((command) => command instanceof GetCommand)
    expect(gets.map((command) => command.input)).toEqual([{
      TableName: 'agent-runs',
      Key: { directoryTeamId: partition, recordKey: `agent-run#${runId(1)}` },
      ConsistentRead: true,
    }])
    expect(JSON.stringify(evidence)).not.toContain('member-secret-1')
  })

  test('reports a Work Item row it cannot read without reading the run again', async () => {
    const { client, commands } = createFakeClient({ [partition]: healthyRows() }, 100)
    const { lookup } = createWorkItemLookup({ 'task-1': { kind: 'malformed' } })
    const evidence = await runAgentRunsIntegrityCheck({
      client, tableName: 'agent-runs', teams: [team], bounds, correlationId: 'corr-w3', now, workItems: lookup,
    })
    expect(evidence.failures).toEqual([{ code: 'AGENT_RUN_ACTIVE_RUN_WORK_ITEM_UNREADABLE', count: 1, samples: [activeSample] }])
    expect(commands.some((command) => command instanceof GetCommand)).toBe(false)
  })

  test('does not report a run that closed after its Work Item was read', async () => {
    const rows = healthyRows()
    const released = serializeRun(finishAgentRun(createRun(1, 'task-1'), 'released', 'person', finishedAt))
    const { client } = createFakeClient({ [partition]: rows }, 100)
    const reread: AgentRunIntegrityClient = {
      // The archive transaction released the run between the partition read and the run read.
      send: async (command) => command instanceof GetCommand ? { Item: released } : client.send(command),
    }
    const { lookup } = createWorkItemLookup({ 'task-1': { kind: 'present', archived: true } })
    const evidence = await runAgentRunsIntegrityCheck({
      client: reread, tableName: 'agent-runs', teams: [team], bounds, correlationId: 'corr-w4', now, workItems: lookup,
    })
    expect(evidence.status).toBe('pass')
    expect(evidence.counts).toMatchObject({ workItemsChecked: 1, unconfirmedFindings: 1 })
  })

  test('stops at the page bound while reading Work Items', async () => {
    const { client } = createFakeClient({ [partition]: healthyRows() }, 100)
    const { lookup, reads } = createWorkItemLookup({})
    const evidence = await runAgentRunsIntegrityCheck({
      client, tableName: 'agent-runs', teams: [team], bounds: { pageSize: 100, maxPages: 1, maxItems: 100 }, correlationId: 'corr-w5', now, workItems: lookup,
    })
    expect(evidence.status).toBe('incomplete')
    expect(evidence.incompleteReason).toBe('page-limit')
    expect(evidence.counts).toMatchObject({ partitions: 1, workItemsChecked: 0 })
    expect(reads).toEqual([])
  })
})
