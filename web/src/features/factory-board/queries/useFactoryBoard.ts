import type { AgentRunHistoryFilters } from '@mukuroji/contracts'
import useSWR from 'swr'
import { getTeamAgentRunBoard, getTeamAgentRunHistory, getTeamFactoryAnalytics, listWorkItemAgentRunReports } from '../../../work-items/api/agentRuns'
import { WorkItemConfigurationApiError } from '../../../work-items/api/errors'
import { createFactoryAnalyticsPeriod, type FactoryAnalyticsPeriodDays } from '../model/factoryAnalytics'
import { createRunHistoryPeriod, mergeRunHistories, type RunHistory, type RunHistoryPeriodDays } from '../model/runHistory'

/**
 * Interval for reading the board again while it stays open. Each read evaluates many runs and Work
 * Items, so it is slower than the single Work Item's run panel; focus and the refresh action read it
 * at once.
 */
const factoryBoardRefreshInterval = 60_000

/** Interval for reading the selected Work Item's reports again while its detail stays open. */
const factoryBoardReportsRefreshInterval = 30_000

/**
 * Reads a Team's Factory board, again when the window regains focus and at a slow interval. There is
 * no realtime delivery. Previous data is kept while the access token rotates; callers mount one
 * instance per Team so a board never stays visible under another Team.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team ID; reading is skipped without it.
 * @returns SWR state of the board.
 */
export function useTeamAgentRunBoard(accessToken: string | undefined, teamId: string | undefined) {
  return useSWR(
    accessToken && teamId ? ['factory-board', accessToken, teamId] as const : null,
    ([, token, currentTeamId]) => getTeamAgentRunBoard(token, currentTeamId),
    {
      dedupingInterval: 10_000,
      keepPreviousData: true,
      refreshInterval: factoryBoardRefreshInterval,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}

/**
 * Reads the structured reports of the Work Item selected on the board.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team ID; reading is skipped without it.
 * @param workItemId - Selected Work Item; reading is skipped without one.
 * @returns SWR state of the reports.
 */
export function useFactoryBoardReports(
  accessToken: string | undefined,
  teamId: string | undefined,
  workItemId: string | undefined,
) {
  return useSWR(
    accessToken && teamId && workItemId ? ['factory-board-reports', accessToken, teamId, workItemId] as const : null,
    ([, token, currentTeamId, currentWorkItemId]) => listWorkItemAgentRunReports(token, currentTeamId, currentWorkItemId),
    {
      dedupingInterval: 10_000,
      refreshInterval: factoryBoardReportsRefreshInterval,
      shouldRetryOnError: false,
    },
  )
}

/**
 * Reads a Team's Factory analytics for the period that ends at read time. The key holds the period
 * length rather than its bounds, so the period moves forward on each read instead of changing the key
 * on every render.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team ID; reading is skipped without it.
 * @param days - Period length in days.
 * @returns SWR state of the analytics.
 */
export function useFactoryAnalytics(accessToken: string | undefined, teamId: string | undefined, days: FactoryAnalyticsPeriodDays) {
  return useSWR(
    accessToken && teamId ? ['factory-analytics', accessToken, teamId, days] as const : null,
    ([, token, currentTeamId, currentDays]) =>
      getTeamFactoryAnalytics(token, currentTeamId, createFactoryAnalyticsPeriod(currentDays, new Date())),
    {
      dedupingInterval: 60_000,
      // Another period's numbers are never shown under the newly selected period.
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

/**
 * Reads the Run history of several Teams for the period that ends now and merges it, newest finish
 * first. The Teams are read in parallel. A Team whose history the viewer may not read (403) is left
 * out and named in the result; any other failure fails the whole read, so the list never looks
 * shorter than it is.
 *
 * @param accessToken - Session access token.
 * @param teamIds - Teams to read.
 * @param days - Period length in days.
 * @param filters - Filters every Team applies.
 * @param teamNames - Display names by Team ID.
 * @returns The merged history.
 */
export async function readAgentRunHistories(
  accessToken: string,
  teamIds: readonly string[],
  days: RunHistoryPeriodDays,
  filters: AgentRunHistoryFilters,
  teamNames: Readonly<Record<string, string>>,
): Promise<RunHistory> {
  const period = createRunHistoryPeriod(days, new Date())
  const deniedTeamIds = new Set<string>()
  const histories = await Promise.all(teamIds.map(async (teamId) => {
    try {
      return [await getTeamAgentRunHistory(accessToken, teamId, { ...period, ...filters })]
    } catch (error) {
      // Seeing a Team does not grant its Run history; that Team is left out instead of hiding the rest.
      if (error instanceof WorkItemConfigurationApiError && error.status === 403) {
        deniedTeamIds.add(teamId)
        return []
      }
      throw error
    }
  }))
  return mergeRunHistories(histories.flat(), teamNames, teamIds.filter((teamId) => deniedTeamIds.has(teamId)))
}

/**
 * Reads the Run history of several Teams with {@link readAgentRunHistories}, keyed by its inputs.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamIds - Teams to read; reading is skipped when empty.
 * @param days - Period length in days.
 * @param filters - Filters every Team applies.
 * @param teamNames - Display names by Team ID.
 * @returns SWR state of the merged history.
 */
export function useAgentRunHistory(
  accessToken: string | undefined,
  teamIds: readonly string[],
  days: RunHistoryPeriodDays,
  filters: AgentRunHistoryFilters,
  teamNames: Readonly<Record<string, string>>,
) {
  return useSWR(
    accessToken && teamIds.length > 0 ? ['agent-run-history', accessToken, teamIds.join(','), days, JSON.stringify(filters)] as const : null,
    async ([, token]) => readAgentRunHistories(token, teamIds, days, filters, teamNames),
    {
      dedupingInterval: 30_000,
      keepPreviousData: false,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}
