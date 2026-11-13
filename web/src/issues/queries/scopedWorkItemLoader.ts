import { SCOPED_WORK_ITEM_PAGE_MAX_LIMIT } from '@mukuroji/contracts'
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

/**
 * Loads every Work Item assigned to one Project by following page cursors.
 *
 * @param projectId - Project whose assigned Work Items should be loaded.
 * @param accessToken - Bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @returns The Work Items and the Customer impact capability of the last page.
 */
export async function loadProjectIssues(
  projectId: string,
  accessToken: string,
  includeArchived = false,
): Promise<ProjectIssueList> {
  let canReadCustomerImpact: boolean | undefined
  const issues = await loadAllWorkItemPages(
    (cursor) => getProjectIssuesPage(projectId, accessToken, {
      includeArchived,
      limit: SCOPED_WORK_ITEM_PAGE_MAX_LIMIT,
      ...(cursor ? { cursor } : {}),
    }),
    (page) => page.issues,
    (page) => {
      if (page.canReadCustomerImpact !== undefined) {
        canReadCustomerImpact = page.canReadCustomerImpact
      }
    },
  )
  return {
    projectId,
    issues,
    ...(canReadCustomerImpact === undefined ? {} : { canReadCustomerImpact }),
  }
}
