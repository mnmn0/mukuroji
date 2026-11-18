import { describe, expect, test } from 'bun:test'
import { mutate, unstable_serialize } from 'swr'
import {
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

  test('clears the pre-move hierarchy when the read fails, even for an open outline', async () => {
    const key = ['team-work-item-hierarchy', 'token', 'team-failed'] as const
    await mutate(key, 'before move', { revalidate: false })

    await refreshMovedHierarchyCache(
      mutate,
      key,
      async () => { throw new Error('Hierarchy read failed.') },
    )

    // The outline shows its loading or error state, and reopening it reads the hierarchy again,
    // instead of showing the old placement.
    expect(await readCached(key)).toBeUndefined()
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
