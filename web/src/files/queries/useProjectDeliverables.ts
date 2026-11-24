import type {
  ProjectDeliverable,
  ProjectDeliverableApprovalFilter,
  ProjectDeliverablePage,
} from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { getProjectDeliverables } from '../api/deliverables'

/** Most pages the CSV export reads, so a runaway cursor cannot loop forever. */
const deliverableExportMaxPages = 100

/**
 * Filters of the Project deliverables list.
 */
export type ProjectDeliverableFilters = {
  /**
   * Approval state filter.
   */
  approval: ProjectDeliverableApprovalFilter
  /**
   * Whether only files with unresolved annotations are listed.
   */
  unresolvedOnly: boolean
}

/**
 * Deliverables list state and actions for one Project.
 */
export type ProjectDeliverablesController = {
  /**
   * Deliverables of every loaded page.
   */
  deliverables: ProjectDeliverable[]
  /**
   * Current filters.
   */
  filters: ProjectDeliverableFilters
  /**
   * Replaces the filters and reloads from the first page.
   */
  setFilters: (filters: ProjectDeliverableFilters) => void
  /**
   * Whether the first page is loading.
   */
  isLoading: boolean
  /**
   * Whether a further page is loading.
   */
  isLoadingMore: boolean
  /**
   * Whether loading failed.
   */
  hasError: boolean
  /**
   * Whether more Work Items remain to be read.
   */
  hasMore: boolean
  /**
   * Loads the next page.
   */
  loadMore: () => void
  /**
   * Reloads every loaded page.
   */
  refresh: () => Promise<void>
  /**
   * Reads every page with the current filters, for an export.
   */
  loadAll: () => Promise<ProjectDeliverable[]>
}

/**
 * Reads every page of a Project's deliverables.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose deliverables are listed.
 * @param accessToken - Files API access token.
 * @param filters - Filters of the list.
 * @returns Every matching deliverable, page by page.
 * @throws Error when the pages do not end within the export page limit.
 */
export async function loadAllProjectDeliverables(
  teamId: string,
  projectId: string,
  accessToken: string,
  filters: ProjectDeliverableFilters,
): Promise<ProjectDeliverable[]> {
  const deliverables: ProjectDeliverable[] = []
  let cursor: string | undefined
  for (let page = 0; page < deliverableExportMaxPages; page += 1) {
    const result = await getProjectDeliverables(teamId, projectId, accessToken, {
      ...filters,
      ...(cursor ? { cursor } : {}),
    })
    deliverables.push(...result.deliverables)
    if (!result.nextCursor) return deliverables
    cursor = result.nextCursor
  }
  throw new Error('Project deliverables exceed the export page limit.')
}

/**
 * Reads a Project's deliverables page by page with the filters the list shows.
 *
 * @param accessToken - Files API access token.
 * @param scope - Project to list; the query is idle without it.
 * @returns The deliverables list controller.
 */
export function useProjectDeliverables(
  accessToken: string | undefined,
  scope: { teamId: string; projectId: string } | undefined,
): ProjectDeliverablesController {
  const [filters, setFilters] = useState<ProjectDeliverableFilters>({
    approval: 'all',
    unresolvedOnly: false,
  })
  const query = useSWRInfinite(
    (pageIndex, previousPage: ProjectDeliverablePage | null) => {
      if (!accessToken || !scope) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'project-deliverables',
        accessToken,
        scope.teamId,
        scope.projectId,
        filters.approval,
        filters.unresolvedOnly,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, teamId, projectId, approval, unresolvedOnly, cursor]) => getProjectDeliverables(
      teamId,
      projectId,
      token,
      { approval, unresolvedOnly, ...(cursor ? { cursor } : {}) },
    ),
    { dedupingInterval: 5_000, revalidateFirstPage: false, shouldRetryOnError: false },
  )
  const pages = query.data
  const lastPage = pages?.at(-1)
  const { mutate, setSize } = query
  const refresh = useCallback(async () => {
    await mutate()
  }, [mutate])
  const loadMore = useCallback(() => {
    void setSize((size) => size + 1)
  }, [setSize])
  const loadAll = useCallback(async () => {
    if (!accessToken || !scope) return []
    return await loadAllProjectDeliverables(scope.teamId, scope.projectId, accessToken, filters)
  }, [accessToken, filters, scope])

  return {
    deliverables: pages?.flatMap((page) => page.deliverables) ?? [],
    filters,
    setFilters,
    isLoading: Boolean(accessToken && scope) && query.isLoading,
    isLoadingMore: query.isValidating && pages !== undefined && query.size > pages.length,
    hasError: query.error !== undefined,
    hasMore: Boolean(lastPage?.nextCursor),
    loadMore,
    refresh,
    loadAll,
  }
}
