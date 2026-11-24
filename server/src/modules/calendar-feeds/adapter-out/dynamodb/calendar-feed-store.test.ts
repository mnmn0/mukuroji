import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import type { CalendarFeedRecord } from '../../application/calendar-feed-use-cases'
import { DynamoDbCalendarFeedStore } from './calendar-feed-store'

/** Command the fake client received. */
type SentCommand = {
  /** Command class name. */
  name: string
  /** Command input. */
  input: Record<string, unknown>
}

/** Feed written by the tests. */
const record: CalendarFeedRecord = {
  id: 'feed-1',
  kind: 'project',
  teamId: 'core team',
  projectId: 'refero',
  locale: 'ja',
  issuedAt: '2026-11-24T00:00:00.000Z',
  createdAt: '2026-11-20T00:00:00.000Z',
  memberKey: 'demo@example.com',
  tokenHash: 'new-hash',
}

/** Stored feed row of {@link record}. */
const feedRow = {
  workspaceId: 'w',
  recordKey: 'CALENDAR_FEED#demo%40example.com#PROJECT#core%20team#refero',
  entryType: 'calendar-feed',
  schemaVersion: 1,
  feedId: 'feed-1',
  kind: 'project',
  memberKey: 'demo@example.com',
  teamId: 'core team',
  projectId: 'refero',
  locale: 'ja',
  tokenHash: 'new-hash',
  issuedAt: record.issuedAt,
  createdAt: record.createdAt,
}

/** Audit context of the writes. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'u', kind: 'user', displayName: 'U' },
  idempotencyKey: 'key',
  request: { method: 'POST', path: '/api/me/calendar-feeds', body: {} },
  source: { kind: 'api' },
})

/**
 * Builds a document client that answers reads from a row map and fails writes when asked.
 *
 * @param rows - Rows keyed by record key.
 * @param sent - List collecting every command.
 * @param writeError - Error thrown by writes.
 * @returns The fake client.
 */
function fakeClient(rows: Record<string, Record<string, unknown>>, sent: SentCommand[], writeError?: unknown) {
  /** Fake `send`. */
  const send = async (command: { constructor: { name: string }, input: Record<string, unknown> }) => {
    sent.push({ name: command.constructor.name, input: command.input })
    if (command.constructor.name === 'GetCommand') {
      const key = command.input.Key
      const recordKey = typeof key === 'object' && key !== null && 'recordKey' in key ? String(key.recordKey) : ''
      return { Item: rows[recordKey] }
    }
    if (command.constructor.name === 'QueryCommand') {
      const values = command.input.ExpressionAttributeValues
      const prefix = typeof values === 'object' && values !== null && ':prefix' in values ? String(values[':prefix']) : ''
      return { Items: Object.entries(rows).filter(([key]) => key.startsWith(prefix)).map(([, row]) => row) }
    }
    if (writeError) throw writeError
    return {}
  }
  const client: Pick<DynamoDBDocumentClient, 'send'> = { send: send as DynamoDBDocumentClient['send'] }
  return client as DynamoDBDocumentClient
}

test('replaces a token by deleting the old lookup row in the same transaction', async () => {
  const sent: SentCommand[] = []
  const store = new DynamoDbCalendarFeedStore('Planning', fakeClient({}, sent), 'Audit')
  await store.save({ workspaceId: 'w', record, previousTokenHash: 'old-hash', auditContext, now: record.issuedAt })
  const items = sent[0]?.input.TransactItems
  if (!Array.isArray(items)) throw new Error('Expected a transaction.')
  expect(items).toMatchObject([
    { Put: { Item: { recordKey: feedRow.recordKey, tokenHash: 'new-hash' }, ConditionExpression: '#tokenHash = :previousTokenHash', ExpressionAttributeValues: { ':previousTokenHash': 'old-hash' } } },
    { Put: { Item: { recordKey: 'CALENDAR_FEED_TOKEN#new-hash', feedRecordKey: feedRow.recordKey }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
    { Delete: { Key: { workspaceId: 'w', recordKey: 'CALENDAR_FEED_TOKEN#old-hash' } } },
    { Put: { TableName: 'Audit' } },
  ])
  expect(JSON.stringify(items?.at(-1))).not.toContain('new-hash')
})

test('maps a failed condition to a conflict', async () => {
  const error = Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
  })
  const store = new DynamoDbCalendarFeedStore('Planning', fakeClient({}, [], error))
  expect(store.remove({ workspaceId: 'w', record, now: record.issuedAt })).rejects.toMatchObject({ status: 409 })
})

test('finds a feed by its current token only', async () => {
  const rows = {
    [feedRow.recordKey]: feedRow,
    'CALENDAR_FEED_TOKEN#new-hash': { workspaceId: 'w', recordKey: 'CALENDAR_FEED_TOKEN#new-hash', entryType: 'calendar-feed-token', schemaVersion: 1, feedRecordKey: feedRow.recordKey },
    'CALENDAR_FEED_TOKEN#stale-hash': { workspaceId: 'w', recordKey: 'CALENDAR_FEED_TOKEN#stale-hash', entryType: 'calendar-feed-token', schemaVersion: 1, feedRecordKey: feedRow.recordKey },
  }
  const store = new DynamoDbCalendarFeedStore('Planning', fakeClient(rows, []))
  expect(await store.findByTokenHash('w', 'new-hash')).toEqual(record)
  expect(await store.findByTokenHash('w', 'stale-hash')).toBeNull()
  expect(await store.findByTokenHash('w', 'missing')).toBeNull()
  expect(await store.list({ workspaceId: 'w', memberKey: 'demo@example.com' })).toEqual([record])
})
