import { createHash } from 'node:crypto'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import type { EncodedAttributeMap } from './dynamodb-attribute-codec'

/** Stable identifier for the first production Workspace Search maintenance migration. */
export const WORKSPACE_SEARCH_MIGRATION_ID = 'workspace-search-maintenance'

/** Behavior and evidence schema version for the Workspace Search maintenance migration. */
export const WORKSPACE_SEARCH_MIGRATION_VERSION = 1

/** Minimum writer-drain observation required before a mutating maintenance run. */
export const MINIMUM_MAINTENANCE_DRAIN_SECONDS = 15 * 60

/** Maximum source rows read in one bounded DynamoDB page. */
export const WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE = 100

/** Stable source names covered by the first Workspace Search maintenance migration. */
export const workspaceSearchMigrationSourceNames = [
  'project-directory',
  'work-items',
  'collaboration',
  'documents',
] as const

/** Source name covered by the first Workspace Search maintenance migration. */
export type WorkspaceSearchMigrationSourceName =
  typeof workspaceSearchMigrationSourceNames[number]

/** Explicit operator command supported by the maintenance migration. */
export type WorkspaceSearchMigrationMode =
  | 'dry-run'
  | 'apply'
  | 'verify'
  | 'rollback'

/** Stable table roles pinned into migration configuration evidence. */
export type WorkspaceSearchMigrationTableRole =
  | WorkspaceSearchMigrationSourceName
  | 'workspace-search'
  | 'migration-state'

/** One DynamoDB key attribute recorded in a table descriptor. */
export type MigrationKeyAttribute = {
  /** Physical DynamoDB attribute name. */
  name: string
  /** Whether the attribute is the partition or sort key. */
  role: 'HASH' | 'RANGE'
  /** DynamoDB scalar type used by the key attribute. */
  type: 'B' | 'N' | 'S'
}

/** One DynamoDB global secondary index recorded for drift detection. */
export type MigrationGlobalSecondaryIndex = {
  /** Physical index name. */
  name: string
  /** Ordered partition and optional sort key descriptor. */
  key: readonly MigrationKeyAttribute[]
  /** Projection shape returned by the index. */
  projection: 'ALL' | 'INCLUDE' | 'KEYS_ONLY'
  /** Non-key attributes projected by an INCLUDE index. */
  nonKeyAttributes: readonly string[]
  /** Observed DynamoDB index state. */
  status: 'ACTIVE'
}

/** Immutable and schema-sensitive DynamoDB table identity pinned to one run. */
export type MigrationTableIdentity = {
  /** Logical role assigned to the table by this migration. */
  role: WorkspaceSearchMigrationTableRole
  /** Exact physical table name requested by the operator. */
  tableName: string
  /** AWS table ARN measured with DescribeTable. */
  tableArn: string
  /** Immutable DynamoDB table identifier measured with DescribeTable. */
  tableId: string
  /** Canonical UTC table creation time. */
  creationTime: string
  /** AWS account parsed from the measured table ARN. */
  account: string
  /** AWS region parsed from the measured table ARN. */
  region: string
  /** Ordered base-table key descriptor. */
  key: readonly MigrationKeyAttribute[]
  /** Active global secondary indexes, sorted by name. */
  globalSecondaryIndexes: readonly MigrationGlobalSecondaryIndex[]
  /** Observed billing mode. */
  billingMode: 'PAY_PER_REQUEST'
  /** Whether DynamoDB deletion protection was enabled. */
  deletionProtection: boolean
  /** Observed encryption family. */
  encryption: 'AWS_OWNED' | 'KMS'
  /** Canonical digest of the KMS key ARN, or null for AWS-owned encryption. */
  kmsKeyDigest: string | null
  /** Observed DynamoDB TTL status and optional attribute. */
  ttl: {
    /** Whether TTL is enabled or disabled. */
    status: 'DISABLED' | 'ENABLED'
    /** TTL attribute when TTL is enabled. */
    attribute?: string
  }
  /** Point-in-time recovery evidence captured immediately before the run. */
  pitr: {
    /** PITR must be enabled for every production source and target table. */
    status: 'ENABLED'
    /** Earliest restorable point measured from DynamoDB. */
    earliestRestorableTime: string
    /** Latest restorable point measured from DynamoDB. */
    latestRestorableTime: string
  }
}

/** Measured immutable and safety-sensitive S3 journal configuration. */
export type MigrationJournalIdentity = {
  /** Dedicated Object-Lock journal bucket name. */
  bucketName: string
  /** Customer-managed KMS key ARN configured on the bucket. */
  keyArn: string
  /** Creation time of the exact customer-managed KMS key. */
  keyCreationTime: string
  /** KMS must report a customer-managed key. */
  keyManager: 'CUSTOMER'
  /** KMS key must be enabled when the entry gate is measured. */
  keyState: 'Enabled'
  /** Journal encryption requires a symmetric encrypt/decrypt key. */
  keySpec: 'SYMMETRIC_DEFAULT'
  /** Journal encryption requires the encrypt/decrypt usage family. */
  keyUsage: 'ENCRYPT_DECRYPT'
  /** Journal key material must be generated and retained by AWS KMS. */
  keyOrigin: 'AWS_KMS'
  /** Migration v1 uses a single-region journal key. */
  keyMultiRegion: false
  /** Versioning must be enabled before any segment is accepted. */
  versioning: 'Enabled'
  /** Object Lock must use compliance mode. */
  objectLockMode: 'COMPLIANCE'
  /** Default compliance retention measured in whole days. */
  defaultRetentionDays: number
  /** Default bucket encryption algorithm. */
  encryption: 'aws:kms'
  /** Whether S3 Bucket Keys are enabled for the KMS rule. */
  bucketKeyEnabled: true
  /** Server-access-log destination bucket. */
  accessLogBucket: string
  /** Server-access-log object prefix. */
  accessLogPrefix: string
}

