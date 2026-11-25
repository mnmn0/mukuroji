/** Largest number of OrgUnits one Workspace can define. */
export const ORG_UNIT_MAX_COUNT = 200

/** Deepest OrgUnit level, counting a top-level OrgUnit as level 1. */
export const ORG_UNIT_MAX_DEPTH = 6

/** Longest OrgUnit display name. */
export const ORG_UNIT_NAME_MAX_LENGTH = 200

/** Largest number of Team-to-OrgUnit assignments one Workspace can store. */
export const ORG_UNIT_TEAM_ASSIGNMENT_MAX_COUNT = 1000

/** Longest Team identifier an OrgUnit assignment accepts. */
const ORG_UNIT_TEAM_ID_MAX_LENGTH = 256

/** Pattern of an OrgUnit identifier. Clients create identifiers for new OrgUnits. */
const ORG_UNIT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u

/**
 * Department or business unit that groups Teams. OrgUnits form a tree, and each Team belongs to at
 * most one OrgUnit.
 */
export type OrgUnit = {
  /** Stable identifier. It never changes when the OrgUnit is renamed or moved. */
  id: string
  /** Display name. */
  name: string
  /** Parent OrgUnit, absent for a top-level OrgUnit. */
  parentId?: string
}

/** Membership of one Team in one OrgUnit. */
export type OrgUnitTeamAssignment = {
  /** Team that belongs to the OrgUnit. */
  teamId: string
  /** OrgUnit the Team belongs to. */
  orgUnitId: string
}

/** OrgUnit tree and Team memberships of one Workspace. */
export type OrgStructure = {
  /** Every OrgUnit, parents listed before their children. */
  orgUnits: OrgUnit[]
  /** Team memberships. A Team that is not listed belongs to no OrgUnit. */
  teamAssignments: OrgUnitTeamAssignment[]
  /** Compare-and-swap revision, 0 while the Workspace has never saved a structure. */
  revision: number
  /** ISO 8601 time of the last save, absent before the first save. */
  updatedAt?: string
}

/** Response body of `GET /api/org-structure` and `PUT /api/org-structure`. */
export type OrgStructureResponse = {
  /** Current OrgUnit tree and Team memberships. */
  orgStructure: OrgStructure
}

/** Request body of `PUT /api/org-structure`, which replaces the whole structure. */
export type ReplaceOrgStructureInput = {
  /** Revision the caller read. A different stored revision is a conflict. */
  expectedRevision: number
  /** Every OrgUnit of the new structure. */
  orgUnits: OrgUnit[]
  /** Every Team membership of the new structure. */
  teamAssignments: OrgUnitTeamAssignment[]
}

/** Reason an OrgUnit tree or its Team memberships are refused. */
export type OrgStructureIssue =
  | 'invalid-shape'
  | 'too-many-org-units'
  | 'invalid-org-unit-id'
  | 'duplicate-org-unit-id'
  | 'invalid-org-unit-name'
  | 'unknown-parent'
  | 'cycle'
  | 'too-deep'
  | 'too-many-team-assignments'
  | 'invalid-team-id'
  | 'duplicate-team'
  | 'unknown-org-unit'

/** Result of reading an untrusted OrgUnit tree and its Team memberships. */
export type OrgStructureDraftResult =
  | {
    /** The structure is valid. */
    ok: true
    /** OrgUnits ordered so that every parent comes before its children. */
    orgUnits: OrgUnit[]
    /** Team memberships in the order given. */
    teamAssignments: OrgUnitTeamAssignment[]
  }
  | {
    /** The structure is refused. */
    ok: false
    /** First reason found. */
    issue: OrgStructureIssue
  }

/**
 * Reads and validates an untrusted OrgUnit tree and its Team memberships.
 *
 * Names are trimmed. Identifiers must be unique, parents must exist, the tree must be acyclic and
 * at most {@link ORG_UNIT_MAX_DEPTH} levels deep, and each Team may belong to one OrgUnit only.
 *
 * @param orgUnitsValue - Untrusted OrgUnit list.
 * @param teamAssignmentsValue - Untrusted Team membership list.
 * @returns The normalized structure, or the first issue found.
 */
