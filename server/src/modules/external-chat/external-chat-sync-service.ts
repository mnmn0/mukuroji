import type {
  ExternalChatActor,
  ExternalChatAttachment,
  ExternalChatInboundEvent,
  ExternalChatMessage,
  ExternalChatMessageBinding,
  ExternalChatProvider,
  ExternalChatQuotedRange,
  ExternalChatSourceAvailability,
  ExternalChatSourceState,
  ExternalChatSyncOutcome,
  ExternalChatThreadSnapshot,
  ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import {
  ChatProviderAdapterError,
  type ChatProviderAuthorization,
  type ChatProviderAdapterRegistry,
  type ChatProviderOriginAction,
  type ChatProviderOriginMarker,
  type ChatProviderThreadPage,
  createChatProviderOriginMarker,
  verifyChatProviderOriginMarker,
} from './chat-provider-adapter'
import {
  normalizeChatProviderInboundEvent,
  normalizeChatProviderMessage,
  normalizeChatProviderThreadMutationResult,
  normalizeChatProviderThreadPage,
} from './chat-provider-normalizer'
import { normalizeExternalChatRetryAt } from './external-chat-retry-schedule'
import {
  createExternalChatFingerprint,
  createExternalChatInboundOperationId,
  createExternalChatSourceDigest,
  ExternalChatError,
  type ExternalChatInboundReceipt,
  type ExternalChatParentLifecycleFence,
  type ExternalChatSyncCommentCreatedEvent,
  type ExternalChatSyncCommentDeletedEvent,
  type ExternalChatSyncCommentEditedEvent,
  type ExternalChatSyncOutboundEvent,
  type ExternalChatSyncWorkItemCompletedEvent,
  type ExternalChatSyncWorkItemReopenedEvent,
  type ExternalChatThreadLifecycleState,
  type ExternalChatSourceIdentity,
  type ExternalChatStore,
  type StoredExternalChatLink,
  type StoredExternalChatMessageBinding,
  type StoredExternalChatThreadLifecycle,
} from './external-chat'

export type {
  ExternalChatSyncCommentCreatedEvent,
  ExternalChatSyncCommentDeletedEvent,
  ExternalChatSyncCommentEditedEvent,
  ExternalChatSyncOutboundEvent,
  ExternalChatSyncWorkItemCompletedEvent,
  ExternalChatSyncWorkItemReopenedEvent,
} from './external-chat'

/** Maximum active links processed before one durable parent fan-out checkpoint. */
const PARENT_LIFECYCLE_FANOUT_PAGE_SIZE = 25

/** Provider parent lifecycle event that must fan out independently of one thread locator. */
type ExternalChatParentLifecycleEvent = Extract<
  ExternalChatInboundEvent,
  { type: 'source.lifecycle-changed' }
> & {
  /** Parent resource kind shared by every affected active link. */
  resourceType: 'workspace' | 'conversation'
}

/** Authenticated internal principal passed to external chat synchronization use cases. */
export type ExternalChatSyncPrincipal = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Canonical internal principal identifier. */
  principalId: string
}

/** Scope used for both internal and provider-side source authorization. */
export type ExternalChatSyncSourceAccessScope = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Team that owns the linked Work Item. */
  teamId: string
  /** Linked canonical Work Item identifier. */
  workItemId: string
  /** External chat link identifier. */
  linkId: string
}

/** Application boundary that fail-closes source views across both permission systems. */
export interface ExternalChatSyncAccessPort {
  /** Checks whether the current principal may view the linked internal Work Item. */
  canViewWorkItem(
    principal: ExternalChatSyncPrincipal,
    scope: ExternalChatSyncSourceAccessScope,
  ): Promise<boolean>
  /** Resolves current viewer-scoped provider authorization, or no access. */
  getViewerProviderAuthorization(
    principal: ExternalChatSyncPrincipal,
    link: ExternalChatWorkItemLink,
  ): Promise<ChatProviderAuthorization | undefined>
  /** Resolves current installation authorization for background synchronization. */
  getInstallationProviderAuthorization(
    workspaceId: string,
    link: ExternalChatWorkItemLink,
  ): Promise<ChatProviderAuthorization | undefined>
  /** Revalidates whether the current internal principal may export this Work Item mutation. */
  canSyncOutbound(
    principal: ExternalChatSyncPrincipal,
    scope: ExternalChatSyncSourceAccessScope,
  ): Promise<boolean>
}

/** Cursor binding that prevents replaying one source cursor in another authorization scope. */
export type ExternalChatSyncCursorScope = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Current internal principal identifier. */
  principalId: string
  /** External chat link identifier. */
  linkId: string
  /** Provider that owns the private continuation. */
  provider: ExternalChatProvider
  /** Link ownership revision current when the cursor is issued or consumed. */
  linkRevision: number
  /** Viewer provider authorization generation current for the source read. */
  authorizationRevision: number
}

/** Application-issued cursor codec that keeps provider continuations private. */
export interface ExternalChatSyncCursorCodecPort {
  /** Authenticates and unwraps an application cursor for the exact source-view scope. */
  decode(scope: ExternalChatSyncCursorScope, cursor: string): Promise<string>
  /** Authenticates and wraps a private provider continuation for the exact source-view scope. */
  encode(scope: ExternalChatSyncCursorScope, providerCursor: string): Promise<string>
}

/** Input for an authorized, bounded external source view. */
export type ExternalChatSyncGetSourceViewInput = {
  /** Authenticated internal principal. */
  principal: ExternalChatSyncPrincipal
  /** External chat link identifier. */
  linkId: string
  /** Application-issued continuation from an earlier page. */
  cursor?: string
  /** Maximum provider messages to return. */
  limit: number
}

/** Per-message ordering decision made with provider-aware version semantics. */
export type ExternalChatSyncMessageOrderDecision = 'apply' | 'stale' | 'defer'

/** Input for provider-specific external message ordering. */
export type ExternalChatSyncMessageOrderInput = {
  /** Chat provider that owns the versions. */
  provider: ExternalChatProvider
  /** External chat link identifier. */
  linkId: string
  /** Provider-scoped message identifier. */
  externalMessageId: string
  /** Last committed provider version, when a binding exists. */
  previousExternalVersion?: string
  /** Incoming provider version. */
  incomingExternalVersion: string
  /** Optional adapter-defined ordering token. */
  externalSequence?: string
  /** Provider occurrence timestamp. */
  occurredAt: string
}

/** Provider-aware ordering boundary for message revisions and tombstones. */
export interface ExternalChatSyncMessageOrderPort {
  /** Classifies an incoming message version without guessing provider token semantics. */
  decide(input: ExternalChatSyncMessageOrderInput): Promise<ExternalChatSyncMessageOrderDecision>
}

/** Per-thread lifecycle ordering decision made with provider-specific version semantics. */
export type ExternalChatSyncThreadOrderDecision = 'apply' | 'stale' | 'defer'

/** Input for provider-specific external thread lifecycle ordering. */
export type ExternalChatSyncThreadOrderInput = {
  /** Chat provider that owns the version. */
  provider: ExternalChatProvider
  /** External chat link whose thread lifecycle is changing. */
  linkId: string
  /** Last committed provider thread version, when one exists. */
  previousExternalVersion?: string
  /** Incoming provider thread version. */
  incomingExternalVersion: string
  /** Optional adapter-defined ordering token. */
  externalSequence?: string
  /** Provider occurrence timestamp. */
  occurredAt: string
}

/** Provider-aware ordering boundary for thread completion and reopen revisions. */
export interface ExternalChatSyncThreadOrderPort {
  /** Classifies an incoming thread lifecycle version without guessing token semantics. */
  decideThreadLifecycle(
    input: ExternalChatSyncThreadOrderInput,
  ): Promise<ExternalChatSyncThreadOrderDecision>
}

/** Provenance retained when an external message becomes an internal comment. */
export type ExternalChatSyncCommentSource = {
  /** Chat provider that owns the source message. */
  provider: ExternalChatProvider
  /** External chat link identifier. */
  linkId: string
  /** Provider-scoped message identifier. */
  externalMessageId: string
  /** Stable provider permalink authorized for this import. */
  permalink: string
  /** Permission-filtered provider actor snapshot. */
  actor?: ExternalChatActor
  /** Provider post timestamp. */
  postedAt: string
  /** Selected source ranges retained with the comment. */
  quotedRanges: ExternalChatQuotedRange[]
  /** Permission-filtered attachment metadata. */
  attachments: ExternalChatAttachment[]
}

/** Common context for idempotent collaboration mutations. */
export type ExternalChatSyncCommentMutationContext = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** External chat link that owns the mutation and its imported provenance. */
  linkId: string
  /** Link revision that must still own the target Work Item when the mutation commits. */
  expectedLinkRevision: number
  /** Team that owns the Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Stable retry-safe synchronization operation identifier. */
  operationId: string
  /** Correlation identifier propagated from the provider event. */
  correlationId: string
  /** Provider occurrence timestamp. */
  occurredAt: string
}

/** Input for importing one external message as an internal comment. */
export type ExternalChatSyncCreateCommentInput = ExternalChatSyncCommentMutationContext & {
  /** Normalized Markdown body. */
  bodyMarkdown: string
  /** Bound internal parent comment for an external reply. */
  parentCommentId?: string
  /** Provider source provenance. */
  source: ExternalChatSyncCommentSource
}

/** Input for applying an external edit to a bound internal comment. */
export type ExternalChatSyncUpdateCommentInput = ExternalChatSyncCommentMutationContext & {
  /** Bound internal collaboration comment identifier. */
  commentId: string
  /** Last internal version committed in the binding. */
  expectedVersion: number
  /** Replacement normalized Markdown body. */
  bodyMarkdown: string
  /** Updated provider source provenance. */
  source: ExternalChatSyncCommentSource
}

/** Input for applying an external deletion to a bound internal comment. */
export type ExternalChatSyncDeleteCommentInput = ExternalChatSyncCommentMutationContext & {
  /** Bound internal collaboration comment identifier. */
  commentId: string
  /** Last internal version committed in the binding. */
  expectedVersion: number
}

/** Input for idempotently redacting an imported message or attachment lifecycle projection. */
export type ExternalChatSyncApplyResourceLifecycleInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Team that owns the canonical Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** External chat link that owns the imported projection. */
  linkId: string
  /** Link revision that must still own the target Work Item when redaction commits. */
  expectedLinkRevision: number
  /** Kind of imported external resource whose projection must change. */
  resourceType: 'message' | 'attachment'
  /** Provider-scoped resource identifier used to find imported provenance. */
  resourceExternalId: string
  /** Current provider reachability for the resource. */
  availability: ExternalChatSourceAvailability
  /** Last known provider lifecycle state for the resource. */
  state: ExternalChatSourceState
  /** Stable retry-safe synchronization operation identifier. */
  operationId: string
  /** Correlation identifier propagated from the provider event. */
  correlationId: string
  /** Provider lifecycle occurrence timestamp. */
  occurredAt: string
}

/** Input for redacting every imported projection owned by one restrictive parent link. */
export type ExternalChatSyncRedactLinkResourcesInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Team that owns the canonical Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** External chat link whose imported comments and files must be redacted. */
  linkId: string
  /** Link revision that must still own the target Work Item when redaction commits. */
  expectedLinkRevision: number
  /** Restrictive provider reachability observed for the parent resource. */
  availability: ExternalChatSourceAvailability
  /** Restrictive provider lifecycle state observed for the parent resource. */
  state: ExternalChatSourceState
  /** Stable retry-safe synchronization operation identifier. */
  operationId: string
  /** Correlation identifier propagated from the provider event. */
  correlationId: string
  /** Provider lifecycle occurrence timestamp. */
  occurredAt: string
}

/** Result of an idempotent collaboration comment mutation. */
export type ExternalChatSyncCommentMutationResult = {
  /** Canonical collaboration comment identifier. */
  commentId: string
  /** Current internal comment version. */
  version: number
}

/**
 * Collaboration boundary used for inbound external message mutations.
 *
 * Implementations must condition the link ID, expected link revision, Team, and Work Item in the
 * same transaction as the comment mutation so duplicate merge cannot commit a stale owner.
 */
export interface ExternalChatSyncCollaborationPort {
  /** Idempotently creates an internal comment from an external message. */
  createExternalComment(
    input: ExternalChatSyncCreateCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult>
  /** Idempotently updates a bound internal comment from an external edit. */
  updateExternalComment(
    input: ExternalChatSyncUpdateCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult>
  /** Idempotently tombstones a bound internal comment from an external deletion. */
  deleteExternalComment(
    input: ExternalChatSyncDeleteCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult>
  /** Idempotently applies redaction or lifecycle state to imported message/file projections. */
  applyExternalResourceLifecycle(
    input: ExternalChatSyncApplyResourceLifecycleInput,
  ): Promise<void>
  /** Idempotently and resumably redacts every imported comment/file projection owned by a link. */
  redactExternalLinkResources(input: ExternalChatSyncRedactLinkResourcesInput): Promise<void>
}

/** Input for importing provider attachment metadata through the private Files pipeline. */
export type ExternalChatSyncImportAttachmentsInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Team that owns the canonical Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** External chat link that owns the imported files. */
  linkId: string
  /** Link revision that must still own the target Work Item when the import commits. */
  expectedLinkRevision: number
  /** Provider that owns the attachment identities. */
  provider: ExternalChatProvider
  /** Current installation authorization used to read provider attachment content. */
  authorization: ChatProviderAuthorization
  /** Provider-scoped message that owns the attachments. */
  externalMessageId: string
  /** Permission-filtered metadata with provider-supplied internal File IDs removed. */
  attachments: Array<Omit<ExternalChatAttachment, 'importedFileId'>>
  /** Stable retry-safe synchronization operation identifier. */
  operationId: string
  /** Correlation identifier propagated from the provider event. */
  correlationId: string
  /** Provider message occurrence timestamp. */
  occurredAt: string
}

/** Result of importing authorized provider attachments through the private Files pipeline. */
export type ExternalChatSyncImportAttachmentsResult = {
  /** Scanned canonical internal File IDs created or recovered by the pipeline. */
  importedFileIds: string[]
}

/**
 * Private Files pipeline boundary for authorized and idempotent external attachment imports.
 *
 * Implementations must condition the supplied link owner in the same transaction as File
 * ownership, and merge must move any import that committed before its owner revision changed.
 */
export interface ExternalChatSyncAttachmentPort {
  /** Imports authorized attachments and returns only server-issued scanned File IDs. */
  importAuthorizedAttachments(
    input: ExternalChatSyncImportAttachmentsInput,
  ): Promise<ExternalChatSyncImportAttachmentsResult>
}

/** Input for applying provider thread completion to a canonical Work Item. */
export type ExternalChatSyncSetWorkItemCompletionInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** External chat link that owns the lifecycle projection. */
  linkId: string
  /** Link revision that must still own the target Work Item when the transition commits. */
  expectedLinkRevision: number
  /** Team that owns the Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Requested completion state. */
  completed: boolean
  /** Last Work Item revision committed by lifecycle synchronization, when one exists. */
  expectedWorkItemRevision?: number
  /** Stable retry-safe operation identifier. */
  operationId: string
  /** Correlation identifier propagated from the provider event. */
  correlationId: string
  /** Provider occurrence timestamp. */
  occurredAt: string
}

/** Explicit result of applying an external completion state to a canonical Work Item. */
export type ExternalChatSyncSetWorkItemCompletionResult =
  | {
    /** The configured completion or reopen transition committed. */
    kind: 'applied'
    /** Work Item revision after the committed transition. */
    workItemRevision: number
  }
  | {
    /** The Work Item changed while the transition was being applied. */
    kind: 'revision-conflict'
    /** Current Work Item revision observed after the conflict. */
    workItemRevision: number
  }
  | {
    /** Current workflow configuration has no permitted transition for the requested state. */
    kind: 'unsupported-transition'
    /** Current unchanged Work Item revision. */
    workItemRevision: number
  }

/**
 * Work Item boundary used for inbound thread lifecycle synchronization.
 *
 * Implementations must condition the supplied link revision and Work Item owner with the workflow
 * transition. The external-chat lifecycle lease supplies the corresponding merge fence.
 */
export interface ExternalChatSyncWorkItemPort {
  /** Idempotently completes or reopens the linked canonical Work Item with explicit conflicts. */
  setCompletion(
    input: ExternalChatSyncSetWorkItemCompletionInput,
  ): Promise<ExternalChatSyncSetWorkItemCompletionResult>
}

/** Installation-scoped secret lookup for authenticated outbound origin markers. */
export interface ExternalChatSyncOriginSecretPort {
  /** Reads the current HMAC secret without persisting or logging its plaintext. */
  getSigningSecret(
    workspaceId: string,
    installationId: string,
    provider: ExternalChatProvider,
  ): Promise<string>
}

/** Safe idempotent audit record for one synchronization decision. */
export type ExternalChatSyncAuditRecord = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Provider name without raw provider object identifiers. */
  provider: ExternalChatProvider
  /** External chat link identifier when one resolved. */
  linkId?: string
  /** Digest of the external workspace, conversation, and thread identity. */
  sourceDigest: string
  /** Stable synchronization operation identifier. */
  operationId: string
  /** Provider event identifier for an inbound operation. */
  eventId?: string
  /** Correlation identifier propagated across the logical mutation. */
  correlationId: string
  /** Synchronization direction. */
  direction: 'inbound' | 'outbound'
  /** Secret-free logical action. */
  action: ExternalChatSyncAuditAction
  /** External actor kind, never a raw provider actor identifier. */
  externalActorKind?: ExternalChatActor['kind']
  /** Pseudonymous digest of the provider-scoped actor identity, never its raw identifier. */
  externalActorDigest?: string
  /** Internal principal identifier for an authorized outbound mutation. */
  internalPrincipalId?: string
  /** Final decision or mutation outcome. */
  outcome: ExternalChatSyncOutcome
}

/** Secret-free actions emitted by the synchronization audit boundary. */
export type ExternalChatSyncAuditAction =
  | 'source.viewed'
  | 'message.created'
  | 'message.edited'
  | 'message.deleted'
  | 'thread.completed'
  | 'thread.reopened'
  | 'source.lifecycle-changed'

/** Idempotent audit boundary keyed by the synchronization operation identifier. */
export interface ExternalChatSyncAuditPort {
  /** Appends or idempotently recovers one redacted synchronization record. */
  record(record: ExternalChatSyncAuditRecord): Promise<void>
}

/** Stable collaboration and provider failure categories understood by the service. */
export type ExternalChatSyncPortErrorCode =
  | 'ExternalChatSyncRateLimited'
  | 'ExternalChatSyncSourceUnavailable'
  | 'ExternalChatSyncRevisionConflict'
  | 'ExternalChatSyncPermissionDenied'
  | 'ExternalChatSyncTransientFailure'
  | 'ExternalChatSyncInvalidMutation'

