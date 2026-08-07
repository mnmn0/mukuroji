import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  ExternalChatInboundEvent,
  ExternalChatMessage,
  ExternalChatProvider,
  ExternalChatThreadReference,
  ExternalChatThreadSnapshot,
} from '@mukuroji/contracts'

/** Maximum raw webhook payload accepted by the provider adapter boundary. */
export const CHAT_PROVIDER_WEBHOOK_MAX_BYTES = 1_048_576

/** Maximum aggregate UTF-8 bytes accepted for normalized webhook header names and values. */
export const CHAT_PROVIDER_WEBHOOK_MAX_HEADER_BYTES = 65_536

const CHAT_PROVIDER_WEBHOOK_MAX_HEADERS = 100
const CHAT_PROVIDER_WEBHOOK_MAX_HEADER_NAME_BYTES = 256

/** Stable provider adapter error categories understood by the synchronization runtime. */
export type ChatProviderAdapterErrorCode =
  | 'ChatProviderInvalidWebhook'
  | 'ChatProviderReplayRejected'
  | 'ChatProviderScopeMismatch'
  | 'ChatProviderPermissionDenied'
  | 'ChatProviderReauthorizationRequired'
  | 'ChatProviderDisconnected'
  | 'ChatProviderSourceNotFound'
  | 'ChatProviderRateLimited'
  | 'ChatProviderUnsupportedOperation'
  | 'ChatProviderTransientFailure'
  | 'ChatProviderInvalidResponse'
  | 'ChatProviderAdapterUnavailable'
  | 'ChatProviderAdapterDuplicate'
  | 'ChatProviderAdapterDefinitionMismatch'

/** Secret-free error raised by a chat provider adapter. */
export class ChatProviderAdapterError extends Error {
  /** Stable machine-readable error code. */
  readonly code: ChatProviderAdapterErrorCode

  /** Whether retrying the same logical operation can recover. */
  readonly retryable: boolean

  /** Earliest safe retry timestamp for a provider rate limit. */
  readonly retryAt?: string

  /**
   * Creates a classified provider adapter error.
   *
   * @param code - Stable machine-readable error code.
   * @param message - Secret-free diagnostic message.
   * @param options - Retry classification and optional retry timestamp.
   */
  constructor(
    code: ChatProviderAdapterErrorCode,
    message: string,
    options: {
      /** Whether the same logical operation may be retried. */
      retryable?: boolean
      /** Earliest safe retry timestamp. */
      retryAt?: string
    } = {},
  ) {
    super(message)
    this.name = 'ChatProviderAdapterError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.retryAt = options.retryAt
  }
}

/** Provider capabilities that affect honest synchronization behavior. */
export type ChatProviderCapabilities = {
  /** Whether provider messages can be edited after creation. */
  edits: boolean
  /** Whether provider messages can be deleted through the installation. */
  deletion: boolean
  /** Whether the provider exposes a native or connector-defined completion mutation. */
  threadCompletion: boolean
  /** Whether the provider accepts a native client idempotency key for reply creation. */
  nativeIdempotency: boolean
}

/** Immutable metadata advertised by a Slack or Microsoft Teams adapter. */
export type ChatProviderDefinition = {
  /** Provider implemented by the adapter. */
  provider: ExternalChatProvider
  /** Canonical provider-owned hosts accepted for durable navigation permalinks. */
  permalinkHosts: readonly string[]
  /** Provider operations implemented without silently degrading semantics. */
  capabilities: ChatProviderCapabilities
}

/** Installation-scoped authorization supplied to provider operations. */
export type ChatProviderAuthorization = {
  /** Canonical connector installation identifier. */
  installationId: string
  /** Provider workspace or tenant bound to the installation. */
  externalWorkspaceId: string
  /** Current consent or scope generation used to reject stale work. */
  authorizationRevision: number
}

/** Untrusted raw webhook request presented to an adapter. */
export type ChatProviderWebhookRequest = {
  /** Case-normalized request headers without authorization token logging. */
  headers: Readonly<Record<string, string | undefined>>
  /** Exact raw request bytes used for provider signature verification. */
  rawBody: Uint8Array
  /** Server receipt timestamp in ISO 8601 format. */
  receivedAt: string
}

/** Verified normalized result of one provider webhook delivery. */
export type ChatProviderNormalizedWebhook = {
  /** Provider event ID used for retry deduplication. */
  deliveryId: string
  /** Provider events in their verified envelope order. */
  events: ExternalChatInboundEvent[]
  /** Runtime-only signed echo markers keyed by event ID when the provider returned one. */
  originMarkers?: Readonly<Record<string, string>>
}

