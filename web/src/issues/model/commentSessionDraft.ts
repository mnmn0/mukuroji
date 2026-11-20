/**
 * New-comment input of one Work Item, kept across an ended session.
 */
export type CommentSessionDraft = {
  /** Raw Markdown the member typed. */
  bodyMarkdown: string
  /** Mention member keys selected while typing. */
  mentionMemberKeys: string[]
}

/**
 * Builds the key under which a Work Item's new-comment input is kept across an ended session.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item the comment is written on.
 * @returns The draft key.
 */
export function createIssueCommentSessionDraftKey(teamId: string, workItemId: string): string {
  return `issue-comment:${JSON.stringify([teamId, workItemId])}`
}

/**
 * Validates a new-comment input read back after an ended session.
 *
 * @param value - Value kept in this tab.
 * @returns The input, or `undefined` when the value is not one.
 */
export function parseCommentSessionDraft(value: unknown): CommentSessionDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const bodyMarkdown: unknown = Reflect.get(value, 'bodyMarkdown')
  const mentionMemberKeys: unknown = Reflect.get(value, 'mentionMemberKeys')
  if (typeof bodyMarkdown !== 'string' || !Array.isArray(mentionMemberKeys)) return undefined
  return {
    bodyMarkdown,
    mentionMemberKeys: mentionMemberKeys.filter((key): key is string => typeof key === 'string'),
  }
}
