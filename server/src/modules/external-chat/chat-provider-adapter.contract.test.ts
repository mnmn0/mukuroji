import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  type ExternalChatInboundEvent,
  type ExternalChatMessage,
  type ExternalChatProvider,
  type ExternalChatThreadReference,
  type ExternalChatThreadSnapshot,
} from '@mukuroji/contracts'
import {
  CHAT_PROVIDER_WEBHOOK_MAX_BYTES,
  ChatProviderAdapterError,
  ChatProviderAdapterRegistry,
  createChatProviderOriginMarker,
  validateChatProviderWebhookRequest,
  verifyChatProviderOriginMarker,
  type ChatProviderAdapter,
  type ChatProviderAuthorization,
  type ChatProviderDefinition,
  type ChatProviderNormalizedWebhook,
  type ChatProviderThreadMutationResult,
  type ChatProviderThreadPage,
  type ChatProviderWebhookRequest,
  type CreateChatProviderReplyInput,
  type DeleteChatProviderMessageInput,
  type EditChatProviderMessageInput,
  type ReadChatProviderThreadPageInput,
  type SetChatProviderThreadCompletionInput,
} from './chat-provider-adapter'

const fixtureNow = '2026-08-06T03:00:00.000Z'
const fixtureEditedAt = '2026-08-06T03:01:00.000Z'
const fixtureDeletedAt = '2026-08-06T03:02:00.000Z'
const fixtureRetryAt = '2026-08-06T03:05:00.000Z'
const fixtureMarkerSecret = 'marker-secret-with-at-least-thirty-two-bytes'
const fixtureWebhookSecret = 'provider-webhook-secret-with-at-least-thirty-two-bytes'

/** Mutable state exposed only to the shared synthetic adapter contract fixture. */
type SyntheticAdapterState = {
  /** Provider-neutral source locator used by every operation. */
  source: ExternalChatThreadReference
  /** Installation authorization accepted by the synthetic provider. */
  authorization: ChatProviderAuthorization
  /** Complete initial thread snapshot. */
  thread: ExternalChatThreadSnapshot
}

/** Synthetic provider implementation used to exercise one shared adapter contract. */
class SyntheticChatProviderAdapter implements ChatProviderAdapter {
  /** Immutable provider capability declaration. */
  readonly definition: ChatProviderDefinition

  /** Fixture state available to assertions. */
  readonly state: SyntheticAdapterState

  /** Deterministic reply results keyed by logical operation ID. */
  private readonly replyByOperationId = new Map<string, ExternalChatMessage>()

  /** Deterministic edit results keyed by logical operation ID. */
  private readonly editByOperationId = new Map<string, ExternalChatMessage>()

  /** Deterministic deletion results keyed by logical operation ID. */
  private readonly deletionByOperationId = new Map<string, ExternalChatMessage>()

  /** Deterministic thread mutation results keyed by logical operation ID. */
  private readonly completionByOperationId = new Map<
    string,
    ChatProviderThreadMutationResult
  >()

  /** Current provider message snapshots keyed by external message ID. */
  private readonly messages = new Map<string, ExternalChatMessage>()

  /** Operations whose first committed provider response is intentionally lost. */
  private readonly responseLossOperations = new Set<string>()

  /** Provider-side effect counts keyed by stable operation ID. */
  private readonly committedMutationCounts = new Map<string, number>()

  /** Provider-specific webhook signing secret. */
  private readonly webhookSecret: string

