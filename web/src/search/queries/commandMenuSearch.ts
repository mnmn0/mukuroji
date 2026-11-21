import type { WorkspaceSearchResponse } from '@mukuroji/contracts'
import { searchWorkspaceAcrossCursors } from '../api/search'
import {
  COMMAND_MENU_PROJECT_SLOTS,
  COMMAND_MENU_RESULT_LIMIT,
  mergeCommandMenuSearchResults,
} from '../model/commandMenuResults'

/**
 * Searches the Workspace for the command menu so one query can open both Work Items and Projects.
 *
 * The Workspace-wide search reads Work Items before Projects, so a short keyword that matches
 * many Work Item titles would fill every slot before any Project. A second Project-only search
 * runs in parallel and up to four of its matches are kept at the end of the list. When only the
 * Project search fails, the Workspace-wide results are still returned.
 *
 * @param accessToken - Access token of the signed-in user.
 * @param keyword - Trimmed keyword typed into the command menu.
 * @param options - Optional AbortSignal that cancels both searches.
 * @returns Up to 12 permitted results in API order, followed by Projects the page did not reach.
 */
export async function searchWorkspaceForCommandMenu(
  accessToken: string,
  keyword: string,
  options: {
    /**
     * requestを中断するAbortSignalです。
     */
    signal?: AbortSignal
  } = {},
): Promise<WorkspaceSearchResponse> {
  const [workspaceSearch, projectSearch] = await Promise.allSettled([
    searchWorkspaceAcrossCursors(accessToken, { keyword }, {
      pageLimit: 5,
      resultLimit: COMMAND_MENU_RESULT_LIMIT,
      signal: options.signal,
    }),
    searchWorkspaceAcrossCursors(accessToken, { keyword, entityTypes: ['project'] }, {
      pageLimit: 2,
      resultLimit: COMMAND_MENU_PROJECT_SLOTS,
      signal: options.signal,
    }),
  ])
  if (workspaceSearch.status === 'rejected') {
    throw workspaceSearch.reason
  }

  return {
    ...workspaceSearch.value,
    results: mergeCommandMenuSearchResults(
      workspaceSearch.value.results,
      projectSearch.status === 'fulfilled' ? projectSearch.value.results : [],
    ),
  }
}
