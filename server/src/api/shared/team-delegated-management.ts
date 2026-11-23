import type {
  AutomationAction,
  AutomationManagementScopes,
} from '@mukuroji/contracts'
import { AutomationError } from '../../modules/automation'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { workspaceDependencies } from './app-dependencies'
import {
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from './project-access'
import { projectAccessAllows } from './workspace-access'

/**
 * Returns whether the principal administers the whole Workspace's definitions.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns Whether Workspace administration is granted.
 */
export function canAdministerWorkspace(principal: WorkspacePrincipal): boolean {
  try {
    requireWorkspaceAdministration(principal)
    return true
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return false
    throw error
  }
}

/**
 * Requires the principal to manage definitions (Automation rules, templates, recurring Work,
 * Request forms) owned by the given scope.
 *
 * A definition without an owner Team is managed by Workspace administrators only. A Team-owned
 * definition is also managed by a Team manager: a member who can write Workspace business data
 * and manages every active Project of the Team, because the definition acts on all of the
 * Team's Work Items. Enterprise role holders keep the Workspace `automation.manage` or
 * `requests.manage` grant that the route already requires (ADR 0087).
 *
 * @param principal - Authenticated Workspace principal.
 * @param ownerTeamId - Team that owns the definition, or undefined for a Workspace definition.
 * @throws WorkspaceAccessError or ProjectDataError when the principal cannot manage the scope.
 * @throws AutomationError when the owner Team does not exist.
 */
export async function requireDelegatedManagement(
  principal: WorkspacePrincipal,
  ownerTeamId: string | undefined,
): Promise<void> {
  if (ownerTeamId === undefined) {
    requireWorkspaceAdministration(principal)
    return
  }
  if (canAdministerWorkspace(principal)) {
    await requireAutomationOwnerTeam(principal.directoryId, ownerTeamId)
    return
  }
  if (principal.enterprisePermissions !== undefined) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'An Enterprise management permission for the Workspace is required for this operation.',
    )
  }
  requireWorkspaceBusinessWrite(principal)
  const context = await requireTeamPermission(principal, ownerTeamId, 'manager')
  const managedProjectIds = new Set(
    context.projectAccesses
      ?.filter((access) => projectAccessAllows(access, 'manager'))
      .map((access) => access.projectId) ?? [],
  )
  if (!context.team.projects.every((project) => managedProjectIds.has(project.id))) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Managing a Team definition requires managing every Project of the Team.',
    )
  }
}

/**
 * Lists the definition scopes the principal can manage.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns Whether Workspace definitions are manageable and which Teams' definitions are.
 */
export async function listDelegatedManagementScopes(
  principal: WorkspacePrincipal,
): Promise<AutomationManagementScopes> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
  )
  if (canAdministerWorkspace(principal)) {
    return { workspace: true, teamIds: directory.teams.map((team) => team.id) }
  }
  const teamIds: string[] = []
  for (const team of directory.teams) {
    try {
      await requireDelegatedManagement(principal, team.id)
      teamIds.push(team.id)
    } catch (error) {
      if (error instanceof AutomationError) throw error
      if (!isAccessDenied(error)) throw error
    }
  }
  return { workspace: false, teamIds }
}

/**
 * Rejects Team rule actions that name a Project outside the owner Team.
 *
 * @param workspaceId - Workspace that owns the rule.
 * @param ownerTeamId - Team that owns the rule.
 * @param actions - Validated rule actions.
 * @throws AutomationError when a move or create action names another Team's Project.
 */
export async function assertAutomationActionsUseOwnerTeamProjects(
  workspaceId: string,
  ownerTeamId: string,
  actions: readonly AutomationAction[],
): Promise<void> {
  const team = await requireAutomationOwnerTeam(workspaceId, ownerTeamId)
  const projectIds = new Set(team.projects.map((project) => project.id))
  for (const action of actions) {
    const projectId = action.type === 'move'
      ? action.targetProjectId
      : action.type === 'create'
        ? action.values?.assignedProjectId
        : undefined
    if (typeof projectId === 'string' && projectId !== '' && !projectIds.has(projectId)) {
      throw new AutomationError(
        'forbidden',
        'AutomationTeamScopeViolation',
        'A Team rule can only use Projects of its own Team.',
      )
    }
  }
}

/**
 * Reads the active owner Team of a Team definition.
 *
 * @param workspaceId - Workspace that owns the definition.
 * @param ownerTeamId - Owner Team identifier.
 * @returns The Team directory entry.
 * @throws AutomationError when the Team is not active in the Workspace.
 */
async function requireAutomationOwnerTeam(workspaceId: string, ownerTeamId: string) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    workspaceId,
    'ja',
    true,
  )
  const team = directory.teams.find((candidate) => candidate.id === ownerTeamId)
  if (!team) {
    throw new AutomationError(
      'conflict',
      'AutomationTeamUnavailable',
      'The owner Team of the definition is unavailable.',
    )
  }
  return team
}

/**
 * Tests whether an error is a 403 or 404 access decision rather than an outage.
 *
 * @param error - Caught error.
 * @returns Whether the error only denies access.
 */
function isAccessDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const status: unknown = Reflect.get(error, 'status')
  return status === 403 || status === 404
}
