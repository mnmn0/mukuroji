import { useSWRConfig } from 'swr'
import { useCallback } from 'react'
import { isTimeTrackingQueryKey } from '../queries/timeTrackingQueryKeys'

/**
 * Returns a function that revalidates every time tracking query, so the timer, entry lists,
 * totals, and estimates agree after a mutation or a conflict.
 *
 * @returns Revalidation callback that never rejects.
 */
export function useRefreshTimeTrackingQueries(): () => Promise<void> {
  const { mutate } = useSWRConfig()
  return useCallback(async () => {
    await mutate(isTimeTrackingQueryKey).catch(() => undefined)
  }, [mutate])
}
