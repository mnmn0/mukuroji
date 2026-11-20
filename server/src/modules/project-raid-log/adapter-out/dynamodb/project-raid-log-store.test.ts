import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { ProjectRaidEntry } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { DynamoDbProjectRaidLogStore } from './project-raid-log-store'

/** Scope shared by every test. */
const scope = { workspaceId: 'w', teamId: 't', projectId: 'p' }

/** Entry written by the tests. */
const entry: ProjectRaidEntry = {
  id: 'e1',
  kind: 'issue',
  title: 'Build broken',
  impact: 3,
  status: 'open',
  revision: 1,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
}

/** Caller fence included in every write. */
const callerAuthorization = [{ ConditionCheck: { TableName: 'access', Key: { k: 'v' }, ConditionExpression: 'attribute_exists(k)' } }]

/** Audit context of the writes. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'u', kind: 'user', displayName: 'U' },
  idempotencyKey: 'key',
  request: { method: 'POST', path: '/x', body: {} },
  source: { kind: 'api' },
})

/** Commands the fake client received. */
type SentCommand = {
  /** Command class, identified by its name. */
  constructor: {
    /** Command class name, such as `TransactWriteCommand`. */
    name: string
  }
  /** Command input as sent to the client. */
  input: Record<string, unknown>
}

/** Stored rows and failures the fake client answers with. */
type FakeClientOptions = {
  /** Entry row returned by entry reads. */
  row?: Record<string, unknown>
  /** Counter row returned by counter reads. */
  counter?: Record<string, unknown>
  /** Query pages returned in order, each with the key of the page after it. */
  pages?: { items: Record<string, unknown>[]; lastEvaluatedKey?: Record<string, unknown> }[]
  /** Error thrown by every write. */
  writeError?: unknown
  /** List collecting every command. */
  sent?: SentCommand[]
}

/**
 * Builds a document client that answers reads with the given rows and writes with the given error.
 *
 * @param options - Stored rows, query pages, write error, and a list collecting every command.
 * @returns The fake client.
 */
function fakeClient(options: FakeClientOptions): DynamoDBDocumentClient {
  let queryCount = 0
  const client = {
    async send(command: SentCommand) {
      options.sent?.push(command)
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key
        const recordKey = typeof key === 'object' && key !== null && 'recordKey' in key ? key.recordKey : undefined
        return { Item: typeof recordKey === 'string' && recordKey.includes('#ENTRY#') ? options.row : options.counter }
      }
      if (command.constructor.name === 'QueryCommand') {
        const page = options.pages?.[queryCount]
        queryCount += 1
        return { Items: page?.items ?? [], ...(page?.lastEvaluatedKey ? { LastEvaluatedKey: page.lastEvaluatedKey } : {}) }
      }
      if (options.writeError) throw options.writeError
      return {}
    },
  }
  return Object.assign(Object.create(null), client)
}

/**
 * Builds a stored entry row of the test Project.
 *
 * @param stored - Entry stored in the row.
 * @returns The row.
 */
function entryRow(stored: ProjectRaidEntry) {
  return { workspaceId: 'w', recordKey: `PROJECT_RAID#t#p#ENTRY#${stored.id}`, entryType: 'project-raid-entry', schemaVersion: 1, teamId: 't', projectId: 'p', creationFingerprint: 'f1', ...stored }
}

/**
 * Builds a transaction cancellation with the given reason codes.
 *
 * @param codes - Cancellation reason codes.
 * @returns The error.
 */
function cancellation(codes: string[]) {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  })
}

/**
 * Creates the test entry with the given client.
 *
 * @param client - Fake client.
 * @param fingerprint - Creation fingerprint of the request.
 * @returns The stored entry or the rejection.
 */
function createWith(client: DynamoDBDocumentClient, fingerprint = 'f1') {
  return new DynamoDbProjectRaidLogStore('planning', client, 'audit').create({
    ...scope,
    now: entry.createdAt,
    callerAuthorization,
    auditContext,
    entry,
    creationFingerprint: fingerprint,
  }).then((value) => value, (error: unknown) => error)
}

test('writes the entry, the counter, the caller fence, and the audit event in one transaction', async () => {
  const sent: SentCommand[] = []
  expect(await createWith(fakeClient({ sent }))).toEqual(entry)
  const items = sent[0]?.input.TransactItems
  expect(Array.isArray(items) ? items.length : 0).toBe(4)
  expect(sent[0]?.input).toMatchObject({
    TransactItems: [
      { Put: { Item: { recordKey: 'PROJECT_RAID#t#p#ENTRY#e1', entryType: 'project-raid-entry', creationFingerprint: 'f1' } } },
      { Update: { Key: { workspaceId: 'w', recordKey: 'PROJECT_RAID#t#p' } } },
      callerAuthorization[0],
      { Put: { TableName: 'audit' } },
    ],
  })
  // The counter is checked against its Project and schema, and an existing one keeps them.
  expect(Array.isArray(items) ? items[1] : undefined).toMatchObject({
    Update: {
      ConditionExpression: 'attribute_not_exists(recordKey) OR (#type = :type AND #schemaVersion = :schemaVersion AND #teamId = :teamId AND #projectId = :projectId AND #count >= :zero AND #count < :max)',
      ExpressionAttributeValues: { ':teamId': 't', ':projectId': 'p', ':schemaVersion': 1 },
    },
  })
  // The audit event records that the title was set without keeping its text.
  const auditItem = Array.isArray(items) ? items[3] : undefined
  expect(JSON.stringify(auditItem)).not.toContain(entry.title)
})

