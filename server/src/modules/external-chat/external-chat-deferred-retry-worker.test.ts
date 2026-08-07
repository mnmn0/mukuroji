import type {
  ExternalChatInboundEvent,
  ExternalChatSyncOutcome,
  ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import { EXTERNAL_CHAT_SCHEMA_VERSION } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import {
  createExternalChatFingerprint,
  ExternalChatError,
  InMemoryExternalChatStore,
} from './external-chat'
import {
  type ExternalChatDeferredInboundProcessorPort,
  ExternalChatDeferredRetryWorker,
} from './external-chat-deferred-retry-worker'

/** Stable deferred retry due timestamp. */
const DUE_AT = '2026-08-06T00:10:00.000Z'

/** Creates one normalized external message event at a deterministic occurrence time. */
function createEvent(eventId: string, minute: number): ExternalChatInboundEvent {
  const occurredAt = `2026-08-06T00:${String(minute).padStart(2, '0')}:00.000Z`
  return {
    schemaVersion: 1,
    type: 'message.created',
    eventId,
    correlationId: `correlation-${eventId}`,
    installationId: 'installation-1',
    provider: 'slack',
    externalWorkspaceId: 'workspace-external-1',
    conversationExternalId: 'conversation-external-1',
    threadExternalId: 'thread-external-1',
    occurredAt,
    message: {
      externalId: `message-${eventId}`,
      externalVersion: 'version-1',
      conversationExternalId: 'conversation-external-1',
      threadExternalId: 'thread-external-1',
      permalink: `https://chat.example.test/messages/${eventId}`,
      availability: 'available',
      state: 'active',
      bodyMarkdown: `Synthetic ${eventId}`,
      quotedRanges: [],
      attachments: [],
      postedAt: occurredAt,
      updatedAt: occurredAt,
    },
  }
}

/** Stores one synthetic due event in the in-memory persistence adapter. */
async function deferEvent(
  store: InMemoryExternalChatStore,
  event: ExternalChatInboundEvent,
  retryAt = event.occurredAt,
): Promise<void> {
  await seedActiveLink(store)
  await store.deferEvent({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    event,
    expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
    fingerprint: createExternalChatFingerprint(event),
    reason: 'out-of-order',
    attempt: 1,
    retryAt,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  })
}

/** Seeds the active link required for retaining non-lifecycle deferred content. */
async function seedActiveLink(store: InMemoryExternalChatStore): Promise<void> {
  const link: ExternalChatWorkItemLink = {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    id: 'link-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    installationId: 'installation-1',
    provider: 'slack',
    workspace: {
      provider: 'slack',
      externalId: 'workspace-external-1',
      displayName: 'Synthetic workspace',
    },
    conversation: {
      externalId: 'conversation-external-1',
      externalWorkspaceId: 'workspace-external-1',
      kind: 'channel',
      displayName: 'Synthetic conversation',
    },
    source: {
      externalWorkspaceId: 'workspace-external-1',
      conversationExternalId: 'conversation-external-1',
      threadExternalId: 'thread-external-1',
      rootMessageExternalId: 'root-message-1',
      sourcePermalink: 'https://chat.example.test/threads/thread-external-1',
    },
    syncDirection: 'bidirectional',
    syncStatus: 'synced',
    sourceAvailability: 'available',
    sourceState: 'active',
    revision: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
  }
  await store.createLink({
    workspaceId: 'workspace-1',
    link,
    authorizationRevision: 1,
    source: {
      provider: 'slack',
      externalWorkspaceId: 'workspace-external-1',
      conversationExternalId: 'conversation-external-1',
      threadExternalId: 'thread-external-1',
    },
    idempotencyKeyHash: createExternalChatFingerprint('deferred-worker-link'),
    requestFingerprint: createExternalChatFingerprint(link),
  })
}

/** Creates one applied terminal outcome for a synthetic event. */
function appliedOutcome(event: ExternalChatInboundEvent): ExternalChatSyncOutcome {
  return {
    kind: 'applied',
    operationId: `operation-${event.eventId}`,
    eventId: event.eventId,
    direction: 'inbound',
    occurredAt: event.occurredAt,
  }
}

/** Lists every retained test event from the strict FIFO head. */
async function listDueEventIds(store: InMemoryExternalChatStore): Promise<string[]> {
  const events = await store.listDeferredEvents(
    'workspace-1',
    'link-1',
    100,
  )
  return events.map((event) => event.event.eventId)
}

test('removes terminal outcomes and continues in deterministic FIFO order', async () => {
  const store = new InMemoryExternalChatStore()
  const events = [createEvent('event-3', 3), createEvent('event-1', 1), createEvent('event-2', 2)]
  for (const event of events) await deferEvent(store, event)
  const processed: string[] = []
  const originMarkerPresence: boolean[] = []
  const processor: ExternalChatDeferredInboundProcessorPort = {
    async processInbound(input) {
      processed.push(input.event.eventId)
      originMarkerPresence.push(Object.hasOwn(input, 'originMarker'))
      if (input.event.eventId === 'event-2') {
        return {
          kind: 'skipped',
          operationId: 'operation-event-2',
          eventId: 'event-2',
          reason: 'stale',
          occurredAt: input.event.occurredAt,
        }
      }
      if (input.event.eventId === 'event-3') {
        return {
          kind: 'failed',
          operationId: 'operation-event-3',
          eventId: 'event-3',
          errorCode: 'ExternalChatInvalidMutation',
          retryable: false,
          occurredAt: input.event.occurredAt,
        }
      }
      return appliedOutcome(input.event)
    },
  }
  const worker = new ExternalChatDeferredRetryWorker({ store, processor })

  const result = await worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 10,
  })

  expect(processed).toEqual(['event-1', 'event-2', 'event-3'])
  expect(originMarkerPresence).toEqual([false, false, false])
  expect(result).toMatchObject({
    attemptedEventCount: 3,
    removedEventCount: 3,
    stopReason: 'batch-complete',
  })
  expect(await listDueEventIds(store)).toEqual([])
})

