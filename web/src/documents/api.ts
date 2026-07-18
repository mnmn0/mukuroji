import type {
  ApplyDocumentOperationsInput,
  ApplyDocumentOperationsResponse,
  CreateDocumentCommentInput,
  CreateDocumentInput,
  CreateDocumentShareInput,
  CreateDocumentShareResponse,
  DocumentComment,
  DocumentCommentsResponse,
  DocumentDetail,
  DocumentDetailResponse,
  DocumentMemberShare,
  DocumentNode,
  DocumentPresenceResponse,
  DocumentPublicShare,
  DocumentRelation,
  RevokeDocumentShareInput,
  DocumentSharesResponse,
  DocumentTreeResponse,
  DocumentVersionsResponse,
  ExportDocumentResponse,
  PublicDocumentResponse,
  RecentDocumentsResponse,
  UpdateDocumentInput,
  UpdateDocumentPresenceInput,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../api/mutationHeaders'

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
 * Operation POST が確定した revision と、続けて取得した表示用 detail です。
 */
export type DocumentOperationSaveResult = {
  /**
   * Operation POST 自体が atomic に確定した revision です。
   */
  committedRevision: number
  /**
   * 保存後に取得した permission-filtered Document detail です。
   */
  document: DocumentRecord
}

/**
 * Share dialog が扱う canonical member/public share です。
 *
 * Public URL は作成 response で一度だけ返るため、同一 browser session 内で
 * public metadata に関連付けて保持します。
 */
export type DocumentShare =
  | DocumentMemberShare
  | (DocumentPublicShare & {
      /**
       * Public share 作成時にだけ取得できる read-only URL です。
       */
      url?: string
    })

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
 * Documents API が失敗したときの例外です。
 */
export class DocumentsApiError extends Error {
  /**
   * HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  /**
   * Documents API error を作成します。
   *
   * @param status - HTTP status code です。
   * @param message - User または log に渡す message です。
   * @param code - API が返した安定 error code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Latest server detail を添えて local draft を保持する revision conflict です。
 */
export class DocumentRevisionConflictError extends DocumentsApiError {
  /**
   * Conflict 検出後に取得した最新 server Document です。
   */
  readonly latestDocument: DocumentRecord

  /**
   * User の明示的な overwrite retry に必要な conflict context を作成します。
   *
   * @param latestDocument - Conflict 後の最新 server Document です。
   * @param message - 元 API error の message です。
   * @param code - 元 API error の安定 code です。
   */
  constructor(
    latestDocument: DocumentRecord,
    message: string,
    code?: string,
  ) {
    super(409, message, code)
    this.latestDocument = latestDocument
  }
}

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)
const createdPublicShareUrls = new Map<string, string>()

/**
 * Documents API base URL を既存 Workspace API と同じ優先順で解決します。
 *
 * @param environment - Vite environment value map です。
 * @returns 末尾 slash を除いた API base URL です。
 */
export function resolveDocumentsApiBaseUrl(
  environment: Record<string, string | boolean | undefined>,
) {
  return trimTrailingSlash(
    typeof environment.VITE_WORKSPACE_API_BASE_URL === 'string'
      ? environment.VITE_WORKSPACE_API_BASE_URL
      : typeof environment.VITE_PROJECTS_API_BASE_URL === 'string'
        ? environment.VITE_PROJECTS_API_BASE_URL
        : typeof environment.VITE_TASKS_API_BASE_URL === 'string'
          ? environment.VITE_TASKS_API_BASE_URL
          : typeof environment.VITE_API_BASE_URL === 'string'
            ? environment.VITE_API_BASE_URL
            : '/api',
  )
}

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
 * Canonical operation batch を保存し、更新後 detail を取得します。
 */
export async function applyDocumentOperations(
  accessToken: string,
  documentId: string,
  input: ApplyDocumentOperationsInput,
  context: MutationRequestContext,
) {
  const response = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/operations`,
    accessToken,
    createJsonMutationInit('POST', input, context),
  ) as ApplyDocumentOperationsResponse
  const document = await getDocument(accessToken, documentId)
  return {
    committedRevision: response.revision,
    document,
  } satisfies DocumentOperationSaveResult
}

/**
 * Concurrent revision conflict のときだけ最新 detail を取得し、silent
 * overwrite を避けるため latest context 付き conflict として返します。
 *
 * @param accessToken - Workspace access token です。
 * @param documentId - 保存対象 Document ID です。
 * @param input - 最初に送る canonical operation batch です。
 * @param apply - Operation batch を idempotent request として送る関数です。
 * @returns Conflict がない場合の保存済み Document です。
 */
export async function applyDocumentOperationsWithConflictAwareness(
  accessToken: string,
  documentId: string,
  input: ApplyDocumentOperationsInput,
  apply: (
    candidateInput: ApplyDocumentOperationsInput,
  ) => Promise<DocumentOperationSaveResult>,
) {
  try {
    return await apply(input)
  } catch (error) {
    if (!(error instanceof DocumentsApiError) || error.status !== 409) {
      throw error
    }
    const latest = await getDocument(accessToken, documentId)
    throw new DocumentRevisionConflictError(
      latest,
      error.message,
      error.code,
    )
  }
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
 * Document の version history を取得します。
 */
export async function getDocumentVersions(
  accessToken: string,
  documentId: string,
  cursor?: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ limit: '50' })
  if (cursor) query.set('cursor', cursor)
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/versions?${query.toString()}`,
    accessToken,
    { signal },
  )
  return value as DocumentVersionsResponse
}