/** Immutable operator and infrastructure configuration reviewed before apply. */
export type WorkspaceSearchMigrationConfiguration = {
  /** Stable migration identifier. */
  migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Versioned migration behavior. */
  migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Expected AWS account supplied by the operator and confirmed by STS. */
  account: string
  /** Explicit AWS region used by every client. */
  region: string
  /** Explicit shared-configuration profile used to resolve credentials. */
  profile: string
  /** Exact reviewed Git commit containing the migration implementation. */
  commit: string
  /** Caller ARN returned by STS, retained for audit without logging it. */
  callerArn: string
  /** Stable IAM role unique ID recovered from STS GetCallerIdentity. */
  callerRoleId: string
  /** Source, target, and state table identities measured at runtime. */
  tables: Readonly<Record<WorkspaceSearchMigrationTableRole, MigrationTableIdentity>>
  /** Measured Object-Lock and encryption configuration for the journal bucket. */
  journal: MigrationJournalIdentity
  /** Versioned prefix reserved for this migration. */
  journalPrefix: 'workspace-search/v1'
}

/** Secret-free reviewed configuration evidence emitted by a dry run. */
export type WorkspaceSearchDryRunEvidence = {
  /** Evidence discriminator. */
  kind: 'workspace-search-migration-dry-run'
  /** Evidence schema version. */
  evidenceVersion: 1
  /** Stable migration identifier. */
  migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Deterministic digest of the measured configuration. */
  configurationHash: string
  /** Canonical start timestamp. */
  startedAt: string
  /** Canonical completion timestamp. */
  completedAt: string
  /** Per-source aggregate evidence without tenant identifiers. */
  sources: Readonly<Record<WorkspaceSearchMigrationSourceName, MigrationScanAggregate>>
  /** Aggregate evidence for existing searchable target rows. */
  target: MigrationScanAggregate
  /** Stable pass/fail outcome. */
  status: 'pass'
}

/** Exact source and target aggregates reproduced while building a plan. */
export type WorkspaceSearchMigrationScanSnapshot = {
  /** Reviewed configuration digest shared with the dry-run evidence. */
  configurationHash: string
  /** Complete per-source aggregates reproduced during planning. */
  sources: Readonly<Record<WorkspaceSearchMigrationSourceName, MigrationScanAggregate>>
  /** Complete Workspace Search target aggregate reproduced during planning. */
  target: MigrationScanAggregate
}

/** Order-independent, secret-free aggregate for a complete table scan. */
export type MigrationScanAggregate = {
  /** Exact number of rows scanned from the base table. */
  scanned: number
  /** Exact number of rows mapped into this migration's target set. */
  mapped: number
  /** Exact number of recognized but intentionally ignored rows. */
  ignored: number
  /** Exact number of malformed rows. A production-safe scan requires zero. */
  invalid: number
  /** Number of target put states represented by mapped rows. */
  projected: number
  /** Number of target absent states represented by mapped rows. */
  deleted: number
  /** Order-independent digest of canonical physical keys. */
  keyDigest: string
  /** Order-independent digest of canonical full row content. */
  contentDigest: string
  /** Number of DynamoDB pages consumed to finish the scan. */
  pageCount: number
}

/** Mutable counters used while one source or target table is scanned. */
export type MigrationScanCounters = {
  /** Exact number of rows scanned from the base table. */
  scanned: number
  /** Exact number of rows mapped into this migration's target set. */
  mapped: number
  /** Exact number of recognized but intentionally ignored rows. */
  ignored: number
  /** Exact number of malformed rows. */
  invalid: number
  /** Number of target put states represented by mapped rows. */
  projected: number
  /** Number of target absent states represented by mapped rows. */
  deleted: number
  /** Number of DynamoDB pages consumed. */
  pageCount: number
}

/** Low-level DynamoDB item whose native AttributeValue representation is preserved. */
export type DynamoAttributeMap = Record<string, AttributeValue>

/** Exact present or absent DynamoDB item state used by apply and rollback CAS. */
export type MigrationItemSnapshot =
  | {
      /** Indicates that no item existed at the key. */
      exists: false
      /** Stable digest of the absent state. */
      digest: string
    }
  | {
      /** Indicates that an item existed at the key. */
      exists: true
      /** Exact low-level DynamoDB item. */
      item: DynamoAttributeMap
      /** Stable digest of the exact low-level item. */
      digest: string
    }

/** JSON-safe exact present or absent item state stored in immutable evidence. */
export type EncodedMigrationItemSnapshot =
  | {
      /** Indicates that no item existed at the key. */
      exists: false
      /** Stable digest of the absent state. */
      digest: string
    }
  | {
      /** Indicates that an item existed at the key. */
      exists: true
      /** Losslessly encoded low-level DynamoDB item. */
      item: EncodedAttributeMap
      /** Stable digest of the exact low-level item. */
      digest: string
    }

/** Exact present source binding used to prevent source drift during a target mutation. */
export type MigrationSourceBinding = {
  /** Indicates that the planned source item must still exist. */
  exists: true
  /** Logical source name. */
  source: WorkspaceSearchMigrationSourceName
  /** Immutable physical source TableId. */
  tableId: string
  /** Exact source table name. */
  tableName: string
  /** Exact low-level source primary key. */
  key: DynamoAttributeMap
  /** Digest of the exact source primary key. */
  keyDigest: string
  /** Exact low-level source item observed while planning. */
  item: DynamoAttributeMap
  /** Digest of the exact source item. */
  itemDigest: string
}

/** Exact absent source binding used to prevent orphan-reconciliation drift. */
export type MigrationAbsentSourceBinding = {
  /** Indicates that no source item may exist at the planned key. */
  exists: false
  /** Logical source name. */
  source: WorkspaceSearchMigrationSourceName
  /** Immutable physical source TableId. */
  tableId: string
  /** Exact source table name. */
  tableName: string
  /** Exact low-level source primary key whose absence was planned. */
  key: DynamoAttributeMap
  /** Digest of the exact source primary key. */
  keyDigest: string
}

