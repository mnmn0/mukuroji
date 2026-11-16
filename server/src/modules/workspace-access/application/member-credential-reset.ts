import type { MutationAuditContext } from '../../audit'
import {
  WorkspaceAccessError,
  type WorkspaceMember,
  type WorkspaceMemberCredentialAction,
  type WorkspaceMemberCredentialProgress,
} from '../workspace-access'

/** Sign-in state of a member's password account that decides whether a reset applies. */
export type MemberSignInAccount = {
  /** Whether the member has not yet replaced the invitation's temporary password. */
  invitationPending: boolean
  /** Whether the member has an MFA method registered. */
  mfaEnrolled: boolean
}

/** Ports the credential reset use case needs. */
export type MemberCredentialResetPorts = {
  /** Reads an active member, or undefined when the member is missing or deactivated. */
  getActiveMember(workspaceId: string, memberKey: string): Promise<WorkspaceMember | undefined>
  /** Tells whether an identity provider owns the sign-in of this email address. */
  isSsoManagedEmail(email: string): Promise<boolean>
  /** Reads the member's password account state. */
  readSignInAccount(memberKey: string): Promise<MemberSignInAccount>
  /** Reads how far a request with the same idempotency key got with this action. */
  readActionProgress(
    workspaceId: string,
    memberKey: string,
    action: WorkspaceMemberCredentialAction,
    auditContext: MutationAuditContext | undefined,
  ): Promise<WorkspaceMemberCredentialProgress>
  /**
   * Checks the actor's authority over the member, records the action in the audit log, and
   * claims it so that only one attempt changes the account at a time. A retry with the same
   * idempotency key resumes the recorded action, or reports that it already completed.
   */
  recordAction(
    workspaceId: string,
    actorMemberKey: string,
    memberKey: string,
    action: WorkspaceMemberCredentialAction,
    auditContext: MutationAuditContext | undefined,
  ): Promise<{ completed: boolean }>
  /** Marks the recorded action as finished, so that a retry does not change the account again. */
  completeAction(
    workspaceId: string,
    memberKey: string,
    action: WorkspaceMemberCredentialAction,
    auditContext: MutationAuditContext | undefined,
  ): Promise<void>
  /** Invalidates the password and emails a reset code. */
  resetPassword(memberKey: string): Promise<void>
  /** Removes the member's authenticator app. */
  disableAuthenticator(memberKey: string): Promise<void>
  /** Signs the member out of every session. */
  signOutEverywhere(memberKey: string): Promise<void>
  /** Records a failure that does not undo the completed reset. */
  reportFailure(message: string, error: unknown): void
}

/** Input of {@link resetMemberCredential}. */
export type MemberCredentialResetInput = {
  /** Workspace of the actor and the member. */
  workspaceId: string
  /** Member key of the administrator. */
  actorMemberKey: string
  /** Member whose credential is reset. */
  memberKey: string
  /** Which credential to reset. */
  action: WorkspaceMemberCredentialAction
  /** Audit context of the request, carrying its idempotency key. */
  auditContext?: MutationAuditContext
}

/**
 * Sends a password reset to a member, or removes a lost authenticator app, for an administrator.
 *
 * The action is recorded in the audit log before the account changes, and marked completed
 * after it. A retry with the same idempotency key does nothing once the action completed, so a
 * late retry cannot undo an app or password the member set up since. A retry of an action that
 * was recorded but not completed checks the actor's authority again and resumes it without the
 * eligibility checks, because the earlier attempt may already have changed the account. Each
 * attempt claims the action before changing the account, so concurrent retries do not repeat it.
 *
 * @param ports - Member, identity, and audit ports.
 * @param input - Actor, member, action, and audit context.
 * @throws WorkspaceAccessError when the member cannot be found or the reset does not apply.
 */
export async function resetMemberCredential(
  ports: MemberCredentialResetPorts,
  input: MemberCredentialResetInput,
): Promise<void> {
  const member = await ports.getActiveMember(input.workspaceId, input.memberKey)
  if (!member) {
    throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
  }
  if (await ports.isSsoManagedEmail(member.email)) {
    throw new WorkspaceAccessError(
      409,
      'MemberSignInManagedBySso',
      'The identity provider manages this member\'s password and MFA.',
    )
  }

  const progress = await ports.readActionProgress(
    input.workspaceId,
    member.memberKey,
    input.action,
    input.auditContext,
  )
  if (progress === 'completed') {
    return
  }
  if (progress === 'none') {
    const blocked = resolveBlockedReset(input.action, await ports.readSignInAccount(member.memberKey))
    if (blocked) {
      throw blocked
    }
  }
  const claim = await ports.recordAction(
    input.workspaceId,
    input.actorMemberKey,
    member.memberKey,
    input.action,
    input.auditContext,
  )
  if (claim.completed) {
    return
  }

  if (input.action === 'mfa-reset') {
    await ports.disableAuthenticator(member.memberKey)
  } else {
    await ports.resetPassword(member.memberKey)
    try {
      await ports.signOutEverywhere(member.memberKey)
    } catch (error) {
      ports.reportFailure('Failed to sign the member out after a password reset.', error)
    }
  }

  try {
    await ports.completeAction(input.workspaceId, member.memberKey, input.action, input.auditContext)
  } catch (error) {
    ports.reportFailure('Failed to mark the credential reset as completed.', error)
  }
}

/**
 * Explains why a reset does not apply to the member's current account.
 *
 * @param action - Requested reset.
 * @param account - Member's password account state.
 * @returns The error to report, or undefined when the reset applies.
 */
function resolveBlockedReset(action: WorkspaceMemberCredentialAction, account: MemberSignInAccount) {
  if (action === 'password-reset-requested' && account.invitationPending) {
    return new WorkspaceAccessError(
      409,
      'MemberInvitationPending',
      'The member has not accepted the invitation. Resend the invitation instead.',
    )
  }
  if (action === 'mfa-reset' && !account.mfaEnrolled) {
    return new WorkspaceAccessError(
      409,
      'MemberMfaNotEnrolled',
      'The member has no authenticator app to reset.',
    )
  }
  return undefined
}
