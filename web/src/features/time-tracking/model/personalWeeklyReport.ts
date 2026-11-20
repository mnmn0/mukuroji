import {
  readWorkItemPlannedEndDate,
  readWorkItemPlannedStartDate,
  type CanonicalWorkItem,
  type SubmitWeeklyReportRequest,
  type TimeEntry,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { splitTimeEntryMinutesByDay } from './timeEntryLifecycle'
import { formatMinutes, shiftLocalDate } from './timePeriod'

/** One Work Item fact listed in a personal weekly report. */
export type PersonalWeeklyReportItem = {
  /** Work Item identifier. */
  id: string
  /** Short Work Item reference such as `ABC-123`, when the item has one. */
  key?: string
  /** Work Item title. */
  title: string
  /** Planned end date or deadline as `YYYY-MM-DD`, when the item is scheduled. */
  plannedEndDate?: string
  /** Minutes the member recorded against the item during the week. */
  minutes: number
}

/** Minutes the member recorded against one Work Item during the week. */
export type PersonalWeeklyReportTimeRow = {
  /** Work Item identifier. */
  workItemId: string
  /** Work Item title, or the identifier when the title is unknown. */
  title: string
  /** Recorded minutes. */
  minutes: number
}

/** Facts of one member's week, derived only from data the member can already read. */
export type PersonalWeeklyReport = {
  /** First local day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Last local day of the week as `YYYY-MM-DD`. */
  weekEnd: string
  /** Work Items whose latest completion falls in the week. */
  completed: PersonalWeeklyReportItem[]
  /** Work Items first started in the week and not completed in it. */
  started: PersonalWeeklyReportItem[]
  /** Open Work Items whose planned end passed before the end of the week, or before today. */
  overdue: PersonalWeeklyReportItem[]
  /** Open, not overdue Work Items in progress or planned to start or end by the end of next week. */
  upcoming: PersonalWeeklyReportItem[]
  /** Recorded minutes per Work Item, largest first. */
  time: PersonalWeeklyReportTimeRow[]
  /** Total recorded minutes in the week. */
  totalMinutes: number
}

/** Inputs of {@link buildPersonalWeeklyReport}. */
export type PersonalWeeklyReportInput = {
  /** Local days of the week, Monday first, as `YYYY-MM-DD`. */
  weekDays: readonly string[]
  /** Today's local date as `YYYY-MM-DD`; caps the overdue cutoff for the current week. */
  today: string
  /** Work Items the member owns or contributes to, as returned by the server for the member. */
  workItems: readonly CanonicalWorkItem[]
  /** The member's own time entries that overlap the week; only minutes inside the week count. */
  entries: readonly TimeEntry[]
  /** Titles of Team Work Items, used for time recorded against items outside `workItems`. */
  workItemTitles?: Readonly<Record<string, string>>
}

/**
 * Reports whether a local date lies within an inclusive range.
 *
 * @param date - Local `YYYY-MM-DD` date, or undefined.
 * @param from - Inclusive first date.
 * @param to - Inclusive last date.
 * @returns True when the date is present and inside the range.
 */
function isWithin(date: string | undefined, from: string, to: string): date is string {
  return date !== undefined && date >= from && date <= to
}

/**
 * Reports whether a Work Item still needs work.
 *
 * @param workItem - Work Item to inspect.
 * @returns True unless the item is completed or canceled.
 */
function isOpen(workItem: CanonicalWorkItem): boolean {
  return workItem.statusCategory !== 'completed' && workItem.statusCategory !== 'canceled'
}

/**
 * Orders report items by planned end date (unscheduled last), then by key and title.
 *
 * @param left - First item.
 * @param right - Second item.
 * @returns Sort order.
 */
function compareItems(left: PersonalWeeklyReportItem, right: PersonalWeeklyReportItem): number {
  const leftDate = left.plannedEndDate ?? '9999-12-31'
  const rightDate = right.plannedEndDate ?? '9999-12-31'
  if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1
  return `${left.key ?? ''} ${left.title}`.localeCompare(`${right.key ?? ''} ${right.title}`)
}

/**
 * Builds the facts of a member's weekly report from their Work Items and time entries.
 *
 * The result is deterministic for the same inputs. It reads only the Work Items and entries passed
 * in, so it never shows a Work Item the server did not already return to the member.
 *
 * @param input - Week, today, the member's Work Items, and their time entries.
 * @returns Completed, started, overdue, and upcoming Work Items with the recorded time.
 */
export function buildPersonalWeeklyReport(input: PersonalWeeklyReportInput): PersonalWeeklyReport {
  const weekStart = input.weekDays[0] ?? input.today
  const weekEnd = input.weekDays.at(-1) ?? weekStart
  const dayAfterWeek = shiftLocalDate(weekEnd, 1) ?? weekEnd
  const overdueCutoff = input.today < dayAfterWeek ? input.today : dayAfterWeek
  const nextWeekEnd = shiftLocalDate(weekEnd, 7) ?? weekEnd

  const minutesByWorkItem = new Map<string, number>()
  let totalMinutes = 0
  for (const entry of input.entries) {
    // Split by day like the timesheet, so the totals match it for entries crossing the week edge.
    let minutes = 0
    for (const dayMinutes of splitTimeEntryMinutesByDay(entry, input.weekDays).values()) minutes += dayMinutes
    if (minutes === 0) continue
    minutesByWorkItem.set(entry.workItemId, (minutesByWorkItem.get(entry.workItemId) ?? 0) + minutes)
    totalMinutes += minutes
  }

  const completed: PersonalWeeklyReportItem[] = []
  const started: PersonalWeeklyReportItem[] = []
  const overdue: PersonalWeeklyReportItem[] = []
  const upcoming: PersonalWeeklyReportItem[] = []
  const titles = new Map<string, string>(Object.entries(input.workItemTitles ?? {}))
  for (const workItem of input.workItems) {
    titles.set(workItem.id, workItem.title)
    if (workItem.archivedAt !== undefined) continue
    const plannedEndDate = readWorkItemPlannedEndDate(workItem.schedule)
    const plannedStartDate = readWorkItemPlannedStartDate(workItem.schedule)
    const item: PersonalWeeklyReportItem = {
      id: workItem.id,
      ...(workItem.key === undefined ? {} : { key: workItem.key }),
      title: workItem.title,
      ...(plannedEndDate === undefined ? {} : { plannedEndDate }),
      minutes: minutesByWorkItem.get(workItem.id) ?? 0,
    }
    const completedThisWeek = workItem.statusCategory === 'completed' && isWithin(workItem.actualEndDate, weekStart, weekEnd)
    if (completedThisWeek) completed.push(item)
    else if (isWithin(workItem.actualStartDate, weekStart, weekEnd)) started.push(item)
    if (!isOpen(workItem)) continue
    if (plannedEndDate !== undefined && plannedEndDate < overdueCutoff) {
      overdue.push(item)
    } else if (
      workItem.statusCategory === 'started'
      || (plannedStartDate !== undefined && plannedStartDate <= nextWeekEnd)
      || (plannedEndDate !== undefined && plannedEndDate <= nextWeekEnd)
    ) {
      upcoming.push(item)
    }
  }

  const time = [...minutesByWorkItem.entries()]
    .map(([workItemId, minutes]) => ({ workItemId, title: titles.get(workItemId) ?? workItemId, minutes }))
    .sort((left, right) => right.minutes - left.minutes || left.title.localeCompare(right.title))

  return {
    weekStart,
    weekEnd,
    completed: completed.sort(compareItems),
    started: started.sort(compareItems),
    overdue: overdue.sort(compareItems),
    upcoming: upcoming.sort(compareItems),
    time,
    totalMinutes,
  }
}

/** Free text the member adds on top of the generated facts. */
export type PersonalWeeklyReportNotes = {
  /** Problems and requests for help. */
  issues: string
  /** The member's own reflection on the week. */
  reflection: string
}

/**
 * Replaces line breaks so a title stays on its Markdown list line.
 *
 * @param text - Title text.
 * @returns Single-line text.
 */
function toSingleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/gu, ' ').trim()
}

