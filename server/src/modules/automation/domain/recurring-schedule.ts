import type {
  RecurringCatchUpPolicy,
  RecurringSchedule,
} from '@mukuroji/contracts'
import { AutomationError } from './automation-error'

/**
 * Validates and normalizes an untrusted recurring schedule.
 *
 * @param value - Untrusted schedule value.
 * @returns A normalized recurring schedule.
 */
export function validateRecurringSchedule(value: unknown): RecurringSchedule {
  const schedule = requireRecord(value, 'Recurring schedule')
  if (
    schedule.frequency !== 'daily' &&
    schedule.frequency !== 'weekly' &&
    schedule.frequency !== 'monthly'
  ) {
    throw invalidInput('Recurring schedule frequency is invalid.')
  }
  const interval = requireInteger(schedule.interval, 'Recurring interval', 1, 365)
  const timeZone = requireBoundedText(schedule.timeZone, 'Recurring timezone', 128)
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format()
  } catch {
    throw invalidInput('Recurring timezone must be a valid IANA timezone ID.')
  }
  const localTime = requireBoundedText(schedule.localTime, 'Recurring local time', 5)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    throw invalidInput('Recurring local time must use HH:mm.')
  }
  const startDate = requireBoundedText(schedule.startDate, 'Recurring start date', 10)
  if (!isIsoDate(startDate)) {
    throw invalidInput('Recurring start date must use a valid YYYY-MM-DD date.')
  }
  if (
    schedule.catchUpPolicy !== 'skip' &&
    schedule.catchUpPolicy !== 'latest' &&
    schedule.catchUpPolicy !== 'all'
  ) {
    throw invalidInput('Recurring catch-up policy is invalid.')
  }
  const result: RecurringSchedule = {
    frequency: schedule.frequency,
    interval,
    timeZone,
    localTime,
    startDate,
    catchUpPolicy: schedule.catchUpPolicy,
  }
  if (schedule.frequency === 'weekly') {
    if (!Array.isArray(schedule.daysOfWeek) || schedule.daysOfWeek.length === 0) {
      throw invalidInput('Weekly recurring schedule requires daysOfWeek.')
    }
    const days = schedule.daysOfWeek.map((day) =>
      requireInteger(day, 'Recurring weekday', 0, 6)
    )
    if (new Set(days).size !== days.length) {
      throw invalidInput('Recurring weekdays must be unique.')
    }
    result.daysOfWeek = [...days].sort((first, second) => first - second)
  } else if (schedule.daysOfWeek !== undefined) {
    throw invalidInput('Only weekly recurring schedules can define daysOfWeek.')
  }
  if (schedule.frequency === 'monthly') {
    result.dayOfMonth = requireInteger(schedule.dayOfMonth, 'Recurring month day', 1, 31)
  } else if (schedule.dayOfMonth !== undefined) {
    throw invalidInput('Only monthly recurring schedules can define dayOfMonth.')
  }
  if (schedule.maxCatchUpOccurrences !== undefined) {
    result.maxCatchUpOccurrences = requireInteger(
      schedule.maxCatchUpOccurrences,
      'Maximum catch-up occurrences',
      1,
      1_000,
    )
  }
  return result
}

/**
 * Returns recurring occurrences within an exclusive/inclusive UTC window.
 *
 * @param scheduleValue - Recurring schedule to evaluate.
 * @param fromExclusive - Exclusive lower UTC bound.
 * @param toInclusive - Inclusive upper UTC bound.
 * @returns Ordered UTC occurrences.
 */
