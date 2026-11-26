import type { PublicWorkItemWebLink } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { createWorkItemWebLink, deleteWorkItemWebLink } from '../api/webLinks'
import { useWorkItemWebLinks } from '../queries/useWorkItemWebLinks'

/**
 * Reads a Work Item's web links and returns the add and remove actions. Each action keeps its
 * idempotency context across a retry of the same input and reads the links again after it commits.
 *
 * @param accessToken - Access token of the person.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item whose links are shown.
 * @returns The links, their read state, and the actions.
 */
export function useWorkItemWebLinksController(accessToken: string, teamId: string, workItemId: string) {
  const runner = useMemo(() => createMutationRequestRunner(), [])
  const { data, error, isLoading, mutate } = useWorkItemWebLinks(accessToken, teamId, workItemId)

  return {
    links: data ?? [],
    isLoading,
    hasLoadError: data === undefined && error !== undefined,
    /** Reads the links again. */
    retry: () => {
      void mutate()
    },
    /**
     * Adds a link and reads the list again.
     *
     * @param input - Normalized URL and optional title.
     */
    add: async (input: { url: string, title?: string }) => {
      await runner.run(`web-link:create:${teamId}:${workItemId}`, JSON.stringify(input), (context) =>
        createWorkItemWebLink(accessToken, teamId, workItemId, input, context))
      await mutate()
    },
    /**
     * Removes a link and reads the list again.
     *
     * @param link - Link to remove.
     */
    remove: async (link: PublicWorkItemWebLink) => {
      await runner.run(`web-link:delete:${teamId}:${workItemId}:${link.id}`, link.id, (context) =>
        deleteWorkItemWebLink(accessToken, teamId, workItemId, link.id, context))
      await mutate()
    },
  }
}
