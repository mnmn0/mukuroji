import type { WorkspaceWeekStartDay } from '@mukuroji/contracts'
import type { WeeklyReportTeamRoster } from '../weekly-report-reminders'

/** Reads what weekly report reminders are built from. */
export type ScheduledWeeklyReportReader = {
  /**
   * Reads the day the Workspace week starts on, which decides the week a reminder is about.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @returns The week start day; the default for a Workspace without calendar settings.
   */
  readWeekStartDay(workspaceId: string): Promise<WorkspaceWeekStartDay>
  /**
   * Lists the Teams of a Workspace with the members expected to write weekly reports.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @returns One roster per Team with an active Project.
   */
  readTeamRosters(workspaceId: string): Promise<WeeklyReportTeamRoster[]>
  /**
   * Tells which members have submitted a week.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @param teamId - Team ID.
   * @param memberKeys - Lower-case member keys.
   * @param weekStart - First day of the week.
   * @returns The members with at least one submitted version of that week.
   */
  readSubmittedMembers(
    workspaceId: string,
    teamId: string,
    memberKeys: readonly string[],
    weekStart: string,
  ): Promise<Set<string>>
}
