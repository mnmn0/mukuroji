import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../api/mutationHeaders'

const bulkOperationsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/** Bulk operation API が返す安定した HTTP error です。 */
export class BulkOperationsApiError extends Error {
  /** HTTP status code です。 */
  readonly status: number

  /** Server が返した安定 error code です。 */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Preview token と確定対象 request をまとめた apply payload です。 */
export type ApplyBulkOperationRequest = BulkOperationRequest & {
  /** Preview した内容だけを確定する短寿命 token です。 */
  operationToken: string
}

/**
 * Bulk operation を dry-run し、item ごとの validation 結果を取得します。
 *
 * @param accessToken API 認証に使う access token です。
 * @param request Preview する bulk action と対象 item です。
 * @param mutationContext logical preview retry で共有する request context です。
 */
export function previewBulkOperation(
  accessToken: string,
  request: BulkOperationRequest,
  mutationContext: MutationRequestContext,
) {
  return requestJson<BulkOperationPreview>(
    `${bulkOperationsApiBaseUrl}/bulk-operations/preview`,
    accessToken,
    createPostInit(request, mutationContext),
  )
}

/**
 * Preview 済み Bulk operation を確定します。
 *
 * @param accessToken API 認証に使う access token です。
 * @param request Preview token を含む確定 request です。
 * @param mutationContext logical apply retry で共有する request context です。
 */
export function applyBulkOperation(
  accessToken: string,
  request: ApplyBulkOperationRequest,
  mutationContext: MutationRequestContext,
) {
  return requestJson<BulkOperation>(
    `${bulkOperationsApiBaseUrl}/bulk-operations`,
    accessToken,
    createPostInit(request, mutationContext),
  )
}

/**
 * Bulk operation の failed item だけを再試行します。
 *
 * @param accessToken API 認証に使う access token です。
 * @param operationId 再試行する operation ID です。
 * @param mutationContext logical retry で共有する request context です。
 */
export function retryBulkOperation(
  accessToken: string,
  operationId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<BulkOperation>(
    `${bulkOperationsApiBaseUrl}/bulk-operations/${encodeURIComponent(operationId)}/retry`,
    accessToken,
    createPostInit(undefined, mutationContext),
  )
}

/**
 * Bulk operation の成功 item を undo します。
 *
 * @param accessToken API 認証に使う access token です。
 * @param operationId Undo する operation ID です。
 * @param mutationContext logical undo retry で共有する request context です。
 */
export function undoBulkOperation(
  accessToken: string,
  operationId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<BulkOperation>(
    `${bulkOperationsApiBaseUrl}/bulk-operations/${encodeURIComponent(operationId)}/undo`,
    accessToken,
    createPostInit(undefined, mutationContext),
  )
}

function createPostInit(
  body: unknown,
  mutationContext: MutationRequestContext,
): RequestInit {
  return {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...createMutationHeaders(mutationContext),
    },
    method: 'POST',
  }
}

async function requestJson<TResponse>(
  url: string,
  accessToken: string,
  init: RequestInit,
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson(response)

  if (!response.ok) {
    throw new BulkOperationsApiError(
      response.status,
      readOptionalString(data, 'message') ?? 'Unable to complete the bulk operation request.',
      readOptionalString(data, 'code'),
    )
  }

  return data as TResponse
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  return text ? JSON.parse(text) : {}
}

function readOptionalString(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return undefined
  }

  const fieldValue = (value as Record<string, unknown>)[key]
  return typeof fieldValue === 'string' && fieldValue.trim() ? fieldValue : undefined
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
