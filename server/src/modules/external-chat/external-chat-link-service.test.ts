import { describe, expect, test } from 'bun:test'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
  type CreateWorkItemFromExternalChatThreadInput,
  type CreateWorkItemFromExternalChatThreadResult,
  type ExternalChatMessage,
  type ExternalChatThreadReference,
  type ExternalChatThreadSelection,
  type ExternalChatThreadSnapshot,
  type ExternalChatWorkItemLink,
  type LinkExternalChatThreadInput,
  type LinkExternalChatThreadResult,
  type MergeExternalChatWorkItemLinksInput,
  type MergeExternalChatWorkItemLinksResult,
  type ResyncExternalChatWorkItemLinkResult,
  type UpdateExternalChatWorkItemLinkInput,
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
import {
  createExternalChatFingerprint,
  ExternalChatError,
  InMemoryExternalChatStore,
} from './external-chat'
import {
  ExternalChatLinkService,
  type AcceptExternalChatResyncTransactionInput,
  type CreateWorkItemAndExternalChatLinkTransactionInput,
  type ExternalChatLinkAccessPort,
  type ExternalChatLinkAuditRecord,
  type ExternalChatLinkCommandContext,
  type ExternalChatLinkFailureAuditPort,
  type ExternalChatLinkTransactionPort,
  type LinkExistingWorkItemToExternalChatTransactionInput,
  type MergeWorkItemsAndExternalChatLinksTransactionInput,
  type MergeWorkItemsAndExternalChatLinksTransactionResult,
  type UnlinkExternalChatLinkTransactionInput,
  type UnlinkExternalChatLinkTransactionResult,
  type UpdateExternalChatLinkTransactionInput,
  type UpdateExternalChatLinkTransactionResult,
} from './external-chat-link-service'

const occurredAt = '2026-08-06T06:00:00.000Z'
const retryOccurredAt = '2026-08-06T06:01:00.000Z'

/** Recorded update receipt used to emulate transaction-owned idempotency. */
type RecordedUpdateReceipt = {
  /** Digest of the complete normalized command. */
  requestFingerprint: string
  /** Exact first-commit result returned by every replay. */
  result: UpdateExternalChatLinkTransactionResult
}

/** Recorded unlink receipt used to emulate transaction-owned idempotency. */
type RecordedUnlinkReceipt = {
  /** Digest of the complete normalized command. */
  requestFingerprint: string
  /** Exact first-commit result returned by every replay. */
  result: UnlinkExternalChatLinkTransactionResult
}

/** Recorded merge receipt used to prove receipt-first duplicate merge replay. */
type RecordedMergeReceipt = {
  /** Digest of the complete normalized merge command. */
  requestFingerprint: string
  /** Exact first-commit cross-domain merge result. */
  result: MergeWorkItemsAndExternalChatLinksTransactionResult
}

/** Recorded Work Item/link creation receipt owned by the raw idempotency key digest. */
type RecordedCreateReceipt = {
  /** Digest of the complete normalized creation command. */
  requestFingerprint: string
  /** Exact first-commit Work Item and link result. */
  result: CreateWorkItemFromExternalChatThreadResult
}

/** Recorded existing-link creation receipt owned by the raw idempotency key digest. */
type RecordedLinkReceipt = {
  /** Digest of the complete normalized link command. */
  requestFingerprint: string
  /** Exact first-commit link result. */
  result: LinkExternalChatThreadResult
}

/** Recorded resynchronization receipt owned by the raw idempotency key digest. */
type RecordedResyncReceipt = {
  /** Digest of the complete normalized resynchronization command. */
  requestFingerprint: string
  /** Exact first-commit accepted resynchronization result. */
  result: ResyncExternalChatWorkItemLinkResult
}

/** Deliberate invalid update result selected by fail-closed contract tests. */
type UpdateResultCorruption = 'scope' | 'revision' | 'inactive'

/** Deliberate invalid unlink result selected by fail-closed contract tests. */
type UnlinkResultCorruption = 'scope' | 'revision' | 'active'

/** Deliberate invalid canonical Work Item result selected by causal timestamp tests. */
type CreateWorkItemResultCorruption =
  | 'priority-noncanonical'
  | 'priority-before-created'
  | 'due-after-updated'
  | 'approval-noncanonical'
  | 'approval-before-created'

/** Complete application fixture for external chat link boundary tests. */
type LinkServiceFixture = {
  /** Service under test. */
  service: ExternalChatLinkService
  /** Mutable authorization boundary. */
  access: RecordingLinkAccessPort
  /** Provider fixture used to resolve authorized source snapshots. */
  adapter: RecordingLinkProviderAdapter
  /** Recording atomic transaction boundary. */
  transactions: RecordingLinkTransactionPort
  /** Durable link state used by non-creation command tests. */
  store: InMemoryExternalChatStore
  /** Secret-free audit sink for unsuccessful commands. */
  failureAudit: RecordingLinkFailureAuditPort
}

/** Provider adapter that records source reads and returns one configured snapshot. */
class RecordingLinkProviderAdapter implements ChatProviderAdapter {
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

  /** Source resolutions that reached the provider boundary. */
  readonly resolvedSources: ExternalChatThreadReference[] = []

  /** Permission-filtered thread returned by source resolution. */
  private readonly thread: ExternalChatThreadSnapshot

  /**
   * Creates a recording provider fixture.
   *
   * @param thread - Snapshot returned by source resolution.
   */
  constructor(thread: ExternalChatThreadSnapshot) {
    this.thread = thread
  }

  /** Rejects webhook normalization because link tests never enter that boundary. */
  async normalizeWebhook(
    _request: ChatProviderWebhookRequest,
    _authorization: ChatProviderAuthorization,
  ): Promise<ChatProviderNormalizedWebhook> {
    throw new Error('Webhook normalization is outside this fixture.')
  }

  /** Records a provider-authorized source resolution. */
  async resolveThread(
    authorization: ChatProviderAuthorization,
    source: ExternalChatThreadReference,
  ): Promise<ExternalChatThreadSnapshot> {
    if (
      authorization.installationId !== 'installation-slack' ||
      authorization.externalWorkspaceId !== source.externalWorkspaceId
    ) {
      throw new Error('Unexpected provider authorization scope.')
    }
    this.resolvedSources.push(source)
    return this.thread
  }

  /** Rejects source paging because link tests only resolve initial snapshots. */
  async readThreadPage(_input: ReadChatProviderThreadPageInput): Promise<ChatProviderThreadPage> {
    throw new Error('Thread paging is outside this fixture.')
  }

  /** Rejects reply creation because link tests do not synchronize messages. */
  async createReply(_input: CreateChatProviderReplyInput): Promise<ExternalChatMessage> {
    throw new Error('Reply creation is outside this fixture.')
  }

  /** Rejects provider edits because link tests do not synchronize messages. */
  async editMessage(_input: EditChatProviderMessageInput): Promise<ExternalChatMessage> {
    throw new Error('Message editing is outside this fixture.')
  }

  /** Rejects provider deletion because link tests do not synchronize messages. */
  async deleteMessage(_input: DeleteChatProviderMessageInput): Promise<ExternalChatMessage> {
    throw new Error('Message deletion is outside this fixture.')
  }

  /** Rejects thread completion because link tests do not synchronize lifecycle events. */
  async setThreadCompletion(
    _input: SetChatProviderThreadCompletionInput,
  ): Promise<ChatProviderThreadMutationResult> {
    throw new Error('Thread completion is outside this fixture.')
  }
}

/** Authorization fixture that records ordering and can deny Work Item writes. */
class RecordingLinkAccessPort implements ExternalChatLinkAccessPort {
  /** Team-create authorization calls. */
  readonly teamCreateCalls: string[] = []

  /** Existing Work Item authorization calls. */
  readonly workItemCalls: Array<{
    /** Team passed to authorization. */
    teamId: string
    /** Work Item passed to authorization. */
    workItemId: string
    /** Requested capability. */
    mode: 'read' | 'write'
  }> = []

  /** Installation resolutions that reached the external authorization boundary. */
  readonly installationCalls: string[] = []

  /** Whether existing Work Item authorization must fail closed. */
  denyWorkItemWrite = false

