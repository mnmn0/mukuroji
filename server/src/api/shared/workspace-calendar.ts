import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  createWorkspaceWorkItemCalendarPolicy,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import { workspaceDependencies } from './app-dependencies'

/**
 * Reads the calendar policy a Work Item created without one takes from its Workspace.
 *
 * It matches the policy the Web puts on a new Work Item: the Workspace time zone, working weekdays,
 * company holidays, and the national holidays when the Workspace uses them. The national holidays
 * come from the monthly Cabinet Office sync, or the bundled list before the first sync. A Workspace
 * that has not saved calendar settings gets the defaults; any other read failure propagates so a
 * stored calendar is never silently replaced.
 *
 * @param directoryId - Workspace directory that owns the new Work Item.
 * @returns A new calendar policy for that Workspace.
 */
export async function readWorkspaceWorkItemCalendarPolicy(
  directoryId: string,
): Promise<WorkItemScheduleCalendarPolicy> {
  const profile = await workspaceDependencies.tenantAdministration.getProfile(directoryId)
  const settings = profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS
  return createWorkspaceWorkItemCalendarPolicy(
    settings,
    settings.publicHolidays === 'japan'
      ? await workspaceDependencies.nationalHolidays.listDates()
      : undefined,
  )
}
