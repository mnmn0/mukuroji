import { revokeMemberCredentials } from '../../modules/developer-platform'
import type {
  ManagedMemberCredentialRevocationPorts,
  MemberCredentialRevoker,
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
  return (workspaceId, memberKey, actorId) =>
    revokeMemberCredentials(developerPlatform, workspaceId, memberKey, actorId)
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
    revokeMemberCredentials: createMemberCredentialRevoker(developerPlatform),
  }
}

