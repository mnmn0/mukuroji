/** One cache publication, revalidation, and restoration of authoritative confirmation results. */
export type ScheduleConfirmationCacheRefresh = {
  /** Revalidates one cache from its backing GET endpoint. */
  refresh: () => Promise<unknown>
  /** Reapplies compact committed results and clears a transient revalidation error. */
  preserveConfirmedState: () => Promise<unknown>
}

/**
 * Publishes and revalidates schedule-related caches without delaying a committed POST result.
 *
 * Each cache publishes the compact confirmation result before its GET starts, then restores it
 * after the GET settles. This both prevents an eventually consistent older row from replacing the
 * committed revision and clears transient SWR errors after a failed revalidation. Failures are
 * reported for enterprise-session handling, but all refresh branches settle before this
 * best-effort operation resolves.
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

    try {
      await refresh()
    } catch (error) {
      onError(error)
    }

    try {
      await preserveConfirmedState()
    } catch (error) {
      onError(error)
    }
  }))
}
