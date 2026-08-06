import type {
  ConnectorProvider,
  ExternalSyncDirection,
  ExternalSyncStatus,
} from './developer-platform'
import type { CanonicalWorkItem, CreateWorkItemInput } from './work-items'

/**
 * Current schema version for provider-neutral external chat records.
 */
export const EXTERNAL_CHAT_SCHEMA_VERSION = 1

/**
 * Chat providers supported by the external chat synchronization contract.
 */
export type ExternalChatProvider = Extract<
  ConnectorProvider,
  'slack' | 'microsoft-teams'
>

/**
 * Provider-neutral kind of chat conversation.
 */
export type ExternalChatConversationKind =
  | 'channel'
  | 'group'
  | 'direct'
  | 'meeting'
  | 'unknown'

/**
 * Provider-neutral kind of an external chat actor.
 */
export type ExternalChatActorKind = 'person' | 'bot' | 'application' | 'unknown'

/**
 * Current ability to access an external chat source through its installation.
 */
export type ExternalChatSourceAvailability =
  | 'available'
  | 'temporarily-unavailable'
  | 'installation-disconnected'
  | 'needs-reauth'
  | 'scope-changed'
  | 'permission-lost'

/**
 * Last known lifecycle state of an external chat source.
 */
export type ExternalChatSourceState =
  | 'active'
  | 'completed'
  | 'deleted'
  | 'retained-metadata'
  | 'retention-expired'

/**
 * Provider workspace or tenant that owns external chat conversations.
 */
export type ExternalChatWorkspace = {
  /**
   * Provider that owns the workspace identity.
   */
  provider: ExternalChatProvider
  /**
   * Immutable provider-scoped workspace or tenant ID.
   */
  externalId: string
  /**
   * Permission-filtered workspace display name snapshot.
   */
  displayName?: string
  /**
   * HTTPS provider permalink for the workspace when one exists.
   */
  permalink?: string
}

/**
 * Channel, group, direct chat, or meeting conversation within an external workspace.
 */
export type ExternalChatConversation = {
  /**
   * Immutable provider-scoped conversation ID.
   */
  externalId: string
  /**
   * External workspace ID that owns the conversation.
   */
  externalWorkspaceId: string
  /**
   * Provider-neutral conversation kind.
   */
  kind: ExternalChatConversationKind
  /**
   * Permission-filtered conversation display name snapshot.
   */
  displayName?: string
  /**
   * HTTPS provider permalink for the conversation when one exists.
   */
  permalink?: string
}

/**
 * Permission-filtered snapshot of a person, bot, or application that posted externally.
 */
export type ExternalChatActor = {
  /**
   * Immutable provider-scoped actor ID.
   */
  externalId: string
  /**
   * Provider-neutral actor kind.
   */
  kind: ExternalChatActorKind
  /**
   * Display name captured when the message was observed and still permitted.
   */
  displayName?: string
}

/**
 * Selected source text range used to create or link a Work Item.
 */
export type ExternalChatQuotedRange = {
  /**
   * External message ID containing the selected range.
   */
  sourceMessageExternalId: string
  /**
   * Inclusive UTF-16 offset into the normalized message Markdown.
   */
  startOffset: number
  /**
   * Exclusive UTF-16 offset into the normalized message Markdown.
   */
  endOffset: number
  /**
   * Bounded text snapshot retained so the quote remains intelligible after edits.
   */
  text: string
}

/**
 * Provider attachment metadata associated with an external chat message.
 */
export type ExternalChatAttachment = {
  /**
   * Immutable provider-scoped attachment ID.
   */
  externalId: string
  /**
   * Provider-supplied file name after bounded normalization.
   */
  fileName: string
  /**
   * Provider-reported media type when available.
   */
  contentType?: string
  /**
   * Provider-reported byte size when available.
   */
  sizeBytes?: number
  /**
   * Stable HTTPS provider permalink, never a temporary authenticated download URL.
   */
  permalink?: string
  /**
   * Current ability to read attachment metadata or content from the provider.
   */
  availability: ExternalChatSourceAvailability
  /**
   * Last known attachment lifecycle state.
   */
  state: Extract<
    ExternalChatSourceState,
    'active' | 'deleted' | 'retained-metadata' | 'retention-expired'
  >
  /**
   * Internal scanned File ID after an authorized attachment import succeeds.
   */
  importedFileId?: string
  /**
   * Provider timestamp for the attachment when available.
   */
  createdAt?: string
  /**
   * Provider timestamp for an observed attachment deletion when available.
   */
  deletedAt?: string
}