/** Secret-free classified error raised by an injected synchronization port. */
export class ExternalChatSyncPortError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: ExternalChatSyncPortErrorCode

  /** Earliest safe retry timestamp for a rate limit. */
  readonly retryAt?: string

  /** Whether retrying the same logical operation may recover. */
  readonly retryable: boolean

  /**
   * Creates a classified synchronization port error.
   *
   * @param code - Stable machine-readable failure code.
   * @param message - Secret-free diagnostic message.
   * @param options - Retry classification and optional retry timestamp.
   */
  constructor(
    code: ExternalChatSyncPortErrorCode,
    message: string,
    options: {
      /** Whether retrying may recover. */
      retryable?: boolean
      /** Earliest safe retry timestamp. */
      retryAt?: string
    } = {},
  ) {
    super(message)
    this.name = 'ExternalChatSyncPortError'
    this.code = code
    this.retryAt = options.retryAt
    this.retryable = options.retryable ?? false
  }
}

/** Internal control-flow signal raised when a newer parent event wins before child commit. */
class ParentLifecycleFenceSupersededError extends Error {}

/** Verified inbound event plus runtime-only echo authentication material. */
export type ExternalChatSyncInboundInput = {
  /** Canonical Workspace identifier resolved from the webhook route. */
  workspaceId: string
  /** Provider-neutral event produced by a signature-verifying adapter. */
  event: ExternalChatInboundEvent
  /**
   * Provider authorization generation verified with a parent lifecycle webhook. A durable
   * retry may omit it only after the same event already committed its parent fence.
   */
  authorizationRevision?: number
  /** Signed provider-returned marker when the event claims an internal origin. */
  originMarker?: string
  /** Exact accepted link revision required by a durable resynchronization job. */
  expectedLinkRevision?: number
}

/** Clock boundary used to make leases, outcomes, and markers deterministic in tests. */
export interface ExternalChatSyncClockPort {
  /** Returns a canonical ISO 8601 UTC timestamp. */
  now(): string
}

/** Tunable bounded synchronization runtime behavior. */
export type ExternalChatSyncServiceOptions = {
  /** Inbound and outbound receipt lease duration in milliseconds. */
  receiptLeaseMs?: number
  /** Default retry delay for missing prerequisites and transient source failures. */
  deferDelayMs?: number
  /** Maximum accepted age of an echoed authenticated origin marker. */
  originMarkerMaxAgeMs?: number
  /** Maximum number of messages in one authorized source view. */
  maximumSourceViewMessages?: number
}

/** Required application and adapter boundaries for the synchronization service. */
export type ExternalChatSyncServiceDependencies = {
  /** Durable tenant-scoped chat synchronization store. */
  store: ExternalChatStore
  /** Registered Slack and Microsoft Teams provider adapters. */
  adapters: ChatProviderAdapterRegistry
  /** Internal and provider authorization boundary. */
  access: ExternalChatSyncAccessPort
  /** Application-issued source-view cursor codec. */
  cursorCodec: ExternalChatSyncCursorCodecPort
  /** Provider-aware per-message ordering policy. */
  messageOrder: ExternalChatSyncMessageOrderPort
  /** Provider-aware per-thread lifecycle ordering policy. */
  threadOrder: ExternalChatSyncThreadOrderPort
  /** Internal collaboration mutation boundary. */
  collaboration: ExternalChatSyncCollaborationPort
  /** Authorized private Files pipeline for provider attachment imports. */
  attachments: ExternalChatSyncAttachmentPort
  /** Canonical Work Item completion boundary. */
  workItems: ExternalChatSyncWorkItemPort
  /** Installation-scoped HMAC secret boundary. */
  originSecrets: ExternalChatSyncOriginSecretPort
  /** Redacted idempotent audit boundary. */
  audit: ExternalChatSyncAuditPort
  /** Deterministic clock boundary. */
  clock: ExternalChatSyncClockPort
}

/** Provider-neutral application service for permission-safe external chat synchronization. */
export class ExternalChatSyncService {
  /** Durable external chat synchronization store. */
  private readonly store: ExternalChatStore

  /** Registered provider adapters. */
  private readonly adapters: ChatProviderAdapterRegistry

  /** Internal and external authorization boundary. */
  private readonly access: ExternalChatSyncAccessPort

  /** Application cursor codec. */
  private readonly cursorCodec: ExternalChatSyncCursorCodecPort

  /** Provider-specific per-message order policy. */
  private readonly messageOrder: ExternalChatSyncMessageOrderPort

  /** Provider-specific thread lifecycle order policy. */
  private readonly threadOrder: ExternalChatSyncThreadOrderPort

  /** Collaboration mutation boundary. */
  private readonly collaboration: ExternalChatSyncCollaborationPort

  /** Authorized private Files attachment import boundary. */
  private readonly attachments: ExternalChatSyncAttachmentPort

  /** Canonical Work Item mutation boundary. */
  private readonly workItems: ExternalChatSyncWorkItemPort

  /** Origin-marker secret boundary. */
  private readonly originSecrets: ExternalChatSyncOriginSecretPort

  /** Redacted audit boundary. */
  private readonly audit: ExternalChatSyncAuditPort

  /** Deterministic clock boundary. */
  private readonly clock: ExternalChatSyncClockPort

  /** Receipt lease duration. */
  private readonly receiptLeaseMs: number

  /** Default deferred retry delay. */
  private readonly deferDelayMs: number

  /** Maximum accepted marker age. */
  private readonly originMarkerMaxAgeMs: number

  /** Maximum source-view page size. */
  private readonly maximumSourceViewMessages: number

  /**
   * Creates the external chat synchronization application service.
   *
   * @param dependencies - Required persistence, authorization, provider, domain, and audit ports.
   * @param options - Optional bounded runtime settings.
   */
  constructor(
    dependencies: ExternalChatSyncServiceDependencies,
    options: ExternalChatSyncServiceOptions = {},
  ) {
    this.store = dependencies.store
    this.adapters = dependencies.adapters
    this.access = dependencies.access
    this.cursorCodec = dependencies.cursorCodec
    this.messageOrder = dependencies.messageOrder
    this.threadOrder = dependencies.threadOrder
    this.collaboration = dependencies.collaboration
    this.attachments = dependencies.attachments
    this.workItems = dependencies.workItems
    this.originSecrets = dependencies.originSecrets
    this.audit = dependencies.audit
    this.clock = dependencies.clock
    this.receiptLeaseMs = positiveInteger(options.receiptLeaseMs, 30_000)
    this.deferDelayMs = positiveInteger(options.deferDelayMs, 30_000)
    this.originMarkerMaxAgeMs = positiveInteger(
      options.originMarkerMaxAgeMs,
      7 * 24 * 60 * 60 * 1_000,
    )
    this.maximumSourceViewMessages = positiveInteger(options.maximumSourceViewMessages, 100)
  }

  /**
   * Reads one external source page only after current internal and provider authorization succeed.
   *
   * @param input - Authenticated source-view request.
   * @returns Permission-filtered provider thread page with an application-issued cursor.
   */
  async getSourceView(
    input: ExternalChatSyncGetSourceViewInput,
  ): Promise<ExternalChatThreadSnapshot> {
    requirePositiveLimit(input.limit, this.maximumSourceViewMessages)
    const record = await this.requireActiveLink(input.principal.workspaceId, input.linkId)
    const startedAt = this.clock.now()
    const operationId = createSourceViewOperationId(
      record.link.id,
      input.principal.principalId,
      startedAt,
    )
    try {
    const scope = accessScope(record)
    if (!await this.access.canViewWorkItem(input.principal, scope)) {
      throw new ExternalChatError(
        'ExternalChatAuthorizationFailed',
        'The principal cannot view the linked Work Item.',
      )
    }
    const authorization = await this.access.getViewerProviderAuthorization(
      input.principal,
      record.link,
    )
    if (!authorization) {
      throw new ExternalChatError(
        'ExternalChatAuthorizationFailed',
        'Current provider authorization is required to view the external source.',
      )
    }
    validateAuthorization(record.link, authorization)
    const cursorScope: ExternalChatSyncCursorScope = {
      workspaceId: input.principal.workspaceId,
      principalId: input.principal.principalId,
      linkId: record.link.id,
      provider: record.link.provider,
      linkRevision: record.link.revision,
      authorizationRevision: authorization.authorizationRevision,
    }
    const providerCursor = input.cursor
      ? await this.cursorCodec.decode(cursorScope, input.cursor)
      : undefined
    let page: ChatProviderThreadPage
    try {
      const adapter = this.adapters.get(record.link.provider)
      page = normalizeChatProviderThreadPage(
        await adapter.readThreadPage({
          authorization,
          source: record.link.source,
          providerCursor,
          limit: input.limit,
        }),
        adapter.definition.permalinkHosts,
      )
    } catch (error: unknown) {
      if (isInstallationLevelProviderFailure(error)) {
        const occurredAt = this.clock.now()
        await this.reflectProviderFailure(
          input.principal.workspaceId,
          record,
          error,
          operationId,
          operationId,
          occurredAt,
        )
      }
      throw error
    }
    const currentRecord = await this.requireActiveLink(input.principal.workspaceId, input.linkId)
    if (!sameSourceViewOwner(record, currentRecord) ||
      !await this.access.canViewWorkItem(input.principal, accessScope(currentRecord))) {
      throw sourceViewAuthorizationChanged()
    }
    const currentAuthorization = await this.access.getViewerProviderAuthorization(
      input.principal,
      currentRecord.link,
    )
    if (!currentAuthorization) throw sourceViewAuthorizationChanged()
    validateAuthorization(currentRecord.link, currentAuthorization)
    if (!sameProviderAuthorization(authorization, currentAuthorization)) {
      throw sourceViewAuthorizationChanged()
    }
    validateThreadScope(currentRecord.link, page.thread)
    validateThreadPage(page, input.limit)
    const nextMessageCursor = page.providerCursor
      ? await this.cursorCodec.encode(cursorScope, page.providerCursor)
      : undefined
    const thread: ExternalChatThreadSnapshot = {
      ...page.thread,
      hasMoreMessages: page.providerCursor !== undefined,
      nextMessageCursor,
    }
    const now = this.clock.now()
    const outcome: ExternalChatSyncOutcome = {
      kind: 'applied',
      operationId,
      direction: 'inbound',
      occurredAt: now,
    }
    await this.audit.record({
      workspaceId: input.principal.workspaceId,
      provider: currentRecord.link.provider,
      linkId: currentRecord.link.id,
      sourceDigest: currentRecord.sourceDigest,
      operationId: outcome.operationId,
      correlationId: outcome.operationId,
      direction: 'inbound',
      action: 'source.viewed',
      internalPrincipalId: input.principal.principalId,
      outcome,
    })
    return thread
    } catch (error: unknown) {
      const outcome = classifyFailure(
        error,
        operationId,
        undefined,
        this.clock.now(),
        this.deferDelayMs,
      )
      await this.audit.record({
        workspaceId: input.principal.workspaceId,
        provider: record.link.provider,
        linkId: record.link.id,
        sourceDigest: record.sourceDigest,
        operationId,
        correlationId: operationId,
        direction: 'inbound',
        action: 'source.viewed',
        internalPrincipalId: input.principal.principalId,
        outcome,
      })
      throw error
    }
  }

  /**
   * Applies, deduplicates, or honestly defers one verified normalized provider event.
   *
   * @param input - Tenant scope, normalized event, and optional authenticated echo marker.
   * @returns Durable synchronization outcome.
   */
  async processInbound(input: ExternalChatSyncInboundInput): Promise<ExternalChatSyncOutcome> {
    return this.processInboundEvent(input, false)
  }

  /**
   * Applies one durable resynchronization snapshot while leaving the job-owned link projection
   * unchanged until its terminal checkpoint commits.
   *
   * @param input - Synthetic, stable provider-neutral event created by the resync worker.
   * @returns Durable synchronization outcome.
   */
  async processResyncSnapshot(
    input: ExternalChatSyncInboundInput,
  ): Promise<ExternalChatSyncOutcome> {
    return this.processInboundEvent(input, true)
  }

  /**
   * Applies one verified normalized event with an explicit link-projection policy.
   *
   * @param input - Tenant scope and provider-neutral inbound event.
   * @param preserveResyncProjection - Whether a resync checkpoint owns the pending link status.
   * @returns Durable synchronization outcome.
   */
  private async processInboundEvent(
    input: ExternalChatSyncInboundInput,
    preserveResyncProjection: boolean,
  ): Promise<ExternalChatSyncOutcome> {
    const eventAdapter = this.adapters.get(input.event.provider)
    const event = normalizeChatProviderInboundEvent(
      input.event,
      eventAdapter.definition.permalinkHosts,
    )
    const operationId = createExternalChatInboundOperationId(input.workspaceId, event)
    const receiptFingerprint = createExternalChatFingerprint({
      event,
      originMarker: input.originMarker,
    })
    const deferredFingerprint = createExternalChatFingerprint(event)
    const claimedAt = this.clock.now()
    const claim = await this.store.claimInboundEvent({
      workspaceId: input.workspaceId,
      installationId: event.installationId,
      provider: event.provider,
      eventId: event.eventId,
      fingerprint: receiptFingerprint,
      operationId,
      claimedAt,
      leaseExpiresAt: addMilliseconds(claimedAt, this.receiptLeaseMs),
    })
    if (claim.kind === 'conflict') {
      throw new ExternalChatError(
        'ExternalChatEventConflict',
        'The provider event ID was reused with another normalized payload.',
      )
    }
    if (claim.kind === 'busy') {
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'Another processor owns the provider event lease.',
        true,
      )
    }
    if (claim.kind === 'duplicate') {
      if (!claim.receipt.outcome) {
        throw new ExternalChatError(
          'ExternalChatPersistenceFailed',
          'The completed inbound receipt has no outcome.',
        )
      }
      const duplicateSource = sourceIdentity(event)
      const duplicateRecord = isParentLifecycleEvent(event)
        ? undefined
        : await this.store.getLinkBySource(input.workspaceId, duplicateSource)
      if (duplicateRecord) {
        await this.acknowledgeCompletedThreadLifecycle(
          input.workspaceId,
          duplicateRecord,
          operationId,
        )
      }
      await this.recordInboundAudit(
        input.workspaceId,
        event,
        operationId,
        duplicateSource,
        duplicateRecord,
        claim.receipt.outcome,
      )
      await this.deleteTerminalDeferredEvent(input.workspaceId, event, claim.receipt.outcome)
      return claim.receipt.outcome
    }

    if (isParentLifecycleEvent(event)) {
      return this.processParentLifecycleFanout(
        input.workspaceId,
        event,
        input.authorizationRevision,
        operationId,
        claim.receipt,
      )
    }

    const source = sourceIdentity(event)
    const record = await this.store.getLinkBySource(input.workspaceId, source)
    if (!record || !record.active) {
      const outcome = skippedOutcome(operationId, event.eventId, 'unlinked', claimedAt)
      return this.completeInbound(
        input.workspaceId,
        event,
        operationId,
        claim.receipt.attempt,
        source,
        undefined,
        outcome,
      )
    }

