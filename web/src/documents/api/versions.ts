import type { DocumentDetail, DocumentDetailResponse, DocumentVersionsResponse } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'

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
