import { expect, test } from 'bun:test'
import type {
  ConnectorInstallation,
  ExternalWorkItemLink,
} from '@mukuroji/contracts'
import {
  createAuditEvent,
  createMutationAuditContext,
} from './audit'
import {
  CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
  createConnectorOutboundOperationId,
  parseConnectorSyncQueueMessage,
  processConnectorSyncAuditProjectionBatch,
  processConnectorSyncMessage,
  processConnectorSyncWorkerBatch,
  scheduleConnectorPollInventory,
  type CommitConnectorPollCheckpointInput,
  type ConnectorPollCheckpoint,
  type ConnectorPollCheckpointKey,
  type ConnectorPollCheckpointStore,
  type ConnectorPollInventory,
  type ConnectorSyncDynamoAttributeValue,
  type ConnectorSyncQueueMessage,
  type ConnectorSyncWorkerDependencies,
} from './connector-sync-worker'

const now = '2026-07-18T00:00:00.000Z'

test('projects pending Work Item updates and suppresses connector-origin loops', async () => {
  const queued: ConnectorSyncQueueMessage[] = []
  const userEvent = createWorkItemAuditEvent('user-change', {
    kind: 'api',
    requestId: 'request-1',
    route: '/api/teams/:teamId/issues/:issueId',
  })
  const connectorEvent = createWorkItemAuditEvent('connector-change', {
    kind: 'system',
    requestId: 'connector-sync-operation-1',
    route: '/connector-sync/work-items/work-item-1',
  })

  const response = await processConnectorSyncAuditProjectionBatch({
    Records: [userEvent, connectorEvent].map((event, index) => ({
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: String(index + 1),
        NewImage: marshallRecord(event),
      },
    })),
  }, {
    queue: {
      async enqueue(message) {
        queued.push(message)
      },
    },
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(queued).toEqual([{
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'work-item-changed',
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    sourceEventId: userEvent.eventId,
  }])
})

test('projects external-link changes into immediate outbound and poll locators', async () => {
  const queued: ConnectorSyncQueueMessage[] = []
  const event = createExternalLinkAuditEvent()

  const response = await processConnectorSyncAuditProjectionBatch({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: 'external-link-1',
        NewImage: marshallRecord(event),
      },
    }],
  }, {
    queue: {
      async enqueue(message) {
        queued.push(message)
      },
    },
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(queued).toEqual([
    {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'outbound',
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      sourceEventId: event.eventId,
    },
    {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'poll',
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      resourceType: 'issue',
    },
  ])
  expect(JSON.stringify(queued)).not.toContain('external.test')
})

test('does not enqueue sync work for links paused by connector disconnect', async () => {
  const queued: ConnectorSyncQueueMessage[] = []
  const event = createConnectorDisconnectedLinkAuditEvent()

  const response = await processConnectorSyncAuditProjectionBatch({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: 'connector-disconnected-link-1',
        NewImage: marshallRecord(event),
      },
    }],
  }, {
    queue: {
      async enqueue(message) {
        queued.push(message)
      },
    },
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(queued).toEqual([])
})

test('retries a durable disconnect outbox after the SQS response is lost', async () => {
  const event = createConnectorDisconnectAuditEvent()
  const record = {
    eventName: 'INSERT',
    dynamodb: {
      SequenceNumber: 'connector-disconnect-1',
      NewImage: marshallRecord(event),
    },
  }
  const queued: ConnectorSyncQueueMessage[] = []
  let loseFirstResponse = true
  const dependencies = {
    queue: {
      async enqueue(message: ConnectorSyncQueueMessage) {
        queued.push(structuredClone(message))
        if (loseFirstResponse) {
          loseFirstResponse = false
          throw new Error('SQS response was lost after accepting the message')
        }
      },
    },
  }

  await expect(processConnectorSyncAuditProjectionBatch({
    Records: [record],
  }, dependencies)).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: 'connector-disconnect-1' }],
  })
  await expect(processConnectorSyncAuditProjectionBatch({
    Records: [record],
  }, dependencies)).resolves.toEqual({ batchItemFailures: [] })

  expect(queued).toEqual([
    {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'disconnect-links',
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      lifecycleRevision: 4,
      updatedByUserId: 'actor-1',
    },
    {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'disconnect-links',
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      lifecycleRevision: 4,
      updatedByUserId: 'actor-1',
    },
  ])
})

