import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import { applyBulkOperation, previewBulkOperation, retryBulkOperation } from '../api/operations'
import {
  createWorkItemArchiveRequest,
  isWorkItemArchiveOperationRetryable,
  readWorkItemArchiveOperationFailure,
  readWorkItemArchivePreviewFailure,
  type WorkItemArchiveTarget,
} from '../model/workItemArchive'

/** Inputs of one single Work Item archive or restore. */
export type WorkItemArchiveMutationInput = {
  /** Bearer token for the bulk operation API. */
  accessToken: string
  /** Workspace that scopes the request. */
  workspaceId: string
  /** Work Item to archive or restore, at the revision the viewer saw. */
  target: WorkItemArchiveTarget
  /** True to archive the Work Item, false to restore it. */
  archived: boolean
  /** Runner that keeps one request context per logical mutation for safe retries. */
  runner: MutationRequestRunner
  /** Message used when the server rejects the change without a message of its own. */
  fallbackErrorMessage: string
}

/**
 * Archives or restores one Work Item through a one-item bulk archive operation.
 *
 * The operation is previewed first, so a stale revision or a missing permission is reported
 * without changing anything, and then applied with the preview token. A retryable item failure is
 * retried once through the retry endpoint, which also covers a failure kept from an earlier click.
 *
 * @param input - Work Item, direction, and request context.
 * @returns Resolves once the Work Item was archived or restored.
 * @throws Error with the server's safe message when the preview or the apply fails.
 */
export async function applyWorkItemArchive(input: WorkItemArchiveMutationInput): Promise<void> {
  const request = createWorkItemArchiveRequest(input.workspaceId, input.target, input.archived)
  const operationKey = `work-item-archive:${input.target.teamId}:${input.target.id}`
  const preview = await input.runner.run(
    `${operationKey}:preview`,
    JSON.stringify(request),
    (context) => previewBulkOperation(input.accessToken, request, context),
  )
  const previewFailure = readWorkItemArchivePreviewFailure(preview)
  if (previewFailure !== undefined) {
    throw new Error(previewFailure || input.fallbackErrorMessage)
  }
  const operation = await input.runner.run(
    `${operationKey}:apply`,
    JSON.stringify([request, preview.operationToken]),
    (context) => applyBulkOperation(
      input.accessToken,
      { ...request, operationToken: preview.operationToken },
      context,
    ),
  )
  // The same request maps to the same stored operation, so applying it again after a transient
  // failure returns that failed operation unchanged. The retry endpoint re-runs its failed item.
  const settledOperation = isWorkItemArchiveOperationRetryable(operation)
    ? await input.runner.run(
        `${operationKey}:retry:${operation.id}`,
        operation.id,
        (context) => retryBulkOperation(input.accessToken, operation.id, context),
      )
    : operation
  const operationFailure = readWorkItemArchiveOperationFailure(settledOperation)
  if (operationFailure !== undefined) {
    throw new Error(operationFailure || input.fallbackErrorMessage)
  }
}
