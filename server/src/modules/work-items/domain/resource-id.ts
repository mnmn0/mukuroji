/**
 * Converts display text into a stable resource identifier stem.
 *
 * @param value - Untrusted display text.
 * @returns A normalized identifier or a timestamp-based fallback.
 */
export function createResourceId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || `item-${Date.now()}`
}
