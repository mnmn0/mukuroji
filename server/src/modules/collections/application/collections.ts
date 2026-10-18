import { createHash } from 'node:crypto'
import {
  COLLECTION_ITEM_LIMIT,
  type AddWorkItemCollectionItemResponse,
  type CreateWorkItemCollectionInput,
  type UpdateWorkItemCollectionInput,
  type WorkItemCollection,
  type WorkItemCollectionEntry,
} from '@mukuroji/contracts'
import { CollectionError, toPublicCollection, type CollectionDeletion, type StoredCollection } from '../domain/collections'

/** Persistence port for Workspace Collections.
 *
 * Creating (`expectedRevision` 0) fails with `409 CollectionLimitReached` once the
 * Workspace holds `COLLECTION_LIMIT` Collections; the store enforces this atomically.
 */
export interface CollectionsStore {
  /**
   * Lists the metadata of every Collection in a Workspace, without reading their references.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @returns Collection metadata in any order.
   */
  listSummaries(workspaceId: string): Promise<WorkItemCollection[]>
  /**
   * Reads one Collection.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @returns The Collection, or undefined when it does not exist.
   */
  get(workspaceId: string, collectionId: string): Promise<StoredCollection | undefined>
  /**
   * Reads the deletion marker of a Collection.
   *
   * Deletion leaves a permanent marker so that replaying the original creation request
   * cannot bring the Collection back, while reusing its key for another request still
   * reports an idempotency conflict.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @returns The deletion record, or undefined when the Collection was never deleted.
   */
  readDeletion(workspaceId: string, collectionId: string): Promise<CollectionDeletion | undefined>
  /**
   * Writes a Collection when its stored revision still matches.
   *
   * Creating (`expectedRevision` 0) also fails when the Collection was deleted. With a
   * `workItemFence`, the write also fails with `409 CollectionWorkItemChanged` unless the
   * canonical Work Item still exists at the observed revision.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collection - Complete next state.
   * @param expectedRevision - Stored revision, or 0 to create.
   * @param workItemFence - Work Item whose readability authorized the change.
   */
  put(workspaceId: string, collection: StoredCollection, expectedRevision: number, workItemFence?: CollectionWorkItemFence): Promise<void>
  /**
   * Deletes a Collection when its stored revision still matches and records the deletion.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @param expectedRevision - Stored revision.
   * @param deletion - Creation details kept in the deletion marker.
   */
  delete(workspaceId: string, collectionId: string, expectedRevision: number, deletion: CollectionDeletion): Promise<void>
}

/** Caller and clock used by Collection mutations. */
export type CollectionMutationContext = {
  /** Server-resolved Workspace. */
  workspaceId: string
  /** Member key of the caller. */
  actor: string
  /** Current time as an ISO timestamp. */
  now: string
}

/** Readable canonical Work Item fields shown in a Collection. */
export type ReadableCollectionWorkItem = Omit<WorkItemCollectionEntry, 'addedAt'>

/** Readable Work Item together with the canonical revision its readability was checked at. */
export type ObservedCollectionWorkItem = {
  /** Fields shown in a Collection. */
  entry: ReadableCollectionWorkItem
  /** Canonical Work Item revision read during the check. */
  revision: number
  /**
   * Project whose direct membership authorized reading the Work Item, when that membership
   * must still hold when the change commits; undefined when no Project membership is involved.
   */
  accessProjectId?: string
  /**
   * Project whose Enterprise grant authorized reading the Work Item without a direct
   * membership; it must still be active when the change commits.
   */
  activeProjectId?: string
}

/** Canonical Work Item state that a reference change requires to be unchanged when it commits. */
export type CollectionWorkItemFence = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item identifier. */
  issueId: string
  /** Canonical revision observed by the readability check. */
  revision: number
  /** Project whose direct membership authorized the readability check, when any. */
  accessProjectId?: string
  /** Project whose Enterprise grant authorized the readability check, when any. */
  activeProjectId?: string
}

/**
 * Reads a Work Item for the caller.
 *
 * Returns undefined when the Work Item does not exist or the caller cannot read it,
 * and throws for unexpected failures.
 */