/** Exact present or absent source condition checked with every target mutation. */
export type MigrationSourceCondition =
  | MigrationAbsentSourceBinding
  | MigrationSourceBinding

/** Deterministic target plan derived from one source row or orphan target row. */
export type WorkspaceSearchMigrationOperation = {
  /** Stable operation identifier that does not change when source content drifts. */
  operationId: string
  /** Exact present or absent source state required when this operation commits. */
  sourceCondition: MigrationSourceCondition
  /** Exact low-level target primary key. */
  targetKey: DynamoAttributeMap
  /** Digest used for target-receipt lookup without exposing tenant keys. */
  targetKeyDigest: string
  /** Exact target state captured before mutation. */
  before: MigrationItemSnapshot
  /** Exact intended target state. */
  after: MigrationItemSnapshot
  /** Covered Workspace Search entity family. */
  entityType: 'comment' | 'document' | 'project' | 'team' | 'work-item'
}

/** Active fenced lease required by every mutating transaction. */
export type WorkspaceSearchMigrationLease = {
  /** Operator-selected run identifier. */
  runId: string
  /** Operator-selected owner identifier. */
  ownerId: string
  /** Monotonically increasing takeover token. */
  fenceToken: number
  /** Canonical UTC exclusive lease expiry. */
  expiresAt: string
  /** Canonical UTC heartbeat time. */
  heartbeatAt: string
}

/** Fresh maintenance evidence bound to one run and fenced lease holder. */
export type WorkspaceSearchMaintenanceEvidenceReceipt = {
  /** Operator-selected run identifier bound to the validated evidence. */
  runId: string
  /** Digest of the exact maintenance evidence bytes validated for this lease. */
  evidenceDigest: string
  /** Secret-free external locator copied from the validated evidence. */
  evidenceLocator: string
  /** Runtime-control revision shared by every validated surface observation. */
  runtimeRevision: number
  /** Fence token whose mutating transactions may consume this receipt. */
  fenceToken: number
  /** Canonical UTC time at which the evidence was validated. */
  validatedAt: string
  /** Oldest drain-completion or surface-observation time controlling freshness. */
  oldestObservationAt: string
  /** Canonical UTC exclusive deadline at which the evidence must be refreshed. */
  validUntil: string
}

/** Durable lifecycle state for one migration run. */
export type WorkspaceSearchMigrationRunState = {
  /** Operator-selected run identifier. */
  runId: string
  /** Positive optimistic-concurrency revision for every durable state update. */
  revision: number
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Exact measured configuration. */
  configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the current validated maintenance evidence bytes. */
  maintenanceEvidenceDigest: string
  /** Secret-free locator from the current validated maintenance evidence. */
  maintenanceEvidenceLocator: string
  /** Fresh evidence validation bound to the current fenced lease. */
  maintenanceEvidenceReceipt: WorkspaceSearchMaintenanceEvidenceReceipt
  /** Digest of the exact reviewed dry-run evidence bytes. */
  dryRunEvidenceDigest: string
  /** Digest of the sealed deterministic operation plan. */
  planDigest: string
  /** Exact number of operations represented by the sealed plan. */
  planOperationCount: number
  /** Immutable S3 version that anchors the reviewed plan root and count. */
  planSealReference: WorkspaceSearchPlanSealReference
  /** Current state-machine status. */
  status:
    | 'applying'
    | 'applied'
    | 'verifying'
    | 'verified'
    | 'rolling-back'
    | 'rolled-back'
  /** Exact number of durable apply markers, including already-current operations. */
  appliedOperationCount: number
  /** Restorable digest state for every durable apply marker. */
  applyMarkerDigestState: MigrationDigestState
  /** Highest committed journal sequence, counting target mutations only. */
  journalSequence: number
  /** Hash-chain head of the highest committed journal metadata row. */
  journalHeadDigest: string
  /** Durable apply traversal state kept independently from verification. */
  apply: WorkspaceSearchMigrationTraversalProgress
  /** Durable verification traversal state once verification begins. */
  verification?: WorkspaceSearchMigrationTraversalProgress
  /** Immutable complete verification evidence once verification succeeds. */
  verificationEvidenceReference?: WorkspaceSearchVerificationEvidenceReference
  /** Immutable S3 seal anchoring the final apply chain and aggregate. */
  applySeal?: WorkspaceSearchApplySealReference
  /** Reverse-order rollback progress once rollback begins. */
  rollback?: WorkspaceSearchRollbackProgress
  /** Canonical UTC creation time. */
  createdAt: string
  /** Canonical UTC last state transition or checkpoint time. */
  updatedAt: string
}

/** Durable source and target traversal state for one migration phase. */
export type WorkspaceSearchMigrationTraversalProgress = {
  /** Per-source durable scan checkpoints. */
  sources: Readonly<Record<WorkspaceSearchMigrationSourceName, MigrationSourceCheckpoint>>
  /** Durable target-reconciliation or verification checkpoint. */
  target: MigrationSourceCheckpoint
}

/** Immutable root document anchoring one reviewed deterministic operation plan. */
export type WorkspaceSearchPlanSeal = {
  /** Plan-seal document discriminator. */
  kind: 'workspace-search-plan-seal'
  /** Plan-seal schema version. */
  sealVersion: 2
  /** Stable migration identifier. */
  migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  runId: string
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Digest of the exact operator-reviewed dry-run evidence. */
  dryRunEvidenceDigest: string
  /** Digest of the source/target scan aggregates reproduced while planning. */
  planningSnapshotDigest: string
  /** Merkle root of the ordered exact operation plan. */
  planDigest: string
  /** Exact number of leaves in the ordered operation plan. */
  planOperationCount: number
  /** Exact number of operations derived from present source rows. */
  sourceOperationCount: number
  /** Exact number of target-orphan deletion operations. */
  orphanOperationCount: number
  /** Canonical UTC plan sealing time. */
  createdAt: string
}

