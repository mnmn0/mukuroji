import type { CursorPage, SyncConflictStatus, WorkItemSyncConflict } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type {
  ResolveDeveloperSyncConflictInput,
} from '../model/connectors'
import { DeveloperPlatformApiError } from './errors'

export type {
  DeveloperSyncConflictResolution,
  ResolveDeveloperSyncConflictInput,
} from '../model/connectors'

/**
 * Work Item 同期競合一覧の filter と pagination 入力です。
 */
export type ListDeveloperSyncConflictsInput = {
  /**
   * 表示する同期競合の解決状態です。
   */
  status?: SyncConflictStatus
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
 * Work Item 同期競合を cursor pagination で取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Status filter、cursor、取得上限です。
 * @param signal - 画面遷移時に request を中止する AbortSignal です。
 * @returns 同期競合と次 page cursor です。
 */
export function listDeveloperSyncConflicts(
  accessToken: string,
  input: ListDeveloperSyncConflictsInput = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()

  if (input.status) {
    query.set('status', input.status)
  }
  if (input.cursor) {
    query.set('cursor', input.cursor)
  }
  if (input.limit !== undefined) {
    query.set('limit', String(input.limit))
  }

  const suffix = query.size ? `?${query.toString()}` : ''

  return requestJson<CursorPage<WorkItemSyncConflict>>(
    `/developer/sync-conflicts${suffix}`,
    accessToken,
    { signal },
  )
}

/**
 * Work Item 同期競合を解決します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Conflict ID と解決方針です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 解決状態を反映した同期競合です。
 */
export function resolveDeveloperSyncConflict(
  accessToken: string,
  input: ResolveDeveloperSyncConflictInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<WorkItemSyncConflict>(
    `/developer/sync-conflicts/${encodeURIComponent(input.conflictId)}/resolve`,
    accessToken,
    createJsonMutation(
      'POST',
      {
        resolution:
          input.resolution === 'keep-local'
            ? 'use-local'
            : input.resolution === 'keep-remote'
              ? 'use-external'
              : input.resolution,
        ...(input.resolution === 'merge'
          ? { mergedValues: input.mergedValues }
          : {}),
      },
      mutationContext,
    ),
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
