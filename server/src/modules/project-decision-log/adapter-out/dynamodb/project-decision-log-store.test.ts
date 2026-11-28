import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { ProjectDecisionEntry } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { DynamoDbProjectDecisionLogStore } from './project-decision-log-store'

/** Scope shared by every test. */
const scope = { workspaceId: 'w', teamId: 't', projectId: 'p' }

/** Entry written by the tests. */
const entry: ProjectDecisionEntry = {
  id: 'e1',
  title: 'Keep decisions in DynamoDB',
  content: 'One row per decision.',
  rationale: 'No new table.',
  deciderMemberIds: ['decider@example.com'],
  decidedAt: '2026-11-18T00:00:00.000Z',
  sources: [{ url: 'https://example.slack.com/archives/C1/p1' }],
  status: 'active',
  origin: 'project',
  recordedByMemberId: 'recorder@example.com',
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
 * Builds a stored decision row of the test Project.
 *
 * @param stored - Decision stored in the row.
 * @param projectId - Project of the row.
 * @returns The row.
 */
function entryRow(stored: ProjectDecisionEntry, projectId = 'p') {
  return {
    workspaceId: 'w',
    recordKey: `PROJECT_DECISION#t#${projectId}#ENTRY#${stored.id}`,
    entryType: 'project-decision-entry',
    schemaVersion: 1,
    teamId: 't',
    projectId,
    creationFingerprint: 'f1',
    ...stored,
  }
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
 * Creates the test decision with the given client.
 *
 * @param client - Fake client.
 * @param fingerprint - Creation fingerprint of the request.
 * @returns The stored decision or the rejection.
 */
function createWith(client: DynamoDBDocumentClient, fingerprint = 'f1') {
  return new DynamoDbProjectDecisionLogStore('planning', client, 'audit').create({
    ...scope,
    now: entry.createdAt,
    callerAuthorization,
    auditContext,
    entry,
    creationFingerprint: fingerprint,
  }).then((value) => value, (error: unknown) => error)
}

test('writes the decision, the counter, the caller fence, and a redacted audit event in one transaction', async () => {
  const sent: SentCommand[] = []
  expect(await createWith(fakeClient({ sent }))).toEqual(entry)
  const write = sent.find((command) => command.constructor.name === 'TransactWriteCommand')
  const items = write?.input.TransactItems
  expect(write?.input).toMatchObject({
    TransactItems: [
      { Put: { Item: { recordKey: 'PROJECT_DECISION#t#p#ENTRY#e1', entryType: 'project-decision-entry', creationFingerprint: 'f1' } } },
      {
        Update: {
          Key: { workspaceId: 'w', recordKey: 'PROJECT_DECISION#t#p' },
          ConditionExpression: 'attribute_not_exists(recordKey)',
          ExpressionAttributeValues: { ':next': 1 },
        },
      },
      callerAuthorization[0],
      { Put: { TableName: 'audit' } },
    ],
  })
  const auditItem = JSON.stringify(Array.isArray(items) ? items[3] : undefined)
  expect(auditItem).toContain('project.decision_recorded')
  for (const secret of [entry.title, entry.content, 'No new table.', 'decider@example.com', 'example.slack.com']) {
    expect(auditItem).not.toContain(secret)
  }
})

test('returns the stored decision when the same request is retried, and refuses a reused key', async () => {
  const writeError = cancellation(['ConditionalCheckFailed', 'None', 'None', 'ConditionalCheckFailed'])
  expect(await createWith(fakeClient({ row: entryRow(entry), writeError }))).toEqual(entry)
  expect(await createWith(fakeClient({ row: entryRow(entry), writeError }), 'f2'))
    .toMatchObject({ status: 409, code: 'ProjectDecisionEntryIdempotencyConflict' })
})

test('reports a full log only for a valid counter of this Project, and fails closed on a fractional count', async () => {
  const counter = { workspaceId: 'w', recordKey: 'PROJECT_DECISION#t#p', entryType: 'project-decision-log', schemaVersion: 1, teamId: 't', projectId: 'p', entryCount: 100 }
  expect(await createWith(fakeClient({ counter })))
    .toMatchObject({ status: 413, code: 'ProjectDecisionLogFull' })
  expect(await createWith(fakeClient({ counter: { ...counter, projectId: 'other' } })))
    .toMatchObject({ status: 502, code: 'ProjectDecisionLogCorruptState' })
  expect(await createWith(fakeClient({ counter: { ...counter, entryCount: 99.5 } })))
    .toMatchObject({ status: 502, code: 'ProjectDecisionLogCorruptState' })
})

test('requires the exact count it read, and answers a concurrent add as retryable', async () => {
  const sent: SentCommand[] = []
  const counter = { workspaceId: 'w', recordKey: 'PROJECT_DECISION#t#p', entryType: 'project-decision-log', schemaVersion: 1, teamId: 't', projectId: 'p', entryCount: 5 }
  await createWith(fakeClient({ counter, sent }))
  const write = sent.find((command) => command.constructor.name === 'TransactWriteCommand')
  const items = write?.input.TransactItems
  expect(Array.isArray(items) ? items[1] : undefined).toMatchObject({
    Update: { ExpressionAttributeValues: { ':count': 5, ':next': 6 } },
  })
  expect(await createWith(fakeClient({ counter, writeError: cancellation(['None', 'ConditionalCheckFailed', 'None', 'None']) })))
    .toMatchObject({ status: 503 })
})

test('names the audit action of a status change', async () => {
  const sent: SentCommand[] = []
  const next: ProjectDecisionEntry = { ...entry, status: 'withdrawn', revision: 2, updatedAt: '2026-11-20T00:00:00.000Z' }
  const store = new DynamoDbProjectDecisionLogStore('planning', fakeClient({ row: entryRow(entry), sent }), 'audit')
  await store.update({ ...scope, now: next.updatedAt, callerAuthorization, auditContext, previous: entry, previousReceipts: [], next, updateReceipt: 'r1', updateKey: 'k1' })
  const write = sent.find((command) => command.constructor.name === 'TransactWriteCommand')
  const items = write?.input.TransactItems
  expect(JSON.stringify(Array.isArray(items) ? items.at(-1) : undefined)).toContain('project.decision_withdrawn')
  expect(Array.isArray(items) ? items[0] : undefined).toMatchObject({
    Put: { ConditionExpression: '#type = :type AND #revision = :revision', ExpressionAttributeValues: { ':revision': 1 } },
  })
})

test('recognizes a concurrent attempt of the same update after the revision moved on', async () => {
  const next: ProjectDecisionEntry = { ...entry, title: 'Renamed', revision: 2, updatedAt: '2026-11-20T00:00:00.000Z' }
  const row = { ...entryRow(next), updateReceipts: [{ updateKey: 'k1', receipt: 'r1' }] }
  const writeError = cancellation(['ConditionalCheckFailed', 'None', 'None'])
  const update = (updateReceipt: string) => new DynamoDbProjectDecisionLogStore('planning', fakeClient({ row, writeError }), 'audit')
    .update({ ...scope, now: next.updatedAt, callerAuthorization, auditContext, previous: entry, previousReceipts: [], next, updateReceipt, updateKey: 'k1' })
    .then((value) => value, (error: unknown) => error)
  expect(await update('r1')).toEqual(next)
  expect(await update('r2')).toMatchObject({ status: 409, code: 'ProjectDecisionEntryIdempotencyConflict' })
})

test('reads every decision of a Team on the server-side filter, across pages', async () => {
  const sent: SentCommand[] = []
  const other = { ...entry, id: 'e2' }
  const pages = [
    { items: [entryRow(entry)], lastEvaluatedKey: { workspaceId: 'w', recordKey: 'PROJECT_DECISION#t#p#ENTRY#e1' } },
    { items: [entryRow(other, 'q')] },
  ]
  const store = new DynamoDbProjectDecisionLogStore('planning', fakeClient({ pages, sent }))
  expect(await store.listTeam('w', 't')).toEqual([
    { projectId: 'p', entry },
    { projectId: 'q', entry: other },
  ])
  const queries = sent.filter((command) => command.constructor.name === 'QueryCommand')
  expect(queries).toHaveLength(2)
  expect(queries[0]?.input).toMatchObject({
    FilterExpression: '#entryType = :entryType',
    ExpressionAttributeValues: { ':prefix': 'PROJECT_DECISION#t#', ':entryType': 'project-decision-entry' },
    ConsistentRead: false,
  })
  expect(queries[1]?.input.ExclusiveStartKey).toEqual(pages[0]?.lastEvaluatedKey)
})

test('fails closed on a row from another Project or scope', async () => {
  const store = new DynamoDbProjectDecisionLogStore('planning', fakeClient({ row: { ...entryRow(entry), projectId: 'other' } }))
  expect(await store.get(scope, 'e1').catch((error: unknown) => error)).toMatchObject({ status: 502 })
  const listing = new DynamoDbProjectDecisionLogStore('planning', fakeClient({ pages: [{ items: [{ ...entryRow(entry), teamId: 'other' }] }] }))
  expect(await listing.listTeam('w', 't').catch((error: unknown) => error)).toMatchObject({ status: 502 })
})

test('reports a lost caller fence as a conflict and throttling as retryable', async () => {
  expect(await createWith(fakeClient({ writeError: cancellation(['None', 'None', 'ConditionalCheckFailed', 'None']) })))
    .toMatchObject({ status: 409, code: 'ProjectDecisionEntryConflict' })
  expect(await createWith(fakeClient({ writeError: cancellation(['ThrottlingError', 'None', 'None', 'None']) })))
    .toMatchObject({ status: 503 })
})
