import type {
  ExternalChatActor,
  ExternalChatAttachment,
  ExternalChatCanonicalRedirect,
  ExternalChatConversation,
  ExternalChatInboundEvent,
  ExternalChatMessage,
  ExternalChatMessageBinding,
  ExternalChatProvider,
  ExternalChatQuotedRange,
  ExternalChatSourceAvailability,
  ExternalChatSourceState,
  ExternalChatSyncCursor,
  ExternalChatSyncOutcome,
  ExternalChatThreadReference,
  ExternalChatWorkItemLink,
  ExternalChatWorkspace,
} from '@mukuroji/contracts'
import type {
  DeferredExternalChatEvent,
  DeferredExternalChatOutboundEvent,
  ExternalChatInboundReceipt,
  ExternalChatLifecycleObservation,
  ExternalChatLinkLifecycleState,
  ExternalChatOutboundReceipt,
  ExternalChatOutboundRetryPermit,
  ExternalChatParentLifecycleFence,
  ExternalChatParentLifecycleFenceSnapshot,
  ExternalChatSyncOutboundEvent,
  StoredExternalChatLink,
  StoredExternalChatMessageBinding,
  StoredExternalChatThreadLifecycle,
} from '../../external-chat'
import {
  createInitialExternalChatLinkLifecycleState,
  externalChatLifecycleBlocksSynchronization,
  ExternalChatError,
} from '../../external-chat'

/** Maximum text size accepted from one durable identifier or metadata field. */
const MAX_STORED_TEXT_BYTES = 64 * 1024

/** Runtime object representation used while decoding untrusted DynamoDB values. */
type UnknownRecord = Record<string, unknown>

/**
 * Decodes a complete stored external chat link without trusting DynamoDB data.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated stored link.
 */
export function decodeStoredExternalChatLink(value: unknown): StoredExternalChatLink {
  const record = readObject(value, [
    'workspaceId',
    'link',
    'sourceDigest',
    'sourceAuthorizationRevision',
    'lifecycleState',
    'active',
    'unlinkedAt',
  ], 'stored external chat link')
  const active = readBoolean(record.active, 'stored external chat link active state')
  const unlinkedAt = readOptionalTimestamp(
    record.unlinkedAt,
    'stored external chat link unlink timestamp',
  )
  if (active === (unlinkedAt !== undefined)) {
    invalidStoredValue('stored external chat link lifecycle')
  }
  const link = decodeExternalChatLink(record.link)
  const sourceAuthorizationRevision = readPositiveInteger(
    record.sourceAuthorizationRevision,
    'source authorization revision',
  )
  const lifecycleState = record.lifecycleState === undefined
    ? createInitialExternalChatLinkLifecycleState(link, sourceAuthorizationRevision)
    : decodeExternalChatLinkLifecycleState(record.lifecycleState)
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    link,
    sourceDigest: readDigest(record.sourceDigest, 'external chat source digest'),
    sourceAuthorizationRevision,
    lifecycleState,
    active,
    ...(unlinkedAt === undefined ? {} : { unlinkedAt }),
  }
}

/**
 * Decodes private scope-local lifecycle watermarks retained with one link.
 *
 * @param value - Untrusted persisted lifecycle state.
 * @returns Exact validated per-link lifecycle state.
 */
function decodeExternalChatLinkLifecycleState(value: unknown): ExternalChatLinkLifecycleState {
  const record = readObject(
    value,
    ['workspace', 'conversation', 'thread'],
    'external chat link lifecycle state',
  )
  return {
    ...(record.workspace === undefined
      ? {}
      : { workspace: decodeExternalChatLifecycleObservation(record.workspace) }),
    ...(record.conversation === undefined
      ? {}
      : { conversation: decodeExternalChatLifecycleObservation(record.conversation) }),
    thread: decodeExternalChatLifecycleObservation(record.thread),
  }
}

/**
 * Decodes one monotonically ordered lifecycle observation.
 *
 * @param value - Untrusted persisted observation.
 * @returns Exact validated lifecycle observation.
 */
function decodeExternalChatLifecycleObservation(value: unknown): ExternalChatLifecycleObservation {
  const record = readObject(value, [
    'authorizationRevision',
    'availability',
    'state',
    'occurredAt',
    'eventId',
  ], 'external chat lifecycle observation')
  return {
    authorizationRevision: readPositiveInteger(
      record.authorizationRevision,
      'lifecycle authorization revision',
    ),
    availability: decodeAvailability(record.availability),
    state: decodeSourceState(record.state),
    occurredAt: readTimestamp(record.occurredAt, 'lifecycle occurrence timestamp'),
    eventId: readIdentifier(record.eventId, 'lifecycle event ID'),
  }
}

/**
 * Decodes a durable inbound webhook receipt.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated inbound receipt.
 */
export function decodeExternalChatInboundReceipt(value: unknown): ExternalChatInboundReceipt {
  const record = readObject(value, [
    'workspaceId',
    'installationId',
    'provider',
    'eventId',
    'fingerprint',
    'operationId',
    'state',
    'attempt',
    'leaseExpiresAt',
    'outcome',
    'parentLifecycleCursor',
    'createdAt',
    'updatedAt',
  ], 'external chat inbound receipt')
  const state = readEnum(record.state, ['processing', 'completed'], 'inbound receipt state')
  const outcome = record.outcome === undefined
    ? undefined
    : decodeExternalChatSyncOutcome(record.outcome)
  const eventId = readIdentifier(record.eventId, 'provider event ID')
  const operationId = readIdentifier(record.operationId, 'inbound operation ID')
  const parentLifecycleCursor = record.parentLifecycleCursor === undefined
    ? undefined
    : readIdentifier(record.parentLifecycleCursor, 'parent lifecycle fan-out cursor')
  if ((state === 'completed') !== (outcome !== undefined)) {
    invalidStoredValue('external chat inbound receipt completion state')
  }
  if (
    outcome !== undefined &&
    (
      outcome.operationId !== operationId ||
      outcome.eventId !== eventId
    )
  ) invalidStoredValue('external chat inbound receipt outcome scope')
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    installationId: readIdentifier(record.installationId, 'connector installation ID'),
    provider: decodeProvider(record.provider),
    eventId,
    fingerprint: readDigest(record.fingerprint, 'inbound event fingerprint'),
    operationId,
    state,
    attempt: readPositiveInteger(record.attempt, 'inbound receipt attempt'),
    leaseExpiresAt: readTimestamp(record.leaseExpiresAt, 'inbound receipt lease expiry'),
    ...(outcome === undefined ? {} : { outcome }),
    ...(parentLifecycleCursor === undefined ? {} : { parentLifecycleCursor }),
    createdAt: readTimestamp(record.createdAt, 'inbound receipt creation timestamp'),
    updatedAt: readTimestamp(record.updatedAt, 'inbound receipt update timestamp'),
  }
}

/**
 * Decodes a durable outbound operation receipt.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated outbound receipt.
 */
