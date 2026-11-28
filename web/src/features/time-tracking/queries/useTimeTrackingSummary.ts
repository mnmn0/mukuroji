import useSWR from 'swr'
import { getTimeTrackingSummary, type TimeReportInput } from '../api/timeReport'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads a Team's grouped time report.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose entries are summarized.
 * @param input - Period, timezone, grouping, and budget scope.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the report.
 */
export function useTimeTrackingSummary(
  accessToken: string | undefined,
  teamId: string | undefined,
  input: TimeReportInput,
  enabled = true,
) {
  const scope = input.budgetScope
  const key = accessToken && teamId && enabled
    ? [
      timeTrackingQueryKeyRoot,
      'summary',
      accessToken,
      teamId,
      input.from,
      input.to,
      input.timeZone,
      input.groupBy,
      scope?.scopeType ?? '',
      scope?.scopeType === 'project' ? scope.projectId : '',
      input.filterProjectId ?? '',
    ] as const
    : null
  return useSWR(
    key,
    ([, , token, team]) => getTimeTrackingSummary(token, team, input),
    timeTrackingQueryConfig,
  )
}
