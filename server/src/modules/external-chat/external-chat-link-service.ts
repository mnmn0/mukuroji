import { createHash } from 'node:crypto'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type ApprovalSummary,
  type CanonicalWorkItem,
  type CreateWorkItemFromExternalChatThreadInput,
  type CreateWorkItemFromExternalChatThreadResult,
  type CustomFieldValue,
  type ExternalChatCanonicalRedirect,
  type ExternalChatCanonicalRoute,
  type ExternalChatProvider,
  type ExternalChatSourceAvailability,
  type ExternalChatSourceState,
  type ExternalChatThreadSnapshot,
  type ExternalChatWorkItemLink,
  type ExternalChatWorkItemLinkSummary,
  type LinkExternalChatThreadInput,
  type LinkExternalChatThreadResult,
  type MergeExternalChatWorkItemLinksInput,
  type MergeExternalChatWorkItemLinksResult,
  type ResyncExternalChatWorkItemLinkInput,
  type ResyncExternalChatWorkItemLinkResult,
  type UnlinkExternalChatThreadInput,
  type UnlinkExternalChatThreadResult,
  type UpdateExternalChatWorkItemLinkInput,
  type UpdateExternalChatWorkItemLinkResult,
} from '@mukuroji/contracts'
import {
  deriveWorkItemScheduleDueDate,
  isCanonicalWorkItemRelationIds,
  isCanonicalWorkItemSchedule,
} from '../work-items'
import {
  type ChatProviderAuthorization,
  ChatProviderAdapterError,
  ChatProviderAdapterRegistry,
} from './chat-provider-adapter'
import { normalizeChatProviderThreadSnapshot } from './chat-provider-normalizer'
import {
  type CreateExternalChatLinkInput,
  createExternalChatFingerprint,
  ExternalChatError,
  externalChatLifecycleBlocksSynchronization,
  type ExternalChatLinkLifecycleState,
  type ExternalChatParentLifecycleFenceSnapshot,
  type ExternalChatStore,
  type MergeExternalChatLinksStoreInput,
  type StoredExternalChatLink,
} from './external-chat'

/** Authenticated Workspace principal for external chat link commands. */
export type ExternalChatLinkPrincipal = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Canonical Workspace member key. */
  memberKey: string
}

/** Request-scoped state required by every retryable external chat link command. */
export type ExternalChatLinkCommandContext = {
  /** Authenticated caller. */
  principal: ExternalChatLinkPrincipal
  /** Caller-supplied idempotency key bound to the complete command. */
  idempotencyKey: string
  /** Correlation identifier retained across transaction and audit records. */
  correlationId: string
  /** Canonical command timestamp in ISO 8601 format. */
  occurredAt: string
}

/** Provider installation resolved after current user and source authorization. */
export type AuthorizedExternalChatInstallation = {
  /** Provider implemented by the resolved installation. */
  provider: ExternalChatProvider
  /** Current provider authorization snapshot. */
  authorization: ChatProviderAuthorization
}

/** Current authorization operations required by external chat link commands. */
export interface ExternalChatLinkAccessPort {
  /** Authorizes creating a Work Item in one Team. */
  authorizeTeamCreate(principal: ExternalChatLinkPrincipal, teamId: string): Promise<void>
  /**
   * Authorizes reading or mutating one existing Work Item.
   *
   * Implementations must resolve a durable former-duplicate route and authorize its canonical
   * target so a response-loss replay can reach the merge transaction receipt after tombstoning.
   */
  authorizeWorkItem(
    principal: ExternalChatLinkPrincipal,
    teamId: string,
    workItemId: string,
    mode: 'read' | 'write',
  ): Promise<void>
  /** Resolves an installation only after current consent, tenant, and source access checks. */
  resolveInstallation(
    principal: ExternalChatLinkPrincipal,
    installationId: string,
    externalWorkspaceId: string,
    mode: 'read' | 'write',
  ): Promise<AuthorizedExternalChatInstallation>
}

/** Safe audit record emitted by the external chat link application boundary. */
export type ExternalChatLinkAuditRecord = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Workspace member that initiated the command. */
  actorMemberKey: string
  /** Correlation identifier retained across the logical mutation. */
  correlationId: string
  /** Stable logical operation identifier. */
  operationId: string
  /** Link command being attempted. */
  action: 'create-work-item' | 'link' | 'update' | 'unlink' | 'resync' | 'merge'
  /** Team affected by the command when safely known before failure. */
  teamId?: string
  /** Work Item affected by the command when known before commit. */
  workItemId?: string
  /** External chat link affected by the command when known before commit. */
  linkId?: string
  /** Provider affected by the command when a source is involved. */
  provider?: ExternalChatProvider
  /** SHA-256 digest of the external thread identity, never its raw IDs. */
  sourceDigest?: string
  /** Secret-free command outcome. */
  outcome: 'attempted' | 'applied' | 'replayed' | 'failed'
  /** Stable secret-free result or error code. */
  reasonCode: string
  /** Audit occurrence timestamp. */
  occurredAt: string
}

/** Idempotent secret-free sink used for command failures outside successful transactions. */
export interface ExternalChatLinkFailureAuditPort {
  /** Records one bounded failed command result by stable operation identity. */
  record(record: ExternalChatLinkAuditRecord): Promise<void>
}

/** Safely known identifiers retained when a link command fails before its transaction commits. */
type ExternalChatLinkFailureAuditScope = {
  /** Team selected by the command when already safe to retain. */
  teamId?: string
  /** Existing Work Item selected by the command when already safe to retain. */
  workItemId?: string
  /** Link selected by the command when already safe to retain. */
  linkId?: string
}

/** Atomic cross-domain input for creating a Work Item with its initial chat link. */
export type CreateWorkItemAndExternalChatLinkTransactionInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Workspace member that initiated the command. */
  actorMemberKey: string
  /** Original provider-neutral command. */
  command: CreateWorkItemFromExternalChatThreadInput
  /** Permission-filtered source snapshot used to construct the Work Item. */
  sourceThread: ExternalChatThreadSnapshot
  /** Link/source/idempotency state completed with the created Work Item ID in the transaction. */
  linkDraft: CreateWorkItemExternalChatLinkDraft
  /** Stable logical operation identifier. */
  operationId: string
  /** Final audit outbox record completed with the created Work Item ID and committed atomically. */
  audit: ExternalChatLinkAuditRecord
}

/** Link creation state that intentionally omits the not-yet-created Work Item identifier. */
export type CreateWorkItemExternalChatLinkDraft = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Provider-neutral link fields known before the Work Item is created. */
  link: Omit<ExternalChatWorkItemLink, 'workItemId'>
  /** Canonical source identity claimed by the link. */
  source: CreateExternalChatLinkInput['source']
  /** Provider authorization generation that was current when the source was resolved. */
  authorizationRevision: number
  /** Digest of the tenant-scoped idempotency key. */
  idempotencyKeyHash: string
  /** Digest of the complete normalized command. */
  requestFingerprint: string
}

/** Atomic cross-domain input for linking an existing Work Item. */
export type LinkExistingWorkItemToExternalChatTransactionInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Workspace member that initiated the command. */
  actorMemberKey: string
  /** Original provider-neutral command. */
  command: LinkExternalChatThreadInput
  /** Permission-filtered source snapshot validated before commit. */
  sourceThread: ExternalChatThreadSnapshot
  /** Link/source/idempotency state to commit with Work Item fencing. */
  link: CreateExternalChatLinkInput
  /** Stable logical operation identifier. */
  operationId: string
  /** Final redacted audit outbox record committed with state and the idempotency receipt. */
  audit: ExternalChatLinkAuditRecord
}

/** Atomic input for changing one link's synchronization direction. */
export type UpdateExternalChatLinkTransactionInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Workspace member that authorized the command. */
  actorMemberKey: string
  /** Complete replacement link committed when the expected revision still owns the record. */
  link: ExternalChatWorkItemLink
  /** Link revision read by the caller before the update. */
  expectedRevision: number
  /** Exact present-or-absent parent lifecycle authorities observed before the update. */
  expectedParentLifecycleFences: ExternalChatParentLifecycleFenceSnapshot
  /** Digest of the tenant- and actor-scoped idempotency key. */
  idempotencyKeyHash: string
  /** Digest of the link ID and complete normalized update command. */
  requestFingerprint: string
  /** Stable logical operation identifier shared by receipt and audit outbox state. */
  operationId: string
  /** Final redacted audit outbox record committed with mutation and receipt. */
  audit: ExternalChatLinkAuditRecord
}

/** Transaction-owned result for an idempotent link settings update. */
export type UpdateExternalChatLinkTransactionResult = {
  /** Stable operation identifier that owns the committed receipt. */
  operationId: string
  /** Active updated record returned by a first commit or exact receipt replay. */
  record: StoredExternalChatLink
}

/** Atomic input for unlinking one external chat source. */
export type UnlinkExternalChatLinkTransactionInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Workspace member that authorized the command. */
  actorMemberKey: string
  /** Stable external chat link identifier. */
  linkId: string
  /** Link revision read by the caller before unlinking. */
  expectedRevision: number
  /** Canonical unlink timestamp retained in the idempotent result. */
  unlinkedAt: string
  /** Digest of the tenant- and actor-scoped idempotency key. */
  idempotencyKeyHash: string
  /** Digest of the link ID and complete normalized unlink command. */
  requestFingerprint: string
  /** Stable logical operation identifier shared by receipt and audit outbox state. */
  operationId: string
  /** Final redacted audit outbox record committed with mutation and receipt. */
  audit: ExternalChatLinkAuditRecord
}

/** Transaction-owned result for an idempotent unlink command. */
export type UnlinkExternalChatLinkTransactionResult = {
  /** Stable operation identifier that owns the committed receipt. */
  operationId: string
  /** Inactive unlinked record returned by a first commit or exact receipt replay. */
  record: StoredExternalChatLink
}

/** Atomic cross-domain input for merging Work Items and link-owned chat state. */
export type MergeWorkItemsAndExternalChatLinksTransactionInput = {
  /** Authenticated caller. */
  principal: ExternalChatLinkPrincipal
  /** Original revision-fenced merge command. */
  command: MergeExternalChatWorkItemLinksInput
  /** Tenant-scoped store mutation derived from the command. */
  storeMutation: MergeExternalChatLinksStoreInput
  /** Stable logical operation identifier. */
  operationId: string
  /** Digest of the tenant- and actor-scoped idempotency key. */
  idempotencyKeyHash: string
  /** Digest of the complete normalized duplicate merge command. */
  requestFingerprint: string
  /** Final redacted audit outbox record committed with Work Item, link, redirect, and receipt state. */
  audit: ExternalChatLinkAuditRecord
}

/** Durable resynchronization command accepted by a background worker. */
export type ExternalChatResyncJob = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Link selected for resynchronization. */
  linkId: string
  /** Resume or full rebuild mode. */
  mode: 'resume' | 'full'
  /** Link revision committed with the queue outbox entry. */
  linkRevision: number
  /** Provider authorization generation accepted for this exact operation. */
  authorizationRevision: number
  /** Stable operation identifier shared by every retry. */
  operationId: string
  /** Correlation identifier retained by the worker. */
  correlationId: string
  /** Command acceptance timestamp. */
  acceptedAt: string
}

/** Atomic input for accepting one explicit external chat resynchronization. */
export type AcceptExternalChatResyncTransactionInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Link state committed with the resynchronization outbox entry. */
  link: ExternalChatWorkItemLink
  /** Link revision read before command acceptance. */
  expectedRevision: number
  /** Private source authorization generation read before command acceptance. */
  expectedSourceAuthorizationRevision: number
  /** Current provider authorization generation retained by the accepted job. */
  authorizationRevision: number
  /** Exact present-or-absent parent lifecycle authorities observed before command acceptance. */
  expectedParentLifecycleFences: ExternalChatParentLifecycleFenceSnapshot
  /** Digest of the tenant-scoped idempotency key. */
  idempotencyKeyHash: string
  /** Digest of the complete normalized command. */
  requestFingerprint: string
  /** Stable operation identifier shared by the receipt and outbox entry. */
  operationId: string
  /** Durable job to publish from the committed outbox. */
  job: ExternalChatResyncJob
  /** Final redacted audit outbox record committed with state, receipt, and job outbox. */
  audit: ExternalChatLinkAuditRecord
}

