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
 * Tokens picked in the composer come first, the longest one winning, so picking `@Ann Smith`
 * where `@Ann` was mentioned mentions the newly picked member. A stored mention whose exact token
 * is still in the body, outside every picked token, keeps its member, so a member renamed since
 * the comment was written stays mentioned and an unrelated edit is not rejected. The n-th
 * remaining occurrence of a token takes the n-th stored mention with that token; typed
 * `@member-key` tokens in the rest of the body are read like in a new comment.
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
  const kept: DocumentMention[] = []
  for (const [token, stored] of storedByToken) {
    const occurrences = findTokenOccurrences(body, token)
      .filter((offset) => {
        const range = { offset, length: token.length }
        return !overlapsMentionRanges(range, picked) && !overlapsMentionRanges(range, kept)
      })
    occurrences.slice(0, stored.length).forEach((offset, index) => {
      const mention = stored[index]
      if (mention) kept.push({ userId: mention.userId, offset, length: token.length })
    })
  }
  const typed = extractDocumentMentions(body)
    .filter((mention) => !overlapsMentionRanges(mention, picked) && !overlapsMentionRanges(mention, kept))
  return [...picked, ...kept, ...typed].sort((left, right) => left.offset - right.offset)
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
