import useSWR from 'swr'
import { getInboxDigestState } from '../api/digest'

/** Loads delivery settings with session isolation and fail-closed errors.
 * @param token - Current session.
 * @param enabled - Whether the disclosure is open and authorized.
 * @param guard - Shared authentication recovery.
 * @param onVerified - Clears a retained read barrier only after a successful GET.
 * @returns Metadata query and explicit reload capability.
 */
export function useInboxDigestState(token: string | undefined, enabled: boolean, guard: <T>(request: Promise<T>) => Promise<T>, onVerified?: () => void) {
  const query = useSWR(token && enabled ? ['update-feed-inbox-settings', token] : null, ([, accessToken]) => guard(getInboxDigestState(accessToken)), { revalidateOnFocus: true, shouldRetryOnError: false, onSuccess: onVerified })
  return { ...query, data: !token || !enabled || query.error ? undefined : query.data }
}
