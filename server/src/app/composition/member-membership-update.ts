import type { MemberMembershipUpdatePorts } from '../../modules/workspace-access'
import type { DeveloperPlatformDependencies, WorkspaceDependencies } from './app-dependencies'
import { createMemberCredentialRevoker } from './member-credential-revoker'

/** Adapters the Workspace member role and status update is wired to. */
export type MemberMembershipUpdateAdapters = {
  /** Workspace store that reads and updates the member. */
  workspace: Pick<WorkspaceDependencies, 'workspaceAccess'>
  /** API keys and OAuth applications the member created. */
  developerPlatform: Pick<DeveloperPlatformDependencies, 'apiKeys' | 'oauthCredentials'>
}

/**
 * Connects the member role and status update use case to the Workspace store and the developer
 * platform credentials.
 *
 * @param adapters - Concrete adapters bound to the request.
 * @returns The ports.
 */
export function createMemberMembershipUpdatePorts({
  workspace,
  developerPlatform,
}: MemberMembershipUpdateAdapters): MemberMembershipUpdatePorts {
  const { workspaceAccess } = workspace
  return {
    getMember: (workspaceId, memberKey) => workspaceAccess.getMember(workspaceId, memberKey),
    updateMember: (workspaceId, actorMemberKey, memberKey, input, auditContext) =>
      workspaceAccess.updateMember(workspaceId, actorMemberKey, memberKey, input, auditContext),
    revokeMemberCredentials: createMemberCredentialRevoker(developerPlatform),
  }
}
