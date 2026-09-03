import type { FileMetadataIntegrityFailureCode } from '../files'
import type {
  CrossDomainAuditReference,
  CrossDomainIntegrityItem,
} from './cross-domain-integrity-checker'

/** Logical DynamoDB targets whose physical names are bound by the reader. */
export type CrossDomainIntegrityTableTarget =
  | 'audit-events'
  | 'file-proofing'
  | 'project-directory'
  | 'work-item-configuration'
  | 'work-items'
  | 'workspace-access'

/** Complete physical DynamoDB table allowlist for one normalized reader. */
export type CrossDomainIntegrityTableNames = {
  /** Audit Events table name. */
  readonly 'audit-events': string
  /** File proofing metadata table name. */
  readonly 'file-proofing': string
  /** Project directory table name. */
  readonly 'project-directory': string
  /** Work Item configuration table name. */
  readonly 'work-item-configuration': string
  /** Work Items table name. */
  readonly 'work-items': string
  /** Workspace access table name. */
  readonly 'workspace-access': string
}

/** SDK-independent configuration for one isolated normalized AWS reader. */
export type CrossDomainIntegrityNormalizedPageReaderConfiguration = {
  /** Expected owner account for every exact resource read. */
  readonly accountId: string
  /** Exact isolated File bucket name. */
  readonly bucketName: string
  /** Fixed low-level Scan limit, equal to the normalization page bound. */
  readonly pageSize: number
  /** Explicit AWS Region. */
  readonly region: string
  /** Complete isolated logical-to-physical table allowlist. */
  readonly tableNames: CrossDomainIntegrityTableNames
}

/** One lifecycle candidate retained for page-order-independent Audit reduction. */
export type CrossDomainIntegrityNormalizedAuditCandidateValue = {
  /** Stable event ordering key. */
  readonly eventOrder: string
  /** Event ID retained only inside aggregate HMAC input. */
  readonly eventId: string
  /** Whether the event itself is explicitly historical. */
  readonly historical: boolean
  /** Stable process-local identity for latest-event selection. */
  readonly resourceIdentity: string
  /** Joinable normalized reference. */
  readonly reference: Omit<CrossDomainAuditReference, 'resourceState'>
}

/** One normalized item associated with an opaque digest of its physical row. */
export type CrossDomainIntegrityNormalizedItem = {
  /** Strict process-local normalized item. */
  readonly item: CrossDomainIntegrityItem
  /** HMAC of the exact low-level row and logical table target. */
  readonly originDigest: string
}

/** One normalized Audit candidate associated with an opaque row digest. */
export type CrossDomainIntegrityNormalizedAuditCandidate = {
  /** Lifecycle candidate reduced by the semantic verifier. */
  readonly candidate: CrossDomainIntegrityNormalizedAuditCandidateValue
  /** HMAC of the exact low-level row and logical table target. */
  readonly originDigest: string
}

/** Input for one bounded normalized page read. */
export type CrossDomainIntegrityNormalizedPageRequest = {
  /** Existing Workspace Audit pseudonym key retained only in memory. */
  readonly auditPseudonymKey: Uint8Array
  /** Canonical restore point shared by the complete verification. */
  readonly checkedAt: string
  /** Opaque canonical cursor returned by the preceding page. */
  readonly cursor?: string
  /** Invocation-local evidence HMAC key. */
  readonly digestKey: Uint8Array
  /** Remaining global normalized/evidence-unit capacity before this page. */
  readonly remainingItemCapacity: number
  /** Caller-owned finite cancellation shared by every raw read for this page. */
  readonly signal: AbortSignal
  /** Canonical isolated table target. */
  readonly target: CrossDomainIntegrityTableTarget
  /** Whether relation rows should include strongly read endpoint Work Item Types. */
  readonly includeRelationEndpointTypes?: boolean
}

/** One bounded SDK-independent normalized page. */
export type CrossDomainIntegrityNormalizedPage = {
  /** Strict normalized Audit candidates with opaque row digests. */
  readonly auditCandidates: readonly CrossDomainIntegrityNormalizedAuditCandidate[]
  /** Stable failures emitted by the independent exact-version File checker. */
  readonly externalFileFailureCodes: readonly FileMetadataIntegrityFailureCode[]
  /** Strict normalized non-Audit items with opaque row digests. */
  readonly items: readonly CrossDomainIntegrityNormalizedItem[]
  /** Opaque canonical continuation cursor, absent on the terminal page. */
  readonly nextCursor?: string
  /** Exact canonical retained-unit charge applied to the global run budget. */
  readonly retainedUnitCount: number
}

/** Closeable high-level reader that never exposes AWS SDK request or response types. */
export interface CrossDomainIntegrityNormalizedPageReader {
  /** Releases invocation-local AWS client resources. */
  close(): void

  /**
   * Reads and normalizes one bounded isolated table page.
   *
   * @param request - Keys, target, cursor, timestamp, and remaining capacity.
   * @returns Normalized records and an optional opaque continuation cursor.
   */
  readPage(
    request: CrossDomainIntegrityNormalizedPageRequest,
  ): Promise<CrossDomainIntegrityNormalizedPage>
}