export type ReadCollectionWorkItem = (teamId: string, issueId: string) => Promise<ObservedCollectionWorkItem | undefined>

/** Number of Work Item reads issued at once while listing a Collection. */
const ITEM_READ_CONCURRENCY = 10

/**
 * Lists Collections ordered by name.
 *
 * @param store - Collection persistence.
 * @param workspaceId - Server-resolved Workspace.
 * @returns Collection metadata without references.
 */
export async function listCollections(store: CollectionsStore, workspaceId: string): Promise<WorkItemCollection[]> {
  const collections = await store.listSummaries(workspaceId)
  return collections
    .map(toPublicCollection)
    .sort((left, right) => left.name.localeCompare(right.name) || left.collectionId.localeCompare(right.collectionId))
}

/**
 * Creates a Collection with an identifier derived from the idempotency key.
 *
 * Retrying with the same key returns the Collection created by the first request.
 *
 * @param store - Collection persistence.
 * @param context - Caller and clock.
 * @param input - Validated name and description.
 * @param idempotencyKey - Client retry key.
 * @returns The created Collection.
 */
export async function createCollection(
  store: CollectionsStore,
  context: CollectionMutationContext,
  input: CreateWorkItemCollectionInput,
  idempotencyKey: string,
): Promise<WorkItemCollection> {
  const collectionId = createHash('sha256')
    .update(JSON.stringify([context.workspaceId, context.actor, idempotencyKey]))
    .digest('hex')
    .slice(0, 32)
  const createFingerprint = createHash('sha256')
    .update(JSON.stringify([input.name, input.description ?? '']))
    .digest('hex')
  // The marker is read before the live row. Deletion atomically removes the row and writes the
  // marker, and nothing recreates a deleted Collection, so a delete that commits between the two
  // reads is seen as a missing row, never as both. A row read after its marker is contradictory.
  const deletion = await store.readDeletion(context.workspaceId, collectionId)
  const existing = await store.get(context.workspaceId, collectionId)
  // A live row next to its deletion marker is contradictory; never replay it as created.
  if (existing && deletion) throw corruptState()
  if (existing) return replayCreatedCollection(existing, context.actor, createFingerprint)
  if (deletion) throw replayDeletedCollection(deletion, createFingerprint)
  const collection: StoredCollection = {
    collectionId,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    createdBy: context.actor,
    createdAt: context.now,
    updatedAt: context.now,
    revision: 1,
    items: [],
    createFingerprint,
  }
  try {
    await store.put(context.workspaceId, collection, 0)
  } catch (error) {
    const raced = error instanceof CollectionError && error.status === 409
      ? await store.get(context.workspaceId, collectionId)
      : undefined
    if (raced) return replayCreatedCollection(raced, context.actor, createFingerprint)
    const racedDeletion = error instanceof CollectionError && error.status === 409
      ? await store.readDeletion(context.workspaceId, collectionId)
      : undefined
    if (racedDeletion) throw replayDeletedCollection(racedDeletion, createFingerprint)
    throw error
  }
  return toPublicCollection(collection)
}

/**
 * Renames or re-describes a Collection.
 *
 * @param store - Collection persistence.
 * @param context - Caller and clock.
 * @param collectionId - Collection identifier.
 * @param input - Validated change with the observed revision.
 * @returns The updated Collection.
 */
export async function updateCollection(
  store: CollectionsStore,
  context: CollectionMutationContext,
  collectionId: string,
  input: UpdateWorkItemCollectionInput,
): Promise<WorkItemCollection> {
  const current = await requireCollection(store, context.workspaceId, collectionId)
  const description = input.description === undefined ? current.description : input.description
  // A retry after a lost response finds its own change already applied; report it as done
  // instead of a conflict. Nothing changes, so no write is needed.
  if (current.name === (input.name ?? current.name) && (current.description ?? '') === (description ?? '')) {
    return toPublicCollection(current)
  }
  if (current.revision !== input.expectedRevision) throw conflict()
  const next: StoredCollection = {
    collectionId: current.collectionId,
    name: input.name ?? current.name,
    ...(description ? { description } : {}),
    createdBy: current.createdBy,
    createdAt: current.createdAt,
    updatedAt: context.now,
    revision: nextRevision(current.revision),
    items: current.items,
    createFingerprint: current.createFingerprint,
  }
  await store.put(context.workspaceId, next, current.revision)
  return toPublicCollection(next)
}

