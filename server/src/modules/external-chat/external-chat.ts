import { createHash, randomUUID } from 'node:crypto'
import type {
  ExternalChatCanonicalRedirect,
  ExternalChatInboundEvent,
  ExternalChatMessageBinding,
  ExternalChatProvider,
  ExternalChatSyncCursor,
  ExternalChatSyncOutcome,
  ExternalChatWorkItemLink,
} from '@mukuroji/contracts'

/** Stable application error raised by the external chat synchronization boundary. */
export class ExternalChatError extends Error {
  /** Stable machine-readable error code. */
  readonly code: ExternalChatErrorCode

  /** Whether retrying the same logical operation can recover. */
  readonly retryable: boolean

  /**
   * Creates an external chat application error.
   *
   * @param code - Stable machine-readable error code.
   * @param message - Secret-free diagnostic message.
   * @param retryable - Whether the same logical operation may be retried.
   */
  constructor(code: ExternalChatErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'ExternalChatError'
    this.code = code
    this.retryable = retryable
  }
}

/** Stable errors exposed by the external chat application boundary. */
export type ExternalChatErrorCode =
  | 'ExternalChatValidationFailed'
  | 'ExternalChatAuthorizationFailed'
  | 'ExternalChatNotFound'
  | 'ExternalChatRevisionConflict'
  | 'ExternalChatSourceAlreadyLinked'
  | 'ExternalChatIdempotencyConflict'
  | 'ExternalChatEventConflict'
  | 'ExternalChatOperationConflict'
  | 'ExternalChatSourceUnavailable'
  | 'ExternalChatRateLimited'
  | 'ExternalChatPersistenceFailed'

/** Tenant-scoped identity used for every external chat persistence operation. */
export type ExternalChatTenantScope = {
  /** Canonical Workspace identifier. */
  workspaceId: string
}

/** Fields shared by internal mutations eligible for outbound synchronization. */
export type ExternalChatSyncOutboundEventBase = ExternalChatTenantScope & {
  /** External chat link identifier. */
  linkId: string
  /** Team that owns the source Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Authenticated internal principal that initiated the mutation. */
  principalId: string
  /** Correlation identifier propagated across the mutation. */
  correlationId: string
  /** Internal occurrence timestamp. */
  occurredAt: string
  /** Whether policy explicitly allows this internal mutation to leave the Workspace. */
  externalSyncEligible: boolean
}

/** Internal comment creation eligible for one provider reply. */
export type ExternalChatSyncCommentCreatedEvent = ExternalChatSyncOutboundEventBase & {
  /** Event discriminator. */
  type: 'comment.created'
  /** Canonical collaboration comment identifier. */
  internalCommentId: string
  /** Current internal comment version. */
  internalCommentVersion: number
  /** Normalized Markdown body allowed to leave the Workspace. */
  bodyMarkdown: string
}

/** Internal comment edit eligible for one provider message edit. */
export type ExternalChatSyncCommentEditedEvent = ExternalChatSyncOutboundEventBase & {
  /** Event discriminator. */
  type: 'comment.edited'
  /** Canonical collaboration comment identifier. */
  internalCommentId: string
  /** Current internal comment version. */
  internalCommentVersion: number
  /** Replacement normalized Markdown body allowed to leave the Workspace. */
  bodyMarkdown: string
}

/** Internal comment deletion eligible for one provider message deletion. */
export type ExternalChatSyncCommentDeletedEvent = ExternalChatSyncOutboundEventBase & {
  /** Event discriminator. */
  type: 'comment.deleted'
  /** Canonical collaboration comment identifier. */
  internalCommentId: string
  /** Current internal tombstone version. */
  internalCommentVersion: number
  /** Internal deletion timestamp. */
  deletedAt: string
}

/** Internal Work Item completion eligible for a provider thread transition. */
export type ExternalChatSyncWorkItemCompletedEvent = ExternalChatSyncOutboundEventBase & {
  /** Event discriminator. */
  type: 'work-item.completed'
  /** Current Work Item revision. */
  workItemRevision: number
}

/** Internal Work Item reopen eligible for a provider thread transition. */
export type ExternalChatSyncWorkItemReopenedEvent = ExternalChatSyncOutboundEventBase & {
  /** Event discriminator. */
  type: 'work-item.reopened'
  /** Current Work Item revision. */
  workItemRevision: number
}

/** Provider-neutral internal mutation accepted by outbound synchronization. */
export type ExternalChatSyncOutboundEvent =
  | ExternalChatSyncCommentCreatedEvent
  | ExternalChatSyncCommentEditedEvent
  | ExternalChatSyncCommentDeletedEvent
  | ExternalChatSyncWorkItemCompletedEvent
  | ExternalChatSyncWorkItemReopenedEvent

/** Canonical identity of one provider thread, independent of an installation. */
export type ExternalChatSourceIdentity = {
  /** Provider that owns the source. */
  provider: ExternalChatProvider
  /** Provider-scoped workspace or tenant identifier. */
  externalWorkspaceId: string
  /** Provider-scoped conversation identifier. */
  conversationExternalId: string
  /** Provider-scoped thread identifier. */
  threadExternalId: string
}

/** Stored external chat link with tenant and lifecycle metadata. */
export type StoredExternalChatLink = ExternalChatTenantScope & {
  /** Public provider-neutral link snapshot. */
  link: ExternalChatWorkItemLink
  /** Digest used by the unique source claim. */
  sourceDigest: string
  /** Provider authorization generation used to resolve this immutable source claim. */
  sourceAuthorizationRevision: number
  /** Whether the link still accepts synchronization operations. */
  active: boolean
  /** Timestamp at which the link was detached. */
  unlinkedAt?: string
}

/** Durable normalized inbound webhook receipt. */
export type ExternalChatInboundReceipt = ExternalChatTenantScope & {
  /** Connector installation that authenticated the event. */
  installationId: string
  /** Provider that emitted the event. */
  provider: ExternalChatProvider
  /** Stable provider event identifier. */
  eventId: string
  /** Digest of the complete normalized event. */
  fingerprint: string
  /** Stable operation identifier shared by all retries. */
  operationId: string
  /** Current receipt processing state. */
  state: 'processing' | 'completed'
  /** Number of claims made for this logical delivery. */
  attempt: number
  /** Lease expiry used to recover an interrupted processor. */
  leaseExpiresAt: string
  /** Final outcome once processing completes. */
  outcome?: ExternalChatSyncOutcome
  /** Opaque next-page cursor for a durable workspace/conversation lifecycle fan-out. */
  parentLifecycleCursor?: string
  /** Receipt creation timestamp. */
  createdAt: string
  /** Receipt update timestamp. */
  updatedAt: string
}

/** Input used to atomically claim one normalized inbound provider event. */
export type ClaimExternalChatInboundEventInput = ExternalChatTenantScope & {
  /** Connector installation that authenticated the event. */
  installationId: string
  /** Provider that emitted the event. */
  provider: ExternalChatProvider
  /** Stable provider event identifier. */
  eventId: string
  /** Digest of the complete normalized event. */
  fingerprint: string
  /** Deterministic operation identifier derived from the event scope. */
  operationId: string
  /** Claim timestamp. */
  claimedAt: string
  /** Lease expiry used to recover an interrupted processor. */
  leaseExpiresAt: string
}

/** Result of atomically claiming one normalized inbound provider event. */
export type ClaimExternalChatInboundEventResult =
  | {
    /** A new receipt was created and the caller owns the lease. */
    kind: 'claimed'
    /** Current durable receipt. */
    receipt: ExternalChatInboundReceipt
  }
  | {
    /** An expired lease was recovered for another attempt. */
    kind: 'resumed'
    /** Current durable receipt. */
    receipt: ExternalChatInboundReceipt
  }
  | {
    /** The same normalized event already completed. */
    kind: 'duplicate'
    /** Completed durable receipt. */
    receipt: ExternalChatInboundReceipt
  }
  | {
    /** The same event ID was reused with another normalized payload. */
    kind: 'conflict'
    /** Existing durable receipt whose fingerprint did not match. */
    receipt: ExternalChatInboundReceipt
  }
  | {
    /** Another processor still owns the unexpired receipt lease. */
    kind: 'busy'
    /** Current durable receipt. */
    receipt: ExternalChatInboundReceipt
  }

/** Input used to commit the final result of one claimed inbound event. */
export type CompleteExternalChatInboundEventInput = ExternalChatTenantScope & {
  /** Connector installation that authenticated the event. */
  installationId: string
  /** Provider that emitted the event. */
  provider: ExternalChatProvider
  /** Stable provider event identifier. */
  eventId: string
  /** Operation identifier that owns the receipt lease. */
  operationId: string
  /** Receipt attempt that owns the current lease. */
  expectedAttempt: number
  /** Final auditable synchronization outcome. */
  outcome: ExternalChatSyncOutcome
  /** Completion timestamp. */
  completedAt: string
}

/** Input used to checkpoint and renew one claimed parent lifecycle fan-out receipt. */
export type CheckpointExternalChatInboundEventInput = ExternalChatTenantScope & {
  /** Connector installation that authenticated the parent event. */
  installationId: string
  /** Provider that emitted the parent event. */
  provider: ExternalChatProvider
  /** Stable provider event identifier. */
  eventId: string
  /** Operation identifier that owns the receipt lease. */
  operationId: string
  /** Receipt attempt that owns the current lease. */
  expectedAttempt: number
  /** Previously committed opaque parent lookup cursor. */
  expectedCursor?: string
  /** Opaque next-page cursor returned by the parent link lookup. */
  nextCursor: string
  /** Checkpoint timestamp. */
  checkpointedAt: string
  /** Renewed lease expiry for continued fan-out processing. */
  leaseExpiresAt: string
}

/** Input for listing active links under a provider workspace or conversation parent. */
export type ListExternalChatParentLinksInput = ExternalChatTenantScope & {
  /** Provider that owns the parent resource. */
  provider: ExternalChatProvider
  /** Connector installation whose consent generation owns the links. */
  installationId: string
  /** Provider-scoped workspace identifier. */
  externalWorkspaceId: string
  /** Optional provider-scoped conversation identifier for a narrower fan-out. */
  conversationExternalId?: string
  /** Latest source-resolution generation eligible for this parent event. */
  maximumSourceAuthorizationRevision: number
  /** Opaque continuation returned by a previous lookup page. */
  cursor?: string
  /** Maximum active links returned in this page. */
  limit: number
}

/** One deterministic page of active links under a provider parent resource. */
export type ListExternalChatParentLinksResult = {
  /** Active links in stable provider-conversation/link order. */
  links: StoredExternalChatLink[]
  /** Opaque continuation for the next page, when one remains. */
  nextCursor?: string
}

/** Durable provider-parent lifecycle generation that fences concurrent link creation. */
export type ExternalChatParentLifecycleFence = ExternalChatTenantScope & {
  /** Provider that owns the parent resource. */
  provider: ExternalChatProvider
  /** Connector installation whose authorization generation emitted the lifecycle event. */
  installationId: string
  /** Provider-scoped workspace identifier. */
  externalWorkspaceId: string
  /** Optional conversation identifier for a conversation-scoped fence. */
  conversationExternalId?: string
  /** Provider authorization generation current when the event was verified. */
  authorizationRevision: number
  /** Whether new links at this generation must fail closed. */
  restrictive: boolean
  /** Stable provider event identifier. */
  eventId: string
  /** Stable internal operation identifier that owns the fence update. */
  operationId: string
  /** Provider occurrence timestamp used for deterministic same-generation ordering. */
  occurredAt: string
}

/** Input for publishing one provider-parent lifecycle fence before fan-out. */
export type FenceExternalChatParentLifecycleInput = Omit<
  ExternalChatParentLifecycleFence,
  'authorizationRevision'
