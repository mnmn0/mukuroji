import type {
  CreateDocumentCommentInput,
  DocumentComment,
  DocumentCommentsResponse,
  DocumentMention,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'
import { readRecord } from '../../shared/api/jsonValidation'

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
  return readCommentResponse(value)
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
  return readCommentResponse(value)
}

/**
 * Edits the body and mentions of the viewer's own Document comment.
 *
 * @param accessToken - Workspace access token.
 * @param documentId - Document that owns the comment.
 * @param commentId - Comment to edit.
 * @param input - New body and mentions.
 * @param context - Idempotency and audit context of the mutation.
 * @returns The edited comment.
 */
export async function updateDocumentComment(
  accessToken: string,
  documentId: string,
  commentId: string,
  input: { body: string; mentions: DocumentMention[] },
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(commentId)}`,
    accessToken,
    createJsonMutationInit('PATCH', input, context),
  )
  return readCommentResponse(value)
}

/**
 * Deletes the viewer's own Document comment, leaving a placeholder in its thread.
 *
 * @param accessToken - Workspace access token.
 * @param documentId - Document that owns the comment.
 * @param commentId - Comment to delete.
 * @param context - Idempotency and audit context of the mutation.
 * @returns The deleted comment placeholder.
 */
export async function deleteDocumentComment(
  accessToken: string,
  documentId: string,
  commentId: string,
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(commentId)}`,
    accessToken,
    { headers: createMutationHeaders(context), method: 'DELETE' },
  )
  return readCommentResponse(value)
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
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw new DocumentsApiError(
      response.status,
      'Documents API returned invalid JSON.',
      'InvalidDocumentsResponse',
    )
  }
}

function createApiErrorFromBody(status: number, value: unknown) {
  const record = readRecord(value)

  return new DocumentsApiError(
    status,
    typeof record.message === 'string'
      ? record.message
      : 'Unable to complete the document request.',
    typeof record.code === 'string' ? record.code : undefined,
  )
}

/**
 * Reads the comment of a comment mutation response, checking its fields first.
 *
 * @param value - Parsed response body.
 * @returns The comment.
 * @throws DocumentsApiError when the response holds no valid comment.
 */
function readCommentResponse(value: unknown): DocumentComment {
  const comment = readRecord(value).comment
  if (!isDocumentComment(comment)) {
    throw new DocumentsApiError(200, 'Documents API returned an invalid comment.', 'InvalidDocumentsResponse')
  }
  return comment
}

/**
 * Tells whether a value has the fields of a Document comment.
 *
 * @param value - Value to check.
 * @returns Whether the value is a comment.
 */
function isDocumentComment(value: unknown): value is DocumentComment {
  if (typeof value !== 'object' || value === null) return false
  const record = readRecord(value)
  const optionalString = (field: unknown) => field === undefined || typeof field === 'string'
  const anchor = readRecord(record.anchor)
  return typeof record.id === 'string' &&
    typeof record.documentId === 'string' &&
    typeof record.body === 'string' &&
    typeof record.authorUserId === 'string' &&
    typeof record.resolved === 'boolean' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    typeof anchor.type === 'string' &&
    optionalString(record.parentCommentId) &&
    optionalString(record.resolvedByUserId) &&
    optionalString(record.resolvedAt) &&
    optionalString(record.editedAt) &&
    optionalString(record.deletedAt) &&
    Array.isArray(record.mentions) &&
    record.mentions.every((mention: unknown) => {
      const entry = readRecord(mention)
      return typeof entry.userId === 'string' &&
        typeof entry.offset === 'number' &&
        typeof entry.length === 'number'
    })
}
