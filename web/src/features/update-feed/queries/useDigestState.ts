import useSWR from 'swr'
import { getDigestState } from '../api/digest'

/** Loads only personal metadata; preview bodies never enter the shared cache.
 * @param token - Current session.
 * @param enabled - Whether the panel is open and authorized.
 * @param guard - Shared session recovery boundary for metadata failures.
 * @returns Fail-closed query state with explicit retry support.
 */
export function useDigestState(token: string | undefined, enabled: boolean, guard: <T>(request: Promise<T>) => Promise<T>) {
  const query = useSWR(token && enabled ? ['update-feed-digest', token] : null, ([, accessToken]) => guard(getDigestState(accessToken)), { revalidateOnFocus: true, shouldRetryOnError: false })
  return { ...query, data: !token || !enabled || query.error ? undefined : query.data }
}