> & {
  /**
   * Verified authorization generation. A replay may omit it only after the same operation
   * already committed its durable fence.
   */
  authorizationRevision?: number
}

/** Result of publishing one provider-parent lifecycle fence. */
export type FenceExternalChatParentLifecycleResult =
  | {
    /** The incoming lifecycle generation became authoritative. */
    kind: 'applied'
    /** Durable authoritative parent fence. */
    fence: ExternalChatParentLifecycleFence
  }
  | {
    /** The same operation replayed its already committed fence. */
    kind: 'replayed'
    /** Durable authoritative parent fence. */
    fence: ExternalChatParentLifecycleFence
  }
  | {
    /** A newer or deterministically later parent lifecycle event already won. */
    kind: 'stale'
    /** Current durable authoritative parent fence. */
    fence: ExternalChatParentLifecycleFence
  }

/** Durable receipt for one logical outbound provider mutation. */
export type ExternalChatOutboundReceipt = ExternalChatTenantScope & {
  /** External chat link that owns the mutation. */
  linkId: string
  /** Stable operation identifier shared by all retries. */
  operationId: string
  /** Digest of the complete normalized outbound mutation. */
  fingerprint: string
  /** Current receipt processing state. */
  state: 'processing' | 'completed'
  /** Number of claims made for this logical mutation. */
  attempt: number
  /** Lease expiry used to recover an interrupted processor. */
  leaseExpiresAt: string
  /** Final outcome once processing completes. */
  outcome?: ExternalChatSyncOutcome
  /** Receipt creation timestamp. */
  createdAt: string
  /** Receipt update timestamp. */
  updatedAt: string
}

/** Input used to atomically claim one logical outbound mutation. */
export type ClaimExternalChatOutboundOperationInput = ExternalChatTenantScope & {
  /** External chat link that owns the mutation. */
  linkId: string
  /** Stable operation identifier shared by all retries. */
  operationId: string
  /** Digest of the complete normalized outbound mutation. */
  fingerprint: string
  /** Claim timestamp. */
  claimedAt: string
  /** Lease expiry used to recover an interrupted processor. */
  leaseExpiresAt: string
}

/** Result of atomically claiming one logical outbound mutation. */
export type ClaimExternalChatOutboundOperationResult =
  | {
    /** A new receipt was created and the caller owns the lease. */
    kind: 'claimed'
    /** Current durable receipt. */
    receipt: ExternalChatOutboundReceipt
  }
  | {
    /** An expired lease was recovered. */
    kind: 'resumed'
    /** Current durable receipt. */
    receipt: ExternalChatOutboundReceipt
  }
  | {
    /** The same logical mutation already completed. */
    kind: 'duplicate'
    /** Completed durable receipt. */
    receipt: ExternalChatOutboundReceipt
  }
  | {
    /** The operation ID was reused with another mutation. */
    kind: 'conflict'
    /** Existing receipt whose fingerprint did not match. */
    receipt: ExternalChatOutboundReceipt
  }
  | {
    /** Another processor still owns the unexpired lease. */
    kind: 'busy'
    /** Current durable receipt. */
    receipt: ExternalChatOutboundReceipt
  }

/** Input used to commit one claimed outbound mutation result. */
export type CompleteExternalChatOutboundOperationInput = ExternalChatTenantScope & {
  /** External chat link that owns the mutation. */
  linkId: string
  /** Stable operation identifier that owns the receipt lease. */
  operationId: string
  /** Receipt attempt that owns the current lease. */
  expectedAttempt: number
  /** Final auditable synchronization outcome. */
  outcome: ExternalChatSyncOutcome
  /** Completion timestamp. */
  completedAt: string
}

/** Last committed completion state for one linked provider thread. */
export type ExternalChatThreadLifecycleState = {
  /** Last authoritative observed completion state of the linked provider thread. */
  completed: boolean
  /** Last provider revision committed by a lifecycle operation. */
  lastExternalVersion?: string
  /** Last internal Work Item revision committed by a lifecycle operation. */
  lastInternalWorkItemRevision?: number
  /** Store-owned lifecycle revision, starting at zero before the first commit. */
  revision: number
  /** Timestamp of the baseline claim or latest committed lifecycle state. */
  updatedAt: string
}

/** Exclusive processing lease for one linked provider thread lifecycle transition. */
export type ExternalChatThreadLifecycleLease = {
  /** Stable logical operation identifier shared by retries. */
  operationId: string
  /** Monotonically increasing lease attempt for the link lifecycle row. */
  attempt: number
  /** Whether the attempt is processing, awaiting outer acknowledgement, or acknowledged. */
  status: 'processing' | 'completed' | 'acknowledged'
  /** Timestamp after which a processing lease may be recovered. */
  leaseExpiresAt: string
  /** Timestamp at which the current attempt committed. */
  completedAt?: string
  /** Exact synchronization outcome committed by the current completed attempt. */
  completedOutcome?: ExternalChatSyncOutcome
}

/** Durable provider- and link-scoped lifecycle state with a link-ownership epoch. */
export type StoredExternalChatThreadLifecycle = ExternalChatTenantScope & {
  /** External chat link that owns this lifecycle state. */
  linkId: string
  /** Provider that owns the linked thread. */
  provider: ExternalChatProvider
  /** Link revision that most recently claimed or moved this row. */
  ownerLinkRevision: number
  /** Last committed authoritative provider-thread completion state and ordering watermarks. */
  state: ExternalChatThreadLifecycleState
  /** Current or most recently completed exclusive processing lease. */
  lease: ExternalChatThreadLifecycleLease
}

/** Input used to claim exclusive processing for one thread lifecycle transition. */
export type ClaimExternalChatThreadLifecycleInput = ExternalChatTenantScope & {
  /** External chat link that owns the thread. */
  linkId: string
  /** Expected provider of the linked thread. */
  provider: ExternalChatProvider
  /** Link revision observed before lifecycle processing begins. */
  expectedLinkRevision: number
  /** Stable logical operation identifier shared by retries. */
  operationId: string
  /** Claim timestamp. */
  claimedAt: string
  /** Timestamp after which an interrupted claim may be recovered. */
  leaseExpiresAt: string
}

/** Result of claiming exclusive processing for one linked thread lifecycle. */
export type ClaimExternalChatThreadLifecycleResult =
  | {
    /** A new operation owns the lifecycle processing lease. */
    kind: 'claimed'
    /** Current durable lifecycle record and committed state. */
    record: StoredExternalChatThreadLifecycle
  }
  | {
    /** The same operation recovered its expired processing lease. */
    kind: 'resumed'
    /** Current durable lifecycle record and committed state. */
    record: StoredExternalChatThreadLifecycle
  }
  | {
    /** Another active or unacknowledged attempt still owns the lifecycle fence. */
    kind: 'busy'
    /** Current durable lifecycle record and committed state. */
    record: StoredExternalChatThreadLifecycle
  }
  | {
    /** The same logical operation already committed its lifecycle state. */
    kind: 'completed'
    /** Completed durable lifecycle record and committed state. */
    record: StoredExternalChatThreadLifecycle
  }

/** Input used to commit the state produced by one lifecycle lease attempt. */
export type CompleteExternalChatThreadLifecycleInput = ExternalChatTenantScope & {
  /** External chat link that owns the thread. */
  linkId: string
  /** Expected provider of the linked thread. */
  provider: ExternalChatProvider
  /** Link revision that fenced the claimed operation. */
  expectedLinkRevision: number
  /** Operation identifier that owns the processing lease. */
  operationId: string
  /** Lease attempt that owns the processing lease. */
  expectedAttempt: number
  /** Complete next committed lifecycle state. */
  nextState: ExternalChatThreadLifecycleState
  /** Exact auditable outcome to return when the completed operation replays. */
  outcome: ExternalChatSyncOutcome
  /** Completion timestamp, which must match the next state's update timestamp. */
  completedAt: string
}

/** Input used to release a completed lifecycle result after its outer receipt is durable. */
export type AcknowledgeExternalChatThreadLifecycleInput = ExternalChatTenantScope & {
  /** External chat link that owns the thread. */
  linkId: string
  /** Expected provider of the linked thread. */
  provider: ExternalChatProvider
  /** Completed operation whose replay result is now durable elsewhere. */
  operationId: string
  /** Completed lease attempt being acknowledged. */
  expectedAttempt: number
}

/** Link creation input coupled to a unique source and idempotency claim. */
export type CreateExternalChatLinkInput = ExternalChatTenantScope & {
  /** New provider-neutral link. */
  link: ExternalChatWorkItemLink
  /** Canonical source identity claimed by the link. */
  source: ExternalChatSourceIdentity
  /** Provider authorization generation that was current when the source was resolved. */
  authorizationRevision: number
  /** Digest of the tenant-scoped idempotency key. */
  idempotencyKeyHash: string
  /** Digest of the complete normalized command. */
  requestFingerprint: string
}

/** Result of creating a unique, idempotent external chat link. */
export type CreateExternalChatLinkResult =
  | {
    /** A new link and source claim were created. */
    kind: 'created'
    /** Stored link. */
    record: StoredExternalChatLink
  }
  | {
    /** The same idempotency key and request replayed a prior success. */
    kind: 'replayed'
    /** Previously stored link. */
    record: StoredExternalChatLink
  }
  | {
    /** Another active link already owns the source. */
    kind: 'source-conflict'
    /** Existing source owner. */
    record: StoredExternalChatLink
  }
  | {
    /** The idempotency key was reused with another request. */
    kind: 'idempotency-conflict'
  }
  | {
    /** A newer or restrictive provider-parent lifecycle fence rejected this new link. */
    kind: 'parent-restricted'
  }

/** Optimistic update input for one external chat link. */
export type UpdateExternalChatLinkInput = ExternalChatTenantScope & {
  /** Complete replacement link snapshot. */
  link: ExternalChatWorkItemLink
  /** Previously observed link revision. */
  expectedRevision: number
  /** Lifecycle owner authorizing a post-completion projection update. */
  lifecycleOperationId?: string
  /** Exact parent lifecycle authority that must still own an atomic fan-out projection. */
  expectedParentLifecycleFence?: ExternalChatParentLifecycleFence
}

/** Result of an optimistic external chat link update. */
export type UpdateExternalChatLinkResult =
  | {
    /** The replacement was committed. */
    kind: 'updated'
    /** Updated stored link. */
    record: StoredExternalChatLink
  }
  | {
    /** The link does not exist in the tenant. */
    kind: 'not-found'
  }
  | {
    /** The link revision changed before the update. */
    kind: 'conflict'
    /** Current stored link. */
    record: StoredExternalChatLink
  }
  | {
    /** A newer parent lifecycle fence superseded the fan-out projection. */
    kind: 'parent-stale'
  }

/** Unlink input fenced by the previously observed link revision. */
export type UnlinkExternalChatLinkInput = ExternalChatTenantScope & {
  /** Stable link identifier. */
  linkId: string
  /** Previously observed link revision. */
  expectedRevision: number
  /** Lifecycle owner authorizing a post-completion unlink projection. */
  lifecycleOperationId?: string
  /** Unlink timestamp. */
  unlinkedAt: string
}

/** Result of unlinking one external chat link. */
export type UnlinkExternalChatLinkResult =
  | {
    /** The active link was detached. */
    kind: 'unlinked'
    /** Stored inactive link tombstone. */
    record: StoredExternalChatLink
  }
  | {
    /** The same link was already detached. */
    kind: 'replayed'
    /** Stored inactive link tombstone. */
    record: StoredExternalChatLink
  }
  | {
    /** The link does not exist in the tenant. */
    kind: 'not-found'
  }
  | {
    /** The link revision changed before unlinking. */
    kind: 'conflict'
    /** Current stored link. */
    record: StoredExternalChatLink
  }

