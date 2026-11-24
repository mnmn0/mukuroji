import { MAX_WORKSPACE_TIME_ENTRY_CATEGORIES, readTimeEntryCategoryKey } from './time-entry-categories'
import type { TimeEntryCategory } from './time-tracking'

/** Sections of a weekly report that list Work Items. */
export type WeeklyReportSectionName = 'completed' | 'started' | 'overdue' | 'upcoming'

/** Every Work Item section of a weekly report in display order. */
export const WEEKLY_REPORT_SECTION_NAMES: readonly WeeklyReportSectionName[] = ['completed', 'started', 'overdue', 'upcoming']

/** Maximum length of each free-text note of a weekly report. */
export const WEEKLY_REPORT_NOTE_MAX_LENGTH = 4_000
/** Most distinct Work Items one submitted weekly report may reference. */
export const WEEKLY_REPORT_MAX_WORK_ITEMS = 150
/** Most versions a member may submit for one week. */
export const WEEKLY_REPORT_MAX_SUBMISSIONS = 10
/** Largest number of minutes one report row or total may carry: every minute of 31 days. */
export const WEEKLY_REPORT_MAX_MINUTES = 31 * 24 * 60
/** Largest page size of the weekly report history. */
export const WEEKLY_REPORT_HISTORY_MAX_PAGE_SIZE = 52

/** Pattern of a `YYYY-MM-DD` date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
/**
 * Control characters other than tab, line feed, and carriage return, rejected in notes so a
 * stored report's JSON size stays close to its length.
 */
// eslint-disable-next-line no-control-regex -- these control characters are what the check rejects.
const DISALLOWED_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
/** A UTF-16 surrogate without its pair, which JSON escapes to six bytes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** Longest Work Item ID a report row may reference. */
const WORK_ITEM_ID_MAX_LENGTH = 256

/** Free text the member writes on top of the generated facts. */
export type WeeklyReportNotes = {
  /** Problems and requests for help. */
  issues: string
  /** The member's own reflection on the week. */
  reflection: string
}

/** One Work Item reference sent by the member's client; the server resolves its title and Project. */
export type WeeklyReportItemInput = {
  /** Work Item ID within the Team. */
  workItemId: string
  /** Minutes the member recorded against the Work Item in the week. */
  minutes: number
}

/**
 * Minutes the member recorded as indirect work (time without a Work Item, such as a meeting) in one
 * work category during the week.
 */
export type WeeklyReportIndirectTime = {
  /** Work category of the indirect work. */
  category: TimeEntryCategory
  /** Minutes recorded in the category in the week. */
  minutes: number
}

/** Request body that saves the member's notes for a week without submitting. */
export type SaveWeeklyReportDraftRequest = {
  /** Draft revision read before the change; 0 when no draft exists yet. */
  expectedRevision: number
  /** Notes to keep. */
  notes: WeeklyReportNotes
}

/** Request body that submits one version of a weekly report. */
export type SubmitWeeklyReportRequest = {
  /** Number of versions already submitted for the week, as last read; guards against double submission. */
  expectedSubmissionCount: number
  /** Saved revision the submitted notes were edited from; 0 when nothing was saved. Guards against replacing notes saved elsewhere. */
  expectedRevision: number
  /** Work Items listed in each section, in display order. */
  sections: Record<WeeklyReportSectionName, WeeklyReportItemInput[]>
  /** Recorded time per Work Item, largest first. */
  time: WeeklyReportItemInput[]
  /** Recorded indirect work per work category, largest first; treated as empty when omitted. */
  indirectTime?: WeeklyReportIndirectTime[]
  /** Total recorded minutes in the week. */
  totalMinutes: number
  /** Whether only part of the member's time entries could be read when the report was drafted. */
  timeIsPartial: boolean
  /** Notes submitted with this version; also saved as the week's draft. */
  notes: WeeklyReportNotes
}

