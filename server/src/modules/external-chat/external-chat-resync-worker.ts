import { createHash } from 'node:crypto'
import type {
  ExternalChatInboundEvent,
  ExternalChatMessage,
  ExternalChatSourceAvailability,
  ExternalChatSourceState,
  ExternalChatSyncCursor,
  ExternalChatSyncOutcome,
  ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import {
  ChatProviderAdapterError,
  type ChatProviderAdapterRegistry,
  type ChatProviderAuthorization,
  type ChatProviderThreadPage,
} from './chat-provider-adapter'
import { normalizeChatProviderThreadPage } from './chat-provider-normalizer'
import { normalizeExternalChatRetryAt } from './external-chat-retry-schedule'
import {
  ExternalChatError,
  type ExternalChatStore,
  type StoredExternalChatLink,
} from './external-chat'
import type { ExternalChatResyncJob } from './external-chat-link-service'
import type {
  ExternalChatSyncAccessPort,
  ExternalChatSyncClockPort,
  ExternalChatSyncInboundInput,
} from './external-chat-sync-service'

/** Maximum provider messages requested in one resynchronization page. */
const MAXIMUM_RESYNC_PAGE_SIZE = 100

/** Maximum provider pages accepted in one bounded worker delivery. */
const MAXIMUM_RESYNC_PAGES_PER_RUN = 100

/** Maximum provider messages accepted in one bounded worker delivery. */
const MAXIMUM_RESYNC_MESSAGES_PER_RUN = 10_000

/** Stable reason that a resynchronization delivery did not reach successful completion. */
export type ExternalChatResyncWorkerStopReason =
  | 'authorization-lost'
  | 'budget-exhausted'
  | 'concurrent'
  | 'inbound-paused'
  | 'invalid-provider-response'
  | 'provider-unavailable'
  | 'snapshot-deferred'
  | 'snapshot-failed'
  | 'superseded'
  | 'unlinked'

/** Secret-free result of one bounded resynchronization worker delivery. */
export type ExternalChatResyncWorkerResult = {
  /** Whether the operation completed, should retry, or permanently stopped. */
  kind: 'completed' | 'deferred' | 'stopped'
  /** Stable accepted resynchronization operation identifier. */
  operationId: string
  /** Number of complete provider pages processed by this delivery. */
  processedPageCount: number
  /** Number of message snapshots processed by this delivery. */
  processedMessageCount: number
  /** Secret-free reason when the delivery did not complete successfully. */
  reason?: ExternalChatResyncWorkerStopReason
  /** Earliest safe retry timestamp propagated from a deferred snapshot or provider. */
  retryAt?: string
}

/** Tunable strict bounds for one resynchronization worker delivery. */
export type ExternalChatResyncWorkerOptions = {
  /** Maximum provider messages requested per page. */
  pageSize?: number
  /** Maximum complete provider pages processed per queue delivery. */
  maximumPagesPerRun?: number
  /** Maximum message snapshots processed per queue delivery. */
  maximumMessagesPerRun?: number
}

/** Narrow inbound boundary reserved for durable resynchronization snapshots. */
export interface ExternalChatResyncSnapshotProcessorPort {
  /** Applies one stable synthetic snapshot without changing the job-owned link projection. */
  processResyncSnapshot(input: ExternalChatSyncInboundInput): Promise<ExternalChatSyncOutcome>
}

/** Dependencies required by the provider-neutral resynchronization worker. */
export type ExternalChatResyncWorkerDependencies = {
  /** Durable tenant-scoped external chat store. */
  store: ExternalChatStore
  /** Registered provider adapters. */
  adapters: ChatProviderAdapterRegistry
  /** Current installation authorization boundary. */
  access: ExternalChatSyncAccessPort
  /** Existing durable inbound synchronization processor. */
  processor: ExternalChatResyncSnapshotProcessorPort
  /** Deterministic worker clock. */
  clock: ExternalChatSyncClockPort
}

/** Internal decision made while claiming an operation-owned checkpoint. */
type ClaimCheckpointResult =
  | {
    /** A current operation-owned checkpoint is ready for processing or finalization. */
    kind: 'owned'
    /** Current durable checkpoint. */
    cursor: ExternalChatSyncCursor
  }
  | {
    /** A newer accepted operation already owns the durable checkpoint. */
    kind: 'superseded'
  }

/** Current link and installation authorization validated for one provider request. */
type AuthorizedJobScope = {
  /** Exact accepted link revision owned by the job. */
  record: StoredExternalChatLink
  /** Current matching installation authorization. */
  authorization: ChatProviderAuthorization
}

/** Current authorization decision for one exact accepted job revision. */
type AuthorizedJobScopeResult =
  | {
    /** The active link and installation authorization are current. */
    kind: 'authorized'
    /** Current exact job scope. */
    scope: AuthorizedJobScope
  }
  | {
    /** The job cannot safely perform another provider read. */
    kind: 'stopped'
    /** Current record when the link still exists. */
    record?: StoredExternalChatLink
    /** Stable reason for stopping before the provider read. */
    reason: 'authorization-lost' | 'superseded' | 'unlinked'
  }

/** Classification of a provider read failure at the worker boundary. */
type ProviderFailureDecision = {
  /** Whether the same queue job may recover. */
  retryable: boolean
  /** Secret-free worker stop reason. */
  reason: ExternalChatResyncWorkerStopReason
  /** Honest terminal link status for a non-retryable failure. */
  terminalStatus?: ExternalChatWorkItemLink['syncStatus']
  /** Source availability learned from the classified provider failure. */
  availability?: ExternalChatSourceAvailability
  /** Source lifecycle state learned from the classified provider failure. */
  state?: ExternalChatSourceState
  /** Earliest safe retry timestamp supplied by the provider. */
  retryAt?: string
}

/**
 * Executes accepted resynchronization jobs through bounded provider pages and durable checkpoints.
 */
export class ExternalChatResyncWorker {
  /** Durable synchronization store. */
  private readonly store: ExternalChatStore

  /** Provider adapter registry. */
  private readonly adapters: ChatProviderAdapterRegistry

  /** Current authorization boundary. */
  private readonly access: ExternalChatSyncAccessPort

  /** Existing inbound snapshot processor. */
  private readonly processor: ExternalChatResyncSnapshotProcessorPort

  /** Deterministic clock. */
  private readonly clock: ExternalChatSyncClockPort

  /** Per-page provider message bound. */
  private readonly pageSize: number

  /** Per-delivery provider page bound. */
  private readonly maximumPagesPerRun: number

  /** Per-delivery provider message bound. */
  private readonly maximumMessagesPerRun: number

  /**
   * Creates a bounded provider-neutral resynchronization worker.
   *
   * @param dependencies - Store, provider, authorization, processor, and clock boundaries.
   * @param options - Optional strict page and delivery bounds.
   */
  constructor(
    dependencies: ExternalChatResyncWorkerDependencies,
    options: ExternalChatResyncWorkerOptions = {},
  ) {
    this.store = dependencies.store
    this.adapters = dependencies.adapters
    this.access = dependencies.access
    this.processor = dependencies.processor
    this.clock = dependencies.clock
    this.pageSize = requireBoundedInteger(
      options.pageSize,
      50,
      MAXIMUM_RESYNC_PAGE_SIZE,
      'resynchronization page size',
    )
    this.maximumPagesPerRun = requireBoundedInteger(
      options.maximumPagesPerRun,
      10,
      MAXIMUM_RESYNC_PAGES_PER_RUN,
      'resynchronization page budget',
    )
    this.maximumMessagesPerRun = requireBoundedInteger(
      options.maximumMessagesPerRun,
      500,
      MAXIMUM_RESYNC_MESSAGES_PER_RUN,
      'resynchronization message budget',
    )
  }

  /**
   * Processes one accepted resynchronization job until completion or a safe bounded stop.
   *
   * @param job - Durable outbox job accepted with the pending link revision.
   * @returns Secret-free result that never exposes a provider continuation.
   */
  async process(job: ExternalChatResyncJob): Promise<ExternalChatResyncWorkerResult> {
    validateResyncJob(job)
    let processedPageCount = 0
    let processedMessageCount = 0
    const initialRecord = await this.store.getLink(job.workspaceId, job.linkId)
    const initialCursor = await this.store.getSyncCursor(job.workspaceId, job.linkId)

    if (isMatchingCompletedCursor(initialCursor, job)) {
      if (initialRecord?.active && initialRecord.link.revision === job.linkRevision) {
        if (!await this.projectCompletedCheckpoint(job, initialCursor)) {
          return deferredResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'concurrent',
          )
        }
      }
      return completedResult(job.operationId, processedPageCount, processedMessageCount)
    }
    if (!initialRecord || !initialRecord.active) {
      return stoppedResult(job.operationId, processedPageCount, processedMessageCount, 'unlinked')
    }
    if (initialRecord.link.revision !== job.linkRevision) {
      return stoppedResult(
        job.operationId,
        processedPageCount,
        processedMessageCount,
        'superseded',
      )
    }
    validateJobLinkScope(job, initialRecord)

    const claim = await this.claimCheckpoint(job, initialRecord)
    if (claim.kind === 'superseded') {
      return stoppedResult(
        job.operationId,
        processedPageCount,
        processedMessageCount,
        'superseded',
      )
    }
    let cursor = claim.cursor
    if (cursor.status === 'completed') {
      if (!await this.projectCompletedCheckpoint(job, cursor)) {
        return deferredResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          'concurrent',
        )
      }
      return completedResult(job.operationId, processedPageCount, processedMessageCount)
    }

    if (!allowsInbound(initialRecord.link)) {
      const completed = await this.completeCheckpoint(
        job,
        cursor,
        initialRecord.link.sourceAvailability,
        initialRecord.link.sourceState,
        'paused',
      )
      if (!completed) {
        return stoppedResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          'superseded',
        )
      }
      if (!await this.projectCompletedCheckpoint(job, completed)) {
        return deferredResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          'concurrent',
        )
      }
      return stoppedResult(
        job.operationId,
        processedPageCount,
        processedMessageCount,
        'inbound-paused',
      )
    }

    while (true) {
      if (
        processedPageCount >= this.maximumPagesPerRun ||
        processedMessageCount >= this.maximumMessagesPerRun
      ) {
        return deferredResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          'budget-exhausted',
        )
      }

      const authorized = await this.getAuthorizedJobScope(job)
      if (authorized.kind === 'stopped') {
        if (authorized.reason === 'authorization-lost' && authorized.record) {
          const completed = await this.completeCheckpoint(
            job,
            cursor,
            'needs-reauth',
            authorized.record.link.sourceState,
            'paused',
          )
          if (completed && !await this.projectCompletedCheckpoint(job, completed)) {
            return deferredResult(
              job.operationId,
              processedPageCount,
              processedMessageCount,
              'concurrent',
            )
          }
        }
        return stoppedResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          authorized.reason,
        )
      }

      const remainingMessages = this.maximumMessagesPerRun - processedMessageCount
      const requestedLimit = Math.min(this.pageSize, remainingMessages)
      let page: ChatProviderThreadPage
      try {
        const adapter = this.adapters.get(authorized.scope.record.link.provider)
        page = normalizeChatProviderThreadPage(
          await adapter.readThreadPage({
            authorization: authorized.scope.authorization,
            source: authorized.scope.record.link.source,
            ...(cursor.providerCursor === undefined
              ? {}
              : { providerCursor: cursor.providerCursor }),
            limit: requestedLimit,
          }),
          adapter.definition.permalinkHosts,
        )
      } catch (error: unknown) {
        const failure = classifyProviderFailure(error, this.clock.now(), job.operationId)
        if (!failure) throw error
        if (failure.retryable) {
          return deferredResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            failure.reason,
            failure.retryAt,
          )
        }
        const completionStatus = failure.terminalStatus ?? 'failed'
        const completed = await this.completeCheckpoint(
          job,
          cursor,
          failure.availability ?? authorized.scope.record.link.sourceAvailability,
          failure.state ?? authorized.scope.record.link.sourceState,
          completionStatus,
        )
        if (completed && !await this.projectCompletedCheckpoint(job, completed)) {
          return deferredResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'concurrent',
          )
        }
        return stoppedResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          failure.reason,
        )
      }

      try {
        validateProviderPage(
          authorized.scope.record.link,
          page,
          cursor.providerCursor,
          cursor.lastEventAt,
          requestedLimit,
        )
      } catch (error: unknown) {
        if (!(error instanceof ChatProviderAdapterError)) throw error
        const completed = await this.completeCheckpoint(
          job,
          cursor,
          authorized.scope.record.link.sourceAvailability,
          authorized.scope.record.link.sourceState,
          'failed',
        )
        if (completed && !await this.projectCompletedCheckpoint(job, completed)) {
          return deferredResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'concurrent',
          )
        }
        return stoppedResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          'invalid-provider-response',
        )
      }

      if (statusForObservedSource(page.thread.availability, page.thread.state) !== 'synced') {
        const completed = await this.completeCheckpoint(
          job,
          cursor,
          page.thread.availability,
          page.thread.state,
          'paused',
        )
        if (completed && !await this.projectCompletedCheckpoint(job, completed)) {
          return deferredResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'concurrent',
          )
        }
        return stoppedResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          completed ? 'provider-unavailable' : 'superseded',
        )
      }

      let lastEventId = cursor.lastEventId
      let lastEventAt = cursor.lastEventAt
      for (const message of page.thread.messages) {
        const currentRecord = await this.store.getLink(job.workspaceId, job.linkId)
        if (!currentRecord || !currentRecord.active) {
          return stoppedResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'unlinked',
          )
        }
        if (currentRecord.link.revision !== job.linkRevision) {
          return stoppedResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'superseded',
          )
        }
        const event = createSnapshotEvent(job, currentRecord.link, message)
        let outcome: ExternalChatSyncOutcome
        try {
          outcome = await this.processor.processResyncSnapshot({
            workspaceId: job.workspaceId,
            event,
            expectedLinkRevision: job.linkRevision,
          })
        } catch (error: unknown) {
          if (error instanceof ExternalChatError && error.retryable) {
            return deferredResult(
              job.operationId,
              processedPageCount,
              processedMessageCount,
              'concurrent',
            )
          }
          throw error
        }
        processedMessageCount += 1
        if (outcome.kind === 'deferred' || (outcome.kind === 'failed' && outcome.retryable)) {
          return deferredResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'snapshot-deferred',
            outcome.kind === 'deferred' ? outcome.retryAt : undefined,
          )
        }
        if (outcome.kind === 'failed') {
          const completed = await this.completeCheckpoint(
            job,
            cursor,
            page.thread.availability,
            page.thread.state,
            'failed',
          )
          if (completed && !await this.projectCompletedCheckpoint(job, completed)) {
            return deferredResult(
              job.operationId,
              processedPageCount,
              processedMessageCount,
              'concurrent',
            )
          }
          return stoppedResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'snapshot-failed',
          )
        }
        if (outcome.kind === 'skipped' && outcome.reason === 'unlinked') {
          return stoppedResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'unlinked',
          )
        }
        if (outcome.kind === 'skipped' && outcome.reason === 'paused') {
          return stoppedResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'inbound-paused',
          )
        }
        lastEventId = event.eventId
        lastEventAt = message.postedAt
      }

      const nextCursor = createAdvancedCheckpoint(
        cursor,
        page,
        lastEventId,
        lastEventAt,
        this.clock.now(),
      )
      const advanced = await this.advanceCheckpoint(job, cursor, nextCursor)
      if (!advanced) {
        return stoppedResult(
          job.operationId,
          processedPageCount,
          processedMessageCount,
          'superseded',
        )
      }
      cursor = advanced
      processedPageCount += 1
      if (cursor.status === 'completed') {
        if (!await this.projectCompletedCheckpoint(job, cursor)) {
          return deferredResult(
            job.operationId,
            processedPageCount,
            processedMessageCount,
            'concurrent',
          )
        }
        return completedResult(job.operationId, processedPageCount, processedMessageCount)
      }
    }
  }

  /**
   * Claims a new operation checkpoint or recovers its exact durable state through CAS.
   *
   * @param job - Accepted resynchronization job.
   * @param record - Exact accepted link revision.
   * @returns Owned checkpoint or a superseded decision.
   */
  private async claimCheckpoint(
    job: ExternalChatResyncJob,
    record: StoredExternalChatLink,
  ): Promise<ClaimCheckpointResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.store.getSyncCursor(job.workspaceId, job.linkId)
      if (current) validateCursorScope(current, record.link)
      if (current?.operationId === job.operationId) {
        validateOwnedCursor(current, job)
        return { kind: 'owned', cursor: current }
      }
      if (current && current.ownerLinkRevision >= job.linkRevision) {
        return { kind: 'superseded' }
      }
      const candidate = createClaimedCheckpoint(job, record.link, current, this.clock.now())
      const stored = await this.store.putSyncCursor(
        job.workspaceId,
        candidate,
        current?.revision,
      )
      if (stored) return { kind: 'owned', cursor: candidate }
    }
    return { kind: 'superseded' }
  }

  /**
   * Revalidates the exact active link and current installation authorization before a provider read.
   *
   * @param job - Accepted resynchronization job.
   * @returns Authorized scope or a permanent stop reason.
   */
  private async getAuthorizedJobScope(
    job: ExternalChatResyncJob,
  ): Promise<AuthorizedJobScopeResult> {
    const record = await this.store.getLink(job.workspaceId, job.linkId)
    if (!record || !record.active) {
      return { kind: 'stopped', reason: 'unlinked' }
    }
    if (record.link.revision !== job.linkRevision) {
      return { kind: 'stopped', record, reason: 'superseded' }
    }
    validateJobLinkScope(job, record)
    const authorization = await this.access.getInstallationProviderAuthorization(
      job.workspaceId,
      record.link,
    )
    if (!authorization || !authorizationMatchesLink(authorization, record.link)) {
      return { kind: 'stopped', record, reason: 'authorization-lost' }
    }
    return { kind: 'authorized', scope: { record, authorization } }
  }

  /**
   * Commits a terminal operation checkpoint before any user-visible link projection.
   *
   * @param job - Accepted resynchronization job.
   * @param current - Current operation-owned processing checkpoint.
   * @param availability - Last honestly known source availability.
   * @param state - Last honestly known source lifecycle state.
   * @param syncStatus - Terminal link status to project after the checkpoint.
   * @returns Committed terminal checkpoint, or undefined when superseded.
   */
  private async completeCheckpoint(
    job: ExternalChatResyncJob,
    current: ExternalChatSyncCursor,
    availability: ExternalChatSourceAvailability,
    state: ExternalChatSourceState,
    syncStatus: ExternalChatWorkItemLink['syncStatus'],
  ): Promise<ExternalChatSyncCursor | undefined> {
    if (current.status === 'completed') return current
    const completed: ExternalChatSyncCursor = {
      ...current,
      status: 'completed',
      observedSourceAvailability: availability,
      observedSourceState: state,
      completionSyncStatus: syncStatus,
      providerCursor: undefined,
      revision: current.revision + 1,
      updatedAt: this.clock.now(),
    }
    return this.advanceCheckpoint(job, current, completed)
  }

  /**
   * Advances one operation-owned cursor and recovers an identical concurrent advancement.
   *
   * @param job - Accepted resynchronization job.
   * @param current - Previously read cursor revision.
   * @param replacement - Adjacent replacement cursor.
   * @returns Latest same-operation cursor, or undefined when superseded.
   */
  private async advanceCheckpoint(
    job: ExternalChatResyncJob,
    current: ExternalChatSyncCursor,
    replacement: ExternalChatSyncCursor,
  ): Promise<ExternalChatSyncCursor | undefined> {
    const stored = await this.store.putSyncCursor(
      job.workspaceId,
      replacement,
      current.revision,
    )
    if (stored) return replacement
    const recovered = await this.store.getSyncCursor(job.workspaceId, job.linkId)
    if (!recovered || recovered.operationId !== job.operationId) return undefined
    validateOwnedCursor(recovered, job)
    return recovered
  }

  /**
   * Projects a terminal checkpoint with the original accepted link revision fence.
   *
   * @param job - Accepted resynchronization job.
   * @param cursor - Completed operation-owned checkpoint.
   * @returns Whether the projection committed or became obsolete through a newer link revision.
   */
  private async projectCompletedCheckpoint(
    job: ExternalChatResyncJob,
    cursor: ExternalChatSyncCursor,
  ): Promise<boolean> {
    validateOwnedCursor(cursor, job)
    if (
      cursor.status !== 'completed' ||
      cursor.observedSourceAvailability === undefined ||
      cursor.observedSourceState === undefined ||
      cursor.completionSyncStatus === undefined
    ) {
      throw new ExternalChatError(
        'ExternalChatPersistenceFailed',
        'The terminal resynchronization checkpoint is incomplete.',
      )
    }
    const latestCursor = await this.store.getSyncCursor(job.workspaceId, job.linkId)
    if (!isMatchingCompletedCursor(latestCursor, job)) return true
    const current = await this.store.getLink(job.workspaceId, job.linkId)
    if (!current || !current.active || current.link.revision !== job.linkRevision) return true
    const projectedAt = this.clock.now()
    const link: ExternalChatWorkItemLink = {
      ...current.link,
      sourceAvailability: cursor.observedSourceAvailability,
      sourceState: cursor.observedSourceState,
      syncStatus: cursor.completionSyncStatus,
      ...(cursor.completionSyncStatus === 'synced'
        ? { lastSyncedAt: projectedAt, lastSourceObservedAt: projectedAt }
        : {}),
      revision: current.link.revision + 1,
      updatedAt: projectedAt,
    }
    const result = await this.store.updateLink({
      workspaceId: job.workspaceId,
      link,
      expectedRevision: job.linkRevision,
    })
    if (result.kind === 'updated' || result.kind === 'not-found') return true
    if (result.kind === 'parent-stale') {
      throw new ExternalChatError(
        'ExternalChatPersistenceFailed',
        'A non-parent resynchronization update returned a parent fence conflict.',
      )
    }
    return result.record.link.revision !== job.linkRevision
  }
}

