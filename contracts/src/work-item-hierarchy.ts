import type { WorkflowStatusCategory } from './work-item-configuration'
import { deriveWorkItemRemainingEffortMinutes } from './work-item-effort'
import type { WorkItemSchedule } from './work-items'

/**
 * Most Work Items the Team hierarchy read model reads. A Team with more non-archived Work Items
 * gets `413 WorkItemListLimitExceeded` instead of a partial tree.
 */
export const WORK_ITEM_HIERARCHY_MAX_ITEMS = 1_000

/** Longest sibling order rank a Work Item may store. */
export const WORK_ITEM_HIERARCHY_RANK_MAX_LENGTH = 64

/** Digits of a sibling order rank, in ascending order. */
const RANK_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Number of base-36 digits that encode a Team creation order in a default rank. */
const DEFAULT_RANK_SORT_ORDER_DIGITS = 11

/** Number of base-36 digits that hold the Work Item ID hash in a default rank. */
const DEFAULT_RANK_ID_HASH_DIGITS = 7

/**
 * Returns whether a status category leaves no work open under a parent.
 *
 * @param category - Workflow status category of a child.
 * @returns Whether the child is completed or canceled.
 */
export function isWorkItemHierarchyClosedCategory(category: string): boolean {
  return category === 'completed' || category === 'canceled'
}

/**
 * Returns whether a value is a valid sibling order rank.
 *
 * A rank is 1 to {@link WORK_ITEM_HIERARCHY_RANK_MAX_LENGTH} lowercase base-36 digits that does
 * not end in `0`, so another rank can always be placed before or between it. Ranks compare as
 * plain strings.
 *
 * @param value - Candidate value.
 * @returns Whether it is a valid rank.
 */
export function isWorkItemHierarchyRank(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= WORK_ITEM_HIERARCHY_RANK_MAX_LENGTH &&
    /^[0-9a-z]*[1-9a-z]$/u.test(value)
}

/**
 * Derives the rank of a Work Item that has never been reordered.
 *
 * The rank encodes the Team creation order (`sortOrder`), so unordered siblings keep the order
 * in which they were created and a new Work Item is placed after its existing siblings. A hash
 * of the Work Item ID follows, so two siblings that share a `sortOrder` still get different
 * ranks and a move between them always finds room.
 *
 * @param sortOrder - Team creation order stored with the Work Item.
 * @param workItemId - ID of the Work Item.
 * @returns A valid rank that starts with `1`.
 */
export function createDefaultWorkItemHierarchyRank(sortOrder: number, workItemId: string): string {
  const encoded = Number.isSafeInteger(sortOrder) && sortOrder >= 0
    ? sortOrder.toString(36)
    : ''
  const idHash = hashWorkItemId(workItemId).toString(36)
  return `1${encoded.padStart(DEFAULT_RANK_SORT_ORDER_DIGITS, '0')}${idHash.padStart(DEFAULT_RANK_ID_HASH_DIGITS, '0')}i`
}

/**
 * Hashes a Work Item ID with 32-bit FNV-1a.
 *
 * @param workItemId - ID to hash.
 * @returns An unsigned 32-bit hash, which fits in {@link DEFAULT_RANK_ID_HASH_DIGITS} base-36 digits.
 */
