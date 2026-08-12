import { describe, expect, test } from 'bun:test'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  type ExternalChatAttachment,
  type ExternalChatInboundEvent,
  type ExternalChatMessage,
  type ExternalChatThreadReference,
  type ExternalChatThreadSelection,
  type ExternalChatThreadSnapshot,
  type ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import {
  ChatProviderAdapterError,
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
import {
  createExternalChatInboundOperationId,
  createExternalChatFingerprint,
  type DeferredExternalChatEvent,
  ExternalChatError,
  type ExternalChatOutboundRetryPermit,
  InMemoryExternalChatStore,
  type ReleaseExternalChatOutboundRetryPermitInput,
  type RenewExternalChatOutboundRetryPermitInput,
  type ValidateExternalChatOutboundRetryPermitInput,
} from './external-chat'
import {
  ExternalChatSyncPortError,
  ExternalChatSyncService,
  type ExternalChatSyncAccessPort,
  type ExternalChatSyncApplyResourceLifecycleInput,
  type ExternalChatSyncApplyResourceLifecycleResult,
  type ExternalChatSyncAttachmentPort,
  type ExternalChatSyncAuditPort,
  type ExternalChatSyncAuditRecord,
  type ExternalChatSyncClockPort,
  type ExternalChatSyncCollaborationPort,
  type ExternalChatSyncCommentMutationResult,
  type ExternalChatSyncCreateCommentInput,
  type ExternalChatSyncCursorCodecPort,
  type ExternalChatSyncCursorScope,
  type ExternalChatSyncDeleteCommentInput,
  type ExternalChatSyncImportAttachmentsInput,
  type ExternalChatSyncImportAttachmentsResult,
  type ExternalChatSyncMessageOrderInput,
  type ExternalChatSyncMessageOrderPort,
  type ExternalChatSyncRedactLinkResourcesInput,
  type ExternalChatSyncSetWorkItemCompletionInput,
  type ExternalChatSyncSetWorkItemCompletionResult,
  type ExternalChatSyncThreadOrderInput,
  type ExternalChatSyncThreadOrderPort,
  type ExternalChatSyncUpdateCommentInput,
  type ExternalChatSyncWorkItemPort,
} from './external-chat-sync-service'
import {
  ExternalChatResyncWorker,
  type ExternalChatFullResyncBoundary,
  type ExternalChatFullResyncSeenMessageInput,
  type ExternalChatResyncReconciliationPort,
  type ExternalChatResyncRedactionInput,
} from './external-chat-resync-worker'
import {
  type ExternalChatOutboundDeadLetterInput,
  type ExternalChatOutboundRetryConcurrencyInput,
  ExternalChatOutboundDeferredRetryWorker,
} from './external-chat-outbound-deferred-retry-worker'
import { ExternalChatDeferredRetryWorker } from './external-chat-deferred-retry-worker'
import { ExternalChatWebhookRuntime } from './external-chat-webhook-runtime'

const workspaceId = 'workspace-e2e'
const duplicateTeamId = 'team-duplicate'
const duplicateWorkItemId = 'work-item-duplicate'
const canonicalTeamId = 'team-canonical'
const canonicalWorkItemId = 'work-item-canonical'
const linkId = 'external-chat-link-e2e'
const installationId = 'slack-installation-e2e'
const principalId = 'member-e2e'
const signingSecret = 'external-chat-e2e-signing-secret-with-32-bytes'
const initialNow = '2026-08-06T03:00:00.000Z'
const providerRetryAt = '2026-08-06T03:05:00.000Z'

/** Mutable internal collaboration comment retained by the synthetic fixture. */
type SyntheticComment = {
  /** Canonical internal comment identifier. */
  id: string
  /** External chat link provenance that owns the imported comment. */
  linkId: string
  /** Current Team owner moved by duplicate merge. */
  teamId: string
  /** Current Work Item owner moved by duplicate merge. */
  workItemId: string
  /** Latest normalized Markdown body. */
  bodyMarkdown: string
  /** Current internal comment version. */
  version: number
  /** Whether the comment is a tombstone. */
  deleted: boolean
  /** Bound internal parent comment for an imported external reply. */
  parentCommentId?: string
  /** Scanned internal files imported from the external message. */
  importedFileIds: string[]
}

/** Link provenance retained for one synthetic imported File. */
type SyntheticFileOwner = {
  /** External chat link that owns the imported File. */
  linkId: string
  /** Current Team owner moved by duplicate merge. */
  teamId: string
  /** Current Work Item owner moved by duplicate merge. */
  workItemId: string
}

/** Complete synthetic runtime used by each end-to-end synchronization scenario. */
type SyntheticFixture = {
  /** In-memory durable synchronization state. */
  store: StrictDeferredFingerprintStore
  /** Provider-neutral synchronization application service. */
  service: ExternalChatSyncService
  /** Raw-webhook entrypoint backed by the same synchronization service. */
  webhookRuntime: ExternalChatWebhookRuntime
  /** Synthetic Slack provider. */
  provider: SyntheticChatProviderAdapter
  /** Mutable internal collaboration boundary. */
  collaboration: SyntheticCollaborationPort
  /** Authorized private Files attachment import boundary. */
  attachments: SyntheticAttachmentPort
  /** Mutable Work Item completion boundary. */
  workItems: SyntheticWorkItemPort
  /** Mutable dual-authorization boundary. */
  access: SyntheticAccessPort
  /** Idempotent redacted synchronization audit boundary. */
  audit: SyntheticAuditPort
  /** Deterministic fixture clock. */
  clock: MutableClock
  /** Initial external chat link. */
  link: ExternalChatWorkItemLink
}

/** Identity fields used to add one sibling link to a fan-out fixture. */
type SiblingLinkOptions = {
  /** Stable external chat link identifier. */
  linkId: string
  /** Connector installation that owns this link. */
  installationId: string
  /** Provider-scoped conversation identifier. */
  conversationExternalId: string
  /** Provider-scoped thread identifier. */
  threadExternalId: string
  /** Optional provider authorization generation used to resolve the source. */
  authorizationRevision?: number
  /** Optional Team owner used by duplicate merge scenarios. */
  teamId?: string
  /** Optional Work Item owner used by duplicate merge scenarios. */
  workItemId?: string
}

/** Deterministic clock that can cross deferred receipt retry boundaries. */
class MutableClock implements ExternalChatSyncClockPort {
  /** Current canonical ISO timestamp. */
  private current: string

  /**
   * Creates a deterministic clock.
   *
   * @param current - Initial canonical ISO timestamp.
   */
  constructor(current: string) {
    this.current = current
  }

  /** Returns the current deterministic timestamp. */
  now(): string {
    return this.current
  }

  /**
   * Moves the clock to an explicit timestamp.
   *
   * @param current - Replacement canonical ISO timestamp.
   */
  set(current: string): void {
    this.current = current
  }
}

/** Installation concurrency gate that records one active outbound worker permit. */
class SyntheticOutboundRetryConcurrencyPort {
  /** Permit acquisition scopes in call order. */
  readonly acquisitions: ExternalChatOutboundRetryConcurrencyInput[] = []

  /** Permit release scopes in call order. */
  readonly releases: ReleaseExternalChatOutboundRetryPermitInput[] = []

  /** In-memory durable permit semantics exercised by the worker integration tests. */
  private readonly store = new InMemoryExternalChatStore()

  /** Acquires every synthetic installation permit immediately. */
  async acquireOutboundRetryPermit(
    input: ExternalChatOutboundRetryConcurrencyInput,
  ): Promise<ExternalChatOutboundRetryPermit | undefined> {
    this.acquisitions.push(input)
    return await this.store.acquireOutboundRetryPermit(input)
  }

  /** Renews one exact synthetic installation permit. */
  async renewOutboundRetryPermit(
    input: RenewExternalChatOutboundRetryPermitInput,
  ): Promise<ExternalChatOutboundRetryPermit | undefined> {
    return await this.store.renewOutboundRetryPermit(input)
  }

  /** Validates one exact synthetic installation permit immediately before provider work. */
  async validateOutboundRetryPermit(
    input: ValidateExternalChatOutboundRetryPermitInput,
  ): Promise<boolean> {
    return await this.store.validateOutboundRetryPermit(input)
  }

  /** Releases one previously acquired synthetic permit. */
  async releaseOutboundRetryPermit(
    input: ReleaseExternalChatOutboundRetryPermitInput,
  ): Promise<boolean> {
    this.releases.push(input)
    return await this.store.releaseOutboundRetryPermit(input)
  }
}

/** Synthetic DLQ that records exhausted outbound retry entries. */
class SyntheticOutboundDeadLetterPort {
  /** Exhausted entries durably transferred by the worker. */
  readonly inputs: ExternalChatOutboundDeadLetterInput[] = []

  /** Retains one exhausted outbound mutation. */
  async enqueue(input: ExternalChatOutboundDeadLetterInput): Promise<void> {
    this.inputs.push(input)
  }
}

/** In-memory store that enforces the DynamoDB deferred-event fingerprint invariant. */
class StrictDeferredFingerprintStore extends InMemoryExternalChatStore {
  /** Whether the next outbound receipt completion should simulate a crash. */
  failNextOutboundCompletion = false

  /** Queue size observed immediately before the injected receipt completion failure. */
  outboundQueueSizeBeforeCompletionFailure?: number

  /** Optional one-shot interleaving invoked after an outbound retry row becomes durable. */
  afterNextOutboundDefer?: () => Promise<void>

  /** Optional one-shot interleaving invoked immediately before a binding write. */
  beforePutBinding?: () => Promise<void>

  /** Binding write classifications observed across owner-fenced retries. */
  readonly bindingResultKinds: string[] = []

  /** Parent lifecycle persistence calls in invocation order. */
  readonly parentLifecycleCalls: Array<'fence' | 'list'> = []

  /** Optional one-shot interleaving immediately before a parent link page is read. */
  beforeNextParentLinkList?: () => Promise<void>

  /** Optional one-shot interleaving immediately before a parent-fenced link update. */
  beforeNextParentFencedUpdate?: () => Promise<void>

  /** Optional one-shot interleaving immediately before a restrictive deferred-content purge. */
  beforeNextRestrictivePurge?: () => Promise<void>

  /** Optional one-shot interleaving after a completed thread lifecycle is read for acknowledgement. */
  afterNextThreadLifecycleRead?: () => Promise<void>

  /** Number of outbound restrictive purge boundaries reached by the service. */
  outboundRestrictivePurgeCallCount = 0

  /** Rejects a deferred row whose fingerprint includes receipt-only authentication material. */
  override async deferEvent(event: DeferredExternalChatEvent): Promise<void> {
    if (event.fingerprint !== createExternalChatFingerprint(event.event)) {
      throw new ExternalChatError(
        'ExternalChatEventConflict',
        'Deferred event fingerprints must contain only the normalized provider event.',
      )
    }
    await super.deferEvent(event)
  }

  /** Runs one permit-loss interleaving after a deferred outbound row commits. */
  override async deferOutboundEvent(
    event: Parameters<InMemoryExternalChatStore['deferOutboundEvent']>[0],
  ): Promise<void> {
    await super.deferOutboundEvent(event)
    const hook = this.afterNextOutboundDefer
    this.afterNextOutboundDefer = undefined
    if (hook) await hook()
  }

  /** Records that a durable parent fence is published before child enumeration. */
  override async fenceParentLifecycle(
    input: Parameters<InMemoryExternalChatStore['fenceParentLifecycle']>[0],
  ): ReturnType<InMemoryExternalChatStore['fenceParentLifecycle']> {
    this.parentLifecycleCalls.push('fence')
    return await super.fenceParentLifecycle(input)
  }

  /** Records each strongly scoped parent-link enumeration. */
  override async listParentLinks(
    input: Parameters<InMemoryExternalChatStore['listParentLinks']>[0],
  ): ReturnType<InMemoryExternalChatStore['listParentLinks']> {
    this.parentLifecycleCalls.push('list')
    const hook = this.beforeNextParentLinkList
    this.beforeNextParentLinkList = undefined
    if (hook) await hook()
    return await super.listParentLinks(input)
  }

  /** Runs one newer-parent interleaving before delegating a parent-fenced projection. */
  override async updateLink(
    input: Parameters<InMemoryExternalChatStore['updateLink']>[0],
  ): ReturnType<InMemoryExternalChatStore['updateLink']> {
    const hook = input.expectedParentLifecycleFences === undefined
      ? undefined
      : this.beforeNextParentFencedUpdate
    if (hook) {
      this.beforeNextParentFencedUpdate = undefined
      await hook()
    }
    return await super.updateLink(input)
  }

  /** Runs one lifecycle recovery interleaving before delegating a destructive queue purge. */
  override async purgeDeferredEventsForLink(
    ...input: Parameters<InMemoryExternalChatStore['purgeDeferredEventsForLink']>
  ): ReturnType<InMemoryExternalChatStore['purgeDeferredEventsForLink']> {
    const hook = this.beforeNextRestrictivePurge
    this.beforeNextRestrictivePurge = undefined
    if (hook) await hook()
    return await super.purgeDeferredEventsForLink(...input)
  }

  /** Records whether cancellation stopped the second destructive purge boundary. */
  override async purgeDeferredOutboundEventsForLink(
    ...input: Parameters<InMemoryExternalChatStore['purgeDeferredOutboundEventsForLink']>
  ): ReturnType<InMemoryExternalChatStore['purgeDeferredOutboundEventsForLink']> {
    this.outboundRestrictivePurgeCallCount += 1
    return await super.purgeDeferredOutboundEventsForLink(...input)
  }

  /** Runs one permit-loss interleaving after reading a lifecycle and before acknowledgement. */
  override async getThreadLifecycle(
    ...input: Parameters<InMemoryExternalChatStore['getThreadLifecycle']>
  ): ReturnType<InMemoryExternalChatStore['getThreadLifecycle']> {
    const lifecycle = await super.getThreadLifecycle(...input)
    const hook = this.afterNextThreadLifecycleRead
    this.afterNextThreadLifecycleRead = undefined
    if (hook) await hook()
    return lifecycle
  }

  /** Fails once after verifying durable outbound work preceded receipt completion. */
  override async completeOutboundOperation(
    input: Parameters<InMemoryExternalChatStore['completeOutboundOperation']>[0],
  ): Promise<boolean> {
    if (this.failNextOutboundCompletion) {
      this.failNextOutboundCompletion = false
      this.outboundQueueSizeBeforeCompletionFailure = (
        await this.listDeferredOutboundEvents(input.workspaceId, input.linkId, 10)
      ).length
      throw new Error('Synthetic crash before outbound receipt completion.')
    }
    return await super.completeOutboundOperation(input)
  }

  /** Runs one merge interleaving before delegating the owner-fenced binding commit. */
  override async putMessageBinding(
    input: Parameters<InMemoryExternalChatStore['putMessageBinding']>[0],
  ): ReturnType<InMemoryExternalChatStore['putMessageBinding']> {
    const hook = this.beforePutBinding
    this.beforePutBinding = undefined
    if (hook) await hook()
    const result = await super.putMessageBinding(input)
    this.bindingResultKinds.push(result.kind)
    return result
  }
}

/** Dual internal/provider authorization fixture with independently revocable access. */
class SyntheticAccessPort implements ExternalChatSyncAccessPort {
  /** Whether the current viewer retains internal Work Item access. */
  viewAllowed = true

  /** Whether the current viewer retains provider source access. */
  providerViewAllowed = true

  /** Whether the current principal may export internal mutations. */
  outboundAllowed = true

  /** Current installation-scoped provider authorization. */
  readonly authorization: ChatProviderAuthorization

  /** Current canonical ownership scopes reauthorized for outbound mutations. */
  readonly outboundScopes: Array<{
    /** Canonical Workspace identifier. */
    workspaceId: string
    /** Current Team owner. */
    teamId: string
    /** Current Work Item owner. */
    workItemId: string
    /** Current external chat link. */
    linkId: string
  }> = []

  /**
   * Creates an authorization fixture.
   *
   * @param authorization - Installation authorization accepted by the provider.
   */
  constructor(authorization: ChatProviderAuthorization) {
    this.authorization = authorization
  }

  /** Checks current internal Work Item access. */
  async canViewWorkItem(
    principal: { workspaceId: string; principalId: string },
    scope: { workspaceId: string; teamId: string; workItemId: string; linkId: string },
  ): Promise<boolean> {
    return this.viewAllowed &&
      principal.workspaceId === scope.workspaceId &&
      principal.principalId.length > 0
  }

  /** Resolves viewer-scoped provider authorization only while access remains current. */
  async getViewerProviderAuthorization(
    principal: { workspaceId: string; principalId: string },
    link: ExternalChatWorkItemLink,
  ): Promise<ChatProviderAuthorization | undefined> {
    if (
      !this.providerViewAllowed ||
      principal.workspaceId !== workspaceId ||
      principal.principalId.length === 0 ||
      link.installationId !== this.authorization.installationId
    ) {
      return undefined
    }
    return this.authorization
  }

  /** Resolves current installation authorization for background synchronization. */
  async getInstallationProviderAuthorization(
    requestedWorkspaceId: string,
    link: ExternalChatWorkItemLink,
  ): Promise<ChatProviderAuthorization | undefined> {
    if (
      requestedWorkspaceId !== workspaceId ||
      link.installationId !== this.authorization.installationId
    ) {
      return undefined
    }
    return this.authorization
  }

  /** Revalidates the current principal before exporting an internal mutation. */
  async canSyncOutbound(
    principal: { workspaceId: string; principalId: string },
    scope: { workspaceId: string; teamId: string; workItemId: string; linkId: string },
  ): Promise<boolean> {
    this.outboundScopes.push(scope)
    return this.outboundAllowed &&
      principal.workspaceId === scope.workspaceId &&
      principal.principalId.length > 0
  }
}

/** Application cursor fixture that binds continuations to the complete viewer scope. */
class SyntheticCursorCodec implements ExternalChatSyncCursorCodecPort {
  /** Authenticates and unwraps one fixture cursor. */
  async decode(
    scope: ExternalChatSyncCursorScope,
    cursor: string,
  ): Promise<string> {
    const prefix = cursorScopePrefix(scope)
    if (!cursor.startsWith(prefix)) throw new Error('Cursor scope mismatch.')
    return cursor.slice(prefix.length)
  }

  /** Authenticates and wraps one private provider continuation. */
  async encode(
    scope: ExternalChatSyncCursorScope,
    providerCursor: string,
  ): Promise<string> {
    return `${cursorScopePrefix(scope)}${providerCursor}`
  }
}

/**
 * Encodes every authorization generation field used by the synthetic cursor fixture.
 *
 * @param scope - Exact source-view cursor authorization scope.
 * @returns Deterministic prefix used only by this non-production test codec.
 */
function cursorScopePrefix(scope: ExternalChatSyncCursorScope): string {
  return [
    scope.workspaceId,
    scope.principalId,
    scope.linkId,
    scope.provider,
    scope.linkRevision,
    scope.authorizationRevision,
    '',
  ].join(':')
}

/** Numeric external-version policy used by the synthetic provider. */
class SyntheticMessageOrderPort implements ExternalChatSyncMessageOrderPort {
  /** Applies exactly the next numeric provider version and defers gaps. */
  async decide(input: ExternalChatSyncMessageOrderInput): Promise<'apply' | 'stale' | 'defer'> {
    const incoming = parseVersion(input.incomingExternalVersion)
    if (input.previousExternalVersion === undefined) return incoming === 1 ? 'apply' : 'defer'
    const previous = parseVersion(input.previousExternalVersion)
    if (incoming <= previous) return 'stale'
    return incoming === previous + 1 ? 'apply' : 'defer'
  }
}

/** Numeric provider lifecycle-version policy with an open first observation. */
class SyntheticThreadOrderPort implements ExternalChatSyncThreadOrderPort {
  /** Applies the first observation and then requires the next numeric provider version. */
  async decideThreadLifecycle(
    input: ExternalChatSyncThreadOrderInput,
  ): Promise<'apply' | 'stale' | 'defer'> {
    if (input.previousExternalVersion === undefined) return 'apply'
    const incoming = parseVersion(input.incomingExternalVersion)
    const previous = parseVersion(input.previousExternalVersion)
    if (incoming <= previous) return 'stale'
    return incoming === previous + 1 ? 'apply' : 'defer'
  }
}

/** Idempotent in-memory collaboration boundary used by inbound synchronization. */
class SyntheticCollaborationPort implements ExternalChatSyncCollaborationPort {
  /** Current comments keyed by canonical internal comment ID. */
  readonly comments = new Map<string, SyntheticComment>()

  /** Create calls that reached the collaboration boundary. */
  readonly createInputs: ExternalChatSyncCreateCommentInput[] = []

  /** Edit calls that reached the collaboration boundary. */
  readonly updateInputs: ExternalChatSyncUpdateCommentInput[] = []

  /** Delete calls that reached the collaboration boundary. */
  readonly deleteInputs: ExternalChatSyncDeleteCommentInput[] = []

  /** Message and attachment lifecycle calls keyed by their stable operation. */
  readonly lifecycleInputs: ExternalChatSyncApplyResourceLifecycleInput[] = []

  /** Restrictive parent lifecycle cascades keyed by their stable operation. */
  readonly redactionInputs: ExternalChatSyncRedactLinkResourcesInput[] = []

  /** Number of resumable parent lifecycle cascade attempts. */
  redactionAttempts = 0

  /** Whether the next parent cascade should fail retryably before reaching a terminal checkpoint. */
  failNextRedactionWithRetryableError = false

  /** Optional one-based cascade attempt that should fail before its terminal checkpoint. */
  failRedactionAtAttempt?: number

  /** Results retained by synchronization operation ID. */
  private readonly results = new Map<string, ExternalChatSyncCommentMutationResult>()

  /** Monotonic synthetic internal comment sequence. */
  private nextCommentNumber = 1

  /** Idempotently imports one external message as an internal comment. */
  async createExternalComment(
    input: ExternalChatSyncCreateCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult> {
    const replayed = this.results.get(input.operationId)
    if (replayed) return replayed
    this.createInputs.push(input)
    const commentId = `comment-${this.nextCommentNumber}`
    this.nextCommentNumber += 1
    const importedFileIds = collectImportedFileIds(input.source.attachments)
    const comment: SyntheticComment = {
      id: commentId,
      linkId: input.linkId,
      teamId: input.teamId,
      workItemId: input.workItemId,
      bodyMarkdown: input.bodyMarkdown,
      version: 1,
      deleted: false,
      parentCommentId: input.parentCommentId,
      importedFileIds,
    }
    const result: ExternalChatSyncCommentMutationResult = {
      commentId,
      version: comment.version,
    }
    this.comments.set(commentId, comment)
    this.results.set(input.operationId, result)
    return result
  }

  /** Moves every imported comment with one link provenance to the canonical owner. */
  moveLinkProvenance(linkIdValue: string, teamId: string, workItemId: string): void {
    for (const [commentId, comment] of this.comments) {
      if (comment.linkId !== linkIdValue) continue
      this.comments.set(commentId, { ...comment, teamId, workItemId })
    }
  }

  /** Idempotently applies an external edit to a bound internal comment. */
  async updateExternalComment(
    input: ExternalChatSyncUpdateCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult> {
    const replayed = this.results.get(input.operationId)
    if (replayed) return replayed
    const current = this.requireComment(input.commentId, input.expectedVersion)
    this.updateInputs.push(input)
    const importedFileIds = collectImportedFileIds(input.source.attachments)
    const updated: SyntheticComment = {
      ...current,
      bodyMarkdown: input.bodyMarkdown,
      version: current.version + 1,
      importedFileIds: uniqueStrings([...current.importedFileIds, ...importedFileIds]),
    }
    const result: ExternalChatSyncCommentMutationResult = {
      commentId: updated.id,
      version: updated.version,
    }
    this.comments.set(updated.id, updated)
    this.results.set(input.operationId, result)
    return result
  }

  /** Idempotently tombstones a bound internal comment. */
  async deleteExternalComment(
    input: ExternalChatSyncDeleteCommentInput,
  ): Promise<ExternalChatSyncCommentMutationResult> {
    const replayed = this.results.get(input.operationId)
    if (replayed) return replayed
    const current = this.requireComment(input.commentId, input.expectedVersion)
    this.deleteInputs.push(input)
    const deleted: SyntheticComment = {
      ...current,
      version: current.version + 1,
      deleted: true,
    }
    const result: ExternalChatSyncCommentMutationResult = {
      commentId: deleted.id,
      version: deleted.version,
    }
    this.comments.set(deleted.id, deleted)
    this.results.set(input.operationId, result)
    return result
  }

  /** Idempotently records redaction and lifecycle changes for imported resources. */
  async applyExternalResourceLifecycle(
    input: ExternalChatSyncApplyResourceLifecycleInput,
  ): Promise<ExternalChatSyncApplyResourceLifecycleResult> {
    if (this.lifecycleInputs.some((current) => current.operationId === input.operationId)) {
      return { kind: 'stale' }
    }
    this.lifecycleInputs.push(input)
    return { kind: 'applied' }
  }

  /** Idempotently redacts every imported projection owned by a restrictive parent link. */
  async redactExternalLinkResources(
    input: ExternalChatSyncRedactLinkResourcesInput,
  ): Promise<void> {
    this.redactionAttempts += 1
    if (
      this.failNextRedactionWithRetryableError ||
      this.failRedactionAtAttempt === this.redactionAttempts
    ) {
      this.failNextRedactionWithRetryableError = false
      this.failRedactionAtAttempt = undefined
      throw new ExternalChatSyncPortError(
        'ExternalChatSyncSourceUnavailable',
        'The synthetic link resource cascade requires a resumable retry.',
        { retryable: true },
      )
    }
    if (this.redactionInputs.some((current) => current.operationId === input.operationId)) return
    this.redactionInputs.push(input)
    for (const [commentId, comment] of this.comments) {
      this.comments.set(commentId, {
        ...comment,
        bodyMarkdown: '',
        importedFileIds: [],
      })
    }
  }

  /** Reads a comment and enforces the expected version used by synchronization. */
  private requireComment(commentId: string, expectedVersion: number): SyntheticComment {
    const current = this.comments.get(commentId)
    if (!current || current.version !== expectedVersion) {
      throw new Error('Synthetic collaboration revision mismatch.')
    }
    return current
  }
}

/** Authorized private Files pipeline that ignores provider-supplied internal File IDs. */
class SyntheticAttachmentPort implements ExternalChatSyncAttachmentPort {
  /** Authorized attachment import requests keyed by stable operation ID. */
  readonly inputs: ExternalChatSyncImportAttachmentsInput[] = []

  /** Current link provenance owner for each imported internal File. */
  readonly owners = new Map<string, SyntheticFileOwner>()

  /** Idempotent import results keyed by stable operation ID. */
  private readonly results = new Map<string, ExternalChatSyncImportAttachmentsResult>()

  /** Imports provider attachment metadata into deterministic scanned internal Files. */
  async importAuthorizedAttachments(
    input: ExternalChatSyncImportAttachmentsInput,
  ): Promise<ExternalChatSyncImportAttachmentsResult> {
    const replayed = this.results.get(input.operationId)
    if (replayed) return replayed
    if (
      input.authorization.installationId !== installationId ||
      input.authorization.externalWorkspaceId !== 'slack-workspace-e2e'
    ) {
      throw new Error('Synthetic attachment authorization scope mismatch.')
    }
    this.inputs.push(input)
    const result: ExternalChatSyncImportAttachmentsResult = {
      importedFileIds: input.attachments.map((attachment) =>
        attachment.externalId.startsWith('attachment-')
          ? `file-${attachment.externalId.slice('attachment-'.length)}`
          : `file-${attachment.externalId}`
      ),
    }
    for (const fileId of result.importedFileIds) {
      this.owners.set(fileId, {
        linkId: input.linkId,
        teamId: input.teamId,
        workItemId: input.workItemId,
      })
    }
    this.results.set(input.operationId, result)
    return result
  }

  /** Moves every imported File with one link provenance to the canonical owner. */
  moveLinkProvenance(linkIdValue: string, teamId: string, workItemId: string): void {
    for (const [fileId, owner] of this.owners) {
      if (owner.linkId !== linkIdValue) continue
      this.owners.set(fileId, { ...owner, teamId, workItemId })
    }
  }
}

/** Work Item boundary that records inbound completion and reopen transitions. */
class SyntheticWorkItemPort implements ExternalChatSyncWorkItemPort {
  /** Completion mutations in the order applied. */
  readonly inputs: ExternalChatSyncSetWorkItemCompletionInput[] = []

  /** Explicit transition outcomes returned by upcoming calls. */
  readonly nextResults: ExternalChatSyncSetWorkItemCompletionResult[] = []

  /** Idempotent transition outcomes keyed by lifecycle operation. */
  private readonly results = new Map<string, ExternalChatSyncSetWorkItemCompletionResult>()

  /** Current synthetic Work Item revision. */
  private currentRevision = 1

  /** Idempotently records a Work Item completion transition. */
  async setCompletion(
    input: ExternalChatSyncSetWorkItemCompletionInput,
  ): Promise<ExternalChatSyncSetWorkItemCompletionResult> {
    const replayed = this.results.get(input.operationId)
    if (replayed) return replayed
    this.inputs.push(input)
    const queued = this.nextResults.shift()
    const result: ExternalChatSyncSetWorkItemCompletionResult = queued ?? {
      kind: 'applied',
      workItemRevision: this.currentRevision + 1,
    }
    this.currentRevision = Math.max(this.currentRevision, result.workItemRevision)
    this.results.set(input.operationId, result)
    return result
  }
}

/** Idempotent redacted audit boundary used by the synthetic runtime. */
class SyntheticAuditPort implements ExternalChatSyncAuditPort {
  /** Audit records keyed by stable synchronization operation ID. */
  readonly records = new Map<string, ExternalChatSyncAuditRecord>()

  /** Idempotently records one synchronization decision. */
  async record(record: ExternalChatSyncAuditRecord): Promise<void> {
    this.records.set(record.operationId, record)
  }
}

/** Operation-owned reconciliation boundary used by resynchronization integration scenarios. */
class SyntheticResyncReconciliationPort implements ExternalChatResyncReconciliationPort {
  /** Durable link and parent lifecycle state used to validate restrictive cleanup authority. */
  private readonly store: StrictDeferredFingerprintStore

  /** Exact accepted full-resync operation boundary. */
  private boundary?: ExternalChatFullResyncBoundary

  /** Provider message identities seen by the authoritative traversal. */
  readonly seenMessageIds: string[] = []

  /** Whether the authoritative full traversal reached reconciliation. */
  reconciled = false

  /** Restrictive cleanup requests that retained their exact lifecycle authority. */
  readonly redactions: ExternalChatResyncRedactionInput[] = []

  /**
   * Creates a synthetic durable reconciliation boundary.
   *
   * @param store - Durable link and parent lifecycle state.
   */
  constructor(store: StrictDeferredFingerprintStore) {
    this.store = store
  }

  /** Creates or idempotently replays one exact full-resync manifest. */
  async beginFullResync(input: ExternalChatFullResyncBoundary): Promise<boolean> {
    if (this.boundary) return sameSyntheticResyncBoundary(this.boundary, input)
    this.boundary = { ...input }
    return true
  }

  /** Records one provider message under the exact accepted operation boundary. */
  async recordFullResyncMessageSeen(
    input: ExternalChatFullResyncSeenMessageInput,
  ): Promise<boolean> {
    if (!this.boundary || !sameSyntheticResyncBoundary(this.boundary, input)) return false
    if (!this.seenMessageIds.includes(input.externalMessageId)) {
      this.seenMessageIds.push(input.externalMessageId)
    }
    return true
  }

  /** Marks unseen-binding reconciliation complete for the exact accepted operation. */
  async reconcileFullResync(input: ExternalChatFullResyncBoundary): Promise<boolean> {
    if (!this.boundary || !sameSyntheticResyncBoundary(this.boundary, input)) return false
    this.reconciled = true
    return true
  }

  /** Records restrictive cleanup only while its link and parent authority remain exact. */
  async redactRestrictiveResyncResources(
    input: ExternalChatResyncRedactionInput,
  ): Promise<boolean> {
    const current = await this.store.getLink(input.workspaceId, input.linkId)
    if (
      !current ||
      !current.active ||
      current.link.revision !== input.ownerLinkRevision ||
      current.link.teamId !== input.teamId ||
      current.link.workItemId !== input.workItemId ||
      current.sourceAuthorizationRevision > input.authorizationRevision
    ) return false
    const parentFences = await this.store.getParentLifecycleFences(
      input.workspaceId,
      input.linkId,
    )
    if (
      parentFences === undefined ||
      createExternalChatFingerprint(parentFences) !==
        createExternalChatFingerprint(input.expectedParentLifecycleFences)
    ) return false
    this.redactions.push(input)
    return true
  }
}

/**
 * Compares every immutable field of two synthetic resynchronization boundaries.
 *
 * @param left - Existing accepted operation boundary.
 * @param right - Candidate replay boundary.
 * @returns Whether both values identify the exact same operation generation.
 */
function sameSyntheticResyncBoundary(
  left: ExternalChatFullResyncBoundary,
  right: ExternalChatFullResyncBoundary,
): boolean {
  return left.workspaceId === right.workspaceId &&
    left.linkId === right.linkId &&
    left.operationId === right.operationId &&
    left.ownerLinkRevision === right.ownerLinkRevision &&
    left.authorizationRevision === right.authorizationRevision
}

/** Synthetic Slack implementation that retains every provider-side mutation. */
class SyntheticChatProviderAdapter implements ChatProviderAdapter {
  /** Immutable provider capability declaration. */
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

  /** Installation authorization accepted by this provider fixture. */
  readonly authorization: ChatProviderAuthorization

  /** Stable source locator served by this provider fixture. */
  readonly source: ExternalChatThreadSelection

  /** Permission-filtered thread projection served to authorized viewers. */
  readonly thread: ExternalChatThreadSnapshot

  /** Provider create calls after provider-side idempotency recovery. */
  readonly replyInputs: CreateChatProviderReplyInput[] = []

  /** Provider edit calls. */
  readonly editInputs: EditChatProviderMessageInput[] = []

  /** Provider delete calls. */
  readonly deleteInputs: DeleteChatProviderMessageInput[] = []

  /** Provider completion and reopen calls. */
  readonly completionInputs: SetChatProviderThreadCompletionInput[] = []

  /** Explicit provider lifecycle results returned by upcoming calls. */
  readonly nextCompletionResults: ChatProviderThreadMutationResult[] = []

  /** Explicit provider edit results returned by upcoming calls. */
  readonly nextEditResults: ExternalChatMessage[] = []

  /** Explicit provider deletion results returned by upcoming calls. */
  readonly nextDeleteResults: ExternalChatMessage[] = []

  /** Provider messages created by internal comment synchronization. */
  readonly replyMessages: ExternalChatMessage[] = []

  /** Number of source page reads that crossed the provider boundary. */
  readThreadPageCount = 0

  /** Optional provider page returned instead of the canonical fixture thread. */
  nextThreadPage?: ChatProviderThreadPage

  /** Optional one-shot callback executed after a provider page is read but before it returns. */
  afterNextThreadPageRead?: () => Promise<void>

  /** Optional one-shot interleaving immediately before a provider mutation authority guard. */
  beforeNextMutationAuthorityCheck?: () => Promise<void>

  /** Optional signature-verified normalized webhook returned by the next raw request. */
  nextNormalizedWebhook?: ChatProviderNormalizedWebhook

  /** Raw webhook requests that crossed the provider normalization boundary. */
  readonly webhookRequests: ChatProviderWebhookRequest[] = []

  /** Optional one-shot rate limit applied to the next reply. */
  rateLimitNextReplyAt?: string

  /** Whether the next background reply should report installation permission loss. */
  permissionDenyNextReply = false

  /** Whether the next viewer read should report viewer-scoped provider denial. */
  permissionDenyNextSourceView = false

  /** Whether the next committed edit should lose its response once. */
  loseNextEditResponse = false

  /** Whether the next committed deletion should lose its response once. */
  loseNextDeleteResponse = false

  /** Whether the next committed completion transition should lose its response once. */
  loseNextCompletionResponse = false

  /** Current provider messages keyed by immutable external message ID. */
  private readonly messages = new Map<string, ExternalChatMessage>()

  /** Provider sources authorized for this synthetic installation. */
  private readonly allowedSources = new Set<string>()

  /** Idempotent provider replies keyed by stable outbound operation ID. */
  private readonly repliesByOperation = new Map<string, ExternalChatMessage>()

  /** Idempotent provider edit results keyed by stable outbound operation ID. */
  private readonly editResultsByOperation = new Map<string, ExternalChatMessage>()

  /** Idempotent provider deletion results keyed by stable outbound operation ID. */
  private readonly deleteResultsByOperation = new Map<string, ExternalChatMessage>()

  /** Idempotent provider lifecycle results keyed by stable outbound operation ID. */
  private readonly completionResultsByOperation = new Map<
    string,
    ChatProviderThreadMutationResult
  >()

  /**
   * Creates a synthetic Slack provider for one source.
   *
   * @param source - Stable provider-neutral source locator.
   */
  constructor(source: ExternalChatThreadSelection) {
    this.source = source
    this.allowedSources.add(syntheticSourceKey(source))
    this.authorization = {
      installationId,
      externalWorkspaceId: source.externalWorkspaceId,
      authorizationRevision: 1,
    }
    const root = createMessage('root-message', '1', 'Root message')
    this.messages.set(root.externalId, root)
    this.thread = {
      schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
      workspace: {
        provider: 'slack',
        externalId: source.externalWorkspaceId,
        displayName: 'Synthetic workspace',
        permalink: 'https://chat.example.test/workspaces/e2e',
      },
      conversation: {
        externalId: source.conversationExternalId,
        externalWorkspaceId: source.externalWorkspaceId,
        kind: 'channel',
        displayName: 'Synthetic channel',
        permalink: 'https://chat.example.test/conversations/e2e',
      },
      externalId: source.threadExternalId,
      rootMessageExternalId: source.rootMessageExternalId,
      permalink: source.sourcePermalink,
      availability: 'available',
      state: 'active',
      messageCount: 1,
      messages: [root],
      hasMoreMessages: false,
      createdAt: root.postedAt,
      updatedAt: root.updatedAt,
    }
  }

  /** Adds one provider thread to the installation's synthetic authorization scope. */
  allowSource(source: ExternalChatThreadReference): void {
    this.allowedSources.add(syntheticSourceKey(source))
  }

  /** Records one raw webhook and returns its configured signature-verified projection. */
  async normalizeWebhook(
    request: ChatProviderWebhookRequest,
    authorization: ChatProviderAuthorization,
  ): Promise<ChatProviderNormalizedWebhook> {
    if (
      request.rawBody.byteLength === 0 ||
      authorization.installationId !== this.authorization.installationId ||
      authorization.externalWorkspaceId !== this.authorization.externalWorkspaceId
    ) throw new Error('Synthetic webhook scope mismatch.')
    this.webhookRequests.push(request)
    const normalized = this.nextNormalizedWebhook
    if (!normalized) throw new Error('Expected a configured synthetic normalized webhook.')
    this.nextNormalizedWebhook = undefined
    const originMarkers = readSyntheticRawOriginMarkers(request.rawBody, normalized.events)
    return {
      deliveryId: normalized.deliveryId,
      events: normalized.events,
      ...(originMarkers === undefined ? {} : { originMarkers }),
    }
  }

  /** Resolves the single permission-filtered synthetic thread. */
  async resolveThread(
    authorization: ChatProviderAuthorization,
    source: ExternalChatThreadReference,
  ): Promise<ExternalChatThreadSnapshot> {
    this.requireScope(authorization, source)
    return this.thread
  }

  /** Reads one bounded source page after current provider authorization. */
  async readThreadPage(input: ReadChatProviderThreadPageInput): Promise<ChatProviderThreadPage> {
    this.requireScope(input.authorization, input.source)
    this.readThreadPageCount += 1
    if (this.permissionDenyNextSourceView) {
      this.permissionDenyNextSourceView = false
      throw new ChatProviderAdapterError(
        'ChatProviderPermissionDenied',
        'The synthetic viewer no longer has source access.',
      )
    }
    const afterRead = this.afterNextThreadPageRead
    this.afterNextThreadPageRead = undefined
    if (afterRead) await afterRead()
    return this.nextThreadPage ?? { thread: this.thread }
  }

  /** Creates or idempotently recovers one provider reply. */
  async createReply(input: CreateChatProviderReplyInput): Promise<ExternalChatMessage> {
    this.requireActiveSignal(input.signal)
    this.requireScope(input.authorization, input.source)
    await this.assertMutationAuthority(input.assertCurrentAuthority)
    const replayed = this.repliesByOperation.get(input.operationId)
    if (replayed) return replayed
    if (this.rateLimitNextReplyAt) {
      const retryAt = this.rateLimitNextReplyAt
      this.rateLimitNextReplyAt = undefined
      throw new ChatProviderAdapterError(
        'ChatProviderRateLimited',
        'The synthetic provider rate limited this operation.',
        { retryable: true, retryAt },
      )
    }
    if (this.permissionDenyNextReply) {
      this.permissionDenyNextReply = false
      throw new ChatProviderAdapterError(
        'ChatProviderPermissionDenied',
        'The synthetic installation lost source permission.',
      )
    }
    const message: ExternalChatMessage = {
      ...createMessage(
      `outbound-${this.replyMessages.length + 1}`,
      '1',
      input.bodyMarkdown,
        input.source.rootMessageExternalId,
      ),
      conversationExternalId: input.source.conversationExternalId,
      threadExternalId: input.source.threadExternalId,
    }
    this.replyInputs.push(input)
    this.replyMessages.push(message)
    this.messages.set(message.externalId, message)
    this.repliesByOperation.set(input.operationId, message)
    return message
  }

  /** Applies one provider message edit. */
  async editMessage(input: EditChatProviderMessageInput): Promise<ExternalChatMessage> {
    this.requireActiveSignal(input.signal)
    this.requireScope(input.authorization, input.source)
    await this.assertMutationAuthority(input.assertCurrentAuthority)
    const replayed = this.editResultsByOperation.get(input.operationId)
    if (replayed) return replayed
    const queued = this.nextEditResults.shift()
    if (queued) {
      this.editInputs.push(input)
      this.editResultsByOperation.set(input.operationId, queued)
      return queued
    }
    const current = this.requireMessage(input.externalMessageId)
    const edited: ExternalChatMessage = {
      ...current,
      externalVersion: String(parseVersion(current.externalVersion) + 1),
      bodyMarkdown: input.bodyMarkdown,
      editedAt: initialNow,
      updatedAt: initialNow,
    }
    this.editInputs.push(input)
    this.messages.set(edited.externalId, edited)
    this.editResultsByOperation.set(input.operationId, edited)
    if (this.loseNextEditResponse) {
      this.loseNextEditResponse = false
      throw new ChatProviderAdapterError(
        'ChatProviderTransientFailure',
        'The synthetic provider lost one committed edit response.',
        { retryable: true },
      )
    }
    return edited
  }

  /** Applies one provider message tombstone. */
  async deleteMessage(input: DeleteChatProviderMessageInput): Promise<ExternalChatMessage> {
    this.requireActiveSignal(input.signal)
    this.requireScope(input.authorization, input.source)
    await this.assertMutationAuthority(input.assertCurrentAuthority)
    const replayed = this.deleteResultsByOperation.get(input.operationId)
    if (replayed) return replayed
    const queued = this.nextDeleteResults.shift()
    if (queued) {
      this.deleteInputs.push(input)
      this.deleteResultsByOperation.set(input.operationId, queued)
      return queued
    }
    const current = this.requireMessage(input.externalMessageId)
    const deleted: ExternalChatMessage = {
      ...current,
      externalVersion: String(parseVersion(current.externalVersion) + 1),
      permalink: undefined,
      actor: undefined,
      bodyMarkdown: undefined,
      quotedRanges: [],
      attachments: [],
      state: 'deleted',
      deletedAt: initialNow,
      updatedAt: initialNow,
    }
    this.deleteInputs.push(input)
    this.messages.set(deleted.externalId, deleted)
    this.deleteResultsByOperation.set(input.operationId, deleted)
    if (this.loseNextDeleteResponse) {
      this.loseNextDeleteResponse = false
      throw new ChatProviderAdapterError(
        'ChatProviderTransientFailure',
        'The synthetic provider lost one committed delete response.',
        { retryable: true },
      )
    }
    return deleted
  }

  /** Applies one provider thread completion or reopen transition. */
  async setThreadCompletion(
    input: SetChatProviderThreadCompletionInput,
  ): Promise<ChatProviderThreadMutationResult> {
    this.requireActiveSignal(input.signal)
    this.requireScope(input.authorization, input.source)
    await this.assertMutationAuthority(input.assertCurrentAuthority)
    const replayed = this.completionResultsByOperation.get(input.operationId)
    if (replayed) return replayed
    this.completionInputs.push(input)
    const result = this.nextCompletionResults.shift() ?? {
      externalVersion: String(this.completionInputs.length + 1),
      completed: input.completed,
      occurredAt: initialNow,
    }
    this.completionResultsByOperation.set(input.operationId, result)
    if (this.loseNextCompletionResponse) {
      this.loseNextCompletionResponse = false
      throw new ChatProviderAdapterError(
        'ChatProviderTransientFailure',
        'The synthetic provider lost one committed completion response.',
        { retryable: true },
      )
    }
    return result
  }

  /** Rejects an operation that escaped the fixture installation or source scope. */
  private requireScope(
    authorization: ChatProviderAuthorization,
    source: ExternalChatThreadReference,
  ): void {
    if (
      authorization.installationId !== this.authorization.installationId ||
      authorization.externalWorkspaceId !== this.source.externalWorkspaceId ||
      !this.allowedSources.has(syntheticSourceKey(source))
    ) {
      throw new Error('Synthetic provider scope mismatch.')
    }
  }

  /**
   * Rejects a provider mutation before commit after its retry owner loses authority.
   *
   * @param signal - Cancellation fence supplied by the synchronization service.
   */
  private requireActiveSignal(signal: AbortSignal): void {
    if (!signal.aborted) return
    throw new ChatProviderAdapterError(
      'ChatProviderTransientFailure',
      'The synthetic provider mutation was cancelled before commit.',
      { retryable: true },
    )
  }

  /**
   * Runs a configured race interleaving before the adapter's provider-I/O authority check.
   *
   * @param assertCurrentAuthority - Exact guard supplied by the synchronization service.
   */
  private async assertMutationAuthority(
    assertCurrentAuthority: () => Promise<void>,
  ): Promise<void> {
    const beforeCheck = this.beforeNextMutationAuthorityCheck
    this.beforeNextMutationAuthorityCheck = undefined
    if (beforeCheck) await beforeCheck()
    await assertCurrentAuthority()
  }

  /** Reads a provider message or raises a classified missing-source error. */
  private requireMessage(externalMessageId: string): ExternalChatMessage {
    const message = this.messages.get(externalMessageId)
    if (!message) {
      throw new ChatProviderAdapterError(
        'ChatProviderSourceNotFound',
        'The synthetic provider message does not exist.',
      )
    }
    return message
  }
}

describe('external chat synchronization end-to-end fixture', () => {
  test('imports a non-empty restricted source under the newer accepted resync generation', async () => {
    const fixture = await createSyntheticFixture()
    const current = await fixture.store.getLink(workspaceId, linkId)
    if (!current) throw new Error('Expected the seeded link before resynchronization.')
    const restricted = await fixture.store.updateLink({
      workspaceId,
      expectedRevision: current.link.revision,
      lifecycleState: {
        ...current.lifecycleState,
        workspace: {
          authorizationRevision: 1,
          availability: 'permission-lost',
          state: 'active',
          occurredAt: '2026-08-06T03:00:02.000Z',
          eventId: 'event-old-workspace-permission-loss',
        },
      },
      link: {
        ...current.link,
        sourceAvailability: 'permission-lost',
        syncStatus: 'paused',
        revision: current.link.revision + 1,
        updatedAt: '2026-08-06T03:00:02.000Z',
      },
    })
    if (restricted.kind !== 'updated') {
      throw new Error('Expected the old authorization restriction to be persisted.')
    }
    const fenced = await fixture.store.fenceParentLifecycle({
      workspaceId,
      provider: fixture.link.provider,
      installationId,
      externalWorkspaceId: fixture.link.source.externalWorkspaceId,
      authorizationRevision: 1,
      availability: 'permission-lost',
      state: 'active',
      restrictive: true,
      eventId: 'event-old-workspace-permission-loss-fence',
      operationId: 'operation-old-workspace-permission-loss-fence',
      occurredAt: '2026-08-06T03:00:02.000Z',
    })
    if (fenced.kind !== 'applied') {
      throw new Error('Expected the old authorization parent fence to be persisted.')
    }
    fixture.provider.authorization.authorizationRevision = 2
    const reconciliation = new SyntheticResyncReconciliationPort(fixture.store)
    const worker = new ExternalChatResyncWorker(
      {
        store: fixture.store,
        adapters: new ChatProviderAdapterRegistry([fixture.provider]),
        access: fixture.access,
        processor: fixture.service,
        reconciliation,
        clock: fixture.clock,
      },
      {
        pageSize: 10,
        maximumPagesPerRun: 5,
        maximumMessagesPerRun: 10,
      },
    )

    const result = await worker.process({
      workspaceId,
      linkId,
      mode: 'full',
      linkRevision: restricted.record.link.revision,
      authorizationRevision: 2,
      operationId: 'operation-nonempty-reauthorized-resync',
      correlationId: 'correlation-nonempty-reauthorized-resync',
      acceptedAt: fixture.clock.now(),
    })

    expect(result).toMatchObject({
      kind: 'completed',
      processedPageCount: 1,
      processedMessageCount: 1,
    })
    expect(reconciliation.seenMessageIds).toEqual(['root-message'])
    expect(reconciliation.reconciled).toBe(true)
    expect(reconciliation.redactions).toHaveLength(0)
    expect(fixture.collaboration.createInputs).toHaveLength(1)
    expect(await fixture.store.getLink(workspaceId, linkId)).toMatchObject({
      sourceAuthorizationRevision: 2,
      lifecycleState: {
        workspace: {
          authorizationRevision: 1,
          availability: 'permission-lost',
        },
        thread: {
          authorizationRevision: 2,
          availability: 'available',
          state: 'active',
        },
      },
      link: {
        sourceAvailability: 'available',
        sourceState: 'active',
        syncStatus: 'synced',
      },
    })
  })

  test('deduplicates inbound replies and drains an out-of-order edit before edit and delete', async () => {
    const fixture = await createSyntheticFixture()
    const attachment = Object.assign(createProviderAttachmentWithClaimedFileId(
      'attachment-main',
      'provider-forged-file-main',
    ), {
      temporaryDownloadUrl: 'https://files.example.test/private?token=secret',
      providerAccessToken: 'provider-file-secret',
    })
    const createdMessage = Object.assign(createMessage(
      'external-main',
      '1',
      'External reply',
      undefined,
      [attachment],
    ), { rawProviderPayload: 'provider-message-secret' })
    const createdEvent = createMessageCreatedEvent('event-main-created', createdMessage)

    const applied = await fixture.service.processInbound({ workspaceId, event: createdEvent })
    const replayed = await fixture.service.processInbound({ workspaceId, event: createdEvent })

    expect(applied.kind).toBe('applied')
    expect(replayed).toEqual(applied)
    expect(fixture.collaboration.createInputs).toHaveLength(1)
    expect(fixture.collaboration.comments.size).toBe(1)
    const internalCorrelationId = fixture.collaboration.createInputs[0]?.correlationId
    expect(internalCorrelationId).toStartWith('chat_corr_')
    expect(internalCorrelationId).not.toBe(createdEvent.correlationId)
    expect(fixture.attachments.inputs[0]?.correlationId).toBe(internalCorrelationId)
    expect([...fixture.audit.records.values()][0]?.correlationId).toBe(internalCorrelationId)

    const parentBinding = await fixture.store.getMessageBindingByExternalId(
      workspaceId,
      linkId,
      createdMessage.externalId,
    )
    expect(parentBinding?.binding.importedFileIds).toEqual(['file-main'])
    expect(fixture.attachments.inputs[0]?.authorization).toEqual(fixture.provider.authorization)
    expect(fixture.attachments.inputs[0]?.expectedParentLifecycleFences).toEqual({
      workspace: undefined,
      conversation: undefined,
    })
    expect(fixture.collaboration.createInputs[0]?.expectedParentLifecycleFences).toEqual({
      workspace: undefined,
      conversation: undefined,
    })
    expect(fixture.attachments.inputs[0]?.attachments[0]).not.toHaveProperty('importedFileId')
    expect(fixture.attachments.inputs[0]?.attachments[0]).not.toHaveProperty(
      'temporaryDownloadUrl',
    )
    expect(fixture.attachments.inputs[0]?.attachments[0]).not.toHaveProperty(
      'providerAccessToken',
    )
    expect(fixture.collaboration.createInputs[0]?.source).not.toHaveProperty(
      'rawProviderPayload',
    )
    expect(fixture.collaboration.createInputs[0]?.source.attachments[0]).not.toHaveProperty(
      'importedFileId',
    )
    expect(fixture.collaboration.createInputs[0]?.source.attachments[0]).not.toHaveProperty(
      'temporaryDownloadUrl',
    )

    const orderedCreate = createMessage(
      'external-ordered',
      '1',
      'Original ordered reply',
      createdMessage.externalId,
    )
    const orderedEdit = createMessage(
      'external-ordered',
      '2',
      'Edited before create arrived',
      createdMessage.externalId,
    )
    const editEvent = createMessageEditedEvent('event-ordered-edited', orderedEdit)
    const deferred = await fixture.service.processInbound({ workspaceId, event: editEvent })
    expect(deferred).toMatchObject({ kind: 'deferred', reason: 'out-of-order' })

    const createOutcome = await fixture.service.processInbound({
      workspaceId,
      event: createMessageCreatedEvent('event-ordered-created', orderedCreate),
    })
    expect(createOutcome.kind).toBe('applied')
    if (deferred.kind !== 'deferred' || !deferred.retryAt) {
      throw new Error('Expected a retry timestamp for the deferred edit.')
    }
    fixture.clock.set(deferred.retryAt)
    const editOutcome = await fixture.service.processInbound({ workspaceId, event: editEvent })
    expect(editOutcome.kind).toBe('applied')

    const orderedBinding = await fixture.store.getMessageBindingByExternalId(
      workspaceId,
      linkId,
      orderedCreate.externalId,
    )
    const orderedComment = orderedBinding
      ? fixture.collaboration.comments.get(orderedBinding.binding.internalCommentId)
      : undefined
    expect(orderedComment).toMatchObject({
      bodyMarkdown: 'Edited before create arrived',
      parentCommentId: parentBinding?.binding.internalCommentId,
      version: 2,
    })
    expect(
      await fixture.store.listDeferredEvents(workspaceId, linkId, 10),
    ).toHaveLength(0)

    const mainEdit = createMessage(
      createdMessage.externalId,
      '2',
      'External reply edited',
      fixture.link.source.rootMessageExternalId,
      [attachment],
    )
    expect((await fixture.service.processInbound({
      workspaceId,
      event: createMessageEditedEvent('event-main-edited', mainEdit),
    })).kind).toBe('applied')
    expect((await fixture.service.processInbound({
      workspaceId,
      event: createMessageDeletedEvent('event-main-deleted', createdMessage.externalId, '3'),
    })).kind).toBe('applied')

    const finalParent = parentBinding
      ? fixture.collaboration.comments.get(parentBinding.binding.internalCommentId)
      : undefined
    expect(finalParent).toMatchObject({
      bodyMarkdown: 'External reply edited',
      version: 3,
      deleted: true,
      importedFileIds: [],
    })
  })

  test('syncs outbound comments once, suppresses authenticated echoes, and mirrors lifecycle both ways', async () => {
    const fixture = await createSyntheticFixture()
    const outboundCreate = {
      type: 'comment.created',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-outbound-create',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      internalCommentId: 'internal-outbound',
      internalCommentVersion: 1,
      bodyMarkdown: 'Internal reply',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]

    const outbound = await fixture.service.processOutbound(outboundCreate)
    const replayed = await fixture.service.processOutbound(outboundCreate)
    expect(outbound.kind).toBe('applied')
    expect(replayed).toEqual(outbound)
    expect(fixture.provider.replyInputs).toHaveLength(1)

    const outboundBinding = await fixture.store.getMessageBindingByInternalId(
      workspaceId,
      linkId,
      outboundCreate.internalCommentId,
    )
    const echoedMessage = fixture.provider.replyMessages[0]
    const originMarker = fixture.provider.replyInputs[0]?.originMarker
    if (!outboundBinding || !echoedMessage || !originMarker) {
      throw new Error('Expected the outbound reply fixture to retain its binding and marker.')
    }
    const echo = Object.assign(createMessageCreatedEvent('event-outbound-echo', echoedMessage, {
      originOperationId: outbound.operationId,
    }), { rawProviderEchoToken: 'provider-echo-secret' })
    fixture.provider.nextNormalizedWebhook = Object.assign({
      deliveryId: 'delivery-outbound-echo',
      events: [echo],
    }, { rawProviderEnvelope: 'provider-envelope-secret' })
    const rawBody = new TextEncoder().encode(JSON.stringify({
      type: 'provider-echo',
      eventId: 'event-outbound-echo',
      originMarker,
    }))
    const echoDelivery = await fixture.webhookRuntime.process({
      scope: {
        workspaceId,
        provider: 'slack',
        authorization: fixture.provider.authorization,
      },
      request: {
        headers: { 'x-synthetic-signature': 'verified-by-provider-adapter' },
        rawBody,
        receivedAt: initialNow,
      },
    })
    const echoOutcome = echoDelivery.outcomes[0]
    expect(echoOutcome).toMatchObject({ kind: 'skipped', reason: 'self-origin' })
    expect(echoDelivery.deliveryId).toBe('delivery-outbound-echo')
    expect(fixture.provider.webhookRequests).toHaveLength(1)
    expect(fixture.provider.webhookRequests[0]?.rawBody).toEqual(rawBody)
    expect(fixture.collaboration.createInputs).toHaveLength(0)
    expect(fixture.provider.replyInputs).toHaveLength(1)

    for (const invalidEcho of [
      { eventId: 'event-outbound-echo-missing-marker' },
      { eventId: 'event-outbound-echo-tampered-marker', marker: `${originMarker}x` },
    ]) {
      const event = createMessageCreatedEvent(invalidEcho.eventId, echoedMessage, {
        originOperationId: outbound.operationId,
      })
      fixture.provider.nextNormalizedWebhook = {
        deliveryId: `delivery-${invalidEcho.eventId}`,
        events: [event],
      }
      const invalidRawBody = new TextEncoder().encode(JSON.stringify({
        type: 'provider-echo',
        eventId: invalidEcho.eventId,
        ...(invalidEcho.marker === undefined ? {} : { originMarker: invalidEcho.marker }),
      }))
      const delivery = await fixture.webhookRuntime.process({
        scope: {
          workspaceId,
          provider: 'slack',
          authorization: fixture.provider.authorization,
        },
        request: {
          headers: { 'x-synthetic-signature': 'verified-by-provider-adapter' },
          rawBody: invalidRawBody,
          receivedAt: initialNow,
        },
      })
      expect(delivery.outcomes[0]).toMatchObject({
        kind: 'failed',
        errorCode: 'ExternalChatInvalidOriginMarker',
      })
    }
    expect(fixture.collaboration.createInputs).toHaveLength(0)

    const unrelatedMessage = createMessage(
      'provider-unrelated-message',
      '1',
      'Unrelated provider message',
    )
    const replayedMarkerEvents: ExternalChatInboundEvent[] = [
      createMessageCreatedEvent('event-outbound-echo-cross-resource', unrelatedMessage, {
        originOperationId: outbound.operationId,
      }),
      {
        ...createMessageEditedEvent('event-outbound-echo-cross-action', echoedMessage),
        originOperationId: outbound.operationId,
      },
    ]
    for (const replayedMarkerEvent of replayedMarkerEvents) {
      fixture.provider.nextNormalizedWebhook = {
        deliveryId: `delivery-${replayedMarkerEvent.eventId}`,
        events: [replayedMarkerEvent],
      }
      const replayRawBody = new TextEncoder().encode(JSON.stringify({
        type: 'provider-echo',
        eventId: replayedMarkerEvent.eventId,
        originMarker,
      }))
      const delivery = await fixture.webhookRuntime.process({
        scope: {
          workspaceId,
          provider: 'slack',
          authorization: fixture.provider.authorization,
        },
        request: {
          headers: { 'x-synthetic-signature': 'verified-by-provider-adapter' },
          rawBody: replayRawBody,
          receivedAt: initialNow,
        },
      })
      expect(delivery.outcomes[0]).toMatchObject({
        kind: 'failed',
        errorCode: 'ExternalChatInvalidOriginMarker',
      })
    }
    expect(fixture.collaboration.createInputs).toHaveLength(0)

    expect((await fixture.service.processOutbound({
      ...outboundCreate,
      type: 'comment.edited',
      correlationId: 'correlation-outbound-edit',
      internalCommentVersion: 2,
      bodyMarkdown: 'Internal reply edited',
    })).kind).toBe('applied')
    expect((await fixture.service.processOutbound({
      ...outboundCreate,
      type: 'comment.deleted',
      correlationId: 'correlation-outbound-delete',
      internalCommentVersion: 3,
      deletedAt: fixture.clock.now(),
    })).kind).toBe('applied')
    expect(fixture.provider.editInputs).toHaveLength(1)
    expect(fixture.provider.deleteInputs).toHaveLength(1)

    expect((await fixture.service.processInbound({
      workspaceId,
      event: createThreadCompletionEvent('event-inbound-complete', true),
    })).kind).toBe('applied')
    expect((await fixture.service.processInbound({
      workspaceId,
      event: createThreadCompletionEvent('event-inbound-reopen', false),
    })).kind).toBe('applied')
    expect(fixture.workItems.inputs.map((input) => input.completed)).toEqual([true, false])

    const outboundLifecycleFixture = await createSyntheticFixture()
    expect((await outboundLifecycleFixture.service.processOutbound(
      createWorkItemCompletionEvent(true, 2),
    )).kind)
      .toBe('applied')
    expect((await outboundLifecycleFixture.service.processOutbound(
      createWorkItemCompletionEvent(false, 3),
    )).kind)
      .toBe('applied')
    expect(
      outboundLifecycleFixture.provider.completionInputs.map((input) => input.completed),
    ).toEqual([true, false])
  })

  test('rejects provider edit and delete responses with mismatched identity or state', async () => {
    const editFixture = await createSyntheticFixture()
    const createEditTarget = createOutboundCommentCreatedEvent(
      'internal-edit-identity-target',
      'correlation-edit-identity-create',
    )
    expect((await editFixture.service.processOutbound(createEditTarget)).kind).toBe('applied')
    editFixture.provider.nextEditResults.push(
      createMessage('provider-switched-edit-id', '2', 'Wrong edit response'),
    )
    expect(await editFixture.service.processOutbound({
      ...createEditTarget,
      type: 'comment.edited',
      correlationId: 'correlation-edit-identity-mutation',
      internalCommentVersion: 2,
      bodyMarkdown: 'Requested edit',
    })).toMatchObject({ kind: 'failed', errorCode: 'ChatProviderInvalidResponse' })
    expect(await editFixture.store.getMessageBindingByInternalId(
      workspaceId,
      linkId,
      createEditTarget.internalCommentId,
    )).toMatchObject({
      binding: { externalVersion: '1', internalCommentVersion: 1 },
    })

    const deleteFixture = await createSyntheticFixture()
    const createDeleteTarget = createOutboundCommentCreatedEvent(
      'internal-delete-identity-target',
      'correlation-delete-identity-create',
    )
    expect((await deleteFixture.service.processOutbound(createDeleteTarget)).kind).toBe('applied')
    deleteFixture.provider.nextDeleteResults.push({
      ...createMessage('provider-switched-delete-id', '2', 'Wrong delete response'),
      bodyMarkdown: undefined,
      state: 'deleted',
      deletedAt: initialNow,
    })
    expect(await deleteFixture.service.processOutbound({
      ...createDeleteTarget,
      type: 'comment.deleted',
      correlationId: 'correlation-delete-identity-mutation',
      internalCommentVersion: 2,
      deletedAt: initialNow,
    })).toMatchObject({ kind: 'failed', errorCode: 'ChatProviderInvalidResponse' })
    expect(await deleteFixture.store.getMessageBindingByInternalId(
      workspaceId,
      linkId,
      createDeleteTarget.internalCommentId,
    )).toMatchObject({
      binding: { externalVersion: '1', internalCommentVersion: 1 },
    })

    const activeDeleteFixture = await createSyntheticFixture()
    const createActiveDeleteTarget = createOutboundCommentCreatedEvent(
      'internal-delete-active-target',
      'correlation-delete-active-create',
    )
    expect((await activeDeleteFixture.service.processOutbound(createActiveDeleteTarget)).kind)
      .toBe('applied')
    const activeDeleteResponse = activeDeleteFixture.provider.replyMessages[0]
    if (!activeDeleteResponse) throw new Error('Expected the outbound delete target message.')
    activeDeleteFixture.provider.nextDeleteResults.push({
      ...activeDeleteResponse,
      externalVersion: '2',
    })
    expect(await activeDeleteFixture.service.processOutbound({
      ...createActiveDeleteTarget,
      type: 'comment.deleted',
      correlationId: 'correlation-delete-active-mutation',
      internalCommentVersion: 2,
      deletedAt: initialNow,
    })).toMatchObject({ kind: 'failed', errorCode: 'ChatProviderInvalidResponse' })
    const activeDeleteBinding = await activeDeleteFixture.store.getMessageBindingByInternalId(
      workspaceId,
      linkId,
      createActiveDeleteTarget.internalCommentId,
    )
    expect(activeDeleteBinding).toMatchObject({
      binding: { externalVersion: '1', internalCommentVersion: 1 },
    })
    expect(activeDeleteBinding?.binding.deletedAt).toBeUndefined()
  })

  test('does not let an older provider completion undo a newer reopen', async () => {
    const fixture = await createSyntheticFixture()

    expect((await fixture.service.processInbound({
      workspaceId,
      event: createThreadCompletionEvent('event-thread-complete-v2', true, '2'),
    })).kind).toBe('applied')
    expect((await fixture.service.processInbound({
      workspaceId,
      event: createThreadCompletionEvent('event-thread-reopen-v3', false, '3'),
    })).kind).toBe('applied')
    expect(await fixture.service.processInbound({
      workspaceId,
      event: createThreadCompletionEvent('event-thread-old-complete-v2', true, '2'),
    })).toMatchObject({ kind: 'skipped', reason: 'stale' })

    expect(fixture.workItems.inputs.map((input) => input.completed)).toEqual([true, false])
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack')).toMatchObject({
      state: {
        completed: false,
        lastExternalVersion: '3',
        lastInternalWorkItemRevision: 3,
      },
      lease: { status: 'acknowledged' },
    })
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceState: 'active',
      syncStatus: 'synced',
    })
  })

  test('defers behind a busy lifecycle lease without mutating the link and retries after expiry', async () => {
    const fixture = await createSyntheticFixture()
    const leaseExpiresAt = '2026-08-06T03:00:30.000Z'
    expect(await fixture.store.claimThreadLifecycle({
      workspaceId,
      linkId,
      provider: 'slack',
      expectedLinkRevision: 1,
      operationId: 'blocking-thread-lifecycle-operation',
      claimedAt: initialNow,
      leaseExpiresAt,
    })).toMatchObject({ kind: 'claimed' })
    const event = createThreadCompletionEvent('event-thread-busy-complete', true, '2')

    expect(await fixture.service.processInbound({ workspaceId, event })).toMatchObject({
      kind: 'deferred',
      reason: 'out-of-order',
      retryAt: leaseExpiresAt,
    })
    expect(fixture.workItems.inputs).toHaveLength(0)
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      revision: 1,
      sourceState: 'active',
      syncStatus: 'pending',
    })
    expect(
      await fixture.store.listDeferredEvents(workspaceId, linkId, 10),
    ).toHaveLength(1)

    fixture.clock.set(leaseExpiresAt)
    expect((await fixture.service.processInbound({ workspaceId, event })).kind).toBe('applied')
    expect(fixture.workItems.inputs).toHaveLength(1)
    expect(
      await fixture.store.listDeferredEvents(workspaceId, linkId, 10),
    ).toHaveLength(0)
  })

  test('retains an unsupported Work Item lifecycle observation without retrying the mutation', async () => {
    const fixture = await createSyntheticFixture()
    fixture.workItems.nextResults.push({
      kind: 'unsupported-transition',
      workItemRevision: 1,
    })
    const event = createThreadCompletionEvent('event-thread-unsupported', true, '2')

    const outcome = await fixture.service.processInbound({ workspaceId, event })
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'not-eligible' })
    expect(await fixture.service.processInbound({ workspaceId, event })).toEqual(outcome)
    expect(fixture.workItems.inputs).toHaveLength(1)
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack')).toMatchObject({
      state: {
        completed: true,
        lastExternalVersion: '2',
        lastInternalWorkItemRevision: 1,
      },
      lease: { status: 'acknowledged' },
    })
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceState: 'completed',
      syncStatus: 'paused',
    })
  })

  test('replays a completed lifecycle handoff after a crash without repeating the Work Item effect', async () => {
    const fixture = await createSyntheticFixture()
    const event = createThreadCompletionEvent('event-thread-crash-replay', true, '2')
    const operationId = createExternalChatInboundOperationId(workspaceId, event)
    const crashResumeAt = '2026-08-06T03:00:30.000Z'
    expect(await fixture.store.claimInboundEvent({
      workspaceId,
      installationId,
      provider: 'slack',
      eventId: event.eventId,
      fingerprint: createExternalChatFingerprint({ event, originMarker: undefined }),
      operationId,
      claimedAt: initialNow,
      leaseExpiresAt: crashResumeAt,
    })).toMatchObject({ kind: 'claimed' })
    const lifecycleClaim = await fixture.store.claimThreadLifecycle({
      workspaceId,
      linkId,
      provider: 'slack',
      expectedLinkRevision: 1,
      operationId,
      claimedAt: initialNow,
      leaseExpiresAt: crashResumeAt,
    })
    if (lifecycleClaim.kind !== 'claimed') {
      throw new Error('Expected the crash fixture lifecycle claim.')
    }
    const transition = await fixture.workItems.setCompletion({
      workspaceId,
      linkId,
      expectedLinkRevision: 1,
      expectedParentLifecycleFences: {
        workspace: undefined,
        conversation: undefined,
      },
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      completed: true,
      expectedWorkItemRevision: undefined,
      operationId,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
    })
    const outcome = {
      kind: 'applied',
      operationId,
      eventId: event.eventId,
      direction: 'inbound',
      occurredAt: initialNow,
    } satisfies Awaited<ReturnType<ExternalChatSyncService['processInbound']>>
    expect(await fixture.store.completeThreadLifecycle({
      workspaceId,
      linkId,
      provider: 'slack',
      expectedLinkRevision: 1,
      operationId,
      expectedAttempt: lifecycleClaim.record.lease.attempt,
      nextState: {
        completed: true,
        lastExternalVersion: '2',
        lastInternalWorkItemRevision: transition.workItemRevision,
        revision: 1,
        updatedAt: initialNow,
      },
      outcome,
      completedAt: initialNow,
    })).toBe(true)

    fixture.clock.set(crashResumeAt)
    expect(await fixture.service.processInbound({ workspaceId, event })).toEqual(outcome)
    expect(fixture.workItems.inputs).toHaveLength(1)
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceState: 'completed',
      syncStatus: 'synced',
    })
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack')).toMatchObject({
      state: { completed: true, lastExternalVersion: '2' },
      lease: { operationId, status: 'acknowledged' },
    })
  })

  test('reclaims an acknowledged order-gap operation after the missing provider version arrives', async () => {
    const fixture = await createSyntheticFixture()
    expect((await fixture.service.processInbound({
      workspaceId,
      event: createThreadCompletionEvent('event-thread-gap-base-v2', true, '2'),
    })).kind).toBe('applied')
    const gapEvent = createThreadCompletionEvent('event-thread-gap-v4', false, '4')
    const deferred = await fixture.service.processInbound({ workspaceId, event: gapEvent })
    expect(deferred).toMatchObject({
      kind: 'deferred',
      reason: 'out-of-order',
      retryAt: '2026-08-06T03:00:01.000Z',
    })
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack')).toMatchObject({
      state: { completed: true, lastExternalVersion: '2' },
      lease: { operationId: deferred.operationId, status: 'acknowledged' },
    })

    expect((await fixture.service.processInbound({
      workspaceId,
      event: createThreadCompletionEvent('event-thread-gap-v3', false, '3'),
    })).kind).toBe('applied')
    fixture.clock.set('2026-08-06T03:00:01.000Z')
    expect((await fixture.service.processInbound({ workspaceId, event: gapEvent })).kind)
      .toBe('applied')
    expect(fixture.workItems.inputs.map((input) => input.completed)).toEqual([true, false, false])
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack')).toMatchObject({
      state: {
        completed: false,
        lastExternalVersion: '4',
        lastInternalWorkItemRevision: 4,
      },
      lease: { operationId: deferred.operationId, status: 'acknowledged' },
    })
  })

  test('does not send an older Work Item lifecycle revision after a newer one', async () => {
    const fixture = await createSyntheticFixture()
    fixture.provider.nextCompletionResults.push({
      completed: false,
      externalVersion: '3',
      occurredAt: initialNow,
    })

    expect((await fixture.service.processOutbound(
      createWorkItemCompletionEvent(false, 3),
    )).kind).toBe('applied')
    expect(await fixture.service.processOutbound(
      createWorkItemCompletionEvent(true, 2),
    )).toMatchObject({ kind: 'skipped', reason: 'stale' })

    expect(fixture.provider.completionInputs.map((input) => input.completed)).toEqual([false])
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack')).toMatchObject({
      state: {
        completed: false,
        lastExternalVersion: '3',
        lastInternalWorkItemRevision: 3,
      },
      lease: { status: 'acknowledged' },
    })
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceState: 'active',
      syncStatus: 'synced',
    })
  })

  test('fails closed while committing the actual provider lifecycle mutation result', async () => {
    const fixture = await createSyntheticFixture()
    fixture.provider.nextCompletionResults.push({
      completed: false,
      externalVersion: '2',
      occurredAt: initialNow,
    })
    const event = createWorkItemCompletionEvent(true, 2)

    const outcome = await fixture.service.processOutbound(event)
    expect(outcome).toMatchObject({
      kind: 'failed',
      errorCode: 'ExternalChatSyncInvalidMutation',
      retryable: false,
    })
    expect(await fixture.service.processOutbound(event)).toEqual(outcome)
    expect(fixture.provider.completionInputs.map((input) => input.completed)).toEqual([true])
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack')).toMatchObject({
      state: {
        completed: false,
        lastExternalVersion: '2',
        lastInternalWorkItemRevision: 2,
      },
      lease: { status: 'acknowledged' },
    })
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceState: 'active',
      syncStatus: 'conflict',
    })
  })

  test('reports rate limits honestly and fail-closes source content after permission loss', async () => {
    const fixture = await createSyntheticFixture()
    const sensitiveMessage = createMessage(
      'external-sensitive-before-permission-loss',
      '1',
      'Sensitive imported external content',
      undefined,
      [createProviderAttachmentWithClaimedFileId(
        'attachment-sensitive-before-permission-loss',
        'provider-forged-sensitive-file',
      )],
    )
    expect((await fixture.service.processInbound({
      workspaceId,
      event: createMessageCreatedEvent('event-sensitive-before-permission-loss', sensitiveMessage),
    })).kind).toBe('applied')
    const sensitiveBinding = await fixture.store.getMessageBindingByExternalId(
      workspaceId,
      linkId,
      sensitiveMessage.externalId,
    )
    if (!sensitiveBinding) throw new Error('Expected the sensitive imported message binding.')
    expect(sensitiveBinding.binding.importedFileIds)
      .toEqual(['file-sensitive-before-permission-loss'])
    expect(fixture.collaboration.comments.get(sensitiveBinding.binding.internalCommentId))
      .toMatchObject({
        bodyMarkdown: 'Sensitive imported external content',
      })

    fixture.provider.rateLimitNextReplyAt = providerRetryAt
    const rateLimitedEvent = {
      type: 'comment.created',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-rate-limit',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      internalCommentId: 'internal-rate-limited',
      internalCommentVersion: 1,
      bodyMarkdown: 'Please retry this reply',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
    const limited = await fixture.service.processOutbound(rateLimitedEvent)
    expect(limited).toMatchObject({
      kind: 'deferred',
      reason: 'rate-limited',
    })
    if (limited.kind !== 'deferred' || !limited.retryAt) {
      throw new Error('Expected one normalized rate-limit retry schedule.')
    }
    expect(limited.retryAt > providerRetryAt).toBeTrue()
    expect(fixture.provider.replyInputs).toHaveLength(0)
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceAvailability: 'temporarily-unavailable',
      syncStatus: 'pending',
    })

    fixture.clock.set(limited.retryAt)
    expect((await fixture.service.processOutbound(rateLimitedEvent)).kind).toBe('applied')
    expect(fixture.provider.replyInputs).toHaveLength(1)
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceAvailability: 'available',
      sourceState: 'active',
      syncStatus: 'synced',
    })

    const permissionLoss = createSourceLifecycleEvent(
      'event-permission-lost',
      'permission-lost',
      'retained-metadata',
    )
    const permissionOutcome = await fixture.service.processInbound({
      workspaceId,
      event: permissionLoss,
    })
    expect(permissionOutcome.kind).toBe('applied')
    expect(await fixture.service.processInbound({ workspaceId, event: permissionLoss }))
      .toEqual(permissionOutcome)
    expect(fixture.collaboration.redactionInputs).toHaveLength(1)
    expect(fixture.collaboration.redactionInputs[0]).toMatchObject({
      workspaceId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      linkId,
      expectedLinkRevision: 5,
      availability: 'permission-lost',
      state: 'retained-metadata',
      operationId: permissionOutcome.operationId,
      correlationId: expectedInboundCorrelationId(permissionLoss.correlationId),
      occurredAt: permissionLoss.occurredAt,
    })
    expect(fixture.collaboration.comments.get(sensitiveBinding.binding.internalCommentId))
      .toMatchObject({ bodyMarkdown: '', importedFileIds: [] })
    const projectedLink = await fixture.store.getLink(workspaceId, linkId)
    expect(projectedLink?.link).toMatchObject({
      sourceAvailability: 'permission-lost',
      sourceState: 'retained-metadata',
      syncStatus: 'paused',
    })
    expect(projectedLink?.link.workspace).toEqual({
      provider: 'slack',
      externalId: 'slack-workspace-e2e',
    })
    expect(projectedLink?.link.conversation).toEqual({
      externalId: 'slack-channel-e2e',
      externalWorkspaceId: 'slack-workspace-e2e',
      kind: 'channel',
    })
    expect(projectedLink?.link.source).toEqual({
      externalWorkspaceId: 'slack-workspace-e2e',
      conversationExternalId: 'slack-channel-e2e',
      threadExternalId: 'slack-thread-e2e',
      rootMessageExternalId: 'root-message',
      sourceMessageExternalId: 'root-message',
    })

    fixture.access.providerViewAllowed = false
    await expect(fixture.service.getSourceView({
      principal: { workspaceId, principalId },
      linkId,
      limit: 10,
    })).rejects.toMatchObject({ code: 'ExternalChatAuthorizationFailed' })
    expect(fixture.provider.readThreadPageCount).toBe(0)
  })

  test('durably queues a rate-limited link FIFO and retries A before B exactly once', async () => {
    const fixture = await createSyntheticFixture()
    fixture.provider.rateLimitNextReplyAt = providerRetryAt
    const first = {
      type: 'comment.created',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-queued-first',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      internalCommentId: 'internal-queued-first',
      internalCommentVersion: 1,
      bodyMarkdown: 'Queued outbound A',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
    const firstOutcome = await fixture.service.processOutbound(first)
    expect(firstOutcome).toMatchObject({ kind: 'deferred', reason: 'rate-limited' })
    if (firstOutcome.kind !== 'deferred' || !firstOutcome.retryAt) {
      throw new Error('Expected the first outbound mutation to have a durable retry schedule.')
    }

    fixture.clock.set('2026-08-06T03:00:01.000Z')
    const second = {
      ...first,
      correlationId: 'correlation-queued-second',
      occurredAt: fixture.clock.now(),
      internalCommentId: 'internal-queued-second',
      bodyMarkdown: 'Queued outbound B',
    }
    const secondOutcome = await fixture.service.processOutbound(second)
    expect(secondOutcome).toMatchObject({
      kind: 'deferred',
      reason: 'source-unavailable',
      retryAt: firstOutcome.retryAt,
    })
    expect(fixture.provider.replyInputs).toHaveLength(0)
    expect((await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10))
      .map((entry) => entry.event.correlationId)).toEqual([
        first.correlationId,
        second.correlationId,
      ])

    fixture.clock.set(firstOutcome.retryAt)
    const concurrency = new SyntheticOutboundRetryConcurrencyPort()
    const deadLetter = new SyntheticOutboundDeadLetterPort()
    const worker = new ExternalChatOutboundDeferredRetryWorker({
      store: fixture.store,
      processor: fixture.service,
      concurrency,
      deadLetter,
      clock: fixture.clock,
    })
    await expect(worker.processDueBatch({
      workspaceId,
      linkId,
      dueAt: firstOutcome.retryAt,
      limit: 10,
    })).resolves.toMatchObject({
      attemptedEventCount: 2,
      removedEventCount: 2,
      deadLetteredEventCount: 0,
      stopReason: 'batch-complete',
    })
    expect(fixture.provider.replyInputs.map((input) => input.bodyMarkdown)).toEqual([
      first.bodyMarkdown,
      second.bodyMarkdown,
    ])
    expect(await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10)).toEqual([])
    expect(concurrency.acquisitions).toHaveLength(1)
    expect(concurrency.releases).toHaveLength(1)
    expect(deadLetter.inputs).toHaveLength(0)
  })

  test('recovers a crash after outbound enqueue but before receipt completion', async () => {
    const fixture = await createSyntheticFixture()
    fixture.provider.rateLimitNextReplyAt = providerRetryAt
    fixture.store.failNextOutboundCompletion = true
    const event = {
      type: 'comment.created',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-outbound-enqueue-crash',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      internalCommentId: 'internal-outbound-enqueue-crash',
      internalCommentVersion: 1,
      bodyMarkdown: 'Crash-safe queued outbound mutation',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]

    await expect(fixture.service.processOutbound(event)).rejects.toThrow(
      'Synthetic crash before outbound receipt completion.',
    )
    expect(fixture.store.outboundQueueSizeBeforeCompletionFailure).toBe(1)
    const queued = await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10)
    expect(queued).toHaveLength(1)
    const deferred = queued[0]
    if (!deferred) throw new Error('Expected one crash-recoverable outbound queue entry.')

    fixture.clock.set(deferred.retryAt)
    const worker = new ExternalChatOutboundDeferredRetryWorker({
      store: fixture.store,
      processor: fixture.service,
      concurrency: new SyntheticOutboundRetryConcurrencyPort(),
      deadLetter: new SyntheticOutboundDeadLetterPort(),
      clock: fixture.clock,
    })
    await expect(worker.processDueBatch({
      workspaceId,
      linkId,
      dueAt: deferred.retryAt,
      limit: 1,
    })).resolves.toMatchObject({
      attemptedEventCount: 1,
      removedEventCount: 1,
      stopReason: 'batch-complete',
    })
    expect(fixture.provider.replyInputs.map((input) => input.bodyMarkdown)).toEqual([
      event.bodyMarkdown,
    ])
    expect(await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10)).toEqual([])
  })

  test('stops outbound completion after its durable retry permit is lost', async () => {
    const fixture = await createSyntheticFixture()
    fixture.provider.rateLimitNextReplyAt = providerRetryAt
    const abortController = new AbortController()
    let permitCurrent = true
    fixture.store.afterNextOutboundDefer = async () => {
      permitCurrent = false
    }
    /** Revalidates the synthetic retry permit and propagates loss through the shared signal. */
    const assertCurrentPermit = async (): Promise<void> => {
      if (permitCurrent) return
      abortController.abort()
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'Synthetic outbound retry permit loss.',
        true,
      )
    }
    const event = {
      type: 'comment.created',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-outbound-completion-permit-loss',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      internalCommentId: 'internal-outbound-completion-permit-loss',
      internalCommentVersion: 1,
      bodyMarkdown: 'Permit-fenced queued outbound mutation',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]

    await expect(fixture.service.processOutbound(event, {
      signal: abortController.signal,
      assertCurrentPermit,
    })).rejects.toThrow('Synthetic outbound retry permit loss.')

    const queued = await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10)
    expect(queued).toHaveLength(1)
    const deferred = queued[0]
    if (!deferred) throw new Error('Expected the permit-fenced outbound queue entry.')
    expect(await fixture.store.claimOutboundOperation({
      workspaceId,
      linkId,
      operationId: deferred.operationId,
      fingerprint: deferred.fingerprint,
      claimedAt: fixture.clock.now(),
      leaseExpiresAt: '2026-08-06T03:01:00.000Z',
    })).toMatchObject({ kind: 'busy' })
    expect(fixture.audit.records.size).toBe(0)
  })

  test('stops a restrictive outbound cascade after permit loss during its first purge', async () => {
    const fixture = await createSyntheticFixture()
    await fixture.store.fenceParentLifecycle({
      workspaceId,
      provider: fixture.link.provider,
      installationId: fixture.link.installationId,
      externalWorkspaceId: fixture.link.source.externalWorkspaceId,
      authorizationRevision: 1,
      availability: 'permission-lost',
      state: 'retained-metadata',
      restrictive: true,
      eventId: 'event-outbound-purge-permit-loss',
      operationId: 'operation-outbound-purge-permit-loss',
      occurredAt: '2026-08-06T03:00:01.000Z',
    })
    const abortController = new AbortController()
    let permitCurrent = true
    fixture.store.beforeNextRestrictivePurge = async () => {
      permitCurrent = false
      abortController.abort()
    }
    /** Revalidates the synthetic permit at every destructive cascade boundary. */
    const assertCurrentPermit = async (): Promise<void> => {
      if (permitCurrent) return
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'Synthetic restrictive purge permit loss.',
        true,
      )
    }

    await expect(fixture.service.processOutbound(
      createOutboundCommentCreatedEvent(
        'internal-comment-purge-permit-loss',
        'correlation-purge-permit-loss',
      ),
      { signal: abortController.signal, assertCurrentPermit },
    )).rejects.toThrow('outbound retry authority expired')
    expect(fixture.store.outboundRestrictivePurgeCallCount).toBe(0)
    expect(fixture.collaboration.redactionAttempts).toBe(0)
    expect(fixture.provider.replyInputs).toHaveLength(0)
  })

  test('does not acknowledge a completed lifecycle after permit loss during its read', async () => {
    const fixture = await createSyntheticFixture()
    const abortController = new AbortController()
    let permitCurrent = true
    fixture.store.afterNextThreadLifecycleRead = async () => {
      permitCurrent = false
      abortController.abort()
    }
    /** Revalidates the synthetic permit before lifecycle acknowledgement persistence. */
    const assertCurrentPermit = async (): Promise<void> => {
      if (permitCurrent) return
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'Synthetic lifecycle acknowledgement permit loss.',
        true,
      )
    }

    await expect(fixture.service.processOutbound(
      createWorkItemCompletionEvent(true, 1),
      { signal: abortController.signal, assertCurrentPermit },
    )).rejects.toThrow('outbound retry authority expired')
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack'))
      .toMatchObject({ lease: { status: 'completed' } })
    expect(fixture.provider.completionInputs).toHaveLength(1)
    expect(fixture.audit.records.size).toBe(0)
  })

  test('recovers exact edit delete and completion results after provider response loss', async () => {
    const fixture = await createSyntheticFixture()
    const created = {
      type: 'comment.created',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-response-loss-create',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      internalCommentId: 'internal-response-loss',
      internalCommentVersion: 1,
      bodyMarkdown: 'Initial response-loss message',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
    expect((await fixture.service.processOutbound(created)).kind).toBe('applied')

    const worker = new ExternalChatOutboundDeferredRetryWorker({
      store: fixture.store,
      processor: fixture.service,
      concurrency: new SyntheticOutboundRetryConcurrencyPort(),
      deadLetter: new SyntheticOutboundDeadLetterPort(),
      clock: fixture.clock,
    })
    fixture.provider.loseNextEditResponse = true
    const edited = {
      ...created,
      type: 'comment.edited',
      correlationId: 'correlation-response-loss-edit',
      internalCommentVersion: 2,
      bodyMarkdown: 'Edited exactly once after response loss',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
    expect(await fixture.service.processOutbound(edited)).toMatchObject({ kind: 'deferred' })
    let queue = await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10)
    const editRetry = queue[0]?.retryAt
    if (!editRetry) throw new Error('Expected a deferred edit response-loss retry.')
    fixture.clock.set(editRetry)
    expect((await worker.processDueBatch({
      workspaceId,
      linkId,
      dueAt: editRetry,
      limit: 1,
    })).stopReason).toBe('batch-complete')
    expect(fixture.provider.editInputs).toHaveLength(1)

    fixture.provider.loseNextDeleteResponse = true
    const deleted = {
      ...created,
      type: 'comment.deleted',
      correlationId: 'correlation-response-loss-delete',
      occurredAt: fixture.clock.now(),
      internalCommentVersion: 3,
      deletedAt: fixture.clock.now(),
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
    expect(await fixture.service.processOutbound(deleted)).toMatchObject({ kind: 'deferred' })
    queue = await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10)
    const deleteRetry = queue[0]?.retryAt
    if (!deleteRetry) throw new Error('Expected a deferred delete response-loss retry.')
    fixture.clock.set(deleteRetry)
    expect((await worker.processDueBatch({
      workspaceId,
      linkId,
      dueAt: deleteRetry,
      limit: 1,
    })).stopReason).toBe('batch-complete')
    expect(fixture.provider.deleteInputs).toHaveLength(1)

    fixture.provider.loseNextCompletionResponse = true
    const completed = {
      type: 'work-item.completed',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-response-loss-completion',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      workItemRevision: 2,
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
    expect(await fixture.service.processOutbound(completed)).toMatchObject({ kind: 'deferred' })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      queue = await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10)
      const completionRetry = queue[0]?.retryAt
      if (!completionRetry) break
      fixture.clock.set(completionRetry)
      await worker.processDueBatch({
        workspaceId,
        linkId,
        dueAt: completionRetry,
        limit: 1,
      })
    }
    expect(await fixture.store.listDeferredOutboundEvents(workspaceId, linkId, 10)).toEqual([])
    expect(fixture.provider.completionInputs).toHaveLength(1)
    expect(await fixture.store.getThreadLifecycle(workspaceId, linkId, 'slack'))
      .toMatchObject({ state: { completed: true } })
  })

  test('cascades background permission loss without projecting viewer-scoped denial', async () => {
    const fixture = await createSyntheticFixture()
    fixture.provider.permissionDenyNextSourceView = true
    await expect(fixture.service.getSourceView({
      principal: { workspaceId, principalId },
      linkId,
      limit: 10,
    })).rejects.toMatchObject({ code: 'ChatProviderPermissionDenied' })
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceAvailability: 'available',
      sourceState: 'active',
      syncStatus: 'pending',
    })
    expect(fixture.collaboration.redactionInputs).toHaveLength(0)

    const deferredEvent = createMessageEditedEvent(
      'event-deferred-before-background-permission-loss',
      createMessage(
        'external-deferred-before-background-permission-loss',
        '2',
        'Sensitive deferred content',
      ),
    )
    expect(await fixture.service.processInbound({ workspaceId, event: deferredEvent }))
      .toMatchObject({ kind: 'deferred', reason: 'out-of-order' })
    expect(await fixture.store.listDeferredEvents(
      workspaceId,
      linkId,
      10,
    )).toHaveLength(1)

    fixture.provider.permissionDenyNextReply = true
    const outboundEvent = {
      type: 'comment.created',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-background-permission-loss',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      internalCommentId: 'internal-background-permission-loss',
      internalCommentVersion: 1,
      bodyMarkdown: 'This must not escape after permission loss',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
    const outcome = await fixture.service.processOutbound(outboundEvent)
    expect(outcome).toMatchObject({
      kind: 'failed',
      errorCode: 'ChatProviderPermissionDenied',
      retryable: false,
    })
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceAvailability: 'permission-lost',
      sourceState: 'active',
      syncStatus: 'paused',
    })
    expect(fixture.collaboration.redactionInputs).toEqual([{
      workspaceId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      linkId,
      expectedLinkRevision: 2,
      expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
      availability: 'permission-lost',
      state: 'active',
      operationId: outcome.operationId,
      correlationId: outboundEvent.correlationId,
      occurredAt: outboundEvent.occurredAt,
    }])
    expect(await fixture.store.listDeferredEvents(
      workspaceId,
      linkId,
      10,
    )).toHaveLength(0)
  })

  test('returns an exact public source view without provider runtime fields or File claims', async () => {
    const fixture = await createSyntheticFixture()
    const root = fixture.provider.thread.messages[0]
    if (!root) throw new Error('Expected the fixture provider root message.')
    if (!root.actor) throw new Error('Expected the fixture provider root actor.')
    const attachment = Object.assign(createProviderAttachmentWithClaimedFileId(
      'attachment-source-view',
      'provider-forged-source-view-file',
    ), {
      temporaryDownloadUrl: 'https://files.example.test/private?token=secret',
    })
    const actor = Object.assign(
      { ...root.actor },
      { providerProfileEmail: 'private@example.test' },
    )
    const message = Object.assign({
      ...root,
      actor,
      attachments: [attachment],
    }, { rawProviderMessage: 'provider-message-secret' })
    const thread = Object.assign({
      ...fixture.provider.thread,
      messages: [message],
    }, { rawProviderThread: 'provider-thread-secret' })
    fixture.provider.nextThreadPage = Object.assign(
      { thread },
      { providerRequestContext: 'provider-request-secret' },
    )

    const view = await fixture.service.getSourceView({
      principal: { workspaceId, principalId },
      linkId,
      limit: 1,
    })

    expect(view.messages[0]?.attachments[0]).toEqual({
      externalId: 'attachment-source-view',
      fileName: 'attachment-source-view.txt',
      contentType: 'text/plain',
      sizeBytes: 42,
      permalink: 'https://chat.example.test/files/attachment-source-view',
      availability: 'available',
      state: 'active',
      createdAt: initialNow,
    })
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('provider-forged-source-view-file')
    expect(serialized).not.toContain('temporaryDownloadUrl')
    expect(serialized).not.toContain('private@example.test')
    expect(serialized).not.toContain('provider-message-secret')
    expect(serialized).not.toContain('provider-thread-secret')
    expect(serialized).not.toContain('provider-request-secret')
  })

  test('discards a provider page when internal access is revoked during the read', async () => {
    const fixture = await createSyntheticFixture()
    fixture.provider.afterNextThreadPageRead = async () => {
      fixture.access.viewAllowed = false
    }

    await expect(fixture.service.getSourceView({
      principal: { workspaceId, principalId },
      linkId,
      limit: 1,
    })).rejects.toMatchObject({ code: 'ExternalChatAuthorizationFailed' })

    expect(fixture.provider.readThreadPageCount).toBe(1)
    expect([...fixture.audit.records.values()][0]).toMatchObject({
      action: 'source.viewed',
      internalPrincipalId: principalId,
      outcome: {
        kind: 'failed',
        errorCode: 'ExternalChatAuthorizationFailed',
      },
    })
  })

  test('rejects source views before and during a restrictive parent fence', async () => {
    const alreadyFenced = await createSyntheticFixture()
    await alreadyFenced.store.fenceParentLifecycle({
      workspaceId,
      provider: alreadyFenced.link.provider,
      installationId: alreadyFenced.link.installationId,
      externalWorkspaceId: alreadyFenced.link.source.externalWorkspaceId,
      authorizationRevision: 1,
      availability: 'permission-lost',
      state: 'retained-metadata',
      restrictive: true,
      eventId: 'event-source-view-fenced-before-read',
      operationId: 'operation-source-view-fenced-before-read',
      occurredAt: '2026-08-06T03:00:01.000Z',
    })
    await expect(alreadyFenced.service.getSourceView({
      principal: { workspaceId, principalId },
      linkId,
      limit: 1,
    })).rejects.toMatchObject({ code: 'ExternalChatAuthorizationFailed' })
    expect(alreadyFenced.provider.readThreadPageCount).toBe(0)

    const fencedDuringRead = await createSyntheticFixture()
    fencedDuringRead.provider.afterNextThreadPageRead = async () => {
      await fencedDuringRead.store.fenceParentLifecycle({
        workspaceId,
        provider: fencedDuringRead.link.provider,
        installationId: fencedDuringRead.link.installationId,
        externalWorkspaceId: fencedDuringRead.link.source.externalWorkspaceId,
        authorizationRevision: 1,
        availability: 'scope-changed',
        state: 'active',
        restrictive: true,
        eventId: 'event-source-view-fenced-during-read',
        operationId: 'operation-source-view-fenced-during-read',
        occurredAt: '2026-08-06T03:00:02.000Z',
      })
    }
    await expect(fencedDuringRead.service.getSourceView({
      principal: { workspaceId, principalId },
      linkId,
      limit: 1,
    })).rejects.toMatchObject({ code: 'ExternalChatAuthorizationFailed' })
    expect(fencedDuringRead.provider.readThreadPageCount).toBe(1)
  })

  test('rejects unbounded, unsafe, redacted-content, duplicate, and cursor-leaking pages', async () => {
    const fixture = await createSyntheticFixture()
    const root = fixture.provider.thread.messages[0]
    if (!root) throw new Error('Expected the fixture provider root message.')
    const extra = createMessage('extra-source-page-message', '1', 'Extra message')
    const invalidPages: Array<{
      /** Invalid provider page under test. */
      page: ChatProviderThreadPage
      /** Public source-view limit sent to the provider. */
      limit: number
    }> = [
      {
        page: {
          thread: {
            ...fixture.provider.thread,
            messageCount: 2,
            messages: [root, extra],
          },
        },
        limit: 1,
      },
      {
        page: {
          thread: {
            ...fixture.provider.thread,
            messageCount: 2,
            messages: [root, root],
          },
        },
        limit: 2,
      },
      {
        page: {
          thread: {
            ...fixture.provider.thread,
            hasMoreMessages: true,
          },
        },
        limit: 1,
      },
      {
        page: {
          thread: {
            ...fixture.provider.thread,
            hasMoreMessages: true,
            nextMessageCursor: 'provider-public-cursor',
          },
          providerCursor: 'provider-private-cursor',
        },
        limit: 1,
      },
      {
        page: {
          thread: {
            ...fixture.provider.thread,
            messages: [{
              ...root,
              permalink: 'http://chat.example.test/messages/unsafe',
            }],
          },
        },
        limit: 1,
      },
      {
        page: {
          thread: {
            ...fixture.provider.thread,
            messages: [{
              ...root,
              bodyMarkdown: 'x'.repeat(262_145),
            }],
          },
        },
        limit: 1,
      },
      {
        page: {
          thread: {
            ...fixture.provider.thread,
            messages: [{
              ...root,
              availability: 'permission-lost',
              bodyMarkdown: 'restricted source content',
            }],
          },
        },
        limit: 1,
      },
    ]

    for (const invalid of invalidPages) {
      fixture.provider.nextThreadPage = invalid.page
      await expect(fixture.service.getSourceView({
        principal: { workspaceId, principalId },
        linkId,
        limit: invalid.limit,
      })).rejects.toMatchObject({ code: 'ChatProviderInvalidResponse' })
    }
    expect(fixture.provider.readThreadPageCount).toBe(invalidPages.length)
  })

  test('keeps parent metadata redacted while a resumable link-resource cascade retries', async () => {
    const fixture = await createSyntheticFixture()
    fixture.collaboration.failNextRedactionWithRetryableError = true
    const event = createSourceLifecycleEvent(
      'event-resumable-parent-redaction',
      'permission-lost',
      'retained-metadata',
    )

    const deferred = await fixture.service.processInbound({ workspaceId, event })
    expect(deferred).toMatchObject({
      kind: 'deferred',
      reason: 'source-unavailable',
    })
    if (deferred.kind !== 'deferred' || !deferred.retryAt) {
      throw new Error('Expected a normalized parent redaction retry schedule.')
    }
    const redactedDuringRetry = await fixture.store.getLink(workspaceId, linkId)
    expect(redactedDuringRetry?.link.workspace.displayName).toBeUndefined()
    expect(redactedDuringRetry?.link.conversation.permalink).toBeUndefined()
    expect(redactedDuringRetry?.link.source.sourcePermalink).toBeUndefined()
    expect(fixture.collaboration.redactionAttempts).toBe(1)
    expect(fixture.collaboration.redactionInputs).toHaveLength(0)

    fixture.clock.set(deferred.retryAt)
    expect((await fixture.service.processInbound({ workspaceId, event })).kind).toBe('applied')
    expect(fixture.collaboration.redactionAttempts).toBe(2)
    expect(fixture.collaboration.redactionInputs).toHaveLength(1)
    expect(
      await fixture.store.listDeferredEvents(workspaceId, linkId, 10),
    ).toHaveLength(0)
  })

  test('fans a workspace restriction across installation-owned links with exact child replay', async () => {
    const fixture = await createSyntheticFixture()
    const siblingA = await createSiblingLink(fixture, {
      linkId: 'fanout-link-a',
      installationId,
      conversationExternalId: 'fanout-conversation-a',
      threadExternalId: 'fanout-thread-a',
    })
    const siblingB = await createSiblingLink(fixture, {
      linkId: 'fanout-link-b',
      installationId,
      conversationExternalId: 'fanout-conversation-b',
      threadExternalId: 'fanout-thread-b',
    })
    const otherInstallation = await createSiblingLink(fixture, {
      linkId: 'fanout-link-other-installation',
      installationId: 'slack-installation-other-consent',
      conversationExternalId: 'fanout-conversation-other-installation',
      threadExternalId: 'fanout-thread-other-installation',
    })
    const affected = [fixture.link, siblingA, siblingB]
    for (const link of [...affected, otherInstallation]) {
      const pendingEvent = createMessageCreatedEvent(
        `event-pending-before-fanout-${link.id}`,
        createMessage(`pending-before-fanout-${link.id}`, '1', 'Sensitive deferred content'),
      )
      await fixture.store.deferEvent({
        workspaceId,
        linkId: link.id,
        event: pendingEvent,
        expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
        fingerprint: createExternalChatFingerprint(pendingEvent),
        reason: 'out-of-order',
        attempt: 1,
        retryAt: '2026-08-06T03:00:01.000Z',
        createdAt: initialNow,
        updatedAt: initialNow,
      })
    }
    fixture.collaboration.failRedactionAtAttempt = 2
    const event = createParentLifecycleEvent('event-workspace-fanout-restriction', 'workspace')

    const deferred = await fixture.service.processInbound({
      workspaceId,
      event,
      authorizationRevision: fixture.provider.authorization.authorizationRevision,
    })
    expect(deferred).toMatchObject({
      kind: 'deferred',
      reason: 'source-unavailable',
    })
    if (deferred.kind !== 'deferred' || !deferred.retryAt) {
      throw new Error('Expected a normalized parent fan-out retry schedule.')
    }
    expect(fixture.store.parentLifecycleCalls.slice(0, 2)).toEqual(['fence', 'list'])
    expect(fixture.collaboration.redactionAttempts).toBe(2)
    expect(fixture.collaboration.redactionInputs).toHaveLength(1)
    const initiallyRedacted = await Promise.all(affected.map(async (link) =>
      (await fixture.store.getLink(workspaceId, link.id))?.link.sourceAvailability
    ))
    expect(initiallyRedacted.filter((availability) => availability === 'permission-lost'))
      .toHaveLength(2)

    fixture.clock.set(deferred.retryAt)
    const applied = await fixture.service.processInbound({ workspaceId, event })
    expect(applied.kind).toBe('applied')
    expect(fixture.collaboration.redactionAttempts).toBe(4)
    expect(fixture.collaboration.redactionInputs).toHaveLength(3)
    expect(new Set(
      fixture.collaboration.redactionInputs.map((input) => input.operationId),
    ).size).toBe(3)
    for (const link of affected) {
      expect((await fixture.store.getLink(workspaceId, link.id))?.link).toMatchObject({
        sourceAvailability: 'permission-lost',
        sourceState: 'retained-metadata',
        syncStatus: 'paused',
      })
      expect(
        await fixture.store.listDeferredEvents(
          workspaceId,
          link.id,
          10,
        ),
      ).toHaveLength(0)
    }
    expect((await fixture.store.getLink(workspaceId, otherInstallation.id))?.link)
      .toMatchObject({ sourceAvailability: 'available', sourceState: 'active' })
    expect(
      await fixture.store.listDeferredEvents(
        workspaceId,
        otherInstallation.id,
        10,
      ),
    ).toHaveLength(1)

    expect(await fixture.service.processInbound({ workspaceId, event })).toEqual(applied)
    expect(fixture.collaboration.redactionAttempts).toBe(4)
  })

  test('excludes a reauthorized link committed after an older fence but before enumeration', async () => {
    const fixture = await createSyntheticFixture()
    const newerLinkId = 'fanout-link-newer-authorization'
    fixture.store.beforeNextParentLinkList = async () => {
      await createSiblingLink(fixture, {
        linkId: newerLinkId,
        installationId,
        conversationExternalId: 'fanout-conversation-newer-authorization',
        threadExternalId: 'fanout-thread-newer-authorization',
        authorizationRevision: 2,
      })
    }
    const event = createParentLifecycleEvent(
      'event-workspace-restriction-before-reauthorized-link',
      'workspace',
    )

    const outcome = await fixture.service.processInbound({
      workspaceId,
      event,
      authorizationRevision: 1,
    })

    expect(outcome.kind).toBe('applied')
    expect(fixture.store.parentLifecycleCalls.slice(0, 2)).toEqual(['fence', 'list'])
    expect((await fixture.store.getLink(workspaceId, fixture.link.id))?.link)
      .toMatchObject({ sourceAvailability: 'permission-lost', syncStatus: 'paused' })
    expect(await fixture.store.getLink(workspaceId, newerLinkId)).toMatchObject({
      sourceAuthorizationRevision: 2,
      link: {
        sourceAvailability: 'available',
        sourceState: 'active',
      },
    })
    expect(fixture.collaboration.redactionInputs.map((input) => input.linkId))
      .not.toContain(newerLinkId)

    const currentGenerationThreadEvent: Extract<
      ExternalChatInboundEvent,
      { type: 'source.lifecycle-changed' }
    > = {
      ...createParentEventScope(
        'event-current-thread-after-old-workspace-fence',
        '2026-08-06T03:00:01.000Z',
      ),
      type: 'source.lifecycle-changed',
      resourceType: 'thread',
      conversationExternalId: 'fanout-conversation-newer-authorization',
      threadExternalId: 'fanout-thread-newer-authorization',
      availability: 'available',
      state: 'active',
      reasonCode: 'provider_thread_available',
    }
    expect((await fixture.service.processInbound({
      workspaceId,
      event: currentGenerationThreadEvent,
      authorizationRevision: 2,
    })).kind).toBe('applied')
    expect((await fixture.store.getLink(workspaceId, newerLinkId))?.link).toMatchObject({
      sourceAvailability: 'available',
      sourceState: 'active',
      syncStatus: 'synced',
    })
  })

  test('skips a child projection when a newer parent fence wins after enumeration', async () => {
    const fixture = await createSyntheticFixture()
    fixture.store.beforeNextParentFencedUpdate = async () => {
      const newerFence = await fixture.store.fenceParentLifecycle({
        workspaceId,
        provider: fixture.link.provider,
        installationId: fixture.link.installationId,
        externalWorkspaceId: fixture.link.source.externalWorkspaceId,
        authorizationRevision: 2,
        availability: 'available',
        state: 'active',
        restrictive: false,
        eventId: 'event-newer-parent-availability',
        operationId: 'operation-newer-parent-availability',
        occurredAt: '2026-08-06T03:00:01.000Z',
      })
      if (newerFence.kind !== 'applied') {
        throw new Error('Expected the newer parent fence to supersede the fan-out.')
      }
    }
    const event = createParentLifecycleEvent(
      'event-older-parent-restriction-before-newer-fence',
      'workspace',
    )

    const outcome = await fixture.service.processInbound({
      workspaceId,
      event,
      authorizationRevision: 1,
    })

    expect(outcome.kind).toBe('applied')
    expect(fixture.store.parentLifecycleCalls.slice(0, 3)).toEqual([
      'fence',
      'list',
      'fence',
    ])
    expect(await fixture.store.getLink(workspaceId, fixture.link.id)).toMatchObject({
      sourceAuthorizationRevision: 1,
      link: {
        sourceAvailability: 'available',
        sourceState: 'active',
        revision: 1,
      },
    })
    expect(fixture.collaboration.redactionInputs).toHaveLength(0)
  })

  test('retries a parent projection when only its sibling authority changes', async () => {
    const fixture = await createSyntheticFixture()
    fixture.store.beforeNextParentFencedUpdate = async () => {
      const siblingFence = await fixture.store.fenceParentLifecycle({
        workspaceId,
        provider: fixture.link.provider,
        installationId: fixture.link.installationId,
        externalWorkspaceId: fixture.link.source.externalWorkspaceId,
        conversationExternalId: fixture.link.source.conversationExternalId,
        authorizationRevision: 1,
        availability: 'available',
        state: 'active',
        restrictive: false,
        eventId: 'event-conversation-sibling-authority',
        operationId: 'operation-conversation-sibling-authority',
        occurredAt: '2026-08-06T03:00:01.500Z',
      })
      if (siblingFence.kind !== 'applied') {
        throw new Error('Expected the conversation sibling fence to become authoritative.')
      }
    }

    const outcome = await fixture.service.processInbound({
      workspaceId,
      event: createParentLifecycleEvent(
        'event-workspace-restriction-with-sibling-race',
        'workspace',
      ),
      authorizationRevision: 1,
    })

    expect(outcome.kind).toBe('applied')
    expect(await fixture.store.getLink(workspaceId, fixture.link.id)).toMatchObject({
      link: {
        sourceAvailability: 'permission-lost',
        sourceState: 'retained-metadata',
      },
    })
    expect(fixture.collaboration.redactionInputs).toHaveLength(1)
    expect(fixture.collaboration.redactionInputs[0]?.expectedParentLifecycleFences)
      .toMatchObject({
        workspace: { eventId: 'event-workspace-restriction-with-sibling-race' },
        conversation: { eventId: 'event-conversation-sibling-authority' },
      })
  })

  test('stops a restrictive cascade when parent recovery wins before purge', async () => {
    const fixture = await createSyntheticFixture()
    const sensitiveEvent = createMessageCreatedEvent(
      'event-sensitive-before-parent-recovery',
      createMessage('message-sensitive-before-parent-recovery', '1', 'Sensitive body'),
    )
    await fixture.store.deferEvent({
      workspaceId,
      linkId,
      event: sensitiveEvent,
      expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
      fingerprint: createExternalChatFingerprint(sensitiveEvent),
      reason: 'out-of-order',
      attempt: 1,
      retryAt: '2026-08-06T03:00:03.000Z',
      createdAt: initialNow,
      updatedAt: initialNow,
    })
    fixture.store.beforeNextRestrictivePurge = async () => {
      const recovery = await fixture.store.fenceParentLifecycle({
        workspaceId,
        provider: fixture.link.provider,
        installationId: fixture.link.installationId,
        externalWorkspaceId: fixture.link.source.externalWorkspaceId,
        authorizationRevision: 1,
        availability: 'available',
        state: 'active',
        restrictive: false,
        eventId: 'event-workspace-recovery-before-purge',
        operationId: 'operation-workspace-recovery-before-purge',
        occurredAt: '2026-08-06T03:00:03.000Z',
      })
      if (recovery.kind !== 'applied') {
        throw new Error('Expected parent recovery to supersede restrictive cleanup.')
      }
    }

    const outcome = await fixture.service.processInbound({
      workspaceId,
      event: createParentLifecycleEvent(
        'event-workspace-restriction-before-purge',
        'workspace',
      ),
      authorizationRevision: 1,
    })

    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'out-of-order' })
    expect(fixture.collaboration.redactionInputs).toHaveLength(0)
    expect((await fixture.store.listDeferredEvents(workspaceId, linkId, 10))
      .map((deferred) => deferred.event.eventId)).toContain(sensitiveEvent.eventId)
  })

  test('limits a conversation restriction to matching installation-owned links', async () => {
    const fixture = await createSyntheticFixture()
    const sameConversation = await createSiblingLink(fixture, {
      linkId: 'conversation-fanout-matching',
      installationId,
      conversationExternalId: 'slack-channel-e2e',
      threadExternalId: 'conversation-fanout-matching-thread',
    })
    const otherConversation = await createSiblingLink(fixture, {
      linkId: 'conversation-fanout-other',
      installationId,
      conversationExternalId: 'conversation-fanout-other-channel',
      threadExternalId: 'conversation-fanout-other-thread',
    })

    expect((await fixture.service.processInbound({
      workspaceId,
      event: createParentLifecycleEvent(
        'event-conversation-fanout-restriction',
        'conversation',
      ),
      authorizationRevision: fixture.provider.authorization.authorizationRevision,
    })).kind).toBe('applied')
    expect((await fixture.store.getLink(workspaceId, fixture.link.id))?.link.sourceAvailability)
      .toBe('permission-lost')
    expect((await fixture.store.getLink(workspaceId, sameConversation.id))?.link.sourceAvailability)
      .toBe('permission-lost')
    expect((await fixture.store.getLink(workspaceId, otherConversation.id))?.link.sourceAvailability)
      .toBe('available')
    expect(fixture.collaboration.redactionInputs).toHaveLength(2)
  })

  test('does not let an older permissive conversation observation lift a workspace restriction', async () => {
    const fixture = await createSyntheticFixture()
    const restricted = createParentLifecycleEvent(
      'event-workspace-restrictive-t2',
      'workspace',
      'slack-channel-e2e',
      'permission-lost',
      'retained-metadata',
      '2026-08-06T03:00:02.000Z',
    )
    const permissive = createParentLifecycleEvent(
      'event-conversation-active-t1',
      'conversation',
      'slack-channel-e2e',
      'available',
      'active',
      '2026-08-06T03:00:01.000Z',
    )

    expect((await fixture.service.processInbound({
      workspaceId,
      event: restricted,
      authorizationRevision: 1,
    })).kind).toBe('applied')
    expect((await fixture.service.processInbound({
      workspaceId,
      event: permissive,
      authorizationRevision: 1,
    })).kind).toBe('applied')

    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceAvailability: 'permission-lost',
      sourceState: 'retained-metadata',
      syncStatus: 'paused',
    })
  })

  test('does not let a newer active thread observation lift a conversation restriction', async () => {
    const fixture = await createSyntheticFixture()
    const restricted = createParentLifecycleEvent(
      'event-conversation-restrictive-t1',
      'conversation',
      'slack-channel-e2e',
      'permission-lost',
      'retained-metadata',
      '2026-08-06T03:00:01.000Z',
    )
    const activeThread = createSourceLifecycleEvent(
      'event-thread-active-t2',
      'available',
      'active',
      '2026-08-06T03:00:02.000Z',
    )

    expect((await fixture.service.processInbound({
      workspaceId,
      event: restricted,
      authorizationRevision: 1,
    })).kind).toBe('applied')
    expect((await fixture.service.processInbound({
      workspaceId,
      event: activeThread,
      authorizationRevision: 1,
    })).kind).toBe('applied')

    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceAvailability: 'permission-lost',
      sourceState: 'retained-metadata',
      syncStatus: 'paused',
    })
  })

  test('rejects a stale active thread observation after a restrictive thread watermark', async () => {
    const fixture = await createSyntheticFixture()
    const restricted = createSourceLifecycleEvent(
      'event-thread-restrictive-t2',
      'permission-lost',
      'retained-metadata',
      '2026-08-06T03:00:02.000Z',
    )
    const staleActive = createSourceLifecycleEvent(
      'event-thread-active-t1',
      'available',
      'active',
      '2026-08-06T03:00:01.000Z',
    )

    expect((await fixture.service.processInbound({
      workspaceId,
      event: restricted,
      authorizationRevision: 1,
    })).kind).toBe('applied')
    expect(await fixture.service.processInbound({
      workspaceId,
      event: staleActive,
      authorizationRevision: 1,
    })).toMatchObject({ kind: 'skipped', reason: 'stale' })

    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      sourceAvailability: 'permission-lost',
      sourceState: 'retained-metadata',
      syncStatus: 'paused',
    })
  })

  test('keeps a link fail-closed between a workspace fence commit and delayed child fan-out', async () => {
    const fixture = await createSyntheticFixture()
    const fenced = await fixture.store.fenceParentLifecycle({
      workspaceId,
      provider: fixture.link.provider,
      installationId: fixture.link.installationId,
      externalWorkspaceId: fixture.link.source.externalWorkspaceId,
      authorizationRevision: 1,
      availability: 'permission-lost',
      state: 'retained-metadata',
      restrictive: true,
      eventId: 'event-workspace-fence-before-child',
      operationId: 'operation-workspace-fence-before-child',
      occurredAt: '2026-08-06T03:00:02.000Z',
    })
    expect(fenced.kind).toBe('applied')
    const olderConversationRecovery = createParentLifecycleEvent(
      'event-conversation-recovery-during-workspace-gap',
      'conversation',
      'slack-channel-e2e',
      'available',
      'active',
      '2026-08-06T03:00:01.000Z',
    )

    expect((await fixture.service.processInbound({
      workspaceId,
      event: olderConversationRecovery,
      authorizationRevision: 1,
    })).kind).toBe('applied')

    const record = await fixture.store.getLink(workspaceId, linkId)
    expect(record?.lifecycleState.workspace).toBeUndefined()
    expect(record?.link).toMatchObject({
      sourceAvailability: 'permission-lost',
      sourceState: 'retained-metadata',
      syncStatus: 'paused',
    })

    const blockedMessage = createMessageCreatedEvent(
      'event-message-during-workspace-fanout-gap',
      createMessage(
        'external-message-during-workspace-fanout-gap',
        '1',
        'This content must not cross a restrictive parent fence.',
      ),
    )
    expect(await fixture.service.processInbound({ workspaceId, event: blockedMessage }))
      .toMatchObject({ kind: 'skipped', reason: 'paused' })
    expect(fixture.collaboration.createInputs).toHaveLength(0)
    expect(fixture.collaboration.updateInputs).toHaveLength(0)
    expect(fixture.collaboration.deleteInputs).toHaveLength(0)
    expect(fixture.attachments.inputs).toHaveLength(0)

    const blockedOutbound = await fixture.service.processOutbound(
      createOutboundCommentCreatedEvent(
        'internal-comment-during-workspace-fanout-gap',
        'correlation-outbound-during-workspace-fanout-gap',
      ),
    )
    expect(blockedOutbound).toMatchObject({ kind: 'skipped', reason: 'paused' })
    expect(fixture.provider.replyInputs).toHaveLength(0)
  })

  test('rejects a provider mutation when a parent fence wins at adapter I/O time', async () => {
    const fixture = await createSyntheticFixture()
    fixture.provider.beforeNextMutationAuthorityCheck = async () => {
      await fixture.store.fenceParentLifecycle({
        workspaceId,
        provider: fixture.link.provider,
        installationId: fixture.link.installationId,
        externalWorkspaceId: fixture.link.source.externalWorkspaceId,
        authorizationRevision: 1,
        availability: 'scope-changed',
        state: 'active',
        restrictive: true,
        eventId: 'event-parent-fence-at-provider-io',
        operationId: 'operation-parent-fence-at-provider-io',
        occurredAt: '2026-08-06T03:00:03.000Z',
      })
    }

    const outcome = await fixture.service.processOutbound(
      createOutboundCommentCreatedEvent(
        'internal-comment-parent-fence-at-provider-io',
        'correlation-parent-fence-at-provider-io',
      ),
    )

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'paused' })
    expect(fixture.provider.replyInputs).toHaveLength(0)
  })

  test('applies message and attachment redaction lifecycle exactly once with bounded scope', async () => {
    const fixture = await createSyntheticFixture()
    const initial = await fixture.store.getLink(workspaceId, linkId)
    if (!initial) throw new Error('Expected the active lifecycle fixture link.')
    const directionChanged = await fixture.store.updateLink({
      workspaceId,
      expectedRevision: initial.link.revision,
      link: {
        ...initial.link,
        syncDirection: 'outbound',
        revision: initial.link.revision + 1,
        updatedAt: fixture.clock.now(),
      },
    })
    expect(directionChanged.kind).toBe('updated')
    const messageEvent = createResourceLifecycleEvent(
      'event-message-permission-lost',
      'message',
      'external-message-redacted',
      'permission-lost',
      'retained-metadata',
    )
    const attachmentEvent = createResourceLifecycleEvent(
      'event-attachment-retention-expired',
      'attachment',
      'external-attachment-redacted',
      'available',
      'retention-expired',
    )
    const threadEvent = createThreadRetentionExpiredEvent('event-thread-retention-expired')

    const messageOutcome = await fixture.service.processInbound({
      workspaceId,
      event: messageEvent,
    })
    const replayedMessageOutcome = await fixture.service.processInbound({
      workspaceId,
      event: messageEvent,
    })
    const attachmentOutcome = await fixture.service.processInbound({
      workspaceId,
      event: attachmentEvent,
    })
    const threadOutcome = await fixture.service.processInbound({ workspaceId, event: threadEvent })
    expect(threadOutcome.kind).toBe('applied')

    expect(replayedMessageOutcome).toEqual(messageOutcome)
    expect(fixture.collaboration.lifecycleInputs).toEqual([
      {
        workspaceId,
        teamId: duplicateTeamId,
        workItemId: duplicateWorkItemId,
        linkId,
        expectedLinkRevision: 2,
        expectedParentLifecycleFences: {
          workspace: undefined,
          conversation: undefined,
        },
        resourceType: 'message',
        resourceExternalId: 'external-message-redacted',
        availability: 'permission-lost',
        state: 'retained-metadata',
        operationId: messageOutcome.operationId,
        eventId: messageEvent.eventId,
        correlationId: expectedInboundCorrelationId(messageEvent.correlationId),
        occurredAt: messageEvent.occurredAt,
      },
      {
        workspaceId,
        teamId: duplicateTeamId,
        workItemId: duplicateWorkItemId,
        linkId,
        expectedLinkRevision: 2,
        expectedParentLifecycleFences: {
          workspace: undefined,
          conversation: undefined,
        },
        resourceType: 'attachment',
        resourceExternalId: 'external-attachment-redacted',
        availability: 'available',
        state: 'retention-expired',
        operationId: attachmentOutcome.operationId,
        eventId: attachmentEvent.eventId,
        correlationId: expectedInboundCorrelationId(attachmentEvent.correlationId),
        occurredAt: attachmentEvent.occurredAt,
      },
    ])
    expect(fixture.collaboration.redactionInputs).toEqual([{
      workspaceId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      linkId,
      expectedLinkRevision: 3,
      expectedParentLifecycleFences: { workspace: undefined, conversation: undefined },
      availability: 'available',
      state: 'retention-expired',
      operationId: threadOutcome.operationId,
      correlationId: expectedInboundCorrelationId(threadEvent.correlationId),
      occurredAt: threadEvent.occurredAt,
    }])
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      syncDirection: 'outbound',
      sourceAvailability: 'available',
      sourceState: 'retention-expired',
      syncStatus: 'paused',
      workspace: {
        provider: 'slack',
        externalId: 'slack-workspace-e2e',
      },
      conversation: {
        externalId: 'slack-channel-e2e',
        externalWorkspaceId: 'slack-workspace-e2e',
        kind: 'channel',
      },
      source: {
        externalWorkspaceId: 'slack-workspace-e2e',
        conversationExternalId: 'slack-channel-e2e',
        threadExternalId: 'slack-thread-e2e',
        rootMessageExternalId: 'root-message',
        sourceMessageExternalId: 'root-message',
      },
    })
  })

  test('rebases an owner-fenced inbound side effect across duplicate merge exactly once', async () => {
    const fixture = await createSyntheticFixture()
    const message = createMessage(
      'external-owner-fence-merge',
      '1',
      'Imported while duplicate merge wins',
      undefined,
      [createProviderAttachmentWithClaimedFileId(
        'attachment-owner-fence-merge',
        'provider-forged-owner-fence-file',
      )],
    )
    fixture.store.beforePutBinding = async () => {
      const current = await fixture.store.getLink(workspaceId, linkId)
      if (!current) throw new Error('Expected the duplicate-owned link before merge.')
      const duplicateManifest = await fixture.store.getWorkItemLinkManifest(
        workspaceId,
        duplicateTeamId,
        duplicateWorkItemId,
      )
      if (!duplicateManifest) throw new Error('Expected the duplicate owner manifest.')
      const merged = await fixture.store.mergeLinks({
        workspaceId,
        canonicalTeamId,
        canonicalWorkItemId,
        duplicateTeamId,
        duplicateWorkItemId,
        links: [{ linkId, expectedRevision: current.link.revision }],
        expectedDuplicateLinkGeneration: duplicateManifest.generation,
        expectedDuplicateLinkCount: duplicateManifest.activeLinkCount,
        mergedAt: fixture.clock.now(),
      })
      if (merged.kind !== 'merged') throw new Error('Expected the interleaved merge to win.')
      fixture.collaboration.moveLinkProvenance(
        linkId,
        canonicalTeamId,
        canonicalWorkItemId,
      )
      fixture.attachments.moveLinkProvenance(
        linkId,
        canonicalTeamId,
        canonicalWorkItemId,
      )
    }
    const event = createMessageCreatedEvent('event-owner-fence-merge', message)
    const deferred = await fixture.service.processInbound({ workspaceId, event })
    expect(deferred).toMatchObject({ kind: 'deferred', reason: 'out-of-order' })
    if (deferred.kind !== 'deferred' || !deferred.retryAt) {
      throw new Error('Expected an owner-conflict retry schedule.')
    }
    expect(fixture.store.bindingResultKinds).toEqual(['owner-conflict'])
    expect(fixture.collaboration.createInputs).toHaveLength(1)
    expect(fixture.attachments.inputs).toHaveLength(1)
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      teamId: canonicalTeamId,
      workItemId: canonicalWorkItemId,
      revision: 2,
    })
    expect(fixture.collaboration.comments.get('comment-1')).toMatchObject({
      linkId,
      teamId: canonicalTeamId,
      workItemId: canonicalWorkItemId,
    })
    expect(fixture.attachments.owners.get('file-owner-fence-merge')).toEqual({
      linkId,
      teamId: canonicalTeamId,
      workItemId: canonicalWorkItemId,
    })

    fixture.clock.set(deferred.retryAt)
    const worker = new ExternalChatDeferredRetryWorker({
      store: fixture.store,
      processor: fixture.service,
    })
    await expect(worker.processDueBatch({
      workspaceId,
      linkId,
      dueAt: deferred.retryAt,
      limit: 1,
    })).resolves.toMatchObject({
      attemptedEventCount: 1,
      removedEventCount: 1,
      stopReason: 'batch-complete',
    })
    expect(fixture.store.bindingResultKinds).toEqual(['owner-conflict', 'stored'])
    expect(fixture.collaboration.createInputs).toHaveLength(1)
    expect(fixture.attachments.inputs).toHaveLength(1)
    const binding = await fixture.store.getMessageBindingByExternalId(
      workspaceId,
      linkId,
      message.externalId,
    )
    expect(binding?.binding).toMatchObject({
      internalCommentId: 'comment-1',
      importedFileIds: ['file-owner-fence-merge'],
    })
    expect(await fixture.store.getMessageBindingByInternalId(
      workspaceId,
      linkId,
      'comment-1',
    )).toEqual(binding)

    const oldScopeOutbound = {
      type: 'comment.created',
      workspaceId,
      linkId,
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
      principalId,
      correlationId: 'correlation-old-scope-after-merge',
      occurredAt: fixture.clock.now(),
      externalSyncEligible: true,
      internalCommentId: 'internal-old-scope-after-merge',
      internalCommentVersion: 1,
      bodyMarkdown: 'Authorized again against canonical ownership',
    } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
    expect((await fixture.service.processOutbound(oldScopeOutbound)).kind).toBe('applied')
    expect(fixture.access.outboundScopes.at(-1)).toEqual({
      workspaceId,
      teamId: canonicalTeamId,
      workItemId: canonicalWorkItemId,
      linkId,
    })
    expect(fixture.provider.replyInputs.at(-1)?.bodyMarkdown).toBe(
      oldScopeOutbound.bodyMarkdown,
    )
  })

  test('moves link-owned bindings and imported files while preserving a canonical redirect', async () => {
    const fixture = await createSyntheticFixture()
    const message = createMessage(
      'external-to-merge',
      '1',
      'Reply with imported evidence',
      undefined,
      [createProviderAttachmentWithClaimedFileId(
        'attachment-to-merge',
        'provider-forged-file-to-merge',
      )],
    )
    expect((await fixture.service.processInbound({
      workspaceId,
      event: createMessageCreatedEvent('event-to-merge', message),
    })).kind).toBe('applied')
    const secondLink = await createSiblingLink(fixture, {
      linkId: 'external-chat-link-e2e-second',
      installationId,
      conversationExternalId: 'slack-channel-e2e-second',
      threadExternalId: 'slack-thread-e2e-second',
      teamId: duplicateTeamId,
      workItemId: duplicateWorkItemId,
    })
    const beforeMerge = await fixture.store.getLink(workspaceId, linkId)
    if (!beforeMerge) throw new Error('Expected the link before duplicate merge.')
    const duplicateManifest = await fixture.store.getWorkItemLinkManifest(
      workspaceId,
      duplicateTeamId,
      duplicateWorkItemId,
    )
    if (!duplicateManifest) throw new Error('Expected the duplicate owner manifest.')

    const merged = await fixture.store.mergeLinks({
      workspaceId,
      canonicalTeamId,
      canonicalWorkItemId,
      duplicateTeamId,
      duplicateWorkItemId,
      links: [
        { linkId, expectedRevision: beforeMerge.link.revision },
        { linkId: secondLink.id, expectedRevision: secondLink.revision },
      ],
      expectedDuplicateLinkGeneration: duplicateManifest.generation,
      expectedDuplicateLinkCount: duplicateManifest.activeLinkCount,
      mergedAt: fixture.clock.now(),
    })
    expect(merged).toMatchObject({
      kind: 'merged',
      movedFileIds: ['file-to-merge'],
      movedMessageBindingCount: 1,
    })
    if (merged.kind !== 'merged') throw new Error('Expected both links to merge.')
    expect(merged.movedLinks).toHaveLength(2)

    const retainedBinding = await fixture.store.getMessageBindingByExternalId(
      workspaceId,
      linkId,
      message.externalId,
    )
    expect(retainedBinding?.binding.importedFileIds).toEqual(['file-to-merge'])
    expect((await fixture.store.getLink(workspaceId, linkId))?.link).toMatchObject({
      teamId: canonicalTeamId,
      workItemId: canonicalWorkItemId,
    })
    expect(await fixture.store.getCanonicalRedirect(
      workspaceId,
      duplicateTeamId,
      duplicateWorkItemId,
    )).toMatchObject({
      linkId,
      fromTeamId: duplicateTeamId,
      fromWorkItemId: duplicateWorkItemId,
      canonicalTeamId,
      canonicalWorkItemId,
    })
    for (const movedLinkId of [linkId, secondLink.id]) {
      expect(await fixture.store.getCanonicalRedirect(
        workspaceId,
        duplicateTeamId,
        duplicateWorkItemId,
        movedLinkId,
      )).toMatchObject({
        linkId: movedLinkId,
        canonicalTeamId,
        canonicalWorkItemId,
      })
      const oldScopeEvent = {
        type: 'comment.created',
        workspaceId,
        linkId: movedLinkId,
        teamId: duplicateTeamId,
        workItemId: duplicateWorkItemId,
        principalId,
        correlationId: `correlation-old-scope-${movedLinkId}`,
        occurredAt: fixture.clock.now(),
        externalSyncEligible: true,
        internalCommentId: `internal-old-scope-${movedLinkId}`,
        internalCommentVersion: 1,
        bodyMarkdown: `Moved reply for ${movedLinkId}`,
      } satisfies Parameters<ExternalChatSyncService['processOutbound']>[0]
      expect((await fixture.service.processOutbound(oldScopeEvent)).kind).toBe('applied')
    }
    expect(fixture.provider.replyInputs.slice(-2).map((input) => input.source.threadExternalId))
      .toEqual([fixture.link.source.threadExternalId, secondLink.source.threadExternalId])
  })
})

