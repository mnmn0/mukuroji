import { useEffect, useState } from 'react'
import type {
  SearchEntityType,
  WorkspaceSearchResult,
} from '@mukuroji/contracts'
import { searchWorkspaceAcrossCursors } from '../../search/api'

/** Delay before a typed query is sent to Workspace search. */
const LINK_SEARCH_DEBOUNCE_MS = 200

/** Maximum number of candidates shown for one query. */
const LINK_SEARCH_RESULT_LIMIT = 8

/**
 * Debounced, permission-filtered Workspace search state for one entity type.
 */
export type LinkSearchState = {
  /** Results for the latest settled query. */
  results: WorkspaceSearchResult[]
  /** Whether a request for the current query is running. */
  isLoading: boolean
  /** Whether the latest request failed. */
  hasError: boolean
}

/**
 * Search state plus a way to repeat a failed search.
 */
export type DocumentLinkSearch = LinkSearchState & {
  /** Sends the current query again. */
  retry: () => void
}

/**
 * Searches one Workspace entity type while the user types.
 *
 * @param accessToken - Workspace API token; omission disables search.
 * @param entityType - Entity type to search, or undefined to disable search.
 * @param query - Raw keyword typed by the user.
 * @returns Results, loading, and error state for the latest query, and a retry.
 */
export function useDocumentLinkSearch(
  accessToken: string | undefined,
  entityType: SearchEntityType | undefined,
  query: string,
): DocumentLinkSearch {
  const keyword = query.trim()
  const [attempt, setAttempt] = useState(0)
  const retry = () => setAttempt((current) => current + 1)
  const [state, setState] = useState<LinkSearchState & { key: string }>({
    key: '',
    results: [],
    isLoading: false,
    hasError: false,
  })
  const key = accessToken && entityType && keyword
    ? `${entityType}\0${keyword}`
    : ''

  useEffect(() => {
    if (!accessToken || !entityType || !keyword) return undefined
    const abortController = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setState({ key, results: [], isLoading: true, hasError: false })
      searchWorkspaceAcrossCursors(
        accessToken,
        { keyword, entityTypes: [entityType] },
        {
          pageLimit: 3,
          resultLimit: LINK_SEARCH_RESULT_LIMIT,
          signal: abortController.signal,
        },
      )
        .then((response) => {
          setState({
            key,
            results: response.results,
            isLoading: false,
            hasError: false,
          })
        })
        .catch(() => {
          if (abortController.signal.aborted) return
          setState({ key, results: [], isLoading: false, hasError: true })
        })
    }, LINK_SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timeoutId)
      abortController.abort()
    }
  }, [accessToken, attempt, entityType, key, keyword])

  if (!key || state.key !== key) {
    return { results: [], isLoading: Boolean(key), hasError: false, retry }
  }
  return { ...state, retry }
}