function hashWorkItemId(workItemId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < workItemId.length; index += 1) {
    hash ^= workItemId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Creates a rank that sorts strictly between two sibling ranks.
 *
 * Omit `lower` to place the item first and `upper` to place it last. A rank placed after or
 * before a sibling stays close to that sibling, so Work Items created later still sort after it.
 *
 * @param lower - Rank of the sibling just before the new position.
 * @param upper - Rank of the sibling just after the new position.
 * @returns The new rank, or `undefined` when the ranks are invalid, not in ascending order, or
 *   no rank of at most {@link WORK_ITEM_HIERARCHY_RANK_MAX_LENGTH} digits fits between them.
 */
export function createWorkItemHierarchyRankBetween(
  lower?: string,
  upper?: string,
): string | undefined {
  if (lower !== undefined && !isWorkItemHierarchyRank(lower)) return undefined
  if (upper !== undefined && !isWorkItemHierarchyRank(upper)) return undefined
  let rank: string
  if (lower === undefined && upper === undefined) {
    rank = 'i'
  } else if (upper === undefined && lower !== undefined) {
    rank = createRankAfter(lower)
  } else if (lower === undefined && upper !== undefined) {
    rank = createRankBefore(upper)
  } else if (lower !== undefined && upper !== undefined && lower < upper) {
    rank = createRankMidpoint(lower, upper)
  } else {
    return undefined
  }
  return isWorkItemHierarchyRank(rank) ? rank : undefined
}

/**
 * Creates the closest short rank after a rank.
 *
 * @param lower - Valid rank to follow.
 * @returns A rank greater than `lower`.
 */
function createRankAfter(lower: string): string {
  const lastIndex = lower.length - 1
  const lastDigit = RANK_DIGITS.indexOf(lower.charAt(lastIndex))
  if (lastDigit < RANK_DIGITS.length - 1) {
    return `${lower.slice(0, lastIndex)}${RANK_DIGITS.charAt(lastDigit + 1)}`
  }
  if (lower.length < WORK_ITEM_HIERARCHY_RANK_MAX_LENGTH) return `${lower}i`
  // No room to append: raise the last digit that is not `z` and drop the rest, which is shorter.
  const index = lower.replace(/z+$/u, '').length - 1
  if (index < 0) return `${lower}i`
  return `${lower.slice(0, index)}${RANK_DIGITS.charAt(RANK_DIGITS.indexOf(lower.charAt(index)) + 1)}`
}

/**
 * Creates the closest short rank before a rank.
 *
 * @param upper - Valid rank to precede; it never ends in `0`.
 * @returns A rank smaller than `upper` that does not end in `0`.
 */
function createRankBefore(upper: string): string {
  const lastIndex = upper.length - 1
  const lastDigit = RANK_DIGITS.indexOf(upper.charAt(lastIndex))
  if (lastDigit > 1) return `${upper.slice(0, lastIndex)}${RANK_DIGITS.charAt(lastDigit - 1)}`
  if (upper.length < WORK_ITEM_HIERARCHY_RANK_MAX_LENGTH) return `${upper.slice(0, lastIndex)}0i`
  // No room to append: a proper prefix of `upper` sorts before it and is shorter.
  const prefix = upper.slice(0, lastIndex).replace(/0+$/u, '')
  return prefix || `${upper.slice(0, lastIndex)}0i`
}

/**
 * Creates a rank strictly between two ranks.
 *
 * @param lower - Smaller rank, or an empty string for "no lower digit".
 * @param upper - Greater rank, or `undefined` for "no upper bound".
 * @returns A rank between both bounds that does not end in `0`.
 */
function createRankMidpoint(lower: string, upper: string | undefined): string {
  if (upper !== undefined) {
    let shared = 0
    while ((lower.charAt(shared) || '0') === upper.charAt(shared)) shared += 1
    if (shared > 0) {
      return upper.slice(0, shared) + createRankMidpoint(lower.slice(shared), upper.slice(shared))
    }
  }
  const lowerDigit = lower ? RANK_DIGITS.indexOf(lower.charAt(0)) : 0
  const upperDigit = upper !== undefined ? RANK_DIGITS.indexOf(upper.charAt(0)) : RANK_DIGITS.length
  if (upperDigit - lowerDigit > 1) {
    return RANK_DIGITS.charAt(Math.round((lowerDigit + upperDigit) / 2))
  }
  if (upper !== undefined && upper.length > 1) return upper.slice(0, 1)
  return RANK_DIGITS.charAt(lowerDigit) + createRankMidpoint(lower.slice(1), undefined)
}

/**
 * Reads the parent Work Item ID from a Work Item's derived relation IDs.
 *
 * @param relationIds - `type:targetWorkItemId` entries of one Work Item.
 * @returns The parent ID, or `undefined` when the Work Item has no parent.
 */
export function readWorkItemParentId(relationIds: readonly string[]): string | undefined {
  const parents = relationIds
    .filter((relationId) => relationId.startsWith('parent:'))
    .map((relationId) => relationId.slice('parent:'.length))
    .filter((parentId) => parentId.length > 0)
    .sort()
  return parents[0]
}

/** One Work Item placed into a hierarchy. */
export type WorkItemHierarchyEntry = {
  /** Work Item ID. */
  id: string
  /** Parent Work Item ID; absent for a top-level Work Item. */
  parentWorkItemId?: string
  /** Effective sibling order rank. */
  hierarchyRank: string
}

/** Position of one Work Item in a hierarchy. */
export type WorkItemHierarchyPlacement = {
  /** Work Item ID. */
  workItemId: string
  /** Parent Work Item ID; `null` for a top-level Work Item. */
  parentWorkItemId: string | null
  /** Number of ancestors; top-level Work Items have depth 0. */
  depth: number
  /** Dotted position among siblings such as `1.2.3`, derived when the hierarchy is read. */
  wbsNumber: string
  /** Effective sibling order rank. */
  hierarchyRank: string
  /** Child Work Item IDs in sibling order. */
  childWorkItemIds: string[]
}

/**
 * Compares two hierarchy entries in sibling order: by rank, then by Work Item ID.
 *
 * @param first - First entry.
 * @param second - Second entry.
 * @returns A negative, zero, or positive sort result.
 */
export function compareWorkItemHierarchySiblings(
  first: Pick<WorkItemHierarchyEntry, 'id' | 'hierarchyRank'>,
  second: Pick<WorkItemHierarchyEntry, 'id' | 'hierarchyRank'>,
): number {
  if (first.hierarchyRank !== second.hierarchyRank) {
    return first.hierarchyRank < second.hierarchyRank ? -1 : 1
  }
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0
}

/**
 * Places Work Items into a tree and numbers them in WBS order.
 *
 * A Work Item whose parent is not among `entries` (archived, deleted, or not readable) becomes a
 * top-level Work Item. The relation graph rejects cycles; if stored data still contains one, the
 * first Work Item of the cycle in sibling order becomes a top-level Work Item so every entry is
 * placed exactly once.
 *
 * @param entries - Work Items with their parent and effective rank.
 * @returns Every entry in depth-first (outline) order.
 */
export function buildWorkItemHierarchy(
  entries: readonly WorkItemHierarchyEntry[],
): WorkItemHierarchyPlacement[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const childrenByParent = new Map<string, WorkItemHierarchyEntry[]>()
  const roots: WorkItemHierarchyEntry[] = []
  for (const entry of byId.values()) {
    const parentId = entry.parentWorkItemId
    if (parentId !== undefined && parentId !== entry.id && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? []
      siblings.push(entry)
      childrenByParent.set(parentId, siblings)
    } else {
      roots.push(entry)
    }
  }
  for (const siblings of childrenByParent.values()) siblings.sort(compareWorkItemHierarchySiblings)
  roots.sort(compareWorkItemHierarchySiblings)

  const placements: WorkItemHierarchyPlacement[] = []
  const placed = new Set<string>()
  let topLevelCount = 0
  /** Places one top-level entry and its descendants depth-first. */
  const placeTree = (root: WorkItemHierarchyEntry) => {
    topLevelCount += 1
    const stack: { entry: WorkItemHierarchyEntry, parentId: string | null, depth: number, wbsNumber: string }[] = [
      { entry: root, parentId: null, depth: 0, wbsNumber: String(topLevelCount) },
    ]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || placed.has(current.entry.id)) continue
      placed.add(current.entry.id)
      const children = (childrenByParent.get(current.entry.id) ?? [])
        .filter((child) => !placed.has(child.id))
      placements.push({
        workItemId: current.entry.id,
        parentWorkItemId: current.parentId,
        depth: current.depth,
        wbsNumber: current.wbsNumber,
        hierarchyRank: current.entry.hierarchyRank,
        childWorkItemIds: children.map((child) => child.id),
      })
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index]
        if (!child) continue
        stack.push({
          entry: child,
          parentId: current.entry.id,
          depth: current.depth + 1,
          wbsNumber: `${current.wbsNumber}.${index + 1}`,
        })
      }
    }
  }
  for (const root of roots) placeTree(root)
  // Only a stored cycle leaves entries unplaced; break it at its first entry in sibling order.
  while (placed.size < byId.size) {
    const next = [...byId.values()]
      .filter((entry) => !placed.has(entry.id))
      .sort(compareWorkItemHierarchySiblings)[0]
    if (!next) break
    placeTree(next)
  }
  return placements
}

