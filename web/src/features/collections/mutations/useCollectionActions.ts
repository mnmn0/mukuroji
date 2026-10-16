import type {
  WorkItemCollection,
  WorkItemCollectionEntry,
  WorkItemCollectionItemsResponse,
  WorkItemCollectionsResponse,
} from '@mukuroji/contracts'
import { useEffect, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestContext, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
  CollectionApiError,
  addCollectionItem,
  createCollection,
  deleteCollection,
  removeCollectionItem,
  updateCollection,
} from '../api/collections'
import { COLLECTIONS_QUERY_KEY } from '../queries/useCollections'

/**
 * Runs Collection mutations one at a time and refreshes every Collection query afterwards.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param guard - Shared authenticated-request error boundary.
 * @returns Mutation actions, the pending flag, and the latest failure.
 */
export function useCollectionActions(
  accessToken: string | undefined,
  guard: <T>(request: Promise<T>) => Promise<T>,
) {
  const { mutate } = useSWRConfig()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>()
  const busy = useRef(false)
  const active = useRef(true)
  const createContext = useRef<{ fingerprint: string; context: MutationRequestContext } | undefined>(undefined)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  /**
   * Runs one mutation and refreshes Collection queries whatever the outcome.
   *
   * @param request - Mutation to run with the current token.
   * @returns The mutation result, or undefined when it failed or was skipped.
   */
  const run = async <T,>(request: (token: string) => Promise<T>): Promise<T | undefined> => {
    if (!accessToken || busy.current) return undefined
    busy.current = true
    setPending(true)
    setError(undefined)
    try {
      return await guard(request(accessToken))
    } catch (failure) {
      if (active.current) setError(failure)
      return undefined
    } finally {
      // Revalidate the list and item queries without replacing cached data, so loaded state
      // stays visible meanwhile. Candidate searches are not revalidated: every keyword and
      // excluded-item set is its own key, and the next search derives a fresh one anyway.
      await mutate(
        (key) => Array.isArray(key) && key[0] === COLLECTIONS_QUERY_KEY && key[1] === accessToken && key[2] !== 'candidates',
      ).catch(() => undefined)
      busy.current = false
      if (active.current) setPending(false)
    }
  }

  /**
   * Writes a Collection returned by a mutation into the cached list before revalidation, so a
   * failed list refresh cannot keep the previous name or revision that later edits would send.
   *
   * @param token - Bearer token that keys the cached list.
   * @param updated - Collection returned by the mutation.
   * @returns The same Collection.
   */
  const cacheCollection = async (token: string, updated: WorkItemCollection): Promise<WorkItemCollection> => {
    await mutate(
      [COLLECTIONS_QUERY_KEY, token, 'list'],
      (current: WorkItemCollectionsResponse | undefined) => current
        ? {
            ...current,
            collections: current.collections
              .map((entry) => entry.collectionId === updated.collectionId ? updated : entry)
              .sort((left, right) => left.name.localeCompare(right.name)),
          }
        : current,
      { revalidate: false },
    )
    return updated
  }

  /**
   * Writes a successful item change into the selected Collection's cached items before
   * revalidation, so a failed item refresh cannot keep a removed Work Item on screen or
   * leave an added one missing and still offered as a candidate.
   *
   * @param token - Bearer token that keys the cached items.
   * @param updated - Collection returned by the mutation.
   * @param change - Builds the next item list from the cached one.
   */
  const cacheItems = async (
    token: string,
    updated: WorkItemCollection,
    change: (items: readonly WorkItemCollectionEntry[]) => WorkItemCollectionEntry[],
  ): Promise<void> => {
    await mutate(
      [COLLECTIONS_QUERY_KEY, token, 'items', updated.collectionId],
      (current: WorkItemCollectionItemsResponse | undefined) => current
        ? { collection: updated, items: change(current.items) }
        : current,
      { revalidate: false },
    )
  }

  return {
    pending,
    error,
    /** Clears the latest failure. */
    clearError: () => setError(undefined),
    /**
     * Creates a Collection, reusing the idempotency key while the same input is retried.
     *
     * @param name - Collection name.
     * @param description - Optional purpose.
     * @returns The created Collection, or undefined on failure.
     */
    create: async (name: string, description?: string): Promise<WorkItemCollection | undefined> => {
      const fingerprint = JSON.stringify([name, description ?? ''])
      if (createContext.current?.fingerprint !== fingerprint) {
        createContext.current = { fingerprint, context: createMutationRequestContext() }
      }
      const { context } = createContext.current
      const created = await run(async (token) => {
        const collection = await createCollection(token, { name, ...(description ? { description } : {}) }, context)
          .catch((failure: unknown) => {
            // The key's Collection was deleted; the next explicit attempt must use a new key.
            if (failure instanceof CollectionApiError && failure.code === 'CollectionDeleted') createContext.current = undefined
            throw failure
          })
        // Show the new Collection right away, even if the following list refresh fails.
        await mutate(
          [COLLECTIONS_QUERY_KEY, token, 'list'],
          (current: WorkItemCollectionsResponse | undefined) => current
            ? {
                ...current,
                collections: [...current.collections.filter((entry) => entry.collectionId !== collection.collectionId), collection]
                  .sort((left, right) => left.name.localeCompare(right.name)),
              }
            : current,
          { revalidate: false },
        )
        return collection
      })
      if (created) createContext.current = undefined
      return created
    },
    /**
     * Renames or re-describes a Collection.
     *
     * @param collection - Collection as last loaded.
     * @param name - New name.
     * @param description - New purpose; empty clears it.
     * @returns The updated Collection, or undefined on failure.
     */
    rename: (collection: WorkItemCollection, name: string, description: string) =>
      run(async (token) => await cacheCollection(
        token,
        await updateCollection(token, collection.collectionId, { expectedRevision: collection.revision, name, description }),
      )),
    /**
     * Deletes a Collection.
     *
     * @param collection - Collection as last loaded.
     * @returns True when the Collection was deleted.
     */
    remove: async (collection: WorkItemCollection) =>
      (await run(async (token) => {
        await deleteCollection(token, collection.collectionId, collection.revision)
        // Evict the confirmed deletion right away, so a failed list refresh cannot reselect it.
        await mutate(
          [COLLECTIONS_QUERY_KEY, token, 'list'],
          (current: WorkItemCollectionsResponse | undefined) => current
            ? { ...current, collections: current.collections.filter((entry) => entry.collectionId !== collection.collectionId) }
            : current,
          { revalidate: false },
        )
        return true
      })) === true,
    /**
     * Adds a Work Item to a Collection.
     *
     * @param collectionId - Collection identifier.
     * @param teamId - Team that owns the Work Item.
     * @param issueId - Work Item identifier.
     * @returns The Collection after the change, or undefined on failure.
     */
    addItem: (collectionId: string, teamId: string, issueId: string) =>
      run(async (token) => {
        const { item, ...updated } = await addCollectionItem(token, collectionId, teamId, issueId)
        // Most recently added first, matching the item list order.
        await cacheItems(token, updated, (items) => [
          item,
          ...items.filter((entry) => entry.teamId !== teamId || entry.issueId !== issueId),
        ])
        return await cacheCollection(token, updated)
      }),
    /**
     * Removes a Work Item reference from a Collection.
     *
     * @param collectionId - Collection identifier.
     * @param teamId - Team that owns the Work Item.
     * @param issueId - Work Item identifier.
     * @returns The Collection after the change, or undefined on failure.
     */
    removeItem: (collectionId: string, teamId: string, issueId: string) =>
      run(async (token) => {
        const updated = await removeCollectionItem(token, collectionId, teamId, issueId)
        await cacheItems(token, updated, (items) => items.filter((entry) => entry.teamId !== teamId || entry.issueId !== issueId))
        return await cacheCollection(token, updated)
      }),
  }
}