/**
 * Provider-neutral external message snapshot used by synchronization and authorized views.
 */
export type ExternalChatMessage = {
  /**
   * Immutable provider-scoped message ID.
   */
  externalId: string
  /**
   * Provider revision, ETag, sequence, or updated timestamp for this message.
   */
  externalVersion: string
  /**
   * External conversation that contains the message.
   */
  conversationExternalId: string
  /**
   * External thread that contains the message.
   */
  threadExternalId: string
  /**
   * Parent external message ID for a reply when the provider exposes one.
   */
  parentMessageExternalId?: string
  /**
   * Stable HTTPS provider permalink for this exact message while policy permits disclosure.
   */
  permalink?: string
  /**
   * Current ability to read this message through the installation.
   */
  availability: ExternalChatSourceAvailability
  /**
   * Last known message lifecycle state.
   */
  state: Extract<
    ExternalChatSourceState,
    'active' | 'deleted' | 'retained-metadata' | 'retention-expired'
  >
  /**
   * External author snapshot, omitted from a redacted projection when no longer permitted.
   */
  actor?: ExternalChatActor
  /**
   * Bounded normalized Markdown, omitted when permission or retention forbids disclosure.
   */
  bodyMarkdown?: string
  /**
   * Quoted source ranges preserved with this message.
   */
  quotedRanges: ExternalChatQuotedRange[]
  /**
   * Permission-filtered external attachments associated with this message.
   */
  attachments: ExternalChatAttachment[]
  /**
   * Provider timestamp at which the message was posted.
   */
  postedAt: string
  /**
   * Provider timestamp for the latest observed message state.
   */
  updatedAt: string
  /**
   * Provider timestamp for the latest observed content edit.
   */
  editedAt?: string
  /**
   * Provider timestamp for an observed soft or hard deletion.
   */
  deletedAt?: string
}

/**
 * Bounded external thread snapshot suitable for an authorized Work Item source view.
 */
export type ExternalChatThreadSnapshot = {
  /**
   * External chat schema version.
   */
  schemaVersion: typeof EXTERNAL_CHAT_SCHEMA_VERSION
  /**
   * Provider workspace snapshot for the thread.
   */
  workspace: ExternalChatWorkspace
  /**
   * Conversation snapshot for the thread.
   */
  conversation: ExternalChatConversation
  /**
   * Immutable provider-scoped thread ID.
   */
  externalId: string
  /**
   * External message ID that anchors the thread.
   */
  rootMessageExternalId: string
  /**
   * Stable HTTPS provider permalink for the thread or its root message while policy permits it.
   */
  permalink?: string
  /**
   * Current ability to read the thread through the installation.
   */
  availability: ExternalChatSourceAvailability
  /**
   * Last known lifecycle state of the thread.
   */
  state: ExternalChatSourceState
  /**
   * Total message count when the provider exposes a reliable count.
   */
  messageCount?: number
  /**
   * Bounded, chronologically ordered message subset allowed for the current principal.
   */
  messages: ExternalChatMessage[]
  /**
   * Whether additional authorized messages exist beyond this snapshot.
   */
  hasMoreMessages: boolean
  /**
   * Application-issued opaque cursor for another bounded message page.
   */
  nextMessageCursor?: string
  /**
   * Provider timestamp at which the root message was posted.
   */
  createdAt: string
  /**
   * Provider timestamp for the latest observed thread change.
   */
  updatedAt: string
  /**
   * Provider timestamp for the latest observed thread completion.
   */
  completedAt?: string
}

/**
 * Stable external source locator retained after optional metadata redaction.
 */