/** Fields of one Work Item that a parent's roll-up reads. */
export type WorkItemHierarchyRollupSource = {
  /** Standard workflow status category. */
  statusCategory: WorkflowStatusCategory
  /** Canonical schedule with the planned effort and dates. */
  schedule: WorkItemSchedule
  /** Recorded remaining effort in minutes. */
  remainingEffortMinutes?: number
}

/**
 * Values aggregated from every descendant of a parent Work Item. Each descendant is counted once;
 * the parent's own values are not included.
 */
export type WorkItemHierarchyRollup = {
  /** Number of direct children. */
  childCount: number
  /** Number of descendants at every depth. */
  descendantCount: number
  /** Number of descendants in each status category. */
  statusCategoryCounts: Record<WorkflowStatusCategory, number>
  /** Number of descendants that are neither completed nor canceled. */
  openDescendantCount: number
  /** Sum of the descendants' planned effort (`schedule.plannedEffortMinutes`) in minutes. */
  plannedEffortMinutes: number
  /** Number of descendants that have a planned effort. */
  estimatedDescendantCount: number
  /** Sum of the descendants' derived remaining effort in minutes, where known. */
  remainingEffortMinutes: number
  /**
   * Earliest date among the descendants (`startDate` of a date range or milestone, or the
   * deadline of a due-date-only Work Item); absent when no descendant is scheduled.
   */
  startDate?: string
  /** Latest end date or deadline among the descendants; absent when no descendant is scheduled. */
  endDate?: string
}

