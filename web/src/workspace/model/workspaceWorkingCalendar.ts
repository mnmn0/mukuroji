import {
  WORKSPACE_CALENDAR_MAX_HOLIDAYS,
  WORKSPACE_CALENDAR_WEEKDAYS,
  isWorkspaceHolidayDate,
  type WorkspaceCalendarSettings,
  type WorkspaceCalendarWeekday,
} from '@mukuroji/contracts'

/**
 * Turns one Workspace working weekday on or off.
 *
 * @param calendar - Calendar settings being edited.
 * @param weekday - Weekday whose checkbox changed.
 * @param working - Whether the weekday is now a working day.
 * @returns The edited settings with Monday-first weekdays, or undefined when the change would
 *   leave the Workspace without any working weekday.
 */
export function setWorkspaceWorkingWeekday(
  calendar: WorkspaceCalendarSettings,
  weekday: WorkspaceCalendarWeekday,
  working: boolean,
): WorkspaceCalendarSettings | undefined {
  const workingWeekdays = WORKSPACE_CALENDAR_WEEKDAYS.filter((candidate) =>
    candidate === weekday ? working : calendar.workingWeekdays.includes(candidate))
  return workingWeekdays.length > 0 ? { ...calendar, workingWeekdays } : undefined
}

/**
 * Checks whether a drafted date can be added to the Workspace holidays.
 *
 * @param calendar - Calendar settings being edited.
 * @param date - Value of the holiday date input.
 * @returns Whether the date is valid, not yet a holiday, and within the holiday limit.
 */
export function canAddWorkspaceHoliday(calendar: WorkspaceCalendarSettings, date: string): boolean {
  return isWorkspaceHolidayDate(date) &&
    !calendar.holidays.includes(date) &&
    calendar.holidays.length < WORKSPACE_CALENDAR_MAX_HOLIDAYS
}

/**
 * Adds one date to the Workspace holidays, keeping them sorted.
 *
 * @param calendar - Calendar settings being edited.
 * @param date - Holiday to add.
 * @returns The edited settings, or undefined when {@link canAddWorkspaceHoliday} rejects the date.
 */
export function addWorkspaceHoliday(
  calendar: WorkspaceCalendarSettings,
  date: string,
): WorkspaceCalendarSettings | undefined {
  if (!canAddWorkspaceHoliday(calendar, date)) return undefined
  return { ...calendar, holidays: [...calendar.holidays, date].sort() }
}

/**
 * Removes one date from the Workspace holidays.
 *
 * @param calendar - Calendar settings being edited.
 * @param date - Holiday to remove.
 * @returns The edited settings.
 */
export function removeWorkspaceHoliday(
  calendar: WorkspaceCalendarSettings,
  date: string,
): WorkspaceCalendarSettings {
  return { ...calendar, holidays: calendar.holidays.filter((holiday) => holiday !== date) }
}