export function decodeExternalChatOutboundReceipt(value: unknown): ExternalChatOutboundReceipt {
  const record = readObject(value, [
    'workspaceId',
    'linkId',
    'operationId',
    'fingerprint',
    'state',
    'attempt',
    'leaseExpiresAt',
    'outcome',
    'deadLetterReason',
    'deadLetteredAt',
    'createdAt',
    'updatedAt',
  ], 'external chat outbound receipt')
  const state = readEnum(
    record.state,
    ['processing', 'completed', 'dead-lettering', 'dead-lettered'],
    'outbound receipt state',
  )
  const outcome = record.outcome === undefined
    ? undefined
    : decodeExternalChatSyncOutcome(record.outcome)
  const deadLetterReason = record.deadLetterReason === undefined
    ? undefined
    : readEnum(
      record.deadLetterReason,
      ['max-attempts', 'max-age'],
      'outbound receipt dead-letter reason',
    )
  const deadLetteredAt = readOptionalTimestamp(
    record.deadLetteredAt,
    'outbound receipt dead-letter timestamp',
  )
  const operationId = readIdentifier(record.operationId, 'outbound operation ID')
  if (
    (state === 'processing' && outcome !== undefined) ||
    (state === 'completed' && outcome === undefined) ||
    (
      state === 'dead-lettering' &&
      outcome !== undefined &&
      outcome.kind !== 'deferred' &&
      !(outcome.kind === 'failed' && outcome.retryable)
    )
  ) {
    invalidStoredValue('external chat outbound receipt completion state')
  }
  if (
    outcome !== undefined &&
    (outcome.operationId !== operationId || outcome.eventId !== undefined)
  ) invalidStoredValue('external chat outbound receipt outcome scope')
  if (
    state === 'dead-lettered'
      ? deadLetterReason === undefined ||
        deadLetteredAt === undefined ||
        outcome?.kind !== 'failed' ||
        outcome.retryable ||
        outcome.errorCode !== 'ExternalChatRetryExhausted' ||
        outcome.occurredAt !== deadLetteredAt
      : state === 'dead-lettering'
        ? deadLetterReason === undefined || deadLetteredAt === undefined
        : deadLetterReason !== undefined || deadLetteredAt !== undefined
  ) invalidStoredValue('external chat outbound receipt dead-letter state')
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    linkId: readIdentifier(record.linkId, 'external chat link ID'),
    operationId,
    fingerprint: readDigest(record.fingerprint, 'outbound operation fingerprint'),
    state,
    attempt: readPositiveInteger(record.attempt, 'outbound receipt attempt'),
    leaseExpiresAt: readTimestamp(record.leaseExpiresAt, 'outbound receipt lease expiry'),
    ...(outcome === undefined ? {} : { outcome }),
    ...(deadLetterReason === undefined ? {} : { deadLetterReason }),
    ...(deadLetteredAt === undefined ? {} : { deadLetteredAt }),
    createdAt: readTimestamp(record.createdAt, 'outbound receipt creation timestamp'),
    updatedAt: readTimestamp(record.updatedAt, 'outbound receipt update timestamp'),
  }
}

/**
 * Decodes one durable installation-scoped outbound retry permit.
 *
 * @param value - Untrusted persisted value.
 * @returns Exact validated permit ownership and fencing state.
 */
export function decodeExternalChatOutboundRetryPermit(
  value: unknown,
): ExternalChatOutboundRetryPermit {
  const record = readObject(value, [
    'workspaceId',
    'provider',
    'installationId',
    'ownerId',
    'fenceToken',
    'acquiredAt',
    'leaseExpiresAt',
    'updatedAt',
  ], 'external chat outbound retry permit')
  const acquiredAt = readTimestamp(record.acquiredAt, 'outbound retry permit acquisition')
  const leaseExpiresAt = readTimestamp(record.leaseExpiresAt, 'outbound retry permit expiry')
  const updatedAt = readTimestamp(record.updatedAt, 'outbound retry permit update')
  if (updatedAt < acquiredAt) {
    invalidStoredValue('external chat outbound retry permit chronology')
  }
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    provider: decodeProvider(record.provider),
    installationId: readIdentifier(record.installationId, 'connector installation ID'),
    ownerId: readIdentifier(record.ownerId, 'outbound retry permit owner ID'),
    fenceToken: readPositiveInteger(record.fenceToken, 'outbound retry fencing token'),
    acquiredAt,
    leaseExpiresAt,
    updatedAt,
  }
}

/**
 * Decodes durable state and its exclusive lease for one linked thread lifecycle.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated tenant-, link-, and provider-scoped lifecycle record.
 */
export function decodeStoredExternalChatThreadLifecycle(
  value: unknown,
): StoredExternalChatThreadLifecycle {
  const record = readObject(value, [
    'workspaceId',
    'linkId',
    'provider',
    'ownerLinkRevision',
    'state',
    'lease',
  ], 'stored external chat thread lifecycle')
  const state = decodeThreadLifecycleState(record.state)
  const lease = decodeThreadLifecycleLease(record.lease)
  if (
    (lease.status !== 'processing' && state.revision === 0) ||
    (lease.status === 'completed' && state.updatedAt !== lease.completedAt)
  ) invalidStoredValue('stored external chat thread lifecycle completion')
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    linkId: readIdentifier(record.linkId, 'external chat link ID'),
    provider: decodeProvider(record.provider),
    ownerLinkRevision: readPositiveInteger(
      record.ownerLinkRevision,
      'thread lifecycle owner link revision',
    ),
    state,
    lease,
  }
}

/** Decodes one committed thread completion state without interpreting provider ordering. */
function decodeThreadLifecycleState(
  value: unknown,
): StoredExternalChatThreadLifecycle['state'] {
  const record = readObject(value, [
    'completed',
    'lastExternalVersion',
    'lastInternalWorkItemRevision',
    'revision',
    'updatedAt',
  ], 'external chat thread lifecycle state')
  const completed = readBoolean(record.completed, 'thread lifecycle completion state')
  const revision = readNonnegativeInteger(record.revision, 'thread lifecycle state revision')
  const lastExternalVersion = record.lastExternalVersion === undefined
    ? undefined
    : readIdentifier(record.lastExternalVersion, 'last external thread version')
  const lastInternalWorkItemRevision = record.lastInternalWorkItemRevision === undefined
    ? undefined
    : readPositiveInteger(
        record.lastInternalWorkItemRevision,
        'last internal Work Item revision',
      )
  if (
    revision === 0 &&
    (completed || lastExternalVersion !== undefined || lastInternalWorkItemRevision !== undefined)
  ) invalidStoredValue('external chat thread lifecycle state revision')
  return {
    completed,
    ...(lastExternalVersion === undefined ? {} : { lastExternalVersion }),
    ...(lastInternalWorkItemRevision === undefined ? {} : { lastInternalWorkItemRevision }),
    revision,
    updatedAt: readTimestamp(record.updatedAt, 'thread lifecycle state update timestamp'),
  }
}

