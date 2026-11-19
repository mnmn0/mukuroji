import useSWRInfinite from 'swr/infinite'
import {
  getProjectDocumentsPage,
  type ProjectDocumentsPage,
} from './projectDocumentsLoader'

/**
 * Loads the active Documents in one Project scope, page by page.
 *
 * @param accessToken - Workspace API token; omission disables the query.
 * @param projectId - Project whose Documents are listed; omission disables it.
 * @returns Documents read so far, loading and error state, and pagination and
 *   retry entry points.
 */
export function useProjectDocuments(
  accessToken: string | undefined,
  projectId: string | undefined,
) {
  const query = useSWRInfinite(
    (pageIndex, previousPage: ProjectDocumentsPage | null) => {
      if (!accessToken || !projectId) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'project-documents',
        accessToken,
        projectId,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, currentProjectId, cursor]) =>
      getProjectDocumentsPage(token, currentProjectId, cursor || undefined),
    { revalidateFirstPage: false, revalidateOnFocus: false },
  )
  const pages = query.data
  const isEnabled = Boolean(accessToken && projectId)

  return {
    documents: pages?.flatMap((page) => page.documents) ?? [],
    error: query.error,
    hasMore: Boolean(pages?.at(-1)?.nextCursor),
    isLoading: isEnabled && query.isLoading,
    isLoadingMore: Boolean(
      query.isValidating && query.size > (pages?.length ?? 0),
    ),
    loadMore: () => query.setSize((current) => current + 1),
    refresh: () => query.mutate(),
  }
}
