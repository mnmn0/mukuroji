import { PROJECT_BUDGET_REPORT_MAX_POINTS, type ProjectBudgetReportInterval, type TimeBudget } from '@mukuroji/contracts'
import { countLocalDaysBetween, shiftLocalDate } from './timePeriod'
import type { TimeReportRange } from './timeReport'

/** Days before today the report starts when no budget period says otherwise. */
const DEFAULT_LOOKBACK_DAYS = 90

/** Longest range, in days, that the report shows day by day. */
const DAILY_RANGE_MAX_DAYS = 120

/**
 * Chooses the range a Project budget report opens with: the budget period when it has both
 * ends, otherwise the 90 days up to today.
 *
 * @param budget - Project budget, if any.
 * @param today - Today's local date.
 * @returns The range.
 */
export function resolveProjectBudgetReportRange(budget: TimeBudget | null | undefined, today: string): TimeReportRange {
  if (budget?.periodFrom && budget.periodTo && budget.periodFrom <= budget.periodTo) {
    return { from: budget.periodFrom, to: budget.periodTo }
  }
  return { from: shiftLocalDate(today, -DEFAULT_LOOKBACK_DAYS) ?? today, to: today }
}

/**
 * Chooses the series bucket for a range: days up to 120 days, weeks beyond.
 *
 * @param range - Report range.
 * @returns The bucket.
 */
export function chooseProjectBudgetReportInterval(range: TimeReportRange): ProjectBudgetReportInterval {
  const days = countLocalDaysBetween(range.from, range.to) ?? 0
  return days + 1 > DAILY_RANGE_MAX_DAYS ? 'week' : 'day'
}

/**
 * Reports whether the server accepts a range for the report.
 *
 * @param range - Report range.
 * @returns Whether the range is ordered and holds at most the allowed number of weeks.
 */
export function isProjectBudgetReportRangeValid(range: TimeReportRange): boolean {
  const days = countLocalDaysBetween(range.from, range.to)
  if (days === undefined || days < 0) return false
  // Weeks start on Monday, so count the Monday-based weeks the range touches, as the server does.
  const mondayOffset = (new Date(`${range.from}T00:00:00Z`).getUTCDay() + 6) % 7
  return Math.floor((mondayOffset + days) / 7) + 1 <= PROJECT_BUDGET_REPORT_MAX_POINTS
}

/**
 * Formats a performance index such as SPI or CPI.
 *
 * @param value - Index, if known.
 * @returns Two-decimal text, or a dash when unknown.
 */
export function formatPerformanceIndex(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(2)
}

/**
 * Lists the points that a line cannot show because no known neighbour joins them, such as a
 * one-day range or a value between two missing ones, so they can be drawn as dots.
 *
 * @param values - Value per point.
 * @returns Indices of the isolated known values.
 */
export function listIsolatedPoints(values: ReadonlyArray<number | null>): number[] {
  return values.flatMap((value, index) => {
    if (value === null) return []
    const joined = (index > 0 && values[index - 1] !== null) || (index < values.length - 1 && values[index + 1] !== null)
    return joined ? [] : [index]
  })
}