export function getRecurringOccurrences(
  scheduleValue: RecurringSchedule,
  fromExclusive: Date,
  toInclusive: Date,
): Date[] {
  const schedule = validateRecurringSchedule(scheduleValue)
  if (!isValidDate(fromExclusive) || !isValidDate(toInclusive) || fromExclusive >= toInclusive) {
    return []
  }
  const firstLocal = addIsoDays(zonedDate(fromExclusive, schedule.timeZone), -2)
  const lastLocal = addIsoDays(zonedDate(toInclusive, schedule.timeZone), 2)
  const occurrences: Date[] = []
  for (
    let date = firstLocal, count = 0;
    date <= lastLocal;
    date = addIsoDays(date, 1), count += 1
  ) {
    if (count > 20_000) throw new RangeError('Recurring occurrence window is too large.')
    if (date < schedule.startDate || !scheduleMatchesDate(schedule, date)) continue
    const instant = resolveLocalOccurrence(date, schedule.localTime, schedule.timeZone)
    if (instant > fromExclusive && instant <= toInclusive) occurrences.push(instant)
  }
  return occurrences.sort((first, second) => first.getTime() - second.getTime())
}

/**
 * Returns the first recurring occurrence after a UTC instant.
 *
 * @param schedule - Recurring schedule to evaluate.
 * @param after - Exclusive lower UTC bound.
 * @returns The next occurrence, or `undefined` when the supported horizon is exhausted.
 */
export function getNextRecurringOccurrence(
  schedule: RecurringSchedule,
  after: Date,
): Date | undefined {
  if (!isValidDate(after)) throw invalidInput('Recurring after timestamp is invalid.')
  const windows = [366, 1_830, 3_660]
  for (const days of windows) {
    const occurrences = getRecurringOccurrences(
      schedule,
      after,
      new Date(after.getTime() + days * 86_400_000),
    )
    const first = occurrences[0]
    if (first) return first
  }
  return undefined
}

/**
 * Applies a catch-up policy to missed recurring occurrences.
 *
 * @param occurrences - Candidate occurrences.
 * @param policy - Catch-up policy.
 * @param maximum - Maximum occurrences returned for the `all` policy.
 * @returns Selected occurrences in chronological order.
 */
export function selectCatchUpOccurrences(
  occurrences: readonly Date[],
  policy: RecurringCatchUpPolicy,
  maximum = 100,
): Date[] {
  const sorted = [...occurrences]
    .filter(isValidDate)
    .sort((first, second) => first.getTime() - second.getTime())
  if (policy === 'skip') return []
  if (policy === 'latest') {
    const latest = sorted[sorted.length - 1]
    return latest ? [latest] : []
  }
  return sorted.slice(0, requireInteger(
    maximum,
    'Maximum catch-up occurrences',
    1,
    1_000,
  ))
}

/** Tests whether an ISO date is selected by a recurring schedule. */
function scheduleMatchesDate(schedule: RecurringSchedule, date: string): boolean {
  const dayDifference = daysBetween(schedule.startDate, date)
  if (dayDifference < 0) return false
  if (schedule.frequency === 'daily') return dayDifference % schedule.interval === 0
  if (schedule.frequency === 'weekly') {
    return Math.floor(dayDifference / 7) % schedule.interval === 0 &&
      Boolean(schedule.daysOfWeek?.includes(isoDateWeekday(date)))
  }
  const monthDifference = monthsBetween(schedule.startDate, date)
  return monthDifference >= 0 && monthDifference % schedule.interval === 0 &&
    Number(date.slice(8, 10)) === schedule.dayOfMonth
}

/** Resolves a local scheduled time across daylight-saving transitions. */
function resolveLocalOccurrence(date: string, time: string, timeZone: string): Date {
  const exact = findMatchingInstants(date, time, timeZone)
  const firstExact = exact[0]
  if (firstExact) return firstExact
  let candidateDate = date
  let candidateTime = time
  for (let skippedMinutes = 0; skippedMinutes < 180; skippedMinutes += 1) {
    const next = addLocalMinute(candidateDate, candidateTime)
    candidateDate = next.date
    candidateTime = next.time
    const shifted = findMatchingInstants(candidateDate, candidateTime, timeZone)
    const firstShifted = shifted[0]
    if (firstShifted) return firstShifted
  }
  throw new AutomationError(
    'unavailable',
    'RecurringDstResolutionFailed',
    'Recurring local time could not be resolved.',
  )
}

