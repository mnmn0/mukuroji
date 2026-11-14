import {
  WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT,
  type WorkspaceWorkItemListFilter,
} from '@mukuroji/contracts'
import { getWorkspaceWorkItemPage, type TeamIssue } from '../api/workItems'
import { loadAllWorkItemPages } from './workItemPageLoader'

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
  return loadAllWorkItemPages(
    (cursor) => getWorkspaceWorkItemPage(accessToken, {
      includeArchived,
      filter,
      limit: WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT,
      ...(cursor ? { cursor } : {}),
    }),
    (page) => page.workItems,
  )
}
