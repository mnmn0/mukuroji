import { expect, test } from 'bun:test'
import type {
  ExternalChatMessage,
  ExternalChatSyncOutcome,
  ExternalChatThreadSnapshot,
  ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import type {
  ChatProviderAuthorization,
  ChatProviderDefinition,
  ChatProviderNormalizedWebhook,
  ChatProviderThreadMutationResult,
  ChatProviderThreadPage,
  ChatProviderWebhookRequest,
  CreateChatProviderReplyInput,
  DeleteChatProviderMessageInput,
  EditChatProviderMessageInput,
  ReadChatProviderThreadPageInput,
  SetChatProviderThreadCompletionInput,
} from './chat-provider-adapter'
import {
  ChatProviderAdapterError,
  ChatProviderAdapterRegistry,
  type ChatProviderAdapter,
} from './chat-provider-adapter'
import { InMemoryExternalChatStore } from './external-chat'
import type { ExternalChatResyncJob } from './external-chat-link-service'
import {
  ExternalChatResyncWorker,
  type ExternalChatResyncSnapshotProcessorPort,
} from './external-chat-resync-worker'
import type {
  ExternalChatSyncAccessPort,
  ExternalChatSyncClockPort,
  ExternalChatSyncInboundInput,
} from './external-chat-sync-service'

const NOW = '2026-08-06T06:00:00.000Z'
const LATER = '2026-08-06T06:01:00.000Z'

test('full resync processes multiple pages chronologically and hides provider cursors', async () => {
  const firstPage = createPage([createMessage('message-1', 1), createMessage('message-2', 2)], 'page-2')
  const secondPage = createPage([createMessage('message-3', 3)])
  const fixture = await createFixture(new FakeProvider([
    { page: firstPage },
    { cursor: 'page-2', page: secondPage },
  ]))

  const result = await fixture.worker.process(createJob('operation-full', 'full'))

  expect(result).toEqual({
    kind: 'completed',
    operationId: 'operation-full',
    processedPageCount: 2,
    processedMessageCount: 3,
  })
  expect(result).not.toHaveProperty('providerCursor')
  expect(fixture.processor.messageIds()).toEqual(['message-1', 'message-2', 'message-3'])
  expect(fixture.provider.requestedCursors).toEqual([undefined, 'page-2'])
  expect(await fixture.store.getSyncCursor('workspace-1', 'link-1')).toMatchObject({
    operationId: 'operation-full',
    status: 'completed',
    ownerLinkRevision: 2,
    revision: 3,
  })
  expect((await fixture.store.getLink('workspace-1', 'link-1'))?.link).toMatchObject({
    syncStatus: 'synced',
    revision: 3,
  })
})

test('resume carries only an interrupted private continuation', async () => {
  const provider = new FakeProvider([
    { cursor: 'page-2', page: createPage([createMessage('message-2', 2)]) },
  ])
  const fixture = await createFixture(provider)
  await fixture.store.putSyncCursor('workspace-1', {
    schemaVersion: 1,
    linkId: 'link-1',
    provider: 'slack',
    operationId: 'operation-interrupted',
    mode: 'full',
    status: 'processing',
    ownerLinkRevision: 1,
    providerCursor: 'page-2',
    revision: 1,
    lastEventId: 'event-message-1',
    lastEventAt: createMessage('message-1', 1).postedAt,
    updatedAt: NOW,
  })

  const result = await fixture.worker.process(createJob('operation-resume', 'resume'))

  expect(result.kind).toBe('completed')
  expect(provider.requestedCursors).toEqual(['page-2'])
  expect(fixture.processor.messageIds()).toEqual(['message-2'])
  expect(await fixture.store.getSyncCursor('workspace-1', 'link-1')).toMatchObject({
    operationId: 'operation-resume',
    mode: 'resume',
    status: 'completed',
    lastEventId: expect.stringMatching(/^resync-/u),
  })
})

test('resume after a completed operation restarts traversal and observes new snapshots', async () => {
  const provider = new FakeProvider([
    { page: createPage([createMessage('message-new', 4)]) },
  ])
  const fixture = await createFixture(provider)
  await fixture.store.putSyncCursor('workspace-1', {
    schemaVersion: 1,
    linkId: 'link-1',
    provider: 'slack',
    operationId: 'operation-completed',
    mode: 'full',
    status: 'completed',
    ownerLinkRevision: 1,
    observedSourceAvailability: 'available',
    observedSourceState: 'active',
    completionSyncStatus: 'synced',
    revision: 1,
    lastEventId: 'event-old',
    lastEventAt: createMessage('message-old', 3).postedAt,
    updatedAt: NOW,
  })

  const result = await fixture.worker.process(createJob('operation-resume-new', 'resume'))

  expect(result.kind).toBe('completed')
  expect(provider.requestedCursors).toEqual([undefined])
  expect(fixture.processor.messageIds()).toEqual(['message-new'])
})

test('crash replay repeats an uncheckpointed page with stable synthetic event IDs', async () => {
  const provider = new FakeProvider([
    { page: createPage([createMessage('message-1', 1), createMessage('message-2', 2)]) },
  ])
  const fixture = await createFixture(provider)
  fixture.processor.crashOnceOnMessageId = 'message-2'
  const job = createJob('operation-crash', 'full')

  await expect(fixture.worker.process(job)).rejects.toThrow('synthetic processor crash')
  const firstAttemptEventId = fixture.processor.events[0]?.event.eventId
  expect(await fixture.store.getSyncCursor('workspace-1', 'link-1')).toMatchObject({
    operationId: 'operation-crash',
    status: 'processing',
    revision: 1,
  })

  const result = await fixture.worker.process(job)

  expect(result.kind).toBe('completed')
  expect(fixture.processor.events[2]?.event.eventId).toBe(firstAttemptEventId)
  expect(provider.requestedCursors).toEqual([undefined, undefined])
})

test('deferred snapshot stops without advancing the page checkpoint', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([createMessage('message-1', 1), createMessage('message-2', 2)]) },
  ]))
  fixture.processor.deferOnMessageId = 'message-1'

  const result = await fixture.worker.process(createJob('operation-deferred', 'full'))

  expect(result).toMatchObject({
    kind: 'deferred',
    reason: 'snapshot-deferred',
    processedPageCount: 0,
    processedMessageCount: 1,
  })
  expect(await fixture.store.getSyncCursor('workspace-1', 'link-1')).toMatchObject({
    status: 'processing',
    revision: 1,
  })
  expect((await fixture.store.getLink('workspace-1', 'link-1'))?.link).toMatchObject({
    syncStatus: 'pending',
    revision: 2,
  })
})