/**
 * Deletes a Collection; the referenced Work Items are not changed.
 *
 * @param store - Collection persistence.
 * @param workspaceId - Server-resolved Workspace.
 * @param collectionId - Collection identifier.
 * @param expectedRevision - Observed revision.
 */
export async function deleteCollection(
  store: CollectionsStore,
  workspaceId: string,
  collectionId: string,
  expectedRevision: number,
): Promise<void> {
  const current = await store.get(workspaceId, collectionId)
  if (!current) {
    // A retry after a lost response finds only the deletion marker of the revision it deleted;
    // a stale delete of another revision is not reported as done.
    const deletion = await store.readDeletion(workspaceId, collectionId)
    if (deletion?.deletedRevision === expectedRevision) return
    throw new CollectionError(404, 'CollectionNotFound', 'The Collection was not found.')
  }
  if (current.revision !== expectedRevision) throw conflict()
  await store.delete(workspaceId, collectionId, expectedRevision, {
    createFingerprint: current.createFingerprint,
    deletedRevision: current.revision,
  })
}

/** Largest encoded Collection row, kept well below DynamoDB's 400 KB item limit. */
const COLLECTION_ROW_BYTE_LIMIT = 350_000

/**
 * Adds a Work Item reference to a Collection.
 *
 * The caller must already be able to read the Work Item; that check is done by
 * `readWorkItem`, and the write requires the Work Item to still be at the revision that
 * check read. Adding an existing reference is a no-op.
 *
 * @param store - Collection persistence.
 * @param context - Caller and clock.
 * @param collectionId - Collection identifier.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param readWorkItem - Caller-scoped Work Item reader.
 * @returns The Collection after the change and the Work Item as the caller can read it.
 */
export async function addCollectionItem(
  store: CollectionsStore,
  context: CollectionMutationContext,
  collectionId: string,
  teamId: string,
  issueId: string,
  readWorkItem: ReadCollectionWorkItem,
): Promise<AddWorkItemCollectionItemResponse> {
  const { collection, observed } = await applyItemChange(store, context.workspaceId, collectionId, teamId, issueId, readWorkItem, (current) => {
    if (current.items.some((item) => item.teamId === teamId && item.issueId === issueId)) return undefined
    if (current.items.length >= COLLECTION_ITEM_LIMIT) {
      throw new CollectionError(409, 'CollectionItemLimitReached', `A Collection can hold up to ${COLLECTION_ITEM_LIMIT} Work Items.`)
    }
    // A retry rebuilds on newer state, and another server's clock may lag, so the new item must
    // not look older than the Collection's last change or the newest item already there; most
    // recently added first stays true, which the stored-row validator requires.
    const addedAt = laterInstant(laterInstant(context.now, current.updatedAt), current.items[0]?.addedAt ?? context.now)
    const next = {
      ...current,
      items: [{ teamId, issueId, addedAt, addedBy: context.actor }, ...current.items],
      updatedAt: addedAt,
      revision: nextRevision(current.revision),
    }
    // References are stored inline, so long identifiers can reach DynamoDB's 400 KB item limit
    // before the count limit; report that as the same item-limit conflict.
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > COLLECTION_ROW_BYTE_LIMIT) {
      throw new CollectionError(409, 'CollectionItemLimitReached', 'This Collection cannot hold more Work Items.')
    }
    return next
  })
  const stored = collection.items.find((item) => item.teamId === teamId && item.issueId === issueId)
  // The reference was just written or found in this state, so it is always present.
  if (!stored) throw corruptState()
  return { ...toPublicCollection(collection), item: { ...observed.entry, addedAt: stored.addedAt } }
}

