import { expect, test } from 'bun:test'
import {
  createAuditEvent,
  createMutationAuditContext,
} from './audit'
import {
  InMemoryDeveloperPlatformClient,
  LocalAesGcmSecretProtector,
} from './developer-platform'
import {
  processWebhookDeliveryBatch,
  processWebhookProjectionBatch,
  type WebhookDeliveryQueue,
  type WebhookDynamoAttributeValue,
  type WebhookQueueMessage,
} from './webhook-handler'

test('projects one deterministic secret-free delivery from a pending audit event', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const platform = createPlatform(() => now)
  await createSubscription(platform)
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
    developerPlatform: platform,
    authorizer: { canDeliver: async () => true },
    queue: createRecordingQueue(queued),
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(queued).toHaveLength(1)
  expect(queued[0]).toEqual({
    workspaceId: 'workspace-1',
    deliveryId: expect.stringMatching(/^delivery_/),
  })
  expect(JSON.stringify(queued)).not.toContain('whsec_')
  const page = await platform.listWebhookDeliveries({ workspaceId: 'workspace-1' })
  expect(page.deliveries).toHaveLength(1)
  expect(page.deliveries[0]).toMatchObject({
    eventId: event.eventId,
    eventType: 'work-item.created',
    status: 'pending',
    attempts: 0,
  })
  const prepared = await platform.prepareWebhookDelivery({
    workspaceId: 'workspace-1',
    deliveryId: page.deliveries[0]!.id,
  })
  expect(JSON.parse(prepared.payload)).toMatchObject({
    id: event.eventId,
    type: 'work-item.created',
    apiVersion: '2026-07-01',
    workspaceId: 'workspace-1',
  })
})

test('skips delivery when the subscription creator lost current Team access', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const platform = createPlatform(() => now)
  await createSubscription(platform)
  const queued: WebhookQueueMessage[] = []
  const response = await processWebhookProjectionBatch({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: '102',
        NewImage: marshallRecord(createWorkItemAuditEvent(now)),
      },
    }],
  }, {
    developerPlatform: platform,
    authorizer: { canDeliver: async () => false },
    queue: createRecordingQueue(queued),
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(queued).toEqual([])
  expect(await platform.listWebhookDeliveries({ workspaceId: 'workspace-1' }))
    .toMatchObject({ deliveries: [] })
})

test('records a successful signed HTTP attempt in the delivery log', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const fixture = await createDeliveryFixture(() => now)
  let deliveredPayload = ''

  const response = await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId)],
  }, {
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => true },
    queue: createRecordingQueue([]),
    now: () => now,
    random: () => 0.5,
    async deliver(prepared) {
      deliveredPayload = prepared.payload
      expect(prepared.signingSecret).toMatch(/^mk_webhook_/)
      return { succeeded: true, retryable: false, responseStatus: 204 }
    },
  })

  expect(response).toEqual({ batchItemFailures: [] })
  expect(deliveredPayload).toContain('work-item.created')
  const page = await fixture.platform.listWebhookDeliveries({ workspaceId: 'workspace-1' })
  expect(page.deliveries[0]).toMatchObject({
    status: 'delivered',
    attempts: 1,
    responseStatus: 204,
    deliveredAt: now.toISOString(),
  })
})

test('blocks a queued replay after the subscription creator loses access', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z')
  const fixture = await createDeliveryFixture(() => now)
  let deliveryCalls = 0

  const response = await processWebhookDeliveryBatch({
    Records: [createSqsRecord(fixture.deliveryId)],
  }, {
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => false },
    queue: createRecordingQueue([]),
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
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => true },
    queue: createRecordingQueue(queued),
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
  expect(queued.at(-1)?.delaySeconds).toBe(45)

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
    developerPlatform: fixture.platform,
    authorizer: { canDeliver: async () => true },
    queue: createRecordingQueue([]),
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

async function createSubscription(platform: InMemoryDeveloperPlatformClient) {
  return await platform.createWebhookSubscription({
    workspaceId: 'workspace-1',
    createdByUserId: 'creator-1',
    input: {
      name: 'Work Item automation',
      url: 'https://hooks.example.com/mukuroji',
      teamIds: ['team-1'],
      eventTypes: ['work-item.created'],
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

function createSqsRecord(deliveryId: string, messageId = 'message-1') {
  return {
    messageId,
    body: JSON.stringify({ workspaceId: 'workspace-1', deliveryId }),
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
