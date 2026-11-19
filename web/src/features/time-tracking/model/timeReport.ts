import type { TimeBudget, TimeTrackingGroupBy, TimeTrackingSummary } from '@mukuroji/contracts'
import type { Locale } from '../../../shared/i18n/i18n'
import { countLocalDaysBetween, createWeekPeriod, resolveWeekStart } from './timePeriod'

/** Inclusive local date range of a report. */
export type TimeReportRange = {
  /** Inclusive start as `YYYY-MM-DD`. */
  from: string
  /** Inclusive end as `YYYY-MM-DD`. */
  to: string
}

/** Groupings offered by the report, in display order. */
export const timeReportGroupings: readonly TimeTrackingGroupBy[] = ['day', 'week', 'user', 'project', 'work-item']

/** Budget compared with the actual cost recorded in the report period. */
export type TimeBudgetComparison = {
  /** Budget being compared. */
  budget: TimeBudget
  /** Actual cost in the budget currency, in minor units. */
  actualMinor: number
  /** Budget left, in minor units; negative when overspent. Undefined when costs in other currencies exist. */
  remainingMinor?: number
  /**
   * Share of the budget used, as a whole percentage; undefined for a zero budget or when costs in
   * other currencies exist.
   */
  usedPercent?: number
  /** Actual costs in currencies other than the budget's, which are not converted. */
  otherCurrencyCosts: Readonly<Record<string, number>>
  /**
   * Whether the actual cost may leave out part of the scope. Team totals include only the Projects
   * the member manages, and never time without a Project, so a Team comparison is always partial.
   */
  isPartialScope: boolean
  /** Minutes recorded against the scope in the report period. */
  actualMinutes: number
}

/**
 * Reads a grouping from a URL value.
 *
 * @param value - URL value.
 * @returns A known grouping; `day` for anything else.
 */
export function resolveTimeReportGroupBy(value: string | null | undefined): TimeTrackingGroupBy {
  return timeReportGroupings.find((grouping) => grouping === value) ?? 'day'
}

/**
 * Reads a report range from URL values, falling back to the current week.
 *
 * @param from - Inclusive start from the URL.
 * @param to - Inclusive end from the URL.
 * @param today - Current instant used for the fallback week.
 * @returns Range with valid local dates; the start may still be after the end.
 */
export function resolveTimeReportRange(
  from: string | null | undefined,
  to: string | null | undefined,
  today: Date = new Date(),
): TimeReportRange {
  const week = createWeekPeriod(resolveWeekStart(null, today))
  const fallback = { from: week.days[0] ?? '', to: week.days.at(-1) ?? '' }
  if (!from || !to || countLocalDaysBetween(from, to) === undefined) return fallback
  return { from, to }
}

/**
 * Returns whether a range has its start on or before its end.
 *
 * @param range - Inclusive local range.
 * @returns Whether the range can be requested.
 */
export function isTimeReportRangeOrdered(range: TimeReportRange): boolean {
  const days = countLocalDaysBetween(range.from, range.to)
  return days !== undefined && days >= 0
}

/**
 * Returns how many digits after the decimal point a currency uses.
 *
 * @param currency - ISO 4217 code.
 * @returns Fraction digits; 2 for a code the runtime does not know.
 */
export function readCurrencyFractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/**
 * Formats an amount held in minor currency units.
 *
 * @param amountMinor - Amount in minor units.
 * @param currency - ISO 4217 code.
 * @param locale - Display locale.
 * @returns Localized money text.
 */
export function formatMinorAmount(amountMinor: number, currency: string, locale: Locale): string {
  const digits = readCurrencyFractionDigits(currency)
  const amount = amountMinor / 10 ** digits
  try {
    return new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(digits)} ${currency}`
  }
}

/**
 * Formats per-currency totals, one amount per currency.
 *
 * @param amounts - Minor-unit totals keyed by currency.
 * @param locale - Display locale.
 * @returns Joined money text, or an empty string without amounts.
 */
export function formatCostsByCurrency(amounts: Readonly<Record<string, number>> | undefined, locale: Locale): string {
  if (!amounts) return ''
  return Object.entries(amounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => formatMinorAmount(amount, currency, locale))
    .join(' / ')
}

/**
 * Converts a typed amount, such as `1200` or `12.50`, to minor currency units.
 *
 * @param value - Typed amount in major units.
 * @param currency - ISO 4217 code that decides the allowed decimals.
 * @returns Minor units, or undefined for text that is not a non-negative amount of that currency.
 */
export function parseMajorAmount(value: string, currency: string): number | undefined {
  const text = value.trim().replaceAll(',', '')
  const digits = readCurrencyFractionDigits(currency)
  const pattern = digits === 0 ? /^\d+$/u : new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`, 'u')
  if (!pattern.test(text)) return undefined
  const [whole = '0', fraction = ''] = text.split('.')
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0')
  return Number.isSafeInteger(minor) ? minor : undefined
}

/**
 * Formats minor units as the plain amount shown in an input.
 *
 * @param amountMinor - Amount in minor units.
 * @param currency - ISO 4217 code.
 * @returns Amount in major units without grouping.
 */
export function toMajorAmountInput(amountMinor: number, currency: string): string {
  const digits = readCurrencyFractionDigits(currency)
  return (amountMinor / 10 ** digits).toFixed(digits)
}

/**
 * Compares a budget with the actual cost recorded in a project-grouped report.
 *
 * @param summary - Report grouped by Project that carries the budget.
 * @param projectId - Project of a Project budget; omitted for the Team budget.
 * @returns Comparison, or undefined when the report carries no budget.
 */
export function compareTimeBudget(summary: TimeTrackingSummary, projectId?: string): TimeBudgetComparison | undefined {
  const budget = summary.budget
  if (!budget) return undefined
  const group = projectId === undefined ? undefined : summary.groups.find((candidate) => candidate.key === projectId)
  const costs = projectId === undefined ? summary.totalActualCostByCurrency : group?.actualCostByCurrency
  const actualMinor = costs?.[budget.currency] ?? 0
  const otherCurrencyCosts = Object.fromEntries(Object.entries(costs ?? {})
    .filter(([currency, amount]) => currency !== budget.currency && amount !== 0))
  const isPartialScope = projectId === undefined
  // Unconverted currencies or costs outside the member's Projects would overstate what is left.
  const isComplete = !isPartialScope && Object.keys(otherCurrencyCosts).length === 0
  return {
    budget,
    actualMinor,
    otherCurrencyCosts,
    isPartialScope,
    ...(isComplete ? { remainingMinor: budget.amountMinor - actualMinor } : {}),
    ...(isComplete && budget.amountMinor > 0 ? { usedPercent: Math.round((actualMinor / budget.amountMinor) * 100) } : {}),
    actualMinutes: projectId === undefined ? summary.totalMinutes : group?.minutes ?? 0,
  }
}

/**
 * Builds the file name of a CSV export.
 *
 * @param range - Exported period.
 * @param groupBy - Exported grouping.
 * @returns File name.
 */
export function createTimeReportFileName(range: TimeReportRange, groupBy: TimeTrackingGroupBy): string {
  return `mukuroji-time-${range.from}_${range.to}-${groupBy}.csv`
}