/** Cross-domain transaction boundary for canonical Work Item and external chat ownership. */
export interface ExternalChatLinkTransactionPort {
  /**
   * Creates the Work Item, link, source claim, owner manifest, receipt, audit, and outbox atomically.
   * The commit must condition-check the current connector authorization generation and both
   * durable workspace/conversation parent lifecycle fences from the supplied link draft, then
   * retain that generation with the private immutable source claim.
   */
  createWorkItemAndLink(
    input: CreateWorkItemAndExternalChatLinkTransactionInput,
  ): Promise<CreateWorkItemFromExternalChatThreadResult>
  /**
   * Links an existing revision-fenced Work Item, source, and incremented owner manifest atomically.
   * The commit must condition-check the current connector authorization generation and both
   * durable workspace/conversation parent lifecycle fences from the supplied link input, then
   * retain that generation with the private immutable source claim.
   */
  linkExistingWorkItem(
    input: LinkExistingWorkItemToExternalChatTransactionInput,
  ): Promise<LinkExternalChatThreadResult>
  /**
   * Atomically commits link settings, idempotency receipt, and final redacted audit outbox.
   * The commit must condition-check the exact supplied parent lifecycle snapshot so a published
   * restrictive fence cannot be overwritten by a stale pending settings projection.
   */
  updateLink(
    input: UpdateExternalChatLinkTransactionInput,
  ): Promise<UpdateExternalChatLinkTransactionResult>
  /** Atomically commits unlink state, decremented owner manifest, receipt, and redacted audit. */
  unlinkLink(
    input: UnlinkExternalChatLinkTransactionInput,
  ): Promise<UnlinkExternalChatLinkTransactionResult>
  /**
   * Accepts a resynchronization by atomically committing link, receipt, audit, and outbox state.
   * The commit must also reject a processing or completed-unacknowledged thread lifecycle lease,
   * a changed connector authorization generation, a changed private source authorization
   * generation, or a changed exact parent lifecycle snapshot.
   */
  acceptResync(
    input: AcceptExternalChatResyncTransactionInput,
  ): Promise<ResyncExternalChatWorkItemLinkResult>
  /**
   * Merges Work Items and every link-owned record under one transaction or resumable manifest.
   * The commit must strongly enumerate the duplicate owner's complete active link set, compare it
   * exactly with the command, condition-check the supplied membership generation/count, and
   * advance both duplicate and canonical owner manifests atomically with Work Item tombstoning.
   * An existing idempotency receipt must be replayed before those current-state checks so a
   * response-loss retry still succeeds after the first commit advances the duplicate manifest.
   */
  mergeWorkItemsAndLinks(
    input: MergeWorkItemsAndExternalChatLinksTransactionInput,
  ): Promise<MergeWorkItemsAndExternalChatLinksTransactionResult>
}

/** Internal duplicate-merge result retaining link-scoped redirects for fail-closed validation. */
export type MergeWorkItemsAndExternalChatLinksTransactionResult = Omit<
  MergeExternalChatWorkItemLinksResult,
  'redirects'
> & {
  /** Exact redirect created for every moved link before public route redaction. */
  redirects: ExternalChatCanonicalRedirect[]
}

/** Durable queue used for explicit external chat resynchronization. */
export interface ExternalChatResyncQueuePort {
  /** Idempotently enqueues one link-scoped resynchronization job. */
  enqueue(job: ExternalChatResyncJob): Promise<void>
}

/** Dependencies required by the external chat link application service. */
export type ExternalChatLinkServiceDependencies = {
  /** Current internal and provider authorization boundary. */
  access: ExternalChatLinkAccessPort
  /** Registered Slack and Microsoft Teams adapters. */
  adapters: ChatProviderAdapterRegistry
  /** Durable tenant-scoped chat state. */
  store: ExternalChatStore
  /** Atomic Work Item/chat cross-domain mutation boundary. */
  transactions: ExternalChatLinkTransactionPort
  /** Idempotent security audit sink for unsuccessful commands. */
  failureAudit: ExternalChatLinkFailureAuditPort
}

/** Application service for external chat source creation, linking, lifecycle, and duplicate merge. */
export class ExternalChatLinkService {
  /** Current internal and external authorization boundary. */
  private readonly access: ExternalChatLinkAccessPort

  /** Registered provider adapters. */
  private readonly adapters: ChatProviderAdapterRegistry

  /** Durable tenant-scoped external chat state. */
  private readonly store: ExternalChatStore

  /** Atomic cross-domain transaction boundary. */
  private readonly transactions: ExternalChatLinkTransactionPort

  /** Secret-free audit boundary for unsuccessful command results. */
  private readonly failureAudit: ExternalChatLinkFailureAuditPort

  /**
   * Creates an external chat link application service.
   *
   * @param dependencies - Authorization, provider, persistence, transaction, and audit ports.
   */
  constructor(dependencies: ExternalChatLinkServiceDependencies) {
    this.access = dependencies.access
    this.adapters = dependencies.adapters
    this.store = dependencies.store
    this.transactions = dependencies.transactions
    this.failureAudit = dependencies.failureAudit
  }

  /**
   * Creates a canonical Work Item and atomically claims its provider thread.
   *
   * @param context - Authenticated idempotent command context.
   * @param command - Work Item and provider source input.
   * @returns Created or idempotently recovered Work Item and link.
   */
  async createWorkItemFromThread(
    context: ExternalChatLinkCommandContext,
    command: CreateWorkItemFromExternalChatThreadInput,
  ): Promise<CreateWorkItemFromExternalChatThreadResult> {
    validateContext(context)
    return this.withFailureAudit(context, 'create-work-item', command, {
      teamId: safeFailureIdentifier(command.teamId),
    }, async () => {
    validateCreateWorkItemCommand(command)
    await this.access.authorizeTeamCreate(context.principal, requireIdentifier(command.teamId))
    const resolved = await this.resolveSource(context.principal, command.installationId, command.source)
    const identity = sourceIdentity(resolved.provider, command.source)
    const operationId = createLinkCommandOperationId(context, 'create-work-item', command)
    const link = createInitialLinkDraft(
      context,
      command.teamId,
      deterministicLinkId(operationId),
      command.installationId,
      resolved.provider,
      resolved.thread,
      command.source,
      command.syncDirection,
    )
    const createInput: CreateWorkItemExternalChatLinkDraft = {
      workspaceId: context.principal.workspaceId,
      link,
      source: identity,
      authorizationRevision: resolved.authorizationRevision,
      idempotencyKeyHash: hashIdempotencyKey(context, 'create-work-item'),
      requestFingerprint: createExternalChatFingerprint(command),
    }
    const audit = createAuditRecord(
      context,
      operationId,
      'create-work-item',
      command.teamId,
      undefined,
      link.id,
      resolved.provider,
      createExternalChatFingerprint(identity),
      'applied',
      'ExternalChatWorkItemCreated',
    )
    const result = await this.transactions.createWorkItemAndLink({
      workspaceId: context.principal.workspaceId,
      actorMemberKey: context.principal.memberKey,
      command,
      sourceThread: resolved.thread,
      linkDraft: createInput,
      operationId,
      audit,
    })
    const workItem = validateCreateWorkItemTransactionResult(
      context,
      command,
      link,
      result,
      this.adapters.get(resolved.provider).definition.permalinkHosts,
    )
    return {
      workItem,
      link: toExternalChatWorkItemLink(result.link),
    }
    })
  }

  /**
   * Atomically links an authorized existing Work Item to one provider thread.
   *
   * @param context - Authenticated idempotent command context.
   * @param command - Existing Work Item and provider source input.
   * @returns Created or idempotently recovered link.
   */
  async linkThread(
    context: ExternalChatLinkCommandContext,
    command: LinkExternalChatThreadInput,
  ): Promise<LinkExternalChatThreadResult> {
    validateContext(context)
    return this.withFailureAudit(context, 'link', command, {
      teamId: safeFailureIdentifier(command.teamId),
      workItemId: safeFailureIdentifier(command.workItemId),
    }, async () => {
    validateLinkWorkItemCommand(command)
    await this.access.authorizeWorkItem(
      context.principal,
      requireIdentifier(command.teamId),
      requireIdentifier(command.workItemId),
      'write',
    )
    const resolved = await this.resolveSource(context.principal, command.installationId, command.source)
    const identity = sourceIdentity(resolved.provider, command.source)
    const operationId = createLinkCommandOperationId(context, 'link', command)
    const link = createInitialLink(
      context,
      command.teamId,
      deterministicLinkId(operationId),
      command.workItemId,
      command.installationId,
      resolved.provider,
      resolved.thread,
      command.source,
      command.syncDirection,
    )
    const createInput: CreateExternalChatLinkInput = {
      workspaceId: context.principal.workspaceId,
      link,
      source: identity,
      authorizationRevision: resolved.authorizationRevision,
      idempotencyKeyHash: hashIdempotencyKey(context, 'link'),
      requestFingerprint: createExternalChatFingerprint(command),
    }
    const audit = createAuditRecord(
      context,
      operationId,
      'link',
      command.teamId,
      command.workItemId,
      link.id,
      resolved.provider,
      createExternalChatFingerprint(identity),
      'applied',
      'ExternalChatLinkCreated',
    )
    const result = await this.transactions.linkExistingWorkItem({
      workspaceId: context.principal.workspaceId,
      actorMemberKey: context.principal.memberKey,
      command,
      sourceThread: resolved.thread,
      link: createInput,
      operationId,
      audit,
    })
    validateLinkTransactionResult(
      command,
      link,
      result,
      this.adapters.get(resolved.provider).definition.permalinkHosts,
    )
    return { link: toExternalChatWorkItemLink(result.link) }
    })
  }

  /**
   * Changes synchronization direction using optimistic link concurrency.
   *
   * @param context - Authenticated idempotent command context.
   * @param linkId - Link to update.
   * @param command - Replacement direction and expected revision.
   * @returns Updated link.
   */
  async updateLink(
    context: ExternalChatLinkCommandContext,
    linkId: string,
    command: UpdateExternalChatWorkItemLinkInput,
  ): Promise<UpdateExternalChatWorkItemLinkResult> {
    validateContext(context)
    return this.withFailureAudit(context, 'update', { linkId, command }, {
      linkId: safeFailureIdentifier(linkId),
    }, async () => {
    validateUpdateCommand(linkId, command)
    const current = await this.requireAuthorizedLink(context.principal, linkId, 'write')
    if (!current.active) throw notFoundError()
    const parentLifecycleFences = await this.store.getParentLifecycleFences(
      context.principal.workspaceId,
      current.link.id,
    )
    if (parentLifecycleFences === undefined) throw notFoundError()
    const operationId = createLinkCommandOperationId(context, 'update', { linkId, command })
    const requested: ExternalChatWorkItemLink = {
      ...current.link,
      syncDirection: command.syncDirection,
      syncStatus: command.syncDirection === 'none' ? 'paused' : 'pending',
      revision: command.expectedRevision + 1,
      updatedAt: context.occurredAt,
    }
    const replacement = composeCommandProjectionWithLifecycleFloor(
      requested,
      current.lifecycleState,
      parentLifecycleFences,
      current.sourceAuthorizationRevision,
    )
    const audit = createAuditRecord(
      context,
      operationId,
      'update',
      current.link.teamId,
      current.link.workItemId,
      current.link.id,
      current.link.provider,
      current.sourceDigest,
      'applied',
      'ExternalChatLinkUpdated',
    )
    const result = await this.transactions.updateLink({
      workspaceId: context.principal.workspaceId,
      link: replacement,
      expectedRevision: command.expectedRevision,
      expectedParentLifecycleFences: parentLifecycleFences,
      actorMemberKey: context.principal.memberKey,
      idempotencyKeyHash: hashIdempotencyKey(context, 'update'),
      requestFingerprint: createExternalChatFingerprint({ linkId, command }),
      operationId,
      audit,
    })
    validateUpdateTransactionResult(
      context,
      operationId,
      replacement,
      current.sourceDigest,
      result,
    )
    return { link: toExternalChatWorkItemLinkSummary(result.record.link) }
    })
  }

