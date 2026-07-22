import type {
  ApplyDocumentOperationsResponse,
  DocumentCommentsResponse,
  DocumentDetail,
  DocumentNode,
  DocumentTreeResponse,
  DocumentVersionsResponse,
} from '@mukuroji/contracts'
import type {
  ApplyDocumentOperationsRequest,
  ChangeDocumentArchiveStateRequest,
  CreatedDocumentPublicShare,
  CreateDocumentCommentRequest,
  CreateDocumentPublicShareRequest,
  CreateDocumentRequest,
  DocumentBacklinksResponse,
  DocumentManagerLifecycleSnapshot,
  DocumentPreferenceResult,
  DocumentPresenceRequest,
  DocumentPublicShareRequest,
  ExportDocumentRequest,
  GetDocumentRequest,
  HeartbeatDocumentPresenceRequest,
  InstantiateDocumentTemplateRequest,
  ListDocumentBacklinksRequest,
  ListDocumentCommentsRequest,
  ListDocumentVersionsRequest,
  ListDocumentsRequest,
  ListRecentDocumentsRequest,
  PrepareDocumentOperationsResponse,
  RenderedDocumentExport,
  ResolvedDocumentPublicShare,
  ResolvedDocumentSearchAccess,
  ResolveDocumentCommentRequest,
  ResolveDocumentSearchAccessRequest,
  RestoreDocumentVersionRequest,
  StoredDocumentComment,
  StoredDocumentPresence,
  StoredDocumentPublicShare,
  UpdateDocumentPreferenceRequest,
  UpdateDocumentRequest,
} from '../../document-types'

/** Semantic input for incrementing a Workspace document-authorization revision. */
export type PrepareDocumentAuthorizationRevisionMutationRequest = {
  /** Canonical Workspace ID whose authorization revision must advance. */
  readonly workspaceId: string
  /** Revision observed before the surrounding mutation. */
  readonly expectedRevision: number
  /** Canonical timestamp shared with the surrounding mutation. */
  readonly updatedAt: string
}

/**
 * Prepares a storage-specific document-authorization revision contribution.
 *
 * The transaction contribution remains generic so application consumers depend
 * only on this semantic port rather than an AWS SDK transaction shape.
 *
 * @typeParam TransactionContribution - Adapter-owned atomic transaction item.
 */
export interface DocumentAuthorizationRevisionMutationPort<
  TransactionContribution,
> {
  /**
   * Prepares the contribution that advances one Workspace revision.
   *
   * @param input - Semantic revision mutation request.
   * @returns Adapter-owned transaction contribution.
   */
  prepareAuthorizationRevisionMutation(
    input: PrepareDocumentAuthorizationRevisionMutationRequest,
  ): TransactionContribution
}

/** Reads the authorization revision used to fence document mutations. */
export interface DocumentAuthorizationRevisionPort {
  /**
   * Reads the current authorization revision consistently.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @returns Current monotonically increasing authorization revision.
   */
  getAuthorizationRevision(workspaceId: string): Promise<number>
}

/** Reads private-document manager continuity snapshots. */
export interface DocumentManagerLifecyclePort {
  /**
   * Finds whether removing one member would leave a private document unmanaged.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @param memberKey - Member being removed or downgraded.
   * @param eligibleManagerMemberKeys - Members still eligible to manage documents.
   * @returns Authorization revision and optional blocking document ID.
   */
  getManagerLifecycleSnapshot(
    workspaceId: string,
    memberKey: string,
    eligibleManagerMemberKeys: readonly string[],
  ): Promise<DocumentManagerLifecycleSnapshot>
}

/** Reads permission-filtered document tree and detail projections. */
export interface DocumentTreePort {
  /**
   * Returns one page of the document tree.
   *
   * @param input - Tree filters, viewer access, and pagination state.
   * @returns One permission-filtered tree page.
   */
  list(input: ListDocumentsRequest): Promise<DocumentTreeResponse>
  /**
   * Returns one permission-filtered document.
   *
   * @param input - Document identity and viewer access.
   * @returns Current accessible Document detail.
   */
  get(input: GetDocumentRequest): Promise<DocumentDetail>
}

