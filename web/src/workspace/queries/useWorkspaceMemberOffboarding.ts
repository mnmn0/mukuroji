import useSWR from 'swr'
import { getWorkspaceMemberOffboarding } from '../api/members'

const offboardingQueryConfig = {
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Reads what a member manages, owns, or created before they are deactivated.
 *
 * @param accessToken - Access token of the session.
 * @param memberKey - Member who is leaving.
 * @returns The SWR state of the handover summary.
 */
export function useWorkspaceMemberOffboarding(accessToken: string, memberKey: string) {
  return useSWR(
    ['workspace-member-offboarding', accessToken, memberKey] as const,
    ([, token, key]) => getWorkspaceMemberOffboarding(token, key),
    offboardingQueryConfig,
  )
}
