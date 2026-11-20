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

/** Workspace-wide calendar settings that decide fiscal years and weeks. */
export type WorkspaceCalendarSettings = {
  /** First month of the fiscal year, from 1 (January) to 12 (December). */
  fiscalYearStartMonth: number
  /** Day each Workspace week starts on. */
  weekStartDay: WorkspaceWeekStartDay
}

/**
 * Calendar settings of a Workspace that has not chosen its own.
 *
 * They keep the behavior from before the settings existed: calendar-year fiscal years and
 * Monday-based weeks, as the timesheet and capacity planning already use.
 */
export const DEFAULT_WORKSPACE_CALENDAR_SETTINGS: WorkspaceCalendarSettings = {
  fiscalYearStartMonth: 1,
  weekStartDay: 1,
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
 * @param value - Untrusted candidate, such as a request body field or a stored record.
 * @returns Settings built from the value, or undefined when any field is missing or invalid.
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
  return { fiscalYearStartMonth, weekStartDay }
}