/** A Work Item of a stored report, as the server resolved it when the report was submitted. */
export type WeeklyReportStoredItem = {
  /** Work Item ID within the Team. */
  workItemId: string
  /** Short reference such as `ABC-123`, when the Work Item had one. */
  key?: string
  /** Work Item title at submission. */
  title: string
  /** Project the Work Item belonged to at submission; absent for a Team-level Work Item. */
  projectId?: string
  /** Planned end date as `YYYY-MM-DD` at submission, when scheduled. */
  plannedEndDate?: string
}

/** A Work Item row as one reader sees it. */
export type WeeklyReportItemView =
  | {
      /** The reader may read the Work Item. */
      hidden: false
      /** Work Item ID within the Team. */
      workItemId: string
      /** Short reference such as `ABC-123`, when the Work Item had one. */
      key?: string
      /** Work Item title at submission. */
      title: string
      /** Planned end date as `YYYY-MM-DD` at submission, when scheduled. */
      plannedEndDate?: string
      /** Minutes the author recorded against it in the week. */
      minutes: number
    }
  | {
      /** The reader may not read the Work Item, so its identity is withheld. */
      hidden: true
      /** Minutes the author recorded against it in the week. */
      minutes: number
    }

/** One submitted version of a weekly report, filtered for the reader. */
export type WeeklyReportSubmission = {
  /** Version number, 1 for the first submission of the week. */
  version: number
  /** ISO timestamp of the submission. */
  submittedAt: string
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Last day of the week as `YYYY-MM-DD`. */
  weekEnd: string
  /** Work Items listed in each section. */
  sections: Record<WeeklyReportSectionName, WeeklyReportItemView[]>
  /** Recorded time per Work Item. */
  time: WeeklyReportItemView[]
  /** Recorded indirect work per work category. */
  indirectTime: WeeklyReportIndirectTime[]
  /** Total recorded minutes the author reported. */
  totalMinutes: number
  /** Whether the author's time was only partly read when the report was drafted. */
  timeIsPartial: boolean
  /** Notes submitted with this version. */
  notes: WeeklyReportNotes
}

/** The member's unsubmitted notes for a week, returned only to the member. */
export type WeeklyReportDraft = {
  /** Increments with every saved change. */
  revision: number
  /** ISO timestamp of the last saved change. */
  updatedAt: string
  /** Saved notes. */
  notes: WeeklyReportNotes
}

/** Response of the weekly report read, save, and submit endpoints. */
export type WeeklyReportResponse = {
  /** Team the report belongs to. */
  teamId: string
  /** Normalized member key of the author. */
  memberKey: string
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Number of versions submitted for the week. */
  submissionCount: number
  /** The author's saved notes; present only for the author, and absent when nothing was saved. */
  draft?: WeeklyReportDraft
  /** The latest submitted version, or the requested one; absent when nothing was submitted. */
  submission?: WeeklyReportSubmission
}

/** One week of a member's weekly report history. */
export type WeeklyReportHistoryEntry = {
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Number of versions submitted for the week; 0 when only notes were saved. */
  submissionCount: number
  /** ISO timestamp of the latest submission, when one exists. */
  lastSubmittedAt?: string
}

/** Response of the weekly report history endpoint. */
export type WeeklyReportHistoryResponse = {
  /** Team the reports belong to. */
  teamId: string
  /** Normalized member key of the author. */
  memberKey: string
  /** Weeks, newest first. Other readers than the author see only submitted weeks. */
  weeks: WeeklyReportHistoryEntry[]
  /** Opaque cursor of the next page, when more weeks exist. */
  nextCursor?: string
}

/** Submission state of one member for one week, as a manager sees it. */
export type TeamWeeklyReportMemberStatus = {
  /** Normalized member key. */
  memberKey: string
  /** Display name, when the directory has one. */
  displayName?: string
  /** Number of versions submitted for the week; 0 when not submitted. */
  submissionCount: number
  /** ISO timestamp of the latest submission, when one exists. */
  lastSubmittedAt?: string
  /**
   * First day of the stored week the status comes from, present only when it differs from the
   * requested week because the report was submitted under an earlier Workspace week start.
   */
  weekStart?: string
}

