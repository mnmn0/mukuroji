/**
 * IANA time zone that decides the Workspace's local calendar date ("today").
 *
 * The Workspace is used in Japan, so due dates, overdue checks, request-form deadlines, and the
 * Gantt and Calendar "today" all follow Japan time instead of UTC.
 */
export const DEFAULT_WORKSPACE_TIME_ZONE = 'Asia/Tokyo'

/** Cached `YYYY-MM-DD` formatters keyed by IANA time zone. */
const workspaceDateFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Maps an instant to the local calendar date of a time zone.
 *
 * @param instant - Instant to map, as a Date, epoch milliseconds, or an ISO timestamp.
 * @param timeZone - IANA time zone; defaults to {@link DEFAULT_WORKSPACE_TIME_ZONE}.
 * @returns The local date in `YYYY-MM-DD` form.
 * @throws RangeError When the instant or the time zone is invalid.
 */
export function toWorkspaceLocalDate(
  instant: Date | number | string,
  timeZone: string = DEFAULT_WORKSPACE_TIME_ZONE,
): string {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('Workspace calendar instant must be a valid date.')
  }
  const parts = readWorkspaceDateFormatter(timeZone).formatToParts(date)
  const year = readWorkspaceDatePart(parts, 'year')
  const month = readWorkspaceDatePart(parts, 'month')
  const day = readWorkspaceDatePart(parts, 'day')
  return `${year.padStart(4, '0')}-${month}-${day}`
}

/**
 * Returns a cached ISO-calendar date formatter for a time zone.
 *
 * @param timeZone - IANA time zone.
 * @returns A formatter producing Latin-digit year, month, and day parts.
 */
function readWorkspaceDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = workspaceDateFormatters.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  })
  workspaceDateFormatters.set(timeZone, formatter)
  return formatter
}

/**
 * Reads one required part from formatted date parts.
 *
 * @param parts - Parts produced by {@link readWorkspaceDateFormatter}.
 * @param type - Part to read.
 * @returns The part's text.
 * @throws RangeError When the runtime omits the part.
 */
function readWorkspaceDatePart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: 'day' | 'month' | 'year',
): string {
  const value = parts.find((part) => part.type === type)?.value
  if (!value) throw new RangeError(`Workspace calendar date is missing its ${type}.`)
  return value
}

/** Day a Workspace week starts on, as `Date#getDay()` numbers it: 0 is Sunday, 1 is Monday. */
export type WorkspaceWeekStartDay = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Weekday names of the Workspace working calendar, shared with Work Item calendar policies. */
export type WorkspaceCalendarWeekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

/** Every weekday in the order the Workspace calendar stores and shows them, Monday first. */
export const WORKSPACE_CALENDAR_WEEKDAYS: readonly WorkspaceCalendarWeekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]

/** Largest number of holidays a Workspace calendar keeps, the same limit as a Work Item schedule. */
export const WORKSPACE_CALENDAR_MAX_HOLIDAYS = 512

/** Earliest year accepted for a Workspace holiday; Work Item schedules accept these dates too. */
const WORKSPACE_CALENDAR_MIN_HOLIDAY_YEAR = 1970

/** Workspace-wide calendar settings that decide fiscal years, weeks, and working days. */
export type WorkspaceCalendarSettings = {
  /** First month of the fiscal year, from 1 (January) to 12 (December). */
  fiscalYearStartMonth: number
  /** Day each Workspace week starts on. */
  weekStartDay: WorkspaceWeekStartDay
  /** Weekdays the whole Workspace works on, in Monday-first order without duplicates. */
  workingWeekdays: WorkspaceCalendarWeekday[]
  /** Company holidays as local `YYYY-MM-DD` dates, sorted ascending without duplicates. */
  holidays: string[]
}

/**
 * Calendar settings of a Workspace that has not chosen its own.
 *
 * They keep the behavior from before the settings existed: calendar-year fiscal years,
 * Monday-based weeks, and Monday-to-Friday working days without holidays, as the timesheet,
 * capacity planning, and new Work Item schedules already use.
 */
export const DEFAULT_WORKSPACE_CALENDAR_SETTINGS: WorkspaceCalendarSettings = {
  fiscalYearStartMonth: 1,
  weekStartDay: 1,
  workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  holidays: [],
}