/**
 * Creates a new operation checkpoint, carrying a prior partial cursor only for resume mode.
 *
 * @param job - Accepted resynchronization job.
 * @param link - Exact accepted link revision.
 * @param current - Prior operation checkpoint when one exists.
 * @param now - Canonical checkpoint timestamp.
 * @returns Adjacent operation-owned checkpoint.
 */
function createClaimedCheckpoint(
  job: ExternalChatResyncJob,
  link: ExternalChatWorkItemLink,
  current: ExternalChatSyncCursor | undefined,
  now: string,
): ExternalChatSyncCursor {
  const resumesPartialTraversal = job.mode === 'resume' && current?.status === 'processing'
  return {
    schemaVersion: 1,
    linkId: job.linkId,
    provider: link.provider,
    operationId: job.operationId,
    mode: job.mode,
    status: 'processing',
    ownerLinkRevision: job.linkRevision,
    ...(resumesPartialTraversal && current?.observedSourceAvailability !== undefined
      ? { observedSourceAvailability: current.observedSourceAvailability }
      : {}),
    ...(resumesPartialTraversal && current?.observedSourceState !== undefined
      ? { observedSourceState: current.observedSourceState }
      : {}),
    ...(resumesPartialTraversal && current?.providerCursor !== undefined
      ? { providerCursor: current.providerCursor }
      : {}),
    revision: (current?.revision ?? 0) + 1,
    ...(resumesPartialTraversal && current?.lastEventId !== undefined
      ? { lastEventId: current.lastEventId }
      : {}),
    ...(resumesPartialTraversal && current?.lastEventAt !== undefined
      ? { lastEventAt: current.lastEventAt }
      : {}),
    updatedAt: now,
  }
}

