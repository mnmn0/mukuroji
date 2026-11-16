import {
  SCOPED_WORK_ITEM_PAGE_MAX_LIMIT,
  type ScopedWorkItemScheduleFilter,
} from '@mukuroji/contracts'
import {
  getProjectIssuesPage,
  getTeamIssuesPage,
  type TeamIssue,
} from '../api/workItems'
import { loadAllWorkItemPages } from './workItemPageLoader'

/** Complete Work Item list of one Project together with its resource capability. */
export type ProjectIssueList = {
  /** Project whose assigned Work Items were read. */
  projectId: string
  /** Every Work Item assigned to the Project that the viewer can read, in sort order. */
  issues: TeamIssue[]
  /** Whether Customer impact may be requested for this Project resource. */
  canReadCustomerImpact?: boolean
}

/**
 * Loads every Work Item of one Team by following page cursors.
 *
 * @param teamId - Team whose Work Items should be loaded.
 * @param accessToken - Bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @returns Team-owned Work Items visible to the current viewer, in the Team's sort order.
 */
export async function loadTeamIssues(
  teamId: string,
  accessToken: string,
  includeArchived = false,
): Promise<TeamIssue[]> {
  return loadAllWorkItemPages(
    (cursor) => getTeamIssuesPage(teamId, accessToken, {
      includeArchived,
      limit: SCOPED_WORK_ITEM_PAGE_MAX_LIMIT,
      ...(cursor ? { cursor } : {}),
    }),
    (page) => page.issues,
  )
}

/** Inclusive local date window of a windowed Project read. */
export type ProjectIssueScheduleWindow = {
  /** Inclusive first local date in `YYYY-MM-DD` form. */
  from: string
  /** Inclusive last local date in `YYYY-MM-DD` form. */
  to: string
}

/**
 * Loads the Work Items assigned to one Project by following page cursors.
 *
 * Without `scheduleWindow`, every Work Item of the Project is read. With it, only the Work
 * Items whose schedule touches the window are read, together with the unscheduled Work Items
 * in a second cursor read, so a calendar or Gantt never reads the rest of the Project. Each of
 * the two reads has its own item limit.
 *
 * @param projectId - Project whose assigned Work Items should be loaded.
 * @param accessToken - Bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @param scheduleWindow - Optional visible period of a calendar or Gantt.
 * @returns The Work Items and the Customer impact capability of the last page.
 */
export async function loadProjectIssues(
  projectId: string,
  accessToken: string,
  includeArchived = false,
  scheduleWindow?: ProjectIssueScheduleWindow,
): Promise<ProjectIssueList> {
  let canReadCustomerImpact: boolean | undefined
  /** Reads every page of one Project list filter. */
  const loadFilteredIssues = (scheduleFilter?: ScopedWorkItemScheduleFilter) => loadAllWorkItemPages(
    (cursor) => getProjectIssuesPage(projectId, accessToken, {
      includeArchived,
      limit: SCOPED_WORK_ITEM_PAGE_MAX_LIMIT,
      ...(scheduleFilter ? { scheduleFilter } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    (page) => page.issues,
    (page) => {
      if (page.canReadCustomerImpact !== undefined) {
        canReadCustomerImpact = page.canReadCustomerImpact
      }
    },
  )
  const issues = scheduleWindow
    ? mergeProjectIssueReads(await Promise.all([
        loadFilteredIssues({ kind: 'window', from: scheduleWindow.from, to: scheduleWindow.to }),
        loadFilteredIssues({ kind: 'unscheduled' }),
      ]))
    : await loadFilteredIssues()
  return {
    projectId,
    issues,
    ...(canReadCustomerImpact === undefined ? {} : { canReadCustomerImpact }),
  }
}

/**
 * Joins the windowed and unscheduled reads, keeping each Work Item once.
 *
 * A schedule change while the two reads run can return one Work Item from both, and the reads
 * finish in either order. The copy with the higher revision wins at the first position, so an
 * item scheduled meanwhile never returns to the unscheduled bucket with a stale revision.
 *
 * @param reads - Work Items of each read, in read order.
 * @returns Distinct Work Items in first-seen order, each at its newest revision.
 */
function mergeProjectIssueReads(reads: readonly (readonly TeamIssue[])[]): TeamIssue[] {
  const issuesByKey = new Map<string, TeamIssue>()
  for (const issue of reads.flat()) {
    const key = `${issue.teamId}\u0000${issue.id}`
    const current = issuesByKey.get(key)
    if (!current || issue.revision > current.revision) issuesByKey.set(key, issue)
  }
  return [...issuesByKey.values()]
}
