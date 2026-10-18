import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { COLLECTION_LIMIT } from '@mukuroji/contracts'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import type { StoredCollection } from '../domain/collections'
import { DynamoDbCollectionsStore } from './collections-store'

/**
 * Isolates AWS calls at the SDK command boundary.
 *
 * Deletion-marker batch reads find no markers unless the fake transport answers them itself.
 *
 * @param send - Fake transport.
 * @param handlesBatchGet - Whether `send` answers deletion-marker batch reads.
 * @returns Document client that uses the fake transport.
 */
function clientFor(send: (command: unknown) => Promise<unknown>, handlesBatchGet = false): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  /**
   * Answers marker reads with no markers and forwards every other command.
   *
   * @param command - SDK command.
   * @returns The fake response.
   */
  const transport = async (command: unknown) =>
    command instanceof BatchGetCommand && !handlesBatchGet ? { Responses: {} } : await send(command)
  // Replacing the overloaded SDK transport is the only cast; every command is validated below.
  client.send = transport as DynamoDBDocumentClient['send']
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

/** Valid counter row for an empty Workspace. */
const validCounter = { workspaceId: 'w', recordKey: 'COLLECTION_COUNT', entryType: 'work-item-collection-count', count: 0 }

test('writes require caller checks and carry a revision condition', async () => {
  const transactions: unknown[] = []
  const client = clientFor(async (command) => {
    // The creation verifies the counter against the live rows before writing.
    if (command instanceof GetCommand) {
      return command.input.Key?.recordKey === 'COLLECTION_COUNT' ? { Item: { ...validCounter, count: 2 } } : {}
    }
    if (command instanceof QueryCommand) return { Items: [storedRow(7), storedRow(8)] }
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
      { Update: expect.objectContaining({ Key: { workspaceId: 'w', recordKey: 'COLLECTION_COUNT' }, ConditionExpression: '#entryType = :entryType AND #count = :verified AND #count < :limit AND attribute_not_exists(#generation)', UpdateExpression: 'ADD #count :delta, #generation :one SET #entryType = :entryType', ExpressionAttributeValues: { ':delta': 1, ':one': 1, ':entryType': 'work-item-collection-count', ':verified': 2, ':limit': 200 } }) },
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
    if (command instanceof QueryCommand) {
      const count = typeof counter?.count === 'number' ? Math.max(counter.count, 0) : 0
      return { Items: Array.from({ length: count }, (_, index) => storedRow(index)) }
    }
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    })
  }), checks)
  const full = { workspaceId: 'w', recordKey: 'COLLECTION_COUNT', entryType: 'work-item-collection-count', count: 200 }
  await expect(storeWithCounter(full).put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionLimitReached' })
  // A concurrent delete freed a slot after the failed write: retry, not corruption.
  await expect(storeWithCounter({ ...full, count: 199 }).put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionConflict' })
  // A negative or foreign counter row, or one with a generation this store never writes, is
  // corrupt state, not a full Workspace.
  for (const counter of [{ ...full, count: -1 }, { ...full, entryType: 'other' }, { ...full, generation: 0 }, { ...full, generation: 1.5 }, { ...full, generation: Number.MAX_SAFE_INTEGER + 1 }]) {
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
      if (command.input.Key?.recordKey === 'COLLECTION_COUNT') return { Item: validCounter }
      return command.input.Key?.recordKey === 'COLLECTION_DELETED#c1' ? { Item: marker } : {}
    }
    if (command instanceof QueryCommand) return { Items: [] }
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
    { Update: expect.objectContaining({ ConditionExpression: '#count > :zero AND #entryType = :entryType AND (attribute_not_exists(#generation) OR #generation < :generationLimit)', ExpressionAttributeValues: expect.objectContaining({ ':generationLimit': Number.MAX_SAFE_INTEGER }) }) },
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
      // Listing projects the metadata only; inline references are never read.
      const projected = (command.input.ProjectionExpression ?? '').split(', ')
        .map((name) => command.input.ExpressionAttributeNames?.[name])
      expect(projected).toEqual(['workspaceId', 'recordKey', 'entryType', 'schemaVersion', 'collectionId', 'name', 'description', 'createdBy', 'createdAt', 'updatedAt', 'revision'])
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
  expect(await store.listSummaries('w')).toEqual([
    { collectionId: 'c1', name: 'Launch', createdBy: 'reader', createdAt: collection.createdAt, updatedAt: collection.updatedAt, revision: 1 },
    { collectionId: 'c2', name: 'Launch', createdBy: 'reader', createdAt: collection.createdAt, updatedAt: collection.updatedAt, revision: 1 },
  ])
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
  await expect(store.listSummaries('w')).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  // A listed row with invalid metadata is corrupt even though its references are not read.
  const invalid = new DynamoDbCollectionsStore('planning', clientFor(async () => ({ Items: [{ ...rows[0], name: ' padded ' }] })))
  await expect(invalid.listSummaries('w')).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
})

