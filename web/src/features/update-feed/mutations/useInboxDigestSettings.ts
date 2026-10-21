import { useRef, useState } from 'react'
import type { UpdateFeedDigestPreferences } from '@mukuroji/contracts'
import { getInboxDigestState, isAmbiguousInboxSaveFailure, saveInboxDigestPreferences } from '../api/digest'
import { useInboxDigestState } from '../queries/useInboxDigestState'
import { UpdateFeedApiError } from '../api/updateFeed'
import { sameDigestPreferences } from '../model/digestPreferences'

/** Serializes explicit consent changes without generating or sending notifications.
 * @param token - Session bound to the owning component key.
 * @param enabled - Current read permission.
 * @param guard - Shared session recovery.
 * @returns Metadata and save/reload actions.
 */
export function useInboxDigestSettings(token: string | undefined, enabled: boolean, guard: <T>(request: Promise<T>) => Promise<T>) {
  const busy = useRef(false)
  const unconfirmed = useRef<UpdateFeedDigestPreferences | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>()
  const [saveFailed, setSaveFailed] = useState(false)
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [draftReset, setDraftReset] = useState(0)
  const query = useInboxDigestState(token, enabled, guard, (state) => {
    if (verificationRequired) { setVerificationRequired(false); setError(undefined); setDraftReset((value) => value + 1) }
    if (unconfirmed.current && sameDigestPreferences(unconfirmed.current, state.preferences)) {
      unconfirmed.current = undefined; setSaveFailed(false); setError(undefined)
    }
  })
  /** Saves the observed revision; conflicts require explicit reload. */
  const save = async (preferences: UpdateFeedDigestPreferences, expectedRevision?: number) => {
    if (!token || !enabled || !query.data || verificationRequired || busy.current) return false
    busy.current = true; setPending(true); setError(undefined); setSaveFailed(false)
    unconfirmed.current = undefined
    try {
      const state = await guard(saveInboxDigestPreferences(token, expectedRevision ?? query.data.revision, preferences))
      await query.mutate(state, { revalidate: false })
      return true
    } catch (failure) {
      setError(failure); setSaveFailed(true)
      if (isAmbiguousInboxSaveFailure(failure)) unconfirmed.current = preferences
      if (failure instanceof UpdateFeedApiError && (failure.status === 401 || failure.status === 403)) { setVerificationRequired(true); await query.mutate(undefined, { revalidate: false }) }
      return false
    } finally { busy.current = false; setPending(false) }
  }
  /** Discards a draft only after an explicit successful metadata read. */
  const reload = async () => {
    if (!token || !enabled || busy.current) return
    busy.current = true; setPending(true); setSaveFailed(false)
    unconfirmed.current = undefined
    try {
      const state = await guard(getInboxDigestState(token))
      await query.mutate(state, { revalidate: false })
      setError(undefined); setVerificationRequired(false); setDraftReset((value) => value + 1)
    } catch (failure) { setError(failure); setVerificationRequired(true); await query.mutate(undefined, { revalidate: false }) }
    finally { busy.current = false; setPending(false) }
  }
  const retryableSaveFailure = !query.error && saveFailed && isAmbiguousInboxSaveFailure(error)
  /** Dismisses obsolete retry presentation without forgetting an ambiguous submitted save. */
  const dismissSaveFailure = () => { if (retryableSaveFailure) { setSaveFailed(false); setError(undefined) } }
  return { state: verificationRequired ? undefined : query.data, pending, loading: query.isLoading, error: query.error ?? error, retryableSaveFailure, draftReset, save, dismissSaveFailure, reload: () => { void reload() } }
}
