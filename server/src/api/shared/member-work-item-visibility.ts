import { type EnterpriseIdentitySnapshot, type EnterprisePermissionId } from '@mukuroji/contracts'
import {
  type ProjectDirectoryResponse,
  type ProjectDirectoryTeamResponse,
} from '../../modules/directory'
import { isCognitoUserNotFoundError } from '../../modules/authentication'
import {
  evaluateEnterpriseAccess,
  type EnterpriseAuthorizationResource,
  resolveEnterpriseDirectoryPrincipal,
} from '../../modules/enterprise-identity'
import { resolveNotificationRecipientBoundary } from '../../modules/notifications'
import { type WorkspaceMember } from '../../modules/workspace-access/workspace-access'
import { type AutomationActionExecutorDependencies } from './app-dependencies'
import {
  hasUnqualifiedEnterpriseProjectScope,
  qualifyEnterpriseProjectScopes,
} from './enterprise-access'
import { resolveProjectAccessTeamId } from './project-access'
import { projectAccessAllows } from './workspace-access'

/** Ports used to decide whether another Workspace member can view a Work Item. */
export type MemberWorkItemVisibilityDependencies = {
  /** Reads the member's current Cognito groups and system-administrator state. */
  cognito: Pick<AutomationActionExecutorDependencies['cognito'], 'getUserGroups' | 'isSystemAdmin'>
  /** Reads the current Enterprise Identity snapshot. */
  enterpriseIdentity: AutomationActionExecutorDependencies['enterpriseIdentity']
  /** Reads the active Project Directory and the member's legacy Project membership. */
  projectDirectory: Pick<
    AutomationActionExecutorDependencies['projectDirectory'],
    'getProjectAccessList' | 'getProjectDirectory'
  >
}

/** Work Item scope whose visibility is checked for another Workspace member. */
export type MemberWorkItemVisibilityScope = {
  /** Workspace that owns the Work Item. */
  workspaceId: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Project the Work Item is assigned to; absent for a Team-level Work Item. */
  assignedProjectId?: string
  /** Permissions the member must all hold on the scope, such as `work-items.read`. */
  permissions: readonly EnterprisePermissionId[]
}

/** Reads shared by every member checked for one request, so each is read at most once. */
export type MemberWorkItemVisibilityReads = {
  /** Reads the current active Project Directory. */
  directory: () => Promise<ProjectDirectoryResponse>
  /** Reads the current Enterprise Identity snapshot. */
  snapshot: () => Promise<EnterpriseIdentitySnapshot>
}

/**
 * Creates memoized reads for checking several members of one Workspace.
 *
 * @param workspaceId - Workspace whose directory and snapshot are read.
 * @param dependencies - Ports for Enterprise Identity and the Project Directory.
 * @param directory - Current active Project Directory, when the caller already read it.
 * @returns Lazily evaluated reads shared by every check.
 */
export function createMemberWorkItemVisibilityReads(
  workspaceId: string,
  dependencies: Pick<MemberWorkItemVisibilityDependencies, 'enterpriseIdentity' | 'projectDirectory'>,
  directory?: ProjectDirectoryResponse,
): MemberWorkItemVisibilityReads {
  let directoryRead: Promise<ProjectDirectoryResponse> | undefined = directory
    ? Promise.resolve(directory)
    : undefined
  let snapshotRead: Promise<EnterpriseIdentitySnapshot> | undefined
  return {
    directory: () => directoryRead ??= dependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja', true),
    snapshot: () => snapshotRead ??= dependencies.enterpriseIdentity.getSnapshot(workspaceId),
  }
}

