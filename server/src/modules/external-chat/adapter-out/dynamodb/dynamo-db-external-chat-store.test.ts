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
    availability: 'permission-lost',
    state: 'retained-metadata',
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
    ownerTeamId: 'team-1',
    ownerWorkItemId: 'work-item-1',
    ownerLinkRevision: 1,
    expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
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
  return createExternalChatSourceDigest({
    provider: 'slack',
    externalWorkspaceId: 'workspace-external-1',
    conversationExternalId: 'conversation-external-1',
    threadExternalId: 'thread-external-1',
  })
}

/** Creates the SHA-256 component used by opaque DynamoDB record and lookup keys. */
function keyDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Creates one persisted active-link row for merge scan fixtures. */
function createActiveLinkRowFixture(
  link: ExternalChatWorkItemLink,
  storedValue?: unknown,
): UnknownRecord {
  return {
    workspaceId: 'workspace-1',
    recordKey: `CHAT_LINK#${keyDigest(link.id)}`,
    entryType: 'external-chat-link',
    value: storedValue ?? {
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
    storageRevision: link.revision,
  }
}

/** Creates one persisted Work Item owner-manifest row. */
function createWorkItemLinkManifestRow(
  teamId: string,
  workItemId: string,
  activeLinkCount: number,
  generation: number,
): UnknownRecord {
  return {
    workspaceId: 'workspace-1',
    recordKey: `CHAT_WORK_ITEM_LINKS#${keyDigest(teamId)}#${keyDigest(workItemId)}`,
    entryType: 'external-chat-work-item-link-manifest',
    value: {
      workspaceId: 'workspace-1',
      teamId,
      workItemId,
      activeLinkCount,
      generation,
    },
    storageRevision: generation,
  }
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
  const owner = createLink()
  const retained = createInboundEvent('parent-event-retained')
  const purged = createInboundEvent('content-event-purged')
  const deferredValue = (event: ExternalChatInboundEvent) => ({
    workspaceId: 'workspace-1',
    linkId: 'link-1',
    event,
    expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
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
            recordKey:
              `CHAT_DEFERRED_FIFO#${keyDigest('link-1')}#${event.occurredAt}#${keyDigest(event.eventId)}`,
            entryType: 'external-chat-deferred-event',
            value: deferredValue(event),
            storageRevision: 1,
          })),
        }
      }
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'deferred purge key')
        const recordKey = key.recordKey
        if (typeof recordKey !== 'string') throw new TypeError('Expected deferred purge key.')
        if (recordKey === `CHAT_LINK#${keyDigest(owner.id)}`) {
          return { Item: createActiveLinkRowFixture(owner) }
        }
        if (recordKey.startsWith('CHAT_PARENT_STATE#')) return {}
        return {
          Item: {
            workspaceId: 'workspace-1',
            recordKey,
            entryType: 'external-chat-deferred-event',
            value: deferredValue(purged),
            storageRevision: 1,
          },
        }
      }
      if (inspected.name === 'TransactWriteCommand') return {}
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.purgeDeferredEventsForLink(
      'workspace-1',
      'link-1',
      retained.eventId,
      owner.revision,
      { workspace: undefined, conversation: undefined },
    )).resolves.toBe(1)
    const transaction = harness.calls.find((call) => call.name === 'TransactWriteCommand')
    const items = transaction?.input.TransactItems
    if (!Array.isArray(items)) throw new TypeError('Expected deferred purge transaction items.')
    expect(items).toHaveLength(5)
    expect(items.slice(0, 2).map((item) => readRecord(
      readRecord(item, 'deferred purge action').Delete,
      'deferred purge delete',
    ).Key)).toEqual([
      {
        workspaceId: 'workspace-1',
        recordKey:
          `CHAT_DEFERRED#${purged.provider}#${keyDigest(purged.installationId)}#${keyDigest(purged.eventId)}`,
      },
      {
        workspaceId: 'workspace-1',
        recordKey:
          `CHAT_DEFERRED_FIFO#${keyDigest('link-1')}#${purged.occurredAt}#${keyDigest(purged.eventId)}`,
      },
    ])
    const ownerCondition = readRecord(
      readRecord(items[2], 'deferred purge owner action').ConditionCheck,
      'deferred purge owner condition',
    )
    expect(ownerCondition.ExpressionAttributeValues).toMatchObject({ ':linkRevision': 1 })
    for (const parentAction of items.slice(3)) {
      const condition = readRecord(
        readRecord(parentAction, 'deferred purge parent action').ConditionCheck,
        'deferred purge parent condition',
      )
      expect(condition.ConditionExpression).toBe('attribute_not_exists(#workspaceId)')
    }
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
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[0]?.name).toBe('GetCommand')
    expect(harness.calls[0]?.input.ConsistentRead).toBe(true)
    expect(harness.calls[1]?.name).toBe('TransactWriteCommand')
    const transactItems = harness.calls[1]?.input.TransactItems
    expect(Array.isArray(transactItems)).toBe(true)
    if (!Array.isArray(transactItems)) throw new TypeError('Expected transaction items.')
    expect(transactItems).toHaveLength(6)
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
    const conditionKeys = transactItems.slice(3, 5).map((item) => {
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
    const manifestPut = readRecord(
      readRecord(transactItems[5], 'owner manifest transaction item').Put,
      'owner manifest Put',
    )
    const manifestItem = readRecord(manifestPut.Item, 'owner manifest item')
    expect(manifestItem.entryType).toBe('external-chat-work-item-link-manifest')
    expect(manifestItem.value).toMatchObject({
      teamId: 'team-1',
      workItemId: 'work-item-1',
      activeLinkCount: 1,
      generation: 1,
    })
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
            availability: 'permission-lost',
            state: 'retained-metadata',
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
      'GetCommand',
      'TransactWriteCommand',
      'GetCommand',
      'GetCommand',
      'GetCommand',
      'GetCommand',
    ])
    for (const call of harness.calls.filter((call) => call.name === 'GetCommand')) {
      expect(call.input.ConsistentRead).toBe(true)
    }
  } finally {
    harness.restore()
  }
})

