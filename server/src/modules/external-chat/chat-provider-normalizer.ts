import { isIP } from 'node:net'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  type ExternalChatActor,
  type ExternalChatAttachment,
  type ExternalChatConversation,
  type ExternalChatInboundEvent,
  type ExternalChatMessage,
  type ExternalChatProvider,
  type ExternalChatQuotedRange,
  type ExternalChatSourceAvailability,
  type ExternalChatSourceState,
  type ExternalChatThreadSnapshot,
  type ExternalChatWorkspace,
} from '@mukuroji/contracts'
import {
  ChatProviderAdapterError,
  type ChatProviderNormalizedWebhook,
  type ChatProviderThreadMutationResult,
  type ChatProviderThreadPage,
} from './chat-provider-adapter'

const MAX_IDENTIFIER_BYTES = 2_048
const MAX_PROVIDER_VERSION_BYTES = 8_192
const MAX_DISPLAY_TEXT_BYTES = 4_096
const MAX_MARKDOWN_BYTES = 262_144
const MAX_QUOTED_TEXT_BYTES = 65_536
const MAX_PERMALINK_BYTES = 8_192
const MAX_PROVIDER_CURSOR_BYTES = 16_384
const MAX_ORIGIN_MARKER_BYTES = 4_096
const MAX_THREAD_MESSAGES = 100
const MAX_MESSAGE_ATTACHMENTS = 100
const MAX_MESSAGE_QUOTES = 100
const MAX_WEBHOOK_EVENTS = 100

/**
 * Deeply validates and allowlists one normalized webhook returned by a provider adapter.
 *
 * @param value - Untrusted adapter result.
 * @returns Exact provider-neutral webhook data without unknown runtime properties.
 */
export function normalizeChatProviderWebhook(
  value: unknown,
  permalinkHosts: readonly string[] = [],
): ChatProviderNormalizedWebhook {
  const record = requireRecord(value, 'normalized webhook', 'ChatProviderInvalidWebhook')
  const deliveryId = readIdentifier(
    record.deliveryId,
    'provider delivery ID',
    'ChatProviderInvalidWebhook',
  )
  const rawEvents = requireBoundedArray(
    record.events,
    'normalized webhook events',
    MAX_WEBHOOK_EVENTS,
    'ChatProviderInvalidWebhook',
  )
  if (rawEvents.length === 0) {
    invalidAdapterValue(
      'ChatProviderInvalidWebhook',
      'The normalized webhook must contain at least one event.',
    )
  }
  const events = rawEvents.map((event) => normalizeInboundEventWithCode(
    event,
    'ChatProviderInvalidWebhook',
  ))
  const originMarkers = normalizeOriginMarkers(record.originMarkers)
  const normalized: ChatProviderNormalizedWebhook = {
    deliveryId,
    events,
    ...(originMarkers === undefined ? {} : { originMarkers }),
  }
  return requireProviderOwnedPermalinks(
    normalized,
    permalinkHosts,
    'ChatProviderInvalidWebhook',
  )
}

/**
 * Deeply validates and allowlists one provider-normalized inbound event.
 *
 * This function is also used when a durable deferred event re-enters the synchronization service,
 * so stored data never bypasses the adapter response boundary.
 *
 * @param value - Untrusted adapter or persistence value.
 * @returns Exact provider-neutral event without unknown runtime properties.
 */
export function normalizeChatProviderInboundEvent(
  value: unknown,
  permalinkHosts: readonly string[] = [],
): ExternalChatInboundEvent {
  return requireProviderOwnedPermalinks(
    normalizeInboundEventWithCode(value, 'ChatProviderInvalidResponse'),
    permalinkHosts,
    'ChatProviderInvalidResponse',
  )
}

/**
 * Deeply validates and allowlists a provider thread snapshot.
 *
 * @param value - Untrusted adapter result.
 * @returns Exact provider-neutral thread snapshot.
 */
