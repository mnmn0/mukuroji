import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { DynamoDbProjectScheduleBaselineStore, type CaptureProjectScheduleBaselineInput } from './schedule-baseline-store'

/** Audit context of the captures. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'manager', kind: 'user', displayName: 'Manager' },
  idempotencyKey: 'key',
  request: { method: 'POST', path: '/x', body: {} },
  source: { kind: 'api' },
})

/** Caller fence included in every capture. */
const callerAuthorization = [{ ConditionCheck: { TableName: 'access', Key: { k: 'v' }, ConditionExpression: 'attribute_exists(k)' } }]

/**
 * Builds a capture input.
 *
 * @param overrides - Fields that differ from the first capture of an empty Project.
 * @returns The input.
 */
function captureInput(overrides: Partial<CaptureProjectScheduleBaselineInput> = {}): CaptureProjectScheduleBaselineInput {
  return {
    workspaceId: 'w',
    teamId: 't',
    projectId: 'p',
    entries: [],
    capturedAt: '2026-11-19T00:00:00.000Z',
    expectedRevision: 0,
    previous: null,
    callerAuthorization,
    auditContext,
    ...overrides,
  }
}

/**
 * Builds a document client whose reads find nothing and whose writes throw the given error.
 *
 * @param writeError - Error the transaction throws.
 * @returns The fake client.
 */
function fakeClient(writeError: unknown): DynamoDBDocumentClient {
  const client = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') return {}
      throw writeError
    },
  }
  return Object.assign(Object.create(null), client)
}

/**
 * Captures a baseline against a client that fails the write.
 *
 * @param writeError - Error the transaction throws.
 * @returns The rejection.
 */
async function captureWith(writeError: unknown) {
  const store = new DynamoDbProjectScheduleBaselineStore('planning', fakeClient(writeError))
  return store.capture(captureInput()).then(() => undefined, (error: unknown) => error)
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

test('reports failed conditions as a conflict', async () => {
  expect(await captureWith(cancellation(['None', 'ConditionalCheckFailed']))).toMatchObject({ status: 409 })
})

test('reports throttled cancellations as retryable instead of a conflict', async () => {
  expect(await captureWith(cancellation(['ThrottlingError', 'None']))).toMatchObject({ status: 503 })
})

test('reports other cancellations as a storage failure', async () => {
  expect(await captureWith(cancellation(['ValidationError', 'None']))).toMatchObject({ status: 502 })
})

test('rejects a stored row whose capture time or dates are not real', async () => {
  const row = {
    workspaceId: 'w',
    recordKey: 'PROJECT_SCHEDULE_BASELINE#t#p',
    entryType: 'project-schedule-baseline',
    schemaVersion: 1,
    revision: 1,
    capturedAt: '2026-11-19T00:00:00.000Z',
    entries: [{ workItemId: 'a', endDate: '2026-12-05' }],
  }
  /**
   * Reads a store whose only row is the given item.
   *
   * @param item - Stored row.
   * @returns The read result or the rejection.
   */
  const readRow = async (item: Record<string, unknown>) => {
    const client = Object.assign(Object.create(null), { async send() { return { Item: item } } })
    return new DynamoDbProjectScheduleBaselineStore('planning', client)
      .get('w', 't', 'p')
      .catch((error: unknown) => error)
  }
  expect(await readRow(row)).toMatchObject({ revision: 1 })
  expect(await readRow({ ...row, capturedAt: 'broken' })).toMatchObject({ status: 502 })
  expect(await readRow({ ...row, entries: [{ workItemId: 'a', endDate: '2026-02-30' }] })).toMatchObject({ status: 502 })
})

test('writes the baseline, the caller fence, and the audit event in one transaction', async () => {
  const sent: { constructor: { name: string }, input: { TransactItems?: unknown[] } }[] = []
  const client = Object.assign(Object.create(null), {
    async send(command: { constructor: { name: string }, input: { TransactItems?: unknown[] } }) {
      sent.push(command)
      return {}
    },
  })
  const store = new DynamoDbProjectScheduleBaselineStore('planning', client, 'audit')
  await store.capture(captureInput({ entries: [{ workItemId: 'secret-item', endDate: '2026-12-05' }] }))
  await store.capture(captureInput({
    capturedAt: '2026-11-20T00:00:00.000Z',
    expectedRevision: 1,
    previous: { revision: 1, capturedAt: '2026-11-19T00:00:00.000Z', entryCount: 1 },
    entries: [],
  }))
  const [first, second] = sent.map((command) => command.input.TransactItems ?? [])
  expect(first).toHaveLength(3)
  expect(first?.[2]).toMatchObject({ Put: { TableName: 'audit', Item: { eventType: 'project.schedule_baseline_captured' } } })
  // The audit event counts the Work Items without naming them or their dates.
  expect(JSON.stringify(first?.[2])).not.toContain('secret-item')
  expect(JSON.stringify(first?.[2])).not.toContain('2026-12-05')
  expect(second?.[2]).toMatchObject({
    Put: { Item: { eventType: 'project.schedule_baseline_replaced', entity: { type: 'project', id: 'p' } } },
  })
  expect(JSON.stringify(second?.[2])).toContain('"entryCount"')
})

test('counts the audit event when it maps a cancelled transaction', async () => {
  const store = new DynamoDbProjectScheduleBaselineStore('planning', fakeClient(cancellation(['None', 'None', 'ConditionalCheckFailed'])), 'audit')
  expect(await store.capture(captureInput()).catch((error: unknown) => error)).toMatchObject({ status: 409 })
})