test('authorization loss completes the operation as paused and needs reauthorization', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([createMessage('message-1', 1)]) },
  ]))
  fixture.access.authorization = undefined

  const result = await fixture.worker.process(createJob('operation-auth-lost', 'full'))

  expect(result).toMatchObject({ kind: 'stopped', reason: 'authorization-lost' })
  expect(fixture.provider.requestedCursors).toHaveLength(0)
  expect(await fixture.store.getSyncCursor('workspace-1', 'link-1')).toMatchObject({
    status: 'completed',
    observedSourceAvailability: 'needs-reauth',
    completionSyncStatus: 'paused',
  })
  expect((await fixture.store.getLink('workspace-1', 'link-1'))?.link).toMatchObject({
    sourceAvailability: 'needs-reauth',
    syncStatus: 'paused',
    revision: 3,
  })
})

test('provider source deletion completes the operation with an honest deleted state', async () => {
  const provider = new FakeProvider([
    { page: createPage([createMessage('message-1', 1)]) },
  ])
  provider.readError = new ChatProviderAdapterError(
    'ChatProviderSourceNotFound',
    'The source no longer exists.',
  )
  const fixture = await createFixture(provider)

  const result = await fixture.worker.process(createJob('operation-deleted', 'full'))

  expect(result).toMatchObject({ kind: 'stopped', reason: 'provider-unavailable' })
  expect(await fixture.store.getSyncCursor('workspace-1', 'link-1')).toMatchObject({
    status: 'completed',
    observedSourceState: 'deleted',
    completionSyncStatus: 'paused',
  })
  expect((await fixture.store.getLink('workspace-1', 'link-1'))?.link).toMatchObject({
    sourceState: 'deleted',
    syncStatus: 'paused',
  })
})