export function normalizeChatProviderThreadSnapshot(
  value: unknown,
  permalinkHosts: readonly string[] = [],
): ExternalChatThreadSnapshot {
  const record = requireRecord(value, 'thread snapshot', 'ChatProviderInvalidResponse')
  if (record.schemaVersion !== EXTERNAL_CHAT_SCHEMA_VERSION) {
    invalidResponse('The provider returned an unsupported thread schema version.')
  }
  if (record.nextMessageCursor !== undefined) {
    invalidResponse('A provider thread snapshot must not contain an application cursor.')
  }
  const workspace = normalizeWorkspace(record.workspace)
  const conversation = normalizeConversation(record.conversation)
  const availability = readAvailability(record.availability, 'ChatProviderInvalidResponse')
  const state = readSourceState(record.state, 'ChatProviderInvalidResponse')
  const rawMessages = requireBoundedArray(
    record.messages,
    'thread messages',
    MAX_THREAD_MESSAGES,
    'ChatProviderInvalidResponse',
  )
  const restrictive = mustOmitSourceContent(availability, state) || state === 'deleted'
  if (
    restrictive &&
    (rawMessages.length > 0 || record.permalink !== undefined ||
      workspace.displayName !== undefined || workspace.permalink !== undefined ||
      conversation.displayName !== undefined || conversation.permalink !== undefined)
  ) {
    invalidResponse('A redacted provider thread snapshot contains restricted source metadata.')
  }
  const permalink = readOptionalHttpsPermalink(
    record.permalink,
    'thread permalink',
    'ChatProviderInvalidResponse',
  )
  if (availability === 'available' && (state === 'active' || state === 'completed') && !permalink) {
    invalidResponse('An available provider thread snapshot requires an HTTPS permalink.')
  }
  const messages = rawMessages.map((message) => normalizeChatProviderMessage(message))
  if (
    state === 'retained-metadata' &&
    messages.some((message) =>
      message.bodyMarkdown !== undefined || message.quotedRanges.length > 0
    )
  ) {
    invalidResponse('A retained-metadata provider thread contains message body content.')
  }
  const messageCount = readOptionalNonNegativeInteger(
    record.messageCount,
    'thread message count',
    'ChatProviderInvalidResponse',
  )
  if (messageCount !== undefined && messageCount < messages.length) {
    invalidResponse('The provider thread message count is smaller than its returned page.')
  }
  const completedAt = readOptionalTimestamp(
    record.completedAt,
    'thread completion timestamp',
    'ChatProviderInvalidResponse',
  )
  const normalized: ExternalChatThreadSnapshot = {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    workspace,
    conversation,
    externalId: readIdentifier(
      record.externalId,
      'external thread ID',
      'ChatProviderInvalidResponse',
    ),
    rootMessageExternalId: readIdentifier(
      record.rootMessageExternalId,
      'external root message ID',
      'ChatProviderInvalidResponse',
    ),
    ...(permalink === undefined ? {} : { permalink }),
    availability,
    state,
    ...(messageCount === undefined ? {} : { messageCount }),
    messages,
    hasMoreMessages: readBoolean(
      record.hasMoreMessages,
      'thread pagination flag',
      'ChatProviderInvalidResponse',
    ),
    createdAt: readTimestamp(
      record.createdAt,
      'thread creation timestamp',
      'ChatProviderInvalidResponse',
    ),
    updatedAt: readTimestamp(
      record.updatedAt,
      'thread update timestamp',
      'ChatProviderInvalidResponse',
    ),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
  return requireProviderOwnedPermalinks(
    normalized,
    permalinkHosts,
    'ChatProviderInvalidResponse',
  )
}

/**
 * Deeply validates and allowlists one bounded provider thread page.
 *
 * @param value - Untrusted adapter result.
 * @returns Exact provider page with its private continuation separated from public data.
 */
export function normalizeChatProviderThreadPage(
  value: unknown,
  permalinkHosts: readonly string[] = [],
): ChatProviderThreadPage {
  const record = requireRecord(value, 'thread page', 'ChatProviderInvalidResponse')
  const providerCursor = readOptionalBoundedText(
    record.providerCursor,
    'provider cursor',
    MAX_PROVIDER_CURSOR_BYTES,
    'ChatProviderInvalidResponse',
  )
  return {
    thread: normalizeChatProviderThreadSnapshot(record.thread, permalinkHosts),
    ...(providerCursor === undefined ? {} : { providerCursor }),
  }
}

/**
 * Deeply validates and allowlists one provider message.
 *
 * Provider-supplied internal File IDs and unknown attachment properties are intentionally omitted.
 *
 * @param value - Untrusted adapter result.
 * @returns Exact provider-neutral message.
 */
export function normalizeChatProviderMessage(
  value: unknown,
  permalinkHosts: readonly string[] = [],
): ExternalChatMessage {
  const record = requireRecord(value, 'message', 'ChatProviderInvalidResponse')
  const availability = readAvailability(record.availability, 'ChatProviderInvalidResponse')
  const state = readMessageState(record.state)
  const rawQuotes = requireBoundedArray(
    record.quotedRanges,
    'message quoted ranges',
    MAX_MESSAGE_QUOTES,
    'ChatProviderInvalidResponse',
  )
  const rawAttachments = requireBoundedArray(
    record.attachments,
    'message attachments',
    MAX_MESSAGE_ATTACHMENTS,
    'ChatProviderInvalidResponse',
  )
  const restrictive = mustOmitSourceContent(availability, state) || state === 'deleted'
  if (
    restrictive &&
    (record.permalink !== undefined || record.actor !== undefined ||
      record.bodyMarkdown !== undefined || rawQuotes.length > 0 || rawAttachments.length > 0)
  ) {
    invalidResponse('A redacted provider message contains restricted source content.')
  }
  if (
    state === 'retained-metadata' &&
    (record.bodyMarkdown !== undefined || rawQuotes.length > 0)
  ) {
    invalidResponse('A retained-metadata provider message contains message body content.')
  }
  const permalink = readOptionalHttpsPermalink(
    record.permalink,
    'message permalink',
    'ChatProviderInvalidResponse',
  )
  if (availability === 'available' && state === 'active' && !permalink) {
    invalidResponse('An available provider message requires an HTTPS permalink.')
  }
  const actor = normalizeOptionalActor(record.actor)
  const bodyMarkdown = readOptionalMarkdown(record.bodyMarkdown)
  const quotedRanges = rawQuotes.map(normalizeQuotedRange)
  const attachments: ExternalChatAttachment[] = []
  for (const attachmentValue of rawAttachments) {
    const attachment = normalizeAttachment(attachmentValue)
    if (attachment) attachments.push(attachment)
  }
  const deletedAt = readOptionalTimestamp(
    record.deletedAt,
    'message deletion timestamp',
    'ChatProviderInvalidResponse',
  )
  if (state === 'deleted' && !deletedAt) {
    invalidResponse('A deleted provider message requires a canonical deletion timestamp.')
  }
  if (state === 'active' && deletedAt !== undefined) {
    invalidResponse('An active provider message must not contain a deletion timestamp.')
  }
  const parentMessageExternalId = readOptionalBoundedText(
    record.parentMessageExternalId,
    'external parent message ID',
    MAX_IDENTIFIER_BYTES,
    'ChatProviderInvalidResponse',
  )
  const editedAt = readOptionalTimestamp(
    record.editedAt,
    'message edit timestamp',
    'ChatProviderInvalidResponse',
  )
  const normalized: ExternalChatMessage = {
    externalId: readIdentifier(
      record.externalId,
      'external message ID',
      'ChatProviderInvalidResponse',
    ),
    externalVersion: readBoundedText(
      record.externalVersion,
      'external message version',
      MAX_PROVIDER_VERSION_BYTES,
      'ChatProviderInvalidResponse',
    ),
    conversationExternalId: readIdentifier(
      record.conversationExternalId,
      'external conversation ID',
      'ChatProviderInvalidResponse',
    ),
    threadExternalId: readIdentifier(
      record.threadExternalId,
      'external thread ID',
      'ChatProviderInvalidResponse',
    ),
    ...(parentMessageExternalId === undefined ? {} : { parentMessageExternalId }),
    ...(permalink === undefined ? {} : { permalink }),
    availability,
    state,
    ...(actor === undefined ? {} : { actor }),
    ...(bodyMarkdown === undefined ? {} : { bodyMarkdown }),
    quotedRanges,
    attachments,
    postedAt: readTimestamp(
      record.postedAt,
      'message post timestamp',
      'ChatProviderInvalidResponse',
    ),
    updatedAt: readTimestamp(
      record.updatedAt,
      'message update timestamp',
      'ChatProviderInvalidResponse',
    ),
    ...(editedAt === undefined ? {} : { editedAt }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  }
  return requireProviderOwnedPermalinks(
    normalized,
    permalinkHosts,
    'ChatProviderInvalidResponse',
  )
}

/**
 * Deeply validates and allowlists a provider thread completion result.
 *
 * @param value - Untrusted adapter result.
 * @returns Exact provider-neutral lifecycle mutation result.
 */
export function normalizeChatProviderThreadMutationResult(
  value: unknown,
): ChatProviderThreadMutationResult {
  const record = requireRecord(value, 'thread mutation result', 'ChatProviderInvalidResponse')
  return {
    externalVersion: readBoundedText(
      record.externalVersion,
      'external thread version',
      MAX_PROVIDER_VERSION_BYTES,
      'ChatProviderInvalidResponse',
    ),
    completed: readBoolean(
      record.completed,
      'thread completion state',
      'ChatProviderInvalidResponse',
    ),
    occurredAt: readTimestamp(
      record.occurredAt,
      'thread mutation timestamp',
      'ChatProviderInvalidResponse',
    ),
  }
}

/**
 * Normalizes one inbound event using the requested boundary error classification.
 *
 * @param value - Candidate event.
 * @param code - Error code used by the calling boundary.
 * @returns Exact normalized event.
 */
function normalizeInboundEventWithCode(
  value: unknown,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): ExternalChatInboundEvent {
  const record = requireRecord(value, 'provider event', code)
  if (record.schemaVersion !== EXTERNAL_CHAT_SCHEMA_VERSION) {
    invalidAdapterValue(code, 'The provider event schema version is invalid.')
  }
  const type = readEventType(record.type, code)
  const eventId = readIdentifier(record.eventId, 'provider event ID', code)
  const correlationId = readIdentifier(record.correlationId, 'correlation ID', code)
  const installationId = readIdentifier(record.installationId, 'installation ID', code)
  const provider = readProvider(record.provider, code)
  const externalWorkspaceId = readIdentifier(
    record.externalWorkspaceId,
    'external Workspace ID',
    code,
  )
  const conversationExternalId = readIdentifier(
    record.conversationExternalId,
    'external conversation ID',
    code,
  )
  const threadExternalId = readIdentifier(
    record.threadExternalId,
    'external thread ID',
    code,
  )
  const occurredAt = readTimestamp(record.occurredAt, 'provider event timestamp', code)
  const externalSequence = readOptionalBoundedText(
    record.externalSequence,
    'provider ordering token',
    MAX_PROVIDER_VERSION_BYTES,
    code,
  )
  const originOperationId = readOptionalBoundedText(
    record.originOperationId,
    'origin operation ID',
    MAX_IDENTIFIER_BYTES,
    code,
  )
  const base = {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    eventId,
    correlationId,
    installationId,
    provider,
    externalWorkspaceId,
    conversationExternalId,
    threadExternalId,
    occurredAt,
    ...(externalSequence === undefined ? {} : { externalSequence }),
    ...(originOperationId === undefined ? {} : { originOperationId }),
  }
  if (type === 'message.created') {
    const message = normalizeChatProviderMessage(record.message)
    return { ...base, schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION, type, message }
  }
  if (type === 'message.edited') {
    const message = normalizeChatProviderMessage(record.message)
    return { ...base, schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION, type, message }
  }
  if (type === 'message.deleted') {
    const sourcePermalink = readOptionalHttpsPermalink(
      record.sourcePermalink,
      'deleted message source permalink',
      code,
    )
    return {
      ...base,
      schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
      type,
      externalMessageId: readIdentifier(record.externalMessageId, 'external message ID', code),
      externalVersion: readBoundedText(
        record.externalVersion,
        'external message version',
        MAX_PROVIDER_VERSION_BYTES,
        code,
      ),
      ...(sourcePermalink === undefined ? {} : { sourcePermalink }),
      deletedAt: readTimestamp(record.deletedAt, 'message deletion timestamp', code),
    }
  }
  if (type === 'thread.completed') {
    const sourcePermalink = readOptionalHttpsPermalink(
      record.sourcePermalink,
      'completed thread source permalink',
      code,
    )
    return {
      ...base,
      schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
      type,
      externalVersion: readBoundedText(
        record.externalVersion,
        'external thread version',
        MAX_PROVIDER_VERSION_BYTES,
        code,
      ),
      ...(sourcePermalink === undefined ? {} : { sourcePermalink }),
      completedAt: readTimestamp(record.completedAt, 'thread completion timestamp', code),
    }
  }
  if (type === 'thread.reopened') {
    const sourcePermalink = readOptionalHttpsPermalink(
      record.sourcePermalink,
      'reopened thread source permalink',
      code,
    )
    return {
      ...base,
      schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
      type,
      externalVersion: readBoundedText(
        record.externalVersion,
        'external thread version',
        MAX_PROVIDER_VERSION_BYTES,
        code,
      ),
      ...(sourcePermalink === undefined ? {} : { sourcePermalink }),
      reopenedAt: readTimestamp(record.reopenedAt, 'thread reopen timestamp', code),
    }
  }
  const resourceType = readResourceType(record.resourceType, code)
  const availability = readAvailability(record.availability, code)
  const state = readSourceState(record.state, code)
  if (state === 'completed' && resourceType !== 'thread') {
    invalidAdapterValue(code, 'Only a thread lifecycle resource may be completed.')
  }
  const sourcePermalink = readOptionalHttpsPermalink(
    record.sourcePermalink,
    'lifecycle source permalink',
    code,
  )
  if (
    (mustOmitSourceContent(availability, state) || state === 'deleted') &&
    sourcePermalink !== undefined
  ) {
    invalidAdapterValue(code, 'A restrictive source lifecycle event contains a permalink.')
  }
  return {
    ...base,
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    type,
    resourceType,
    resourceExternalId: readIdentifier(
      record.resourceExternalId,
      'external lifecycle resource ID',
      code,
    ),
    availability,
    state,
    reasonCode: readBoundedText(
      record.reasonCode,
      'source lifecycle reason code',
      MAX_DISPLAY_TEXT_BYTES,
      code,
    ),
    ...(sourcePermalink === undefined ? {} : { sourcePermalink }),
  }
}

/**
 * Normalizes provider workspace metadata without forwarding unknown fields.
 *
 * @param value - Candidate workspace.
 * @returns Exact workspace metadata.
 */
function normalizeWorkspace(value: unknown): ExternalChatWorkspace {
  const record = requireRecord(value, 'provider Workspace', 'ChatProviderInvalidResponse')
  const displayName = readOptionalBoundedText(
    record.displayName,
    'provider Workspace display name',
    MAX_DISPLAY_TEXT_BYTES,
    'ChatProviderInvalidResponse',
  )
  const permalink = readOptionalHttpsPermalink(
    record.permalink,
    'provider Workspace permalink',
    'ChatProviderInvalidResponse',
  )
  return {
    provider: readProvider(record.provider, 'ChatProviderInvalidResponse'),
    externalId: readIdentifier(
      record.externalId,
      'external Workspace ID',
      'ChatProviderInvalidResponse',
    ),
    ...(displayName === undefined ? {} : { displayName }),
    ...(permalink === undefined ? {} : { permalink }),
  }
}

/**
 * Normalizes provider conversation metadata without forwarding unknown fields.
 *
 * @param value - Candidate conversation.
 * @returns Exact conversation metadata.
 */
function normalizeConversation(value: unknown): ExternalChatConversation {
  const record = requireRecord(value, 'provider conversation', 'ChatProviderInvalidResponse')
  const displayName = readOptionalBoundedText(
    record.displayName,
    'provider conversation display name',
    MAX_DISPLAY_TEXT_BYTES,
    'ChatProviderInvalidResponse',
  )
  const permalink = readOptionalHttpsPermalink(
    record.permalink,
    'provider conversation permalink',
    'ChatProviderInvalidResponse',
  )
  return {
    externalId: readIdentifier(
      record.externalId,
      'external conversation ID',
      'ChatProviderInvalidResponse',
    ),
    externalWorkspaceId: readIdentifier(
      record.externalWorkspaceId,
      'external Workspace ID',
      'ChatProviderInvalidResponse',
    ),
    kind: readConversationKind(record.kind),
    ...(displayName === undefined ? {} : { displayName }),
    ...(permalink === undefined ? {} : { permalink }),
  }
}

/**
 * Normalizes an optional provider actor without forwarding profile fields.
 *
 * @param value - Candidate actor.
 * @returns Exact actor metadata or no actor.
 */
function normalizeOptionalActor(value: unknown): ExternalChatActor | undefined {
  if (value === undefined) return undefined
  const record = requireRecord(value, 'provider actor', 'ChatProviderInvalidResponse')
  const displayName = readOptionalBoundedText(
    record.displayName,
    'provider actor display name',
    MAX_DISPLAY_TEXT_BYTES,
    'ChatProviderInvalidResponse',
  )
  return {
    externalId: readIdentifier(
      record.externalId,
      'external actor ID',
      'ChatProviderInvalidResponse',
    ),
    kind: readActorKind(record.kind),
    ...(displayName === undefined ? {} : { displayName }),
  }
}

/**
 * Normalizes one quoted range and verifies its UTF-16 bounds.
 *
 * @param value - Candidate quoted range.
 * @returns Exact quoted range.
 */
function normalizeQuotedRange(value: unknown): ExternalChatQuotedRange {
  const record = requireRecord(value, 'quoted range', 'ChatProviderInvalidResponse')
  const startOffset = readNonNegativeInteger(
    record.startOffset,
    'quote start offset',
    'ChatProviderInvalidResponse',
  )
  const endOffset = readNonNegativeInteger(
    record.endOffset,
    'quote end offset',
    'ChatProviderInvalidResponse',
  )
  const text = readBoundedText(
    record.text,
    'quoted text',
    MAX_QUOTED_TEXT_BYTES,
    'ChatProviderInvalidResponse',
  )
  if (endOffset <= startOffset || text.length !== endOffset - startOffset) {
    invalidResponse('The provider returned an invalid quoted text range.')
  }
  return {
    sourceMessageExternalId: readIdentifier(
      record.sourceMessageExternalId,
      'quoted source message ID',
      'ChatProviderInvalidResponse',
    ),
    startOffset,
    endOffset,
    text,
  }
}

/**
 * Normalizes one attachment and omits entries whose metadata is no longer permitted.
 *
 * @param value - Candidate provider attachment.
 * @returns Exact safe attachment metadata or undefined for a redacted attachment.
 */
function normalizeAttachment(value: unknown): ExternalChatAttachment | undefined {
  const record = requireRecord(value, 'provider attachment', 'ChatProviderInvalidResponse')
  const externalId = readIdentifier(
    record.externalId,
    'external attachment ID',
    'ChatProviderInvalidResponse',
  )
  const availability = readAvailability(record.availability, 'ChatProviderInvalidResponse')
  const state = readAttachmentState(record.state)
  if (mustOmitSourceContent(availability, state)) return undefined
  const contentType = readOptionalBoundedText(
    record.contentType,
    'attachment media type',
    MAX_DISPLAY_TEXT_BYTES,
    'ChatProviderInvalidResponse',
  )
  const sizeBytes = readOptionalNonNegativeInteger(
    record.sizeBytes,
    'attachment byte size',
    'ChatProviderInvalidResponse',
  )
  const permalink = readOptionalHttpsPermalink(
    record.permalink,
    'attachment permalink',
    'ChatProviderInvalidResponse',
  )
  const createdAt = readOptionalTimestamp(
    record.createdAt,
    'attachment creation timestamp',
    'ChatProviderInvalidResponse',
  )
  const deletedAt = readOptionalTimestamp(
    record.deletedAt,
    'attachment deletion timestamp',
    'ChatProviderInvalidResponse',
  )
  if (state === 'deleted' && !deletedAt) {
    invalidResponse('A deleted provider attachment requires a deletion timestamp.')
  }
  if (state === 'active' && deletedAt !== undefined) {
    invalidResponse('An active provider attachment must not contain a deletion timestamp.')
  }
  return {
    externalId,
    fileName: readBoundedText(
      record.fileName,
      'attachment file name',
      MAX_DISPLAY_TEXT_BYTES,
      'ChatProviderInvalidResponse',
    ),
    ...(contentType === undefined ? {} : { contentType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(permalink === undefined ? {} : { permalink }),
    availability,
    state,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  }
}

/**
 * Normalizes optional webhook origin markers into an exact own-property record.
 *
 * @param value - Candidate marker map.
 * @returns Exact marker map or undefined.
 */
function normalizeOriginMarkers(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const record = requireRecord(value, 'origin marker map', 'ChatProviderInvalidWebhook')
  const entries = Object.entries(record)
  if (entries.length > MAX_WEBHOOK_EVENTS) {
    invalidAdapterValue('ChatProviderInvalidWebhook', 'The webhook contains too many origin markers.')
  }
  const normalized: Array<[string, string]> = []
  for (const [eventIdValue, markerValue] of entries) {
    const eventId = readIdentifier(eventIdValue, 'origin marker event ID', 'ChatProviderInvalidWebhook')
    const marker = readBoundedText(
      markerValue,
      'origin marker',
      MAX_ORIGIN_MARKER_BYTES,
      'ChatProviderInvalidWebhook',
    )
    normalized.push([eventId, marker])
  }
  return Object.fromEntries(normalized)
}

/**
 * Reads a supported provider event discriminator.
 *
 * @param value - Candidate discriminator.
 * @param code - Boundary error classification.
 * @returns Supported discriminator.
 */
function readEventType(
  value: unknown,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): ExternalChatInboundEvent['type'] {
  if (
    value === 'message.created' || value === 'message.edited' ||
    value === 'message.deleted' || value === 'thread.completed' ||
    value === 'thread.reopened' || value === 'source.lifecycle-changed'
  ) return value
  invalidAdapterValue(code, 'The provider event type is unsupported.')
}

/**
 * Reads a supported provider identifier.
 *
 * @param value - Candidate provider.
 * @param code - Boundary error classification.
 * @returns Supported chat provider.
 */
function readProvider(
  value: unknown,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): ExternalChatProvider {
  if (value === 'slack' || value === 'microsoft-teams') return value
  invalidAdapterValue(code, 'The provider returned an unsupported chat provider.')
}

/**
 * Reads a supported conversation kind.
 *
 * @param value - Candidate conversation kind.
 * @returns Supported conversation kind.
 */
function readConversationKind(value: unknown): ExternalChatConversation['kind'] {
  if (
    value === 'channel' || value === 'group' || value === 'direct' ||
    value === 'meeting' || value === 'unknown'
  ) return value
  invalidResponse('The provider returned an invalid conversation kind.')
}

/**
 * Reads a supported provider actor kind.
 *
 * @param value - Candidate actor kind.
 * @returns Supported actor kind.
 */
function readActorKind(value: unknown): ExternalChatActor['kind'] {
  if (value === 'person' || value === 'bot' || value === 'application' || value === 'unknown') {
    return value
  }
  invalidResponse('The provider returned an invalid actor kind.')
}

/**
 * Reads a supported message lifecycle state.
 *
 * @param value - Candidate state.
 * @returns Supported message state.
 */
function readMessageState(value: unknown): ExternalChatMessage['state'] {
  if (
    value === 'active' || value === 'deleted' ||
    value === 'retained-metadata' || value === 'retention-expired'
  ) return value
  invalidResponse('The provider returned an invalid message lifecycle state.')
}

/**
 * Reads a supported attachment lifecycle state.
 *
 * @param value - Candidate state.
 * @returns Supported attachment state.
 */
function readAttachmentState(value: unknown): ExternalChatAttachment['state'] {
  if (
    value === 'active' || value === 'deleted' ||
    value === 'retained-metadata' || value === 'retention-expired'
  ) return value
  invalidResponse('The provider returned an invalid attachment lifecycle state.')
}

/**
 * Reads a supported source availability.
 *
 * @param value - Candidate availability.
 * @param code - Boundary error classification.
 * @returns Supported availability.
 */
function readAvailability(
  value: unknown,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): ExternalChatSourceAvailability {
  if (
    value === 'available' || value === 'temporarily-unavailable' ||
    value === 'installation-disconnected' || value === 'needs-reauth' ||
    value === 'scope-changed' || value === 'permission-lost'
  ) return value
  invalidAdapterValue(code, 'The provider returned an invalid source availability.')
}

/**
 * Reads a supported source lifecycle state.
 *
 * @param value - Candidate state.
 * @param code - Boundary error classification.
 * @returns Supported source state.
 */
function readSourceState(
  value: unknown,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): ExternalChatSourceState {
  if (
    value === 'active' || value === 'completed' || value === 'deleted' ||
    value === 'retained-metadata' || value === 'retention-expired'
  ) return value
  invalidAdapterValue(code, 'The provider returned an invalid source lifecycle state.')
}

/**
 * Reads a supported lifecycle resource kind.
 *
 * @param value - Candidate resource kind.
 * @param code - Boundary error classification.
 * @returns Supported resource kind.
 */
function readResourceType(
  value: unknown,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): Extract<ExternalChatInboundEvent, { type: 'source.lifecycle-changed' }>['resourceType'] {
  if (
    value === 'workspace' || value === 'conversation' || value === 'thread' ||
    value === 'message' || value === 'attachment'
  ) return value
  invalidAdapterValue(code, 'The provider returned an invalid lifecycle resource type.')
}

/**
 * Checks whether source content must be absent from an adapter result.
 *
 * @param availability - Current source reachability.
 * @param state - Current source lifecycle state.
 * @returns Whether content and navigation metadata must be omitted.
 */
function mustOmitSourceContent(
  availability: ExternalChatSourceAvailability,
  state: ExternalChatSourceState,
): boolean {
  return availability === 'permission-lost' || availability === 'scope-changed' ||
    state === 'retention-expired'
}

/**
 * Reads an exact non-array record.
 *
 * @param value - Candidate record.
 * @param label - Safe diagnostic label.
 * @param code - Boundary error classification.
 * @returns Narrowed record.
 */
function requireRecord(
  value: unknown,
  label: string,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
  }
  return value
}

/**
 * Narrows an unknown value to a non-array string-keyed record.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a record.
 */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads one bounded nonempty identifier.
 *
 * @param value - Candidate identifier.
 * @param label - Safe diagnostic label.
 * @param code - Boundary error classification.
 * @returns Valid identifier.
 */
function readIdentifier(
  value: unknown,
  label: string,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): string {
  return readBoundedText(value, label, MAX_IDENTIFIER_BYTES, code)
}

/**
 * Reads one bounded nonempty string without control characters.
 *
 * @param value - Candidate text.
 * @param label - Safe diagnostic label.
 * @param maximumBytes - Maximum UTF-8 byte length.
 * @param code - Boundary error classification.
 * @returns Valid text.
 */
function readBoundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    /\p{Cc}/u.test(value) || Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
  }
  return value
}

/**
 * Reads one optional bounded nonempty string.
 *
 * @param value - Candidate text.
 * @param label - Safe diagnostic label.
 * @param maximumBytes - Maximum UTF-8 byte length.
 * @param code - Boundary error classification.
 * @returns Valid text or undefined.
 */
function readOptionalBoundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): string | undefined {
  return value === undefined ? undefined : readBoundedText(value, label, maximumBytes, code)
}

