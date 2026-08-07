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
import { createExternalChatFingerprint, InMemoryExternalChatStore } from './external-chat'
import type { ExternalChatResyncJob } from './external-chat-link-service'
import {
  ExternalChatResyncWorker,
  type ExternalChatFullResyncBoundary,
  type ExternalChatFullResyncSeenMessageInput,
  type ExternalChatResyncReconciliationPort,
  type ExternalChatResyncRedactionInput,
  type ExternalChatResyncSnapshotProcessorPort,
} from './external-chat-resync-worker'
import type {
  ExternalChatSyncAccessPort,
  ExternalChatSyncClockPort,
  ExternalChatSyncInboundInput,
} from './external-chat-sync-service'

const NOW = '2026-08-06T06:00:00.000Z'
const LATER = '2026-08-06T06:01:00.000Z'
const AFTER = '2026-08-06T06:02:00.000Z'

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
  expect(fixture.reconciliation.seenMessageIds('operation-full')).toEqual([
    'message-1',
    'message-2',
    'message-3',
  ])
  expect(fixture.reconciliation.remainingBindingIds()).toEqual([
    'message-1',
    'message-2',
    'message-3',
  ])
  expect(fixture.reconciliation.reconciledOperations).toEqual(['operation-full'])
  expect(fixture.provider.requestedCursors).toEqual([undefined, 'page-2'])
  expect(await fixture.store.getSyncCursor('workspace-1', 'link-1')).toMatchObject({
    operationId: 'operation-full',
    status: 'completed',
    ownerLinkRevision: 2,
    authorizationRevision: 1,
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
    authorizationRevision: 1,
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

test('resume does not reuse a continuation issued under an older authorization generation', async () => {
  const provider = new FakeProvider([
    { page: createPage([createMessage('message-new-generation', 2)]) },
  ])
  const fixture = await createFixture(provider)
  await fixture.store.putSyncCursor('workspace-1', {
    schemaVersion: 1,
    linkId: 'link-1',
    provider: 'slack',
    operationId: 'operation-old-generation',
    mode: 'full',
    status: 'processing',
    ownerLinkRevision: 1,
    authorizationRevision: 1,
    providerCursor: 'old-generation-cursor',
    revision: 1,
    updatedAt: NOW,
  })
  fixture.access.authorization = {
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    authorizationRevision: 2,
  }

  const result = await fixture.worker.process(createJob('operation-new-generation', 'resume', 2))

  expect(result.kind).toBe('completed')
  expect(provider.requestedCursors).toEqual([undefined])
  expect(fixture.processor.messageIds()).toEqual(['message-new-generation'])
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
    authorizationRevision: 1,
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
  expect(fixture.reconciliation.redactions).toHaveLength(1)
})

test('successful current-generation resync advances the private source authorization revision', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([createMessage('message-1', 1)]) },
  ]))
  fixture.access.authorization = {
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    authorizationRevision: 2,
  }

  const result = await fixture.worker.process(createJob('operation-reauthorized', 'full', 2))

  expect(result.kind).toBe('completed')
  expect(await fixture.store.getSyncCursor('workspace-1', 'link-1')).toMatchObject({
    authorizationRevision: 2,
  })
  expect(await fixture.store.getLink('workspace-1', 'link-1')).toMatchObject({
    sourceAuthorizationRevision: 2,
  })
})

test('a successful newer authorization generation supersedes older lifecycle restrictions', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([]) },
  ]))
  const current = await fixture.store.getLink('workspace-1', 'link-1')
  if (!current) throw new Error('Expected a seeded link.')
  const restricted = await fixture.store.updateLink({
    workspaceId: 'workspace-1',
    expectedRevision: current.link.revision,
    lifecycleState: {
      ...current.lifecycleState,
      workspace: {
        authorizationRevision: 1,
        availability: 'permission-lost',
        state: 'active',
        occurredAt: AFTER,
        eventId: 'workspace-permission-lost-generation-1',
      },
    },
    link: {
      ...current.link,
      sourceAvailability: 'permission-lost',
      syncStatus: 'paused',
      revision: current.link.revision + 1,
      updatedAt: AFTER,
    },
  })
  if (restricted.kind !== 'updated') throw new Error('Expected a restrictive link update.')
  const fenced = await fixture.store.fenceParentLifecycle({
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    authorizationRevision: 1,
    availability: 'permission-lost',
    state: 'active',
    restrictive: true,
    eventId: 'workspace-fence-generation-1',
    operationId: 'workspace-fence-operation-generation-1',
    occurredAt: AFTER,
  })
  if (fenced.kind !== 'applied') throw new Error('Expected a restrictive parent fence.')
  fixture.access.authorization = {
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    authorizationRevision: 2,
  }

  const result = await fixture.worker.process(createJob(
    'operation-generation-2-recovery',
    'full',
    2,
    restricted.record.link.revision,
  ))

  expect(result.kind).toBe('completed')
  const recovered = await fixture.store.getLink('workspace-1', 'link-1')
  expect(recovered).toMatchObject({
    sourceAuthorizationRevision: 2,
    lifecycleState: {
      workspace: {
        authorizationRevision: 1,
        availability: 'permission-lost',
      },
      thread: {
        authorizationRevision: 2,
        availability: 'available',
        state: 'active',
      },
    },
    link: {
      sourceAvailability: 'available',
      sourceState: 'active',
      syncStatus: 'synced',
    },
  })
  expect(fixture.reconciliation.redactions).toHaveLength(0)
})