/**
 * Adds one active sibling link under the fixture provider workspace.
 *
 * @param fixture - Existing synthetic runtime.
 * @param options - Installation, conversation, and thread identity for the sibling.
 * @returns Created active provider-neutral link.
 */
async function createSiblingLink(
  fixture: SyntheticFixture,
  options: SiblingLinkOptions,
): Promise<ExternalChatWorkItemLink> {
  const rootMessageExternalId = `${options.threadExternalId}-root`
  const link: ExternalChatWorkItemLink = {
    ...fixture.link,
    id: options.linkId,
    teamId: options.teamId ?? `${options.linkId}-team`,
    workItemId: options.workItemId ?? `${options.linkId}-work-item`,
    installationId: options.installationId,
    conversation: {
      ...fixture.link.conversation,
      externalId: options.conversationExternalId,
      permalink: `https://chat.example.test/conversations/${options.conversationExternalId}`,
    },
    source: {
      externalWorkspaceId: fixture.link.source.externalWorkspaceId,
      conversationExternalId: options.conversationExternalId,
      threadExternalId: options.threadExternalId,
      rootMessageExternalId,
      sourceMessageExternalId: rootMessageExternalId,
      sourcePermalink: `https://chat.example.test/archives/${options.threadExternalId}`,
    },
    revision: 1,
    createdAt: initialNow,
    updatedAt: initialNow,
  }
  fixture.provider.allowSource(link.source)
  const created = await fixture.store.createLink({
    workspaceId,
    link,
    authorizationRevision: options.authorizationRevision ??
      fixture.provider.authorization.authorizationRevision,
    source: {
      provider: link.provider,
      externalWorkspaceId: link.source.externalWorkspaceId,
      conversationExternalId: link.source.conversationExternalId,
      threadExternalId: link.source.threadExternalId,
    },
    idempotencyKeyHash: createExternalChatFingerprint({
      kind: 'sibling-link-idempotency',
      linkId: link.id,
    }),
    requestFingerprint: createExternalChatFingerprint(link),
  })
  if (created.kind !== 'created') throw new Error('Expected the sibling link to be created.')
  return link
}

