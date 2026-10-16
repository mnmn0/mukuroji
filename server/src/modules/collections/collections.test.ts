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

const context = { workspaceId: 'w', actor: 'reader', now: '2026-10-16T00:00:00.000Z' }

/** Reader that can see every Work Item except those whose ID starts with `hidden`. */
const readWorkItem: ReadCollectionWorkItem = async (teamId, issueId) => issueId.startsWith('hidden')
  ? undefined
  : { teamId, issueId, title: `Title ${issueId}`, statusCategory: 'started' }

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
  expect(await store.list('w')).toEqual([])
  expect((await createCollection(store, context, { name: 'Launch' }, 'new-key')).name).toBe('Launch')
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

test('treats an overlapping identical add or remove as a no-op instead of a conflict', async () => {
  const store = new RacingCollectionsStore()
  const { collectionId } = await createCollection(store, context, { name: 'Launch' }, 'key')
  store.race = () => addCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)
  expect((await addCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)).revision).toBe(2)

  store.race = () => removeCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)
  expect((await removeCollectionItem(store, context, collectionId, 't', 'a', readWorkItem)).revision).toBe(3)
  expect((await listCollectionEntries(store, 'w', collectionId, readWorkItem)).items).toEqual([])
})