test('equal and newer lifecycle restrictions cannot be downgraded by a resync success', async () => {
  for (const restrictionRevision of [2, 3]) {
    const fixture = await createFixture(new FakeProvider([
      { page: createPage([]) },
    ]))
    const current = await fixture.store.getLink('workspace-1', 'link-1')
    if (!current) throw new Error('Expected a seeded link.')
    const restricted = await fixture.store.updateLink({
      workspaceId: 'workspace-1',
      expectedRevision: current.link.revision,
      lifecycleState: {
        ...current.lifecycleState,
        thread: {
          authorizationRevision: restrictionRevision,
          availability: 'permission-lost',
          state: 'active',
          occurredAt: AFTER,
          eventId: `thread-permission-lost-generation-${restrictionRevision}`,
        },
      },
      link: {
        ...current.link,
        sourceAvailability: 'permission-lost',
        syncStatus: 'paused',
        revision: current.link.revision + 1,
        updatedAt: AFTER,
      },
    })
    if (restricted.kind !== 'updated') throw new Error('Expected a restrictive link update.')
    fixture.access.authorization = {
      installationId: 'installation-1',
      externalWorkspaceId: 'external-workspace-1',
      authorizationRevision: 2,
    }

    const result = await fixture.worker.process(createJob(
      `operation-generation-2-restricted-by-${restrictionRevision}`,
      'full',
      2,
      restricted.record.link.revision,
    ))

    expect(result.kind).toBe('completed')
    expect(await fixture.store.getLink('workspace-1', 'link-1')).toMatchObject({
      sourceAuthorizationRevision: 1,
      lifecycleState: {
        thread: {
          authorizationRevision: restrictionRevision,
          availability: 'permission-lost',
        },
      },
      link: {
        sourceAvailability: 'permission-lost',
        syncStatus: 'paused',
      },
    })
    expect(fixture.reconciliation.redactions).toHaveLength(1)
  }
})

test('an older accepted authorization generation cannot traverse or overwrite the source', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([createMessage('message-1', 1)]) },
  ]))
  const current = await fixture.store.getLink('workspace-1', 'link-1')
  if (!current) throw new Error('Expected a seeded link.')
  const advanced = await fixture.store.updateLink({
    workspaceId: 'workspace-1',
    expectedRevision: current.link.revision,
    sourceAuthorizationRevision: 2,
    lifecycleState: {
      ...current.lifecycleState,
      thread: {
        authorizationRevision: 2,
        availability: 'permission-lost',
        state: 'active',
        occurredAt: LATER,
        eventId: 'thread-permission-lost-generation-2',
      },
    },
    link: {
      ...current.link,
      sourceAvailability: 'permission-lost',
      syncStatus: 'paused',
      revision: 3,
      updatedAt: LATER,
    },
  })
  if (advanced.kind !== 'updated') throw new Error('Expected authorization generation update.')

  const result = await fixture.worker.process(createJob('operation-old-auth', 'full', 1, 3))

  expect(result).toMatchObject({ kind: 'stopped', reason: 'superseded' })
  expect(fixture.provider.requestedCursors).toHaveLength(0)
  expect(await fixture.store.getLink('workspace-1', 'link-1')).toMatchObject({
    sourceAuthorizationRevision: 2,
    lifecycleState: {
      thread: {
        authorizationRevision: 2,
        availability: 'permission-lost',
      },
    },
    link: {
      sourceAvailability: 'permission-lost',
      syncStatus: 'paused',
      revision: 3,
    },
  })
})