/**
 * Creates an exact provider source key for the synthetic adapter authorization set.
 *
 * @param source - Provider-neutral external thread reference.
 * @returns Collision-free synthetic source key.
 */
function syntheticSourceKey(source: ExternalChatThreadReference): string {
  return [
    source.externalWorkspaceId,
    source.conversationExternalId,
    source.threadExternalId,
  ].join('\0')
}

/**
 * Creates a restrictive workspace or conversation lifecycle event.
 *
 * @param eventId - Stable provider event identifier.
 * @param resourceType - Shared provider parent kind.
 * @param conversationExternalId - Conversation target for a narrow fan-out.
 * @param availability - Current parent source availability.
 * @param state - Current parent lifecycle state.
 * @param occurredAt - Provider occurrence timestamp used for deterministic ordering.
 * @returns Provider-neutral parent lifecycle event.
 */
function createParentLifecycleEvent(
  eventId: string,
  resourceType: 'workspace' | 'conversation',
  conversationExternalId = 'slack-channel-e2e',
  availability: Extract<
    ExternalChatInboundEvent,
    { type: 'source.lifecycle-changed' }
  >['availability'] = 'permission-lost',
  state: Extract<
    ExternalChatInboundEvent,
    { type: 'source.lifecycle-changed' }
  >['state'] = 'retained-metadata',
  occurredAt = initialNow,
): Extract<ExternalChatInboundEvent, { type: 'source.lifecycle-changed' }> {
  return resourceType === 'workspace'
    ? {
        ...createParentEventScope(eventId, occurredAt),
        type: 'source.lifecycle-changed',
        resourceType,
        availability,
        state,
        reasonCode: 'provider_parent_permission_revoked',
      }
    : {
        ...createParentEventScope(eventId, occurredAt),
        type: 'source.lifecycle-changed',
        resourceType,
        conversationExternalId,
        availability,
        state,
        reasonCode: 'provider_parent_permission_revoked',
      }
}

