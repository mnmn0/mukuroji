import type { WeeklyReportReminderSettings, WorkspaceWeekStartDay } from '@mukuroji/contracts'
import type { WeeklyReportTeamRoster } from '../weekly-report-reminders'

/** The Workspace settings that decide when reminders go out and which week they are about. */
export type WeeklyReportWorkspaceSettings = {
  /** Day the Workspace week starts on. */
  weekStartDay: WorkspaceWeekStartDay
  /** Whether and when reminders and escalations go out. */
  reminders: WeeklyReportReminderSettings
}

/** Reads what weekly report reminders are built from. */
export type ScheduledWeeklyReportReader = {
  /**
   * Reads the Workspace week start day and reminder settings.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @returns The settings; the defaults for a Workspace that has not saved its own.
   */
  readWorkspaceSettings(workspaceId: string): Promise<WeeklyReportWorkspaceSettings>
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
