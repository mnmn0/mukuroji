import type { ExternalChatProvider, ExternalChatSyncOutcome } from '@mukuroji/contracts'
import {
  type DeferredExternalChatOutboundEvent,
  ExternalChatError,
  type ExternalChatStore,
  type ExternalChatSyncOutboundEvent,
} from './external-chat'

/** Maximum outbound FIFO entries inspected by one bounded worker batch. */
export const EXTERNAL_CHAT_OUTBOUND_RETRY_MAX_BATCH_SIZE = 100

/** Default maximum durable attempts before an outbound mutation enters the DLQ. */
const DEFAULT_MAX_ATTEMPTS = 10

/** Default maximum durable queue age before an outbound mutation enters the DLQ. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

/** Default lease requested from the installation concurrency gate. */
const DEFAULT_GATE_LEASE_MS = 60_000

/** Persistence capabilities required by the outbound retry worker. */
export type ExternalChatOutboundRetryStorePort = Pick<
  ExternalChatStore,
  'getLink' | 'listDeferredOutboundEvents' | 'deleteDeferredOutboundEvent'
>

/** Existing outbound synchronization boundary invoked for one queued mutation. */
export interface ExternalChatDeferredOutboundProcessorPort {
  /**
   * Processes one trusted internal mutation through its durable receipt.
   *
   * @param event - Complete normalized outbound event retained by the queue.
   * @returns Durable synchronization outcome.
   */
  processOutbound(event: ExternalChatSyncOutboundEvent): Promise<ExternalChatSyncOutcome>
}

/** Exact installation scope used to serialize bounded retry work. */
export type ExternalChatOutboundRetryConcurrencyInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Provider whose installation owns the queue. */
  provider: ExternalChatProvider
  /** Connector installation whose capacity is being consumed. */
  installationId: string
  /** Stable owner identity for this worker batch. */
  ownerId: string
  /** Gate acquisition timestamp. */
  acquiredAt: string
  /** Requested gate lease expiry. */
  leaseExpiresAt: string
}

/** Distributed installation-level concurrency boundary. */
export interface ExternalChatOutboundRetryConcurrencyPort {
  /** Attempts to acquire one installation permit without blocking. */
  acquire(input: ExternalChatOutboundRetryConcurrencyInput): Promise<boolean>
  /** Releases a permit previously acquired by the same owner identity. */
  release(input: ExternalChatOutboundRetryConcurrencyInput): Promise<void>
}

/** Reason one permanently exhausted outbound mutation entered the DLQ. */
export type ExternalChatOutboundDeadLetterReason = 'max-attempts' | 'max-age'

/** Redacted scheduling metadata plus the original durable mutation sent to the DLQ. */
export type ExternalChatOutboundDeadLetterInput = {
  /** Exhausted durable queue entry. */
  deferred: DeferredExternalChatOutboundEvent
  /** Bounded retry policy that was exhausted. */
  reason: ExternalChatOutboundDeadLetterReason
  /** Timestamp at which the worker transferred ownership to the DLQ. */
  failedAt: string
}

/** Durable dead-letter boundary for outbound operations requiring operator recovery. */
export interface ExternalChatOutboundDeadLetterPort {
  /**
   * Idempotently stores one exhausted mutation before active queue deletion.
   *
   * Implementations must deduplicate the same operation ID and exhaustion reason so a crash
   * after DLQ commit but before active-row deletion cannot duplicate operator work.
   */
  enqueue(input: ExternalChatOutboundDeadLetterInput): Promise<void>
}

/** Tunable bounded retry and concurrency policy. */
export type ExternalChatOutboundRetryWorkerOptions = {
  /** Maximum completed receipt attempts before DLQ transfer. */
  maxAttempts?: number
  /** Maximum milliseconds retained in the active queue before DLQ transfer. */
  maxAgeMs?: number
  /** Installation permit lease duration in milliseconds. */
  gateLeaseMs?: number
}

/** Dependencies required by the outbound deferred retry worker. */
export type ExternalChatOutboundRetryWorkerDependencies = {
  /** Tenant-scoped durable outbound queue store. */
  store: ExternalChatOutboundRetryStorePort
  /** Existing outbound synchronization service or compatible processor. */
  processor: ExternalChatDeferredOutboundProcessorPort
  /** Installation-level concurrency boundary. */
  concurrency: ExternalChatOutboundRetryConcurrencyPort
  /** Durable dead-letter destination. */
  deadLetter: ExternalChatOutboundDeadLetterPort
  /** Optional bounded retry policy. */
  options?: ExternalChatOutboundRetryWorkerOptions
}