test('reloads links before outbound work and reuses a stable operation ID', async () => {
  const fixture = createWorkerFixture()
  const changedMessage = {
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'work-item-changed',
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    sourceEventId: 'audit-event-1',
  } as const

  await processConnectorSyncMessage(changedMessage, fixture.dependencies)
  expect(fixture.queued).toEqual([{
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'outbound',
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    sourceEventId: 'audit-event-1',
  }])
  expect(JSON.stringify(fixture.queued)).not.toContain('external.test')

  fixture.links[0] = {
    ...fixture.links[0]!,
    externalUrl: 'https://external.test/issues/current',
    updatedAt: '2026-07-18T00:01:00.000Z',
  }
  const outbound = fixture.queued[0]!
  await processConnectorSyncMessage(outbound, fixture.dependencies)
  await processConnectorSyncMessage(outbound, fixture.dependencies)

  expect(fixture.outboundCalls).toHaveLength(2)
  expect(fixture.outboundCalls[0]?.link.externalUrl)
    .toBe('https://external.test/issues/current')
  expect(fixture.outboundCalls[0]?.operationId)
    .toBe(createConnectorOutboundOperationId(outbound))
  expect(fixture.outboundCalls[1]?.operationId)
    .toBe(fixture.outboundCalls[0]?.operationId)
})

test('keeps poll cursors in a CAS checkpoint and queues only ID locators', async () => {
  const fixture = createWorkerFixture({
    checkpoint: { revision: 3, cursor: 'provider-page-1' },
    pollCursors: ['provider-page-2', undefined],
  })
  const pollMessage = {
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'poll',
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    resourceType: 'issue',
  } as const

  await processConnectorSyncMessage(pollMessage, fixture.dependencies)
  expect(fixture.pollCalls[0]).toMatchObject({
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    resourceType: 'issue',
    cursor: 'provider-page-1',
    maximumPages: 10,
  })
  expect(fixture.commits[0]).toEqual({
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    resourceType: 'issue',
    expectedRevision: 3,
    nextCursor: 'provider-page-2',
  })
  expect(fixture.queued).toEqual([pollMessage])
  expect(JSON.stringify(fixture.queued)).not.toContain('provider-page')

  await processConnectorSyncMessage(fixture.queued[0]!, fixture.dependencies)
  expect(fixture.pollCalls[1]).toMatchObject({ cursor: 'provider-page-2' })
  expect(fixture.commits[1]).toEqual({
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    resourceType: 'issue',
    expectedRevision: 4,
  })
  expect(fixture.readCheckpoint()).toEqual({ revision: 5 })
})

test('does not preload external links before delegating a poll to the engine', async () => {
  const fixture = createWorkerFixture()

  await processConnectorSyncMessage({
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'poll',
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    resourceType: 'issue',
  }, fixture.dependencies)

  expect(fixture.linkListCalls).toEqual([])
  expect(fixture.pollCalls).toHaveLength(1)
})

test('continues disconnected link cleanup through durable ID-only jobs', async () => {
  const fixture = createWorkerFixture({
    disconnectPages: [
      { paused: 2, nextCursor: 'disconnect-page-2' },
      { paused: 1 },
    ],
    maximumDisconnectLinks: 2,
  })
  const message = {
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'disconnect-links',
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    lifecycleRevision: 4,
    updatedByUserId: 'user-1',
  } as const

  await processConnectorSyncMessage(message, fixture.dependencies)

  expect(fixture.pauseCalls[0]).toEqual({
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    expectedLifecycleRevision: 4,
    updatedByUserId: 'user-1',
    limit: 2,
  })
  expect(fixture.queued).toEqual([{
    ...message,
    cursor: 'disconnect-page-2',
  }])
  expect(JSON.stringify(fixture.queued)).not.toContain('external.test')

  await processConnectorSyncMessage(fixture.queued[0]!, fixture.dependencies)

  expect(fixture.pauseCalls[1]).toEqual({
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    expectedLifecycleRevision: 4,
    updatedByUserId: 'user-1',
    limit: 2,
    cursor: 'disconnect-page-2',
  })
  expect(fixture.queued).toHaveLength(1)
})

