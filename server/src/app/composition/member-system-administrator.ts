import type { CognitoClient } from '../../modules/authentication'
import type {
  MemberSystemAdministratorPorts,
  WorkspaceAccessClient,
} from '../../modules/workspace-access'

/** Adapters the system administrator change is wired to. */
export type MemberSystemAdministratorAdapters = {
  /** Cognito client that changes the system administrator group. */
  cognito: CognitoClient
  /** Workspace store that checks authority and records the action. */
  workspaceAccess: WorkspaceAccessClient
}

/**
 * Connects the system administrator change use case to the Workspace store and Cognito.
 *
 * @param adapters - Concrete adapters bound to the request.
 * @returns The ports, or undefined when this deployment cannot change the group.
 */
export function createMemberSystemAdministratorPorts(
  { cognito, workspaceAccess }: MemberSystemAdministratorAdapters,
): MemberSystemAdministratorPorts | undefined {
  const { addSystemAdmin, removeSystemAdmin } = cognito
  const {
    recordMemberCredentialAction,
    readMemberCredentialActionProgress,
    markMemberCredentialActionApplying,
    completeMemberCredentialAction,
  } = workspaceAccess
  // Without the applying stage, a replay after a failed completion mark could repeat the change.
  if (
    !addSystemAdmin ||
    !removeSystemAdmin ||
    !recordMemberCredentialAction ||
    !markMemberCredentialActionApplying
  ) {
    return undefined
  }

  return {
    getActiveMember: (workspaceId, memberKey) => workspaceAccess.getActiveMember(workspaceId, memberKey),
    async isAccountInWorkspace(workspaceId, memberKey) {
      const user = await cognito.findWorkspaceUser(memberKey)
      return user?.directoryId === workspaceId
    },
    isSystemAdministrator: (memberKey) => cognito.isSystemAdmin(memberKey),
    async readActionProgress(...args) {
      return await readMemberCredentialActionProgress?.apply(workspaceAccess, args) ?? 'none'
    },
    recordAction: (...args) => recordMemberCredentialAction.apply(workspaceAccess, args),
    async markActionApplying(...args) {
      await markMemberCredentialActionApplying.apply(workspaceAccess, args)
    },
    async completeAction(...args) {
      await completeMemberCredentialAction?.apply(workspaceAccess, args)
    },
    addSystemAdministrator: (memberKey) => addSystemAdmin.call(cognito, memberKey),
    removeSystemAdministrator: (memberKey) => removeSystemAdmin.call(cognito, memberKey),
    reportFailure(message, error, correlationId) {
      console.error(message, {
        error: error instanceof Error ? error.name : 'UnknownError',
        correlationId,
      })
    },
  }
}