/**
 * Builds a valid stored Collection row.
 *
 * @param index - Distinguishes the Collection.
 * @returns Persisted row with storage attributes.
 */
function storedRow(index: number): Record<string, unknown> {
  return { ...collection, collectionId: `c${index}`, workspaceId: 'w', recordKey: `COLLECTION#c${index}`, entryType: 'work-item-collection', schemaVersion: 1 }
}

/**
 * Store whose counter row is missing while the partition holds live Collection rows.
 *
 * @param liveRows - Number of live Collection rows the recount finds, or the rows themselves.
 * @returns The store and the commands it received.
 */
function storeWithMissingCounter(liveRows: number | Record<string, unknown>[]) {
  const commands: unknown[] = []
  let counter: Record<string, unknown> | undefined
  const store = new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
    commands.push(command)
    if (command instanceof GetCommand) return counter ? { Item: counter } : {}
    if (command instanceof QueryCommand) {
      return { Items: typeof liveRows === 'number' ? Array.from({ length: liveRows }, (_, index) => storedRow(index)) : liveRows }
    }
    if (command instanceof PutCommand) {
      counter = command.input.Item
      return {}
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    // The counter condition holds only for an existing counter below the limit.
    const count = counter?.count
    if (typeof count === 'number' && count < COLLECTION_LIMIT) return {}
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    })
  }), checks)
  return { store, commands }
}

test('rebuilds a missing counter from the live rows before creating', async () => {
  const { store, commands } = storeWithMissingCounter(3)
  await store.put('w', collection, 0)
  const initialization = commands.find((command) => command instanceof PutCommand)
  if (!(initialization instanceof PutCommand)) throw new Error('The counter was not initialized')
  expect(initialization.input).toEqual({
    TableName: 'planning',
    Item: { workspaceId: 'w', recordKey: 'COLLECTION_COUNT', entryType: 'work-item-collection-count', count: 3 },
    ConditionExpression: 'attribute_not_exists(recordKey)',
  })
  const recount = commands.find((command) => command instanceof QueryCommand)
  if (!(recount instanceof QueryCommand)) throw new Error('The live rows were not counted')
  // The recount reads the metadata a listing validates, not just keys.
  expect(recount.input.ConsistentRead).toBe(true)
  expect(Object.values(recount.input.ExpressionAttributeNames ?? {})).toEqual(expect.arrayContaining(['entryType', 'schemaVersion', 'collectionId', 'name', 'revision']))
  // The rebuilt counter is verified before the only write, so no write fails on a missing counter.
  expect(commands.filter((command) => command instanceof TransactWriteCommand)).toHaveLength(1)

  // A full partition without its counter still reports the limit instead of growing past it.
  await expect(storeWithMissingCounter(COLLECTION_LIMIT).store.put('w', collection, 0))
    .rejects.toMatchObject({ status: 409, code: 'CollectionLimitReached' })
  // More live rows than the limit cannot be repaired by a counter and fails closed.
  await expect(storeWithMissingCounter(COLLECTION_LIMIT + 1).store.put('w', collection, 0))
    .rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
})

