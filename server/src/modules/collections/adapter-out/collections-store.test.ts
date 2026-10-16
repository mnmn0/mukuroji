import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { COLLECTION_LIMIT } from '@mukuroji/contracts'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import type { StoredCollection } from '../domain/collections'
import { DynamoDbCollectionsStore } from './collections-store'

/**
 * Isolates AWS calls at the SDK command boundary.
 *
 * @param send - Fake transport.
 * @returns Document client that uses the fake transport.
 */
function clientFor(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  // Replacing the overloaded SDK transport is the only cast; every command is validated below.
  client.send = send as DynamoDBDocumentClient['send']
  return client
}

const checks: PlanningCallerAuthorizationConditionCheck[] = [{
  ConditionCheck: {
    TableName: 'members',
    Key: { workspaceId: 'w', recordKey: 'MEMBER#reader' },
    ConditionExpression: '#v = :v',
    ExpressionAttributeNames: { '#v': 'version' },
    ExpressionAttributeValues: { ':v': 2 },
  },
}]

const collection: StoredCollection = {
  collectionId: 'c1',
  name: 'Launch',
  createdBy: 'reader',
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
  revision: 1,
  items: [{ teamId: 'core-team', issueId: 'item-1', addedAt: '2026-10-16T00:00:00.000Z', addedBy: 'reader' }],
  createFingerprint: 'f'.repeat(64),
}

test('writes require caller checks and carry a revision condition', async () => {
  const transactions: unknown[] = []
  const client = clientFor(async (command) => {
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    transactions.push(command.input.TransactItems)
    return {}
  })
  const unbound = new DynamoDbCollectionsStore('planning', client)
  await expect(unbound.put('w', collection, 0)).rejects.toMatchObject({ status: 503 })

  const store = unbound.withCallerAuthorization(checks)
  await store.put('w', collection, 0)
  await store.put('w', { ...collection, revision: 2 }, 1)
  await store.delete('w', 'c1', 2, { createFingerprint: 'f'.repeat(64), deletedRevision: 2 })
  expect(transactions).toEqual([
    [
      { Put: expect.objectContaining({ ConditionExpression: 'attribute_not_exists(recordKey)', Item: expect.objectContaining({ workspaceId: 'w', recordKey: 'COLLECTION#c1', entryType: 'work-item-collection', schemaVersion: 1 }) }) },
      { Update: expect.objectContaining({ Key: { workspaceId: 'w', recordKey: 'COLLECTION_COUNT' }, ConditionExpression: 'attribute_not_exists(recordKey) OR (#entryType = :entryType AND #count >= :zero AND #count < :limit)', ExpressionAttributeValues: expect.objectContaining({ ':delta': 1, ':limit': 200, ':zero': 0 }) }) },
      { ConditionCheck: { TableName: 'planning', Key: { workspaceId: 'w', recordKey: 'COLLECTION_DELETED#c1' }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
      ...checks,
    ],
    [
      { Put: expect.objectContaining({ ExpressionAttributeValues: { ':revision': 1, ':entryType': 'work-item-collection' } }) },
      { ConditionCheck: { TableName: 'planning', Key: { workspaceId: 'w', recordKey: 'COLLECTION_DELETED#c1' }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
      ...checks,
    ],
    [
      { Delete: expect.objectContaining({ Key: { workspaceId: 'w', recordKey: 'COLLECTION#c1' }, ExpressionAttributeValues: { ':revision': 2, ':entryType': 'work-item-collection' } }) },
      { Update: expect.objectContaining({ Key: { workspaceId: 'w', recordKey: 'COLLECTION_COUNT' }, ExpressionAttributeValues: expect.objectContaining({ ':delta': -1 }) }) },
      { Put: { TableName: 'planning', Item: { workspaceId: 'w', recordKey: 'COLLECTION_DELETED#c1', entryType: 'work-item-collection-tombstone', collectionId: 'c1', createFingerprint: 'f'.repeat(64), deletedRevision: 2 }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
      ...checks,
    ],
  ])
})

test('maps a failed counter condition on creation to the limit only for a valid full counter', async () => {
  const storeWithCounter = (counter: Record<string, unknown> | undefined) => new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
    if (command instanceof GetCommand) return counter ? { Item: counter } : {}
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    })
  }), checks)
  const full = { workspaceId: 'w', recordKey: 'COLLECTION_COUNT', entryType: 'work-item-collection-count', count: 200 }
  await expect(storeWithCounter(full).put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionLimitReached' })
  // A concurrent delete freed a slot after the failed write: retry, not corruption.
  await expect(storeWithCounter({ ...full, count: 199 }).put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionConflict' })
  // A negative or foreign counter row is corrupt state, not a full Workspace.
  for (const counter of [{ ...full, count: -1 }, { ...full, entryType: 'other' }, undefined]) {
    await expect(storeWithCounter(counter).put('w', collection, 0)).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  }
})

test('reports a creation blocked by a deletion marker as a conflict and reads the marker', async () => {
  const marker = {
    workspaceId: 'w',
    recordKey: 'COLLECTION_DELETED#c1',
    entryType: 'work-item-collection-tombstone',
    collectionId: 'c1',
    createFingerprint: 'f'.repeat(64),
    deletedRevision: 2,
  }
  const store = new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.recordKey === 'COLLECTION_DELETED#c1' ? { Item: marker } : {}
    }
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    })
  }), checks)
  await expect(store.put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionConflict' })
  expect(await store.readDeletion('w', 'c1')).toEqual({ createFingerprint: 'f'.repeat(64), deletedRevision: 2 })
  expect(await store.readDeletion('w', 'c2')).toBeUndefined()
})

