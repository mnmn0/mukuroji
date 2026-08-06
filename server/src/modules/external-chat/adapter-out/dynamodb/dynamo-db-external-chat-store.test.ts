import { createHash } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  ExternalChatInboundEvent,
  ExternalChatMessageBinding,
  ExternalChatSyncOutcome,
  ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import { expect, spyOn, test } from 'bun:test'
import {
  createExternalChatFingerprint,
  createExternalChatSourceDigest,
  ExternalChatError,
} from '../../external-chat'
import type {
  ClaimExternalChatInboundEventInput,
  ClaimExternalChatThreadLifecycleInput,
  DeferredExternalChatOutboundEvent,
  ExternalChatParentLifecycleFence,
  ExternalChatSyncOutboundEvent,
  StoredExternalChatThreadLifecycle,
} from '../../external-chat'
import { DynamoDbExternalChatStore } from './dynamo-db-external-chat-store'
import {
  decodeDeferredExternalChatOutboundEvent,
  decodeStoredExternalChatLink,
  decodeStoredExternalChatThreadLifecycle,
} from './external-chat-codec'

/** Untrusted AWS command object inspected by adapter tests. */
type UnknownRecord = Record<string, unknown>

/** Script callback used by one mocked DocumentClient. */
type CommandResponder = {
  /**
   * Produces one AWS response or throws a modeled AWS error.
   *
   * @param command - Untrusted SDK command instance.
   * @param callIndex - Zero-based send invocation index.
   * @returns A modeled SDK response.
   */
  respond(command: unknown, callIndex: number): Promise<unknown>
}

/** DynamoDB mock harness returned to focused adapter tests. */
type DynamoDbTestHarness = {
  /** Store under test. */
  store: DynamoDbExternalChatStore
  /** Captured command names and inputs. */
  calls: Array<{
    /** SDK command constructor name. */
    name: string
    /** SDK command input. */
    input: UnknownRecord
  }>
  /** Restores the mocked SDK method. */
  restore(): void
}

/** Stable test timestamp. */
const NOW = '2026-08-06T00:00:00.000Z'

/** Stable future receipt lease. */
const LEASE = '2026-08-06T00:05:00.000Z'

/** Stable SHA-256 fixture digest. */
const DIGEST = 'a'.repeat(64)

test('decodes a retention-redacted link without optional source metadata', () => {
  const current = createLink()
  const decoded = decodeStoredExternalChatLink({
    workspaceId: 'workspace-1',
    link: {
      ...current,
      workspace: {
        provider: current.workspace.provider,
        externalId: current.workspace.externalId,
      },
      conversation: {
        externalId: current.conversation.externalId,
        externalWorkspaceId: current.conversation.externalWorkspaceId,
        kind: current.conversation.kind,
      },
      source: {
        externalWorkspaceId: current.source.externalWorkspaceId,
        conversationExternalId: current.source.conversationExternalId,
        threadExternalId: current.source.threadExternalId,
        rootMessageExternalId: current.source.rootMessageExternalId,
      },
      sourceAvailability: 'permission-lost',
      sourceState: 'retention-expired',
    },
    sourceDigest: DIGEST,
    sourceAuthorizationRevision: 1,
    active: true,
  })

  expect(decoded.link.workspace).not.toHaveProperty('displayName')
  expect(decoded.link.conversation).not.toHaveProperty('displayName')
  expect(decoded.link.source).not.toHaveProperty('sourcePermalink')
  expect(decoded.link.source).not.toHaveProperty('quotedRange')
  expect(decoded.sourceAuthorizationRevision).toBe(1)
})

test('strictly decodes completed thread lifecycle state and its replay outcome', () => {
  const value: StoredExternalChatThreadLifecycle = {
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    ownerLinkRevision: 1,
    state: {
      completed: true,
      lastExternalVersion: 'version-2',
      lastInternalWorkItemRevision: 8,
      revision: 1,
      updatedAt: '2026-08-06T00:01:00.000Z',
    },
    lease: {
      operationId: 'lifecycle-1',
      attempt: 1,
      status: 'completed',
      leaseExpiresAt: LEASE,
      completedAt: '2026-08-06T00:01:00.000Z',
      completedOutcome: {
        kind: 'applied',
        operationId: 'lifecycle-1',
        direction: 'inbound',
        occurredAt: '2026-08-06T00:01:00.000Z',
      },
    },
  }
  expect(decodeStoredExternalChatThreadLifecycle(value)).toEqual(value)
  expect(() => decodeStoredExternalChatThreadLifecycle({
    ...value,
    lease: {
      ...value.lease,
      completedOutcome: undefined,
    },
  })).toThrow(ExternalChatError)
  expect(() => decodeStoredExternalChatThreadLifecycle({
    ...value,
    state: {
      ...value.state,
      lastInternalWorkItemRevision: 0,
    },
  })).toThrow(ExternalChatError)
  expect(decodeStoredExternalChatThreadLifecycle({
    ...value,
    lease: {
      operationId: value.lease.operationId,
      attempt: value.lease.attempt,
      status: 'acknowledged',
      leaseExpiresAt: value.lease.leaseExpiresAt,
    },
  })).toMatchObject({ lease: { status: 'acknowledged' } })
  expect(() => decodeStoredExternalChatThreadLifecycle({
    ...value,
    lease: {
      ...value.lease,
      status: 'acknowledged',
    },
  })).toThrow(ExternalChatError)
})

test('strictly decodes the complete deferred outbound event envelope', () => {
  const deferred = createDeferredOutboundEvent()
  expect(decodeDeferredExternalChatOutboundEvent(deferred)).toEqual(deferred)
  expect(() => decodeDeferredExternalChatOutboundEvent({
    ...deferred,
    unexpectedSecret: 'must-not-survive',
  })).toThrow(ExternalChatError)
  expect(() => decodeDeferredExternalChatOutboundEvent({
    ...deferred,
    event: {
      ...deferred.event,
      unexpectedPayload: 'must-not-survive',
    },
  })).toThrow(ExternalChatError)
  expect(() => decodeDeferredExternalChatOutboundEvent({
    ...deferred,
    event: {
      ...deferred.event,
      internalCommentVersion: 0,
    },
  })).toThrow(ExternalChatError)
})