    try {
      validateInboundScope(record, event)
      if (
        input.expectedLinkRevision !== undefined &&
        record.link.revision !== input.expectedLinkRevision
      ) {
        throw new ExternalChatSyncPortError(
          'ExternalChatSyncRevisionConflict',
          'The resynchronization link ownership changed before the snapshot was applied.',
          { retryable: true },
        )
      }
      if (event.type !== 'source.lifecycle-changed') {
        if (linkForbidsContentSynchronization(record.link)) {
          await this.redactRestrictiveLinkResources(
            input.workspaceId,
            record,
            record.link.sourceAvailability,
            record.link.sourceState,
            operationId,
            inboundCorrelationId(event.correlationId),
            event.occurredAt,
            event.eventId,
          )
          const outcome = skippedOutcome(operationId, event.eventId, 'paused', claimedAt)
          return this.completeInbound(
            input.workspaceId,
            event,
            operationId,
            claim.receipt.attempt,
            source,
            record,
            outcome,
          )
        }
      }
      if (event.type !== 'source.lifecycle-changed' && !allowsInbound(record.link.syncDirection)) {
        const outcome = skippedOutcome(operationId, event.eventId, 'paused', claimedAt)
        return this.completeInbound(
          input.workspaceId,
          event,
          operationId,
          claim.receipt.attempt,
          source,
          record,
          outcome,
        )
      }
      if (
        event.type !== 'source.lifecycle-changed' &&
        record.link.sourceAvailability !== 'available'
      ) {
        return this.deferInbound(
          input.workspaceId,
          event,
          operationId,
          deferredFingerprint,
          record,
          claim.receipt.attempt,
        )
      }
      const echoOutcome = await this.handleInboundEcho({
        workspaceId: input.workspaceId,
        event,
        ...(input.originMarker === undefined ? {} : { originMarker: input.originMarker }),
      }, record, operationId)
      if (echoOutcome) {
        // An origin marker is runtime-only authentication material. Authenticated echo
        // deferrals keep only their receipt; provider redelivery must present the marker again
        // after retryAt because a markerless deferred-event row could not be authenticated.
        return this.completeInbound(
          input.workspaceId,
          event,
          operationId,
          claim.receipt.attempt,
          source,
          record,
          echoOutcome,
        )
      }
      if (event.type !== 'source.lifecycle-changed' && isUnavailableEvent(event)) {
        return this.deferInbound(
          input.workspaceId,
          event,
          operationId,
          deferredFingerprint,
          record,
          claim.receipt.attempt,
        )
      }

      const outcome = await this.applyInboundEvent(
        input.workspaceId,
        record,
        event,
        operationId,
        preserveResyncProjection,
      )
      if (outcome.kind === 'deferred') {
        await this.store.deferEvent({
          workspaceId: input.workspaceId,
          linkId: record.link.id,
          event,
          fingerprint: deferredFingerprint,
          reason: outcome.reason,
          attempt: claim.receipt.attempt,
          retryAt: outcome.retryAt ?? addMilliseconds(claimedAt, this.deferDelayMs),
          createdAt: claimedAt,
          updatedAt: claimedAt,
        })
      }
      return this.completeInbound(
        input.workspaceId,
        event,
        operationId,
        claim.receipt.attempt,
        source,
        record,
        outcome,
      )
    } catch (error: unknown) {
      let outcome = classifyFailure(
        error,
        operationId,
        event.eventId,
        this.clock.now(),
        this.deferDelayMs,
      )
      if (!preserveResyncProjection) {
        try {
          await this.reflectProviderFailure(
            input.workspaceId,
            record,
            error,
            operationId,
            inboundCorrelationId(event.correlationId),
            event.occurredAt,
            event.eventId,
          )
        } catch (projectionError: unknown) {
          outcome = classifyFailure(
            projectionError,
            operationId,
            event.eventId,
            this.clock.now(),
            this.deferDelayMs,
          )
        }
      }
      if (outcome.kind === 'deferred') {
        await this.store.deferEvent({
          workspaceId: input.workspaceId,
          linkId: record.link.id,
          event,
          fingerprint: deferredFingerprint,
          reason: outcome.reason,
          attempt: claim.receipt.attempt,
          retryAt: outcome.retryAt ?? addMilliseconds(claimedAt, this.deferDelayMs),
          createdAt: claimedAt,
          updatedAt: claimedAt,
        })
      }
      return this.completeInbound(
        input.workspaceId,
        event,
        operationId,
        claim.receipt.attempt,
        source,
        record,
        outcome,
      )
    }
  }

  /**
   * Fans one workspace/conversation lifecycle event across every installation-owned active link.
   *
   * Each link uses a derived child receipt, so a crash before a page checkpoint cannot repeat
   * link projection, cascade, or deferred-content purge side effects.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param event - Normalized provider parent lifecycle event.
   * @param authorizationRevision - Verified provider authorization generation, when first seen.
   * @param operationId - Stable parent receipt operation identifier.
   * @param receipt - Claimed outer receipt containing the durable page checkpoint.
   * @returns Durable parent synchronization outcome.
   */
  private async processParentLifecycleFanout(
    workspaceId: string,
    event: ExternalChatParentLifecycleEvent,
    authorizationRevision: number | undefined,
    operationId: string,
    receipt: ExternalChatInboundReceipt,
  ): Promise<ExternalChatSyncOutcome> {
    const startedAt = this.clock.now()
    let cursor = receipt.parentLifecycleCursor
    let processedLinkCount = 0
    let retryLink: StoredExternalChatLink | undefined
    try {
      validateParentLifecycleEventScope(event)
      const fence = await this.store.fenceParentLifecycle({
        workspaceId,
        provider: event.provider,
        installationId: event.installationId,
        externalWorkspaceId: event.externalWorkspaceId,
        ...(event.resourceType === 'conversation'
          ? { conversationExternalId: event.conversationExternalId }
          : {}),
        ...(authorizationRevision === undefined ? {} : { authorizationRevision }),
        restrictive: mustRedactLifecycleMetadata(event),
        eventId: event.eventId,
        operationId,
        occurredAt: event.occurredAt,
      })
      if (fence.kind === 'stale') {
        return this.completeInbound(
          workspaceId,
          event,
          operationId,
          receipt.attempt,
          sourceIdentity(event),
          undefined,
          skippedOutcome(operationId, event.eventId, 'stale', this.clock.now()),
        )
      }
      for (;;) {
        const page = await this.store.listParentLinks({
          workspaceId,
          provider: event.provider,
          installationId: event.installationId,
          externalWorkspaceId: event.externalWorkspaceId,
          ...(event.resourceType === 'conversation'
            ? { conversationExternalId: event.conversationExternalId }
            : {}),
          maximumSourceAuthorizationRevision: fence.fence.authorizationRevision,
          ...(cursor === undefined ? {} : { cursor }),
          limit: PARENT_LIFECYCLE_FANOUT_PAGE_SIZE,
        })
        for (const listed of page.links) {
          retryLink = listed
          const childOutcome = await this.processParentLifecycleChild(
            workspaceId,
            listed,
            event,
            fence.fence,
          )
          if (childOutcome.kind === 'deferred') {
            const retryAt = childOutcome.retryAt ?? addMilliseconds(
              this.clock.now(),
              this.deferDelayMs,
            )
            await this.deferParentLifecycleFanout(
              workspaceId,
              listed,
              event,
              receipt.attempt,
              childOutcome.reason,
              retryAt,
              startedAt,
            )
            return this.completeInbound(
              workspaceId,
              event,
              operationId,
              receipt.attempt,
              sourceIdentity(event),
              undefined,
              deferredOutcome(
                operationId,
                event.eventId,
                childOutcome.reason,
                this.clock.now(),
                retryAt,
              ),
            )
          }
          if (childOutcome.kind === 'failed') {
            const outcome = childOutcome.retryable
              ? deferredOutcome(
                operationId,
                event.eventId,
                'source-unavailable',
                this.clock.now(),
                addMilliseconds(this.clock.now(), this.deferDelayMs),
              )
              : failedOutcome(
                operationId,
                event.eventId,
                childOutcome.errorCode,
                false,
                this.clock.now(),
              )
            if (outcome.kind === 'deferred') {
              await this.deferParentLifecycleFanout(
                workspaceId,
                listed,
                event,
                receipt.attempt,
                outcome.reason,
                outcome.retryAt ?? addMilliseconds(this.clock.now(), this.deferDelayMs),
                startedAt,
              )
            }
            return this.completeInbound(
              workspaceId,
              event,
              operationId,
              receipt.attempt,
              sourceIdentity(event),
              undefined,
              outcome,
            )
          }
          processedLinkCount += 1
        }
        if (page.nextCursor === undefined) break
        const checkpointedAt = this.clock.now()
        const checkpointed = await this.store.checkpointInboundEvent({
          workspaceId,
          installationId: event.installationId,
          provider: event.provider,
          eventId: event.eventId,
          operationId,
          expectedAttempt: receipt.attempt,
          ...(cursor === undefined ? {} : { expectedCursor: cursor }),
          nextCursor: page.nextCursor,
          checkpointedAt,
          leaseExpiresAt: addMilliseconds(checkpointedAt, this.receiptLeaseMs),
        })
        if (!checkpointed) {
          throw new ExternalChatError(
            'ExternalChatPersistenceFailed',
            'The parent lifecycle fan-out checkpoint lease was lost.',
            true,
          )
        }
        cursor = page.nextCursor
      }
      const outcome = processedLinkCount === 0
        ? skippedOutcome(operationId, event.eventId, 'unlinked', this.clock.now())
        : appliedOutcome(operationId, event.eventId, 'inbound', this.clock.now())
      return this.completeInbound(
        workspaceId,
        event,
        operationId,
        receipt.attempt,
        sourceIdentity(event),
        undefined,
        outcome,
      )
    } catch (error: unknown) {
      const outcome = classifyFailure(
        error,
        operationId,
        event.eventId,
        this.clock.now(),
        this.deferDelayMs,
      )
      if (outcome.kind === 'deferred' && retryLink !== undefined) {
        await this.deferParentLifecycleFanout(
          workspaceId,
          retryLink,
          event,
          receipt.attempt,
          outcome.reason,
          outcome.retryAt ?? addMilliseconds(this.clock.now(), this.deferDelayMs),
          startedAt,
        )
      }
      return this.completeInbound(
        workspaceId,
        event,
        operationId,
        receipt.attempt,
        sourceIdentity(event),
        undefined,
        outcome,
      )
    }
  }

  /**
   * Applies one parent lifecycle child through its own exact receipt.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param listed - Link returned by the parent sparse lookup.
   * @param parentEvent - Original normalized provider parent event.
   * @param parentFence - Exact durable parent authority that must remain current.
   * @returns Exact child outcome retained across page replay.
   */
  private async processParentLifecycleChild(
    workspaceId: string,
    listed: StoredExternalChatLink,
    parentEvent: ExternalChatParentLifecycleEvent,
    parentFence: ExternalChatParentLifecycleFence,
  ): Promise<ExternalChatSyncOutcome> {
    const event = createParentLifecycleChildEvent(parentEvent, listed.link.id)
    const operationId = createExternalChatInboundOperationId(workspaceId, event)
    const claimedAt = this.clock.now()
    const claim = await this.store.claimInboundEvent({
      workspaceId,
      installationId: event.installationId,
      provider: event.provider,
      eventId: event.eventId,
      fingerprint: createExternalChatFingerprint(event),
      operationId,
      claimedAt,
      leaseExpiresAt: addMilliseconds(claimedAt, this.receiptLeaseMs),
    })
    if (claim.kind === 'conflict') {
      throw new ExternalChatError(
        'ExternalChatEventConflict',
        'A parent lifecycle child receipt was reused with another link payload.',
      )
    }
    if (claim.kind === 'busy') {
      return deferredOutcome(
        operationId,
        event.eventId,
        'out-of-order',
        claimedAt,
        claim.receipt.leaseExpiresAt,
      )
    }
    const source = linkSourceIdentity(listed.link)
    if (claim.kind === 'duplicate') {
      if (!claim.receipt.outcome) {
        throw new ExternalChatError(
          'ExternalChatPersistenceFailed',
          'The completed parent lifecycle child receipt has no outcome.',
        )
      }
      await this.recordInboundAudit(
        workspaceId,
        event,
        operationId,
        source,
        listed,
        claim.receipt.outcome,
      )
      return claim.receipt.outcome
    }
    const current = await this.store.getLink(workspaceId, listed.link.id)
    let outcome: ExternalChatSyncOutcome
    if (!current || !current.active) {
      outcome = skippedOutcome(operationId, event.eventId, 'unlinked', claimedAt)
    } else if (
      current.sourceAuthorizationRevision > parentFence.authorizationRevision
    ) {
      outcome = skippedOutcome(operationId, event.eventId, 'stale', claimedAt)
    } else {
      try {
        validateParentLifecycleLinkScope(current.link, parentEvent)
        outcome = await this.applyInboundLifecycle(
          workspaceId,
          current,
          event,
          operationId,
          parentEvent.eventId,
          parentFence,
        )
      } catch (error: unknown) {
        outcome = error instanceof ParentLifecycleFenceSupersededError
          ? skippedOutcome(operationId, event.eventId, 'stale', this.clock.now())
          : classifyFailure(
            error,
            operationId,
            event.eventId,
            this.clock.now(),
            this.deferDelayMs,
          )
      }
    }
    return this.completeInbound(
      workspaceId,
      event,
      operationId,
      claim.receipt.attempt,
      source,
      current,
      outcome,
    )
  }

  /**
   * Stores a retryable parent event without retaining message content.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Link used as the durable retry-worker anchor.
   * @param event - Parent lifecycle event.
   * @param attempt - Current outer receipt attempt.
   * @param reason - Honest retry classification.
   * @param retryAt - Earliest safe retry timestamp.
   * @param createdAt - Parent processing start timestamp.
   */
  private async deferParentLifecycleFanout(
    workspaceId: string,
    record: StoredExternalChatLink,
    event: ExternalChatParentLifecycleEvent,
    attempt: number,
    reason: Extract<ExternalChatSyncOutcome, { kind: 'deferred' }>['reason'],
    retryAt: string,
    createdAt: string,
  ): Promise<void> {
    await this.store.deferEvent({
      workspaceId,
      linkId: record.link.id,
      event,
      fingerprint: createExternalChatFingerprint(event),
      reason,
      attempt,
      retryAt,
      createdAt,
      updatedAt: this.clock.now(),
    })
  }

  /**
   * Applies, deduplicates, or honestly defers one explicitly eligible internal mutation.
   *
   * @param event - Trusted internal collaboration or Work Item event.
   * @returns Durable synchronization outcome.
   */
  async processOutbound(event: ExternalChatSyncOutboundEvent): Promise<ExternalChatSyncOutcome> {
    const operationId = createOutboundOperationId(event)
    const fingerprint = createExternalChatFingerprint(event)
    const claimedAt = this.clock.now()
    const record = await this.resolveOutboundRecord(event)
    if (!record) {
      return skippedOutcome(operationId, undefined, 'unlinked', claimedAt)
    }
    const claim = await this.store.claimOutboundOperation({
      workspaceId: event.workspaceId,
      linkId: event.linkId,
      operationId,
      fingerprint,
      claimedAt,
      leaseExpiresAt: addMilliseconds(claimedAt, this.receiptLeaseMs),
    })
    if (claim.kind === 'conflict') {
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'The outbound operation ID was reused with another mutation.',
      )
    }
    if (claim.kind === 'busy') {
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'Another processor owns the outbound operation lease.',
        true,
      )
    }
    if (claim.kind === 'duplicate') {
      if (!claim.receipt.outcome) {
        throw new ExternalChatError(
          'ExternalChatPersistenceFailed',
          'The completed outbound receipt has no outcome.',
        )
      }
      await this.acknowledgeCompletedThreadLifecycle(event.workspaceId, record, operationId)
      await this.recordOutboundAudit(event, record, operationId, claim.receipt.outcome)
      await this.deleteTerminalDeferredOutboundEvent(event, operationId, claim.receipt.outcome)
      return claim.receipt.outcome
    }

    if (!record.active) {
      return this.completeOutbound(
        event,
        record,
        operationId,
        claim.receipt.attempt,
        skippedOutcome(operationId, undefined, 'unlinked', claimedAt),
      )
    }

    const queuedHead = (await this.store.listDeferredOutboundEvents(
      event.workspaceId,
      event.linkId,
      1,
    ))[0]
    let outcome: ExternalChatSyncOutcome
    try {
      if (!event.externalSyncEligible) {
        outcome = skippedOutcome(operationId, undefined, 'not-eligible', claimedAt)
      } else if (linkForbidsContentSynchronization(record.link)) {
        await this.redactRestrictiveLinkResources(
          event.workspaceId,
          record,
          record.link.sourceAvailability,
          record.link.sourceState,
          operationId,
          event.correlationId,
          event.occurredAt,
        )
        outcome = skippedOutcome(operationId, undefined, 'paused', claimedAt)
      } else if (!allowsOutbound(record.link.syncDirection)) {
        outcome = skippedOutcome(operationId, undefined, 'paused', claimedAt)
      } else if (queuedHead && queuedHead.operationId !== operationId) {
        outcome = deferredOutcome(
          operationId,
          undefined,
          'source-unavailable',
          claimedAt,
          queuedHead.retryAt,
        )
      } else if (
        record.link.sourceAvailability === 'temporarily-unavailable' &&
        queuedHead?.operationId !== operationId
      ) {
        outcome = deferredOutcome(
          operationId,
          undefined,
          'source-unavailable',
          claimedAt,
          normalizeExternalChatRetryAt(
            claimedAt,
            operationId,
            undefined,
            this.deferDelayMs,
          ),
        )
      } else if (
        record.link.sourceState === 'deleted' ||
        record.link.sourceState === 'retention-expired'
      ) {
        outcome = deferredOutcome(
          operationId,
          undefined,
          'source-unavailable',
          claimedAt,
          normalizeExternalChatRetryAt(
            claimedAt,
            operationId,
            undefined,
            this.deferDelayMs,
          ),
        )
      } else {
        const principal: ExternalChatSyncPrincipal = {
          workspaceId: event.workspaceId,
          principalId: event.principalId,
        }
        outcome = await this.access.canSyncOutbound(principal, accessScope(record))
          ? await this.applyOutboundEvent(record, event, operationId)
          : failedOutcome(
            operationId,
            undefined,
            'ExternalChatAuthorizationFailed',
            false,
            this.clock.now(),
          )
      }
    } catch (error: unknown) {
      outcome = classifyFailure(
        error,
        operationId,
        undefined,
        this.clock.now(),
        this.deferDelayMs,
      )
      try {
        await this.reflectProviderFailure(
          event.workspaceId,
          record,
          error,
          operationId,
          event.correlationId,
          event.occurredAt,
        )
      } catch (projectionError: unknown) {
        outcome = classifyFailure(
          projectionError,
          operationId,
          undefined,
          this.clock.now(),
          this.deferDelayMs,
        )
      }
    }
    return this.completeOutbound(event, record, operationId, claim.receipt.attempt, outcome)
  }

  /**
   * Authenticates a claimed internal origin and waits for its outbound receipt before suppressing it.
   * Deferred echoes rely on marker-bearing provider redelivery because markers are never persisted.
   *
   * @param input - Inbound event and returned provider marker.
   * @param record - Active source-owning link.
   * @param operationId - Current inbound operation identifier.
   * @returns Echo outcome, or undefined for a genuinely external event.
   */
  private async handleInboundEcho(
    input: ExternalChatSyncInboundInput,
    record: StoredExternalChatLink,
    operationId: string,
  ): Promise<ExternalChatSyncOutcome | undefined> {
    const claimedOrigin = input.event.originOperationId
    if (!claimedOrigin && !input.originMarker) return undefined
    const now = this.clock.now()
    if (!claimedOrigin || !input.originMarker) {
      return failedOutcome(
        operationId,
        input.event.eventId,
        'ExternalChatInvalidOriginMarker',
        false,
        now,
      )
    }
    const secret = await this.originSecrets.getSigningSecret(
      input.workspaceId,
      input.event.installationId,
      input.event.provider,
    )
    const marker = verifyChatProviderOriginMarker(
      input.originMarker,
      {
        provider: input.event.provider,
        installationId: input.event.installationId,
        linkId: record.link.id,
        now,
        maxAgeMs: this.originMarkerMaxAgeMs,
      },
      secret,
    )
    if (!marker || marker.operationId !== claimedOrigin) {
      return failedOutcome(
        operationId,
        input.event.eventId,
        'ExternalChatInvalidOriginMarker',
        false,
        now,
      )
    }
    if (marker.action !== input.event.type) {
      return failedOutcome(
        operationId,
        input.event.eventId,
        'ExternalChatInvalidOriginMarker',
        false,
        now,
      )
    }
    const completed = await this.store.hasCompletedOutboundOperation(
      input.workspaceId,
      record.link.id,
      marker.operationId,
    )
    if (completed && await this.matchesCompletedEchoResource(
      input.workspaceId,
      record,
      input.event,
      marker,
    )) {
      return skippedOutcome(operationId, input.event.eventId, 'self-origin', now)
    }
    if (completed) {
      return failedOutcome(
        operationId,
        input.event.eventId,
        'ExternalChatInvalidOriginMarker',
        false,
        now,
      )
    }
    return deferredOutcome(
      operationId,
      input.event.eventId,
      'out-of-order',
      now,
      addMilliseconds(now, this.deferDelayMs),
    )
  }

  /**
   * Binds a completed marker to the exact provider message revision or thread lifecycle result.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Link that owns the echoed provider resource.
   * @param event - Normalized provider event claiming internal origin.
   * @param marker - Authenticated action- and operation-scoped marker.
   * @returns Whether durable outbound state proves this exact resource echo.
   */
  private async matchesCompletedEchoResource(
    workspaceId: string,
    record: StoredExternalChatLink,
    event: ExternalChatInboundEvent,
    marker: ChatProviderOriginMarker,
  ): Promise<boolean> {
    if (event.type === 'source.lifecycle-changed') return false
    if (event.type === 'thread.completed' || event.type === 'thread.reopened') {
      const lifecycle = await this.store.getThreadLifecycle(
        workspaceId,
        record.link.id,
        record.link.provider,
      )
      return lifecycle?.lease.operationId === marker.operationId &&
        lifecycle.state.completed === (event.type === 'thread.completed') &&
        lifecycle.state.lastExternalVersion === event.externalVersion
    }
    const externalMessageId = event.type === 'message.deleted'
      ? event.externalMessageId
      : event.message.externalId
    const externalVersion = event.type === 'message.deleted'
      ? event.externalVersion
      : event.message.externalVersion
    const binding = await this.store.getMessageBindingByExternalId(
      workspaceId,
      record.link.id,
      externalMessageId,
    )
    return binding?.binding.lastOutboundOperationId === marker.operationId &&
      binding.binding.externalVersion === externalVersion
  }

  /**
   * Applies one non-echo inbound event after receipt, scope, and direction checks.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Active source-owning link.
   * @param event - Verified provider-neutral event.
   * @param operationId - Stable inbound operation identifier.
   * @param preserveResyncProjection - Whether the resync worker owns the pending link status.
   * @returns Applied, skipped, or deferred outcome.
   */
  private async applyInboundEvent(
    workspaceId: string,
    record: StoredExternalChatLink,
    event: ExternalChatInboundEvent,
    operationId: string,
    preserveResyncProjection: boolean,
  ): Promise<ExternalChatSyncOutcome> {
    let authorization: ChatProviderAuthorization | undefined
    if (event.type !== 'source.lifecycle-changed') {
      authorization = await this.access.getInstallationProviderAuthorization(
        workspaceId,
        record.link,
      )
      if (!authorization) {
        throw new ExternalChatSyncPortError(
          'ExternalChatSyncSourceUnavailable',
          'Current installation authorization is unavailable.',
          { retryable: true },
        )
      }
      validateAuthorization(record.link, authorization)
    }
    switch (event.type) {
      case 'message.created':
      case 'message.edited':
        if (!authorization) throw missingInstallationAuthorizationError()
        return this.applyInboundMessage(
          workspaceId,
          record,
          event,
          operationId,
          authorization,
          preserveResyncProjection,
        )
      case 'message.deleted':
        return this.applyInboundMessageDeletion(workspaceId, record, event, operationId)
      case 'thread.completed':
        return this.applyInboundThreadCompletion(
          workspaceId,
          record,
          true,
          event.completedAt,
          event,
          operationId,
        )
      case 'thread.reopened':
        return this.applyInboundThreadCompletion(
          workspaceId,
          record,
          false,
          event.reopenedAt,
          event,
          operationId,
        )
      case 'source.lifecycle-changed':
        return this.applyInboundLifecycle(workspaceId, record, event, operationId)
    }
  }

  /**
   * Creates or edits a bound internal comment with provider-aware version ordering.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Active source-owning link.
   * @param event - External message creation or edit.
   * @param operationId - Stable inbound operation identifier.
   * @param authorization - Current matching installation authorization.
   * @param preserveResyncProjection - Whether the resync worker owns the pending link status.
   * @returns Synchronization outcome.
   */
  private async applyInboundMessage(
    workspaceId: string,
    record: StoredExternalChatLink,
    event: Extract<ExternalChatInboundEvent, { type: 'message.created' | 'message.edited' }>,
    operationId: string,
    authorization: ChatProviderAuthorization,
    preserveResyncProjection: boolean,
  ): Promise<ExternalChatSyncOutcome> {
    validateMessageScope(record.link, event.message)
    const now = this.clock.now()
    if (
      event.message.availability !== 'available' ||
      event.message.state !== 'active' ||
      event.message.bodyMarkdown === undefined ||
      event.message.permalink === undefined
    ) {
      return deferredOutcome(
        operationId,
        event.eventId,
        'source-unavailable',
        now,
        addMilliseconds(now, this.deferDelayMs),
      )
    }
    const current = await this.store.getMessageBindingByExternalId(
      workspaceId,
      record.link.id,
      event.message.externalId,
    )
    if (current?.binding.lastInboundEventId === event.eventId) {
      if (!preserveResyncProjection) {
        await this.markLinkSynchronized(workspaceId, record, now)
      }
      return appliedOutcome(operationId, event.eventId, 'inbound', now)
    }
    if (event.type === 'message.edited' && !current) {
      return deferredOutcome(
        operationId,
        event.eventId,
        'out-of-order',
        now,
        addMilliseconds(now, this.deferDelayMs),
      )
    }
    const parent = event.type === 'message.created' &&
        !current &&
        event.message.parentMessageExternalId
      ? await this.store.getMessageBindingByExternalId(
        workspaceId,
        record.link.id,
        event.message.parentMessageExternalId,
      )
      : undefined
    if (
      event.type === 'message.created' &&
      !current &&
      event.message.parentMessageExternalId !== undefined &&
      !parent
    ) {
      return deferredOutcome(
        operationId,
        event.eventId,
        'out-of-order',
        now,
        addMilliseconds(now, this.deferDelayMs),
      )
    }
    const order = await this.decideMessageOrder(record, event, current)
    if (order === 'stale') {
      return skippedOutcome(operationId, event.eventId, 'stale', now)
    }
    if (order === 'defer') {
      return deferredOutcome(
        operationId,
        event.eventId,
        'out-of-order',
        now,
        addMilliseconds(now, this.deferDelayMs),
      )
    }
    const attachments = event.message.attachments.map(
      copyExternalAttachmentWithoutImportedFileId,
    )
    const imported = await this.attachments.importAuthorizedAttachments({
      workspaceId,
      teamId: record.link.teamId,
      workItemId: record.link.workItemId,
      linkId: record.link.id,
      expectedLinkRevision: record.link.revision,
      provider: record.link.provider,
      authorization,
      externalMessageId: event.message.externalId,
      attachments,
      operationId,
      correlationId: inboundCorrelationId(event.correlationId),
      occurredAt: event.occurredAt,
    })
    const importedFileIds = uniqueInternalFileIds(imported.importedFileIds)
    const source = commentSource(
      record.link.provider,
      record.link.id,
      event.message,
      attachments,
    )
    const mutation = current
      ? await this.collaboration.updateExternalComment({
        workspaceId,
        linkId: record.link.id,
        expectedLinkRevision: record.link.revision,
        teamId: record.link.teamId,
        workItemId: record.link.workItemId,
        operationId,
        correlationId: inboundCorrelationId(event.correlationId),
        occurredAt: event.occurredAt,
        commentId: current.binding.internalCommentId,
        expectedVersion: current.binding.internalCommentVersion,
        bodyMarkdown: event.message.bodyMarkdown,
        source,
      })
      : await this.collaboration.createExternalComment({
        workspaceId,
        linkId: record.link.id,
        expectedLinkRevision: record.link.revision,
        teamId: record.link.teamId,
        workItemId: record.link.workItemId,
        operationId,
        correlationId: inboundCorrelationId(event.correlationId),
        occurredAt: event.occurredAt,
        bodyMarkdown: event.message.bodyMarkdown,
        parentCommentId: parent?.binding.internalCommentId,
        source,
      })
    const binding: ExternalChatMessageBinding = current
      ? {
        ...current.binding,
        externalVersion: event.message.externalVersion,
        internalCommentVersion: mutation.version,
        lastInboundEventId: event.eventId,
        importedFileIds: uniqueStrings([
          ...current.binding.importedFileIds,
          ...importedFileIds,
        ]),
        updatedAt: now,
      }
      : {
        schemaVersion: 1,
        linkId: record.link.id,
        externalMessageId: event.message.externalId,
        internalCommentId: mutation.commentId,
        origin: 'external',
        externalVersion: event.message.externalVersion,
        internalCommentVersion: mutation.version,
        lastInboundEventId: event.eventId,
        importedFileIds,
        createdAt: now,
        updatedAt: now,
      }
    await this.putBinding(workspaceId, record, binding, current)
    if (!preserveResyncProjection) {
      await this.markLinkSynchronized(workspaceId, record, now)
    }
    return appliedOutcome(operationId, event.eventId, 'inbound', now)
  }

  /**
   * Applies an external message tombstone to its bound internal comment.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Active source-owning link.
   * @param event - External message deletion event.
   * @param operationId - Stable inbound operation identifier.
   * @returns Synchronization outcome.
   */
  private async applyInboundMessageDeletion(
    workspaceId: string,
    record: StoredExternalChatLink,
    event: Extract<ExternalChatInboundEvent, { type: 'message.deleted' }>,
    operationId: string,
  ): Promise<ExternalChatSyncOutcome> {
    const now = this.clock.now()
    const current = await this.store.getMessageBindingByExternalId(
      workspaceId,
      record.link.id,
      event.externalMessageId,
    )
    if (!current) {
      return deferredOutcome(
        operationId,
        event.eventId,
        'out-of-order',
        now,
        addMilliseconds(now, this.deferDelayMs),
      )
    }
    if (current.binding.lastInboundEventId === event.eventId) {
      await this.markLinkSynchronized(workspaceId, record, now)
      return appliedOutcome(operationId, event.eventId, 'inbound', now)
    }
    const order = await this.messageOrder.decide({
      provider: record.link.provider,
      linkId: record.link.id,
      externalMessageId: event.externalMessageId,
      previousExternalVersion: current.binding.externalVersion,
      incomingExternalVersion: event.externalVersion,
      externalSequence: event.externalSequence,
      occurredAt: event.occurredAt,
    })
    if (order === 'stale') {
      return skippedOutcome(operationId, event.eventId, 'stale', now)
    }
    if (order === 'defer') {
      return deferredOutcome(
        operationId,
        event.eventId,
        'out-of-order',
        now,
        addMilliseconds(now, this.deferDelayMs),
      )
    }
    const mutation = await this.collaboration.deleteExternalComment({
      workspaceId,
      linkId: record.link.id,
      expectedLinkRevision: record.link.revision,
      teamId: record.link.teamId,
      workItemId: record.link.workItemId,
      operationId,
      correlationId: inboundCorrelationId(event.correlationId),
      occurredAt: event.deletedAt,
      commentId: current.binding.internalCommentId,
      expectedVersion: current.binding.internalCommentVersion,
    })
    const binding: ExternalChatMessageBinding = {
      ...current.binding,
      externalVersion: event.externalVersion,
      internalCommentVersion: mutation.version,
      lastInboundEventId: event.eventId,
      deletedAt: event.deletedAt,
      updatedAt: now,
    }
    await this.putBinding(workspaceId, record, binding, current)
    await this.markLinkSynchronized(workspaceId, record, now)
    return appliedOutcome(operationId, event.eventId, 'inbound', now)
  }

  /**
   * Mirrors a provider thread completion transition into the canonical Work Item.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Active source-owning link.
   * @param completed - Requested completion state.
   * @param occurredAt - Provider transition timestamp.
   * @param event - Provider completion or reopen event.
   * @param operationId - Stable inbound operation identifier.
   * @returns Applied outcome.
   */
  private async applyInboundThreadCompletion(
    workspaceId: string,
    record: StoredExternalChatLink,
    completed: boolean,
    occurredAt: string,
    event: Extract<ExternalChatInboundEvent, {
      type: 'thread.completed' | 'thread.reopened'
    }>,
    operationId: string,
  ): Promise<ExternalChatSyncOutcome> {
    const claimedAt = this.clock.now()
    const claim = await this.store.claimThreadLifecycle({
      workspaceId,
      linkId: record.link.id,
      provider: record.link.provider,
      expectedLinkRevision: record.link.revision,
      operationId,
      claimedAt,
      leaseExpiresAt: addMilliseconds(claimedAt, this.receiptLeaseMs),
    })
    if (claim.kind === 'busy') {
      return deferredOutcome(
        operationId,
        event.eventId,
        'out-of-order',
        claimedAt,
        claim.record.lease.leaseExpiresAt,
      )
    }
    if (claim.kind === 'completed') {
      return this.replayCompletedThreadLifecycle(
        workspaceId,
        record.link.id,
        claim.record,
        operationId,
      )
    }

    const order = await this.decideThreadLifecycleOrder(record, event, claim.record.state)
    if (order === 'stale') {
      const outcome = skippedOutcome(operationId, event.eventId, 'stale', claimedAt)
      await this.completeThreadLifecycleClaim(
        claim.record,
        advanceThreadLifecycleState(claim.record.state, claimedAt),
        outcome,
      )
      return outcome
    }
    if (order === 'defer') {
      const outcome = deferredOutcome(
        operationId,
        event.eventId,
        'out-of-order',
        claimedAt,
        addMilliseconds(claimedAt, this.deferDelayMs),
      )
      const nextState = advanceThreadLifecycleState(claim.record.state, claimedAt)
      await this.completeThreadLifecycleClaim(claim.record, nextState, outcome)
      await this.projectThreadLifecycleOutcome(workspaceId, record.link.id, nextState, outcome)
      return outcome
    }

    const transition = await this.workItems.setCompletion({
      workspaceId,
      linkId: record.link.id,
      expectedLinkRevision: record.link.revision,
      teamId: record.link.teamId,
      workItemId: record.link.workItemId,
      completed,
      expectedWorkItemRevision: claim.record.state.lastInternalWorkItemRevision,
      operationId,
      correlationId: inboundCorrelationId(event.correlationId),
      occurredAt,
    })
    const workItemRevision = requireWorkItemRevision(transition.workItemRevision)
    const committedAt = this.clock.now()
    const nextState = createThreadLifecycleState(
      claim.record.state,
      completed,
      event.externalVersion,
      workItemRevision,
      committedAt,
    )
    const outcome = transition.kind === 'applied'
      ? appliedOutcome(operationId, event.eventId, 'inbound', committedAt)
      : transition.kind === 'unsupported-transition'
      ? skippedOutcome(operationId, event.eventId, 'not-eligible', committedAt)
      : failedOutcome(
        operationId,
        event.eventId,
        'ExternalChatSyncRevisionConflict',
        false,
        committedAt,
      )
    await this.completeThreadLifecycleClaim(claim.record, nextState, outcome)
    await this.projectThreadLifecycleOutcome(workspaceId, record.link.id, nextState, outcome)
    return outcome
  }

  /**
   * Records source lifecycle and permission changes without exposing source content.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Active source-owning link.
   * @param event - Provider lifecycle event.
   * @param operationId - Stable inbound operation identifier.
   * @param excludedDeferredEventId - Current parent retry event retained until outer completion.
   * @param expectedParentLifecycleFence - Exact parent authority required at projection commit.
   * @returns Applied outcome.
   */
  private async applyInboundLifecycle(
    workspaceId: string,
    record: StoredExternalChatLink,
    event: Extract<ExternalChatInboundEvent, { type: 'source.lifecycle-changed' }>,
    operationId: string,
    excludedDeferredEventId = event.eventId,
    expectedParentLifecycleFence?: ExternalChatParentLifecycleFence,
  ): Promise<ExternalChatSyncOutcome> {
    const now = this.clock.now()
    if (event.resourceType === 'message' || event.resourceType === 'attachment') {
      await this.collaboration.applyExternalResourceLifecycle({
        workspaceId,
        teamId: record.link.teamId,
        workItemId: record.link.workItemId,
        linkId: record.link.id,
        expectedLinkRevision: record.link.revision,
        resourceType: event.resourceType,
        resourceExternalId: event.resourceExternalId,
        availability: event.availability,
        state: event.state,
        operationId,
        correlationId: inboundCorrelationId(event.correlationId),
        occurredAt: event.occurredAt,
      })
    } else if (
      event.resourceType === 'workspace' ||
      event.resourceType === 'conversation' ||
      event.resourceType === 'thread'
    ) {
      validateParentLifecycleResourceScope(record.link, event)
      const projectedRecord = await this.updateLinkProjection(
        workspaceId,
        record.link.id,
        (link) => {
        const projected = mustRedactLifecycleMetadata(event)
          ? redactLinkSourceMetadata(link)
          : link
        return {
          ...projected,
          sourceAvailability: event.availability,
          sourceState: event.state,
          syncStatus: statusForSource(event.availability, event.state),
          lastSourceObservedAt: event.availability === 'available'
            ? event.occurredAt
            : link.lastSourceObservedAt,
        }
        },
        undefined,
        expectedParentLifecycleFence,
      )
      if (mustRedactLifecycleMetadata(event)) {
        await this.redactRestrictiveLinkResources(
          workspaceId,
          projectedRecord,
          event.availability,
          event.state,
          operationId,
          inboundCorrelationId(event.correlationId),
          event.occurredAt,
          excludedDeferredEventId,
        )
      }
    }
    return appliedOutcome(operationId, event.eventId, 'inbound', now)
  }

  /**
   * Applies one outbound internal mutation through the current authorized provider adapter.
   *
   * @param record - Active source-owning link.
   * @param event - Eligible trusted internal event.
   * @param operationId - Stable outbound operation identifier.
   * @returns Applied, skipped, or deferred outcome.
   */
  private async applyOutboundEvent(
    record: StoredExternalChatLink,
    event: ExternalChatSyncOutboundEvent,
    operationId: string,
  ): Promise<ExternalChatSyncOutcome> {
    const authorization = await this.access.getInstallationProviderAuthorization(
      event.workspaceId,
      record.link,
    )
    if (!authorization) {
      throw new ExternalChatSyncPortError(
        'ExternalChatSyncSourceUnavailable',
        'Current installation authorization is unavailable.',
        { retryable: true },
      )
    }
    validateAuthorization(record.link, authorization)
    const adapter = this.adapters.get(record.link.provider)
    if (
      (event.type === 'comment.edited' && !adapter.definition.capabilities.edits) ||
      (event.type === 'comment.deleted' && !adapter.definition.capabilities.deletion) ||
      ((event.type === 'work-item.completed' || event.type === 'work-item.reopened') &&
        !adapter.definition.capabilities.threadCompletion)
    ) {
      return skippedOutcome(operationId, undefined, 'not-eligible', this.clock.now())
    }
    const now = this.clock.now()
    const secret = await this.originSecrets.getSigningSecret(
      event.workspaceId,
      record.link.installationId,
      record.link.provider,
    )
    const originMarker = createChatProviderOriginMarker({
      version: 1,
      provider: record.link.provider,
      installationId: record.link.installationId,
      linkId: record.link.id,
      operationId,
      action: outboundOriginAction(event),
      issuedAt: now,
    }, secret)

    if (event.type === 'comment.created') {
      return this.createOutboundReply(record, event, operationId, authorization, originMarker)
    }
    if (event.type === 'comment.edited') {
      return this.editOutboundMessage(record, event, operationId, authorization, originMarker)
    }
    if (event.type === 'comment.deleted') {
      return this.deleteOutboundMessage(record, event, operationId, authorization, originMarker)
    }
    return this.applyOutboundThreadCompletion(
      record,
      event,
      operationId,
      authorization,
      originMarker,
    )
  }

  /**
   * Applies one ordered internal Work Item lifecycle transition to the provider thread.
   *
   * @param record - Active source-owning link.
   * @param event - Eligible Work Item completion or reopen event.
   * @param operationId - Stable outbound operation identifier.
   * @param authorization - Current installation authorization.
   * @param originMarker - Authenticated provider echo marker.
   * @returns Applied, skipped, deferred, or failed synchronization outcome.
   */
  private async applyOutboundThreadCompletion(
    record: StoredExternalChatLink,
    event: ExternalChatSyncWorkItemCompletedEvent | ExternalChatSyncWorkItemReopenedEvent,
    operationId: string,
    authorization: ChatProviderAuthorization,
    originMarker: string,
  ): Promise<ExternalChatSyncOutcome> {
    const claimedAt = this.clock.now()
    const claim = await this.store.claimThreadLifecycle({
      workspaceId: event.workspaceId,
      linkId: record.link.id,
      provider: record.link.provider,
      expectedLinkRevision: record.link.revision,
      operationId,
      claimedAt,
      leaseExpiresAt: addMilliseconds(claimedAt, this.receiptLeaseMs),
    })
    if (claim.kind === 'busy') {
      return deferredOutcome(
        operationId,
        undefined,
        'out-of-order',
        claimedAt,
        normalizeExternalChatRetryAt(
          claimedAt,
          operationId,
          claim.record.lease.leaseExpiresAt,
          this.deferDelayMs,
        ),
      )
    }
    if (claim.kind === 'completed') {
      return this.replayCompletedThreadLifecycle(
        event.workspaceId,
        record.link.id,
        claim.record,
        operationId,
      )
    }

    const internalOrder = internalWorkItemRevisionOrder(
      claim.record.state.lastInternalWorkItemRevision,
      event.workItemRevision,
    )
    if (internalOrder === 'stale') {
      const outcome = skippedOutcome(operationId, undefined, 'stale', claimedAt)
      await this.completeThreadLifecycleClaim(
        claim.record,
        advanceThreadLifecycleState(claim.record.state, claimedAt),
        outcome,
      )
      return outcome
    }
    if (internalOrder === 'defer') {
      const outcome = deferredOutcome(
        operationId,
        undefined,
        'out-of-order',
        claimedAt,
        normalizeExternalChatRetryAt(
          claimedAt,
          operationId,
          undefined,
          this.deferDelayMs,
        ),
      )
      const nextState = advanceThreadLifecycleState(claim.record.state, claimedAt)
      await this.completeThreadLifecycleClaim(claim.record, nextState, outcome)
      await this.projectThreadLifecycleOutcome(
        event.workspaceId,
        record.link.id,
        nextState,
        outcome,
      )
      return outcome
    }

    const requestedCompleted = event.type === 'work-item.completed'
    const mutation = normalizeChatProviderThreadMutationResult(
      await this.adapters.get(record.link.provider).setThreadCompletion({
        authorization,
        source: record.link.source,
        completed: requestedCompleted,
        operationId,
        originMarker,
      }),
    )
    const committedAt = this.clock.now()
    const nextState = createThreadLifecycleState(
      claim.record.state,
      mutation.completed,
      mutation.externalVersion,
      event.workItemRevision,
      committedAt,
    )
    const outcome = mutation.completed === requestedCompleted
      ? appliedOutcome(operationId, undefined, 'outbound', committedAt)
      : failedOutcome(
        operationId,
        undefined,
        'ExternalChatSyncInvalidMutation',
        false,
        committedAt,
      )
    await this.completeThreadLifecycleClaim(claim.record, nextState, outcome)
    await this.projectThreadLifecycleOutcome(
      event.workspaceId,
      record.link.id,
      nextState,
      outcome,
    )
    return outcome
  }

  /**
   * Creates one provider reply and binds it to the originating internal comment.
   *
   * @param record - Active source-owning link.
   * @param event - Internal comment creation.
   * @param operationId - Stable outbound operation identifier.
   * @param authorization - Current installation authorization.
   * @param originMarker - Authenticated provider echo marker.
   * @returns Synchronization outcome.
   */
  private async createOutboundReply(
    record: StoredExternalChatLink,
    event: ExternalChatSyncCommentCreatedEvent,
    operationId: string,
    authorization: ChatProviderAuthorization,
    originMarker: string,
  ): Promise<ExternalChatSyncOutcome> {
    const current = await this.store.getMessageBindingByInternalId(
      event.workspaceId,
      record.link.id,
      event.internalCommentId,
    )
    if (current) {
      if (current.binding.lastOutboundOperationId === operationId) {
        const now = this.clock.now()
        await this.markLinkSynchronized(event.workspaceId, record, now)
        return appliedOutcome(operationId, undefined, 'outbound', now)
      }
      return skippedOutcome(operationId, undefined, 'stale', this.clock.now())
    }
    const adapter = this.adapters.get(record.link.provider)
    const message = normalizeChatProviderMessage(
      await adapter.createReply({
        authorization,
        source: record.link.source,
        bodyMarkdown: event.bodyMarkdown,
        operationId,
        originMarker,
      }),
      adapter.definition.permalinkHosts,
    )
    validateMessageScope(record.link, message)
    validateCreatedMessageResult(message)
    const now = this.clock.now()
    const binding: ExternalChatMessageBinding = {
      schemaVersion: 1,
      linkId: record.link.id,
      externalMessageId: message.externalId,
      internalCommentId: event.internalCommentId,
      origin: 'internal',
      externalVersion: message.externalVersion,
      internalCommentVersion: event.internalCommentVersion,
      lastOutboundOperationId: operationId,
      importedFileIds: [],
      createdAt: now,
      updatedAt: now,
    }
    await this.putBinding(event.workspaceId, record, binding, undefined)
    await this.markLinkSynchronized(event.workspaceId, record, now)
    return appliedOutcome(operationId, undefined, 'outbound', now)
  }

  /**
   * Edits the provider message bound to an internal collaboration comment.
   *
   * @param record - Active source-owning link.
   * @param event - Internal comment edit.
   * @param operationId - Stable outbound operation identifier.
   * @param authorization - Current installation authorization.
   * @param originMarker - Authenticated provider echo marker.
   * @returns Synchronization outcome.
   */
  private async editOutboundMessage(
    record: StoredExternalChatLink,
    event: ExternalChatSyncCommentEditedEvent,
    operationId: string,
    authorization: ChatProviderAuthorization,
    originMarker: string,
  ): Promise<ExternalChatSyncOutcome> {
    const current = await this.store.getMessageBindingByInternalId(
      event.workspaceId,
      record.link.id,
      event.internalCommentId,
    )
    if (!current) {
      const now = this.clock.now()
      return deferredOutcome(
        operationId,
        undefined,
        'out-of-order',
        now,
        normalizeExternalChatRetryAt(now, operationId, undefined, this.deferDelayMs),
      )
    }
    if (current.binding.lastOutboundOperationId === operationId) {
      const now = this.clock.now()
      await this.markLinkSynchronized(event.workspaceId, record, now)
      return appliedOutcome(operationId, undefined, 'outbound', now)
    }
    const order = internalVersionOrder(current, event.internalCommentVersion)
    if (order === 'defer') {
      const now = this.clock.now()
      return deferredOutcome(
        operationId,
        undefined,
        'out-of-order',
        now,
        normalizeExternalChatRetryAt(now, operationId, undefined, this.deferDelayMs),
      )
    }
    if (order === 'stale') {
      return skippedOutcome(operationId, undefined, 'stale', this.clock.now())
    }
    const adapter = this.adapters.get(record.link.provider)
    const message = normalizeChatProviderMessage(
      await adapter.editMessage({
        authorization,
        source: record.link.source,
        externalMessageId: current.binding.externalMessageId,
        expectedExternalVersion: current.binding.externalVersion,
        bodyMarkdown: event.bodyMarkdown,
        operationId,
        originMarker,
      }),
      adapter.definition.permalinkHosts,
    )
    validateMessageMutationIdentity(current.binding.externalMessageId, message)
    validateMessageScope(record.link, message)
    validateEditedMessageResult(current.binding.externalVersion, message)
    const now = this.clock.now()
    const binding: ExternalChatMessageBinding = {
      ...current.binding,
      externalVersion: message.externalVersion,
      internalCommentVersion: event.internalCommentVersion,
      lastOutboundOperationId: operationId,
      updatedAt: now,
    }
    await this.putBinding(event.workspaceId, record, binding, current)
    await this.markLinkSynchronized(event.workspaceId, record, now)
    return appliedOutcome(operationId, undefined, 'outbound', now)
  }

  /**
   * Deletes the provider message bound to an internal collaboration comment.
   *
   * @param record - Active source-owning link.
   * @param event - Internal comment deletion.
   * @param operationId - Stable outbound operation identifier.
   * @param authorization - Current installation authorization.
   * @param originMarker - Authenticated provider echo marker.
   * @returns Synchronization outcome.
   */
  private async deleteOutboundMessage(
    record: StoredExternalChatLink,
    event: ExternalChatSyncCommentDeletedEvent,
    operationId: string,
    authorization: ChatProviderAuthorization,
    originMarker: string,
  ): Promise<ExternalChatSyncOutcome> {
    const current = await this.store.getMessageBindingByInternalId(
      event.workspaceId,
      record.link.id,
      event.internalCommentId,
    )
    if (!current) {
      const now = this.clock.now()
      return deferredOutcome(
        operationId,
        undefined,
        'out-of-order',
        now,
        normalizeExternalChatRetryAt(now, operationId, undefined, this.deferDelayMs),
      )
    }
    if (current.binding.lastOutboundOperationId === operationId) {
      const now = this.clock.now()
      await this.markLinkSynchronized(event.workspaceId, record, now)
      return appliedOutcome(operationId, undefined, 'outbound', now)
    }
    const order = internalVersionOrder(current, event.internalCommentVersion)
    if (order === 'defer') {
      const now = this.clock.now()
      return deferredOutcome(
        operationId,
        undefined,
        'out-of-order',
        now,
        normalizeExternalChatRetryAt(now, operationId, undefined, this.deferDelayMs),
      )
    }
    if (order === 'stale') {
      return skippedOutcome(operationId, undefined, 'stale', this.clock.now())
    }
    const adapter = this.adapters.get(record.link.provider)
    const message = normalizeChatProviderMessage(
      await adapter.deleteMessage({
        authorization,
        source: record.link.source,
        externalMessageId: current.binding.externalMessageId,
        expectedExternalVersion: current.binding.externalVersion,
        operationId,
        originMarker,
      }),
      adapter.definition.permalinkHosts,
    )
    validateMessageMutationIdentity(current.binding.externalMessageId, message)
    validateMessageScope(record.link, message)
    const deletedAt = validateDeletedMessageResult(current.binding.externalVersion, message)
    const now = this.clock.now()
    const binding: ExternalChatMessageBinding = {
      ...current.binding,
      externalVersion: message.externalVersion,
      internalCommentVersion: event.internalCommentVersion,
      lastOutboundOperationId: operationId,
      deletedAt,
      updatedAt: now,
    }
    await this.putBinding(event.workspaceId, record, binding, current)
    await this.markLinkSynchronized(event.workspaceId, record, now)
    return appliedOutcome(operationId, undefined, 'outbound', now)
  }

  /**
   * Delegates provider thread-version comparison after checking an exact committed version.
   *
   * @param record - Active source-owning link.
   * @param event - Incoming provider completion or reopen event.
   * @param state - Last committed thread lifecycle state.
   * @returns Provider-aware lifecycle ordering decision.
   */
  private async decideThreadLifecycleOrder(
    record: StoredExternalChatLink,
    event: Extract<ExternalChatInboundEvent, {
      type: 'thread.completed' | 'thread.reopened'
    }>,
    state: ExternalChatThreadLifecycleState,
  ): Promise<ExternalChatSyncThreadOrderDecision> {
    if (state.lastExternalVersion === event.externalVersion) return 'stale'
    return this.threadOrder.decideThreadLifecycle({
      provider: record.link.provider,
      linkId: record.link.id,
      previousExternalVersion: state.lastExternalVersion,
      incomingExternalVersion: event.externalVersion,
      externalSequence: event.externalSequence,
      occurredAt: event.occurredAt,
    })
  }

  /**
   * Commits one lifecycle state before any link projection changes its ownership revision.
   *
   * @param lifecycle - Claimed lifecycle record and lease attempt.
   * @param nextState - Complete adjacent lifecycle state.
   * @param outcome - Exact outcome retained for crash-safe replay.
   */
  private async completeThreadLifecycleClaim(
    lifecycle: StoredExternalChatThreadLifecycle,
    nextState: ExternalChatThreadLifecycleState,
    outcome: ExternalChatSyncOutcome,
  ): Promise<void> {
    let completed: boolean
    try {
      completed = await this.store.completeThreadLifecycle({
        workspaceId: lifecycle.workspaceId,
        linkId: lifecycle.linkId,
        provider: lifecycle.provider,
        expectedLinkRevision: lifecycle.ownerLinkRevision,
        operationId: lifecycle.lease.operationId,
        expectedAttempt: lifecycle.lease.attempt,
        nextState,
        outcome,
        completedAt: nextState.updatedAt,
      })
    } catch (error: unknown) {
      if (error instanceof ExternalChatError && error.code === 'ExternalChatRevisionConflict') {
        throw lifecycleRevisionConflictError()
      }
      throw error
    }
    if (!completed) throw lifecycleRevisionConflictError()
  }

  /**
   * Replays an exactly completed lifecycle outcome and repairs a missed link projection.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param linkId - External chat link identifier.
   * @param lifecycle - Completed authoritative lifecycle record.
   * @param operationId - Operation expected to own the completed lease.
   * @returns Exact durable lifecycle outcome.
   */
  private async replayCompletedThreadLifecycle(
    workspaceId: string,
    linkId: string,
    lifecycle: StoredExternalChatThreadLifecycle,
    operationId: string,
  ): Promise<ExternalChatSyncOutcome> {
    const outcome = lifecycle.lease.completedOutcome
    if (
      lifecycle.lease.status !== 'completed' ||
      lifecycle.lease.operationId !== operationId ||
      outcome === undefined ||
      outcome.operationId !== operationId
    ) {
      throw new ExternalChatError(
        'ExternalChatPersistenceFailed',
        'The completed thread lifecycle lease has no matching outcome.',
      )
    }
    await this.projectThreadLifecycleOutcome(workspaceId, linkId, lifecycle.state, outcome)
    return outcome
  }

  /**
   * Projects one committed lifecycle decision after its strict link revision fence is released.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param linkId - External chat link identifier.
   * @param state - Authoritative committed provider thread state.
   * @param outcome - Exact outcome that determines synced, pending, paused, or conflict status.
   */
  private async projectThreadLifecycleOutcome(
    workspaceId: string,
    linkId: string,
    state: ExternalChatThreadLifecycleState,
    outcome: ExternalChatSyncOutcome,
  ): Promise<void> {
    const syncStatus = threadLifecycleSyncStatus(outcome)
    if (syncStatus === undefined) return
    const sourceState: ExternalChatSourceState = state.completed ? 'completed' : 'active'
    const current = await this.store.getLink(workspaceId, linkId)
    if (!current || !current.active) return
    if (
      current.link.sourceAvailability === 'available' &&
      current.link.sourceState === sourceState &&
      current.link.syncStatus === syncStatus &&
      current.link.lastSourceObservedAt === state.updatedAt &&
      (outcome.kind !== 'applied' || current.link.lastSyncedAt === state.updatedAt)
    ) return
    await this.updateLinkProjection(
      workspaceId,
      linkId,
      (link) => ({
        ...link,
        sourceAvailability: 'available',
        sourceState,
        syncStatus,
        ...(outcome.kind === 'applied' ? { lastSyncedAt: state.updatedAt } : {}),
        lastSourceObservedAt: state.updatedAt,
      }),
      outcome.operationId,
    )
  }

  /**
   * Delegates external version comparison while short-circuiting an exact committed version.
   *
   * @param record - Active source-owning link.
   * @param event - External message creation or edit.
   * @param current - Current binding, when one exists.
   * @returns Provider-aware ordering decision.
   */
  private async decideMessageOrder(
    record: StoredExternalChatLink,
    event: Extract<ExternalChatInboundEvent, { type: 'message.created' | 'message.edited' }>,
    current: StoredExternalChatMessageBinding | undefined,
  ): Promise<ExternalChatSyncMessageOrderDecision> {
    if (current?.binding.externalVersion === event.message.externalVersion) return 'stale'
    return this.messageOrder.decide({
      provider: record.link.provider,
      linkId: record.link.id,
      externalMessageId: event.message.externalId,
      previousExternalVersion: current?.binding.externalVersion,
      incomingExternalVersion: event.message.externalVersion,
      externalSequence: event.externalSequence,
      occurredAt: event.occurredAt,
    })
  }

  /**
   * Commits a binding with optimistic concurrency and recognizes an idempotent recovered write.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param owner - Exact link ownership observed before the external/internal side effect.
   * @param binding - Complete replacement message binding.
   * @param current - Previously observed stored binding.
   */
  private async putBinding(
    workspaceId: string,
    owner: StoredExternalChatLink,
    binding: ExternalChatMessageBinding,
    current: StoredExternalChatMessageBinding | undefined,
  ): Promise<void> {
    const result = await this.store.putMessageBinding({
      workspaceId,
      binding,
      expectedTeamId: owner.link.teamId,
      expectedWorkItemId: owner.link.workItemId,
      expectedLinkRevision: owner.link.revision,
      expectedStorageRevision: current?.storageRevision,
    })
    if (result.kind === 'stored') return
    if (result.kind !== 'owner-conflict' && sameCommittedBinding(result.record, binding)) return
    throw new ExternalChatSyncPortError(
      'ExternalChatSyncRevisionConflict',
      result.kind === 'identity-conflict'
        ? 'The external or internal message identity is already bound elsewhere.'
        : result.kind === 'owner-conflict'
        ? 'The external chat link ownership changed before the message binding committed.'
        : 'The external message binding changed concurrently.',
      { retryable: result.kind !== 'identity-conflict' },
    )
  }

  /**
   * Marks a link synchronized after its content and binding mutations commit.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Link observed before applying the mutation.
   * @param synchronizedAt - Synchronization completion timestamp.
   */
  private async markLinkSynchronized(
    workspaceId: string,
    record: StoredExternalChatLink,
    synchronizedAt: string,
  ): Promise<void> {
    await this.updateLinkProjection(workspaceId, record.link.id, (link) => {
      const sourceState = link.sourceState === 'deleted' ||
          link.sourceState === 'retention-expired'
        ? link.sourceState
        : 'active'
      return {
        ...link,
        sourceAvailability: 'available',
        sourceState,
        syncStatus: statusForSource('available', sourceState),
        lastSyncedAt: synchronizedAt,
        lastSourceObservedAt: synchronizedAt,
      }
    })
  }

  /**
   * Applies a narrow optimistic link projection update and retries bounded concurrent changes.
   *
   * Immutable identity and ownership fields are always restored from the latest durable record.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param linkId - External chat link identifier.
   * @param project - Pure projection applied to the latest public link.
   * @param lifecycleOperationId - Completed lifecycle owner permitted to project before ack.
   * @param expectedParentLifecycleFence - Exact parent authority required at atomic commit.
   * @returns Updated stored link.
   */
  private async updateLinkProjection(
    workspaceId: string,
    linkId: string,
    project: (link: ExternalChatWorkItemLink) => ExternalChatWorkItemLink,
    lifecycleOperationId?: string,
    expectedParentLifecycleFence?: ExternalChatParentLifecycleFence,
  ): Promise<StoredExternalChatLink> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.getLink(workspaceId, linkId)
      if (!current || !current.active) {
        throw new ExternalChatError(
          'ExternalChatNotFound',
          'The external chat link is no longer active.',
        )
      }
      const now = this.clock.now()
      const candidate = project(current.link)
      const link = restoreImmutableLinkIdentity(current.link, candidate, now)
      const updated = await this.store.updateLink({
        workspaceId,
        link,
        expectedRevision: current.link.revision,
        ...(lifecycleOperationId === undefined ? {} : { lifecycleOperationId }),
        ...(expectedParentLifecycleFence === undefined
          ? {}
          : { expectedParentLifecycleFence }),
      })
      if (updated.kind === 'updated') return updated.record
      if (updated.kind === 'parent-stale') {
        throw new ParentLifecycleFenceSupersededError(
          'A newer provider parent lifecycle event superseded this projection.',
        )
      }
      if (updated.kind === 'not-found') {
        throw new ExternalChatError(
          'ExternalChatNotFound',
          'The external chat link no longer exists.',
        )
      }
    }
    throw new ExternalChatSyncPortError(
      'ExternalChatSyncRevisionConflict',
      'The external chat link changed repeatedly during synchronization.',
      { retryable: true },
    )
  }

  /**
   * Persists a retryable inbound event and commits an honest deferred receipt outcome.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param event - Verified normalized provider event.
   * @param operationId - Stable inbound operation identifier.
   * @param fingerprint - Normalized event fingerprint.
   * @param record - Active source-owning link.
   * @param attempt - Current durable receipt attempt count.
   * @returns Durable deferred outcome.
   */
  private async deferInbound(
    workspaceId: string,
    event: ExternalChatInboundEvent,
    operationId: string,
    fingerprint: string,
    record: StoredExternalChatLink,
    attempt: number,
  ): Promise<ExternalChatSyncOutcome> {
    const now = this.clock.now()
    const retryAt = addMilliseconds(now, this.deferDelayMs)
    const outcome = deferredOutcome(
      operationId,
      event.eventId,
      'source-unavailable',
      now,
      retryAt,
    )
    await this.store.deferEvent({
      workspaceId,
      linkId: record.link.id,
      event,
      fingerprint,
      reason: 'source-unavailable',
      attempt,
      retryAt,
      createdAt: now,
      updatedAt: now,
    })
    return this.completeInbound(
      workspaceId,
      event,
      operationId,
      attempt,
      sourceIdentity(event),
      record,
      outcome,
    )
  }

  /**
   * Commits an inbound receipt before recording its idempotent redacted audit projection.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param event - Verified normalized provider event.
   * @param operationId - Stable inbound operation identifier.
   * @param expectedAttempt - Receipt lease attempt that owns completion.
   * @param source - Provider source identity used only to derive a digest.
   * @param record - Resolved active link, when one exists.
   * @param outcome - Final inbound decision.
   * @returns The committed outcome.
   */
  private async completeInbound(
    workspaceId: string,
    event: ExternalChatInboundEvent,
    operationId: string,
    expectedAttempt: number,
    source: ExternalChatSourceIdentity,
    record: StoredExternalChatLink | undefined,
    outcome: ExternalChatSyncOutcome,
  ): Promise<ExternalChatSyncOutcome> {
    const completed = await this.store.completeInboundEvent({
      workspaceId,
      installationId: event.installationId,
      provider: event.provider,
      eventId: event.eventId,
      operationId,
      expectedAttempt,
      outcome,
      completedAt: this.clock.now(),
    })
    if (!completed) {
      throw new ExternalChatError(
        'ExternalChatPersistenceFailed',
        'The inbound event receipt lease was lost before completion.',
        true,
      )
    }
    if (record) {
      await this.acknowledgeCompletedThreadLifecycle(workspaceId, record, operationId)
    }
    await this.recordInboundAudit(workspaceId, event, operationId, source, record, outcome)
    await this.deleteTerminalDeferredEvent(workspaceId, event, outcome)
    return outcome
  }

  /**
   * Removes deferred work only after its terminal receipt and replay-safe audit have committed.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param event - Exact provider event identity used by the deferred row.
   * @param outcome - Durable receipt outcome.
   */
  private async deleteTerminalDeferredEvent(
    workspaceId: string,
    event: ExternalChatInboundEvent,
    outcome: ExternalChatSyncOutcome,
  ): Promise<void> {
    if (!isTerminalSyncOutcome(outcome)) return
    await this.store.deleteDeferredEvent(
      workspaceId,
      event.provider,
      event.installationId,
      event.eventId,
    )
  }

  /**
   * Writes an idempotent redacted audit projection for an inbound event or receipt replay.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param event - Verified normalized provider event.
   * @param operationId - Stable inbound operation identifier.
   * @param source - Provider source identity used only to derive a digest.
   * @param record - Resolved link, when one exists.
   * @param outcome - Durable inbound outcome.
   */
  private async recordInboundAudit(
    workspaceId: string,
    event: ExternalChatInboundEvent,
    operationId: string,
    source: ExternalChatSourceIdentity,
    record: StoredExternalChatLink | undefined,
    outcome: ExternalChatSyncOutcome,
  ): Promise<void> {
    await this.audit.record({
      workspaceId,
      provider: event.provider,
      linkId: record?.link.id,
      sourceDigest: createExternalChatSourceDigest(source),
      operationId,
      eventId: event.eventId,
      correlationId: inboundCorrelationId(event.correlationId),
      direction: 'inbound',
      action: inboundAuditAction(event),
      externalActorKind: inboundActorKind(event),
      externalActorDigest: inboundActorDigest(event),
      outcome,
    })
  }

  /**
   * Commits an outbound receipt before recording its idempotent redacted audit projection.
   *
   * @param event - Trusted internal mutation.
   * @param record - Active source-owning link.
   * @param operationId - Stable outbound operation identifier.
   * @param expectedAttempt - Receipt lease attempt that owns completion.
   * @param outcome - Final outbound decision.
   * @returns The committed outcome.
   */
  private async completeOutbound(
    event: ExternalChatSyncOutboundEvent,
    record: StoredExternalChatLink,
    operationId: string,
    expectedAttempt: number,
    outcome: ExternalChatSyncOutcome,
  ): Promise<ExternalChatSyncOutcome> {
    const completedAt = this.clock.now()
    const retryAt = outboundRetryAt(outcome, completedAt, this.deferDelayMs)
    if (retryAt) {
      await this.store.deferOutboundEvent({
        workspaceId: event.workspaceId,
        linkId: event.linkId,
        event,
        fingerprint: createExternalChatFingerprint(event),
        operationId,
        attempt: expectedAttempt,
        retryAt,
        createdAt: completedAt,
        updatedAt: completedAt,
      })
    }
    const completed = await this.store.completeOutboundOperation({
      workspaceId: event.workspaceId,
      linkId: event.linkId,
      operationId,
      expectedAttempt,
      outcome,
      completedAt,
    })
    if (!completed) {
      throw new ExternalChatError(
        'ExternalChatPersistenceFailed',
        'The outbound operation receipt lease was lost before completion.',
        true,
      )
    }
    await this.acknowledgeCompletedThreadLifecycle(event.workspaceId, record, operationId)
    await this.recordOutboundAudit(event, record, operationId, outcome)
    await this.deleteTerminalDeferredOutboundEvent(event, operationId, outcome)
    return outcome
  }

  /**
   * Removes one fully scoped outbound queue row only after receipt and audit completion.
   *
   * @param event - Trusted internal mutation that owns the durable queue identity.
   * @param operationId - Stable outbound operation identifier.
   * @param outcome - Committed receipt outcome.
   */
  private async deleteTerminalDeferredOutboundEvent(
    event: ExternalChatSyncOutboundEvent,
    operationId: string,
    outcome: ExternalChatSyncOutcome,
  ): Promise<void> {
    if (!isTerminalSyncOutcome(outcome)) return
    await this.store.deleteDeferredOutboundEvent(
      event.workspaceId,
      event.linkId,
      operationId,
    )
  }

  /**
   * Releases a completed lifecycle handoff only after its outer receipt is durable.
   *
   * Non-lifecycle operations and operations deferred behind another owner have no matching
   * completed lifecycle lease and therefore require no acknowledgement.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Link that may own the lifecycle handoff.
   * @param operationId - Stable inbound or outbound operation identifier.
   */
  private async acknowledgeCompletedThreadLifecycle(
    workspaceId: string,
    record: StoredExternalChatLink,
    operationId: string,
  ): Promise<void> {
    const lifecycle = await this.store.getThreadLifecycle(
      workspaceId,
      record.link.id,
      record.link.provider,
    )
    if (
      lifecycle === undefined ||
      lifecycle.lease.operationId !== operationId ||
      lifecycle.lease.status !== 'completed'
    ) return
    const acknowledged = await this.store.acknowledgeThreadLifecycle({
      workspaceId,
      linkId: record.link.id,
      provider: record.link.provider,
      operationId,
      expectedAttempt: lifecycle.lease.attempt,
    })
    if (!acknowledged) {
      throw new ExternalChatError(
        'ExternalChatPersistenceFailed',
        'The completed thread lifecycle handoff could not be acknowledged.',
        true,
      )
    }
  }

  /**
   * Writes an idempotent redacted audit projection for an outbound event or receipt replay.
   *
   * @param event - Trusted internal mutation.
   * @param record - Stored external chat link.
   * @param operationId - Stable outbound operation identifier.
   * @param outcome - Durable outbound outcome.
   */
  private async recordOutboundAudit(
    event: ExternalChatSyncOutboundEvent,
    record: StoredExternalChatLink,
    operationId: string,
    outcome: ExternalChatSyncOutcome,
  ): Promise<void> {
    await this.audit.record({
      workspaceId: event.workspaceId,
      provider: record.link.provider,
      linkId: record.link.id,
      sourceDigest: record.sourceDigest,
      operationId,
      correlationId: event.correlationId,
      direction: 'outbound',
      action: outboundAuditAction(event),
      internalPrincipalId: event.principalId,
      outcome,
    })
  }

  /**
   * Projects classified provider authorization failures onto the link for honest UI state.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Active source-owning link.
   * @param error - Classified or unknown provider failure.
   * @param operationId - Stable parent operation identifier used to resume redaction.
   * @param correlationId - Stable trace identifier.
   * @param occurredAt - Stable provider or internal event occurrence time.
   * @param excludedDeferredEventId - Current retry event retained until receipt completion.
   */
  private async reflectProviderFailure(
    workspaceId: string,
    record: StoredExternalChatLink,
    error: unknown,
    operationId: string,
    correlationId: string,
    occurredAt: string,
    excludedDeferredEventId?: string,
  ): Promise<void> {
    const projection = providerFailureProjection(error)
    if (!projection) return
    const projectedRecord = await this.updateLinkProjection(
      workspaceId,
      record.link.id,
      (link) => {
      const state = projection.state ?? link.sourceState
      const projected = mustRedactSourceMetadata(projection.availability, state)
        ? redactLinkSourceMetadata(link)
        : link
      return {
        ...projected,
        sourceAvailability: projection.availability,
        sourceState: state,
        syncStatus: projection.status,
      }
      },
    )
    const state = projection.state ?? projectedRecord.link.sourceState
    await this.redactRestrictiveLinkResources(
      workspaceId,
      projectedRecord,
      projection.availability,
      state,
      operationId,
      correlationId,
      occurredAt,
      excludedDeferredEventId,
    )
  }

  /**
   * Purges retained payloads before resuming the idempotent collaboration redaction cascade.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param record - Link whose collaboration resources are being restricted.
   * @param availability - Effective provider availability.
   * @param state - Effective provider lifecycle state.
   * @param operationId - Stable operation identifier used by collaboration idempotency.
   * @param correlationId - Stable trace identifier.
   * @param occurredAt - Stable source occurrence time.
   * @param excludedDeferredEventId - Retry coordinator event retained until outer completion.
   */
  private async redactRestrictiveLinkResources(
    workspaceId: string,
    record: StoredExternalChatLink,
    availability: ExternalChatWorkItemLink['sourceAvailability'],
    state: ExternalChatWorkItemLink['sourceState'],
    operationId: string,
    correlationId: string,
    occurredAt: string,
    excludedDeferredEventId?: string,
  ): Promise<void> {
    if (!mustRedactSourceMetadata(availability, state)) return
    await this.store.purgeDeferredEventsForLink(
      workspaceId,
      record.link.id,
      excludedDeferredEventId,
    )
    await this.collaboration.redactExternalLinkResources({
      workspaceId,
      teamId: record.link.teamId,
      workItemId: record.link.workItemId,
      linkId: record.link.id,
      expectedLinkRevision: record.link.revision,
      availability,
      state,
      operationId,
      correlationId,
      occurredAt,
    })
  }

  /**
   * Resolves an outbound event against current ownership or its exact canonical merge redirect.
   *
   * A queued event keeps its original Work Item scope and operation fingerprint. After a duplicate
   * merge, only a redirect bound to the same link, provider thread, and canonical owner may rebase
   * that event. Authorization is evaluated again against the returned canonical record.
   *
   * @param event - Trusted internal mutation carrying its original Work Item ownership.
   * @returns Current link record, or undefined when the link no longer exists.
   */
  private async resolveOutboundRecord(
    event: ExternalChatSyncOutboundEvent,
  ): Promise<StoredExternalChatLink | undefined> {
    const record = await this.store.getLink(event.workspaceId, event.linkId)
    if (!record || outboundScopeMatches(record, event)) return record
    const redirect = await this.store.getCanonicalRedirect(
      event.workspaceId,
      event.teamId,
      event.workItemId,
      event.linkId,
    )
    if (
      redirect?.linkId === record.link.id &&
      redirect.provider === record.link.provider &&
      redirect.threadExternalId === record.link.source.threadExternalId &&
      redirect.canonicalTeamId === record.link.teamId &&
      redirect.canonicalWorkItemId === record.link.workItemId
    ) return record
    validateOutboundScope(record, event)
    return record
  }

  /**
   * Reads one active link without crossing its Workspace partition.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param linkId - External chat link identifier.
   * @returns Active stored link.
   */
  private async requireActiveLink(
    workspaceId: string,
    linkId: string,
  ): Promise<StoredExternalChatLink> {
    const record = await this.store.getLink(workspaceId, linkId)
    if (!record || !record.active) {
      throw new ExternalChatError(
        'ExternalChatNotFound',
        'The external chat link was not found.',
      )
    }
    return record
  }
}

