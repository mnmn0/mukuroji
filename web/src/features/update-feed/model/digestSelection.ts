import type { SavedUpdateFeeds, UpdateFeedDigestPreferences } from '@mukuroji/contracts'

/** Checks source count and explicit confirmation without silently accepting edited definitions.
 * @param preferences - Current settings draft.
 * @param collection - Successfully loaded current personal definitions.
 * @returns Whether this selection can be explicitly saved or generated.
 */
export function validDigestSelection(preferences: UpdateFeedDigestPreferences, collection?: SavedUpdateFeeds): boolean {
  const saved = preferences.savedFeeds
  const count = preferences.views.length + (saved?.ids.length ?? 0)
  return count > 0 && count <= 6 && (!preferences.enabled || !saved || (collection?.revision === saved.revision && saved.ids.every((id) => collection.feeds.some((feed) => feed.id === id))))
}