test('a superseded job cannot read the provider or overwrite the newer link revision', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([createMessage('message-1', 1)]) },
  ]))
  const current = await fixture.store.getLink('workspace-1', 'link-1')
  if (!current) throw new Error('Expected a seeded link.')
  await fixture.store.updateLink({
    workspaceId: 'workspace-1',
    expectedRevision: 2,
    link: {
      ...current.link,
      revision: 3,
      updatedAt: LATER,
    },
  })

  const result = await fixture.worker.process(createJob('operation-stale', 'full'))

  expect(result).toMatchObject({ kind: 'stopped', reason: 'superseded' })
  expect(fixture.provider.requestedCursors).toHaveLength(0)
  expect((await fixture.store.getLink('workspace-1', 'link-1'))?.link.revision).toBe(3)
})

/** Provider page fixture keyed by its private input cursor. */
type PageFixture = {
  /** Private input cursor required to read the page, or the initial page when absent. */
  cursor?: string
  /** Provider-neutral page returned for the cursor. */
  page: ChatProviderThreadPage
}

/** Deterministic provider adapter used by resynchronization worker tests. */
class FakeProvider implements ChatProviderAdapter {
  /** Immutable Slack capability declaration. */
  readonly definition: ChatProviderDefinition = {
    provider: 'slack',
    permalinkHosts: ['chat.example.test'],
    capabilities: {
      edits: true,
      deletion: true,
      threadCompletion: true,
      nativeIdempotency: true,
    },
  }

  /** Provider pages keyed by their private continuation. */
  private readonly pages = new Map<string, ChatProviderThreadPage>()

  /** Private cursors received from worker reads. */
  readonly requestedCursors: Array<string | undefined> = []

  /** Classified provider read failure injected before page lookup. */
  readError?: ChatProviderAdapterError

  /**
   * Creates a deterministic paged provider.
   *
   * @param fixtures - Pages keyed by their expected input cursor.
   */
  constructor(fixtures: PageFixture[]) {
    for (const fixture of fixtures) this.pages.set(fixture.cursor ?? 'initial', fixture.page)
  }

  /** Rejects webhook use outside this worker fixture. */
  async normalizeWebhook(
    _request: ChatProviderWebhookRequest,
    _authorization: ChatProviderAuthorization,
  ): Promise<ChatProviderNormalizedWebhook> {
    throw new Error('Webhook normalization is not used by the resync worker fixture.')
  }

  /** Returns the configured initial thread. */
  async resolveThread(
    _authorization: ChatProviderAuthorization,
  ): Promise<ExternalChatThreadSnapshot> {
    const page = this.pages.get('initial') ?? this.pages.values().next().value
    if (!page) throw new Error('Expected at least one provider page.')
    return page.thread
  }

  /** Returns the exact provider page configured for a private continuation. */
  async readThreadPage(input: ReadChatProviderThreadPageInput): Promise<ChatProviderThreadPage> {
    this.requestedCursors.push(input.providerCursor)
    if (this.readError) throw this.readError
    const page = this.pages.get(input.providerCursor ?? 'initial')
    if (!page) throw new Error('No provider page was configured for the private cursor.')
    return page
  }

  /** Rejects outbound reply use outside this worker fixture. */
  async createReply(_input: CreateChatProviderReplyInput): Promise<ExternalChatMessage> {
    throw new Error('Reply creation is not used by the resync worker fixture.')
  }

  /** Rejects outbound edit use outside this worker fixture. */
  async editMessage(_input: EditChatProviderMessageInput): Promise<ExternalChatMessage> {
    throw new Error('Message editing is not used by the resync worker fixture.')
  }

  /** Rejects outbound deletion use outside this worker fixture. */
  async deleteMessage(_input: DeleteChatProviderMessageInput): Promise<ExternalChatMessage> {
    throw new Error('Message deletion is not used by the resync worker fixture.')
  }

  /** Rejects thread mutation use outside this worker fixture. */
  async setThreadCompletion(
    _input: SetChatProviderThreadCompletionInput,
  ): Promise<ChatProviderThreadMutationResult> {
    throw new Error('Thread completion is not used by the resync worker fixture.')
  }
}

