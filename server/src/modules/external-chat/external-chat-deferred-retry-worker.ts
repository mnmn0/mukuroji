import type { ExternalChatSyncOutcome } from '@mukuroji/contracts'
import {
  ExternalChatError,
  type ExternalChatStore,
} from './external-chat'
import type { ExternalChatSyncInboundInput } from './external-chat-sync-service'

/** Maximum number of due events accepted by one link-scoped retry batch. */
export const EXTERNAL_CHAT_DEFERRED_RETRY_MAX_BATCH_SIZE = 100

/** Persistence capabilities required by the deferred retry worker. */
export type ExternalChatDeferredRetryStorePort = Pick<
  ExternalChatStore,
  'listDueDeferredEvents' | 'deleteDeferredEvent'
>

/** Provider-neutral inbound processor used by the deferred retry worker. */
export interface ExternalChatDeferredInboundProcessorPort {
  /**
   * Processes one normalized provider event without persisted echo authentication material.
   *
   * @param input - Tenant and normalized event selected from durable deferred state.
   * @returns The durable synchronization outcome.
   */
  processInbound(input: ExternalChatSyncInboundInput): Promise<ExternalChatSyncOutcome>
}

/** Dependencies required by one provider-neutral deferred retry worker. */
export type ExternalChatDeferredRetryWorkerDependencies = {
  /** Tenant-scoped durable deferred event store. */
  store: ExternalChatDeferredRetryStorePort
  /** Existing synchronization service or compatible inbound processor. */
  processor: ExternalChatDeferredInboundProcessorPort
}

/** Input selecting one bounded link-scoped due batch. */
export type ExternalChatDeferredRetryBatchInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** External chat link whose FIFO queue is processed. */
  linkId: string
  /** Inclusive due timestamp in ISO 8601 format. */
  dueAt: string
  /** Maximum number of due events to inspect. */
  limit: number
}

/** Reason a retry worker stopped before every selected event became terminal. */
export type ExternalChatDeferredRetryStopReason =
  | 'batch-complete'
  | 'deferred'
  | 'retryable-failure'
  | 'busy'

/** Bounded retry batch result suitable for metrics without message content. */
export type ExternalChatDeferredRetryBatchResult = {
  /** Number of due events passed to the synchronization service. */
  attemptedEventCount: number
  /** Number of terminal event rows removed idempotently. */
  removedEventCount: number
  /** Outcomes returned before the batch completed or stopped. */
  outcomes: ExternalChatSyncOutcome[]
  /** Completion or FIFO-preserving early-stop reason. */
  stopReason: ExternalChatDeferredRetryStopReason
}

/**
 * Processes one bounded link FIFO of provider-neutral deferred chat events.
 *
 * Deferred rows intentionally contain no runtime-only origin marker. The worker
 * therefore passes only the normalized event to `processInbound`; authenticated
 * echoes must be redelivered through the verified webhook boundary.
 */
export class ExternalChatDeferredRetryWorker {
  /** Durable due-event persistence boundary. */
  private readonly store: ExternalChatDeferredRetryStorePort

  /** Existing provider-neutral inbound synchronization boundary. */
  private readonly processor: ExternalChatDeferredInboundProcessorPort

  /**
   * Creates a deferred event retry worker.
   *
   * @param dependencies - Store and inbound processor boundaries.
   */
  constructor(dependencies: ExternalChatDeferredRetryWorkerDependencies) {
    this.store = dependencies.store
    this.processor = dependencies.processor
  }

  /**
   * Processes due events in deterministic order until the batch or FIFO head blocks.
   *
   * @param input - Tenant, link, due cutoff, and bounded batch size.
   * @returns Secret-free outcomes and the reason processing stopped.
   */
  async processDueBatch(
    input: ExternalChatDeferredRetryBatchInput,
  ): Promise<ExternalChatDeferredRetryBatchResult> {
    const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
    const linkId = requireIdentifier(input.linkId, 'external chat link ID')
    const dueAt = requireTimestamp(input.dueAt, 'deferred retry due timestamp')
    const limit = requireBatchLimit(input.limit)
    const dueEvents = await this.store.listDueDeferredEvents(
      workspaceId,
      linkId,
      dueAt,
      limit,
    )
    const outcomes: ExternalChatSyncOutcome[] = []
    let removedEventCount = 0
    let attemptedEventCount = 0
    for (const deferred of dueEvents) {
      attemptedEventCount += 1
      let outcome: ExternalChatSyncOutcome
      try {
        outcome = await this.processor.processInbound({
          workspaceId,
          event: deferred.event,
        })
      } catch (error: unknown) {
        if (error instanceof ExternalChatError && error.retryable) {
          return {
            attemptedEventCount,
            removedEventCount,
            outcomes,
            stopReason: error.code === 'ExternalChatOperationConflict'
              ? 'busy'
              : 'retryable-failure',
          }
        }
        throw error
      }
      outcomes.push(outcome)
      if (outcome.kind === 'deferred') {
        return {
          attemptedEventCount,
          removedEventCount,
          outcomes,
          stopReason: 'deferred',
        }
      }
      if (outcome.kind === 'failed' && outcome.retryable) {
        return {
          attemptedEventCount,
          removedEventCount,
          outcomes,
          stopReason: 'retryable-failure',
        }
      }
      await this.store.deleteDeferredEvent(
        workspaceId,
        deferred.event.provider,
        deferred.event.installationId,
        deferred.event.eventId,
      )
      removedEventCount += 1
    }
    return {
      attemptedEventCount,
      removedEventCount,
      outcomes,
      stopReason: 'batch-complete',
    }
  }
}

/** Reads a bounded nonempty identifier. */
function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > 2_048
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is invalid.`,
    )
  }
  return value
}

/** Reads one parseable ISO 8601 timestamp. */
function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireIdentifier(value, label)
  if (
    !/^\d{4}-\d{2}-\d{2}T/u.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is invalid.`,
    )
  }
  return timestamp
}

/** Reads a positive bounded deferred retry batch size. */
function requireBatchLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > EXTERNAL_CHAT_DEFERRED_RETRY_MAX_BATCH_SIZE
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The deferred retry batch limit must be between 1 and ${EXTERNAL_CHAT_DEFERRED_RETRY_MAX_BATCH_SIZE}.`,
    )
  }
  return value
}