/** Stored message binding with an independent persistence revision. */
export type StoredExternalChatMessageBinding = ExternalChatTenantScope & {
  /** Provider-neutral message-to-comment binding. */
  binding: ExternalChatMessageBinding
  /** Optimistic persistence revision. */
  storageRevision: number
}

/** Optimistic message binding write input. */
export type PutExternalChatMessageBindingInput = ExternalChatTenantScope & {
  /** Complete replacement binding. */
  binding: ExternalChatMessageBinding
  /** Team that must still own the link when the binding commits. */
  expectedTeamId: string
  /** Work Item that must still own the link when the binding commits. */
  expectedWorkItemId: string
  /** Public link revision observed before the internal or provider side effect. */
  expectedLinkRevision: number
  /** Previously observed persistence revision, omitted for a create. */
  expectedStorageRevision?: number
}

/** Result of an optimistic message binding write. */
export type PutExternalChatMessageBindingResult =
  | {
    /** The binding was created or replaced. */
    kind: 'stored'
    /** Current stored binding. */
    record: StoredExternalChatMessageBinding
  }
  | {
    /** The external or internal message identity belongs to another binding. */
    kind: 'identity-conflict'
    /** Conflicting stored binding. */
    record: StoredExternalChatMessageBinding
  }
  | {
    /** The expected persistence revision did not match. */
    kind: 'revision-conflict'
    /** Current stored binding when it still exists. */
    record?: StoredExternalChatMessageBinding
  }
  | {
    /** The link was detached, merged, or changed ownership before the binding committed. */
    kind: 'owner-conflict'
    /** Current link when it still exists in the tenant. */
    record?: StoredExternalChatLink
  }

/** Deferred normalized event retained for out-of-order or upstream recovery. */
export type DeferredExternalChatEvent = ExternalChatTenantScope & {
  /** Link that should eventually consume the event. */
  linkId: string
  /** Complete normalized event. */
  event: ExternalChatInboundEvent
  /** Digest of the normalized event. */
  fingerprint: string
  /** Stable defer reason. */
  reason: 'out-of-order' | 'rate-limited' | 'source-unavailable'
  /** Number of processing attempts. */
  attempt: number
  /** Earliest processing timestamp. */
  retryAt: string
  /** First defer timestamp. */
  createdAt: string
  /** Latest defer timestamp. */
  updatedAt: string
}

/** Durable outbound mutation retained until its receipt and audit become terminal. */
export type DeferredExternalChatOutboundEvent = ExternalChatTenantScope & {
  /** Link whose FIFO owns the deferred mutation. */
  linkId: string
  /** Complete normalized internal mutation. */
  event: ExternalChatSyncOutboundEvent
  /** Digest of the complete normalized mutation. */
  fingerprint: string
  /** Stable receipt and provider idempotency identity. */
  operationId: string
  /** Latest durable receipt processing attempt. */
  attempt: number
  /** Earliest timestamp at which the FIFO head may be retried. */
  retryAt: string
  /** Timestamp at which this mutation first entered the durable queue. */
  createdAt: string
  /** Timestamp of the latest retry scheduling decision. */
  updatedAt: string
}

/** Duplicate merge persistence input for link-owned chat state. */
export type MergeExternalChatLinksStoreInput = ExternalChatTenantScope & {
  /** Canonical Team identifier. */
  canonicalTeamId: string
  /** Canonical Work Item identifier. */
  canonicalWorkItemId: string
  /** Duplicate Team identifier. */
  duplicateTeamId: string
  /** Duplicate Work Item identifier. */
  duplicateWorkItemId: string
  /** Link identifiers and revisions selected by the caller. */
  links: ReadonlyArray<{
    /** Link identifier to move. */
    linkId: string
    /** Previously observed link revision. */
    expectedRevision: number
  }>
  /** Merge completion timestamp. */
  mergedAt: string
}

/** Result of atomically retargeting link-owned state during a duplicate merge. */
export type MergeExternalChatLinksStoreResult =
  | {
    /** All selected links were moved. */
    kind: 'merged'
    /** Retargeted public links. */
    movedLinks: ExternalChatWorkItemLink[]
    /** Durable old-to-canonical redirects. */
    redirects: ExternalChatCanonicalRedirect[]
    /** Internal scanned file identifiers retained through the move. */
    movedFileIds: string[]
    /** Number of link-owned message bindings retained through the move. */
    movedMessageBindingCount: number
  }
  | {
    /** A selected link or revision no longer matched. */
    kind: 'conflict'
  }

/** Durable tenant-scoped persistence required by external chat synchronization. */
export interface ExternalChatStore {
  /** Creates a link, source claim, and idempotency receipt atomically. */
  createLink(input: CreateExternalChatLinkInput): Promise<CreateExternalChatLinkResult>
  /** Reads one link without crossing its tenant partition. */
  getLink(workspaceId: string, linkId: string): Promise<StoredExternalChatLink | undefined>
  /** Resolves the active link that uniquely owns a provider thread. */
  getLinkBySource(
    workspaceId: string,
    source: ExternalChatSourceIdentity,
  ): Promise<StoredExternalChatLink | undefined>
  /** Replaces one link when its optimistic revision still matches. */
  updateLink(input: UpdateExternalChatLinkInput): Promise<UpdateExternalChatLinkResult>
  /** Detaches one link and releases its active source claim. */
  unlinkLink(input: UnlinkExternalChatLinkInput): Promise<UnlinkExternalChatLinkResult>
  /** Claims or recovers one inbound event receipt. */
  claimInboundEvent(
    input: ClaimExternalChatInboundEventInput,
  ): Promise<ClaimExternalChatInboundEventResult>
  /** Commits the final outcome for the operation that owns an event receipt. */
  completeInboundEvent(input: CompleteExternalChatInboundEventInput): Promise<boolean>
  /** Checkpoints a parent lifecycle fan-out only for its current receipt lease owner. */
  checkpointInboundEvent(input: CheckpointExternalChatInboundEventInput): Promise<boolean>
  /** Publishes the authoritative parent lifecycle generation before enumerating child links. */
  fenceParentLifecycle(
    input: FenceExternalChatParentLifecycleInput,
  ): Promise<FenceExternalChatParentLifecycleResult>
  /** Lists active links owned by one provider workspace or conversation parent. */
  listParentLinks(
    input: ListExternalChatParentLinksInput,
  ): Promise<ListExternalChatParentLinksResult>
  /** Claims or recovers one outbound operation receipt. */
  claimOutboundOperation(
    input: ClaimExternalChatOutboundOperationInput,
  ): Promise<ClaimExternalChatOutboundOperationResult>
  /** Commits the final outcome for the operation that owns an outbound receipt. */
  completeOutboundOperation(
    input: CompleteExternalChatOutboundOperationInput,
  ): Promise<boolean>
  /** Checks whether an authenticated echoed operation already completed outbound. */
  hasCompletedOutboundOperation(
    workspaceId: string,
    linkId: string,
    operationId: string,
  ): Promise<boolean>
  /** Reads the durable lifecycle state for one linked provider thread. */
  getThreadLifecycle(
    workspaceId: string,
    linkId: string,
    provider: ExternalChatProvider,
  ): Promise<StoredExternalChatThreadLifecycle | undefined>
  /** Claims or recovers exclusive processing for one thread lifecycle transition. */
  claimThreadLifecycle(
    input: ClaimExternalChatThreadLifecycleInput,
  ): Promise<ClaimExternalChatThreadLifecycleResult>
  /** Commits one lifecycle transition only for its current fenced lease attempt. */
  completeThreadLifecycle(input: CompleteExternalChatThreadLifecycleInput): Promise<boolean>
  /** Releases one completed lifecycle result after the outer operation receipt commits. */
  acknowledgeThreadLifecycle(
    input: AcknowledgeExternalChatThreadLifecycleInput,
  ): Promise<boolean>
  /** Reads a binding by provider message identity. */
  getMessageBindingByExternalId(
    workspaceId: string,
    linkId: string,
    externalMessageId: string,
  ): Promise<StoredExternalChatMessageBinding | undefined>
  /** Reads a binding by internal collaboration comment identity. */
  getMessageBindingByInternalId(
    workspaceId: string,
    linkId: string,
    internalCommentId: string,
  ): Promise<StoredExternalChatMessageBinding | undefined>
  /** Creates or replaces one identity-unique binding while fencing its exact active link owner. */
  putMessageBinding(
    input: PutExternalChatMessageBindingInput,
  ): Promise<PutExternalChatMessageBindingResult>
  /** Reads one private provider traversal cursor. */
  getSyncCursor(workspaceId: string, linkId: string): Promise<ExternalChatSyncCursor | undefined>
  /** Advances one private provider traversal cursor with optimistic concurrency. */
  putSyncCursor(
    workspaceId: string,
    cursor: ExternalChatSyncCursor,
    expectedRevision?: number,
  ): Promise<boolean>
  /** Idempotently retains one deferred normalized event. */
  deferEvent(event: DeferredExternalChatEvent): Promise<void>
  /** Lists due deferred events for one link in deterministic occurrence order. */
  listDueDeferredEvents(
    workspaceId: string,
    linkId: string,
    dueAt: string,
    limit: number,
  ): Promise<DeferredExternalChatEvent[]>
  /** Removes one provider- and installation-scoped deferred event after its outcome commits. */
  deleteDeferredEvent(
    workspaceId: string,
    provider: ExternalChatProvider,
    installationId: string,
    eventId: string,
  ): Promise<void>
  /** Purges deferred content owned by a restrictive link, except the current event when requested. */
  purgeDeferredEventsForLink(
    workspaceId: string,
    linkId: string,
    excludedEventId?: string,
  ): Promise<number>
  /** Idempotently retains one deferred outbound mutation before its receipt completes. */
  deferOutboundEvent(event: DeferredExternalChatOutboundEvent): Promise<void>
  /** Lists one link FIFO in deterministic internal occurrence order without skipping its head. */
  listDeferredOutboundEvents(
    workspaceId: string,
    linkId: string,
    limit: number,
  ): Promise<DeferredExternalChatOutboundEvent[]>
  /** Removes one fully scoped outbound mutation only after its terminal audit commits. */
  deleteDeferredOutboundEvent(
    workspaceId: string,
    linkId: string,
    operationId: string,
  ): Promise<void>
  /** Atomically retargets link-owned state and creates canonical redirects. */
  mergeLinks(input: MergeExternalChatLinksStoreInput): Promise<MergeExternalChatLinksStoreResult>
  /** Resolves a former duplicate Work Item to its canonical target. */
  getCanonicalRedirect(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    linkId?: string,
  ): Promise<ExternalChatCanonicalRedirect | undefined>
}

/** In-memory implementation used by deterministic application and adapter contract tests. */
export class InMemoryExternalChatStore implements ExternalChatStore {
  /** Tenant-scoped links by stable link ID. */
  private readonly links = new Map<string, StoredExternalChatLink>()

  /** Active unique source claims mapped to link IDs. */
  private readonly sourceClaims = new Map<string, string>()

  /** Link command receipts mapped to link IDs. */
  private readonly linkReceipts = new Map<string, {
    /** Digest of the original normalized command. */
    requestFingerprint: string
    /** Created link ID. */
    linkId: string
  }>()

  /** Inbound provider event receipts. */
  private readonly inboundReceipts = new Map<string, ExternalChatInboundReceipt>()

  /** Outbound provider mutation receipts. */
  private readonly outboundReceipts = new Map<string, ExternalChatOutboundReceipt>()

  /** Provider- and link-scoped thread lifecycle records. */
  private readonly threadLifecycles = new Map<string, StoredExternalChatThreadLifecycle>()

  /** Message bindings by external identity. */
  private readonly externalBindings = new Map<string, StoredExternalChatMessageBinding>()

  /** Message bindings by internal identity. */
  private readonly internalBindings = new Map<string, StoredExternalChatMessageBinding>()

  /** Provider traversal cursors by link. */
  private readonly cursors = new Map<string, ExternalChatSyncCursor>()

