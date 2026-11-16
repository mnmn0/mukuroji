import { isCognitoUserNotFoundError } from '../../modules/authentication'
import type { WorkspaceMember } from '../../modules/workspace-access/workspace-access'
import type {
  WorkspaceMemberMfaStatus,
  WorkspaceMemberPasswordResetAvailability,
  WorkspaceMemberSignInSecurity,
} from '@mukuroji/contracts'
import { authenticationDependencies, workspaceDependencies } from './app-dependencies'
import { isEnterpriseSsoConfigured } from './enterprise-access'

/** Cognito lookups that run at the same time while members are inspected. */
const memberInspectionConcurrency = 5

/**
 * Checks whether an email address signs in through an enforced enterprise SSO domain.
 *
 * Members of such a domain have no password in mukuroji and get MFA from their identity
 * provider, so password and MFA management does not apply to them.
 *
 * @param email - Email address of the member.
 * @returns Whether the domain enforces SSO.
 */
export async function isSsoManagedEmail(email: string) {
  if (!isEnterpriseSsoConfigured()) return false
  const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
  return discovery !== undefined
}

/**
 * Reads how one member signs in: whether TOTP is registered and whether an administrator can
 * send a password reset.
 *
 * @param member - Active Workspace member.
 * @returns The member's sign-in security state.
 */
async function inspectMemberSignInSecurity(
  member: WorkspaceMember,
): Promise<WorkspaceMemberSignInSecurity> {
  if (await isSsoManagedEmail(member.email)) {
    return { memberKey: member.memberKey, mfa: 'sso', passwordReset: 'sso' }
  }
  try {
    const profile = await authenticationDependencies.cognito.getUserProfile(member.memberKey)
    const mfa: WorkspaceMemberMfaStatus = profile.mfaConfigured === true ? 'enrolled' : 'not-enrolled'
    const passwordReset: WorkspaceMemberPasswordResetAvailability =
      profile.status === 'FORCE_CHANGE_PASSWORD'
        ? 'invitation-pending'
        : profile.enabled === false
          ? 'unavailable'
          : 'available'
    return { memberKey: member.memberKey, mfa, passwordReset }
  } catch (error) {
    if (!isCognitoUserNotFoundError(error)) {
      console.error('Failed to read member sign-in security:', error)
    }
    return { memberKey: member.memberKey, mfa: 'unknown', passwordReset: 'unavailable' }
  }
}

/**
 * Reads the sign-in security state of every given member, a few Cognito lookups at a time.
 *
 * @param members - Active Workspace members.
 * @returns The state of each member, in the order of `members`.
 */
export async function inspectMembersSignInSecurity(
  members: readonly WorkspaceMember[],
): Promise<WorkspaceMemberSignInSecurity[]> {
  const results = new Map<number, WorkspaceMemberSignInSecurity>()
  let next = 0
  const worker = async () => {
    while (next < members.length) {
      const index = next
      next += 1
      results.set(index, await inspectMemberSignInSecurity(members[index]))
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(memberInspectionConcurrency, members.length) }, worker),
  )
  return members.map((member, index) => results.get(index) ?? {
    memberKey: member.memberKey,
    mfa: 'unknown',
    passwordReset: 'unavailable',
  })
}

/**
 * Counts the active members that an MFA requirement would send to authenticator setup.
 *
 * @param workspaceId - Workspace whose active members are counted.
 * @returns Members without TOTP, and members whose state could not be read.
 */
export async function summarizeMfaEnrollment(workspaceId: string) {
  const members = await workspaceDependencies.workspaceAccess.listActiveMembers(workspaceId)
  const states = await inspectMembersSignInSecurity(members)
  return {
    activeMemberCount: members.length,
    unenrolledMemberCount: states.filter((state) => state.mfa === 'not-enrolled').length,
    unknownMemberCount: states.filter((state) => state.mfa === 'unknown').length,
  }
}
