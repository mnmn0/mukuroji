import {
  createWorkItemHierarchyRankBetween,
  type TeamWorkItemHierarchyNode,
} from '@mukuroji/contracts'

/** Ways a Work Item can move in the hierarchy. */
export type WorkItemHierarchyMoveDirection = 'indent' | 'outdent' | 'up' | 'down'

/** Why a hierarchy move cannot be made. */
export type WorkItemHierarchyMoveBlockReason =
  | 'not-in-hierarchy'
  | 'parent-hidden'
  | 'no-previous-sibling'
  | 'no-next-sibling'
  | 'top-level'
  | 'rank-exhausted'

/** Result of planning one hierarchy move. */
export type WorkItemHierarchyMovePlan =
  | {
      /** The move can be sent. */
      ok: true
      /** Parent after the move; `null` makes the Work Item top-level. */
      parentWorkItemId: string | null
      /** Sibling order rank after the move. */
      hierarchyRank: string
    }
  | {
      /** The move cannot be made. */
      ok: false
      /** Why the move cannot be made. */
      reason: WorkItemHierarchyMoveBlockReason
    }

/**
 * Plans where a Work Item lands when it is indented, outdented, or moved among its siblings.
 *
 * - `indent` makes it the last child of its previous sibling.
 * - `outdent` places it right after its parent, under its grandparent.
 * - `up` and `down` swap it with its previous or next sibling.
 *
 * @param nodes - Hierarchy nodes in outline order.
 * @param workItemId - Work Item to move.
 * @param direction - Move to make.
 * @returns The new parent and rank, or why the move cannot be made.
 */
export function planWorkItemHierarchyMove(
  nodes: readonly TeamWorkItemHierarchyNode[],
  workItemId: string,
  direction: WorkItemHierarchyMoveDirection,
): WorkItemHierarchyMovePlan {
  const byId = new Map(nodes.map((node) => [node.workItemId, node]))
  const node = byId.get(workItemId)
  if (!node) return { ok: false, reason: 'not-in-hierarchy' }
  if (node.parentHidden) return { ok: false, reason: 'parent-hidden' }
  const siblings = listSiblings(nodes, byId, node.parentWorkItemId)
  const index = siblings.findIndex((sibling) => sibling.workItemId === workItemId)
  const previous = index > 0 ? siblings[index - 1] : undefined
  const next = siblings[index + 1]
  switch (direction) {
    case 'indent': {
      if (!previous) return { ok: false, reason: 'no-previous-sibling' }
      const lastChildId = previous.childWorkItemIds.at(-1)
      const lastChild = lastChildId === undefined ? undefined : byId.get(lastChildId)
      return createPlan(previous.workItemId, lastChild?.hierarchyRank, undefined)
    }
    case 'outdent': {
      const parent = node.parentWorkItemId === null ? undefined : byId.get(node.parentWorkItemId)
      if (!parent) return { ok: false, reason: 'top-level' }
      if (parent.parentHidden) return { ok: false, reason: 'parent-hidden' }
      const parentSiblings = listSiblings(nodes, byId, parent.parentWorkItemId)
      const parentIndex = parentSiblings.findIndex((sibling) => sibling.workItemId === parent.workItemId)
      return createPlan(
        parent.parentWorkItemId,
        parent.hierarchyRank,
        parentSiblings[parentIndex + 1]?.hierarchyRank,
      )
    }
    case 'up': {
      if (!previous) return { ok: false, reason: 'no-previous-sibling' }
      return createPlan(node.parentWorkItemId, siblings[index - 2]?.hierarchyRank, previous.hierarchyRank)
    }
    case 'down': {
      if (!next) return { ok: false, reason: 'no-next-sibling' }
      return createPlan(node.parentWorkItemId, next.hierarchyRank, siblings[index + 2]?.hierarchyRank)
    }
  }
}

/**
 * Lists the movable siblings under one parent in sibling order.
 *
 * @param nodes - Hierarchy nodes in outline order.
 * @param byId - Nodes by Work Item ID.
 * @param parentWorkItemId - Parent whose children are listed; `null` lists top-level Work Items.
 * @returns Siblings in sibling order.
 */