/** Provider-owned bounded thread page before application cursor wrapping. */
export type ChatProviderThreadPage = {
  /** Permission-filtered provider-neutral thread snapshot. */
  thread: ExternalChatThreadSnapshot
  /** Opaque provider continuation retained only in private synchronization state. */
  providerCursor?: string
}

/** Input used to read a bounded provider thread page. */
export type ReadChatProviderThreadPageInput = {
  /** Installation authorization for the source. */
  authorization: ChatProviderAuthorization
  /** Provider-neutral thread locator. */
  source: ExternalChatThreadReference
  /** Opaque provider continuation from private durable state. */
  providerCursor?: string
  /** Maximum messages to return after provider normalization. */
  limit: number
}

/** Input used to create one provider reply. */
export type CreateChatProviderReplyInput = {
  /** Installation authorization for the source. */
  authorization: ChatProviderAuthorization
  /** Provider-neutral thread locator. */
  source: ExternalChatThreadReference
  /** Normalized Markdown body. */
  bodyMarkdown: string
  /** Stable logical operation identifier used to recover the exact result after response loss. */
  operationId: string
  /** Authenticated marker used to recognize the provider echo. */
  originMarker: string
  /** Cancellation fence that provider transport must propagate to its request. */
  signal: AbortSignal
  /**
   * Revalidates current link/parent authority and any durable retry permit immediately before an
   * irreversible provider request. The adapter must await this guard after request preparation and
   * before provider I/O.
   */
  assertCurrentAuthority: () => Promise<void>
}

/** Input used to edit one provider message. */
export type EditChatProviderMessageInput = {
  /** Installation authorization for the source. */
  authorization: ChatProviderAuthorization
  /** Provider-neutral thread locator. */
  source: ExternalChatThreadReference
  /** Provider-scoped message identifier. */
  externalMessageId: string
  /** Last provider version observed before the edit. */
  expectedExternalVersion?: string
  /** Replacement normalized Markdown body. */
  bodyMarkdown: string
  /** Stable logical operation identifier used to recover the exact result after response loss. */
  operationId: string
  /** Authenticated marker used to recognize the provider echo. */
  originMarker: string
  /** Cancellation fence that provider transport must propagate to its request. */
  signal: AbortSignal
  /**
   * Revalidates current link/parent authority and any durable retry permit immediately before an
   * irreversible provider request. The adapter must await this guard after request preparation and
   * before provider I/O.
   */
  assertCurrentAuthority: () => Promise<void>
}

/** Input used to delete one provider message. */
export type DeleteChatProviderMessageInput = {
  /** Installation authorization for the source. */
  authorization: ChatProviderAuthorization
  /** Provider-neutral thread locator. */
  source: ExternalChatThreadReference
  /** Provider-scoped message identifier. */
  externalMessageId: string
  /** Last provider version observed before deletion. */
  expectedExternalVersion?: string
  /** Stable logical operation identifier used to recover the exact result after response loss. */
  operationId: string
  /** Authenticated marker used to recognize the provider echo. */
  originMarker: string
  /** Cancellation fence that provider transport must propagate to its request. */
  signal: AbortSignal
  /**
   * Revalidates current link/parent authority and any durable retry permit immediately before an
   * irreversible provider request. The adapter must await this guard after request preparation and
   * before provider I/O.
   */
  assertCurrentAuthority: () => Promise<void>
}

/** Input used to complete or reopen one provider thread. */
export type SetChatProviderThreadCompletionInput = {
  /** Installation authorization for the source. */
  authorization: ChatProviderAuthorization
  /** Provider-neutral thread locator. */
  source: ExternalChatThreadReference
  /** Requested provider-neutral completion state. */
  completed: boolean
  /** Stable logical operation identifier used to recover the exact result after response loss. */
  operationId: string
  /** Authenticated marker used to recognize the provider echo. */
  originMarker: string
  /** Cancellation fence that provider transport must propagate to its request. */
  signal: AbortSignal
  /**
   * Revalidates current link/parent authority and any durable retry permit immediately before an
   * irreversible provider request. The adapter must await this guard after request preparation and
   * before provider I/O.
   */
  assertCurrentAuthority: () => Promise<void>
}

/** Provider result for a thread completion or reopen mutation. */
export type ChatProviderThreadMutationResult = {
  /** Provider revision for the resulting thread state. */
  externalVersion: string
  /** Resulting completion state. */
  completed: boolean
  /** Provider occurrence timestamp. */
  occurredAt: string
}