test('fails closed without installing a counter when a counted row is malformed or foreign', async () => {
  for (const row of [
    { recordKey: 'COLLECTION#c9' },
    { ...storedRow(9), entryType: 'something-else' },
    { ...storedRow(9), schemaVersion: 2 },
    { ...storedRow(9), workspaceId: 'other' },
    { ...storedRow(9), recordKey: 'COLLECTION#c8' },
  ]) {
    const { store, commands } = storeWithMissingCounter([storedRow(1), row])
    await expect(store.put('w', collection, 0)).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
    expect(commands.some((command) => command instanceof PutCommand)).toBe(false)
    expect(commands.some((command) => command instanceof TransactWriteCommand)).toBe(false)
  }
})

test('fences a reference change on the canonical Work Item revision', async () => {
  const transactions: unknown[] = []
  const fenceCheck = {
    ConditionCheck: { TableName: 'work-items', Key: { directoryTeamId: 'w#core-team', issueId: 'item-1' }, ConditionExpression: 'revision = :expectedRevision', ExpressionAttributeValues: { ':expectedRevision': 4 } },
  }
  const fences: unknown[] = []
  let failFence = false
  const client = clientFor(async (command) => {
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    transactions.push(command.input.TransactItems)
    if (!failFence) return {}
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    })
  })
  const store = new DynamoDbCollectionsStore('planning', client, [], (workspaceId, fence) => {
    fences.push([workspaceId, fence])
    return fenceCheck
  }).withCallerAuthorization(checks)
  const fence = { teamId: 'core-team', issueId: 'item-1', revision: 4 }
  await store.put('w', { ...collection, revision: 2 }, 1, fence)
  expect(fences).toEqual([['w', fence]])
  expect(transactions).toEqual([[
    expect.objectContaining({ Put: expect.anything() }),
    { ConditionCheck: expect.objectContaining({ Key: { workspaceId: 'w', recordKey: 'COLLECTION_DELETED#c1' } }) },
    fenceCheck,
    ...checks,
  ]])
  // A deleted or changed Work Item fails only its fence: report it, not corruption or a lost grant.
  failFence = true
  await expect(store.put('w', { ...collection, revision: 2 }, 1, fence))
    .rejects.toMatchObject({ status: 409, code: 'CollectionWorkItemChanged' })
  // Without a configured fence builder, a fenced write is refused rather than left unfenced.
  await expect(new DynamoDbCollectionsStore('planning', client, checks).put('w', { ...collection, revision: 2 }, 1, fence))
    .rejects.toMatchObject({ status: 503 })
})

test('fences a reference change on the Project membership that authorized the read', async () => {
  const transactions: unknown[] = []
  const revisionCheck = { ConditionCheck: { TableName: 'work-items', Key: { directoryTeamId: 'w#core-team', issueId: 'item-1' }, ConditionExpression: 'revision = :r' } }
  const membershipCheck = { ConditionCheck: { TableName: 'directory', Key: { directoryId: 'w', entryKey: 'PROJECT_MEMBER#refero#reader' }, ConditionExpression: 'attribute_exists(directoryId)' } }
  let failMembership = false
  const client = clientFor(async (command) => {
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    transactions.push(command.input.TransactItems)
    if (!failMembership) return {}
    throw Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    })
  })
  const requested: unknown[] = []
  const store = new DynamoDbCollectionsStore('planning', client, [], () => revisionCheck)
    .withCallerAuthorization(checks, async (workspaceId, teamId, projectId, membership) => {
      requested.push([workspaceId, teamId, projectId, membership])
      return [membershipCheck]
    })
  const fence = { teamId: 'core-team', issueId: 'item-1', revision: 4, accessProjectId: 'refero' }
  await store.put('w', { ...collection, revision: 2 }, 1, fence)
  expect(requested).toEqual([['w', 'core-team', 'refero', true]])
  expect(transactions).toEqual([[expect.objectContaining({ Put: expect.anything() }), expect.anything(), revisionCheck, membershipCheck, ...checks]])
  // A revoked membership fails only its check: retry with a fresh read, not a lost Workspace grant.
  failMembership = true
  await expect(store.put('w', { ...collection, revision: 2 }, 1, fence))
    .rejects.toMatchObject({ status: 409, code: 'CollectionWorkItemChanged' })
  // An Enterprise grant fences its Project's active state without a membership check.
  failMembership = false
  requested.length = 0
  await store.put('w', { ...collection, revision: 2 }, 1, { teamId: 'core-team', issueId: 'item-1', revision: 4, activeProjectId: 'refero' })
  expect(requested).toEqual([['w', 'core-team', 'refero', false]])
  // A fence that names a Project cannot be written without the membership builder.
  await expect(new DynamoDbCollectionsStore('planning', client, checks, () => revisionCheck).put('w', { ...collection, revision: 2 }, 1, fence))
    .rejects.toMatchObject({ status: 503 })
})