  /** Current provider authorization generation returned by installation resolution. */
  authorizationRevision = 4

  /** Former duplicate routes resolved to their canonical authorization target. */
  private readonly canonicalRoutes = new Map<string, {
    /** Canonical Team identifier. */
    teamId: string
    /** Canonical Work Item identifier. */
    workItemId: string
  }>()

  /** Records successful Team-create authorization. */
  async authorizeTeamCreate(
    _principal: { workspaceId: string; memberKey: string },
    teamId: string,
  ): Promise<void> {
    this.teamCreateCalls.push(teamId)
  }

  /** Records or rejects existing Work Item authorization. */
  async authorizeWorkItem(
    _principal: { workspaceId: string; memberKey: string },
    teamId: string,
    workItemId: string,
    mode: 'read' | 'write',
  ): Promise<void> {
    const target = this.canonicalRoutes.get(workItemRouteKey(teamId, workItemId)) ?? {
      teamId,
      workItemId,
    }
    this.workItemCalls.push({ teamId: target.teamId, workItemId: target.workItemId, mode })
    if (this.denyWorkItemWrite && mode === 'write') {
      throw new ExternalChatError(
        'ExternalChatAuthorizationFailed',
        'The principal cannot mutate the Work Item.',
      )
    }
  }

  /** Records the durable canonical route created when a duplicate becomes non-addressable. */
  recordCanonicalRoute(
    duplicateTeamId: string,
    duplicateWorkItemId: string,
    canonicalTeamId: string,
    canonicalWorkItemId: string,
  ): void {
    this.canonicalRoutes.set(workItemRouteKey(duplicateTeamId, duplicateWorkItemId), {
      teamId: canonicalTeamId,
      workItemId: canonicalWorkItemId,
    })
  }

  /** Resolves current installation authorization for the exact external Workspace. */
  async resolveInstallation(
    _principal: { workspaceId: string; memberKey: string },
    installationId: string,
    externalWorkspaceId: string,
    _mode: 'read' | 'write',
  ): Promise<{
    /** Provider selected by the installation. */
    provider: 'slack'
    /** Current provider authorization snapshot. */
    authorization: ChatProviderAuthorization
  }> {
    this.installationCalls.push(installationId)
    return {
      provider: 'slack',
      authorization: {
        installationId,
        externalWorkspaceId,
        authorizationRevision: this.authorizationRevision,
      },
    }
  }
}

/** Recording transaction port that materializes deterministic fixture results. */
class RecordingLinkTransactionPort implements ExternalChatLinkTransactionPort {
  /** Durable link store mutated inside the recording transaction boundary. */
  private readonly store: InMemoryExternalChatStore

  /** Authorization fixture updated atomically with synthetic duplicate redirects. */
  private readonly access: RecordingLinkAccessPort

  /** Atomic create inputs received by the transaction boundary. */
  readonly createInputs: CreateWorkItemAndExternalChatLinkTransactionInput[] = []

  /** Atomic existing-link inputs received by the transaction boundary. */
  readonly linkInputs: LinkExistingWorkItemToExternalChatTransactionInput[] = []

  /** Atomic resynchronization inputs received by the transaction boundary. */
  readonly resyncInputs: AcceptExternalChatResyncTransactionInput[] = []

  /** Atomic link settings inputs received by the transaction boundary. */
  readonly updateInputs: UpdateExternalChatLinkTransactionInput[] = []

  /** Atomic unlink inputs received by the transaction boundary. */
  readonly unlinkInputs: UnlinkExternalChatLinkTransactionInput[] = []

  /** Atomic duplicate merge inputs received by the transaction boundary. */
  readonly mergeInputs: MergeWorkItemsAndExternalChatLinksTransactionInput[] = []

  /** Final redacted audits committed with update and unlink receipts. */
  readonly committedAudits: ExternalChatLinkAuditRecord[] = []

  /** Operation identifiers whose final audit outbox record already committed. */
  private readonly committedAuditOperations = new Set<string>()

  /** Whether the next first-commit update should simulate response loss. */
  failUpdateAfterCommitOnce = false

  /** Optional one-shot concurrent mutation invoked before the settings store commit. */
  updateBeforeCommitHook?: () => Promise<void>

  /** Whether the next first-commit unlink should simulate response loss. */
  failUnlinkAfterCommitOnce = false

  /** Whether the next first-commit merge should simulate response loss. */
  failMergeAfterCommitOnce = false

  /** Optional malformed redirect result returned after a valid durable merge. */
  mergeResultCorruption?: 'duplicate-redirect' | 'provider'

  /** Optional invalid update result returned without corrupting durable state. */
  updateResultCorruption?: UpdateResultCorruption

  /** Optional invalid unlink result returned without corrupting durable state. */
  unlinkResultCorruption?: UnlinkResultCorruption

  /** Optional invalid Work Item result returned after a valid creation commit. */
  createWorkItemResultCorruption?: CreateWorkItemResultCorruption

  /** Durable update receipts keyed by actor-scoped idempotency digest. */
  private readonly updateReceipts = new Map<string, RecordedUpdateReceipt>()

  /** Durable unlink receipts keyed by actor-scoped idempotency digest. */
  private readonly unlinkReceipts = new Map<string, RecordedUnlinkReceipt>()

  /** First-commit Work Item/link results keyed by stable operation identity. */
  private readonly createReceipts = new Map<string, RecordedCreateReceipt>()

  /** First-commit existing-link results keyed by stable operation identity. */
  private readonly linkReceipts = new Map<string, RecordedLinkReceipt>()

  /** First-commit resynchronization results keyed by stable operation identity. */
  private readonly resyncReceipts = new Map<string, RecordedResyncReceipt>()

  /** First-commit duplicate merge receipts keyed by actor-scoped idempotency digest. */
  private readonly mergeReceipts = new Map<string, RecordedMergeReceipt>()

  /**
   * Creates a recording transaction boundary over one durable fixture store.
   *
   * @param store - Store mutated atomically with synthetic receipts and audit outbox records.
   */
  constructor(store: InMemoryExternalChatStore, access: RecordingLinkAccessPort) {
    this.store = store
    this.access = access
  }

  /** Records an atomic Work Item/link creation and assigns the canonical Work Item ID. */
  async createWorkItemAndLink(
    input: CreateWorkItemAndExternalChatLinkTransactionInput,
  ): Promise<CreateWorkItemFromExternalChatThreadResult> {
    this.createInputs.push(input)
    const receipt = this.createReceipts.get(input.linkDraft.idempotencyKeyHash)
    if (receipt) {
      if (receipt.requestFingerprint !== input.linkDraft.requestFingerprint) {
        throw idempotencyConflict()
      }
      return receipt.result
    }
    const workItem = this.corruptCreateWorkItemResult(
      createCanonicalWorkItem('work-item-created', input.command),
    )
    const link: ExternalChatWorkItemLink = {
      ...input.linkDraft.link,
      workItemId: workItem.id,
    }
    const stored = await this.store.createLink({
      workspaceId: input.workspaceId,
      link,
      authorizationRevision: input.linkDraft.authorizationRevision,
      source: input.linkDraft.source,
      idempotencyKeyHash: input.linkDraft.idempotencyKeyHash,
      requestFingerprint: input.linkDraft.requestFingerprint,
    })
    if (stored.kind !== 'created') throw transactionCommitFailed('Work Item/link creation')
    this.commitAudit({ ...input.audit, workItemId: workItem.id, linkId: link.id })
    const result = { workItem, link }
    this.createReceipts.set(input.linkDraft.idempotencyKeyHash, {
      requestFingerprint: input.linkDraft.requestFingerprint,
      result,
    })
    return result
  }

  /** Records an atomic existing Work Item/link creation. */
  async linkExistingWorkItem(
    input: LinkExistingWorkItemToExternalChatTransactionInput,
  ): Promise<LinkExternalChatThreadResult> {
    this.linkInputs.push(input)
    const receipt = this.linkReceipts.get(input.link.idempotencyKeyHash)
    if (receipt) {
      if (receipt.requestFingerprint !== input.link.requestFingerprint) throw idempotencyConflict()
      return receipt.result
    }
    const stored = await this.store.createLink(input.link)
    if (stored.kind !== 'created') throw transactionCommitFailed('existing Work Item link')
    this.commitAudit(input.audit)
    const result = { link: input.link.link }
    this.linkReceipts.set(input.link.idempotencyKeyHash, {
      requestFingerprint: input.link.requestFingerprint,
      result,
    })
    return result
  }

