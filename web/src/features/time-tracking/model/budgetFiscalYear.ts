import { workspaceFiscalYearContaining } from '@mukuroji/contracts'

/** One fiscal year a budget period can be set to. */
export type TimeBudgetFiscalYearOption = {
  /** Fiscal year, named by the calendar year it starts in. */
  fiscalYear: number
  /** First local date of the fiscal year. */
  from: string
  /** Last local date of the fiscal year, inclusive. */
  to: string
}

/**
 * Lists the fiscal years a budget period is usually set to: the previous, current, and next
 * fiscal year of the Workspace.
 *
 * @param today - Today's local `YYYY-MM-DD` date in the Workspace time zone.
 * @param fiscalYearStartMonth - First month of the Workspace fiscal year, from 1 to 12.
 * @returns The three fiscal years in ascending order.
 * @throws RangeError When the date or the month is invalid.
 */
export function listTimeBudgetFiscalYearOptions(
  today: string,
  fiscalYearStartMonth: number,
): TimeBudgetFiscalYearOption[] {
  const current = workspaceFiscalYearContaining(today, fiscalYearStartMonth)
  return [current.fiscalYear - 1, current.fiscalYear, current.fiscalYear + 1].map((fiscalYear) => {
    // The fiscal year starts on the first day of its start month in the year it is named by.
    const firstDay = `${String(fiscalYear).padStart(4, '0')}-${String(fiscalYearStartMonth).padStart(2, '0')}-01`
    const { range } = workspaceFiscalYearContaining(firstDay, fiscalYearStartMonth)
    return { fiscalYear, from: range.from, to: range.to }
  })
}

/**
 * Finds the fiscal year a budget period covers exactly, so the period can be named by it.
 *
 * @param periodFrom - Inclusive first date of the budget period.
 * @param periodTo - Inclusive last date of the budget period.
 * @param fiscalYearStartMonth - First month of the Workspace fiscal year, from 1 to 12.
 * @returns The fiscal year, or undefined when the period is open or not exactly one fiscal year.
 */
export function findTimeBudgetFiscalYear(
  periodFrom: string | undefined,
  periodTo: string | undefined,
  fiscalYearStartMonth: number,
): number | undefined {
  if (!periodFrom || !periodTo) return undefined
  try {
    const { fiscalYear, range } = workspaceFiscalYearContaining(periodFrom, fiscalYearStartMonth)
    return range.from === periodFrom && range.to === periodTo ? fiscalYear : undefined
  } catch {
    return undefined
  }
}
