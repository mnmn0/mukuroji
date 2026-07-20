import type { CreateDocumentInput, DocumentDetail, DocumentDetailResponse, DocumentNode, DocumentTreeResponse, PublicDocumentResponse, RecentDocumentsResponse, UpdateDocumentInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'

export type {
  CreateDocumentCommentInput,
  CreateDocumentInput,
  CreateDocumentShareInput,
  DocumentComment,
  DocumentOperation,
  DocumentPresence,
  PublicDocument,
  DocumentVersion,
  RevokeDocumentShareInput,
  UpdateDocumentInput,
  UpdateDocumentPresenceInput,
  WhiteboardConnector,
  WhiteboardContent,
  WhiteboardObject,
} from '@mukuroji/contracts'

/**
 * Document tree の canonical node alias です。
 */
export type DocumentSummary = DocumentNode

/**
 * Editor が扱う canonical kind-specific Document detail alias です。
 */
export type DocumentRecord = DocumentDetail

/**
 * Active/archive tree の独立 cursor と現在までに取得した node 集合です。
 */
export type DocumentCollection = {
  /**
   * ID ごとに重複を除いた permission-filtered nodes です。
   */
  documents: DocumentSummary[]
  /**
   * Active tree に次 page がある場合の cursor です。
   */
  activeCursor?: string
  /**
   * Archive tree に次 page がある場合の cursor です。
   */
  archivedCursor?: string
}

/**
 * Template instantiate route の入力です。
 */
export type InstantiateDocumentInput = {
  /**
   * 利用する template Document ID です。
   */
  templateId: string
  /**
   * 作成先 scope です。
   */
  scope: DocumentDetail['scope']
  /**
   * 作成先 folder ID です。
   */
  parentId?: string
  /**
   * 作成後の title です。
   */
  title?: string
  /**
   * 作成後の sibling position です。
   */
  position?: string
}

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

/**
 * Permission-filtered Document tree を取得します。
 */
export async function getDocuments(
  accessToken: string,
  options: {
    /**
     * Archive 済み node を取得するかどうかです。
     */
    archived?: boolean
    /**
     * 前 page が返した opaque cursor です。
     */
    cursor?: string
    /**
     * Request を中断する signal です。
     */
    signal?: AbortSignal
  } = {},
) {
  return (
    await getDocumentTreePage(accessToken, options)
  ).nodes
}

/**
 * Active と archive 済み両方の permission-filtered Document の最初の
 * page を取得し、継続 cursor を保持します。
 */
export async function getDocumentCollection(
  accessToken: string,
  signal?: AbortSignal,
): Promise<DocumentCollection> {
  const [activePage, archivedPage, recent] = await Promise.all([
    getDocumentTreePage(accessToken, { signal }),
    getDocumentTreePage(accessToken, { archived: true, signal }),
    getRecentDocuments(accessToken, signal),
  ])
  return {
    documents: deduplicateDocuments([
      ...activePage.nodes,
      ...archivedPage.nodes,
      ...recent,
    ]),
    ...(activePage.nextCursor === undefined
      ? {}
      : { activeCursor: activePage.nextCursor }),
    ...(archivedPage.nextCursor === undefined
      ? {}
      : { archivedCursor: archivedPage.nextCursor }),
  }
}

/**
 * Source-of-truth ACL を適用した newest-first recent Documents を取得します。
 */
export async function getRecentDocuments(
  accessToken: string,
  signal?: AbortSignal,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/recent?limit=20`,
    accessToken,
    { signal },
  ) as RecentDocumentsResponse
  return value.documents.map(({ document }) => document)
}

/**
 * Active または archive tree の次 page を一度だけ取得して collection
 * へ追記します。
 */
export async function getNextDocumentCollectionPage(
  accessToken: string,
  collection: DocumentCollection,
  archived: boolean,
  signal?: AbortSignal,
): Promise<DocumentCollection> {
  const cursor = archived
    ? collection.archivedCursor
    : collection.activeCursor
  if (cursor === undefined) return collection
  const page = await getDocumentTreePage(accessToken, {
    archived,
    cursor,
    signal,
  })
  return {
    ...collection,
    documents: deduplicateDocuments([
      ...collection.documents,
      ...page.nodes,
    ]),
    ...(archived
      ? {
          archivedCursor: page.nextCursor,
        }
      : {
          activeCursor: page.nextCursor,
        }),
  }
}

async function getDocumentTreePage(
  accessToken: string,
  options: {
    archived?: boolean
    cursor?: string
    signal?: AbortSignal
  },
): Promise<DocumentTreeResponse> {
  const query = new URLSearchParams()
  if (options.archived) query.set('archived', 'true')
  if (options.cursor) query.set('cursor', options.cursor)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents${suffix}`,
    accessToken,
    { signal: options.signal },
  )
  return value as DocumentTreeResponse
}