/** Slack or Microsoft Teams adapter boundary used by the chat synchronization runtime. */
export interface ChatProviderAdapter {
  /** Immutable provider and capability metadata. */
  readonly definition: ChatProviderDefinition
  /**
   * Verifies and normalizes one raw provider webhook without returning raw payload data.
   *
   * Implementations must call `validateChatProviderWebhookRequest` before provider-specific parsing.
   */
  normalizeWebhook(
    request: ChatProviderWebhookRequest,
    authorization: ChatProviderAuthorization,
  ): Promise<ChatProviderNormalizedWebhook>
  /** Resolves and permission-filters one thread source before linking. */
  resolveThread(
    authorization: ChatProviderAuthorization,
    source: ExternalChatThreadReference,
  ): Promise<ExternalChatThreadSnapshot>
  /** Reads one bounded thread page and a private provider continuation. */
  readThreadPage(input: ReadChatProviderThreadPageInput): Promise<ChatProviderThreadPage>
  /** Creates or recovers one reply after awaiting its authority guard at provider-I/O time. */
  createReply(input: CreateChatProviderReplyInput): Promise<ExternalChatMessage>
  /** Applies or reconciles one edit after awaiting its authority guard at provider-I/O time. */
  editMessage(input: EditChatProviderMessageInput): Promise<ExternalChatMessage>
  /** Applies or reconciles one deletion after awaiting its authority guard at provider-I/O time. */
  deleteMessage(input: DeleteChatProviderMessageInput): Promise<ExternalChatMessage>
  /** Applies or reconciles completion after awaiting its authority guard at provider-I/O time. */
  setThreadCompletion(
    input: SetChatProviderThreadCompletionInput,
  ): Promise<ChatProviderThreadMutationResult>
}

/** Provider registry that rejects duplicate or mismatched chat adapters. */
export class ChatProviderAdapterRegistry {
  /** Registered adapters by provider. */
  private readonly adapters = new Map<ExternalChatProvider, ChatProviderAdapter>()

  /**
   * Creates a registry from a bounded adapter list.
   *
   * @param adapters - Adapters to register.
   */
  constructor(adapters: readonly ChatProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  /**
   * Registers one provider exactly once.
   *
   * @param adapter - Adapter to register.
   */
  register(adapter: ChatProviderAdapter): void {
    validateChatProviderDefinition(adapter.definition)
    if (this.adapters.has(adapter.definition.provider)) {
      throw new ChatProviderAdapterError(
        'ChatProviderAdapterDuplicate',
        `The ${adapter.definition.provider} chat adapter is already registered.`,
      )
    }
    this.adapters.set(adapter.definition.provider, adapter)
  }

  /**
   * Resolves one configured provider adapter.
   *
   * @param provider - Provider to resolve.
   * @returns Registered provider adapter.
   */
  get(provider: ExternalChatProvider): ChatProviderAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      throw new ChatProviderAdapterError(
        'ChatProviderAdapterUnavailable',
        `The ${provider} chat adapter is not configured.`,
      )
    }
    return adapter
  }
}

/** Provider event action eligible for authenticated outbound echo suppression. */
export type ChatProviderOriginAction =
  | 'message.created'
  | 'message.edited'
  | 'message.deleted'
  | 'thread.completed'
  | 'thread.reopened'

/** Authenticated outbound marker payload restored from a provider echo. */
export type ChatProviderOriginMarker = {
  /** Marker schema version. */
  version: 1
  /** Provider expected to return the marker. */
  provider: ExternalChatProvider
  /** Installation that authorized the outbound operation. */
  installationId: string
  /** External chat link that originated the operation. */
  linkId: string
  /** Stable logical outbound operation identifier. */
  operationId: string
  /** Exact provider event action expected when the operation echoes. */
  action: ChatProviderOriginAction
  /** Marker issue timestamp in ISO 8601 format. */
  issuedAt: string
}

/** Constraints used to authenticate and scope an echoed origin marker. */
export type VerifyChatProviderOriginMarkerInput = {
  /** Provider that returned the marker. */
  provider: ExternalChatProvider
  /** Installation that received the echo. */
  installationId: string
  /** Link expected to own the echoed mutation. */
  linkId: string
  /** Current server timestamp in ISO 8601 format. */
  now: string
  /** Maximum accepted marker age in milliseconds. */
  maxAgeMs: number
}

/**
 * Creates a signed, scoped marker for outbound echo prevention.
 *
 * @param marker - Secret-free marker payload.
 * @param signingSecret - Installation-scoped HMAC secret with at least 32 bytes.
 * @returns URL-safe authenticated marker.
 */