/** Revalidates workspace-search candidates against canonical document access. */
export interface DocumentSearchAccessPort {
  /**
   * Returns canonical access data when the indexed candidate is still current.
   *
   * @param input - Indexed candidate identity, revision, and viewer access.
   * @returns Canonical search data, or `undefined` when the candidate is stale or hidden.
   */
  resolveSearchAccess(
    input: ResolveDocumentSearchAccessRequest,
  ): Promise<ResolvedDocumentSearchAccess | undefined>
}

/** Creates and mutates document tree metadata. */
export interface DocumentMutationPort {
  /**
   * Creates a document and its initial immutable version.
   *
   * @param input - Validated Document creation intent.
   * @returns Created permission-filtered Document.
   */
  create(input: CreateDocumentRequest): Promise<DocumentDetail>
  /**
   * Updates document metadata using optimistic revision checks.
   *
   * @param input - Metadata patch and expected revision.
   * @returns Updated permission-filtered Document.
   */
  update(input: UpdateDocumentRequest): Promise<DocumentDetail>
  /**
   * Soft-archives a document.
   *
   * @param input - Archive target, access, and expected revision.
   * @returns Archived Document detail.
   */
  archive(input: ChangeDocumentArchiveStateRequest): Promise<DocumentDetail>
  /**
   * Restores an archived document to the tree.
   *
   * @param input - Restore target, access, and expected revision.
   * @returns Restored Document detail.
   */
  restoreArchived(input: ChangeDocumentArchiveStateRequest): Promise<DocumentDetail>
  /**
   * Creates a page from an immutable template snapshot.
   *
   * @param input - Template identity and destination intent.
   * @returns Created page detail.
   */
  instantiateTemplate(input: InstantiateDocumentTemplateRequest): Promise<DocumentDetail>
}

/** Applies idempotent element-level document operations. */
export interface DocumentOperationsPort {
  /**
   * Resolves durable receipts before external relation validation.
   *
   * @param input - Atomic operation request.
   * @returns Replay response or the operations still requiring validation.
   */
  prepareOperations(
    input: ApplyDocumentOperationsRequest,
  ): Promise<PrepareDocumentOperationsResponse>
  /**
   * Applies one atomic operation batch.
   *
   * @param input - Preflight-bound atomic operation request.
   * @returns Durable operation result or replay.
   */
  applyOperations(
    input: ApplyDocumentOperationsRequest,
  ): Promise<ApplyDocumentOperationsResponse>
}

/** Reads and restores immutable document versions. */
export interface DocumentVersionsPort {
  /**
   * Returns one page of immutable document versions.
   *
   * @param input - Version query and pagination state.
   * @returns One immutable version page.
   */
  listVersions(input: ListDocumentVersionsRequest): Promise<DocumentVersionsResponse>
  /**
   * Restores a historical version as a new current revision.
   *
   * @param input - Historical version, expected revision, and target validator.
   * @returns Restored current Document detail.
   */
  restoreVersion(input: RestoreDocumentVersionRequest): Promise<DocumentDetail>
}

/** Stores viewer-specific favorite and recent-document preferences. */
export interface DocumentPreferencePort {
  /**
   * Updates favorite or recent-open state.
   *
   * @param input - Viewer preference mutation.
   * @returns Persisted preference and projected Document.
   */
  updatePreference(input: UpdateDocumentPreferenceRequest): Promise<DocumentPreferenceResult>
  /**
   * Returns recent documents for the current member.
   *
   * @param input - Viewer identity and result limit.
   * @returns Permission-filtered recent Documents.
   */
  listRecent(input: ListRecentDocumentsRequest): Promise<DocumentNode[]>
}

/** Creates, reads, and resolves document comments. */
export interface DocumentCommentsPort {
  /**
   * Returns an existing comment for an idempotent create replay.
   *
   * @param input - Proposed comment identity and payload.
   * @returns Existing matching comment, or `undefined` when creation is pending.
   */
  getCommentCreateReplay(
    input: CreateDocumentCommentRequest,
  ): Promise<StoredDocumentComment | undefined>
  /**
   * Creates a root comment or reply.
   *
   * @param input - Validated comment creation intent.
   * @returns Created or idempotently replayed comment.
   */
  createComment(input: CreateDocumentCommentRequest): Promise<StoredDocumentComment>
  /**
   * Returns one page of document comments.
   *
   * @param input - Comment query and pagination state.
   * @returns One comment page.
   */
  listComments(input: ListDocumentCommentsRequest): Promise<DocumentCommentsResponse>
  /**
   * Resolves or reopens a root comment.
   *
   * @param input - Comment identity and desired resolution state.
   * @returns Updated comment.
   */
  resolveComment(input: ResolveDocumentCommentRequest): Promise<StoredDocumentComment>
}

