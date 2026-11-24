import useSWR from 'swr'
import { getMemberProfile } from '../api/memberProfile'

/**
 * Builds the cache key of a member profile read with an access token.
 *
 * @param accessToken - Cognito access token the profile is read with.
 * @returns SWR key of that profile.
 */
export function memberProfileKey(accessToken: string): readonly ['member-profile', string] {
  return ['member-profile', accessToken]
}

/**
 * Tells whether an SWR key belongs to a member profile, whichever token it was read with.
 *
 * @param key - SWR cache key.
 * @returns Whether the key is a member profile key.
 */
export function isMemberProfileKey(key: unknown): key is readonly unknown[] {
  return Array.isArray(key) && key[0] === 'member-profile'
}

/**
 * Loads and caches the signed-in member's own profile.
 *
 * @param accessToken - Cognito access token; no request runs without it.
 * @param loadMemberProfile - Loader override for tests and stories.
 * @returns SWR state for the profile.
 */
export function useMemberProfile(
  accessToken: string | undefined,
  loadMemberProfile: typeof getMemberProfile = getMemberProfile,
) {
  const key = accessToken ? memberProfileKey(accessToken) : null
  return useSWR(key, ([, token]) => loadMemberProfile(token), {
    revalidateOnFocus: false,
  })
}