/**
 * Removes a Work Item reference from a Collection; the Work Item itself is not changed.
 *
 * The caller must be able to read the Work Item, so a hidden reference can be neither
 * removed nor probed; the write requires the Work Item to still be at the revision that
 * check read. Removing a reference that is not present is a no-op.
 *
 * @param store - Collection persistence.
 * @param context - Caller and clock.
 * @param collectionId - Collection identifier.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param readWorkItem - Caller-scoped Work Item reader.
 * @returns The Collection after the change.
 */
export async function removeCollectionItem(
  store: CollectionsStore,
  context: CollectionMutationContext,
  collectionId: string,
  teamId: string,
  issueId: string,
  readWorkItem: ReadCollectionWorkItem,
): Promise<WorkItemCollection> {
  const { collection } = await applyItemChange(store, context.workspaceId, collectionId, teamId, issueId, readWorkItem, (current) => {
    const items = current.items.filter((item) => item.teamId !== teamId || item.issueId !== issueId)
    if (items.length === current.items.length) return undefined
    return { ...current, items, updatedAt: laterInstant(context.now, current.updatedAt), revision: nextRevision(current.revision) }
  })
  return toPublicCollection(collection)
}

/** Attempts for a set-like item change that races another writer. */
const ITEM_CHANGE_ATTEMPTS = 3

/**
 * Applies a set-like item change, rereading and reapplying it after a concurrent write.
 *
 * Each attempt first checks that the caller can read the Work Item and then writes with a
 * fence on the Work Item revision and the Project membership that check relied on, so a
 * Work Item deleted or moved, or a membership revoked, in between never has its reference
 * changed. Adding or removing one
 * reference does not depend on the rest of the Collection, so a revision conflict or a
 * changed Work Item is retried against the current state; a concurrent identical change
 * then becomes a no-op instead of a reported failure.
 *
 * @param store - Collection persistence.
 * @param workspaceId - Server-resolved Workspace.
 * @param collectionId - Collection identifier.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param readWorkItem - Caller-scoped Work Item reader.
 * @param change - Returns the next state, or undefined when the change is already applied.
 * @returns The stored Collection after the change and the Work Item read by the last attempt.
 */
async function applyItemChange(
  store: CollectionsStore,
  workspaceId: string,
  collectionId: string,
  teamId: string,
  issueId: string,
  readWorkItem: ReadCollectionWorkItem,
  change: (current: StoredCollection) => StoredCollection | undefined,
): Promise<{ collection: StoredCollection; observed: ObservedCollectionWorkItem }> {
  for (let attempt = 1; ; attempt += 1) {
    const observed = await readWorkItem(teamId, issueId)
    if (!observed) throw new CollectionError(404, 'CollectionWorkItemNotFound', 'The Work Item was not found.')
    const current = await requireCollection(store, workspaceId, collectionId)
    const next = change(current)
    if (!next) return { collection: current, observed }
    try {
      await store.put(workspaceId, next, current.revision, {
        teamId,
        issueId,
        revision: observed.revision,
        ...(observed.accessProjectId === undefined ? {} : { accessProjectId: observed.accessProjectId }),
        ...(observed.activeProjectId === undefined ? {} : { activeProjectId: observed.activeProjectId }),
      })
      return { collection: next, observed }
    } catch (error) {
      const retryable = error instanceof CollectionError &&
        (error.code === 'CollectionConflict' || error.code === 'CollectionWorkItemChanged')
      if (!retryable || attempt >= ITEM_CHANGE_ATTEMPTS) throw error
    }
  }
}

/**
 * Lists the Work Items of a Collection that the caller can read.
 *
 * References the caller cannot read, including deleted Work Items, are omitted, so a
 * Collection never widens visibility.
 *
 * @param store - Collection persistence.
 * @param workspaceId - Server-resolved Workspace.
 * @param collectionId - Collection identifier.
 * @param readWorkItem - Caller-scoped Work Item reader.
 * @returns The Collection and its readable entries, most recently added first.
 */
