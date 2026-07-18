import { afterEach, expect, test } from 'bun:test'
import {
  getDocumentComments,
  getDocumentCommentThread,
} from '../src/documents/api'
import { documentCommentFixtures } from '../src/documents/fixtures'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('loads Document comments one opaque-cursor page at a time', async () => {
  const requests: Request[] = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(
      typeof input === 'string' && input.startsWith('/')
        ? new URL(input, 'https://example.test')
        : input,
      init,
    )
    requests.push(request)
    return new URL(request.url).searchParams.get('cursor') === 'comments-next'
      ? Response.json({ comments: [documentCommentFixtures[1]] })
      : Response.json({
          comments: [documentCommentFixtures[0]],
          nextCursor: 'comments-next',
        })
  }) as typeof fetch

  const firstPage = await getDocumentComments(
    'access-token',
    'product-principles',
  )
  const secondPage = await getDocumentComments(
    'access-token',
    'product-principles',
    firstPage.nextCursor,
  )

  expect(firstPage).toEqual({
    comments: [documentCommentFixtures[0]],
    nextCursor: 'comments-next',
  })
  expect(secondPage).toEqual({
    comments: [documentCommentFixtures[1]],
  })
  expect(requests).toHaveLength(2)
  expect(
    new URL(requests[1]!.url).searchParams.get('cursor'),
  ).toBe('comments-next')
  expect(
    requests.every(
      (request) =>
        request.headers.get('Authorization') === 'Bearer access-token',
    ),
  ).toBe(true)
})

test('loads a notification comment and its root through scoped pages', async () => {
  const requests: Request[] = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(
      typeof input === 'string' && input.startsWith('/')
        ? new URL(input, 'https://example.test')
        : input,
      init,
    )
    requests.push(request)
    return new URL(request.url).searchParams.get('cursor') ===
        'thread-next'
      ? Response.json({
          comments: [documentCommentFixtures[0]],
          nextCursor: 'unused-next',
        })
      : Response.json({
          comments: [documentCommentFixtures[2]],
          nextCursor: 'thread-next',
        })
  }) as typeof fetch

  const comments = await getDocumentCommentThread(
    'access-token',
    'product-principles',
    'comment-context',
    'comment-context-reply',
  )

  expect(comments.map(({ id }) => id)).toEqual([
    'comment-context-reply',
    'comment-context',
  ])
  expect(requests).toHaveLength(2)
  expect(
    requests.every(
      (request) =>
        new URL(request.url).searchParams.get(
          'rootCommentId',
        ) === 'comment-context',
    ),
  ).toBe(true)
})