function deduplicateDocuments(
  documents: readonly DocumentSummary[],
) {
  return [
    ...new Map(
      documents.map((document) => [document.id, document]),
    ).values(),
  ]
}

/**
 * Canonical Document node を作成します。
 */
export async function createDocument(
  accessToken: string,
  input: CreateDocumentInput,
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents`,
    accessToken,
    createJsonMutationInit('POST', input, context),
  )
  return readDocumentRecord(value)
}

/**
 * Document detail を取得します。
 */
export async function getDocument(
  accessToken: string,
  documentId: string,
  signal?: AbortSignal,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}`,
    accessToken,
    { signal },
  )
  return readDocumentRecord(value)
}

/**
 * Document metadata または permission を更新します。
 */
export async function updateDocument(
  accessToken: string,
  documentId: string,
  input: UpdateDocumentInput,
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}`,
    accessToken,
    createJsonMutationInit('PATCH', input, context),
  )
  return readDocumentRecord(value)
}

/**
 * Document を archive します。
 */
export async function archiveDocument(
  accessToken: string,
  documentId: string,
  expectedRevision: number,
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/archive`,
    accessToken,
    createJsonMutationInit('POST', { expectedRevision }, context),
  )
  return readDocumentNode(value)
}

/**
 * Archive 済み Document を restore します。
 */
export async function restoreDocument(
  accessToken: string,
  documentId: string,
  expectedRevision: number,
  context: MutationRequestContext,
) {
  await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/restore`,
    accessToken,
    createJsonMutationInit('POST', { expectedRevision }, context),
  )
  return getDocument(accessToken, documentId)
}

/**
 * Template から page Document を作成します。
 */
export async function instantiateDocument(
  accessToken: string,
  input: InstantiateDocumentInput,
  context: MutationRequestContext,
) {
  const { templateId, ...body } = input
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(templateId)}/instantiate`,
    accessToken,
    createJsonMutationInit('POST', body, context),
  )
  return readDocumentRecord(value)
}

/**
 * Document を現在 user の favorite に追加します。
 */
export async function favoriteDocument(
  accessToken: string,
  documentId: string,
  context: MutationRequestContext,
) {
  await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/favorite`,
    accessToken,
    createMutationInit('PUT', context),
  )
}

/**
 * Document を現在 user の favorite から削除します。
 */
export async function unfavoriteDocument(
  accessToken: string,
  documentId: string,
  context: MutationRequestContext,
) {
  await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/favorite`,
    accessToken,
    createMutationInit('DELETE', context),
  )
}

/**
 * Document の閲覧を recent として記録します。
 */
export async function markDocumentRecent(
  accessToken: string,
  documentId: string,
  context: MutationRequestContext,
) {
  await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/recent`,
    accessToken,
    createJsonMutationInit('POST', {}, context),
  )
}

/**
 * Public share token から read-only canonical Document detail を取得します。
 */
export async function getPublicDocument(
  token: string,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `${documentsApiBaseUrl}/public/documents/${encodeURIComponent(token)}`,
    {
      referrerPolicy: 'no-referrer',
      signal,
    },
  )
  const value = await readJson(response)

  if (!response.ok) {
    throw createApiErrorFromBody(response.status, value)
  }

  return value as PublicDocumentResponse
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

function createMutationInit(
  method: 'DELETE' | 'POST' | 'PUT',
  context: MutationRequestContext,
): RequestInit {
  return {
    headers: createMutationHeaders(context),
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

function readDocumentNode(value: unknown): DocumentNode {
  const record = asRecord(value)
  const document = asRecord(record.document ?? value)

  if (typeof document.id !== 'string' || typeof document.title !== 'string') {
    throw new DocumentsApiError(
      502,
      'Document node response was invalid.',
      'InvalidDocumentResponse',
    )
  }

  return document as unknown as DocumentNode
}

function readDocumentRecord(value: unknown): DocumentDetail {
  const record = asRecord(value)
  const document = asRecord(
    (record as DocumentDetailResponse).document ?? value,
  )

  if (typeof document.id !== 'string' || typeof document.title !== 'string') {
    throw new DocumentsApiError(
      502,
      'Document response was invalid.',
      'InvalidDocumentResponse',
    )
  }

  return document as unknown as DocumentDetail
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}