/**
 * Reads bounded Markdown while permitting newlines, tabs, and an empty attachment-only body.
 *
 * @param value - Candidate Markdown.
 * @returns Valid Markdown or undefined.
 */
function readOptionalMarkdown(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_MARKDOWN_BYTES ||
    containsDisallowedMarkdownControl(value)
  ) invalidResponse('The provider returned an invalid or unbounded message body.')
  return value
}

/**
 * Detects control characters other than Markdown-safe tab and newline separators.
 *
 * @param value - Candidate Markdown text.
 * @returns Whether the text contains a disallowed control code unit.
 */
function containsDisallowedMarkdownControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if ((codeUnit < 32 && codeUnit !== 9 && codeUnit !== 10 && codeUnit !== 13) ||
      codeUnit === 127) return true
  }
  return false
}

/**
 * Reads one canonical millisecond-precision UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @param label - Safe diagnostic label.
 * @param code - Boundary error classification.
 * @returns Canonical timestamp.
 */
function readTimestamp(
  value: unknown,
  label: string,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): string {
  if (typeof value !== 'string') {
    invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
  }
  return value
}

/**
 * Reads one optional canonical timestamp.
 *
 * @param value - Candidate timestamp.
 * @param label - Safe diagnostic label.
 * @param code - Boundary error classification.
 * @returns Canonical timestamp or undefined.
 */