export type ExternalChatThreadReference = {
  /**
   * Immutable provider-scoped workspace or tenant ID.
   */
  externalWorkspaceId: string
  /**
   * Immutable provider-scoped conversation ID.
   */
  conversationExternalId: string
  /**
   * Immutable provider-scoped thread ID.
   */
  threadExternalId: string
  /**
   * External root message ID for the thread.
   */
  rootMessageExternalId: string
  /**
   * Exact message that initiated the command when the command targets a reply.
   */
  sourceMessageExternalId?: string
  /**
   * Stable HTTPS permalink for the selected thread, message, or quoted source while retention
   * policy still permits keeping it.
   */
  sourcePermalink?: string
  /**
   * Optional selected text range within the source message.
   */
  quotedRange?: ExternalChatQuotedRange
}

/**
 * External thread selection accepted by create and link commands before retention redaction.
 */
export type ExternalChatThreadSelection = ExternalChatThreadReference & {
  /**
   * Stable HTTPS permalink required and authorization-checked at the command boundary.
   */
  sourcePermalink: string
}

/**
 * Independent association between an external chat thread and a canonical Work Item.
 */
export type ExternalChatWorkItemLink = {
  /**
   * External chat schema version.
   */
  schemaVersion: typeof EXTERNAL_CHAT_SCHEMA_VERSION
  /**
   * Stable link ID used by commands, audit events, and message bindings.
   */
  id: string
  /**
   * Team that owns the canonical Work Item.
   */
  teamId: string
  /**
   * Current canonical Work Item ID after any duplicate merge.
   */
  workItemId: string
  /**
   * Connector installation authorized to access the external source.
   */
  installationId: string
  /**
   * Slack or Microsoft Teams provider derived from the installation.
   */
  provider: ExternalChatProvider
  /**
   * Display snapshot of the provider workspace retained within policy.
   */
  workspace: ExternalChatWorkspace
  /**
   * Display snapshot of the provider conversation retained within policy.
   */
  conversation: ExternalChatConversation
  /**
   * Stable thread, message, and optional quote locator.
   */
  source: ExternalChatThreadReference
  /**
   * Enabled synchronization direction for replies and source lifecycle updates.
   */
  syncDirection: ExternalSyncDirection
  /**
   * Current user-visible synchronization status.
   */
  syncStatus: ExternalSyncStatus
  /**
   * Current ability to reach the provider source.
   */
  sourceAvailability: ExternalChatSourceAvailability
  /**
   * Last known provider source lifecycle state.
   */
  sourceState: ExternalChatSourceState
  /**
   * Optimistic concurrency revision for link commands and duplicate moves.
   */
  revision: number
  /**
   * Timestamp when all observed internal and external state last agreed.
   */
  lastSyncedAt?: string
  /**
   * Timestamp when the provider source was last observed successfully.
   */
  lastSourceObservedAt?: string
  /**
   * Link creation timestamp in ISO 8601 format.
   */
  createdAt: string
  /**
   * Link update timestamp in ISO 8601 format.
   */
  updatedAt: string
}

/**
 * Source-redacted external chat link state safe to return after Work Item authorization alone.
 */
export type ExternalChatWorkItemLinkSummary = {
  /**
   * External chat schema version.
   */
  schemaVersion: typeof EXTERNAL_CHAT_SCHEMA_VERSION
  /**
   * Stable link ID used by commands and audit records.
   */
  id: string
  /**
   * Team that owns the canonical Work Item.
   */
  teamId: string
  /**
   * Current canonical Work Item ID after any duplicate merge.
   */
  workItemId: string
  /**
   * Provider family without provider-scoped source identifiers or content.
   */
  provider: ExternalChatProvider
  /**
   * Enabled synchronization direction.
   */
  syncDirection: ExternalSyncDirection
  /**
   * Current synchronization status.
   */
  syncStatus: ExternalSyncStatus
  /**
   * Current source reachability state.
   */
  sourceAvailability: ExternalChatSourceAvailability
  /**
   * Last known source lifecycle state.
   */
  sourceState: ExternalChatSourceState
  /**
   * Optimistic concurrency revision.
   */
  revision: number
  /**
   * Timestamp when internal and external state last agreed.
   */
  lastSyncedAt?: string
  /**
   * Link creation timestamp in ISO 8601 format.
   */
  createdAt: string
  /**
   * Link update timestamp in ISO 8601 format.
   */
  updatedAt: string
}

