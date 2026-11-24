import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import type { PortfolioProjectMetrics } from '@mukuroji/contracts'
import { createMutationAuditContext } from '../../../audit'
import { captureTeamPortfolioSnapshot } from '../../application/team-portfolio'
import { DynamoDbTeamPortfolioSnapshotStore, InMemoryTeamPortfolioSnapshotStore } from './portfolio-snapshot-store'

/** Audit context of the test writes. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'u', kind: 'user', displayName: 'U' },
  idempotencyKey: 'key',
  request: { method: 'PUT', path: '/x', body: {} },
  source: { kind: 'api' },
})

/**
 * Builds a save of the November snapshot at one revision.
 *
 * @param revision - Revision the save writes.
 * @param keyHash - Idempotency key hash of the save.
 * @returns The write input.
 */
function save(revision: number, keyHash = `key-${revision}`) {
  return {
    snapshot: { workspaceId: 'w', teamId: 't', month: '2026-11', capturedAt: `2026-11-2${revision}T00:00:00.000Z`, revision, projects: [] },
    callerAuthorization: [],
    auditContext,
    receipt: { keyHash, requestFingerprint: 'f', month: '2026-11', revision },
  }
}

test('replaces a month only from the revision the capture read', async () => {
  const store = new InMemoryTeamPortfolioSnapshotStore()
  await store.put(save(1))
  await expect(store.put(save(1, 'other'))).rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotConflict' })
  await store.put(save(2))
  await expect(store.put(save(2, 'another'))).rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotConflict' })
  await expect(store.put(save(3, 'key-1'))).rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotConflict' })
  expect(await store.get('w', 't', '2026-11')).toMatchObject({ revision: 2, capturedAt: '2026-11-22T00:00:00.000Z' })
  expect(await store.getReceipt('w', 't', 'key-2')).toEqual({ keyHash: 'key-2', requestFingerprint: 'f', month: '2026-11', revision: 2 })
  await expect(store.put(save(0))).rejects.toMatchObject({ status: 400 })
})

test('returns the completed save on a retry with the same key without capturing again', async () => {
  const store = new InMemoryTeamPortfolioSnapshotStore()
  let captures = 0
  const ports = {
    store,
    computeProjects: async (): Promise<PortfolioProjectMetrics[]> => {
      captures += 1
      return []
    },
  }
  const input = {
    workspaceId: 'w',
    teamId: 't',
    month: '2026-11',
    currentMonth: '2026-11',
    now: new Date('2026-11-23T00:00:00.000Z'),
    canCapture: true,
    callerAuthorization: [],
    auditContext,
    idempotencyKeyHash: 'retry-key',
    requestFingerprint: 'fingerprint',
  }

  const first = await captureTeamPortfolioSnapshot(ports, input)
  const retried = await captureTeamPortfolioSnapshot(ports, { ...input, now: new Date('2026-11-23T00:01:00.000Z') })
  expect(retried).toEqual(first)
  expect(captures).toBe(1)
  const afterMonthEnd = await captureTeamPortfolioSnapshot(ports, { ...input, currentMonth: '2026-12', now: new Date('2026-12-01T00:00:00.000Z') })
  expect(afterMonthEnd).toEqual(first)
  expect(captures).toBe(1)

  await expect(captureTeamPortfolioSnapshot(ports, { ...input, requestFingerprint: 'other' }))
    .rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotIdempotencyConflict' })
  await expect(captureTeamPortfolioSnapshot(ports, { ...input, idempotencyKeyHash: 'new', canCapture: false }))
    .rejects.toMatchObject({ status: 403 })
  await expect(captureTeamPortfolioSnapshot(ports, { ...input, idempotencyKeyHash: 'new', month: '2026-10' }))
    .rejects.toMatchObject({ status: 400 })
  const second = await captureTeamPortfolioSnapshot(ports, { ...input, idempotencyKeyHash: 'new' })
  expect(second.revision).toBe(2)
  expect(captures).toBe(2)
})

/**
 * Creates a DocumentClient that records each command and answers with an empty result.
 *
 * @param commands - Receives every command sent.
 * @returns The client.
 */
function recordingClient(commands: unknown[]): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  Object.defineProperty(client, 'send', {
    configurable: true,
    value: async (command: unknown): Promise<unknown> => {
      commands.push(command)
      return {}
    },
  })
  return client
}

test('sends the snapshot, receipt, caller fences, and audit in one transaction, and nothing without fences', async () => {
  const commands: unknown[] = []
  const store = new DynamoDbTeamPortfolioSnapshotStore('planning-table', recordingClient(commands), 'audit-table')
  await expect(store.put(save(1))).rejects.toMatchObject({ status: 503, code: 'PortfolioSnapshotAuthorizationUnavailable' })
  expect(commands).toHaveLength(0)

  const fence = { ConditionCheck: { TableName: 'directory-table', Key: { directoryId: 'w', entryKey: 'TEAM#t' }, ConditionExpression: 'attribute_not_exists(archivedAt)' } }
  await store.put({ ...save(1), callerAuthorization: [fence] })
  expect(commands).toHaveLength(1)
  const items: unknown = Reflect.get(Reflect.get(commands[0] ?? {}, 'input') ?? {}, 'TransactItems')
  if (!Array.isArray(items)) throw new Error('The write is not a transaction.')
  expect(items).toHaveLength(4)
  expect(items[0]).toMatchObject({ Put: { TableName: 'planning-table', Item: { recordKey: 'TEAM_PORTFOLIO_SNAPSHOT#t#2026-11', revision: 1 }, ConditionExpression: 'attribute_not_exists(recordKey)' } })
  expect(items[1]).toMatchObject({ Put: { TableName: 'planning-table', Item: { entryType: 'team-portfolio-snapshot-receipt', keyHash: 'key-1' } } })
  expect(items[2]).toEqual(fence)
  expect(items[3]).toMatchObject({ Put: { TableName: 'audit-table' } })
})
