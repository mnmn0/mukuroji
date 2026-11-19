import type { MessageKey } from '../../shared/i18n/i18n'

/** The parts of a failed Customer mutation that decide what the member is told. */
export type CustomerMutationFailure = {
  /** HTTP status, when the server answered. */
  status?: number
  /** Stable API error code, when the server sent one. */
  code?: string
}

/** Codes the Customer API returns while another change to the same records is still finishing. */
const busyCodes = new Set([
  'CustomerContactMutationInProgress',
  'CustomerDeletionInProgress',
  'CustomerMergeInProgress',
  'CustomerOperationInProgress',
  'CustomerRequestMutationInProgress',
  'CustomerRetentionInProgress',
])

/** Codes the Customer API returns when the record already exists. */
const duplicateCodes = new Set([
  'CustomerAlreadyExists',
  'CustomerContactAlreadyExists',
  'CustomerRequestAlreadyExists',
])

/**
 * Chooses the message for a failed Customer mutation.
 *
 * @param failure Status and code of the failure.
 * @returns Message key to show next to the editor.
 */
export function resolveCustomerMutationErrorKey(failure: CustomerMutationFailure): MessageKey {
  if (failure.code === 'CustomerRevisionConflict' || failure.code === 'CustomerSnapshotChanged') {
    return 'customers.edit.error.conflict'
  }
  if (failure.code && busyCodes.has(failure.code)) return 'customers.edit.error.busy'
  if (failure.code && duplicateCodes.has(failure.code)) return 'customers.edit.error.duplicate'
  if (failure.status === 403) return 'customers.edit.error.forbidden'
  if (failure.status === 404) return 'customers.edit.error.notFound'
  if (failure.status === 400) return 'customers.edit.error.invalid'
  if (failure.status === 409) return 'customers.edit.error.conflict'
  return 'customers.edit.error.failed'
}

/**
 * Reports whether the failure means the loaded data is stale and should be reloaded.
 *
 * @param failure Status and code of the failure.
 * @returns Whether to refresh Customer data before the member retries.
 */
export function shouldRefreshAfterCustomerMutationFailure(failure: CustomerMutationFailure): boolean {
  return failure.status === 409 || failure.status === 404
}