/**
 * Formats a report item as a Markdown list line.
 *
 * @param item - Report item.
 * @param t - Translator.
 * @returns List line without the trailing newline.
 */
function formatItemLine(item: PersonalWeeklyReportItem, t: (key: MessageKey) => string): string {
  const details: string[] = []
  if (item.plannedEndDate !== undefined) details.push(`${t('timeTracking.weeklyReport.due')} ${item.plannedEndDate}`)
  if (item.minutes > 0) details.push(`${t('timeTracking.weeklyReport.recorded')} ${formatMinutes(item.minutes)}`)
  const label = item.key === undefined ? toSingleLine(item.title) : `${item.key} ${toSingleLine(item.title)}`
  return `- ${label}${details.length > 0 ? ` (${details.join(', ')})` : ''}`
}

/**
 * Formats a list section, or a placeholder line when it is empty.
 *
 * @param items - Section items.
 * @param t - Translator.
 * @returns Markdown lines.
 */
function formatItemLines(items: readonly PersonalWeeklyReportItem[], t: (key: MessageKey) => string): string[] {
  return items.length === 0 ? [`- ${t('timeTracking.weeklyReport.none')}`] : items.map((item) => formatItemLine(item, t))
}

/**
 * Formats a weekly report as Markdown in the "this week / next week / issues" layout.
 *
 * @param report - Generated facts.
 * @param notes - The member's free text.
 * @param t - Translator.
 * @param options - Export options.
 * @param options.timeIsPartial - Whether only part of the time entries could be read; the
 *   recorded-time section then says so, so a short total is not shared as complete.
 * @returns Markdown text ready to paste into a report, chat, or Document.
 */
