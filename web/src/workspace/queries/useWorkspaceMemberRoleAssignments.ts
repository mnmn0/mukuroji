import useSWR from 'swr'
import { getEnterpriseSecuritySnapshot } from '../../security/api'
import { groupMemberRoleAssignments } from '../model/memberRoleAssignments'

const memberRoleAssignmentsQueryConfig = {
  dedupingInterval: 30_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Reads the roles assigned directly to each member, for the member list.
 *
 * The roles come from the security snapshot, which only callers with security access can read;
 * for anyone else the request fails and the list shows no direct roles.
 *
 * @param accessToken - Access token of the session.
 * @param enabled - Whether the caller manages members.
 * @returns The SWR state of each member's direct roles.
 */
export function useWorkspaceMemberRoleAssignments(accessToken: string, enabled: boolean) {
  return useSWR(
    enabled ? ['workspace-member-role-assignments', accessToken] as const : null,
    async ([, token]) => groupMemberRoleAssignments(await getEnterpriseSecuritySnapshot(token)),
    memberRoleAssignmentsQueryConfig,
  )
}