test('does not misclassify a transaction cancellation without explicit reasons', async () => {
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') return {}
      if (inspected.name === 'TransactWriteCommand') {
        const error = new Error('transaction canceled without modeled reasons')
        error.name = 'TransactionCanceledException'
        throw error
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.createLink({
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
    })).rejects.toMatchObject({
      code: 'ExternalChatPersistenceFailed',
      retryable: true,
    })
    expect(harness.calls.map((call) => call.name)).toEqual([
      'GetCommand',
      'TransactWriteCommand',
    ])
  } finally {
    harness.restore()
  }
})

test('classifies a conditional link write as an idempotent replay through strong reads', async () => {
  const link = createLink()
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'TransactWriteCommand') throw transactionConditionalFailure()
      if (inspected.name !== 'GetCommand') {
        throw new TypeError(`Unexpected command: ${inspected.name}`)
      }
      const key = readRecord(inspected.input.Key, 'Get key')
      if (String(key.recordKey).startsWith('CHAT_WORK_ITEM_LINKS#')) return {}
      if (String(key.recordKey).startsWith('CHAT_LINK_RECEIPT#')) {
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
      return { Item: createActiveLinkRowFixture(link) }
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
    expect(harness.calls.map((call) => call.name)).toEqual([
      'GetCommand',
      'TransactWriteCommand',
      'GetCommand',
      'GetCommand',
    ])
    for (const call of harness.calls.filter((call) => call.name === 'GetCommand')) {
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

test('does not resume a completed retryable inbound failure', async () => {
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
    eventId: 'event-retryable-failure',
    fingerprint: DIGEST,
    operationId: 'operation-inbound-retryable-failure',
    claimedAt: NOW,
    leaseExpiresAt: LEASE,
  }
  const outcome: ExternalChatSyncOutcome = {
    kind: 'failed',
    operationId: claim.operationId,
    eventId: claim.eventId,
    errorCode: 'ExternalChatSourceUnavailable',
    retryable: true,
    occurredAt: '2026-08-06T00:01:00.000Z',
  }
  try {
    await expect(harness.store.claimInboundEvent(claim)).resolves.toMatchObject({ kind: 'claimed' })
    await expect(harness.store.completeInboundEvent({
      ...claim,
      expectedAttempt: 1,
      outcome,
      completedAt: outcome.occurredAt,
    })).resolves.toBe(true)
    await expect(harness.store.claimInboundEvent({
      ...claim,
      claimedAt: '2026-08-06T00:10:00.000Z',
      leaseExpiresAt: '2026-08-06T00:15:00.000Z',
    })).resolves.toMatchObject({ kind: 'duplicate' })
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

test('persists monotonic installation retry fences across renew, release, and reacquire', async () => {
  let storedRow: UnknownRecord | undefined
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        return storedRow === undefined ? {} : { Item: structuredClone(storedRow) }
      }
      if (inspected.name === 'PutCommand') {
        storedRow = readRecord(inspected.input.Item, 'outbound retry permit row')
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    const acquired = await harness.store.acquireOutboundRetryPermit({
      workspaceId: 'workspace-1',
      provider: 'slack',
      installationId: 'installation-1',
      ownerId: 'worker-attempt-1',
      acquiredAt: NOW,
      leaseExpiresAt: LEASE,
    })
    if (!acquired) throw new Error('Expected the first outbound retry permit.')
    expect(acquired.fenceToken).toBe(1)
    await expect(harness.store.acquireOutboundRetryPermit({
      workspaceId: 'workspace-1',
      provider: 'slack',
      installationId: 'installation-1',
      ownerId: 'worker-attempt-busy',
      acquiredAt: '2026-08-06T00:01:00.000Z',
      leaseExpiresAt: '2026-08-06T00:06:00.000Z',
    })).resolves.toBeUndefined()
    const renewed = await harness.store.renewOutboundRetryPermit({
      permit: acquired,
      renewedAt: '2026-08-06T00:01:00.000Z',
      leaseExpiresAt: '2026-08-06T00:06:00.000Z',
    })
    if (!renewed) throw new Error('Expected the outbound retry permit renewal.')
    await expect(harness.store.validateOutboundRetryPermit({
      permit: renewed,
      checkedAt: '2026-08-06T00:02:00.000Z',
    })).resolves.toBe(true)
    await expect(harness.store.releaseOutboundRetryPermit({
      permit: renewed,
      releasedAt: '2026-08-06T00:02:00.000Z',
    })).resolves.toBe(true)
    await expect(harness.store.validateOutboundRetryPermit({
      permit: renewed,
      checkedAt: '2026-08-06T00:02:00.000Z',
    })).resolves.toBe(false)
    await expect(harness.store.acquireOutboundRetryPermit({
      workspaceId: 'workspace-1',
      provider: 'slack',
      installationId: 'installation-1',
      ownerId: 'worker-attempt-2',
      acquiredAt: '2026-08-06T00:02:00.000Z',
      leaseExpiresAt: '2026-08-06T00:07:00.000Z',
    })).resolves.toMatchObject({ fenceToken: 2, ownerId: 'worker-attempt-2' })
  } finally {
    harness.restore()
  }
})

test('prepares then atomically terminalizes an exhausted receipt and both queue rows', async () => {
  const deferred = createDeferredOutboundEvent()
  const identityKey =
    `CHAT_DEFERRED_OUTBOUND#${keyDigest(deferred.linkId)}#${keyDigest(deferred.operationId)}`
  const fifoKey =
    `CHAT_DEFERRED_OUTBOUND_FIFO#${keyDigest(deferred.linkId)}#${deferred.event.occurredAt}#${keyDigest(deferred.operationId)}`
  const receiptKey =
    `CHAT_OUTBOUND#${keyDigest(deferred.linkId)}#${keyDigest(deferred.operationId)}`
  let receipt: unknown = {
    workspaceId: deferred.workspaceId,
    linkId: deferred.linkId,
    operationId: deferred.operationId,
    fingerprint: deferred.fingerprint,
    state: 'completed',
    attempt: deferred.attempt,
    leaseExpiresAt: LEASE,
    outcome: {
      kind: 'deferred',
      operationId: deferred.operationId,
      reason: 'rate-limited',
      retryAt: deferred.retryAt,
      occurredAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  }
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'outbound DLQ row key')
        if (key.recordKey === receiptKey) {
          return {
            Item: {
              workspaceId: deferred.workspaceId,
              recordKey: receiptKey,
              entryType: 'external-chat-outbound-receipt',
              value: structuredClone(receipt),
              storageRevision: 1,
            },
          }
        }
        if (key.recordKey === identityKey || key.recordKey === fifoKey) {
          return {
            Item: {
              workspaceId: deferred.workspaceId,
              recordKey: key.recordKey,
              entryType: 'external-chat-deferred-outbound-event',
              value: deferred,
              storageRevision: 1,
            },
          }
        }
      }
      if (inspected.name === 'TransactWriteCommand') {
        const items = inspected.input.TransactItems
        if (!Array.isArray(items)) throw new TypeError('Expected outbound DLQ transaction items.')
        for (const item of items) {
          const putValue = readRecord(item, 'outbound DLQ transaction item').Put
          if (putValue === undefined) continue
          const put = readRecord(putValue, 'outbound DLQ transaction Put')
          const row = readRecord(put.Item, 'outbound DLQ transaction row')
          if (row.entryType === 'external-chat-outbound-receipt') {
            receipt = structuredClone(row.value)
          }
        }
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.prepareOutboundDeadLetterOperation({
      workspaceId: deferred.workspaceId,
      linkId: deferred.linkId,
      operationId: deferred.operationId,
      expectedAttempt: deferred.attempt,
      reason: 'max-attempts',
      deadLetteredAt: '2026-08-06T00:10:00.000Z',
    })).resolves.toMatchObject({
      kind: 'prepared',
      deferred: { attempt: deferred.attempt },
      reason: 'max-attempts',
    })
    await expect(harness.store.deadLetterOutboundOperation({
      workspaceId: deferred.workspaceId,
      linkId: deferred.linkId,
      operationId: deferred.operationId,
      expectedAttempt: deferred.attempt,
      reason: 'max-attempts',
      deadLetteredAt: '2026-08-06T00:10:00.000Z',
    })).resolves.toBe(true)
    const transactions = harness.calls.filter((call) => call.name === 'TransactWriteCommand')
    const transaction = transactions[transactions.length - 1]
    const items = transaction?.input.TransactItems
    if (!Array.isArray(items)) throw new TypeError('Expected outbound DLQ transaction items.')
    expect(items).toHaveLength(3)
    const put = readRecord(readRecord(items[0], 'outbound DLQ receipt action').Put, 'receipt put')
    const terminalRow = readRecord(put.Item, 'terminal outbound receipt row')
    expect(terminalRow.value).toMatchObject({
      state: 'dead-lettered',
      deadLetterReason: 'max-attempts',
      outcome: {
        kind: 'failed',
        errorCode: 'ExternalChatRetryExhausted',
        retryable: false,
      },
    })
    expect(items.slice(1).map((item) => readRecord(
      readRecord(item, 'outbound DLQ delete action').Delete,
      'outbound DLQ delete',
    ).Key)).toEqual([
      { workspaceId: deferred.workspaceId, recordKey: identityKey },
      { workspaceId: deferred.workspaceId, recordKey: fifoKey },
    ])
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
        if (recordKey.startsWith('CHAT_WORK_ITEM_LINKS#')) {
          const duplicateManifestKey =
            `CHAT_WORK_ITEM_LINKS#${keyDigest('team-1')}#${keyDigest('work-item-1')}`
          return recordKey === duplicateManifestKey
            ? { Item: createWorkItemLinkManifestRow('team-1', 'work-item-1', 1, 1) }
            : {}
        }
        return {}
      }
      if (inspected.name === 'QueryCommand') {
        const values = readRecord(
          inspected.input.ExpressionAttributeValues,
          'merge scan values',
        )
        if (values[':recordPrefix'] !== 'CHAT_LINK#') return { Items: [] }
        return {
          Items: [{
            ...createActiveLinkRowFixture(createLink(), structuredClone(linkValue)),
            storageRevision: linkStorageRevision,
          }],
        }
      }
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
      expectedDuplicateLinkGeneration: 1,
      expectedDuplicateLinkCount: 1,
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
      expectedDuplicateLinkGeneration: 1,
      expectedDuplicateLinkCount: 1,
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
      expectedDuplicateLinkGeneration: 1,
      expectedDuplicateLinkCount: 1,
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
        if (recordKey.startsWith('CHAT_WORK_ITEM_LINKS#')) {
          return { Item: createWorkItemLinkManifestRow('team-1', 'work-item-1', 1, 1) }
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
      if (inspected.name === 'QueryCommand') return { Items: [] }
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
      sourceAuthorizationRevision: 2,
      lifecycleOperationId: 'lifecycle-1',
    })).resolves.toMatchObject({ kind: 'updated' })
    const updateTransaction = [...harness.calls]
      .reverse()
      .find((call) => call.name === 'TransactWriteCommand')
    const updateItems = updateTransaction?.input.TransactItems
    if (!Array.isArray(updateItems)) throw new TypeError('Expected update transaction items.')
    expect(updateItems).toHaveLength(2)
    const linkPut = readRecord(
      readRecord(updateItems[0], 'updated link transaction item').Put,
      'updated link Put',
    )
    expect(readRecord(linkPut.Item, 'updated link row').value).toMatchObject({
      sourceAuthorizationRevision: 2,
    })
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
    expect(unlinkItems).toHaveLength(4)
    expect(readRecord(unlinkItems[2], 'unlink lifecycle fence').ConditionCheck).toBeDefined()
    const manifestPut = readRecord(
      readRecord(unlinkItems[3], 'unlink owner manifest item').Put,
      'unlink owner manifest Put',
    )
    expect(readRecord(manifestPut.Item, 'unlink owner manifest row').value).toMatchObject({
      activeLinkCount: 0,
      generation: 2,
    })
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
    availability: 'available',
    state: 'active',
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
      expectedParentLifecycleFences: {
        workspace: undefined,
        conversation: undefined,
      },
    })
    expect(result).toMatchObject({
      kind: 'stored',
      record: { storageRevision: 1 },
    })
    expect(harness.calls.map((call) => call.name)).toEqual([
      'GetCommand',
      'GetCommand',
      'GetCommand',
      'GetCommand',
      'GetCommand',
      'TransactWriteCommand',
    ])
    const transactItems = harness.calls[5]?.input.TransactItems
    if (!Array.isArray(transactItems)) throw new TypeError('Expected binding transaction items.')
    expect(transactItems).toHaveLength(5)
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
      authorizationRevision: 1,
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
      authorizationRevision: 1,
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
      authorizationRevision: 1,
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

