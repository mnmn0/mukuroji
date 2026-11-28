import { ProjectDataError } from '../../modules/directory'
import { principalManagesTeamWorkItem, requireTeamPermission, type WorkspacePrincipal } from './project-access'
import { managesEveryTeamProject } from './team-delegated-management'
import type { TeamPermissionContext } from './workspace-access'

/** The Agent Runs of one Team whose estimated cost a viewer may see (ADR 0111). */
export type AgentRunCostAccess = {
  /**
   * Whether the viewer may see the estimated cost of a run.
   *
   * @param run - Run, by the member whose agent ran it.
   * @param projectId - Project the run's Work Item is in now, if any.
   * @returns Whether the cost is visible.
   */
  allows: (run: { assigneeUserId: string }, projectId: string | undefined) => boolean
  /**
   * Sorted keys of the scope the decision covers, for a stored snapshot to notice when it changes:
   * `team:<teamId>`, `project:<teamId>\0<projectId>`, and `member:<teamId>\0<userKey>`.
   */
  scopeKeys: readonly string[]
}

/**
 * Reports whether the principal administers the Workspace, so every Project's cost is theirs to see.
 * An enterprise role is not read here: one that manages a Team is read through the Team context.
 *
 * @param principal - Viewer.
 * @returns Whether the principal is a system administrator or a Workspace owner or admin.
 */
function administersWorkspace(principal: WorkspacePrincipal): boolean {
  return principal.isSystemAdmin ||
    principal.enterprisePermissions === undefined && (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin')
}

/**
 * Reads the Team context at a role, or undefined when the viewer does not hold it.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param role - Role to read.
 * @returns The context, or undefined for a 403.
 */
async function readTeamContext(
  principal: WorkspacePrincipal,
  teamId: string,
  role: 'viewer' | 'manager',
): Promise<TeamPermissionContext | undefined> {
  try {
    return await requireTeamPermission(principal, teamId, role)
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return undefined
    throw error
  }
}

/**
 * Reads whose Agent Run cost the viewer may see in a Team (ADR 0111): a Workspace administrator and
 * a manager of every Project of the Team see every run, a Project manager sees the runs on the
 * Project's Work Items, and every member sees the runs of their own agent.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns The decision for the Team's runs.
 */
export async function readAgentRunCostAccess(principal: WorkspacePrincipal, teamId: string): Promise<AgentRunCostAccess> {
  const own = `member:${teamId}\0${principal.userKey}`
  if (administersWorkspace(principal)) return { allows: () => true, scopeKeys: [`team:${teamId}`] }
  const manager = await readTeamContext(principal, teamId, 'manager')
  if (manager && managesEveryTeamProject(manager)) return { allows: () => true, scopeKeys: [`team:${teamId}`] }
  // A direct Team grant read at viewer level reports every Project role as viewer, so the Projects
  // are judged from the manager-level context when there is one.
  const context = manager ?? await readTeamContext(principal, teamId, 'viewer')
  const managedProjectIds = new Set(context === undefined
    ? []
    : context.team.projects.filter((project) => principalManagesTeamWorkItem(principal, context, project.id)).map((project) => project.id))
  // An enterprise `teams.manage` grant manages every Project without a Project manager role.
  if (manager && manager.team.projects.every((project) => managedProjectIds.has(project.id))) {
    return { allows: () => true, scopeKeys: [`team:${teamId}`] }
  }
  return {
    allows: (run, projectId) =>
      run.assigneeUserId === principal.userKey || projectId !== undefined && managedProjectIds.has(projectId),
    scopeKeys: [...[...managedProjectIds].map((projectId) => `project:${teamId}\0${projectId}`), own].sort(),
  }
}
