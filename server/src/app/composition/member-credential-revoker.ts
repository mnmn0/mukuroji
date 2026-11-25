import { listMemberActiveCredentials, revokeMemberCredentials } from '../../modules/developer-platform'
import type {
  DirectoryMemberReconciliationPorts,
  ManagedMemberCredentialRevocationPorts,
  MemberCredentialRevoker,
  WorkspaceAccessClient,
} from '../../modules/workspace-access'
import type { DeveloperPlatformDependencies, WorkspaceDependencies } from './app-dependencies'

/** Developer platform adapters a member credential revocation uses. */
export type MemberCredentialRevocationAdapters = Pick<DeveloperPlatformDependencies, 'apiKeys' | 'oauthCredentials'>

/**
 * Connects the Workspace Access credential revocation port to the developer platform.
 *
 * @param developerPlatform - API key and OAuth application adapters bound to the request.
 * @returns The revoker.
 */
export function createMemberCredentialRevoker(
  developerPlatform: MemberCredentialRevocationAdapters,
): MemberCredentialRevoker {
  return (workspaceId, memberKey, actorId, limitTo) =>
    revokeMemberCredentials(developerPlatform, workspaceId, memberKey, actorId, limitTo)
}

/**
 * Connects an administrator's revocation of a member's credentials to the Workspace store and the
 * developer platform.
 *
 * @param adapters - Workspace store and developer platform adapters bound to the request.
 * @returns The ports.
 */
export function createManagedMemberCredentialRevocationPorts({
  workspace,
  developerPlatform,
}: {
  /** Workspace store that reads the member. */
  workspace: Pick<WorkspaceDependencies, 'workspaceAccess'>
  /** API keys and OAuth applications the member created. */
  developerPlatform: MemberCredentialRevocationAdapters
}): ManagedMemberCredentialRevocationPorts {
  const { workspaceAccess } = workspace
  return {
    getMember: (workspaceId, memberKey) => workspaceAccess.getMember(workspaceId, memberKey),
    listMemberCredentials: async (workspaceId, memberKey) => {
      const credentials = await listMemberActiveCredentials(developerPlatform, workspaceId, memberKey)
      return {
        revokedApiKeyIds: credentials.apiKeys.map((apiKey) => apiKey.id),
        revokedOAuthAppIds: credentials.oauthApps.map((oauthApp) => oauthApp.id),
      }
    },
    revokeMemberCredentials: createMemberCredentialRevoker(developerPlatform),
    ...(workspaceAccess.findMemberCredentialRevocation && workspaceAccess.recordMemberCredentialRevocation
      ? {
          receipts: {
            find: workspaceAccess.findMemberCredentialRevocation.bind(workspaceAccess),
            record: workspaceAccess.recordMemberCredentialRevocation.bind(workspaceAccess),
          },
        }
      : {}),
  }
}

/**
 * Connects the directory member reconciliation to the Workspace store and the developer platform.
 *
 * @param workspaceAccess - Workspace store that reconciles directory members.
 * @param developerPlatform - API key and OAuth application adapters.
 * @returns The ports, or undefined when the store cannot reconcile directory members.
 */
export function createDirectoryMemberReconciliationPorts(
  workspaceAccess: Pick<WorkspaceAccessClient, 'reconcileDirectoryMember'>,
  developerPlatform: MemberCredentialRevocationAdapters,
): DirectoryMemberReconciliationPorts | undefined {
  const { reconcileDirectoryMember } = workspaceAccess
  if (!reconcileDirectoryMember) return undefined
  return {
    reconcileDirectoryMember: (workspaceId, input, auditContext) =>
      reconcileDirectoryMember.call(workspaceAccess, workspaceId, input, auditContext),
    revokeMemberCredentials: createMemberCredentialRevoker(developerPlatform),
  }
}