/**
 * Rejects a parent lifecycle event whose resource ID does not own the linked source.
 *
 * @param link - Link whose immutable provider scope owns the cascade.
 * @param event - Workspace, conversation, or thread lifecycle event.
 */
function validateParentLifecycleResourceScope(
  link: ExternalChatWorkItemLink,
  event: Extract<ExternalChatInboundEvent, { type: 'source.lifecycle-changed' }>,
): void {
  const expectedResourceId = event.resourceType === 'workspace'
    ? link.source.externalWorkspaceId
    : event.resourceType === 'conversation'
    ? link.source.conversationExternalId
    : event.resourceType === 'thread'
    ? link.source.threadExternalId
    : undefined
  if (expectedResourceId === undefined) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'Only parent lifecycle resources can trigger a link-wide cascade.',
    )
  }
  if (event.resourceExternalId !== expectedResourceId) {
    throw new ChatProviderAdapterError(
      'ChatProviderScopeMismatch',
      'The provider lifecycle resource does not own the linked source.',
    )
  }
}

/**
 * Checks whether a provider lifecycle transition forbids retaining optional source metadata.
 *
 * @param event - Verified provider lifecycle event.
 * @returns Whether display names, permalinks, and quoted source text must be removed.
 */
function mustRedactLifecycleMetadata(
  event: Extract<ExternalChatInboundEvent, { type: 'source.lifecycle-changed' }>,
): boolean {
  return mustRedactSourceMetadata(event.availability, event.state)
}

