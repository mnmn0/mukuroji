import type { ExportDocumentResponse } from '@mukuroji/contracts'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

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