  /**
   * Creates a deterministic Slack or Microsoft Teams adapter.
   *
   * @param provider - Provider represented by the fixture.
   * @param webhookSecret - Secret used to authenticate fixture webhook envelopes.
   */
  constructor(provider: ExternalChatProvider, webhookSecret: string) {
    this.definition = {
      provider,
      permalinkHosts: ['chat.example.test'],
      capabilities: {
        edits: true,
        deletion: true,
        threadCompletion: true,
        nativeIdempotency: true,
      },
    }
    this.webhookSecret = webhookSecret
    const root = createFixtureMessage(provider, 'root', undefined, 'Root message')
    const reply = createFixtureMessage(provider, 'reply', root.externalId, 'Reply message')
    const source: ExternalChatThreadReference = {
      externalWorkspaceId: `${provider}-workspace`,
      conversationExternalId: `${provider}-conversation`,
      threadExternalId: `${provider}-thread`,
      rootMessageExternalId: root.externalId,
      sourceMessageExternalId: reply.externalId,
      sourcePermalink: reply.permalink,
      quotedRange: reply.quotedRanges[0],
    }
    const authorization: ChatProviderAuthorization = {
      installationId: `${provider}-installation`,
      externalWorkspaceId: source.externalWorkspaceId,
      authorizationRevision: 3,
    }
    const thread: ExternalChatThreadSnapshot = {
      schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
      workspace: {
        provider,
        externalId: source.externalWorkspaceId,
        displayName: `${provider} workspace`,
        permalink: `https://chat.example.test/${provider}/workspaces/main`,
      },
      conversation: {
        externalId: source.conversationExternalId,
        externalWorkspaceId: source.externalWorkspaceId,
        kind: provider === 'slack' ? 'channel' : 'meeting',
        displayName: 'Incident room',
        permalink: `https://chat.example.test/${provider}/conversations/incident`,
      },
      externalId: source.threadExternalId,
      rootMessageExternalId: root.externalId,
      permalink: root.permalink,
      availability: 'available',
      state: 'active',
      messageCount: 2,
      messages: [root, reply],
      hasMoreMessages: false,
      createdAt: root.postedAt,
      updatedAt: reply.updatedAt,
    }
    this.messages.set(root.externalId, root)
    this.messages.set(reply.externalId, reply)
    this.state = { source, authorization, thread }
  }

  /** Configures the first committed response for one operation to be lost in transit. */
  loseFirstResponseFor(operationId: string): void {
    this.responseLossOperations.add(operationId)
  }

  /** Reads the provider-side effect count for one logical operation. */
  committedMutationCount(operationId: string): number {
    return this.committedMutationCounts.get(operationId) ?? 0
  }

  /** Verifies one synthetic provider signature and emits a provider-neutral event. */
  async normalizeWebhook(
    request: ChatProviderWebhookRequest,
    authorization: ChatProviderAuthorization,
  ): Promise<ChatProviderNormalizedWebhook> {
    validateChatProviderWebhookRequest(request)
    this.requireAuthorization(authorization)
    const timestamp = requireHeader(request.headers, 'x-chat-timestamp')
    const signature = requireHeader(request.headers, 'x-chat-signature')
    const receivedAt = Date.parse(request.receivedAt)
    const sentAt = Date.parse(timestamp)
    if (!Number.isFinite(sentAt) || Math.abs(receivedAt - sentAt) > 5 * 60 * 1_000) {
      throw invalidWebhook()
    }
    const expectedSignature = signWebhook(timestamp, request.rawBody, this.webhookSecret)
    if (signature !== expectedSignature) throw invalidWebhook()
    const envelope = parseWebhookEnvelope(request.rawBody)
    if (
      envelope.provider !== this.definition.provider ||
      envelope.installationId !== authorization.installationId ||
      envelope.externalWorkspaceId !== authorization.externalWorkspaceId ||
      envelope.conversationExternalId !== this.state.source.conversationExternalId ||
      envelope.threadExternalId !== this.state.source.threadExternalId
    ) {
      throw new ChatProviderAdapterError(
        'ChatProviderScopeMismatch',
        'The verified webhook does not belong to the authorized chat source.',
      )
    }
    const event: ExternalChatInboundEvent = {
      schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
      type: 'message.created',
      eventId: envelope.eventId,
      correlationId: `correlation-${envelope.eventId}`,
      installationId: authorization.installationId,
      provider: this.definition.provider,
      externalWorkspaceId: authorization.externalWorkspaceId,
      conversationExternalId: this.state.source.conversationExternalId,
      threadExternalId: this.state.source.threadExternalId,
      occurredAt: timestamp,
      externalSequence: envelope.externalSequence,
      originOperationId: envelope.originOperationId,
      message: createFixtureMessage(
        this.definition.provider,
        'webhook',
        this.state.source.rootMessageExternalId,
        'Webhook reply',
      ),
    }
    return {
      deliveryId: requireHeader(request.headers, 'x-chat-delivery-id'),
      events: [event],
      ...(envelope.originMarker === undefined
        ? {}
        : { originMarkers: { [event.eventId]: envelope.originMarker } }),
    }
  }