/** Creates one complete provider-neutral external chat link fixture. */
function createLink(
  id = 'link-1',
  revision = 1,
): ExternalChatWorkItemLink {
  return {
    schemaVersion: 1,
    id,
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
      displayName: 'Synthetic channel',
    },
    source: {
      externalWorkspaceId: 'workspace-external-1',
      conversationExternalId: 'conversation-external-1',
      threadExternalId: 'thread-external-1',
      rootMessageExternalId: 'message-root-1',
      sourcePermalink: 'https://chat.example.test/thread/thread-external-1',
    },
    syncDirection: 'bidirectional',
    syncStatus: 'pending',
    sourceAvailability: 'available',
    sourceState: 'active',
    revision,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Creates the exact workspace parent fence used by atomic projection tests. */
function createParentLifecycleFence(): ExternalChatParentLifecycleFence {
  return {
    workspaceId: 'workspace-1',
    provider: 'slack',
    installationId: 'installation-1',
    externalWorkspaceId: 'workspace-external-1',
    authorizationRevision: 1,
    restrictive: true,
    eventId: 'parent-event-1',
    operationId: 'parent-operation-1',
    occurredAt: NOW,
  }
}

/** Creates one normalized message-created event fixture. */
function createInboundEvent(eventId = 'event-1'): ExternalChatInboundEvent {
  return {
    schemaVersion: 1,
    type: 'message.created',
    eventId,
    correlationId: 'correlation-1',
    installationId: 'installation-1',
    provider: 'slack',
    externalWorkspaceId: 'workspace-external-1',
    conversationExternalId: 'conversation-external-1',
    threadExternalId: 'thread-external-1',
    occurredAt: NOW,
    message: {
      externalId: 'message-external-1',
      externalVersion: 'version-1',
      conversationExternalId: 'conversation-external-1',
      threadExternalId: 'thread-external-1',
      permalink: 'https://chat.example.test/message/message-external-1',
      availability: 'available',
      state: 'active',
      bodyMarkdown: 'Synthetic message',
      quotedRanges: [],
      attachments: [],
      postedAt: NOW,
      updatedAt: NOW,
    },
  }
}

/** Creates one normalized internal comment event for outbound synchronization. */
function createOutboundEvent(
  occurredAt = NOW,
  internalCommentId = 'comment-internal-1',
): ExternalChatSyncOutboundEvent {
  return {
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    principalId: 'principal-1',
    correlationId: 'correlation-outbound-1',
    occurredAt,
    externalSyncEligible: true,
    type: 'comment.created',
    internalCommentId,
    internalCommentVersion: 1,
    bodyMarkdown: 'Synthetic outbound comment',
  }
}

/** Creates one complete deferred outbound queue entry fixture. */
function createDeferredOutboundEvent(
  operationId = 'operation-outbound-deferred-1',
  event = createOutboundEvent(),
): DeferredExternalChatOutboundEvent {
  return {
    workspaceId: event.workspaceId,
    linkId: event.linkId,
    event,
    fingerprint: createExternalChatFingerprint(event),
    operationId,
    attempt: 1,
    retryAt: LEASE,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Creates one complete message binding fixture. */
function createBinding(): ExternalChatMessageBinding {
  return {
    schemaVersion: 1,
    linkId: 'link-1',
    externalMessageId: 'message-external-1',
    internalCommentId: 'comment-internal-1',
    origin: 'external',
    externalVersion: 'version-1',
    internalCommentVersion: 1,
    importedFileIds: ['file-1'],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Creates a real SDK client whose send method is replaced by a deterministic script. */
function createHarness(responder: CommandResponder): DynamoDbTestHarness {
  const lowLevelClient = new DynamoDBClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  const calls: DynamoDbTestHarness['calls'] = []
  let callIndex = 0
  const sendSpy = spyOn(documentClient, 'send')
  sendSpy.mockImplementation(async (command) => {
    const inspected = inspectCommand(command)
    calls.push(inspected)
    const currentCallIndex = callIndex
    callIndex += 1
    return await responder.respond(command, currentCallIndex)
  })
  return {
    store: new DynamoDbExternalChatStore({
      tableName: 'ExternalChatTable',
      documentClient,
    }),
    calls,
    restore: () => sendSpy.mockRestore(),
  }
}

/** Reads a command constructor name and input without trusting the SDK object. */
function inspectCommand(command: unknown): { name: string; input: UnknownRecord } {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw new TypeError('Expected an AWS SDK command object.')
  }
  const record = Object.fromEntries(Object.entries(command))
  const constructorValue = Reflect.get(command, 'constructor')
  if (
    typeof constructorValue !== 'function' ||
    typeof constructorValue.name !== 'string' ||
    typeof record.input !== 'object' ||
    record.input === null ||
    Array.isArray(record.input)
  ) throw new TypeError('Expected an AWS SDK command input.')
  return {
    name: constructorValue.name,
    input: Object.fromEntries(Object.entries(record.input)),
  }
}

/** Reads a nested record from a captured command input. */
function readRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${label}.`)
  }
  return Object.fromEntries(Object.entries(value))
}

/** Creates a modeled DynamoDB conditional failure. */
function conditionalFailure(): Error {
  const error = new Error('conditional failure')
  error.name = 'ConditionalCheckFailedException'
  return error
}

/** Creates a modeled DynamoDB transaction conditional failure. */
function transactionConditionalFailure(): Error {
  const error = new Error('transaction conditional failure')
  error.name = 'TransactionCanceledException'
  Object.assign(error, {
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  })
  return error
}

/** Creates the canonical source digest used by persisted link fixtures. */
function sourceDigest(): string {
  return createHash('sha256')
    .update([
      'external-chat-source-v1',
      'slack',
      'workspace-external-1',
      'conversation-external-1',
      'thread-external-1',
    ].join('\0'))
    .digest('hex')
}

/** Creates the SHA-256 component used by opaque DynamoDB record and lookup keys. */
function keyDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

test('strongly queries eligible parent links and excludes inactive or newer-generation rows', async () => {
  const activeLink = createLink('link-active')
  const newerLink = createLink('link-newer-authorization')
  const inactiveLink: ExternalChatWorkItemLink = {
    ...createLink('link-inactive'),
    installationId: 'installation-poison',
  }
  const lookupKey = [
    'CHAT_PARENT_LINK',
    keyDigest('workspace-1'),
    'slack',
    keyDigest('installation-1'),
    keyDigest('workspace-external-1'),
  ].join('#')
  const lastEvaluatedKey = {
    workspaceId: 'workspace-1',
    recordKey: `CHAT_LINK#${keyDigest(activeLink.id)}`,
  }
  const harness = createHarness({
    async respond(command, callIndex) {
      const inspected = inspectCommand(command)
      if (inspected.name !== 'QueryCommand') {
        throw new TypeError(`Unexpected command: ${inspected.name}`)
      }
      const values = readRecord(inspected.input.ExpressionAttributeValues, 'query values')
      const recordPrefix = String(values[':recordPrefix'])
      if (recordPrefix !== 'CHAT_LINK#') throw new TypeError('Unexpected link record prefix.')
      if (callIndex > 0) return { Items: [] }
      return {
        Items: [
          {
            workspaceId: 'workspace-1',
            recordKey: `CHAT_LINK#${keyDigest(inactiveLink.id)}`,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link: inactiveLink,
              sourceDigest: sourceDigest(),
              sourceAuthorizationRevision: 1,
              active: false,
              unlinkedAt: NOW,
            },
            storageRevision: 2,
            lookupKey: 'poisoned-inactive-projection',
            lookupSortKey: 'poisoned-inactive-projection',
          },
          {
            workspaceId: 'workspace-1',
            recordKey: `CHAT_LINK#${keyDigest(activeLink.id)}`,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link: activeLink,
              sourceDigest: sourceDigest(),
              sourceAuthorizationRevision: 1,
              active: true,
            },
            storageRevision: 1,
            lookupKey,
            lookupSortKey:
              `${keyDigest(activeLink.source.conversationExternalId)}\0${keyDigest(activeLink.id)}`,
          },
          {
            workspaceId: 'workspace-1',
            recordKey: `CHAT_LINK#${keyDigest(newerLink.id)}`,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link: newerLink,
              sourceDigest: sourceDigest(),
              sourceAuthorizationRevision: 2,
              active: true,
            },
            storageRevision: 1,
            lookupKey,
            lookupSortKey:
              `${keyDigest(newerLink.source.conversationExternalId)}\0${keyDigest(newerLink.id)}`,
          },
        ],
        LastEvaluatedKey: lastEvaluatedKey,
      }
    },
  })
  try {
    const first = await harness.store.listParentLinks({
      workspaceId: 'workspace-1',
      provider: 'slack',
      installationId: 'installation-1',
      externalWorkspaceId: 'workspace-external-1',
      conversationExternalId: 'conversation-external-1',
      maximumSourceAuthorizationRevision: 1,
      limit: 2,
    })
    expect(first.links.map((record) => record.link.id)).toEqual(['link-active'])
    expect(first.nextCursor).toBeString()
    const firstQuery = harness.calls[0]?.input
    expect(firstQuery?.IndexName).toBeUndefined()
    expect(firstQuery?.ConsistentRead).toBe(true)
    expect(readRecord(
      firstQuery?.ExpressionAttributeValues,
      'first parent lookup values',
    )[':recordPrefix']).toBe('CHAT_LINK#')

    await expect(harness.store.listParentLinks({
      workspaceId: 'workspace-1',
      provider: 'slack',
      installationId: 'installation-1',
      externalWorkspaceId: 'workspace-external-1',
      conversationExternalId: 'conversation-external-1',
      maximumSourceAuthorizationRevision: 1,
      cursor: first.nextCursor,
      limit: 2,
    })).resolves.toEqual({ links: [] })
    expect(harness.calls[1]?.input.ExclusiveStartKey).toEqual(lastEvaluatedKey)

    await expect(harness.store.listParentLinks({
      workspaceId: 'workspace-1',
      provider: 'slack',
      installationId: 'installation-2',
      externalWorkspaceId: 'workspace-external-1',
      conversationExternalId: 'conversation-external-1',
      maximumSourceAuthorizationRevision: 1,
      cursor: first.nextCursor,
      limit: 2,
    })).rejects.toMatchObject({ code: 'ExternalChatValidationFailed' })
    expect(harness.calls).toHaveLength(2)
  } finally {
    harness.restore()
  }
})

test('checkpoints parent fan-out receipts through operation and attempt fences', async () => {
  let receipt: UnknownRecord = {
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    provider: 'slack',
    eventId: 'parent-event-1',
    fingerprint: DIGEST,
    operationId: 'parent-operation-1',
    state: 'processing',
    attempt: 1,
    leaseExpiresAt: LEASE,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'receipt checkpoint key')
        return {
          Item: {
            workspaceId: key.workspaceId,
            recordKey: key.recordKey,
            entryType: 'external-chat-inbound-receipt',
            value: receipt,
            storageRevision: 1,
          },
        }
      }
      if (inspected.name === 'PutCommand') {
        const row = readRecord(inspected.input.Item, 'checkpoint replacement row')
        receipt = readRecord(row.value, 'checkpoint replacement receipt')
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.checkpointInboundEvent({
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      provider: 'slack',
      eventId: 'parent-event-1',
      operationId: 'parent-operation-1',
      expectedAttempt: 1,
      nextCursor: 'opaque-parent-cursor',
      checkpointedAt: '2026-08-06T00:01:00.000Z',
      leaseExpiresAt: '2026-08-06T00:06:00.000Z',
    })).resolves.toBe(true)
    expect(receipt).toMatchObject({
      parentLifecycleCursor: 'opaque-parent-cursor',
      leaseExpiresAt: '2026-08-06T00:06:00.000Z',
      updatedAt: '2026-08-06T00:01:00.000Z',
    })
    expect(harness.calls.map((call) => call.name)).toEqual(['GetCommand', 'PutCommand'])
  } finally {
    harness.restore()
  }
})

test('purges deferred link payloads while retaining the active coordinator event', async () => {
  const retained = createInboundEvent('parent-event-retained')
  const purged = createInboundEvent('content-event-purged')
  const deferredValue = (event: ExternalChatInboundEvent) => ({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    event,
    fingerprint: createExternalChatFingerprint(event),
    reason: 'source-unavailable',
    attempt: 1,
    retryAt: LEASE,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'QueryCommand') {
        return {
          Items: [retained, purged].map((event) => ({
            workspaceId: 'workspace-1',
            recordKey: `CHAT_DEFERRED#${keyDigest(event.eventId)}`,
            entryType: 'external-chat-deferred-event',
            value: deferredValue(event),
            storageRevision: 1,
          })),
        }
      }
      if (inspected.name === 'DeleteCommand') return {}
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.purgeDeferredEventsForLink(
      'workspace-1',
      'link-1',
      retained.eventId,
    )).resolves.toBe(1)
    const deletes = harness.calls.filter((call) => call.name === 'DeleteCommand')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.input.Key).toEqual({
      workspaceId: 'workspace-1',
      recordKey: `CHAT_DEFERRED#${keyDigest(purged.eventId)}`,
    })
  } finally {
    harness.restore()
  }
})

