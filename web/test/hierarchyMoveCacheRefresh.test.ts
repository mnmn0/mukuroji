import { describe, expect, test } from 'bun:test'
import { mutate, unstable_serialize } from 'swr'
import { cache, SWRGlobalState, subscribeCallback } from 'swr/_internal'
import {
  refreshCachedHierarchy,
  refreshMovedCacheEntry,
  refreshMovedHierarchyCache,
} from '../src/issues/mutations/hierarchyMoveCacheRefresh'

/** Reads an entry back without a reader: a key-only mutate resolves the cached data. */
async function readCached(key: readonly unknown[]) {
  return mutate(key)
}

describe('hierarchy move cache refresh', () => {
  test('writes the new hierarchy even when the outline closed during the save', async () => {
    const key = ['team-work-item-hierarchy', 'token', 'team-written'] as const
    await mutate(key, 'before move', { revalidate: false })

    await refreshMovedHierarchyCache(mutate, key, async () => 'after move')

    expect(await readCached(key)).toBe('after move')
  })

  test('clears the pre-move hierarchy when the read fails and no outline reads it', async () => {
    const key = ['team-work-item-hierarchy', 'token', 'team-failed'] as const
    await mutate(key, 'before move', { revalidate: false })

    await refreshMovedHierarchyCache(
      mutate,
      key,
      async () => { throw new Error('Hierarchy read failed.') },
    )

    // Reopening the outline reads the hierarchy again instead of showing the old placement.
    expect(await readCached(key)).toBeUndefined()
  })

  test('has an open outline read the hierarchy again when the read fails', async () => {
    const key = ['team-work-item-hierarchy', 'token', 'team-open'] as const
    await mutate(key, 'before move', { revalidate: false })
    // Stands in for the open outline's reader, which SWR asks to revalidate on a key-only mutate.
    const revalidators = SWRGlobalState.get(cache)?.[0]
    if (!revalidators) throw new Error('The default SWR cache is not initialized.')
    const outlineReads: string[] = []
    // What the cache held each time the outline was asked to read again.
    const cachedWhenRead: unknown[] = []
    const stopReading = subscribeCallback(unstable_serialize(key), revalidators, () => {
      outlineReads.push('read')
      cachedWhenRead.push(cache.get(unstable_serialize(key))?.data)
      return Promise.resolve(true)
    })

    try {
      await refreshMovedHierarchyCache(
        mutate,
        key,
        async () => { throw new Error('Hierarchy read failed.') },
      )
    } finally {
      stopReading()
    }

    expect(outlineReads).toEqual(['read'])
    // The old hierarchy was already gone when the outline started reading again.
    expect(cachedWhenRead).toEqual([undefined])
    // The outline shows its loading or error state, not the old placement, while it reads.
    expect(await readCached(key)).toBeUndefined()
  })

  test('keeps a newer hierarchy stored while the failed read ran', async () => {
    const key = ['team-work-item-hierarchy', 'token', 'team-raced'] as const
    await mutate(key, 'before move', { revalidate: false })
    let failRead: (error: Error) => void = () => undefined
    const refresh = refreshMovedHierarchyCache(
      mutate,
      key,
      () => new Promise<string>((_resolve, reject) => {
        failRead = reject
      }),
    )

    await mutate(key, 'newer', { revalidate: false })
    failRead(new Error('Hierarchy read failed.'))
    await refresh

    expect(await readCached(key)).toBe('newer')
  })

  test('refreshes a cached hierarchy after a write and leaves an unread one alone', async () => {
    const cachedKey = ['team-work-item-hierarchy', 'token', 'team-cached'] as const
    const unreadKey = ['team-work-item-hierarchy', 'token', 'team-unread'] as const
    await mutate(cachedKey, 'before write', { revalidate: false })
    const reads: string[] = []

    await refreshCachedHierarchy(cache, mutate, cachedKey, async () => {
      reads.push('cached')
      return 'after write'
    })
    await refreshCachedHierarchy(cache, mutate, unreadKey, async () => {
      reads.push('unread')
      return 'after write'
    })

    expect(reads).toEqual(['cached'])
    expect(await readCached(cachedKey)).toBe('after write')
    expect(cache.get(unstable_serialize(unreadKey))).toBeUndefined()
  })

  test('clears a list or detail entry the page no longer reads', async () => {
    const shownKey = ['team-issues', 'token', 'team-shown', true] as const
    const leftKey = ['team-issue-detail', 'token', 'team-shown', 'left-issue'] as const
    await mutate(shownKey, 'shown list', { revalidate: false })
    await mutate(leftKey, 'left detail', { revalidate: false })
    const shownKeys = new Set([unstable_serialize(shownKey)])

    await refreshMovedCacheEntry(mutate, shownKey, () => shownKeys)
    await refreshMovedCacheEntry(mutate, leftKey, () => shownKeys)

    expect(await readCached(shownKey)).toBe('shown list')
    expect(await readCached(leftKey)).toBeUndefined()
  })
})