/** Immutable S3 locator for one exact reviewed plan-seal version. */
export type WorkspaceSearchPlanSealReference = {
  /** Exact S3 object key. */
  objectKey: string
  /** Exact immutable S3 object version. */
  versionId: string
  /** SHA-256 digest of the exact canonical plan-seal bytes. */
  contentDigest: string
}

/** Immutable complete full-scan evidence for one successful verification. */
export type WorkspaceSearchVerificationEvidence = {
  /** Verification-evidence document discriminator. */
  kind: 'workspace-search-verification-evidence'
  /** Verification-evidence schema version. */
  evidenceVersion: 1
  /** Stable migration identifier. */
  migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  runId: string
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Merkle root of the exact reviewed operation plan. */
  planDigest: string
  /** Exact reviewed plan operation count. */
  planOperationCount: number
  /** Content digest of the immutable complete-plan apply seal. */
  applySealContentDigest: string
  /** Exact completed source and target verification checkpoints. */
  verification: WorkspaceSearchMigrationTraversalProgress
  /** Stable successful verification result. */
  status: 'pass'
  /** Canonical UTC verification completion time. */
  completedAt: string
}

/** Immutable S3 locator for complete verification evidence. */
export type WorkspaceSearchVerificationEvidenceReference = {
  /** Exact S3 object key. */
  objectKey: string
  /** Exact immutable S3 object version. */
  versionId: string
  /** SHA-256 digest of the exact canonical verification evidence bytes. */
  contentDigest: string
}

/** Serializable internal state required to resume an order-independent digest. */
export type MigrationDigestState = {
  /** Exact number of digests already accumulated. */
  count: number
  /** Modular 256-bit sum encoded as 64 lowercase hexadecimal characters. */
  sumHex: string
  /** Byte-wise XOR encoded as 64 lowercase hexadecimal characters. */
  xorHex: string
}

/** Durable cursor and aggregate for a bounded scan. */
export type MigrationSourceCheckpoint = {
  /** Whether the complete source or target scan finished. */
  completed: boolean
  /** Low-level DynamoDB LastEvaluatedKey for the next page. */
  cursor?: DynamoAttributeMap
  /** Cumulative secret-free counters and digests. */
  aggregate: MigrationScanAggregate
  /** Restorable accumulator state for physical key digests. */
  keyDigestState: MigrationDigestState
  /** Restorable accumulator state for full row-content digests. */
  contentDigestState: MigrationDigestState
}

/** Immutable S3 preimage segment stored before a target transaction. */
export type WorkspaceSearchJournalSegment = {
  /** Journal document discriminator. */
  kind: 'workspace-search-preimage-segment'
  /** Journal document schema version. */
  segmentVersion: 1
  /** Stable migration identifier. */
  migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  runId: string
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Monotonic sequence reserved by the pending transaction. */
  sequence: number
  /** Fence token held when the immutable segment was first prepared. */
  preparedFenceToken: number
  /** Stable operation identifier. */
  operationId: string
  /** Digest of the exact source item, absent for orphan reconciliation. */
  sourceDigest?: string
  /** Previous committed journal-chain head. */
  previousHeadDigest: string
  /** Losslessly encoded exact target primary key required for restart-safe rollback. */
  targetKey: EncodedAttributeMap
  /** Digest of the target primary key. */
  targetKeyDigest: string
  /** Losslessly encoded exact target preimage. */
  before: EncodedMigrationItemSnapshot
  /** Losslessly encoded exact intended post-migration state used by rollback CAS. */
  after: EncodedMigrationItemSnapshot
  /** Canonical UTC segment creation time. */
  createdAt: string
}

/** Immutable locator for one encrypted S3 journal segment version. */
export type WorkspaceSearchJournalReference = {
  /** Exact S3 object key. */
  objectKey: string
  /** Exact immutable S3 object version. */
  versionId: string
  /** SHA-256 digest of the exact stored bytes. */
  contentDigest: string
  /** Hash-chain digest committed with the operation marker. */
  headDigest: string
}

/** Durable operation marker written atomically with one target mutation. */
export type WorkspaceSearchOperationReceipt = {
  /** Operation-marker discriminator. */
  kind: 'workspace-search-operation-applied'
  /** Operation-marker schema version. */
  markerVersion: 1
  /** Operator-selected run identifier. */
  runId: string
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Stable operation identifier. */
  operationId: string
  /** One-based position of this operation in the immutable sealed plan. */
  planSequence: number
  /** Digest of the exact immutable planned operation. */
  planOperationDigest: string
  /** Monotonic application sequence. */
  sequence: number
  /** Digest of the exact target primary key. */
  targetKeyDigest: string
  /** Digest of the exact source item, absent for orphan reconciliation. */
  sourceDigest?: string
  /** Digest of the target preimage. */
  beforeDigest: string
  /** Digest of the intended post-migration state. */
  afterDigest: string
  /** Fence token that committed the operation. */
  fenceToken: number
  /** Digest of the exact fresh maintenance-evidence receipt authorizing the commit. */
  maintenanceEvidenceReceiptDigest: string
  /** Immutable preimage journal reference. */
  journal: WorkspaceSearchJournalReference
  /** Canonical UTC commit time. */
  committedAt: string
}

