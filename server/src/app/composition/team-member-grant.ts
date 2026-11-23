import type { MutationAuditContext } from '../../modules/audit/audit'
import {
  ProjectDataError,
  type DirectoryAuthorizationConditionChecks,
  type ProjectDirectoryClient,
  type TeamMemberGrantPorts,
} from '../../modules/directory'
import type { WorkspaceAccessClient } from '../../modules/workspace-access/workspace-access'

/** Request-specific parts of the Team-wide member grant, supplied by the HTTP route. */
export type TeamMemberGrantRequestPorts = Pick<
  TeamMemberGrantPorts<DirectoryAuthorizationConditionChecks[number], MutationAuditContext>,
  'canManageProject' | 'createAuditContext'
> & {
  /** Idempotency key hash and request fingerprint, joined by `:`, recorded on each granted row. */
  grantRequestKey: string
}

/**
 * Connects the Team-wide member grant use case to the directory store and the Workspace access
 * table.
 *
 * @param projectDirectory - Directory store of the request.
 * @param workspaceAccess - Workspace access client of the request.
 * @param request - Permission predicate and audit context of the caller's request.
 * @returns The ports of the use case.
 */
export function createTeamMemberGrantPorts(
  projectDirectory: ProjectDirectoryClient,
  workspaceAccess: WorkspaceAccessClient,
  request: TeamMemberGrantRequestPorts,
): TeamMemberGrantPorts<DirectoryAuthorizationConditionChecks[number], MutationAuditContext> {
  return {
    getDirectoryAdministration: (workspaceId) => projectDirectory.getDirectoryAdministration(workspaceId),
    addProjectMemberIfAbsent: (...args) =>
      projectDirectory.addProjectMemberIfAbsent(...args, request.grantRequestKey),
    requireUnusedGrantRequest: (workspaceId) =>
      projectDirectory.requireUnusedProjectGrantRequest(workspaceId, request.grantRequestKey),
    async readActiveMemberVersion(workspaceId, memberKey) {
      const member = await workspaceAccess.getActiveMember(workspaceId, memberKey)
      if (!member) {
        throw new ProjectDataError(
          409,
          'WorkspaceMemberInactive',
          'Only active Workspace members can lead a Team or be added to its Projects.',
        )
      }
      return member.version
    },
    canManageProject: request.canManageProject,
    createAuditContext: request.createAuditContext,
  }
}
