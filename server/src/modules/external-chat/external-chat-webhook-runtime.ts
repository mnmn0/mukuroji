import type {
  ExternalChatProvider,
  ExternalChatSyncOutcome,
} from '@mukuroji/contracts'
import {
  type ChatProviderAuthorization,
  ChatProviderAdapterError,
  type ChatProviderAdapterRegistry,
  type ChatProviderWebhookRequest,
  validateChatProviderWebhookRequest,
} from './chat-provider-adapter'
import { normalizeChatProviderWebhook } from './chat-provider-normalizer'
import type { ExternalChatSyncService } from './external-chat-sync-service'

/** Maximum normalized provider events accepted from one verified webhook envelope. */
export const EXTERNAL_CHAT_WEBHOOK_MAX_EVENTS = 100

/** Verified installation and tenant scope supplied by the webhook transport. */
export type ExternalChatWebhookScope = {
  /** Canonical Workspace identifier resolved from the installation. */
  workspaceId: string
  /** Provider selected by the canonical webhook endpoint. */
  provider: ExternalChatProvider
  /** Current installation authorization used by signature and scope verification. */
  authorization: ChatProviderAuthorization
}

/** Complete input accepted by the provider-neutral webhook runtime. */
export type ProcessExternalChatWebhookInput = {
  /** Verified installation and tenant scope. */
  scope: ExternalChatWebhookScope
  /** Untrusted raw transport state retained for provider signature verification. */
  request: ChatProviderWebhookRequest
}

/** Result of processing every normalized event in one verified provider delivery. */
export type ProcessExternalChatWebhookResult = {
  /** Stable provider delivery identifier. */
  deliveryId: string
  /** Durable outcomes in the provider envelope order. */
  outcomes: ExternalChatSyncOutcome[]
}

/** Dependencies required by the external chat webhook runtime. */
export type ExternalChatWebhookRuntimeDependencies = {
  /** Registered signature-verifying provider adapters. */
  adapters: ChatProviderAdapterRegistry
  /** Provider-neutral synchronization application service. */
  sync: ExternalChatSyncService
}

/** Runtime that verifies raw webhooks before applying their normalized events sequentially. */
export class ExternalChatWebhookRuntime {
  /** Registered provider adapters. */
  private readonly adapters: ChatProviderAdapterRegistry

  /** Provider-neutral synchronization service. */
  private readonly sync: ExternalChatSyncService

  /**
   * Creates an external chat webhook runtime.
   *
   * @param dependencies - Provider registry and synchronization service.
   */
  constructor(dependencies: ExternalChatWebhookRuntimeDependencies) {
    this.adapters = dependencies.adapters
    this.sync = dependencies.sync
  }

  /**
   * Verifies, preflights, and applies one at-least-once provider delivery.
   *
   * The complete envelope is scope-checked before the first side effect. Events then run in
   * provider order; if a later event fails, an upstream retry safely replays earlier receipts.
   *
   * @param input - Canonical installation scope and untrusted raw request.
   * @returns Delivery ID and durable per-event outcomes.
   */
  async process(
    input: ProcessExternalChatWebhookInput,
  ): Promise<ProcessExternalChatWebhookResult> {
    validateScope(input.scope)
    validateChatProviderWebhookRequest(input.request)
    const adapter = this.adapters.get(input.scope.provider)
    const normalized = normalizeChatProviderWebhook(
      await adapter.normalizeWebhook(
        input.request,
        input.scope.authorization,
      ),
      adapter.definition.permalinkHosts,
    )
    requireBoundedIdentifier(normalized.deliveryId, 'provider delivery ID')
    if (
      normalized.events.length === 0 ||
      normalized.events.length > EXTERNAL_CHAT_WEBHOOK_MAX_EVENTS
    ) {
      throw new ChatProviderAdapterError(
        'ChatProviderInvalidWebhook',
        `The verified webhook must contain between 1 and ${EXTERNAL_CHAT_WEBHOOK_MAX_EVENTS} events.`,
      )
    }
    const eventIds = new Set<string>()
    for (const event of normalized.events) {
      if (
        event.provider !== input.scope.provider ||
        event.installationId !== input.scope.authorization.installationId ||
        event.externalWorkspaceId !== input.scope.authorization.externalWorkspaceId
      ) {
        throw scopeMismatchError()
      }
      requireBoundedIdentifier(event.eventId, 'provider event ID')
      if (eventIds.has(event.eventId)) {
        throw new ChatProviderAdapterError(
          'ChatProviderInvalidWebhook',
          'The verified webhook envelope repeats a provider event ID.',
        )
      }
      eventIds.add(event.eventId)
    }
    for (const markerEventId of Object.keys(normalized.originMarkers ?? {})) {
      if (!eventIds.has(markerEventId)) throw scopeMismatchError()
      const marker = normalized.originMarkers?.[markerEventId]
      if (typeof marker !== 'string' || marker.length === 0 || marker.length > 4096) {
        throw new ChatProviderAdapterError(
          'ChatProviderInvalidWebhook',
          'The verified webhook contains an invalid origin marker.',
        )
      }
    }

    const outcomes: ExternalChatSyncOutcome[] = []
    for (const event of normalized.events) {
      const originMarker = ownOriginMarker(normalized.originMarkers, event.eventId)
      outcomes.push(await this.sync.processInbound({
        workspaceId: input.scope.workspaceId,
        event,
        authorizationRevision: input.scope.authorization.authorizationRevision,
        ...(originMarker === undefined ? {} : { originMarker }),
      }))
    }
    return { deliveryId: normalized.deliveryId, outcomes }
  }
}

/**
 * Reads only an own origin-marker property so provider event IDs cannot reach object prototypes.
 *
 * @param originMarkers - Exact normalized marker dictionary.
 * @param eventId - Provider event ID selected by the verified envelope.
 * @returns Own marker value, or undefined when the event has no marker.
 */
function ownOriginMarker(
  originMarkers: Readonly<Record<string, string>> | undefined,
  eventId: string,
): string | undefined {
  if (!originMarkers || !Object.hasOwn(originMarkers, eventId)) return undefined
  const marker = originMarkers[eventId]
  return typeof marker === 'string' ? marker : undefined
}

/**
 * Validates canonical webhook scope before provider dispatch.
 *
 * @param scope - Candidate transport-resolved scope.
 */
function validateScope(scope: ExternalChatWebhookScope): void {
  requireBoundedIdentifier(scope.workspaceId, 'Workspace ID')
  requireBoundedIdentifier(scope.authorization.installationId, 'installation ID')
  requireBoundedIdentifier(scope.authorization.externalWorkspaceId, 'external Workspace ID')
  if (!Number.isSafeInteger(scope.authorization.authorizationRevision) ||
    scope.authorization.authorizationRevision < 1) {
    throw new ChatProviderAdapterError(
      'ChatProviderScopeMismatch',
      'The webhook installation authorization revision is invalid.',
    )
  }
}

/**
 * Requires a non-empty bounded identifier without control characters.
 *
 * @param value - Candidate identifier.
 * @param label - Secret-free field label for diagnostics.
 */
function requireBoundedIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidWebhook',
      `The ${label} is invalid.`,
    )
  }
}

/**
 * Creates a stable provider scope mismatch without exposing tenant identifiers.
 *
 * @returns Classified provider adapter error.
 */
function scopeMismatchError(): ChatProviderAdapterError {
  return new ChatProviderAdapterError(
    'ChatProviderScopeMismatch',
    'The verified webhook does not match its canonical installation scope.',
  )
}
