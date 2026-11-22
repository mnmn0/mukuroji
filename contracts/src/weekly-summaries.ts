import { isWeeklyReportDate } from './weekly-reports'

/** Most Work Items one section of a weekly summary lists; `count` still covers every match. */
export const WEEKLY_SUMMARY_SECTION_ITEM_LIMIT = 50

/** Sections of a Team or Project weekly summary. */
export type WeeklySummarySectionName = 'completed' | 'delayed' | 'overdue' | 'milestonesReached'

/** Every weekly summary section, in display order. */
export const WEEKLY_SUMMARY_SECTION_NAMES: readonly WeeklySummarySectionName[] = ['completed', 'delayed', 'overdue', 'milestonesReached']

/** One Work Item listed in a weekly summary section. */
export type WeeklySummaryItem = {
  /** Work Item ID within the Team. */
  workItemId: string
  /** Short reference such as `ABC-123`, when the Work Item has one. */
  key?: string
  /** Work Item title. */
  title: string
  /** Planned end date or deadline as `YYYY-MM-DD`, when the Work Item is scheduled. */
  plannedEndDate?: string
  /** Completion date as `YYYY-MM-DD`, when the Work Item is completed. */
  actualEndDate?: string
  /** Planned end date frozen in the Project schedule baseline, when the baseline has one. */
  baselineEndDate?: string
  /**
   * Calendar days behind the baseline: from the baseline end to the completion date of a Work
   * Item completed in the week, or to the current planned end of an open Work Item. Set only in
   * the `delayed` section, where it is always positive.
   */
  delayDays?: number
}

/** Count and the first Work Items of one section. */
export type WeeklySummarySection = {
  /** Every Work Item that matches the section. */
  count: number
  /** At most {@link WEEKLY_SUMMARY_SECTION_ITEM_LIMIT} of them, most urgent first. */
  items: WeeklySummaryItem[]
}

/** The schedule baseline a Project's delays are measured against. */
export type WeeklySummaryBaseline = {
  /** Baseline revision. */
  revision: number
  /** ISO timestamp of the capture. */
  capturedAt: string
}

/** Weekly summary of one Project, or of the Team's Work Items outside any Project. */
export type WeeklySummaryScope = {
  /** Project ID; absent for the Team's Work Items that belong to no Project. */
  projectId?: string
  /**
   * Latest schedule baseline of the Project, or `null` when none was captured, so delays cannot
   * be measured. Absent for Work Items outside any Project, which have no baseline.
   */
  baseline?: WeeklySummaryBaseline | null
  /** Work Items completed in the week. */
  completed: WeeklySummarySection
  /** Work Items completed in the week, or still open, later than their baseline end. */
  delayed: WeeklySummarySection
  /** Open Work Items whose planned end passed before the end of the week, or before today. */
  overdue: WeeklySummarySection
  /** Milestone Work Items completed in the week. */
  milestonesReached: WeeklySummarySection
}

/** Counts of every section across the readable scopes. */
export type WeeklySummaryTotals = Record<WeeklySummarySectionName, number>