test('transactionally fences inbound deferred enqueue on both absent parent authorities', async () => {
  const link = createLink()
  const event = createInboundEvent('event-parent-fenced-defer')
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'parent-fenced deferred key')
        return key.recordKey === `CHAT_LINK#${keyDigest(link.id)}`
          ? { Item: createActiveLinkRowFixture(link) }
          : {}
      }
      if (inspected.name === 'TransactWriteCommand') return {}
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.deferEvent({
      workspaceId: 'workspace-1',
      linkId: link.id,
      event,
      expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
      fingerprint: createExternalChatFingerprint(event),
      reason: 'source-unavailable',
      attempt: 1,
      retryAt: LEASE,
      createdAt: NOW,
      updatedAt: NOW,
    })).resolves.toBeUndefined()
    const transaction = harness.calls.find((call) => call.name === 'TransactWriteCommand')
    const items = transaction?.input.TransactItems
    if (!Array.isArray(items)) throw new TypeError('Expected deferred inbound transaction items.')
    expect(items).toHaveLength(5)
    for (const parentAction of items.slice(3)) {
      const condition = readRecord(
        readRecord(parentAction, 'deferred inbound parent action').ConditionCheck,
        'deferred inbound parent condition',
      )
      const key = readRecord(condition.Key, 'deferred inbound parent key')
      expect(String(key.recordKey)).toStartWith('CHAT_PARENT_STATE#')
      expect(condition.ConditionExpression).toBe('attribute_not_exists(#workspaceId)')
    }
  } finally {
    harness.restore()
  }
})

