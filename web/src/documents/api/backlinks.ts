import type { DocumentRelation } from '@mukuroji/contracts'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'

/**
 * Relation target から取得する permission-filtered backlink です。
 */
export type DocumentBacklink = {
  /**
   * Backlink source Document ID です。
   */
  documentId: string
  /**
   * Backlink source Document title です。
   */
  documentTitle: string
  /**
   * Backlink を作成した canonical relation です。
   */
  relation: DocumentRelation
}

/**
 * Backlink API の cursor page です。
 */
export type DocumentBacklinksResponse = {
  /**
   * 現在 page で閲覧可能な backlinks です。
   */
  backlinks: DocumentBacklink[]
  /**
   * 次 page がある場合の opaque cursor です。
   */
  nextCursor?: string
}

/**
 * Batched backlink read の一 target と継続 cursor です。
 */
export type DocumentBacklinkBatchTarget = {
  /**
   * Relation target 種別です。
   */
  targetType: 'work-item' | 'project' | 'goal'
  /**
   * Relation target の canonical ID です。
   */
  targetId: string
  /**
   * この target の次 page を読む opaque cursor です。
   */
  cursor?: string
}

/**
 * 複数 target を request 全体の read budget 内で取得した結果です。
 */
export type DocumentBacklinksBatchResponse = {
  /**
   * 現在 batch で閲覧可能だった backlinks です。
   */
  backlinks: DocumentBacklink[]
  /**
   * 次 batch で継続する target/cursor です。
   */
  pending: DocumentBacklinkBatchTarget[]
}

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

/**
 * Work Item/Project/Goal target の Document backlinks を取得します。
 */
export async function getDocumentBacklinks(
  accessToken: string,
  targetType: 'work-item' | 'project' | 'goal',
  targetId: string,
  cursor?: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    limit: '20',
    targetId,
    targetType,
  })
  if (cursor) query.set('cursor', cursor)
  const value = await requestJson(
    `${documentsApiBaseUrl}/document-backlinks?${query.toString()}`,
    accessToken,
    { signal },
  )
  return value as DocumentBacklinksResponse
}

/**
 * 複数の relation target を一つの bounded backlink request で取得します。
 */
export async function getDocumentBacklinksBatch(
  accessToken: string,
  targets: readonly DocumentBacklinkBatchTarget[],
  signal?: AbortSignal,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/document-backlinks/batch`,
    accessToken,
    {
      body: JSON.stringify({ targets }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal,
    },
  )
  return value as DocumentBacklinksBatchResponse
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}
