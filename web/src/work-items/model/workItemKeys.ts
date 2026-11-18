import { isCanonicalWorkItemKey } from '@mukuroji/contracts'

/**
 * Finds `ABC-123` keys that stand alone in text, so `x-ABC-1` or `ABC-12a` are not keys.
 * Kept in step with the key format in `@mukuroji/contracts`.
 */
const workItemKeyInTextPattern = /(?<![\p{L}\p{N}_-])[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}(?![\p{L}\p{N}_-])/gu

/** One Work Item key found in text. */
export type WorkItemKeyMatch = {
  /** The canonical key, such as `PT-12`. */
  key: string
  /** UTF-16 offset of the key in the text. */
  index: number
}

/**
 * Finds the Work Item keys written in plain text.
 *
 * @param text - Text such as a comment or a description.
 * @returns Each key in the order it appears, without duplicates removed.
 */
export function findWorkItemKeys(text: string): WorkItemKeyMatch[] {
  return Array.from(text.matchAll(workItemKeyInTextPattern), (match) => ({
    key: match[0],
    index: match.index,
  }))
}

/**
 * Reads what a person typed as a Work Item key, accepting lower case and surrounding spaces.
 *
 * @param value - Typed text, such as a search keyword.
 * @returns The canonical key, or undefined when the text is not one key.
 */
export function readWorkItemKeyInput(value: string | undefined): string | undefined {
  const candidate = value?.trim().toUpperCase()
  return candidate && isCanonicalWorkItemKey(candidate) ? candidate : undefined
}