/**
 * Checks whether another active Workspace member can currently view a Work Item scope.
 *
 * The check follows the same model as request-time Work Item authorization. When the current
 * Enterprise snapshot makes Enterprise authoritative for the member (directory management, a
 * personal or directory-group role assignment, or an enabled group mapping), only the Enterprise
 * evaluation decides and legacy Project membership is ignored. Otherwise legacy Project
 * membership decides, qualified by Team so that a Project ID shared by several Teams fails
 * closed. A Team-level Work Item is visible through the Team or any of its active Projects,
 * as in `requireTeamPermission`. A system administrator can always view; Cognito is asked
 * only after the other checks deny, as before.
 *
 * @param member - Active Workspace member being checked.
 * @param scope - Work Item scope and the permissions the member needs on it.
 * @param dependencies - Ports for Cognito, Enterprise Identity, and the Project Directory.
 * @param reads - Memoized reads shared by the members of one request.
 * @returns Whether the member can view the Work Item scope.
 */
export async function canMemberViewWorkItemScope(
  member: Pick<WorkspaceMember, 'email' | 'memberKey' | 'role'>,
  scope: MemberWorkItemVisibilityScope,
  dependencies: MemberWorkItemVisibilityDependencies,
  reads: MemberWorkItemVisibilityReads =
    createMemberWorkItemVisibilityReads(scope.workspaceId, dependencies),
): Promise<boolean> {
  const memberKey = member.memberKey.trim().toLowerCase()
  if (await hasWorkItemScopeAccess(memberKey, member, scope, dependencies, reads)) return true
  return await dependencies.cognito.isSystemAdmin(memberKey)
}

/**
 * Evaluates Enterprise or legacy Project access without the system-administrator override.
 *
 * @param memberKey - Normalized member key.
 * @param member - Active Workspace member being checked.
 * @param scope - Work Item scope and the permissions the member needs on it.
 * @param dependencies - Ports for Cognito and the Project Directory.
 * @param reads - Memoized directory and snapshot reads.
 * @returns Whether the member's roles or memberships allow viewing the scope.
 */