  /**
   * Detaches a link without deleting imported internal comments or files.
   *
   * @param context - Authenticated idempotent command context.
   * @param linkId - Link to detach.
   * @param command - Expected link revision.
   * @returns Stable unlink result.
   */
  async unlinkThread(
    context: ExternalChatLinkCommandContext,
    linkId: string,
    command: UnlinkExternalChatThreadInput,
  ): Promise<UnlinkExternalChatThreadResult> {
    validateContext(context)
    return this.withFailureAudit(context, 'unlink', { linkId, command }, {
      linkId: safeFailureIdentifier(linkId),
    }, async () => {
    validateUnlinkCommand(linkId, command)
    const current = await this.requireAuthorizedLink(context.principal, linkId, 'write')
    const operationId = createLinkCommandOperationId(context, 'unlink', { linkId, command })
    const audit = createAuditRecord(
      context,
      operationId,
      'unlink',
      current.link.teamId,
      current.link.workItemId,
      current.link.id,
      current.link.provider,
      current.sourceDigest,
      'applied',
      'ExternalChatLinkUnlinked',
    )
    const result = await this.transactions.unlinkLink({
      workspaceId: context.principal.workspaceId,
      linkId: current.link.id,
      expectedRevision: command.expectedRevision,
      unlinkedAt: context.occurredAt,
      actorMemberKey: context.principal.memberKey,
      idempotencyKeyHash: hashIdempotencyKey(context, 'unlink'),
      requestFingerprint: createExternalChatFingerprint({ linkId, command }),
      operationId,
      audit,
    })
    validateUnlinkTransactionResult(
      context,
      operationId,
      current.sourceDigest,
      current.link,
      result,
    )
    if (!result.record.unlinkedAt) invalidTransactionResult('external chat unlink timestamp')
    return { linkId: current.link.id, unlinkedAt: result.record.unlinkedAt }
    })
  }

  /**
   * Atomically marks a link pending and accepts an explicit resumable synchronization.
   *
   * @param context - Authenticated idempotent command context.
   * @param linkId - Link to resynchronize.
   * @param command - Expected revision and resume mode.
   * @returns Accepted resynchronization operation.
   */
  async resyncLink(
    context: ExternalChatLinkCommandContext,
    linkId: string,
    command: ResyncExternalChatWorkItemLinkInput,
  ): Promise<ResyncExternalChatWorkItemLinkResult> {
    validateContext(context)
    return this.withFailureAudit(context, 'resync', { linkId, command }, {
      linkId: safeFailureIdentifier(linkId),
    }, async () => {
    validateResyncCommand(linkId, command)
    const current = await this.requireAuthorizedLink(context.principal, linkId, 'write')
    if (!current.active) throw notFoundError()
    const installation = await this.access.resolveInstallation(
      context.principal,
      current.link.installationId,
      current.link.source.externalWorkspaceId,
      'read',
    )
    validateResolvedInstallation(
      current.link.installationId,
      current.link.source.externalWorkspaceId,
      installation,
    )
    if (installation.provider !== current.link.provider) {
      throw new ExternalChatError(
        'ExternalChatAuthorizationFailed',
        'The connector installation provider does not match the linked source.',
      )
    }
    if (installation.authorization.authorizationRevision < current.sourceAuthorizationRevision) {
      throw new ExternalChatError(
        'ExternalChatAuthorizationFailed',
        'The connector authorization generation is older than the linked source.',
      )
    }
    const parentLifecycleFences = await this.store.getParentLifecycleFences(
      context.principal.workspaceId,
      current.link.id,
    )
    if (parentLifecycleFences === undefined) throw notFoundError()
    const operationId = createLinkCommandOperationId(context, 'resync', { linkId, command })
    const replacement: ExternalChatWorkItemLink = {
      ...current.link,
      syncStatus: 'pending',
      revision: command.expectedRevision + 1,
      updatedAt: context.occurredAt,
    }
    const job: ExternalChatResyncJob = {
      workspaceId: context.principal.workspaceId,
      linkId: replacement.id,
      mode: command.mode,
      linkRevision: replacement.revision,
      authorizationRevision: installation.authorization.authorizationRevision,
      operationId,
      correlationId: context.correlationId,
      acceptedAt: context.occurredAt,
    }
    const audit = createAuditRecord(
      context,
      operationId,
      'resync',
      replacement.teamId,
      replacement.workItemId,
      replacement.id,
      replacement.provider,
      current.sourceDigest,
      'applied',
      command.mode === 'full' ? 'ExternalChatFullResyncQueued' : 'ExternalChatResumeQueued',
    )
    const result = await this.transactions.acceptResync({
      workspaceId: context.principal.workspaceId,
      link: replacement,
      expectedRevision: command.expectedRevision,
      expectedSourceAuthorizationRevision: current.sourceAuthorizationRevision,
      authorizationRevision: installation.authorization.authorizationRevision,
      expectedParentLifecycleFences: parentLifecycleFences,
      idempotencyKeyHash: hashIdempotencyKey(context, 'resync'),
      requestFingerprint: createExternalChatFingerprint({ linkId, command }),
      operationId,
      job,
      audit,
    })
    validateResyncTransactionResult(replacement, operationId, result)
    return {
      link: toExternalChatWorkItemLinkSummary(result.link),
      operationId: result.operationId,
      acceptedAt: result.acceptedAt,
    }
    })
  }

  /**
   * Atomically merges duplicate Work Items and every link-owned chat record.
   *
   * @param context - Authenticated idempotent command context.
   * @param command - Revision-fenced canonical/duplicate merge command.
   * @returns Canonical Work Item, moved links/files/bindings, and durable redirects.
   */
  async mergeDuplicateLinks(
    context: ExternalChatLinkCommandContext,
    command: MergeExternalChatWorkItemLinksInput,
  ): Promise<MergeExternalChatWorkItemLinksResult> {
    validateContext(context)
    return this.withFailureAudit(context, 'merge', command, {
      teamId: safeFailureIdentifier(command.canonicalTeamId),
      workItemId: safeFailureIdentifier(command.canonicalWorkItemId),
    }, async () => {
    validateMergeCommand(command)
    const duplicateRoute = await this.resolveCanonicalWorkItemRoute(
      context.principal.workspaceId,
      command.duplicateTeamId,
      command.duplicateWorkItemId,
    )
    await this.access.authorizeWorkItem(
      context.principal,
      command.canonicalTeamId,
      command.canonicalWorkItemId,
      'write',
    )
    await this.access.authorizeWorkItem(
      context.principal,
      duplicateRoute.teamId,
      duplicateRoute.workItemId,
      'write',
    )
    const duplicateLinkManifest = await this.store.getWorkItemLinkManifest(
      context.principal.workspaceId,
      command.duplicateTeamId,
      command.duplicateWorkItemId,
    )
    const expectedLinks = new Map<string, StoredExternalChatLink>()
    for (const candidate of command.links) {
      const record = await this.store.getLink(context.principal.workspaceId, candidate.linkId)
      if (record !== undefined) expectedLinks.set(candidate.linkId, record)
    }
    const operationId = createLinkCommandOperationId(context, 'merge', command)
    const storeMutation: MergeExternalChatLinksStoreInput = {
      workspaceId: context.principal.workspaceId,
      canonicalTeamId: command.canonicalTeamId,
      canonicalWorkItemId: command.canonicalWorkItemId,
      duplicateTeamId: command.duplicateTeamId,
      duplicateWorkItemId: command.duplicateWorkItemId,
      links: command.links,
      expectedDuplicateLinkGeneration: duplicateLinkManifest?.generation ?? 0,
      expectedDuplicateLinkCount: duplicateLinkManifest?.activeLinkCount ?? 0,
      mergedAt: context.occurredAt,
    }
    const audit = createAuditRecord(
      context,
      operationId,
      'merge',
      command.canonicalTeamId,
      command.canonicalWorkItemId,
      undefined,
      undefined,
      undefined,
      'applied',
      'ExternalChatMergeCompleted',
    )
    const result = await this.transactions.mergeWorkItemsAndLinks({
      principal: context.principal,
      command,
      storeMutation,
      operationId,
      idempotencyKeyHash: hashIdempotencyKey(context, 'merge'),
      requestFingerprint: createExternalChatFingerprint(command),
      audit,
    })
    const canonicalWorkItem = validateMergeTransactionResult(command, expectedLinks, result)
    return {
      canonicalWorkItem,
      movedLinks: result.movedLinks.map(toExternalChatWorkItemLinkSummary),
      redirects: uniqueCanonicalRoutes(result.redirects),
      movedFileCount: result.movedFileCount,
      movedMessageBindingCount: result.movedMessageBindingCount,
      mergedAt: result.mergedAt,
    }
    })
  }

