import {
  WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT,
  type WorkspaceWorkItemListFilter,
} from '@mukuroji/contracts'
import { TeamIssuesApiError } from '../api/errors'
import { getWorkspaceWorkItemPage, type TeamIssue } from '../api/workItems'

/**
 * Largest number of pages one complete Workspace Work Item read follows.
 *
 * With the maximum page size this allows 10,000 Work Items; beyond that the read fails
 * with `WorkItemListLimitExceeded` instead of showing a silently truncated list.
 */
const WORKSPACE_WORK_ITEM_MAX_PAGES = 50

/**
 * Loads every Workspace Work Item that matches the filter by following page cursors.
 *
 * The page request stays in the transport layer; this loader owns the complete-list policy
 * for the query that caches the result.
 *
 * @param accessToken - Bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @param filter - Server-side filter, such as `involvement: 'mine'` or a Team ID.
 * @returns Matching Work Items visible to the current viewer, including unassigned items.
 */
export async function loadWorkspaceWorkItems(
  accessToken: string,
  includeArchived = false,
  filter: WorkspaceWorkItemListFilter = {},
): Promise<TeamIssue[]> {
  const workItems: TeamIssue[] = []
  let cursor: string | undefined

  for (let page = 0; page < WORKSPACE_WORK_ITEM_MAX_PAGES; page += 1) {
    const response = await getWorkspaceWorkItemPage(accessToken, {
      includeArchived,
      filter,
      limit: WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT,
      ...(cursor ? { cursor } : {}),
    })
    workItems.push(...response.workItems)
    if (!response.nextCursor) return workItems
    cursor = response.nextCursor
  }

  throw new TeamIssuesApiError(
    413,
    `More than ${WORKSPACE_WORK_ITEM_MAX_PAGES * WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT} Work Items match this view.`,
    'WorkItemListLimitExceeded',
  )
}