/**
 * Checks source reachability and lifecycle values for mandatory metadata redaction.
 *
 * @param availability - Current provider reachability.
 * @param state - Last known provider lifecycle state.
 * @returns Whether policy-controlled metadata must be removed.
 */
function mustRedactSourceMetadata(
  availability: ExternalChatSourceAvailability,
  state: ExternalChatSourceState,
): boolean {
  return availability === 'permission-lost' ||
    availability === 'scope-changed' ||
    state === 'deleted' ||
    state === 'retention-expired'
}

/**
 * Removes policy-controlled source metadata while preserving canonical provider identity.
 *
 * @param link - Current external chat link.
 * @returns Link projection without display names, permalinks, or quoted body text.
 */
function redactLinkSourceMetadata(
  link: ExternalChatWorkItemLink,
): ExternalChatWorkItemLink {
  return {
    ...link,
    workspace: {
      provider: link.workspace.provider,
      externalId: link.workspace.externalId,
    },
    conversation: {
      externalId: link.conversation.externalId,
      externalWorkspaceId: link.conversation.externalWorkspaceId,
      kind: link.conversation.kind,
    },
    source: {
      externalWorkspaceId: link.source.externalWorkspaceId,
      conversationExternalId: link.source.conversationExternalId,
      threadExternalId: link.source.threadExternalId,
      rootMessageExternalId: link.source.rootMessageExternalId,
      ...(link.source.sourceMessageExternalId === undefined
        ? {}
        : { sourceMessageExternalId: link.source.sourceMessageExternalId }),
    },
  }
}