/** Creates one complete in-memory synchronization runtime and an active bidirectional link. */
async function createSyntheticFixture(): Promise<SyntheticFixture> {
  const source: ExternalChatThreadSelection = {
    externalWorkspaceId: 'slack-workspace-e2e',
    conversationExternalId: 'slack-channel-e2e',
    threadExternalId: 'slack-thread-e2e',
    rootMessageExternalId: 'root-message',
    sourceMessageExternalId: 'root-message',
    sourcePermalink: 'https://chat.example.test/archives/e2e/root-message',
    quotedRange: {
      sourceMessageExternalId: 'root-message',
      startOffset: 0,
      endOffset: 4,
      text: 'Root',
    },
  }
  const provider = new SyntheticChatProviderAdapter(source)
  const link: ExternalChatWorkItemLink = {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    id: linkId,
    teamId: duplicateTeamId,
    workItemId: duplicateWorkItemId,
    installationId,
    provider: 'slack',
    workspace: provider.thread.workspace,
    conversation: provider.thread.conversation,
    source,
    syncDirection: 'bidirectional',
    syncStatus: 'pending',
    sourceAvailability: 'available',
    sourceState: 'active',
    revision: 1,
    createdAt: initialNow,
    updatedAt: initialNow,
  }
  const store = new StrictDeferredFingerprintStore()
  const created = await store.createLink({
    workspaceId,
    link,
    authorizationRevision: provider.authorization.authorizationRevision,
    source: {
      provider: link.provider,
      externalWorkspaceId: source.externalWorkspaceId,
      conversationExternalId: source.conversationExternalId,
      threadExternalId: source.threadExternalId,
    },
    idempotencyKeyHash: createExternalChatFingerprint('fixture-link-idempotency-key'),
    requestFingerprint: createExternalChatFingerprint('fixture-link-request-fingerprint'),
  })
  if (created.kind !== 'created') throw new Error('Expected the fixture link to be created.')

  const collaboration = new SyntheticCollaborationPort()
  const attachments = new SyntheticAttachmentPort()
  const workItems = new SyntheticWorkItemPort()
  const access = new SyntheticAccessPort(provider.authorization)
  const clock = new MutableClock(initialNow)
  const adapters = new ChatProviderAdapterRegistry([provider])
  const audit = new SyntheticAuditPort()
  const service = new ExternalChatSyncService(
    {
      store,
      adapters,
      access,
      cursorCodec: new SyntheticCursorCodec(),
      messageOrder: new SyntheticMessageOrderPort(),
      threadOrder: new SyntheticThreadOrderPort(),
      collaboration,
      attachments,
      workItems,
      originSecrets: {
        /** Returns the deterministic installation-scoped fixture signing secret. */
        async getSigningSecret(
          requestedWorkspaceId: string,
          requestedInstallationId: string,
          providerName: 'slack' | 'microsoft-teams',
        ): Promise<string> {
          if (
            requestedWorkspaceId !== workspaceId ||
            requestedInstallationId !== installationId ||
            providerName !== 'slack'
          ) {
            throw new Error('Synthetic signing-secret scope mismatch.')
          }
          return signingSecret
        },
      },
      audit,
      clock,
    },
    { deferDelayMs: 1_000 },
  )
  const webhookRuntime = new ExternalChatWebhookRuntime({ adapters, sync: service })
  return {
    store,
    service,
    webhookRuntime,
    provider,
    collaboration,
    attachments,
    workItems,
    access,
    audit,
    clock,
    link,
  }
}