test('creates a link, source claim, and idempotency receipt in one conditional transaction', async () => {
  const harness = createHarness({
    async respond() {
      return {}
    },
  })
  try {
    const result = await harness.store.createLink({
      workspaceId: 'workspace-1',
      link: createLink(),
      authorizationRevision: 1,
      source: {
        provider: 'slack',
        externalWorkspaceId: 'workspace-external-1',
        conversationExternalId: 'conversation-external-1',
        threadExternalId: 'thread-external-1',
      },
      idempotencyKeyHash: DIGEST,
      requestFingerprint: 'b'.repeat(64),
    })

    expect(result.kind).toBe('created')
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]?.name).toBe('TransactWriteCommand')
    const transactItems = harness.calls[0]?.input.TransactItems
    expect(Array.isArray(transactItems)).toBe(true)
    if (!Array.isArray(transactItems)) throw new TypeError('Expected transaction items.')
    expect(transactItems).toHaveLength(5)
    const entryTypes = transactItems.slice(0, 3).map((item) => {
      const put = readRecord(readRecord(item, 'transaction item').Put, 'transaction Put')
      const storedItem = readRecord(put.Item, 'transaction Put item')
      expect(put.ConditionExpression).toBe('attribute_not_exists(#workspaceId)')
      expect(storedItem.workspaceId).toBe('workspace-1')
      expect(String(storedItem.recordKey)).not.toContain('thread-external-1')
      return storedItem.entryType
    })
    expect(entryTypes).toEqual([
      'external-chat-link',
      'external-chat-source-claim',
      'external-chat-link-receipt',
    ])
    const expectedFenceKeys = [
      `CHAT_PARENT_STATE#slack#${keyDigest('installation-1')}#${keyDigest('workspace-external-1')}#WORKSPACE`,
      `CHAT_PARENT_STATE#slack#${keyDigest('installation-1')}#${keyDigest('workspace-external-1')}#CONVERSATION#${keyDigest('conversation-external-1')}`,
    ]
    const conditionKeys = transactItems.slice(3).map((item) => {
      const condition = readRecord(
        readRecord(item, 'parent fence transaction item').ConditionCheck,
        'parent fence condition',
      )
      expect(condition.ConditionExpression).toContain(
        '#value.#authorizationRevision < :authorizationRevision',
      )
      expect(condition.ConditionExpression).toContain('#value.#restrictive = :notRestrictive')
      expect(readRecord(
        condition.ExpressionAttributeValues,
        'parent fence condition values',
      )).toMatchObject({
        ':entryType': 'external-chat-parent-lifecycle',
        ':authorizationRevision': 1,
        ':notRestrictive': false,
      })
      const key = readRecord(condition.Key, 'parent fence condition key')
      expect(key.workspaceId).toBe('workspace-1')
      expect(String(key.recordKey)).not.toContain('installation-1')
      expect(String(key.recordKey)).not.toContain('workspace-external-1')
      expect(String(key.recordKey)).not.toContain('conversation-external-1')
      return key.recordKey
    })
    expect(conditionKeys).toEqual(expectedFenceKeys)
  } finally {
    harness.restore()
  }
})

test('classifies a conditional link write as parent-restricted after a lifecycle race', async () => {
  const link = createLink()
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'TransactWriteCommand') throw transactionConditionalFailure()
      if (inspected.name !== 'GetCommand') {
        throw new TypeError(`Unexpected command: ${inspected.name}`)
      }
      const key = readRecord(inspected.input.Key, 'parent race Get key')
      if (typeof key.recordKey !== 'string') throw new TypeError('Expected a record key.')
      if (!key.recordKey.endsWith('#WORKSPACE')) return {}
      return {
        Item: {
          workspaceId: 'workspace-1',
          recordKey: key.recordKey,
          entryType: 'external-chat-parent-lifecycle',
          value: {
            workspaceId: 'workspace-1',
            provider: 'slack',
            installationId: 'installation-1',
            externalWorkspaceId: 'workspace-external-1',
            authorizationRevision: 1,
            restrictive: true,
            eventId: 'parent-event-after-resolution',
            operationId: 'parent-operation-after-resolution',
            occurredAt: NOW,
          },
          storageRevision: 1,
        },
      }
    },
  })
  try {
    const result = await harness.store.createLink({
      workspaceId: 'workspace-1',
      link,
      authorizationRevision: 1,
      source: {
        provider: 'slack',
        externalWorkspaceId: 'workspace-external-1',
        conversationExternalId: 'conversation-external-1',
        threadExternalId: 'thread-external-1',
      },
      idempotencyKeyHash: DIGEST,
      requestFingerprint: 'b'.repeat(64),
    })

    expect(result).toEqual({ kind: 'parent-restricted' })
    expect(harness.calls.map((call) => call.name)).toEqual([
      'TransactWriteCommand',
      'GetCommand',
      'GetCommand',
      'GetCommand',
      'GetCommand',
    ])
    for (const call of harness.calls.slice(1)) expect(call.input.ConsistentRead).toBe(true)
  } finally {
    harness.restore()
  }
})

test('classifies a conditional link write as an idempotent replay through strong reads', async () => {
  const link = createLink()
  const harness = createHarness({
    async respond(command, callIndex) {
      const inspected = inspectCommand(command)
      if (callIndex === 0) throw transactionConditionalFailure()
      const key = readRecord(inspected.input.Key, 'Get key')
      if (callIndex === 1) {
        return {
          Item: {
            workspaceId: key.workspaceId,
            recordKey: key.recordKey,
            entryType: 'external-chat-link-receipt',
            value: {
              requestFingerprint: 'b'.repeat(64),
              linkId: link.id,
            },
            storageRevision: 1,
          },
        }
      }
      return {
        Item: {
          workspaceId: key.workspaceId,
          recordKey: key.recordKey,
          entryType: 'external-chat-link',
          value: {
            workspaceId: 'workspace-1',
            link,
            sourceDigest: sourceDigest(),
            sourceAuthorizationRevision: 1,
            active: true,
          },
          storageRevision: 1,
        },
      }
    },
  })
  try {
    const result = await harness.store.createLink({
      workspaceId: 'workspace-1',
      link,
      authorizationRevision: 1,
      source: {
        provider: 'slack',
        externalWorkspaceId: 'workspace-external-1',
        conversationExternalId: 'conversation-external-1',
        threadExternalId: 'thread-external-1',
      },
      idempotencyKeyHash: DIGEST,
      requestFingerprint: 'b'.repeat(64),
    })

    expect(result).toMatchObject({ kind: 'replayed', record: { link } })
    expect(harness.calls.slice(1).map((call) => call.name)).toEqual([
      'GetCommand',
      'GetCommand',
    ])
    for (const call of harness.calls.slice(1)) {
      expect(call.input.ConsistentRead).toBe(true)
    }
  } finally {
    harness.restore()
  }
})

test('keeps inbound receipts exactly once through lease, completion, and echo checks', async () => {
  let storedRow: unknown
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        return storedRow === undefined ? {} : { Item: structuredClone(storedRow) }
      }
      if (inspected.name === 'PutCommand') {
        storedRow = structuredClone(inspected.input.Item)
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  const claim: ClaimExternalChatInboundEventInput = {
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    provider: 'slack',
    eventId: 'event-1',
    fingerprint: DIGEST,
    operationId: 'operation-inbound-1',
    claimedAt: NOW,
    leaseExpiresAt: LEASE,
  }
  try {
    await expect(harness.store.claimInboundEvent(claim)).resolves.toMatchObject({
      kind: 'claimed',
      receipt: { attempt: 1, state: 'processing' },
    })
    await expect(harness.store.claimInboundEvent({
      ...claim,
      claimedAt: '2026-08-06T00:01:00.000Z',
      leaseExpiresAt: '2026-08-06T00:06:00.000Z',
    })).resolves.toMatchObject({ kind: 'busy', receipt: { attempt: 1 } })
    await expect(harness.store.completeInboundEvent({
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      provider: 'slack',
      eventId: 'event-1',
      operationId: 'operation-inbound-1',
      expectedAttempt: 1,
      outcome: {
        kind: 'applied',
        operationId: 'operation-inbound-1',
        eventId: 'event-1',
        direction: 'inbound',
        occurredAt: '2026-08-06T00:02:00.000Z',
      },
      completedAt: '2026-08-06T00:02:00.000Z',
    })).resolves.toBe(true)
    await expect(harness.store.claimInboundEvent({
      ...claim,
      claimedAt: '2026-08-06T00:10:00.000Z',
      leaseExpiresAt: '2026-08-06T00:15:00.000Z',
    })).resolves.toMatchObject({ kind: 'duplicate', receipt: { state: 'completed' } })
    const putCalls = harness.calls.filter((call) => call.name === 'PutCommand')
    expect(putCalls).toHaveLength(2)
    expect(putCalls[0]?.input.ConditionExpression).toBe('attribute_not_exists(#workspaceId)')
    expect(putCalls[1]?.input.ConditionExpression).toContain('#storageRevision')
  } finally {
    harness.restore()
  }
})

