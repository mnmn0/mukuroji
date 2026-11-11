import type { WorkflowStatusCategory } from './work-item-configuration'
import type { CanonicalWorkItem } from './work-items'

/** Largest `limit` accepted by a paged Workspace Work Item list request. */
export const WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT = 200

/** Page size used when a paged Workspace Work Item list request omits `limit`. */
export const WORKSPACE_WORK_ITEM_PAGE_DEFAULT_LIMIT = 100

/** Involvement scope that narrows a Workspace Work Item list to the caller's own work. */
export type WorkspaceWorkItemInvolvement = 'mine'

/**
 * Server-side filters accepted by `GET /api/work-items`.
 *
 * Every filter narrows the Work Items the caller can already read; none of them widens access.
 */
export type WorkspaceWorkItemListFilter = {
  /** `mine` keeps Work Items whose accountable owner or a contributor is the caller. */
  involvement?: WorkspaceWorkItemInvolvement
  /** Keeps Work Items owned by this Team. The server then reads only that Team partition. */
  teamId?: string
  /** Keeps Work Items assigned to this Project. */
  projectId?: string
  /** Keeps Work Items whose workflow status belongs to one of these categories. */
  statusCategories?: readonly WorkflowStatusCategory[]
  /** Keeps Work Items that are neither completed nor canceled. */
  openOnly?: boolean
}

/** One page of `GET /api/work-items` when the request carries `limit` or `cursor`. */
export type WorkspaceWorkItemPage<TWorkItem extends CanonicalWorkItem = CanonicalWorkItem> = {
  /**
   * Work Items in this page.
   *
   * A page can hold fewer than `limit` items, or none, while `nextCursor` is still set,
   * because the server stops after a bounded number of evaluated rows.
   */
  workItems: TWorkItem[]
  /** Opaque cursor for the next page. Absent once every matching Work Item was returned. */
  nextCursor?: string
}

/** Assignee represented by the Work Items of one summary bucket. */
export type WorkItemSummaryAssignee = {
  /** Stable Workspace user ID stored as the Work Item's accountable owner. */
  id: string
  /** Best available display name, email address, or the ID itself. */
  label: string
}

/** Work Item counts for one Team-owned Project, or for a Team's Work Items without a Project. */
export type WorkItemSummaryBucket = {
  /** Team that owns the counted Work Items. */
  teamId: string
  /** Project the counted Work Items are assigned to. Absent for Work Items without a Project. */
  projectId?: string
  /** Every non-archived Work Item in the bucket. */
  total: number
  /** Work Items that are neither completed nor canceled. */
  open: number
  /** Work Items in a completed workflow status. */
  completed: number
  /** Open Work Items with high priority. */
  highPriorityOpen: number
  /** Open Work Items whose due date is before today in their schedule calendar. */
  overdueOpen: number
  /** Open Work Items that are high priority, overdue, or both. */
  attentionOpen: number
  /** Work Items in the `review` workflow status. */
  inReview: number
  /** Unique accountable owners of the bucket's Work Items, in first-seen order. */
  assignees: WorkItemSummaryAssignee[]
}

/** Response of `GET /api/work-items/summary`. */
export type WorkItemSummaryResponse = {
  /** Instant used to decide which Work Items are overdue. */
  generatedAt: string
  /** Counts across every bucket. */
  totals: {
    /** Every non-archived Work Item the caller can read. */
    total: number
    /** Work Items that are neither completed nor canceled. */
    open: number
    /** Work Items in a completed workflow status. */
    completed: number
  }
  /** One bucket per Team and Project that has at least one Work Item. */
  buckets: WorkItemSummaryBucket[]
}
