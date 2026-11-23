import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  createWorkspaceWorkItemCalendarPolicy,
  type WorkItemScheduleCalendarPolicy,
  type WorkspaceCalendarSettings,
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

/**
 * Reads the full Workspace calendar that workload profiles inheriting it are counted against.
 *
 * Unlike {@link readWorkspaceWorkItemCalendarPolicy}, which keeps at most the number of holidays a
 * persisted Work Item schedule can hold (chosen around today), this keeps every company holiday and
 * every national holiday, because a workload range may lie anywhere and must not change as today
 * moves. The policy is only used in memory and never stored.
 *
 * @param directoryId - Workspace directory whose calendar is read.
 * @returns The Workspace time zone, working weekdays, and every day off.
 */
export async function readWorkspaceWorkloadCalendarPolicy(
  directoryId: string,
): Promise<WorkItemScheduleCalendarPolicy> {
  const profile = await workspaceDependencies.tenantAdministration.getProfile(directoryId)
  const settings = profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS
  const nationalHolidays = settings.publicHolidays === 'japan'
    ? await workspaceDependencies.nationalHolidays.listDates()
    : []
  return {
    timeZone: settings.timeZone,
    workingWeekdays: [...settings.workingWeekdays],
    holidays: [...new Set([...settings.holidays, ...nationalHolidays])].sort(),
  }
}

/**
 * Reads a Workspace's calendar settings, which decide its week start and fiscal year start.
 *
 * A Workspace that has not saved calendar settings gets the defaults; any other read failure
 * propagates so a stored week start is never silently replaced.
 *
 * @param directoryId - Workspace directory to read.
 * @returns The stored settings, or the defaults.
 */
export async function readWorkspaceCalendarSettingsOf(
  directoryId: string,
): Promise<WorkspaceCalendarSettings> {
  const profile = await workspaceDependencies.tenantAdministration.getProfile(directoryId)
  return profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS
}
