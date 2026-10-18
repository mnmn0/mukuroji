import { expect, test } from 'bun:test'
import { COLLECTION_ITEM_LIMIT, COLLECTION_LIMIT } from '@mukuroji/contracts'
import { InMemoryCollectionsStore } from './adapter-out/collections-store'
import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  listCollectionEntries,
  removeCollectionItem,
  updateCollection,
  type ReadCollectionWorkItem,
} from './application/collections'
import { isStoredCollection, type StoredCollection } from './domain/collections'

const context = { workspaceId: 'w', actor: 'reader', now: '2026-10-16T00:00:00.000Z' }

/** Reader that can see every Work Item except those whose ID starts with `hidden`. */
const readWorkItem: ReadCollectionWorkItem = async (teamId, issueId) => issueId.startsWith('hidden')
  ? undefined
  : { entry: { teamId, issueId, title: `Title ${issueId}`, statusCategory: 'started' }, revision: 1 }

test('keeps the most recently added reference first and skips unreadable ones on read', async () => {
  const store = new InMemoryCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  for (const issueId of ['a', 'b', 'c']) {
    await addCollectionItem(store, { ...context, now: `2026-10-16T00:00:0${issueId.charCodeAt(0) - 96}.000Z` }, collectionId, 't', issueId, readWorkItem)
  }
  const stored = await store.get('w', collectionId)
  if (!stored) throw new Error('missing')
  await store.put('w', { ...stored, items: [{ teamId: 't', issueId: 'hidden-1', addedAt: context.now, addedBy: 'x' }, ...stored.items], revision: stored.revision + 1 }, stored.revision)

  const listed = await listCollectionEntries(store, 'w', collectionId, readWorkItem)
  expect(listed.items.map((item) => item.issueId)).toEqual(['c', 'b', 'a'])
  expect(listed.items[0]).toEqual({ teamId: 't', issueId: 'c', title: 'Title c', statusCategory: 'started', addedAt: '2026-10-16T00:00:03.000Z' })

  await removeCollectionItem(store, context, collectionId, 't', 'b', readWorkItem)
  expect((await listCollectionEntries(store, 'w', collectionId, readWorkItem)).items.map((item) => item.issueId)).toEqual(['c', 'a'])
})

test('rejects unreadable Work Items and enforces the item limit', async () => {
  const store = new InMemoryCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  await expect(addCollectionItem(store, context, collectionId, 't', 'hidden-1', readWorkItem))
    .rejects.toMatchObject({ status: 404, code: 'CollectionWorkItemNotFound' })
  const stored = await store.get('w', collectionId)
  if (!stored) throw new Error('missing')
  const items = Array.from({ length: COLLECTION_ITEM_LIMIT }, (_, index) => ({ teamId: 't', issueId: `i${index}`, addedAt: context.now, addedBy: 'reader' }))
  await store.put('w', { ...stored, items, revision: 2 }, 1)
  await expect(addCollectionItem(store, context, collectionId, 't', 'new', readWorkItem))
    .rejects.toMatchObject({ status: 409, code: 'CollectionItemLimitReached' })
  expect((await addCollectionItem(store, context, collectionId, 't', 'i0', readWorkItem)).revision).toBe(2)
})

test('propagates unexpected Work Item read failures instead of hiding items', async () => {
  const store = new InMemoryCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  await addCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)
  await expect(listCollectionEntries(store, 'w', collectionId, async () => {
    throw new Error('storage down')
  })).rejects.toThrow('storage down')
})

test('replays a creation after the Collection changed and enforces the Workspace limit', async () => {
  const store = new InMemoryCollectionsStore()
  const created = await createCollection(store, context, { name: 'Launch' }, 'key')
  await updateCollection(store, context, created.collectionId, { expectedRevision: 1, name: 'Renamed' })
  expect((await createCollection(store, context, { name: 'Launch' }, 'key')).collectionId).toBe(created.collectionId)
  await expect(createCollection(store, context, { name: 'Other' }, 'key')).rejects.toMatchObject({ code: 'CollectionIdempotencyConflict' })

  for (let index = 1; index < COLLECTION_LIMIT; index += 1) {
    await createCollection(store, context, { name: `C${index}` }, `key-${index}`)
  }
  await expect(createCollection(store, context, { name: 'One too many' }, 'overflow'))
    .rejects.toMatchObject({ status: 409, code: 'CollectionLimitReached' })
})

test('refuses to remove a reference the caller cannot read', async () => {
  const store = new InMemoryCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  await expect(removeCollectionItem(store, context, collectionId, 't', 'hidden-1', readWorkItem))
    .rejects.toMatchObject({ status: 404, code: 'CollectionWorkItemNotFound' })
})

