/** Sidebar colors a Project can use. */
export const DIRECTORY_PROJECT_TONES = ['blue', 'purple', 'green', 'yellow'] as const

/** Sidebar color of a Project. */
export type DirectoryProjectTone = typeof DIRECTORY_PROJECT_TONES[number]

/** Largest number of Teams, or Projects in one Team, that one reorder request may name. */
export const DIRECTORY_REORDER_MAX_ITEMS = 90

/** Project row shown to Workspace administrators, including an archived Project. */
export type DirectoryAdministrationProject = {
  /** Stable Project identifier. It never changes when the Project is renamed. */
  id: string
  /** Japanese display name. */
  nameJa: string
  /** English display name. */
  nameEn: string
  /** Sidebar color. */
  tone: DirectoryProjectTone
  /** ISO 8601 time the Project was archived, when it is archived. */
  archivedAt?: string
}

/** Team row shown to Workspace administrators, including an archived Team. */
export type DirectoryAdministrationTeam = {
  /** Stable Team identifier. It never changes when the Team is renamed. */
  id: string
  /** Japanese display name. */
  nameJa: string
  /** English display name. */
  nameEn: string
  /** ISO 8601 time the Team was archived, when it is archived. */
  archivedAt?: string
  /** Projects of the Team in display order, archived ones included. */
  projects: DirectoryAdministrationProject[]
}

/** Every Team and Project of a Workspace in display order, for directory administration. */
export type DirectoryAdministrationResponse = {
  /** Teams in display order, archived ones included. */
  teams: DirectoryAdministrationTeam[]
}

/** Request body that renames a Team. */
export type RenameDirectoryTeamInput = {
  /** Japanese display name. */
  nameJa: string
  /** English display name. An empty value reuses the Japanese name. */
  nameEn?: string
}

/** Request body that renames a Project or changes its color. */
export type RenameDirectoryProjectInput = {
  /** Japanese display name. */
  nameJa: string
  /** English display name. An empty value reuses the Japanese name. */
  nameEn?: string
  /** Sidebar color. The current color is kept when omitted. */
  tone?: DirectoryProjectTone
}

/** Request body that sets the display order of every active Team. */
export type ReorderDirectoryTeamsInput = {
  /** Every active Team identifier, in the new display order. */
  teamIds: string[]
}

/** Request body that sets the display order of every active Project of one Team. */
export type ReorderDirectoryProjectsInput = {
  /** Every active Project identifier of the Team, in the new display order. */
  projectIds: string[]
}

/** Response of a Team rename. */
export type RenameDirectoryTeamResponse = {
  /** Renamed Team identifier, unchanged by the rename. */
  teamId: string
  /** Stored Japanese display name. */
  nameJa: string
  /** Stored English display name. */
  nameEn: string
}

/** Response of a Project rename. */
export type RenameDirectoryProjectResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Renamed Project identifier, unchanged by the rename. */
  projectId: string
  /** Stored Japanese display name. */
  nameJa: string
  /** Stored English display name. */
  nameEn: string
  /** Stored sidebar color. */
  tone: DirectoryProjectTone
}

/** Response of a Team restore. */
export type RestoreDirectoryTeamResponse = {
  /** Restored Team identifier. */
  teamId: string
}

/** Response of a Project restore. */
export type RestoreDirectoryProjectResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Restored Project identifier. */
  projectId: string
}

/**
 * Returns whether a value is a Project sidebar color.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is one of the known colors.
 */
export function isDirectoryProjectTone(value: unknown): value is DirectoryProjectTone {
  return DIRECTORY_PROJECT_TONES.some((tone) => tone === value)
}

/**
 * Returns whether a value is a directory administration response.
 *
 * @param value - Untrusted response body.
 * @returns Whether every Team and Project row has the expected shape.
 */
export function isDirectoryAdministrationResponse(
  value: unknown,
): value is DirectoryAdministrationResponse {
  return isObject(value) &&
    Array.isArray(value.teams) &&
    value.teams.every(isDirectoryAdministrationTeam)
}

/**
 * Returns whether a value is one administered Team row.
 *
 * @param value - Untrusted Team row.
 * @returns Whether the row and its Projects have the expected shape.
 */
function isDirectoryAdministrationTeam(value: unknown): value is DirectoryAdministrationTeam {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.nameJa === 'string' &&
    typeof value.nameEn === 'string' &&
    (value.archivedAt === undefined || typeof value.archivedAt === 'string') &&
    Array.isArray(value.projects) &&
    value.projects.every(isDirectoryAdministrationProject)
}

/**
 * Returns whether a value is one administered Project row.
 *
 * @param value - Untrusted Project row.
 * @returns Whether the row has the expected shape.
 */
function isDirectoryAdministrationProject(value: unknown): value is DirectoryAdministrationProject {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.nameJa === 'string' &&
    typeof value.nameEn === 'string' &&
    isDirectoryProjectTone(value.tone) &&
    (value.archivedAt === undefined || typeof value.archivedAt === 'string')
}

/**
 * Returns whether a value is a non-array object.
 *
 * @param value - Untrusted value.
 * @returns Whether properties can be read from the value.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