test('processes disconnect cleanup without loading the secret-backed engine', async () => {
  const fixture = createWorkerFixture({
    disconnectPages: [{ paused: 1 }],
    engineError: new Error('Secrets Manager is unavailable'),
  })

  await expect(processConnectorSyncWorkerBatch({
    Records: [{
      messageId: 'disconnect-without-engine',
      body: JSON.stringify({
        version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
        kind: 'disconnect-links',
        workspaceId: 'workspace-1',
        installationId: 'installation-1',
        lifecycleRevision: 4,
      }),
    }],
  }, fixture.dependencies)).resolves.toEqual({ batchItemFailures: [] })

  expect(fixture.pauseCalls).toHaveLength(1)
  expect(fixture.readEngineLoads()).toBe(0)
})

test('skips stale outbound work before loading the secret-backed engine', async () => {
  const inactiveLinks = [
    { syncStatus: 'paused', syncDirection: 'bidirectional' },
    { syncStatus: 'conflict', syncDirection: 'outbound' },
    { syncStatus: 'synced', syncDirection: 'inbound' },
    { syncStatus: 'synced', syncDirection: 'none' },
  ] as const

  for (const inactive of inactiveLinks) {
    const fixture = createWorkerFixture({
      engineError: new Error('Secrets Manager is unavailable'),
    })
    fixture.links[0] = {
      ...fixture.links[0]!,
      ...inactive,
    }

    await expect(processConnectorSyncMessage({
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'outbound',
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      sourceEventId: 'stale-outbound-event',
    }, fixture.dependencies)).resolves.toBeUndefined()

    expect(fixture.outboundCalls).toEqual([])
    expect(fixture.readEngineLoads()).toBe(0)
  }
})

test('replays a disconnect page safely when the continuation response is lost', async () => {
  const fixture = createWorkerFixture({
    disconnectPages: [
      { paused: 2, nextCursor: 'disconnect-page-2' },
      { paused: 0, nextCursor: 'disconnect-page-2' },
      { paused: 1 },
      { paused: 0 },
    ],
    maximumDisconnectLinks: 2,
  })
  const message = {
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'disconnect-links',
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    lifecycleRevision: 4,
  } as const
  const originalQueue = fixture.dependencies.queue
  let loseFirstResponse = true
  const retryingDependencies: ConnectorSyncWorkerDependencies = {
    ...fixture.dependencies,
    queue: {
      async enqueue(nextMessage) {
        await originalQueue.enqueue(nextMessage)
        if (loseFirstResponse) {
          loseFirstResponse = false
          throw new Error('SQS continuation response was lost')
        }
      },
    },
  }
  const record = {
    messageId: 'disconnect-page-1',
    body: JSON.stringify(message),
  }

  await expect(processConnectorSyncWorkerBatch({
    Records: [record],
  }, retryingDependencies)).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: 'disconnect-page-1' }],
  })
  await expect(processConnectorSyncWorkerBatch({
    Records: [record],
  }, retryingDependencies)).resolves.toEqual({ batchItemFailures: [] })
  expect(fixture.queued).toEqual([
    { ...message, cursor: 'disconnect-page-2' },
    { ...message, cursor: 'disconnect-page-2' },
  ])

  await processConnectorSyncMessage(fixture.queued[0]!, fixture.dependencies)
  await processConnectorSyncMessage(fixture.queued[1]!, fixture.dependencies)
  expect(fixture.pauseCalls).toEqual([
    {
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      expectedLifecycleRevision: 4,
      limit: 2,
    },
    {
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      expectedLifecycleRevision: 4,
      limit: 2,
    },
    {
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      expectedLifecycleRevision: 4,
      limit: 2,
      cursor: 'disconnect-page-2',
    },
    {
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      expectedLifecycleRevision: 4,
      limit: 2,
      cursor: 'disconnect-page-2',
    },
  ])
  expect(fixture.queued).toHaveLength(2)
})

