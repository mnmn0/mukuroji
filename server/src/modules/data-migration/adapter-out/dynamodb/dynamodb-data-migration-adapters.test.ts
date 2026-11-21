import { describe, expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createTaskEstimateMigration } from '../../test-support/data-migration-fakes'
import type { DataMigrationCheckpoint } from '../../domain/data-migration'
import {
  createDynamoDbDataMigrationRowStore,
  decodeDataMigrationCursor,
  encodeDataMigrationCursor,
} from './dynamodb-data-migration-row-store'
import {
  createDynamoDbDataMigrationCheckpointStore,
  parseDataMigrationCheckpoint,
} from './dynamodb-data-migration-checkpoint-store'

/** One intercepted SDK call. */
type RecordedCall = {
  /** Low-level command name. */
  readonly commandName: string
  /** Marshalled command input. */
  readonly input: Record<string, unknown>
}

/**
 * Creates a document client whose calls are answered by a handler before
 * they reach the network. Outputs are returned as plain objects because the
 * interception happens before the SDK's own unmarshalling step.
 *
 * @param handler - Returns the output, or throws, for each call.
 * @returns The client and the recorded calls.
 */
function createInterceptedClient(
  handler: (call: RecordedCall) => Record<string, unknown>,
): { documentClient: DynamoDBDocumentClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }))
  documentClient.middlewareStack.add((_next, context) => async (args) => {
    const input: Record<string, unknown> = typeof args.input === 'object' && args.input !== null
      ? Object.fromEntries(Object.entries(args.input))
      : {}
    const call = { commandName: String(context.commandName), input }
    calls.push(call)
    return { output: { $metadata: {}, ...handler(call) }, response: {} }
  }, { step: 'build', name: 'dataMigrationTestInterceptor' })
  return { documentClient, calls }
}

/**
 * Creates an SDK-shaped error with a name.
 *
 * @param name - Error name.
 * @returns The error.
 */