test('keeps deferred inbound completion immutable until a due claim resumes a new attempt', async () => {
  let storedRow: unknown
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        return storedRow === undefined ? {} : { Item: structuredClone(storedRow) }
      }
      if (inspected.name === 'PutCommand') {
        storedRow = structuredClone(inspected.input.Item)
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  const claim: ClaimExternalChatInboundEventInput = {
    workspaceId: 'workspace-1',
    installationId: 'installation-1',
    provider: 'slack',
    eventId: 'event-stale-lease',
    fingerprint: DIGEST,
    operationId: 'operation-inbound-stale',
    claimedAt: NOW,
    leaseExpiresAt: LEASE,
  }
  const deferred: ExternalChatSyncOutcome = {
    kind: 'deferred',
    operationId: claim.operationId,
    eventId: claim.eventId,
    reason: 'out-of-order',
    retryAt: '2026-08-06T00:06:00.000Z',
    occurredAt: '2026-08-06T00:01:00.000Z',
  }
  const applied: ExternalChatSyncOutcome = {
    kind: 'applied',
    operationId: claim.operationId,
    eventId: claim.eventId,
    direction: 'inbound',
    occurredAt: '2026-08-06T00:07:00.000Z',
  }
  try {
    await expect(harness.store.claimInboundEvent(claim)).resolves.toMatchObject({
      kind: 'claimed',
      receipt: { attempt: 1 },
    })
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: { ...deferred, operationId: 'another-operation' },
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(false)
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: { ...deferred, eventId: 'another-event' },
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(false)
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: deferred,
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(true)
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: applied,
      completedAt: applied.occurredAt,
    })).resolves.toBe(false)
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: {
        ...deferred,
        operationId: 'another-operation',
      },
      completedAt: applied.occurredAt,
    })).resolves.toBe(false)
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: {
        ...deferred,
        eventId: 'another-event',
      },
      completedAt: applied.occurredAt,
    })).resolves.toBe(false)
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: deferred,
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(true)
    await expect(harness.store.claimInboundEvent({
      ...claim,
      claimedAt: '2026-08-06T00:05:00.000Z',
      leaseExpiresAt: '2026-08-06T00:10:00.000Z',
    })).resolves.toMatchObject({
      kind: 'duplicate',
      receipt: { attempt: 1 },
    })
    await expect(harness.store.claimInboundEvent({
      ...claim,
      claimedAt: '2026-08-06T00:06:00.000Z',
      leaseExpiresAt: '2026-08-06T00:11:00.000Z',
    })).resolves.toMatchObject({
      kind: 'resumed',
      receipt: { attempt: 2 },
    })
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: applied,
      completedAt: applied.occurredAt,
    })).resolves.toBe(false)
    await expect(harness.store.completeInboundEvent({
      workspaceId: claim.workspaceId,
      installationId: claim.installationId,
      provider: claim.provider,
      eventId: claim.eventId,
      operationId: claim.operationId,
      expectedAttempt: 2,
      outcome: applied,
      completedAt: applied.occurredAt,
    })).resolves.toBe(true)
  } finally {
    harness.restore()
  }
})

test('keeps deferred outbound completion immutable until a due claim resumes a new attempt', async () => {
  let storedRow: unknown
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        return storedRow === undefined ? {} : { Item: structuredClone(storedRow) }
      }
      if (inspected.name === 'PutCommand') {
        storedRow = structuredClone(inspected.input.Item)
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  const deferred: ExternalChatSyncOutcome = {
    kind: 'deferred',
    operationId: 'operation-outbound-1',
    reason: 'rate-limited',
    retryAt: '2026-08-06T00:06:00.000Z',
    occurredAt: '2026-08-06T00:01:00.000Z',
  }
  const applied: ExternalChatSyncOutcome = {
    kind: 'applied',
    operationId: 'operation-outbound-1',
    direction: 'outbound',
    occurredAt: '2026-08-06T00:07:00.000Z',
  }
  try {
    await expect(harness.store.claimOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      fingerprint: DIGEST,
      claimedAt: NOW,
      leaseExpiresAt: LEASE,
    })).resolves.toMatchObject({ kind: 'claimed' })
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 1,
      outcome: { ...deferred, operationId: 'another-operation' },
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(false)
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 1,
      outcome: { ...deferred, eventId: 'provider-event-not-allowed' },
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(false)
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 1,
      outcome: deferred,
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(true)
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 1,
      outcome: applied,
      completedAt: applied.occurredAt,
    })).resolves.toBe(false)
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 1,
      outcome: {
        ...deferred,
        operationId: 'another-operation',
      },
      completedAt: applied.occurredAt,
    })).resolves.toBe(false)
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 1,
      outcome: {
        ...deferred,
        eventId: 'provider-event-not-allowed',
      },
      completedAt: applied.occurredAt,
    })).resolves.toBe(false)
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 1,
      outcome: deferred,
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(true)
    await expect(harness.store.hasCompletedOutboundOperation(
      'workspace-1',
      'link-1',
      'operation-outbound-1',
    )).resolves.toBe(true)
    await expect(harness.store.claimOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      fingerprint: DIGEST,
      claimedAt: '2026-08-06T00:05:00.000Z',
      leaseExpiresAt: '2026-08-06T00:10:00.000Z',
    })).resolves.toMatchObject({ kind: 'duplicate', receipt: { attempt: 1 } })
    await expect(harness.store.claimOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      fingerprint: DIGEST,
      claimedAt: '2026-08-06T00:06:00.000Z',
      leaseExpiresAt: '2026-08-06T00:11:00.000Z',
    })).resolves.toMatchObject({ kind: 'resumed', receipt: { attempt: 2 } })
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 1,
      outcome: applied,
      completedAt: applied.occurredAt,
    })).resolves.toBe(false)
    await expect(harness.store.completeOutboundOperation({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      operationId: 'operation-outbound-1',
      expectedAttempt: 2,
      outcome: applied,
      completedAt: applied.occurredAt,
    })).resolves.toBe(true)
    const getKeys = harness.calls
      .filter((call) => call.name === 'GetCommand')
      .map((call) => call.input.Key)
    expect(getKeys.every((key) => !JSON.stringify(key).includes('operation-outbound-1'))).toBe(true)
  } finally {
    harness.restore()
  }
})

test('resumes a completed retryable outbound failure for its durable queue worker', async () => {
  let storedRow: unknown
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        return storedRow === undefined ? {} : { Item: structuredClone(storedRow) }
      }
      if (inspected.name === 'PutCommand') {
        storedRow = structuredClone(inspected.input.Item)
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  const claim = {
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    operationId: 'operation-outbound-retryable-failure',
    fingerprint: DIGEST,
    claimedAt: NOW,
    leaseExpiresAt: LEASE,
  }
  try {
    await expect(harness.store.claimOutboundOperation(claim)).resolves.toMatchObject({
      kind: 'claimed',
      receipt: { attempt: 1 },
    })
    await expect(harness.store.completeOutboundOperation({
      workspaceId: claim.workspaceId,
      linkId: claim.linkId,
      operationId: claim.operationId,
      expectedAttempt: 1,
      outcome: {
        kind: 'failed',
        operationId: claim.operationId,
        errorCode: 'ExternalChatSyntheticRetryableFailure',
        retryable: true,
        occurredAt: '2026-08-06T00:01:00.000Z',
      },
      completedAt: '2026-08-06T00:01:00.000Z',
    })).resolves.toBe(true)
    await expect(harness.store.claimOutboundOperation({
      ...claim,
      claimedAt: '2026-08-06T00:02:00.000Z',
      leaseExpiresAt: '2026-08-06T00:07:00.000Z',
    })).resolves.toMatchObject({
      kind: 'resumed',
      receipt: { state: 'processing', attempt: 2 },
    })
  } finally {
    harness.restore()
  }
})

