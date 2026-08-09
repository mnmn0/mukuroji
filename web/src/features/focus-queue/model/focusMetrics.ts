import type { FocusQueueResponse } from '@mukuroji/contracts'

/**
 * Reads the server-projected count of visible Work Items with real blockers.
 *
 * @param response - Current permission-filtered Focus queue snapshot.
 * @returns Number of visible active Work Items with unresolved blockers.
 */
export function getFocusBlockedCount(
  response: FocusQueueResponse | undefined,
): number {
  return response?.metrics.blocked ?? 0
}
