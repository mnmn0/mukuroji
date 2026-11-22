import type {
  AddDirectoryTeamMemberResponse,
  DirectoryAdministrationResponse,
  DirectoryTeamMemberRole,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../project-data-error'

/** Member being added, as resolved from the identity provider. */
export type TeamMemberGrantMember = {
  /** Member key. */
  id: string
  /** Email address stored on the Project member rows. */
  email: string
  /** Display name stored on the Project member rows. */
  name?: string
}

/** Caller whose authorization fences every grant. */
export type TeamMemberGrantCaller<TFence> = {
  /** Member key and authorized membership version, when the caller is a Workspace member. */
  membership?: { memberKey: string; version: number }
  /** Opaque condition checks proving the caller is still authorized when each grant commits. */
  fences: TFence[]
}

/** Ports used by {@link addMemberToTeamProjectsUseCase}. */
export type TeamMemberGrantPorts<TFence, TAudit> = {
  /** Reads every Team and Project, archived ones included. */
  getDirectoryAdministration(workspaceId: string): Promise<DirectoryAdministrationResponse>
  /** Grants a role on one Project only when the member has none there. */
  addProjectMemberIfAbsent(
    workspaceId: string,
    teamId: string,
    projectId: string,
    memberKey: string,
    input: { role: DirectoryTeamMemberRole; email: string; name?: string },
    expectedWorkspaceMemberVersion: number,
    auditContext: TAudit,
    authorizationFences: TFence[],
  ): Promise<{ added: boolean }>
  /** Reads the current version of an active Workspace member, refusing an inactive one. */
  readActiveMemberVersion(workspaceId: string, memberKey: string): Promise<number>
  /** Tells whether the caller may grant roles on a Project. */
  canManageProject(teamId: string, projectId: string): boolean
  /** Builds the audit context of the grant on one Project. */
  createAuditContext(projectId: string): TAudit
}

/** Input of {@link addMemberToTeamProjectsUseCase}. */
export type TeamMemberGrantInput<TFence> = {
  /** Workspace identifier. */
  workspaceId: string
  /** Team whose active Projects receive the member. */
  teamId: string
  /** Member to add. */
  member: TeamMemberGrantMember
  /** Role granted on each Project the member is not yet in. */
  role: DirectoryTeamMemberRole
  /** Caller authorization carried into each grant. */
  caller: TeamMemberGrantCaller<TFence>
}

/**
 * Adds one Workspace member to every active Project of an active Team.
 *
 * Every Project must be manageable by the caller before the first grant, so a refusal changes
 * nothing. Each grant is insert-only and fenced by the caller's authorization: a role that already
 * exists, even one granted concurrently, is kept and reported as existing, and a caller who loses
 * access stops the remaining grants. A retry after a partial failure adds only the rest.
 *
 * @param ports - Directory persistence, member lookup, permission, and audit ports.
 * @param input - Validated request and caller authorization.
 * @returns The Projects the member was added to and the ones they already belonged to.
 */
export async function addMemberToTeamProjectsUseCase<TFence, TAudit>(
  ports: TeamMemberGrantPorts<TFence, TAudit>,
  input: TeamMemberGrantInput<TFence>,
): Promise<AddDirectoryTeamMemberResponse> {
  const { workspaceId, teamId, member, role, caller } = input
  const directory = await ports.getDirectoryAdministration(workspaceId)
  const team = directory.teams.find((candidate) =>
    candidate.id === teamId && candidate.archivedAt === undefined
  )
  if (!team) {
    throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
  }

  const activeProjects = team.projects.filter((project) => project.archivedAt === undefined)
  if (activeProjects.some((project) => !ports.canManageProject(teamId, project.id))) {
    throw new ProjectDataError(
      403,
      'TeamProjectsManageDenied',
      'Adding a member to every Project of a Team requires managing each of its Projects.',
    )
  }

  const response: AddDirectoryTeamMemberResponse = {
    teamId,
    memberKey: member.id,
    addedProjectIds: [],
    existingProjectIds: [],
  }
  // A caller adding themselves keeps the membership version they were authorized with, advanced
  // only by their own grants, so a change to their membership in between still fails.
  const addsSelf = caller.membership !== undefined &&
    isSameMemberKey(caller.membership.memberKey, member.id)
  for (const project of activeProjects) {
    // Each grant advances the member's version, so it is read again before every Project.
    const expectedVersion = addsSelf && caller.membership
      ? caller.membership.version + response.addedProjectIds.length
      : await ports.readActiveMemberVersion(workspaceId, member.id)
    const { added } = await ports.addProjectMemberIfAbsent(
      workspaceId,
      teamId,
      project.id,
      member.id,
      { role, email: member.email, ...(member.name === undefined ? {} : { name: member.name }) },
      expectedVersion,
      ports.createAuditContext(project.id),
      caller.fences,
    )
    ;(added ? response.addedProjectIds : response.existingProjectIds).push(project.id)
  }
  return response
}

/**
 * Compares member keys the way membership rows store them: trimmed and lowercase.
 *
 * @param left - One member key.
 * @param right - Another member key.
 * @returns Whether both keys name the same member.
 */
function isSameMemberKey(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}
