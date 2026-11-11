import type { TimeEntry, TimeEntryStatus } from '@mukuroji/contracts'
import { readLocalDayRange, shiftLocalDate, toLocalDateKey } from './timePeriod'

/** Longest interval the API accepts for one entry or timer, in minutes. */
export const maxTimeEntryMinutes = 7 * 24 * 60

/** One day of a member's week with its entries. */
export type TimeEntryDay = {
  /** Local date as `YYYY-MM-DD`. */
  date: string
  /** Entries listed under the date: those that start on it, or carried over into the first date of the week. */
  entries: TimeEntry[]
  /** Minutes recorded on the date, including parts of entries that cross midnight. */
  totalMinutes: number
}

/** One Work Item row of the weekly table. */
export type TimeEntryWeekRow = {
  /** Work Item identifier. */
  workItemId: string
  /** Minutes keyed by local date. */
  minutesByDate: Record<string, number>
  /** Sum of the row. */
  totalMinutes: number
}

/** Counts of a week's entries by lifecycle state. */
export type TimeEntryStatusCounts = Record<TimeEntryStatus, number>

/** Entries of one member waiting for a manager. */
export type TimeApprovalGroup = {
  /** Member who recorded the entries. */
  userId: string
  /** Entries by start time. */
  entries: TimeEntry[]
  /** Sum of the entries' minutes. */
  totalMinutes: number
}

/**
 * Returns whether the owner may still edit an entry.
 *
 * @param entry - Entry to check.
 * @returns Whether the entry is a draft or was rejected.
 */
export function isTimeEntryEditable(entry: Pick<TimeEntry, 'status'>): boolean {
  return entry.status === 'draft' || entry.status === 'rejected'
}

/**
 * Sorts entries by start time, then by identifier.
 *
 * @param entries - Entries to sort.
 * @returns New sorted array.
 */
export function sortTimeEntries(entries: readonly TimeEntry[]): TimeEntry[] {
  return [...entries].sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id))
}

/**
 * Sums the minutes of entries.
 *
 * @param entries - Entries to sum.
 * @returns Total minutes.
 */
export function sumTimeEntryMinutes(entries: readonly Pick<TimeEntry, 'durationMinutes'>[]): number {
  return entries.reduce((total, entry) => total + entry.durationMinutes, 0)
}

/**
 * Splits an entry's minutes across the local dates its interval covers.
 *
 * Like the server timesheet, each date first gets the whole minutes inside it and the minutes
 * left over go to the dates with the largest fractions, so every part is a whole number and the
 * parts across all covered dates add up to the recorded minutes. An entry that crosses midnight
 * therefore counts on both days.
 *
 * @param entry - Entry to split.
 * @param days - Local dates to report.
 * @returns Whole minutes keyed by each listed date the entry overlaps, zero for a sliver under a minute.
 */
export function splitTimeEntryMinutesByDay(
  entry: Pick<TimeEntry, 'startAt' | 'endAt' | 'durationMinutes'>,
  days: readonly string[],
): Map<string, number> {
  const start = Date.parse(entry.startAt)
  const end = Date.parse(entry.endAt)
  const minutesByDate = new Map<string, number>()
  if (!(end > start)) return minutesByDate
  const segments: Array<{ date: string; rawMinutes: number; minutes: number }> = []
  const lastDate = toLocalDateKey(new Date(end - 1))
  // An entry spans at most seven days, so the walk is short; the bound guards bad input.
  for (let date: string | undefined = toLocalDateKey(new Date(start)), steps = 0; date && date <= lastDate && steps < 10; date = shiftLocalDate(date, 1), steps += 1) {
    const range = readLocalDayRange(date)
    if (!range) break
    const overlap = Math.min(end, range.to) - Math.max(start, range.from)
    if (overlap > 0) segments.push({ date, rawMinutes: overlap / 60_000, minutes: Math.floor(overlap / 60_000) })
  }
  // The recorded minutes are rounded from the exact interval; as on the server, the minutes left
  // after flooring each day's elapsed time go to the days with the largest elapsed fractions.
  let remaining = entry.durationMinutes - segments.reduce((total, segment) => total + segment.minutes, 0)
  for (const segment of [...segments].sort((left, right) =>
    (right.rawMinutes - Math.floor(right.rawMinutes)) - (left.rawMinutes - Math.floor(left.rawMinutes)))) {
    if (remaining <= 0) break
    segment.minutes += 1
    remaining -= 1
  }
  const listed = new Set(days)
  for (const segment of segments) {
    if (listed.has(segment.date)) minutesByDate.set(segment.date, segment.minutes)
  }
  return minutesByDate
}

