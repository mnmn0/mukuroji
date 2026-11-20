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
 * company holidays, and the bundled national holidays when the Workspace uses them. A Workspace
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
  return createWorkspaceWorkItemCalendarPolicy(profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS)
}