  /** Resolves the complete authorized source snapshot. */
  async resolveThread(
    authorization: ChatProviderAuthorization,
    source: ExternalChatThreadReference,
  ): Promise<ExternalChatThreadSnapshot> {
    this.requireSource(authorization, source)
    return this.state.thread
  }

  /** Returns deterministic two-page message traversal with a private cursor. */
  async readThreadPage(input: ReadChatProviderThreadPageInput): Promise<ChatProviderThreadPage> {
    this.requireSource(input.authorization, input.source)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new ChatProviderAdapterError(
        'ChatProviderInvalidResponse',
        'The requested provider page size is invalid.',
      )
    }
    const [root, reply] = this.state.thread.messages
    if (!root || !reply) {
      throw new ChatProviderAdapterError(
        'ChatProviderInvalidResponse',
        'The synthetic thread fixture is incomplete.',
      )
    }
    if (input.providerCursor === undefined) {
      return {
        thread: {
          ...this.state.thread,
          messages: [root],
          hasMoreMessages: true,
        },
        providerCursor: `${this.definition.provider}-cursor-2`,
      }
    }
    if (input.providerCursor !== `${this.definition.provider}-cursor-2`) {
      throw new ChatProviderAdapterError(
        'ChatProviderInvalidResponse',
        'The provider cursor is invalid.',
      )
    }
    return {
      thread: {
        ...this.state.thread,
        messages: [reply],
        hasMoreMessages: false,
      },
    }
  }

  /** Creates one reply and replays the same result for the same operation ID. */
  async createReply(input: CreateChatProviderReplyInput): Promise<ExternalChatMessage> {
    this.requireSource(input.authorization, input.source)
    this.throwForSyntheticOperation(input.operationId)
    const replay = this.replyByOperationId.get(input.operationId)
    if (replay) return replay
    const created = createFixtureMessage(
      this.definition.provider,
      `created-${this.replyByOperationId.size + 1}`,
      input.source.rootMessageExternalId,
      input.bodyMarkdown,
    )
    this.replyByOperationId.set(input.operationId, created)
    this.messages.set(created.externalId, created)
    this.commitMutation(input.operationId)
    this.throwLostResponse(input.operationId)
    return created
  }

  /** Edits or reconciles one provider message by stable operation ID. */
  async editMessage(input: EditChatProviderMessageInput): Promise<ExternalChatMessage> {
    this.requireSource(input.authorization, input.source)
    this.throwForSyntheticOperation(input.operationId)
    const replay = this.editByOperationId.get(input.operationId)
    if (replay) return replay
    const current = this.requireMessage(input.externalMessageId)
    const edited: ExternalChatMessage = {
      ...current,
      externalVersion: `${current.externalVersion}-edited`,
      bodyMarkdown: input.bodyMarkdown,
      updatedAt: fixtureEditedAt,
      editedAt: fixtureEditedAt,
    }
    this.editByOperationId.set(input.operationId, edited)
    this.messages.set(edited.externalId, edited)
    this.commitMutation(input.operationId)
    this.throwLostResponse(input.operationId)
    return edited
  }

  /** Deletes or reconciles one provider message into an explicit tombstone. */
  async deleteMessage(input: DeleteChatProviderMessageInput): Promise<ExternalChatMessage> {
    this.requireSource(input.authorization, input.source)
    this.throwForSyntheticOperation(input.operationId)
    const replay = this.deletionByOperationId.get(input.operationId)
    if (replay) return replay
    const current = this.requireMessage(input.externalMessageId)
    const deleted: ExternalChatMessage = {
      ...current,
      externalVersion: `${current.externalVersion}-deleted`,
      availability: 'available',
      state: 'deleted',
      permalink: undefined,
      actor: undefined,
      bodyMarkdown: undefined,
      quotedRanges: [],
      attachments: [],
      updatedAt: fixtureDeletedAt,
      deletedAt: fixtureDeletedAt,
    }
    this.deletionByOperationId.set(input.operationId, deleted)
    this.messages.set(deleted.externalId, deleted)
    this.commitMutation(input.operationId)
    this.throwLostResponse(input.operationId)
    return deleted
  }

  /** Completes, reopens, or reconciles the synthetic thread by stable operation ID. */
  async setThreadCompletion(
    input: SetChatProviderThreadCompletionInput,
  ): Promise<ChatProviderThreadMutationResult> {
    this.requireSource(input.authorization, input.source)
    this.throwForSyntheticOperation(input.operationId)
    const replay = this.completionByOperationId.get(input.operationId)
    if (replay) return replay
    const result: ChatProviderThreadMutationResult = {
      externalVersion: `${this.definition.provider}-completion-${input.completed ? '1' : '2'}`,
      completed: input.completed,
      occurredAt: fixtureNow,
    }
    this.completionByOperationId.set(input.operationId, result)
    this.commitMutation(input.operationId)
    this.throwLostResponse(input.operationId)
    return result
  }

  /** Records one newly committed provider-side mutation. */
  private commitMutation(operationId: string): void {
    this.committedMutationCounts.set(
      operationId,
      (this.committedMutationCounts.get(operationId) ?? 0) + 1,
    )
  }

  /** Simulates a transport failure after the provider has durably committed a mutation. */
  private throwLostResponse(operationId: string): void {
    if (!this.responseLossOperations.delete(operationId)) return
    throw new ChatProviderAdapterError(
      'ChatProviderTransientFailure',
      'The synthetic provider response was lost after commit.',
      { retryable: true },
    )
  }

  /** Rejects authorization and tenant mismatches before provider access. */
  private requireAuthorization(authorization: ChatProviderAuthorization): void {
    if (authorization.installationId === 'permission-denied') {
      throw new ChatProviderAdapterError(
        'ChatProviderPermissionDenied',
        'The installation no longer permits this chat operation.',
      )
    }
    if (
      authorization.installationId !== this.state.authorization.installationId ||
      authorization.externalWorkspaceId !== this.state.authorization.externalWorkspaceId ||
      authorization.authorizationRevision !== this.state.authorization.authorizationRevision
    ) {
      throw new ChatProviderAdapterError(
        'ChatProviderScopeMismatch',
        'The chat operation scope does not match the installation.',
      )
    }
  }

  /** Rejects a thread locator that crosses the authorized source boundary. */
  private requireSource(
    authorization: ChatProviderAuthorization,
    source: ExternalChatThreadReference,
  ): void {
    this.requireAuthorization(authorization)
    if (
      source.externalWorkspaceId !== this.state.source.externalWorkspaceId ||
      source.conversationExternalId !== this.state.source.conversationExternalId ||
      source.threadExternalId !== this.state.source.threadExternalId ||
      source.rootMessageExternalId !== this.state.source.rootMessageExternalId
    ) {
      throw new ChatProviderAdapterError(
        'ChatProviderScopeMismatch',
        'The chat source does not match the installation scope.',
      )
    }
  }

  /** Reads one current message or reports an honest source deletion. */
  private requireMessage(externalMessageId: string): ExternalChatMessage {
    const message = this.messages.get(externalMessageId)
    if (!message) {
      throw new ChatProviderAdapterError(
        'ChatProviderSourceNotFound',
        'The provider message no longer exists.',
      )
    }
    return message
  }

  /** Produces classified provider failures used by the shared contract. */
  private throwForSyntheticOperation(operationId: string): void {
    if (operationId === 'rate-limited') {
      throw new ChatProviderAdapterError(
        'ChatProviderRateLimited',
        'The provider rate limit is active.',
        { retryable: true, retryAt: fixtureRetryAt },
      )
    }
  }
}

