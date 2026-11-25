import { resolveOrgUnitPath, type OrgUnit } from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../projects/api'

/**
 * Enterprise Security panel scope derived from the Workspace directory.
 */
export type WorkspaceSecurityScopeOption = {
  /** Stable Workspace, OrgUnit, Team, or Project identifier. */
  id: string
  /** User-facing scope name. */
  name: string
  /** Resource level represented by the option. */
  type: 'workspace' | 'org-unit' | 'team' | 'project'
  /** Teams that own a Project option; a shared Project lists every owning Team. */
  parentIds?: string[]
}

/**
 * Builds the Enterprise Security scope selector from the Workspace directory.
 *
 * @param teams - Workspace Team and Project directory.
 * @param workspaceLabel - Localized label for the root Workspace scope.
 * @param orgUnits - OrgUnits of the Workspace, each offered with its full path as its name.
 * @returns Workspace, OrgUnit, Team, and deduplicated Project scope options.
 */
export function createWorkspaceSecurityScopeOptions(
  teams: readonly ProjectDirectoryTeam[],
  workspaceLabel: string,
  orgUnits: readonly OrgUnit[] = [],
): WorkspaceSecurityScopeOption[] {
  const projects = new Map<
    string,
    { id: string; name: string; teamName: string; teamIds: string[] }
  >()

  for (const team of teams) {
    for (const project of team.projects) {
      const existing = projects.get(project.id)
      if (existing) {
        existing.teamIds.push(team.id)
      } else {
        projects.set(project.id, {
          id: project.id,
          name: project.name,
          teamName: team.name,
          teamIds: [team.id],
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
    ...orgUnits.map((orgUnit): WorkspaceSecurityScopeOption => ({
      id: orgUnit.id,
      name: resolveOrgUnitPath(orgUnits, orgUnit.id).map((unit) => unit.name).join(' / '),
      type: 'org-unit',
    })),
    ...teams.map((team): WorkspaceSecurityScopeOption => ({
      id: team.id,
      name: team.name,
      type: 'team',
    })),
    ...Array.from(projects.values(), (project): WorkspaceSecurityScopeOption => ({
      id: project.id,
      // A Project shared by several Teams is named alone; the form asks for its owning Team.
      name: project.teamIds.length > 1 ? project.name : `${project.name} · ${project.teamName}`,
      type: 'project',
      parentIds: project.teamIds,
    })),
  ]
}