test('does not resurrect a deleted Collection when its creation is replayed', async () => {
  const store = new InMemoryCollectionsStore()
  const created = await createCollection(store, context, { name: 'Launch' }, 'key')
  await deleteCollection(store, 'w', created.collectionId, 1)
  await expect(createCollection(store, context, { name: 'Launch' }, 'key'))
    .rejects.toMatchObject({ status: 409, code: 'CollectionDeleted' })
  // Reusing the key for a different request is still an idempotency conflict after deletion.
  await expect(createCollection(store, context, { name: 'Other' }, 'key'))
    .rejects.toMatchObject({ status: 409, code: 'CollectionIdempotencyConflict' })
  expect(await store.listSummaries('w')).toEqual([])
  expect((await createCollection(store, context, { name: 'Launch' }, 'new-key')).name).toBe('Launch')
})

test('treats a retried delete after a lost response as already done', async () => {
  const store = new InMemoryCollectionsStore()
  const created = await createCollection(store, context, { name: 'Launch' }, 'key')
  await deleteCollection(store, 'w', created.collectionId, 1)
  await expect(deleteCollection(store, 'w', created.collectionId, 1)).resolves.toBeUndefined()
  // A stale delete of another revision is not the lost-response retry.
  await expect(deleteCollection(store, 'w', created.collectionId, 2)).rejects.toMatchObject({ status: 404, code: 'CollectionNotFound' })
  await expect(deleteCollection(store, 'w', 'missing', 1)).rejects.toMatchObject({ status: 404, code: 'CollectionNotFound' })
})

test('stores Unicode and slash-containing canonical Work Item identifiers', async () => {
  const store = new InMemoryCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  await addCollectionItem(store, context, collectionId, 'チーム/日本', '課題-１', readWorkItem)
  expect((await listCollectionEntries(store, 'w', collectionId, readWorkItem)).items.map((item) => [item.teamId, item.issueId]))
    .toEqual([['チーム/日本', '課題-１']])
})

/** Store that lets another writer commit once between a request's read and its write. */
class RacingCollectionsStore extends InMemoryCollectionsStore {
  /** The concurrent change to commit after the next read, if any. */
  race: (() => Promise<unknown>) | undefined

  /**
   * Reads a Collection, then commits the pending concurrent change.
   *
   * @param workspaceId - Workspace.
   * @param collectionId - Collection identifier.
   * @returns The Collection as read before the concurrent change.
   */
  override async get(workspaceId: string, collectionId: string) {
    const current = await super.get(workspaceId, collectionId)
    const race = this.race
    this.race = undefined
    await race?.()
    return current
  }
}

test('keeps a newer updatedAt when a retry rebuilds on a later concurrent change', async () => {
  const store = new RacingCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  const later = { ...context, now: '2026-10-16T00:05:00.000Z' }
  store.race = () => addCollectionItem(store, later, collectionId, 't', 'b', readWorkItem)
  const added = await addCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)
  expect(added.revision).toBe(3)
  expect(added.updatedAt).toBe(later.now)
  // The retried item is the most recently added one and is not dated before the item it follows.
  const items = (await store.get('w', collectionId))?.items ?? []
  expect(items.map((item) => item.issueId)).toEqual(['a', 'b'])
  expect(items[0]?.addedAt).toBe(later.now)

  store.race = () => addCollectionItem(store, later, collectionId, 't', 'c', readWorkItem)
  const removed = await removeCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)
  expect(removed.updatedAt).toBe(later.now)
})

test('treats an overlapping identical add or remove as a no-op instead of a conflict', async () => {
  const store = new RacingCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  store.race = () => addCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)
  expect((await addCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)).revision).toBe(2)

  store.race = () => removeCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)
  expect((await removeCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)).revision).toBe(3)
  expect((await listCollectionEntries(store, 'w', collectionId, readWorkItem)).items).toEqual([])
})

test('replays a metadata update whose change is already applied instead of reporting a conflict', async () => {
  const store = new InMemoryCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  const renamed = await updateCollection(store, context, collectionId, { expectedRevision: 1, name: 'Launch plan' })
  expect(renamed.revision).toBe(2)
  // The response was lost; the same request is retried with the old revision.
  expect(await updateCollection(store, context, collectionId, { expectedRevision: 1, name: 'Launch plan' })).toMatchObject({ name: 'Launch plan', revision: 2 })
  // A different stale change still conflicts.
  await expect(updateCollection(store, context, collectionId, { expectedRevision: 1, name: 'Other' }))
    .rejects.toMatchObject({ status: 409, code: 'CollectionConflict' })
})

