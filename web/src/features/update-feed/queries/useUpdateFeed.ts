import type { UpdateFeedView } from '@mukuroji/contracts'
import useSWR from 'swr'
import { getUpdateFeed } from '../api/updateFeed'

/** Loads a token-scoped view and suppresses cached content on any refresh failure.
 * @param token - Session bearer token.
 * @param enabled - Whether the session may load Workspace data.
 * @param view - Selected standard view.
 * @returns Query state with fail-closed data and revalidation support.
 */
export function useUpdateFeed(token: string | undefined, enabled: boolean, view: UpdateFeedView) {
  const query = useSWR(token && enabled ? ['update-feed', token, view] : null,
    ([, accessToken, selectedView]) => getUpdateFeed(accessToken, selectedView),
    { refreshInterval: 15_000, revalidateOnFocus: true, shouldRetryOnError: false })
  return { ...query, data: query.error || !enabled || !token ? undefined : query.data }
}