  /**
   * Atomically updates one link and replays its exact transaction-owned receipt.
   *
   * A parent-stale result is classified as a transaction failure so callers cannot mistake a
   * restrictive lifecycle race for a successful settings update.
   */
  async updateLink(
    input: UpdateExternalChatLinkTransactionInput,
  ): Promise<UpdateExternalChatLinkTransactionResult> {
    this.updateInputs.push(input)
    const receipt = this.updateReceipts.get(input.idempotencyKeyHash)
    if (receipt) {
      if (receipt.requestFingerprint !== input.requestFingerprint) throw idempotencyConflict()
      return this.corruptUpdateResult(receipt.result)
    }
    const current = await this.store.getLink(input.workspaceId, input.link.id)
    if (!current || !current.active) throw transactionNotFound()
    if (this.updateBeforeCommitHook) {
      const hook = this.updateBeforeCommitHook
      this.updateBeforeCommitHook = undefined
      await hook()
    }
    const stored = await this.store.updateLink({
      workspaceId: input.workspaceId,
      link: input.link,
      expectedRevision: input.expectedRevision,
      expectedParentLifecycleFences: input.expectedParentLifecycleFences,
    })
    if (stored.kind === 'not-found') throw transactionNotFound()
    if (stored.kind === 'conflict') throw transactionRevisionConflict()
    if (stored.kind === 'parent-stale') {
      throw transactionCommitFailed('non-parent link update')
    }
    const result: UpdateExternalChatLinkTransactionResult = {
      operationId: input.operationId,
      record: stored.record,
    }
    this.updateReceipts.set(input.idempotencyKeyHash, {
      requestFingerprint: input.requestFingerprint,
      result,
    })
    this.commitAudit(input.audit)
    if (this.failUpdateAfterCommitOnce) {
      this.failUpdateAfterCommitOnce = false
      throw new Error('Simulated response loss after atomic update commit.')
    }
    return this.corruptUpdateResult(result)
  }

  /** Atomically unlinks one source and replays its exact transaction-owned receipt. */
  async unlinkLink(
    input: UnlinkExternalChatLinkTransactionInput,
  ): Promise<UnlinkExternalChatLinkTransactionResult> {
    this.unlinkInputs.push(input)
    const receipt = this.unlinkReceipts.get(input.idempotencyKeyHash)
    if (receipt) {
      if (receipt.requestFingerprint !== input.requestFingerprint) throw idempotencyConflict()
      return this.corruptUnlinkResult(receipt.result)
    }
    const current = await this.store.getLink(input.workspaceId, input.linkId)
    if (!current || !current.active) throw transactionNotFound()
    const stored = await this.store.unlinkLink({
      workspaceId: input.workspaceId,
      linkId: input.linkId,
      expectedRevision: input.expectedRevision,
      unlinkedAt: input.unlinkedAt,
    })
    if (stored.kind === 'not-found') throw transactionNotFound()
    if (stored.kind === 'conflict') throw transactionRevisionConflict()
    const result: UnlinkExternalChatLinkTransactionResult = {
      operationId: input.operationId,
      record: stored.record,
    }
    this.unlinkReceipts.set(input.idempotencyKeyHash, {
      requestFingerprint: input.requestFingerprint,
      result,
    })
    this.commitAudit(input.audit)
    if (this.failUnlinkAfterCommitOnce) {
      this.failUnlinkAfterCommitOnce = false
      throw new Error('Simulated response loss after atomic unlink commit.')
    }
    return this.corruptUnlinkResult(result)
  }

  /**
   * Records an atomically accepted resynchronization command.
   *
   * A parent-stale result is surfaced as a revision conflict and never queues a stale job.
   */
  async acceptResync(
    input: AcceptExternalChatResyncTransactionInput,
  ): Promise<ResyncExternalChatWorkItemLinkResult> {
    this.resyncInputs.push(input)
    const receipt = this.resyncReceipts.get(input.idempotencyKeyHash)
    if (receipt) {
      if (receipt.requestFingerprint !== input.requestFingerprint) throw idempotencyConflict()
      return receipt.result
    }
    const current = await this.store.getLink(input.workspaceId, input.link.id)
    if (
      !current ||
      current.sourceAuthorizationRevision !== input.expectedSourceAuthorizationRevision ||
      input.authorizationRevision < current.sourceAuthorizationRevision ||
      input.job.authorizationRevision !== input.authorizationRevision
    ) {
      throw transactionRevisionConflict()
    }
    const stored = await this.store.updateLink({
      workspaceId: input.workspaceId,
      link: input.link,
      expectedRevision: input.expectedRevision,
      expectedParentLifecycleFences: input.expectedParentLifecycleFences,
    })
    if (stored.kind === 'not-found') throw transactionNotFound()
    if (stored.kind === 'conflict') throw transactionRevisionConflict()
    if (stored.kind === 'parent-stale') throw transactionRevisionConflict()
    this.commitAudit(input.audit)
    const result = {
      link: input.link,
      operationId: input.operationId,
      acceptedAt: input.job.acceptedAt,
    }
    this.resyncReceipts.set(input.idempotencyKeyHash, {
      requestFingerprint: input.requestFingerprint,
      result,
    })
    return result
  }

  /** Atomically moves duplicate link state and replays the first merge receipt. */
  async mergeWorkItemsAndLinks(
    input: MergeWorkItemsAndExternalChatLinksTransactionInput,
  ): Promise<MergeWorkItemsAndExternalChatLinksTransactionResult> {
    this.mergeInputs.push(input)
    const receipt = this.mergeReceipts.get(input.idempotencyKeyHash)
    if (receipt) {
      if (receipt.requestFingerprint !== input.requestFingerprint) throw idempotencyConflict()
      return receipt.result
    }
    const merged = await this.store.mergeLinks(input.storeMutation)
    if (merged.kind !== 'merged') throw transactionRevisionConflict()
    const baseWorkItem = createCanonicalWorkItem(
      input.command.canonicalWorkItemId,
      createWorkItemCommand(),
    )
    const result: MergeWorkItemsAndExternalChatLinksTransactionResult = {
      canonicalWorkItem: {
        ...baseWorkItem,
        id: input.command.canonicalWorkItemId,
        teamId: input.command.canonicalTeamId,
        revision: input.command.expectedCanonicalWorkItemRevision + 1,
        updatedAt: input.storeMutation.mergedAt,
      },
      movedLinks: merged.movedLinks.map(toFixtureLinkSummary),
      redirects: merged.redirects,
      movedFileCount: merged.movedFileIds.length,
      movedMessageBindingCount: merged.movedMessageBindingCount,
      mergedAt: input.storeMutation.mergedAt,
    }
    this.mergeReceipts.set(input.idempotencyKeyHash, {
      requestFingerprint: input.requestFingerprint,
      result,
    })
    this.commitAudit(input.audit)
    this.access.recordCanonicalRoute(
      input.command.duplicateTeamId,
      input.command.duplicateWorkItemId,
      input.command.canonicalTeamId,
      input.command.canonicalWorkItemId,
    )
    if (this.failMergeAfterCommitOnce) {
      this.failMergeAfterCommitOnce = false
      throw new Error('Simulated response loss after atomic duplicate merge commit.')
    }
    return this.corruptMergeResult(result)
  }

