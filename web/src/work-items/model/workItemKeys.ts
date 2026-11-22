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
 * @param prefixes - Key prefixes that exist in the Workspace. When given, key-shaped words with
 *   another prefix, such as `UTF-8`, are not keys. When omitted, every key-shaped word counts.
 * @returns Each key in the order it appears, without duplicates removed.
 */
export function findWorkItemKeys(text: string, prefixes?: ReadonlySet<string>): WorkItemKeyMatch[] {
  return Array.from(text.matchAll(workItemKeyInTextPattern), (match) => ({
    key: match[0],
    index: match.index,
  })).filter(({ key }) => !prefixes || prefixes.has(key.slice(0, key.lastIndexOf('-'))))
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

/** Pattern of a Work Item key prefix: 2 to 10 letters or digits that start with a letter. */
const workItemKeyPrefixPattern = /^[A-Z][A-Z0-9]{1,9}$/u

/**
 * Reads what a person typed as a key prefix, accepting lower case and surrounding spaces.
 *
 * @param value - Typed prefix.
 * @returns The uppercase prefix, or undefined when it cannot be a key prefix.
 */
export function readWorkItemKeyPrefixInput(value: string): string | undefined {
  const candidate = value.trim().toUpperCase()
  return workItemKeyPrefixPattern.test(candidate) ? candidate : undefined
}

/**
 * Turns Project codes into key prefix choices: separators are dropped, the code is cut to ten
 * characters, and codes that cannot be a prefix are left out.
 *
 * @param codes - Project codes of the Team's Projects, such as `CORE-API`.
 * @returns Distinct prefix choices in the order of the codes, such as `COREAPI`.
 */
export function createWorkItemKeyPrefixChoices(codes: readonly (string | undefined)[]): string[] {
  const choices = codes.flatMap((code) => {
    const prefix = readWorkItemKeyPrefixInput((code ?? '').replace(/[^A-Za-z0-9]/gu, '').slice(0, 10))
    return prefix ? [prefix] : []
  })
  return [...new Set(choices)]
}