test('reads one strongly consistent bounded deferred-event FIFO page', async () => {
  const firstEvent = createInboundEvent('event-1')
  const secondEvent = {
    ...createInboundEvent('event-2'),
    occurredAt: '2026-08-06T00:01:00.000Z',
  }
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      expect(inspected.name).toBe('QueryCommand')
      const linkDigest = createHash('sha256').update('link-1').digest('hex')
      const createItem = (event: ExternalChatInboundEvent): UnknownRecord => ({
        workspaceId: 'workspace-1',
        recordKey: `CHAT_DEFERRED_FIFO#${linkDigest}#${event.occurredAt}#${createHash('sha256').update(event.eventId).digest('hex')}`,
        entryType: 'external-chat-deferred-event',
        value: {
          workspaceId: 'workspace-1',
          linkId: 'link-1',
          event,
          expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
          fingerprint: createExternalChatFingerprint(event),
          reason: 'out-of-order',
          attempt: 1,
          retryAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        },
        storageRevision: 1,
      })
      return { Items: [createItem(firstEvent), createItem(secondEvent)] }
    },
  })
  try {
    const events = await harness.store.listDeferredEvents(
      'workspace-1',
      'link-1',
      2,
    )
    expect(events.map((event) => event.event.eventId)).toEqual(['event-1', 'event-2'])
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]?.input).toMatchObject({
      ConsistentRead: true,
      Limit: 2,
      ScanIndexForward: true,
    })
    expect(harness.calls[0]?.input).not.toHaveProperty('IndexName')
    expect(readRecord(
      harness.calls[0]?.input.ExpressionAttributeValues,
      'query expression values',
    )[':recordPrefix']).toStartWith('CHAT_DEFERRED_FIFO#')
  } finally {
    harness.restore()
  }
})

