import { useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import type { ReplaceSavedUpdateFeedsInput } from '@mukuroji/contracts'
import { getSavedUpdateFeeds, getUpdateFeedFilterOptions, replaceSavedUpdateFeeds } from '../api/savedFeeds'

/** Owns session-scoped definitions and serialized revision-guarded changes.
 * @param token - Current session identity.
 * @param enabled - Whether Workspace data can be loaded.
 * @param guard - Shared session error recovery boundary.
 * @returns Fail-closed query data and a mutation that preserves the editor on failure.
 */
export function useSavedUpdateFeeds(token: string | undefined, enabled: boolean, guard: <T>(request: Promise<T>) => Promise<T>) {
  const query = useSWR(token && enabled ? ['saved-update-feeds', token] : null, ([, accessToken]) => getSavedUpdateFeeds(accessToken), { revalidateOnFocus: true, shouldRetryOnError: false })
  const { mutate } = useSWRConfig()
  const busy = useRef(false)
  const active = useRef(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>()
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  /** Commits an explicit collection revision; late completions cannot affect another session. */
  const replace = async (input: ReplaceSavedUpdateFeedsInput): Promise<boolean> => {
    if (!token || !enabled || busy.current) return false
    busy.current = true; setPending(true); setError(undefined)
    try {
      const saved = await replaceSavedUpdateFeeds(token, input)
      if (!active.current) return false
      await query.mutate(saved, { revalidate: false })
      await mutate((key) => Array.isArray(key) && key[0] === 'update-feed' && key[1] === token, undefined, { revalidate: true }).catch(() => undefined)
      return active.current
    } catch (failure) {
      if (active.current) {
        await guard(Promise.reject(failure)).catch(() => undefined)
        setError(failure)
        await query.mutate().catch(() => undefined)
      }
      return false
    } finally { busy.current = false; if (active.current) setPending(false) }
  }
  return { ...query, data: query.error || !enabled || !token ? undefined : query.data, replace, pending, mutationError: error, clearMutationError: () => setError(undefined) }
}

/** Loads fresh authorized selector labels only while the filter editor is open.
 * @param token - Current session.
 * @param enabled - Whether the editor may load metadata.
 * @param locale - Active display language.
 * @returns Fail-closed current selector metadata.
 */
export function useUpdateFeedFilterOptions(token: string | undefined, enabled: boolean, locale: 'ja' | 'en') {
  const query = useSWR(token && enabled ? ['update-feed-options', token, locale] : null, ([, accessToken, selectedLocale]) => getUpdateFeedFilterOptions(accessToken, selectedLocale), { revalidateOnFocus: true, refreshInterval: 15_000, shouldRetryOnError: false })
  return { ...query, data: query.error || !enabled || !token ? undefined : query.data }
}
