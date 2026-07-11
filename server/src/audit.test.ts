import { expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  AUDIT_TARGET_INDEX_NAME,
  auditEventsToNdjson,
  createAuditConsumerReceiptTransactPut,
  createAuditEvent,
  createAuditFieldChanges,
  createAuditTransactPut,
  createMutationAuditContext,
  DynamoDbAuditEventsClient,
  ensureLocalAuditEventsTable,
  toAuditEventView,
  upcastAuditEvent,
} from './audit'

test('creates deterministic audit IDs and CDK-compatible DynamoDB keys', () => {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: {
      id: 'actor-1',
      kind: 'user',
      displayName: 'Demo User',
    },
    idempotencyKey: 'request-1',
    correlationId: 'correlation-1',
    occurredAt: '2026-07-11T12:00:00.000Z',
    request: {
      method: 'PATCH',
      path: '/api/work-items/item-1',
      body: { status: 'done' },
    },
    source: {
      kind: 'api',
      requestId: 'request-id-1',
    },
  })
  const first = createAuditEvent({
    context,
    eventType: 'work-item.updated',
    entity: { type: 'work-item', id: 'item-1' },
    action: 'updated',
    before: { status: 'todo' },
    after: { status: 'done' },
  })
  const second = createAuditEvent({
    context,
    eventType: 'work-item.updated',
    entity: { type: 'work-item', id: 'item-1' },
    action: 'updated',
    before: { status: 'todo' },
    after: { status: 'done' },
  })
  const retryAfterGeneratedIdChanged = createAuditEvent({
    context,
    eventType: 'work-item.created',
    entity: { type: 'work-item', id: 'item-2' },
    action: 'created',
    after: { status: 'todo' },
  })
  const otherActorContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-2', kind: 'user' },
    idempotencyKey: 'request-1',
    occurredAt: '2026-07-11T12:00:00.000Z',
    request: { method: 'PATCH', path: '/api/work-items/item-1' },
    source: { kind: 'api' },
  })
  const otherActorEvent = createAuditEvent({
    context: otherActorContext,
    eventType: 'work-item.updated',
    entity: { type: 'work-item', id: 'item-1' },
  })

  expect(second.eventId).toBe(first.eventId)
  expect(retryAfterGeneratedIdChanged.eventId).toBe(first.eventId)
  expect(otherActorEvent.eventId).not.toBe(first.eventId)
  expect(first).toMatchObject({
    directoryId: 'workspace-1',
    workspaceId: 'workspace-1',
    workspaceKey: 'workspace-1',
    actorKey: 'workspace-1#actor#actor-1',
    entityKey: 'workspace-1#work-item#item-1',
    targetKey: 'workspace-1#work-item#item-1',
    workspaceEventKey: first.occurredAtEventId,
    actorEventKey: first.occurredAtEventId,
    entityEventKey: first.occurredAtEventId,
    targetEventKey: first.occurredAtEventId,
    source: 'api',
    outboxStatus: 'pending',
  })
})

test('creates field changes with default and explicit redaction', () => {
  const changes = createAuditFieldChanges(
    {
      profile: {
        email: 'before@example.com',
        token: 'old-token',
      },
      status: 'todo',
    },
    {
      profile: {
        email: 'after@example.com',
        token: 'new-token',
      },
      status: 'done',
    },
    ['profile', 'status'],
    ['profile.email'],
  )

  expect(changes).toEqual([
    {
      field: 'profile.email',
      before: '[REDACTED]',
      after: '[REDACTED]',
      redacted: true,
    },
    {
      field: 'profile.token',
      before: '[REDACTED]',
      after: '[REDACTED]',
      redacted: true,
    },
    {
      field: 'status',
      before: 'todo',
      after: 'done',
    },
  ])
})

test('sanitizes direct changes and metadata before persistence', () => {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'request-sanitize',
    occurredAt: '2026-07-11T12:00:00.000Z',
    request: { method: 'PATCH', path: '/api/work-items/item-1' },
    source: { kind: 'api' },
  })
  const longValue = 'x'.repeat(5_000)
  const event = createAuditEvent({
    context,
    eventType: 'work-item.updated',
    entity: { type: 'work-item', id: 'item-1' },
    changes: [
      { field: 'apiKey', after: 'plain-secret' },
      { field: 'description', after: longValue },
    ],
    metadata: {
      signedUrl: 'https://example.invalid/private',
      note: longValue,
    },
  })

  expect(event.changes[0]).toEqual({
    field: 'apiKey',
    after: '[REDACTED]',
    redacted: true,
  })
  expect(String(event.changes[1]?.after)).toHaveLength(4_096)
  expect(event.metadata?.signedUrl).toBe('[REDACTED]')
  expect(String(event.metadata?.note)).toHaveLength(4_096)
  const view = toAuditEventView({
    ...event,
    metadata: {
      adapter: 'team-issue',
      legacyKey: 'workspace-1#internal-partition',
    },
  })

  expect(view.metadata).toEqual({ adapter: 'team-issue' })
})