test('transactionally fences thread lifecycle claims, completion replay, and duplicate merge', async () => {
  let linkValue: unknown = {
    workspaceId: 'workspace-1',
    link: createLink(),
    sourceDigest: sourceDigest(),
    sourceAuthorizationRevision: 1,
    active: true,
  }
  let linkStorageRevision = 1
  let lifecycleRow: unknown
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'lifecycle Get key')
        const recordKey = String(key.recordKey)
        if (recordKey.startsWith('CHAT_LINK#')) {
          return {
            Item: {
              workspaceId: key.workspaceId,
              recordKey,
              entryType: 'external-chat-link',
              value: structuredClone(linkValue),
              storageRevision: linkStorageRevision,
            },
          }
        }
        if (recordKey.startsWith('CHAT_THREAD_LIFECYCLE#')) {
          return lifecycleRow === undefined ? {} : { Item: structuredClone(lifecycleRow) }
        }
        return {}
      }
      if (inspected.name === 'QueryCommand') return { Items: [] }
      if (inspected.name === 'PutCommand') {
        lifecycleRow = structuredClone(inspected.input.Item)
        return {}
      }
      if (inspected.name === 'TransactWriteCommand') {
        const transactItems = inspected.input.TransactItems
        if (!Array.isArray(transactItems)) throw new TypeError('Expected transaction items.')
        for (const item of transactItems) {
          const putValue = readRecord(item, 'transaction item').Put
          if (putValue === undefined) continue
          const put = readRecord(putValue, 'transaction Put')
          const storedItem = readRecord(put.Item, 'transaction Put item')
          if (storedItem.entryType === 'external-chat-thread-lifecycle') {
            lifecycleRow = structuredClone(storedItem)
          }
          if (storedItem.entryType === 'external-chat-link') {
            linkValue = structuredClone(storedItem.value)
            if (typeof storedItem.storageRevision !== 'number') {
              throw new TypeError('Expected link storage revision.')
            }
            linkStorageRevision = storedItem.storageRevision
          }
        }
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  const initialClaim: ClaimExternalChatThreadLifecycleInput = {
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    provider: 'slack',
    expectedLinkRevision: 1,
    operationId: 'lifecycle-complete-1',
    claimedAt: NOW,
    leaseExpiresAt: LEASE,
  }
  const completedAt = '2026-08-06T00:01:00.000Z'
  const completedState = {
    completed: true,
    lastExternalVersion: 'version-2',
    lastInternalWorkItemRevision: 8,
    revision: 1,
    updatedAt: completedAt,
  }
  const completedOutcome: ExternalChatSyncOutcome = {
    kind: 'applied',
    operationId: initialClaim.operationId,
    direction: 'inbound',
    occurredAt: completedAt,
  }
  try {
    await expect(harness.store.claimThreadLifecycle(initialClaim)).resolves.toMatchObject({
      kind: 'claimed',
      record: {
        ownerLinkRevision: 1,
        state: { completed: false, revision: 0 },
        lease: { attempt: 1, status: 'processing' },
      },
    })
    const firstTransaction = harness.calls.find((call) => call.name === 'TransactWriteCommand')
    const firstItems = firstTransaction?.input.TransactItems
    if (!Array.isArray(firstItems)) throw new TypeError('Expected lifecycle transaction items.')
    expect(firstItems).toHaveLength(2)
    expect(readRecord(firstItems[0], 'lifecycle link fence').ConditionCheck).toBeDefined()
    const lifecyclePut = readRecord(
      readRecord(firstItems[1], 'lifecycle transaction item').Put,
      'lifecycle Put',
    )
    expect(readRecord(lifecyclePut.Item, 'lifecycle item').entryType).toBe(
      'external-chat-thread-lifecycle',
    )
    expect(String(readRecord(lifecyclePut.Item, 'lifecycle item').recordKey)).not.toContain(
      'link-1',
    )

    await expect(harness.store.claimThreadLifecycle({
      ...initialClaim,
      claimedAt: '2026-08-06T00:00:30.000Z',
      leaseExpiresAt: '2026-08-06T00:05:30.000Z',
    })).resolves.toMatchObject({ kind: 'busy', record: { lease: { attempt: 1 } } })
    await expect(harness.store.completeThreadLifecycle({
      workspaceId: initialClaim.workspaceId,
      linkId: initialClaim.linkId,
      provider: initialClaim.provider,
      expectedLinkRevision: initialClaim.expectedLinkRevision,
      operationId: initialClaim.operationId,
      expectedAttempt: 1,
      nextState: completedState,
      outcome: completedOutcome,
      completedAt,
    })).resolves.toBe(true)
    const transactionCountAfterCompletion = harness.calls.filter(
      (call) => call.name === 'TransactWriteCommand',
    ).length
    await expect(harness.store.claimThreadLifecycle({
      ...initialClaim,
      claimedAt: '2026-08-06T00:06:00.000Z',
      leaseExpiresAt: '2026-08-06T00:11:00.000Z',
    })).resolves.toMatchObject({
      kind: 'completed',
      record: {
        state: completedState,
        lease: { completedOutcome },
      },
    })
    expect(harness.calls.filter(
      (call) => call.name === 'TransactWriteCommand',
    )).toHaveLength(transactionCountAfterCompletion)

    await expect(harness.store.claimThreadLifecycle({
      ...initialClaim,
      operationId: 'lifecycle-reopen-1',
      claimedAt: '2026-08-06T00:06:00.000Z',
      leaseExpiresAt: '2026-08-06T00:11:00.000Z',
    })).resolves.toMatchObject({ kind: 'busy' })
    await expect(harness.store.acknowledgeThreadLifecycle({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      provider: 'slack',
      operationId: initialClaim.operationId,
      expectedAttempt: 1,
    })).resolves.toBe(true)
    const reopenClaim = await harness.store.claimThreadLifecycle({
      ...initialClaim,
      operationId: 'lifecycle-reopen-1',
      claimedAt: '2026-08-06T00:06:00.000Z',
      leaseExpiresAt: '2026-08-06T00:11:00.000Z',
    })
    expect(reopenClaim).toMatchObject({
      kind: 'claimed',
      record: { state: completedState, lease: { attempt: 2, status: 'processing' } },
    })
    const blockedMergeTransactionCount = harness.calls.filter(
      (call) => call.name === 'TransactWriteCommand',
    ).length
    await expect(harness.store.mergeLinks({
      workspaceId: 'workspace-1',
      canonicalTeamId: 'team-canonical',
      canonicalWorkItemId: 'work-item-canonical',
      duplicateTeamId: 'team-1',
      duplicateWorkItemId: 'work-item-1',
      links: [{ linkId: 'link-1', expectedRevision: 1 }],
      mergedAt: '2026-08-06T00:07:00.000Z',
    })).resolves.toEqual({ kind: 'conflict' })
    expect(harness.calls.filter(
      (call) => call.name === 'TransactWriteCommand',
    )).toHaveLength(blockedMergeTransactionCount)

    const reopenedAt = '2026-08-06T00:07:00.000Z'
    await expect(harness.store.completeThreadLifecycle({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      provider: 'slack',
      expectedLinkRevision: 1,
      operationId: 'lifecycle-reopen-1',
      expectedAttempt: 2,
      nextState: {
        completed: false,
        lastExternalVersion: 'version-3',
        lastInternalWorkItemRevision: 9,
        revision: 2,
        updatedAt: reopenedAt,
      },
      outcome: {
        kind: 'applied',
        operationId: 'lifecycle-reopen-1',
        direction: 'inbound',
        occurredAt: reopenedAt,
      },
      completedAt: reopenedAt,
    })).resolves.toBe(true)
    await expect(harness.store.mergeLinks({
      workspaceId: 'workspace-1',
      canonicalTeamId: 'team-canonical',
      canonicalWorkItemId: 'work-item-canonical',
      duplicateTeamId: 'team-1',
      duplicateWorkItemId: 'work-item-1',
      links: [{ linkId: 'link-1', expectedRevision: 1 }],
      mergedAt: '2026-08-06T00:08:00.000Z',
    })).resolves.toEqual({ kind: 'conflict' })
    await expect(harness.store.acknowledgeThreadLifecycle({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      provider: 'slack',
      operationId: 'lifecycle-reopen-1',
      expectedAttempt: 2,
    })).resolves.toBe(true)
    await expect(harness.store.mergeLinks({
      workspaceId: 'workspace-1',
      canonicalTeamId: 'team-canonical',
      canonicalWorkItemId: 'work-item-canonical',
      duplicateTeamId: 'team-1',
      duplicateWorkItemId: 'work-item-1',
      links: [{ linkId: 'link-1', expectedRevision: 1 }],
      mergedAt: '2026-08-06T00:08:00.000Z',
    })).resolves.toMatchObject({ kind: 'merged' })
    await expect(harness.store.getThreadLifecycle(
      'workspace-1',
      'link-1',
      'slack',
    )).resolves.toMatchObject({
      ownerLinkRevision: 2,
      state: { completed: false, revision: 2 },
    })
    const strongReads = harness.calls.filter((call) => call.name === 'GetCommand')
    expect(strongReads.every((call) => call.input.ConsistentRead === true)).toBe(true)
  } finally {
    harness.restore()
  }
})

