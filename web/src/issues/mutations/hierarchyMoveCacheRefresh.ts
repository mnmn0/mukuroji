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
 * placement even when it closed while the move saved.
 *
 * When the read fails, the cached pre-move hierarchy is cleared whether or not the outline is
 * open, and an open outline reads it again. The outline then shows its loading or error state
 * instead of the old placement, and no further move is planned from it. The failure is written
 * through the same mutation as a success, so a newer hierarchy that another write stored while
 * this read ran is kept rather than cleared.
 *
 * @param mutate - Global SWR mutator.
 * @param key - Key of the moved Team's hierarchy.
 * @param load - Reads the hierarchy.
 * @returns Resolves once the entry holds the new hierarchy or is cleared.
 */
export async function refreshMovedHierarchyCache<Data>(
  mutate: ScopedMutator,
  key: Arguments,
  load: () => Promise<Data>,
): Promise<void> {
  let failed = false
  const read = load().catch(() => {
    failed = true
    return undefined
  })
  await mutate(key, read, { revalidate: false })
  if (failed) await mutate(key)
}