/** Response of `GET /api/teams/:teamId/weekly-summary`. */
export type TeamWeeklySummaryResponse = {
  /** Team summarized. */
  teamId: string
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Last day of the week as `YYYY-MM-DD`. */
  weekEnd: string
  /** ISO timestamp the summary was computed at; "open" and "today" refer to this instant. */
  generatedAt: string
  /** Counts across `scopes`. */
  totals: WeeklySummaryTotals
  /**
   * Every Project of the Team the reader may read, in the Team's order, then the Work Items
   * outside any Project when the reader sees at least one. Only Work Items the reader may read
   * are counted.
   */
  scopes: WeeklySummaryScope[]
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
 * Checks whether a value is a non-negative safe integer.
 *
 * @param value - Value to check.
 * @returns Whether the value is a count.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validates one untrusted summary item.
 *
 * @param value - Candidate item.
 * @returns The item, or `undefined` when it is malformed.
 */
function parseWeeklySummaryItem(value: unknown): WeeklySummaryItem | undefined {
  if (!isRecord(value)) return undefined
  const { workItemId, key, title, plannedEndDate, actualEndDate, baselineEndDate, delayDays } = value
  if (typeof workItemId !== 'string' || workItemId.length === 0 || typeof title !== 'string') return undefined
  if (key !== undefined && typeof key !== 'string') return undefined
  for (const date of [plannedEndDate, actualEndDate, baselineEndDate]) {
    if (date !== undefined && !isWeeklyReportDate(date)) return undefined
  }
  if (delayDays !== undefined && (!isCount(delayDays) || delayDays === 0)) return undefined
  return {
    workItemId,
    ...(typeof key === 'string' ? { key } : {}),
    title,
    ...(typeof plannedEndDate === 'string' ? { plannedEndDate } : {}),
    ...(typeof actualEndDate === 'string' ? { actualEndDate } : {}),
    ...(typeof baselineEndDate === 'string' ? { baselineEndDate } : {}),
    ...(typeof delayDays === 'number' ? { delayDays } : {}),
  }
}

/**
 * Validates one untrusted section.
 *
 * @param value - Candidate section.
 * @returns The section, or `undefined` when it is malformed.
 */
function parseWeeklySummarySection(value: unknown): WeeklySummarySection | undefined {
  if (!isRecord(value) || !isCount(value.count) || !Array.isArray(value.items)) return undefined
  if (value.items.length > WEEKLY_SUMMARY_SECTION_ITEM_LIMIT || value.items.length > value.count) return undefined
  const items: WeeklySummaryItem[] = []
  for (const candidate of value.items) {
    const item = parseWeeklySummaryItem(candidate)
    if (!item) return undefined
    items.push(item)
  }
  return { count: value.count, items }
}

/**
 * Validates one untrusted scope.
 *
 * @param value - Candidate scope.
 * @returns The scope, or `undefined` when it is malformed.
 */
function parseWeeklySummaryScope(value: unknown): WeeklySummaryScope | undefined {
  if (!isRecord(value)) return undefined
  const { projectId, baseline } = value
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.length === 0)) return undefined
  let parsedBaseline: WeeklySummaryBaseline | null | undefined
  if (baseline === null) {
    parsedBaseline = null
  } else if (baseline !== undefined) {
    if (
      !isRecord(baseline) ||
      !isCount(baseline.revision) ||
      baseline.revision < 1 ||
      typeof baseline.capturedAt !== 'string' ||
      Number.isNaN(Date.parse(baseline.capturedAt))
    ) {
      return undefined
    }
    parsedBaseline = { revision: baseline.revision, capturedAt: baseline.capturedAt }
  }
  const sections: Partial<Record<WeeklySummarySectionName, WeeklySummarySection>> = {}
  for (const name of WEEKLY_SUMMARY_SECTION_NAMES) {
    const section = parseWeeklySummarySection(value[name])
    if (!section) return undefined
    sections[name] = section
  }
  const { completed, delayed, overdue, milestonesReached } = sections
  if (!completed || !delayed || !overdue || !milestonesReached) return undefined
  return {
    ...(typeof projectId === 'string' ? { projectId } : {}),
    ...(parsedBaseline === undefined ? {} : { baseline: parsedBaseline }),
    completed,
    delayed,
    overdue,
    milestonesReached,
  }
}

/**
 * Validates an untrusted Team weekly summary response.
 *
 * @param value - Parsed response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseTeamWeeklySummaryResponse(value: unknown): TeamWeeklySummaryResponse | undefined {
  if (!isRecord(value)) return undefined
  const { teamId, weekStart, weekEnd, generatedAt, totals, scopes } = value
  if (
    typeof teamId !== 'string' ||
    !isWeeklyReportDate(weekStart) ||
    !isWeeklyReportDate(weekEnd) ||
    typeof generatedAt !== 'string' ||
    Number.isNaN(Date.parse(generatedAt)) ||
    !isRecord(totals) ||
    !Array.isArray(scopes)
  ) {
    return undefined
  }
  const parsedTotals: Partial<WeeklySummaryTotals> = {}
  for (const name of WEEKLY_SUMMARY_SECTION_NAMES) {
    const count = totals[name]
    if (!isCount(count)) return undefined
    parsedTotals[name] = count
  }
  const { completed, delayed, overdue, milestonesReached } = parsedTotals
  if (completed === undefined || delayed === undefined || overdue === undefined || milestonesReached === undefined) {
    return undefined
  }
  const parsedScopes: WeeklySummaryScope[] = []
  for (const candidate of scopes) {
    const scope = parseWeeklySummaryScope(candidate)
    if (!scope) return undefined
    parsedScopes.push(scope)
  }
  return {
    teamId,
    weekStart,
    weekEnd,
    generatedAt,
    totals: { completed, delayed, overdue, milestonesReached },
    scopes: parsedScopes,
  }
}
