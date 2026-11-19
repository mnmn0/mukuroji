import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemberPreferenceValues, MemberPreferences } from '@mukuroji/contracts'
import {
  getMemberPreferences,
  replaceMemberPreferences,
} from '../api/memberPreferences'
import { WorkspaceAccessApiError } from '../api/errors'
import { useMemberPreferences } from '../queries/useMemberPreferences'

/** Preference fields, in the order they are compared. */
const preferenceKeys = ['locale', 'timeZone', 'theme', 'fontSize'] as const

/** Inputs for keeping display preferences in step with the server. */
export type UseMemberPreferencesSyncOptions = {
  /** Cognito access token. */
  accessToken?: string
  /** Whether the signed-in member is known, so the request may run. */
  enabled: boolean
  /** Applies preferences to this device. */
  apply: (values: MemberPreferenceValues) => void
  /** Loader override for tests and stories. */
  loadMemberPreferences?: typeof getMemberPreferences
  /** Saver override for tests and stories. */
  saveMemberPreferences?: typeof replaceMemberPreferences
}

/** Save actions and state returned by {@link useMemberPreferencesSync}. */
export type MemberPreferencesSync = {
  /** Saves changed fields; unsaved changes are kept until a save succeeds. */
  save: (changes: MemberPreferenceValues) => void
  /** Saves the changes kept after a failed save again. */
  retry: () => void
  /** Whether the latest save failed and changes are waiting for a retry. */
  saveFailed: boolean
}

/**
 * Applies the member's saved display preferences to this device and saves later changes.
 *
 * Changes not yet saved are kept and laid over any values fetched meanwhile, so a fetch never
 * undoes a newer local choice. A save sends only those changes on top of the newest saved
 * values, so a change made on another device to a different field is kept. Each saved result
 * updates the query cache, so a remount starts from it.
 *
 * @param options - Authentication state, the apply callback, and optional overrides.
 * @returns Save and retry actions with the save failure state.
 */
export function useMemberPreferencesSync({
  accessToken,
  apply,
  enabled,
  loadMemberPreferences = getMemberPreferences,
  saveMemberPreferences = replaceMemberPreferences,
}: UseMemberPreferencesSyncOptions): MemberPreferencesSync {
  const { data, mutate } = useMemberPreferences({ accessToken, enabled, loadMemberPreferences })
  const [saveFailed, setSaveFailed] = useState(false)
  const applyRef = useRef(apply)
  const latestRef = useRef<MemberPreferences | undefined>(undefined)
  const pendingRef = useRef<MemberPreferenceValues>({})
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    applyRef.current = apply
  })

  useEffect(() => {
    if (!data || (latestRef.current && data.revision <= latestRef.current.revision)) return
    latestRef.current = data
    if (data.revision > 0) applyRef.current({ ...toValues(data), ...pendingRef.current })
  }, [data])

  const flush = useCallback(() => {
    if (!accessToken) return
    saveChainRef.current = saveChainRef.current.then(async () => {
      const changes = { ...pendingRef.current }
      if (!hasChanges(changes)) return
      const base = latestRef.current ?? await loadMemberPreferences(accessToken)
      let saved: MemberPreferences
      try {
        saved = await saveMemberPreferences(accessToken, {
          ...toValues(base),
          ...changes,
          revision: base.revision,
        })
      } catch (error) {
        if (!(error instanceof WorkspaceAccessApiError) || error.status !== 409) throw error
        const fresh = await loadMemberPreferences(accessToken)
        saved = await saveMemberPreferences(accessToken, {
          ...toValues(fresh),
          ...changes,
          revision: fresh.revision,
        })
      }
      pendingRef.current = withoutSaved(pendingRef.current, changes)
      // Record the result first so the cache update is not applied again over newer local changes.
      latestRef.current = saved
      await mutate(saved, { revalidate: false })
      setSaveFailed(false)
    }).catch((error: unknown) => {
      console.warn('Display preferences could not be saved to the server.', error)
      setSaveFailed(true)
    })
  }, [accessToken, loadMemberPreferences, mutate, saveMemberPreferences])

  const save = useCallback((changes: MemberPreferenceValues) => {
    pendingRef.current = { ...pendingRef.current, ...changes }
    flush()
  }, [flush])

  return { retry: flush, save, saveFailed }
}

/**
 * Checks whether any preference field is set, including one set to undefined to clear it.
 *
 * @param changes - Changed fields.
 * @returns Whether there is anything to save.
 */
function hasChanges(changes: MemberPreferenceValues): boolean {
  return preferenceKeys.some((key) => key in changes)
}

/**
 * Removes the saved fields from the pending changes, keeping any changed again since.
 *
 * @param pending - Changes waiting to be saved now.
 * @param saved - Changes the finished save sent.
 * @returns The changes still waiting to be saved.
 */
function withoutSaved(
  pending: MemberPreferenceValues,
  saved: MemberPreferenceValues,
): MemberPreferenceValues {
  const remaining = { ...pending }
  for (const key of preferenceKeys) {
    if (key in saved && remaining[key] === saved[key]) delete remaining[key]
  }
  return remaining
}

/**
 * Copies only the preference fields that hold a value.
 *
 * @param value - Preferences, possibly with a revision.
 * @returns The preference fields without the revision.
 */
function toValues(value: MemberPreferenceValues): MemberPreferenceValues {
  return {
    ...(value.locale ? { locale: value.locale } : {}),
    ...(value.timeZone ? { timeZone: value.timeZone } : {}),
    ...(value.theme ? { theme: value.theme } : {}),
    ...(value.fontSize ? { fontSize: value.fontSize } : {}),
  }
}
