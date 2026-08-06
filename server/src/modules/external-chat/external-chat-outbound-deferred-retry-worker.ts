import { randomUUID } from 'node:crypto'
import type { ExternalChatSyncOutcome } from '@mukuroji/contracts'
import {
  type AcquireExternalChatOutboundRetryPermitInput,
  type DeferredExternalChatOutboundEvent,
  ExternalChatError,
  type ExternalChatOutboundDeadLetterReason,
  type ExternalChatOutboundRetryPermit,
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
  | 'getLink'
  | 'listDeferredOutboundEvents'
  | 'deleteDeferredOutboundEvent'
  | 'prepareOutboundDeadLetterOperation'
  | 'deadLetterOutboundOperation'
>

/** Cancellation fence supplied while one provider mutation owns an installation permit. */
export type ExternalChatOutboundRetryExecutionContext = {
  /**
   * Signal aborted as soon as the worker can no longer renew and validate its durable permit.
   *
   * Processors must propagate this signal through provider transport calls, stop promptly when
   * it aborts, and must not begin additional provider or persistence side effects afterward.
   */
  signal: AbortSignal
  /**
   * Revalidates the exact durable permit at the processor's next side-effect boundary.
   *
   * The processor must await this capability immediately before provider I/O and before each
   * newly started persistence side effect so expiry or lease theft cannot hide between heartbeats.
   */
  assertCurrentPermit: () => Promise<void>
}

/** Existing outbound synchronization boundary invoked for one queued mutation. */
export interface ExternalChatDeferredOutboundProcessorPort {
  /**
   * Processes one trusted internal mutation while honoring the current installation permit.
   *
   * @param event - Complete normalized outbound event retained by the queue.
   * @param context - Abort fence that remains active for the whole awaited provider operation.
   * @returns Durable synchronization outcome.
   */
  processOutbound(
    event: ExternalChatSyncOutboundEvent,
    context: ExternalChatOutboundRetryExecutionContext,
  ): Promise<ExternalChatSyncOutcome>
}

/** Exact installation scope used to serialize bounded retry work. */
export type ExternalChatOutboundRetryConcurrencyInput =
  AcquireExternalChatOutboundRetryPermitInput

/** Distributed installation-level concurrency boundary. */
export type ExternalChatOutboundRetryConcurrencyPort = Pick<
  ExternalChatStore,
  | 'acquireOutboundRetryPermit'
  | 'renewOutboundRetryPermit'
  | 'validateOutboundRetryPermit'
  | 'releaseOutboundRetryPermit'
>

/** Abort-aware scheduler used between installation permit heartbeats. */
export interface ExternalChatOutboundRetryHeartbeatPort {
  /**
   * Waits for the next heartbeat interval or resolves early after cancellation.
   *
   * @param delayMs - Positive bounded delay before the next renewal.
   * @param signal - Processing signal used to stop the pending wait.
   * @returns A promise settled after either condition occurs.
   */
  wait(delayMs: number, signal: AbortSignal): Promise<void>
}

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
  /** Canonical clock used for permit acquisition, renewal, and validation. */
  clock?: ExternalChatOutboundRetryClockPort
  /** Abort-aware scheduler, injectable for deterministic heartbeat tests. */
  heartbeat?: ExternalChatOutboundRetryHeartbeatPort
  /** Optional bounded retry policy. */
  options?: ExternalChatOutboundRetryWorkerOptions
}

