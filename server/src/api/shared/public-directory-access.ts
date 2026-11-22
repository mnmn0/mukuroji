import type {
  PublicCredentialOwner,
  PublicProjectMemberList,
  PublicTeamList,
  PublicWorkItemKeyLookup,
  WorkItemKeyLookupResponse,
} from '@mukuroji/contracts'
import { ProjectDataError, type ProjectDirectoryResponse } from '../../modules/directory'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import {
  PublicApiServiceError,
  type PublicDirectoryService,
} from '../../modules/developer-platform/public-api'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { resolveDeveloperCredentialPrincipal } from './developer-platform-access'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { requirePlanningUpdateProjectPermission } from './planning-access'
import {
  getEffectiveProjectAccessList,
  requireAssignedProjectPermission,
  requireTeamPermission,
  type WorkspacePrincipal,
} from './project-access'
import { projectAccessAllows } from './workspace-access'

/**
 * Narrows the Project directory to what a principal may see: every Project they can view, and
 * the Teams that hold one or that Enterprise RBAC grants directly. A system administrator sees
 * the whole directory.
 *
 * @param principal - Current Workspace principal.
 * @param directory - Whole Project directory of the Workspace.
 * @returns The directory with hidden Teams and Projects left out.
 */
export async function filterReadableProjectDirectory(
  principal: WorkspacePrincipal,
  directory: ProjectDirectoryResponse,
): Promise<ProjectDirectoryResponse> {
  if (principal.isSystemAdmin) return directory
  const readableProjectIds = new Set(
    (await getEffectiveProjectAccessList(principal))
      .filter((access) => projectAccessAllows(access, 'viewer'))
      .map((access) => access.projectId),
  )
  const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  return {
    ...directory,
    teams: directory.teams
      .map((team) => ({
        ...team,
        projects: team.projects.filter((project) => readableProjectIds.has(project.id)),
      }))
      .filter((team) => authorizedTeamIds.has(team.id) || team.projects.length > 0),
  }
}

/**
 * Resolves a Work Item key such as `ABC-123` to the Work Item it names, when the principal can
 * read that Work Item.
 *
 * Text that is not a key, an unused key, a deleted Work Item, and a Work Item the principal cannot
 * read all resolve to nothing, so a key reveals nothing to someone without access.
 *
 * @param principal - Current Workspace principal.
 * @param key - Key text from the request.
 * @returns The key's Team and Work Item, or undefined when no readable Work Item has the key.
 */
export async function resolveReadableWorkItemKey(
  principal: WorkspacePrincipal,
  key: string,
): Promise<WorkItemKeyLookupResponse | undefined> {
  const location = await workItemDependencies.teamIssues.getWorkItemKeyLocation(principal.directoryId, key)
  if (!location) return undefined
  try {
    const context = await requireTeamPermission(principal, location.teamId, 'viewer')
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      location.teamId,
      location.workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')
    // A deleted Work Item keeps its key row, and a fixed ID can be created again with a new key,
    // so the row only counts when the Work Item at that ID still carries this key.
    if (detail.issue.key !== location.key) return undefined
  } catch (error) {
    if (
      isTeamIssueNotFoundError(error) ||
      error instanceof ProjectDataError && (error.status === 403 || error.status === 404)
    ) {
      return undefined
    }
    throw error
  }
  return { key: location.key, teamId: location.teamId, workItemId: location.workItemId }
}

/**
 * Reads the credential owner as a Public API client sees them.
 *
 * @param credential - Authenticated developer credential.
 * @returns The owner's Workspace, member ID, name, and email.
 */
async function readCredentialOwner(credential: AuthenticatedDeveloperCredential): Promise<PublicCredentialOwner> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, { permission: 'workspace.read' })
  const member = principal.workspaceMember
  if (!member) {
    throw new PublicApiServiceError(403, 'forbidden', 'The credential owner is not an active Workspace member.')
  }
  return {
    schemaVersion: 1,
    workspaceId: principal.directoryId,
    memberId: credential.subjectUserId,
    ...(member.name ? { name: member.name } : {}),
    email: member.email,
  }
}

