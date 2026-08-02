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

/** Returns the inclusive number of calendar days in a workload date range. */
export function countWorkloadCalendarDays(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T12:00:00Z`)
  const to = Date.parse(`${toDate}T12:00:00Z`)
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1)
}

/** Adds calendar days without applying browser-local timezone arithmetic. */
export function addWorkloadCalendarDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

/** Formats a browser-local date as YYYY-MM-DD. */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}
