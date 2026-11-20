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

/**
 * Builds a document client that answers reads with the given row and writes with the given error.
 *
 * @param options - Stored row, write error, and a list collecting every command.
 * @returns The fake client.
 */
function fakeClient(options: { row?: Record<string, unknown>; writeError?: unknown; sent?: SentCommand[] }): DynamoDBDocumentClient {
  const client = {
    async send(command: SentCommand) {
      options.sent?.push(command)
      if (command.constructor.name === 'GetCommand') return { Item: options.row }
      if (options.writeError) throw options.writeError
      return {}
    },
  }
  return Object.assign(Object.create(null), client)
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
})

test('returns the stored entry when the same request is retried', async () => {
  const row = { workspaceId: 'w', recordKey: 'PROJECT_RAID#t#p#ENTRY#e1', entryType: 'project-raid-entry', schemaVersion: 1, teamId: 't', projectId: 'p', creationFingerprint: 'f1', ...entry }
  const writeError = cancellation(['ConditionalCheckFailed', 'None', 'None', 'ConditionalCheckFailed'])
  expect(await createWith(fakeClient({ row, writeError }))).toEqual(entry)
  expect(await createWith(fakeClient({ row, writeError }), 'f2')).toMatchObject({ status: 409 })
})

test('reports a full log', async () => {
  expect(await createWith(fakeClient({ writeError: cancellation(['None', 'ConditionalCheckFailed', 'None', 'None']) })))
    .toMatchObject({ status: 413, code: 'ProjectRaidLogFull' })
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