/**
 * Narrows an untrusted value to a week start day.
 *
 * @param value - Untrusted candidate.
 * @returns Whether the value is an integer from 0 (Sunday) to 6 (Saturday).
 */
export function isWorkspaceWeekStartDay(value: unknown): value is WorkspaceWeekStartDay {
  return value === 0 || value === 1 || value === 2 || value === 3 ||
    value === 4 || value === 5 || value === 6
}

/**
 * Reads untrusted Workspace calendar settings.
 *
 * Settings stored before working days existed carry only the fiscal year and week start, so a
 * missing `workingWeekdays` reads as Monday to Friday and missing `holidays` as none. Weekdays come
 * back in Monday-first order and holidays sorted, both without duplicates.
 *
 * @param value - Untrusted candidate, such as a request body field or a stored record.
 * @returns Settings built from the value, or undefined when any field is invalid.
 */
export function readWorkspaceCalendarSettings(value: unknown): WorkspaceCalendarSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fiscalYearStartMonth: unknown = Reflect.get(value, 'fiscalYearStartMonth')
  const weekStartDay: unknown = Reflect.get(value, 'weekStartDay')
  if (
    typeof fiscalYearStartMonth !== 'number' ||
    !Number.isInteger(fiscalYearStartMonth) ||
    fiscalYearStartMonth < 1 ||
    fiscalYearStartMonth > 12 ||
    !isWorkspaceWeekStartDay(weekStartDay)
  ) {
    return undefined
  }
  const workingWeekdays = readWorkspaceWorkingWeekdays(Reflect.get(value, 'workingWeekdays'))
  const holidays = readWorkspaceHolidays(Reflect.get(value, 'holidays'))
  if (!workingWeekdays || !holidays) return undefined
  return { fiscalYearStartMonth, weekStartDay, workingWeekdays, holidays }
}

/**
 * Narrows an untrusted value to a Workspace calendar weekday name.
 *
 * @param value - Untrusted candidate.
 * @returns Whether the value names a weekday.
 */
export function isWorkspaceCalendarWeekday(value: unknown): value is WorkspaceCalendarWeekday {
  return WORKSPACE_CALENDAR_WEEKDAYS.some((weekday) => weekday === value)
}

/**
 * Checks whether a value is a real `YYYY-MM-DD` date a Workspace holiday may fall on.
 *
 * @param value - Untrusted candidate.
 * @returns Whether the value is a valid calendar date from 1970 onward.
 */
export function isWorkspaceHolidayDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number(value.slice(0, 4)) >= WORKSPACE_CALENDAR_MIN_HOLIDAY_YEAR &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
}

/**
 * Reads the working weekdays of untrusted calendar settings.
 *
 * @param value - Untrusted `workingWeekdays` field.
 * @returns At least one weekday in Monday-first order, the default when the field is missing, or
 *   undefined when the field is not a list of weekday names.
 */
function readWorkspaceWorkingWeekdays(value: unknown): WorkspaceCalendarWeekday[] | undefined {
  if (value === undefined) return [...DEFAULT_WORKSPACE_CALENDAR_SETTINGS.workingWeekdays]
  if (!Array.isArray(value) || value.length > WORKSPACE_CALENDAR_WEEKDAYS.length) return undefined
  const entries: unknown[] = value
  if (!entries.every(isWorkspaceCalendarWeekday)) return undefined
  const weekdays = WORKSPACE_CALENDAR_WEEKDAYS.filter((weekday) => entries.includes(weekday))
  return weekdays.length > 0 ? weekdays : undefined
}

/**
 * Reads the holidays of untrusted calendar settings.
 *
 * @param value - Untrusted `holidays` field.
 * @returns Sorted unique dates, none when the field is missing, or undefined when the field is not
 *   a list of at most {@link WORKSPACE_CALENDAR_MAX_HOLIDAYS} valid dates.
 */
function readWorkspaceHolidays(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const entries: unknown[] = value
  if (!entries.every(isWorkspaceHolidayDate)) return undefined
  const holidays = [...new Set(entries.filter(isWorkspaceHolidayDate))].sort()
  return holidays.length <= WORKSPACE_CALENDAR_MAX_HOLIDAYS ? holidays : undefined
}