test('returns partial SQS failures and rejects payload fields that could carry secrets', async () => {
  const fixture = createWorkerFixture()
  const valid = {
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'outbound',
    workspaceId: 'workspace-1',
    linkId: 'deleted-link',
    sourceEventId: 'audit-event-1',
  }
  const response = await processConnectorSyncWorkerBatch({
    Records: [
      { messageId: 'valid', body: JSON.stringify(valid) },
      { messageId: 'invalid', body: '{"credential":"secret"}' },
    ],
  }, fixture.dependencies)

  expect(response).toEqual({
    batchItemFailures: [{ itemIdentifier: 'invalid' }],
  })
  expect(() => parseConnectorSyncQueueMessage(JSON.stringify({
    ...valid,
    credential: 'provider-secret',
  }))).toThrow('unsupported fields')
})

test('enumerates a global secret-free inventory without requiring workspace input', async () => {
  const queued: ConnectorSyncQueueMessage[] = []
  const cursors: Array<string | undefined> = []
  const result = await scheduleConnectorPollInventory({}, {
    inventory: {
      async listPollTargets(cursor) {
        cursors.push(cursor)
        if (!cursor) {
          return {
            targets: [
              {
                workspaceId: 'workspace-1',
                installationId: 'installation-1',
                resourceType: 'issue',
              },
              {
                workspaceId: 'workspace-1',
                installationId: 'installation-1',
                resourceType: 'issue',
              },
            ],
            nextCursor: 'inventory-page-2',
          }
        }
        return {
          targets: [{
            workspaceId: 'workspace-2',
            installationId: 'installation-2',
            resourceType: 'merge-request',
          }],
        }
      },
    },
    queue: {
      async enqueue(message) {
        queued.push(message)
      },
    },
  })

  expect(result).toEqual({
    pages: 2,
    enqueued: 2,
    continuationQueued: false,
  })
  expect(cursors).toEqual([undefined, 'inventory-page-2'])
  expect(queued).toEqual([
    {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'poll',
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      resourceType: 'issue',
    },
    {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'poll',
      workspaceId: 'workspace-2',
      installationId: 'installation-2',
      resourceType: 'merge-request',
    },
  ])
})

test('continues a capped global inventory scan through a durable queue job', async () => {
  const cursors: Array<string | undefined> = []
  const inventory: ConnectorPollInventory = {
    async listPollTargets(cursor) {
      cursors.push(cursor)
      if (!cursor) {
        return {
          targets: [{
            workspaceId: 'workspace-1',
            installationId: 'installation-1',
            resourceType: 'issue',
          }],
          nextCursor: 'inventory-page-2',
        }
      }
      return {
        targets: [{
          workspaceId: 'workspace-2',
          installationId: 'installation-2',
          resourceType: 'merge-request',
        }],
      }
    },
  }
  const fixture = createWorkerFixture({ inventory })

  await expect(scheduleConnectorPollInventory({ maximumPages: 1 }, {
    inventory,
    queue: fixture.dependencies.queue,
  })).resolves.toEqual({
    pages: 1,
    enqueued: 1,
    continuationQueued: true,
  })
  expect(fixture.queued).toEqual([
    {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'poll',
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      resourceType: 'issue',
    },
    {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'poll-inventory',
      cursor: 'inventory-page-2',
    },
  ])

  const continuation = fixture.queued[1]
  if (continuation?.kind !== 'poll-inventory') {
    throw new Error('Expected durable inventory continuation.')
  }
  await processConnectorSyncMessage(continuation, fixture.dependencies)
  expect(cursors).toEqual([undefined, 'inventory-page-2'])
  expect(fixture.queued[2]).toEqual({
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'poll',
    workspaceId: 'workspace-2',
    installationId: 'installation-2',
    resourceType: 'merge-request',
  })
})

