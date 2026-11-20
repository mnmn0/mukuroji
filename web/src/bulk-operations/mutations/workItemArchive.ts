import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import { applyBulkOperation, previewBulkOperation, retryBulkOperation } from '../api/operations'
import {
  createWorkItemArchiveRequest,
  isWorkItemArchiveOperationRetryable,
  readWorkItemArchiveFailureMessageKey,
  readWorkItemArchiveOperationFailure,
  readWorkItemArchivePreviewFailure,
  type WorkItemArchiveFailure,
  type WorkItemArchiveTarget,
} from '../model/workItemArchive'

/**
 * Operations whose hierarchy failure was already shown to the viewer in this page.
 *
 * A hierarchy failure is not retried on its own, because the viewer has to fix the hierarchy
 * first. Fixing it does not change the request, so the next click returns the same stored
 * operation, and only then, as the viewer's own new attempt, is it retried.
 */
const shownHierarchyFailureOperationIds = new Set<string>()

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
  /** Returns a localized message for a failure code, or undefined to keep the server's message. */
  localizeFailure?: (code: string | undefined) => string | undefined
}

/**
 * Picks the message shown for a failed archive or restore.
 *
 * @param input - Mutation input with the fallback message and the localizer.
 * @param failure - Failure the server reported.
 * @returns The localized message, the server's message, or the fallback.
 */
function describeWorkItemArchiveFailure(
  input: WorkItemArchiveMutationInput,
  failure: WorkItemArchiveFailure,
): string {
  return input.localizeFailure?.(failure.code) || failure.message || input.fallbackErrorMessage
}

/**
 * Archives or restores one Work Item through a one-item bulk archive operation.
 *
 * The operation is previewed first, so a stale revision or a missing permission is reported
 * without changing anything, and then applied with the preview token. A retryable item failure is
 * retried once through the retry endpoint, which also covers a failure kept from an earlier click.
 * A hierarchy failure is retried only when an earlier click already showed it, so a validation
 * conflict is never repeated without the viewer asking again.
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
    throw new Error(describeWorkItemArchiveFailure(input, previewFailure))
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
  // A hierarchy failure is retried only on the click after the one that showed it.
  const appliedFailureCode = operation.items[0]?.errorCode
  const isHierarchyFailure = readWorkItemArchiveFailureMessageKey(appliedFailureCode) !== undefined
  const retries = isWorkItemArchiveOperationRetryable(operation) &&
    (!isHierarchyFailure || shownHierarchyFailureOperationIds.has(operation.id))
  const settledOperation = retries
    ? await input.runner.run(
        `${operationKey}:retry:${operation.id}`,
        operation.id,
        (context) => retryBulkOperation(input.accessToken, operation.id, context),
      )
    : operation
  const operationFailure = readWorkItemArchiveOperationFailure(settledOperation)
  if (operationFailure !== undefined && readWorkItemArchiveFailureMessageKey(operationFailure.code) !== undefined) {
    shownHierarchyFailureOperationIds.add(settledOperation.id)
  } else {
    shownHierarchyFailureOperationIds.delete(settledOperation.id)
  }
  if (operationFailure !== undefined) {
    throw new Error(describeWorkItemArchiveFailure(input, operationFailure))
  }
}