/**
 * Creates an empty roll-up for a parent with the given number of children.
 *
 * @param childCount - Number of direct children.
 * @returns A roll-up with zero counts and no dates.
 */
function createEmptyRollup(childCount: number): WorkItemHierarchyRollup {
  return {
    childCount,
    descendantCount: 0,
    statusCategoryCounts: { backlog: 0, unstarted: 0, started: 0, completed: 0, canceled: 0 },
    openDescendantCount: 0,
    plannedEffortMinutes: 0,
    estimatedDescendantCount: 0,
    remainingEffortMinutes: 0,
  }
}

/**
 * Reads the first and last calendar dates a schedule occupies.
 *
 * @param schedule - Canonical schedule.
 * @returns The date span, or `undefined` for an unscheduled Work Item.
 */
function readScheduleSpan(schedule: WorkItemSchedule): { start: string, end: string } | undefined {
  switch (schedule.mode) {
    case 'unscheduled':
      return undefined
    case 'due-date':
      return schedule.dueDate ? { start: schedule.dueDate, end: schedule.dueDate } : undefined
    case 'date-range':
    case 'milestone':
      return { start: schedule.startDate, end: schedule.endDate }
  }
}

/**
 * Adds one descendant's own values to a roll-up.
 *
 * @param rollup - Roll-up to change.
 * @param source - Descendant values.
 */
function addRollupSource(rollup: WorkItemHierarchyRollup, source: WorkItemHierarchyRollupSource) {
  rollup.descendantCount += 1
  rollup.statusCategoryCounts[source.statusCategory] += 1
  if (!isWorkItemHierarchyClosedCategory(source.statusCategory)) rollup.openDescendantCount += 1
  const planned = source.schedule.plannedEffortMinutes
  if (planned !== undefined) {
    rollup.plannedEffortMinutes += planned
    rollup.estimatedDescendantCount += 1
  }
  rollup.remainingEffortMinutes += deriveWorkItemRemainingEffortMinutes(source) ?? 0
  const span = readScheduleSpan(source.schedule)
  if (span) {
    if (rollup.startDate === undefined || span.start < rollup.startDate) rollup.startDate = span.start
    if (rollup.endDate === undefined || span.end > rollup.endDate) rollup.endDate = span.end
  }
}

/**
 * Adds a child's subtree roll-up to its parent's roll-up.
 *
 * @param rollup - Parent roll-up to change.
 * @param child - Child roll-up whose descendants are added.
 */
function addChildRollup(rollup: WorkItemHierarchyRollup, child: WorkItemHierarchyRollup) {
  rollup.descendantCount += child.descendantCount
  for (const category of Object.keys(rollup.statusCategoryCounts)) {
    if (isWorkflowStatusCategoryKey(category)) {
      rollup.statusCategoryCounts[category] += child.statusCategoryCounts[category]
    }
  }
  rollup.openDescendantCount += child.openDescendantCount
  rollup.plannedEffortMinutes += child.plannedEffortMinutes
  rollup.estimatedDescendantCount += child.estimatedDescendantCount
  rollup.remainingEffortMinutes += child.remainingEffortMinutes
  if (child.startDate !== undefined && (rollup.startDate === undefined || child.startDate < rollup.startDate)) {
    rollup.startDate = child.startDate
  }
  if (child.endDate !== undefined && (rollup.endDate === undefined || child.endDate > rollup.endDate)) {
    rollup.endDate = child.endDate
  }
}

/**
 * Narrows a status count key to a workflow status category.
 *
 * @param value - Key of a status count record.
 * @returns Whether it is a workflow status category.
 */
