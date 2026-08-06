import { EXTERNAL_CHAT_SCHEMA_VERSION, type ExternalChatSyncOutcome } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import {
  createExternalChatFingerprint,
  type DeadLetterExternalChatOutboundOperationInput,
  type ExternalChatOutboundRetryPermit,
  InMemoryExternalChatStore,
  type ReleaseExternalChatOutboundRetryPermitInput,
  type RenewExternalChatOutboundRetryPermitInput,
  type ExternalChatSyncCommentCreatedEvent,
  type ValidateExternalChatOutboundRetryPermitInput,
} from './external-chat'
import {
  type ExternalChatOutboundDeadLetterInput,
  type ExternalChatOutboundRetryConcurrencyInput,
  ExternalChatOutboundDeferredRetryWorker,
} from './external-chat-outbound-deferred-retry-worker'

/** Stable worker clock used by focused FIFO tests. */
const DUE_AT = '2026-08-06T00:10:00.000Z'

/** Creates and stores the active link required by the outbound worker concurrency scope. */
async function seedLink(store: InMemoryExternalChatStore): Promise<void> {
  const link = {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    id: 'link-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    installationId: 'installation-1',
    provider: 'slack',
    workspace: {
      provider: 'slack',
      externalId: 'workspace-external-1',
    },
    conversation: {
      externalId: 'conversation-external-1',
      externalWorkspaceId: 'workspace-external-1',
      kind: 'channel',
    },
    source: {
      externalWorkspaceId: 'workspace-external-1',
      conversationExternalId: 'conversation-external-1',
      threadExternalId: 'thread-external-1',
      rootMessageExternalId: 'message-root-1',
    },
    syncDirection: 'bidirectional',
    syncStatus: 'pending',
    sourceAvailability: 'available',
    sourceState: 'active',
    revision: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
  } satisfies Parameters<InMemoryExternalChatStore['createLink']>[0]['link']
  await store.createLink({
    workspaceId: 'workspace-1',
    link,
    authorizationRevision: 1,
    source: {
      provider: 'slack',
      externalWorkspaceId: link.source.externalWorkspaceId,
      conversationExternalId: link.source.conversationExternalId,
      threadExternalId: link.source.threadExternalId,
    },
    idempotencyKeyHash: createExternalChatFingerprint('worker-link-idempotency'),
    requestFingerprint: createExternalChatFingerprint(link),
  })
}

/** Creates one deterministic internal comment event. */
function createOutboundEvent(
  suffix: string,
  occurredAt: string,
): ExternalChatSyncCommentCreatedEvent {
  return {
    type: 'comment.created',
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    principalId: 'principal-1',
    correlationId: `correlation-${suffix}`,
    occurredAt,
    externalSyncEligible: true,
    internalCommentId: `comment-${suffix}`,
    internalCommentVersion: 1,
    bodyMarkdown: `Synthetic ${suffix}`,
  }
}

/** Stores one outbound mutation with an explicit retry policy state. */
async function deferOutbound(
  store: InMemoryExternalChatStore,
  event: ExternalChatSyncCommentCreatedEvent,
  operationId: string,
  retryAt: string,
  attempt = 1,
  createdAt = '2026-08-06T00:00:00.000Z',
): Promise<void> {
  const fingerprint = createExternalChatFingerprint(event)
  await store.deferOutboundEvent({
    workspaceId: event.workspaceId,
    linkId: event.linkId,
    event,
    fingerprint,
    operationId,
    attempt,
    retryAt,
    ownerTeamId: 'team-1',
    ownerWorkItemId: 'work-item-1',
    ownerLinkRevision: 1,
    expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
    createdAt,
    updatedAt: createdAt,
  })
  for (let currentAttempt = 1; currentAttempt <= attempt; currentAttempt += 1) {
    const claim = await store.claimOutboundOperation({
      workspaceId: event.workspaceId,
      linkId: event.linkId,
      operationId,
      fingerprint,
      claimedAt: retryAt,
      leaseExpiresAt: '2026-08-06T01:00:00.000Z',
    })
    if (claim.kind !== (currentAttempt === 1 ? 'claimed' : 'resumed')) {
      throw new Error(`Expected retry receipt attempt ${currentAttempt} to be claimed.`)
    }
    const completed = await store.completeOutboundOperation({
      workspaceId: event.workspaceId,
      linkId: event.linkId,
      operationId,
      expectedAttempt: currentAttempt,
      outcome: {
        kind: 'deferred',
        operationId,
        reason: 'rate-limited',
        retryAt,
        occurredAt: retryAt,
      },
      completedAt: retryAt,
    })
    if (!completed) throw new Error(`Expected retry receipt attempt ${currentAttempt} to complete.`)
  }
}