  /**
   * Records one secret-free failed command outcome without weakening successful transaction audit.
   *
   * @param context - Validated authenticated command context.
   * @param action - Stable command namespace.
   * @param payload - Complete command payload used only for a one-way operation fingerprint.
   * @param scope - Safely known canonical identifiers available before execution.
   * @param execute - Authorized command execution callback.
   * @returns Successful command result.
   */
  private async withFailureAudit<T>(
    context: ExternalChatLinkCommandContext,
    action: ExternalChatLinkAuditRecord['action'],
    payload: unknown,
    scope: ExternalChatLinkFailureAuditScope,
    execute: () => Promise<T>,
  ): Promise<T> {
    try {
      return await execute()
    } catch (error: unknown) {
      try {
        await this.failureAudit.record({
          workspaceId: context.principal.workspaceId,
          actorMemberKey: context.principal.memberKey,
          correlationId: context.correlationId,
          operationId: createLinkCommandOperationId(context, action, payload),
          action,
          ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }),
          ...(scope.workItemId === undefined ? {} : { workItemId: scope.workItemId }),
          ...(scope.linkId === undefined ? {} : { linkId: scope.linkId }),
          outcome: 'failed',
          reasonCode: linkCommandFailureReason(error),
          occurredAt: context.occurredAt,
        })
      } catch (auditError: unknown) {
        console.error('external chat command failure audit failed', {
          correlationId: context.correlationId,
          action,
          errorCode: linkCommandFailureReason(auditError),
        })
      }
      throw error
    }
  }

  /**
   * Resolves a former duplicate route only after authorizing the canonical target.
   *
   * @param principal - Authenticated caller.
   * @param formerTeamId - Former duplicate Team identifier.
   * @param formerWorkItemId - Former duplicate Work Item identifier.
   * @returns Authorized canonical redirect when one exists.
   */
  async resolveCanonicalRedirect(
    principal: ExternalChatLinkPrincipal,
    formerTeamId: string,
    formerWorkItemId: string,
  ): Promise<ExternalChatCanonicalRoute | undefined> {
    requireIdentifier(principal.workspaceId)
    requireIdentifier(principal.memberKey)
    const fromTeamId = requireIdentifier(formerTeamId)
    const fromWorkItemId = requireIdentifier(formerWorkItemId)
    const route = await this.resolveCanonicalWorkItemRoute(
      principal.workspaceId,
      fromTeamId,
      fromWorkItemId,
    )
    if (route.teamId === fromTeamId && route.workItemId === fromWorkItemId) return undefined
    await this.access.authorizeWorkItem(
      principal,
      route.teamId,
      route.workItemId,
      'read',
    )
    return {
      fromTeamId,
      fromWorkItemId,
      canonicalTeamId: route.teamId,
      canonicalWorkItemId: route.workItemId,
      createdAt: route.createdAt,
    }
  }

  /**
   * Resolves a source with current installation and provider permissions.
   *
   * @param principal - Authenticated caller.
   * @param installationId - Connector installation identifier.
   * @param source - Provider-neutral source locator.
   * @returns Authorized provider and permission-filtered thread snapshot.
   */
  private async resolveSource(
    principal: ExternalChatLinkPrincipal,
    installationId: string,
    source: LinkExternalChatThreadInput['source'],
  ): Promise<{
    /** Provider resolved from the installation. */
    provider: ExternalChatProvider
    /** Provider authorization generation current when the source was resolved. */
    authorizationRevision: number
    /** Permission-filtered thread snapshot. */
    thread: ExternalChatThreadSnapshot
  }> {
    const installation = await this.access.resolveInstallation(
      principal,
      requireIdentifier(installationId),
      requireIdentifier(source.externalWorkspaceId),
      'write',
    )
    validateResolvedInstallation(installationId, source.externalWorkspaceId, installation)
    const adapter = this.adapters.get(installation.provider)
    const thread = normalizeChatProviderThreadSnapshot(
      await adapter.resolveThread(
        installation.authorization,
        source,
      ),
      adapter.definition.permalinkHosts,
    )
    validateResolvedThread(installation.provider, source, thread)
    return {
      provider: installation.provider,
      authorizationRevision: installation.authorization.authorizationRevision,
      thread,
    }
  }

  /**
   * Follows durable former-duplicate redirects to an authorized Work Item route.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param teamId - Starting Team identifier.
   * @param workItemId - Starting Work Item identifier.
   * @returns Terminal route and the first redirect timestamp.
   * @throws ExternalChatError when a redirect cycle or unbounded chain is stored.
   */
  private async resolveCanonicalWorkItemRoute(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<ExternalChatCanonicalWorkItemRoute> {
    let currentTeamId = teamId
    let currentWorkItemId = workItemId
    let createdAt: string | undefined
    const seen = new Set<string>()
    for (let hop = 0; hop < MAX_CANONICAL_REDIRECT_HOPS; hop += 1) {
      const identity = `${currentTeamId}\u0000${currentWorkItemId}`
      if (seen.has(identity)) {
        throw new ExternalChatError(
          'ExternalChatPersistenceFailed',
          'The external chat canonical redirect graph contains a cycle.',
        )
      }
      seen.add(identity)
      const redirect = await this.store.getCanonicalRedirect(
        workspaceId,
        currentTeamId,
        currentWorkItemId,
      )
      if (!redirect) {
        return {
          teamId: currentTeamId,
          workItemId: currentWorkItemId,
          createdAt: createdAt ?? '',
        }
      }
      createdAt ??= redirect.createdAt
      currentTeamId = redirect.canonicalTeamId
      currentWorkItemId = redirect.canonicalWorkItemId
    }
    throw new ExternalChatError(
      'ExternalChatPersistenceFailed',
      'The external chat canonical redirect chain exceeded its safety bound.',
    )
  }

  /**
   * Loads a tenant-scoped link and authorizes its current Work Item.
   *
   * @param principal - Authenticated caller.
   * @param linkId - Link to load.
   * @param mode - Required Work Item capability.
   * @returns Authorized stored link.
   */
  private async requireAuthorizedLink(
    principal: ExternalChatLinkPrincipal,
    linkId: string,
    mode: 'read' | 'write',
  ) {
    const current = await this.store.getLink(principal.workspaceId, requireIdentifier(linkId))
    if (!current) throw notFoundError()
    await this.access.authorizeWorkItem(
      principal,
      current.link.teamId,
      current.link.workItemId,
      mode,
    )
    return current
  }
}

/** Terminal Work Item route obtained after bounded canonical redirect resolution. */
type ExternalChatCanonicalWorkItemRoute = {
  /** Team that owns the terminal Work Item. */
  teamId: string
  /** Terminal Work Item identifier. */
  workItemId: string
  /** First redirect creation timestamp, or an empty value for an active route. */
  createdAt: string
}

/** Maximum number of canonical redirect hops followed by one authorization check. */
const MAX_CANONICAL_REDIRECT_HOPS = 16

/**
 * Verifies that a cross-domain create transaction returned the exact authorized link scope.
 *
 * @param context - Authenticated command context supplied to the transaction.
 * @param command - Authorized create command.
 * @param linkDraft - Exact link fields supplied before Work Item identity assignment.
 * @param result - Transaction result to verify before audit or response projection.
 * @param permalinkHosts - Provider-owned host allowlist declared by the selected adapter.
 */
function validateCreateWorkItemTransactionResult(
  context: ExternalChatLinkCommandContext,
  command: CreateWorkItemFromExternalChatThreadInput,
  linkDraft: Omit<ExternalChatWorkItemLink, 'workItemId'>,
  result: CreateWorkItemFromExternalChatThreadResult,
  permalinkHosts: readonly string[],
): CanonicalWorkItem {
  const workItem = normalizeCanonicalWorkItemResult(result.workItem)
  requireValidTransactionWorkItemScope(
    workItem.id,
    workItem.teamId,
    workItem.revision,
    command.teamId,
  )
  if (workItem.creatorMemberKey !== context.principal.memberKey) {
    invalidTransactionResult('created Work Item actor scope')
  }
  validateInitialLinkTransactionResult(
    linkDraft,
    workItem.id,
    result.link,
    permalinkHosts,
  )
  return workItem
}

/**
 * Verifies that an existing-Work-Item transaction returned the exact requested link.
 *
 * @param command - Authorized existing Work Item link command.
 * @param expectedLink - Exact link supplied to the transaction.
 * @param result - Transaction result to verify.
 * @param permalinkHosts - Provider-owned host allowlist declared by the selected adapter.
 */
function validateLinkTransactionResult(
  command: LinkExternalChatThreadInput,
  expectedLink: ExternalChatWorkItemLink,
  result: LinkExternalChatThreadResult,
  permalinkHosts: readonly string[],
): void {
  if (result.link.teamId !== command.teamId || result.link.workItemId !== command.workItemId) {
    invalidTransactionResult('existing Work Item external chat link scope')
  }
  const linkDraft = omitWorkItemId(expectedLink)
  validateInitialLinkTransactionResult(
    linkDraft,
    command.workItemId,
    result.link,
    permalinkHosts,
  )
}

/**
 * Verifies an initial link while treating first-commit metadata and timestamps as receipt-owned.
 *
 * A command retry may resolve fresher provider display metadata or carry a later request timestamp.
 * The transaction must replay its first committed snapshot, while stable tenant, installation,
 * provider, source, owner, and synchronization fields must still match the authorized command.
 *
 * @param expectedDraft - Stable command-owned link fields before Work Item assignment.
 * @param expectedWorkItemId - Work Item authorized or created by the transaction.
 * @param returnedLink - First-commit link returned directly or from an idempotency receipt.
 * @param permalinkHosts - Provider-owned host allowlist declared by the selected adapter.
 */
function validateInitialLinkTransactionResult(
  expectedDraft: Omit<ExternalChatWorkItemLink, 'workItemId'>,
  expectedWorkItemId: string,
  returnedLink: ExternalChatWorkItemLink,
  permalinkHosts: readonly string[],
): void {
  if (
    returnedLink.workItemId !== expectedWorkItemId ||
    returnedLink.workspace.provider !== expectedDraft.workspace.provider ||
    returnedLink.workspace.externalId !== expectedDraft.workspace.externalId ||
    returnedLink.conversation.externalId !== expectedDraft.conversation.externalId ||
    returnedLink.conversation.externalWorkspaceId !==
      expectedDraft.conversation.externalWorkspaceId ||
    returnedLink.conversation.kind !== expectedDraft.conversation.kind ||
    !isCanonicalTimestamp(returnedLink.lastSourceObservedAt) ||
    !isCanonicalTimestamp(returnedLink.createdAt) ||
    !isCanonicalTimestamp(returnedLink.updatedAt) ||
    returnedLink.lastSourceObservedAt !== returnedLink.createdAt ||
    returnedLink.updatedAt !== returnedLink.createdAt
  ) {
    invalidTransactionResult('initial external chat link scope')
  }
  const normalizedSnapshot = normalizeChatProviderThreadSnapshot({
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    workspace: returnedLink.workspace,
    conversation: returnedLink.conversation,
    externalId: returnedLink.source.threadExternalId,
    rootMessageExternalId: returnedLink.source.rootMessageExternalId,
    ...(returnedLink.source.sourcePermalink === undefined
      ? {}
      : { permalink: returnedLink.source.sourcePermalink }),
    availability: returnedLink.sourceAvailability,
    state: returnedLink.sourceState,
    messages: [],
    hasMoreMessages: false,
    createdAt: returnedLink.createdAt,
    updatedAt: returnedLink.updatedAt,
  }, permalinkHosts)
  if (
    createExternalChatFingerprint(normalizedSnapshot.workspace) !==
      createExternalChatFingerprint(returnedLink.workspace) ||
    createExternalChatFingerprint(normalizedSnapshot.conversation) !==
      createExternalChatFingerprint(returnedLink.conversation)
  ) {
    invalidTransactionResult('initial external chat link metadata')
  }
  const receiptOwnedExpectedLink: ExternalChatWorkItemLink = {
    ...expectedDraft,
    workItemId: expectedWorkItemId,
    workspace: returnedLink.workspace,
    conversation: returnedLink.conversation,
    sourceAvailability: returnedLink.sourceAvailability,
    sourceState: returnedLink.sourceState,
    lastSourceObservedAt: returnedLink.lastSourceObservedAt,
    createdAt: returnedLink.createdAt,
    updatedAt: returnedLink.updatedAt,
  }
  if (
    createExternalChatFingerprint(returnedLink) !==
      createExternalChatFingerprint(receiptOwnedExpectedLink)
  ) {
    invalidTransactionResult('initial external chat link state')
  }
}

/**
 * Removes the Work Item identifier from an exact initial link without an assertion.
 *
 * @param link - Complete initial link.
 * @returns Initial link draft expected by the create/link receipt validator.
 */
function omitWorkItemId(
  link: ExternalChatWorkItemLink,
): Omit<ExternalChatWorkItemLink, 'workItemId'> {
  return {
    schemaVersion: link.schemaVersion,
    id: link.id,
    teamId: link.teamId,
    installationId: link.installationId,
    provider: link.provider,
    workspace: link.workspace,
    conversation: link.conversation,
    source: link.source,
    syncDirection: link.syncDirection,
    syncStatus: link.syncStatus,
    sourceAvailability: link.sourceAvailability,
    sourceState: link.sourceState,
    revision: link.revision,
    ...(link.lastSyncedAt === undefined ? {} : { lastSyncedAt: link.lastSyncedAt }),
    ...(link.lastSourceObservedAt === undefined
      ? {}
      : { lastSourceObservedAt: link.lastSourceObservedAt }),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  }
}

/**
 * Verifies that an update receipt remains active, scoped, and exactly one revision ahead.
 *
 * The transaction owns the first-commit timestamp so response-loss replays may return that
 * original value even when request metadata is reconstructed.
 *
 * @param context - Authenticated command context.
 * @param operationId - Stable operation supplied to the transaction.
 * @param expectedLink - Exact semantic replacement supplied to the transaction.
 * @param expectedSourceDigest - Source ownership digest read before dispatch.
 * @param result - Transaction result to verify before response projection.
 */
