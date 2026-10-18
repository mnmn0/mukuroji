import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { COLLECTION_LIMIT, type WorkItemCollection } from '@mukuroji/contracts'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import type { CollectionsStore, CollectionWorkItemFence } from '../application/collections'
import {
  CollectionError,
  isCollectionCreateFingerprint,
  isCollectionSummary,
  isStoredCollection,
  toPublicCollection,
  type CollectionDeletion,
  type StoredCollection,
} from '../domain/collections'

/** One item of a DynamoDB write transaction. */
type CollectionTransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/**
 * Builds the condition that a canonical Work Item still exists at an observed revision.
 *
 * The Work Item table belongs to the Work Items module, so composition supplies this.
 *
 * @param workspaceId - Server-resolved Workspace.
 * @param fence - Work Item and the revision its readability was checked at.
 * @returns Transaction condition check on the canonical Work Item row.
 */
export type CollectionWorkItemFenceCheck = (workspaceId: string, fence: CollectionWorkItemFence) => CollectionTransactItem

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

/**
 * Exclusive upper bound of a counter generation that a create or delete may still increment.
 *
 * Any safe integer is a valid stored generation; a write requires the stored one to be below
 * this bound, so the incremented value is still a safe integer.
 */
const COLLECTION_COUNTER_GENERATION_LIMIT = Number.MAX_SAFE_INTEGER

/** Maximum keys in one DynamoDB `BatchGetItem` request. */
const DYNAMODB_BATCH_GET_LIMIT = 100

/** Attempts to read the keys DynamoDB leaves unprocessed in a batch read. */
const BATCH_GET_ATTEMPTS = 5

/** Validated state of the per-Workspace Collection counter row. */
type CollectionCounter = {
  /** Number of live Collections in the Workspace. */
  count: number
  /** Number of creates and deletes applied to the counter; it only grows. */
  generation: number
}

/** Entry type stored on Collection rows. */
const COLLECTION_ENTRY_TYPE = 'work-item-collection'

/** Schema version stored on Collection rows. */
const COLLECTION_SCHEMA_VERSION = 1

/** Attributes read when listing Collections; references stay unread. */
const COLLECTION_SUMMARY_ATTRIBUTES = [
  'workspaceId',
  'recordKey',
  'entryType',
  'schemaVersion',
  'collectionId',
  'name',
  'description',
  'createdBy',
  'createdAt',
  'updatedAt',
  'revision',
] as const

/**
 * Builds the conditions that the Team and the Project that authorized reading a Work Item are
 * still active and, for a direct membership, that the caller still holds it.
 *
 * Archiving a Project changes the Project row, not its membership rows or an Enterprise
 * grant, so the Project row is always fenced. Throws `409 CollectionWorkItemChanged` when the
 * membership or the Project no longer exists.
 *
 * @param workspaceId - Server-resolved Workspace.
 * @param teamId - Team that owns the Work Item and the Project.
 * @param projectId - Project that authorized the read.
 * @param membership - Whether a direct Project membership authorized the read.
 * @returns Transaction condition checks on the membership, Team and Project rows.
 */
export type CollectionProjectAccessCheck = (
  workspaceId: string,
  teamId: string,
  projectId: string,
  membership: boolean,
) => Promise<readonly PlanningCallerAuthorizationConditionCheck[]>

/** Composition-only binding for fresh caller authorization conditions. */
export interface CollectionsPersistence extends CollectionsStore {
  /**
   * Creates a request-local store whose writes also require the caller's current membership.
   *
   * @param checks - Server-built caller authorization conditions.
   * @param projectAccessCheck - Builds the Project membership condition for reference changes.
   * @returns Request-local Collection persistence.
   */
  withCallerAuthorization(
    checks: readonly PlanningCallerAuthorizationConditionCheck[],
    projectAccessCheck?: CollectionProjectAccessCheck,
  ): CollectionsStore
}