/** Parsed, allowlisted fields from one synthetic raw webhook body. */
type SyntheticWebhookEnvelope = {
  /** Provider that emitted the event. */
  provider: ExternalChatProvider
  /** Installation expected to receive the event. */
  installationId: string
  /** Provider workspace or tenant ID. */
  externalWorkspaceId: string
  /** Provider conversation ID. */
  conversationExternalId: string
  /** Provider thread ID. */
  threadExternalId: string
  /** Stable provider event ID. */
  eventId: string
  /** Opaque provider ordering token. */
  externalSequence: string
  /** Echoed logical operation ID when present. */
  originOperationId?: string
  /** Provider-returned opaque authenticated origin marker when present. */
  originMarker?: string
}

/** Creates one fully populated normalized provider message fixture. */
function createFixtureMessage(
  provider: ExternalChatProvider,
  suffix: string,
  parentMessageExternalId: string | undefined,
  bodyMarkdown: string,
): ExternalChatMessage {
  const externalId = `${provider}-message-${suffix}`
  return {
    externalId,
    externalVersion: `${externalId}-v1`,
    conversationExternalId: `${provider}-conversation`,
    threadExternalId: `${provider}-thread`,
    ...(parentMessageExternalId ? { parentMessageExternalId } : {}),
    permalink: `https://chat.example.test/${provider}/messages/${externalId}`,
    availability: 'available',
    state: 'active',
    actor: {
      externalId: `${provider}-actor-1`,
      kind: 'person',
      displayName: 'External Operator',
    },
    bodyMarkdown,
    quotedRanges: [{
      sourceMessageExternalId: `${provider}-message-source`,
      startOffset: 0,
      endOffset: 6,
      text: 'quoted',
    }],
    attachments: [{
      externalId: `${externalId}-attachment`,
      fileName: 'evidence.txt',
      contentType: 'text/plain',
      sizeBytes: 128,
      permalink: `https://chat.example.test/${provider}/attachments/evidence`,
      availability: 'available',
      state: 'active',
      createdAt: fixtureNow,
    }],
    postedAt: fixtureNow,
    updatedAt: fixtureNow,
  }
}

