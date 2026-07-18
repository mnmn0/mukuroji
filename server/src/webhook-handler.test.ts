import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  createAuditEvent,
  createMutationAuditContext,
} from './audit'
import {
  InMemoryDeveloperPlatformClient,
  LocalAesGcmSecretProtector,
} from './developer-platform'
import {
  DynamoDbWebhookAuditEventReader,
  DynamoDbWebhookDeliveryClaimStore,
  WEBHOOK_PROJECTION_CONCURRENCY,
  WEBHOOK_PROJECTION_PAGE_SIZE,
  processWebhookDeliveryBatch,
  processWebhookProjectionBatch,
  type WebhookDeliveryClaimStore,
  type WebhookDeliveryQueue,
  type WebhookDynamoAttributeValue,
  type WebhookQueueMessage,
} from './webhook-handler'

test('queues an ID-only durable projection locator from a pending audit event', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const queued: WebhookQueueMessage[] = []
  const event = createWorkItemAuditEvent(now)

  const response = await processWebhookProjectionBatch({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: '101',
        NewImage: marshallRecord(event),
      },
    }],
  }, {
    queue: createRecordingQueue(queued),
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(queued).toHaveLength(1)
  expect(queued[0]).toEqual({
    kind: 'projection',
    workspaceId: 'workspace-1',
    eventId: event.eventId,
  })
  expect(JSON.stringify(queued)).not.toContain('mk_webhook_')
  expect(JSON.stringify(queued)).not.toContain('metadata')
})

test('projects one bounded subscription page and queues a durable continuation', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const platform = createPlatform(() => now)
  const matching = await Promise.all(Array.from({ length: 13 }, async (_, index) =>
    await createSubscription(platform, {
      name: `Matching subscription ${String(index)}`,
    })
  ))
  const wrongEvent = await createSubscription(platform, {
    name: 'Wrong event subscription',
    eventTypes: ['work-item.updated'],
  })
  const wrongTeam = await createSubscription(platform, {
    name: 'Wrong Team subscription',
    teamIds: ['team-2'],
  })
  const disabled = await createSubscription(platform, {
    name: 'Disabled subscription',
  })
  await platform.setWebhookSubscriptionStatus({
    workspaceId: 'workspace-1',
    subscriptionId: disabled.subscription.id,
    status: 'disabled',
  })
  const subscriptions = await platform.listWebhookSubscriptions('workspace-1')
  const pageRequests: Array<{ workspaceId: string; cursor?: string; limit?: number }> = []
  platform.listActiveWebhookSubscriptionsPage = async (request) => {
    pageRequests.push(request)
    return { subscriptions, nextCursor: 'subscription-page-2' }
  }

  const queued: WebhookQueueMessage[] = []
  const event = createWorkItemAuditEvent(now)
  let concurrentAuthorizations = 0
  let maxConcurrentAuthorizations = 0
  const authorizationIds: string[] = []
  const deniedSubscriptionId = matching.at(-1)!.subscription.id
  const response = await processWebhookDeliveryBatch({
    Records: [createProjectionSqsRecord(event.eventId)],
  }, {
    auditEvents: { getEvent: async () => event },
    developerPlatform: platform,
    authorizer: {
      async canDeliver(_workspaceId, subscription) {
        authorizationIds.push(subscription.id)
        concurrentAuthorizations += 1
        maxConcurrentAuthorizations = Math.max(
          maxConcurrentAuthorizations,
          concurrentAuthorizations,
        )
        await Promise.resolve()
        concurrentAuthorizations -= 1
        return subscription.id !== deniedSubscriptionId
      },
    },
    queue: createRecordingQueue(queued),
    claims: createMemoryClaimStore(),
    now: () => now,
    random: () => 0.5,
    async deliver() {
      throw new Error('Projection must not perform HTTP delivery.')
    },
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(pageRequests).toEqual([{
    workspaceId: 'workspace-1',
    limit: WEBHOOK_PROJECTION_PAGE_SIZE,
  }])
  expect(maxConcurrentAuthorizations).toBe(WEBHOOK_PROJECTION_CONCURRENCY)
  expect(authorizationIds.sort()).toEqual(
    matching.map(({ subscription }) => subscription.id).sort(),
  )
  expect(authorizationIds).not.toContain(wrongEvent.subscription.id)
  expect(authorizationIds).not.toContain(wrongTeam.subscription.id)
  expect(authorizationIds).not.toContain(disabled.subscription.id)
  expect(queued.filter((message) => message.kind === 'delivery')).toHaveLength(12)
  expect(queued.at(-1)).toEqual({
    kind: 'projection',
    workspaceId: 'workspace-1',
    eventId: event.eventId,
    cursor: 'subscription-page-2',
  })
  const deliveries = await platform.listWebhookDeliveries({ workspaceId: 'workspace-1' })
  expect(deliveries.deliveries).toHaveLength(12)
})

test('records a successful signed HTTP attempt in the delivery log', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const fixture = await createDeliveryFixture(() => now)
  let deliveredPayload = ''
  let batchAuthorizerCreations = 0

  const response = await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId)],
  }, {
    auditEvents: createMissingAuditReader(),
    developerPlatform: fixture.platform,
    authorizer: {
      async canDeliver() {
        throw new Error('The unscoped authorizer must not be used for a Lambda batch.')
      },
      createBatch() {
        batchAuthorizerCreations += 1
        return { canDeliver: async () => true }
      },
    },
    queue: createRecordingQueue([]),
    claims: createMemoryClaimStore(),
    now: () => now,
    random: () => 0.5,
    async deliver(prepared) {
      deliveredPayload = prepared.payload
      expect(prepared.signingSecret).toMatch(/^mk_webhook_/)
      return { succeeded: true, retryable: false, responseStatus: 204 }
    },
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(batchAuthorizerCreations).toBe(1)
  expect(deliveredPayload).toContain('work-item.created')
  const page = await fixture.platform.listWebhookDeliveries({ workspaceId: 'workspace-1' })
  expect(page.deliveries[0]).toMatchObject({
    status: 'delivered',
    attempts: 1,
    responseStatus: 204,
    deliveredAt: now.toISOString(),
  })
})