/**
 * Private durable provider cursor used to resume bounded thread synchronization.
 */
export type ExternalChatSyncCursor = {
  /**
   * External chat schema version.
   */
  schemaVersion: typeof EXTERNAL_CHAT_SCHEMA_VERSION
  /**
   * Link whose provider traversal owns this cursor.
   */
  linkId: string
  /**
   * Provider that issued the opaque cursor.
   */
  provider: ExternalChatProvider
  /**
   * Resynchronization operation that exclusively owns this checkpoint.
   */
  operationId: string
  /**
   * Traversal mode selected when the owning operation was accepted.
   */
  mode: 'resume' | 'full'
  /**
   * Whether the owning traversal can still advance or reached its terminal page.
   */
  status: 'processing' | 'completed'
  /**
   * Accepted link revision used to fence superseded resynchronization jobs.
   */
  ownerLinkRevision: number
  /**
   * Provider authorization generation accepted for the owning resynchronization operation.
   */
  authorizationRevision: number
  /**
   * Last permission-filtered source availability observed on a committed provider page.
   */
  observedSourceAvailability?: ExternalChatSourceAvailability
  /**
   * Last provider thread lifecycle state observed on a committed provider page.
   */
  observedSourceState?: ExternalChatSourceState
  /**
   * Provider timestamp for the latest authoritative thread snapshot in this traversal.
   */
  observedSourceAt?: string
  /**
   * Honest link synchronization status to project after a terminal operation checkpoint.
   */
  completionSyncStatus?: ExternalSyncStatus
  /**
   * Provider-issued opaque continuation value that must never be returned directly to clients.
   */
  providerCursor?: string
  /**
   * Optimistic concurrency revision for cursor advancement.
   */
  revision: number
  /**
   * Last provider event ID committed with this checkpoint.
   */
  lastEventId?: string
  /**
   * Provider occurrence timestamp of the last committed event when available.
   */
  lastEventAt?: string
  /**
   * Checkpoint update timestamp in ISO 8601 format.
   */
  updatedAt: string
}

/**
 * Side that originally created a synchronized message binding.
 */
export type ExternalChatMessageOrigin = 'external' | 'internal'

/**
 * Durable one-to-one mapping between a provider message and an internal Work Item comment.
 */
export type ExternalChatMessageBinding = {
  /**
   * External chat schema version.
   */
  schemaVersion: typeof EXTERNAL_CHAT_SCHEMA_VERSION
  /**
   * Thread link that owns this binding.
   */
  linkId: string
  /**
   * Immutable provider-scoped message ID.
   */
  externalMessageId: string
  /**
   * Internal collaboration comment ID synchronized with the external message.
   */
  internalCommentId: string
  /**
   * Side that created the message before synchronization.
   */
  origin: ExternalChatMessageOrigin
  /**
   * Last committed provider message revision.
   */
  externalVersion: string
  /**
   * Last committed internal comment version.
   */
  internalCommentVersion: number
  /**
   * Last inbound provider event ID applied to this message.
   */
  lastInboundEventId?: string
  /**
   * Last outbound operation ID accepted by the provider.
   */
  lastOutboundOperationId?: string
  /**
   * Internal File IDs imported from attachments on this message.
   */
  importedFileIds: string[]
  /**
   * Timestamp at which either side observed message deletion.
   */
  deletedAt?: string
  /**
   * Binding creation timestamp in ISO 8601 format.
   */
  createdAt: string
  /**
   * Binding update timestamp in ISO 8601 format.
   */
  updatedAt: string
}

/**
 * Successful synchronization outcome for one logical operation.
 */
export type ExternalChatAppliedSyncOutcome = {
  /**
   * Outcome discriminator.
   */
  kind: 'applied'
  /**
   * Stable logical operation ID shared across retries.
   */
  operationId: string
  /**
   * Provider event ID for an inbound operation.
   */
  eventId?: string
  /**
   * Direction that was applied.
   */
  direction: 'inbound' | 'outbound'
  /**
   * Completion timestamp in ISO 8601 format.
   */
  occurredAt: string
}