/** Creates one applied outcome for a worker event. */
function applied(operationId: string, occurredAt: string): ExternalChatSyncOutcome {
  return {
    kind: 'applied',
    operationId,
    direction: 'outbound',
    occurredAt,
  }
}

/** In-memory installation concurrency gate used by focused worker tests. */
class RecordingConcurrencyGate {
  /** Whether the next permit may be acquired. */
  available = true

  /** Successful and rejected acquisition attempts. */
  readonly acquisitions: ExternalChatOutboundRetryConcurrencyInput[] = []

  /** Released permit scopes. */
  readonly releases: ReleaseExternalChatOutboundRetryPermitInput[] = []

  /** Permit renewal attempts. */
  readonly renewals: RenewExternalChatOutboundRetryPermitInput[] = []

  /** Permit validations immediately preceding provider calls. */
  readonly validations: ValidateExternalChatOutboundRetryPermitInput[] = []

  /** One-based renewal number that should simulate losing ownership. */
  loseOnRenewalNumber?: number

  /** One-based renewal number that should raise a synthetic persistence failure. */
  throwOnRenewalNumber?: number

  /** One-based validation number that should raise a synthetic persistence failure. */
  throwOnValidationNumber?: number

  /** Latest exact permit owned by this synthetic gate. */
  private current?: ExternalChatOutboundRetryPermit

  /** Next monotonic fencing token issued by this synthetic gate. */
  private nextFenceToken = 1

  /** Records and resolves one non-blocking permit attempt. */
  async acquireOutboundRetryPermit(
    input: ExternalChatOutboundRetryConcurrencyInput,
  ): Promise<ExternalChatOutboundRetryPermit | undefined> {
    this.acquisitions.push(input)
    if (!this.available) return undefined
    const permit: ExternalChatOutboundRetryPermit = {
      workspaceId: input.workspaceId,
      provider: input.provider,
      installationId: input.installationId,
      ownerId: input.ownerId,
      fenceToken: this.nextFenceToken,
      acquiredAt: input.acquiredAt,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.acquiredAt,
    }
    this.nextFenceToken += 1
    this.current = permit
    return permit
  }

  /** Renews the current exact permit unless the test requested simulated lease loss. */
  async renewOutboundRetryPermit(
    input: RenewExternalChatOutboundRetryPermitInput,
  ): Promise<ExternalChatOutboundRetryPermit | undefined> {
    this.renewals.push(input)
    if (this.throwOnRenewalNumber === this.renewals.length) {
      throw new Error('Synthetic outbound retry permit renewal failure.')
    }
    if (
      this.loseOnRenewalNumber === this.renewals.length ||
      !this.current ||
      !samePermit(this.current, input.permit)
    ) return undefined
    const renewed: ExternalChatOutboundRetryPermit = {
      ...input.permit,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.renewedAt,
    }
    this.current = renewed
    return renewed
  }

  /** Validates the exact current permit and its exclusive expiry. */
  async validateOutboundRetryPermit(
    input: ValidateExternalChatOutboundRetryPermitInput,
  ): Promise<boolean> {
    this.validations.push(input)
    if (this.throwOnValidationNumber === this.validations.length) {
      throw new Error('Synthetic outbound retry permit validation failure.')
    }
    return this.current !== undefined &&
      samePermit(this.current, input.permit) &&
      this.current.leaseExpiresAt > input.checkedAt
  }

