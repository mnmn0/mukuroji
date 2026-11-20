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

/** Inclusive range of Workspace-local calendar dates, both in `YYYY-MM-DD` form. */
export type WorkspaceCalendarDateRange = {
  /** First local date of the range. */
  from: string
  /** Last local date of the range, inclusive. */
  to: string
}

/** Fiscal year and fiscal quarter a local date falls in. */
export type WorkspaceFiscalQuarter = {
  /** Fiscal year, named by the calendar year it starts in (an April 2026 start is fiscal 2026). */
  fiscalYear: number
  /** Quarter of the fiscal year, from 1 to 4. */
  quarter: 1 | 2 | 3 | 4
  /** Local dates the quarter covers. */
  range: WorkspaceCalendarDateRange
}

/**
 * Calendar periods a screen can offer as one-click presets.
 *
 * Weeks follow the Workspace week start, and quarters and years follow its fiscal year start.
 */
export type WorkspaceCalendarPeriodPreset =
  | 'this-week'
  | 'last-week'
  | 'this-fiscal-quarter'
  | 'last-fiscal-quarter'
  | 'this-fiscal-year'
  | 'last-fiscal-year'

/** Every period preset, in the order screens list them. */
export const WORKSPACE_CALENDAR_PERIOD_PRESETS: readonly WorkspaceCalendarPeriodPreset[] = [
  'this-week',
  'last-week',
  'this-fiscal-quarter',
  'last-fiscal-quarter',
  'this-fiscal-year',
  'last-fiscal-year',
]

/** Milliseconds in one UTC day, used to step through calendar dates. */
const WORKSPACE_CALENDAR_DAY_MILLISECONDS = 86_400_000

/**
 * Parses a real `YYYY-MM-DD` calendar date.
 *
 * @param date - Local calendar date.
 * @returns The year, month (1 to 12), and day of the date.
 * @throws RangeError When the value is not a real calendar date.
 */