  /**
   * Applies one deliberate causal timestamp corruption to a created Work Item result.
   *
   * @param workItem - Valid transaction-owned canonical Work Item.
   * @returns Valid Work Item or one malformed boundary result.
   */
  private corruptCreateWorkItemResult(workItem: CanonicalWorkItem): CanonicalWorkItem {
    switch (this.createWorkItemResultCorruption) {
      case 'priority-noncanonical':
        return { ...workItem, priorityUpdatedAt: '2026-08-06T06:00:00Z' }
      case 'priority-before-created':
        return { ...workItem, priorityUpdatedAt: '2026-08-06T05:59:00.000Z' }
      case 'due-after-updated':
        return { ...workItem, dueDateUpdatedAt: retryOccurredAt }
      case 'approval-noncanonical':
        if (workItem.approvalSummary === undefined) {
          throw new Error('Expected an approval summary fixture.')
        }
        return {
          ...workItem,
          approvalSummary: {
            ...workItem.approvalSummary,
            updatedAt: '2026-08-06T06:01:00Z',
          },
        }
      case 'approval-before-created':
        if (workItem.approvalSummary === undefined) {
          throw new Error('Expected an approval summary fixture.')
        }
        return {
          ...workItem,
          approvalSummary: {
            ...workItem.approvalSummary,
            updatedAt: '2026-08-06T05:59:00.000Z',
          },
        }
      default:
        return workItem
    }
  }

  /** Commits one final audit outbox record idempotently by logical operation. */
  private commitAudit(record: ExternalChatLinkAuditRecord): void {
    if (this.committedAuditOperations.has(record.operationId)) return
    this.committedAuditOperations.add(record.operationId)
    this.committedAudits.push(record)
  }

  /**
   * Applies one deliberate merge redirect corruption for fail-closed service validation.
   *
   * @param result - Valid internal merge transaction result.
   * @returns Valid result or one deliberately malformed redirect set.
   */
  private corruptMergeResult(
    result: MergeWorkItemsAndExternalChatLinksTransactionResult,
  ): MergeWorkItemsAndExternalChatLinksTransactionResult {
    const first = result.redirects[0]
    if (!first) return result
    if (this.mergeResultCorruption === 'duplicate-redirect') {
      return { ...result, redirects: [first, first] }
    }
    if (this.mergeResultCorruption === 'provider') {
      return {
        ...result,
        redirects: [{
          ...first,
          provider: first.provider === 'slack' ? 'microsoft-teams' : 'slack',
        }],
      }
    }
    return result
  }

  /**
   * Applies one deliberate update receipt corruption for fail-closed service validation.
   *
   * @param result - Valid durable transaction result.
   * @returns Valid result or one deliberately invalid response projection.
   */
  private corruptUpdateResult(
    result: UpdateExternalChatLinkTransactionResult,
  ): UpdateExternalChatLinkTransactionResult {
    switch (this.updateResultCorruption) {
      case 'scope':
        return { ...result, record: { ...result.record, workspaceId: 'workspace-other' } }
      case 'revision':
        return {
          ...result,
          record: {
            ...result.record,
            link: { ...result.record.link, revision: result.record.link.revision + 1 },
          },
        }
      case 'inactive':
        return { ...result, record: { ...result.record, active: false } }
      case undefined:
        return result
    }
  }

  /**
   * Applies one deliberate unlink receipt corruption for fail-closed service validation.
   *
   * @param result - Valid durable transaction result.
   * @returns Valid result or one deliberately invalid response projection.
   */
  private corruptUnlinkResult(
    result: UnlinkExternalChatLinkTransactionResult,
  ): UnlinkExternalChatLinkTransactionResult {
    switch (this.unlinkResultCorruption) {
      case 'scope':
        return { ...result, record: { ...result.record, workspaceId: 'workspace-other' } }
      case 'revision':
        return {
          ...result,
          record: {
            ...result.record,
            link: { ...result.record.link, revision: result.record.link.revision + 1 },
          },
        }
      case 'active':
        return { ...result, record: { ...result.record, active: true } }
      case undefined:
        return result
    }
  }
}

/** Recording idempotent security audit sink for failed link commands. */
class RecordingLinkFailureAuditPort implements ExternalChatLinkFailureAuditPort {
  /** Failed command records keyed idempotently by logical operation. */
  readonly records = new Map<string, ExternalChatLinkAuditRecord>()

  /** Records one secret-free failed command result. */
  async record(record: ExternalChatLinkAuditRecord): Promise<void> {
    this.records.set(record.operationId, record)
  }
}

/**
 * Creates the idempotency conflict emitted by the recording transaction receipt.
 *
 * @returns Stable command conflict.
 */
function idempotencyConflict(): ExternalChatError {
  return new ExternalChatError(
    'ExternalChatIdempotencyConflict',
    'The idempotency key is already bound to another command.',
  )
}

/**
 * Creates the tenant-safe missing-link error emitted by the recording transaction.
 *
 * @returns Stable not-found error.
 */
function transactionNotFound(): ExternalChatError {
  return new ExternalChatError('ExternalChatNotFound', 'The external chat link was not found.')
}

/**
 * Creates the optimistic revision conflict emitted by the recording transaction.
 *
 * @returns Stable revision conflict.
 */
function transactionRevisionConflict(): ExternalChatError {
  return new ExternalChatError(
    'ExternalChatRevisionConflict',
    'The external chat link revision changed.',
  )
}

/**
 * Creates a persistence error for an impossible recording transaction fixture result.
 *
 * @param operation - Atomic fixture operation that did not commit as expected.
 * @returns Stable persistence failure.
 */
function transactionCommitFailed(operation: string): ExternalChatError {
  return new ExternalChatError(
    'ExternalChatPersistenceFailed',
    `The recording ${operation} transaction did not commit.`,
  )
}

