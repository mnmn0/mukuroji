import { unstable_serialize } from 'swr'
import type { Arguments, ScopedMutator } from 'swr'

/**
 * Revalidates one cache entry that a hierarchy move changed.
 *
 * An entry the page still reads is revalidated in place, so its data stays on screen while the
 * new data loads. An entry nothing on the page reads any more is cleared instead: a plain
 * revalidation does nothing without a reader, and the pre-move data would come back the next
 * time the entry is shown.
 *
 * @param mutate - Global SWR mutator.
 * @param key - Key of the changed entry.
 * @param readShownKeys - Returns the serialized keys the page reads now.
 * @returns Resolves once the entry is revalidated or cleared.
 */
export async function refreshMovedCacheEntry(
  mutate: ScopedMutator,
  key: Arguments,
  readShownKeys: () => ReadonlySet<string>,
): Promise<void> {
  if (readShownKeys().has(unstable_serialize(key))) {
    await mutate(key)
    return
  }
  await mutate(key, undefined, { revalidate: true })
}

/**
 * Reads a moved Team's hierarchy and writes it to the cache, so the outline shows the new
 * placement even when it closed while the move saved. When the read fails, the entry is
 * revalidated or cleared like {@link refreshMovedCacheEntry}, so the pre-move hierarchy is
 * never shown as current.
 *
 * @param mutate - Global SWR mutator.
 * @param key - Key of the moved Team's hierarchy.
 * @param load - Reads the hierarchy.
 * @param readShownKeys - Returns the serialized keys the page reads now.
 * @returns Resolves once the entry holds the new hierarchy, or is revalidated or cleared.
 */
export async function refreshMovedHierarchyCache<Data>(
  mutate: ScopedMutator,
  key: Arguments,
  load: () => Promise<Data>,
  readShownKeys: () => ReadonlySet<string>,
): Promise<void> {
  try {
    await mutate(key, load(), { revalidate: false })
  } catch {
    await refreshMovedCacheEntry(mutate, key, readShownKeys)
  }
}