function parseWorkspaceCalendarDate(date: string): { year: number, month: number, day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
  const epoch = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN
  if (!match || Number.isNaN(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) {
    throw new RangeError('Workspace calendar date must be a real YYYY-MM-DD date.')
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/**
 * Formats a UTC-midnight epoch as a `YYYY-MM-DD` calendar date.
 *
 * @param epoch - Epoch milliseconds at UTC midnight of the date.
 * @returns The calendar date.
 */
function formatWorkspaceCalendarEpoch(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10)
}

/**
 * Returns the local date a number of months after the first day of a month.
 *
 * @param year - Calendar year of the starting month.
 * @param month - Starting month, from 1 to 12.
 * @param months - Months to move; may be negative.
 * @returns The first day of the resulting month.
 */
function firstDayOfWorkspaceMonth(year: number, month: number, months: number): string {
  return formatWorkspaceCalendarEpoch(Date.UTC(year, month - 1 + months, 1))
}

/**
 * Returns the local date a number of days from another.
 *
 * @param date - Starting `YYYY-MM-DD` date.
 * @param days - Days to move; may be negative.
 * @returns The resulting date.
 */
function addWorkspaceCalendarDays(date: string, days: number): string {
  const { year, month, day } = parseWorkspaceCalendarDate(date)
  return formatWorkspaceCalendarEpoch(Date.UTC(year, month - 1, day) + days * WORKSPACE_CALENDAR_DAY_MILLISECONDS)
}

/**
 * Checks a fiscal year start month.
 *
 * @param fiscalYearStartMonth - Candidate month.
 * @throws RangeError When the month is not an integer from 1 to 12.
 */
function assertWorkspaceFiscalYearStartMonth(fiscalYearStartMonth: number): void {
  if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
    throw new RangeError('Fiscal year start month must be an integer from 1 to 12.')
  }
}

/**
 * Finds the week that contains a local date.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @param weekStartDay - Day the Workspace week starts on.
 * @returns The seven local dates of that week, starting on the week start day.
 * @throws RangeError When the date is not a real calendar date.
 */
export function workspaceWeekContaining(
  date: string,
  weekStartDay: WorkspaceWeekStartDay,
): WorkspaceCalendarDateRange {
  const { year, month, day } = parseWorkspaceCalendarDate(date)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const from = addWorkspaceCalendarDays(date, -((weekday - weekStartDay + 7) % 7))
  return { from, to: addWorkspaceCalendarDays(from, 6) }
}

/**
 * Finds the fiscal year that contains a local date.
 *
 * A fiscal year is named by the calendar year it starts in, so with an April start
 * 2027-03-31 belongs to fiscal 2026. A January start makes fiscal years calendar years.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @param fiscalYearStartMonth - First month of the fiscal year, from 1 to 12.
 * @returns The fiscal year and the local dates it covers.
 * @throws RangeError When the date or the month is invalid.
 */
export function workspaceFiscalYearContaining(
  date: string,
  fiscalYearStartMonth: number,
): { fiscalYear: number, range: WorkspaceCalendarDateRange } {
  assertWorkspaceFiscalYearStartMonth(fiscalYearStartMonth)
  const { year, month } = parseWorkspaceCalendarDate(date)
  const fiscalYear = month >= fiscalYearStartMonth ? year : year - 1
  const from = firstDayOfWorkspaceMonth(fiscalYear, fiscalYearStartMonth, 0)
  const to = addWorkspaceCalendarDays(firstDayOfWorkspaceMonth(fiscalYear, fiscalYearStartMonth, 12), -1)
  return { fiscalYear, range: { from, to } }
}

/**
 * Finds the fiscal quarter that contains a local date.
 *
 * Quarters are three-month blocks counted from the fiscal year start, so with an April start
 * July to September is the second quarter.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @param fiscalYearStartMonth - First month of the fiscal year, from 1 to 12.
 * @returns The fiscal year, the quarter number, and the local dates the quarter covers.
 * @throws RangeError When the date or the month is invalid.
 */
export function workspaceFiscalQuarterContaining(
  date: string,
  fiscalYearStartMonth: number,
): WorkspaceFiscalQuarter {
  const { fiscalYear } = workspaceFiscalYearContaining(date, fiscalYearStartMonth)
  const { year, month } = parseWorkspaceCalendarDate(date)
  const monthsIntoYear = (year - fiscalYear) * 12 + month - fiscalYearStartMonth
  const quarterIndex = Math.floor(monthsIntoYear / 3)
  const from = firstDayOfWorkspaceMonth(fiscalYear, fiscalYearStartMonth, quarterIndex * 3)
  const to = addWorkspaceCalendarDays(
    firstDayOfWorkspaceMonth(fiscalYear, fiscalYearStartMonth, quarterIndex * 3 + 3),
    -1,
  )
  return { fiscalYear, quarter: readWorkspaceFiscalQuarterNumber(quarterIndex + 1), range: { from, to } }
}

/**
 * Narrows a computed quarter number.
 *
 * @param value - Quarter number computed from a month offset inside a fiscal year.
 * @returns The quarter number.
 * @throws RangeError When the value is outside 1 to 4.
 */
function readWorkspaceFiscalQuarterNumber(value: number): 1 | 2 | 3 | 4 {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value
  throw new RangeError('Fiscal quarter must be from 1 to 4.')
}

/**
 * Resolves a period preset to the local dates it covers on a given day.
 *
 * "This" periods contain `today` and may end after it; "last" periods are the whole period
 * just before. Only the fiscal year start and week start of the settings are used.
 *
 * @param preset - Period to resolve.
 * @param today - Today's local `YYYY-MM-DD` date in the time zone the period is read in.
 * @param settings - Workspace fiscal year start month and week start day.
 * @returns The inclusive local dates of the period.
 * @throws RangeError When the date or the settings are invalid.
 */
export function resolveWorkspaceCalendarPeriod(
  preset: WorkspaceCalendarPeriodPreset,
  today: string,
  settings: Pick<WorkspaceCalendarSettings, 'fiscalYearStartMonth' | 'weekStartDay'>,
): WorkspaceCalendarDateRange {
  switch (preset) {
    case 'this-week':
      return workspaceWeekContaining(today, settings.weekStartDay)
    case 'last-week':
      return workspaceWeekContaining(addWorkspaceCalendarDays(today, -7), settings.weekStartDay)
    case 'this-fiscal-quarter':
      return workspaceFiscalQuarterContaining(today, settings.fiscalYearStartMonth).range
    case 'last-fiscal-quarter': {
      const current = workspaceFiscalQuarterContaining(today, settings.fiscalYearStartMonth)
      return workspaceFiscalQuarterContaining(
        addWorkspaceCalendarDays(current.range.from, -1),
        settings.fiscalYearStartMonth,
      ).range
    }
    case 'this-fiscal-year':
      return workspaceFiscalYearContaining(today, settings.fiscalYearStartMonth).range
    case 'last-fiscal-year': {
      const current = workspaceFiscalYearContaining(today, settings.fiscalYearStartMonth)
      return workspaceFiscalYearContaining(
        addWorkspaceCalendarDays(current.range.from, -1),
        settings.fiscalYearStartMonth,
      ).range
    }
  }
}