test('terminal projection respects a restrictive parent fence and redacts source resources', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([createMessage('message-1', 1)]) },
  ]))
  await fixture.store.fenceParentLifecycle({
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    authorizationRevision: 1,
    availability: 'permission-lost',
    state: 'active',
    restrictive: true,
    eventId: 'workspace-restricted',
    operationId: 'workspace-restricted-operation',
    occurredAt: LATER,
  })

  const result = await fixture.worker.process(createJob('operation-parent-restricted', 'full'))

  expect(result.kind).toBe('completed')
  const record = await fixture.store.getLink('workspace-1', 'link-1')
  expect(record?.link).toMatchObject({
    sourceAvailability: 'permission-lost',
    syncStatus: 'paused',
    workspace: { provider: 'slack', externalId: 'external-workspace-1' },
  })
  expect(record?.link.workspace).not.toHaveProperty('displayName')
  expect(record?.link.source).not.toHaveProperty('sourcePermalink')
  expect(fixture.reconciliation.redactions).toHaveLength(1)
  expect(fixture.reconciliation.redactions[0]?.expectedParentLifecycleFences).toMatchObject({
    workspace: { eventId: 'workspace-restricted' },
    conversation: undefined,
  })
})

test('restrictive resource cleanup must succeed before the terminal link projection commits', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([createMessage('message-1', 1)]) },
  ]))
  await fixture.store.fenceParentLifecycle({
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    authorizationRevision: 1,
    availability: 'permission-lost',
    state: 'active',
    restrictive: true,
    eventId: 'workspace-restricted',
    operationId: 'workspace-restricted-operation',
    occurredAt: LATER,
  })
  fixture.reconciliation.rejectNextRedaction = true

  const result = await fixture.worker.process(createJob('operation-redaction-fenced', 'full'))

  expect(result).toMatchObject({ kind: 'deferred', reason: 'concurrent' })
  expect((await fixture.store.getLink('workspace-1', 'link-1'))?.link).toMatchObject({
    revision: 2,
    syncStatus: 'pending',
  })
  expect(fixture.reconciliation.redactions).toHaveLength(0)
})

