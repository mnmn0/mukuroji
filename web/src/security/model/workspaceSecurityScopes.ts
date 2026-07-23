import type { ProjectDirectoryTeam } from '../../projects/api'

/**
 * Enterprise Security panel scope derived from the Workspace directory.
 */
export type WorkspaceSecurityScopeOption = {
  /** Stable Workspace, Team, or Project identifier. */
  id: string
  /** User-facing scope name. */
  name: string
  /** Resource level represented by the option. */
  type: 'workspace' | 'team' | 'project'
}

/**
 * Builds the Enterprise Security scope selector from the Workspace directory.
 *
 * @param teams - Workspace Team and Project directory.
 * @param workspaceLabel - Localized label for the root Workspace scope.
 * @returns Workspace, Team, and deduplicated Project scope options.
 */
export function createWorkspaceSecurityScopeOptions(
  teams: readonly ProjectDirectoryTeam[],
  workspaceLabel: string,
): WorkspaceSecurityScopeOption[] {
  const projects = new Map<
    string,
    { id: string; name: string; teamName: string }
  >()

  for (const team of teams) {
    for (const project of team.projects) {
      if (!projects.has(project.id)) {
        projects.set(project.id, {
          id: project.id,
          name: project.name,
          teamName: team.name,
        })
      }
    }
  }

  return [
    {
      id: 'workspace',
      name: workspaceLabel,
      type: 'workspace',
    },
    ...teams.map((team): WorkspaceSecurityScopeOption => ({
      id: team.id,
      name: team.name,
      type: 'team',
    })),
    ...Array.from(projects.values(), (project): WorkspaceSecurityScopeOption => ({
      id: project.id,
      name: `${project.name} · ${project.teamName}`,
      type: 'project',
    })),
  ]
}
