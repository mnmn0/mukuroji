/** Workload date range used by the Team member screen. */
export type WorkloadDateRange = {
  /** Inclusive local start date. */
  fromDate: string
  /** Inclusive local end date. */
  toDate: string
}

/** Returns a short browser-local date range for the workload screen. */
export function createWorkloadDateRange(referenceDate = new Date(), days = 14): WorkloadDateRange {
  const from = new Date(referenceDate)
  from.setHours(12, 0, 0, 0)
  const to = new Date(from)
  to.setDate(to.getDate() + days - 1)
  return {
    fromDate: formatLocalDate(from),
    toDate: formatLocalDate(to),
  }
}

/** Formats a browser-local date as YYYY-MM-DD. */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}
