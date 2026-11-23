import { PORTFOLIO_WORKSPACE_TEAM_LIMIT } from '@mukuroji/contracts'
import useSWR from 'swr'
import { getTeamAgentRunBoard } from '../../../work-items/api/agentRuns'
import { getTeamPortfolio, getTeamPortfolioSnapshot } from '../api/portfolio'
import type {
  PortfolioDashboardReads,
  TeamPortfolioRead,
  TeamPortfolioSnapshotRead,
} from '../model/portfolioDashboard'

/** Team reads in flight at once. */
const TEAM_READ_CONCURRENCY = 6

/**
 * Runs an async mapping a few items at a time, keeping the input order.
 *
 * @param items - Inputs.
 * @param map - Async mapping.
 * @returns Outputs in input order.
 */
async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  map: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = []
  for (let offset = 0; offset < items.length; offset += TEAM_READ_CONCURRENCY) {
    results.push(...await Promise.all(items.slice(offset, offset + TEAM_READ_CONCURRENCY).map(map)))
  }
  return results
}

/**
 * Reads the live portfolio of every Team, each Team on its own, so one failed Team does not
 * hide the others. With more Teams than {@link PORTFOLIO_WORKSPACE_TEAM_LIMIT}, nothing is read.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamIds - Teams to read, in directory order.
 * @param timeZone - IANA timezone of budget periods.
 * @param includeAgentRuns - Whether to read each Team's Factory board.
 * @returns SWR state of the reads.
 */
export function usePortfolioDashboard(
  accessToken: string | undefined,
  teamIds: readonly string[],
  timeZone: string,
  includeAgentRuns: boolean,
) {
  return useSWR(
    accessToken ? ['portfolio-dashboard', accessToken, teamIds.join('\n'), timeZone, includeAgentRuns] as const : null,
    async ([, token]): Promise<PortfolioDashboardReads> => {
      if (teamIds.length > PORTFOLIO_WORKSPACE_TEAM_LIMIT) return { tooManyTeams: true, teams: [] }
      const teams = await mapWithConcurrency(teamIds, async (teamId): Promise<TeamPortfolioRead> => {
        const [portfolio, agentBoard] = await Promise.all([
          getTeamPortfolio(token, teamId, timeZone).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          ),
          includeAgentRuns
            ? getTeamAgentRunBoard(token, teamId).then(
                (value) => ({ value }),
                (error: unknown) => ({ failed: true, error }),
              )
            : Promise.resolve(undefined),
        ])
        return {
          teamId,
          ...('value' in portfolio ? { portfolio: portfolio.value } : { error: portfolio.error }),
          ...(agentBoard && 'value' in agentBoard ? { agentBoard: agentBoard.value } : {}),
          agentBoardFailed: agentBoard !== undefined && 'failed' in agentBoard,
          ...(agentBoard && 'error' in agentBoard ? { agentBoardError: agentBoard.error } : {}),
        }
      })
      return { tooManyTeams: false, teams }
    },
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )
}

/**
 * Reads every Team's saved snapshot of one month.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamIds - Teams to read.
 * @param month - Month as `YYYY-MM`; reading is skipped without it.
 * @returns SWR state of the reads.
 */
export function usePortfolioSnapshots(
  accessToken: string | undefined,
  teamIds: readonly string[],
  month: string | undefined,
) {
  return useSWR(
    accessToken && month && teamIds.length <= PORTFOLIO_WORKSPACE_TEAM_LIMIT
      ? ['portfolio-snapshots', accessToken, teamIds.join('\n'), month] as const
      : null,
    async ([, token, , currentMonth]): Promise<TeamPortfolioSnapshotRead[]> =>
      await mapWithConcurrency(teamIds, async (teamId) => {
        try {
          const { snapshot } = await getTeamPortfolioSnapshot(token, teamId, currentMonth)
          return { teamId, snapshot, failed: false }
        } catch (error) {
          return { teamId, failed: true, error }
        }
      }),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )
}