describe('ExternalChatLinkService', () => {
  test('passes an ID-free link draft to the atomic Work Item creation boundary', async () => {
    const fixture = createLinkServiceFixture()
    const context = createCommandContext('create-idempotency-key')
    const command = createWorkItemCommand()

    const first = await fixture.service.createWorkItemFromThread(context, command)
    const replay = await fixture.service.createWorkItemFromThread({
      ...context,
      correlationId: 'correlation-create-retry',
      occurredAt: retryOccurredAt,
    }, command)
    await expect(fixture.service.createWorkItemFromThread(context, {
      ...command,
      workItem: { ...command.workItem, title: 'A conflicting create payload' },
    })).rejects.toMatchObject({ code: 'ExternalChatIdempotencyConflict' })

    expect(fixture.access.teamCreateCalls).toEqual(['team-1', 'team-1', 'team-1'])
    expect(fixture.access.installationCalls).toEqual([
      'installation-slack',
      'installation-slack',
      'installation-slack',
    ])
    expect(fixture.adapter.resolvedSources).toHaveLength(3)
    expect(fixture.transactions.createInputs).toHaveLength(3)
    const transactionInput = requireCreateTransactionInput(fixture.transactions.createInputs[0])
    expect('workItemId' in transactionInput.linkDraft.link).toBeFalse()
    expect(transactionInput.linkDraft.workspaceId).toBe('workspace-1')
    expect(transactionInput.linkDraft.link.id).toStartWith('chat_link_')
    expect(transactionInput.linkDraft.authorizationRevision).toBe(4)
    expect(transactionInput.linkDraft.idempotencyKeyHash).toHaveLength(64)
    expect(transactionInput.linkDraft.idempotencyKeyHash).not.toContain(context.idempotencyKey)
    expect(transactionInput.audit).toMatchObject({
      outcome: 'applied',
      reasonCode: 'ExternalChatWorkItemCreated',
    })
    expect(first.workItem.id).toBe('work-item-created')
    expect(first.workItem).toMatchObject({
      priorityUpdatedAt: occurredAt,
      dueDateUpdatedAt: occurredAt,
      approvalSummary: {
        pendingCount: 1,
        updatedAt: retryOccurredAt,
      },
    })
    expect(first.link.workItemId).toBe(first.workItem.id)
    expect(replay).toEqual(first)
    expect(replay.link.createdAt).toBe(occurredAt)
    expect(fixture.transactions.createInputs[1]?.operationId).toBe(transactionInput.operationId)
    expect(fixture.transactions.committedAudits).toEqual([{
      ...transactionInput.audit,
      workItemId: first.workItem.id,
      linkId: first.link.id,
    }])
    expect((await fixture.store.getLink('workspace-1', first.link.id))?.active).toBeTrue()
  })

  test('rejects malformed causal timestamps returned by the creation transaction', async () => {
    const corruptions: CreateWorkItemResultCorruption[] = [
      'priority-noncanonical',
      'priority-before-created',
      'due-after-updated',
      'approval-noncanonical',
      'approval-before-created',
    ]

    for (const corruption of corruptions) {
      const fixture = createLinkServiceFixture()
      fixture.transactions.createWorkItemResultCorruption = corruption

      await expect(fixture.service.createWorkItemFromThread(
        createCommandContext(`create-corrupt-${corruption}`),
        createWorkItemCommand(),
      )).rejects.toMatchObject({ code: 'ExternalChatPersistenceFailed' })
    }
  })

  test('authorizes an existing Work Item before resolving or linking its provider source', async () => {
    const denied = createLinkServiceFixture()
    denied.access.denyWorkItemWrite = true
    const command = createLinkCommand()

    await expect(denied.service.linkThread(
      createCommandContext('denied-link-key'),
      command,
    )).rejects.toMatchObject({ code: 'ExternalChatAuthorizationFailed' })
    expect(denied.access.workItemCalls).toEqual([
      { teamId: 'team-1', workItemId: 'work-item-existing', mode: 'write' },
    ])
    expect(denied.adapter.resolvedSources).toHaveLength(0)
    expect(denied.transactions.linkInputs).toHaveLength(0)

    const allowed = createLinkServiceFixture()
    const result = await allowed.service.linkThread(
      createCommandContext('allowed-link-key'),
      command,
    )
    const replay = await allowed.service.linkThread({
      ...createCommandContext('allowed-link-key'),
      correlationId: 'correlation-link-retry',
      occurredAt: retryOccurredAt,
    }, command)
    const transactionInput = requireLinkTransactionInput(allowed.transactions.linkInputs[0])
    expect(transactionInput.link.link.workItemId).toBe('work-item-existing')
    expect(transactionInput.link.workspaceId).toBe('workspace-1')
    expect(transactionInput.link.authorizationRevision).toBe(4)
    expect(transactionInput.sourceThread).toEqual(createThreadSnapshot())
    expect(result.link).toEqual(transactionInput.link.link)
    expect(replay).toEqual(result)
    expect(replay.link.createdAt).toBe(occurredAt)
    expect(allowed.transactions.committedAudits[0]?.reasonCode).toBe('ExternalChatLinkCreated')
    expect((await allowed.store.getLink('workspace-1', result.link.id))?.active).toBeTrue()
  })

  test('rejects a quote that does not match the authorized provider snapshot before commit', async () => {
    const fixture = createLinkServiceFixture()
    const valid = createWorkItemCommand()
    const command: CreateWorkItemFromExternalChatThreadInput = {
      ...valid,
      source: {
        ...valid.source,
        quotedRange: {
          sourceMessageExternalId: 'message-reply',
          startOffset: 9,
          endOffset: 16,
          text: 'altered',
        },
      },
    }

    await expect(fixture.service.createWorkItemFromThread(
      createCommandContext('invalid-quote-key'),
      command,
    )).rejects.toMatchObject({ code: 'ExternalChatValidationFailed' })
    expect(fixture.adapter.resolvedSources).toHaveLength(1)
    expect(fixture.transactions.createInputs).toHaveLength(0)
    expect(fixture.transactions.committedAudits).toHaveLength(0)
    expect([...fixture.failureAudit.records.values()]).toEqual([
      expect.objectContaining({
        action: 'create-work-item',
        outcome: 'failed',
        reasonCode: 'ExternalChatValidationFailed',
      }),
    ])
  })

  test('rejects malformed source selection before internal or provider authorization', async () => {
    const fixture = createLinkServiceFixture()
    const valid = createWorkItemCommand()
    const command: CreateWorkItemFromExternalChatThreadInput = {
      ...valid,
      source: {
        ...valid.source,
        sourcePermalink: 'http://chat.example.test/messages/message-reply',
      },
    }

    await expect(fixture.service.createWorkItemFromThread(
      createCommandContext('invalid-source-key'),
      command,
    )).rejects.toMatchObject({ code: 'ExternalChatValidationFailed' })
    expect(fixture.access.teamCreateCalls).toHaveLength(0)
    expect(fixture.access.installationCalls).toHaveLength(0)
    expect(fixture.adapter.resolvedSources).toHaveLength(0)
    expect(fixture.transactions.createInputs).toHaveLength(0)
  })

  test('accepts resync state and its durable job through one atomic transaction boundary', async () => {
    const fixture = createLinkServiceFixture()
    const original = createStoredLink()
    await seedStoredLink(fixture.store, original)

    const result = await fixture.service.resyncLink(
      createCommandContext('resync-idempotency-key'),
      original.id,
      { expectedRevision: original.revision, mode: 'full' },
    )
    const replay = await fixture.service.resyncLink({
      ...createCommandContext('resync-idempotency-key'),
      correlationId: 'correlation-resync-retry',
      occurredAt: retryOccurredAt,
    }, original.id, { expectedRevision: original.revision, mode: 'full' })

    expect(fixture.transactions.resyncInputs).toHaveLength(2)
    const input = requireResyncTransactionInput(fixture.transactions.resyncInputs[0])
    expect(input.link).toMatchObject({ revision: 2, syncStatus: 'pending' })
    expect(input.job).toMatchObject({
      linkId: original.id,
      linkRevision: 2,
      authorizationRevision: 4,
      mode: 'full',
      operationId: input.operationId,
    })
    expect(input.idempotencyKeyHash).toHaveLength(64)
    expect(input.expectedSourceAuthorizationRevision).toBe(4)
    expect(input.authorizationRevision).toBe(4)
    expect(input.requestFingerprint).toHaveLength(64)
    expect(input.audit).toMatchObject({
      action: 'resync',
      outcome: 'applied',
      reasonCode: 'ExternalChatFullResyncQueued',
    })
    expect((await fixture.store.getLink('workspace-1', original.id))?.link.revision).toBe(2)
    expect(result.link).toMatchObject({ id: original.id, revision: 2, syncStatus: 'pending' })
    expect(replay).toEqual(result)
    expect(replay.acceptedAt).toBe(occurredAt)
    expect(result.link).not.toHaveProperty('installationId')
    expect(result.link).not.toHaveProperty('workspace')
    expect(result.link).not.toHaveProperty('conversation')
    expect(result.link).not.toHaveProperty('source')
    expect(fixture.transactions.committedAudits).toEqual([input.audit])
  })

  test('rejects resync acceptance from an older connector authorization generation', async () => {
    const fixture = createLinkServiceFixture()
    const original = createStoredLink()
    await seedStoredLink(fixture.store, original)
    fixture.access.authorizationRevision = 3

    await expect(fixture.service.resyncLink(
      createCommandContext('resync-old-authorization-key'),
      original.id,
      { expectedRevision: original.revision, mode: 'full' },
    )).rejects.toMatchObject({ code: 'ExternalChatAuthorizationFailed' })
    expect(fixture.transactions.resyncInputs).toHaveLength(0)
  })

  test('redacts provider source metadata from settings update results', async () => {
    const fixture = createLinkServiceFixture()
    const original = createStoredLink()
    await seedStoredLink(fixture.store, original)

    const result = await fixture.service.updateLink(
      createCommandContext('update-idempotency-key'),
      original.id,
      { expectedRevision: original.revision, syncDirection: 'none' },
    )

    expect(result.link).toMatchObject({
      id: original.id,
      revision: 2,
      syncDirection: 'none',
      syncStatus: 'paused',
    })
    expect(result.link).not.toHaveProperty('installationId')
    expect(result.link).not.toHaveProperty('workspace')
    expect(result.link).not.toHaveProperty('conversation')
    expect(result.link).not.toHaveProperty('source')
  })

  test('keeps restrictive deleted links paused when synchronization settings are enabled', async () => {
    const fixture = createLinkServiceFixture()
    const original: ExternalChatWorkItemLink = {
      ...createStoredLink(),
      sourceAvailability: 'permission-lost',
      sourceState: 'deleted',
      syncStatus: 'paused',
    }
    await seedStoredLink(fixture.store, original)

    const result = await fixture.service.updateLink(
      createCommandContext('update-restrictive-key'),
      original.id,
      { expectedRevision: original.revision, syncDirection: 'bidirectional' },
    )

    expect(result.link).toMatchObject({
      syncDirection: 'bidirectional',
      syncStatus: 'paused',
      sourceAvailability: 'permission-lost',
      sourceState: 'deleted',
    })
    const input = fixture.transactions.updateInputs[0]
    expect(input?.link.workspace).not.toHaveProperty('displayName')
    expect(input?.link.conversation).not.toHaveProperty('displayName')
    expect(input?.link.source).not.toHaveProperty('sourcePermalink')
  })

  test('settings update respects a restrictive parent fence published before child fan-out', async () => {
    const fixture = createLinkServiceFixture()
    const original = createStoredLink()
    await seedStoredLink(fixture.store, original)
    await fixture.store.fenceParentLifecycle({
      workspaceId: 'workspace-1',
      provider: 'slack',
      installationId: original.installationId,
      externalWorkspaceId: original.source.externalWorkspaceId,
      authorizationRevision: 4,
      availability: 'permission-lost',
      state: 'active',
      restrictive: true,
      eventId: 'workspace-restricted',
      operationId: 'workspace-restricted-operation',
      occurredAt: retryOccurredAt,
    })

    const result = await fixture.service.updateLink(
      createCommandContext('update-parent-restricted-key'),
      original.id,
      { expectedRevision: original.revision, syncDirection: 'inbound' },
    )

    expect(result.link).toMatchObject({
      syncDirection: 'inbound',
      syncStatus: 'paused',
      sourceAvailability: 'permission-lost',
    })
    expect(fixture.transactions.updateInputs[0]?.expectedParentLifecycleFences.workspace)
      .toMatchObject({ eventId: 'workspace-restricted', restrictive: true })
  })

  test('settings update cannot commit pending after a concurrent restrictive parent fence', async () => {
    const fixture = createLinkServiceFixture()
    const original = createStoredLink()
    await seedStoredLink(fixture.store, original)
    fixture.transactions.updateBeforeCommitHook = async () => {
      await fixture.store.fenceParentLifecycle({
        workspaceId: 'workspace-1',
        provider: 'slack',
        installationId: original.installationId,
        externalWorkspaceId: original.source.externalWorkspaceId,
        authorizationRevision: 4,
        availability: 'permission-lost',
        state: 'active',
        restrictive: true,
        eventId: 'workspace-concurrent-restriction',
        operationId: 'workspace-concurrent-restriction-operation',
        occurredAt: retryOccurredAt,
      })
    }

    await expect(fixture.service.updateLink(
      createCommandContext('update-concurrent-parent-key'),
      original.id,
      { expectedRevision: original.revision, syncDirection: 'inbound' },
    )).rejects.toMatchObject({ code: 'ExternalChatPersistenceFailed' })
    expect((await fixture.store.getLink('workspace-1', original.id))?.link).toMatchObject({
      revision: 1,
      syncStatus: 'synced',
    })
  })

  test('replays the exact update after response loss with one atomic final audit', async () => {
    const fixture = createLinkServiceFixture()
    const original = createStoredLink()
    await seedStoredLink(fixture.store, original)
    fixture.transactions.failUpdateAfterCommitOnce = true
    const context = createCommandContext('update-response-loss-key')
    const command = { expectedRevision: original.revision, syncDirection: 'none' } satisfies
      UpdateExternalChatWorkItemLinkInput

    await expect(fixture.service.updateLink(context, original.id, command))
      .rejects.toThrow('Simulated response loss')
    const replay = await fixture.service.updateLink({
      ...context,
      correlationId: 'correlation-update-retry',
      occurredAt: retryOccurredAt,
    }, original.id, command)

    expect(replay.link).toMatchObject({
      id: original.id,
      revision: 2,
      syncDirection: 'none',
      syncStatus: 'paused',
      updatedAt: occurredAt,
    })
    expect(fixture.transactions.updateInputs).toHaveLength(2)
    const input = requireUpdateTransactionInput(fixture.transactions.updateInputs[0])
    expect(input.idempotencyKeyHash).toHaveLength(64)
    expect(input.requestFingerprint).toHaveLength(64)
    expect(input.operationId).toBe(fixture.transactions.updateInputs[1]?.operationId)
    expect(input.audit).toMatchObject({
      action: 'update',
      outcome: 'applied',
      reasonCode: 'ExternalChatLinkUpdated',
    })
    expect(input.audit).not.toHaveProperty('source')
    expect(fixture.transactions.committedAudits).toEqual([input.audit])
    expect((await fixture.store.getLink('workspace-1', original.id))?.link.revision).toBe(2)
  })

  test('rejects another update payload that reuses a committed idempotency key', async () => {
    const fixture = createLinkServiceFixture()
    const original = createStoredLink()
    await seedStoredLink(fixture.store, original)
    const context = createCommandContext('update-conflicting-payload-key')

    await fixture.service.updateLink(context, original.id, {
      expectedRevision: original.revision,
      syncDirection: 'none',
    })
    await expect(fixture.service.updateLink(context, original.id, {
      expectedRevision: original.revision,
      syncDirection: 'inbound',
    })).rejects.toMatchObject({ code: 'ExternalChatIdempotencyConflict' })

    expect(fixture.transactions.updateInputs).toHaveLength(2)
    expect(fixture.transactions.committedAudits).toHaveLength(1)
    expect((await fixture.store.getLink('workspace-1', original.id))?.link.syncDirection)
      .toBe('none')
  })

  test('replays the exact unlink after response loss without a second mutation or audit', async () => {
    const fixture = createLinkServiceFixture()
    const original = createStoredLink()
    await seedStoredLink(fixture.store, original)
    fixture.transactions.failUnlinkAfterCommitOnce = true
    const context = createCommandContext('unlink-response-loss-key')
    const command = { expectedRevision: original.revision }

    await expect(fixture.service.unlinkThread(context, original.id, command))
      .rejects.toThrow('Simulated response loss')
    const replay = await fixture.service.unlinkThread({
      ...context,
      correlationId: 'correlation-unlink-retry',
      occurredAt: retryOccurredAt,
    }, original.id, command)

    expect(replay).toEqual({ linkId: original.id, unlinkedAt: occurredAt })
    expect(fixture.transactions.unlinkInputs).toHaveLength(2)
    const input = requireUnlinkTransactionInput(fixture.transactions.unlinkInputs[0])
    expect(input.idempotencyKeyHash).toHaveLength(64)
    expect(input.requestFingerprint).toHaveLength(64)
    expect(input.operationId).toBe(fixture.transactions.unlinkInputs[1]?.operationId)
    expect(input.audit).toMatchObject({
      action: 'unlink',
      outcome: 'applied',
      reasonCode: 'ExternalChatLinkUnlinked',
    })
    expect(fixture.transactions.committedAudits).toEqual([input.audit])
    expect(await fixture.store.getLinkBySource('workspace-1', {
      provider: original.provider,
      externalWorkspaceId: original.source.externalWorkspaceId,
      conversationExternalId: original.source.conversationExternalId,
      threadExternalId: original.source.threadExternalId,
    })).toBeUndefined()
  })

  test('fails closed on update transaction scope, revision, or active-state corruption', async () => {
    const corruptions: UpdateResultCorruption[] = ['scope', 'revision', 'inactive']
    for (const corruption of corruptions) {
      const fixture = createLinkServiceFixture()
      const original = createStoredLink()
      await seedStoredLink(fixture.store, original)
      fixture.transactions.updateResultCorruption = corruption

      await expect(fixture.service.updateLink(
        createCommandContext(`update-corrupt-${corruption}`),
        original.id,
        { expectedRevision: original.revision, syncDirection: 'none' },
      )).rejects.toMatchObject({ code: 'ExternalChatPersistenceFailed' })
    }
  })

  test('fails closed on unlink transaction scope, revision, or active-state corruption', async () => {
    const corruptions: UnlinkResultCorruption[] = ['scope', 'revision', 'active']
    for (const corruption of corruptions) {
      const fixture = createLinkServiceFixture()
      const original = createStoredLink()
      await seedStoredLink(fixture.store, original)
      fixture.transactions.unlinkResultCorruption = corruption

      await expect(fixture.service.unlinkThread(
        createCommandContext(`unlink-corrupt-${corruption}`),
        original.id,
        { expectedRevision: original.revision },
      )).rejects.toMatchObject({ code: 'ExternalChatPersistenceFailed' })
    }
  })

  test('replays a duplicate merge receipt before CAS and conflicts key reuse', async () => {
    const fixture = createLinkServiceFixture()
    const duplicateLink: ExternalChatWorkItemLink = {
      ...createStoredLink(),
      teamId: 'team-duplicate',
      workItemId: 'work-item-duplicate',
    }
    await seedStoredLink(fixture.store, duplicateLink)
    const context = createCommandContext('merge-response-loss-key')
    const command = createMergeCommand(duplicateLink)
    fixture.transactions.failMergeAfterCommitOnce = true

    await expect(fixture.service.mergeDuplicateLinks(context, command))
      .rejects.toThrow('Simulated response loss')
    const replay = await fixture.service.mergeDuplicateLinks({
      ...context,
      correlationId: 'correlation-merge-retry',
      occurredAt: retryOccurredAt,
    }, command)

    expect(replay.mergedAt).toBe(occurredAt)
    expect(replay.movedLinks).toHaveLength(1)
    expect(replay.movedLinks[0]).toMatchObject({
      id: duplicateLink.id,
      teamId: 'team-canonical',
      workItemId: 'work-item-canonical',
      revision: duplicateLink.revision + 1,
    })
    expect(replay.movedLinks[0]).not.toHaveProperty('installationId')
    expect(replay.movedLinks[0]).not.toHaveProperty('source')
    expect(fixture.transactions.mergeInputs).toHaveLength(2)
    const input = fixture.transactions.mergeInputs[0]
    expect(input?.idempotencyKeyHash).toHaveLength(64)
    expect(input?.requestFingerprint).toHaveLength(64)
    expect(input?.storeMutation).toMatchObject({
      expectedDuplicateLinkGeneration: 1,
      expectedDuplicateLinkCount: 1,
    })
    expect(input?.audit).toMatchObject({
      action: 'merge',
      outcome: 'applied',
      reasonCode: 'ExternalChatMergeCompleted',
    })
    expect(fixture.transactions.committedAudits).toEqual([input?.audit])
    expect([...fixture.failureAudit.records.values()][0]).toMatchObject({
      action: 'merge',
      outcome: 'failed',
      reasonCode: 'ExternalChatCommandFailed',
    })
    expect(fixture.access.workItemCalls.at(-1)).toEqual({
      teamId: 'team-canonical',
      workItemId: 'work-item-canonical',
      mode: 'write',
    })
    expect((await fixture.store.getLink('workspace-1', duplicateLink.id))?.link)
      .toMatchObject({ teamId: 'team-canonical', workItemId: 'work-item-canonical' })

    await expect(fixture.service.mergeDuplicateLinks(context, {
      ...command,
      expectedCanonicalWorkItemRevision: command.expectedCanonicalWorkItemRevision + 1,
    })).rejects.toMatchObject({ code: 'ExternalChatIdempotencyConflict' })
    expect(fixture.transactions.committedAudits).toHaveLength(1)
  })

  test('rejects a duplicate redirect set returned by the merge transaction', async () => {
    const fixture = createLinkServiceFixture()
    const duplicateLink: ExternalChatWorkItemLink = {
      ...createStoredLink(),
      workItemId: 'work-item-duplicate',
    }
    await seedStoredLink(fixture.store, duplicateLink)
    fixture.transactions.mergeResultCorruption = 'duplicate-redirect'

    await expect(fixture.service.mergeDuplicateLinks(
      createCommandContext('merge-duplicate-redirect-key'),
      createMergeCommand(duplicateLink),
    )).rejects.toMatchObject({ code: 'ExternalChatPersistenceFailed' })
  })

  test('rejects a redirect whose provider differs from its moved link', async () => {
    const fixture = createLinkServiceFixture()
    const duplicateLink: ExternalChatWorkItemLink = {
      ...createStoredLink(),
      workItemId: 'work-item-duplicate',
    }
    await seedStoredLink(fixture.store, duplicateLink)
    fixture.transactions.mergeResultCorruption = 'provider'

    await expect(fixture.service.mergeDuplicateLinks(
      createCommandContext('merge-provider-redirect-key'),
      createMergeCommand(duplicateLink),
    )).rejects.toMatchObject({ code: 'ExternalChatPersistenceFailed' })
  })

  test('resolves a former duplicate to a source-redacted canonical Work Item route', async () => {
    const fixture = createLinkServiceFixture()
    const original: ExternalChatWorkItemLink = {
      ...createStoredLink(),
      workItemId: 'work-item-duplicate',
    }
    await seedStoredLink(fixture.store, original)
    const duplicateManifest = await fixture.store.getWorkItemLinkManifest(
      'workspace-1',
      original.teamId,
      original.workItemId,
    )
    if (!duplicateManifest) throw new Error('Expected the duplicate owner manifest.')
    const merged = await fixture.store.mergeLinks({
      workspaceId: 'workspace-1',
      canonicalTeamId: 'team-1',
      canonicalWorkItemId: 'work-item-canonical',
      duplicateTeamId: original.teamId,
      duplicateWorkItemId: original.workItemId,
      links: [{ linkId: original.id, expectedRevision: original.revision }],
      expectedDuplicateLinkGeneration: duplicateManifest.generation,
      expectedDuplicateLinkCount: duplicateManifest.activeLinkCount,
      mergedAt: occurredAt,
    })
    if (merged.kind !== 'merged') throw new Error('Expected the redirect fixture to merge.')

    const route = await fixture.service.resolveCanonicalRedirect(
      createCommandContext('redirect-key').principal,
      original.teamId,
      original.workItemId,
    )

    expect(route).toEqual({
      fromTeamId: original.teamId,
      fromWorkItemId: original.workItemId,
      canonicalTeamId: 'team-1',
      canonicalWorkItemId: 'work-item-canonical',
      createdAt: occurredAt,
    })
    expect(route).not.toHaveProperty('linkId')
    expect(route).not.toHaveProperty('provider')
    expect(route).not.toHaveProperty('threadExternalId')
    expect(fixture.access.workItemCalls.at(-1)).toEqual({
      teamId: 'team-1',
      workItemId: 'work-item-canonical',
      mode: 'read',
    })
  })
})