/** Mutable current-authorization fixture. */
class FakeAccess implements ExternalChatSyncAccessPort {
  /** Current installation authorization, or undefined after simulated access loss. */
  authorization: ChatProviderAuthorization | undefined = {
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    authorizationRevision: 1,
  }

  /** Allows unused source views in this focused worker fixture. */
  async canViewWorkItem(): Promise<boolean> {
    return true
  }

  /** Returns current authorization for unused source views. */
  async getViewerProviderAuthorization(): Promise<ChatProviderAuthorization | undefined> {
    return this.authorization
  }

  /** Returns current installation authorization for every page revalidation. */
  async getInstallationProviderAuthorization(): Promise<ChatProviderAuthorization | undefined> {
    return this.authorization
  }

  /** Allows unused outbound synchronization in this focused worker fixture. */
  async canSyncOutbound(): Promise<boolean> {
    return true
  }
}

/** Recording snapshot processor with deterministic crash and deferred injection. */
class FakeSnapshotProcessor implements ExternalChatResyncSnapshotProcessorPort {
  /** Every stable synthetic input observed across retries. */
  readonly events: ExternalChatSyncInboundInput[] = []

  /** Message whose first processing attempt throws a crash. */
  crashOnceOnMessageId?: string

  /** Message whose processing returns a durable deferred outcome. */
  deferOnMessageId?: string

  /** Whether the configured one-time crash already occurred. */
  private crashed = false

  /** Applies or deterministically interrupts one synthetic snapshot. */
  async processResyncSnapshot(
    input: ExternalChatSyncInboundInput,
  ): Promise<ExternalChatSyncOutcome> {
    this.events.push(input)
    if (input.event.type !== 'message.created') {
      throw new Error('Expected a message snapshot event.')
    }
    if (input.event.message.externalId === this.crashOnceOnMessageId && !this.crashed) {
      this.crashed = true
      throw new Error('synthetic processor crash')
    }
    if (input.event.message.externalId === this.deferOnMessageId) {
      return {
        kind: 'deferred',
        operationId: `inbound-${input.event.eventId}`,
        eventId: input.event.eventId,
        reason: 'out-of-order',
        retryAt: LATER,
        occurredAt: NOW,
      }
    }
    return {
      kind: 'applied',
      operationId: `inbound-${input.event.eventId}`,
      eventId: input.event.eventId,
      direction: 'inbound',
      occurredAt: NOW,
    }
  }

  /** Returns provider message identities in exact observed order. */
  messageIds(): string[] {
    const messageIds: string[] = []
    for (const input of this.events) {
      if (input.event.type === 'message.created') {
        messageIds.push(input.event.message.externalId)
      }
    }
    return messageIds
  }
}

/** Fixed deterministic worker clock. */
class FakeClock implements ExternalChatSyncClockPort {
  /** Returns the fixture timestamp. */
  now(): string {
    return LATER
  }
}

/**
 * Creates a complete worker fixture with one accepted pending link revision.
 *
 * @param provider - Deterministic provider pages.
 * @returns Store, worker, and mutable test doubles.
 */
async function createFixture(provider: FakeProvider) {
  const store = new InMemoryExternalChatStore()
  const link = createLink(1, 'synced')
  const created = await store.createLink({
    workspaceId: 'workspace-1',
    link,
    authorizationRevision: 1,
    source: {
      provider: link.provider,
      externalWorkspaceId: link.source.externalWorkspaceId,
      conversationExternalId: link.source.conversationExternalId,
      threadExternalId: link.source.threadExternalId,
    },
    idempotencyKeyHash: 'resync-worker-fixture-idempotency',
    requestFingerprint: 'resync-worker-fixture-request',
  })
  if (created.kind !== 'created') throw new Error('Expected the fixture link to be created.')
  const accepted = await store.updateLink({
    workspaceId: 'workspace-1',
    expectedRevision: 1,
    link: createLink(2, 'pending'),
  })
  if (accepted.kind !== 'updated') throw new Error('Expected the pending link to be accepted.')
  const access = new FakeAccess()
  const processor = new FakeSnapshotProcessor()
  const worker = new ExternalChatResyncWorker({
    store,
    adapters: new ChatProviderAdapterRegistry([provider]),
    access,
    processor,
    clock: new FakeClock(),
  }, {
    pageSize: 2,
    maximumPagesPerRun: 5,
    maximumMessagesPerRun: 10,
  })
  return { store, provider, access, processor, worker }
}

