import { describe, expect, test } from 'bun:test'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  type ExternalChatAttachment,
  type ExternalChatInboundEvent,
  type ExternalChatMessage,
  type ExternalChatThreadSnapshot,
} from '@mukuroji/contracts'
import {
  normalizeChatProviderMessage,
  normalizeChatProviderThreadMutationResult,
  normalizeChatProviderThreadSnapshot,
  normalizeChatProviderWebhook,
} from './chat-provider-normalizer'

const observedAt = '2026-08-06T03:00:00.000Z'

describe('chat provider output normalizer', () => {
  test('deeply projects messages and removes provider runtime properties and internal File claims', () => {
    const message = Object.assign(createActiveMessage(), {
      providerAccessToken: 'message-secret',
      actor: Object.assign(createActor(), { email: 'private@example.test' }),
      attachments: [Object.assign(createAttachment(), {
        importedFileId: 'provider-forged-file-id',
        temporaryDownloadUrl: 'https://files.example.test/private?token=secret',
      })],
    })

    const normalized = normalizeChatProviderMessage(message)

    expect(normalized.actor).toEqual({
      externalId: 'actor-1',
      kind: 'person',
      displayName: 'Operator',
    })
    expect(normalized.attachments).toEqual([createAttachment()])
    expect(normalized.attachments[0]).not.toHaveProperty('importedFileId')
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toContain('providerAccessToken')
    expect(serialized).not.toContain('temporaryDownloadUrl')
    expect(serialized).not.toContain('private@example.test')
  })

  test('rejects unsafe permalinks, unbounded content and arrays, and noncanonical timestamps', () => {
    for (const permalink of [
      'http://chat.example.test/messages/message-1',
      'https://user:password@chat.example.test/messages/message-1',
      'https://chat.example.test/messages/message-1?token=secret',
      'https://chat.example.test/messages/message-1#temporary-secret',
      'https://chat.example.test:8443/messages/message-1',
      'https://localhost/messages/message-1',
      'https://127.0.0.1/messages/message-1',
      'javascript:alert(1)',
    ]) {
      expectInvalidResponse(() => normalizeChatProviderMessage({
        ...createActiveMessage(),
        permalink,
      }))
    }
    expectInvalidResponse(() => normalizeChatProviderMessage({
      ...createActiveMessage(),
      bodyMarkdown: 'x'.repeat(262_145),
    }))
    expectInvalidResponse(() => normalizeChatProviderMessage({
      ...createActiveMessage(),
      attachments: Array.from({ length: 101 }, (_, index) =>
        createAttachment(`attachment-${index}`)),
    }))
    expectInvalidResponse(() => normalizeChatProviderMessage({
      ...createActiveMessage(),
      updatedAt: '2026-08-06T03:00:00Z',
    }))
    expectInvalidResponse(() => normalizeChatProviderMessage(
      {
        ...createActiveMessage(),
        permalink: 'https://off-provider.example/messages/message-1',
      },
      ['chat.example.test'],
    ))
    expectInvalidResponse(() => normalizeChatProviderMessage(
      {
        ...createActiveMessage(),
        attachments: [{
          ...createAttachment(),
          permalink: 'https://off-provider.example/files/attachment-1',
        }],
      },
      ['chat.example.test'],
    ))
    expect(normalizeChatProviderMessage(
      createActiveMessage(),
      ['chat.example.test'],
    ).permalink).toBe('https://chat.example.test/messages/message-1')
  })

  test('enforces restrictive deletion and retention projections while preserving allowed metadata', () => {
    const retainedMessage: ExternalChatMessage = {
      ...createActiveMessage(),
      state: 'retained-metadata',
      bodyMarkdown: undefined,
      quotedRanges: [],
    }
    const retainedThread: ExternalChatThreadSnapshot = {
      ...createThreadSnapshot(retainedMessage),
      state: 'retained-metadata',
    }

    expect(normalizeChatProviderThreadSnapshot(retainedThread)).toMatchObject({
      state: 'retained-metadata',
      workspace: { displayName: 'Operations' },
      messages: [{
        state: 'retained-metadata',
        actor: { displayName: 'Operator' },
        permalink: 'https://chat.example.test/messages/message-1',
        attachments: [{ fileName: 'incident.txt' }],
      }],
    })

    expectInvalidResponse(() => normalizeChatProviderMessage({
      ...retainedMessage,
      availability: 'permission-lost',
      bodyMarkdown: 'must not survive permission loss',
    }))
    expectInvalidResponse(() => normalizeChatProviderMessage({
      ...createDeletedMessage(),
      actor: createActor(),
    }))
    expectInvalidResponse(() => normalizeChatProviderMessage({
      ...createDeletedMessage(),
      state: 'retention-expired',
      deletedAt: undefined,
      permalink: 'https://chat.example.test/messages/message-1',
    }))
    expectInvalidResponse(() => normalizeChatProviderThreadSnapshot({
      ...createThreadSnapshot(createDeletedMessage()),
      state: 'deleted',
    }))
    expect(normalizeChatProviderMessage(createDeletedMessage())).toEqual(createDeletedMessage())
  })

  test('projects webhook events and mutation results without forwarding adapter extras', () => {
    const event = Object.assign(createMessageCreatedEvent(), {
      providerRequestId: 'runtime-request-secret',
      message: Object.assign(createActiveMessage(), { rawProviderBody: 'raw-secret' }),
    })
    const normalized = normalizeChatProviderWebhook(Object.assign({
      deliveryId: 'delivery-1',
      events: [event],
      originMarkers: { 'event-1': 'authenticated-origin-marker' },
    }, { signatureKey: 'signature-secret' }))
    const mutation = normalizeChatProviderThreadMutationResult(Object.assign({
      externalVersion: '2',
      completed: true,
      occurredAt: observedAt,
    }, { rawProviderResponse: 'provider-secret' }))

    expect(normalized).toEqual({
      deliveryId: 'delivery-1',
      events: [createMessageCreatedEvent()],
      originMarkers: { 'event-1': 'authenticated-origin-marker' },
    })
    expect(mutation).toEqual({
      externalVersion: '2',
      completed: true,
      occurredAt: observedAt,
    })
  })
})