/** Durable marker for a planned operation whose intended target was already current. */
export type WorkspaceSearchAlreadyCurrentOperationMarker = {
  /** Operation-marker discriminator. */
  kind: 'workspace-search-operation-already-current'
  /** Operation-marker schema version. */
  markerVersion: 1
  /** Operator-selected run identifier. */
  runId: string
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Stable operation identifier. */
  operationId: string
  /** One-based position of this operation in the immutable sealed plan. */
  planSequence: number
  /** Digest of the exact immutable planned operation. */
  planOperationDigest: string
  /** Digest of the exact target primary key. */
  targetKeyDigest: string
  /** Digest of the exact source item, absent for orphan reconciliation. */
  sourceDigest?: string
  /** Digest of the already-current intended target state. */
  afterDigest: string
  /** Fence token that recorded the operation. */
  fenceToken: number
  /** Digest of the exact fresh maintenance-evidence receipt authorizing the marker. */
  maintenanceEvidenceReceiptDigest: string
  /** Canonical UTC time at which the no-op marker was recorded. */
  recordedAt: string
}

/**
 * Durable apply marker covering both target mutations and already-current operations.
 */
export type WorkspaceSearchOperationMarker =
  | WorkspaceSearchAlreadyCurrentOperationMarker
  | WorkspaceSearchOperationReceipt

/** Immutable apply-chain seal stored separately from mutable DynamoDB state. */
export type WorkspaceSearchApplySeal = {
  /** Seal document discriminator. */
  kind: 'workspace-search-apply-seal'
  /** Seal document schema version. */
  sealVersion: 1
  /** Stable migration identifier. */
  migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  runId: string
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Whether the seal covers the complete plan or an aborted committed prefix. */
  scope: 'committed-prefix' | 'complete-plan'
  /** Digest of the immutable operation plan bound to this run. */
  planDigest: string
  /** Exact operation count in the immutable operation plan. */
  planOperationCount: number
  /** Highest contiguous committed journal sequence. */
  journalSequence: number
  /** Final independently anchored journal-chain head. */
  journalHeadDigest: string
  /** Exact count of durable apply markers, including already-current operations. */
  markerCount: number
  /** Digest of the complete durable apply-marker aggregate. */
  applyMarkerAggregateDigest: string
  /** Canonical UTC seal creation time. */
  createdAt: string
}

/** Immutable reference to the independently anchored apply-chain seal. */
export type WorkspaceSearchApplySealReference = {
  /** Whether the immutable seal covers the complete plan or a committed prefix. */
  scope: WorkspaceSearchApplySeal['scope']
  /** Exact S3 object key. */
  objectKey: string
  /** Exact immutable S3 object version. */
  versionId: string
  /** SHA-256 digest of the exact stored seal bytes. */
  contentDigest: string
}

/** Durable reverse-order rollback cursor and chain state. */
export type WorkspaceSearchRollbackProgress = {
  /** Final committed apply sequence captured when rollback starts. */
  upperBoundSequence: number
  /** Next sequence to restore, or zero after rollback is complete. */
  nextSequence: number
  /** Journal head expected at the next reverse step. */
  expectedHeadDigest: string
  /** Exact count of operations already restored. */
  restored: number
}

/** Durable marker committed atomically with one reverse target mutation. */
export type WorkspaceSearchRollbackReceipt = {
  /** Rollback-marker discriminator. */
  kind: 'workspace-search-operation-rolled-back'
  /** Rollback-marker schema version. */
  markerVersion: 1
  /** Operator-selected run identifier. */
  runId: string
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Stable operation identifier restored by this transaction. */
  operationId: string
  /** Reverse journal sequence restored by this transaction. */
  sequence: number
  /** Digest of the exact apply receipt used as rollback authority. */
  applyReceiptDigest: string
  /** Digest of the exact target primary key. */
  targetKeyDigest: string
  /** Digest of the restored pre-migration state. */
  beforeDigest: string
  /** Digest of the replaced post-migration state. */
  afterDigest: string
  /** Apply journal head consumed by this reverse step. */
  journalHeadDigest: string
  /** Current fence token that committed the rollback transaction. */
  fenceToken: number
  /** Digest of the exact fresh maintenance-evidence receipt authorizing the rollback. */
  maintenanceEvidenceReceiptDigest: string
  /** Canonical UTC rollback commit time. */
  rolledBackAt: string
}

/** Stable failure code emitted without raw AWS errors or tenant identifiers. */
export type WorkspaceSearchMigrationFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_DRIFT'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'DRY_RUN_INVALID_ROWS'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_JOURNAL'
  | 'INVALID_MAINTENANCE_EVIDENCE'
  | 'INVALID_STATE'
  | 'JOURNAL_WRITE_FAILED'
  | 'LEASE_CONFLICT'
  | 'LEASE_LOST'
  | 'PITR_NOT_READY'
  | 'ROLLBACK_TARGET_DRIFT'
  | 'SOURCE_DRIFT'
  | 'TABLE_SCHEMA_MISMATCH'
  | 'TARGET_DRIFT'
  | 'TRANSIENT_INFRASTRUCTURE_FAILURE'
  | 'VERIFY_FAILED'

/** Error with a stable operator-safe code and no embedded tenant or AWS payload. */
export class WorkspaceSearchMigrationFailure extends Error {
  /** Stable failure code suitable for logs and automation. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates an operator-safe migration failure.
   *
   * @param code - Stable failure code.
   * @param message - Secret-free operator guidance.
   */
  constructor(
    code: WorkspaceSearchMigrationFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceSearchMigrationFailure'
    this.code = code
  }
}

/**
 * Creates a deterministic digest for a JSON-compatible value.
 *
 * @param value - Strictly JSON-compatible value.
 * @returns Lowercase SHA-256 digest.
 */
export function createMigrationDigest(value: unknown): string {
  return createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')
}

/**
 * Serializes JSON-compatible data with stable UTF-8 object-key ordering.
 *
 * @param value - Strictly JSON-compatible value.
 * @returns Canonical JSON text.
 */
export function serializeCanonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value))
}

/**
 * Creates the reviewed configuration digest used by dry-run, apply, verify, and rollback.
 *
 * @param configuration - Measured immutable migration configuration.
 * @returns Lowercase SHA-256 configuration digest.
 */