  /** Records one successful exact permit release. */
  async releaseOutboundRetryPermit(
    input: ReleaseExternalChatOutboundRetryPermitInput,
  ): Promise<boolean> {
    this.releases.push(input)
    if (!this.current || !samePermit(this.current, input.permit)) return false
    this.current = undefined
    return true
  }
}

/** Deterministic abort-aware heartbeat scheduler used to hold a provider call open. */
class ControlledHeartbeat {
  /** Delays requested by the worker in registration order. */
  readonly delays: number[] = []

  /** Pending heartbeat completions controlled by the test. */
  private readonly completions: Array<() => void> = []

  /** Resolves when the first heartbeat wait has been registered. */
  readonly firstWaitObserved: Promise<void>

  /** Resolver for the first registered heartbeat wait. */
  private observeFirstWait?: () => void

  /** Creates one deterministic heartbeat scheduler. */
  constructor() {
    this.firstWaitObserved = new Promise((resolve) => {
      this.observeFirstWait = resolve
    })
  }

  /** Registers one wait that settles only when elapsed or aborted. */
  async wait(delayMs: number, signal: AbortSignal): Promise<void> {
    this.delays.push(delayMs)
    this.observeFirstWait?.()
    this.observeFirstWait = undefined
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', finish)
        resolve()
      }
      this.completions.push(finish)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }

  /** Elapses the oldest pending heartbeat wait. */
  elapseNext(): void {
    const complete = this.completions.shift()
    if (!complete) throw new Error('Expected one pending outbound retry heartbeat.')
    complete()
  }
}

/** Heartbeat scheduler that fails immediately to exercise monitor exception fencing. */
class ThrowingHeartbeat {
  /** Raises one synthetic scheduler failure instead of waiting. */
  async wait(_delayMs: number, _signal: AbortSignal): Promise<void> {
    throw new Error('Synthetic outbound retry heartbeat failure.')
  }
}

/** Heartbeat scheduler that fails one microtask after an immediate processor can settle. */
class DelayedThrowingHeartbeat {
  /** Yields once, then raises a synthetic scheduler failure. */
  async wait(_delayMs: number, _signal: AbortSignal): Promise<void> {
    await Promise.resolve()
    throw new Error('Synthetic delayed outbound retry heartbeat failure.')
  }
}

/** Compares every exact synthetic permit capability field. */
function samePermit(
  left: ExternalChatOutboundRetryPermit,
  right: ExternalChatOutboundRetryPermit,
): boolean {
  return left.workspaceId === right.workspaceId &&
    left.provider === right.provider &&
    left.installationId === right.installationId &&
    left.ownerId === right.ownerId &&
    left.fenceToken === right.fenceToken &&
    left.acquiredAt === right.acquiredAt &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    left.updatedAt === right.updatedAt
}

/** In-memory DLQ that retains exact exhausted worker inputs. */
class RecordingDeadLetterPort {
  /** Exhausted entries transferred before active queue deletion. */
  readonly inputs: ExternalChatOutboundDeadLetterInput[] = []

  /** Total enqueue attempts, including idempotent replays. */
  enqueueAttemptCount = 0

  /** Idempotently records one exhausted durable mutation by operation and reason. */
  async enqueue(input: ExternalChatOutboundDeadLetterInput): Promise<void> {
    this.enqueueAttemptCount += 1
    if (this.inputs.some((current) =>
      current.deferred.operationId === input.deferred.operationId &&
      current.reason === input.reason
    )) return
    this.inputs.push(input)
  }
}

/** In-memory store that injects one atomic DLQ transition failure after DLQ commit. */
class FailOnceOutboundDeadLetterStore extends InMemoryExternalChatStore {
  /** Whether the next outbound dead-letter transition should fail. */
  failNextOutboundDeadLetter = true

