import { useCallback, useEffect, useRef } from 'react'
import useSWR from 'swr'
import type { MemberPreferenceValues, MemberPreferences } from '@mukuroji/contracts'
import {
  getMemberPreferences,
  replaceMemberPreferences,
} from '../api/memberPreferences'
import { WorkspaceAccessApiError } from '../api/errors'

/** Inputs for keeping display preferences in step with the server. */
export type UseMemberPreferencesSyncOptions = {
  /** Cognito access token. */
  accessToken?: string
  /** Whether the signed-in member is known, so the request may run. */
  enabled: boolean
  /** Preferences currently applied on this device. */
  current: MemberPreferenceValues
  /** Applies preferences loaded from the server to this device. */
  apply: (values: MemberPreferenceValues) => void
  /** Loader override for tests and stories. */
  loadMemberPreferences?: typeof getMemberPreferences
  /** Saver override for tests and stories. */
  saveMemberPreferences?: typeof replaceMemberPreferences
}

/**
 * Loads the member's saved display preferences once per sign-in and saves later changes.
 *
 * Saved values win over this device's local ones when the page loads, so a new device starts
 * with the member's choices. Saving is best effort: a failure keeps the local change.
 *
 * @param options - Authentication state, current values, and the apply callback.
 * @returns A function that saves changed values on top of the current ones.
 */
export function useMemberPreferencesSync({
  accessToken,
  apply,
  current,
  enabled,
  loadMemberPreferences = getMemberPreferences,
  saveMemberPreferences = replaceMemberPreferences,
}: UseMemberPreferencesSyncOptions) {
  const key: readonly ['member-preferences', string] | null = accessToken && enabled
    ? ['member-preferences', accessToken]
    : null
  const { data } = useSWR(key, ([, token]) => loadMemberPreferences(token), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  })
  const currentRef = useRef(current)
  const applyRef = useRef(apply)
  const latestRef = useRef<MemberPreferences | undefined>(undefined)
  const appliedRef = useRef(false)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const pendingRef = useRef<MemberPreferenceValues | undefined>(undefined)

  useEffect(() => {
    currentRef.current = current
    applyRef.current = apply
  })

  const save = useCallback((changes: MemberPreferenceValues) => {
    if (!accessToken) return
    if (!latestRef.current) {
      // Keep changes made before the saved values arrive, and save them once they do.
      pendingRef.current = { ...pendingRef.current, ...changes }
      return
    }
    saveChainRef.current = saveChainRef.current.then(async () => {
      const latest = latestRef.current
      if (!latest) return
      const next = { ...toValues(currentRef.current), ...changes }
      try {
        latestRef.current = await saveMemberPreferences(accessToken, {
          ...next,
          revision: latest.revision,
        })
      } catch (error) {
        if (!(error instanceof WorkspaceAccessApiError) || error.status !== 409) throw error
        const fresh = await loadMemberPreferences(accessToken)
        latestRef.current = await saveMemberPreferences(accessToken, {
          ...next,
          revision: fresh.revision,
        })
      }
    }).catch((error: unknown) => {
      console.warn('Display preferences could not be saved to the server.', error)
    })
  }, [accessToken, loadMemberPreferences, saveMemberPreferences])

  useEffect(() => {
    if (!data || appliedRef.current) return
    appliedRef.current = true
    latestRef.current = data
    const pending = pendingRef.current
    pendingRef.current = undefined
    if (pending) {
      // The member changed something before the saved values arrived; that change wins.
      const merged = { ...toValues(data), ...pending }
      applyRef.current(merged)
      save(merged)
    } else if (data.revision > 0) {
      applyRef.current(toValues(data))
    }
  }, [data, save])

  return save
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
