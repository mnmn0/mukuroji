import type { PlanningWorkItemLink } from '@mukuroji/contracts'
import type { PlanningWorkItemState } from '../../planning'

/** One Cycle whose automation step is due. */
export type CycleScheduleDueCycle = {
  /** Owning Workspace. */
  workspaceId: string
  /** Cycle entity ID. */
  cycleId: string
}

/** One page of due Cycles in a schedule shard. */
export type CycleScheduleDuePage = {
  /** Due Cycles of this page. */
  cycles: CycleScheduleDueCycle[]
  /** Opaque cursor of the next page; absent on the last page. */
  cursor?: unknown
}

/** Storage the Cycle automation schedule reads. */
export type CycleScheduleSource = {
  /** Number of due-index shards to visit. */
  shardCount: number
  /**
   * Lists the Cycles of one shard that are due at or before a time.
   *
   * @param shard - Zero-based shard index.
   * @param asOf - Schedule time.
   * @param cursor - Cursor returned by the previous page.
   * @returns One page of due Cycles.
   */
  listDueCycles(shard: number, asOf: Date, cursor?: unknown): Promise<CycleScheduleDuePage>
  /**
   * Reads the canonical Work Items behind Cycle links; archived Work Items are left out.
   *
   * @param workspaceId - Owning Workspace.
   * @param links - Cycle links.
   * @returns Planning Work Item projection.
   */
  readLinkedWorkItems(
    workspaceId: string,
    links: readonly PlanningWorkItemLink[],
  ): Promise<PlanningWorkItemState>
}