/** Decodes one processing, completed, or acknowledged exclusive thread lifecycle lease. */
function decodeThreadLifecycleLease(
  value: unknown,
): StoredExternalChatThreadLifecycle['lease'] {
  const record = readObject(value, [
    'operationId',
    'attempt',
    'status',
    'leaseExpiresAt',
    'completedAt',
    'completedOutcome',
  ], 'external chat thread lifecycle lease')
  const operationId = readIdentifier(record.operationId, 'thread lifecycle operation ID')
  const status = readEnum(
    record.status,
    ['processing', 'completed', 'acknowledged'],
    'thread lifecycle lease status',
  )
  const completedAt = readOptionalTimestamp(
    record.completedAt,
    'thread lifecycle completion timestamp',
  )
  const completedOutcome = record.completedOutcome === undefined
    ? undefined
    : decodeExternalChatSyncOutcome(record.completedOutcome)
  if (
    status === 'completed'
      ? completedAt === undefined || completedOutcome === undefined
      : completedAt !== undefined || completedOutcome !== undefined
  ) invalidStoredValue('external chat thread lifecycle lease completion')
  if (completedOutcome !== undefined && completedOutcome.operationId !== operationId) {
    invalidStoredValue('external chat thread lifecycle outcome scope')
  }
  return {
    operationId,
    attempt: readPositiveInteger(record.attempt, 'thread lifecycle lease attempt'),
    status,
    leaseExpiresAt: readTimestamp(record.leaseExpiresAt, 'thread lifecycle lease expiry'),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(completedOutcome === undefined ? {} : { completedOutcome }),
  }
}

/**
 * Decodes a stored external-to-internal message binding.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated message binding record.
 */
export function decodeStoredExternalChatMessageBinding(
  value: unknown,
): StoredExternalChatMessageBinding {
  const record = readObject(value, [
    'workspaceId',
    'binding',
    'storageRevision',
  ], 'stored external chat message binding')
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    binding: decodeExternalChatMessageBinding(record.binding),
    storageRevision: readPositiveInteger(
      record.storageRevision,
      'message binding storage revision',
    ),
  }
}

/**
 * Decodes a private external chat synchronization cursor.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated synchronization cursor.
 */
export function decodeExternalChatSyncCursor(value: unknown): ExternalChatSyncCursor {
  const record = readObject(value, [
    'schemaVersion',
    'linkId',
    'provider',
    'operationId',
    'mode',
    'status',
    'ownerLinkRevision',
    'authorizationRevision',
    'observedSourceAvailability',
    'observedSourceState',
    'observedSourceAt',
    'completionSyncStatus',
    'providerCursor',
    'revision',
    'lastEventId',
    'lastEventAt',
    'updatedAt',
  ], 'external chat sync cursor')
  const status = readEnum(
    record.status,
    ['processing', 'completed'],
    'sync cursor status',
  )
  if (status === 'completed' && record.providerCursor !== undefined) {
    invalidStoredValue('A completed external chat sync cursor cannot retain a provider cursor.')
  }
  if (
    status === 'completed' &&
    (
      record.observedSourceAvailability === undefined ||
      record.observedSourceState === undefined ||
      record.completionSyncStatus === undefined
    )
  ) {
    invalidStoredValue('A completed external chat sync cursor must retain terminal source state.')
  }
  return {
    schemaVersion: readSchemaVersion(record.schemaVersion),
    linkId: readIdentifier(record.linkId, 'external chat link ID'),
    provider: decodeProvider(record.provider),
    operationId: readIdentifier(record.operationId, 'resynchronization operation ID'),
    mode: readEnum(record.mode, ['resume', 'full'], 'sync cursor mode'),
    status,
    ownerLinkRevision: readPositiveInteger(
      record.ownerLinkRevision,
      'sync cursor owner link revision',
    ),
    authorizationRevision: readPositiveInteger(
      record.authorizationRevision,
      'sync cursor authorization revision',
    ),
    ...(record.observedSourceAvailability === undefined
      ? {}
      : {
        observedSourceAvailability: decodeAvailability(
          record.observedSourceAvailability,
        ),
      }),
    ...(record.observedSourceState === undefined
      ? {}
      : { observedSourceState: decodeSourceState(record.observedSourceState) }),
    ...(record.observedSourceAt === undefined
      ? {}
      : { observedSourceAt: readTimestamp(record.observedSourceAt, 'observed source timestamp') }),
    ...(record.completionSyncStatus === undefined
      ? {}
      : {
        completionSyncStatus: readEnum(
          record.completionSyncStatus,
          ['pending', 'synced', 'conflict', 'failed', 'paused'],
          'sync cursor completion status',
        ),
      }),
    ...(record.providerCursor === undefined
      ? {}
      : { providerCursor: readText(record.providerCursor, 'provider cursor') }),
    revision: readPositiveInteger(record.revision, 'sync cursor revision'),
    ...(record.lastEventId === undefined
      ? {}
      : { lastEventId: readIdentifier(record.lastEventId, 'provider event ID') }),
    ...(record.lastEventAt === undefined
      ? {}
      : { lastEventAt: readTimestamp(record.lastEventAt, 'last provider event timestamp') }),
    updatedAt: readTimestamp(record.updatedAt, 'sync cursor update timestamp'),
  }
}

/**
 * Decodes one durable deferred external chat event.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated deferred event.
 */
export function decodeDeferredExternalChatEvent(value: unknown): DeferredExternalChatEvent {
  const record = readObject(value, [
    'workspaceId',
    'linkId',
    'event',
    'authorizationRevision',
    'expectedParentLifecycleFences',
    'fingerprint',
    'reason',
    'attempt',
    'retryAt',
    'createdAt',
    'updatedAt',
  ], 'deferred external chat event')
  const event = decodeExternalChatInboundEvent(record.event)
  const expectedParentLifecycleFences = record.expectedParentLifecycleFences === undefined
    ? undefined
    : decodeExternalChatParentLifecycleFenceSnapshot(record.expectedParentLifecycleFences)
  if (
    expectedParentLifecycleFences === undefined &&
    !(
      event.type === 'source.lifecycle-changed' &&
      (event.resourceType === 'workspace' || event.resourceType === 'conversation')
    )
  ) {
    invalidStoredValue('deferred external chat parent authority snapshot')
  }
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    linkId: readIdentifier(record.linkId, 'external chat link ID'),
    event,
    ...(record.authorizationRevision === undefined
      ? {}
      : {
          authorizationRevision: readPositiveInteger(
            record.authorizationRevision,
            'deferred lifecycle authorization revision',
          ),
        }),
    ...(expectedParentLifecycleFences === undefined
      ? {}
      : { expectedParentLifecycleFences }),
    fingerprint: readDigest(record.fingerprint, 'deferred event fingerprint'),
    reason: readEnum(
      record.reason,
      ['out-of-order', 'rate-limited', 'source-unavailable'],
      'deferred event reason',
    ),
    attempt: readPositiveInteger(record.attempt, 'deferred event attempt'),
    retryAt: readTimestamp(record.retryAt, 'deferred event retry timestamp'),
    createdAt: readTimestamp(record.createdAt, 'deferred event creation timestamp'),
    updatedAt: readTimestamp(record.updatedAt, 'deferred event update timestamp'),
  }
}

/**
 * Decodes one durable deferred outbound external chat event.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated deferred outbound event.
 */