/** Canonical clock used to fence provider calls with current lease time. */
export interface ExternalChatOutboundRetryClockPort {
  /** Returns the current canonical UTC timestamp. */
  now(): string
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
  | 'lease-lost'

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

/** Mutable holder tracking the latest renewed fencing capability for one batch. */
type ExternalChatOutboundRetryPermitHolder = {
  /** Latest exact permit returned by the durable concurrency boundary. */
  permit: ExternalChatOutboundRetryPermit
}

/** Settled processor outcome captured without leaking an unhandled rejection into a race. */
type ExternalChatOutboundProcessorSettlement =
  | {
    /** Successful processor settlement. */
    kind: 'outcome'
    /** Durable synchronization outcome. */
    outcome: ExternalChatSyncOutcome
  }
  | {
    /** Failed processor settlement. */
    kind: 'error'
    /** Unknown processor failure preserved for caller classification. */
    error: unknown
  }

/** Result of monitoring one installation permit until processing stops or ownership is lost. */
type ExternalChatOutboundPermitMonitorResult =
  | {
    /** The private processing signal stopped the heartbeat after provider settlement. */
    kind: 'heartbeat-stopped'
  }
  | {
    /** A renewal or exact validation proved the worker no longer owns the permit. */
    kind: 'lease-lost'
  }

/** Combined provider settlement or permit-loss result for one awaited mutation. */
type ExternalChatOutboundFencedProcessingResult =
  | ExternalChatOutboundProcessorSettlement
  | {
    /** Provider processing was aborted after durable permit ownership was lost. */
    kind: 'lease-lost'
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

  /** Canonical clock used for every concurrency lease decision. */
  private readonly clock: ExternalChatOutboundRetryClockPort

  /** Abort-aware scheduler used to renew the permit during provider work. */
  private readonly heartbeat: ExternalChatOutboundRetryHeartbeatPort

  /** Maximum durable attempts before DLQ transfer. */
  private readonly maxAttempts: number

  /** Maximum active queue age in milliseconds. */
  private readonly maxAgeMs: number

  /** Requested installation permit lease duration. */
  private readonly gateLeaseMs: number

  /** Delay between permit renewal attempts while provider work remains pending. */
  private readonly heartbeatIntervalMs: number

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
    this.clock = dependencies.clock ?? { now: () => new Date().toISOString() }
    this.heartbeat = dependencies.heartbeat ?? { wait: waitForRetryHeartbeat }
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
    this.heartbeatIntervalMs = Math.max(1, Math.floor(this.gateLeaseMs / 3))
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
    const acquiredAt = requireTimestamp(this.clock.now(), 'outbound retry acquisition timestamp')
    const concurrencyInput: ExternalChatOutboundRetryConcurrencyInput = {
      workspaceId,
      provider: link.link.provider,
      installationId: link.link.installationId,
      ownerId: `outbound-retry:${workspaceId}:${linkId}:${randomUUID()}`,
      acquiredAt,
      leaseExpiresAt: addMilliseconds(acquiredAt, this.gateLeaseMs),
    }
    const permit = await this.concurrency.acquireOutboundRetryPermit(concurrencyInput)
    if (!permit) {
      return { ...initial, stopReason: 'installation-busy' }
    }
    const permitHolder: ExternalChatOutboundRetryPermitHolder = { permit }
    try {
      return await this.processAcquiredBatch(
        workspaceId,
        linkId,
        dueAt,
        deferredEvents,
        permitHolder,
      )
    } finally {
      await this.concurrency.releaseOutboundRetryPermit({
        permit: permitHolder.permit,
        releasedAt: requireTimestamp(this.clock.now(), 'outbound retry release timestamp'),
      })
    }
  }

