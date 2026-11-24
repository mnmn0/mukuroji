import type { OrgStructure, OrgUnit, OrgUnitTeamAssignment } from '@mukuroji/contracts'

/** Row discriminator of the OrgUnit structure row. */
export const ORG_STRUCTURE_ENTRY_TYPE = 'org-structure'

/** Sort key of the single OrgUnit structure row of a Workspace. */
export const ORG_STRUCTURE_ENTRY_KEY = 'STRUCTURE'

/**
 * Row that stores the whole OrgUnit tree and Team memberships of one Workspace (ADR 0097).
 *
 * It lives in its own sidecar partition, so the Workspace directory partition that many readers
 * parse strictly never sees it.
 */
export type OrgStructureItem = {
  /** Sidecar partition `ORG_STRUCTURE#<encoded Workspace ID>`. */
  directoryId: string
  /** Always {@link ORG_STRUCTURE_ENTRY_KEY}. */
  entryKey: string
  /** Row discriminator. */
  entryType: typeof ORG_STRUCTURE_ENTRY_TYPE
  /** Workspace that owns the structure, kept for tenant deletion and integrity checks. */
  workspaceId: string
  /** OrgUnits, parents listed before their children. */
  orgUnits: OrgUnit[]
  /** Team memberships. */
  teamAssignments: OrgUnitTeamAssignment[]
  /** Compare-and-swap revision, 1 after the first save. */
  revision: number
  /** ISO 8601 time of the last save. */
  updatedAt: string
}

/**
 * Creates the sidecar partition key of a Workspace's OrgUnit structure.
 *
 * @param workspaceId - Workspace directory identifier.
 * @returns A partition key that cannot overlap the canonical directory partition.
 */
export function createOrgStructureDirectoryId(workspaceId: string) {
  return `ORG_STRUCTURE#${encodeURIComponent(workspaceId)}`
}

/**
 * Creates the primary key of a Workspace's OrgUnit structure row.
 *
 * @param workspaceId - Workspace directory identifier.
 * @returns The partition and sort key.
 */
export function createOrgStructureKey(workspaceId: string) {
  return {
    directoryId: createOrgStructureDirectoryId(workspaceId),
    entryKey: ORG_STRUCTURE_ENTRY_KEY,
  }
}

/**
 * Builds the row that stores a committed structure.
 *
 * @param workspaceId - Workspace directory identifier.
 * @param structure - Structure to store; its revision must be at least 1.
 * @returns The row.
 */
export function createOrgStructureItem(
  workspaceId: string,
  structure: OrgStructure,
): OrgStructureItem {
  return {
    ...createOrgStructureKey(workspaceId),
    entryType: ORG_STRUCTURE_ENTRY_TYPE,
    workspaceId,
    orgUnits: structure.orgUnits,
    teamAssignments: structure.teamAssignments,
    revision: structure.revision,
    updatedAt: structure.updatedAt ?? new Date().toISOString(),
  }
}

/**
 * Tells whether a stored row is the OrgUnit structure row of a Workspace. The structure fields
 * themselves are validated separately.
 *
 * @param value - Stored row.
 * @param workspaceId - Expected Workspace.
 * @returns Whether the row's identity matches.
 */
export function isOrgStructureItem(
  value: unknown,
  workspaceId: string,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row: Record<string, unknown> = { ...value }
  return row.directoryId === createOrgStructureDirectoryId(workspaceId) &&
    row.entryKey === ORG_STRUCTURE_ENTRY_KEY &&
    row.entryType === ORG_STRUCTURE_ENTRY_TYPE &&
    row.workspaceId === workspaceId
}