function listSiblings(
  nodes: readonly TeamWorkItemHierarchyNode[],
  byId: ReadonlyMap<string, TeamWorkItemHierarchyNode>,
  parentWorkItemId: string | null,
): TeamWorkItemHierarchyNode[] {
  if (parentWorkItemId !== null) {
    return (byId.get(parentWorkItemId)?.childWorkItemIds ?? [])
      .map((childId) => byId.get(childId))
      .filter((child): child is TeamWorkItemHierarchyNode => child !== undefined)
  }
  // A Work Item whose parent is hidden is not a real top-level sibling.
  return nodes.filter((candidate) => candidate.parentWorkItemId === null && !candidate.parentHidden)
}

/**
 * Creates a move plan with a rank between two neighbours.
 *
 * @param parentWorkItemId - Parent after the move.
 * @param lower - Rank of the sibling before the new position.
 * @param upper - Rank of the sibling after the new position.
 * @returns The plan, or `rank-exhausted` when no rank fits.
 */
function createPlan(
  parentWorkItemId: string | null,
  lower: string | undefined,
  upper: string | undefined,
): WorkItemHierarchyMovePlan {
  const hierarchyRank = createWorkItemHierarchyRankBetween(lower, upper)
  return hierarchyRank === undefined
    ? { ok: false, reason: 'rank-exhausted' }
    : { ok: true, parentWorkItemId, hierarchyRank }
}

/** One Work Item row of an outline. */
export type WorkItemOutlineRow<Item> = {
  /** Work Item shown on the row. */
  item: Item
  /** Hierarchy node of the Work Item; absent for a Work Item outside the hierarchy. */
  node?: TeamWorkItemHierarchyNode
  /** Indentation level among the shown Work Items; top-level is 0. */
  depth: number
  /** Whether shown Work Items are nested under this row. */
  hasChildren: boolean
  /** Whether the rows nested under this row are hidden. */
  collapsed: boolean
}

/**
 * Orders shown Work Items as an outline and hides the rows under collapsed parents.
 *
 * A Work Item nests under its nearest shown ancestor, so a filter that hides a parent keeps its
 * shown children under the next shown ancestor. Ancestors come from the nodes' outline order and
 * depth rather than from `parentWorkItemId`, because a Work Item under a parent the reader may not
 * see has no parent ID but still sits inside its readable ancestor's subtree. Work Items missing
 * from the hierarchy (archived, or created after it was read) follow at the top level in their
 * given order.
 *
 * @param items - Shown Work Items.
 * @param nodes - Hierarchy nodes in outline order, with depths counting readable ancestors.
 * @param collapsedIds - Work Items whose nested rows are hidden.
 * @returns Visible rows in outline order.
 */
export function createWorkItemOutlineRows<Item extends { id: string }>(
  items: readonly Item[],
  nodes: readonly TeamWorkItemHierarchyNode[],
  collapsedIds: ReadonlySet<string>,
): WorkItemOutlineRow<Item>[] {
  const itemsById = new Map(items.map((item) => [item.id, item]))
  const nodeIds = new Set(nodes.map((node) => node.workItemId))
  // Readable ancestors of the current node: their hierarchy depth and, when shown, row depth.
  const ancestors: { depth: number, rowDepth?: number }[] = []
  const ordered: { item: Item, node?: TeamWorkItemHierarchyNode, depth: number }[] = []
  for (const node of nodes) {
    while ((ancestors.at(-1)?.depth ?? -1) >= node.depth) ancestors.pop()
    const shownAncestor = ancestors.findLast((ancestor) => ancestor.rowDepth !== undefined)
    const depth = shownAncestor?.rowDepth === undefined ? 0 : shownAncestor.rowDepth + 1
    const item = itemsById.get(node.workItemId)
    ancestors.push({ depth: node.depth, ...(item ? { rowDepth: depth } : {}) })
    if (item) ordered.push({ item, node, depth })
  }
  for (const item of items) {
    if (!nodeIds.has(item.id)) ordered.push({ item, depth: 0 })
  }

  const rows: WorkItemOutlineRow<Item>[] = []
  let collapsedDepth: number | undefined
  ordered.forEach((entry, index) => {
    if (collapsedDepth !== undefined && entry.depth > collapsedDepth) return
    collapsedDepth = undefined
    const hasChildren = (ordered[index + 1]?.depth ?? -1) > entry.depth
    const collapsed = hasChildren && collapsedIds.has(entry.item.id)
    if (collapsed) collapsedDepth = entry.depth
    rows.push({ ...entry, hasChildren, collapsed })
  })
  return rows
}

