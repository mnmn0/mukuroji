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

/** Numbered prefixes (`PT`, `PT2` … `PT10`) tried before hashed ones. */
const NUMBERED_KEY_PREFIX_CANDIDATES = 10

/** Hex digits of the Team-specific hash appended to a hashed prefix candidate. */
const HASHED_KEY_PREFIX_DIGITS = 4

/**
 * Lists the key prefixes to try for a Team, in order, until one is free in the Workspace.
 *
 * The first candidates are the derived prefix and its numbered variants (`PT`, `PT2` … `PT10`).
 * After those, each candidate appends four hex digits from a hash of the Team ID and the attempt
 * (`PT3F0A`), so many Teams sharing a derived prefix, such as `team-<hex>` IDs made from non-ASCII
 * names, still find a free one. The list depends only on the Team ID, so concurrent first
 * allocations for the same Team try the same prefixes in the same order.
 *
 * @param teamId - Canonical Team ID.
 * @param limit - Number of candidates to produce.
 * @returns Distinct prefix candidates, each valid under the Work Item key grammar.
 */
export function createWorkItemKeyPrefixCandidates(teamId: string, limit: number): string[] {
  const base = deriveWorkItemKeyPrefix(teamId)
  const candidates = [base]
  for (let suffix = 2; candidates.length < Math.min(limit, NUMBERED_KEY_PREFIX_CANDIDATES); suffix += 1) {
    const suffixText = String(suffix)
    candidates.push(`${base.slice(0, KEY_PREFIX_MAX_LENGTH - suffixText.length)}${suffixText}`)
  }
  const seen = new Set(candidates)
  for (let attempt = 0; candidates.length < limit; attempt += 1) {
    const digits = hashTeamPrefixAttempt(teamId, attempt).slice(0, HASHED_KEY_PREFIX_DIGITS)
    const candidate = `${base}${digits}`
    if (seen.has(candidate)) continue
    seen.add(candidate)
    candidates.push(candidate)
  }
  return candidates
}

/**
 * Hashes a Team ID and an attempt number with 32-bit FNV-1a.
 *
 * @param teamId - Canonical Team ID.
 * @param attempt - Zero-based hashed candidate number.
 * @returns Eight uppercase hex digits.
 */
function hashTeamPrefixAttempt(teamId: string, attempt: number): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(`${teamId}\0${attempt}`)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).toUpperCase().padStart(8, '0')
}