/** Runs one identical behavioral contract for a provider fixture. */
function runChatProviderAdapterContract(provider: ExternalChatProvider): void {
  describe(`${provider} chat provider adapter`, () => {
    const adapter = new SyntheticChatProviderAdapter(provider, fixtureWebhookSecret)
    const registry = new ChatProviderAdapterRegistry([adapter])

    test('registers strict capabilities and normalizes the complete thread source', async () => {
      expect(registry.get(provider)).toBe(adapter)
      expect(() => registry.register(adapter)).toThrow(ChatProviderAdapterError)
      expect(() => new ChatProviderAdapterRegistry().get(provider))
        .toThrow(ChatProviderAdapterError)
      expect(adapter.definition.capabilities).toEqual({
        edits: true,
        deletion: true,
        threadCompletion: true,
        nativeIdempotency: true,
      })
      const thread = await adapter.resolveThread(adapter.state.authorization, adapter.state.source)
      expect(thread).toMatchObject({
        workspace: {
          provider,
          externalId: `${provider}-workspace`,
          displayName: `${provider} workspace`,
        },
        conversation: {
          externalId: `${provider}-conversation`,
          kind: provider === 'slack' ? 'channel' : 'meeting',
          displayName: 'Incident room',
        },
        externalId: `${provider}-thread`,
        messageCount: 2,
      })
      expect(thread.messages[1]).toMatchObject({
        actor: { kind: 'person', displayName: 'External Operator' },
        permalink: `https://chat.example.test/${provider}/messages/${provider}-message-reply`,
        postedAt: fixtureNow,
        quotedRanges: [{ startOffset: 0, endOffset: 6, text: 'quoted' }],
        attachments: [{
          fileName: 'evidence.txt',
          contentType: 'text/plain',
          sizeBytes: 128,
        }],
      })
    })

    test('keeps provider cursors private across deterministic pages', async () => {
      const first = await adapter.readThreadPage({
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        limit: 1,
      })
      expect(first.thread.messages).toHaveLength(1)
      expect(first.thread.hasMoreMessages).toBe(true)
      expect(first.providerCursor).toBe(`${provider}-cursor-2`)
      const second = await adapter.readThreadPage({
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        providerCursor: first.providerCursor,
        limit: 1,
      })
      expect(second.thread.messages[0]?.externalId).toBe(`${provider}-message-reply`)
      expect(second.providerCursor).toBeUndefined()
    })

    test('replays stable replies and supports edit, delete, and completion', async () => {
      const marker = createChatProviderOriginMarker({
        version: 1,
        provider,
        installationId: adapter.state.authorization.installationId,
        linkId: 'link-1',
        operationId: 'reply-operation',
        action: 'message.created',
        issuedAt: fixtureNow,
      }, fixtureMarkerSecret)
      const replyInput: CreateChatProviderReplyInput = {
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        bodyMarkdown: 'Created once',
        operationId: 'reply-operation',
        originMarker: marker,
      }
      const created = await adapter.createReply(replyInput)
      await expect(adapter.createReply(replyInput)).resolves.toEqual(created)
      const editInput: EditChatProviderMessageInput = {
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        externalMessageId: created.externalId,
        expectedExternalVersion: created.externalVersion,
        bodyMarkdown: 'Edited once',
        operationId: 'edit-operation',
        originMarker: marker,
      }
      const edited = await adapter.editMessage(editInput)
      expect(edited).toMatchObject({ bodyMarkdown: 'Edited once', editedAt: fixtureEditedAt })
      await expect(adapter.editMessage(editInput)).resolves.toEqual(edited)
      const deleteInput: DeleteChatProviderMessageInput = {
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        externalMessageId: created.externalId,
        expectedExternalVersion: edited.externalVersion,
        operationId: 'delete-operation',
        originMarker: marker,
      }
      const deleted = await adapter.deleteMessage(deleteInput)
      expect(deleted).toMatchObject({ state: 'deleted', deletedAt: fixtureDeletedAt })
      expect(deleted.permalink).toBeUndefined()
      expect(deleted.actor).toBeUndefined()
      expect(deleted.bodyMarkdown).toBeUndefined()
      expect(deleted.quotedRanges).toEqual([])
      expect(deleted.attachments).toEqual([])
      await expect(adapter.deleteMessage(deleteInput)).resolves.toEqual(deleted)
      const completionInput: SetChatProviderThreadCompletionInput = {
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        completed: true,
        operationId: 'complete-operation',
        originMarker: marker,
      }
      const completion = await adapter.setThreadCompletion(completionInput)
      expect(completion).toMatchObject({ completed: true })
      await expect(adapter.setThreadCompletion(completionInput)).resolves.toEqual(completion)
    })

    test('reconciles every provider mutation after a committed response is lost', async () => {
      const operationIds = {
        create: `${provider}-loss-create`,
        edit: `${provider}-loss-edit`,
        delete: `${provider}-loss-delete`,
        complete: `${provider}-loss-complete`,
      }
      const marker = createChatProviderOriginMarker({
        version: 1,
        provider,
        installationId: adapter.state.authorization.installationId,
        linkId: 'link-response-loss',
        operationId: operationIds.create,
        action: 'message.created',
        issuedAt: fixtureNow,
      }, fixtureMarkerSecret)
      const createInput: CreateChatProviderReplyInput = {
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        bodyMarkdown: 'Response-loss reply',
        operationId: operationIds.create,
        originMarker: marker,
      }
      adapter.loseFirstResponseFor(operationIds.create)
      await expect(adapter.createReply(createInput)).rejects.toMatchObject({
        code: 'ChatProviderTransientFailure',
        retryable: true,
      })
      const created = await adapter.createReply(createInput)

      const editInput: EditChatProviderMessageInput = {
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        externalMessageId: created.externalId,
        expectedExternalVersion: created.externalVersion,
        bodyMarkdown: 'Recovered edit',
        operationId: operationIds.edit,
        originMarker: marker,
      }
      adapter.loseFirstResponseFor(operationIds.edit)
      await expect(adapter.editMessage(editInput)).rejects.toMatchObject({
        code: 'ChatProviderTransientFailure',
      })
      const edited = await adapter.editMessage(editInput)

      const deleteInput: DeleteChatProviderMessageInput = {
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        externalMessageId: created.externalId,
        expectedExternalVersion: edited.externalVersion,
        operationId: operationIds.delete,
        originMarker: marker,
      }
      adapter.loseFirstResponseFor(operationIds.delete)
      await expect(adapter.deleteMessage(deleteInput)).rejects.toMatchObject({
        code: 'ChatProviderTransientFailure',
      })
      const deleted = await adapter.deleteMessage(deleteInput)
      expect(deleted.state).toBe('deleted')

      const completionInput: SetChatProviderThreadCompletionInput = {
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        completed: true,
        operationId: operationIds.complete,
        originMarker: marker,
      }
      adapter.loseFirstResponseFor(operationIds.complete)
      await expect(adapter.setThreadCompletion(completionInput)).rejects.toMatchObject({
        code: 'ChatProviderTransientFailure',
      })
      await expect(adapter.setThreadCompletion(completionInput))
        .resolves.toMatchObject({ completed: true })
      for (const operationId of Object.values(operationIds)) {
        expect(adapter.committedMutationCount(operationId)).toBe(1)
      }
    })

    test('authenticates echo markers and rejects tampering, scope changes, and expiry', () => {
      const marker = createChatProviderOriginMarker({
        version: 1,
        provider,
        installationId: adapter.state.authorization.installationId,
        linkId: 'link-1',
        operationId: 'echo-operation',
        action: 'message.created',
        issuedAt: fixtureNow,
      }, fixtureMarkerSecret)
      const expected = {
        provider,
        installationId: adapter.state.authorization.installationId,
        linkId: 'link-1',
        now: '2026-08-06T03:01:00.000Z',
        maxAgeMs: 120_000,
      }
      expect(verifyChatProviderOriginMarker(marker, expected, fixtureMarkerSecret))
        .toMatchObject({ operationId: 'echo-operation', action: 'message.created' })
      expect(verifyChatProviderOriginMarker(`${marker}x`, expected, fixtureMarkerSecret))
        .toBeUndefined()
      expect(verifyChatProviderOriginMarker(marker, {
        ...expected,
        linkId: 'link-2',
      }, fixtureMarkerSecret)).toBeUndefined()
      expect(verifyChatProviderOriginMarker(marker, {
        ...expected,
        now: '2026-08-06T03:10:00.000Z',
      }, fixtureMarkerSecret)).toBeUndefined()
    })

    test('verifies raw webhook signatures and drops provider-only fields', async () => {
      const originMarker = createChatProviderOriginMarker({
        version: 1,
        provider,
        installationId: adapter.state.authorization.installationId,
        linkId: 'link-raw-echo',
        operationId: `${provider}-raw-echo-operation`,
        action: 'message.created',
        issuedAt: fixtureNow,
      }, fixtureMarkerSecret)
      const body = createWebhookBody(provider, adapter.state.authorization, {
        rawProviderToken: 'must-not-escape',
        eventId: `${provider}-event-1`,
        originOperationId: `${provider}-raw-echo-operation`,
        originMarker,
      })
      const request = createSignedWebhookRequest(body, fixtureNow, fixtureWebhookSecret)
      const normalized = await adapter.normalizeWebhook(request, adapter.state.authorization)
      expect(normalized.deliveryId).toBe('delivery-1')
      expect(normalized.events[0]).toMatchObject({
        eventId: `${provider}-event-1`,
        provider,
        externalWorkspaceId: adapter.state.authorization.externalWorkspaceId,
        originOperationId: `${provider}-raw-echo-operation`,
      })
      expect(normalized.originMarkers).toEqual({ [`${provider}-event-1`]: originMarker })
      expect(JSON.stringify(normalized)).not.toContain('must-not-escape')
      await expect(adapter.normalizeWebhook({
        ...request,
        headers: { ...request.headers, 'x-chat-signature': 'tampered' },
      }, adapter.state.authorization)).rejects.toMatchObject({
        code: 'ChatProviderInvalidWebhook',
      })
      const staleRequest = createSignedWebhookRequest(
        body,
        '2026-08-06T02:50:00.000Z',
        fixtureWebhookSecret,
      )
      await expect(adapter.normalizeWebhook({
        ...staleRequest,
        receivedAt: fixtureNow,
      }, adapter.state.authorization)).rejects.toMatchObject({
        code: 'ChatProviderInvalidWebhook',
      })
      const wrongScopeBody = createWebhookBody(provider, adapter.state.authorization, {
        eventId: `${provider}-event-2`,
        externalWorkspaceId: 'another-workspace',
      })
      await expect(adapter.normalizeWebhook(
        createSignedWebhookRequest(wrongScopeBody, fixtureNow, fixtureWebhookSecret),
        adapter.state.authorization,
      )).rejects.toMatchObject({ code: 'ChatProviderScopeMismatch' })
    })

    test('fails closed on raw bounds and classifies permission and rate limits', async () => {
      expect(() => validateChatProviderWebhookRequest({
        headers: {},
        rawBody: new Uint8Array(),
        receivedAt: fixtureNow,
      })).toThrow(ChatProviderAdapterError)
      expect(() => validateChatProviderWebhookRequest({
        headers: {},
        rawBody: new Uint8Array(CHAT_PROVIDER_WEBHOOK_MAX_BYTES + 1),
        receivedAt: fixtureNow,
      })).toThrow(ChatProviderAdapterError)
      await expect(adapter.resolveThread({
        ...adapter.state.authorization,
        installationId: 'permission-denied',
      }, adapter.state.source)).rejects.toMatchObject({
        code: 'ChatProviderPermissionDenied',
        retryable: false,
      })
      await expect(adapter.createReply({
        authorization: adapter.state.authorization,
        source: adapter.state.source,
        bodyMarkdown: 'Rate limited',
        operationId: 'rate-limited',
        originMarker: 'not-sent',
      })).rejects.toMatchObject({
        code: 'ChatProviderRateLimited',
        retryable: true,
        retryAt: fixtureRetryAt,
      })
    })
  })
}

