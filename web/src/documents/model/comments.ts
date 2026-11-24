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

/**
 * Resolves the mention ranges of an edited comment.
 *
 * Tokens picked in the composer and stored mentions whose exact token is still in the body are
 * both candidates; where they overlap the longer token wins, and a picked token wins a tie. So
 * picking `@Ann Smith` where `@Ann` was mentioned mentions the newly picked member, while a
 * picked `@Ann` elsewhere never cuts a stored `@Ann Smith` short. A stored mention keeps its
 * member, so a member renamed since the comment was written stays mentioned and an unrelated edit
 * is not rejected. The n-th occurrence of a stored token takes the n-th stored mention with that
 * token; typed `@member-key` tokens in the rest of the body are read like in a new comment.
 *
 * @param original - Stored body and mentions of the comment.
 * @param body - Edited plain text body.
 * @param selectedMemberKeys - Member keys picked from the composer's suggestions.
 * @param members - Mention candidates used to validate the picked tokens.
 * @returns Mention ranges ordered by offset.
 */
export function resolveEditedDocumentMentions(
  original: { body: string; mentions: readonly DocumentMention[] },
  body: string,
  selectedMemberKeys: readonly string[],
  members: readonly MentionableMember[],
): DocumentMention[] {
  const storedByToken = new Map<string, DocumentMention[]>()
  for (const mention of [...original.mentions].sort((left, right) => left.offset - right.offset)) {
    const token = original.body.slice(mention.offset, mention.offset + mention.length)
    storedByToken.set(token, [...(storedByToken.get(token) ?? []), mention])
  }
  const picked: DocumentMention[] = findMemberMentionRanges(body, selectedMemberKeys, members)
    .map((range) => ({ length: range.length, offset: range.offset, userId: range.memberKey }))
  const storedCandidates: DocumentMention[] = []
  // Longer stored tokens take their occurrences first, so `@Ann` is not read inside `@Ann Smith`.
  const storedTokens = [...storedByToken].sort(([left], [right]) => right.length - left.length)
  for (const [token, stored] of storedTokens) {
    findTokenOccurrences(body, token)
      .filter((offset) => !overlapsMentionRanges({ offset, length: token.length }, storedCandidates))
      .slice(0, stored.length)
      .forEach((offset, index) => {
        const mention = stored[index]
        if (mention) storedCandidates.push({ userId: mention.userId, offset, length: token.length })
      })
  }
  // Longest first; on equal length a picked token, then a stored one, then a typed key.
  const candidates = [
    ...picked.map((mention) => ({ mention, rank: 0 })),
    ...storedCandidates.map((mention) => ({ mention, rank: 1 })),
    ...extractDocumentMentions(body).map((mention) => ({ mention, rank: 2 })),
  ].sort((left, right) =>
    right.mention.length - left.mention.length ||
    left.rank - right.rank ||
    left.mention.offset - right.mention.offset)
  const resolved: DocumentMention[] = []
  for (const { mention } of candidates) {
    if (!overlapsMentionRanges(mention, resolved)) resolved.push(mention)
  }
  return resolved.sort((left, right) => left.offset - right.offset)
}

/**
 * Finds whole-token occurrences of a mention token in a body.
 *
 * @param body - Comment body.
 * @param token - Mention token such as `@Mina Sato`.
 * @returns Offsets where the token starts and is not part of a longer word.
 */
function findTokenOccurrences(body: string, token: string): number[] {
  const offsets: number[] = []
  if (!token) return offsets
  let index = body.indexOf(token)
  while (index !== -1) {
    const before = index === 0 ? '' : body[index - 1] ?? ''
    const after = body[index + token.length] ?? ''
    if (!mentionWordCharacter.test(before) && !mentionWordCharacter.test(after)) offsets.push(index)
    index = body.indexOf(token, index + token.length)
  }
  return offsets
}

/** A character that continues a mention token. */
const mentionWordCharacter = /^[\p{L}\p{N}_@]$/u

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
