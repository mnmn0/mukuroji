import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { COLLECTION_LIMIT } from '@mukuroji/contracts'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import type { CollectionsStore } from '../application/collections'
import { CollectionError, isStoredCollection, type StoredCollection } from '../domain/collections'

/** Sort-key prefix of Collection rows in the Planning table. */
const COLLECTION_RECORD_PREFIX = 'COLLECTION#'

/** Sort key of the per-Workspace Collection counter row. */
const COLLECTION_COUNT_RECORD_KEY = 'COLLECTION_COUNT'

/** Entry type stored on Collection rows. */
const COLLECTION_ENTRY_TYPE = 'work-item-collection'

/** Schema version stored on Collection rows. */
const COLLECTION_SCHEMA_VERSION = 1

/** Composition-only binding for fresh caller authorization conditions. */
export interface CollectionsPersistence extends CollectionsStore {
  /**
   * Creates a request-local store whose writes also require the caller's current membership.
   *
   * @param checks - Server-built caller authorization conditions.
   * @returns Request-local Collection persistence.
   */
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[]): CollectionsStore
}

/** Collection rows in the existing Planning table (pk `workspaceId`, sk `recordKey`). */
export class DynamoDbCollectionsStore implements CollectionsPersistence {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected document client. */
  private readonly client: DynamoDBDocumentClient
  /** Caller authorization conditions added to every write. */
  private readonly checks: readonly PlanningCallerAuthorizationConditionCheck[]

