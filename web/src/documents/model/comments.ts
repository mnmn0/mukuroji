import type { DocumentComment, DocumentMention } from '@mukuroji/contracts'
import {
  findMemberMentionRanges,
  overlapsMentionRanges,
  type MentionableMember,
} from '../../shared/lib/memberMentions'

/**
 * Comment 本文に含まれる `@member-key` mention を抽出します。
 *
 * @param body - Comment composer の plain text body です。
 * @returns 重複を除いた member key 一覧です。
 */
export function extractMentionMemberKeys(body: string) {
  return [...new Set(
    extractDocumentMentions(body).map((mention) => mention.userId),
  )]
}

/**
 * Comment body 内の `@user-id` 表現を canonical mention ranges へ変換します。
 *
 * @param body - Comment composer の plain text body です。
 * @returns User ID と UTF-16 range を保持する mention 一覧です。
 */
export function extractDocumentMentions(body: string): DocumentMention[] {
  return [...body.matchAll(documentMentionPattern)].flatMap((match) => {
    const prefix = match[1] ?? ''
    const userId = (match[2] ?? '').replace(/[.…]+$/u, '')
    if (!userId || match.index === undefined) return []

    return [{
      length: userId.length + 1,
      offset: match.index + prefix.length,
      userId,
    }]
  })
}

/**
 * Resolves the mention ranges of a comment from display-name tokens picked in the composer and
 * typed `@member-key` tokens.
 *
 * A typed token that falls inside a display-name token, such as the first word of `@Taro Yamada`,
 * is not read as a separate member key.
 *
 * @param body - Comment composer plain text body.
 * @param selectedMemberKeys - Member keys picked from the composer's suggestions.
 * @param members - Mention candidates used to validate the picked tokens.
 * @returns Mention ranges ordered by offset.
 */
export function resolveDocumentMentions(
  body: string,
  selectedMemberKeys: readonly string[],
  members: readonly MentionableMember[],
): DocumentMention[] {
  const named = findMemberMentionRanges(body, selectedMemberKeys, members).map((range) => ({
    length: range.length,
    offset: range.offset,
    userId: range.memberKey,
  }))
  const typed = extractDocumentMentions(body)
    .filter((mention) => !overlapsMentionRanges(mention, named))
  return [...named, ...typed].sort((left, right) => left.offset - right.offset)
}

const documentMentionPattern =
  /(^|[\s,;:!?()[\]{}"'、。！？：；（）［］｛｝「」『』【】])@([^\s,;:!?()[\]{}"'、。！？：；（）［］｛｝「」『』【】]+)/gu

/**
 * Replaces one comment in a loaded list with the server's copy after an edit or delete.
 *
 * @param comments - Loaded comments, or undefined before the first read.
 * @param changed - Comment returned by the server.
 * @returns The list with the comment replaced, or the same value when the comment is not in it.
 */
export function replaceLoadedDocumentComment<T extends readonly DocumentComment[] | undefined>(
  comments: T,
  changed: DocumentComment,
): T | DocumentComment[] {
  if (!comments?.some((comment) => comment.id === changed.id)) return comments
  return comments.map((comment) => comment.id === changed.id ? changed : comment)
}
