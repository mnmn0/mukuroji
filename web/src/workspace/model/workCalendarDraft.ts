import {
  WORKSPACE_CALENDAR_WEEKDAYS,
  WORK_CALENDAR_MAX_ADDITIONAL_HOLIDAYS,
  isWorkspaceHolidayDate,
  type WorkCalendarAdjustment,
  type WorkCalendarOverrides,
  type WorkCalendarResponse,
  type WorkspaceCalendarWeekday,
  type WorkspacePublicHolidayCalendar,
} from '@mukuroji/contracts'

/** National holiday choice of a Team or Project calendar form, including inheriting it. */
export type WorkCalendarPublicHolidayChoice = WorkspacePublicHolidayCalendar | 'inherit'

/** Form values of a Team or Project calendar. */
export type WorkCalendarDraft = {
  /** Whether the working weekdays come from the inherited calendar. */
  inheritWorkingWeekdays: boolean
  /** Working weekdays used when they are not inherited, Monday first. */
  workingWeekdays: WorkspaceCalendarWeekday[]
  /** National holiday choice. */
  publicHolidays: WorkCalendarPublicHolidayChoice
  /** Company days off added to the inherited ones, sorted. */
  additionalHolidays: string[]
  /** How Work Items that follow the calendar keep their dates. */
  adjustment: WorkCalendarAdjustment
}

/**
 * Creates the form values of a loaded calendar.
 *
 * @param response - Calendar read from the server.
 * @returns The form values; inherited weekdays start from the resolved ones.
 */
export function createWorkCalendarDraft(response: WorkCalendarResponse): WorkCalendarDraft {
  const calendar = response.calendar
  return {
    inheritWorkingWeekdays: calendar?.workingWeekdays === undefined,
    workingWeekdays: [...(calendar?.workingWeekdays ?? response.resolvedPolicy.workingWeekdays)],
    publicHolidays: calendar?.publicHolidays ?? 'inherit',
    additionalHolidays: [...(calendar?.additionalHolidays ?? [])],
    adjustment: response.changeAdjustment,
  }
}

/**
 * Builds the calendar rules a form saves.
 *
 * @param draft - Form values.
 * @returns The rules, leaving inherited fields out.
 */
export function toWorkCalendarOverrides(draft: WorkCalendarDraft): WorkCalendarOverrides {
  return {
    ...(draft.inheritWorkingWeekdays ? {} : { workingWeekdays: [...draft.workingWeekdays] }),
    ...(draft.publicHolidays === 'inherit' ? {} : { publicHolidays: draft.publicHolidays }),
    additionalHolidays: [...draft.additionalHolidays],
  }
}

/**
 * Turns one working weekday on or off, keeping at least one.
 *
 * @param draft - Form values.
 * @param weekday - Weekday whose checkbox changed.
 * @param checked - Whether the weekday is now a working day.
 * @returns The new form values, or undefined when the change would leave no working weekday.
 */
export function setWorkCalendarWeekday(
  draft: WorkCalendarDraft,
  weekday: WorkspaceCalendarWeekday,
  checked: boolean,
): WorkCalendarDraft | undefined {
  const next = WORKSPACE_CALENDAR_WEEKDAYS.filter((candidate) =>
    candidate === weekday ? checked : draft.workingWeekdays.includes(candidate))
  return next.length === 0 ? undefined : { ...draft, workingWeekdays: next }
}

/**
 * Reports whether a drafted date can be added to the days off.
 *
 * @param draft - Form values.
 * @param date - Drafted `YYYY-MM-DD` date.
 * @returns Whether the date is valid, new, and within the limit.
 */
export function canAddWorkCalendarHoliday(draft: WorkCalendarDraft, date: string): boolean {
  return isWorkspaceHolidayDate(date) &&
    !draft.additionalHolidays.includes(date) &&
    draft.additionalHolidays.length < WORK_CALENDAR_MAX_ADDITIONAL_HOLIDAYS
}

/**
 * Adds a day off.
 *
 * @param draft - Form values.
 * @param date - Date to add.
 * @returns The new form values, or undefined when the date cannot be added.
 */
export function addWorkCalendarHoliday(draft: WorkCalendarDraft, date: string): WorkCalendarDraft | undefined {
  if (!canAddWorkCalendarHoliday(draft, date)) return undefined
  return { ...draft, additionalHolidays: [...draft.additionalHolidays, date].sort() }
}

/**
 * Removes a day off.
 *
 * @param draft - Form values.
 * @param date - Date to remove.
 * @returns The new form values.
 */
export function removeWorkCalendarHoliday(draft: WorkCalendarDraft, date: string): WorkCalendarDraft {
  return { ...draft, additionalHolidays: draft.additionalHolidays.filter((holiday) => holiday !== date) }
}
