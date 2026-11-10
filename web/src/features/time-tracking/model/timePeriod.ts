/** One Monday-based local week shown by the timesheet. */
export type TimeWeekPeriod = {
  /** Local dates of the week, Monday first, as `YYYY-MM-DD`. */
  days: string[]
  /** Inclusive start (Monday 00:00 local) as an ISO 8601 instant. */
  from: string
  /** Exclusive end (next Monday 00:00 local) as an ISO 8601 instant. */
  to: string
}

const localDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u
const localTimePattern = /^(\d{2}):(\d{2})$/u

/**
 * Pads a calendar number to two digits.
 *
 * @param value - Calendar number.
 * @returns Two-digit text.
 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Formats a Date as a local `YYYY-MM-DD` date in the browser timezone.
 *
 * @param date - Date to format.
 * @returns Local date text.
 */
function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Parses a local `YYYY-MM-DD` date into local midnight.
 *
 * @param value - Local date text.
 * @returns Local midnight, or undefined for invalid text.
 */
function parseLocalDate(value: string): Date | undefined {
  const match = localDatePattern.exec(value)
  if (!match) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return formatLocalDate(date) === value ? date : undefined
}

/**
 * Returns the local date of an instant in the browser timezone.
 *
 * @param instant - ISO 8601 instant or Date.
 * @returns Local `YYYY-MM-DD` date.
 */
export function toLocalDateKey(instant: string | Date): string {
  return formatLocalDate(typeof instant === 'string' ? new Date(instant) : instant)
}

/**
 * Returns the instants that bound a local date in the browser timezone.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @returns Epoch milliseconds of its midnight and of the next midnight, or undefined for invalid text.
 */
export function readLocalDayRange(date: string): { from: number; to: number } | undefined {
  const start = parseLocalDate(date)
  if (!start) return undefined
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { from: start.getTime(), to: end.getTime() }
}

/**
 * Returns local noon of a date, a safe instant inside the day for range helpers.
 *
 * @param date - Local `YYYY-MM-DD` date; invalid text falls back to now.
 * @returns Date at local noon.
 */
export function readLocalNoon(date: string): Date {
  const day = parseLocalDate(date)
  if (!day) return new Date()
  day.setHours(12, 0, 0, 0)
  return day
}

/**
 * Moves a local date by whole days.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @param days - Days to move; negative moves back.
 * @returns Target date, or undefined for invalid text.
 */
export function shiftLocalDate(date: string, days: number): string | undefined {
  const day = parseLocalDate(date)
  if (!day) return undefined
  day.setDate(day.getDate() + days)
  return formatLocalDate(day)
}

/**
 * Counts whole local days from one date to another.
 *
 * @param from - Local `YYYY-MM-DD` date.
 * @param to - Local `YYYY-MM-DD` date.
 * @returns Days from `from` to `to`, or undefined when either is invalid.
 */
export function countLocalDaysBetween(from: string, to: string): number | undefined {
  const start = parseLocalDate(from)
  const end = parseLocalDate(to)
  if (!start || !end) return undefined
  return Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86_400_000)
}

/**
 * Returns the local `HH:MM` time of an instant in the browser timezone.
 *
 * @param instant - ISO 8601 instant.
 * @returns Local time text.
 */
export function toLocalTimeInput(instant: string): string {
  const date = new Date(instant)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Combines a local date and time into an ISO 8601 instant.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @param time - Local `HH:MM` time.
 * @returns ISO instant, or undefined when either part is invalid.
 */
export function toInstantFromLocal(date: string, time: string): string | undefined {
  const day = parseLocalDate(date)
  const match = localTimePattern.exec(time)
  if (!day || !match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  day.setHours(hours, minutes, 0, 0)
  return day.toISOString()
}

/**
 * Reads an instant from local date and time fields, keeping the stored one when they were left unchanged.
 *
 * Timer entries carry seconds that minute-resolution inputs cannot show, so rebuilding an
 * untouched endpoint would shorten the recorded time or make a sub-minute entry invalid.
 *
 * @param original - Stored instant of the entry being edited, if any.
 * @param date - Local `YYYY-MM-DD` date.
 * @param time - Local `HH:MM` time.
 * @returns ISO instant, or undefined when the fields are invalid.
 */
export function resolveLocalInstant(original: string | undefined, date: string, time: string): string | undefined {
  if (original && toLocalDateKey(original) === date && toLocalTimeInput(original) === time) return original
  return toInstantFromLocal(date, time)
}

/**
 * Normalizes any local date to the Monday that starts its week.
 *
 * @param value - Local `YYYY-MM-DD` date; invalid text falls back to `today`.
 * @param today - Current instant used for the fallback.
 * @returns Monday of the week as `YYYY-MM-DD`.
 */
export function resolveWeekStart(value: string | null | undefined, today: Date = new Date()): string {
  const date = (value ? parseLocalDate(value) : undefined) ?? new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const offsetFromMonday = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offsetFromMonday)
  return formatLocalDate(date)
}

/**
 * Moves a week start by whole weeks.
 *
 * @param weekStart - Monday as `YYYY-MM-DD`.
 * @param weeks - Number of weeks to move; negative moves back.
 * @returns Monday of the target week.
 */
export function shiftWeek(weekStart: string, weeks: number): string {
  const date = parseLocalDate(weekStart) ?? new Date()
  date.setDate(date.getDate() + weeks * 7)
  return resolveWeekStart(formatLocalDate(date))
}

/**
 * Creates the seven local days and the instant range of a week.
 *
 * @param weekStart - Monday as `YYYY-MM-DD`.
 * @returns Week days and range.
 */
export function createWeekPeriod(weekStart: string): TimeWeekPeriod {
  const monday = parseLocalDate(resolveWeekStart(weekStart)) ?? new Date()
  const days: string[] = []
  const cursor = new Date(monday)
  for (let index = 0; index < 7; index += 1) {
    days.push(formatLocalDate(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return { days, from: monday.toISOString(), to: cursor.toISOString() }
}

/**
 * Creates a range that ends now and starts a number of days earlier.
 *
 * @param days - Length of the range in days.
 * @param now - Current instant.
 * @returns Inclusive start and exclusive end as ISO instants; the end is the next local midnight.
 */
export function createTrailingPeriod(days: number, now: Date = new Date()): { from: string; to: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const start = new Date(end)
  start.setDate(start.getDate() - days)
  return { from: start.toISOString(), to: end.toISOString() }
}

/**
 * Formats minutes as `H:MM`.
 *
 * @param minutes - Duration in minutes.
 * @returns Duration text, with a leading minus for negative values.
 */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : ''
  const absolute = Math.abs(Math.round(minutes))
  return `${sign}${Math.floor(absolute / 60)}:${pad(absolute % 60)}`
}

/**
 * Formats elapsed milliseconds as `H:MM:SS` for a running timer.
 *
 * @param milliseconds - Elapsed time.
 * @returns Clock text.
 */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/**
 * Parses an hour amount typed by a member, such as `1.5` or `1:30`.
 *
 * @param value - Typed text.
 * @returns Whole minutes, or undefined when the text is not a non-negative amount.
 */
export function parseHoursInput(value: string): number | undefined {
  const text = value.trim()
  const clock = /^(\d+):([0-5]\d)$/u.exec(text)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return undefined
  return Math.round(Number(text) * 60)
}

/**
 * Returns the browser's IANA timezone, used for server-side calendar grouping.
 *
 * @returns Timezone identifier, or `UTC` when the runtime does not report one.
 */
export function resolveBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