/**
 * Sums the minutes of entries that fall on the listed local dates.
 *
 * @param entries - Entries to sum.
 * @param days - Local dates to count.
 * @returns Minutes inside the dates; time outside them is left out.
 */
export function sumTimeEntryMinutesInDays(entries: readonly TimeEntry[], days: readonly string[]): number {
  let total = 0
  for (const entry of entries) {
    for (const minutes of splitTimeEntryMinutesByDay(entry, days).values()) total += minutes
  }
  return total
}

/**
 * Groups entries by local date for the daily lists.
 *
 * Each entry is listed once, under the first listed date it overlaps, so an entry carried over
 * from the previous week stays reachable. Day totals count only the time on that date.
 *
 * @param entries - Entries of the week.
 * @param days - Local dates of the week.
 * @returns One group per day, including empty days.
 */
export function groupTimeEntriesByDay(entries: readonly TimeEntry[], days: readonly string[]): TimeEntryDay[] {
  const groups = new Map<string, TimeEntryDay>(days.map((date) => [date, { date, entries: [], totalMinutes: 0 }]))
  for (const entry of sortTimeEntries(entries)) {
    const minutesByDate = splitTimeEntryMinutesByDay(entry, days)
    const firstDate = days.find((date) => minutesByDate.has(date))
    if (firstDate) groups.get(firstDate)?.entries.push(entry)
    for (const [date, minutes] of minutesByDate) {
      const group = groups.get(date)
      if (group) group.totalMinutes += minutes
    }
  }
  return [...groups.values()]
}

/**
 * Builds the Work Item × day table of a week, splitting entries that cross midnight.
 *
 * @param entries - Entries of the week.
 * @param days - Local dates of the week.
 * @returns Rows in order of first appearance.
 */
export function buildTimeEntryWeekRows(entries: readonly TimeEntry[], days: readonly string[]): TimeEntryWeekRow[] {
  const rows = new Map<string, TimeEntryWeekRow>()
  for (const entry of sortTimeEntries(entries)) {
    const minutesByDate = splitTimeEntryMinutesByDay(entry, days)
    if (minutesByDate.size === 0) continue
    const row = rows.get(entry.workItemId) ?? { workItemId: entry.workItemId, minutesByDate: {}, totalMinutes: 0 }
    for (const [date, minutes] of minutesByDate) {
      row.minutesByDate[date] = (row.minutesByDate[date] ?? 0) + minutes
      row.totalMinutes += minutes
    }
    rows.set(entry.workItemId, row)
  }
  return [...rows.values()]
}

/**
 * Counts entries by lifecycle state.
 *
 * @param entries - Entries to count.
 * @returns Count per state.
 */
export function countTimeEntriesByStatus(entries: readonly Pick<TimeEntry, 'status'>[]): TimeEntryStatusCounts {
  const counts: TimeEntryStatusCounts = { draft: 0, submitted: 0, approved: 0, rejected: 0, locked: 0 }
  for (const entry of entries) counts[entry.status] += 1
  return counts
}

/**
 * Groups entries in one lifecycle state by member for the approval queue.
 *
 * @param entries - Team entries of the period.
 * @param status - State to keep.
 * @returns Groups ordered by member identifier.
 */
export function groupTimeEntriesByMember(entries: readonly TimeEntry[], status: TimeEntryStatus): TimeApprovalGroup[] {
  const groups = new Map<string, TimeEntry[]>()
  for (const entry of sortTimeEntries(entries)) {
    if (entry.status !== status) continue
    groups.set(entry.userId, [...groups.get(entry.userId) ?? [], entry])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([userId, memberEntries]) => ({ userId, entries: memberEntries, totalMinutes: sumTimeEntryMinutes(memberEntries) }))
}

/**
 * Returns the minutes a running timer has measured.
 *
 * @param startedAt - Timer start as an ISO 8601 instant.
 * @param now - Current instant.
 * @returns Elapsed milliseconds, never negative.
 */
export function readTimerElapsedMilliseconds(startedAt: string, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(startedAt))
}

/**
 * Returns whether a running timer is longer than one entry may be, so it can only be discarded.
 *
 * @param startedAt - Timer start as an ISO 8601 instant.
 * @param now - Current instant.
 * @returns Whether stopping the timer would be rejected.
 */
export function isTimerOverlong(startedAt: string, now: Date): boolean {
  return readTimerElapsedMilliseconds(startedAt, now) > maxTimeEntryMinutes * 60_000
}