/** Collection rows in the existing Planning table (pk `workspaceId`, sk `recordKey`). */
export class DynamoDbCollectionsStore implements CollectionsPersistence {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected document client. */
  private readonly client: DynamoDBDocumentClient
  /** Caller authorization conditions added to every write. */
  private readonly checks: readonly PlanningCallerAuthorizationConditionCheck[]
  /** Builds the canonical Work Item condition for reference changes, when configured. */
  private readonly workItemFenceCheck: CollectionWorkItemFenceCheck | undefined
  /** Builds the request caller's Project membership condition, when bound. */
  private readonly projectAccessCheck: CollectionProjectAccessCheck | undefined

  /**
   * Creates the adapter.
   *
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   * @param checks - Request-local caller conditions.
   * @param workItemFenceCheck - Builds the Work Item revision condition for reference changes.
   * @param projectAccessCheck - Request-local Project membership condition builder.
   */
  constructor(
    tableName: string,
    client: DynamoDBDocumentClient,
    checks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    workItemFenceCheck?: CollectionWorkItemFenceCheck,
    projectAccessCheck?: CollectionProjectAccessCheck,
  ) {
    this.tableName = tableName
    this.client = client
    this.checks = structuredClone(checks)
    this.workItemFenceCheck = workItemFenceCheck
    this.projectAccessCheck = projectAccessCheck
  }

  /**
   * Binds caller authorization conditions to writes.
   *
   * @param checks - Server-built caller authorization conditions.
   * @param projectAccessCheck - Builds the Project membership condition for reference changes.
   * @returns Request-local store.
   */
  withCallerAuthorization(
    checks: readonly PlanningCallerAuthorizationConditionCheck[],
    projectAccessCheck?: CollectionProjectAccessCheck,
  ): CollectionsStore {
    return new DynamoDbCollectionsStore(this.tableName, this.client, checks, this.workItemFenceCheck, projectAccessCheck)
  }

  /**
   * Lists the metadata of every Collection row in the Workspace partition.
   *
   * Only the summary attributes are projected, so the inline references are left out of
   * the response. DynamoDB still reads, charges, and pages by each row's full size including
   * its references, so a listing of `COLLECTION_LIMIT` large rows costs as much read capacity
   * as reading them whole; the projection only trims what is transferred and parsed.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @returns Validated Collection metadata.
   */
  async listSummaries(workspaceId: string): Promise<WorkItemCollection[]> {
    const collections: WorkItemCollection[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#workspaceId = :workspaceId AND begins_with(#recordKey, :prefix)',
        ProjectionExpression: COLLECTION_SUMMARY_ATTRIBUTES.map((_, index) => `#a${index}`).join(', '),
        ExpressionAttributeNames: {
          '#workspaceId': 'workspaceId',
          '#recordKey': 'recordKey',
          ...Object.fromEntries(COLLECTION_SUMMARY_ATTRIBUTES.map((attribute, index) => [`#a${index}`, attribute])),
        },
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': COLLECTION_RECORD_PREFIX },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })).catch((error: unknown) => storageFailure(error))
      for (const row of page.Items ?? []) collections.push(readSummaryRow(workspaceId, row))
      if (collections.length > COLLECTION_LIMIT) {
        // The counter keeps a Workspace at the limit, so more rows mean a corrupt partition.
        throw new CollectionError(502, 'CollectionCorruptState', 'Collection data is invalid.')
      }
      exclusiveStartKey = page.LastEvaluatedKey
    } while (exclusiveStartKey)
    return await this.withoutDeletedSummaries(workspaceId, collections)
  }