/** Response of the Team weekly report status endpoint. */
export type TeamWeeklyReportStatusResponse = {
  /** Team whose members are listed. */
  teamId: string
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Members whose reports the requesting manager may read, by display name. */
  members: TeamWeeklyReportMemberStatus[]
}

/** Result of validating untrusted input. */
export type WeeklyReportParseResult<T> =
  | {
      /** The input is valid. */
      ok: true
      /** Normalized input. */
      value: T
    }
  | {
      /** The input is invalid. */
      ok: false
      /** Safe explanation of the first problem found. */
      message: string
    }

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a value is a real calendar date in `YYYY-MM-DD`.
 *
 * @param value - Value to check.
 * @returns Whether the value is a valid date string.
 */
export function isWeeklyReportDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Returns the last day of a seven-day week.
 *
 * @param weekStart - First day as `YYYY-MM-DD`.
 * @returns The sixth day after it as `YYYY-MM-DD`.
 */
export function weeklyReportWeekEnd(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 6)
  return date.toISOString().slice(0, 10)
}

/**
 * Checks whether a value is a whole number of minutes a report may carry.
 *
 * @param value - Value to check.
 * @returns Whether the value is an integer from 0 to {@link WEEKLY_REPORT_MAX_MINUTES}.
 */
function isMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= WEEKLY_REPORT_MAX_MINUTES
}

/**
 * Validates untrusted notes, trimming surrounding whitespace.
 *
 * @param value - Untrusted notes.
 * @returns Normalized notes or the first problem found.
 */
export function parseWeeklyReportNotes(value: unknown): WeeklyReportParseResult<WeeklyReportNotes> {
  if (!isRecord(value)) return { ok: false, message: 'notes must be an object.' }
  const notes: WeeklyReportNotes = { issues: '', reflection: '' }
  for (const field of ['issues', 'reflection'] as const) {
    const raw = value[field]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string') return { ok: false, message: `notes.${field} must be a string.` }
    const text = raw.trim()
    if (text.length > WEEKLY_REPORT_NOTE_MAX_LENGTH) {
      return { ok: false, message: `notes.${field} must be at most ${WEEKLY_REPORT_NOTE_MAX_LENGTH} characters.` }
    }
    if (DISALLOWED_CONTROL_CHARACTER.test(text) || LONE_SURROGATE.test(text)) {
      return { ok: false, message: `notes.${field} contains characters that cannot be stored.` }
    }
    notes[field] = text
  }
  return { ok: true, value: notes }
}

/**
 * Validates an untrusted list of Work Item rows.
 *
 * @param value - Untrusted list.
 * @param label - Field name used in messages.
 * @returns The rows, or the first problem found.
 */
function parseItemInputs(value: unknown, label: string): WeeklyReportParseResult<WeeklyReportItemInput[]> {
  if (!Array.isArray(value)) return { ok: false, message: `${label} must be an array.` }
  if (value.length > WEEKLY_REPORT_MAX_WORK_ITEMS) {
    return { ok: false, message: `${label} may list at most ${WEEKLY_REPORT_MAX_WORK_ITEMS} Work Items.` }
  }
  const rows: WeeklyReportItemInput[] = []
  const seen = new Set<string>()
  for (const row of value) {
    if (!isRecord(row)) return { ok: false, message: `${label} rows must be objects.` }
    const workItemId = typeof row.workItemId === 'string' ? row.workItemId.trim() : ''
    if (workItemId.length === 0 || workItemId.length > WORK_ITEM_ID_MAX_LENGTH) {
      return { ok: false, message: `${label} rows need a workItemId.` }
    }
    if (!isMinutes(row.minutes)) return { ok: false, message: `${label} minutes must be a whole number of minutes.` }
    // A Work Item listed twice in one section adds nothing, so later copies are dropped.
    if (seen.has(workItemId)) continue
    seen.add(workItemId)
    rows.push({ workItemId, minutes: row.minutes })
  }
  return { ok: true, value: rows }
}

/**
 * Validates indirect-work rows, one per work category.
 *
 * @param value - Untrusted rows.
 * @param label - Field name used in messages.
 * @returns The rows, or the first problem found.
 */
