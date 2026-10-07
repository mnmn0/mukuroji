import useSWR from 'swr'
import { getDigestState } from '../api/digest'

/** Loads only personal metadata; preview bodies never enter the shared cache.
 * @param token - Current session.
 * @param enabled - Whether the panel is open and authorized.
 * @param guard - Shared session recovery boundary for metadata failures.
 * @param onVerified - Clears a retained verification barrier only after a successful read.
 * @returns Fail-closed query state with explicit retry support.
 */
export function useDigestState(token: string | undefined, enabled: boolean, guard: <T>(request: Promise<T>) => Promise<T>, onVerified?: () => void) {
  const query = useSWR(token && enabled ? ['update-feed-digest', token] : null, ([, accessToken]) => guard(getDigestState(accessToken)), { revalidateOnFocus: true, shouldRetryOnError: false, onSuccess: onVerified })
  return { ...query, data: !token || !enabled || query.error ? undefined : query.data }
}