  /** Fails once, then delegates atomic terminalization to the in-memory adapter. */
  override async deadLetterOutboundOperation(
    input: DeadLetterExternalChatOutboundOperationInput,
  ): Promise<boolean> {
    if (this.failNextOutboundDeadLetter) {
      this.failNextOutboundDeadLetter = false
      throw new Error('Synthetic outbound dead-letter transition failure.')
    }
    return await super.deadLetterOutboundOperation(input)
  }
}

test('processes terminal FIFO entries and stops at a deferred head', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  const first = createOutboundEvent('first', '2026-08-06T00:01:00.000Z')
  const second = createOutboundEvent('second', '2026-08-06T00:02:00.000Z')
  await deferOutbound(store, first, 'operation-first', DUE_AT)
  await deferOutbound(store, second, 'operation-second', DUE_AT)
  const processed: string[] = []
  const gate = new RecordingConcurrencyGate()
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    processor: {
      async processOutbound(event) {
        processed.push(event.correlationId)
        return event.correlationId === 'correlation-first'
          ? applied('operation-first', DUE_AT)
          : {
            kind: 'deferred',
            operationId: 'operation-second',
            reason: 'rate-limited',
            retryAt: '2026-08-06T00:20:00.000Z',
            occurredAt: DUE_AT,
          }
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 10,
  })).resolves.toMatchObject({
    attemptedEventCount: 2,
    removedEventCount: 1,
    deadLetteredEventCount: 0,
    stopReason: 'deferred',
  })
  expect(processed).toEqual(['correlation-first', 'correlation-second'])
  expect((await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10))
    .map((entry) => entry.operationId)).toEqual(['operation-second'])
  expect(gate.acquisitions[0]).toMatchObject({
    provider: 'slack',
    installationId: 'installation-1',
  })
  expect(gate.renewals).toHaveLength(2)
  expect(gate.validations).toHaveLength(2)
  expect(gate.releases).toHaveLength(1)
})

test('does not skip a not-yet-due FIFO head for a later due entry', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('head', '2026-08-06T00:01:00.000Z'),
    'operation-head',
    '2026-08-06T00:20:00.000Z',
  )
  await deferOutbound(
    store,
    createOutboundEvent('later', '2026-08-06T00:02:00.000Z'),
    'operation-later',
    DUE_AT,
  )
  const gate = new RecordingConcurrencyGate()
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    processor: {
      async processOutbound() {
        throw new Error('The not-due FIFO must not reach the processor.')
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 10,
  })).resolves.toMatchObject({ attemptedEventCount: 0, stopReason: 'not-due' })
  expect(gate.acquisitions).toHaveLength(0)
})

test('dead-letters maximum-attempt and maximum-age entries before continuing', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('attempts', '2026-08-06T00:01:00.000Z'),
    'operation-attempts',
    DUE_AT,
    3,
  )
  await deferOutbound(
    store,
    createOutboundEvent('age', '2026-08-06T00:02:00.000Z'),
    'operation-age',
    DUE_AT,
    1,
    '2026-08-05T23:00:00.000Z',
  )
  const deadLetter = new RecordingDeadLetterPort()
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: new RecordingConcurrencyGate(),
    deadLetter,
    options: { maxAttempts: 3, maxAgeMs: 30 * 60 * 1_000 },
    processor: {
      async processOutbound() {
        throw new Error('Exhausted entries must not reach outbound synchronization.')
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 10,
  })).resolves.toMatchObject({
    attemptedEventCount: 0,
    removedEventCount: 2,
    deadLetteredEventCount: 2,
    stopReason: 'batch-complete',
  })
  expect(deadLetter.inputs.map((input) => input.reason)).toEqual(['max-attempts', 'max-age'])
  expect(await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10)).toEqual([])
  const terminal = deadLetter.inputs[0]?.deferred
  if (!terminal) throw new Error('Expected one terminal outbound retry fixture.')
  await expect(store.claimOutboundOperation({
    workspaceId: terminal.workspaceId,
    linkId: terminal.linkId,
    operationId: terminal.operationId,
    fingerprint: terminal.fingerprint,
    claimedAt: '2026-08-06T00:11:00.000Z',
    leaseExpiresAt: '2026-08-06T00:12:00.000Z',
  })).resolves.toMatchObject({
    kind: 'duplicate',
    receipt: {
      state: 'dead-lettered',
      deadLetterReason: 'max-attempts',
      outcome: {
        kind: 'failed',
        errorCode: 'ExternalChatRetryExhausted',
        retryable: false,
      },
    },
  })
})

