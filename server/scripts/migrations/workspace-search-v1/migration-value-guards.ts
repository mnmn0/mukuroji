/**
 * Checks that UTF-16 text can be encoded to UTF-8 without replacement bytes.
 *
 * @param value - Candidate JavaScript string.
 * @returns Whether every surrogate code unit belongs to a valid pair.
 */
export function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

/**
 * Checks that an array has only every canonical enumerable numeric index.
 *
 * @param value - Runtime value whose callback semantics must match its length.
 * @returns Whether the value is a dense array without enumerable side properties.
 */
export function hasCanonicalDenseArrayShape(
  value: unknown,
): value is readonly unknown[] {
  if (!Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === value.length &&
    keys.every((key, index) => key === String(index))
}