function readOptionalTimestamp(
  value: unknown,
  label: string,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): string | undefined {
  return value === undefined ? undefined : readTimestamp(value, label, code)
}

/**
 * Reads one optional credential-free HTTPS permalink.
 *
 * @param value - Candidate URL.
 * @param label - Safe diagnostic label.
 * @param code - Boundary error classification.
 * @returns Safe URL or undefined.
 */
function readOptionalHttpsPermalink(
  value: unknown,
  label: string,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_PERMALINK_BYTES) {
    invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
  }
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' || url.hostname.length === 0 ||
      url.username.length > 0 || url.password.length > 0 ||
      url.port.length > 0 || url.hash.length > 0 ||
      isLocalOrIpHost(url.hostname) ||
      [...url.searchParams.keys()].some(isSensitivePermalinkQueryKey)
    ) invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
    return value
  } catch {
    invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
  }
}

/**
 * Requires every allowlisted permalink field to use one adapter-declared provider host.
 *
 * @param value - Exact normalized DTO tree.
 * @param permalinkHosts - Canonical provider-owned host suffixes declared by the adapter.
 * @param code - Boundary error classification.
 * @returns The unchanged exact DTO after recursive URL ownership validation.
 */
function requireProviderOwnedPermalinks<T>(
  value: T,
  permalinkHosts: readonly string[],
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): T {
  if (permalinkHosts.length === 0) return value
  visitProviderPermalinks(value, permalinkHosts, code)
  return value
}