/**
 * Safe no-op synchronization outcome for one logical operation.
 */
export type ExternalChatSkippedSyncOutcome = {
  /**
   * Outcome discriminator.
   */
  kind: 'skipped'
  /**
   * Stable logical operation ID shared across retries.
   */
  operationId: string
  /**
   * Provider event ID for an inbound operation.
   */
  eventId?: string
  /**
   * Stable reason that no side effect was required.
   */
  reason:
    | 'duplicate'
    | 'self-origin'
    | 'stale'
    | 'paused'
    | 'unlinked'
    | 'not-eligible'
  /**
   * Decision timestamp in ISO 8601 format.
   */
  occurredAt: string
}

/**
 * Retryable synchronization outcome deferred without reporting false success.
 */
export type ExternalChatDeferredSyncOutcome = {
  /**
   * Outcome discriminator.
   */
  kind: 'deferred'
  /**
   * Stable logical operation ID shared across retries.
   */
  operationId: string
  /**
   * Provider event ID for an inbound operation.
   */
  eventId?: string
  /**
   * Stable reason that processing must resume later.
   */
  reason: 'out-of-order' | 'rate-limited' | 'source-unavailable'
  /**
   * Earliest safe retry timestamp when known.
   */
  retryAt?: string
  /**
   * Decision timestamp in ISO 8601 format.
   */
  occurredAt: string
}

/**
 * Failed synchronization outcome with secret-free diagnostics.
 */
export type ExternalChatFailedSyncOutcome = {
  /**
   * Outcome discriminator.
   */
  kind: 'failed'
  /**
   * Stable logical operation ID shared across retries.
   */
  operationId: string
  /**
   * Provider event ID for an inbound operation.
   */
  eventId?: string
  /**
   * Stable secret-free error code.
   */
  errorCode: string
  /**
   * Whether retrying the same logical operation may recover.
   */
  retryable: boolean
  /**
   * Failure timestamp in ISO 8601 format.
   */
  occurredAt: string
}

/**
 * Auditable result of processing one inbound or outbound chat synchronization operation.
 */
export type ExternalChatSyncOutcome =
  | ExternalChatAppliedSyncOutcome
  | ExternalChatSkippedSyncOutcome
  | ExternalChatDeferredSyncOutcome
  | ExternalChatFailedSyncOutcome

/**
 * Fields shared by every normalized inbound provider event.
 */
type ExternalChatInboundEventBase = {
  /**
   * External chat schema version.
   */
  schemaVersion: typeof EXTERNAL_CHAT_SCHEMA_VERSION
  /**
   * Provider event ID that remains stable across webhook retries.
   */
  eventId: string
  /**
   * Correlation ID retained across normalization, persistence, and audit writes.
   */
  correlationId: string
  /**
   * Connector installation that authenticated the provider event.
   */
  installationId: string
  /**
   * Provider that emitted the event.
   */
  provider: ExternalChatProvider
  /**
   * External workspace or tenant ID in the event scope.
   */
  externalWorkspaceId: string
  /**
   * Provider occurrence timestamp in ISO 8601 format.
   */
  occurredAt: string
  /**
   * Provider ordering token interpreted only by its adapter.
   */
  externalSequence?: string
  /**
   * Authenticated internal operation ID when the event echoes an outbound mutation.
   */
  originOperationId?: string
}

/**
 * Fields shared by normalized events that are contained by one external thread.
 */
type ExternalChatThreadScopedInboundEventBase = ExternalChatInboundEventBase & {
  /**
   * External conversation ID that contains the thread.
   */
  conversationExternalId: string
  /**
   * External thread ID that contains the event resource.
   */
  threadExternalId: string
}

/**
 * Fields shared by every normalized source lifecycle transition.
 */
