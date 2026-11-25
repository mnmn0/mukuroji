import {
  type ProjectCharterPerson,
  toPublicProjectRaidEntry,
  type PublicCredentialOwner,
  type PublicProjectCharter,
  type PublicProjectCharterPerson,
  type PublicProjectMemberList,
  type PublicProjectRaidLog,
  type PublicTeamList,
  type PublicWorkItemKeyLookup,
} from '@mukuroji/contracts'
import { readProjectRaidLogUseCase } from '../../modules/project-raid-log'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import {
  PublicApiServiceError,
  type PublicDirectoryService,
} from '../../modules/developer-platform/public-api'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { resolveDeveloperCredentialPrincipal } from './developer-platform-access'
import { requirePlanningUpdateProjectPermission } from './planning-access'
import { isWorkspaceMemberRowActive } from '../../modules/workspace-access'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  requireProjectPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessRead,
} from './project-access'
import { filterReadableProjectDirectory, resolveReadableWorkItemKey } from './project-directory-visibility'

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
 * whose Workspace membership is not active, or whose access expiry has passed, is left out, because
 * work cannot be assigned to them.
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
  const now = new Date()
  const items = await Promise.all(members.map(async (member) => {
    const workspaceMember = await workspaceDependencies.workspaceAccess.getMember(principal.directoryId, member.id)
    // A member whose access expired keeps an active row until handover, but cannot receive work.
    if (!workspaceMember || !isWorkspaceMemberRowActive(workspaceMember, now)) return undefined
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
 * Lists a Project's risks, issues, and change requests for an owner who can view the Project.
 *
 * The rule matches the Web log panel: viewer access to the Project reads the whole log.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Every entry, newest first, with its severity.
 */
async function listCredentialProjectRaidLog(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  projectId: string,
): Promise<PublicProjectRaidLog> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'projects.read',
    teamId,
    projectId,
    evaluateProjectScopes: true,
  })
  // The same restriction as the Web log GET: guests cannot read Project logs.
  requireWorkspaceBusinessRead(principal)
  await requirePlanningUpdateProjectPermission(principal, teamId, projectId, 'viewer')
  const log = await readProjectRaidLogUseCase(
    workItemDependencies.projectRaidLogs,
    { workspaceId: principal.directoryId, teamId, projectId },
  )
  return {
    schemaVersion: 1,
    teamId,
    projectId,
    items: log.entries.map(toPublicProjectRaidEntry),
  }
}

/**
 * Reads a Project's charter and lifecycle state for an owner who can view the Project.
 *
 * The rule matches the Web charter panel: a Workspace administrator or viewer access to the Project reads the charter, and
 * Workspace guests cannot read it.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The charter with people referenced by member ID.
 */
async function readCredentialProjectCharter(
  credential: AuthenticatedDeveloperCredential,
  teamId: string,
  projectId: string,
): Promise<PublicProjectCharter> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'projects.read',
    teamId,
    projectId,
    evaluateProjectScopes: true,
  })
  requireWorkspaceBusinessRead(principal)
  await requireCredentialProjectCharterRead(principal, teamId, projectId)
  const state = await workspaceDependencies.projectDirectory.getProjectCharter(
    principal.directoryId,
    teamId,
    projectId,
  )
  const { charter } = state
  return {
    schemaVersion: 1,
    teamId,
    projectId,
    lifecycleState: state.lifecycleState,
    revision: state.revision,
    ...(state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt }),
    ...(charter.code === undefined ? {} : { code: charter.code }),
    ...(charter.description === undefined ? {} : { description: charter.description }),
    ...(charter.purpose === undefined ? {} : { purpose: charter.purpose }),
    ...(charter.owner === undefined ? {} : { owner: toPublicCharterPerson(charter.owner) }),
    ...(charter.sponsor === undefined ? {} : { sponsor: toPublicCharterPerson(charter.sponsor) }),
    ...(charter.plannedStartDate === undefined ? {} : { plannedStartDate: charter.plannedStartDate }),
    ...(charter.plannedEndDate === undefined ? {} : { plannedEndDate: charter.plannedEndDate }),
    tags: [...charter.tags],
    repositoryUrls: [...charter.repositoryUrls],
  }
}

/**
 * Applies the Web charter read rule: a Workspace administrator, or viewer access to the Project.
 *
 * @param principal - Principal resolved for the credential owner and this Project.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 */
async function requireCredentialProjectCharterRead(
  principal: Awaited<ReturnType<typeof resolveDeveloperCredentialPrincipal>>,
  teamId: string,
  projectId: string,
): Promise<void> {
  try {
    requireWorkspaceAdministration(principal)
    return
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error
  }
  await requireProjectPermission(principal, projectId, 'viewer', teamId)
}

/**
 * Converts a stored charter person to the Public API shape, which names members by member ID.
 *
 * @param person - Charter person with its display snapshot.
 * @returns The member ID and display name.
 */
function toPublicCharterPerson(person: ProjectCharterPerson): PublicProjectCharterPerson {
  return { memberId: person.userId, displayName: person.displayName }
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
 * @returns Directory service for `/api/v1/me`, `/api/v1/teams`, Project members, the Project log, the Project charter, and key lookup.
 */
export function createCanonicalPublicDirectoryService(): PublicDirectoryService {
  return {
    getCredentialOwner: readCredentialOwner,
    listTeams: listCredentialTeams,
    listProjectMembers: listCredentialProjectMembers,
    listProjectRaidLog: listCredentialProjectRaidLog,
    getProjectCharter: readCredentialProjectCharter,
    lookupWorkItemKey: lookupCredentialWorkItemKey,
  }
}
