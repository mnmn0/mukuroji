/** First element shared by every time tracking SWR key, so a mutation can refresh them together. */
export const timeTrackingQueryKeyRoot = 'time-tracking'

/**
 * Returns whether an SWR key belongs to time tracking.
 *
 * @param key - SWR cache key.
 * @returns Whether the key starts with the time tracking root.
 */
export function isTimeTrackingQueryKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === timeTrackingQueryKeyRoot
}

/** Shared SWR options: quiet retries, and a refresh when the browser comes back online. */
export const timeTrackingQueryConfig = {
  dedupingInterval: 5_000,
  revalidateOnReconnect: true,
  shouldRetryOnError: false,
} as const
