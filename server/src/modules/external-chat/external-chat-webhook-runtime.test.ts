import { describe, expect, test } from 'bun:test'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  type ExternalChatInboundEvent,
  type ExternalChatMessage,
} from '@mukuroji/contracts'
import {
  ChatProviderAdapterRegistry,
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
import { InMemoryExternalChatStore } from './external-chat'
import {
  ExternalChatSyncService,
  type ExternalChatSyncAccessPort,
  type ExternalChatSyncApplyResourceLifecycleInput,
  type ExternalChatSyncAttachmentPort,
  type ExternalChatSyncAuditPort,
  type ExternalChatSyncAuditRecord,
  type ExternalChatSyncClockPort,
  type ExternalChatSyncCollaborationPort,
  type ExternalChatSyncCommentMutationResult,
  type ExternalChatSyncCreateCommentInput,
  type ExternalChatSyncCursorCodecPort,
  type ExternalChatSyncDeleteCommentInput,
  type ExternalChatSyncImportAttachmentsInput,
  type ExternalChatSyncImportAttachmentsResult,
  type ExternalChatSyncMessageOrderDecision,
  type ExternalChatSyncMessageOrderInput,
  type ExternalChatSyncMessageOrderPort,
  type ExternalChatSyncOriginSecretPort,
  type ExternalChatSyncRedactLinkResourcesInput,
  type ExternalChatSyncSetWorkItemCompletionInput,
  type ExternalChatSyncSetWorkItemCompletionResult,
  type ExternalChatSyncThreadOrderDecision,
  type ExternalChatSyncThreadOrderInput,
  type ExternalChatSyncThreadOrderPort,
  type ExternalChatSyncUpdateCommentInput,
  type ExternalChatSyncWorkItemPort,
} from './external-chat-sync-service'
import {
  EXTERNAL_CHAT_WEBHOOK_MAX_EVENTS,
  ExternalChatWebhookRuntime,
  type ProcessExternalChatWebhookInput,
} from './external-chat-webhook-runtime'

const runtimeNow = '2026-08-06T07:00:00.000Z'

/** Complete runtime fixture with durable receipts and recording audit state. */
type WebhookRuntimeFixture = {
  /** Runtime under test. */
  runtime: ExternalChatWebhookRuntime
  /** Configurable signature-verifying adapter boundary. */
  adapter: ConfigurableWebhookAdapter
  /** Redacted synchronization audit sink. */
  audit: RecordingSyncAuditPort
}

/** Provider adapter that returns a preverified normalized webhook envelope. */
class ConfigurableWebhookAdapter implements ChatProviderAdapter {
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

  /** Webhook normalization calls received by the adapter. */
  readonly normalizeCalls: Array<{
    /** Canonical installation identifier. */
    installationId: string
    /** Raw body byte count presented for signature verification. */
    rawBodyBytes: number
  }> = []

  /** Current normalized envelope returned by the adapter. */
  private normalized: ChatProviderNormalizedWebhook

  /**
   * Creates a configurable webhook adapter.
   *
   * @param normalized - Initial verified normalized envelope.
   */
  constructor(normalized: ChatProviderNormalizedWebhook) {
    this.normalized = normalized
  }

  /**
   * Replaces the normalized envelope used by the next delivery.
   *
   * @param normalized - Replacement verified normalized envelope.
   */
  setNormalized(normalized: ChatProviderNormalizedWebhook): void {
    this.normalized = normalized
  }

  /** Records raw transport use and returns the configured verified envelope. */
  async normalizeWebhook(
    request: ChatProviderWebhookRequest,
    authorization: ChatProviderAuthorization,
  ): Promise<ChatProviderNormalizedWebhook> {
    this.normalizeCalls.push({
      installationId: authorization.installationId,
      rawBodyBytes: request.rawBody.byteLength,
    })
    return this.normalized
  }

  /** Rejects source resolution because webhook tests only normalize inbound deliveries. */
  async resolveThread(): Promise<never> {
    throw new Error('Thread resolution is outside this fixture.')
  }

  /** Rejects source paging because webhook tests do not render source views. */
  async readThreadPage(_input: ReadChatProviderThreadPageInput): Promise<ChatProviderThreadPage> {
    throw new Error('Thread paging is outside this fixture.')
  }

  /** Rejects provider reply creation because all fixture sources are unlinked. */
  async createReply(_input: CreateChatProviderReplyInput): Promise<ExternalChatMessage> {
    throw new Error('Reply creation is outside this fixture.')
  }

  /** Rejects provider editing because all fixture sources are unlinked. */
  async editMessage(_input: EditChatProviderMessageInput): Promise<ExternalChatMessage> {
    throw new Error('Message editing is outside this fixture.')
  }

  /** Rejects provider deletion because all fixture sources are unlinked. */
  async deleteMessage(_input: DeleteChatProviderMessageInput): Promise<ExternalChatMessage> {
    throw new Error('Message deletion is outside this fixture.')
  }

  /** Rejects provider completion because all fixture sources are unlinked. */
  async setThreadCompletion(
    _input: SetChatProviderThreadCompletionInput,
  ): Promise<ChatProviderThreadMutationResult> {
    throw new Error('Thread completion is outside this fixture.')
  }
}

/** Fail-fast dependency used for synchronization paths unreachable by unlinked events. */
class UnreachableSyncPorts implements
  ExternalChatSyncAccessPort,
  ExternalChatSyncCursorCodecPort,
  ExternalChatSyncMessageOrderPort,
  ExternalChatSyncThreadOrderPort,
  ExternalChatSyncCollaborationPort,
  ExternalChatSyncAttachmentPort,
  ExternalChatSyncWorkItemPort,
  ExternalChatSyncOriginSecretPort {
  /** Rejects source-view internal authorization. */
  async canViewWorkItem(): Promise<boolean> {
    throw new Error('Work Item viewing is outside this fixture.')
  }

  /** Rejects source-view provider authorization. */
  async getViewerProviderAuthorization(): Promise<ChatProviderAuthorization | undefined> {
    throw new Error('Viewer provider authorization is outside this fixture.')
  }

  /** Rejects background installation authorization. */
  async getInstallationProviderAuthorization(): Promise<ChatProviderAuthorization | undefined> {
    throw new Error('Installation authorization is outside this fixture.')
  }

  /** Rejects outbound synchronization authorization. */
  async canSyncOutbound(): Promise<boolean> {
    throw new Error('Outbound synchronization is outside this fixture.')
  }

  /** Rejects application cursor decoding. */
  async decode(): Promise<string> {
    throw new Error('Cursor decoding is outside this fixture.')
  }

  /** Rejects application cursor encoding. */
  async encode(): Promise<string> {
    throw new Error('Cursor encoding is outside this fixture.')
  }

  /** Rejects message ordering because no link resolves. */
  async decide(_input: ExternalChatSyncMessageOrderInput): Promise<ExternalChatSyncMessageOrderDecision> {
    throw new Error('Message ordering is outside this fixture.')
  }

  /** Rejects thread ordering because no link resolves. */
  async decideThreadLifecycle(
    _input: ExternalChatSyncThreadOrderInput,
  ): Promise<ExternalChatSyncThreadOrderDecision> {
    throw new Error('Thread ordering is outside this fixture.')
  }

  /** Rejects internal comment creation because no link resolves. */
  async createExternalComment(
    _input: ExternalChatSyncCreateCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult> {
    throw new Error('Comment creation is outside this fixture.')
  }

  /** Rejects internal comment editing because no link resolves. */
  async updateExternalComment(
    _input: ExternalChatSyncUpdateCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult> {
    throw new Error('Comment editing is outside this fixture.')
  }

  /** Rejects internal comment deletion because no link resolves. */
  async deleteExternalComment(
    _input: ExternalChatSyncDeleteCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult> {
    throw new Error('Comment deletion is outside this fixture.')
  }

  /** Rejects imported resource lifecycle changes because no link resolves. */
  async applyExternalResourceLifecycle(
    _input: ExternalChatSyncApplyResourceLifecycleInput,
  ): Promise<void> {
    throw new Error('Resource lifecycle handling is outside this fixture.')
  }

  /** Rejects parent lifecycle cascades because no link resolves. */
  async redactExternalLinkResources(
    _input: ExternalChatSyncRedactLinkResourcesInput,
  ): Promise<void> {
    throw new Error('Link resource redaction is outside this fixture.')
  }

  /** Rejects attachment imports because no link resolves. */
  async importAuthorizedAttachments(
    _input: ExternalChatSyncImportAttachmentsInput,
  ): Promise<ExternalChatSyncImportAttachmentsResult> {
    throw new Error('Attachment importing is outside this fixture.')
  }

  /** Rejects Work Item completion because no link resolves. */
  async setCompletion(
    _input: ExternalChatSyncSetWorkItemCompletionInput,
  ): Promise<ExternalChatSyncSetWorkItemCompletionResult> {
    throw new Error('Work Item completion is outside this fixture.')
  }

  /** Rejects origin-secret access because unlinked events cannot be echoes. */
  async getSigningSecret(): Promise<string> {
    throw new Error('Origin secret access is outside this fixture.')
  }
}

/** Redacted audit sink that exposes synchronization decisions to assertions. */
class RecordingSyncAuditPort implements ExternalChatSyncAuditPort {
  /** Audit records written by inbound synchronization. */
  readonly records: ExternalChatSyncAuditRecord[] = []

  /** Records one redacted synchronization decision. */
  async record(record: ExternalChatSyncAuditRecord): Promise<void> {
    this.records.push(record)
  }
}

/** Fixed canonical clock shared by receipt and audit assertions. */
class FixedSyncClock implements ExternalChatSyncClockPort {
  /** Returns the deterministic runtime timestamp. */
  now(): string {
    return runtimeNow
  }
}

describe('ExternalChatWebhookRuntime', () => {
  test('preflights the complete normalized envelope before processing its first event', async () => {
    const first = createLifecycleEvent('event-valid')
    const outOfScope = createLifecycleEvent(
      'event-out-of-scope',
      'installation-slack',
      'another-external-workspace',
    )
    const fixture = createWebhookRuntimeFixture({
      deliveryId: 'delivery-mixed-scope',
      events: [first, outOfScope],
      originMarkers: { 'event-valid': 'origin-marker-one' },
    })

    await expect(fixture.runtime.process(createWebhookInput())).rejects.toMatchObject({
      code: 'ChatProviderScopeMismatch',
    })
    expect(fixture.audit.records).toHaveLength(0)

    fixture.adapter.setNormalized({
      deliveryId: 'delivery-valid-retry',
      events: [first],
      originMarkers: { 'event-valid': 'origin-marker-one' },
    })
    const recovered = await fixture.runtime.process(createWebhookInput())
    expect(recovered.deliveryId).toBe('delivery-valid-retry')
    expect(recovered.outcomes).toHaveLength(1)
    expect(recovered.outcomes[0]).toMatchObject({
      kind: 'skipped',
      eventId: 'event-valid',
      reason: 'unlinked',
    })
    expect(fixture.audit.records).toHaveLength(1)
    expect(fixture.adapter.normalizeCalls).toEqual([
      { installationId: 'installation-slack', rawBodyBytes: 2 },
      { installationId: 'installation-slack', rawBodyBytes: 2 },
    ])
  })

  test('forwards origin markers into durable replay fingerprints without duplicating effects', async () => {
    const event = createLifecycleEvent('event-replayed')
    const fixture = createWebhookRuntimeFixture({
      deliveryId: 'delivery-original',
      events: [event],
      originMarkers: { 'event-replayed': 'origin-marker-one' },
    })

    const first = await fixture.runtime.process(createWebhookInput())
    const replay = await fixture.runtime.process(createWebhookInput())
    expect(replay.outcomes).toEqual(first.outcomes)
    expect(fixture.audit.records).toHaveLength(2)

    fixture.adapter.setNormalized({
      deliveryId: 'delivery-conflicting-marker',
      events: [event],
      originMarkers: { 'event-replayed': 'origin-marker-two' },
    })
    await expect(fixture.runtime.process(createWebhookInput())).rejects.toMatchObject({
      code: 'ExternalChatEventConflict',
    })
    expect(fixture.audit.records).toHaveLength(2)

    fixture.adapter.setNormalized({
      deliveryId: 'delivery-original-marker-again',
      events: [event],
      originMarkers: { 'event-replayed': 'origin-marker-one' },
    })
    const recoveredReplay = await fixture.runtime.process(createWebhookInput())
    expect(recoveredReplay.outcomes).toEqual(first.outcomes)
    expect(fixture.audit.records).toHaveLength(3)
  })

  test('rejects empty and oversized verified envelopes before synchronization', async () => {
    const fixture = createWebhookRuntimeFixture({
      deliveryId: 'delivery-empty',
      events: [],
    })

    await expect(fixture.runtime.process(createWebhookInput())).rejects.toMatchObject({
      code: 'ChatProviderInvalidWebhook',
    })
    fixture.adapter.setNormalized({
      deliveryId: 'delivery-oversized',
      events: Array.from(
        { length: EXTERNAL_CHAT_WEBHOOK_MAX_EVENTS + 1 },
        (_, index) => createLifecycleEvent(`event-${index}`),
      ),
    })
    await expect(fixture.runtime.process(createWebhookInput())).rejects.toMatchObject({
      code: 'ChatProviderInvalidWebhook',
    })
    expect(fixture.audit.records).toHaveLength(0)
  })

  test('treats prototype-shaped event IDs as markerless own keys and bounds raw input first', async () => {
    const fixture = createWebhookRuntimeFixture({
      deliveryId: 'delivery-prototype-event-id',
      events: [createLifecycleEvent('toString')],
    })

    const processed = await fixture.runtime.process(createWebhookInput())
    expect(processed.outcomes[0]).toMatchObject({
      kind: 'skipped',
      eventId: 'toString',
      reason: 'unlinked',
    })

    const invalid = createWebhookInput()
    invalid.request.rawBody = new Uint8Array()
    await expect(fixture.runtime.process(invalid)).rejects.toMatchObject({
      code: 'ChatProviderInvalidWebhook',
    })
    expect(fixture.adapter.normalizeCalls).toHaveLength(1)
  })
})

/**
 * Creates an isolated webhook runtime with a real durable synchronization service.
 *
 * @param normalized - Verified provider envelope returned by the adapter.
 * @returns Runtime, adapter, and redacted audit fixture.
 */
function createWebhookRuntimeFixture(
  normalized: ChatProviderNormalizedWebhook,
): WebhookRuntimeFixture {
  const adapter = new ConfigurableWebhookAdapter(normalized)
  const adapters = new ChatProviderAdapterRegistry([adapter])
  const unreachable = new UnreachableSyncPorts()
  const audit = new RecordingSyncAuditPort()
  const sync = new ExternalChatSyncService({
    store: new InMemoryExternalChatStore(),
    adapters,
    access: unreachable,
    cursorCodec: unreachable,
    messageOrder: unreachable,
    threadOrder: unreachable,
    collaboration: unreachable,
    attachments: unreachable,
    workItems: unreachable,
    originSecrets: unreachable,
    audit,
    clock: new FixedSyncClock(),
  })
  return {
    runtime: new ExternalChatWebhookRuntime({ adapters, sync }),
    adapter,
    audit,
  }
}

/**
 * Creates one transport-scoped raw webhook input.
 *
 * @returns Canonical scope and untrusted raw body.
 */
function createWebhookInput(): ProcessExternalChatWebhookInput {
  return {
    scope: {
      workspaceId: 'workspace-1',
      provider: 'slack',
      authorization: {
        installationId: 'installation-slack',
        externalWorkspaceId: 'external-workspace-1',
        authorizationRevision: 4,
      },
    },
    request: {
      headers: {},
      rawBody: new TextEncoder().encode('{}'),
      receivedAt: runtimeNow,
    },
  }
}

/**
 * Creates one provider-neutral lifecycle event.
 *
 * @param eventId - Stable provider event identifier.
 * @param installationId - Installation carried by the normalized event.
 * @param externalWorkspaceId - External Workspace carried by the normalized event.
 * @returns Normalized lifecycle event.
 */
function createLifecycleEvent(
  eventId: string,
  installationId = 'installation-slack',
  externalWorkspaceId = 'external-workspace-1',
): ExternalChatInboundEvent {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    type: 'source.lifecycle-changed',
    eventId,
    correlationId: `correlation-${eventId}`,
    installationId,
    provider: 'slack',
    externalWorkspaceId,
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
    occurredAt: runtimeNow,
    resourceType: 'thread',
    resourceExternalId: 'thread-1',
    availability: 'available',
    state: 'active',
    reasonCode: 'ThreadObserved',
    sourcePermalink: 'https://chat.example.test/threads/thread-1',
  }
}