export function decodeDeferredExternalChatOutboundEvent(
  value: unknown,
): DeferredExternalChatOutboundEvent {
  const record = readObject(value, [
    'workspaceId',
    'linkId',
    'ownerTeamId',
    'ownerWorkItemId',
    'ownerLinkRevision',
    'expectedParentLifecycleFences',
    'event',
    'fingerprint',
    'operationId',
    'attempt',
    'retryAt',
    'createdAt',
    'updatedAt',
  ], 'deferred outbound external chat event')
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    linkId: readIdentifier(record.linkId, 'external chat link ID'),
    ownerTeamId: readIdentifier(record.ownerTeamId, 'deferred outbound owner Team ID'),
    ownerWorkItemId: readIdentifier(
      record.ownerWorkItemId,
      'deferred outbound owner Work Item ID',
    ),
    ownerLinkRevision: readPositiveInteger(
      record.ownerLinkRevision,
      'deferred outbound owner link revision',
    ),
    expectedParentLifecycleFences: decodeExternalChatParentLifecycleFenceSnapshot(
      record.expectedParentLifecycleFences,
    ),
    event: decodeExternalChatSyncOutboundEvent(record.event),
    fingerprint: readDigest(record.fingerprint, 'deferred outbound event fingerprint'),
    operationId: readIdentifier(record.operationId, 'outbound operation ID'),
    attempt: readPositiveInteger(record.attempt, 'deferred outbound event attempt'),
    retryAt: readTimestamp(record.retryAt, 'deferred outbound event retry timestamp'),
    createdAt: readTimestamp(record.createdAt, 'deferred outbound event creation timestamp'),
    updatedAt: readTimestamp(record.updatedAt, 'deferred outbound event update timestamp'),
  }
}

/**
 * Decodes an exact present-or-absent parent lifecycle authority snapshot.
 *
 * @param value - Untrusted durable snapshot value.
 * @returns Validated workspace and conversation parent authorities.
 */
function decodeExternalChatParentLifecycleFenceSnapshot(
  value: unknown,
): ExternalChatParentLifecycleFenceSnapshot {
  const record = readObject(
    value,
    ['workspace', 'conversation'],
    'external chat parent lifecycle fence snapshot',
  )
  return {
    workspace: record.workspace === undefined
      ? undefined
      : decodeExternalChatParentLifecycleFence(record.workspace, false),
    conversation: record.conversation === undefined
      ? undefined
      : decodeExternalChatParentLifecycleFence(record.conversation, true),
  }
}

/**
 * Decodes one exact provider-parent lifecycle fence from a queue payload.
 *
 * @param value - Untrusted durable fence value.
 * @param conversationScoped - Whether the enclosing snapshot slot requires a conversation ID.
 * @returns Validated provider parent authority.
 */
function decodeExternalChatParentLifecycleFence(
  value: unknown,
  conversationScoped: boolean,
): ExternalChatParentLifecycleFence {
  const record = readObject(value, [
    'workspaceId',
    'provider',
    'installationId',
    'externalWorkspaceId',
    'conversationExternalId',
    'authorizationRevision',
    'availability',
    'state',
    'restrictive',
    'eventId',
    'operationId',
    'occurredAt',
  ], 'external chat parent lifecycle fence')
  const availability = decodeAvailability(record.availability)
  const state = decodeSourceState(record.state)
  const restrictive = readBoolean(record.restrictive, 'parent lifecycle restrictive state')
  const conversationExternalId = record.conversationExternalId === undefined
    ? undefined
    : readIdentifier(record.conversationExternalId, 'parent lifecycle conversation ID')
  if (
    restrictive !== externalChatLifecycleBlocksSynchronization(availability, state) ||
    conversationScoped === (conversationExternalId === undefined)
  ) {
    invalidStoredValue('external chat parent lifecycle fence')
  }
  return {
    workspaceId: readIdentifier(record.workspaceId, 'parent lifecycle Workspace ID'),
    provider: decodeProvider(record.provider),
    installationId: readIdentifier(record.installationId, 'parent lifecycle installation ID'),
    externalWorkspaceId: readIdentifier(
      record.externalWorkspaceId,
      'parent lifecycle external Workspace ID',
    ),
    ...(conversationExternalId === undefined ? {} : { conversationExternalId }),
    authorizationRevision: readPositiveInteger(
      record.authorizationRevision,
      'parent lifecycle authorization revision',
    ),
    availability,
    state,
    restrictive,
    eventId: readIdentifier(record.eventId, 'parent lifecycle event ID'),
    operationId: readIdentifier(record.operationId, 'parent lifecycle operation ID'),
    occurredAt: readTimestamp(record.occurredAt, 'parent lifecycle occurrence timestamp'),
  }
}

/**
 * Decodes one trusted internal mutation retained for outbound synchronization.
 *
 * @param value - Untrusted persisted outbound event value.
 * @returns A strictly validated outbound synchronization event.
 */
function decodeExternalChatSyncOutboundEvent(value: unknown): ExternalChatSyncOutboundEvent {
  const candidate = readUnknownRecord(value, 'external chat outbound event')
  const type = readText(candidate.type, 'external chat outbound event type')
  const baseKeys = [
    'workspaceId',
    'linkId',
    'teamId',
    'workItemId',
    'principalId',
    'correlationId',
    'occurredAt',
    'externalSyncEligible',
    'type',
  ]
  const base = decodeOutboundEventBase(candidate)
  if (type === 'comment.created' || type === 'comment.edited') {
    const record = readObject(value, [
      ...baseKeys,
      'internalCommentId',
      'internalCommentVersion',
      'bodyMarkdown',
    ], 'external chat outbound comment event')
    return {
      ...base,
      type,
      internalCommentId: readIdentifier(
        record.internalCommentId,
        'internal comment ID',
      ),
      internalCommentVersion: readPositiveInteger(
        record.internalCommentVersion,
        'internal comment version',
      ),
      bodyMarkdown: readText(record.bodyMarkdown, 'outbound comment Markdown'),
    }
  }
  if (type === 'comment.deleted') {
    const record = readObject(value, [
      ...baseKeys,
      'internalCommentId',
      'internalCommentVersion',
      'deletedAt',
    ], 'external chat outbound comment deletion event')
    return {
      ...base,
      type,
      internalCommentId: readIdentifier(
        record.internalCommentId,
        'internal comment ID',
      ),
      internalCommentVersion: readPositiveInteger(
        record.internalCommentVersion,
        'internal comment version',
      ),
      deletedAt: readTimestamp(record.deletedAt, 'internal comment deletion timestamp'),
    }
  }
  if (type === 'work-item.completed' || type === 'work-item.reopened') {
    const record = readObject(value, [
      ...baseKeys,
      'workItemRevision',
    ], 'external chat outbound Work Item event')
    return {
      ...base,
      type,
      workItemRevision: readPositiveInteger(
        record.workItemRevision,
        'Work Item revision',
      ),
    }
  }
  invalidStoredValue('external chat outbound event type')
}

/** Fields decoded from every outbound synchronization event variant. */
type DecodedOutboundEventBase = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** External chat link identifier. */
  linkId: string
  /** Team that owns the source Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Authenticated internal principal identifier. */
  principalId: string
  /** End-to-end correlation identifier. */
  correlationId: string
  /** Internal occurrence timestamp. */
  occurredAt: string
  /** Whether policy allows the event to leave the Workspace. */
  externalSyncEligible: boolean
}

/**
 * Decodes fields shared by every outbound synchronization event.
 *
 * @param record - Untrusted outbound event record.
 * @returns Validated common outbound event fields.
 */
