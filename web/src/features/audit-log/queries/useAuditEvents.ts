import useSWRInfinite from 'swr/infinite'
import type { AuditEventFilters, AuditEventPageView } from '@mukuroji/contracts'
import { listAuditEvents } from '../api/auditEvents'

/** Wraps a request so the Workspace shell can react to session-policy failures. */
export type AuditLogRequestGuard = <Result>(request: Promise<Result>) => Promise<Result>

/**
 * Searches the audit log page by page once the member has run a search.
 *
 * The server records every page read as an `audit.viewed` event, so the query never
 * revalidates on its own (focus, reconnect, stale data, or errors); only a search, a
 * further page, or an explicit retry reads again.
 *
 * @param accessToken - Bearer token; omission disables the query.
 * @param filters - Filters of the search that was run; undefined until the first search.
 * @param searchRun - Number of the explicit search; a new number reads again even for filters
 *   whose results are already cached.
 * @param guardRequest - Session-policy guard of the Workspace shell.
 * @returns Events read so far, loading and error state, and pagination and retry entry points.
 */
export function useAuditEvents(
  accessToken: string | undefined,
  filters: AuditEventFilters | undefined,
  searchRun: number,
  guardRequest: AuditLogRequestGuard,
) {
  const query = useSWRInfinite(
    (pageIndex, previousPage: AuditEventPageView | null) => {
      if (!accessToken || !filters) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      // SWR hashes the filter object by value; the search number keeps each explicit search apart.
      return ['audit-events', accessToken, filters, searchRun, pageIndex === 0 ? '' : previousPage?.nextCursor ?? ''] as const
    },
    ([, token, currentFilters, , cursor]) =>
      guardRequest(listAuditEvents(token, currentFilters, cursor || undefined)),
    {
      revalidateFirstPage: false,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  )
  const pages = query.data
  const isEnabled = Boolean(accessToken && filters)

  return {
    events: pages?.flatMap((page) => page.events) ?? [],
    error: query.error,
    hasMore: Boolean(pages?.at(-1)?.nextCursor),
    isLoading: isEnabled && query.isLoading,
    isLoadingMore: Boolean(query.isValidating && query.size > (pages?.length ?? 0)),
    loadMore: () => query.setSize((current) => current + 1),
    refresh: () => query.mutate(),
  }
}