test('reconciles an expired newer receipt attempt before dead-lettering the queue head', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  const event = createOutboundEvent('receipt-ahead', '2026-08-06T00:01:00.000Z')
  await deferOutbound(store, event, 'operation-receipt-ahead', DUE_AT, 3)
  const fingerprint = createExternalChatFingerprint(event)
  await expect(store.claimOutboundOperation({
    workspaceId: event.workspaceId,
    linkId: event.linkId,
    operationId: 'operation-receipt-ahead',
    fingerprint,
    claimedAt: '2026-08-06T00:10:01.000Z',
    leaseExpiresAt: '2026-08-06T00:10:02.000Z',
  })).resolves.toMatchObject({
    kind: 'resumed',
    receipt: { attempt: 4, state: 'processing' },
  })
  const deadLetter = new RecordingDeadLetterPort()
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: new RecordingConcurrencyGate(),
    deadLetter,
    options: { maxAttempts: 3 },
    processor: {
      async processOutbound() {
        throw new Error('An exhausted mismatched entry must not reach synchronization.')
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: '2026-08-06T00:11:00.000Z',
    limit: 1,
  })).resolves.toMatchObject({
    attemptedEventCount: 0,
    removedEventCount: 1,
    deadLetteredEventCount: 1,
    stopReason: 'batch-complete',
  })
  expect(deadLetter.inputs).toHaveLength(1)
  expect(deadLetter.inputs[0]?.deferred.attempt).toBe(4)
  expect(await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10)).toEqual([])
})

test('stops before the next provider call when its renewed fence is lost', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('lease-first', '2026-08-06T00:01:00.000Z'),
    'operation-lease-first',
    DUE_AT,
  )
  await deferOutbound(
    store,
    createOutboundEvent('lease-second', '2026-08-06T00:02:00.000Z'),
    'operation-lease-second',
    DUE_AT,
  )
  const gate = new RecordingConcurrencyGate()
  gate.loseOnRenewalNumber = 2
  const processed: string[] = []
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    processor: {
      async processOutbound(event) {
        processed.push(event.correlationId)
        return applied('operation-lease-first', DUE_AT)
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 10,
  })).resolves.toMatchObject({
    attemptedEventCount: 1,
    removedEventCount: 1,
    stopReason: 'lease-lost',
  })
  expect(processed).toEqual(['correlation-lease-first'])
  expect((await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10))
    .map((entry) => entry.operationId)).toEqual(['operation-lease-second'])
  expect(gate.releases).toHaveLength(1)
})

test('aborts an in-flight provider call when its permit heartbeat loses the fence', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('heartbeat-loss', '2026-08-06T00:01:00.000Z'),
    'operation-heartbeat-loss',
    DUE_AT,
  )
  const gate = new RecordingConcurrencyGate()
  gate.loseOnRenewalNumber = 2
  const heartbeat = new ControlledHeartbeat()
  let abortObserved = false
  let observeProcessorStart: (() => void) | undefined
  const processorStarted = new Promise<void>((resolve) => {
    observeProcessorStart = resolve
  })
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    heartbeat,
    options: { gateLeaseMs: 90 },
    processor: {
      async processOutbound(_event, context) {
        observeProcessorStart?.()
        await new Promise<void>((resolve) => {
          const observeAbort = (): void => {
            abortObserved = true
            resolve()
          }
          context.signal.addEventListener('abort', observeAbort, { once: true })
          if (context.signal.aborted) observeAbort()
        })
        return applied('operation-heartbeat-loss', DUE_AT)
      },
    },
  })

  const processing = worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  })
  await Promise.all([processorStarted, heartbeat.firstWaitObserved])
  heartbeat.elapseNext()

  await expect(processing).resolves.toMatchObject({
    attemptedEventCount: 1,
    removedEventCount: 0,
    stopReason: 'lease-lost',
  })
  expect(abortObserved).toBe(true)
  expect(heartbeat.delays).toEqual([30])
  expect(gate.renewals).toHaveLength(2)
  expect(await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10))
    .toHaveLength(1)
})

