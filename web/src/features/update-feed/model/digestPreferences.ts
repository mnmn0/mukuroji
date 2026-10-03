import type { UpdateFeedDigestPreferences } from '@mukuroji/contracts'
import { updateFeedViews } from './updateFeed'

/** Canonicalizes selections independently of checkbox interaction order.
 * @param preferences - Validated settings or a local draft.
 * @returns Preferences in the standard generation source order.
 */
export function normalizeDigestPreferences(preferences: UpdateFeedDigestPreferences): UpdateFeedDigestPreferences {
  return { ...preferences, views: updateFeedViews.filter((view) => preferences.views.includes(view)) }
}

/** Compares semantic selections without treating input order as an edit.
 * @param left - Current draft.
 * @param right - Committed settings.
 * @returns Whether both describe the same preferences.
 */
export function sameDigestPreferences(left: UpdateFeedDigestPreferences, right: UpdateFeedDigestPreferences): boolean {
  return JSON.stringify(normalizeDigestPreferences(left)) === JSON.stringify(normalizeDigestPreferences(right))
}