/** Input selecting one bounded link-scoped outbound FIFO batch. */
export type ExternalChatOutboundRetryBatchInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** External chat link whose FIFO is processed. */
  linkId: string
  /** Inclusive worker timestamp used for due and age decisions. */
  dueAt: string
  /** Maximum FIFO entries inspected by this batch. */
  limit: number
}

/** Reason an outbound worker stopped before exhausting the selected FIFO page. */
export type ExternalChatOutboundRetryStopReason =
  | 'batch-complete'
  | 'not-due'
  | 'deferred'
  | 'retryable-failure'
  | 'busy'
  | 'installation-busy'

/** Secret-free bounded outbound retry metrics and outcomes. */
export type ExternalChatOutboundRetryBatchResult = {
  /** Number of queued events passed to outbound synchronization. */
  attemptedEventCount: number
  /** Number of terminal or dead-lettered active queue rows removed. */
  removedEventCount: number
  /** Number of exhausted rows durably transferred to the DLQ. */
  deadLetteredEventCount: number
  /** Outcomes returned before the FIFO completed or blocked. */
  outcomes: ExternalChatSyncOutcome[]
  /** Completion or FIFO-preserving early-stop reason. */
  stopReason: ExternalChatOutboundRetryStopReason
}

/** Processes one link FIFO under a bounded installation-level concurrency permit. */
export class ExternalChatOutboundDeferredRetryWorker {
  /** Durable link FIFO persistence boundary. */
  private readonly store: ExternalChatOutboundRetryStorePort

  /** Existing outbound synchronization boundary. */
  private readonly processor: ExternalChatDeferredOutboundProcessorPort

  /** Installation-level concurrency gate. */
  private readonly concurrency: ExternalChatOutboundRetryConcurrencyPort

  /** Durable dead-letter destination. */
  private readonly deadLetter: ExternalChatOutboundDeadLetterPort

  /** Maximum durable attempts before DLQ transfer. */
  private readonly maxAttempts: number

  /** Maximum active queue age in milliseconds. */
  private readonly maxAgeMs: number

  /** Requested installation permit lease duration. */
  private readonly gateLeaseMs: number

  /**
   * Creates a bounded outbound deferred retry worker.
   *
   * @param dependencies - Store, processor, gate, DLQ, and retry policy.
   */
  constructor(dependencies: ExternalChatOutboundRetryWorkerDependencies) {
    this.store = dependencies.store
    this.processor = dependencies.processor
    this.concurrency = dependencies.concurrency
    this.deadLetter = dependencies.deadLetter
    this.maxAttempts = requirePositiveInteger(
      dependencies.options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      'maximum outbound retry attempts',
    )
    this.maxAgeMs = requirePositiveInteger(
      dependencies.options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      'maximum outbound retry age',
    )
    this.gateLeaseMs = requirePositiveInteger(
      dependencies.options?.gateLeaseMs ?? DEFAULT_GATE_LEASE_MS,
      'outbound retry gate lease',
    )
  }

  /**
   * Processes the FIFO head until the page completes or one non-terminal entry blocks it.
   *
   * @param input - Tenant, link, worker timestamp, and bounded page size.
   * @returns Secret-free batch metrics and stop reason.
   */
  async processDueBatch(
    input: ExternalChatOutboundRetryBatchInput,
  ): Promise<ExternalChatOutboundRetryBatchResult> {
    const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
    const linkId = requireIdentifier(input.linkId, 'external chat link ID')
    const dueAt = requireTimestamp(input.dueAt, 'outbound retry due timestamp')
    const limit = requireBatchLimit(input.limit)
    const deferredEvents = await this.store.listDeferredOutboundEvents(
      workspaceId,
      linkId,
      limit,
    )
    const initial = createEmptyResult()
    const head = deferredEvents[0]
    if (!head) return initial
    const headRetryAt = requireTimestamp(head.retryAt, 'deferred outbound retry timestamp')
    if (headRetryAt > dueAt) return { ...initial, stopReason: 'not-due' }

    const link = await this.store.getLink(workspaceId, linkId)
    if (!link) {
      throw new ExternalChatError(
        'ExternalChatPersistenceFailed',
        'The outbound retry FIFO refers to a missing link.',
        true,
      )
    }
    const concurrencyInput: ExternalChatOutboundRetryConcurrencyInput = {
      workspaceId,
      provider: link.link.provider,
      installationId: link.link.installationId,
      ownerId: `outbound-retry:${workspaceId}:${linkId}:${dueAt}`,
      acquiredAt: dueAt,
      leaseExpiresAt: addMilliseconds(dueAt, this.gateLeaseMs),
    }
    if (!await this.concurrency.acquire(concurrencyInput)) {
      return { ...initial, stopReason: 'installation-busy' }
    }
    try {
      return await this.processAcquiredBatch(
        workspaceId,
        linkId,
        dueAt,
        deferredEvents,
      )
    } finally {
      await this.concurrency.release(concurrencyInput)
    }
  }

