import type { WorkspaceSearchResult } from '@mukuroji/contracts'

/** Maximum results the command menu shows for one query. */
export const COMMAND_MENU_RESULT_LIMIT = 12

/** Result slots the command menu keeps for Projects so Work Item title matches cannot crowd them out. */
export const COMMAND_MENU_PROJECT_SLOTS = 4

/**
 * Merges Workspace-wide and Project-only search results into the command menu order.
 *
 * The Workspace-wide results keep their API order, which already puts title matches first.
 * Project matches that the Workspace-wide page did not reach are appended after it, and the
 * fewest trailing Workspace-wide results are dropped to make room for them.
 *
 * @param workspaceResults - Results of the Workspace-wide search, in API order.
 * @param projectResults - Results of the Project-only search, in API order.
 * @returns Deduplicated results capped at {@link COMMAND_MENU_RESULT_LIMIT}.
 */
export function mergeCommandMenuSearchResults(
  workspaceResults: WorkspaceSearchResult[],
  projectResults: WorkspaceSearchResult[],
): WorkspaceSearchResult[] {
  const workspace = deduplicateSearchResults(workspaceResults)
  const projects = deduplicateSearchResults(projectResults).slice(0, COMMAND_MENU_PROJECT_SLOTS)
  for (let kept = Math.min(workspace.length, COMMAND_MENU_RESULT_LIMIT); kept >= 0; kept -= 1) {
    const shown = workspace.slice(0, kept)
    const shownKeys = new Set(shown.map(createSearchResultKey))
    const missingProjects = projects.filter((result) => !shownKeys.has(createSearchResultKey(result)))
    if (shown.length + missingProjects.length <= COMMAND_MENU_RESULT_LIMIT) {
      return [...shown, ...missingProjects]
    }
  }
  return projects
}

/**
 * Removes repeated search results while keeping the first occurrence of each.
 *
 * @param results - Search results in display order.
 * @returns Results without duplicates, in the same order.
 */
function deduplicateSearchResults(results: WorkspaceSearchResult[]) {
  const seenResults = new Set<string>()
  return results.filter((result) => {
    const resultKey = createSearchResultKey(result)
    if (seenResults.has(resultKey)) return false
    seenResults.add(resultKey)
    return true
  })
}

/**
 * Creates the identity of a search result across entity types and Teams.
 *
 * @param result - Search result.
 * @returns A key unique per entity type, Team and entity ID.
 */
function createSearchResultKey(result: WorkspaceSearchResult) {
  return `${result.entityType}:${result.teamId ?? ''}:${result.id}`
}