  /** Deferred events by provider event identity. */
  private readonly deferredEvents = new Map<string, DeferredExternalChatEvent>()

  /** Deferred outbound mutations by tenant, link, and stable operation identity. */
  private readonly deferredOutboundEvents = new Map<string, DeferredExternalChatOutboundEvent>()

  /** Canonical redirects by former Work Item and moved-link identity. */
  private readonly redirects = new Map<string, ExternalChatCanonicalRedirect>()

  /** Navigation redirects by former Work Item identity. */
  private readonly redirectRoutes = new Map<string, ExternalChatCanonicalRedirect>()

  /** Authoritative provider-parent lifecycle generations that fence new links. */
  private readonly parentLifecycleFences = new Map<
    string,
    ExternalChatParentLifecycleFence
  >()

  /** Creates a link, source claim, and idempotency receipt atomically in memory. */
  async createLink(input: CreateExternalChatLinkInput): Promise<CreateExternalChatLinkResult> {
    const receiptKey = key(input.workspaceId, input.idempotencyKeyHash)
    const receipt = this.linkReceipts.get(receiptKey)
    if (receipt) {
      if (receipt.requestFingerprint !== input.requestFingerprint) {
        return { kind: 'idempotency-conflict' }
      }
      const replayed = this.links.get(key(input.workspaceId, receipt.linkId))
      if (!replayed) {
        throw new ExternalChatError(
          'ExternalChatPersistenceFailed',
          'The link receipt refers to missing durable state.',
        )
      }
      return { kind: 'replayed', record: replayed }
    }

    const authorizationRevision = requireLifecyclePositiveInteger(
      input.authorizationRevision,
      'provider authorization revision',
    )
    const parentFences = [
      this.parentLifecycleFences.get(parentLifecycleFenceKey(
        input.workspaceId,
        input.source.provider,
        input.link.installationId,
        input.source.externalWorkspaceId,
        undefined,
      )),
      this.parentLifecycleFences.get(parentLifecycleFenceKey(
        input.workspaceId,
        input.source.provider,
        input.link.installationId,
        input.source.externalWorkspaceId,
        input.source.conversationExternalId,
      )),
    ]
    if (parentFences.some((fence) =>
      fence !== undefined && parentLifecycleFenceBlocks(fence, authorizationRevision)
    )) return { kind: 'parent-restricted' }

    const sourceDigest = createExternalChatSourceDigest(input.source)
    const sourceClaimKey = key(input.workspaceId, sourceDigest)
    const claimedLinkId = this.sourceClaims.get(sourceClaimKey)
    if (claimedLinkId) {
      const claimed = this.links.get(key(input.workspaceId, claimedLinkId))
      if (!claimed) {
        throw new ExternalChatError(
          'ExternalChatPersistenceFailed',
          'The source claim refers to missing durable state.',
        )
      }
      return { kind: 'source-conflict', record: claimed }
    }

    const record: StoredExternalChatLink = {
      workspaceId: input.workspaceId,
      link: input.link,
      sourceDigest,
      sourceAuthorizationRevision: authorizationRevision,
      active: true,
    }
    this.links.set(key(input.workspaceId, input.link.id), record)
    this.sourceClaims.set(sourceClaimKey, input.link.id)
    this.linkReceipts.set(receiptKey, {
      requestFingerprint: input.requestFingerprint,
      linkId: input.link.id,
    })
    return { kind: 'created', record }
  }

  /** Reads one link from its tenant partition. */
  async getLink(workspaceId: string, linkId: string): Promise<StoredExternalChatLink | undefined> {
    return this.links.get(key(workspaceId, linkId))
  }

  /** Resolves the active link that owns a provider thread. */
  async getLinkBySource(
    workspaceId: string,
    source: ExternalChatSourceIdentity,
  ): Promise<StoredExternalChatLink | undefined> {
    const linkId = this.sourceClaims.get(key(workspaceId, createExternalChatSourceDigest(source)))
    return linkId ? this.links.get(key(workspaceId, linkId)) : undefined
  }

  /** Publishes one authoritative provider-parent lifecycle generation before child fan-out. */
  async fenceParentLifecycle(
    input: FenceExternalChatParentLifecycleInput,
  ): Promise<FenceExternalChatParentLifecycleResult> {
    const normalized = normalizeParentLifecycleFenceInput(input)
    const fenceKey = parentLifecycleFenceKey(
      normalized.workspaceId,
      normalized.provider,
      normalized.installationId,
      normalized.externalWorkspaceId,
      normalized.conversationExternalId,
    )
    const current = this.parentLifecycleFences.get(fenceKey)
    if (current && parentLifecycleFenceReplays(current, normalized)) {
      return { kind: 'replayed', fence: current }
    }
    if (current && normalized.authorizationRevision === undefined) {
      return { kind: 'stale', fence: current }
    }
    if (normalized.authorizationRevision === undefined) {
      throw new ExternalChatError(
        'ExternalChatValidationFailed',
        'A new parent lifecycle fence requires its verified authorization revision.',
      )
    }
    const candidate = createParentLifecycleFence(
      normalized,
      normalized.authorizationRevision,
    )
    if (current && compareParentLifecycleFences(candidate, current) <= 0) {
      return { kind: 'stale', fence: current }
    }
    this.parentLifecycleFences.set(fenceKey, candidate)
    return { kind: 'applied', fence: candidate }
  }

  /** Lists active links under one provider workspace or conversation parent. */
  async listParentLinks(
    input: ListExternalChatParentLinksInput,
  ): Promise<ListExternalChatParentLinksResult> {
    const maximumSourceAuthorizationRevision = requireLifecyclePositiveInteger(
      input.maximumSourceAuthorizationRevision,
      'maximum source authorization revision',
    )
    const candidates = [...this.links.values()]
      .filter((record) =>
        record.workspaceId === input.workspaceId &&
        record.active &&
        record.sourceAuthorizationRevision <= maximumSourceAuthorizationRevision &&
        record.link.provider === input.provider &&
        record.link.installationId === input.installationId &&
        record.link.source.externalWorkspaceId === input.externalWorkspaceId &&
        (
          input.conversationExternalId === undefined ||
          record.link.source.conversationExternalId === input.conversationExternalId
        ) &&
        (input.cursor === undefined || parentLinkCursor(record) > input.cursor)
      )
      .sort((left, right) => compareOrdinal(parentLinkCursor(left), parentLinkCursor(right)))
    const links = candidates.slice(0, Math.max(0, input.limit))
    const last = links.at(-1)
    return {
      links,
      ...(last !== undefined && candidates.length > links.length
        ? { nextCursor: parentLinkCursor(last) }
        : {}),
    }
  }

  /** Replaces one link when its optimistic revision matches. */
  async updateLink(input: UpdateExternalChatLinkInput): Promise<UpdateExternalChatLinkResult> {
    const recordKey = key(input.workspaceId, input.link.id)
    const current = this.links.get(recordKey)
    if (!current) return { kind: 'not-found' }
    if (input.expectedParentLifecycleFence !== undefined) {
      const expectedFence = normalizeExpectedParentLifecycleFenceForLink(
        input.expectedParentLifecycleFence,
        current,
      )
      const currentFence = this.parentLifecycleFences.get(parentLifecycleFenceKey(
        expectedFence.workspaceId,
        expectedFence.provider,
        expectedFence.installationId,
        expectedFence.externalWorkspaceId,
        expectedFence.conversationExternalId,
      ))
      if (!currentFence || !sameParentLifecycleFence(currentFence, expectedFence)) {
        return { kind: 'parent-stale' }
      }
    }
    if (current.link.revision !== input.expectedRevision) {
      return { kind: 'conflict', record: current }
    }
    validateInMemoryLinkReplacement(current, input.link)
    const lifecycleOperationId = input.lifecycleOperationId === undefined
      ? undefined
      : requireLifecycleIdentifier(
          input.lifecycleOperationId,
          'thread lifecycle operation ID',
        )
    const lifecycleKey = threadLifecycleKey(
      input.workspaceId,
      current.link.id,
      current.link.provider,
    )
    const lifecycle = this.threadLifecycles.get(lifecycleKey)
    if (lifecycle) {
      validateThreadLifecycleScope(
        lifecycle,
        input.workspaceId,
        current.link.id,
        current.link.provider,
      )
      if (!threadLifecycleAllowsLinkMutation(lifecycle, lifecycleOperationId)) {
        return { kind: 'conflict', record: current }
      }
    }
    if (input.link.revision !== input.expectedRevision + 1) {
      throw new ExternalChatError(
        'ExternalChatValidationFailed',
        'The replacement link revision must advance exactly once.',
      )
    }
    const updated: StoredExternalChatLink = {
      ...current,
      link: input.link,
    }
    this.links.set(recordKey, updated)
    if (lifecycle) {
      this.threadLifecycles.set(lifecycleKey, {
        ...lifecycle,
        ownerLinkRevision: updated.link.revision,
      })
    }
    return { kind: 'updated', record: updated }
  }

  /** Detaches one link and releases its active source claim. */
  async unlinkLink(input: UnlinkExternalChatLinkInput): Promise<UnlinkExternalChatLinkResult> {
    const recordKey = key(input.workspaceId, input.linkId)
    const current = this.links.get(recordKey)
    if (!current) return { kind: 'not-found' }
    if (!current.active) return { kind: 'replayed', record: current }
    if (current.link.revision !== input.expectedRevision) {
      return { kind: 'conflict', record: current }
    }
    const lifecycleOperationId = input.lifecycleOperationId === undefined
      ? undefined
      : requireLifecycleIdentifier(
          input.lifecycleOperationId,
          'thread lifecycle operation ID',
        )
    const lifecycle = this.threadLifecycles.get(
      threadLifecycleKey(input.workspaceId, current.link.id, current.link.provider),
    )
    if (lifecycle) {
      validateThreadLifecycleScope(
        lifecycle,
        input.workspaceId,
        current.link.id,
        current.link.provider,
      )
      if (!threadLifecycleAllowsLinkMutation(lifecycle, lifecycleOperationId)) {
        return { kind: 'conflict', record: current }
      }
    }
    const unlinked: StoredExternalChatLink = {
      ...current,
      active: false,
      unlinkedAt: input.unlinkedAt,
    }
    this.links.set(recordKey, unlinked)
    this.sourceClaims.delete(key(input.workspaceId, current.sourceDigest))
    return { kind: 'unlinked', record: unlinked }
  }

  /** Claims, recovers, or deduplicates one inbound event receipt. */
  async claimInboundEvent(
    input: ClaimExternalChatInboundEventInput,
  ): Promise<ClaimExternalChatInboundEventResult> {
    const receiptKey = key(input.workspaceId, input.provider, input.installationId, input.eventId)
    const current = this.inboundReceipts.get(receiptKey)
    if (!current) {
      const receipt: ExternalChatInboundReceipt = {
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        provider: input.provider,
        eventId: input.eventId,
        fingerprint: input.fingerprint,
        operationId: input.operationId,
        state: 'processing',
        attempt: 1,
        leaseExpiresAt: input.leaseExpiresAt,
        createdAt: input.claimedAt,
        updatedAt: input.claimedAt,
      }
      this.inboundReceipts.set(receiptKey, receipt)
      return { kind: 'claimed', receipt }
    }
    if (current.fingerprint !== input.fingerprint) {
      return { kind: 'conflict', receipt: current }
    }
    if (current.state === 'completed') {
      if (
        !isRetryableOutboundReceiptDue(current.outcome, input.claimedAt)
      ) {
        return { kind: 'duplicate', receipt: current }
      }
      const resumed: ExternalChatInboundReceipt = {
        ...withoutInboundReceiptOutcome(current),
        operationId: input.operationId,
        state: 'processing',
        attempt: current.attempt + 1,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.claimedAt,
      }
      this.inboundReceipts.set(receiptKey, resumed)
      return { kind: 'resumed', receipt: resumed }
    }
    if (Date.parse(current.leaseExpiresAt) > Date.parse(input.claimedAt)) {
      return { kind: 'busy', receipt: current }
    }
    const resumed: ExternalChatInboundReceipt = {
      ...current,
      operationId: input.operationId,
      attempt: current.attempt + 1,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.claimedAt,
    }
    this.inboundReceipts.set(receiptKey, resumed)
    return { kind: 'resumed', receipt: resumed }
  }

