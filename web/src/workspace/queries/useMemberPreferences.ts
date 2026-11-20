import useSWR from 'swr'
import { getMemberPreferences } from '../api/memberPreferences'

/** Inputs for loading the signed-in member's saved display preferences. */
export type UseMemberPreferencesOptions = {
  /** Cognito access token. */
  accessToken?: string
  /** Whether the signed-in member is known, so the request may run. */
  enabled: boolean
  /** Loader override for tests and stories. */
  loadMemberPreferences?: typeof getMemberPreferences
}

/**
 * Loads and caches the signed-in member's saved display preferences.
 *
 * Failed loads retry with SWR's backoff, so a brief outage at startup does not leave the
 * device without the saved values.
 *
 * @param options - Authentication state and optional loader override.
 * @returns SWR state for the preferences.
 */
export function useMemberPreferences({
  accessToken,
  enabled,
  loadMemberPreferences = getMemberPreferences,
}: UseMemberPreferencesOptions) {
  const key: readonly ['member-preferences', string] | null = accessToken && enabled
    ? ['member-preferences', accessToken]
    : null
  return useSWR(key, ([, token]) => loadMemberPreferences(token), {
    revalidateOnFocus: false,
  })
}
