/** One cache publication, revalidation, and restoration of authoritative confirmation results. */
export type ScheduleConfirmationCacheRefresh = {
  /** Revalidates one cache from its backing GET endpoint. */
  refresh: () => Promise<unknown>
  /** Reapplies compact committed results and clears a transient revalidation error. */
  preserveConfirmedState: () => Promise<unknown>
}

const scheduleConfirmationRefreshAttempts = 3

/**
 * Reads, validates, and publishes one authoritative cache value.
 *
 * Keeping the GET outside SWR's no-argument `mutate()` is intentional: SWR represents a failed
 * revalidation in cache state while resolving the mutation promise, which cannot drive retries.
 *
 * @param read - Explicit backing-endpoint GET whose rejection must reach the caller.
 * @param validate - Postcondition that rejects eventually consistent stale responses.
 * @param publish - Cache publisher called only for an accepted response.
 * @returns Completion after the validated response is stored.
 */
export async function refreshScheduleConfirmationCache<Data>(
  read: () => Promise<Data>,
  validate: (value: Data) => void,
  publish: (value: Data) => Promise<unknown>,
): Promise<void> {
  const value = await read()
  validate(value)
  await publish(value)
}

/**
 * Publishes and revalidates schedule-related caches without delaying a committed POST result.
 *
 * Each cache publishes the compact confirmation result before its GET starts, then restores it
 * after the GET settles. This both prevents an eventually consistent older row from replacing the
 * committed revision and clears transient SWR errors after revalidation. GET failures are retried
 * because the Planning query intentionally disables automatic SWR retries; only the final failure
 * is reported for enterprise-session handling. All refresh branches settle before this best-effort
 * operation resolves.
 *
 * @param cacheRefreshes - Independent cache refresh and committed-state restoration pairs.
 * @param onError - Observer used to preserve enterprise-session redirect behavior.
 * @returns A promise that resolves after every best-effort refresh branch settles.
 */
export async function revalidateScheduleConfirmationCachesBestEffort(
  cacheRefreshes: readonly ScheduleConfirmationCacheRefresh[],
  onError: (error: unknown) => void,
): Promise<void> {
  await Promise.allSettled(cacheRefreshes.map(async ({
    preserveConfirmedState,
    refresh,
  }) => {
    try {
      await preserveConfirmedState()
    } catch (error) {
      onError(error)
    }

    const refreshError = await retryScheduleConfirmationCacheRefresh(refresh)
    if (refreshError !== undefined) {
      onError(refreshError)
    }

    try {
      await preserveConfirmedState()
    } catch (error) {
      onError(error)
    }
  }))
}

/** Retries one cache GET and returns only its final failure. */
async function retryScheduleConfirmationCacheRefresh(
  refresh: () => Promise<unknown>,
): Promise<unknown> {
  let finalError: unknown
  for (let attempt = 0; attempt < scheduleConfirmationRefreshAttempts; attempt += 1) {
    try {
      await refresh()
      return undefined
    } catch (error) {
      finalError = error
    }
  }
  return finalError
}