test('claims a delivery ID before HTTP and retries a concurrent duplicate', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const fixture = await createDeliveryFixture(() => now)
  let deliveryCalls = 0
  const response = await processWebhookDeliveryBatch({
    Records: [
      createSqsRecord(fixture.deliveryId, 'message-first'),
      createSqsRecord(fixture.deliveryId, 'message-duplicate'),
    ],
  }, {
    auditEvents: createMissingAuditReader(),
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => true },
    queue: createRecordingQueue([]),
    claims: createMemoryClaimStore(),
    now: () => now,
    random: () => 0.5,
    async deliver() {
      deliveryCalls += 1
      await Promise.resolve()
      return { succeeded: true, retryable: false, responseStatus: 204 }
    },
  })

  expect(response).toEqual({
    batchItemFailures: [{ itemIdentifier: 'message-duplicate' }],
  })
  expect(deliveryCalls).toBe(1)
})

test('does not acknowledge a redelivery while a failed attempt lease is active', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const fixture = await createDeliveryFixture(() => now)
  const claims = createMemoryClaimStore()
  const originalRecordAttempt =
    fixture.platform.recordWebhookDeliveryAttempt.bind(fixture.platform)
  let persistenceFails = true
  fixture.platform.recordWebhookDeliveryAttempt = async (request) => {
    if (persistenceFails) {
      persistenceFails = false
      throw new Error('DynamoDB transaction is temporarily unavailable.')
    }
    return originalRecordAttempt(request)
  }
  let deliveryCalls = 0
  const dependencies = {
    auditEvents: createMissingAuditReader(),
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => true },
    queue: createRecordingQueue([]),
    claims,
    now: () => now,
    random: () => 0.5,
    async deliver() {
      deliveryCalls += 1
      return { succeeded: true, retryable: false, responseStatus: 204 }
    },
  }

  const first = await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId, 'message-first')],
  }, dependencies)
  const redelivery = await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId, 'message-redelivery')],
  }, dependencies)

  expect(first).toEqual({
    batchItemFailures: [{ itemIdentifier: 'message-first' }],
  })
  expect(redelivery).toEqual({
    batchItemFailures: [{ itemIdentifier: 'message-redelivery' }],
  })
  expect(deliveryCalls).toBe(1)
})

