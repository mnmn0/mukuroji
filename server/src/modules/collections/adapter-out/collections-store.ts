import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { COLLECTION_LIMIT } from '@mukuroji/contracts'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import type { CollectionsStore } from '../application/collections'
import {
  CollectionError,
  isCollectionCreateFingerprint,
  isStoredCollection,
  type CollectionDeletion,
  type StoredCollection,
} from '../domain/collections'

/** Sort-key prefix of Collection rows in the Planning table. */
const COLLECTION_RECORD_PREFIX = 'COLLECTION#'

/** Sort-key prefix of deletion markers; it does not share the Collection row prefix. */
const COLLECTION_TOMBSTONE_PREFIX = 'COLLECTION_DELETED#'

/** Entry type stored on deletion markers. */
const COLLECTION_TOMBSTONE_ENTRY_TYPE = 'work-item-collection-tombstone'

/** Sort key of the per-Workspace Collection counter row. */
const COLLECTION_COUNT_RECORD_KEY = 'COLLECTION_COUNT'

/** Entry type stored on the per-Workspace Collection counter row. */
const COLLECTION_COUNT_ENTRY_TYPE = 'work-item-collection-count'

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
      if (collections.length > COLLECTION_LIMIT) {
        // The counter keeps a Workspace at the limit, so more rows mean a corrupt partition.
        throw new CollectionError(502, 'CollectionCorruptState', 'Collection data is invalid.')
      }
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
   * Reads the deletion marker of a Collection.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @returns The deletion record, or undefined when the Collection was never deleted.
   */
  async readDeletion(workspaceId: string, collectionId: string): Promise<CollectionDeletion | undefined> {
    const { Item: row } = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: tombstoneKey(collectionId) },
      ConsistentRead: true,
    })).catch((error: unknown) => storageFailure(error))
    if (row === undefined) return undefined
    // Only a marker written by `delete` proves the deletion; anything else is corrupt state.
    if (
      row.workspaceId !== workspaceId ||
      row.recordKey !== tombstoneKey(collectionId) ||
      row.entryType !== COLLECTION_TOMBSTONE_ENTRY_TYPE ||
      row.collectionId !== collectionId ||
      !isCollectionCreateFingerprint(row.createFingerprint) ||
      typeof row.deletedRevision !== 'number' || !Number.isSafeInteger(row.deletedRevision) || row.deletedRevision < 1
    ) {
      throw new CollectionError(502, 'CollectionCorruptState', 'Collection data is invalid.')
    }
    return { createFingerprint: row.createFingerprint, deletedRevision: row.deletedRevision }
  }

  /**
   * Writes a Collection with a revision condition and the caller conditions.
   *
   * A creation also adjusts the Workspace counter and requires that no deletion marker exists.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collection - Complete next state.
   * @param expectedRevision - Stored revision, or 0 to create.
   */
  async put(workspaceId: string, collection: StoredCollection, expectedRevision: number): Promise<void> {
    this.requireChecks()
    // Every write requires that no deletion marker exists, so a restored live row next to its
    // marker fails closed instead of being changed after its deletion.
    const counter = expectedRevision === 0
      ? [this.counterUpdate(workspaceId, 1), this.notDeletedCheck(workspaceId, collection.collectionId)]
      : [this.notDeletedCheck(workspaceId, collection.collectionId)]
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
      const transactionSize = 1 + counter.length + this.checks.length
      // A failed counter condition means either a full Workspace or an invalid counter row;
      // read the row to report which.
      if (expectedRevision === 0 && isOnlyConditionFailure(error, transactionSize, 1)) {
        throw await this.classifyCounterFailure(workspaceId)
      }
      storageFailure(error, transactionSize, 1 + counter.length, expectedRevision === 0 ? 'create' : 'update')
    }
  }

  /**
   * Deletes a Collection row with a revision condition and the caller conditions.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @param expectedRevision - Stored revision.
   * @param deletion - Creation details kept in the deletion marker.
   */
  async delete(workspaceId: string, collectionId: string, expectedRevision: number, deletion: CollectionDeletion): Promise<void> {
    this.requireChecks()
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [{
          Delete: {
            TableName: this.tableName,
            Key: { workspaceId, recordKey: recordKey(collectionId) },
            ...revisionCondition(expectedRevision),
          },
        }, this.counterUpdate(workspaceId, -1), {
          Put: {
            TableName: this.tableName,
            Item: {
              workspaceId,
              recordKey: tombstoneKey(collectionId),
              entryType: COLLECTION_TOMBSTONE_ENTRY_TYPE,
              collectionId,
              createFingerprint: deletion.createFingerprint,
              deletedRevision: deletion.deletedRevision,
            },
            // An existing marker next to a live row is contradictory state; never overwrite it.
            ConditionExpression: 'attribute_not_exists(recordKey)',
          },
        }, ...this.checks],
      }))
    } catch (error) {
      storageFailure(error, this.checks.length + 3, 3, 'delete')
    }
  }

  /**
   * Explains why the creation counter condition failed.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @returns `CollectionLimitReached` for a valid full counter, otherwise `CollectionCorruptState`.
   */
  private async classifyCounterFailure(workspaceId: string): Promise<CollectionError> {
    const { Item: row } = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: COLLECTION_COUNT_RECORD_KEY },
      ConsistentRead: true,
    })).catch((error: unknown) => storageFailure(error))
    const count: unknown = row?.count
    const isValidCounter = row?.entryType === COLLECTION_COUNT_ENTRY_TYPE &&
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    if (!isValidCounter) return new CollectionError(502, 'CollectionCorruptState', 'Collection data is invalid.')
    // A concurrent delete can free a slot between the failed write and this read; retry then.
    return count >= COLLECTION_LIMIT ? limitReached() : conflict()
  }

  /**
   * Builds the condition that a Collection being created was never deleted.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @returns Transaction condition check.
   */
  private notDeletedCheck(workspaceId: string, collectionId: string) {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { workspaceId, recordKey: tombstoneKey(collectionId) },
        ConditionExpression: 'attribute_not_exists(recordKey)',
      },
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
        // A decrement needs an existing positive counter; otherwise the partition is corrupt and
        // a counter created at -1 would let the Workspace exceed the limit.
        ConditionExpression: delta === 1
          ? 'attribute_not_exists(recordKey) OR (#entryType = :entryType AND #count >= :zero AND #count < :limit)'
          : '#count > :zero AND #entryType = :entryType',
        ExpressionAttributeNames: { '#count': 'count', '#entryType': 'entryType' },
        ExpressionAttributeValues: {
          ':delta': delta,
          ':entryType': COLLECTION_COUNT_ENTRY_TYPE,
          ':zero': 0,
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
  /** Deletion markers keyed by Workspace and Collection. */
  private readonly deleted = new Map<string, CollectionDeletion>()

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
   * Reads a copy of a deletion marker.
   *
   * @param workspaceId - Test Workspace.
   * @param collectionId - Collection identifier.
   * @returns The deletion record, or undefined.
   */
  async readDeletion(workspaceId: string, collectionId: string): Promise<CollectionDeletion | undefined> {
    const deletion = this.deleted.get(memoryKey(workspaceId, collectionId))
    return deletion ? { ...deletion } : undefined
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
    if ((this.collections.get(key)?.revision ?? 0) !== expectedRevision || (expectedRevision === 0 && this.deleted.has(key))) throw conflict()
    if (expectedRevision === 0 && (await this.list(workspaceId)).length >= COLLECTION_LIMIT) throw limitReached()
    this.collections.set(key, structuredClone(collection))
  }

  /**
   * Deletes a Collection with optimistic concurrency.
   *
   * @param workspaceId - Test Workspace.
   * @param collectionId - Collection identifier.
   * @param expectedRevision - Stored revision.
   * @param deletion - Creation details kept in the deletion marker.
   */
  async delete(workspaceId: string, collectionId: string, expectedRevision: number, deletion: CollectionDeletion): Promise<void> {
    const key = memoryKey(workspaceId, collectionId)
    if (this.collections.get(key)?.revision !== expectedRevision) throw conflict()
    this.collections.delete(key)
    this.deleted.set(key, { ...deletion })
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
 * Derives the Planning table sort key of a deletion marker.
 *
 * @param collectionId - Collection identifier.
 * @returns Sort key.
 */
function tombstoneKey(collectionId: string): string {
  return `${COLLECTION_TOMBSTONE_PREFIX}${collectionId}`
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
 * @param authorizationStart - Index of the first caller authorization condition check.
 * @param operation - Write kind; it decides what a failed item after the main row means.
 *   A creation's counter failure is classified by the caller before this runs.
 * @returns Never; always throws a Collection error.
 */
function storageFailure(
  error: unknown,
  transactionSize = 0,
  authorizationStart = transactionSize,
  operation: 'create' | 'update' | 'delete' = 'update',
): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (name === 'TransactionCanceledException' && typeof error === 'object' && error !== null && 'CancellationReasons' in error && Array.isArray(error.CancellationReasons)) {
    const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined)
    if (codes.length === transactionSize && codes.slice(authorizationStart).includes('ConditionalCheckFailed')) {
      throw new CollectionError(403, 'CollectionAuthorizationChanged', 'Your Workspace access changed. Sign in again or ask an administrator.')
    }
    /**
     * Checks whether only a condition after the main row failed.
     *
     * @param index - Transaction item index.
     * @returns Whether that item failed while the main row condition held.
     */
    const onlyFailed = (index: number) =>
      codes.length === transactionSize && codes[0] !== 'ConditionalCheckFailed' && codes[index] === 'ConditionalCheckFailed'
    // Item 1 is the deletion marker check on an update; on a delete, items 1 and 2 are the
    // counter decrement and the marker write. Their failure means contradictory stored state.
    if ((operation === 'update' && onlyFailed(1)) || (operation === 'delete' && (onlyFailed(1) || onlyFailed(2)))) {
      throw new CollectionError(502, 'CollectionCorruptState', 'Collection data is invalid.')
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

/**
 * Checks whether a transaction failed only on one condition after the main row.
 *
 * @param error - Thrown SDK error.
 * @param transactionSize - Number of items in the transaction.
 * @param index - Item whose condition failed.
 * @returns Whether that item alone failed while the main row condition held.
 */
function isOnlyConditionFailure(error: unknown, transactionSize: number, index: number): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error) || error.name !== 'TransactionCanceledException') return false
  if (!('CancellationReasons' in error) || !Array.isArray(error.CancellationReasons)) return false
  const codes = error.CancellationReasons.map((reason: unknown) =>
    typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined)
  return codes.length === transactionSize && codes[0] !== 'ConditionalCheckFailed' &&
    codes.every((code, position) => position === index ? code === 'ConditionalCheckFailed' : code !== 'ConditionalCheckFailed')
}
