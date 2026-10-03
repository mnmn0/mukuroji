import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateFeedDigestPreferences, UpdateFeedDigestPreview } from '@mukuroji/contracts'
import { generateDigestPreview, getDigestState, saveDigestPreferences } from '../api/digest'
import { useDigestState } from '../queries/useDigestState'

/** Ephemeral result bound to the metadata revision observed after generation. */
type PreviewSnapshot = {
  /** Fresh authorized response, never shared with SWR. */
  result: UpdateFeedDigestPreview
  /** Metadata revision; a later refresh invalidates this result. */
  revision: number
}

/** Owns explicit preview actions and short-lived session-local content.
 * @param token - Current session, also used as the owner component's React key.
 * @param enabled - Whether Workspace data is currently readable.
 * @param locale - Current target-label language.
 * @param guard - Shared session recovery boundary.
 * @returns Serialized actions and fail-closed preview state.
 */
export function useDigestPreview(token: string | undefined, enabled: boolean, locale: 'ja' | 'en', guard: <T>(request: Promise<T>) => Promise<T>) {
  const query = useDigestState(token, enabled, guard)
  const [preview, setPreview] = useState<PreviewSnapshot>()
  const [error, setError] = useState<unknown>()
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [draftReset, setDraftReset] = useState(0)
  const active = useRef(true)
  const busy = useRef(false)
  const epoch = useRef(0)
  const body = useRef<UpdateFeedDigestPreview | undefined>(undefined)
  const deadline = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const metadataRequest = useRef<AbortController | undefined>(undefined)
  /** Invalidates pending content as well as visible content. */
  const dismiss = useCallback(() => {
    epoch.current += 1
    body.current = undefined
    clearTimeout(timer.current)
    metadataRequest.current?.abort()
    if (active.current) setPreview(undefined)
  }, [])
  useEffect(() => {
    active.current = true
    /** Content cannot survive switching away from the authenticated screen. */
    const clear = dismiss
    window.addEventListener('blur', clear)
    window.addEventListener('focus', clear)
    document.addEventListener('visibilitychange', clear)
    return () => { active.current = false; dismiss(); window.removeEventListener('blur', clear); window.removeEventListener('focus', clear); document.removeEventListener('visibilitychange', clear) }
  }, [dismiss])
  /** Transfers the response into the sole clearable owner before awaiting metadata. */
  const capture = (result: UpdateFeedDigestPreview, generation: number) => {
    if (!active.current || generation !== epoch.current) return
    body.current = result
    deadline.current = Date.now() + 15_000
    timer.current = setTimeout(dismiss, 15_000)
  }
  /** Performs one explicit action without automatically retrying mutations. */
  const run = async (preferences?: UpdateFeedDigestPreferences, expectedRevision?: number): Promise<boolean> => {
    if (!token || !enabled || !query.data || busy.current) return false
    busy.current = true; setPending(true); setError(undefined); setRefreshFailed(false); dismiss()
    const generation = epoch.current
    try {
      if (preferences) {
        const state = await guard(saveDigestPreferences(token, expectedRevision ?? query.data.revision, preferences))
        if (active.current) await query.mutate(state, { revalidate: false })
      } else {
        capture(await guard(generateDigestPreview(token, locale)), generation)
        if (!body.current) return false
        const request = new AbortController()
        metadataRequest.current = request
        let refreshed
        try {
          refreshed = await guard(getDigestState(token, request.signal))
          if (request.signal.aborted || generation !== epoch.current) return false
          if (active.current) await query.mutate(refreshed, { revalidate: false })
          if (!refreshed) throw new Error('Digest metadata unavailable after generation')
        } catch (failure) {
          if (request.signal.aborted || generation !== epoch.current) return false
          // Generation committed, but its response cannot be displayed until a
          // current metadata/permission read succeeds. Do not retry the POST.
          if (active.current) { dismiss(); setRefreshFailed(true); setError(failure) }
          return false
        }
        if (active.current && generation === epoch.current && body.current && Date.now() < deadline.current && refreshed?.preferences.enabled && JSON.stringify(refreshed.preferences) === JSON.stringify(query.data.preferences)) setPreview({ result: body.current, revision: refreshed.revision })
      }
      return active.current
    } catch (failure) {
      if (active.current && generation === epoch.current) {
        dismiss(); setError(failure)
        // Generation conflicts still recheck authorization; save conflicts retain
        // the original editing base until the member explicitly reloads.
        if (!preferences) await query.mutate().catch(() => undefined)
      }
      return false
    } finally { busy.current = false; if (active.current) setPending(false) }
  }
  /** Reloads metadata explicitly; a failed refresh never restores the discarded body. */
  const reload = async () => {
    if (!token || !enabled || busy.current) return
    busy.current = true; setPending(true); dismiss()
    try {
      const state = await guard(getDigestState(token))
      if (active.current) { await query.mutate(state, { revalidate: false }); setError(undefined); setRefreshFailed(false); setDraftReset((value) => value + 1) }
    } catch (failure) { if (active.current) { setError(failure); setRefreshFailed(true) } }
    finally { busy.current = false; if (active.current) setPending(false) }
  }
  return { state: refreshFailed ? undefined : query.data, loading: query.isLoading, error: query.error ?? error, refreshFailed, pending, draftReset, preview: refreshFailed || query.error || !enabled || !token || query.isValidating || query.data?.revision !== preview?.revision ? undefined : preview?.result, save: (preferences: UpdateFeedDigestPreferences, expectedRevision?: number) => run(preferences, expectedRevision), generate: () => run(), dismiss, reload: () => { void reload() } }
}