test('fails closed before creating when an existing counter disagrees with the live rows', async () => {
  /**
   * Store whose counter reads return the given counts in order while the partition holds rows.
   *
   * @param counts - Counter values returned by successive counter reads.
   * @param liveRows - Number of live Collection rows.
   * @param generations - Write generations returned by successive counter reads.
   * @returns The store and the commands it received.
   */
  const storeWith = (counts: number[], liveRows: number, generations: number[] = [0]) => {
    const commands: unknown[] = []
    let reads = 0
    const store = new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
      commands.push(command)
      if (command instanceof GetCommand) {
        const count = counts[Math.min(reads, counts.length - 1)]
        const generation = generations[Math.min(reads, generations.length - 1)]
        reads += 1
        return { Item: { ...validCounter, count, ...(generation === 0 ? {} : { generation }) } }
      }
      if (command instanceof QueryCommand) return { Items: Array.from({ length: liveRows }, (_, index) => storedRow(index)) }
      if (command instanceof TransactWriteCommand) return {}
      throw new Error('Unexpected command')
    }), checks)
    return { store, commands }
  }
  // An undercounted counter beside a full partition must not let another creation commit.
  const undercounted = storeWith([1], COLLECTION_LIMIT)
  await expect(undercounted.store.put('w', collection, 0)).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  expect(undercounted.commands.some((command) => command instanceof TransactWriteCommand)).toBe(false)
  // An overcounted counter is corrupt too, rather than reported as a full Workspace.
  await expect(storeWith([5], 3).store.put('w', collection, 0)).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  // A counter that moved between the two reads was a concurrent write: a retryable conflict.
  const raced = storeWith([3, 4], 4)
  await expect(raced.store.put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionConflict' })
  expect(raced.commands.some((command) => command instanceof TransactWriteCommand)).toBe(false)
  // A delete and a create during a paged listing leave the count unchanged but advance the
  // generation; that is a retryable conflict, not corrupt state.
  const churned = storeWith([3], 2, [7, 9])
  await expect(churned.store.put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionConflict' })
  expect(churned.commands.some((command) => command instanceof TransactWriteCommand)).toBe(false)
  // A full, consistent counter reports the limit without writing.
  const full = storeWith([COLLECTION_LIMIT], COLLECTION_LIMIT)
  await expect(full.store.put('w', collection, 0)).rejects.toMatchObject({ status: 409, code: 'CollectionLimitReached' })
  expect(full.commands.some((command) => command instanceof TransactWriteCommand)).toBe(false)
  // A creation is bound to the generation it verified, so churn after the listing fails it.
  const generationBound = storeWith([2], 2, [5])
  await generationBound.store.put('w', collection, 0)
  expect(generationBound.commands.find((command) => command instanceof TransactWriteCommand)?.input.TransactItems?.[1])
    .toMatchObject({ Update: { ConditionExpression: '#entryType = :entryType AND #count = :verified AND #count < :limit AND #generation = :generation', ExpressionAttributeValues: expect.objectContaining({ ':verified': 2, ':generation': 5 }) } })
  // A generation with no room for the creation's increment is not written.
  const exhausted = storeWith([2], 2, [Number.MAX_SAFE_INTEGER])
  await expect(exhausted.store.put('w', collection, 0)).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  expect(exhausted.commands.some((command) => command instanceof TransactWriteCommand)).toBe(false)
  // An updated row never needs the counter.
  const update = storeWith([1], COLLECTION_LIMIT)
  await update.store.put('w', { ...collection, revision: 2 }, 1)
  expect(update.commands.every((command) => command instanceof TransactWriteCommand)).toBe(true)
})

