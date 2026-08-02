import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  CloudWatchClient,
  PutMetricDataCommand,
  type StandardUnit,
} from '@aws-sdk/client-cloudwatch'
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3'
import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager'
import {
  DescribeExecutionCommand,
  SFNClient,
} from '@aws-sdk/client-sfn'
import {
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  createCrossDomainIntegrityNormalizedPageReader,
  type CrossDomainIntegrityFailureCode,
  type CrossDomainIntegrityNormalizedPageReader,
  type CrossDomainIntegrityNormalizedPageReaderConfiguration,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityTableNames,
  type CrossDomainIntegrityTableTarget,
} from '../data-integrity'
import { createWorkspaceMemberAuditEntityIdFromKeyBytes } from '../audit'
import {
  RESTORE_DRILL_RESOURCE_TARGETS,
  RESTORE_DRILL_RTO_TARGET_SECONDS,
  RESTORE_DRILL_TABLE_TARGETS,
  calculateRestoreDrillDatasetDigest,
  calculateRestoreDrillObjectives,
  compareRestoreDrillDatasetAggregates,
  createRestoreDrillCleanupExecutionName,
  evaluateRestoreDrillCleanupApproval,
  parseRestoreDrillDatasetAggregate,
  RestoreDrillFailure,
  RestoreDrillKeyedMultisetDigestAccumulator,
  selectLatestCommonRestorePoint,
  type RestoreDrillCleanupApprovalReceipt,
  type RestoreDrillDatasetAggregate,
  type RestoreDrillFailureCode,
  type RestoreDrillKeyedMultisetDigestCheckpoint,
  type RestoreDrillMultisetDigest,
  type RestoreDrillResourceAggregate,
  type RestoreDrillResourceIdentity,
  type RestoreDrillResultEvidence,
  type RestoreDrillRunOutcome,
  type RestoreDrillRunPhase,
  type RestoreDrillTableTarget,
} from './restore-drill'
import {
  type RestoreDrillAwsActionResult,
  type RestoreDrillAwsConfiguration,
  type RestoreDrillAwsOperations,
  type RestoreDrillAwsPartition,
  RestoreDrillAwsFailure,
  RestoreDrillDynamoAggregateAccumulator,
  type RestoreDrillDynamoAggregateCheckpoint,
  type RestoreDrillCreatedScratchObjectVersion,
  type RestoreDrillCreatedScratchObjectVersions,
  type RestoreDrillDigestKeyEnvelope,
  type RestoreDrillExportDataFile,
  type RestoreDrillExportManifest,
  type RestoreDrillExportObjectVersionCursor,
  type RestoreDrillFileVersionProof,
  type RestoreDrillFileRangeCheckpoint,
  type RestoreDrillMultipartUploadCursor,
  type RestoreDrillRecordedMultipartUpload,
  type RestoreDrillRecordedExport,
  type RestoreDrillRecordedExportObjectVersion,
  type RestoreDrillRecordedRestoreTable,
  type RestoreDrillRecordedScratchObjectVersion,
  type RestoreDrillSourceFileVersion,
  type RestoreDrillSourceTableObservation,
  type RestoreDrillTableDescriptor,
  consumeRestoreDrillExportData,
  parseRestoreDrillExportFilesManifest,
  parseRestoreDrillExportSummary,
  resolveRestoreDrillAwsPartition,
  verifyRestoreDrillExportManifestChecksum,
  verifyRestoreDrillFileVersionProof,
} from './restore-drill-aws'
import {
  createRestoreDrillSemanticAuditCandidateClaims,
  createRestoreDrillSemanticAuditMemberAliasClaim,
  createRestoreDrillSemanticFailureClaim,
  createRestoreDrillSemanticItemClaims,
  createRestoreDrillSemanticToken,
  evaluateRestoreDrillSemanticRequirement,
  type RestoreDrillSemanticAuditCandidate,
  type RestoreDrillSemanticClaim,
  type RestoreDrillSemanticFallback,
  type RestoreDrillSemanticRequirement,
  type RestoreDrillSemanticRequirementBranch,
} from './restore-drill-semantic-claims'

/** Number of days after a successful verification at which the next drill becomes due. */
export const RESTORE_DRILL_DUE_DAYS = 89

/** Number of days without a successful verification that raises the cadence alarm. */
export const RESTORE_DRILL_OVERDUE_DAYS = 90

/** Fixed cleanup policy authenticated by every data-owner approval receipt. */
export const RESTORE_DRILL_CLEANUP_POLICY_VERSION = 'restore-drill-cleanup-v1'

/** Wait returned to Step Functions while long-running AWS operations remain pending. */
export const RESTORE_DRILL_POLL_WAIT_SECONDS = 60

const DAY_MILLISECONDS = 86_400_000
const COPY_CLAIM_GRACE_MILLISECONDS = 16 * 60 * 1_000
const CLEANUP_BATCH_SIZE = 25
const CLEANUP_LEDGER_TRANSACTION_ATTEMPTS = 5
const CLEANUP_SCOPE_SEAL_PAGE_SIZE = 100
const APPROVAL_RETENTION_DAYS = 400
const MAX_EXPORT_LISTING_OBJECTS_PER_TARGET = 10_000
const MAX_EXPORT_LISTING_PAGES_PER_TARGET = 10
const MAX_JSON_CHECKPOINT_QUERY_PAGES = 1_000
const MAX_VERIFICATION_MANIFEST_FILES_PER_TARGET = 256
const MAX_VERIFICATION_FILE_VERSIONS = 10_000
const MAX_VERIFICATION_RECORDS_PER_SOURCE_FILE = 100_000
const MAX_VERIFICATION_RECORDS_PER_TARGET = 1_000_000
const MAX_VERIFICATION_RESTORE_PAGES_PER_TARGET = 10_000
// A DynamoDB Scan response is at most 1 MiB and one item is at most 400 KiB. The
// smallest canonical pending File version occupies at least 95 DynamoDB item
// bytes, so one physical page can contain at most 11,037 versions. Each version
// expands to at most thirteen claims and the page can add only the four stable
// external File failures (143,485 claims total). The rounded bound retains that
// complete physical-page envelope without permitting unbounded claim fan-out.
const MAX_VERIFICATION_SEMANTIC_CLAIMS_PER_PAGE = 150_000
const MAX_VERIFICATION_SEMANTIC_PAGES = 10_000
const MAX_VERIFICATION_SEMANTIC_UNITS = 1_000_000
const MAX_VERIFICATION_STEPS_PER_INVOCATION = 50
const MAX_VERIFICATION_BATCH_MILLISECONDS = 480_000
const RESULT_EVIDENCE_PREFIX = 'evidence/v1/runs/'
const CLEANUP_RUN_READ_ATTRIBUTE_NAMES = [
  'approvalDigest',
  'approvalObjectKey',
  'approvedAt',
  'cleanupPolicyVersion',
  'cleanupAttemptCount',
  'cleanupExecutionArn',
  'cleanupExecutionName',
  'cleanupStartedAt',
  'cleanupEffectIndex',
  'deadlineAt',
  'digestKeyEnvelope',
  'drillId',
  'failureCodes',
  'kind',
  'outcome',
  'phase',
  'recordKey',
  'resourceDigest',
  'resultDigest',
  'resultEvidenceKey',
  'resultOutcome',
  'restorePoint',
  'revision',
  'runnerExecutionArn',
  'runVersion',
  'scopeKey',
  'startedAt',
  'updatedAt',
  'verificationCompletedAt',
]

/** Stable orchestration failures that never include tenant data or physical keys. */
export type RestoreDrillOrchestratorFailureCode =
  | 'APPROVAL_INVALID'
  | 'CLEANUP_TARGET_INVALID'
  | 'CONCURRENT_UPDATE'
  | 'CONFIGURATION_INVALID'
  | 'EVIDENCE_WRITE_FAILED'
  | 'REQUEST_INVALID'
  | 'RUN_NOT_FOUND'
  | 'RUN_STATE_INVALID'
  | 'STATE_READ_FAILED'
  | 'STATE_WRITE_FAILED'
  | 'VERIFICATION_FAILED'

/** Raw-value-free failure raised at the durable orchestration boundary. */
export class RestoreDrillOrchestratorFailure extends Error {
  /** Stable machine-readable failure category. */
  readonly code: RestoreDrillOrchestratorFailureCode

  /**
   * Creates a raw-value-free orchestration failure.
   *
   * @param code - Stable failure category.
   */
  constructor(code: RestoreDrillOrchestratorFailureCode) {
    super(code)
    this.name = 'RestoreDrillOrchestratorFailure'
    this.code = code
  }
}

/** Strict EventBridge scheduled-event subset admitted as the first advance request. */
export type RestoreDrillScheduledEvent = {
  /** AWS account that emitted the scheduled event. */
  readonly account: string
  /** Fixed EventBridge scheduled-event detail type. */
  readonly 'detail-type': 'Scheduled Event'
  /** Empty EventBridge schedule detail. */
  readonly detail: Readonly<Record<string, never>>
  /** Stable EventBridge event identifier. */
  readonly id: string
  /** AWS Region that emitted the event. */
  readonly region: string
  /** EventBridge rule ARN vector. */
  readonly resources: readonly string[]
  /** Fixed EventBridge source. */
  readonly source: 'aws.events'
  /** Canonical UTC event time. */
  readonly time: string
  /** EventBridge envelope version. */
  readonly version: '0'
}

/** Strict request accepted by the runner or cleanup Lambda handler. */
export type RestoreDrillHandlerRequest =
  | {
      /** Advances a new scheduled drill. */
      readonly action: 'advance'
      /** Untrusted EventBridge event validated before admission. */
      readonly event: RestoreDrillScheduledEvent
      /** Exact runner Standard execution identity. */
      readonly runnerExecutionArn: string
    }
  | {
      /** Advances one already admitted drill. */
      readonly action: 'advance'
      /** Stable drill identifier. */
      readonly drillId: string
      /** Exact runner Standard execution identity pinned at admission. */
      readonly runnerExecutionArn: string
    }
  | {
      /** Advances explicitly approved cleanup. */
      readonly action: 'cleanup'
      /** Immutable approval object key on the first cleanup invocation. */
      readonly approvalObjectKey?: string
      /** Exact Standard Step Functions execution ARN supplied on every cleanup task. */
      readonly cleanupExecutionArn: string
      /** Deterministic receipt-bound Standard Step Functions execution name. */
      readonly cleanupExecutionName: string
      /** Stable drill identifier. */
      readonly drillId: string
    }
  | {
      /** Seals a safe failure after a Step Functions task catch. */
      readonly action: 'finalize-failure'
      /** Stable drill identifier when the failed task had already admitted a run. */
      readonly drillId?: string
      /** Exact failed runner Standard execution identity. */
      readonly runnerExecutionArn: string
    }
  | {
      /** Seals the dedicated operational failure for an exhausted workflow poll budget. */
      readonly action: 'finalize-poll-budget-exceeded'
      /** Stable drill identifier when the workflow already admitted a run. */
      readonly drillId?: string
      /** Exact exhausted runner Standard execution identity. */
      readonly runnerExecutionArn: string
    }

/** Cadence and active-run lease stored in the singleton control item. */
export type RestoreDrillCadenceState = {
  /** Exact run that retains the no-overlap lease until approved cleanup completes. */
  readonly activeDrillId?: string
  /** Durable origin used until the first successful verification exists. */
  readonly cadenceOriginAt?: string
  /** Last time a passing result was immutably sealed. */
  readonly lastSuccessfulVerifiedAt?: string
  /** Optimistic control-item revision. */
  readonly revision: number
}

/** One replay-safe external effect fixed before terminal result publication. */
export type RestoreDrillTerminalEffect =
  | {
      /** Exact successful verification time recorded in cadence state. */
      readonly completedAt: string
      /** Successful-cadence effect discriminator. */
      readonly kind: 'record-successful-verification'
    }
  | {
      /** Metric effect discriminator. */
      readonly kind: 'metric'
      /** Fixed allowlisted CloudWatch metric name. */
      readonly metricName: RestoreDrillMetricName
      /** Fixed CloudWatch unit for this metric. */
      readonly unit: RestoreDrillMetricUnit
      /** Fixed non-negative aggregate metric value. */
      readonly value: number
    }

/** Immutable result/failure artifact and effects pinned before the Object-Lock write. */
export type RestoreDrillTerminalArtifactIntent = {
  /** Canonical JSON bytes that must be replayed exactly. */
  readonly artifactJson: string
  /** Exact immutable evidence key for these bytes. */
  readonly evidenceKey: string
  /** Terminal effects executed in fixed order after RUN publication. */
  readonly effects: readonly RestoreDrillTerminalEffect[]
  /** Stable terminal failure vector represented by the artifact. */
  readonly failureCodes: readonly RestoreDrillFailureCode[]
  /** Digest of the exact cleanup resource scope. */
  readonly resourceDigest: string
  /** Exact retention reference timestamp encoded in the artifact. */
  readonly retentionReferenceAt: string
  /** Digest of the exact immutable terminal artifact. */
  readonly resultDigest: string
  /** Terminal artifact outcome. */
  readonly resultOutcome: 'fail' | 'pass'
}

/** Minimal safe run item exposed to the data owner while preparing approval. */
export type RestoreDrillDurableRun = {
  /** SHA-256 of the exact immutable approval object selected at cleanup admission. */
  readonly approvalDigest?: string
  /** Immutable approval object key fixed for every cleanup resume. */
  readonly approvalObjectKey?: string
  /** Receipt approval time retained without approver identity or change text. */
  readonly approvedAt?: string
  /** Fixed cleanup policy bound into approval. */
  readonly cleanupPolicyVersion: typeof RESTORE_DRILL_CLEANUP_POLICY_VERSION
  /** Time at which valid approval first admitted cleanup. */
  readonly cleanupStartedAt?: string
  /** Next replay-safe cleanup completion effect; zero means the metric is not yet durable. */
  readonly cleanupEffectIndex?: number
  /** Number of explicitly approved execution attempts, starting at one. */
  readonly cleanupAttemptCount?: number
  /** Exact Standard Step Functions execution ARN pinned at approval admission. */
  readonly cleanupExecutionArn?: string
  /** Deterministic receipt-bound execution name pinned at approval admission. */
  readonly cleanupExecutionName?: string
  /** Four-hour objective deadline calculated at admission. */
  readonly deadlineAt: string
  /** Ciphertext-only per-run HMAC key envelope. */
  readonly digestKeyEnvelope?: RestoreDrillDigestKeyEnvelope
  /** Stable random drill identifier. */
  readonly drillId: string
  /** Stable secret-free result failure categories. */
  readonly failureCodes: readonly RestoreDrillFailureCode[]
  /** Current durable outcome; nonterminal approval phases remain in progress. */
  readonly outcome: RestoreDrillRunOutcome
  /** Current durable orchestration phase. */
  readonly phase: RestoreDrillRunPhase
  /** Digest of the exact isolated resources eligible for cleanup. */
  readonly resourceDigest?: string
  /** Optimistic run-item revision. */
  readonly revision: number
  /** Immutable result evidence object key. */
  readonly resultEvidenceKey?: string
  /** Pass or fail represented by the immutable terminal result. */
  readonly resultOutcome?: 'fail' | 'pass'
  /** Exact runner Standard execution ARN pinned at admission. */
  readonly runnerExecutionArn: string
  /** Digest of the exact immutable terminal result. */
  readonly resultDigest?: string
  /** Common exact point represented by every restored dataset. */
  readonly restorePoint?: string
  /** Admission time used as the RTO origin. */
  readonly startedAt: string
  /** Last successful state transition time. */
  readonly updatedAt: string
  /** Time at which result verification completed or failed. */
  readonly verificationCompletedAt?: string
  /** Exact result/failure artifact intent pinned before any immutable evidence write. */
  readonly terminalArtifactIntent?: RestoreDrillTerminalArtifactIntent
  /** Next terminal publication effect to execute after the artifact is durable. */
  readonly terminalEffectIndex?: number
}

/** Durable identities and observations too sensitive or large for the approval-facing run item. */
export type RestoreDrillResourceCheckpoint = {
  /** Completed canonical descriptor for each isolated table. */
  readonly restoredDescriptors: readonly RestoreDrillTableDescriptor[]
  /** Exact isolated table identities in canonical logical order. */
  readonly restores: readonly RestoreDrillRecordedRestoreTable[]
  /** Exact point-in-time export identities in canonical logical order. */
  readonly exports: readonly RestoreDrillRecordedExport[]
  /** Source PITR observations in canonical logical order. */
  readonly sources: readonly RestoreDrillSourceTableObservation[]
}

/** Durable baseline written before the first CopyObject attempt. */
export type RestoreDrillCopyIntent = {
  /** Exclusive bounded invocation claim held before CopyObject is attempted. */
  readonly copyClaim?: RestoreDrillCopyClaim
  /** Every created or adopted destination identity persisted before verification. */
  readonly createdCopies?: readonly RestoreDrillCreatedScratchObjectVersion[]
  /** Exact verified destination copy after response-loss reconciliation. */
  readonly completedCopy?: RestoreDrillRecordedScratchObjectVersion
  /** Stable digest identifying this copy without using the raw object key as a state key. */
  readonly intentDigest: string
  /** Exact VersionIds present in scratch before the first copy attempt. */
  readonly preexistingScratchVersionIds: readonly string[]
  /** Deterministically selected created identity that alone proceeds to verification. */
  readonly selectedCopy?: RestoreDrillCreatedScratchObjectVersion
  /** Strict source immutable-version reference. */
  readonly source: RestoreDrillSourceFileVersion
  /** Authenticated next range retained only while exact-version verification is incomplete. */
  readonly verificationCheckpoint?: RestoreDrillFileRangeCheckpoint
}

/** Durable exclusive claim preventing concurrent CopyObject creation for one intent. */
export type RestoreDrillCopyClaim = {
  /** Random invocation identity that alone may record the created VersionId. */
  readonly claimId: string
  /** Canonical acquisition time used for the post-Lambda takeover grace. */
  readonly claimedAt: string
}

/** Durable pre-API intent for one deterministic restore/export target pair. */
export type RestoreDrillStartIntent = {
  /** Whether the idempotent export API may already have been called. */
  readonly exportAttempted: boolean
  /** Exact recorded export after start/adoption reconciliation. */
  readonly exportRecord?: RestoreDrillRecordedExport
  /** Whether the deterministic restore API may already have been called. */
  readonly restoreAttempted: boolean
  /** Exact recorded table after start/adoption reconciliation. */
  readonly restoreRecord?: RestoreDrillRecordedRestoreTable
  /** Common exact restore/export point. */
  readonly restorePoint: string
  /** Exact measured source identity and descriptor. */
  readonly source: RestoreDrillSourceTableObservation
  /** Canonical logical table target. */
  readonly target: RestoreDrillTableTarget
}

/** Opaque File Proofing scan progress kept outside the approval-facing RUN item. */
export type RestoreDrillFileCursorCheckpoint = {
  /** Whether the isolated scan has reached its terminal page. */
  readonly complete: boolean
  /** Exact continuation key when another row remains. */
  readonly nextKey?: Readonly<Record<string, AttributeValue>>
  /** Whether at least one durable cursor checkpoint exists. */
  readonly started: boolean
}

/**
 * Rejects a nonterminal File scan cursor that does not advance.
 *
 * @param currentKey - Exact cursor used for the current scan.
 * @param nextKey - Exact cursor returned by the scan, absent at exhaustion.
 */
export function validateRestoreDrillFileCursorAdvance(
  currentKey: Readonly<Record<string, AttributeValue>> | undefined,
  nextKey: Readonly<Record<string, AttributeValue>> | undefined,
): void {
  if (nextKey !== undefined && stableJson(nextKey) === stableJson(currentKey)) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
}

/** Durable cursor for one exact export-prefix VersionId listing. */
export type RestoreDrillExportListingCheckpoint = {
  /** Whether the exact prefix has been enumerated to exhaustion. */
  readonly complete: boolean
  /** Opaque exact S3 continuation markers. */
  readonly cursor?: RestoreDrillExportObjectVersionCursor
  /** Total exact object versions captured for this export prefix. */
  readonly objectCount: number
  /** Total service pages durably committed for this export prefix. */
  readonly pageCount: number
  /** Whether at least one page checkpoint exists. */
  readonly started: boolean
}

/**
 * Calculates one bounded export-listing checkpoint and rejects stalled pagination.
 *
 * @param expected - Durable checkpoint used to request the service page.
 * @param pageObjectCount - Exact number of versions in the returned page.
 * @param nextCursor - Exact returned continuation, absent at exhaustion.
 * @returns Next bounded durable checkpoint.
 */
export function createRestoreDrillExportListingCheckpoint(
  expected: RestoreDrillExportListingCheckpoint,
  pageObjectCount: number,
  nextCursor?: RestoreDrillExportObjectVersionCursor,
): RestoreDrillExportListingCheckpoint {
  if (
    expected.complete ||
    !isNonNegativeInteger(expected.objectCount) ||
    !isNonNegativeInteger(expected.pageCount) ||
    !isNonNegativeInteger(pageObjectCount) ||
    pageObjectCount > 1_000 ||
    !Number.isSafeInteger(expected.pageCount + 1) ||
    !Number.isSafeInteger(expected.objectCount + pageObjectCount) ||
    (nextCursor !== undefined &&
      stableJson(nextCursor) === stableJson(expected.cursor))
  ) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  return {
    complete: nextCursor === undefined,
    ...(nextCursor ? { cursor: nextCursor } : {}),
    objectCount: expected.objectCount + pageObjectCount,
    pageCount: expected.pageCount + 1,
    started: true,
  }
}

/** Durable bounded cursor for the run-owned incomplete multipart-upload inventory. */
export type RestoreDrillMultipartUploadListingCheckpoint = {
  /** Whether the exact run prefix has been enumerated to exhaustion. */
  readonly complete: boolean
  /** Opaque exact S3 continuation markers. */
  readonly cursor?: RestoreDrillMultipartUploadCursor
  /** Total service pages durably committed. */
  readonly pageCount: number
  /** Whether at least one page checkpoint exists. */
  readonly started: boolean
  /** Total exact incomplete uploads captured below the run prefix. */
  readonly uploadCount: number
}

/** Durable exact completion metadata returned by DescribeExport. */
export type RestoreDrillExportCompletion = {
  /** Digest binding completion metadata to one recorded export ARN. */
  readonly exportArnDigest: string
  /** Exact exported item count returned by DescribeExport. */
  readonly itemCount: number
  /** Exact manifest-summary key returned by DescribeExport. */
  readonly manifestKey: string
  /** Canonical logical export target. */
  readonly target: RestoreDrillTableTarget
}

/** Durable result of exact aggregate and semantic verification. */
export type RestoreDrillVerificationResult = {
  /** Whether the isolated six-table semantic cross-domain verifier passed. */
  readonly crossDomainStatus: 'fail' | 'pass'
  /** Exact isolated physical identities in canonical resource order. */
  readonly resourceIdentities: readonly RestoreDrillResourceIdentity[]
  /** Complete isolated restore aggregate. */
  readonly restoreAggregate: RestoreDrillDatasetAggregate
  /** Complete source export aggregate. */
  readonly sourceAggregate: RestoreDrillDatasetAggregate
  /** Whether the Work Items schema and descriptor gate passed. */
  readonly workItemsSchemaStatus: 'fail' | 'pass'
}

/** Durable bounded verification phase advanced by at most one external page or file. */
export type RestoreDrillVerificationStage =
  | 'assembly'
  | 'file-data'
  | 'file-partition-count'
  | 'restore-data'
  | 'restore-partition-count'
  | 'semantic-audit'
  | 'semantic-claims'
  | 'semantic-requirements'
  | 'semantic-secret'
  | 'source-data'
  | 'source-manifest'
  | 'source-partition-count'

/** Source-export or isolated-restore partition namespace. */
export type RestoreDrillVerificationPartitionRole = 'file' | 'restore' | 'source'

/** Compact independently accumulated source and destination File proof state. */
export type RestoreDrillFileVerificationCheckpoint = {
  /** Destination content-proof multiset state. */
  readonly destinationContent: RestoreDrillKeyedMultisetDigestCheckpoint
  /** Destination portable metadata-and-tag multiset state. */
  readonly destinationMetadata: RestoreDrillKeyedMultisetDigestCheckpoint
  /** Exact File version multiplicity represented by every checkpoint. */
  readonly recordCount: number
  /** Source content-proof multiset state. */
  readonly sourceContent: RestoreDrillKeyedMultisetDigestCheckpoint
  /** Source portable metadata-and-tag multiset state. */
  readonly sourceMetadata: RestoreDrillKeyedMultisetDigestCheckpoint
}

/** Final independently reduced File proof evidence passed to the descriptor adapter. */
export type RestoreDrillFileVerificationEvidence = {
  /** Destination content proof aggregate. */
  readonly destinationContent: RestoreDrillMultisetDigest
  /** Destination portable metadata-and-tag aggregate. */
  readonly destinationMetadata: RestoreDrillMultisetDigest
  /** Exact unique object-key count reduced from opaque state tokens. */
  readonly logicalPartitionCount: number
  /** Exact File version multiplicity. */
  readonly recordCount: number
  /** Source content proof aggregate. */
  readonly sourceContent: RestoreDrillMultisetDigest
  /** Source portable metadata-and-tag aggregate. */
  readonly sourceMetadata: RestoreDrillMultisetDigest
}

/** Completed source and isolated File resource aggregates. */
export type RestoreDrillFileVerificationResources = {
  /** Isolated scratch File resource aggregate. */
  readonly restore: RestoreDrillResourceAggregate
  /** Source File resource aggregate. */
  readonly source: RestoreDrillResourceAggregate
}

/** Opaque state-table cursor for one bounded partition-count query. */
export type RestoreDrillVerificationPartitionCursor = {
  /** Exact last state record key returned by the preceding count page. */
  readonly recordKey: string
}

/** One bounded partition-count page without exposing logical partition values. */
export type RestoreDrillVerificationPartitionCountPage = {
  /** Number of unique keyed partition records in this page. */
  readonly count: number
  /** Opaque continuation absent after the terminal count page. */
  readonly nextCursor?: RestoreDrillVerificationPartitionCursor
}

/** Opaque cursor for one bounded semantic requirement-ledger query. */
export type RestoreDrillSemanticRequirementCursor = {
  /** Exact last opaque state record key returned by the preceding page. */
  readonly recordKey: string
}

/** One bounded page of opaque requirements ready for fact evaluation. */
export type RestoreDrillSemanticRequirementPage = {
  /** Deferred tenant-data-free requirements from this ledger page. */
  readonly requirements: readonly RestoreDrillSemanticRequirement[]
  /** Opaque continuation absent after the terminal page. */
  readonly nextCursor?: RestoreDrillSemanticRequirementCursor
}

/** One bounded normalized page converted to tenant-data-free semantic claims. */
export type RestoreDrillSemanticClaimPage = {
  /** Opaque facts, uniqueness guards, requirements, failures, and Audit candidates. */
  readonly claims: readonly RestoreDrillSemanticClaim[]
  /** Opaque normalized-reader cursor absent after the terminal page. */
  readonly nextCursor?: string
  /** Exact canonical units charged to the global six-table capacity. */
  readonly retainedUnitCount: number
}

/** HMAC-only durable winner for one logical Audit resource lifecycle. */
type RestoreDrillSemanticAuditLatest = {
  /** Per-byte HMAC tokens preserving exact UTF-8 comparison without retaining the value. */
  readonly orderTokens: readonly string[]
  /** Current resource requirement, absent when the latest event is explicitly historical. */
  readonly requirement?: RestoreDrillSemanticRequirement
}

/** Constant-size authenticated verification progress retained between Lambda invocations. */
export type RestoreDrillVerificationProgress = {
  /** Cumulative authenticated table aggregate for the active role and target. */
  readonly aggregateCheckpoint?: RestoreDrillDynamoAggregateCheckpoint
  /** Secret version pinned before any semantic table read. */
  readonly auditPseudonymSecretVersionId?: string
  /** Final semantic status set only after both requirement ledgers are exhausted. */
  readonly crossDomainStatus?: 'fail' | 'pass'
  /** Compact independently authenticated File proof aggregates. */
  readonly fileAggregateCheckpoint?: RestoreDrillFileVerificationCheckpoint
  /** Opaque cursor for the bounded CopyIntent inventory page. */
  readonly fileInventoryCursor?: string
  /** Completed isolated File resource retained after bounded proof reduction. */
  readonly restoreFileResource?: RestoreDrillResourceAggregate
  /** Number of authenticated manifest data-file entries for the active source target. */
  readonly manifestFileCount?: number
  /** Exact exported item count authenticated by summary and files manifests. */
  readonly manifestItemCount?: number
  /** Opaque strongly consistent restore Scan continuation. */
  readonly nextKey?: Readonly<Record<string, AttributeValue>>
  /** Number of bounded source files or restore pages completed for the active target. */
  readonly pageCount: number
  /** Cumulative exact unique partition count reduced from keyed state records. */
  readonly partitionCount: number
  /** Opaque continuation for the bounded partition-record count reduction. */
  readonly partitionCursor?: RestoreDrillVerificationPartitionCursor
  /** Completed isolated-restore table resources in canonical target order. */
  readonly restoreResources: readonly RestoreDrillResourceAggregate[]
  /** Monotonic compare-and-swap revision for the complete progress item. */
  readonly revision: number
  /** Cumulative exact canonical semantic units across all six isolated tables. */
  readonly semanticItemCount: number
  /** Opaque normalized-reader cursor for the active semantic table target. */
  readonly semanticNextCursor?: string
  /** Cumulative raw Scan pages across all six isolated semantic targets. */
  readonly semanticPageCount: number
  /** Opaque cursor for the active regular or Audit-latest requirement ledger. */
  readonly semanticRequirementCursor?: RestoreDrillSemanticRequirementCursor
  /** Completed source-export table resources in canonical target order. */
  readonly sourceResources: readonly RestoreDrillResourceAggregate[]
  /** Completed source File resource retained after bounded proof reduction. */
  readonly sourceFileResource?: RestoreDrillResourceAggregate
  /** Current bounded verification phase. */
  readonly stage: RestoreDrillVerificationStage
  /** Canonical table target index from zero through the terminal six. */
  readonly targetIndex: number
  /** Next manifest data-file index for the active source target. */
  readonly unitIndex: number
  /** Cumulative Work Items descriptor-gate result. */
  readonly workItemsSchemaStatus: 'fail' | 'pass'
}

/** Artifact written append-only to the compliance evidence bucket. */
export type RestoreDrillEvidenceArtifact =
  | {
      /** Stable reason when complete result evidence could not be constructed. */
      readonly failureCode: RestoreDrillFailureCode
      /** UTC time at which the safe fallback was sealed. */
      readonly failedAt: string
      /** Stable drill identifier. */
      readonly drillId: string
      /** Fixed fallback discriminator. */
      readonly kind: 'mukuroji-restore-drill-operational-failure'
      /** Last durable phase observed before failure. */
      readonly phase: RestoreDrillRunPhase
      /** Fallback contract version. */
      readonly failureVersion: 1
    }
  | {
      /** Exact terminal kernel result. */
      readonly result: RestoreDrillResultEvidence
      /** HMAC binding used by cleanup approval. */
      readonly resultDigest: string
      /** Semantic verifier statuses omitted from the narrower kernel result contract. */
      readonly semantic: {
        /** Cross-domain verifier result. */
        readonly crossDomainStatus: 'fail' | 'pass'
        /** Work Items schema gate result. */
        readonly workItemsSchemaStatus: 'fail' | 'pass'
      }
    }
  | {
      /** HMAC aggregate of every exact absence receipt. */
      readonly absenceReceiptDigest: string
      /** SHA-256 of the immutable approval body selected at cleanup admission. */
      readonly approvalDigest: string
      /** Number of explicitly approved execution attempts. */
      readonly approvalAttemptCount: number
      /** Immutable approval object key selected at cleanup admission. */
      readonly approvalObjectKey: string
      /** UTC time at which exact absence was reconciled. */
      readonly completedAt: string
      /** Exact number of deleted export object versions. */
      readonly deletedExportObjectCount: number
      /** Exact number of deleted File copy versions. */
      readonly deletedFileObjectCount: number
      /** Exact number of aborted incomplete multipart uploads. */
      readonly deletedMultipartUploadCount: number
      /** Exact number of deleted isolated tables. */
      readonly deletedTableCount: number
      /** Stable drill identifier. */
      readonly drillId: string
      /** Fixed cleanup evidence discriminator. */
      readonly kind: 'mukuroji-restore-drill-cleanup'
      /** UTC time at which approval first admitted cleanup. */
      readonly startedAt: string
      /** Exact expected export object-version count. */
      readonly expectedExportObjectCount: number
      /** Exact expected File-copy version count. */
      readonly expectedFileObjectCount: number
      /** Exact expected incomplete multipart-upload count. */
      readonly expectedMultipartUploadCount: number
      /** Exact expected isolated table count. */
      readonly expectedTableCount: number
      /** Digest of resources proven absent. */
      readonly resourceDigest: string
      /** Digest of the approved result. */
      readonly resultDigest: string
      /** Cleanup evidence contract version. */
      readonly cleanupVersion: 1
    }

/** Append-only evidence write result after response-loss reconciliation. */
export type RestoreDrillEvidenceWriteResult = {
  /** Base64 SHA-256 checksum sent to S3. */
  readonly checksumSha256: string
  /** Exact immutable evidence object key. */
  readonly objectKey: string
}

/** Exact resource cleanup progress persisted between bounded cleanup invocations. */
export type RestoreDrillCleanupProgress = {
  /** Number of exact absence receipts folded into the bounded digest chain. */
  readonly absenceReceiptCount: number
  /** Bounded rolling digest over every ordered keyed absence receipt. */
  readonly absenceReceiptDigest?: string
  /** Exact cleanup artifact bytes pinned before the immutable Object-Lock write. */
  readonly artifactIntent?: RestoreDrillCleanupArtifactIntent
  /** Durable completion time fixed before the immutable cleanup evidence write. */
  readonly completedAt?: string
  /** Number of completed exact export object deletions. */
  readonly exportObjectIndex: number
  /** Number of completed exact File-copy object deletions. */
  readonly fileObjectIndex: number
  /** Number of completed exact multipart-upload aborts. */
  readonly multipartUploadIndex: number
  /** Number of completed exact table deletions. */
  readonly tableIndex: number
  /** Opaque last processed cleanup-ledger key, absent before the first target. */
  readonly targetCursor?: string
}

/** Immutable cleanup artifact bytes pinned in cleanup-owned durable progress. */
export type RestoreDrillCleanupArtifactIntent = {
  /** Canonical JSON bytes replayed exactly after response loss or reapproval. */
  readonly artifactJson: string
  /** Exact immutable cleanup evidence key. */
  readonly evidenceKey: string
  /** Exact cleanup completion timestamp used for Object-Lock retention. */
  readonly retentionReferenceAt: string
}

/** One exact isolated target recorded in the append-only cleanup ledger. */
export type RestoreDrillCleanupTarget =
  | RestoreDrillCreatedScratchObjectVersion
  | RestoreDrillRecordedExportObjectVersion
  | RestoreDrillRecordedMultipartUpload
  | RestoreDrillRecordedRestoreTable

/** One ordered cleanup-ledger entry with an opaque, tenant-data-free cursor. */
export type RestoreDrillCleanupInventoryEntry = {
  /** Opaque state-table sort key used only to resume the ordered ledger query. */
  readonly cursor: string
  /** Strict exact isolated target owned by this drill. */
  readonly target: RestoreDrillCleanupTarget
}

/** One bounded ordered cleanup-ledger page. */
export type RestoreDrillCleanupInventoryPage = {
  /** At most the requested number of exact ordered targets. */
  readonly entries: readonly RestoreDrillCleanupInventoryEntry[]
  /** Cursor to persist when another ledger entry remains. */
  readonly nextCursor?: string
}

/** Constant-size cleanup-ledger generation used to close terminal-query races. */
export type RestoreDrillCleanupLedgerControl = {
  /** Exact number of immutable cleanup targets ever appended. */
  readonly count: number
  /** Monotonic revision incremented atomically with each first target put. */
  readonly revision: number
}

/** One ordered page of durable File CopyObject intents for late-commit reconciliation. */
export type RestoreDrillCopyIntentInventoryPage = {
  /** At most the requested number of strict intent records. */
  readonly entries: readonly {
    /** Opaque digest-only state-table cursor. */
    readonly cursor: string
    /** Strict durable CopyObject intent. */
    readonly intent: RestoreDrillCopyIntent
  }[]
  /** Cursor to persist when another intent remains. */
  readonly nextCursor?: string
}

/** Durable progress for one final exact post-baseline File-version reconciliation pass. */
export type RestoreDrillCopyReconciliationCheckpoint = {
  /** Whether every CopyObject intent was reconciled after runner work stopped. */
  readonly complete: boolean
  /** Number of exact created versions represented by all reconciled intents. */
  readonly createdCopyCount: number
  /** Authenticated chain for the currently advancing reconciliation pass. */
  readonly currentDigest?: string
  /** Opaque last reconciled COPY_INTENT record key. */
  readonly cursor?: string
  /** Number of reconciled durable CopyObject intents. */
  readonly intentCount: number
  /** First or second complete post-run listing pass. */
  readonly pass: 1 | 2
  /** First-pass authenticated inventory digest used to require a stable second pass. */
  readonly passDigest?: string
  /** End of the quiet window after the first complete listing pass. */
  readonly quietUntil?: string
  /** Final COPY_INTENT cursor bound into the completed cleanup scope. */
  readonly terminalCursor?: string
  /** Whether at least one reconciliation checkpoint was committed. */
  readonly started: boolean
}

/** Constant-size authenticated cleanup-scope sealing progress. */
export type RestoreDrillCleanupScopeCheckpoint = {
  /** Whether the exact cleanup ledger has been sealed for approval. */
  readonly complete: boolean
  /** Opaque last cleanup-ledger key included in the rolling digest. */
  readonly cursor?: string
  /** Number of exact export object versions included in the scope. */
  readonly exportObjectCount: number
  /** Number of exact File-copy versions included in the scope. */
  readonly fileObjectCount: number
  /** Number of exact incomplete multipart uploads included in the scope. */
  readonly multipartUploadCount: number
  /** Terminal immutable-ledger count atomically fenced by the seal commit. */
  readonly ledgerCount?: number
  /** Terminal immutable-ledger revision atomically fenced by the seal commit. */
  readonly ledgerRevision?: number
  /** HMAC chain over the static export records and every ordered cleanup target. */
  readonly rollingDigest?: string
  /** Final approval-facing scope digest, present only after exhaustion. */
  readonly resourceDigest?: string
  /** Whether at least one scope-seal checkpoint was committed. */
  readonly started: boolean
  /** Number of exact isolated restored tables included in the scope. */
  readonly tableCount: number
  /** Final cleanup-ledger cursor bound into the completed scope. */
  readonly terminalCursor?: string
}

/** Durable state operations required by the orchestration kernel. */
export interface RestoreDrillStateStore {
  /** Reads the singleton cadence control state consistently. */
  readCadence(): Promise<RestoreDrillCadenceState>

  /**
   * Conditionally admits one run and acquires the no-overlap lease.
   *
   * @param run - Initial safe run item.
   * @param expectedCadenceRevision - Revision read during due evaluation.
   * @returns Whether admission won the conditional transaction.
   */
  admitRun(run: RestoreDrillDurableRun, expectedCadenceRevision: number): Promise<boolean>

  /**
   * Reads one strict approval-facing run item.
   *
   * @param drillId - Stable drill identifier.
   * @returns Existing run or undefined.
   */
  readRun(drillId: string): Promise<RestoreDrillDurableRun | undefined>

  /**
   * Reads only the approval-facing RUN attributes available to cleanup.
   *
   * @param drillId - Stable drill identifier.
   * @returns Existing projected run or undefined.
   */
  readCleanupRun(drillId: string): Promise<RestoreDrillDurableRun | undefined>

  /**
   * Replaces one safe run item using optimistic revision control.
   *
   * @param run - Next complete run state.
   * @param expectedRevision - Revision that must still be current.
   * @returns Whether the compare-and-swap succeeded.
   */
  writeRun(run: RestoreDrillDurableRun, expectedRevision: number): Promise<boolean>

  /**
   * Updates only cleanup-owned RUN attributes using the complete prior state as a fence.
   *
   * @param run - Next complete run state after cleanup admission, rotation, or completion.
   * @param expected - Exact prior run state whose revision and execution binding must match.
   * @returns Whether the cleanup-only compare-and-swap succeeded.
   */
  writeCleanupRun(
    run: RestoreDrillDurableRun,
    expected: RestoreDrillDurableRun,
  ): Promise<boolean>

  /**
   * Writes resource observations and identities once, or verifies an identical retry.
   *
   * @param drillId - Stable drill identifier.
   * @param checkpoint - Exact resource checkpoint.
   */
  writeResourceCheckpoint(
    drillId: string,
    checkpoint: RestoreDrillResourceCheckpoint,
  ): Promise<void>

  /** Reads an existing exact resource checkpoint. */
  readResourceCheckpoint(drillId: string): Promise<RestoreDrillResourceCheckpoint | undefined>

  /** Reads one durable pre-API restore/export intent. */
  readStartIntent(
    drillId: string,
    target: RestoreDrillTableTarget,
  ): Promise<RestoreDrillStartIntent | undefined>

  /** Writes one immutable pre-API restore/export intent. */
  writeStartIntent(drillId: string, intent: RestoreDrillStartIntent): Promise<void>

  /** Durably marks one external start as potentially attempted before the API call. */
  markStartAttempted(
    drillId: string,
    target: RestoreDrillTableTarget,
    kind: 'export' | 'restore',
  ): Promise<void>

  /** Records one exact restored table after start/adoption reconciliation. */
  recordStartedRestore(
    drillId: string,
    target: RestoreDrillTableTarget,
    table: RestoreDrillRecordedRestoreTable,
  ): Promise<void>

  /** Records one exact export after start/adoption reconciliation. */
  recordStartedExport(
    drillId: string,
    target: RestoreDrillTableTarget,
    exportRecord: RestoreDrillRecordedExport,
  ): Promise<void>

  /** Lists all six durable pre-API start intents in canonical order. */
  listStartIntents(drillId: string): Promise<readonly RestoreDrillStartIntent[]>

  /** Reads opaque File scan progress from the latest committed checkpoint. */
  readFileCursor(drillId: string): Promise<RestoreDrillFileCursorCheckpoint>

  /**
   * Advances an auxiliary or empty File row without putting raw keys in the RUN item.
   *
   * @param drillId - Stable drill identifier.
   * @param runRevision - Current run revision.
   * @param nextKey - Exact next scan cursor, absent at completion.
   * @returns Whether the checkpoint CAS succeeded.
   */
  writeFileCursor(
    drillId: string,
    runRevision: number,
    nextKey?: Readonly<Record<string, AttributeValue>>,
  ): Promise<boolean>

  /** Reads one deterministic CopyObject intent. */
  readCopyIntent(drillId: string, intentDigest: string): Promise<RestoreDrillCopyIntent | undefined>

  /** Writes the pre-copy VersionId baseline before CopyObject is attempted. */
  writeCopyIntent(drillId: string, intent: RestoreDrillCopyIntent): Promise<void>

  /** Conditionally acquires or takes over one expired pre-copy claim. */
  claimCopyIntent(
    drillId: string,
    intentDigest: string,
    expectedClaim: RestoreDrillCopyClaim | undefined,
    nextClaim: RestoreDrillCopyClaim,
  ): Promise<boolean>

  /** Records the exact verified CopyObject result without replacing another result. */
  recordCreatedCopyIntent(
    drillId: string,
    intentDigest: string,
    claimId: string,
    copies: RestoreDrillCreatedScratchObjectVersions,
  ): Promise<void>

  /** Advances one authenticated File range checkpoint using compare-and-swap semantics. */
  writeCopyVerificationCheckpoint(
    drillId: string,
    intentDigest: string,
    expected: RestoreDrillFileRangeCheckpoint | undefined,
    next: RestoreDrillFileRangeCheckpoint,
  ): Promise<boolean>

  /** Records the exact verified CopyObject result without replacing another result. */
  completeCopyIntent(
    drillId: string,
    intentDigest: string,
    copy: RestoreDrillRecordedScratchObjectVersion,
  ): Promise<void>

  /** Lists every exact completed File copy eligible for cleanup. */
  listCompletedFileCopies(drillId: string): Promise<readonly RestoreDrillRecordedScratchObjectVersion[]>

  /** Lists every exact created File version eligible for cleanup, including failed verification. */
  listCreatedFileCopies(drillId: string): Promise<readonly RestoreDrillCreatedScratchObjectVersion[]>

  /** Lists every durable copy intent for bounded orphan reconciliation. */
  listCopyIntents(drillId: string): Promise<readonly RestoreDrillCopyIntent[]>

  /** Reads one bounded ordered page of CopyObject intents without a total-cardinality cap. */
  readCopyIntentInventoryPage(
    drillId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<RestoreDrillCopyIntentInventoryPage>

  /** Merges every exact post-baseline VersionId and ensures its cleanup-ledger entry. */
  reconcileCopyIntentVersions(
    drillId: string,
    intentDigest: string,
    discovered: readonly RestoreDrillCreatedScratchObjectVersion[],
  ): Promise<RestoreDrillCopyIntent>

  /** Reads durable final CopyObject reconciliation progress. */
  readCopyReconciliationCheckpoint(
    drillId: string,
  ): Promise<RestoreDrillCopyReconciliationCheckpoint>

  /** Advances final CopyObject reconciliation progress using compare-and-swap semantics. */
  writeCopyReconciliationCheckpoint(
    drillId: string,
    expected: RestoreDrillCopyReconciliationCheckpoint,
    next: RestoreDrillCopyReconciliationCheckpoint,
  ): Promise<boolean>

  /** Reads resumable listing progress for one logical table export. */
  readExportListingCheckpoint(
    drillId: string,
    target: RestoreDrillTableTarget,
  ): Promise<RestoreDrillExportListingCheckpoint>

  /**
   * Persists every exact version in one page before committing its next cursor.
   *
   * @param drillId - Stable drill identifier.
   * @param target - Canonical exported table target.
   * @param expected - Cursor used to fetch the page.
   * @param versions - At most 1,000 exact versions from that page.
   * @param nextCursor - Exact next cursor, absent on the terminal page.
   */
  writeExportListingPage(
    drillId: string,
    target: RestoreDrillTableTarget,
    expected: RestoreDrillExportListingCheckpoint,
    versions: readonly RestoreDrillRecordedExportObjectVersion[],
    nextCursor?: RestoreDrillExportObjectVersionCursor,
  ): Promise<void>

  /** Lists every exact export object version eligible for cleanup. */
  listExportObjectVersions(drillId: string): Promise<readonly RestoreDrillRecordedExportObjectVersion[]>

  /** Resolves exactly one captured export VersionId by export and object-key identity. */
  readVerificationExportObjectVersion(
    drillId: string,
    exportArnDigest: string,
    objectKey: string,
  ): Promise<RestoreDrillRecordedExportObjectVersion | undefined>

  /** Reads bounded run-prefix incomplete multipart-upload listing progress. */
  readMultipartUploadListingCheckpoint(
    drillId: string,
  ): Promise<RestoreDrillMultipartUploadListingCheckpoint>

  /** Persists one exact MPU page before committing its continuation. */
  writeMultipartUploadListingPage(
    drillId: string,
    expected: RestoreDrillMultipartUploadListingCheckpoint,
    uploads: readonly RestoreDrillRecordedMultipartUpload[],
    nextCursor?: RestoreDrillMultipartUploadCursor,
  ): Promise<void>

  /** Lists every exact incomplete MPU captured before approval. */
  listMultipartUploads(
    drillId: string,
  ): Promise<readonly RestoreDrillRecordedMultipartUpload[]>

  /** Writes or verifies exact completed DescribeExport metadata. */
  writeExportCompletion(
    drillId: string,
    completion: RestoreDrillExportCompletion,
  ): Promise<void>

  /** Lists every completed export metadata checkpoint in canonical order. */
  listExportCompletions(drillId: string): Promise<readonly RestoreDrillExportCompletion[]>

  /** Writes or verifies one exact verification checkpoint. */
  writeVerificationCheckpoint(
    drillId: string,
    result: RestoreDrillVerificationResult,
  ): Promise<void>

  /** Reads an existing exact verification checkpoint. */
  readVerificationCheckpoint(drillId: string): Promise<RestoreDrillVerificationResult | undefined>

  /** Reads constant-size resumable aggregate-verification progress. */
  readVerificationProgress(drillId: string): Promise<RestoreDrillVerificationProgress>

  /** Advances aggregate-verification progress using compare-and-swap semantics. */
  writeVerificationProgress(
    drillId: string,
    expected: RestoreDrillVerificationProgress,
    next: RestoreDrillVerificationProgress,
  ): Promise<boolean>

  /** Persists one bounded authenticated source manifest as individually addressed entries. */
  writeVerificationManifestFiles(
    drillId: string,
    target: RestoreDrillTableTarget,
    files: readonly RestoreDrillExportDataFile[],
  ): Promise<void>

  /** Reads one exact source manifest entry without rereading the complete manifest. */
  readVerificationManifestFile(
    drillId: string,
    target: RestoreDrillTableTarget,
    index: number,
  ): Promise<RestoreDrillExportDataFile | undefined>

  /** Writes opaque keyed logical-partition tokens with exact retry reconciliation. */
  writeVerificationPartitionDigests(
    drillId: string,
    role: RestoreDrillVerificationPartitionRole,
    target: RestoreDrillTableTarget,
    digests: readonly string[],
  ): Promise<void>

  /** Counts one bounded page of unique opaque logical-partition tokens. */
  readVerificationPartitionCountPage(
    drillId: string,
    role: RestoreDrillVerificationPartitionRole,
    target: RestoreDrillTableTarget,
    cursor?: RestoreDrillVerificationPartitionCursor,
  ): Promise<RestoreDrillVerificationPartitionCountPage>

  /** Writes one bounded opaque semantic claim page with retry-safe collision handling. */
  writeVerificationSemanticClaims(
    drillId: string,
    claims: readonly RestoreDrillSemanticClaim[],
    digestKey: Uint8Array,
  ): Promise<void>

  /** Reads one bounded regular or Audit-latest semantic requirement page. */
  readVerificationSemanticRequirementPage(
    drillId: string,
    source: 'audit' | 'requirement',
    cursor: RestoreDrillSemanticRequirementCursor | undefined,
    limit: number,
  ): Promise<RestoreDrillSemanticRequirementPage>

  /** Evaluates one bounded requirement page against strongly consistent opaque facts. */
  evaluateVerificationSemanticRequirements(
    drillId: string,
    requirements: readonly RestoreDrillSemanticRequirement[],
  ): Promise<void>

  /** Checks whether any immediate or deferred semantic failure was recorded. */
  hasVerificationSemanticFailures(drillId: string): Promise<boolean>

  /** Reads bounded exact cleanup progress. */
  readCleanupProgress(drillId: string): Promise<RestoreDrillCleanupProgress>

  /** Reads at most one bounded ordered page directly from the cleanup ledger. */
  readCleanupInventoryPage(
    drillId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<RestoreDrillCleanupInventoryPage>

  /** Reads the immutable cleanup-ledger generation consistently. */
  readCleanupLedgerControl(drillId: string): Promise<RestoreDrillCleanupLedgerControl>

  /** Reads constant-size authenticated cleanup-scope sealing progress. */
  readCleanupScopeCheckpoint(
    drillId: string,
  ): Promise<RestoreDrillCleanupScopeCheckpoint>

  /** Advances authenticated cleanup-scope sealing using compare-and-swap semantics. */
  writeCleanupScopeCheckpoint(
    drillId: string,
    expected: RestoreDrillCleanupScopeCheckpoint,
    next: RestoreDrillCleanupScopeCheckpoint,
  ): Promise<boolean>

  /** Writes bounded exact cleanup progress using compare-and-swap semantics. */
  writeCleanupProgress(
    drillId: string,
    expected: RestoreDrillCleanupProgress,
    next: RestoreDrillCleanupProgress,
  ): Promise<boolean>

  /** Records a passing verification time while retaining the active cleanup lease. */
  recordSuccessfulVerification(drillId: string, completedAt: string): Promise<void>

  /** Clears the exact active run only after all isolated resources are absent. */
  releaseActiveRun(drillId: string): Promise<void>

  /** Reads the current active drill for initial-task failure finalization. */
  readActiveDrillId(): Promise<string | undefined>
}

/** Exact bounded inputs consumed by one aggregate and semantic verification. */
export type RestoreDrillVerifierInput = {
  /** Exact resource checkpoint. */
  readonly checkpoint: RestoreDrillResourceCheckpoint
  /** In-memory 32-byte evidence key. */
  readonly digestKey: Uint8Array
  /** Stable drill identifier. */
  readonly drillId: string
  /** Exact completed DescribeExport metadata in canonical target order. */
  readonly exportCompletions: readonly RestoreDrillExportCompletion[]
  /** Common exact restore point. */
  readonly restorePoint: string
}

/** Exact-version lookup used while following authenticated export-manifest pointers. */
export type RestoreDrillExportVersionReader = (
  exportArnDigest: string,
  objectKey: string,
) => Promise<RestoreDrillRecordedExportObjectVersion | undefined>

/** Idempotent sink for one bounded group of opaque logical-partition tokens. */
export type RestoreDrillPartitionDigestSink = (
  digests: readonly string[],
) => Promise<void>

/** Factory isolating the generic semantic AWS reader from verifier orchestration. */
export interface RestoreDrillSemanticReaderFactory {
  /**
   * Creates one isolated normalized reader from an SDK-independent allowlist.
   *
   * @param configuration - Exact account, Region, resources, and page bound.
   * @returns SDK-independent normalized page reader.
   */
  create(
    configuration: CrossDomainIntegrityNormalizedPageReaderConfiguration,
  ): CrossDomainIntegrityNormalizedPageReader
}

/** Aggregate and semantic verification boundary. */
export interface RestoreDrillVerifier {
  /**
   * Resolves the immutable Audit pseudonym secret version before semantic scanning.
   *
   * @param input - Exact run resources and in-memory digest key.
   * @returns Exact Secrets Manager VersionId pinned for every later page.
   */
  resolveSemanticSecretVersion(input: RestoreDrillVerifierInput): Promise<string>

  /**
   * Reads one bounded isolated table page and immediately converts raw values to claims.
   *
   * @param input - Exact run resources and in-memory digest key.
   * @param target - Canonical isolated table target.
   * @param auditPseudonymSecretVersionId - Exact secret VersionId pinned before scanning.
   * @param remainingItemCapacity - Remaining global canonical semantic-unit capacity.
   * @param nextCursor - Opaque normalized-reader cursor for this target.
   * @returns Tenant-data-free claims, exact capacity charge, and continuation.
   */
  readSemanticClaimPage(
    input: RestoreDrillVerifierInput,
    target: RestoreDrillTableTarget,
    auditPseudonymSecretVersionId: string,
    remainingItemCapacity: number,
    nextCursor?: string,
  ): Promise<RestoreDrillSemanticClaimPage>

  /**
   * Authenticates and parses one bounded source export manifest exactly once.
   *
   * @param input - Exact run resources and in-memory digest key.
   * @param target - Canonical source table target.
   * @param readVersion - Exact captured VersionId lookup.
   * @returns Bounded data-file entries and authenticated total item count.
   */
  readSourceExportManifest(
    input: RestoreDrillVerifierInput,
    target: RestoreDrillTableTarget,
    readVersion: RestoreDrillExportVersionReader,
  ): Promise<RestoreDrillExportManifest>

  /**
   * Streams one exact source export data file into a compact authenticated unit.
   *
   * @param input - Exact run resources and in-memory digest key.
   * @param target - Canonical source table target.
   * @param dataFile - One authenticated manifest entry.
   * @param readVersion - Exact captured VersionId lookup.
   * @param partitionSink - Idempotent durable opaque-token sink.
   * @returns Compact aggregate checkpoint with no retained partition-token array.
   */
  aggregateSourceExportFile(
    input: RestoreDrillVerifierInput,
    target: RestoreDrillTableTarget,
    dataFile: RestoreDrillExportDataFile,
    readVersion: RestoreDrillExportVersionReader,
    partitionSink: RestoreDrillPartitionDigestSink,
  ): Promise<RestoreDrillDynamoAggregateCheckpoint>

  /**
   * Applies exact bucket descriptor gates to completed paged File proof evidence.
   *
   * @param input - Exact run resources and in-memory digest key.
   * @param evidence - Independently reduced source and destination proof aggregates.
   * @returns Completed source and isolated File resource aggregates.
   */
  finalizeFileVerification(
    input: RestoreDrillVerifierInput,
    evidence: RestoreDrillFileVerificationEvidence,
  ): Promise<RestoreDrillFileVerificationResources>

  /**
   * Assembles bounded completed resource aggregates after semantic verification.
   *
   * @param input - Exact run resources and in-memory digest key.
   * @param sourceFileResource - Completed source File resource.
   * @param restoreFileResource - Completed isolated File resource.
   * @param sourceResources - Six completed source table resources.
   * @param restoreResources - Six completed restore table resources.
   * @param workItemsSchemaStatus - Cumulative descriptor-gate result.
   * @param crossDomainStatus - Result of the completed incremental semantic evaluation.
   * @returns Complete final verification result.
   */
  assembleVerification(
    input: RestoreDrillVerifierInput,
    sourceFileResource: RestoreDrillResourceAggregate,
    restoreFileResource: RestoreDrillResourceAggregate,
    sourceResources: readonly RestoreDrillResourceAggregate[],
    restoreResources: readonly RestoreDrillResourceAggregate[],
    workItemsSchemaStatus: 'fail' | 'pass',
    crossDomainStatus: 'fail' | 'pass',
  ): Promise<RestoreDrillVerificationResult>
}

/** Append-only evidence storage boundary. */
export interface RestoreDrillEvidenceStore {
  /**
   * Writes immutable JSON with no-clobber and reconciles an ambiguous response by checksum.
   *
   * @param objectKey - Exact evidence/v1 key.
   * @param artifact - Secret-free bounded artifact.
   * @returns Exact key and base64 SHA-256 checksum.
   */
  putImmutable(
    objectKey: string,
    artifact: RestoreDrillEvidenceArtifact,
  ): Promise<RestoreDrillEvidenceWriteResult>

  /**
   * Writes previously pinned canonical JSON bytes without reconstructing the artifact.
   *
   * @param objectKey - Exact evidence/v1 key pinned before the first write.
   * @param artifactJson - Exact canonical JSON bytes pinned in durable state.
   * @param retentionReferenceAt - Exact artifact completion/failure timestamp.
   * @returns Exact key and base64 SHA-256 checksum.
   */
  putImmutablePinned(
    objectKey: string,
    artifactJson: string,
    retentionReferenceAt: string,
  ): Promise<RestoreDrillEvidenceWriteResult>
}

/** Exact immutable approval read result. */
export type RestoreDrillApprovalReadResult = {
  /** SHA-256 digest of the canonical exact receipt object bytes. */
  readonly approvalDigest: string
  /** Strict authenticated kernel receipt. */
  readonly receipt: RestoreDrillCleanupApprovalReceipt
}

/** Immutable Object-Lock approval reader available only to the cleanup role. */
export interface RestoreDrillApprovalStore {
  /**
   * Reads one exact approval object and verifies its key, checksum, KMS, and canonical body.
   *
   * @param objectKey - Exact approvals/v1 key supplied at cleanup admission.
   * @param drillId - Stable drill identifier that must be embedded in the key and receipt.
   * @returns Strict receipt and exact body digest.
   */
  readImmutable(objectKey: string, drillId: string): Promise<RestoreDrillApprovalReadResult>
}

/**
 * Checks that one approval copy is protected by COMPLIANCE retention for at least 400 days.
 *
 * @param approvedAt - Canonical receipt approval time.
 * @param mode - Untrusted S3 Object Lock mode.
 * @param retainUntil - Untrusted S3 retention deadline.
 * @returns Whether the observation independently satisfies the immutable receipt policy.
 */
export function isRestoreDrillApprovalRetentionSufficient(
  approvedAt: string,
  mode: unknown,
  retainUntil: unknown,
): boolean {
  return isRestoreDrillComplianceRetentionSufficient(
    approvedAt,
    mode,
    retainUntil,
  )
}

/** Checks one terminal artifact retention observation against the fixed policy. */
function isRestoreDrillComplianceRetentionSufficient(
  referenceAt: string,
  mode: unknown,
  retainUntil: unknown,
): boolean {
  const referenceAtMilliseconds = Date.parse(referenceAt)
  if (
    mode !== 'COMPLIANCE' ||
    !(retainUntil instanceof Date) ||
    !Number.isFinite(referenceAtMilliseconds) ||
    !Number.isFinite(retainUntil.getTime())
  ) return false
  return retainUntil.getTime() >=
    referenceAtMilliseconds + APPROVAL_RETENTION_DAYS * DAY_MILLISECONDS
}

/** Bounded Standard Step Functions execution statuses relevant to approval rotation. */
export type RestoreDrillCleanupExecutionStatus =
  | 'ABORTED'
  | 'FAILED'
  | 'PENDING_REDRIVE'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'TIMED_OUT'

/** Strict execution observation used to gate safe reapproval rotation. */
export type RestoreDrillCleanupExecutionObservation = {
  /** Number of same-ARN Step Functions redrives observed for this execution. */
  readonly redriveCount: number
  /** Canonical execution stop time, required for a terminal status. */
  readonly stopDate?: string
  /** Bounded Standard execution status. */
  readonly status: RestoreDrillCleanupExecutionStatus
}

/** Exact execution-status reader available only to the cleanup role. */
export interface RestoreDrillCleanupExecutionStore {
  /**
   * Reads one exact pinned Standard execution status.
   *
   * @param executionArn - Exact execution ARN previously pinned in RUN.
   * @returns Strict bounded execution status and terminal stop time.
   */
  readStatus(executionArn: string): Promise<RestoreDrillCleanupExecutionObservation>
}

/** CloudWatch metric boundary receiving only aggregate numbers. */
export interface RestoreDrillMetricSink {
  /** Emits one named metric with the fixed service dimension. */
  put(metricName: RestoreDrillMetricName, value: number, unit: RestoreDrillMetricUnit): Promise<void>
}

/** Fixed metric names consumed by the CDK alarms. */
export type RestoreDrillMetricName =
  | 'CadenceOverdueCount'
  | 'CleanupOverdueCount'
  | 'DrillFailureCount'
  | 'IntegrityFailureCount'
  | 'RpoSeconds'
  | 'RtoSeconds'

/** CloudWatch units used by restore-drill metrics. */
export type RestoreDrillMetricUnit = 'Count' | 'Seconds'

/** Injected dependencies for a deterministic durable orchestrator. */
export type CreateRestoreDrillOrchestratorInput = {
  /** Immutable Object-Lock cleanup approval reader. */
  readonly approvals: RestoreDrillApprovalStore
  /** Random invocation identity factory for exclusive pre-copy claims. */
  readonly claimId?: () => string
  /** Append-only compliance evidence port. */
  readonly evidence: RestoreDrillEvidenceStore
  /** Exact Step Functions execution-status reader for explicit reapproval rotation. */
  readonly executions: RestoreDrillCleanupExecutionStore
  /** Aggregate-only metric sink. */
  readonly metrics: RestoreDrillMetricSink
  /** Deterministic clock, defaulting to the current time. */
  readonly now?: () => Date
  /** Stable random identifier factory. */
  readonly randomId?: () => string
  /** Durable state and checkpoint store. */
  readonly state: RestoreDrillStateStore
  /** Exact aggregate and semantic verifier. */
  readonly verifier: RestoreDrillVerifier
}

/** Cleanup-only AWS primitive surface exposed to the approval-gated Lambda role. */
export type RestoreDrillCleanupOperations = Pick<
  RestoreDrillAwsOperations,
  | 'abortRecordedMultipartUpload'
  | 'deleteRecordedRestoreTable'
  | 'deleteRecordedExportObjectVersion'
  | 'deleteRecordedScratchObjectVersion'
  | 'listRecordedMultipartUploadPage'
  | 'withDigestKey'
>

/** Full handler-facing orchestration contract including task-catch finalization. */
export interface RestoreDrillOrchestrator {
  /** Advances a strict scheduled event or drill continuation. */
  advance(
    event: unknown,
    operations: RestoreDrillAwsOperations,
    runnerExecutionArn: string,
  ): Promise<RestoreDrillAwsActionResult>

  /** Advances explicit approval-gated exact cleanup. */
  cleanup(
    event: unknown,
    operations: RestoreDrillCleanupOperations,
  ): Promise<RestoreDrillAwsActionResult>

  /**
   * Safely seals an unexpected task failure when a run can be identified.
   *
   * @param drillId - Optional explicit run identifier.
   * @param operations - Isolated AWS operations used only when a digest envelope exists.
   * @param runnerExecutionArn - Exact failed runner execution identity.
   * @returns Stable failure result.
   */
  finalizeFailure(
    drillId: string | undefined,
    operations: RestoreDrillAwsOperations,
    runnerExecutionArn: string,
  ): Promise<RestoreDrillAwsActionResult>

  /**
   * Seals a non-integrity operational failure after the runner poll fuse is exhausted.
   *
   * @param drillId - Optional explicit run identifier.
   * @param operations - Isolated AWS operations used only for bounded finalization.
   * @param runnerExecutionArn - Exact exhausted runner execution identity.
   * @returns Stable failure result.
   */
  finalizePollBudgetExceeded(
    drillId: string | undefined,
    operations: RestoreDrillAwsOperations,
    runnerExecutionArn: string,
  ): Promise<RestoreDrillAwsActionResult>
}

/**
 * Creates the durable restore-drill orchestration kernel over explicit external ports.
 *
 * @param input - Durable state, verifier, evidence, cleanup, metric, clock, and ID ports.
 * @returns Handler-facing durable orchestrator.
 */
export function createRestoreDrillOrchestrator(
  input: CreateRestoreDrillOrchestratorInput,
): RestoreDrillOrchestrator {
  const now = input.now ?? (() => new Date())
  const randomId = input.randomId ?? randomUUID
  const claimId = input.claimId ?? randomUUID

  /** Advances one schedule or continuation request. */
  async function advance(
    event: unknown,
    operations: RestoreDrillAwsOperations,
    runnerExecutionArn: string,
  ): Promise<RestoreDrillAwsActionResult> {
    const validatedRunnerExecutionArn = requireRunnerExecutionArn(runnerExecutionArn)
    const request = parseAdvanceEvent(event)
    if (request.kind === 'schedule') {
      return advanceSchedule(
        input,
        operations,
        request.event,
        validatedRunnerExecutionArn,
        now,
        randomId,
      )
    }
    const run = await requireRun(input.state, request.drillId)
    if (run.runnerExecutionArn !== validatedRunnerExecutionArn) {
      return { drillId: run.drillId, status: 'failed' }
    }
    if (run.terminalArtifactIntent) {
      return publishTerminalArtifactIntent(input, run)
    }
    if (run.phase === 'awaiting-cleanup-approval') {
      if (run.resultOutcome === 'pass' && run.verificationCompletedAt) {
        await input.state.recordSuccessfulVerification(
          run.drillId,
          run.verificationCompletedAt,
        )
      }
      return awaitingApprovalResult(run)
    }
    if (run.phase === 'completed') {
      return { drillId: run.drillId, status: 'completed' }
    }
    if (run.phase === 'failed') {
      return { drillId: run.drillId, status: 'failed' }
    }
    const pendingFailure = run.failureCodes[0]
    if (pendingFailure) {
      return sealFailure(input, operations, run, pendingFailure, now)
    }
    if (Date.parse(canonicalNow(now)) >= Date.parse(run.deadlineAt)) {
      return sealFailure(input, operations, run, 'RTO_TARGET_MISSED', now)
    }
    try {
      switch (run.phase) {
        case 'scheduled':
          return await advanceScheduled(input, operations, run, now)
        case 'discovering-pitr-windows':
          return await advanceDiscovery(input, operations, run, now)
        case 'restoring-tables':
          return await advanceTableRestores(input, operations, run, now)
        case 'copying-file-versions':
          return await advanceFileCopies(input, operations, run, now, claimId)
        case 'verifying':
          return await advanceVerification(input, operations, run, now)
        case 'cleaning-up':
          return { drillId: run.drillId, status: 'failed' }
        default:
          return assertUnreachable(run.phase)
      }
    } catch (error: unknown) {
      if (isConditionalConflict(error)) {
        return pendingResult(run.drillId)
      }
      return sealFailure(
        input,
        operations,
        await requireRun(input.state, run.drillId),
        failureCodeForCaughtError(error),
        now,
      )
    }
  }

  /** Advances approval-gated cleanup for one exact run. */
  async function cleanup(
    event: unknown,
    operations: RestoreDrillCleanupOperations,
  ): Promise<RestoreDrillAwsActionResult> {
    const cleanupEvent = parseCleanupEvent(event)
    const drillId = cleanupEvent.drillId
    let run = await requireCleanupRun(input.state, drillId)
    if (run.phase === 'completed') {
      if (!cleanupExecutionMatches(run, cleanupEvent)) {
        return { drillId, status: 'failed' }
      }
      return await advanceCleanupCompletionEffects(input, run)
        ? { drillId, status: 'completed' }
        : pendingResult(drillId)
    }
    if (run.phase !== 'awaiting-cleanup-approval' && run.phase !== 'cleaning-up') {
      return { drillId, status: 'failed' }
    }
    try {
      if (run.phase === 'awaiting-cleanup-approval') {
        if (!cleanupEvent.approvalObjectKey) return { drillId, status: 'failed' }
        const approval = await input.approvals.readImmutable(
          cleanupEvent.approvalObjectKey,
          drillId,
        )
        const receipt = approval.receipt
        const expectedExecutionName = createRestoreDrillCleanupExecutionName(receipt)
        if (
          !run.digestKeyEnvelope ||
          !run.resourceDigest ||
          !run.resultDigest ||
          cleanupEvent.cleanupExecutionName !== expectedExecutionName ||
          !cleanupExecutionArnHasName(
            cleanupEvent.cleanupExecutionArn,
            expectedExecutionName,
          ) ||
          receipt.policyVersion !== RESTORE_DRILL_CLEANUP_POLICY_VERSION
        ) {
          return { drillId, status: 'failed' }
        }
        const currentExecution = await input.executions.readStatus(
          cleanupEvent.cleanupExecutionArn,
        )
        if (
          currentExecution.status !== 'RUNNING' ||
          currentExecution.redriveCount !== 0
        ) {
          return { drillId, status: 'failed' }
        }
        const decision = await operations.withDigestKey(
          drillId,
          run.digestKeyEnvelope,
          async (digestKey) => evaluateRestoreDrillCleanupApproval({
            digestKey,
            now: canonicalNow(now),
            receipt,
            expected: {
              // The S3 adapter independently constrains this STS session to the trusted role.
              authorizedApprovers: [receipt.approver],
              // The trusted data owner selects and authenticates this exact opaque change record.
              changeLocator: receipt.changeLocator,
              drillId,
              policyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
              resourceDigest: run.resourceDigest ?? '',
              resultDigest: run.resultDigest ?? '',
            },
          }),
        )
        if (!decision.eligible) return { drillId, status: 'failed' }
        const cleanupStartedAt = canonicalNow(now)
        const next = transitionRun(
          {
            ...run,
            approvalDigest: approval.approvalDigest,
            approvalObjectKey: cleanupEvent.approvalObjectKey,
            approvedAt: receipt.approvedAt,
            cleanupAttemptCount: 1,
            cleanupExecutionArn: cleanupEvent.cleanupExecutionArn,
            cleanupExecutionName: cleanupEvent.cleanupExecutionName,
            cleanupStartedAt,
          },
          'cleaning-up',
          'in-progress',
          cleanupStartedAt,
        )
        if (!(await input.state.writeCleanupRun(next, run))) return pendingResult(drillId)
        run = next
      } else if (!cleanupExecutionMatches(run, cleanupEvent)) {
        if (
          !cleanupEvent.approvalObjectKey ||
          !run.cleanupExecutionArn ||
          !run.digestKeyEnvelope ||
          !run.resourceDigest ||
          !run.resultDigest
        ) return { drillId, status: 'failed' }
        const priorExecution = await input.executions.readStatus(run.cleanupExecutionArn)
        if (
          (priorExecution.status !== 'ABORTED' &&
            priorExecution.status !== 'FAILED' &&
            priorExecution.status !== 'TIMED_OUT') ||
          !priorExecution.stopDate ||
          Date.parse(canonicalNow(now)) <
            Date.parse(priorExecution.stopDate) + 16 * 60 * 1_000
        ) return { drillId, status: 'failed' }
        const approval = await input.approvals.readImmutable(
          cleanupEvent.approvalObjectKey,
          drillId,
        )
        const receipt = approval.receipt
        const expectedExecutionName = createRestoreDrillCleanupExecutionName(receipt)
        if (
          cleanupEvent.cleanupExecutionName !== expectedExecutionName ||
          !cleanupExecutionArnHasName(cleanupEvent.cleanupExecutionArn, expectedExecutionName) ||
          Date.parse(receipt.approvedAt) <
            Date.parse(priorExecution.stopDate) + 16 * 60 * 1_000 ||
          (run.approvedAt !== undefined &&
            Date.parse(receipt.approvedAt) <= Date.parse(run.approvedAt))
        ) return { drillId, status: 'failed' }
        const decision = await operations.withDigestKey(
          drillId,
          run.digestKeyEnvelope,
          async (digestKey) => evaluateRestoreDrillCleanupApproval({
            digestKey,
            now: canonicalNow(now),
            receipt,
            expected: {
              // The S3 adapter independently constrains this STS session to the trusted role.
              authorizedApprovers: [receipt.approver],
              // The trusted data owner selects and authenticates this exact opaque change record.
              changeLocator: receipt.changeLocator,
              drillId,
              policyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
              resourceDigest: run.resourceDigest ?? '',
              resultDigest: run.resultDigest ?? '',
            },
          }),
        )
        if (!decision.eligible) return { drillId, status: 'failed' }
        const updatedAt = canonicalNow(now)
        const next = incrementRun({
          ...run,
          approvalDigest: approval.approvalDigest,
          approvalObjectKey: cleanupEvent.approvalObjectKey,
          approvedAt: receipt.approvedAt,
          cleanupAttemptCount: (run.cleanupAttemptCount ?? 0) + 1,
          cleanupExecutionArn: cleanupEvent.cleanupExecutionArn,
          cleanupExecutionName: cleanupEvent.cleanupExecutionName,
          updatedAt,
        })
        const currentExecution = await input.executions.readStatus(
          cleanupEvent.cleanupExecutionArn,
        )
        if (
          currentExecution.status !== 'RUNNING' ||
          currentExecution.redriveCount !== 0
        ) {
          return { drillId, status: 'failed' }
        }
        if (!(await input.state.writeCleanupRun(next, run))) return pendingResult(drillId)
        run = next
      } else if (
        cleanupEvent.approvalObjectKey !== undefined &&
        cleanupEvent.approvalObjectKey !== run.approvalObjectKey
      ) {
        return { drillId, status: 'failed' }
      }

      if (!run.digestKeyEnvelope || !run.resourceDigest) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      const scope = await input.state.readCleanupScopeCheckpoint(drillId)
      const ledger = await input.state.readCleanupLedgerControl(drillId)
      if (
        !scope.complete || !scope.resourceDigest ||
        scope.resourceDigest !== run.resourceDigest ||
        scope.ledgerCount !== ledger.count ||
        scope.ledgerRevision !== ledger.revision ||
        scope.ledgerCount !== scope.tableCount + scope.fileObjectCount +
          scope.exportObjectCount + scope.multipartUploadCount ||
        (scope.ledgerCount === 0) !== (scope.terminalCursor === undefined)
      ) {
        throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
      }
      let progress = await input.state.readCleanupProgress(drillId)
      const page = await input.state.readCleanupInventoryPage(
        drillId,
        progress.targetCursor,
        CLEANUP_BATCH_SIZE,
      )
      for (const entry of page.entries) {
        await requireCurrentCleanupExecution(
          input.state,
          input.executions,
          run,
          cleanupEvent,
        )
        validateCleanupTargetBinding(run, undefined, entry.target)
        const deletionPending = await deleteCleanupTarget(
          operations,
          entry.target,
          drillId,
        )
        if (deletionPending) return pendingResult(drillId)
        const absenceDigest = await calculateCleanupAbsenceReceiptDigest(
          operations,
          run,
          cleanupReceiptTargetKind(entry.target),
          progress.absenceReceiptCount,
          entry.target,
        )
        const next = incrementCleanupProgress(progress, entry, absenceDigest)
        await writeCleanupProgressOrThrow(input.state, drillId, progress, next)
        progress = next
      }
      if (page.nextCursor) {
        if (page.nextCursor !== progress.targetCursor) {
          throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
        }
        return pendingResult(drillId, 0)
      }
      const expectedTargetCount = scope.tableCount + scope.fileObjectCount +
        scope.exportObjectCount + scope.multipartUploadCount
      if (
        !run.approvalDigest ||
        !run.approvalObjectKey ||
        !run.approvedAt ||
        !run.cleanupAttemptCount ||
        !run.cleanupStartedAt ||
        !run.resourceDigest ||
        !run.resultDigest ||
        !run.resultOutcome ||
        progress.absenceReceiptCount !== expectedTargetCount ||
        progress.tableIndex !== scope.tableCount ||
        progress.fileObjectIndex !== scope.fileObjectCount ||
        progress.exportObjectIndex !== scope.exportObjectCount ||
        progress.multipartUploadIndex !== scope.multipartUploadCount ||
        progress.targetCursor !== scope.terminalCursor ||
        (progress.absenceReceiptCount > 0 && !progress.absenceReceiptDigest)
      ) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      await requireCurrentCleanupExecution(
        input.state,
        input.executions,
        run,
        cleanupEvent,
      )
      const uploadPrefix =
        `restore-drill/${sha256Hex(`drill\0${drillId}`).slice(0, 16)}/`
      const remainingUploads = await operations.listRecordedMultipartUploadPage(uploadPrefix)
      if (remainingUploads.uploads.length > 0 || remainingUploads.nextCursor) {
        throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
      }
      if (!progress.artifactIntent) {
        await requireCurrentCleanupExecution(
          input.state,
          input.executions,
          run,
          cleanupEvent,
        )
        const observedAt = canonicalNow(now)
        const completedAt = progress.completedAt !== undefined &&
            Date.parse(run.approvedAt) <= Date.parse(progress.completedAt)
          ? progress.completedAt
          : observedAt
        if (Date.parse(completedAt) < Date.parse(run.approvedAt)) {
          throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
        }
        const absenceReceiptDigest = await operations.withDigestKey(
          drillId,
          run.digestKeyEnvelope,
          async (digestKey) => createHmac('sha256', digestKey)
            .update('mukuroji-restore-drill-cleanup-absence-chain-seal-v1\0', 'utf8')
            .update(stableJson({
              count: progress.absenceReceiptCount,
              digest: progress.absenceReceiptDigest ?? null,
              ledgerCount: scope.ledgerCount,
              ledgerRevision: scope.ledgerRevision,
              resourceDigest: scope.resourceDigest,
              terminalCursor: scope.terminalCursor ?? null,
            }), 'utf8')
            .digest('hex'),
        )
        const artifact = {
          absenceReceiptDigest,
          approvalAttemptCount: run.cleanupAttemptCount,
          approvalDigest: run.approvalDigest,
          approvalObjectKey: run.approvalObjectKey,
          cleanupVersion: 1,
          completedAt,
          deletedExportObjectCount: progress.exportObjectIndex,
          deletedFileObjectCount: progress.fileObjectIndex,
          deletedMultipartUploadCount: progress.multipartUploadIndex,
          deletedTableCount: progress.tableIndex,
          drillId,
          expectedExportObjectCount: scope.exportObjectCount,
          expectedFileObjectCount: scope.fileObjectCount,
          expectedMultipartUploadCount: scope.multipartUploadCount,
          expectedTableCount: scope.tableCount,
          kind: 'mukuroji-restore-drill-cleanup',
          resourceDigest: run.resourceDigest,
          resultDigest: run.resultDigest,
          startedAt: run.cleanupStartedAt,
        } satisfies RestoreDrillEvidenceArtifact
        const next = {
          ...progress,
          artifactIntent: {
            artifactJson: stableJson(artifact),
            evidenceKey: cleanupEvidenceKey(drillId),
            retentionReferenceAt: completedAt,
          },
          completedAt,
        }
        await writeCleanupProgressOrThrow(input.state, drillId, progress, next)
        return pendingResult(drillId, 0)
      }
      const artifactIntent = progress.artifactIntent
      if (!artifactIntent) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      const completedAt = progress.completedAt
      if (!completedAt) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      validateCleanupArtifactBinding(artifactIntent, run, progress, scope)
      await requireCurrentCleanupExecution(
        input.state,
        input.executions,
        run,
        cleanupEvent,
      )
      await input.evidence.putImmutablePinned(
        artifactIntent.evidenceKey,
        artifactIntent.artifactJson,
        artifactIntent.retentionReferenceAt,
      )
      const completedRunAt = latestCanonicalTimestamp([
        canonicalNow(now),
        run.updatedAt,
        run.approvedAt,
        completedAt,
      ])
      const completed = transitionRun(
        { ...run, cleanupEffectIndex: 0 },
        'completed',
        run.resultOutcome,
        completedRunAt,
      )
      if (!(await input.state.writeCleanupRun(completed, run))) {
        return pendingResult(drillId, 0)
      }
      return await advanceCleanupCompletionEffects(input, completed)
        ? { drillId, status: 'completed' }
        : pendingResult(drillId)
    } catch (error: unknown) {
      if (
        run.phase === 'cleaning-up' &&
        !(error instanceof RestoreDrillOrchestratorFailure && (
          error.code === 'APPROVAL_INVALID' ||
          error.code === 'CLEANUP_TARGET_INVALID' ||
          error.code === 'REQUEST_INVALID' ||
          error.code === 'RUN_STATE_INVALID'
        ))
      ) return pendingResult(drillId)
      return { drillId, status: 'failed' }
    }
  }

  /** Safely finalizes one task-catch failure. */
  async function finalizeFailure(
    drillId: string | undefined,
    operations: RestoreDrillAwsOperations,
    runnerExecutionArn: string,
  ): Promise<RestoreDrillAwsActionResult> {
    return finalizeFailureWithCode(
      drillId,
      operations,
      runnerExecutionArn,
      'WORKFLOW_TASK_FAILED',
    )
  }

  /** Safely finalizes an exhausted runner workflow with its exact operational code. */
  async function finalizePollBudgetExceeded(
    drillId: string | undefined,
    operations: RestoreDrillAwsOperations,
    runnerExecutionArn: string,
  ): Promise<RestoreDrillAwsActionResult> {
    return finalizeFailureWithCode(
      drillId,
      operations,
      runnerExecutionArn,
      'WORKFLOW_POLL_BUDGET_EXCEEDED',
    )
  }

  /** Replays immediately durable finalization steps without crossing an external wait. */
  async function finalizeFailureWithCode(
    drillId: string | undefined,
    operations: RestoreDrillAwsOperations,
    runnerExecutionArn: string,
    fixedFailureCode?: RestoreDrillFailureCode,
  ): Promise<RestoreDrillAwsActionResult> {
    const validatedRunnerExecutionArn = requireRunnerExecutionArn(runnerExecutionArn)
    const resolvedDrillId = drillId ?? await input.state.readActiveDrillId()
    if (!resolvedDrillId) return { drillId: 'unidentified', status: 'failed' }
    const batchDeadline = Date.now() + MAX_VERIFICATION_BATCH_MILLISECONDS
    let result: RestoreDrillAwsActionResult = pendingResult(resolvedDrillId, 0)
    for (
      let step = 0;
      step < MAX_VERIFICATION_STEPS_PER_INVOCATION;
      step += 1
    ) {
      const run = await requireRun(input.state, resolvedDrillId)
      if (run.runnerExecutionArn !== validatedRunnerExecutionArn) {
        return { drillId: resolvedDrillId, status: 'failed' }
      }
      if (run.phase === 'awaiting-cleanup-approval') return awaitingApprovalResult(run)
      if (run.phase === 'completed') return { drillId: resolvedDrillId, status: 'completed' }
      if (run.phase === 'failed') return { drillId: resolvedDrillId, status: 'failed' }
      try {
        result = await sealFailure(
          input,
          operations,
          run,
          fixedFailureCode ?? 'WORKFLOW_TASK_FAILED',
          now,
        )
      } catch (error: unknown) {
        return isConditionalConflict(error)
          ? pendingResult(resolvedDrillId)
          : { drillId: resolvedDrillId, status: 'failed' }
      }
      if (
        result.status !== 'pending' ||
        result.waitSeconds !== 0 ||
        Date.now() >= batchDeadline
      ) return result
    }
    return result
  }

  return { advance, cleanup, finalizeFailure, finalizePollBudgetExceeded }
}

/** Parsed advance input used internally after strict structural validation. */
type ParsedAdvanceEvent =
  | {
      /** Schedule input discriminator. */
      readonly kind: 'schedule'
      /** Strict EventBridge event. */
      readonly event: RestoreDrillScheduledEvent
    }
  | {
      /** Continuation input discriminator. */
      readonly kind: 'continuation'
      /** Stable drill identifier. */
      readonly drillId: string
    }

/**
 * Strictly parses the complete outer restore-drill handler request.
 *
 * @param value - Untrusted Lambda payload.
 * @returns Strict discriminated request.
 */
export function parseRestoreDrillHandlerRequest(value: unknown): RestoreDrillHandlerRequest {
  const record = requireRecord(value, 'REQUEST_INVALID')
  if (record.action === 'advance') {
    if (Object.keys(record).length === 3 && 'event' in record) {
      return {
        action: 'advance',
        event: parseScheduledEvent(record.event),
        runnerExecutionArn: requireRunnerExecutionArn(record.runnerExecutionArn),
      }
    }
    if (Object.keys(record).length === 3 && 'drillId' in record) {
      return {
        action: 'advance',
        drillId: requireDrillId(record.drillId),
        runnerExecutionArn: requireRunnerExecutionArn(record.runnerExecutionArn),
      }
    }
  }
  if (
    record.action === 'cleanup' &&
    'drillId' in record
  ) {
    if (Object.keys(record).length === 4) {
      const parsed = parseCleanupEvent({
        cleanupExecutionArn: record.cleanupExecutionArn,
        cleanupExecutionName: record.cleanupExecutionName,
        drillId: record.drillId,
      })
      return {
        action: 'cleanup',
        cleanupExecutionArn: parsed.cleanupExecutionArn,
        cleanupExecutionName: parsed.cleanupExecutionName,
        drillId: parsed.drillId,
      }
    }
    if (Object.keys(record).length === 5 && 'approvalObjectKey' in record) {
      const parsed = parseCleanupEvent({
        approvalObjectKey: record.approvalObjectKey,
        cleanupExecutionArn: record.cleanupExecutionArn,
        cleanupExecutionName: record.cleanupExecutionName,
        drillId: record.drillId,
      })
      return {
        action: 'cleanup',
        approvalObjectKey: parsed.approvalObjectKey,
        cleanupExecutionArn: parsed.cleanupExecutionArn,
        cleanupExecutionName: parsed.cleanupExecutionName,
        drillId: parsed.drillId,
      }
    }
  }
  if (record.action === 'finalize-failure') {
    if (Object.keys(record).length === 2) {
      return {
        action: 'finalize-failure',
        runnerExecutionArn: requireRunnerExecutionArn(record.runnerExecutionArn),
      }
    }
    if (Object.keys(record).length === 3 && 'drillId' in record) {
      return {
        action: 'finalize-failure',
        drillId: requireDrillId(record.drillId),
        runnerExecutionArn: requireRunnerExecutionArn(record.runnerExecutionArn),
      }
    }
  }
  if (record.action === 'finalize-poll-budget-exceeded') {
    if (Object.keys(record).length === 2) {
      return {
        action: 'finalize-poll-budget-exceeded',
        runnerExecutionArn: requireRunnerExecutionArn(record.runnerExecutionArn),
      }
    }
    if (Object.keys(record).length === 3 && 'drillId' in record) {
      return {
        action: 'finalize-poll-budget-exceeded',
        drillId: requireDrillId(record.drillId),
        runnerExecutionArn: requireRunnerExecutionArn(record.runnerExecutionArn),
      }
    }
  }
  throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
}

/** Advances one strict daily cadence check. */
async function advanceSchedule(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  event: RestoreDrillScheduledEvent,
  runnerExecutionArn: string,
  now: () => Date,
  randomId: () => string,
): Promise<RestoreDrillAwsActionResult> {
  void event
  const cadence = await input.state.readCadence()
  const current = canonicalNow(now)
  const cadenceBase = cadence.lastSuccessfulVerifiedAt ?? cadence.cadenceOriginAt
  if (cadenceBase) {
    const age = Date.parse(current) - Date.parse(cadenceBase)
    if (age >= RESTORE_DRILL_OVERDUE_DAYS * DAY_MILLISECONDS) {
      await input.metrics.put('CadenceOverdueCount', 1, 'Count')
    }
  }
  if (cadence.activeDrillId) {
    const active = await input.state.readRun(cadence.activeDrillId)
    if (active?.phase === 'completed') {
      await advanceCleanupCompletionEffects(input, active)
      return { drillId: active.drillId, status: 'not-due' }
    }
    if (
      active !== undefined &&
      Date.parse(current) >= Date.parse(active.deadlineAt)
    ) {
      await input.metrics.put('CleanupOverdueCount', 1, 'Count')
      if (
        active.phase !== 'awaiting-cleanup-approval' &&
        active.phase !== 'cleaning-up'
      ) {
        let owned = active
        if (active.runnerExecutionArn !== runnerExecutionArn) {
          const takeover = incrementRun({
            ...active,
            runnerExecutionArn,
            updatedAt: current,
          })
          if (!(await input.state.writeRun(takeover, active.revision))) {
            return { drillId: active.drillId, status: 'not-due' }
          }
          owned = takeover
        }
        return sealFailure(
          input,
          operations,
          owned,
          'RTO_TARGET_MISSED',
          now,
        )
      }
    }
    return { drillId: cadence.activeDrillId, status: 'not-due' }
  }
  if (
    cadenceBase &&
    Date.parse(current) - Date.parse(cadenceBase) <
      RESTORE_DRILL_DUE_DAYS * DAY_MILLISECONDS
  ) {
    return { drillId: 'cadence-not-due', status: 'not-due' }
  }
  const drillId = requireDrillId(randomId())
  const run: RestoreDrillDurableRun = {
    cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
    deadlineAt: new Date(Date.parse(current) + RESTORE_DRILL_RTO_TARGET_SECONDS * 1_000)
      .toISOString(),
    drillId,
    failureCodes: [],
    outcome: 'in-progress',
    phase: 'scheduled',
    revision: 1,
    runnerExecutionArn,
    startedAt: current,
    updatedAt: current,
  }
  if (!(await input.state.admitRun(run, cadence.revision))) {
    return { drillId, status: 'not-due' }
  }
  return pendingResult(drillId, 0)
}

/** Replays cleanup completion metrics and lease release from a completed RUN. */
async function advanceCleanupCompletionEffects(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
): Promise<boolean> {
  if (run.phase !== 'completed') {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  let current = run
  if ((current.cleanupEffectIndex ?? 0) < 1) {
    try {
      await input.metrics.put('CleanupOverdueCount', 0, 'Count')
    } catch {
      return false
    }
    const metricRecorded = incrementRun({ ...current, cleanupEffectIndex: 1 })
    if (!(await input.state.writeCleanupRun(metricRecorded, current))) return false
    current = metricRecorded
  }
  if ((current.cleanupEffectIndex ?? 0) < 2) {
    try {
      await input.state.releaseActiveRun(current.drillId)
    } catch {
      return false
    }
    const leaseReleased = incrementRun({ ...current, cleanupEffectIndex: 2 })
    if (!(await input.state.writeCleanupRun(leaseReleased, current))) return false
  }
  return true
}

/** Creates the envelope before any source or isolated identity becomes durable. */
async function advanceScheduled(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  now: () => Date,
): Promise<RestoreDrillAwsActionResult> {
  const envelope = run.digestKeyEnvelope ?? await operations.createDigestKeyEnvelope(run.drillId)
  const next = transitionRun(
    { ...run, digestKeyEnvelope: envelope },
    'discovering-pitr-windows',
    'in-progress',
    canonicalNow(now),
  )
  if (!(await input.state.writeRun(next, run.revision))) return pendingResult(run.drillId, 0)
  return pendingResult(run.drillId, 0)
}

/** Selects the common point and starts one durable restore/export pair per invocation. */
async function advanceDiscovery(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  now: () => Date,
): Promise<RestoreDrillAwsActionResult> {
  let checkpoint = await input.state.readResourceCheckpoint(run.drillId)
  let currentRun = run
  if (!checkpoint) {
    const sources = await operations.collectSourceTableObservations()
    const selection = selectLatestCommonRestorePoint(sources.map((source) => ({
      earliestRestorableTime: source.earliestRestorableAt,
      latestRestorableTime: source.latestRestorableAt,
      target: source.target,
    })))
    calculateRestoreDrillObjectives({
      completedAt: run.startedAt,
      restorePoint: selection.restorePoint,
      startedAt: run.startedAt,
    })
    checkpoint = { sources, restores: [], exports: [], restoredDescriptors: [] }
    await input.state.writeResourceCheckpoint(run.drillId, checkpoint)
    const next = transitionRun(
      {
        ...run,
        restorePoint: selection.restorePoint,
      },
      'discovering-pitr-windows',
      'in-progress',
      canonicalNow(now),
    )
    if (!(await input.state.writeRun(next, run.revision))) return pendingResult(run.drillId, 0)
    currentRun = next
  }
  if (!currentRun.restorePoint) {
    const selection = selectLatestCommonRestorePoint(checkpoint.sources.map((source) => ({
      earliestRestorableTime: source.earliestRestorableAt,
      latestRestorableTime: source.latestRestorableAt,
      target: source.target,
    })))
    calculateRestoreDrillObjectives({
      completedAt: currentRun.startedAt,
      restorePoint: selection.restorePoint,
      startedAt: currentRun.startedAt,
    })
    const reconciled = transitionRun(
      {
        ...currentRun,
        restorePoint: selection.restorePoint,
      },
      'discovering-pitr-windows',
      'in-progress',
      canonicalNow(now),
    )
    if (!(await input.state.writeRun(reconciled, currentRun.revision))) {
      return pendingResult(currentRun.drillId, 0)
    }
    return pendingResult(currentRun.drillId, 0)
  }
  if (!currentRun.restorePoint) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  for (const target of RESTORE_DRILL_TABLE_TARGETS) {
    const source = checkpoint.sources.find((candidate) => candidate.target === target)
    if (!source) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    const intent = await input.state.readStartIntent(currentRun.drillId, target)
    if (!intent) {
      await input.state.writeStartIntent(currentRun.drillId, {
        exportAttempted: false,
        restoreAttempted: false,
        restorePoint: currentRun.restorePoint,
        source,
        target,
      })
      return pendingResult(currentRun.drillId, 0)
    }
    if (!intent.restoreAttempted) {
      await input.state.markStartAttempted(currentRun.drillId, target, 'restore')
      return pendingResult(currentRun.drillId, 0)
    }
    if (!intent.restoreRecord) {
      const table = (await operations.startTableRestore({
        drillId: currentRun.drillId,
        restorePoint: currentRun.restorePoint,
        source,
      })).table
      await input.state.recordStartedRestore(currentRun.drillId, target, table)
      return pendingResult(currentRun.drillId, 0)
    }
    if (!intent.exportAttempted) {
      await input.state.markStartAttempted(currentRun.drillId, target, 'export')
      return pendingResult(currentRun.drillId, 0)
    }
    if (!intent.exportRecord) {
      const exportRecord = await operations.startTableExport({
        drillId: currentRun.drillId,
        exportPoint: currentRun.restorePoint,
        source,
      })
      await input.state.recordStartedExport(
        currentRun.drillId,
        target,
        exportRecord,
      )
      return pendingResult(currentRun.drillId, 0)
    }
  }
  const intents = await input.state.listStartIntents(currentRun.drillId)
  const restores: RestoreDrillRecordedRestoreTable[] = []
  const exports: RestoreDrillRecordedExport[] = []
  for (const target of RESTORE_DRILL_TABLE_TARGETS) {
    const intent = intents.find((candidate) => candidate.target === target)
    if (!intent?.restoreRecord || !intent.exportRecord) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    restores.push(intent.restoreRecord)
    exports.push(intent.exportRecord)
  }
  checkpoint = { ...checkpoint, exports, restores }
  await input.state.writeResourceCheckpoint(currentRun.drillId, checkpoint)
  const next = transitionRun(
    currentRun,
    'restoring-tables',
    'in-progress',
    canonicalNow(now),
  )
  if (!(await input.state.writeRun(next, currentRun.revision))) {
    return pendingResult(currentRun.drillId, 0)
  }
  return pendingResult(currentRun.drillId, 0)
}

/** Polls all exact restore and export identities and advances only after every one completes. */
async function advanceTableRestores(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  now: () => Date,
): Promise<RestoreDrillAwsActionResult> {
  const checkpoint = await requireResourceCheckpoint(input.state, run.drillId)
  if (
    checkpoint.restores.length !== RESTORE_DRILL_TABLE_TARGETS.length ||
    checkpoint.exports.length !== RESTORE_DRILL_TABLE_TARGETS.length
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const restorePolls = await Promise.all(
    checkpoint.restores.map((table) => operations.pollTableRestore(table)),
  )
  const exportPolls = await Promise.all(
    checkpoint.exports.map((record) => operations.pollTableExport(record)),
  )
  if (exportPolls.some((poll) => poll.status === 'failed')) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  for (let index = 0; index < exportPolls.length; index += 1) {
    const poll = exportPolls[index]
    const record = checkpoint.exports[index]
    if (poll?.status !== 'completed') continue
    if (!record || !poll.manifestKey || poll.itemCount === undefined) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    await input.state.writeExportCompletion(run.drillId, {
      exportArnDigest: sha256Hex(`export-arn\0${record.exportArn}`),
      itemCount: poll.itemCount,
      manifestKey: poll.manifestKey,
      target: record.target,
    })
  }
  if (
    restorePolls.some((poll) => poll.status === 'pending') ||
    exportPolls.some((poll) => poll.status === 'pending')
  ) {
    return pendingResult(run.drillId)
  }
  const descriptors: RestoreDrillTableDescriptor[] = []
  for (const poll of restorePolls) {
    if (!poll.descriptor) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    descriptors.push(poll.descriptor)
  }
  await input.state.writeResourceCheckpoint(run.drillId, {
    ...checkpoint,
    restoredDescriptors: descriptors,
  })
  const next = transitionRun(
    run,
    'copying-file-versions',
    'in-progress',
    canonicalNow(now),
  )
  if (!(await input.state.writeRun(next, run.revision))) return pendingResult(run.drillId, 0)
  return pendingResult(run.drillId, 0)
}

/** Copies one isolated File row with a durable pre-copy VersionId baseline. */
async function advanceFileCopies(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  now: () => Date,
  claimIdFactory: () => string,
): Promise<RestoreDrillAwsActionResult> {
  const checkpoint = await requireResourceCheckpoint(input.state, run.drillId)
  const fileTable = checkpoint.restores.find(
    (table) => table.target === 'table:file-proofing',
  )
  if (!fileTable) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  const cursor = await input.state.readFileCursor(run.drillId)
  if (cursor.complete) {
    const next = transitionRun(run, 'verifying', 'in-progress', canonicalNow(now))
    if (!(await input.state.writeRun(next, run.revision))) return pendingResult(run.drillId, 0)
    return pendingResult(run.drillId, 0)
  }
  const page = await operations.scanFileProofingPage(fileTable, cursor.nextKey)
  validateRestoreDrillFileCursorAdvance(cursor.nextKey, page.nextKey)
  if (!page.row) {
    await input.state.writeFileCursor(run.drillId, run.revision, page.nextKey)
    return pendingResult(run.drillId, 0)
  }
  const copies: RestoreDrillRecordedScratchObjectVersion[] = []
  for (let sourceIndex = 0; sourceIndex < page.row.versions.length; sourceIndex += 1) {
    const source = page.row.versions[sourceIndex]
    if (!source) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    const intentDigest = createCopyIntentDigest(source)
    let intent = await input.state.readCopyIntent(run.drillId, intentDigest)
    if (!intent) {
      const preexistingScratchVersionIds = await operations.listScratchObjectVersionIds(source)
      const candidate: RestoreDrillCopyIntent = {
        intentDigest,
        preexistingScratchVersionIds,
        source,
      }
      await input.state.writeCopyIntent(run.drillId, candidate)
      intent = await input.state.readCopyIntent(run.drillId, intentDigest) ?? candidate
    }
    let selectedCopy = intent.selectedCopy
    if (!selectedCopy) {
      const claimedAt = canonicalNow(now)
      if (
        intent.copyClaim &&
        Date.parse(claimedAt) <
          Date.parse(intent.copyClaim.claimedAt) + COPY_CLAIM_GRACE_MILLISECONDS
      ) return pendingResult(run.drillId)
      const nextClaim: RestoreDrillCopyClaim = {
        claimId: requireDrillId(claimIdFactory()),
        claimedAt,
      }
      if (!(await input.state.claimCopyIntent(
        run.drillId,
        intentDigest,
        intent.copyClaim,
        nextClaim,
      ))) return pendingResult(run.drillId)
      const created = await operations.createOrAdoptFileVersion({
        drillId: run.drillId,
        preexistingScratchVersionIds: intent.preexistingScratchVersionIds,
        source,
      })
      await input.state.recordCreatedCopyIntent(
        run.drillId,
        intentDigest,
        nextClaim.claimId,
        created,
      )
      intent = await input.state.readCopyIntent(run.drillId, intentDigest) ?? {
        ...intent,
        createdCopies: created.createdCopies,
        selectedCopy: created.selectedCopy,
      }
      selectedCopy = intent.selectedCopy
      if (!selectedCopy) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
    }
    let copy = intent.completedCopy
    let verifiedThisInvocation = false
    if (!copy) {
      if (!run.digestKeyEnvelope) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      const verificationResult = await operations.withDigestKey(
        run.drillId,
        run.digestKeyEnvelope,
        async (digestKey) => operations.verifyCreatedFileVersion({
          ...(intent.verificationCheckpoint
            ? { checkpoint: intent.verificationCheckpoint }
            : {}),
          copy: selectedCopy,
          digestKey,
          drillId: run.drillId,
          source,
        }),
      )
      if (verificationResult.status === 'pending') {
        await input.state.writeCopyVerificationCheckpoint(
          run.drillId,
          intentDigest,
          intent.verificationCheckpoint,
          verificationResult.checkpoint,
        )
        return pendingResult(run.drillId, 0)
      }
      copy = verificationResult.version
      await input.state.completeCopyIntent(run.drillId, intentDigest, copy)
      verifiedThisInvocation = true
    }
    if (
      copy.objectKey !== source.objectKey ||
      copy.versionId !== source.versionId ||
      copy.drillDigest !== sha256Hex(`drill\0${run.drillId}`).slice(0, 16)
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    copies.push(copy)
    if (verifiedThisInvocation && sourceIndex + 1 < page.row.versions.length) {
      return pendingResult(run.drillId, 0)
    }
  }
  await operations.commitFileRemap({
    copies,
    drillId: run.drillId,
    row: page.row,
    table: fileTable,
  })
  if (!(await input.state.writeFileCursor(run.drillId, run.revision, page.nextKey))) {
    return pendingResult(run.drillId, 0)
  }
  return pendingResult(run.drillId, 0)
}

/** Runs deterministic exact and semantic verification before sealing immutable evidence. */
async function advanceVerification(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  now: () => Date,
): Promise<RestoreDrillAwsActionResult> {
  if (!run.digestKeyEnvelope || !run.restorePoint) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const checkpoint = await requireResourceCheckpoint(input.state, run.drillId)
  let verification = await input.state.readVerificationCheckpoint(run.drillId)
  if (!verification) {
    if (!(await captureNextExportListingPage(input.state, operations, run.drillId, checkpoint))) {
      return pendingResult(run.drillId, 0)
    }
    if (!(await captureNextMultipartUploadListingPage(
      input.state,
      operations,
      run.drillId,
    ))) return pendingResult(run.drillId, 0)
    await requireVerificationExportInventoryWithinBounds(
      input.state,
      run.drillId,
      checkpoint,
    )
    const exportCompletions = await input.state.listExportCompletions(run.drillId)
    const verified = await operations.withDigestKey(
      run.drillId,
      run.digestKeyEnvelope,
      async (digestKey) => {
        const batchDeadline = Date.now() + MAX_VERIFICATION_BATCH_MILLISECONDS
        const verifierInput: RestoreDrillVerifierInput = {
          checkpoint,
          digestKey,
          drillId: run.drillId,
          exportCompletions,
          restorePoint: run.restorePoint ?? '',
        }
        for (
          let step = 0;
          step < MAX_VERIFICATION_STEPS_PER_INVOCATION;
          step += 1
        ) {
          const progress = await input.state.readVerificationProgress(run.drillId)
          const result = await advanceVerificationProgress(
            input,
            operations,
            run,
            progress,
            verifierInput,
          )
          if (result) return result
          if (!continuesVerificationBatchAfter(progress.stage)) return undefined
          if (Date.now() >= batchDeadline) return undefined
        }
        return undefined
      },
    )
    if (!verified) return pendingResult(run.drillId, 0)
    await input.state.writeVerificationCheckpoint(run.drillId, verified)
    verification = verified
  }
  if (!run.verificationCompletedAt) {
    const completedAt = canonicalNow(now)
    const timestamped = incrementRun({
      ...run,
      updatedAt: completedAt,
      verificationCompletedAt: completedAt,
    })
    if (!(await input.state.writeRun(timestamped, run.revision))) {
      return pendingResult(run.drillId)
    }
    return pendingResult(run.drillId)
  }
  return sealVerifiedResult(input, operations, run, verification, now)
}

/** Allows only bounded page-like stages to share one Step Functions Task event. */
function continuesVerificationBatchAfter(stage: RestoreDrillVerificationStage): boolean {
  return stage === 'file-data' ||
    stage === 'restore-data' ||
    stage === 'restore-partition-count' ||
    stage === 'semantic-audit' ||
    stage === 'semantic-claims' ||
    stage === 'semantic-requirements' ||
    stage === 'semantic-secret' ||
    stage === 'source-partition-count'
}

/**
 * Advances one bounded aggregate-verification unit and persists it before returning.
 *
 * @param input - Complete orchestration dependencies.
 * @param operations - AWS primitives used for one restore Scan page.
 * @param run - Exact durable run.
 * @param progress - Current authenticated progress checkpoint.
 * @param verifierInput - Complete fixed verification identities and digest key.
 * @returns Final verification only from the terminal assembly stage.
 */
async function advanceVerificationProgress(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
): Promise<RestoreDrillVerificationResult | undefined> {
  if (progress.stage === 'assembly') {
    if (
      !progress.sourceFileResource ||
      !progress.restoreFileResource ||
      !progress.crossDomainStatus
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    return input.verifier.assembleVerification(
      verifierInput,
      progress.sourceFileResource,
      progress.restoreFileResource,
      progress.sourceResources,
      progress.restoreResources,
      progress.workItemsSchemaStatus,
      progress.crossDomainStatus,
    )
  }
  if (progress.stage === 'file-data') {
    await advanceFileProofVerification(input, run, progress, verifierInput)
    return undefined
  }
  if (progress.stage === 'file-partition-count') {
    await advanceFilePartitionCount(input, run, progress, verifierInput)
    return undefined
  }
  if (progress.stage === 'semantic-secret') {
    await advanceSemanticSecret(input, run, progress, verifierInput)
    return undefined
  }
  if (progress.stage === 'semantic-requirements') {
    await advanceSemanticRequirementEvaluation(input, run, progress, 'requirement')
    return undefined
  }
  if (progress.stage === 'semantic-audit') {
    await advanceSemanticRequirementEvaluation(input, run, progress, 'audit')
    return undefined
  }
  const target = RESTORE_DRILL_TABLE_TARGETS[progress.targetIndex]
  if (!target) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  if (progress.stage === 'semantic-claims') {
    await advanceSemanticClaims(input, run, progress, verifierInput, target)
    return undefined
  }
  switch (progress.stage) {
    case 'source-manifest':
      await advanceSourceManifestVerification(input, run, progress, verifierInput, target)
      return undefined
    case 'source-data':
      await advanceSourceDataVerification(input, run, progress, verifierInput, target)
      return undefined
    case 'source-partition-count':
      await advanceSourcePartitionCount(input, run, progress, verifierInput, target)
      return undefined
    case 'restore-data':
      await advanceRestoreDataVerification(
        input,
        operations,
        run,
        progress,
        verifierInput,
        target,
      )
      return undefined
    case 'restore-partition-count':
      await advanceRestorePartitionCount(input, run, progress, verifierInput, target)
      return undefined
    default:
      return assertUnreachable(progress.stage)
  }
}

/** Process-local independently role-observed File proof accumulators. */
type RestoreDrillFileVerificationAccumulators = {
  /** Destination content-proof accumulator. */
  readonly destinationContent: RestoreDrillKeyedMultisetDigestAccumulator
  /** Destination metadata-and-tag accumulator. */
  readonly destinationMetadata: RestoreDrillKeyedMultisetDigestAccumulator
  /** Source content-proof accumulator. */
  readonly sourceContent: RestoreDrillKeyedMultisetDigestAccumulator
  /** Source metadata-and-tag accumulator. */
  readonly sourceMetadata: RestoreDrillKeyedMultisetDigestAccumulator
}

/** Reads one bounded CopyIntent page and commits only proof digests and opaque object-key tokens. */
async function advanceFileProofVerification(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
): Promise<void> {
  const page = await input.state.readCopyIntentInventoryPage(
    run.drillId,
    progress.fileInventoryCursor,
    100,
  )
  const accumulators = createFileVerificationAccumulators(verifierInput.digestKey)
  let fileAggregateCheckpoint: RestoreDrillFileVerificationCheckpoint
  try {
    if (progress.fileAggregateCheckpoint) {
      mergeFileVerificationCheckpoint(accumulators, progress.fileAggregateCheckpoint)
    }
    const tokens = new Set<string>()
    for (const entry of page.entries) {
      const copy = entry.intent.completedCopy
      if (!copy) {
        throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
      }
      if (
        !verifyRestoreDrillFileVersionProof(copy.sourceProof, verifierInput.digestKey) ||
        !verifyRestoreDrillFileVersionProof(copy.destinationProof, verifierInput.digestKey) ||
        copy.sourceProof.contentDigest !== copy.destinationProof.contentDigest ||
        copy.sourceProof.metadataDigest !== copy.destinationProof.metadataDigest ||
        copy.sourceProof.tagsDigest !== copy.destinationProof.tagsDigest
      ) throw new RestoreDrillFailure('S3_VERSION_RESTORE_FAILED')
      accumulators.sourceContent.add(copy.sourceProof.contentDigest)
      accumulators.destinationContent.add(copy.destinationProof.contentDigest)
      accumulators.sourceMetadata.add(stableJson({
        metadataDigest: copy.sourceProof.metadataDigest,
        tagsDigest: copy.sourceProof.tagsDigest,
      }))
      accumulators.destinationMetadata.add(stableJson({
        metadataDigest: copy.destinationProof.metadataDigest,
        tagsDigest: copy.destinationProof.tagsDigest,
      }))
      tokens.add(createHmac('sha256', verifierInput.digestKey)
        .update('mukuroji-restore-drill-file-logical-partition-v1\0', 'utf8')
        .update(copy.objectKey, 'utf8')
        .digest('hex'))
    }
    const recordCount = (progress.fileAggregateCheckpoint?.recordCount ?? 0) +
      page.entries.length
    if (recordCount > MAX_VERIFICATION_FILE_VERSIONS) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    await input.state.writeVerificationPartitionDigests(
      run.drillId,
      'file',
      'table:file-proofing',
      [...tokens].sort(),
    )
    fileAggregateCheckpoint = checkpointFileVerificationAccumulators(
      accumulators,
      recordCount,
    )
  } finally {
    disposeFileVerificationAccumulators(accumulators)
  }
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    fileAggregateCheckpoint,
    ...(page.nextCursor ? { fileInventoryCursor: page.nextCursor } : {}),
    pageCount: progress.pageCount + 1,
    partitionCount: 0,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    sourceResources: progress.sourceResources,
    stage: page.nextCursor ? 'file-data' : 'file-partition-count',
    targetIndex: 0,
    unitIndex: 0,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Counts one File token page and binds terminal proof aggregates to bucket descriptors. */
async function advanceFilePartitionCount(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
): Promise<void> {
  if (!progress.fileAggregateCheckpoint) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const page = await input.state.readVerificationPartitionCountPage(
    run.drillId,
    'file',
    'table:file-proofing',
    progress.partitionCursor,
  )
  const partitionCount = progress.partitionCount + page.count
  if (partitionCount > progress.fileAggregateCheckpoint.recordCount) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  if (page.nextCursor) {
    await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
      ...progress,
      partitionCount,
      partitionCursor: page.nextCursor,
      revision: progress.revision + 1,
    })
    return
  }
  const evidence = finalizeFileVerificationAccumulators(
    verifierInput.digestKey,
    progress.fileAggregateCheckpoint,
    partitionCount,
  )
  const resources = await input.verifier.finalizeFileVerification(verifierInput, evidence)
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    pageCount: 0,
    partitionCount: 0,
    restoreFileResource: resources.restore,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    sourceFileResource: resources.source,
    sourceResources: progress.sourceResources,
    stage: 'source-manifest',
    targetIndex: 0,
    unitIndex: 0,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Creates four independent accumulators using shared comparison domains. */
function createFileVerificationAccumulators(
  digestKey: Uint8Array,
): RestoreDrillFileVerificationAccumulators {
  return {
    destinationContent: new RestoreDrillKeyedMultisetDigestAccumulator(
      digestKey,
      'restore-drill-file-content-v2',
      MAX_VERIFICATION_FILE_VERSIONS,
    ),
    destinationMetadata: new RestoreDrillKeyedMultisetDigestAccumulator(
      digestKey,
      'restore-drill-file-metadata-v2',
      MAX_VERIFICATION_FILE_VERSIONS,
    ),
    sourceContent: new RestoreDrillKeyedMultisetDigestAccumulator(
      digestKey,
      'restore-drill-file-content-v2',
      MAX_VERIFICATION_FILE_VERSIONS,
    ),
    sourceMetadata: new RestoreDrillKeyedMultisetDigestAccumulator(
      digestKey,
      'restore-drill-file-metadata-v2',
      MAX_VERIFICATION_FILE_VERSIONS,
    ),
  }
}

/** Merges one authenticated File proof checkpoint into empty process-local accumulators. */
function mergeFileVerificationCheckpoint(
  accumulators: RestoreDrillFileVerificationAccumulators,
  checkpoint: RestoreDrillFileVerificationCheckpoint,
): void {
  accumulators.destinationContent.mergeCheckpoint(checkpoint.destinationContent)
  accumulators.destinationMetadata.mergeCheckpoint(checkpoint.destinationMetadata)
  accumulators.sourceContent.mergeCheckpoint(checkpoint.sourceContent)
  accumulators.sourceMetadata.mergeCheckpoint(checkpoint.sourceMetadata)
}

/** Detaches compact authenticated File proof state after one bounded page. */
function checkpointFileVerificationAccumulators(
  accumulators: RestoreDrillFileVerificationAccumulators,
  recordCount: number,
): RestoreDrillFileVerificationCheckpoint {
  return {
    destinationContent: accumulators.destinationContent.checkpoint(),
    destinationMetadata: accumulators.destinationMetadata.checkpoint(),
    recordCount,
    sourceContent: accumulators.sourceContent.checkpoint(),
    sourceMetadata: accumulators.sourceMetadata.checkpoint(),
  }
}

/** Finalizes four authenticated File proof accumulators with one exact token count. */
function finalizeFileVerificationAccumulators(
  digestKey: Uint8Array,
  checkpoint: RestoreDrillFileVerificationCheckpoint,
  logicalPartitionCount: number,
): RestoreDrillFileVerificationEvidence {
  const accumulators = createFileVerificationAccumulators(digestKey)
  try {
    mergeFileVerificationCheckpoint(accumulators, checkpoint)
    return {
      destinationContent: accumulators.destinationContent.finalize(),
      destinationMetadata: accumulators.destinationMetadata.finalize(),
      logicalPartitionCount,
      recordCount: checkpoint.recordCount,
      sourceContent: accumulators.sourceContent.finalize(),
      sourceMetadata: accumulators.sourceMetadata.finalize(),
    }
  } finally {
    disposeFileVerificationAccumulators(accumulators)
  }
}

/** Clears every process-local File proof accumulator. */
function disposeFileVerificationAccumulators(
  accumulators: RestoreDrillFileVerificationAccumulators,
): void {
  accumulators.destinationContent.dispose()
  accumulators.destinationMetadata.dispose()
  accumulators.sourceContent.dispose()
  accumulators.sourceMetadata.dispose()
}

/** Retains completed resources and global semantic counters across stage-local resets. */
function retainVerificationProgressFields(
  progress: RestoreDrillVerificationProgress,
): Pick<
  RestoreDrillVerificationProgress,
  'restoreResources' | 'semanticItemCount' | 'semanticPageCount' | 'sourceResources'
> & Partial<Pick<
  RestoreDrillVerificationProgress,
  | 'auditPseudonymSecretVersionId'
  | 'crossDomainStatus'
  | 'restoreFileResource'
  | 'sourceFileResource'
>> {
  return {
    ...(progress.auditPseudonymSecretVersionId
      ? { auditPseudonymSecretVersionId: progress.auditPseudonymSecretVersionId }
      : {}),
    ...(progress.crossDomainStatus
      ? { crossDomainStatus: progress.crossDomainStatus }
      : {}),
    ...(progress.restoreFileResource
      ? { restoreFileResource: progress.restoreFileResource }
      : {}),
    restoreResources: progress.restoreResources,
    semanticItemCount: progress.semanticItemCount,
    semanticPageCount: progress.semanticPageCount,
    ...(progress.sourceFileResource
      ? { sourceFileResource: progress.sourceFileResource }
      : {}),
    sourceResources: progress.sourceResources,
  }
}

/** Authenticates one manifest and stores each bounded entry individually. */
async function advanceSourceManifestVerification(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
  target: RestoreDrillTableTarget,
): Promise<void> {
  const manifest = await input.verifier.readSourceExportManifest(
    verifierInput,
    target,
    verificationExportVersionReader(input.state, run.drillId),
  )
  await input.state.writeVerificationManifestFiles(run.drillId, target, manifest.dataFiles)
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    manifestFileCount: manifest.dataFiles.length,
    manifestItemCount: manifest.itemCount,
    pageCount: 0,
    partitionCount: 0,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    sourceResources: progress.sourceResources,
    stage: 'source-data',
    targetIndex: progress.targetIndex,
    unitIndex: 0,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Streams exactly one authenticated source data file and commits one compact aggregate CAS. */
async function advanceSourceDataVerification(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
  target: RestoreDrillTableTarget,
): Promise<void> {
  if (
    progress.manifestFileCount === undefined ||
    progress.manifestItemCount === undefined ||
    progress.unitIndex >= progress.manifestFileCount
  ) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  const dataFile = await input.state.readVerificationManifestFile(
    run.drillId,
    target,
    progress.unitIndex,
  )
  if (!dataFile) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  const unit = await input.verifier.aggregateSourceExportFile(
    verifierInput,
    target,
    dataFile,
    verificationExportVersionReader(input.state, run.drillId),
    async (digests) => input.state.writeVerificationPartitionDigests(
      run.drillId,
      'source',
      target,
      digests,
    ),
  )
  const source = findSourceObservation(verifierInput.checkpoint, target)
  const cumulative = new RestoreDrillDynamoAggregateAccumulator(
    verifierInput.digestKey,
    target,
    source.descriptor.keySchema,
    MAX_VERIFICATION_RECORDS_PER_TARGET,
  )
  let aggregateCheckpoint: RestoreDrillDynamoAggregateCheckpoint
  try {
    if (progress.aggregateCheckpoint) cumulative.mergeCheckpoint(progress.aggregateCheckpoint)
    cumulative.mergeCheckpoint(unit)
    aggregateCheckpoint = cumulative.checkpoint(false)
  } finally {
    cumulative.dispose()
  }
  const nextUnitIndex = progress.unitIndex + 1
  const complete = nextUnitIndex === progress.manifestFileCount
  if (
    aggregateCheckpoint.recordCount > progress.manifestItemCount ||
    (complete && aggregateCheckpoint.recordCount !== progress.manifestItemCount)
  ) throw new RestoreDrillFailure('AGGREGATE_RECORD_COUNT_MISMATCH')
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    aggregateCheckpoint,
    manifestFileCount: progress.manifestFileCount,
    manifestItemCount: progress.manifestItemCount,
    pageCount: progress.pageCount + 1,
    partitionCount: 0,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    sourceResources: progress.sourceResources,
    stage: complete ? 'source-partition-count' : 'source-data',
    targetIndex: progress.targetIndex,
    unitIndex: nextUnitIndex,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Reduces one bounded source partition-token COUNT page and finalizes at terminal cursor. */
async function advanceSourcePartitionCount(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
  target: RestoreDrillTableTarget,
): Promise<void> {
  if (!progress.aggregateCheckpoint || progress.manifestItemCount === undefined) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const page = await input.state.readVerificationPartitionCountPage(
    run.drillId,
    'source',
    target,
    progress.partitionCursor,
  )
  const partitionCount = progress.partitionCount + page.count
  if (partitionCount > progress.aggregateCheckpoint.recordCount) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  if (page.nextCursor) {
    await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
      ...progress,
      partitionCount,
      partitionCursor: page.nextCursor,
      revision: progress.revision + 1,
    })
    return
  }
  const source = findSourceObservation(verifierInput.checkpoint, target)
  const evidence = finalizeVerificationAggregate(
    verifierInput.digestKey,
    target,
    source.descriptor.keySchema,
    progress.aggregateCheckpoint,
    partitionCount,
  )
  const sourceResource = createTableResourceAggregate(
    target,
    calculateDescriptorDigest(source.descriptor, verifierInput.digestKey),
    evidence,
  )
  const restoredDescriptor = findRestoredDescriptor(verifierInput.checkpoint, target)
  const descriptorGatePassed = descriptorsMatchForRestore(
    source.descriptor,
    restoredDescriptor,
  )
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    pageCount: 0,
    partitionCount: 0,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    sourceResources: [...progress.sourceResources, sourceResource],
    stage: 'restore-data',
    targetIndex: progress.targetIndex,
    unitIndex: 0,
    workItemsSchemaStatus:
      target === 'table:work-items' && !descriptorGatePassed
        ? 'fail'
        : progress.workItemsSchemaStatus,
  })
}

/** Scans exactly one isolated restore page and commits its opaque tokens before progress CAS. */
async function advanceRestoreDataVerification(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
  target: RestoreDrillTableTarget,
): Promise<void> {
  if (progress.pageCount >= MAX_VERIFICATION_RESTORE_PAGES_PER_TARGET) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  const source = findSourceObservation(verifierInput.checkpoint, target)
  const restoredTable = findRestoredTable(verifierInput.checkpoint, target)
  const cumulative = new RestoreDrillDynamoAggregateAccumulator(
    verifierInput.digestKey,
    target,
    source.descriptor.keySchema,
    MAX_VERIFICATION_RECORDS_PER_TARGET,
  )
  let page: Awaited<ReturnType<RestoreDrillAwsOperations['scanRestoreAggregatePage']>>
  let aggregateCheckpoint: RestoreDrillDynamoAggregateCheckpoint
  try {
    if (progress.aggregateCheckpoint) cumulative.mergeCheckpoint(progress.aggregateCheckpoint)
    page = await operations.scanRestoreAggregatePage({
      accumulator: cumulative,
      ...(progress.nextKey ? { exclusiveStartKey: progress.nextKey } : {}),
      limit: 1_000,
      table: restoredTable,
    })
    const partitionDigests = cumulative.drainPartitionDigests()
    await input.state.writeVerificationPartitionDigests(
      run.drillId,
      'restore',
      target,
      partitionDigests,
    )
    aggregateCheckpoint = cumulative.checkpoint(false)
  } finally {
    cumulative.dispose()
  }
  if (aggregateCheckpoint.recordCount > MAX_VERIFICATION_RECORDS_PER_TARGET) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    aggregateCheckpoint,
    ...(page.nextKey ? { nextKey: page.nextKey } : {}),
    pageCount: progress.pageCount + 1,
    partitionCount: 0,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    sourceResources: progress.sourceResources,
    stage: page.nextKey ? 'restore-data' : 'restore-partition-count',
    targetIndex: progress.targetIndex,
    unitIndex: 0,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Reduces one bounded restore partition-token COUNT page and advances the target. */
async function advanceRestorePartitionCount(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
  target: RestoreDrillTableTarget,
): Promise<void> {
  if (!progress.aggregateCheckpoint) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const page = await input.state.readVerificationPartitionCountPage(
    run.drillId,
    'restore',
    target,
    progress.partitionCursor,
  )
  const partitionCount = progress.partitionCount + page.count
  if (partitionCount > progress.aggregateCheckpoint.recordCount) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  if (page.nextCursor) {
    await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
      ...progress,
      partitionCount,
      partitionCursor: page.nextCursor,
      revision: progress.revision + 1,
    })
    return
  }
  const source = findSourceObservation(verifierInput.checkpoint, target)
  const restoredDescriptor = findRestoredDescriptor(verifierInput.checkpoint, target)
  const descriptorGatePassed = descriptorsMatchForRestore(
    source.descriptor,
    restoredDescriptor,
  )
  const evidence = finalizeVerificationAggregate(
    verifierInput.digestKey,
    target,
    source.descriptor.keySchema,
    progress.aggregateCheckpoint,
    partitionCount,
  )
  const restoreResource = createTableResourceAggregate(
    target,
    descriptorGatePassed
      ? calculateDescriptorDigest(source.descriptor, verifierInput.digestKey)
      : calculateDescriptorDigest(restoredDescriptor, verifierInput.digestKey),
    evidence,
  )
  const nextTargetIndex = progress.targetIndex + 1
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    pageCount: 0,
    partitionCount: 0,
    restoreResources: [...progress.restoreResources, restoreResource],
    revision: progress.revision + 1,
    sourceResources: progress.sourceResources,
    stage: nextTargetIndex === RESTORE_DRILL_TABLE_TARGETS.length
      ? 'semantic-secret'
      : 'source-manifest',
    targetIndex: nextTargetIndex,
    unitIndex: 0,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Pins one immutable Audit pseudonym secret version before any semantic table read. */
async function advanceSemanticSecret(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
): Promise<void> {
  const auditPseudonymSecretVersionId = await input.verifier
    .resolveSemanticSecretVersion(verifierInput)
  if (!isSecretsManagerVersionId(auditPseudonymSecretVersionId)) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    auditPseudonymSecretVersionId,
    pageCount: 0,
    partitionCount: 0,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    semanticItemCount: 0,
    semanticPageCount: 0,
    sourceResources: progress.sourceResources,
    stage: 'semantic-claims',
    targetIndex: 0,
    unitIndex: 0,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Reads, writes, and checkpoints one bounded isolated semantic normalization page. */
async function advanceSemanticClaims(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  verifierInput: RestoreDrillVerifierInput,
  target: RestoreDrillTableTarget,
): Promise<void> {
  if (
    !progress.auditPseudonymSecretVersionId ||
    progress.semanticPageCount >= MAX_VERIFICATION_SEMANTIC_PAGES
  ) throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  const page = await input.verifier.readSemanticClaimPage(
    verifierInput,
    target,
    progress.auditPseudonymSecretVersionId,
    MAX_VERIFICATION_SEMANTIC_UNITS - progress.semanticItemCount,
    progress.semanticNextCursor,
  )
  if (
    !isNonNegativeInteger(page.retainedUnitCount) ||
    page.retainedUnitCount > MAX_VERIFICATION_SEMANTIC_UNITS - progress.semanticItemCount ||
    page.claims.length > MAX_VERIFICATION_SEMANTIC_CLAIMS_PER_PAGE
  ) throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  await input.state.writeVerificationSemanticClaims(
    run.drillId,
    page.claims,
    verifierInput.digestKey,
  )
  const semanticItemCount = progress.semanticItemCount + page.retainedUnitCount
  const semanticPageCount = progress.semanticPageCount + 1
  const nextTargetIndex = page.nextCursor
    ? progress.targetIndex
    : progress.targetIndex + 1
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    ...(page.nextCursor ? { semanticNextCursor: page.nextCursor } : {}),
    pageCount: 0,
    partitionCount: 0,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    semanticItemCount,
    semanticPageCount,
    sourceResources: progress.sourceResources,
    stage: nextTargetIndex === RESTORE_DRILL_TABLE_TARGETS.length
      ? 'semantic-requirements'
      : 'semantic-claims',
    targetIndex: nextTargetIndex,
    unitIndex: 0,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Evaluates one bounded regular or latest-Audit semantic requirement page. */
async function advanceSemanticRequirementEvaluation(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillVerificationProgress,
  source: 'audit' | 'requirement',
): Promise<void> {
  const page = await input.state.readVerificationSemanticRequirementPage(
    run.drillId,
    source,
    progress.semanticRequirementCursor,
    100,
  )
  await input.state.evaluateVerificationSemanticRequirements(
    run.drillId,
    page.requirements,
  )
  if (page.nextCursor) {
    await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
      ...progress,
      revision: progress.revision + 1,
      semanticRequirementCursor: page.nextCursor,
    })
    return
  }
  const terminal = source === 'audit'
  const crossDomainStatus = terminal
    ? (await input.state.hasVerificationSemanticFailures(run.drillId) ? 'fail' : 'pass')
    : undefined
  await writeVerificationProgressOrThrow(input.state, run.drillId, progress, {
    ...retainVerificationProgressFields(progress),
    ...(crossDomainStatus ? { crossDomainStatus } : {}),
    pageCount: 0,
    partitionCount: 0,
    restoreResources: progress.restoreResources,
    revision: progress.revision + 1,
    semanticItemCount: progress.semanticItemCount,
    semanticPageCount: progress.semanticPageCount,
    sourceResources: progress.sourceResources,
    stage: terminal ? 'assembly' : 'semantic-audit',
    targetIndex: RESTORE_DRILL_TABLE_TARGETS.length,
    unitIndex: 0,
    workItemsSchemaStatus: progress.workItemsSchemaStatus,
  })
}

/** Creates one exact VersionId reader bound to the current state namespace. */
function verificationExportVersionReader(
  state: RestoreDrillStateStore,
  drillId: string,
): RestoreDrillExportVersionReader {
  return async (exportArnDigest, objectKey) => state.readVerificationExportObjectVersion(
    drillId,
    exportArnDigest,
    objectKey,
  )
}

/** Finalizes one authenticated aggregate with an externally reduced partition count. */
function finalizeVerificationAggregate(
  digestKey: Uint8Array,
  target: RestoreDrillTableTarget,
  keySchema: RestoreDrillTableDescriptor['keySchema'],
  checkpoint: RestoreDrillDynamoAggregateCheckpoint,
  partitionCount: number,
): ReturnType<RestoreDrillDynamoAggregateAccumulator['finalize']> {
  const accumulator = new RestoreDrillDynamoAggregateAccumulator(
    digestKey,
    target,
    keySchema,
    MAX_VERIFICATION_RECORDS_PER_TARGET,
  )
  try {
    accumulator.mergeCheckpoint(checkpoint)
    return accumulator.finalize(partitionCount)
  } finally {
    accumulator.dispose()
  }
}

/** Writes verification progress or reports the exact compare-and-swap conflict. */
async function writeVerificationProgressOrThrow(
  state: RestoreDrillStateStore,
  drillId: string,
  expected: RestoreDrillVerificationProgress,
  next: RestoreDrillVerificationProgress,
): Promise<void> {
  if (!(await state.writeVerificationProgress(drillId, expected, next))) {
    throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }
}

/**
 * Applies verification-work limits without truncating the separately durable cleanup ledger.
 *
 * @param state - Durable state and inventory checkpoints.
 * @param drillId - Stable drill identifier.
 * @param checkpoint - Exact recorded export identities.
 */
async function requireVerificationExportInventoryWithinBounds(
  state: RestoreDrillStateStore,
  drillId: string,
  checkpoint: RestoreDrillResourceCheckpoint,
): Promise<void> {
  for (const record of checkpoint.exports) {
    const listing = await state.readExportListingCheckpoint(drillId, record.target)
    if (
      listing.objectCount > MAX_EXPORT_LISTING_OBJECTS_PER_TARGET ||
      listing.pageCount > MAX_EXPORT_LISTING_PAGES_PER_TARGET
    ) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
  }
}

/** Seals a complete verification checkpoint into immutable result evidence. */
async function sealVerifiedResult(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  verification: RestoreDrillVerificationResult,
  now: () => Date,
): Promise<RestoreDrillAwsActionResult> {
  if (run.terminalArtifactIntent) {
    return publishTerminalArtifactIntent(input, run)
  }
  if (
    !run.digestKeyEnvelope ||
    !run.restorePoint ||
    !run.verificationCompletedAt
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const checkpoint = await requireResourceCheckpoint(input.state, run.drillId)
  const reconciliationWait = await advanceFinalCopyReconciliation(
    input.state,
    operations,
    run,
    now,
  )
  if (reconciliationWait !== undefined) {
    return pendingResult(run.drillId, reconciliationWait)
  }
  const cleanupScope = await advanceCleanupScopeSeal(
    input.state,
    operations,
    run,
    checkpoint,
  )
  if (!cleanupScope?.resourceDigest) return pendingResult(run.drillId, 0)
  const sealed = await operations.withDigestKey(
    run.drillId,
    run.digestKeyEnvelope,
    async (digestKey) => {
      const comparison = compareRestoreDrillDatasetAggregates(
        verification.sourceAggregate,
        verification.restoreAggregate,
      )
      const objectives = calculateRestoreDrillObjectives({
        completedAt: run.verificationCompletedAt ?? '',
        restorePoint: run.restorePoint ?? '',
        startedAt: run.startedAt,
      })
      const semanticFailures: RestoreDrillFailureCode[] = []
      if (verification.crossDomainStatus === 'fail') {
        semanticFailures.push('CROSS_DOMAIN_INTEGRITY_FAILED')
      }
      if (verification.workItemsSchemaStatus === 'fail') {
        semanticFailures.push('AGGREGATE_DESCRIPTOR_MISMATCH')
      }
      const failureCodes = canonicalFailureCodes([
        ...run.failureCodes,
        ...objectives.failureCodes,
        ...comparison.failureCodes,
        ...semanticFailures,
      ])
      const resultOutcome: 'fail' | 'pass' = failureCodes.length === 0 ? 'pass' : 'fail'
      const resourceDigest = cleanupScope.resourceDigest ?? ''
      const result: RestoreDrillResultEvidence = {
        completedAt: run.verificationCompletedAt ?? '',
        comparison,
        drillId: run.drillId,
        failureCodes,
        kind: 'mukuroji-restore-drill-result',
        objectives,
        resourceDigest,
        restoreAggregateDigest: calculateRestoreDrillDatasetDigest(
          verification.restoreAggregate,
          digestKey,
        ),
        restorePoint: run.restorePoint ?? '',
        resultVersion: 1,
        runState: resultOutcome === 'pass'
          ? { outcome: 'pass', phase: 'completed' }
          : { outcome: 'fail', phase: 'failed' },
        sourceAggregateDigest: calculateRestoreDrillDatasetDigest(
          verification.sourceAggregate,
          digestKey,
        ),
        startedAt: run.startedAt,
      }
      const semantic: {
        readonly crossDomainStatus: 'fail' | 'pass'
        readonly workItemsSchemaStatus: 'fail' | 'pass'
      } = {
        crossDomainStatus: verification.crossDomainStatus,
        workItemsSchemaStatus: verification.workItemsSchemaStatus,
      }
      const resultDigest = createHmac('sha256', digestKey)
        .update('mukuroji-restore-drill-result-artifact-v1\0', 'utf8')
        .update(stableJson({ result, semantic }), 'utf8')
        .digest('hex')
      return {
        artifact: { result, resultDigest, semantic } satisfies RestoreDrillEvidenceArtifact,
        failureCodes,
        resourceDigest,
        resultOutcome,
      }
    },
  )
  const evidenceKey = resultEvidenceKey(run.drillId)
  const effects: RestoreDrillTerminalEffect[] = []
  if (sealed.resultOutcome === 'pass') {
    effects.push({
      completedAt: run.verificationCompletedAt,
      kind: 'record-successful-verification',
    })
  }
  effects.push(
    {
      kind: 'metric',
      metricName: 'RpoSeconds',
      unit: 'Seconds',
      value: sealed.artifact.result.objectives.rpoSeconds,
    },
    {
      kind: 'metric',
      metricName: 'RtoSeconds',
      unit: 'Seconds',
      value: sealed.artifact.result.objectives.rtoSeconds,
    },
    {
      kind: 'metric',
      metricName: 'DrillFailureCount',
      unit: 'Count',
      value: sealed.resultOutcome === 'fail' ? 1 : 0,
    },
    {
      kind: 'metric',
      metricName: 'IntegrityFailureCount',
      unit: 'Count',
      value: sealed.failureCodes.some(isRestoreDrillIntegrityFailureCode) ? 1 : 0,
    },
    {
      kind: 'metric',
      metricName: 'CleanupOverdueCount',
      unit: 'Count',
      value: 0,
    },
  )
  const pinned = await pinTerminalArtifactIntent(input.state, run, {
    artifactJson: stableJson(sealed.artifact),
    effects,
    evidenceKey,
    failureCodes: sealed.failureCodes,
    resourceDigest: sealed.resourceDigest,
    resultDigest: sealed.artifact.resultDigest,
    resultOutcome: sealed.resultOutcome,
    retentionReferenceAt: run.verificationCompletedAt,
  })
  return pinned
    ? publishTerminalArtifactIntent(input, pinned)
    : pendingResult(run.drillId, 0)
}

/** Creates complete or fallback immutable evidence for an unexpected safe failure. */
async function sealFailure(
  input: CreateRestoreDrillOrchestratorInput,
  operations: RestoreDrillAwsOperations,
  run: RestoreDrillDurableRun,
  failureCode: RestoreDrillFailureCode,
  now: () => Date,
): Promise<RestoreDrillAwsActionResult> {
  if (run.terminalArtifactIntent) {
    return publishTerminalArtifactIntent(input, run)
  }
  if (run.phase === 'awaiting-cleanup-approval') return awaitingApprovalResult(run)
  if (run.phase === 'completed') return { drillId: run.drillId, status: 'completed' }
  let current = run
  const durableFailureCode = current.failureCodes[0] ?? failureCode
  if (current.failureCodes.length === 0) {
    const failed = incrementRun({ ...current, failureCodes: [durableFailureCode] })
    if (!(await input.state.writeRun(failed, current.revision))) {
      return pendingResult(current.drillId, 0)
    }
    current = failed
  }
  if (!current.digestKeyEnvelope) {
    const envelope = await operations.createDigestKeyEnvelope(current.drillId)
    const next = incrementRun({
      ...current,
      digestKeyEnvelope: envelope,
      updatedAt: canonicalNow(now),
    })
    if (!(await input.state.writeRun(next, current.revision))) return pendingResult(run.drillId)
    current = next
  }
  if (!current.verificationCompletedAt) {
    const failedAt = canonicalNow(now)
    const next = incrementRun({
      ...current,
      updatedAt: failedAt,
      verificationCompletedAt: failedAt,
    })
    if (!(await input.state.writeRun(next, current.revision))) return pendingResult(run.drillId)
    current = next
  }
  const envelope = current.digestKeyEnvelope
  const failedAt = current.verificationCompletedAt
  if (!envelope || !failedAt) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  if (!(await reconcileNextAttemptedStartIntent(
    input.state,
    operations,
    current.drillId,
  ))) return pendingResult(current.drillId)
  await synchronizeResourceCheckpointFromStartIntents(input.state, current.drillId)
  const verification = await input.state.readVerificationCheckpoint(current.drillId)
  if (verification && current.restorePoint) {
    const forced: RestoreDrillVerificationResult = {
      ...verification,
      crossDomainStatus: durableFailureCode === 'CROSS_DOMAIN_INTEGRITY_FAILED'
        ? 'fail'
        : verification.crossDomainStatus,
    }
    const failedRun = {
      ...current,
      failureCodes: [...current.failureCodes],
    }
    return sealVerifiedResult(input, operations, failedRun, forced, now)
  }
  const checkpoint = await input.state.readResourceCheckpoint(current.drillId)
  if (checkpoint && checkpoint.exports.length > 0) {
    const exportPolls = await Promise.all(
      checkpoint.exports.map((record) => operations.pollTableExport(record)),
    )
    for (let index = 0; index < exportPolls.length; index += 1) {
      const poll = exportPolls[index]
      const record = checkpoint.exports[index]
      if (poll?.status !== 'completed') continue
      if (!record || !poll.manifestKey || poll.itemCount === undefined) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      await input.state.writeExportCompletion(current.drillId, {
        exportArnDigest: sha256Hex(`export-arn\0${record.exportArn}`),
        itemCount: poll.itemCount,
        manifestKey: poll.manifestKey,
        target: record.target,
      })
    }
    if (exportPolls.some((poll) => poll.status === 'pending')) {
      return pendingResult(current.drillId)
    }
    if (!(await captureNextExportListingPage(
      input.state,
      operations,
      current.drillId,
      checkpoint,
    ))) {
      return pendingResult(current.drillId, 0)
    }
  }
  const reconciliationWait = await advanceFinalCopyReconciliation(
    input.state,
    operations,
    current,
    now,
  )
  if (reconciliationWait !== undefined) {
    return pendingResult(current.drillId, reconciliationWait)
  }
  if (!(await captureNextMultipartUploadListingPage(
    input.state,
    operations,
    current.drillId,
  ))) return pendingResult(current.drillId, 0)
  const cleanupScope = await advanceCleanupScopeSeal(
    input.state,
    operations,
    current,
    checkpoint,
  )
  if (!cleanupScope?.resourceDigest) return pendingResult(current.drillId, 0)
  const rpoObjectives = current.restorePoint
    ? calculateRestoreDrillObjectives({
        completedAt: current.startedAt,
        restorePoint: current.restorePoint,
        startedAt: current.startedAt,
      })
    : undefined
  const terminalFailureCodes = canonicalFailureCodes([
    ...current.failureCodes,
    ...(rpoObjectives?.failureCodes ?? []),
  ])
  const fallback = await operations.withDigestKey(
    current.drillId,
    envelope,
    async (digestKey) => {
      const resourceDigest = cleanupScope.resourceDigest ?? ''
      const artifact: RestoreDrillEvidenceArtifact = {
        drillId: current.drillId,
        failedAt,
        failureCode: durableFailureCode,
        failureVersion: 1,
        kind: 'mukuroji-restore-drill-operational-failure',
        phase: current.phase,
      }
      return {
        artifact,
        resourceDigest,
        resultDigest: keyedArtifactDigest(artifact, digestKey),
      }
    },
  )
  const evidenceKey = resultEvidenceKey(current.drillId)
  const effects: RestoreDrillTerminalEffect[] = []
  if (rpoObjectives) {
    effects.push({
      kind: 'metric',
      metricName: 'RpoSeconds',
      unit: 'Seconds',
      value: rpoObjectives.rpoSeconds,
    })
  }
  effects.push(
    {
      kind: 'metric',
      metricName: 'DrillFailureCount',
      unit: 'Count',
      value: 1,
    },
    {
      kind: 'metric',
      metricName: 'IntegrityFailureCount',
      unit: 'Count',
      value: isRestoreDrillIntegrityFailureCode(durableFailureCode) ? 1 : 0,
    },
  )
  if (durableFailureCode === 'RTO_TARGET_MISSED') {
    effects.push({
      kind: 'metric',
      metricName: 'RtoSeconds',
      unit: 'Seconds',
      value: Math.ceil((Date.parse(failedAt) - Date.parse(current.startedAt)) / 1_000),
    })
  }
  const pinned = await pinTerminalArtifactIntent(input.state, current, {
    artifactJson: stableJson(fallback.artifact),
    effects,
    evidenceKey,
    failureCodes: terminalFailureCodes,
    resourceDigest: fallback.resourceDigest,
    resultDigest: fallback.resultDigest,
    resultOutcome: 'fail',
    retentionReferenceAt: failedAt,
  })
  return pinned
    ? publishTerminalArtifactIntent(input, pinned)
    : pendingResult(current.drillId, 0)
}

/** Pins exact terminal bytes and effects in RUN before any immutable S3 write. */
async function pinTerminalArtifactIntent(
  state: RestoreDrillStateStore,
  run: RestoreDrillDurableRun,
  intent: RestoreDrillTerminalArtifactIntent,
): Promise<RestoreDrillDurableRun | undefined> {
  if (run.terminalArtifactIntent) return run
  const pinned = incrementRun({
    ...run,
    terminalArtifactIntent: intent,
    terminalEffectIndex: 0,
  })
  return await state.writeRun(pinned, run.revision) ? pinned : undefined
}

/** Publishes one pinned terminal artifact and resumes its ordered idempotent effects. */
async function publishTerminalArtifactIntent(
  input: CreateRestoreDrillOrchestratorInput,
  run: RestoreDrillDurableRun,
): Promise<RestoreDrillAwsActionResult> {
  const intent = run.terminalArtifactIntent
  if (!intent || run.terminalEffectIndex === undefined) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  let current = run
  const requiresAwaitingTransition =
    current.phase !== 'awaiting-cleanup-approval' &&
    current.phase !== 'cleaning-up' &&
    current.phase !== 'completed'
  if (requiresAwaitingTransition) {
    try {
      await input.evidence.putImmutablePinned(
        intent.evidenceKey,
        intent.artifactJson,
        intent.retentionReferenceAt,
      )
    } catch {
      return pendingResult(current.drillId)
    }
  }
  while ((current.terminalEffectIndex ?? 0) < intent.effects.length) {
    const effectIndex = current.terminalEffectIndex ?? 0
    const effect = intent.effects[effectIndex]
    if (!effect) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    try {
      if (effect.kind === 'record-successful-verification') {
        await input.state.recordSuccessfulVerification(current.drillId, effect.completedAt)
      } else {
        await input.metrics.put(effect.metricName, effect.value, effect.unit)
      }
    } catch {
      return pendingResult(current.drillId)
    }
    const advanced = incrementRun({
      ...current,
      terminalEffectIndex: effectIndex + 1,
    })
    if (!(await input.state.writeRun(advanced, current.revision))) {
      return pendingResult(current.drillId, 0)
    }
    current = advanced
  }
  const published = requiresAwaitingTransition
    ? transitionRun(
        {
          ...current,
          failureCodes: [...intent.failureCodes],
          resourceDigest: intent.resourceDigest,
          resultDigest: intent.resultDigest,
          resultEvidenceKey: intent.evidenceKey,
          resultOutcome: intent.resultOutcome,
          terminalArtifactIntent: undefined,
          terminalEffectIndex: undefined,
        },
        'awaiting-cleanup-approval',
        'in-progress',
        latestCanonicalTimestamp([current.updatedAt, intent.retentionReferenceAt]),
      )
    : incrementRun({
        ...current,
        terminalArtifactIntent: undefined,
        terminalEffectIndex: undefined,
      })
  if (!(await input.state.writeRun(published, current.revision))) {
    return pendingResult(current.drillId, 0)
  }
  if (published.phase === 'completed') {
    return { drillId: published.drillId, status: 'completed' }
  }
  if (published.phase !== 'awaiting-cleanup-approval') {
    return { drillId: published.drillId, status: 'failed' }
  }
  return awaitingApprovalResult(published)
}

/** Parses either a strict scheduled event or an exact continuation object. */
function parseAdvanceEvent(value: unknown): ParsedAdvanceEvent {
  if (isRecord(value) && Object.keys(value).length === 1 && 'drillId' in value) {
    return { kind: 'continuation', drillId: requireDrillId(value.drillId) }
  }
  return { kind: 'schedule', event: parseScheduledEvent(value) }
}

/** Parsed cleanup invocation with an optional first-invocation approval key. */
type ParsedCleanupEvent = {
  /** Immutable approval object key on the first invocation. */
  readonly approvalObjectKey?: string
  /** Exact Standard Step Functions execution ARN supplied on every invocation. */
  readonly cleanupExecutionArn: string
  /** Deterministic receipt-bound Standard Step Functions execution name. */
  readonly cleanupExecutionName: string
  /** Stable drill identifier. */
  readonly drillId: string
}

/** Parses one cleanup admission or resume event. */
function parseCleanupEvent(value: unknown): ParsedCleanupEvent {
  const record = requireRecord(value, 'REQUEST_INVALID')
  const drillId = requireDrillId(record.drillId)
  const cleanupExecutionName = requireCleanupExecutionName(record.cleanupExecutionName)
  const cleanupExecutionArn = requireCleanupExecutionArn(
    record.cleanupExecutionArn,
    cleanupExecutionName,
  )
  if (Object.keys(record).length === 3) {
    return { cleanupExecutionArn, cleanupExecutionName, drillId }
  }
  if (Object.keys(record).length === 4 && 'approvalObjectKey' in record) {
    return {
      approvalObjectKey: requireApprovalObjectKey(record.approvalObjectKey, drillId),
      cleanupExecutionArn,
      cleanupExecutionName,
      drillId,
    }
  }
  throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
}

/** Validates one deterministic cleanup execution name without accepting arbitrary values. */
function requireCleanupExecutionName(value: unknown): string {
  if (typeof value !== 'string' || !/^restore-cleanup-[a-f0-9]{64}$/.test(value)) {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  return value
}

/** Validates one Standard Step Functions execution ARN and its exact name suffix. */
function requireCleanupExecutionArn(value: unknown, executionName: string): string {
  if (
    typeof value !== 'string' ||
    !cleanupExecutionArnHasName(value, executionName)
  ) {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  return value
}

/** Validates one exact runner Standard Step Functions execution ARN. */
function requireRunnerExecutionArn(value: unknown): string {
  if (typeof value !== 'string' || !isRunnerExecutionArn(value)) {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  return value
}

/** Checks the strict runner Standard Step Functions execution ARN shape. */
function isRunnerExecutionArn(value: string): boolean {
  return parseCleanupExecutionArn(value) !== undefined
}

/** Checks an execution ARN against one exact deterministic execution name. */
function cleanupExecutionArnHasName(value: string, executionName: string): boolean {
  return parseCleanupExecutionArn(value)?.executionName === executionName
}

/** Parsed exact Standard cleanup execution identity. */
type RestoreDrillCleanupExecutionArnIdentity = {
  /** AWS account owning the state machine. */
  readonly accountId: string
  /** Exact execution name. */
  readonly executionName: string
  /** AWS ARN partition. */
  readonly partition: RestoreDrillAwsPartition
  /** AWS Region containing the state machine. */
  readonly region: string
  /** Physical state-machine name embedded in the execution ARN. */
  readonly stateMachineName: string
}

/** Parses an exact Standard execution ARN without accepting aliases or map-run ARNs. */
function parseCleanupExecutionArn(
  value: string,
): RestoreDrillCleanupExecutionArnIdentity | undefined {
  const match = /^arn:(aws|aws-cn|aws-us-gov):states:([^:]+):(\d{12}):execution:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{1,80})$/.exec(value)
  const partition = match?.[1]
  const region = match?.[2]
  const accountId = match?.[3]
  const stateMachineName = match?.[4]
  const executionName = match?.[5]
  const expectedPartition = region === undefined
    ? undefined
    : resolveRestoreDrillAwsPartition(region)
  if (
    (partition !== 'aws' && partition !== 'aws-cn' && partition !== 'aws-us-gov') ||
    expectedPartition !== partition ||
    !region ||
    !accountId ||
    !stateMachineName ||
    !executionName
  ) return undefined
  return { accountId, executionName, partition, region, stateMachineName }
}

/** Checks whether a cleanup invocation matches the execution identity pinned in RUN. */
function cleanupExecutionMatches(
  run: RestoreDrillDurableRun,
  event: ParsedCleanupEvent,
): boolean {
  return run.cleanupExecutionArn === event.cleanupExecutionArn &&
    run.cleanupExecutionName === event.cleanupExecutionName
}

/** Re-reads RUN immediately before mutation and rejects a rotated execution. */
async function requireCurrentCleanupExecution(
  state: RestoreDrillStateStore,
  executions: RestoreDrillCleanupExecutionStore,
  expectedRun: RestoreDrillDurableRun,
  event: ParsedCleanupEvent,
): Promise<void> {
  const current = await state.readCleanupRun(expectedRun.drillId)
  if (
    !current ||
    current.phase !== 'cleaning-up' ||
    current.revision !== expectedRun.revision ||
    !cleanupExecutionMatches(current, event)
  ) {
    throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }
  const observation = await executions.readStatus(event.cleanupExecutionArn)
  if (observation.status !== 'RUNNING' || observation.redriveCount !== 0) {
    throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
  }
}

/** Validates an immutable approval object key and its drill binding. */
function requireApprovalObjectKey(value: unknown, drillId: string): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(
      `^approvals/v1/runs/${escapeRegularExpression(drillId)}/[a-f0-9]{64}\\.json$`,
    ).test(value)
  ) {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  return value
}

/** Escapes one literal for a dynamically constructed regular expression. */
function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Strictly parses the standard EventBridge scheduled-event envelope. */
function parseScheduledEvent(value: unknown): RestoreDrillScheduledEvent {
  const record = requireRecord(value, 'REQUEST_INVALID')
  const expectedKeys = [
    'account',
    'detail',
    'detail-type',
    'id',
    'region',
    'resources',
    'source',
    'time',
    'version',
  ]
  if (
    !sameStringVector(Object.keys(record).sort(), expectedKeys) ||
    record.version !== '0' ||
    record.source !== 'aws.events' ||
    record['detail-type'] !== 'Scheduled Event' ||
    typeof record.account !== 'string' ||
    !/^\d{12}$/.test(record.account) ||
    typeof record.id !== 'string' ||
    record.id.length < 8 ||
    record.id.length > 128 ||
    typeof record.region !== 'string' ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(record.region) ||
    !isRecord(record.detail) ||
    Object.keys(record.detail).length !== 0 ||
    !Array.isArray(record.resources) ||
    record.resources.some((resource) => typeof resource !== 'string' || resource.length === 0)
  ) {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  const time = requireCanonicalTimestamp(record.time)
  const resources: string[] = []
  for (const resource of record.resources) {
    if (typeof resource !== 'string') {
      throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
    }
    resources.push(resource)
  }
  return {
    account: record.account,
    'detail-type': 'Scheduled Event',
    detail: {},
    id: record.id,
    region: record.region,
    resources,
    source: 'aws.events',
    time,
    version: '0',
  }
}

/** Validates one stable drill identifier. */
function requireDrillId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  return value
}

/** Reads one canonical UTC timestamp. */
function requireCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  return value
}

/** Returns the injected clock as a canonical UTC timestamp. */
function canonicalNow(now: () => Date): string {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }
  return value.toISOString()
}

/** Returns the latest timestamp without allowing a durable clock to move backwards. */
function latestCanonicalTimestamp(values: readonly string[]): string {
  let latest = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!isCanonicalTimestamp(value)) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    latest = Math.max(latest, Date.parse(value))
  }
  if (!Number.isFinite(latest)) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return new Date(latest).toISOString()
}

/** Reads one existing run or raises a raw-value-free missing-state error. */
async function requireRun(
  state: RestoreDrillStateStore,
  drillId: string,
): Promise<RestoreDrillDurableRun> {
  const run = await state.readRun(drillId)
  if (!run) throw new RestoreDrillOrchestratorFailure('RUN_NOT_FOUND')
  return run
}

/** Reads one projected cleanup run or raises a raw-value-free missing-state error. */
async function requireCleanupRun(
  state: RestoreDrillStateStore,
  drillId: string,
): Promise<RestoreDrillDurableRun> {
  const run = await state.readCleanupRun(drillId)
  if (!run) throw new RestoreDrillOrchestratorFailure('RUN_NOT_FOUND')
  return run
}

/** Reads one existing resource checkpoint or fails closed. */
async function requireResourceCheckpoint(
  state: RestoreDrillStateStore,
  drillId: string,
): Promise<RestoreDrillResourceCheckpoint> {
  const checkpoint = await state.readResourceCheckpoint(drillId)
  if (!checkpoint) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  return checkpoint
}

/** Creates the next revision after a complete state replacement. */
function incrementRun(run: RestoreDrillDurableRun): RestoreDrillDurableRun {
  return { ...run, revision: run.revision + 1 }
}

/** Creates one validated phase/outcome transition and increments its revision. */
function transitionRun(
  run: RestoreDrillDurableRun,
  phase: RestoreDrillRunPhase,
  outcome: RestoreDrillRunOutcome,
  updatedAt: string,
): RestoreDrillDurableRun {
  const terminal = phase === 'completed' || phase === 'failed'
  if (
    (terminal && outcome === 'in-progress') ||
    (!terminal && outcome !== 'in-progress') ||
    (phase === 'failed' && outcome !== 'fail')
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return incrementRun({ ...run, outcome, phase, updatedAt })
}

/** Creates a stable bounded continuation result. */
function pendingResult(
  drillId: string,
  waitSeconds = RESTORE_DRILL_POLL_WAIT_SECONDS,
): RestoreDrillAwsActionResult {
  return { drillId, status: 'pending', waitSeconds }
}

/** Creates a stable approval-wait result. */
function awaitingApprovalResult(run: RestoreDrillDurableRun): RestoreDrillAwsActionResult {
  return { drillId: run.drillId, status: 'awaiting-cleanup-approval' }
}

/** Maps an explicitly categorized caught error to a stable terminal failure category. */
function failureCodeForCaughtError(error: unknown): RestoreDrillFailureCode {
  if (error instanceof RestoreDrillFailure) return error.code
  if (error instanceof RestoreDrillAwsFailure) {
    switch (error.code) {
      case 'EXPORT_CHECKSUM_MISMATCH':
        return 'AGGREGATE_INVALID'
      case 'EXPORT_IDENTITY_MISMATCH':
      case 'RESTORE_IDENTITY_MISMATCH':
        return 'RESOURCE_IDENTITY_INVALID'
      case 'FILE_COPY_CHECKSUM_MISMATCH':
      case 'FILE_COPY_IDENTITY_MISMATCH':
      case 'FILE_COPY_METADATA_MISMATCH':
      case 'FILE_COPY_TAG_MISMATCH':
      case 'FILE_ROW_INVALID':
        return 'S3_VERSION_RESTORE_FAILED'
      case 'SOURCE_PITR_INVALID':
        return 'PITR_WINDOW_INVALID'
      case 'TABLE_DESCRIPTOR_INVALID':
        return 'AGGREGATE_DESCRIPTOR_MISMATCH'
      case 'AWS_RESPONSE_INVALID':
      case 'CHECKPOINT_INVALID':
      case 'CLEANUP_IDENTITY_MISMATCH':
      case 'CONFIGURATION_INVALID':
      case 'EXPORT_FAILED':
      case 'EXPORT_LIMIT_EXCEEDED':
      case 'RESTORE_START_FAILED':
      case 'UNEXPECTED_AWS_FAILURE':
        return 'WORKFLOW_TASK_FAILED'
      default:
        return assertUnreachable(error.code)
    }
  }
  return 'WORKFLOW_TASK_FAILED'
}

/** Recognizes the local stable optimistic-concurrency failure. */
function isConditionalConflict(error: unknown): boolean {
  return error instanceof RestoreDrillOrchestratorFailure && error.code === 'CONCURRENT_UPDATE'
}

/** Writes cleanup progress or reports the exact CAS conflict. */
async function writeCleanupProgressOrThrow(
  state: RestoreDrillStateStore,
  drillId: string,
  expected: RestoreDrillCleanupProgress,
  next: RestoreDrillCleanupProgress,
): Promise<void> {
  if (!(await state.writeCleanupProgress(drillId, expected, next))) {
    throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }
}

/**
 * Captures at most one export VersionId page and commits its cursor only after all versions.
 *
 * @param state - Durable state and checkpoint store.
 * @param operations - Exact paginated export listing primitive.
 * @param drillId - Stable drill identifier.
 * @param checkpoint - Exact recorded exports.
 * @returns Whether every export prefix was already or is now fully enumerated.
 */
async function captureNextExportListingPage(
  state: RestoreDrillStateStore,
  operations: Pick<RestoreDrillAwsOperations, 'listRecordedExportObjectVersionPage'>,
  drillId: string,
  checkpoint: RestoreDrillResourceCheckpoint,
): Promise<boolean> {
  for (const exportRecord of checkpoint.exports) {
    const listing = await state.readExportListingCheckpoint(drillId, exportRecord.target)
    if (listing.complete) continue
    const page = await operations.listRecordedExportObjectVersionPage(
      exportRecord,
      listing.cursor,
    )
    createRestoreDrillExportListingCheckpoint(
      listing,
      page.versions.length,
      page.nextCursor,
    )
    await state.writeExportListingPage(
      drillId,
      exportRecord.target,
      listing,
      page.versions,
      page.nextCursor,
    )
    return false
  }
  return true
}

/** Captures at most one run-prefix incomplete multipart-upload page. */
async function captureNextMultipartUploadListingPage(
  state: RestoreDrillStateStore,
  operations: Pick<RestoreDrillAwsOperations, 'listRecordedMultipartUploadPage'>,
  drillId: string,
): Promise<boolean> {
  const listing = await state.readMultipartUploadListingCheckpoint(drillId)
  if (listing.complete) return true
  const prefix = `restore-drill/${sha256Hex(`drill\0${drillId}`).slice(0, 16)}/`
  const page = await operations.listRecordedMultipartUploadPage(prefix, listing.cursor)
  createNextMultipartUploadListingCheckpoint(
    listing,
    page.uploads.length,
    page.nextCursor,
  )
  await state.writeMultipartUploadListingPage(
    drillId,
    listing,
    page.uploads,
    page.nextCursor,
  )
  return false
}

/** Calculates one bounded MPU listing checkpoint and rejects stalled pagination. */
function createNextMultipartUploadListingCheckpoint(
  expected: RestoreDrillMultipartUploadListingCheckpoint,
  pageUploadCount: number,
  nextCursor?: RestoreDrillMultipartUploadCursor,
): RestoreDrillMultipartUploadListingCheckpoint {
  if (
    expected.complete ||
    !isNonNegativeInteger(expected.pageCount) ||
    !isNonNegativeInteger(expected.uploadCount) ||
    !isNonNegativeInteger(pageUploadCount) ||
    pageUploadCount > 1_000 ||
    !Number.isSafeInteger(expected.pageCount + 1) ||
    !Number.isSafeInteger(expected.uploadCount + pageUploadCount) ||
    (nextCursor !== undefined &&
      stableJson(nextCursor) === stableJson(expected.cursor))
  ) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  return {
    complete: nextCursor === undefined,
    ...(nextCursor ? { cursor: nextCursor } : {}),
    pageCount: expected.pageCount + 1,
    started: true,
    uploadCount: expected.uploadCount + pageUploadCount,
  }
}

/** Reconciles at most one external start whose pre-API attempted marker is durable. */
async function reconcileNextAttemptedStartIntent(
  state: RestoreDrillStateStore,
  operations: Pick<RestoreDrillAwsOperations, 'startTableExport' | 'startTableRestore'>,
  drillId: string,
): Promise<boolean> {
  const intents = await state.listStartIntents(drillId)
  for (const intent of intents) {
    if (intent.restoreAttempted && !intent.restoreRecord) {
      const table = (await operations.startTableRestore({
        drillId,
        restorePoint: intent.restorePoint,
        source: intent.source,
      })).table
      await state.recordStartedRestore(drillId, intent.target, table)
      return false
    }
    if (intent.exportAttempted && !intent.exportRecord) {
      const exportRecord = await operations.startTableExport({
        drillId,
        exportPoint: intent.restorePoint,
        source: intent.source,
      })
      await state.recordStartedExport(drillId, intent.target, exportRecord)
      return false
    }
  }
  return true
}

/** Synchronizes reconciled start identities into the resource cleanup checkpoint. */
async function synchronizeResourceCheckpointFromStartIntents(
  state: RestoreDrillStateStore,
  drillId: string,
): Promise<void> {
  const checkpoint = await state.readResourceCheckpoint(drillId)
  if (!checkpoint) return
  const intents = await state.listStartIntents(drillId)
  if (intents.length === 0) return
  const restores: RestoreDrillRecordedRestoreTable[] = []
  const exports: RestoreDrillRecordedExport[] = []
  for (const target of RESTORE_DRILL_TABLE_TARGETS) {
    const intent = intents.find((candidate) => candidate.target === target)
    if (!intent) break
    if (intent.restoreRecord) restores.push(intent.restoreRecord)
    if (intent.exportRecord) exports.push(intent.exportRecord)
    if (!intent.restoreRecord || !intent.exportRecord) break
  }
  const next = { ...checkpoint, exports, restores }
  if (stableJson(next) !== stableJson(checkpoint)) {
    await state.writeResourceCheckpoint(drillId, next)
  }
}

/**
 * Advances one bounded pure two-pass post-baseline CopyObject reconciliation page.
 *
 * @param state - Durable state and append-only cleanup ledger.
 * @param operations - Pure scratch VersionId re-list and digest-key operations.
 * @param run - Exact run whose runner work has stopped.
 * @param now - Injected canonical clock.
 * @returns Required wait seconds, or undefined once reconciliation is complete.
 */
async function advanceFinalCopyReconciliation(
  state: RestoreDrillStateStore,
  operations: Pick<
    RestoreDrillAwsOperations,
    'reconcileCreatedFileVersions' | 'withDigestKey'
  >,
  run: RestoreDrillDurableRun,
  now: () => Date,
): Promise<number | undefined> {
  if (!run.digestKeyEnvelope || !run.verificationCompletedAt) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const checkpoint = await state.readCopyReconciliationCheckpoint(run.drillId)
  if (checkpoint.complete) return undefined
  const observedAt = canonicalNow(now)
  if (
    checkpoint.pass === 2 && checkpoint.quietUntil &&
    Date.parse(observedAt) < Date.parse(checkpoint.quietUntil)
  ) return RESTORE_DRILL_POLL_WAIT_SECONDS
  const page = await state.readCopyIntentInventoryPage(
    run.drillId,
    checkpoint.cursor,
    CLEANUP_BATCH_SIZE,
  )
  const reconciled: Array<{
    readonly cursor: string
    readonly intent: RestoreDrillCopyIntent
  }> = []
  for (const entry of page.entries) {
    const latest = entry.intent.copyClaim &&
        Date.parse(observedAt) <
          Math.max(
            Date.parse(entry.intent.copyClaim.claimedAt),
            Date.parse(run.verificationCompletedAt),
          ) + COPY_CLAIM_GRACE_MILLISECONDS
      ? undefined
      : await operations.reconcileCreatedFileVersions({
          drillId: run.drillId,
          preexistingScratchVersionIds: entry.intent.preexistingScratchVersionIds,
          source: entry.intent.source,
        })
    if (!latest) return RESTORE_DRILL_POLL_WAIT_SECONDS
    const intent = await state.reconcileCopyIntentVersions(
      run.drillId,
      entry.intent.intentDigest,
      latest,
    )
    reconciled.push({ cursor: entry.cursor, intent })
  }
  const nextIntentCount = checkpoint.intentCount + reconciled.length
  const nextCreatedCopyCount = checkpoint.createdCopyCount + reconciled.reduce(
    (count, entry) => count + (entry.intent.createdCopies?.length ?? 0),
    0,
  )
  const currentDigest = await operations.withDigestKey(
    run.drillId,
    run.digestKeyEnvelope,
    async (digestKey) => foldCopyReconciliationPage(
      digestKey,
      checkpoint.currentDigest,
      checkpoint.intentCount,
      reconciled,
    ),
  )
  const lastCursor = reconciled.at(-1)?.cursor ?? checkpoint.cursor
  if (page.nextCursor) {
    if (!lastCursor || page.nextCursor !== lastCursor) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const next: RestoreDrillCopyReconciliationCheckpoint = {
      complete: false,
      createdCopyCount: nextCreatedCopyCount,
      currentDigest,
      cursor: page.nextCursor,
      intentCount: nextIntentCount,
      pass: checkpoint.pass,
      ...(checkpoint.passDigest ? { passDigest: checkpoint.passDigest } : {}),
      ...(checkpoint.quietUntil ? { quietUntil: checkpoint.quietUntil } : {}),
      started: true,
      ...(checkpoint.terminalCursor
        ? { terminalCursor: checkpoint.terminalCursor }
        : {}),
    }
    if (!(await state.writeCopyReconciliationCheckpoint(run.drillId, checkpoint, next))) {
      throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
    }
    return 0
  }
  const passDigest = await operations.withDigestKey(
    run.drillId,
    run.digestKeyEnvelope,
    async (digestKey) => sealCopyReconciliationPass(
      digestKey,
      currentDigest,
      nextIntentCount,
      nextCreatedCopyCount,
      lastCursor,
    ),
  )
  if (checkpoint.pass === 1) {
    const next: RestoreDrillCopyReconciliationCheckpoint = {
      complete: false,
      createdCopyCount: 0,
      intentCount: 0,
      pass: 2,
      passDigest,
      quietUntil: new Date(
        Date.parse(observedAt) + COPY_CLAIM_GRACE_MILLISECONDS,
      ).toISOString(),
      started: true,
      ...(lastCursor ? { terminalCursor: lastCursor } : {}),
    }
    if (!(await state.writeCopyReconciliationCheckpoint(run.drillId, checkpoint, next))) {
      throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
    }
    return RESTORE_DRILL_POLL_WAIT_SECONDS
  }
  if (
    passDigest !== checkpoint.passDigest ||
    lastCursor !== checkpoint.terminalCursor
  ) {
    const restart: RestoreDrillCopyReconciliationCheckpoint = {
      complete: false,
      createdCopyCount: 0,
      intentCount: 0,
      pass: 1,
      started: true,
    }
    if (!(await state.writeCopyReconciliationCheckpoint(
      run.drillId,
      checkpoint,
      restart,
    ))) {
      throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
    }
    return 0
  }
  const complete: RestoreDrillCopyReconciliationCheckpoint = {
    complete: true,
    createdCopyCount: nextCreatedCopyCount,
    currentDigest: passDigest,
    intentCount: nextIntentCount,
    pass: 2,
    passDigest,
    quietUntil: checkpoint.quietUntil ?? observedAt,
    started: true,
    ...(lastCursor ? { terminalCursor: lastCursor } : {}),
  }
  if (!(await state.writeCopyReconciliationCheckpoint(
    run.drillId,
    checkpoint,
    complete,
  ))) {
    throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }
  return undefined
}

/** Folds one bounded CopyObject reconciliation page into a keyed digest chain. */
function foldCopyReconciliationPage(
  digestKey: Uint8Array,
  priorDigest: string | undefined,
  priorIntentCount: number,
  entries: readonly {
    readonly cursor: string
    readonly intent: RestoreDrillCopyIntent
  }[],
): string {
  let digest = priorDigest ?? createHmac('sha256', digestKey)
    .update('mukuroji-restore-drill-copy-reconciliation-start-v1\0', 'utf8')
    .digest('hex')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    digest = createHmac('sha256', digestKey)
      .update('mukuroji-restore-drill-copy-reconciliation-item-v1\0', 'utf8')
      .update(digest, 'utf8')
      .update('\0', 'utf8')
      .update(String(priorIntentCount + index), 'utf8')
      .update('\0', 'utf8')
      .update(entry.cursor, 'utf8')
      .update('\0', 'utf8')
      .update(stableJson({
        createdCopies: entry.intent.createdCopies ?? [],
        intentDigest: entry.intent.intentDigest,
      }), 'utf8')
      .digest('hex')
  }
  return digest
}

/** Seals one complete reconciliation pass with counts and its terminal cursor. */
function sealCopyReconciliationPass(
  digestKey: Uint8Array,
  currentDigest: string,
  intentCount: number,
  createdCopyCount: number,
  terminalCursor: string | undefined,
): string {
  return createHmac('sha256', digestKey)
    .update('mukuroji-restore-drill-copy-reconciliation-seal-v1\0', 'utf8')
    .update(currentDigest, 'utf8')
    .update('\0', 'utf8')
    .update(stableJson({ createdCopyCount, intentCount, terminalCursor: terminalCursor ?? null }), 'utf8')
    .digest('hex')
}

/**
 * Merges one pure post-baseline re-list into a durable CopyObject intent.
 *
 * @param intent - Current strict durable intent.
 * @param discovered - Exact versions observed by the final pure re-list.
 * @param drillId - Stable drill identifier binding every destination identity.
 * @returns Canonical superset retaining the originally selected verification copy.
 */
function mergeCopyIntentVersions(
  intent: RestoreDrillCopyIntent,
  discovered: readonly RestoreDrillCreatedScratchObjectVersion[],
  drillId: string,
): RestoreDrillCopyIntent {
  const drillDigest = sha256Hex(`drill\0${requireDrillId(drillId)}`).slice(0, 16)
  const byVersionId = new Map<string, RestoreDrillCreatedScratchObjectVersion>()
  for (const copy of [...(intent.createdCopies ?? []), ...discovered]) {
    if (
      copy.kind !== 'scratch-object-version' ||
      copy.drillDigest !== drillDigest ||
      copy.objectKey !== intent.source.objectKey ||
      copy.versionId !== intent.source.versionId ||
      intent.preexistingScratchVersionIds.includes(copy.objectVersionId)
    ) {
      throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
    }
    const existing = byVersionId.get(copy.objectVersionId)
    if (existing && stableJson(existing) !== stableJson(copy)) {
      throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
    }
    byVersionId.set(copy.objectVersionId, copy)
  }
  const createdCopies = [...byVersionId.values()].sort(compareCreatedScratchVersions)
  if (createdCopies.length === 0) return intent
  const selectedCopy = intent.selectedCopy ?? createdCopies[0]
  if (!selectedCopy || !createdCopies.some((copy) =>
    sameCreatedScratchVersion(copy, selectedCopy)
  )) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return {
    ...(intent.completedCopy ? { completedCopy: intent.completedCopy } : {}),
    createdCopies,
    intentDigest: intent.intentDigest,
    preexistingScratchVersionIds: intent.preexistingScratchVersionIds,
    selectedCopy,
    source: intent.source,
  }
}

/** Creates a deterministic opaque copy-intent key. */
function createCopyIntentDigest(source: RestoreDrillSourceFileVersion): string {
  return createHash('sha256')
    .update('mukuroji-restore-drill-copy-intent-v1\0', 'utf8')
    .update(source.versionId, 'utf8')
    .update('\0', 'utf8')
    .update(source.objectKey, 'utf8')
    .update('\0', 'utf8')
    .update(source.objectVersionId, 'utf8')
    .digest('hex')
}

/**
 * Advances one constant-memory authenticated cleanup-scope ledger page.
 *
 * @param state - Durable ordered cleanup ledger and sealing checkpoints.
 * @param operations - Digest-key boundary.
 * @param run - Exact run whose inventory is terminal.
 * @param checkpoint - Exact source, restore, and export identities.
 * @returns Complete scope checkpoint or undefined when another page is required.
 */
async function advanceCleanupScopeSeal(
  state: RestoreDrillStateStore,
  operations: Pick<RestoreDrillAwsOperations, 'withDigestKey'>,
  run: RestoreDrillDurableRun,
  checkpoint: RestoreDrillResourceCheckpoint | undefined,
): Promise<RestoreDrillCleanupScopeCheckpoint | undefined> {
  if (!run.digestKeyEnvelope) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const copyReconciliation = await state.readCopyReconciliationCheckpoint(run.drillId)
  if (!copyReconciliation.complete || !copyReconciliation.currentDigest) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  validateCleanupStaticBindings(run, checkpoint)
  const current = await state.readCleanupScopeCheckpoint(run.drillId)
  if (current.complete) return current
  const page = await state.readCleanupInventoryPage(
    run.drillId,
    current.cursor,
    CLEANUP_SCOPE_SEAL_PAGE_SIZE,
  )
  for (const entry of page.entries) {
    validateCleanupTargetBinding(run, checkpoint, entry.target)
  }
  const counts = countCleanupTargets(current, page.entries)
  const rollingDigest = await operations.withDigestKey(
    run.drillId,
    run.digestKeyEnvelope,
    async (digestKey) => foldCleanupScopePage(
      digestKey,
      current.rollingDigest,
      cleanupScopeStaticHeader(checkpoint, copyReconciliation),
      current.tableCount + current.fileObjectCount +
        current.exportObjectCount + current.multipartUploadCount,
      page.entries,
    ),
  )
  const lastCursor = page.entries.at(-1)?.cursor ?? current.cursor
  if (page.nextCursor) {
    if (!lastCursor || page.nextCursor !== lastCursor) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const next: RestoreDrillCleanupScopeCheckpoint = {
      complete: false,
      cursor: page.nextCursor,
      ...counts,
      rollingDigest,
      started: true,
    }
    if (!(await state.writeCleanupScopeCheckpoint(run.drillId, current, next))) {
      throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
    }
    return undefined
  }
  const ledger = await state.readCleanupLedgerControl(run.drillId)
  const totalCount = counts.tableCount + counts.fileObjectCount +
    counts.exportObjectCount + counts.multipartUploadCount
  const exportObjectCount = await expectedExportObjectCount(
    state,
    run.drillId,
    checkpoint,
  )
  const multipartUploadCount = (
    await state.readMultipartUploadListingCheckpoint(run.drillId)
  ).uploadCount
  if (
    counts.tableCount !== (checkpoint?.restores.length ?? 0) ||
    counts.fileObjectCount !== copyReconciliation.createdCopyCount ||
    counts.exportObjectCount !== exportObjectCount ||
    counts.multipartUploadCount !== multipartUploadCount ||
    ledger.count !== totalCount
  ) {
    throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
  }
  const resourceDigest = await operations.withDigestKey(
    run.drillId,
    run.digestKeyEnvelope,
    async (digestKey) => createHmac('sha256', digestKey)
      .update('mukuroji-restore-drill-cleanup-scope-seal-v2\0', 'utf8')
      .update(rollingDigest, 'utf8')
      .update('\0', 'utf8')
      .update(stableJson({
        ...counts,
        copyReconciliationDigest: copyReconciliation.currentDigest,
        copyReconciliationTerminalCursor:
          copyReconciliation.terminalCursor ?? null,
        ledger,
        terminalCursor: lastCursor ?? null,
      }), 'utf8')
      .digest('hex'),
  )
  const complete: RestoreDrillCleanupScopeCheckpoint = {
    complete: true,
    ...counts,
    ledgerCount: ledger.count,
    ledgerRevision: ledger.revision,
    resourceDigest,
    rollingDigest,
    started: true,
    ...(lastCursor ? { terminalCursor: lastCursor } : {}),
  }
  if (!(await state.writeCleanupScopeCheckpoint(run.drillId, current, complete))) {
    throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }
  return complete
}

/** Reads the exact sum of complete export-listing object counts. */
async function expectedExportObjectCount(
  state: RestoreDrillStateStore,
  drillId: string,
  checkpoint: RestoreDrillResourceCheckpoint | undefined,
): Promise<number> {
  let count = 0
  for (const record of checkpoint?.exports ?? []) {
    const listing = await state.readExportListingCheckpoint(drillId, record.target)
    if (!listing.complete || !Number.isSafeInteger(count + listing.objectCount)) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    count += listing.objectCount
  }
  return count
}

/** Creates the small static header mixed into every cleanup-scope page chain. */
function cleanupScopeStaticHeader(
  checkpoint: RestoreDrillResourceCheckpoint | undefined,
  copyReconciliation: RestoreDrillCopyReconciliationCheckpoint,
): Readonly<Record<string, unknown>> {
  return {
    copyReconciliationDigest: copyReconciliation.currentDigest ?? null,
    copyReconciliationTerminalCursor: copyReconciliation.terminalCursor ?? null,
    exportRecords: [...(checkpoint?.exports ?? [])]
      .sort(compareRecordedExports)
      .map((record) => ({
        clientToken: record.clientToken,
        exportArn: record.exportArn,
        exportPoint: record.exportPoint,
        kind: record.kind,
        scratchPrefix: record.scratchPrefix,
        sourceTableArn: record.sourceTableArn,
        sourceTableId: record.sourceTableId,
        target: record.target,
      })),
  }
}

/** Folds one ordered cleanup-ledger page into a constant-size keyed chain. */
function foldCleanupScopePage(
  digestKey: Uint8Array,
  priorDigest: string | undefined,
  staticHeader: Readonly<Record<string, unknown>>,
  priorCount: number,
  entries: readonly RestoreDrillCleanupInventoryEntry[],
): string {
  let digest = priorDigest ?? createHmac('sha256', digestKey)
    .update('mukuroji-restore-drill-cleanup-scope-start-v2\0', 'utf8')
    .update(stableJson(staticHeader), 'utf8')
    .digest('hex')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    digest = createHmac('sha256', digestKey)
      .update('mukuroji-restore-drill-cleanup-scope-item-v2\0', 'utf8')
      .update(digest, 'utf8')
      .update('\0', 'utf8')
      .update(String(priorCount + index), 'utf8')
      .update('\0', 'utf8')
      .update(entry.cursor, 'utf8')
      .update('\0', 'utf8')
      .update(entry.target.kind, 'utf8')
      .update('\0', 'utf8')
      .update(stableJson(entry.target), 'utf8')
      .digest('hex')
  }
  return digest
}

/** Adds one bounded page of cleanup targets to its exact per-kind counts. */
function countCleanupTargets(
  current: RestoreDrillCleanupScopeCheckpoint,
  entries: readonly RestoreDrillCleanupInventoryEntry[],
): Pick<
  RestoreDrillCleanupScopeCheckpoint,
  'exportObjectCount' | 'fileObjectCount' | 'multipartUploadCount' | 'tableCount'
> {
  let exportObjectCount = current.exportObjectCount
  let fileObjectCount = current.fileObjectCount
  let multipartUploadCount = current.multipartUploadCount
  let tableCount = current.tableCount
  for (const { target } of entries) {
    switch (target.kind) {
      case 'restore-table':
        tableCount += 1
        break
      case 'scratch-object-version':
        fileObjectCount += 1
        break
      case 'export-object-version':
        exportObjectCount += 1
        break
      case 'scratch-multipart-upload':
        multipartUploadCount += 1
        break
      default:
        assertUnreachable(target)
    }
  }
  if (
    !Number.isSafeInteger(exportObjectCount) ||
    !Number.isSafeInteger(fileObjectCount) ||
    !Number.isSafeInteger(multipartUploadCount) ||
    !Number.isSafeInteger(tableCount)
  ) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  return { exportObjectCount, fileObjectCount, multipartUploadCount, tableCount }
}

/** Validates one ledger target against immutable run-owned resource identities. */
function validateCleanupTargetBinding(
  run: RestoreDrillDurableRun,
  checkpoint: RestoreDrillResourceCheckpoint | undefined,
  target: RestoreDrillCleanupTarget,
): void {
  const drillDigest = sha256Hex(`drill\0${run.drillId}`).slice(0, 16)
  switch (target.kind) {
    case 'restore-table': {
      const source = checkpoint?.sources.find((candidate) =>
        candidate.target === target.target
      )
      const logicalName = target.target.slice('table:'.length)
      if (
        (checkpoint !== undefined && (
          !source || target.sourceTableArn !== source.sourceTableArn
        )) ||
        target.restorePoint !== run.restorePoint ||
        !target.tableName.endsWith(`-${drillDigest}-${logicalName}`) ||
        !target.tableArn.endsWith(`:table/${target.tableName}`)
      ) throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
      return
    }
    case 'scratch-object-version':
      if (
        target.drillDigest !== drillDigest ||
        !target.objectKey.startsWith('workspaces/') ||
        !isRestoreDrillObjectKeyPathSafe(target.objectKey)
      ) throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
      return
    case 'export-object-version': {
      const record = checkpoint?.exports.find((candidate) =>
        sha256Hex(`export-arn\0${candidate.exportArn}`) === target.exportArnDigest
      )
      const drillRoot = `restore-drill/${drillDigest}/`
      const deterministicPrefix = RESTORE_DRILL_TABLE_TARGETS.some(
        (candidate) => target.scratchPrefix === `${drillRoot}${candidate}/export`,
      )
      if (
        (checkpoint !== undefined && (
          !record || target.scratchPrefix !== record.scratchPrefix
        )) ||
        !deterministicPrefix ||
        !target.objectKey.startsWith(`${target.scratchPrefix}/`) ||
        !isRestoreDrillObjectKeyPathSafe(target.objectKey)
      ) throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
      return
    }
    case 'scratch-multipart-upload':
      if (
        !target.objectKey.startsWith(`restore-drill/${drillDigest}/`) ||
        !isRestoreDrillObjectKeyPathSafe(target.objectKey)
      ) throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
      return
    default:
      assertUnreachable(target)
  }
}

/** Validates the small non-deletable export-operation header bound into the scope. */
function validateCleanupStaticBindings(
  run: RestoreDrillDurableRun,
  checkpoint: RestoreDrillResourceCheckpoint | undefined,
): void {
  const drillDigest = sha256Hex(`drill\0${run.drillId}`).slice(0, 16)
  for (const record of checkpoint?.exports ?? []) {
    const source = checkpoint?.sources.find((candidate) => candidate.target === record.target)
    const expectedPrefix = `restore-drill/${drillDigest}/${record.target}/export`
    const expectedToken = sha256Hex(
      `export\0${run.drillId}\0${record.target}\0${record.exportPoint}`,
    )
    if (
      !source || record.sourceTableArn !== source.sourceTableArn ||
      record.sourceTableId !== source.descriptor.tableId ||
      record.exportPoint !== run.restorePoint ||
      record.scratchPrefix !== expectedPrefix ||
      record.clientToken !== expectedToken ||
      !record.exportArn.startsWith(`${record.sourceTableArn}/export/`)
    ) throw new RestoreDrillOrchestratorFailure('CLEANUP_TARGET_INVALID')
  }
}

/** Executes one exact idempotent cleanup target operation. */
async function deleteCleanupTarget(
  operations: RestoreDrillCleanupOperations,
  target: RestoreDrillCleanupTarget,
  drillId: string,
): Promise<boolean> {
  switch (target.kind) {
    case 'restore-table':
      return (await operations.deleteRecordedRestoreTable(target, drillId)).status === 'pending'
    case 'scratch-object-version':
      await operations.deleteRecordedScratchObjectVersion(target, drillId)
      return false
    case 'export-object-version':
      await operations.deleteRecordedExportObjectVersion(target, drillId)
      return false
    case 'scratch-multipart-upload':
      return (await operations.abortRecordedMultipartUpload(target, drillId)).status === 'pending'
    default:
      return assertUnreachable(target)
  }
}

/** Maps one strict cleanup target to the keyed receipt discriminator. */
function cleanupReceiptTargetKind(
  target: RestoreDrillCleanupTarget,
): 'export-object-version' | 'file-object-version' | 'multipart-upload' | 'restore-table' {
  switch (target.kind) {
    case 'restore-table':
      return 'restore-table'
    case 'scratch-object-version':
      return 'file-object-version'
    case 'export-object-version':
      return 'export-object-version'
    case 'scratch-multipart-upload':
      return 'multipart-upload'
    default:
      return assertUnreachable(target)
  }
}

/** Advances one exact cleanup target and its authenticated absence chain. */
function incrementCleanupProgress(
  progress: RestoreDrillCleanupProgress,
  entry: RestoreDrillCleanupInventoryEntry,
  absenceDigest: string,
): RestoreDrillCleanupProgress {
  const common = {
    ...progress,
    ...appendCleanupAbsenceReceipt(progress, absenceDigest),
    targetCursor: entry.cursor,
  }
  switch (entry.target.kind) {
    case 'restore-table':
      return { ...common, tableIndex: progress.tableIndex + 1 }
    case 'scratch-object-version':
      return { ...common, fileObjectIndex: progress.fileObjectIndex + 1 }
    case 'export-object-version':
      return { ...common, exportObjectIndex: progress.exportObjectIndex + 1 }
    case 'scratch-multipart-upload':
      return { ...common, multipartUploadIndex: progress.multipartUploadIndex + 1 }
    default:
      return assertUnreachable(entry.target)
  }
}

/** Calculates one identity-bound keyed absence receipt after exact deletion reconciliation. */
async function calculateCleanupAbsenceReceiptDigest(
  operations: Pick<RestoreDrillAwsOperations, 'withDigestKey'>,
  run: RestoreDrillDurableRun,
  targetKind:
    | 'export-object-version'
    | 'file-object-version'
    | 'multipart-upload'
    | 'restore-table',
  targetIndex: number,
  target: RestoreDrillRecordedExportObjectVersion |
    RestoreDrillRecordedMultipartUpload |
    RestoreDrillRecordedRestoreTable |
    RestoreDrillCreatedScratchObjectVersion,
): Promise<string> {
  if (!run.digestKeyEnvelope) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return operations.withDigestKey(
    run.drillId,
    run.digestKeyEnvelope,
    async (digestKey) => createHmac('sha256', digestKey)
      .update('mukuroji-restore-drill-cleanup-absence-receipt-v1\0', 'utf8')
      .update(stableJson({ target, targetIndex, targetKind }), 'utf8')
      .digest('hex'),
  )
}

/**
 * Appends one keyed absence receipt to a constant-size order- and count-bound chain.
 *
 * @param progress - Current durable cleanup progress.
 * @param receiptDigest - Exact keyed receipt for the next canonical target.
 * @returns Updated bounded receipt-chain fields.
 */
function appendCleanupAbsenceReceipt(
  progress: RestoreDrillCleanupProgress,
  receiptDigest: string,
): Pick<
  RestoreDrillCleanupProgress,
  'absenceReceiptCount' | 'absenceReceiptDigest'
> {
  if (!isHexDigest(receiptDigest)) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const nextCount = progress.absenceReceiptCount + 1
  const nextDigest = createHash('sha256')
    .update('mukuroji-restore-drill-absence-chain-v1\0', 'utf8')
    .update(String(nextCount), 'utf8')
    .update('\0', 'utf8')
    .update(progress.absenceReceiptDigest ?? 'genesis', 'utf8')
    .update('\0', 'utf8')
    .update(receiptDigest, 'utf8')
    .digest('hex')
  return { absenceReceiptCount: nextCount, absenceReceiptDigest: nextDigest }
}

/** Calculates a domain-separated fallback artifact digest. */
function keyedArtifactDigest(
  artifact: RestoreDrillEvidenceArtifact,
  digestKey: Uint8Array,
): string {
  return createHmac('sha256', digestKey)
    .update('mukuroji-restore-drill-operational-failure-v1\0', 'utf8')
    .update(stableJson(artifact), 'utf8')
    .digest('hex')
}

/** Creates the immutable result evidence key. */
function resultEvidenceKey(drillId: string): string {
  return `${RESULT_EVIDENCE_PREFIX}${drillId}/result.json`
}

/** Creates the immutable cleanup evidence key. */
function cleanupEvidenceKey(drillId: string): string {
  return `${RESULT_EVIDENCE_PREFIX}${drillId}/cleanup.json`
}

/** Classifies only data-integrity failures that contribute to the integrity alarm. */
export function isRestoreDrillIntegrityFailureCode(
  failureCode: RestoreDrillFailureCode,
): boolean {
  switch (failureCode) {
    case 'AGGREGATE_CONTENT_MISMATCH':
    case 'AGGREGATE_DESCRIPTOR_MISMATCH':
    case 'AGGREGATE_INVALID':
    case 'AGGREGATE_KEY_MISMATCH':
    case 'AGGREGATE_METADATA_MISMATCH':
    case 'AGGREGATE_PARTITION_COUNT_MISMATCH':
    case 'AGGREGATE_RECORD_COUNT_MISMATCH':
    case 'AGGREGATE_RESOURCE_MISMATCH':
    case 'AGGREGATE_RESTORE_POINT_MISMATCH':
    case 'AGGREGATE_ROLE_MISMATCH':
    case 'CROSS_DOMAIN_INTEGRITY_FAILED':
    case 'S3_VERSION_RESTORE_FAILED':
      return true
    case 'APPROVAL_APPROVER_UNAUTHORIZED':
    case 'APPROVAL_AUTHENTICATION_FAILED':
    case 'APPROVAL_CHANGE_MISMATCH':
    case 'APPROVAL_DRILL_MISMATCH':
    case 'APPROVAL_EXPIRED':
    case 'APPROVAL_NOT_YET_VALID':
    case 'APPROVAL_POLICY_MISMATCH':
    case 'APPROVAL_RECEIPT_INVALID':
    case 'APPROVAL_RESOURCE_MISMATCH':
    case 'APPROVAL_RESULT_MISMATCH':
    case 'CADENCE_OVERDUE':
    case 'CLEANUP_CONTEXT_INVALID':
    case 'CLEANUP_FAILED':
    case 'DIGEST_DOMAIN_INVALID':
    case 'DIGEST_KEY_INVALID':
    case 'DYNAMODB_RESTORE_FAILED':
    case 'EVIDENCE_INVALID':
    case 'EVIDENCE_PERSIST_FAILED':
    case 'OBJECTIVE_TIMELINE_INVALID':
    case 'PITR_WINDOW_INVALID':
    case 'PITR_WINDOW_NO_OVERLAP':
    case 'PITR_WINDOW_TARGET_MISMATCH':
    case 'RESOURCE_IDENTITY_INVALID':
    case 'RPO_TARGET_MISSED':
    case 'RTO_TARGET_MISSED':
    case 'RUN_STATE_INVALID':
    case 'WORKFLOW_POLL_BUDGET_EXCEEDED':
    case 'WORKFLOW_TASK_FAILED':
      return false
    default:
      return assertUnreachable(failureCode)
  }
}

/** Returns unique lexically sorted failure codes. */
function canonicalFailureCodes(
  values: readonly RestoreDrillFailureCode[],
): RestoreDrillFailureCode[] {
  return [...new Set(values)].sort()
}

/** Sorts exact export operations for deterministic approval scope binding. */
function compareRecordedExports(
  left: RestoreDrillRecordedExport,
  right: RestoreDrillRecordedExport,
): number {
  return `${left.target}\0${left.exportArn}\0${left.scratchPrefix}`.localeCompare(
    `${right.target}\0${right.exportArn}\0${right.scratchPrefix}`,
  )
}

/** Sorts exact File-copy versions for deterministic cleanup. */
function compareScratchVersions(
  left: RestoreDrillCreatedScratchObjectVersion,
  right: RestoreDrillCreatedScratchObjectVersion,
): number {
  return `${left.objectKey}\0${left.objectVersionId}`.localeCompare(
    `${right.objectKey}\0${right.objectVersionId}`,
  )
}

/** Sorts exact created File-copy identities for deterministic cleanup. */
function compareCreatedScratchVersions(
  left: RestoreDrillCreatedScratchObjectVersion,
  right: RestoreDrillCreatedScratchObjectVersion,
): number {
  return compareScratchVersions(left, right)
}

/** Sorts exact export object versions for deterministic cleanup. */
function compareExportVersions(
  left: RestoreDrillRecordedExportObjectVersion,
  right: RestoreDrillRecordedExportObjectVersion,
): number {
  return `${left.objectKey}\0${left.objectVersionId}`.localeCompare(
    `${right.objectKey}\0${right.objectVersionId}`,
  )
}

/** Sorts exact incomplete multipart uploads for deterministic cleanup. */
function compareMultipartUploads(
  left: RestoreDrillRecordedMultipartUpload,
  right: RestoreDrillRecordedMultipartUpload,
): number {
  return `${left.objectKey}\0${left.uploadId}`.localeCompare(
    `${right.objectKey}\0${right.uploadId}`,
  )
}

/** Creates one digest-only ordered cleanup-ledger sort key. */
function cleanupTargetRecordKey(target: RestoreDrillCleanupTarget): string {
  const order = cleanupTargetKindOrder(target)
  return `CLEANUP_TARGET#${order}#${sha256Hex(stableJson(target))}`
}

/** Returns the fixed deletion order for one strict cleanup target. */
function cleanupTargetKindOrder(target: RestoreDrillCleanupTarget): number {
  switch (target.kind) {
    case 'restore-table':
      return 0
    case 'scratch-object-version':
      return 1
    case 'export-object-version':
      return 2
    case 'scratch-multipart-upload':
      return 3
    default:
      return assertUnreachable(target)
  }
}

/** Checks one opaque digest-only cleanup-ledger cursor. */
function isCleanupTargetCursor(value: unknown): value is string {
  return typeof value === 'string' && /^CLEANUP_TARGET#[0-3]#[a-f0-9]{64}$/.test(value)
}

/** Checks one opaque digest-only CopyObject-intent cursor. */
function isCopyIntentCursor(value: unknown): value is string {
  return typeof value === 'string' && /^COPY_INTENT#[a-f0-9]{64}$/.test(value)
}

/** Checks two ordered string vectors for exact equality. */
function sameStringVector(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Produces deterministic JSON by recursively sorting record keys. */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

/** Recursively sorts JSON-compatible record keys. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) result[key] = sortJsonValue(value[key])
  return result
}

/** Reads a non-null untrusted record. */
function requireRecord(
  value: unknown,
  code: RestoreDrillOrchestratorFailureCode,
): Record<string, unknown> {
  if (!isRecord(value)) throw new RestoreDrillOrchestratorFailure(code)
  return value
}

/** Checks whether a value is a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Enforces exhaustive control flow. */
function assertUnreachable(value: never): never {
  void value
  throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
}

/** S3-backed append-only compliance evidence store with response-loss reconciliation. */
export class AwsRestoreDrillEvidenceStore implements RestoreDrillEvidenceStore {
  /** Expected owner account for the protected evidence bucket. */
  private readonly accountId: string

  /** Protected Object-Lock evidence bucket name. */
  private readonly bucketName: string

  /** Customer-managed key required on every evidence object. */
  private readonly kmsKeyArn: string

  /** Official S3 client owned by this adapter. */
  private readonly s3: S3Client

  /**
   * Creates an immutable evidence adapter over explicit protected resources.
   *
   * @param configuration - Validated evidence bucket, KMS key, account, and Region.
   */
  constructor(configuration: Pick<
    RestoreDrillAwsConfiguration,
    'accountId' | 'evidenceBucketName' | 'evidenceKmsKeyArn' | 'region'
  >) {
    this.accountId = configuration.accountId
    this.bucketName = configuration.evidenceBucketName
    this.kmsKeyArn = configuration.evidenceKmsKeyArn
    this.s3 = new S3Client({ region: configuration.region })
  }

  /** Releases the underlying S3 client. */
  close(): void {
    this.s3.destroy()
  }

  /** @inheritdoc */
  async putImmutable(
    objectKey: string,
    artifact: RestoreDrillEvidenceArtifact,
  ): Promise<RestoreDrillEvidenceWriteResult> {
    return this.putImmutablePinned(
      objectKey,
      stableJson(artifact),
      evidenceRetentionReferenceAt(artifact),
    )
  }

  /** @inheritdoc */
  async putImmutablePinned(
    objectKey: string,
    artifactJson: string,
    retentionReferenceAt: string,
  ): Promise<RestoreDrillEvidenceWriteResult> {
    if (!isEvidenceObjectKey(objectKey)) {
      throw new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(artifactJson)
    } catch {
      throw new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED')
    }
    if (
      !isCanonicalTimestamp(retentionReferenceAt) ||
      Buffer.byteLength(artifactJson, 'utf8') > 350_000 ||
      stableJson(parsed) !== artifactJson ||
      readPinnedEvidenceRetentionReferenceAt(parsed) !== retentionReferenceAt
    ) throw new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED')
    const body = Buffer.from(artifactJson, 'utf8')
    const checksumSha256 = createHash('sha256').update(body).digest('base64')
    let putVersionId: string | undefined
    try {
      const output = await this.s3.send(new PutObjectCommand({
        Body: body,
        Bucket: this.bucketName,
        ChecksumAlgorithm: 'SHA256',
        ChecksumSHA256: checksumSha256,
        ContentType: 'application/json',
        ExpectedBucketOwner: this.accountId,
        IfNoneMatch: '*',
        Key: objectKey,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.kmsKeyArn,
      }))
      if (
        output.ChecksumSHA256 !== checksumSha256 ||
        !isNonEmptyString(output.VersionId, 1_024) ||
        output.ServerSideEncryption !== 'aws:kms' ||
        output.SSEKMSKeyId !== this.kmsKeyArn
      ) {
        throw new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED')
      }
      putVersionId = output.VersionId
    } catch {
      // PutObject responses can be absent or incomplete; the exact read below is authoritative.
    }
    await this.reconcileExistingObject(
      objectKey,
      body,
      checksumSha256,
      retentionReferenceAt,
      putVersionId,
    )
    return { checksumSha256, objectKey }
  }

  /** Reconciles an ambiguous PutObject outcome against exact immutable bytes. */
  private async reconcileExistingObject(
    objectKey: string,
    expectedBody: Uint8Array,
    expectedChecksum: string,
    retentionReferenceAt: string,
    expectedVersionId: string | undefined,
  ): Promise<void> {
    try {
      const output = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucketName,
        ChecksumMode: 'ENABLED',
        ExpectedBucketOwner: this.accountId,
        Key: objectKey,
        ...(expectedVersionId ? { VersionId: expectedVersionId } : {}),
      }))
      const body = await collectBoundedObjectBody(output, 1_048_576)
      const observedChecksum = createHash('sha256').update(body).digest('base64')
      if (
        output.ChecksumSHA256 !== expectedChecksum ||
        observedChecksum !== expectedChecksum ||
        output.ContentLength !== expectedBody.byteLength ||
        output.ContentType !== 'application/json' ||
        output.ServerSideEncryption !== 'aws:kms' ||
        output.SSEKMSKeyId !== this.kmsKeyArn ||
        !isNonEmptyString(output.VersionId, 1_024) ||
        (expectedVersionId !== undefined && output.VersionId !== expectedVersionId) ||
        !isRestoreDrillComplianceRetentionSufficient(
          retentionReferenceAt,
          output.ObjectLockMode,
          output.ObjectLockRetainUntilDate,
        ) ||
        !Buffer.from(body).equals(Buffer.from(expectedBody))
      ) {
        throw new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED')
      }
      const retention = await this.s3.send(new GetObjectRetentionCommand({
        Bucket: this.bucketName,
        ExpectedBucketOwner: this.accountId,
        Key: objectKey,
        VersionId: output.VersionId,
      }))
      if (
        !isRestoreDrillComplianceRetentionSufficient(
          retentionReferenceAt,
          retention.Retention?.Mode,
          retention.Retention?.RetainUntilDate,
        ) ||
        retention.Retention?.RetainUntilDate?.getTime() !==
          output.ObjectLockRetainUntilDate?.getTime()
      ) {
        throw new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED')
      }
    } catch (error: unknown) {
      if (
        error instanceof RestoreDrillOrchestratorFailure &&
        error.code === 'EVIDENCE_WRITE_FAILED'
      ) throw error
      throw new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED')
    }
  }
}

/** Resolves the exact terminal timestamp that starts evidence retention. */
function evidenceRetentionReferenceAt(artifact: RestoreDrillEvidenceArtifact): string {
  if ('result' in artifact) return artifact.result.completedAt
  return artifact.kind === 'mukuroji-restore-drill-cleanup'
    ? artifact.completedAt
    : artifact.failedAt
}

/** Reads the timestamp encoded by pinned evidence without trusting its caller. */
function readPinnedEvidenceRetentionReferenceAt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if ('result' in value) {
    return isRecord(value.result) && isCanonicalTimestamp(value.result.completedAt)
      ? value.result.completedAt
      : undefined
  }
  if (value.kind === 'mukuroji-restore-drill-cleanup') {
    return isCanonicalTimestamp(value.completedAt) ? value.completedAt : undefined
  }
  if (value.kind === 'mukuroji-restore-drill-operational-failure') {
    return isCanonicalTimestamp(value.failedAt) ? value.failedAt : undefined
  }
  return undefined
}

/** S3-backed immutable cleanup approval reader. */
export class AwsRestoreDrillApprovalStore implements RestoreDrillApprovalStore {
  /** Expected owner account for the protected evidence bucket. */
  private readonly accountId: string

  /** ARN partition fixed by the protected evidence bucket Region. */
  private readonly authorizedApproverPartition: RestoreDrillAwsPartition

  /** Role name whose STS sessions alone may sign cleanup approval receipts. */
  private readonly authorizedApproverRoleName: string

  /** Protected Object-Lock evidence bucket name. */
  private readonly bucketName: string

  /** Customer-managed key required on every approval object. */
  private readonly kmsKeyArn: string

  /** Official S3 client owned by this adapter. */
  private readonly s3: S3Client

  /**
   * Creates an immutable approval reader over explicit protected resources.
   *
   * @param configuration - Validated evidence bucket, KMS key, account, and Region.
   * @param authorizedApproverRoleArn - Exact trusted data-owner IAM role ARN.
   */
  constructor(configuration: Pick<
    RestoreDrillAwsConfiguration,
    'accountId' | 'evidenceBucketName' | 'evidenceKmsKeyArn' | 'region'
  >, authorizedApproverRoleArn: string) {
    const partition = resolveRestoreDrillAwsPartition(configuration.region)
    if (partition === undefined) {
      throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
    }
    const roleName = readAuthorizedApproverRoleName(
      authorizedApproverRoleArn,
      configuration.accountId,
      partition,
    )
    this.accountId = configuration.accountId
    this.authorizedApproverPartition = partition
    this.authorizedApproverRoleName = roleName
    this.bucketName = configuration.evidenceBucketName
    this.kmsKeyArn = configuration.evidenceKmsKeyArn
    this.s3 = new S3Client({ region: configuration.region })
  }

  /** Releases the underlying S3 client. */
  close(): void {
    this.s3.destroy()
  }

  /** @inheritdoc */
  async readImmutable(
    objectKey: string,
    drillId: string,
  ): Promise<RestoreDrillApprovalReadResult> {
    const validatedKey = requireApprovalObjectKey(objectKey, drillId)
    try {
      const output = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucketName,
        ChecksumMode: 'ENABLED',
        ExpectedBucketOwner: this.accountId,
        Key: validatedKey,
      }))
      const body = await collectBoundedObjectBody(output, 16_384)
      const checksum = createHash('sha256').update(body).digest('base64')
      if (
        output.ChecksumSHA256 !== checksum ||
        output.ContentType !== 'application/json' ||
        output.ServerSideEncryption !== 'aws:kms' ||
        output.SSEKMSKeyId !== this.kmsKeyArn
      ) {
        throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
      }
      const text = Buffer.from(body).toString('utf8')
      const value: unknown = JSON.parse(text)
      const receipt = parseApprovalReceipt(value, drillId)
      if (
        !output.VersionId ||
        !isRestoreDrillApprovalRetentionSufficient(
          receipt.approvedAt,
          output.ObjectLockMode,
          output.ObjectLockRetainUntilDate,
        )
      ) {
        throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
      }
      const retention = await this.s3.send(new GetObjectRetentionCommand({
        Bucket: this.bucketName,
        ExpectedBucketOwner: this.accountId,
        Key: validatedKey,
        VersionId: output.VersionId,
      }))
      if (
        !isRestoreDrillApprovalRetentionSufficient(
          receipt.approvedAt,
          retention.Retention?.Mode,
          retention.Retention?.RetainUntilDate,
        ) ||
        retention.Retention?.RetainUntilDate?.getTime() !==
          output.ObjectLockRetainUntilDate?.getTime()
      ) {
        throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
      }
      if (
        stableJson(receipt) !== text ||
        validatedKey !== `approvals/v1/runs/${drillId}/${receipt.approvalMac}.json` ||
        !isAuthorizedApproverSession(
          receipt.approver,
          this.accountId,
          this.authorizedApproverPartition,
          this.authorizedApproverRoleName,
        )
      ) {
        throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
      }
      return {
        approvalDigest: createHash('sha256').update(body).digest('hex'),
        receipt,
      }
    } catch (error: unknown) {
      if (
        error instanceof RestoreDrillOrchestratorFailure &&
        error.code === 'APPROVAL_INVALID'
      ) throw error
      throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
    }
  }
}

/** CloudWatch-backed aggregate-only metric sink. */
export class AwsRestoreDrillMetricSink implements RestoreDrillMetricSink {
  /** Official CloudWatch client owned by this adapter. */
  private readonly cloudwatch: CloudWatchClient

  /** Explicit namespace constrained by the runner role. */
  private readonly namespace: string

  /**
   * Creates a metric sink over one fixed namespace and Region.
   *
   * @param namespace - Fixed restore-drill namespace.
   * @param region - AWS Region containing the restore drill.
   */
  constructor(namespace: string, region: string) {
    if (!/^[A-Za-z0-9_.\-/]{1,255}$/.test(namespace) || !isAwsRegion(region)) {
      throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
    }
    this.namespace = namespace
    this.cloudwatch = new CloudWatchClient({ region })
  }

  /** Releases the underlying CloudWatch client. */
  close(): void {
    this.cloudwatch.destroy()
  }

  /** @inheritdoc */
  async put(
    metricName: RestoreDrillMetricName,
    value: number,
    unit: RestoreDrillMetricUnit,
  ): Promise<void> {
    if (!Number.isFinite(value) || value < 0) {
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
    const standardUnit: StandardUnit = unit
    await this.cloudwatch.send(new PutMetricDataCommand({
      MetricData: [{
        Dimensions: [{ Name: 'Service', Value: 'mukuroji-restore-drill' }],
        MetricName: metricName,
        Unit: standardUnit,
        Value: value,
      }],
      Namespace: this.namespace,
    }))
  }
}

/** Step Functions-backed exact execution-status reader for explicit reapproval. */
export class AwsRestoreDrillCleanupExecutionStore
implements RestoreDrillCleanupExecutionStore {
  /** AWS account that owns the configured cleanup workflow. */
  private readonly accountId: string

  /** Exact physical cleanup state-machine name. */
  private readonly cleanupWorkflowName: string

  /** AWS Region containing the configured cleanup workflow. */
  private readonly region: string

  /** Official Step Functions client owned by this adapter. */
  private readonly sfn: SFNClient

  /**
   * Creates an execution-status reader in one explicit Region.
   *
   * @param region - AWS Region containing the cleanup workflow.
   * @param accountId - AWS account that owns the cleanup workflow.
   * @param cleanupWorkflowName - Exact deployed cleanup state-machine name.
   */
  constructor(region: string, accountId: string, cleanupWorkflowName: string) {
    if (
      !isAwsRegion(region) ||
      !/^\d{12}$/.test(accountId) ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(cleanupWorkflowName)
    ) {
      throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
    }
    this.accountId = accountId
    this.cleanupWorkflowName = cleanupWorkflowName
    this.region = region
    this.sfn = new SFNClient({ region })
  }

  /** Releases the underlying Step Functions client. */
  close(): void {
    this.sfn.destroy()
  }

  /** @inheritdoc */
  async readStatus(
    executionArn: string,
  ): Promise<RestoreDrillCleanupExecutionObservation> {
    const identity = parseCleanupExecutionArn(executionArn)
    if (
      !identity ||
      identity.accountId !== this.accountId ||
      identity.region !== this.region ||
      identity.stateMachineName !== this.cleanupWorkflowName
    ) {
      throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
    }
    const output = await this.sfn.send(new DescribeExecutionCommand({
      executionArn,
      includedData: 'METADATA_ONLY',
    }))
    const expectedStateMachineArn =
      `arn:${identity.partition}:states:${this.region}:${this.accountId}:stateMachine:${this.cleanupWorkflowName}`
    if (
      output.executionArn !== executionArn ||
      output.name !== identity.executionName ||
      output.stateMachineArn !== expectedStateMachineArn ||
      !isNonNegativeInteger(output.redriveCount)
    ) {
      throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
    }
    switch (output.status) {
      case 'ABORTED':
      case 'FAILED':
      case 'SUCCEEDED':
      case 'TIMED_OUT': {
        const stopDate = output.stopDate?.toISOString()
        if (!stopDate) {
          throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
        }
        return { redriveCount: output.redriveCount, status: output.status, stopDate }
      }
      case 'PENDING_REDRIVE':
      case 'RUNNING':
        return { redriveCount: output.redriveCount, status: output.status }
      default:
        throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
    }
  }
}

/** AWS-backed exact export, restore, descriptor, File, and semantic verifier. */
export class AwsRestoreDrillVerifier implements RestoreDrillVerifier {
  /** Explicit validated AWS resource allowlist. */
  private readonly configuration: RestoreDrillAwsConfiguration

  /** Low-level DynamoDB client for strongly consistent isolated scans. */
  private readonly dynamodb: DynamoDBClient

  /** S3 client for exact export versions and bucket descriptors. */
  private readonly s3: S3Client

  /** Secrets Manager client for the existing audit pseudonym key. */
  private readonly secrets: SecretsManagerClient

  /** Narrow semantic reader factory, injectable for production-adapter contract tests. */
  private readonly semanticReaderFactory: RestoreDrillSemanticReaderFactory

  /**
   * Creates a production verifier over one validated restore-drill configuration.
   *
   * @param configuration - Complete explicit runner resource allowlist.
   * @param semanticReaderFactory - Optional narrow reader factory; official clients are default.
   */
  constructor(
    configuration: RestoreDrillAwsConfiguration,
    semanticReaderFactory: RestoreDrillSemanticReaderFactory = {
      /** Creates the module-owned concrete normalized AWS page reader. */
      create(readerConfiguration) {
        return createCrossDomainIntegrityNormalizedPageReader(readerConfiguration)
      },
    },
  ) {
    this.configuration = configuration
    this.dynamodb = new DynamoDBClient({ region: configuration.region })
    this.s3 = new S3Client({ region: configuration.region })
    this.secrets = new SecretsManagerClient({ region: configuration.region })
    this.semanticReaderFactory = semanticReaderFactory
  }

  /** Releases every AWS client owned by the verifier. */
  close(): void {
    this.dynamodb.destroy()
    this.s3.destroy()
    this.secrets.destroy()
  }

  /** @inheritdoc */
  async resolveSemanticSecretVersion(input: RestoreDrillVerifierInput): Promise<string> {
    validateVerifierInput(input)
    const output = await this.secrets.send(new GetSecretValueCommand({
      SecretId: this.configuration.auditPseudonymSecretArn,
      VersionStage: 'AWSCURRENT',
    }))
    const parsed = parseAuditPseudonymSecret(output, input.digestKey)
    parsed.key.fill(0)
    return parsed.versionId
  }

  /** @inheritdoc */
  async readSemanticClaimPage(
    input: RestoreDrillVerifierInput,
    target: RestoreDrillTableTarget,
    auditPseudonymSecretVersionId: string,
    remainingItemCapacity: number,
    nextCursor?: string,
  ): Promise<RestoreDrillSemanticClaimPage> {
    validateVerifierInput(input)
    if (
      !isSecretsManagerVersionId(auditPseudonymSecretVersionId) ||
      !isNonNegativeInteger(remainingItemCapacity) ||
      remainingItemCapacity > MAX_VERIFICATION_SEMANTIC_UNITS
    ) throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    let reader: CrossDomainIntegrityNormalizedPageReader | undefined
    let result: RestoreDrillSemanticClaimPage | undefined
    let secret: RestoreDrillAuditPseudonymSecret | undefined
    const pageSignal = AbortSignal.timeout(MAX_VERIFICATION_BATCH_MILLISECONDS)
    try {
      reader = this.semanticReaderFactory.create(
        {
          accountId: this.configuration.accountId,
          bucketName: this.configuration.scratchBucketName,
          pageSize: 25,
          region: this.configuration.region,
          tableNames: createCrossDomainTableNames(input.checkpoint),
        },
      )
      const output = await this.secrets.send(
        new GetSecretValueCommand({
          SecretId: this.configuration.auditPseudonymSecretArn,
          VersionId: auditPseudonymSecretVersionId,
        }),
        { abortSignal: pageSignal },
      )
      secret = parseAuditPseudonymSecret(
        output,
        input.digestKey,
        auditPseudonymSecretVersionId,
      )
      const normalized = await reader.readPage({
        auditPseudonymKey: secret.key,
        checkedAt: input.restorePoint,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        digestKey: input.digestKey,
        remainingItemCapacity,
        signal: pageSignal,
        target: toCrossDomainTableTarget(target),
      })
      const claims: RestoreDrillSemanticClaim[] = []
      for (const entry of normalized.items) {
        claims.push(...createRestoreDrillSemanticItemClaims(
          entry.item,
          input.digestKey,
          entry.originDigest,
        ))
        if (entry.item.kind === 'workspace-member') {
          const auditEntityId = createWorkspaceMemberAuditEntityIdFromKeyBytes(
            entry.item.workspaceId,
            entry.item.memberKey,
            secret.key,
          )
          claims.push(createRestoreDrillSemanticAuditMemberAliasClaim(
            entry.item.workspaceId,
            auditEntityId,
            input.digestKey,
            entry.originDigest,
          ))
        }
      }
      for (const entry of normalized.auditCandidates) {
        const candidateLabel = createRestoreDrillSemanticToken(
          input.digestKey,
          'audit-candidate-label',
          [entry.originDigest, entry.candidate.resourceIdentity],
        )
        claims.push(...createRestoreDrillSemanticAuditCandidateClaims(
          entry.candidate.reference,
          entry.candidate.historical,
          entry.candidate.eventOrder,
          entry.candidate.resourceIdentity,
          input.digestKey,
          entry.originDigest,
          candidateLabel,
        ))
      }
      for (const failureCode of normalized.externalFileFailureCodes) {
        const originToken = createRestoreDrillSemanticToken(
          input.digestKey,
          'external-file-origin',
          [target, failureCode],
        )
        claims.push(createRestoreDrillSemanticFailureClaim(
          input.digestKey,
          originToken,
          'external-file',
          failureCode,
        ))
      }
      if (claims.length > MAX_VERIFICATION_SEMANTIC_CLAIMS_PER_PAGE) {
        throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
      }
      result = normalized.nextCursor
        ? {
            claims,
            nextCursor: normalized.nextCursor,
            retainedUnitCount: normalized.retainedUnitCount,
          }
        : { claims, retainedUnitCount: normalized.retainedUnitCount }
    } catch (error) {
      secret?.key.fill(0)
      if (reader) {
        try {
          reader.close()
        } catch {
          // Preserve the primary verification failure.
        }
      }
      throw error
    }
    secret?.key.fill(0)
    if (!reader || !result || !secret) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    try {
      reader.close()
    } catch {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    return result
  }

  /** @inheritdoc */
  async readSourceExportManifest(
    input: RestoreDrillVerifierInput,
    target: RestoreDrillTableTarget,
    readVersion: RestoreDrillExportVersionReader,
  ): Promise<RestoreDrillExportManifest> {
    validateVerifierInput(input)
    const recorded = input.checkpoint.exports.find((candidate) => candidate.target === target)
    const completion = input.exportCompletions.find((candidate) => candidate.target === target)
    if (!recorded || !completion) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    const exportArnDigest = sha256Hex(`export-arn\0${recorded.exportArn}`)
    if (completion.exportArnDigest !== exportArnDigest) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    const summaryVersion = await requireVerificationExportVersion(
      readVersion,
      exportArnDigest,
      completion.manifestKey,
    )
    const summaryChecksumVersion = await requireVerificationExportVersion(
      readVersion,
      exportArnDigest,
      replaceJsonWithChecksum(completion.manifestKey),
    )
    const authenticatedSummaryBody = await verifyRestoreDrillExportManifestChecksum(
      streamObjectBody(await this.readExactExportVersion(summaryVersion)),
      streamObjectBody(await this.readExactExportVersion(summaryChecksumVersion)),
      1_048_576,
    )
    const summary = await parseRestoreDrillExportSummary(
      authenticatedSummaryBody,
      1_048_576,
      recorded,
      this.configuration,
    )
    const manifestKey = normalizeExportPointer(
      recorded,
      completion.manifestKey,
      summary.manifestFilesObjectKey,
      'manifest-files.json',
    )
    const manifestVersion = await requireVerificationExportVersion(
      readVersion,
      exportArnDigest,
      manifestKey,
    )
    const manifestChecksumVersion = await requireVerificationExportVersion(
      readVersion,
      exportArnDigest,
      replaceJsonWithChecksum(manifestKey),
    )
    const authenticatedManifestBody = await verifyRestoreDrillExportManifestChecksum(
      streamObjectBody(await this.readExactExportVersion(manifestVersion)),
      streamObjectBody(await this.readExactExportVersion(manifestChecksumVersion)),
      4_194_304,
    )
    const manifest = await parseRestoreDrillExportFilesManifest(
      authenticatedManifestBody,
      {
        maxBytes: 4_194_304,
        maxRecords: MAX_VERIFICATION_MANIFEST_FILES_PER_TARGET,
      },
      recorded,
      this.configuration,
    )
    if (
      manifest.dataFiles.length < 1 ||
      manifest.itemCount > MAX_VERIFICATION_RECORDS_PER_TARGET ||
      manifest.dataFiles.some(
        (dataFile) => dataFile.itemCount > MAX_VERIFICATION_RECORDS_PER_SOURCE_FILE,
      )
    ) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    if (
      manifest.itemCount !== summary.itemCount ||
      summary.itemCount !== completion.itemCount
    ) throw new RestoreDrillFailure('AGGREGATE_RECORD_COUNT_MISMATCH')
    return manifest
  }

  /** @inheritdoc */
  async aggregateSourceExportFile(
    input: RestoreDrillVerifierInput,
    target: RestoreDrillTableTarget,
    dataFile: RestoreDrillExportDataFile,
    readVersion: RestoreDrillExportVersionReader,
    partitionSink: RestoreDrillPartitionDigestSink,
  ): Promise<RestoreDrillDynamoAggregateCheckpoint> {
    validateVerifierInput(input)
    const exactDataFile = parseVerificationManifestFile(dataFile)
    const recorded = input.checkpoint.exports.find((candidate) => candidate.target === target)
    const completion = input.exportCompletions.find((candidate) => candidate.target === target)
    const source = findSourceObservation(input.checkpoint, target)
    if (!recorded || !completion) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    const exportArnDigest = sha256Hex(`export-arn\0${recorded.exportArn}`)
    const dataKey = normalizeExportPointer(
      recorded,
      completion.manifestKey,
      exactDataFile.objectKey,
      'data-file',
    )
    const version = await requireVerificationExportVersion(
      readVersion,
      exportArnDigest,
      dataKey,
    )
    const accumulator = new RestoreDrillDynamoAggregateAccumulator(
      input.digestKey,
      target,
      source.descriptor.keySchema,
      MAX_VERIFICATION_RECORDS_PER_SOURCE_FILE,
    )
    try {
      const consumed = await consumeRestoreDrillExportData(
        streamObjectBody(await this.readExactExportVersion(version)),
        {
          maxBytes: 1_073_741_824,
          maxRecords: Math.max(1, exactDataFile.itemCount),
        },
        accumulator,
        exactDataFile.md5Checksum,
        partitionSink,
      )
      if (consumed !== exactDataFile.itemCount) {
        throw new RestoreDrillFailure('AGGREGATE_RECORD_COUNT_MISMATCH')
      }
      return accumulator.checkpoint(false)
    } finally {
      accumulator.dispose()
    }
  }

  /** @inheritdoc */
  async finalizeFileVerification(
    input: RestoreDrillVerifierInput,
    evidence: RestoreDrillFileVerificationEvidence,
  ): Promise<RestoreDrillFileVerificationResources> {
    validateVerifierInput(input)
    validateFileVerificationEvidence(evidence)
    const sourceBucketDescriptor = await this.readBucketDescriptor(
      this.configuration.sourceFileBucketName,
      'AES256',
    )
    const restoreBucketDescriptor = await this.readBucketDescriptor(
      this.configuration.scratchBucketName,
      'aws:kms',
    )
    return {
      restore: createReducedFileResourceAggregate(
        evidence.destinationContent,
        evidence.destinationMetadata,
        evidence.logicalPartitionCount,
        evidence.recordCount,
        restoreBucketDescriptor,
        input.digestKey,
      ),
      source: createReducedFileResourceAggregate(
        evidence.sourceContent,
        evidence.sourceMetadata,
        evidence.logicalPartitionCount,
        evidence.recordCount,
        sourceBucketDescriptor,
        input.digestKey,
      ),
    }
  }

  /** @inheritdoc */
  async assembleVerification(
    input: RestoreDrillVerifierInput,
    sourceFileResource: RestoreDrillResourceAggregate,
    restoreFileResource: RestoreDrillResourceAggregate,
    sourceTableResources: readonly RestoreDrillResourceAggregate[],
    restoreTableResources: readonly RestoreDrillResourceAggregate[],
    workItemsSchemaStatus: 'fail' | 'pass',
    crossDomainStatus: 'fail' | 'pass',
  ): Promise<RestoreDrillVerificationResult> {
    validateVerifierInput(input)
    validateCompletedVerificationResources(sourceTableResources)
    validateCompletedVerificationResources(restoreTableResources)
    validateCompletedFileResource(sourceFileResource)
    validateCompletedFileResource(restoreFileResource)
    const keyFingerprint = calculateRestoreDrillKeyFingerprint(input.digestKey)
    const sourceAggregate = parseRestoreDrillDatasetAggregate({
      keyFingerprint,
      resources: [sourceFileResource, ...sourceTableResources],
      restorePoint: input.restorePoint,
      role: 'source-export',
    })
    const restoreAggregate = parseRestoreDrillDatasetAggregate({
      keyFingerprint,
      resources: [restoreFileResource, ...restoreTableResources],
      restorePoint: input.restorePoint,
      role: 'isolated-restore',
    })
    const resourceIdentities = createRestoreResourceIdentities(
      input.checkpoint,
      this.configuration,
      input.digestKey,
    )
    return {
      crossDomainStatus,
      resourceIdentities,
      restoreAggregate,
      sourceAggregate,
      workItemsSchemaStatus,
    }
  }

  /** Reads one recorded export object version and enforces scratch KMS identity. */
  private async readExactExportVersion(
    version: RestoreDrillRecordedExportObjectVersion,
  ): Promise<GetObjectCommandOutput> {
    const output = await this.s3.send(new GetObjectCommand({
      Bucket: version.bucketName,
      ChecksumMode: 'ENABLED',
      ExpectedBucketOwner: this.configuration.accountId,
      Key: version.objectKey,
      VersionId: version.objectVersionId,
    }))
    if (
      version.bucketName !== this.configuration.scratchBucketName ||
      output.ServerSideEncryption !== 'aws:kms' ||
      output.SSEKMSKeyId !== this.configuration.scratchKmsKeyArn ||
      !output.VersionId ||
      output.VersionId !== version.objectVersionId
    ) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    return output
  }

  /** Reads and normalizes one versioned KMS-encrypted bucket descriptor. */
  private async readBucketDescriptor(
    bucketName: string,
    expectedEncryption: 'AES256' | 'aws:kms',
  ): Promise<RestoreDrillBucketDescriptor> {
    const [versioning, encryption] = await Promise.all([
      this.s3.send(new GetBucketVersioningCommand({
        Bucket: bucketName,
        ExpectedBucketOwner: this.configuration.accountId,
      })),
      this.s3.send(new GetBucketEncryptionCommand({
        Bucket: bucketName,
        ExpectedBucketOwner: this.configuration.accountId,
      })),
    ])
    const rules = encryption.ServerSideEncryptionConfiguration?.Rules
    const defaultEncryption = rules?.[0]?.ApplyServerSideEncryptionByDefault
    if (
      versioning.Status !== 'Enabled' ||
      !rules ||
      rules.length !== 1 ||
      defaultEncryption?.SSEAlgorithm !== expectedEncryption ||
      (expectedEncryption === 'AES256' && defaultEncryption.KMSMasterKeyID !== undefined) ||
      (expectedEncryption === 'aws:kms' &&
        defaultEncryption.KMSMasterKeyID !== this.configuration.scratchKmsKeyArn)
    ) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    return { encryptionAtRest: 'enabled', versioning: 'Enabled' }
  }

}

/** Logical bucket descriptor compared without physical KMS key identity. */
type RestoreDrillBucketDescriptor = {
  /** Portable encryption-at-rest guarantee after provider-specific validation. */
  readonly encryptionAtRest: 'enabled'
  /** Required object-versioning state. */
  readonly versioning: 'Enabled'
}

/** Parsed pinned Audit pseudonym secret retained only in one verifier call. */
type RestoreDrillAuditPseudonymSecret = {
  /** Exact 32-byte pseudonym key. */
  readonly key: Uint8Array
  /** Immutable Secrets Manager version identifier. */
  readonly versionId: string
}

/** Strictly parses and domain-separates one pinned Audit pseudonym secret response. */
function parseAuditPseudonymSecret(
  output: GetSecretValueCommandOutput,
  digestKey: Uint8Array,
  expectedVersionId?: string,
): RestoreDrillAuditPseudonymSecret {
  if (
    typeof output.SecretString !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(output.SecretString) ||
    !isSecretsManagerVersionId(output.VersionId) ||
    (expectedVersionId !== undefined && output.VersionId !== expectedVersionId)
  ) throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  const key = Uint8Array.from(Buffer.from(output.SecretString, 'hex'))
  if (digestKey.byteLength !== 32 || timingSafeEqual(key, digestKey)) {
    key.fill(0)
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  return { key, versionId: output.VersionId }
}

/** Checks one immutable Secrets Manager version identifier. */
function isSecretsManagerVersionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{32,64}$/u.test(value)
}

/** Maps one restore contract target to the generic isolated AWS reader target. */
function toCrossDomainTableTarget(
  target: RestoreDrillTableTarget,
): CrossDomainIntegrityTableTarget {
  switch (target) {
    case 'table:audit-events':
      return 'audit-events'
    case 'table:file-proofing':
      return 'file-proofing'
    case 'table:project-directory':
      return 'project-directory'
    case 'table:work-item-configuration':
      return 'work-item-configuration'
    case 'table:work-items':
      return 'work-items'
    case 'table:workspace-access':
      return 'workspace-access'
    default:
      return assertUnreachable(target)
  }
}

/** Validates the complete fixed verifier input before any external read. */
function validateVerifierInput(input: RestoreDrillVerifierInput): void {
  if (
    input.digestKey.byteLength !== 32 ||
    !isCanonicalTimestamp(input.restorePoint) ||
    input.checkpoint.sources.length !== RESTORE_DRILL_TABLE_TARGETS.length ||
    input.checkpoint.restores.length !== RESTORE_DRILL_TABLE_TARGETS.length ||
    input.checkpoint.exports.length !== RESTORE_DRILL_TABLE_TARGETS.length ||
    input.exportCompletions.length !== RESTORE_DRILL_TABLE_TARGETS.length ||
    input.checkpoint.restoredDescriptors.length !== RESTORE_DRILL_TABLE_TARGETS.length
  ) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
}

/** Reads one canonical source observation from the fixed checkpoint vector. */
function findSourceObservation(
  checkpoint: RestoreDrillResourceCheckpoint,
  target: RestoreDrillTableTarget,
): RestoreDrillSourceTableObservation {
  const observation = checkpoint.sources.find((candidate) => candidate.target === target)
  if (!observation) throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  return observation
}

/** Reads one canonical restored table from the fixed checkpoint vector. */
function findRestoredTable(
  checkpoint: RestoreDrillResourceCheckpoint,
  target: RestoreDrillTableTarget,
): RestoreDrillRecordedRestoreTable {
  const table = checkpoint.restores.find((candidate) => candidate.target === target)
  if (!table) throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  return table
}

/** Reads the restored descriptor parallel to the canonical restored-table vector. */
function findRestoredDescriptor(
  checkpoint: RestoreDrillResourceCheckpoint,
  target: RestoreDrillTableTarget,
): RestoreDrillTableDescriptor {
  const index = checkpoint.restores.findIndex((candidate) => candidate.target === target)
  const descriptor = checkpoint.restoredDescriptors[index]
  if (index < 0 || !descriptor) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  return descriptor
}

/** Compares portable logical table configuration and enforces disabled restore TTL. */
export function descriptorsMatchForRestore(
  source: RestoreDrillTableDescriptor,
  restored: RestoreDrillTableDescriptor,
): boolean {
  if (
    restored.ttlEnabled ||
    restored.ttlStatus !== 'DISABLED' ||
    restored.ttlAttribute !== undefined
  ) return false
  return stableJson(portableTableDescriptor(source, source)) ===
    stableJson(portableTableDescriptor(restored, source))
}

/** Removes physical and approximate fields while retaining source logical TTL configuration. */
function portableTableDescriptor(
  descriptor: RestoreDrillTableDescriptor,
  sourceTtl: RestoreDrillTableDescriptor,
): unknown {
  return {
    attributeDefinitions: descriptor.attributeDefinitions,
    billingMode: descriptor.billingMode,
    globalSecondaryIndexes: descriptor.globalSecondaryIndexes.map((index) => ({
      indexName: index.indexName,
      keySchema: index.keySchema,
      nonKeyAttributes: index.projection.nonKeyAttributes,
      projectionType: index.projection.projectionType,
      status: index.status,
    })),
    keySchema: descriptor.keySchema,
    kmsMasterKeyArn: descriptor.kmsMasterKeyArn ?? null,
    sseType: descriptor.sseType,
    sseStatus: descriptor.sseStatus,
    ttlAttribute: sourceTtl.ttlAttribute ?? null,
    ttlEnabled: sourceTtl.ttlEnabled,
    ttlStatus: sourceTtl.ttlStatus,
  }
}

/** Calculates one keyed portable table descriptor digest. */
function calculateDescriptorDigest(
  descriptor: RestoreDrillTableDescriptor,
  digestKey: Uint8Array,
): string {
  return createHmac('sha256', digestKey)
    .update('mukuroji-restore-drill-table-descriptor-v1\0', 'utf8')
    .update(stableJson(portableTableDescriptor(descriptor, descriptor)), 'utf8')
    .digest('hex')
}

/** Converts low-level DynamoDB aggregate evidence to the shared resource contract. */
function createTableResourceAggregate(
  target: RestoreDrillTableTarget,
  descriptorDigest: string,
  evidence: ReturnType<RestoreDrillDynamoAggregateAccumulator['finalize']>,
): RestoreDrillResourceAggregate {
  return {
    contentDigest: evidence.content.aggregateDigest,
    descriptorDigest,
    logicalPartitionCount: evidence.logicalPartitionCount,
    metadataDigest: evidence.keys.aggregateDigest,
    recordCount: evidence.recordCount,
    target,
  }
}

/** Creates one File resource from independently paged proof aggregates. */
function createReducedFileResourceAggregate(
  content: RestoreDrillMultisetDigest,
  metadata: RestoreDrillMultisetDigest,
  logicalPartitionCount: number,
  recordCount: number,
  descriptor: RestoreDrillBucketDescriptor,
  digestKey: Uint8Array,
): RestoreDrillResourceAggregate {
  return {
    contentDigest: content.aggregateDigest,
    descriptorDigest: keyedCanonicalDigest(
      digestKey,
      'mukuroji-restore-drill-bucket-descriptor-v1',
      descriptor,
    ),
    logicalPartitionCount,
    metadataDigest: metadata.aggregateDigest,
    recordCount,
    target: 'bucket:file',
  }
}

/** Validates independently reduced File proof evidence before descriptor binding. */
function validateFileVerificationEvidence(
  evidence: RestoreDrillFileVerificationEvidence,
): void {
  const digests = [
    evidence.destinationContent,
    evidence.destinationMetadata,
    evidence.sourceContent,
    evidence.sourceMetadata,
  ]
  if (
    !isNonNegativeInteger(evidence.recordCount) ||
    evidence.recordCount > MAX_VERIFICATION_FILE_VERSIONS ||
    !isNonNegativeInteger(evidence.logicalPartitionCount) ||
    evidence.logicalPartitionCount > evidence.recordCount ||
    digests.some((digest) =>
      digest.algorithm !== 'HMAC-SHA-256' ||
      digest.digestVersion !== 2 ||
      digest.itemCount !== evidence.recordCount ||
      !isHexDigest(digest.aggregateDigest) ||
      !isHexDigest(digest.keyFingerprint)
    )
  ) throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  if (
    evidence.sourceContent.aggregateDigest !== evidence.destinationContent.aggregateDigest ||
    evidence.sourceMetadata.aggregateDigest !== evidence.destinationMetadata.aggregateDigest
  ) throw new RestoreDrillFailure('S3_VERSION_RESTORE_FAILED')
}

/** Validates one completed File resource before final dataset assembly. */
function validateCompletedFileResource(resource: RestoreDrillResourceAggregate): void {
  if (
    resource.target !== 'bucket:file' ||
    !isHexDigest(resource.contentDigest) ||
    !isHexDigest(resource.descriptorDigest) ||
    !isHexDigest(resource.metadataDigest) ||
    !isNonNegativeInteger(resource.logicalPartitionCount) ||
    !isNonNegativeInteger(resource.recordCount) ||
    resource.logicalPartitionCount > resource.recordCount ||
    resource.recordCount > MAX_VERIFICATION_FILE_VERSIONS
  ) throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
}

/** Calculates a keyed digest over canonical JSON under one explicit domain. */
function keyedCanonicalDigest(
  digestKey: Uint8Array,
  domain: string,
  value: unknown,
): string {
  return createHmac('sha256', digestKey)
    .update(`${domain}\0`, 'utf8')
    .update(stableJson(value), 'utf8')
    .digest('hex')
}

/** Reproduces the shared restore-drill key fingerprint without exposing key bytes. */
function calculateRestoreDrillKeyFingerprint(digestKey: Uint8Array): string {
  return createHmac('sha256', digestKey)
    .update('mukuroji-restore-drill\0key-fingerprint-v1\0', 'utf8')
    .update('restore-drill', 'utf8')
    .digest('hex')
}

/** Resolves one and only one exact captured export object VersionId. */
async function requireVerificationExportVersion(
  readVersion: RestoreDrillExportVersionReader,
  exportArnDigest: string,
  objectKey: string,
): Promise<RestoreDrillRecordedExportObjectVersion> {
  const version = await readVersion(exportArnDigest, objectKey)
  if (
    !version ||
    version.exportArnDigest !== exportArnDigest ||
    version.objectKey !== objectKey
  ) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  return version
}

/** Validates six completed table resources in canonical target order. */
function validateCompletedVerificationResources(
  resources: readonly RestoreDrillResourceAggregate[],
): void {
  if (resources.length !== RESTORE_DRILL_TABLE_TARGETS.length) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  for (let index = 0; index < resources.length; index += 1) {
    const resource = resources[index]
    if (
      !resource ||
      resource.target !== RESTORE_DRILL_TABLE_TARGETS[index] ||
      stableJson(parseVerificationResourceAggregate(resource)) !== stableJson(resource)
    ) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
  }
}

/** Resolves DynamoDB's adjacent manifest checksum key without accepting other suffixes. */
function replaceJsonWithChecksum(objectKey: string): string {
  if (!objectKey.endsWith('.json')) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  return `${objectKey.slice(0, -'.json'.length)}.checksum`
}

/** Safely normalizes a relative or full export pointer into the exact ExportId directory. */
function normalizeExportPointer(
  recorded: RestoreDrillRecordedExport,
  summaryKey: string,
  pointer: string,
  expectedLeaf: 'data-file' | 'manifest-files.json',
): string {
  const exportMarker = '/AWSDynamoDB/'
  const markerIndex = summaryKey.indexOf(exportMarker)
  const summaryDirectoryEnd = summaryKey.lastIndexOf('/')
  if (
    markerIndex < 0 ||
    summaryDirectoryEnd <= markerIndex + exportMarker.length ||
    summaryKey.slice(0, markerIndex) !== recorded.scratchPrefix ||
    !isRestoreDrillObjectKeyPathSafe(pointer)
  ) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  const exportDirectory = summaryKey.slice(0, summaryDirectoryEnd + 1)
  const fullKey = pointer.startsWith(`${recorded.scratchPrefix}/`)
    ? pointer
    : `${recorded.scratchPrefix}/${pointer.replace(/^\/+/, '')}`
  if (
    !fullKey.startsWith(exportDirectory) ||
    (expectedLeaf === 'manifest-files.json' && fullKey !== `${exportDirectory}manifest-files.json`) ||
    (expectedLeaf === 'data-file' && !fullKey.startsWith(`${exportDirectory}data/`))
  ) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  return fullKey
}

/** Creates canonical keyed identities for the exact isolated table and bucket vector. */
function createRestoreResourceIdentities(
  checkpoint: RestoreDrillResourceCheckpoint,
  configuration: RestoreDrillAwsConfiguration,
  digestKey: Uint8Array,
): RestoreDrillResourceIdentity[] {
  return CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target) => ({
    identityDigest: createPhysicalResourceIdentityDigest(
      target,
      resolveRestorePhysicalName(target, checkpoint, configuration),
      configuration,
      digestKey,
    ),
    target,
  }))
}

/** Resolves one physical restore resource from the fixed logical identity vector. */
function resolveRestorePhysicalName(
  target: CrossDomainIntegrityResourceIdentity['target'],
  checkpoint: RestoreDrillResourceCheckpoint,
  configuration: RestoreDrillAwsConfiguration,
): string {
  if (target === 'bucket:file') return configuration.scratchBucketName
  const tableTarget = crossDomainTargetToRestoreTarget(target)
  return findRestoredTable(checkpoint, tableTarget).tableName
}

/** Converts a cross-domain table target to the restore-drill target namespace. */
function crossDomainTargetToRestoreTarget(
  target: Exclude<CrossDomainIntegrityResourceIdentity['target'], 'bucket:file'>,
): RestoreDrillTableTarget {
  switch (target) {
    case 'table:audit-events':
    case 'table:file-proofing':
    case 'table:project-directory':
    case 'table:work-item-configuration':
    case 'table:work-items':
    case 'table:workspace-access':
      return target
    default:
      return assertUnreachable(target)
  }
}

/** Calculates the existing domain-separated exact physical resource identity HMAC. */
function createPhysicalResourceIdentityDigest(
  target: CrossDomainIntegrityResourceIdentity['target'],
  physicalName: string,
  configuration: RestoreDrillAwsConfiguration,
  digestKey: Uint8Array,
): string {
  const hmac = createHmac('sha256', digestKey)
  hmac.update('mukuroji-cross-domain-physical-resource-identity/v1\0', 'utf8')
  appendLengthPrefixedHmacField(hmac, 'target', target)
  appendLengthPrefixedHmacField(hmac, 'account', configuration.accountId)
  appendLengthPrefixedHmacField(hmac, 'region', configuration.region)
  appendLengthPrefixedHmacField(hmac, 'physical-name', physicalName)
  return hmac.digest('hex')
}

/** Adds one unambiguous UTF-8 label/value pair to an HMAC. */
function appendLengthPrefixedHmacField(
  hmac: ReturnType<typeof createHmac>,
  label: string,
  value: string,
): void {
  appendLengthPrefixedHmacBytes(hmac, Buffer.from(label, 'utf8'))
  appendLengthPrefixedHmacBytes(hmac, Buffer.from(value, 'utf8'))
}

/** Adds one eight-byte-length-prefixed byte string to an HMAC. */
function appendLengthPrefixedHmacBytes(
  hmac: ReturnType<typeof createHmac>,
  value: Uint8Array,
): void {
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(value.byteLength))
  hmac.update(length)
  hmac.update(value)
}

/** Creates the cross-domain bridge's complete physical table allowlist. */
function createCrossDomainTableNames(
  checkpoint: RestoreDrillResourceCheckpoint,
): CrossDomainIntegrityTableNames {
  return {
    'audit-events': findRestoredTable(checkpoint, 'table:audit-events').tableName,
    'file-proofing': findRestoredTable(checkpoint, 'table:file-proofing').tableName,
    'project-directory': findRestoredTable(
      checkpoint,
      'table:project-directory',
    ).tableName,
    'work-item-configuration': findRestoredTable(
      checkpoint,
      'table:work-item-configuration',
    ).tableName,
    'work-items': findRestoredTable(checkpoint, 'table:work-items').tableName,
    'workspace-access': findRestoredTable(checkpoint, 'table:workspace-access').tableName,
  }
}

/** Exposes an exact SDK object body as a byte-only async stream. */
async function* streamObjectBody(output: GetObjectCommandOutput): AsyncIterable<Uint8Array> {
  const body: unknown = output.Body
  if (!isAsyncIterable(body)) {
    throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
  }
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    yield chunk
  }
}

/** Collects one small exact object body under a strict byte bound. */
async function collectBoundedObjectBody(
  output: GetObjectCommandOutput,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let byteLength = 0
  for await (const chunk of streamObjectBody(output)) {
    byteLength += chunk.byteLength
    if (byteLength > maxBytes) {
      throw new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, byteLength)
}

/** Checks whether an untrusted value exposes an async iterator. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  ) && typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
}

/** Restricts append-only evidence writes to the two per-run artifact keys. */
function isEvidenceObjectKey(value: string): boolean {
  return /^evidence\/v1\/runs\/[A-Za-z0-9_-]{8,128}\/(?:cleanup|result)\.json$/.test(value)
}

/**
 * Checks an S3 object key without rejecting legal consecutive dots inside a segment.
 *
 * @param value - Untrusted complete or relative object key.
 * @returns Whether no exact traversal segment, NUL, or backslash is present.
 */
export function isRestoreDrillObjectKeyPathSafe(value: string): boolean {
  return !value.includes('\u0000') &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment !== '.' && segment !== '..')
}

/**
 * Parses an exact same-account, same-partition IAM role ARN.
 *
 * @param roleArn - Candidate trusted IAM role ARN.
 * @param accountId - Expected twelve-digit owner account.
 * @param partition - Partition derived from the configured Region.
 * @returns Terminal IAM role name.
 */
function readAuthorizedApproverRoleName(
  roleArn: string,
  accountId: string,
  partition: RestoreDrillAwsPartition,
): string {
  const match = new RegExp(
    `^arn:${partition}:iam::${accountId}:role/(?:[A-Za-z0-9+=,.@_-]+/)*([A-Za-z0-9+=,.@_-]{1,64})$`,
  ).exec(roleArn)
  const roleName = match?.[1]
  if (!roleName) throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  return roleName
}

/**
 * Checks whether an approver ARN is an STS session of the configured data-owner role.
 *
 * @param approverArn - Candidate approval signer session ARN.
 * @param accountId - Expected twelve-digit owner account.
 * @param partition - Partition derived from the configured Region.
 * @param roleName - Exact trusted terminal IAM role name.
 * @returns Whether the signer is a session of the configured role in the same partition.
 */
function isAuthorizedApproverSession(
  approverArn: string,
  accountId: string,
  partition: RestoreDrillAwsPartition,
  roleName: string,
): boolean {
  return new RegExp(
    `^arn:${partition}:sts::${accountId}:assumed-role/${escapeRegularExpression(roleName)}/[A-Za-z0-9+=,.@_-]{2,64}$`,
  ).test(approverArn)
}

/** DynamoDB-backed implementation of durable run and checkpoint state. */
export class AwsRestoreDrillStateStore implements RestoreDrillStateStore {
  /** Native-document client used for secret-free JSON-compatible records. */
  private readonly document: DynamoDBDocumentClient

  /** Low-level client used only to preserve opaque DynamoDB cursor AttributeValues. */
  private readonly dynamodb: DynamoDBClient

  /** Exact protected state table name. */
  private readonly tableName: string

  /**
   * Creates a state store over one explicit table and Region.
   *
   * @param tableName - Exact protected restore-drill state table.
   * @param region - AWS Region containing the table.
   */
  constructor(tableName: string, region: string) {
    if (!isDynamoDbTableName(tableName) || !isAwsRegion(region)) {
      throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
    }
    this.tableName = tableName
    this.dynamodb = new DynamoDBClient({ region })
    this.document = DynamoDBDocumentClient.from(this.dynamodb, {
      marshallOptions: { removeUndefinedValues: true },
    })
  }

  /** Releases the underlying DynamoDB client. */
  close(): void {
    this.dynamodb.destroy()
  }

  /** @inheritdoc */
  async readCadence(): Promise<RestoreDrillCadenceState> {
    const output = await this.document.send(new GetCommand({
      ConsistentRead: true,
      Key: cadenceKey(),
      TableName: this.tableName,
    }))
    if (!output.Item) return { revision: 0 }
    return parseCadenceItem(output.Item)
  }

  /** @inheritdoc */
  async admitRun(
    run: RestoreDrillDurableRun,
    expectedCadenceRevision: number,
  ): Promise<boolean> {
    const revisionCondition = expectedCadenceRevision === 0
      ? 'attribute_not_exists(#controlRevision)'
      : '#controlRevision = :expectedControlRevision'
    try {
      await this.document.send(new TransactWriteCommand({
        ClientRequestToken: sha256Hex(`admit\0${run.drillId}`),
        TransactItems: [
          {
            Put: {
              ConditionExpression:
                'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
              Item: serializeRunItem(run),
              TableName: this.tableName,
            },
          },
          {
            Update: {
              ConditionExpression:
                `${revisionCondition} AND attribute_not_exists(#activeDrillId)`,
              ExpressionAttributeNames: {
                '#activeDrillId': 'activeDrillId',
                '#controlRevision': 'revision',
                '#cadenceOriginAt': 'cadenceOriginAt',
                '#kind': 'kind',
              },
              ExpressionAttributeValues: {
                ':activeDrillId': run.drillId,
                ':controlRevision': expectedCadenceRevision + 1,
                ':cadenceOriginAt': run.startedAt,
                ':expectedControlRevision': expectedCadenceRevision,
                ':kind': 'mukuroji-restore-drill-cadence',
              },
              Key: cadenceKey(),
              TableName: this.tableName,
              UpdateExpression:
                'SET #activeDrillId = :activeDrillId, #controlRevision = :controlRevision, #kind = :kind, #cadenceOriginAt = if_not_exists(#cadenceOriginAt, :cadenceOriginAt)',
            },
          },
        ],
      }))
      return true
    } catch (error: unknown) {
      try {
        const [currentRun, cadence] = await Promise.all([
          this.readRun(run.drillId),
          this.readCadence(),
        ])
        if (
          currentRun &&
          stableJson(currentRun) === stableJson(run) &&
          cadence.activeDrillId === run.drillId &&
          cadence.revision === expectedCadenceRevision + 1
        ) return true
      } catch {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      if (isConditionalAwsFailure(error)) return false
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** @inheritdoc */
  async readRun(drillId: string): Promise<RestoreDrillDurableRun | undefined> {
    const output = await this.document.send(new GetCommand({
      ConsistentRead: true,
      Key: runKey(drillId),
      TableName: this.tableName,
    }))
    return output.Item ? parseRunItem(output.Item, drillId) : undefined
  }

  /** @inheritdoc */
  async readCleanupRun(drillId: string): Promise<RestoreDrillDurableRun | undefined> {
    const expressionAttributeNames = Object.fromEntries(
      CLEANUP_RUN_READ_ATTRIBUTE_NAMES.map((attribute, index) => [
        `#attribute${index}`,
        attribute,
      ]),
    )
    const output = await this.document.send(new GetCommand({
      ConsistentRead: true,
      ExpressionAttributeNames: expressionAttributeNames,
      Key: runKey(drillId),
      ProjectionExpression: CLEANUP_RUN_READ_ATTRIBUTE_NAMES
        .map((_attribute, index) => `#attribute${index}`)
        .join(', '),
      TableName: this.tableName,
    }))
    return output.Item ? parseRunItem(output.Item, drillId) : undefined
  }

  /** @inheritdoc */
  async writeRun(run: RestoreDrillDurableRun, expectedRevision: number): Promise<boolean> {
    if (run.revision !== expectedRevision + 1) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    try {
      await this.document.send(new PutCommand({
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
        Item: serializeRunItem(run),
        TableName: this.tableName,
      }))
      return true
    } catch (error: unknown) {
      let current: RestoreDrillDurableRun | undefined
      try {
        current = await this.readRun(run.drillId)
      } catch {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      if (current && stableJson(current) === stableJson(run)) return true
      if (isConditionalAwsFailure(error)) return false
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** @inheritdoc */
  async writeCleanupRun(
    run: RestoreDrillDurableRun,
    expected: RestoreDrillDurableRun,
  ): Promise<boolean> {
    validateCleanupRunTransition(expected, run)
    const executionCondition = expected.cleanupExecutionArn === undefined
      ? 'attribute_not_exists(#cleanupExecutionArn)'
      : '#cleanupExecutionArn = :expectedCleanupExecutionArn'
    try {
      await this.document.send(new UpdateCommand({
        ConditionExpression:
          `#revision = :expectedRevision AND #phase = :expectedPhase AND ${executionCondition}`,
        ExpressionAttributeNames: {
          '#approvalDigest': 'approvalDigest',
          '#approvalObjectKey': 'approvalObjectKey',
          '#approvedAt': 'approvedAt',
          '#cleanupAttemptCount': 'cleanupAttemptCount',
          '#cleanupExecutionArn': 'cleanupExecutionArn',
          '#cleanupExecutionName': 'cleanupExecutionName',
          '#cleanupStartedAt': 'cleanupStartedAt',
          ...(run.cleanupEffectIndex !== undefined
            ? { '#cleanupEffectIndex': 'cleanupEffectIndex' }
            : {}),
          '#outcome': 'outcome',
          '#phase': 'phase',
          '#revision': 'revision',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':approvalDigest': run.approvalDigest,
          ':approvalObjectKey': run.approvalObjectKey,
          ':approvedAt': run.approvedAt,
          ':cleanupAttemptCount': run.cleanupAttemptCount,
          ':cleanupExecutionArn': run.cleanupExecutionArn,
          ':cleanupExecutionName': run.cleanupExecutionName,
          ':cleanupStartedAt': run.cleanupStartedAt,
          ...(run.cleanupEffectIndex !== undefined
            ? { ':cleanupEffectIndex': run.cleanupEffectIndex }
            : {}),
          ...(expected.cleanupExecutionArn
            ? { ':expectedCleanupExecutionArn': expected.cleanupExecutionArn }
            : {}),
          ':expectedPhase': expected.phase,
          ':expectedRevision': expected.revision,
          ':outcome': run.outcome,
          ':phase': run.phase,
          ':revision': run.revision,
          ':updatedAt': run.updatedAt,
        },
        Key: runKey(run.drillId),
        TableName: this.tableName,
        UpdateExpression:
          'SET #approvalDigest = :approvalDigest, #approvalObjectKey = :approvalObjectKey, #approvedAt = :approvedAt, #cleanupAttemptCount = :cleanupAttemptCount, #cleanupExecutionArn = :cleanupExecutionArn, #cleanupExecutionName = :cleanupExecutionName, #cleanupStartedAt = :cleanupStartedAt, #outcome = :outcome, #phase = :phase, #revision = :revision, #updatedAt = :updatedAt' +
          (run.cleanupEffectIndex !== undefined
            ? ', #cleanupEffectIndex = :cleanupEffectIndex'
            : ''),
      }))
      return true
    } catch (error: unknown) {
      let current: RestoreDrillDurableRun | undefined
      try {
        current = await this.readCleanupRun(run.drillId)
      } catch {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      if (current && stableJson(current) === stableJson(run)) return true
      if (isConditionalAwsFailure(error)) return false
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** @inheritdoc */
  async writeResourceCheckpoint(
    drillId: string,
    checkpoint: RestoreDrillResourceCheckpoint,
  ): Promise<void> {
    await this.putCleanupTargets(drillId, checkpoint.restores)
    const current = await this.readResourceCheckpoint(drillId)
    if (current && stableJson(current) === stableJson(checkpoint)) return
    const advanced = await this.writeJsonCheckpointCas(
      drillId,
      'RESOURCES',
      'mukuroji-restore-drill-resources',
      current,
      checkpoint,
      current === undefined,
    )
    if (!advanced) throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }

  /** @inheritdoc */
  async readResourceCheckpoint(
    drillId: string,
  ): Promise<RestoreDrillResourceCheckpoint | undefined> {
    const value = await this.readJsonCheckpoint(drillId, 'RESOURCES')
    return value === undefined ? undefined : parseResourceCheckpoint(value)
  }

  /** @inheritdoc */
  async readStartIntent(
    drillId: string,
    target: RestoreDrillTableTarget,
  ): Promise<RestoreDrillStartIntent | undefined> {
    const value = await this.readJsonCheckpoint(drillId, `START_INTENT#${target}`)
    return value === undefined ? undefined : parseStartIntent(value)
  }

  /** @inheritdoc */
  async writeStartIntent(drillId: string, intent: RestoreDrillStartIntent): Promise<void> {
    await this.putJsonCheckpointOnce(
      drillId,
      `START_INTENT#${intent.target}`,
      'mukuroji-restore-drill-start-intent',
      intent,
    )
  }

  /** @inheritdoc */
  async markStartAttempted(
    drillId: string,
    target: RestoreDrillTableTarget,
    kind: 'export' | 'restore',
  ): Promise<void> {
    const existing = await this.readStartIntent(drillId, target)
    if (!existing) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    if (kind === 'restore' ? existing.restoreAttempted : existing.exportAttempted) return
    const next: RestoreDrillStartIntent = kind === 'restore'
      ? { ...existing, restoreAttempted: true }
      : { ...existing, exportAttempted: true }
    await this.replaceJsonCheckpoint(
      drillId,
      `START_INTENT#${target}`,
      'mukuroji-restore-drill-start-intent',
      existing,
      next,
    )
  }

  /** @inheritdoc */
  async recordStartedRestore(
    drillId: string,
    target: RestoreDrillTableTarget,
    table: RestoreDrillRecordedRestoreTable,
  ): Promise<void> {
    const existing = await this.readStartIntent(drillId, target)
    if (!existing?.restoreAttempted || table.target !== target) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    if (existing.restoreRecord) {
      if (stableJson(existing.restoreRecord) !== stableJson(table)) {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      return
    }
    await this.replaceJsonCheckpoint(
      drillId,
      `START_INTENT#${target}`,
      'mukuroji-restore-drill-start-intent',
      existing,
      { ...existing, restoreRecord: table },
    )
  }

  /** @inheritdoc */
  async recordStartedExport(
    drillId: string,
    target: RestoreDrillTableTarget,
    exportRecord: RestoreDrillRecordedExport,
  ): Promise<void> {
    const existing = await this.readStartIntent(drillId, target)
    if (!existing?.exportAttempted || exportRecord.target !== target) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    if (existing.exportRecord) {
      if (stableJson(existing.exportRecord) !== stableJson(exportRecord)) {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      return
    }
    await this.replaceJsonCheckpoint(
      drillId,
      `START_INTENT#${target}`,
      'mukuroji-restore-drill-start-intent',
      existing,
      { ...existing, exportRecord },
    )
  }

  /** @inheritdoc */
  async listStartIntents(drillId: string): Promise<readonly RestoreDrillStartIntent[]> {
    const values = await this.queryJsonCheckpoints(drillId, 'START_INTENT#')
    return values.map(parseStartIntent).sort(
      (left, right) => RESTORE_DRILL_TABLE_TARGETS.indexOf(left.target) -
        RESTORE_DRILL_TABLE_TARGETS.indexOf(right.target),
    )
  }

  /** @inheritdoc */
  async readFileCursor(drillId: string): Promise<RestoreDrillFileCursorCheckpoint> {
    const runOutput = await this.document.send(new GetCommand({
      ConsistentRead: true,
      Key: runKey(drillId),
      ProjectionExpression: '#pointer',
      ExpressionAttributeNames: { '#pointer': 'fileCheckpointRecordKey' },
      TableName: this.tableName,
    }))
    const pointer = runOutput.Item?.fileCheckpointRecordKey
    if (pointer === undefined) return { complete: false, started: false }
    if (typeof pointer !== 'string' || pointer.length === 0 || pointer.length > 256) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const output = await this.dynamodb.send(new GetItemCommand({
      ConsistentRead: true,
      Key: {
        scopeKey: { S: runScopeKey(drillId) },
        recordKey: { S: pointer },
      },
      TableName: this.tableName,
    }))
    const item = output.Item
    if (!item || typeof item.complete?.BOOL !== 'boolean') {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const nextKey = item.nextKey?.M === undefined
      ? undefined
      : cloneStrictAttributeMap(item.nextKey.M)
    return {
      complete: item.complete.BOOL,
      ...(nextKey ? { nextKey } : {}),
      started: true,
    }
  }

  /** @inheritdoc */
  async writeFileCursor(
    drillId: string,
    runRevision: number,
    nextKey?: Readonly<Record<string, AttributeValue>>,
  ): Promise<boolean> {
    const recordKey = `FILE_CURSOR#${String(runRevision + 1).padStart(12, '0')}`
    const item: Record<string, AttributeValue> = {
      complete: { BOOL: nextKey === undefined },
      kind: { S: 'mukuroji-restore-drill-file-cursor' },
      recordKey: { S: recordKey },
      scopeKey: { S: runScopeKey(drillId) },
      ...(nextKey ? { nextKey: { M: cloneStrictAttributeMap(nextKey) } } : {}),
    }
    try {
      await this.dynamodb.send(new TransactWriteItemsCommand({
        ClientRequestToken: sha256Hex(`file-cursor\0${drillId}\0${runRevision}`),
        TransactItems: [
          {
            Put: {
              ConditionExpression:
                'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
              Item: item,
              TableName: this.tableName,
            },
          },
          {
            Update: {
              ConditionExpression: '#revision = :expectedRevision AND #phase = :phase',
              ExpressionAttributeNames: {
                '#pointer': 'fileCheckpointRecordKey',
                '#revision': 'revision',
                '#phase': 'phase',
              },
              ExpressionAttributeValues: {
                ':expectedRevision': { N: String(runRevision) },
                ':nextRevision': { N: String(runRevision + 1) },
                ':phase': { S: 'copying-file-versions' },
                ':pointer': { S: recordKey },
              },
              Key: {
                scopeKey: { S: runScopeKey(drillId) },
                recordKey: { S: 'RUN' },
              },
              TableName: this.tableName,
              UpdateExpression: 'SET #revision = :nextRevision, #pointer = :pointer',
            },
          },
        ],
      }))
      return true
    } catch (error: unknown) {
      try {
        const [cursorOutput, runOutput] = await Promise.all([
          this.dynamodb.send(new GetItemCommand({
            ConsistentRead: true,
            Key: {
              scopeKey: { S: runScopeKey(drillId) },
              recordKey: { S: recordKey },
            },
            TableName: this.tableName,
          })),
          this.dynamodb.send(new GetItemCommand({
            ConsistentRead: true,
            Key: {
              scopeKey: { S: runScopeKey(drillId) },
              recordKey: { S: 'RUN' },
            },
            ProjectionExpression: '#pointer, #revision, #phase',
            ExpressionAttributeNames: {
              '#pointer': 'fileCheckpointRecordKey',
              '#revision': 'revision',
              '#phase': 'phase',
            },
            TableName: this.tableName,
          })),
        ])
        const observedRun = runOutput.Item
        if (
          cursorOutput.Item &&
          stableJson(cursorOutput.Item) === stableJson(item) &&
          observedRun &&
          Object.keys(observedRun).length === 3 &&
          observedRun.fileCheckpointRecordKey?.S === recordKey &&
          observedRun.revision?.N === String(runRevision + 1) &&
          observedRun.phase?.S === 'copying-file-versions'
        ) return true
      } catch {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      if (isConditionalAwsFailure(error)) return false
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** @inheritdoc */
  async readCopyIntent(
    drillId: string,
    intentDigest: string,
  ): Promise<RestoreDrillCopyIntent | undefined> {
    const value = await this.readJsonCheckpoint(drillId, `COPY_INTENT#${intentDigest}`)
    return value === undefined ? undefined : parseCopyIntent(value, drillId)
  }

  /** @inheritdoc */
  async writeCopyIntent(drillId: string, intent: RestoreDrillCopyIntent): Promise<void> {
    const recordKey = `COPY_INTENT#${intent.intentDigest}`
    await this.putJsonCheckpointOnce(
      drillId,
      recordKey,
      'mukuroji-restore-drill-copy-intent',
      intent,
    )
  }

  /** @inheritdoc */
  async claimCopyIntent(
    drillId: string,
    intentDigest: string,
    expectedClaim: RestoreDrillCopyClaim | undefined,
    nextClaim: RestoreDrillCopyClaim,
  ): Promise<boolean> {
    const existing = await this.readCopyIntent(drillId, intentDigest)
    if (
      !existing ||
      existing.createdCopies ||
      stableJson(existing.copyClaim) !== stableJson(expectedClaim)
    ) return false
    try {
      await this.replaceJsonCheckpoint(
        drillId,
        `COPY_INTENT#${intentDigest}`,
        'mukuroji-restore-drill-copy-intent',
        existing,
        { ...existing, copyClaim: nextClaim },
      )
      return true
    } catch (error: unknown) {
      if (isConditionalConflict(error)) return false
      throw error
    }
  }

  /** @inheritdoc */
  async recordCreatedCopyIntent(
    drillId: string,
    intentDigest: string,
    claimId: string,
    copies: RestoreDrillCreatedScratchObjectVersions,
  ): Promise<void> {
    const existing = await this.readCopyIntent(drillId, intentDigest)
    if (!existing) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    if (existing.createdCopies || existing.selectedCopy) {
      if (
        stableJson(existing.createdCopies) !== stableJson(copies.createdCopies) ||
        stableJson(existing.selectedCopy) !== stableJson(copies.selectedCopy)
      ) {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      await this.putCleanupTargets(drillId, copies.createdCopies)
      return
    }
    if (existing.copyClaim?.claimId !== claimId) {
      throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
    }
    const withoutClaim: RestoreDrillCopyIntent = {
      ...(existing.completedCopy ? { completedCopy: existing.completedCopy } : {}),
      intentDigest: existing.intentDigest,
      preexistingScratchVersionIds: existing.preexistingScratchVersionIds,
      source: existing.source,
    }
    await this.putCleanupTargets(drillId, copies.createdCopies)
    await this.replaceJsonCheckpoint(
      drillId,
      `COPY_INTENT#${intentDigest}`,
      'mukuroji-restore-drill-copy-intent',
      existing,
      {
        ...withoutClaim,
        createdCopies: copies.createdCopies,
        selectedCopy: copies.selectedCopy,
      },
    )
  }

  /** @inheritdoc */
  async writeCopyVerificationCheckpoint(
    drillId: string,
    intentDigest: string,
    expected: RestoreDrillFileRangeCheckpoint | undefined,
    next: RestoreDrillFileRangeCheckpoint,
  ): Promise<boolean> {
    const exactExpected = expected === undefined
      ? undefined
      : parseFileRangeCheckpoint(expected)
    const exactNext = parseFileRangeCheckpoint(next)
    if (!fileRangeCheckpointAdvances(exactExpected, exactNext)) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const existing = await this.readCopyIntent(drillId, intentDigest)
    if (
      !existing?.selectedCopy ||
      existing.completedCopy ||
      stableJson(existing.verificationCheckpoint) !== stableJson(exactExpected)
    ) {
      return stableJson(existing?.verificationCheckpoint) === stableJson(exactNext)
    }
    try {
      await this.replaceJsonCheckpoint(
        drillId,
        `COPY_INTENT#${intentDigest}`,
        'mukuroji-restore-drill-copy-intent',
        existing,
        { ...existing, verificationCheckpoint: exactNext },
      )
      return true
    } catch (error: unknown) {
      if (!isConditionalConflict(error)) throw error
      const current = await this.readCopyIntent(drillId, intentDigest)
      return stableJson(current?.verificationCheckpoint) === stableJson(exactNext)
    }
  }

  /** @inheritdoc */
  async completeCopyIntent(
    drillId: string,
    intentDigest: string,
    copy: RestoreDrillRecordedScratchObjectVersion,
  ): Promise<void> {
    const existing = await this.readCopyIntent(drillId, intentDigest)
    if (!existing) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    if (
      !existing.selectedCopy ||
      !sameCreatedScratchVersion(existing.selectedCopy, copy)
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    if (existing.completedCopy) {
      if (stableJson(existing.completedCopy) !== stableJson(copy)) {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      return
    }
    const completed: RestoreDrillCopyIntent = {
      ...(existing.copyClaim ? { copyClaim: existing.copyClaim } : {}),
      ...(existing.createdCopies ? { createdCopies: existing.createdCopies } : {}),
      completedCopy: copy,
      intentDigest: existing.intentDigest,
      preexistingScratchVersionIds: existing.preexistingScratchVersionIds,
      selectedCopy: existing.selectedCopy,
      source: existing.source,
    }
    await this.replaceJsonCheckpoint(
      drillId,
      `COPY_INTENT#${intentDigest}`,
      'mukuroji-restore-drill-copy-intent',
      existing,
      completed,
    )
  }

  /** @inheritdoc */
  async listCompletedFileCopies(
    drillId: string,
  ): Promise<readonly RestoreDrillRecordedScratchObjectVersion[]> {
    const values = await this.queryJsonCheckpoints(drillId, 'COPY_INTENT#')
    const copies: RestoreDrillRecordedScratchObjectVersion[] = []
    for (const value of values) {
      const intent = parseCopyIntent(value, drillId)
      if (intent.completedCopy) copies.push(intent.completedCopy)
    }
    return copies.sort(compareScratchVersions)
  }

  /** @inheritdoc */
  async listCreatedFileCopies(
    drillId: string,
  ): Promise<readonly RestoreDrillCreatedScratchObjectVersion[]> {
    const values = await this.queryJsonCheckpoints(drillId, 'COPY_INTENT#')
    const copies: RestoreDrillCreatedScratchObjectVersion[] = []
    for (const value of values) {
      const intent = parseCopyIntent(value, drillId)
      copies.push(...(intent.createdCopies ?? []))
    }
    return copies.sort(compareCreatedScratchVersions)
  }

  /** @inheritdoc */
  async listCopyIntents(drillId: string): Promise<readonly RestoreDrillCopyIntent[]> {
    const values = await this.queryJsonCheckpoints(drillId, 'COPY_INTENT#')
    return values.map((value) => parseCopyIntent(value, drillId))
      .sort((left, right) => left.intentDigest.localeCompare(right.intentDigest))
  }

  /** @inheritdoc */
  async readCopyIntentInventoryPage(
    drillId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<RestoreDrillCopyIntentInventoryPage> {
    if (cursor !== undefined && !isCopyIntentCursor(cursor)) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const page = await this.queryJsonCheckpointPage(
      drillId,
      'COPY_INTENT#',
      cursor,
      limit,
    )
    return {
      entries: page.entries.map((entry) => ({
        cursor: entry.recordKey,
        intent: parseCopyIntent(entry.value, drillId),
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
  }

  /** @inheritdoc */
  async reconcileCopyIntentVersions(
    drillId: string,
    intentDigest: string,
    discovered: readonly RestoreDrillCreatedScratchObjectVersion[],
  ): Promise<RestoreDrillCopyIntent> {
    const existing = await this.readCopyIntent(drillId, intentDigest)
    if (!existing) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    const merged = mergeCopyIntentVersions(existing, discovered, drillId)
    await this.putCleanupTargets(drillId, merged.createdCopies ?? [])
    if (stableJson(existing) !== stableJson(merged)) {
      await this.replaceJsonCheckpoint(
        drillId,
        `COPY_INTENT#${intentDigest}`,
        'mukuroji-restore-drill-copy-intent',
        existing,
        merged,
      )
    }
    return merged
  }

  /** @inheritdoc */
  async readCopyReconciliationCheckpoint(
    drillId: string,
  ): Promise<RestoreDrillCopyReconciliationCheckpoint> {
    const value = await this.readJsonCheckpoint(drillId, 'COPY_RECONCILIATION')
    return value === undefined
      ? {
          complete: false,
          createdCopyCount: 0,
          intentCount: 0,
          pass: 1,
          started: false,
        }
      : parseCopyReconciliationCheckpoint(value)
  }

  /** @inheritdoc */
  async writeCopyReconciliationCheckpoint(
    drillId: string,
    expected: RestoreDrillCopyReconciliationCheckpoint,
    next: RestoreDrillCopyReconciliationCheckpoint,
  ): Promise<boolean> {
    return this.writeJsonCheckpointCas(
      drillId,
      'COPY_RECONCILIATION',
      'mukuroji-restore-drill-copy-reconciliation',
      expected,
      next,
      !expected.started,
    )
  }

  /** @inheritdoc */
  async readExportListingCheckpoint(
    drillId: string,
    target: RestoreDrillTableTarget,
  ): Promise<RestoreDrillExportListingCheckpoint> {
    const value = await this.readJsonCheckpoint(
      drillId,
      `EXPORT_LISTING#${target}`,
    )
    return value === undefined
      ? { complete: false, objectCount: 0, pageCount: 0, started: false }
      : parseExportListingCheckpoint(value)
  }

  /** @inheritdoc */
  async writeExportListingPage(
    drillId: string,
    target: RestoreDrillTableTarget,
    expected: RestoreDrillExportListingCheckpoint,
    versions: readonly RestoreDrillRecordedExportObjectVersion[],
    nextCursor?: RestoreDrillExportObjectVersionCursor,
  ): Promise<void> {
    const next = createRestoreDrillExportListingCheckpoint(
      expected,
      versions.length,
      nextCursor,
    )
    await this.putCleanupTargets(drillId, versions)
    for (let offset = 0; offset < versions.length; offset += CLEANUP_BATCH_SIZE) {
      const group = versions.slice(offset, offset + CLEANUP_BATCH_SIZE)
      await Promise.all(group.map(async (version) => {
        const digest = sha256Hex(`${version.objectKey}\0${version.objectVersionId}`)
        await Promise.all([
          this.putJsonCheckpointOnce(
            drillId,
            `EXPORT_OBJECT#${digest}`,
            'mukuroji-restore-drill-export-object',
            version,
          ),
          this.putJsonCheckpointOnce(
            drillId,
            verificationExportObjectRecordKey(version),
            'mukuroji-restore-drill-verification-export-object',
            version,
          ),
        ])
      }))
    }
    const current = await this.readExportListingCheckpoint(drillId, target)
    if (stableJson(current) !== stableJson(expected)) {
      if (stableJson(current) === stableJson(next)) return
      throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
    }
    const advanced = await this.writeJsonCheckpointCas(
      drillId,
      `EXPORT_LISTING#${target}`,
      'mukuroji-restore-drill-export-listing',
      expected,
      next,
      !expected.started,
    )
    if (!advanced) throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }

  /** @inheritdoc */
  async listExportObjectVersions(
    drillId: string,
  ): Promise<readonly RestoreDrillRecordedExportObjectVersion[]> {
    const values = await this.queryJsonCheckpoints(drillId, 'EXPORT_OBJECT#')
    return values.map(parseRecordedExportObjectVersion).sort(compareExportVersions)
  }

  /** @inheritdoc */
  async readVerificationExportObjectVersion(
    drillId: string,
    exportArnDigest: string,
    objectKey: string,
  ): Promise<RestoreDrillRecordedExportObjectVersion | undefined> {
    if (!isHexDigest(exportArnDigest) || !isNonEmptyString(objectKey, 2_048)) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const prefix = verificationExportObjectRecordPrefix(exportArnDigest, objectKey)
    const output = await this.document.send(new QueryCommand({
      ConsistentRead: true,
      ExpressionAttributeNames: { '#recordKey': 'recordKey', '#scopeKey': 'scopeKey' },
      ExpressionAttributeValues: {
        ':recordPrefix': prefix,
        ':scopeKey': runScopeKey(drillId),
      },
      KeyConditionExpression:
        '#scopeKey = :scopeKey AND begins_with(#recordKey, :recordPrefix)',
      Limit: 2,
      TableName: this.tableName,
    }))
    const items = output.Items ?? []
    if (items.length > 1 || output.LastEvaluatedKey) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    const payloadJson = items[0]?.payloadJson
    if (payloadJson === undefined) return undefined
    if (typeof payloadJson !== 'string' || payloadJson.length > 350_000) invalidRunState()
    let value: unknown
    try {
      value = JSON.parse(payloadJson)
    } catch {
      invalidRunState()
    }
    const version = parseRecordedExportObjectVersion(value)
    if (version.exportArnDigest !== exportArnDigest || version.objectKey !== objectKey) {
      invalidRunState()
    }
    return version
  }

  /** @inheritdoc */
  async readMultipartUploadListingCheckpoint(
    drillId: string,
  ): Promise<RestoreDrillMultipartUploadListingCheckpoint> {
    const value = await this.readJsonCheckpoint(drillId, 'MULTIPART_LISTING')
    return value === undefined
      ? { complete: false, pageCount: 0, started: false, uploadCount: 0 }
      : parseMultipartUploadListingCheckpoint(value)
  }

  /** @inheritdoc */
  async writeMultipartUploadListingPage(
    drillId: string,
    expected: RestoreDrillMultipartUploadListingCheckpoint,
    uploads: readonly RestoreDrillRecordedMultipartUpload[],
    nextCursor?: RestoreDrillMultipartUploadCursor,
  ): Promise<void> {
    const next = createNextMultipartUploadListingCheckpoint(
      expected,
      uploads.length,
      nextCursor,
    )
    await this.putCleanupTargets(drillId, uploads)
    for (let offset = 0; offset < uploads.length; offset += CLEANUP_BATCH_SIZE) {
      const group = uploads.slice(offset, offset + CLEANUP_BATCH_SIZE)
      await Promise.all(group.map(async (upload) => {
        const digest = sha256Hex(`${upload.objectKey}\0${upload.uploadId}`)
        await this.putJsonCheckpointOnce(
          drillId,
          `MULTIPART_UPLOAD#${digest}`,
          'mukuroji-restore-drill-multipart-upload',
          upload,
        )
      }))
    }
    const current = await this.readMultipartUploadListingCheckpoint(drillId)
    if (stableJson(current) !== stableJson(expected)) {
      if (stableJson(current) === stableJson(next)) return
      throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
    }
    const advanced = await this.writeJsonCheckpointCas(
      drillId,
      'MULTIPART_LISTING',
      'mukuroji-restore-drill-multipart-listing',
      expected,
      next,
      !expected.started,
    )
    if (!advanced) throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }

  /** @inheritdoc */
  async listMultipartUploads(
    drillId: string,
  ): Promise<readonly RestoreDrillRecordedMultipartUpload[]> {
    const values = await this.queryJsonCheckpoints(drillId, 'MULTIPART_UPLOAD#')
    return values.map(parseRecordedMultipartUpload).sort(compareMultipartUploads)
  }

  /** @inheritdoc */
  async writeExportCompletion(
    drillId: string,
    completion: RestoreDrillExportCompletion,
  ): Promise<void> {
    await this.putJsonCheckpointOnce(
      drillId,
      `EXPORT_COMPLETION#${completion.target}`,
      'mukuroji-restore-drill-export-completion',
      completion,
    )
  }

  /** @inheritdoc */
  async listExportCompletions(
    drillId: string,
  ): Promise<readonly RestoreDrillExportCompletion[]> {
    const values = await this.queryJsonCheckpoints(drillId, 'EXPORT_COMPLETION#')
    return values.map(parseExportCompletion).sort(
      (left, right) => RESTORE_DRILL_TABLE_TARGETS.indexOf(left.target) -
        RESTORE_DRILL_TABLE_TARGETS.indexOf(right.target),
    )
  }

  /** @inheritdoc */
  async writeVerificationCheckpoint(
    drillId: string,
    result: RestoreDrillVerificationResult,
  ): Promise<void> {
    await this.putJsonCheckpointOnce(
      drillId,
      'VERIFICATION',
      'mukuroji-restore-drill-verification',
      result,
    )
  }

  /** @inheritdoc */
  async readVerificationCheckpoint(
    drillId: string,
  ): Promise<RestoreDrillVerificationResult | undefined> {
    const value = await this.readJsonCheckpoint(drillId, 'VERIFICATION')
    return value === undefined ? undefined : parseVerificationResult(value)
  }

  /** @inheritdoc */
  async readVerificationProgress(
    drillId: string,
  ): Promise<RestoreDrillVerificationProgress> {
    const value = await this.readJsonCheckpoint(drillId, 'VERIFICATION_PROGRESS')
    return value === undefined
      ? initialVerificationProgress()
      : parseVerificationProgress(value)
  }

  /** @inheritdoc */
  async writeVerificationProgress(
    drillId: string,
    expected: RestoreDrillVerificationProgress,
    next: RestoreDrillVerificationProgress,
  ): Promise<boolean> {
    const exactExpected = parseVerificationProgress(expected)
    const exactNext = parseVerificationProgress(next)
    if (
      exactNext.revision !== exactExpected.revision + 1 ||
      (exactExpected.revision === 0 &&
        stableJson(exactExpected) !== stableJson(initialVerificationProgress()))
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    if (exactExpected.revision === 0) {
      try {
        await this.document.send(new PutCommand({
          ConditionExpression:
            'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          Item: {
            kind: 'mukuroji-restore-drill-verification-progress',
            payloadJson: stableJson(exactNext),
            recordKey: 'VERIFICATION_PROGRESS',
            scopeKey: runScopeKey(drillId),
          },
          TableName: this.tableName,
        }))
        return true
      } catch (error: unknown) {
        let current: RestoreDrillVerificationProgress
        try {
          current = await this.readVerificationProgress(drillId)
        } catch {
          throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
        }
        if (stableJson(current) === stableJson(exactNext)) return true
        if (isConditionalAwsFailure(error)) return false
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
    }
    try {
      await this.replaceJsonCheckpoint(
        drillId,
        'VERIFICATION_PROGRESS',
        'mukuroji-restore-drill-verification-progress',
        exactExpected,
        exactNext,
      )
      return true
    } catch (error: unknown) {
      if (!isConditionalConflict(error)) throw error
      const current = await this.readVerificationProgress(drillId)
      return stableJson(current) === stableJson(exactNext)
    }
  }

  /** @inheritdoc */
  async writeVerificationManifestFiles(
    drillId: string,
    target: RestoreDrillTableTarget,
    files: readonly RestoreDrillExportDataFile[],
  ): Promise<void> {
    if (
      !isTableTarget(target) ||
      files.length < 1 ||
      files.length > MAX_VERIFICATION_MANIFEST_FILES_PER_TARGET
    ) {
      throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
    }
    const objectKeys = new Set<string>()
    let itemCount = 0
    for (let index = 0; index < files.length; index += 1) {
      const file = parseVerificationManifestFile(files[index])
      if (
        objectKeys.has(file.objectKey) ||
        !Number.isSafeInteger(itemCount + file.itemCount) ||
        itemCount + file.itemCount > MAX_VERIFICATION_RECORDS_PER_TARGET
      ) {
        throw new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED')
      }
      objectKeys.add(file.objectKey)
      itemCount += file.itemCount
      await this.putJsonCheckpointOnce(
        drillId,
        verificationManifestRecordKey(target, index),
        'mukuroji-restore-drill-verification-manifest-entry',
        { file, index, target },
      )
    }
  }

  /** @inheritdoc */
  async readVerificationManifestFile(
    drillId: string,
    target: RestoreDrillTableTarget,
    index: number,
  ): Promise<RestoreDrillExportDataFile | undefined> {
    if (
      !isTableTarget(target) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= MAX_VERIFICATION_MANIFEST_FILES_PER_TARGET
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const value = await this.readJsonCheckpoint(
      drillId,
      verificationManifestRecordKey(target, index),
    )
    if (value === undefined) return undefined
    const record = requireRecord(value, 'RUN_STATE_INVALID')
    if (
      !sameStringVector(Object.keys(record).sort(), ['file', 'index', 'target']) ||
      record.index !== index ||
      record.target !== target
    ) invalidRunState()
    return parseVerificationManifestFile(record.file)
  }

  /** @inheritdoc */
  async writeVerificationPartitionDigests(
    drillId: string,
    role: RestoreDrillVerificationPartitionRole,
    target: RestoreDrillTableTarget,
    digests: readonly string[],
  ): Promise<void> {
    if (
      (role !== 'file' && role !== 'restore' && role !== 'source') ||
      !isTableTarget(target) ||
      digests.length > MAX_VERIFICATION_RECORDS_PER_TARGET ||
      !isSortedUniqueHexDigests(digests)
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    for (let offset = 0; offset < digests.length; offset += CLEANUP_BATCH_SIZE) {
      const group = digests.slice(offset, offset + CLEANUP_BATCH_SIZE)
      await Promise.all(group.map(async (digest) => {
        await this.putJsonCheckpointOnce(
          drillId,
          verificationPartitionRecordKey(role, target, digest),
          'mukuroji-restore-drill-verification-partition',
          { digest, role, target },
        )
      }))
    }
  }

  /** @inheritdoc */
  async readVerificationPartitionCountPage(
    drillId: string,
    role: RestoreDrillVerificationPartitionRole,
    target: RestoreDrillTableTarget,
    cursor?: RestoreDrillVerificationPartitionCursor,
  ): Promise<RestoreDrillVerificationPartitionCountPage> {
    if (
      (role !== 'file' && role !== 'restore' && role !== 'source') ||
      !isTableTarget(target)
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const prefix = verificationPartitionRecordPrefix(role, target)
    if (cursor !== undefined && !cursor.recordKey.startsWith(prefix)) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const output = await this.document.send(new QueryCommand({
      ConsistentRead: true,
      ...(cursor ? {
        ExclusiveStartKey: {
          recordKey: cursor.recordKey,
          scopeKey: runScopeKey(drillId),
        },
      } : {}),
      ExpressionAttributeNames: { '#recordKey': 'recordKey', '#scopeKey': 'scopeKey' },
      ExpressionAttributeValues: {
        ':recordPrefix': prefix,
        ':scopeKey': runScopeKey(drillId),
      },
      KeyConditionExpression:
        '#scopeKey = :scopeKey AND begins_with(#recordKey, :recordPrefix)',
      Limit: 1_000,
      Select: 'COUNT',
      TableName: this.tableName,
    }))
    if (
      !isNonNegativeInteger(output.Count) ||
      output.Count > 1_000 ||
      (output.ScannedCount !== undefined && output.ScannedCount !== output.Count)
    ) invalidRunState()
    const nextRecordKey = output.LastEvaluatedKey?.recordKey
    if (nextRecordKey === undefined) return { count: output.Count }
    if (
      typeof nextRecordKey !== 'string' ||
      !nextRecordKey.startsWith(prefix) ||
      nextRecordKey === cursor?.recordKey
    ) invalidRunState()
    return { count: output.Count, nextCursor: { recordKey: nextRecordKey } }
  }

  /** @inheritdoc */
  async writeVerificationSemanticClaims(
    drillId: string,
    claims: readonly RestoreDrillSemanticClaim[],
    digestKey: Uint8Array,
  ): Promise<void> {
    if (
      digestKey.byteLength !== 32 ||
      claims.length > MAX_VERIFICATION_SEMANTIC_CLAIMS_PER_PAGE
    ) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    const exactClaims = claims.map(parseSemanticClaimForWrite)
    for (let offset = 0; offset < exactClaims.length; offset += CLEANUP_BATCH_SIZE) {
      const group = exactClaims.slice(offset, offset + CLEANUP_BATCH_SIZE)
      const serialGroups = new Map<string, RestoreDrillSemanticClaim[]>()
      for (let index = 0; index < group.length; index += 1) {
        const claim = group[index]
        if (!claim) invalidRunState()
        const serialKey = claim.kind === 'audit-candidate'
          ? `audit:${claim.resourceToken}`
          : `independent:${index}`
        const serialGroup = serialGroups.get(serialKey) ?? []
        serialGroup.push(claim)
        serialGroups.set(serialKey, serialGroup)
      }
      await Promise.all([...serialGroups.values()].map(async (serialGroup) => {
        for (const claim of serialGroup) {
          await this.writeSemanticClaim(drillId, claim, digestKey)
        }
      }))
    }
  }

  /** Writes one parsed semantic claim through its exact durable representation. */
  private async writeSemanticClaim(
    drillId: string,
    claim: RestoreDrillSemanticClaim,
    digestKey: Uint8Array,
  ): Promise<void> {
    if (claim.kind === 'audit-candidate') {
      await this.writeSemanticAuditCandidate(drillId, claim, digestKey)
      return
    }
    if (claim.kind === 'unique') {
      await this.writeSemanticUniqueClaim(drillId, claim)
      return
    }
    const recordKey = semanticClaimRecordKey(claim)
    await this.putJsonCheckpointOnce(
      drillId,
      recordKey,
      `mukuroji-restore-drill-semantic-${claim.kind}`,
      claim,
    )
  }

  /** @inheritdoc */
  async readVerificationSemanticRequirementPage(
    drillId: string,
    source: 'audit' | 'requirement',
    cursor: RestoreDrillSemanticRequirementCursor | undefined,
    limit: number,
  ): Promise<RestoreDrillSemanticRequirementPage> {
    const prefix = source === 'audit'
      ? 'VERIFY_SEMANTIC_AUDIT_LATEST#'
      : 'VERIFY_SEMANTIC_REQUIREMENT#'
    if (cursor !== undefined && !cursor.recordKey.startsWith(prefix)) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const page = await this.queryJsonCheckpointPage(
      drillId,
      prefix,
      cursor?.recordKey,
      limit,
    )
    const requirements: RestoreDrillSemanticRequirement[] = []
    for (const entry of page.entries) {
      if (source === 'requirement') {
        requirements.push(parseSemanticRequirement(entry.value))
        continue
      }
      const latest = parseSemanticAuditLatest(entry.value)
      if (latest.requirement) requirements.push(latest.requirement)
    }
    return {
      requirements,
      ...(page.nextCursor
        ? { nextCursor: { recordKey: page.nextCursor } }
        : {}),
    }
  }

  /** @inheritdoc */
  async evaluateVerificationSemanticRequirements(
    drillId: string,
    requirements: readonly RestoreDrillSemanticRequirement[],
  ): Promise<void> {
    if (requirements.length > 100) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    for (const value of requirements) {
      const requirement = parseSemanticRequirement(value)
      const failureCode = await evaluateRestoreDrillSemanticRequirement(
        requirement,
        (factToken) => this.hasSemanticFact(drillId, factToken),
      )
      if (!failureCode) continue
      const failure: Extract<
        RestoreDrillSemanticClaim,
        { readonly kind: 'failure' }
      > = {
        failureCode,
        failureToken: sha256Hex(
          `semantic-requirement\0${requirement.requirementToken}\0${failureCode}`,
        ),
        kind: 'failure',
      }
      await this.putJsonCheckpointOnce(
        drillId,
        semanticClaimRecordKey(failure),
        'mukuroji-restore-drill-semantic-failure',
        failure,
      )
    }
  }

  /** @inheritdoc */
  async hasVerificationSemanticFailures(drillId: string): Promise<boolean> {
    const prefix = 'VERIFY_SEMANTIC_FAILURE#'
    const output = await this.document.send(new QueryCommand({
      ConsistentRead: true,
      ExpressionAttributeNames: { '#recordKey': 'recordKey', '#scopeKey': 'scopeKey' },
      ExpressionAttributeValues: {
        ':recordPrefix': prefix,
        ':scopeKey': runScopeKey(drillId),
      },
      KeyConditionExpression:
        '#scopeKey = :scopeKey AND begins_with(#recordKey, :recordPrefix)',
      Limit: 1,
      Select: 'COUNT',
      TableName: this.tableName,
    }))
    if (!isNonNegativeInteger(output.Count) || output.Count > 1) invalidRunState()
    return output.Count === 1
  }

  /** Writes one uniqueness owner or atomically records a collision against its exact owner. */
  private async writeSemanticUniqueClaim(
    drillId: string,
    claim: Extract<RestoreDrillSemanticClaim, { readonly kind: 'unique' }>,
  ): Promise<void> {
    const recordKey = semanticClaimRecordKey(claim)
    let existing = await this.readJsonCheckpoint(drillId, recordKey)
    if (existing === undefined) {
      try {
        await this.putJsonCheckpointOnce(
          drillId,
          recordKey,
          'mukuroji-restore-drill-semantic-unique',
          claim,
        )
        return
      } catch {
        existing = await this.readJsonCheckpoint(drillId, recordKey)
        if (existing === undefined) {
          throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
        }
      }
    }
    const owner = parseSemanticUniqueClaim(existing)
    if (
      owner.originToken === claim.originToken &&
      owner.duplicateFailureCode === claim.duplicateFailureCode
    ) return
    const origins = [owner.originToken, claim.originToken].sort()
    const failure: Extract<
      RestoreDrillSemanticClaim,
      { readonly kind: 'failure' }
    > = {
      failureCode: claim.duplicateFailureCode,
      failureToken: sha256Hex(
        `semantic-unique-collision\0${claim.uniqueToken}\0${origins.join('\0')}`,
      ),
      kind: 'failure',
    }
    const failureRecordKey = semanticClaimRecordKey(failure)
    const ownerJson = stableJson(owner)
    const failureJson = stableJson(failure)
    try {
      await this.document.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              ConditionExpression: '#payloadJson = :ownerJson',
              ExpressionAttributeNames: { '#payloadJson': 'payloadJson' },
              ExpressionAttributeValues: { ':ownerJson': ownerJson },
              Key: { recordKey, scopeKey: runScopeKey(drillId) },
              TableName: this.tableName,
            },
          },
          {
            Put: {
              Item: {
                kind: 'mukuroji-restore-drill-semantic-failure',
                payloadJson: failureJson,
                recordKey: failureRecordKey,
                scopeKey: runScopeKey(drillId),
              },
              TableName: this.tableName,
            },
          },
        ],
      }))
    } catch {
      const observed = await this.readJsonCheckpoint(drillId, failureRecordKey)
      if (stableJson(observed) !== failureJson) {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
    }
  }

  /** Conditionally retains the exact latest Audit candidate using HMAC-only order state. */
  private async writeSemanticAuditCandidate(
    drillId: string,
    claim: RestoreDrillSemanticAuditCandidate,
    digestKey: Uint8Array,
  ): Promise<void> {
    const recordKey = `VERIFY_SEMANTIC_AUDIT_LATEST#${claim.resourceToken}`
    const next = createSemanticAuditLatest(claim, digestKey)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rawExisting = await this.readJsonCheckpoint(drillId, recordKey)
      if (rawExisting === undefined) {
        if (await this.writeJsonCheckpointCas(
          drillId,
          recordKey,
          'mukuroji-restore-drill-semantic-audit-latest',
          undefined,
          next,
          true,
        )) return
        continue
      }
      const existing = parseSemanticAuditLatest(rawExisting)
      const comparison = compareSemanticAuditOrder(
        claim.eventOrder,
        existing.orderTokens,
        claim.resourceToken,
        digestKey,
      )
      if (comparison < 0) return
      if (comparison === 0) {
        if (stableJson(existing) !== stableJson(next)) invalidRunState()
        return
      }
      if (await this.writeJsonCheckpointCas(
        drillId,
        recordKey,
        'mukuroji-restore-drill-semantic-audit-latest',
        existing,
        next,
        false,
      )) return
    }
    throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }

  /** Checks one opaque fact prefix with a strongly consistent bounded query. */
  private async hasSemanticFact(drillId: string, factToken: string): Promise<boolean> {
    const prefix = `VERIFY_SEMANTIC_FACT#${factToken}#`
    const output = await this.document.send(new QueryCommand({
      ConsistentRead: true,
      ExpressionAttributeNames: { '#recordKey': 'recordKey', '#scopeKey': 'scopeKey' },
      ExpressionAttributeValues: {
        ':recordPrefix': prefix,
        ':scopeKey': runScopeKey(drillId),
      },
      KeyConditionExpression:
        '#scopeKey = :scopeKey AND begins_with(#recordKey, :recordPrefix)',
      Limit: 1,
      Select: 'COUNT',
      TableName: this.tableName,
    }))
    if (!isNonNegativeInteger(output.Count) || output.Count > 1) invalidRunState()
    return output.Count === 1
  }

  /** @inheritdoc */
  async readCleanupProgress(drillId: string): Promise<RestoreDrillCleanupProgress> {
    const value = await this.readJsonCheckpoint(
      drillId,
      'CLEANUP_PROGRESS',
      cleanupProgressScopeKey(drillId),
    )
    return value === undefined
      ? {
          absenceReceiptCount: 0,
          exportObjectIndex: 0,
          fileObjectIndex: 0,
          multipartUploadIndex: 0,
          tableIndex: 0,
        }
      : parseCleanupProgress(value, drillId)
  }

  /** @inheritdoc */
  async readCleanupInventoryPage(
    drillId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<RestoreDrillCleanupInventoryPage> {
    if (cursor !== undefined && !isCleanupTargetCursor(cursor)) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const page = await this.queryJsonCheckpointPage(
      drillId,
      'CLEANUP_TARGET#',
      cursor,
      limit,
      cleanupLedgerScopeKey(drillId),
    )
    const entries = page.entries.map((entry): RestoreDrillCleanupInventoryEntry => {
      const target = parseCleanupTarget(entry.value)
      if (entry.recordKey !== cleanupTargetRecordKey(target)) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      return { cursor: entry.recordKey, target }
    })
    return {
      entries,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
  }

  /** @inheritdoc */
  async readCleanupLedgerControl(
    drillId: string,
  ): Promise<RestoreDrillCleanupLedgerControl> {
    const output = await this.document.send(new GetCommand({
      ConsistentRead: true,
      Key: {
        recordKey: 'CLEANUP_LEDGER_CONTROL',
        scopeKey: cleanupLedgerScopeKey(drillId),
      },
      TableName: this.tableName,
    }))
    if (!output.Item) return { count: 0, revision: 0 }
    if (
      output.Item.kind !== 'mukuroji-restore-drill-cleanup-ledger-control' ||
      !isPositiveInteger(output.Item.count) ||
      output.Item.count !== output.Item.revision
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    return { count: output.Item.count, revision: output.Item.revision }
  }

  /** @inheritdoc */
  async readCleanupScopeCheckpoint(
    drillId: string,
  ): Promise<RestoreDrillCleanupScopeCheckpoint> {
    const value = await this.readJsonCheckpoint(
      drillId,
      'CLEANUP_SCOPE',
      cleanupLedgerScopeKey(drillId),
    )
    return value === undefined ? emptyCleanupScopeCheckpoint() : parseCleanupScopeCheckpoint(value)
  }

  /** @inheritdoc */
  async writeCleanupScopeCheckpoint(
    drillId: string,
    expected: RestoreDrillCleanupScopeCheckpoint,
    next: RestoreDrillCleanupScopeCheckpoint,
  ): Promise<boolean> {
    if (next.complete) {
      if (
        next.ledgerCount === undefined ||
        next.ledgerRevision === undefined ||
        next.ledgerCount !== next.ledgerRevision
      ) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      const expectedJson = stableJson(expected)
      const payloadJson = stableJson(next)
      try {
        await this.document.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                ConditionExpression: expected.started
                  ? '#payloadJson = :expectedJson'
                  : 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
                ...(expected.started
                  ? {
                      ExpressionAttributeNames: { '#payloadJson': 'payloadJson' },
                      ExpressionAttributeValues: { ':expectedJson': expectedJson },
                    }
                  : {}),
                Item: {
                  kind: 'mukuroji-restore-drill-cleanup-scope',
                  payloadJson,
                  recordKey: 'CLEANUP_SCOPE',
                  sealed: true,
                  scopeKey: cleanupLedgerScopeKey(drillId),
                },
                TableName: this.tableName,
              },
            },
            {
              ConditionCheck: {
                ConditionExpression: next.ledgerRevision === 0
                  ? 'attribute_not_exists(#count) AND attribute_not_exists(#revision)'
                  : '#count = :count AND #revision = :revision',
                ExpressionAttributeNames: {
                  '#count': 'count',
                  '#revision': 'revision',
                },
                ...(next.ledgerRevision === 0
                  ? {}
                  : {
                      ExpressionAttributeValues: {
                        ':count': next.ledgerCount,
                        ':revision': next.ledgerRevision,
                      },
                    }),
                Key: {
                  recordKey: 'CLEANUP_LEDGER_CONTROL',
                  scopeKey: cleanupLedgerScopeKey(drillId),
                },
                TableName: this.tableName,
              },
            },
          ],
        }))
        return true
      } catch (error: unknown) {
        const current = await this.readCleanupScopeCheckpoint(drillId)
        if (stableJson(current) === payloadJson) {
          const control = await this.readCleanupLedgerControl(drillId)
          if (
            control.count === next.ledgerCount &&
            control.revision === next.ledgerRevision
          ) return true
        }
        if (isConditionalAwsFailure(error)) return false
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
    }
    return this.writeJsonCheckpointCas(
      drillId,
      'CLEANUP_SCOPE',
      'mukuroji-restore-drill-cleanup-scope',
      expected,
      next,
      !expected.started,
      cleanupLedgerScopeKey(drillId),
    )
  }

  /** @inheritdoc */
  async writeCleanupProgress(
    drillId: string,
    expected: RestoreDrillCleanupProgress,
    next: RestoreDrillCleanupProgress,
  ): Promise<boolean> {
    return this.writeJsonCheckpointCas(
      drillId,
      'CLEANUP_PROGRESS',
      'mukuroji-restore-drill-cleanup-progress',
      expected,
      next,
      expected.absenceReceiptCount === 0 && expected.completedAt === undefined,
      cleanupProgressScopeKey(drillId),
    )
  }

  /** @inheritdoc */
  async recordSuccessfulVerification(drillId: string, completedAt: string): Promise<void> {
    try {
      await this.document.send(new UpdateCommand({
        ConditionExpression:
          '#activeDrillId = :drillId AND (attribute_not_exists(#lastSuccessfulVerifiedAt) OR #lastSuccessfulVerifiedAt <> :completedAt)',
        ExpressionAttributeNames: {
          '#activeDrillId': 'activeDrillId',
          '#lastSuccessfulVerifiedAt': 'lastSuccessfulVerifiedAt',
          '#revision': 'revision',
        },
        ExpressionAttributeValues: {
          ':completedAt': completedAt,
          ':drillId': drillId,
          ':one': 1,
        },
        Key: cadenceKey(),
        TableName: this.tableName,
        UpdateExpression:
          'SET #lastSuccessfulVerifiedAt = :completedAt, #revision = #revision + :one',
      }))
    } catch {
      try {
        const cadence = await this.readCadence()
        if (
          cadence.activeDrillId === drillId &&
          cadence.lastSuccessfulVerifiedAt === completedAt
        ) return
      } catch {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** @inheritdoc */
  async releaseActiveRun(drillId: string): Promise<void> {
    try {
      await this.document.send(new UpdateCommand({
        ConditionExpression: '#activeDrillId = :drillId',
        ExpressionAttributeNames: {
          '#activeDrillId': 'activeDrillId',
          '#revision': 'revision',
        },
        ExpressionAttributeValues: { ':drillId': drillId, ':one': 1 },
        Key: cadenceKey(),
        TableName: this.tableName,
        UpdateExpression: 'REMOVE #activeDrillId SET #revision = #revision + :one',
      }))
    } catch {
      try {
        const cadence = await this.readCadence()
        if (cadence.activeDrillId !== drillId) return
      } catch {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** @inheritdoc */
  async readActiveDrillId(): Promise<string | undefined> {
    return (await this.readCadence()).activeDrillId
  }

  /** Writes deduplicated cleanup-ledger targets in bounded atomic groups. */
  private async putCleanupTargets(
    drillId: string,
    targets: readonly RestoreDrillCleanupTarget[],
  ): Promise<void> {
    const deduplicated = new Map<string, string>()
    for (const target of targets) {
      const recordKey = cleanupTargetRecordKey(target)
      const payloadJson = stableJson(target)
      const previous = deduplicated.get(recordKey)
      if (previous !== undefined && previous !== payloadJson) {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      deduplicated.set(recordKey, payloadJson)
    }
    const records = [...deduplicated].map(([recordKey, payloadJson]) => ({
      payloadJson,
      recordKey,
    }))
    for (let offset = 0; offset < records.length; offset += CLEANUP_BATCH_SIZE) {
      await this.putCleanupTargetGroup(
        drillId,
        records.slice(offset, offset + CLEANUP_BATCH_SIZE),
      )
    }
  }

  /** Atomically inserts one bounded ledger group and advances its generation by the same count. */
  private async putCleanupTargetGroup(
    drillId: string,
    records: readonly {
      /** Canonical target JSON. */
      readonly payloadJson: string
      /** Opaque deterministic ledger record key. */
      readonly recordKey: string
    }[],
  ): Promise<void> {
    const ledgerScopeKey = cleanupLedgerScopeKey(drillId)
    let pending = [...records]
    for (
      let attempt = 0;
      attempt < CLEANUP_LEDGER_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      const observations = await Promise.all(pending.map(async (record) => ({
        existing: await this.readJsonCheckpoint(
          drillId,
          record.recordKey,
          ledgerScopeKey,
        ),
        record,
      })))
      const missing: typeof pending = []
      for (const observation of observations) {
        if (observation.existing === undefined) {
          missing.push(observation.record)
        } else if (stableJson(observation.existing) !== observation.record.payloadJson) {
          throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
        }
      }
      if (missing.length === 0) return
      try {
        await this.document.send(new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                ConditionExpression: 'attribute_not_exists(#sealed)',
                ExpressionAttributeNames: { '#sealed': 'sealed' },
                Key: { recordKey: 'CLEANUP_SCOPE', scopeKey: ledgerScopeKey },
                TableName: this.tableName,
              },
            },
            ...missing.map((record) => ({
              Put: {
                ConditionExpression:
                  'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
                Item: {
                  kind: 'mukuroji-restore-drill-cleanup-target',
                  payloadJson: record.payloadJson,
                  recordKey: record.recordKey,
                  scopeKey: ledgerScopeKey,
                },
                TableName: this.tableName,
              },
            })),
            {
              Update: {
                ExpressionAttributeNames: {
                  '#count': 'count',
                  '#kind': 'kind',
                  '#revision': 'revision',
                },
                ExpressionAttributeValues: {
                  ':delta': missing.length,
                  ':kind': 'mukuroji-restore-drill-cleanup-ledger-control',
                  ':zero': 0,
                },
                Key: {
                  recordKey: 'CLEANUP_LEDGER_CONTROL',
                  scopeKey: ledgerScopeKey,
                },
                TableName: this.tableName,
                UpdateExpression:
                  'SET #kind = :kind, #count = if_not_exists(#count, :zero) + :delta, #revision = if_not_exists(#revision, :zero) + :delta',
              },
            },
          ],
        }))
        return
      } catch (error: unknown) {
        if (!isConditionalAwsFailure(error)) {
          const reconciled = await Promise.all(missing.map(async (record) => ({
            existing: await this.readJsonCheckpoint(
              drillId,
              record.recordKey,
              ledgerScopeKey,
            ),
            record,
          })))
          if (reconciled.every((observation) =>
            observation.existing !== undefined &&
            stableJson(observation.existing) === observation.record.payloadJson
          )) return
          throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
        }
        pending = missing
      }
    }
    throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
  }

  /** Reads one JSON payload checkpoint. */
  private async readJsonCheckpoint(
    drillId: string,
    recordKey: string,
    scopeKey = runScopeKey(drillId),
  ): Promise<unknown> {
    const output = await this.document.send(new GetCommand({
      ConsistentRead: true,
      Key: { scopeKey, recordKey },
      TableName: this.tableName,
    }))
    if (!output.Item) return undefined
    if (typeof output.Item.payloadJson !== 'string' || output.Item.payloadJson.length > 350_000) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    try {
      const value: unknown = JSON.parse(output.Item.payloadJson)
      return value
    } catch {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
  }

  /** Writes one immutable JSON checkpoint and reconciles an identical retry. */
  private async putJsonCheckpointOnce(
    drillId: string,
    recordKey: string,
    kind: string,
    value: unknown,
  ): Promise<void> {
    const payloadJson = stableJson(value)
    if (Buffer.byteLength(payloadJson, 'utf8') > 350_000) {
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
    try {
      await this.document.send(new PutCommand({
        ConditionExpression:
          'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        Item: { kind, payloadJson, recordKey, scopeKey: runScopeKey(drillId) },
        TableName: this.tableName,
      }))
    } catch {
      const existing = await this.readJsonCheckpoint(drillId, recordKey)
      if (stableJson(existing) === payloadJson) return
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** Conditionally replaces one JSON checkpoint and reconciles an identical retry. */
  private async replaceJsonCheckpoint(
    drillId: string,
    recordKey: string,
    kind: string,
    expected: unknown,
    next: unknown,
  ): Promise<void> {
    const expectedJson = stableJson(expected)
    const payloadJson = stableJson(next)
    if (Buffer.byteLength(payloadJson, 'utf8') > 350_000) {
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
    try {
      await this.document.send(new PutCommand({
        ConditionExpression: '#payloadJson = :expectedJson',
        ExpressionAttributeNames: { '#payloadJson': 'payloadJson' },
        ExpressionAttributeValues: { ':expectedJson': expectedJson },
        Item: {
          kind,
          payloadJson,
          recordKey,
          ...(recordKey === 'CLEANUP_SCOPE' && isRecord(next) && next.complete === true
            ? { sealed: true }
            : {}),
          scopeKey: runScopeKey(drillId),
        },
        TableName: this.tableName,
      }))
    } catch (error: unknown) {
      let current: unknown
      try {
        current = await this.readJsonCheckpoint(drillId, recordKey)
      } catch {
        throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
      }
      if (stableJson(current) === payloadJson) return
      if (isConditionalAwsFailure(error)) {
        throw new RestoreDrillOrchestratorFailure('CONCURRENT_UPDATE')
      }
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** Conditionally advances one JSON checkpoint and reconciles an identical retry. */
  private async writeJsonCheckpointCas(
    drillId: string,
    recordKey: string,
    kind: string,
    expected: unknown,
    next: unknown,
    expectedMissing: boolean,
    scopeKey = runScopeKey(drillId),
  ): Promise<boolean> {
    const expectedJson = stableJson(expected)
    const payloadJson = stableJson(next)
    if (Buffer.byteLength(payloadJson, 'utf8') > 350_000) {
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
    try {
      await this.document.send(new PutCommand({
        ConditionExpression: expectedMissing
          ? 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)'
          : '#payloadJson = :expectedJson',
        ...(expectedMissing
          ? {}
          : {
              ExpressionAttributeNames: { '#payloadJson': 'payloadJson' },
              ExpressionAttributeValues: { ':expectedJson': expectedJson },
            }),
        Item: {
          kind,
          payloadJson,
          recordKey,
          ...(recordKey === 'CLEANUP_SCOPE' && isRecord(next) && next.complete === true
            ? { sealed: true }
            : {}),
          scopeKey,
        },
        TableName: this.tableName,
      }))
      return true
    } catch (error: unknown) {
      const current = await this.readJsonCheckpoint(drillId, recordKey, scopeKey)
      if (stableJson(current) === payloadJson) return true
      if (isConditionalAwsFailure(error)) return false
      throw new RestoreDrillOrchestratorFailure('STATE_WRITE_FAILED')
    }
  }

  /** Queries one bounded, strictly advancing JSON checkpoint page. */
  private async queryJsonCheckpointPage(
    drillId: string,
    recordPrefix: string,
    cursor: string | undefined,
    limit: number,
    scopeKey = runScopeKey(drillId),
  ): Promise<{
    readonly entries: readonly { readonly recordKey: string; readonly value: unknown }[]
    readonly nextCursor?: string
  }> {
    if (!isPositiveInteger(limit) || limit > CLEANUP_SCOPE_SEAL_PAGE_SIZE) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    const output = await this.document.send(new QueryCommand({
      ConsistentRead: true,
      ...(cursor
        ? { ExclusiveStartKey: { recordKey: cursor, scopeKey } }
        : {}),
      ExpressionAttributeNames: { '#recordKey': 'recordKey', '#scopeKey': 'scopeKey' },
      ExpressionAttributeValues: {
        ':recordPrefix': recordPrefix,
        ':scopeKey': scopeKey,
      },
      KeyConditionExpression:
        '#scopeKey = :scopeKey AND begins_with(#recordKey, :recordPrefix)',
      Limit: limit,
      TableName: this.tableName,
    }))
    const entries: Array<{ readonly recordKey: string; readonly value: unknown }> = []
    let previous = cursor
    for (const item of output.Items ?? []) {
      if (
        typeof item.recordKey !== 'string' ||
        !item.recordKey.startsWith(recordPrefix) ||
        (previous !== undefined && item.recordKey.localeCompare(previous) <= 0) ||
        typeof item.payloadJson !== 'string' ||
        Buffer.byteLength(item.payloadJson, 'utf8') > 350_000
      ) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      let value: unknown
      try {
        value = JSON.parse(item.payloadJson)
      } catch {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      entries.push({ recordKey: item.recordKey, value })
      previous = item.recordKey
    }
    if (!output.LastEvaluatedKey) return { entries }
    const nextCursor = output.LastEvaluatedKey.recordKey
    if (
      typeof nextCursor !== 'string' ||
      nextCursor !== previous ||
      nextCursor === cursor ||
      !nextCursor.startsWith(recordPrefix)
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    return { entries, nextCursor }
  }

  /** Queries all bounded JSON checkpoint records below one sort-key prefix. */
  private async queryJsonCheckpoints(
    drillId: string,
    recordPrefix: string,
  ): Promise<unknown[]> {
    const values: unknown[] = []
    const recordLimit = jsonCheckpointQueryRecordLimit(recordPrefix)
    const baseInput = {
      ConsistentRead: true,
      ExpressionAttributeNames: { '#recordKey': 'recordKey', '#scopeKey': 'scopeKey' },
      ExpressionAttributeValues: {
        ':recordPrefix': recordPrefix,
        ':scopeKey': runScopeKey(drillId),
      },
      KeyConditionExpression:
        '#scopeKey = :scopeKey AND begins_with(#recordKey, :recordPrefix)',
      Limit: 1_000,
      TableName: this.tableName,
    }
    let command = new QueryCommand(baseInput)
    let exclusiveStartKeyJson: string | undefined
    let pageCount = 0
    while (true) {
      if (pageCount >= MAX_JSON_CHECKPOINT_QUERY_PAGES) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      const output = await this.document.send(command)
      pageCount += 1
      const items = output.Items ?? []
      if (items.length > 1_000) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      for (const item of items) {
        if (values.length >= recordLimit) {
          throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
        }
        if (typeof item.payloadJson !== 'string' || item.payloadJson.length > 350_000) {
          throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
        }
        try {
          const value: unknown = JSON.parse(item.payloadJson)
          values.push(value)
        } catch {
          throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
        }
      }
      if (!output.LastEvaluatedKey) break
      const nextStartKeyJson = stableJson(output.LastEvaluatedKey)
      if (
        Object.keys(output.LastEvaluatedKey).length === 0 ||
        nextStartKeyJson === exclusiveStartKeyJson
      ) {
        throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
      }
      exclusiveStartKeyJson = nextStartKeyJson
      command = new QueryCommand({
        ...baseInput,
        ExclusiveStartKey: output.LastEvaluatedKey,
      })
    }
    return values
  }
}

/**
 * Returns the fixed inventory cardinality bound for one internal checkpoint family.
 *
 * @param recordPrefix - Exact internal record-key prefix.
 * @returns Maximum accepted records for one query.
 */
function jsonCheckpointQueryRecordLimit(recordPrefix: string): number {
  switch (recordPrefix) {
    case 'START_INTENT#':
    case 'EXPORT_COMPLETION#':
      return RESTORE_DRILL_TABLE_TARGETS.length
    case 'EXPORT_OBJECT#':
      return RESTORE_DRILL_TABLE_TARGETS.length *
        MAX_EXPORT_LISTING_OBJECTS_PER_TARGET
    case 'COPY_INTENT#':
      return 10_000
    case 'MULTIPART_UPLOAD#':
      return 10_000
    default:
      return 10_000
  }
}

/** Creates the singleton cadence key. */
function cadenceKey(): { readonly scopeKey: 'CONTROL'; readonly recordKey: 'CADENCE' } {
  return { scopeKey: 'CONTROL', recordKey: 'CADENCE' }
}

/** Creates the safe RUN key. */
function runKey(drillId: string): { readonly scopeKey: string; readonly recordKey: 'RUN' } {
  return { scopeKey: runScopeKey(drillId), recordKey: 'RUN' }
}

/** Creates one exact per-run partition key. */
function runScopeKey(drillId: string): string {
  return `RESTORE_DRILL#${requireDrillId(drillId)}`
}

/** Creates the separate append-only cleanup-ledger partition key. */
function cleanupLedgerScopeKey(drillId: string): string {
  return `RESTORE_DRILL_LEDGER#${requireDrillId(drillId)}`
}

/** Creates the cleanup-only mutable progress partition key. */
function cleanupProgressScopeKey(drillId: string): string {
  return `RESTORE_DRILL_CLEANUP#${requireDrillId(drillId)}`
}

/** Validates that one RUN update changes only cleanup-owned state. */
function validateCleanupRunTransition(
  expected: RestoreDrillDurableRun,
  next: RestoreDrillDurableRun,
): void {
  validateRun(expected)
  validateRun(next)
  if (
    next.drillId !== expected.drillId ||
    next.revision !== expected.revision + 1 ||
    Date.parse(next.updatedAt) < Date.parse(expected.updatedAt) ||
    !next.approvalDigest ||
    !next.approvalObjectKey ||
    !next.approvedAt ||
    !next.cleanupAttemptCount ||
    !next.cleanupExecutionArn ||
    !next.cleanupExecutionName ||
    !next.cleanupStartedAt
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const expectedImmutable = serializeRunItem(expected)
  const nextImmutable = serializeRunItem(next)
  for (const attribute of [
    'approvalDigest',
    'approvalObjectKey',
    'approvedAt',
    'cleanupAttemptCount',
    'cleanupExecutionArn',
    'cleanupExecutionName',
    'cleanupStartedAt',
    'cleanupEffectIndex',
    'outcome',
    'phase',
    'revision',
    'updatedAt',
  ]) {
    delete expectedImmutable[attribute]
    delete nextImmutable[attribute]
  }
  if (stableJson(expectedImmutable) !== stableJson(nextImmutable)) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  if (expected.phase === 'completed') {
    if (
      next.phase !== 'completed' ||
      next.outcome !== expected.outcome ||
      next.cleanupAttemptCount !== expected.cleanupAttemptCount ||
      next.approvalDigest !== expected.approvalDigest ||
      next.approvalObjectKey !== expected.approvalObjectKey ||
      next.approvedAt !== expected.approvedAt ||
      next.cleanupExecutionArn !== expected.cleanupExecutionArn ||
      next.cleanupExecutionName !== expected.cleanupExecutionName ||
      next.cleanupStartedAt !== expected.cleanupStartedAt ||
      next.cleanupEffectIndex !== (expected.cleanupEffectIndex ?? 0) + 1 ||
      next.cleanupEffectIndex > 2
    ) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    return
  }
  if (expected.phase === 'awaiting-cleanup-approval') {
    if (
      next.phase !== 'cleaning-up' ||
      next.outcome !== 'in-progress' ||
      next.cleanupAttemptCount !== 1 ||
      next.cleanupEffectIndex !== undefined ||
      expected.cleanupExecutionArn !== undefined
    ) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    return
  }
  if (expected.phase !== 'cleaning-up') {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  if (next.phase === 'cleaning-up') {
    if (
      next.outcome !== 'in-progress' ||
      next.cleanupAttemptCount !== (expected.cleanupAttemptCount ?? 0) + 1 ||
      next.cleanupExecutionArn === expected.cleanupExecutionArn ||
      next.cleanupStartedAt !== expected.cleanupStartedAt ||
      expected.approvedAt === undefined ||
      Date.parse(next.approvedAt) <= Date.parse(expected.approvedAt)
    ) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    return
  }
  if (
    next.phase !== 'completed' ||
    next.cleanupAttemptCount !== expected.cleanupAttemptCount ||
    next.approvalDigest !== expected.approvalDigest ||
    next.approvalObjectKey !== expected.approvalObjectKey ||
    next.approvedAt !== expected.approvedAt ||
    next.cleanupExecutionArn !== expected.cleanupExecutionArn ||
    next.cleanupExecutionName !== expected.cleanupExecutionName ||
    next.cleanupStartedAt !== expected.cleanupStartedAt ||
    next.cleanupEffectIndex !== 0
  ) throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
}

/** Serializes the approval-facing RUN item without checkpoint payloads. */
function serializeRunItem(run: RestoreDrillDurableRun): Record<string, unknown> {
  validateRun(run)
  return {
    ...(run.approvalDigest ? { approvalDigest: run.approvalDigest } : {}),
    ...(run.approvalObjectKey ? { approvalObjectKey: run.approvalObjectKey } : {}),
    ...(run.approvedAt ? { approvedAt: run.approvedAt } : {}),
    cleanupPolicyVersion: run.cleanupPolicyVersion,
    ...(run.cleanupAttemptCount ? { cleanupAttemptCount: run.cleanupAttemptCount } : {}),
    ...(run.cleanupExecutionArn ? { cleanupExecutionArn: run.cleanupExecutionArn } : {}),
    ...(run.cleanupExecutionName ? { cleanupExecutionName: run.cleanupExecutionName } : {}),
    ...(run.cleanupStartedAt ? { cleanupStartedAt: run.cleanupStartedAt } : {}),
    ...(run.cleanupEffectIndex !== undefined
      ? { cleanupEffectIndex: run.cleanupEffectIndex }
      : {}),
    deadlineAt: run.deadlineAt,
    drillId: run.drillId,
    failureCodes: [...run.failureCodes],
    kind: 'mukuroji-restore-drill-run',
    outcome: run.outcome,
    phase: run.phase,
    recordKey: 'RUN',
    revision: run.revision,
    runVersion: 1,
    scopeKey: runScopeKey(run.drillId),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.digestKeyEnvelope ? { digestKeyEnvelope: { ...run.digestKeyEnvelope } } : {}),
    ...(run.resourceDigest ? { resourceDigest: run.resourceDigest } : {}),
    ...(run.resultDigest ? { resultDigest: run.resultDigest } : {}),
    ...(run.resultEvidenceKey ? { resultEvidenceKey: run.resultEvidenceKey } : {}),
    ...(run.resultOutcome ? { resultOutcome: run.resultOutcome } : {}),
    ...(run.restorePoint ? { restorePoint: run.restorePoint } : {}),
    runnerExecutionArn: run.runnerExecutionArn,
    ...(run.verificationCompletedAt
      ? { verificationCompletedAt: run.verificationCompletedAt }
      : {}),
    ...(run.terminalArtifactIntent
      ? { terminalArtifactIntent: run.terminalArtifactIntent }
      : {}),
    ...(run.terminalEffectIndex !== undefined
      ? { terminalEffectIndex: run.terminalEffectIndex }
      : {}),
  }
}

/** Strictly parses one approval-facing RUN item. */
function parseRunItem(value: unknown, expectedDrillId: string): RestoreDrillDurableRun {
  const item = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'approvalDigest',
    'approvalObjectKey',
    'approvedAt',
    'cleanupPolicyVersion',
    'cleanupAttemptCount',
    'cleanupExecutionArn',
    'cleanupExecutionName',
    'cleanupStartedAt',
    'cleanupEffectIndex',
    'deadlineAt',
    'digestKeyEnvelope',
    'drillId',
    'failureCodes',
    'fileCheckpointRecordKey',
    'kind',
    'outcome',
    'phase',
    'recordKey',
    'resourceDigest',
    'resultDigest',
    'resultEvidenceKey',
    'resultOutcome',
    'restorePoint',
    'revision',
    'runnerExecutionArn',
    'runVersion',
    'scopeKey',
    'startedAt',
    'updatedAt',
    'verificationCompletedAt',
    'terminalArtifactIntent',
    'terminalEffectIndex',
  ])
  if (
    Object.keys(item).some((key) => !allowedKeys.has(key)) ||
    item.scopeKey !== runScopeKey(expectedDrillId) ||
    item.recordKey !== 'RUN' ||
    item.kind !== 'mukuroji-restore-drill-run' ||
    item.runVersion !== 1 ||
    item.drillId !== expectedDrillId ||
    item.cleanupPolicyVersion !== RESTORE_DRILL_CLEANUP_POLICY_VERSION ||
    !isPositiveInteger(item.revision) ||
    !isRunPhase(item.phase) ||
    !isRunOutcome(item.outcome) ||
    typeof item.runnerExecutionArn !== 'string' ||
    !isRunnerExecutionArn(item.runnerExecutionArn) ||
    !isCanonicalTimestamp(item.startedAt) ||
    !isCanonicalTimestamp(item.deadlineAt) ||
    !isCanonicalTimestamp(item.updatedAt) ||
    Date.parse(item.startedAt) > Date.parse(item.deadlineAt) ||
    !isFailureCodeVector(item.failureCodes)
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const envelope = item.digestKeyEnvelope === undefined
    ? undefined
    : parseDigestKeyEnvelope(item.digestKeyEnvelope)
  const resourceDigest = readOptionalHexDigest(item.resourceDigest)
  const resultDigest = readOptionalHexDigest(item.resultDigest)
  const resultEvidenceKeyValue = readOptionalString(item.resultEvidenceKey)
  const resultOutcome = item.resultOutcome === undefined
    ? undefined
    : item.resultOutcome === 'pass' || item.resultOutcome === 'fail'
      ? item.resultOutcome
      : invalidRunState()
  const restorePoint = item.restorePoint === undefined
    ? undefined
    : readStateTimestamp(item.restorePoint)
  const verificationCompletedAt = item.verificationCompletedAt === undefined
    ? undefined
    : readStateTimestamp(item.verificationCompletedAt)
  const approvalDigest = readOptionalHexDigest(item.approvalDigest)
  const approvalObjectKey = readOptionalString(item.approvalObjectKey)
  const approvedAt = item.approvedAt === undefined
    ? undefined
    : readStateTimestamp(item.approvedAt)
  const cleanupStartedAt = item.cleanupStartedAt === undefined
    ? undefined
    : readStateTimestamp(item.cleanupStartedAt)
  const cleanupEffectIndex = item.cleanupEffectIndex === undefined
    ? undefined
    : isNonNegativeInteger(item.cleanupEffectIndex)
      ? item.cleanupEffectIndex
      : invalidRunState()
  const cleanupAttemptCount = item.cleanupAttemptCount === undefined
    ? undefined
    : isPositiveInteger(item.cleanupAttemptCount)
      ? item.cleanupAttemptCount
      : invalidRunState()
  const cleanupExecutionArn = readOptionalString(item.cleanupExecutionArn)
  const cleanupExecutionName = readOptionalString(item.cleanupExecutionName)
  const terminalArtifactIntent = item.terminalArtifactIntent === undefined
    ? undefined
    : parseTerminalArtifactIntent(item.terminalArtifactIntent, expectedDrillId)
  const terminalEffectIndex = item.terminalEffectIndex === undefined
    ? undefined
    : isNonNegativeInteger(item.terminalEffectIndex)
      ? item.terminalEffectIndex
      : invalidRunState()
  const run: RestoreDrillDurableRun = {
    ...(approvalDigest ? { approvalDigest } : {}),
    ...(approvalObjectKey ? { approvalObjectKey } : {}),
    ...(approvedAt ? { approvedAt } : {}),
    cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
    ...(cleanupAttemptCount ? { cleanupAttemptCount } : {}),
    ...(cleanupExecutionArn ? { cleanupExecutionArn } : {}),
    ...(cleanupExecutionName ? { cleanupExecutionName } : {}),
    ...(cleanupStartedAt ? { cleanupStartedAt } : {}),
    ...(cleanupEffectIndex !== undefined ? { cleanupEffectIndex } : {}),
    deadlineAt: item.deadlineAt,
    ...(envelope ? { digestKeyEnvelope: envelope } : {}),
    drillId: expectedDrillId,
    failureCodes: [...item.failureCodes],
    outcome: item.outcome,
    phase: item.phase,
    ...(resourceDigest ? { resourceDigest } : {}),
    revision: item.revision,
    ...(resultDigest ? { resultDigest } : {}),
    ...(resultEvidenceKeyValue ? { resultEvidenceKey: resultEvidenceKeyValue } : {}),
    ...(resultOutcome ? { resultOutcome } : {}),
    ...(restorePoint ? { restorePoint } : {}),
    runnerExecutionArn: item.runnerExecutionArn,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    ...(verificationCompletedAt ? { verificationCompletedAt } : {}),
    ...(terminalArtifactIntent ? { terminalArtifactIntent } : {}),
    ...(terminalEffectIndex !== undefined ? { terminalEffectIndex } : {}),
  }
  validateRun(run)
  return run
}

/** Strictly parses one terminal artifact intent pinned in RUN. */
function parseTerminalArtifactIntent(
  value: unknown,
  expectedDrillId: string,
): RestoreDrillTerminalArtifactIntent {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), [
      'artifactJson',
      'effects',
      'evidenceKey',
      'failureCodes',
      'resourceDigest',
      'resultDigest',
      'resultOutcome',
      'retentionReferenceAt',
    ].sort()) ||
    typeof record.artifactJson !== 'string' ||
    Buffer.byteLength(record.artifactJson, 'utf8') > 350_000 ||
    record.evidenceKey !== resultEvidenceKey(expectedDrillId) ||
    !Array.isArray(record.effects) ||
    record.effects.length < 1 ||
    record.effects.length > 6 ||
    !isFailureCodeVector(record.failureCodes) ||
    !isHexDigest(record.resourceDigest) ||
    !isHexDigest(record.resultDigest) ||
    (record.resultOutcome !== 'fail' && record.resultOutcome !== 'pass') ||
    !isCanonicalTimestamp(record.retentionReferenceAt)
  ) invalidRunState()
  const effects = record.effects.map(parseTerminalEffect)
  const successfulEffects = effects.filter(
    (effect) => effect.kind === 'record-successful-verification',
  )
  const metricNames = effects.flatMap((effect) =>
    effect.kind === 'metric' ? [effect.metricName] : []
  )
  if (
    successfulEffects.length > 1 ||
    (record.resultOutcome === 'pass') !== (successfulEffects.length === 1) ||
    new Set(metricNames).size !== metricNames.length ||
    (record.resultOutcome === 'pass') !== (record.failureCodes.length === 0) ||
    terminalArtifactRetentionReferenceAt(record.artifactJson, expectedDrillId) !==
      record.retentionReferenceAt
  ) invalidRunState()
  const parsed: RestoreDrillTerminalArtifactIntent = {
    artifactJson: record.artifactJson,
    effects,
    evidenceKey: record.evidenceKey,
    failureCodes: [...record.failureCodes],
    resourceDigest: record.resourceDigest,
    resultDigest: record.resultDigest,
    resultOutcome: record.resultOutcome,
    retentionReferenceAt: record.retentionReferenceAt,
  }
  validateTerminalArtifactBinding(parsed, expectedDrillId)
  return parsed
}

/** Strictly parses one replay-safe terminal side effect. */
function parseTerminalEffect(value: unknown): RestoreDrillTerminalEffect {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (record.kind === 'record-successful-verification') {
    if (
      !sameStringVector(Object.keys(record).sort(), ['completedAt', 'kind']) ||
      !isCanonicalTimestamp(record.completedAt)
    ) invalidRunState()
    return {
      completedAt: record.completedAt,
      kind: 'record-successful-verification',
    }
  }
  if (
    record.kind !== 'metric' ||
    !sameStringVector(
      Object.keys(record).sort(),
      ['kind', 'metricName', 'unit', 'value'],
    ) ||
    !isRestoreDrillMetricName(record.metricName) ||
    (record.unit !== 'Count' && record.unit !== 'Seconds') ||
    typeof record.value !== 'number' ||
    !Number.isFinite(record.value) ||
    record.value < 0
  ) invalidRunState()
  return {
    kind: 'metric',
    metricName: record.metricName,
    unit: record.unit,
    value: record.value,
  }
}

/** Returns the exact retention timestamp from canonical pinned result/failure bytes. */
function terminalArtifactRetentionReferenceAt(
  artifactJson: string,
  expectedDrillId: string,
): string {
  let value: unknown
  try {
    value = JSON.parse(artifactJson)
  } catch {
    return invalidRunState()
  }
  if (stableJson(value) !== artifactJson) invalidRunState()
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (record.kind === 'mukuroji-restore-drill-operational-failure') {
    if (
      !sameStringVector(Object.keys(record).sort(), [
        'drillId',
        'failedAt',
        'failureCode',
        'failureVersion',
        'kind',
        'phase',
      ]) ||
      record.drillId !== expectedDrillId ||
      record.failureVersion !== 1 ||
      typeof record.failureCode !== 'string' ||
      !isRestoreDrillFailureCode(record.failureCode) ||
      !isRunPhase(record.phase) ||
      !isCanonicalTimestamp(record.failedAt)
    ) invalidRunState()
    return record.failedAt
  }
  if (!sameStringVector(Object.keys(record).sort(), ['result', 'resultDigest', 'semantic'])) {
    return invalidRunState()
  }
  const result = requireRecord(record.result, 'RUN_STATE_INVALID')
  const semantic = requireRecord(record.semantic, 'RUN_STATE_INVALID')
  if (
    result.kind !== 'mukuroji-restore-drill-result' ||
    result.drillId !== expectedDrillId ||
    !isCanonicalTimestamp(result.completedAt) ||
    !isHexDigest(record.resultDigest) ||
    !sameStringVector(
      Object.keys(semantic).sort(),
      ['crossDomainStatus', 'workItemsSchemaStatus'],
    ) ||
    (semantic.crossDomainStatus !== 'fail' && semantic.crossDomainStatus !== 'pass') ||
    (semantic.workItemsSchemaStatus !== 'fail' &&
      semantic.workItemsSchemaStatus !== 'pass')
  ) invalidRunState()
  return result.completedAt
}

/** Verifies that pinned bytes and terminal fields describe the same artifact. */
function validateTerminalArtifactBinding(
  intent: RestoreDrillTerminalArtifactIntent,
  expectedDrillId: string,
): void {
  const value: unknown = JSON.parse(intent.artifactJson)
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (record.kind === 'mukuroji-restore-drill-operational-failure') {
    const failureCode = typeof record.failureCode === 'string' &&
      isRestoreDrillFailureCode(record.failureCode)
      ? record.failureCode
      : invalidRunState()
    if (
      intent.resultOutcome !== 'fail' ||
      !intent.failureCodes.includes(failureCode)
    ) invalidRunState()
    return
  }
  const result = requireRecord(record.result, 'RUN_STATE_INVALID')
  const runState = requireRecord(result.runState, 'RUN_STATE_INVALID')
  if (
    record.resultDigest !== intent.resultDigest ||
    result.resourceDigest !== intent.resourceDigest ||
    runState.outcome !== intent.resultOutcome ||
    !isFailureCodeVector(result.failureCodes) ||
    !sameStringVector(result.failureCodes, intent.failureCodes) ||
    result.drillId !== expectedDrillId
  ) invalidRunState()
}

/** Checks one fixed restore-drill metric name. */
function isRestoreDrillMetricName(value: unknown): value is RestoreDrillMetricName {
  return value === 'CadenceOverdueCount' ||
    value === 'CleanupOverdueCount' ||
    value === 'DrillFailureCount' ||
    value === 'IntegrityFailureCount' ||
    value === 'RpoSeconds' ||
    value === 'RtoSeconds'
}

/** Validates cross-field durable RUN invariants. */
function validateRun(run: RestoreDrillDurableRun): void {
  const terminalEvidencePhase =
    run.phase === 'awaiting-cleanup-approval' ||
    run.phase === 'cleaning-up' ||
    run.phase === 'completed'
  const hasTerminalFields =
    run.digestKeyEnvelope !== undefined &&
    run.resourceDigest !== undefined &&
    run.resultDigest !== undefined &&
    run.resultEvidenceKey !== undefined &&
    run.resultOutcome !== undefined &&
    run.verificationCompletedAt !== undefined
  const cleanupBindingComplete =
    run.approvalDigest !== undefined &&
    run.approvalObjectKey !== undefined &&
    run.approvedAt !== undefined &&
    run.cleanupAttemptCount !== undefined &&
    run.cleanupExecutionArn !== undefined &&
    run.cleanupExecutionName !== undefined &&
    run.cleanupStartedAt !== undefined
  const anyCleanupBinding =
    run.approvalDigest !== undefined ||
    run.approvalObjectKey !== undefined ||
    run.approvedAt !== undefined ||
    run.cleanupAttemptCount !== undefined ||
    run.cleanupExecutionArn !== undefined ||
    run.cleanupExecutionName !== undefined ||
    run.cleanupStartedAt !== undefined
  if (
    !isPositiveInteger(run.revision) ||
    !isCanonicalTimestamp(run.startedAt) ||
    !isCanonicalTimestamp(run.deadlineAt) ||
    !isCanonicalTimestamp(run.updatedAt) ||
    !isRunnerExecutionArn(run.runnerExecutionArn) ||
    (run.restorePoint !== undefined && !isCanonicalTimestamp(run.restorePoint)) ||
    (run.verificationCompletedAt !== undefined &&
      !isCanonicalTimestamp(run.verificationCompletedAt)) ||
    (run.approvedAt !== undefined && !isCanonicalTimestamp(run.approvedAt)) ||
    (run.cleanupStartedAt !== undefined && !isCanonicalTimestamp(run.cleanupStartedAt)) ||
    (run.cleanupEffectIndex !== undefined && (
      !isNonNegativeInteger(run.cleanupEffectIndex) ||
      run.cleanupEffectIndex > 2 ||
      run.phase !== 'completed'
    )) ||
    (run.cleanupAttemptCount !== undefined && !isPositiveInteger(run.cleanupAttemptCount)) ||
    (run.cleanupAttemptCount !== undefined && run.cleanupAttemptCount > 1 && (
      run.approvedAt === undefined ||
      run.cleanupStartedAt === undefined ||
      Date.parse(run.approvedAt) < Date.parse(run.cleanupStartedAt)
    )) ||
    (run.cleanupExecutionName !== undefined &&
      !/^restore-cleanup-[a-f0-9]{64}$/.test(run.cleanupExecutionName)) ||
    (run.cleanupExecutionArn !== undefined &&
      (run.cleanupExecutionName === undefined ||
        !cleanupExecutionArnHasName(run.cleanupExecutionArn, run.cleanupExecutionName))) ||
    (run.approvalDigest !== undefined && !isHexDigest(run.approvalDigest)) ||
    (run.approvalObjectKey !== undefined &&
      !run.approvalObjectKey.startsWith(`approvals/v1/runs/${run.drillId}/`)) ||
    !isFailureCodeVector(run.failureCodes) ||
    (terminalEvidencePhase && !hasTerminalFields) ||
    (anyCleanupBinding && !cleanupBindingComplete) ||
    ((run.phase === 'cleaning-up' || run.phase === 'completed') && !cleanupBindingComplete) ||
    (run.resultOutcome === 'pass' && run.failureCodes.length !== 0) ||
    (run.resultOutcome === 'fail' && run.failureCodes.length === 0) ||
    (run.resultOutcome === 'pass' && run.restorePoint === undefined) ||
    (run.phase === 'completed' && run.outcome !== run.resultOutcome) ||
    (run.terminalArtifactIntent === undefined) !== (run.terminalEffectIndex === undefined) ||
    (run.terminalArtifactIntent !== undefined && (
      !isNonNegativeInteger(run.terminalEffectIndex) ||
      (run.terminalEffectIndex ?? -1) > run.terminalArtifactIntent.effects.length ||
      (terminalEvidencePhase && (
        run.resourceDigest !== run.terminalArtifactIntent.resourceDigest ||
        run.resultDigest !== run.terminalArtifactIntent.resultDigest ||
        run.resultEvidenceKey !== run.terminalArtifactIntent.evidenceKey ||
        run.resultOutcome !== run.terminalArtifactIntent.resultOutcome ||
        !sameStringVector(run.failureCodes, run.terminalArtifactIntent.failureCodes)
      ))
    )) ||
    (run.phase !== 'completed' && run.phase !== 'failed' && run.outcome !== 'in-progress')
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
}

/** Parses the singleton cadence item. */
function parseCadenceItem(value: unknown): RestoreDrillCadenceState {
  const item = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    item.scopeKey !== 'CONTROL' ||
    item.recordKey !== 'CADENCE' ||
    item.kind !== 'mukuroji-restore-drill-cadence' ||
    !isPositiveInteger(item.revision) ||
    (item.activeDrillId !== undefined && !isDrillId(item.activeDrillId)) ||
    (item.cadenceOriginAt !== undefined && !isCanonicalTimestamp(item.cadenceOriginAt)) ||
    (item.lastSuccessfulVerifiedAt !== undefined &&
      !isCanonicalTimestamp(item.lastSuccessfulVerifiedAt))
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return {
    ...(typeof item.activeDrillId === 'string'
      ? { activeDrillId: item.activeDrillId }
      : {}),
    ...(typeof item.cadenceOriginAt === 'string'
      ? { cadenceOriginAt: item.cadenceOriginAt }
      : {}),
    ...(typeof item.lastSuccessfulVerifiedAt === 'string'
      ? { lastSuccessfulVerifiedAt: item.lastSuccessfulVerifiedAt }
      : {}),
    revision: item.revision,
  }
}

/** Parses one strict ciphertext-only digest key envelope. */
function parseDigestKeyEnvelope(value: unknown): RestoreDrillDigestKeyEnvelope {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['ciphertextBase64', 'kind', 'kmsKeyArn'],
    ) ||
    record.kind !== 'restore-drill-digest-key' ||
    !isRestoreDrillKmsKeyArn(record.kmsKeyArn) ||
    typeof record.ciphertextBase64 !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertextBase64) ||
    record.ciphertextBase64.length > 16_384
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return {
    ciphertextBase64: record.ciphertextBase64,
    kind: 'restore-drill-digest-key',
    kmsKeyArn: record.kmsKeyArn,
  }
}

/**
 * Checks one account-bound KMS key ARN in a supported Region partition.
 *
 * @param value - Candidate persisted KMS key ARN.
 * @returns Whether the ARN's partition is canonical for its Region.
 */
function isRestoreDrillKmsKeyArn(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split(':')
  const region = parts[3]
  const resource = parts[5]
  const partition = region === undefined
    ? undefined
    : resolveRestoreDrillAwsPartition(region)
  return parts.length === 6 &&
    parts[0] === 'arn' &&
    partition !== undefined &&
    parts[1] === partition &&
    parts[2] === 'kms' &&
    typeof parts[4] === 'string' &&
    /^\d{12}$/.test(parts[4]) &&
    typeof resource === 'string' &&
    resource.startsWith('key/') &&
    resource.length > 'key/'.length
}

/** Reads an optional lower-case SHA-256 digest. */
function readOptionalHexDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalidRunState()
  return value
}

/** Reads an optional bounded non-empty string. */
function readOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    invalidRunState()
  }
  return value
}

/** Reads a state timestamp or fails closed. */
function readStateTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) invalidRunState()
  return value
}

/** Throws the stable invalid-state failure in expression contexts. */
function invalidRunState(): never {
  throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
}

/** Checks a drill identifier without throwing. */
function isDrillId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)
}

/** Checks a canonical UTC timestamp without throwing. */
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

/** Checks a positive safe integer. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Checks a non-negative safe integer. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Checks a durable run phase. */
function isRunPhase(value: unknown): value is RestoreDrillRunPhase {
  return value === 'awaiting-cleanup-approval' ||
    value === 'cleaning-up' ||
    value === 'completed' ||
    value === 'copying-file-versions' ||
    value === 'discovering-pitr-windows' ||
    value === 'failed' ||
    value === 'restoring-tables' ||
    value === 'scheduled' ||
    value === 'verifying'
}

/** Checks a durable run outcome. */
function isRunOutcome(value: unknown): value is RestoreDrillRunOutcome {
  return value === 'fail' || value === 'in-progress' || value === 'pass'
}

const RESTORE_DRILL_FAILURE_CODES: ReadonlySet<string> = new Set([
  'AGGREGATE_CONTENT_MISMATCH',
  'AGGREGATE_DESCRIPTOR_MISMATCH',
  'AGGREGATE_INVALID',
  'AGGREGATE_KEY_MISMATCH',
  'AGGREGATE_METADATA_MISMATCH',
  'AGGREGATE_PARTITION_COUNT_MISMATCH',
  'AGGREGATE_RECORD_COUNT_MISMATCH',
  'AGGREGATE_RESOURCE_MISMATCH',
  'AGGREGATE_RESTORE_POINT_MISMATCH',
  'AGGREGATE_ROLE_MISMATCH',
  'APPROVAL_APPROVER_UNAUTHORIZED',
  'APPROVAL_AUTHENTICATION_FAILED',
  'APPROVAL_CHANGE_MISMATCH',
  'APPROVAL_DRILL_MISMATCH',
  'APPROVAL_EXPIRED',
  'APPROVAL_NOT_YET_VALID',
  'APPROVAL_POLICY_MISMATCH',
  'APPROVAL_RECEIPT_INVALID',
  'APPROVAL_RESOURCE_MISMATCH',
  'APPROVAL_RESULT_MISMATCH',
  'CADENCE_OVERDUE',
  'CLEANUP_CONTEXT_INVALID',
  'CLEANUP_FAILED',
  'CROSS_DOMAIN_INTEGRITY_FAILED',
  'DIGEST_DOMAIN_INVALID',
  'DIGEST_KEY_INVALID',
  'DYNAMODB_RESTORE_FAILED',
  'EVIDENCE_INVALID',
  'EVIDENCE_PERSIST_FAILED',
  'OBJECTIVE_TIMELINE_INVALID',
  'PITR_WINDOW_INVALID',
  'PITR_WINDOW_NO_OVERLAP',
  'PITR_WINDOW_TARGET_MISMATCH',
  'RESOURCE_IDENTITY_INVALID',
  'RPO_TARGET_MISSED',
  'RTO_TARGET_MISSED',
  'RUN_STATE_INVALID',
  'S3_VERSION_RESTORE_FAILED',
  'WORKFLOW_POLL_BUDGET_EXCEEDED',
  'WORKFLOW_TASK_FAILED',
])

/** Checks a canonical sorted unique stable failure-code vector. */
function isFailureCodeVector(value: unknown): value is RestoreDrillFailureCode[] {
  if (!Array.isArray(value)) return false
  const codes: RestoreDrillFailureCode[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !isRestoreDrillFailureCode(candidate)) return false
    codes.push(candidate)
  }
  return sameStringVector(codes, [...new Set(codes)].sort())
}

/** Narrows one string to the kernel failure-code union. */
function isRestoreDrillFailureCode(value: string): value is RestoreDrillFailureCode {
  return RESTORE_DRILL_FAILURE_CODES.has(value)
}

/** Checks a portable DynamoDB table name. */
function isDynamoDbTableName(value: string): boolean {
  return value.length >= 3 && value.length <= 255 && /^[A-Za-z0-9_.-]+$/.test(value)
}

/** Checks a portable AWS Region name. */
function isAwsRegion(value: string): boolean {
  return /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value)
}

/** Calculates lower-case SHA-256. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Recognizes conditional DynamoDB failures without serializing raw SDK values. */
function isConditionalAwsFailure(error: unknown): boolean {
  return isRecord(error) &&
    (error.name === 'ConditionalCheckFailedException' ||
      error.name === 'TransactionCanceledException' ||
      error.name === 'IdempotentParameterMismatchException')
}

/** Strictly parses the complete resource checkpoint in canonical order. */
function parseResourceCheckpoint(value: unknown): RestoreDrillResourceCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['exports', 'restoredDescriptors', 'restores', 'sources'],
    ) ||
    !Array.isArray(record.sources) ||
    !Array.isArray(record.restores) ||
    !Array.isArray(record.exports) ||
    !Array.isArray(record.restoredDescriptors) ||
    record.sources.length !== RESTORE_DRILL_TABLE_TARGETS.length ||
    record.restores.length > RESTORE_DRILL_TABLE_TARGETS.length ||
    record.exports.length > RESTORE_DRILL_TABLE_TARGETS.length ||
    (record.restoredDescriptors.length !== 0 &&
      record.restoredDescriptors.length !== RESTORE_DRILL_TABLE_TARGETS.length)
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const sources = record.sources.map(parseSourceObservation)
  const restores = record.restores.map(parseRecordedRestoreTable)
  const exports = record.exports.map(parseRecordedExport)
  const restoredDescriptors = record.restoredDescriptors.map(parseTableDescriptor)
  for (let index = 0; index < RESTORE_DRILL_TABLE_TARGETS.length; index += 1) {
    const expected = RESTORE_DRILL_TABLE_TARGETS[index]
    if (
      sources[index]?.target !== expected ||
      (restores[index] !== undefined && restores[index]?.target !== expected) ||
      (exports[index] !== undefined && exports[index]?.target !== expected)
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
  }
  return { exports, restoredDescriptors, restores, sources }
}

/** Parses one durable pre-API restore/export start intent. */
function parseStartIntent(value: unknown): RestoreDrillStartIntent {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'exportAttempted',
    'exportRecord',
    'restoreAttempted',
    'restorePoint',
    'restoreRecord',
    'source',
    'target',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    Object.keys(record).length < 5 ||
    typeof record.exportAttempted !== 'boolean' ||
    typeof record.restoreAttempted !== 'boolean' ||
    !isCanonicalTimestamp(record.restorePoint) ||
    !isTableTarget(record.target)
  ) invalidRunState()
  const source = parseSourceObservation(record.source)
  const restoreRecord = record.restoreRecord === undefined
    ? undefined
    : parseRecordedRestoreTable(record.restoreRecord)
  const exportRecord = record.exportRecord === undefined
    ? undefined
    : parseRecordedExport(record.exportRecord)
  if (
    source.target !== record.target ||
    (restoreRecord !== undefined && (
      !record.restoreAttempted ||
      restoreRecord.target !== record.target ||
      restoreRecord.restorePoint !== record.restorePoint ||
      restoreRecord.sourceTableArn !== source.sourceTableArn
    )) ||
    (exportRecord !== undefined && (
      !record.exportAttempted ||
      exportRecord.target !== record.target ||
      exportRecord.exportPoint !== record.restorePoint ||
      exportRecord.sourceTableArn !== source.sourceTableArn
    ))
  ) invalidRunState()
  return {
    exportAttempted: record.exportAttempted,
    ...(exportRecord ? { exportRecord } : {}),
    restoreAttempted: record.restoreAttempted,
    restorePoint: record.restorePoint,
    ...(restoreRecord ? { restoreRecord } : {}),
    source,
    target: record.target,
  }
}

/** Parses one source PITR observation. */
function parseSourceObservation(value: unknown): RestoreDrillSourceTableObservation {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'descriptor',
        'earliestRestorableAt',
        'latestRestorableAt',
        'sourceTableArn',
        'target',
      ],
    ) ||
    !isTableTarget(record.target) ||
    !isCanonicalTimestamp(record.earliestRestorableAt) ||
    !isCanonicalTimestamp(record.latestRestorableAt) ||
    Date.parse(record.earliestRestorableAt) > Date.parse(record.latestRestorableAt) ||
    typeof record.sourceTableArn !== 'string' ||
    !record.sourceTableArn.includes(':dynamodb:')
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return {
    descriptor: parseTableDescriptor(record.descriptor),
    earliestRestorableAt: record.earliestRestorableAt,
    latestRestorableAt: record.latestRestorableAt,
    sourceTableArn: record.sourceTableArn,
    target: record.target,
  }
}

/** Parses one exact recorded restore-table identity. */
function parseRecordedRestoreTable(value: unknown): RestoreDrillRecordedRestoreTable {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'kind',
        'restorePoint',
        'sourceTableArn',
        'tableArn',
        'tableId',
        'tableName',
        'target',
      ],
    ) ||
    record.kind !== 'restore-table' ||
    !isTableTarget(record.target) ||
    !isCanonicalTimestamp(record.restorePoint) ||
    !isNonEmptyString(record.sourceTableArn, 2_048) ||
    !isNonEmptyString(record.tableArn, 2_048) ||
    !isNonEmptyString(record.tableId, 256) ||
    !isNonEmptyString(record.tableName, 255)
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return {
    kind: 'restore-table',
    restorePoint: record.restorePoint,
    sourceTableArn: record.sourceTableArn,
    tableArn: record.tableArn,
    tableId: record.tableId,
    tableName: record.tableName,
    target: record.target,
  }
}

/** Parses one exact recorded point-in-time export identity. */
function parseRecordedExport(value: unknown): RestoreDrillRecordedExport {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'clientToken',
        'exportArn',
        'exportPoint',
        'kind',
        'scratchPrefix',
        'sourceTableArn',
        'sourceTableId',
        'target',
      ],
    ) ||
    record.kind !== 'table-export' ||
    !isTableTarget(record.target) ||
    !isCanonicalTimestamp(record.exportPoint) ||
    !isHexDigest(record.clientToken) ||
    !isNonEmptyString(record.exportArn, 2_048) ||
    !isNonEmptyString(record.scratchPrefix, 1_024) ||
    !isNonEmptyString(record.sourceTableArn, 2_048) ||
    !isNonEmptyString(record.sourceTableId, 256)
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  return {
    clientToken: record.clientToken,
    exportArn: record.exportArn,
    exportPoint: record.exportPoint,
    kind: 'table-export',
    scratchPrefix: record.scratchPrefix,
    sourceTableArn: record.sourceTableArn,
    sourceTableId: record.sourceTableId,
    target: record.target,
  }
}

/** Parses one canonical table descriptor. */
function parseTableDescriptor(value: unknown): RestoreDrillTableDescriptor {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'attributeDefinitions',
    'billingMode',
    'globalSecondaryIndexes',
    'itemCount',
    'keySchema',
    'kmsMasterKeyArn',
    'sseType',
    'sseStatus',
    'tableId',
    'ttlAttribute',
    'ttlEnabled',
    'ttlStatus',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    !Array.isArray(record.attributeDefinitions) ||
    !Array.isArray(record.globalSecondaryIndexes) ||
    !Array.isArray(record.keySchema) ||
    (record.billingMode !== 'PAY_PER_REQUEST' && record.billingMode !== 'PROVISIONED') ||
    (record.sseType !== 'AES256' && record.sseType !== 'KMS') ||
    record.sseStatus !== 'ENABLED' ||
    !isNonNegativeInteger(record.itemCount) ||
    !isNonEmptyString(record.tableId, 256) ||
    typeof record.ttlEnabled !== 'boolean' ||
    (record.ttlStatus !== 'DISABLED' && record.ttlStatus !== 'ENABLED') ||
    (record.kmsMasterKeyArn !== undefined &&
      !isNonEmptyString(record.kmsMasterKeyArn, 2_048)) ||
    (record.ttlAttribute !== undefined && !isNonEmptyString(record.ttlAttribute, 255)) ||
    record.ttlEnabled !== (record.ttlStatus === 'ENABLED') ||
    (record.ttlEnabled && record.ttlAttribute === undefined) ||
    (!record.ttlEnabled && record.ttlAttribute !== undefined)
  ) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const attributeDefinitions = record.attributeDefinitions.map(parseAttributeDefinition)
  const globalSecondaryIndexes = record.globalSecondaryIndexes.map(parseGlobalSecondaryIndex)
  const keySchema = record.keySchema.map(parseKeySchemaElement)
  return {
    attributeDefinitions,
    billingMode: record.billingMode,
    globalSecondaryIndexes,
    itemCount: record.itemCount,
    keySchema,
    ...(typeof record.kmsMasterKeyArn === 'string'
      ? { kmsMasterKeyArn: record.kmsMasterKeyArn }
      : {}),
    sseType: record.sseType,
    sseStatus: 'ENABLED',
    tableId: record.tableId,
    ...(typeof record.ttlAttribute === 'string' ? { ttlAttribute: record.ttlAttribute } : {}),
    ttlEnabled: record.ttlEnabled,
    ttlStatus: record.ttlStatus,
  }
}

/** Parses one DynamoDB scalar attribute definition. */
function parseAttributeDefinition(
  value: unknown,
): RestoreDrillTableDescriptor['attributeDefinitions'][number] {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), ['attributeName', 'attributeType']) ||
    !isNonEmptyString(record.attributeName, 255) ||
    (record.attributeType !== 'B' && record.attributeType !== 'N' && record.attributeType !== 'S')
  ) invalidRunState()
  return { attributeName: record.attributeName, attributeType: record.attributeType }
}

/** Parses one DynamoDB key schema element. */
function parseKeySchemaElement(
  value: unknown,
): RestoreDrillTableDescriptor['keySchema'][number] {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), ['attributeName', 'keyType']) ||
    !isNonEmptyString(record.attributeName, 255) ||
    (record.keyType !== 'HASH' && record.keyType !== 'RANGE')
  ) invalidRunState()
  return { attributeName: record.attributeName, keyType: record.keyType }
}

/** Parses one DynamoDB global secondary-index descriptor. */
function parseGlobalSecondaryIndex(
  value: unknown,
): RestoreDrillTableDescriptor['globalSecondaryIndexes'][number] {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['indexName', 'keySchema', 'projection', 'status'],
    ) ||
    !isNonEmptyString(record.indexName, 255) ||
    !Array.isArray(record.keySchema) ||
    !isRecord(record.projection) ||
    !sameStringVector(
      Object.keys(record.projection).sort(),
      ['nonKeyAttributes', 'projectionType'],
    ) ||
    !Array.isArray(record.projection.nonKeyAttributes) ||
    record.projection.nonKeyAttributes.some((entry) => !isNonEmptyString(entry, 255)) ||
    (record.projection.projectionType !== 'ALL' &&
      record.projection.projectionType !== 'INCLUDE' &&
      record.projection.projectionType !== 'KEYS_ONLY') ||
    record.status !== 'ACTIVE'
  ) invalidRunState()
  const nonKeyAttributes: string[] = []
  for (const entry of record.projection.nonKeyAttributes) {
    if (typeof entry !== 'string') invalidRunState()
    nonKeyAttributes.push(entry)
  }
  return {
    indexName: record.indexName,
    keySchema: record.keySchema.map(parseKeySchemaElement),
    projection: {
      nonKeyAttributes,
      projectionType: record.projection.projectionType,
    },
    status: 'ACTIVE',
  }
}

/** Checks one canonical restore-drill table target. */
function isTableTarget(value: unknown): value is RestoreDrillTableTarget {
  return typeof value === 'string' && RESTORE_DRILL_TABLE_TARGETS.includes(
    isRestoreDrillTableTargetString(value) ? value : 'table:audit-events',
  ) && isRestoreDrillTableTargetString(value)
}

/** Narrows one string to the fixed table-target union. */
function isRestoreDrillTableTargetString(value: string): value is RestoreDrillTableTarget {
  return value === 'table:audit-events' ||
    value === 'table:file-proofing' ||
    value === 'table:project-directory' ||
    value === 'table:work-item-configuration' ||
    value === 'table:work-items' ||
    value === 'table:workspace-access'
}

/** Checks a bounded non-empty string. */
function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

/** Checks a lower-case SHA-256 digest. */
function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Parses one durable CopyObject intent. */
function parseCopyIntent(value: unknown, drillId: string): RestoreDrillCopyIntent {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const preexistingScratchVersionIds = record.preexistingScratchVersionIds
  const allowedKeys = new Set([
    'completedCopy',
    'copyClaim',
    'createdCopies',
    'intentDigest',
    'preexistingScratchVersionIds',
    'selectedCopy',
    'source',
    'verificationCheckpoint',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    !isHexDigest(record.intentDigest) ||
    !Array.isArray(preexistingScratchVersionIds) ||
    preexistingScratchVersionIds.some(
      (versionId) => !isNonEmptyString(versionId, 1_024),
    )
  ) invalidRunState()
  const source = parseSourceFileVersion(record.source)
  if (record.intentDigest !== createCopyIntentDigest(source)) invalidRunState()
  const copyClaim = record.copyClaim === undefined
    ? undefined
    : parseCopyClaim(record.copyClaim)
  const createdCopies = record.createdCopies === undefined
    ? undefined
    : parseCreatedScratchObjectVersions(record.createdCopies)
  const selectedCopy = record.selectedCopy === undefined
    ? undefined
    : parseCreatedScratchObjectVersion(record.selectedCopy)
  const completedCopy = record.completedCopy === undefined
    ? undefined
    : parseRecordedScratchObjectVersion(record.completedCopy)
  const verificationCheckpoint = record.verificationCheckpoint === undefined
    ? undefined
    : parseFileRangeCheckpoint(record.verificationCheckpoint)
  if (
    ((createdCopies !== undefined || selectedCopy !== undefined) && copyClaim !== undefined) ||
    (createdCopies === undefined) !== (selectedCopy === undefined) ||
    (selectedCopy !== undefined && !createdCopies?.some(
      (copy) => sameCreatedScratchVersion(copy, selectedCopy),
    )) ||
    (completedCopy !== undefined && selectedCopy === undefined) ||
    (verificationCheckpoint !== undefined && selectedCopy === undefined) ||
    (verificationCheckpoint !== undefined && completedCopy !== undefined) ||
    (completedCopy !== undefined && selectedCopy !== undefined &&
      !sameCreatedScratchVersion(selectedCopy, completedCopy))
  ) invalidRunState()
  const expectedDrillDigest = sha256Hex(`drill\0${requireDrillId(drillId)}`).slice(0, 16)
  if (
    createdCopies?.some((createdCopy) =>
      createdCopy.objectKey !== source.objectKey ||
      createdCopy.versionId !== source.versionId ||
      createdCopy.drillDigest !== expectedDrillDigest ||
      preexistingScratchVersionIds.includes(createdCopy.objectVersionId)
    )
  ) invalidRunState()
  return {
    ...(completedCopy ? { completedCopy } : {}),
    ...(copyClaim ? { copyClaim } : {}),
    ...(createdCopies ? { createdCopies } : {}),
    intentDigest: record.intentDigest,
    preexistingScratchVersionIds: [...preexistingScratchVersionIds],
    ...(selectedCopy ? { selectedCopy } : {}),
    source,
    ...(verificationCheckpoint ? { verificationCheckpoint } : {}),
  }
}

/** Parses a non-empty canonical set of exact created File-copy identities. */
function parseCreatedScratchObjectVersions(
  value: unknown,
): readonly RestoreDrillCreatedScratchObjectVersion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) invalidRunState()
  const copies = value.map(parseCreatedScratchObjectVersion)
  const canonical = [...copies].sort(compareCreatedScratchVersions)
  if (stableJson(copies) !== stableJson(canonical)) invalidRunState()
  if (new Set(copies.map((copy) => copy.objectVersionId)).size !== copies.length) {
    invalidRunState()
  }
  return copies
}

/** Parses one exclusive bounded pre-copy claim. */
function parseCopyClaim(value: unknown): RestoreDrillCopyClaim {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), ['claimId', 'claimedAt']) ||
    typeof record.claimId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(record.claimId) ||
    !isCanonicalTimestamp(record.claimedAt)
  ) invalidRunState()
  return { claimId: record.claimId, claimedAt: record.claimedAt }
}

/** Strictly parses one authenticated exact-version range checkpoint. */
function parseFileRangeCheckpoint(value: unknown): RestoreDrillFileRangeCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'bindingDigest',
        'chainDigest',
        'checkpointMac',
        'checkpointVersion',
        'kind',
        'nextOffset',
        'rangeCount',
        'totalBytes',
      ],
    ) ||
    record.kind !== 'restore-drill-file-range-checkpoint' ||
    record.checkpointVersion !== 1 ||
    !isHexDigest(record.bindingDigest) ||
    !isHexDigest(record.chainDigest) ||
    !isHexDigest(record.checkpointMac) ||
    !isNonNegativeInteger(record.nextOffset) ||
    !isNonNegativeInteger(record.rangeCount) ||
    !isNonNegativeInteger(record.totalBytes) ||
    record.nextOffset > record.totalBytes ||
    (record.nextOffset === 0) !== (record.rangeCount === 0)
  ) invalidRunState()
  return {
    bindingDigest: record.bindingDigest,
    chainDigest: record.chainDigest,
    checkpointMac: record.checkpointMac,
    checkpointVersion: 1,
    kind: 'restore-drill-file-range-checkpoint',
    nextOffset: record.nextOffset,
    rangeCount: record.rangeCount,
    totalBytes: record.totalBytes,
  }
}

/** Checks monotonic exact-binding advancement without authenticating secret-key material. */
function fileRangeCheckpointAdvances(
  expected: RestoreDrillFileRangeCheckpoint | undefined,
  next: RestoreDrillFileRangeCheckpoint,
): boolean {
  if (expected === undefined) return next.rangeCount === 1 && next.nextOffset > 0
  return next.bindingDigest === expected.bindingDigest &&
    next.totalBytes === expected.totalBytes &&
    next.rangeCount === expected.rangeCount + 1 &&
    next.nextOffset > expected.nextOffset &&
    next.chainDigest !== expected.chainDigest &&
    next.checkpointMac !== expected.checkpointMac
}

/** Parses one exact created File-copy identity before content verification. */
function parseCreatedScratchObjectVersion(
  value: unknown,
): RestoreDrillCreatedScratchObjectVersion {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['bucketName', 'drillDigest', 'kind', 'objectKey', 'objectVersionId', 'versionId'],
    ) ||
    record.kind !== 'scratch-object-version' ||
    !isNonEmptyString(record.bucketName, 63) ||
    typeof record.drillDigest !== 'string' ||
    !/^[a-f0-9]{16}$/.test(record.drillDigest) ||
    !isNonEmptyString(record.objectKey, 1_024) ||
    !record.objectKey.startsWith('workspaces/') ||
    !isRestoreDrillObjectKeyPathSafe(record.objectKey) ||
    !isNonEmptyString(record.objectVersionId, 1_024) ||
    !isNonEmptyString(record.versionId, 256)
  ) invalidRunState()
  return {
    bucketName: record.bucketName,
    drillDigest: record.drillDigest,
    kind: 'scratch-object-version',
    objectKey: record.objectKey,
    objectVersionId: record.objectVersionId,
    versionId: record.versionId,
  }
}

/** Parses one strict source File object version. */
function parseSourceFileVersion(value: unknown): RestoreDrillSourceFileVersion {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['contentType', 'objectKey', 'objectVersionId', 'sizeBytes', 'versionId'],
    ) ||
    !isNonEmptyString(record.contentType, 1_024) ||
    !isNonEmptyString(record.objectKey, 1_024) ||
    !record.objectKey.startsWith('workspaces/') ||
    !isRestoreDrillObjectKeyPathSafe(record.objectKey) ||
    !isNonEmptyString(record.objectVersionId, 1_024) ||
    !isNonEmptyString(record.versionId, 256) ||
    !isNonNegativeInteger(record.sizeBytes)
  ) invalidRunState()
  return {
    contentType: record.contentType,
    objectKey: record.objectKey,
    objectVersionId: record.objectVersionId,
    sizeBytes: record.sizeBytes,
    versionId: record.versionId,
  }
}

/** Parses one exact completed File-copy version. */
function parseRecordedScratchObjectVersion(
  value: unknown,
): RestoreDrillRecordedScratchObjectVersion {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'bucketName',
        'destinationProof',
        'drillDigest',
        'kind',
        'objectKey',
        'objectVersionId',
        'sourceProof',
        'versionId',
      ],
    ) ||
    record.kind !== 'scratch-object-version' ||
    !isNonEmptyString(record.bucketName, 63) ||
    typeof record.drillDigest !== 'string' ||
    !/^[a-f0-9]{16}$/.test(record.drillDigest) ||
    !isNonEmptyString(record.objectKey, 1_024) ||
    !record.objectKey.startsWith('workspaces/') ||
    !isRestoreDrillObjectKeyPathSafe(record.objectKey) ||
    !isNonEmptyString(record.objectVersionId, 1_024) ||
    !isNonEmptyString(record.versionId, 256)
  ) invalidRunState()
  const destinationProof = parseFileVersionProof(record.destinationProof, 'destination')
  const sourceProof = parseFileVersionProof(record.sourceProof, 'source')
  if (
    sourceProof.contentDigest !== destinationProof.contentDigest ||
    sourceProof.metadataDigest !== destinationProof.metadataDigest ||
    sourceProof.tagsDigest !== destinationProof.tagsDigest ||
    sourceProof.proofMac === destinationProof.proofMac
  ) invalidRunState()
  return {
    bucketName: record.bucketName,
    destinationProof,
    drillDigest: record.drillDigest,
    kind: 'scratch-object-version',
    objectKey: record.objectKey,
    objectVersionId: record.objectVersionId,
    sourceProof,
    versionId: record.versionId,
  }
}

/** Parses one role-bound keyed File-version proof. */
function parseFileVersionProof(
  value: unknown,
  role: RestoreDrillFileVersionProof['role'],
): RestoreDrillFileVersionProof {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), [
      'contentDigest',
      'metadataDigest',
      'physicalIdentityDigest',
      'proofMac',
      'proofVersion',
      'role',
      'tagsDigest',
    ]) ||
    !isHexDigest(record.contentDigest) ||
    !isHexDigest(record.metadataDigest) ||
    !isHexDigest(record.physicalIdentityDigest) ||
    !isHexDigest(record.proofMac) ||
    record.proofVersion !== 1 ||
    record.role !== role ||
    !isHexDigest(record.tagsDigest)
  ) invalidRunState()
  return {
    contentDigest: record.contentDigest,
    metadataDigest: record.metadataDigest,
    physicalIdentityDigest: record.physicalIdentityDigest,
    proofMac: record.proofMac,
    proofVersion: 1,
    role,
    tagsDigest: record.tagsDigest,
  }
}

/** Checks whether a verified copy extends one exact created identity. */
function sameCreatedScratchVersion(
  created: RestoreDrillCreatedScratchObjectVersion,
  recorded: RestoreDrillCreatedScratchObjectVersion,
): boolean {
  return created.bucketName === recorded.bucketName &&
    created.drillDigest === recorded.drillDigest &&
    created.kind === recorded.kind &&
    created.objectKey === recorded.objectKey &&
    created.objectVersionId === recorded.objectVersionId &&
    created.versionId === recorded.versionId
}

/** Parses one resumable export listing checkpoint. */
function parseExportListingCheckpoint(value: unknown): RestoreDrillExportListingCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'complete',
    'cursor',
    'objectCount',
    'pageCount',
    'started',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    typeof record.complete !== 'boolean' ||
    record.started !== true ||
    (record.complete && record.cursor !== undefined) ||
    !isNonNegativeInteger(record.objectCount) ||
    !isNonNegativeInteger(record.pageCount) ||
    record.pageCount < 1
  ) invalidRunState()
  const cursor = record.cursor === undefined
    ? undefined
    : parseExportObjectVersionCursor(record.cursor)
  return {
    complete: record.complete,
    ...(cursor ? { cursor } : {}),
    objectCount: record.objectCount,
    pageCount: record.pageCount,
    started: true,
  }
}

/** Parses exact S3 ListObjectVersions continuation markers. */
function parseExportObjectVersionCursor(value: unknown): RestoreDrillExportObjectVersionCursor {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), ['keyMarker', 'versionIdMarker']) ||
    !isNonEmptyString(record.keyMarker, 1_024) ||
    !isNonEmptyString(record.versionIdMarker, 1_024)
  ) invalidRunState()
  return {
    keyMarker: record.keyMarker,
    versionIdMarker: record.versionIdMarker,
  }
}

/** Parses one exact export-created object version. */
function parseRecordedExportObjectVersion(
  value: unknown,
): RestoreDrillRecordedExportObjectVersion {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'bucketName',
        'exportArnDigest',
        'kind',
        'objectKey',
        'objectVersionId',
        'scratchPrefix',
      ],
    ) ||
    record.kind !== 'export-object-version' ||
    !isNonEmptyString(record.bucketName, 63) ||
    !isHexDigest(record.exportArnDigest) ||
    !isNonEmptyString(record.objectKey, 1_024) ||
    !isNonEmptyString(record.objectVersionId, 1_024) ||
    !isNonEmptyString(record.scratchPrefix, 1_024) ||
    !record.objectKey.startsWith(`${record.scratchPrefix}/`) ||
    !isRestoreDrillObjectKeyPathSafe(record.objectKey)
  ) invalidRunState()
  return {
    bucketName: record.bucketName,
    exportArnDigest: record.exportArnDigest,
    kind: 'export-object-version',
    objectKey: record.objectKey,
    objectVersionId: record.objectVersionId,
    scratchPrefix: record.scratchPrefix,
  }
}

/** Parses one exact drill-owned incomplete multipart-upload identity. */
function parseRecordedMultipartUpload(value: unknown): RestoreDrillRecordedMultipartUpload {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['bucketName', 'kind', 'objectKey', 'uploadId'],
    ) ||
    record.kind !== 'scratch-multipart-upload' ||
    !isNonEmptyString(record.bucketName, 63) ||
    !isNonEmptyString(record.objectKey, 1_024) ||
    !isRestoreDrillObjectKeyPathSafe(record.objectKey) ||
    !isNonEmptyString(record.uploadId, 2_048)
  ) invalidRunState()
  return {
    bucketName: record.bucketName,
    kind: 'scratch-multipart-upload',
    objectKey: record.objectKey,
    uploadId: record.uploadId,
  }
}

/** Parses one strict cleanup-ledger target by its fixed discriminator. */
function parseCleanupTarget(value: unknown): RestoreDrillCleanupTarget {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  switch (record.kind) {
    case 'restore-table':
      return parseRecordedRestoreTable(record)
    case 'scratch-object-version':
      return parseCreatedScratchObjectVersion(record)
    case 'export-object-version':
      return parseRecordedExportObjectVersion(record)
    case 'scratch-multipart-upload':
      return parseRecordedMultipartUpload(record)
    default:
      return invalidRunState()
  }
}

/** Parses one bounded run-prefix multipart-upload listing checkpoint. */
function parseMultipartUploadListingCheckpoint(
  value: unknown,
): RestoreDrillMultipartUploadListingCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'complete',
    'cursor',
    'pageCount',
    'started',
    'uploadCount',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    typeof record.complete !== 'boolean' ||
    record.started !== true ||
    (record.complete && record.cursor !== undefined) ||
    !isNonNegativeInteger(record.pageCount) ||
    record.pageCount < 1 ||
    !isNonNegativeInteger(record.uploadCount)
  ) invalidRunState()
  const cursor = record.cursor === undefined
    ? undefined
    : parseMultipartUploadCursor(record.cursor)
  return {
    complete: record.complete,
    ...(cursor ? { cursor } : {}),
    pageCount: record.pageCount,
    started: true,
    uploadCount: record.uploadCount,
  }
}

/** Parses exact S3 multipart-upload continuation markers. */
function parseMultipartUploadCursor(value: unknown): RestoreDrillMultipartUploadCursor {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), ['keyMarker', 'uploadIdMarker']) ||
    !isNonEmptyString(record.keyMarker, 1_024) ||
    !isNonEmptyString(record.uploadIdMarker, 2_048)
  ) invalidRunState()
  return { keyMarker: record.keyMarker, uploadIdMarker: record.uploadIdMarker }
}

/** Parses exact completed DescribeExport metadata. */
function parseExportCompletion(value: unknown): RestoreDrillExportCompletion {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['exportArnDigest', 'itemCount', 'manifestKey', 'target'],
    ) ||
    !isHexDigest(record.exportArnDigest) ||
    !isNonNegativeInteger(record.itemCount) ||
    !isNonEmptyString(record.manifestKey, 1_024) ||
    !record.manifestKey.includes('/AWSDynamoDB/') ||
    !record.manifestKey.endsWith('/manifest-summary.json') ||
    !isRestoreDrillObjectKeyPathSafe(record.manifestKey) ||
    !isTableTarget(record.target)
  ) invalidRunState()
  return {
    exportArnDigest: record.exportArnDigest,
    itemCount: record.itemCount,
    manifestKey: record.manifestKey,
    target: record.target,
  }
}

/** Parses constant-size final CopyObject reconciliation progress. */
function parseCopyReconciliationCheckpoint(
  value: unknown,
): RestoreDrillCopyReconciliationCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'complete',
    'createdCopyCount',
    'currentDigest',
    'cursor',
    'intentCount',
    'pass',
    'passDigest',
    'quietUntil',
    'started',
    'terminalCursor',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    typeof record.complete !== 'boolean' ||
    record.started !== true ||
    !isNonNegativeInteger(record.createdCopyCount) ||
    !isNonNegativeInteger(record.intentCount) ||
    (record.pass !== 1 && record.pass !== 2) ||
    (record.cursor !== undefined && !isCopyIntentCursor(record.cursor)) ||
    (record.terminalCursor !== undefined && !isCopyIntentCursor(record.terminalCursor)) ||
    (record.currentDigest !== undefined && !isHexDigest(record.currentDigest)) ||
    (record.passDigest !== undefined && !isHexDigest(record.passDigest)) ||
    (record.quietUntil !== undefined && !isCanonicalTimestamp(record.quietUntil)) ||
    (!record.complete &&
      (record.intentCount === 0) !== (record.cursor === undefined)) ||
    (!record.complete && record.intentCount > 0 && !isHexDigest(record.currentDigest)) ||
    (record.pass === 1 && (
      record.passDigest !== undefined || record.quietUntil !== undefined ||
      record.terminalCursor !== undefined || record.complete
    )) ||
    (record.pass === 2 && (
      !isHexDigest(record.passDigest) || !isCanonicalTimestamp(record.quietUntil)
    )) ||
    (record.complete && (
      record.cursor !== undefined || !isHexDigest(record.currentDigest) ||
      stableDigestValue(record.currentDigest) !== stableDigestValue(record.passDigest)
    ))
  ) invalidRunState()
  return {
    complete: record.complete,
    createdCopyCount: record.createdCopyCount,
    ...(typeof record.currentDigest === 'string'
      ? { currentDigest: record.currentDigest }
      : {}),
    ...(typeof record.cursor === 'string' ? { cursor: record.cursor } : {}),
    intentCount: record.intentCount,
    pass: record.pass,
    ...(typeof record.passDigest === 'string' ? { passDigest: record.passDigest } : {}),
    ...(typeof record.quietUntil === 'string' ? { quietUntil: record.quietUntil } : {}),
    started: true,
    ...(typeof record.terminalCursor === 'string'
      ? { terminalCursor: record.terminalCursor }
      : {}),
  }
}

/** Returns a digest value without widening strict parser branches. */
function stableDigestValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Creates one empty cleanup-scope sealing checkpoint. */
function emptyCleanupScopeCheckpoint(): RestoreDrillCleanupScopeCheckpoint {
  return {
    complete: false,
    exportObjectCount: 0,
    fileObjectCount: 0,
    multipartUploadCount: 0,
    started: false,
    tableCount: 0,
  }
}

/** Parses constant-size authenticated cleanup-scope sealing progress. */
function parseCleanupScopeCheckpoint(value: unknown): RestoreDrillCleanupScopeCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'complete',
    'cursor',
    'exportObjectCount',
    'fileObjectCount',
    'ledgerCount',
    'ledgerRevision',
    'multipartUploadCount',
    'resourceDigest',
    'rollingDigest',
    'started',
    'tableCount',
    'terminalCursor',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    typeof record.complete !== 'boolean' ||
    record.started !== true ||
    !isNonNegativeInteger(record.exportObjectCount) ||
    !isNonNegativeInteger(record.fileObjectCount) ||
    !isNonNegativeInteger(record.multipartUploadCount) ||
    !isNonNegativeInteger(record.tableCount) ||
    !isHexDigest(record.rollingDigest) ||
    (record.cursor !== undefined && !isCleanupTargetCursor(record.cursor)) ||
    (record.terminalCursor !== undefined && !isCleanupTargetCursor(record.terminalCursor)) ||
    (record.complete && (
      record.cursor !== undefined || !isHexDigest(record.resourceDigest) ||
      !isNonNegativeInteger(record.ledgerCount) ||
      record.ledgerCount !== record.ledgerRevision ||
      record.ledgerCount !== record.tableCount + record.fileObjectCount +
        record.exportObjectCount + record.multipartUploadCount ||
      (record.ledgerCount === 0) !== (record.terminalCursor === undefined)
    )) ||
    (!record.complete && (
      record.resourceDigest !== undefined || record.ledgerCount !== undefined ||
      record.ledgerRevision !== undefined
    ))
  ) invalidRunState()
  return {
    complete: record.complete,
    ...(typeof record.cursor === 'string' ? { cursor: record.cursor } : {}),
    exportObjectCount: record.exportObjectCount,
    fileObjectCount: record.fileObjectCount,
    ...(typeof record.ledgerCount === 'number' ? { ledgerCount: record.ledgerCount } : {}),
    ...(typeof record.ledgerRevision === 'number'
      ? { ledgerRevision: record.ledgerRevision }
      : {}),
    multipartUploadCount: record.multipartUploadCount,
    ...(typeof record.resourceDigest === 'string'
      ? { resourceDigest: record.resourceDigest }
      : {}),
    rollingDigest: record.rollingDigest,
    started: true,
    tableCount: record.tableCount,
    ...(typeof record.terminalCursor === 'string'
      ? { terminalCursor: record.terminalCursor }
      : {}),
  }
}

/** Parses exact bounded cleanup progress. */
function parseCleanupProgress(
  value: unknown,
  expectedDrillId: string,
): RestoreDrillCleanupProgress {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'absenceReceiptCount',
    'absenceReceiptDigest',
    'artifactIntent',
    'completedAt',
    'exportObjectIndex',
    'fileObjectIndex',
    'multipartUploadIndex',
    'tableIndex',
    'targetCursor',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    Object.keys(record).length < 5 ||
    !isNonNegativeInteger(record.absenceReceiptCount) ||
    (record.absenceReceiptCount === 0 && record.absenceReceiptDigest !== undefined) ||
    (record.absenceReceiptCount > 0 && !isHexDigest(record.absenceReceiptDigest)) ||
    (record.completedAt !== undefined && !isCanonicalTimestamp(record.completedAt)) ||
    !isNonNegativeInteger(record.exportObjectIndex) ||
    !isNonNegativeInteger(record.fileObjectIndex) ||
    !isNonNegativeInteger(record.multipartUploadIndex) ||
    !isNonNegativeInteger(record.tableIndex) ||
    (record.targetCursor !== undefined && !isCleanupTargetCursor(record.targetCursor)) ||
    (record.absenceReceiptCount === 0) !== (record.targetCursor === undefined) ||
    record.absenceReceiptCount !== record.exportObjectIndex +
      record.fileObjectIndex + record.multipartUploadIndex + record.tableIndex ||
    (record.artifactIntent !== undefined && record.completedAt === undefined)
  ) invalidRunState()
  const artifactIntent = record.artifactIntent === undefined
    ? undefined
    : parseCleanupArtifactIntent(record.artifactIntent, expectedDrillId)
  if (
    artifactIntent !== undefined &&
    artifactIntent.retentionReferenceAt !== record.completedAt
  ) invalidRunState()
  return {
    absenceReceiptCount: record.absenceReceiptCount,
    ...(typeof record.absenceReceiptDigest === 'string'
      ? { absenceReceiptDigest: record.absenceReceiptDigest }
      : {}),
    ...(artifactIntent ? { artifactIntent } : {}),
    ...(typeof record.completedAt === 'string' ? { completedAt: record.completedAt } : {}),
    exportObjectIndex: record.exportObjectIndex,
    fileObjectIndex: record.fileObjectIndex,
    multipartUploadIndex: record.multipartUploadIndex,
    tableIndex: record.tableIndex,
    ...(typeof record.targetCursor === 'string'
      ? { targetCursor: record.targetCursor }
      : {}),
  }
}

/** Strictly parses exact cleanup artifact bytes pinned before Object-Lock publication. */
function parseCleanupArtifactIntent(
  value: unknown,
  expectedDrillId: string,
): RestoreDrillCleanupArtifactIntent {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['artifactJson', 'evidenceKey', 'retentionReferenceAt'],
    ) ||
    typeof record.artifactJson !== 'string' ||
    Buffer.byteLength(record.artifactJson, 'utf8') > 350_000 ||
    record.evidenceKey !== cleanupEvidenceKey(expectedDrillId) ||
    !isCanonicalTimestamp(record.retentionReferenceAt)
  ) invalidRunState()
  let artifactValue: unknown
  try {
    artifactValue = JSON.parse(record.artifactJson)
  } catch {
    return invalidRunState()
  }
  if (stableJson(artifactValue) !== record.artifactJson) invalidRunState()
  const artifact = requireRecord(artifactValue, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(artifact).sort(), [
      'absenceReceiptDigest',
      'approvalAttemptCount',
      'approvalDigest',
      'approvalObjectKey',
      'cleanupVersion',
      'completedAt',
      'deletedExportObjectCount',
      'deletedFileObjectCount',
      'deletedMultipartUploadCount',
      'deletedTableCount',
      'drillId',
      'expectedExportObjectCount',
      'expectedFileObjectCount',
      'expectedMultipartUploadCount',
      'expectedTableCount',
      'kind',
      'resourceDigest',
      'resultDigest',
      'startedAt',
    ]) ||
    artifact.kind !== 'mukuroji-restore-drill-cleanup' ||
    artifact.cleanupVersion !== 1 ||
    artifact.drillId !== expectedDrillId ||
    artifact.completedAt !== record.retentionReferenceAt ||
    !isCanonicalTimestamp(artifact.completedAt) ||
    !isCanonicalTimestamp(artifact.startedAt) ||
    Date.parse(artifact.startedAt) > Date.parse(artifact.completedAt) ||
    !isHexDigest(artifact.absenceReceiptDigest) ||
    !isPositiveInteger(artifact.approvalAttemptCount) ||
    !isHexDigest(artifact.approvalDigest) ||
    typeof artifact.approvalObjectKey !== 'string' ||
    !new RegExp(
      `^approvals/v1/runs/${escapeRegularExpression(expectedDrillId)}/[a-f0-9]{64}\\.json$`,
    ).test(artifact.approvalObjectKey) ||
    !isNonNegativeInteger(artifact.deletedExportObjectCount) ||
    !isNonNegativeInteger(artifact.deletedFileObjectCount) ||
    !isNonNegativeInteger(artifact.deletedMultipartUploadCount) ||
    !isNonNegativeInteger(artifact.deletedTableCount) ||
    !isNonNegativeInteger(artifact.expectedExportObjectCount) ||
    !isNonNegativeInteger(artifact.expectedFileObjectCount) ||
    !isNonNegativeInteger(artifact.expectedMultipartUploadCount) ||
    !isNonNegativeInteger(artifact.expectedTableCount) ||
    artifact.deletedExportObjectCount !== artifact.expectedExportObjectCount ||
    artifact.deletedFileObjectCount !== artifact.expectedFileObjectCount ||
    artifact.deletedMultipartUploadCount !== artifact.expectedMultipartUploadCount ||
    artifact.deletedTableCount !== artifact.expectedTableCount ||
    !isHexDigest(artifact.resourceDigest) ||
    !isHexDigest(artifact.resultDigest)
  ) invalidRunState()
  return {
    artifactJson: record.artifactJson,
    evidenceKey: record.evidenceKey,
    retentionReferenceAt: record.retentionReferenceAt,
  }
}

/** Verifies pinned cleanup bytes against the current immutable scope and progress. */
function validateCleanupArtifactBinding(
  intent: RestoreDrillCleanupArtifactIntent,
  run: RestoreDrillDurableRun,
  progress: RestoreDrillCleanupProgress,
  scope: RestoreDrillCleanupScopeCheckpoint,
): void {
  let value: unknown
  try {
    value = JSON.parse(intent.artifactJson)
  } catch {
    return invalidRunState()
  }
  const artifact = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    artifact.drillId !== run.drillId ||
    artifact.completedAt !== progress.completedAt ||
    artifact.startedAt !== run.cleanupStartedAt ||
    artifact.resourceDigest !== run.resourceDigest ||
    artifact.resultDigest !== run.resultDigest ||
    !isPositiveInteger(artifact.approvalAttemptCount) ||
    artifact.approvalAttemptCount > (run.cleanupAttemptCount ?? 0) ||
    artifact.deletedExportObjectCount !== progress.exportObjectIndex ||
    artifact.deletedFileObjectCount !== progress.fileObjectIndex ||
    artifact.deletedMultipartUploadCount !== progress.multipartUploadIndex ||
    artifact.deletedTableCount !== progress.tableIndex ||
    artifact.expectedExportObjectCount !== scope.exportObjectCount ||
    artifact.expectedFileObjectCount !== scope.fileObjectCount ||
    artifact.expectedMultipartUploadCount !== scope.multipartUploadCount ||
    artifact.expectedTableCount !== scope.tableCount
  ) invalidRunState()
}

/** Creates the absent-item identity used by the first verification-progress CAS. */
function initialVerificationProgress(): RestoreDrillVerificationProgress {
  return {
    pageCount: 0,
    partitionCount: 0,
    restoreResources: [],
    revision: 0,
    semanticItemCount: 0,
    semanticPageCount: 0,
    sourceResources: [],
    stage: 'file-data',
    targetIndex: 0,
    unitIndex: 0,
    workItemsSchemaStatus: 'pass',
  }
}

/** Creates one deterministic individually addressable manifest-entry key. */
function verificationManifestRecordKey(
  target: RestoreDrillTableTarget,
  index: number,
): string {
  return `VERIFY_MANIFEST#${target}#${String(index).padStart(6, '0')}`
}

/** Creates the digest-only lookup prefix for an exact export object key. */
function verificationExportObjectRecordPrefix(
  exportArnDigest: string,
  objectKey: string,
): string {
  return `VERIFY_EXPORT_OBJECT#${exportArnDigest}#${sha256Hex(objectKey)}#`
}

/** Creates one exact-version export-object lookup record key. */
function verificationExportObjectRecordKey(
  version: RestoreDrillRecordedExportObjectVersion,
): string {
  return `${verificationExportObjectRecordPrefix(
    version.exportArnDigest,
    version.objectKey,
  )}${sha256Hex(version.objectVersionId)}`
}

/** Creates the opaque logical-partition token prefix for one role and target. */
function verificationPartitionRecordPrefix(
  role: RestoreDrillVerificationPartitionRole,
  target: RestoreDrillTableTarget,
): string {
  return `VERIFY_PARTITION#${role}#${target}#`
}

/** Creates one opaque logical-partition token record key. */
function verificationPartitionRecordKey(
  role: RestoreDrillVerificationPartitionRole,
  target: RestoreDrillTableTarget,
  digest: string,
): string {
  return `${verificationPartitionRecordPrefix(role, target)}${digest}`
}

/** Creates one exact opaque semantic-ledger record key. */
function semanticClaimRecordKey(
  claim: Exclude<RestoreDrillSemanticClaim, RestoreDrillSemanticAuditCandidate>,
): string {
  if (claim.kind === 'fact') {
    return `VERIFY_SEMANTIC_FACT#${claim.factToken}#${claim.originToken}`
  }
  if (claim.kind === 'unique') return `VERIFY_SEMANTIC_UNIQUE#${claim.uniqueToken}`
  if (claim.kind === 'requirement') {
    return `VERIFY_SEMANTIC_REQUIREMENT#${claim.requirementToken}`
  }
  return `VERIFY_SEMANTIC_FAILURE#${claim.failureCode}#${claim.failureToken}`
}

/** Strictly parses an ephemeral semantic claim before any state operation. */
function parseSemanticClaimForWrite(value: unknown): RestoreDrillSemanticClaim {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (record.kind === 'requirement') return parseSemanticRequirement(record)
  if (record.kind === 'fact') {
    if (
      !sameStringVector(Object.keys(record).sort(), ['factToken', 'kind', 'originToken']) ||
      !isHexDigest(record.factToken) ||
      !isHexDigest(record.originToken)
    ) invalidRunState()
    return { factToken: record.factToken, kind: 'fact', originToken: record.originToken }
  }
  if (record.kind === 'unique') return parseSemanticUniqueClaim(record)
  if (record.kind === 'failure') {
    if (
      !sameStringVector(Object.keys(record).sort(), ['failureCode', 'failureToken', 'kind']) ||
      !isCrossDomainIntegrityFailureCode(record.failureCode) ||
      !isHexDigest(record.failureToken)
    ) invalidRunState()
    return {
      failureCode: record.failureCode,
      failureToken: record.failureToken,
      kind: 'failure',
    }
  }
  if (record.kind === 'audit-candidate') {
    if (
      !sameStringVector(
        Object.keys(record).sort(),
        ['eventOrder', 'historical', 'kind', 'requirement', 'resourceToken'],
      ) ||
      typeof record.eventOrder !== 'string' ||
      Buffer.byteLength(record.eventOrder, 'utf8') < 1 ||
      Buffer.byteLength(record.eventOrder, 'utf8') > 4_096 ||
      typeof record.historical !== 'boolean' ||
      !isHexDigest(record.resourceToken)
    ) invalidRunState()
    return {
      eventOrder: record.eventOrder,
      historical: record.historical,
      kind: 'audit-candidate',
      requirement: parseSemanticRequirement(record.requirement),
      resourceToken: record.resourceToken,
    }
  }
  return invalidRunState()
}

/** Strictly parses one immutable semantic uniqueness owner. */
function parseSemanticUniqueClaim(
  value: unknown,
): Extract<RestoreDrillSemanticClaim, { readonly kind: 'unique' }> {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['duplicateFailureCode', 'kind', 'originToken', 'uniqueToken'],
    ) ||
    record.kind !== 'unique' ||
    !isCrossDomainIntegrityFailureCode(record.duplicateFailureCode) ||
    !isHexDigest(record.originToken) ||
    !isHexDigest(record.uniqueToken)
  ) invalidRunState()
  return {
    duplicateFailureCode: record.duplicateFailureCode,
    kind: 'unique',
    originToken: record.originToken,
    uniqueToken: record.uniqueToken,
  }
}

/** Strictly parses one deferred semantic requirement and its ordered branches. */
function parseSemanticRequirement(value: unknown): RestoreDrillSemanticRequirement {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), ['branches', 'kind', 'requirementToken']) ||
    record.kind !== 'requirement' ||
    !isHexDigest(record.requirementToken) ||
    !Array.isArray(record.branches) ||
    record.branches.length < 1 ||
    record.branches.length > 3
  ) invalidRunState()
  const branches = record.branches.map(parseSemanticRequirementBranch)
  for (let index = 0; index < branches.length; index += 1) {
    const branch = branches[index]
    if (
      !branch ||
      (index < branches.length - 1 && branch.guardToken === undefined) ||
      (index === branches.length - 1 && branch.guardToken !== undefined)
    ) invalidRunState()
  }
  return { branches, kind: 'requirement', requirementToken: record.requirementToken }
}

/** Strictly parses one ordered semantic requirement branch. */
function parseSemanticRequirementBranch(value: unknown): RestoreDrillSemanticRequirementBranch {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'defaultFailureCode',
    'fallbacks',
    'guardToken',
    'satisfied',
    'successTokens',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    !isCrossDomainIntegrityFailureCode(record.defaultFailureCode) ||
    !Array.isArray(record.fallbacks) ||
    record.fallbacks.length > 3 ||
    (record.guardToken !== undefined && !isHexDigest(record.guardToken)) ||
    typeof record.satisfied !== 'boolean' ||
    !Array.isArray(record.successTokens) ||
    record.successTokens.length > 3 ||
    !record.successTokens.every(isHexDigest) ||
    new Set(record.successTokens).size !== record.successTokens.length ||
    (record.satisfied && (record.fallbacks.length > 0 || record.successTokens.length > 0))
  ) invalidRunState()
  const fallbacks = record.fallbacks.map((fallback): RestoreDrillSemanticFallback => {
    const candidate = requireRecord(fallback, 'RUN_STATE_INVALID')
    if (
      !sameStringVector(Object.keys(candidate).sort(), ['factToken', 'failureCode']) ||
      !isHexDigest(candidate.factToken) ||
      !isCrossDomainIntegrityFailureCode(candidate.failureCode)
    ) invalidRunState()
    return { factToken: candidate.factToken, failureCode: candidate.failureCode }
  })
  return {
    defaultFailureCode: record.defaultFailureCode,
    fallbacks,
    ...(typeof record.guardToken === 'string' ? { guardToken: record.guardToken } : {}),
    satisfied: record.satisfied,
    successTokens: [...record.successTokens],
  }
}

/** Strictly parses one HMAC-only latest Audit lifecycle winner. */
function parseSemanticAuditLatest(value: unknown): RestoreDrillSemanticAuditLatest {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set(['orderTokens', 'requirement'])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    !Array.isArray(record.orderTokens) ||
    record.orderTokens.length < 1 ||
    record.orderTokens.length > 4_096 ||
    !record.orderTokens.every(isHexDigest)
  ) invalidRunState()
  return {
    orderTokens: [...record.orderTokens],
    ...(record.requirement === undefined
      ? {}
      : { requirement: parseSemanticRequirement(record.requirement) }),
  }
}

/** Converts one ephemeral Audit candidate into a raw-value-free durable winner. */
function createSemanticAuditLatest(
  claim: RestoreDrillSemanticAuditCandidate,
  digestKey: Uint8Array,
): RestoreDrillSemanticAuditLatest {
  const bytes = Buffer.from(claim.eventOrder, 'utf8')
  if (bytes.length < 1 || bytes.length > 4_096) invalidRunState()
  const orderTokens: string[] = []
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (byte === undefined) invalidRunState()
    orderTokens.push(semanticAuditOrderToken(digestKey, claim.resourceToken, index, byte))
  }
  return {
    orderTokens,
    ...(claim.historical ? {} : { requirement: claim.requirement }),
  }
}

/** Compares raw candidate bytes against an opaque persisted order-token vector. */
function compareSemanticAuditOrder(
  eventOrder: string,
  persistedTokens: readonly string[],
  resourceToken: string,
  digestKey: Uint8Array,
): number {
  const bytes = Buffer.from(eventOrder, 'utf8')
  const sharedLength = Math.min(bytes.length, persistedTokens.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const nextByte = bytes[index]
    const persistedToken = persistedTokens[index]
    if (nextByte === undefined || persistedToken === undefined) invalidRunState()
    if (semanticAuditOrderToken(digestKey, resourceToken, index, nextByte) === persistedToken) {
      continue
    }
    let persistedByte: number | undefined
    for (let candidate = 0; candidate <= 255; candidate += 1) {
      if (semanticAuditOrderToken(digestKey, resourceToken, index, candidate) === persistedToken) {
        persistedByte = candidate
        break
      }
    }
    if (persistedByte === undefined) invalidRunState()
    return nextByte - persistedByte
  }
  return bytes.length - persistedTokens.length
}

/** Creates one domain-separated HMAC token for an Audit ordering byte. */
function semanticAuditOrderToken(
  digestKey: Uint8Array,
  resourceToken: string,
  index: number,
  byte: number,
): string {
  return createRestoreDrillSemanticToken(
    digestKey,
    'audit-order-byte',
    [resourceToken, String(index), String(byte)],
  )
}

/** Checks one stable cross-domain failure category. */
function isCrossDomainIntegrityFailureCode(
  value: unknown,
): value is CrossDomainIntegrityFailureCode {
  return typeof value === 'string' && CROSS_DOMAIN_FAILURE_CODES.has(value)
}

const CROSS_DOMAIN_FAILURE_CODES = new Set<string>([
  'AUDIT_RESOURCE_MISSING',
  'AUDIT_TENANT_MISMATCH',
  'CONFIGURATION_DUPLICATE_SCOPE',
  'CURSOR_LOOP',
  'DUPLICATE_RECORD',
  'FILE_METADATA_OBJECT_MISMATCH',
  'FILE_METADATA_OBJECT_MISSING',
  'FILE_METADATA_REFERENCE_MISSING',
  'FILE_METADATA_TENANT_MISMATCH',
  'FILE_OBJECT_METADATA_MISSING',
  'INTEGRITY_LIMIT_EXCEEDED',
  'RELATION_ENDPOINT_MISSING',
  'RELATION_ENDPOINT_TEAM_MISMATCH',
  'RELATION_PROJECT_MISSING',
  'RELATION_PROJECT_TEAM_MISMATCH',
  'RELATION_RECIPROCAL_MISSING',
  'RELATION_TEAM_MISSING',
  'RELATION_TENANT_MISMATCH',
  'RESTORE_AUDIT_DIFFERENCE',
  'RESTORE_CHECK_FAILED',
  'RESTORE_CONFIGURATION_DIFFERENCE',
  'RESTORE_FILE_DIFFERENCE',
  'RESTORE_RELATION_DIFFERENCE',
  'RESTORE_RESOURCE_DIFFERENCE',
  'RESTORE_RESULT_AUTHENTICATION_FAILED',
  'RESTORE_WORK_ITEM_DIFFERENCE',
  'SOURCE_CHECK_FAILED',
  'SOURCE_RESULT_AUTHENTICATION_FAILED',
  'SOURCE_RESTORE_CHECKED_AT_MISMATCH',
  'SOURCE_RESTORE_KEY_MISMATCH',
  'SOURCE_RESTORE_LIMITS_MISMATCH',
  'SOURCE_RESTORE_RESOURCE_BINDING_MISMATCH',
  'SOURCE_RESTORE_RESOURCE_IDENTITY_REUSED',
  'SOURCE_RESTORE_ROLE_MISMATCH',
  'WORK_ITEM_CREATOR_MEMBER_MISSING',
  'WORK_ITEM_CREATOR_TENANT_MISMATCH',
  'WORK_ITEM_PROJECT_MISSING',
  'WORK_ITEM_PROJECT_TEAM_MISMATCH',
  'WORK_ITEM_RELATION_PROJECTION_MISMATCH',
  'WORK_ITEM_STATUS_CATEGORY_MISMATCH',
  'WORK_ITEM_TEAM_MISSING',
  'WORK_ITEM_TENANT_MISMATCH',
  'WORK_ITEM_WORKFLOW_STATUS_UNKNOWN',
])

/** Checks that a token vector is canonical, unique, and safe for keyed state records. */
function isSortedUniqueHexDigests(digests: readonly string[]): boolean {
  let preceding: string | undefined
  for (const digest of digests) {
    if (!isHexDigest(digest) || (preceding !== undefined && preceding >= digest)) return false
    preceding = digest
  }
  return true
}

/** Strictly parses one individually stored source export data-file reference. */
function parseVerificationManifestFile(value: unknown): RestoreDrillExportDataFile {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record).sort(), ['itemCount', 'md5Checksum', 'objectKey']) ||
    !isNonNegativeInteger(record.itemCount) ||
    record.itemCount > MAX_VERIFICATION_RECORDS_PER_SOURCE_FILE ||
    typeof record.md5Checksum !== 'string' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(record.md5Checksum) ||
    !isNonEmptyString(record.objectKey, 2_048) ||
    !record.objectKey.includes('/AWSDynamoDB/') ||
    !record.objectKey.includes('/data/') ||
    !record.objectKey.endsWith('.json.gz') ||
    !isRestoreDrillObjectKeyPathSafe(record.objectKey)
  ) invalidRunState()
  return {
    itemCount: record.itemCount,
    md5Checksum: record.md5Checksum,
    objectKey: record.objectKey,
  }
}

/** Strictly parses one compact keyed multiset checkpoint. */
function parseVerificationMultisetCheckpoint(
  value: unknown,
): RestoreDrillKeyedMultisetDigestCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      ['checkpointMac', 'checkpointVersion', 'itemCount', 'keyFingerprint', 'modularSum'],
    ) ||
    record.checkpointVersion !== 1 ||
    !isNonNegativeInteger(record.itemCount) ||
    !isHexDigest(record.checkpointMac) ||
    !isHexDigest(record.keyFingerprint) ||
    !isHexDigest(record.modularSum)
  ) invalidRunState()
  return {
    checkpointMac: record.checkpointMac,
    checkpointVersion: 1,
    itemCount: record.itemCount,
    keyFingerprint: record.keyFingerprint,
    modularSum: record.modularSum,
  }
}

/** Strictly parses one constant-size authenticated table aggregate checkpoint. */
function parseVerificationAggregateCheckpoint(
  value: unknown,
): RestoreDrillDynamoAggregateCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'checkpointMac',
        'checkpointVersion',
        'content',
        'keys',
        'keySchemaDigest',
        'partitionDigests',
        'recordCount',
        'target',
      ],
    ) ||
    record.checkpointVersion !== 1 ||
    !isHexDigest(record.checkpointMac) ||
    !isHexDigest(record.keySchemaDigest) ||
    !Array.isArray(record.partitionDigests) ||
    record.partitionDigests.length !== 0 ||
    !isNonNegativeInteger(record.recordCount) ||
    record.recordCount > MAX_VERIFICATION_RECORDS_PER_TARGET ||
    !isTableTarget(record.target)
  ) invalidRunState()
  const content = parseVerificationMultisetCheckpoint(record.content)
  const keys = parseVerificationMultisetCheckpoint(record.keys)
  if (content.itemCount !== record.recordCount || keys.itemCount !== record.recordCount) {
    invalidRunState()
  }
  return {
    checkpointMac: record.checkpointMac,
    checkpointVersion: 1,
    content,
    keys,
    keySchemaDigest: record.keySchemaDigest,
    partitionDigests: [],
    recordCount: record.recordCount,
    target: record.target,
  }
}

/** Strictly parses compact independently accumulated File proof state. */
function parseFileVerificationCheckpoint(
  value: unknown,
): RestoreDrillFileVerificationCheckpoint {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'destinationContent',
        'destinationMetadata',
        'recordCount',
        'sourceContent',
        'sourceMetadata',
      ],
    ) ||
    !isNonNegativeInteger(record.recordCount) ||
    record.recordCount > MAX_VERIFICATION_FILE_VERSIONS
  ) invalidRunState()
  const destinationContent = parseVerificationMultisetCheckpoint(
    record.destinationContent,
  )
  const destinationMetadata = parseVerificationMultisetCheckpoint(
    record.destinationMetadata,
  )
  const sourceContent = parseVerificationMultisetCheckpoint(record.sourceContent)
  const sourceMetadata = parseVerificationMultisetCheckpoint(record.sourceMetadata)
  if (
    destinationContent.itemCount !== record.recordCount ||
    destinationMetadata.itemCount !== record.recordCount ||
    sourceContent.itemCount !== record.recordCount ||
    sourceMetadata.itemCount !== record.recordCount
  ) invalidRunState()
  return {
    destinationContent,
    destinationMetadata,
    recordCount: record.recordCount,
    sourceContent,
    sourceMetadata,
  }
}

/** Strictly parses one completed table resource retained in resumable progress. */
function parseVerificationResourceAggregate(value: unknown): RestoreDrillResourceAggregate {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'contentDigest',
        'descriptorDigest',
        'logicalPartitionCount',
        'metadataDigest',
        'recordCount',
        'target',
      ],
    ) ||
    !isHexDigest(record.contentDigest) ||
    !isHexDigest(record.descriptorDigest) ||
    !isHexDigest(record.metadataDigest) ||
    !isNonNegativeInteger(record.logicalPartitionCount) ||
    !isNonNegativeInteger(record.recordCount) ||
    record.recordCount > MAX_VERIFICATION_RECORDS_PER_TARGET ||
    record.logicalPartitionCount > record.recordCount ||
    (record.target !== 'bucket:file' && !isTableTarget(record.target))
  ) invalidRunState()
  return {
    contentDigest: record.contentDigest,
    descriptorDigest: record.descriptorDigest,
    logicalPartitionCount: record.logicalPartitionCount,
    metadataDigest: record.metadataDigest,
    recordCount: record.recordCount,
    target: record.target,
  }
}

/** Strictly parses constant-size resumable aggregate-verification progress. */
function parseVerificationProgress(value: unknown): RestoreDrillVerificationProgress {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  const allowedKeys = new Set([
    'aggregateCheckpoint',
    'auditPseudonymSecretVersionId',
    'crossDomainStatus',
    'fileAggregateCheckpoint',
    'fileInventoryCursor',
    'manifestFileCount',
    'manifestItemCount',
    'nextKey',
    'pageCount',
    'partitionCount',
    'partitionCursor',
    'restoreResources',
    'restoreFileResource',
    'revision',
    'semanticItemCount',
    'semanticNextCursor',
    'semanticPageCount',
    'semanticRequirementCursor',
    'sourceResources',
    'sourceFileResource',
    'stage',
    'targetIndex',
    'unitIndex',
    'workItemsSchemaStatus',
  ])
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    !isNonNegativeInteger(record.pageCount) ||
    record.pageCount > MAX_VERIFICATION_RESTORE_PAGES_PER_TARGET ||
    !isNonNegativeInteger(record.partitionCount) ||
    record.partitionCount > MAX_VERIFICATION_RECORDS_PER_TARGET ||
    !isNonNegativeInteger(record.revision) ||
    !isNonNegativeInteger(record.semanticItemCount) ||
    record.semanticItemCount > MAX_VERIFICATION_SEMANTIC_UNITS ||
    !isNonNegativeInteger(record.semanticPageCount) ||
    record.semanticPageCount > MAX_VERIFICATION_SEMANTIC_PAGES ||
    !isNonNegativeInteger(record.targetIndex) ||
    record.targetIndex > RESTORE_DRILL_TABLE_TARGETS.length ||
    !isNonNegativeInteger(record.unitIndex) ||
    record.unitIndex > MAX_VERIFICATION_MANIFEST_FILES_PER_TARGET ||
    !Array.isArray(record.restoreResources) ||
    record.restoreResources.length > RESTORE_DRILL_TABLE_TARGETS.length ||
    !Array.isArray(record.sourceResources) ||
    record.sourceResources.length > RESTORE_DRILL_TABLE_TARGETS.length ||
    !isVerificationStage(record.stage) ||
    (record.auditPseudonymSecretVersionId !== undefined &&
      !isSecretsManagerVersionId(record.auditPseudonymSecretVersionId)) ||
    (record.crossDomainStatus !== undefined &&
      record.crossDomainStatus !== 'fail' && record.crossDomainStatus !== 'pass') ||
    (record.workItemsSchemaStatus !== 'fail' && record.workItemsSchemaStatus !== 'pass') ||
    (record.manifestFileCount !== undefined &&
      (!isPositiveInteger(record.manifestFileCount) ||
        record.manifestFileCount > MAX_VERIFICATION_MANIFEST_FILES_PER_TARGET)) ||
    (record.manifestItemCount !== undefined &&
      (!isNonNegativeInteger(record.manifestItemCount) ||
        record.manifestItemCount > MAX_VERIFICATION_RECORDS_PER_TARGET))
  ) invalidRunState()
  const sourceResources = record.sourceResources.map(parseVerificationResourceAggregate)
  const restoreResources = record.restoreResources.map(parseVerificationResourceAggregate)
  for (let index = 0; index < sourceResources.length; index += 1) {
    if (sourceResources[index]?.target !== RESTORE_DRILL_TABLE_TARGETS[index]) invalidRunState()
  }
  for (let index = 0; index < restoreResources.length; index += 1) {
    if (restoreResources[index]?.target !== RESTORE_DRILL_TABLE_TARGETS[index]) invalidRunState()
  }
  const aggregateCheckpoint = record.aggregateCheckpoint === undefined
    ? undefined
    : parseVerificationAggregateCheckpoint(record.aggregateCheckpoint)
  const fileAggregateCheckpoint = record.fileAggregateCheckpoint === undefined
    ? undefined
    : parseFileVerificationCheckpoint(record.fileAggregateCheckpoint)
  const fileInventoryCursor = record.fileInventoryCursor === undefined
    ? undefined
    : isCopyIntentCursor(record.fileInventoryCursor)
      ? record.fileInventoryCursor
      : invalidRunState()
  const restoreFileResource = record.restoreFileResource === undefined
    ? undefined
    : parseVerificationResourceAggregate(record.restoreFileResource)
  const sourceFileResource = record.sourceFileResource === undefined
    ? undefined
    : parseVerificationResourceAggregate(record.sourceFileResource)
  const nextKey = record.nextKey === undefined
    ? undefined
    : cloneStrictAttributeMap(requireAttributeMap(record.nextKey))
  const partitionCursor = record.partitionCursor === undefined
    ? undefined
    : parseVerificationPartitionCursor(record.partitionCursor)
  const semanticNextCursor = record.semanticNextCursor === undefined
    ? undefined
    : isNonEmptyString(record.semanticNextCursor, 16_384)
      ? record.semanticNextCursor
      : invalidRunState()
  const semanticRequirementCursor = record.semanticRequirementCursor === undefined
    ? undefined
    : parseSemanticRequirementCursor(record.semanticRequirementCursor)
  const completeResourceStage = record.stage === 'assembly' ||
    record.stage === 'semantic-audit' ||
    record.stage === 'semantic-claims' ||
    record.stage === 'semantic-requirements' ||
    record.stage === 'semantic-secret'
  const terminalTargetStage = record.stage === 'assembly' ||
    record.stage === 'semantic-audit' ||
    record.stage === 'semantic-requirements' ||
    record.stage === 'semantic-secret'
  if (
    terminalTargetStage !==
      (record.targetIndex === RESTORE_DRILL_TABLE_TARGETS.length) ||
    (completeResourceStage &&
      (sourceResources.length !== RESTORE_DRILL_TABLE_TARGETS.length ||
        restoreResources.length !== RESTORE_DRILL_TABLE_TARGETS.length)) ||
    (!terminalTargetStage && record.targetIndex >= RESTORE_DRILL_TABLE_TARGETS.length) ||
    ((record.stage === 'file-data' || record.stage === 'file-partition-count') &&
      (record.targetIndex !== 0 || sourceResources.length !== 0 || restoreResources.length !== 0)) ||
    (fileAggregateCheckpoint !== undefined &&
      record.stage !== 'file-data' && record.stage !== 'file-partition-count') ||
    (fileInventoryCursor !== undefined && record.stage !== 'file-data') ||
    ((restoreFileResource === undefined) !== (sourceFileResource === undefined)) ||
    (restoreFileResource !== undefined && restoreFileResource.target !== 'bucket:file') ||
    (sourceFileResource !== undefined && sourceFileResource.target !== 'bucket:file') ||
    ((record.stage === 'file-data' || record.stage === 'file-partition-count') &&
      restoreFileResource !== undefined) ||
    (completeResourceStage && restoreFileResource === undefined) ||
    (aggregateCheckpoint !== undefined &&
      aggregateCheckpoint.target !== RESTORE_DRILL_TABLE_TARGETS[record.targetIndex]) ||
    (nextKey !== undefined && record.stage !== 'restore-data') ||
    (semanticNextCursor !== undefined && record.stage !== 'semantic-claims') ||
    (semanticRequirementCursor !== undefined &&
      record.stage !== 'semantic-audit' && record.stage !== 'semantic-requirements') ||
    ((record.stage === 'semantic-claims' ||
      record.stage === 'semantic-audit' ||
      record.stage === 'semantic-requirements' ||
      record.stage === 'assembly') &&
      record.auditPseudonymSecretVersionId === undefined) ||
    (record.stage === 'semantic-secret' &&
      record.auditPseudonymSecretVersionId !== undefined) ||
    ((record.stage === 'assembly') !== (record.crossDomainStatus !== undefined)) ||
    (partitionCursor !== undefined &&
      record.stage !== 'restore-partition-count' &&
      record.stage !== 'source-partition-count' &&
      record.stage !== 'file-partition-count')
  ) invalidRunState()
  return {
    ...(aggregateCheckpoint ? { aggregateCheckpoint } : {}),
    ...(typeof record.auditPseudonymSecretVersionId === 'string'
      ? { auditPseudonymSecretVersionId: record.auditPseudonymSecretVersionId }
      : {}),
    ...(record.crossDomainStatus === 'fail' || record.crossDomainStatus === 'pass'
      ? { crossDomainStatus: record.crossDomainStatus }
      : {}),
    ...(fileAggregateCheckpoint ? { fileAggregateCheckpoint } : {}),
    ...(fileInventoryCursor ? { fileInventoryCursor } : {}),
    ...(typeof record.manifestFileCount === 'number'
      ? { manifestFileCount: record.manifestFileCount }
      : {}),
    ...(typeof record.manifestItemCount === 'number'
      ? { manifestItemCount: record.manifestItemCount }
      : {}),
    ...(nextKey ? { nextKey } : {}),
    pageCount: record.pageCount,
    partitionCount: record.partitionCount,
    ...(partitionCursor ? { partitionCursor } : {}),
    restoreResources,
    ...(restoreFileResource ? { restoreFileResource } : {}),
    revision: record.revision,
    semanticItemCount: record.semanticItemCount,
    ...(semanticNextCursor ? { semanticNextCursor } : {}),
    semanticPageCount: record.semanticPageCount,
    ...(semanticRequirementCursor ? { semanticRequirementCursor } : {}),
    sourceResources,
    ...(sourceFileResource ? { sourceFileResource } : {}),
    stage: record.stage,
    targetIndex: record.targetIndex,
    unitIndex: record.unitIndex,
    workItemsSchemaStatus: record.workItemsSchemaStatus,
  }
}

/** Checks one durable verification stage. */
function isVerificationStage(value: unknown): value is RestoreDrillVerificationStage {
  return value === 'assembly' ||
    value === 'file-data' ||
    value === 'file-partition-count' ||
    value === 'restore-data' ||
    value === 'restore-partition-count' ||
    value === 'semantic-audit' ||
    value === 'semantic-claims' ||
    value === 'semantic-requirements' ||
    value === 'semantic-secret' ||
    value === 'source-data' ||
    value === 'source-manifest' ||
    value === 'source-partition-count'
}

/** Strictly parses one opaque partition-ledger count cursor. */
function parseVerificationPartitionCursor(
  value: unknown,
): RestoreDrillVerificationPartitionCursor {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record), ['recordKey']) ||
    !isNonEmptyString(record.recordKey, 256) ||
    !record.recordKey.startsWith('VERIFY_PARTITION#')
  ) invalidRunState()
  return { recordKey: record.recordKey }
}

/** Strictly parses one opaque semantic requirement-ledger cursor. */
function parseSemanticRequirementCursor(
  value: unknown,
): RestoreDrillSemanticRequirementCursor {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(Object.keys(record), ['recordKey']) ||
    !isNonEmptyString(record.recordKey, 256) ||
    (!record.recordKey.startsWith('VERIFY_SEMANTIC_REQUIREMENT#') &&
      !record.recordKey.startsWith('VERIFY_SEMANTIC_AUDIT_LATEST#'))
  ) invalidRunState()
  return { recordKey: record.recordKey }
}

/** Narrows one untrusted value to an AttributeValue map before strict cloning. */
function requireAttributeMap(value: unknown): Readonly<Record<string, AttributeValue>> {
  if (!isRecord(value)) invalidRunState()
  const result: Record<string, AttributeValue> = {}
  for (const [key, attribute] of Object.entries(value)) {
    if (
      !isRecord(attribute) ||
      !sameStringVector(Object.keys(attribute), ['S']) ||
      !isNonEmptyString(attribute.S, 2_048)
    ) invalidRunState()
    result[key] = { S: attribute.S }
  }
  return result
}

/** Parses a complete strict verification checkpoint. */
function parseVerificationResult(value: unknown): RestoreDrillVerificationResult {
  const record = requireRecord(value, 'RUN_STATE_INVALID')
  if (
    !sameStringVector(
      Object.keys(record).sort(),
      [
        'crossDomainStatus',
        'resourceIdentities',
        'restoreAggregate',
        'sourceAggregate',
        'workItemsSchemaStatus',
      ],
    ) ||
    (record.crossDomainStatus !== 'fail' && record.crossDomainStatus !== 'pass') ||
    (record.workItemsSchemaStatus !== 'fail' && record.workItemsSchemaStatus !== 'pass') ||
    !Array.isArray(record.resourceIdentities) ||
    record.resourceIdentities.length !== RESTORE_DRILL_RESOURCE_TARGETS.length
  ) invalidRunState()
  const resourceIdentities: RestoreDrillResourceIdentity[] = []
  for (let index = 0; index < record.resourceIdentities.length; index += 1) {
    const candidate = requireRecord(record.resourceIdentities[index], 'RUN_STATE_INVALID')
    const expectedTarget = RESTORE_DRILL_RESOURCE_TARGETS[index]
    if (
      !expectedTarget ||
      !sameStringVector(Object.keys(candidate).sort(), ['identityDigest', 'target']) ||
      candidate.target !== expectedTarget ||
      !isHexDigest(candidate.identityDigest)
    ) invalidRunState()
    resourceIdentities.push({ identityDigest: candidate.identityDigest, target: expectedTarget })
  }
  return {
    crossDomainStatus: record.crossDomainStatus,
    resourceIdentities,
    restoreAggregate: parseRestoreDrillDatasetAggregate(record.restoreAggregate),
    sourceAggregate: parseRestoreDrillDatasetAggregate(record.sourceAggregate),
    workItemsSchemaStatus: record.workItemsSchemaStatus,
  }
}

/** Parses one exact immutable data-owner approval body. */
function parseApprovalReceipt(
  value: unknown,
  expectedDrillId: string,
): RestoreDrillCleanupApprovalReceipt {
  const record = requireRecord(value, 'APPROVAL_INVALID')
  const expectedKeys = [
    'algorithm',
    'approvalMac',
    'approvedAt',
    'approver',
    'changeLocator',
    'drillId',
    'expiresAt',
    'keyFingerprint',
    'kind',
    'policyVersion',
    'receiptVersion',
    'resourceDigest',
    'resultDigest',
  ]
  if (
    !sameStringVector(Object.keys(record).sort(), expectedKeys) ||
    record.kind !== 'mukuroji-restore-drill-cleanup-approval' ||
    record.receiptVersion !== 1 ||
    record.algorithm !== 'HMAC-SHA-256' ||
    record.drillId !== expectedDrillId ||
    record.policyVersion !== RESTORE_DRILL_CLEANUP_POLICY_VERSION ||
    !isCanonicalTimestamp(record.approvedAt) ||
    !isCanonicalTimestamp(record.expiresAt) ||
    !isNonEmptyString(record.approver, 512) ||
    !isNonEmptyString(record.changeLocator, 1_024) ||
    !isHexDigest(record.keyFingerprint) ||
    !isHexDigest(record.approvalMac) ||
    !isHexDigest(record.resourceDigest) ||
    !isHexDigest(record.resultDigest)
  ) {
    throw new RestoreDrillOrchestratorFailure('APPROVAL_INVALID')
  }
  return {
    algorithm: 'HMAC-SHA-256',
    approvalMac: record.approvalMac,
    approvedAt: record.approvedAt,
    approver: record.approver,
    changeLocator: record.changeLocator,
    drillId: expectedDrillId,
    expiresAt: record.expiresAt,
    keyFingerprint: record.keyFingerprint,
    kind: 'mukuroji-restore-drill-cleanup-approval',
    policyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
    receiptVersion: 1,
    resourceDigest: record.resourceDigest,
    resultDigest: record.resultDigest,
  }
}

/** Clones an opaque cursor whose configured table keys are all DynamoDB strings. */
function cloneStrictAttributeMap(
  value: Readonly<Record<string, AttributeValue>>,
): Record<string, AttributeValue> {
  const entries = Object.entries(value)
  if (entries.length < 1 || entries.length > 2) {
    throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
  }
  const result: Record<string, AttributeValue> = {}
  for (const [name, attribute] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]{0,254}$/.test(name) ||
      typeof attribute.S !== 'string' ||
      attribute.S.length === 0 ||
      Object.keys(attribute).length !== 1
    ) {
      throw new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID')
    }
    result[name] = { S: attribute.S }
  }
  return result
}
