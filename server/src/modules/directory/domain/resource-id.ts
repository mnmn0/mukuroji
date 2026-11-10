/** Directory resources whose identifiers are generated from their display names. */
export type DirectoryResourceKind = 'team' | 'project'

/** Longest slug kept from a display name, so generated IDs stay well inside every route and key grammar. */
const MAX_SLUG_LENGTH = 64

/**
 * Creates an ASCII identifier for a new Team or Project that is unique among the existing IDs.
 *
 * The identifier is a slug of the first candidate name that is spelled only with ASCII letters
 * and digits (accents and full-width forms are folded first), so ASCII names keep the IDs they
 * produced before. A name written in another script, such as Japanese, never becomes part of the
 * ID; when no candidate is ASCII the ID is a numbered `<kind>-<n>` value. Every generated ID
 * therefore matches the `A-Z a-z 0-9 . _ : -` grammar that Triage and Request intake require.
 *
 * @param kind - Resource kind used for the numbered fallback.
 * @param candidateNames - Display names in preference order, typically the Japanese then English name.
 * @param existingIds - IDs already used in the same directory.
 * @returns An unused ASCII identifier.
 */
export function createDirectoryResourceId(
  kind: DirectoryResourceKind,
  candidateNames: readonly string[],
  existingIds: Iterable<string>,
): string {
  const usedIds = new Set(existingIds)
  const slug = candidateNames
    .map(createAsciiSlug)
    .find((value): value is string => value !== undefined)

  if (slug === undefined) {
    return findUnusedNumberedId(kind, 1, usedIds)
  }

  return usedIds.has(slug) ? findUnusedNumberedId(slug, 2, usedIds) : slug
}

/**
 * Converts a display name into an ASCII slug when the name is spelled only with ASCII letters and digits.
 *
 * @param value - Untrusted display name.
 * @returns The lower-case slug, or undefined when the name has no ASCII letters or digits or contains other scripts.
 */
function createAsciiSlug(value: string): string | undefined {
  const folded = value
    .trim()
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase()
  const lettersAndDigits = folded.replace(/[^\p{Letter}\p{Number}]+/gu, '')

  if (!/^[a-z0-9]+$/u.test(lettersAndDigits)) {
    return undefined
  }

  const slug = folded
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/u, '')

  return slug || undefined
}

/**
 * Finds the first `<stem>-<n>` identifier that is not used yet.
 *
 * @param stem - Identifier stem.
 * @param firstSuffix - First number to try.
 * @param usedIds - IDs already used in the same directory.
 * @returns An unused numbered identifier.
 */
function findUnusedNumberedId(stem: string, firstSuffix: number, usedIds: ReadonlySet<string>): string {
  let suffix = firstSuffix

  while (usedIds.has(`${stem}-${suffix}`)) {
    suffix += 1
  }

  return `${stem}-${suffix}`
}