/**
 * Creates one accepted resynchronization job for the pending fixture revision.
 *
 * @param operationId - Stable operation identity.
 * @param mode - Resume or full traversal mode.
 * @returns Accepted durable job.
 */
function createJob(operationId: string, mode: 'resume' | 'full'): ExternalChatResyncJob {
  return {
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    mode,
    linkRevision: 2,
    operationId,
    correlationId: `correlation-${operationId}`,
    acceptedAt: NOW,
  }
}

/**
 * Creates the stable external chat link used by worker tests.
 *
 * @param revision - Optimistic link revision.
 * @param syncStatus - User-visible synchronization status.
 * @returns Complete provider-neutral link.
 */
function createLink(
  revision: number,
  syncStatus: ExternalChatWorkItemLink['syncStatus'],
): ExternalChatWorkItemLink {
  return {
    schemaVersion: 1,
    id: 'link-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    installationId: 'installation-1',
    provider: 'slack',
    workspace: {
      provider: 'slack',
      externalId: 'external-workspace-1',
      displayName: 'Workspace',
    },
    conversation: {
      externalId: 'conversation-1',
      externalWorkspaceId: 'external-workspace-1',
      kind: 'channel',
      displayName: 'Channel',
    },
    source: {
      externalWorkspaceId: 'external-workspace-1',
      conversationExternalId: 'conversation-1',
      threadExternalId: 'thread-1',
      rootMessageExternalId: 'message-root',
      sourcePermalink: 'https://chat.example.test/thread-1',
    },
    syncDirection: 'bidirectional',
    syncStatus,
    sourceAvailability: 'available',
    sourceState: 'active',
    revision,
    createdAt: NOW,
    updatedAt: revision === 1 ? NOW : LATER,
  }
}

/**
 * Creates one strict bounded provider page.
 *
 * @param messages - Chronologically ordered page messages.
 * @param providerCursor - Private continuation when another page exists.
 * @returns Provider-neutral thread page.
 */
function createPage(
  messages: ExternalChatMessage[],
  providerCursor?: string,
): ChatProviderThreadPage {
  return {
    thread: {
      schemaVersion: 1,
      workspace: {
        provider: 'slack',
        externalId: 'external-workspace-1',
        displayName: 'Workspace',
      },
      conversation: {
        externalId: 'conversation-1',
        externalWorkspaceId: 'external-workspace-1',
        kind: 'channel',
        displayName: 'Channel',
      },
      externalId: 'thread-1',
      rootMessageExternalId: 'message-root',
      permalink: 'https://chat.example.test/thread-1',
      availability: 'available',
      state: 'active',
      messages,
      hasMoreMessages: providerCursor !== undefined,
      createdAt: '2026-08-06T05:00:00.000Z',
      updatedAt: LATER,
    },
    ...(providerCursor === undefined ? {} : { providerCursor }),
  }
}

/**
 * Creates one active provider message with monotonically increasing timestamps.
 *
 * @param externalId - Provider message identity.
 * @param minute - Posting minute used for chronological ordering.
 * @returns Complete provider-neutral message.
 */
function createMessage(externalId: string, minute: number): ExternalChatMessage {
  const timestamp = `2026-08-06T05:${String(minute).padStart(2, '0')}:00.000Z`
  return {
    externalId,
    externalVersion: `version-${minute}`,
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
    parentMessageExternalId: externalId === 'message-root' ? undefined : 'message-root',
    permalink: `https://chat.example.test/messages/${externalId}`,
    availability: 'available',
    state: 'active',
    actor: { externalId: 'actor-1', kind: 'person', displayName: 'Example User' },
    bodyMarkdown: `Body for ${externalId}`,
    quotedRanges: [],
    attachments: [],
    postedAt: timestamp,
    updatedAt: timestamp,
  }
}
