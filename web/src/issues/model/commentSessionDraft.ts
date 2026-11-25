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

/** Reply or edit input of one comment, kept across an ended session. */
export type TargetedCommentSessionDraft = CommentSessionDraft & {
  /** Comment the reply answers or the edit changes. */
  commentId: string
  /** Comment version the edit started from; absent for a reply. */
  originalVersion?: number
  /** Comment body the edit started from; absent for a reply. */
  originalBodyMarkdown?: string
  /** Mention member keys the edit started from; absent for a reply. */
  originalMentionMemberKeys?: string[]
}

/**
 * Builds the key under which a Work Item's reply or edit input is kept across an ended session.
 *
 * The target comment and the version an edit started from travel in the kept value, so the
 * restored edit still detects a comment that changed in the meantime.
 *
 * @param commentKey - Key of the Work Item's new-comment input.
 * @param slot - Whether the input is a reply or an edit.
 * @returns The draft key.
 */
export function createTargetedCommentSessionDraftKey(commentKey: string, slot: 'reply' | 'edit'): string {
  return `${commentKey}:${slot}`
}

/**
 * Validates a reply or edit input read back after an ended session.
 *
 * @param value - Value kept in this tab.
 * @returns The input, or `undefined` when the value is not one.
 */
export function parseTargetedCommentSessionDraft(value: unknown): TargetedCommentSessionDraft | undefined {
  const draft = parseCommentSessionDraft(value)
  if (!draft || typeof value !== 'object' || value === null) return undefined
  const commentId: unknown = Reflect.get(value, 'commentId')
  if (typeof commentId !== 'string' || !commentId) return undefined
  const originalVersion: unknown = Reflect.get(value, 'originalVersion')
  if (originalVersion === undefined) return { ...draft, commentId }
  const originalBodyMarkdown: unknown = Reflect.get(value, 'originalBodyMarkdown')
  const originalMentionMemberKeys: unknown = Reflect.get(value, 'originalMentionMemberKeys')
  // An edit comes back only with the baseline it started from, so a newer comment still conflicts.
  if (
    typeof originalVersion !== 'number' ||
    !Number.isInteger(originalVersion) ||
    typeof originalBodyMarkdown !== 'string' ||
    !Array.isArray(originalMentionMemberKeys)
  ) {
    return undefined
  }
  return {
    ...draft,
    commentId,
    originalVersion,
    originalBodyMarkdown,
    originalMentionMemberKeys: originalMentionMemberKeys.filter((key): key is string => typeof key === 'string'),
  }
}