test('uses an expiring conditional DynamoDB row for delivery claims', async () => {
  const commands: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = []
  let claimed = false
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push(command)
      if (command.constructor.name === 'UpdateCommand') {
        if (claimed) throw { name: 'ConditionalCheckFailedException' }
        claimed = true
      }
      if (command.constructor.name === 'DeleteCommand') claimed = false
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const store = new DynamoDbWebhookDeliveryClaimStore(
    documentClient,
    'developer-platform-test',
  )
  const request = {
    workspaceId: 'workspace-1',
    deliveryId: 'delivery-1',
    leaseOwner: 'worker-1',
    now: '2026-07-18T00:00:00.000Z',
    leaseExpiresAt: '2026-07-18T00:01:30.000Z',
  }

  await expect(store.tryClaim(request)).resolves.toBe(true)
  await expect(store.tryClaim({ ...request, leaseOwner: 'worker-2' }))
    .resolves.toBe(false)
  await store.release(request)
  await expect(store.tryClaim({ ...request, leaseOwner: 'worker-3' }))
    .resolves.toBe(true)
  expect(commands[0]?.input).toMatchObject({
    ConditionExpression: expect.stringContaining('leaseExpiresAt < :now'),
    Key: {
      workspaceId: 'workspace-1',
      recordKey: 'WEBHOOKDELIVERYCLAIM#delivery-1',
    },
  })
})

test('strongly reads a Workspace-bound Audit event for projection', async () => {
  const event = createWorkItemAuditEvent(new Date('2026-07-18T00:00:00.000Z'))
  const commands: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = []
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push(command)
      return { Item: event }
    },
  } as unknown as DynamoDBDocumentClient
  const reader = new DynamoDbWebhookAuditEventReader(documentClient, 'audit-events-test')

  await expect(reader.getEvent('workspace-1', event.eventId)).resolves.toEqual(event)
  expect(commands[0]).toMatchObject({
    constructor: { name: 'GetCommand' },
    input: {
      TableName: 'audit-events-test',
      Key: { directoryId: 'workspace-1', eventId: event.eventId },
      ConsistentRead: true,
    },
  })
})

test('blocks a queued replay after the subscription creator loses access', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const fixture = await createDeliveryFixture(() => now)
  let deliveryCalls = 0

  const response = await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId)],
  }, {
    auditEvents: createMissingAuditReader(),
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => false },
    queue: createRecordingQueue([]),
    claims: createMemoryClaimStore(),
    now: () => now,
    random: () => 0.5,
    async deliver() {
      deliveryCalls += 1
      return { succeeded: true, retryable: false, responseStatus: 204 }
    },
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(deliveryCalls).toBe(0)
  const page = await fixture.platform.listWebhookDeliveries({ workspaceId: 'workspace-1' })
  expect(page.deliveries[0]).toMatchObject({ status: 'failed', attempts: 1 })
})

test('persists retry schedule and avoids an early duplicate HTTP attempt', async () => {
  let now = new Date('2026-07-18T00:00:00.000Z')
  const fixture = await createDeliveryFixture(() => now)
  const queued: WebhookQueueMessage[] = []
  let deliveryCalls = 0
  const dependencies = {
    auditEvents: createMissingAuditReader(),
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => true },
    queue: createRecordingQueue(queued),
    claims: createMemoryClaimStore(),
    now: () => now,
    random: () => 0.5,
    async deliver() {
      deliveryCalls += 1
      return deliveryCalls === 1
        ? {
            succeeded: false,
            retryable: true,
            responseStatus: 503,
            retryAfterSeconds: 45,
            error: 'Webhook endpoint is temporarily unavailable.',
          }
        : { succeeded: true, retryable: false, responseStatus: 200 }
    },
  }

  await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId)],
  }, dependencies)
  expect(deliveryCalls).toBe(1)
  expect(queued.at(-1)).toEqual({
    kind: 'delivery',
    workspaceId: 'workspace-1',
    deliveryId: fixture.deliveryId,
    delaySeconds: 45,
  })
  let page = await fixture.platform.listWebhookDeliveries({ workspaceId: 'workspace-1' })
  expect(page.deliveries[0]).toMatchObject({
    status: 'retrying',
    attempts: 1,
    responseStatus: 503,
    nextAttemptAt: '2026-07-18T00:00:45.000Z',
  })

  await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId, 'message-early')],
  }, dependencies)
  expect(deliveryCalls).toBe(1)
  expect(queued.at(-1)).toMatchObject({ kind: 'delivery', delaySeconds: 45 })

  now = new Date('2026-07-18T00:00:46.000Z')
  await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId, 'message-retry')],
  }, dependencies)
  expect(deliveryCalls).toBe(2)
  page = await fixture.platform.listWebhookDeliveries({ workspaceId: 'workspace-1' })
  expect(page.deliveries[0]).toMatchObject({
    status: 'delivered',
    attempts: 2,
    responseStatus: 200,
  })
})