/** Keyboard state read to detect a hierarchy move shortcut. */
export type WorkItemHierarchyMoveKeyInput = {
  /** Pressed key. */
  key: string
  /** Whether Alt (Option) is held. */
  altKey: boolean
  /** Whether Shift is held. */
  shiftKey: boolean
  /** Whether Control is held. */
  ctrlKey: boolean
  /** Whether Meta (Command) is held. */
  metaKey: boolean
}

/** Shortcuts announced on outline rows through `aria-keyshortcuts`. */
export const WORK_ITEM_HIERARCHY_MOVE_KEY_SHORTCUTS =
  'Alt+Shift+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowUp Alt+Shift+ArrowDown'

/**
 * Reads the hierarchy move asked for by Alt+Shift with an arrow key.
 *
 * @param input - Key and modifiers of a keydown event.
 * @returns The move, or `undefined` for any other key combination.
 */
export function readWorkItemHierarchyMoveShortcut(
  input: WorkItemHierarchyMoveKeyInput,
): WorkItemHierarchyMoveDirection | undefined {
  if (!input.altKey || !input.shiftKey || input.ctrlKey || input.metaKey) return undefined
  switch (input.key) {
    case 'ArrowRight': return 'indent'
    case 'ArrowLeft': return 'outdent'
    case 'ArrowUp': return 'up'
    case 'ArrowDown': return 'down'
    default: return undefined
  }
}

/**
 * Builds the key that identifies one Work Item's collapsed outline row across Teams.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns A key unique within the Workspace.
 */
export function createWorkItemOutlineKey(teamId: string, workItemId: string): string {
  return `${teamId}:${workItemId}`
}

/**
 * Orders shown Work Items of one or more Teams as outlines, one Team after another.
 *
 * Teams follow the order in which their first Work Item appears. A Team whose hierarchy is
 * missing (not read, too large, or failed) keeps its Work Items flat in their given order, so a
 * view that spans Teams still shows every Work Item when one Team's hierarchy is unavailable.
 *
 * @param items - Shown Work Items in their fallback order.
 * @param hierarchies - Hierarchy nodes in outline order, by Team ID.
 * @param collapsedKeys - Keys from {@link createWorkItemOutlineKey} of the collapsed rows.
 * @returns Visible rows in outline order.
 */
export function createMultiTeamWorkItemOutlineRows<Item extends { id: string, teamId: string }>(
  items: readonly Item[],
  hierarchies: ReadonlyMap<string, readonly TeamWorkItemHierarchyNode[]>,
  collapsedKeys: ReadonlySet<string>,
): WorkItemOutlineRow<Item>[] {
  const itemsByTeam = new Map<string, Item[]>()
  for (const item of items) {
    const teamItems = itemsByTeam.get(item.teamId)
    if (teamItems) teamItems.push(item)
    else itemsByTeam.set(item.teamId, [item])
  }
  return [...itemsByTeam].flatMap(([teamId, teamItems]) => {
    const nodes = hierarchies.get(teamId)
    if (!nodes) {
      return teamItems.map((item) => ({ item, depth: 0, hasChildren: false, collapsed: false }))
    }
    const collapsedIds = new Set(
      teamItems
        .filter((item) => collapsedKeys.has(createWorkItemOutlineKey(teamId, item.id)))
        .map((item) => item.id),
    )
    return createWorkItemOutlineRows(teamItems, nodes, collapsedIds)
  })
}

/**
 * Reads the WBS number of every Work Item in a set of Team hierarchies.
 *
 * @param hierarchies - Hierarchy nodes by Team ID.
 * @returns WBS numbers by {@link createWorkItemOutlineKey} key.
 */
export function createWorkItemWbsNumberIndex(
  hierarchies: ReadonlyMap<string, readonly TeamWorkItemHierarchyNode[]>,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const [teamId, nodes] of hierarchies) {
    for (const node of nodes) index.set(createWorkItemOutlineKey(teamId, node.workItemId), node.wbsNumber)
  }
  return index
}