/** Store whose reads return a restored live row even after its deletion marker was written. */
class RestoredCollectionsStore extends InMemoryCollectionsStore {
  /** Live row put back by a restore, if any. */
  restored: StoredCollection | undefined

  /**
   * Reads the restored row when one is set, otherwise the stored Collection.
   *
   * @param workspaceId - Workspace.
   * @param collectionId - Collection identifier.
   * @returns The Collection, or undefined.
   */
  override async get(workspaceId: string, collectionId: string) {
    return this.restored?.collectionId === collectionId ? structuredClone(this.restored) : await super.get(workspaceId, collectionId)
  }
}

test('refuses to replay a creation whose live row also has a deletion marker', async () => {
  const store = new RestoredCollectionsStore()
  const created = await createCollection(store, context, { name: 'Launch' }, 'key')
  const live = await store.get('w', created.collectionId)
  await deleteCollection(store, 'w', created.collectionId, 1)
  // A restore puts the live row back next to its marker.
  store.restored = live
  await expect(createCollection(store, context, { name: 'Launch' }, 'key')).rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
})

/** Store that commits a deletion of a Collection right after one of its reads, as a concurrent request would. */
class RacingDeleteCollectionsStore extends InMemoryCollectionsStore {
  /** Read after which the deletion commits, if a race is armed. */
  deleteAfter: 'get' | 'readDeletion' | undefined

  /**
   * Reads the stored Collection, then commits the armed deletion.
   *
   * @param workspaceId - Workspace.
   * @param collectionId - Collection identifier.
   * @returns The Collection observed before the deletion, or undefined.
   */
  override async get(workspaceId: string, collectionId: string) {
    const collection = await super.get(workspaceId, collectionId)
    if (this.deleteAfter === 'get') await this.commitDeletion(workspaceId, collectionId)
    return collection
  }

  /**
   * Reads the deletion marker, then commits the armed deletion.
   *
   * @param workspaceId - Workspace.
   * @param collectionId - Collection identifier.
   * @returns The marker observed before the deletion, or undefined.
   */
  override async readDeletion(workspaceId: string, collectionId: string) {
    const deletion = await super.readDeletion(workspaceId, collectionId)
    if (this.deleteAfter === 'readDeletion') await this.commitDeletion(workspaceId, collectionId)
    return deletion
  }

  /**
   * Deletes the live Collection once and disarms the race.
   *
   * @param workspaceId - Workspace.
   * @param collectionId - Collection identifier.
   */
  private async commitDeletion(workspaceId: string, collectionId: string): Promise<void> {
    this.deleteAfter = undefined
    const live = await super.get(workspaceId, collectionId)
    if (live) await this.delete(workspaceId, collectionId, live.revision, { createFingerprint: live.createFingerprint, deletedRevision: live.revision })
  }
}

test('replays a creation consistently when a deletion commits between its live-row and marker reads', async () => {
  // Deleted after the marker read: the retry sees the deletion, exactly like a retry after the deletion.
  const afterMarker = new RacingDeleteCollectionsStore()
  const created = await createCollection(afterMarker, context, { name: 'Launch' }, 'key')
  afterMarker.deleteAfter = 'readDeletion'
  await expect(createCollection(afterMarker, context, { name: 'Launch' }, 'key'))
    .rejects.toMatchObject({ status: 409, code: 'CollectionDeleted' })
  await expect(createCollection(afterMarker, context, { name: 'Launch' }, 'key'))
    .rejects.toMatchObject({ status: 409, code: 'CollectionDeleted' })

  // Deleted after the live-row read: the Collection still existed when it was read, so the creation replays.
  const afterRow = new RacingDeleteCollectionsStore()
  await createCollection(afterRow, context, { name: 'Launch' }, 'key')
  afterRow.deleteAfter = 'get'
  expect((await createCollection(afterRow, context, { name: 'Launch' }, 'key')).collectionId).toBe(created.collectionId)
  expect(await afterRow.readDeletion('w', created.collectionId)).toBeDefined()
})

test('keeps the newest reference first when the previous change came from a server with a lagging clock', async () => {
  const store = new InMemoryCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  await addCollectionItem(store, { ...context, now: '2026-10-16T00:00:05.000Z' }, collectionId, 't', 'a', readWorkItem)
  // A rename on a lagging server moves updatedAt behind the newest reference.
  await updateCollection(store, { ...context, now: '2026-10-16T00:00:01.000Z' }, collectionId, { expectedRevision: 2, name: 'Renamed' })
  const added = await addCollectionItem(store, { ...context, now: '2026-10-16T00:00:03.000Z' }, collectionId, 't', 'b', readWorkItem)
  expect(added.item.addedAt).toBe('2026-10-16T00:00:05.000Z')
  const stored = await store.get('w', collectionId)
  expect(stored && isStoredCollection(stored)).toBe(true)
  expect(stored?.items.map((item) => item.issueId)).toEqual(['b', 'a'])
})

