/**
 * Formats an ISO timestamp with the cadence timezone when one is configured.
 *
 * @param value - Timestamp to display.
 * @param timeZone - IANA timezone used by the update cadence.
 * @param locale - Optional BCP-47 locale; the browser locale is used by default.
 * @returns A localized date/time or an em dash for missing/invalid input.
 */
export function formatPlanningUpdateDate(
  value: string | undefined,
  timeZone?: string,
  locale?: string,
): string {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone ? { timeZone } : {}),
    }).format(date)
  } catch {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  }
}