function validateUpdateTransactionResult(
  context: ExternalChatLinkCommandContext,
  operationId: string,
  expectedLink: ExternalChatWorkItemLink,
  expectedSourceDigest: string,
  result: unknown,
): void {
  if (!isTransactionRecord(result) || !isTransactionRecord(result.record)) {
    invalidTransactionResult('external chat link update receipt shape')
  }
  const record = result.record
  if (!isTransactionRecord(record.link)) {
    invalidTransactionResult('external chat link update receipt shape')
  }
  const returnedLink = record.link
  if (
    result.operationId !== operationId ||
    record.workspaceId !== context.principal.workspaceId ||
    record.sourceDigest !== expectedSourceDigest ||
    record.active !== true ||
    record.unlinkedAt !== undefined ||
    returnedLink.revision !== expectedLink.revision ||
    typeof returnedLink.updatedAt !== 'string' ||
    !isCanonicalTimestamp(returnedLink.updatedAt)
  ) {
    invalidTransactionResult('external chat link update receipt scope')
  }
  const timestampOwnedExpectedLink: ExternalChatWorkItemLink = {
    ...expectedLink,
    updatedAt: returnedLink.updatedAt,
  }
  if (
    createExternalChatFingerprint(returnedLink) !==
      createExternalChatFingerprint(timestampOwnedExpectedLink)
  ) {
    invalidTransactionResult('external chat link update state')
  }
}

/**
 * Verifies that an unlink receipt is inactive and retains the exact authorized link scope.
 *
 * @param context - Authenticated command context.
 * @param operationId - Stable operation supplied to the transaction.
 * @param expectedSourceDigest - Source ownership digest read before dispatch.
 * @param expectedLink - Exact link state selected for unlinking.
 * @param result - Transaction result to verify before response projection.
 */
function validateUnlinkTransactionResult(
  context: ExternalChatLinkCommandContext,
  operationId: string,
  expectedSourceDigest: string,
  expectedLink: ExternalChatWorkItemLink,
  result: unknown,
): void {
  if (!isTransactionRecord(result) || !isTransactionRecord(result.record)) {
    invalidTransactionResult('external chat unlink receipt shape')
  }
  const record = result.record
  if (!isTransactionRecord(record.link)) {
    invalidTransactionResult('external chat unlink receipt shape')
  }
  if (
    result.operationId !== operationId ||
    record.workspaceId !== context.principal.workspaceId ||
    record.sourceDigest !== expectedSourceDigest ||
    record.active !== false ||
    typeof record.unlinkedAt !== 'string' ||
    !isCanonicalTimestamp(record.unlinkedAt) ||
    createExternalChatFingerprint(record.link) !==
      createExternalChatFingerprint(expectedLink)
  ) {
    invalidTransactionResult('external chat unlink receipt scope')
  }
}

/**
 * Narrows an untrusted transaction result layer without accepting arrays or null.
 *
 * @param value - Candidate result layer.
 * @returns Whether named properties can be inspected safely.
 */
function isTransactionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Verifies resynchronization receipt ownership before exposing its accepted operation.
 *
 * @param expectedLink - Pending link state supplied to the transaction.
 * @param operationId - Stable operation supplied to the transaction and outbox.
 * @param result - Transaction result to verify.
 */
function validateResyncTransactionResult(
  expectedLink: ExternalChatWorkItemLink,
  operationId: string,
  result: ResyncExternalChatWorkItemLinkResult,
): void {
  const returnedUpdatedAt = result.link.updatedAt
  const expectedSummary = toExternalChatWorkItemLinkSummary({
    ...expectedLink,
    updatedAt: returnedUpdatedAt,
  })
  if (
    result.operationId !== operationId ||
    !isCanonicalTimestamp(result.acceptedAt) ||
    !isCanonicalTimestamp(returnedUpdatedAt) ||
    result.acceptedAt !== returnedUpdatedAt ||
    createExternalChatFingerprint(toExternalChatWorkItemLinkSummary(result.link)) !==
      createExternalChatFingerprint(expectedSummary)
  ) {
    invalidTransactionResult('external chat resynchronization receipt scope')
  }
}

/**
 * Verifies canonical ownership, revisions, counts, and redirects returned by a merge transaction.
 *
 * @param command - Authorized revision-fenced duplicate merge.
 * @param expectedLinks - Strongly read link identities used to validate provider redirects.
 * @param result - Cross-domain merge result to verify before response projection.
 */
function validateMergeTransactionResult(
  command: MergeExternalChatWorkItemLinksInput,
  expectedLinks: ReadonlyMap<string, StoredExternalChatLink>,
  result: MergeWorkItemsAndExternalChatLinksTransactionResult,
): CanonicalWorkItem {
  const canonicalWorkItem = normalizeCanonicalWorkItemResult(result.canonicalWorkItem)
  requireValidTransactionWorkItemScope(
    canonicalWorkItem.id,
    canonicalWorkItem.teamId,
    canonicalWorkItem.revision,
    command.canonicalTeamId,
  )
  if (
    canonicalWorkItem.id !== command.canonicalWorkItemId ||
    canonicalWorkItem.revision <= command.expectedCanonicalWorkItemRevision ||
    !isCanonicalTimestamp(result.mergedAt) ||
    !Number.isSafeInteger(result.movedFileCount) ||
    result.movedFileCount < 0 ||
    !Number.isSafeInteger(result.movedMessageBindingCount) ||
    result.movedMessageBindingCount < 0
  ) {
    invalidTransactionResult('external chat duplicate merge result')
  }
  const candidates = new Map(command.links.map((candidate) => [candidate.linkId, candidate]))
  if (result.movedLinks.length !== candidates.size || expectedLinks.size !== candidates.size) {
    invalidTransactionResult('external chat duplicate merge link count')
  }
  const movedIds = new Set<string>()
  for (const rawLink of result.movedLinks) {
    const link = normalizeExternalChatLinkSummaryResult(rawLink)
    const candidate = candidates.get(link.id)
    const expected = expectedLinks.get(link.id)
    if (
      !candidate ||
      !expected ||
      movedIds.has(link.id) ||
      link.teamId !== command.canonicalTeamId ||
      link.workItemId !== command.canonicalWorkItemId ||
      link.provider !== expected.link.provider ||
      link.revision !== candidate.expectedRevision + 1
    ) {
      invalidTransactionResult('external chat duplicate merge link ownership')
    }
    movedIds.add(link.id)
  }
  if (result.redirects.length !== candidates.size) {
    invalidTransactionResult('external chat duplicate merge redirect count')
  }
  const redirectedIds = new Set<string>()
  for (const redirect of result.redirects) {
    const expected = expectedLinks.get(redirect.linkId)
    if (
      !expected ||
      !movedIds.has(redirect.linkId) ||
      redirectedIds.has(redirect.linkId) ||
      redirect.provider !== expected.link.provider ||
      redirect.threadExternalId !== expected.link.source.threadExternalId ||
      redirect.fromTeamId !== command.duplicateTeamId ||
      redirect.fromWorkItemId !== command.duplicateWorkItemId ||
      redirect.canonicalTeamId !== command.canonicalTeamId ||
      redirect.canonicalWorkItemId !== command.canonicalWorkItemId ||
      redirect.createdAt !== result.mergedAt
    ) {
      invalidTransactionResult('external chat duplicate merge redirect scope')
    }
    redirectedIds.add(redirect.linkId)
  }
  if (redirectedIds.size !== movedIds.size) {
    invalidTransactionResult('external chat duplicate merge redirect set')
  }
  return canonicalWorkItem
}

/**
 * Deeply validates and allowlists one source-redacted link transaction result.
 *
 * @param value - Untrusted moved-link result layer.
 * @returns Exact source-redacted link summary.
 */