type ExternalChatSourceLifecycleEventBase = ExternalChatInboundEventBase & {
  /**
   * Event discriminator.
   */
  type: 'source.lifecycle-changed'
  /**
   * Current ability to access the affected source.
   */
  availability: ExternalChatSourceAvailability
  /**
   * Last known lifecycle state of the affected source.
   */
  state: ExternalChatSourceState
  /**
   * Stable secret-free reason code supplied by the adapter or runtime.
   */
  reasonCode: string
  /**
   * Stable source permalink retained when policy allows it.
   */
  sourcePermalink?: string
}

/**
 * Normalized event emitted when an external chat message is created.
 */
export type ExternalChatMessageCreatedEvent = ExternalChatThreadScopedInboundEventBase & {
  /**
   * Event discriminator.
   */
  type: 'message.created'
  /**
   * Complete permission-filtered message snapshot.
   */
  message: ExternalChatMessage
}

/**
 * Normalized event emitted when an external chat message is edited.
 */
export type ExternalChatMessageEditedEvent = ExternalChatThreadScopedInboundEventBase & {
  /**
   * Event discriminator.
   */
  type: 'message.edited'
  /**
   * Complete permission-filtered message snapshot after the edit.
   */
  message: ExternalChatMessage
}

/**
 * Normalized event emitted when an external chat message is deleted.
 */
export type ExternalChatMessageDeletedEvent = ExternalChatThreadScopedInboundEventBase & {
  /**
   * Event discriminator.
   */
  type: 'message.deleted'
  /**
   * Immutable provider-scoped message ID.
   */
  externalMessageId: string
  /**
   * Provider revision for the deletion tombstone.
   */
  externalVersion: string
  /**
   * Stable source permalink retained when policy allows it.
   */
  sourcePermalink?: string
  /**
   * Provider deletion timestamp in ISO 8601 format.
   */
  deletedAt: string
}

/**
 * Normalized event emitted when a provider thread is completed.
 */
export type ExternalChatThreadCompletedEvent = ExternalChatThreadScopedInboundEventBase & {
  /**
   * Event discriminator.
   */
  type: 'thread.completed'
  /**
   * Provider revision for the completed thread state.
   */
  externalVersion: string
  /**
   * Stable source permalink retained when policy allows it.
   */
  sourcePermalink?: string
  /**
   * Provider completion timestamp in ISO 8601 format.
   */
  completedAt: string
}

/**
 * Normalized event emitted when a completed provider thread is reopened.
 */
export type ExternalChatThreadReopenedEvent = ExternalChatThreadScopedInboundEventBase & {
  /**
   * Event discriminator.
   */
  type: 'thread.reopened'
  /**
   * Provider revision for the reopened thread state.
   */
  externalVersion: string
  /**
   * Stable source permalink retained when policy allows it.
   */
  sourcePermalink?: string
  /**
   * Provider reopen timestamp in ISO 8601 format.
   */
  reopenedAt: string
}

/**
 * Normalized event for permission, retention, deletion, or installation lifecycle changes.
 */
export type ExternalChatSourceLifecycleEvent =
  | ExternalChatSourceLifecycleEventBase & {
    /**
     * Workspace-scoped lifecycle transition with no fabricated child identifiers.
     */
    resourceType: 'workspace'
  }
  | ExternalChatSourceLifecycleEventBase & {
    /**
     * Conversation-scoped lifecycle transition.
     */
    resourceType: 'conversation'
    /**
     * External conversation ID affected by the transition.
     */
    conversationExternalId: string
  }
  | ExternalChatSourceLifecycleEventBase & {
    /**
     * Thread-scoped lifecycle transition.
     */
    resourceType: 'thread'
    /**
     * External conversation ID that contains the thread.
     */
    conversationExternalId: string
    /**
     * External thread ID affected by the transition.
     */
    threadExternalId: string
  }
  | ExternalChatSourceLifecycleEventBase & {
    /**
     * Message-scoped lifecycle transition.
     */
    resourceType: 'message'
    /**
     * External conversation ID that contains the message.
     */
    conversationExternalId: string
    /**
     * External thread ID that contains the message.
     */
    threadExternalId: string
    /**
     * Provider-scoped message ID affected by the transition.
     */
    resourceExternalId: string
  }
  | ExternalChatSourceLifecycleEventBase & {
    /**
     * Attachment-scoped lifecycle transition.
     */
    resourceType: 'attachment'
    /**
     * External conversation ID that contains the attachment.
     */
    conversationExternalId: string
    /**
     * External thread ID that contains the attachment.
     */
    threadExternalId: string
    /**
     * Provider-scoped attachment ID affected by the transition.
     */
    resourceExternalId: string
  }

