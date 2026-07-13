import {
  type CreateSavedWorkspaceViewInput,
  type SavedWorkspaceView,
  type UpdateSavedWorkspaceViewInput,
  type WorkspaceSearchFilters,
  type WorkspaceSearchResponse,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../api/mutationHeaders'

const searchApiBaseUrl = resolveSearchApiBaseUrl(import.meta.env)

/**
 * Workspace search API の base URL を既存 Workspace API と同じ優先順で解決します。
 */
export function resolveSearchApiBaseUrl(environment: Record<string, string | boolean | undefined>) {
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
 * Workspace search / saved view API が失敗したときの例外です。
 */
export class WorkspaceSearchApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Workspace 全体を権限考慮済みsearch indexから検索します。
 */
export async function searchWorkspace(
  accessToken: string,
  filters: WorkspaceSearchFilters,
  options: {
    /**
     * APIから返されたopaque cursorです。
     */
    cursor?: string
    /**
     * 1 pageあたりの最大結果数です。
     */
    limit?: number
    /**
     * requestを中断するAbortSignalです。
     */
    signal?: AbortSignal
  } = {},
) {
  const query = new URLSearchParams({ limit: String(options.limit ?? 30) })
  if (Object.keys(filters).length > 0) {
    query.set('filters', JSON.stringify(filters))
  }

  if (options.cursor) {
    query.set('cursor', options.cursor)
  }

  return requestJson<WorkspaceSearchResponse>(
    `${searchApiBaseUrl}/search?${query.toString()}`,
    accessToken,
    { signal: options.signal },
  )
}

/**
 * Backendのscan cursorを追跡し、指定件数の検索結果が集まるまで限定的に検索します。
 *
 * Command menuのように手動paginationを持たないsurface向けです。権限判定後の結果が
 * 先頭scan pageにない場合も検索を続けつつ、page上限でrequest数を制限します。
 */
export async function searchWorkspaceAcrossCursors(
  accessToken: string,
  filters: WorkspaceSearchFilters,
  options: {
    /**
     * 集約する検索結果の最大件数です。
     */
    resultLimit?: number
    /**
     * 追跡するscan pageの最大件数です。
     */
    pageLimit?: number
    /**
     * requestを中断するAbortSignalです。
     */
    signal?: AbortSignal
  } = {},
) {
  const resultLimit = Math.max(1, Math.min(12, Math.trunc(options.resultLimit ?? 12)))
  const pageLimit = Math.max(1, Math.min(5, Math.trunc(options.pageLimit ?? 5)))
  const results: WorkspaceSearchResponse['results'] = []
  const seenResults = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let latestResponse: WorkspaceSearchResponse | undefined

  for (let page = 0; page < pageLimit && results.length < resultLimit; page += 1) {
    latestResponse = await searchWorkspace(accessToken, filters, {
      cursor,
      limit: resultLimit - results.length,
      signal: options.signal,
    })

    for (const result of latestResponse.results) {
      const resultKey = `${result.entityType}:${result.teamId ?? ''}:${result.id}`
      if (!seenResults.has(resultKey)) {
        seenResults.add(resultKey)
        results.push(result)
      }

      if (results.length >= resultLimit) {
        break
      }
    }

    const nextCursor = latestResponse.nextCursor
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break
    }

    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  if (!latestResponse) {
    throw new WorkspaceSearchApiError(500, 'Search page limit was invalid.', 'InvalidSearchPageLimit')
  }

  return {
    ...latestResponse,
    results,
  }
}

/**
 * 現在ユーザーが利用できるpersonal/team/shared saved viewを取得します。
 */
export async function getSavedWorkspaceViews(accessToken: string, signal?: AbortSignal) {
  const views: SavedWorkspaceView[] = []
  const seenViewIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor) {
      query.set('cursor', cursor)
    }
    const response = await requestJson<unknown>(
      `${searchApiBaseUrl}/saved-views?${query.toString()}`,
      accessToken,
      { signal },
    )
    const page = readSavedViewsPage(response)
    for (const view of page.views) {
      if (!seenViewIds.has(view.id)) {
        seenViewIds.add(view.id)
        views.push(view)
      }
    }

    cursor = page.nextCursor && !seenCursors.has(page.nextCursor)
      ? page.nextCursor
      : undefined
    if (cursor) {
      seenCursors.add(cursor)
    }
  } while (cursor)

  return views
}

/**
 * Workspace search stateを新しいsaved viewとして保存します。
 */
export async function createSavedWorkspaceView(
  accessToken: string,
  input: CreateSavedWorkspaceViewInput,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<unknown>(
    `${searchApiBaseUrl}/saved-views`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )

  return readSavedView(response)
}

/**
 * 既存saved viewのquery、layout、共有範囲、favorite状態を更新します。
 */
export async function updateSavedWorkspaceView(
  accessToken: string,
  viewId: string,
  input: UpdateSavedWorkspaceViewInput,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<unknown>(
    `${searchApiBaseUrl}/saved-views/${encodeURIComponent(viewId)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PATCH',
    },
  )

  return readSavedView(response)
}

/**
 * 既存saved viewを削除します。
 */
export async function deleteSavedWorkspaceView(
  accessToken: string,
  viewId: string,
  expectedRevision: number,
  mutationContext: MutationRequestContext,
) {
  const query = new URLSearchParams({ expectedRevision: String(expectedRevision) })

  await requestJson<unknown>(
    `${searchApiBaseUrl}/saved-views/${encodeURIComponent(viewId)}?${query.toString()}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

/**
 * Search API resultに含まれる遷移先を同一origin内のpathとして返します。
 */
export function resolveSearchResultPath(result: unknown) {
  const record = asRecord(result)
  const url = typeof record.url === 'string' ? record.url : undefined

  if (!url) {
    return undefined
  }

  try {
    const parsed = new URL(url, window.location.origin)
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : undefined
  } catch {
    return url.startsWith('/') ? url : undefined
  }
}

function readSavedViewsPage(value: unknown) {
  if (Array.isArray(value)) {
    return { views: value as SavedWorkspaceView[] }
  }

  const record = asRecord(value)
  return {
    views: Array.isArray(record.views) ? record.views as SavedWorkspaceView[] : [],
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : undefined,
  }
}

function readSavedView(value: unknown) {
  const record = asRecord(value)
  const view = record.view ?? value

  if (!view || typeof view !== 'object') {
    throw new WorkspaceSearchApiError(502, 'Saved view response was invalid.', 'InvalidSavedViewResponse')
  }

  return view as SavedWorkspaceView
}

async function requestJson<TResponse>(
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
  const body = await readJson(response)

  if (!response.ok) {
    const error = asRecord(body)
    throw new WorkspaceSearchApiError(
      response.status,
      typeof error.message === 'string' ? error.message : 'Unable to complete the search request.',
      typeof error.code === 'string' ? error.code : undefined,
    )
  }

  return body as TResponse
}

async function readJson(response: Response) {
  const text = await response.text()

  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new WorkspaceSearchApiError(response.status, 'Search API returned invalid JSON.', 'InvalidSearchResponse')
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
