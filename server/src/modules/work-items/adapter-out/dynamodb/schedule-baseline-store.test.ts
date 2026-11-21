import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { DynamoDbProjectScheduleBaselineStore, type WriteProjectScheduleBaselineInput } from './schedule-baseline-store'

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
 * @param entries - Entries of the captured baseline.
 * @returns The input.
 */
function captureInput(
  overrides: Partial<WriteProjectScheduleBaselineInput> = {},
  entries: WriteProjectScheduleBaselineInput['baseline']['entries'] = [],
): WriteProjectScheduleBaselineInput {
  const capturedAt = overrides.writtenAt ?? '2026-11-19T00:00:00.000Z'
  const baseline = { revision: (overrides.expectedRevision ?? 0) + 1, id: 'b1', capturedAt, entries }
  return {
    workspaceId: 'w',
    teamId: 't',
    projectId: 'p',
    kind: 'capture',
    writtenAt: capturedAt,
    baseline,
    expectedRevision: 0,
    savedBaselines: [{ id: 'b1', capturedAt, entryCount: entries.length }],
    savedRowsToPut: [baseline],
    savedIdsToDelete: [],
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
  return store.write(captureInput()).then(() => undefined, (error: unknown) => error)
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
  expect(await captureWith(cancellation(['None', 'None', 'ConditionalCheckFailed']))).toMatchObject({ status: 409 })
})

test('reports throttled cancellations as retryable instead of a conflict', async () => {
  expect(await captureWith(cancellation(['ThrottlingError', 'None', 'None']))).toMatchObject({ status: 503 })
})

test('reports other cancellations as a storage failure', async () => {
  expect(await captureWith(cancellation(['ValidationError', 'None', 'None']))).toMatchObject({ status: 502 })
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
  await store.write(captureInput({}, [{ workItemId: 'secret-item', endDate: '2026-12-05' }]))
  await store.write({
    ...captureInput({
      writtenAt: '2026-11-20T00:00:00.000Z',
      expectedRevision: 1,
      previous: { baselineId: 'b1', revision: 1, capturedAt: '2026-11-19T00:00:00.000Z', entryCount: 1 },
    }),
    savedIdsToDelete: ['old'],
  })
  const [first, second] = sent.map((command) => command.input.TransactItems ?? [])
  // Active row, saved row, caller fence, audit event.
  expect(first).toHaveLength(4)
  expect(first?.[0]).toMatchObject({ Put: { Item: { recordKey: 'PROJECT_SCHEDULE_BASELINE#t#p', id: 'b1' } } })
  expect(first?.[1]).toMatchObject({
    Put: {
      Item: { recordKey: 'PROJECT_SCHEDULE_BASELINE_SAVED#t#p#b1', entryType: 'project-schedule-baseline-saved' },
      ConditionExpression: 'attribute_not_exists(recordKey)',
    },
  })
  expect(first?.[3]).toMatchObject({ Put: { TableName: 'audit', Item: { eventType: 'project.schedule_baseline_captured' } } })
  // The audit event counts the Work Items without naming them or their dates.
  expect(JSON.stringify(first?.[3])).not.toContain('secret-item')
  expect(JSON.stringify(first?.[3])).not.toContain('2026-12-05')
  expect(second?.[2]).toMatchObject({ Delete: { Key: { recordKey: 'PROJECT_SCHEDULE_BASELINE_SAVED#t#p#old' } } })
  expect(second?.[4]).toMatchObject({
    Put: { Item: { eventType: 'project.schedule_baseline_replaced', entity: { type: 'project', id: 'p' } } },
  })
  expect(JSON.stringify(second?.[4])).toContain('"entryCount"')
})

test('records a switch to a saved baseline as its own audit event', async () => {
  const sent: { input: { TransactItems?: unknown[] } }[] = []
  const client = Object.assign(Object.create(null), {
    async send(command: { input: { TransactItems?: unknown[] } }) {
      sent.push(command)
      return {}
    },
  })
  const store = new DynamoDbProjectScheduleBaselineStore('planning', client, 'audit')
  await store.write({
    ...captureInput({
      kind: 'activate',
      expectedRevision: 2,
      previous: { baselineId: 'b2', revision: 2, capturedAt: '2026-11-19T00:00:00.000Z', entryCount: 0 },
    }),
    savedRowsToPut: [],
  })
  const items = sent[0]?.input.TransactItems ?? []
  expect(items).toHaveLength(3)
  expect(items[0]).toMatchObject({ Put: { Item: { revision: 3, id: 'b1' }, ExpressionAttributeValues: { ':revision': 2 } } })
  expect(items[2]).toMatchObject({ Put: { Item: { eventType: 'project.schedule_baseline_activated' } } })
})

test('rejects a stored saved list or saved row that is malformed', async () => {
  const active = {
    workspaceId: 'w',
    recordKey: 'PROJECT_SCHEDULE_BASELINE#t#p',
    entryType: 'project-schedule-baseline',
    schemaVersion: 1,
    revision: 1,
    id: 'b1',
    capturedAt: '2026-11-19T00:00:00.000Z',
    entries: [],
    savedBaselines: [{ id: 'b1', capturedAt: '2026-11-19T00:00:00.000Z', entryCount: 0 }],
  }
  /**
   * Builds a store whose reads return the given item.
   *
   * @param item - Stored row.
   * @returns The store.
   */
  const storeWith = (item: Record<string, unknown>) =>
    new DynamoDbProjectScheduleBaselineStore('planning', Object.assign(Object.create(null), { async send() { return { Item: item } } }))
  expect(await storeWith(active).get('w', 't', 'p')).toMatchObject({ id: 'b1', savedBaselines: [{ id: 'b1' }] })
  expect(await storeWith({ ...active, savedBaselines: [{ id: 'b1' }] }).get('w', 't', 'p').catch((error: unknown) => error))
    .toMatchObject({ status: 502 })
  const saved = {
    ...active,
    recordKey: 'PROJECT_SCHEDULE_BASELINE_SAVED#t#p#b1',
    entryType: 'project-schedule-baseline-saved',
    savedBaselines: undefined,
  }
  expect(await storeWith(saved).getSaved('w', 't', 'p', 'b1')).toMatchObject({ id: 'b1' })
  expect(await storeWith({ ...saved, id: 'b2' }).getSaved('w', 't', 'p', 'b1').catch((error: unknown) => error))
    .toMatchObject({ status: 502 })
})

test('counts the audit event when it maps a cancelled transaction', async () => {
  const store = new DynamoDbProjectScheduleBaselineStore('planning', fakeClient(cancellation(['None', 'None', 'None', 'ConditionalCheckFailed'])), 'audit')
  expect(await store.write(captureInput()).catch((error: unknown) => error)).toMatchObject({ status: 409 })
})