/**
 * Creates an isolated link service fixture.
 *
 * @returns Service and recording boundary implementations.
 */
function createLinkServiceFixture(): LinkServiceFixture {
  const access = new RecordingLinkAccessPort()
  const adapter = new RecordingLinkProviderAdapter(createThreadSnapshot())
  const store = new InMemoryExternalChatStore()
  const transactions = new RecordingLinkTransactionPort(store, access)
  const failureAudit = new RecordingLinkFailureAuditPort()
  const service = new ExternalChatLinkService({
    access,
    adapters: new ChatProviderAdapterRegistry([adapter]),
    store,
    transactions,
    failureAudit,
  })
  return { service, access, adapter, transactions, store, failureAudit }
}

/** Creates one collision-safe fixture key for former and canonical Work Item routes. */
function workItemRouteKey(teamId: string, workItemId: string): string {
  return `${teamId}\0${workItemId}`
}

/**
 * Creates one active durable link for command-boundary tests.
 *
 * @returns Provider-authorized link with revision one.
 */
function createStoredLink(): ExternalChatWorkItemLink {
  const thread = createThreadSnapshot()
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    id: 'chat-link-existing',
    teamId: 'team-1',
    workItemId: 'work-item-existing',
    installationId: 'installation-slack',
    provider: 'slack',
    workspace: thread.workspace,
    conversation: thread.conversation,
    source: createThreadReference(),
    syncDirection: 'bidirectional',
    syncStatus: 'synced',
    sourceAvailability: 'available',
    sourceState: 'active',
    revision: 1,
    lastSyncedAt: occurredAt,
    lastSourceObservedAt: occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
}