  /**
   * Processes one already installation-gated FIFO page.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param linkId - Link whose queue owns every selected row.
   * @param dueAt - Inclusive worker timestamp.
   * @param deferredEvents - Stable occurrence-ordered FIFO page.
   * @param permitHolder - Latest exact installation fencing capability.
   * @returns Batch result after the page completes or blocks.
   */
  private async processAcquiredBatch(
    workspaceId: string,
    linkId: string,
    dueAt: string,
    deferredEvents: DeferredExternalChatOutboundEvent[],
    permitHolder: ExternalChatOutboundRetryPermitHolder,
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
        const preparation = await this.store.prepareOutboundDeadLetterOperation({
          workspaceId,
          linkId,
          operationId: deferred.operationId,
          expectedAttempt: deferred.attempt,
          reason: deadLetterReason,
          deadLetteredAt: dueAt,
        })
        if (preparation.kind === 'busy') {
          return {
            attemptedEventCount,
            removedEventCount,
            deadLetteredEventCount,
            outcomes,
            stopReason: 'busy',
          }
        }
        if (preparation.kind === 'terminal') {
          removedEventCount += 1
          continue
        }
        await this.deadLetter.enqueue({
          deferred: preparation.deferred,
          reason: preparation.reason,
          failedAt: preparation.deadLetteredAt,
        })
        const terminalized = await this.store.deadLetterOutboundOperation({
          workspaceId,
          linkId,
          operationId: preparation.deferred.operationId,
          expectedAttempt: preparation.deferred.attempt,
          reason: preparation.reason,
          deadLetteredAt: preparation.deadLetteredAt,
        })
        if (!terminalized) {
          throw new ExternalChatError(
            'ExternalChatPersistenceFailed',
            'The exhausted outbound receipt changed before DLQ terminalization.',
            true,
          )
        }
        removedEventCount += 1
        deadLetteredEventCount += 1
        continue
      }

      if (!await this.renewAndValidatePermit(permitHolder)) {
        return {
          attemptedEventCount,
          removedEventCount,
          deadLetteredEventCount,
          outcomes,
          stopReason: 'lease-lost',
        }
      }
      attemptedEventCount += 1
      const processing = await this.processWithPermitHeartbeat(
        deferred.event,
        permitHolder,
      )
      if (processing.kind === 'lease-lost') {
        return {
          attemptedEventCount,
          removedEventCount,
          deadLetteredEventCount,
          outcomes,
          stopReason: 'lease-lost',
        }
      }
      if (processing.kind === 'error') {
        if (processing.error instanceof ExternalChatError && processing.error.retryable) {
          return {
            attemptedEventCount,
            removedEventCount,
            deadLetteredEventCount,
            outcomes,
            stopReason: processing.error.code === 'ExternalChatOperationConflict'
              ? 'busy'
              : 'retryable-failure',
          }
        }
        throw processing.error
      }
      const outcome = processing.outcome
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
   * Renews and then validates the exact installation fence before one provider call.
   *
   * @param permitHolder - Mutable latest permit capability for this batch.
   * @returns Whether the worker still owns an unexpired exact fence.
   */
  private async renewAndValidatePermit(
    permitHolder: ExternalChatOutboundRetryPermitHolder,
  ): Promise<boolean> {
    const renewedAt = requireTimestamp(this.clock.now(), 'outbound retry renewal timestamp')
    const renewed = await this.concurrency.renewOutboundRetryPermit({
      permit: permitHolder.permit,
      renewedAt,
      leaseExpiresAt: addMilliseconds(renewedAt, this.gateLeaseMs),
    })
    if (!renewed) return false
    permitHolder.permit = renewed
    return await this.concurrency.validateOutboundRetryPermit({
      permit: renewed,
      checkedAt: requireTimestamp(this.clock.now(), 'outbound retry validation timestamp'),
    })
  }

  /**
   * Runs one processor call while renewing its installation permit until the call settles.
   *
   * @param event - Trusted queued outbound mutation.
   * @param permitHolder - Mutable latest durable permit capability.
   * @returns Provider settlement, or lease loss after the aborted processor has settled.
   */
  private async processWithPermitHeartbeat(
    event: ExternalChatSyncOutboundEvent,
    permitHolder: ExternalChatOutboundRetryPermitHolder,
  ): Promise<ExternalChatOutboundFencedProcessingResult> {
    const abortController = new AbortController()
    const assertCurrentPermit = this.createCurrentPermitGuard(
      permitHolder,
      abortController,
    )
    const processing = this.settleProcessor(
      event,
      abortController.signal,
      assertCurrentPermit,
    )
    const monitoring = this.monitorPermit(permitHolder, abortController.signal)
    const first = await Promise.race([processing, monitoring])
    if (first.kind === 'outcome' || first.kind === 'error') {
      const permitWasLost = abortController.signal.aborted
      abortController.abort()
      const monitorResult = await monitoring
      return permitWasLost || monitorResult.kind === 'lease-lost'
        ? { kind: 'lease-lost' }
        : first
    }
    if (first.kind === 'lease-lost') {
      abortController.abort()
      await processing
      return first
    }
    const settled = await processing
    return abortController.signal.aborted ? { kind: 'lease-lost' } : settled
  }