test('idempotently persists the complete deferred outbound mutation and retry schedule', async () => {
  const storedRows = new Map<string, UnknownRecord>()
  let ownerLink = createLink()
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'deferred outbound key')
        if (typeof key.recordKey !== 'string') {
          throw new TypeError('Expected a deferred outbound record key.')
        }
        if (key.recordKey === `CHAT_LINK#${keyDigest('link-1')}`) {
          return { Item: createActiveLinkRowFixture(ownerLink) }
        }
        const row = storedRows.get(key.recordKey)
        return row === undefined ? {} : { Item: structuredClone(row) }
      }
      if (inspected.name === 'TransactWriteCommand') {
        const items = inspected.input.TransactItems
        if (!Array.isArray(items)) throw new TypeError('Expected deferred outbound puts.')
        for (const item of items) {
          const putValue = readRecord(item, 'deferred outbound action').Put
          if (putValue === undefined) continue
          const put = readRecord(putValue, 'queue put')
          const row = readRecord(put.Item, 'deferred outbound row')
          if (typeof row.recordKey !== 'string') {
            throw new TypeError('Expected a deferred outbound row key.')
          }
          storedRows.set(row.recordKey, structuredClone(row))
        }
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

    const identityKey =
      `CHAT_DEFERRED_OUTBOUND#${keyDigest(initial.linkId)}#${keyDigest(initial.operationId)}`
    const row = readRecord(storedRows.get(identityKey), 'deferred outbound stored row')
    const value = decodeDeferredExternalChatOutboundEvent(row.value)
    expect(value).toEqual({
      ...initial,
      attempt: 2,
      retryAt,
      updatedAt,
    })
    expect(row).toMatchObject({
      workspaceId: initial.workspaceId,
      recordKey: identityKey,
      entryType: 'external-chat-deferred-outbound-event',
      storageRevision: 2,
    })
    expect(row).not.toHaveProperty('lookupKey')
    expect(storedRows).toHaveProperty('size', 2)
    const transactions = harness.calls.filter((call) => call.name === 'TransactWriteCommand')
    expect(transactions).toHaveLength(2)
    const replacementItems = transactions[1]?.input.TransactItems
    if (!Array.isArray(replacementItems)) {
      throw new TypeError('Expected deferred outbound replacement transaction.')
    }
    expect(replacementItems).toHaveLength(5)
    expect(replacementItems.slice(0, 2).every((item) => readRecord(
      readRecord(item, 'deferred replacement action').Put,
      'deferred replacement put',
    ).ExpressionAttributeValues !== undefined)).toBe(true)
    expect(readRecord(
      replacementItems[2],
      'deferred replacement link fence',
    ).ConditionCheck).toBeDefined()
    const linkCondition = readRecord(
      readRecord(
        replacementItems[2],
        'deferred replacement link fence',
      ).ConditionCheck,
      'deferred replacement link condition',
    )
    expect(linkCondition.ConditionExpression).toContain(
      '#value.#link.#sourceState <> :retainedMetadata',
    )
    expect(linkCondition.ExpressionAttributeValues).toMatchObject({
      ':retainedMetadata': 'retained-metadata',
    })
    for (const parentAction of replacementItems.slice(3)) {
      const condition = readRecord(
        readRecord(parentAction, 'deferred outbound parent action').ConditionCheck,
        'deferred outbound parent condition',
      )
      const key = readRecord(condition.Key, 'deferred outbound parent key')
      expect(String(key.recordKey)).toStartWith('CHAT_PARENT_STATE#')
      expect(condition.ConditionExpression).toBe('attribute_not_exists(#workspaceId)')
    }

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

    ownerLink = {
      ...ownerLink,
      sourceAvailability: 'available',
      sourceState: 'retained-metadata',
      syncStatus: 'paused',
      revision: 2,
      updatedAt,
    }
    await expect(harness.store.deferOutboundEvent({
      ...initial,
      ownerLinkRevision: 2,
    })).rejects.toMatchObject({
      code: 'ExternalChatOperationConflict',
      retryable: true,
    })
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
  const fifoKey = (event: DeferredExternalChatOutboundEvent): string =>
    `CHAT_DEFERRED_OUTBOUND_FIFO#${keyDigest(event.linkId)}#${event.event.occurredAt}#${keyDigest(event.operationId)}`
  const queueRow = (event: DeferredExternalChatOutboundEvent, recordKey: string): UnknownRecord => ({
    workspaceId: event.workspaceId,
    recordKey,
    entryType: 'external-chat-deferred-outbound-event',
    value: event,
    storageRevision: 1,
  })
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'QueryCommand') {
        return { Items: [queueRow(first, fifoKey(first)), queueRow(second, fifoKey(second))] }
      }
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'deferred outbound deletion key')
        if (typeof key.recordKey !== 'string') {
          throw new TypeError('Expected deferred outbound deletion key.')
        }
        return { Item: queueRow(first, key.recordKey) }
      }
      if (inspected.name === 'TransactWriteCommand') return {}
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.listDeferredOutboundEvents(
      first.workspaceId,
      first.linkId,
      2,
    )).resolves.toEqual([first, second])
    const queries = harness.calls.filter((call) => call.name === 'QueryCommand')
    expect(queries).toHaveLength(1)
    expect(queries.every((call) => call.input.IndexName === undefined)).toBe(true)
    expect(queries.every((call) => call.input.ConsistentRead === true)).toBe(true)
    expect(queries.every((call) => call.input.FilterExpression === undefined)).toBe(true)
    expect(queries[0]?.input.ExpressionAttributeValues).toEqual({
      ':workspaceId': first.workspaceId,
      ':recordPrefix': `CHAT_DEFERRED_OUTBOUND_FIFO#${keyDigest(first.linkId)}#`,
    })
    expect(queries[0]?.input.Limit).toBe(2)

    await expect(harness.store.deleteDeferredOutboundEvent(
      first.workspaceId,
      first.linkId,
      first.operationId,
    )).resolves.toBeUndefined()
    const transaction = harness.calls.find((call) => call.name === 'TransactWriteCommand')
    const deletes = transaction?.input.TransactItems
    if (!Array.isArray(deletes)) throw new TypeError('Expected outbound deletion transaction.')
    expect(deletes.map((item) => readRecord(
      readRecord(item, 'outbound deletion action').Delete,
      'outbound queue delete',
    ).Key)).toEqual([
      {
        workspaceId: first.workspaceId,
        recordKey:
          `CHAT_DEFERRED_OUTBOUND#${keyDigest(first.linkId)}#${keyDigest(first.operationId)}`,
      },
      { workspaceId: first.workspaceId, recordKey: fifoKey(first) },
    ])
  } finally {
    harness.restore()
  }
})