  /**
   * Creates the adapter.
   *
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   * @param checks - Request-local caller conditions.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, checks: readonly PlanningCallerAuthorizationConditionCheck[] = []) {
    this.tableName = tableName
    this.client = client
    this.checks = structuredClone(checks)
  }

  /**
   * Binds caller authorization conditions to writes.
   *
   * @param checks - Server-built caller authorization conditions.
   * @returns Request-local store.
   */
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[]): CollectionsStore {
    return new DynamoDbCollectionsStore(this.tableName, this.client, checks)
  }

  /**
   * Lists every Collection row in the Workspace partition.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @returns Validated Collections.
   */
  async list(workspaceId: string): Promise<StoredCollection[]> {
    const collections: StoredCollection[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#workspaceId = :workspaceId AND begins_with(#recordKey, :prefix)',
        ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': COLLECTION_RECORD_PREFIX },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })).catch((error: unknown) => storageFailure(error))
      for (const row of page.Items ?? []) collections.push(readRow(workspaceId, row))
      exclusiveStartKey = page.LastEvaluatedKey
    } while (exclusiveStartKey)
    return collections
  }

  /**
   * Reads one Collection row.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @returns The Collection, or undefined.
   */
  async get(workspaceId: string, collectionId: string): Promise<StoredCollection | undefined> {
    const { Item: row } = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: recordKey(collectionId) },
      ConsistentRead: true,
    })).catch((error: unknown) => storageFailure(error))
    return row === undefined ? undefined : readRow(workspaceId, row)
  }

  /**
   * Writes a Collection with a revision condition and the caller conditions.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collection - Complete next state.
   * @param expectedRevision - Stored revision, or 0 to create.
   */
  async put(workspaceId: string, collection: StoredCollection, expectedRevision: number): Promise<void> {
    this.requireChecks()
    const counter = expectedRevision === 0 ? [this.counterUpdate(workspaceId, 1)] : []
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: this.tableName,
            Item: {
              ...collection,
              workspaceId,
              recordKey: recordKey(collection.collectionId),
              entryType: COLLECTION_ENTRY_TYPE,
              schemaVersion: COLLECTION_SCHEMA_VERSION,
            },
            ...revisionCondition(expectedRevision),
          },
        }, ...counter, ...this.checks],
      }))
    } catch (error) {
      storageFailure(error, 1 + counter.length + this.checks.length, counter.length > 0)
    }
  }

  /**
   * Deletes a Collection row with a revision condition and the caller conditions.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @param expectedRevision - Stored revision.
   */
  async delete(workspaceId: string, collectionId: string, expectedRevision: number): Promise<void> {
    this.requireChecks()
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [{
          Delete: {
            TableName: this.tableName,
            Key: { workspaceId, recordKey: recordKey(collectionId) },
            ...revisionCondition(expectedRevision),
          },
        }, this.counterUpdate(workspaceId, -1), ...this.checks],
      }))
    } catch (error) {
      storageFailure(error, this.checks.length + 2)
    }
  }

  /**
   * Builds the counter update that keeps the Workspace within `COLLECTION_LIMIT`.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param delta - 1 when creating, -1 when deleting.
   * @returns Transaction item that adjusts the counter.
   */
  private counterUpdate(workspaceId: string, delta: 1 | -1) {
    return {
      Update: {
        TableName: this.tableName,
        Key: { workspaceId, recordKey: COLLECTION_COUNT_RECORD_KEY },
        UpdateExpression: 'ADD #count :delta SET #entryType = :entryType',
        ...(delta === 1 ? { ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit' } : {}),
        ExpressionAttributeNames: { '#count': 'count', '#entryType': 'entryType' },
        ExpressionAttributeValues: {
          ':delta': delta,
          ':entryType': 'work-item-collection-count',
          ...(delta === 1 ? { ':limit': COLLECTION_LIMIT } : {}),
        },
      },
    }
  }

  /** Rejects writes that were not bound to the caller's current authorization. */
  private requireChecks(): void {
    if (this.checks.length === 0) {
      throw new CollectionError(503, 'CollectionAuthorizationUnavailable', 'Caller authorization is unavailable.')
    }
  }
}

/** Isolated store for application and route tests. */
export class InMemoryCollectionsStore implements CollectionsPersistence {
  /** Collections keyed by Workspace and Collection. */
  private readonly collections = new Map<string, StoredCollection>()

  /**
   * Returns this store; condition checks are verified by the DynamoDB adapter tests.
   *
   * @param _checks - Caller authorization conditions.
   * @returns This store.
   */
  withCallerAuthorization(_checks: readonly PlanningCallerAuthorizationConditionCheck[]): CollectionsStore {
    return this
  }

  /**
   * Lists copies of the Workspace's Collections.
   *
   * @param workspaceId - Test Workspace.
   * @returns Stored Collections.
   */
  async list(workspaceId: string): Promise<StoredCollection[]> {
    const prefix = `${JSON.stringify(workspaceId)}:`
    return [...this.collections.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, collection]) => structuredClone(collection))
  }

  /**
   * Reads a copy of one Collection.
   *
   * @param workspaceId - Test Workspace.
   * @param collectionId - Collection identifier.
   * @returns The Collection, or undefined.
   */
  async get(workspaceId: string, collectionId: string): Promise<StoredCollection | undefined> {
    const collection = this.collections.get(memoryKey(workspaceId, collectionId))
    return collection ? structuredClone(collection) : undefined
  }

  /**
   * Writes a Collection with optimistic concurrency.
   *
   * @param workspaceId - Test Workspace.
   * @param collection - Complete next state.
   * @param expectedRevision - Stored revision, or 0 to create.
   */
  async put(workspaceId: string, collection: StoredCollection, expectedRevision: number): Promise<void> {
    const key = memoryKey(workspaceId, collection.collectionId)
    if ((this.collections.get(key)?.revision ?? 0) !== expectedRevision) throw conflict()
    if (expectedRevision === 0 && (await this.list(workspaceId)).length >= COLLECTION_LIMIT) throw limitReached()
    this.collections.set(key, structuredClone(collection))
  }

  /**
   * Deletes a Collection with optimistic concurrency.
   *
   * @param workspaceId - Test Workspace.
   * @param collectionId - Collection identifier.
   * @param expectedRevision - Stored revision.
   */
  async delete(workspaceId: string, collectionId: string, expectedRevision: number): Promise<void> {
    const key = memoryKey(workspaceId, collectionId)
    if (this.collections.get(key)?.revision !== expectedRevision) throw conflict()
    this.collections.delete(key)
  }
}

/**
 * Derives the Planning table sort key of a Collection.
 *
 * @param collectionId - Collection identifier.
 * @returns Sort key.
 */
