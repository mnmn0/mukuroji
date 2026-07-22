import type { CreateDocumentCommentInput, DocumentComment, DocumentCommentsResponse } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

/**
 * Document comment 一覧を取得します。
 */
export async function getDocumentComments(
  accessToken: string,
  documentId: string,
  cursor?: string,
  signal?: AbortSignal,
  rootCommentId?: string,
) {
  const query = new URLSearchParams({ limit: '50' })
  if (cursor) query.set('cursor', cursor)
  if (rootCommentId) query.set('rootCommentId', rootCommentId)
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/comments?${query.toString()}`,
    accessToken,
    { signal },
  )
  return value as DocumentCommentsResponse
}

/**
 * Notification deep link が指す root と comment を含む thread を取得します。
 *
 * Root filter は Document 全体の cursor page に適用されるため、対象 root と
 * comment の両方が見つかるまで opaque cursor を追跡します。
 *
 * @param accessToken - Workspace access token です。
 * @param documentId - Comment を保持する Document ID です。
 * @param rootCommentId - Thread の root comment ID です。
 * @param targetCommentId - Deep link が focus する comment ID です。
 * @param signal - Request を中断する任意の signal です。
 * @returns Target と root を含む取得済み thread comments です。
 */
export async function getDocumentCommentThread(
  accessToken: string,
  documentId: string,
  rootCommentId: string,
  targetCommentId: string,
  signal?: AbortSignal,
) {
  const comments = new Map<string, DocumentComment>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    const page = await getDocumentComments(
      accessToken,
      documentId,
      cursor,
      signal,
      rootCommentId,
    )
    for (const comment of page.comments) {
      comments.set(comment.id, comment)
    }
    if (
      comments.has(rootCommentId) &&
      comments.has(targetCommentId)
    ) {
      break
    }
    cursor = page.nextCursor
    if (cursor && seenCursors.has(cursor)) break
    if (cursor) seenCursors.add(cursor)
  } while (cursor)

  return [...comments.values()]
}

/**
 * Document comment を作成します。
 */
export async function createDocumentComment(
  accessToken: string,
  documentId: string,
  input: CreateDocumentCommentInput,
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/comments`,
    accessToken,
    createJsonMutationInit('POST', input, context),
  )
  return readObjectValue(value, 'comment') as DocumentComment
}

/**
 * Document comment thread を resolve します。
 */
export async function resolveDocumentComment(
  accessToken: string,
  documentId: string,
  commentId: string,
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(commentId)}/resolve`,
    accessToken,
    createJsonMutationInit('POST', { resolved: true }, context),
  )
  return readObjectValue(value, 'comment') as DocumentComment
}

function createJsonMutationInit(
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT',
  body: unknown,
  context: MutationRequestContext,
): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(context),
    },
    method,
  }
}

async function requestJson(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const value = await readJson(response)

  if (!response.ok) {
    throw createApiErrorFromBody(response.status, value)
  }

  return value
}

async function readJson(response: Response) {
  const text = await response.text()

  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DocumentsApiError(
      response.status,
      'Documents API returned invalid JSON.',
      'InvalidDocumentsResponse',
    )
  }
}

function createApiErrorFromBody(status: number, value: unknown) {
  const record = asRecord(value)

  return new DocumentsApiError(
    status,
    typeof record.message === 'string'
      ? record.message
      : 'Unable to complete the document request.',
    typeof record.code === 'string' ? record.code : undefined,
  )
}

function readObjectValue(value: unknown, key: string) {
  const record = asRecord(value)
  const nested = record[key]
  return nested && typeof nested === 'object' ? nested : value
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}