test('atomically fences link updates and unlinking with lifecycle ownership', async () => {
  let linkValue: unknown = {
    workspaceId: 'workspace-1',
    link: createLink(),
    sourceDigest: sourceDigest(),
    sourceAuthorizationRevision: 1,
    active: true,
  }
  let linkStorageRevision = 1
  let lifecycleRow: unknown = {
    workspaceId: 'workspace-1',
    recordKey: `CHAT_THREAD_LIFECYCLE#${'b'.repeat(64)}#slack`,
    entryType: 'external-chat-thread-lifecycle',
    value: {
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      provider: 'slack',
      ownerLinkRevision: 1,
      state: {
        completed: true,
        lastExternalVersion: 'version-2',
        revision: 1,
        updatedAt: '2026-08-06T00:01:00.000Z',
      },
      lease: {
        operationId: 'lifecycle-1',
        attempt: 1,
        status: 'completed',
        leaseExpiresAt: LEASE,
        completedAt: '2026-08-06T00:01:00.000Z',
        completedOutcome: {
          kind: 'applied',
          operationId: 'lifecycle-1',
          direction: 'inbound',
          occurredAt: '2026-08-06T00:01:00.000Z',
        },
      },
    },
    storageRevision: 2,
  }
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'fenced link Get key')
        const recordKey = String(key.recordKey)
        if (recordKey.startsWith('CHAT_LINK#')) {
          return {
            Item: {
              workspaceId: key.workspaceId,
              recordKey,
              entryType: 'external-chat-link',
              value: structuredClone(linkValue),
              storageRevision: linkStorageRevision,
            },
          }
        }
        if (recordKey.startsWith('CHAT_THREAD_LIFECYCLE#')) {
          const current = readRecord(lifecycleRow, 'lifecycle row')
          return {
            Item: {
              ...structuredClone(current),
              workspaceId: key.workspaceId,
              recordKey,
            },
          }
        }
        return {}
      }
      if (inspected.name === 'TransactWriteCommand') {
        const items = inspected.input.TransactItems
        if (!Array.isArray(items)) throw new TypeError('Expected transaction items.')
        for (const item of items) {
          const putValue = readRecord(item, 'fenced mutation item').Put
          if (putValue === undefined) continue
          const put = readRecord(putValue, 'fenced mutation Put')
          const storedItem = readRecord(put.Item, 'fenced mutation stored item')
          if (storedItem.entryType === 'external-chat-link') {
            linkValue = structuredClone(storedItem.value)
            if (typeof storedItem.storageRevision !== 'number') {
              throw new TypeError('Expected link storage revision.')
            }
            linkStorageRevision = storedItem.storageRevision
          }
          if (storedItem.entryType === 'external-chat-thread-lifecycle') {
            lifecycleRow = structuredClone(storedItem)
          }
        }
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  const replacement: ExternalChatWorkItemLink = {
    ...createLink(),
    syncStatus: 'synced',
    revision: 2,
    updatedAt: '2026-08-06T00:02:00.000Z',
  }
  try {
    await expect(harness.store.updateLink({
      workspaceId: 'workspace-1',
      link: replacement,
      expectedRevision: 1,
    })).resolves.toMatchObject({ kind: 'conflict' })
    await expect(harness.store.updateLink({
      workspaceId: 'workspace-1',
      link: replacement,
      expectedRevision: 1,
      lifecycleOperationId: 'lifecycle-1',
    })).resolves.toMatchObject({ kind: 'updated' })
    const updateTransaction = [...harness.calls]
      .reverse()
      .find((call) => call.name === 'TransactWriteCommand')
    const updateItems = updateTransaction?.input.TransactItems
    if (!Array.isArray(updateItems)) throw new TypeError('Expected update transaction items.')
    expect(updateItems).toHaveLength(2)
    const lifecyclePut = readRecord(
      readRecord(updateItems[1], 'update lifecycle item').Put,
      'update lifecycle Put',
    )
    expect(readRecord(lifecyclePut.Item, 'updated lifecycle row').value).toMatchObject({
      ownerLinkRevision: 2,
    })

    await expect(harness.store.unlinkLink({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      expectedRevision: 2,
      unlinkedAt: '2026-08-06T00:03:00.000Z',
    })).resolves.toMatchObject({ kind: 'conflict' })
    await expect(harness.store.unlinkLink({
      workspaceId: 'workspace-1',
      linkId: 'link-1',
      expectedRevision: 2,
      lifecycleOperationId: 'lifecycle-1',
      unlinkedAt: '2026-08-06T00:03:00.000Z',
    })).resolves.toMatchObject({ kind: 'unlinked' })
    const unlinkTransaction = [...harness.calls]
      .reverse()
      .find((call) => call.name === 'TransactWriteCommand')
    const unlinkItems = unlinkTransaction?.input.TransactItems
    if (!Array.isArray(unlinkItems)) throw new TypeError('Expected unlink transaction items.')
    expect(unlinkItems).toHaveLength(3)
    expect(readRecord(unlinkItems[2], 'unlink lifecycle fence').ConditionCheck).toBeDefined()
  } finally {
    harness.restore()
  }
})

test('conditions a parent fan-out projection on the exact durable parent fence', async () => {
  const currentLink = createLink()
  const expectedFence = createParentLifecycleFence()
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'parent-fenced update Get key')
        if (!String(key.recordKey).startsWith('CHAT_LINK#')) return {}
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey: key.recordKey,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link: currentLink,
              sourceDigest: sourceDigest(),
              sourceAuthorizationRevision: 1,
              active: true,
            },
            storageRevision: 1,
          },
        }
      }
      if (inspected.name === 'TransactWriteCommand') return {}
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  const replacement: ExternalChatWorkItemLink = {
    ...currentLink,
    sourceAvailability: 'permission-lost',
    sourceState: 'retained-metadata',
    syncStatus: 'paused',
    revision: 2,
    updatedAt: '2026-08-06T00:01:00.000Z',
  }
  try {
    await expect(harness.store.updateLink({
      workspaceId: 'workspace-1',
      link: replacement,
      expectedRevision: 1,
      expectedParentLifecycleFence: expectedFence,
    })).resolves.toMatchObject({ kind: 'updated' })

    const transaction = harness.calls.find((call) => call.name === 'TransactWriteCommand')
    const items = transaction?.input.TransactItems
    if (!Array.isArray(items)) throw new TypeError('Expected parent-fenced update items.')
    expect(items).toHaveLength(3)
    const condition = readRecord(
      readRecord(items[2], 'parent fence update item').ConditionCheck,
      'parent fence update condition',
    )
    expect(condition.ConditionExpression).toContain(
      '#value.#authorizationRevision = :authorizationRevision',
    )
    expect(condition.ConditionExpression).toContain(
      'attribute_not_exists(#value.#conversationExternalId)',
    )
    expect(readRecord(
      condition.ExpressionAttributeValues,
      'parent fence update values',
    )).toMatchObject({
      ':entryType': 'external-chat-parent-lifecycle',
      ':workspaceId': expectedFence.workspaceId,
      ':provider': expectedFence.provider,
      ':installationId': expectedFence.installationId,
      ':externalWorkspaceId': expectedFence.externalWorkspaceId,
      ':authorizationRevision': expectedFence.authorizationRevision,
      ':restrictive': expectedFence.restrictive,
      ':eventId': expectedFence.eventId,
      ':operationId': expectedFence.operationId,
      ':occurredAt': expectedFence.occurredAt,
    })
    expect(readRecord(condition.Key, 'parent fence update key')).toEqual({
      workspaceId: 'workspace-1',
      recordKey:
        `CHAT_PARENT_STATE#slack#${keyDigest('installation-1')}#${keyDigest('workspace-external-1')}#WORKSPACE`,
    })
  } finally {
    harness.restore()
  }
})

test('classifies a failed parent-fenced update as stale when a newer fence won', async () => {
  const currentLink = createLink()
  const expectedFence = createParentLifecycleFence()
  const newerFence: ExternalChatParentLifecycleFence = {
    ...expectedFence,
    authorizationRevision: 2,
    restrictive: false,
    eventId: 'parent-event-2',
    operationId: 'parent-operation-2',
    occurredAt: '2026-08-06T00:01:00.000Z',
  }
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'TransactWriteCommand') throw transactionConditionalFailure()
      if (inspected.name !== 'GetCommand') {
        throw new TypeError(`Unexpected command: ${inspected.name}`)
      }
      const key = readRecord(inspected.input.Key, 'stale parent update Get key')
      const recordKey = String(key.recordKey)
      if (recordKey.startsWith('CHAT_LINK#')) {
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link: currentLink,
              sourceDigest: sourceDigest(),
              sourceAuthorizationRevision: 1,
              active: true,
            },
            storageRevision: 1,
          },
        }
      }
      if (recordKey.startsWith('CHAT_PARENT_STATE#')) {
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey,
            entryType: 'external-chat-parent-lifecycle',
            value: newerFence,
            storageRevision: 2,
          },
        }
      }
      return {}
    },
  })
  const replacement: ExternalChatWorkItemLink = {
    ...currentLink,
    sourceAvailability: 'permission-lost',
    sourceState: 'retained-metadata',
    syncStatus: 'paused',
    revision: 2,
    updatedAt: '2026-08-06T00:01:00.000Z',
  }
  try {
    await expect(harness.store.updateLink({
      workspaceId: 'workspace-1',
      link: replacement,
      expectedRevision: 1,
      expectedParentLifecycleFence: expectedFence,
    })).resolves.toEqual({ kind: 'parent-stale' })
    expect(harness.calls.map((call) => call.name)).toEqual([
      'GetCommand',
      'GetCommand',
      'TransactWriteCommand',
      'GetCommand',
    ])
    expect(harness.calls[3]?.input.ConsistentRead).toBe(true)
  } finally {
    harness.restore()
  }
})

test('writes both message identity projections in one revision-fenced transaction', async () => {
  const owner = createLink()
  const harness = createHarness({
    async respond(command, callIndex) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand' && callIndex === 0) {
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey: `CHAT_LINK#${keyDigest(owner.id)}`,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link: owner,
              sourceDigest: sourceDigest(),
              sourceAuthorizationRevision: 1,
              active: true,
            },
            storageRevision: 1,
          },
        }
      }
      return {}
    },
  })
  try {
    const result = await harness.store.putMessageBinding({
      workspaceId: 'workspace-1',
      binding: createBinding(),
      expectedTeamId: owner.teamId,
      expectedWorkItemId: owner.workItemId,
      expectedLinkRevision: owner.revision,
    })
    expect(result).toMatchObject({
      kind: 'stored',
      record: { storageRevision: 1 },
    })
    expect(harness.calls.map((call) => call.name)).toEqual([
      'GetCommand',
      'GetCommand',
      'GetCommand',
      'TransactWriteCommand',
    ])
    const transactItems = harness.calls[3]?.input.TransactItems
    if (!Array.isArray(transactItems)) throw new TypeError('Expected binding transaction items.')
    expect(transactItems).toHaveLength(3)
    const entryTypes = transactItems.slice(0, 2).map((item) => {
      const put = readRecord(readRecord(item, 'binding transaction item').Put, 'binding Put')
      const storedItem = readRecord(put.Item, 'binding Put item')
      expect(put.ConditionExpression).toBe('attribute_not_exists(#workspaceId)')
      return storedItem.entryType
    })
    expect(entryTypes).toEqual([
      'external-chat-binding-external',
      'external-chat-binding-internal',
    ])
    const ownerFence = readRecord(
      readRecord(transactItems[2], 'binding owner fence').Put,
      'binding owner Put',
    )
    expect(readRecord(ownerFence.Item, 'binding owner item')).toMatchObject({
      entryType: 'external-chat-link',
      storageRevision: 2,
    })
    expect(ownerFence.ConditionExpression).toContain('#storageRevision = :storageRevision')
  } finally {
    harness.restore()
  }
})