function namedError(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

describe('DynamoDB row store', () => {
  test('scans one strongly consistent segment page and encodes the cursor', async () => {
    const { documentClient, calls } = createInterceptedClient(() => ({
      Items: [{ pk: 'TEAM#a', sk: 'TASK#1' }],
      LastEvaluatedKey: { pk: 'TEAM#a', sk: 'TASK#1' },
    }))
    const store = createDynamoDbDataMigrationRowStore({ documentClient, tableName: 'work-items', totalSegments: 3 })

    expect(store.listPartitions()).toEqual(['segment-0-of-3', 'segment-1-of-3', 'segment-2-of-3'])
    const page = await store.readPage({
      partitionId: 'segment-2-of-3',
      cursor: encodeDataMigrationCursor({ pk: 'TEAM#a', sk: 'TASK#0' }),
      limit: 25,
    })
    expect(page.rows).toEqual([{ pk: 'TEAM#a', sk: 'TASK#1' }])
    expect(page.nextCursor).toBeDefined()
    expect(decodeDataMigrationCursor(page.nextCursor ?? '')).toEqual({ pk: 'TEAM#a', sk: 'TASK#1' })
    expect(calls[0]).toMatchObject({
      commandName: 'ScanCommand',
      input: {
        TableName: 'work-items',
        Segment: 2,
        TotalSegments: 3,
        Limit: 25,
        ConsistentRead: true,
        ExclusiveStartKey: { pk: { S: 'TEAM#a' }, sk: { S: 'TASK#0' } },
      },
    })
    await expect(store.readPage({ partitionId: 'segment-3-of-3', limit: 1 })).rejects.toThrow('PARTITION_PLAN_MISMATCH')
    await expect(store.readPage({ partitionId: 'segment-0-of-4', limit: 1 })).rejects.toThrow('PARTITION_PLAN_MISMATCH')
  })

  test('puts the replacement on the stored version and revision and reports a lost condition', async () => {
    let fail = false
    const { documentClient, calls } = createInterceptedClient(() => {
      if (fail) throw namedError('ConditionalCheckFailedException')
      return {}
    })
    const store = createDynamoDbDataMigrationRowStore({ documentClient, tableName: 'work-items', totalSegments: 1 })
    const definition = createTaskEstimateMigration({ writerPolicy: 'revision-fenced', revisionAttribute: 'revision' })
    const row = { pk: 'TEAM#a', sk: 'TASK#1', schemaVersion: 2, revision: 3 }

    expect(await store.replaceRow({ definition, row, expectedRevision: 3 })).toBe('replaced')
    expect(calls[0]).toMatchObject({
      commandName: 'PutItemCommand',
      input: {
        ConditionExpression: 'attribute_exists(#key0) AND attribute_exists(#key1) AND #version = :fromVersion AND #revision = :expectedRevision',
        ExpressionAttributeNames: { '#key0': 'pk', '#key1': 'sk', '#version': 'schemaVersion', '#revision': 'revision' },
        ExpressionAttributeValues: { ':fromVersion': { N: '1' }, ':expectedRevision': { N: '3' } },
      },
    })
    await store.replaceRow({ definition, row })
    expect(calls[1]?.input.ConditionExpression).toContain('attribute_not_exists(#revision)')
    fail = true
    expect(await store.replaceRow({ definition, row, expectedRevision: 3 })).toBe('condition-failed')
  })

  test('writes derived rows in one transaction fenced on the source and classifies its failures', async () => {
    let failure: Error | undefined
    const { documentClient, calls } = createInterceptedClient(() => {
      if (failure !== undefined) throw failure
      return {}
    })
    const store = createDynamoDbDataMigrationRowStore({ documentClient, tableName: 'work-items', totalSegments: 1 })
    const definition = createTaskEstimateMigration({ writerPolicy: 'revision-fenced', revisionAttribute: 'revision' })
    const request = {
      definition,
      sourceKey: { pk: 'TEAM#a', sk: 'TASK#1' },
      expectedRevision: 3,
      rows: [
        { pk: 'OWNER#sato', sk: 'TEAM#a#TASK#1', entity: 'owner-index' },
        { pk: 'OWNER#kato', sk: 'TEAM#a#TASK#1', entity: 'owner-index' },
      ],
    }

    expect(await store.writeDerivedRows(request)).toBe('replaced')
    expect(calls[0]).toMatchObject({
      commandName: 'TransactWriteItemsCommand',
      input: {
        TransactItems: [
          {
            ConditionCheck: {
              TableName: 'work-items',
              Key: { pk: { S: 'TEAM#a' }, sk: { S: 'TASK#1' } },
              ConditionExpression: 'attribute_exists(#key0) AND attribute_exists(#key1) AND #revision = :expectedRevision',
              ExpressionAttributeNames: { '#key0': 'pk', '#key1': 'sk', '#revision': 'revision' },
              ExpressionAttributeValues: { ':expectedRevision': { N: '3' } },
            },
          },
          { Put: { TableName: 'work-items', Item: { pk: { S: 'OWNER#sato' } } } },
          { Put: { TableName: 'work-items', Item: { pk: { S: 'OWNER#kato' } } } },
        ],
      },
    })

    failure = Object.assign(namedError('TransactionCanceledException'), {
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    })
    expect(await store.writeDerivedRows(request)).toBe('condition-failed')

    failure = Object.assign(namedError('TransactionCanceledException'), {
      CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }, { Code: 'None' }],
    })
    await expect(store.writeDerivedRows(request)).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE' })

    failure = namedError('ProvisionedThroughputExceededException')
    await expect(store.writeDerivedRows(request)).rejects.toMatchObject({
      code: 'UPSTREAM_FAILURE', detail: 'ProvisionedThroughputExceededException',
    })
  })

  test('classifies other SDK errors without exposing them', async () => {
    const { documentClient } = createInterceptedClient(() => {
      throw namedError('ProvisionedThroughputExceededException')
    })
    const store = createDynamoDbDataMigrationRowStore({ documentClient, tableName: 'work-items', totalSegments: 1 })
    await expect(store.readPage({ partitionId: 'segment-0-of-1', limit: 1 }))
      .rejects.toMatchObject({ code: 'UPSTREAM_FAILURE', detail: 'ProvisionedThroughputExceededException', message: 'UPSTREAM_FAILURE' })
    await expect(store.getRow({ pk: 'a', sk: 'b' })).rejects.toThrow('UPSTREAM_FAILURE')
    await expect(store.replaceRow({ definition: createTaskEstimateMigration(), row: { pk: 'a', sk: 'b' } }))
      .rejects.toThrow('UPSTREAM_FAILURE')
  })

  test('rejects malformed cursors and segment counts', () => {
    expect(() => decodeDataMigrationCursor('not json')).toThrow('CHECKPOINT_INVALID')
    expect(() => decodeDataMigrationCursor('{"pk":{"S":"a"}}')).toThrow('CHECKPOINT_INVALID')
    expect(() => decodeDataMigrationCursor('{}')).toThrow('CHECKPOINT_INVALID')
    const { documentClient } = createInterceptedClient(() => ({}))
    expect(() => createDynamoDbDataMigrationRowStore({ documentClient, tableName: 't', totalSegments: 65 }))
      .toThrow('DEFINITION_INVALID')
  })
})

