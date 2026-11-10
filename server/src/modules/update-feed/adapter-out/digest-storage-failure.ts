import { PlanningError } from '../../planning'

/** Separates proven permanent failures from transient and unclassified SDK failures.
 * @param error - Untrusted SDK failure, never reflected into responses.
 * @param size - Expected transaction cancellation vector length, zero for reads.
 * @returns Never; throws a stable application error suitable for bounded recovery.
 */
export function digestStorageFailure(error: unknown, size = 0): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (name === 'TransactionCanceledException' && typeof error === 'object' && error !== null && 'CancellationReasons' in error && Array.isArray(error.CancellationReasons)) {
    const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined)
    if (size > 0 && codes.length === size) {
      if (codes.includes('ConditionalCheckFailed') && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Digest state or permissions changed. Reload before saving.')
      if (codes.includes('ValidationError') || codes.includes('ItemCollectionSizeLimitExceeded')) throw new PlanningError(502, 'UpdateFeedDigestStoragePermanent', 'Digest storage requires operator inspection.')
      const transient = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']
      if (codes.some((code) => transient.includes(String(code))) && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed' || transient.includes(String(code)))) throw new PlanningError(503, 'UpdateFeedDigestRetryable', 'Digest storage is temporarily unavailable.')
    }
  }
  if (typeof name === 'string' && ['ValidationException', 'AccessDeniedException', 'ResourceNotFoundException', 'UnrecognizedClientException', 'InvalidSignatureException'].includes(name)) throw new PlanningError(502, 'UpdateFeedDigestStoragePermanent', 'Digest storage requires operator inspection.')
  if (typeof name === 'string' && ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException'].includes(name)) throw new PlanningError(503, 'UpdateFeedDigestRetryable', 'Digest storage is temporarily unavailable.')
  // An unknown network/SDK error is not evidence of corrupt data or bad configuration.
  throw new PlanningError(502, 'UpdateFeedDigestStorageFailure', 'Digest storage request failed.')
}