/**
 * Creates the adjacent checkpoint after every snapshot in a provider page reaches a terminal state.
 *
 * @param current - Current operation-owned checkpoint.
 * @param page - Strictly validated provider page.
 * @param lastEventId - Last stable synthetic event ID committed through the page.
 * @param lastEventAt - Posting timestamp of the last committed snapshot.
 * @param now - Canonical checkpoint timestamp.
 * @returns Adjacent processing or completed checkpoint.
 */
function createAdvancedCheckpoint(
  current: ExternalChatSyncCursor,
  page: ChatProviderThreadPage,
  lastEventId: string | undefined,
  lastEventAt: string | undefined,
  now: string,
): ExternalChatSyncCursor {
  const completed = page.providerCursor === undefined
  const completionSyncStatus = statusForObservedSource(
    page.thread.availability,
    page.thread.state,
  )
  return {
    ...current,
    status: completed ? 'completed' : 'processing',
    observedSourceAvailability: page.thread.availability,
    observedSourceState: page.thread.state,
    ...(completed ? { completionSyncStatus } : { completionSyncStatus: undefined }),
    ...(page.providerCursor === undefined
      ? { providerCursor: undefined }
      : { providerCursor: page.providerCursor }),
    revision: current.revision + 1,
    ...(lastEventId === undefined ? {} : { lastEventId }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    updatedAt: now,
  }
}

/**
 * Creates a stable synthetic provider event for one resynchronization snapshot.
 *
 * @param job - Accepted resynchronization operation.
 * @param link - Current exact job-owned link.
 * @param message - Provider-neutral message snapshot.
 * @returns Stable message-created event consumed by the existing inbound processor.
 */
function createSnapshotEvent(
  job: ExternalChatResyncJob,
  link: ExternalChatWorkItemLink,
  message: ExternalChatMessage,
): ExternalChatInboundEvent {
  const eventId = `resync-${createHash('sha256').update(JSON.stringify({
    version: 1,
    operationId: job.operationId,
    provider: link.provider,
    externalMessageId: message.externalId,
    externalVersion: message.externalVersion,
    state: message.state,
  })).digest('hex')}`
  if (message.state === 'active') {
    return {
      schemaVersion: 1,
      type: 'message.created',
      eventId,
      correlationId: job.correlationId,
      installationId: link.installationId,
      provider: link.provider,
      externalWorkspaceId: link.source.externalWorkspaceId,
      conversationExternalId: link.source.conversationExternalId,
      threadExternalId: link.source.threadExternalId,
      occurredAt: message.updatedAt,
      message,
    }
  }
  return {
    schemaVersion: 1,
    type: 'message.deleted',
    eventId,
    correlationId: job.correlationId,
    installationId: link.installationId,
    provider: link.provider,
    externalWorkspaceId: link.source.externalWorkspaceId,
    conversationExternalId: link.source.conversationExternalId,
    threadExternalId: link.source.threadExternalId,
    occurredAt: message.updatedAt,
    externalMessageId: message.externalId,
    externalVersion: message.externalVersion,
    ...(message.permalink === undefined ? {} : { sourcePermalink: message.permalink }),
    deletedAt: message.deletedAt ?? message.updatedAt,
  }
}

/**
 * Rejects an out-of-scope, over-bound, cursor-leaking, duplicate, or unordered provider page.
 *
 * @param link - Exact job-owned link scope.
 * @param page - Untrusted provider adapter result.
 * @param requestedCursor - Private continuation supplied to the adapter.
 * @param previousEventAt - Posting timestamp committed by the previous checkpoint.
 * @param requestedLimit - Strict message count requested from the adapter.
 */
function validateProviderPage(
  link: ExternalChatWorkItemLink,
  page: ChatProviderThreadPage,
  requestedCursor: string | undefined,
  previousEventAt: string | undefined,
  requestedLimit: number,
): void {
  if (
    page.thread.workspace.provider !== link.provider ||
    page.thread.workspace.externalId !== link.source.externalWorkspaceId ||
    page.thread.conversation.externalWorkspaceId !== link.source.externalWorkspaceId ||
    page.thread.conversation.externalId !== link.source.conversationExternalId ||
    page.thread.externalId !== link.source.threadExternalId ||
    page.thread.rootMessageExternalId !== link.source.rootMessageExternalId
  ) {
    throw invalidProviderResponse('The resynchronization page escaped the linked source scope.')
  }
  if (
    page.thread.messages.length > requestedLimit ||
    page.thread.hasMoreMessages !== (page.providerCursor !== undefined) ||
    page.thread.nextMessageCursor !== undefined ||
    (page.providerCursor !== undefined &&
      (page.providerCursor.trim().length === 0 || page.providerCursor === requestedCursor))
  ) {
    throw invalidProviderResponse('The provider returned an invalid bounded resync page.')
  }
  const messageIds = new Set<string>()
  let previousPostedAt = previousEventAt
  for (const message of page.thread.messages) {
    if (
      message.conversationExternalId !== link.source.conversationExternalId ||
      message.threadExternalId !== link.source.threadExternalId ||
      messageIds.has(message.externalId) ||
      !isCanonicalTimestamp(message.postedAt) ||
      !isCanonicalTimestamp(message.updatedAt) ||
      (previousPostedAt !== undefined && Date.parse(message.postedAt) < Date.parse(previousPostedAt))
    ) {
      throw invalidProviderResponse(
        'The provider returned an out-of-scope, duplicate, or unordered message snapshot.',
      )
    }
    messageIds.add(message.externalId)
    previousPostedAt = message.postedAt
  }
}

/**
 * Validates a persisted cursor against immutable link scope.
 *
 * @param cursor - Persisted private cursor.
 * @param link - Current link.
 */
function validateCursorScope(cursor: ExternalChatSyncCursor, link: ExternalChatWorkItemLink): void {
  if (cursor.linkId !== link.id || cursor.provider !== link.provider) {
    throw new ExternalChatError(
      'ExternalChatPersistenceFailed',
      'The persisted resynchronization cursor does not match its link scope.',
    )
  }
}

/**
 * Validates an operation-owned cursor against the accepted immutable job identity.
 *
 * @param cursor - Persisted private cursor.
 * @param job - Accepted resynchronization job.
 */
function validateOwnedCursor(cursor: ExternalChatSyncCursor, job: ExternalChatResyncJob): void {
  if (
    cursor.linkId !== job.linkId ||
    cursor.operationId !== job.operationId ||
    cursor.mode !== job.mode ||
    cursor.ownerLinkRevision !== job.linkRevision
  ) {
    throw new ExternalChatError(
      'ExternalChatPersistenceFailed',
      'The persisted resynchronization cursor does not match its owning job.',
    )
  }
}

/**
 * Detects an exact completed checkpoint for queue replay recovery.
 *
 * @param cursor - Current persisted cursor when one exists.
 * @param job - Replayed accepted job.
 * @returns Whether the exact operation has already reached a terminal checkpoint.
 */
function isMatchingCompletedCursor(
  cursor: ExternalChatSyncCursor | undefined,
  job: ExternalChatResyncJob,
): cursor is ExternalChatSyncCursor {
  return cursor?.operationId === job.operationId &&
    cursor.mode === job.mode &&
    cursor.ownerLinkRevision === job.linkRevision &&
    cursor.status === 'completed'
}

/**
 * Validates the queue job and its tenant-scoped identifiers.
 *
 * @param job - Candidate durable resynchronization job.
 */
function validateResyncJob(job: ExternalChatResyncJob): void {
  requireIdentifier(job.workspaceId, 'Workspace ID')
  requireIdentifier(job.linkId, 'external chat link ID')
  requireIdentifier(job.operationId, 'resynchronization operation ID')
  requireIdentifier(job.correlationId, 'correlation ID')
  if (
    (job.mode !== 'resume' && job.mode !== 'full') ||
    !Number.isSafeInteger(job.linkRevision) ||
    job.linkRevision < 1 ||
    !isCanonicalTimestamp(job.acceptedAt)
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The resynchronization job is invalid.',
    )
  }
}