/**
 * Lists the Teams and Projects the credential owner can view, with each Project's charter summary.
 *
 * @param credential - Authenticated developer credential.
 * @param locale - Locale of the Team and Project names.
 * @returns Readable Teams in directory order.
 */
async function listCredentialTeams(
  credential: AuthenticatedDeveloperCredential,
  locale: 'ja' | 'en',
): Promise<PublicTeamList> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'teams.read',
    alternativePermissions: ['projects.read'],
    evaluateProjectScopes: true,
  })
  const directory = await filterReadableProjectDirectory(
    principal,
    await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, locale),
  )
  return {
    schemaVersion: 1,
    items: directory.teams.map((team) => ({
      id: team.id,
      name: team.name,
      projects: team.projects.map((project) => ({
        id: project.id,
        name: project.name,
        lifecycleState: project.lifecycleState,
        ...(project.charter?.code ? { code: project.charter.code } : {}),
        ...(project.charter?.owner ? { ownerMemberId: project.charter.owner.userId } : {}),
        ...(project.charter?.plannedStartDate ? { plannedStartDate: project.charter.plannedStartDate } : {}),
        ...(project.charter?.plannedEndDate ? { plannedEndDate: project.charter.plannedEndDate } : {}),
      })),
    })),
  }
}

/**
 * Lists the active members of a Project, for an owner who may assign work in it.
 *
 * The rule matches the Web assignee picker: the owner needs member access to the Project. A member
 * whose Workspace membership is not active is left out, because work cannot be assigned to them.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Active members of the Project with their Project roles.
 */
async function listCredentialProjectMembers(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  projectId: string,
): Promise<PublicProjectMemberList> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'projects.write',
    alternativePermissions: ['work-items.write'],
    teamId,
    projectId,
    evaluateProjectScopes: true,
  })
  await requirePlanningUpdateProjectPermission(principal, teamId, projectId, 'member')
  const { members } = await workspaceDependencies.projectDirectory.getProjectMembers(
    principal.directoryId,
    projectId,
    teamId,
  )
  const items = await Promise.all(members.map(async (member) => {
    const workspaceMember = await workspaceDependencies.workspaceAccess.getMember(principal.directoryId, member.id)
    if (workspaceMember?.status !== 'active') return undefined
    return {
      id: member.id,
      ...(workspaceMember.name ? { name: workspaceMember.name } : {}),
      email: workspaceMember.email,
      role: member.role,
    }
  }))
  return {
    schemaVersion: 1,
    teamId,
    projectId,
    items: items.filter((item) => item !== undefined),
  }
}

/**
 * Resolves a Work Item key for the credential owner.
 *
 * @param credential - Authenticated developer credential.
 * @param key - Key text from the request.
 * @returns The key's Team and Work Item.
 */
async function lookupCredentialWorkItemKey(
  credential: AuthenticatedDeveloperCredential,
  key: string,
): Promise<PublicWorkItemKeyLookup> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.read',
    evaluateProjectScopes: true,
  })
  const location = await resolveReadableWorkItemKey(principal, key)
  if (!location) {
    throw new PublicApiServiceError(404, 'not_found', 'No readable Work Item has this key.')
  }
  return { schemaVersion: 1, ...location }
}

/**
 * Creates the Public API directory service backed by the canonical Project directory and the
 * credential owner's current permissions.
 *
 * @returns Directory service for `/api/v1/me`, `/api/v1/teams`, Project members, and key lookup.
 */
export function createCanonicalPublicDirectoryService(): PublicDirectoryService {
  return {
    getCredentialOwner: readCredentialOwner,
    listTeams: listCredentialTeams,
    listProjectMembers: listCredentialProjectMembers,
    lookupWorkItemKey: lookupCredentialWorkItemKey,
  }
}
