/**
 * Returns whether an unknown deep link is a same-origin application path.
 *
 * @param value - Untrusted deep-link candidate.
 * @returns Whether the value is a same-origin single-slash path without control characters or backslashes.
 */
export function isSafeApplicationPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      )
    })
  ) {
    return false
  }

  try {
    return new URL(value, 'https://mukuroji.invalid').origin === 'https://mukuroji.invalid'
  } catch {
    return false
  }
}
