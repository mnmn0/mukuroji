import type { UnsubmittedTimeEntry } from '../timesheet-reminders'

/** Reads the time entries that timesheet submission reminders are built from. */
export type ScheduledTimesheetReader = {
  /**
   * Lists a Team's draft and rejected entries that overlap a period.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @param teamId - Team ID.
   * @param from - Inclusive start of the period.
   * @param to - Exclusive end of the period.
   * @returns Unsubmitted entries of every member of the Team.
   */
  listUnsubmittedEntries(
    workspaceId: string,
    teamId: string,
    from: Date,
    to: Date,
  ): Promise<UnsubmittedTimeEntry[]>
}