/**
 * Creates one active provider-neutral message in the linked source.
 *
 * @param externalId - Immutable provider message identifier.
 * @param externalVersion - Numeric provider revision serialized as text.
 * @param bodyMarkdown - Normalized message body.
 * @param parentMessageExternalId - Optional external parent message.
 * @param attachments - Permission-filtered provider attachments.
 * @returns Synthetic provider message.
 */
function createMessage(
  externalId: string,
  externalVersion: string,
  bodyMarkdown: string,
  parentMessageExternalId?: string,
  attachments: ExternalChatAttachment[] = [],
): ExternalChatMessage {
  return {
    externalId,
    externalVersion,
    conversationExternalId: 'slack-channel-e2e',
    threadExternalId: 'slack-thread-e2e',
    parentMessageExternalId,
    permalink: `https://chat.example.test/archives/e2e/${externalId}`,
    availability: 'available',
    state: 'active',
    actor: {
      externalId: 'external-actor-e2e',
      kind: 'person',
      displayName: 'External collaborator',
    },
    bodyMarkdown,
    quotedRanges: [],
    attachments,
    postedAt: initialNow,
    updatedAt: initialNow,
  }
}

/**
 * Creates provider metadata containing an untrusted internal File ID claim.
 *
 * @param externalId - Immutable provider attachment identifier.
 * @param providerImportedFileId - Provider-supplied value that the service must discard.
 * @returns Permission-filtered attachment metadata.
 */
