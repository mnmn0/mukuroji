import { createHash } from 'node:crypto'
import {
  COLLECTION_ITEM_LIMIT,
  type CreateWorkItemCollectionInput,
  type UpdateWorkItemCollectionInput,
  type WorkItemCollection,
  type WorkItemCollectionEntry,
} from '@mukuroji/contracts'
import { CollectionError, toPublicCollection, type StoredCollection } from '../domain/collections'

/** Persistence port for Workspace Collections.
 *
 * Creating (`expectedRevision` 0) fails with `409 CollectionLimitReached` once the
 * Workspace holds `COLLECTION_LIMIT` Collections; the store enforces this atomically.
 */
export interface CollectionsStore {
  /**
   * Lists every Collection in a Workspace.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @returns Stored Collections in any order.
   */
  list(workspaceId: string): Promise<StoredCollection[]>
  /**
   * Reads one Collection.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @returns The Collection, or undefined when it does not exist.
   */
  get(workspaceId: string, collectionId: string): Promise<StoredCollection | undefined>
  /**
   * Writes a Collection when its stored revision still matches.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collection - Complete next state.
   * @param expectedRevision - Stored revision, or 0 to create.
   */
  put(workspaceId: string, collection: StoredCollection, expectedRevision: number): Promise<void>
  /**
   * Deletes a Collection when its stored revision still matches.
   *
   * @param workspaceId - Server-resolved Workspace.
   * @param collectionId - Collection identifier.
   * @param expectedRevision - Stored revision.
   */
  delete(workspaceId: string, collectionId: string, expectedRevision: number): Promise<void>
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

/**
 * Reads a Work Item for the caller.
 *
 * Returns undefined when the Work Item does not exist or the caller cannot read it,
 * and throws for unexpected failures.
 */
export type ReadCollectionWorkItem = (teamId: string, issueId: string) => Promise<ReadableCollectionWorkItem | undefined>

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
  const collections = await store.list(workspaceId)
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
  const existing = await store.get(context.workspaceId, collectionId)
  if (existing) return replayCreatedCollection(existing, context.actor, createFingerprint)
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
  if (current.revision !== input.expectedRevision) throw conflict()
  const description = input.description === undefined ? current.description : input.description
  const next: StoredCollection = {
    collectionId: current.collectionId,
    name: input.name ?? current.name,
    ...(description ? { description } : {}),
    createdBy: current.createdBy,
    createdAt: current.createdAt,
    updatedAt: context.now,
    revision: current.revision + 1,
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
  const current = await requireCollection(store, workspaceId, collectionId)
  if (current.revision !== expectedRevision) throw conflict()
  await store.delete(workspaceId, collectionId, expectedRevision)
}

/**
 * Adds a Work Item reference to a Collection.
 *
 * The caller must already be able to read the Work Item; that check is done by
 * `readWorkItem`. Adding an existing reference is a no-op.
 *
 * @param store - Collection persistence.
 * @param context - Caller and clock.
 * @param collectionId - Collection identifier.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param readWorkItem - Caller-scoped Work Item reader.
 * @returns The Collection after the change.
 */
export async function addCollectionItem(
  store: CollectionsStore,
  context: CollectionMutationContext,
  collectionId: string,
  teamId: string,
  issueId: string,
  readWorkItem: ReadCollectionWorkItem,
): Promise<WorkItemCollection> {
  if (!await readWorkItem(teamId, issueId)) {
    throw new CollectionError(404, 'CollectionWorkItemNotFound', 'The Work Item was not found.')
  }
  const current = await requireCollection(store, context.workspaceId, collectionId)
  if (current.items.some((item) => item.teamId === teamId && item.issueId === issueId)) {
    return toPublicCollection(current)
  }
  if (current.items.length >= COLLECTION_ITEM_LIMIT) {
    throw new CollectionError(409, 'CollectionItemLimitReached', `A Collection can hold up to ${COLLECTION_ITEM_LIMIT} Work Items.`)
  }
  const next: StoredCollection = {
    ...current,
    items: [{ teamId, issueId, addedAt: context.now, addedBy: context.actor }, ...current.items],
    updatedAt: context.now,
    revision: current.revision + 1,
  }
  await store.put(context.workspaceId, next, current.revision)
  return toPublicCollection(next)
}

/**
 * Removes a Work Item reference from a Collection; the Work Item itself is not changed.
 *
 * The caller must be able to read the Work Item, so a hidden reference can be neither
 * removed nor probed. Removing a reference that is not present is a no-op.
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
  if (!await readWorkItem(teamId, issueId)) {
    throw new CollectionError(404, 'CollectionWorkItemNotFound', 'The Work Item was not found.')
  }
  const current = await requireCollection(store, context.workspaceId, collectionId)
  const items = current.items.filter((item) => item.teamId !== teamId || item.issueId !== issueId)
  if (items.length === current.items.length) return toPublicCollection(current)
  const next: StoredCollection = { ...current, items, updatedAt: context.now, revision: current.revision + 1 }
  await store.put(context.workspaceId, next, current.revision)
  return toPublicCollection(next)
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
      if (workItem && item) entries[start + offset] = { ...workItem, addedAt: item.addedAt }
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
 * Creates the shared stale-revision error.
 *
 * @returns A 409 Collection error.
 */
function conflict(): CollectionError {
  return new CollectionError(409, 'CollectionConflict', 'The Collection changed. Reload and try again.')
}