function recordKey(collectionId: string): string {
  return `${COLLECTION_RECORD_PREFIX}${collectionId}`
}

/**
 * Derives the in-memory map key.
 *
 * @param workspaceId - Workspace identifier.
 * @param collectionId - Collection identifier.
 * @returns Map key scoped to the Workspace.
 */
function memoryKey(workspaceId: string, collectionId: string): string {
  return `${JSON.stringify(workspaceId)}:${collectionId}`
}

/**
 * Builds the revision condition for a write.
 *
 * @param expectedRevision - Stored revision, or 0 to create.
 * @returns DynamoDB condition fields.
 */
function revisionCondition(expectedRevision: number) {
  if (expectedRevision === 0) return { ConditionExpression: 'attribute_not_exists(recordKey)' }
  return {
    ConditionExpression: '#revision = :revision AND #entryType = :entryType',
    ExpressionAttributeNames: { '#revision': 'revision', '#entryType': 'entryType' },
    ExpressionAttributeValues: { ':revision': expectedRevision, ':entryType': COLLECTION_ENTRY_TYPE },
  }
}

/**
 * Validates a persisted row and strips its storage attributes.
 *
 * @param workspaceId - Partition that was read.
 * @param row - Raw item.
 * @returns The stored Collection.
 */
function readRow(workspaceId: string, row: Record<string, unknown>): StoredCollection {
  const { workspaceId: rowWorkspaceId, recordKey: rowRecordKey, entryType, schemaVersion, ...collection } = row
  if (
    rowWorkspaceId !== workspaceId ||
    entryType !== COLLECTION_ENTRY_TYPE ||
    schemaVersion !== COLLECTION_SCHEMA_VERSION ||
    !isStoredCollection(collection) ||
    rowRecordKey !== recordKey(collection.collectionId)
  ) {
    throw new CollectionError(502, 'CollectionCorruptState', 'Collection data is invalid.')
  }
  return collection
}

/**
 * Creates the shared stale-revision error.
 *
 * @returns A 409 Collection error.
 */
function conflict(): CollectionError {
  return new CollectionError(409, 'CollectionConflict', 'The Collection changed. Reload and try again.')
}

/**
 * Classifies a DynamoDB failure.
 *
 * @param error - Thrown SDK error.
 * @param transactionSize - Number of items in the failed transaction, if any.
 * @param countsCreation - Whether item 1 is the creation counter update.
 * @returns Never; always throws a Collection error.
 */
function storageFailure(error: unknown, transactionSize = 0, countsCreation = false): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (name === 'TransactionCanceledException' && typeof error === 'object' && error !== null && 'CancellationReasons' in error && Array.isArray(error.CancellationReasons)) {
    const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined)
    if (countsCreation && codes.length === transactionSize && codes[0] !== 'ConditionalCheckFailed' && codes[1] === 'ConditionalCheckFailed') {
      throw limitReached()
    }
    if (transactionSize > 0 && codes.length === transactionSize && codes.includes('ConditionalCheckFailed')) {
      throw new CollectionError(409, 'CollectionConflict', 'The Collection or your permissions changed. Reload and try again.')
    }
    if (codes.some((code) => code === 'TransactionConflict' || code === 'ProvisionedThroughputExceeded' || code === 'ThrottlingError')) {
      throw retryable()
    }
  }
  if (typeof name === 'string' && ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)) {
    throw retryable()
  }
  throw new CollectionError(502, 'CollectionStorageFailure', 'Collection storage request failed.')
}

/**
 * Creates the Workspace Collection limit error.
 *
 * @returns A 409 Collection error.
 */
function limitReached(): CollectionError {
  return new CollectionError(409, 'CollectionLimitReached', `A Workspace can have up to ${COLLECTION_LIMIT} Collections.`)
}

/**
 * Creates the shared retryable storage error.
 *
 * @returns A 503 Collection error.
 */
function retryable(): CollectionError {
  return new CollectionError(503, 'CollectionRetryable', 'Collection storage is temporarily unavailable.')
}