function createWorkerFixture(options: {
  checkpoint?: ConnectorPollCheckpoint
  pollCursors?: Array<string | undefined>
  inventory?: ConnectorPollInventory
  disconnectPages?: Array<{ paused: number; nextCursor?: string }>
  maximumDisconnectLinks?: number
  engineError?: Error
} = {}) {
  const links: ExternalWorkItemLink[] = [createLink()]
  const installations: ConnectorInstallation[] = [createInstallation()]
  const queued: ConnectorSyncQueueMessage[] = []
  const outboundCalls: Array<{
    workspaceId: string
    link: ExternalWorkItemLink
    operationId: string
  }> = []
  const pollCalls: Array<{
    workspaceId: string
    installationId: string
    resourceType: 'issue' | 'merge-request' | 'commit' | 'deploy'
    cursor?: string
    maximumPages?: number
  }> = []
  const linkListCalls: unknown[] = []
  const pauseCalls: unknown[] = []
  const commits: CommitConnectorPollCheckpointInput[] = []
  const pollCursors = [...(options.pollCursors ?? [])]
  const disconnectPages = [...(options.disconnectPages ?? [])]
  let engineLoads = 0
  let checkpoint = options.checkpoint
    ? structuredClone(options.checkpoint)
    : undefined
  const checkpoints: ConnectorPollCheckpointStore = {
    async get(_key: ConnectorPollCheckpointKey) {
      return checkpoint ? structuredClone(checkpoint) : undefined
    },
    async compareAndSet(input) {
      commits.push(structuredClone(input))
      if (input.expectedRevision !== checkpoint?.revision) return false
      checkpoint = {
        revision: (checkpoint?.revision ?? 0) + 1,
        ...(input.nextCursor ? { cursor: input.nextCursor } : {}),
      }
      return true
    },
  }
  const dependencies: ConnectorSyncWorkerDependencies = {
    platform: {
      async listConnectors() {
        return structuredClone(installations)
      },
      async listExternalWorkItemLinks(request) {
        linkListCalls.push(structuredClone(request))
        return structuredClone(links.filter((link) =>
          (request.teamId === undefined || link.teamId === request.teamId) &&
          (request.workItemId === undefined || link.workItemId === request.workItemId) &&
          (request.installationId === undefined ||
            link.installationId === request.installationId)
        ))
      },
      async pauseConnectorExternalLinksPage(request) {
        pauseCalls.push(structuredClone(request))
        return structuredClone(disconnectPages.shift() ?? { paused: 0 })
      },
    },
    async getEngine() {
      engineLoads += 1
      if (options.engineError) throw options.engineError
      return {
        async processOutbound(input) {
          outboundCalls.push(structuredClone(input))
          return {
            kind: 'skipped',
            linkId: input.link.id,
            reason: 'duplicate',
          }
        },
        async pollInstallation(input) {
          pollCalls.push(structuredClone(input))
          const nextCursor = pollCursors.shift()
          return {
            results: [],
            ...(nextCursor ? { nextCursor } : {}),
          }
        },
      }
    },
    queue: {
      async enqueue(message) {
        queued.push(structuredClone(message))
      },
    },
    checkpoints,
    ...(options.inventory ? { inventory: options.inventory } : {}),
    ...(options.maximumDisconnectLinks === undefined
      ? {}
      : { maximumDisconnectLinks: options.maximumDisconnectLinks }),
  }
  return {
    dependencies,
    links,
    installations,
    queued,
    outboundCalls,
    pollCalls,
    linkListCalls,
    pauseCalls,
    commits,
    readEngineLoads: () => engineLoads,
    readCheckpoint: () => checkpoint ? structuredClone(checkpoint) : undefined,
  }
}

function createLink(): ExternalWorkItemLink {
  return {
    id: 'link-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    installationId: 'installation-1',
    resourceType: 'issue',
    externalId: '29',
    externalUrl: 'https://external.test/issues/29',
    syncDirection: 'bidirectional',
    syncStatus: 'synced',
    createdAt: now,
    updatedAt: now,
  }
}