function createProviderAttachmentWithClaimedFileId(
  externalId: string,
  providerImportedFileId: string,
): ExternalChatAttachment {
  return {
    externalId,
    fileName: `${externalId}.txt`,
    contentType: 'text/plain',
    sizeBytes: 42,
    permalink: `https://chat.example.test/files/${externalId}`,
    availability: 'available',
    state: 'active',
    importedFileId: providerImportedFileId,
    createdAt: initialNow,
  }
}

/**
 * Creates a normalized external message creation event.
 *
 * @param eventId - Stable provider event identifier.
 * @param message - Complete permission-filtered message snapshot.
 * @param options - Optional authenticated outbound origin claim.
 * @returns Provider-neutral creation event.
 */
function createMessageCreatedEvent(
  eventId: string,
  message: ExternalChatMessage,
  options: { /** Authenticated outbound operation claimed by the provider echo. */ originOperationId?: string } = {},
): Extract<ExternalChatInboundEvent, { type: 'message.created' }> {
  return {
    ...createEventScope(eventId),
    type: 'message.created',
    originOperationId: options.originOperationId,
    message,
  }
}

/**
 * Creates a normalized external message edit event.
 *
 * @param eventId - Stable provider event identifier.
 * @param message - Complete edited message snapshot.
 * @returns Provider-neutral edit event.
 */