  /** Commits an inbound outcome only for the operation that owns the receipt. */
  async completeInboundEvent(input: CompleteExternalChatInboundEventInput): Promise<boolean> {
    if (!matchesInboundOutcomeScope(input.outcome, input.operationId, input.eventId)) {
      return false
    }
    const receiptKey = key(
      input.workspaceId,
      input.provider,
      input.installationId,
      input.eventId,
    )
    const current = this.inboundReceipts.get(receiptKey)
    if (!current) return false
    if (
      current.operationId !== input.operationId ||
      current.attempt !== input.expectedAttempt
    ) return false
    if (current.state === 'completed') {
      return syncOutcomesEqual(current.outcome, input.outcome)
    }
    this.inboundReceipts.set(receiptKey, {
      ...current,
      state: 'completed',
      outcome: input.outcome,
      updatedAt: input.completedAt,
    })
    return true
  }

  /** Checkpoints and renews one claimed parent lifecycle fan-out receipt. */
  async checkpointInboundEvent(
    input: CheckpointExternalChatInboundEventInput,
  ): Promise<boolean> {
    const receiptKey = key(
      input.workspaceId,
      input.provider,
      input.installationId,
      input.eventId,
    )
    const current = this.inboundReceipts.get(receiptKey)
    if (
      !current ||
      current.state !== 'processing' ||
      current.operationId !== input.operationId ||
      current.attempt !== input.expectedAttempt
    ) return false
    if (current.parentLifecycleCursor === input.nextCursor) return true
    if (current.parentLifecycleCursor !== input.expectedCursor) return false
    this.inboundReceipts.set(receiptKey, {
      ...current,
      parentLifecycleCursor: input.nextCursor,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.checkpointedAt,
    })
    return true
  }

  /** Claims, recovers, or deduplicates one outbound provider mutation. */
  async claimOutboundOperation(
    input: ClaimExternalChatOutboundOperationInput,
  ): Promise<ClaimExternalChatOutboundOperationResult> {
    const receiptKey = key(input.workspaceId, input.linkId, input.operationId)
    const current = this.outboundReceipts.get(receiptKey)
    if (!current) {
      const receipt: ExternalChatOutboundReceipt = {
        workspaceId: input.workspaceId,
        linkId: input.linkId,
        operationId: input.operationId,
        fingerprint: input.fingerprint,
        state: 'processing',
        attempt: 1,
        leaseExpiresAt: input.leaseExpiresAt,
        createdAt: input.claimedAt,
        updatedAt: input.claimedAt,
      }
      this.outboundReceipts.set(receiptKey, receipt)
      return { kind: 'claimed', receipt }
    }
    if (current.fingerprint !== input.fingerprint) {
      return { kind: 'conflict', receipt: current }
    }
    if (current.state === 'completed') {
      if (
        current.outcome?.kind !== 'deferred' ||
        current.outcome.retryAt === undefined ||
        current.outcome.retryAt > input.claimedAt
      ) {
        return { kind: 'duplicate', receipt: current }
      }
      const resumed: ExternalChatOutboundReceipt = {
        workspaceId: current.workspaceId,
        linkId: current.linkId,
        operationId: current.operationId,
        fingerprint: current.fingerprint,
        state: 'processing',
        attempt: current.attempt + 1,
        leaseExpiresAt: input.leaseExpiresAt,
        createdAt: current.createdAt,
        updatedAt: input.claimedAt,
      }
      this.outboundReceipts.set(receiptKey, resumed)
      return { kind: 'resumed', receipt: resumed }
    }
    if (Date.parse(current.leaseExpiresAt) > Date.parse(input.claimedAt)) {
      return { kind: 'busy', receipt: current }
    }
    const resumed: ExternalChatOutboundReceipt = {
      ...current,
      attempt: current.attempt + 1,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.claimedAt,
    }
    this.outboundReceipts.set(receiptKey, resumed)
    return { kind: 'resumed', receipt: resumed }
  }

  /** Commits an outbound outcome only for the operation that owns the receipt. */
  async completeOutboundOperation(
    input: CompleteExternalChatOutboundOperationInput,
  ): Promise<boolean> {
    if (!matchesOutboundOutcomeScope(input.outcome, input.operationId)) return false
    const receiptKey = key(input.workspaceId, input.linkId, input.operationId)
    const current = this.outboundReceipts.get(receiptKey)
    if (!current || current.attempt !== input.expectedAttempt) return false
    if (current.state === 'completed') {
      return syncOutcomesEqual(current.outcome, input.outcome)
    }
    this.outboundReceipts.set(receiptKey, {
      ...current,
      state: 'completed',
      outcome: input.outcome,
      updatedAt: input.completedAt,
    })
    return true
  }

  /** Checks whether an authenticated echoed operation completed outbound. */
  async hasCompletedOutboundOperation(
    workspaceId: string,
    linkId: string,
    operationId: string,
  ): Promise<boolean> {
    return this.outboundReceipts.get(key(workspaceId, linkId, operationId))?.state === 'completed'
  }

  /** Reads the current lifecycle row for one linked provider thread. */
  async getThreadLifecycle(
    workspaceIdValue: string,
    linkIdValue: string,
    providerValue: ExternalChatProvider,
  ): Promise<StoredExternalChatThreadLifecycle | undefined> {
    const workspaceId = requireLifecycleIdentifier(workspaceIdValue, 'Workspace ID')
    const linkId = requireLifecycleIdentifier(linkIdValue, 'external chat link ID')
    const provider = requireLifecycleProvider(providerValue)
    const record = this.threadLifecycles.get(threadLifecycleKey(workspaceId, linkId, provider))
    if (record) validateThreadLifecycleScope(record, workspaceId, linkId, provider)
    return record
  }

  /** Claims or recovers exclusive processing for one linked thread lifecycle. */
  async claimThreadLifecycle(
    input: ClaimExternalChatThreadLifecycleInput,
  ): Promise<ClaimExternalChatThreadLifecycleResult> {
    const workspaceId = requireLifecycleIdentifier(input.workspaceId, 'Workspace ID')
    const linkId = requireLifecycleIdentifier(input.linkId, 'external chat link ID')
    const provider = requireLifecycleProvider(input.provider)
    const expectedLinkRevision = requireLifecyclePositiveInteger(
      input.expectedLinkRevision,
      'expected external chat link revision',
    )
    const operationId = requireLifecycleIdentifier(
      input.operationId,
      'thread lifecycle operation ID',
    )
    const claimedAt = requireLifecycleTimestamp(input.claimedAt, 'thread lifecycle claim timestamp')
    const leaseExpiresAt = requireLifecycleFutureTimestamp(
      input.leaseExpiresAt,
      claimedAt,
      'thread lifecycle lease expiry',
    )
    const link = requireLifecycleLink(
      this.links.get(key(workspaceId, linkId)),
      provider,
      expectedLinkRevision,
    )
    const lifecycleKey = threadLifecycleKey(workspaceId, linkId, provider)
    const current = this.threadLifecycles.get(lifecycleKey)
    if (!current) {
      const record: StoredExternalChatThreadLifecycle = {
        workspaceId,
        linkId,
        provider,
        ownerLinkRevision: link.link.revision,
        state: {
          completed: false,
          revision: 0,
          updatedAt: claimedAt,
        },
        lease: {
          operationId,
          attempt: 1,
          status: 'processing',
          leaseExpiresAt,
        },
      }
      this.threadLifecycles.set(lifecycleKey, record)
      return { kind: 'claimed', record }
    }
    validateThreadLifecycleScope(current, workspaceId, linkId, provider)
    if (current.lease.status === 'completed') {
      return current.lease.operationId === operationId
        ? { kind: 'completed', record: current }
        : { kind: 'busy', record: current }
    }
    if (
      current.lease.status === 'processing' &&
      Date.parse(current.lease.leaseExpiresAt) > Date.parse(claimedAt)
    ) {
      return { kind: 'busy', record: current }
    }
    const sameOperation = current.lease.operationId === operationId
    const record: StoredExternalChatThreadLifecycle = {
      ...current,
      ownerLinkRevision: link.link.revision,
      lease: {
        operationId,
        attempt: incrementThreadLifecycleAttempt(current.lease.attempt),
        status: 'processing',
        leaseExpiresAt,
      },
    }
    this.threadLifecycles.set(lifecycleKey, record)
    return { kind: sameOperation ? 'resumed' : 'claimed', record }
  }

  /** Commits one thread lifecycle state only for its current lease owner. */
  async completeThreadLifecycle(
    input: CompleteExternalChatThreadLifecycleInput,
  ): Promise<boolean> {
    const workspaceId = requireLifecycleIdentifier(input.workspaceId, 'Workspace ID')
    const linkId = requireLifecycleIdentifier(input.linkId, 'external chat link ID')
    const provider = requireLifecycleProvider(input.provider)
    const expectedLinkRevision = requireLifecyclePositiveInteger(
      input.expectedLinkRevision,
      'expected external chat link revision',
    )
    const operationId = requireLifecycleIdentifier(
      input.operationId,
      'thread lifecycle operation ID',
    )
    const expectedAttempt = requireLifecyclePositiveInteger(
      input.expectedAttempt,
      'expected thread lifecycle attempt',
    )
    const completedAt = requireLifecycleTimestamp(
      input.completedAt,
      'thread lifecycle completion timestamp',
    )
    const outcome = validateThreadLifecycleOutcome(input.outcome, operationId)
    requireLifecycleLink(
      this.links.get(key(workspaceId, linkId)),
      provider,
      expectedLinkRevision,
    )
    const lifecycleKey = threadLifecycleKey(workspaceId, linkId, provider)
    const current = this.threadLifecycles.get(lifecycleKey)
    if (!current) return false
    validateThreadLifecycleScope(current, workspaceId, linkId, provider)
    if (
      current.lease.operationId !== operationId ||
      current.lease.attempt !== expectedAttempt ||
      current.ownerLinkRevision !== expectedLinkRevision
    ) return false
    if (current.lease.status === 'acknowledged') return false
    const nextState = validateThreadLifecycleNextState(
      input.nextState,
      current.lease.status === 'completed'
        ? current.state.revision
        : current.state.revision + 1,
      completedAt,
    )
    if (current.lease.status === 'completed') {
      return threadLifecycleStatesEqual(current.state, nextState) &&
        syncOutcomesEqual(current.lease.completedOutcome, outcome) &&
        current.lease.completedAt === completedAt
    }
    this.threadLifecycles.set(lifecycleKey, {
      ...current,
      state: nextState,
      lease: {
        ...current.lease,
        status: 'completed',
        completedAt,
        completedOutcome: outcome,
      },
    })
    return true
  }