test('records terminal rejection and isolates an invalid queue message', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const fixture = await createDeliveryFixture(() => now)
  const response = await processWebhookDeliveryBatch({
    Records: [
      createSqsRecord(fixture.deliveryId),
      { messageId: 'invalid-message', body: '{' },
    ],
  }, {
    auditEvents: createMissingAuditReader(),
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => true },
    queue: createRecordingQueue([]),
    claims: createMemoryClaimStore(),
    now: () => now,
    random: () => 0.5,
    async deliver() {
      return {
        succeeded: false,
        retryable: false,
        responseStatus: 422,
        error: 'Webhook endpoint rejected the delivery.',
      }
    },
  })

  expect(response).toEqual({
    batchItemFailures: [{ itemIdentifier: 'invalid-message' }],
  })
  const page = await fixture.platform.listWebhookDeliveries({ workspaceId: 'workspace-1' })
  expect(page.deliveries[0]).toMatchObject({
    status: 'failed',
    attempts: 1,
    responseStatus: 422,
  })
})

function createPlatform(clock: () => Date) {
  return new InMemoryDeveloperPlatformClient(
    new LocalAesGcmSecretProtector('webhook-handler-test-key-with-at-least-32-bytes'),
    clock,
  )
}

async function createSubscription(
  platform: InMemoryDeveloperPlatformClient,
  options: {
    name?: string
    teamIds?: string[]
    eventTypes?: Array<'work-item.created' | 'work-item.updated'>
  } = {},
) {
  return await platform.createWebhookSubscription({
    workspaceId: 'workspace-1',
    createdByUserId: 'creator-1',
    input: {
      name: options.name ?? 'Work Item automation',
      url: 'https://hooks.example.com/mukuroji',
      teamIds: options.teamIds ?? ['team-1'],
      eventTypes: options.eventTypes ?? ['work-item.created'],
      scopes: ['work-items:read'],
    },
  })
}

async function createDeliveryFixture(clock: () => Date) {
  const platform = createPlatform(clock)
  const subscription = await createSubscription(platform)
  const event = createWorkItemAuditEvent(clock())
  const deliveries = await platform.enqueueWebhookEvent({
    workspaceId: 'workspace-1',
    event: {
      id: event.eventId,
      type: 'work-item.created',
      apiVersion: '2026-07-01',
      occurredAt: event.occurredAt,
      workspaceId: 'workspace-1',
      data: { metadata: { teamId: 'team-1' }, workItemId: 'work-item-1' },
    },
    authorizedSubscriptionIds: [subscription.subscription.id],
  })
  return { platform, deliveryId: deliveries[0]!.id }
}

function createWorkItemAuditEvent(now: Date) {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'service-1', kind: 'service', displayName: 'Public API' },
    idempotencyKey: 'request-1',
    request: { method: 'POST', path: '/api/v1/work-items', body: { title: 'Ship API' } },
    source: { kind: 'api', requestId: 'request-1' },
    occurredAt: now.toISOString(),
  })
  return createAuditEvent({
    context,
    eventType: 'work-item.created',
    entity: { type: 'work-item', id: 'work-item-1' },
    action: 'created',
    summary: 'Work Item was created.',
    metadata: { teamId: 'team-1', issueId: 'work-item-1' },
    outboxStatus: 'pending',
    expiresAt: Math.floor(now.getTime() / 1_000) + 86_400,
  })
}

function createRecordingQueue(messages: WebhookQueueMessage[]): WebhookDeliveryQueue {
  return {
    async enqueue(message) {
      messages.push(message)
    },
  }
}

function createMemoryClaimStore(): WebhookDeliveryClaimStore {
  const claimed = new Set<string>()
  return {
    async tryClaim(request) {
      const key = `${request.workspaceId}\0${request.deliveryId}`
      if (claimed.has(key)) return false
      claimed.add(key)
      return true
    },
    async release(request) {
      claimed.delete(`${request.workspaceId}\0${request.deliveryId}`)
    },
  }
}

function createMissingAuditReader() {
  return { getEvent: async () => undefined }
}

function createSqsRecord(deliveryId: string, messageId = 'message-1') {
  return {
    messageId,
    body: JSON.stringify({ kind: 'delivery', workspaceId: 'workspace-1', deliveryId }),
  }
}

function createProjectionSqsRecord(eventId: string, messageId = 'projection-message-1') {
  return {
    messageId,
    body: JSON.stringify({ kind: 'projection', workspaceId: 'workspace-1', eventId }),
  }
}

function marshallRecord(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, marshallValue(item)]),
  )
}

function marshallValue(value: unknown): WebhookDynamoAttributeValue {
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