/**
 * Creates one revision-fenced duplicate merge command for a seeded fixture link.
 *
 * @param duplicateLink - Link owned by the duplicate Work Item before merge.
 * @returns Valid provider-neutral duplicate merge command.
 */
function createMergeCommand(
  duplicateLink: ExternalChatWorkItemLink,
): MergeExternalChatWorkItemLinksInput {
  return {
    canonicalTeamId: 'team-canonical',
    canonicalWorkItemId: 'work-item-canonical',
    expectedCanonicalWorkItemRevision: 1,
    duplicateTeamId: duplicateLink.teamId,
    duplicateWorkItemId: duplicateLink.workItemId,
    expectedDuplicateWorkItemRevision: 1,
    links: [{ linkId: duplicateLink.id, expectedRevision: duplicateLink.revision }],
  }
}

/**
 * Projects one durable fixture link to its source-redacted command result.
 *
 * @param link - Full durable provider-neutral link.
 * @returns Source-redacted link summary.
 */
function toFixtureLinkSummary(
  link: ExternalChatWorkItemLink,
): MergeExternalChatWorkItemLinksResult['movedLinks'][number] {
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
 * Seeds one active link through the store's source-claim transaction.
 *
 * @param store - Durable in-memory store under test.
 * @param link - Link to persist.
 */
async function seedStoredLink(
  store: InMemoryExternalChatStore,
  link: ExternalChatWorkItemLink,
): Promise<void> {
  const result = await store.createLink({
    workspaceId: 'workspace-1',
    link,
    authorizationRevision: 4,
    source: {
      provider: link.provider,
      externalWorkspaceId: link.source.externalWorkspaceId,
      conversationExternalId: link.source.conversationExternalId,
      threadExternalId: link.source.threadExternalId,
    },
    idempotencyKeyHash: createExternalChatFingerprint(`seed-idempotency-hash-${link.id}`),
    requestFingerprint: createExternalChatFingerprint(`seed-request-fingerprint-${link.id}`),
  })
  if (result.kind !== 'created') throw new Error('Expected the link fixture to be created.')
}

/**
 * Creates a valid retryable command context.
 *
 * @param idempotencyKey - Raw request key retained only at the application boundary.
 * @returns Valid command context.
 */
function createCommandContext(idempotencyKey: string): ExternalChatLinkCommandContext {
  return {
    principal: { workspaceId: 'workspace-1', memberKey: 'member-1' },
    idempotencyKey,
    correlationId: 'correlation-link-test',
    occurredAt,
  }
}

/**
 * Creates a valid provider thread source locator.
 *
 * @returns Source selecting a quoted reply.
 */
function createThreadReference(): ExternalChatThreadSelection {
  return {
    externalWorkspaceId: 'external-workspace-1',
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
    rootMessageExternalId: 'message-root',
    sourceMessageExternalId: 'message-reply',
    sourcePermalink: 'https://chat.example.test/messages/message-reply',
    quotedRange: {
      sourceMessageExternalId: 'message-reply',
      startOffset: 9,
      endOffset: 16,
      text: 'details',
    },
  }
}

/**
 * Creates one permission-filtered provider thread snapshot.
 *
 * @returns Authorized snapshot containing the selected source message.
 */
function createThreadSnapshot(): ExternalChatThreadSnapshot {
  const root = createMessage('message-root', 'Root incident')
  const reply = createMessage('message-reply', 'Incident details', 'message-root')
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    workspace: {
      provider: 'slack',
      externalId: 'external-workspace-1',
      displayName: 'Operations',
    },
    conversation: {
      externalId: 'conversation-1',
      externalWorkspaceId: 'external-workspace-1',
      kind: 'channel',
      displayName: 'incidents',
    },
    externalId: 'thread-1',
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
}

/**
 * Creates one provider-neutral message fixture.
 *
 * @param externalId - Provider-scoped message identifier.
 * @param bodyMarkdown - Normalized message body.
 * @param parentMessageExternalId - Optional parent provider message.
 * @returns Permission-filtered message snapshot.
 */
function createMessage(
  externalId: string,
  bodyMarkdown: string,
  parentMessageExternalId?: string,
): ExternalChatMessage {
  return {
    externalId,
    externalVersion: '1',
    conversationExternalId: 'conversation-1',
    threadExternalId: 'thread-1',
    ...(parentMessageExternalId ? { parentMessageExternalId } : {}),
    permalink: `https://chat.example.test/messages/${externalId}`,
    availability: 'available',
    state: 'active',
    actor: { externalId: 'actor-1', kind: 'person', displayName: 'Operator' },
    bodyMarkdown,
    quotedRanges: [],
    attachments: [],
    postedAt: occurredAt,
    updatedAt: occurredAt,
  }
}

/**
 * Creates a valid command for creating a Work Item from chat.
 *
 * @returns Provider-neutral create command.
 */
function createWorkItemCommand(): CreateWorkItemFromExternalChatThreadInput {
  return {
    teamId: 'team-1',
    installationId: 'installation-slack',
    source: createThreadReference(),
    workItem: {
      title: 'Investigate incident',
      description: 'Imported from an authorized chat source.',
      assigneeUserId: 'user-1',
      schedule: {
        mode: 'unscheduled',
        calendarPolicy: {
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          holidays: [],
        },
      },
      priority: 'high',
    },
    syncDirection: 'bidirectional',
  }
}

/**
 * Creates a valid command for linking an existing Work Item.
 *
 * @returns Provider-neutral link command.
 */
function createLinkCommand(): LinkExternalChatThreadInput {
  return {
    teamId: 'team-1',
    workItemId: 'work-item-existing',
    installationId: 'installation-slack',
    source: createThreadReference(),
    syncDirection: 'bidirectional',
  }
}

/**
 * Materializes a canonical Work Item as the atomic transaction result.
 *
 * @param workItemId - Assigned canonical Work Item identifier.
 * @param command - Original create command.
 * @returns Canonical fixture Work Item.
 */
function createCanonicalWorkItem(
  workItemId: string,
  command: CreateWorkItemFromExternalChatThreadInput,
): CanonicalWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: workItemId,
    teamId: command.teamId,
    title: command.workItem.title,
    description: command.workItem.description,
    assigneeUserId: command.workItem.assigneeUserId,
    creatorMemberKey: 'member-1',
    dueDate: '',
    schedule: command.workItem.schedule,
    priority: command.workItem.priority,
    priorityUpdatedAt: occurredAt,
    dueDateUpdatedAt: occurredAt,
    workflowStatusId: 'status-todo',
    statusCategory: 'unstarted',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    createdAt: occurredAt,
    updatedAt: occurredAt,
    approvalSummary: {
      pendingCount: 1,
      overdueCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      changesRequestedCount: 0,
      updatedAt: retryOccurredAt,
    },
    source: 'dynamodb',
  }
}