function normalizeExternalChatLinkSummaryResult(value: unknown): ExternalChatWorkItemLinkSummary {
  if (!isTransactionRecord(value)) invalidTransactionResult('external chat link summary shape')
  if (
    value.schemaVersion !== EXTERNAL_CHAT_SCHEMA_VERSION ||
    !isBoundedResultIdentifier(value.id) ||
    !isBoundedResultIdentifier(value.teamId) ||
    !isBoundedResultIdentifier(value.workItemId) ||
    (value.provider !== 'slack' && value.provider !== 'microsoft-teams') ||
    (value.syncDirection !== 'inbound' &&
      value.syncDirection !== 'outbound' &&
      value.syncDirection !== 'bidirectional' &&
      value.syncDirection !== 'none') ||
    (value.syncStatus !== 'pending' &&
      value.syncStatus !== 'synced' &&
      value.syncStatus !== 'conflict' &&
      value.syncStatus !== 'failed' &&
      value.syncStatus !== 'paused') ||
    (value.sourceAvailability !== 'available' &&
      value.sourceAvailability !== 'temporarily-unavailable' &&
      value.sourceAvailability !== 'installation-disconnected' &&
      value.sourceAvailability !== 'needs-reauth' &&
      value.sourceAvailability !== 'scope-changed' &&
      value.sourceAvailability !== 'permission-lost') ||
    (value.sourceState !== 'active' &&
      value.sourceState !== 'completed' &&
      value.sourceState !== 'deleted' &&
      value.sourceState !== 'retained-metadata' &&
      value.sourceState !== 'retention-expired') ||
    !isPositiveSafeInteger(value.revision) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) invalidTransactionResult('external chat link summary fields')
  const lastSyncedAt = readOptionalResultTimestamp(value.lastSyncedAt)
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    id: value.id,
    teamId: value.teamId,
    workItemId: value.workItemId,
    provider: value.provider,
    syncDirection: value.syncDirection,
    syncStatus: value.syncStatus,
    sourceAvailability: value.sourceAvailability,
    sourceState: value.sourceState,
    revision: value.revision,
    ...(lastSyncedAt === undefined ? {} : { lastSyncedAt }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/**
 * Deeply validates and allowlists a transaction-owned canonical Work Item API result.
 *
 * @param value - Untrusted cross-domain transaction result layer.
 * @returns Exact canonical Work Item without unknown persistence or legacy fields.
 */
function normalizeCanonicalWorkItemResult(value: unknown): CanonicalWorkItem {
  if (!isTransactionRecord(value)) invalidTransactionResult('canonical Work Item shape')
  if (
    value.schemaVersion !== WORK_ITEM_SCHEMA_VERSION ||
    value.workflowSchemaVersion !== WORK_ITEM_CONFIGURATION_SCHEMA_VERSION ||
    value.source !== 'dynamodb' ||
    !isPositiveSafeInteger(value.revision) ||
    !isBoundedResultIdentifier(value.id) ||
    !isBoundedResultIdentifier(value.teamId) ||
    !isBoundedResultText(value.title, 16_384) ||
    !isBoundedResultIdentifier(value.assigneeUserId) ||
    !isBoundedResultIdentifier(value.creatorMemberKey) ||
    !isBoundedResultIdentifier(value.workflowStatusId) ||
    !isCanonicalWorkItemSchedule(value.schedule) ||
    typeof value.dueDate !== 'string' ||
    value.dueDate !== deriveWorkItemScheduleDueDate(value.schedule) ||
    (value.priority !== 'high' && value.priority !== 'medium' && value.priority !== 'low') ||
    (value.statusCategory !== 'backlog' &&
      value.statusCategory !== 'unstarted' &&
      value.statusCategory !== 'started' &&
      value.statusCategory !== 'completed' &&
      value.statusCategory !== 'canceled') ||
    !isCanonicalWorkItemRelationIds(value.relationIds) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) invalidTransactionResult('canonical Work Item fields')
  const description = readOptionalResultText(value.description, 262_144)
  const assignedProjectId = readOptionalResultIdentifier(value.assignedProjectId)
  const assigneeEmail = readOptionalResultText(value.assigneeEmail, 4_096)
  const assigneeName = readOptionalResultText(value.assigneeName, 4_096)
  const sourceRequestId = readOptionalResultIdentifier(value.sourceRequestId)
  const workItemTypeId = readOptionalResultIdentifier(value.workItemTypeId)
  const archivedAt = readOptionalResultTimestamp(value.archivedAt)
  const archivedBy = readOptionalResultIdentifier(value.archivedBy)
  if ((archivedAt === undefined) !== (archivedBy === undefined)) {
    invalidTransactionResult('canonical Work Item archive fields')
  }
  const priorityUpdatedAt = readOptionalCausalResultTimestamp(
    value.priorityUpdatedAt,
    value.createdAt,
    value.updatedAt,
  )
  const dueDateUpdatedAt = readOptionalCausalResultTimestamp(
    value.dueDateUpdatedAt,
    value.createdAt,
    value.updatedAt,
  )
  const approvalSummary = normalizeApprovalSummary(value.approvalSummary, value.createdAt)
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: value.revision,
    id: value.id,
    teamId: value.teamId,
    ...(assignedProjectId === undefined ? {} : { assignedProjectId }),
    title: value.title,
    ...(description === undefined ? {} : { description }),
    assigneeUserId: value.assigneeUserId,
    ...(assigneeEmail === undefined ? {} : { assigneeEmail }),
    ...(assigneeName === undefined ? {} : { assigneeName }),
    creatorMemberKey: value.creatorMemberKey,
    ...(sourceRequestId === undefined ? {} : { sourceRequestId }),
    dueDate: value.dueDate,
    schedule: value.schedule,
    priority: value.priority,
    ...(priorityUpdatedAt === undefined ? {} : { priorityUpdatedAt }),
    ...(dueDateUpdatedAt === undefined ? {} : { dueDateUpdatedAt }),
    workflowStatusId: value.workflowStatusId,
    ...(workItemTypeId === undefined ? {} : { workItemTypeId }),
    statusCategory: value.statusCategory,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: normalizeCustomFieldValues(value.customFieldValues),
    relationIds: [...value.relationIds],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(archivedBy === undefined ? {} : { archivedBy }),
    ...(approvalSummary === undefined ? {} : { approvalSummary }),
    source: 'dynamodb',
  }
}

/**
 * Deeply validates and copies canonical custom field values.
 *
 * @param value - Candidate custom field dictionary.
 * @returns Exact bounded custom field dictionary.
 */
function normalizeCustomFieldValues(value: unknown): Record<string, CustomFieldValue> {
  if (!isTransactionRecord(value)) invalidTransactionResult('canonical custom field values')
  const entries = Object.entries(value)
  if (entries.length > 100) invalidTransactionResult('canonical custom field values')
  const normalized: Record<string, CustomFieldValue> = {}
  for (const [fieldId, fieldValue] of entries) {
    if (!isBoundedResultIdentifier(fieldId) || !isCustomFieldValue(fieldValue)) {
      invalidTransactionResult('canonical custom field values')
    }
    normalized[fieldId] = Array.isArray(fieldValue) ? [...fieldValue] : fieldValue
  }
  return normalized
}

/** Checks one bounded canonical custom field value. */
function isCustomFieldValue(value: unknown): value is CustomFieldValue {
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return isBoundedResultText(value, 65_536)
  return Array.isArray(value) &&
    value.length <= 100 &&
    value.every((item) => isBoundedResultText(item, 65_536))
}

/**
 * Deeply validates and copies an optional Work Item approval summary.
 *
 * @param value - Candidate optional approval summary.
 * @param workItemCreatedAt - Canonical creation boundary for approval activity.
 * @returns Exact summary or undefined.
 */
function normalizeApprovalSummary(
  value: unknown,
  workItemCreatedAt: string,
): ApprovalSummary | undefined {
  if (value === undefined) return undefined
  if (!isTransactionRecord(value)) invalidTransactionResult('canonical approval summary')
  if (
    !isNonNegativeSafeInteger(value.pendingCount) ||
    !isNonNegativeSafeInteger(value.overdueCount) ||
    !isNonNegativeSafeInteger(value.approvedCount) ||
    !isNonNegativeSafeInteger(value.rejectedCount) ||
    !isNonNegativeSafeInteger(value.changesRequestedCount)
  ) invalidTransactionResult('canonical approval summary')
  const nextDueAt = readOptionalResultTimestamp(value.nextDueAt)
  const pendingDueAt = readOptionalResultTimestampArray(value.pendingDueAt)
  const updatedAt = readOptionalResultTimestamp(value.updatedAt)
  if (
    updatedAt !== undefined &&
    Date.parse(updatedAt) < Date.parse(workItemCreatedAt)
  ) {
    invalidTransactionResult('canonical approval summary timestamp')
  }
  return {
    pendingCount: value.pendingCount,
    overdueCount: value.overdueCount,
    approvedCount: value.approvedCount,
    rejectedCount: value.rejectedCount,
    changesRequestedCount: value.changesRequestedCount,
    ...(nextDueAt === undefined ? {} : { nextDueAt }),
    ...(pendingDueAt === undefined ? {} : { pendingDueAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/** Checks one positive safe integer. */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Checks one nonnegative safe integer. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Checks one bounded transaction result identifier. */
function isBoundedResultIdentifier(value: unknown): value is string {
  return isBoundedResultText(value, 512) && value.trim() === value && !/\p{Cc}/u.test(value)
}

/** Checks one bounded transaction result string. */
function isBoundedResultText(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
}

/** Reads one optional bounded transaction result identifier. */
function readOptionalResultIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isBoundedResultIdentifier(value)) invalidTransactionResult('canonical Work Item identifier')
  return value
}

/** Reads one optional bounded transaction result string. */
function readOptionalResultText(value: unknown, maximumBytes: number): string | undefined {
  if (value === undefined) return undefined
  if (!isBoundedResultText(value, maximumBytes)) {
    invalidTransactionResult('canonical Work Item text')
  }
  return value
}

/** Reads one optional canonical transaction result timestamp. */
function readOptionalResultTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isCanonicalTimestamp(value)) invalidTransactionResult('canonical Work Item timestamp')
  return value
}

/** Reads one optional array of canonical transaction result timestamps. */
function readOptionalResultTimestampArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) invalidTransactionResult('canonical Work Item timestamp list')
  const timestamps: string[] = []
  for (const entry of value) {
    if (!isCanonicalTimestamp(entry)) {
      invalidTransactionResult('canonical Work Item timestamp list')
    }
    timestamps.push(entry)
  }
  return timestamps
}

/**
 * Reads one optional field-specific timestamp inside a canonical Work Item lifetime.
 *
 * @param value - Candidate causal timestamp.
 * @param createdAt - Canonical Work Item creation timestamp.
 * @param updatedAt - Canonical Work Item aggregate update timestamp.
 * @returns Exact causal timestamp or undefined.
 */
function readOptionalCausalResultTimestamp(
  value: unknown,
  createdAt: string,
  updatedAt: string,
): string | undefined {
  const timestamp = readOptionalResultTimestamp(value)
  if (
    timestamp !== undefined &&
    (
      Date.parse(timestamp) < Date.parse(createdAt) ||
      Date.parse(timestamp) > Date.parse(updatedAt)
    )
  ) {
    invalidTransactionResult('canonical Work Item causal timestamp')
  }
  return timestamp
}

/**
 * Requires a transaction-owned Work Item to stay within its authorized Team and revision domain.
 *
 * @param workItemId - Returned canonical Work Item identifier.
 * @param teamId - Returned canonical Team identifier.
 * @param revision - Returned canonical Work Item revision.
 * @param expectedTeamId - Team authorized before transaction dispatch.
 */
function requireValidTransactionWorkItemScope(
  workItemId: string,
  teamId: string,
  revision: number,
  expectedTeamId: string,
): void {
  if (
    workItemId.length === 0 ||
    workItemId.length > 512 ||
    teamId !== expectedTeamId ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    invalidTransactionResult('canonical Work Item scope')
  }
}

/** Raises a fail-closed error for an inconsistent trusted transaction adapter. */
function invalidTransactionResult(label: string): never {
  throw new ExternalChatError(
    'ExternalChatPersistenceFailed',
    `The ${label} returned by the external chat transaction is invalid.`,
  )
}

/**
 * Removes installation and provider-scoped source metadata from one link.
 *
 * @param link - Durable link visible at a trusted application boundary.
 * @returns Link state safe after Work Item authorization alone.
 */
function toExternalChatWorkItemLinkSummary(
  link: ExternalChatWorkItemLinkSummary,
): ExternalChatWorkItemLinkSummary {
  return {
    schemaVersion: link.schemaVersion,
    id: link.id,
    teamId: link.teamId,
    workItemId: link.workItemId,
    provider: link.provider,
    syncDirection: link.syncDirection,
    syncStatus: link.syncStatus,
    sourceAvailability: link.sourceAvailability,
    sourceState: link.sourceState,
    revision: link.revision,
    ...(link.lastSyncedAt === undefined ? {} : { lastSyncedAt: link.lastSyncedAt }),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  }
}

/**
 * Constructs an exact public link DTO without forwarding unknown runtime properties.
 *
 * @param link - Trusted durable or transaction link result.
 * @returns Exact provider-neutral link DTO.
 */
function toExternalChatWorkItemLink(link: ExternalChatWorkItemLink): ExternalChatWorkItemLink {
  return {
    schemaVersion: link.schemaVersion,
    id: link.id,
    teamId: link.teamId,
    workItemId: link.workItemId,
    installationId: link.installationId,
    provider: link.provider,
    workspace: copyExternalChatWorkspace(link.workspace),
    conversation: copyExternalChatConversation(link.conversation),
    source: copyExternalChatThreadReference(link.source),
    syncDirection: link.syncDirection,
    syncStatus: link.syncStatus,
    sourceAvailability: link.sourceAvailability,
    sourceState: link.sourceState,
    revision: link.revision,
    ...(link.lastSyncedAt === undefined ? {} : { lastSyncedAt: link.lastSyncedAt }),
    ...(link.lastSourceObservedAt === undefined
      ? {}
      : { lastSourceObservedAt: link.lastSourceObservedAt }),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  }
}

/**
 * Constructs an exact provider Workspace snapshot.
 *
 * @param workspace - Provider-normalized Workspace metadata.
 * @returns Exact Workspace DTO without unknown properties.
 */
function copyExternalChatWorkspace(
  workspace: ExternalChatWorkItemLink['workspace'],
): ExternalChatWorkItemLink['workspace'] {
  return {
    provider: workspace.provider,
    externalId: workspace.externalId,
    ...(workspace.displayName === undefined ? {} : { displayName: workspace.displayName }),
    ...(workspace.permalink === undefined ? {} : { permalink: workspace.permalink }),
  }
}

/**
 * Constructs an exact provider conversation snapshot.
 *
 * @param conversation - Provider-normalized conversation metadata.
 * @returns Exact conversation DTO without unknown properties.
 */
function copyExternalChatConversation(
  conversation: ExternalChatWorkItemLink['conversation'],
): ExternalChatWorkItemLink['conversation'] {
  return {
    externalId: conversation.externalId,
    externalWorkspaceId: conversation.externalWorkspaceId,
    kind: conversation.kind,
    ...(conversation.displayName === undefined
      ? {}
      : { displayName: conversation.displayName }),
    ...(conversation.permalink === undefined ? {} : { permalink: conversation.permalink }),
  }
}

/**
 * Constructs an exact persisted provider thread reference.
 *
 * @param source - Validated command or durable thread reference.
 * @returns Exact source DTO without unknown properties.
 */
function copyExternalChatThreadReference(
  source: ExternalChatWorkItemLink['source'],
): ExternalChatWorkItemLink['source'] {
  return {
    externalWorkspaceId: source.externalWorkspaceId,
    conversationExternalId: source.conversationExternalId,
    threadExternalId: source.threadExternalId,
    rootMessageExternalId: source.rootMessageExternalId,
    ...(source.sourceMessageExternalId === undefined
      ? {}
      : { sourceMessageExternalId: source.sourceMessageExternalId }),
    ...(source.sourcePermalink === undefined
      ? {}
      : { sourcePermalink: source.sourcePermalink }),
    ...(source.quotedRange === undefined
      ? {}
      : { quotedRange: copyExternalChatQuotedRange(source.quotedRange) }),
  }
}

