import type { TimeEntry, TimeEntryStatus } from '@mukuroji/contracts'

/** Longest interval the API accepts for one entry or timer, in minutes. */
export const maxTimeEntryMinutes = 7 * 24 * 60

/** One day of a member's week with its entries. */
export type TimeEntryDay = {
  /** Local date as `YYYY-MM-DD`. */
  date: string
  /** Entries that start on the date, by start time. */
  entries: TimeEntry[]
  /** Sum of the entries' minutes. */
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
 * Groups entries by the local date they start on.
 *
 * @param entries - Entries of the week.
 * @param days - Local dates of the week.
 * @param toDateKey - Converts an instant to its local date.
 * @returns One group per day, including empty days.
 */
export function groupTimeEntriesByDay(
  entries: readonly TimeEntry[],
  days: readonly string[],
  toDateKey: (instant: string) => string,
): TimeEntryDay[] {
  const sorted = sortTimeEntries(entries)
  return days.map((date) => {
    const dayEntries = sorted.filter((entry) => toDateKey(entry.startAt) === date)
    return { date, entries: dayEntries, totalMinutes: sumTimeEntryMinutes(dayEntries) }
  })
}

/**
 * Builds the Work Item × day table of a week.
 *
 * @param entries - Entries of the week.
 * @param days - Local dates of the week.
 * @param toDateKey - Converts an instant to its local date.
 * @returns Rows in order of first appearance.
 */
export function buildTimeEntryWeekRows(
  entries: readonly TimeEntry[],
  days: readonly string[],
  toDateKey: (instant: string) => string,
): TimeEntryWeekRow[] {
  const dates = new Set(days)
  const rows = new Map<string, TimeEntryWeekRow>()
  for (const entry of sortTimeEntries(entries)) {
    const date = toDateKey(entry.startAt)
    if (!dates.has(date)) continue
    const row = rows.get(entry.workItemId) ?? { workItemId: entry.workItemId, minutesByDate: {}, totalMinutes: 0 }
    row.minutesByDate[date] = (row.minutesByDate[date] ?? 0) + entry.durationMinutes
    row.totalMinutes += entry.durationMinutes
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
