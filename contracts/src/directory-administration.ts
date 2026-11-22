/** Sidebar colors a Project can use. */
export const DIRECTORY_PROJECT_TONES = ['blue', 'purple', 'green', 'yellow'] as const

/** Sidebar color of a Project. */
export type DirectoryProjectTone = typeof DIRECTORY_PROJECT_TONES[number]

/** Largest number of Teams, or Projects in one Team, that one reorder request may name. */
export const DIRECTORY_REORDER_MAX_ITEMS = 90

/** Longest Japanese or English Team or Project name that creating or renaming stores. */
export const DIRECTORY_DISPLAY_NAME_MAX_LENGTH = 500

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

/** One counted archive impact. Counting stops early on large Teams, so a count can be a floor. */
export type DirectoryArchiveImpactCount = {
  /** Number of matching records counted. */
  count: number
  /** Whether counting stopped before reading every record, so the real number may be larger. */
  hasMore: boolean
}

/** What archiving a Team or Project affects, shown before the archive is confirmed. */
export type DirectoryArchiveImpactResponse = {
  /** Work Items that are neither completed nor canceled, archived Work Items excluded. */
  openWorkItems: DirectoryArchiveImpactCount
  /** Agent Runs that are still active on the Team's or Project's Work Items. */
  activeAgentRuns: DirectoryArchiveImpactCount
  /** Active Planning entities scoped to the Team or Project. Any of them blocks the archive. */
  planningEntities: number
  /** Planning links to the Team's or Project's Work Items. Any of them blocks the archive. */
  planningWorkItemLinks: number
  /**
   * Planning dependencies that block the archive: for a Team, every dependency on its Work
   * Items; for a Project, every dependency on a Work Item assigned to the Project.
   */
  planningDependencies: number
  /** Active Webhook subscriptions that deliver events for the Team. */
  webhookSubscriptions: number
  /**
   * Whether the archive is refused until the Planning references are removed. A Project archive
   * is also refused when its Team has more dependency endpoints than one archive can guard.
   */
  archiveBlocked: boolean
}

/** Team or Project whose archive impact is read. */
export type DirectoryArchiveImpactTarget =
  | {
      /** A Team and every Project in it. */
      kind: 'team'
      /** Team identifier. */
      teamId: string
    }
  | {
      /** One Project of a Team. */
      kind: 'project'
      /** Team that owns the Project. */
      teamId: string
      /** Project identifier. */
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
 * Returns whether a value is an archive impact response.
 *
 * @param value - Untrusted response body.
 * @returns Whether every count has the expected shape.
 */
export function isDirectoryArchiveImpactResponse(
  value: unknown,
): value is DirectoryArchiveImpactResponse {
  return isObject(value) &&
    isDirectoryArchiveImpactCount(value.openWorkItems) &&
    isDirectoryArchiveImpactCount(value.activeAgentRuns) &&
    isCount(value.planningEntities) &&
    isCount(value.planningWorkItemLinks) &&
    isCount(value.planningDependencies) &&
    isCount(value.webhookSubscriptions) &&
    typeof value.archiveBlocked === 'boolean'
}

/**
 * Returns whether a value is one counted archive impact.
 *
 * @param value - Untrusted value.
 * @returns Whether the value has a count and a completeness flag.
 */
function isDirectoryArchiveImpactCount(value: unknown): value is DirectoryArchiveImpactCount {
  return isObject(value) && isCount(value.count) && typeof value.hasMore === 'boolean'
}

/**
 * Returns whether a value is a non-negative integer count.
 *
 * @param value - Untrusted value.
 * @returns Whether the value can be shown as a count.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
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
