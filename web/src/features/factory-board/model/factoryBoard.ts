import {
  FACTORY_BOARD_LANES,
  classifyFactoryBoardItem,
  type AgentRunRuntime,
  type FactoryBoardItem,
  type FactoryBoardLane,
  type TeamAgentRunBoardResponse,
} from '@mukuroji/contracts'

/** Filter value that keeps every item. */
export const FACTORY_BOARD_FILTER_ALL = 'all'

/** Project filter value that keeps Work Items without a Project. */
export const FACTORY_BOARD_FILTER_NO_PROJECT = 'none'

/** Filters the board offers; each value is {@link FACTORY_BOARD_FILTER_ALL} or a concrete choice. */
export type FactoryBoardFilters = {
  /** Runtime of the item's run. Items without a run never match a concrete runtime. */
  runtime: AgentRunRuntime | typeof FACTORY_BOARD_FILTER_ALL
  /** Member responsible for the Work Item. */
  assigneeUserId: string
  /** Assigned Project ID, or {@link FACTORY_BOARD_FILTER_NO_PROJECT} for unassigned Work Items. */
  projectId: string
}

/** Filters that keep every item. */
export const defaultFactoryBoardFilters: FactoryBoardFilters = {
  runtime: FACTORY_BOARD_FILTER_ALL,
  assigneeUserId: FACTORY_BOARD_FILTER_ALL,
  projectId: FACTORY_BOARD_FILTER_ALL,
}

/** One lane with the items it holds, in display order. */
export type FactoryBoardLaneGroup = {
  /** Lane. */
  lane: FactoryBoardLane
  /** Items in the lane. */
  items: FactoryBoardItem[]
}

/** Choices the filters can offer, taken from the loaded items. */
export type FactoryBoardFilterOptions = {
  /** Runtimes of the loaded runs, in contract order. */
  runtimes: AgentRunRuntime[]
  /** Assignees of the loaded Work Items, sorted. */
  assigneeUserIds: string[]
  /** Assigned Projects of the loaded Work Items, sorted. */
  projectIds: string[]
  /** Whether a loaded Work Item has no Project. */
  hasUnassignedProject: boolean
}

/** Runtimes in the order the filter lists them. */
const runtimeOrder: readonly AgentRunRuntime[] = ['claude-code', 'codex', 'kiro', 'other']

/**
 * Reads the time an item last changed, used to put the newest items first in finished lanes.
 *
 * @param item - Board item.
 * @returns Milliseconds since the epoch.
 */
function readLatestActivity(item: FactoryBoardItem): number {
  const times = [item.run?.finishedAt, item.run?.lastHeartbeatAt, item.latestReport?.createdAt]
    .flatMap((value) => value === undefined ? [] : [Date.parse(value)])
  return times.length === 0 ? 0 : Math.max(...times)
}

/**
 * Compares two items of one lane: leases that expire first lead the active lanes, the newest change
 * leads the others, and the title breaks ties so the order is stable.
 *
 * @param lane - Lane both items belong to.
 * @param left - First item.
 * @param right - Second item.
 * @returns Negative when `left` comes first.
 */
function compareLaneItems(lane: FactoryBoardLane, left: FactoryBoardItem, right: FactoryBoardItem): number {
  const byTitle = left.workItem.title.localeCompare(right.workItem.title) || left.workItem.id.localeCompare(right.workItem.id)
  if (lane === 'processing' || lane === 'stalled') {
    return Date.parse(left.run?.leaseExpiresAt ?? '') - Date.parse(right.run?.leaseExpiresAt ?? '') || byTitle
  }
  if (lane === 'no-run') return byTitle
  return readLatestActivity(right) - readLatestActivity(left) || byTitle
}

/**
 * Places items in their lanes at a given time with the shared contract rule, dropping items that
 * belong to no lane any more.
 *
 * @param items - Board items.
 * @param now - Time the lanes are evaluated at.
 * @returns Every lane in display order, including empty ones.
 */
export function groupFactoryBoardItems(items: readonly FactoryBoardItem[], now: Date): FactoryBoardLaneGroup[] {
  const groups = new Map<FactoryBoardLane, FactoryBoardItem[]>(FACTORY_BOARD_LANES.map((lane) => [lane, []]))
  for (const item of items) {
    const lane = classifyFactoryBoardItem(item, now)
    if (lane !== undefined) groups.get(lane)?.push(item)
  }
  return FACTORY_BOARD_LANES.map((lane) => ({
    lane,
    items: [...(groups.get(lane) ?? [])].sort((left, right) => compareLaneItems(lane, left, right)),
  }))
}

/**
 * Keeps the items that match every filter.
 *
 * @param items - Board items.
 * @param filters - Selected filters.
 * @returns Matching items in their original order.
 */
export function filterFactoryBoardItems(items: readonly FactoryBoardItem[], filters: FactoryBoardFilters): FactoryBoardItem[] {
  return items.filter((item) =>
    (filters.runtime === FACTORY_BOARD_FILTER_ALL || item.run?.runtime === filters.runtime) &&
    (filters.assigneeUserId === FACTORY_BOARD_FILTER_ALL || item.workItem.assigneeUserId === filters.assigneeUserId) &&
    (filters.projectId === FACTORY_BOARD_FILTER_ALL ||
      (filters.projectId === FACTORY_BOARD_FILTER_NO_PROJECT
        ? item.workItem.assignedProjectId === undefined
        : item.workItem.assignedProjectId === filters.projectId)))
}

/**
 * Lists the filter choices present in the loaded items.
 *
 * @param items - Board items.
 * @returns Runtime, assignee, and Project choices.
 */
export function readFactoryBoardFilterOptions(items: readonly FactoryBoardItem[]): FactoryBoardFilterOptions {
  const runtimes = new Set(items.flatMap((item) => item.run ? [item.run.runtime] : []))
  const projectIds = new Set(items.flatMap((item) => item.workItem.assignedProjectId === undefined ? [] : [item.workItem.assignedProjectId]))
  return {
    runtimes: runtimeOrder.filter((runtime) => runtimes.has(runtime)),
    assigneeUserIds: [...new Set(items.map((item) => item.workItem.assigneeUserId))].sort(),
    projectIds: [...projectIds].sort(),
    hasUnassignedProject: items.some((item) => item.workItem.assignedProjectId === undefined),
  }
}

/**
 * Reads the whole minutes until an active run's lease expires.
 *
 * @param leaseExpiresAt - Lease expiry time.
 * @param now - Reference time.
 * @returns Minutes left, rounded up; zero or negative once expired, rounded toward the past.
 */
export function readLeaseMinutesRemaining(leaseExpiresAt: string, now: Date): number {
  const milliseconds = Date.parse(leaseExpiresAt) - now.getTime()
  return milliseconds > 0 ? Math.ceil(milliseconds / 60_000) : Math.floor(milliseconds / 60_000)
}

/**
 * Checks whether the server stopped any read early, so the board must say it may be incomplete.
 *
 * @param board - Board response.
 * @returns True when a read bound was reached.
 */
export function isFactoryBoardIncomplete(board: Pick<TeamAgentRunBoardResponse, 'activeRunsHasMore' | 'finishedRunsHasMore' | 'startedWorkItemsHasMore'>): boolean {
  return board.activeRunsHasMore || board.finishedRunsHasMore || board.startedWorkItemsHasMore
}
