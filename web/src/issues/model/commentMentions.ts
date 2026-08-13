import type { WorkspaceMember } from '../../workspace/api'

/**
 * Formats the exact mention token label, including a stable discriminator for duplicate names.
 *
 * @param member - Workspace member represented by the token.
 * @param members - Members used to detect duplicate active display names.
 * @returns Display label inserted immediately after the `@` marker.
 */
export function formatIssueMentionLabel(
  member: WorkspaceMember,
  members: readonly WorkspaceMember[],
): string {
  const displayName = formatIssueMentionMemberName(member, member.memberKey)
  const duplicateCount = members.filter(
    (candidate) =>
      candidate.status === 'active' &&
      formatIssueMentionMemberName(candidate, candidate.memberKey) ===
        displayName,
  ).length

  if (duplicateCount < 2) return displayName

  const discriminator =
    member.email && member.email !== displayName
      ? member.email
      : member.memberKey
  return `${displayName} (${discriminator})`
}

/**
 * Resolves active member keys whose exact, disambiguated mention tokens remain in Markdown.
 *
 * Token boundaries prevent `@Ann` from matching `@Anna`, and selected keys prevent plain text
 * from inventing a mention that the author did not choose in the composer.
 *
 * @param bodyMarkdown - Human-authored Markdown containing possible mention tokens.
 * @param selectedMemberKeys - Member keys selected by a composer or eligible for draft parsing.
 * @param members - Workspace members used to validate status and labels.
 * @returns Deduplicated active member keys with exact tokens in the body.
 */
export function resolveIssueMentionMemberKeys(
  bodyMarkdown: string,
  selectedMemberKeys: readonly string[],
  members: readonly WorkspaceMember[],
): string[] {
  return Array.from(new Set(selectedMemberKeys)).filter((memberKey) => {
    const member = members.find(
      (candidate) =>
        candidate.memberKey === memberKey ||
        candidate.id === memberKey ||
        candidate.email === memberKey,
    )

    if (!member || member.status !== 'active') return false

    const escapedName = escapeIssueMentionPattern(
      formatIssueMentionLabel(member, members),
    )
    const mentionPattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_@])@${escapedName}(?=$|[^\\p{L}\\p{N}_@])`,
      'u',
    )
    return mentionPattern.test(bodyMarkdown)
  })
}

/**
 * Formats a member name for mention-token disambiguation.
 *
 * @param member - Workspace member when one can be resolved.
 * @param fallback - Stable key used when display data is absent.
 * @returns Non-empty member label.
 */
function formatIssueMentionMemberName(
  member: WorkspaceMember | undefined,
  fallback: string,
): string {
  return member?.name?.trim() || member?.email || fallback
}

/**
 * Escapes a display label before embedding it into a mention-token regular expression.
 *
 * @param value - Literal display label.
 * @returns Regular-expression-safe label.
 */
function escapeIssueMentionPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
