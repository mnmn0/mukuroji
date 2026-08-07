/**
 * Returns whether an unknown JSON value is a plain object-like record.
 *
 * @param value - Unknown value read from a JSON boundary.
 * @returns Whether the value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns whether a value is a nonnegative safe integer.
 *
 * @param value - Unknown numeric candidate.
 * @returns Whether the value is a safe integer greater than or equal to zero.
 */
export function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Returns whether a value is a positive safe integer.
 *
 * @param value - Unknown numeric candidate.
 * @returns Whether the value is a safe integer greater than or equal to one.
 */
export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Returns whether a value is a finite number.
 *
 * @param value - Unknown numeric candidate.
 * @returns Whether the value is a finite JavaScript number.
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Returns whether a value is an array containing only strings.
 *
 * @param value - Unknown array candidate.
 * @returns Whether every array entry is a string.
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Returns whether an optional field is absent or a string.
 *
 * @param value - Unknown optional-field candidate.
 * @returns Whether the value is undefined or a string.
 */
export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/**
 * Returns whether a JSON object contains only finite numeric values.
 *
 * @param value - Unknown object candidate.
 * @returns Whether the value is a string-keyed finite-number record.
 */
export function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber)
}

/**
 * Returns whether a value can safely cross a JSON data boundary.
 *
 * @param value - Unknown JSON-compatible candidate.
 * @returns Whether the value recursively contains only JSON-compatible finite values.
 */
export function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    isFiniteNumber(value)
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}