/**
 * Requires a captured create transaction input.
 *
 * @param input - Possibly missing captured input.
 * @returns Captured transaction input.
 */
function requireCreateTransactionInput(
  input: CreateWorkItemAndExternalChatLinkTransactionInput | undefined,
): CreateWorkItemAndExternalChatLinkTransactionInput {
  if (!input) throw new Error('Expected a create transaction input.')
  return input
}

/**
 * Requires a captured existing-link transaction input.
 *
 * @param input - Possibly missing captured input.
 * @returns Captured transaction input.
 */
function requireLinkTransactionInput(
  input: LinkExistingWorkItemToExternalChatTransactionInput | undefined,
): LinkExistingWorkItemToExternalChatTransactionInput {
  if (!input) throw new Error('Expected an existing-link transaction input.')
  return input
}

/**
 * Requires a captured update transaction input.
 *
 * @param input - Possibly missing captured input.
 * @returns Captured update transaction input.
 */
function requireUpdateTransactionInput(
  input: UpdateExternalChatLinkTransactionInput | undefined,
): UpdateExternalChatLinkTransactionInput {
  if (!input) throw new Error('Expected an update transaction input.')
  return input
}

/**
 * Requires a captured unlink transaction input.
 *
 * @param input - Possibly missing captured input.
 * @returns Captured unlink transaction input.
 */
function requireUnlinkTransactionInput(
  input: UnlinkExternalChatLinkTransactionInput | undefined,
): UnlinkExternalChatLinkTransactionInput {
  if (!input) throw new Error('Expected an unlink transaction input.')
  return input
}

/**
 * Requires a captured resynchronization transaction input.
 *
 * @param input - Possibly missing captured input.
 * @returns Captured resynchronization transaction input.
 */
function requireResyncTransactionInput(
  input: AcceptExternalChatResyncTransactionInput | undefined,
): AcceptExternalChatResyncTransactionInput {
  if (!input) throw new Error('Expected a resynchronization transaction input.')
  return input
}