export async function listCollectionEntries(
  store: CollectionsStore,
  workspaceId: string,
  collectionId: string,
  readWorkItem: ReadCollectionWorkItem,
): Promise<{ collection: WorkItemCollection; items: WorkItemCollectionEntry[] }> {
  const current = await requireCollection(store, workspaceId, collectionId)
  const entries: (WorkItemCollectionEntry | undefined)[] = Array.from({ length: current.items.length })
  for (let start = 0; start < current.items.length; start += ITEM_READ_CONCURRENCY) {
    const batch = current.items.slice(start, start + ITEM_READ_CONCURRENCY)
    const results = await Promise.all(batch.map((item) => readWorkItem(item.teamId, item.issueId)))
    results.forEach((workItem, offset) => {
      const item = batch[offset]
      if (workItem && item) entries[start + offset] = { ...workItem.entry, addedAt: item.addedAt }
    })
  }
  return {
    collection: toPublicCollection(current),
    items: entries.filter((entry): entry is WorkItemCollectionEntry => entry !== undefined),
  }
}

/**
 * Reads a Collection or fails with 404.
 *
 * @param store - Collection persistence.
 * @param workspaceId - Server-resolved Workspace.
 * @param collectionId - Collection identifier.
 * @returns The stored Collection.
 */
async function requireCollection(store: CollectionsStore, workspaceId: string, collectionId: string): Promise<StoredCollection> {
  const collection = await store.get(workspaceId, collectionId)
  if (!collection) throw new CollectionError(404, 'CollectionNotFound', 'The Collection was not found.')
  return collection
}

/**
 * Returns the Collection created by an earlier request with the same idempotency key.
 *
 * The comparison uses the fingerprint stored at creation, so a retry still succeeds
 * after the Collection was renamed or its items changed.
 *
 * @param existing - Collection stored under the derived identifier.
 * @param actor - Current caller.
 * @param createFingerprint - Fingerprint of the current request.
 * @returns The Collection created by the earlier request.
 */
function replayCreatedCollection(existing: StoredCollection, actor: string, createFingerprint: string): WorkItemCollection {
  if (existing.createdBy !== actor || existing.createFingerprint !== createFingerprint) {
    throw new CollectionError(409, 'CollectionIdempotencyConflict', 'The idempotency key was used for a different request.')
  }
  return toPublicCollection(existing)
}

/**
 * Creates the error for a creation whose idempotency key belongs to a deleted Collection.
 *
 * @param deletion - Deletion marker of the Collection created with this key.
 * @param createFingerprint - Fingerprint of the current request.
 * @returns `CollectionDeleted` for a replay of the original request, otherwise an idempotency conflict.
 */
function replayDeletedCollection(deletion: CollectionDeletion, createFingerprint: string): CollectionError {
  if (deletion.createFingerprint !== createFingerprint) {
    return new CollectionError(409, 'CollectionIdempotencyConflict', 'The idempotency key was used for a different request.')
  }
  return new CollectionError(409, 'CollectionDeleted', 'The Collection created by this request was deleted. Use a new idempotency key to create another.')
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
 * Computes the revision a change writes.
 *
 * The stored-row validator only accepts revisions below `Number.MAX_SAFE_INTEGER`, so a change
 * that would write one is rejected before the write instead of leaving an unreadable row.
 *
 * @param revision - Revision of the state being replaced.
 * @returns The next revision.
 * @throws CollectionError `CollectionCorruptState` when no valid next revision remains.
 */
function nextRevision(revision: number): number {
  if (revision + 1 >= Number.MAX_SAFE_INTEGER) throw corruptState()
  return revision + 1
}

/**
 * Picks the later of two ISO instants.
 *
 * A retry after a lost race rebuilds on a state written after this request started, so
 * `updatedAt` must not move back behind that newer change.
 *
 * @param now - Time of the current request.
 * @param stored - `updatedAt` of the state being replaced.
 * @returns The later instant.
 */
function laterInstant(now: string, stored: string): string {
  return Date.parse(stored) > Date.parse(now) ? stored : now
}

/**
 * Creates the error for contradictory persisted Collection state.
 *
 * @returns A 502 Collection error.
 */
function corruptState(): CollectionError {
  return new CollectionError(502, 'CollectionCorruptState', 'Collection data is invalid.')
}
