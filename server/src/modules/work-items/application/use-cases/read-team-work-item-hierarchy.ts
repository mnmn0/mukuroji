import {
  buildWorkItemHierarchy,
  readWorkItemParentId,
  rollUpWorkItemHierarchy,
  type CanonicalWorkItem,
  type TeamWorkItemHierarchyNode,
  type TeamWorkItemHierarchyResponse,
  type WorkItemHierarchyPlacement,
  type WorkItemHierarchyRollupSource,
} from '@mukuroji/contracts'

/** One non-archived Work Item with its effective sibling order rank. */
export type TeamWorkItemHierarchySourceEntry<Issue extends CanonicalWorkItem = CanonicalWorkItem> = {
  /** Canonical Work Item. */
  issue: Issue
  /** Stored or derived sibling order rank. */
  hierarchyRank: string
}

/** Input of {@link createTeamWorkItemHierarchyResponse}. */
export type CreateTeamWorkItemHierarchyInput<Issue extends CanonicalWorkItem = CanonicalWorkItem> = {
  /** Team whose hierarchy is returned. */
  teamId: string
  /** Relation graph revision read before the Work Items. */
  graphRevision: number
  /** Every non-archived Work Item of the Team. */
  entries: readonly TeamWorkItemHierarchySourceEntry<Issue>[]
  /** Whether the reader may see a Work Item. */
  isReadable: (issue: Issue) => boolean
}

/**
 * Builds the Team hierarchy read model for one reader.
 *
 * WBS numbers come from the Team's whole tree, so every reader sees the same number for a Work
 * Item. Only readable Work Items are returned, their depth counts only readable ancestors, and
 * roll-ups count only readable descendants reached through readable parents, so a reader learns
 * nothing about Work Items they may not see.
 *
 * @param input - Team, graph revision, Work Items, and the reader's visibility check.
 * @returns Readable nodes in outline order.
 */
export function createTeamWorkItemHierarchyResponse<Issue extends CanonicalWorkItem>(
  input: CreateTeamWorkItemHierarchyInput<Issue>,
): TeamWorkItemHierarchyResponse {
  // A stored parent that is archived, missing, or part of a broken cycle leaves the Work Item at
  // the top of the tree; it is still marked so that a move cannot silently drop that parent.
  const storedParentIds = new Map<string, string>()
  const placements = buildWorkItemHierarchy(input.entries.map((entry) => {
    const parentWorkItemId = readWorkItemParentId(entry.issue.relationIds)
    if (parentWorkItemId !== undefined) storedParentIds.set(entry.issue.id, parentWorkItemId)
    return {
      id: entry.issue.id,
      hierarchyRank: entry.hierarchyRank,
      ...(parentWorkItemId === undefined ? {} : { parentWorkItemId }),
    }
  }))
  const sources = new Map<string, WorkItemHierarchyRollupSource>()
  for (const entry of input.entries) {
    if (input.isReadable(entry.issue)) sources.set(entry.issue.id, entry.issue)
  }
  const placementById = new Map(placements.map((placement) => [placement.workItemId, placement]))
  const rollups = rollUpWorkItemHierarchy(placements, sources)
  const visibleDepth = new Map<string, number>()
  const nodes: TeamWorkItemHierarchyNode[] = []
  for (const placement of placements) {
    if (!sources.has(placement.workItemId)) continue
    const depth = readVisibleDepth(placement, placementById, visibleDepth, sources)
    visibleDepth.set(placement.workItemId, depth)
    const parentReadable = placement.parentWorkItemId !== null && sources.has(placement.parentWorkItemId)
    const parentHidden = placement.parentWorkItemId === null
      ? storedParentIds.has(placement.workItemId)
      : !parentReadable
    const rollup = rollups.get(placement.workItemId)
    nodes.push({
      workItemId: placement.workItemId,
      parentWorkItemId: parentReadable ? placement.parentWorkItemId : null,
      ...(parentHidden ? { parentHidden: true } : {}),
      depth,
      wbsNumber: placement.wbsNumber,
      hierarchyRank: placement.hierarchyRank,
      childWorkItemIds: placement.childWorkItemIds.filter((childId) => sources.has(childId)),
      ...(rollup ? { rollup } : {}),
    })
  }
  return {
    schemaVersion: 1,
    teamId: input.teamId,
    graphRevision: input.graphRevision,
    nodes,
  }
}

/**
 * Counts a Work Item's readable ancestors.
 *
 * @param placement - Placement of a readable Work Item.
 * @param placementById - Every placement by Work Item ID.
 * @param visibleDepth - Depths of readable Work Items placed earlier in outline order.
 * @param readable - Readable Work Items by ID.
 * @returns One more than the depth of the nearest readable ancestor, or 0 without one.
 */
function readVisibleDepth(
  placement: WorkItemHierarchyPlacement,
  placementById: ReadonlyMap<string, WorkItemHierarchyPlacement>,
  visibleDepth: ReadonlyMap<string, number>,
  readable: ReadonlyMap<string, unknown>,
): number {
  let ancestorId = placement.parentWorkItemId
  while (ancestorId !== null) {
    if (readable.has(ancestorId)) return (visibleDepth.get(ancestorId) ?? 0) + 1
    ancestorId = placementById.get(ancestorId)?.parentWorkItemId ?? null
  }
  return 0
}