function decodeOutboundEventBase(record: UnknownRecord): DecodedOutboundEventBase {
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Workspace ID'),
    linkId: readIdentifier(record.linkId, 'external chat link ID'),
    teamId: readIdentifier(record.teamId, 'Team ID'),
    workItemId: readIdentifier(record.workItemId, 'Work Item ID'),
    principalId: readIdentifier(record.principalId, 'principal ID'),
    correlationId: readIdentifier(record.correlationId, 'correlation ID'),
    occurredAt: readTimestamp(record.occurredAt, 'outbound event occurrence timestamp'),
    externalSyncEligible: readBoolean(
      record.externalSyncEligible,
      'outbound event eligibility',
    ),
  }
}

/**
 * Decodes a durable duplicate Work Item redirect.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated canonical redirect.
 */
export function decodeExternalChatCanonicalRedirect(
  value: unknown,
): ExternalChatCanonicalRedirect {
  const record = readObject(value, [
    'linkId',
    'provider',
    'threadExternalId',
    'fromTeamId',
    'fromWorkItemId',
    'canonicalTeamId',
    'canonicalWorkItemId',
    'createdAt',
  ], 'external chat canonical redirect')
  return {
    linkId: readIdentifier(record.linkId, 'external chat link ID'),
    provider: decodeProvider(record.provider),
    threadExternalId: readIdentifier(record.threadExternalId, 'external thread ID'),
    fromTeamId: readIdentifier(record.fromTeamId, 'duplicate Team ID'),
    fromWorkItemId: readIdentifier(record.fromWorkItemId, 'duplicate Work Item ID'),
    canonicalTeamId: readIdentifier(record.canonicalTeamId, 'canonical Team ID'),
    canonicalWorkItemId: readIdentifier(
      record.canonicalWorkItemId,
      'canonical Work Item ID',
    ),
    createdAt: readTimestamp(record.createdAt, 'redirect creation timestamp'),
  }
}

/**
 * Decodes an auditable synchronization outcome.
 *
 * @param value - Untrusted persisted value.
 * @returns A validated outcome.
 */
export function decodeExternalChatSyncOutcome(value: unknown): ExternalChatSyncOutcome {
  const candidate = readUnknownRecord(value, 'external chat sync outcome')
  const kind = readText(candidate.kind, 'external chat sync outcome kind')
  if (kind === 'applied') {
    const record = readObject(value, [
      'kind', 'operationId', 'eventId', 'direction', 'occurredAt',
    ], 'applied external chat sync outcome')
    return {
      kind,
      operationId: readIdentifier(record.operationId, 'operation ID'),
      ...(record.eventId === undefined
        ? {}
        : { eventId: readIdentifier(record.eventId, 'provider event ID') }),
      direction: readEnum(record.direction, ['inbound', 'outbound'], 'sync direction'),
      occurredAt: readTimestamp(record.occurredAt, 'outcome timestamp'),
    }
  }
  if (kind === 'skipped') {
    const record = readObject(value, [
      'kind', 'operationId', 'eventId', 'reason', 'occurredAt',
    ], 'skipped external chat sync outcome')
    return {
      kind,
      operationId: readIdentifier(record.operationId, 'operation ID'),
      ...(record.eventId === undefined
        ? {}
        : { eventId: readIdentifier(record.eventId, 'provider event ID') }),
      reason: readEnum(record.reason, [
        'duplicate', 'self-origin', 'stale', 'paused', 'unlinked', 'not-eligible',
      ], 'skipped outcome reason'),
      occurredAt: readTimestamp(record.occurredAt, 'outcome timestamp'),
    }
  }
  if (kind === 'deferred') {
    const record = readObject(value, [
      'kind', 'operationId', 'eventId', 'reason', 'retryAt', 'occurredAt',
    ], 'deferred external chat sync outcome')
    return {
      kind,
      operationId: readIdentifier(record.operationId, 'operation ID'),
      ...(record.eventId === undefined
        ? {}
        : { eventId: readIdentifier(record.eventId, 'provider event ID') }),
      reason: readEnum(
        record.reason,
        ['out-of-order', 'rate-limited', 'source-unavailable'],
        'deferred outcome reason',
      ),
      ...(record.retryAt === undefined
        ? {}
        : { retryAt: readTimestamp(record.retryAt, 'outcome retry timestamp') }),
      occurredAt: readTimestamp(record.occurredAt, 'outcome timestamp'),
    }
  }
  if (kind === 'failed') {
    const record = readObject(value, [
      'kind', 'operationId', 'eventId', 'errorCode', 'retryable', 'occurredAt',
    ], 'failed external chat sync outcome')
    return {
      kind,
      operationId: readIdentifier(record.operationId, 'operation ID'),
      ...(record.eventId === undefined
        ? {}
        : { eventId: readIdentifier(record.eventId, 'provider event ID') }),
      errorCode: readIdentifier(record.errorCode, 'outcome error code'),
      retryable: readBoolean(record.retryable, 'outcome retryable state'),
      occurredAt: readTimestamp(record.occurredAt, 'outcome timestamp'),
    }
  }
  invalidStoredValue('external chat sync outcome kind')
}

/** Decodes a complete provider-neutral external chat link. */
function decodeExternalChatLink(value: unknown): ExternalChatWorkItemLink {
  const record = readObject(value, [
    'schemaVersion',
    'id',
    'teamId',
    'workItemId',
    'installationId',
    'provider',
    'workspace',
    'conversation',
    'source',
    'syncDirection',
    'syncStatus',
    'sourceAvailability',
    'sourceState',
    'revision',
    'lastSyncedAt',
    'lastSourceObservedAt',
    'createdAt',
    'updatedAt',
  ], 'external chat link')
  const provider = decodeProvider(record.provider)
  const workspace = decodeWorkspace(record.workspace)
  const conversation = decodeConversation(record.conversation)
  const source = decodeThreadReference(record.source)
  if (
    workspace.provider !== provider ||
    conversation.externalWorkspaceId !== workspace.externalId ||
    source.externalWorkspaceId !== workspace.externalId ||
    source.conversationExternalId !== conversation.externalId
  ) {
    invalidStoredValue('external chat link source scope')
  }
  return {
    schemaVersion: readSchemaVersion(record.schemaVersion),
    id: readIdentifier(record.id, 'external chat link ID'),
    teamId: readIdentifier(record.teamId, 'Team ID'),
    workItemId: readIdentifier(record.workItemId, 'Work Item ID'),
    installationId: readIdentifier(record.installationId, 'connector installation ID'),
    provider,
    workspace,
    conversation,
    source,
    syncDirection: readEnum(
      record.syncDirection,
      ['inbound', 'outbound', 'bidirectional', 'none'],
      'external chat sync direction',
    ),
    syncStatus: readEnum(
      record.syncStatus,
      ['pending', 'synced', 'conflict', 'failed', 'paused'],
      'external chat sync status',
    ),
    sourceAvailability: decodeAvailability(record.sourceAvailability),
    sourceState: decodeSourceState(record.sourceState),
    revision: readPositiveInteger(record.revision, 'external chat link revision'),
    ...(record.lastSyncedAt === undefined
      ? {}
      : { lastSyncedAt: readTimestamp(record.lastSyncedAt, 'last sync timestamp') }),
    ...(record.lastSourceObservedAt === undefined
      ? {}
      : {
          lastSourceObservedAt: readTimestamp(
            record.lastSourceObservedAt,
            'last source observation timestamp',
          ),
        }),
    createdAt: readTimestamp(record.createdAt, 'external chat link creation timestamp'),
    updatedAt: readTimestamp(record.updatedAt, 'external chat link update timestamp'),
  }
}