test('terminal projection retries when the exact parent fence changes after redaction', async () => {
  const fixture = await createFixture(new FakeProvider([
    { page: createPage([createMessage('message-1', 1)]) },
  ]))
  await fixture.store.fenceParentLifecycle({
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'external-workspace-1',
    authorizationRevision: 1,
    availability: 'permission-lost',
    state: 'active',
    restrictive: true,
    eventId: 'workspace-restricted-1',
    operationId: 'workspace-restricted-operation-1',
    occurredAt: LATER,
  })
  fixture.reconciliation.redactionHook = async () => {
    await fixture.store.fenceParentLifecycle({
      workspaceId: 'workspace-1',
      provider: 'slack',
      installationId: 'installation-1',
      externalWorkspaceId: 'external-workspace-1',
      authorizationRevision: 1,
      availability: 'permission-lost',
      state: 'deleted',
      restrictive: true,
      eventId: 'workspace-restricted-2',
      operationId: 'workspace-restricted-operation-2',
      occurredAt: AFTER,
    })
  }

  const result = await fixture.worker.process(createJob('operation-parent-race', 'full'))

  expect(result).toMatchObject({ kind: 'deferred', reason: 'concurrent' })
  expect((await fixture.store.getLink('workspace-1', 'link-1'))?.link).toMatchObject({
    revision: 2,
    syncStatus: 'pending',
  })
  expect(fixture.reconciliation.redactions).toHaveLength(0)
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

/** Durable operation-owned full-resync manifest retained across worker retries. */
type FakeFullResyncManifest = {
  /** Exact operation boundary that created the manifest. */
  boundary: ExternalChatFullResyncBoundary
  /** Provider message identities seen in the authoritative traversal. */
  seen: Set<string>
  /** Whether unseen bindings were reconciled terminally. */
  reconciled: boolean
}

/** Deterministic durable reconciliation boundary for worker acceptance tests. */
class FakeResyncReconciliation implements ExternalChatResyncReconciliationPort {
  /** Durable link and parent lifecycle state used to validate destructive cleanup authority. */
  private readonly store: InMemoryExternalChatStore

  /** Durable manifests keyed by accepted operation ID. */
  private readonly manifests = new Map<string, FakeFullResyncManifest>()

  /** Existing imported binding identities reconciled by a full traversal. */
  private readonly bindings = new Set(['message-stale', 'message-1', 'message-2', 'message-3'])

  /** Full operations that completed unseen-binding reconciliation. */
  readonly reconciledOperations: string[] = []

  /** Restrictive terminal resource-redaction requests. */
  readonly redactions: ExternalChatResyncRedactionInput[] = []

  /** Whether the next redaction should lose its exact operation fence. */
  rejectNextRedaction = false

  /** Optional one-shot concurrent mutation invoked between redaction and link projection. */
  redactionHook?: () => Promise<void>

  /**
   * Creates an exact-snapshot reconciliation fixture.
   *
   * @param store - Durable state re-read at the destructive redaction boundary.
   */
  constructor(store: InMemoryExternalChatStore) {
    this.store = store
  }

  /** Creates or replays one exact operation-owned manifest. */
  async beginFullResync(input: ExternalChatFullResyncBoundary): Promise<boolean> {
    const current = this.manifests.get(input.operationId)
    if (current) return sameFullResyncBoundary(current.boundary, input)
    this.manifests.set(input.operationId, { boundary: input, seen: new Set(), reconciled: false })
    return true
  }

  /** Records one provider message in its exact operation-owned manifest. */
  async recordFullResyncMessageSeen(
    input: ExternalChatFullResyncSeenMessageInput,
  ): Promise<boolean> {
    const manifest = this.manifests.get(input.operationId)
    if (!manifest || !sameFullResyncBoundary(manifest.boundary, input)) return false
    manifest.seen.add(input.externalMessageId)
    this.bindings.add(input.externalMessageId)
    return true
  }

  /** Removes every pre-existing binding absent from the authoritative seen manifest. */
  async reconcileFullResync(input: ExternalChatFullResyncBoundary): Promise<boolean> {
    const manifest = this.manifests.get(input.operationId)
    if (!manifest || !sameFullResyncBoundary(manifest.boundary, input)) return false
    if (!manifest.reconciled) {
      for (const bindingId of this.bindings) {
        if (!manifest.seen.has(bindingId)) this.bindings.delete(bindingId)
      }
      manifest.reconciled = true
      this.reconciledOperations.push(input.operationId)
    }
    return true
  }

  /** Records restrictive cleanup only while the exact accepted operation still owns the link. */
  async redactRestrictiveResyncResources(
    input: ExternalChatResyncRedactionInput,
  ): Promise<boolean> {
    if (this.redactionHook) {
      const hook = this.redactionHook
      this.redactionHook = undefined
      await hook()
    }
    if (this.rejectNextRedaction) {
      this.rejectNextRedaction = false
      return false
    }
    const current = await this.store.getLink(input.workspaceId, input.linkId)
    if (
      !current ||
      !current.active ||
      current.link.revision !== input.ownerLinkRevision ||
      current.link.teamId !== input.teamId ||
      current.link.workItemId !== input.workItemId ||
      current.sourceAuthorizationRevision > input.authorizationRevision
    ) return false
    const parentFences = await this.store.getParentLifecycleFences(
      input.workspaceId,
      input.linkId,
    )
    if (
      parentFences === undefined ||
      createExternalChatFingerprint(parentFences) !==
        createExternalChatFingerprint(input.expectedParentLifecycleFences)
    ) return false
    this.redactions.push(input)
    return true
  }

  /** Returns seen message IDs for one operation in deterministic provider order. */
  seenMessageIds(operationId: string): string[] {
    return [...(this.manifests.get(operationId)?.seen ?? [])]
  }

  /** Returns remaining imported binding identities after reconciliation. */
  remainingBindingIds(): string[] {
    return [...this.bindings].sort((left, right) => left.localeCompare(right))
  }
}

/**
 * Compares every immutable field of two operation-owned full-resync boundaries.
 *
 * @param left - Existing durable manifest boundary.
 * @param right - Candidate replay boundary.
 * @returns Whether both inputs name the exact same accepted operation generation.
 */
function sameFullResyncBoundary(
  left: ExternalChatFullResyncBoundary,
  right: ExternalChatFullResyncBoundary,
): boolean {
  return left.workspaceId === right.workspaceId &&
    left.linkId === right.linkId &&
    left.operationId === right.operationId &&
    left.ownerLinkRevision === right.ownerLinkRevision &&
    left.authorizationRevision === right.authorizationRevision
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
    idempotencyKeyHash: createExternalChatFingerprint('resync-worker-fixture-idempotency'),
    requestFingerprint: createExternalChatFingerprint('resync-worker-fixture-request'),
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
  const reconciliation = new FakeResyncReconciliation(store)
  const worker = new ExternalChatResyncWorker({
    store,
    adapters: new ChatProviderAdapterRegistry([provider]),
    access,
    processor,
    reconciliation,
    clock: new FakeClock(),
  }, {
    pageSize: 2,
    maximumPagesPerRun: 5,
    maximumMessagesPerRun: 10,
  })
  return { store, provider, access, processor, reconciliation, worker }
}

/**
 * Creates one accepted resynchronization job for the pending fixture revision.
 *
 * @param operationId - Stable operation identity.
 * @param mode - Resume or full traversal mode.
 * @param authorizationRevision - Provider authorization generation accepted by the job.
 * @param linkRevision - Link revision that owns the resynchronization checkpoint.
 * @returns Accepted durable job.
 */
function createJob(
  operationId: string,
  mode: 'resume' | 'full',
  authorizationRevision = 1,
  linkRevision = 2,
): ExternalChatResyncJob {
  return {
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    mode,
    linkRevision,
    authorizationRevision,
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
