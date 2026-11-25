import type { AutomationExecution } from '@mukuroji/contracts'
import { getAutomationExecutions } from '../api'

/** Number of Team-owned runs after which one search stops reading pages. */
const OWNED_EXECUTION_LIMIT = 50
/** Upper bound of execution pages read in one search for one Team's runs. */
const OWNED_EXECUTION_MAX_PAGES = 10

/** One search of the Workspace execution history for a Team's runs. */
export type OwnedAutomationExecutionPage = {
  /** Runs owned by the Team, newest first. */
  executions: AutomationExecution[]
  /** Cursor where the next search continues, present while older history remains unsearched. */
  nextCursor?: string
}

/**
 * Collects the latest runs of one Team's definitions by following the Workspace execution cursor,
 * because the execution list is paginated before any owner filter could apply (ADR 0087).
 *
 * @param accessToken - Automation API access token.
 * @param ownerTeamId - Team whose runs are collected.
 * @param startCursor - Cursor returned by the previous search, to continue into older history.
 * @returns The Team's runs from whole pages until at least {@link OWNED_EXECUTION_LIMIT} are found,
 *   and the cursor to continue when the search stopped before the end of the history.
 */
export async function loadOwnedAutomationExecutions(
  accessToken: string,
  ownerTeamId: string,
  startCursor?: string,
): Promise<OwnedAutomationExecutionPage> {
  const owned: AutomationExecution[] = []
  let cursor = startCursor
  for (let page = 0; page < OWNED_EXECUTION_MAX_PAGES; page += 1) {
    const result = await getAutomationExecutions(accessToken, cursor ? { cursor } : {})
    owned.push(...result.executions.filter((execution) => execution.ownerTeamId === ownerTeamId))
    cursor = result.nextCursor
    // A whole page is kept, so the next search starts exactly where this one stopped.
    if (!cursor || owned.length >= OWNED_EXECUTION_LIMIT) break
  }
  return cursor ? { executions: owned, nextCursor: cursor } : { executions: owned }
}
