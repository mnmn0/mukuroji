import { isCognitoUserNotFoundError, type CognitoClient } from '../../modules/authentication'
import type { MemberSignInSecurityPorts, WorkspaceAccessClient } from '../../modules/workspace-access'

/** Adapters the member sign-in security use cases are wired to. */
export type MemberSignInSecurityAdapters = {
  /** Cognito client that holds the members' password accounts. */
  cognito: CognitoClient
  /** Workspace store that lists the active members. */
  workspaceAccess: Pick<WorkspaceAccessClient, 'listActiveMembers'>
  /** Tells whether an identity provider owns the sign-in of an email address. */
  isSsoManagedEmail(email: string): Promise<boolean>
}

/**
 * Connects the member sign-in security use cases to Cognito and the Workspace store.
 *
 * @param adapters - Cognito client, Workspace store and SSO discovery.
 * @returns The ports.
 */
export function createMemberSignInSecurityPorts(
  { cognito, workspaceAccess, isSsoManagedEmail }: MemberSignInSecurityAdapters,
): MemberSignInSecurityPorts {
  return {
    listActiveMembers: (workspaceId) => workspaceAccess.listActiveMembers(workspaceId),
    isSsoManagedEmail,
    async readSignInProfile(memberKey) {
      try {
        const profile = await cognito.getUserProfile(memberKey)
        return {
          softwareTokenMfaConfigured: profile.softwareTokenMfaConfigured === true,
          invitationPending: profile.status === 'FORCE_CHANGE_PASSWORD',
          disabled: profile.enabled === false,
        }
      } catch (error) {
        // A member without a Cognito user has no password account to inspect.
        if (isCognitoUserNotFoundError(error)) return undefined
        throw error
      }
    },
    reportFailure(error) {
      console.error('Failed to read member sign-in security:', error)
    },
  }
}
