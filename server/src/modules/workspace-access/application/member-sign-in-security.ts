import type {
  WorkspaceMemberMfaStatus,
  WorkspaceMemberPasswordResetAvailability,
  WorkspaceMemberSignInSecurity,
} from '@mukuroji/contracts'
import type { WorkspaceMember } from '../workspace-access'

/** Password account state of a member that decides how the member signs in. */
export type MemberSignInProfile = {
  /** Whether an authenticator app (TOTP) is registered. SMS or email MFA does not count. */
  softwareTokenMfaConfigured: boolean
  /** Whether the member has not yet replaced the invitation's temporary password. */
  invitationPending: boolean
  /** Whether the account is disabled in the identity provider. */
  disabled: boolean
}

/** Ports the member sign-in security use cases need. */
export type MemberSignInSecurityPorts = {
  /** Lists the active members of a Workspace. */
  listActiveMembers(workspaceId: string): Promise<readonly WorkspaceMember[]>
  /** Tells whether an identity provider owns the sign-in of this email address. */
  isSsoManagedEmail(email: string): Promise<boolean>
  /** Reads the member's password account, or undefined when the member has none. */
  readSignInProfile(memberKey: string): Promise<MemberSignInProfile | undefined>
  /** Records a failure to read one member, whose state is then reported as unknown. */
  reportFailure(error: unknown): void
}

/** Identity provider lookups that run at the same time while members are inspected. */
const memberInspectionConcurrency = 5

/**
 * Lists how every active member signs in: whether an authenticator app is registered and
 * whether an administrator can send a password reset.
 *
 * Members of an enforced SSO domain are reported as `sso`. A member whose password account
 * cannot be read is reported as `unknown`, so one failure does not hide the rest of the roster.
 *
 * @param ports - Member store and identity provider ports.
 * @param workspaceId - Workspace whose members are listed.
 * @returns The state of each active member, in the store's order.
 */
export async function listMembersSignInSecurity(
  ports: MemberSignInSecurityPorts,
  workspaceId: string,
): Promise<WorkspaceMemberSignInSecurity[]> {
  return await inspectMembers(ports, await ports.listActiveMembers(workspaceId))
}

/**
 * Counts the active members that an MFA requirement would send to authenticator setup.
 *
 * @param ports - Member store and identity provider ports.
 * @param workspaceId - Workspace whose active members are counted.
 * @returns Members without TOTP, and members whose state could not be read.
 */
export async function summarizeMfaEnrollment(ports: MemberSignInSecurityPorts, workspaceId: string) {
  const members = await ports.listActiveMembers(workspaceId)
  const states = await inspectMembers(ports, members)
  return {
    activeMemberCount: members.length,
    unenrolledMemberCount: states.filter((state) => state.mfa === 'not-enrolled').length,
    unknownMemberCount: states.filter((state) => state.mfa === 'unknown').length,
  }
}

/**
 * Inspects members a few identity provider lookups at a time.
 *
 * @param ports - Identity provider ports.
 * @param members - Active members.
 * @returns The state of each member, in the order of `members`.
 */
async function inspectMembers(
  ports: MemberSignInSecurityPorts,
  members: readonly WorkspaceMember[],
): Promise<WorkspaceMemberSignInSecurity[]> {
  const results = new Map<number, WorkspaceMemberSignInSecurity>()
  let next = 0
  const worker = async () => {
    while (next < members.length) {
      const index = next
      next += 1
      results.set(index, await inspectMember(ports, members[index]))
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(memberInspectionConcurrency, members.length) }, worker),
  )
  return members.map((member, index) => results.get(index) ?? unknownState(member))
}

/**
 * Reads how one member signs in.
 *
 * @param ports - Identity provider ports.
 * @param member - Active member.
 * @returns The member's sign-in security state.
 */
async function inspectMember(
  ports: MemberSignInSecurityPorts,
  member: WorkspaceMember,
): Promise<WorkspaceMemberSignInSecurity> {
  // A failed SSO lookup fails the whole request, so an SSO member is never shown as resettable.
  if (await ports.isSsoManagedEmail(member.email)) {
    return { memberKey: member.memberKey, mfa: 'sso', passwordReset: 'sso' }
  }
  try {
    const profile = await ports.readSignInProfile(member.memberKey)
    if (!profile) return unknownState(member)
    const mfa: WorkspaceMemberMfaStatus = profile.softwareTokenMfaConfigured ? 'enrolled' : 'not-enrolled'
    const passwordReset: WorkspaceMemberPasswordResetAvailability = profile.invitationPending
      ? 'invitation-pending'
      : profile.disabled
        ? 'unavailable'
        : 'available'
    return { memberKey: member.memberKey, mfa, passwordReset }
  } catch (error) {
    ports.reportFailure(error)
    return unknownState(member)
  }
}

/**
 * Describes a member whose sign-in state could not be read.
 *
 * @param member - Active member.
 * @returns The unknown state.
 */
function unknownState(member: WorkspaceMember): WorkspaceMemberSignInSecurity {
  return { memberKey: member.memberKey, mfa: 'unknown', passwordReset: 'unavailable' }
}