test('strongly purges every identity and FIFO payload row for one outbound link', async () => {
  const owner = createLink()
  const events = [
    createDeferredOutboundEvent(
      'operation-outbound-purge-1',
      createOutboundEvent(NOW, 'comment-outbound-purge-1'),
    ),
    createDeferredOutboundEvent(
      'operation-outbound-purge-2',
      createOutboundEvent('2026-08-06T00:01:00.000Z', 'comment-outbound-purge-2'),
    ),
  ]
  const rows = new Map<string, UnknownRecord>()
  for (const event of events) {
    const identityKey =
      `CHAT_DEFERRED_OUTBOUND#${keyDigest(event.linkId)}#${keyDigest(event.operationId)}`
    const fifoKey =
      `CHAT_DEFERRED_OUTBOUND_FIFO#${keyDigest(event.linkId)}#${event.event.occurredAt}#${keyDigest(event.operationId)}`
    for (const recordKey of [identityKey, fifoKey]) {
      rows.set(recordKey, {
        workspaceId: event.workspaceId,
        recordKey,
        entryType: 'external-chat-deferred-outbound-event',
        value: event,
        storageRevision: 1,
      })
    }
  }
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'QueryCommand') {
        return {
          Items: [...rows.values()].filter((row) =>
            String(row.recordKey).startsWith('CHAT_DEFERRED_OUTBOUND_FIFO#')
          ),
        }
      }
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'outbound purge Get key')
        if (key.recordKey === `CHAT_LINK#${keyDigest(owner.id)}`) {
          return { Item: createActiveLinkRowFixture(owner) }
        }
        if (typeof key.recordKey === 'string' && key.recordKey.startsWith('CHAT_PARENT_STATE#')) {
          return {}
        }
        return typeof key.recordKey === 'string' && rows.has(key.recordKey)
          ? { Item: structuredClone(rows.get(key.recordKey)) }
          : {}
      }
      if (inspected.name === 'TransactWriteCommand') {
        const items = inspected.input.TransactItems
        if (!Array.isArray(items)) throw new TypeError('Expected outbound purge deletes.')
        for (const item of items) {
          const action = readRecord(item, 'outbound purge transaction item')
          if (action.Delete === undefined) continue
          const deletion = readRecord(
            action.Delete,
            'outbound purge Delete',
          )
          const key = readRecord(deletion.Key, 'outbound purge delete key')
          if (typeof key.recordKey !== 'string') {
            throw new TypeError('Expected one outbound purge record key.')
          }
          rows.delete(key.recordKey)
        }
        return {}
      }
      throw new TypeError(`Unexpected command: ${inspected.name}`)
    },
  })
  try {
    await expect(harness.store.purgeDeferredOutboundEventsForLink(
      'workspace-1',
      'link-1',
      owner.revision,
      { workspace: undefined, conversation: undefined },
    )).resolves.toBe(2)
    expect(rows.size).toBe(0)
    const query = harness.calls.find((call) => call.name === 'QueryCommand')
    expect(query?.input).toMatchObject({
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ':workspaceId': 'workspace-1',
        ':recordPrefix': `CHAT_DEFERRED_OUTBOUND_FIFO#${keyDigest('link-1')}#`,
      },
    })
    const transactions = harness.calls.filter((call) => call.name === 'TransactWriteCommand')
    expect(transactions).toHaveLength(2)
    for (const transaction of transactions) {
      expect(transaction.input.TransactItems).toHaveLength(5)
    }
  } finally {
    harness.restore()
  }
})