  /** Releases one completed lifecycle lease after its outer receipt becomes durable. */
  async acknowledgeThreadLifecycle(
    input: AcknowledgeExternalChatThreadLifecycleInput,
  ): Promise<boolean> {
    const workspaceId = requireLifecycleIdentifier(input.workspaceId, 'Workspace ID')
    const linkId = requireLifecycleIdentifier(input.linkId, 'external chat link ID')
    const provider = requireLifecycleProvider(input.provider)
    const operationId = requireLifecycleIdentifier(
      input.operationId,
      'thread lifecycle operation ID',
    )
    const expectedAttempt = requireLifecyclePositiveInteger(
      input.expectedAttempt,
      'expected thread lifecycle attempt',
    )
    const lifecycleKey = threadLifecycleKey(workspaceId, linkId, provider)
    const current = this.threadLifecycles.get(lifecycleKey)
    if (!current) return false
    validateThreadLifecycleScope(current, workspaceId, linkId, provider)
    if (
      current.lease.operationId !== operationId ||
      current.lease.attempt !== expectedAttempt
    ) return false
    if (current.lease.status === 'acknowledged') return true
    if (current.lease.status !== 'completed') return false
    this.threadLifecycles.set(lifecycleKey, {
      ...current,
      lease: {
        operationId,
        attempt: expectedAttempt,
        status: 'acknowledged',
        leaseExpiresAt: current.lease.leaseExpiresAt,
      },
    })
    return true
  }

  /** Reads one binding by provider message identity. */
  async getMessageBindingByExternalId(
    workspaceId: string,
    linkId: string,
    externalMessageId: string,
  ): Promise<StoredExternalChatMessageBinding | undefined> {
    return this.externalBindings.get(key(workspaceId, linkId, externalMessageId))
  }

  /** Reads one binding by internal comment identity. */
  async getMessageBindingByInternalId(
    workspaceId: string,
    linkId: string,
    internalCommentId: string,
  ): Promise<StoredExternalChatMessageBinding | undefined> {
    return this.internalBindings.get(key(workspaceId, linkId, internalCommentId))
  }

  /** Creates or replaces one identity-unique message binding. */
  async putMessageBinding(
    input: PutExternalChatMessageBindingInput,
  ): Promise<PutExternalChatMessageBindingResult> {
    const owner = this.links.get(key(input.workspaceId, input.binding.linkId))
    if (
      !owner ||
      !owner.active ||
      owner.link.teamId !== input.expectedTeamId ||
      owner.link.workItemId !== input.expectedWorkItemId ||
      owner.link.revision !== input.expectedLinkRevision
    ) {
      return owner ? { kind: 'owner-conflict', record: owner } : { kind: 'owner-conflict' }
    }
    const externalKey = key(
      input.workspaceId,
      input.binding.linkId,
      input.binding.externalMessageId,
    )
    const internalKey = key(
      input.workspaceId,
      input.binding.linkId,
      input.binding.internalCommentId,
    )
    const currentExternal = this.externalBindings.get(externalKey)
    const currentInternal = this.internalBindings.get(internalKey)
    if (
      currentExternal &&
      currentExternal.binding.internalCommentId !== input.binding.internalCommentId
    ) {
      return { kind: 'identity-conflict', record: currentExternal }
    }
    if (
      currentInternal &&
      currentInternal.binding.externalMessageId !== input.binding.externalMessageId
    ) {
      return { kind: 'identity-conflict', record: currentInternal }
    }
    const current = currentExternal ?? currentInternal
    if (
      input.expectedStorageRevision === undefined
        ? current !== undefined
        : current?.storageRevision !== input.expectedStorageRevision
    ) {
      return current
        ? { kind: 'revision-conflict', record: current }
        : { kind: 'revision-conflict' }
    }
    const record: StoredExternalChatMessageBinding = {
      workspaceId: input.workspaceId,
      binding: input.binding,
      storageRevision: (current?.storageRevision ?? 0) + 1,
    }
    this.externalBindings.set(externalKey, record)
    this.internalBindings.set(internalKey, record)
    return { kind: 'stored', record }
  }

  /** Reads one private provider traversal cursor. */
  async getSyncCursor(
    workspaceId: string,
    linkId: string,
  ): Promise<ExternalChatSyncCursor | undefined> {
    return this.cursors.get(key(workspaceId, linkId))
  }

  /** Advances one private provider traversal cursor with optimistic concurrency. */
  async putSyncCursor(
    workspaceId: string,
    cursor: ExternalChatSyncCursor,
    expectedRevision?: number,
  ): Promise<boolean> {
    const cursorKey = key(workspaceId, cursor.linkId)
    const current = this.cursors.get(cursorKey)
    if (
      expectedRevision === undefined
        ? current !== undefined || cursor.revision !== 1
        : current?.revision !== expectedRevision || cursor.revision !== expectedRevision + 1
    ) {
      return false
    }
    this.cursors.set(cursorKey, cursor)
    return true
  }

  /** Idempotently stores one deferred event. */
  async deferEvent(event: DeferredExternalChatEvent): Promise<void> {
    const link = this.links.get(key(event.workspaceId, event.linkId))
    if (
      event.event.type !== 'source.lifecycle-changed' &&
      (!link || !link.active || linkRejectsDeferredContent(link.link))
    ) return
    const eventKey = key(
      event.workspaceId,
      event.event.provider,
      event.event.installationId,
      event.event.eventId,
    )
    const current = this.deferredEvents.get(eventKey)
    if (current && current.fingerprint !== event.fingerprint) {
      throw new ExternalChatError(
        'ExternalChatEventConflict',
        'A deferred event ID was reused with another normalized payload.',
      )
    }
    this.deferredEvents.set(eventKey, current
      ? {
        ...event,
        attempt: Math.max(current.attempt, event.attempt),
        createdAt: current.createdAt,
      }
      : event)
  }

  /** Lists due deferred events in deterministic occurrence order. */
  async listDueDeferredEvents(
    workspaceId: string,
    linkId: string,
    dueAt: string,
    limit: number,
  ): Promise<DeferredExternalChatEvent[]> {
    return [...this.deferredEvents.values()]
      .filter((event) =>
        event.workspaceId === workspaceId &&
        event.linkId === linkId &&
        event.retryAt <= dueAt
      )
      .sort(compareDeferredEvents)
      .slice(0, Math.max(0, limit))
  }

  /** Removes one deferred event after its outcome commits. */
  async deleteDeferredEvent(
    workspaceId: string,
    provider: ExternalChatProvider,
    installationId: string,
    eventId: string,
  ): Promise<void> {
    this.deferredEvents.delete(key(workspaceId, provider, installationId, eventId))
  }

  /** Purges deferred content owned by one restrictive link except an active retry event. */
  async purgeDeferredEventsForLink(
    workspaceId: string,
    linkId: string,
    excludedEventId?: string,
  ): Promise<number> {
    let deleted = 0
    for (const [eventKey, event] of this.deferredEvents) {
      if (
        event.workspaceId !== workspaceId ||
        event.linkId !== linkId ||
        event.event.eventId === excludedEventId
      ) continue
      this.deferredEvents.delete(eventKey)
      deleted += 1
    }
    return deleted
  }

  /** Idempotently stores one outbound mutation while preserving its first queue timestamp. */
  async deferOutboundEvent(event: DeferredExternalChatOutboundEvent): Promise<void> {
    if (
      event.event.workspaceId !== event.workspaceId ||
      event.event.linkId !== event.linkId ||
      event.fingerprint !== createExternalChatFingerprint(event.event)
    ) {
      throw new ExternalChatError(
        'ExternalChatValidationFailed',
        'The deferred outbound event does not match its queue scope or fingerprint.',
      )
    }
    const eventKey = key(event.workspaceId, event.linkId, event.operationId)
    const current = this.deferredOutboundEvents.get(eventKey)
    if (
      current &&
      (
        current.fingerprint !== event.fingerprint ||
        createExternalChatFingerprint(current.event) !==
          createExternalChatFingerprint(event.event)
      )
    ) {
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'A deferred outbound operation was reused with another normalized mutation.',
      )
    }
    this.deferredOutboundEvents.set(eventKey, current
      ? {
        ...event,
        attempt: Math.max(current.attempt, event.attempt),
        createdAt: current.createdAt,
      }
      : event)
  }

  /** Lists one complete link FIFO without filtering a not-yet-due head. */
  async listDeferredOutboundEvents(
    workspaceId: string,
    linkId: string,
    limit: number,
  ): Promise<DeferredExternalChatOutboundEvent[]> {
    return [...this.deferredOutboundEvents.values()]
      .filter((event) => event.workspaceId === workspaceId && event.linkId === linkId)
      .sort(compareDeferredOutboundEvents)
      .slice(0, Math.max(0, limit))
  }

  /** Removes one fully scoped outbound queue entry after terminal completion. */
  async deleteDeferredOutboundEvent(
    workspaceId: string,
    linkId: string,
    operationId: string,
  ): Promise<void> {
    this.deferredOutboundEvents.delete(key(workspaceId, linkId, operationId))
  }

  /** Atomically retargets selected link-owned records and creates redirects. */
  async mergeLinks(
    input: MergeExternalChatLinksStoreInput,
  ): Promise<MergeExternalChatLinksStoreResult> {
    const selected: StoredExternalChatLink[] = []
    for (const candidate of input.links) {
      const current = this.links.get(key(input.workspaceId, candidate.linkId))
      if (
        !current ||
        !current.active ||
        current.link.teamId !== input.duplicateTeamId ||
        current.link.workItemId !== input.duplicateWorkItemId ||
        current.link.revision !== candidate.expectedRevision
      ) {
        return { kind: 'conflict' }
      }
      const lifecycle = this.threadLifecycles.get(
        threadLifecycleKey(input.workspaceId, current.link.id, current.link.provider),
      )
      if (lifecycle) {
        validateThreadLifecycleScope(
          lifecycle,
          input.workspaceId,
          current.link.id,
          current.link.provider,
        )
        if (lifecycle.lease.status !== 'acknowledged') return { kind: 'conflict' }
      }
      selected.push(current)
    }

    const movedLinks: ExternalChatWorkItemLink[] = []
    const redirects: ExternalChatCanonicalRedirect[] = []
    const movedFileIds = new Set<string>()
    let movedMessageBindingCount = 0
    for (const current of selected) {
      const moved: ExternalChatWorkItemLink = {
        ...current.link,
        teamId: input.canonicalTeamId,
        workItemId: input.canonicalWorkItemId,
        revision: current.link.revision + 1,
        updatedAt: input.mergedAt,
      }
      const redirect: ExternalChatCanonicalRedirect = {
        linkId: moved.id,
        provider: moved.provider,
        threadExternalId: moved.source.threadExternalId,
        fromTeamId: input.duplicateTeamId,
        fromWorkItemId: input.duplicateWorkItemId,
        canonicalTeamId: input.canonicalTeamId,
        canonicalWorkItemId: input.canonicalWorkItemId,
        createdAt: input.mergedAt,
      }
      this.links.set(key(input.workspaceId, moved.id), {
        ...current,
        link: moved,
      })
      const lifecycleKey = threadLifecycleKey(
        input.workspaceId,
        moved.id,
        moved.provider,
      )
      const lifecycle = this.threadLifecycles.get(lifecycleKey)
      if (lifecycle) {
        this.threadLifecycles.set(lifecycleKey, {
          ...lifecycle,
          ownerLinkRevision: moved.revision,
        })
      }
      this.redirects.set(
        key(
          input.workspaceId,
          input.duplicateTeamId,
          input.duplicateWorkItemId,
          moved.id,
        ),
        redirect,
      )
      for (const binding of this.externalBindings.values()) {
        if (binding.workspaceId === input.workspaceId && binding.binding.linkId === moved.id) {
          movedMessageBindingCount += 1
          for (const fileId of binding.binding.importedFileIds) movedFileIds.add(fileId)
        }
      }
      movedLinks.push(moved)
      redirects.push(redirect)
    }
    const routeRedirect = [...redirects].sort((left, right) =>
      compareOrdinal(left.linkId, right.linkId)
    )[0]
    if (routeRedirect) {
      this.redirectRoutes.set(
        key(input.workspaceId, input.duplicateTeamId, input.duplicateWorkItemId),
        routeRedirect,
      )
    }
    return {
      kind: 'merged',
      movedLinks,
      redirects,
      movedFileIds: [...movedFileIds].sort(),
      movedMessageBindingCount,
    }
  }

  /** Resolves a former duplicate Work Item to its canonical target. */
  async getCanonicalRedirect(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    linkId?: string,
  ): Promise<ExternalChatCanonicalRedirect | undefined> {
    return linkId === undefined
      ? this.redirectRoutes.get(key(workspaceId, teamId, workItemId))
      : this.redirects.get(key(workspaceId, teamId, workItemId, linkId))
  }
}

