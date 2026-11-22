/** Member fields that a comment composer needs to offer and resolve a display-name mention. */
export type MentionableMember = {
  /** Stable member key the server receives as the mentioned member. */
  memberKey: string
  /** Optional membership ID that older drafts may hold instead of the member key. */
  id?: string
  /** Optional email shown beside the name and used to tell apart duplicate names. */
  email?: string
  /** Optional display name inserted after the `@` marker. */
  name?: string
  /** Membership status; only active members can be mentioned. */
  status: string
}

/** One resolved mention token inside a comment body. */
export type MemberMentionRange = {
  /** Mentioned member key. */
  memberKey: string
  /** UTF-16 offset of the `@` marker. */
  offset: number
  /** UTF-16 length of the whole token, including the `@` marker. */
  length: number
}

/** The `@` query that the cursor is typing. */
export type MentionAtCursor = {
  /** UTF-16 offset of the `@` marker. */
  start: number
  /** Text typed after the `@` marker. */
  query: string
}

/** Most suggestions a composer shows at once. */
const MAX_MENTION_SUGGESTIONS = 6

/**
 * Formats the exact mention token label, including a stable discriminator for duplicate names.
 *
 * @param member - Member represented by the token.
 * @param members - Members used to detect duplicate active display names.
 * @returns Display label inserted immediately after the `@` marker.
 */
export function formatMemberMentionLabel(
  member: MentionableMember,
  members: readonly MentionableMember[],
): string {
  const displayName = formatMemberMentionName(member)
  const duplicateCount = members.filter(
    (candidate) =>
      candidate.status === 'active' && formatMemberMentionName(candidate) === displayName,
  ).length

  if (duplicateCount < 2) return displayName

  const discriminator =
    member.email && member.email !== displayName ? member.email : member.memberKey
  return `${displayName} (${discriminator})`
}

/**
 * Finds every exact, disambiguated mention token of the selected active members in a body.
 *
 * Token boundaries keep `@Ann` from matching `@Anna`, and only selected keys count, so plain text
 * never invents a mention the author did not pick in the composer.
 *
 * @param body - Comment body that may contain mention tokens.
 * @param selectedMemberKeys - Member keys picked in the composer.
 * @param members - Members used to validate status and labels.
 * @returns Token ranges ordered by offset.
 */
export function findMemberMentionRanges(
  body: string,
  selectedMemberKeys: readonly string[],
  members: readonly MentionableMember[],
): MemberMentionRange[] {
  const ranges: MemberMentionRange[] = []
  for (const selectedKey of new Set(selectedMemberKeys)) {
    const member = members.find(
      (candidate) =>
        candidate.memberKey === selectedKey ||
        candidate.id === selectedKey ||
        candidate.email === selectedKey,
    )
    if (!member || member.status !== 'active') continue

    const label = formatMemberMentionLabel(member, members)
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_@])@${escapeMentionPattern(label)}(?=$|[^\\p{L}\\p{N}_@])`,
      'gu',
    )
    for (const match of body.matchAll(pattern)) {
      const prefix = match[1] ?? ''
      ranges.push({
        memberKey: member.memberKey,
        offset: match.index + prefix.length,
        length: label.length + 1,
      })
    }
  }
  return ranges.sort((left, right) => left.offset - right.offset)
}

/**
 * Resolves the selected active members whose exact mention tokens remain in a body.
 *
 * @param body - Comment body that may contain mention tokens.
 * @param selectedMemberKeys - Member keys picked in the composer.
 * @param members - Members used to validate status and labels.
 * @returns Deduplicated member keys in the order they were picked.
 */
export function resolveMentionedMemberKeys(
  body: string,
  selectedMemberKeys: readonly string[],
  members: readonly MentionableMember[],
): string[] {
  const present = new Set(
    findMemberMentionRanges(body, selectedMemberKeys, members).map((range) => range.memberKey),
  )
  return [...new Set(selectedMemberKeys)].flatMap((selectedKey) => {
    const member = members.find(
      (candidate) =>
        candidate.memberKey === selectedKey ||
        candidate.id === selectedKey ||
        candidate.email === selectedKey,
    )
    return member && present.has(member.memberKey) ? [selectedKey] : []
  })
}

/**
 * Reads the mention query immediately before a composer cursor.
 *
 * @param value - Composer text.
 * @param cursor - UTF-16 cursor offset.
 * @returns The `@` position and query, or undefined when the cursor is not in a mention.
 */
export function readMentionAtCursor(value: string, cursor: number): MentionAtCursor | undefined {
  const match = value.slice(0, cursor).match(/(?:^|[^\p{L}\p{N}_@])@([^@\n]*)$/u)
  if (!match) return undefined
  const query = match[1] ?? ''
  return { query, start: cursor - query.length - 1 }
}

/**
 * Lists the active members whose name or email contains the typed query.
 *
 * @param members - Mention candidates.
 * @param query - Text typed after the `@` marker.
 * @returns At most six matching active members.
 */
export function filterMentionSuggestions<Member extends MentionableMember>(
  members: readonly Member[],
  query: string,
): Member[] {
  const normalizedQuery = query.trim().toLowerCase()
  return members
    .filter((member) => member.status === 'active')
    .filter((member) => !normalizedQuery || [member.name, member.email]
      .some((value) => value?.toLowerCase().includes(normalizedQuery)))
    .slice(0, MAX_MENTION_SUGGESTIONS)
}

/**
 * Tells whether a range overlaps any of the given ranges.
 *
 * @param range - UTF-16 range to test.
 * @param ranges - Ranges already claimed by display-name mentions.
 * @returns True when the two share at least one UTF-16 unit.
 */
export function overlapsMentionRanges(
  range: Pick<MemberMentionRange, 'offset' | 'length'>,
  ranges: readonly Pick<MemberMentionRange, 'offset' | 'length'>[],
): boolean {
  return ranges.some((other) =>
    range.offset < other.offset + other.length && other.offset < range.offset + range.length)
}

/**
 * Formats a member name for a mention token.
 *
 * @param member - Member represented by the token.
 * @returns Non-empty member label.
 */
function formatMemberMentionName(member: MentionableMember): string {
  return member.name?.trim() || member.email || member.memberKey
}

/**
 * Escapes a display label before embedding it into a regular expression.
 *
 * @param value - Literal display label.
 * @returns Regular-expression-safe label.
 */
function escapeMentionPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
