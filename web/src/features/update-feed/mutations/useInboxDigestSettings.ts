import { useRef, useState } from 'react'
import type { UpdateFeedDigestPreferences } from '@mukuroji/contracts'
import { saveInboxDigestPreferences } from '../api/digest'
import { useInboxDigestState } from '../queries/useInboxDigestState'

/** Serializes explicit consent changes without generating or sending notifications.
 * @param token - Session bound to the owning component key.
 * @param enabled - Current read permission.
 * @param guard - Shared session recovery.
 * @returns Metadata and save/reload actions.
 */
export function useInboxDigestSettings(token: string | undefined, enabled: boolean, guard: <T>(request: Promise<T>) => Promise<T>) {
  const query = useInboxDigestState(token, enabled, guard)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>()
  /** Saves the observed revision; conflicts require explicit reload. */
  const save = async (preferences: UpdateFeedDigestPreferences) => {
    if (!token || !enabled || !query.data || busy.current) return false
    busy.current = true; setPending(true); setError(undefined)
    try {
      const state = await guard(saveInboxDigestPreferences(token, query.data.revision, preferences))
      await query.mutate(state, { revalidate: false })
      return true
    } catch (failure) {
      setError(failure)
      await query.mutate().catch(() => undefined)
      return false
    } finally { busy.current = false; setPending(false) }
  }
  return { state: query.data, pending, loading: query.isLoading, error: query.error ?? error, save, reload: () => { setError(undefined); void query.mutate().catch(() => undefined) } }
}
