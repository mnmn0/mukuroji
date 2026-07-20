import type { ApplyDocumentOperationsInput, ApplyDocumentOperationsResponse } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { getDocument } from './documents'
import type { DocumentRecord } from './documents'
import { DocumentRevisionConflictError, DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'

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

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}
