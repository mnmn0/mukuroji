import type {
  AutomationValue,
  BulkOperation,
  BulkOperationItemResult,
  BulkOperationRequest,
} from '@mukuroji/contracts'

/** Result of validating one Bulk item without mutation. */
export type BulkItemPreviewResult = {
  /** Whether the item may be applied. */
  allowed: boolean
  /** Stable validation error code. */
  errorCode?: string
  /** Safe validation error message. */
  errorMessage?: string
  /** Whether a transient failure may be retried. */
  retryable?: boolean
  /** Server-only snapshot used for recovery and undo. */
  undoPayload?: Record<string, AutomationValue>
}

/** Result of successfully applying or undoing one Bulk item. */
export type BulkItemApplyResult = {
  /** Revision after the mutation. */
  resultingRevision: number
  /** Server-only snapshot required for safe undo. */
  undoPayload?: Record<string, AutomationValue>
}

/** External Work Item side-effect port used by Bulk operations. */
export interface BulkOperationAdapter {
  /** Validates authorization, revision, and configuration without mutation. */
  preview(
    request: BulkOperationRequest,
    itemIndex: number,
  ): Promise<BulkItemPreviewResult>
  /** Applies one item with optimistic concurrency. */
  apply(
    request: BulkOperationRequest,
    itemIndex: number,
    checkpoint: BulkOperationItemResult,
  ): Promise<BulkItemApplyResult>
  /** Applies a saved undo snapshot with a current-revision guard. */
  undo(operation: BulkOperation, itemIndex: number): Promise<BulkItemApplyResult>
}

/** Durable checkpoint capability required by Bulk operation use cases. */
export interface AutomationBulkOperationPort {
  /** Conditionally creates a durable Bulk operation. */
  createBulkOperation(operation: BulkOperation): Promise<boolean>
  /** Saves a Bulk checkpoint with revision compare-and-swap. */
  saveBulkOperation(operation: BulkOperation, expectedRevision: number): Promise<void>
  /** Reads a durable Bulk operation. */
  getBulkOperation(
    workspaceId: string,
    operationId: string,
  ): Promise<BulkOperation | undefined>
}
