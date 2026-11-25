import type {
  AutomationAction,
  AutomationCreateAction,
  AutomationManagementScopes,
  AutomationValue,
  EnterprisePermissionId,
} from '@mukuroji/contracts'
import { AutomationError } from '../../modules/automation'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { automationDependencies, workspaceDependencies } from './app-dependencies'
import {
  hasEnterpriseWorkspacePermission,
  listPermittedTeams,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from './project-access'
import { projectAccessAllows, type TeamPermissionContext } from './workspace-access'

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

/** Options of {@link requireDelegatedManagement}. */
export type DelegatedManagementOptions = {
  /**
   * Whether the call changes a stored definition. Administrators then skip the active-Team check,
   * so they can stop definitions of an archived Team.
   */
  existingDefinition?: boolean
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
 * @param options - Whether the call changes a stored definition rather than creating one.
 * @throws WorkspaceAccessError or ProjectDataError when the principal cannot manage the scope.
 * @throws AutomationError when the owner Team does not exist.
 */
export async function requireDelegatedManagement(
  principal: WorkspacePrincipal,
  ownerTeamId: string | undefined,
  options: DelegatedManagementOptions = {},
): Promise<void> {
  if (ownerTeamId === undefined) {
    requireWorkspaceAdministration(principal)
    return
  }
  if (canAdministerWorkspace(principal)) {
    // An administrator can still stop or fix a definition after its Team was archived.
    if (!options.existingDefinition) await requireAutomationOwnerTeam(principal.directoryId, ownerTeamId)
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
  if (!managesEveryTeamProject(context)) {
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
 * An Enterprise role holder reaches a read route with a read grant, which already counts as
 * Workspace administration for that request. Pass `managePermission` to report the scopes the
 * principal can change instead: then an Enterprise role holder manages every scope only with
 * that Workspace grant, and none without it.
 *
 * @param principal - Authenticated Workspace principal.
 * @param managePermission - Enterprise permission that mutations of the definitions require.
 * @returns Whether Workspace definitions are manageable and which Teams' definitions are.
 */
export async function listDelegatedManagementScopes(
  principal: WorkspacePrincipal,
  managePermission?: EnterprisePermissionId,
): Promise<AutomationManagementScopes> {
  if (
    managePermission !== undefined && principal.enterprisePermissions !== undefined
      ? hasEnterpriseWorkspacePermission(principal, managePermission)
      : canAdministerWorkspace(principal)
  ) {
    return { workspace: true, teamIds: await listWorkspaceTeamIds(principal.directoryId) }
  }
  if (principal.enterprisePermissions !== undefined) return { workspace: false, teamIds: [] }
  try {
    requireWorkspaceBusinessWrite(principal)
  } catch (error) {
    if (isAccessDenied(error)) return { workspace: false, teamIds: [] }
    throw error
  }
  // One directory read and one access-list read cover every Team (listPermittedTeams).
  const managedTeams = await listPermittedTeams(principal, 'manager')
  return {
    workspace: false,
    teamIds: managedTeams.filter(managesEveryTeamProject).map((context) => context.team.id),
  }
}

/**
 * Rejects a principal that manages no definitions at all before a route reads the definition it
 * names, so members who manage nothing get the usual administration error and learn nothing
 * about which definitions exist.
 *
 * @param principal - Authenticated Workspace principal.
 * @param managePermission - Enterprise permission that mutations of the definitions require.
 * @throws WorkspaceAccessError when the principal manages neither the Workspace nor any Team.
 */
export async function requireSomeDelegatedManagement(
  principal: WorkspacePrincipal,
  managePermission: EnterprisePermissionId,
): Promise<void> {
  const scopes = await listDelegatedManagementScopes(principal, managePermission)
  if (!scopes.workspace && scopes.teamIds.length === 0) requireWorkspaceAdministration(principal)
}

/**
 * Rejects Team rule actions that name a Project outside the owner Team.
 *
 * @param workspaceId - Workspace that owns the rule.
 * @param ownerTeamId - Team that owns the rule.
 * @param actions - Validated rule actions.
 * @throws AutomationError when a move, create or update action names another Team's Project.
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
        ? await readCreateActionProjectId(workspaceId, action)
        : action.type === 'update'
          ? action.patch.assignedProjectId
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
 * Resolves the Project a create action assigns, letting the action's values override the
 * template, as the executor does when it merges them.
 *
 * @param workspaceId - Workspace that owns the template.
 * @param action - Create action of a rule.
 * @returns The effective assigned Project value, or undefined when neither side sets one.
 */
async function readCreateActionProjectId(
  workspaceId: string,
  action: AutomationCreateAction,
): Promise<AutomationValue | undefined> {
  if (action.values !== undefined && 'assignedProjectId' in action.values) {
    return action.values.assignedProjectId
  }
  if (!action.templateId) return undefined
  const template = action.templateVersion !== undefined
    ? await automationDependencies.ruleTemplates.getTemplateVersion(
      workspaceId,
      action.templateId,
      action.templateVersion,
    )
    : await automationDependencies.ruleTemplates.getTemplate(workspaceId, action.templateId)
  return template?.kind === 'work-item' ? template.payload.assignedProjectId : undefined
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
 * Lists every Team of the Workspace, all of which a Workspace administrator manages.
 *
 * @param workspaceId - Workspace whose Teams are listed.
 * @returns Team identifiers in directory order.
 */
async function listWorkspaceTeamIds(workspaceId: string): Promise<string[]> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
  return directory.teams.map((team) => team.id)
}

/**
 * Tests whether a Team permission context manages every Project of the Team, because a Team
 * definition acts on all of the Team's Work Items (ADR 0087).
 *
 * @param context - Team permission context of the principal.
 * @returns Whether every Project of the Team is managed.
 */
function managesEveryTeamProject(context: TeamPermissionContext): boolean {
  const managedProjectIds = new Set(
    context.projectAccesses
      ?.filter((access) => projectAccessAllows(access, 'manager'))
      .map((access) => access.projectId) ?? [],
  )
  return context.team.projects.every((project) => managedProjectIds.has(project.id))
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
