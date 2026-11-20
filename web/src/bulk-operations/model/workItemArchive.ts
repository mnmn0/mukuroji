import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
  CanonicalWorkItem,
} from '@mukuroji/contracts'

/** Work Item identity and revision that a single archive or restore targets. */
export type WorkItemArchiveTarget = Pick<CanonicalWorkItem, 'id' | 'revision' | 'teamId'>

/**
 * Builds the one-item bulk archive request that archives or restores a single Work Item.
 *
 * The single action reuses the bulk archive operation, so it keeps the same server-side
 * permission check, revision check, audit, and Undo payload as the bulk toolbar.
 *
 * @param workspaceId - Workspace that scopes the request.
 * @param target - Work Item to archive or restore, at the revision the viewer saw.
 * @param archived - True to archive the Work Item, false to restore it.
 * @returns The bulk archive request for the one Work Item.
 */
export function createWorkItemArchiveRequest(
  workspaceId: string,
  target: WorkItemArchiveTarget,
  archived: boolean,
): BulkOperationRequest {
  return {
    workspaceId,
    items: [{
      teamId: target.teamId,
      workItemId: target.id,
      expectedRevision: target.revision,
    }],
    action: { type: 'archive', archived },
  }
}

/** Why a single archive or restore did not change the Work Item. */
export type WorkItemArchiveFailure = {
  /** Stable server error code, when the server sent one. */
  code?: string
  /** Safe server message; empty when the server sent none. */
  message: string
}

/**
 * Reads why a single-item archive preview cannot be applied.
 *
 * @param preview - Preview returned for a one-item archive request.
 * @returns The server's failure, or undefined when the preview can be applied.
 */
export function readWorkItemArchivePreviewFailure(
  preview: BulkOperationPreview,
): WorkItemArchiveFailure | undefined {
  if (preview.canApply) return undefined
  const item = preview.items.find((candidate) => candidate.errorCode || candidate.errorMessage)
  return {
    ...(item?.errorCode ? { code: item.errorCode } : {}),
    message: item?.errorMessage ?? '',
  }
}

/**
 * Reads why a single-item archive operation did not change the Work Item.
 *
 * @param operation - Operation returned by applying a one-item archive request.
 * @returns The server's failure, or undefined when the item succeeded.
 */
export function readWorkItemArchiveOperationFailure(
  operation: BulkOperation,
): WorkItemArchiveFailure | undefined {
  const item = operation.items[0]
  if (item?.status === 'succeeded') return undefined
  return {
    ...(item?.errorCode ? { code: item.errorCode } : {}),
    message: item?.errorMessage ?? '',
  }
}

/**
 * Picks the localized message of an archive failure that the hierarchy rules caused.
 *
 * The server refuses to archive a parent while a child is not archived, to restore a child while
 * its parent is archived, and either change when the parent or children changed during the check.
 * Its own messages are English, so these are shown localized.
 *
 * @param code - Stable server error code of the failure.
 * @returns The message key, or undefined when the failure keeps the server's message.
 */
export function readWorkItemArchiveFailureMessageKey(
  code: string | undefined,
): 'issues.archive.activeChildren' | 'issues.archive.parentArchived' | 'issues.archive.hierarchyChanged' | undefined {
  if (code === 'WorkItemActiveChildren') return 'issues.archive.activeChildren'
  if (code === 'WorkItemParentArchived') return 'issues.archive.parentArchived'
  if (code === 'WorkItemHierarchyChanged') return 'issues.archive.hierarchyChanged'
  return undefined
}

/**
 * Reports whether a single-item archive operation failed in a way the retry endpoint can repeat.
 *
 * @param operation - Operation returned by applying a one-item archive request.
 * @returns True when its item failed and the server marked it retryable.
 */
export function isWorkItemArchiveOperationRetryable(operation: BulkOperation): boolean {
  const item = operation.items[0]
  return item?.status === 'failed' && item.retryable
}
