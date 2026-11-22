import type { ProjectDirectoryTeam } from '../../projects/api'
import {
  createProjectSearchPath,
  createProjectIssuesPath,
} from '../../shared/routing/paths'
import { updateTaskViewUrlState } from '../../task-views/model/taskViewUrlState'

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

/**
 * Creates the Project Issues route that opens the Work Item Gantt chart for one Project.
 *
 * The Gantt layout is carried as a temporary task-view override, so the viewer's saved
 * views and the Project's default view stay unchanged.
 *
 * @param projectId - Team-local Project identifier.
 * @param teamId - Team that owns the Project.
 * @returns Same-origin Project Issues path that shows the Gantt layout.
 */
export function createPlanningProjectGanttPath(projectId: string, teamId: string): string {
  const issuesPath = createProjectIssuesPath(projectId, teamId)
  const [pathname = issuesPath, query = ''] = issuesPath.split('?')
  const searchParams = updateTaskViewUrlState(
    new URLSearchParams(query),
    { surface: 'project', scope: { kind: 'project', projectId, teamId } },
    { override: { layout: { mode: 'gantt' } } },
  )
  return `${pathname}?${searchParams.toString()}`
}