function createInstallation(): ConnectorInstallation {
  return {
    id: 'installation-1',
    category: 'source-control',
    provider: 'github',
    name: 'GitHub',
    status: 'connected',
    scopes: ['repo'],
    installedByUserId: 'installer-1',
    installedAt: now,
    updatedAt: now,
  }
}

function createWorkItemAuditEvent(idempotencyKey: string, source: {
  kind: 'api' | 'system'
  requestId: string
  route: string
}) {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey,
    occurredAt: now,
    request: {
      method: 'PATCH',
      path: source.route,
      body: { title: 'Current title' },
    },
    source,
  })
  return createAuditEvent({
    context,
    eventType: 'work-item.updated',
    entity: {
      type: 'work-item',
      id: 'team/team-1/issue/work-item-1',
    },
    action: 'updated',
    metadata: {
      adapter: 'canonical-work-item',
      teamId: 'team-1',
      issueId: 'work-item-1',
    },
    expiresAt: Math.floor(Date.parse(now) / 1_000) + 86_400,
  })
}

function createExternalLinkAuditEvent() {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'create-external-link',
    occurredAt: now,
    request: {
      method: 'POST',
      path: '/api/developer/external-links',
      body: { externalLinkId: 'link-1' },
    },
    source: {
      kind: 'api',
      requestId: 'request-external-link-1',
      route: '/api/developer/external-links',
    },
  })
  return createAuditEvent({
    context,
    eventType: 'external-link.created',
    entity: { type: 'external-link', id: 'link-1' },
    action: 'created',
    metadata: {
      externalLinkId: 'link-1',
      installationId: 'installation-1',
      resourceType: 'issue',
      syncDirection: 'bidirectional',
    },
    expiresAt: Math.floor(Date.parse(now) / 1_000) + 86_400,
  })
}

function createConnectorDisconnectAuditEvent() {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'connector-disconnect-installation-1-revision-4',
    occurredAt: now,
    request: {
      method: 'EVENT',
      path: '/developer-platform/connector-installation/installation-1',
      body: { transitionId: 'status:4:1' },
    },
    source: {
      kind: 'system',
      requestId: 'developer-platform-disconnect-1',
    },
  })
  return createAuditEvent({
    context,
    eventType: 'connector.status.updated',
    entity: { type: 'connector-installation', id: 'installation-1' },
    action: 'status-updated',
    metadata: {
      adapter: 'developer-platform',
      previousStatus: 'connected',
      status: 'disconnected',
      disconnectCleanupRevision: 4,
    },
    expiresAt: Math.floor(Date.parse(now) / 1_000) + 86_400,
  })
}

function createConnectorDisconnectedLinkAuditEvent() {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'connector-disconnected-link-1',
    occurredAt: now,
    request: {
      method: 'EVENT',
      path: '/developer-platform/external-link/link-1',
      body: { transitionId: 'connector-disconnect:4' },
    },
    source: {
      kind: 'system',
      requestId: 'developer-platform-connector-disconnect-link-1',
    },
  })
  return createAuditEvent({
    context,
    eventType: 'external-link.updated',
    entity: { type: 'external-link', id: 'link-1' },
    action: 'paused',
    metadata: {
      externalLinkId: 'link-1',
      workItemId: 'work-item-1',
      installationId: 'installation-1',
      resourceType: 'issue',
      previousSyncDirection: 'bidirectional',
      syncDirection: 'bidirectional',
      previousSyncStatus: 'synced',
      syncStatus: 'paused',
      cause: 'connector-disconnected',
    },
    expiresAt: Math.floor(Date.parse(now) / 1_000) + 86_400,
  })
}

function marshallRecord(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, marshallValue(item)]),
  )
}

function marshallValue(value: unknown): ConnectorSyncDynamoAttributeValue {
  if (typeof value === 'string') return { S: value }
  if (typeof value === 'number') return { N: String(value) }
  if (typeof value === 'boolean') return { BOOL: value }
  if (value === null) return { NULL: true }
  if (Array.isArray(value)) return { L: value.map(marshallValue) }
  if (typeof value === 'object') {
    return { M: marshallRecord(value as Record<string, unknown>) }
  }
  throw new TypeError('Unsupported test DynamoDB value.')
}