  /**
   * Fails closed when a listed Collection also has a deletion marker.
   *
   * A restore or manual repair can leave a live row beside its marker; listing it would expose
   * a logically deleted Collection and let counter reconciliation count it. The markers are
   * read after the rows, so a delete that commits in between also shows both; such a row is
   * read again and dropped once it is gone, and only a row that is still live is corrupt.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collections - Listed Collection metadata.
   * @returns The Collections without ones deleted while listing.
   * @throws CollectionError `CollectionCorruptState` when a live row has a deletion marker.
   */
  private async withoutDeletedSummaries(workspaceId: string, collections: WorkItemCollection[]): Promise<WorkItemCollection[]> {
    const deleted = new Set<string>()
    for (let index = 0; index < collections.length; index += DYNAMODB_BATCH_GET_LIMIT) {
      let keys: Record<string, unknown>[] = collections
        .slice(index, index + DYNAMODB_BATCH_GET_LIMIT)
        .map((collection) => ({ workspaceId, recordKey: tombstoneKey(collection.collectionId) }))
      for (let attempt = 0; keys.length > 0 && attempt < BATCH_GET_ATTEMPTS; attempt += 1) {
        const response = await this.client.send(new BatchGetCommand({
          RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true, ProjectionExpression: 'collectionId' } },
        })).catch((error: unknown) => storageFailure(error))
        for (const marker of response.Responses?.[this.tableName] ?? []) {
          if (typeof marker.collectionId !== 'string') throw corruptState()
          deleted.add(marker.collectionId)
        }
        keys = response.UnprocessedKeys?.[this.tableName]?.Keys ?? []
      }
      if (keys.length > 0) throw retryable()
    }
    if (deleted.size === 0) return collections
    for (const collectionId of deleted) {
      const { Item: row } = await this.client.send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: recordKey(collectionId) },
        ConsistentRead: true,
        ProjectionExpression: 'recordKey',
      })).catch((error: unknown) => storageFailure(error))
      if (row !== undefined) throw corruptState()
    }
    return collections.filter((collection) => !deleted.has(collection.collectionId))
  }

  /**
   * Reads one Collection row and fails closed when its deletion marker also exists.
   *
   * The marker is read before the live row. Deletion atomically removes the row and writes the
   * marker, and nothing recreates a deleted Collection, so a delete that commits between the two
   * reads is seen as a missing row, never as both. A live row read after its marker is left by a
   * restore or manual repair and is reported as `CollectionCorruptState` instead of exposing a
   * logically deleted Collection.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @returns The Collection, or undefined.
   */
  async get(workspaceId: string, collectionId: string): Promise<StoredCollection | undefined> {
    const deletion = await this.readDeletion(workspaceId, collectionId)
    const { Item: row } = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: recordKey(collectionId) },
      ConsistentRead: true,
    })).catch((error: unknown) => storageFailure(error))
    if (row === undefined) return undefined
    const collection = readRow(workspaceId, row)
    if (deletion) throw corruptState()
    return collection
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
   * The counter is first compared with the live Collection rows and the increment requires it
   * to still hold that verified value, so a partition restored without its counter, or with an
   * undercounted one, cannot exceed `COLLECTION_LIMIT`. A reference
   * change also requires the canonical Work Item to still be at the observed revision.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collection - Complete next state.
   * @param expectedRevision - Stored revision, or 0 to create.
   * @param workItemFence - Work Item whose readability authorized the change.
   */
  async put(workspaceId: string, collection: StoredCollection, expectedRevision: number, workItemFence?: CollectionWorkItemFence): Promise<void> {
    this.requireChecks()
    const fence = workItemFence ? await this.workItemChecks(workspaceId, workItemFence) : []
    // A counter that disappears after verification is rebuilt once and the creation retried;
    // a second miss is unexpected.
    for (let attempt = 1; ; attempt += 1) {
      // Every write requires that no deletion marker exists, so a restored live row next to its
      // marker fails closed instead of being changed after its deletion.
      const counter = expectedRevision === 0
        ? [this.counterUpdate(workspaceId, 1, await this.verifiedCount(workspaceId)), this.notDeletedCheck(workspaceId, collection.collectionId)]
        : [this.notDeletedCheck(workspaceId, collection.collectionId)]
      const transactItems = [{
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
      }, ...counter, ...fence, ...this.checks]
      const transactionSize = transactItems.length
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }))
        return
      } catch (error) {
        // A failed counter condition means a full Workspace, a missing counter, or an invalid
        // counter row; read the row to report which.
        if (expectedRevision === 0 && isOnlyConditionFailure(error, transactionSize, 1)) {
          const failure = await this.classifyCounterFailure(workspaceId)
          if (failure !== 'missing') throw failure
          if (attempt >= 2) throw corruptState()
          continue
        }
        if (fence.some((_, offset) => isOnlyConditionFailure(error, transactionSize, 1 + counter.length + offset))) {
          throw new CollectionError(409, 'CollectionWorkItemChanged', 'The Work Item changed. Reload and try again.')
        }
        storageFailure(error, transactionSize, 1 + counter.length + fence.length, expectedRevision === 0 ? 'create' : 'update')
      }
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
   * Reads the Workspace counter and verifies it against the live Collection rows.
   *
   * A restore or manual repair can leave a structurally valid counter that disagrees with the
   * rows, and an undercounted one would let creations exceed `COLLECTION_LIMIT`. A missing
   * counter is rebuilt from the live rows first. Creations and deletions change the counter and
   * the rows in one transaction, so a mismatch whose counter is unchanged on a second read is
   * stored state that disagrees and fails closed with `CollectionCorruptState`; a counter that
   * changed in between was a concurrent write and is reported as `CollectionConflict`. The
   * listing can span several pages, so a delete and a create during it can leave the count
   * unchanged while the listing missed a row; every write also advances the counter's
   * generation, which tells that churn apart from corrupt state.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @returns The verified count and generation, which the increment then requires to be
   *   unchanged, so a write that overlapped the listing fails the creation instead of
   *   committing on a count the listing did not really observe.
   */
  private async verifiedCount(workspaceId: string): Promise<CollectionCounter> {
    let counter = await this.readCounter(workspaceId)
    if (counter === undefined) {
      await this.initializeCounter(workspaceId)
      counter = await this.readCounter(workspaceId)
      // The initialization either wrote the row or lost to another one; a miss is unexpected.
      if (counter === undefined) throw corruptState()
    }
    const live = (await this.listSummaries(workspaceId)).length
    if (live !== counter.count) {
      const reread = await this.readCounter(workspaceId)
      if (reread?.count !== counter.count || reread.generation !== counter.generation) throw conflict()
      throw corruptState()
    }
    if (counter.count >= COLLECTION_LIMIT) throw limitReached()
    // The creation increments the generation it verified; one at the bound has no room left.
    if (counter.generation >= COLLECTION_COUNTER_GENERATION_LIMIT) throw corruptState()
    return counter
  }

  /**
   * Reads the Workspace counter row.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @returns The stored count and write generation, or undefined when the row is missing.
   * @throws CollectionError `CollectionCorruptState` when the row is not a valid counter.
   */
  private async readCounter(workspaceId: string): Promise<CollectionCounter | undefined> {
    const { Item: row } = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: COLLECTION_COUNT_RECORD_KEY },
      ConsistentRead: true,
    })).catch((error: unknown) => storageFailure(error))
    if (row === undefined) return undefined
    const count: unknown = row.count
    // A counter no create or delete has touched has no generation yet; `ADD` then writes 1, so
    // a stored generation is always positive.
    const generation: unknown = row.generation ?? 0
    if (
      row.entryType !== COLLECTION_COUNT_ENTRY_TYPE ||
      typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 ||
      typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0 ||
      (row.generation !== undefined && generation === 0)
    ) {
      throw corruptState()
    }
    return { count, generation }
  }

  /**
   * Explains why the creation counter condition failed.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @returns `missing` when no counter row exists, `CollectionLimitReached` for a valid full
   *   counter, otherwise `CollectionConflict` because the counter changed after it was verified.
   * @throws CollectionError `CollectionCorruptState` when the counter row is invalid.
   */
  private async classifyCounterFailure(workspaceId: string): Promise<CollectionError | 'missing'> {
    // An invalid counter row throws `CollectionCorruptState` from the read.
    const counter = await this.readCounter(workspaceId)
    if (counter === undefined) return 'missing'
    // A concurrent write can change the counter after it was verified; retry then.
    return counter.count >= COLLECTION_LIMIT ? limitReached() : conflict()
  }

  /**
   * Creates a missing counter row from the live Collection rows.
   *
   * While the counter is missing, creations fail their counter condition and deletions fail
   * their decrement, so the live rows cannot change between this count and the write. The
   * write only creates the row, so a concurrent initialization by another request wins.
   * The count reads the same validated metadata as a listing, so a malformed or foreign row
   * under the Collection prefix, or more rows than `COLLECTION_LIMIT`, fails closed with
   * `CollectionCorruptState` before any counter is written.
   *
   * @param workspaceId - Server-resolved Workspace.
   */
  private async initializeCounter(workspaceId: string): Promise<void> {
    const count = (await this.listSummaries(workspaceId)).length
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { workspaceId, recordKey: COLLECTION_COUNT_RECORD_KEY, entryType: COLLECTION_COUNT_ENTRY_TYPE, count },
        ConditionExpression: 'attribute_not_exists(recordKey)',
      }))
    } catch (error) {
      const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
      if (name !== 'ConditionalCheckFailedException') storageFailure(error)
    }
  }

  /**
   * Builds the conditions that the canonical Work Item is still at the observed revision and
   * that the caller still holds the Project membership that authorized reading it.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param fence - Work Item, its observed revision, and the authorizing Project.
   * @returns Transaction condition checks.
   */
  private async workItemChecks(workspaceId: string, fence: CollectionWorkItemFence): Promise<CollectionTransactItem[]> {
    // Without either fence a stale readability check could commit; refuse instead.
    const projectId = fence.accessProjectId ?? fence.activeProjectId
    if (!this.workItemFenceCheck || (projectId !== undefined && !this.projectAccessCheck)) {
      throw new CollectionError(503, 'CollectionAuthorizationUnavailable', 'Caller authorization is unavailable.')
    }
    const checks: CollectionTransactItem[] = [this.workItemFenceCheck(workspaceId, fence)]
    if (projectId !== undefined && this.projectAccessCheck) {
      checks.push(...await this.projectAccessCheck(workspaceId, fence.teamId, projectId, fence.accessProjectId !== undefined))
    }
    return checks
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
   * @param verified - When creating, the counter state verified against the live rows.
   * @returns Transaction item that adjusts the counter.
   */
  private counterUpdate(workspaceId: string, delta: 1 | -1, verified: CollectionCounter = { count: 0, generation: 0 }) {
    return {
      Update: {
        TableName: this.tableName,
        Key: { workspaceId, recordKey: COLLECTION_COUNT_RECORD_KEY },
        // Every create and delete advances the generation, so a reconciliation can detect writes
        // that left the count unchanged.
        UpdateExpression: 'ADD #count :delta, #generation :one SET #entryType = :entryType',
        // Both directions need an existing counter. A creation requires the count it verified
        // against the live rows, because a missing or undercounted counter would let a restored
        // partition exceed the limit. A decrement also needs a positive count; otherwise the
        // partition is corrupt and a counter at -1 would allow overflow.
        // A creation also requires the generation it verified: a delete and a create during the
        // paged reconciliation leave the count unchanged but advance the generation. A counter
        // that no create or delete has touched yet has no generation attribute.
        ConditionExpression: delta === 1
          ? '#entryType = :entryType AND #count = :verified AND #count < :limit AND ' +
            (verified.generation === 0 ? 'attribute_not_exists(#generation)' : '#generation = :generation')
          // A decrement does not read the counter first, so the condition itself keeps room for
          // the generation increment; a creation's verified generation already passed the read.
          : '#count > :zero AND #entryType = :entryType AND ' +
            '(attribute_not_exists(#generation) OR #generation < :generationLimit)',
        ExpressionAttributeNames: { '#count': 'count', '#entryType': 'entryType', '#generation': 'generation' },
        ExpressionAttributeValues: {
          ':delta': delta,
          ':one': 1,
          ':entryType': COLLECTION_COUNT_ENTRY_TYPE,
          ...(delta === 1
            ? { ':verified': verified.count, ':limit': COLLECTION_LIMIT }
            : { ':zero': 0, ':generationLimit': COLLECTION_COUNTER_GENERATION_LIMIT }),
          ...(delta === 1 && verified.generation !== 0 ? { ':generation': verified.generation } : {}),
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
  /** Current canonical Work Item revision, or undefined when it no longer exists. */
  private readonly readWorkItemRevision: ((teamId: string, issueId: string) => number | undefined) | undefined

  /**
   * Creates the store.
   *
   * @param readWorkItemRevision - Current Work Item revisions; when given, reference changes
   *   require the observed revision like the DynamoDB condition check does.
   */
  constructor(readWorkItemRevision?: (teamId: string, issueId: string) => number | undefined) {
    this.readWorkItemRevision = readWorkItemRevision
  }

  /**
   * Returns this store, or a view whose reference changes first require the Project
   * membership builder to succeed; condition checks themselves are verified by the DynamoDB
   * adapter tests.
   *
   * @param _checks - Caller authorization conditions.
   * @param projectAccessCheck - Project membership condition builder, as in the DynamoDB store.
   * @returns Request-local store.
   */
  withCallerAuthorization(
    _checks: readonly PlanningCallerAuthorizationConditionCheck[],
    projectAccessCheck?: CollectionProjectAccessCheck,
  ): CollectionsStore {
    if (!projectAccessCheck) return this
    return {
      listSummaries: (workspaceId) => this.listSummaries(workspaceId),
      get: (workspaceId, collectionId) => this.get(workspaceId, collectionId),
      readDeletion: (workspaceId, collectionId) => this.readDeletion(workspaceId, collectionId),
      delete: (workspaceId, collectionId, expectedRevision, deletion) => this.delete(workspaceId, collectionId, expectedRevision, deletion),
      put: async (workspaceId, collection, expectedRevision, workItemFence) => {
        const projectId = workItemFence?.accessProjectId ?? workItemFence?.activeProjectId
        if (workItemFence && projectId !== undefined) {
          await projectAccessCheck(workspaceId, workItemFence.teamId, projectId, workItemFence.accessProjectId !== undefined)
        }
        await this.put(workspaceId, collection, expectedRevision, workItemFence)
      },
    }
  }

  /**
   * Lists the metadata of the Workspace's Collections.
   *
   * @param workspaceId - Test Workspace.
   * @returns Collection metadata.
   */
  async listSummaries(workspaceId: string): Promise<WorkItemCollection[]> {
    const prefix = `${JSON.stringify(workspaceId)}:`
    return [...this.collections.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, collection]) => toPublicCollection(collection))
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
   * @param workItemFence - Work Item whose observed revision must still be current.
   */
  async put(workspaceId: string, collection: StoredCollection, expectedRevision: number, workItemFence?: CollectionWorkItemFence): Promise<void> {
    const key = memoryKey(workspaceId, collection.collectionId)
    if ((this.collections.get(key)?.revision ?? 0) !== expectedRevision || (expectedRevision === 0 && this.deleted.has(key))) throw conflict()
    if (expectedRevision === 0 && (await this.listSummaries(workspaceId)).length >= COLLECTION_LIMIT) throw limitReached()
    if (
      workItemFence && this.readWorkItemRevision &&
      this.readWorkItemRevision(workItemFence.teamId, workItemFence.issueId) !== workItemFence.revision
    ) {
      throw new CollectionError(409, 'CollectionWorkItemChanged', 'The Work Item changed. Reload and try again.')
    }
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
 * Validates a listed summary row and strips its storage attributes.
 *
 * @param workspaceId - Partition that was read.
 * @param row - Projected item.
 * @returns The Collection metadata.
 */
function readSummaryRow(workspaceId: string, row: Record<string, unknown>): WorkItemCollection {
  const { workspaceId: rowWorkspaceId, recordKey: rowRecordKey, entryType, schemaVersion, ...summary } = row
  if (
    rowWorkspaceId !== workspaceId ||
    entryType !== COLLECTION_ENTRY_TYPE ||
    schemaVersion !== COLLECTION_SCHEMA_VERSION ||
    !isCollectionSummary(summary) ||
    rowRecordKey !== recordKey(summary.collectionId)
  ) {
    throw corruptState()
  }
  return toPublicCollection(summary)
}

/**
 * Creates the shared corrupt-state error.
 *
 * @returns A 502 Collection error.
 */
function corruptState(): CollectionError {
  return new CollectionError(502, 'CollectionCorruptState', 'Collection data is invalid.')
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