export function formatPersonalWeeklyReportMarkdown(
  report: PersonalWeeklyReport,
  notes: PersonalWeeklyReportNotes,
  t: (key: MessageKey) => string,
  options: { timeIsPartial?: boolean } = {},
): string {
  const lines: string[] = [
    `# ${t('timeTracking.weeklyReport.title')} ${report.weekStart} – ${report.weekEnd}`,
    '',
    `## ${t('timeTracking.weeklyReport.thisWeek')}`,
    '',
    `### ${t('timeTracking.weeklyReport.completed')}`,
    ...formatItemLines(report.completed, t),
    '',
    `### ${t('timeTracking.weeklyReport.started')}`,
    ...formatItemLines(report.started, t),
    '',
    `## ${t('timeTracking.weeklyReport.nextWeek')}`,
    ...formatItemLines(report.upcoming, t),
    '',
    `## ${t('timeTracking.weeklyReport.issues')}`,
    '',
    `### ${t('timeTracking.weeklyReport.overdue')}`,
    ...formatItemLines(report.overdue, t),
  ]
  if (notes.issues.trim() !== '') lines.push('', notes.issues.trim())
  lines.push(
    '',
    `## ${t('timeTracking.weeklyReport.time')}`,
    ...(options.timeIsPartial === true ? [`> ${t('timeTracking.weeklyReport.partial')}`, ''] : []),
    `- ${t('timeTracking.weeklyReport.total')} ${formatMinutes(report.totalMinutes)}`,
    ...report.time.map((row) => `- ${toSingleLine(row.title)} ${formatMinutes(row.minutes)}`),
  )
  if (notes.reflection.trim() !== '') {
    lines.push('', `## ${t('timeTracking.weeklyReport.reflection')}`, notes.reflection.trim())
  }
  return `${lines.join('\n')}\n`
}

/**
 * Builds the submission of a weekly report: only Work Item IDs and minutes are sent, and the
 * server copies each Work Item's key, title, and Project from the Work Item itself.
 *
 * @param report - Generated facts.
 * @param notes - The member's free text.
 * @param options - Submission options.
 * @param options.timeIsPartial - Whether only part of the time entries could be read.
 * @param options.expectedSubmissionCount - Versions already submitted for the week, as last read.
 * @returns The request body.
 */
export function toSubmitWeeklyReportRequest(
  report: PersonalWeeklyReport,
  notes: PersonalWeeklyReportNotes,
  options: { timeIsPartial: boolean; expectedSubmissionCount: number },
): SubmitWeeklyReportRequest {
  const rows = (items: readonly PersonalWeeklyReportItem[]) => items.map((item) => ({ workItemId: item.id, minutes: item.minutes }))
  return {
    expectedSubmissionCount: options.expectedSubmissionCount,
    sections: {
      completed: rows(report.completed),
      started: rows(report.started),
      overdue: rows(report.overdue),
      upcoming: rows(report.upcoming),
    },
    time: report.time.map((row) => ({ workItemId: row.workItemId, minutes: row.minutes })),
    totalMinutes: report.totalMinutes,
    timeIsPartial: options.timeIsPartial,
    notes: { issues: notes.issues.trim(), reflection: notes.reflection.trim() },
  }
}