/**
 * Validates tenant and immutable link identity retained by an accepted job.
 *
 * @param job - Accepted resynchronization job.
 * @param record - Current stored link record.
 */
function validateJobLinkScope(job: ExternalChatResyncJob, record: StoredExternalChatLink): void {
  if (record.workspaceId !== job.workspaceId || record.link.id !== job.linkId) {
    throw new ExternalChatError(
      'ExternalChatPersistenceFailed',
      'The resynchronization job does not match its stored link scope.',
    )
  }
}

/**
 * Checks whether current installation authorization matches immutable link scope.
 *
 * @param authorization - Current installation authorization.
 * @param link - Stored link scope.
 * @returns Whether the authorization is current and correctly scoped.
 */
function authorizationMatchesLink(
  authorization: ChatProviderAuthorization,
  link: ExternalChatWorkItemLink,
): boolean {
  return authorization.installationId === link.installationId &&
    authorization.externalWorkspaceId === link.source.externalWorkspaceId &&
    Number.isSafeInteger(authorization.authorizationRevision) &&
    authorization.authorizationRevision >= 1
}

/**
 * Checks whether explicit synchronization direction permits provider-to-internal snapshots.
 *
 * @param link - Current link configuration.
 * @returns Whether inbound synchronization is enabled.
 */
