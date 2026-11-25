import useSWR from 'swr'
import { getProjectBudgetReport, type ProjectBudgetReportInput } from '../api/projectBudgetReport'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads the budget against actual report and earned value figures of one Project.
 *
 * The key sits under the time tracking root, so saving a budget or time refreshes it too.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param input - Range, timezone, and bucket.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the report.
 */
export function useProjectBudgetReport(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string | undefined,
  input: ProjectBudgetReportInput,
  enabled = true,
) {
  const key = accessToken && teamId && projectId && enabled
    ? [timeTrackingQueryKeyRoot, 'project-budget-report', accessToken, teamId, projectId, input.from, input.to, input.timeZone, input.interval] as const
    : null
  return useSWR(
    key,
    ([, , token, team, project]) => getProjectBudgetReport(token, team, project, input),
    timeTrackingQueryConfig,
  )
}
