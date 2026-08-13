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