function allowsInbound(link: ExternalChatWorkItemLink): boolean {
  return link.syncDirection === 'inbound' || link.syncDirection === 'bidirectional'
}

/**
 * Maps an observed provider source to the honest final link synchronization state.
 *
 * @param availability - Current provider source availability.
 * @param state - Current provider thread lifecycle state.
 * @returns Synced only for accessible live or completed threads.
 */
function statusForObservedSource(
  availability: ExternalChatSourceAvailability,
  state: ExternalChatSourceState,
): ExternalChatWorkItemLink['syncStatus'] {
  if (availability !== 'available') return 'paused'
  return state === 'active' || state === 'completed' ? 'synced' : 'paused'
}

/**
 * Classifies a provider adapter failure without exposing provider response details.
 *
 * @param error - Unknown provider read failure.
 * @param now - Current canonical server timestamp used to bound retry scheduling.
 * @param operationId - Stable job identifier used for deterministic jitter.
 * @returns Worker decision for a classified adapter error, or undefined for an unknown crash.
 */
function classifyProviderFailure(
  error: unknown,
  now: string,
  operationId: string,
): ProviderFailureDecision | undefined {
  if (!(error instanceof ChatProviderAdapterError)) return undefined
  switch (error.code) {
    case 'ChatProviderRateLimited':
      return {
        retryable: true,
        reason: 'provider-unavailable',
        retryAt: normalizeExternalChatRetryAt(now, operationId, error.retryAt),
      }
    case 'ChatProviderTransientFailure':
    case 'ChatProviderAdapterUnavailable':
      return {
        retryable: true,
        reason: 'provider-unavailable',
        retryAt: normalizeExternalChatRetryAt(now, operationId),
      }
    case 'ChatProviderPermissionDenied':
      return {
        retryable: false,
        reason: 'authorization-lost',
        terminalStatus: 'paused',
        availability: 'permission-lost',
      }
    case 'ChatProviderReauthorizationRequired':
      return {
        retryable: false,
        reason: 'authorization-lost',
        terminalStatus: 'paused',
        availability: 'needs-reauth',
      }
    case 'ChatProviderDisconnected':
      return {
        retryable: false,
        reason: 'authorization-lost',
        terminalStatus: 'paused',
        availability: 'installation-disconnected',
      }
    case 'ChatProviderSourceNotFound':
      return {
        retryable: false,
        reason: 'provider-unavailable',
        terminalStatus: 'paused',
        availability: 'permission-lost',
        state: 'deleted',
      }
    default:
      return {
        retryable: false,
        reason: 'invalid-provider-response',
        terminalStatus: 'failed',
      }
  }
}