test('stops at a still-deferred FIFO head and retains it and later events', async () => {
  const store = new InMemoryExternalChatStore()
  const events = [createEvent('event-1', 1), createEvent('event-2', 2), createEvent('event-3', 3)]
  for (const event of events) await deferEvent(store, event)
  const processed: string[] = []
  const processor: ExternalChatDeferredInboundProcessorPort = {
    async processInbound(input) {
      processed.push(input.event.eventId)
      if (input.event.eventId === 'event-2') {
        return {
          kind: 'deferred',
          operationId: 'operation-event-2',
          eventId: 'event-2',
          reason: 'out-of-order',
          retryAt: DUE_AT,
          occurredAt: input.event.occurredAt,
        }
      }
      return appliedOutcome(input.event)
    },
  }
  const worker = new ExternalChatDeferredRetryWorker({ store, processor })

  const result = await worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 10,
  })

  expect(processed).toEqual(['event-1', 'event-2'])
  expect(result).toMatchObject({
    attemptedEventCount: 2,
    removedEventCount: 1,
    stopReason: 'deferred',
  })
  expect(await listDueEventIds(store)).toEqual(['event-2', 'event-3'])
})

test('does not overtake a non-due inbound FIFO head with a later due event', async () => {
  const store = new InMemoryExternalChatStore()
  await deferEvent(
    store,
    createEvent('event-head', 1),
    '2026-08-06T00:20:00.000Z',
  )
  await deferEvent(store, createEvent('event-later', 2), DUE_AT)
  const processed: string[] = []
  const worker = new ExternalChatDeferredRetryWorker({
    store,
    processor: {
      async processInbound(input) {
        processed.push(input.event.eventId)
        return appliedOutcome(input.event)
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
    removedEventCount: 0,
    stopReason: 'not-due',
  })
  expect(processed).toEqual([])
  expect(await listDueEventIds(store)).toEqual(['event-head', 'event-later'])
})

test('stops without deleting a retryable failed outcome', async () => {
  const store = new InMemoryExternalChatStore()
  await deferEvent(store, createEvent('event-1', 1))
  await deferEvent(store, createEvent('event-2', 2))
  const processed: string[] = []
  const processor: ExternalChatDeferredInboundProcessorPort = {
    async processInbound(input) {
      processed.push(input.event.eventId)
      return {
        kind: 'failed',
        operationId: `operation-${input.event.eventId}`,
        eventId: input.event.eventId,
        errorCode: 'ChatProviderTransientFailure',
        retryable: true,
        occurredAt: input.event.occurredAt,
      }
    },
  }
  const worker = new ExternalChatDeferredRetryWorker({ store, processor })

  const result = await worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 10,
  })

  expect(processed).toEqual(['event-1'])
  expect(result).toMatchObject({
    attemptedEventCount: 1,
    removedEventCount: 0,
    stopReason: 'retryable-failure',
  })
  expect(await listDueEventIds(store)).toEqual(['event-1', 'event-2'])
})

test('stops without deleting when another processor owns the receipt lease', async () => {
  const store = new InMemoryExternalChatStore()
  await deferEvent(store, createEvent('event-1', 1))
  const processor: ExternalChatDeferredInboundProcessorPort = {
    async processInbound() {
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'Another processor owns the receipt lease.',
        true,
      )
    },
  }
  const worker = new ExternalChatDeferredRetryWorker({ store, processor })

  const result = await worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 10,
  })

  expect(result).toEqual({
    attemptedEventCount: 1,
    removedEventCount: 0,
    outcomes: [],
    stopReason: 'busy',
  })
  expect(await listDueEventIds(store)).toEqual(['event-1'])
})

test('honors the bounded batch limit and validates worker input', async () => {
  const store = new InMemoryExternalChatStore()
  await deferEvent(store, createEvent('event-1', 1))
  await deferEvent(store, createEvent('event-2', 2))
  const processor: ExternalChatDeferredInboundProcessorPort = {
    async processInbound(input) {
      return appliedOutcome(input.event)
    },
  }
  const worker = new ExternalChatDeferredRetryWorker({ store, processor })

  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 1,
  })).resolves.toMatchObject({
    attemptedEventCount: 1,
    removedEventCount: 1,
    stopReason: 'batch-complete',
  })
  expect(await listDueEventIds(store)).toEqual(['event-2'])
  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: DUE_AT,
    limit: 0,
  })).rejects.toMatchObject({
    code: 'ExternalChatValidationFailed',
  })
  await expect(worker.processDueBatch({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    dueAt: '2026-08-06T09:10:00.000+09:00',
    limit: 1,
  })).rejects.toMatchObject({
    code: 'ExternalChatValidationFailed',
  })
})
