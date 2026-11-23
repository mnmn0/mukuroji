import useSWR from 'swr'
import { getMemberProfile } from '../api/memberProfile'

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
  const key: readonly ['member-profile', string] | null = accessToken
    ? ['member-profile', accessToken]
    : null
  return useSWR(key, ([, token]) => loadMemberProfile(token), {
    revalidateOnFocus: false,
  })
}