/**
 * Restores immutable ownership and provider identity around a narrow projection update.
 *
 * Optional display, permalink, and quote metadata intentionally comes from the candidate so a
 * restrictive lifecycle event can remove it without changing the durable source identity.
 *
 * @param current - Latest durable external chat link.
 * @param candidate - Projected replacement link.
 * @param updatedAt - Canonical projection update timestamp.
 * @returns Revision-fenced replacement with immutable identity restored.
 */
function restoreImmutableLinkIdentity(
  current: ExternalChatWorkItemLink,
  candidate: ExternalChatWorkItemLink,
  updatedAt: string,
): ExternalChatWorkItemLink {
  return {
    ...candidate,
    schemaVersion: current.schemaVersion,
    id: current.id,
    teamId: current.teamId,
    workItemId: current.workItemId,
    installationId: current.installationId,
    provider: current.provider,
    workspace: {
      provider: current.workspace.provider,
      externalId: current.workspace.externalId,
      ...(candidate.workspace.displayName === undefined
        ? {}
        : { displayName: candidate.workspace.displayName }),
      ...(candidate.workspace.permalink === undefined
        ? {}
        : { permalink: candidate.workspace.permalink }),
    },
    conversation: {
      externalId: current.conversation.externalId,
      externalWorkspaceId: current.conversation.externalWorkspaceId,
      kind: current.conversation.kind,
      ...(candidate.conversation.displayName === undefined
        ? {}
        : { displayName: candidate.conversation.displayName }),
      ...(candidate.conversation.permalink === undefined
        ? {}
        : { permalink: candidate.conversation.permalink }),
    },
    source: {
      externalWorkspaceId: current.source.externalWorkspaceId,
      conversationExternalId: current.source.conversationExternalId,
      threadExternalId: current.source.threadExternalId,
      rootMessageExternalId: current.source.rootMessageExternalId,
      ...(current.source.sourceMessageExternalId === undefined
        ? {}
        : { sourceMessageExternalId: current.source.sourceMessageExternalId }),
      ...(candidate.source.sourcePermalink === undefined
        ? {}
        : { sourcePermalink: candidate.source.sourcePermalink }),
      ...(candidate.source.quotedRange === undefined
        ? {}
        : { quotedRange: candidate.source.quotedRange }),
    },
    revision: current.revision + 1,
    createdAt: current.createdAt,
    updatedAt,
  }
}

/** Provider failure projection retained on a link without raw upstream diagnostics. */
type ExternalChatSyncProviderFailureProjection = {
  /** Current provider source availability. */
  availability: ExternalChatSourceAvailability
  /** Optional last known provider source lifecycle state. */
  state?: ExternalChatSourceState
  /** Honest user-visible synchronization status. */
  status: ExternalChatWorkItemLink['syncStatus']
}

/** Internal ordering classification for outbound comment versions. */
type ExternalChatSyncInternalVersionOrder = 'apply' | 'stale' | 'defer' | 'missing'

