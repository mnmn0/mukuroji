/** How the UI explains a failed time tracking request. */
export type TimeTrackingFailureKind =
  /** The request did not reach the API; it can be retried with the same idempotency key. */
  | 'offline'
  /** Someone else changed the record first; the latest state was reloaded. */
  | 'conflict'
  /** The member lacks the permission. */
  | 'forbidden'
  /** The API rejected the input. */
  | 'invalid'
  /** Any other failure. */
  | 'failed'

/**
 * Reads the HTTP status and code of an unknown error without trusting its type.
 *
 * @param error - Unknown failure.
 * @returns Status and code when present.
 */
function readErrorFields(error: unknown): { status?: number; code?: string } {
  if (typeof error !== 'object' || error === null) return {}
  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  return { ...(status === undefined ? {} : { status }), ...(code === undefined ? {} : { code }) }
}

/**
 * Classifies a time tracking failure for display and retry decisions.
 *
 * @param error - Unknown failure.
 * @returns Failure kind.
 */
export function classifyTimeTrackingFailure(error: unknown): TimeTrackingFailureKind {
  const { status, code } = readErrorFields(error)
  if (status === 0) return 'offline'
  if (status === 409 && code !== 'TimeTrackingMutationInProgress') return 'conflict'
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 400 || status === 404 || status === 422) return 'invalid'
  return 'failed'
}

/**
 * Returns whether a failed mutation should keep its idempotency key for a safe retry.
 *
 * Network failures, in-progress duplicates, and server failures may have been applied, so a retry
 * must replay the same key. Rejected input and conflicts start a new logical mutation.
 *
 * @param error - Unknown failure.
 * @returns Whether the request context should be kept.
 */
export function shouldRetainTimeTrackingMutation(error: unknown): boolean {
  const { status, code } = readErrorFields(error)
  return status === 0 || status === undefined || status >= 500 || code === 'TimeTrackingMutationInProgress'
}