export function createWorkspaceSearchConfigurationHash(
  configuration: WorkspaceSearchMigrationConfiguration,
): string {
  const tables = {
    'project-directory': createHashableTableIdentity(
      configuration.tables['project-directory'],
    ),
    'work-items': createHashableTableIdentity(
      configuration.tables['work-items'],
    ),
    collaboration: createHashableTableIdentity(
      configuration.tables.collaboration,
    ),
    documents: createHashableTableIdentity(
      configuration.tables.documents,
    ),
    'workspace-search': createHashableTableIdentity(
      configuration.tables['workspace-search'],
    ),
    'migration-state': createHashableTableIdentity(
      configuration.tables['migration-state'],
    ),
  } satisfies Readonly<
    Record<
      WorkspaceSearchMigrationTableRole,
      ReturnType<typeof createHashableTableIdentity>
    >
  >

  return createMigrationDigest({
    migrationId: configuration.migrationId,
    migrationVersion: configuration.migrationVersion,
    account: configuration.account,
    region: configuration.region,
    profile: configuration.profile,
    commit: configuration.commit,
    callerIdentity: createHashableCallerIdentity(
      configuration.callerArn,
      configuration.callerRoleId,
    ),
    tables,
    journal: configuration.journal,
    journalPrefix: configuration.journalPrefix,
  })
}

/**
 * Creates the domain-separated digest of the exact aggregates reproduced while
 * planning.
 *
 * The digest deliberately excludes timestamps and page ordering so it can be
 * compared with an independently reviewed dry run while still binding every
 * source and target row classification and content aggregate.
 *
 * @param snapshot - Reviewed configuration and complete scan aggregates.
 * @returns Lowercase SHA-256 planning-snapshot digest.
 */
export function createWorkspaceSearchMigrationScanSnapshotDigest(
  snapshot: WorkspaceSearchMigrationScanSnapshot,
): string {
  if (
    !isRecord(snapshot) ||
    Object.keys(snapshot).sort(compareUtf8Ordinal).join('\u0000') !==
      'configurationHash\u0000sources\u0000target' ||
    !isRecord(snapshot.sources) ||
    Object.keys(snapshot.sources).sort(compareUtf8Ordinal).join('\u0000') !==
      'collaboration\u0000documents\u0000project-directory\u0000work-items'
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Planning snapshot shape is invalid.',
    )
  }
  requireHexDigest(snapshot.configurationHash, 'planning configuration hash')
  const sources = {
    'project-directory': requireMigrationScanAggregate(
      snapshot.sources['project-directory'],
      'project-directory planning aggregate',
    ),
    'work-items': requireMigrationScanAggregate(
      snapshot.sources['work-items'],
      'work-items planning aggregate',
    ),
    collaboration: requireMigrationScanAggregate(
      snapshot.sources.collaboration,
      'collaboration planning aggregate',
    ),
    documents: requireMigrationScanAggregate(
      snapshot.sources.documents,
      'documents planning aggregate',
    ),
  } satisfies Readonly<
    Record<WorkspaceSearchMigrationSourceName, MigrationScanAggregate>
  >
  const target = requireMigrationScanAggregate(
    snapshot.target,
    'target planning aggregate',
  )

  return createMigrationDigest({
    kind: 'workspace-search-migration-scan-snapshot',
    snapshotVersion: 1,
    configurationHash: snapshot.configurationHash,
    sources,
    target,
  })
}

/**
 * Creates an empty aggregate with canonical absent digests.
 *
 * @returns Empty migration scan aggregate.
 */
export function createEmptyMigrationScanAggregate(): MigrationScanAggregate {
  const emptyDigest = new MigrationDigestAccumulator().digest()
  return {
    scanned: 0,
    mapped: 0,
    ignored: 0,
    invalid: 0,
    projected: 0,
    deleted: 0,
    keyDigest: emptyDigest,
    contentDigest: emptyDigest,
    pageCount: 0,
  }
}

/**
 * Validates and returns one complete scan aggregate.
 *
 * @param aggregate - Candidate aggregate.
 * @param label - Secret-free aggregate purpose.
 * @returns The validated aggregate.
 */
function requireMigrationScanAggregate(
  aggregate: MigrationScanAggregate,
  label: string,
): MigrationScanAggregate {
  const expectedKeys = [
    'contentDigest',
    'deleted',
    'ignored',
    'invalid',
    'keyDigest',
    'mapped',
    'pageCount',
    'projected',
    'scanned',
  ]
  if (
    !isRecord(aggregate) ||
    Object.keys(aggregate).sort(compareUtf8Ordinal).join('\u0000') !==
      expectedKeys.join('\u0000')
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Planning aggregate shape is invalid.',
    )
  }
  requireNonNegativeInteger(aggregate.scanned, `${label} scanned count`)
  requireNonNegativeInteger(aggregate.mapped, `${label} mapped count`)
  requireNonNegativeInteger(aggregate.ignored, `${label} ignored count`)
  requireNonNegativeInteger(aggregate.invalid, `${label} invalid count`)
  requireNonNegativeInteger(aggregate.projected, `${label} projected count`)
  requireNonNegativeInteger(aggregate.deleted, `${label} deleted count`)
  requireNonNegativeInteger(aggregate.pageCount, `${label} page count`)
  requireHexDigest(aggregate.keyDigest, `${label} key digest`)
  requireHexDigest(aggregate.contentDigest, `${label} content digest`)
  if (
    aggregate.mapped + aggregate.ignored + aggregate.invalid !==
      aggregate.scanned ||
    aggregate.projected + aggregate.deleted !== aggregate.mapped
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Planning aggregate counters are inconsistent.',
    )
  }
  return {
    scanned: aggregate.scanned,
    mapped: aggregate.mapped,
    ignored: aggregate.ignored,
    invalid: aggregate.invalid,
    projected: aggregate.projected,
    deleted: aggregate.deleted,
    keyDigest: aggregate.keyDigest,
    contentDigest: aggregate.contentDigest,
    pageCount: aggregate.pageCount,
  }
}

