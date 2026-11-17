import useSWR from 'swr'
import { getWorkspaceMembersSignInSecurity } from '../api/members'

const signInSecurityQueryConfig = {
  dedupingInterval: 30_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Reads each active member's MFA enrollment and password reset availability.
 *
 * Only owners and admins may read it, so the caller enables it from the access capabilities.
 *
 * @param accessToken - Access token of the session.
 * @param enabled - Whether the caller can manage members.
 * @returns The SWR state of the members' sign-in security.
 */
export function useWorkspaceMembersSignInSecurity(accessToken: string, enabled: boolean) {
  return useSWR(
    enabled ? ['workspace-members-sign-in-security', accessToken] as const : null,
    ([, token]) => getWorkspaceMembersSignInSecurity(token),
    signInSecurityQueryConfig,
  )
}
