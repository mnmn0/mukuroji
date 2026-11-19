import type {
  DirectoryAdministrationProject,
  DirectoryAdministrationTeam,
} from '@mukuroji/contracts'

/** Direction a Team or Project moves by one place. */
export type DirectoryMoveDirection = 'up' | 'down'

/** Archived Team or Project an administrator can restore. */
export type ArchivedDirectoryEntry =
  | {
    /** Entry kind. */
    kind: 'team'
    /** Archived Team. */
    team: DirectoryAdministrationTeam
  }
  | {
    /** Entry kind. */
    kind: 'project'
    /** Team that owns the Project. */
    team: DirectoryAdministrationTeam
    /** Archived Project. */
    project: DirectoryAdministrationProject
  }

/**
 * Returns the active Teams with only their active Projects, keeping display order.
 *
 * @param teams - Every Team in display order.
 * @returns Active Teams and Projects.
 */
export function listActiveDirectoryTeams(
  teams: readonly DirectoryAdministrationTeam[],
): DirectoryAdministrationTeam[] {
  return teams
    .filter((team) => team.archivedAt === undefined)
    .map((team) => ({
      ...team,
      projects: team.projects.filter((project) => project.archivedAt === undefined),
    }))
}

/**
 * Lists archived Teams, and archived Projects of active Teams, that can be restored now.
 *
 * Archived Projects of an archived Team come back with the Team, so they are not listed.
 *
 * @param teams - Every Team in display order.
 * @returns Restorable entries in display order.
 */
export function listArchivedDirectoryEntries(
  teams: readonly DirectoryAdministrationTeam[],
): ArchivedDirectoryEntry[] {
  return teams.flatMap((team): ArchivedDirectoryEntry[] => {
    if (team.archivedAt !== undefined) return [{ kind: 'team', team }]
    return team.projects
      .filter((project) => project.archivedAt !== undefined)
      .map((project) => ({ kind: 'project', team, project }))
  })
}

/**
 * Moves one ID by one place.
 *
 * @param ids - IDs in the current order.
 * @param id - ID to move.
 * @param direction - Direction to move.
 * @returns The new order, or undefined when the ID is missing or already at that end.
 */
export function moveDirectoryId(
  ids: readonly string[],
  id: string,
  direction: DirectoryMoveDirection,
): string[] | undefined {
  const index = ids.indexOf(id)
  const target = direction === 'up' ? index - 1 : index + 1

  if (index < 0 || target < 0 || target >= ids.length) return undefined

  const next = [...ids]
  next.splice(index, 1)
  next.splice(target, 0, id)
  return next
}