/**
 * Builds a stable operation identifier from immutable source identity or an orphan target key.
 *
 * @param input - Configuration, physical source, and target bindings.
 * @returns Lowercase SHA-256 operation identifier.
 */
export function createWorkspaceSearchOperationId(input: {
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Immutable source TableId, or the orphan-target marker. */
  sourceTableId: string
  /** Exact source key digest, or target key digest for an orphan. */
  sourceKeyDigest: string
  /** Exact target key digest. */
  targetKeyDigest: string
}): string {
  requireHexDigest(input.configurationHash, 'configuration hash')
  requireNonEmptyText(input.sourceTableId, 'source TableId')
  requireHexDigest(input.sourceKeyDigest, 'source key digest')
  requireHexDigest(input.targetKeyDigest, 'target key digest')
  return createMigrationDigest({
    configurationHash: input.configurationHash,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    sourceKeyDigest: input.sourceKeyDigest,
    sourceTableId: input.sourceTableId,
    targetKeyDigest: input.targetKeyDigest,
  })
}

/**
 * Computes a journal-chain head from immutable metadata and exact segment bytes.
 *
 * @param input - Previous chain head and committed segment identity.
 * @returns Lowercase SHA-256 chain head.
 */
export function createJournalHeadDigest(input: {
  /** Previous committed chain head. */
  previousHeadDigest: string
  /** Monotonic journal sequence. */
  sequence: number
  /** Stable operation identifier. */
  operationId: string
  /** SHA-256 digest of exact journal bytes. */
  contentDigest: string
  /** Exact immutable S3 version. */
  versionId: string
}): string {
  requireHexDigest(input.previousHeadDigest, 'previous journal head')
  requirePositiveInteger(input.sequence, 'journal sequence')
  requireHexDigest(input.operationId, 'operation ID')
  requireHexDigest(input.contentDigest, 'journal content digest')
  requireNonEmptyText(input.versionId, 'journal version ID')
  return createMigrationDigest(input)
}

/**
 * Checks one conventional lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Whether the value is a lowercase 64-character digest.
 */
export function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * Checks a canonical UTC ISO-8601 timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Whether the timestamp round-trips through Date.toISOString.
 */
export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

/**
 * Validates an operator-selected identifier used in DynamoDB and S3 keys.
 *
 * @param value - Candidate identifier.
 * @param label - Secret-free field label for the error.
 * @returns Valid identifier.
 */
export function requireMigrationIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_ARGUMENT',
      `${label} must use 1-128 safe identifier characters.`,
    )
  }
  return value
}

/**
 * Validates an exact lowercase Git commit identifier.
 *
 * @param value - Candidate commit OID.
 * @returns Valid 40-character commit OID.
 */
export function requireCommitOid(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_ARGUMENT',
      'Migration commit must be a lowercase 40-character Git OID.',
    )
  }
  return value
}

/**
 * Creates a zero SHA-256-sized digest used as the first journal-chain head.
 *
 * @returns Sixty-four zero characters.
 */
export function zeroHexDigest(): string {
  return '0'.repeat(64)
}

/**
 * Accumulates order-independent key and content evidence with bounded memory.
 *
 * The combined count, byte-wise XOR, and modular 256-bit sum prevent page order
 * from affecting evidence while retaining stronger duplicate sensitivity than
 * XOR alone.
 */
export class MigrationDigestAccumulator {
  /** Number of digests accumulated. */
  private count = 0
  /** Byte-wise XOR of every digest. */
  private readonly xor = new Uint8Array(32)
  /** Modular 256-bit sum of every digest. */
  private sum = 0n

  /**
   * Restores an accumulator from an exact durable checkpoint.
   *
   * @param state - Validated count, sum, and XOR state.
   * @returns Accumulator that continues from the checkpoint without double counting.
   */
  static fromState(state: MigrationDigestState): MigrationDigestAccumulator {
    requireNonNegativeInteger(state.count, 'aggregate digest count')
    requireHexDigest(state.sumHex, 'aggregate digest sum')
    requireHexDigest(state.xorHex, 'aggregate digest XOR')

    const accumulator = new MigrationDigestAccumulator()
    accumulator.count = state.count
    accumulator.sum = BigInt(`0x${state.sumHex}`)
    accumulator.xor.set(Buffer.from(state.xorHex, 'hex'))
    return accumulator
  }

  /**
   * Adds one canonical lowercase SHA-256 digest.
   *
   * @param digest - Digest to add.
   */
  add(digest: string): void {
    requireHexDigest(digest, 'aggregate digest')
    if (this.count === Number.MAX_SAFE_INTEGER) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Aggregate digest count exceeds the safe integer range.',
      )
    }
    const bytes = Buffer.from(digest, 'hex')
    for (let index = 0; index < this.xor.length; index += 1) {
      this.xor[index] = this.xor[index] ^ (bytes[index] ?? 0)
    }
    this.sum = (this.sum + BigInt(`0x${digest}`)) % (1n << 256n)
    this.count += 1
  }

  /**
   * Returns a stable digest of the current aggregate.
   *
   * @returns Lowercase SHA-256 aggregate digest.
   */
  digest(): string {
    const state = this.exportState()
    return createMigrationDigest({
      count: state.count,
      sum: state.sumHex,
      xor: state.xorHex,
    })
  }

  /**
   * Exports the complete serializable state required for exact resume.
   *
   * @returns Durable count, modular sum, and byte-wise XOR state.
   */
  exportState(): MigrationDigestState {
    return {
      count: this.count,
      sumHex: this.sum.toString(16).padStart(64, '0'),
      xorHex: Buffer.from(this.xor).toString('hex'),
    }
  }

  /**
   * Returns the exact number of accumulated entries.
   *
   * @returns Entry count.
   */
  size(): number {
    return this.count
  }
}

