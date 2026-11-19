import { useEffect, useState } from 'react'
import useSWR from 'swr'
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
export type DocumentLinkSearch = {
  /** Results for the settled query. */
  results: WorkspaceSearchResult[]
  /** Whether the typed query is waiting for the debounce or a response. */
  isLoading: boolean
  /** Whether the search for the settled query failed. */
  hasError: boolean
  /** Sends the settled query again. */
  retry: () => void
}

/**
 * Returns the value once it has stopped changing for the debounce delay.
 *
 * @param value - Value that changes while the user types.
 * @returns The last value that stayed unchanged for the delay.
 */
function useDebouncedValue(value: string): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setDebounced(value),
      LINK_SEARCH_DEBOUNCE_MS,
    )
    return () => window.clearTimeout(timeoutId)
  }, [value])
  return debounced
}

/**
 * Searches one Workspace entity type while the user types.
 *
 * @param accessToken - Workspace API token; omission disables search.
 * @param entityType - Entity type to search, or undefined to disable search.
 * @param query - Raw keyword typed by the user.
 * @returns Results, loading, and error state for the settled query, and a retry.
 */
export function useDocumentLinkSearch(
  accessToken: string | undefined,
  entityType: SearchEntityType | undefined,
  query: string,
): DocumentLinkSearch {
  const keyword = query.trim()
  const settledKeyword = useDebouncedValue(keyword)
  const isEnabled = Boolean(accessToken && entityType && keyword)
  const key = accessToken && entityType && keyword && settledKeyword
    ? ['document-link-search', accessToken, entityType, settledKeyword] as const
    : null
  const { data, error, isLoading, mutate } = useSWR(
    key,
    ([, token, type, currentKeyword]) =>
      searchWorkspaceAcrossCursors(
        token,
        { keyword: currentKeyword, entityTypes: [type] },
        { pageLimit: 3, resultLimit: LINK_SEARCH_RESULT_LIMIT },
      ),
    {
      dedupingInterval: 10_000,
      keepPreviousData: false,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
  const isSettled = settledKeyword === keyword

  return {
    hasError: isEnabled && isSettled && error !== undefined,
    isLoading: isEnabled && (!isSettled || isLoading),
    results: isEnabled && isSettled ? data?.results ?? [] : [],
    retry: () => void mutate(),
  }
}