export function createChatProviderOriginMarker(
  marker: ChatProviderOriginMarker,
  signingSecret: string,
): string {
  requireSigningSecret(signingSecret)
  validateOriginMarker(marker)
  const payload = Buffer.from(JSON.stringify(marker)).toString('base64url')
  const signature = createHmac('sha256', signingSecret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

/**
 * Authenticates and scope-checks a provider echo marker.
 *
 * Invalid, expired, or mismatched markers return undefined and never become a loop bypass.
 *
 * @param token - Untrusted marker returned by the provider.
 * @param expected - Expected provider, installation, link, and validity window.
 * @param signingSecret - Installation-scoped HMAC secret with at least 32 bytes.
 * @returns Authenticated marker, or undefined when verification fails.
 */
export function verifyChatProviderOriginMarker(
  token: string,
  expected: VerifyChatProviderOriginMarkerInput,
  signingSecret: string,
): ChatProviderOriginMarker | undefined {
  if (Buffer.byteLength(signingSecret, 'utf8') < 32) return undefined
  const separator = token.indexOf('.')
  if (separator <= 0 || separator !== token.lastIndexOf('.')) return undefined
  const payload = token.slice(0, separator)
  const signatureText = token.slice(separator + 1)
  if (!isBase64Url(payload) || !isBase64Url(signatureText)) return undefined
  const expectedSignature = createHmac('sha256', signingSecret).update(payload).digest()
  const actualSignature = Buffer.from(signatureText, 'base64url')
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return undefined
  }
  const parsed = parseOriginMarker(payload)
  if (!parsed) return undefined
  if (
    parsed.provider !== expected.provider ||
    parsed.installationId !== expected.installationId ||
    parsed.linkId !== expected.linkId
  ) {
    return undefined
  }
  const issuedAt = Date.parse(parsed.issuedAt)
  const now = Date.parse(expected.now)
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(now) ||
    !Number.isSafeInteger(expected.maxAgeMs) ||
    expected.maxAgeMs < 0 ||
    issuedAt > now ||
    now - issuedAt > expected.maxAgeMs
  ) {
    return undefined
  }
  return parsed
}

/**
 * Validates bounded raw webhook transport state before a provider parser runs.
 *
 * @param request - Untrusted webhook transport state.
 */
export function validateChatProviderWebhookRequest(
  request: ChatProviderWebhookRequest,
): void {
  if (
    !(request.rawBody instanceof Uint8Array) ||
    request.rawBody.byteLength === 0 ||
    request.rawBody.byteLength > CHAT_PROVIDER_WEBHOOK_MAX_BYTES
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidWebhook',
      'The chat webhook body size is invalid.',
    )
  }
  if (!isCanonicalTimestamp(request.receivedAt)) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidWebhook',
      'The chat webhook receipt timestamp is invalid.',
    )
  }
  if (!isRecord(request.headers)) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidWebhook',
      'The chat webhook headers are invalid.',
    )
  }
  const headerEntries = Object.entries(request.headers)
  if (headerEntries.length > CHAT_PROVIDER_WEBHOOK_MAX_HEADERS) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidWebhook',
      'The chat webhook contains too many headers.',
    )
  }
  let aggregateBytes = 0
  for (const [name, value] of headerEntries) {
    if (
      Buffer.byteLength(name, 'utf8') > CHAT_PROVIDER_WEBHOOK_MAX_HEADER_NAME_BYTES ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)
    ) {
      throw new ChatProviderAdapterError(
        'ChatProviderInvalidWebhook',
        'The chat webhook contains an invalid header name.',
      )
    }
    if (
      value !== undefined &&
      (typeof value !== 'string' || containsHeaderControlCharacter(value))
    ) {
      throw new ChatProviderAdapterError(
        'ChatProviderInvalidWebhook',
        'The chat webhook contains an invalid header value.',
      )
    }
    aggregateBytes += Buffer.byteLength(name, 'utf8') +
      (value === undefined ? 0 : Buffer.byteLength(value, 'utf8')) +
      4
    if (aggregateBytes > CHAT_PROVIDER_WEBHOOK_MAX_HEADER_BYTES) {
      throw new ChatProviderAdapterError(
        'ChatProviderInvalidWebhook',
        'The chat webhook headers exceed the aggregate size limit.',
      )
    }
  }
}

/**
 * Detects transport control characters that cannot appear in a normalized header value.
 *
 * @param value - Candidate header value.
 * @returns Whether the value contains a C0/C1 control or Unicode line separator.
 */
function containsHeaderControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (
      codeUnit <= 31 ||
      (codeUnit >= 127 && codeUnit <= 159) ||
      codeUnit === 0x2028 ||
      codeUnit === 0x2029
    ) return true
  }
  return false
}

/**
 * Validates adapter metadata without assuming provider-specific optional behavior.
 *
 * @param definition - Adapter metadata to validate.
 * @returns The validated definition.
 */
export function validateChatProviderDefinition(
  definition: ChatProviderDefinition,
): ChatProviderDefinition {
  if (definition.provider !== 'slack' && definition.provider !== 'microsoft-teams') {
    throw new ChatProviderAdapterError(
      'ChatProviderAdapterDefinitionMismatch',
      'Only Slack and Microsoft Teams may register as chat adapters.',
    )
  }
  if (
    !Array.isArray(definition.permalinkHosts) ||
    definition.permalinkHosts.length === 0 ||
    definition.permalinkHosts.length > 32 ||
    new Set(definition.permalinkHosts).size !== definition.permalinkHosts.length ||
    definition.permalinkHosts.some((host) =>
      typeof host !== 'string' ||
      host.length === 0 ||
      host.length > 253 ||
      host !== host.trim() ||
      host !== host.toLowerCase() ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)
    )
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderAdapterDefinitionMismatch',
      'Chat provider permalink hosts must be a bounded unique canonical domain allowlist.',
    )
  }
  const capabilities: unknown = definition.capabilities
  if (!isRecord(capabilities)) {
    throw new ChatProviderAdapterError(
      'ChatProviderAdapterDefinitionMismatch',
      'Chat provider capabilities must be an explicit record.',
    )
  }
  for (const name of ['edits', 'deletion', 'threadCompletion', 'nativeIdempotency'] as const) {
    if (typeof capabilities[name] !== 'boolean') {
      throw new ChatProviderAdapterError(
        'ChatProviderAdapterDefinitionMismatch',
        'Chat provider capabilities must be explicit booleans.',
      )
    }
  }
  return definition
}

/**
 * Parses an authenticated marker payload without trusting JSON.parse output.
 *
 * @param payload - Base64url JSON payload.
 * @returns Valid marker or undefined.
 */
function parseOriginMarker(payload: string): ChatProviderOriginMarker | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return isOriginMarker(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Validates one origin marker before signing.
 *
 * @param marker - Marker to validate.
 */
function validateOriginMarker(marker: ChatProviderOriginMarker): void {
  if (!isOriginMarker(marker)) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'The outbound origin marker is invalid.',
    )
  }
}

/**
 * Narrows an unknown value to a complete origin marker.
 *
 * @param value - Candidate marker value.
 * @returns Whether the candidate is valid.
 */
function isOriginMarker(value: unknown): value is ChatProviderOriginMarker {
  if (!isRecord(value)) return false
  return value.version === 1 &&
    (value.provider === 'slack' || value.provider === 'microsoft-teams') &&
    isBoundedText(value.installationId, 256) &&
    isBoundedText(value.linkId, 256) &&
    isBoundedText(value.operationId, 256) &&
    isOriginAction(value.action) &&
    isCanonicalTimestamp(value.issuedAt)
}

/**
 * Narrows an unknown value to one provider event action that may carry an origin marker.
 *
 * @param value - Candidate action discriminator.
 * @returns Whether the action is supported for authenticated echo suppression.
 */
function isOriginAction(value: unknown): value is ChatProviderOriginAction {
  return value === 'message.created' ||
    value === 'message.edited' ||
    value === 'message.deleted' ||
    value === 'thread.completed' ||
    value === 'thread.reopened'
}

/**
 * Requires a minimum entropy-bearing HMAC secret length.
 *
 * @param signingSecret - Candidate signing secret.
 */
function requireSigningSecret(signingSecret: string): void {
  if (Buffer.byteLength(signingSecret, 'utf8') < 32) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'The chat origin-marker signing secret is too short.',
    )
  }
}

/**
 * Checks canonical millisecond-precision UTC timestamps.
 *
 * @param value - Candidate timestamp.
 * @returns Whether parsing and serialization are lossless.
 */
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

/**
 * Checks a non-empty bounded string.
 *
 * @param value - Candidate string.
 * @param maximumLength - Maximum accepted UTF-16 length.
 * @returns Whether the candidate is accepted.
 */
function isBoundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
}

/**
 * Checks a strict URL-safe base64 token component.
 *
 * @param value - Candidate encoded text.
 * @returns Whether the text uses only the URL-safe base64 alphabet.
 */
function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/u.test(value)
}

/**
 * Narrows a value to a non-null object record.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
