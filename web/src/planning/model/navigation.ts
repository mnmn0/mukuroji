import type { ProjectDirectoryTeam } from '../../projects/api'
import {
  createProjectSearchPath,
  createProjectIssuesPath,
} from '../../shared/routing/paths'

/**
 * Resolves a Planning Project reference to a Team-scoped Issue route only when ownership is unique.
 *
 * @param teams - Visible Workspace Team and Project directory.
 * @param projectId - Project identifier selected from Planning.
 * @returns A Team-scoped Issue path for one owner, or permission-aware Project search otherwise.
 */
export function resolvePlanningProjectNavigationPath(
  teams: readonly ProjectDirectoryTeam[],
  projectId: string,
) {
  const owningTeams = teams.filter((team) =>
    team.projects.some((project) => project.id === projectId)
  )
  const owningTeam = owningTeams.length === 1 ? owningTeams[0] : undefined

  return owningTeam
    ? createProjectIssuesPath(projectId, owningTeam.id)
    : createProjectSearchPath(projectId)
}
