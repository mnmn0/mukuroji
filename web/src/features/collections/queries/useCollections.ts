import useSWR from 'swr'
import { getCollectionItems, getCollections, searchCollectionCandidatePage } from '../api/collections'
import { collectionCandidateKey, toCollectionCandidates, type CollectionCandidate } from '../model/collectionCandidates'

/** Shared SWR key namespace for Collection queries. */
export const COLLECTIONS_QUERY_KEY = 'collections'

/** Maximum number of candidates shown for one search. */
const COLLECTION_CANDIDATE_LIMIT = 12

/**
 * Hard cap on search pages read for one candidate search.
 *
 * A page can come back empty while a cursor remains, because each server page evaluates a
 * bounded number of index rows that may all be other entity types. Reading continues while a
 * cursor remains, and this cap only bounds a pathological scan.
 */
const COLLECTION_CANDIDATE_PAGE_CAP = 100

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
 * large Workspaces never load every Work Item at once. Work Items already in the
 * Collection are skipped while paging, so they never use up the result limit. Nothing
 * is requested until the caller enters a keyword.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param keyword - Search keyword; blank disables the query.
 * @param excludedKeys - `teamId`/`issueId` keys already in the Collection.
 * @param enabled - Whether the query may run.
 * @returns SWR state for the matching candidates.
 */
export function useCollectionCandidates(
  accessToken: string | undefined,
  keyword: string,
  excludedKeys: readonly string[],
  enabled: boolean,
) {
  const normalized = keyword.trim()
  const excluded = [...excludedKeys].sort().join('\n')
  return useSWR(
    accessToken && enabled && normalized ? [COLLECTIONS_QUERY_KEY, accessToken, 'candidates', normalized, excluded] as const : null,
    ([, token, , query, excludedList]) => searchCollectionCandidates(token, query, new Set(excludedList ? excludedList.split('\n') : [])),
    collectionQueryConfig,
  )
}

/**
 * Pages through Work Item search results until enough addable candidates are found.
 *
 * @param token - Bearer token for the Workspace.
 * @param keyword - Search keyword.
 * @param excluded - Candidate keys already in the Collection.
 * @returns Up to `COLLECTION_CANDIDATE_LIMIT` addable candidates.
 */
export async function searchCollectionCandidates(token: string, keyword: string, excluded: ReadonlySet<string>): Promise<CollectionCandidate[]> {
  const candidates: CollectionCandidate[] = []
  const seen = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < COLLECTION_CANDIDATE_PAGE_CAP && candidates.length < COLLECTION_CANDIDATE_LIMIT; page += 1) {
    const response = await searchCollectionCandidatePage(token, keyword, {
      limit: COLLECTION_CANDIDATE_LIMIT,
      ...(cursor ? { cursor } : {}),
    })
    for (const candidate of toCollectionCandidates(response.results)) {
      const key = collectionCandidateKey(candidate.teamId, candidate.issueId)
      if (excluded.has(key) || seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
      if (candidates.length >= COLLECTION_CANDIDATE_LIMIT) break
    }
    if (!response.nextCursor || seenCursors.has(response.nextCursor)) break
    seenCursors.add(response.nextCursor)
    cursor = response.nextCursor
  }
  return candidates
}