function createMessageEditedEvent(
  eventId: string,
  message: ExternalChatMessage,
): Extract<ExternalChatInboundEvent, { type: 'message.edited' }> {
  return {
    ...createEventScope(eventId),
    type: 'message.edited',
    message,
  }
}

/**
 * Creates a normalized external message tombstone event.
 *
 * @param eventId - Stable provider event identifier.
 * @param externalMessageId - Immutable provider message identifier.
 * @param externalVersion - Provider tombstone revision.
 * @returns Provider-neutral deletion event.
 */
function createMessageDeletedEvent(
  eventId: string,
  externalMessageId: string,
  externalVersion: string,
): Extract<ExternalChatInboundEvent, { type: 'message.deleted' }> {
  return {
    ...createEventScope(eventId),
    type: 'message.deleted',
    externalMessageId,
    externalVersion,
    deletedAt: initialNow,
  }
}

/**
 * Creates an inbound provider thread completion or reopen event.
 *
 * @param eventId - Stable provider event identifier.
 * @param completed - Whether the provider thread became complete.
 * @param externalVersion - Provider lifecycle revision.
 * @returns Provider-neutral lifecycle event.
 */
function createThreadCompletionEvent(
  eventId: string,
  completed: boolean,
  externalVersion = completed ? '2' : '3',
): Extract<ExternalChatInboundEvent, { type: 'thread.completed' | 'thread.reopened' }> {
  if (completed) {
    return {
      ...createEventScope(eventId),
      type: 'thread.completed',
      externalVersion,
      completedAt: initialNow,
    }
  }
  return {
    ...createEventScope(eventId),
    type: 'thread.reopened',
    externalVersion,
    reopenedAt: initialNow,
  }
}

