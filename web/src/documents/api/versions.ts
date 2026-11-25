import type {
  ApprovalRequest,
  ApprovalRequestStatus,
  ApprovalReviewer,
  ApprovalReviewerStatus,
  CreateDocumentVersionApprovalInput,
  DocumentDetail,
  DocumentVersion,
  DocumentVersionDetail,
  DocumentVersionsResponse,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'
import { readRecord } from '../../shared/api/jsonValidation'

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

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
 * Reads one retained version with a read-only snapshot of its content.
 *
 * @param accessToken - Documents API access token.
 * @param documentId - Document that owns the version.
 * @param versionId - Version to read.
 * @param signal - Abort signal for the request.
 * @returns The version metadata and its snapshot.
 */
export async function getDocumentVersion(
  accessToken: string,
  documentId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<DocumentVersionDetail> {
  const value = await requestJson(
    `${createVersionPath(documentId, versionId)}`,
    accessToken,
    { signal },
  )
  const detail = readRecord(readRecord(value).version)
  const version = detail.version
  if (!isDocumentVersion(version) || !isVersionSnapshot(detail.document)) throw invalidVersionResponse()
  return { version, document: readDocumentRecord({ document: detail.document }) }
}

/**
 * Names a version and keeps it beyond the version retention period.
 *
 * @param accessToken - Documents API access token.
 * @param documentId - Document that owns the version.
 * @param versionId - Version to pin.
 * @param name - Name shown for the pinned version.
 * @param context - Mutation idempotency context.
 * @returns The pinned version metadata.
 */
export async function pinDocumentVersion(
  accessToken: string,
  documentId: string,
  versionId: string,
  name: string,
  context: MutationRequestContext,
): Promise<DocumentVersion> {
  const value = await requestJson(
    `${createVersionPath(documentId, versionId)}/pin`,
    accessToken,
    createJsonMutationInit('POST', { name }, context),
  )
  const version = readRecord(value).version
  if (!isDocumentVersion(version)) throw invalidVersionResponse()
  return version
}

/**
 * Requests approval of a pinned version on the Work Item that links it as a deliverable.
 *
 * @param accessToken - Documents API access token.
 * @param documentId - Document that owns the version.
 * @param versionId - Pinned version to approve.
 * @param input - Work Item, reviewers, and due date.
 * @param context - Mutation idempotency context.
 * @returns The created approval request.
 */
export async function requestDocumentVersionApproval(
  accessToken: string,
  documentId: string,
  versionId: string,
  input: CreateDocumentVersionApprovalInput,
  context: MutationRequestContext,
): Promise<ApprovalRequest> {
  const value = await requestJson(
    `${createVersionPath(documentId, versionId)}/approvals`,
    accessToken,
    createJsonMutationInit('POST', input, context),
  )
  return readDocumentApproval(readRecord(value).approval)
}

/**
 * Lists approvals of the Document's versions whose Work Item the viewer can see.
 *
 * @param accessToken - Documents API access token.
 * @param documentId - Document whose version approvals are listed.
 * @param signal - Abort signal for the request.
 * @returns Approvals newest first.
 */
export async function getDocumentApprovals(
  accessToken: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<ApprovalRequest[]> {
  const value = await requestJson(
    `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/approvals`,
    accessToken,
    { signal },
  )
  const approvals = readRecord(value).approvals
  if (!Array.isArray(approvals)) throw invalidVersionResponse()
  // One malformed approval fails the whole read instead of silently hiding it.
  return approvals.map(readDocumentApproval)
}

/**
 * Builds the API path of one Document version.
 *
 * @param documentId - Document that owns the version.
 * @param versionId - Version ID.
 * @returns The version resource URL.
 */
function createVersionPath(documentId: string, versionId: string) {
  return `${documentsApiBaseUrl}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}`
}

/**
 * Checks the fields the version history relies on.
 *
 * @param value - Parsed response value.
 * @returns Whether the value is Document version metadata.
 */
function isDocumentVersion(value: unknown): value is DocumentVersion {
  const record = readRecord(value)
  return typeof record.id === 'string' &&
    typeof record.documentId === 'string' &&
    typeof record.revision === 'number' &&
    typeof record.createdAt === 'string' &&
    (record.name === undefined || typeof record.name === 'string')
}

/** Reviewer statuses defined by the shared approval contract. */
const APPROVAL_REVIEWER_STATUSES: readonly ApprovalReviewerStatus[] = [
  'pending',
  'approved',
  'rejected',
  'changes-requested',
]

/** Approval statuses defined by the shared approval contract. */
const APPROVAL_REQUEST_STATUSES: readonly ApprovalRequestStatus[] = [
  ...APPROVAL_REVIEWER_STATUSES,
  'cancelled',
]

/**
 * Checks whether a value is a reviewer status of the shared contract.
 *
 * @param value - Parsed response value.
 * @returns Whether the value is a reviewer status.
 */
function isApprovalReviewerStatus(value: unknown): value is ApprovalReviewerStatus {
  return APPROVAL_REVIEWER_STATUSES.some((status) => status === value)
}

/**
 * Checks whether a value is an approval status of the shared contract.
 *
 * @param value - Parsed response value.
 * @returns Whether the value is an approval status.
 */
function isApprovalRequestStatus(value: unknown): value is ApprovalRequestStatus {
  return APPROVAL_REQUEST_STATUSES.some((status) => status === value)
}

/**
 * Reads one reviewer of an approval.
 *
 * @param value - Parsed response value.
 * @returns The reviewer.
 * @throws DocumentsApiError when the reviewer is malformed.
 */
function readApprovalReviewer(value: unknown): ApprovalReviewer {
  const record = readRecord(value)
  const { memberKey, status, decidedAt, comment } = record
  if (
    typeof memberKey !== 'string' ||
    !memberKey ||
    !isApprovalReviewerStatus(status) ||
    (decidedAt !== undefined && typeof decidedAt !== 'string') ||
    (comment !== undefined && typeof comment !== 'string')
  ) {
    throw invalidVersionResponse()
  }
  return {
    memberKey,
    status,
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(comment === undefined ? {} : { comment }),
  }
}

/**
 * Reads one Document version approval, checking every field of the shared contract that the
 * version review shows.
 *
 * @param value - Parsed response value.
 * @returns The approval request for a Document version.
 * @throws DocumentsApiError when a required field, a status, or a reviewer is malformed.
 */
function readDocumentApproval(value: unknown): ApprovalRequest {
  const record = readRecord(value)
  const capabilities = readRecord(record.capabilities)
  const {
    id,
    documentId,
    versionId,
    teamId,
    issueId,
    projectId,
    revision,
    status,
    reviewers,
    dueAt,
    requestedByMemberKey,
    requestedByKind,
    createdAt,
    updatedAt,
    completedAt,
  } = record
  const { canDecide, canCancel } = capabilities
  if (
    typeof id !== 'string' ||
    record.subjectType !== 'document-version' ||
    typeof documentId !== 'string' ||
    typeof versionId !== 'string' ||
    (teamId !== undefined && typeof teamId !== 'string') ||
    (issueId !== undefined && typeof issueId !== 'string') ||
    (projectId !== undefined && typeof projectId !== 'string') ||
    typeof revision !== 'number' ||
    !isApprovalRequestStatus(status) ||
    !Array.isArray(reviewers) ||
    typeof dueAt !== 'string' ||
    typeof requestedByMemberKey !== 'string' ||
    (requestedByKind !== 'member' && requestedByKind !== 'service') ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    (completedAt !== undefined && typeof completedAt !== 'string') ||
    typeof canDecide !== 'boolean' ||
    typeof canCancel !== 'boolean'
  ) {
    throw invalidVersionResponse()
  }
  return {
    id,
    subjectType: 'document-version',
    documentId,
    versionId,
    ...(teamId === undefined ? {} : { teamId }),
    ...(issueId === undefined ? {} : { issueId }),
    ...(projectId === undefined ? {} : { projectId }),
    revision,
    status,
    reviewers: reviewers.map(readApprovalReviewer),
    dueAt,
    requestedByMemberKey,
    requestedByKind,
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    capabilities: { canDecide, canCancel },
  }
}

/**
 * Checks that every entry of a list is an object with a string ID.
 *
 * @param value - Parsed response value.
 * @returns Whether the value is a list of identified records.
 */
function isIdentifiedRecordList(value: unknown) {
  return Array.isArray(value) &&
    value.every((entry) => typeof readRecord(entry).id === 'string')
}

/**
 * Checks the content a version snapshot is shown with, for its kind: the blocks of a page or
 * template, the objects, connectors, and frames of a whiteboard, or the child count of a folder.
 *
 * @param value - Parsed `document` of a version detail.
 * @returns Whether the snapshot has the content its kind needs.
 */
function isVersionSnapshot(value: unknown) {
  const record = readRecord(value)
  if (
    typeof record.id !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.revision !== 'number'
  ) {
    return false
  }
  if (record.kind === 'page' || record.kind === 'template') {
    return isIdentifiedRecordList(record.blocks) &&
      Array.isArray(record.blocks) &&
      record.blocks.every((block) => typeof readRecord(block).type === 'string')
  }
  if (record.kind === 'whiteboard') {
    const whiteboard = readRecord(record.whiteboard)
    return isIdentifiedRecordList(whiteboard.objects) &&
      isIdentifiedRecordList(whiteboard.connectors) &&
      isIdentifiedRecordList(whiteboard.frames)
  }
  return record.kind === 'folder' && typeof record.childCount === 'number'
}

/**
 * Creates the error for a malformed version response.
 *
 * @returns The Documents API error.
 */
function invalidVersionResponse() {
  return new DocumentsApiError(
    502,
    'Document version response was invalid.',
    'InvalidDocumentVersionResponse',
  )
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
 * Reads the `{ document }` detail returned by the version restore endpoint.
 *
 * @param value - Parsed response body.
 * @returns The restored Document detail.
 * @throws DocumentsApiError when the body does not wrap a Document detail.
 */
function readDocumentRecord(value: unknown): DocumentDetail {
  const document = readRecord(readRecord(value).document)

  if (typeof document.id !== 'string' || typeof document.title !== 'string') {
    throw new DocumentsApiError(
      502,
      'Document response was invalid.',
      'InvalidDocumentResponse',
    )
  }

  return document as unknown as DocumentDetail
}