test('reports the item limit before a row would exceed the DynamoDB item size', async () => {
  const store = new InMemoryCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  // Valid but long identifiers: multibyte Team and Work Item IDs and a long member key.
  const long = (index: number) => `${'長'.repeat(250)}-${index}`
  const longActor = { ...context, actor: 'a'.repeat(500) }
  let failure: unknown
  let added = 0
  for (; added < COLLECTION_ITEM_LIMIT && failure === undefined; added += 1) {
    failure = await addCollectionItem(store, longActor, collectionId, long(added), long(added), readWorkItem).then(() => undefined, (error: unknown) => error)
  }
  expect(added).toBeLessThan(COLLECTION_ITEM_LIMIT)
  expect(failure).toMatchObject({ status: 409, code: 'CollectionItemLimitReached' })
})

test('does not commit a reference change after the Work Item is deleted or moved past the check', async () => {
  // Canonical Work Item revisions; undefined means the Work Item no longer exists.
  const revisions = new Map<string, number | undefined>([['a', 1], ['b', 1]])
  const store = new InMemoryCollectionsStore((_teamId, issueId) => revisions.get(issueId))
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  /**
   * Reader that sees the current canonical state, then lets the Work Item change before the write.
   *
   * @param change - Applied to the Work Item right after it was read.
   * @returns Caller-scoped reader for the test.
   */
  const racingReader = (change: () => void): ReadCollectionWorkItem => {
    let pending: (() => void) | undefined = change
    return async (teamId, issueId) => {
      const revision = revisions.get(issueId)
      if (revision === undefined) return undefined
      const apply = pending
      pending = undefined
      apply?.()
      return { entry: { teamId, issueId, title: `Title ${issueId}`, statusCategory: 'started' }, revision }
    }
  }

  // Deleted between the readability check and the write: the retry sees it is gone.
  await expect(addCollectionItem(store, context, collectionId, 't', 'a', racingReader(() => revisions.set('a', undefined))))
    .rejects.toMatchObject({ status: 404, code: 'CollectionWorkItemNotFound' })
  expect((await store.get('w', collectionId))?.items).toEqual([])

  // Changed (for example moved to another Project) in between: the retry rechecks and then commits.
  const added = await addCollectionItem(store, context, collectionId, 't', 'b', racingReader(() => revisions.set('b', 2)))
  expect(added.revision).toBe(2)

  // The same fence guards removal.
  await expect(removeCollectionItem(store, context, collectionId, 't', 'b', racingReader(() => revisions.set('b', undefined))))
    .rejects.toMatchObject({ status: 404, code: 'CollectionWorkItemNotFound' })
  expect((await store.get('w', collectionId))?.items.map((item) => item.issueId)).toEqual(['b'])
})

test('rejects a change before writing a revision the stored-row validator would refuse', async () => {
  const lastRevision = Number.MAX_SAFE_INTEGER - 1
  let writes = 0
  /** Store whose Collection is at the last revision the stored-row validator accepts. */
  class ExhaustedRevisionStore extends InMemoryCollectionsStore {
    /**
     * Reads the Collection at the last valid revision.
     * @param workspaceId Workspace identifier.
     * @param collectionId Collection identifier.
     * @returns The Collection with its revision moved to the last valid value.
     */
    override async get(workspaceId: string, collectionId: string): Promise<StoredCollection | undefined> {
      const stored = await super.get(workspaceId, collectionId)
      return stored ? { ...stored, revision: lastRevision } : undefined
    }

    /**
     * Counts writes that reach the store.
     * @param args Write arguments.
     */
    override async put(...args: Parameters<InMemoryCollectionsStore['put']>): Promise<void> {
      writes += 1
      await super.put(...args)
    }
  }
  const store = new ExhaustedRevisionStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  writes = 0
  expect(isStoredCollection(await store.get('w', collectionId))).toBe(true)
  await expect(updateCollection(store, context, collectionId, { expectedRevision: lastRevision, name: 'Renamed' }))
    .rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  await expect(addCollectionItem(store, context, collectionId, 'core-team', 'item-1', readWorkItem))
    .rejects.toMatchObject({ status: 502, code: 'CollectionCorruptState' })
  expect(writes).toBe(0)
})
