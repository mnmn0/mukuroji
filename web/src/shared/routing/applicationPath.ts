/**
 * Returns whether an unknown deep link is a same-origin application path.
 *
 * @param value - Untrusted deep-link candidate.
 * @returns Whether the value is a single-slash absolute path without backslashes.
 */
export function isSafeApplicationPath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\')
}