/**
 * Creates a stable digest for a provider thread without retaining its raw identifiers in audit keys.
 *
 * @param source - Provider-neutral source identity.
 * @returns Lowercase SHA-256 digest.
 */
export function createExternalChatSourceDigest(source: ExternalChatSourceIdentity): string {
  return createHash('sha256')
    .update([
      'external-chat-source-v1',
      source.provider,
      source.externalWorkspaceId,
      source.conversationExternalId,
      source.threadExternalId,
    ].join('\0'))
    .digest('hex')
}

/**
 * Creates a stable fingerprint for a normalized external chat value.
 *
 * Object keys are sorted recursively so semantically identical normalized objects replay exactly.
 *
 * @param value - Normalized, secret-free application value.
 * @returns Lowercase SHA-256 digest.
 */
export function createExternalChatFingerprint(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

/**
 * Creates a deterministic inbound operation identifier.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param event - Verified provider-neutral inbound event.
 * @returns Stable retry-safe operation identifier.
 */
export function createExternalChatInboundOperationId(
  workspaceId: string,
  event: ExternalChatInboundEvent,
): string {
  const digest = createHash('sha256')
    .update([
      'external-chat-inbound-operation-v1',
      workspaceId,
      event.provider,
      event.installationId,
      event.eventId,
    ].join('\0'))
    .digest('hex')
  return `chat_in_${digest.slice(0, 40)}`
}

/**
 * Creates a fresh external chat link identifier.
 *
 * @returns Random opaque link identifier.
 */
export function createExternalChatLinkId(): string {
  return `chat_link_${randomUUID()}`
}

/**
 * Creates the provider- and link-scoped in-memory lifecycle key.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param linkId - External chat link identifier.
 * @param provider - Provider that owns the linked thread.
 * @returns Collision-resistant lifecycle map key.
 */
function threadLifecycleKey(
  workspaceId: string,
  linkId: string,
  provider: ExternalChatProvider,
): string {
  return key(workspaceId, linkId, provider)
}

/**
 * Reads one supported lifecycle provider from caller input.
 *
 * @param value - Untrusted provider value.
 * @returns Validated external chat provider.
 */
function requireLifecycleProvider(value: unknown): ExternalChatProvider {
  if (value === 'slack' || value === 'microsoft-teams') return value
  throw new ExternalChatError(
    'ExternalChatValidationFailed',
    'The external chat provider is invalid.',
  )
}

/**
 * Reads one bounded nonempty lifecycle identifier from caller input.
 *
 * @param value - Untrusted identifier value.
 * @param label - Secret-free field label used in diagnostics.
 * @returns Validated identifier.
 */
function requireLifecycleIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > 64 * 1024
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is invalid.`,
    )
  }
  return value
}

/**
 * Reads one positive safe lifecycle integer from caller input.
 *
 * @param value - Untrusted integer value.
 * @param label - Secret-free field label used in diagnostics.
 * @returns Validated positive integer.
 */
function requireLifecyclePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is invalid.`,
    )
  }
  return value
}

/**
 * Reads one nonnegative safe lifecycle integer from caller input.
 *
 * @param value - Untrusted integer value.
 * @param label - Secret-free field label used in diagnostics.
 * @returns Validated nonnegative integer.
 */
function requireLifecycleNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is invalid.`,
    )
  }
  return value
}

/**
 * Reads one parseable ISO 8601 lifecycle timestamp from caller input.
 *
 * @param value - Untrusted timestamp value.
 * @param label - Secret-free field label used in diagnostics.
 * @returns Validated timestamp.
 */
function requireLifecycleTimestamp(value: unknown, label: string): string {
  const timestamp = requireLifecycleIdentifier(value, label)
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} is invalid.`,
    )
  }
  return timestamp
}

/**
 * Reads a lifecycle lease expiry that is strictly after its claim timestamp.
 *
 * @param value - Untrusted lease expiry value.
 * @param claimedAt - Validated claim timestamp.
 * @param label - Secret-free field label used in diagnostics.
 * @returns Validated future timestamp.
 */
function requireLifecycleFutureTimestamp(
  value: unknown,
  claimedAt: string,
  label: string,
): string {
  const timestamp = requireLifecycleTimestamp(value, label)
  if (Date.parse(timestamp) <= Date.parse(claimedAt)) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      `The ${label} must be after the claim timestamp.`,
    )
  }
  return timestamp
}

/**
 * Requires one active link with the expected provider and revision.
 *
 * @param record - Tenant-scoped link resolved by its server-derived key.
 * @param provider - Expected linked provider.
 * @param expectedRevision - Previously observed link revision.
 * @returns Validated active link record.
 */
function requireLifecycleLink(
  record: StoredExternalChatLink | undefined,
  provider: ExternalChatProvider,
  expectedRevision: number,
): StoredExternalChatLink {
  if (!record || !record.active) {
    throw new ExternalChatError(
      'ExternalChatNotFound',
      'The active external chat link does not exist.',
    )
  }
  if (record.link.provider !== provider) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The thread lifecycle provider does not match the external chat link.',
    )
  }
  if (record.link.revision !== expectedRevision) {
    throw new ExternalChatError(
      'ExternalChatRevisionConflict',
      'The external chat link revision changed before lifecycle processing.',
    )
  }
  return record
}

/**
 * Validates immutable link identity before an in-memory replacement.
 *
 * @param current - Current stored link record.
 * @param replacement - Caller-provided replacement link.
 */
function validateInMemoryLinkReplacement(
  current: StoredExternalChatLink,
  replacement: ExternalChatWorkItemLink,
): void {
  if (
    replacement.id !== current.link.id ||
    replacement.teamId !== current.link.teamId ||
    replacement.workItemId !== current.link.workItemId ||
    replacement.provider !== current.link.provider ||
    replacement.installationId !== current.link.installationId ||
    replacement.source.externalWorkspaceId !== current.link.source.externalWorkspaceId ||
    replacement.source.conversationExternalId !== current.link.source.conversationExternalId ||
    replacement.source.threadExternalId !== current.link.source.threadExternalId
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'Immutable external chat link identity fields cannot change.',
    )
  }
}

/**
 * Verifies a durable lifecycle record against its physical tenant and provider scope.
 *
 * @param record - Current durable lifecycle record.
 * @param workspaceId - Expected Workspace identifier.
 * @param linkId - Expected link identifier.
 * @param provider - Expected provider.
 */
function validateThreadLifecycleScope(
  record: StoredExternalChatThreadLifecycle,
  workspaceId: string,
  linkId: string,
  provider: ExternalChatProvider,
): void {
  if (
    record.workspaceId !== workspaceId ||
    record.linkId !== linkId ||
    record.provider !== provider ||
    !Number.isSafeInteger(record.ownerLinkRevision) ||
    record.ownerLinkRevision < 1
  ) {
    throw new ExternalChatError(
      'ExternalChatPersistenceFailed',
      'Stored external chat thread lifecycle scope is invalid.',
    )
  }
}

/**
 * Checks whether a link mutation is idle or belongs to a completed lifecycle owner.
 *
 * @param record - Current durable lifecycle record.
 * @param operationId - Optional lifecycle operation supplied by the mutation owner.
 * @returns Whether the mutation may cross the lifecycle fence.
 */
function threadLifecycleAllowsLinkMutation(
  record: StoredExternalChatThreadLifecycle,
  operationId: string | undefined,
): boolean {
  if (record.lease.status === 'acknowledged') return true
  return record.lease.status === 'completed' && record.lease.operationId === operationId
}

/**
 * Validates and constructs the next committed lifecycle state.
 *
 * The store validates shape and revision adjacency but deliberately leaves provider-specific
 * ordering comparisons to the synchronization service.
 *
 * @param value - Caller-provided complete next state.
 * @param expectedRevision - Exact lifecycle revision required for this write or replay.
 * @param completedAt - Validated completion timestamp.
 * @returns Canonically constructed next lifecycle state.
 */
function validateThreadLifecycleNextState(
  value: ExternalChatThreadLifecycleState,
  expectedRevision: number,
  completedAt: string,
): ExternalChatThreadLifecycleState {
  if (typeof value.completed !== 'boolean') {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The thread lifecycle completion state is invalid.',
    )
  }
  const revision = requireLifecycleNonnegativeInteger(
    value.revision,
    'thread lifecycle state revision',
  )
  if (revision !== expectedRevision) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The thread lifecycle state revision must advance exactly once.',
    )
  }
  const updatedAt = requireLifecycleTimestamp(
    value.updatedAt,
    'thread lifecycle state update timestamp',
  )
  if (updatedAt !== completedAt) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The thread lifecycle state timestamp must match its completion timestamp.',
    )
  }
  const lastExternalVersion = value.lastExternalVersion === undefined
    ? undefined
    : requireLifecycleIdentifier(value.lastExternalVersion, 'last external thread version')
  const lastInternalWorkItemRevision = value.lastInternalWorkItemRevision === undefined
    ? undefined
    : requireLifecyclePositiveInteger(
        value.lastInternalWorkItemRevision,
        'last internal Work Item revision',
      )
  return {
    completed: value.completed,
    ...(lastExternalVersion === undefined ? {} : { lastExternalVersion }),
    ...(lastInternalWorkItemRevision === undefined ? {} : { lastInternalWorkItemRevision }),
    revision,
    updatedAt,
  }
}

/**
 * Validates a lifecycle outcome against the operation that owns the lease.
 *
 * @param outcome - Caller-provided auditable synchronization outcome.
 * @param operationId - Operation identifier that owns the lifecycle lease.
 * @returns Outcome validated for the exact lease scope.
 */
function validateThreadLifecycleOutcome(
  outcome: ExternalChatSyncOutcome,
  operationId: string,
): ExternalChatSyncOutcome {
  if (outcome.operationId !== operationId) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The thread lifecycle outcome does not match its operation.',
    )
  }
  requireLifecycleTimestamp(outcome.occurredAt, 'thread lifecycle outcome timestamp')
  return outcome
}

/**
 * Increments a lifecycle attempt without leaving the safe integer range.
 *
 * @param current - Current durable lease attempt.
 * @returns Next monotonic attempt.
 */
function incrementThreadLifecycleAttempt(current: number): number {
  if (!Number.isSafeInteger(current) || current < 1 || current === Number.MAX_SAFE_INTEGER) {
    throw new ExternalChatError(
      'ExternalChatPersistenceFailed',
      'Stored external chat thread lifecycle attempt is invalid.',
    )
  }
  return current + 1
}

/**
 * Compares complete lifecycle states through their canonical stable serialization.
 *
 * @param left - Current committed state.
 * @param right - Candidate idempotent replay state.
 * @returns Whether both states are semantically identical.
 */
function threadLifecycleStatesEqual(
  left: ExternalChatThreadLifecycleState,
  right: ExternalChatThreadLifecycleState,
): boolean {
  return stableSerialize(left) === stableSerialize(right)
}

/**
 * Removes a terminal outcome while preserving a parent fan-out checkpoint for receipt resumption.
 *
 * @param receipt - Completed deferred inbound receipt being resumed.
 * @returns Processing receipt fields without the terminal outcome.
 */
function withoutInboundReceiptOutcome(
  receipt: ExternalChatInboundReceipt,
): Omit<ExternalChatInboundReceipt, 'outcome'> {
  const { outcome: ignoredOutcome, ...processing } = receipt
  void ignoredOutcome
  return processing
}