/**
 * Provider-neutral inbound chat event accepted by the synchronization runtime.
 */
export type ExternalChatInboundEvent =
  | ExternalChatMessageCreatedEvent
  | ExternalChatMessageEditedEvent
  | ExternalChatMessageDeletedEvent
  | ExternalChatThreadCompletedEvent
  | ExternalChatThreadReopenedEvent
  | ExternalChatSourceLifecycleEvent

/**
 * Command that creates a canonical Work Item and links it to one external chat thread.
 */
export type CreateWorkItemFromExternalChatThreadInput = {
  /**
   * Team that will own the new Work Item.
   */
  teamId: string
  /**
   * Chat connector installation used to resolve and authorize the source.
   */
  installationId: string
  /**
   * Provider source locator to validate through the adapter.
   */
  source: ExternalChatThreadSelection
  /**
   * Canonical Work Item fields validated against current configuration.
   */
  workItem: CreateWorkItemInput
  /**
   * Initial synchronization direction for replies and lifecycle changes.
   */
  syncDirection: ExternalSyncDirection
}

/**
 * Result of creating a Work Item from an external chat thread.
 */
export type CreateWorkItemFromExternalChatThreadResult = {
  /**
   * Created or idempotently recovered canonical Work Item.
   */
  workItem: CanonicalWorkItem
  /**
   * Chat source link committed with the Work Item mutation.
   */
  link: ExternalChatWorkItemLink
}

/**
 * Command that links an external chat thread to an existing canonical Work Item.
 */
export type LinkExternalChatThreadInput = {
  /**
   * Team that owns the existing Work Item.
   */
  teamId: string
  /**
   * Existing canonical Work Item ID.
   */
  workItemId: string
  /**
   * Chat connector installation used to resolve and authorize the source.
   */
  installationId: string
  /**
   * Provider source locator to validate through the adapter.
   */
  source: ExternalChatThreadSelection
  /**
   * Initial synchronization direction for replies and lifecycle changes.
   */
  syncDirection: ExternalSyncDirection
}

/**
 * Result of linking an external chat thread to an existing Work Item.
 */
export type LinkExternalChatThreadResult = {
  /**
   * Created or idempotently recovered chat source link.
   */
  link: ExternalChatWorkItemLink
}

/**
 * Command that changes synchronization settings on an external chat link.
 */
export type UpdateExternalChatWorkItemLinkInput = {
  /**
   * Link revision read before the update.
   */
  expectedRevision: number
  /**
   * Replacement synchronization direction.
   */
  syncDirection: ExternalSyncDirection
}

/**
 * Result of updating an external chat link.
 */
export type UpdateExternalChatWorkItemLinkResult = {
  /**
   * Updated link state without provider-scoped source metadata.
   */
  link: ExternalChatWorkItemLinkSummary
}

/**
 * Command that unlinks an external chat thread from a Work Item.
 */
export type UnlinkExternalChatThreadInput = {
  /**
   * Link revision read before unlinking.
   */
  expectedRevision: number
}

/**
 * Result of unlinking an external chat thread from a Work Item.
 */
export type UnlinkExternalChatThreadResult = {
  /**
   * Removed external chat link ID.
   */
  linkId: string
  /**
   * Unlink completion timestamp in ISO 8601 format.
   */
  unlinkedAt: string
}

/**
 * Command that resumes from a checkpoint or rebuilds one external chat link.
 */
export type ResyncExternalChatWorkItemLinkInput = {
  /**
   * Link revision read before scheduling the resynchronization.
   */
  expectedRevision: number
  /**
   * Whether to resume the saved checkpoint or rebuild from the provider source.
   */
  mode: 'resume' | 'full'
}

/**
 * Result of accepting an external chat resynchronization command.
 */
