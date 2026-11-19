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

/**
 * Reads why a single-item archive preview cannot be applied.
 *
 * @param preview - Preview returned for a one-item archive request.
 * @returns The server's safe error message, or undefined when the preview can be applied.
 */
export function readWorkItemArchivePreviewFailure(
  preview: BulkOperationPreview,
): string | undefined {
  if (preview.canApply) return undefined
  return preview.items.find((item) => item.errorMessage)?.errorMessage ?? ''
}

/**
 * Reads why a single-item archive operation did not change the Work Item.
 *
 * @param operation - Operation returned by applying a one-item archive request.
 * @returns The server's safe error message, or undefined when the item succeeded.
 */
export function readWorkItemArchiveOperationFailure(
  operation: BulkOperation,
): string | undefined {
  const item = operation.items[0]
  if (item?.status === 'succeeded') return undefined
  return item?.errorMessage ?? ''
}