export function readOrgStructureDraft(
  orgUnitsValue: unknown,
  teamAssignmentsValue: unknown,
): OrgStructureDraftResult {
  if (!Array.isArray(orgUnitsValue) || !Array.isArray(teamAssignmentsValue)) {
    return { ok: false, issue: 'invalid-shape' }
  }
  if (orgUnitsValue.length > ORG_UNIT_MAX_COUNT) return { ok: false, issue: 'too-many-org-units' }
  if (teamAssignmentsValue.length > ORG_UNIT_TEAM_ASSIGNMENT_MAX_COUNT) {
    return { ok: false, issue: 'too-many-team-assignments' }
  }
  const byId = new Map<string, OrgUnit>()
  for (const value of orgUnitsValue) {
    if (!isPlainRecord(value)) return { ok: false, issue: 'invalid-shape' }
    const { id, name, parentId } = value
    if (typeof id !== 'string' || !ORG_UNIT_ID_PATTERN.test(id)) {
      return { ok: false, issue: 'invalid-org-unit-id' }
    }
    if (byId.has(id)) return { ok: false, issue: 'duplicate-org-unit-id' }
    const trimmedName = typeof name === 'string' ? name.trim() : ''
    if (
      !trimmedName ||
      trimmedName.length > ORG_UNIT_NAME_MAX_LENGTH ||
      /\p{Cc}/u.test(trimmedName)
    ) {
      return { ok: false, issue: 'invalid-org-unit-name' }
    }
    if (parentId !== undefined && (typeof parentId !== 'string' || !ORG_UNIT_ID_PATTERN.test(parentId))) {
      return { ok: false, issue: 'unknown-parent' }
    }
    byId.set(id, { id, name: trimmedName, ...(parentId === undefined ? {} : { parentId }) })
  }
  for (const orgUnit of byId.values()) {
    if (orgUnit.parentId !== undefined && !byId.has(orgUnit.parentId)) {
      return { ok: false, issue: 'unknown-parent' }
    }
  }
  const ordered: OrgUnit[] = []
  const depthById = new Map<string, number>()
  for (const orgUnit of byId.values()) {
    const depth = resolveDepth(orgUnit.id, byId, depthById)
    if (depth === 'cycle') return { ok: false, issue: 'cycle' }
    if (depth > ORG_UNIT_MAX_DEPTH) return { ok: false, issue: 'too-deep' }
  }
  const children = groupChildren([...byId.values()])
  const visit = (parentId: string | undefined) => {
    for (const child of children.get(parentId) ?? []) {
      ordered.push(child)
      visit(child.id)
    }
  }
  visit(undefined)

  const teamIds = new Set<string>()
  const teamAssignments: OrgUnitTeamAssignment[] = []
  for (const value of teamAssignmentsValue) {
    if (!isPlainRecord(value)) return { ok: false, issue: 'invalid-shape' }
    const { teamId, orgUnitId } = value
    if (
      typeof teamId !== 'string' ||
      !teamId.trim() ||
      teamId !== teamId.trim() ||
      teamId.length > ORG_UNIT_TEAM_ID_MAX_LENGTH ||
      /\p{Cc}/u.test(teamId)
    ) {
      return { ok: false, issue: 'invalid-team-id' }
    }
    if (teamIds.has(teamId)) return { ok: false, issue: 'duplicate-team' }
    if (typeof orgUnitId !== 'string' || !byId.has(orgUnitId)) {
      return { ok: false, issue: 'unknown-org-unit' }
    }
    teamIds.add(teamId)
    teamAssignments.push({ teamId, orgUnitId })
  }
  return { ok: true, orgUnits: ordered, teamAssignments }
}

/**
 * Validates an OrgStructure read from the API or from storage.
 *
 * @param value - Untrusted value.
 * @returns The structure, or undefined when it is malformed.
 */
