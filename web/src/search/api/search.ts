import { type WorkspaceSearchFilters, type WorkspaceSearchResponse } from '@mukuroji/contracts'
import { WorkspaceSearchApiError, resolveSearchApiBaseUrl } from './errors'

const searchApiBaseUrl = resolveSearchApiBaseUrl(import.meta.env)

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