  /**
   * Processes one already installation-gated FIFO page.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param linkId - Link whose queue owns every selected row.
   * @param dueAt - Inclusive worker timestamp.
   * @param deferredEvents - Stable occurrence-ordered FIFO page.
   * @returns Batch result after the page completes or blocks.
   */
  private async processAcquiredBatch(
    workspaceId: string,
    linkId: string,
    dueAt: string,
    deferredEvents: DeferredExternalChatOutboundEvent[],
  ): Promise<ExternalChatOutboundRetryBatchResult> {
    const outcomes: ExternalChatSyncOutcome[] = []
    let attemptedEventCount = 0
    let removedEventCount = 0
    let deadLetteredEventCount = 0
    for (const deferred of deferredEvents) {
      const retryAt = requireTimestamp(deferred.retryAt, 'deferred outbound retry timestamp')
      if (retryAt > dueAt) {
        return {
          attemptedEventCount,
          removedEventCount,
          deadLetteredEventCount,
          outcomes,
          stopReason: 'not-due',
        }
      }
      const deadLetterReason = this.deadLetterReason(deferred, dueAt)
      if (deadLetterReason) {
        await this.deadLetter.enqueue({ deferred, reason: deadLetterReason, failedAt: dueAt })
        await this.store.deleteDeferredOutboundEvent(
          workspaceId,
          linkId,
          deferred.operationId,
        )
        removedEventCount += 1
        deadLetteredEventCount += 1
        continue
      }

      attemptedEventCount += 1
      let outcome: ExternalChatSyncOutcome
      try {
        outcome = await this.processor.processOutbound(deferred.event)
      } catch (error: unknown) {
        if (error instanceof ExternalChatError && error.retryable) {
          return {
            attemptedEventCount,
            removedEventCount,
            deadLetteredEventCount,
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
          deadLetteredEventCount,
          outcomes,
          stopReason: 'deferred',
        }
      }
      if (outcome.kind === 'failed' && outcome.retryable) {
        return {
          attemptedEventCount,
          removedEventCount,
          deadLetteredEventCount,
          outcomes,
          stopReason: 'retryable-failure',
        }
      }
      await this.store.deleteDeferredOutboundEvent(
        workspaceId,
        linkId,
        deferred.operationId,
      )
      removedEventCount += 1
    }
    return {
      attemptedEventCount,
      removedEventCount,
      deadLetteredEventCount,
      outcomes,
      stopReason: 'batch-complete',
    }
  }

  /**
   * Classifies bounded retry exhaustion for one FIFO entry.
   *
   * @param deferred - Durable outbound queue entry.
   * @param dueAt - Current worker timestamp.
   * @returns DLQ reason, or undefined while retry remains allowed.
   */
  private deadLetterReason(
    deferred: DeferredExternalChatOutboundEvent,
    dueAt: string,
  ): ExternalChatOutboundDeadLetterReason | undefined {
    if (deferred.attempt >= this.maxAttempts) return 'max-attempts'
    const createdAtMs = Date.parse(requireTimestamp(
      deferred.createdAt,
      'deferred outbound creation timestamp',
    ))
    if (Date.parse(dueAt) - createdAtMs >= this.maxAgeMs) return 'max-age'
    return undefined
  }
}

/** Creates an empty successful batch result. */
function createEmptyResult(): ExternalChatOutboundRetryBatchResult {
  return {
    attemptedEventCount: 0,
    removedEventCount: 0,
    deadLetteredEventCount: 0,
    outcomes: [],
    stopReason: 'batch-complete',
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
  const parsed = Date.parse(timestamp)
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== timestamp
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is invalid.`,
    )
  }
  return timestamp
}

/** Reads one positive safe integer option. */
function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is invalid.`,
    )
  }
  return value
}

/** Reads a positive bounded outbound retry batch size. */
function requireBatchLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > EXTERNAL_CHAT_OUTBOUND_RETRY_MAX_BATCH_SIZE
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The outbound retry batch limit must be between 1 and ${EXTERNAL_CHAT_OUTBOUND_RETRY_MAX_BATCH_SIZE}.`,
    )
  }
  return value
}

/** Adds a positive millisecond duration to a canonical timestamp. */
function addMilliseconds(timestamp: string, milliseconds: number): string {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The outbound retry timestamp is invalid.',
    )
  }
  return new Date(parsed + milliseconds).toISOString()
}