test('advances private sync cursors with create and update CAS conditions', async () => {
  let failNext = false
  const harness = createHarness({
    async respond() {
      if (failNext) throw conditionalFailure()
      return {}
    },
  })
  try {
    await expect(harness.store.putSyncCursor('workspace-1', {
      schemaVersion: 1,
      linkId: 'link-1',
      provider: 'slack',
      operationId: 'operation-resync-1',
      mode: 'full',
      status: 'processing',
      ownerLinkRevision: 2,
      providerCursor: 'opaque-provider-cursor',
      revision: 1,
      updatedAt: NOW,
    })).resolves.toBe(true)
    await expect(harness.store.putSyncCursor('workspace-1', {
      schemaVersion: 1,
      linkId: 'link-1',
      provider: 'slack',
      operationId: 'operation-resync-1',
      mode: 'full',
      status: 'processing',
      ownerLinkRevision: 2,
      providerCursor: 'opaque-provider-cursor-2',
      revision: 2,
      updatedAt: '2026-08-06T00:01:00.000Z',
    }, 1)).resolves.toBe(true)
    failNext = true
    await expect(harness.store.putSyncCursor('workspace-1', {
      schemaVersion: 1,
      linkId: 'link-1',
      provider: 'slack',
      operationId: 'operation-resync-1',
      mode: 'full',
      status: 'completed',
      ownerLinkRevision: 2,
      observedSourceAvailability: 'available',
      observedSourceState: 'active',
      completionSyncStatus: 'synced',
      revision: 3,
      updatedAt: '2026-08-06T00:02:00.000Z',
    }, 2)).resolves.toBe(false)
    expect(harness.calls[0]?.input.ConditionExpression).toBe('attribute_not_exists(#workspaceId)')
    expect(harness.calls[1]?.input.ExpressionAttributeValues).toMatchObject({
      ':storageRevision': 1,
    })
  } finally {
    harness.restore()
  }
})

test('exhausts deferred-event lookup pages and preserves provider occurrence order', async () => {
  const firstEvent = createInboundEvent('event-1')
  const secondEvent = {
    ...createInboundEvent('event-2'),
    occurredAt: '2026-08-06T00:01:00.000Z',
  }
  const harness = createHarness({
    async respond(command, callIndex) {
      const inspected = inspectCommand(command)
      const values = readRecord(
        inspected.input.ExpressionAttributeValues,
        'query expression values',
      )
      const event = callIndex === 0 ? firstEvent : secondEvent
      const installationDigest = createHash('sha256')
        .update(event.installationId)
        .digest('hex')
      const eventDigest = createHash('sha256').update(event.eventId).digest('hex')
      const recordKey = `CHAT_DEFERRED#${event.provider}#${installationDigest}#${eventDigest}`
      const lookupSortKey = `${event.occurredAt}\0${eventDigest}`
      const item = {
        workspaceId: 'workspace-1',
        recordKey,
        entryType: 'external-chat-deferred-event',
        value: {
          workspaceId: 'workspace-1',
          linkId: 'link-1',
          event,
          fingerprint: createExternalChatFingerprint(event),
          reason: 'out-of-order',
          attempt: 1,
          retryAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        },
        storageRevision: 1,
        lookupKey: values[':lookupKey'],
        lookupSortKey,
      }
      return callIndex === 0
        ? {
            Items: [item],
            LastEvaluatedKey: {
              workspaceId: item.workspaceId,
              recordKey,
              lookupKey: item.lookupKey,
              lookupSortKey,
            },
          }
        : { Items: [item] }
    },
  })
  try {
    const events = await harness.store.listDueDeferredEvents(
      'workspace-1',
      'link-1',
      '2026-08-06T00:10:00.000Z',
      2,
    )
    expect(events.map((event) => event.event.eventId)).toEqual(['event-1', 'event-2'])
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]?.input.ExclusiveStartKey).toBeDefined()
    expect(harness.calls.every((call) => call.input.IndexName === 'LookupKeyIndex')).toBe(true)
  } finally {
    harness.restore()
  }
})

test('idempotently persists the complete deferred outbound mutation and retry schedule', async () => {
  let storedRow: unknown
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        return storedRow === undefined ? {} : { Item: structuredClone(storedRow) }
      }
      if (inspected.name === 'PutCommand') {
        storedRow = structuredClone(inspected.input.Item)
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  const initial = createDeferredOutboundEvent()
  const retryAt = '2026-08-06T00:10:00.000Z'
  const updatedAt = '2026-08-06T00:02:00.000Z'
  try {
    await expect(harness.store.deferOutboundEvent(initial)).resolves.toBeUndefined()
    await expect(harness.store.deferOutboundEvent({
      ...initial,
      attempt: 2,
      retryAt,
      createdAt: '2026-08-06T00:01:00.000Z',
      updatedAt,
    })).resolves.toBeUndefined()

    const row = readRecord(storedRow, 'deferred outbound stored row')
    const value = decodeDeferredExternalChatOutboundEvent(row.value)
    expect(value).toEqual({
      ...initial,
      attempt: 2,
      retryAt,
      updatedAt,
    })
    expect(row).toMatchObject({
      workspaceId: initial.workspaceId,
      recordKey:
        `CHAT_DEFERRED_OUTBOUND#${keyDigest(initial.linkId)}#${keyDigest(initial.operationId)}`,
      entryType: 'external-chat-deferred-outbound-event',
      storageRevision: 2,
      lookupKey:
        `CHAT_DEFERRED_OUTBOUND#${keyDigest(initial.workspaceId)}#${keyDigest(initial.linkId)}`,
      lookupSortKey: `${initial.event.occurredAt}\0${keyDigest(initial.operationId)}`,
    })
    expect(harness.calls.filter((call) => call.name === 'GetCommand')).toHaveLength(2)
    const putCalls = harness.calls.filter((call) => call.name === 'PutCommand')
    expect(putCalls).toHaveLength(2)
    expect(putCalls[0]?.input.ConditionExpression).toBe('attribute_not_exists(#workspaceId)')
    expect(putCalls[1]?.input.ExpressionAttributeValues).toMatchObject({
      ':storageRevision': 1,
    })

    if (initial.event.type !== 'comment.created') {
      throw new TypeError('Expected a comment-created outbound fixture.')
    }
    const conflictingEvent: ExternalChatSyncOutboundEvent = {
      ...initial.event,
      bodyMarkdown: 'Conflicting outbound comment',
    }
    await expect(harness.store.deferOutboundEvent({
      ...initial,
      event: conflictingEvent,
      fingerprint: createExternalChatFingerprint(conflictingEvent),
    })).rejects.toMatchObject({ code: 'ExternalChatOperationConflict' })
  } finally {
    harness.restore()
  }
})

test('lists the exact outbound link FIFO without bypassing a not-due head and deletes fully scoped', async () => {
  const first = {
    ...createDeferredOutboundEvent(
      'operation-outbound-deferred-1',
      createOutboundEvent(NOW, 'comment-internal-1'),
    ),
    retryAt: '2026-08-06T01:00:00.000Z',
  }
  const second = {
    ...createDeferredOutboundEvent(
      'operation-outbound-deferred-2',
      createOutboundEvent('2026-08-06T00:01:00.000Z', 'comment-internal-2'),
    ),
    retryAt: NOW,
  }
  let queryIndex = 0
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'DeleteCommand') return {}
      if (inspected.name !== 'QueryCommand') {
        throw new TypeError(`Unexpected command: ${inspected.name}`)
      }
      const event = queryIndex === 0 ? second : first
      queryIndex += 1
      const item = {
        workspaceId: event.workspaceId,
        recordKey:
          `CHAT_DEFERRED_OUTBOUND#${keyDigest(event.linkId)}#${keyDigest(event.operationId)}`,
        entryType: 'external-chat-deferred-outbound-event',
        value: event,
        storageRevision: 1,
        lookupKey:
          `CHAT_DEFERRED_OUTBOUND#${keyDigest(event.workspaceId)}#${keyDigest(event.linkId)}`,
        lookupSortKey: `${event.event.occurredAt}\0${keyDigest(event.operationId)}`,
      }
      return queryIndex === 1
        ? {
            Items: [item],
            LastEvaluatedKey: {
              workspaceId: item.workspaceId,
              recordKey: item.recordKey,
            },
          }
        : { Items: [item] }
    },
  })
  try {
    await expect(harness.store.listDeferredOutboundEvents(
      first.workspaceId,
      first.linkId,
      2,
    )).resolves.toEqual([first, second])
    const queries = harness.calls.filter((call) => call.name === 'QueryCommand')
    expect(queries).toHaveLength(2)
    expect(queries.every((call) => call.input.IndexName === undefined)).toBe(true)
    expect(queries.every((call) => call.input.ConsistentRead === true)).toBe(true)
    expect(queries.every((call) => call.input.FilterExpression === undefined)).toBe(true)
    expect(queries[0]?.input.ExpressionAttributeValues).toEqual({
      ':workspaceId': first.workspaceId,
      ':recordPrefix': `CHAT_DEFERRED_OUTBOUND#${keyDigest(first.linkId)}#`,
    })

    await expect(harness.store.deleteDeferredOutboundEvent(
      first.workspaceId,
      first.linkId,
      first.operationId,
    )).resolves.toBeUndefined()
    const deletion = harness.calls.find((call) => call.name === 'DeleteCommand')
    expect(deletion?.input.Key).toEqual({
      workspaceId: first.workspaceId,
      recordKey:
        `CHAT_DEFERRED_OUTBOUND#${keyDigest(first.linkId)}#${keyDigest(first.operationId)}`,
    })
    expect(deletion?.input.ConditionExpression).toContain('#value.#workspaceId = :workspaceId')
    expect(deletion?.input.ConditionExpression).toContain('#value.#linkId = :linkId')
    expect(deletion?.input.ConditionExpression).toContain('#value.#operationId = :operationId')
    expect(deletion?.input.ExpressionAttributeValues).toMatchObject({
      ':entryType': 'external-chat-deferred-outbound-event',
      ':workspaceId': first.workspaceId,
      ':linkId': first.linkId,
      ':operationId': first.operationId,
    })
  } finally {
    harness.restore()
  }
})

