import type { CreateDocumentShareInput, CreateDocumentShareResponse, DocumentMemberShare, DocumentPublicShare, RevokeDocumentShareInput, DocumentSharesResponse } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DocumentsApiError, resolveDocumentsApiBaseUrl } from './errors'

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

const documentsApiBaseUrl = resolveDocumentsApiBaseUrl(import.meta.env)

const createdPublicShareUrls = new Map<string, string>()

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

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/u, '')
}