/**
 * Uses a caller value only when it is a positive safe integer.
 *
 * @param value - Optional runtime setting.
 * @param fallback - Trusted default setting.
 * @returns Validated runtime setting.
 */
function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'External chat synchronization options must be positive safe integers.',
    )
  }
  return value
}

/**
 * Requires a bounded positive source-view page size.
 *
 * @param limit - Requested page size.
 * @param maximum - Configured upper bound.
 */
function requirePositiveLimit(limit: number, maximum: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The external chat source-view limit is invalid.',
    )
  }
}

/**
 * Builds the internal Work Item authorization scope from a tenant-scoped stored link.
 *
 * @param record - Stored external chat link.
 * @returns Internal source access scope.
 */
function accessScope(record: StoredExternalChatLink): ExternalChatSyncSourceAccessScope {
  return {
    workspaceId: record.workspaceId,
    teamId: record.link.teamId,
    workItemId: record.link.workItemId,
    linkId: record.link.id,
  }
}

/**
 * Requires current authorization to match the link's immutable installation and provider scope.
 *
 * @param link - Linked external source.
 * @param authorization - Current provider authorization.
 */
function validateAuthorization(
  link: ExternalChatWorkItemLink,
  authorization: ChatProviderAuthorization,
): void {
  if (
    authorization.installationId !== link.installationId ||
    authorization.externalWorkspaceId !== link.source.externalWorkspaceId ||
    !Number.isSafeInteger(authorization.authorizationRevision) ||
    authorization.authorizationRevision < 1
  ) {
    throw new ExternalChatError(
      'ExternalChatAuthorizationFailed',
      'Current provider authorization does not match the linked source scope.',
    )
  }
}

/**
 * Checks that a provider read still belongs to the exact authorized link revision and owner.
 *
 * @param before - Link snapshot authorized before provider I/O.
 * @param after - Strong current snapshot loaded immediately before disclosure.
 * @returns Whether no unlink, merge, lifecycle projection, or source replacement intervened.
 */
function sameSourceViewOwner(
  before: StoredExternalChatLink,
  after: StoredExternalChatLink,
): boolean {
  return after.active &&
    before.workspaceId === after.workspaceId &&
    before.sourceDigest === after.sourceDigest &&
    before.link.id === after.link.id &&
    before.link.revision === after.link.revision &&
    before.link.teamId === after.link.teamId &&
    before.link.workItemId === after.link.workItemId &&
    before.link.installationId === after.link.installationId &&
    before.link.provider === after.link.provider
}

/**
 * Checks that the exact viewer-scoped provider grant remained current during provider I/O.
 *
 * @param before - Authorization used for the provider read.
 * @param after - Authorization re-resolved immediately before disclosure.
 * @returns Whether installation, provider Workspace, and authorization generation match.
 */
function sameProviderAuthorization(
  before: ChatProviderAuthorization,
  after: ChatProviderAuthorization,
): boolean {
  return before.installationId === after.installationId &&
    before.externalWorkspaceId === after.externalWorkspaceId &&
    before.authorizationRevision === after.authorizationRevision
}

/** Creates the safe terminal error used when source-view authorization changes during I/O. */
function sourceViewAuthorizationChanged(): ExternalChatError {
  return new ExternalChatError(
    'ExternalChatAuthorizationFailed',
    'External chat source authorization changed before the source view could be returned.',
  )
}

/**
 * Rejects a provider page that escaped the immutable linked source scope.
 *
 * @param link - Linked external source.
 * @param thread - Provider-normalized thread page.
 */
function validateThreadScope(
  link: ExternalChatWorkItemLink,
  thread: ExternalChatThreadSnapshot,
): void {
  if (
    thread.workspace.provider !== link.provider ||
    thread.workspace.externalId !== link.source.externalWorkspaceId ||
    thread.conversation.externalWorkspaceId !== link.source.externalWorkspaceId ||
    thread.conversation.externalId !== link.source.conversationExternalId ||
    thread.externalId !== link.source.threadExternalId ||
    thread.rootMessageExternalId !== link.source.rootMessageExternalId
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderScopeMismatch',
      'The provider returned a thread outside the linked source scope.',
    )
  }
  for (const message of thread.messages) validateMessageScope(link, message)
}

/**
 * Rejects an adapter page that exceeds its bound or leaks a provider cursor into public DTO state.
 *
 * @param page - Provider-normalized bounded thread page.
 * @param requestedLimit - Maximum messages requested from the adapter.
 */
function validateThreadPage(page: ChatProviderThreadPage, requestedLimit: number): void {
  if (
    page.thread.messages.length > requestedLimit ||
    page.thread.hasMoreMessages !== (page.providerCursor !== undefined) ||
    page.thread.nextMessageCursor !== undefined
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'The provider returned an invalid bounded thread page.',
    )
  }
  const messageIds = new Set<string>()
  for (const message of page.thread.messages) {
    if (messageIds.has(message.externalId)) {
      throw new ChatProviderAdapterError(
        'ChatProviderInvalidResponse',
        'The provider returned duplicate message identities in one thread page.',
      )
    }
    messageIds.add(message.externalId)
  }
}

/**
 * Recognizes a workspace/conversation lifecycle event that requires parent fan-out.
 *
 * @param event - Normalized provider inbound event.
 * @returns Whether the event targets a shared provider parent.
 */
function isParentLifecycleEvent(
  event: ExternalChatInboundEvent,
): event is ExternalChatParentLifecycleEvent {
  return event.type === 'source.lifecycle-changed' &&
    (event.resourceType === 'workspace' || event.resourceType === 'conversation')
}

/**
 * Validates a parent event's resource ID against its authenticated envelope scope.
 *
 * @param event - Workspace or conversation lifecycle event.
 */
function validateParentLifecycleEventScope(event: ExternalChatParentLifecycleEvent): void {
  const expectedResourceId = event.resourceType === 'workspace'
    ? event.externalWorkspaceId
    : event.conversationExternalId
  if (event.resourceExternalId !== expectedResourceId) {
    throw new ChatProviderAdapterError(
      'ChatProviderScopeMismatch',
      'The parent lifecycle resource does not match its authenticated envelope scope.',
    )
  }
}

/**
 * Validates one current link against an installation-scoped parent lifecycle event.
 *
 * @param link - Current active link selected by the sparse lookup.
 * @param event - Workspace or conversation lifecycle event.
 */
function validateParentLifecycleLinkScope(
  link: ExternalChatWorkItemLink,
  event: ExternalChatParentLifecycleEvent,
): void {
  if (
    link.installationId !== event.installationId ||
    link.provider !== event.provider ||
    link.source.externalWorkspaceId !== event.externalWorkspaceId ||
    (
      event.resourceType === 'conversation' &&
      link.source.conversationExternalId !== event.conversationExternalId
    )
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderScopeMismatch',
      'The parent lifecycle event escaped its installation-owned link scope.',
    )
  }
}

/**
 * Creates a deterministic link-scoped child event for exact fan-out replay.
 *
 * @param event - Original provider parent lifecycle event.
 * @param linkId - Active link receiving this child.
 * @returns Parent event with a collision-resistant internal child event ID.
 */
function createParentLifecycleChildEvent(
  event: ExternalChatParentLifecycleEvent,
  linkId: string,
): ExternalChatParentLifecycleEvent {
  const digest = createExternalChatFingerprint({
    version: 1,
    parentEventId: event.eventId,
    linkId,
  })
  return {
    ...event,
    eventId: `chat_parent_child_${digest.slice(0, 40)}`,
  }
}

/**
 * Builds the exact provider thread identity owned by one link.
 *
 * @param link - Provider-neutral external chat link.
 * @returns Canonical source identity.
 */
function linkSourceIdentity(link: ExternalChatWorkItemLink): ExternalChatSourceIdentity {
  return {
    provider: link.provider,
    externalWorkspaceId: link.source.externalWorkspaceId,
    conversationExternalId: link.source.conversationExternalId,
    threadExternalId: link.source.threadExternalId,
  }
}

/**
 * Checks whether a restrictive link state permanently blocks non-lifecycle content processing.
 *
 * @param link - Current provider-neutral link.
 * @returns Whether content must be skipped and any deferred payload discarded.
 */
function linkForbidsContentSynchronization(link: ExternalChatWorkItemLink): boolean {
  return link.sourceAvailability === 'permission-lost' ||
    link.sourceAvailability === 'scope-changed' ||
    link.sourceState === 'retained-metadata' ||
    link.sourceState === 'deleted' ||
    link.sourceState === 'retention-expired'
}

/**
 * Extracts the canonical provider thread identity from a normalized event.
 *
 * @param event - Provider-neutral inbound event.
 * @returns Source identity used by the tenant-scoped unique claim.
 */
function sourceIdentity(event: ExternalChatInboundEvent): ExternalChatSourceIdentity {
  return {
    provider: event.provider,
    externalWorkspaceId: event.externalWorkspaceId,
    conversationExternalId: event.conversationExternalId,
    threadExternalId: event.threadExternalId,
  }
}

/**
 * Requires an inbound event to match the full installation and linked provider source scope.
 *
 * @param record - Active source-owning link.
 * @param event - Verified provider-neutral event.
 */
function validateInboundScope(
  record: StoredExternalChatLink,
  event: ExternalChatInboundEvent,
): void {
  if (
    record.workspaceId.length === 0 ||
    record.link.installationId !== event.installationId ||
    record.link.provider !== event.provider ||
    record.link.source.externalWorkspaceId !== event.externalWorkspaceId ||
    record.link.source.conversationExternalId !== event.conversationExternalId ||
    record.link.source.threadExternalId !== event.threadExternalId
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderScopeMismatch',
      'The provider event does not match the linked installation and source scope.',
    )
  }
}

/**
 * Requires an outbound event to match the link's Workspace, Team, and Work Item ownership.
 *
 * @param record - Active external chat link.
 * @param event - Trusted internal mutation.
 */
function validateOutboundScope(
  record: StoredExternalChatLink,
  event: ExternalChatSyncOutboundEvent,
): void {
  if (!outboundScopeMatches(record, event)) {
    throw new ExternalChatError(
      'ExternalChatAuthorizationFailed',
      'The outbound mutation does not match the linked Work Item scope.',
    )
  }
}

/**
 * Checks an outbound event against the link owner without consulting a canonical redirect.
 *
 * @param record - Current stored link.
 * @param event - Trusted internal mutation carrying its original ownership scope.
 * @returns Whether the event already names the current owner exactly.
 */
function outboundScopeMatches(
  record: StoredExternalChatLink,
  event: ExternalChatSyncOutboundEvent,
): boolean {
  return record.workspaceId === event.workspaceId &&
    record.link.id === event.linkId &&
    record.link.teamId === event.teamId &&
    record.link.workItemId === event.workItemId
}

/**
 * Checks whether a link accepts provider-to-internal mutations.
 *
 * @param direction - Configured synchronization direction.
 * @returns Whether inbound mutations are enabled.
 */
function allowsInbound(direction: ExternalChatWorkItemLink['syncDirection']): boolean {
  return direction === 'inbound' || direction === 'bidirectional'
}

/**
 * Checks whether a link accepts internal-to-provider mutations.
 *
 * @param direction - Configured synchronization direction.
 * @returns Whether outbound mutations are enabled.
 */
function allowsOutbound(direction: ExternalChatWorkItemLink['syncDirection']): boolean {
  return direction === 'outbound' || direction === 'bidirectional'
}

/**
 * Detects an event whose content cannot currently be imported under provider policy.
 *
 * @param event - Verified provider-neutral event.
 * @returns Whether processing must wait for source recovery.
 */
function isUnavailableEvent(event: ExternalChatInboundEvent): boolean {
  if (event.type !== 'message.created' && event.type !== 'message.edited') return false
  return event.message.availability !== 'available' ||
    event.message.state === 'retention-expired'
}

/**
 * Rejects a provider message that escaped the linked conversation or thread.
 *
 * @param link - Linked external source.
 * @param message - Provider-normalized message.
 */
function validateMessageScope(link: ExternalChatWorkItemLink, message: ExternalChatMessage): void {
  if (
    message.conversationExternalId !== link.source.conversationExternalId ||
    message.threadExternalId !== link.source.threadExternalId
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderScopeMismatch',
      'The provider message does not match the linked conversation and thread.',
    )
  }
}

/**
 * Builds permission-filtered internal comment provenance from one provider message.
 *
 * @param provider - Chat provider that owns the message.
 * @param linkId - External chat link identifier.
 * @param message - Provider-normalized message.
 * @param attachments - Provider metadata after removing internal File ID claims.
 * @returns Collaboration source projection.
 */
function commentSource(
  provider: ExternalChatProvider,
  linkId: string,
  message: ExternalChatMessage,
  attachments: Array<Omit<ExternalChatAttachment, 'importedFileId'>>,
): ExternalChatSyncCommentSource {
  if (message.permalink === undefined) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'An imported provider message requires an authorized HTTPS permalink.',
    )
  }
  return {
    provider,
    linkId,
    externalMessageId: message.externalId,
    permalink: message.permalink,
    ...(message.actor === undefined ? {} : { actor: copyExternalActor(message.actor) }),
    postedAt: message.postedAt,
    quotedRanges: message.quotedRanges.map(copyExternalQuotedRange),
    attachments: attachments.map(copyExternalAttachmentWithoutImportedFileId),
  }
}

/**
 * Constructs an exact permission-filtered provider actor snapshot.
 *
 * @param actor - Provider-normalized actor metadata.
 * @returns Exact actor projection without runtime-only properties.
 */
function copyExternalActor(actor: ExternalChatActor): ExternalChatActor {
  return {
    externalId: actor.externalId,
    kind: actor.kind,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
  }
}

/**
 * Constructs an exact quoted-range provenance snapshot.
 *
 * @param quote - Provider-normalized quoted range.
 * @returns Exact quote projection without runtime-only properties.
 */
function copyExternalQuotedRange(quote: ExternalChatQuotedRange): ExternalChatQuotedRange {
  return {
    sourceMessageExternalId: quote.sourceMessageExternalId,
    startOffset: quote.startOffset,
    endOffset: quote.endOffset,
    text: quote.text,
  }
}

/**
 * Constructs exact provider attachment metadata without trusting an internal File ID claim.
 *
 * @param attachment - Permission-filtered provider attachment metadata.
 * @returns Exact provider metadata without an internal identity claim or runtime-only properties.
 */
function copyExternalAttachmentWithoutImportedFileId(
  attachment: ExternalChatAttachment,
): Omit<ExternalChatAttachment, 'importedFileId'> {
  return {
    externalId: attachment.externalId,
    fileName: attachment.fileName,
    ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
    ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
    ...(attachment.permalink === undefined ? {} : { permalink: attachment.permalink }),
    availability: attachment.availability,
    state: attachment.state,
    ...(attachment.createdAt === undefined ? {} : { createdAt: attachment.createdAt }),
    ...(attachment.deletedAt === undefined ? {} : { deletedAt: attachment.deletedAt }),
  }
}

/**
 * Validates and deduplicates server-issued internal File identifiers.
 *
 * @param values - File IDs returned by the private authorized import pipeline.
 * @returns Deterministically ordered unique File IDs.
 */
function uniqueInternalFileIds(values: readonly string[]): string[] {
  for (const value of values) {
    if (value.length === 0 || value.length > 512 || /\p{Cc}/u.test(value)) {
      throw new ExternalChatSyncPortError(
        'ExternalChatSyncInvalidMutation',
        'The attachment import pipeline returned an invalid internal File ID.',
      )
    }
  }
  return uniqueStrings(values)
}

/**
 * Creates a classified missing-authorization failure for an impossible narrowed branch.
 *
 * @returns Retryable source-unavailable error.
 */
function missingInstallationAuthorizationError(): ExternalChatSyncPortError {
  return new ExternalChatSyncPortError(
    'ExternalChatSyncSourceUnavailable',
    'Current installation authorization is unavailable.',
    { retryable: true },
  )
}

/**
 * Deduplicates and sorts stable internal identifiers.
 *
 * @param values - Candidate identifiers.
 * @returns Deterministically ordered unique identifiers.
 */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * Recognizes a recovered binding write for the same logical synchronization operation.
 *
 * @param record - Current conflicting record, when present.
 * @param binding - Intended replacement binding.
 * @returns Whether the current record already contains the intended logical commit.
 */
function sameCommittedBinding(
  record: StoredExternalChatMessageBinding | undefined,
  binding: ExternalChatMessageBinding,
): boolean {
  if (!record) return false
  return record.binding.linkId === binding.linkId &&
    record.binding.externalMessageId === binding.externalMessageId &&
    record.binding.internalCommentId === binding.internalCommentId &&
    record.binding.externalVersion === binding.externalVersion &&
    record.binding.internalCommentVersion === binding.internalCommentVersion &&
    record.binding.lastInboundEventId === binding.lastInboundEventId &&
    record.binding.lastOutboundOperationId === binding.lastOutboundOperationId &&
    record.binding.deletedAt === binding.deletedAt
}

/**
 * Maps source reachability and lifecycle to an honest link synchronization state.
 *
 * @param availability - Current installation access state.
 * @param state - Last known source lifecycle state.
 * @returns User-visible synchronization status.
 */
function statusForSource(
  availability: ExternalChatSourceAvailability,
  state: ExternalChatSourceState,
): ExternalChatWorkItemLink['syncStatus'] {
  if (availability !== 'available') return 'paused'
  if (
    state === 'deleted' ||
    state === 'retained-metadata' ||
    state === 'retention-expired'
  ) return 'paused'
  return 'synced'
}

/**
 * Advances only the store-owned lifecycle revision while retaining semantic watermarks.
 *
 * @param current - Current committed lifecycle state.
 * @param updatedAt - Completion timestamp for the no-op ordering decision.
 * @returns Adjacent lifecycle state with the same provider and Work Item watermarks.
 */
function advanceThreadLifecycleState(
  current: ExternalChatThreadLifecycleState,
  updatedAt: string,
): ExternalChatThreadLifecycleState {
  return {
    completed: current.completed,
    ...(current.lastExternalVersion === undefined
      ? {}
      : { lastExternalVersion: current.lastExternalVersion }),
    ...(current.lastInternalWorkItemRevision === undefined
      ? {}
      : { lastInternalWorkItemRevision: current.lastInternalWorkItemRevision }),
    revision: current.revision + 1,
    updatedAt,
  }
}

/**
 * Creates one adjacent authoritative lifecycle state from observed provider and internal versions.
 *
 * @param current - Current committed lifecycle state.
 * @param completed - Authoritative observed provider completion state.
 * @param externalVersion - Provider revision returned or delivered for the state.
 * @param workItemRevision - Current internal Work Item revision associated with the operation.
 * @param updatedAt - Lifecycle commit timestamp.
 * @returns Complete adjacent lifecycle state.
 */
function createThreadLifecycleState(
  current: ExternalChatThreadLifecycleState,
  completed: boolean,
  externalVersion: string,
  workItemRevision: number,
  updatedAt: string,
): ExternalChatThreadLifecycleState {
  return {
    completed,
    lastExternalVersion: requireExternalVersion(externalVersion),
    lastInternalWorkItemRevision: requireWorkItemRevision(workItemRevision),
    revision: current.revision + 1,
    updatedAt,
  }
}