/**
 * 過去 version を新しい version として restore します。
 */
export async function restoreDocumentVersion(
  accessToken: string,
  documentId: string,
  versionId: string,
  expectedRevision: number,
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/restore`,
    accessToken,
    createJsonMutationInit('POST', { expectedRevision }, context),
  )
  return readDocumentRecord(value)
}

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

/**
 * Document presence 一覧を取得します。
 */
export async function getDocumentPresence(
  accessToken: string,
  documentId: string,
  signal?: AbortSignal,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/presence`,
    accessToken,
    { signal },
  )
  return (value as DocumentPresenceResponse).presences
}

/**
 * Document presence heartbeat を保存します。
 */
export async function updateDocumentPresence(
  accessToken: string,
  documentId: string,
  input: UpdateDocumentPresenceInput,
  context: MutationRequestContext,
) {
  await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/presence`,
    accessToken,
    createJsonMutationInit('PUT', input, context),
  )
}

/**
 * Browser tab の Document presence を削除します。
 */
export async function deleteDocumentPresence(
  accessToken: string,
  documentId: string,
  clientId: string,
  context: MutationRequestContext,
) {
  await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/presence/${encodeURIComponent(clientId)}`,
    accessToken,
    createMutationInit('DELETE', context),
  )
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
 * Document share 一覧を canonical member/public union へまとめて取得します。
 */
export async function getDocumentShares(
  accessToken: string,
  documentId: string,
  signal?: AbortSignal,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/shares`,
    accessToken,
    { signal },
  ) as DocumentSharesResponse
  const now = Date.now()
  const publicShares: DocumentShare[] = value.publicShares
    .filter(
      (share) =>
        !share.revokedAt &&
        Number.isFinite(Date.parse(share.expiresAt)) &&
        Date.parse(share.expiresAt) > now,
    )
    .map((share) => ({
      ...share,
      url: createdPublicShareUrls.get(share.id),
    }))
  return [...value.memberShares, ...publicShares]
}

/**
 * Member grant または expiring public link を作成します。
 */
export async function createDocumentShare(
  accessToken: string,
  documentId: string,
  input: CreateDocumentShareInput,
  context: MutationRequestContext,
) {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/shares`,
    accessToken,
    createJsonMutationInit('POST', input, context),
  ) as CreateDocumentShareResponse

  if (value.type === 'public') {
    const absoluteUrl = resolvePublicDocumentUrl(value.url)
    if (absoluteUrl) {
      createdPublicShareUrls.set(value.share.id, absoluteUrl)
    }
    return {
      ...value.share,
      ...(absoluteUrl ? { url: absoluteUrl } : {}),
    } satisfies DocumentShare
  }
  return value.share satisfies DocumentShare
}

/**
 * API が返した relative public path を現在の app origin の絶対 URL にします。
 *
 * @param url - API response の absolute URL または relative path です。
 * @param appOrigin - Browser app の origin です。Test では明示できます。
 * @returns Clipboard へ安全に渡せる same-origin absolute URL です。不正な
 * URL は undefined です。
 */
export function resolvePublicDocumentUrl(
  url: string,
  appOrigin =
    typeof globalThis.location?.origin === 'string'
      ? globalThis.location.origin
      : 'http://localhost',
) {
  try {
    const baseUrl = new URL(`${trimTrailingSlash(appOrigin)}/`)
    const resolvedUrl = new URL(url, baseUrl)
    if (
      (resolvedUrl.protocol !== 'https:' &&
        resolvedUrl.protocol !== 'http:') ||
      resolvedUrl.origin !== baseUrl.origin
    ) {
      return undefined
    }
    return resolvedUrl.toString()
  } catch {
    return undefined
  }
}

/**
 * Document member/public share を revoke します。
 */
export async function deleteDocumentShare(
  accessToken: string,
  documentId: string,
  input: RevokeDocumentShareInput,
  context: MutationRequestContext,
) {
  await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/shares`,
    accessToken,
    createJsonMutationInit('DELETE', input, context),
  )
  if (input.type === 'public') {
    createdPublicShareUrls.delete(input.publicShareId)
  }
}

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
 * Document または Whiteboard を canonical inline/download response で export します。
 */
export async function exportDocument(
  accessToken: string,
  documentId: string,
  format: 'markdown' | 'json' | 'svg',
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ format })
  return requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/export?${query.toString()}`,
    accessToken,
    { signal },
  ) as Promise<ExportDocumentResponse>
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

/**
 * Public token の export permission がある Document を認証情報なしで
 * export します。
 */
export async function exportPublicDocument(
  token: string,
  format: 'markdown' | 'json' | 'svg',
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ format })
  const response = await fetch(
    `${documentsApiBaseUrl}/public/documents/${encodeURIComponent(token)}/export?${query.toString()}`,
    {
      referrerPolicy: 'no-referrer',
      signal,
    },
  )
  const value = await readJson(response)
  if (!response.ok) {
    throw createApiErrorFromBody(response.status, value)
  }
  return value as ExportDocumentResponse
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

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/u, '')
}