  /**
   * Captures one processor promise as a value so permit-loss races never leak rejections.
   *
   * @param event - Trusted queued outbound mutation.
   * @param signal - Permit-loss signal supplied to the processor.
   * @param assertCurrentPermit - Exact durable permit validator for side-effect boundaries.
   * @returns Tagged processor settlement.
   */
  private async settleProcessor(
    event: ExternalChatSyncOutboundEvent,
    signal: AbortSignal,
    assertCurrentPermit: () => Promise<void>,
  ): Promise<ExternalChatOutboundProcessorSettlement> {
    try {
      return {
        kind: 'outcome',
        outcome: await this.processor.processOutbound(event, {
          signal,
          assertCurrentPermit,
        }),
      }
    } catch (error: unknown) {
      return { kind: 'error', error }
    }
  }

  /**
   * Renews and validates one exact permit while its provider operation remains pending.
   *
   * @param permitHolder - Mutable latest durable permit capability.
   * @param signal - Private processor cancellation signal.
   * @returns Whether the provider settled normally or the durable permit was lost.
   */
  private async monitorPermit(
    permitHolder: ExternalChatOutboundRetryPermitHolder,
    signal: AbortSignal,
  ): Promise<ExternalChatOutboundPermitMonitorResult> {
    try {
      while (!signal.aborted) {
        await this.heartbeat.wait(this.heartbeatIntervalMs, signal)
        if (signal.aborted) return { kind: 'heartbeat-stopped' }
        if (!await this.renewAndValidatePermit(permitHolder)) {
          return { kind: 'lease-lost' }
        }
      }
      return { kind: 'heartbeat-stopped' }
    } catch {
      return { kind: 'lease-lost' }
    }
  }

  /**
   * Creates an exact durable permit validator for processor side-effect boundaries.
   *
   * @param permitHolder - Mutable latest durable permit capability.
   * @param abortController - Controller cancelled immediately when validation fails.
   * @returns Reusable guard that rejects after ownership loss or exclusive expiry.
   */
  private createCurrentPermitGuard(
    permitHolder: ExternalChatOutboundRetryPermitHolder,
    abortController: AbortController,
  ): () => Promise<void> {
    return async () => {
      if (abortController.signal.aborted) {
        throw createOutboundRetryPermitLostError()
      }
      try {
        const valid = await this.concurrency.validateOutboundRetryPermit({
          permit: permitHolder.permit,
          checkedAt: requireTimestamp(
            this.clock.now(),
            'outbound retry side-effect validation timestamp',
          ),
        })
        if (valid && !abortController.signal.aborted) return
      } catch {
        abortController.abort()
        throw createOutboundRetryPermitLostError()
      }
      abortController.abort()
      throw createOutboundRetryPermitLostError()
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

/**
 * Waits for one default heartbeat interval and resolves early when processing is cancelled.
 *
 * @param delayMs - Positive heartbeat delay in milliseconds.
 * @param signal - Processing cancellation signal.
 * @returns A promise settled after the timer elapses or the signal aborts.
 */
function waitForRetryHeartbeat(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      finish()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
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

/** Creates the retryable error used after durable installation permit loss. */
function createOutboundRetryPermitLostError(): ExternalChatError {
  return new ExternalChatError(
    'ExternalChatOperationConflict',
    'The outbound retry installation permit is no longer current.',
    true,
  )
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