/** Decodes one provider workspace snapshot. */
function decodeWorkspace(value: unknown): ExternalChatWorkspace {
  const record = readObject(
    value,
    ['provider', 'externalId', 'displayName', 'permalink'],
    'external chat workspace',
  )
  return {
    provider: decodeProvider(record.provider),
    externalId: readIdentifier(record.externalId, 'external workspace ID'),
    ...(record.displayName === undefined
      ? {}
      : { displayName: readText(record.displayName, 'workspace display name') }),
    ...(record.permalink === undefined
      ? {}
      : { permalink: readHttpsUrl(record.permalink, 'workspace permalink') }),
  }
}

/** Decodes one provider conversation snapshot. */
function decodeConversation(value: unknown): ExternalChatConversation {
  const record = readObject(value, [
    'externalId', 'externalWorkspaceId', 'kind', 'displayName', 'permalink',
  ], 'external chat conversation')
  return {
    externalId: readIdentifier(record.externalId, 'external conversation ID'),
    externalWorkspaceId: readIdentifier(record.externalWorkspaceId, 'external workspace ID'),
    kind: readEnum(
      record.kind,
      ['channel', 'group', 'direct', 'meeting', 'unknown'],
      'conversation kind',
    ),
    ...(record.displayName === undefined
      ? {}
      : { displayName: readText(record.displayName, 'conversation display name') }),
    ...(record.permalink === undefined
      ? {}
      : { permalink: readHttpsUrl(record.permalink, 'conversation permalink') }),
  }
}

/** Decodes one stable external thread reference. */
function decodeThreadReference(value: unknown): ExternalChatThreadReference {
  const record = readObject(value, [
    'externalWorkspaceId',
    'conversationExternalId',
    'threadExternalId',
    'rootMessageExternalId',
    'sourceMessageExternalId',
    'sourcePermalink',
    'quotedRange',
  ], 'external chat thread reference')
  return {
    externalWorkspaceId: readIdentifier(record.externalWorkspaceId, 'external workspace ID'),
    conversationExternalId: readIdentifier(
      record.conversationExternalId,
      'external conversation ID',
    ),
    threadExternalId: readIdentifier(record.threadExternalId, 'external thread ID'),
    rootMessageExternalId: readIdentifier(
      record.rootMessageExternalId,
      'external root message ID',
    ),
    ...(record.sourceMessageExternalId === undefined
      ? {}
      : {
          sourceMessageExternalId: readIdentifier(
            record.sourceMessageExternalId,
            'external source message ID',
          ),
        }),
    ...(record.sourcePermalink === undefined
      ? {}
      : {
          sourcePermalink: readHttpsUrl(
            record.sourcePermalink,
            'external source permalink',
          ),
        }),
    ...(record.quotedRange === undefined
      ? {}
      : { quotedRange: decodeQuotedRange(record.quotedRange) }),
  }
}

/** Decodes one message binding. */
function decodeExternalChatMessageBinding(value: unknown): ExternalChatMessageBinding {
  const record = readObject(value, [
    'schemaVersion',
    'linkId',
    'externalMessageId',
    'internalCommentId',
    'origin',
    'externalVersion',
    'internalCommentVersion',
    'lastInboundEventId',
    'lastOutboundOperationId',
    'importedFileIds',
    'deletedAt',
    'createdAt',
    'updatedAt',
  ], 'external chat message binding')
  return {
    schemaVersion: readSchemaVersion(record.schemaVersion),
    linkId: readIdentifier(record.linkId, 'external chat link ID'),
    externalMessageId: readIdentifier(record.externalMessageId, 'external message ID'),
    internalCommentId: readIdentifier(record.internalCommentId, 'internal comment ID'),
    origin: readEnum(record.origin, ['external', 'internal'], 'message binding origin'),
    externalVersion: readText(record.externalVersion, 'external message version'),
    internalCommentVersion: readPositiveInteger(
      record.internalCommentVersion,
      'internal comment version',
    ),
    ...(record.lastInboundEventId === undefined
      ? {}
      : {
          lastInboundEventId: readIdentifier(
            record.lastInboundEventId,
            'last inbound event ID',
          ),
        }),
    ...(record.lastOutboundOperationId === undefined
      ? {}
      : {
          lastOutboundOperationId: readIdentifier(
            record.lastOutboundOperationId,
            'last outbound operation ID',
          ),
        }),
    importedFileIds: readIdentifierArray(record.importedFileIds, 'imported File IDs'),
    ...(record.deletedAt === undefined
      ? {}
      : { deletedAt: readTimestamp(record.deletedAt, 'binding deletion timestamp') }),
    createdAt: readTimestamp(record.createdAt, 'binding creation timestamp'),
    updatedAt: readTimestamp(record.updatedAt, 'binding update timestamp'),
  }
}

