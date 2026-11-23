import type { MutationAuditContext } from '../../audit'
import {
  WorkspaceAccessError,
  type WorkspaceMember,
  type WorkspaceMemberCredentialProgress,
  type WorkspaceMemberSystemAdministratorAction,
} from '../workspace-access'

/** Ports the system administrator change use case needs (ADR 0067). */
export type MemberSystemAdministratorPorts = {
  /** Reads an active member, or undefined when the member is missing or deactivated. */
  getActiveMember(workspaceId: string, memberKey: string): Promise<WorkspaceMember | undefined>
  /**
   * Tells whether the member's sign-in account belongs to this Workspace's directory, so that a
   * grant here cannot raise the account in another Workspace.
   */
  isAccountInWorkspace(workspaceId: string, memberKey: string): Promise<boolean>
  /** Tells whether the member is in a system administrator group now. */
  isSystemAdministrator(memberKey: string): Promise<boolean>
  /** Reads how far a request with the same idempotency key got with this action. */
  readActionProgress(
    workspaceId: string,
    memberKey: string,
    action: WorkspaceMemberSystemAdministratorAction,
    auditContext: MutationAuditContext | undefined,
  ): Promise<WorkspaceMemberCredentialProgress>
  /**
   * Checks that the actor is an owner and the target may take the change, records the action in
   * the audit log, and claims it so that only one attempt changes the group at a time.
   */
  recordAction(
    workspaceId: string,
    actorMemberKey: string,
    memberKey: string,
    action: WorkspaceMemberSystemAdministratorAction,
    auditContext: MutationAuditContext | undefined,
  ): Promise<{ completed: boolean }>
  /** Marks that this attempt is about to change the group. */
  markActionApplying(
    workspaceId: string,
    memberKey: string,
    action: WorkspaceMemberSystemAdministratorAction,
    auditContext: MutationAuditContext | undefined,
  ): Promise<void>
  /** Marks the recorded action as finished. */
  completeAction(
    workspaceId: string,
    memberKey: string,
    action: WorkspaceMemberSystemAdministratorAction,
    auditContext: MutationAuditContext | undefined,
  ): Promise<void>
  /** Adds the member to the system administrator group. */
  addSystemAdministrator(memberKey: string): Promise<void>
  /** Removes the member from every system administrator group. */
  removeSystemAdministrator(memberKey: string): Promise<void>
  /** Records a failure that does not undo the completed change. */
  reportFailure(message: string, error: unknown, correlationId: string | undefined): void
}

/** Input of {@link changeMemberSystemAdministrator}. */
export type MemberSystemAdministratorInput = {
  /** Workspace of the actor and the member. */
  workspaceId: string
  /** Member key of the owner making the change. */
  actorMemberKey: string
  /** Member whose system administrator access changes. */
  memberKey: string
  /** Whether the member should be a system administrator afterwards. */
  systemAdministrator: boolean
  /** Audit context of the request, carrying its idempotency key. */
  auditContext?: MutationAuditContext
}

/** Result of {@link changeMemberSystemAdministrator}. */
export type MemberSystemAdministratorResult = {
  /** Whether the member is a system administrator afterwards. */
  systemAdministrator: boolean
  /** Whether this request changed the group; false when the member already had that state. */
  changed: boolean
}

/** How many times the use case tries to mark a finished change as completed. */
const completionAttempts = 3

/**
 * Grants or revokes system administrator access for a member, for an owner.
 *
 * System administrators stay the members of the configured Cognito groups. The change is
 * recorded in the audit log before the group changes and marked completed after it, with the
 * same progress record the administrator credential resets use, so a retry with the same
 * idempotency key does not repeat a change that finished or may have started. A member who
 * already has the requested state is left as is and nothing is recorded.
 *
 * @param ports - Member, identity, and audit ports.
 * @param input - Actor, member, requested state, and audit context.
 * @returns The state afterwards, and whether this request changed it.
 * @throws WorkspaceAccessError 404 when the member is not active, 409 when the member's account
 *   belongs to another directory, and the authority errors of the record step.
 */
export async function changeMemberSystemAdministrator(
  ports: MemberSystemAdministratorPorts,
  input: MemberSystemAdministratorInput,
): Promise<MemberSystemAdministratorResult> {
  const member = await ports.getActiveMember(input.workspaceId, input.memberKey)
  if (!member) {
    throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
  }
  const action: WorkspaceMemberSystemAdministratorAction = input.systemAdministrator
    ? 'system-administrator-granted'
    : 'system-administrator-revoked'
  const result = { systemAdministrator: input.systemAdministrator, changed: true }

  const progress = await ports.readActionProgress(
    input.workspaceId,
    member.memberKey,
    action,
    input.auditContext,
  )
  if (progress === 'completed') {
    return result
  }
  if (progress === 'none') {
    if (!await ports.isAccountInWorkspace(input.workspaceId, member.memberKey)) {
      throw new WorkspaceAccessError(
        409,
        'MemberSystemAdministratorUnavailable',
        'This member\'s sign-in account belongs to another Workspace.',
      )
    }
    if (await ports.isSystemAdministrator(member.memberKey) === input.systemAdministrator) {
      return { ...result, changed: false }
    }
  }

  const claim = await ports.recordAction(
    input.workspaceId,
    input.actorMemberKey,
    member.memberKey,
    action,
    input.auditContext,
  )
  if (claim.completed) {
    return result
  }

  await ports.markActionApplying(input.workspaceId, member.memberKey, action, input.auditContext)
  if (input.systemAdministrator) {
    await ports.addSystemAdministrator(member.memberKey)
  } else {
    await ports.removeSystemAdministrator(member.memberKey)
  }

  let lastError: unknown
  for (let attempt = 0; attempt < completionAttempts; attempt += 1) {
    try {
      await ports.completeAction(input.workspaceId, member.memberKey, action, input.auditContext)
      return result
    } catch (error) {
      lastError = error
    }
  }
  ports.reportFailure(
    'Failed to mark the system administrator change as completed.',
    lastError,
    input.auditContext?.correlationId,
  )
  return result
}
