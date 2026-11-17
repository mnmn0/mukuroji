import { useState } from 'react'
import useSWR from 'swr'
import { getWorkItemByKey } from '../api/workItems'

/** Counts mounted lookups, so each mount gets its own cache entry. */
let lookupCount = 0

/**
 * Resolves a Work Item key, such as `PT-12`, to the Team and Work Item it names now.
 * Each mounted page looks the key up afresh, so a cached answer from an earlier visit never
 * redirects to a Work Item that has since been deleted or replaced.
 *
 * @param accessToken - Work Item API access token.
 * @param workItemKey - Canonical key, or undefined when the URL did not hold one.
 * @param enabled - Whether the lookup may run yet.
 * @returns The SWR state of the lookup. Call `mutate()` to retry after a failure.
 */
export function useWorkItemKeyLocation(
  accessToken: string | undefined,
  workItemKey: string | undefined,
  enabled = true,
) {
  const [lookupId] = useState(() => ++lookupCount)
  const key = accessToken && workItemKey && enabled
    ? ['work-item-key-location', accessToken, workItemKey, lookupId] as const
    : null

  return useSWR(
    key,
    ([, token, currentKey]) => getWorkItemByKey(currentKey, token),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  )
}