test('merges link-owned bindings without rewriting their identity rows', async () => {
  const link = createLink()
  const binding = createBinding()
  const harness = createHarness({
    async respond(command, callIndex) {
      const inspected = inspectCommand(command)
      if (callIndex === 0) {
        const key = readRecord(inspected.input.Key, 'link Get key')
        return {
          Item: {
            workspaceId: key.workspaceId,
            recordKey: key.recordKey,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link,
              sourceDigest: createExternalChatSourceDigest({
                provider: link.provider,
                externalWorkspaceId: link.source.externalWorkspaceId,
                conversationExternalId: link.source.conversationExternalId,
                threadExternalId: link.source.threadExternalId,
              }),
              sourceAuthorizationRevision: 1,
              active: true,
            },
            storageRevision: 1,
          },
        }
      }
      if (callIndex === 1) return {}
      if (callIndex === 2) {
        const values = readRecord(
          inspected.input.ExpressionAttributeValues,
          'binding query values',
        )
        return {
          Items: [{
            workspaceId: 'workspace-1',
            recordKey: `${String(values[':recordPrefix'])}${'c'.repeat(64)}`,
            entryType: 'external-chat-binding-external',
            value: {
              workspaceId: 'workspace-1',
              binding,
              storageRevision: 1,
            },
            storageRevision: 1,
          }],
        }
      }
      if (callIndex === 3) return {}
      return {}
    },
  })
  try {
    const result = await harness.store.mergeLinks({
      workspaceId: 'workspace-1',
      canonicalTeamId: 'team-canonical',
      canonicalWorkItemId: 'work-item-canonical',
      duplicateTeamId: 'team-1',
      duplicateWorkItemId: 'work-item-1',
      links: [{ linkId: 'link-1', expectedRevision: 1 }],
      mergedAt: '2026-08-06T00:10:00.000Z',
    })
    expect(result).toMatchObject({
      kind: 'merged',
      movedMessageBindingCount: 1,
      movedFileIds: ['file-1'],
      movedLinks: [{
        teamId: 'team-canonical',
        workItemId: 'work-item-canonical',
        revision: 2,
      }],
    })
    const transaction = harness.calls[4]
    expect(transaction?.name).toBe('TransactWriteCommand')
    const transactItems = transaction?.input.TransactItems
    if (!Array.isArray(transactItems)) throw new TypeError('Expected merge transaction items.')
    expect(transactItems).toHaveLength(3)
    const putItems = transactItems.filter((item) =>
      readRecord(item, 'merge transaction item').Put !== undefined
    )
    const entryTypes = putItems.map((item) => {
      const put = readRecord(readRecord(item, 'merge transaction item').Put, 'merge Put')
      return readRecord(put.Item, 'merge Put item').entryType
    })
    expect(entryTypes).toEqual([
      'external-chat-link',
      'external-chat-canonical-redirect',
    ])
    const lifecycleFence = readRecord(transactItems[1], 'lifecycle merge fence')
    expect(lifecycleFence.ConditionCheck).toBeDefined()
  } finally {
    harness.restore()
  }
})

test('persists one canonical lineage redirect for every moved link', async () => {
  const first = createLink('link-1')
  const second: ExternalChatWorkItemLink = {
    ...createLink('link-2'),
    source: {
      ...createLink('link-2').source,
      threadExternalId: 'thread-external-2',
      rootMessageExternalId: 'message-root-2',
    },
  }
  const links = [first, second]
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'merge Get key')
        const link = links.find((candidate) =>
          key.recordKey === `CHAT_LINK#${keyDigest(candidate.id)}`
        )
        if (!link) return {}
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey: key.recordKey,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link,
              sourceDigest: createExternalChatSourceDigest({
                provider: link.provider,
                externalWorkspaceId: link.source.externalWorkspaceId,
                conversationExternalId: link.source.conversationExternalId,
                threadExternalId: link.source.threadExternalId,
              }),
              sourceAuthorizationRevision: 1,
              active: true,
            },
            storageRevision: 1,
          },
        }
      }
      if (inspected.name === 'QueryCommand') return { Items: [] }
      if (inspected.name === 'TransactWriteCommand') return {}
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    const result = await harness.store.mergeLinks({
      workspaceId: 'workspace-1',
      canonicalTeamId: 'team-canonical',
      canonicalWorkItemId: 'work-item-canonical',
      duplicateTeamId: 'team-1',
      duplicateWorkItemId: 'work-item-1',
      links: links.map((link) => ({ linkId: link.id, expectedRevision: link.revision })),
      mergedAt: '2026-08-06T00:10:00.000Z',
    })
    expect(result).toMatchObject({ kind: 'merged' })
    if (result.kind !== 'merged') throw new TypeError('Expected a successful merge result.')
    expect(result.redirects.map((redirect) => redirect.linkId)).toEqual(['link-1', 'link-2'])
    const transaction = harness.calls.at(-1)
    expect(transaction?.name).toBe('TransactWriteCommand')
    const transactItems = transaction?.input.TransactItems
    if (!Array.isArray(transactItems)) throw new TypeError('Expected merge transaction items.')
    const redirectRows = transactItems.flatMap((item) => {
      const put = readRecord(item, 'merge transaction item').Put
      if (put === undefined) return []
      const stored = readRecord(readRecord(put, 'merge Put').Item, 'merge Put item')
      return stored.entryType === 'external-chat-canonical-redirect' ? [stored] : []
    })
    expect(redirectRows).toHaveLength(2)
    expect(redirectRows.map((row) => row.recordKey)).toEqual([
      `CHAT_REDIRECT#${keyDigest('team-1')}#${keyDigest('work-item-1')}#${keyDigest('link-1')}`,
      `CHAT_REDIRECT#${keyDigest('team-1')}#${keyDigest('work-item-1')}#${keyDigest('link-2')}`,
    ])
  } finally {
    harness.restore()
  }
})

test('rejects a merge when a binding commit advances the owner after its scan', async () => {
  const link = createLink()
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'merge race Get key')
        if (key.recordKey !== `CHAT_LINK#${keyDigest(link.id)}`) return {}
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey: key.recordKey,
            entryType: 'external-chat-link',
            value: {
              workspaceId: 'workspace-1',
              link,
              sourceDigest: sourceDigest(),
              sourceAuthorizationRevision: 1,
              active: true,
            },
            storageRevision: 1,
          },
        }
      }
      if (inspected.name === 'QueryCommand') return { Items: [] }
      if (inspected.name === 'TransactWriteCommand') {
        const transactItems = inspected.input.TransactItems
        if (!Array.isArray(transactItems)) throw new TypeError('Expected merge transaction items.')
        const linkPut = readRecord(
          readRecord(transactItems[0], 'merge link item').Put,
          'merge link Put',
        )
        expect(readRecord(
          linkPut.ExpressionAttributeValues,
          'merge link conditions',
        )[':storageRevision']).toBe(1)
        throw conditionalFailure()
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.mergeLinks({
      workspaceId: 'workspace-1',
      canonicalTeamId: 'team-canonical',
      canonicalWorkItemId: 'work-item-canonical',
      duplicateTeamId: 'team-1',
      duplicateWorkItemId: 'work-item-1',
      links: [{ linkId: link.id, expectedRevision: link.revision }],
      mergedAt: '2026-08-06T00:10:00.000Z',
    })).resolves.toEqual({ kind: 'conflict' })
  } finally {
    harness.restore()
  }
})

test('fails closed when a tenant-scoped DynamoDB row has an unknown schema', async () => {
  const harness = createHarness({
    async respond(command) {
      const input = inspectCommand(command).input
      const key = readRecord(input.Key, 'link Get key')
      return {
        Item: {
          workspaceId: key.workspaceId,
          recordKey: key.recordKey,
          entryType: 'external-chat-link',
          value: {
            workspaceId: 'workspace-1',
            link: {
              ...createLink(),
              provider: 'unknown-provider',
            },
            sourceDigest: sourceDigest(),
            sourceAuthorizationRevision: 1,
            active: true,
          },
          storageRevision: 1,
        },
      }
    },
  })
  try {
    const request = harness.store.getLink('workspace-1', 'link-1')
    await expect(request).rejects.toBeInstanceOf(ExternalChatError)
    await expect(request).rejects.toMatchObject({
      code: 'ExternalChatPersistenceFailed',
      retryable: false,
    })
  } finally {
    harness.restore()
  }
})
