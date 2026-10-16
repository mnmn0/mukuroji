import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
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
  await store.delete('w', 'c1', 2)
  expect(transactions).toEqual([
    [
      { Put: expect.objectContaining({ ConditionExpression: 'attribute_not_exists(recordKey)', Item: expect.objectContaining({ workspaceId: 'w', recordKey: 'COLLECTION#c1', entryType: 'work-item-collection', schemaVersion: 1 }) }) },
      { Update: expect.objectContaining({ Key: { workspaceId: 'w', recordKey: 'COLLECTION_COUNT' }, ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit', ExpressionAttributeValues: expect.objectContaining({ ':delta': 1, ':limit': 200 }) }) },
      { ConditionCheck: { TableName: 'planning', Key: { workspaceId: 'w', recordKey: 'COLLECTION_DELETED#c1' }, ConditionExpression: 'attribute_not_exists(recordKey)' } },
      ...checks,
    ],
    [
      { Put: expect.objectContaining({ ExpressionAttributeValues: { ':revision': 1, ':entryType': 'work-item-collection' } }) },
      ...checks,
    ],
    [
      { Delete: expect.objectContaining({ Key: { workspaceId: 'w', recordKey: 'COLLECTION#c1' }, ExpressionAttributeValues: { ':revision': 2, ':entryType': 'work-item-collection' } }) },
      { Update: expect.objectContaining({ Key: { workspaceId: 'w', recordKey: 'COLLECTION_COUNT' }, ExpressionAttributeValues: expect.objectContaining({ ':delta': -1 }) }) },
      { Put: { TableName: 'planning', Item: { workspaceId: 'w', recordKey: 'COLLECTION_DELETED#c1', entryType: 'work-item-collection-tombstone', collectionId: 'c1' } } },
      ...checks,
    ],
  ])
})

test('maps a failed counter condition on creation to the Workspace limit', async () => {
  const store = new DynamoDbCollectionsStore('planning', clientFor(async () => {
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    })
  }), checks)
  await expect(store.put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionLimitReached' })
})

test('reports a creation blocked by a deletion marker as a conflict and reads the marker', async () => {
  const store = new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.recordKey === 'COLLECTION_DELETED#c1' ? { Item: { recordKey: 'COLLECTION_DELETED#c1' } } : {}
    }
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    })
  }), checks)
  await expect(store.put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionConflict' })
  expect(await store.wasDeleted('w', 'c1')).toBe(true)
  expect(await store.wasDeleted('w', 'c2')).toBe(false)
})

test('maps a failed caller authorization check to 403 instead of a conflict', async () => {
  const store = new DynamoDbCollectionsStore('planning', clientFor(async () => {
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    })
  }), checks)
  await expect(store.put('w', collection, 1)).rejects.toMatchObject({ status: 403, code: 'CollectionAuthorizationChanged' })
})

test('maps a failed condition to a conflict', async () => {
  const store = new DynamoDbCollectionsStore('planning', clientFor(async () => {
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
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
