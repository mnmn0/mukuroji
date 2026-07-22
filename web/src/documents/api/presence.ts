import type { DocumentPresenceResponse, UpdateDocumentPresenceInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}
