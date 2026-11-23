import type { WorkflowStatusCategory } from './work-item-configuration'
import type { CanonicalWorkItem, WorkItemSchedule } from './work-items'

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
  /**
   * Keeps Work Items whose accountable owner or a contributor is this member, as the
   * `member` query parameter. Used to find a member's work before handing it over; it
   * cannot be combined with `involvement`. It only narrows what the caller can already read.
   */
  memberUserId?: string
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

/** Largest `limit` accepted by a paged Team or Project Work Item list request. */
export const SCOPED_WORK_ITEM_PAGE_MAX_LIMIT = 200

/** Page size used when a paged Team or Project Work Item list request omits `limit`. */
export const SCOPED_WORK_ITEM_PAGE_DEFAULT_LIMIT = 100

/**
 * Largest number of Work Items a legacy Team or Project list request returns.
 *
 * A request without `limit` and `cursor` that matches more Work Items fails with
 * `413 WorkItemListLimitExceeded` instead of returning an unbounded response.
 */
export const SCOPED_WORK_ITEM_LEGACY_MAX_ITEMS = 1_000

/** One page of `GET /api/teams/:teamId/issues` when the request carries `limit` or `cursor`. */
export type TeamWorkItemListPage<TWorkItem extends CanonicalWorkItem = CanonicalWorkItem> = {
  /** Team whose Work Items were read. */
  teamId: string
  /**
   * Work Items in this page, in the Team's manual sort order.
   *
   * A page can hold fewer than `limit` items, or none, while `nextCursor` is still set,
   * because archived, other-type, and inaccessible Work Items are dropped after a bounded read.
   */
  issues: TWorkItem[]
  /** Opaque cursor for the next page. Absent once every matching Work Item was returned. */
  nextCursor?: string
}

/** One page of `GET /api/projects/:projectId/issues` when the request carries `limit` or `cursor`. */
export type ProjectWorkItemListPage<TWorkItem extends CanonicalWorkItem = CanonicalWorkItem> = {
  /** Project whose assigned Work Items were read. */
  projectId: string
  /**
   * Work Items in this page, in the Project's sort order.
   *
   * A page can hold fewer than `limit` items, or none, while `nextCursor` is still set.
   */
  issues: TWorkItem[]
  /** Whether the caller may request Customer impact for this Project resource. */
  canReadCustomerImpact?: boolean
  /** Opaque cursor for the next page. Absent once every matching Work Item was returned. */
  nextCursor?: string
}

/**
 * Longest inclusive schedule window, in calendar days, that a Team or Project list accepts.
 *
 * It covers a month calendar with its surrounding weeks and a quarter-long Gantt with margin,
 * while keeping one windowed read far below the complete-list limits.
 */
export const SCOPED_WORK_ITEM_SCHEDULE_WINDOW_MAX_DAYS = 400

/**
 * Schedule filter of `GET /api/teams/:teamId/issues` and `GET /api/projects/:projectId/issues`.
 *
 * - `window` keeps Work Items whose schedule touches the inclusive `from`..`to` dates. It is sent
 *   as `scheduledFrom` and `scheduledTo`, and never includes unscheduled Work Items.
 * - `unscheduled` keeps only Work Items without a calendar placement. It is sent as
 *   `unscheduled=true`.
 */
export type ScopedWorkItemScheduleFilter =
  | {
      /** Keeps Work Items whose schedule overlaps the window. */
      kind: 'window'
      /** Inclusive first local date in `YYYY-MM-DD` form. */
      from: string
      /** Inclusive last local date in `YYYY-MM-DD` form. */
      to: string
    }
  | {
      /** Keeps only Work Items whose schedule mode is `unscheduled`. */
      kind: 'unscheduled'
    }

/**
 * Decides whether a canonical schedule touches an inclusive local date window.
 *
 * A deadline touches the window when its date is inside it. A date range or milestone touches
 * the window when the two inclusive ranges overlap. An unscheduled Work Item never does.
 *
 * @param schedule - Canonical Work Item schedule.
 * @param from - Inclusive first date in `YYYY-MM-DD` form.
 * @param to - Inclusive last date in `YYYY-MM-DD` form.
 * @returns Whether the schedule is placed on at least one date of the window.
 */
export function workItemScheduleOverlapsWindow(
  schedule: WorkItemSchedule,
  from: string,
  to: string,
): boolean {
  switch (schedule.mode) {
    case 'unscheduled':
      return false
    case 'due-date':
      return from <= schedule.dueDate && schedule.dueDate <= to
    case 'date-range':
    case 'milestone':
      return schedule.startDate <= to && from <= schedule.endDate
  }
}

/**
 * Decides whether a canonical schedule passes a Team or Project list schedule filter.
 *
 * @param schedule - Canonical Work Item schedule.
 * @param filter - Schedule filter of the list request.
 * @returns Whether the Work Item belongs to the filtered list.
 */
export function matchesScopedWorkItemScheduleFilter(
  schedule: WorkItemSchedule,
  filter: ScopedWorkItemScheduleFilter,
): boolean {
  return filter.kind === 'unscheduled'
    ? schedule.mode === 'unscheduled'
    : workItemScheduleOverlapsWindow(schedule, filter.from, filter.to)
}