/**
 * Creates one eligible internal comment creation event.
 *
 * @param internalCommentId - Canonical internal comment identifier.
 * @param correlationId - Trusted internal correlation identifier.
 * @returns Trusted outbound comment creation event.
 */
function createOutboundCommentCreatedEvent(
  internalCommentId: string,
  correlationId: string,
): Extract<Parameters<ExternalChatSyncService['processOutbound']>[0], {
  type: 'comment.created'
}> {
  return {
    type: 'comment.created',
    workspaceId,
    linkId,
    teamId: duplicateTeamId,
    workItemId: duplicateWorkItemId,
    principalId,
    correlationId,
    occurredAt: initialNow,
    externalSyncEligible: true,
    internalCommentId,
    internalCommentVersion: 1,
    bodyMarkdown: 'Internal identity validation target',
  }
}

/**
 * Creates an eligible internal Work Item completion or reopen event.
 *
 * @param completed - Whether the Work Item became complete.
 * @param workItemRevision - Current canonical Work Item revision.
 * @returns Trusted outbound lifecycle event.
 */
function createWorkItemCompletionEvent(
  completed: boolean,
  workItemRevision: number,
): Parameters<ExternalChatSyncService['processOutbound']>[0] {
  const common = {
    workspaceId,
    linkId,
    teamId: duplicateTeamId,
    workItemId: duplicateWorkItemId,
    principalId,
    correlationId: `correlation-work-item-${workItemRevision}`,
    occurredAt: initialNow,
    externalSyncEligible: true,
    workItemRevision,
  }
  return completed
    ? { ...common, type: 'work-item.completed' }
    : { ...common, type: 'work-item.reopened' }
}

/**
 * Creates a provider lifecycle event that changes source visibility.
 *
 * @param eventId - Stable provider event identifier.
 * @param availability - Current source availability.
 * @param state - Last visible source lifecycle state.
 * @param occurredAt - Provider occurrence timestamp used for deterministic ordering.
 * @returns Provider-neutral lifecycle event.
 */
function createSourceLifecycleEvent(
  eventId: string,
  availability: Extract<
    ExternalChatInboundEvent,
    { type: 'source.lifecycle-changed' }
  >['availability'],
  state: Extract<
    ExternalChatInboundEvent,
    { type: 'source.lifecycle-changed' }
  >['state'],
  occurredAt = initialNow,
): Extract<
  ExternalChatInboundEvent,
  { type: 'source.lifecycle-changed'; resourceType: 'thread' }
> {
  return {
    ...createEventScope(eventId),
    occurredAt,
    type: 'source.lifecycle-changed',
    resourceType: 'thread',
    availability,
    state,
    reasonCode: 'provider_permission_revoked',
  }
}

/**
 * Creates a provider lifecycle event for one imported message or attachment.
 *
 * @param eventId - Stable provider event identifier.
 * @param resourceType - Imported resource kind.
 * @param resourceExternalId - Provider-scoped resource identifier.
 * @param availability - Current provider reachability.
 * @param state - Last known resource lifecycle state.
 * @returns Provider-neutral resource lifecycle event.
 */
function createResourceLifecycleEvent(
  eventId: string,
  resourceType: 'message' | 'attachment',
  resourceExternalId: string,
  availability: Extract<
    ExternalChatInboundEvent,
    { type: 'source.lifecycle-changed' }
  >['availability'],
  state: Extract<
    ExternalChatInboundEvent,
    { type: 'source.lifecycle-changed' }
  >['state'],
): Extract<ExternalChatInboundEvent, { type: 'source.lifecycle-changed' }> {
  return {
    ...createEventScope(eventId),
    type: 'source.lifecycle-changed',
    resourceType,
    resourceExternalId,
    availability,
    state,
    reasonCode: 'provider_resource_policy_changed',
  }
}

/**
 * Creates a mandatory thread retention-expiry event.
 *
 * @param eventId - Stable provider event identifier.
 * @returns Provider-neutral terminal thread lifecycle event.
 */
function createThreadRetentionExpiredEvent(
  eventId: string,
): Extract<ExternalChatInboundEvent, { type: 'source.lifecycle-changed' }> {
  return {
    ...createEventScope(eventId),
    type: 'source.lifecycle-changed',
    resourceType: 'thread',
    availability: 'available',
    state: 'retention-expired',
    reasonCode: 'provider_retention_expired',
  }
}

/**
 * Creates fields shared by normalized workspace- and conversation-scoped provider events.
 *
 * @param eventId - Stable provider event identifier.
 * @param occurredAt - Provider occurrence timestamp.
 * @returns Provider event scope without fabricated thread or conversation identifiers.
 */
function createParentEventScope(eventId: string, occurredAt: string): {
  /** External chat contract schema version. */
  schemaVersion: typeof EXTERNAL_CHAT_SCHEMA_VERSION
  /** Stable provider event identifier. */
  eventId: string
  /** Correlation identifier propagated through synchronization. */
  correlationId: string
  /** Installation that authenticated the event. */
  installationId: string
  /** Provider that emitted the event. */
  provider: 'slack'
  /** Provider workspace in the event scope. */
  externalWorkspaceId: string
  /** Provider occurrence timestamp. */
  occurredAt: string
} {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    eventId,
    correlationId: `correlation-${eventId}`,
    installationId,
    provider: 'slack',
    externalWorkspaceId: 'slack-workspace-e2e',
    occurredAt,
  }
}

/**
 * Creates fields shared by normalized inbound provider events.
 *
 * @param eventId - Stable provider event identifier.
 * @returns Fully scoped inbound event fields.
 */
function createEventScope(eventId: string): {
  /** External chat contract schema version. */
  schemaVersion: typeof EXTERNAL_CHAT_SCHEMA_VERSION
  /** Stable provider event identifier. */
  eventId: string
  /** Correlation identifier propagated through synchronization. */
  correlationId: string
  /** Installation that authenticated the event. */
  installationId: string
  /** Provider that emitted the event. */
  provider: 'slack'
  /** Provider workspace in the event scope. */
  externalWorkspaceId: string
  /** Provider conversation in the event scope. */
  conversationExternalId: string
  /** Provider thread in the event scope. */
  threadExternalId: string
  /** Provider occurrence timestamp. */
  occurredAt: string
} {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    eventId,
    correlationId: `correlation-${eventId}`,
    installationId,
    provider: 'slack',
    externalWorkspaceId: 'slack-workspace-e2e',
    conversationExternalId: 'slack-channel-e2e',
    threadExternalId: 'slack-thread-e2e',
    occurredAt: initialNow,
  }
}

/**
 * Reproduces the one-way internal correlation boundary asserted by the E2E fixture.
 *
 * @param providerCorrelationId - Synthetic provider correlation value.
 * @returns Stable secret-free internal correlation identifier.
 */
function expectedInboundCorrelationId(providerCorrelationId: string): string {
  const digest = createExternalChatFingerprint({ providerCorrelationId })
  return `chat_corr_${digest.slice(0, 40)}`
}

/**
 * Restores an opaque origin marker only from the signature-verified raw provider envelope.
 *
 * @param rawBody - Exact synthetic provider webhook bytes.
 * @param events - Normalized events produced from the same envelope.
 * @returns Event-keyed runtime marker map, or undefined when the envelope carries no marker.
 */
function readSyntheticRawOriginMarkers(
  rawBody: Uint8Array,
  events: readonly ExternalChatInboundEvent[],
): Readonly<Record<string, string>> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    throw new Error('Synthetic webhook JSON is invalid.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Synthetic webhook envelope is invalid.')
  }
  const record = Object.fromEntries(Object.entries(parsed))
  if (record.originMarker === undefined) return undefined
  if (
    typeof record.eventId !== 'string' ||
    typeof record.originMarker !== 'string' ||
    record.eventId.length === 0 ||
    record.originMarker.length === 0 ||
    !events.some((event) => event.eventId === record.eventId)
  ) throw new Error('Synthetic webhook origin marker scope is invalid.')
  return { [record.eventId]: record.originMarker }
}

/**
 * Parses the synthetic provider's positive integer message version.
 *
 * @param version - Provider version text.
 * @returns Positive integer version.
 */
function parseVersion(version: string): number {
  const parsed = Number(version)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Synthetic provider versions must be positive integers.')
  }
  return parsed
}

/**
 * Collects unique scanned internal File identifiers from provider attachment metadata.
 *
 * @param attachments - Permission-filtered provider attachments.
 * @returns Deterministically sorted unique File identifiers.
 */
function collectImportedFileIds(attachments: readonly ExternalChatAttachment[]): string[] {
  const fileIds: string[] = []
  for (const attachment of attachments) {
    if (attachment.importedFileId) fileIds.push(attachment.importedFileId)
  }
  return uniqueStrings(fileIds)
}

/**
 * Deduplicates and sorts stable identifiers.
 *
 * @param values - Candidate identifiers.
 * @returns Sorted unique identifiers.
 */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}
