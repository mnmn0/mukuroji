/** Longest key prefix derived automatically from a Team ID, before any collision suffix. */
const DERIVED_KEY_PREFIX_MAX_LENGTH = 4

/** Longest key prefix accepted by the Work Item key grammar. */
const KEY_PREFIX_MAX_LENGTH = 10

/** Prefix used when a Team ID has no ASCII letter to build one from. */
const FALLBACK_KEY_PREFIX = 'WI'

/**
 * Derives the preferred Work Item key prefix for a Team from its ID.
 *
 * Team IDs are ASCII slugs such as `platform-team` or `team-1a2b3c4d5e6f`. A multi-word slug
 * whose words all start with a letter becomes its initials (`platform-team` → `PT`); otherwise
 * the slug is shortened (`backend` → `BACK`, `team-1a2b…` → `TEAM`).
 *
 * @param teamId - Canonical Team ID.
 * @returns A prefix of two to four uppercase letters or digits that starts with a letter.
 */
export function deriveWorkItemKeyPrefix(teamId: string): string {
  const words = teamId
    .normalize('NFKC')
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter((word) => word.length > 0)
  const candidate = words.length >= 2 && words.every((word) => /^[A-Z]/u.test(word))
    ? words.map((word) => word.charAt(0)).join('')
    : words.join('').replace(/^[0-9]+/u, '')
  const prefix = candidate.slice(0, DERIVED_KEY_PREFIX_MAX_LENGTH)
  return prefix.length >= 2 ? prefix : FALLBACK_KEY_PREFIX
}

/**
 * Lists the key prefixes to try for a Team, in order, until one is free in the Workspace.
 *
 * @param teamId - Canonical Team ID.
 * @param limit - Number of candidates to produce.
 * @returns The derived prefix followed by numbered variants (`PT`, `PT2`, `PT3`, …).
 */
export function createWorkItemKeyPrefixCandidates(teamId: string, limit: number): string[] {
  const base = deriveWorkItemKeyPrefix(teamId)
  const candidates = [base]
  for (let suffix = 2; candidates.length < limit; suffix += 1) {
    const suffixText = String(suffix)
    candidates.push(`${base.slice(0, KEY_PREFIX_MAX_LENGTH - suffixText.length)}${suffixText}`)
  }
  return candidates
}
