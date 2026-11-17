import type { CognitoClient } from '../../modules/authentication'
import {
  WorkspaceAccessError,
  type MemberCredentialResetPorts,
  type WorkspaceAccessClient,
  type WorkspaceMemberCredentialAction,
} from '../../modules/workspace-access'

/** Adapters the administrator credential reset is wired to. */
export type MemberCredentialResetAdapters = {
  /** Cognito client that changes the member's sign-in account. */
  cognito: CognitoClient
  /** Workspace store that checks authority and records the action. */
  workspaceAccess: WorkspaceAccessClient
  /** Tells whether an identity provider owns the sign-in of an email address. */
  isSsoManagedEmail(email: string): Promise<boolean>
}

/**
 * Creates the error for a credential reset this deployment cannot perform.
 *
 * @returns The error.
 */
function createCredentialResetUnavailableError() {
  return new WorkspaceAccessError(503, 'AccountSecurityUnavailable', 'This sign-in operation is not available.')
}

/**
 * Connects the credential reset use case to the Workspace store and Cognito.
 *
 * @param adapters - Concrete adapters bound to the request.
 * @param action - Reset the request asks for.
 * @returns The ports, or undefined when this deployment cannot perform that reset.
 */
export function createMemberCredentialResetPorts(
  { cognito, workspaceAccess, isSsoManagedEmail }: MemberCredentialResetAdapters,
  action: WorkspaceMemberCredentialAction,
): MemberCredentialResetPorts | undefined {
  const { adminResetUserPassword, adminDisableSoftwareTokenMfa } = cognito
  const {
    recordMemberCredentialAction,
    readMemberCredentialActionProgress,
    completeMemberCredentialAction,
  } = workspaceAccess
  const changeCredential = action === 'password-reset-requested'
    ? adminResetUserPassword
    : adminDisableSoftwareTokenMfa
  if (!changeCredential || !recordMemberCredentialAction) {
    return undefined
  }

  return {
    getActiveMember: (workspaceId, memberKey) => workspaceAccess.getActiveMember(workspaceId, memberKey),
    isSsoManagedEmail,
    async readSignInAccount(memberKey) {
      const profile = await cognito.getUserProfile(memberKey)
      return {
        invitationPending: profile.status === 'FORCE_CHANGE_PASSWORD',
        // The reset turns off the authenticator app only, so SMS or email MFA does not count.
        mfaEnrolled: profile.softwareTokenMfaConfigured === true,
      }
    },
    async readActionProgress(...args) {
      return await readMemberCredentialActionProgress?.apply(workspaceAccess, args) ?? 'none'
    },
    recordAction: (...args) => recordMemberCredentialAction.apply(workspaceAccess, args),
    async completeAction(...args) {
      await completeMemberCredentialAction?.apply(workspaceAccess, args)
    },
    async resetPassword(memberKey) {
      if (!adminResetUserPassword) throw createCredentialResetUnavailableError()
      await adminResetUserPassword.call(cognito, memberKey)
    },
    async disableAuthenticator(memberKey) {
      if (!adminDisableSoftwareTokenMfa) throw createCredentialResetUnavailableError()
      await adminDisableSoftwareTokenMfa.call(cognito, memberKey)
    },
    async signOutEverywhere(memberKey) {
      await cognito.globallySignOutWorkspaceUser?.(memberKey)
    },
    reportFailure(message, error) {
      console.error(message, error instanceof Error ? error.name : 'UnknownError')
    },
  }
}