test('aborts and awaits provider settlement when the heartbeat scheduler throws', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('heartbeat-error', '2026-08-06T00:01:00.000Z'),
    'operation-heartbeat-error',
    DUE_AT,
  )
  const gate = new RecordingConcurrencyGate()
  let abortObserved = false
  let processorSettled = false
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    heartbeat: new ThrowingHeartbeat(),
    processor: {
      async processOutbound(_event, context) {
        await new Promise<void>((resolve) => {
          const observeAbort = (): void => {
            abortObserved = true
            resolve()
          }
          context.signal.addEventListener('abort', observeAbort, { once: true })
          if (context.signal.aborted) observeAbort()
        })
        processorSettled = true
        return applied('operation-heartbeat-error', DUE_AT)
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  })).resolves.toMatchObject({
    attemptedEventCount: 1,
    removedEventCount: 0,
    stopReason: 'lease-lost',
  })
  expect(abortObserved).toBe(true)
  expect(processorSettled).toBe(true)
  expect(gate.releases).toHaveLength(1)
})

test('keeps the deferred row when a delayed heartbeat error follows processor success', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('post-settlement-heartbeat-error', '2026-08-06T00:01:00.000Z'),
    'operation-post-settlement-heartbeat-error',
    DUE_AT,
  )
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: new RecordingConcurrencyGate(),
    deadLetter: new RecordingDeadLetterPort(),
    heartbeat: new DelayedThrowingHeartbeat(),
    processor: {
      async processOutbound() {
        return applied('operation-post-settlement-heartbeat-error', DUE_AT)
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  })).resolves.toMatchObject({
    attemptedEventCount: 1,
    removedEventCount: 0,
    stopReason: 'lease-lost',
  })
  expect(await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10))
    .toHaveLength(1)
})

test('aborts and awaits provider settlement when permit renewal throws', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('renewal-error', '2026-08-06T00:01:00.000Z'),
    'operation-renewal-error',
    DUE_AT,
  )
  const gate = new RecordingConcurrencyGate()
  gate.throwOnRenewalNumber = 2
  const heartbeat = new ControlledHeartbeat()
  let processorSettled = false
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    heartbeat,
    options: { gateLeaseMs: 90 },
    processor: {
      async processOutbound(_event, context) {
        await new Promise<void>((resolve) => {
          const observeAbort = (): void => resolve()
          context.signal.addEventListener('abort', observeAbort, { once: true })
          if (context.signal.aborted) observeAbort()
        })
        processorSettled = true
        return applied('operation-renewal-error', DUE_AT)
      },
    },
  })

  const processing = worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  })
  await heartbeat.firstWaitObserved
  heartbeat.elapseNext()

  await expect(processing).resolves.toMatchObject({
    attemptedEventCount: 1,
    removedEventCount: 0,
    stopReason: 'lease-lost',
  })
  expect(processorSettled).toBe(true)
  expect(gate.releases).toHaveLength(1)
})

test('revalidates the exact permit at the processor side-effect boundary', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('side-effect-guard', '2026-08-06T00:01:00.000Z'),
    'operation-side-effect-guard',
    DUE_AT,
  )
  const gate = new RecordingConcurrencyGate()
  gate.throwOnValidationNumber = 2
  let abortObserved = false
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    processor: {
      async processOutbound(_event, context) {
        context.signal.addEventListener('abort', () => {
          abortObserved = true
        }, { once: true })
        await context.assertCurrentPermit()
        throw new Error('A lost permit must not cross the provider side-effect boundary.')
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  })).resolves.toMatchObject({
    attemptedEventCount: 1,
    removedEventCount: 0,
    stopReason: 'lease-lost',
  })
  expect(abortObserved).toBe(true)
  expect(gate.validations).toHaveLength(2)
  expect(gate.releases).toHaveLength(1)
})

