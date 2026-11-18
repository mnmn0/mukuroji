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
  /**
   * Whether any MFA method is enabled, SMS and email included. Sign-in asks only members without
   * any method to register an authenticator app when the Workspace policy requires MFA.
   */
  mfaConfigured: boolean
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
  const inspections = await inspectMembers(ports, await ports.listActiveMembers(workspaceId))
  return inspections.map((inspection) => inspection.state)
}

/**
 * Counts the active members that an MFA requirement would send to authenticator setup.
 *
 * Follows the sign-in rule, so a member with SMS or email MFA but no authenticator app is not
 * counted: sign-in lets that member through without the setup.
 *
 * @param ports - Member store and identity provider ports.
 * @param workspaceId - Workspace whose active members are counted.
 * @returns Members without any MFA method, and members whose state could not be read.
 */
export async function summarizeMfaEnrollment(ports: MemberSignInSecurityPorts, workspaceId: string) {
  const members = await ports.listActiveMembers(workspaceId)
  const inspections = await inspectMembers(ports, members)
  return {
    activeMemberCount: members.length,
    unenrolledMemberCount: inspections.filter((inspection) => inspection.setupRequiredByMfaPolicy).length,
    unknownMemberCount: inspections.filter((inspection) => inspection.state.mfa === 'unknown').length,
  }
}

/** What inspecting one member found. */
type MemberInspection = {
  /** State reported in the roster. */
  state: WorkspaceMemberSignInSecurity
  /** Whether sign-in would send the member to authenticator setup if the policy required MFA. */
  setupRequiredByMfaPolicy: boolean
}

/**
 * Inspects members a few identity provider lookups at a time.
 *
 * @param ports - Identity provider ports.
 * @param members - Active members.
 * @returns What was found for each member, in the order of `members`.
 */
async function inspectMembers(
  ports: MemberSignInSecurityPorts,
  members: readonly WorkspaceMember[],
): Promise<MemberInspection[]> {
  const results = new Map<number, MemberInspection>()
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
  return members.map((member, index) => results.get(index) ?? unknownInspection(member))
}

/**
 * Reads how one member signs in.
 *
 * @param ports - Identity provider ports.
 * @param member - Active member.
 * @returns What was found for the member.
 */
async function inspectMember(
  ports: MemberSignInSecurityPorts,
  member: WorkspaceMember,
): Promise<MemberInspection> {
  // A failed SSO lookup fails the whole request, so an SSO member is never shown as resettable.
  if (await ports.isSsoManagedEmail(member.email)) {
    return {
      state: { memberKey: member.memberKey, mfa: 'sso', passwordReset: 'sso' },
      setupRequiredByMfaPolicy: false,
    }
  }
  try {
    const profile = await ports.readSignInProfile(member.memberKey)
    if (!profile) return unknownInspection(member)
    const mfa: WorkspaceMemberMfaStatus = profile.softwareTokenMfaConfigured ? 'enrolled' : 'not-enrolled'
    const passwordReset: WorkspaceMemberPasswordResetAvailability = profile.invitationPending
      ? 'invitation-pending'
      : profile.disabled
        ? 'unavailable'
        : 'available'
    return {
      state: { memberKey: member.memberKey, mfa, passwordReset },
      setupRequiredByMfaPolicy: !profile.mfaConfigured,
    }
  } catch (error) {
    ports.reportFailure(error)
    return unknownInspection(member)
  }
}

/**
 * Describes a member whose sign-in state could not be read.
 *
 * @param member - Active member.
 * @returns The unknown state, which is counted apart from the members that need setup.
 */
function unknownInspection(member: WorkspaceMember): MemberInspection {
  return {
    state: { memberKey: member.memberKey, mfa: 'unknown', passwordReset: 'unavailable' },
    setupRequiredByMfaPolicy: false,
  }
}
