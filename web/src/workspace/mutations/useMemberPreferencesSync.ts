import { useCallback, useEffect, useRef } from 'react'
import type { MemberPreferenceValues, MemberPreferences } from '@mukuroji/contracts'
import {
  getMemberPreferences,
  replaceMemberPreferences,
} from '../api/memberPreferences'
import { WorkspaceAccessApiError } from '../api/errors'
import { useMemberPreferences } from '../queries/useMemberPreferences'

/** Inputs for keeping display preferences in step with the server. */
export type UseMemberPreferencesSyncOptions = {
  /** Cognito access token. */
  accessToken?: string
  /** Whether the signed-in member is known, so the request may run. */
  enabled: boolean
  /** Applies preferences saved on the server to this device. */
  apply: (values: MemberPreferenceValues) => void
  /** Loader override for tests and stories. */
  loadMemberPreferences?: typeof getMemberPreferences
  /** Saver override for tests and stories. */
  saveMemberPreferences?: typeof replaceMemberPreferences
}

/**
 * Applies the member's saved display preferences to this device and saves later changes.
 *
 * A save sends only the changed fields on top of the newest saved values, so a change made on
 * another device to a different field is kept. Each saved result also updates the query cache,
 * so a remount starts from it. Saving is best effort: a failure keeps the local change.
 *
 * @param options - Authentication state, the apply callback, and optional overrides.
 * @returns A function that saves changed fields.
 */
export function useMemberPreferencesSync({
  accessToken,
  apply,
  enabled,
  loadMemberPreferences = getMemberPreferences,
  saveMemberPreferences = replaceMemberPreferences,
}: UseMemberPreferencesSyncOptions) {
  const { data, mutate } = useMemberPreferences({ accessToken, enabled, loadMemberPreferences })
  const applyRef = useRef(apply)
  const latestRef = useRef<MemberPreferences | undefined>(undefined)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    applyRef.current = apply
  })

  useEffect(() => {
    if (!data || (latestRef.current && data.revision <= latestRef.current.revision)) return
    latestRef.current = data
    if (data.revision > 0) applyRef.current(toValues(data))
  }, [data])

  return useCallback((changes: MemberPreferenceValues) => {
    if (!accessToken) return
    saveChainRef.current = saveChainRef.current.then(async () => {
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
      // Record the result first so the cache update is not applied again over newer local changes.
      latestRef.current = saved
      await mutate(saved, { revalidate: false })
    }).catch((error: unknown) => {
      console.warn('Display preferences could not be saved to the server.', error)
    })
  }, [accessToken, loadMemberPreferences, mutate, saveMemberPreferences])
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
