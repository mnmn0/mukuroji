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
