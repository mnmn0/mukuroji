import type { DocumentMention } from '@mukuroji/contracts'

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

const documentMentionPattern =
  /(^|[\s,;:!?()[\]{}"'、。！？：；（）［］｛｝「」『』【】])@([^\s,;:!?()[\]{}"'、。！？：；（）［］｛｝「」『』【】]+)/gu