/**
 * Constructs an exact quoted range snapshot.
 *
 * @param quote - Validated normalized quoted range.
 * @returns Exact quoted range DTO without unknown properties.
 */
function copyExternalChatQuotedRange(
  quote: NonNullable<ExternalChatWorkItemLink['source']['quotedRange']>,
): NonNullable<ExternalChatWorkItemLink['source']['quotedRange']> {
  return {
    sourceMessageExternalId: quote.sourceMessageExternalId,
    startOffset: quote.startOffset,
    endOffset: quote.endOffset,
    text: quote.text,
  }
}

/**
 * Removes provider-scoped source identity from a durable canonical redirect.
 *
 * @param redirect - Durable redirect loaded from trusted storage.
 * @returns Work Item-only route safe after canonical target authorization.
 */
function toExternalChatCanonicalRoute(
  redirect: ExternalChatCanonicalRoute,
): ExternalChatCanonicalRoute {
  return {
    fromTeamId: redirect.fromTeamId,
    fromWorkItemId: redirect.fromWorkItemId,
    canonicalTeamId: redirect.canonicalTeamId,
    canonicalWorkItemId: redirect.canonicalWorkItemId,
    createdAt: redirect.createdAt,
  }
}

/**
 * Redacts link-scoped redirects into a unique former-to-canonical navigation route set.
 *
 * @param redirects - Exact validated per-link redirects returned by the transaction boundary.
 * @returns Unique source-redacted canonical routes in deterministic transaction order.
 */
function uniqueCanonicalRoutes(
  redirects: readonly ExternalChatCanonicalRedirect[],
): ExternalChatCanonicalRoute[] {
  const routes: ExternalChatCanonicalRoute[] = []
  const identities = new Set<string>()
  for (const redirect of redirects) {
    const route = toExternalChatCanonicalRoute(redirect)
    const identity = createExternalChatFingerprint(route)
    if (identities.has(identity)) continue
    identities.add(identity)
    routes.push(route)
  }
  return routes
}

/**
 * Applies private lifecycle watermarks and current parent fences as a fail-closed command floor.
 *
 * @param candidate - Requested settings projection before lifecycle composition.
 * @param lifecycleState - Durable workspace, conversation, and thread observations.
 * @param parentFences - Strongly read exact parent authorities.
 * @param sourceAuthorizationRevision - Authorization generation that resolved the source.
 * @returns Honest, optionally redacted settings projection.
 */
function composeCommandProjectionWithLifecycleFloor(
  candidate: ExternalChatWorkItemLink,
  lifecycleState: ExternalChatLinkLifecycleState,
  parentFences: ExternalChatParentLifecycleFenceSnapshot,
  sourceAuthorizationRevision: number,
): ExternalChatWorkItemLink {
  let availability: ExternalChatSourceAvailability = 'available'
  let state: ExternalChatSourceState = 'active'
  for (const observation of [
    lifecycleState.workspace,
    lifecycleState.conversation,
    lifecycleState.thread,
  ]) {
    if (observation === undefined) continue
    if (sourceAvailabilityRank(observation.availability) > sourceAvailabilityRank(availability)) {
      availability = observation.availability
    }
    if (sourceStateRank(observation.state) > sourceStateRank(state)) state = observation.state
  }
  for (const fence of [parentFences.workspace, parentFences.conversation]) {
    if (
      fence?.restrictive !== true ||
      fence.authorizationRevision < sourceAuthorizationRevision
    ) continue
    if (sourceAvailabilityRank(fence.availability) > sourceAvailabilityRank(availability)) {
      availability = fence.availability
    }
    if (sourceStateRank(fence.state) > sourceStateRank(state)) state = fence.state
  }
  if (sourceAvailabilityRank(candidate.sourceAvailability) > sourceAvailabilityRank(availability)) {
    availability = candidate.sourceAvailability
  }
  if (sourceStateRank(candidate.sourceState) > sourceStateRank(state)) state = candidate.sourceState
  const redacted = mustRedactCommandSourceMetadata(availability, state)
    ? redactCommandSourceMetadata(candidate)
    : candidate
  const restrictive = externalChatLifecycleBlocksSynchronization(availability, state)
  return {
    ...redacted,
    sourceAvailability: availability,
    sourceState: state,
    syncStatus: restrictive || candidate.syncDirection === 'none' ? 'paused' : candidate.syncStatus,
  }
}

/** Returns the fail-closed ordering rank of one source availability. */
function sourceAvailabilityRank(value: ExternalChatSourceAvailability): number {
  if (value === 'available') return 0
  if (value === 'temporarily-unavailable') return 1
  if (value === 'needs-reauth') return 2
  if (value === 'installation-disconnected') return 3
  if (value === 'scope-changed') return 4
  return 5
}

/** Returns the fail-closed ordering rank of one source lifecycle state. */
function sourceStateRank(value: ExternalChatSourceState): number {
  if (value === 'active') return 0
  if (value === 'completed') return 1
  if (value === 'retained-metadata') return 2
  if (value === 'deleted') return 3
  return 4
}

/**
 * Checks whether policy-controlled provider metadata must be removed from a command result.
 *
 * @param availability - Effective provider reachability.
 * @param state - Effective provider lifecycle state.
 * @returns Whether display and permalink metadata must be removed.
 */
function mustRedactCommandSourceMetadata(
  availability: ExternalChatSourceAvailability,
  state: ExternalChatSourceState,
): boolean {
  return availability === 'permission-lost' || availability === 'scope-changed' ||
    state === 'deleted' || state === 'retention-expired'
}

/**
 * Removes policy-controlled provider display, permalink, and quote metadata.
 *
 * @param link - Current durable link projection.
 * @returns Link retaining only immutable provider identities.
 */
function redactCommandSourceMetadata(
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
 * Creates initial link fields before the transaction assigns the canonical Work Item ID.
 *
 * @param context - Validated command context.
 * @param teamId - Owner Team identifier.
 * @param linkId - Deterministic link identifier.
 * @param installationId - Connector installation identifier.
 * @param provider - Resolved provider.
 * @param thread - Permission-filtered source snapshot.
 * @param source - Stable source locator.
 * @param syncDirection - Requested synchronization direction.
 * @returns Initial link fields without a placeholder Work Item identifier.
 */
function createInitialLinkDraft(
  context: ExternalChatLinkCommandContext,
  teamId: string,
  linkId: string,
  installationId: string,
  provider: ExternalChatProvider,
  thread: ExternalChatThreadSnapshot,
  source: LinkExternalChatThreadInput['source'],
  syncDirection: ExternalChatWorkItemLink['syncDirection'],
): Omit<ExternalChatWorkItemLink, 'workItemId'> {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    id: linkId,
    teamId,
    installationId,
    provider,
    workspace: copyExternalChatWorkspace(thread.workspace),
    conversation: copyExternalChatConversation(thread.conversation),
    source: copyExternalChatThreadReference(source),
    syncDirection,
    syncStatus: syncDirection === 'none' ? 'paused' : 'pending',
    sourceAvailability: thread.availability,
    sourceState: thread.state,
    revision: 1,
    lastSourceObservedAt: context.occurredAt,
    createdAt: context.occurredAt,
    updatedAt: context.occurredAt,
  }
}

/**
 * Creates one initial provider-neutral link after source resolution.
 *
 * @param context - Validated command context.
 * @param teamId - Owner Team identifier.
 * @param linkId - Deterministic link identifier.
 * @param workItemId - Existing canonical Work Item identifier.
 * @param installationId - Connector installation identifier.
 * @param provider - Resolved provider.
 * @param thread - Permission-filtered source snapshot.
 * @param source - Stable source locator.
 * @param syncDirection - Requested synchronization direction.
 * @returns Initial link snapshot.
 */
function createInitialLink(
  context: ExternalChatLinkCommandContext,
  teamId: string,
  linkId: string,
  workItemId: string,
  installationId: string,
  provider: ExternalChatProvider,
  thread: ExternalChatThreadSnapshot,
  source: LinkExternalChatThreadInput['source'],
  syncDirection: ExternalChatWorkItemLink['syncDirection'],
): ExternalChatWorkItemLink {
  return {
    ...createInitialLinkDraft(
      context,
      teamId,
      linkId,
      installationId,
      provider,
      thread,
      source,
      syncDirection,
    ),
    workItemId,
  }
}

/**
 * Requires a resolved installation authorization to match the exact requested scope.
 *
 * @param installationId - Installation requested by the command.
 * @param externalWorkspaceId - External Workspace requested by the command.
 * @param installation - Authorization state returned by the access boundary.
 */
function validateResolvedInstallation(
  installationId: string,
  externalWorkspaceId: string,
  installation: AuthorizedExternalChatInstallation,
): void {
  if (
    installation.authorization.installationId !== installationId ||
    installation.authorization.externalWorkspaceId !== externalWorkspaceId ||
    !Number.isSafeInteger(installation.authorization.authorizationRevision) ||
    installation.authorization.authorizationRevision < 1
  ) {
    throw new ExternalChatError(
      'ExternalChatAuthorizationFailed',
      'The connector installation authorization does not match the requested source.',
    )
  }
}

/**
 * Validates that a provider response belongs to the exact requested source scope.
 *
 * @param provider - Provider resolved from the installation.
 * @param source - Requested source locator.
 * @param thread - Provider response to validate.
 */
function validateResolvedThread(
  provider: ExternalChatProvider,
  source: LinkExternalChatThreadInput['source'],
  thread: ExternalChatThreadSnapshot,
): void {
  if (
    thread.workspace.provider !== provider ||
    thread.workspace.externalId !== source.externalWorkspaceId ||
    thread.conversation.externalWorkspaceId !== source.externalWorkspaceId ||
    thread.conversation.externalId !== source.conversationExternalId ||
    thread.externalId !== source.threadExternalId ||
    thread.rootMessageExternalId !== source.rootMessageExternalId
  ) {
    throw new ExternalChatError(
      'ExternalChatAuthorizationFailed',
      'The provider response does not match the authorized chat source.',
    )
  }
  if (thread.availability !== 'available') {
    throw new ExternalChatError(
      'ExternalChatSourceUnavailable',
      'The external chat source is not currently available.',
      true,
    )
  }
  const selectedMessageId = source.sourceMessageExternalId ?? source.rootMessageExternalId
  const selectedMessage = thread.messages.find((message) => message.externalId === selectedMessageId)
  const permalinkMatches = source.sourcePermalink === thread.permalink ||
    selectedMessage?.permalink === source.sourcePermalink
  if (!selectedMessage || !permalinkMatches || !isHttpsUrl(source.sourcePermalink)) {
    throw new ExternalChatError(
      'ExternalChatAuthorizationFailed',
      'The selected message and permalink were not present in the authorized thread snapshot.',
    )
  }
  const quote = source.quotedRange
  if (quote) {
    const body = selectedMessage.bodyMarkdown
    if (
      quote.sourceMessageExternalId !== selectedMessage.externalId ||
      body === undefined ||
      !Number.isSafeInteger(quote.startOffset) ||
      !Number.isSafeInteger(quote.endOffset) ||
      quote.startOffset < 0 ||
      quote.endOffset <= quote.startOffset ||
      quote.endOffset > body.length ||
      body.slice(quote.startOffset, quote.endOffset) !== quote.text
    ) {
      throw new ExternalChatError(
        'ExternalChatValidationFailed',
        'The selected external chat quote does not match the authorized normalized message.',
      )
    }
  }
}

/**
 * Creates the canonical source identity used by the unique claim.
 *
 * @param provider - Provider resolved from the installation.
 * @param source - Stable source locator.
 * @returns Installation-independent provider thread identity.
 */
function sourceIdentity(
  provider: ExternalChatProvider,
  source: LinkExternalChatThreadInput['source'],
) {
  return {
    provider,
    externalWorkspaceId: source.externalWorkspaceId,
    conversationExternalId: source.conversationExternalId,
    threadExternalId: source.threadExternalId,
  }
}

