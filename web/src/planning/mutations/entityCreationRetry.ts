import { PlanningApiError } from '../api/errors'

/**
 * Remembers the revision sent by Planning creations whose outcome is unknown.
 *
 * A create or duplicate without an entity ID is deduplicated only when its retry sends the same
 * body with the same `Idempotency-Key`. Retrying with the revision of a refreshed snapshot would
 * change the body, and with it the key, so the server would create a second entity.
 */
export type PlanningEntityCreationRetryTracker = {
  /**
   * Returns the revision to send for one logical creation.
   *
   * @param creationKey - Stable identity of the creation, without its revision.
   * @param currentRevision - Revision of the current snapshot.
   * @returns The revision of an earlier attempt whose outcome is unknown, else the current one.
   */
  readonly resolveRevision: (creationKey: string, currentRevision: number) => number
  /**
   * Runs one creation attempt and keeps its revision while its outcome is unknown.
   *
   * @param creationKey - Stable identity of the creation, without its revision.
   * @param expectedRevision - Revision sent by this attempt.
   * @param request - The attempt.
   * @returns The result of the attempt.
   */
  readonly track: <TResult>(
    creationKey: string,
    expectedRevision: number,
    request: () => Promise<TResult>,
  ) => Promise<TResult>
}

/**
 * Creates a tracker that pins the revision of unknown-outcome Planning creations for their retries.
 *
 * @returns A tracker owned by one Planning page instance.
 */
export function createPlanningEntityCreationRetryTracker(): PlanningEntityCreationRetryTracker {
  const pendingRevisions = new Map<string, number>()

  return {
    resolveRevision: (creationKey, currentRevision) =>
      pendingRevisions.get(creationKey) ?? currentRevision,
    track: async (creationKey, expectedRevision, request) => {
      pendingRevisions.set(creationKey, expectedRevision)
      try {
        const result = await request()
        pendingRevisions.delete(creationKey)
        return result
      } catch (error) {
        if (!isUncertainPlanningEntityCreationFailure(error)) pendingRevisions.delete(creationKey)
        throw error
      }
    },
  }
}

/**
 * Returns whether a failed create or duplicate may still have created the entity.
 *
 * A Planning API error below 500 is a definite rejection, except that the earlier attempt with
 * the same key may still be running. A server error, an unreadable response, or a network
 * failure can follow a committed creation.
 *
 * @param error - Rejection of the creation request.
 * @returns True when the entity may exist.
 */
export function isUncertainPlanningEntityCreationFailure(error: unknown) {
  if (!(error instanceof PlanningApiError)) return true
  return error.status >= 500 || error.code === 'PlanningEntityIdempotencyInProgress'
}
