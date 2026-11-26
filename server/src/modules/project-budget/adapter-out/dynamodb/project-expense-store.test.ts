import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { ProjectExpense } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { DynamoDbProjectExpenseStore } from './project-expense-store'

/** Scope shared by every test. */
const scope = { workspaceId: 'w', teamId: 't', projectId: 'p' }

/** Expense written by the tests. */
const expense: ProjectExpense = {
  id: 'x1',
  teamId: 't',
  projectId: 'p',
  date: '2026-11-19',
  category: '外注費',
  amountMinor: 10_000,
  currency: 'JPY',
  receiptFileIds: ['file-1'],
  status: 'submitted',
  submittedByMemberId: 'pm@example.com',
  submittedAt: '2026-11-19T00:00:00.000Z',
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
  /** Expense row returned by expense reads. */
  row?: Record<string, unknown>
  /** Counter row returned by counter reads. */
  counter?: Record<string, unknown>
  /** Items returned by a query. */
  items?: Record<string, unknown>[]
  /** Query result pages, each but the last followed by a `LastEvaluatedKey`; overrides `items`. */
  pages?: Record<string, unknown>[][]
  /** Error thrown by every write. */
  writeError?: unknown
  /** List collecting every command. */
  sent?: SentCommand[]
}

/**
 * Builds a document client that answers reads with the given rows and writes with the given error.
 *
 * @param options - Stored rows, query items, write error, and a list collecting every command.
 * @returns The fake client.
 */
function fakeClient(options: FakeClientOptions): DynamoDBDocumentClient {
  const client = {
    async send(command: SentCommand) {
      options.sent?.push(command)
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key
        const recordKey = typeof key === 'object' && key !== null && 'recordKey' in key ? key.recordKey : undefined
        return { Item: typeof recordKey === 'string' && recordKey.includes('#ENTRY#') ? options.row : options.counter }
      }
      if (command.constructor.name === 'QueryCommand') {
        if (!options.pages) return { Items: options.items ?? [] }
        const start = command.input.ExclusiveStartKey
        const index = typeof start === 'object' && start !== null && 'page' in start && typeof start.page === 'number' ? start.page : 0
        return {
          Items: options.pages[index] ?? [],
          ...(index + 1 < options.pages.length ? { LastEvaluatedKey: { page: index + 1 } } : {}),
        }
      }
      if (options.writeError) throw options.writeError
      return {}
    },
  }
  return Object.assign(Object.create(null), client)
}

/**
 * Builds a stored row of the test Project.
 *
 * @param stored - Expense stored in the row.
 * @returns The row.
 */
