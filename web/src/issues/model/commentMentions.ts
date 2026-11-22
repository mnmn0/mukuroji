import type { WorkspaceMember } from '../../workspace/api'
import {
  formatMemberMentionLabel,
  resolveMentionedMemberKeys,
} from '../../shared/lib/memberMentions'

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
  return formatMemberMentionLabel(member, members)
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
  return resolveMentionedMemberKeys(bodyMarkdown, selectedMemberKeys, members)
}
