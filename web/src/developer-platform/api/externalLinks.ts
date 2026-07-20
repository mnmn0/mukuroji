import type { CreateExternalWorkItemLinkInput, CursorPage, ExternalWorkItemLink, UpdateExternalWorkItemLinkInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { DeveloperPlatformApiError } from './errors'

/**
 * Work Item 外部 link 一覧の cursor pagination 入力です。
 */
export type ListDeveloperExternalLinksInput = {
  /**
   * 前 response が返した opaque cursor です。
   */
  cursor?: string
  /**
   * 一度に取得する最大件数です。
   */
  limit?: number
}

const developerApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

const defaultDeveloperApiErrorMessage =
  'Unable to complete the Developer Platform request.'

/**
 * Work Item に紐づく外部 resource link を cursor pagination で取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param teamId - Work Item を所有する Team ID です。
 * @param workItemId - Link 対象 Work Item ID です。
 * @param input - Cursor と取得上限です。
 * @param signal - 画面遷移時に request を中止する AbortSignal です。
 * @returns External link と次 page cursor です。
 */
export function listDeveloperExternalLinks(
  accessToken: string,
  teamId: string,
  workItemId: string,
  input: ListDeveloperExternalLinksInput = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ teamId })

  if (input.cursor) {
    query.set('cursor', input.cursor)
  }
  if (input.limit !== undefined) {
    query.set('limit', String(input.limit))
  }

  return requestJson<CursorPage<ExternalWorkItemLink>>(
    `/developer/work-items/${encodeURIComponent(workItemId)}/external-links?${query.toString()}`,
    accessToken,
    { signal },
  )
}

/**
 * Work Item と外部 resource の link を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param workItemId - Link 対象 Work Item ID です。
 * @param input - Installation、resource、同期方向です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 作成した external link です。
 */
export function createDeveloperExternalLink(
  accessToken: string,
  workItemId: string,
  input: CreateExternalWorkItemLinkInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ExternalWorkItemLink>(
    `/developer/work-items/${encodeURIComponent(workItemId)}/external-links`,
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * External link の同期方向を更新します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param linkId - 更新対象 external link ID です。
 * @param input - 新しい同期方向です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 更新した external link です。
 */
export function updateDeveloperExternalLink(
  accessToken: string,
  linkId: string,
  input: UpdateExternalWorkItemLinkInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ExternalWorkItemLink>(
    `/developer/external-links/${encodeURIComponent(linkId)}`,
    accessToken,
    createJsonMutation('PATCH', input, mutationContext),
  )
}

/**
 * Work Item と外部 resource の link を解除します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param teamId - External link が属する Team ID です。
 * @param workItemId - External link が属する Work Item ID です。
 * @param linkId - 削除対象 external link ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 */
export function deleteDeveloperExternalLink(
  accessToken: string,
  teamId: string,
  workItemId: string,
  linkId: string,
  mutationContext: MutationRequestContext,
) {
  const search = new URLSearchParams({ teamId, workItemId })
  return requestJson<unknown>(
    `/developer/external-links/${encodeURIComponent(linkId)}?${search.toString()}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
    true,
  )
}

function createJsonMutation(
  method: 'PATCH' | 'POST',
  body: unknown,
  mutationContext: MutationRequestContext,
): RequestInit {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method,
  }
}

async function requestJson<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  allowEmptyResponse = false,
) {
  const response = await fetch(`${developerApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(
    response,
    allowEmptyResponse || !response.ok,
    response.ok,
  )

  if (!response.ok) {
    const errorData = readErrorResponse(data)

    throw new DeveloperPlatformApiError(
      response.status,
      errorData?.message?.trim() ||
        errorData?.detail?.trim() ||
        defaultDeveloperApiErrorMessage,
      errorData?.code,
      isRetryableDeveloperApiResponse(response.status, errorData),
      readRetryAfterSeconds(response),
    )
  }

  return data as T
}

function readRetryAfterSeconds(response: Response) {
  const value = response.headers.get('Retry-After')?.trim()
  if (!value) return undefined
  if (/^\d+$/u.test(value)) {
    return Math.min(Number(value), 300)
  }
  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.min(Math.max(Math.ceil((retryAt - Date.now()) / 1_000), 0), 300)
}

function readErrorResponse(
  value: unknown,
): {
  code?: string
  detail?: string
  message?: string
  retryable?: boolean
} | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

function isRetryableDeveloperApiResponse(
  status: number,
  error: ReturnType<typeof readErrorResponse>,
) {
  return error?.retryable === true || status === 429 || status >= 500
}

async function readJson<T>(
  response: Response,
  allowEmpty: boolean,
  rejectMalformed: boolean,
): Promise<T> {
  const text = await response.text()

  if (!text) {
    if (allowEmpty) {
      return {} as T
    }

    throw new DeveloperPlatformApiError(
      response.status,
      'Developer Platform API returned an empty JSON response.',
      'InvalidDeveloperPlatformResponse',
      response.ok ||
        isRetryableDeveloperApiResponse(response.status, undefined),
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    if (!rejectMalformed) {
      return {} as T
    }

    throw new DeveloperPlatformApiError(
      response.status,
      'Developer Platform API returned invalid JSON.',
      'InvalidDeveloperPlatformResponse',
      response.ok ||
        isRetryableDeveloperApiResponse(response.status, undefined),
    )
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
