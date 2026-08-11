import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type BulkOperation,
  type BulkOperationPreview,
  type WorkItemActionFailureCategory,
  type WorkItemActionId,
  type WorkItemActionItemResult,
  type WorkItemActionResult,
  type WorkItemActionTarget,
} from '@mukuroji/contracts'

/**
 * Converts a durable bulk mutation checkpoint into the shared action-result contract.
 *
 * Successful undoable items expose the durable operation ID as the opaque undo token consumed
 * by the existing bulk undo entrance. A running checkpoint is partial for the completed apply
 * request; retry and resume continue to use the durable operation shown by the result panel.
 *
 * @param actionId - Canonical Move, Assign, or Archive action that created the operation.
 * @param operation - Durable bulk mutation checkpoint returned by apply, retry, or undo.
 * @param fallbackMessage - Localized safe message for items without a server error message.
 * @returns Shared aggregate and per-target mutation outcome.
 */
export function createBulkOperationTaskActionResult(
  actionId: WorkItemActionId,
  operation: BulkOperation,
  fallbackMessage: string,
): WorkItemActionResult {
  const items = operation.items.map((item): WorkItemActionItemResult => {
    const target = createBulkTaskActionTarget(item)
    if (item.status === 'succeeded') {
      return {
        status: 'succeeded',
        target,
        ...(item.resultingRevision !== undefined
          ? { resultingRevision: item.resultingRevision }
          : {}),
      }
    }
    if (item.status === 'undone') return { status: 'cancelled', target }
    const category: WorkItemActionFailureCategory =
      item.errorCode === 'WorkItemRevisionConflict'
        ? 'conflict'
        : item.status === 'failed'
          ? 'unknown'
          : 'unavailable'
    const failure = {
      category,
      code: item.errorCode ?? (item.status === 'failed'
        ? 'BulkOperationItemFailed'
        : 'BulkOperationItemNotApplied'),
      message: item.errorMessage ?? fallbackMessage,
      retryable: item.retryable,
    }
    return {
      failure,
      status: item.status === 'failed' ? 'failed' : 'skipped',
      target,
    }
  })
  const succeededCount = items.filter((item) => item.status === 'succeeded').length
  const failedCount = items.filter((item) => item.status === 'failed').length
  const cancelledCount = items.filter((item) => item.status === 'cancelled').length
  const status: WorkItemActionResult['status'] = operation.status === 'undone' ||
      (cancelledCount > 0 && cancelledCount === items.length)
    ? 'cancelled'
    : operation.status === 'pending' ||
        operation.status === 'running' ||
        operation.status === 'undoing'
      ? 'partial'
      : failedCount === 0 && succeededCount === items.length
      ? 'succeeded'
      : succeededCount > 0
        ? 'partial'
        : 'failed'
  const firstFailure = items.find((item) => item.failure)?.failure
  const undoToken = resolveBulkOperationTaskActionUndoToken(operation)

  return {
    actionId,
    items,
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    status,
    ...(firstFailure !== undefined ? { failure: firstFailure } : {}),
    ...(undoToken !== undefined ? { undoToken } : {}),
  }
}

/**
 * Resolves the opaque undo token exposed by a successful bulk action result.
 *
 * @param operation - Durable operation shown by the existing result panel.
 * @returns Durable operation ID when at least one successful item remains undoable.
 */
export function resolveBulkOperationTaskActionUndoToken(
  operation: BulkOperation,
): string | undefined {
  return operation.status !== 'undone' && operation.items.some(
    (item) => item.status === 'succeeded' && item.undoable,
  )
    ? operation.id
    : undefined
}

/**
 * Converts a rejected bulk preview into a canonical validation failure result.
 *
 * @param actionId - Canonical action whose preview was rejected.
 * @param preview - Revision-bound preview containing per-target validation outcomes.
 * @param fallbackMessage - Localized safe message for preview items without server text.
 * @returns Shared failed result without an undo token because persistence did not run.
 */
export function createBulkPreviewTaskActionResult(
  actionId: WorkItemActionId,
  preview: BulkOperationPreview,
  fallbackMessage: string,
): WorkItemActionResult {
  const items = preview.items.map((item): WorkItemActionItemResult => {
    const category: WorkItemActionFailureCategory =
      item.errorCode === 'WorkItemRevisionConflict' ? 'conflict' : 'validation'
    const failure = {
      category,
      code: item.errorCode ?? 'BulkOperationPreviewRejected',
      message: item.errorMessage ?? fallbackMessage,
      retryable: item.retryable,
    }
    return {
      failure,
      status: item.status === 'failed' ? 'failed' : 'skipped',
      target: createBulkTaskActionTarget(item),
    }
  })
  const failure = items.find((item) => item.failure)?.failure ?? {
    category: 'validation' satisfies WorkItemActionFailureCategory,
    code: 'BulkOperationPreviewRejected',
    message: fallbackMessage,
    retryable: false,
  }
  return {
    actionId,
    failure,
    items,
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    status: 'failed',
  }
}

/**
 * Converts a bulk item snapshot into the Team-qualified shared action target.
 *
 * @param item - Preview or operation item returned by the bulk API.
 * @returns Canonical Work Item action target.
 */
function createBulkTaskActionTarget(
  item: Pick<
    BulkOperation['items'][number],
    'expectedRevision' | 'teamId' | 'workItemId'
  >,
): WorkItemActionTarget {
  return {
    expectedRevision: item.expectedRevision,
    teamId: item.teamId,
    workItemId: item.workItemId,
  }
}
