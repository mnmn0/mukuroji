import { type WorkspaceSearchFilters, type WorkspaceSearchResponse } from '@mukuroji/contracts'
import { WorkspaceSearchApiError, resolveSearchApiBaseUrl } from './errors'
import { readRecord } from '../../shared/api/jsonValidation'

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

/** Maximum results the command menu shows for one query. */
const COMMAND_MENU_RESULT_LIMIT = 12

/** Result slots the command menu keeps for Projects so Work Item title matches cannot crowd them out. */
const COMMAND_MENU_PROJECT_SLOTS = 4

/**
 * Searches the Workspace for the command menu so one query can open both Work Items and Projects.
 *
 * The Workspace-wide search reads Work Items before Projects, so a short keyword that matches
 * many Work Item titles would fill every slot before any Project. A second Project-only search
 * runs in parallel and up to four of its matches are kept at the end of the list. When only the
 * Project search fails, the Workspace-wide results are still returned.
 *
 * @param accessToken - Access token of the signed-in user.
 * @param keyword - Trimmed keyword typed into the command menu.
 * @param options - Optional AbortSignal that cancels both searches.
 * @returns Up to 12 permitted results in API order, followed by Projects the page did not reach.
 */
export async function searchWorkspaceForCommandMenu(
  accessToken: string,
  keyword: string,
  options: {
    /**
     * requestを中断するAbortSignalです。
     */
    signal?: AbortSignal
  } = {},
): Promise<WorkspaceSearchResponse> {
  const [workspaceSearch, projectSearch] = await Promise.allSettled([
    searchWorkspaceAcrossCursors(accessToken, { keyword }, {
      pageLimit: 5,
      resultLimit: COMMAND_MENU_RESULT_LIMIT,
      signal: options.signal,
    }),
    searchWorkspaceAcrossCursors(accessToken, { keyword, entityTypes: ['project'] }, {
      pageLimit: 2,
      resultLimit: COMMAND_MENU_PROJECT_SLOTS,
      signal: options.signal,
    }),
  ])
  if (workspaceSearch.status === 'rejected') {
    throw workspaceSearch.reason
  }

  return {
    ...workspaceSearch.value,
    results: mergeCommandMenuSearchResults(
      workspaceSearch.value.results,
      projectSearch.status === 'fulfilled' ? projectSearch.value.results : [],
    ),
  }
}

/**
 * Merges Workspace-wide and Project-only search results into the command menu order.
 *
 * The Workspace-wide results keep their API order, which already puts title matches first.
 * Project matches that the Workspace-wide page did not reach are appended after it, and the
 * fewest trailing Workspace-wide results are dropped to make room for them.
 *
 * @param workspaceResults - Results of the Workspace-wide search, in API order.
 * @param projectResults - Results of the Project-only search, in API order.
 * @returns Deduplicated results capped at {@link COMMAND_MENU_RESULT_LIMIT}.
 */
export function mergeCommandMenuSearchResults(
  workspaceResults: WorkspaceSearchResponse['results'],
  projectResults: WorkspaceSearchResponse['results'],
): WorkspaceSearchResponse['results'] {
  const workspace = deduplicateSearchResults(workspaceResults)
  const projects = deduplicateSearchResults(projectResults).slice(0, COMMAND_MENU_PROJECT_SLOTS)
  for (let kept = Math.min(workspace.length, COMMAND_MENU_RESULT_LIMIT); kept >= 0; kept -= 1) {
    const shown = workspace.slice(0, kept)
    const shownKeys = new Set(shown.map(createSearchResultKey))
    const missingProjects = projects.filter((result) => !shownKeys.has(createSearchResultKey(result)))
    if (shown.length + missingProjects.length <= COMMAND_MENU_RESULT_LIMIT) {
      return [...shown, ...missingProjects]
    }
  }
  return projects
}

/**
 * Removes repeated search results while keeping the first occurrence of each.
 *
 * @param results - Search results in display order.
 * @returns Results without duplicates, in the same order.
 */
function deduplicateSearchResults(results: WorkspaceSearchResponse['results']) {
  const seenResults = new Set<string>()
  return results.filter((result) => {
    const resultKey = createSearchResultKey(result)
    if (seenResults.has(resultKey)) return false
    seenResults.add(resultKey)
    return true
  })
}

/**
 * Creates the identity of a search result across entity types and Teams.
 *
 * @param result - Search result.
 * @returns A key unique per entity type, Team and entity ID.
 */
function createSearchResultKey(result: WorkspaceSearchResponse['results'][number]) {
  return `${result.entityType}:${result.teamId ?? ''}:${result.id}`
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
    const error = readRecord(body)
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
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw new WorkspaceSearchApiError(response.status, 'Search API returned invalid JSON.', 'InvalidSearchResponse')
  }
}