/** Maintains short-lived collaborative presence leases. */
export interface DocumentPresencePort {
  /**
   * Refreshes a browser-client presence lease.
   *
   * @param input - Current collaborator state and browser client identity.
   * @returns Nothing after the lease is persisted.
   */
  heartbeatPresence(input: HeartbeatDocumentPresenceRequest): Promise<void>
  /**
   * Removes a browser-client presence lease.
   *
   * @param input - Document, viewer, and client lease identity.
   * @returns Nothing after the lease is removed.
   */
  leavePresence(input: DocumentPresenceRequest): Promise<void>
  /**
   * Returns active presence leases grouped by member.
   *
   * @param input - Document and viewer access.
   * @returns Active collaborator presence snapshots.
   */
  listPresence(input: DocumentPresenceRequest): Promise<StoredDocumentPresence[]>
}

/** Manages expiring public document shares. */
export interface DocumentSharesPort {
  /**
   * Creates an idempotent public share and returns its raw token once.
   *
   * @param input - Public share intent and authorization snapshot.
   * @returns Stored share metadata and raw bearer token.
   */
  createPublicShare(input: CreateDocumentPublicShareRequest): Promise<CreatedDocumentPublicShare>
  /**
   * Lists public shares for a document.
   *
   * @param input - Document identity and manager access.
   * @returns Current public shares.
   */
  listPublicShares(input: DocumentPublicShareRequest): Promise<StoredDocumentPublicShare[]>
  /**
   * Revokes one public share.
   *
   * @param input - Document, share identity, and manager access.
   * @returns Revoked share metadata.
   */
  revokePublicShare(input: DocumentPublicShareRequest): Promise<StoredDocumentPublicShare>
  /**
   * Resolves a raw public token to its current snapshot.
   *
   * @param token - Raw high-entropy bearer token.
   * @returns Current public Document and share metadata.
   */
  resolvePublicShare(token: string): Promise<ResolvedDocumentPublicShare>
}

/** Reads permission-filtered backlinks. */
export interface DocumentBacklinksPort {
  /**
   * Returns backlinks for one external domain target.
   *
   * @param input - Target identity, viewer access, and pagination state.
   * @returns One permission-filtered backlink page.
   */
  listBacklinks(input: ListDocumentBacklinksRequest): Promise<DocumentBacklinksResponse>
}

/** Renders authenticated document exports. */
export interface DocumentExportPort {
  /**
   * Returns a safe text export for one document.
   *
   * @param input - Document identity, viewer access, and export format.
   * @returns Rendered text artifact.
   */
  exportDocument(input: ExportDocumentRequest): Promise<RenderedDocumentExport>
}

/** Complete application-facing Documents capability set. */
export interface DocumentApplicationClient extends
  DocumentAuthorizationRevisionPort,
  DocumentManagerLifecyclePort,
  DocumentTreePort,
  DocumentSearchAccessPort,
  DocumentMutationPort,
  DocumentOperationsPort,
  DocumentVersionsPort,
  DocumentPreferencePort,
  DocumentCommentsPort,
  DocumentPresencePort,
  DocumentSharesPort,
  DocumentBacklinksPort,
  DocumentExportPort {}

/** Focused capability set consumed by the Documents HTTP adapter. */
export interface DocumentHttpApplication extends
  DocumentAuthorizationRevisionPort,
  DocumentTreePort,
  DocumentMutationPort,
  DocumentOperationsPort,
  DocumentVersionsPort,
  DocumentPreferencePort,
  DocumentCommentsPort,
  DocumentPresencePort,
  DocumentSharesPort,
  DocumentBacklinksPort,
  DocumentExportPort {}
