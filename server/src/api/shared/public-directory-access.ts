import {
  deriveProjectRaidSeverity,
  type PublicCredentialOwner,
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
import { requireWorkspaceBusinessRead } from './project-access'
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
    items: log.entries.map((entry) => ({ ...entry, severity: deriveProjectRaidSeverity(entry) })),
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
 * @returns Directory service for `/api/v1/me`, `/api/v1/teams`, Project members, the Project log, and key lookup.
 */
export function createCanonicalPublicDirectoryService(): PublicDirectoryService {
  return {
    getCredentialOwner: readCredentialOwner,
    listTeams: listCredentialTeams,
    listProjectMembers: listCredentialProjectMembers,
    listProjectRaidLog: listCredentialProjectRaidLog,
    lookupWorkItemKey: lookupCredentialWorkItemKey,
  }
}
