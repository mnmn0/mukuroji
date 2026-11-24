import type { AutomationExecution } from '@mukuroji/contracts'
import { getAutomationExecutions } from '../api'

/** Number of Team-owned runs the Team settings view collects. */
const OWNED_EXECUTION_LIMIT = 50
/** Upper bound of execution pages read to collect one Team's runs. */
const OWNED_EXECUTION_MAX_PAGES = 10

/**
 * Collects the latest runs of one Team's definitions by following the Workspace execution cursor,
 * because the execution list is paginated before any owner filter could apply (ADR 0087).
 *
 * @param accessToken - Automation API access token.
 * @param ownerTeamId - Team whose runs are collected.
 * @returns Up to {@link OWNED_EXECUTION_LIMIT} runs owned by the Team, newest first.
 */
export async function loadOwnedAutomationExecutions(
  accessToken: string,
  ownerTeamId: string,
): Promise<AutomationExecution[]> {
  const owned: AutomationExecution[] = []
  let cursor: string | undefined
  for (let page = 0; page < OWNED_EXECUTION_MAX_PAGES; page += 1) {
    const result = await getAutomationExecutions(accessToken, cursor ? { cursor } : {})
    owned.push(...result.executions.filter((execution) => execution.ownerTeamId === ownerTeamId))
    if (owned.length >= OWNED_EXECUTION_LIMIT || !result.nextCursor) break
    cursor = result.nextCursor
  }
  return owned.slice(0, OWNED_EXECUTION_LIMIT)
}