function isWorkflowStatusCategoryKey(value: string): value is WorkflowStatusCategory {
  return value === 'backlog' || value === 'unstarted' || value === 'started' ||
    value === 'completed' || value === 'canceled'
}

/**
 * Rolls each parent's descendants up into one set of totals.
 *
 * @param placements - Hierarchy in outline order, as {@link buildWorkItemHierarchy} returns it.
 * @param sources - Roll-up fields of each Work Item by ID. Work Items missing from the map are
 *   neither counted nor traversed, so callers can leave out Work Items a reader may not see.
 * @returns The roll-up of every Work Item that has at least one counted child, by ID.
 */
export function rollUpWorkItemHierarchy(
  placements: readonly WorkItemHierarchyPlacement[],
  sources: ReadonlyMap<string, WorkItemHierarchyRollupSource>,
): Map<string, WorkItemHierarchyRollup> {
  const rollups = new Map<string, WorkItemHierarchyRollup>()
  // Children follow their parent in outline order, so a reverse pass sees every child first.
  for (let index = placements.length - 1; index >= 0; index -= 1) {
    const placement = placements[index]
    if (!placement || !sources.has(placement.workItemId)) continue
    const countedChildren = placement.childWorkItemIds.filter((childId) => sources.has(childId))
    if (countedChildren.length === 0) continue
    const rollup = createEmptyRollup(countedChildren.length)
    for (const childId of countedChildren) {
      const child = sources.get(childId)
      if (child) addRollupSource(rollup, child)
      const childRollup = rollups.get(childId)
      if (childRollup) addChildRollup(rollup, childRollup)
    }
    rollups.set(placement.workItemId, rollup)
  }
  return rollups
}

/** One readable Work Item of a Team hierarchy response. */
export type TeamWorkItemHierarchyNode = {
  /** Work Item ID. */
  workItemId: string
  /**
   * Parent Work Item ID; `null` for a top-level Work Item and for a Work Item whose parent the
   * reader may not see.
   */
  parentWorkItemId: string | null
  /**
   * `true` when the Work Item has a stored parent that is not in the reader's tree: one the reader
   * may not see, or one that is archived or missing. Such a Work Item cannot be moved in the
   * hierarchy by this reader, so a move never drops that parent silently.
   */
  parentHidden?: true
  /** Outline depth among the Work Items the reader sees; top-level is 0. */
  depth: number
  /**
   * WBS number such as `1.2.3`, derived from the Team's whole tree of non-archived Work Items so
   * every reader sees the same number.
   */
  wbsNumber: string
  /** Effective sibling order rank. Send ranks made from these as `hierarchyRank` to reorder. */
  hierarchyRank: string
  /** Readable child Work Item IDs in sibling order. */
  childWorkItemIds: string[]
  /** Totals of the readable descendants; absent when the Work Item has no readable child. */
  rollup?: WorkItemHierarchyRollup
}

/** Response of `GET /api/teams/{teamId}/issues/{issueId}/children/open-count`. */
export type WorkItemOpenChildCountResponse = {
  /**
   * Number of direct children the reader may see that are not archived and are neither
   * completed nor canceled.
   */
  openChildCount: number
}

/** Response of `GET /api/teams/{teamId}/issues/hierarchy`. */
export type TeamWorkItemHierarchyResponse = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team whose hierarchy was read. */
  teamId: string
  /** Team relation graph revision; send it as `expectedGraphRevision` to move a Work Item. */
  graphRevision: number
  /** Readable non-archived Work Items in outline (depth-first) order. */
  nodes: TeamWorkItemHierarchyNode[]
}

/**
 * Response of `GET /api/v1/work-items/{workItemId}/hierarchy`. The closed public Work Item schema
 * omits hierarchy fields, so a client reads them here.
 */
export type PublicWorkItemHierarchy = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
  /**
   * Parent Work Item ID; `null` when the Work Item has no parent the client may read, and for an
   * archived Work Item, which is outside the tree.
   */
  parentWorkItemId: string | null
  /**
   * Readable non-archived child Work Item IDs; empty for an archived Work Item. They are in sibling
   * order, except when the Team is too large for its tree: then `wbsNumber` is absent and the
   * children are in Work Item ID order.
   */
  childWorkItemIds: string[]
  /**
   * WBS number such as `1.2.3`; absent for an archived Work Item and when the Team is too large
   * for its tree.
   */
  wbsNumber?: string
}
