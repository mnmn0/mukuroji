import type { WorkItemCollection, WorkItemCollectionsResponse } from '@mukuroji/contracts'
import { useEffect, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestContext, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
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
      await mutate(
        (key) => Array.isArray(key) && key[0] === COLLECTIONS_QUERY_KEY && key[1] === accessToken,
        undefined,
        { revalidate: true },
      ).catch(() => undefined)
      busy.current = false
      if (active.current) setPending(false)
    }
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
      run((token) => updateCollection(token, collection.collectionId, { expectedRevision: collection.revision, name, description })),
    /**
     * Deletes a Collection.
     *
     * @param collection - Collection as last loaded.
     * @returns True when the Collection was deleted.
     */
    remove: async (collection: WorkItemCollection) =>
      (await run(async (token) => {
        await deleteCollection(token, collection.collectionId, collection.revision)
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
      run((token) => addCollectionItem(token, collectionId, teamId, issueId)),
    /**
     * Removes a Work Item reference from a Collection.
     *
     * @param collectionId - Collection identifier.
     * @param teamId - Team that owns the Work Item.
     * @param issueId - Work Item identifier.
     * @returns The Collection after the change, or undefined on failure.
     */
    removeItem: (collectionId: string, teamId: string, issueId: string) =>
      run((token) => removeCollectionItem(token, collectionId, teamId, issueId)),
  }
}