/**
 * Creates a classified invalid adapter response.
 *
 * @param message - Secret-free validation message.
 * @returns Classified provider response error.
 */
function invalidProviderResponse(message: string): ChatProviderAdapterError {
  return new ChatProviderAdapterError('ChatProviderInvalidResponse', message)
}

/**
 * Validates an optional integer bound and applies its default.
 *
 * @param value - Optional configured bound.
 * @param fallback - Default bound.
 * @param maximum - Hard safety maximum.
 * @param label - Secret-free validation label.
 * @returns Validated positive integer.
 */
function requireBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} must be a positive integer no greater than ${maximum}.`,
    )
  }
  return resolved
}

/**
 * Validates one non-empty identifier without normalizing its identity.
 *
 * @param value - Candidate identifier.
 * @param label - Secret-free identifier label.
 */
function requireIdentifier(value: string, label: string): void {
  if (value.trim() !== value || value.length === 0) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is required.`,
    )
  }
}

/**
 * Checks one canonical ISO 8601 timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Whether the timestamp round-trips through the platform parser.
 */
function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

/**
 * Creates a successful worker result.
 *
 * @param operationId - Accepted operation identifier.
 * @param processedPageCount - Complete pages processed by this delivery.
 * @param processedMessageCount - Snapshots processed by this delivery.
 * @returns Successful secret-free result.
 */