export function parseWeeklyReportIndirectTime(
  value: unknown,
  label = 'indirectTime',
): WeeklyReportParseResult<WeeklyReportIndirectTime[]> {
  if (!Array.isArray(value)) return { ok: false, message: `${label} must be an array.` }
  if (value.length > MAX_WORKSPACE_TIME_ENTRY_CATEGORIES) {
    return { ok: false, message: `${label} may list each work category once.` }
  }
  const rows: WeeklyReportIndirectTime[] = []
  const seen = new Set<TimeEntryCategory>()
  for (const row of value) {
    const category = isRecord(row) ? readTimeEntryCategoryKey(row.category) : undefined
    if (!isRecord(row) || category === undefined) {
      return { ok: false, message: `${label} rows need a valid work category key.` }
    }
    if (!isMinutes(row.minutes)) return { ok: false, message: `${label} minutes must be a whole number of minutes.` }
    if (seen.has(category)) return { ok: false, message: `${label} may list each work category once.` }
    seen.add(category)
    rows.push({ category, minutes: row.minutes })
  }
  return { ok: true, value: rows }
}

/**
 * Validates an untrusted submission body.
 *
 * @param value - Untrusted request body.
 * @returns The normalized submission or the first problem found.
 */
export function parseSubmitWeeklyReportRequest(value: unknown): WeeklyReportParseResult<SubmitWeeklyReportRequest> {
  if (!isRecord(value)) return { ok: false, message: 'The request body must be an object.' }
  const expected = value.expectedSubmissionCount
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
    return { ok: false, message: 'expectedSubmissionCount must be a non-negative integer.' }
  }
  const expectedRevision = value.expectedRevision
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, message: 'expectedRevision must be a non-negative integer.' }
  }
  const rawSections = value.sections
  if (!isRecord(rawSections)) return { ok: false, message: 'sections must be an object.' }
  const completed = parseItemInputs(rawSections.completed ?? [], 'sections.completed')
  if (!completed.ok) return completed
  const started = parseItemInputs(rawSections.started ?? [], 'sections.started')
  if (!started.ok) return started
  const overdue = parseItemInputs(rawSections.overdue ?? [], 'sections.overdue')
  if (!overdue.ok) return overdue
  const upcoming = parseItemInputs(rawSections.upcoming ?? [], 'sections.upcoming')
  if (!upcoming.ok) return upcoming
  const sections: Record<WeeklyReportSectionName, WeeklyReportItemInput[]> = {
    completed: completed.value,
    started: started.value,
    overdue: overdue.value,
    upcoming: upcoming.value,
  }
  const time = parseItemInputs(value.time ?? [], 'time')
  if (!time.ok) return time
  const indirectTime = parseWeeklyReportIndirectTime(value.indirectTime ?? [])
  if (!indirectTime.ok) return indirectTime
  const distinct = new Set<string>()
  for (const rows of [...Object.values(sections), time.value]) {
    for (const row of rows) distinct.add(row.workItemId)
  }
  if (distinct.size > WEEKLY_REPORT_MAX_WORK_ITEMS) {
    return { ok: false, message: `A weekly report may reference at most ${WEEKLY_REPORT_MAX_WORK_ITEMS} Work Items.` }
  }
  if (!isMinutes(value.totalMinutes)) return { ok: false, message: 'totalMinutes must be a whole number of minutes.' }
  if (value.timeIsPartial !== undefined && typeof value.timeIsPartial !== 'boolean') {
    return { ok: false, message: 'timeIsPartial must be a boolean.' }
  }
  const notes = parseWeeklyReportNotes(value.notes)
  if (!notes.ok) return notes
  return {
    ok: true,
    value: {
      expectedSubmissionCount: expected,
      expectedRevision,
      sections,
      time: time.value,
      indirectTime: indirectTime.value,
      totalMinutes: value.totalMinutes,
      timeIsPartial: value.timeIsPartial === true,
      notes: notes.value,
    },
  }
}
