import type { WorkItemKeyLookupResponse } from '@mukuroji/contracts'
import { ProjectDataError, type ProjectDirectoryResponse } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { workItemDependencies } from './app-dependencies'
import {
  getEffectiveProjectScopeAccessList,
  requireAssignedProjectPermission,
  requireTeamPermission,
  selectTeamProjectScopeAccesses,
  type WorkspacePrincipal,
} from './project-access'
import { projectAccessAllows } from './workspace-access'

/**
 * Narrows the Project directory to what a principal may see: every Project they can view, and
 * the Teams that hold one or that Enterprise RBAC grants directly. A system administrator sees
 * the whole directory. Access is matched by Team and Project together, so a grant on one Team's
 * Project never reveals another Team's Project with the same ID; a legacy grant that cannot be
 * tied to one Team opens none of them.
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
  const accesses = (await getEffectiveProjectScopeAccessList(principal))
    .filter((access) => projectAccessAllows(access, 'viewer'))
  const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  return {
    ...directory,
    teams: directory.teams
      .map((team) => {
        const readableProjectIds = new Set(selectTeamProjectScopeAccesses(accesses, team).map((access) => access.projectId))
        return { ...team, projects: team.projects.filter((project) => readableProjectIds.has(project.id)) }
      })
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