describe('DynamoDB checkpoint store', () => {
  const checkpoint: DataMigrationCheckpoint = {
    migrationId: '0001-task-estimate-points',
    partitionId: 'segment-0-of-1',
    targetTable: 'work-items',
    partitionCount: 1,
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    status: 'in-progress',
    cursor: '{"pk":"a"}',
    counters: { scanned: 1, migrated: 1, alreadyMigrated: 0, unrelated: 0, vanished: 0 },
    revision: 2,
    leaseOwner: 'run-1',
    leaseExpiresAt: '2026-11-20T00:05:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  }

  test('saves with compare-and-set on the revision and lists every page strictly', async () => {
    let conditionFails = false
    let page = 0
    const { documentClient, calls } = createInterceptedClient((call) => {
      if (call.commandName === 'PutItemCommand') {
        if (conditionFails) throw namedError('ConditionalCheckFailedException')
        return {}
      }
      page += 1
      return page === 1
        ? { Items: [{ ...checkpoint, schemaVersion: 2 }], LastEvaluatedKey: { migrationId: 'm', partitionId: 'p' } }
        : { Items: [] }
    })
    const store = createDynamoDbDataMigrationCheckpointStore({ documentClient, tableName: 'migrations' })

    expect(await store.save(checkpoint, 1)).toBe(true)
    expect(calls[0]?.input).toMatchObject({
      ConditionExpression: '#revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': { N: '1' } },
    })
    expect(await store.save({ ...checkpoint, revision: 1 }, undefined)).toBe(true)
    expect(calls[1]?.input.ConditionExpression).toBe('attribute_not_exists(#migrationId)')
    conditionFails = true
    expect(await store.save(checkpoint, 1)).toBe(false)

    expect(await store.list(checkpoint.migrationId)).toEqual([checkpoint])
    expect(calls.filter((call) => call.commandName === 'QueryCommand')).toHaveLength(2)
  })

  test('keeps run records in their own partition so checkpoint listing never reads them', async () => {
    const { documentClient, calls } = createInterceptedClient(() => ({}))
    const store = createDynamoDbDataMigrationCheckpointStore({ documentClient, tableName: 'migrations' })
    await store.saveRun({
      migrationId: checkpoint.migrationId,
      runId: 'run-1',
      operator: 'arn:aws:sts::123456789012:assumed-role/operator/session',
      targetTable: 'work-items',
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
      partitionCount: 1,
      status: 'started',
      pagesRead: 0,
      counters: checkpoint.counters,
      startedAt: '2026-11-20T00:00:00.000Z',
    })
    expect(calls[0]?.input.Item).toMatchObject({
      migrationId: { S: 'RUN#0001-task-estimate-points' },
      partitionId: { S: '2026-11-20T00:00:00.000Z#run-1' },
      operator: { S: 'arn:aws:sts::123456789012:assumed-role/operator/session' },
    })
  })

  test.each([
    ['another migration', { migrationId: 'other' }],
    ['an unknown status', { status: 'paused' }],
    ['a cursor on a completed partition', { status: 'completed' }],
    ['a lease owner without expiry', { leaseExpiresAt: undefined }],
    ['a non-canonical time', { updatedAt: '2026-11-20' }],
    ['a missing counter', { counters: { scanned: 1 } }],
    ['an unknown row version', { schemaVersion: 1 }],
    ['no target table', { targetTable: '' }],
    ['a negative source version', { fromSchemaVersion: -1, toSchemaVersion: 0 }],
    ['a version step other than one', { fromSchemaVersion: 1, toSchemaVersion: 3 }],
  ])('rejects a stored checkpoint with %s', (_label, overrides) => {
    expect(() => parseDataMigrationCheckpoint({ ...checkpoint, schemaVersion: 2, ...overrides }, checkpoint.migrationId))
      .toThrow('CHECKPOINT_INVALID')
  })

  test('accepts the version 0 source of a derive migration', () => {
    const stored = { ...checkpoint, schemaVersion: 2, fromSchemaVersion: 0, toSchemaVersion: 1 }
    expect(parseDataMigrationCheckpoint(stored, checkpoint.migrationId)).toMatchObject({
      fromSchemaVersion: 0,
      toSchemaVersion: 1,
    })
  })
})
