import useSWR from 'swr'
import { getTeamWeeklyReportStatus, getWeeklyReport, listWeeklyReportHistory } from '../api/weeklyReports'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads one member's week: the latest submission and, for the author, the saved notes.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team the report belongs to.
 * @param memberKey - Author's member key, or undefined while unknown.
 * @param weekStart - First day of the week.
 * @returns SWR state of the report.
 */
export function useWeeklyReport(
  accessToken: string | undefined,
  teamId: string,
  memberKey: string | undefined,
  weekStart: string,
) {
  const key = accessToken && memberKey
    ? [timeTrackingQueryKeyRoot, 'weekly-report', accessToken, teamId, memberKey, weekStart] as const
    : null
  return useSWR(key, ([, , token, team, member, week]) => getWeeklyReport(token, team, member, week), timeTrackingQueryConfig)
}

/**
 * Loads one member's recent weeks, newest first.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team the reports belong to.
 * @param memberKey - Author's member key, or undefined while unknown.
 * @returns SWR state of the history.
 */
export function useWeeklyReportHistory(accessToken: string | undefined, teamId: string, memberKey: string | undefined) {
  const key = accessToken && memberKey
    ? [timeTrackingQueryKeyRoot, 'weekly-report-history', accessToken, teamId, memberKey] as const
    : null
  return useSWR(key, ([, , token, team, member]) => listWeeklyReportHistory(token, team, member), timeTrackingQueryConfig)
}

/**
 * Loads who submitted a report for a week among the members the manager may read.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team ID.
 * @param weekStart - First day of the week.
 * @returns SWR state of the Team status.
 */
export function useTeamWeeklyReportStatus(accessToken: string | undefined, teamId: string, weekStart: string) {
  const key = accessToken ? [timeTrackingQueryKeyRoot, 'team-weekly-reports', accessToken, teamId, weekStart] as const : null
  return useSWR(key, ([, , token, team, week]) => getTeamWeeklyReportStatus(token, team, week), timeTrackingQueryConfig)
}
