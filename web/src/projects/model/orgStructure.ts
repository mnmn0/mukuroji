import {
  listOrgUnitSubtreeIds,
  type OrgUnit,
  type OrgUnitTeamAssignment,
} from '@mukuroji/contracts'

/** OrgUnit tree and Team memberships being edited before they are saved. */
export type OrgStructureDraft = {
  /** Every OrgUnit, parents first. */
  orgUnits: OrgUnit[]
  /** Team memberships. */
  teamAssignments: OrgUnitTeamAssignment[]
}

/** One OrgUnit with its depth, for an indented tree. */
export type OrgUnitTreeRow = {
  /** The OrgUnit. */
  orgUnit: OrgUnit
  /** Level below the top, 0 for a top-level OrgUnit. */
  depth: number
}

/**
 * Lists OrgUnits depth-first, each parent before its children, keeping sibling order.
 *
 * @param orgUnits - Every OrgUnit.
 * @returns Rows for an indented tree.
 */
export function listOrgUnitTreeRows(orgUnits: readonly OrgUnit[]): OrgUnitTreeRow[] {
  const ids = new Set(orgUnits.map((orgUnit) => orgUnit.id))
  const children = new Map<string | undefined, OrgUnit[]>()
  for (const orgUnit of orgUnits) {
    // An OrgUnit whose parent is missing is shown at the top rather than hidden.
    const parentId = orgUnit.parentId !== undefined && ids.has(orgUnit.parentId) ? orgUnit.parentId : undefined
    children.set(parentId, [...(children.get(parentId) ?? []), orgUnit])
  }
  const rows: OrgUnitTreeRow[] = []
  const visited = new Set<string>()
  const visit = (parentId: string | undefined, depth: number) => {
    for (const orgUnit of children.get(parentId) ?? []) {
      if (visited.has(orgUnit.id)) continue
      visited.add(orgUnit.id)
      rows.push({ orgUnit, depth })
      visit(orgUnit.id, depth + 1)
    }
  }
  visit(undefined, 0)
  return rows
}

/**
 * Adds an OrgUnit at the end of its siblings. A parent that is no longer in the draft, such as one
 * removed after it was chosen, is dropped so the OrgUnit is added at the top level.
 *
 * @param draft - Current draft.
 * @param orgUnit - OrgUnit to add.
 * @returns The new draft.
 */
export function addOrgUnit(draft: OrgStructureDraft, orgUnit: OrgUnit): OrgStructureDraft {
  const { parentId, ...rest } = orgUnit
  const added = parentId !== undefined && draft.orgUnits.some((candidate) => candidate.id === parentId)
    ? { ...rest, parentId }
    : rest
  return { ...draft, orgUnits: [...draft.orgUnits, added] }
}

/**
 * Renames an OrgUnit.
 *
 * @param draft - Current draft.
 * @param orgUnitId - OrgUnit to rename.
 * @param name - New name.
 * @returns The new draft.
 */
export function renameOrgUnit(draft: OrgStructureDraft, orgUnitId: string, name: string): OrgStructureDraft {
  return {
    ...draft,
    orgUnits: draft.orgUnits.map((orgUnit) => orgUnit.id === orgUnitId ? { ...orgUnit, name } : orgUnit),
  }
}

/**
 * Lists the OrgUnits that can become the parent of an OrgUnit: every OrgUnit outside its subtree.
 *
 * @param orgUnits - Every OrgUnit.
 * @param orgUnitId - OrgUnit to move.
 * @returns Candidate parents in tree order.
 */
export function listOrgUnitParentCandidates(orgUnits: readonly OrgUnit[], orgUnitId: string): OrgUnit[] {
  const subtree = new Set(listOrgUnitSubtreeIds(orgUnits, orgUnitId))
  return listOrgUnitTreeRows(orgUnits)
    .map((row) => row.orgUnit)
    .filter((orgUnit) => !subtree.has(orgUnit.id))
}

/**
 * Moves an OrgUnit under another parent, or to the top level. A move into its own subtree, which
 * would make a cycle, leaves the draft unchanged.
 *
 * @param draft - Current draft.
 * @param orgUnitId - OrgUnit to move.
 * @param parentId - New parent, or undefined for the top level.
 * @returns The new draft.
 */
export function moveOrgUnit(
  draft: OrgStructureDraft,
  orgUnitId: string,
  parentId: string | undefined,
): OrgStructureDraft {
  if (parentId !== undefined && listOrgUnitSubtreeIds(draft.orgUnits, orgUnitId).includes(parentId)) {
    return draft
  }
  return {
    ...draft,
    orgUnits: draft.orgUnits.map((orgUnit) => orgUnit.id === orgUnitId ? withParent(orgUnit, parentId) : orgUnit),
  }
}

/**
 * Removes an OrgUnit. Its child OrgUnits and its Teams move to its parent; at the top level its
 * children become top-level OrgUnits and its Teams belong to no OrgUnit.
 *
 * @param draft - Current draft.
 * @param orgUnitId - OrgUnit to remove.
 * @returns The new draft.
 */
export function removeOrgUnit(draft: OrgStructureDraft, orgUnitId: string): OrgStructureDraft {
  const removed = draft.orgUnits.find((orgUnit) => orgUnit.id === orgUnitId)
  if (!removed) return draft
  const parentId = removed.parentId
  return {
    orgUnits: draft.orgUnits
      .filter((orgUnit) => orgUnit.id !== orgUnitId)
      .map((orgUnit) => orgUnit.parentId === orgUnitId ? withParent(orgUnit, parentId) : orgUnit),
    teamAssignments: draft.teamAssignments.flatMap((assignment) => {
      if (assignment.orgUnitId !== orgUnitId) return [assignment]
      return parentId === undefined ? [] : [{ ...assignment, orgUnitId: parentId }]
    }),
  }
}

/**
 * Copies an OrgUnit under another parent.
 *
 * @param orgUnit - OrgUnit to copy.
 * @param parentId - New parent, or undefined for the top level.
 * @returns The OrgUnit with only the new parent.
 */
function withParent(orgUnit: OrgUnit, parentId: string | undefined): OrgUnit {
  return { id: orgUnit.id, name: orgUnit.name, ...(parentId === undefined ? {} : { parentId }) }
}

/**
 * Puts a Team in an OrgUnit, or takes it out of every OrgUnit.
 *
 * @param draft - Current draft.
 * @param teamId - Team to place.
 * @param orgUnitId - OrgUnit, or undefined for none.
 * @returns The new draft.
 */
export function assignTeamToOrgUnit(
  draft: OrgStructureDraft,
  teamId: string,
  orgUnitId: string | undefined,
): OrgStructureDraft {
  const others = draft.teamAssignments.filter((assignment) => assignment.teamId !== teamId)
  return {
    ...draft,
    teamAssignments: orgUnitId === undefined ? others : [...others, { teamId, orgUnitId }],
  }
}

/**
 * Creates the identifier of a new OrgUnit.
 *
 * @returns An identifier the API accepts.
 */
export function createOrgUnitId(): string {
  return `ou-${crypto.randomUUID()}`
}
