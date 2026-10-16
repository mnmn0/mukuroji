import useSWR from 'swr'
import { getCollectionItems, getCollections } from '../api/collections'

/** Shared SWR key namespace for Collection queries. */
export const COLLECTIONS_QUERY_KEY = 'collections'

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
