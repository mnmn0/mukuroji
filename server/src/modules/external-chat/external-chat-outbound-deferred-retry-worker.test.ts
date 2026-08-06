import { EXTERNAL_CHAT_SCHEMA_VERSION, type ExternalChatSyncOutcome } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import {
  createExternalChatFingerprint,
  InMemoryExternalChatStore,
  type ExternalChatSyncCommentCreatedEvent,
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
    idempotencyKeyHash: 'worker-link-idempotency',
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
  await store.deferOutboundEvent({
    workspaceId: event.workspaceId,
    linkId: event.linkId,
    event,
    fingerprint: createExternalChatFingerprint(event),
    operationId,
    attempt,
    retryAt,
    createdAt,
    updatedAt: createdAt,
  })
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
  readonly releases: ExternalChatOutboundRetryConcurrencyInput[] = []

  /** Records and resolves one non-blocking permit attempt. */
  async acquire(input: ExternalChatOutboundRetryConcurrencyInput): Promise<boolean> {
    this.acquisitions.push(input)
    return this.available
  }

  /** Records one successful permit release. */
  async release(input: ExternalChatOutboundRetryConcurrencyInput): Promise<void> {
    this.releases.push(input)
  }
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

/** In-memory store that injects one active queue deletion failure after DLQ commit. */
class FailOnceOutboundDeleteStore extends InMemoryExternalChatStore {
  /** Whether the next outbound queue deletion should fail. */
  failNextOutboundDelete = true

  /** Fails once, then delegates exact identity deletion to the in-memory adapter. */
  override async deleteDeferredOutboundEvent(
    workspaceId: string,
    linkId: string,
    operationId: string,
  ): Promise<void> {
    if (this.failNextOutboundDelete) {
      this.failNextOutboundDelete = false
      throw new Error('Synthetic active queue deletion failure.')
    }
    await super.deleteDeferredOutboundEvent(workspaceId, linkId, operationId)
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

test('replays DLQ transfer idempotently after active queue deletion fails', async () => {
  const store = new FailOnceOutboundDeleteStore()
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
    'Synthetic active queue deletion failure.',
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