async function hasWorkItemScopeAccess(
  memberKey: string,
  member: Pick<WorkspaceMember, 'email' | 'role'>,
  scope: MemberWorkItemVisibilityScope,
  dependencies: MemberWorkItemVisibilityDependencies,
  reads: MemberWorkItemVisibilityReads,
): Promise<boolean> {
  const activeDirectory = await reads.directory()
  const team = activeDirectory.teams.find((candidate) => candidate.id === scope.teamId)
  if (!team) return false
  if (
    scope.assignedProjectId !== undefined &&
    !team.projects.some((project) => project.id === scope.assignedProjectId)
  ) {
    return false
  }

  const snapshot = await reads.snapshot()
  if (snapshot.workspaceId !== scope.workspaceId) return false
  const boundary = resolveNotificationRecipientBoundary(snapshot, memberKey, member.email, member.role)
  if (!boundary.allowed) return false
  // A ceiling the Workspace configured binds every route. Without a configured policy, the
  // request boundary applies the default external ceiling only to Enterprise-evaluated access and
  // leaves legacy access to the legacy handlers, so the default ceiling is applied below with the
  // Enterprise evaluation only. The default holds every read permission, so read checks are the
  // same either way; a write-like permission such as `files.approve` follows the request boundary.
  if (
    boundary.permissionCeiling &&
    snapshot.policy !== undefined &&
    !scope.permissions.every((permission) => boundary.permissionCeiling?.includes(permission))
  ) {
    return false
  }

  const evaluateEnterprise = (cognitoGroupIds: readonly string[]) => {
    const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(snapshot, memberKey, cognitoGroupIds)
    if (directoryPrincipal.deprovisioned) {
      return { deprovisioned: true, authoritative: true, allowed: false }
    }
    const needsProjectScopeQualification =
      hasUnqualifiedEnterpriseProjectScope(directoryPrincipal.compatibleRoleAssignments) ||
      hasUnqualifiedEnterpriseProjectScope(directoryPrincipal.compatibleGroupMappings)
    const assignments = needsProjectScopeQualification
      ? qualifyEnterpriseProjectScopes(directoryPrincipal.compatibleRoleAssignments, activeDirectory)
      : directoryPrincipal.compatibleRoleAssignments
    const groupMappings = needsProjectScopeQualification
      ? qualifyEnterpriseProjectScopes(directoryPrincipal.compatibleGroupMappings, activeDirectory)
      : directoryPrincipal.compatibleGroupMappings
    const authoritative = directoryPrincipal.directoryManaged ||
      assignments.some((assignment) =>
        assignment.principalKind === 'member' &&
          assignment.principalId.trim().toLowerCase() === memberKey ||
        assignment.principalKind === 'directory-group' && (
          assignment.source === 'directory-mapping' ||
          directoryPrincipal.directoryGroupIds.includes(assignment.principalId)
        )
      ) || groupMappings.some((mapping) => mapping.enabled)
    const allowed = authoritative && listWorkItemScopeResources(scope, team).some((resource) => {
      const access = evaluateEnterpriseAccess({
        permission: scope.permissions[0] ?? 'work-items.read',
        principal: {
          kind: 'member',
          principalId: memberKey,
          directoryGroupIds: directoryPrincipal.directoryGroupIds,
          directoryGroupMemberships: directoryPrincipal.directoryGroupMemberships,
          workspaceRole: member.role,
          includeWorkspaceRolePermissions: false,
          directPermissions: ['workspace.read'],
          systemAdministrator: false,
          ...(boundary.permissionCeiling ? { permissionCeiling: boundary.permissionCeiling } : {}),
        },
        assignments,
        customRoles: snapshot.customRoles,
        groupMappings,
        resource,
      })
      return scope.permissions.every((permission) => access.permissions.includes(permission))
    })
    return { deprovisioned: false, authoritative, allowed }
  }

  // Enterprise grants only add permissions, so a grant found without Cognito groups stands
  // whatever the groups are, and a group read that fails cannot take it away.
  const withoutGroups = evaluateEnterprise([])
  if (withoutGroups.deprovisioned) return false
  if (withoutGroups.allowed) return true
  // Cognito groups only match role assignments made directly to a group, so skip the read
  // when the snapshot has none.
  const enterprise = snapshot.roleAssignments.some((assignment) =>
    assignment.principalKind === 'directory-group'
  )
    ? evaluateEnterprise(await readMemberCognitoGroups(memberKey, dependencies))
    : withoutGroups
  if (enterprise.authoritative) return enterprise.allowed

  const accesses = await dependencies.projectDirectory.getProjectAccessList(
    scope.workspaceId,
    memberKey,
  )
  return accesses.some((access) =>
    resolveProjectAccessTeamId(access, activeDirectory) === team.id &&
    (scope.assignedProjectId === undefined
      ? team.projects.some((project) => project.id === access.projectId)
      : access.projectId === scope.assignedProjectId) &&
    projectAccessAllows(access, 'viewer')
  )
}

/**
 * Reads a member's Cognito groups, treating a member with no Cognito user as having none.
 *
 * @param memberKey - Normalized member key.
 * @param dependencies - Port for Cognito group reads.
 * @returns Current Cognito group names.
 */
async function readMemberCognitoGroups(
  memberKey: string,
  dependencies: Pick<MemberWorkItemVisibilityDependencies, 'cognito'>,
): Promise<string[]> {
  try {
    return await dependencies.cognito.getUserGroups(memberKey)
  } catch (error) {
    if (isCognitoUserNotFoundError(error)) return []
    throw error
  }
}

/**
 * Lists the Enterprise resources through which a Work Item scope can be viewed.
 *
 * @param scope - Work Item scope being checked.
 * @param team - Active owner Team of the Work Item.
 * @returns The assigned Project, or the Team followed by each of its active Projects.
 */
function listWorkItemScopeResources(
  scope: MemberWorkItemVisibilityScope,
  team: Pick<ProjectDirectoryTeamResponse, 'id' | 'projects'>,
): EnterpriseAuthorizationResource[] {
  const projectResource = (projectId: string): EnterpriseAuthorizationResource => ({
    workspaceId: scope.workspaceId,
    kind: 'project',
    targetId: projectId,
    parentTeamId: team.id,
  })
  if (scope.assignedProjectId !== undefined) return [projectResource(scope.assignedProjectId)]
  return [
    { workspaceId: scope.workspaceId, kind: 'team', targetId: team.id },
    ...team.projects.map((project) => projectResource(project.id)),
  ]
}
