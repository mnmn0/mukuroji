import {
  createWorkItemHierarchyRankBetween,
  isWorkItemHierarchyClosedCategory,
  readWorkItemParentId,
  type TeamWorkItemHierarchyNode,
  type WorkflowStatusCategory,
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
 * shown children under the next shown ancestor. Work Items missing from the hierarchy (archived,
 * or created after it was read) follow at the top level in their given order.
 *
 * @param items - Shown Work Items.
 * @param nodes - Hierarchy nodes in outline order.
 * @param collapsedIds - Work Items whose nested rows are hidden.
 * @returns Visible rows in outline order.
 */
export function createWorkItemOutlineRows<Item extends { id: string }>(
  items: readonly Item[],
  nodes: readonly TeamWorkItemHierarchyNode[],
  collapsedIds: ReadonlySet<string>,
): WorkItemOutlineRow<Item>[] {
  const itemsById = new Map(items.map((item) => [item.id, item]))
  const nodesById = new Map(nodes.map((node) => [node.workItemId, node]))
  const depthById = new Map<string, number>()
  const ordered: { item: Item, node?: TeamWorkItemHierarchyNode, depth: number }[] = []
  for (const node of nodes) {
    const item = itemsById.get(node.workItemId)
    if (!item) continue
    let depth = 0
    let ancestorId = node.parentWorkItemId
    while (ancestorId !== null) {
      const ancestorDepth = depthById.get(ancestorId)
      if (ancestorDepth !== undefined) {
        depth = ancestorDepth + 1
        break
      }
      ancestorId = nodesById.get(ancestorId)?.parentWorkItemId ?? null
    }
    depthById.set(node.workItemId, depth)
    ordered.push({ item, node, depth })
  }
  for (const item of items) {
    if (!nodesById.has(item.id)) ordered.push({ item, depth: 0 })
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

/**
 * Counts the direct children of a Work Item that are neither completed nor canceled.
 *
 * Only Work Items the viewer has loaded are counted; the server still enforces a Team's reject
 * policy over every child.
 *
 * @param parentWorkItemId - Parent whose children are counted.
 * @param workItems - Loaded Work Items with their relation projection and status category.
 * @returns Number of open direct children.
 */
export function countOpenWorkItemChildren(
  parentWorkItemId: string,
  workItems: readonly { relationIds: readonly string[], statusCategory: WorkflowStatusCategory }[],
): number {
  return workItems.filter((workItem) =>
    readWorkItemParentId(workItem.relationIds) === parentWorkItemId &&
    !isWorkItemHierarchyClosedCategory(workItem.statusCategory)
  ).length
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