test('uses a unique owner and advancing fence for every worker attempt', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('unique-owner', '2026-08-06T00:01:00.000Z'),
    'operation-unique-owner',
    DUE_AT,
  )
  const gate = new RecordingConcurrencyGate()
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    processor: {
      async processOutbound() {
        return {
          kind: 'deferred',
          operationId: 'operation-unique-owner',
          reason: 'rate-limited',
          retryAt: '2026-08-06T00:20:00.000Z',
          occurredAt: DUE_AT,
        }
      },
    },
  })
  const batch = {
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  }

  expect((await worker.processDueBatch(batch)).stopReason).toBe('deferred')
  expect((await worker.processDueBatch(batch)).stopReason).toBe('deferred')
  expect(gate.acquisitions).toHaveLength(2)
  expect(gate.acquisitions[0]?.ownerId).not.toBe(gate.acquisitions[1]?.ownerId)
  expect(gate.releases.map((release) => release.permit.fenceToken)).toEqual([1, 2])
})

test('stops without processing when the installation concurrency gate is busy', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('busy', '2026-08-06T00:01:00.000Z'),
    'operation-busy',
    DUE_AT,
  )
  const gate = new RecordingConcurrencyGate()
  gate.available = false
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: gate,
    deadLetter: new RecordingDeadLetterPort(),
    processor: {
      async processOutbound() {
        throw new Error('A busy installation must not reach outbound synchronization.')
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  })).resolves.toMatchObject({ attemptedEventCount: 0, stopReason: 'installation-busy' })
  expect(gate.releases).toHaveLength(0)
  expect(await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10))
    .toHaveLength(1)
})

test('replays DLQ transfer idempotently after atomic terminalization fails', async () => {
  const store = new FailOnceOutboundDeadLetterStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('dlq-replay', '2026-08-06T00:01:00.000Z'),
    'operation-dlq-replay',
    DUE_AT,
    3,
  )
  const deadLetter = new RecordingDeadLetterPort()
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: new RecordingConcurrencyGate(),
    deadLetter,
    options: { maxAttempts: 3 },
    processor: {
      async processOutbound() {
        throw new Error('An exhausted entry must not reach outbound synchronization.')
      },
    },
  })
  const batch = {
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  }

  await expect(worker.processDueBatch(batch)).rejects.toThrow(
    'Synthetic outbound dead-letter transition failure.',
  )
  expect(deadLetter.inputs).toHaveLength(1)
  expect(await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10))
    .toHaveLength(1)

  await expect(worker.processDueBatch(batch)).resolves.toMatchObject({
    removedEventCount: 1,
    deadLetteredEventCount: 1,
    stopReason: 'batch-complete',
  })
  expect(deadLetter.enqueueAttemptCount).toBe(2)
  expect(deadLetter.inputs).toHaveLength(1)
  expect(await store.listDeferredOutboundEvents('workspace-1', 'link-1', 10)).toEqual([])
})

test('rejects parseable but noncanonical worker and queue timestamps', async () => {
  const store = new InMemoryExternalChatStore()
  await seedLink(store)
  await deferOutbound(
    store,
    createOutboundEvent('noncanonical', '2026-08-06T00:01:00.000Z'),
    'operation-noncanonical',
    '2026-08-06T00:10:00Z',
  )
  const worker = new ExternalChatOutboundDeferredRetryWorker({
    store,
    concurrency: new RecordingConcurrencyGate(),
    deadLetter: new RecordingDeadLetterPort(),
    processor: {
      async processOutbound() {
        throw new Error('An invalid schedule must not reach outbound synchronization.')
      },
    },
  })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: '2026-08-06T00:10:00Z',
    limit: 1,
  })).rejects.toMatchObject({ code: 'ExternalChatValidationFailed' })
  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  })).rejects.toMatchObject({ code: 'ExternalChatValidationFailed' })
})