test('creates a conditional audit transaction Put', () => {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'request-1',
    occurredAt: '2026-07-11T12:00:00.000Z',
    request: { method: 'POST', path: '/api/projects' },
    source: { kind: 'api' },
  })
  const event = createAuditEvent({
    context,
    eventType: 'project.created',
    entity: { type: 'project', id: 'project-1' },
    after: { name: 'Project 1' },
  })

  expect(createAuditTransactPut('AuditTable', event)).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        directoryId: 'workspace-1',
        eventId: event.eventId,
      },
      ConditionExpression: 'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  })
})

test('creates a conditional consumer receipt for at-least-once delivery', () => {
  expect(createAuditConsumerReceiptTransactPut('ProcessedEvents', {
    consumerName: 'notifications',
    eventId: 'evt_123',
    processedAt: '2026-07-11T12:00:00.000Z',
    expiresAt: 2_000_000_000,
  })).toEqual({
    Put: {
      TableName: 'ProcessedEvents',
      Item: {
        consumerName: 'notifications',
        eventId: 'evt_123',
        processedAt: '2026-07-11T12:00:00.000Z',
        expiresAt: 2_000_000_000,
      },
      ConditionExpression: 'attribute_not_exists(#consumerName) AND attribute_not_exists(#eventId)',
      ExpressionAttributeNames: {
        '#consumerName': 'consumerName',
        '#eventId': 'eventId',
      },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  })
})

test('queries the target timeline and binds cursor to the original filters', async () => {
  const commands: Array<Record<string, unknown>> = []
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'request-1',
    occurredAt: '2026-07-11T12:00:00.000Z',
    request: { method: 'POST', path: '/api/comments' },
    source: { kind: 'api' },
  })
  const event = createAuditEvent({
    context,
    eventType: 'comment.created',
    entity: { type: 'work-item', id: 'item-1' },
    target: { type: 'comment', id: 'comment-1' },
    after: { body: 'Hello' },
  })
  let page = 0
  const documentClient = {
    send: async (command: { input: Record<string, unknown> }) => {
      commands.push(command.input)
      page += 1

      return page === 1
        ? {
            Items: [event],
            LastEvaluatedKey: {
              directoryId: event.directoryId,
              eventId: event.eventId,
              targetKey: event.targetKey,
              targetEventKey: event.targetEventKey,
            },
          }
        : { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbAuditEventsClient(documentClient, 'AuditTable')
  const firstPage = await client.query({
    workspaceId: 'workspace-1',
    targetType: 'comment',
    targetId: 'comment-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-31T23:59:59.999Z',
    limit: 25,
  })
  const secondPage = await client.query({
    workspaceId: 'workspace-1',
    targetType: 'comment',
    targetId: 'comment-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-31T23:59:59.999Z',
    limit: 25,
    cursor: firstPage.nextCursor,
  })

  expect(firstPage.events).toHaveLength(1)
  expect(secondPage.events).toEqual([])
  expect(commands[0]).toMatchObject({
    TableName: 'AuditTable',
    IndexName: AUDIT_TARGET_INDEX_NAME,
    Limit: 25,
    ScanIndexForward: false,
    ExpressionAttributeValues: {
      ':partitionValue': 'workspace-1#comment#comment-1',
      ':workspaceId': 'workspace-1',
    },
  })
  expect(commands[1]?.ExclusiveStartKey).toEqual({
    directoryId: event.directoryId,
    eventId: event.eventId,
    targetKey: event.targetKey,
    targetEventKey: event.targetEventKey,
  })

  const forgedCursorPayload = JSON.parse(
    Buffer.from(firstPage.nextCursor ?? '', 'base64url').toString('utf8'),
  ) as { lastEvaluatedKey: Record<string, unknown> }
  forgedCursorPayload.lastEvaluatedKey.targetKey = 'workspace-1#comment#other-comment'
  const forgedCursor = Buffer.from(JSON.stringify(forgedCursorPayload), 'utf8').toString('base64url')

  await expect(client.query({
    workspaceId: 'workspace-1',
    targetType: 'comment',
    targetId: 'comment-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-31T23:59:59.999Z',
    limit: 25,
    cursor: forgedCursor,
  })).rejects.toThrow('Audit cursor does not match the query partition.')
})

test('upcasts legacy issue activity without inventing an unavailable diff', () => {
  const event = upcastAuditEvent({
    directoryTeamIssueId: 'workspace-1#team#team-1#issue#issue-1',
    eventId: '2026-07-11T12:00:00.000Z#updated#legacy',
    directoryId: 'workspace-1',
    teamId: 'team-1',
    issueId: 'issue-1',
    eventType: 'updated',
    actorUserId: 'actor-1',
    summary: 'Issue was updated.',
    createdAt: '2026-07-11T12:00:00.000Z',
  })

  expect(event).toMatchObject({
    schemaVersion: 1,
    directoryId: 'workspace-1',
    eventType: 'work-item.updated',
    entityType: 'work-item',
    entityId: 'team/team-1/issue/issue-1',
    targetType: 'work-item',
    targetId: 'team/team-1/issue/issue-1',
    changes: [],
    source: 'backfill',
    outboxStatus: 'suppressed',
    metadata: {
      backfilled: true,
      diffUnavailable: true,
    },
  })
})

test('exports schema-normalized events as newline-delimited JSON', async () => {
  const output = await auditEventsToNdjson([
    {
      directoryTeamIssueId: 'workspace-1#team#team-1#issue#issue-1',
      eventId: 'legacy-comment',
      directoryId: 'workspace-1',
      teamId: 'team-1',
      issueId: 'issue-1',
      eventType: 'commented',
      actorUserId: 'actor-1',
      body: 'Hello',
      createdAt: '2026-07-11T12:00:00.000Z',
    },
  ])
  const lines = output.trimEnd().split('\n')

  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    schemaVersion: 1,
    eventType: 'comment.created',
    targetType: 'comment',
  })
  expect(JSON.parse(lines[0] ?? '{}')).not.toHaveProperty('requestFingerprint')
  expect(JSON.parse(lines[0] ?? '{}')).not.toHaveProperty('idempotencyKeyHash')
  expect(JSON.parse(lines[0] ?? '{}')).not.toHaveProperty('workspaceKey')
  expect(JSON.parse(lines[0] ?? '{}')).not.toHaveProperty('sourceDetails')
})