export function parseOrgStructure(value: unknown): OrgStructure | undefined {
  if (!isPlainRecord(value)) return undefined
  const { revision, updatedAt } = value
  if (!Number.isSafeInteger(revision) || typeof revision !== 'number' || revision < 0) return undefined
  if (updatedAt !== undefined && (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)))) {
    return undefined
  }
  const draft = readOrgStructureDraft(value.orgUnits, value.teamAssignments)
  if (!draft.ok) return undefined
  return {
    orgUnits: draft.orgUnits,
    teamAssignments: draft.teamAssignments,
    revision,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/**
 * Lists an OrgUnit and every OrgUnit below it.
 *
 * @param orgUnits - Every OrgUnit of the Workspace.
 * @param rootId - OrgUnit whose subtree is listed.
 * @returns The root and its descendants, or an empty list when the root does not exist.
 */
export function listOrgUnitSubtreeIds(orgUnits: readonly OrgUnit[], rootId: string): string[] {
  if (!orgUnits.some((orgUnit) => orgUnit.id === rootId)) return []
  const children = groupChildren(orgUnits)
  const result: string[] = []
  const pending = [rootId]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    for (const child of children.get(id) ?? []) pending.push(child.id)
  }
  return result
}

/**
 * Lists the Teams that belong to an OrgUnit or to any OrgUnit below it.
 *
 * @param structure - OrgUnit tree and Team memberships.
 * @param orgUnitId - OrgUnit whose Teams are listed.
 * @returns Team identifiers in membership order.
 */
export function listOrgUnitTeamIds(
  structure: Pick<OrgStructure, 'orgUnits' | 'teamAssignments'>,
  orgUnitId: string,
): string[] {
  const subtree = new Set(listOrgUnitSubtreeIds(structure.orgUnits, orgUnitId))
  return structure.teamAssignments
    .filter((assignment) => subtree.has(assignment.orgUnitId))
    .map((assignment) => assignment.teamId)
}

/**
 * Builds the display path of an OrgUnit, such as `Sales / East`.
 *
 * @param orgUnits - Every OrgUnit of the Workspace.
 * @param orgUnitId - OrgUnit to describe.
 * @returns OrgUnits from the top level down to the given one, or empty when it does not exist.
 */
export function resolveOrgUnitPath(orgUnits: readonly OrgUnit[], orgUnitId: string): OrgUnit[] {
  const byId = new Map(orgUnits.map((orgUnit) => [orgUnit.id, orgUnit]))
  const path: OrgUnit[] = []
  let current = byId.get(orgUnitId)
  while (current && path.length <= ORG_UNIT_MAX_DEPTH && !path.includes(current)) {
    path.unshift(current)
    current = current.parentId === undefined ? undefined : byId.get(current.parentId)
  }
  return path
}

/**
 * Groups OrgUnits by parent, keeping their given order.
 *
 * @param orgUnits - OrgUnits to group.
 * @returns Children by parent identifier, with top-level OrgUnits under `undefined`.
 */
function groupChildren(orgUnits: readonly OrgUnit[]) {
  const children = new Map<string | undefined, OrgUnit[]>()
  for (const orgUnit of orgUnits) {
    const siblings = children.get(orgUnit.parentId) ?? []
    siblings.push(orgUnit)
    children.set(orgUnit.parentId, siblings)
  }
  return children
}

/**
 * Resolves the depth of an OrgUnit, memoizing results.
 *
 * @param id - OrgUnit identifier.
 * @param byId - OrgUnits by identifier; every parent must exist.
 * @param depthById - Memoized depths.
 * @returns The level, counting a top-level OrgUnit as 1, or `cycle` when the ancestry loops.
 */
function resolveDepth(
  id: string,
  byId: ReadonlyMap<string, OrgUnit>,
  depthById: Map<string, number>,
): number | 'cycle' {
  const chain: string[] = []
  let current: string | undefined = id
  let base = 0
  while (current !== undefined) {
    const known = depthById.get(current)
    if (known !== undefined) {
      base = known
      break
    }
    if (chain.includes(current)) return 'cycle'
    chain.push(current)
    current = byId.get(current)?.parentId
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    base += 1
    const chainId = chain[index]
    if (chainId !== undefined) depthById.set(chainId, base)
  }
  return depthById.get(id) ?? base
}

/**
 * Tells whether a value is a non-array object.
 *
 * @param value - Value to test.
 * @returns Whether the value can be read as a record.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