test('merges link-owned bindings without rewriting their identity rows', async () => {
  const link = createLink()
  const binding = createBinding()
  const harness = createHarness({
    async respond(command) {
      const inspected = inspectCommand(command)
      if (inspected.name === 'GetCommand') {
        const key = readRecord(inspected.input.Key, 'merge Get key')
        if (key.recordKey === `CHAT_LINK#${keyDigest(link.id)}`) {
          return { Item: createActiveLinkRowFixture(link) }
        }
        if (
          key.recordKey ===
            `CHAT_WORK_ITEM_LINKS#${keyDigest('team-1')}#${keyDigest('work-item-1')}`
        ) {
          return { Item: createWorkItemLinkManifestRow('team-1', 'work-item-1', 1, 1) }
        }
        return {}
      }
      if (inspected.name === 'QueryCommand') {
        const values = readRecord(
          inspected.input.ExpressionAttributeValues,
          'merge query values',
        )
        if (values[':recordPrefix'] === 'CHAT_LINK#') {
          return { Items: [createActiveLinkRowFixture(link)] }
        }
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
      links: [{ linkId: 'link-1', expectedRevision: 1 }],
      expectedDuplicateLinkGeneration: 1,
      expectedDuplicateLinkCount: 1,
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
    const transaction = harness.calls.at(-1)
    expect(transaction?.name).toBe('TransactWriteCommand')
    const transactItems = transaction?.input.TransactItems
    if (!Array.isArray(transactItems)) throw new TypeError('Expected merge transaction items.')
    expect(transactItems).toHaveLength(5)
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
      'external-chat-work-item-link-manifest',
      'external-chat-work-item-link-manifest',
    ])
    const lifecycleFence = readRecord(transactItems[1], 'lifecycle merge fence')
    expect(lifecycleFence.ConditionCheck).toBeDefined()
    const ownerScan = harness.calls.find((call) =>
      call.name === 'QueryCommand' &&
      readRecord(call.input.ExpressionAttributeValues, 'owner scan values')[':recordPrefix'] ===
        'CHAT_LINK#'
    )
    expect(ownerScan?.input.ConsistentRead).toBe(true)
  } finally {
    harness.restore()
  }
})

test('returns an explicit capacity result before an oversized merge transaction', async () => {
  const harness = createHarness({
    async respond(command) {
      throw new TypeError(`Unexpected command: ${inspectCommand(command).name}`)
    },
  })
  try {
    await expect(harness.store.mergeLinks({
      workspaceId: 'workspace-1',
      canonicalTeamId: 'team-canonical',
      canonicalWorkItemId: 'work-item-canonical',
      duplicateTeamId: 'team-1',
      duplicateWorkItemId: 'work-item-1',
      links: Array.from({ length: 33 }, (_, index) => ({
        linkId: `link-${index + 1}`,
        expectedRevision: 1,
      })),
      expectedDuplicateLinkGeneration: 33,
      expectedDuplicateLinkCount: 33,
      mergedAt: '2026-08-06T00:10:00.000Z',
    })).resolves.toEqual({ kind: 'too-large', maximumLinks: 32 })
    expect(harness.calls).toHaveLength(0)
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
        if (link) return { Item: createActiveLinkRowFixture(link) }
        if (
          key.recordKey ===
            `CHAT_WORK_ITEM_LINKS#${keyDigest('team-1')}#${keyDigest('work-item-1')}`
        ) {
          return {
            Item: createWorkItemLinkManifestRow('team-1', 'work-item-1', 2, 2),
          }
        }
        return {}
      }
      if (inspected.name === 'QueryCommand') {
        const values = readRecord(inspected.input.ExpressionAttributeValues, 'merge query values')
        return values[':recordPrefix'] === 'CHAT_LINK#'
          ? { Items: links.map((link) => createActiveLinkRowFixture(link)) }
          : { Items: [] }
      }
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
      expectedDuplicateLinkGeneration: 2,
      expectedDuplicateLinkCount: 2,
      mergedAt: '2026-08-06T00:10:00.000Z',
    })
    expect(result).toMatchObject({ kind: 'merged' })
    if (result.kind !== 'merged') throw new TypeError('Expected a successful merge result.')
    expect(result.redirects.map((redirect) => redirect.linkId)).toEqual(['link-1', 'link-2'])
    const transaction = harness.calls.at(-1)
    expect(transaction?.name).toBe('TransactWriteCommand')
    const transactItems = transaction?.input.TransactItems
    if (!Array.isArray(transactItems)) throw new TypeError('Expected merge transaction items.')
    expect(transactItems).toHaveLength(8)
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
    const manifestRows = transactItems.flatMap((item) => {
      const put = readRecord(item, 'merge transaction item').Put
      if (put === undefined) return []
      const stored = readRecord(readRecord(put, 'merge Put').Item, 'merge Put item')
      return stored.entryType === 'external-chat-work-item-link-manifest' ? [stored] : []
    })
    expect(manifestRows).toHaveLength(2)
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
        if (key.recordKey === `CHAT_LINK#${keyDigest(link.id)}`) {
          return { Item: createActiveLinkRowFixture(link) }
        }
        if (
          key.recordKey ===
            `CHAT_WORK_ITEM_LINKS#${keyDigest('team-1')}#${keyDigest('work-item-1')}`
        ) {
          return { Item: createWorkItemLinkManifestRow('team-1', 'work-item-1', 1, 1) }
        }
        return {}
      }
      if (inspected.name === 'QueryCommand') {
        const values = readRecord(inspected.input.ExpressionAttributeValues, 'merge query values')
        return values[':recordPrefix'] === 'CHAT_LINK#'
          ? { Items: [createActiveLinkRowFixture(link)] }
          : { Items: [] }
      }
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
      expectedDuplicateLinkGeneration: 1,
      expectedDuplicateLinkCount: 1,
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