test('bootstraps a local table with the CDK-compatible base key and GSIs', async () => {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const dynamoDbClient = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      commands.push({ name: command.constructor.name, input: command.input })

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            TableStatus: 'ACTIVE',
            KeySchema: [
              { AttributeName: 'directoryId', KeyType: 'HASH' },
              { AttributeName: 'eventId', KeyType: 'RANGE' },
            ],
            GlobalSecondaryIndexes: [
              {
                IndexName: 'WorkspaceOccurredAtIndex',
                KeySchema: [
                  { AttributeName: 'workspaceKey', KeyType: 'HASH' },
                  { AttributeName: 'workspaceEventKey', KeyType: 'RANGE' },
                ],
              },
              {
                IndexName: 'ActorOccurredAtIndex',
                KeySchema: [
                  { AttributeName: 'actorKey', KeyType: 'HASH' },
                  { AttributeName: 'actorEventKey', KeyType: 'RANGE' },
                ],
              },
              {
                IndexName: 'EntityOccurredAtIndex',
                KeySchema: [
                  { AttributeName: 'entityKey', KeyType: 'HASH' },
                  { AttributeName: 'entityEventKey', KeyType: 'RANGE' },
                ],
              },
              {
                IndexName: 'TargetOccurredAtIndex',
                KeySchema: [
                  { AttributeName: 'targetKey', KeyType: 'HASH' },
                  { AttributeName: 'targetEventKey', KeyType: 'RANGE' },
                ],
              },
            ],
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient

  await ensureLocalAuditEventsTable('AuditTable', dynamoDbClient, { retryDelayMs: 0 })

  expect(commands.map((command) => command.name)).toEqual([
    'CreateTableCommand',
    'DescribeTableCommand',
  ])
  expect(commands[0]?.input).toMatchObject({
    TableName: 'AuditTable',
    KeySchema: [
      { AttributeName: 'directoryId', KeyType: 'HASH' },
      { AttributeName: 'eventId', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    StreamSpecification: {
      StreamEnabled: true,
      StreamViewType: 'NEW_IMAGE',
    },
  })
})