/** Decodes one normalized inbound provider event. */
function decodeExternalChatInboundEvent(value: unknown): ExternalChatInboundEvent {
  const candidate = readUnknownRecord(value, 'external chat inbound event')
  const type = readText(candidate.type, 'external chat inbound event type')
  const baseKeys = [
    'schemaVersion',
    'eventId',
    'correlationId',
    'installationId',
    'provider',
    'externalWorkspaceId',
    'occurredAt',
    'externalSequence',
    'originOperationId',
    'type',
  ]
  const base = decodeInboundEventBase(candidate)
  const threadBaseKeys = [...baseKeys, 'conversationExternalId', 'threadExternalId']
  if (type === 'message.created' || type === 'message.edited') {
    const record = readObject(value, [...threadBaseKeys, 'message'], 'external chat message event')
    return { ...decodeThreadInboundEventBase(candidate), type, message: decodeMessage(record.message) }
  }
  if (type === 'message.deleted') {
    const record = readObject(value, [
      ...threadBaseKeys, 'externalMessageId', 'externalVersion', 'sourcePermalink', 'deletedAt',
    ], 'external chat message deletion event')
    return {
      ...decodeThreadInboundEventBase(candidate),
      type,
      externalMessageId: readIdentifier(record.externalMessageId, 'external message ID'),
      externalVersion: readText(record.externalVersion, 'external message version'),
      ...(record.sourcePermalink === undefined
        ? {}
        : { sourcePermalink: readHttpsUrl(record.sourcePermalink, 'source permalink') }),
      deletedAt: readTimestamp(record.deletedAt, 'external message deletion timestamp'),
    }
  }
  if (type === 'thread.completed') {
    const record = readObject(value, [
      ...threadBaseKeys, 'externalVersion', 'sourcePermalink', 'completedAt',
    ], 'external chat thread completion event')
    return {
      ...decodeThreadInboundEventBase(candidate),
      type,
      externalVersion: readText(record.externalVersion, 'external thread version'),
      ...(record.sourcePermalink === undefined
        ? {}
        : { sourcePermalink: readHttpsUrl(record.sourcePermalink, 'source permalink') }),
      completedAt: readTimestamp(record.completedAt, 'external thread completion timestamp'),
    }
  }
  if (type === 'thread.reopened') {
    const record = readObject(value, [
      ...threadBaseKeys, 'externalVersion', 'sourcePermalink', 'reopenedAt',
    ], 'external chat thread reopen event')
    return {
      ...decodeThreadInboundEventBase(candidate),
      type,
      externalVersion: readText(record.externalVersion, 'external thread version'),
      ...(record.sourcePermalink === undefined
        ? {}
        : { sourcePermalink: readHttpsUrl(record.sourcePermalink, 'source permalink') }),
      reopenedAt: readTimestamp(record.reopenedAt, 'external thread reopen timestamp'),
    }
  }
  if (type === 'source.lifecycle-changed') {
    const resourceType = readEnum(
      candidate.resourceType,
      ['workspace', 'conversation', 'thread', 'message', 'attachment'],
      'external resource type',
    )
    const lifecycleKeys = [
      'resourceType',
      'availability',
      'state',
      'reasonCode',
      'sourcePermalink',
    ]
    const scopedKeys = resourceType === 'workspace'
      ? baseKeys
      : resourceType === 'conversation'
      ? [...baseKeys, 'conversationExternalId']
      : resourceType === 'thread'
      ? threadBaseKeys
      : [...threadBaseKeys, 'resourceExternalId']
    const record = readObject(
      value,
      [...scopedKeys, ...lifecycleKeys],
      'external chat source lifecycle event',
    )
    const availability = decodeAvailability(record.availability)
    const state = decodeSourceState(record.state)
    if (state === 'completed' && resourceType !== 'thread') {
      invalidStoredValue('external chat source lifecycle completion scope')
    }
    const lifecycle = {
      ...base,
      availability,
      state,
      reasonCode: readIdentifier(record.reasonCode, 'source lifecycle reason code'),
      ...(record.sourcePermalink === undefined
        ? {}
        : { sourcePermalink: readHttpsUrl(record.sourcePermalink, 'source permalink') }),
    }
    if (resourceType === 'workspace') {
      return { ...lifecycle, type: 'source.lifecycle-changed', resourceType }
    }
    const conversationExternalId = readIdentifier(
      record.conversationExternalId,
      'external conversation ID',
    )
    if (resourceType === 'conversation') {
      return {
        ...lifecycle,
        type: 'source.lifecycle-changed',
        resourceType,
        conversationExternalId,
      }
    }
    const threadExternalId = readIdentifier(record.threadExternalId, 'external thread ID')
    if (resourceType === 'thread') {
      return {
        ...lifecycle,
        type: 'source.lifecycle-changed',
        resourceType,
        conversationExternalId,
        threadExternalId,
      }
    }
    const resourceExternalId = readIdentifier(
      record.resourceExternalId,
      'external resource ID',
    )
    return {
      ...lifecycle,
      type: 'source.lifecycle-changed',
      resourceType,
      conversationExternalId,
      threadExternalId,
      resourceExternalId,
    }
  }
  invalidStoredValue('external chat inbound event type')
}

/** Fields decoded from every inbound event variant. */
type DecodedInboundEventBase = {
  /** Current external chat schema version. */
  schemaVersion: 1
  /** Stable provider event identifier. */
  eventId: string
  /** End-to-end correlation identifier. */
  correlationId: string
  /** Connector installation identifier. */
  installationId: string
  /** External chat provider. */
  provider: ExternalChatProvider
  /** Provider workspace identifier. */
  externalWorkspaceId: string
  /** Provider occurrence timestamp. */
  occurredAt: string
  /** Optional provider ordering token. */
  externalSequence?: string
  /** Optional authenticated echo marker. */
  originOperationId?: string
}

/** Decoded fields shared by normalized events contained by one provider thread. */
type DecodedThreadInboundEventBase = DecodedInboundEventBase & {
  /** Provider conversation identifier. */
  conversationExternalId: string
  /** Provider thread identifier. */
  threadExternalId: string
}

/** Decodes common inbound event fields. */
function decodeInboundEventBase(record: UnknownRecord): DecodedInboundEventBase {
  return {
    schemaVersion: readSchemaVersion(record.schemaVersion),
    eventId: readIdentifier(record.eventId, 'provider event ID'),
    correlationId: readIdentifier(record.correlationId, 'correlation ID'),
    installationId: readIdentifier(record.installationId, 'connector installation ID'),
    provider: decodeProvider(record.provider),
    externalWorkspaceId: readIdentifier(record.externalWorkspaceId, 'external workspace ID'),
    occurredAt: readTimestamp(record.occurredAt, 'provider event timestamp'),
    ...(record.externalSequence === undefined
      ? {}
      : { externalSequence: readText(record.externalSequence, 'external sequence') }),
    ...(record.originOperationId === undefined
      ? {}
      : {
          originOperationId: readIdentifier(
            record.originOperationId,
            'origin operation ID',
          ),
        }),
  }
}

/**
 * Decodes the required conversation and thread scope for one contained inbound event.
 *
 * @param record - Untrusted persisted event record.
 * @returns Validated common and thread scope fields.
 */
function decodeThreadInboundEventBase(record: UnknownRecord): DecodedThreadInboundEventBase {
  return {
    ...decodeInboundEventBase(record),
    conversationExternalId: readIdentifier(
      record.conversationExternalId,
      'external conversation ID',
    ),
    threadExternalId: readIdentifier(record.threadExternalId, 'external thread ID'),
  }
}

/** Decodes one normalized external message. */
function decodeMessage(value: unknown): ExternalChatMessage {
  const record = readObject(value, [
    'externalId',
    'externalVersion',
    'conversationExternalId',
    'threadExternalId',
    'parentMessageExternalId',
    'permalink',
    'availability',
    'state',
    'actor',
    'bodyMarkdown',
    'quotedRanges',
    'attachments',
    'postedAt',
    'updatedAt',
    'editedAt',
    'deletedAt',
  ], 'external chat message')
  const state = readEnum(
    record.state,
    ['active', 'deleted', 'retained-metadata', 'retention-expired'],
    'external message state',
  )
  const quotedRanges = readArray(record.quotedRanges, 'external message quoted ranges')
    .map(decodeQuotedRange)
  const attachments = readArray(record.attachments, 'external message attachments')
    .map(decodeAttachment)
  return {
    externalId: readIdentifier(record.externalId, 'external message ID'),
    externalVersion: readText(record.externalVersion, 'external message version'),
    conversationExternalId: readIdentifier(
      record.conversationExternalId,
      'external conversation ID',
    ),
    threadExternalId: readIdentifier(record.threadExternalId, 'external thread ID'),
    ...(record.parentMessageExternalId === undefined
      ? {}
      : {
          parentMessageExternalId: readIdentifier(
            record.parentMessageExternalId,
            'parent external message ID',
          ),
        }),
    ...(record.permalink === undefined
      ? {}
      : { permalink: readHttpsUrl(record.permalink, 'external message permalink') }),
    availability: decodeAvailability(record.availability),
    state,
    ...(record.actor === undefined ? {} : { actor: decodeActor(record.actor) }),
    ...(record.bodyMarkdown === undefined
      ? {}
      : { bodyMarkdown: readText(record.bodyMarkdown, 'external message body') }),
    quotedRanges,
    attachments,
    postedAt: readTimestamp(record.postedAt, 'external message post timestamp'),
    updatedAt: readTimestamp(record.updatedAt, 'external message update timestamp'),
    ...(record.editedAt === undefined
      ? {}
      : { editedAt: readTimestamp(record.editedAt, 'external message edit timestamp') }),
    ...(record.deletedAt === undefined
      ? {}
      : { deletedAt: readTimestamp(record.deletedAt, 'external message deletion timestamp') }),
  }
}

