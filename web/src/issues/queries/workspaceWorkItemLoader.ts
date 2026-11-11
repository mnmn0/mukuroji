import {
  WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT,
  type WorkspaceWorkItemListFilter,
} from '@mukuroji/contracts'
import { TeamIssuesApiError } from '../api/errors'
import { getWorkspaceWorkItemPage, type TeamIssue } from '../api/workItems'

/**
 * Largest number of Work Items one complete Workspace read keeps.
 *
 * Beyond it the read fails with `WorkItemListLimitExceeded` instead of showing a silently
 * truncated list.
 */
const WORKSPACE_WORK_ITEM_MAX_ITEMS = 10_000

/**
 * Safety limit on followed pages.
 *
 * A selective filter can return empty pages with a cursor, because the server evaluates at
 * most 2,000 rows per request, so the item limit above is what bounds the result. This limit
 * only stops a read that never ends.
 */
const WORKSPACE_WORK_ITEM_MAX_PAGES = 500

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
    if (workItems.length > WORKSPACE_WORK_ITEM_MAX_ITEMS) {
      throw new TeamIssuesApiError(
        413,
        `More than ${WORKSPACE_WORK_ITEM_MAX_ITEMS} Work Items match this view.`,
        'WorkItemListLimitExceeded',
      )
    }
    if (!response.nextCursor) return workItems
    if (response.nextCursor === cursor) throw createWorkItemListStalledError()
    cursor = response.nextCursor
  }

  throw createWorkItemListStalledError()
}

/**
 * Creates the error for a cursor read that repeats its cursor or never ends.
 *
 * @returns The error shown instead of a partial Work Item list.
 */
function createWorkItemListStalledError() {
  return new TeamIssuesApiError(
    503,
    'The Work Item list did not finish loading.',
    'WorkItemListReadStalled',
  )
}