/**
 * Recursively inspects only known normalized DTO properties for durable permalink fields.
 *
 * @param value - Current exact normalized DTO node.
 * @param permalinkHosts - Adapter-declared provider-owned host suffixes.
 * @param code - Boundary error classification.
 */
function visitProviderPermalinks(
  value: unknown,
  permalinkHosts: readonly string[],
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): void {
  if (Array.isArray(value)) {
    for (const item of value) visitProviderPermalinks(item, permalinkHosts, code)
    return
  }
  if (!isUnknownRecord(value)) return
  for (const [property, nested] of Object.entries(value)) {
    if (property === 'permalink' || property === 'sourcePermalink') {
      if (typeof nested !== 'string' || !isAllowedPermalinkHost(nested, permalinkHosts)) {
        invalidAdapterValue(code, 'The provider returned a permalink outside its declared hosts.')
      }
      continue
    }
    visitProviderPermalinks(nested, permalinkHosts, code)
  }
}

/**
 * Checks one stable permalink against exact or subdomain host ownership.
 *
 * @param value - Previously validated credential-free HTTPS permalink.
 * @param permalinkHosts - Canonical provider-owned host suffixes.
 * @returns Whether the parsed host belongs to the adapter declaration.
 */
function isAllowedPermalinkHost(value: string, permalinkHosts: readonly string[]): boolean {
  const hostname = new URL(value).hostname.toLowerCase()
  return permalinkHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

/**
 * Rejects local, loopback, and numeric network destinations from durable navigation metadata.
 *
 * @param hostname - URL hostname returned by the platform parser.
 * @returns Whether the hostname is local or an IP literal.
 */
function isLocalOrIpHost(hostname: string): boolean {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  return unwrapped === 'localhost' ||
    unwrapped.endsWith('.localhost') ||
    isIP(unwrapped) !== 0
}

/**
 * Detects credential-bearing query parameter names that must never be retained as permalinks.
 *
 * @param key - Decoded query parameter name.
 * @returns Whether the parameter commonly carries a bearer credential or temporary signature.
 */
function isSensitivePermalinkQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
  return normalized === 'token' ||
    normalized === 'accesstoken' ||
    normalized === 'refreshtoken' ||
    normalized === 'signature' ||
    normalized === 'sig' ||
    normalized === 'secret' ||
    normalized === 'password' ||
    normalized === 'credential' ||
    normalized === 'authorization' ||
    normalized === 'auth' ||
    normalized === 'code' ||
    normalized === 'apikey' ||
    normalized === 'accesskey' ||
    normalized === 'sas'
}

