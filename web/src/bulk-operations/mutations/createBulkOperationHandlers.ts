import type {
  BulkOperation,
  BulkOperationAction,
  BulkOperationPreview,
  BulkOperationRequest,
} from '@mukuroji/contracts'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  applyBulkOperation,
  previewBulkOperation,
  retryBulkOperation,
  undoBulkOperation,
} from '../api'

/** One Work Item a bulk request or operation targets. */
export type BulkOperationTarget = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
}

/** Inputs for {@link createBulkOperationHandlers}. */
export type BulkOperationHandlersOptions = {
  /** Access token used for every bulk request; the handlers reject without it. */
  accessToken: string | undefined
  /** Wrapper that applies Enterprise session policy to each request. */
  guardRequest: <Result>(request: Promise<Result>) => Promise<Result>
  /** Runner that keeps one idempotency key per repeated request. */
  mutationRequestRunner: MutationRequestRunner
  /**
   * Throws when the person may not change every target, or assign the Project the action sets.
   *
   * @param items - Targets of the request or operation.
   * @param action - Action applied to every target.
   */
  requireWriteScopes: (items: readonly BulkOperationTarget[], action: BulkOperationAction) => void
  /**
   * Asks the person before a previewed request is applied; resolving `false` stops the apply.
   *
   * @param request - Request about to be applied.
   * @returns Whether the apply may go ahead.
   */
  confirmApply?: (request: BulkOperationRequest) => Promise<boolean>
  /** Reads the affected caches again after an apply, retry, or undo; a failed read is ignored. */
  revalidate: () => Promise<unknown>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Handlers the bulk operation toolbar calls. */
export type BulkOperationHandlers = {
  /** Validates a bulk request and returns the server preview. */
  preview: (request: BulkOperationRequest) => Promise<BulkOperationPreview>
  /** Applies a previewed bulk request. */
  apply: (request: BulkOperationRequest, preview: BulkOperationPreview) => Promise<BulkOperation>
  /** Retries the failed items of an operation. */
  retry: (operationId: string, operation?: BulkOperation) => Promise<BulkOperation>
  /** Undoes the succeeded items of an operation. */
  undo: (operationId: string, operation?: BulkOperation) => Promise<BulkOperation>
}

/**
 * Creates the preview, apply, retry, and undo handlers for a bulk operation toolbar.
 *
 * Each handler checks write scopes before its request, keeps one idempotency key per repeated
 * request, and reads the affected caches again after a change.
 *
 * @param options - Session, scope check, confirmation, and cache refresh.
 * @returns Handlers for the toolbar.
 */
export function createBulkOperationHandlers({
  accessToken,
  confirmApply,
  guardRequest,
  mutationRequestRunner,
  requireWriteScopes,
  revalidate,
  t,
}: BulkOperationHandlersOptions): BulkOperationHandlers {
  /**
   * Returns the access token, or rejects when the session has none.
   *
   * @returns Access token.
   */
  const requireAccessToken = () => {
    if (!accessToken) throw new Error(t('bulk.error'))
    return accessToken
  }

  /** Reads the caches again without failing a change that already succeeded. */
  const revalidateAfterChange = () => revalidate().catch(() => undefined)

  return {
    apply: async (request, preview) => {
      const token = requireAccessToken()
      requireWriteScopes(request.items, request.action)
      if (confirmApply && !await confirmApply(request)) {
        throw new Error(t('bulk.apply.cancelled'))
      }
      const operation = await guardRequest(mutationRequestRunner.run(
        'bulk:apply',
        JSON.stringify([request, preview.operationToken]),
        (context) => applyBulkOperation(
          token,
          { ...request, operationToken: preview.operationToken },
          context,
        ),
      ))
      await revalidateAfterChange()
      return operation
    },
    preview: async (request) => {
      const token = requireAccessToken()
      requireWriteScopes(request.items, request.action)
      return guardRequest(mutationRequestRunner.run(
        'bulk:preview',
        JSON.stringify(request),
        (context) => previewBulkOperation(token, request, context),
      ))
    },
    retry: async (operationId, operation) => {
      const token = requireAccessToken()
      if (!operation) throw new Error(t('bulk.error'))
      requireWriteScopes(operation.items, operation.action)
      const nextOperation = await guardRequest(mutationRequestRunner.run(
        `bulk:retry:${operationId}`,
        operationId,
        (context) => retryBulkOperation(token, operationId, context),
      ))
      await revalidateAfterChange()
      return nextOperation
    },
    undo: async (operationId, operation) => {
      const token = requireAccessToken()
      if (!operation) throw new Error(t('bulk.error'))
      requireWriteScopes(operation.items, operation.action)
      const nextOperation = await guardRequest(mutationRequestRunner.run(
        `bulk:undo:${operationId}`,
        operationId,
        (context) => undoBulkOperation(token, operationId, context),
      ))
      await revalidateAfterChange()
      return nextOperation
    },
  }
}
