import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import {
  WorkCalendarAuthorizationChangedError,
  WorkCalendarRevisionConflictError,
  type WorkCalendarWrite,
} from '../../domain/work-calendars'
import { DynamoDbWorkCalendarStore } from './work-calendar-store'

/** A command the fake client received. */
type SentCommand = {
  /** Command input. */
  input: Record<string, unknown>
}

/** Team calendar save of every test. */
const write: WorkCalendarWrite = {
  scope: { kind: 'team', teamId: 'core-team' },
  overrides: { additionalHolidays: ['2026-12-09'] },
  changeAdjustment: 'keep-duration',
}

/** Fence on the saving member's authorization. */
const fence = {
  ConditionCheck: {
    TableName: 'access',
    Key: { recordKey: 'MEMBER#a' },
    ConditionExpression: 'version = :v',
    ExpressionAttributeValues: { ':v': 1 },
  },
}

/**
 * Builds a document client that records commands and answers with the given error, if any.
 *
 * @param sent - Receives every command.
 * @param failure - Error every command raises.
 * @returns The fake client.
 */
function fakeClient(sent: SentCommand[], failure?: Error): DynamoDBDocumentClient {
  const client = {
    async send(command: SentCommand) {
      sent.push(command)
      if (failure) throw failure
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

test('saves the calendar in one transaction with the authorization fences', async () => {
  const sent: SentCommand[] = []
  const store = new DynamoDbWorkCalendarStore('tenant', fakeClient(sent))
  const saved = await store.save('w', write, 0, 'user#a@example.com', '2026-11-23T00:00:00.000Z', [fence])
  expect(saved).toMatchObject({ revision: 1, updatedBy: 'user#a@example.com' })
  const items = sent[0]?.input.TransactItems
  expect(Array.isArray(items) ? items.length : 0).toBe(2)
  // The fence goes into the transaction whole, with its condition and values.
  expect(Array.isArray(items) ? items[1] : undefined).toEqual(fence)
})

test('tells a revision conflict apart from a changed authorization', async () => {
  const conflict = new DynamoDbWorkCalendarStore('tenant', fakeClient([], cancellation(['ConditionalCheckFailed', 'None'])))
  await expect(conflict.save('w', write, 1, 'user#a@example.com', '2026-11-23T00:00:00.000Z', [fence]))
    .rejects.toBeInstanceOf(WorkCalendarRevisionConflictError)
  const revoked = new DynamoDbWorkCalendarStore('tenant', fakeClient([], cancellation(['None', 'ConditionalCheckFailed'])))
  await expect(revoked.save('w', write, 1, 'user#a@example.com', '2026-11-23T00:00:00.000Z', [fence]))
    .rejects.toBeInstanceOf(WorkCalendarAuthorizationChangedError)
})
