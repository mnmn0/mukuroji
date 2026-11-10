/** Directory resources whose identifiers are generated from their display names. */
export type DirectoryResourceKind = 'team' | 'project'

/** Longest slug kept from a display name, so generated IDs stay well inside every route and key grammar. */
const MAX_SLUG_LENGTH = 64

/** Random bytes in a fallback ID; 48 bits keep concurrent creations from choosing the same ID. */
const RANDOM_SUFFIX_BYTES = 6

/**
 * Supplies the random suffix of a fallback ID.
 *
 * @returns Lower-case hexadecimal text.
 */
type RandomSuffixSource = () => string

/**
 * Creates an ASCII identifier for a new Team or Project that is unique among the existing IDs.
 *
 * The identifier is a slug of the first candidate name that is spelled only with ASCII letters
 * and digits (accents and full-width forms are folded first), so ASCII names keep the IDs they
 * produced before. A name written in another script, such as Japanese, never becomes part of the
 * ID; when no candidate is ASCII the ID is `<kind>-<random hex>`. The fallback is random rather
 * than numbered because Project rows are not keyed by their ID alone, so two concurrent creations
 * that picked the same counter value from one directory snapshot could both commit. Every
 * generated ID matches the `A-Z a-z 0-9 . _ : -` grammar that Triage and Request intake require.
 *
 * @param kind - Resource kind used as the fallback prefix.
 * @param candidateNames - Display names in preference order, typically the Japanese then English name.
 * @param existingIds - IDs already used in the same directory.
 * @param randomSuffix - Source of the fallback suffix, replaceable in tests.
 * @returns An unused ASCII identifier.
 */
export function createDirectoryResourceId(
  kind: DirectoryResourceKind,
  candidateNames: readonly string[],
  existingIds: Iterable<string>,
  randomSuffix: RandomSuffixSource = createRandomSuffix,
): string {
  const usedIds = new Set(existingIds)
  const slug = candidateNames
    .map(createAsciiSlug)
    .find((value): value is string => value !== undefined)

  if (slug === undefined) {
    let id = `${kind}-${randomSuffix()}`

    while (usedIds.has(id)) {
      id = `${kind}-${randomSuffix()}`
    }

    return id
  }

  return usedIds.has(slug) ? findUnusedNumberedId(slug, usedIds) : slug
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
 * Creates the random hexadecimal suffix of a fallback ID.
 *
 * @returns Lower-case hexadecimal text.
 */
function createRandomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_SUFFIX_BYTES))

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Finds the first `<stem>-<n>` identifier that is not used yet.
 *
 * @param stem - Identifier stem.
 * @param usedIds - IDs already used in the same directory.
 * @returns An unused numbered identifier, starting at `<stem>-2`.
 */
function findUnusedNumberedId(stem: string, usedIds: ReadonlySet<string>): string {
  let suffix = 2

  while (usedIds.has(`${stem}-${suffix}`)) {
    suffix += 1
  }

  return `${stem}-${suffix}`
}