/**
 * Validates one provider-parent lifecycle fence without trusting its TypeScript shape.
 *
 * @param input - Untrusted parent lifecycle fence input.
 * @returns Exact normalized fence input.
 */
function normalizeParentLifecycleFenceInput(
  input: FenceExternalChatParentLifecycleInput,
): FenceExternalChatParentLifecycleInput {
  const provider = input.provider === 'slack' || input.provider === 'microsoft-teams'
    ? input.provider
    : undefined
  if (!provider || typeof input.restrictive !== 'boolean') {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The provider parent lifecycle fence is invalid.',
    )
  }
  const conversationExternalId = input.conversationExternalId === undefined
    ? undefined
    : requireLifecycleIdentifier(
      input.conversationExternalId,
      'parent conversation ID',
    )
  return {
    workspaceId: requireLifecycleIdentifier(input.workspaceId, 'Workspace ID'),
    provider,
    installationId: requireLifecycleIdentifier(input.installationId, 'installation ID'),
    externalWorkspaceId: requireLifecycleIdentifier(
      input.externalWorkspaceId,
      'external Workspace ID',
    ),
    ...(conversationExternalId === undefined ? {} : { conversationExternalId }),
    ...(input.authorizationRevision === undefined
      ? {}
      : {
        authorizationRevision: requireLifecyclePositiveInteger(
          input.authorizationRevision,
          'provider authorization revision',
        ),
      }),
    restrictive: input.restrictive,
    eventId: requireLifecycleIdentifier(input.eventId, 'provider event ID'),
    operationId: requireLifecycleIdentifier(input.operationId, 'operation ID'),
    occurredAt: requireLifecycleTimestamp(input.occurredAt, 'parent occurrence timestamp'),
  }
}

/**
 * Builds one complete authoritative parent lifecycle fence.
 *
 * @param input - Normalized fence input.
 * @param authorizationRevision - Verified provider authorization generation.
 * @returns Complete durable parent lifecycle fence.
 */
function createParentLifecycleFence(
  input: FenceExternalChatParentLifecycleInput,
  authorizationRevision: number,
): ExternalChatParentLifecycleFence {
  return {
    workspaceId: input.workspaceId,
    provider: input.provider,
    installationId: input.installationId,
    externalWorkspaceId: input.externalWorkspaceId,
    ...(input.conversationExternalId === undefined
      ? {}
      : { conversationExternalId: input.conversationExternalId }),
    authorizationRevision,
    restrictive: input.restrictive,
    eventId: input.eventId,
    operationId: input.operationId,
    occurredAt: input.occurredAt,
  }
}

/**
 * Normalizes and scope-checks an atomic parent fence expected by one link projection.
 *
 * @param fence - Candidate full parent lifecycle authority.
 * @param record - Link whose projection will be conditionally updated.
 * @returns Exact validated fence matching the link's workspace or conversation parent.
 */
function normalizeExpectedParentLifecycleFenceForLink(
  fence: ExternalChatParentLifecycleFence,
  record: StoredExternalChatLink,
): ExternalChatParentLifecycleFence {
  const normalizedInput = normalizeParentLifecycleFenceInput(fence)
  const authorizationRevision = normalizedInput.authorizationRevision
  if (authorizationRevision === undefined) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The expected parent lifecycle fence requires its authorization revision.',
    )
  }
  const normalized = createParentLifecycleFence(normalizedInput, authorizationRevision)
  if (
    normalized.workspaceId !== record.workspaceId ||
    normalized.provider !== record.link.provider ||
    normalized.installationId !== record.link.installationId ||
    normalized.externalWorkspaceId !== record.link.source.externalWorkspaceId ||
    (
      normalized.conversationExternalId !== undefined &&
      normalized.conversationExternalId !== record.link.source.conversationExternalId
    )
  ) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The expected parent lifecycle fence does not own the external chat link.',
    )
  }
  return normalized
}

/**
 * Compares every authoritative field of two provider-parent lifecycle fences.
 *
 * @param left - First durable fence.
 * @param right - Second durable fence.
 * @returns Whether both fences represent the exact same parent authority.
 */
function sameParentLifecycleFence(
  left: ExternalChatParentLifecycleFence,
  right: ExternalChatParentLifecycleFence,
): boolean {
  return stableSerialize(left) === stableSerialize(right)
}

/**
 * Detects an exact parent fence operation replay and rejects payload reuse.
 *
 * @param current - Current authoritative fence.
 * @param input - Normalized incoming fence update.
 * @returns Whether the same operation already committed.
 */
function parentLifecycleFenceReplays(
  current: ExternalChatParentLifecycleFence,
  input: FenceExternalChatParentLifecycleInput,
): boolean {
  if (current.operationId !== input.operationId || current.eventId !== input.eventId) return false
  const candidate = createParentLifecycleFence(
    input,
    input.authorizationRevision ?? current.authorizationRevision,
  )
  if (!sameParentLifecycleFence(candidate, current)) {
    throw new ExternalChatError(
      'ExternalChatEventConflict',
      'The parent lifecycle operation was reused with another payload.',
    )
  }
  return true
}

/**
 * Orders provider-parent lifecycle fences by authorization generation and occurrence identity.
 *
 * @param left - Incoming candidate fence.
 * @param right - Current authoritative fence.
 * @returns Standard sort comparator result.
 */
function compareParentLifecycleFences(
  left: ExternalChatParentLifecycleFence,
  right: ExternalChatParentLifecycleFence,
): number {
  return left.authorizationRevision - right.authorizationRevision ||
    compareOrdinal(left.occurredAt, right.occurredAt) ||
    compareOrdinal(left.eventId, right.eventId)
}

/**
 * Checks whether one parent fence invalidates a source resolved at the supplied generation.
 *
 * @param fence - Current authoritative provider-parent fence.
 * @param authorizationRevision - Generation used to resolve the new link source.
 * @returns Whether the link must fail closed.
 */
function parentLifecycleFenceBlocks(
  fence: ExternalChatParentLifecycleFence,
  authorizationRevision: number,
): boolean {
  return fence.authorizationRevision > authorizationRevision ||
    (fence.authorizationRevision === authorizationRevision && fence.restrictive)
}

/**
 * Creates one exact tenant/provider/installation parent lifecycle map key.
 *
 * @param workspaceId - Canonical tenant identifier.
 * @param provider - Provider that owns the parent.
 * @param installationId - Connector installation identifier.
 * @param externalWorkspaceId - Provider-scoped workspace identifier.
 * @param conversationExternalId - Optional conversation restriction.
 * @returns Collision-free in-memory parent fence key.
 */
function parentLifecycleFenceKey(
  workspaceId: string,
  provider: ExternalChatProvider,
  installationId: string,
  externalWorkspaceId: string,
  conversationExternalId: string | undefined,
): string {
  return key(
    workspaceId,
    provider,
    installationId,
    externalWorkspaceId,
    conversationExternalId === undefined ? 'workspace' : 'conversation',
    conversationExternalId ?? '',
  )
}

/**
 * Builds the deterministic in-memory parent lookup continuation for one link.
 *
 * @param record - Active link under a provider parent.
 * @returns Stable conversation/link continuation.
 */
function parentLinkCursor(record: StoredExternalChatLink): string {
  return `${record.link.source.conversationExternalId}\0${record.link.id}`
}

/**
 * Checks whether a link state forbids retaining deferred provider content.
 *
 * @param link - Current provider-neutral link snapshot.
 * @returns Whether deferred message payloads must be rejected.
 */
function linkRejectsDeferredContent(link: ExternalChatWorkItemLink): boolean {
  return link.sourceAvailability === 'permission-lost' ||
    link.sourceAvailability === 'scope-changed' ||
    link.sourceState === 'deleted' ||
    link.sourceState === 'retention-expired'
}

/**
 * Joins trusted internal key components without exposing the encoding as a public contract.
 *
 * @param components - Validated canonical identifiers or digests.
 * @returns Collision-resistant in-memory compound key.
 */
function key(...components: string[]): string {
  return components.join('\0')
}

/**
 * Recursively serializes JSON-compatible normalized values with stable object key ordering.
 *
 * @param value - Value to serialize.
 * @returns Deterministic text representation.
 */
function stableSerialize(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ExternalChatError(
        'ExternalChatValidationFailed',
        'Normalized chat values cannot contain non-finite numbers.',
      )
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((left, right) => compareOrdinal(left[0], right[0]))
      .map(([entryKey, entryValue]) =>
        `${JSON.stringify(entryKey)}:${stableSerialize(entryValue)}`
      )
    return `{${entries.join(',')}}`
  }
  throw new ExternalChatError(
    'ExternalChatValidationFailed',
    'Normalized chat values must be JSON-compatible.',
  )
}

/**
 * Compares deferred events by provider occurrence and stable event identity.
 *
 * @param left - First deferred event.
 * @param right - Second deferred event.
 * @returns Standard sort comparator result.
 */
function compareDeferredEvents(
  left: DeferredExternalChatEvent,
  right: DeferredExternalChatEvent,
): number {
  return compareOrdinal(left.event.occurredAt, right.event.occurredAt) ||
    compareOrdinal(left.event.eventId, right.event.eventId)
}

/**
 * Compares outbound queue entries by internal occurrence and stable operation identity.
 *
 * @param left - First deferred outbound mutation.
 * @param right - Second deferred outbound mutation.
 * @returns Standard sort comparator result.
 */
function compareDeferredOutboundEvents(
  left: DeferredExternalChatOutboundEvent,
  right: DeferredExternalChatOutboundEvent,
): number {
  return compareOrdinal(left.event.occurredAt, right.event.occurredAt) ||
    compareOrdinal(left.operationId, right.operationId)
}

/**
 * Compares normalized strings by UTF-16 code units without host locale variance.
 *
 * @param left - Left normalized value.
 * @param right - Right normalized value.
 * @returns Negative, zero, or positive ordering result.
 */
function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Compares two optional synchronization outcomes using their stable serialization.
 *
 * @param left - First outcome.
 * @param right - Second outcome.
 * @returns Whether both outcomes are present and semantically identical.
 */
function syncOutcomesEqual(
  left: ExternalChatSyncOutcome | undefined,
  right: ExternalChatSyncOutcome,
): boolean {
  return left !== undefined && stableSerialize(left) === stableSerialize(right)
}

/**
 * Checks whether a completed outbound receipt may be reclaimed by its durable queue worker.
 *
 * @param outcome - Previously committed outbound result.
 * @param claimedAt - Timestamp of the proposed retry claim.
 * @returns Whether retry policy allows a new receipt attempt.
 */
function isRetryableOutboundReceiptDue(
  outcome: ExternalChatSyncOutcome | undefined,
  claimedAt: string,
): boolean {
  if (outcome?.kind === 'failed') return outcome.retryable
  return outcome?.kind === 'deferred' &&
    outcome.retryAt !== undefined &&
    outcome.retryAt <= claimedAt
}

/**
 * Validates an inbound outcome against the receipt operation and provider event identity.
 *
 * @param outcome - Candidate inbound completion outcome.
 * @param operationId - Receipt operation that owns completion.
 * @param eventId - Provider event addressed by the receipt.
 * @returns Whether the outcome belongs to the exact inbound receipt scope.
 */
function matchesInboundOutcomeScope(
  outcome: ExternalChatSyncOutcome,
  operationId: string,
  eventId: string,
): boolean {
  return outcome.operationId === operationId && outcome.eventId === eventId
}

/**
 * Validates an outbound outcome against its operation and rejects provider event identity.
 *
 * @param outcome - Candidate outbound completion outcome.
 * @param operationId - Receipt operation that owns completion.
 * @returns Whether the outcome belongs to the exact outbound receipt scope.
 */
function matchesOutboundOutcomeScope(
  outcome: ExternalChatSyncOutcome,
  operationId: string,
): boolean {
  return outcome.operationId === operationId && outcome.eventId === undefined
}