/**
 * Reads one boolean.
 *
 * @param value - Candidate boolean.
 * @param label - Safe diagnostic label.
 * @param code - Boundary error classification.
 * @returns Valid boolean.
 */
function readBoolean(
  value: unknown,
  label: string,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): boolean {
  if (typeof value !== 'boolean') {
    invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
  }
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate number.
 * @param label - Safe diagnostic label.
 * @param code - Boundary error classification.
 * @returns Valid integer.
 */
function readNonNegativeInteger(
  value: unknown,
  label: string,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidAdapterValue(code, `The provider returned an invalid ${label}.`)
  }
  return value
}

/**
 * Reads one optional nonnegative safe integer.
 *
 * @param value - Candidate number.
 * @param label - Safe diagnostic label.
 * @param code - Boundary error classification.
 * @returns Valid integer or undefined.
 */
function readOptionalNonNegativeInteger(
  value: unknown,
  label: string,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): number | undefined {
  return value === undefined ? undefined : readNonNegativeInteger(value, label, code)
}

/**
 * Reads one bounded array.
 *
 * @param value - Candidate array.
 * @param label - Safe diagnostic label.
 * @param maximumLength - Maximum accepted item count.
 * @param code - Boundary error classification.
 * @returns Valid array.
 */
function requireBoundedArray(
  value: unknown,
  label: string,
  maximumLength: number,
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    invalidAdapterValue(code, `The provider returned an invalid or unbounded ${label}.`)
  }
  return value
}

/**
 * Raises a provider response validation error.
 *
 * @param message - Secret-free diagnostic message.
 * @returns Never returns.
 */
function invalidResponse(message: string): never {
  return invalidAdapterValue('ChatProviderInvalidResponse', message)
}

/**
 * Raises a classified provider adapter boundary error.
 *
 * @param code - Stable boundary classification.
 * @param message - Secret-free diagnostic message.
 * @returns Never returns.
 */
function invalidAdapterValue(
  code: 'ChatProviderInvalidWebhook' | 'ChatProviderInvalidResponse',
  message: string,
): never {
  throw new ChatProviderAdapterError(code, message)
}
