import type { UpdateFeedView } from '@mukuroji/contracts'
import useSWR from 'swr'
import { getUpdateFeed } from '../api/updateFeed'

/** Loads a token-scoped view and suppresses cached content on any refresh failure.
 * @param token - Session bearer token.
 * @param enabled - Whether the session may load Workspace data.
 * @param view - Selected standard view.
 * @param locale - Active UI locale, included in the cache identity.
 * @param feedId - Optional personal saved definition, included in cache identity.
 * @returns Query state with fail-closed data and revalidation support.
 */
export function useUpdateFeed(token: string | undefined, enabled: boolean, view: UpdateFeedView, locale: 'ja' | 'en', feedId?: string) {
  const query = useSWR(token && enabled ? ['update-feed', token, view, locale, feedId] : null,
    ([, accessToken, selectedView, selectedLocale, selectedFeed]) => getUpdateFeed(accessToken, selectedView, selectedLocale, selectedFeed),
    { refreshInterval: 15_000, revalidateOnFocus: true, shouldRetryOnError: false })
  return { ...query, data: query.error || !enabled || !token ? undefined : query.data }
}
