/**
 * Parses a non-negative integer from a cadence form value.
 *
 * @param value - Raw FormData value.
 * @returns A non-negative integer, or undefined for empty or invalid input.
 */
export function readNonNegativeNumber(value: FormDataEntryValue | null): number | undefined {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Checks that a submitted cadence deadline includes an explicit timezone offset.
 *
 * @param value - Candidate ISO timestamp from the cadence form.
 * @returns Whether the timestamp is parseable and timezone-qualified.
 */
export function isValidPlanningDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value)) &&
    /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
}