/**
 * Maps a completed lifecycle decision to its user-visible link status.
 *
 * @param outcome - Exact committed lifecycle outcome.
 * @returns Projected status, or no projection for a stale no-op.
 */
function threadLifecycleSyncStatus(
  outcome: ExternalChatSyncOutcome,
): ExternalChatWorkItemLink['syncStatus'] | undefined {
  if (outcome.kind === 'applied') return 'synced'
  if (outcome.kind === 'deferred') return 'pending'
  if (outcome.kind === 'failed') return 'conflict'
  if (outcome.reason === 'not-eligible' || outcome.reason === 'paused') return 'paused'
  return undefined
}

/**
 * Classifies a trusted Work Item lifecycle revision against the last committed watermark.
 *
 * @param previousRevision - Last internal Work Item revision committed for the link.
 * @param incomingRevision - Incoming canonical Work Item revision.
 * @returns Apply, stale, or defer decision.
 */
function internalWorkItemRevisionOrder(
  previousRevision: number | undefined,
  incomingRevision: number,
): ExternalChatSyncThreadOrderDecision {
  const incoming = requireWorkItemRevision(incomingRevision)
  if (previousRevision === undefined) return 'apply'
  const previous = requireWorkItemRevision(previousRevision)
  if (incoming <= previous) return 'stale'
  return incoming === previous + 1 ? 'apply' : 'defer'
}

/**
 * Validates one canonical Work Item revision returned by an internal adapter.
 *
 * @param value - Candidate positive safe integer revision.
 * @returns Validated Work Item revision.
 */
function requireWorkItemRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ExternalChatSyncPortError(
      'ExternalChatSyncInvalidMutation',
      'The Work Item completion adapter returned an invalid revision.',
    )
  }
  return value
}

/**
 * Validates one bounded provider lifecycle version.
 *
 * @param value - Candidate provider version.
 * @returns Validated provider version.
 */
function requireExternalVersion(value: string): string {
  if (value.length === 0 || value.length > 2_048 || /\p{Cc}/u.test(value)) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'The provider returned an invalid thread lifecycle version.',
    )
  }
  return value
}

/**
 * Requires an edit or delete response to retain the exact requested provider message identity.
 *
 * @param expectedExternalMessageId - Provider message identifier sent to the mutation.
 * @param message - Provider-normalized mutation response.
 */
function validateMessageMutationIdentity(
  expectedExternalMessageId: string,
  message: ExternalChatMessage,
): void {
  if (message.externalId !== expectedExternalMessageId) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'The provider message mutation returned another message identity.',
    )
  }
}

/**
 * Requires a create response to describe an available active message safe for future mutation.
 *
 * @param message - Provider-normalized create response.
 */
function validateCreatedMessageResult(message: ExternalChatMessage): void {
  if (
    message.availability !== 'available' || message.state !== 'active' ||
    message.permalink === undefined
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'The provider message create response is not an available active message.',
    )
  }
}

/**
 * Requires an edit response to be active and to advance the provider revision.
 *
 * @param previousExternalVersion - Provider revision supplied as the edit precondition.
 * @param message - Provider-normalized edit response.
 */
function validateEditedMessageResult(
  previousExternalVersion: string,
  message: ExternalChatMessage,
): void {
  if (
    message.availability !== 'available' || message.state !== 'active' ||
    message.permalink === undefined || message.externalVersion === previousExternalVersion
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'The provider message edit response did not return an updated active message.',
    )
  }
}

/**
 * Requires a delete response to be a version-advanced tombstone with a canonical deletion time.
 *
 * @param previousExternalVersion - Provider revision supplied as the delete precondition.
 * @param message - Provider-normalized delete response.
 * @returns Canonical provider deletion timestamp.
 */
function validateDeletedMessageResult(
  previousExternalVersion: string,
  message: ExternalChatMessage,
): string {
  if (
    message.state !== 'deleted' || message.deletedAt === undefined ||
    message.externalVersion === previousExternalVersion
  ) {
    throw new ChatProviderAdapterError(
      'ChatProviderInvalidResponse',
      'The provider message delete response did not return a version-advanced tombstone.',
    )
  }
  return message.deletedAt
}

/**
 * Creates a retryable revision conflict for a lost lifecycle lease or link ownership fence.
 *
 * @returns Classified retryable lifecycle conflict.
 */
function lifecycleRevisionConflictError(): ExternalChatSyncPortError {
  return new ExternalChatSyncPortError(
    'ExternalChatSyncRevisionConflict',
    'The thread lifecycle lease or link revision changed before completion.',
    { retryable: true },
  )
}

/**
 * Classifies a trusted internal comment version against its current binding.
 *
 * @param current - Current binding, when message creation has committed.
 * @param incomingVersion - Incoming canonical internal comment version.
 * @returns Internal ordering decision.
 */
function internalVersionOrder(
  current: StoredExternalChatMessageBinding | undefined,
  incomingVersion: number,
): ExternalChatSyncInternalVersionOrder {
  if (!current) return 'missing'
  if (incomingVersion <= current.binding.internalCommentVersion) return 'stale'
  if (incomingVersion !== current.binding.internalCommentVersion + 1) return 'defer'
  return 'apply'
}

/**
 * Creates a deterministic outbound operation identifier from immutable event identity and version.
 *
 * @param event - Trusted internal mutation.
 * @returns Stable retry-safe outbound operation identifier.
 */
function createOutboundOperationId(event: ExternalChatSyncOutboundEvent): string {
  const entityId = event.type === 'work-item.completed' || event.type === 'work-item.reopened'
    ? event.workItemId
    : event.internalCommentId
  const revision = event.type === 'work-item.completed' || event.type === 'work-item.reopened'
    ? event.workItemRevision
    : event.internalCommentVersion
  const digest = createExternalChatFingerprint({
    version: 1,
    workspaceId: event.workspaceId,
    linkId: event.linkId,
    type: event.type,
    entityId,
    revision,
  })
  return `chat_out_${digest.slice(0, 40)}`
}

/**
 * Creates a bounded audit operation identifier for an authorized source view.
 *
 * @param linkId - External chat link identifier.
 * @param principalId - Current internal principal identifier.
 * @param occurredAt - View timestamp.
 * @returns Stable operation identifier for this view attempt.
 */
function createSourceViewOperationId(
  linkId: string,
  principalId: string,
  occurredAt: string,
): string {
  const digest = createExternalChatFingerprint({
    version: 1,
    linkId,
    principalId,
    occurredAt,
  })
  return `chat_view_${digest.slice(0, 40)}`
}

/**
 * Adds a bounded millisecond interval to a canonical timestamp.
 *
 * @param timestamp - Base ISO 8601 timestamp.
 * @param milliseconds - Positive interval.
 * @returns Canonical ISO 8601 UTC timestamp.
 */
function addMilliseconds(timestamp: string, milliseconds: number): string {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The synchronization clock returned an invalid timestamp.',
    )
  }
  return new Date(parsed + milliseconds).toISOString()
}

/**
 * Creates a successful synchronization outcome.
 *
 * @param operationId - Stable logical operation identifier.
 * @param eventId - Optional provider event identifier.
 * @param direction - Applied synchronization direction.
 * @param occurredAt - Completion timestamp.
 * @returns Applied outcome.
 */
function appliedOutcome(
  operationId: string,
  eventId: string | undefined,
  direction: 'inbound' | 'outbound',
  occurredAt: string,
): ExternalChatSyncOutcome {
  return eventId
    ? { kind: 'applied', operationId, eventId, direction, occurredAt }
    : { kind: 'applied', operationId, direction, occurredAt }
}

/**
 * Creates a safe no-op synchronization outcome.
 *
 * @param operationId - Stable logical operation identifier.
 * @param eventId - Optional provider event identifier.
 * @param reason - Stable skip reason.
 * @param occurredAt - Decision timestamp.
 * @returns Skipped outcome.
 */
function skippedOutcome(
  operationId: string,
  eventId: string | undefined,
  reason: Extract<ExternalChatSyncOutcome, { kind: 'skipped' }>['reason'],
  occurredAt: string,
): ExternalChatSyncOutcome {
  return eventId
    ? { kind: 'skipped', operationId, eventId, reason, occurredAt }
    : { kind: 'skipped', operationId, reason, occurredAt }
}

/**
 * Creates an honestly retryable synchronization outcome.
 *
 * @param operationId - Stable logical operation identifier.
 * @param eventId - Optional provider event identifier.
 * @param reason - Stable defer reason.
 * @param occurredAt - Decision timestamp.
 * @param retryAt - Earliest safe retry timestamp.
 * @returns Deferred outcome.
 */
function deferredOutcome(
  operationId: string,
  eventId: string | undefined,
  reason: Extract<ExternalChatSyncOutcome, { kind: 'deferred' }>['reason'],
  occurredAt: string,
  retryAt: string,
): ExternalChatSyncOutcome {
  return eventId
    ? { kind: 'deferred', operationId, eventId, reason, occurredAt, retryAt }
    : { kind: 'deferred', operationId, reason, occurredAt, retryAt }
}

/**
 * Creates a secret-free terminal synchronization failure.
 *
 * @param operationId - Stable logical operation identifier.
 * @param eventId - Optional provider event identifier.
 * @param errorCode - Stable secret-free failure code.
 * @param retryable - Whether retrying may recover.
 * @param occurredAt - Failure timestamp.
 * @returns Failed outcome.
 */
function failedOutcome(
  operationId: string,
  eventId: string | undefined,
  errorCode: string,
  retryable: boolean,
  occurredAt: string,
): ExternalChatSyncOutcome {
  return eventId
    ? { kind: 'failed', operationId, eventId, errorCode, retryable, occurredAt }
    : { kind: 'failed', operationId, errorCode, retryable, occurredAt }
}

/**
 * Checks whether an outcome can permanently remove its durable retry entry.
 *
 * @param outcome - Receipt outcome being committed or replayed.
 * @returns Whether no scheduled retry remains necessary.
 */
function isTerminalSyncOutcome(outcome: ExternalChatSyncOutcome): boolean {
  return outcome.kind === 'applied' ||
    outcome.kind === 'skipped' ||
    (outcome.kind === 'failed' && !outcome.retryable)
}

/**
 * Resolves the durable retry schedule for a non-terminal outbound outcome.
 *
 * @param outcome - Receipt outcome produced by one outbound attempt.
 * @param completedAt - Canonical attempt completion timestamp.
 * @param deferDelayMs - Fallback retry delay for retryable failures.
 * @returns Earliest retry timestamp, or undefined for a terminal outcome.
 */
function outboundRetryAt(
  outcome: ExternalChatSyncOutcome,
  completedAt: string,
  deferDelayMs: number,
): string | undefined {
  if (outcome.kind === 'deferred') {
    return outcome.retryAt ?? normalizeExternalChatRetryAt(
      completedAt,
      outcome.operationId,
      undefined,
      deferDelayMs,
    )
  }
  if (outcome.kind === 'failed' && outcome.retryable) {
    return normalizeExternalChatRetryAt(
      completedAt,
      outcome.operationId,
      undefined,
      deferDelayMs,
    )
  }
  return undefined
}

/**
 * Converts classified port and provider errors to stable retry or failure outcomes.
 *
 * @param error - Unknown caught failure.
 * @param operationId - Stable logical operation identifier.
 * @param eventId - Optional provider event identifier.
 * @param occurredAt - Classification timestamp.
 * @param deferDelayMs - Configured fallback retry delay.
 * @returns Secret-free synchronization outcome.
 */
function classifyFailure(
  error: unknown,
  operationId: string,
  eventId: string | undefined,
  occurredAt: string,
  deferDelayMs: number,
): ExternalChatSyncOutcome {
  if (error instanceof ChatProviderAdapterError) {
    if (error.code === 'ChatProviderRateLimited') {
      return deferredOutcome(
        operationId,
        eventId,
        'rate-limited',
        occurredAt,
        normalizeExternalChatRetryAt(occurredAt, operationId, error.retryAt, deferDelayMs),
      )
    }
    if (
      error.code === 'ChatProviderTransientFailure' ||
      error.code === 'ChatProviderDisconnected'
    ) {
      return deferredOutcome(
        operationId,
        eventId,
        'source-unavailable',
        occurredAt,
        normalizeExternalChatRetryAt(occurredAt, operationId, error.retryAt, deferDelayMs),
      )
    }
    return failedOutcome(operationId, eventId, error.code, error.retryable, occurredAt)
  }
  if (error instanceof ExternalChatSyncPortError) {
    if (error.code === 'ExternalChatSyncRateLimited') {
      return deferredOutcome(
        operationId,
        eventId,
        'rate-limited',
        occurredAt,
        normalizeExternalChatRetryAt(occurredAt, operationId, error.retryAt, deferDelayMs),
      )
    }
    if (error.code === 'ExternalChatSyncRevisionConflict') {
      return deferredOutcome(
        operationId,
        eventId,
        'out-of-order',
        occurredAt,
        normalizeExternalChatRetryAt(occurredAt, operationId, error.retryAt, deferDelayMs),
      )
    }
    if (error.code === 'ExternalChatSyncSourceUnavailable' || error.retryable) {
      return deferredOutcome(
        operationId,
        eventId,
        'source-unavailable',
        occurredAt,
        normalizeExternalChatRetryAt(occurredAt, operationId, error.retryAt, deferDelayMs),
      )
    }
    return failedOutcome(operationId, eventId, error.code, false, occurredAt)
  }
  if (error instanceof ExternalChatError) {
    if (error.retryable) {
      return deferredOutcome(
        operationId,
        eventId,
        'source-unavailable',
        occurredAt,
        normalizeExternalChatRetryAt(occurredAt, operationId, undefined, deferDelayMs),
      )
    }
    return failedOutcome(operationId, eventId, error.code, false, occurredAt)
  }
  return failedOutcome(
    operationId,
    eventId,
    'ExternalChatUnexpectedFailure',
    false,
    occurredAt,
  )
}

/**
 * Maps an inbound event to its secret-free audit action.
 *
 * @param event - Provider-neutral inbound event.
 * @returns Audit action.
 */
function inboundAuditAction(event: ExternalChatInboundEvent): ExternalChatSyncAuditAction {
  switch (event.type) {
    case 'message.created':
      return 'message.created'
    case 'message.edited':
      return 'message.edited'
    case 'message.deleted':
      return 'message.deleted'
    case 'thread.completed':
      return 'thread.completed'
    case 'thread.reopened':
      return 'thread.reopened'
    case 'source.lifecycle-changed':
      return 'source.lifecycle-changed'
  }
}

/**
 * Converts an adapter-provided correlation value to a safe stable internal correlation identifier.
 *
 * @param providerCorrelationId - Bounded provider or adapter correlation value.
 * @returns One-way internal correlation identifier that cannot retain a mistaken provider secret.
 */
function inboundCorrelationId(providerCorrelationId: string): string {
  const digest = createExternalChatFingerprint({ providerCorrelationId })
  return `chat_corr_${digest.slice(0, 40)}`
}

/**
 * Maps one eligible internal mutation to the exact provider event action expected on echo.
 *
 * @param event - Trusted internal outbound mutation.
 * @returns Action embedded in the authenticated origin marker.
 */
function outboundOriginAction(event: ExternalChatSyncOutboundEvent): ChatProviderOriginAction {
  switch (event.type) {
    case 'comment.created':
      return 'message.created'
    case 'comment.edited':
      return 'message.edited'
    case 'comment.deleted':
      return 'message.deleted'
    case 'work-item.completed':
      return 'thread.completed'
    case 'work-item.reopened':
      return 'thread.reopened'
  }
}

/**
 * Maps an outbound event to its corresponding provider-facing audit action.
 *
 * @param event - Trusted internal outbound event.
 * @returns Audit action.
 */
function outboundAuditAction(event: ExternalChatSyncOutboundEvent): ExternalChatSyncAuditAction {
  switch (event.type) {
    case 'comment.created':
      return 'message.created'
    case 'comment.edited':
      return 'message.edited'
    case 'comment.deleted':
      return 'message.deleted'
    case 'work-item.completed':
      return 'thread.completed'
    case 'work-item.reopened':
      return 'thread.reopened'
  }
}

/**
 * Reads only the external actor kind allowed in redacted audit records.
 *
 * @param event - Provider-neutral inbound event.
 * @returns Actor kind when the event contains a permission-filtered actor.
 */
function inboundActorKind(event: ExternalChatInboundEvent): ExternalChatActor['kind'] | undefined {
  if (event.type === 'message.created' || event.type === 'message.edited') {
    return event.message.actor?.kind
  }
  return undefined
}

/**
 * Derives a one-way provider-scoped actor digest without retaining the raw external identifier.
 *
 * @param event - Provider-neutral inbound event.
 * @returns Pseudonymous actor digest when the event contains an actor.
 */
function inboundActorDigest(event: ExternalChatInboundEvent): string | undefined {
  if (
    (event.type !== 'message.created' && event.type !== 'message.edited') ||
    !event.message.actor
  ) {
    return undefined
  }
  return createExternalChatFingerprint({
    version: 1,
    provider: event.provider,
    externalWorkspaceId: event.externalWorkspaceId,
    externalActorId: event.message.actor.externalId,
  })
}

/**
 * Identifies provider failures that represent installation or source state, not viewer denial.
 *
 * @param error - Unknown provider read failure.
 * @returns Whether the failure may safely update shared link availability.
 */
function isInstallationLevelProviderFailure(error: unknown): boolean {
  if (!(error instanceof ChatProviderAdapterError)) return false
  return error.code === 'ChatProviderReauthorizationRequired' ||
    error.code === 'ChatProviderDisconnected' ||
    error.code === 'ChatProviderSourceNotFound' ||
    error.code === 'ChatProviderTransientFailure' ||
    error.code === 'ChatProviderRateLimited'
}

/**
 * Projects authorization and source lifecycle provider failures onto a link.
 *
 * @param error - Unknown caught provider failure.
 * @returns Safe link projection, or undefined for failures unrelated to source state.
 */
function providerFailureProjection(
  error: unknown,
): ExternalChatSyncProviderFailureProjection | undefined {
  if (error instanceof ExternalChatSyncPortError) {
    if (error.code === 'ExternalChatSyncPermissionDenied') {
      return { availability: 'permission-lost', status: 'paused' }
    }
    if (error.code === 'ExternalChatSyncSourceUnavailable') {
      return { availability: 'temporarily-unavailable', status: 'pending' }
    }
    return undefined
  }
  if (!(error instanceof ChatProviderAdapterError)) return undefined
  switch (error.code) {
    case 'ChatProviderPermissionDenied':
      return { availability: 'permission-lost', status: 'paused' }
    case 'ChatProviderReauthorizationRequired':
      return { availability: 'needs-reauth', status: 'paused' }
    case 'ChatProviderDisconnected':
      return { availability: 'installation-disconnected', status: 'paused' }
    case 'ChatProviderSourceNotFound':
      return { availability: 'available', state: 'deleted', status: 'paused' }
    case 'ChatProviderTransientFailure':
    case 'ChatProviderRateLimited':
      return { availability: 'temporarily-unavailable', status: 'pending' }
    default:
      return undefined
  }
}