/** Decodes one external actor snapshot. */
function decodeActor(value: unknown): ExternalChatActor {
  const record = readObject(value, ['externalId', 'kind', 'displayName'], 'external chat actor')
  return {
    externalId: readIdentifier(record.externalId, 'external actor ID'),
    kind: readEnum(
      record.kind,
      ['person', 'bot', 'application', 'unknown'],
      'external actor kind',
    ),
    ...(record.displayName === undefined
      ? {}
      : { displayName: readText(record.displayName, 'external actor display name') }),
  }
}

/** Decodes one external message quote. */
function decodeQuotedRange(value: unknown): ExternalChatQuotedRange {
  const record = readObject(
    value,
    ['sourceMessageExternalId', 'startOffset', 'endOffset', 'text'],
    'external chat quoted range',
  )
  const startOffset = readNonnegativeInteger(record.startOffset, 'quote start offset')
  const endOffset = readNonnegativeInteger(record.endOffset, 'quote end offset')
  const text = readText(record.text, 'quoted text')
  if (endOffset <= startOffset || endOffset - startOffset !== text.length) {
    invalidStoredValue('external chat quoted range offsets')
  }
  return {
    sourceMessageExternalId: readIdentifier(
      record.sourceMessageExternalId,
      'quoted source message ID',
    ),
    startOffset,
    endOffset,
    text,
  }
}

/** Decodes one external attachment metadata snapshot. */
function decodeAttachment(value: unknown): ExternalChatAttachment {
  const record = readObject(value, [
    'externalId',
    'fileName',
    'contentType',
    'sizeBytes',
    'permalink',
    'availability',
    'state',
    'importedFileId',
    'createdAt',
    'deletedAt',
  ], 'external chat attachment')
  return {
    externalId: readIdentifier(record.externalId, 'external attachment ID'),
    fileName: readText(record.fileName, 'external attachment file name'),
    ...(record.contentType === undefined
      ? {}
      : { contentType: readText(record.contentType, 'attachment content type') }),
    ...(record.sizeBytes === undefined
      ? {}
      : { sizeBytes: readNonnegativeInteger(record.sizeBytes, 'attachment byte size') }),
    ...(record.permalink === undefined
      ? {}
      : { permalink: readHttpsUrl(record.permalink, 'attachment permalink') }),
    availability: decodeAvailability(record.availability),
    state: readEnum(
      record.state,
      ['active', 'deleted', 'retained-metadata', 'retention-expired'],
      'external attachment state',
    ),
    ...(record.importedFileId === undefined
      ? {}
      : { importedFileId: readIdentifier(record.importedFileId, 'imported File ID') }),
    ...(record.createdAt === undefined
      ? {}
      : { createdAt: readTimestamp(record.createdAt, 'attachment creation timestamp') }),
    ...(record.deletedAt === undefined
      ? {}
      : { deletedAt: readTimestamp(record.deletedAt, 'attachment deletion timestamp') }),
  }
}

/** Decodes a supported provider. */
function decodeProvider(value: unknown): ExternalChatProvider {
  return readEnum(value, ['slack', 'microsoft-teams'], 'external chat provider')
}

/** Decodes provider source availability. */
function decodeAvailability(value: unknown): ExternalChatSourceAvailability {
  return readEnum(value, [
    'available',
    'temporarily-unavailable',
    'installation-disconnected',
    'needs-reauth',
    'scope-changed',
    'permission-lost',
  ], 'external chat source availability')
}

/** Decodes provider source lifecycle state. */
function decodeSourceState(value: unknown): ExternalChatSourceState {
  return readEnum(value, [
    'active', 'completed', 'deleted', 'retained-metadata', 'retention-expired',
  ], 'external chat source state')
}

/** Reads the only currently supported external chat schema version. */
function readSchemaVersion(value: unknown): 1 {
  if (value !== 1) invalidStoredValue('external chat schema version')
  return 1
}

/** Reads an object and rejects unknown properties. */
function readObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): UnknownRecord {
  const record = readUnknownRecord(value, label)
  const allowed = new Set(allowedKeys)
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    invalidStoredValue(`${label} properties`)
  }
  return record
}

/** Reads an untrusted object value. */
function readUnknownRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidStoredValue(label)
  }
  return Object.fromEntries(Object.entries(value))
}

/** Reads a bounded nonempty identifier. */
function readIdentifier(value: unknown, label: string): string {
  const text = readText(value, label)
  if (text.trim() !== text || text.length === 0) invalidStoredValue(label)
  return text
}

/** Reads bounded stored text. */
function readText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_STORED_TEXT_BYTES
  ) {
    invalidStoredValue(label)
  }
  return value
}

/** Reads one lowercase SHA-256 digest. */
function readDigest(value: unknown, label: string): string {
  const digest = readText(value, label)
  if (!/^[a-f0-9]{64}$/u.test(digest)) invalidStoredValue(label)
  return digest
}

/** Reads a boolean. */
function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalidStoredValue(label)
  return value
}

/** Reads a positive safe integer. */
function readPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
    invalidStoredValue(label)
  }
  return value
}

/** Reads a nonnegative safe integer. */
function readNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    invalidStoredValue(label)
  }
  return value
}

/** Reads an array without trusting its elements. */
function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) invalidStoredValue(label)
  return [...value]
}

/** Reads a bounded array of nonempty identifiers. */
function readIdentifierArray(value: unknown, label: string): string[] {
  return readArray(value, label).map((entry) => readIdentifier(entry, label))
}

/** Reads one ISO 8601 timestamp. */
function readTimestamp(value: unknown, label: string): string {
  const timestamp = readText(value, label)
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    invalidStoredValue(label)
  }
  return timestamp
}

/** Reads an optional ISO 8601 timestamp. */
function readOptionalTimestamp(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : readTimestamp(value, label)
}

/** Reads a stable HTTPS URL and rejects embedded credentials. */
function readHttpsUrl(value: unknown, label: string): string {
  const text = readText(value, label)
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      invalidStoredValue(label)
    }
  } catch (error) {
    if (error instanceof ExternalChatError) throw error
    invalidStoredValue(label)
  }
  return text
}

/** Reads a string union member. */
function readEnum<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  label: string,
): TValue {
  if (typeof value !== 'string') invalidStoredValue(label)
  for (const candidate of allowed) {
    if (value === candidate) return candidate
  }
  invalidStoredValue(label)
}

/** Throws the stable fail-closed error used for malformed durable state. */
function invalidStoredValue(label: string): never {
  throw new ExternalChatError(
    'ExternalChatPersistenceFailed',
    `Stored ${label} is invalid.`,
  )
}
