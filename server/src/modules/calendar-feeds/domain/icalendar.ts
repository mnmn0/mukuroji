/**
 * Pure iCalendar (RFC 5545) rendering of a calendar feed.
 *
 * Work Item schedules, Milestones, and Cycles are date-only, so every event is an all-day
 * `VALUE=DATE` event whose `DTEND` is the day after its inclusive last date. A date-only event
 * floats with the subscriber's calendar, so the Workspace time zone is written only as the
 * calendar's `X-WR-TIMEZONE` hint.
 */

/** One all-day event of a feed. */
export type CalendarFeedEvent = {
  /** Globally unique, stable event ID; a calendar client updates the event with the same UID. */
  uid: string
  /** Inclusive first date in `YYYY-MM-DD` form. */
  startDate: string
  /** Inclusive last date in `YYYY-MM-DD` form; the same as `startDate` for a one-day event. */
  endDate: string
  /** Event title. */
  summary: string
  /** Optional plain-text description. */
  description?: string
  /** Revision of the source record; a higher value tells the client the event changed. */
  sequence?: number
}

/** Calendar-level fields of a feed. */
export type CalendarFeedDocument = {
  /** Calendar name shown by the client. */
  name: string
  /** IANA time zone hint of the Workspace calendar. */
  timeZone?: string
  /** Hint of how often the client should refresh, in minutes. */
  refreshIntervalMinutes: number
  /** Time the feed was generated, used as every event's `DTSTAMP`. */
  generatedAt: Date
  /** Events in output order. */
  events: readonly CalendarFeedEvent[]
}

/** Largest number of UTF-8 octets on one content line before folding (RFC 5545 3.1). */
const LINE_OCTET_LIMIT = 75

/** Calendar product identifier. */
const PRODUCT_ID = '-//Mukuroji//Calendar Feed//EN'

/** Shape of a `YYYY-MM-DD` date. */
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Returns whether a value is a real `YYYY-MM-DD` calendar date.
 *
 * @param value - Value to check.
 * @returns Whether the value names an existing date.
 */
export function isCalendarFeedDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = LOCAL_DATE_PATTERN.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

/**
 * Renders a feed as an iCalendar document with CRLF line endings.
 *
 * Events whose dates are not valid, or whose last date is before the first, are left out.
 *
 * @param document - Calendar fields and events.
 * @returns The `text/calendar` body.
 */
export function renderCalendarFeed(document: CalendarFeedDocument): string {
  const stamp = formatUtcTimestamp(document.generatedAt)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODUCT_ID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(document.name)}`,
    ...(document.timeZone ? [`X-WR-TIMEZONE:${escapeText(document.timeZone)}`] : []),
    `REFRESH-INTERVAL;VALUE=DURATION:PT${document.refreshIntervalMinutes}M`,
    `X-PUBLISHED-TTL:PT${document.refreshIntervalMinutes}M`,
  ]
  for (const event of document.events) {
    if (!isCalendarFeedDate(event.startDate) || !isCalendarFeedDate(event.endDate)) continue
    if (event.endDate < event.startDate) continue
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDate(event.startDate)}`,
      renderEventEnd(event.startDate, event.endDate),
      `SUMMARY:${escapeText(event.summary)}`,
      ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
      ...(event.sequence !== undefined && Number.isSafeInteger(event.sequence) && event.sequence >= 0
        ? [`SEQUENCE:${event.sequence}`]
        : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}

/**
 * Escapes a TEXT value (RFC 5545 3.3.11) and drops control characters other than newlines.
 *
 * @param value - Raw text.
 * @returns The escaped text.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    // oxlint-disable-next-line no-control-regex -- control characters are not allowed in iCalendar text.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/**
 * Folds a content line so that no line exceeds 75 UTF-8 octets, never splitting a character.
 *
 * @param line - Unfolded content line.
 * @returns The folded line, joined with CRLF and a leading space.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= LINE_OCTET_LIMIT) return line
  const parts: string[] = []
  let current = ''
  let currentOctets = 0
  for (const character of line) {
    const octets = encoder.encode(character).length
    // Continuation lines start with a space, which counts toward their limit.
    const limit = parts.length === 0 ? LINE_OCTET_LIMIT : LINE_OCTET_LIMIT - 1
    if (currentOctets + octets > limit) {
      parts.push(current)
      current = ''
      currentOctets = 0
    }
    current += character
    currentOctets += octets
  }
  parts.push(current)
  return parts.join('\r\n ')
}

/**
 * Formats an instant as an iCalendar UTC date-time.
 *
 * @param value - Instant.
 * @returns The `YYYYMMDDTHHMMSSZ` form.
 */
function formatUtcTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
}

/**
 * Removes the separators of a `YYYY-MM-DD` date.
 *
 * @param value - Valid local date.
 * @returns The `YYYYMMDD` form.
 */
function compactDate(value: string): string {
  return value.replace(/-/g, '')
}

/**
 * Returns the day after a local date.
 *
 * @param value - Valid `YYYY-MM-DD` date.
 * @returns The next date in the same form.
 */
/**
 * Renders the exclusive end of an all-day event. An event that ends on 9999-12-31 has no
 * next day in the DATE format, so it gets a `DURATION` in days instead.
 *
 * @param startDate - First day, inclusive.
 * @param endDate - Last day, inclusive.
 * @returns The `DTEND` or `DURATION` line.
 */
function renderEventEnd(startDate: string, endDate: string): string {
  const end = nextDate(endDate)
  if (/^\d{4}-\d{2}-\d{2}$/u.test(end)) return `DTEND;VALUE=DATE:${compactDate(end)}`
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1
  return `DURATION:P${days}D`
}

function nextDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1))
  return date.toISOString().slice(0, 10)
}