function expenseRow(stored: ProjectExpense) {
  return { workspaceId: 'w', recordKey: `PROJECT_EXPENSE#t#p#ENTRY#${stored.id}`, entryType: 'project-expense', schemaVersion: 1, creationFingerprint: 'f1', ...stored }
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
 * Creates the test expense with the given client.
 *
 * @param client - Fake client.
 * @param fingerprint - Creation fingerprint of the request.
 * @returns The stored expense or the rejection.
 */
function createWith(client: DynamoDBDocumentClient, fingerprint = 'f1') {
  return new DynamoDbProjectExpenseStore('planning', client, 'audit').create({
    ...scope,
    now: expense.createdAt,
    callerAuthorization,
    auditContext,
    expense,
    creationFingerprint: fingerprint,
  }).then((value) => value, (error: unknown) => error)
}

test('writes the expense, the counter, the caller fence, and the audit event in one transaction', async () => {
  const sent: SentCommand[] = []
  expect(await createWith(fakeClient({ sent }))).toEqual(expense)
  expect(sent[0]?.input).toMatchObject({
    TransactItems: [
      { Put: { TableName: 'planning', Item: { workspaceId: 'w', recordKey: 'PROJECT_EXPENSE#t#p#ENTRY#x1', entryType: 'project-expense', creationFingerprint: 'f1' } } },
      { Update: { Key: { workspaceId: 'w', recordKey: 'PROJECT_EXPENSE#t#p' } } },
      callerAuthorization[0],
      { Put: { TableName: 'audit' } },
    ],
  })
  // The amount is confidential, so the audit event records that it changed without its value.
  const input = sent[0]?.input
  const items = typeof input === 'object' && input !== null && 'TransactItems' in input && Array.isArray(input.TransactItems) ? input.TransactItems : []
  const auditItem = JSON.stringify(items[3])
  expect(auditItem).toContain('amountMinor')
  expect(auditItem).not.toContain(String(expense.amountMinor))
})

test('returns the stored expense for a retried creation and refuses a reused key with other content', async () => {
  const writeError = cancellation(['ConditionalCheckFailed', 'None', 'None', 'None'])
  expect(await createWith(fakeClient({ writeError, row: expenseRow(expense) }))).toEqual(expense)
  expect(await createWith(fakeClient({ writeError, row: expenseRow(expense) }), 'f2')).toMatchObject({ status: 409, code: 'ProjectExpenseIdempotencyConflict' })
})

test('reports a full ledger only for a valid counter at the limit', async () => {
  const writeError = cancellation(['None', 'ConditionalCheckFailed', 'None', 'None'])
  const full = { workspaceId: 'w', recordKey: 'PROJECT_EXPENSE#t#p', entryType: 'project-expense-ledger', schemaVersion: 1, teamId: 't', projectId: 'p', entryCount: 2_000 }
  expect(await createWith(fakeClient({ writeError, counter: full }))).toMatchObject({ status: 413, code: 'ProjectExpensesFull' })
  expect(await createWith(fakeClient({ writeError, counter: { ...full, projectId: 'other' } }))).toMatchObject({ status: 502 })
})

test('deletes the expense and lowers the counter, refusing an approved expense at commit', async () => {
  const sent: SentCommand[] = []
  await new DynamoDbProjectExpenseStore('planning', fakeClient({ sent }), 'audit').delete({
    ...scope,
    now: expense.updatedAt,
    callerAuthorization,
    auditContext,
    deleteReceipt: 'r1',
    previous: expense,
  })
  expect(sent[0]?.input).toMatchObject({
    TransactItems: [
      {
        Delete: {
          Key: { workspaceId: 'w', recordKey: 'PROJECT_EXPENSE#t#p#ENTRY#x1' },
          ExpressionAttributeValues: { ':revision': 1, ':approved': 'approved' },
        },
      },
      { Update: { Key: { recordKey: 'PROJECT_EXPENSE#t#p' }, UpdateExpression: 'SET #count = #count - :one' } },
      // The removal leaves its receipt outside the list prefix, so a retry can find it.
      { Put: { Item: { recordKey: 'PROJECT_EXPENSE#t#p#DELETED#x1', entryType: 'project-expense-deletion', deleteReceipt: 'r1' } } },
      callerAuthorization[0],
      { Put: { TableName: 'audit' } },
    ],
  })
})

test('recognizes only the request that removed the expense', async () => {
  const deletion = { workspaceId: 'w', recordKey: 'PROJECT_EXPENSE#t#p#DELETED#x1', entryType: 'project-expense-deletion', deleteReceipt: 'r1' }
  const client = {
    async send(command: SentCommand) {
      const key = command.input.Key
      const recordKey = typeof key === 'object' && key !== null && 'recordKey' in key ? key.recordKey : undefined
      return { Item: recordKey === deletion.recordKey ? deletion : undefined }
    },
  }
  const store = new DynamoDbProjectExpenseStore('planning', Object.assign(Object.create(null), client))
  expect(await store.wasDeletedBy(scope, 'x1', 'r1')).toBe(true)
  expect(await store.wasDeletedBy(scope, 'x1', 'other')).toBe(false)
  expect(await store.wasDeletedBy(scope, 'x2', 'r1')).toBe(false)
})

test('lists the expenses of every query page', async () => {
  const sent: SentCommand[] = []
  const store = new DynamoDbProjectExpenseStore('planning', fakeClient({
    pages: [[expenseRow(expense)], [expenseRow({ ...expense, id: 'x2' })]],
    sent,
  }))
  expect((await store.list(scope)).map((stored) => stored.id)).toEqual(['x1', 'x2'])
  expect(sent.map((command) => command.input.ExclusiveStartKey)).toEqual([undefined, { page: 1 }])
})

test('rejects a stored row of another Project as corrupt', async () => {
  const store = new DynamoDbProjectExpenseStore('planning', fakeClient({ items: [expenseRow({ ...expense, projectId: 'other' })] }))
  expect(await store.list(scope).then(() => undefined, (error: unknown) => error)).toMatchObject({ status: 502, code: 'ProjectExpenseCorruptState' })
})