test('reads the deletion marker before the live row and fails closed when both exist', async () => {
  const row = storedRow(1)
  const marker = {
    workspaceId: 'w',
    recordKey: 'COLLECTION_DELETED#c1',
    entryType: 'work-item-collection-tombstone',
    collectionId: 'c1',
    createFingerprint: 'f'.repeat(64),
    deletedRevision: 2,
  }
  /**
   * Store holding the given rows by sort key.
   *
   * @param rows - Rows keyed by sort key.
   * @returns The store and the sort keys it read, in order.
   */
  const storeWith = (rows: Record<string, Record<string, unknown>>) => {
    const reads: unknown[] = []
    const store = new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
      if (!(command instanceof GetCommand)) throw new Error('Unexpected command')
      expect(command.input.ConsistentRead).toBe(true)
      const key = command.input.Key?.recordKey
      reads.push(key)
      const item = typeof key === 'string' ? rows[key] : undefined
      return item ? { Item: item } : {}
    }))
    return { store, reads }
  }
  const restored = storeWith({ 'COLLECTION#c1': row, 'COLLECTION_DELETED#c1': marker })
  await expect(restored.store.get('w', 'c1')).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  expect(restored.reads).toEqual(['COLLECTION_DELETED#c1', 'COLLECTION#c1'])
  // A deleted Collection is missing; a live one without a marker is returned.
  expect(await storeWith({ 'COLLECTION_DELETED#c1': marker }).store.get('w', 'c1')).toBeUndefined()
  expect(await storeWith({ 'COLLECTION#c1': row }).store.get('w', 'c1')).toMatchObject({ collectionId: 'c1', revision: 1 })
})

test('fails closed when a listed Collection also has a deletion marker', async () => {
  /**
   * Store whose listing returns two rows while one of them has a deletion marker.
   *
   * @param stillLive - Whether the marked row is still live when it is read again.
   * @returns The store.
   */
  const storeWithMarker = (stillLive: boolean) => new DynamoDbCollectionsStore('planning', clientFor(async (command) => {
    if (command instanceof QueryCommand) return { Items: [storedRow(1), storedRow(2)] }
    if (command instanceof BatchGetCommand) {
      const keys = command.input.RequestItems?.planning?.Keys ?? []
      expect(keys).toEqual([{ workspaceId: 'w', recordKey: 'COLLECTION_DELETED#c1' }, { workspaceId: 'w', recordKey: 'COLLECTION_DELETED#c2' }])
      return { Responses: { planning: [{ collectionId: 'c2' }] } }
    }
    if (command instanceof GetCommand && command.input.Key?.recordKey === 'COLLECTION#c2') {
      return stillLive ? { Item: { recordKey: 'COLLECTION#c2' } } : {}
    }
    throw new Error('Unexpected command')
  }, true), checks)
  // A restored live row beside its marker would expose a logically deleted Collection.
  await expect(storeWithMarker(true).listSummaries('w')).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  // A delete that committed after the rows were listed is dropped, not reported as corrupt.
  expect((await storeWithMarker(false).listSummaries('w')).map((entry) => entry.collectionId)).toEqual(['c1'])
})
