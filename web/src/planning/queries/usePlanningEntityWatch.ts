import { useState } from 'react'
import useSWR from 'swr'
import { getPlanningEntityWatch, setPlanningEntityWatch } from '../api/entities'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'

/**
 * Loads the viewer's watch state of one Milestone and changes it.
 *
 * @param accessToken - Planning API access token.
 * @param entityId - Milestone ID.
 * @returns The watch state, whether a change is saving, whether a read or change failed, and the toggle.
 */
export function usePlanningEntityWatch(accessToken: string, entityId: string) {
  const query = useSWR(
    ['planning-entity-watch', accessToken, entityId],
    () => getPlanningEntityWatch(accessToken, entityId),
    { shouldRetryOnError: false },
  )
  const [isPending, setIsPending] = useState(false)
  const [hasMutationError, setHasMutationError] = useState(false)
  /** Flips the watch state and keeps the server's answer. */
  const toggle = async () => {
    const current = query.data
    if (!current) return
    setIsPending(true)
    setHasMutationError(false)
    try {
      const next = await setPlanningEntityWatch(
        accessToken,
        entityId,
        !current.subscribed,
        createMutationRequestContext(),
      )
      await query.mutate(next, { revalidate: false })
    } catch {
      setHasMutationError(true)
    } finally {
      setIsPending(false)
    }
  }
  return {
    watch: query.data,
    hasError: Boolean(query.error) || hasMutationError,
    isPending,
    toggle,
  }
}