/** Maximum number of links accepted by one bounded duplicate merge command. */
const EXTERNAL_CHAT_MERGE_MAX_LINKS = 20

/**
 * Validates the chat-specific fields of a create-from-thread command.
 *
 * Canonical Work Item field validation remains owned by the Work Item transaction boundary.
 *
 * @param command - Candidate create command.
 */
function validateCreateWorkItemCommand(
  command: CreateWorkItemFromExternalChatThreadInput,
): void {
  requireRecord(command, 'external chat create command')
  requireIdentifier(command.teamId)
  requireIdentifier(command.installationId)
  requireRecord(command.workItem, 'canonical Work Item input')
  validateThreadSelection(command.source)
  requireSyncDirection(command.syncDirection)
}

/**
 * Validates the chat-specific fields of an existing Work Item link command.
 *
 * @param command - Candidate link command.
 */
function validateLinkWorkItemCommand(command: LinkExternalChatThreadInput): void {
  requireRecord(command, 'external chat link command')
  requireIdentifier(command.teamId)
  requireIdentifier(command.workItemId)
  requireIdentifier(command.installationId)
  validateThreadSelection(command.source)
  requireSyncDirection(command.syncDirection)
}

/**
 * Validates one external source selection before authorization or provider access.
 *
 * @param source - Candidate provider-neutral thread selection.
 */
function validateThreadSelection(source: LinkExternalChatThreadInput['source']): void {
  requireRecord(source, 'external chat thread selection')
  requireIdentifier(source.externalWorkspaceId)
  requireIdentifier(source.conversationExternalId)
  requireIdentifier(source.threadExternalId)
  requireIdentifier(source.rootMessageExternalId)
  if (source.sourceMessageExternalId !== undefined) {
    requireIdentifier(source.sourceMessageExternalId)
  }
  if (!isHttpsUrl(source.sourcePermalink)) {
    validationError('The external chat source permalink must be an absolute HTTPS URL.')
  }
  const quote = source.quotedRange
  if (quote === undefined) return
  requireRecord(quote, 'external chat quoted range')
  requireIdentifier(quote.sourceMessageExternalId)
  if (
    !Number.isSafeInteger(quote.startOffset) ||
    !Number.isSafeInteger(quote.endOffset) ||
    quote.startOffset < 0 ||
    quote.endOffset <= quote.startOffset ||
    typeof quote.text !== 'string' ||
    quote.text.length === 0 ||
    quote.text.length > 20_000 ||
    quote.text.length !== quote.endOffset - quote.startOffset
  ) {
    validationError('The external chat quoted range is invalid.')
  }
}

/**
 * Validates a revision-fenced link settings command.
 *
 * @param linkId - Candidate link identifier.
 * @param command - Candidate settings command.
 */
function validateUpdateCommand(
  linkId: string,
  command: UpdateExternalChatWorkItemLinkInput,
): void {
  requireIdentifier(linkId)
  requireRecord(command, 'external chat link update command')
  requirePositiveRevision(command.expectedRevision)
  requireSyncDirection(command.syncDirection)
}

/**
 * Validates a revision-fenced unlink command.
 *
 * @param linkId - Candidate link identifier.
 * @param command - Candidate unlink command.
 */
function validateUnlinkCommand(linkId: string, command: UnlinkExternalChatThreadInput): void {
  requireIdentifier(linkId)
  requireRecord(command, 'external chat unlink command')
  requirePositiveRevision(command.expectedRevision)
}

/**
 * Validates a revision-fenced explicit resynchronization command.
 *
 * @param linkId - Candidate link identifier.
 * @param command - Candidate resynchronization command.
 */
function validateResyncCommand(
  linkId: string,
  command: ResyncExternalChatWorkItemLinkInput,
): void {
  requireIdentifier(linkId)
  requireRecord(command, 'external chat resynchronization command')
  requirePositiveRevision(command.expectedRevision)
  if (command.mode !== 'resume' && command.mode !== 'full') {
    validationError('The external chat resynchronization mode is invalid.')
  }
}

/**
 * Validates every revision and identity used by a bounded duplicate merge.
 *
 * @param command - Candidate duplicate merge command.
 */
function validateMergeCommand(command: MergeExternalChatWorkItemLinksInput): void {
  requireRecord(command, 'external chat duplicate merge command')
  requireIdentifier(command.canonicalTeamId)
  requireIdentifier(command.canonicalWorkItemId)
  requirePositiveRevision(command.expectedCanonicalWorkItemRevision)
  requireIdentifier(command.duplicateTeamId)
  requireIdentifier(command.duplicateWorkItemId)
  requirePositiveRevision(command.expectedDuplicateWorkItemRevision)
  if (
    command.canonicalTeamId === command.duplicateTeamId &&
    command.canonicalWorkItemId === command.duplicateWorkItemId
  ) {
    validationError('The canonical and duplicate Work Items must be different.')
  }
  if (
    !Array.isArray(command.links) ||
    command.links.length === 0 ||
    command.links.length > EXTERNAL_CHAT_MERGE_MAX_LINKS
  ) {
    validationError(
      `An external chat duplicate merge must contain between 1 and ${EXTERNAL_CHAT_MERGE_MAX_LINKS} links.`,
    )
  }
  const linkIds = new Set<string>()
  for (const candidate of command.links) {
    requireRecord(candidate, 'external chat merge candidate')
    const linkId = requireIdentifier(candidate.linkId)
    requirePositiveRevision(candidate.expectedRevision)
    if (linkIds.has(linkId)) validationError('External chat merge link IDs must be unique.')
    linkIds.add(linkId)
  }
}

/**
 * Validates request-scoped command state.
 *
 * @param context - Candidate command context.
 */
function validateContext(context: ExternalChatLinkCommandContext): void {
  requireRecord(context, 'external chat command context')
  requireRecord(context.principal, 'external chat command principal')
  requireIdentifier(context.principal.workspaceId)
  requireIdentifier(context.principal.memberKey)
  requireIdentifier(context.correlationId)
  if (
    typeof context.idempotencyKey !== 'string' ||
    context.idempotencyKey.length === 0 ||
    context.idempotencyKey.length > 256 ||
    context.idempotencyKey.trim() !== context.idempotencyKey ||
    /\p{Cc}/u.test(context.idempotencyKey)
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The external chat idempotency key must contain 1 to 256 characters.',
    )
  }
  if (!isCanonicalTimestamp(context.occurredAt)) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The external chat command timestamp is invalid.',
    )
  }
}

/**
 * Requires one bounded canonical identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    validationError('An external chat identifier is invalid.')
  }
  return value
}

/**
 * Requires one positive safe optimistic concurrency revision.
 *
 * @param value - Candidate revision.
 * @returns Validated revision.
 */
function requirePositiveRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    validationError('An external chat revision is invalid.')
  }
  return value
}

/**
 * Requires one supported synchronization direction.
 *
 * @param value - Candidate direction.
 */
function requireSyncDirection(value: unknown): void {
  if (
    value !== 'none' &&
    value !== 'inbound' &&
    value !== 'outbound' &&
    value !== 'bidirectional'
  ) {
    validationError('The external chat synchronization direction is invalid.')
  }
}

/**
 * Requires one non-array object before any command property is read.
 *
 * @param value - Candidate object.
 * @param label - Secret-free diagnostic label.
 */
function requireRecord(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    validationError(`The ${label} is invalid.`)
  }
}

/**
 * Raises one stable command validation error.
 *
 * @param message - Secret-free diagnostic message.
 * @returns Never returns.
 */
function validationError(message: string): never {
  throw new ExternalChatError('ExternalChatValidationFailed', message)
}

/**
 * Hashes a tenant, actor, operation, and raw idempotency key without persisting the key.
 *
 * @param context - Validated command context.
 * @param action - Command namespace.
 * @returns Lowercase SHA-256 digest.
 */
function hashIdempotencyKey(
  context: ExternalChatLinkCommandContext,
  action: ExternalChatLinkAuditRecord['action'],
): string {
  return createHash('sha256')
    .update([
      'external-chat-link-idempotency-v1',
      context.principal.workspaceId,
      context.principal.memberKey,
      action,
      context.idempotencyKey,
    ].join('\0'))
    .digest('hex')
}

/**
 * Creates a stable operation ID bound to an idempotency key and normalized command.
 *
 * @param context - Validated command context.
 * @param action - Command namespace.
 * @param command - Complete normalized command.
 * @returns Stable operation identifier.
 */
function createLinkCommandOperationId(
  context: ExternalChatLinkCommandContext,
  action: ExternalChatLinkAuditRecord['action'],
  command: unknown,
): string {
  const digest = createHash('sha256')
    .update([
      'external-chat-link-operation-v1',
      hashIdempotencyKey(context, action),
      createExternalChatFingerprint(command),
    ].join('\0'))
    .digest('hex')
  return `chat_cmd_${digest.slice(0, 40)}`
}

/**
 * Converts a deterministic operation ID into a retry-stable link ID.
 *
 * @param operationId - Stable command operation identifier.
 * @returns Stable link identifier.
 */
function deterministicLinkId(operationId: string): string {
  return `chat_link_${operationId.slice('chat_cmd_'.length)}`
}

/**
 * Creates one bounded safe audit record.
 *
 * @param context - Validated command context.
 * @param operationId - Stable logical operation identifier.
 * @param action - Link command action.
 * @param teamId - Affected Team identifier.
 * @param workItemId - Affected Work Item identifier.
 * @param linkId - Affected link identifier.
 * @param provider - Affected provider.
 * @param sourceDigest - Digest of external source identity.
 * @param outcome - Secret-free command outcome.
 * @param reasonCode - Stable reason code.
 * @returns Safe audit record.
 */
function createAuditRecord(
  context: ExternalChatLinkCommandContext,
  operationId: string,
  action: ExternalChatLinkAuditRecord['action'],
  teamId: string,
  workItemId: string | undefined,
  linkId: string | undefined,
  provider: ExternalChatProvider | undefined,
  sourceDigest: string | undefined,
  outcome: ExternalChatLinkAuditRecord['outcome'],
  reasonCode: string,
): ExternalChatLinkAuditRecord {
  return {
    workspaceId: context.principal.workspaceId,
    actorMemberKey: context.principal.memberKey,
    correlationId: context.correlationId,
    operationId,
    action,
    teamId,
    ...(workItemId ? { workItemId } : {}),
    ...(linkId ? { linkId } : {}),
    ...(provider ? { provider } : {}),
    ...(sourceDigest ? { sourceDigest } : {}),
    outcome,
    reasonCode,
    occurredAt: context.occurredAt,
  }
}

/**
 * Creates a stable not-found error without disclosing cross-tenant existence.
 *
 * @returns External chat not-found error.
 */
function notFoundError(): ExternalChatError {
  return new ExternalChatError('ExternalChatNotFound', 'The external chat link was not found.')
}

/**
 * Retains a command identifier in failure audit only when it is already canonical and bounded.
 *
 * @param value - Candidate untrusted command identifier.
 * @returns Safe identifier or undefined when validation has not succeeded.
 */
function safeFailureIdentifier(value: unknown): string | undefined {
  return isBoundedResultIdentifier(value) ? value : undefined
}

/**
 * Classifies a failed command without retaining exception text or provider payload data.
 *
 * @param error - Unknown application, adapter, or infrastructure failure.
 * @returns Stable secret-free failure reason.
 */
function linkCommandFailureReason(error: unknown): string {
  if (error instanceof ExternalChatError || error instanceof ChatProviderAdapterError) {
    return error.code
  }
  return 'ExternalChatCommandFailed'
}

/**
 * Checks a canonical millisecond-precision UTC timestamp.
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
 * Checks that a provider permalink is an absolute HTTPS URL without embedded credentials.
 *
 * @param value - Candidate provider permalink.
 * @returns Whether the URL is safe for persisted navigation metadata.
 */
function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 4_096) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
  } catch {
    return false
  }
}
