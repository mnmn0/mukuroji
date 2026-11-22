/** One started request whose result is wanted only while no later request has started. */
export type LatestRequestTicket = {
  /** Whether no later request has started since this one. */
  readonly isCurrent: () => boolean
}

/** Tracks requests where only the latest one may apply its result. */
export type LatestRequestTracker = {
  /** Starts a request and makes every earlier one stale. */
  readonly begin: () => LatestRequestTicket
}

/**
 * Creates a tracker for requests where a later request replaces an earlier one, such as file
 * reads: an earlier read that finishes late must not overwrite what a later choice showed.
 *
 * @returns A tracker with no request started.
 */
export function createLatestRequestTracker(): LatestRequestTracker {
  let latest = 0
  return {
    begin: () => {
      latest += 1
      const request = latest
      return { isCurrent: () => latest === request }
    },
  }
}
