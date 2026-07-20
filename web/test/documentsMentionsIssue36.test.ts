import { describe, expect, test } from 'bun:test'
import {
  extractDocumentMentions,
  extractMentionMemberKeys,
} from '../src/documents/model/comments'

describe('Document comment mentions', () => {
  test('keeps canonical email member keys and trims terminal punctuation', () => {
    const body =
      'Ask @demo@example.com, then (@second.user+lab@example.co.jp).'

    expect(extractMentionMemberKeys(body)).toEqual([
      'demo@example.com',
      'second.user+lab@example.co.jp',
    ])
    expect(extractDocumentMentions(body)).toEqual([
      {
        length: '@demo@example.com'.length,
        offset: body.indexOf('@demo@example.com'),
        userId: 'demo@example.com',
      },
      {
        length: '@second.user+lab@example.co.jp'.length,
        offset: body.indexOf('@second.user+lab@example.co.jp'),
        userId: 'second.user+lab@example.co.jp',
      },
    ])
  })

  test('reports UTF-16 offsets after non-BMP text and deduplicates member keys', () => {
    const body =
      '🚀 @demo@example.com! 🧠 Check @other@example.com… @demo@example.com.'

    const mentions = extractDocumentMentions(body)

    expect(mentions).toHaveLength(3)
    expect(mentions.map((mention) => mention.offset)).toEqual([
      body.indexOf('@demo@example.com'),
      body.indexOf('@other@example.com'),
      body.lastIndexOf('@demo@example.com'),
    ])
    expect(mentions.map((mention) => mention.length)).toEqual([
      '@demo@example.com'.length,
      '@other@example.com'.length,
      '@demo@example.com'.length,
    ])
    expect(extractMentionMemberKeys(body)).toEqual([
      'demo@example.com',
      'other@example.com',
    ])
  })
})
