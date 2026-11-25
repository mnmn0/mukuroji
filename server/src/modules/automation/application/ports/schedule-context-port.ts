import type { RecurringWorkCalendar } from '../../domain/recurring-schedule'

/** One open Work Item a due-soon schedule rule runs for. */
export type AutomationDueWorkItem = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item identifier within the Team. */
  workItemId: string
  /** Canonical `YYYY-MM-DD` due date. */
  dueDate: string
}

/** Lists the open Work Items a due-soon schedule rule runs for. */
export interface AutomationDueWorkItemSource {
  /**
   * Lists the Workspace's open, unarchived Work Items due on one date.
   *
   * @param workspaceId - Workspace that owns the rule.
   * @param dueDate - `YYYY-MM-DD` due date.
   * @returns Every matching Work Item, in no particular order.
   */
  listOpenWorkItemsDueOn(workspaceId: string, dueDate: string): Promise<AutomationDueWorkItem[]>
}

/** Reads the work calendar a `business-day` Recurring Work counts on. */
export interface AutomationWorkCalendarSource {
  /**
   * Reads a Team's effective work calendar.
   *
   * @param workspaceId - Workspace that owns the Team.
   * @param teamId - Team that owns the Recurring Work.
   * @returns Working weekdays and holidays.
   */
  readTeamWorkCalendar(workspaceId: string, teamId: string): Promise<RecurringWorkCalendar>
}
