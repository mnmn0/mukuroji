import useSWR from 'swr'
import { searchWorkspaceAcrossCursors } from '../../../search/api'
import { getCollectionItems, getCollections } from '../api/collections'
import { toCollectionCandidates } from '../model/collectionCandidates'

/** Shared SWR key namespace for Collection queries. */
export const COLLECTIONS_QUERY_KEY = 'collections'

/** Maximum number of candidates shown for one search. */
const COLLECTION_CANDIDATE_LIMIT = 12

const collectionQueryConfig = {
  dedupingInterval: 5_000,
  shouldRetryOnError: false,
} as const

/**
 * Loads the Workspace's Collections.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param enabled - Whether the query may run.
 * @returns SWR state for the Collection list.
 */
export function useCollections(accessToken: string | undefined, enabled: boolean) {
  return useSWR(
    accessToken && enabled ? [COLLECTIONS_QUERY_KEY, accessToken, 'list'] as const : null,
    ([, token]) => getCollections(token),
    collectionQueryConfig,
  )
}

/**
 * Loads the readable Work Items of one Collection.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param collectionId - Selected Collection, if any.
 * @param enabled - Whether the query may run.
 * @returns SWR state for the Collection items.
 */
export function useCollectionItems(accessToken: string | undefined, collectionId: string | undefined, enabled: boolean) {
  return useSWR(
    accessToken && collectionId && enabled ? [COLLECTIONS_QUERY_KEY, accessToken, 'items', collectionId] as const : null,
    ([, token, , id]) => getCollectionItems(token, id),
    collectionQueryConfig,
  )
}

/**
 * Searches the Work Items that can be added to a Collection.
 *
 * Candidates come from the permission-filtered, cursor-paginated Workspace search, so
 * large Workspaces never load every Work Item at once. Nothing is requested until the
 * caller enters a keyword.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param keyword - Search keyword; blank disables the query.
 * @param enabled - Whether the query may run.
 * @returns SWR state for the matching candidates.
 */
export function useCollectionCandidates(accessToken: string | undefined, keyword: string, enabled: boolean) {
  const normalized = keyword.trim()
  return useSWR(
    accessToken && enabled && normalized ? [COLLECTIONS_QUERY_KEY, accessToken, 'candidates', normalized] as const : null,
    async ([, token, , query]) => toCollectionCandidates((await searchWorkspaceAcrossCursors(
      token,
      { keyword: query, entityTypes: ['work-item'] },
      { resultLimit: COLLECTION_CANDIDATE_LIMIT, pageLimit: 5 },
    )).results),
    collectionQueryConfig,
  )
}