/**
 * Converts an unknown JSON-compatible value into a canonical recursive shape.
 *
 * @param value - Value to normalize.
 * @returns Canonical JSON-compatible value.
 */
function normalizeJsonValue(
  value: unknown,
): null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry))
  }
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort(compareUtf8Ordinal)) {
      const entry = value[key]
      if (entry !== undefined) {
        defineOwnProperty(normalized, key, normalizeJsonValue(entry))
      }
    }
    return normalized
  }
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_STATE',
    'Migration evidence contains a non-JSON-compatible value.',
  )
}

/**
 * Defines an own data property without invoking the legacy `__proto__` setter.
 *
 * @param record - Destination canonical JSON record.
 * @param key - Exact source property name.
 * @param value - Canonically normalized property value.
 */
function defineOwnProperty(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

/**
 * Selects stable table identity fields for the reviewed configuration hash.
 *
 * PITR restore-window timestamps are retained in run evidence but excluded from
 * the hash because DynamoDB advances them continuously between dry-run, apply,
 * verify, and rollback invocations.
 *
 * @param identity - Complete measured table identity and PITR evidence.
 * @returns Stable identity fields and required PITR status.
 */
function createHashableTableIdentity(identity: MigrationTableIdentity): {
  /** Logical migration role. */
  role: WorkspaceSearchMigrationTableRole
  /** Exact physical table name. */
  tableName: string
  /** Exact physical table ARN. */
  tableArn: string
  /** Immutable DynamoDB TableId. */
  tableId: string
  /** Immutable table creation timestamp. */
  creationTime: string
  /** AWS account parsed from the table ARN. */
  account: string
  /** AWS region parsed from the table ARN. */
  region: string
  /** Exact base-table key schema. */
  key: readonly MigrationKeyAttribute[]
  /** Exact active global secondary indexes. */
  globalSecondaryIndexes: readonly MigrationGlobalSecondaryIndex[]
  /** Exact billing mode. */
  billingMode: 'PAY_PER_REQUEST'
  /** Exact deletion-protection setting. */
  deletionProtection: boolean
  /** Exact encryption family. */
  encryption: 'AWS_OWNED' | 'KMS'
  /** Canonical digest of the KMS key ARN, or null for AWS-owned encryption. */
  kmsKeyDigest: string | null
  /** Exact TTL setting. */
  ttl: MigrationTableIdentity['ttl']
  /** Required point-in-time recovery state without volatile restore times. */
  pitrStatus: 'ENABLED'
} {
  return {
    role: identity.role,
    tableName: identity.tableName,
    tableArn: identity.tableArn,
    tableId: identity.tableId,
    creationTime: identity.creationTime,
    account: identity.account,
    region: identity.region,
    key: identity.key,
    globalSecondaryIndexes: identity.globalSecondaryIndexes,
    billingMode: identity.billingMode,
    deletionProtection: identity.deletionProtection,
    encryption: identity.encryption,
    kmsKeyDigest: identity.kmsKeyDigest,
    ttl: identity.ttl,
    pitrStatus: identity.pitr.status,
  }
}

/**
 * Selects the stable role identity from an exact STS assumed-role caller ARN.
 *
 * STS role-session ARNs do not expose an IAM role path, so this projection
 * deliberately records the STS partition, account, and role name instead of
 * fabricating an IAM role ARN. The exact session ARN remains in run evidence.
 *
 * @param callerArn - Exact caller ARN returned by STS GetCallerIdentity.
 * @param callerRoleId - Stable IAM role unique ID returned in STS UserId.
 * @returns Stable assumed-role identity without the volatile session name.
 */
function createHashableCallerIdentity(
  callerArn: string,
  callerRoleId: string,
): {
  /** AWS ARN partition. */
  partition: string
  /** AWS account that owns the assumed role. */
  account: string
  /** STS role name without the session name. */
  roleName: string
  /** Stable IAM role unique ID that changes when the role is recreated. */
  roleId: string
} {
  const parts = callerArn.split(':')
  const resourceSegments = parts[5]?.split('/')
  const partition = parts[1]
  const account = parts[4]
  const roleName = resourceSegments?.[1]
  const sessionName = resourceSegments?.[2]
  if (
    parts.length !== 6 ||
    parts[0] !== 'arn' ||
    !partition ||
    parts[2] !== 'sts' ||
    parts[3] !== '' ||
    !account ||
    resourceSegments?.length !== 3 ||
    resourceSegments[0] !== 'assumed-role' ||
    !roleName ||
    !sessionName ||
    !/^AROA[A-Z0-9]{17}$/u.test(callerRoleId)
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Migration caller identity is not a valid assumed-role session.',
    )
  }
  return { partition, account, roleName, roleId: callerRoleId }
}

/**
 * Compares strings by their UTF-8 byte representation.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive comparison value.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * Narrows an unknown value to a non-array object.
 *
 * @param value - Value to inspect.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires a non-empty string without exposing its value in an error.
 *
 * @param value - Candidate text.
 * @param label - Secret-free field label.
 */
function requireNonEmptyText(value: string, label: string): void {
  if (!value.trim()) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      `${label} must not be empty.`,
    )
  }
}

/**
 * Requires one positive safe integer.
 *
 * @param value - Candidate number.
 * @param label - Secret-free field label.
 */
function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      `${label} must be a positive integer.`,
    )
  }
}

/**
 * Requires one non-negative safe integer.
 *
 * @param value - Candidate number.
 * @param label - Secret-free field label.
 */
function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      `${label} must be a non-negative integer.`,
    )
  }
}

/**
 * Requires one canonical lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param label - Secret-free field label.
 */
function requireHexDigest(value: string, label: string): void {
  if (!isHexDigest(value)) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      `${label} must be a lowercase SHA-256 digest.`,
    )
  }
}