test('fails closed on a malformed deletion marker instead of accepting it', async () => {
  const valid = {
    workspaceId: 'w',
    recordKey: 'COLLECTION_DELETED#c1',
    entryType: 'work-item-collection-tombstone',
    collectionId: 'c1',
    createFingerprint: 'f'.repeat(64),
    deletedRevision: 2,
  }
  for (const item of [
    { recordKey: 'COLLECTION_DELETED#c1' },
    { ...valid, workspaceId: 'other' },
    { ...valid, entryType: 'work-item-collection' },
    { ...valid, collectionId: 'c2' },
    { ...valid, createFingerprint: 'not-a-digest' },
    { ...valid, deletedRevision: 0 },
    { ...valid, deletedRevision: undefined },
  ]) {
    const store = new DynamoDbCollectionsStore('planning', clientFor(async () => ({ Item: item })), checks)
    await expect(store.readDeletion('w', 'c1')).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  }
})

test('requires an existing positive counter before a deletion decrements it', async () => {
  const transactions: unknown[] = []
  const store = new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
    if (command instanceof TransactWriteCommand) transactions.push(command.input.TransactItems)
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    })
  }), checks)
  await expect(store.delete('w', 'c1', 1, { createFingerprint: 'f'.repeat(64), deletedRevision: 2 }))
    .rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  expect(transactions).toEqual([[
    expect.anything(),
    { Update: expect.objectContaining({ ConditionExpression: '#count > :zero AND #entryType = :entryType' }) },
    expect.anything(),
    ...checks,
  ]])
})

test('fails closed when a live Collection row also has a deletion marker', async () => {
  const failing = (reasons: string[]) => new DynamoDbCollectionsStore('planning', clientFor(async () => {
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: reasons.map((Code) => ({ Code })),
    })
  }), checks)
  // Update: the marker check (item 1) fails while the revision held.
  await expect(failing(['None', 'ConditionalCheckFailed', 'None']).put('w', { ...collection, revision: 2 }, 1))
    .rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  // Delete: the marker write (item 2) finds an existing marker.
  await expect(failing(['None', 'None', 'ConditionalCheckFailed', 'None']).delete('w', 'c1', 1, { createFingerprint: 'f'.repeat(64), deletedRevision: 2 }))
    .rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
})

test('maps a failed caller authorization check to 403 instead of a conflict', async () => {
  const store = new DynamoDbCollectionsStore('planning', clientFor(async () => {
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    })
  }), checks)
  await expect(store.put('w', collection, 1)).rejects.toMatchObject({ status: 403, code: 'CollectionAuthorizationChanged' })
})

test('maps a failed condition to a conflict', async () => {
  const store = new DynamoDbCollectionsStore('planning', clientFor(async () => {
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    })
  }), checks)
  await expect(store.put('w', collection, 1)).rejects.toMatchObject({ status: 409, code: 'CollectionConflict' })
})

test('reads only the Workspace partition, pages through results, and rejects corrupt rows', async () => {
  const row = { ...collection, workspaceId: 'w', recordKey: 'COLLECTION#c1', entryType: 'work-item-collection', schemaVersion: 1 }
  let pages = 0
  const store = new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
    if (command instanceof QueryCommand) {
      expect(command.input.ExpressionAttributeValues).toEqual({ ':workspaceId': 'w', ':prefix': 'COLLECTION#' })
      expect(command.input.ConsistentRead).toBe(true)
      pages += 1
      return pages === 1
        ? { Items: [row], LastEvaluatedKey: { workspaceId: 'w', recordKey: 'COLLECTION#c1' } }
        : { Items: [{ ...row, collectionId: 'c2', recordKey: 'COLLECTION#c2' }] }
    }
    if (command instanceof GetCommand) {
      return command.input.Key?.recordKey === 'COLLECTION#c1'
        ? { Item: { ...row, recordKey: 'COLLECTION#other' } }
        : {}
    }
    throw new Error('Unexpected command')
  }))
  expect((await store.list('w')).map((stored) => stored.collectionId)).toEqual(['c1', 'c2'])
  expect(await store.get('w', 'missing')).toBeUndefined()
  await expect(store.get('w', 'c1')).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
})

test('fails closed when the partition holds more Collections than the Workspace limit', async () => {
  const rows = Array.from({ length: COLLECTION_LIMIT + 1 }, (_, index) => ({
    ...collection,
    collectionId: `c${index}`,
    workspaceId: 'w',
    recordKey: `COLLECTION#c${index}`,
    entryType: 'work-item-collection',
    schemaVersion: 1,
  }))
  const store = new DynamoDbCollectionsStore('planning', clientFor(async () => ({ Items: rows })))
  await expect(store.list('w')).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
})