/** Finds all UTC instants represented by a local date and time. */
function findMatchingInstants(date: string, time: string, timeZone: string): Date[] {
  const components = parseLocalDateTime(date, time)
  const approximate = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
  )
  const offsets = new Set([-2, -1, 0, 1, 2].map((dayOffset) =>
    zonedOffsetMinutes(new Date(approximate + dayOffset * 86_400_000), timeZone)
  ))
  const matches: Date[] = []
  for (const offset of offsets) {
    const candidate = new Date(approximate - offset * 60_000)
    const local = zonedDateTime(candidate, timeZone)
    if (local.date === date && local.time === time) matches.push(candidate)
  }
  return [...new Map(matches.map((match) => [match.getTime(), match])).values()]
    .sort((first, second) => first.getTime() - second.getTime())
}

/** Parsed local date/time components. */
type LocalDateTimeComponents = {
  /** Four-digit year. */
  year: number
  /** One-based month. */
  month: number
  /** Day of month. */
  day: number
  /** Local hour. */
  hour: number
  /** Local minute. */
  minute: number
}

/** Parses already validated local date and time strings. */
function parseLocalDateTime(date: string, time: string): LocalDateTimeComponents {
  const [yearText, monthText, dayText] = date.split('-')
  const [hourText, minuteText] = time.split(':')
  if (!yearText || !monthText || !dayText || !hourText || !minuteText) {
    throw invalidInput('Recurring local date or time is invalid.')
  }
  return {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  }
}

/** Returns an ISO date in a requested IANA time zone. */
function zonedDate(value: Date, timeZone: string): string {
  return zonedDateTime(value, timeZone).date
}

/** Local date/time representation in a requested IANA time zone. */
type ZonedDateTime = {
  /** ISO local date. */
  date: string
  /** Local 24-hour time. */
  time: string
}

/** Formats a UTC instant as a local date and time. */
function zonedDateTime(value: Date, timeZone: string): ZonedDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? ''
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  }
}

/** Returns the zone offset for a UTC instant in minutes. */
function zonedOffsetMinutes(value: Date, timeZone: string): number {
  const local = zonedDateTime(value, timeZone)
  const components = parseLocalDateTime(local.date, local.time)
  const minuteAligned = Math.floor(value.getTime() / 60_000) * 60_000
  return (Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
  ) - minuteAligned) / 60_000
}

/** Adds one minute in local calendar space. */
function addLocalMinute(date: string, time: string): ZonedDateTime {
  const components = parseLocalDateTime(date, time)
  const next = new Date(Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute + 1,
  ))
  return {
    date: next.toISOString().slice(0, 10),
    time: next.toISOString().slice(11, 16),
  }
}

/** Adds whole days to an ISO date. */
function addIsoDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/** Returns the whole-day difference between ISO dates. */
function daysBetween(from: string, to: string): number {
  return Math.floor(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  )
}

/** Returns the calendar-month difference between ISO dates. */
function monthsBetween(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    Number(to.slice(5, 7)) - Number(from.slice(5, 7))
}

/** Returns the Sunday-based weekday of an ISO date. */
function isoDateWeekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay()
}

/** Validates an ISO calendar date. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Tests whether a Date contains a valid instant. */
function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

/** Reads an object from untrusted input. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidInput(`${label} must be an object.`)
  }
  return value
}

/** Narrows an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads bounded non-empty text from untrusted input. */
function requireBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidInput(`${label} is required.`)
  }
  const text = value.trim()
  if (text.length > maximum) {
    throw invalidInput(`${label} must be ${maximum} characters or fewer.`)
  }
  return text
}

/** Reads a bounded integer from untrusted input. */
function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

/** Creates the stable invalid-input error used by Automation adapters. */
function invalidInput(message: string): AutomationError {
  return new AutomationError('invalid-input', 'InvalidAutomationInput', message)
}