/** Creates a signed synthetic raw webhook request. */
function createSignedWebhookRequest(
  rawBody: Uint8Array,
  timestamp: string,
  signingSecret: string,
): ChatProviderWebhookRequest {
  return {
    headers: {
      'x-chat-timestamp': timestamp,
      'x-chat-signature': signWebhook(timestamp, rawBody, signingSecret),
      'x-chat-delivery-id': 'delivery-1',
    },
    rawBody,
    receivedAt: timestamp,
  }
}

/** Creates one provider-specific raw envelope with optional test overrides. */
function createWebhookBody(
  provider: ExternalChatProvider,
  authorization: ChatProviderAuthorization,
  overrides: Readonly<Record<string, unknown>>,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    provider,
    installationId: authorization.installationId,
    externalWorkspaceId: authorization.externalWorkspaceId,
    conversationExternalId: `${provider}-conversation`,
    threadExternalId: `${provider}-thread`,
    eventId: `${provider}-event`,
    externalSequence: '42',
    ...overrides,
  }))
}

/** Signs raw fixture bytes with a provider-style timestamp-bound HMAC. */
function signWebhook(timestamp: string, rawBody: Uint8Array, signingSecret: string): string {
  return createHmac('sha256', signingSecret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest('hex')
}

/** Parses and allowlists one synthetic provider webhook envelope. */
function parseWebhookEnvelope(rawBody: Uint8Array): SyntheticWebhookEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    throw invalidWebhook()
  }
  if (!isRecord(parsed)) throw invalidWebhook()
  const provider = readProvider(parsed.provider)
  return {
    provider,
    installationId: readText(parsed.installationId),
    externalWorkspaceId: readText(parsed.externalWorkspaceId),
    conversationExternalId: readText(parsed.conversationExternalId),
    threadExternalId: readText(parsed.threadExternalId),
    eventId: readText(parsed.eventId),
    externalSequence: readText(parsed.externalSequence),
    ...(typeof parsed.originOperationId === 'string'
      ? { originOperationId: readText(parsed.originOperationId) }
      : {}),
    ...(typeof parsed.originMarker === 'string'
      ? { originMarker: readText(parsed.originMarker) }
      : {}),
  }
}

/** Reads one required normalized webhook header. */
function requireHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = headers[name]
  if (!value) throw invalidWebhook()
  return value
}

/** Creates a generic secret-free webhook rejection. */
function invalidWebhook(): ChatProviderAdapterError {
  return new ChatProviderAdapterError(
    'ChatProviderInvalidWebhook',
    'The chat provider webhook could not be authenticated.',
  )
}

/** Reads one supported chat provider from untrusted JSON. */
function readProvider(value: unknown): ExternalChatProvider {
  if (value === 'slack' || value === 'microsoft-teams') return value
  throw invalidWebhook()
}

/** Reads one bounded non-empty string from untrusted JSON. */
function readText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw invalidWebhook()
  }
  return value
}

/** Narrows untrusted JSON to a non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const providers: readonly ExternalChatProvider[] = ['slack', 'microsoft-teams']
for (const provider of providers) runChatProviderAdapterContract(provider)
