import { expect, test } from 'bun:test'
import { COLLECTION_ITEM_LIMIT } from '@mukuroji/contracts'
import { InMemoryCollectionsStore } from '../adapter-out/collections-store'
import {
  addCollectionItem,
  createCollection,
  listCollectionEntries,
  removeCollectionItem,
  type ReadCollectionWorkItem,
} from './collections'

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

  await removeCollectionItem(store, context, collectionId, 't', 'b')
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