/**
 * Creates a provider actor containing only approved provenance fields.
 *
 * @returns Synthetic actor metadata.
 */
function createActor(): NonNullable<ExternalChatMessage['actor']> {
  return {
    externalId: 'actor-1',
    kind: 'person',
    displayName: 'Operator',
  }
}

/**
 * Creates one safe external attachment.
 *
 * @param externalId - Provider attachment identifier.
 * @returns Synthetic attachment metadata.
 */
function createAttachment(externalId = 'attachment-1'): ExternalChatAttachment {
  return {
    externalId,
    fileName: 'incident.txt',
    contentType: 'text/plain',
    sizeBytes: 42,
    permalink: `https://chat.example.test/files/${externalId}`,
    availability: 'available',
    state: 'active',
    createdAt: observedAt,
  }
}

/**
 * Creates one active provider message safe for import.
 *
 * @returns Synthetic active message.
 */
function createActiveMessage(): ExternalChatMessage {
  return {
    externalId: 'message-1',
    externalVersion: '1',
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
    permalink: 'https://chat.example.test/messages/message-1',
    availability: 'available',
    state: 'active',
    actor: createActor(),
    bodyMarkdown: 'Investigate the incident',
    quotedRanges: [],
    attachments: [createAttachment()],
    postedAt: observedAt,
    updatedAt: observedAt,
  }
}

/**
 * Creates one fully redacted provider message tombstone.
 *
 * @returns Synthetic deleted message containing only lifecycle-safe fields.
 */
function createDeletedMessage(): ExternalChatMessage {
  return {
    externalId: 'message-1',
    externalVersion: '2',
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
    availability: 'available',
    state: 'deleted',
    quotedRanges: [],
    attachments: [],
    postedAt: observedAt,
    updatedAt: observedAt,
    deletedAt: observedAt,
  }
}

/**
 * Creates one provider thread snapshot around a selected message.
 *
 * @param message - Message returned in the bounded thread page.
 * @returns Synthetic thread snapshot.
 */
function createThreadSnapshot(message: ExternalChatMessage): ExternalChatThreadSnapshot {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    workspace: {
      provider: 'slack',
      externalId: 'workspace-1',
      displayName: 'Operations',
      permalink: 'https://chat.example.test/workspaces/workspace-1',
    },
    conversation: {
      externalId: 'conversation-1',
      externalWorkspaceId: 'workspace-1',
      kind: 'channel',
      displayName: 'incidents',
      permalink: 'https://chat.example.test/conversations/conversation-1',
    },
    externalId: 'thread-1',
    rootMessageExternalId: 'message-1',
    permalink: 'https://chat.example.test/threads/thread-1',
    availability: 'available',
    state: 'active',
    messageCount: 1,
    messages: [message],
    hasMoreMessages: false,
    createdAt: observedAt,
    updatedAt: observedAt,
  }
}

/**
 * Creates one normalized message creation event.
 *
 * @returns Synthetic provider event.
 */
function createMessageCreatedEvent(): Extract<
  ExternalChatInboundEvent,
  { type: 'message.created' }
> {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    type: 'message.created',
    eventId: 'event-1',
    correlationId: 'correlation-1',
    installationId: 'installation-1',
    provider: 'slack',
    externalWorkspaceId: 'workspace-1',
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
    occurredAt: observedAt,
    message: createActiveMessage(),
  }
}

/**
 * Requires a callback to fail at the strict provider response boundary.
 *
 * @param callback - Synchronous normalization attempt.
 */
function expectInvalidResponse(callback: () => unknown): void {
  try {
    callback()
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: 'ChatProviderInvalidResponse' })
    return
  }
  throw new Error('Expected provider response normalization to fail.')
}