function completedResult(
  operationId: string,
  processedPageCount: number,
  processedMessageCount: number,
): ExternalChatResyncWorkerResult {
  return { kind: 'completed', operationId, processedPageCount, processedMessageCount }
}

/**
 * Creates a retryable worker result.
 *
 * @param operationId - Accepted operation identifier.
 * @param processedPageCount - Complete pages processed by this delivery.
 * @param processedMessageCount - Snapshots processed by this delivery.
 * @param reason - Secret-free retry reason.
 * @param retryAt - Earliest safe retry timestamp when known.
 * @returns Deferred secret-free result.
 */
function deferredResult(
  operationId: string,
  processedPageCount: number,
  processedMessageCount: number,
  reason: ExternalChatResyncWorkerStopReason,
  retryAt?: string,
): ExternalChatResyncWorkerResult {
  return {
    kind: 'deferred',
    operationId,
    processedPageCount,
    processedMessageCount,
    reason,
    ...(retryAt === undefined ? {} : { retryAt }),
  }
}

/**
 * Creates a non-retry worker stop result.
 *
 * @param operationId - Accepted operation identifier.
 * @param processedPageCount - Complete pages processed by this delivery.
 * @param processedMessageCount - Snapshots processed by this delivery.
 * @param reason - Secret-free stop reason.
 * @returns Stopped secret-free result.
 */
function stoppedResult(
  operationId: string,
  processedPageCount: number,
  processedMessageCount: number,
  reason: ExternalChatResyncWorkerStopReason,
): ExternalChatResyncWorkerResult {
  return { kind: 'stopped', operationId, processedPageCount, processedMessageCount, reason }
}
