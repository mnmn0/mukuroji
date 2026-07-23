import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { PrepareWorkItemDeletionFenceRequest } from '../../application/ports/connector-port'
import type { CompleteIdempotencyRequest } from '../../application/ports/request-control-port'

/** One DynamoDB transaction item contributed by the idempotency adapter. */
export type IdempotencyCompletionTransactWrite = {
  /** Conditional write replacing a reservation with an encrypted completed receipt. */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/** One DynamoDB transaction item contributed by the external-link adapter. */
export type WorkItemDeletionFenceTransactWrite = {
  /** Conditional write requiring the Work Item's external-link count to remain zero. */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/** DynamoDB-specific transaction contributions kept outside application ports. */
export interface DeveloperPlatformTransactionPort {
  /** Prepares encrypted idempotency completion for a caller-owned transaction. */
  prepareIdempotencyCompletionTransactWrite?(
    request: CompleteIdempotencyRequest,
  ): Promise<IdempotencyCompletionTransactWrite>
  /** Prepares an external-link existence fence for Work Item deletion. */
  prepareWorkItemDeletionFenceTransactWrite?(
    request: PrepareWorkItemDeletionFenceRequest,
  ): Promise<WorkItemDeletionFenceTransactWrite>
}

/**
 * Projects only DynamoDB transaction contribution methods from a backing store.
 *
 * @param source - Backing store that may contribute DynamoDB transaction items.
 * @returns A focused transaction port.
 */
export function projectDeveloperPlatformTransactionPort(
  source: DeveloperPlatformTransactionPort,
): DeveloperPlatformTransactionPort {
  const prepareIdempotency = source.prepareIdempotencyCompletionTransactWrite
  const prepareDeletionFence = source.prepareWorkItemDeletionFenceTransactWrite
  return {
    ...(prepareIdempotency
      ? {
          prepareIdempotencyCompletionTransactWrite:
            (request) => prepareIdempotency.call(source, request),
        }
      : {}),
    ...(prepareDeletionFence
      ? {
          prepareWorkItemDeletionFenceTransactWrite:
            (request) => prepareDeletionFence.call(source, request),
        }
      : {}),
  }
}
