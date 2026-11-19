import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import { DynamoDbProjectScheduleBaselineStore } from './schedule-baseline-store'

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
  return store.capture({
    workspaceId: 'w',
    teamId: 't',
    projectId: 'p',
    entries: [],
    capturedAt: '2026-11-19T00:00:00.000Z',
    callerAuthorization: [{ ConditionCheck: { TableName: 'access', Key: { k: 'v' }, ConditionExpression: 'attribute_exists(k)' } }],
  }).then(() => undefined, (error: unknown) => error)
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