export type ResyncExternalChatWorkItemLinkResult = {
  /**
   * Link transitioned to its pending state without provider-scoped source metadata.
   */
  link: ExternalChatWorkItemLinkSummary
  /**
   * Stable operation ID used by every retry of the resynchronization.
   */
  operationId: string
  /**
   * Command acceptance timestamp in ISO 8601 format.
   */
  acceptedAt: string
}

/**
 * Revision-fenced external chat link selected for a duplicate Work Item merge.
 */
export type ExternalChatLinkMergeCandidate = {
  /**
   * External chat link to move to the canonical Work Item.
   */
  linkId: string
  /**
   * Link revision read before the merge.
   */
  expectedRevision: number
}

/**
 * Command that moves external chat sources from a duplicate to the canonical Work Item.
 */
export type MergeExternalChatWorkItemLinksInput = {
  /**
   * Team that owns the canonical Work Item.
   */
  canonicalTeamId: string
  /**
   * Work Item that remains canonical after the merge.
   */
  canonicalWorkItemId: string
  /**
   * Canonical Work Item revision read before the merge.
   */
  expectedCanonicalWorkItemRevision: number
  /**
   * Team that owns the duplicate Work Item.
   */
  duplicateTeamId: string
  /**
   * Duplicate Work Item whose chat sources will move.
   */
  duplicateWorkItemId: string
  /**
   * Duplicate Work Item revision read before the merge.
   */
  expectedDuplicateWorkItemRevision: number
  /**
   * Complete active link set owned by the duplicate, with every observed link revision.
   * The server rejects omissions and concurrent membership changes before tombstoning the duplicate.
   */
  links: ExternalChatLinkMergeCandidate[]
}

/**
 * Durable redirect from an external thread's former Work Item to its canonical Work Item.
 */
export type ExternalChatCanonicalRedirect = {
  /**
   * External chat link whose ownership moved.
   */
  linkId: string
  /**
   * Provider that owns the external thread identity.
   */
  provider: ExternalChatProvider
  /**
   * Provider-scoped thread ID that resolves through this redirect.
   */
  threadExternalId: string
  /**
   * Team that owned the duplicate Work Item.
   */
  fromTeamId: string
  /**
   * Duplicate Work Item ID retained for traceability.
   */
  fromWorkItemId: string
  /**
   * Team that owns the canonical Work Item.
   */
  canonicalTeamId: string
  /**
   * Canonical Work Item ID returned for future source lookups.
   */
  canonicalWorkItemId: string
  /**
   * Redirect creation timestamp in ISO 8601 format.
   */
  createdAt: string
}

/**
 * Source-redacted canonical route safe to return after Work Item authorization alone.
 */
export type ExternalChatCanonicalRoute = {
  /**
   * Team that owned the duplicate Work Item.
   */
  fromTeamId: string
  /**
   * Duplicate Work Item ID retained for navigation.
   */
  fromWorkItemId: string
  /**
   * Team that owns the canonical Work Item.
   */
  canonicalTeamId: string
  /**
   * Canonical Work Item ID returned for future navigation.
   */
  canonicalWorkItemId: string
  /**
   * Redirect creation timestamp in ISO 8601 format.
   */
  createdAt: string
}

/**
 * Result of moving duplicate Work Item chat sources to the canonical Work Item.
 */
export type MergeExternalChatWorkItemLinksResult = {
  /**
   * Canonical Work Item after the merge transaction.
   */
  canonicalWorkItem: CanonicalWorkItem
  /**
   * Source-redacted chat link states after canonical ownership changed.
   */
  movedLinks: ExternalChatWorkItemLinkSummary[]
  /**
   * Source-redacted routes that keep former Work Item URLs navigable.
   */
  redirects: ExternalChatCanonicalRoute[]
  /**
   * Number of scanned internal Files moved without exposing File identifiers.
   */
  movedFileCount: number
  /**
   * Number of message bindings moved to the canonical Work Item.
   */
  movedMessageBindingCount: number
  /**
   * Merge completion timestamp in ISO 8601 format.
   */
  mergedAt: string
}