test('returns the stored entry when the same request is retried', async () => {
  const row = { workspaceId: 'w', recordKey: 'PROJECT_RAID#t#p#ENTRY#e1', entryType: 'project-raid-entry', schemaVersion: 1, teamId: 't', projectId: 'p', creationFingerprint: 'f1', ...entry }
  const writeError = cancellation(['ConditionalCheckFailed', 'None', 'None', 'ConditionalCheckFailed'])
  expect(await createWith(fakeClient({ row, writeError }))).toEqual(entry)
  expect(await createWith(fakeClient({ row, writeError }), 'f2')).toMatchObject({ status: 409 })
})

test('does not return the stored entry to a retry whose caller fence failed', async () => {
  const writeError = cancellation(['ConditionalCheckFailed', 'None', 'ConditionalCheckFailed', 'ConditionalCheckFailed'])
  expect(await createWith(fakeClient({ row: entryRow(entry), writeError })))
    .toMatchObject({ status: 409, code: 'ProjectRaidEntryConflict' })
})

test('reports a full log only for a valid counter of this Project', async () => {
  const writeError = cancellation(['None', 'ConditionalCheckFailed', 'None', 'None'])
  const counter = { workspaceId: 'w', recordKey: 'PROJECT_RAID#t#p', entryType: 'project-raid-log', schemaVersion: 1, teamId: 't', projectId: 'p', entryCount: 300 }
  expect(await createWith(fakeClient({ counter, writeError })))
    .toMatchObject({ status: 413, code: 'ProjectRaidLogFull' })
  expect(await createWith(fakeClient({ counter: { ...counter, schemaVersion: 2 }, writeError })))
    .toMatchObject({ status: 502, code: 'ProjectRaidLogCorruptState' })
  expect(await createWith(fakeClient({ counter: { ...counter, projectId: 'other' }, writeError })))
    .toMatchObject({ status: 502, code: 'ProjectRaidLogCorruptState' })
  expect(await createWith(fakeClient({ counter: { ...counter, entryCount: 12 }, writeError })))
    .toMatchObject({ status: 502, code: 'ProjectRaidLogCorruptState' })
  expect(await createWith(fakeClient({ counter: { ...counter, entryCount: -1 }, writeError })))
    .toMatchObject({ status: 502, code: 'ProjectRaidLogCorruptState' })
  expect(await createWith(fakeClient({ counter: { ...counter, entryCount: 300.5 }, writeError })))
    .toMatchObject({ status: 502, code: 'ProjectRaidLogCorruptState' })
})

test('records that the title changed on an update without keeping either text', async () => {
  const sent: SentCommand[] = []
  const previous = entry
  const next: ProjectRaidEntry = { ...entry, title: 'Build fixed', revision: 2, updatedAt: '2026-11-20T00:00:00.000Z' }
  const store = new DynamoDbProjectRaidLogStore('planning', fakeClient({ row: entryRow(previous), sent }), 'audit')
  await store.update({
    ...scope,
    now: next.updatedAt,
    callerAuthorization,
    auditContext,
    previous,
    next,
    updateReceipt: 'r1',
    updateKey: 'k1',
  })
  const write = sent.find((command) => command.constructor.name === 'TransactWriteCommand')
  const items = write?.input.TransactItems
  const auditItem = JSON.stringify(Array.isArray(items) ? items.at(-1) : undefined)
  expect(auditItem).toContain('"title"')
  expect(auditItem).not.toContain(previous.title)
  expect(auditItem).not.toContain(next.title)
})

test('reads every page of a log', async () => {
  const sent: SentCommand[] = []
  const second = { ...entry, id: 'e2' }
  const pages = [
    { items: [entryRow(entry)], lastEvaluatedKey: { workspaceId: 'w', recordKey: 'PROJECT_RAID#t#p#ENTRY#e1' } },
    { items: [entryRow(second)] },
  ]
  const store = new DynamoDbProjectRaidLogStore('planning', fakeClient({ pages, sent }))
  expect(await store.list(scope)).toEqual([entry, second])
  const queries = sent.filter((command) => command.constructor.name === 'QueryCommand')
  expect(queries).toHaveLength(2)
  expect(queries[0]?.input.ExclusiveStartKey).toBeUndefined()
  expect(queries[1]?.input.ExclusiveStartKey).toEqual(pages[0]?.lastEvaluatedKey)
})

test('reports a lost caller fence as a conflict and throttling as retryable', async () => {
  expect(await createWith(fakeClient({ writeError: cancellation(['None', 'None', 'ConditionalCheckFailed', 'None']) })))
    .toMatchObject({ status: 409 })
  expect(await createWith(fakeClient({ writeError: cancellation(['ThrottlingError', 'None', 'None', 'None']) })))
    .toMatchObject({ status: 503 })
  expect(await createWith(fakeClient({ writeError: cancellation(['ValidationError', 'None', 'None', 'None']) })))
    .toMatchObject({ status: 502 })
})

test('fails closed on a row from another Project', async () => {
  const row = { workspaceId: 'w', recordKey: 'PROJECT_RAID#t#p#ENTRY#e1', entryType: 'project-raid-entry', schemaVersion: 1, teamId: 't', projectId: 'other', ...entry }
  const store = new DynamoDbProjectRaidLogStore('planning', fakeClient({ row }))
  expect(await store.get(scope, 'e1').catch((error: unknown) => error)).toMatchObject({ status: 502 })
})
