import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { types as nodeUtilTypes } from 'node:util'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  calculateCrossDomainIntegrityImmutableResourceIdentity,
  createCrossDomainIntegrityImmutableResourceIdentities,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_MAX_DURATION_MILLISECONDS,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
  parseCrossDomainIntegrityResourceAttestation,
  serializeCrossDomainIntegrityResourceAttestation,
  validateCrossDomainIntegrityLimits,
  type CrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import {
  type AttributeValue,
  DescribeContinuousBackupsCommand,
  type DescribeContinuousBackupsCommandOutput,
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  DescribeTimeToLiveCommand,
  type DescribeTimeToLiveCommandOutput,
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandOutput,
  QueryCommand,
  type QueryCommandOutput,
  ResourceNotFoundException,
  ScanCommand,
  type ScanCommandOutput,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  DescribeKeyCommand,
  type DescribeKeyCommandOutput,
  KMSClient,
} from '@aws-sdk/client-kms'
import {
  GetBucketTaggingCommand,
  type GetBucketTaggingOutput,
  type GetBucketVersioningCommandOutput,
  GetObjectAttributesCommand,
  type GetObjectAttributesCommandOutput,
  GetObjectTaggingCommand,
  type GetObjectTaggingCommandOutput,
  GetObjectCommand,
  type GetObjectCommandOutput,
  GetBucketEncryptionCommand,
  type GetBucketEncryptionOutput,
  GetBucketLoggingCommand,
  type GetBucketLoggingOutput,
  GetBucketVersioningCommand,
  type GetBucketVersioningOutput,
  GetObjectLockConfigurationCommand,
  type GetObjectLockConfigurationOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3'
import type { fromIni } from '@aws-sdk/credential-provider-ini'
import {
  isThrottlingError,
  isTransientError,
} from '@smithy/core/retry'
import {
  AssumeRoleCommand,
  type Credentials,
  GetCallerIdentityCommand,
  type GetCallerIdentityCommandOutput,
  STSClient,
} from '@aws-sdk/client-sts'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  requireMigrationIdentifier,
  type DynamoAttributeMap,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import {
  type WorkspaceSearchMigrationIdentityPort,
  type WorkspaceSearchMigrationJournalKeyMetadata,
  type WorkspaceSearchMigrationJournalLookup,
  type WorkspaceSearchMigrationRequestedResources,
  type WorkspaceSearchMigrationRequestedResourcesSnapshot,
  createWorkspaceSearchMigrationIdentityAdapterFailure,
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  createWorkspaceSearchMigrationRequestedResourcesSnapshot,
  isWorkspaceSearchMigrationIdentityAdapterFailure,
  measureWorkspaceSearchMigrationConfiguration,
} from './migration-identity'
import {
  createWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStore,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointAwsTransport,
} from './migration-describe-table-rate-budget-aws'
import type {
  WorkspaceSearchMigrationDescribeTablePhase,
  WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials,
  WorkspaceSearchMigrationDescribeTablePinnedAwsCredentialsProvider,
  WorkspaceSearchMigrationDescribeTableRateEvidence,
  WorkspaceSearchMigrationDescribeTableRatePolicy,
  WorkspaceSearchMigrationDescribeTableRateRecorder,
} from './migration-describe-table-rate-budget'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
} from './migration-describe-table-rate-budget'
import {
  createWorkspaceSearchMigrationManagedDescribeTableRate,
  createWorkspaceSearchMigrationRehearsalManagedDescribeTableRate,
  WorkspaceSearchMigrationManagedDescribeTableRateError,
  type WorkspaceSearchMigrationManagedDescribeTableRate,
  type WorkspaceSearchMigrationRehearsalDescribeTableRateExercise,
  type WorkspaceSearchMigrationRehearsalDescribeTableRateExerciseReceipt,
} from './migration-describe-table-rate-managed-session'
import {
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
  type WorkspaceSearchMigrationTelemetryRecorder,
} from './migration-telemetry'
import {
  type WorkspaceSearchMigrationSharedProfiles,
  loadWorkspaceSearchMigrationSharedProfiles,
} from './migration-shared-profile-loader'
import {
  AwsCrossDomainIntegrityReader,
  type CrossDomainIntegrityAwsTransport,
  type CrossDomainIntegrityBucketNames,
  type CrossDomainIntegrityTableNames,
} from '../../data-integrity/verify-cross-domain-integrity'
import {
  resolveWorkspaceSearchMigrationRehearsalDeploymentTarget,
} from './migration-deployment-targets'
import {
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  createWorkspaceSearchMigrationRehearsalResourceAttestationDigest,
  verifyWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
  WorkspaceSearchMigrationRehearsalPermitError,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  parseWorkspaceSearchMigrationRehearsalRootPlan,
  type WorkspaceSearchMigrationRehearsalRootPlan,
} from './migration-rehearsal-root-plan'
import {
  createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
  type WorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
} from './migration-rehearsal-integrity-rate-adapter'
import {
  disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
  finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
  runWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
  WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError,
  type WorkspaceSearchMigrationRehearsalIntegrityLiveReadTransport,
  type WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending,
} from './migration-rehearsal-integrity-live-session'
import type {
  WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
} from './migration-rehearsal-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalPrePermitRootSession,
  createWorkspaceSearchMigrationRehearsalRootTimeline,
  WorkspaceSearchMigrationRehearsalPrePermitRootSessionError,
  type WorkspaceSearchMigrationRehearsalPrePermitRootSession,
  type WorkspaceSearchMigrationRehearsalRootAttestationOperation,
  type WorkspaceSearchMigrationRehearsalRootAttestationOperationResult,
  type WorkspaceSearchMigrationRehearsalRootTimeline,
} from './migration-rehearsal-pre-permit-root-session'
import {
  createWorkspaceSearchMigrationRehearsalFaultController,
  type CreateWorkspaceSearchMigrationRehearsalFaultControllerInput,
  type WorkspaceSearchMigrationRehearsalApplyCheckpointTarget,
  type WorkspaceSearchMigrationRehearsalApplyOperationTarget,
  type WorkspaceSearchMigrationRehearsalFaultController,
  type WorkspaceSearchMigrationRehearsalPlanningPageFailpoint,
  type WorkspaceSearchMigrationRehearsalPlanningPageTarget,
} from './migration-rehearsal-faults'
import type {
  WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-fault-observation'
import {
  createWorkspaceSearchMigrationRehearsalEvidenceAwsPublisher,
  type CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput,
  type PublishWorkspaceSearchMigrationRehearsalEvidenceInput,
  type WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher,
} from './migration-rehearsal-evidence-aws'
import {
  createWorkspaceSearchMigrationRehearsalArtifactAwsPublisher,
  type CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput,
  type WorkspaceSearchMigrationRehearsalArtifactAwsPublisher,
} from './migration-rehearsal-artifact-aws'
import {
  createWorkspaceSearchMigrationRehearsalStageReservationAwsStore,
  prepareWorkspaceSearchMigrationRehearsalStageReservationAwsCommit,
  prepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaim,
  WorkspaceSearchMigrationRehearsalStageReservationAwsError,
  type PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsCommitInput,
  type PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaimInput,
  type PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsCommit,
  type PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsClaim,
  type WorkspaceSearchMigrationRehearsalStageDurabilityRecovery,
  type WorkspaceSearchMigrationRehearsalStageHead,
  type WorkspaceSearchMigrationRehearsalStageReservationCommitResult,
  type WorkspaceSearchMigrationRehearsalStageReservationAwsTransport,
} from './migration-rehearsal-stage-reservation-aws'
import {
  verifyWorkspaceSearchMigrationRehearsalStageManifest,
  verifyWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  verifyWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint,
  readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment,
  type WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
} from './migration-rehearsal-stage-reservation-abandonment'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
} from './maintenance-evidence'
import {
  createAwsWorkspaceSearchMigrationApplicationWriterFencePort,
  type ReleaseWorkspaceSearchMigrationApplicationWriterFenceInput,
  type WorkspaceSearchMigrationApplicationWriterFenceAwsPort,
} from './migration-application-writer-fence-aws'
import {
  createAwsWorkspaceSearchMigrationApplyOperationPort,
  createAwsWorkspaceSearchMigrationApplyRunStateReader,
  parseWorkspaceSearchMigrationApplyAuthorityAuditRecord,
  parseWorkspaceSearchMigrationApplyMarkerAuditRecord,
  type WorkspaceSearchMigrationApplyAuditBindingInput,
  type WorkspaceSearchMigrationApplyCheckpointScanner,
  type WorkspaceSearchMigrationApplyOperationAuthorityPort,
  type WorkspaceSearchMigrationApplyOperationAwsPort,
  type WorkspaceSearchMigrationApplyOperationAwsTransport,
  type WorkspaceSearchMigrationApplyRunStateAwsTransport,
} from './migration-apply-operation-aws'
import {
  createWorkspaceSearchMigrationApplyReceiptAwsBinding,
} from './migration-apply-receipt-aws'
import {
  createWorkspaceSearchMigrationAppliedRootStrongReadCommand,
  parseWorkspaceSearchMigrationAppliedRootStrongReadOutput,
} from './migration-applied-root-aws'
import {
  createAwsWorkspaceSearchMigrationApplySealGateway,
} from './migration-apply-seal-aws'
import {
  createAwsWorkspaceSearchMigrationExecutionBoundaryPort,
  type WorkspaceSearchMigrationExecutionBoundaryAwsPort,
  type WorkspaceSearchMigrationExecutionBoundaryAwsTransport,
} from './migration-execution-boundary-aws'
import type {
  WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createAwsWorkspaceSearchMigrationExecutionRunPort,
  type WorkspaceSearchMigrationExecutionRunAwsPort,
  type WorkspaceSearchMigrationExecutionRunAwsTransport,
} from './migration-execution-run-aws'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createAwsWorkspaceSearchMigrationFullVerificationPort,
  type WorkspaceSearchMigrationFullVerificationAppliedRootReader,
  type WorkspaceSearchMigrationFullVerificationAuthorityPort,
  type WorkspaceSearchMigrationFullVerificationAwsPort,
  type WorkspaceSearchMigrationFullVerificationAwsTransport,
  type WorkspaceSearchMigrationFullVerificationPageScanner,
  type WorkspaceSearchMigrationFullVerificationPlanReplayGateway,
} from './migration-full-verification-aws'
import {
  reduceWorkspaceSearchMigrationFullVerificationSourcePage,
  reduceWorkspaceSearchMigrationFullVerificationTargetPage,
  type WorkspaceSearchMigrationFullVerificationResult,
} from './migration-full-verification'
import {
  createAwsWorkspaceSearchMigrationPrePlanAuthorityPort,
  type RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  type WorkspaceSearchMigrationDurableLeaseAcquisitionObservation,
  type WorkspaceSearchMigrationDurableLeaseAcquisitionObserver,
  type WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsPort,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
  type WorkspaceSearchMigrationPrePlanAuthorityClaim,
  type WorkspaceSearchMigrationPrePlanAuthorityClock,
  type WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
} from './migration-pre-plan-authority-aws'
import {
  createAwsWorkspaceSearchMigrationSourceEvidencePort,
  type WorkspaceSearchMigrationPlanningSourceArtifactGateway,
  type WorkspaceSearchMigrationSourceEvidenceAwsPort,
  type WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  type WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  type WorkspaceSearchMigrationSourceEvidenceAwsTransport,
  type WorkspaceSearchMigrationSourceEvidenceScanner,
} from './migration-source-evidence-aws'
import {
  createAwsWorkspaceSearchMigrationSourceArtifactPort,
  type WorkspaceSearchMigrationSourceArtifactAwsTransport,
} from './migration-source-artifact-aws'
import {
  type WorkspaceSearchMigrationPlanningSourceArtifactPage,
  WORKSPACE_SEARCH_MIGRATION_SOURCE_ARTIFACT_VERSION,
} from './migration-source-artifact'
import type {
  WorkspaceSearchMigrationPlanArtifactReplayResult,
} from './migration-plan-artifact'
import {
  createWorkspaceSearchMigrationSourceEvidenceProgressDigest,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationSourceEvidenceProgress,
  type WorkspaceSearchMigrationSourceEvidenceReplayResult,
} from './migration-source-evidence'
import {
  normalizeWorkspaceSearchMigrationSourceScanOutput,
  type WorkspaceSearchMigrationSourceScanAwsTransport,
  type WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
  type ReduceWorkspaceSearchMigrationSourceScanPageInput,
  type WorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPageResult,
} from './migration-source-scan-page'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
  prepareWorkspaceSearchMigrationSourceScanContext,
} from './migration-source-scan-context'
import {
  createAwsWorkspaceSearchMigrationTargetArtifactPort,
  type WorkspaceSearchMigrationTargetArtifactAwsTransport,
} from './migration-target-artifact-aws'
import {
  type WorkspaceSearchMigrationPlanningTargetArtifactPage,
  WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
} from './migration-target-artifact'
import {
  createWorkspaceSearchMigrationTargetEvidenceProgressDigest,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
  type WorkspaceSearchMigrationTargetEvidenceReplayResult,
} from './migration-target-evidence'
import {
  createAwsWorkspaceSearchMigrationTargetEvidencePort,
  type WorkspaceSearchMigrationPlanningTargetArtifactGateway,
  type WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  type WorkspaceSearchMigrationTargetEvidenceAwsPort,
  type WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  type WorkspaceSearchMigrationTargetEvidenceAwsTransport,
} from './migration-target-evidence-aws'
import {
  normalizeWorkspaceSearchMigrationTargetScanOutput,
  type WorkspaceSearchMigrationTargetScanAwsTransport,
  type WorkspaceSearchMigrationTargetScanReadInput,
} from './migration-target-scan-aws'
import {
  createWorkspaceSearchMigrationApplyTargetScanPredecessor,
  reduceWorkspaceSearchMigrationApplyTargetScanPage,
} from './migration-apply-target-scan-page'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
  type ReduceWorkspaceSearchMigrationTargetScanPageInput,
  type WorkspaceSearchMigrationTargetScanPage,
  type WorkspaceSearchMigrationTargetScanPageResult,
} from './migration-target-scan-page'
import {
  prepareWorkspaceSearchMigrationTargetScanContext,
} from './migration-target-scan-context'
import {
  joinWorkspaceSearchMigrationPlanningEvidence,
  type WorkspaceSearchMigrationPlanningJoinResult,
} from './migration-planning-join'
import {
  createAwsWorkspaceSearchMigrationImmutableArtifactPort,
  hasWorkspaceSearchMigrationImmutableArtifactRetentionHeadroom,
  type WorkspaceSearchMigrationImmutableArtifactAwsPort,
  type WorkspaceSearchMigrationImmutableArtifactAwsTransport,
} from './migration-immutable-artifact-aws'
import {
  createAwsWorkspaceSearchMigrationJournalGateway,
} from './migration-journal-aws'
import {
  createAwsWorkspaceSearchMigrationCommittedPrefixApplySealGateway,
} from './migration-committed-prefix-apply-seal-aws'
import {
  createAwsWorkspaceSearchMigrationPartialRollbackOperationPort,
  type WorkspaceSearchMigrationPartialRollbackOperationAwsPort,
  type WorkspaceSearchMigrationPartialRollbackOperationAwsTransport,
} from './migration-partial-rollback-operation-aws'
import {
  createAwsWorkspaceSearchMigrationPartialRollbackStartPort,
  type WorkspaceSearchMigrationPartialRollbackStartAwsPort,
  type WorkspaceSearchMigrationPartialRollbackStartAwsTransport,
} from './migration-partial-rollback-start-aws'
import {
  createAwsWorkspaceSearchMigrationRollbackOperationPort,
  type WorkspaceSearchMigrationRollbackAppliedRootReader,
  type WorkspaceSearchMigrationRollbackApplyRunStateReader,
  type WorkspaceSearchMigrationRollbackOperationAuthorityReader,
  type WorkspaceSearchMigrationRollbackOperationAwsPort,
  type WorkspaceSearchMigrationRollbackOperationAwsTransport,
} from './migration-rollback-operation-aws'
import type {
  WorkspaceSearchMigrationPlanningJoinLimits,
  WorkspaceSearchMigrationPlanningMaterialReadLimits,
  WorkspaceSearchMigrationPlanningSourceChainMaterial,
  WorkspaceSearchMigrationPlanningTargetChainMaterial,
} from './migration-planning-material'
import {
  createAwsWorkspaceSearchMigrationPlanningArtifactGateway,
  type WorkspaceSearchMigrationPlanningArtifactAwsGateway,
  type WorkspaceSearchMigrationStoredPlanningProvenanceArtifact,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_ARTIFACT_MAX_OBJECT_BYTES,
} from './migration-planning-artifact-aws'
import {
  createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsTransport,
} from './migration-sealed-planning-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createAwsWorkspaceSearchMigrationVerificationResultGateway,
  type WorkspaceSearchMigrationVerificationResultAwsGateway,
} from './migration-verification-result-aws'
import type {
  WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
  type WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
} from './migration-rehearsal-integrity-evidence'
import {
  type WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  type WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair,
} from './migration-rehearsal-reconciliation-audit'
import {
  collectWorkspaceSearchMigrationRehearsalReconciliationAws,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_AUTHORITY_ADOPTION_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_ITEMS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_PAGES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_REQUEST_TIMEOUT_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalExpectedAuthority,
  type WorkspaceSearchMigrationRehearsalExpectedMarker,
  type WorkspaceSearchMigrationRehearsalReconciliationAwsLimits,
  type WorkspaceSearchMigrationRehearsalReconciliationAwsTransport,
  type WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
} from './migration-rehearsal-reconciliation-aws'
import {
  authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
  type WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding,
} from './migration-rehearsal-target-audit'
import type {
  WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import type {
  AcquireWorkspaceSearchMigrationLeaseInput,
  HeartbeatWorkspaceSearchMigrationLeaseInput,
  WorkspaceSearchMigrationLeaseClaim,
} from './migration-state-machine'

/** AWS services used by the migration identity entry gate. */
type WorkspaceSearchMigrationIdentityAwsService =
  | 'dynamodb'
  | 'kms'
  | 's3'
  | 'sts'

/** Initialization accepted by the explicitly selected shared-profile provider. */
type WorkspaceSearchMigrationProfileCredentialsOptions =
  NonNullable<Parameters<typeof fromIni>[0]>

/** Named-profile role-assumption callback supplied to the AWS SDK. */
type WorkspaceSearchMigrationProfileRoleAssumer = NonNullable<
  WorkspaceSearchMigrationProfileCredentialsOptions['roleAssumer']
>

/** Credentials returned by one safe shared-profile resolution. */
type WorkspaceSearchMigrationProfileCredentials = Awaited<
  ReturnType<ReturnType<typeof fromIni>>
>

/** Immutable selected-chain plan for static shared-profile credentials. */
type WorkspaceSearchMigrationStaticCredentialPlan = {
  /** Credential-plan discriminator. */
  readonly kind: 'static'
  /** Selected source access key ID. */
  readonly accessKeyId: string
  /** Selected source secret access key. */
  readonly secretAccessKey: string
  /** Optional selected source session token. */
  readonly sessionToken: string | undefined
}

/** Immutable selected-chain plan for one explicit AssumeRole hop. */
type WorkspaceSearchMigrationAssumeRoleCredentialPlan = {
  /** Credential-plan discriminator. */
  readonly kind: 'assume-role'
  /** Validated IAM role ARN. */
  readonly roleArn: string
  /** Explicit stable role-session name. */
  readonly roleSessionName: string
  /** Optional external identifier. */
  readonly externalId: string | undefined
  /** Validated STS session duration. */
  readonly durationSeconds: number
  /** Selected source-profile plan for this role. */
  readonly source: WorkspaceSearchMigrationCredentialPlan
}

/** Exact selected source-profile chain retained across credential refreshes. */
type WorkspaceSearchMigrationCredentialPlan =
  | WorkspaceSearchMigrationStaticCredentialPlan
  | WorkspaceSearchMigrationAssumeRoleCredentialPlan

/** Official STS location used by every nested profile role assumption. */
type WorkspaceSearchMigrationRoleAssumptionConfiguration = {
  /** Partition-aware official STS endpoint. */
  readonly endpoint: string
  /** Explicit shared-configuration profile. */
  readonly profile: string
  /** Explicit AWS region. */
  readonly region: string
}

/** Profile mechanisms excluded from the migration's credential boundary. */
const unsupportedWorkspaceSearchMigrationProfileKeys: readonly string[] =
  Object.freeze([
    'credential_process',
    'credential_source',
    'login_session',
    'mfa_serial',
    'sso_account_id',
    'sso_region',
    'sso_role_name',
    'sso_session',
    'sso_start_url',
    'web_identity_token_file',
  ])

/** Refresh lead time shared by every service client in one invocation. */
const PROFILE_CREDENTIAL_REFRESH_WINDOW_MILLISECONDS = 5 * 60 * 1_000

/** Maximum explicit source-profile depth accepted by the migration. */
const MAXIMUM_PROFILE_ROLE_CHAIN_DEPTH = 8

/** Hard deadline for one migration-state transaction SDK request. */
const MIGRATION_STATE_TRANSACTION_TIMEOUT_MILLISECONDS = 5_000

/** Hard deadline for one managed immutable migration-artifact S3 request. */
export const WORKSPACE_SEARCH_MIGRATION_MANAGED_ARTIFACT_REQUEST_TIMEOUT_MILLISECONDS =
  10_000

/** Maximum rows one managed five-chain planning join may retain. */
export const WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_TOTAL_ROWS =
  100_000

/** Maximum canonical item bytes one managed planning join may retain. */
export const WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_CANONICAL_BYTES =
  256 * 1024 * 1024

/** Maximum candidate operations one managed planning join may construct. */
export const WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_OPERATIONS =
  100_000

/** Maximum combined durable evidence pages one managed join may read. */
export const WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_EVIDENCE_PAGES =
  10_000

/**
 * Fixed secret-free timeout emitted when a local state-write deadline aborts.
 */
class MigrationStateTransactionTimeout extends Error {
  /** Node.js timeout code recognized by Smithy's transient-error classifier. */
  readonly code = 'ETIMEDOUT'

  /**
   * Creates one classifier-compatible local transaction timeout.
   */
  constructor() {
    super('Migration-state transaction timed out.')
    this.name = 'TimeoutError'
  }
}

/**
 * Fixed secret-free timeout emitted when one artifact S3 request is aborted.
 */
class MigrationArtifactTimeout extends Error {
  /** Node.js timeout code recognized by Smithy's transient-error classifier. */
  readonly code = 'ETIMEDOUT'

  /**
   * Creates one classifier-compatible local artifact timeout.
   */
  constructor() {
    super('Migration artifact request timed out.')
    this.name = 'TimeoutError'
  }
}

/**
 * Failure codes deliberately emitted by the private managed source data path.
 */
type SourceScanAwsFailureCode =
  | 'CONFIGURATION_DRIFT'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MAINTENANCE_EVIDENCE'
  | 'INVALID_STATE'
  | 'SOURCE_DRIFT'
  | 'TABLE_SCHEMA_MISMATCH'
  | 'TRANSIENT_INFRASTRUCTURE_FAILURE'

/**
 * Failure codes deliberately emitted by the private managed target data path.
 */
type TargetScanAwsFailureCode =
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'
  | 'TARGET_DRIFT'
  | 'TRANSIENT_INFRASTRUCTURE_FAILURE'

/**
 * Secret-free structural AWS error supplied only to Smithy's classifiers.
 */
type SourceScanAwsErrorClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout error code. */
    readonly code?: string
  }

/**
 * Privately branded managed source failure that response data cannot forge.
 */
class SourceScanAwsFailure extends Error {
  /** Stable operator-safe code selected inside the managed session. */
  readonly code: SourceScanAwsFailureCode

  /**
   * Creates one private fixed-code source Scan failure.
   *
   * @param code - Stable code selected by trusted session logic.
   */
  constructor(code: SourceScanAwsFailureCode) {
    super(code)
    this.name = 'SourceScanAwsFailure'
    this.code = code
  }
}

/**
 * Privately branded managed target failure that response data cannot forge.
 */
class TargetScanAwsFailure extends Error {
  /** Stable operator-safe code selected inside the managed session. */
  readonly code: TargetScanAwsFailureCode

  /**
   * Creates one private fixed-code target Scan failure.
   *
   * @param code - Stable code selected by trusted session logic.
   */
  constructor(code: TargetScanAwsFailureCode) {
    super(code)
    this.name = 'TargetScanAwsFailure'
    this.code = code
  }
}

/**
 * Detached reduction state paired with the authority that produced its page.
 */
type PreparedManagedSourceScanReduction = {
  /** Measurement hash captured before the Scan. */
  readonly configurationHash: string
  /** Managed-session generation captured before the Scan. */
  readonly generation: number
  /** Exact predecessor and page that must be reduced together. */
  readonly reductionInput: ReduceWorkspaceSearchMigrationSourceScanPageInput
}

/**
 * Detached target reduction state paired with the authority that produced it.
 */
type PreparedManagedTargetScanReduction = {
  /** Measurement hash captured before the Scan. */
  readonly configurationHash: string
  /** Managed-session generation captured before the Scan. */
  readonly generation: number
  /** Exact predecessor and page that must be reduced together. */
  readonly reductionInput: ReduceWorkspaceSearchMigrationTargetScanPageInput
}

/** Exact private raw page paired with its public digest-only reduction. */
type CapturedManagedSourceScanPage = {
  /** Detached normalized raw Scan items retained only inside the session. */
  readonly page: WorkspaceSearchMigrationSourceScanPage
  /** Digest-only reduction exposed by the public managed session. */
  readonly pageResult: WorkspaceSearchMigrationSourceScanPageResult
}

/** Exact private raw target page paired with its public digest-only reduction. */
type CapturedManagedTargetScanPage = {
  /** Detached normalized raw Scan items retained only inside the session. */
  readonly page: WorkspaceSearchMigrationTargetScanPage
  /** Digest-only reduction exposed by the public managed session. */
  readonly pageResult: WorkspaceSearchMigrationTargetScanPageResult
}

/** One request signal linked to caller cancellation and session sealing. */
type ManagedTargetScanCancellation = {
  /** Signal passed to every finite AWS request in the target page. */
  readonly signal: AbortSignal
  /** Removes listeners after the complete guarded page settles. */
  readonly dispose: () => void
}

/**
 * Measurement authority shared by every migration-state table operation.
 */
type ManagedMigrationStateAuthority = {
  /** Session generation captured before migration-state validation or I/O. */
  readonly generation: number
  /** Exact configuration hash authorized by the current measurement. */
  readonly configurationHash: string
  /** Detached measured migration-state table incarnation. */
  readonly stateTable: MigrationTableIdentity
}

/**
 * Measured generation retained by one managed planning storage operation.
 */
type ManagedPlanningArtifactGenerationAuthority = {
  /** Session generation that installed the immutable object port. */
  readonly generation: number
  /** Exact measured-configuration digest owned by that generation. */
  readonly configurationHash: string
}

/**
 * Current immutable object port paired with its measured generation.
 */
type ManagedPlanningArtifactAuthority =
  ManagedPlanningArtifactGenerationAuthority & {
    /** Private codec-agnostic port installed by successful measurement. */
    readonly immutableArtifactPort:
      WorkspaceSearchMigrationImmutableArtifactAwsPort
  }

/**
 * Measured configuration retained by one zero-I/O artifact preflight.
 */
type ManagedPlanningArtifactPreflightAuthority =
  ManagedPlanningArtifactGenerationAuthority & {
    /** Detached measured configuration owning immutable artifact retention. */
    readonly configuration: WorkspaceSearchMigrationConfiguration
  }

/**
 * Complete measured configuration captured by one sealed publication port.
 */
type ManagedSealedPlanningAuthority = ManagedMigrationStateAuthority & {
  /** Detached configuration owning state and all five evidence tables. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
}

/**
 * Complete measured configuration captured by one writer-fence operator port.
 */
type ManagedApplicationWriterFenceAuthority =
  ManagedMigrationStateAuthority & {
    /** Detached configuration owning state and all five fenced datasets. */
    readonly configuration: WorkspaceSearchMigrationConfiguration
  }

/**
 * Complete measured configuration captured for one execution-boundary port.
 */
type ManagedExecutionBoundaryAuthority =
  ManagedApplicationWriterFenceAuthority

/**
 * Complete measured configuration captured for one execution-run port.
 */
type ManagedExecutionRunAuthority =
  ManagedApplicationWriterFenceAuthority

/**
 * Complete measured authority retained by one apply-operation port.
 */
type ManagedApplyOperationAuthority =
  ManagedExecutionRunAuthority & {
    /** Private immutable object port installed by this generation. */
    readonly immutableArtifactPort:
      WorkspaceSearchMigrationImmutableArtifactAwsPort
  }

/**
 * Complete measured authority retained by one full-verification port.
 */
type ManagedFullVerificationAuthority =
  ManagedApplyOperationAuthority

/**
 * Complete measured authority retained by one rollback-operation port.
 */
type ManagedRollbackOperationAuthority =
  ManagedApplyOperationAuthority

/** Complete measured graph reconstructed before reconciliation Query access. */
type ManagedReconciliationExecutionGraph = {
  /** Captured generation and all-six measured configuration authority. */
  readonly authority: ManagedFullVerificationAuthority
  /** Exact revision-two planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact canonical closed writer-fence row fixed by the boundary. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact immutable sealed planning-authority root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact replayed plan seal, manifest head, and ordered operations. */
  readonly replay: WorkspaceSearchMigrationPlanArtifactReplayResult
  /** Exact immutable execution admission reconstructed from the plan. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
}

/** Seal facts independently read from the complete or committed apply root. */
type ManagedReconciliationMarkerSeal = {
  /** Exact durable marker count in the authenticated seal. */
  readonly markerCount: number
  /** Order-independent aggregate digest of every durable marker. */
  readonly aggregateDigest: string
}

/** Authoritative terminal and reread capability prepared for one scenario. */
type ManagedReconciliationTerminalMaterial = {
  /** Exact immutable terminal identity guarded around every Query page. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding
  /** Complete or committed-prefix marker seal fixed by the apply boundary. */
  readonly markerSeal: ManagedReconciliationMarkerSeal
  /** Successful full-verification result for a verified terminal only. */
  readonly verifiedResult?: WorkspaceSearchMigrationFullVerificationResult
  /**
   * Strongly rereads the same terminal and returns its exact detached identity.
   *
   * @param signal - Collector-owned request-local cancellation signal.
   * @returns Current exact terminal binding.
   */
  readonly readBinding: (
    signal: AbortSignal,
  ) => Promise<
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding
  >
}

/** Expected authenticated source-session fields carried by target audits. */
type ManagedReconciliationTargetSourceBinding = {
  /** Exact reviewed commit owned by the measured session. */
  readonly commit: string
  /** Exact measured six-table configuration digest. */
  readonly configurationHash: string
  /** Session-approved target-audit key digest. */
  readonly evidenceKeyDigest: string
  /** Exact requested-resource inventory digest. */
  readonly sourceResourceBindingDigest: string
  /** Domain-separated digest of the complete source-session binding. */
  readonly sourceSessionBindingDigest: string
}

/** Independently keyed identities for the two migration-owned data tables. */
export type WorkspaceSearchMigrationManagedReconciliationResourceIdentities = {
  /** Exact measured immutable ProjectDirectory table incarnation identity. */
  readonly projectDirectory: CrossDomainIntegrityResourceIdentity
  /** Exact measured immutable WorkItems table incarnation identity. */
  readonly workItems: CrossDomainIntegrityResourceIdentity
}

/**
 * Inputs for independently validating migration-owned #163 table identities.
 */
export type WorkspaceSearchMigrationManagedReconciliationResourceIdentityValidationInput = {
  /** Identities computed before a downstream authenticator consumes its key. */
  readonly expected:
    WorkspaceSearchMigrationManagedReconciliationResourceIdentities
  /** Authenticated identity scheme carried by the permit or live result. */
  readonly resourceIdentityScheme: string
  /** Authenticated canonical seven-entry immutable resource vector. */
  readonly resourceIdentities:
    readonly CrossDomainIntegrityResourceIdentity[]
}

/** Detached reconciliation input retained after the synchronous trust boundary. */
type PreparedManagedReconciliationSessionInput =
  CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput

/** Authenticated scenario-specific target observations for one rollback. */
type ManagedReconciliationAuthenticatedTargetPair = {
  /** Exact authenticated target state captured before apply. */
  readonly preimage:
    WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding
  /** Exact authenticated target state captured after rollback. */
  readonly restored:
    WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding
}

/** Complete collected result fields that do not depend on post-seal #163. */
type ManagedReconciliationCollectedBaseValue = Omit<
  WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
  'integrity'
>

/** Private state retained behind one collected-base capability. */
type ManagedReconciliationCollectedBaseState = {
  /** Detached collector fields measured before rate sealing. */
  readonly base: ManagedReconciliationCollectedBaseValue
  /** Exact permit-bound migration table identities measured in-session. */
  readonly expectedMigrationResourceIdentities:
    WorkspaceSearchMigrationManagedReconciliationResourceIdentities
  /** Exact permit-bound complete seven-resource identity digest. */
  readonly expectedResourceIdentityDigest: string
  /** Authenticated rollback target pair, absent for verified terminals. */
  readonly target?: ManagedReconciliationAuthenticatedTargetPair
  /** Trusted clock retained for post-live completion chronology. */
  readonly clock: () => Date
}

/** Minimal strictly parsed fields needed before the genuine result is consumed. */
type ManagedReconciliationRateBoundIntegrityProjection = {
  /** Strict detached live #163 result projection. */
  readonly result:
    WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection
  /** Reviewed rate policy digest carried by the combined result. */
  readonly policyVersion: string
  /** Measured configuration digest carried by the combined result. */
  readonly configurationBindingDigest: string
}

/** Genuine unconsumed bases indexed by their opaque outer capability. */
const managedReconciliationCollectedBaseStates = new WeakMap<
  WorkspaceSearchMigrationRehearsalCollectedReconciliationBase,
  ManagedReconciliationCollectedBaseState
>()

/**
 * Measurement authority captured for one complete source-evidence operation.
 */
type ManagedSourceEvidenceAuthority<
  Request extends WorkspaceSearchMigrationSourceEvidenceAwsRequest =
    WorkspaceSearchMigrationSourceEvidenceAwsRequest,
> = ManagedMigrationStateAuthority & {
  /** Detached complete request that cannot change after authority capture. */
  readonly request: Request
}

/**
 * Measurement authority captured for one complete target-evidence operation.
 */
type ManagedTargetEvidenceAuthority<
  Request extends WorkspaceSearchMigrationTargetEvidenceAwsRequest =
    WorkspaceSearchMigrationTargetEvidenceAwsRequest,
> = ManagedMigrationStateAuthority & {
  /** Detached complete request that cannot change after authority capture. */
  readonly request: Request
}

/** Operation-local marker proving an authoritative tx received its post-guard. */
type ManagedPlanningEvidencePostSendGuardState = {
  /** Whether the final tx result was already classified by a fresh all-six guard. */
  finalized: boolean
  /** Stable guard failure retained across the adapter's tx reconciliation. */
  failure?: WorkspaceSearchMigrationFailure
}

/** Admission context used by one table-incarnation guard sequence. */
type ManagedTableIncarnationGuardMode =
  | 'new-operation'
  | 'post-send-cleanup'
  | 'reconciliation'

/** Operation-local authority to drain reads after an admitted AWS send. */
type ManagedAwsMutationDrainState = {
  /** Whether descendants may still use this operation-local authority. */
  active: boolean
  /** Whether an actual AWS mutation transport invocation has begun. */
  sent: boolean
}

/**
 * One complete managed planning-join request fixed to a measured generation.
 */
type ManagedPlanningJoinAuthority = ManagedMigrationStateAuthority & {
  /** Detached read-only join request retained across every managed await. */
  readonly request:
    JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput
}

/**
 * Source evidence request and adapter sharing one managed planning authority.
 */
type ManagedPlanningSourceEvidenceContext = {
  /** Exact planning evidence-chain request for this source. */
  readonly request: WorkspaceSearchMigrationSourceEvidenceAwsRequest
  /** Ephemeral evidence adapter guarded by the shared session generation. */
  readonly adapter: WorkspaceSearchMigrationSourceEvidenceAwsPort
}

/**
 * All four source contexts in the migration's fixed canonical source order.
 */
type ManagedPlanningSourceEvidenceContexts = Readonly<
  Record<
    WorkspaceSearchMigrationSourceName,
    ManagedPlanningSourceEvidenceContext
  >
>

/**
 * Target evidence request and adapter sharing one managed planning authority.
 */
type ManagedPlanningTargetEvidenceContext = {
  /** Exact planning target evidence-chain request. */
  readonly request: WorkspaceSearchMigrationTargetEvidenceAwsRequest
  /** Ephemeral target adapter guarded by the shared session generation. */
  readonly adapter: WorkspaceSearchMigrationTargetEvidenceAwsPort
}

/**
 * Five strongly captured evidence heads for one planning material join.
 */
type ManagedPlanningEvidenceHeads = {
  /** Exact source heads indexed by the four fixed source roles. */
  readonly sources: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationSourceEvidenceProgress
    >
  >
  /** Exact Workspace Search target evidence head. */
  readonly target: WorkspaceSearchMigrationTargetEvidenceProgress
}

/**
 * Remaining exact material budget while the five chains are read in order.
 */
type ManagedPlanningMaterialBudget = {
  /** Additional raw rows that may still be retained. */
  rows: number
  /** Additional canonical UTF-8 item bytes that may still be retained. */
  canonicalItemBytes: number
}

/**
 * Complete exact-version material retained privately until the pure join.
 */
type ManagedPlanningEvidenceMaterial = {
  /** Four source chain materials indexed by the fixed source roles. */
  readonly sources: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationPlanningSourceChainMaterial
    >
  >
  /** Exact target chain material. */
  readonly target: WorkspaceSearchMigrationPlanningTargetChainMaterial
}

/**
 * Join result and private raw material retained until provenance preparation.
 */
type ManagedPlanningJoinPreparation = {
  /** Measured generation and detached join request owning the material. */
  readonly authority: ManagedPlanningJoinAuthority
  /** Fully revalidated caller-safe planning join result. */
  readonly result: WorkspaceSearchMigrationPlanningJoinResult
  /** Exact private evidence material used to derive the join result. */
  readonly material: ManagedPlanningEvidenceMaterial
}

/**
 * Read-only managed composition input without caller-supplied raw material.
 */
export type JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput = {
  /** Operator-selected run shared by all five planning evidence chains. */
  readonly runId: string
  /** Exact measured configuration owning the durable evidence. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Explicit total row, canonical-byte, and operation limits. */
  readonly limits: WorkspaceSearchMigrationPlanningJoinLimits
}

/**
 * Input for one zero-I/O measured planning-artifact preflight.
 */
export type ValidateWorkspaceSearchMigrationPlanningArtifactPreflightInput = {
  /** Shared canonical COMPLIANCE retention deadline to validate. */
  readonly retainUntil: string
  /** Additional lower-bound runway required before the first artifact write. */
  readonly minimumAdditionalHeadroomMilliseconds: number
  /** Canonical completion time of the exact reviewed dry-run artifact. */
  readonly reviewedDryRunCompletedAt: string
}

/**
 * Input for one generation-bound write of already prepared provenance.
 */
export type WriteWorkspaceSearchMigrationPreparedPlanningProvenanceInput = {
  /** Shared canonical COMPLIANCE retention deadline for the provenance graph. */
  readonly retainUntil: string
}

/**
 * Opaque prepared planning evidence that keeps restricted page bytes private.
 */
export type WorkspaceSearchMigrationPreparedCommittedPlanningEvidence = {
  /** Fully revalidated planning snapshot, ownership, and plan candidates. */
  readonly result: WorkspaceSearchMigrationPlanningJoinResult
  /**
   * Persists the exact provenance graph prepared from the joined evidence.
   *
   * @param input - Shared immutable retention deadline.
   * @returns Exact stored provenance roots.
   */
  writePlanningProvenanceArtifact(
    input: WriteWorkspaceSearchMigrationPreparedPlanningProvenanceInput,
  ): Promise<WorkspaceSearchMigrationStoredPlanningProvenanceArtifact>
}

/** Explicit AWS SDK client configuration retained for construction tests. */
export type WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration = {
  /** Credentials resolved only from the explicitly selected shared profile. */
  readonly credentials: ReturnType<typeof fromIni>
  /** Partition-aware official regional endpoint. */
  readonly endpoint: string
  /** Explicit shared-configuration profile that selected the credentials. */
  readonly profile: string
  /** Explicit AWS region used by the client. */
  readonly region: string
}

/** S3 client configuration that refuses transparent cross-region redirects. */
export type WorkspaceSearchMigrationIdentityS3SdkClientConfiguration =
  WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration & {
    /** Prevents a journal bucket in another region from being followed. */
    readonly followRegionRedirects: false
  }

/** Complete client configurations supplied to the allowlisted SDK transport. */
export type WorkspaceSearchMigrationIdentityAwsSdkConfigurations = {
  /** DynamoDB control-plane client configuration. */
  readonly dynamodb: WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration
  /** KMS control-plane client configuration. */
  readonly kms: WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration
  /** S3 control-plane client configuration. */
  readonly s3: WorkspaceSearchMigrationIdentityS3SdkClientConfiguration
  /** STS identity client configuration. */
  readonly sts: WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration
}

/** Closeable identity port owned by one migration operator invocation. */
export interface WorkspaceSearchMigrationManagedIdentityPort
  extends WorkspaceSearchMigrationIdentityPort {
  /**
   * Releases resources retained by the AWS SDK clients.
   */
  close(): void
  /**
   * Measures identity with the same immutable resource snapshot that configured
   * this port.
   *
   * @returns Exact measured migration configuration.
   */
  measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration>
}

/**
 * Writer-fence lifecycle capability exposed by a managed AWS session.
 *
 * The standalone writer-fence adapter retains its lower-level close operation
 * for isolated adapter use, but managed callers must close only through the
 * atomic execution-boundary port. Terminal-bound release remains available
 * here because it atomically fixes the immutable execution graph.
 */
export type WorkspaceSearchMigrationManagedApplicationWriterFencePort = Pick<
  WorkspaceSearchMigrationApplicationWriterFenceAwsPort,
  'bootstrapOpen' | 'read' | 'release'
>

/**
 * Caller-safe committed-prefix rollback capability exposed by one managed
 * measurement generation.
 *
 * Lifecycle transaction factories remain private to the composition. Managed
 * callers can only start, inspect, advance, and finish the rollback.
 */
export type WorkspaceSearchMigrationManagedPartialRollbackAwsPort =
  Pick<
    WorkspaceSearchMigrationPartialRollbackStartAwsPort,
    | 'beginRollback'
    | 'readRollbackLifecycle'
    | 'readRollbackState'
  > &
  WorkspaceSearchMigrationPartialRollbackOperationAwsPort

/**
 * Composite measured AWS session for identity, source/target reads, authority
 * I/O, and immutable planning artifact storage.
 */
export interface WorkspaceSearchMigrationManagedAwsSession
  extends
    WorkspaceSearchMigrationManagedIdentityPort,
    WorkspaceSearchMigrationPrePlanAuthorityAwsPort {
  /**
   * Installs one heartbeat-owned guard at every nested data mutation boundary.
   *
   * @param guard - Synchronous lease and commit-headroom assertion.
   * @param task - Complete supervised operation using this session.
   * @returns Exact task result while the guard remains current.
   */
  runWithMutationAdmissionGuard<Result>(
    guard: () => void,
    task: () => Promise<Result>,
  ): Promise<Result>

  /**
   * Reads and reduces one bounded source page through the measured AWS session.
   *
   * @param input - Measured source context and durable predecessor checkpoint.
   * @returns Bound cumulative checkpoint and detached row evidence.
   */
  scanSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPageResult>

  /**
   * Reads and reduces one bounded target page through the measured AWS session.
   *
   * @param input - Measured target context and durable predecessor checkpoint.
   * @param signal - Optional collector deadline or caller cancellation.
   * @returns Bound cumulative checkpoint and detached row evidence.
   */
  scanTargetPage(
    input: WorkspaceSearchMigrationTargetScanReadInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchMigrationTargetScanPageResult>

  /**
   * Reads one durable pre-plan source evidence head.
   *
   * @param input - Exact measured evidence-chain request.
   * @returns Current durable or canonical initial progress.
   */
  readSourceEvidenceProgress(
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress>

  /**
   * Reads and globally validates every page at one captured durable head.
   *
   * @param input - Exact measured evidence-chain request.
   * @returns Replayed row evidence and its exact captured progress.
   */
  readCommittedSourceEvidence(
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceReplayResult>

  /**
   * Scans and atomically commits one next pre-plan source evidence page.
   *
   * @param input - Exact measured evidence-chain request.
   * @returns Exact committed successor or terminal progress.
   */
  commitNextSourceEvidencePage(
    input: WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress>

  /**
   * Reads one durable pre-plan target evidence head.
   *
   * @param input - Exact measured target evidence-chain request.
   * @returns Current durable or canonical initial target progress.
   */
  readTargetEvidenceProgress(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress>

  /**
   * Reads and globally validates every target page at one captured durable head.
   *
   * @param input - Exact measured target evidence-chain request.
   * @returns Replayed target-row evidence and its exact captured progress.
   */
  readCommittedTargetEvidence(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceReplayResult>

  /**
   * Scans and atomically commits one next pre-plan target evidence page.
   *
   * @param input - Exact measured target evidence-chain request and authority.
   * @returns Exact committed successor or terminal target progress.
   */
  commitNextTargetEvidencePage(
    input: WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress>

  /**
   * Reads five fixed terminal planning chains and joins their exact versions.
   *
   * Full raw page material remains private to this measured session. Returned
   * candidates may contain required source or target preimages. Every durable
   * head is strongly reread after the pure join before the result is returned.
   *
   * This read-only result is provisional evidence only. It is not a sealed
   * plan and cannot open the production gate until writer fencing, current
   * authority freshness, and atomic plan/head persistence are implemented.
   *
   * @param input - Run, measured identity, and bounded join limits.
   * @returns Fully revalidated planning snapshot, ownership, and candidates.
   */
  joinCommittedPlanningEvidence(
    input: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPlanningJoinResult>

  /**
   * Prepares a joined result and an opaque provenance writer in one generation.
   *
   * Restricted evidence-page cursor bytes and historical receipt bindings stay
   * inside the managed session. The returned writer is generation-bound and
   * may only persist the exact evidence fixed by this preparation.
   *
   * @param input - Run, measured identity, and bounded join limits.
   * @returns Revalidated planning result and its opaque provenance writer.
   */
  prepareCommittedPlanningEvidence(
    input: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPreparedCommittedPlanningEvidence>

  /**
   * Validates one artifact epoch and deadline against measured contracts.
   *
   * This preflight performs no AWS I/O and uses the same configuration, clock,
   * and request timeout as immutable storage and sealed-root publication.
   *
   * @param input - Reviewed epoch, fixed deadline, and pre-write runway.
   * @returns Exact accepted canonical retention deadline.
   */
  validatePlanningArtifactPreflight(
    input:
      ValidateWorkspaceSearchMigrationPlanningArtifactPreflightInput,
  ): string

  /**
   * Creates one run-scoped immutable planning storage gateway.
   *
   * The gateway remains bound to the current measured generation and becomes
   * unusable after close or any replacement measurement.
   *
   * @param runId - Operator-selected run owning every stored object.
   * @returns Planning graph storage over the pinned measured S3 client.
   */
  createPlanningArtifactGateway(
    runId: string,
  ): WorkspaceSearchMigrationPlanningArtifactAwsGateway

  /**
   * Creates one generation-bound atomic sealed-authority publication port.
   *
   * @returns Publication port bound to the latest measured configuration.
   */
  createSealedPlanningAuthorityPort():
    WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort

  /**
   * Creates one generation-bound writer-fence lifecycle port.
   *
   * Closing is deliberately absent so managed callers cannot bypass the
   * atomic execution-boundary record. Release is terminal-root-bound.
   *
   * @returns Bootstrap, read, and release port bound to the measurement.
   */
  createApplicationWriterFencePort():
    WorkspaceSearchMigrationManagedApplicationWriterFencePort

  /**
   * Creates one generation-bound atomic execution-boundary operator port.
   *
   * @returns Close/admission port bound to the latest measured configuration.
   */
  createExecutionBoundaryPort():
    WorkspaceSearchMigrationExecutionBoundaryAwsPort

  /**
   * Creates one generation-bound atomic execution-run admission port.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param planSeal - Exact canonical plan seal referenced by the root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @returns Create/read port bound to the latest measured configuration.
   */
  createExecutionRunPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    planSeal: WorkspaceSearchPlanSeal,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
  ): WorkspaceSearchMigrationExecutionRunAwsPort

  /**
   * Creates one generation-bound atomic apply progress port.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Apply operation/checkpoint port bound to the latest measurement.
   */
  createApplyOperationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationApplyOperationAwsPort

  /**
   * Creates one generation-bound resumable full-verification port.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Verification progress/publication port bound to the measurement.
   */
  createFullVerificationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationFullVerificationAwsPort

  /**
   * Creates one generation-bound committed-prefix rollback port.
   *
   * The partial-start seal, lifecycle rows, reverse receipts, target writes,
   * and terminal root share the same pinned DynamoDB/S3 clients, all-six table
   * guards, and post-send quarantine.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Partial-start, reverse, and finish operations bound to one measurement.
   */
  createPartialRollbackOperationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationManagedPartialRollbackAwsPort

  /**
   * Creates one generation-bound complete-root reverse rollback port.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Rollback progress/restoration port bound to the measurement.
   */
  createRollbackOperationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationRollbackOperationAwsPort
}

/**
 * Complete production session whose DescribeTable access is durably budgeted.
 */
export interface WorkspaceSearchMigrationRateManagedAwsSession
  extends WorkspaceSearchMigrationManagedAwsSession {
  /**
   * Stops admission and waits for already-started mandatory cleanup to drain.
   *
   * @returns Completion after every owned AWS transport is closed.
   */
  close(): Promise<void>

  /**
   * Creates a fresh identity port sharing this session's rate lifecycle.
   *
   * The child owns independent AWS identity clients but cannot claim or close
   * the shared rate fence. Its fresh all-six measurement is serialized with
   * the parent session's checkpoint pages.
   *
   * @returns Fresh independently closeable measurement port.
   */
  createRateManagedMeasurementSession():
    Promise<WorkspaceSearchMigrationManagedIdentityPort>

  /** Stops admission of every new AWS data mutation for this invocation. */
  interruptMutationAdmission(): void

  /** Stops every new rate-managed call for this invocation. */
  interruptDescribeTableRate(): void

  /** Returns only the secret-free durable rate aggregate. */
  readDescribeTableRateEvidence():
    WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Raw target-audit pair authenticated only after a rollback terminal reread. */
export type WorkspaceSearchMigrationRehearsalReconciliationRollbackTargetInput = {
  /** Canonical authenticated target observation captured before apply. */
  readonly preimageAuditBytes: Uint8Array
  /** Canonical authenticated target observation captured after this rollback. */
  readonly restoredAuditBytes: Uint8Array
  /** Parent-authenticated scenario, manifest, planning, and fence context. */
  readonly context: WorkspaceSearchMigrationRehearsalTargetAuditContext
  /** Canonical trusted start time of the admitted apply operation. */
  readonly applyStartedAt: string
  /** Owned 32-byte runtime HMAC key consumed and overwritten here. */
  readonly runtimeVerificationKey: Uint8Array
  /** Owned 32-byte publication HMAC key consumed and overwritten here. */
  readonly publicationVerificationKey: Uint8Array
}

/** Complete high-level input for one measured terminal reconciliation audit. */
export type CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput = {
  /** Exact restricted migration run reconstructed through durable roots. */
  readonly runId: string
  /** Stage-HMAC-derived locator for the same restricted run identifier. */
  readonly runLocatorDigest: string
  /** Canonical isolated rehearsal scenario selecting terminal semantics. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /**
   * Adapter-proven complete authority-adoption chain from authenticated stage
   * execution evidence. Bare operator-authored entries are not permitted.
   */
  readonly expectedAuthorities:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
  /** Mandatory target preimage/restored files for either rollback scenario. */
  readonly rollbackTarget?:
    WorkspaceSearchMigrationRehearsalReconciliationRollbackTargetInput
  /** Reviewed finite Query, row, byte, request, and total-duration budgets. */
  readonly limits: WorkspaceSearchMigrationRehearsalReconciliationAwsLimits
  /** Trusted monotonic wall clock shared by authentication and collection. */
  readonly clock: () => Date
  /** Optional caller cancellation propagated to every reconciliation request. */
  readonly signal?: AbortSignal
}

/** Module-private construction authority for collected reconciliation bases. */
const collectedReconciliationBaseToken = Symbol(
  'workspace-search-migration-rehearsal-collected-reconciliation-base',
)

/** Opaque one-shot terminal collection awaiting post-seal #163 completion. */
export class WorkspaceSearchMigrationRehearsalCollectedReconciliationBase {
  /**
   * Constructs only capabilities minted by the measured session.
   *
   * @param token - Module-private construction authority.
   */
  constructor(token: symbol) {
    if (token !== collectedReconciliationBaseToken) {
      return failManagedReconciliationSession()
    }
    Object.freeze(this)
  }
}

/** Input completing one measured base after rate sealing and live finalization. */
export type CompleteWorkspaceSearchMigrationRehearsalReconciliationInput = {
  /** Genuine one-shot base returned by the exact measured session. */
  readonly collectedBase:
    WorkspaceSearchMigrationRehearsalCollectedReconciliationBase
  /** Genuine live result for verified scenarios, otherwise strict null. */
  readonly verifiedIntegrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult | null
}

/**
 * Dedicated non-production session with immutable rehearsal evidence output.
 */
export interface WorkspaceSearchMigrationNonProductionRehearsalAwsSession
  extends WorkspaceSearchMigrationRateManagedAwsSession {
  /**
   * Stops operational admission and returns the final drained rate aggregate.
   *
   * Publication-only S3 capabilities remain available until `close()`. The
   * exact result or failure is retained across repeated seal and close calls.
   *
   * @returns Final secret-free aggregate after every admitted owner settles.
   */
  sealAndReadDescribeTableRateEvidence():
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence>

  /**
   * Reconstructs and independently reconciles one authoritative terminal run.
   *
   * Boundary, closed fence, sealed authority, plan, execution admission,
   * apply boundary, terminal root, and expected markers are all strongly read
   * or replayed inside this capability. The caller cannot supply terminal
   * counts or digests, and no generic Query primitive is exposed.
   *
   * @param input - Restricted run, authenticated evidence files, and budgets.
   * @returns Opaque one-shot base awaiting post-seal #163 completion.
   */
  collectRehearsalReconciliation(
    input:
      CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
  ): Promise<WorkspaceSearchMigrationRehearsalCollectedReconciliationBase>

  /**
   * Reads the immutable secret-free head claimed during session construction.
   *
   * Publication-only rehearsal sessions may omit a stage claim and therefore
   * return undefined. Production sessions do not expose this capability.
   *
   * @returns Detached frozen claimed head, or undefined when claim was omitted.
   */
  readRehearsalClaimedStageHead():
    WorkspaceSearchMigrationRehearsalStageHead | undefined

  /**
   * Takes the oldest unread adapter-proven durable lease projection.
   *
   * Each observation is returned at most once. Production sessions do not
   * expose this method and reflective calls on them fail closed.
   *
   * @returns Frozen acquisition/reuse projection, or undefined when none waits.
   */
  takeRehearsalLeaseAcquisitionObservation():
    WorkspaceSearchMigrationDurableLeaseAcquisitionObservation | undefined

  /**
   * Takes the oldest unread adapter-proven authority-adoption projection.
   *
   * Successful transaction and response-loss reconciliation paths both pass
   * through the writer-owned strict receipt codec. Each exact receipt can be
   * returned only once and production sessions do not expose this capability.
   *
   * @returns Frozen renewal position and receipt digest, or undefined.
   */
  takeRehearsalAuthorityAdoptionObservation():
    WorkspaceSearchMigrationRehearsalExpectedAuthority | undefined

  /**
   * Takes the oldest unread adapter-proven runtime fault observation.
   *
   * The observation contains only cursor-free digests and scalar durable
   * state. Each selected fault can be read exactly once.
   *
   * @returns Frozen runtime observation, or undefined when none waits.
   */
  takeRehearsalFaultObservation():
    WorkspaceSearchMigrationRehearsalFaultObservation | undefined

  /**
   * Creates a child-artifact publisher borrowing this measured session.
   *
   * @param input - Trusted clock and finite per-request deadline only.
   * @returns Publisher with no caller-selected AWS resource identity.
   */
  createRehearsalArtifactPublisher(
    input: Pick<
      CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput,
      'clock' | 'requestTimeoutMilliseconds'
    >,
  ): WorkspaceSearchMigrationRehearsalArtifactAwsPublisher

  /**
   * Reads digest-only facts derived from the authenticated measured session.
   *
   * @returns Frozen binding required by evidence finalization/publication.
   */
  readRehearsalEvidenceSessionBinding():
    CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput[
      'sessionBinding'
    ]

  /**
   * Reads the authenticated permit interval for final suite containment.
   *
   * @returns Exact canonical inclusive issue and exclusive expiry timestamps.
   */
  readRehearsalPermitValidity():
    WorkspaceSearchMigrationRehearsalPermitValidity

  /**
   * Creates a publisher borrowing this measured session's exact journal client.
   *
   * @param input - Trusted clock and finite per-request deadline only.
   * @returns Closeable publisher with no caller-selected AWS resource identity.
   */
  createRehearsalEvidencePublisher(
    input: Pick<
      CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput,
      'clock' | 'requestTimeoutMilliseconds'
    >,
  ): WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher
}

/**
 * Capability-minimized AWS session dedicated to final rehearsal publication.
 *
 * It deliberately omits generic reads, mutations, stage state, reconciliation,
 * child-session creation, and raw transports. The sole rate exercise is bound
 * to the session's construction-fixed migration-state table.
 */
export interface WorkspaceSearchMigrationRehearsalFinalPublicationAwsSession {
  /**
   * Measures the exact construction-fixed migration resources.
   *
   * @returns Exact measured migration configuration.
   */
  measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration>

  /**
   * Runs the one-shot real post-success DescribeTable throttle exercise.
   *
   * @returns Exact source-specific one-attempt, one-throttle, one-stop receipt.
   */
  exerciseDescribeTableThrottle():
    Promise<WorkspaceSearchMigrationRehearsalDescribeTableRateExerciseReceipt>

  /**
   * Creates the journal-bound immutable child-artifact publisher.
   *
   * @param input - Trusted clock and finite per-request deadline only.
   * @returns Publisher with no caller-selected AWS resource identity.
   */
  createRehearsalArtifactPublisher(
    input: Pick<
      CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput,
      'clock' | 'requestTimeoutMilliseconds'
    >,
  ): WorkspaceSearchMigrationRehearsalArtifactAwsPublisher

  /**
   * Creates the journal-bound immutable evidence-index publisher.
   *
   * @param input - Trusted clock and finite per-request deadline only.
   * @returns Publisher with no caller-selected AWS resource identity.
   */
  createRehearsalEvidencePublisher(
    input: Pick<
      CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput,
      'clock' | 'requestTimeoutMilliseconds'
    >,
  ): WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher

  /**
   * Reads digest-only facts derived from the authenticated measured session.
   *
   * @returns Frozen binding required by final evidence publication.
   */
  readRehearsalEvidenceSessionBinding():
    CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput[
      'sessionBinding'
    ]

  /**
   * Reads the current source-separated secret-free rate aggregate.
   *
   * @returns Current aggregate owned by the shared durable rate lifecycle.
   */
  readDescribeTableRateEvidence():
    WorkspaceSearchMigrationDescribeTableRateEvidence

  /**
   * Reads the authenticated interval containing the complete rehearsal.
   *
   * @returns Exact canonical inclusive issue and exclusive expiry timestamps.
   */
  readRehearsalPermitValidity():
    WorkspaceSearchMigrationRehearsalPermitValidity

  /** Stops every not-yet-started rate-managed operation. */
  interruptDescribeTableRate(): void

  /** Stops admission and closes the standard and exercise AWS transports. */
  close(): Promise<void>
}

/** Caller-controlled limits for one permit-backed actual #163 live check. */
export type RunAwsWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput = {
  /** Invocation-owned Workspace Audit pseudonym key consumed on every path. */
  readonly auditPseudonymKey: Uint8Array
  /** Fixed DynamoDB Scan item limit. */
  readonly pageSize: number
  /** Total DynamoDB Scan page bound. */
  readonly maxPages: number
  /** Total normalized checker item bound. */
  readonly maxItems: number
  /** Complete non-resettable live-check duration bound in milliseconds. */
  readonly maximumDurationMilliseconds: number
  /** Optional caller cancellation combined with session cancellation. */
  readonly signal?: AbortSignal
}

/** Module-private construction authority for dedicated outer pending handles. */
const rehearsalIntegrityAwsPendingToken = Symbol(
  'workspace-search-migration-rehearsal-integrity-aws-pending',
)

/** Opaque session-owned handle that never exposes the generic live pending. */
export class WorkspaceSearchMigrationRehearsalIntegrityAwsPending {
  /**
   * Constructs only handles minted by the dedicated permit-backed session.
   *
   * @param token - Module-private construction authority.
   */
  constructor(token: symbol) {
    if (token !== rehearsalIntegrityAwsPendingToken) {
      throw new TypeError('Invalid rehearsal integrity AWS pending handle.')
    }
    Object.freeze(this)
  }
}

/** Exact raw rate material accepted by the dedicated outer finalizer. */
export type FinalizeAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput = {
  /** Genuine pending handle returned by this exact dedicated session. */
  readonly pending: WorkspaceSearchMigrationRehearsalIntegrityAwsPending
  /** Canonical raw segment bytes containing the exact live run. */
  readonly canonicalSegmentBytes: Uint8Array
  /** Canonical raw bytes of the immediate authenticated predecessor. */
  readonly predecessorSegmentBytes: Uint8Array
  /** Caller-owned runtime rate authentication key consumed on every path. */
  readonly rateAuthenticationKey: Uint8Array
}

/** Dedicated permit-backed non-production session for one actual #163 check. */
export interface WorkspaceSearchMigrationRehearsalIntegrityAwsSession {
  /** Stops admission and waits for the owned rate and AWS clients to close. */
  close(): Promise<void>

  /**
   * Measures the exact permit-authorized six-table migration configuration.
   *
   * @returns Exact measured migration configuration.
   */
  measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration>

  /**
   * Reads and reduces one target page through this measured claimed session.
   *
   * @param input - Measured target context and predecessor checkpoint.
   * @param signal - Optional reconciliation deadline or cancellation.
   * @returns Bound cumulative checkpoint and detached row evidence.
   */
  scanTargetPage(
    input: WorkspaceSearchMigrationTargetScanReadInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchMigrationTargetScanPageResult>

  /**
   * Returns the digest of the exact permit-authorized resource selection.
   *
   * @returns Lowercase requested-resource binding digest.
   */
  readRequestedResourcesBinding(): string

  /**
   * Returns the digest-only binding derived from this measured session.
   *
   * @returns Permit, resource, policy, and measured-configuration binding.
   */
  readRehearsalEvidenceSessionBinding():
    CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput[
      'sessionBinding'
    ]

  /**
   * Returns the immutable stage head claimed during construction.
   *
   * @returns Detached claimed stage head.
   */
  readRehearsalClaimedStageHead():
    WorkspaceSearchMigrationRehearsalStageHead | undefined

  /**
   * Reconstructs one authoritative terminal run using the claimed session.
   *
   * @param input - Restricted authenticated evidence and finite read budgets.
   * @returns Opaque one-shot base awaiting post-seal #163 completion.
   */
  collectRehearsalReconciliation(
    input:
      CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
  ): Promise<WorkspaceSearchMigrationRehearsalCollectedReconciliationBase>

  /** Stops every new rate-managed DescribeTable operation. */
  interruptDescribeTableRate(): void

  /** Stops live admission and returns the final drained rate aggregate. */
  sealAndReadDescribeTableRateEvidence():
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence>

  /** Reads only the current secret-free durable rate aggregate. */
  readDescribeTableRateEvidence():
    WorkspaceSearchMigrationDescribeTableRateEvidence

  /**
   * Runs the real source integrity checker exactly once behind the permit gate.
   *
   * Account, Region, profile, physical resources, caller identity, immutable
   * resource digest, managed rate owner, clocks, and AWS transport are all
   * retained privately by the session and cannot be selected by this call.
   *
   * @param input - Audit key, finite read limits, and optional cancellation.
   * @returns Opaque pending result for later authenticated segment sealing.
   */
  runRehearsalIntegrityLiveSession(
    input: RunAwsWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
  ): Promise<WorkspaceSearchMigrationRehearsalIntegrityAwsPending>

  /**
   * Finalizes one session-owned pending handle against its raw rate segment.
   *
   * Policy/configuration bindings are derived from the authenticated permit.
   * The runtime rate key must differ from the retained dedicated integrity key.
   *
   * @param input - Genuine handle, linked raw segments, and runtime rate key.
   * @returns Authenticated rate-bound integrity result.
   */
  finalizeRehearsalIntegrityLiveSession(
    input:
      FinalizeAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
  ): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult

  /** Burns one unfinalized session-owned pending handle and its retained key. */
  disposeRehearsalIntegrityLiveSession(
    pending: WorkspaceSearchMigrationRehearsalIntegrityAwsPending,
  ): void
}

/** Authenticated time interval that must contain the complete rehearsal. */
export type WorkspaceSearchMigrationRehearsalPermitValidity = {
  /** Canonical inclusive permit issuance boundary. */
  readonly issuedAt: string
  /** Canonical exclusive permit expiry boundary. */
  readonly expiresAt: string
}

/** Input for the production durably rate-managed AWS composition root. */
export type CreateAwsWorkspaceSearchMigrationRateManagedSessionInput = {
  /** Complete explicit operator-selected resources. */
  readonly requested: WorkspaceSearchMigrationRequestedResources
  /** Exact reviewed and digest-bound DescribeTable policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Explicit authority to create the first absent rate checkpoint. */
  readonly bootstrapRateCheckpoint: boolean
  /** Explicit authority to recover a retained cleanup marker. */
  readonly recoverInterruptedCleanup: boolean
  /** Explicit authority to recover one uncertain physical attempt. */
  readonly recoverInterruptedAttempt: boolean
  /** Optional best-effort secret-free observation sink. */
  readonly rateRecorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
  /** Optional best-effort migration telemetry observer. */
  readonly telemetryRecorder?: WorkspaceSearchMigrationTelemetryRecorder
  /** Optional trusted clock captured by pre-plan authority commits. */
  readonly prePlanAuthorityClock?:
    WorkspaceSearchMigrationPrePlanAuthorityClock
  /** Optional cancellation stopping not-yet-started checkpoint mutation. */
  readonly signal?: AbortSignal
}

/** Input for the dedicated owner-only pre-permit non-production root. */
export type CreateAwsWorkspaceSearchMigrationRehearsalPrePermitRootSessionInput = {
  /** Strict source-controlled root-plan document validated before clients. */
  readonly rootPlan: unknown
  /** Exact reviewed DescribeTable policy bound by later root evidence. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Optional best-effort secret-free rate observation sink. */
  readonly rateRecorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
  /** Optional caller cancellation combined with the non-resettable root bound. */
  readonly signal?: AbortSignal
  /** Optional trusted process-monotonic clock used by the complete root. */
  readonly monotonicClock?: () => number
  /** Optional trusted wall clock used for root chronology. */
  readonly wallClock?: () => Date
}

/** Input for the isolated non-production runtime-fault rehearsal session. */
export type CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput =
  CreateAwsWorkspaceSearchMigrationRateManagedSessionInput & {
    /** Authenticated short-lived permit retained only in restricted operator state. */
    readonly permit: unknown
    /** Dedicated 32-byte key authenticating the reviewed permit. */
    readonly permitVerificationKey: Uint8Array
    /** Optional trusted clock used to validate permit expiry around STS. */
    readonly permitClock?: () => Date
    /** Optional finite one-shot fault configured only for this rehearsal. */
    readonly fault?:
      CreateWorkspaceSearchMigrationRehearsalFaultControllerInput
    /** Optional authenticated one-shot durable stage reservation claim. */
    readonly stageReservationClaim?:
      PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaimInput
  }

/** Input for one permit-backed session owning the actual #163 live gate. */
export type CreateAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput =
  {
    /** Complete explicit permit-authorized non-production resources. */
    readonly requested: WorkspaceSearchMigrationRequestedResources
    /** Exact reviewed and permit-bound DescribeTable policy. */
    readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
    /** Optional best-effort secret-free rate observation sink. */
    readonly rateRecorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
    /** Authenticated short-lived non-production permit. */
    readonly permit: unknown
    /** Dedicated 32-byte runtime key authenticating the reviewed permit. */
    readonly permitVerificationKey: Uint8Array
    /** Optional trusted clock used around permit-bound external reads. */
    readonly permitClock?: () => Date
    /** Required authenticated one-shot durable auxiliary-stage claim. */
    readonly stageReservationClaim:
      PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaimInput
    /** Canonical owner-only immutable resource-attestation bytes, consumed. */
    readonly resourceAttestationBytes: Uint8Array
    /** Dedicated 32-byte immutable-resource and result HMAC key, consumed. */
    readonly integrityDigestKey: Uint8Array
    /** Optional cancellation stopping construction and later live admission. */
    readonly signal?: AbortSignal
  }

/** Input for one standalone authenticated non-production stage commit. */
export type CommitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput = {
  /** Complete explicit operator-selected non-production resources. */
  readonly requested: WorkspaceSearchMigrationRequestedResources
  /** Exact reviewed policy whose version is bound by the stage material. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Authenticated short-lived non-production permit. */
  readonly permit: unknown
  /** Dedicated 32-byte key authenticating the reviewed permit. */
  readonly permitVerificationKey: Uint8Array
  /** Required trusted clock sampled around remote preflight and commit. */
  readonly permitClock: () => Date
  /** Authenticated commit material plus cleanup and command-specific caps. */
  readonly stageReservationCommit:
    PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsCommitInput
}

/** Input for one standalone authenticated non-production stage claim. */
export type ClaimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput = {
  /** Complete explicit operator-selected non-production resources. */
  readonly requested: WorkspaceSearchMigrationRequestedResources
  /** Exact reviewed policy whose version is bound by the stage material. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Authenticated short-lived non-production permit. */
  readonly permit: unknown
  /** Runtime-only 32-byte key authenticating the permit and reservation. */
  readonly permitVerificationKey: Uint8Array
  /** Required trusted clock sampled around remote preflight and claim. */
  readonly permitClock: () => Date
  /** Authenticated one-shot reservation, selection, and runtime key. */
  readonly stageReservationClaim:
    PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaimInput
}

/** Shared authenticated inputs for a standalone non-production stage-head read. */
type AwsWorkspaceSearchMigrationNonProductionRehearsalStageHeadInput = {
  /** Complete explicit operator-selected non-production resources. */
  readonly requested: WorkspaceSearchMigrationRequestedResources
  /** Exact reviewed policy bound by the authenticated stage manifest. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Authenticated short-lived non-production permit. */
  readonly permit: unknown
  /** Dedicated 32-byte key authenticating the reviewed permit. */
  readonly permitVerificationKey: Uint8Array
  /** Required trusted clock sampled around every remote preflight read. */
  readonly permitClock: () => Date
  /** Complete authenticated reviewed stage manifest. */
  readonly manifest: unknown
  /** Child-visible 32-byte key authenticating the stage manifest. */
  readonly manifestVerificationKey: Uint8Array
}

/** Input for one standalone strongly consistent non-production stage-head read. */
export type ReadAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationHeadInput =
  AwsWorkspaceSearchMigrationNonProductionRehearsalStageHeadInput

/** Exact authenticated material for one explicit expired-reservation removal. */
export type AwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationAbandonmentInput = {
  /** Independently authenticated exact manifest selection. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Exact runtime-authenticated active reservation token. */
  readonly reservation: unknown
  /** Parent-signed immutable abandonment transition. */
  readonly abandonment: unknown
  /** Genuine same-process proof of durable cleanup for the exact runtime key. */
  readonly runtimeKeyCleanupAuthorization: unknown
  /** Child-visible 32-byte reservation and selection verification key. */
  readonly runtimeVerificationKey: Uint8Array
  /** Parent-only 32-byte abandonment verification key. */
  readonly publicationVerificationKey: Uint8Array
  /** Canonical trusted invocation time not before abandonment authorization. */
  readonly observedAt: string
}

/** Input for one standalone parent-authorized reservation abandonment. */
export type AbandonAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput =
  AwsWorkspaceSearchMigrationNonProductionRehearsalStageHeadInput & {
    /** Exact selection, reservation, authorization, split keys, and time. */
    readonly stageReservationAbandonment:
      AwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationAbandonmentInput
  }

/** Input for one full-suite immutable stage-commit durability recovery. */
export type RecoverAwsWorkspaceSearchMigrationNonProductionRehearsalStageCommitDurabilityAuthorizationsInput =
  AwsWorkspaceSearchMigrationNonProductionRehearsalStageHeadInput & {
    /** Dense exact 36 authenticated stage receipts in global ordinal order. */
    readonly receipts: readonly unknown[]
    /** Exact signed reservation/abandonment pairs in cumulative order. */
    readonly reservationAbandonments: readonly unknown[]
    /** Child-visible 32-byte receipt and manifest verification key. */
    readonly runtimeVerificationKey: Uint8Array
    /** Parent-only 32-byte commit-evidence verification key. */
    readonly publicationVerificationKey: Uint8Array
  }

/** Quarantine-only observer captured before production composition awaits. */
type WorkspaceSearchMigrationQuarantineTelemetryRecorder = {
  /** Records one already bounded migration quarantine observation. */
  readonly record: WorkspaceSearchMigrationTelemetryRecorder['record']
}

/** Detached production composition input captured before the STS await. */
type RateManagedAwsSessionConstructionSnapshot = {
  /** Validated immutable requested resource snapshot. */
  readonly resources: WorkspaceSearchMigrationRequestedResourcesSnapshot
  /** Detached reviewed DescribeTable rate policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Explicit initial checkpoint bootstrap authority. */
  readonly bootstrapRateCheckpoint: boolean
  /** Explicit interrupted-cleanup recovery authority. */
  readonly recoverInterruptedCleanup: boolean
  /** Explicit uncertain-attempt recovery authority. */
  readonly recoverInterruptedAttempt: boolean
  /** Optional captured secret-free observation sink. */
  readonly rateRecorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
  /** Optional captured quarantine-only migration observer. */
  readonly telemetryRecorder?:
    WorkspaceSearchMigrationQuarantineTelemetryRecorder
  /** Captured trusted pre-plan clock. */
  readonly prePlanAuthorityClock:
    WorkspaceSearchMigrationPrePlanAuthorityClock
  /** Optional captured composition cancellation. */
  readonly signal?: AbortSignal
}

/** Module-owned sink receiving the isolated final-publication exercise. */
type RegisterFinalPublicationDescribeTableRateExercise = (
  exercise: WorkspaceSearchMigrationRehearsalDescribeTableRateExercise,
) => void

/** Synchronously detached construction for the dedicated pre-permit root. */
type RehearsalPrePermitRootConstructionSnapshot = {
  /** Strict plan re-resolved from the repository-owned target map. */
  readonly plan: WorkspaceSearchMigrationRehearsalRootPlan
  /** Detached reviewed DescribeTable rate policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Optional captured secret-free rate observation sink. */
  readonly rateRecorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
  /** Optional caller cancellation combined with the root deadline. */
  readonly signal?: AbortSignal
  /** Trusted process-monotonic root clock. */
  readonly monotonicClock: () => number
  /** Trusted canonical root wall clock. */
  readonly wallClock: () => Date
}

/** Fixed rate construction authority derived from one strict root plan. */
type RehearsalPrePermitRootRateConstruction = {
  /** Exact six migration tables allowed only for interrupted cleanup logic. */
  readonly recoveryTableNames: readonly string[]
  /** Exact canonical ten-name migration/integrity union. */
  readonly allowedTableNames: readonly string[]
  /** Root-only authority to create the first absent checkpoint. */
  readonly bootstrap: true
  /** Mandatory refusal to recover a retained cleanup marker. */
  readonly recoverInterruptedCleanup: false
  /** Mandatory refusal to recover one uncertain physical attempt. */
  readonly recoverInterruptedAttempt: false
}

/** Exact physical names shared by pre-permit and permit-backed integrity roots. */
type RehearsalIntegrityTableSelection = {
  /** Exact six migration tables admitted to interrupted cleanup only. */
  readonly recoveryTableNames: readonly string[]
  /** Exact canonical migration-six plus integrity-four union. */
  readonly allowedTableNames: readonly string[]
}

/** Synchronously authenticated owner-only state for one actual #163 session. */
type NonProductionRehearsalIntegrityConstruction = {
  /** Privately retained canonical owner-only attestation bytes. */
  readonly resourceAttestationBytes: Uint8Array
  /** Privately retained dedicated immutable-resource and result key. */
  readonly integrityDigestKey: Uint8Array
  /** Exact six integrity tables derived only from the private attestation. */
  readonly tables: CrossDomainIntegrityTableNames
  /** Exact File bucket derived only from the private attestation. */
  readonly buckets: CrossDomainIntegrityBucketNames
  /** Permit-matched keyed digest of the canonical seven-resource vector. */
  readonly expectedResourceIdentityDigest: string
  /** Exact six-table cleanup and exact ten-table operational authority. */
  readonly rateTables: RehearsalIntegrityTableSelection
}

/** Complete synchronous result before any integrity-session AWS client exists. */
type NonProductionRehearsalIntegritySessionConstructionSnapshot = {
  /** Detached generic rate-managed construction. */
  readonly session: RateManagedAwsSessionConstructionSnapshot
  /** Authenticated permit and optional one-shot stage claim. */
  readonly preflight: NonProductionRehearsalConstructionPreflight
  /** Permit-matched owner-only integrity construction. */
  readonly integrity: NonProductionRehearsalIntegrityConstruction
}

/** Detached caller-controlled state for one dedicated actual #163 invocation. */
type RehearsalIntegrityLiveInvocationSnapshot = {
  /** Invocation-owned detached audit pseudonym key. */
  readonly auditPseudonymKey: Uint8Array
  /** Fixed DynamoDB Scan item limit. */
  readonly pageSize: number
  /** Total Scan page bound. */
  readonly maxPages: number
  /** Total normalized item bound. */
  readonly maxItems: number
  /** Complete non-resettable duration bound. */
  readonly maximumDurationMilliseconds: number
  /** Optional validated caller cancellation. */
  readonly signal?: AbortSignal
}

/** Private generic pending and key retained behind one outer session handle. */
type RehearsalIntegrityAwsPendingState = {
  /** Genuine generic pending that never crosses the dedicated outer gate. */
  readonly pending: WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending
  /** Dedicated integrity key copy used only for runtime-key separation. */
  readonly integrityDigestKey: Uint8Array
  /** Combined signal whose later abort burns this unfinalized handle. */
  readonly signal: AbortSignal
  /** Exact listener removed on explicit finalization or disposal. */
  readonly abortListener: () => void
}

/** Validated non-production guard retained only through composition preflight. */
type NonProductionRehearsalConstructionGuard = {
  /** Authenticated exact account, role, Region, commit, and resource claims. */
  readonly permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>
  /** Digest of the complete authenticated permit including its MAC. */
  readonly permitDigest: string
  /** Trusted clock rechecked after remote identity and tag reads. */
  readonly clock: () => Date
  /** Optional one-shot semantic fault controller retained by the session. */
  readonly faultController?:
    WorkspaceSearchMigrationRehearsalFaultController
}

/** Shared untrusted fields accepted by non-production identity preflight. */
type NonProductionRehearsalGuardConstructionInput = {
  /** Candidate authenticated permit. */
  readonly permit: unknown
  /** Candidate exact-length permit verification key. */
  readonly permitVerificationKey: Uint8Array
  /** Optional trusted permit clock. */
  readonly permitClock?: () => Date
  /** Optional rehearsal-only semantic fault construction. */
  readonly fault?:
    CreateWorkspaceSearchMigrationRehearsalFaultControllerInput
}

/** Preauthenticated rehearsal construction retained only through preflight. */
type NonProductionRehearsalConstructionPreflight = {
  /** Authenticated permit, clock, and optional semantic fault controller. */
  readonly guard: NonProductionRehearsalConstructionGuard
  /** Optional one-shot stage claim with a privately retained key copy. */
  readonly stageReservationClaim?:
    PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsClaim
}

/** Synchronously detached standalone commit construction. */
type NonProductionRehearsalStageCommitConstruction = {
  /** Validated immutable requested resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResourcesSnapshot
  /** Validated immutable reviewed rate policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Authenticated permit and captured trusted clock. */
  readonly guard: NonProductionRehearsalConstructionGuard
  /** One-shot preauthenticated stage commit. */
  readonly stageCommit:
    PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsCommit
}

/** Synchronously detached standalone stage-claim construction. */
type NonProductionRehearsalStageClaimConstruction = {
  /** Validated immutable requested resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResourcesSnapshot
  /** Validated immutable reviewed rate policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Authenticated permit and captured trusted clock. */
  readonly guard: NonProductionRehearsalConstructionGuard
  /** One-shot preauthenticated stage claim. */
  readonly stageClaim:
    PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsClaim
}

/** Synchronously authenticated standalone stage-head read construction. */
type NonProductionRehearsalStageHeadConstruction = {
  /** Validated immutable requested resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResourcesSnapshot
  /** Validated immutable reviewed rate policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Authenticated permit and captured trusted clock. */
  readonly guard: NonProductionRehearsalConstructionGuard
  /** Detached authenticated reviewed stage manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Invocation-owned stage-manifest verification key. */
  readonly manifestVerificationKey: Uint8Array
}

/** Synchronously authenticated standalone abandonment construction. */
type NonProductionRehearsalStageAbandonmentConstruction =
  NonProductionRehearsalStageHeadConstruction & {
    /** Detached authenticated manifest selection. */
    readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
    /** Detached runtime-authenticated active reservation. */
    readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
    /** Detached parent-authenticated abandonment transition. */
    readonly abandonment:
      WorkspaceSearchMigrationRehearsalStageReservationAbandonment
    /** Genuine cleanup capability retained until the store CAS boundary. */
    readonly runtimeKeyCleanupAuthorization: unknown
    /** Invocation-owned runtime verification key. */
    readonly runtimeVerificationKey: Uint8Array
    /** Invocation-owned parent publication verification key. */
    readonly publicationVerificationKey: Uint8Array
    /** Canonical trusted time admitted by the parent operation. */
    readonly observedAt: string
  }

/** Synchronously authenticated full-suite durability recovery construction. */
type NonProductionRehearsalStageCommitRecoveryConstruction =
  NonProductionRehearsalStageHeadConstruction & {
    /** Dense exact 36 caller-owned receipt references. */
    readonly receipts: readonly unknown[]
    /** Safely detached exact reservation/abandonment pair records. */
    readonly reservationAbandonments: readonly unknown[]
    /** Invocation-owned runtime verification key. */
    readonly runtimeVerificationKey: Uint8Array
    /** Invocation-owned parent publication verification key. */
    readonly publicationVerificationKey: Uint8Array
  }

/** Additional S3 read available only during rehearsal environment preflight. */
type WorkspaceSearchMigrationRehearsalGuardAwsTransport = {
  /**
   * Reads the selected journal bucket's deployment-environment tags.
   *
   * @param command - Exact owner-bound bucket tag request.
   * @returns Raw S3 bucket tag response used only by the guard.
   */
  getBucketTagging(
    command: GetBucketTaggingCommand,
  ): Promise<GetBucketTaggingOutput>
}

/** Narrow standalone transport with no DescribeTable or rate capability. */
type WorkspaceSearchMigrationRehearsalStageCommitAwsTransport =
  WorkspaceSearchMigrationRehearsalGuardAwsTransport &
    WorkspaceSearchMigrationRehearsalStageReservationAwsTransport & {
      /** Releases all AWS clients owned by the standalone operation. */
      readonly close: () => void
      /** Reads the exact AWS signing identity before any state access. */
      readonly getCallerIdentity: (
        command: GetCallerIdentityCommand,
      ) => Promise<GetCallerIdentityCommandOutput>
    }

/** Narrow transport containing only managed identity reads. */
export interface WorkspaceSearchMigrationIdentityAwsTransport {
  /**
   * Releases all underlying AWS SDK clients.
   */
  close(): void
  /**
   * Sends one DynamoDB point-in-time recovery read.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB recovery-state response.
   */
  describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput>
  /**
   * Sends one KMS key metadata read.
   *
   * @param command - Exact read-only command.
   * @returns KMS key metadata response.
   */
  describeKey(command: DescribeKeyCommand): Promise<DescribeKeyCommandOutput>
  /**
   * Sends one DynamoDB table metadata read.
   *
   * @param command - Exact read-only command.
   * @param signal - Optional managed-operation cancellation signal.
   * @returns DynamoDB table metadata response.
   */
  describeTable(
    command: DescribeTableCommand,
    signal?: AbortSignal,
  ): Promise<DescribeTableCommandOutput>
  /**
   * Sends one DynamoDB TTL metadata read.
   *
   * @param command - Exact read-only command.
   * @returns DynamoDB TTL response.
   */
  describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput>
  /**
   * Sends one S3 bucket-encryption read.
   *
   * @param command - Exact owner-bound read-only command.
   * @returns S3 encryption response.
   */
  getBucketEncryption(
    command: GetBucketEncryptionCommand,
  ): Promise<GetBucketEncryptionOutput>
  /**
   * Sends one S3 server-access-logging read.
   *
   * @param command - Exact owner-bound read-only command.
   * @returns S3 logging response.
   */
  getBucketLogging(
    command: GetBucketLoggingCommand,
  ): Promise<GetBucketLoggingOutput>
  /**
   * Sends one S3 bucket-versioning read.
   *
   * @param command - Exact owner-bound read-only command.
   * @returns S3 versioning response.
   */
  getBucketVersioning(
    command: GetBucketVersioningCommand,
  ): Promise<GetBucketVersioningOutput>
  /**
   * Sends one STS caller-identity read.
   *
   * @param command - Exact read-only command.
   * @returns STS caller response.
   */
  getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput>
  /**
   * Sends one S3 Object Lock configuration read.
   *
   * @param command - Exact owner-bound read-only command.
   * @returns S3 Object Lock response.
   */
  getObjectLockConfiguration(
    command: GetObjectLockConfigurationCommand,
  ): Promise<GetObjectLockConfigurationOutput>
}

/**
 * Composite transport sharing one pinned client set across managed operations.
 */
export interface WorkspaceSearchMigrationManagedAwsTransport
  extends
    WorkspaceSearchMigrationIdentityAwsTransport,
    WorkspaceSearchMigrationImmutableArtifactAwsTransport,
    WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
    WorkspaceSearchMigrationRehearsalReconciliationAwsTransport,
    WorkspaceSearchMigrationRehearsalStageReservationAwsTransport,
    WorkspaceSearchMigrationSourceArtifactAwsTransport,
    WorkspaceSearchMigrationSourceScanAwsTransport,
    WorkspaceSearchMigrationSourceEvidenceAwsTransport,
    WorkspaceSearchMigrationTargetArtifactAwsTransport,
    WorkspaceSearchMigrationTargetEvidenceAwsTransport,
    WorkspaceSearchMigrationTargetScanAwsTransport {}

/**
 * Injectable constructor for the allowlisted AWS SDK transport.
 *
 * @param configurations - Explicit official-endpoint client configurations.
 * @returns Composite transport exposing only allowlisted managed operations.
 */
export type WorkspaceSearchMigrationIdentityAwsTransportConstructor = (
  configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations,
) => WorkspaceSearchMigrationManagedAwsTransport

/**
 * Dedicated AWS transport for one standalone non-production stage commit.
 *
 * The class intentionally owns only STS, journal-tag, and migration-state
 * clients. It cannot issue DescribeTable calls or rate-checkpoint operations.
 */
class AwsSdkWorkspaceSearchMigrationRehearsalStageCommitTransport
  implements WorkspaceSearchMigrationRehearsalStageCommitAwsTransport {
  /** DynamoDB client restricted by the exposed stage-head methods. */
  private readonly dynamodbClient: DynamoDBClient

  /** S3 client restricted to the journal bucket tag preflight. */
  private readonly s3Client: S3Client

  /** STS client restricted to exact caller-identity preflight. */
  private readonly stsClient: STSClient

  /**
   * Creates the three explicit-profile clients needed by one commit.
   *
   * @param configurations - Pinned official-endpoint SDK configurations.
   */
  constructor(
    configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations,
  ) {
    this.dynamodbClient = new DynamoDBClient(configurations.dynamodb)
    this.s3Client = new S3Client(configurations.s3)
    this.stsClient = new STSClient(configurations.sts)
  }

  /** Releases every standalone client despite individual destroy failures. */
  close(): void {
    for (const client of [
      this.dynamodbClient,
      this.s3Client,
      this.stsClient,
    ]) {
      try {
        client.destroy()
      } catch {
        // Best-effort continuation prevents one client from leaking the rest.
      }
    }
  }

  /**
   * Reads the exact AWS signing identity.
   *
   * @param command - Factory-owned empty STS caller request.
   * @returns Raw caller identity output.
   */
  getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    return this.stsClient.send(command)
  }

  /**
   * Reads the selected journal bucket's environment tags.
   *
   * @param command - Exact owner-bound bucket tag request.
   * @returns Raw journal tag output.
   */
  getBucketTagging(
    command: GetBucketTaggingCommand,
  ): Promise<GetBucketTaggingOutput> {
    return this.s3Client.send(command)
  }

  /**
   * Strongly reads the exact manifest-scoped stage head.
   *
   * @param command - Adapter-owned consistent point read.
   * @returns Raw stage-head output.
   */
  getRehearsalStageReservation(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Sends one bounded exact-predecessor stage commit.
   *
   * @param command - Adapter-owned single-Put transaction.
   * @returns Raw transaction response.
   */
  async transactWriteRehearsalStageReservation(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    const abortController = new AbortController()
    const timeout = setTimeout(
      () => abortController.abort(),
      MIGRATION_STATE_TRANSACTION_TIMEOUT_MILLISECONDS,
    )
    try {
      return await this.dynamodbClient.send(command, {
        abortSignal: abortController.signal,
      })
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        throw new MigrationStateTransactionTimeout()
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

/** AWS SDK transport exposing only allowlisted measured migration operations. */
class AwsSdkWorkspaceSearchMigrationIdentityTransport
  implements
    WorkspaceSearchMigrationManagedAwsTransport,
    WorkspaceSearchMigrationDescribeTableRateCheckpointAwsTransport,
    WorkspaceSearchMigrationRehearsalGuardAwsTransport {
  /** DynamoDB client bound to the explicit profile and region. */
  private readonly dynamodbClient: DynamoDBClient

  /** KMS client bound to the explicit profile and region. */
  private readonly kmsClient: KMSClient

  /** S3 client bound to the explicit profile and region. */
  private readonly s3Client: S3Client

  /** STS client bound to the explicit profile and region. */
  private readonly stsClient: STSClient

  /**
   * Creates the exact clients needed by the identity entry gate.
   *
   * @param configurations - Explicit official-endpoint client configurations.
   */
  constructor(configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations) {
    this.dynamodbClient = new DynamoDBClient(configurations.dynamodb)
    this.kmsClient = new KMSClient(configurations.kms)
    this.s3Client = new S3Client(configurations.s3)
    this.stsClient = new STSClient(configurations.sts)
  }

  /**
   * Releases every AWS SDK client.
   */
  close(): void {
    for (const client of [
      this.dynamodbClient,
      this.kmsClient,
      this.s3Client,
      this.stsClient,
    ]) {
      try {
        client.destroy()
      } catch {
        // Continue best-effort cleanup so one client cannot leak the others.
      }
    }
  }

  /**
   * Sends one point-in-time recovery read.
   *
   * @param command - Exact DescribeContinuousBackups command.
   * @returns DynamoDB recovery-state response.
   */
  describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Sends one KMS key metadata read.
   *
   * @param command - Exact DescribeKey command.
   * @returns KMS key metadata response.
   */
  describeKey(command: DescribeKeyCommand): Promise<DescribeKeyCommandOutput> {
    return this.kmsClient.send(command)
  }

  /**
   * Sends one table metadata read.
   *
   * @param command - Exact DescribeTable command.
   * @param signal - Optional managed-operation cancellation signal.
   * @returns DynamoDB table metadata response.
   */
  describeTable(
    command: DescribeTableCommand,
    signal?: AbortSignal,
  ): Promise<DescribeTableCommandOutput> {
    return this.dynamodbClient.send(
      command,
      signal === undefined ? {} : { abortSignal: signal },
    )
  }

  /**
   * Strongly reads one pre-measurement DescribeTable rate checkpoint.
   *
   * @param command - Exact adapter-owned GetItem command.
   * @returns Raw low-level checkpoint item response.
   */
  getRateCheckpoint(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Strongly reads one pre-rate non-production stage-reservation head.
   *
   * @param command - Exact adapter-owned consistent GetItem command.
   * @returns Raw low-level stage-head response.
   */
  getRehearsalStageReservation(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Atomically claims one pre-rate non-production stage reservation.
   *
   * @param command - Exact adapter-owned single-Put transaction.
   * @returns Raw low-level transaction response.
   */
  transactWriteRehearsalStageReservation(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    return this.sendMigrationStateTransaction(command)
  }

  /**
   * Transactionally replaces one pre-measurement rate checkpoint.
   *
   * @param command - Exact adapter-owned single-item transaction.
   * @returns Raw low-level transaction response.
   */
  transactWriteRateCheckpoint(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    return this.sendMigrationStateTransaction(command)
  }

  /**
   * Sends one TTL metadata read.
   *
   * @param command - Exact DescribeTimeToLive command.
   * @returns DynamoDB TTL response.
   */
  describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Sends one collector-owned strongly consistent state-table Query page.
   *
   * This method remains behind the measured non-production session and is not
   * exposed as a generic public Query capability.
   *
   * @param command - Exact base-table prefix Query built by the collector.
   * @param signal - Collector-owned finite request cancellation signal.
   * @returns Raw low-level Query page for strict collector normalization.
   */
  queryStatePage(
    command: QueryCommand,
    signal: AbortSignal,
  ): Promise<QueryCommandOutput> {
    return this.dynamodbClient.send(command, { abortSignal: signal })
  }

  /**
   * Sends one bounded source base-table Scan.
   *
   * @param command - Exact adapter-owned Scan command.
   * @returns Raw low-level DynamoDB page.
   */
  scanSource(command: ScanCommand): Promise<ScanCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Sends one bounded target base-table Scan.
   *
   * @param command - Exact adapter-owned Scan command.
   * @param signal - Optional collector or session cancellation signal.
   * @returns Raw low-level DynamoDB page.
   */
  scanTarget(
    command: ScanCommand,
    signal?: AbortSignal,
  ): Promise<ScanCommandOutput> {
    return this.dynamodbClient.send(
      command,
      signal === undefined ? {} : { abortSignal: signal },
    )
  }

  /**
   * Sends one strongly consistent source-evidence point read.
   *
   * @param command - Exact adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB item response.
   */
  getSourceEvidence(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Defers the measured state-incarnation guard to the managed session wrapper.
   *
   * @returns An already completed low-level preparation.
   */
  prepareSourceEvidenceWrite(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Sends one atomic immutable-page and CAS-head evidence commit.
   *
   * The abort deadline starts only when the SDK send begins, after the managed
   * session's state-incarnation preparation has completed.
   *
   * @param command - Exact adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB transaction response.
   */
  transactWriteSourceEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    return this.sendMigrationStateTransaction(command)
  }

  /**
   * Sends one strongly consistent target-evidence point read.
   *
   * @param command - Exact adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB item response.
   */
  getTargetEvidence(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Defers target and state incarnation guards to the managed session wrapper.
   *
   * @returns An already completed low-level preparation.
   */
  prepareTargetEvidenceWrite(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Sends one atomic immutable target page and CAS-head evidence commit.
   *
   * The abort deadline starts only when the SDK send begins, after target and
   * state incarnation preparation has completed.
   *
   * @param command - Exact adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB transaction response.
   */
  transactWriteTargetEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    return this.sendMigrationStateTransaction(command)
  }

  /**
   * Sends one strongly consistent pre-plan authority point read.
   *
   * @param command - Exact adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB item response.
   */
  getPrePlanAuthority(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /**
   * Defers the measured state-incarnation guard to the managed session wrapper.
   *
   * @returns An already completed low-level preparation.
   */
  preparePrePlanAuthorityWrite(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Sends one atomic pre-plan authority transition.
   *
   * The abort deadline starts only when the SDK send begins, after the managed
   * session's state-incarnation preparation has completed.
   *
   * @param command - Exact adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB transaction response.
   */
  async transactWritePrePlanAuthority(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    return this.sendMigrationStateTransaction(command)
  }

  /**
   * Sends one state-table transaction with a bounded local SDK deadline.
   *
   * @param command - Exact adapter-owned state transaction.
   * @returns Raw low-level DynamoDB transaction response.
   */
  private async sendMigrationStateTransaction(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    const abortController = new AbortController()
    const timeout = setTimeout(
      () => abortController.abort(),
      MIGRATION_STATE_TRANSACTION_TIMEOUT_MILLISECONDS,
    )
    try {
      return await this.dynamodbClient.send(command, {
        abortSignal: abortController.signal,
      })
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        throw new MigrationStateTransactionTimeout()
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Sends one conditional immutable source-artifact upload.
   *
   * @param command - Exact adapter-owned PutObject command.
   * @returns Raw S3 upload response.
   */
  putSourceArtifact(
    command: PutObjectCommand,
  ): Promise<PutObjectCommandOutput> {
    return this.sendMigrationArtifactRequest(
      (abortSignal) => this.s3Client.send(command, { abortSignal }),
    )
  }

  /**
   * Reads exact source-artifact metadata for reconciliation.
   *
   * @param command - Exact adapter-owned HeadObject command.
   * @returns Raw S3 metadata response.
   */
  headSourceArtifact(
    command: HeadObjectCommand,
  ): Promise<HeadObjectCommandOutput> {
    return this.sendMigrationArtifactRequest(
      (abortSignal) => this.s3Client.send(command, { abortSignal }),
    )
  }

  /**
   * Reads one exact source-artifact object version.
   *
   * @param command - Exact adapter-owned GetObject command.
   * @returns Raw S3 object response.
   */
  getSourceArtifact(
    command: GetObjectCommand,
  ): Promise<GetObjectCommandOutput> {
    return this.sendMigrationArtifactRequest(
      (abortSignal) => this.s3Client.send(command, { abortSignal }),
    )
  }

  /**
   * Sends one immutable object upload with the core-owned deadline signal.
   *
   * @param command - Exact codec-agnostic PutObject command.
   * @param abortSignal - Signal owned by the immutable object core.
   * @returns Raw S3 upload response.
   */
  putImmutableArtifact(
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<PutObjectCommandOutput> {
    return this.s3Client.send(command, { abortSignal })
  }

  /**
   * Reads immutable object metadata with the core-owned deadline signal.
   *
   * @param command - Exact current or version-pinned HeadObject command.
   * @param abortSignal - Signal owned by the immutable object core.
   * @returns Raw S3 metadata response.
   */
  headImmutableArtifact(
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<HeadObjectCommandOutput> {
    return this.s3Client.send(command, { abortSignal })
  }

  /**
   * Reads one immutable object version with the core-owned deadline signal.
   *
   * @param command - Exact version-pinned GetObject command.
   * @param abortSignal - Signal owned by the immutable object core.
   * @returns Raw S3 object response.
   */
  getImmutableArtifact(
    command: GetObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<GetObjectCommandOutput> {
    return this.s3Client.send(command, { abortSignal })
  }

  /**
   * Sends one conditional immutable target-artifact upload.
   *
   * @param command - Exact adapter-owned PutObject command.
   * @returns Raw S3 upload response.
   */
  putTargetArtifact(
    command: PutObjectCommand,
  ): Promise<PutObjectCommandOutput> {
    return this.sendMigrationArtifactRequest(
      (abortSignal) => this.s3Client.send(command, { abortSignal }),
    )
  }

  /**
   * Reads exact target-artifact metadata for reconciliation.
   *
   * @param command - Exact adapter-owned HeadObject command.
   * @returns Raw S3 metadata response.
   */
  headTargetArtifact(
    command: HeadObjectCommand,
  ): Promise<HeadObjectCommandOutput> {
    return this.sendMigrationArtifactRequest(
      (abortSignal) => this.s3Client.send(command, { abortSignal }),
    )
  }

  /**
   * Reads one exact target-artifact object version.
   *
   * @param command - Exact adapter-owned GetObject command.
   * @returns Raw S3 object response.
   */
  getTargetArtifact(
    command: GetObjectCommand,
  ): Promise<GetObjectCommandOutput> {
    return this.sendMigrationArtifactRequest(
      (abortSignal) => this.s3Client.send(command, { abortSignal }),
    )
  }

  /**
   * Sends one migration-artifact S3 request with a bounded local SDK deadline.
   *
   * @param operation - Exact request using the adapter-owned abort signal.
   * @returns Raw successful S3 response.
   */
  private async sendMigrationArtifactRequest<Result>(
    operation: (abortSignal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const abortController = new AbortController()
    const timeout = setTimeout(
      () => abortController.abort(),
      WORKSPACE_SEARCH_MIGRATION_MANAGED_ARTIFACT_REQUEST_TIMEOUT_MILLISECONDS,
    )
    try {
      return await operation(abortController.signal)
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        throw new MigrationArtifactTimeout()
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Sends one bucket-encryption read.
   *
   * @param command - Exact GetBucketEncryption command.
   * @returns S3 encryption response.
   */
  getBucketEncryption(
    command: GetBucketEncryptionCommand,
  ): Promise<GetBucketEncryptionOutput> {
    return this.s3Client.send(command)
  }

  /**
   * Reads the selected journal bucket's deployment-environment tags.
   *
   * @param command - Exact owner-bound GetBucketTagging command.
   * @param signal - Optional root-owned complete-lifecycle cancellation.
   * @returns Raw S3 bucket tag response used only during rehearsal preflight.
   */
  getBucketTagging(
    command: GetBucketTaggingCommand,
    signal?: AbortSignal,
  ): Promise<GetBucketTaggingOutput> {
    return this.s3Client.send(
      command,
      signal === undefined ? {} : { abortSignal: signal },
    )
  }

  /**
   * Sends one bucket-logging read.
   *
   * @param command - Exact GetBucketLogging command.
   * @returns S3 logging response.
   */
  getBucketLogging(
    command: GetBucketLoggingCommand,
  ): Promise<GetBucketLoggingOutput> {
    return this.s3Client.send(command)
  }

  /**
   * Sends one bucket-versioning read.
   *
   * @param command - Exact GetBucketVersioning command.
   * @returns S3 versioning response.
   */
  getBucketVersioning(
    command: GetBucketVersioningCommand,
  ): Promise<GetBucketVersioningOutput> {
    return this.s3Client.send(command)
  }

  /**
   * Sends one caller-identity read.
   *
   * @param command - Exact GetCallerIdentity command.
   * @param signal - Optional root-owned complete-lifecycle cancellation.
   * @returns STS caller response.
   */
  getCallerIdentity(
    command: GetCallerIdentityCommand,
    signal?: AbortSignal,
  ): Promise<GetCallerIdentityCommandOutput> {
    return this.stsClient.send(
      command,
      signal === undefined ? {} : { abortSignal: signal },
    )
  }

  /**
   * Sends one Object Lock configuration read.
   *
   * @param command - Exact GetObjectLockConfiguration command.
   * @returns S3 Object Lock response.
   */
  getObjectLockConfiguration(
    command: GetObjectLockConfigurationCommand,
  ): Promise<GetObjectLockConfigurationOutput> {
    return this.s3Client.send(command)
  }
}

/**
 * Dedicated read-only S3 transport for a root or guarded live attestation.
 *
 * DescribeTable is deliberately an unreachable fallback because the managed
 * integrity adapter owns every table read. STS, Scan, object-tag, and HEAD
 * operations also fail locally for the root operation. The same constructor
 * can be reused behind a permit-backed live outer gate without weakening its
 * fallback rule.
 */
class AwsSdkWorkspaceSearchMigrationRehearsalIntegrityTransport
  implements CrossDomainIntegrityAwsTransport {
  /** S3 client sharing the exact pinned profile and official endpoint. */
  private readonly s3Client: S3Client

  /** Whether the sole owned SDK client was already destroyed. */
  private closed = false

  /**
   * Creates the exact S3 client needed by immutable resource attestation.
   *
   * @param configuration - Existing hardened migration S3 configuration.
   */
  constructor(
    configuration: WorkspaceSearchMigrationIdentityS3SdkClientConfiguration,
  ) {
    this.s3Client = new S3Client(configuration)
  }

  /** Releases the sole owned S3 client exactly once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.s3Client.destroy()
  }

  /** Rejects any attempt to bypass the managed DescribeTable adapter. */
  describeTable(
    _command: DescribeTableCommand,
    _signal: AbortSignal,
  ): Promise<DescribeTableCommandOutput> {
    return rejectPrePermitRootOperation()
  }

  /** Reads only the exact owner-bound File bucket versioning state. */
  getBucketVersioning(
    command: GetBucketVersioningCommand,
    signal: AbortSignal,
  ): Promise<GetBucketVersioningCommandOutput> {
    return this.s3Client.send(command, { abortSignal: signal })
  }

  /** Reads only the exact immutable File marker object's attributes. */
  getObjectAttributes(
    command: GetObjectAttributesCommand,
    signal: AbortSignal,
  ): Promise<GetObjectAttributesCommandOutput> {
    return this.s3Client.send(command, { abortSignal: signal })
  }

  /** Rejects object-tag reads because root attestation does not need them. */
  getObjectTagging(
    _command: GetObjectTaggingCommand,
    _signal: AbortSignal,
  ): Promise<GetObjectTaggingCommandOutput> {
    return rejectPrePermitRootOperation()
  }

  /** Rejects object HEAD reads because root attestation does not need them. */
  headObject(
    _command: HeadObjectCommand,
    _signal: AbortSignal,
  ): Promise<HeadObjectCommandOutput> {
    return rejectPrePermitRootOperation()
  }

  /** Rejects a second caller-identity path after exact outer STS preflight. */
  readCallerIdentity(
    _command: GetCallerIdentityCommand,
    _signal: AbortSignal,
  ): Promise<GetCallerIdentityCommandOutput> {
    return rejectPrePermitRootOperation()
  }

  /** Rejects every data-plane Scan from the attestation-only transport. */
  scan(
    _command: ScanCommand,
    _signal: AbortSignal,
  ): Promise<ScanCommandOutput> {
    return rejectPrePermitRootOperation()
  }
}

/** Real read-only AWS transport retained only for one permit-backed live run. */
class AwsSdkWorkspaceSearchMigrationRehearsalIntegrityLiveTransport
  implements WorkspaceSearchMigrationRehearsalIntegrityLiveReadTransport {
  /** DynamoDB data-plane client restricted to bounded Scan commands. */
  private readonly dynamodbClient: DynamoDBClient

  /** S3 client restricted to versioning, attributes, tags, and HEAD reads. */
  private readonly s3Client: S3Client

  /** STS client restricted to one exact caller-identity read. */
  private readonly stsClient: STSClient

  /** Exact account expected from the live STS call. */
  private readonly expectedAccount: string

  /** Exact assumed-role session ARN authenticated by the permit. */
  private readonly expectedCallerArn: string

  /** Session-owned admission check run before and after every service read. */
  private readonly requireAdmission: () => void

  /** Whether every owned SDK client was already destroyed. */
  private closed = false

  /**
   * Creates only the three official-endpoint clients needed by #163.
   *
   * @param configurations - Pinned official-endpoint client configurations.
   * @param expectedAccount - Exact permit-authorized AWS account.
   * @param expectedCallerArn - Exact permit-authorized STS caller ARN.
   * @param requireAdmission - Session admission checked around every send.
   */
  constructor(
    configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations,
    expectedAccount: string,
    expectedCallerArn: string,
    requireAdmission: () => void,
  ) {
    this.dynamodbClient = new DynamoDBClient(configurations.dynamodb)
    this.s3Client = new S3Client(configurations.s3)
    this.stsClient = new STSClient(configurations.sts)
    this.expectedAccount = expectedAccount
    this.expectedCallerArn = expectedCallerArn
    this.requireAdmission = requireAdmission
  }

  /** Releases every owned SDK client exactly once and without early exit. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const client of [
      this.dynamodbClient,
      this.s3Client,
      this.stsClient,
    ]) {
      try {
        client.destroy()
      } catch {
        // Every client receives its best-effort close despite sibling failure.
      }
    }
  }

  /** Reads only the exact owner-bound File bucket versioning state. */
  getBucketVersioning(
    command: GetBucketVersioningCommand,
    signal: AbortSignal,
  ): Promise<GetBucketVersioningCommandOutput> {
    return this.runRead(
      signal,
      async () => await this.s3Client.send(command, {
        abortSignal: signal,
      }),
    )
  }

  /** Reads only the exact immutable File marker object's attributes. */
  getObjectAttributes(
    command: GetObjectAttributesCommand,
    signal: AbortSignal,
  ): Promise<GetObjectAttributesCommandOutput> {
    return this.runRead(
      signal,
      async () => await this.s3Client.send(command, {
        abortSignal: signal,
      }),
    )
  }

  /** Reads only immutable File object tags selected by the checker. */
  getObjectTagging(
    command: GetObjectTaggingCommand,
    signal: AbortSignal,
  ): Promise<GetObjectTaggingCommandOutput> {
    return this.runRead(
      signal,
      async () => await this.s3Client.send(command, {
        abortSignal: signal,
      }),
    )
  }

  /** Reads only immutable File object metadata selected by the checker. */
  headObject(
    command: HeadObjectCommand,
    signal: AbortSignal,
  ): Promise<HeadObjectCommandOutput> {
    return this.runRead(
      signal,
      async () => await this.s3Client.send(command, {
        abortSignal: signal,
      }),
    )
  }

  /** Reads and enforces the exact permit-authorized STS caller identity. */
  async readCallerIdentity(
    command: GetCallerIdentityCommand,
    signal: AbortSignal,
  ): Promise<GetCallerIdentityCommandOutput> {
    const output = await this.runRead(
      signal,
      async () => await this.stsClient.send(command, {
        abortSignal: signal,
      }),
    )
    requirePreMeasurementCallerIdentity(output, this.expectedAccount)
    if (
      output.Account !== this.expectedAccount ||
      output.Arn !== this.expectedCallerArn
    ) throw new WorkspaceSearchMigrationRehearsalPermitError()
    return output
  }

  /** Sends only one checker-built bounded strongly consistent Scan page. */
  scan(
    command: ScanCommand,
    signal: AbortSignal,
  ): Promise<ScanCommandOutput> {
    return this.runRead(
      signal,
      async () => await this.dynamodbClient.send(command, {
        abortSignal: signal,
      }),
    )
  }

  /**
   * Runs one service read between exact permit/session admission checks.
   *
   * @param signal - Complete live invocation cancellation.
   * @param operation - One allowlisted SDK send using the same signal.
   * @returns Raw SDK output after post-send admission remains active.
   */
  private async runRead<Result>(
    signal: AbortSignal,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (
      this.closed ||
      !(signal instanceof AbortSignal) ||
      nodeUtilTypes.isProxy(signal) ||
      signal.aborted
    ) throw new WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError()
    this.requireAdmission()
    try {
      return await operation()
    } finally {
      this.requireAdmission()
    }
  }
}

/** Exact actual-send state inherited by one managed immutable write. */
type ManagedImmutableArtifactWriteSendState = {
  /** Whether the owning write callback may still reach the transport. */
  active: boolean
  /** Whether an actual immutable Put transport invocation has begun. */
  sent: boolean
}

/** Managed AWS adapter bound to one validated resource selection. */
class AwsWorkspaceSearchMigrationIdentityPort
  implements WorkspaceSearchMigrationManagedAwsSession {
  /** Immutable resource snapshot shared with identity measurement. */
  private readonly requested: WorkspaceSearchMigrationRequestedResourcesSnapshot

  /** Digest binding every read to the immutable resource snapshot. */
  private readonly requestedResourcesBinding: string

  /** AWS account selected by the operator. */
  private readonly account: string

  /** Physical journal bucket selected by the operator. */
  private readonly journalBucket: string

  /** Customer-managed journal key selected by the operator. */
  private readonly journalKeyArn: string

  /** Exact physical table names selected by the operator. */
  private readonly tableNames: ReadonlySet<string>

  /** Allowlisted AWS command transport. */
  private readonly transport: WorkspaceSearchMigrationManagedAwsTransport

  /** Optional durable controller owning every production DescribeTable call. */
  private readonly describeTableRate:
    WorkspaceSearchMigrationManagedDescribeTableRate | undefined

  /** Optional observer for exact-once managed quarantine transitions. */
  private readonly telemetryRecorder:
    WorkspaceSearchMigrationQuarantineTelemetryRecorder | undefined

  /** Whether this session owns final closure of the shared rate controller. */
  private readonly ownsDescribeTableRate: boolean

  /** Factory for a fresh child that shares the parent's rate lifecycle. */
  private readonly rateManagedMeasurementSessionFactory:
    (() => Promise<WorkspaceSearchMigrationManagedIdentityPort>) | undefined

  /** Optional one-shot semantic fault available only to a rehearsal session. */
  private readonly rehearsalFaultController:
    WorkspaceSearchMigrationRehearsalFaultController | undefined

  /** Authenticated non-production guard retained for evidence publication. */
  private readonly rehearsalGuard:
    NonProductionRehearsalConstructionGuard | undefined

  /** Immutable secret-free stage head claimed during remote preflight. */
  private readonly claimedRehearsalStageHead:
    WorkspaceSearchMigrationRehearsalStageHead | undefined

  /** Newly durable acquisition projections not yet read by the rehearsal. */
  private readonly pendingRehearsalLeaseAcquisitionObservations:
    WorkspaceSearchMigrationDurableLeaseAcquisitionObservation[] = []

  /** Digests suppressing duplicate success for one deterministic acquisition. */
  private readonly observedRehearsalLeaseAcquisitionDigests =
    new Set<string>()

  /** Strict authority-adoption receipts not yet consumed by stage material. */
  private readonly pendingRehearsalAuthorityAdoptionObservations:
    WorkspaceSearchMigrationRehearsalExpectedAuthority[] = []

  /** Renewal position retained for every already observed receipt digest. */
  private readonly observedRehearsalAuthorityAdoptionDigests =
    new Map<string, number>()

  /** Receipt digest retained for every already observed renewal position. */
  private readonly observedRehearsalAuthorityAdoptionRenewals =
    new Map<number, string>()

  /** Highest unseen-or-consumed renewal position observed this generation. */
  private highestRehearsalAuthorityAdoptionRenewalCount:
    number | undefined

  /** Adapter-proven runtime fault observations not yet read by the rehearsal. */
  private readonly pendingRehearsalFaultObservations:
    WorkspaceSearchMigrationRehearsalFaultObservation[] = []

  /** Digests suppressing duplicate adapter-proven runtime fault observations. */
  private readonly observedRehearsalFaultObservationDigests =
    new Set<string>()

  /** Stable current rehearsal lease identity proven by the latest observation. */
  private rehearsalLeaseIdentityDigest: string | undefined

  /** Closed writer-fence record digest proven in this managed session. */
  private rehearsalClosedWriterFenceRecordDigest: string | undefined

  /** Adapter-owned trusted clock for pre-plan authority transitions. */
  private readonly prePlanAuthorityClock:
    WorkspaceSearchMigrationPrePlanAuthorityClock

  /** Whether this managed session has permanently released its clients. */
  private closed = false

  /** Whether final rate evidence has stopped every operational admission. */
  private rateSealed = false

  /** Cancellation merged into target scans and tripped by seal or close. */
  private readonly operationalAbortController = new AbortController()

  /** Exact-once completion for asynchronous owned transport drainage. */
  private closeCompletion: Promise<void> | undefined

  /** Exact-once final aggregate retained until final transport closure. */
  private sealEvidenceCompletion:
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence> | undefined

  /** Generation invalidated by close and every replacement measurement. */
  private generation = 0

  /** Hash authorized by the most recent successful identity measurement. */
  private measuredConfigurationHash: string | undefined

  /** Detached configuration authorized by the latest successful measurement. */
  private measuredConfiguration:
    WorkspaceSearchMigrationConfiguration | undefined

  /** Immutable object port installed by the current successful measurement. */
  private measuredPlanningArtifactPort:
    WorkspaceSearchMigrationImmutableArtifactAwsPort | undefined

  /** One-way cancellation owned by the current measured immutable object port. */
  private measuredPlanningArtifactAbortController:
    AbortController | undefined

  /** Migration-state table incarnation authorized by the current measurement. */
  private measuredMigrationStateTable: MigrationTableIdentity | undefined

  /**
   * Whether an uncertain execution-control commit quarantined this measurement.
   */
  private measuredExecutionControlQuarantined = false

  /** Operation-local actual-send latch for managed immutable writes. */
  private readonly immutableArtifactWriteSendState =
    new AsyncLocalStorage<ManagedImmutableArtifactWriteSendState>()

  /** Operation-local post-send authority isolated across concurrent calls. */
  private readonly awsMutationDrainState =
    new AsyncLocalStorage<ManagedAwsMutationDrainState>()

  /**
   * Creates a port bound to immutable copies of the reviewed resources.
   *
   * @param requested - Validated operator-selected resources.
   * @param transport - Allowlisted AWS command transport.
   * @param prePlanAuthorityClock - Trusted clock captured by authority commits.
   * @param telemetryRecorder - Optional captured quarantine-only observer.
   * @param describeTableRate - Optional durable DescribeTable controller.
   * @param ownsDescribeTableRate - Whether close drains the shared controller.
   * @param measurementSessionFactory - Optional shared-controller child factory.
   * @param rehearsalGuard - Optional authenticated non-production boundary.
   * @param claimedRehearsalStageHead - Optional pre-rate durable stage claim.
   */
  constructor(
    requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
    transport: WorkspaceSearchMigrationManagedAwsTransport,
    prePlanAuthorityClock:
      WorkspaceSearchMigrationPrePlanAuthorityClock,
    telemetryRecorder?: WorkspaceSearchMigrationQuarantineTelemetryRecorder,
    describeTableRate?: WorkspaceSearchMigrationManagedDescribeTableRate,
    ownsDescribeTableRate = false,
    measurementSessionFactory?:
      () => Promise<WorkspaceSearchMigrationManagedIdentityPort>,
    rehearsalGuard?: NonProductionRehearsalConstructionGuard,
    claimedRehearsalStageHead?:
      WorkspaceSearchMigrationRehearsalStageHead,
  ) {
    this.requested = requested
    this.requestedResourcesBinding =
      createWorkspaceSearchMigrationRequestedResourcesBinding(requested)
    this.account = requested.account
    this.journalBucket = requested.journalBucket
    this.journalKeyArn = requested.journalKeyArn
    this.tableNames = new Set(Object.values(requested.tables))
    this.transport = transport
    this.prePlanAuthorityClock = prePlanAuthorityClock
    this.telemetryRecorder = telemetryRecorder
    this.describeTableRate = describeTableRate
    this.ownsDescribeTableRate = ownsDescribeTableRate
    this.rateManagedMeasurementSessionFactory = measurementSessionFactory
    this.rehearsalGuard = rehearsalGuard
    this.rehearsalFaultController = rehearsalGuard?.faultController
    this.claimedRehearsalStageHead = claimedRehearsalStageHead === undefined
      ? undefined
      : cloneRehearsalStageHead(claimedRehearsalStageHead)
  }

  /**
   * Releases every AWS SDK client owned by the transport.
   */
  close(): Promise<void> {
    const existing = this.closeCompletion
    if (existing !== undefined) return existing
    const ownsDescribeTableRate =
      this.describeTableRate !== undefined && this.ownsDescribeTableRate
    const rateCompletion =
      ownsDescribeTableRate
        ? this.beginOwnedDescribeTableRateSeal().then(() => undefined)
        : Promise.resolve()
    this.operationalAbortController.abort()
    this.closed = true
    this.generation += 1
    this.measuredConfigurationHash = undefined
    this.measuredConfiguration = undefined
    this.invalidateManagedPlanningArtifactPort()
    this.measuredMigrationStateTable = undefined
    this.measuredExecutionControlQuarantined = false
    this.pendingRehearsalLeaseAcquisitionObservations.splice(0)
    this.observedRehearsalLeaseAcquisitionDigests.clear()
    this.pendingRehearsalAuthorityAdoptionObservations.splice(0)
    this.observedRehearsalAuthorityAdoptionDigests.clear()
    this.observedRehearsalAuthorityAdoptionRenewals.clear()
    this.highestRehearsalAuthorityAdoptionRenewalCount = undefined
    this.pendingRehearsalFaultObservations.splice(0)
    this.observedRehearsalFaultObservationDigests.clear()
    this.rehearsalLeaseIdentityDigest = undefined
    this.rehearsalClosedWriterFenceRecordDigest = undefined
    /** Closes the sole transport retained by this managed session. */
    const closeTransport = (): void => this.transport.close()
    if (!ownsDescribeTableRate) {
      try {
        closeTransport()
      } catch {
        // The unmanaged close contract remains best-effort and synchronous.
      }
      const completion = Promise.resolve()
      this.closeCompletion = completion
      return completion
    }
    const completion = rateCompletion.then(
      () => closeTransport(),
      (error: unknown) => {
        try {
          closeTransport()
        } catch {
          // Preserve the first sealed-rate failure as the retry outcome.
        }
        throw error
      },
    )
    this.closeCompletion = completion
    return completion
  }

  /** Seals rate admission while retaining publication-only AWS transport. */
  sealAndReadDescribeTableRateEvidence():
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence> {
    if (
      this.rehearsalGuard === undefined ||
      this.describeTableRate === undefined ||
      !this.ownsDescribeTableRate
    ) {
      return Promise.reject(invalidIdentityLookup())
    }
    return this.beginOwnedDescribeTableRateSeal()
  }

  /**
   * Stops every operational admission and drains the owned rate controller.
   *
   * @returns Exact final rate evidence retained across seal and close calls.
   */
  private beginOwnedDescribeTableRateSeal():
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence> {
    const existing = this.sealEvidenceCompletion
    if (existing !== undefined) return existing
    const rate = this.describeTableRate
    if (rate === undefined || !this.ownsDescribeTableRate) {
      return Promise.reject(invalidIdentityLookup())
    }
    this.rateSealed = true
    this.operationalAbortController.abort()
    this.generation += 1
    this.invalidateManagedPlanningArtifactPort()
    this.measuredExecutionControlQuarantined = false
    const completion = rate.closeAndReadEvidence().then(
      (evidence) => Object.freeze({ ...evidence }),
    )
    this.sealEvidenceCompletion = completion
    return completion
  }

  /** Creates an independent identity port sharing this exact rate lifecycle. */
  async createRateManagedMeasurementSession():
    Promise<WorkspaceSearchMigrationManagedIdentityPort> {
    this.requireNewAwsAdmission()
    const factory = this.rateManagedMeasurementSessionFactory
    if (factory === undefined) throw invalidIdentityLookup()
    return await factory()
  }

  /** Installs one synchronous heartbeat guard on the shared rate controller. */
  async runWithMutationAdmissionGuard<Result>(
    guard: () => void,
    task: () => Promise<Result>,
  ): Promise<Result> {
    this.requireNewAwsAdmission()
    if (typeof guard !== 'function' || typeof task !== 'function') {
      throw invalidIdentityLookup()
    }
    const rate = this.describeTableRate
    if (rate === undefined) {
      guard()
      return await task()
    }
    return await rate.runWithMutationAdmissionGuard(guard, task)
  }

  /** Stops every new AWS data mutation while preserving active cleanup. */
  interruptMutationAdmission(): void {
    this.describeTableRate?.interrupt()
  }

  /** Stops every new rate-managed DescribeTable operation. */
  interruptDescribeTableRate(): void {
    this.interruptMutationAdmission()
  }

  /** Returns the current secret-free DescribeTable rate aggregate. */
  readDescribeTableRateEvidence():
    WorkspaceSearchMigrationDescribeTableRateEvidence {
    this.requireOpen()
    const rate = this.describeTableRate
    if (rate === undefined) throw invalidIdentityLookup()
    return rate.readEvidence()
  }

  /**
   * Reconstructs and reconciles one authoritative rehearsal terminal.
   *
   * @param input - Restricted run, rollback target files, and finite limits.
   * @returns Opaque one-shot base awaiting post-seal #163 completion.
   */
  async collectRehearsalReconciliation(
    input:
      CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
  ): Promise<WorkspaceSearchMigrationRehearsalCollectedReconciliationBase> {
    const request = prepareManagedReconciliationSessionInput(input)
    let integrityKey: Uint8Array | undefined
    try {
      this.requireNewAwsAdmission()
      const guard = this.rehearsalGuard
      if (guard === undefined) {
        throw new WorkspaceSearchMigrationRehearsalPermitError()
      }
      requireNonProductionRehearsalPermitActive(guard)
      requireManagedReconciliationCallerActive(request.signal)
      const graph = await this.readManagedReconciliationExecutionGraph(
        request.runId,
        request.signal,
      )
      integrityKey = this.copyManagedReconciliationIntegrityKey()
      if (integrityKey === undefined) {
        return failManagedReconciliationSession()
      }
      const expectedMigrationResourceIdentities =
        createWorkspaceSearchMigrationManagedReconciliationResourceIdentities(
          graph.authority.configuration,
          integrityKey,
        )
      integrityKey.fill(0)
      integrityKey = undefined
      validateWorkspaceSearchMigrationManagedReconciliationResourceIdentities({
        expected: expectedMigrationResourceIdentities,
        resourceIdentityScheme:
          guard.permit.integrityResourceIdentityScheme,
        resourceIdentities: guard.permit.integrityResourceIdentities,
      })
      const terminal = await this.createManagedReconciliationTerminalMaterial(
        graph,
        request.scenario,
        request.signal,
      )
      const target = authenticateManagedReconciliationTarget(
        request,
        terminal.binding,
        this.readManagedReconciliationTargetSourceBinding(
          graph.authority.configurationHash,
        ),
        graph,
        guard,
        this.claimedRehearsalStageHead,
      )
      requireManagedReconciliationTargetResourceIdentities(
        target,
        guard.permit.integrityResourceIdentityDigest,
        expectedMigrationResourceIdentities,
      )
      const expectedMarkers = createManagedReconciliationExpectedMarkers(
        graph.replay,
        terminal.markerSeal.markerCount,
      )
      const auditBinding: WorkspaceSearchMigrationApplyAuditBindingInput = {
        configuration: graph.authority.configuration,
        configurationHash: graph.authority.configurationHash,
        executionBoundary: graph.executionBoundary,
        sealedPlanningAuthority: graph.sealedPlanningAuthority,
        closedWriterFenceRecord: graph.closedWriterFenceRecord,
        executionRun: graph.executionRun,
      }
      const collected = await
        collectWorkspaceSearchMigrationRehearsalReconciliationAws({
          stateTableName: graph.authority.stateTable.tableName,
          expectedTerminalBinding: terminal.binding,
          expectedMarkers,
          expectedMarkerAggregateDigest:
            terminal.markerSeal.aggregateDigest,
          expectedAuthorities: request.expectedAuthorities,
          auditBinding,
          parsers: {
            parseMarker:
              parseWorkspaceSearchMigrationApplyMarkerAuditRecord,
            parseAuthority:
              parseWorkspaceSearchMigrationApplyAuthorityAuditRecord,
          },
          transport: {
            queryStatePage: async (command, signal) => {
              requireManagedReconciliationCallerActive(signal)
              requireManagedReconciliationCallerActive(request.signal)
              this.requireNewAwsAdmission()
              this.requireManagedFullVerificationAuthority(graph.authority)
              const output = await this.transport.queryStatePage(
                command,
                signal,
              )
              this.requireManagedFullVerificationAuthority(graph.authority)
              this.requireNewAwsAdmission()
              requireManagedReconciliationCallerActive(request.signal)
              return output
            },
          },
          guards: {
            readTerminalBinding: terminal.readBinding,
            requireCurrentTableIncarnations: async (signal) => {
              requireManagedReconciliationCallerActive(signal)
              requireManagedReconciliationCallerActive(request.signal)
              this.requireNewAwsAdmission()
              await this.requireCurrentFullVerificationTableIncarnations(
                graph.authority,
              )
              this.requireManagedFullVerificationAuthority(graph.authority)
              requireManagedReconciliationCallerActive(request.signal)
            },
          },
          limits: request.limits,
          clock: request.clock,
          ...(request.signal === undefined
            ? {}
            : { signal: request.signal }),
        })
      const checkedAt = readManagedReconciliationClock(request.clock)
      const context = createManagedReconciliationCoreContext(
        request,
        terminal.binding,
        guard.permit.policyVersion,
        guard.permit.integrityResourceIdentityDigest,
        checkedAt,
      )
      const sourceTargetSummary =
        createManagedReconciliationSourceTargetSummary(
          terminal.verifiedResult,
          target,
        )
      const base = Object.freeze({
        context,
        targetAudits: target === undefined
          ? null
          : createManagedReconciliationTargetAuditPair(target),
        markerSummary: collected.markerSummary,
        authoritySummary: collected.authoritySummary,
        sourceTargetSummary,
      })
      const capability =
        new WorkspaceSearchMigrationRehearsalCollectedReconciliationBase(
          collectedReconciliationBaseToken,
        )
      managedReconciliationCollectedBaseStates.set(capability, Object.freeze({
        base,
        expectedMigrationResourceIdentities,
        expectedResourceIdentityDigest:
          guard.permit.integrityResourceIdentityDigest,
        ...(target === undefined ? {} : { target }),
        clock: request.clock,
      }))
      return capability
    } finally {
      integrityKey?.fill(0)
      zeroizeManagedReconciliationSessionInput(request)
    }
  }

  /**
   * Reconstructs the admitted execution graph from strong roots and S3 replay.
   *
   * @param runId - Exact restricted run selected by authenticated stage state.
   * @param signal - Optional caller cancellation checked around every phase.
   * @returns Complete measured graph used by the strict audit codecs.
   */
  private async readManagedReconciliationExecutionGraph(
    runId: string,
    signal: AbortSignal | undefined,
  ): Promise<ManagedReconciliationExecutionGraph> {
    const authority = this.captureManagedFullVerificationAuthority()
    requireManagedReconciliationCallerActive(signal)
    const [boundary, fence, sealedPlanningAuthority] = await Promise.all([
      this.createExecutionBoundaryPort().read(runId),
      this.createApplicationWriterFencePort().read(),
      this.createSealedPlanningAuthorityPort().read(runId),
    ])
    requireManagedReconciliationCallerActive(signal)
    if (
      boundary === undefined ||
      boundary.phase !== 'planning-admitted' ||
      sealedPlanningAuthority === undefined ||
      fence.status !== 'present' ||
      fence.record.mode !== 'closed' ||
      fence.record.recordDigest !==
        boundary.closedWriterFenceRecordDigest ||
      boundary.runId !== runId ||
      sealedPlanningAuthority.runId !== runId ||
      boundary.configurationHash !== authority.configurationHash ||
      sealedPlanningAuthority.configurationHash !==
        authority.configurationHash
    ) {
      return failManagedReconciliationSession()
    }
    await this.requireCurrentFullVerificationTableIncarnations(authority)
    const replay = await this.createPlanningArtifactGateway(
      runId,
    ).replayPlanArtifact({
      planSealReference: sealedPlanningAuthority.planSealReference,
      manifestHeadReference:
        sealedPlanningAuthority.planManifestHeadReference,
    })
    await this.requireCurrentFullVerificationTableIncarnations(authority)
    requireManagedReconciliationCallerActive(signal)
    const executionRun = await this.createExecutionRunPort(
      boundary,
      sealedPlanningAuthority,
      replay.planSeal,
      fence.record,
    ).read(runId)
    requireManagedReconciliationCallerActive(signal)
    if (
      executionRun === undefined ||
      replay.operations.length !==
        sealedPlanningAuthority.planOperationCount ||
      replay.planSeal.planDigest !==
        sealedPlanningAuthority.planDigest ||
      executionRun.executionRunDigest === undefined
    ) {
      return failManagedReconciliationSession()
    }
    return Object.freeze({
      authority,
      executionBoundary: boundary,
      closedWriterFenceRecord: fence.record,
      sealedPlanningAuthority,
      replay,
      executionRun,
    })
  }

  /**
   * Selects and strongly reads the exact verified or rolled-back terminal.
   *
   * @param graph - Complete admitted execution graph reconstructed in-session.
   * @param scenario - Canonical scenario selecting terminal semantics.
   * @param signal - Optional caller cancellation checked around terminal reads.
   * @returns Terminal identity, marker seal, and fresh reread capability.
   */
  private async createManagedReconciliationTerminalMaterial(
    graph: ManagedReconciliationExecutionGraph,
    scenario: WorkspaceSearchMigrationRehearsalScenarioName,
    signal: AbortSignal | undefined,
  ): Promise<ManagedReconciliationTerminalMaterial> {
    const apply = this.createApplyOperationPort(
      graph.executionBoundary,
      graph.sealedPlanningAuthority,
      graph.closedWriterFenceRecord,
      graph.executionRun,
    )
    if (isManagedReconciliationVerifiedScenario(scenario)) {
      const verification = this.createFullVerificationPort(
        graph.executionBoundary,
        graph.sealedPlanningAuthority,
        graph.closedWriterFenceRecord,
        graph.executionRun,
      )
      requireManagedReconciliationCallerActive(signal)
      const [root, result, appliedRoot] = await Promise.all([
        verification.readVerifiedRoot(),
        verification.readVerifiedResult(),
        apply.readAppliedRoot(),
      ])
      requireManagedReconciliationCallerActive(signal)
      if (
        root === undefined ||
        result === undefined ||
        appliedRoot === undefined ||
        root.appliedRootDigest !== appliedRoot.rootDigest ||
        root.verificationResultDigest !== result.resultDigest ||
        appliedRoot.seal.markerCount !==
          graph.sealedPlanningAuthority.planOperationCount
      ) {
        return failManagedReconciliationSession()
      }
      const markerSeal = createManagedReconciliationMarkerSeal(
        appliedRoot.seal.markerCount,
        appliedRoot.seal.applyMarkerAggregateDigest,
      )
      const binding = createManagedVerifiedTerminalBinding(
        graph,
        root.persistenceVersion,
        root.verifiedRootDigest,
        root.appliedRootDigest,
        root.verifiedAt,
        markerSeal.markerCount,
      )
      return Object.freeze({
        binding,
        markerSeal,
        verifiedResult: result,
        readBinding: async (requestSignal: AbortSignal) => {
          requireManagedReconciliationCallerActive(requestSignal)
          const current = await verification.readVerifiedRoot()
          requireManagedReconciliationCallerActive(requestSignal)
          if (current === undefined) {
            return failManagedReconciliationSession()
          }
          return createManagedVerifiedTerminalBinding(
            graph,
            current.persistenceVersion,
            current.verifiedRootDigest,
            current.appliedRootDigest,
            current.verifiedAt,
            markerSeal.markerCount,
          )
        },
      })
    }
    if (scenario === 'complete-apply-rollback') {
      const rollback = this.createRollbackOperationPort(
        graph.executionBoundary,
        graph.sealedPlanningAuthority,
        graph.closedWriterFenceRecord,
        graph.executionRun,
      )
      requireManagedReconciliationCallerActive(signal)
      const [root, appliedRoot] = await Promise.all([
        rollback.readRolledBackRoot(),
        apply.readAppliedRoot(),
      ])
      requireManagedReconciliationCallerActive(signal)
      if (
        root === undefined ||
        appliedRoot === undefined ||
        root.appliedRootDigest !== appliedRoot.rootDigest ||
        appliedRoot.seal.markerCount !==
          graph.sealedPlanningAuthority.planOperationCount
      ) {
        return failManagedReconciliationSession()
      }
      const markerSeal = createManagedReconciliationMarkerSeal(
        appliedRoot.seal.markerCount,
        appliedRoot.seal.applyMarkerAggregateDigest,
      )
      const binding = createManagedRolledBackTerminalBinding(
        graph,
        root.persistenceVersion,
        root.rootDigest,
        root.appliedRootDigest,
        root.finishedAt,
        markerSeal.markerCount,
      )
      return Object.freeze({
        binding,
        markerSeal,
        readBinding: async (requestSignal: AbortSignal) => {
          requireManagedReconciliationCallerActive(requestSignal)
          const current = await rollback.readRolledBackRoot()
          requireManagedReconciliationCallerActive(requestSignal)
          if (current === undefined) {
            return failManagedReconciliationSession()
          }
          return createManagedRolledBackTerminalBinding(
            graph,
            current.persistenceVersion,
            current.rootDigest,
            current.appliedRootDigest,
            current.finishedAt,
            markerSeal.markerCount,
          )
        },
      })
    }
    const rollback = this.createPartialRollbackOperationPort(
      graph.executionBoundary,
      graph.sealedPlanningAuthority,
      graph.closedWriterFenceRecord,
      graph.executionRun,
    )
    requireManagedReconciliationCallerActive(signal)
    const lifecycle = await rollback.readRollbackLifecycle()
    requireManagedReconciliationCallerActive(signal)
    const root = lifecycle?.rolledBackRoot
    const seal = lifecycle?.startRoot.origin.seal
    if (
      lifecycle === undefined ||
      root === undefined ||
      seal === undefined ||
      root.originDigest !== lifecycle.startRoot.originDigest ||
      seal.markerCount <= 0 ||
      seal.markerCount >= graph.sealedPlanningAuthority.planOperationCount
    ) {
      return failManagedReconciliationSession()
    }
    const markerSeal = createManagedReconciliationMarkerSeal(
      seal.markerCount,
      seal.applyMarkerAggregateDigest,
    )
    const binding = createManagedRolledBackTerminalBinding(
      graph,
      root.persistenceVersion,
      root.rootDigest,
      root.originDigest,
      root.finishedAt,
      markerSeal.markerCount,
    )
    return Object.freeze({
      binding,
      markerSeal,
      readBinding: async (requestSignal: AbortSignal) => {
        requireManagedReconciliationCallerActive(requestSignal)
        const current = await rollback.readRollbackLifecycle()
        requireManagedReconciliationCallerActive(requestSignal)
        const currentRoot = current?.rolledBackRoot
        if (currentRoot === undefined) {
          return failManagedReconciliationSession()
        }
        return createManagedRolledBackTerminalBinding(
          graph,
          currentRoot.persistenceVersion,
          currentRoot.rootDigest,
          currentRoot.originDigest,
          currentRoot.finishedAt,
          markerSeal.markerCount,
        )
      },
    })
  }

  /**
   * Reconstructs the exact source-session digest carried by target audits.
   *
   * @param configurationHash - Current measured six-table configuration hash.
   * @returns Expected commit, key, resource, and source-session bindings.
   */
  private readManagedReconciliationTargetSourceBinding(
    configurationHash: string,
  ): ManagedReconciliationTargetSourceBinding {
    const binding = this.readRehearsalEvidenceSessionBinding()
    const sourceResourceBindingDigest = this.requestedResourcesBinding
    return Object.freeze({
      commit: binding.commit,
      configurationHash,
      evidenceKeyDigest: binding.evidenceKeyDigest,
      sourceResourceBindingDigest,
      sourceSessionBindingDigest: createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-target-source-session',
        version: 1,
        sourceResourceBindingDigest,
        binding,
      }),
    })
  }

  /**
   * Reads the immutable secret-free stage head claimed before rate mutation.
   *
   * @returns Detached frozen claimed head, or undefined when claim was omitted.
   */
  readRehearsalClaimedStageHead():
    WorkspaceSearchMigrationRehearsalStageHead | undefined {
    this.requireOpen()
    const guard = this.rehearsalGuard
    if (guard === undefined) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    requireNonProductionRehearsalPermitActive(guard)
    const head = this.claimedRehearsalStageHead
    return head === undefined ? undefined : cloneRehearsalStageHead(head)
  }

  /**
   * Takes the oldest unread secret-free durable lease projection.
   *
   * @returns Frozen exact acquisition/reuse projection, or undefined when empty.
   */
  takeRehearsalLeaseAcquisitionObservation():
    WorkspaceSearchMigrationDurableLeaseAcquisitionObservation | undefined {
    this.requireOpen()
    const guard = this.rehearsalGuard
    if (guard === undefined) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    requireNonProductionRehearsalPermitActive(guard)
    const observation =
      this.pendingRehearsalLeaseAcquisitionObservations.shift()
    return observation === undefined
      ? undefined
      : cloneDurableLeaseObservation(observation)
  }

  /**
   * Takes the oldest unread strict authority-adoption projection.
   *
   * @returns Frozen renewal position and receipt digest, or undefined.
   */
  takeRehearsalAuthorityAdoptionObservation():
    WorkspaceSearchMigrationRehearsalExpectedAuthority | undefined {
    this.requireOpen()
    const guard = this.rehearsalGuard
    if (guard === undefined) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    requireNonProductionRehearsalPermitActive(guard)
    const observation =
      this.pendingRehearsalAuthorityAdoptionObservations.shift()
    return observation === undefined
      ? undefined
      : cloneRehearsalAuthorityAdoptionObservation(observation)
  }

  /**
   * Takes the oldest unread cursor-free runtime fault observation.
   *
   * @returns Frozen exact observation, or undefined when empty.
   */
  takeRehearsalFaultObservation():
    WorkspaceSearchMigrationRehearsalFaultObservation | undefined {
    this.requireOpen()
    const guard = this.rehearsalGuard
    if (guard === undefined) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    requireNonProductionRehearsalPermitActive(guard)
    const observation = this.pendingRehearsalFaultObservations.shift()
    return observation === undefined
      ? undefined
      : cloneRehearsalFaultObservation(observation)
  }

  /**
   * Records one adapter-proven lease observation and suppresses duplicates.
   *
   * @param observation - Frozen secret-free acquisition/reuse projection.
   * @param generation - Measurement generation owning the acquisition.
   * @returns Whether this session queued a previously unseen acquisition.
   */
  private recordRehearsalLeaseAcquisitionObservation(
    observation:
      WorkspaceSearchMigrationDurableLeaseAcquisitionObservation,
    generation: number,
  ): boolean {
    this.requireGeneration(generation)
    const detached = cloneDurableLeaseObservation(observation)
    this.rehearsalLeaseIdentityDigest = detached.kind === 'acquired'
      ? detached.successorLeaseIdentityDigest
      : detached.currentLeaseIdentityDigest
    const digest = createMigrationDigest({
      kind: 'workspace-search-rehearsal-durable-lease-observation',
      generation,
      observation: detached,
    })
    if (this.observedRehearsalLeaseAcquisitionDigests.has(digest)) {
      return false
    }
    this.observedRehearsalLeaseAcquisitionDigests.add(digest)
    this.pendingRehearsalLeaseAcquisitionObservations.push(detached)
    return true
  }

  /**
   * Records one writer-codec-proven authority-adoption receipt exactly once.
   *
   * Exact idempotent rereads are suppressed. A digest reused at another
   * renewal position, a position reused by another digest, or a newly observed
   * non-consecutive successor fails closed before stage material can consume
   * the projection.
   *
   * @param observation - Strict renewal position and immutable receipt digest.
   * @param authority - Measured generation owning the admitted execution.
   */
  private recordRehearsalAuthorityAdoptionObservation(
    observation: WorkspaceSearchMigrationRehearsalExpectedAuthority,
    authority: ManagedApplyOperationAuthority,
  ): void {
    if (this.rehearsalGuard === undefined) return
    this.requireManagedApplyOperationAuthority(authority)
    const detached = cloneRehearsalAuthorityAdoptionObservation(observation)
    const count = detached.maintenanceEvidenceRenewalCount
    const digest = detached.receiptDigest
    const existingCount =
      this.observedRehearsalAuthorityAdoptionDigests.get(digest)
    if (existingCount !== undefined) {
      if (existingCount !== count) return failManagedApplyOperation()
      return
    }
    const existingDigest =
      this.observedRehearsalAuthorityAdoptionRenewals.get(count)
    if (existingDigest !== undefined) return failManagedApplyOperation()
    const highest = this.highestRehearsalAuthorityAdoptionRenewalCount
    if (highest !== undefined && count !== highest + 1) {
      return failManagedApplyOperation()
    }
    this.requireManagedApplyOperationAuthority(authority)
    this.observedRehearsalAuthorityAdoptionDigests.set(digest, count)
    this.observedRehearsalAuthorityAdoptionRenewals.set(count, digest)
    this.highestRehearsalAuthorityAdoptionRenewalCount = count
    this.pendingRehearsalAuthorityAdoptionObservations.push(detached)
  }

  /**
   * Parses one candidate row with the writer-owned strict adoption codec.
   *
   * @param binding - Exact measured admitted-run audit binding.
   * @param item - Candidate low-level authority-adoption row.
   * @param authority - Measured generation owning the row read or write.
   */
  private recordRehearsalAuthorityAdoptionItem(
    binding: WorkspaceSearchMigrationApplyAuditBindingInput,
    item: Readonly<Record<string, AttributeValue>>,
    authority: ManagedApplyOperationAuthority,
  ): void {
    if (this.rehearsalGuard === undefined) return
    const parsed = parseWorkspaceSearchMigrationApplyAuthorityAuditRecord(
      binding,
      item,
    )
    if (parsed === undefined) return failManagedApplyOperation()
    this.recordRehearsalAuthorityAdoptionObservation({
      maintenanceEvidenceRenewalCount:
        parsed.receipt.maintenanceEvidenceRenewalCount,
      receiptDigest: parsed.receipt.receiptDigest,
    }, authority)
  }

  /**
   * Observes an exact adoption-key GetItem response after all-six guarding.
   *
   * @param command - Adapter-owned exact strongly consistent point read.
   * @param output - Guarded low-level response returned to the writer adapter.
   * @param binding - Exact measured admitted-run audit binding.
   * @param authority - Measured generation owning the read.
   */
  private recordRehearsalAuthorityAdoptionRead(
    command: GetItemCommand,
    output: GetItemCommandOutput,
    binding: WorkspaceSearchMigrationApplyAuditBindingInput,
    authority: ManagedApplyOperationAuthority,
  ): void {
    if (this.rehearsalGuard === undefined) return
    const recordKey = command.input.Key?.recordKey?.S
    if (
      typeof recordKey !== 'string' ||
      !recordKey.startsWith(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_AUTHORITY_ADOPTION_KEY_PREFIX,
      )
    ) return
    if (output.Item === undefined) return
    this.recordRehearsalAuthorityAdoptionItem(
      binding,
      output.Item,
      authority,
    )
  }

  /**
   * Observes the sole strict adoption Put after a guarded transaction succeeds.
   *
   * @param command - Adapter-owned fixed-shape apply transaction.
   * @param binding - Exact measured admitted-run audit binding.
   * @param authority - Measured generation owning the write.
   */
  private recordRehearsalAuthorityAdoptionWrite(
    command: TransactWriteItemsCommand,
    binding: WorkspaceSearchMigrationApplyAuditBindingInput,
    authority: ManagedApplyOperationAuthority,
  ): void {
    if (this.rehearsalGuard === undefined) return
    let candidate: Readonly<Record<string, AttributeValue>> | undefined
    for (const item of command.input.TransactItems ?? []) {
      const put = item.Put?.Item
      const recordKey = put?.recordKey?.S
      if (
        put === undefined ||
        typeof recordKey !== 'string' ||
        !recordKey.startsWith(
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_AUTHORITY_ADOPTION_KEY_PREFIX,
        )
      ) continue
      if (candidate !== undefined) return failManagedApplyOperation()
      candidate = put
    }
    if (candidate === undefined) return
    this.recordRehearsalAuthorityAdoptionItem(
      binding,
      candidate,
      authority,
    )
  }

  /**
   * Records one selected adapter-proven runtime fault observation.
   *
   * @param observation - Cursor-free strong-read evidence for the fault.
   * @param generation - Measurement generation owning the observation.
   * @param configurationHash - Current measured configuration authority.
   */
  private recordRehearsalFaultObservation(
    observation: WorkspaceSearchMigrationRehearsalFaultObservation,
    generation: number,
    configurationHash: string,
  ): void {
    this.requireMeasurementGeneration(generation, configurationHash)
    const detached = cloneRehearsalFaultObservation(observation)
    if (
      detached.leaseIdentityDigest !==
        this.rehearsalLeaseIdentityDigest ||
      (detached.closedWriterFenceRecordDigest !== null &&
        detached.closedWriterFenceRecordDigest !==
          this.rehearsalClosedWriterFenceRecordDigest)
    ) {
      return failSourceScanAws('INVALID_STATE')
    }
    const digest = createMigrationDigest({
      kind: 'workspace-search-rehearsal-fault-observation',
      generation,
      configurationHash,
      observation: detached,
    })
    this.requireMeasurementGeneration(generation, configurationHash)
    if (this.observedRehearsalFaultObservationDigests.has(digest)) {
      return
    }
    this.observedRehearsalFaultObservationDigests.add(digest)
    this.pendingRehearsalFaultObservations.push(detached)
  }

  /**
   * Retains the one closed writer-fence digest authorized by this generation.
   *
   * @param digest - Adapter-validated closed writer-fence record digest.
   * @param generation - Measurement generation owning the record.
   * @param configurationHash - Current measured configuration authority.
   */
  private recordRehearsalClosedWriterFenceRecordDigest(
    digest: string,
    generation: number,
    configurationHash: string,
  ): void {
    if (
      this.rehearsalGuard === undefined &&
      this.rehearsalFaultController === undefined
    ) return
    this.requireMeasurementGeneration(generation, configurationHash)
    if (!isHexDigest(digest)) return failSourceScanAws('INVALID_STATE')
    const existing = this.rehearsalClosedWriterFenceRecordDigest
    if (existing !== undefined && existing !== digest) {
      return failSourceScanAws('INVALID_STATE')
    }
    this.rehearsalClosedWriterFenceRecordDigest = digest
    this.requireMeasurementGeneration(generation, configurationHash)
  }

  /**
   * Creates an immutable child-artifact publisher from this rehearsal session.
   *
   * Every new publication is admitted against the current permit and optional
   * claimed-stage reservation, while HEAD reconciliation belonging to an
   * already admitted Put may drain after expiry. Bucket, owner, Region, and
   * KMS identity remain fixed by the measured session.
   *
   * @param input - Trusted clock and finite S3 request deadline.
   * @returns Digest-only publisher bound to this non-production journal.
   */
  createRehearsalArtifactPublisher(
    input: Pick<
      CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput,
      'clock' | 'requestTimeoutMilliseconds'
    >,
  ): WorkspaceSearchMigrationRehearsalArtifactAwsPublisher {
    this.requireOpen()
    const guard = this.rehearsalGuard
    if (
      guard === undefined ||
      this.measuredConfigurationHash === undefined ||
      this.measuredConfiguration === undefined
    ) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    this.requireRehearsalAdmissionActive()
    let clock:
      CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput[
        'clock'
      ]
    let requestTimeoutMilliseconds: number
    try {
      clock = input.clock
      requestTimeoutMilliseconds = input.requestTimeoutMilliseconds
    } catch {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    const transport = this.transport
    /** Rejects borrowed artifact-publication I/O after the owner closes. */
    const requireOwningSessionOpen = (): void => this.requireOpen()
    return createWorkspaceSearchMigrationRehearsalArtifactAwsPublisher({
      account: this.account,
      bucketName: this.journalBucket,
      clock,
      kmsKeyArn: this.journalKeyArn,
      region: this.requested.region,
      requestTimeoutMilliseconds,
      sessionBinding: this.readRehearsalEvidenceSessionBinding(),
      transport: {
        admitNewArtifactPublication: (): void => {
          requireOwningSessionOpen()
          this.requireRehearsalAdmissionActive()
        },
        putArtifact: async (command, abortSignal) => {
          requireOwningSessionOpen()
          const result = await transport.putImmutableArtifact(
            command,
            abortSignal,
          )
          requireOwningSessionOpen()
          return result
        },
        headArtifact: async (command, abortSignal) => {
          requireOwningSessionOpen()
          const result = await transport.headImmutableArtifact(
            command,
            abortSignal,
          )
          requireOwningSessionOpen()
          return result
        },
        close: (): void => undefined,
      },
    })
  }

  /**
   * Creates an immutable evidence publisher from the authenticated rehearsal.
   *
   * The publisher borrows this session's pinned S3 client and cannot select a
   * different account, bucket, Region, or KMS key. Callers must close the
   * publisher before closing the owning session. Every new publication is
   * admitted while the permit and optional claimed-stage reservation are
   * active; exact HEAD reconciliation belonging to an admitted Put may drain
   * after expiry.
   *
   * @param input - Trusted clock and finite S3 request deadline.
   * @returns Publisher bound to the measured non-production journal identity.
   */
  createRehearsalEvidencePublisher(
    input: Pick<
      CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput,
      'clock' | 'requestTimeoutMilliseconds'
    >,
  ): WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher {
    this.requireOpen()
    const guard = this.rehearsalGuard
    if (
      guard === undefined ||
      this.measuredConfigurationHash === undefined ||
      this.measuredConfiguration === undefined
    ) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    this.requireRehearsalAdmissionActive()
    let clock:
      CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput[
        'clock'
      ]
    let requestTimeoutMilliseconds: number
    try {
      clock = input.clock
      requestTimeoutMilliseconds = input.requestTimeoutMilliseconds
    } catch {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    const transport = this.transport
    /** Rejects borrowed evidence-publication I/O after the owner closes. */
    const requireOwningSessionOpen = (): void => {
      this.requireOpen()
    }
    const publisher =
      createWorkspaceSearchMigrationRehearsalEvidenceAwsPublisher({
        account: this.account,
        bucketName: this.journalBucket,
        clock,
        kmsKeyArn: this.journalKeyArn,
        region: this.requested.region,
        requestTimeoutMilliseconds,
        sessionBinding: this.readRehearsalEvidenceSessionBinding(),
        transport: {
          putEvidence: async (command, abortSignal) => {
            requireOwningSessionOpen()
            const result = await transport.putImmutableArtifact(
              command,
              abortSignal,
            )
            requireOwningSessionOpen()
            return result
          },
          headEvidence: async (command, abortSignal) => {
            requireOwningSessionOpen()
            const result = await transport.headImmutableArtifact(
              command,
              abortSignal,
            )
            requireOwningSessionOpen()
            return result
          },
          close: (): void => undefined,
        },
      })
    return Object.freeze({
      publishEvidence: async (
        evidenceInput:
          PublishWorkspaceSearchMigrationRehearsalEvidenceInput,
      ) => {
        this.requireOpen()
        this.requireRehearsalAdmissionActive()
        return await publisher.publishEvidence(evidenceInput)
      },
      close: (): void => publisher.close(),
    })
  }

  /**
   * Reads the digest-only evidence binding owned by this measured rehearsal.
   *
   * @returns Frozen permit, caller, resource, commit, and configuration facts.
   */
  readRehearsalEvidenceSessionBinding():
    CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput[
      'sessionBinding'
    ] {
    this.requireOpen()
    const guard = this.rehearsalGuard
    const configurationHash = this.measuredConfigurationHash
    if (guard === undefined || configurationHash === undefined) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    requireNonProductionRehearsalPermitActive(guard)
    return createNonProductionRehearsalEvidenceSessionBinding(
      guard,
      this.requested.commit,
      this.requestedResourcesBinding,
      configurationHash,
    )
  }

  /**
   * Reads the authenticated interval containing the complete rehearsal suite.
   *
   * The permit is revalidated at this admission boundary. The detached result
   * is used only by the final publication orchestrator and is not added to the
   * externally published digest-only evidence index.
   *
   * @returns Frozen exact inclusive issue and exclusive expiry timestamps.
   */
  readRehearsalPermitValidity():
    WorkspaceSearchMigrationRehearsalPermitValidity {
    this.requireOpen()
    const guard = this.rehearsalGuard
    if (guard === undefined) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    requireNonProductionRehearsalPermitActive(guard)
    return Object.freeze({
      issuedAt: guard.permit.issuedAt,
      expiresAt: guard.permit.expiresAt,
    })
  }

  /**
   * Measures identity against the same snapshot that configured every client
   * and lookup allowlist.
   *
   * @returns Exact measured migration configuration.
   */
  async measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration> {
    this.requireNewAwsAdmission()
    const rate = this.describeTableRate
    if (rate === undefined) {
      return await this.measureConfigurationWithinRateGate()
    }
    return await rate.runNonPageOperation(
      async () => await this.measureConfigurationWithinRateGate(),
    )
  }

  /** Measures all six identities while the caller owns any configured gate. */
  private async measureConfigurationWithinRateGate():
    Promise<WorkspaceSearchMigrationConfiguration> {
    this.requireOpen()
    this.generation += 1
    const measurementGeneration = this.generation
    this.measuredConfigurationHash = undefined
    this.measuredConfiguration = undefined
    this.invalidateManagedPlanningArtifactPort()
    this.measuredMigrationStateTable = undefined
    this.measuredExecutionControlQuarantined = false
    this.pendingRehearsalLeaseAcquisitionObservations.splice(0)
    this.observedRehearsalLeaseAcquisitionDigests.clear()
    this.pendingRehearsalAuthorityAdoptionObservations.splice(0)
    this.observedRehearsalAuthorityAdoptionDigests.clear()
    this.observedRehearsalAuthorityAdoptionRenewals.clear()
    this.highestRehearsalAuthorityAdoptionRenewalCount = undefined
    this.pendingRehearsalFaultObservations.splice(0)
    this.observedRehearsalFaultObservationDigests.clear()
    this.rehearsalLeaseIdentityDigest = undefined
    this.rehearsalClosedWriterFenceRecordDigest = undefined
    const configuration = await measureWorkspaceSearchMigrationConfiguration({
      requested: this.requested,
      port: this,
    })
    this.requireGeneration(measurementGeneration)
    const configurationHash =
      createWorkspaceSearchConfigurationHash(configuration)
    const measuredConfiguration = structuredClone(configuration)
    const stateTable = structuredClone(
      measuredConfiguration.tables['migration-state'],
    )
    const planningArtifactAbortController = new AbortController()
    const planningArtifactPort =
      this.createManagedPlanningArtifactPort(
        measuredConfiguration,
        {
          generation: measurementGeneration,
          configurationHash,
        },
        planningArtifactAbortController.signal,
      )
    this.requireGeneration(measurementGeneration)
    this.measuredMigrationStateTable = stateTable
    this.measuredPlanningArtifactPort = planningArtifactPort
    this.measuredPlanningArtifactAbortController =
      planningArtifactAbortController
    this.measuredConfiguration = measuredConfiguration
    this.measuredConfigurationHash = configurationHash
    return configuration
  }

  /**
   * Validates one planning epoch and deadline in the measured generation.
   *
   * @param input - Reviewed epoch, exact deadline, and pre-write runway.
   * @returns Exact accepted canonical retention deadline.
   */
  validatePlanningArtifactPreflight(
    input:
      ValidateWorkspaceSearchMigrationPlanningArtifactPreflightInput,
  ): string {
    const request =
      detachManagedPlanningArtifactPreflightInput(input)
    const authority =
      this.captureManagedPlanningArtifactPreflightAuthority()
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      )
    ) {
      return failManagedPlanningArtifactPreflight('INVALID_STATE')
    }
    const currentTime = readManagedPlanningArtifactPreflightClock(
      this.prePlanAuthorityClock,
    )
    const accepted =
      hasWorkspaceSearchMigrationImmutableArtifactRetentionHeadroom(
        request.retainUntil,
        authority.configuration,
        WORKSPACE_SEARCH_MIGRATION_MANAGED_ARTIFACT_REQUEST_TIMEOUT_MILLISECONDS,
        currentTime,
        request.minimumAdditionalHeadroomMilliseconds,
      )
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      )
    ) {
      return failManagedPlanningArtifactPreflight('INVALID_STATE')
    }
    if (!accepted) {
      return failManagedPlanningArtifactPreflight('INVALID_ARGUMENT')
    }
    if (
      Date.parse(request.reviewedDryRunCompletedAt) >
        Date.prototype.getTime.call(currentTime)
    ) {
      return failManagedPlanningArtifactPreflight(
        'DRY_RUN_INVALID_ROWS',
      )
    }
    return request.retainUntil
  }

  /**
   * Creates one run-scoped planning gateway over the current measured port.
   *
   * @param runId - Operator-selected run owning every immutable object.
   * @returns Generation-guarded planning graph storage gateway.
   */
  createPlanningArtifactGateway(
    runId: string,
  ): WorkspaceSearchMigrationPlanningArtifactAwsGateway {
    const authority = this.captureManagedPlanningArtifactAuthority()
    const delegate =
      createAwsWorkspaceSearchMigrationPlanningArtifactGateway({
        runId,
        configurationHash: authority.configurationHash,
        immutableArtifactPort: authority.immutableArtifactPort,
      })
    const managedGateway:
      WorkspaceSearchMigrationPlanningArtifactAwsGateway = {
        /**
         * Uploads one reviewed plan while the captured measurement is current.
         *
         * @param input - Reviewed plan graph and shared retention deadline.
         * @returns Exact immutable plan roots.
         */
        writePlanArtifact: (input) =>
          this.runNewManagedPlanningArtifactOperation(
            authority,
            () => delegate.writePlanArtifact(input),
          ),

        /**
         * Replays one exact-version plan while measurement stays current.
         *
         * @param input - Exact immutable plan roots.
         * @returns Detached and validated plan graph.
         */
        replayPlanArtifact: (input) =>
          this.runNewManagedPlanningArtifactOperation(
            authority,
            () => delegate.replayPlanArtifact(input),
          ),

        /**
         * Uploads one complete provenance graph under measured authority.
         *
         * @param input - Strict provenance material and packing limits.
         * @returns Exact immutable provenance root.
         */
        writePlanningProvenanceArtifact: (input) =>
          this.runNewManagedPlanningArtifactOperation(
            authority,
            () => delegate.writePlanningProvenanceArtifact(input),
          ),

        /**
         * Replays one exact-version provenance graph under measured authority.
         *
         * @param input - Exact immutable provenance root.
         * @returns Detached and validated provenance artifact.
         */
        replayPlanningProvenanceArtifact: (input) =>
          this.runNewManagedPlanningArtifactOperation(
            authority,
            () => delegate.replayPlanningProvenanceArtifact(input),
          ),
      }
    return managedGateway
  }

  /**
   * Creates one atomic publication port bound to the current measurement.
   *
   * @returns Generation-guarded sealed planning authority publication port.
   */
  createSealedPlanningAuthorityPort():
    WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort {
    const authority = this.captureManagedSealedPlanningAuthority()
    const transport:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsTransport = {
        getSealedPlanningAuthority: (command) =>
          this.runManagedSealedPlanningAuthorityRead(
            authority,
            () => this.transport.getPrePlanAuthority(command),
          ),
        prepareSealedPlanningAuthorityWrite: async () => {
          await this.requireCurrentSealedPlanningAuthorityTableIncarnations(
            authority,
          )
        },
        transactWriteSealedPlanningAuthority: (command) =>
          this.runManagedPreparedSealedPlanningAuthorityWrite(
            authority,
            () => this.transport.transactWritePrePlanAuthority(command),
          ),
      }
    const delegate =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        authority.stateTable,
        authority.configurationHash,
        transport,
        this.prePlanAuthorityClock,
      )
    return {
      read: (runId) =>
        this.runManagedSealedPlanningAuthorityOperation(
          authority,
          () => delegate.read(runId),
        ),
      publish: (input) =>
        this.runManagedSealedPlanningAuthorityOperation(
          authority,
          () => delegate.publish(input),
        ),
    }
  }

  /**
   * Creates one writer-fence lifecycle port bound to the current measured
   * generation and all six physical table incarnations.
   *
   * @returns Generation-guarded bootstrap, read, and release capability.
   */
  createApplicationWriterFencePort():
    WorkspaceSearchMigrationManagedApplicationWriterFencePort {
    const authority = this.captureManagedApplicationWriterFenceAuthority()
    const transport: WorkspaceSearchMigrationPrePlanAuthorityAwsTransport = {
      getPrePlanAuthority: (command) =>
        this.runManagedApplicationWriterFenceRead(
          authority,
          () => this.transport.getPrePlanAuthority(command),
        ),
      preparePrePlanAuthorityWrite: async () => {
        await this.requireCurrentApplicationWriterFenceTableIncarnations(
          authority,
        )
      },
      transactWritePrePlanAuthority: (command) =>
        this.runManagedPreparedApplicationWriterFenceWrite(
          authority,
          () => this.transport.transactWritePrePlanAuthority(command),
        ),
    }
    const delegate =
      createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
        authority.configuration,
        authority.configurationHash,
        transport,
        this.prePlanAuthorityClock,
    )
    return {
      bootstrapOpen: (
        currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
      ) =>
        this.runManagedApplicationWriterFenceOperation(
          authority,
          () => delegate.bootstrapOpen(currentAuthority),
        ),
      read: () =>
        this.runManagedApplicationWriterFenceOperation(
          authority,
          () => delegate.read(),
        ),
      release: (
        input:
          ReleaseWorkspaceSearchMigrationApplicationWriterFenceInput,
      ) =>
        this.runManagedApplicationWriterFenceOperation(
          authority,
          () => delegate.release(input),
        ),
    }
  }

  /**
   * Creates one atomic execution-boundary port bound to the current measured
   * generation and all six physical table incarnations.
   *
   * @returns Generation-guarded writer close and planning admission capability.
   */
  createExecutionBoundaryPort():
    WorkspaceSearchMigrationExecutionBoundaryAwsPort {
    const authority = this.captureManagedExecutionBoundaryAuthority()
    const transport: WorkspaceSearchMigrationExecutionBoundaryAwsTransport = {
      getExecutionBoundaryState: (command) =>
        this.runManagedApplicationWriterFenceRead(
          authority,
          () => this.transport.getPrePlanAuthority(command),
        ),
      prepareExecutionBoundaryWrite: async () => {
        await this.requireCurrentApplicationWriterFenceTableIncarnations(
          authority,
        )
      },
      transactWriteExecutionBoundary: (command) =>
        this.runManagedPreparedApplicationWriterFenceWrite(
          authority,
          () => this.transport.transactWritePrePlanAuthority(command),
        ),
    }
    const delegate =
      createAwsWorkspaceSearchMigrationExecutionBoundaryPort(
        authority.configuration,
        authority.configurationHash,
        transport,
        this.prePlanAuthorityClock,
      )
    return {
      read: (runId) =>
        this.runManagedExecutionBoundaryOperation(
          authority,
          () => delegate.read(runId),
        ),
      close: async (currentAuthority) => {
        const result = await this.runManagedExecutionBoundaryOperation(
          authority,
          () => delegate.close(currentAuthority),
        )
        this.recordRehearsalClosedWriterFenceRecordDigest(
          result.closedWriterFenceRecordDigest,
          authority.generation,
          authority.configurationHash,
        )
        return result
      },
      admitPlanning: async (input) => {
        const result = await this.runManagedExecutionBoundaryOperation(
          authority,
          () => delegate.admitPlanning(input),
        )
        this.recordRehearsalClosedWriterFenceRecordDigest(
          result.closedWriterFenceRecordDigest,
          authority.generation,
          authority.configurationHash,
        )
        return result
      },
    }
  }

  /**
   * Creates one atomic execution-run admission port bound to the current
   * measured generation and all six physical table incarnations.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param planSeal - Exact canonical plan seal referenced by the root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @returns Generation-guarded execution-run create/read capability.
   */
  createExecutionRunPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    planSeal: WorkspaceSearchPlanSeal,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
  ): WorkspaceSearchMigrationExecutionRunAwsPort {
    const authority = this.captureManagedExecutionRunAuthority()
    const transport: WorkspaceSearchMigrationExecutionRunAwsTransport = {
      getExecutionRunState: (command) =>
        this.runManagedExecutionRunRead(
          authority,
          () => this.transport.getPrePlanAuthority(command),
        ),
      prepareExecutionRunWrite: async () => {
        await this.requireCurrentExecutionRunTableIncarnations(
          authority,
        )
      },
      transactWriteExecutionRun: (command) =>
        this.runManagedPreparedExecutionRunWrite(
          authority,
          () => this.transport.transactWritePrePlanAuthority(command),
        ),
    }
    const delegate =
      createAwsWorkspaceSearchMigrationExecutionRunPort({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        executionBoundary,
        sealedPlanningAuthority,
        planSeal,
        closedWriterFenceRecord,
        transport,
        clock: this.prePlanAuthorityClock,
      })
    return {
      read: (runId) =>
        this.runManagedExecutionRunOperation(
          authority,
          () => delegate.read(runId),
        ),
      create: (currentAuthority) =>
        this.runManagedExecutionRunOperation(
          authority,
          () => delegate.create(currentAuthority),
      ),
    }
  }

  /**
   * Creates one atomic apply progress port bound to the current measured
   * generation, all six physical table incarnations, private journal storage,
   * and strongly consistent source/target checkpoint scans.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Generation-guarded apply/checkpoint reconciliation capability.
   */
  createApplyOperationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationApplyOperationAwsPort {
    const authority = this.captureManagedApplyOperationAuthority()
    this.recordRehearsalClosedWriterFenceRecordDigest(
      closedWriterFenceRecord.recordDigest,
      authority.generation,
      authority.configurationHash,
    )
    let rehearsalApplyCheckpointTarget:
      WorkspaceSearchMigrationRehearsalApplyCheckpointTarget | undefined
    let delegate: WorkspaceSearchMigrationApplyOperationAwsPort | undefined
    let detachedExecutionRun: WorkspaceSearchMigrationExecutionRun
    try {
      detachedExecutionRun =
        parseWorkspaceSearchMigrationExecutionRun(
          serializeWorkspaceSearchMigrationExecutionRun(executionRun),
        )
    } catch {
      return failManagedApplyOperation()
    }
    const auditBinding: WorkspaceSearchMigrationApplyAuditBindingInput = {
      configuration: authority.configuration,
      configurationHash: authority.configurationHash,
      executionBoundary,
      sealedPlanningAuthority,
      closedWriterFenceRecord,
      executionRun: detachedExecutionRun,
    }
    const immutableArtifactPort =
      this.createManagedApplyImmutableArtifactPort(authority)
    const journalGateway =
      createAwsWorkspaceSearchMigrationJournalGateway({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        runId: detachedExecutionRun.runId,
        immutableArtifactPort,
        clock: this.prePlanAuthorityClock,
      })
    const applySealGateway =
      createAwsWorkspaceSearchMigrationApplySealGateway({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        runId: detachedExecutionRun.runId,
        immutableArtifactPort,
        clock: this.prePlanAuthorityClock,
      })
    const prePlanAuthorityAdapter =
      this.createManagedPrePlanAuthorityAdapter(authority)
    const authorityPort:
      WorkspaceSearchMigrationApplyOperationAuthorityPort = {
        readAuthority: (claim) =>
          this.runManagedApplyOperationRead(
            authority,
            () => prePlanAuthorityAdapter.readAuthority(claim),
          ),
      }
    const checkpointScanner:
      WorkspaceSearchMigrationApplyCheckpointScanner = {
        scanApplyCheckpointPage: async ({
          location,
          previousCheckpoint,
        }) => {
          const checkpoint = await this.runManagedApplyOperationRead(
            authority,
            async () => {
              if (location === 'target') {
                const targetPredecessor =
                  createWorkspaceSearchMigrationApplyTargetScanPredecessor({
                    configuration: authority.configuration,
                    configurationHash: authority.configurationHash,
                    previousCheckpoint,
                  })
                const pageResult = await this.scanTargetPage({
                  configuration: authority.configuration,
                  configurationHash: authority.configurationHash,
                  previousCheckpoint: targetPredecessor,
                })
                return reduceWorkspaceSearchMigrationApplyTargetScanPage({
                  configuration: authority.configuration,
                  configurationHash: authority.configurationHash,
                  previousCheckpoint,
                  pageResult,
                }).checkpoint
              }
              return (
                await this.scanSourcePage({
                  configuration: authority.configuration,
                  configurationHash: authority.configurationHash,
                  source: location,
                  previousCheckpoint,
                })
              ).checkpoint
            },
          )
          if (checkpoint.cursor !== undefined) {
            rehearsalApplyCheckpointTarget = {
              kind: 'apply-checkpoint',
              location,
              pageSequence: checkpoint.aggregate.pageCount,
              cursorState: 'present',
            }
            await this.reachRehearsalApplyCheckpointFault(
              'apply-checkpoint-cursor-captured-before-commit',
              rehearsalApplyCheckpointTarget,
              authority,
              async () => {
                const reader = delegate
                if (reader === undefined) {
                  return failManagedApplyOperation()
                }
                return await reader.readRunState()
              },
            )
          }
          return checkpoint
        },
    }
    const transport:
      WorkspaceSearchMigrationApplyOperationAwsTransport = {
        getApplyItem: async (command) => {
          const output = await this.runManagedApplyOperationRead(
            authority,
            () => this.transport.getPrePlanAuthority(command),
          )
          this.recordRehearsalAuthorityAdoptionRead(
            command,
            output,
            auditBinding,
            authority,
          )
          return output
        },
        prepareApplyWrite: async () => {
          await this.requireCurrentApplyOperationTableIncarnations(
            authority,
          )
        },
        transactWriteApply: async (command) => {
          const output = await this.runManagedPreparedApplyOperationWrite(
            authority,
            async () => {
              const result =
                await this.transport.transactWritePrePlanAuthority(
                  command,
                )
              const target = rehearsalApplyCheckpointTarget
              if (target !== undefined) {
                await this.reachRehearsalApplyCheckpointFault(
                  'apply-checkpoint-cursor-committed-before-return',
                  target,
                  authority,
                  async () => {
                    const reader = delegate
                    if (reader === undefined) {
                      return failManagedApplyOperation()
                    }
                    return await reader.readRunState()
                  },
                )
              }
              return result
            },
          )
          this.recordRehearsalAuthorityAdoptionWrite(
            command,
            auditBinding,
            authority,
          )
          return output
        },
      }
    const operationDelegate =
      createAwsWorkspaceSearchMigrationApplyOperationPort({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        executionBoundary,
        sealedPlanningAuthority,
        closedWriterFenceRecord,
        executionRun: detachedExecutionRun,
        authorityPort,
        journalGateway,
        applySealGateway,
        checkpointScanner,
        transport,
        clock: this.prePlanAuthorityClock,
      })
    delegate = operationDelegate
    return {
      readRunState: () =>
        this.runManagedApplyOperation(
          authority,
          () => operationDelegate.readRunState(),
        ),
      readAppliedRoot: () =>
        this.runManagedApplyOperation(
          authority,
          () => operationDelegate.readAppliedRoot(),
        ),
      readOperationMarker: (operationId) =>
        this.runManagedApplyOperation(
          authority,
          () => operationDelegate.readOperationMarker(operationId),
        ),
      readApplyReceipt: (sequence) =>
        this.runManagedApplyOperation(
          authority,
          () => operationDelegate.readApplyReceipt(sequence),
        ),
      adoptExecutionAuthority: (input) =>
        this.runManagedApplyOperation(
          authority,
          () => operationDelegate.adoptExecutionAuthority(input),
        ),
      commitApplyOperation: async (input) => {
        const result = await this.runManagedApplyOperation(
          authority,
          () => operationDelegate.commitApplyOperation(input),
        )
        if (
          result.status === 'applying' &&
          result.appliedOperationCount > 0 &&
          result.appliedOperationCount < result.planOperationCount
        ) {
          await this.reachRehearsalApplyOperationFault({
            kind: 'apply-operation',
            planSequence: result.appliedOperationCount,
            remainingOperations: 'present',
          }, result, authority, async () => {
            const reader = delegate
            if (reader === undefined) return failManagedApplyOperation()
            return await reader.readRunState()
          })
        }
        return result
      },
      saveApplyCheckpoint: async (input) => {
        const snapshot = snapshotManagedRateGateInput(
          input,
          () => createManagedApplyOperationFailure('INVALID_ARGUMENT'),
        )
        rehearsalApplyCheckpointTarget = undefined
        try {
          return await this.runManagedDescribeTableCheckpointPage(
            () => this.runManagedApplyOperation(
              authority,
              () => operationDelegate.saveApplyCheckpoint(snapshot),
            ),
          )
        } finally {
          rehearsalApplyCheckpointTarget = undefined
        }
      },
      sealApply: (input) =>
        this.runManagedApplyOperation(
          authority,
          () => operationDelegate.sealApply(input),
        ),
    }
  }

  /**
   * Creates one independently scanned, resumable full-verification port bound
   * to the current measured generation and every physical table incarnation.
   *
   * Exact plan, apply-seal, and verification-result objects all reuse the
   * current private immutable-object port. Raw source and target pages remain
   * private to this session and are reduced exactly once after one strong Scan.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Generation-guarded verification and publication capability.
   */
  createFullVerificationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationFullVerificationAwsPort {
    const authority = this.captureManagedFullVerificationAuthority()
    let detachedExecutionRun: WorkspaceSearchMigrationExecutionRun
    try {
      detachedExecutionRun =
        parseWorkspaceSearchMigrationExecutionRun(
          serializeWorkspaceSearchMigrationExecutionRun(executionRun),
        )
    } catch {
      return failManagedFullVerification()
    }
    const immutableArtifactPort =
      this.createManagedFullVerificationImmutableArtifactPort(authority)
    const planArtifactDelegate =
      createAwsWorkspaceSearchMigrationPlanningArtifactGateway({
        runId: detachedExecutionRun.runId,
        configurationHash: authority.configurationHash,
        immutableArtifactPort,
      })
    const planArtifactGateway:
      WorkspaceSearchMigrationFullVerificationPlanReplayGateway = {
        replayPlanArtifact: (input) =>
          planArtifactDelegate.replayPlanArtifact(input),
      }
    const applySealGateway =
      createAwsWorkspaceSearchMigrationApplySealGateway({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        runId: detachedExecutionRun.runId,
        immutableArtifactPort,
        clock: this.prePlanAuthorityClock,
      })
    const prePlanAuthorityAdapter =
      this.createManagedPrePlanAuthorityAdapter(authority)
    const authorityPort:
      WorkspaceSearchMigrationFullVerificationAuthorityPort = {
        readAuthority: (claim) =>
          this.runManagedFullVerificationRead(
            authority,
            () => prePlanAuthorityAdapter.readAuthority(claim),
          ),
      }
    let appliedRootDigest: string | undefined
    const appliedRootReader:
      WorkspaceSearchMigrationFullVerificationAppliedRootReader = {
        readAppliedRoot: () =>
          this.runManagedFullVerificationRead(
            authority,
            async () => {
              const root =
                parseWorkspaceSearchMigrationAppliedRootStrongReadOutput({
                  stateTable:
                    authority.configuration.tables['migration-state'],
                  configurationHash: authority.configurationHash,
                  executionRun: detachedExecutionRun,
                  output: await this.transport.getPrePlanAuthority(
                    createWorkspaceSearchMigrationAppliedRootStrongReadCommand({
                      stateTable:
                        authority.configuration.tables['migration-state'],
                      configurationHash: authority.configurationHash,
                      executionRun: detachedExecutionRun,
                    }),
                  ),
                })
              if (root !== undefined) {
                if (
                  appliedRootDigest !== undefined &&
                  appliedRootDigest !== root.rootDigest
                ) {
                  return failManagedFullVerification()
                }
                appliedRootDigest = root.rootDigest
              }
              return root
            },
          ),
      }
    const verificationResultGateway:
      WorkspaceSearchMigrationVerificationResultAwsGateway = {
        writeVerificationResultArtifact: (input) => {
          this.requireManagedFullVerificationAuthority(authority)
          if (appliedRootDigest === undefined) {
            return failManagedFullVerification()
          }
          return createAwsWorkspaceSearchMigrationVerificationResultGateway({
            runId: detachedExecutionRun.runId,
            configurationHash: authority.configurationHash,
            appliedRootDigest,
            immutableArtifactPort,
          }).writeVerificationResultArtifact(input)
        },
        replayVerificationResultArtifact: (reference) => {
          this.requireManagedFullVerificationAuthority(authority)
          if (appliedRootDigest === undefined) {
            return failManagedFullVerification()
          }
          return createAwsWorkspaceSearchMigrationVerificationResultGateway({
            runId: detachedExecutionRun.runId,
            configurationHash: authority.configurationHash,
            appliedRootDigest,
            immutableArtifactPort,
          }).replayVerificationResultArtifact(reference)
        },
      }
    const pageScanner:
      WorkspaceSearchMigrationFullVerificationPageScanner = {
        scanVerificationPage: (input) => {
          const plan = structuredClone(input.plan)
          const previousProgress =
            structuredClone(input.previousProgress)
          const location = input.location
          return this.runManagedFullVerificationRead(
            authority,
            async () => {
              if (location === 'target') {
                const reductionInput =
                  await this.captureTargetReductionInput(
                    {
                      configuration: authority.configuration,
                      configurationHash: authority.configurationHash,
                      previousCheckpoint:
                        createWorkspaceSearchMigrationApplyTargetScanPredecessor({
                          configuration: authority.configuration,
                          configurationHash: authority.configurationHash,
                          previousCheckpoint:
                            previousProgress.traversal.target,
                        }),
                    },
                    this.operationalAbortController.signal,
                  )
                return reduceWorkspaceSearchMigrationFullVerificationTargetPage({
                  plan,
                  progress: previousProgress,
                  configuration: authority.configuration,
                  configurationHash: authority.configurationHash,
                  page: reductionInput.page,
                })
              }
              const reductionInput =
                await this.captureSourceReductionInput({
                  configuration: authority.configuration,
                  configurationHash: authority.configurationHash,
                  source: location,
                  previousCheckpoint:
                    previousProgress.traversal.sources[location],
                })
              return reduceWorkspaceSearchMigrationFullVerificationSourcePage({
                plan,
                progress: previousProgress,
                configuration: authority.configuration,
                configurationHash: authority.configurationHash,
                source: location,
                page: reductionInput.page,
              })
            },
          )
        },
      }
    const transport:
      WorkspaceSearchMigrationFullVerificationAwsTransport = {
        getVerificationItem: (command) =>
          this.runManagedFullVerificationRead(
            authority,
            () => this.transport.getPrePlanAuthority(command),
          ),
        runVerificationReceiptChainRead: (operation) =>
          this.runManagedFullVerificationRead(
            authority,
            () =>
              operation((command) =>
                this.runManagedMigrationStateIo(
                  authority,
                  () =>
                    this.transport.getPrePlanAuthority(command),
                )
              ),
          ),
        prepareVerificationWrite: async () => {
          await this.requireCurrentFullVerificationTableIncarnations(
            authority,
          )
        },
        transactWriteVerification: (command) =>
          this.runManagedPreparedFullVerificationWrite(
            authority,
            () => this.transport.transactWritePrePlanAuthority(command),
          ),
      }
    const delegate =
      createAwsWorkspaceSearchMigrationFullVerificationPort({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        executionBoundary,
        sealedPlanningAuthority,
        closedWriterFenceRecord,
        executionRun: detachedExecutionRun,
        authorityPort,
        planArtifactGateway,
        applySealGateway,
        verificationResultGateway,
        appliedRootReader,
        pageScanner,
        transport,
        clock: this.prePlanAuthorityClock,
      })
    return {
      readProgress: () =>
        this.runManagedFullVerificationOperation(
          authority,
          () => delegate.readProgress(),
        ),
      readVerifiedRoot: () =>
        this.runManagedFullVerificationOperation(
          authority,
          () => delegate.readVerifiedRoot(),
        ),
      readVerifiedResult: () =>
        this.runManagedFullVerificationOperation(
          authority,
          () => delegate.readVerifiedResult(),
        ),
      saveVerificationPage: async (input) => {
        const snapshot = snapshotManagedRateGateInput(
          input,
          () => createManagedFullVerificationFailure('INVALID_ARGUMENT'),
        )
        return await this.runManagedDescribeTableCheckpointPage(
          () => this.runManagedFullVerificationOperation(
            authority,
            () => delegate.saveVerificationPage(snapshot),
          ),
        )
      },
      publishVerified: (input) =>
        this.runManagedFullVerificationOperation(
          authority,
          () => delegate.publishVerified(input),
        ),
    }
  }

  /**
   * Creates one committed-prefix rollback capability bound to the current
   * measured generation and shared execution-control quarantine.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Generation-guarded partial-start, reverse, and finish capability.
   */
  createPartialRollbackOperationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationManagedPartialRollbackAwsPort {
    try {
      return this.createManagedPartialRollbackOperationPort(
        executionBoundary,
        sealedPlanningAuthority,
        closedWriterFenceRecord,
        executionRun,
      )
    } catch (error: unknown) {
      throw createManagedRollbackOperationFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
  }

  /**
   * Composes committed-prefix start and reverse adapters over one private
   * measured transport and immutable-object capability.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Caller-safe managed committed-prefix rollback capability.
   */
  private createManagedPartialRollbackOperationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationManagedPartialRollbackAwsPort {
    const authority = this.captureManagedRollbackOperationAuthority()
    let detachedExecutionRun: WorkspaceSearchMigrationExecutionRun
    try {
      detachedExecutionRun =
        parseWorkspaceSearchMigrationExecutionRun(
          serializeWorkspaceSearchMigrationExecutionRun(executionRun),
        )
    } catch {
      return failManagedRollbackOperation()
    }
    const immutableArtifactPort =
      this.createManagedPartialRollbackImmutableArtifactPort(
        authority,
      )
    const committedPrefixSealGateway =
      createAwsWorkspaceSearchMigrationCommittedPrefixApplySealGateway({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        runId: detachedExecutionRun.runId,
        immutableArtifactPort,
        clock: this.prePlanAuthorityClock,
      })
    const journalGateway =
      createAwsWorkspaceSearchMigrationJournalGateway({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        runId: detachedExecutionRun.runId,
        immutableArtifactPort,
        clock: this.prePlanAuthorityClock,
      })
    const prePlanAuthorityAdapter =
      this.createManagedPrePlanAuthorityAdapter(authority)
    const authorityPort:
      WorkspaceSearchMigrationRollbackOperationAuthorityReader = {
        readAuthority: (claim) =>
          this.runManagedRollbackOperationRead(
            authority,
            () => prePlanAuthorityAdapter.readAuthority(claim),
          ),
      }
    const applyReceiptBinding =
      createWorkspaceSearchMigrationApplyReceiptAwsBinding({
        stateTable:
          authority.configuration.tables['migration-state'],
        configurationHash: authority.configurationHash,
        executionRun: detachedExecutionRun,
      })
    const startTransport:
      WorkspaceSearchMigrationPartialRollbackStartAwsTransport = {
        getPartialRollbackStartItem: (command) =>
          this.runManagedRollbackOperationRead(
            authority,
            () => this.transport.getPrePlanAuthority(command),
          ),
        preparePartialRollbackStartWrite: async () => {
          await this.requireCurrentRollbackOperationTableIncarnations(
            authority,
          )
        },
        transactWritePartialRollbackStart: (command) =>
          this.runManagedPreparedRollbackOperationWrite(
            authority,
            () => this.transport.transactWritePrePlanAuthority(command),
          ),
      }
    const lifecycle =
      createAwsWorkspaceSearchMigrationPartialRollbackStartPort({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        executionBoundary,
        sealedPlanningAuthority,
        closedWriterFenceRecord,
        executionRun: detachedExecutionRun,
        authorityPort,
        committedPrefixSealGateway,
        transport: startTransport,
        clock: this.prePlanAuthorityClock,
      })
    const operationTransport:
      WorkspaceSearchMigrationPartialRollbackOperationAwsTransport = {
        getPartialRollbackOperationItem: (command) =>
          this.runManagedRollbackOperationRead(
            authority,
            () => this.transport.getPrePlanAuthority(command),
          ),
        preparePartialRollbackOperationWrite: async () => {
          await this.requireCurrentRollbackOperationTableIncarnations(
            authority,
          )
        },
        transactWritePartialRollbackOperation: (command) =>
          this.runManagedPreparedRollbackOperationWrite(
            authority,
            () => this.transport.transactWritePrePlanAuthority(command),
          ),
      }
    const operation =
      createAwsWorkspaceSearchMigrationPartialRollbackOperationPort({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        executionBoundary,
        sealedPlanningAuthority,
        closedWriterFenceRecord,
        executionRun: detachedExecutionRun,
        authorityPort,
        lifecycleBinding: lifecycle,
        journalGateway,
        applyReceiptBinding,
        transport: operationTransport,
        clock: this.prePlanAuthorityClock,
      })
    return {
      readRollbackState: () =>
        this.runManagedRollbackOperation(
          authority,
          () => lifecycle.readRollbackState(),
        ),
      readRollbackLifecycle: () =>
        this.runManagedRollbackOperation(
          authority,
          () => lifecycle.readRollbackLifecycle(),
        ),
      readRollbackReceipt: (sequence) =>
        this.runManagedRollbackOperation(
          authority,
          () => operation.readRollbackReceipt(sequence),
        ),
      beginRollback: (input) =>
        this.runManagedRollbackOperation(
          authority,
          () => lifecycle.beginRollback(input),
        ),
      commitRollbackOperation: async (input) => {
        const snapshot = snapshotManagedRateGateInput(
          input,
          () => createManagedRollbackOperationFailure('INVALID_ARGUMENT'),
        )
        return await this.runManagedDescribeTableCheckpointPage(
          () => this.runManagedRollbackOperation(
            authority,
            () => operation.commitRollbackOperation(snapshot),
          ),
        )
      },
      finishRollback: (input) =>
        this.runManagedRollbackOperation(
          authority,
          () => operation.finishRollback(input),
        ),
    }
  }

  /**
   * Creates one complete-applied-root reverse rollback port bound to the
   * current measured generation, pinned DynamoDB/S3 clients, and all six table
   * incarnations.
   *
   * Applied execution state is reconstructed through a dedicated read-only
   * capability. Rollback state, apply receipts, target rows, apply seals, and
   * immutable journal versions remain behind rollback-specific lifecycle and
   * post-send quarantine guards.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Generation-guarded complete-root rollback capability.
   */
  createRollbackOperationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationRollbackOperationAwsPort {
    try {
      return this.createManagedRollbackOperationPort(
        executionBoundary,
        sealedPlanningAuthority,
        closedWriterFenceRecord,
        executionRun,
      )
    } catch (error: unknown) {
      throw createManagedRollbackOperationFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
  }

  /**
   * Composes one rollback port from already captured managed capabilities.
   *
   * Construction remains private so the public factory can normalize every
   * static binding or dependency failure to the rollback boundary.
   *
   * @param executionBoundary - Exact revision-two planning admission.
   * @param sealedPlanningAuthority - Exact immutable sealed planning root.
   * @param closedWriterFenceRecord - Exact closed fence fixed by the boundary.
   * @param executionRun - Exact immutable execution admission.
   * @returns Generation-guarded complete-root rollback capability.
   */
  private createManagedRollbackOperationPort(
    executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord,
    executionRun: WorkspaceSearchMigrationExecutionRun,
  ): WorkspaceSearchMigrationRollbackOperationAwsPort {
    const authority = this.captureManagedRollbackOperationAuthority()
    let detachedExecutionRun: WorkspaceSearchMigrationExecutionRun
    try {
      detachedExecutionRun =
        parseWorkspaceSearchMigrationExecutionRun(
          serializeWorkspaceSearchMigrationExecutionRun(executionRun),
        )
    } catch {
      return failManagedRollbackOperation()
    }
    const immutableArtifactPort =
      this.createManagedRollbackImmutableArtifactPort(authority)
    const journalGateway =
      createAwsWorkspaceSearchMigrationJournalGateway({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        runId: detachedExecutionRun.runId,
        immutableArtifactPort,
        clock: this.prePlanAuthorityClock,
      })
    const prePlanAuthorityAdapter =
      this.createManagedPrePlanAuthorityAdapter(authority)
    const authorityPort:
      WorkspaceSearchMigrationRollbackOperationAuthorityReader = {
        readAuthority: (claim) =>
          this.runManagedRollbackOperationRead(
            authority,
            () => prePlanAuthorityAdapter.readAuthority(claim),
          ),
      }
    let appliedRootDigest: string | undefined
    const appliedRootReader:
      WorkspaceSearchMigrationRollbackAppliedRootReader = {
        readAppliedRoot: () =>
          this.runManagedRollbackOperationRead(
            authority,
            async () => {
              const root =
                parseWorkspaceSearchMigrationAppliedRootStrongReadOutput({
                  stateTable:
                    authority.configuration.tables['migration-state'],
                  configurationHash: authority.configurationHash,
                  executionRun: detachedExecutionRun,
                  output: await this.transport.getPrePlanAuthority(
                    createWorkspaceSearchMigrationAppliedRootStrongReadCommand({
                      stateTable:
                        authority.configuration.tables['migration-state'],
                      configurationHash: authority.configurationHash,
                      executionRun: detachedExecutionRun,
                    }),
                  ),
                })
              if (root !== undefined) {
                if (
                  appliedRootDigest !== undefined &&
                  appliedRootDigest !== root.rootDigest
                ) {
                  return failManagedRollbackOperation()
                }
                appliedRootDigest = root.rootDigest
              }
              return root
            },
          ),
      }
    const applySealReader =
      createAwsWorkspaceSearchMigrationApplySealGateway({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        runId: detachedExecutionRun.runId,
        immutableArtifactPort,
        clock: this.prePlanAuthorityClock,
      })
    const applyRunStateTransport:
      WorkspaceSearchMigrationApplyRunStateAwsTransport = {
        getApplyRunStateItem: (command) =>
          this.runManagedRollbackOperationRead(
            authority,
            () => this.transport.getPrePlanAuthority(command),
          ),
        prepareApplyRunStateRead: async () => {
          await this.requireCurrentRollbackOperationTableIncarnations(
            authority,
          )
        },
      }
    const applyRunStateDelegate =
      createAwsWorkspaceSearchMigrationApplyRunStateReader({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        executionBoundary,
        sealedPlanningAuthority,
        closedWriterFenceRecord,
        executionRun: detachedExecutionRun,
        applySealReader,
        transport: applyRunStateTransport,
      })
    const applyRunStateReader:
      WorkspaceSearchMigrationRollbackApplyRunStateReader = {
        readRunState: () => applyRunStateDelegate.readRunState(),
      }
    const applyReceiptBinding =
      createWorkspaceSearchMigrationApplyReceiptAwsBinding({
        stateTable:
          authority.configuration.tables['migration-state'],
        configurationHash: authority.configurationHash,
        executionRun: detachedExecutionRun,
      })
    const transport:
      WorkspaceSearchMigrationRollbackOperationAwsTransport = {
        getRollbackItem: (command) =>
          this.runManagedRollbackOperationRead(
            authority,
            () => this.transport.getPrePlanAuthority(command),
          ),
        prepareRollbackWrite: async () => {
          await this.requireCurrentRollbackOperationTableIncarnations(
            authority,
          )
        },
        transactWriteRollback: (command) =>
          this.runManagedPreparedRollbackOperationWrite(
            authority,
            () => this.transport.transactWritePrePlanAuthority(command),
          ),
      }
    const delegate =
      createAwsWorkspaceSearchMigrationRollbackOperationPort({
        configuration: authority.configuration,
        configurationHash: authority.configurationHash,
        executionBoundary,
        sealedPlanningAuthority,
        closedWriterFenceRecord,
        executionRun: detachedExecutionRun,
        authorityPort,
        appliedRootReader,
        applyRunStateReader,
        journalGateway,
        applyReceiptBinding,
        transport,
        clock: this.prePlanAuthorityClock,
      })
    return {
      readRollbackState: () =>
        this.runManagedRollbackOperation(
          authority,
          () => delegate.readRollbackState(),
        ),
      readRollbackReceipt: (sequence) =>
        this.runManagedRollbackOperation(
          authority,
          () => delegate.readRollbackReceipt(sequence),
        ),
      readRolledBackRoot: () =>
        this.runManagedRollbackOperation(
          authority,
          () => delegate.readRolledBackRoot(),
        ),
      beginRollback: (input) =>
        this.runManagedRollbackOperation(
          authority,
          () => delegate.beginRollback(input),
        ),
      commitRollbackOperation: async (input) => {
        const snapshot = snapshotManagedRateGateInput(
          input,
          () => createManagedRollbackOperationFailure('INVALID_ARGUMENT'),
        )
        return await this.runManagedDescribeTableCheckpointPage(
          () => this.runManagedRollbackOperation(
            authority,
            () => delegate.commitRollbackOperation(snapshot),
          ),
        )
      },
      finishRollback: (input) =>
        this.runManagedRollbackOperation(
          authority,
          () => delegate.finishRollback(input),
        ),
    }
  }

  /**
   * Reads and reduces one source page through the same pinned credentials and
   * DynamoDB client that performed identity measurement.
   *
   * The predecessor checkpoint is detached before I/O and is passed directly
   * to the reducer, so callers cannot substitute another valid checkpoint
   * between the Scan and cumulative evidence update.
   *
   * @param input - Measured source context and durable predecessor checkpoint.
   * @returns Bound cumulative checkpoint and detached row evidence.
   */
  async scanSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPageResult> {
    const captured = await this.captureSourcePage(input)
    return captured.pageResult
  }

  /**
   * Captures one normalized raw source page and reduces those exact same items.
   *
   * This private primitive is shared by the digest-only public API and the
   * planning artifact gateway, so planning never issues a second Scan or
   * retains an SDK-owned response across an artifact upload.
   *
   * @param input - Measured source context and durable predecessor checkpoint.
   * @returns Detached raw page paired with its exact digest-only reduction.
   */
  private async captureSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<CapturedManagedSourceScanPage> {
    const reductionInput =
      await this.captureSourceReductionInput(input)
    return {
      page: reductionInput.page,
      pageResult:
        reduceWorkspaceSearchMigrationSourceScanPage(
          reductionInput,
        ),
    }
  }

  /**
   * Captures one detached raw source reduction input after guarded I/O.
   *
   * The caller input is validated and detached before the first await. The
   * returned reduction input alone survives the Scan boundary, preventing a
   * caller from substituting configuration, predecessor, or raw page state.
   *
   * @param input - Measured source context and durable predecessor checkpoint.
   * @returns Detached base-reducer input containing the exact normalized page.
   */
  private async captureSourceReductionInput(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<ReduceWorkspaceSearchMigrationSourceScanPageInput> {
    const prepared = await runSourceScanAwsBoundary(async () => {
      this.requireNewAwsAdmission()
      const scanGeneration = this.generation
      const authorizedConfigurationHash =
        this.measuredConfigurationHash
      if (authorizedConfigurationHash === undefined) {
        return failSourceScanAws('INVALID_STATE')
      }
      const preflight =
        prepareWorkspaceSearchMigrationSourceScanContext(input)
      if (!preflight.ok) return failSourceScanAws(preflight.code)
      const context = preflight.context
      if (context.configurationHash !== authorizedConfigurationHash) {
        return failSourceScanAws('CONFIGURATION_HASH_MISMATCH')
      }
      this.requireMeasuredConfigurationBinding(context.configuration)
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      let commandCursor: DynamoAttributeMap | undefined
      if (context.previousCheckpoint.cursor !== undefined) {
        const commandCursorResult =
          cloneWorkspaceSearchMigrationExactTableKey(
            context.previousCheckpoint.cursor,
            context.table,
          )
        if (!commandCursorResult.ok) {
          return failSourceScanAws(commandCursorResult.code)
        }
        commandCursor = commandCursorResult.key
      }

      await this.requireCurrentSourceTableIncarnation(
        context.table,
        scanGeneration,
        authorizedConfigurationHash,
      )
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      let output: ScanCommandOutput
      try {
        output = await this.transport.scanSource(new ScanCommand({
          TableName: this.requested.tables[context.source],
          ConsistentRead: true,
          Limit: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
          ...(commandCursor === undefined
            ? {}
            : { ExclusiveStartKey: commandCursor }),
        }))
      } catch (error: unknown) {
        this.requireMeasurementGeneration(
          scanGeneration,
          authorizedConfigurationHash,
        )
        throw error
      }
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      await this.requireCurrentSourceTableIncarnation(
        context.table,
        scanGeneration,
        authorizedConfigurationHash,
      )
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      const normalized =
        normalizeWorkspaceSearchMigrationSourceScanOutput(
          output,
          context.table,
        )
      if (!normalized.ok) return failSourceScanAws(normalized.code)
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      return {
        configurationHash: authorizedConfigurationHash,
        generation: scanGeneration,
        reductionInput: {
          configuration: context.configuration,
          configurationHash: context.configurationHash,
          source: context.source,
          previousCheckpoint: context.previousCheckpoint,
          page: normalized.page,
        },
      } satisfies PreparedManagedSourceScanReduction
    })
    if (
      !this.isMeasurementGenerationCurrent(
        prepared.generation,
        prepared.configurationHash,
      )
    ) {
      throw createSourceScanAwsBoundaryFailure('INVALID_STATE')
    }
    return prepared.reductionInput
  }

  /**
   * Reads and reduces one target page through the same pinned credentials and
   * DynamoDB client that performed identity measurement.
   *
   * The predecessor checkpoint is detached before I/O and is passed directly
   * to the reducer, so callers cannot substitute another valid checkpoint
   * between the Scan and cumulative evidence update.
   *
   * @param input - Measured target context and durable predecessor checkpoint.
   * @param signal - Optional collector deadline or caller cancellation.
   * @returns Bound cumulative checkpoint and detached row evidence.
   */
  async scanTargetPage(
    input: WorkspaceSearchMigrationTargetScanReadInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchMigrationTargetScanPageResult> {
    const linked = this.createManagedTargetScanCancellation(signal)
    try {
      const captured = await this.captureTargetPage(input, linked.signal)
      return captured.pageResult
    } finally {
      linked.dispose()
    }
  }

  /**
   * Links one caller deadline to this session's permanent operational seal.
   *
   * @param signal - Optional caller or collector cancellation signal.
   * @returns Linked request signal and exact listener cleanup capability.
   */
  private createManagedTargetScanCancellation(
    signal: AbortSignal | undefined,
  ): ManagedTargetScanCancellation {
    if (
      signal !== undefined &&
      (!(signal instanceof AbortSignal) || nodeUtilTypes.isProxy(signal))
    ) return failTargetScanAws('INVALID_ARGUMENT')
    const controller = new AbortController()
    const sessionSignal = this.operationalAbortController.signal
    /** Propagates either cancellation source to the linked request signal. */
    const abort = (): void => controller.abort()
    sessionSignal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (sessionSignal.aborted || signal?.aborted === true) abort()
    return Object.freeze({
      signal: controller.signal,
      dispose: (): void => {
        sessionSignal.removeEventListener('abort', abort)
        signal?.removeEventListener('abort', abort)
      },
    })
  }

  /**
   * Captures one normalized raw target page and reduces those exact same items.
   *
   * The private primitive keeps the raw page inside the managed session so a
   * later durable artifact gateway can reuse it without issuing a second Scan.
   *
   * @param input - Measured target context and durable predecessor checkpoint.
   * @param signal - Session-linked finite request cancellation signal.
   * @returns Detached raw page paired with its exact digest-only reduction.
   */
  private async captureTargetPage(
    input: WorkspaceSearchMigrationTargetScanReadInput,
    signal: AbortSignal = this.operationalAbortController.signal,
  ): Promise<CapturedManagedTargetScanPage> {
    const reductionInput =
      await this.captureTargetReductionInput(input, signal)
    return {
      page: reductionInput.page,
      pageResult:
        reduceWorkspaceSearchMigrationTargetScanPage(
          reductionInput,
        ),
    }
  }

  /**
   * Captures one detached raw target reduction input after guarded I/O.
   *
   * The caller input is validated and detached before the first await. Only
   * the captured reduction input is returned after lifecycle revalidation.
   *
   * @param input - Measured target context and durable predecessor checkpoint.
   * @param signal - Session-linked finite request cancellation signal.
   * @returns Detached base-reducer input containing the exact normalized page.
   */
  private async captureTargetReductionInput(
    input: WorkspaceSearchMigrationTargetScanReadInput,
    signal: AbortSignal,
  ): Promise<ReduceWorkspaceSearchMigrationTargetScanPageInput> {
    const prepared = await runTargetScanAwsBoundary(async () => {
      requireManagedTargetScanSignalActive(signal)
      this.requireNewAwsAdmission()
      const scanGeneration = this.generation
      const authorizedConfigurationHash =
        this.measuredConfigurationHash
      if (authorizedConfigurationHash === undefined) {
        return failTargetScanAws('INVALID_STATE')
      }
      const preflight =
        prepareWorkspaceSearchMigrationTargetScanContext(input)
      if (!preflight.ok) return failTargetScanAws(preflight.code)
      const context = preflight.context
      if (context.configurationHash !== authorizedConfigurationHash) {
        return failTargetScanAws('CONFIGURATION_HASH_MISMATCH')
      }
      this.requireMeasuredConfigurationBinding(context.configuration)
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      let commandCursor: DynamoAttributeMap | undefined
      if (context.previousCheckpoint.cursor !== undefined) {
        const commandCursorResult =
          cloneWorkspaceSearchMigrationExactTableKey(
            context.previousCheckpoint.cursor,
            context.table,
          )
        if (!commandCursorResult.ok) {
          return failTargetScanAws(commandCursorResult.code)
        }
        commandCursor = commandCursorResult.key
      }

      await this.requireCurrentTargetTableIncarnation(
        context.table,
        scanGeneration,
        authorizedConfigurationHash,
        undefined,
        signal,
      )
      requireManagedTargetScanSignalActive(signal)
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      let output: ScanCommandOutput
      try {
        output = await this.transport.scanTarget(
          new ScanCommand({
            TableName: this.requested.tables['workspace-search'],
            ConsistentRead: true,
            Limit: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
            ...(commandCursor === undefined
              ? {}
              : { ExclusiveStartKey: commandCursor }),
          }),
          signal,
        )
      } catch (error: unknown) {
        this.requireMeasurementGeneration(
          scanGeneration,
          authorizedConfigurationHash,
        )
        throw error
      }
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      await this.requireCurrentTargetTableIncarnation(
        context.table,
        scanGeneration,
        authorizedConfigurationHash,
        undefined,
        signal,
      )
      requireManagedTargetScanSignalActive(signal)
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      const normalized =
        normalizeWorkspaceSearchMigrationTargetScanOutput(
          output,
          context.table,
        )
      if (!normalized.ok) return failTargetScanAws(normalized.code)
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      return {
        configurationHash: authorizedConfigurationHash,
        generation: scanGeneration,
        reductionInput: {
          configuration: context.configuration,
          configurationHash: context.configurationHash,
          previousCheckpoint: context.previousCheckpoint,
          page: normalized.page,
        },
      } satisfies PreparedManagedTargetScanReduction
    })
    if (
      !this.isMeasurementGenerationCurrent(
        prepared.generation,
        prepared.configurationHash,
      )
    ) {
      throw createTargetScanAwsBoundaryFailure('INVALID_STATE')
    }
    return prepared.reductionInput
  }

  /**
   * Acquires the measured migration-state table's global pre-plan lease.
   *
   * @param input - Operator-selected run and process-unique owner.
   * @returns Exact newly durable fenced lease.
   */
  async acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    const snapshot = snapshotManagedRateGateInput(
      input,
      createManagedPrePlanSnapshotFailure,
    )
    const request: AcquireWorkspaceSearchMigrationLeaseInput = {
      runId: snapshot.runId,
      ownerId: snapshot.ownerId,
    }
    const acquisitionGeneration = this.generation
    const acquisitionConfigurationHash = this.measuredConfigurationHash
    if (
      this.rehearsalFaultController !== undefined &&
      acquisitionConfigurationHash === undefined
    ) throw invalidIdentityLookup()
    let newlyObservedAcquisition = false
    const leaseAcquisitionObserver:
      WorkspaceSearchMigrationDurableLeaseAcquisitionObserver | undefined =
        this.rehearsalGuard === undefined &&
        this.rehearsalFaultController === undefined
          ? undefined
          : {
              observe: (observation): void => {
                const newlyQueued =
                  this.recordRehearsalLeaseAcquisitionObservation(
                    observation,
                    acquisitionGeneration,
                  )
                if (newlyQueued && observation.kind === 'acquired') {
                  newlyObservedAcquisition = true
                }
              },
            }
    /** Acquires one lease through the measured authority boundary. */
    const operation = async (): Promise<WorkspaceSearchMigrationLease> =>
      await runManagedPrePlanAuthorityAwsBoundary(async () => {
        return this.runPrePlanAuthorityOperation(
          (adapter) => adapter.acquireLease(request),
          leaseAcquisitionObserver,
        )
      })
    const rate = this.describeTableRate
    if (rate === undefined) {
      const lease = await operation()
      if (newlyObservedAcquisition) {
        if (acquisitionConfigurationHash === undefined) {
          throw invalidIdentityLookup()
        }
        await this.reachRehearsalLeaseFault(
          acquisitionGeneration,
          acquisitionConfigurationHash,
        )
      }
      return lease
    }
    return await rate.runNonPageOperation(async () => {
      const lease = await operation()
      await rate.claimAfterLease(lease.fenceToken)
      if (newlyObservedAcquisition) {
        if (acquisitionConfigurationHash === undefined) {
          throw invalidIdentityLookup()
        }
        await this.reachRehearsalLeaseFault(
          acquisitionGeneration,
          acquisitionConfigurationHash,
        )
      }
      return lease
    })
  }

  /**
   * Reaches the rehearsal-only post-acquire lease barrier when configured.
   */
  private async reachRehearsalLeaseFault(
    generation: number,
    configurationHash: string,
  ): Promise<void> {
    const controller = this.rehearsalFaultController
    if (controller === undefined) return
    await controller.reach({
      failpoint: 'lease-acquired-before-first-heartbeat',
      target: { kind: 'planning-lease' },
      reachedAt: this.readRehearsalFaultReachedAt(),
    }, async () => {
      this.requireMeasurementGeneration(generation, configurationHash)
      const leaseIdentityDigest = this.rehearsalLeaseIdentityDigest
      if (leaseIdentityDigest === undefined) {
        return failSourceScanAws('INVALID_STATE')
      }
      this.recordRehearsalFaultObservation(
        Object.freeze({
          observationVersion: 1,
          kind: 'lease',
          failpoint: 'lease-acquired-before-first-heartbeat',
          leaseIdentityDigest,
          closedWriterFenceRecordDigest: null,
          durableAppliedOperationCount: 0,
          sealedPlanOperationCount: null,
        }),
        generation,
        configurationHash,
      )
    })
  }

  /**
   * Reaches one rehearsal-only non-terminal planning-page boundary.
   *
   * @param failpoint - Exact semantic boundary reached by the runtime.
   * @param target - Exact source or target successor page with a cursor.
   */
  private async reachRehearsalPlanningPageFault(
    failpoint: WorkspaceSearchMigrationRehearsalPlanningPageFailpoint,
    target: WorkspaceSearchMigrationRehearsalPlanningPageTarget,
    authority: ManagedMigrationStateAuthority,
    readProgress: () => Promise<
      | WorkspaceSearchMigrationSourceEvidenceProgress
      | WorkspaceSearchMigrationTargetEvidenceProgress
    >,
  ): Promise<void> {
    const controller = this.rehearsalFaultController
    if (controller === undefined) return
    await controller.reach({
      failpoint,
      target,
      reachedAt: this.readRehearsalFaultReachedAt(),
    }, async () => {
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      const progress = await readProgress()
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      const leaseIdentityDigest = this.rehearsalLeaseIdentityDigest
      const closedWriterFenceRecordDigest =
        this.rehearsalClosedWriterFenceRecordDigest
      if (
        leaseIdentityDigest === undefined ||
        closedWriterFenceRecordDigest === undefined
      ) return failSourceScanAws('INVALID_STATE')
      const durableHeadProgressDigest = target.kind === 'source'
        ? 'source' in progress && progress.source === target.source
          ? createWorkspaceSearchMigrationSourceEvidenceProgressDigest(
              progress,
            )
          : failSourceScanAws('INVALID_STATE')
        : 'source' in progress
          ? failSourceScanAws('INVALID_STATE')
          : createWorkspaceSearchMigrationTargetEvidenceProgressDigest(
              progress,
            )
      const observation:
        WorkspaceSearchMigrationRehearsalFaultObservation =
          Object.freeze({
            observationVersion: 1,
            kind: 'planning-page',
            failpoint,
            leaseIdentityDigest,
            closedWriterFenceRecordDigest,
            durableAppliedOperationCount: 0,
            sealedPlanOperationCount: null,
            durableHeadPosition: failpoint ===
                'planning-page-artifact-uploaded-before-checkpoint-commit'
              ? 'predecessor'
              : 'committed-successor',
            durableHeadPageSequence: progress.pageSequence,
            durableHeadEvidenceDigest: progress.evidenceDigest,
            durableHeadCheckpointDigest:
              createMigrationDigest(progress.checkpoint),
            durableHeadProgressDigest,
            durableHeadCursorState:
              progress.checkpoint.cursor === undefined
                ? 'absent'
                : 'present',
            durableHeadCompleted: progress.checkpoint.completed,
            planningTarget: target.kind === 'source'
              ? Object.freeze({
                  kind: target.kind,
                  source: target.source,
                  pageSequence: target.pageSequence,
                  cursorState: target.cursorState,
                })
              : Object.freeze({
                  kind: target.kind,
                  pageSequence: target.pageSequence,
                  cursorState: target.cursorState,
                }),
          })
      this.recordRehearsalFaultObservation(
        observation,
        authority.generation,
        authority.configurationHash,
      )
    })
  }

  /**
   * Reaches one rehearsal-only apply checkpoint cursor boundary.
   *
   * @param failpoint - Exact pre- or post-commit cursor boundary.
   * @param target - Exact non-terminal apply checkpoint selector.
   */
  private async reachRehearsalApplyCheckpointFault(
    failpoint:
      | 'apply-checkpoint-cursor-captured-before-commit'
      | 'apply-checkpoint-cursor-committed-before-return',
    target: WorkspaceSearchMigrationRehearsalApplyCheckpointTarget,
    authority: ManagedApplyOperationAuthority,
    readRunState: () => Promise<WorkspaceSearchMigrationRunState>,
  ): Promise<void> {
    const controller = this.rehearsalFaultController
    if (controller === undefined) return
    await controller.reach({
      failpoint,
      target,
      reachedAt: this.readRehearsalFaultReachedAt(),
    }, async () => {
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      const state = await readRunState()
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      const leaseIdentityDigest = this.rehearsalLeaseIdentityDigest
      const closedWriterFenceRecordDigest =
        this.rehearsalClosedWriterFenceRecordDigest
      if (
        leaseIdentityDigest === undefined ||
        closedWriterFenceRecordDigest === undefined ||
        state.status !== 'applying'
      ) return failManagedApplyOperation()
      const checkpoint = target.location === 'target'
        ? state.apply.target
        : state.apply.sources[target.location]
      const observation:
        WorkspaceSearchMigrationRehearsalFaultObservation =
          Object.freeze({
            observationVersion: 1,
            kind: 'apply-checkpoint',
            failpoint,
            leaseIdentityDigest,
            closedWriterFenceRecordDigest,
            durableAppliedOperationCount: state.appliedOperationCount,
            sealedPlanOperationCount: state.planOperationCount,
            checkpointLocation: target.location,
            durableStatePosition: failpoint ===
                'apply-checkpoint-cursor-captured-before-commit'
              ? 'predecessor'
              : 'committed-successor',
            durableStateRevision: state.revision,
            durableStateStatus: state.status,
            durableRunStateDigest: createMigrationDigest(state),
            durableCheckpointDigest: createMigrationDigest(checkpoint),
            durableCheckpointPageSequence:
              checkpoint.aggregate.pageCount,
            durableCheckpointCursorState:
              checkpoint.cursor === undefined ? 'absent' : 'present',
            durableCheckpointCompleted: checkpoint.completed,
          })
      this.recordRehearsalFaultObservation(
        observation,
        authority.generation,
        authority.configurationHash,
      )
    })
  }

  /**
   * Reaches the rehearsal-only strict partial apply prefix barrier.
   *
   * @param target - Exact committed operation with later work remaining.
   */
  private async reachRehearsalApplyOperationFault(
    target: WorkspaceSearchMigrationRehearsalApplyOperationTarget,
    returnedState: WorkspaceSearchMigrationRunState,
    authority: ManagedApplyOperationAuthority,
    readRunState: () => Promise<WorkspaceSearchMigrationRunState>,
  ): Promise<void> {
    const controller = this.rehearsalFaultController
    if (controller === undefined) return
    await controller.reach({
      failpoint: 'apply-operation-committed-before-return',
      target,
      reachedAt: this.readRehearsalFaultReachedAt(),
    }, async () => {
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      const durableState = await readRunState()
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      const leaseIdentityDigest = this.rehearsalLeaseIdentityDigest
      const closedWriterFenceRecordDigest =
        this.rehearsalClosedWriterFenceRecordDigest
      const returnedRunStateDigest = createMigrationDigest(returnedState)
      const durableRunStateDigest = createMigrationDigest(durableState)
      if (
        leaseIdentityDigest === undefined ||
        closedWriterFenceRecordDigest === undefined ||
        returnedState.status !== 'applying' ||
        durableState.status !== 'applying' ||
        returnedState.revision !== durableState.revision ||
        returnedState.appliedOperationCount !==
          durableState.appliedOperationCount ||
        returnedState.planOperationCount !==
          durableState.planOperationCount ||
        returnedRunStateDigest !== durableRunStateDigest
      ) return failManagedApplyOperation()
      const observation:
        WorkspaceSearchMigrationRehearsalFaultObservation =
          Object.freeze({
            observationVersion: 1,
            kind: 'apply-operation',
            failpoint: 'apply-operation-committed-before-return',
            leaseIdentityDigest,
            closedWriterFenceRecordDigest,
            durableAppliedOperationCount:
              durableState.appliedOperationCount,
            sealedPlanOperationCount: durableState.planOperationCount,
            returnedStateRevision: returnedState.revision,
            returnedRunStateDigest,
            returnedAppliedOperationCount:
              returnedState.appliedOperationCount,
            returnedSealedPlanOperationCount:
              returnedState.planOperationCount,
            durableStateRevision: durableState.revision,
            durableStateStatus: durableState.status,
            durableRunStateDigest,
          })
      this.recordRehearsalFaultObservation(
        observation,
        authority.generation,
        authority.configurationHash,
      )
    })
  }

  /**
   * Samples one canonical secret-free timestamp for a semantic fault receipt.
   *
   * @returns Canonical timestamp from the session's trusted authority clock.
   */
  private readRehearsalFaultReachedAt(): string {
    return readNonProductionRehearsalClock(
      this.prePlanAuthorityClock,
    ).toISOString()
  }

  /**
   * Extends one exact measured global pre-plan lease.
   *
   * @param input - Exact run, owner, and fence being heartbeated.
   * @returns Exact durable successor lease.
   */
  async heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    const snapshot = snapshotManagedRateGateInput(
      input,
      createManagedPrePlanSnapshotFailure,
    )
    const request = snapshotManagedRateGateOperation(
      () => ({
        lease: this.snapshotPrePlanLeaseClaim(snapshot.lease),
      }),
      createManagedPrePlanSnapshotFailure,
    )
    /** Heartbeats one lease through the measured authority boundary. */
    const operation = async (): Promise<WorkspaceSearchMigrationLease> =>
      await runManagedPrePlanAuthorityAwsBoundary(async () => {
        return this.runPrePlanAuthorityOperation(
          (adapter) => adapter.heartbeatLease(request),
        )
      })
    const rate = this.describeTableRate
    return rate === undefined
      ? await operation()
      : await rate.runNonPageOperation(operation)
  }

  /**
   * Resolves the current same-fence maintenance-pointer predecessor.
   *
   * @param lease - Exact active run, owner, and fence identity.
   * @returns Same-fence pointer, or null after first acquire/takeover.
   */
  async readMaintenanceEvidencePointer(
    lease: WorkspaceSearchMigrationLeaseClaim,
  ): Promise<
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null
  > {
    return runManagedPrePlanAuthorityAwsBoundary(async () => {
      const request = this.snapshotPrePlanLeaseClaim(lease)
      return this.runPrePlanAuthorityOperation(
        (adapter) => adapter.readMaintenanceEvidencePointer(request),
      )
    })
  }

  /**
   * Persists one immutable fresh pre-plan maintenance receipt.
   *
   * @param input - Exact lease claim and untrusted evidence bytes.
   * @returns Exact current authority under the measured session.
   */
  async renewMaintenanceEvidence(
    input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    return runManagedPrePlanAuthorityAwsBoundary(async () => {
      const evidenceBytes = input.evidenceBytes
      const expectedPointer = input.expectedPointer
      if (!(evidenceBytes instanceof Uint8Array)) {
        return failSourceScanAws('INVALID_ARGUMENT')
      }
      if (
        evidenceBytes.byteLength === 0 ||
        evidenceBytes.byteLength > MAINTENANCE_EVIDENCE_MAX_BYTES
      ) {
        return failSourceScanAws('INVALID_MAINTENANCE_EVIDENCE')
      }
      const request:
        RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput = {
          lease: this.snapshotPrePlanLeaseClaim(input.lease),
          expectedPointer: expectedPointer === null
            ? null
            : this.snapshotPrePlanMaintenancePointerClaim(expectedPointer),
          evidenceBytes: new Uint8Array(evidenceBytes),
        }
      return this.runPrePlanAuthorityOperation(
        (adapter) => adapter.renewMaintenanceEvidence(request),
      )
    })
  }

  /**
   * Resolves one exact fresh pre-plan authority claim.
   *
   * @param claim - Exact current lease and receipt digest.
   * @returns Exact authority evaluated by the adapter-owned clock.
   */
  async readAuthority(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    return runManagedPrePlanAuthorityAwsBoundary(async () => {
      const request: WorkspaceSearchMigrationPrePlanAuthorityClaim = {
        lease: this.snapshotPrePlanLeaseClaim(claim.lease),
        maintenanceEvidenceReceiptDigest:
          claim.maintenanceEvidenceReceiptDigest,
        maintenanceEvidencePointerRevision:
          claim.maintenanceEvidencePointerRevision,
      }
      return this.runPrePlanAuthorityOperation(
        (adapter) => adapter.readAuthority(request),
      )
    })
  }

  /**
   * Reads one immutable pre-plan maintenance-evidence receipt.
   *
   * @param runId - Run that owns the historical receipt.
   * @param receiptDigest - Exact immutable receipt digest.
   * @returns Exact historical receipt or undefined when absent.
   */
  async readMaintenanceEvidenceReceipt(
    runId: string,
    receiptDigest: string,
  ): Promise<WorkspaceSearchMaintenanceEvidenceReceipt | undefined> {
    return runManagedPrePlanAuthorityAwsBoundary(async () => {
      const runIdSnapshot = runId
      const receiptDigestSnapshot = receiptDigest
      return this.runPrePlanAuthorityOperation(
        (adapter) => adapter.readMaintenanceEvidenceReceipt(
          runIdSnapshot,
          receiptDigestSnapshot,
        ),
      )
    })
  }

  /**
   * Reads one immutable historical receipt with its durable authority binding.
   *
   * @param runId - Run that owns the historical receipt.
   * @param receiptDigest - Exact immutable receipt digest.
   * @returns Exact historical binding or undefined when absent.
   */
  async readHistoricalMaintenanceEvidenceBinding(
    runId: string,
    receiptDigest: string,
  ): Promise<
    WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding | undefined
  > {
    return runManagedPrePlanAuthorityAwsBoundary(async () => {
      const runIdSnapshot = runId
      const receiptDigestSnapshot = receiptDigest
      return this.runPrePlanAuthorityOperation(
        (adapter) =>
          adapter.readHistoricalMaintenanceEvidenceBinding(
            runIdSnapshot,
            receiptDigestSnapshot,
          ),
      )
    })
  }

  /**
   * Detaches one exact pre-plan lease claim before any asynchronous guard I/O.
   *
   * @param claim - Candidate run, owner, and fence tuple.
   * @returns Detached claim safe to retain across awaits.
   */
  private snapshotPrePlanLeaseClaim(
    claim: WorkspaceSearchMigrationLeaseClaim,
  ): WorkspaceSearchMigrationLeaseClaim {
    return {
      runId: claim.runId,
      ownerId: claim.ownerId,
      fenceToken: claim.fenceToken,
    }
  }

  /**
   * Detaches one exact maintenance-pointer predecessor before asynchronous I/O.
   *
   * @param claim - Candidate fence, revision, and immutable receipt digest.
   * @returns Detached pointer claim safe to retain across awaits.
   */
  private snapshotPrePlanMaintenancePointerClaim(
    claim: WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
  ): WorkspaceSearchMigrationPrePlanMaintenancePointerClaim {
    return {
      fenceToken: claim.fenceToken,
      revision: claim.revision,
      receiptDigest: claim.receiptDigest,
    }
  }

  /**
   * Runs one pre-plan authority operation against the current measurement.
   *
   * The caller must detach every operation input before entering this method,
   * because the first state-incarnation check performs asynchronous I/O.
   *
   * @param operation - Exact operation over an ephemeral measured adapter.
   * @param leaseAcquisitionObserver - Optional rehearsal-only commit observer.
   * @returns Detached authority result while measurement remains current.
   */
  private async runPrePlanAuthorityOperation<Result>(
    operation: (
      adapter: WorkspaceSearchMigrationPrePlanAuthorityAwsPort,
    ) => Promise<Result>,
    leaseAcquisitionObserver?:
      WorkspaceSearchMigrationDurableLeaseAcquisitionObserver,
  ): Promise<Result> {
    return await this.runManagedAwsMutationDrainOperation(async () => {
      const authority = this.captureManagedMigrationStateAuthority()
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      const adapter = this.createManagedPrePlanAuthorityAdapter(
        authority,
        leaseAcquisitionObserver,
      )
      let result: Result
      try {
        result = await operation(adapter)
      } catch (error: unknown) {
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        await this.requireCurrentMigrationStateTableIncarnation(authority)
        throw error
      }
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      return result
    })
  }

  /**
   * Creates an ephemeral authority adapter on the measured DynamoDB client.
   *
   * @param authority - Current generation, configuration, and state identity.
   * @param leaseAcquisitionObserver - Optional rehearsal-only commit observer.
   * @returns Pre-plan authority adapter guarded around every state operation.
   */
  private createManagedPrePlanAuthorityAdapter(
    authority: ManagedMigrationStateAuthority,
    leaseAcquisitionObserver?:
      WorkspaceSearchMigrationDurableLeaseAcquisitionObserver,
  ): WorkspaceSearchMigrationPrePlanAuthorityAwsPort {
    let writePrepared = false
    const transport: WorkspaceSearchMigrationPrePlanAuthorityAwsTransport = {
      getPrePlanAuthority: (command) =>
        this.runManagedMigrationStateIo(
          authority,
          () => this.transport.getPrePlanAuthority(command),
        ),
      preparePrePlanAuthorityWrite: async () => {
        if (writePrepared) return failSourceScanAws('INVALID_STATE')
        await this.requireCurrentMigrationStateTableIncarnation(authority)
        writePrepared = true
      },
      transactWritePrePlanAuthority: (command) => {
        if (!writePrepared) return failSourceScanAws('INVALID_STATE')
        writePrepared = false
        return this.runManagedPreparedMigrationStateWrite(
          authority,
          () => this.transport.transactWritePrePlanAuthority(command),
        )
      },
    }
    return createAwsWorkspaceSearchMigrationPrePlanAuthorityPort({
      stateTable: authority.stateTable,
      configurationHash: authority.configurationHash,
      transport,
      clock: this.prePlanAuthorityClock,
      ...(leaseAcquisitionObserver === undefined
        ? {}
        : { leaseAcquisitionObserver }),
    })
  }

  /**
   * Reads one durable source-evidence head through the current measurement.
   *
   * @param input - Exact measured evidence-chain request.
   * @returns Current durable or canonical initial progress.
   */
  async readSourceEvidenceProgress(
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    return this.runSourceEvidenceOperation(
      input,
      (adapter, request) => adapter.readProgress(request),
    )
  }

  /**
   * Reads and globally validates all pages at one captured durable head.
   *
   * @param input - Exact measured evidence-chain request.
   * @returns Replayed row evidence and captured progress.
   */
  async readCommittedSourceEvidence(
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceReplayResult> {
    return this.runSourceEvidenceOperation(
      input,
      (adapter, request) => adapter.readCommittedEvidence(request),
    )
  }

  /**
   * Scans and atomically commits one next source-evidence page.
   *
   * @param input - Exact measured evidence-chain request.
   * @returns Exact committed successor or terminal progress.
   */
  async commitNextSourceEvidencePage(
    input: WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    const snapshot = snapshotManagedRateGateInput(
      input,
      () => createManagedSourceEvidencePreparationFailure(
        'INVALID_ARGUMENT',
      ),
    )
    return await this.runManagedDescribeTableCheckpointPage(
      () => this.runSourceEvidenceOperation(
        snapshot,
        (adapter, request) => adapter.commitNextPage(request),
      ),
    )
  }

  /**
   * Runs one complete managed evidence operation against the exact measured
   * migration-state table incarnation.
   *
   * @param input - Exact measured evidence-chain request.
   * @param operation - Adapter operation over the detached captured request.
   * @returns Detached operation result only while state identity stays current.
   */
  private async runSourceEvidenceOperation<
    Request extends WorkspaceSearchMigrationSourceEvidenceAwsRequest,
    Result,
  >(
    input: Request,
    operation: (
      adapter: WorkspaceSearchMigrationSourceEvidenceAwsPort,
      request: Request,
    ) => Promise<Result>,
  ): Promise<Result> {
    return runManagedSourceEvidenceAwsBoundary(() =>
      this.runManagedAwsMutationDrainOperation(async () => {
        const authority = this.captureSourceEvidenceAuthority(input)
        await this.requireCurrentMigrationStateTableIncarnation(authority)
        const postSendGuard: ManagedPlanningEvidencePostSendGuardState = {
          finalized: false,
        }
        const adapter = this.createManagedSourceEvidenceAdapter(
          authority,
          postSendGuard,
        )
        let result: Result
        try {
          result = await operation(adapter, authority.request)
        } catch (error: unknown) {
          if (postSendGuard.finalized) {
            const failure = postSendGuard.failure
            if (failure !== undefined) throw failure
            throw error
          }
          this.requireMeasurementGeneration(
            authority.generation,
            authority.configurationHash,
          )
          await this.requireCurrentMigrationStateTableIncarnation(authority)
          throw error
        }
        if (postSendGuard.finalized) {
          const failure = postSendGuard.failure
          if (failure !== undefined) throw failure
          return result
        }
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        await this.requireCurrentMigrationStateTableIncarnation(authority)
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        return result
      }),
    )
  }

  /**
   * Captures the migration-state authority installed by the latest measurement.
   *
   * @returns Detached generation, configuration hash, and state incarnation.
   */
  private captureManagedMigrationStateAuthority():
    ManagedMigrationStateAuthority {
    this.requireNewAwsAdmission()
    const generation = this.generation
    const configurationHash = this.measuredConfigurationHash
    const stateTable = this.measuredMigrationStateTable
    if (configurationHash === undefined || stateTable === undefined) {
      return failSourceScanAws('INVALID_STATE')
    }
    this.requireMeasurementGeneration(generation, configurationHash)
    return {
      generation,
      configurationHash,
      stateTable: structuredClone(stateTable),
    }
  }

  /**
   * Captures and validates the current measurement for one evidence call.
   *
   * @param input - Exact measured evidence-chain request.
   * @returns Generation and configuration hash guarded around every I/O.
   */
  private captureSourceEvidenceAuthority<
    Request extends WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  >(
    input: Request,
  ): ManagedSourceEvidenceAuthority<Request> {
    this.requireNewAwsAdmission()
    const request = structuredClone(input)
    const authority = this.captureManagedMigrationStateAuthority()
    if (request.configurationHash !== authority.configurationHash) {
      return failSourceScanAws('CONFIGURATION_HASH_MISMATCH')
    }
    this.requireMeasuredConfigurationBinding(request.configuration)
    return {
      ...authority,
      request,
    }
  }

  /**
   * Creates one ephemeral evidence adapter guarded by captured authority.
   *
   * @param authority - Current generation and configuration authorization.
   * @param postSendGuard - Operation-local final transaction guard marker.
   * @returns Adapter composed from this session's scanner and DynamoDB client.
   */
  private createManagedSourceEvidenceAdapter(
    authority: ManagedSourceEvidenceAuthority,
    postSendGuard: ManagedPlanningEvidencePostSendGuardState,
  ): WorkspaceSearchMigrationSourceEvidenceAwsPort {
    let writePrepared = false
    let delegate: WorkspaceSearchMigrationSourceEvidenceAwsPort | undefined
    let rehearsalPlanningPageTarget:
      WorkspaceSearchMigrationRehearsalPlanningPageTarget | undefined
    const sourceArtifactTransport:
      WorkspaceSearchMigrationSourceArtifactAwsTransport = {
        putSourceArtifact: (command) =>
          this.runManagedMigrationStateIo(
            authority,
            () => {
              this.assertNewManagedDataIoAllowed()
              return this.transport.putSourceArtifact(command)
            },
          ),
        headSourceArtifact: (command) =>
          this.runManagedMigrationStateIo(
            authority,
            () => this.transport.headSourceArtifact(command),
          ),
        getSourceArtifact: (command) =>
          this.runManagedMigrationStateIo(
            authority,
            () => this.transport.getSourceArtifact(command),
          ),
      }
    const sourceArtifactPort =
      createAwsWorkspaceSearchMigrationSourceArtifactPort({
        configuration: authority.request.configuration,
        configurationHash: authority.configurationHash,
        transport: sourceArtifactTransport,
      })
    const planningArtifactGateway:
      WorkspaceSearchMigrationPlanningSourceArtifactGateway = {
        captureAndStorePlanningPage: async (input) => {
          const captured = await this.runManagedMigrationStateIo(
            authority,
            () => this.captureSourcePage({
              configuration: input.configuration,
              configurationHash: input.configurationHash,
              source: input.source,
              previousCheckpoint: input.previousCheckpoint,
            }),
          )
          const sourceTable =
            input.configuration.tables[input.source]
          const stateTable =
            input.configuration.tables['migration-state']
          if (
            sourceTable === undefined ||
            stateTable === undefined
          ) {
            return failSourceScanAws('IDENTITY_MISMATCH')
          }
          const expectedPage:
            WorkspaceSearchMigrationPlanningSourceArtifactPage = {
              kind: 'workspace-search-planning-source-artifact-page',
              artifactVersion:
                WORKSPACE_SEARCH_MIGRATION_SOURCE_ARTIFACT_VERSION,
              migrationId: input.configuration.migrationId,
              migrationVersion: input.configuration.migrationVersion,
              purpose: 'planning',
              runId: input.runId,
              configurationHash: input.configurationHash,
              source: input.source,
              sourceTable: {
                tableName: sourceTable.tableName,
                tableArn: sourceTable.tableArn,
                tableId: sourceTable.tableId,
                creationTime: sourceTable.creationTime,
              },
              stateTable: {
                tableName: stateTable.tableName,
                tableArn: stateTable.tableArn,
                tableId: stateTable.tableId,
                creationTime: stateTable.creationTime,
              },
              pageSequence: input.pageSequence,
              previousEvidenceDigest: input.previousEvidenceDigest,
              previousCheckpointDigest:
                input.previousCheckpointDigest,
              planningAuthority: {
                ownerId: input.planningAuthority.ownerId,
                fenceToken: input.planningAuthority.fenceToken,
                maintenanceEvidencePointerRevision:
                  input.planningAuthority
                    .maintenanceEvidencePointerRevision,
                maintenanceEvidenceReceiptDigest:
                  input.planningAuthority
                    .maintenanceEvidenceReceiptDigest,
              },
              items: captured.page.items,
            }
          const sourceArtifacts =
            await sourceArtifactPort.writePlanningSourceArtifactPage({
              expectedPage,
            })
          if (captured.pageResult.checkpoint.cursor !== undefined) {
            rehearsalPlanningPageTarget = {
              kind: 'source',
              source: input.source,
              pageSequence: input.pageSequence,
              cursorState: 'present',
            }
            await this.reachRehearsalPlanningPageFault(
              'planning-page-artifact-uploaded-before-checkpoint-commit',
              rehearsalPlanningPageTarget,
              authority,
              async () => {
                const reader = delegate
                if (reader === undefined) {
                  return failSourceScanAws('INVALID_STATE')
                }
                return await reader.readProgress({
                  runId: authority.request.runId,
                  purpose: authority.request.purpose,
                  configuration: authority.request.configuration,
                  configurationHash:
                    authority.request.configurationHash,
                  source: authority.request.source,
                })
              },
            )
          }
          return {
            pageResult: captured.pageResult,
            sourceArtifacts,
          }
        },
        readVerifiedPlanningPage: async (input) => {
          const sourceTable =
            input.configuration.tables[input.source]
          const stateTable =
            input.configuration.tables['migration-state']
          if (
            sourceTable === undefined ||
            stateTable === undefined
          ) {
            return failSourceScanAws('IDENTITY_MISMATCH')
          }
          const page =
            await sourceArtifactPort.readPlanningSourceArtifactPage({
              expectedPage: {
                runId: input.runId,
                configurationHash: input.configurationHash,
                source: input.source,
                sourceTable: {
                  tableName: sourceTable.tableName,
                  tableArn: sourceTable.tableArn,
                  tableId: sourceTable.tableId,
                  creationTime: sourceTable.creationTime,
                },
                stateTable: {
                  tableName: stateTable.tableName,
                  tableArn: stateTable.tableArn,
                  tableId: stateTable.tableId,
                  creationTime: stateTable.creationTime,
                },
                pageSequence: input.pageSequence,
                previousEvidenceDigest:
                  input.previousEvidenceDigest,
                previousCheckpointDigest:
                  input.previousCheckpointDigest,
                planningAuthority: {
                  ownerId: input.planningAuthority.ownerId,
                  fenceToken: input.planningAuthority.fenceToken,
                  maintenanceEvidencePointerRevision:
                    input.planningAuthority
                      .maintenanceEvidencePointerRevision,
                  maintenanceEvidenceReceiptDigest:
                    input.planningAuthority
                      .maintenanceEvidenceReceiptDigest,
                },
              },
              references: input.sourceArtifacts,
            })
          return {
            items: page.items,
          }
        },
      }
    const scanner: WorkspaceSearchMigrationSourceEvidenceScanner = {
      scanSourcePage: (input) =>
        this.runManagedMigrationStateIo(
          authority,
          () => this.scanSourcePage(input),
        ),
    }
    const transport: WorkspaceSearchMigrationSourceEvidenceAwsTransport = {
      getSourceEvidence: (command) =>
        this.runManagedMigrationStateIo(
          authority,
          () => this.transport.getSourceEvidence(command),
        ),
      prepareSourceEvidenceWrite: async () => {
        if (writePrepared) return failSourceScanAws('INVALID_STATE')
        const sourceTable =
          authority.request.configuration.tables[
            authority.request.source
          ]
        if (sourceTable === undefined) {
          return failSourceScanAws('IDENTITY_MISMATCH')
        }
        try {
          await this.requireCurrentSourceTableIncarnation(
            sourceTable,
            authority.generation,
            authority.configurationHash,
          )
        } catch (error: unknown) {
          throw createManagedSourceEvidencePreparationFailure(
            readManagedMigrationStateFailureCode(error),
          )
        }
        try {
          await this.requireCurrentMigrationStateTableIncarnation(
            authority,
          )
        } catch (error: unknown) {
          throw createManagedSourceEvidencePreparationFailure(
            readManagedMigrationStateFailureCode(error),
          )
        }
        writePrepared = true
      },
      transactWriteSourceEvidence: (command) => {
        if (!writePrepared) return failSourceScanAws('INVALID_STATE')
        writePrepared = false
        return this.runManagedPreparedSourceEvidenceWrite(
          authority,
          postSendGuard,
          async () => {
            const result =
              await this.transport.transactWriteSourceEvidence(command)
            const target = rehearsalPlanningPageTarget
            if (target !== undefined) {
              await this.reachRehearsalPlanningPageFault(
                'planning-page-transaction-response-lost',
                target,
                authority,
                async () => {
                  const reader = delegate
                  if (reader === undefined) {
                    return failSourceScanAws('INVALID_STATE')
                  }
                  return await reader.readProgress({
                    runId: authority.request.runId,
                    purpose: authority.request.purpose,
                    configuration: authority.request.configuration,
                    configurationHash:
                      authority.request.configurationHash,
                    source: authority.request.source,
                  })
                },
              )
            }
            return result
          },
        )
      },
    }
    delegate = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTable: authority.stateTable,
      scanner,
      planningArtifactGateway,
      transport,
      clock: this.prePlanAuthorityClock,
    })
    return delegate
  }

  /**
   * Reads one durable target-evidence head through the current measurement.
   *
   * @param input - Exact measured target evidence-chain request.
   * @returns Current durable or canonical initial target progress.
   */
  async readTargetEvidenceProgress(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress> {
    return this.runTargetEvidenceOperation(
      input,
      (adapter, request) => adapter.readProgress(request),
    )
  }

  /**
   * Reads and globally validates all target pages at one captured durable head.
   *
   * @param input - Exact measured target evidence-chain request.
   * @returns Replayed target-row evidence and captured progress.
   */
  async readCommittedTargetEvidence(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceReplayResult> {
    return this.runTargetEvidenceOperation(
      input,
      (adapter, request) => adapter.readCommittedEvidence(request),
    )
  }

  /**
   * Scans and atomically commits one next target-evidence page.
   *
   * @param input - Exact measured target evidence-chain request and authority.
   * @returns Exact committed successor or terminal target progress.
   */
  async commitNextTargetEvidencePage(
    input: WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress> {
    const snapshot = snapshotManagedRateGateInput(
      input,
      () => createManagedTargetEvidenceFailure('INVALID_ARGUMENT'),
    )
    return await this.runManagedDescribeTableCheckpointPage(
      () => this.runTargetEvidenceOperation(
        snapshot,
        (adapter, request) => adapter.commitNextPage(request),
      ),
    )
  }

  /**
   * Runs one complete managed target-evidence operation against the exact
   * measured migration-state table incarnation.
   *
   * @param input - Exact measured target evidence-chain request.
   * @param operation - Adapter operation over the detached captured request.
   * @returns Detached result only while state identity stays current.
   */
  private async runTargetEvidenceOperation<
    Request extends WorkspaceSearchMigrationTargetEvidenceAwsRequest,
    Result,
  >(
    input: Request,
    operation: (
      adapter: WorkspaceSearchMigrationTargetEvidenceAwsPort,
      request: Request,
    ) => Promise<Result>,
  ): Promise<Result> {
    return runManagedTargetEvidenceAwsBoundary(() =>
      this.runManagedAwsMutationDrainOperation(async () => {
        const authority = this.captureTargetEvidenceAuthority(input)
        await this.requireCurrentMigrationStateTableIncarnation(authority)
        const postSendGuard: ManagedPlanningEvidencePostSendGuardState = {
          finalized: false,
        }
        const adapter = this.createManagedTargetEvidenceAdapter(
          authority,
          postSendGuard,
        )
        let result: Result
        try {
          result = await operation(adapter, authority.request)
        } catch (error: unknown) {
          if (postSendGuard.finalized) {
            const failure = postSendGuard.failure
            if (failure !== undefined) throw failure
            throw error
          }
          this.requireMeasurementGeneration(
            authority.generation,
            authority.configurationHash,
          )
          await this.requireCurrentMigrationStateTableIncarnation(authority)
          throw error
        }
        if (postSendGuard.finalized) {
          const failure = postSendGuard.failure
          if (failure !== undefined) throw failure
          return result
        }
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        await this.requireCurrentMigrationStateTableIncarnation(authority)
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        return result
      }),
    )
  }

  /**
   * Captures and validates the current measurement for one target-evidence call.
   *
   * @param input - Exact measured target evidence-chain request.
   * @returns Generation and configuration guarded around every managed I/O.
   */
  private captureTargetEvidenceAuthority<
    Request extends WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  >(
    input: Request,
  ): ManagedTargetEvidenceAuthority<Request> {
    this.requireNewAwsAdmission()
    const request = structuredClone(input)
    const authority = this.captureManagedMigrationStateAuthority()
    if (request.configurationHash !== authority.configurationHash) {
      throw createManagedTargetEvidenceFailure(
        'CONFIGURATION_HASH_MISMATCH',
      )
    }
    this.requireMeasuredConfigurationBinding(request.configuration)
    return {
      ...authority,
      request,
    }
  }

  /**
   * Creates one ephemeral target-evidence adapter guarded by captured authority.
   *
   * @param authority - Current generation and configuration authorization.
   * @param postSendGuard - Operation-local final transaction guard marker.
   * @returns Adapter composed from one private raw-page gateway and AWS clients.
   */
  private createManagedTargetEvidenceAdapter(
    authority: ManagedTargetEvidenceAuthority,
    postSendGuard: ManagedPlanningEvidencePostSendGuardState,
  ): WorkspaceSearchMigrationTargetEvidenceAwsPort {
    let writePrepared = false
    let delegate: WorkspaceSearchMigrationTargetEvidenceAwsPort | undefined
    let rehearsalPlanningPageTarget:
      WorkspaceSearchMigrationRehearsalPlanningPageTarget | undefined
    const targetArtifactTransport:
      WorkspaceSearchMigrationTargetArtifactAwsTransport = {
        putTargetArtifact: (command) =>
          this.runManagedMigrationStateIo(
            authority,
            () => {
              this.assertNewManagedDataIoAllowed()
              return this.transport.putTargetArtifact(command)
            },
          ),
        headTargetArtifact: (command) =>
          this.runManagedMigrationStateIo(
            authority,
            () => this.transport.headTargetArtifact(command),
          ),
        getTargetArtifact: (command) =>
          this.runManagedMigrationStateIo(
            authority,
            () => this.transport.getTargetArtifact(command),
          ),
      }
    const targetArtifactPort =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration: authority.request.configuration,
        configurationHash: authority.configurationHash,
        transport: targetArtifactTransport,
      })
    const planningArtifactGateway:
      WorkspaceSearchMigrationPlanningTargetArtifactGateway = {
        captureAndStorePlanningPage: async (input) => {
          const captured = await this.runManagedMigrationStateIo(
            authority,
            () => this.captureTargetPage({
              configuration: input.configuration,
              configurationHash: input.configurationHash,
              previousCheckpoint: input.previousCheckpoint,
            }),
          )
          const targetTable =
            input.configuration.tables['workspace-search']
          const stateTable =
            input.configuration.tables['migration-state']
          if (targetTable === undefined || stateTable === undefined) {
            throw createManagedTargetEvidenceFailure(
              'IDENTITY_MISMATCH',
            )
          }
          const expectedPage:
            WorkspaceSearchMigrationPlanningTargetArtifactPage = {
              kind: 'workspace-search-planning-target-artifact-page',
              artifactVersion:
                WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
              migrationId: input.configuration.migrationId,
              migrationVersion: input.configuration.migrationVersion,
              purpose: 'planning',
              runId: input.runId,
              configurationHash: input.configurationHash,
              targetTable: {
                tableName: targetTable.tableName,
                tableArn: targetTable.tableArn,
                tableId: targetTable.tableId,
                creationTime: targetTable.creationTime,
              },
              stateTable: {
                tableName: stateTable.tableName,
                tableArn: stateTable.tableArn,
                tableId: stateTable.tableId,
                creationTime: stateTable.creationTime,
              },
              pageSequence: input.pageSequence,
              previousEvidenceDigest: input.previousEvidenceDigest,
              previousCheckpointDigest:
                input.previousCheckpointDigest,
              planningAuthority: {
                ownerId: input.planningAuthority.ownerId,
                fenceToken: input.planningAuthority.fenceToken,
                maintenanceEvidencePointerRevision:
                  input.planningAuthority
                    .maintenanceEvidencePointerRevision,
                maintenanceEvidenceReceiptDigest:
                  input.planningAuthority
                    .maintenanceEvidenceReceiptDigest,
              },
              items: captured.page.items,
            }
          const targetArtifacts =
            await this.runManagedMigrationStateIo(
              authority,
              () =>
                targetArtifactPort.writePlanningTargetArtifactPage({
                  expectedPage,
                }),
            )
          if (captured.pageResult.checkpoint.cursor !== undefined) {
            rehearsalPlanningPageTarget = {
              kind: 'target',
              pageSequence: input.pageSequence,
              cursorState: 'present',
            }
            await this.reachRehearsalPlanningPageFault(
              'planning-page-artifact-uploaded-before-checkpoint-commit',
              rehearsalPlanningPageTarget,
              authority,
              async () => {
                const reader = delegate
                if (reader === undefined) {
                  throw createManagedTargetEvidenceFailure('INVALID_STATE')
                }
                return await reader.readProgress({
                  runId: authority.request.runId,
                  purpose: authority.request.purpose,
                  configuration: authority.request.configuration,
                  configurationHash:
                    authority.request.configurationHash,
                })
              },
            )
          }
          return {
            pageResult: captured.pageResult,
            targetArtifacts,
          }
        },
        readVerifiedPlanningPage: async (input) => {
          const targetTable =
            input.configuration.tables['workspace-search']
          const stateTable =
            input.configuration.tables['migration-state']
          if (targetTable === undefined || stateTable === undefined) {
            throw createManagedTargetEvidenceFailure(
              'IDENTITY_MISMATCH',
            )
          }
          const page = await this.runManagedMigrationStateIo(
            authority,
            () =>
              targetArtifactPort.readPlanningTargetArtifactPage({
                expectedPage: {
                  runId: input.runId,
                  configurationHash: input.configurationHash,
                  targetTable: {
                    tableName: targetTable.tableName,
                    tableArn: targetTable.tableArn,
                    tableId: targetTable.tableId,
                    creationTime: targetTable.creationTime,
                  },
                  stateTable: {
                    tableName: stateTable.tableName,
                    tableArn: stateTable.tableArn,
                    tableId: stateTable.tableId,
                    creationTime: stateTable.creationTime,
                  },
                  pageSequence: input.pageSequence,
                  previousEvidenceDigest:
                    input.previousEvidenceDigest,
                  previousCheckpointDigest:
                    input.previousCheckpointDigest,
                  planningAuthority: {
                    ownerId: input.planningAuthority.ownerId,
                    fenceToken: input.planningAuthority.fenceToken,
                    maintenanceEvidencePointerRevision:
                      input.planningAuthority
                        .maintenanceEvidencePointerRevision,
                    maintenanceEvidenceReceiptDigest:
                      input.planningAuthority
                        .maintenanceEvidenceReceiptDigest,
                  },
                },
                references: input.targetArtifacts,
              }),
          )
          return {
            items: page.items,
          }
        },
      }
    const transport: WorkspaceSearchMigrationTargetEvidenceAwsTransport = {
      getTargetEvidence: (command) =>
        this.runManagedMigrationStateIo(
          authority,
          () => this.transport.getTargetEvidence(command),
        ),
      prepareTargetEvidenceWrite: async () => {
        if (writePrepared) {
          throw createManagedTargetEvidenceFailure('INVALID_STATE')
        }
        const targetTable =
          authority.request.configuration.tables['workspace-search']
        if (targetTable === undefined) {
          throw createManagedTargetEvidenceFailure(
            'IDENTITY_MISMATCH',
          )
        }
        try {
          await this.requireCurrentTargetTableIncarnation(
            targetTable,
            authority.generation,
            authority.configurationHash,
          )
        } catch (error: unknown) {
          throw createManagedTargetEvidenceFailure(
            readTargetScanAwsFailureCode(error),
          )
        }
        try {
          await this.requireCurrentMigrationStateTableIncarnation(
            authority,
          )
        } catch (error: unknown) {
          throw createManagedTargetEvidenceFailure(
            readManagedMigrationStateFailureCode(error),
          )
        }
        writePrepared = true
      },
      transactWriteTargetEvidence: (command) => {
        if (!writePrepared) {
          throw createManagedTargetEvidenceFailure('INVALID_STATE')
        }
        writePrepared = false
        return this.runManagedPreparedTargetEvidenceWrite(
          authority,
          postSendGuard,
          async () => {
            const result =
              await this.transport.transactWriteTargetEvidence(command)
            const target = rehearsalPlanningPageTarget
            if (target !== undefined) {
              await this.reachRehearsalPlanningPageFault(
                'planning-page-transaction-response-lost',
                target,
                authority,
                async () => {
                  const reader = delegate
                  if (reader === undefined) {
                    throw createManagedTargetEvidenceFailure('INVALID_STATE')
                  }
                  return await reader.readProgress({
                    runId: authority.request.runId,
                    purpose: authority.request.purpose,
                    configuration: authority.request.configuration,
                    configurationHash:
                      authority.request.configurationHash,
                  })
                },
              )
            }
            return result
          },
        )
      },
    }
    delegate = createAwsWorkspaceSearchMigrationTargetEvidencePort({
      stateTable: authority.stateTable,
      planningArtifactGateway,
      transport,
      clock: this.prePlanAuthorityClock,
    })
    return delegate
  }

  /**
   * Reads and joins five terminal planning chains under one measurement.
   *
   * The method fixes all five heads before exact-version artifact reads, keeps
   * full raw page material private, and strongly rereads every head after the
   * pure join. Candidate preimages required by later plan sealing remain in the
   * returned pure-join result.
   *
   * The result is provisional and grants no execution or production-gate
   * authority without writer fencing, freshness checks, and atomic plan/head
   * persistence.
   *
   * @param input - Run, measured identity, and bounded material limits.
   * @returns Fully revalidated planning evidence ready for later plan sealing.
   */
  async joinCommittedPlanningEvidence(
    input: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPlanningJoinResult> {
    return runManagedPlanningJoinAwsBoundary(async () =>
      (await this.prepareManagedPlanningJoin(input)).result
    )
  }

  /**
   * Prepares one exact planning join and an opaque provenance writer.
   *
   * @param input - Run, measured identity, and bounded material limits.
   * @returns Joined planning evidence with a generation-bound writer.
   */
  async prepareCommittedPlanningEvidence(
    input: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPreparedCommittedPlanningEvidence> {
    return runManagedPlanningJoinAwsBoundary(async () => {
      const preparation = await this.prepareManagedPlanningJoin(input)
      const { authority, material, result } = preparation
      try {
        const sourceEvidencePageBytes = {
          'project-directory':
            material.sources['project-directory'].materials.map(
              (entry) =>
                serializeWorkspaceSearchMigrationSourceEvidencePage(
                  entry.page,
                ),
            ),
          'work-items': material.sources['work-items'].materials.map(
            (entry) =>
              serializeWorkspaceSearchMigrationSourceEvidencePage(
                entry.page,
              ),
          ),
          collaboration: material.sources.collaboration.materials.map(
            (entry) =>
              serializeWorkspaceSearchMigrationSourceEvidencePage(
                entry.page,
              ),
          ),
          documents: material.sources.documents.materials.map(
            (entry) =>
              serializeWorkspaceSearchMigrationSourceEvidencePage(
                entry.page,
              ),
          ),
        }
        const targetEvidencePageBytes = material.target.materials.map(
          (entry) =>
            serializeWorkspaceSearchMigrationTargetEvidencePage(entry.page),
        )
        const historicalReceiptBindings:
          WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding[] = []
        for (
          const transition of
          result.planningAuthorityProvenance.authorityTransitions
        ) {
          const binding =
            await this.readHistoricalMaintenanceEvidenceBinding(
              authority.request.runId,
              transition.maintenanceEvidenceReceiptDigest,
            )
          if (binding === undefined) {
            return failManagedPlanningJoin('INVALID_STATE')
          }
          historicalReceiptBindings.push(binding)
        }
        await this.requireCurrentPlanningJoinTableIncarnations(authority)
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        const gateway = this.createPlanningArtifactGateway(
          authority.request.runId,
        )
        return {
          result,
          writePlanningProvenanceArtifact: async (writeInput) => {
            const retainUntil = await runManagedPlanningJoinAwsBoundary(
              async () =>
                detachPreparedPlanningProvenanceWriteInput(writeInput),
            )
            return gateway.writePlanningProvenanceArtifact({
              sourceEvidencePageBytes,
              targetEvidencePageBytes,
              historicalReceiptBindings,
              retainUntil,
            })
          },
        }
      } catch (error: unknown) {
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        await this.requireCurrentPlanningJoinTableIncarnations(authority)
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        throw error
      }
    })
  }

  /**
   * Fixes five heads, reads exact material, and joins it under one generation.
   *
   * @param input - Caller-owned run, configuration, hash, and limits.
   * @returns Private material paired with its fully revalidated join result.
   */
  private async prepareManagedPlanningJoin(
    input: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput,
  ): Promise<ManagedPlanningJoinPreparation> {
    const authority = this.captureManagedPlanningJoinAuthority(input)
    const sourceContexts =
      this.createManagedPlanningSourceEvidenceContexts(authority)
    const targetContext =
      this.createManagedPlanningTargetEvidenceContext(authority)
    try {
      await this.requireCurrentPlanningJoinTableIncarnations(authority)
      const capturedHeads = await this.readManagedPlanningEvidenceHeads(
        sourceContexts,
        targetContext,
      )
      this.requireManagedPlanningEvidenceHeadPreflight(
        capturedHeads,
        authority.request.limits,
      )
      const material = await this.readManagedPlanningEvidenceMaterial(
        sourceContexts,
        targetContext,
        capturedHeads,
        authority.request.limits,
      )
      const result = joinWorkspaceSearchMigrationPlanningEvidence({
        runId: authority.request.runId,
        configuration: authority.request.configuration,
        configurationHash: authority.request.configurationHash,
        limits: authority.request.limits,
        sourcePages: {
          'project-directory':
            material.sources['project-directory'].materials,
          'work-items': material.sources['work-items'].materials,
          collaboration: material.sources.collaboration.materials,
          documents: material.sources.documents.materials,
        },
        targetPages: material.target.materials,
      })
      const confirmedHeads = await this.readManagedPlanningEvidenceHeads(
        sourceContexts,
        targetContext,
      )
      this.requireManagedPlanningEvidenceHeadsEqual(
        capturedHeads,
        confirmedHeads,
      )
      await this.requireCurrentPlanningJoinTableIncarnations(authority)
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      return { authority, material, result }
    } catch (error: unknown) {
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      await this.requireCurrentPlanningJoinTableIncarnations(authority)
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      throw error
    }
  }

  /**
   * Detaches one managed planning-join request before the first guard await.
   *
   * @param input - Caller-owned run, configuration, hash, and limits.
   * @returns One request fixed to the current measured session generation.
   */
  private captureManagedPlanningJoinAuthority(
    input: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput,
  ): ManagedPlanningJoinAuthority {
    const detached = detachManagedPlanningJoinInput(input)
    const request: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput = {
      ...detached,
      runId: requireMigrationIdentifier(detached.runId, 'Run ID'),
    }
    this.requireManagedPlanningJoinLimits(request.limits)
    const authority = this.captureManagedMigrationStateAuthority()
    if (
      request.configurationHash !== authority.configurationHash ||
      createManagedPlanningConfigurationHash(request.configuration) !==
        authority.configurationHash
    ) {
      return failManagedPlanningJoin(
        'CONFIGURATION_HASH_MISMATCH',
      )
    }
    this.requireMeasuredConfigurationBinding(request.configuration)
    return {
      ...authority,
      request,
    }
  }

  /**
   * Requires the three public planning limits to be positive safe integers.
   *
   * @param limits - Detached caller-selected material ceilings.
   */
  private requireManagedPlanningJoinLimits(
    limits: WorkspaceSearchMigrationPlanningJoinLimits,
  ): void {
    if (
      !Number.isSafeInteger(limits.maxTotalRows) ||
      limits.maxTotalRows <= 0 ||
      limits.maxTotalRows >
        WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_TOTAL_ROWS ||
      !Number.isSafeInteger(limits.maxTotalCanonicalItemBytes) ||
      limits.maxTotalCanonicalItemBytes <= 0 ||
      limits.maxTotalCanonicalItemBytes >
        WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_CANONICAL_BYTES ||
      !Number.isSafeInteger(limits.maxPlanOperations) ||
      limits.maxPlanOperations <= 0 ||
      limits.maxPlanOperations >
        WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_OPERATIONS
    ) {
      return failManagedPlanningJoin('INVALID_ARGUMENT')
    }
  }

  /**
   * Creates four source evidence adapters from one captured generation.
   *
   * @param authority - Shared measured planning-join authority.
   * @returns Fixed source-role request and adapter contexts.
   */
  private createManagedPlanningSourceEvidenceContexts(
    authority: ManagedPlanningJoinAuthority,
  ): ManagedPlanningSourceEvidenceContexts {
    return {
      'project-directory':
        this.createManagedPlanningSourceEvidenceContext(
          authority,
          'project-directory',
        ),
      'work-items': this.createManagedPlanningSourceEvidenceContext(
        authority,
        'work-items',
      ),
      collaboration: this.createManagedPlanningSourceEvidenceContext(
        authority,
        'collaboration',
      ),
      documents: this.createManagedPlanningSourceEvidenceContext(
        authority,
        'documents',
      ),
    }
  }

  /**
   * Creates one source adapter without recapturing session authority.
   *
   * @param authority - Shared measured planning-join authority.
   * @param source - Fixed logical source role for this chain.
   * @returns Exact request and ephemeral adapter.
   */
  private createManagedPlanningSourceEvidenceContext(
    authority: ManagedPlanningJoinAuthority,
    source: WorkspaceSearchMigrationSourceName,
  ): ManagedPlanningSourceEvidenceContext {
    const request: WorkspaceSearchMigrationSourceEvidenceAwsRequest = {
      runId: authority.request.runId,
      purpose: 'planning',
      configuration: authority.request.configuration,
      configurationHash: authority.request.configurationHash,
      source,
    }
    const adapter = this.createManagedSourceEvidenceAdapter(
      {
        generation: authority.generation,
        configurationHash: authority.configurationHash,
        stateTable: authority.stateTable,
        request,
      },
      { finalized: false },
    )
    return { request, adapter }
  }

  /**
   * Creates the target adapter without recapturing session authority.
   *
   * @param authority - Shared measured planning-join authority.
   * @returns Exact target request and ephemeral adapter.
   */
  private createManagedPlanningTargetEvidenceContext(
    authority: ManagedPlanningJoinAuthority,
  ): ManagedPlanningTargetEvidenceContext {
    const request: WorkspaceSearchMigrationTargetEvidenceAwsRequest = {
      runId: authority.request.runId,
      purpose: 'planning',
      configuration: authority.request.configuration,
      configurationHash: authority.request.configurationHash,
    }
    const adapter = this.createManagedTargetEvidenceAdapter(
      {
        generation: authority.generation,
        configurationHash: authority.configurationHash,
        stateTable: authority.stateTable,
        request,
      },
      { finalized: false },
    )
    return { request, adapter }
  }

  /**
   * Strongly reads all five evidence heads in canonical source-then-target order.
   *
   * @param sources - Four source adapter contexts sharing one authority.
   * @param target - Target adapter context sharing the same authority.
   * @returns Detached exact progress for every chain.
   */
  private async readManagedPlanningEvidenceHeads(
    sources: ManagedPlanningSourceEvidenceContexts,
    target: ManagedPlanningTargetEvidenceContext,
  ): Promise<ManagedPlanningEvidenceHeads> {
    const projectDirectory =
      await sources['project-directory'].adapter.readProgress(
        sources['project-directory'].request,
      )
    const workItems = await sources['work-items'].adapter.readProgress(
      sources['work-items'].request,
    )
    const collaboration =
      await sources.collaboration.adapter.readProgress(
        sources.collaboration.request,
      )
    const documents = await sources.documents.adapter.readProgress(
      sources.documents.request,
    )
    const targetProgress = await target.adapter.readProgress(target.request)
    return {
      sources: {
        'project-directory': projectDirectory,
        'work-items': workItems,
        collaboration,
        documents,
      },
      target: targetProgress,
    }
  }

  /**
   * Rejects incomplete or oversized captured heads before any artifact GET.
   *
   * @param heads - Five strongly captured evidence heads.
   * @param limits - Detached total material and operation ceilings.
   */
  private requireManagedPlanningEvidenceHeadPreflight(
    heads: ManagedPlanningEvidenceHeads,
    limits: WorkspaceSearchMigrationPlanningJoinLimits,
  ): void {
    let totalRows = 0
    let totalSourceMapped = 0
    let totalPages = 0
    for (const source of workspaceSearchMigrationSourceNames) {
      const progress = heads.sources[source]
      const pageSequence = requireManagedPlanningHeadCount(
        progress.pageSequence,
      )
      const scanned = requireManagedPlanningHeadCount(
        progress.checkpoint.aggregate.scanned,
      )
      if (
        pageSequence === 0 ||
        progress.checkpoint.aggregate.pageCount !==
          pageSequence ||
        pageSequence >
          addManagedPlanningHeadCount(scanned, 1) ||
        !progress.checkpoint.completed ||
        progress.checkpoint.cursor !== undefined ||
        progress.checkpoint.aggregate.invalid !== 0
      ) {
        return failManagedPlanningJoin('DRY_RUN_INVALID_ROWS')
      }
      totalRows = addManagedPlanningHeadCount(
        totalRows,
        scanned,
      )
      totalSourceMapped = addManagedPlanningHeadCount(
        totalSourceMapped,
        progress.checkpoint.aggregate.mapped,
      )
      totalPages = addManagedPlanningHeadCount(
        totalPages,
        pageSequence,
      )
    }
    const target = heads.target
    const targetPageSequence = requireManagedPlanningHeadCount(
      target.pageSequence,
    )
    const targetScanned = requireManagedPlanningHeadCount(
      target.checkpoint.aggregate.scanned,
    )
    if (
      targetPageSequence === 0 ||
      target.checkpoint.aggregate.pageCount !== targetPageSequence ||
      targetPageSequence >
        addManagedPlanningHeadCount(targetScanned, 1) ||
      !target.checkpoint.completed ||
      target.checkpoint.cursor !== undefined ||
      target.checkpoint.aggregate.invalid !== 0
    ) {
      return failManagedPlanningJoin('DRY_RUN_INVALID_ROWS')
    }
    totalRows = addManagedPlanningHeadCount(
      totalRows,
      targetScanned,
    )
    totalPages = addManagedPlanningHeadCount(
      totalPages,
      targetPageSequence,
    )
    const targetOwned = requireManagedPlanningHeadCount(
      target.checkpoint.aggregate.owned,
    )
    if (
      totalRows > limits.maxTotalRows ||
      Math.max(totalSourceMapped, targetOwned) >
        limits.maxPlanOperations ||
      totalPages >
        WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_EVIDENCE_PAGES
    ) {
      return failManagedPlanningJoin('INVALID_ARGUMENT')
    }
  }

  /**
   * Reads five exact-version material chains against their captured heads.
   *
   * Remaining rows and canonical bytes are passed by value to each adapter,
   * preventing one chain from materializing work reserved for later chains.
   *
   * @param sources - Four source adapter contexts sharing one authority.
   * @param target - Target adapter context sharing the same authority.
   * @param heads - Initial fixed head for every material prefix.
   * @param limits - Detached total material ceilings.
   * @returns Private exact material for the pure planning join.
   */
  private async readManagedPlanningEvidenceMaterial(
    sources: ManagedPlanningSourceEvidenceContexts,
    target: ManagedPlanningTargetEvidenceContext,
    heads: ManagedPlanningEvidenceHeads,
    limits: WorkspaceSearchMigrationPlanningJoinLimits,
  ): Promise<ManagedPlanningEvidenceMaterial> {
    const budget: ManagedPlanningMaterialBudget = {
      rows: limits.maxTotalRows,
      canonicalItemBytes: limits.maxTotalCanonicalItemBytes,
    }
    const projectDirectory =
      await this.readManagedPlanningSourceMaterial(
        sources['project-directory'],
        heads.sources['project-directory'],
        budget,
      )
    const workItems = await this.readManagedPlanningSourceMaterial(
      sources['work-items'],
      heads.sources['work-items'],
      budget,
    )
    const collaboration =
      await this.readManagedPlanningSourceMaterial(
        sources.collaboration,
        heads.sources.collaboration,
        budget,
      )
    const documents = await this.readManagedPlanningSourceMaterial(
      sources.documents,
      heads.sources.documents,
      budget,
    )
    const targetMaterial =
      await this.readManagedPlanningTargetMaterial(
        target,
        heads.target,
        budget,
      )
    return {
      sources: {
        'project-directory': projectDirectory,
        'work-items': workItems,
        collaboration,
        documents,
      },
      target: targetMaterial,
    }
  }

  /**
   * Reads and accounts for one source chain under the remaining total budget.
   *
   * @param context - Exact source request and measured adapter.
   * @param expectedProgress - Initially captured durable head.
   * @param budget - Mutable private remaining total budget.
   * @returns Exact verified source material.
   */
  private async readManagedPlanningSourceMaterial(
    context: ManagedPlanningSourceEvidenceContext,
    expectedProgress: WorkspaceSearchMigrationSourceEvidenceProgress,
    budget: ManagedPlanningMaterialBudget,
  ): Promise<WorkspaceSearchMigrationPlanningSourceChainMaterial> {
    const material = await context.adapter.readPlanningMaterialAtProgress(
      context.request,
      expectedProgress,
      createManagedPlanningMaterialReadLimits(budget),
    )
    this.requireManagedPlanningSourceProgressEqual(
      expectedProgress,
      material.progress,
    )
    this.consumeManagedPlanningMaterialBudget(
      budget,
      material.rowCount,
      material.canonicalItemBytes,
      expectedProgress.checkpoint.aggregate.scanned,
    )
    return material
  }

  /**
   * Reads and accounts for the target chain under the remaining total budget.
   *
   * @param context - Exact target request and measured adapter.
   * @param expectedProgress - Initially captured durable target head.
   * @param budget - Mutable private remaining total budget.
   * @returns Exact verified target material.
   */
  private async readManagedPlanningTargetMaterial(
    context: ManagedPlanningTargetEvidenceContext,
    expectedProgress: WorkspaceSearchMigrationTargetEvidenceProgress,
    budget: ManagedPlanningMaterialBudget,
  ): Promise<WorkspaceSearchMigrationPlanningTargetChainMaterial> {
    const material = await context.adapter.readPlanningMaterialAtProgress(
      context.request,
      expectedProgress,
      createManagedPlanningMaterialReadLimits(budget),
    )
    this.requireManagedPlanningTargetProgressEqual(
      expectedProgress,
      material.progress,
    )
    this.consumeManagedPlanningMaterialBudget(
      budget,
      material.rowCount,
      material.canonicalItemBytes,
      expectedProgress.checkpoint.aggregate.scanned,
    )
    return material
  }

  /**
   * Deducts one trusted adapter result from the remaining material budget.
   *
   * @param budget - Mutable private remaining total budget.
   * @param rowCount - Exact rows retained by one chain.
   * @param canonicalItemBytes - Exact canonical bytes retained by one chain.
   * @param expectedRows - Captured head's exact scanned-row count.
   */
  private consumeManagedPlanningMaterialBudget(
    budget: ManagedPlanningMaterialBudget,
    rowCount: number,
    canonicalItemBytes: number,
    expectedRows: number,
  ): void {
    if (
      !Number.isSafeInteger(rowCount) ||
      rowCount < 0 ||
      !Number.isSafeInteger(canonicalItemBytes) ||
      canonicalItemBytes < 0 ||
      rowCount !== expectedRows ||
      rowCount > budget.rows ||
      canonicalItemBytes > budget.canonicalItemBytes
    ) {
      return failManagedPlanningJoin('INVALID_STATE')
    }
    budget.rows -= rowCount
    budget.canonicalItemBytes -= canonicalItemBytes
  }

  /**
   * Requires every final strong head to equal its initially captured head.
   *
   * @param captured - Initial five head snapshot.
   * @param confirmed - Five heads strongly reread after the pure join.
   */
  private requireManagedPlanningEvidenceHeadsEqual(
    captured: ManagedPlanningEvidenceHeads,
    confirmed: ManagedPlanningEvidenceHeads,
  ): void {
    for (const source of workspaceSearchMigrationSourceNames) {
      this.requireManagedPlanningSourceProgressEqual(
        captured.sources[source],
        confirmed.sources[source],
      )
    }
    this.requireManagedPlanningTargetProgressEqual(
      captured.target,
      confirmed.target,
    )
  }

  /**
   * Requires two source progress heads to have one exact CAS digest.
   *
   * @param expected - Initially captured source head.
   * @param actual - Material or final source head.
   */
  private requireManagedPlanningSourceProgressEqual(
    expected: WorkspaceSearchMigrationSourceEvidenceProgress,
    actual: WorkspaceSearchMigrationSourceEvidenceProgress,
  ): void {
    if (
      createWorkspaceSearchMigrationSourceEvidenceProgressDigest(
        expected,
      ) !==
        createWorkspaceSearchMigrationSourceEvidenceProgressDigest(actual)
    ) {
      return failManagedPlanningJoin('INVALID_STATE')
    }
  }

  /**
   * Requires two target progress heads to have one exact CAS digest.
   *
   * @param expected - Initially captured target head.
   * @param actual - Material or final target head.
   */
  private requireManagedPlanningTargetProgressEqual(
    expected: WorkspaceSearchMigrationTargetEvidenceProgress,
    actual: WorkspaceSearchMigrationTargetEvidenceProgress,
  ): void {
    if (
      createWorkspaceSearchMigrationTargetEvidenceProgressDigest(
        expected,
      ) !==
        createWorkspaceSearchMigrationTargetEvidenceProgressDigest(actual)
    ) {
      return failManagedPlanningJoin('INVALID_STATE')
    }
  }

  /**
   * Revalidates state, all four sources, and the target in fixed order.
   *
   * @param authority - One measured generation and detached configuration.
   */
  private async requireCurrentPlanningJoinTableIncarnations(
    authority: ManagedPlanningJoinAuthority,
  ): Promise<void> {
    await this.runManagedDescribeTableNonPageOperation(async () => {
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      for (const source of workspaceSearchMigrationSourceNames) {
        await this.requireCurrentSourceTableIncarnation(
          authority.request.configuration.tables[source],
          authority.generation,
          authority.configurationHash,
        )
      }
      await this.requireCurrentTargetTableIncarnation(
        authority.request.configuration.tables['workspace-search'],
        authority.generation,
        authority.configurationHash,
      )
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
    })
  }

  /**
   * Marks the exact point where a managed immutable Put reaches its transport.
   *
   * Writes outside a full-verification or partial-rollback cleanup have no
   * operation-local latch. A descendant that outlives its owning callback is
   * rejected before it can reuse the retained send capability.
   */
  private markManagedImmutableArtifactWriteSent(): void {
    const sendState = this.immutableArtifactWriteSendState.getStore()
    if (sendState === undefined) return
    if (!sendState.active) throw invalidIdentityLookup()
    sendState.sent = true
    this.markManagedAwsMutationSent()
  }

  /**
   * Installs one codec-agnostic immutable object port for a measurement.
   *
   * The low-level transport is guarded around every request, while the
   * immutable core remains the sole owner of request and body deadlines.
   *
   * @param configuration - Exact successful identity measurement.
   * @param authority - Generation and hash installing this private port.
   * @param lifecycleSignal - One-way generation lifecycle cancellation.
   * @returns Immutable storage bound to the pinned S3 client and configuration.
   */
  private createManagedPlanningArtifactPort(
    configuration: WorkspaceSearchMigrationConfiguration,
    authority: ManagedPlanningArtifactGenerationAuthority,
    lifecycleSignal: AbortSignal,
  ): WorkspaceSearchMigrationImmutableArtifactAwsPort {
    const transport: WorkspaceSearchMigrationImmutableArtifactAwsTransport = {
      /**
       * Sends one guarded immutable PutObject request.
       *
       * @param command - Exact immutable upload command.
       * @param abortSignal - Deadline signal owned by the immutable core.
       * @returns Raw low-level S3 response.
       */
      putImmutableArtifact: (command, abortSignal) =>
        this.runManagedPlanningArtifactOperation(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            this.markManagedImmutableArtifactWriteSent()
            return this.transport.putImmutableArtifact(
              command,
              abortSignal,
            )
          },
        ),

      /**
       * Sends one guarded immutable HeadObject request.
       *
       * @param command - Exact reconciliation or version-pinned metadata read.
       * @param abortSignal - Deadline signal owned by the immutable core.
       * @returns Raw low-level S3 response.
       */
      headImmutableArtifact: (command, abortSignal) =>
        this.runManagedPlanningArtifactOperation(
          authority,
          () => this.transport.headImmutableArtifact(
            command,
            abortSignal,
          ),
        ),

      /**
       * Sends one guarded exact-version immutable GetObject request.
       *
       * @param command - Exact version-pinned object read.
       * @param abortSignal - Deadline signal owned by the immutable core.
       * @returns Raw low-level S3 response.
       */
      getImmutableArtifact: (command, abortSignal) =>
        this.runManagedPlanningArtifactGetOperation(
          authority,
          () => this.transport.getImmutableArtifact(
            command,
            abortSignal,
          ),
        ),
    }
    return createAwsWorkspaceSearchMigrationImmutableArtifactPort({
      configuration,
      configurationHash: authority.configurationHash,
      maximumObjectBytes:
        WORKSPACE_SEARCH_MIGRATION_PLANNING_ARTIFACT_MAX_OBJECT_BYTES,
      requestTimeoutMilliseconds:
        WORKSPACE_SEARCH_MIGRATION_MANAGED_ARTIFACT_REQUEST_TIMEOUT_MILLISECONDS,
      bodyTimeoutMilliseconds:
        WORKSPACE_SEARCH_MIGRATION_MANAGED_ARTIFACT_REQUEST_TIMEOUT_MILLISECONDS,
      lifecycleSignal,
      clock: this.prePlanAuthorityClock,
      transport,
    })
  }

  /**
   * Cancels and forgets the immutable port owned by the previous generation.
   */
  private invalidateManagedPlanningArtifactPort(): void {
    const abortController =
      this.measuredPlanningArtifactAbortController
    this.measuredPlanningArtifactAbortController = undefined
    this.measuredPlanningArtifactPort = undefined
    abortController?.abort()
  }

  /**
   * Captures the complete configuration installed by current measurement.
   *
   * @returns Detached generation, configuration, hash, and state identity.
   */
  private captureManagedSealedPlanningAuthority():
    ManagedSealedPlanningAuthority {
    const generation = this.generation
    const configurationHash = this.measuredConfigurationHash
    const configuration = this.measuredConfiguration
    const stateTable = this.measuredMigrationStateTable
    if (
      configurationHash === undefined ||
      configuration === undefined ||
      stateTable === undefined
    ) {
      return failManagedSealedPlanningAuthority()
    }
    const authority: ManagedMigrationStateAuthority = {
      generation,
      configurationHash,
      stateTable: structuredClone(stateTable),
    }
    this.requireManagedSealedPlanningAuthority(authority)
    return {
      ...authority,
      configuration: structuredClone(configuration),
    }
  }

  /**
   * Guards one sealed publication operation against lifecycle invalidation.
   *
   * @param authority - Captured complete measurement authority.
   * @param operation - Exact publication adapter or transport operation.
   * @returns Result only while the captured generation remains current.
   */
  private async runManagedSealedPlanningAuthorityOperation<Result>(
    authority: ManagedSealedPlanningAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedAwsMutationDrainOperation(async () => {
      this.requireManagedSealedPlanningAuthority(authority)
      this.requireNewAwsAdmission()
      try {
        const result = await operation()
        this.requireManagedSealedPlanningAuthority(authority)
        return result
      } catch (error: unknown) {
        this.requireManagedSealedPlanningAuthority(authority)
        throw error
      }
    })
  }

  /**
   * Guards one publication read with state-incarnation checks on both sides.
   *
   * @param authority - Captured complete measurement authority.
   * @param operation - Exact strongly consistent publication-root read.
   * @returns Read result only while state identity remains measured.
   */
  private async runManagedSealedPlanningAuthorityRead<Result>(
    authority: ManagedSealedPlanningAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedSealedPlanningAuthority(authority)
    await this.requireCurrentSealedPlanningAuthorityStateIncarnation(
      authority,
    )
    let result: Result
    try {
      result = await operation()
    } catch (error: unknown) {
      this.requireManagedSealedPlanningAuthority(authority)
      await this.requireCurrentSealedPlanningAuthorityStateIncarnation(
        authority,
      )
      throw error
    }
    this.requireManagedSealedPlanningAuthority(authority)
    await this.requireCurrentSealedPlanningAuthorityStateIncarnation(
      authority,
    )
    this.requireManagedSealedPlanningAuthority(authority)
    return result
  }

  /**
   * Requires one captured publication authority to remain current.
   *
   * @param authority - Captured generation and configuration hash.
   */
  private requireManagedSealedPlanningAuthority(
    authority: ManagedPlanningArtifactGenerationAuthority,
  ): void {
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      ) ||
      this.measuredConfiguration === undefined
    ) {
      return failManagedSealedPlanningAuthority()
    }
  }

  /**
   * Revalidates every transaction-owned table immediately before publication.
   *
   * @param authority - Captured measured configuration and generation.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentSealedPlanningAuthorityTableIncarnations(
    authority: ManagedSealedPlanningAuthority,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    await this.runManagedTableIncarnationGuardSequence(guardMode, async () => {
      try {
        await this.requireCurrentMigrationStateTableIncarnation(
          authority,
          guardMode,
        )
        for (const source of workspaceSearchMigrationSourceNames) {
          await this.requireCurrentSourceTableIncarnation(
            authority.configuration.tables[source],
            authority.generation,
            authority.configurationHash,
            guardMode,
          )
        }
        await this.requireCurrentTargetTableIncarnation(
          authority.configuration.tables['workspace-search'],
          authority.generation,
          authority.configurationHash,
          guardMode,
        )
      } catch (error: unknown) {
        throw createManagedSealedPlanningAuthorityFailure(
          readManagedMigrationStateFailureCode(error),
        )
      }
      this.requireManagedSealedPlanningAuthority(authority)
    })
  }

  /**
   * Revalidates and safely classifies the publication state incarnation.
   *
   * @param authority - Captured measured state-table authority.
   */
  private async requireCurrentSealedPlanningAuthorityStateIncarnation(
    authority: ManagedSealedPlanningAuthority,
  ): Promise<void> {
    try {
      await this.requireCurrentMigrationStateTableIncarnation(authority)
    } catch (error: unknown) {
      throw createManagedSealedPlanningAuthorityFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
  }

  /**
   * Protects one irreversible send and its required post-send all-six guards.
   *
   * @param task - Send and reconciliation sequence entered immediately before I/O.
   * @returns Exact task result after protected accounting is durably released.
   */
  private async runManagedDescribeTableMandatoryCleanup<Result>(
    task: () => Promise<Result>,
  ): Promise<Result> {
    const rate = this.describeTableRate
    return rate === undefined
      ? await task()
      : await rate.runMandatoryCleanup(task)
  }

  /**
   * Installs isolated authority for reconciliation belonging to one AWS send.
   *
   * Descendant transport helpers observe the exact same state directly. A
   * reentrant public operation is rejected, and a retained callback cannot
   * reuse the authority after its owning public operation completes.
   *
   * The caller performs its domain-specific lifecycle guard and permit
   * admission as the first statements inside `task`.
   *
   * @param task - Complete public operation that may reach one or more sends.
   * @returns Exact operation result after its drain authority is revoked.
   */
  private async runManagedAwsMutationDrainOperation<Result>(
    task: () => Promise<Result>,
  ): Promise<Result> {
    const inherited = this.awsMutationDrainState.getStore()
    if (inherited !== undefined) {
      throw invalidIdentityLookup()
    }
    const state: ManagedAwsMutationDrainState = {
      active: true,
      sent: false,
    }
    try {
      return await this.awsMutationDrainState.run(state, task)
    } finally {
      state.active = false
    }
  }

  /** Marks that the current public operation reached an AWS mutation send. */
  private markManagedAwsMutationSent(): void {
    const state = this.awsMutationDrainState.getStore()
    if (state === undefined) return
    if (!state.active) throw invalidIdentityLookup()
    state.sent = true
  }

  /**
   * Selects fresh admission or already-admitted reconciliation for a guard.
   *
   * @returns Operation-local table-incarnation guard mode.
   */
  private readManagedTableIncarnationGuardMode():
    ManagedTableIncarnationGuardMode {
    const state = this.awsMutationDrainState.getStore()
    return state?.active === true && state.sent
      ? 'reconciliation'
      : 'new-operation'
  }

  /**
   * Runs one complete table-incarnation sequence on its correct rate surface.
   *
   * @param mode - Fresh, immediate post-send, or later reconciliation mode.
   * @param task - State-only or fixed-order all-six table checks.
   * @returns Exact guard result after serialized rate ownership is released.
   */
  private async runManagedTableIncarnationGuardSequence<Result>(
    mode: ManagedTableIncarnationGuardMode,
    task: () => Promise<Result>,
  ): Promise<Result> {
    if (mode === 'new-operation') {
      return await this.runManagedDescribeTableNonPageOperation(task)
    }
    this.requireOpen()
    if (mode === 'post-send-cleanup') return await task()
    const rate = this.describeTableRate
    return rate === undefined
      ? await task()
      : await rate.runNonPageOperation(task)
  }

  /**
   * Maps one guard mode to its durable DescribeTable accounting phase.
   *
   * @param mode - Fresh, immediate post-send, or reconciliation mode.
   * @returns Exact phase recorded for each physical DescribeTable attempt.
   */
  private readManagedTableIncarnationGuardPhase(
    mode: ManagedTableIncarnationGuardMode,
  ): WorkspaceSearchMigrationDescribeTablePhase {
    if (mode === 'post-send-cleanup') return 'post-send-guard'
    if (mode === 'reconciliation') return 'reconciliation'
    return 'pre-send-guard'
  }

  /** Rejects a new AWS data mutation after shared admission has stopped. */
  private assertNewManagedDataIoAllowed(): void {
    this.requireNewAwsAdmission()
    this.describeTableRate?.assertNewDataIoAllowed()
  }

  /**
   * Serializes one complete all-six read against checkpoint-page admission.
   *
   * @param task - Complete pre-send guard or measurement sequence.
   * @returns Exact task result without borrowing another call chain's page.
   */
  private async runManagedDescribeTableNonPageOperation<Result>(
    task: () => Promise<Result>,
  ): Promise<Result> {
    this.requireNewAwsAdmission()
    const rate = this.describeTableRate
    return rate === undefined
      ? await task()
      : await rate.runNonPageOperation(task)
  }

  /**
   * Reserves the exact reviewed page capacity before logical page data I/O.
   *
   * @param task - Complete apply, verification, or rollback page operation.
   * @returns Exact page result after unused permits are durably released.
   */
  private async runManagedDescribeTableCheckpointPage<Result>(
    task: () => Promise<Result>,
  ): Promise<Result> {
    this.requireNewAwsAdmission()
    const rate = this.describeTableRate
    return rate === undefined
      ? await task()
      : await rate.runCheckpointPage({}, task)
  }

  /**
   * Protects the source planning page's final authoritative transaction.
   *
   * @param authority - Captured source evidence generation and configuration.
   * @param postSendGuard - Operation-local final guard state.
   * @param operation - Exact prepared source evidence transaction.
   * @returns Raw transaction result after a fresh all-six post-guard.
   */
  private async runManagedPreparedSourceEvidenceWrite<Result>(
    authority: ManagedSourceEvidenceAuthority,
    postSendGuard: ManagedPlanningEvidencePostSendGuardState,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedPreparedPlanningEvidenceWrite(
      authority,
      authority.request.configuration,
      postSendGuard,
      createManagedSourceEvidencePreparationFailure,
      operation,
    )
  }

  /**
   * Protects the target planning page's final authoritative transaction.
   *
   * @param authority - Captured target evidence generation and configuration.
   * @param postSendGuard - Operation-local final guard state.
   * @param operation - Exact prepared target evidence transaction.
   * @returns Raw transaction result after a fresh all-six post-guard.
   */
  private async runManagedPreparedTargetEvidenceWrite<Result>(
    authority: ManagedTargetEvidenceAuthority,
    postSendGuard: ManagedPlanningEvidencePostSendGuardState,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedPreparedPlanningEvidenceWrite(
      authority,
      authority.request.configuration,
      postSendGuard,
      createManagedTargetEvidenceFailure,
      operation,
    )
  }

  /**
   * Runs one planning evidence tx and classifies its exact post-send identity.
   *
   * A transport failure is preserved when every fresh table guard succeeds.
   * A failed guard quarantines both the rate controller and this generation.
   * A failure before the transport callback starts remains non-ambiguous.
   *
   * @param authority - Captured measured migration-state authority.
   * @param configuration - Detached configuration owning all six tables.
   * @param postSendGuard - Operation-local final guard state.
   * @param createFailure - Source- or target-specific safe failure factory.
   * @param operation - Exact prepared authoritative transaction.
   * @returns Raw transaction result after final table revalidation.
   */
  private async runManagedPreparedPlanningEvidenceWrite<Result>(
    authority: ManagedMigrationStateAuthority,
    configuration: WorkspaceSearchMigrationConfiguration,
    postSendGuard: ManagedPlanningEvidencePostSendGuardState,
    createFailure: (
      code: WorkspaceSearchMigrationFailureCode,
    ) => WorkspaceSearchMigrationFailure,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      let sent = false
      let result: Result
      try {
        result = await this.runManagedMigrationStateIo(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            sent = true
            this.markManagedAwsMutationSent()
            return operation()
          },
        )
      } catch (error: unknown) {
        if (!sent) throw error
        try {
          await this.requireCurrentPlanningEvidenceTableIncarnations(
            authority,
            configuration,
            createFailure,
            'post-send-cleanup',
          )
        } catch (guardError: unknown) {
          this.quarantineManagedExecutionControl(authority)
          postSendGuard.failure =
            guardError instanceof WorkspaceSearchMigrationFailure
              ? guardError
              : createFailure('INVALID_STATE')
        } finally {
          postSendGuard.finalized = true
        }
        throw error
      }
      try {
        await this.requireCurrentPlanningEvidenceTableIncarnations(
          authority,
          configuration,
          createFailure,
          'post-send-cleanup',
        )
      } catch (error: unknown) {
        this.quarantineManagedExecutionControl(authority)
        postSendGuard.failure =
          error instanceof WorkspaceSearchMigrationFailure
            ? error
            : createFailure('INVALID_STATE')
      } finally {
        postSendGuard.finalized = true
      }
      return result
    })
  }

  /**
   * Revalidates state, all four sources, and target after a planning tx.
   *
   * @param authority - Captured measured generation and state table.
   * @param configuration - Detached exact six-table configuration.
   * @param createFailure - Source- or target-specific safe failure factory.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentPlanningEvidenceTableIncarnations(
    authority: ManagedMigrationStateAuthority,
    configuration: WorkspaceSearchMigrationConfiguration,
    createFailure: (
      code: WorkspaceSearchMigrationFailureCode,
    ) => WorkspaceSearchMigrationFailure,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    await this.runManagedTableIncarnationGuardSequence(guardMode, async () => {
      let guardFailure: WorkspaceSearchMigrationFailure | undefined
      try {
        await this.requireCurrentMigrationStateTableIncarnation(
          authority,
          guardMode,
        )
      } catch (error: unknown) {
        guardFailure = createFailure(
          readManagedMigrationStateFailureCode(error),
        )
      }
      for (const source of workspaceSearchMigrationSourceNames) {
        try {
          await this.requireCurrentSourceTableIncarnation(
            configuration.tables[source],
            authority.generation,
            authority.configurationHash,
            guardMode,
          )
        } catch (error: unknown) {
          if (guardFailure === undefined) {
            guardFailure = createFailure(
              readManagedMigrationStateFailureCode(error),
            )
          }
        }
      }
      try {
        await this.requireCurrentTargetTableIncarnation(
          configuration.tables['workspace-search'],
          authority.generation,
          authority.configurationHash,
          guardMode,
        )
      } catch (error: unknown) {
        if (guardFailure === undefined) {
          guardFailure = createFailure(
            readManagedMigrationStateFailureCode(error),
          )
        }
      }
      try {
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
      } catch (error: unknown) {
        if (guardFailure === undefined) {
          guardFailure = createFailure(
            readManagedMigrationStateFailureCode(error),
          )
        }
      }
      if (guardFailure !== undefined) throw guardFailure
    })
  }

  /**
   * Sends one prepared publication and revalidates all six table incarnations.
   *
   * The pre-send preparation closes drift detected before transaction
   * construction. Repeating the complete check after either success or failure
   * closes replacement races that occur between an earlier source check and
   * the migration-state transaction.
   *
   * @param authority - Captured measured publication authority.
   * @param operation - Exact prepared transaction on the shared client.
   * @returns Raw transaction result only while every table identity stays current.
   */
  private async runManagedPreparedSealedPlanningAuthorityWrite<Result>(
    authority: ManagedSealedPlanningAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      this.requireManagedSealedPlanningAuthority(authority)
      let sent = false
      let result: Result
      try {
        result = await this.runManagedMigrationStateIo(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            sent = true
            this.markManagedAwsMutationSent()
            return operation()
          },
        )
      } catch (error: unknown) {
        if (!sent) throw error
        this.requireManagedSealedPlanningAuthority(authority)
        await this.requireCurrentSealedPlanningAuthorityTableIncarnations(
          authority,
          'post-send-cleanup',
        )
        throw error
      }
      await this.requireCurrentSealedPlanningAuthorityTableIncarnations(
        authority,
        'post-send-cleanup',
      )
      return result
    })
  }

  /**
   * Captures all measured identities installed for execution-boundary work.
   *
   * @returns Detached generation, configuration, hash, and state identity.
   */
  private captureManagedExecutionBoundaryAuthority():
    ManagedExecutionBoundaryAuthority {
    const generation = this.generation
    const configurationHash = this.measuredConfigurationHash
    const configuration = this.measuredConfiguration
    const stateTable = this.measuredMigrationStateTable
    if (
      configurationHash === undefined ||
      configuration === undefined ||
      stateTable === undefined ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedExecutionBoundary()
    }
    const authority: ManagedExecutionBoundaryAuthority = {
      generation,
      configurationHash,
      configuration: structuredClone(configuration),
      stateTable: structuredClone(stateTable),
    }
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      )
    ) {
      return failManagedExecutionBoundary()
    }
    return authority
  }

  /**
   * Guards one execution-boundary operation against lifecycle invalidation.
   *
   * The operation callback runs synchronously inside its isolated drain state,
   * so the standalone adapter detaches input before its first transport await.
   *
   * @param authority - Captured measured execution-boundary authority.
   * @param operation - Standalone adapter operation started in drain context.
   * @returns Result only while the captured generation remains current.
   */
  private async runManagedExecutionBoundaryOperation<Result>(
    authority: ManagedExecutionBoundaryAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedAwsMutationDrainOperation(async () => {
      try {
        this.requireNewAwsAdmission()
        const result = await operation()
        if (
          !this.isMeasurementGenerationCurrent(
            authority.generation,
            authority.configurationHash,
          ) ||
          this.measuredExecutionControlQuarantined
        ) {
          return failManagedExecutionBoundary()
        }
        return result
      } catch (error: unknown) {
        if (
          !this.isMeasurementGenerationCurrent(
            authority.generation,
            authority.configurationHash,
          )
        ) {
          return failManagedExecutionBoundary()
        }
        throw error
      }
    })
  }

  /**
   * Captures all measured identities installed for execution-run admission.
   *
   * @returns Detached generation, configuration, hash, and state identity.
   */
  private captureManagedExecutionRunAuthority():
    ManagedExecutionRunAuthority {
    const generation = this.generation
    const configurationHash = this.measuredConfigurationHash
    const configuration = this.measuredConfiguration
    const stateTable = this.measuredMigrationStateTable
    if (
      configurationHash === undefined ||
      configuration === undefined ||
      stateTable === undefined ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedExecutionRun()
    }
    const authority: ManagedExecutionRunAuthority = {
      generation,
      configurationHash,
      configuration: structuredClone(configuration),
      stateTable: structuredClone(stateTable),
    }
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      )
    ) {
      return failManagedExecutionRun()
    }
    return authority
  }

  /**
   * Guards one execution-run operation against lifecycle invalidation.
   *
   * The callback starts inside isolated drain state and detaches caller input
   * before the first managed transport await.
   *
   * @param authority - Captured measured execution-run authority.
   * @param operation - Standalone adapter operation started in drain context.
   * @returns Result only while the measured generation remains current.
   */
  private async runManagedExecutionRunOperation<Result>(
    authority: ManagedExecutionRunAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedAwsMutationDrainOperation(async () => {
      try {
        this.requireNewAwsAdmission()
        const result = await operation()
        if (
          !this.isMeasurementGenerationCurrent(
            authority.generation,
            authority.configurationHash,
          ) ||
          this.measuredExecutionControlQuarantined
        ) {
          return failManagedExecutionRun()
        }
        return result
      } catch (error: unknown) {
        if (
          !this.isMeasurementGenerationCurrent(
            authority.generation,
            authority.configurationHash,
          )
        ) {
          return failManagedExecutionRun()
        }
        throw error
      }
    })
  }

  /**
   * Guards one execution-run read with all six incarnation checks.
   *
   * @param authority - Captured measured execution-run authority.
   * @param operation - Exact strongly consistent execution-run state read.
   * @returns Read result only while all six identities remain current.
   */
  private async runManagedExecutionRunRead<Result>(
    authority: ManagedExecutionRunAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.runManagedApplicationWriterFenceRead(
        authority,
        operation,
      )
    } catch (error: unknown) {
      throw createManagedExecutionRunFailure(
        error instanceof ResourceNotFoundException
          ? 'CONFIGURATION_DRIFT'
          : readManagedMigrationStateFailureCode(error),
      )
    }
  }

  /**
   * Revalidates all six transaction-owned table incarnations before create.
   *
   * @param authority - Captured measured execution-run authority.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentExecutionRunTableIncarnations(
    authority: ManagedExecutionRunAuthority,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    try {
      await this.requireCurrentApplicationWriterFenceTableIncarnations(
        authority,
        guardMode,
      )
    } catch (error: unknown) {
      throw createManagedExecutionRunFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
  }

  /**
   * Sends one prepared execution-run create and preserves shared quarantine.
   *
   * @param authority - Captured measured execution-run authority.
   * @param operation - Exact prepared seven-item transaction.
   * @returns Raw transaction result after the post-send all-six guard.
   */
  private async runManagedPreparedExecutionRunWrite<Result>(
    authority: ManagedExecutionRunAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      try {
        this.requireManagedApplicationWriterFenceAuthority(authority)
      } catch (error: unknown) {
        throw createManagedExecutionRunFailure(
          readManagedMigrationStateFailureCode(error),
        )
      }
      let sent = false
      let result: Result
      try {
        result = await this.runManagedMigrationStateIo(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            sent = true
            this.markManagedAwsMutationSent()
            return operation()
          },
        )
      } catch (error: unknown) {
        if (!sent) throw error
        try {
          await this.requireCurrentApplicationWriterFenceTableIncarnations(
            authority,
            'post-send-cleanup',
          )
        } catch (guardError: unknown) {
          this.quarantineManagedExecutionControl(authority)
          throw createManagedExecutionRunFailure(
            readManagedMigrationStateFailureCode(guardError),
          )
        }
        throw error
      }
      try {
        await this.requireCurrentApplicationWriterFenceTableIncarnations(
          authority,
          'post-send-cleanup',
        )
      } catch (error: unknown) {
        this.quarantineManagedExecutionControl(authority)
        throw createManagedExecutionRunFailure(
          readManagedMigrationStateFailureCode(error),
        )
      }
      return result
    })
  }

  /**
   * Captures the complete measured authority for one apply-operation port.
   *
   * @returns Detached generation, configuration, state identity, and private
   * immutable object port.
   */
  private captureManagedApplyOperationAuthority():
    ManagedApplyOperationAuthority {
    const generation = this.generation
    const configurationHash = this.measuredConfigurationHash
    const configuration = this.measuredConfiguration
    const stateTable = this.measuredMigrationStateTable
    const immutableArtifactPort = this.measuredPlanningArtifactPort
    if (
      configurationHash === undefined ||
      configuration === undefined ||
      stateTable === undefined ||
      immutableArtifactPort === undefined ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedApplyOperation()
    }
    const authority: ManagedApplyOperationAuthority = {
      generation,
      configurationHash,
      configuration: structuredClone(configuration),
      stateTable: structuredClone(stateTable),
      immutableArtifactPort,
    }
    this.requireManagedApplyOperationAuthority(authority)
    return authority
  }

  /**
   * Guards one complete apply operation against lifecycle invalidation.
   *
   * The callback is invoked synchronously after the initial lifecycle guard so
   * the standalone adapter snapshots caller input before its first await.
   * A post-send ambiguous failure remains visible even after it quarantines the
   * captured generation.
   *
   * @param authority - Captured measured apply-operation authority.
   * @param operation - One standalone apply operation.
   * @returns Result only while the captured generation remains current.
   */
  private async runManagedApplyOperation<Result>(
    authority: ManagedApplyOperationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedAwsMutationDrainOperation(async () => {
      this.requireManagedApplyOperationAuthority(authority)
      this.requireNewAwsAdmission()
      try {
        const result = await operation()
        this.requireManagedApplyOperationAuthority(authority)
        return result
      } catch (error: unknown) {
        if (
          !this.isMeasurementGenerationCurrent(
            authority.generation,
            authority.configurationHash,
          )
        ) {
          return failManagedApplyOperation()
        }
        throw error
      }
    })
  }

  /**
   * Guards one apply read with all six table-incarnation checks on both sides.
   *
   * @param authority - Captured measured apply-operation authority.
   * @param operation - Exact strongly consistent DynamoDB read.
   * @returns Read result only while every measured table remains current.
   */
  private async runManagedApplyOperationRead<Result>(
    authority: ManagedApplyOperationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedApplyOperationAuthority(authority)
    await this.requireCurrentApplyOperationTableIncarnations(authority)
    this.requireManagedApplyOperationAuthority(authority)
    let result: Result
    try {
      result = await operation()
    } catch (error: unknown) {
      this.requireManagedApplyOperationAuthority(authority)
      await this.requireCurrentApplyOperationTableIncarnations(authority)
      throw error
    }
    this.requireManagedApplyOperationAuthority(authority)
    await this.requireCurrentApplyOperationTableIncarnations(authority)
    this.requireManagedApplyOperationAuthority(authority)
    return result
  }

  /**
   * Revalidates all six transaction-owned table incarnations for apply.
   *
   * @param authority - Captured measured apply-operation authority.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentApplyOperationTableIncarnations(
    authority: ManagedApplyOperationAuthority,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    try {
      await this.requireCurrentApplicationWriterFenceTableIncarnations(
        authority,
        guardMode,
      )
    } catch (error: unknown) {
      throw createManagedApplyOperationFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
  }

  /**
   * Sends one prepared apply transaction and quarantines uncertain identity.
   *
   * Once the transaction transport has been invoked, failure of either the
   * success-path or error-path all-six guard makes the commit outcome
   * unreconcilable under the captured measurement. The shared execution
   * generation is quarantined and a public ambiguous-outcome failure is
   * returned so the standalone adapter does not attempt managed reconciliation.
   *
   * @param authority - Captured measured apply-operation authority.
   * @param operation - Exact prepared eleven- or twelve-item transaction.
   * @returns Raw transaction result after the post-send all-six guard.
   */
  private async runManagedPreparedApplyOperationWrite<Result>(
    authority: ManagedApplyOperationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      try {
        this.requireManagedApplyOperationAuthority(authority)
      } catch (error: unknown) {
        throw createManagedApplyOperationFailure(
          readManagedMigrationStateFailureCode(error),
        )
      }
      let sent = false
      let result: Result
      try {
        result = await this.runManagedMigrationStateIo(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            sent = true
            this.markManagedAwsMutationSent()
            return operation()
          },
        )
      } catch (error: unknown) {
        if (!sent) {
          throw createManagedApplyOperationFailure(
            readManagedMigrationStateFailureCode(error),
          )
        }
        try {
          await this.requireCurrentApplyOperationTableIncarnations(
            authority,
            'post-send-cleanup',
          )
        } catch {
          this.quarantineManagedExecutionControl(authority)
          throw createManagedApplyOperationFailure(
            'AMBIGUOUS_OPERATION_UNRESOLVED',
          )
        }
        throw error
      }
      try {
        await this.requireCurrentApplyOperationTableIncarnations(
          authority,
          'post-send-cleanup',
        )
      } catch {
        this.quarantineManagedExecutionControl(authority)
        throw createManagedApplyOperationFailure(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
        )
      }
      return result
    })
  }

  /**
   * Creates an apply-artifact port bound to one measured generation.
   *
   * @param authority - Captured measured apply-operation authority.
   * @returns Immutable storage capability guarded around every S3 operation.
   */
  private createManagedApplyImmutableArtifactPort(
    authority: ManagedApplyOperationAuthority,
  ): WorkspaceSearchMigrationImmutableArtifactAwsPort {
    const delegate = authority.immutableArtifactPort
    return {
      writeImmutableArtifact: (input) =>
        this.runManagedApplyImmutableArtifactOperation(
          authority,
          () => delegate.writeImmutableArtifact(input),
        ),
      readImmutableArtifact: (input) =>
        this.runManagedApplyImmutableArtifactOperation(
          authority,
          () => delegate.readImmutableArtifact(input),
        ),
    }
  }

  /**
   * Guards one journal S3 operation with generation, configuration, and
   * shared-quarantine checks before and after transport activity.
   *
   * @param authority - Captured measured apply-operation authority.
   * @param operation - Exact immutable artifact read or write.
   * @returns Storage result only while apply authority remains usable.
   */
  private async runManagedApplyImmutableArtifactOperation<Result>(
    authority: ManagedApplyOperationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedApplyOperationAuthority(authority)
    try {
      const result = await operation()
      this.requireManagedApplyOperationAuthority(authority)
      return result
    } catch (error: unknown) {
      this.requireManagedApplyOperationAuthority(authority)
      throw error
    }
  }

  /**
   * Requires one captured apply authority and private storage port to remain
   * current and outside the shared execution-control quarantine.
   *
   * @param authority - Captured generation, configuration, and private port.
   */
  private requireManagedApplyOperationAuthority(
    authority: ManagedApplyOperationAuthority,
  ): void {
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      ) ||
      this.measuredConfiguration === undefined ||
      this.measuredPlanningArtifactPort !==
        authority.immutableArtifactPort ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedApplyOperation()
    }
  }

  /**
   * Captures complete measured authority for one full-verification port.
   *
   * @returns Detached generation, configuration, table identity, and private
   * immutable-object port.
   */
  private captureManagedFullVerificationAuthority():
    ManagedFullVerificationAuthority {
    const generation = this.generation
    const configurationHash = this.measuredConfigurationHash
    const configuration = this.measuredConfiguration
    const stateTable = this.measuredMigrationStateTable
    const immutableArtifactPort = this.measuredPlanningArtifactPort
    if (
      configurationHash === undefined ||
      configuration === undefined ||
      stateTable === undefined ||
      immutableArtifactPort === undefined ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedFullVerification()
    }
    const authority: ManagedFullVerificationAuthority = {
      generation,
      configurationHash,
      configuration: structuredClone(configuration),
      stateTable: structuredClone(stateTable),
      immutableArtifactPort,
    }
    this.requireManagedFullVerificationAuthority(authority)
    return authority
  }

  /**
   * Guards one complete full-verification operation against invalidation.
   *
   * @param authority - Captured full-verification authority.
   * @param operation - One standalone verification operation.
   * @returns Result only while the captured generation remains current.
   */
  private async runManagedFullVerificationOperation<Result>(
    authority: ManagedFullVerificationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedAwsMutationDrainOperation(async () => {
      this.requireManagedFullVerificationAuthority(authority)
      this.requireNewAwsAdmission()
      try {
        const result = await operation()
        this.requireManagedFullVerificationAuthority(authority)
        return result
      } catch (error: unknown) {
        if (
          !this.isMeasurementGenerationCurrent(
            authority.generation,
            authority.configurationHash,
          )
        ) {
          return failManagedFullVerification()
        }
        throw error
      }
    })
  }

  /**
   * Guards one verification read or Scan with all six table incarnations.
   *
   * @param authority - Captured full-verification authority.
   * @param operation - Exact read-only operation.
   * @returns Result only while every measured table remains current.
   */
  private async runManagedFullVerificationRead<Result>(
    authority: ManagedFullVerificationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedFullVerificationAuthority(authority)
    await this.requireCurrentFullVerificationTableIncarnations(authority)
    this.requireManagedFullVerificationAuthority(authority)
    let result: Result
    try {
      result = await operation()
    } catch (error: unknown) {
      this.requireManagedFullVerificationAuthority(authority)
      await this.requireCurrentFullVerificationTableIncarnations(authority)
      throw error
    }
    this.requireManagedFullVerificationAuthority(authority)
    await this.requireCurrentFullVerificationTableIncarnations(authority)
    this.requireManagedFullVerificationAuthority(authority)
    return result
  }

  /**
   * Revalidates all six transaction-owned table incarnations for verification.
   *
   * @param authority - Captured full-verification authority.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentFullVerificationTableIncarnations(
    authority: ManagedFullVerificationAuthority,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    try {
      await this.requireCurrentApplicationWriterFenceTableIncarnations(
        authority,
        guardMode,
      )
    } catch (error: unknown) {
      throw createManagedFullVerificationFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
  }

  /**
   * Sends one prepared verification transaction and quarantines stale identity.
   *
   * Once transport begins, a failed post-send all-six guard makes the commit
   * outcome unsafe to reconcile in this generation. The shared execution
   * control is quarantined and ambiguity is surfaced directly.
   *
   * @param authority - Captured full-verification authority.
   * @param operation - Exact prepared verification transaction.
   * @returns Raw transaction result after the post-send all-six guard.
   */
  private async runManagedPreparedFullVerificationWrite<Result>(
    authority: ManagedFullVerificationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      try {
        this.requireManagedFullVerificationAuthority(authority)
      } catch (error: unknown) {
        throw createManagedFullVerificationFailure(
          readManagedMigrationStateFailureCode(error),
        )
      }
      let sent = false
      let result: Result
      try {
        result = await this.runManagedMigrationStateIo(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            sent = true
            this.markManagedAwsMutationSent()
            return operation()
          },
        )
      } catch (error: unknown) {
        if (!sent) {
          throw createManagedFullVerificationFailure(
            readManagedMigrationStateFailureCode(error),
          )
        }
        try {
          await this.requireCurrentFullVerificationTableIncarnations(
            authority,
            'post-send-cleanup',
          )
        } catch {
          this.quarantineManagedExecutionControl(authority)
          throw createManagedFullVerificationFailure(
            'AMBIGUOUS_OPERATION_UNRESOLVED',
          )
        }
        throw error
      }
      try {
        await this.requireCurrentFullVerificationTableIncarnations(
          authority,
          'post-send-cleanup',
        )
      } catch {
        this.quarantineManagedExecutionControl(authority)
        throw createManagedFullVerificationFailure(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
        )
      }
      return result
    })
  }

  /**
   * Creates immutable storage guarded by full-verification measurement.
   *
   * @param authority - Captured full-verification authority.
   * @returns Private immutable storage with guarded reads and writes.
   */
  private createManagedFullVerificationImmutableArtifactPort(
    authority: ManagedFullVerificationAuthority,
  ): WorkspaceSearchMigrationImmutableArtifactAwsPort {
    const delegate = authority.immutableArtifactPort
    return {
      writeImmutableArtifact: (input) =>
        this.runManagedFullVerificationImmutableArtifactWrite(
          authority,
          () => delegate.writeImmutableArtifact(input),
        ),
      readImmutableArtifact: (input) =>
        this.runManagedFullVerificationRead(
          authority,
          () => delegate.readImmutableArtifact(input),
        ),
    }
  }

  /**
   * Guards one immutable-object write and quarantines post-send table drift.
   *
   * @param authority - Captured full-verification authority.
   * @param operation - Exact immutable-object write.
   * @returns Storage result after all-six post-send validation.
   */
  private async runManagedFullVerificationImmutableArtifactWrite<Result>(
    authority: ManagedFullVerificationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedFullVerificationAuthority(authority)
    await this.requireCurrentFullVerificationTableIncarnations(authority)
    this.requireManagedFullVerificationAuthority(authority)
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      this.requireManagedFullVerificationAuthority(authority)
      const sendState: ManagedImmutableArtifactWriteSendState = {
        active: true,
        sent: false,
      }
      let result: Result
      try {
        try {
          result = await this.immutableArtifactWriteSendState.run(
            sendState,
            operation,
          )
        } finally {
          sendState.active = false
        }
      } catch (error: unknown) {
        if (!sendState.sent) {
          throw error
        }
        try {
          await this.requireCurrentFullVerificationTableIncarnations(
            authority,
            'post-send-cleanup',
          )
        } catch {
          this.quarantineManagedExecutionControl(authority)
          throw createManagedFullVerificationFailure(
            'AMBIGUOUS_OPERATION_UNRESOLVED',
          )
        }
        throw error
      }
      if (!sendState.sent) {
        throw createManagedFullVerificationFailure('INVALID_STATE')
      }
      try {
        await this.requireCurrentFullVerificationTableIncarnations(
          authority,
          'post-send-cleanup',
        )
      } catch {
        this.quarantineManagedExecutionControl(authority)
        throw createManagedFullVerificationFailure(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
        )
      }
      return result
    })
  }

  /**
   * Requires one full-verification authority and its private storage to remain
   * current and outside the shared execution-control quarantine.
   *
   * @param authority - Captured generation, configuration, and private port.
   */
  private requireManagedFullVerificationAuthority(
    authority: ManagedFullVerificationAuthority,
  ): void {
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      ) ||
      this.measuredConfiguration === undefined ||
      this.measuredPlanningArtifactPort !==
        authority.immutableArtifactPort ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedFullVerification()
    }
  }

  /**
   * Captures complete measured authority for one rollback-operation port.
   *
   * @returns Detached generation, configuration, table identity, and private
   * immutable-object port.
   */
  private captureManagedRollbackOperationAuthority():
    ManagedRollbackOperationAuthority {
    const generation = this.generation
    const configurationHash = this.measuredConfigurationHash
    const configuration = this.measuredConfiguration
    const stateTable = this.measuredMigrationStateTable
    const immutableArtifactPort = this.measuredPlanningArtifactPort
    if (
      configurationHash === undefined ||
      configuration === undefined ||
      stateTable === undefined ||
      immutableArtifactPort === undefined ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedRollbackOperation()
    }
    const authority: ManagedRollbackOperationAuthority = {
      generation,
      configurationHash,
      configuration: structuredClone(configuration),
      stateTable: structuredClone(stateTable),
      immutableArtifactPort,
    }
    this.requireManagedRollbackOperationAuthority(authority)
    return authority
  }

  /**
   * Guards one complete rollback operation against lifecycle invalidation.
   *
   * @param authority - Captured rollback-operation authority.
   * @param operation - One standalone rollback operation.
   * @returns Result only while the captured generation remains current.
   */
  private async runManagedRollbackOperation<Result>(
    authority: ManagedRollbackOperationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedAwsMutationDrainOperation(async () => {
      this.requireManagedRollbackOperationAuthority(authority)
      this.requireNewAwsAdmission()
      try {
        const result = await operation()
        this.requireManagedRollbackOperationAuthority(authority)
        return result
      } catch (error: unknown) {
        const code = readManagedMigrationStateFailureCode(error)
        if (code === 'AMBIGUOUS_OPERATION_UNRESOLVED') {
          throw createManagedRollbackOperationFailure(code)
        }
        if (
          !this.isMeasurementGenerationCurrent(
            authority.generation,
            authority.configurationHash,
          )
        ) {
          return failManagedRollbackOperation()
        }
        throw createManagedRollbackOperationFailure(code)
      }
    })
  }

  /**
   * Guards one rollback read with all six table-incarnation checks.
   *
   * @param authority - Captured rollback-operation authority.
   * @param operation - Exact DynamoDB or immutable-object read.
   * @returns Read result only while every measured table remains current.
   */
  private async runManagedRollbackOperationRead<Result>(
    authority: ManagedRollbackOperationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedRollbackOperationAuthority(authority)
    await this.requireCurrentRollbackOperationTableIncarnations(
      authority,
    )
    this.requireManagedRollbackOperationAuthority(authority)
    let result: Result
    try {
      result = await operation()
    } catch (error: unknown) {
      this.requireManagedRollbackOperationAuthority(authority)
      await this.requireCurrentRollbackOperationTableIncarnations(
        authority,
      )
      throw error
    }
    this.requireManagedRollbackOperationAuthority(authority)
    await this.requireCurrentRollbackOperationTableIncarnations(
      authority,
    )
    this.requireManagedRollbackOperationAuthority(authority)
    return result
  }

  /**
   * Revalidates all six transaction-owned table incarnations for rollback.
   *
   * @param authority - Captured rollback-operation authority.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentRollbackOperationTableIncarnations(
    authority: ManagedRollbackOperationAuthority,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    try {
      await this.requireCurrentApplicationWriterFenceTableIncarnations(
        authority,
        guardMode,
      )
    } catch (error: unknown) {
      throw createManagedRollbackOperationFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
  }

  /**
   * Sends one prepared rollback transaction and quarantines stale identity.
   *
   * Once transport begins, a failed post-send all-six guard makes the commit
   * outcome unsafe to reconcile in this generation. The shared execution
   * control is quarantined and ambiguity is surfaced directly.
   *
   * @param authority - Captured rollback-operation authority.
   * @param operation - Exact prepared rollback transaction.
   * @returns Raw transaction result after the post-send all-six guard.
   */
  private async runManagedPreparedRollbackOperationWrite<Result>(
    authority: ManagedRollbackOperationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      try {
        this.requireManagedRollbackOperationAuthority(authority)
      } catch (error: unknown) {
        throw createManagedRollbackOperationFailure(
          readManagedMigrationStateFailureCode(error),
        )
      }
      let sent = false
      let result: Result
      try {
        result = await this.runManagedMigrationStateIo(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            sent = true
            this.markManagedAwsMutationSent()
            return operation()
          },
        )
      } catch (error: unknown) {
        if (!sent) {
          throw createManagedRollbackOperationFailure(
            readManagedMigrationStateFailureCode(error),
          )
        }
        try {
          await this.requireCurrentRollbackOperationTableIncarnations(
            authority,
            'post-send-cleanup',
          )
        } catch {
          this.quarantineManagedExecutionControl(authority)
          throw createManagedRollbackOperationFailure(
            'AMBIGUOUS_OPERATION_UNRESOLVED',
          )
        }
        throw error
      }
      try {
        await this.requireCurrentRollbackOperationTableIncarnations(
          authority,
          'post-send-cleanup',
        )
      } catch {
        this.quarantineManagedExecutionControl(authority)
        throw createManagedRollbackOperationFailure(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
        )
      }
      return result
    })
  }

  /**
   * Creates committed-prefix rollback storage guarded by one measured
   * generation and all six table incarnations.
   *
   * The write path is required only for the immutable committed-prefix seal;
   * journal reads and seal retries use the same pinned S3 client.
   *
   * @param authority - Captured rollback-operation authority.
   * @returns Private immutable storage with guarded reads and writes.
   */
  private createManagedPartialRollbackImmutableArtifactPort(
    authority: ManagedRollbackOperationAuthority,
  ): WorkspaceSearchMigrationImmutableArtifactAwsPort {
    const delegate = authority.immutableArtifactPort
    return {
      writeImmutableArtifact: (input) =>
        this.runManagedPartialRollbackImmutableArtifactWrite(
          authority,
          () => delegate.writeImmutableArtifact(input),
        ),
      readImmutableArtifact: (input) =>
        this.runManagedRollbackOperationRead(
          authority,
          () => delegate.readImmutableArtifact(input),
        ),
    }
  }

  /**
   * Guards one committed-prefix seal write and quarantines any post-send
   * table-incarnation drift.
   *
   * @param authority - Captured rollback-operation authority.
   * @param operation - Exact immutable-object write.
   * @returns Storage result after all-six post-send validation.
   */
  private async runManagedPartialRollbackImmutableArtifactWrite<Result>(
    authority: ManagedRollbackOperationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedRollbackOperationAuthority(authority)
    await this.requireCurrentRollbackOperationTableIncarnations(
      authority,
    )
    this.requireManagedRollbackOperationAuthority(authority)
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      this.requireManagedRollbackOperationAuthority(authority)
      const sendState: ManagedImmutableArtifactWriteSendState = {
        active: true,
        sent: false,
      }
      let result: Result
      try {
        try {
          result = await this.immutableArtifactWriteSendState.run(
            sendState,
            operation,
          )
        } finally {
          sendState.active = false
        }
      } catch (error: unknown) {
        if (!sendState.sent) throw error
        try {
          await this.requireCurrentRollbackOperationTableIncarnations(
            authority,
            'post-send-cleanup',
          )
        } catch {
          this.quarantineManagedExecutionControl(authority)
          throw createManagedRollbackOperationFailure(
            'AMBIGUOUS_OPERATION_UNRESOLVED',
          )
        }
        throw error
      }
      if (!sendState.sent) {
        throw createManagedRollbackOperationFailure('INVALID_STATE')
      }
      try {
        await this.requireCurrentRollbackOperationTableIncarnations(
          authority,
          'post-send-cleanup',
        )
      } catch {
        this.quarantineManagedExecutionControl(authority)
        throw createManagedRollbackOperationFailure(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
        )
      }
      return result
    })
  }

  /**
   * Creates read-only immutable storage guarded by rollback measurement.
   *
   * @param authority - Captured rollback-operation authority.
   * @returns Private immutable storage with guarded reads and no write path.
   */
  private createManagedRollbackImmutableArtifactPort(
    authority: ManagedRollbackOperationAuthority,
  ): WorkspaceSearchMigrationImmutableArtifactAwsPort {
    const delegate = authority.immutableArtifactPort
    return {
      writeImmutableArtifact: async () =>
        failManagedRollbackOperation(),
      readImmutableArtifact: (input) =>
        this.runManagedRollbackOperationRead(
          authority,
          () => delegate.readImmutableArtifact(input),
        ),
    }
  }

  /**
   * Requires one rollback authority and its private storage to remain current.
   *
   * @param authority - Captured generation, configuration, and private port.
   */
  private requireManagedRollbackOperationAuthority(
    authority: ManagedRollbackOperationAuthority,
  ): void {
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      ) ||
      this.measuredConfiguration === undefined ||
      this.measuredPlanningArtifactPort !==
        authority.immutableArtifactPort ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedRollbackOperation()
    }
  }

  /**
   * Captures all measured identities installed for writer-fence operations.
   *
   * @returns Detached generation, configuration, hash, and state identity.
   */
  private captureManagedApplicationWriterFenceAuthority():
    ManagedApplicationWriterFenceAuthority {
    const generation = this.generation
    const configurationHash = this.measuredConfigurationHash
    const configuration = this.measuredConfiguration
    const stateTable = this.measuredMigrationStateTable
    if (
      configurationHash === undefined ||
      configuration === undefined ||
      stateTable === undefined ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedApplicationWriterFence()
    }
    const authority: ManagedApplicationWriterFenceAuthority = {
      generation,
      configurationHash,
      configuration: structuredClone(configuration),
      stateTable: structuredClone(stateTable),
    }
    this.requireManagedApplicationWriterFenceAuthority(authority)
    return authority
  }

  /**
   * Guards one complete writer-fence operation against lifecycle invalidation.
   *
   * The callback starts inside isolated drain state and detaches caller input
   * before its first guarded transport await.
   *
   * @param authority - Captured measured writer-fence authority.
   * @param operation - Adapter operation started inside its drain context.
   * @returns Result only while the captured measurement remains authoritative.
   */
  private async runManagedApplicationWriterFenceOperation<Result>(
    authority: ManagedApplicationWriterFenceAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedAwsMutationDrainOperation(async () => {
      this.requireManagedApplicationWriterFenceAuthority(authority)
      this.requireNewAwsAdmission()
      try {
        const result = await operation()
        this.requireManagedApplicationWriterFenceAuthority(authority)
        return result
      } catch (error: unknown) {
        if (
          !this.isMeasurementGenerationCurrent(
            authority.generation,
            authority.configurationHash,
          )
        ) {
          return failManagedApplicationWriterFence()
        }
        throw error
      }
    })
  }

  /**
   * Requires one captured writer-fence authority to remain current and usable.
   *
   * @param authority - Captured generation and measured configuration hash.
   */
  private requireManagedApplicationWriterFenceAuthority(
    authority: ManagedApplicationWriterFenceAuthority,
  ): void {
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      ) ||
      this.measuredConfiguration === undefined ||
      this.measuredExecutionControlQuarantined
    ) {
      return failManagedApplicationWriterFence()
    }
  }

  /**
   * Guards one writer-fence read with all six incarnation checks on both sides.
   *
   * @param authority - Captured measured writer-fence authority.
   * @param operation - Exact strongly consistent control-row read.
   * @returns Read result only while every fenced table stays current.
   */
  private async runManagedApplicationWriterFenceRead<Result>(
    authority: ManagedApplicationWriterFenceAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedApplicationWriterFenceAuthority(authority)
    await this.requireCurrentApplicationWriterFenceTableIncarnations(
      authority,
    )
    this.requireManagedApplicationWriterFenceAuthority(authority)
    let result: Result
    try {
      result = await operation()
    } catch (error: unknown) {
      this.requireManagedApplicationWriterFenceAuthority(authority)
      await this.requireCurrentApplicationWriterFenceTableIncarnations(
        authority,
      )
      throw error
    }
    this.requireManagedApplicationWriterFenceAuthority(authority)
    await this.requireCurrentApplicationWriterFenceTableIncarnations(
      authority,
    )
    this.requireManagedApplicationWriterFenceAuthority(authority)
    return result
  }

  /**
   * Revalidates state, all four sources, and target in fixed fence order.
   *
   * @param authority - Captured measured configuration and generation.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentApplicationWriterFenceTableIncarnations(
    authority: ManagedApplicationWriterFenceAuthority,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    await this.runManagedTableIncarnationGuardSequence(guardMode, async () => {
      this.requireManagedApplicationWriterFenceAuthority(authority)
      try {
        await this.requireCurrentMigrationStateTableIncarnation(
          authority,
          guardMode,
        )
        for (const source of workspaceSearchMigrationSourceNames) {
          await this.requireCurrentSourceTableIncarnation(
            authority.configuration.tables[source],
            authority.generation,
            authority.configurationHash,
            guardMode,
          )
        }
        await this.requireCurrentTargetTableIncarnation(
          authority.configuration.tables['workspace-search'],
          authority.generation,
          authority.configurationHash,
          guardMode,
        )
      } catch (error: unknown) {
        throw createManagedApplicationWriterFenceFailure(
          readManagedMigrationStateFailureCode(error),
        )
      }
      this.requireManagedApplicationWriterFenceAuthority(authority)
    })
  }

  /**
   * Sends one prepared fence transition and guards its uncertain commit result.
   *
   * A failure of the post-transaction six-table guard quarantines the complete
   * measurement generation. No port from that generation may reconcile or
   * continue control-row operations; a replacement measurement must
   * re-establish identities before the closed state can be inspected.
   *
   * @param authority - Captured measured writer-fence authority.
   * @param operation - Exact prepared transaction on the shared client.
   * @returns Raw transaction result only after every identity is revalidated.
   */
  private async runManagedPreparedApplicationWriterFenceWrite<Result>(
    authority: ManagedApplicationWriterFenceAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      this.requireManagedApplicationWriterFenceAuthority(authority)
      let sent = false
      let result: Result
      try {
        result = await this.runManagedMigrationStateIo(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            sent = true
            this.markManagedAwsMutationSent()
            return operation()
          },
        )
      } catch (error: unknown) {
        if (!sent) throw error
        try {
          await this.requireCurrentApplicationWriterFenceTableIncarnations(
            authority,
            'post-send-cleanup',
          )
        } catch (guardError: unknown) {
          this.quarantineManagedExecutionControl(authority)
          throw guardError
        }
        throw error
      }
      try {
        await this.requireCurrentApplicationWriterFenceTableIncarnations(
          authority,
          'post-send-cleanup',
        )
      } catch (error: unknown) {
        this.quarantineManagedExecutionControl(authority)
        throw error
      }
      return result
    })
  }

  /**
   * Permanently quarantines one still-current execution-control generation.
   *
   * @param authority - Generation whose commit outcome became uncertain.
   */
  private quarantineManagedExecutionControl(
    authority: ManagedMigrationStateAuthority,
  ): void {
    if (
      this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      ) &&
      !this.measuredExecutionControlQuarantined
    ) {
      this.measuredExecutionControlQuarantined = true
      try {
        this.describeTableRate?.quarantine()
      } finally {
        this.recordManagedExecutionControlQuarantineSafely()
      }
    }
  }

  /** Records one bounded quarantine event without changing primary control flow. */
  private recordManagedExecutionControlQuarantineSafely(): void {
    try {
      this.telemetryRecorder?.record({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        kind: 'quarantine',
        phase: 'post-send-guard',
        reason: 'configuration-mismatch',
      })
    } catch {
      // Quarantine remains authoritative when optional observation fails.
    }
  }

  /**
   * Captures the private immutable port installed by current measurement.
   *
   * @returns Current generation, configuration hash, and private object port.
   */
  private captureManagedPlanningArtifactAuthority():
    ManagedPlanningArtifactAuthority {
    this.requireNewAwsAdmission()
    const configurationHash = this.measuredConfigurationHash
    const immutableArtifactPort = this.measuredPlanningArtifactPort
    if (
      configurationHash === undefined ||
      immutableArtifactPort === undefined
    ) {
      return failManagedPlanningArtifact()
    }
    const authority: ManagedPlanningArtifactAuthority = {
      generation: this.generation,
      configurationHash,
      immutableArtifactPort,
    }
    this.requireManagedPlanningArtifactAuthority(authority)
    return authority
  }

  /**
   * Captures measured configuration for one synchronous artifact preflight.
   *
   * @returns Current generation, configuration hash, and detached configuration.
   */
  private captureManagedPlanningArtifactPreflightAuthority():
    ManagedPlanningArtifactPreflightAuthority {
    try {
      this.requireNewAwsAdmission()
    } catch {
      return failManagedPlanningArtifactPreflight('INVALID_STATE')
    }
    const configurationHash = this.measuredConfigurationHash
    const configuration = this.measuredConfiguration
    if (
      configurationHash === undefined ||
      configuration === undefined
    ) {
      return failManagedPlanningArtifactPreflight('INVALID_STATE')
    }
    const authority: ManagedPlanningArtifactPreflightAuthority = {
      generation: this.generation,
      configurationHash,
      configuration: structuredClone(configuration),
    }
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      )
    ) {
      return failManagedPlanningArtifactPreflight('INVALID_STATE')
    }
    return authority
  }

  /**
   * Guards one planning storage step against session lifecycle changes.
   *
   * The callback is invoked synchronously before the first await so the
   * standalone gateway snapshots caller input before storage I/O. Lifecycle
   * invalidation takes precedence over any concurrent lower-layer failure.
   *
   * @param authority - Measurement generation captured for this gateway.
   * @param operation - One high- or low-level immutable storage operation.
   * @returns Result only while the captured measurement remains current.
   */
  private async runManagedPlanningArtifactOperation<Result>(
    authority: ManagedPlanningArtifactGenerationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireManagedPlanningArtifactAuthority(authority)
    try {
      const result = await operation()
      this.requireManagedPlanningArtifactAuthority(authority)
      return result
    } catch (error: unknown) {
      this.requireManagedPlanningArtifactAuthority(authority)
      throw error
    }
  }

  /**
   * Admits one new high-level immutable artifact operation under the permit.
   *
   * Low-level reconciliation requests remain on
   * `runManagedPlanningArtifactOperation` so cleanup already admitted before
   * permit expiry can still converge an uncertain immutable write.
   *
   * @param authority - Measurement generation captured by the public gateway.
   * @param operation - One complete new artifact operation.
   * @returns Result while permit and measurement authority remain current.
   */
  private async runNewManagedPlanningArtifactOperation<Result>(
    authority: ManagedPlanningArtifactGenerationAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      this.requireNewAwsAdmission()
    } catch {
      return failManagedPlanningArtifact()
    }
    return await this.runManagedPlanningArtifactOperation(
      authority,
      operation,
    )
  }

  /**
   * Guards one GetObject and releases its body if lifecycle authority changed.
   *
   * S3 may resolve GetObject after response headers while retaining a streaming
   * body. A replacement measurement must not leak that body when rejecting the
   * stale output before the immutable core can consume it.
   *
   * @param authority - Measurement generation captured for this gateway.
   * @param operation - Exact low-level immutable GetObject operation.
   * @returns Raw GetObject output only while authority remains current.
   */
  private async runManagedPlanningArtifactGetOperation(
    authority: ManagedPlanningArtifactGenerationAuthority,
    operation: () => Promise<GetObjectCommandOutput>,
  ): Promise<GetObjectCommandOutput> {
    this.requireManagedPlanningArtifactAuthority(authority)
    let output: GetObjectCommandOutput
    try {
      output = await operation()
    } catch (error: unknown) {
      this.requireManagedPlanningArtifactAuthority(authority)
      throw error
    }
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      )
    ) {
      cancelManagedPlanningArtifactGetBody(output)
      return failManagedPlanningArtifact()
    }
    return output
  }

  /**
   * Requires one planning gateway generation to remain current.
   *
   * @param authority - Captured measurement generation and hash.
   */
  private requireManagedPlanningArtifactAuthority(
    authority: ManagedPlanningArtifactGenerationAuthority,
  ): void {
    if (
      !this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      )
    ) {
      return failManagedPlanningArtifact()
    }
  }

  /**
   * Guards one managed operation against session-generation changes.
   *
   * The complete public operation verifies the migration-state incarnation
   * before and after its read phase. Transactions use the stricter write guard.
   *
   * @param authority - Captured measurement authority.
   * @param operation - One exact operation on the shared managed transport.
   * @returns Raw operation result only while authority remains current.
   */
  private async runManagedMigrationStateIo<Result>(
    authority: ManagedMigrationStateAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.requireMeasurementGeneration(
      authority.generation,
      authority.configurationHash,
    )
    try {
      const result = await operation()
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      return result
    } catch (error: unknown) {
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      throw error
    }
  }

  /**
   * Sends one prepared write and revalidates state incarnation only afterward.
   *
   * The authority adapter calls its preparation hook immediately before it
   * captures commit time and constructs the transaction, so this wrapper must
   * not add another pre-send DescribeTable delay.
   *
   * @param authority - Captured measurement authority already prevalidated.
   * @param operation - Exact prepared transaction on the shared client.
   * @returns Raw transaction result only while state identity stays current.
   */
  private async runManagedPreparedMigrationStateWrite<Result>(
    authority: ManagedMigrationStateAuthority,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return await this.runManagedDescribeTableMandatoryCleanup(async () => {
      let sent = false
      let result: Result
      try {
        result = await this.runManagedMigrationStateIo(
          authority,
          () => {
            this.assertNewManagedDataIoAllowed()
            sent = true
            this.markManagedAwsMutationSent()
            return operation()
          },
        )
      } catch (error: unknown) {
        if (!sent) throw error
        this.requireMeasurementGeneration(
          authority.generation,
          authority.configurationHash,
        )
        await this.requireCurrentMigrationStateTableIncarnation(
          authority,
          'post-send-cleanup',
        )
        throw error
      }
      await this.requireCurrentMigrationStateTableIncarnation(
        authority,
        'post-send-cleanup',
      )
      return result
    })
  }

  /**
   * Revalidates the measured migration-state table around managed state I/O.
   *
   * @param authority - Captured generation, hash, and state-table incarnation.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentMigrationStateTableIncarnation(
    authority: ManagedMigrationStateAuthority,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    this.requireMeasurementGeneration(
      authority.generation,
      authority.configurationHash,
    )
    let output: DescribeTableCommandOutput
    try {
      output = await this.runManagedDescribeTable(
        authority.stateTable.tableName,
        this.readManagedTableIncarnationGuardPhase(guardMode),
      )
    } catch (error: unknown) {
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      if (error instanceof ResourceNotFoundException) {
        return failSourceScanAws('CONFIGURATION_DRIFT')
      }
      throw error
    }
    this.requireMeasurementGeneration(
      authority.generation,
      authority.configurationHash,
    )
    const observed = output.Table
    const creationTime = observed?.CreationDateTime
    let creationTimeMilliseconds: number | undefined
    try {
      creationTimeMilliseconds = creationTime instanceof Date
        ? Date.prototype.getTime.call(creationTime)
        : undefined
    } catch {
      return failSourceScanAws('CONFIGURATION_DRIFT')
    }
    if (
      observed?.TableStatus !== 'ACTIVE' ||
      observed.TableName !== authority.stateTable.tableName ||
      observed.TableArn !== authority.stateTable.tableArn ||
      observed.TableId !== authority.stateTable.tableId ||
      !Number.isFinite(creationTimeMilliseconds) ||
      new Date(creationTimeMilliseconds ?? Number.NaN).toISOString() !==
        authority.stateTable.creationTime
    ) {
      return failSourceScanAws('CONFIGURATION_DRIFT')
    }
    this.requireMeasurementGeneration(
      authority.generation,
      authority.configurationHash,
    )
  }

  /**
   * Requires a detached measured configuration to remain bound to this
   * session's immutable operator-selected resources.
   *
   * @param configuration - Detached configuration authorized for one Scan.
   */
  private requireMeasuredConfigurationBinding(
    configuration: WorkspaceSearchMigrationConfiguration,
  ): void {
    let binding: string
    try {
      binding = createWorkspaceSearchMigrationRequestedResourcesBinding(
        createRequestedResourcesFromConfiguration(configuration),
      )
    } catch {
      return failSourceScanAws('IDENTITY_MISMATCH')
    }
    if (binding !== this.requestedResourcesBinding) {
      return failSourceScanAws('IDENTITY_MISMATCH')
    }
  }

  /**
   * Revalidates one immutable source-table incarnation around source I/O.
   *
   * @param table - Measured source table identity authorized for the Scan.
   * @param generation - Managed-session generation captured before the Scan.
   * @param configurationHash - Measurement authority captured before the Scan.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   */
  private async requireCurrentSourceTableIncarnation(
    table: MigrationTableIdentity,
    generation: number,
    configurationHash: string,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
  ): Promise<void> {
    this.requireMeasurementGeneration(generation, configurationHash)
    let output: DescribeTableCommandOutput
    try {
      output = await this.runManagedDescribeTable(
        table.tableName,
        this.readManagedTableIncarnationGuardPhase(guardMode),
      )
    } catch (error: unknown) {
      this.requireMeasurementGeneration(generation, configurationHash)
      throw error
    }
    this.requireMeasurementGeneration(generation, configurationHash)
    const observed = output.Table
    const creationTime = observed?.CreationDateTime
    let creationTimeMilliseconds: number | undefined
    try {
      creationTimeMilliseconds = creationTime instanceof Date
        ? Date.prototype.getTime.call(creationTime)
        : undefined
    } catch {
      return failSourceScanAws('SOURCE_DRIFT')
    }
    if (
      observed?.TableStatus !== 'ACTIVE' ||
      observed.TableName !== table.tableName ||
      observed.TableArn !== table.tableArn ||
      observed.TableId !== table.tableId ||
      !Number.isFinite(creationTimeMilliseconds) ||
      new Date(creationTimeMilliseconds ?? Number.NaN).toISOString() !==
        table.creationTime
    ) {
      return failSourceScanAws('SOURCE_DRIFT')
    }
    this.requireMeasurementGeneration(generation, configurationHash)
  }

  /**
   * Revalidates the immutable target-table incarnation around target I/O.
   *
   * @param table - Measured target table identity authorized for the Scan.
   * @param generation - Managed-session generation captured before the Scan.
   * @param configurationHash - Measurement authority captured before the Scan.
   * @param guardMode - Fresh admission or already-admitted cleanup context.
   * @param signal - Optional collector or session cancellation signal.
   */
  private async requireCurrentTargetTableIncarnation(
    table: MigrationTableIdentity,
    generation: number,
    configurationHash: string,
    guardMode: ManagedTableIncarnationGuardMode =
      this.readManagedTableIncarnationGuardMode(),
    signal?: AbortSignal,
  ): Promise<void> {
    this.requireMeasurementGeneration(generation, configurationHash)
    let output: DescribeTableCommandOutput
    try {
      output = await this.runManagedDescribeTable(
        table.tableName,
        this.readManagedTableIncarnationGuardPhase(guardMode),
        signal,
      )
    } catch (error: unknown) {
      this.requireMeasurementGeneration(generation, configurationHash)
      if (error instanceof ResourceNotFoundException) {
        return failTargetScanAws('TARGET_DRIFT')
      }
      throw error
    }
    this.requireMeasurementGeneration(generation, configurationHash)
    const observed = output.Table
    const creationTime = observed?.CreationDateTime
    let creationTimeMilliseconds: number | undefined
    try {
      creationTimeMilliseconds = creationTime instanceof Date
        ? Date.prototype.getTime.call(creationTime)
        : undefined
    } catch {
      return failTargetScanAws('TARGET_DRIFT')
    }
    if (
      observed?.TableStatus !== 'ACTIVE' ||
      observed.TableName !== table.tableName ||
      observed.TableArn !== table.tableArn ||
      observed.TableId !== table.tableId ||
      !Number.isFinite(creationTimeMilliseconds) ||
      new Date(creationTimeMilliseconds ?? Number.NaN).toISOString() !==
        table.creationTime
    ) {
      return failTargetScanAws('TARGET_DRIFT')
    }
    this.requireMeasurementGeneration(generation, configurationHash)
  }

  /**
   * Requires one measured-session generation to remain current.
   *
   * @param generation - Generation captured before managed I/O.
   * @param configurationHash - Measurement authority captured before I/O.
   */
  private requireMeasurementGeneration(
    generation: number,
    configurationHash: string,
  ): void {
    if (!this.isMeasurementGenerationCurrent(generation, configurationHash)) {
      return failSourceScanAws('INVALID_STATE')
    }
  }

  /**
   * Checks whether one managed authority remains the current measurement.
   *
   * @param generation - Generation captured before managed I/O.
   * @param configurationHash - Measurement authority captured before I/O.
   * @returns Whether close or replacement measurement has not invalidated it.
   */
  private isMeasurementGenerationCurrent(
    generation: number,
    configurationHash: string,
  ): boolean {
    return !this.closed &&
      !this.rateSealed &&
      this.generation === generation &&
      this.measuredConfigurationHash === configurationHash
  }

  /**
   * Returns the digest of the resource snapshot that configured this port.
   *
   * @returns Lowercase SHA-256 resource-selection digest.
   */
  readRequestedResourcesBinding(): string {
    return this.requestedResourcesBinding
  }

  /**
   * Reads the exact selected table's point-in-time recovery state.
   *
   * @param tableName - Operator-selected physical table name.
   * @returns DynamoDB recovery-state response.
   */
  async describeContinuousBackups(
    tableName: string,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    this.requireNewAwsAdmission()
    this.validateTableName(tableName)
    return this.transport.describeContinuousBackups(
      new DescribeContinuousBackupsCommand({ TableName: tableName }),
    )
  }

  /**
   * Reads the exact selected journal KMS key metadata.
   *
   * @param keyArn - Operator-selected KMS key ARN.
   * @returns Narrow detached KMS key metadata.
   */
  async describeJournalKey(
    keyArn: string,
  ): Promise<WorkspaceSearchMigrationJournalKeyMetadata> {
    this.requireNewAwsAdmission()
    if (keyArn !== this.journalKeyArn) {
      throw invalidIdentityLookup()
    }
    const output = await this.transport.describeKey(
      new DescribeKeyCommand({ KeyId: keyArn }),
    )
    const metadata = output.KeyMetadata
    const arn = metadata?.Arn
    const awsAccountId = metadata?.AWSAccountId
    const keyId = metadata?.KeyId
    const creationDate = metadata?.CreationDate
    const enabled = metadata?.Enabled
    const keyManager = metadata?.KeyManager
    const keyState = metadata?.KeyState
    const keyUsage = metadata?.KeyUsage
    const keySpec = metadata?.KeySpec
    const origin = metadata?.Origin
    const multiRegion = metadata?.MultiRegion
    return {
      arn,
      awsAccountId,
      keyId,
      creationDate: creationDate === undefined
        ? undefined
        : new Date(Date.prototype.getTime.call(creationDate)),
      enabled,
      keyManager,
      keyState,
      keyUsage,
      keySpec,
      origin,
      multiRegion,
    }
  }

  /**
   * Routes one table metadata read through the durable production controller.
   *
   * @param tableName - Exact already allowlisted physical table name.
   * @param phase - Secret-free accounting phase for non-cleanup admission.
   * @param signal - Optional collector or operation cancellation signal.
   * @returns Raw table metadata retained inside the identity boundary.
   */
  private runManagedDescribeTable(
    tableName: string,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    signal?: AbortSignal,
  ): Promise<DescribeTableCommandOutput> {
    if (phase === 'post-send-guard' || phase === 'reconciliation') {
      this.requireOpen()
    } else {
      this.requireNewAwsAdmission()
    }
    const rate = this.describeTableRate
    if (rate !== undefined) {
      return rate.describeTable(tableName, phase, signal)
    }
    return this.transport.describeTable(
      new DescribeTableCommand({ TableName: tableName }),
      signal,
    )
  }

  /**
   * Reads the exact selected table's physical metadata.
   *
   * @param tableName - Operator-selected physical table name.
   * @returns DynamoDB table metadata response.
   */
  async describeTable(tableName: string): Promise<DescribeTableCommandOutput> {
    this.requireNewAwsAdmission()
    this.validateTableName(tableName)
    return this.runManagedDescribeTable(tableName, 'measurement')
  }

  /**
   * Reads the exact selected table's TTL state.
   *
   * @param tableName - Operator-selected physical table name.
   * @returns DynamoDB TTL response.
   */
  async describeTimeToLive(
    tableName: string,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    this.requireNewAwsAdmission()
    this.validateTableName(tableName)
    return this.transport.describeTimeToLive(
      new DescribeTimeToLiveCommand({ TableName: tableName }),
    )
  }

  /**
   * Reads the selected journal bucket's default encryption.
   *
   * @param lookup - Exact owner-bound journal bucket lookup.
   * @returns S3 encryption response.
   */
  async getBucketEncryption(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketEncryptionOutput> {
    this.requireNewAwsAdmission()
    const validatedLookup = this.createJournalLookupSnapshot(lookup)
    return this.transport.getBucketEncryption(
      new GetBucketEncryptionCommand(createBucketLookupInput(validatedLookup)),
    )
  }

  /**
   * Reads the selected journal bucket's access-logging configuration.
   *
   * @param lookup - Exact owner-bound journal bucket lookup.
   * @returns S3 logging response.
   */
  async getBucketLogging(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketLoggingOutput> {
    this.requireNewAwsAdmission()
    const validatedLookup = this.createJournalLookupSnapshot(lookup)
    return this.transport.getBucketLogging(
      new GetBucketLoggingCommand(createBucketLookupInput(validatedLookup)),
    )
  }

  /**
   * Reads the selected journal bucket's versioning state.
   *
   * @param lookup - Exact owner-bound journal bucket lookup.
   * @returns S3 versioning response.
   */
  async getBucketVersioning(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetBucketVersioningOutput> {
    this.requireNewAwsAdmission()
    const validatedLookup = this.createJournalLookupSnapshot(lookup)
    return this.transport.getBucketVersioning(
      new GetBucketVersioningCommand(createBucketLookupInput(validatedLookup)),
    )
  }

  /**
   * Reads and validates the caller identity returned by STS.
   *
   * @returns Complete STS caller identity.
   */
  async readCallerIdentity(): Promise<{
    /** AWS account returned by STS. */
    account: string
    /** Caller ARN returned by STS. */
    arn: string
    /** Caller unique ID returned by STS. */
    userId: string
  }> {
    this.requireNewAwsAdmission()
    const output = await this.transport.getCallerIdentity(
      new GetCallerIdentityCommand({}),
    )
    const account = output.Account
    const arn = output.Arn
    const userId = output.UserId
    if (
      !isNonEmptyString(account) ||
      !isNonEmptyString(arn) ||
      !isNonEmptyString(userId)
    ) {
      throw createWorkspaceSearchMigrationIdentityAdapterFailure(
        'INCOMPLETE_CALLER_IDENTITY',
      )
    }
    return {
      account,
      arn,
      userId,
    }
  }

  /**
   * Reads the selected journal bucket's Object Lock configuration.
   *
   * @param lookup - Exact owner-bound journal bucket lookup.
   * @returns S3 Object Lock response.
   */
  async getObjectLockConfiguration(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): Promise<GetObjectLockConfigurationOutput> {
    this.requireNewAwsAdmission()
    const validatedLookup = this.createJournalLookupSnapshot(lookup)
    return this.transport.getObjectLockConfiguration(
      new GetObjectLockConfigurationCommand(
        createBucketLookupInput(validatedLookup),
      ),
    )
  }

  /**
   * Requires this managed session to retain its AWS clients.
   */
  private requireOpen(): void {
    if (this.closed) throw inactiveManagedIdentityPort()
  }

  /**
   * Requires one new AWS admission to remain inside its time capabilities.
   *
   * Permit or claimed-stage expiry stops new measurements, reads,
   * reservations, and writes. It does not disable `close`, post-send guards,
   * or reconciliation needed to drain an already-admitted operation.
   */
  protected requireNewAwsAdmission(): void {
    this.requireOpen()
    if (this.rateSealed) throw inactiveManagedIdentityPort()
    this.requireRehearsalAdmissionActive()
  }

  /**
   * Returns cancellation tripped by session seal or complete closure.
   *
   * @returns Stable session-owned operational cancellation signal.
   */
  protected readOperationalAbortSignal(): AbortSignal {
    return this.operationalAbortController.signal
  }

  /**
   * Copies dedicated #163 identity authority for measured reconciliation.
   *
   * Generic and production sessions own no such authority and fail closed.
   *
   * @returns Fresh owned key copy, or undefined outside the dedicated root.
   */
  protected copyManagedReconciliationIntegrityKey():
    Uint8Array | undefined {
    return undefined
  }

  /**
   * Requires the current rehearsal permit and claimed stage reservation.
   *
   * Publication-only S3 admission uses this guard after rate sealing, while
   * already-admitted transport reconciliation deliberately does not re-enter
   * it. One trusted instant is shared by both exclusive expiry checks.
   */
  private requireRehearsalAdmissionActive(): void {
    const guard = this.rehearsalGuard
    if (guard === undefined) {
      if (this.claimedRehearsalStageHead !== undefined) {
        throw new WorkspaceSearchMigrationRehearsalPermitError()
      }
      return
    }
    requireNonProductionRehearsalAdmissionActive(
      guard,
      this.claimedRehearsalStageHead,
    )
  }

  /**
   * Requires an asynchronous measurement to remain the current generation.
   *
   * @param generation - Generation captured before identity I/O.
   */
  private requireGeneration(generation: number): void {
    if (this.closed || this.rateSealed || this.generation !== generation) {
      throw inactiveManagedIdentityPort()
    }
  }

  /**
   * Rejects a table lookup outside the reviewed resource selection.
   *
   * @param tableName - Candidate physical table name.
   */
  private validateTableName(tableName: string): void {
    if (!this.tableNames.has(tableName)) {
      throw invalidIdentityLookup()
    }
  }

  /**
   * Snapshots and validates one S3 lookup against the reviewed bucket and
   * account.
   *
   * @param lookup - Candidate journal lookup.
   * @returns Detached owner-bound lookup used to construct one command.
   */
  private createJournalLookupSnapshot(
    lookup: WorkspaceSearchMigrationJournalLookup,
  ): WorkspaceSearchMigrationJournalLookup {
    let snapshot: WorkspaceSearchMigrationJournalLookup
    try {
      snapshot = {
        bucketName: lookup.bucketName,
        expectedBucketOwner: lookup.expectedBucketOwner,
      }
    } catch {
      throw invalidIdentityLookup()
    }
    if (
      snapshot.bucketName !== this.journalBucket ||
      snapshot.expectedBucketOwner !== this.account
    ) {
      throw invalidIdentityLookup()
    }
    return snapshot
  }
}

/** Internal full session hidden behind the dedicated live-only projection. */
class AwsWorkspaceSearchMigrationRehearsalIntegrityPort
  extends AwsWorkspaceSearchMigrationIdentityPort {
  /** Immutable requested resource snapshot used to derive live clients. */
  private readonly integrityRequested:
    WorkspaceSearchMigrationRequestedResourcesSnapshot

  /** Shared exact-ten managed rate owner used by the live adapter. */
  private readonly integrityRate:
    WorkspaceSearchMigrationManagedDescribeTableRate

  /** Authenticated permit retained for exact caller and clock admission. */
  private readonly integrityGuard: NonProductionRehearsalConstructionGuard

  /** Optional construction cancellation retained through the live operation. */
  private readonly integritySessionSignal: AbortSignal | undefined

  /** Exact six integrity tables derived from canonical private bytes. */
  private readonly integrityTables: CrossDomainIntegrityTableNames

  /** Exact File bucket derived from canonical private bytes. */
  private readonly integrityBuckets: CrossDomainIntegrityBucketNames

  /** Permit-matched immutable seven-resource identity digest. */
  private readonly expectedResourceIdentityDigest: string

  /** Canonical owner-only bytes retained until use, seal, or close. */
  private readonly resourceAttestationBytes: Uint8Array

  /** Dedicated result and immutable-resource HMAC key retained privately. */
  private readonly integrityDigestKey: Uint8Array

  /** Whether the sole actual live invocation was already attempted. */
  private liveAttempted = false

  /** Whether retained owner-only bytes and key were already overwritten. */
  private integrityMaterialDestroyed = false

  /** Genuine generic pendings hidden behind this session's outer handles. */
  private readonly integrityPendingStates = new WeakMap<
    object,
    RehearsalIntegrityAwsPendingState
  >()

  /** Enumerable live handles used only for seal/close cleanup. */
  private readonly unfinalizedIntegrityPendings =
    new Set<WorkspaceSearchMigrationRehearsalIntegrityAwsPending>()

  /**
   * Creates one internal permit-backed session after synchronous validation.
   *
   * @param requested - Exact permit-authorized migration resources.
   * @param transport - Main session transport for rate and narrow control reads.
   * @param prePlanAuthorityClock - Internal system authority clock.
   * @param rate - Exact-ten managed DescribeTable owner.
   * @param measurementSessionFactory - Internal shared-rate child factory.
   * @param guard - Authenticated permit and trusted clock.
   * @param claimedStageHead - Optional immutable claimed stage head.
   * @param integrity - Permit-matched private attestation construction.
   * @param sessionSignal - Optional construction/session cancellation.
   */
  constructor(
    requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
    transport: WorkspaceSearchMigrationManagedAwsTransport,
    prePlanAuthorityClock:
      WorkspaceSearchMigrationPrePlanAuthorityClock,
    rate: WorkspaceSearchMigrationManagedDescribeTableRate,
    measurementSessionFactory:
      () => Promise<WorkspaceSearchMigrationManagedIdentityPort>,
    guard: NonProductionRehearsalConstructionGuard,
    claimedStageHead: WorkspaceSearchMigrationRehearsalStageHead | undefined,
    integrity: NonProductionRehearsalIntegrityConstruction,
    sessionSignal: AbortSignal | undefined,
  ) {
    super(
      requested,
      transport,
      prePlanAuthorityClock,
      undefined,
      rate,
      true,
      measurementSessionFactory,
      guard,
      claimedStageHead,
    )
    this.integrityRequested = requested
    this.integrityRate = rate
    this.integrityGuard = guard
    this.integritySessionSignal = sessionSignal
    this.integrityTables = integrity.tables
    this.integrityBuckets = integrity.buckets
    this.expectedResourceIdentityDigest =
      integrity.expectedResourceIdentityDigest
    this.resourceAttestationBytes = integrity.resourceAttestationBytes
    this.integrityDigestKey = integrity.integrityDigestKey
  }

  /** Overwrites retained private material before complete session closure. */
  override close(): Promise<void> {
    this.disposeAllIntegrityPendings()
    this.destroyIntegrityMaterial()
    return super.close()
  }

  /** Overwrites retained private material before final rate sealing begins. */
  override sealAndReadDescribeTableRateEvidence():
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence> {
    this.disposeAllIntegrityPendings()
    this.destroyIntegrityMaterial()
    return super.sealAndReadDescribeTableRateEvidence()
  }

  /**
   * Returns one private key copy only before live use, seal, or close.
   *
   * @returns Fresh owned key copy, or undefined after private destruction.
   */
  protected override copyManagedReconciliationIntegrityKey():
    Uint8Array | undefined {
    if (this.integrityMaterialDestroyed) return undefined
    return new Uint8Array(this.integrityDigestKey)
  }

  /**
   * Runs the real source #163 checker exactly once with no injected AWS state.
   *
   * @param input - Audit pseudonym key, bounded limits, and cancellation only.
   * @returns Opaque pending result for authenticated segment finalization.
   */
  async runRehearsalIntegrityLiveSession(
    input: RunAwsWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
  ): Promise<WorkspaceSearchMigrationRehearsalIntegrityAwsPending> {
    const replayed = this.liveAttempted
    this.liveAttempted = true
    let invocation: RehearsalIntegrityLiveInvocationSnapshot | undefined
    let transport:
      AwsSdkWorkspaceSearchMigrationRehearsalIntegrityLiveTransport | undefined
    let pending:
      WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending | undefined
    let integrityDigestKey: Uint8Array | undefined
    let pendingIntegrityDigestKey: Uint8Array | undefined
    let resourceAttestationBytes: Uint8Array | undefined
    try {
      invocation = detachRehearsalIntegrityLiveInvocation(input)
      if (replayed) return failRehearsalIntegrityLiveInvocation()
      if (
        createHash('sha256')
          .update(invocation.auditPseudonymKey)
          .digest('hex') === this.integrityGuard.permit.evidenceKeyDigest
      ) return failRehearsalIntegrityLiveInvocation()
      this.requireNewAwsAdmission()
      integrityDigestKey = copyRehearsalIntegrityLiveKey(
        this.integrityDigestKey,
      )
      pendingIntegrityDigestKey = copyRehearsalIntegrityLiveKey(
        this.integrityDigestKey,
      )
      resourceAttestationBytes = copyRehearsalIntegrityLiveBytes(
        this.resourceAttestationBytes,
        CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
      )
      const signal = combineRehearsalIntegrityLiveSignals(
        this.readOperationalAbortSignal(),
        this.integritySessionSignal,
        invocation.signal,
      )
      if (signal.aborted) return failRehearsalIntegrityLiveInvocation()
      const credentials = createPinnedProfileCredentials(
        this.integrityRequested,
        signal,
      )
      const configurations = createIdentityAwsSdkConfigurations(
        this.integrityRequested,
        credentials,
      )
      transport =
        new AwsSdkWorkspaceSearchMigrationRehearsalIntegrityLiveTransport(
          configurations,
          this.integrityRequested.account,
          this.integrityGuard.permit.callerArn,
          () => this.requireNewAwsAdmission(),
        )
      pending =
        await runWorkspaceSearchMigrationRehearsalIntegrityLiveSession({
          account: this.integrityRequested.account,
          auditPseudonymKey: invocation.auditPseudonymKey,
          buckets: this.integrityBuckets,
          expectedResourceIdentityDigest:
            this.expectedResourceIdentityDigest,
          integrityDigestKey,
          maxItems: invocation.maxItems,
          maxPages: invocation.maxPages,
          maximumDurationMilliseconds:
            invocation.maximumDurationMilliseconds,
          monotonicClock: readRehearsalRootSystemMonotonicClock,
          pageSize: invocation.pageSize,
          profile: this.integrityRequested.profile,
          rate: this.integrityRate,
          region: this.integrityRequested.region,
          resourceAttestationBytes,
          role: 'source',
          signal,
          tables: this.integrityTables,
          transport,
          wallClock: this.integrityGuard.clock,
        })
      this.requireNewAwsAdmission()
      const completed = new WorkspaceSearchMigrationRehearsalIntegrityAwsPending(
        rehearsalIntegrityAwsPendingToken,
      )
      const completedPending = pending
      const completedIntegrityKey = pendingIntegrityDigestKey
      const abortListener = (): void => {
        this.disposeTrackedIntegrityPending(completed)
      }
      this.integrityPendingStates.set(completed, Object.freeze({
        pending: completedPending,
        integrityDigestKey: completedIntegrityKey,
        signal,
        abortListener,
      }))
      this.unfinalizedIntegrityPendings.add(completed)
      signal.addEventListener('abort', abortListener, { once: true })
      pending = undefined
      pendingIntegrityDigestKey = undefined
      if (signal.aborted) {
        this.disposeTrackedIntegrityPending(completed)
        return failRehearsalIntegrityLiveInvocation()
      }
      return completed
    } catch {
      if (pending !== undefined) {
        try {
          disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
            pending,
          )
        } catch {
          // Preserve the stable outer failure after burning pending authority.
        }
      }
      return failRehearsalIntegrityLiveInvocation()
    } finally {
      invocation?.auditPseudonymKey.fill(0)
      integrityDigestKey?.fill(0)
      pendingIntegrityDigestKey?.fill(0)
      resourceAttestationBytes?.fill(0)
      transport?.close()
      this.destroyIntegrityMaterial()
    }
  }

  /**
   * Finalizes one outer pending after enforcing runtime/integrity key separation.
   *
   * @param input - Session handle, exact linked raw segments, and runtime key.
   * @returns Authenticated rate-bound live result.
   */
  finalizeRehearsalIntegrityLiveSession(
    input:
      FinalizeAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
  ): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
    let transferredRateKey: unknown
    let rateAuthenticationKey: Uint8Array | undefined
    let canonicalSegmentBytes: Uint8Array | undefined
    let predecessorSegmentBytes: Uint8Array | undefined
    let pendingState: RehearsalIntegrityAwsPendingState | undefined
    try {
      const record = rehearsalIntegrityLiveInvocationGuards.requireRecord(input)
      transferredRateKey = readRehearsalIntegrityOwnDataCandidate(
        record,
        'rateAuthenticationKey',
      )
      rehearsalIntegrityLiveInvocationGuards.requireExactKeys(record, [
        'canonicalSegmentBytes',
        'pending',
        'predecessorSegmentBytes',
        'rateAuthenticationKey',
      ])
      pendingState = this.consumeIntegrityPendingState(
        rehearsalIntegrityLiveInvocationGuards.readOwn(record, 'pending'),
      )
      transferredRateKey = rehearsalIntegrityLiveInvocationGuards.readOwn(
        record,
        'rateAuthenticationKey',
      )
      rateAuthenticationKey = copyRehearsalIntegrityLiveKey(
        transferredRateKey,
      )
      canonicalSegmentBytes = copyRehearsalIntegrityLiveBytes(
        rehearsalIntegrityLiveInvocationGuards.readOwn(
          record,
          'canonicalSegmentBytes',
        ),
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
      )
      predecessorSegmentBytes = copyRehearsalIntegrityLiveBytes(
        rehearsalIntegrityLiveInvocationGuards.readOwn(
          record,
          'predecessorSegmentBytes',
        ),
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
      )
      if (timingSafeEqual(
        rateAuthenticationKey,
        pendingState.integrityDigestKey,
      ) || createHash('sha256')
        .update(rateAuthenticationKey)
        .digest('hex') !== this.integrityGuard.permit.evidenceKeyDigest) {
        disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
          pendingState.pending,
        )
        return failRehearsalIntegrityLiveInvocation()
      }
      this.requireNewAwsAdmission()
      return finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession({
        canonicalSegmentBytes,
        expectedConfigurationBindingDigest:
          this.integrityGuard.permit.configurationBindingDigest,
        expectedPolicyVersion: this.integrityGuard.permit.policyVersion,
        pending: pendingState.pending,
        predecessorSegmentBytes,
        rateAuthenticationKey,
      })
    } catch {
      if (pendingState !== undefined) {
        try {
          disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
            pendingState.pending,
          )
        } catch {
          // The generic finalizer may already have burned the inner pending.
        }
      }
      return failRehearsalIntegrityLiveInvocation()
    } finally {
      zeroizeRehearsalIntegrityCandidate(transferredRateKey)
      rateAuthenticationKey?.fill(0)
      canonicalSegmentBytes?.fill(0)
      predecessorSegmentBytes?.fill(0)
      pendingState?.integrityDigestKey.fill(0)
    }
  }

  /** Burns one genuine outer handle and its hidden generic pending. */
  disposeRehearsalIntegrityLiveSession(
    pending: WorkspaceSearchMigrationRehearsalIntegrityAwsPending,
  ): void {
    const state = this.consumeIntegrityPendingState(pending)
    try {
      disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
        state.pending,
      )
    } catch {
      return failRehearsalIntegrityLiveInvocation()
    } finally {
      state.integrityDigestKey.fill(0)
    }
  }

  /** Consumes one exact-session outer pending before any finalizer validation. */
  private consumeIntegrityPendingState(
    value: unknown,
  ): RehearsalIntegrityAwsPendingState {
    if (
      typeof value !== 'object' ||
      value === null ||
      nodeUtilTypes.isProxy(value)
    ) return failRehearsalIntegrityLiveInvocation()
    const state = this.integrityPendingStates.get(value)
    if (state === undefined) return failRehearsalIntegrityLiveInvocation()
    this.integrityPendingStates.delete(value)
    this.unfinalizedIntegrityPendings.delete(value)
    state.signal.removeEventListener('abort', state.abortListener)
    return state
  }

  /** Best-effort abort/seal cleanup for one possibly already consumed handle. */
  private disposeTrackedIntegrityPending(
    pending: WorkspaceSearchMigrationRehearsalIntegrityAwsPending,
  ): void {
    const state = this.integrityPendingStates.get(pending)
    if (state === undefined) return
    this.integrityPendingStates.delete(pending)
    this.unfinalizedIntegrityPendings.delete(pending)
    state.signal.removeEventListener('abort', state.abortListener)
    try {
      disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
        state.pending,
      )
    } catch {
      // Abort/seal/close cleanup is exhaustive and best effort.
    } finally {
      state.integrityDigestKey.fill(0)
    }
  }

  /** Burns every still-unfinalized handle before seal or close proceeds. */
  private disposeAllIntegrityPendings(): void {
    for (const pending of this.unfinalizedIntegrityPendings) {
      this.disposeTrackedIntegrityPending(pending)
    }
  }

  /** Overwrites the retained private attestation and HMAC key exactly once. */
  private destroyIntegrityMaterial(): void {
    if (this.integrityMaterialDestroyed) return
    this.integrityMaterialDestroyed = true
    this.resourceAttestationBytes.fill(0)
    this.integrityDigestKey.fill(0)
  }
}

/**
 * Hides every generic mutation and low-level read capability of the full port.
 *
 * @param session - Internal full session owned by this narrow projection.
 * @returns Frozen live, seal, evidence, and close capability only.
 */
function createRehearsalIntegrityAwsSessionProjection(
  session: AwsWorkspaceSearchMigrationRehearsalIntegrityPort,
): WorkspaceSearchMigrationRehearsalIntegrityAwsSession {
  return Object.freeze({
    close: async (): Promise<void> => await session.close(),
    measureConfiguration: async () => await session.measureConfiguration(),
    scanTargetPage: async (
      input: WorkspaceSearchMigrationTargetScanReadInput,
      signal?: AbortSignal,
    ) => await session.scanTargetPage(input, signal),
    readRequestedResourcesBinding: () =>
      session.readRequestedResourcesBinding(),
    readRehearsalEvidenceSessionBinding: () =>
      session.readRehearsalEvidenceSessionBinding(),
    readRehearsalClaimedStageHead: () =>
      session.readRehearsalClaimedStageHead(),
    collectRehearsalReconciliation: async (
      input:
        CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
    ) => await session.collectRehearsalReconciliation(input),
    interruptDescribeTableRate: (): void =>
      session.interruptDescribeTableRate(),
    sealAndReadDescribeTableRateEvidence: async () =>
      await session.sealAndReadDescribeTableRateEvidence(),
    readDescribeTableRateEvidence: () =>
      session.readDescribeTableRateEvidence(),
    runRehearsalIntegrityLiveSession: async (
      input: RunAwsWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
    ) =>
      await session.runRehearsalIntegrityLiveSession(input),
    finalizeRehearsalIntegrityLiveSession: (
      input:
        FinalizeAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
    ) =>
      session.finalizeRehearsalIntegrityLiveSession(input),
    disposeRehearsalIntegrityLiveSession: (
      pending: WorkspaceSearchMigrationRehearsalIntegrityAwsPending,
    ) =>
      session.disposeRehearsalIntegrityLiveSession(pending),
  })
}

/**
 * Projects one authenticated session onto final-publication capabilities only.
 *
 * @param session - Internal full rehearsal session owning all AWS transports.
 * @param exercise - Construction-fixed opaque one-shot rate exercise.
 * @returns Frozen measure, publish, evidence, interrupt, exercise, and close surface.
 */
function createRehearsalFinalPublicationAwsSessionProjection(
  session: WorkspaceSearchMigrationNonProductionRehearsalAwsSession,
  exercise: WorkspaceSearchMigrationRehearsalDescribeTableRateExercise,
): WorkspaceSearchMigrationRehearsalFinalPublicationAwsSession {
  return Object.freeze({
    measureConfiguration: async () =>
      await session.measureConfiguration(),
    exerciseDescribeTableThrottle: async () => await exercise.run(),
    createRehearsalArtifactPublisher: (
      input: Pick<
        CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput,
        'clock' | 'requestTimeoutMilliseconds'
      >,
    ) => session.createRehearsalArtifactPublisher(input),
    createRehearsalEvidencePublisher: (
      input: Pick<
        CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput,
        'clock' | 'requestTimeoutMilliseconds'
      >,
    ) => session.createRehearsalEvidencePublisher(input),
    readRehearsalEvidenceSessionBinding: () =>
      session.readRehearsalEvidenceSessionBinding(),
    readDescribeTableRateEvidence: () =>
      session.readDescribeTableRateEvidence(),
    readRehearsalPermitValidity: () =>
      session.readRehearsalPermitValidity(),
    interruptDescribeTableRate: (): void =>
      session.interruptDescribeTableRate(),
    close: async (): Promise<void> => await session.close(),
  })
}

/**
 * Creates a managed AWS migration session pinned to resources and endpoints.
 *
 * @param requested - Complete operator-selected migration resources.
 * @param transportConstructor - Injectable allowlisted transport constructor.
 * @param prePlanAuthorityClock - Injectable trusted authority clock.
 * @returns Closeable measured session including pre-plan authority operations.
 */
export function createAwsWorkspaceSearchMigrationIdentityPort(
  requested: WorkspaceSearchMigrationRequestedResources,
  transportConstructor: WorkspaceSearchMigrationIdentityAwsTransportConstructor =
    createDefaultAwsTransport,
  prePlanAuthorityClock:
    WorkspaceSearchMigrationPrePlanAuthorityClock =
      createWorkspaceSearchMigrationPrePlanAuthoritySystemTime,
): WorkspaceSearchMigrationManagedAwsSession {
  const resources =
    createWorkspaceSearchMigrationRequestedResourcesSnapshot(requested)
  const credentials = createPinnedProfileCredentials(resources)
  const configurations = createIdentityAwsSdkConfigurations(
    resources,
    credentials,
  )
  return new AwsWorkspaceSearchMigrationIdentityPort(
    resources,
    transportConstructor(configurations),
    prePlanAuthorityClock,
  )
}

/**
 * Creates the only production session allowed to issue DescribeTable calls.
 *
 * STS validates the actual signing identity before the requested migration-
 * state table can be read or mutated for rate checkpointing. An absent rate
 * row, cleanup recovery, and uncertain-attempt recovery are controlled only
 * by the three explicit booleans supplied by the caller.
 *
 * @param input - Explicit resources, reviewed policy, and recovery authority.
 * @returns Fully claimed rate-managed session with a subordinate measurement factory.
 */
export async function createAwsWorkspaceSearchMigrationRateManagedSession(
  input: CreateAwsWorkspaceSearchMigrationRateManagedSessionInput,
): Promise<WorkspaceSearchMigrationRateManagedAwsSession> {
  rejectProductionStageReservationCapabilities(input)
  const snapshot = detachRateManagedAwsSessionConstructionInput(input)
  return createRateManagedAwsSessionFromSnapshot(snapshot)
}

/**
 * Creates the dedicated owner-only pre-permit non-production root session.
 *
 * The strict source-controlled root plan is parsed before clocks, credentials,
 * or clients are constructed. The complete timeline begins before the first
 * possible profile-assumption or GetCallerIdentity service read. Exact STS
 * identity and journal deployment tags are verified before rate-checkpoint
 * I/O. Bootstrap is fixed on while both recovery authorities are fixed off.
 *
 * @param input - Strict root plan, reviewed policy, clocks, and cancellation.
 * @returns Capability-narrow measurement, attestation, seal, and close session.
 */
export async function createAwsWorkspaceSearchMigrationRehearsalPrePermitRootSession(
  input:
    CreateAwsWorkspaceSearchMigrationRehearsalPrePermitRootSessionInput,
): Promise<WorkspaceSearchMigrationRehearsalPrePermitRootSession> {
  const construction = detachRehearsalPrePermitRootConstruction(input)
  const plan = construction.plan
  const timeline = createWorkspaceSearchMigrationRehearsalRootTimeline({
    maximumDurationMilliseconds:
      plan.document.maximumDurationMilliseconds,
    monotonicClock: construction.monotonicClock,
    wallClock: construction.wallClock,
    ...(construction.signal === undefined
      ? {}
      : { signal: construction.signal }),
  })
  return await createRehearsalPrePermitRootSessionFromSnapshot(
    construction,
    timeline,
  )
}

/**
 * Rejects every own or inherited rehearsal stage capability on production.
 *
 * The check observes property presence only. It never reads the claim value,
 * so a production call cannot use an accessor to expose reservation material.
 *
 * @param input - Candidate production construction input.
 */
function rejectProductionStageReservationCapabilities(
  input: CreateAwsWorkspaceSearchMigrationRateManagedSessionInput,
): void {
  try {
    for (const property of [
      'stageReservationClaim',
      'stageReservationCommit',
    ]) {
      if (Reflect.has(input, property)) {
        throw new WorkspaceSearchMigrationManagedDescribeTableRateError()
      }
    }
  } catch {
    throw new WorkspaceSearchMigrationManagedDescribeTableRateError()
  }
}

/**
 * Creates a rate-managed session only after authenticated non-production guard
 * validation. The production factory cannot supply this guard or any fault
 * controller.
 *
 * @param input - Production session input plus a restricted reviewed permit.
 * @returns Fully claimed session after STS, permit, and journal-tag checks.
 */
export async function createAwsWorkspaceSearchMigrationNonProductionRehearsalSession(
  input:
    CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
): Promise<WorkspaceSearchMigrationNonProductionRehearsalAwsSession> {
  const snapshot = detachRateManagedAwsSessionConstructionInput(input)
  const rehearsalPreflight = detachNonProductionRehearsalConstructionGuard(
    input,
    snapshot.resources,
    snapshot.ratePolicy,
  )
  try {
    return await createRateManagedAwsSessionFromSnapshot(
      snapshot,
      rehearsalPreflight,
    )
  } finally {
    rehearsalPreflight.stageReservationClaim?.destroy()
  }
}

/**
 * Creates the capability-minimized session used only by final publication.
 *
 * The caller cannot choose the exercise target. This factory fixes it to the
 * already authenticated and allowlisted migration-state table and keeps the
 * exercise outside both production and generic rehearsal session surfaces.
 *
 * @param input - Authenticated non-production session construction.
 * @returns Frozen final-publication projection with one opaque rate exercise.
 */
export async function createAwsWorkspaceSearchMigrationRehearsalFinalPublicationSession(
  input:
    CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
): Promise<WorkspaceSearchMigrationRehearsalFinalPublicationAwsSession> {
  const snapshot = detachRateManagedAwsSessionConstructionInput(input)
  const rehearsalPreflight = detachNonProductionRehearsalConstructionGuard(
    input,
    snapshot.resources,
    snapshot.ratePolicy,
  )
  const exerciseHolder: {
    /** Opaque exercise registered only by the specialized rate factory. */
    exercise?: WorkspaceSearchMigrationRehearsalDescribeTableRateExercise
  } = {}
  let session:
    WorkspaceSearchMigrationNonProductionRehearsalAwsSession | undefined
  try {
    session = await createRateManagedAwsSessionFromSnapshot(
      snapshot,
      rehearsalPreflight,
      undefined,
      (exercise) => {
        exerciseHolder.exercise = exercise
      },
    )
    const exercise = exerciseHolder.exercise
    if (exercise === undefined) {
      await session.close()
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    return createRehearsalFinalPublicationAwsSessionProjection(
      session,
      exercise,
    )
  } catch (error: unknown) {
    try {
      await session?.close()
    } catch {
      // Preserve the construction or projection failure after draining I/O.
    }
    throw error
  } finally {
    rehearsalPreflight.stageReservationClaim?.destroy()
  }
}

/**
 * Creates one stage-bound permit-backed session for an actual #163 live run.
 *
 * The private attestation, dedicated integrity key, exact permit resource
 * vector, aggregate identity digest, source-controlled deployment target, and
 * exact recovery-six/allow-ten tables are validated synchronously before any
 * credentials, AWS clients, or rate-checkpoint I/O are created. Bootstrap and
 * both recovery authorities are fixed false. The returned projection exposes
 * no generic AWS reads, mutation ports, rate owner, or transport.
 *
 * @param input - Permit, required stage claim, private attestation, key, and policy.
 * @returns Frozen live, rate evidence, seal, and close capability only.
 */
export async function createAwsWorkspaceSearchMigrationRehearsalIntegritySession(
  input: CreateAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
): Promise<WorkspaceSearchMigrationRehearsalIntegrityAwsSession> {
  const construction =
    detachNonProductionRehearsalIntegritySessionConstruction(input)
  let transferred = false
  let internal:
    AwsWorkspaceSearchMigrationRehearsalIntegrityPort | undefined
  try {
    internal = await createRateManagedAwsSessionFromSnapshot(
      construction.session,
      construction.preflight,
      construction.integrity,
    )
    const projection = createRehearsalIntegrityAwsSessionProjection(internal)
    transferred = true
    internal = undefined
    return projection
  } catch {
    try {
      await internal?.close()
    } catch {
      // Preserve the stable construction failure after draining owned state.
    }
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  } finally {
    construction.preflight.stageReservationClaim?.destroy()
    if (!transferred) {
      construction.integrity.resourceAttestationBytes.fill(0)
      construction.integrity.integrityDigestKey.fill(0)
    }
  }
}

/**
 * Claims one authenticated stage without constructing a control session.
 *
 * The claim is completed after the same STS, journal-tag, deployment-trust,
 * resource, policy, and permit checks used by the child composition root.
 *
 * @param input - Exact resources, permit, policy, and authenticated claim.
 * @returns Frozen newly claimed or revision-neutral resumed durable head.
 */
export async function claimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
  input:
    ClaimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
): Promise<WorkspaceSearchMigrationRehearsalStageHead> {
  const construction =
    detachNonProductionRehearsalStageClaimConstruction(input)
  let transport:
    AwsSdkWorkspaceSearchMigrationRehearsalStageCommitTransport | undefined
  try {
    const credentialsProvider = createPinnedProfileCredentials(
      construction.resources,
    )
    const configurations = createIdentityAwsSdkConfigurations(
      construction.resources,
      credentialsProvider,
    )
    transport =
      new AwsSdkWorkspaceSearchMigrationRehearsalStageCommitTransport(
        configurations,
      )
    const caller = await transport.getCallerIdentity(
      new GetCallerIdentityCommand({}),
    )
    requirePreMeasurementCallerIdentity(
      caller,
      construction.resources.account,
    )
    await credentialsProvider()
    requireNonProductionRehearsalCaller(caller, construction.guard)
    requireNonProductionRehearsalPermitActive(construction.guard)
    const bucketTags = await transport.getBucketTagging(
      new GetBucketTaggingCommand({
        Bucket: construction.resources.journalBucket,
        ExpectedBucketOwner: construction.resources.account,
      }),
    )
    requireNonProductionRehearsalJournalTags(
      bucketTags,
      construction.guard,
    )
    requireNonProductionRehearsalPermitActive(construction.guard)
    const claimTime = readNonProductionRehearsalClock(
      construction.guard.clock,
    )
    requireNonProductionRehearsalPermitActiveAt(
      construction.guard,
      claimTime,
    )
    return await construction.stageClaim.claim({
      binding: {
        stateTableName:
          construction.resources.tables['migration-state'],
        requestedResourcesBinding:
          createWorkspaceSearchMigrationRequestedResourcesBinding(
            construction.resources,
          ),
      },
      transport,
      observedAt: claimTime.toISOString(),
    })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  } finally {
    construction.stageClaim.destroy()
    transport?.close()
  }
}

/**
 * Strongly reads one authenticated non-production suite stage head.
 *
 * No generic DynamoDB capability escapes this composition root. The exact
 * permit, role session, journal tags, resource binding, rate policy, manifest,
 * and state-table locator are authenticated before the store may read.
 *
 * @param input - Exact resources, permit, policy, manifest, and split key.
 * @returns Frozen current durable head or canonical absent-root projection.
 */
export async function readAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationHead(
  input:
    ReadAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationHeadInput,
): Promise<WorkspaceSearchMigrationRehearsalStageHead> {
  const construction =
    detachNonProductionRehearsalStageHeadConstruction(input)
  try {
    return await runNonProductionRehearsalStageHeadOperation(
      construction,
      async (transport) => {
        const store =
          createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
            binding: {
              stateTableName:
                construction.resources.tables['migration-state'],
              requestedResourcesBinding:
                createWorkspaceSearchMigrationRequestedResourcesBinding(
                  construction.resources,
                ),
            },
            manifest: construction.manifest,
            manifestVerificationKey:
              construction.manifestVerificationKey,
            transport,
          })
        return cloneRehearsalStageHead(await store.read())
      },
    )
  } finally {
    zeroizeStandaloneStageHeadKey(
      construction.manifestVerificationKey,
    )
  }
}

/**
 * Explicitly abandons one exact expired contained stage reservation.
 *
 * The parent-signed transition is fully authenticated before remote I/O. The
 * store owns the exact-predecessor CAS and accepts an uncertain transaction as
 * success only after its built-in strong read proves the exact successor.
 *
 * @param input - Exact preflight plus selection, token, authorization, and keys.
 * @returns Frozen newly inactive durable head.
 */
export async function abandonAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
  input:
    AbandonAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
): Promise<WorkspaceSearchMigrationRehearsalStageHead> {
  const construction =
    detachNonProductionRehearsalStageAbandonmentConstruction(input)
  try {
    return await runNonProductionRehearsalStageHeadOperation(
      construction,
      async (transport) => {
        const store =
          createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
            binding: {
              stateTableName:
                construction.resources.tables['migration-state'],
              requestedResourcesBinding:
                createWorkspaceSearchMigrationRequestedResourcesBinding(
                  construction.resources,
                ),
            },
            manifest: construction.manifest,
            manifestVerificationKey:
              construction.manifestVerificationKey,
            transport,
          })
        const head = await store.abandon({
          selection: construction.selection,
          reservation: construction.reservation,
          abandonment: construction.abandonment,
          runtimeKeyCleanupAuthorization:
            construction.runtimeKeyCleanupAuthorization,
          runtimeVerificationKey: construction.runtimeVerificationKey,
          publicationVerificationKey:
            construction.publicationVerificationKey,
          observedAt: construction.observedAt,
        })
        return cloneRehearsalStageHead(head)
      },
    )
  } finally {
    zeroizeStandaloneStageHeadKey(
      construction.manifestVerificationKey,
    )
    zeroizeStandaloneStageHeadKey(construction.runtimeVerificationKey)
    zeroizeStandaloneStageHeadKey(
      construction.publicationVerificationKey,
    )
  }
}

/**
 * Strongly recovers every immutable commit row for one completed suite.
 *
 * The manifest, exact 36-receipt chain, and split verification keys are
 * authenticated before the first state-table read. The store brackets all
 * journal reads with the same terminal root and returns only opaque branded
 * durability capabilities.
 *
 * @param input - Exact preflight, manifest, receipts, and separated keys.
 * @returns Ordered 36 strong-read durability authorizations.
 */
export async function recoverAwsWorkspaceSearchMigrationNonProductionRehearsalStageCommitDurabilityAuthorizations(
  input:
    RecoverAwsWorkspaceSearchMigrationNonProductionRehearsalStageCommitDurabilityAuthorizationsInput,
): Promise<WorkspaceSearchMigrationRehearsalStageDurabilityRecovery> {
  const construction =
    detachNonProductionRehearsalStageCommitRecoveryConstruction(input)
  try {
    return await runNonProductionRehearsalStageHeadOperation(
      construction,
      async (transport) => {
        const store =
          createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
            binding: {
              stateTableName:
                construction.resources.tables['migration-state'],
              requestedResourcesBinding:
                createWorkspaceSearchMigrationRequestedResourcesBinding(
                  construction.resources,
                ),
            },
            manifest: construction.manifest,
            manifestVerificationKey:
              construction.manifestVerificationKey,
            transport,
          })
        return await store.recoverCommitChain({
          receipts: construction.receipts,
          reservationAbandonments:
            construction.reservationAbandonments,
          runtimeVerificationKey: construction.runtimeVerificationKey,
          publicationVerificationKey:
            construction.publicationVerificationKey,
        })
      },
    )
  } finally {
    zeroizeStandaloneStageHeadKey(
      construction.manifestVerificationKey,
    )
    zeroizeStandaloneStageHeadKey(construction.runtimeVerificationKey)
    zeroizeStandaloneStageHeadKey(
      construction.publicationVerificationKey,
    )
  }
}

/**
 * Commits one authenticated non-production stage without constructing a
 * control session or exposing DescribeTable and rate-checkpoint capabilities.
 * The synchronous construction preflight retains the original opaque cleanup
 * and special-audit capabilities until the exact durable store boundary.
 *
 * @param input - Exact resources, permit, policy, and authenticated material.
 * @returns Frozen direct-commit or exact response-loss recovery result.
 */
export async function commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
  input:
    CommitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
): Promise<WorkspaceSearchMigrationRehearsalStageReservationCommitResult> {
  const construction =
    detachNonProductionRehearsalStageCommitConstruction(input)
  let transport:
    AwsSdkWorkspaceSearchMigrationRehearsalStageCommitTransport | undefined
  try {
    const credentialsProvider = createPinnedProfileCredentials(
      construction.resources,
    )
    const configurations = createIdentityAwsSdkConfigurations(
      construction.resources,
      credentialsProvider,
    )
    transport =
      new AwsSdkWorkspaceSearchMigrationRehearsalStageCommitTransport(
        configurations,
      )
    const caller = await transport.getCallerIdentity(
      new GetCallerIdentityCommand({}),
    )
    requirePreMeasurementCallerIdentity(
      caller,
      construction.resources.account,
    )
    await credentialsProvider()
    requireNonProductionRehearsalCaller(
      caller,
      construction.guard,
    )
    requireNonProductionRehearsalPermitActive(construction.guard)
    const bucketTags = await transport.getBucketTagging(
      new GetBucketTaggingCommand({
        Bucket: construction.resources.journalBucket,
        ExpectedBucketOwner: construction.resources.account,
      }),
    )
    requireNonProductionRehearsalJournalTags(
      bucketTags,
      construction.guard,
    )
    requireNonProductionRehearsalPermitActive(construction.guard)
    const commitTime = readNonProductionRehearsalClock(
      construction.guard.clock,
    )
    requireNonProductionRehearsalPermitActiveAt(
      construction.guard,
      commitTime,
    )
    return await construction.stageCommit.commit({
      binding: {
        stateTableName:
          construction.resources.tables['migration-state'],
        requestedResourcesBinding:
          createWorkspaceSearchMigrationRequestedResourcesBinding(
            construction.resources,
          ),
      },
      transport,
      commitDispatchAt: commitTime.toISOString(),
    })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  } finally {
    construction.stageCommit.destroy()
    transport?.close()
  }
}

/** Exact allowed fields of the pre-permit root construction input. */
const rehearsalPrePermitRootConstructionKeys = new Set([
  'monotonicClock',
  'ratePolicy',
  'rateRecorder',
  'rootPlan',
  'signal',
  'wallClock',
])

/** Stable strict guards for the owner-only pre-permit construction. */
const rehearsalPrePermitRootConstructionGuards =
  new WorkspaceSearchMigrationStrictRecordGuards(
    failRehearsalPrePermitRootOperation,
  )

/**
 * Detaches the complete pre-permit construction before its first clock sample.
 *
 * The root plan is parsed first and therefore re-resolves the enabled target
 * from the repository-owned deployment map before any client can exist.
 * Recovery and bootstrap properties are not accepted on this public input.
 *
 * @param input - Candidate owner-only pre-permit construction.
 * @returns Strict plan, policy, clocks, recorder, and cancellation snapshot.
 */
function detachRehearsalPrePermitRootConstruction(
  input:
    CreateAwsWorkspaceSearchMigrationRehearsalPrePermitRootSessionInput,
): RehearsalPrePermitRootConstructionSnapshot {
  const record = rehearsalPrePermitRootConstructionGuards.requireRecord(input)
  const prototype = Object.getPrototypeOf(record)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    (prototype !== null && nodeUtilTypes.isProxy(prototype))
  ) return failRehearsalPrePermitRootOperation()
  const keys = Reflect.ownKeys(record)
  for (const key of keys) {
    if (
      typeof key !== 'string' ||
      !rehearsalPrePermitRootConstructionKeys.has(key)
    ) return failRehearsalPrePermitRootOperation()
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) return failRehearsalPrePermitRootOperation()
  }
  if (
    !Object.hasOwn(record, 'rootPlan') ||
    !Object.hasOwn(record, 'ratePolicy')
  ) return failRehearsalPrePermitRootOperation()
  const plan = parseWorkspaceSearchMigrationRehearsalRootPlan(
    rehearsalPrePermitRootConstructionGuards.readOwn(record, 'rootPlan'),
  )
  let ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  let rateRecorder:
    WorkspaceSearchMigrationDescribeTableRateRecorder | undefined
  let signal: AbortSignal | undefined
  let monotonicClock: (() => number) | undefined
  let wallClock: (() => Date) | undefined
  try {
    ratePolicy = structuredClone(input.ratePolicy)
    rateRecorder = Object.hasOwn(record, 'rateRecorder')
      ? input.rateRecorder
      : undefined
    signal = Object.hasOwn(record, 'signal')
      ? input.signal
      : undefined
    monotonicClock = Object.hasOwn(record, 'monotonicClock')
      ? input.monotonicClock
      : undefined
    wallClock = Object.hasOwn(record, 'wallClock')
      ? input.wallClock
      : undefined
  } catch {
    return failRehearsalPrePermitRootOperation()
  }
  if (
    (signal !== undefined &&
      (!(signal instanceof AbortSignal) || nodeUtilTypes.isProxy(signal))) ||
    (monotonicClock !== undefined &&
      (typeof monotonicClock !== 'function' ||
        nodeUtilTypes.isProxy(monotonicClock))) ||
    (wallClock !== undefined &&
      (typeof wallClock !== 'function' || nodeUtilTypes.isProxy(wallClock)))
  ) return failRehearsalPrePermitRootOperation()
  return Object.freeze({
    plan,
    ratePolicy: Object.freeze(ratePolicy),
    ...(rateRecorder === undefined ? {} : { rateRecorder }),
    ...(signal === undefined ? {} : { signal }),
    monotonicClock: monotonicClock ?? readRehearsalRootSystemMonotonicClock,
    wallClock: wallClock ?? readRehearsalRootSystemWallClock,
  })
}

/**
 * Composes one authenticated pre-permit root after the timeline has begun.
 *
 * @param construction - Strict detached source-controlled construction.
 * @param timeline - Complete non-resettable root timeline begun before clients.
 * @returns Capability-narrow root session after fixed rate bootstrap.
 */
async function createRehearsalPrePermitRootSessionFromSnapshot(
  construction: RehearsalPrePermitRootConstructionSnapshot,
  timeline: WorkspaceSearchMigrationRehearsalRootTimeline,
): Promise<WorkspaceSearchMigrationRehearsalPrePermitRootSession> {
  const plan = construction.plan
  const resources = plan.document.requestedResources
  const credentialsProvider = createPinnedProfileCredentials(
    resources,
    timeline.signal,
  )
  const configurations = createIdentityAwsSdkConfigurations(
    resources,
    credentialsProvider,
  )
  const transport =
    new AwsSdkWorkspaceSearchMigrationIdentityTransport(configurations)
  let rate: WorkspaceSearchMigrationManagedDescribeTableRate | undefined
  let measurementPort: AwsWorkspaceSearchMigrationIdentityPort | undefined
  let attestationOperation:
    WorkspaceSearchMigrationRehearsalRootAttestationOperation | undefined
  try {
    const caller = await timeline.run(
      async (signal) => await transport.getCallerIdentity(
        new GetCallerIdentityCommand({}),
        signal,
      ),
    )
    requirePreMeasurementCallerIdentity(caller, resources.account)
    if (caller.Arn !== plan.document.expectedCallerArn) {
      return failRehearsalPrePermitRootOperation()
    }
    await timeline.run(async () => await credentialsProvider())
    const tags = await timeline.run(
      async (signal) => await transport.getBucketTagging(
        new GetBucketTaggingCommand({
          Bucket: resources.journalBucket,
          ExpectedBucketOwner: resources.account,
        }),
        signal,
      ),
    )
    requireRehearsalPrePermitRootJournalTags(tags, plan)

    const checkpointStore =
      createWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStore({
        binding: {
          account: resources.account,
          region: resources.region,
          tableName: resources.tables['migration-state'],
        },
        transport,
      })
    const rateConstruction =
      createRehearsalIntegrityRateConstruction(plan)
    rate = await timeline.run(
      async (signal) =>
        await createWorkspaceSearchMigrationManagedDescribeTableRate({
          account: resources.account,
          region: resources.region,
          recoveryTableNames: rateConstruction.recoveryTableNames,
          allowedTableNames: rateConstruction.allowedTableNames,
          policy: construction.ratePolicy,
          checkpointStore,
          credentials: createPinnedDescribeTableCredentialsProvider(
            credentialsProvider,
            resources.account,
          ),
          bootstrap: rateConstruction.bootstrap,
          recoverInterruptedCleanup:
            rateConstruction.recoverInterruptedCleanup,
          recoverInterruptedAttempt:
            rateConstruction.recoverInterruptedAttempt,
          ...(construction.rateRecorder === undefined
            ? {}
            : { recorder: construction.rateRecorder }),
          signal,
        }),
    )
    measurementPort = new AwsWorkspaceSearchMigrationIdentityPort(
      resources,
      transport,
      construction.wallClock,
      undefined,
      rate,
      false,
    )
    attestationOperation =
      createRateManagedRehearsalRootAttestationOperation({
        configurations,
        plan,
        rate,
      })
    const ownedMeasurementPort = measurementPort
    const rootMeasurementPort = Object.freeze({
      measureConfiguration: async () =>
        await ownedMeasurementPort.measureConfiguration(),
      readDescribeTableRateEvidence: () =>
        ownedMeasurementPort.readDescribeTableRateEvidence(),
    })
    return createWorkspaceSearchMigrationRehearsalPrePermitRootSession({
      measurementPort: rootMeasurementPort,
      closeMeasurementPort: async () => {
        await ownedMeasurementPort.close()
      },
      rate,
      attestationOperation,
      expectedConfigurationBindingDigest:
        plan.configurationBindingDigest,
      expectedPolicyVersion: construction.ratePolicy.policyVersion,
      timeline,
    })
  } catch {
    timeline.interrupt()
    rate?.interrupt()
    try {
      await rate?.close()
    } catch {
      // Continue closing both AWS transports before raising the stable failure.
    }
    try {
      await measurementPort?.close()
    } catch {
      // Continue closing the attestation transport after measurement failure.
    }
    if (measurementPort === undefined) {
      try {
        transport.close()
      } catch {
        // The stable root failure hides transport-specific close details.
      }
    }
    try {
      attestationOperation?.close()
    } catch {
      // Every best-effort close is attempted before the stable root failure.
    }
    return failRehearsalPrePermitRootOperation()
  }
}

/** Input for the reusable rate-managed integrity reader composition. */
type CreateRateManagedRehearsalRootAttestationOperationInput = {
  /** Existing hardened official-endpoint client configuration set. */
  readonly configurations:
    WorkspaceSearchMigrationIdentityAwsSdkConfigurations
  /** Strict source-controlled root plan and exact integrity resources. */
  readonly plan: WorkspaceSearchMigrationRehearsalRootPlan
  /** Existing exact-ten managed DescribeTable owner. */
  readonly rate: WorkspaceSearchMigrationManagedDescribeTableRate
}

/**
 * Creates a one-shot adapter/reader pair with no DescribeTable fallback.
 *
 * This helper deliberately keeps the adapter and reader private. A future
 * permit-backed live composition can reuse the same outer construction while
 * supplying its separately guarded non-DescribeTable transport and pass count.
 *
 * @param input - Pinned clients, strict resources, and shared rate owner.
 * @returns One-shot root attestation operation with exact close ownership.
 */
function createRateManagedRehearsalRootAttestationOperation(
  input: CreateRateManagedRehearsalRootAttestationOperationInput,
): WorkspaceSearchMigrationRehearsalRootAttestationOperation {
  const plan = input.plan
  const resources = plan.document.integrityResources
  const baseTransport =
    new AwsSdkWorkspaceSearchMigrationRehearsalIntegrityTransport(
      input.configurations.s3,
    )
  let adapter: WorkspaceSearchMigrationRehearsalIntegrityRateAdapter
  let reader: AwsCrossDomainIntegrityReader
  try {
    adapter = createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter({
      tableNames: resources.tables,
      tablePassCount: 1,
      baseTransport,
      rate: input.rate,
    })
    reader = new AwsCrossDomainIntegrityReader({
      buckets: { file: resources.fileBucket },
      expectedAccount: plan.document.requestedResources.account,
      maxPages: 1,
      pageSize: 1,
      profile: plan.document.requestedResources.profile,
      region: plan.document.requestedResources.region,
      tables: resources.tables,
    }, () => adapter)
  } catch {
    baseTransport.close()
    return failRehearsalPrePermitRootOperation()
  }
  let used = false
  let closed = false
  return Object.freeze({
    run: async (
      signal: AbortSignal,
    ): Promise<WorkspaceSearchMigrationRehearsalRootAttestationOperationResult> => {
      if (
        used ||
        closed ||
        !(signal instanceof AbortSignal) ||
        nodeUtilTypes.isProxy(signal)
      ) return failRehearsalPrePermitRootOperation()
      used = true
      const resourceAttestation = await adapter.run(
        async () => await reader.measureResourceAttestation(
          resources.marker,
          signal,
        ),
      )
      const sequence = adapter.takeCompletedSequence(resourceAttestation)
      return Object.freeze({ resourceAttestation, sequence })
    },
    close: (): void => {
      if (closed) return
      closed = true
      reader.close()
    },
  })
}

/**
 * Creates the exact-ten allowlist and fixed root recovery/bootstrap authority.
 *
 * @param plan - Strict source-controlled root plan.
 * @returns Canonical migration six, union ten, and non-caller-controlled flags.
 */
function createRehearsalIntegrityRateConstruction(
  plan: WorkspaceSearchMigrationRehearsalRootPlan,
): RehearsalPrePermitRootRateConstruction {
  const tables = plan.document.requestedResources.tables
  const recoveryTableNames = Object.freeze([
    tables['project-directory'],
    tables['work-items'],
    tables.collaboration,
    tables.documents,
    tables['workspace-search'],
    tables['migration-state'],
  ])
  const allowedTableNames = Object.freeze([
    ...plan.allowedDescribeTableNames,
  ])
  if (
    recoveryTableNames.length !== 6 ||
    new Set(recoveryTableNames).size !== 6 ||
    allowedTableNames.length !== 10 ||
    new Set(allowedTableNames).size !== 10 ||
    recoveryTableNames.some(
      (tableName) => !allowedTableNames.includes(tableName),
    )
  ) return failRehearsalPrePermitRootOperation()
  return Object.freeze({
    recoveryTableNames,
    allowedTableNames,
    bootstrap: true,
    recoverInterruptedCleanup: false,
    recoverInterruptedAttempt: false,
  })
}

/** Requires all three source-controlled journal deployment tags exactly once. */
function requireRehearsalPrePermitRootJournalTags(
  output: GetBucketTaggingOutput,
  plan: WorkspaceSearchMigrationRehearsalRootPlan,
): void {
  const tags = output.TagSet
  if (!Array.isArray(tags)) return failRehearsalPrePermitRootOperation()
  let environmentCount = 0
  let trustRootCount = 0
  let productionDigestCount = 0
  for (const tag of tags) {
    if (tag.Key === WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY) {
      environmentCount += 1
      if (tag.Value !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE) {
        return failRehearsalPrePermitRootOperation()
      }
      continue
    }
    if (
      tag.Key ===
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY
    ) {
      trustRootCount += 1
      if (tag.Value !== plan.deploymentTrustRootDigest) {
        return failRehearsalPrePermitRootOperation()
      }
      continue
    }
    if (
      tag.Key ===
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY
    ) {
      productionDigestCount += 1
      if (tag.Value !== plan.productionAccountDigest) {
        return failRehearsalPrePermitRootOperation()
      }
    }
  }
  if (
    environmentCount !== 1 ||
    trustRootCount !== 1 ||
    productionDigestCount !== 1
  ) return failRehearsalPrePermitRootOperation()
}

/** Reads the default trusted process-monotonic root clock. */
function readRehearsalRootSystemMonotonicClock(): number {
  return Math.floor(performance.now())
}

/** Reads the default trusted root wall clock. */
function readRehearsalRootSystemWallClock(): Date {
  return new Date()
}

/** Creates one locally rejected Promise for a forbidden root transport call. */
function rejectPrePermitRootOperation<Result>(): Promise<Result> {
  return Promise.reject(
    new WorkspaceSearchMigrationRehearsalPrePermitRootSessionError(),
  )
}

/** Raises the stable raw-value-free pre-permit root failure. */
function failRehearsalPrePermitRootOperation(): never {
  throw new WorkspaceSearchMigrationRehearsalPrePermitRootSessionError()
}

/**
 * Composes one rate-managed session from an already detached construction.
 *
 * @param snapshot - Validated production-compatible session construction.
 * @param rehearsalPreflight - Optional authenticated non-production preflight.
 * @param integrity - Optional dedicated integrity-session construction.
 * @param registerFinalPublicationExercise - Optional specialized exercise sink.
 * @returns Fully claimed parent session and subordinate measurement factory.
 */
function createRateManagedAwsSessionFromSnapshot(
  snapshot: RateManagedAwsSessionConstructionSnapshot,
  rehearsalPreflight: NonProductionRehearsalConstructionPreflight,
): Promise<WorkspaceSearchMigrationNonProductionRehearsalAwsSession>
function createRateManagedAwsSessionFromSnapshot(
  snapshot: RateManagedAwsSessionConstructionSnapshot,
  rehearsalPreflight: NonProductionRehearsalConstructionPreflight,
  integrity: NonProductionRehearsalIntegrityConstruction,
): Promise<AwsWorkspaceSearchMigrationRehearsalIntegrityPort>
function createRateManagedAwsSessionFromSnapshot(
  snapshot: RateManagedAwsSessionConstructionSnapshot,
  rehearsalPreflight: NonProductionRehearsalConstructionPreflight,
  integrity: undefined,
  registerFinalPublicationExercise:
    RegisterFinalPublicationDescribeTableRateExercise,
): Promise<WorkspaceSearchMigrationNonProductionRehearsalAwsSession>
function createRateManagedAwsSessionFromSnapshot(
  snapshot: RateManagedAwsSessionConstructionSnapshot,
): Promise<WorkspaceSearchMigrationRateManagedAwsSession>
async function createRateManagedAwsSessionFromSnapshot(
  snapshot: RateManagedAwsSessionConstructionSnapshot,
  rehearsalPreflight?: NonProductionRehearsalConstructionPreflight,
  integrity?: NonProductionRehearsalIntegrityConstruction,
  registerFinalPublicationExercise?:
    RegisterFinalPublicationDescribeTableRateExercise,
): Promise<WorkspaceSearchMigrationRateManagedAwsSession> {
  const rehearsalGuard = rehearsalPreflight?.guard
  const stageReservationClaim =
    rehearsalPreflight?.stageReservationClaim
  const signal = snapshot.signal
  requireRateManagedSessionSignalActive(signal)
  const resources = snapshot.resources
  const credentialsProvider = createPinnedProfileCredentials(
    resources,
    signal,
  )
  const configurations = createIdentityAwsSdkConfigurations(
    resources,
    credentialsProvider,
  )
  const transport = createDefaultAwsTransport(configurations)
  let claimedRehearsalStageHead:
    WorkspaceSearchMigrationRehearsalStageHead | undefined
  try {
    requireRateManagedSessionSignalActive(signal)
    const caller = await transport.getCallerIdentity(
      new GetCallerIdentityCommand({}),
    )
    requireRateManagedSessionSignalActive(signal)
    requirePreMeasurementCallerIdentity(caller, resources.account)
    await credentialsProvider()
    requireRateManagedSessionSignalActive(signal)
    if (rehearsalGuard !== undefined) {
      requireNonProductionRehearsalCaller(
        caller,
        rehearsalGuard,
      )
      requireNonProductionRehearsalPermitActive(rehearsalGuard)
      const bucketTags = await transport.getBucketTagging(
        new GetBucketTaggingCommand({
          Bucket: resources.journalBucket,
          ExpectedBucketOwner: resources.account,
        }),
      )
      requireRateManagedSessionSignalActive(signal)
      requireNonProductionRehearsalJournalTags(
        bucketTags,
        rehearsalGuard,
      )
      requireNonProductionRehearsalPermitActive(rehearsalGuard)
      if (stageReservationClaim !== undefined) {
        const claimTime = readNonProductionRehearsalClock(
          rehearsalGuard.clock,
        )
        requireNonProductionRehearsalPermitActiveAt(
          rehearsalGuard,
          claimTime,
        )
        claimedRehearsalStageHead =
          await stageReservationClaim.claim({
            binding: {
              stateTableName: resources.tables['migration-state'],
              requestedResourcesBinding:
                createWorkspaceSearchMigrationRequestedResourcesBinding(
                  resources,
                ),
            },
            transport,
            observedAt: claimTime.toISOString(),
          })
        requireRateManagedSessionSignalActive(signal)
      }
      requireNonProductionRehearsalAdmissionActive(
        rehearsalGuard,
        claimedRehearsalStageHead,
      )
    }
  } catch (error: unknown) {
    transport.close()
    requireRateManagedSessionSignalActive(signal)
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) {
      throw error
    }
    if (rehearsalGuard !== undefined) {
      throw new WorkspaceSearchMigrationRehearsalPermitError()
    }
    throw preMeasurementCallerIdentityFailure()
  }

  const checkpointStore =
    createWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStore({
      binding: {
        account: resources.account,
        region: resources.region,
        tableName: resources.tables['migration-state'],
      },
      transport,
    })
  let rate: WorkspaceSearchMigrationManagedDescribeTableRate
  try {
    const rateConstruction = {
      account: resources.account,
      region: resources.region,
      recoveryTableNames: integrity?.rateTables.recoveryTableNames ??
        Object.values(resources.tables),
      allowedTableNames: integrity?.rateTables.allowedTableNames ??
        Object.values(resources.tables),
      policy: snapshot.ratePolicy,
      checkpointStore,
      credentials: createPinnedDescribeTableCredentialsProvider(
        credentialsProvider,
        resources.account,
      ),
      bootstrap: snapshot.bootstrapRateCheckpoint,
      recoverInterruptedCleanup: snapshot.recoverInterruptedCleanup,
      recoverInterruptedAttempt: snapshot.recoverInterruptedAttempt,
      ...(snapshot.rateRecorder === undefined
        ? {}
        : { recorder: snapshot.rateRecorder }),
      ...(signal === undefined ? {} : { signal }),
    }
    if (registerFinalPublicationExercise === undefined) {
      rate = await createWorkspaceSearchMigrationManagedDescribeTableRate(
        rateConstruction,
      )
    } else {
      if (rehearsalGuard === undefined || integrity !== undefined) {
        throw new WorkspaceSearchMigrationRehearsalPermitError()
      }
      const bundle =
        await createWorkspaceSearchMigrationRehearsalManagedDescribeTableRate({
          ...rateConstruction,
          exerciseTableName: resources.tables['migration-state'],
        })
      rate = bundle.rate
      registerFinalPublicationExercise(bundle.exercise)
    }
  } catch (error: unknown) {
    transport.close()
    throw error
  }
  try {
    requireRateManagedSessionSignalActive(signal)
  } catch (error: unknown) {
    try {
      await rate.close()
    } catch {
      // Preserve cancellation while still draining the owned rate lifecycle.
    }
    try {
      transport.close()
    } catch {
      // Preserve cancellation after attempting every owned transport close.
    }
    throw error
  }

  const prePlanAuthorityClock = snapshot.prePlanAuthorityClock
  /** Creates one child projection sharing the owned durable rate lifecycle. */
  const createMeasurementSession = () => {
    const child = new AwsWorkspaceSearchMigrationIdentityPort(
      resources,
      createDefaultAwsTransport(configurations),
      prePlanAuthorityClock,
      snapshot.telemetryRecorder,
      rate,
      false,
      undefined,
      rehearsalGuard,
      claimedRehearsalStageHead,
    )
    try {
      return Promise.resolve(
        createRateManagedMeasurementPortProjection(child),
      )
    } catch (error: unknown) {
      void child.close()
      throw error
    }
  }
  try {
    if (integrity !== undefined) {
      if (
        rehearsalGuard === undefined ||
        claimedRehearsalStageHead === undefined
      ) throw new WorkspaceSearchMigrationRehearsalPermitError()
      return new AwsWorkspaceSearchMigrationRehearsalIntegrityPort(
        resources,
        transport,
        prePlanAuthorityClock,
        rate,
        createMeasurementSession,
        rehearsalGuard,
        claimedRehearsalStageHead,
        integrity,
        signal,
      )
    }
    return new AwsWorkspaceSearchMigrationIdentityPort(
      resources,
      transport,
      prePlanAuthorityClock,
      snapshot.telemetryRecorder,
      rate,
      true,
      createMeasurementSession,
      rehearsalGuard,
      claimedRehearsalStageHead,
    )
  } catch (error: unknown) {
    try {
      await rate.close()
    } catch {
      // Preserve the composition failure while still draining owned I/O.
    }
    transport.close()
    throw error
  }
}

/**
 * Projects one full internal child onto the exact runtime identity capability.
 *
 * @param child - Fresh child owning only its independent AWS transport.
 * @returns Frozen receiver-preserving identity and measurement surface.
 */
function createRateManagedMeasurementPortProjection(
  child: WorkspaceSearchMigrationManagedIdentityPort,
): WorkspaceSearchMigrationManagedIdentityPort {
  let readRequestedResourcesBinding:
    WorkspaceSearchMigrationManagedIdentityPort[
      'readRequestedResourcesBinding'
    ]
  let readCallerIdentity:
    WorkspaceSearchMigrationManagedIdentityPort['readCallerIdentity']
  let describeTable:
    WorkspaceSearchMigrationManagedIdentityPort['describeTable']
  let describeContinuousBackups:
    WorkspaceSearchMigrationManagedIdentityPort[
      'describeContinuousBackups'
    ]
  let describeTimeToLive:
    WorkspaceSearchMigrationManagedIdentityPort['describeTimeToLive']
  let describeJournalKey:
    WorkspaceSearchMigrationManagedIdentityPort['describeJournalKey']
  let getBucketVersioning:
    WorkspaceSearchMigrationManagedIdentityPort['getBucketVersioning']
  let getObjectLockConfiguration:
    WorkspaceSearchMigrationManagedIdentityPort[
      'getObjectLockConfiguration'
    ]
  let getBucketEncryption:
    WorkspaceSearchMigrationManagedIdentityPort['getBucketEncryption']
  let getBucketLogging:
    WorkspaceSearchMigrationManagedIdentityPort['getBucketLogging']
  let measureConfiguration:
    WorkspaceSearchMigrationManagedIdentityPort['measureConfiguration']
  let close: WorkspaceSearchMigrationManagedIdentityPort['close']
  try {
    readRequestedResourcesBinding = child.readRequestedResourcesBinding
    readCallerIdentity = child.readCallerIdentity
    describeTable = child.describeTable
    describeContinuousBackups = child.describeContinuousBackups
    describeTimeToLive = child.describeTimeToLive
    describeJournalKey = child.describeJournalKey
    getBucketVersioning = child.getBucketVersioning
    getObjectLockConfiguration = child.getObjectLockConfiguration
    getBucketEncryption = child.getBucketEncryption
    getBucketLogging = child.getBucketLogging
    measureConfiguration = child.measureConfiguration
    close = child.close
  } catch {
    throw invalidIdentityLookup()
  }
  if (
    typeof readRequestedResourcesBinding !== 'function' ||
    typeof readCallerIdentity !== 'function' ||
    typeof describeTable !== 'function' ||
    typeof describeContinuousBackups !== 'function' ||
    typeof describeTimeToLive !== 'function' ||
    typeof describeJournalKey !== 'function' ||
    typeof getBucketVersioning !== 'function' ||
    typeof getObjectLockConfiguration !== 'function' ||
    typeof getBucketEncryption !== 'function' ||
    typeof getBucketLogging !== 'function' ||
    typeof measureConfiguration !== 'function' ||
    typeof close !== 'function'
  ) {
    throw invalidIdentityLookup()
  }
  const projection: WorkspaceSearchMigrationManagedIdentityPort = {
    readRequestedResourcesBinding: () =>
      Reflect.apply(readRequestedResourcesBinding, child, []),
    readCallerIdentity: async () =>
      await Reflect.apply(readCallerIdentity, child, []),
    describeTable: async (tableName) =>
      await Reflect.apply(describeTable, child, [tableName]),
    describeContinuousBackups: async (tableName) =>
      await Reflect.apply(describeContinuousBackups, child, [tableName]),
    describeTimeToLive: async (tableName) =>
      await Reflect.apply(describeTimeToLive, child, [tableName]),
    describeJournalKey: async (keyArn) =>
      await Reflect.apply(describeJournalKey, child, [keyArn]),
    getBucketVersioning: async (lookup) =>
      await Reflect.apply(getBucketVersioning, child, [lookup]),
    getObjectLockConfiguration: async (lookup) =>
      await Reflect.apply(getObjectLockConfiguration, child, [lookup]),
    getBucketEncryption: async (lookup) =>
      await Reflect.apply(getBucketEncryption, child, [lookup]),
    getBucketLogging: async (lookup) =>
      await Reflect.apply(getBucketLogging, child, [lookup]),
    measureConfiguration: async () =>
      await Reflect.apply(measureConfiguration, child, []),
    close: () => {
      Reflect.apply(close, child, [])
    },
  }
  return Object.freeze(projection)
}

/** Reads and detaches every production input before the first STS await. */
function detachRateManagedAwsSessionConstructionInput(
  input: CreateAwsWorkspaceSearchMigrationRateManagedSessionInput,
): RateManagedAwsSessionConstructionSnapshot {
  let requested: WorkspaceSearchMigrationRequestedResources
  let ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  let bootstrapRateCheckpoint: boolean
  let recoverInterruptedCleanup: boolean
  let recoverInterruptedAttempt: boolean
  let rateRecorder: WorkspaceSearchMigrationDescribeTableRateRecorder | undefined
  let telemetryRecorder: WorkspaceSearchMigrationTelemetryRecorder | undefined
  let prePlanAuthorityClock:
    WorkspaceSearchMigrationPrePlanAuthorityClock | undefined
  let signal: AbortSignal | undefined
  try {
    requested = input.requested
    ratePolicy = structuredClone(input.ratePolicy)
    bootstrapRateCheckpoint = input.bootstrapRateCheckpoint
    recoverInterruptedCleanup = input.recoverInterruptedCleanup
    recoverInterruptedAttempt = input.recoverInterruptedAttempt
    rateRecorder = input.rateRecorder
    telemetryRecorder = input.telemetryRecorder
    prePlanAuthorityClock = input.prePlanAuthorityClock
    signal = input.signal
  } catch {
    throw new WorkspaceSearchMigrationManagedDescribeTableRateError()
  }
  if (
    typeof bootstrapRateCheckpoint !== 'boolean' ||
    typeof recoverInterruptedCleanup !== 'boolean' ||
    typeof recoverInterruptedAttempt !== 'boolean' ||
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    (
      telemetryRecorder !== undefined &&
      (typeof telemetryRecorder !== 'object' || telemetryRecorder === null)
    )
  ) {
    throw new WorkspaceSearchMigrationManagedDescribeTableRateError()
  }
  let telemetryRecord:
    WorkspaceSearchMigrationTelemetryRecorder['record'] | undefined
  try {
    telemetryRecord = telemetryRecorder?.record
  } catch {
    throw new WorkspaceSearchMigrationManagedDescribeTableRateError()
  }
  if (
    telemetryRecorder !== undefined &&
    typeof telemetryRecord !== 'function'
  ) {
    throw new WorkspaceSearchMigrationManagedDescribeTableRateError()
  }
  const capturedTelemetryRecorder:
    WorkspaceSearchMigrationQuarantineTelemetryRecorder | undefined =
      telemetryRecorder === undefined || telemetryRecord === undefined
        ? undefined
        : Object.freeze({
          /**
           * Forwards one quarantine observation through the captured recorder.
           *
           * @param observation - Candidate secret-free quarantine observation.
           */
          record: (observation: unknown): void => {
            const result: unknown = Reflect.apply(
              telemetryRecord,
              telemetryRecorder,
              [observation],
            )
            if (result !== undefined) {
              consumeIdentityTelemetryNativePromise(result)
            }
          },
        })
  return Object.freeze({
    resources:
      createWorkspaceSearchMigrationRequestedResourcesSnapshot(requested),
    ratePolicy: Object.freeze(ratePolicy),
    bootstrapRateCheckpoint,
    recoverInterruptedCleanup,
    recoverInterruptedAttempt,
    ...(rateRecorder === undefined ? {} : { rateRecorder }),
    ...(capturedTelemetryRecorder === undefined
      ? {}
      : { telemetryRecorder: capturedTelemetryRecorder }),
    prePlanAuthorityClock: prePlanAuthorityClock ??
      createWorkspaceSearchMigrationPrePlanAuthoritySystemTime,
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Strict public-record guards for the permit-backed integrity factory. */
const rehearsalIntegritySessionConstructionGuards =
  new WorkspaceSearchMigrationStrictRecordGuards(
    failRehearsalIntegritySessionConstruction,
  )

/** Required public fields for one permit-backed integrity construction. */
const rehearsalIntegritySessionRequiredConstructionKeys = Object.freeze([
  'integrityDigestKey',
  'permit',
  'permitVerificationKey',
  'ratePolicy',
  'requested',
  'resourceAttestationBytes',
  'stageReservationClaim',
])

/** Optional public fields inherited from the restricted rehearsal session. */
const rehearsalIntegritySessionOptionalConstructionKeys = Object.freeze([
  'permitClock',
  'rateRecorder',
  'signal',
])

/** Raises the stable permit boundary for malformed integrity construction. */
function failRehearsalIntegritySessionConstruction(): never {
  throw new WorkspaceSearchMigrationRehearsalPermitError()
}

/**
 * Authenticates the complete dedicated integrity construction synchronously.
 *
 * Canonical attestation parsing, immutable identity derivation, exact permit
 * comparison, source-controlled target resolution, and exact ten-table rate
 * selection all finish before credentials, clients, or checkpoint I/O exist.
 * The caller-owned attestation and integrity key are overwritten on every path.
 *
 * @param input - Exact permit-backed owner-only construction input.
 * @returns Detached generic, permit, and private integrity construction state.
 */
function detachNonProductionRehearsalIntegritySessionConstruction(
  input: CreateAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
): NonProductionRehearsalIntegritySessionConstructionSnapshot {
  let transferredAttestationBytes: unknown
  let transferredIntegrityKey: unknown
  let resourceAttestationBytes: Uint8Array | undefined
  let integrityDigestKey: Uint8Array | undefined
  let permitVerificationKey: Uint8Array | undefined
  let preflight: NonProductionRehearsalConstructionPreflight | undefined
  try {
    const record = rehearsalIntegritySessionConstructionGuards.requireRecord(
      input,
    )
    transferredAttestationBytes = readRehearsalIntegrityOwnDataCandidate(
      record,
      'resourceAttestationBytes',
    )
    transferredIntegrityKey = readRehearsalIntegrityOwnDataCandidate(
      record,
      'integrityDigestKey',
    )
    const exactKeys = [
      ...rehearsalIntegritySessionRequiredConstructionKeys,
      ...rehearsalIntegritySessionOptionalConstructionKeys.filter(
        (key) => Object.hasOwn(record, key),
      ),
    ]
    rehearsalIntegritySessionConstructionGuards.requireExactKeys(
      record,
      exactKeys,
    )
    transferredAttestationBytes =
      rehearsalIntegritySessionConstructionGuards.readOwn(
        record,
        'resourceAttestationBytes',
      )
    transferredIntegrityKey =
      rehearsalIntegritySessionConstructionGuards.readOwn(
        record,
        'integrityDigestKey',
      )
    resourceAttestationBytes = copyRehearsalIntegrityBytes(
      transferredAttestationBytes,
      CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
    )
    integrityDigestKey = copyRehearsalIntegrityKey(
      transferredIntegrityKey,
    )
    permitVerificationKey = copyRehearsalIntegrityKey(
      rehearsalIntegritySessionConstructionGuards.readOwn(
        record,
        'permitVerificationKey',
      ),
    )
    if (timingSafeEqual(integrityDigestKey, permitVerificationKey)) {
      return failRehearsalIntegritySessionConstruction()
    }
    const genericInput:
      CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput = {
        requested: input.requested,
        ratePolicy: input.ratePolicy,
        bootstrapRateCheckpoint: false,
        recoverInterruptedCleanup: false,
        recoverInterruptedAttempt: false,
        ...(Object.hasOwn(record, 'rateRecorder')
          ? { rateRecorder: input.rateRecorder }
          : {}),
        permit: input.permit,
        permitVerificationKey,
        ...(Object.hasOwn(record, 'permitClock')
          ? { permitClock: input.permitClock }
          : {}),
        stageReservationClaim: input.stageReservationClaim,
        ...(Object.hasOwn(record, 'signal')
          ? { signal: input.signal }
          : {}),
      }
    const session = detachRateManagedAwsSessionConstructionInput(genericInput)
    if (session.signal !== undefined && nodeUtilTypes.isProxy(session.signal)) {
      return failRehearsalIntegritySessionConstruction()
    }
    preflight = detachNonProductionRehearsalConstructionGuard(
      genericInput,
      session.resources,
      session.ratePolicy,
    )
    if (
      createHash('sha256').update(permitVerificationKey).digest('hex') !==
        preflight.guard.permit.evidenceKeyDigest ||
      createHash('sha256').update(integrityDigestKey).digest('hex') ===
        preflight.guard.permit.evidenceKeyDigest
    ) return failRehearsalIntegritySessionConstruction()
    const validated = validateNonProductionRehearsalIntegrityConstruction(
      resourceAttestationBytes,
      integrityDigestKey,
      session,
      preflight,
    )
    resourceAttestationBytes = undefined
    integrityDigestKey = undefined
    preflight = undefined
    return Object.freeze({
      session,
      preflight: validated.preflight,
      integrity: validated.integrity,
    })
  } catch {
    return failRehearsalIntegritySessionConstruction()
  } finally {
    zeroizeRehearsalIntegrityCandidate(transferredAttestationBytes)
    zeroizeRehearsalIntegrityCandidate(transferredIntegrityKey)
    resourceAttestationBytes?.fill(0)
    integrityDigestKey?.fill(0)
    permitVerificationKey?.fill(0)
    preflight?.stageReservationClaim?.destroy()
  }
}

/** Validated private state paired with its already authenticated preflight. */
type ValidatedNonProductionRehearsalIntegrityConstruction = {
  /** Authenticated permit and optional prepared stage claim. */
  readonly preflight: NonProductionRehearsalConstructionPreflight
  /** Canonical attestation, key, resource map, digest, and rate tables. */
  readonly integrity: NonProductionRehearsalIntegrityConstruction
}

/**
 * Matches one canonical private attestation and dedicated key to the permit.
 *
 * @param resourceAttestationBytes - Owned canonical attestation byte copy.
 * @param integrityDigestKey - Owned dedicated 32-byte key copy.
 * @param session - Detached requested resources and reviewed rate policy.
 * @param preflight - Authenticated permit and optional prepared stage claim.
 * @returns Permit-matched private integrity state retaining both byte arrays.
 */
function validateNonProductionRehearsalIntegrityConstruction(
  resourceAttestationBytes: Uint8Array,
  integrityDigestKey: Uint8Array,
  session: RateManagedAwsSessionConstructionSnapshot,
  preflight: NonProductionRehearsalConstructionPreflight,
): ValidatedNonProductionRehearsalIntegrityConstruction {
  const attestation = parseCanonicalRehearsalIntegrityAttestation(
    resourceAttestationBytes,
  )
  if (preflight.stageReservationClaim === undefined) {
    return failRehearsalIntegritySessionConstruction()
  }
  const permit = preflight.guard.permit
  const target = resolveWorkspaceSearchMigrationRehearsalDeploymentTarget(
    permit.deploymentTargetId,
  )
  const productionAccountDigest =
    createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
      permit.productionAccount,
    )
  if (
    attestation.account !== session.resources.account ||
    attestation.region !== session.resources.region ||
    permit.account !== target.deploymentAccount ||
    permit.region !== target.region ||
    permit.deploymentTrustRootDigest !== target.digest ||
    productionAccountDigest !== target.productionAccountDigest ||
    permit.policyVersion !== session.ratePolicy.policyVersion ||
    permit.integrityAttestationRoot.attestation.byteLength !==
      resourceAttestationBytes.byteLength ||
    permit.integrityResourceIdentityScheme !==
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  ) return failRehearsalIntegritySessionConstruction()
  const identities = createCrossDomainIntegrityImmutableResourceIdentities(
    attestation,
    integrityDigestKey,
  )
  if (!sameRehearsalIntegrityResourceIdentities(
    identities,
    permit.integrityResourceIdentities,
  )) return failRehearsalIntegritySessionConstruction()
  const expectedResourceIdentityDigest =
    calculateCrossDomainIntegrityResourceIdentityDigest(
      identities,
      integrityDigestKey,
    )
  if (
    expectedResourceIdentityDigest !==
      permit.integrityResourceIdentityDigest
  ) return failRehearsalIntegritySessionConstruction()
  const tables = createRehearsalIntegrityTableNames(attestation)
  const rateTables = selectRehearsalIntegrityTables(
    session.resources.tables,
    tables,
  )
  return Object.freeze({
    preflight,
    integrity: Object.freeze({
      resourceAttestationBytes,
      integrityDigestKey,
      tables,
      buckets: Object.freeze({
        file: attestation.bucket.bucketName,
      }),
      expectedResourceIdentityDigest,
      rateTables,
    }),
  })
}

/** Parses exact canonical UTF-8 private resource-attestation bytes. */
function parseCanonicalRehearsalIntegrityAttestation(
  bytes: Uint8Array,
): CrossDomainIntegrityResourceAttestation {
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    parsed = JSON.parse(text)
    const attestation = parseCrossDomainIntegrityResourceAttestation(parsed)
    if (serializeCrossDomainIntegrityResourceAttestation(attestation) !== text) {
      return failRehearsalIntegritySessionConstruction()
    }
    return attestation
  } catch {
    return failRehearsalIntegritySessionConstruction()
  }
}

/** Projects the canonical six-table map from one strict attestation. */
function createRehearsalIntegrityTableNames(
  attestation: CrossDomainIntegrityResourceAttestation,
): CrossDomainIntegrityTableNames {
  const tables = attestation.tables
  if (tables.length !== 6) {
    return failRehearsalIntegritySessionConstruction()
  }
  return Object.freeze({
    'audit-events': tables[0]?.tableName ??
      failRehearsalIntegritySessionConstruction(),
    'file-proofing': tables[1]?.tableName ??
      failRehearsalIntegritySessionConstruction(),
    'project-directory': tables[2]?.tableName ??
      failRehearsalIntegritySessionConstruction(),
    'work-item-configuration': tables[3]?.tableName ??
      failRehearsalIntegritySessionConstruction(),
    'work-items': tables[4]?.tableName ??
      failRehearsalIntegritySessionConstruction(),
    'workspace-access': tables[5]?.tableName ??
      failRehearsalIntegritySessionConstruction(),
  })
}

/** Requires exact target-and-digest equality for both canonical vectors. */
function sameRehearsalIntegrityResourceIdentities(
  actual: readonly CrossDomainIntegrityResourceIdentity[],
  expected: readonly CrossDomainIntegrityResourceIdentity[],
): boolean {
  return actual.length === 7 &&
    expected.length === actual.length &&
    actual.every((identity, index) => {
      const expectedIdentity = expected[index]
      return expectedIdentity !== undefined &&
        identity.target === expectedIdentity.target &&
        identity.identityDigest === expectedIdentity.identityDigest
    })
}

/**
 * Selects exact migration cleanup and migration/integrity operational tables.
 *
 * @param migrationTables - Six migration tables from the requested snapshot.
 * @param integrityTables - Six integrity tables from the private attestation.
 * @returns Canonical recovery six and union ten.
 */
function selectRehearsalIntegrityTables(
  migrationTables: WorkspaceSearchMigrationRequestedResourcesSnapshot[
    'tables'
  ],
  integrityTables: CrossDomainIntegrityTableNames,
): RehearsalIntegrityTableSelection {
  const recoveryTableNames = Object.freeze([
    migrationTables['project-directory'],
    migrationTables['work-items'],
    migrationTables.collaboration,
    migrationTables.documents,
    migrationTables['workspace-search'],
    migrationTables['migration-state'],
  ])
  const integrityTableNames = Object.freeze([
    integrityTables['audit-events'],
    integrityTables['file-proofing'],
    integrityTables['project-directory'],
    integrityTables['work-item-configuration'],
    integrityTables['work-items'],
    integrityTables['workspace-access'],
  ])
  const allowedTableNames = Object.freeze([
    ...recoveryTableNames,
    integrityTables['audit-events'],
    integrityTables['file-proofing'],
    integrityTables['work-item-configuration'],
    integrityTables['workspace-access'],
  ])
  if (
    integrityTables['project-directory'] !==
      migrationTables['project-directory'] ||
    integrityTables['work-items'] !== migrationTables['work-items'] ||
    recoveryTableNames.length !== 6 ||
    new Set(recoveryTableNames).size !== 6 ||
    integrityTableNames.length !== 6 ||
    new Set(integrityTableNames).size !== 6 ||
    allowedTableNames.length !== 10 ||
    new Set(allowedTableNames).size !== 10 ||
    recoveryTableNames.some(
      (tableName) => !allowedTableNames.includes(tableName),
    )
  ) return failRehearsalIntegritySessionConstruction()
  return Object.freeze({ recoveryTableNames, allowedTableNames })
}

/** Copies one plain non-shared byte array below an explicit finite bound. */
function copyRehearsalIntegrityBytes(
  value: unknown,
  maximumByteLength: number,
): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failRehearsalIntegritySessionConstruction()
  const buffer = rehearsalIntegritySessionConstructionGuards
    .readIntrinsicBuffer(value)
  const byteLength = rehearsalIntegritySessionConstructionGuards
    .readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength < 1 ||
    byteLength > maximumByteLength
  ) return failRehearsalIntegritySessionConstruction()
  const copied = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
  } catch {
    copied.fill(0)
    return failRehearsalIntegritySessionConstruction()
  }
  return copied
}

/** Copies one exact plain non-shared 32-byte integrity key. */
function copyRehearsalIntegrityKey(value: unknown): Uint8Array {
  const key = copyRehearsalIntegrityBytes(value, 32)
  if (key.byteLength !== 32) {
    key.fill(0)
    return failRehearsalIntegritySessionConstruction()
  }
  return key
}

/** Reads one own data value without invoking a hostile accessor. */
function readRehearsalIntegrityOwnDataCandidate(
  value: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined
}

/** Best-effort intrinsic zeroization for transferred owner-only bytes. */
function zeroizeRehearsalIntegrityCandidate(value: unknown): void {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // A hostile detached view cannot weaken the already stable failure path.
  }
}

/** Strict public-record guards for one actual live invocation. */
const rehearsalIntegrityLiveInvocationGuards =
  new WorkspaceSearchMigrationStrictRecordGuards(
    failRehearsalIntegrityLiveInvocation,
  )

/** Raises the stable actual live outer-gate failure. */
function failRehearsalIntegrityLiveInvocation(): never {
  throw new WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError()
}

/**
 * Detaches the six-field live input and consumes its audit pseudonym key.
 *
 * @param input - Untrusted key, limits, and optional cancellation only.
 * @returns Detached bounded invocation safe to retain through AWS I/O.
 */
function detachRehearsalIntegrityLiveInvocation(
  input: RunAwsWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
): RehearsalIntegrityLiveInvocationSnapshot {
  let transferredAuditKey: unknown
  let auditPseudonymKey: Uint8Array | undefined
  try {
    const record = rehearsalIntegrityLiveInvocationGuards.requireRecord(input)
    transferredAuditKey = readRehearsalIntegrityOwnDataCandidate(
      record,
      'auditPseudonymKey',
    )
    const expectedKeys = Object.hasOwn(record, 'signal')
      ? [
        'auditPseudonymKey',
        'maxItems',
        'maxPages',
        'maximumDurationMilliseconds',
        'pageSize',
        'signal',
      ]
      : [
        'auditPseudonymKey',
        'maxItems',
        'maxPages',
        'maximumDurationMilliseconds',
        'pageSize',
      ]
    rehearsalIntegrityLiveInvocationGuards.requireExactKeys(
      record,
      expectedKeys,
    )
    transferredAuditKey = rehearsalIntegrityLiveInvocationGuards.readOwn(
      record,
      'auditPseudonymKey',
    )
    auditPseudonymKey = copyRehearsalIntegrityLiveKey(transferredAuditKey)
    const pageSize = readRehearsalIntegrityLiveBound(
      rehearsalIntegrityLiveInvocationGuards.readOwn(record, 'pageSize'),
      1_000,
    )
    const maxPages = readRehearsalIntegrityLiveBound(
      rehearsalIntegrityLiveInvocationGuards.readOwn(record, 'maxPages'),
      10_000,
    )
    const maxItems = readRehearsalIntegrityLiveBound(
      rehearsalIntegrityLiveInvocationGuards.readOwn(record, 'maxItems'),
      1_000_000,
    )
    validateCrossDomainIntegrityLimits({ pageSize, maxPages, maxItems })
    const maximumDurationMilliseconds = readRehearsalIntegrityLiveBound(
      rehearsalIntegrityLiveInvocationGuards.readOwn(
        record,
        'maximumDurationMilliseconds',
      ),
      CROSS_DOMAIN_INTEGRITY_MAX_DURATION_MILLISECONDS,
    )
    const signalValue = Object.hasOwn(record, 'signal')
      ? rehearsalIntegrityLiveInvocationGuards.readOwn(record, 'signal')
      : undefined
    if (
      signalValue !== undefined &&
      (!(signalValue instanceof AbortSignal) ||
        nodeUtilTypes.isProxy(signalValue))
    ) return failRehearsalIntegrityLiveInvocation()
    const snapshot = Object.freeze({
      auditPseudonymKey,
      pageSize,
      maxPages,
      maxItems,
      maximumDurationMilliseconds,
      ...(signalValue === undefined ? {} : { signal: signalValue }),
    })
    auditPseudonymKey = undefined
    return snapshot
  } catch {
    return failRehearsalIntegrityLiveInvocation()
  } finally {
    zeroizeRehearsalIntegrityCandidate(transferredAuditKey)
    auditPseudonymKey?.fill(0)
  }
}

/** Reads one finite positive integer under an explicit reviewed maximum. */
function readRehearsalIntegrityLiveBound(
  value: unknown,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) return failRehearsalIntegrityLiveInvocation()
  return value
}

/** Copies one plain non-shared byte array for the stable live boundary. */
function copyRehearsalIntegrityLiveBytes(
  value: unknown,
  maximumByteLength: number,
): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failRehearsalIntegrityLiveInvocation()
  const buffer = rehearsalIntegrityLiveInvocationGuards
    .readIntrinsicBuffer(value)
  const byteLength = rehearsalIntegrityLiveInvocationGuards
    .readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength < 1 ||
    byteLength > maximumByteLength
  ) return failRehearsalIntegrityLiveInvocation()
  const copied = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
  } catch {
    copied.fill(0)
    return failRehearsalIntegrityLiveInvocation()
  }
  return copied
}

/** Copies one exact plain non-shared 32-byte live HMAC key. */
function copyRehearsalIntegrityLiveKey(value: unknown): Uint8Array {
  const key = copyRehearsalIntegrityLiveBytes(value, 32)
  if (key.byteLength !== 32) {
    key.fill(0)
    return failRehearsalIntegrityLiveInvocation()
  }
  return key
}

/** Combines close/seal, construction, and invocation cancellation signals. */
function combineRehearsalIntegrityLiveSignals(
  operationalSignal: AbortSignal,
  sessionSignal: AbortSignal | undefined,
  invocationSignal: AbortSignal | undefined,
): AbortSignal {
  const signals: AbortSignal[] = [operationalSignal]
  if (sessionSignal !== undefined) signals.push(sessionSignal)
  if (invocationSignal !== undefined) signals.push(invocationSignal)
  try {
    return AbortSignal.any(signals)
  } catch {
    return failRehearsalIntegrityLiveInvocation()
  }
}

/** Strict standalone construction guards with one stable public failure. */
const standaloneStageCommitConstructionGuards =
  new WorkspaceSearchMigrationStrictRecordGuards(
    failStandaloneStageCommitConstruction,
  )

/** Raises the stable standalone preflight construction failure. */
function failStandaloneStageCommitConstruction(): never {
  throw new WorkspaceSearchMigrationRehearsalPermitError()
}

/**
 * Synchronously detaches and authenticates a standalone claim construction.
 *
 * @param input - Exact untrusted public construction input.
 * @returns Immutable resources, policy, guard, and one-shot claim capability.
 */
function detachNonProductionRehearsalStageClaimConstruction(
  input:
    ClaimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
): NonProductionRehearsalStageClaimConstruction {
  const record = standaloneStageCommitConstructionGuards.requireRecord(input)
  standaloneStageCommitConstructionGuards.requireExactKeys(record, [
    'permit',
    'permitClock',
    'permitVerificationKey',
    'ratePolicy',
    'requested',
    'stageReservationClaim',
  ])
  let requested: WorkspaceSearchMigrationRequestedResources
  let ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  let permit: unknown
  let permitVerificationKey: Uint8Array
  let permitClock: () => Date
  let stageReservationClaim:
    PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaimInput
  try {
    requested = input.requested
    ratePolicy = input.ratePolicy
    permit = input.permit
    permitVerificationKey = input.permitVerificationKey
    permitClock = input.permitClock
    stageReservationClaim = input.stageReservationClaim
  } catch {
    return failStandaloneStageCommitConstruction()
  }
  const resources =
    createWorkspaceSearchMigrationRequestedResourcesSnapshot(requested)
  const detachedRatePolicy = detachStandaloneStageCommitRatePolicy(ratePolicy)
  const guard = detachNonProductionRehearsalGuard({
    permit,
    permitVerificationKey,
    permitClock,
  }, resources)
  const preparedClaim =
    prepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaim(
      stageReservationClaim,
    )
  try {
    requireStageReservationMaterialMatchesRehearsalConstruction(
      preparedClaim,
      guard,
      createWorkspaceSearchMigrationRequestedResourcesBinding(resources),
      detachedRatePolicy.policyVersion,
    )
  } catch (error: unknown) {
    preparedClaim.destroy()
    throw error
  }
  return Object.freeze({
    resources,
    ratePolicy: detachedRatePolicy,
    guard,
    stageClaim: preparedClaim,
  })
}

/**
 * Synchronously detaches and authenticates a standalone commit construction.
 *
 * @param input - Exact untrusted public construction input.
 * @returns Immutable resources, policy, guard, and one-shot commit capability.
 */
function detachNonProductionRehearsalStageCommitConstruction(
  input:
    CommitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
): NonProductionRehearsalStageCommitConstruction {
  const record = standaloneStageCommitConstructionGuards.requireRecord(input)
  standaloneStageCommitConstructionGuards.requireExactKeys(record, [
    'permit',
    'permitClock',
    'permitVerificationKey',
    'ratePolicy',
    'requested',
    'stageReservationCommit',
  ])
  let requested: WorkspaceSearchMigrationRequestedResources
  let ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  let permit: unknown
  let permitVerificationKey: Uint8Array
  let permitClock: () => Date
  let stageReservationCommit:
    PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsCommitInput
  try {
    requested = input.requested
    ratePolicy = input.ratePolicy
    permit = input.permit
    permitVerificationKey = input.permitVerificationKey
    permitClock = input.permitClock
    stageReservationCommit = input.stageReservationCommit
  } catch {
    return failStandaloneStageCommitConstruction()
  }
  const resources =
    createWorkspaceSearchMigrationRequestedResourcesSnapshot(requested)
  const detachedRatePolicy = detachStandaloneStageCommitRatePolicy(
    ratePolicy,
  )
  const guard = detachNonProductionRehearsalGuard({
    permit,
    permitVerificationKey,
    permitClock,
  }, resources)
  const preparedCommit =
    prepareWorkspaceSearchMigrationRehearsalStageReservationAwsCommit(
      stageReservationCommit,
    )
  try {
    requireStageReservationMaterialMatchesRehearsalConstruction(
      preparedCommit,
      guard,
      createWorkspaceSearchMigrationRequestedResourcesBinding(resources),
      detachedRatePolicy.policyVersion,
    )
  } catch (error: unknown) {
    preparedCommit.destroy()
    throw error
  }
  return Object.freeze({
    resources,
    ratePolicy: detachedRatePolicy,
    guard,
    stageCommit: preparedCommit,
  })
}

/** Exact common keys admitted by a standalone stage-head read. */
const standaloneStageHeadConstructionKeys = Object.freeze([
  'manifest',
  'manifestVerificationKey',
  'permit',
  'permitClock',
  'permitVerificationKey',
  'ratePolicy',
  'requested',
])

/**
 * Synchronously authenticates one standalone stage-head read construction.
 *
 * @param input - Exact public read input.
 * @returns Detached resources, permit, policy, manifest, and private key copy.
 */
function detachNonProductionRehearsalStageHeadConstruction(
  input:
    ReadAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationHeadInput,
): NonProductionRehearsalStageHeadConstruction {
  return detachNonProductionRehearsalStageHeadConstructionWithKeys(
    input,
    standaloneStageHeadConstructionKeys,
  )
}

/**
 * Detaches common stage-head material while admitting an exact outer key set.
 *
 * @param input - Typed public input whose descriptors remain untrusted.
 * @param exactKeys - Complete outer property set for the selected operation.
 * @returns Authenticated common standalone construction.
 */
function detachNonProductionRehearsalStageHeadConstructionWithKeys(
  input: AwsWorkspaceSearchMigrationNonProductionRehearsalStageHeadInput,
  exactKeys: readonly string[],
): NonProductionRehearsalStageHeadConstruction {
  let manifestVerificationKey: Uint8Array | undefined
  try {
    const record = standaloneStageCommitConstructionGuards.requireRecord(input)
    standaloneStageCommitConstructionGuards.requireExactKeys(
      record,
      exactKeys,
    )
    let requested: WorkspaceSearchMigrationRequestedResources
    let ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
    let permit: unknown
    let permitVerificationKey: Uint8Array
    let permitClock: () => Date
    let manifest: unknown
    let manifestKey: Uint8Array
    try {
      requested = input.requested
      ratePolicy = input.ratePolicy
      permit = input.permit
      permitVerificationKey = input.permitVerificationKey
      permitClock = input.permitClock
      manifest = input.manifest
      manifestKey = input.manifestVerificationKey
    } catch {
      return failStandaloneStageCommitConstruction()
    }
    const resources =
      createWorkspaceSearchMigrationRequestedResourcesSnapshot(requested)
    const detachedRatePolicy =
      detachStandaloneStageCommitRatePolicy(ratePolicy)
    const guard = detachNonProductionRehearsalGuard({
      permit,
      permitVerificationKey,
      permitClock,
    }, resources)
    manifestVerificationKey = copyStandaloneStageHeadKey(manifestKey)
    const authenticatedManifest =
      verifyWorkspaceSearchMigrationRehearsalStageManifest(
        manifest,
        manifestVerificationKey,
      )
    requireStandaloneStageManifestBinding(
      authenticatedManifest,
      manifestVerificationKey,
      guard,
      resources,
      detachedRatePolicy,
    )
    const construction = Object.freeze({
      resources,
      ratePolicy: detachedRatePolicy,
      guard,
      manifest: authenticatedManifest,
      manifestVerificationKey,
    })
    manifestVerificationKey = undefined
    return construction
  } catch {
    return failStandaloneStageCommitConstruction()
  } finally {
    zeroizeStandaloneStageHeadKey(manifestVerificationKey)
  }
}

/**
 * Authenticates an explicit parent-authorized abandonment before remote I/O.
 *
 * @param input - Exact public abandonment input.
 * @returns Detached manifest, selection, token, transition, keys, and time.
 */
function detachNonProductionRehearsalStageAbandonmentConstruction(
  input:
    AbandonAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
): NonProductionRehearsalStageAbandonmentConstruction {
  const construction =
    detachNonProductionRehearsalStageHeadConstructionWithKeys(
      input,
      [
        ...standaloneStageHeadConstructionKeys,
        'stageReservationAbandonment',
      ],
    )
  let runtimeVerificationKey: Uint8Array | undefined
  let publicationVerificationKey: Uint8Array | undefined
  try {
    const outer = standaloneStageCommitConstructionGuards.requireRecord(input)
    const abandonmentInput =
      standaloneStageCommitConstructionGuards.requireRecord(
        standaloneStageCommitConstructionGuards.readOwn(
          outer,
          'stageReservationAbandonment',
        ),
      )
    standaloneStageCommitConstructionGuards.requireExactKeys(
      abandonmentInput,
      [
        'abandonment',
        'observedAt',
        'publicationVerificationKey',
        'reservation',
        'runtimeKeyCleanupAuthorization',
        'runtimeVerificationKey',
        'selection',
      ],
    )
    runtimeVerificationKey = copyStandaloneStageHeadKey(
      standaloneStageCommitConstructionGuards.readOwn(
        abandonmentInput,
        'runtimeVerificationKey',
      ),
    )
    publicationVerificationKey = copyStandaloneStageHeadKey(
      standaloneStageCommitConstructionGuards.readOwn(
        abandonmentInput,
        'publicationVerificationKey',
      ),
    )
    requireStandaloneStageSplitKeyBindings(
      construction,
      runtimeVerificationKey,
      publicationVerificationKey,
    )
    const selection = detachStandaloneStageSelection(
      standaloneStageCommitConstructionGuards.readOwn(
        abandonmentInput,
        'selection',
      ),
      runtimeVerificationKey,
      construction.manifest,
    )
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: standaloneStageCommitConstructionGuards.readOwn(
          abandonmentInput,
          'reservation',
        ),
        selection,
        verificationKey: runtimeVerificationKey,
      })
    const abandonment =
      verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
        abandonment: standaloneStageCommitConstructionGuards.readOwn(
          abandonmentInput,
          'abandonment',
        ),
        reservation,
        selection,
        runtimeVerificationKey,
        publicationVerificationKey,
      })
    const runtimeKeyCleanupAuthorization =
      standaloneStageCommitConstructionGuards.readOwn(
        abandonmentInput,
        'runtimeKeyCleanupAuthorization',
      )
    const cleanupBinding =
      readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
        runtimeKeyCleanupAuthorization,
      )
    if (
      cleanupBinding.reservationDigest !== createMigrationDigest(reservation) ||
      cleanupBinding.manifestDigest !== reservation.manifestDigest ||
      cleanupBinding.permitDigest !== reservation.permitDigest ||
      cleanupBinding.requestedResourcesBinding !==
        reservation.requestedResourcesBinding ||
      cleanupBinding.stageOrdinal !== reservation.stageOrdinal ||
      cleanupBinding.parentLivenessProtocol !==
        reservation.parentLivenessProtocol ||
      cleanupBinding.parentLivenessProtocol !==
        abandonment.parentLivenessProtocol ||
      cleanupBinding.runtimeKeyFingerprint !==
        createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint(
          runtimeVerificationKey,
        ) ||
      cleanupBinding.runtimeKeyFingerprint !==
        abandonment.runtimeKeyFingerprint ||
      cleanupBinding.cleanupCompletionDigest !==
        abandonment.runtimeKeyCleanupCompletionDigest ||
      Date.parse(cleanupBinding.completedAt) >
        Date.parse(abandonment.abandonedAt)
    ) return failStandaloneStageCommitConstruction()
    const observedAt =
      standaloneStageCommitConstructionGuards.readTimestamp(
        standaloneStageCommitConstructionGuards.readOwn(
          abandonmentInput,
          'observedAt',
        ),
      )
    requireStandaloneStageAbandonmentTimeBindings(
      reservation,
      abandonment,
      observedAt,
      construction.guard,
    )
    const detached = Object.freeze({
      ...construction,
      selection,
      reservation,
      abandonment,
      runtimeKeyCleanupAuthorization,
      runtimeVerificationKey,
      publicationVerificationKey,
      observedAt,
    })
    runtimeVerificationKey = undefined
    publicationVerificationKey = undefined
    return detached
  } catch {
    zeroizeStandaloneStageHeadKey(
      construction.manifestVerificationKey,
    )
    return failStandaloneStageCommitConstruction()
  } finally {
    zeroizeStandaloneStageHeadKey(runtimeVerificationKey)
    zeroizeStandaloneStageHeadKey(publicationVerificationKey)
  }
}

/**
 * Authenticates one exact full-suite immutable commit recovery construction.
 *
 * @param input - Exact public recovery input.
 * @returns Detached manifest, authenticated receipt chain, and split keys.
 */
function detachNonProductionRehearsalStageCommitRecoveryConstruction(
  input:
    RecoverAwsWorkspaceSearchMigrationNonProductionRehearsalStageCommitDurabilityAuthorizationsInput,
): NonProductionRehearsalStageCommitRecoveryConstruction {
  const construction =
    detachNonProductionRehearsalStageHeadConstructionWithKeys(
      input,
      [
        ...standaloneStageHeadConstructionKeys,
        'publicationVerificationKey',
        'receipts',
        'reservationAbandonments',
        'runtimeVerificationKey',
      ],
    )
  let runtimeVerificationKey: Uint8Array | undefined
  let publicationVerificationKey: Uint8Array | undefined
  try {
    const record = standaloneStageCommitConstructionGuards.requireRecord(input)
    runtimeVerificationKey = copyStandaloneStageHeadKey(
      standaloneStageCommitConstructionGuards.readOwn(
        record,
        'runtimeVerificationKey',
      ),
    )
    publicationVerificationKey = copyStandaloneStageHeadKey(
      standaloneStageCommitConstructionGuards.readOwn(
        record,
        'publicationVerificationKey',
      ),
    )
    requireStandaloneStageSplitKeyBindings(
      construction,
      runtimeVerificationKey,
      publicationVerificationKey,
    )
    const receipts = authenticateStandaloneStageCommitRecoveryReceipts(
      standaloneStageCommitConstructionGuards.readOwn(record, 'receipts'),
      runtimeVerificationKey,
      construction.manifest,
    )
    const reservationAbandonments =
      detachStandaloneStageCommitRecoveryAbandonments(
        standaloneStageCommitConstructionGuards.readOwn(
          record,
          'reservationAbandonments',
        ),
        receipts.at(-1)?.stageReservationAbandonmentCount ?? -1,
      )
    const detached = Object.freeze({
      ...construction,
      receipts,
      reservationAbandonments,
      runtimeVerificationKey,
      publicationVerificationKey,
    })
    runtimeVerificationKey = undefined
    publicationVerificationKey = undefined
    return detached
  } catch {
    zeroizeStandaloneStageHeadKey(
      construction.manifestVerificationKey,
    )
    return failStandaloneStageCommitConstruction()
  } finally {
    zeroizeStandaloneStageHeadKey(runtimeVerificationKey)
    zeroizeStandaloneStageHeadKey(publicationVerificationKey)
  }
}

/**
 * Runs one head/store operation behind the complete non-production preflight.
 *
 * @param construction - Synchronously authenticated standalone construction.
 * @param operation - Narrow store operation using the preflight-owned transport.
 * @returns Exact operation result after STS and journal-tag authentication.
 */
async function runNonProductionRehearsalStageHeadOperation<Result>(
  construction: NonProductionRehearsalStageHeadConstruction,
  operation: (
    transport: WorkspaceSearchMigrationRehearsalStageCommitAwsTransport,
  ) => Promise<Result>,
): Promise<Result> {
  let transport:
    AwsSdkWorkspaceSearchMigrationRehearsalStageCommitTransport | undefined
  try {
    const credentialsProvider = createPinnedProfileCredentials(
      construction.resources,
    )
    const configurations = createIdentityAwsSdkConfigurations(
      construction.resources,
      credentialsProvider,
    )
    transport =
      new AwsSdkWorkspaceSearchMigrationRehearsalStageCommitTransport(
        configurations,
      )
    const caller = await transport.getCallerIdentity(
      new GetCallerIdentityCommand({}),
    )
    requirePreMeasurementCallerIdentity(
      caller,
      construction.resources.account,
    )
    await credentialsProvider()
    requireNonProductionRehearsalCaller(caller, construction.guard)
    requireNonProductionRehearsalPermitActive(construction.guard)
    const bucketTags = await transport.getBucketTagging(
      new GetBucketTaggingCommand({
        Bucket: construction.resources.journalBucket,
        ExpectedBucketOwner: construction.resources.account,
      }),
    )
    requireNonProductionRehearsalJournalTags(
      bucketTags,
      construction.guard,
    )
    requireNonProductionRehearsalPermitActive(construction.guard)
    return await operation(transport)
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalStageReservationAwsError
    ) throw error
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  } finally {
    transport?.close()
  }
}

/**
 * Requires one authenticated manifest to match the permit and policy exactly.
 *
 * @param manifest - Detached authenticated complete reviewed manifest.
 * @param manifestVerificationKey - Private copied manifest key.
 * @param guard - Authenticated permit and clock.
 * @param resources - Exact validated requested resources.
 * @param ratePolicy - Exact reviewed DescribeTable policy.
 */
function requireStandaloneStageManifestBinding(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  manifestVerificationKey: Uint8Array,
  guard: NonProductionRehearsalConstructionGuard,
  resources: WorkspaceSearchMigrationRequestedResourcesSnapshot,
  ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy,
): void {
  const reviewedAt = Date.parse(manifest.reviewedAt)
  if (
    manifest.commit !== guard.permit.commit ||
    manifest.commit !== resources.commit ||
    manifest.deploymentTrustRootDigest !==
      guard.permit.deploymentTrustRootDigest ||
    manifest.permitDigest !== guard.permitDigest ||
    manifest.requestedResourcesBinding !==
      createWorkspaceSearchMigrationRequestedResourcesBinding(resources) ||
    manifest.integrityResourceIdentityScheme !==
      guard.permit.integrityResourceIdentityScheme ||
    !sameManagedReconciliationResourceIdentityVector(
      manifest.integrityResourceIdentities,
      guard.permit.integrityResourceIdentities,
    ) ||
    manifest.integrityResourceIdentityDigest !==
      guard.permit.integrityResourceIdentityDigest ||
    manifest.evidenceKeyDigest !== guard.permit.evidenceKeyDigest ||
    manifest.publicationKeyDigest !==
      guard.permit.publicationKeyDigest ||
    manifest.policyVersion !== ratePolicy.policyVersion ||
    createHash('sha256').update(manifestVerificationKey).digest('hex') !==
      guard.permit.evidenceKeyDigest ||
    reviewedAt < Date.parse(guard.permit.issuedAt) ||
    reviewedAt >= Date.parse(guard.permit.expiresAt)
  ) return failStandaloneStageCommitConstruction()
}

/**
 * Requires runtime and publication key copies to match split permit bindings.
 *
 * @param construction - Authenticated common manifest construction.
 * @param runtimeVerificationKey - Copied runtime verification key.
 * @param publicationVerificationKey - Copied publication verification key.
 */
function requireStandaloneStageSplitKeyBindings(
  construction: NonProductionRehearsalStageHeadConstruction,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): void {
  if (
    createHash('sha256').update(runtimeVerificationKey).digest('hex') !==
      construction.manifest.evidenceKeyDigest ||
    createHash('sha256')
      .update(publicationVerificationKey)
      .digest('hex') !== construction.manifest.publicationKeyDigest
  ) return failStandaloneStageCommitConstruction()
}

/**
 * Authenticates and detaches one exact manifest selection under its runtime key.
 *
 * @param value - Candidate selection record.
 * @param runtimeVerificationKey - Runtime manifest verification key.
 * @param expectedManifest - Independently authenticated outer manifest.
 * @returns Frozen selection using only the verified manifest entry.
 */
function detachStandaloneStageSelection(
  value: unknown,
  runtimeVerificationKey: Uint8Array,
  expectedManifest: WorkspaceSearchMigrationRehearsalStageManifest,
): WorkspaceSearchMigrationRehearsalSelectedStage {
  const record = standaloneStageCommitConstructionGuards.requireRecord(value)
  standaloneStageCommitConstructionGuards.requireExactKeys(record, [
    'entry',
    'manifest',
    'manifestDigest',
    'previousStageReceiptDigest',
  ])
  const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
    standaloneStageCommitConstructionGuards.readOwn(record, 'manifest'),
    runtimeVerificationKey,
  )
  const manifestDigest =
    standaloneStageCommitConstructionGuards.readDigest(
      standaloneStageCommitConstructionGuards.readOwn(
        record,
        'manifestDigest',
      ),
    )
  if (
    manifestDigest !== createMigrationDigest(manifest) ||
    manifestDigest !== createMigrationDigest(expectedManifest)
  ) return failStandaloneStageCommitConstruction()
  const entryRecord = standaloneStageCommitConstructionGuards.requireRecord(
    standaloneStageCommitConstructionGuards.readOwn(record, 'entry'),
  )
  standaloneStageCommitConstructionGuards.requireExactKeys(entryRecord, [
    'attemptOrdinal',
    'command',
    'controlArgumentsDigest',
    'expectedOutcome',
    'faultPlanDigest',
    'ordinal',
    'scenario',
    'scenarioStageOrdinal',
  ])
  const ordinal = standaloneStageCommitConstructionGuards.readOwn(
    entryRecord,
    'ordinal',
  )
  if (!Number.isSafeInteger(ordinal) || typeof ordinal !== 'number') {
    return failStandaloneStageCommitConstruction()
  }
  const entry = manifest.entries[ordinal - 1]
  if (
    entry === undefined ||
    createMigrationDigest(entryRecord) !== createMigrationDigest(entry)
  ) return failStandaloneStageCommitConstruction()
  const previousValue = standaloneStageCommitConstructionGuards.readOwn(
    record,
    'previousStageReceiptDigest',
  )
  const previousStageReceiptDigest = previousValue === null
    ? null
    : standaloneStageCommitConstructionGuards.readDigest(previousValue)
  if ((ordinal === 1) !== (previousStageReceiptDigest === null)) {
    return failStandaloneStageCommitConstruction()
  }
  return Object.freeze({
    manifest,
    manifestDigest,
    entry,
    previousStageReceiptDigest,
  })
}

/**
 * Requires reservation and parent authorization times inside one permit.
 *
 * @param reservation - Runtime-authenticated active reservation.
 * @param abandonment - Parent-authenticated immutable transition.
 * @param observedAt - Trusted operation admission timestamp.
 * @param guard - Authenticated short-lived permit.
 */
function requireStandaloneStageAbandonmentTimeBindings(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  abandonment:
    WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
  observedAt: string,
  guard: NonProductionRehearsalConstructionGuard,
): void {
  const issuedAt = Date.parse(guard.permit.issuedAt)
  const expiresAt = Date.parse(guard.permit.expiresAt)
  const observedAtMilliseconds = Date.parse(observedAt)
  if (
    Date.parse(reservation.reservedAt) < issuedAt ||
    Date.parse(reservation.expiresAt) > expiresAt ||
    observedAtMilliseconds < issuedAt ||
    observedAtMilliseconds >= expiresAt ||
    observedAtMilliseconds < Date.parse(abandonment.abandonedAt)
  ) return failStandaloneStageCommitConstruction()
}

/**
 * Authenticates the sole dense exact 36-receipt full-suite chain.
 *
 * @param value - Candidate dense receipt array.
 * @param runtimeVerificationKey - Runtime receipt verification key.
 * @param manifest - Authenticated complete reviewed manifest.
 * @returns Frozen ordered authenticated receipt array.
 */
function authenticateStandaloneStageCommitRecoveryReceipts(
  value: unknown,
  runtimeVerificationKey: Uint8Array,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
): readonly WorkspaceSearchMigrationRehearsalStageReceipt[] {
  const expectedLength =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== expectedLength ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    Object.getOwnPropertyNames(value).length !== expectedLength + 1
  ) return failStandaloneStageCommitConstruction()
  const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
  let previousStageReceiptDigest: string | null = null
  const manifestDigest = createMigrationDigest(manifest)
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) return failStandaloneStageCommitConstruction()
    const receipt =
      verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        descriptor.value,
        runtimeVerificationKey,
      )
    const entry = manifest.entries[index]
    if (
      entry === undefined ||
      receipt.stageOrdinal !== index + 1 ||
      receipt.manifestDigest !== manifestDigest ||
      receipt.manifestEntryDigest !== createMigrationDigest(entry) ||
      receipt.permitDigest !== manifest.permitDigest ||
      receipt.commit !== manifest.commit ||
      receipt.requestedResourcesBinding !==
        manifest.requestedResourcesBinding ||
      receipt.configurationBindingDigest !==
        manifest.configurationBindingDigest ||
      receipt.policyVersion !== manifest.policyVersion ||
      receipt.scenario !== entry.scenario ||
      receipt.scenarioStageOrdinal !== entry.scenarioStageOrdinal ||
      receipt.command !== entry.command ||
      receipt.controlArgumentsDigest !== entry.controlArgumentsDigest ||
      receipt.attemptOrdinal !== entry.attemptOrdinal ||
      receipt.outcome !== entry.expectedOutcome ||
      receipt.previousStageReceiptDigest !== previousStageReceiptDigest
    ) return failStandaloneStageCommitConstruction()
    receipts.push(receipt)
    previousStageReceiptDigest = createMigrationDigest(receipt)
  }
  return Object.freeze(receipts)
}

/**
 * Safely detaches the exact bounded reservation/abandonment pair array.
 *
 * Cryptographic authentication remains inside the same store recovery call
 * that addresses and strongly reads every corresponding immutable row.
 *
 * @param value - Candidate dense pair array.
 * @param expectedLength - Exact terminal cumulative abandonment count.
 * @returns Frozen accessor-free pair records in cumulative count order.
 */
function detachStandaloneStageCommitRecoveryAbandonments(
  value: unknown,
  expectedLength: number,
): readonly unknown[] {
  if (
    expectedLength < 0 ||
    expectedLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES ||
    !Number.isSafeInteger(expectedLength) ||
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== expectedLength ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    Object.getOwnPropertyNames(value).length !== expectedLength + 1
  ) return failStandaloneStageCommitConstruction()
  const pairs: unknown[] = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) return failStandaloneStageCommitConstruction()
    const pair = standaloneStageCommitConstructionGuards.requireRecord(
      descriptor.value,
    )
    standaloneStageCommitConstructionGuards.requireExactKeys(pair, [
      'abandonment',
      'reservation',
    ])
    pairs.push(Object.freeze({
      abandonment: standaloneStageCommitConstructionGuards.readOwn(
        pair,
        'abandonment',
      ),
      reservation: standaloneStageCommitConstructionGuards.readOwn(
        pair,
        'reservation',
      ),
    }))
  }
  return Object.freeze(pairs)
}

/** Copies one exact non-shared 32-byte standalone stage key. */
function copyStandaloneStageHeadKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(
      standaloneStageCommitConstructionGuards.readIntrinsicBuffer(value),
    ) ||
    standaloneStageCommitConstructionGuards
      .readIntrinsicByteLength(value) !== 32
  ) return failStandaloneStageCommitConstruction()
  let copied: unknown
  try {
    copied = Reflect.apply(Uint8Array.prototype.slice, value, [])
  } catch {
    return failStandaloneStageCommitConstruction()
  }
  if (
    !(copied instanceof Uint8Array) ||
    copied.byteLength !== 32
  ) return failStandaloneStageCommitConstruction()
  return copied
}

/** Best-effort zeroization for one invocation-owned standalone key copy. */
function zeroizeStandaloneStageHeadKey(
  value: Uint8Array | undefined,
): void {
  if (value === undefined) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // The operation has already discarded this private key reference.
  }
}

/**
 * Detaches and validates every scalar in the standalone reviewed rate policy.
 *
 * @param value - Candidate exact policy record.
 * @returns Frozen complete reviewed policy.
 */
function detachStandaloneStageCommitRatePolicy(
  value: WorkspaceSearchMigrationDescribeTableRatePolicy,
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  const record = standaloneStageCommitConstructionGuards.requireRecord(value)
  standaloneStageCommitConstructionGuards.requireExactKeys(record, [
    'checkpointPageAttemptCapacity',
    'maximumAdmissionWaitMilliseconds',
    'maximumAttemptsPerLifecycle',
    'maximumAttemptsPerWindow',
    'minimumAttemptIntervalMilliseconds',
    'minimumPageIntervalMilliseconds',
    'policyVersion',
    'throttleBackoffInitialMilliseconds',
    'throttleBackoffMaximumMilliseconds',
    'windowMilliseconds',
  ])
  const policyVersion = standaloneStageCommitConstructionGuards.readOwn(
    record,
    'policyVersion',
  )
  const maximumAttemptsPerWindow =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'maximumAttemptsPerWindow',
    )
  const maximumAttemptsPerLifecycle =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'maximumAttemptsPerLifecycle',
    )
  const checkpointPageAttemptCapacity =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'checkpointPageAttemptCapacity',
    )
  const windowMilliseconds =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'windowMilliseconds',
    )
  const minimumAttemptIntervalMilliseconds =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'minimumAttemptIntervalMilliseconds',
    )
  const minimumPageIntervalMilliseconds =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'minimumPageIntervalMilliseconds',
    )
  const maximumAdmissionWaitMilliseconds =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'maximumAdmissionWaitMilliseconds',
    )
  const throttleBackoffInitialMilliseconds =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'throttleBackoffInitialMilliseconds',
    )
  const throttleBackoffMaximumMilliseconds =
    standaloneStageCommitConstructionGuards.readOwn(
      record,
      'throttleBackoffMaximumMilliseconds',
    )
  if (
    typeof policyVersion !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(policyVersion) ||
    typeof maximumAttemptsPerWindow !== 'number' ||
    typeof maximumAttemptsPerLifecycle !== 'number' ||
    typeof checkpointPageAttemptCapacity !== 'number' ||
    typeof windowMilliseconds !== 'number' ||
    typeof minimumAttemptIntervalMilliseconds !== 'number' ||
    typeof minimumPageIntervalMilliseconds !== 'number' ||
    typeof maximumAdmissionWaitMilliseconds !== 'number' ||
    typeof throttleBackoffInitialMilliseconds !== 'number' ||
    typeof throttleBackoffMaximumMilliseconds !== 'number'
  ) return failStandaloneStageCommitConstruction()
  const detached = Object.freeze({
    policyVersion,
    maximumAttemptsPerWindow,
    maximumAttemptsPerLifecycle,
    checkpointPageAttemptCapacity,
    windowMilliseconds,
    minimumAttemptIntervalMilliseconds,
    minimumPageIntervalMilliseconds,
    maximumAdmissionWaitMilliseconds,
    throttleBackoffInitialMilliseconds,
    throttleBackoffMaximumMilliseconds,
  })
  for (const scalar of [
    detached.maximumAttemptsPerWindow,
    detached.maximumAttemptsPerLifecycle,
    detached.checkpointPageAttemptCapacity,
    detached.windowMilliseconds,
    detached.minimumAttemptIntervalMilliseconds,
    detached.minimumPageIntervalMilliseconds,
    detached.maximumAdmissionWaitMilliseconds,
    detached.throttleBackoffInitialMilliseconds,
    detached.throttleBackoffMaximumMilliseconds,
  ]) {
    if (!Number.isSafeInteger(scalar) || scalar < 1) {
      return failStandaloneStageCommitConstruction()
    }
  }
  if (
    detached.maximumAttemptsPerLifecycle <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS ||
    detached.checkpointPageAttemptCapacity <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS ||
    detached.checkpointPageAttemptCapacity >
      detached.maximumAttemptsPerLifecycle ||
    detached.maximumAttemptsPerLifecycle -
        detached.checkpointPageAttemptCapacity <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS ||
    detached.checkpointPageAttemptCapacity >
      detached.maximumAttemptsPerWindow ||
    detached.throttleBackoffInitialMilliseconds >
      detached.throttleBackoffMaximumMilliseconds
  ) return failStandaloneStageCommitConstruction()
  return detached
}

/**
 * Authenticates and detaches the shared non-production identity preflight.
 *
 * @param input - Permit, key, clock, and optional fault construction.
 * @param resources - Validated exact requested resources.
 * @returns Authenticated permit, trusted clock, and optional fault controller.
 */
function detachNonProductionRehearsalGuard(
  input: NonProductionRehearsalGuardConstructionInput,
  resources: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): NonProductionRehearsalConstructionGuard {
  let permit: unknown
  let permitVerificationKey: unknown
  let permitClock: (() => Date) | undefined
  let fault:
    CreateWorkspaceSearchMigrationRehearsalFaultControllerInput | undefined
  try {
    permit = input.permit
    permitVerificationKey = input.permitVerificationKey
    permitClock = input.permitClock
    fault = input.fault
  } catch {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  const clock = permitClock ??
    createWorkspaceSearchMigrationPrePlanAuthoritySystemTime
  if (typeof clock !== 'function' || nodeUtilTypes.isProxy(clock)) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  const currentTime = readNonProductionRehearsalClock(clock)
  const authenticatedPermit =
    verifyWorkspaceSearchMigrationRehearsalPermit({
      permit,
      verificationKey: requireRehearsalVerificationKey(
        permitVerificationKey,
      ),
      account: resources.account,
      region: resources.region,
      commit: resources.commit,
      requestedResourcesBinding:
        createWorkspaceSearchMigrationRequestedResourcesBinding(resources),
      currentTime,
    })
  const permitDigest = createAuthenticatedRehearsalPermitDigest(
    permit,
    authenticatedPermit,
  )
  const faultController = fault === undefined
    ? undefined
    : createWorkspaceSearchMigrationRehearsalFaultController(fault)
  return Object.freeze({
    permit: authenticatedPermit,
    permitDigest,
    clock,
    ...(faultController === undefined ? {} : { faultController }),
  })
}

/**
 * Reconstructs the complete authenticated permit from detached claims and MAC.
 *
 * @param value - Exact permit record already accepted by the verifier.
 * @param claims - Detached authenticated claims returned by the verifier.
 * @returns Digest of the complete permit including its authenticated MAC.
 */
function createAuthenticatedRehearsalPermitDigest(
  value: unknown,
  claims: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'permitMac')
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    !isHexDigest(descriptor.value)
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  return createMigrationDigest({
    ...claims,
    permitMac: descriptor.value,
  })
}

/**
 * Authenticates and detaches the rehearsal-only construction guard before STS.
 *
 * @param input - Candidate dedicated rehearsal construction.
 * @param resources - Already validated exact resource selection.
 * @param ratePolicy - Detached reviewed DescribeTable rate policy.
 * @returns Authenticated guard and optional preauthenticated stage claim.
 */
function detachNonProductionRehearsalConstructionGuard(
  input:
    CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
  resources: WorkspaceSearchMigrationRequestedResourcesSnapshot,
  ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy,
): NonProductionRehearsalConstructionPreflight {
  let stageReservationClaimInput:
    PrepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaimInput |
    undefined
  try {
    stageReservationClaimInput = input.stageReservationClaim
  } catch {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  const guard = detachNonProductionRehearsalGuard(input, resources)
  const stageReservationClaim = stageReservationClaimInput === undefined
    ? undefined
    : prepareWorkspaceSearchMigrationRehearsalStageReservationAwsClaim(
        stageReservationClaimInput,
      )
  if (stageReservationClaim !== undefined) {
    try {
      requireStageReservationMaterialMatchesRehearsalConstruction(
        stageReservationClaim,
        guard,
        createWorkspaceSearchMigrationRequestedResourcesBinding(resources),
        ratePolicy.policyVersion,
      )
    } catch (error: unknown) {
      stageReservationClaim.destroy()
      throw error
    }
  }
  return Object.freeze({
    guard,
    ...(stageReservationClaim === undefined
      ? {}
      : { stageReservationClaim }),
  })
}

/**
 * Binds one preauthenticated stage claim to this permit and rate policy.
 *
 * @param material - Detached one-shot claim or commit and its bindings.
 * @param guard - Authenticated permit and trusted clock.
 * @param requestedResourcesBinding - Exact permit-authorized resources.
 * @param policyVersion - Exact reviewed DescribeTable policy digest.
 */
function requireStageReservationMaterialMatchesRehearsalConstruction(
  material:
    | PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsClaim
    | PreparedWorkspaceSearchMigrationRehearsalStageReservationAwsCommit,
  guard: NonProductionRehearsalConstructionGuard,
  requestedResourcesBinding: string,
  policyVersion: string,
): void {
  const binding = material.binding
  if (
    binding.permitDigest !== guard.permitDigest ||
    binding.commit !== guard.permit.commit ||
    binding.requestedResourcesBinding !== requestedResourcesBinding ||
    binding.policyVersion !== policyVersion ||
    binding.stageKeyDigest !== guard.permit.evidenceKeyDigest ||
    binding.publicationKeyDigest !== guard.permit.publicationKeyDigest ||
    Date.parse(binding.reservedAt) < Date.parse(guard.permit.issuedAt) ||
    Date.parse(binding.expiresAt) > Date.parse(guard.permit.expiresAt) ||
    Date.parse(binding.expiresAt) +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS >
      Date.parse(guard.permit.expiresAt) ||
    ('permitExpiresAt' in binding &&
      (binding.permitExpiresAt !== guard.permit.expiresAt ||
        Date.parse(binding.preparedAt) >=
          Date.parse(binding.recoveryDeadlineAt)))
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
}

/** Requires one non-proxy exact-length permit key before authentication. */
function requireRehearsalVerificationKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    standaloneStageCommitConstructionGuards
      .readIntrinsicByteLength(value) !== 32
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  return value
}

/** Reads one detached valid Date from the captured rehearsal clock. */
function readNonProductionRehearsalClock(clock: () => Date): Date {
  let value: unknown
  let timestamp: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
    timestamp = Date.prototype.getTime.call(value)
  } catch {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  return new Date(timestamp)
}

/** Requires the STS caller to match the exact permit-authorized role session. */
function requireNonProductionRehearsalCaller(
  caller: GetCallerIdentityCommandOutput,
  guard: NonProductionRehearsalConstructionGuard,
): void {
  if (
    caller.Account !== guard.permit.account ||
    caller.Arn !== guard.permit.callerArn ||
    guard.permit.stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
}

/** Requires the authenticated permit to remain active after remote reads. */
function requireNonProductionRehearsalPermitActive(
  guard: NonProductionRehearsalConstructionGuard,
): void {
  requireNonProductionRehearsalPermitActiveAt(
    guard,
    readNonProductionRehearsalClock(guard.clock),
  )
}

/**
 * Requires the permit to contain one already sampled trusted instant.
 *
 * @param guard - Authenticated permit and trusted clock binding.
 * @param currentTime - Detached trusted instant sampled for an AWS boundary.
 */
function requireNonProductionRehearsalPermitActiveAt(
  guard: NonProductionRehearsalConstructionGuard,
  currentTime: Date,
): void {
  const currentTimestamp = Date.prototype.getTime.call(currentTime)
  if (
    currentTimestamp < Date.parse(guard.permit.issuedAt) ||
    currentTimestamp >= Date.parse(guard.permit.expiresAt)
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
}

/**
 * Samples one trusted instant for a new permit and stage-bound admission.
 *
 * @param guard - Authenticated rehearsal permit and trusted clock.
 * @param claimedHead - Optional durable stage claim restricting the session.
 */
function requireNonProductionRehearsalAdmissionActive(
  guard: NonProductionRehearsalConstructionGuard,
  claimedHead?: WorkspaceSearchMigrationRehearsalStageHead,
): void {
  const currentTime = readNonProductionRehearsalClock(guard.clock)
  requireNonProductionRehearsalPermitActiveAt(guard, currentTime)
  if (claimedHead === undefined) return
  requireClaimedRehearsalStageReservationActiveAt(
    claimedHead,
    currentTime,
    guard.permit.expiresAt,
  )
}

/**
 * Requires one claimed stage head to retain its active reservation capability.
 *
 * @param head - Immutable durable head claimed before rate initialization.
 * @param currentTime - Single trusted instant shared with the permit check.
 * @param permitExpiresAt - Exclusive authenticated permit expiry boundary.
 */
function requireClaimedRehearsalStageReservationActiveAt(
  head: WorkspaceSearchMigrationRehearsalStageHead,
  currentTime: Date,
  permitExpiresAt: string,
): void {
  const reservationDigest = head.activeReservationDigest
  const stageOrdinal = head.activeStageOrdinal
  const expiresAt = head.activeExpiresAt
  if (
    !isHexDigest(reservationDigest) ||
    !Number.isSafeInteger(head.completedStageOrdinal) ||
    head.completedStageOrdinal < 0 ||
    typeof stageOrdinal !== 'number' ||
    !Number.isSafeInteger(stageOrdinal) ||
    stageOrdinal < 1 ||
    stageOrdinal !== head.completedStageOrdinal + 1 ||
    !isCanonicalTimestamp(expiresAt)
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  const currentTimestamp = Date.prototype.getTime.call(currentTime)
  const reservationExpiresAt = Date.parse(expiresAt)
  if (
    currentTimestamp >= reservationExpiresAt ||
    reservationExpiresAt > Date.parse(permitExpiresAt)
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
}

/**
 * Detaches one secret-free durable stage-head projection.
 *
 * @param head - Strict head returned by the reservation adapter.
 * @returns Frozen scalar-only projection with no reservation token or key.
 */
function cloneRehearsalStageHead(
  head: WorkspaceSearchMigrationRehearsalStageHead,
): WorkspaceSearchMigrationRehearsalStageHead {
  return Object.freeze({
    manifestDigest: head.manifestDigest,
    completedStageOrdinal: head.completedStageOrdinal,
    headReceiptDigest: head.headReceiptDigest,
    activeReservationDigest: head.activeReservationDigest,
    activeStageOrdinal: head.activeStageOrdinal,
    activeExpiresAt: head.activeExpiresAt,
    abandonmentCount: head.abandonmentCount,
    abandonmentRootDigest: head.abandonmentRootDigest,
    revision: head.revision,
  })
}

/**
 * Detaches one adapter-proven durable lease observation.
 *
 * The discriminated branches preserve only adapter-derived stable identity and
 * chronology. A reused-active observation cannot acquire predecessor fields.
 *
 * @param observation - Trusted adapter observation to detach.
 * @returns Frozen scalar-only acquisition or matching-active projection.
 */
function cloneDurableLeaseObservation(
  observation: WorkspaceSearchMigrationDurableLeaseAcquisitionObservation,
): WorkspaceSearchMigrationDurableLeaseAcquisitionObservation {
  if (observation.kind === 'acquired') {
    return Object.freeze({
      kind: observation.kind,
      predecessorLeaseIdentityDigest:
        observation.predecessorLeaseIdentityDigest,
      predecessorLeaseExpiresAt:
        observation.predecessorLeaseExpiresAt,
      acquiredAt: observation.acquiredAt,
      successorLeaseIdentityDigest:
        observation.successorLeaseIdentityDigest,
      successorLeaseExpiresAt: observation.successorLeaseExpiresAt,
    })
  }
  return Object.freeze({
    kind: observation.kind,
    currentLeaseIdentityDigest:
      observation.currentLeaseIdentityDigest,
    evaluatedAt: observation.evaluatedAt,
    currentLeaseExpiresAt: observation.currentLeaseExpiresAt,
  })
}

/**
 * Detaches one writer-codec-proven authority-adoption projection.
 *
 * @param observation - Strict renewal position and immutable receipt digest.
 * @returns Frozen scalar-only projection safe for stage child material.
 */
function cloneRehearsalAuthorityAdoptionObservation(
  observation: WorkspaceSearchMigrationRehearsalExpectedAuthority,
): WorkspaceSearchMigrationRehearsalExpectedAuthority {
  if (
    !Number.isSafeInteger(
      observation.maintenanceEvidenceRenewalCount,
    ) ||
    observation.maintenanceEvidenceRenewalCount <= 0 ||
    !isHexDigest(observation.receiptDigest)
  ) return failManagedApplyOperation()
  return Object.freeze({
    maintenanceEvidenceRenewalCount:
      observation.maintenanceEvidenceRenewalCount,
    receiptDigest: observation.receiptDigest,
  })
}

/**
 * Detaches one adapter-proven cursor-free runtime fault observation.
 *
 * @param observation - Trusted selected-fault observation to detach.
 * @returns Frozen scalar-only observation with a detached safe target.
 */
function cloneRehearsalFaultObservation(
  observation: WorkspaceSearchMigrationRehearsalFaultObservation,
): WorkspaceSearchMigrationRehearsalFaultObservation {
  if (observation.kind === 'planning-page') {
    const planningTarget = observation.planningTarget.kind === 'source'
      ? Object.freeze({
          kind: observation.planningTarget.kind,
          source: observation.planningTarget.source,
          pageSequence: observation.planningTarget.pageSequence,
          cursorState: observation.planningTarget.cursorState,
        })
      : Object.freeze({
          kind: observation.planningTarget.kind,
          pageSequence: observation.planningTarget.pageSequence,
          cursorState: observation.planningTarget.cursorState,
        })
    return Object.freeze({
      observationVersion: observation.observationVersion,
      kind: observation.kind,
      failpoint: observation.failpoint,
      leaseIdentityDigest: observation.leaseIdentityDigest,
      closedWriterFenceRecordDigest:
        observation.closedWriterFenceRecordDigest,
      durableAppliedOperationCount:
        observation.durableAppliedOperationCount,
      sealedPlanOperationCount: observation.sealedPlanOperationCount,
      durableHeadPosition: observation.durableHeadPosition,
      durableHeadPageSequence: observation.durableHeadPageSequence,
      durableHeadEvidenceDigest: observation.durableHeadEvidenceDigest,
      durableHeadCheckpointDigest:
        observation.durableHeadCheckpointDigest,
      durableHeadProgressDigest: observation.durableHeadProgressDigest,
      durableHeadCursorState: observation.durableHeadCursorState,
      durableHeadCompleted: observation.durableHeadCompleted,
      planningTarget,
    })
  }
  if (observation.kind === 'apply-checkpoint') {
    return Object.freeze({
      observationVersion: observation.observationVersion,
      kind: observation.kind,
      failpoint: observation.failpoint,
      leaseIdentityDigest: observation.leaseIdentityDigest,
      closedWriterFenceRecordDigest:
        observation.closedWriterFenceRecordDigest,
      durableAppliedOperationCount:
        observation.durableAppliedOperationCount,
      sealedPlanOperationCount: observation.sealedPlanOperationCount,
      checkpointLocation: observation.checkpointLocation,
      durableStatePosition: observation.durableStatePosition,
      durableStateRevision: observation.durableStateRevision,
      durableStateStatus: observation.durableStateStatus,
      durableRunStateDigest: observation.durableRunStateDigest,
      durableCheckpointDigest: observation.durableCheckpointDigest,
      durableCheckpointPageSequence:
        observation.durableCheckpointPageSequence,
      durableCheckpointCursorState:
        observation.durableCheckpointCursorState,
      durableCheckpointCompleted: observation.durableCheckpointCompleted,
    })
  }
  if (observation.kind === 'apply-operation') {
    return Object.freeze({
      observationVersion: observation.observationVersion,
      kind: observation.kind,
      failpoint: observation.failpoint,
      leaseIdentityDigest: observation.leaseIdentityDigest,
      closedWriterFenceRecordDigest:
        observation.closedWriterFenceRecordDigest,
      durableAppliedOperationCount:
        observation.durableAppliedOperationCount,
      sealedPlanOperationCount: observation.sealedPlanOperationCount,
      returnedStateRevision: observation.returnedStateRevision,
      returnedRunStateDigest: observation.returnedRunStateDigest,
      returnedAppliedOperationCount:
        observation.returnedAppliedOperationCount,
      returnedSealedPlanOperationCount:
        observation.returnedSealedPlanOperationCount,
      durableStateRevision: observation.durableStateRevision,
      durableStateStatus: observation.durableStateStatus,
      durableRunStateDigest: observation.durableRunStateDigest,
    })
  }
  return Object.freeze({
    observationVersion: observation.observationVersion,
    kind: observation.kind,
    failpoint: observation.failpoint,
    leaseIdentityDigest: observation.leaseIdentityDigest,
    closedWriterFenceRecordDigest:
      observation.closedWriterFenceRecordDigest,
    durableAppliedOperationCount: observation.durableAppliedOperationCount,
    sealedPlanOperationCount: observation.sealedPlanOperationCount,
  })
}

/**
 * Derives the only external evidence attestations accepted by this session.
 *
 * Raw account, role, and resource selections remain inside domain-separated
 * canonical digests. The resource statement includes the exact journal tags
 * already verified during preflight, while the isolation statement records
 * the mandatory account separation enforced by the permit.
 *
 * @param guard - Authenticated permit and trusted non-production clock.
 * @param commit - Reviewed commit fixed by the requested resource snapshot.
 * @param requestedResourcesBinding - Digest of the exact selected resources.
 * @param configurationHash - Measured six-table configuration digest.
 * @returns Frozen session binding required by the immutable publisher.
 */
function createNonProductionRehearsalEvidenceSessionBinding(
  guard: NonProductionRehearsalConstructionGuard,
  commit: string,
  requestedResourcesBinding: string,
  configurationHash: string,
): CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput[
  'sessionBinding'
] {
  const permit = guard.permit
  if (
    permit.account === permit.productionAccount ||
    permit.commit !== commit ||
    permit.requestedResourcesBinding !== requestedResourcesBinding
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  return Object.freeze({
    commit,
    configurationHash,
    evidenceKeyDigest: permit.evidenceKeyDigest,
    publicationKeyDigest: permit.publicationKeyDigest,
    attestation: Object.freeze({
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      permitDigest: guard.permitDigest,
      callerAttestationDigest: createMigrationDigest({
        account: permit.account,
        callerArn: permit.callerArn,
        stage: permit.stage,
      }),
      resourceAttestationDigest:
        createWorkspaceSearchMigrationRehearsalResourceAttestationDigest({
          configurationHash,
          deploymentTrustRootDigest:
            permit.deploymentTrustRootDigest,
          productionAccount: permit.productionAccount,
          requestedResourcesBinding,
        }),
      productionIsolationDigest: createMigrationDigest({
        accountsSeparated: true,
        productionAccount: permit.productionAccount,
        rehearsalAccount: permit.account,
        stage: permit.stage,
      }),
    }),
  })
}

/** Requires the journal's non-production and production-account bindings. */
function requireNonProductionRehearsalJournalTags(
  output: GetBucketTaggingOutput,
  guard: NonProductionRehearsalConstructionGuard,
): void {
  const tags = output.TagSet
  if (!Array.isArray(tags)) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
  let environmentTagCount = 0
  let deploymentTrustRootTagCount = 0
  let productionAccountDigestTagCount = 0
  for (const tag of tags) {
    if (tag.Key === WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY) {
      environmentTagCount += 1
      if (tag.Value !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE) {
        throw new WorkspaceSearchMigrationRehearsalPermitError()
      }
      continue
    }
    if (
      tag.Key ===
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY
    ) {
      deploymentTrustRootTagCount += 1
      if (tag.Value !== guard.permit.deploymentTrustRootDigest) {
        throw new WorkspaceSearchMigrationRehearsalPermitError()
      }
      continue
    }
    if (
      tag.Key ===
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY
    ) {
      productionAccountDigestTagCount += 1
      if (
        tag.Value !==
          createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
            guard.permit.productionAccount,
          )
      ) {
        throw new WorkspaceSearchMigrationRehearsalPermitError()
      }
    }
  }
  if (
    environmentTagCount !== 1 ||
    deploymentTrustRootTagCount !== 1 ||
    productionAccountDigestTagCount !== 1
  ) {
    throw new WorkspaceSearchMigrationRehearsalPermitError()
  }
}

/**
 * Consumes an exact native Promise returned across a synchronous telemetry port.
 * Opaque objects, Proxies, and thenables are never inspected or assimilated.
 *
 * @param value - Runtime return from the captured telemetry recorder.
 * @returns Whether the value was an exact native Promise.
 */
function consumeIdentityTelemetryNativePromise(value: unknown): boolean {
  if (
    !nodeUtilTypes.isPromise(value) ||
    Object.getPrototypeOf(value) !== Promise.prototype ||
    Object.hasOwn(value, 'constructor')
  ) {
    return false
  }
  void Reflect.apply(Promise.prototype.then, value, [
    undefined,
    () => undefined,
  ])
  return true
}

/** Stops composition before another durable rate mutation may start. */
function requireRateManagedSessionSignalActive(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) {
    throw new WorkspaceSearchMigrationManagedDescribeTableRateError()
  }
}

/**
 * Builds one immutable official-endpoint configuration set.
 *
 * @param resources - Validated requested resource snapshot.
 * @param credentials - Pinned shared-profile credential provider.
 * @returns Exact four-service SDK configuration.
 */
function createIdentityAwsSdkConfigurations(
  resources: WorkspaceSearchMigrationRequestedResourcesSnapshot,
  credentials: ReturnType<typeof fromIni>,
): WorkspaceSearchMigrationIdentityAwsSdkConfigurations {
  /** Builds one official-endpoint service configuration. */
  const createConfiguration = (
    service: WorkspaceSearchMigrationIdentityAwsService,
  ): WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration => ({
    credentials,
    endpoint: resolveOfficialAwsRegionalEndpoint(service, resources.region),
    profile: resources.profile,
    region: resources.region,
  })
  return {
    dynamodb: createConfiguration('dynamodb'),
    kms: createConfiguration('kms'),
    s3: {
      ...createConfiguration('s3'),
      followRegionRedirects: false,
    },
    sts: createConfiguration('sts'),
  }
}

/**
 * Detaches credentials only after STS proved their requested account.
 *
 * @param credentials - Exact resolved shared-profile identity.
 * @param accountId - STS-verified requested account.
 * @returns Static credentials accepted by the one-attempt transport.
 */
function createPinnedDescribeTableCredentials(
  credentials: WorkspaceSearchMigrationProfileCredentials,
  accountId: string,
): WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials {
  const expiration = credentials.expiration
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    accountId,
    ...(credentials.sessionToken === undefined
      ? {}
      : { sessionToken: credentials.sessionToken }),
    ...(credentials.credentialScope === undefined
      ? {}
      : { credentialScope: credentials.credentialScope }),
    ...(expiration === undefined
      ? {}
      : {
          expiration: new Date(Date.prototype.getTime.call(expiration)),
        }),
  }
}

/**
 * Preserves the pinned profile's refresh path for the dedicated DescribeTable
 * client while declaring every detached result for the measured account.
 *
 * @param credentialsProvider - Refresh-capable fixed-profile provider.
 * @param accountId - STS-verified requested account.
 * @returns Account-declaring provider for the one-attempt transport.
 */
function createPinnedDescribeTableCredentialsProvider(
  credentialsProvider: ReturnType<typeof fromIni>,
  accountId: string,
): WorkspaceSearchMigrationDescribeTablePinnedAwsCredentialsProvider {
  /** Resolves and detaches one refreshed credential value for this account. */
  const provider:
    WorkspaceSearchMigrationDescribeTablePinnedAwsCredentialsProvider =
      async () => createPinnedDescribeTableCredentials(
        await credentialsProvider(),
        accountId,
      )
  return Object.freeze(provider)
}

/**
 * Requires the same assumed-role identity constraints as full measurement.
 *
 * @param output - Untrusted STS GetCallerIdentity response.
 * @param expectedAccount - Exact requested twelve-digit account.
 */
function requirePreMeasurementCallerIdentity(
  output: GetCallerIdentityCommandOutput,
  expectedAccount: string,
): void {
  const account = output.Account
  const arn = output.Arn
  const userId = output.UserId
  if (
    account !== expectedAccount ||
    typeof arn !== 'string' ||
    typeof userId !== 'string'
  ) {
    throw preMeasurementCallerIdentityFailure()
  }
  const arnParts = arn.split(':')
  const resource = arnParts[5]
  if (
    arnParts.length !== 6 ||
    arnParts[0] !== 'arn' ||
    !/^aws(?:-[a-z0-9-]+)?$/u.test(arnParts[1] ?? '') ||
    arnParts[2] !== 'sts' ||
    arnParts[3] !== '' ||
    arnParts[4] !== expectedAccount ||
    typeof resource !== 'string'
  ) {
    throw preMeasurementCallerIdentityFailure()
  }
  const resourceParts = resource.split('/')
  const roleName = resourceParts[1]
  const sessionName = resourceParts[2]
  const userIdParts = userId.split(':')
  if (
    resourceParts.length !== 3 ||
    resourceParts[0] !== 'assumed-role' ||
    typeof roleName !== 'string' ||
    !/^[A-Za-z0-9+=,.@_-]{1,64}$/u.test(roleName) ||
    !isRoleSessionName(sessionName) ||
    userIdParts.length !== 2 ||
    !/^AROA[A-Z0-9]{17}$/u.test(userIdParts[0] ?? '') ||
    userIdParts[1] !== sessionName
  ) {
    throw preMeasurementCallerIdentityFailure()
  }
}

/** Returns one stable raw-value-free pre-measurement identity failure. */
function preMeasurementCallerIdentityFailure(): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    'IDENTITY_MISMATCH',
    'Workspace Search migration caller identity could not be verified.',
  )
}

/**
 * Reads the process system clock for one pre-plan authority evaluation.
 *
 * @returns Current wall-clock time as a detached Date.
 */
function createWorkspaceSearchMigrationPrePlanAuthoritySystemTime(): Date {
  return new Date()
}

/**
 * Creates a named-profile provider whose nested STS operations cannot honor
 * endpoint override environment variables.
 *
 * @param requested - Validated immutable resource selection.
 * @param signal - Optional complete-lifecycle cancellation for nested STS.
 * @returns Lazy shared-profile credentials provider.
 */
function createPinnedProfileCredentials(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
  signal?: AbortSignal,
): ReturnType<typeof fromIni> {
  const configuration: WorkspaceSearchMigrationRoleAssumptionConfiguration = {
    endpoint: resolveOfficialAwsRegionalEndpoint('sts', requested.region),
    profile: requested.profile,
    region: requested.region,
  }
  const roleAssumer = createPinnedRoleAssumer(configuration, signal)
  let cachedCredentials: WorkspaceSearchMigrationProfileCredentials | undefined
  let credentialPlan:
    Promise<WorkspaceSearchMigrationCredentialPlan> | undefined
  let pendingRefresh:
    Promise<WorkspaceSearchMigrationProfileCredentials> | undefined
  return async () => {
    if (
      cachedCredentials &&
      hasUsableProfileCredentialLifetime(cachedCredentials)
    ) {
      return detachProfileCredentials(cachedCredentials)
    }
    credentialPlan ??= loadPinnedCredentialPlan(requested.profile).catch(
      (error: unknown) => {
        credentialPlan = undefined
        throw error
      },
    )
    const refresh = pendingRefresh ??= credentialPlan.then((plan) =>
      resolvePinnedProfileCredentials(
        plan,
        roleAssumer,
      ),
    )
    try {
      const resolved = await refresh
      cachedCredentials = Object.freeze(resolved)
      return detachProfileCredentials(cachedCredentials)
    } catch (error: unknown) {
      if (pendingRefresh === refresh) {
        cachedCredentials = undefined
      }
      if (isWorkspaceSearchMigrationIdentityAdapterFailure(error)) {
        throw error
      }
      throw invalidProfileCredentials()
    } finally {
      if (pendingRefresh === refresh) {
        pendingRefresh = undefined
      }
    }
  }
}

/**
 * Loads only the selected validated source chain into an immutable credential
 * plan used by every refresh in an invocation.
 *
 * @param profileName - Explicit selected profile name.
 * @returns Null-prototype plan that retains no unrelated profile secret.
 */
async function loadPinnedCredentialPlan(
  profileName: string,
): Promise<WorkspaceSearchMigrationCredentialPlan> {
  const profiles =
    await loadWorkspaceSearchMigrationSharedProfiles(profileName)
  return createPinnedCredentialPlan(
    profileName,
    profiles,
    new Set(),
  )
}

/**
 * Resolves only static credentials or an explicit source-profile assume-role
 * chain from the invocation's immutable selected-chain plan.
 *
 * @param plan - Immutable selected source-profile chain.
 * @param roleAssumer - Pinned assume-role callback.
 * @returns Complete credentials shared by every service client.
 */
async function resolvePinnedProfileCredentials(
  plan: WorkspaceSearchMigrationCredentialPlan,
  roleAssumer: WorkspaceSearchMigrationProfileRoleAssumer,
): Promise<WorkspaceSearchMigrationProfileCredentials> {
  if (plan.kind === 'static') {
    return {
      accessKeyId: plan.accessKeyId,
      secretAccessKey: plan.secretAccessKey,
      sessionToken: plan.sessionToken,
    }
  }
  const sourceCredentials = await resolvePinnedProfileCredentials(
    plan.source,
    roleAssumer,
  )
  return roleAssumer(sourceCredentials, {
    RoleArn: plan.roleArn,
    RoleSessionName: plan.roleSessionName,
    ExternalId: plan.externalId,
    DurationSeconds: plan.durationSeconds,
  })
}

/**
 * Recursively builds one exact selected-chain credential plan.
 *
 * @param profileName - Current profile in the explicit source chain.
 * @param profiles - Temporary full shared-file parse.
 * @param visitedProfiles - Profiles already visited in this chain.
 * @returns Frozen null-prototype static or AssumeRole plan.
 */
function createPinnedCredentialPlan(
  profileName: string,
  profiles: WorkspaceSearchMigrationSharedProfiles,
  visitedProfiles: ReadonlySet<string>,
): WorkspaceSearchMigrationCredentialPlan {
  if (
    !isSafeProfileName(profileName) ||
    visitedProfiles.has(profileName) ||
    visitedProfiles.size >= MAXIMUM_PROFILE_ROLE_CHAIN_DEPTH
  ) {
    throw invalidProfileCredentials()
  }
  const profile = readOwnProfile(profiles, profileName)
  if (hasUnsupportedProfileMechanism(profile)) {
    throw invalidProfileCredentials()
  }
  if (
    hasOwnProfileField(profile, 'role_arn') ||
    hasOwnProfileField(profile, 'source_profile')
  ) {
    return createPinnedAssumeRoleCredentialPlan(
      profile,
      profiles,
      new Set([...visitedProfiles, profileName]),
    )
  }
  return createPinnedStaticCredentialPlan(profile)
}

/**
 * Builds one immutable AssumeRole hop from exact own profile fields.
 *
 * @param profile - Parsed assume-role profile.
 * @param profiles - Temporary full shared-file parse.
 * @param visitedProfiles - Profiles already visited in this chain.
 * @returns Frozen null-prototype AssumeRole plan.
 */
function createPinnedAssumeRoleCredentialPlan(
  profile: object,
  profiles: WorkspaceSearchMigrationSharedProfiles,
  visitedProfiles: ReadonlySet<string>,
): WorkspaceSearchMigrationAssumeRoleCredentialPlan {
  const roleArn = readOwnProfileField(profile, 'role_arn')
  const sourceProfile = readOwnProfileField(profile, 'source_profile')
  const sessionName = readOwnProfileField(profile, 'role_session_name')
  const externalId = readOwnProfileField(profile, 'external_id')
  if (
    !isIamRoleArn(roleArn) ||
    !isSafeProfileName(sourceProfile) ||
    !isRoleSessionName(sessionName) ||
    (externalId !== undefined && !isNonEmptyString(externalId)) ||
    hasOwnProfileField(profile, 'aws_access_key_id') ||
    hasOwnProfileField(profile, 'aws_secret_access_key') ||
    hasOwnProfileField(profile, 'aws_session_token')
  ) {
    throw invalidProfileCredentials()
  }
  const source = createPinnedCredentialPlan(
    sourceProfile,
    profiles,
    visitedProfiles,
  )
  const plan: WorkspaceSearchMigrationAssumeRoleCredentialPlan = {
    kind: 'assume-role',
    roleArn,
    roleSessionName: sessionName,
    externalId,
    durationSeconds: readRoleDurationSeconds(
      readOwnProfileField(profile, 'duration_seconds'),
    ),
    source,
  }
  Object.setPrototypeOf(plan, null)
  return Object.freeze(plan)
}

/**
 * Builds one immutable static-credential leaf from exact own profile fields.
 *
 * @param profile - Parsed shared-profile section.
 * @returns Frozen null-prototype static credential plan.
 */
function createPinnedStaticCredentialPlan(
  profile: object,
): WorkspaceSearchMigrationStaticCredentialPlan {
  const accessKeyId = readOwnProfileField(profile, 'aws_access_key_id')
  const secretAccessKey = readOwnProfileField(
    profile,
    'aws_secret_access_key',
  )
  const sessionToken = readOwnProfileField(profile, 'aws_session_token')
  if (
    !isNonEmptyString(accessKeyId) ||
    !isNonEmptyString(secretAccessKey) ||
    (sessionToken !== undefined && !isNonEmptyString(sessionToken))
  ) {
    throw invalidProfileCredentials()
  }
  const plan: WorkspaceSearchMigrationStaticCredentialPlan = {
    kind: 'static',
    accessKeyId,
    secretAccessKey,
    sessionToken,
  }
  Object.setPrototypeOf(plan, null)
  return Object.freeze(plan)
}

/**
 * Reads one profile through an exact own data property on the parsed map.
 *
 * @param profiles - Temporary parsed shared-profile map.
 * @param profileName - Exact selected or source profile name.
 * @returns Object-valued own data property for the profile.
 */
function readOwnProfile(
  profiles: WorkspaceSearchMigrationSharedProfiles,
  profileName: string,
): object {
  if (!Object.hasOwn(profiles, profileName)) {
    throw invalidProfileCredentials()
  }
  const descriptor = Object.getOwnPropertyDescriptor(profiles, profileName)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw invalidProfileCredentials()
  }
  const value: unknown = descriptor.value
  if (typeof value !== 'object' || value === null) {
    throw invalidProfileCredentials()
  }
  return value
}

/**
 * Checks one exact own field without consulting a profile prototype.
 *
 * @param profile - Parsed profile object.
 * @param key - Exact shared-profile field name.
 * @returns Whether the profile defines the field itself.
 */
function hasOwnProfileField(profile: object, key: string): boolean {
  return Object.hasOwn(profile, key)
}

/**
 * Reads one exact own data property without consulting a profile prototype.
 *
 * @param profile - Parsed profile object.
 * @param key - Exact shared-profile field name.
 * @returns Own field value, or undefined when absent.
 */
function readOwnProfileField(profile: object, key: string): unknown {
  if (!hasOwnProfileField(profile, key)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(profile, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw invalidProfileCredentials()
  }
  return descriptor.value
}

/**
 * Rejects shared-profile mechanisms that add unmanaged clients, shell
 * execution, ambient credentials, or arbitrary metadata endpoints.
 *
 * @param profile - Parsed shared-profile section.
 * @returns Whether the profile uses an unsupported mechanism.
 */
function hasUnsupportedProfileMechanism(
  profile: object,
): boolean {
  return unsupportedWorkspaceSearchMigrationProfileKeys.some(
    (key) => hasOwnProfileField(profile, key),
  )
}

/**
 * Parses a strict STS role duration.
 *
 * @param value - Optional duration text from the shared profile.
 * @returns Duration in seconds, defaulting to one hour.
 */
function readRoleDurationSeconds(value: unknown): number {
  if (value === undefined) return 3_600
  if (typeof value !== 'string' || !/^[0-9]{3,5}$/.test(value)) {
    throw invalidProfileCredentials()
  }
  const duration = Number(value)
  if (!Number.isSafeInteger(duration) || duration < 900 || duration > 43_200) {
    throw invalidProfileCredentials()
  }
  return duration
}

/**
 * Checks whether cached credentials are safe to share for another client
 * request.
 *
 * @param credentials - Cached credentials.
 * @returns Whether they are static or remain valid beyond the refresh window.
 */
function hasUsableProfileCredentialLifetime(
  credentials: WorkspaceSearchMigrationProfileCredentials,
): boolean {
  const expiration = credentials.expiration
  if (expiration === undefined) return true
  const expirationTime = Date.prototype.getTime.call(expiration)
  return Number.isFinite(expirationTime) &&
    expirationTime - Date.now() >
    PROFILE_CREDENTIAL_REFRESH_WINDOW_MILLISECONDS
}

/**
 * Returns a detached credential object so SDK wrappers cannot mutate the
 * shared cache.
 *
 * @param credentials - Cached shared credentials.
 * @returns Detached credentials with a cloned expiration.
 */
function detachProfileCredentials(
  credentials: WorkspaceSearchMigrationProfileCredentials,
): WorkspaceSearchMigrationProfileCredentials {
  const expiration = credentials.expiration
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiration: expiration === undefined
      ? undefined
      : new Date(Date.prototype.getTime.call(expiration)),
  }
}

/**
 * Creates an assume-role callback that owns and immediately releases its
 * official-endpoint STS client.
 *
 * @param configuration - Explicit profile, region, and STS endpoint.
 * @param signal - Optional complete-lifecycle cancellation for AssumeRole.
 * @returns AWS SDK shared-profile role-assumption callback.
 */
function createPinnedRoleAssumer(
  configuration: WorkspaceSearchMigrationRoleAssumptionConfiguration,
  signal?: AbortSignal,
): WorkspaceSearchMigrationProfileRoleAssumer {
  return async (sourceCredentials, parameters) => {
    const client = new STSClient({
      ...configuration,
      credentials: sourceCredentials,
    })
    try {
      const output = await client.send(
        new AssumeRoleCommand(parameters),
        signal === undefined ? {} : { abortSignal: signal },
      )
      return readAssumedCredentials(output.Credentials)
    } finally {
      client.destroy()
    }
  }
}

/**
 * Detaches complete temporary credentials from one STS response.
 *
 * @param credentials - Temporary credentials returned by STS.
 * @returns Complete credentials suitable for signing migration reads.
 */
function readAssumedCredentials(
  credentials: Credentials | undefined,
): Awaited<ReturnType<WorkspaceSearchMigrationProfileRoleAssumer>> {
  let accessKeyId: unknown
  let secretAccessKey: unknown
  let sessionToken: unknown
  let expiration: unknown
  let expirationTime: unknown
  try {
    accessKeyId = credentials?.AccessKeyId
    secretAccessKey = credentials?.SecretAccessKey
    sessionToken = credentials?.SessionToken
    expiration = credentials?.Expiration
    expirationTime = Date.prototype.getTime.call(expiration)
  } catch {
    throw invalidAssumedCredentials()
  }
  if (
    !isNonEmptyString(accessKeyId) ||
    !isNonEmptyString(secretAccessKey) ||
    !isNonEmptyString(sessionToken) ||
    typeof expirationTime !== 'number' ||
    !Number.isFinite(expirationTime)
  ) {
    throw invalidAssumedCredentials()
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiration: new Date(expirationTime),
  }
}

/**
 * Creates the concrete allowlisted AWS SDK transport.
 *
 * @param configurations - Explicit official-endpoint client configurations.
 * @returns AWS SDK transport exposing only allowlisted managed operations.
 */
function createDefaultAwsTransport(
  configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations,
): WorkspaceSearchMigrationManagedAwsTransport &
  WorkspaceSearchMigrationDescribeTableRateCheckpointAwsTransport &
  WorkspaceSearchMigrationRehearsalGuardAwsTransport {
  return new AwsSdkWorkspaceSearchMigrationIdentityTransport(configurations)
}

/**
 * Reconstructs the operator-selected resources represented by a measurement.
 *
 * @param configuration - Detached measured migration configuration.
 * @returns Exact resource selection represented by the configuration.
 */
function createRequestedResourcesFromConfiguration(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationRequestedResources {
  return {
    account: configuration.account,
    region: configuration.region,
    profile: configuration.profile,
    commit: configuration.commit,
    tables: {
      'project-directory':
        configuration.tables['project-directory'].tableName,
      'work-items': configuration.tables['work-items'].tableName,
      collaboration: configuration.tables.collaboration.tableName,
      documents: configuration.tables.documents.tableName,
      'workspace-search':
        configuration.tables['workspace-search'].tableName,
      'migration-state':
        configuration.tables['migration-state'].tableName,
    },
    journalBucket: configuration.journal.bucketName,
    journalKeyArn: configuration.journal.keyArn,
  }
}

/**
 * Creates one owner-bound S3 control-plane command input.
 *
 * @param lookup - Validated journal bucket and expected owner.
 * @returns Exact S3 bucket input.
 */
function createBucketLookupInput(
  lookup: WorkspaceSearchMigrationJournalLookup,
): {
  /** Physical journal bucket name. */
  Bucket: string
  /** Expected AWS account that owns the bucket. */
  ExpectedBucketOwner: string
} {
  return {
    Bucket: lookup.bucketName,
    ExpectedBucketOwner: lookup.expectedBucketOwner,
  }
}

/**
 * Constructs a partition-aware official AWS regional endpoint.
 *
 * @param service - Allowlisted AWS service endpoint prefix.
 * @param region - Explicit AWS region.
 * @returns Official regional endpoint URL.
 */
function resolveOfficialAwsRegionalEndpoint(
  service: WorkspaceSearchMigrationIdentityAwsService,
  region: string,
): string {
  return `https://${service}.${region}.${resolveOfficialAwsDnsSuffix(region)}/`
}

/**
 * Resolves the official DNS suffix for supported AWS partitions.
 *
 * @param region - Explicit validated AWS region.
 * @returns Official non-dualstack DNS suffix.
 */
function resolveOfficialAwsDnsSuffix(region: string): string {
  if (region.startsWith('cn-')) {
    return 'amazonaws.com.cn'
  }
  if (region.startsWith('eusc-')) {
    return 'amazonaws.eu'
  }
  if (region.startsWith('us-iso-')) {
    return 'c2s.ic.gov'
  }
  if (region.startsWith('us-isob-')) {
    return 'sc2s.sgov.gov'
  }
  if (region.startsWith('eu-isoe-')) {
    return 'cloud.adc-e.uk'
  }
  if (region.startsWith('us-isof-')) {
    return 'csp.hci.ic.gov'
  }
  return 'amazonaws.com'
}

/**
 * Creates a stable failure for an incomplete STS role-assumption response.
 *
 * @returns Secret-free identity failure.
 */
function invalidAssumedCredentials(): WorkspaceSearchMigrationFailure {
  return createWorkspaceSearchMigrationIdentityAdapterFailure(
    'INCOMPLETE_ASSUMED_CREDENTIALS',
  )
}

/**
 * Creates a stable failure for an unsupported or malformed shared profile.
 *
 * @returns Secret-free identity failure.
 */
function invalidProfileCredentials(): WorkspaceSearchMigrationFailure {
  return createWorkspaceSearchMigrationIdentityAdapterFailure(
    'INVALID_PROFILE_CREDENTIALS',
  )
}

/**
 * Runs managed source Scan I/O behind a fresh raw-error replacement boundary.
 *
 * @param operation - Authority checks and SDK work for one exact source page.
 * @returns Detached reducer input and the authority that produced its page.
 */
async function runSourceScanAwsBoundary(
  operation: () => Promise<PreparedManagedSourceScanReduction>,
): Promise<PreparedManagedSourceScanReduction> {
  try {
    return await operation()
  } catch (error: unknown) {
    const code = readSourceScanAwsFailureCode(error)
    throw createSourceScanAwsBoundaryFailure(code)
  }
}

/**
 * Runs managed target Scan I/O behind a fresh raw-error replacement boundary.
 *
 * @param operation - Authority checks and SDK work for one exact target page.
 * @returns Detached reducer input and the authority that produced its page.
 */
async function runTargetScanAwsBoundary(
  operation: () => Promise<PreparedManagedTargetScanReduction>,
): Promise<PreparedManagedTargetScanReduction> {
  try {
    return await operation()
  } catch (error: unknown) {
    const code = readTargetScanAwsFailureCode(error)
    throw createTargetScanAwsBoundaryFailure(code)
  }
}

/** Rejects target-page work after caller cancellation or session sealing. */
function requireManagedTargetScanSignalActive(signal: AbortSignal): void {
  if (signal.aborted) return failTargetScanAws('INVALID_STATE')
}

/**
 * Detaches the four-field public join input without trusting accessors.
 *
 * Descriptor inspection and structured cloning remain inside one private
 * replacement boundary so hostile proxies cannot forge migration codes.
 *
 * @param input - Caller-owned public managed planning request.
 * @returns Plain detached request safe to retain across asynchronous I/O.
 */
function detachManagedPlanningJoinInput(
  input: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput,
): JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput {
  try {
    requireExactManagedPlanningOwnDataKeys(input, [
      'configuration',
      'configurationHash',
      'limits',
      'runId',
    ])
    const limits = readManagedPlanningOwnDataProperty(input, 'limits')
    requireExactManagedPlanningOwnDataKeys(limits, [
      'maxPlanOperations',
      'maxTotalCanonicalItemBytes',
      'maxTotalRows',
    ])
    const runId = readManagedPlanningOwnDataProperty(input, 'runId')
    const configurationHash = readManagedPlanningOwnDataProperty(
      input,
      'configurationHash',
    )
    if (
      typeof runId !== 'string' ||
      typeof configurationHash !== 'string'
    ) {
      return failSourceScanAws('INVALID_ARGUMENT')
    }
    const snapshot = structuredClone(input)
    return {
      runId,
      configuration: snapshot.configuration,
      configurationHash,
      limits: {
        maxTotalRows: snapshot.limits.maxTotalRows,
        maxTotalCanonicalItemBytes:
          snapshot.limits.maxTotalCanonicalItemBytes,
        maxPlanOperations: snapshot.limits.maxPlanOperations,
      },
    }
  } catch {
    return failSourceScanAws('INVALID_ARGUMENT')
  }
}

/**
 * Detaches one planning-artifact preflight without accessors.
 *
 * @param input - Caller-owned reviewed time, deadline, and runway.
 * @returns Exact scalar preflight request.
 */
function detachManagedPlanningArtifactPreflightInput(
  input:
    ValidateWorkspaceSearchMigrationPlanningArtifactPreflightInput,
): ValidateWorkspaceSearchMigrationPlanningArtifactPreflightInput {
  try {
    requireExactManagedPlanningOwnDataKeys(input, [
      'minimumAdditionalHeadroomMilliseconds',
      'retainUntil',
      'reviewedDryRunCompletedAt',
    ])
    const retainUntil = readManagedPlanningOwnDataProperty(
      input,
      'retainUntil',
    )
    const minimumAdditionalHeadroomMilliseconds =
      readManagedPlanningOwnDataProperty(
        input,
        'minimumAdditionalHeadroomMilliseconds',
      )
    const reviewedDryRunCompletedAt =
      readManagedPlanningOwnDataProperty(
        input,
        'reviewedDryRunCompletedAt',
      )
    if (
      typeof retainUntil !== 'string' ||
      typeof reviewedDryRunCompletedAt !== 'string' ||
      !isCanonicalTimestamp(reviewedDryRunCompletedAt) ||
      typeof minimumAdditionalHeadroomMilliseconds !== 'number' ||
      !Number.isSafeInteger(minimumAdditionalHeadroomMilliseconds) ||
      minimumAdditionalHeadroomMilliseconds < 0
    ) {
      return failManagedPlanningArtifactPreflight('INVALID_ARGUMENT')
    }
    return {
      retainUntil,
      minimumAdditionalHeadroomMilliseconds,
      reviewedDryRunCompletedAt,
    }
  } catch {
    return failManagedPlanningArtifactPreflight('INVALID_ARGUMENT')
  }
}

/**
 * Reads one trusted clock instant for a measured artifact preflight.
 *
 * @param clock - Managed session clock shared with immutable artifact writes.
 * @returns Detached finite nonnegative Date.
 */
function readManagedPlanningArtifactPreflightClock(
  clock: WorkspaceSearchMigrationPrePlanAuthorityClock,
): Date {
  let currentTime: unknown
  try {
    currentTime = clock()
  } catch {
    return failManagedPlanningArtifactPreflight('INVALID_STATE')
  }
  if (
    nodeUtilTypes.isProxy(currentTime) ||
    !(currentTime instanceof Date)
  ) {
    return failManagedPlanningArtifactPreflight('INVALID_STATE')
  }
  let currentTimeEpochMilliseconds: number
  try {
    currentTimeEpochMilliseconds =
      Date.prototype.getTime.call(currentTime)
  } catch {
    return failManagedPlanningArtifactPreflight('INVALID_STATE')
  }
  if (
    !Number.isSafeInteger(currentTimeEpochMilliseconds) ||
    currentTimeEpochMilliseconds < 0
  ) {
    return failManagedPlanningArtifactPreflight('INVALID_STATE')
  }
  return new Date(currentTimeEpochMilliseconds)
}

/**
 * Detaches one opaque provenance-write input without invoking accessors.
 *
 * @param input - Caller-owned retention request.
 * @returns Exact caller-selected canonical retention timestamp.
 */
function detachPreparedPlanningProvenanceWriteInput(
  input: WriteWorkspaceSearchMigrationPreparedPlanningProvenanceInput,
): string {
  try {
    requireExactManagedPlanningOwnDataKeys(input, ['retainUntil'])
    const retainUntil = readManagedPlanningOwnDataProperty(
      input,
      'retainUntil',
    )
    if (typeof retainUntil !== 'string') {
      return failSourceScanAws('INVALID_ARGUMENT')
    }
    return retainUntil
  } catch {
    return failSourceScanAws('INVALID_ARGUMENT')
  }
}

/**
 * Requires one record to expose exactly enumerable own data properties.
 *
 * @param value - Candidate caller-owned record or proxy.
 * @param expectedKeys - Exact accepted string keys.
 */
function requireExactManagedPlanningOwnDataKeys(
  value: unknown,
  expectedKeys: readonly string[],
): void {
  if (typeof value !== 'object' || value === null) {
    return failSourceScanAws('INVALID_ARGUMENT')
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) => typeof key !== 'string' || !expectedKeys.includes(key),
    )
  ) {
    return failSourceScanAws('INVALID_ARGUMENT')
  }
  for (const key of expectedKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failSourceScanAws('INVALID_ARGUMENT')
    }
  }
}

/**
 * Reads one already validated own data descriptor without invoking a getter.
 *
 * @param owner - Caller-owned candidate record.
 * @param property - Exact own data property to read.
 * @returns Raw descriptor value for further validation.
 */
function readManagedPlanningOwnDataProperty(
  owner: object,
  property: string,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(owner, property)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failSourceScanAws('INVALID_ARGUMENT')
  }
  return descriptor.value
}

/** Exact byte length of either reconciliation evidence authentication key. */
const managedReconciliationAuthenticationKeyBytes = 32

/** Strict guards for the high-level measured reconciliation trust boundary. */
const managedReconciliationGuards =
  new WorkspaceSearchMigrationStrictRecordGuards(
    failManagedReconciliationSession,
  )

/**
 * Synchronously detaches one complete high-level reconciliation request.
 *
 * @param input - Untrusted raw files, selectors, expectations, and budgets.
 * @returns Frozen aliases-free material safe to retain across AWS awaits.
 */
function prepareManagedReconciliationSessionInput(
  input:
    CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
): PreparedManagedReconciliationSessionInput {
  let rollbackTarget:
    WorkspaceSearchMigrationRehearsalReconciliationRollbackTargetInput |
      undefined
  try {
    const record = managedReconciliationGuards.requireRecord(input)
    const hasRollbackTarget = Object.hasOwn(record, 'rollbackTarget')
    const hasSignal = Object.hasOwn(record, 'signal')
    managedReconciliationGuards.requireExactKeys(record, [
      'clock',
      'expectedAuthorities',
      'limits',
      ...(hasRollbackTarget ? ['rollbackTarget'] : []),
      'runId',
      'runLocatorDigest',
      'scenario',
      ...(hasSignal ? ['signal'] : []),
    ])
    const scenario = readManagedReconciliationScenario(
      managedReconciliationGuards.readOwn(record, 'scenario'),
    )
    const runId = managedReconciliationGuards.readIdentifier(
      managedReconciliationGuards.readOwn(record, 'runId'),
    )
    const runLocatorDigest = managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'runLocatorDigest'),
    )
    const limits = readManagedReconciliationLimits(
      managedReconciliationGuards.readOwn(record, 'limits'),
    )
    const expectedAuthorities =
      readManagedReconciliationExpectedAuthorities(
        managedReconciliationGuards.readOwn(
          record,
          'expectedAuthorities',
        ),
        limits.maximumItems,
      )
    const rollbackTargetValue = hasRollbackTarget
      ? managedReconciliationGuards.readOwn(record, 'rollbackTarget')
      : undefined
    if (isManagedReconciliationVerifiedScenario(scenario)) {
      if (hasRollbackTarget) {
        return failManagedReconciliationSession()
      }
    } else {
      if (!hasRollbackTarget || rollbackTargetValue === undefined) {
        return failManagedReconciliationSession()
      }
      rollbackTarget =
        prepareManagedReconciliationRollbackTargetInput(
          rollbackTargetValue,
          scenario,
          runLocatorDigest,
        )
    }
    const clock = captureManagedReconciliationClock(
      managedReconciliationGuards.readOwn(record, 'clock'),
    )
    const signal = hasSignal
      ? readManagedReconciliationSignal(
          managedReconciliationGuards.readOwn(record, 'signal'),
        )
      : undefined
    const prepared = Object.freeze({
      runId,
      runLocatorDigest,
      scenario,
      expectedAuthorities,
      ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
      limits,
      clock,
      ...(signal === undefined ? {} : { signal }),
    })
    return prepared
  } catch (error: unknown) {
    if (rollbackTarget !== undefined) {
      zeroizeManagedReconciliationRollbackTargetInput(rollbackTarget)
    }
    throw error
  }
}

/**
 * Reads one finite canonical reconciliation scenario.
 *
 * @param value - Candidate scenario discriminator.
 * @returns Exact supported scenario.
 */
function readManagedReconciliationScenario(
  value: unknown,
): WorkspaceSearchMigrationRehearsalScenarioName {
  switch (value) {
    case 'artifact-before-checkpoint-kill':
    case 'complete-apply-rollback':
    case 'cursor-after-commit-kill':
    case 'cursor-before-commit-kill':
    case 'happy-path-verified':
    case 'lease-expiry-takeover':
    case 'partial-apply-rollback':
    case 'transaction-response-loss':
      return value
    default:
      return failManagedReconciliationSession()
  }
}

/**
 * Classifies whether one scenario must terminate in a verified root.
 *
 * @param scenario - Canonical isolated rehearsal scenario.
 * @returns Whether the scenario uses verified-terminal integrity material.
 */
function isManagedReconciliationVerifiedScenario(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): boolean {
  return scenario !== 'complete-apply-rollback' &&
    scenario !== 'partial-apply-rollback'
}

/**
 * Reads and freezes the exact finite reconciliation budgets.
 *
 * @param value - Candidate five-scalar budget record.
 * @returns Reviewed bounded collector limits.
 */
function readManagedReconciliationLimits(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationAwsLimits {
  const record = managedReconciliationGuards.requireRecord(value)
  managedReconciliationGuards.requireExactKeys(record, [
    'maximumBytes',
    'maximumDurationMilliseconds',
    'maximumItems',
    'maximumPages',
    'requestTimeoutMilliseconds',
  ])
  const limits = Object.freeze({
    maximumPages: readManagedReconciliationPositiveInteger(
      managedReconciliationGuards.readOwn(record, 'maximumPages'),
    ),
    maximumItems: readManagedReconciliationPositiveInteger(
      managedReconciliationGuards.readOwn(record, 'maximumItems'),
    ),
    maximumBytes: readManagedReconciliationPositiveInteger(
      managedReconciliationGuards.readOwn(record, 'maximumBytes'),
    ),
    requestTimeoutMilliseconds:
      readManagedReconciliationPositiveInteger(
        managedReconciliationGuards.readOwn(
          record,
          'requestTimeoutMilliseconds',
        ),
      ),
    maximumDurationMilliseconds:
      readManagedReconciliationPositiveInteger(
        managedReconciliationGuards.readOwn(
          record,
          'maximumDurationMilliseconds',
        ),
      ),
  })
  if (
    limits.maximumPages >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_PAGES ||
    limits.maximumItems >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_ITEMS ||
    limits.maximumBytes >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_BYTES ||
    limits.requestTimeoutMilliseconds >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_REQUEST_TIMEOUT_MILLISECONDS ||
    limits.maximumDurationMilliseconds >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS
  ) return failManagedReconciliationSession()
  return limits
}

/**
 * Reads a positive safe integer at the synchronous trust boundary.
 *
 * @param value - Candidate finite counter or budget.
 * @returns Exact positive safe integer.
 */
function readManagedReconciliationPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failManagedReconciliationSession()
  return value
}

/**
 * Detaches the complete ordered authority-adoption expectation.
 *
 * @param value - Candidate authenticated stage projection array.
 * @param maximumItems - Reviewed maximum combined collector item budget.
 * @returns Frozen nonempty sequential authority chain.
 */
function readManagedReconciliationExpectedAuthorities(
  value: unknown,
  maximumItems: number,
): readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length === 0 ||
    value.length > maximumItems
  ) return failManagedReconciliationSession()
  const keys = Object.keys(value)
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index))
  ) return failManagedReconciliationSession()
  const authorities: WorkspaceSearchMigrationRehearsalExpectedAuthority[] = []
  const digests = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) return failManagedReconciliationSession()
    const record = managedReconciliationGuards.requireRecord(
      descriptor.value,
    )
    managedReconciliationGuards.requireExactKeys(record, [
      'maintenanceEvidenceRenewalCount',
      'receiptDigest',
    ])
    const maintenanceEvidenceRenewalCount =
      readManagedReconciliationPositiveInteger(
        managedReconciliationGuards.readOwn(
          record,
          'maintenanceEvidenceRenewalCount',
        ),
      )
    const receiptDigest = managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'receiptDigest'),
    )
    if (
      maintenanceEvidenceRenewalCount !== index + 1 ||
      digests.has(receiptDigest)
    ) return failManagedReconciliationSession()
    digests.add(receiptDigest)
    authorities.push(Object.freeze({
      maintenanceEvidenceRenewalCount,
      receiptDigest,
    }))
  }
  return Object.freeze(authorities)
}

/**
 * Captures a non-proxy trusted Date clock without accepting a thenable.
 *
 * @param value - Candidate direct clock function.
 * @returns Wrapper producing detached valid native Dates.
 */
function captureManagedReconciliationClock(value: unknown): () => Date {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failManagedReconciliationSession()
  }
  return (): Date => {
    let clockValue: unknown
    let milliseconds: unknown
    try {
      clockValue = Reflect.apply(value, undefined, [])
      if (
        !(clockValue instanceof Date) ||
        nodeUtilTypes.isProxy(clockValue)
      ) return failManagedReconciliationSession()
      milliseconds = Reflect.apply(
        Date.prototype.getTime,
        clockValue,
        [],
      )
    } catch {
      return failManagedReconciliationSession()
    }
    if (
      typeof milliseconds !== 'number' ||
      !Number.isFinite(milliseconds)
    ) return failManagedReconciliationSession()
    return new Date(milliseconds)
  }
}

/**
 * Reads one optional exact native caller cancellation signal.
 *
 * @param value - Candidate signal or explicit undefined.
 * @returns Native non-proxy signal or undefined.
 */
function readManagedReconciliationSignal(
  value: unknown,
): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof AbortSignal) || nodeUtilTypes.isProxy(value)) {
    return failManagedReconciliationSession()
  }
  return value
}

/**
 * Detaches both target-audit files and consumes their caller-owned keys.
 *
 * @param value - Candidate preimage/restored target observation pair.
 * @param scenario - Exact rollback scenario selected by the outer request.
 * @param runLocatorDigest - Exact outer restricted-run locator.
 * @returns Frozen aliases-free target authentication input.
 */
function prepareManagedReconciliationRollbackTargetInput(
  value: unknown,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  runLocatorDigest: string,
): WorkspaceSearchMigrationRehearsalReconciliationRollbackTargetInput {
  const record = managedReconciliationGuards.requireRecord(value)
  managedReconciliationGuards.requireExactKeys(record, [
    'applyStartedAt',
    'context',
    'preimageAuditBytes',
    'publicationVerificationKey',
    'restoredAuditBytes',
    'runtimeVerificationKey',
  ])
  const originalRuntimeKey = managedReconciliationGuards.readOwn(
    record,
    'runtimeVerificationKey',
  )
  const originalPublicationKey = managedReconciliationGuards.readOwn(
    record,
    'publicationVerificationKey',
  )
  let preimageAuditBytes: Uint8Array | undefined
  let restoredAuditBytes: Uint8Array | undefined
  let runtimeVerificationKey: Uint8Array | undefined
  let publicationVerificationKey: Uint8Array | undefined
  try {
    preimageAuditBytes = copyManagedReconciliationBytes(
      managedReconciliationGuards.readOwn(record, 'preimageAuditBytes'),
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
    )
    restoredAuditBytes = copyManagedReconciliationBytes(
      managedReconciliationGuards.readOwn(record, 'restoredAuditBytes'),
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
    )
    const context = readManagedReconciliationTargetContext(
      managedReconciliationGuards.readOwn(record, 'context'),
      scenario,
      runLocatorDigest,
    )
    const applyStartedAt = managedReconciliationGuards.readTimestamp(
      managedReconciliationGuards.readOwn(record, 'applyStartedAt'),
    )
    runtimeVerificationKey =
      copyManagedReconciliationKey(originalRuntimeKey)
    publicationVerificationKey =
      copyManagedReconciliationKey(originalPublicationKey)
    return Object.freeze({
      preimageAuditBytes,
      restoredAuditBytes,
      context,
      applyStartedAt,
      runtimeVerificationKey,
      publicationVerificationKey,
    })
  } catch (error: unknown) {
    zeroizeManagedReconciliationBytes(preimageAuditBytes)
    zeroizeManagedReconciliationBytes(restoredAuditBytes)
    zeroizeManagedReconciliationBytes(runtimeVerificationKey)
    zeroizeManagedReconciliationBytes(publicationVerificationKey)
    throw error
  } finally {
    zeroizeManagedReconciliationBytes(originalRuntimeKey)
    zeroizeManagedReconciliationBytes(originalPublicationKey)
  }
}

/**
 * Detaches the exact parent-authenticated rollback target context.
 *
 * @param value - Candidate strict context record.
 * @param scenario - Exact outer rollback scenario.
 * @param runLocatorDigest - Exact outer restricted-run locator.
 * @returns Frozen digest-only target-audit context.
 */
function readManagedReconciliationTargetContext(
  value: unknown,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  runLocatorDigest: string,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  const record = managedReconciliationGuards.requireRecord(value)
  managedReconciliationGuards.requireExactKeys(record, [
    'configurationBindingDigest',
    'executionBoundaryDigest',
    'integrityResourceIdentityDigest',
    'manifestDigest',
    'permitDigest',
    'planDigest',
    'planningReceiptDigest',
    'policyVersion',
    'requestedResourcesBinding',
    'runLocatorDigest',
    'scenario',
    'sealedPlanningAuthorityDigest',
    'writerFenceDigest',
  ])
  const contextScenario = managedReconciliationGuards.readOwn(
    record,
    'scenario',
  )
  const contextRunLocatorDigest = managedReconciliationGuards.readDigest(
    managedReconciliationGuards.readOwn(record, 'runLocatorDigest'),
  )
  if (
    (scenario !== 'complete-apply-rollback' &&
      scenario !== 'partial-apply-rollback') ||
    contextScenario !== scenario ||
    contextRunLocatorDigest !== runLocatorDigest
  ) return failManagedReconciliationSession()
  return Object.freeze({
    scenario,
    runLocatorDigest: contextRunLocatorDigest,
    manifestDigest: managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'manifestDigest'),
    ),
    permitDigest: managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'permitDigest'),
    ),
    requestedResourcesBinding:
      managedReconciliationGuards.readDigest(
        managedReconciliationGuards.readOwn(
          record,
          'requestedResourcesBinding',
        ),
      ),
    configurationBindingDigest:
      managedReconciliationGuards.readDigest(
        managedReconciliationGuards.readOwn(
          record,
          'configurationBindingDigest',
        ),
      ),
    policyVersion: managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'policyVersion'),
    ),
    integrityResourceIdentityDigest:
      managedReconciliationGuards.readDigest(
        managedReconciliationGuards.readOwn(
          record,
          'integrityResourceIdentityDigest',
        ),
      ),
    planningReceiptDigest: managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'planningReceiptDigest'),
    ),
    executionBoundaryDigest: managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(
        record,
        'executionBoundaryDigest',
      ),
    ),
    sealedPlanningAuthorityDigest:
      managedReconciliationGuards.readDigest(
        managedReconciliationGuards.readOwn(
          record,
          'sealedPlanningAuthorityDigest',
        ),
      ),
    planDigest: managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'planDigest'),
    ),
    writerFenceDigest: managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'writerFenceDigest'),
    ),
  })
}

/**
 * Copies one exact bounded non-shared byte buffer without retaining aliases.
 *
 * @param value - Candidate ordinary Uint8Array.
 * @param maximumBytes - Fixed contract-specific byte ceiling.
 * @returns Detached exact byte copy.
 */
function copyManagedReconciliationBytes(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value)
  ) return failManagedReconciliationSession()
  const buffer = managedReconciliationGuards.readIntrinsicBuffer(value)
  const byteLength =
    managedReconciliationGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength > maximumBytes
  ) return failManagedReconciliationSession()
  const copy = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copy, [value])
  } catch {
    zeroizeManagedReconciliationBytes(copy)
    return failManagedReconciliationSession()
  }
  return copy
}

/**
 * Copies one exact ordinary authentication key without retaining aliases.
 *
 * @param value - Candidate non-shared 32-byte Uint8Array.
 * @returns Detached owned authentication key.
 */
function copyManagedReconciliationKey(value: unknown): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(
      managedReconciliationGuards.readIntrinsicBuffer(value),
    ) ||
    managedReconciliationGuards.readIntrinsicByteLength(value) !==
      managedReconciliationAuthenticationKeyBytes
  ) return failManagedReconciliationSession()
  const copy = new Uint8Array(
    managedReconciliationAuthenticationKeyBytes,
  )
  try {
    Reflect.apply(Uint8Array.prototype.set, copy, [value])
  } catch {
    zeroizeManagedReconciliationBytes(copy)
    return failManagedReconciliationSession()
  }
  return copy
}

/** Best-effort overwrites one caller-owned or invocation-owned byte buffer. */
function zeroizeManagedReconciliationBytes(value: unknown): void {
  if (!nodeUtilTypes.isUint8Array(value) || nodeUtilTypes.isProxy(value)) {
    return
  }
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // The stable high-level boundary rejects malformed public material.
  }
}

/** Overwrites every detached target-audit buffer retained for a rollback. */
function zeroizeManagedReconciliationRollbackTargetInput(
  input: WorkspaceSearchMigrationRehearsalReconciliationRollbackTargetInput,
): void {
  zeroizeManagedReconciliationBytes(input.preimageAuditBytes)
  zeroizeManagedReconciliationBytes(input.restoredAuditBytes)
  zeroizeManagedReconciliationBytes(input.runtimeVerificationKey)
  zeroizeManagedReconciliationBytes(input.publicationVerificationKey)
}

/** Overwrites all detached restricted evidence after collection completes. */
function zeroizeManagedReconciliationSessionInput(
  input: PreparedManagedReconciliationSessionInput,
): void {
  if (input.rollbackTarget !== undefined) {
    zeroizeManagedReconciliationRollbackTargetInput(input.rollbackTarget)
  }
}

/** Rejects an already cancelled high-level reconciliation invocation. */
function requireManagedReconciliationCallerActive(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) return failManagedReconciliationSession()
}

/**
 * Samples one captured trusted clock as a canonical timestamp.
 *
 * @param clock - Previously captured non-proxy Date-returning clock.
 * @returns Detached canonical UTC millisecond timestamp.
 */
function readManagedReconciliationClock(clock: () => Date): string {
  let value: unknown
  let milliseconds: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
    if (!(value instanceof Date) || nodeUtilTypes.isProxy(value)) {
      return failManagedReconciliationSession()
    }
    milliseconds = Reflect.apply(Date.prototype.getTime, value, [])
  } catch {
    return failManagedReconciliationSession()
  }
  if (
    typeof milliseconds !== 'number' ||
    !Number.isFinite(milliseconds)
  ) return failManagedReconciliationSession()
  return new Date(milliseconds).toISOString()
}

/**
 * Authenticates both rollback target files against the measured terminal.
 *
 * @param request - Detached high-level request retaining owned raw files.
 * @param terminal - Authoritative terminal reconstructed inside the session.
 * @param source - Exact measured source-session fields expected in each file.
 * @param graph - Complete durable execution graph reconstructed in-session.
 * @param guard - Authenticated permit retained by this session.
 * @param claimedHead - Manifest head claimed during remote session preflight.
 * @returns Authenticated equal target pair, or undefined for verified scenarios.
 */
function authenticateManagedReconciliationTarget(
  request: PreparedManagedReconciliationSessionInput,
  terminal:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
  source: ManagedReconciliationTargetSourceBinding,
  graph: ManagedReconciliationExecutionGraph,
  guard: NonProductionRehearsalConstructionGuard,
  claimedHead: WorkspaceSearchMigrationRehearsalStageHead | undefined,
): ManagedReconciliationAuthenticatedTargetPair | undefined {
  const target = request.rollbackTarget
  if (isManagedReconciliationVerifiedScenario(request.scenario)) {
    if (target !== undefined) return failManagedReconciliationSession()
    return undefined
  }
  if (target === undefined) return failManagedReconciliationSession()
  requireManagedReconciliationTargetContext(
    target.context,
    terminal,
    graph,
    guard,
    claimedHead,
    source.sourceResourceBindingDigest,
  )
  const targetTerminal = createManagedReconciliationTargetTerminalBinding(
    request.scenario,
    terminal,
    target.applyStartedAt,
  )
  let preimageRuntimeKey: Uint8Array | undefined
  let preimagePublicationKey: Uint8Array | undefined
  let restoredRuntimeKey: Uint8Array | undefined
  let restoredPublicationKey: Uint8Array | undefined
  try {
    preimageRuntimeKey =
      copyManagedReconciliationKey(target.runtimeVerificationKey)
    preimagePublicationKey =
      copyManagedReconciliationKey(target.publicationVerificationKey)
    restoredRuntimeKey =
      copyManagedReconciliationKey(target.runtimeVerificationKey)
    restoredPublicationKey =
      copyManagedReconciliationKey(target.publicationVerificationKey)
    const preimage = authenticateManagedReconciliationPreimageTarget(
      request.scenario,
      target.preimageAuditBytes,
      target.context,
      preimageRuntimeKey,
      preimagePublicationKey,
    )
    const restored = authenticateManagedReconciliationRestoredTarget(
      request.scenario,
      target.restoredAuditBytes,
      target.context,
      targetTerminal,
      restoredRuntimeKey,
      restoredPublicationKey,
    )
    requireManagedReconciliationTargetSourceBinding(preimage, source)
    requireManagedReconciliationTargetSourceBinding(restored, source)
    if (
      Date.parse(preimage.observedAt) >=
        Date.parse(target.applyStartedAt) ||
      Date.parse(preimage.rate.completedAt) >=
        Date.parse(target.applyStartedAt) ||
      Date.parse(restored.startedAt) <= Date.parse(terminal.terminalAt) ||
      Date.parse(restored.observedAt) <= Date.parse(terminal.terminalAt) ||
      !managedReconciliationTargetAggregatesEqual(
        preimage.aggregate,
        restored.aggregate,
      ) ||
      preimage.aggregateDigest !== restored.aggregateDigest
    ) return failManagedReconciliationSession()
    return Object.freeze({ preimage, restored })
  } finally {
    zeroizeManagedReconciliationBytes(preimageRuntimeKey)
    zeroizeManagedReconciliationBytes(preimagePublicationKey)
    zeroizeManagedReconciliationBytes(restoredRuntimeKey)
    zeroizeManagedReconciliationBytes(restoredPublicationKey)
  }
}

/**
 * Authenticates one scenario-specific pre-apply target observation.
 *
 * @param scenario - Canonical rollback scenario.
 * @param artifactBytes - Exact canonical preimage target-audit bytes.
 * @param context - Exact parent-authenticated planning context.
 * @param runtimeVerificationKey - Invocation-owned runtime HMAC key.
 * @param publicationVerificationKey - Invocation-owned publication HMAC key.
 * @returns Strict authenticated preimage target binding.
 */
function authenticateManagedReconciliationPreimageTarget(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  artifactBytes: Uint8Array,
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding {
  if (
    scenario === 'partial-apply-rollback' &&
    context.scenario === scenario
  ) {
    return authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
      artifactBytes,
      expectedContext: context,
      purpose: 'partial-rollback-preimage',
      terminal: null,
    }, runtimeVerificationKey, publicationVerificationKey)
  }
  if (
    scenario === 'complete-apply-rollback' &&
    context.scenario === scenario
  ) {
    return authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
      artifactBytes,
      expectedContext: context,
      purpose: 'complete-rollback-preimage',
      terminal: null,
    }, runtimeVerificationKey, publicationVerificationKey)
  }
  return failManagedReconciliationSession()
}

/**
 * Authenticates one restored target file with an exactly correlated purpose.
 *
 * @param scenario - Canonical rollback scenario.
 * @param artifactBytes - Exact canonical restored target-audit bytes.
 * @param context - Exact parent-authenticated planning context.
 * @param terminal - Scenario-specific authoritative rollback terminal.
 * @param runtimeVerificationKey - Invocation-owned runtime HMAC key.
 * @param publicationVerificationKey - Invocation-owned publication HMAC key.
 * @returns Strict authenticated restored target binding.
 */
function authenticateManagedReconciliationRestoredTarget(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  artifactBytes: Uint8Array,
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  terminal: WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding {
  if (scenario === 'partial-apply-rollback') {
    if (
      terminal.scenario !== scenario ||
      context.scenario !== scenario
    ) {
      return failManagedReconciliationSession()
    }
    return authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
      artifactBytes,
      expectedContext: context,
      purpose: 'partial-rollback-restored',
      terminal,
    }, runtimeVerificationKey, publicationVerificationKey)
  }
  if (scenario === 'complete-apply-rollback') {
    if (
      terminal.scenario !== scenario ||
      context.scenario !== scenario
    ) {
      return failManagedReconciliationSession()
    }
    return authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
      artifactBytes,
      expectedContext: context,
      purpose: 'complete-rollback-restored',
      terminal,
    }, runtimeVerificationKey, publicationVerificationKey)
  }
  return failManagedReconciliationSession()
}

/**
 * Derives the exact target-audit terminal contract from measured root facts.
 *
 * @param scenario - Canonical rollback scenario.
 * @param terminal - Exact measured reconciliation terminal binding.
 * @param applyStartedAt - Exact parent-observed apply admission time.
 * @returns Scenario-specific target-audit terminal binding.
 */
function createManagedReconciliationTargetTerminalBinding(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  terminal:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
  applyStartedAt: string,
): WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding {
  if (
    terminal.terminalRootKind !== 'rolled-back' ||
    scenario === 'artifact-before-checkpoint-kill' ||
    scenario === 'cursor-after-commit-kill' ||
    scenario === 'cursor-before-commit-kill' ||
    scenario === 'happy-path-verified' ||
    scenario === 'lease-expiry-takeover' ||
    scenario === 'transaction-response-loss'
  ) return failManagedReconciliationSession()
  if (scenario === 'complete-apply-rollback') {
    if (terminal.terminalRootVersion !== 1) {
      return failManagedReconciliationSession()
    }
    return Object.freeze({
      scenario,
      kind: 'rolled-back',
      version: 1,
      rootDigest: terminal.terminalRootDigest,
      applyStartedAt,
      terminalAt: terminal.terminalAt,
    })
  }
  if (terminal.terminalRootVersion !== 2) {
    return failManagedReconciliationSession()
  }
  return Object.freeze({
    scenario,
    kind: 'rolled-back',
    version: 2,
    rootDigest: terminal.terminalRootDigest,
    applyStartedAt,
    terminalAt: terminal.terminalAt,
  })
}

/**
 * Requires caller-carried target context to match the measured durable graph.
 *
 * The planning receipt digest has no DynamoDB locator and remains protected by
 * the independently verified runtime and publication artifact MACs. Every
 * graph-addressable field is reconstructed rather than trusted from input.
 *
 * @param context - Parent-authenticated target-audit context.
 * @param terminal - Authoritative terminal reconstructed in-session.
 * @param graph - Complete durable execution graph reconstructed in-session.
 * @param guard - Authenticated non-production permit.
 * @param claimedHead - Manifest head claimed during remote preflight.
 * @param requestedResourcesBinding - Exact measured resource selection.
 */
function requireManagedReconciliationTargetContext(
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  terminal:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
  graph: ManagedReconciliationExecutionGraph,
  guard: NonProductionRehearsalConstructionGuard,
  claimedHead: WorkspaceSearchMigrationRehearsalStageHead | undefined,
  requestedResourcesBinding: string,
): void {
  if (
    claimedHead === undefined ||
    context.manifestDigest !== claimedHead.manifestDigest ||
    context.permitDigest !== guard.permitDigest ||
    context.requestedResourcesBinding !==
      requestedResourcesBinding ||
    context.configurationBindingDigest !==
      terminal.configurationBindingDigest ||
    context.policyVersion !== guard.permit.policyVersion ||
    context.integrityResourceIdentityDigest !==
      guard.permit.integrityResourceIdentityDigest ||
    context.executionBoundaryDigest !==
      createMigrationDigest(graph.executionBoundary) ||
    context.sealedPlanningAuthorityDigest !==
      createMigrationDigest(graph.sealedPlanningAuthority) ||
    context.planDigest !== graph.replay.planSeal.planDigest ||
    context.writerFenceDigest !==
      graph.closedWriterFenceRecord.recordDigest
  ) return failManagedReconciliationSession()
}

/**
 * Requires one target artifact to carry the exact measured source session.
 *
 * @param artifact - Strict HMAC-authenticated target-audit binding.
 * @param source - Exact source-session fields derived by the managed session.
 */
function requireManagedReconciliationTargetSourceBinding(
  artifact: WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
  source: ManagedReconciliationTargetSourceBinding,
): void {
  if (
    artifact.commit !== source.commit ||
    artifact.configurationHash !== source.configurationHash ||
    artifact.evidenceKeyDigest !== source.evidenceKeyDigest ||
    artifact.sourceResourceBindingDigest !==
      source.sourceResourceBindingDigest ||
    artifact.sourceSessionBindingDigest !==
      source.sourceSessionBindingDigest
  ) return failManagedReconciliationSession()
}

/**
 * Compares two complete authenticated target aggregates exactly.
 *
 * @param left - Pre-apply target aggregate.
 * @param right - Post-rollback target aggregate.
 * @returns Whether every count and physical digest is identical.
 */
function managedReconciliationTargetAggregatesEqual(
  left: WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding[
    'aggregate'
  ],
  right: WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding[
    'aggregate'
  ],
): boolean {
  return left.scanned === right.scanned &&
    left.owned === right.owned &&
    left.ignored === right.ignored &&
    left.keyDigest === right.keyDigest &&
    left.contentDigest === right.contentDigest &&
    left.pageCount === right.pageCount
}

/**
 * Projects a genuine dual-key-authenticated target pair into audit summaries.
 *
 * @param target - Exact authenticated preimage and restored target bindings.
 * @returns Frozen summaries retained inside the reconciliation artifact.
 */
function createManagedReconciliationTargetAuditPair(
  target: ManagedReconciliationAuthenticatedTargetPair,
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair {
  return Object.freeze({
    preimage: createManagedReconciliationTargetAuditSummary(
      target.preimage,
    ),
    restored: createManagedReconciliationTargetAuditSummary(
      target.restored,
    ),
  })
}

/**
 * Projects one authenticated target binding without restricted identifiers.
 *
 * @param binding - Exact dual-key-authenticated target artifact binding.
 * @returns Frozen target summary including its complete auxiliary rate proof.
 */
function createManagedReconciliationTargetAuditSummary(
  binding: WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair['preimage'] {
  return Object.freeze({
    purpose: binding.purpose,
    contentDigest: binding.contentDigest,
    byteLength: binding.byteLength,
    startedAt: binding.startedAt,
    observedAt: binding.observedAt,
    observationDigest: binding.observationDigest,
    aggregateDigest: binding.aggregateDigest,
    contextDigest: createMigrationDigest(binding.context),
    context: binding.context,
    terminal: binding.terminal,
    integrity: binding.integrity,
    rate: binding.rate,
  })
}

/**
 * Independently keys the two measured migration table incarnations.
 *
 * @param configuration - Complete runtime-measured migration configuration.
 * @param integrityKey - Dedicated #163 identity HMAC key before consumption.
 * @returns Exact keyed ProjectDirectory and WorkItems identities.
 */
export function createWorkspaceSearchMigrationManagedReconciliationResourceIdentities(
  configuration: WorkspaceSearchMigrationConfiguration,
  integrityKey: Uint8Array,
): WorkspaceSearchMigrationManagedReconciliationResourceIdentities {
  try {
    const projectDirectory = configuration.tables['project-directory']
    const workItems = configuration.tables['work-items']
    return Object.freeze({
      projectDirectory:
        calculateCrossDomainIntegrityImmutableResourceIdentity({
          account: configuration.account,
          region: configuration.region,
          target: 'table:project-directory',
          tableName: projectDirectory.tableName,
          tableArn: projectDirectory.tableArn,
          tableId: projectDirectory.tableId,
          creationTime: projectDirectory.creationTime,
        }, integrityKey),
      workItems: calculateCrossDomainIntegrityImmutableResourceIdentity({
        account: configuration.account,
        region: configuration.region,
        target: 'table:work-items',
        tableName: workItems.tableName,
        tableArn: workItems.tableArn,
        tableId: workItems.tableId,
        creationTime: workItems.creationTime,
      }, integrityKey),
    })
  } catch {
    return failManagedReconciliationSession()
  }
}

/**
 * Independently validates both migration-owned table incarnations against an
 * authenticated permit or live #163 result vector.
 *
 * @param input - Precomputed expected identities and authenticated vector.
 * @returns Nothing after both keyed identities match exactly.
 */
export function validateWorkspaceSearchMigrationManagedReconciliationResourceIdentities(
  input:
    WorkspaceSearchMigrationManagedReconciliationResourceIdentityValidationInput,
): void {
  if (
    input.resourceIdentityScheme !==
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME ||
    !managedReconciliationResourceIdentitiesContainExpected(
      input.resourceIdentities,
      input.expected,
    )
  ) return failManagedReconciliationSession()
}

/** Requires one authenticated live #163 result to retain measured identities. */
function requireManagedReconciliationResultResourceIdentities(
  result: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
  expected:
    WorkspaceSearchMigrationManagedReconciliationResourceIdentities,
): void {
  validateWorkspaceSearchMigrationManagedReconciliationResourceIdentities({
    expected,
    resourceIdentityScheme: result.resourceIdentityScheme,
    resourceIdentities: result.resourceIdentities,
  })
}

/** Checks both migration-owned entries inside one canonical seven-entry vector. */
function managedReconciliationResourceIdentitiesContainExpected(
  identities: readonly CrossDomainIntegrityResourceIdentity[],
  expected:
    WorkspaceSearchMigrationManagedReconciliationResourceIdentities,
): boolean {
  const projectDirectory = identities.find(
    (identity) => identity.target === 'table:project-directory',
  )
  const workItems = identities.find(
    (identity) => identity.target === 'table:work-items',
  )
  return projectDirectory !== undefined &&
    projectDirectory.identityDigest ===
      expected.projectDirectory.identityDigest &&
    workItems !== undefined &&
    workItems.identityDigest === expected.workItems.identityDigest
}

/** Checks exact canonical vector equality for manifest-to-permit binding. */
function sameManagedReconciliationResourceIdentityVector(
  left: readonly CrossDomainIntegrityResourceIdentity[],
  right: readonly CrossDomainIntegrityResourceIdentity[],
): boolean {
  return left.length === right.length && left.every((identity, index) => {
    const other = right[index]
    return other !== undefined &&
      identity.target === other.target &&
      identity.identityDigest === other.identityDigest
  })
}

/**
 * Requires both authenticated rollback target results to match measured state.
 *
 * @param target - Authenticated target pair, absent for verified scenarios.
 * @param expectedResourceIdentityDigest - Permit-pinned seven-resource digest.
 * @param expectedMigrationResourceIdentities - Measured keyed table identities.
 */
function requireManagedReconciliationTargetResourceIdentities(
  target: ManagedReconciliationAuthenticatedTargetPair | undefined,
  expectedResourceIdentityDigest: string,
  expectedMigrationResourceIdentities:
    WorkspaceSearchMigrationManagedReconciliationResourceIdentities,
): void {
  if (target === undefined) return
  for (const binding of [target.preimage, target.restored]) {
    const integrity = binding.integrity
    if (
      integrity.result.resourceIdentityDigest !==
        expectedResourceIdentityDigest ||
      integrity.configurationBindingDigest !==
        binding.context.configurationBindingDigest ||
      integrity.policyVersion !== binding.context.policyVersion
    ) return failManagedReconciliationSession()
    requireManagedReconciliationResultResourceIdentities(
      integrity.result,
      expectedMigrationResourceIdentities,
    )
  }
}

/**
 * Completes one measured base after rate sealing and live #163 finalization.
 *
 * The verified genuine rate-bound result is inspected but deliberately not
 * consumed; the reconciliation-audit v3 finalizer remains its sole consumer.
 * Rollback comparison fields are derived only from the two already
 * authenticated target-audit integrity results retained behind the base.
 *
 * @param input - Genuine base and scenario-specific post-seal live result.
 * @returns Complete finalizer-ready reconciliation collector result.
 */
export function completeWorkspaceSearchMigrationRehearsalReconciliation(
  input: CompleteWorkspaceSearchMigrationRehearsalReconciliationInput,
): WorkspaceSearchMigrationRehearsalReconciliationCollectorResult {
  const record = managedReconciliationGuards.requireRecord(input)
  managedReconciliationGuards.requireExactKeys(record, [
    'collectedBase',
    'verifiedIntegrity',
  ])
  const state = consumeManagedReconciliationCollectedBase(
    managedReconciliationGuards.readOwn(record, 'collectedBase'),
  )
  const context = completeManagedReconciliationCoreContext(
    state.base.context,
    state.clock,
  )
  const verifiedIntegrity = managedReconciliationGuards.readOwn(
    record,
    'verifiedIntegrity',
  )
  const integrity = state.target === undefined
    ? createManagedVerifiedReconciliationIntegrity(
      verifiedIntegrity,
      state,
      context,
    )
    : createManagedRollbackReconciliationIntegrity(
      verifiedIntegrity,
      state,
      context,
    )
  return Object.freeze({
    ...state.base,
    context,
    integrity,
  })
}

/** Consumes one genuine collected base before post-seal input validation. */
function consumeManagedReconciliationCollectedBase(
  value: unknown,
): ManagedReconciliationCollectedBaseState {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failManagedReconciliationSession()
  const state = managedReconciliationCollectedBaseStates.get(value)
  if (state === undefined) return failManagedReconciliationSession()
  managedReconciliationCollectedBaseStates.delete(value)
  return state
}

/** Samples the retained clock and advances the final collector completion. */
function completeManagedReconciliationCoreContext(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  clock: () => Date,
): WorkspaceSearchMigrationRehearsalReconciliationCoreContext {
  const checkedAt = readManagedReconciliationClock(clock)
  if (Date.parse(checkedAt) < Date.parse(context.checkedAt)) {
    return failManagedReconciliationSession()
  }
  return Object.freeze({ ...context, checkedAt })
}

/** Strictly reads the live projection without consuming its genuine wrapper. */
function readManagedReconciliationRateBoundIntegrityProjection(
  value: unknown,
): ManagedReconciliationRateBoundIntegrityProjection {
  const record = managedReconciliationGuards.requireRecord(value)
  managedReconciliationGuards.requireExactKeys(record, [
    'bindingMac',
    'configurationBindingDigest',
    'interval',
    'kind',
    'policyVersion',
    'predecessor',
    'result',
    'segment',
    'tableOrderBindingMac',
    'version',
  ])
  if (
    managedReconciliationGuards.readOwn(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result' ||
    managedReconciliationGuards.readOwn(record, 'version') !== 1
  ) return failManagedReconciliationSession()
  let result: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection
  try {
    result = readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
      managedReconciliationGuards.readOwn(record, 'result'),
    )
  } catch {
    return failManagedReconciliationSession()
  }
  return Object.freeze({
    result,
    policyVersion: managedReconciliationGuards.readDigest(
      managedReconciliationGuards.readOwn(record, 'policyVersion'),
    ),
    configurationBindingDigest:
      managedReconciliationGuards.readDigest(
        managedReconciliationGuards.readOwn(
          record,
          'configurationBindingDigest',
        ),
      ),
  })
}

/** Derives the verified collector branch without consuming the live result. */
function createManagedVerifiedReconciliationIntegrity(
  value: unknown,
  state: ManagedReconciliationCollectedBaseState,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult {
  if (
    value === null ||
    !isManagedReconciliationVerifiedScenario(context.scenario) ||
    context.terminalRootKind !== 'verified'
  ) return failManagedReconciliationSession()
  const parsed = readManagedReconciliationRateBoundIntegrityProjection(value)
  const result = parsed.result
  if (
    parsed.policyVersion !== context.policyVersion ||
    parsed.configurationBindingDigest !==
      context.configurationBindingDigest ||
    result.resourceIdentityDigest !==
      state.expectedResourceIdentityDigest ||
    Date.parse(result.runtimeProvenance.startedAt) <=
      Date.parse(context.terminalAt) ||
    Date.parse(result.checkedAt) <= Date.parse(context.terminalAt) ||
    Date.parse(result.checkedAt) > Date.parse(context.checkedAt)
  ) return failManagedReconciliationSession()
  requireManagedReconciliationResultResourceIdentities(
    result,
    state.expectedMigrationResourceIdentities,
  )
  return Object.freeze({
    kind: 'verified-result',
    status: 'pass',
    failureCount: 0,
    completedAt: context.checkedAt,
    result,
    terminalRootDigest: context.terminalRootDigest,
    integrityAggregateDigest: result.integrityAggregateDigest,
  })
}

/** Derives the rollback comparison solely from authenticated target results. */
function createManagedRollbackReconciliationIntegrity(
  verifiedIntegrity: unknown,
  state: ManagedReconciliationCollectedBaseState,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult {
  const target = state.target
  if (
    verifiedIntegrity !== null ||
    target === undefined ||
    context.terminalRootKind !== 'rolled-back'
  ) return failManagedReconciliationSession()
  const purpose = context.scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : context.scenario === 'complete-apply-rollback'
    ? 'complete-rollback'
    : failManagedReconciliationSession()
  const terminal = target.restored.terminal
  if (terminal === null) return failManagedReconciliationSession()
  const before = target.preimage.integrity.result
  const after = target.restored.integrity.result
  const startedAt = before.runtimeProvenance.startedAt
  const applyStartedAt = terminal.applyStartedAt
  const terminalAt = terminal.terminalAt
  const completedAt = after.checkedAt
  if (
    before.contentDigest === after.contentDigest ||
    before.resultDigest === after.resultDigest ||
    before.resultMac === after.resultMac ||
    before.integrityAggregateDigest !== after.integrityAggregateDigest ||
    before.resourceIdentityScheme !== after.resourceIdentityScheme ||
    !sameManagedReconciliationResourceIdentityVector(
      before.resourceIdentities,
      after.resourceIdentities,
    ) ||
    before.resourceIdentityDigest !== after.resourceIdentityDigest ||
    before.resourceIdentityDigest !==
      state.expectedResourceIdentityDigest ||
    Date.parse(before.checkedAt) >= Date.parse(applyStartedAt) ||
    Date.parse(applyStartedAt) >= Date.parse(terminalAt) ||
    terminalAt !== context.terminalAt ||
    Date.parse(after.runtimeProvenance.startedAt) <=
      Date.parse(terminalAt) ||
    Date.parse(completedAt) > Date.parse(context.checkedAt) ||
    target.preimage.aggregateDigest !== target.restored.aggregateDigest
  ) return failManagedReconciliationSession()
  const comparisonDigest = createMigrationDigest({
    purpose,
    beforeResultDigest: before.resultDigest,
    afterResultDigest: after.resultDigest,
    comparison: {
      kind:
        'mukuroji-cross-domain-integrity-migration-rehearsal-comparison',
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      status: 'pass',
    },
  })
  const comparisonFields = Object.freeze({
    purpose,
    startedAt,
    applyStartedAt,
    terminalAt,
    completedAt,
    before,
    after,
    comparisonDigest,
  })
  return Object.freeze({
    kind: 'rollback-comparison',
    status: 'pass',
    failureCount: 0,
    ...comparisonFields,
    comparisonContextDigest: createMigrationDigest({
      kind:
        'workspace-search-migration-rehearsal-integrity-context/v3',
      version: 3,
      ...comparisonFields,
    }),
    terminalRootDigest: context.terminalRootDigest,
    targetPreimageAggregateDigest: target.preimage.aggregateDigest,
    targetRestoredAggregateDigest: target.restored.aggregateDigest,
    targetPreimageStatus: 'equal',
  })
}

/**
 * Creates one strict complete or prefix marker seal projection.
 *
 * @param markerCount - Positive durable marker count fixed by the root.
 * @param aggregateDigest - Exact order-independent marker aggregate digest.
 * @returns Frozen validated marker seal.
 */
function createManagedReconciliationMarkerSeal(
  markerCount: number,
  aggregateDigest: string,
): ManagedReconciliationMarkerSeal {
  if (
    !Number.isSafeInteger(markerCount) ||
    markerCount <= 0 ||
    !isHexDigest(aggregateDigest)
  ) return failManagedReconciliationSession()
  return Object.freeze({ markerCount, aggregateDigest })
}

/**
 * Derives one verified-terminal identity from the complete measured graph.
 *
 * @param graph - Exact admitted execution graph.
 * @param version - Persistence version read from the verified root.
 * @param rootDigest - Complete verified-root digest.
 * @param applyBoundaryDigest - Complete applied-root digest.
 * @param terminalAt - Canonical verified-root publication time.
 * @param appliedOperationCount - Complete durable marker count.
 * @returns Frozen exact verified terminal binding.
 */
function createManagedVerifiedTerminalBinding(
  graph: ManagedReconciliationExecutionGraph,
  version: 1,
  rootDigest: string,
  applyBoundaryDigest: string,
  terminalAt: string,
  appliedOperationCount: number,
): WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding {
  return createManagedReconciliationTerminalBinding(
    graph,
    'verified',
    version,
    rootDigest,
    applyBoundaryDigest,
    terminalAt,
    appliedOperationCount,
  )
}

/**
 * Derives one rolled-back terminal identity from the complete measured graph.
 *
 * @param graph - Exact admitted execution graph.
 * @param version - Complete or committed-prefix rollback persistence version.
 * @param rootDigest - Complete rolled-back root digest.
 * @param applyBoundaryDigest - Applied-root or committed-prefix origin digest.
 * @param terminalAt - Canonical rolled-back root publication time.
 * @param appliedOperationCount - Complete or committed-prefix marker count.
 * @returns Frozen exact rolled-back terminal binding.
 */
function createManagedRolledBackTerminalBinding(
  graph: ManagedReconciliationExecutionGraph,
  version: 1 | 2,
  rootDigest: string,
  applyBoundaryDigest: string,
  terminalAt: string,
  appliedOperationCount: number,
): WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding {
  return createManagedReconciliationTerminalBinding(
    graph,
    'rolled-back',
    version,
    rootDigest,
    applyBoundaryDigest,
    terminalAt,
    appliedOperationCount,
  )
}

/**
 * Constructs and validates fields shared by every reconciliation terminal.
 *
 * @param graph - Exact admitted execution graph.
 * @param kind - Verified or rolled-back terminal classification.
 * @param version - Exact terminal persistence version.
 * @param rootDigest - Complete terminal root digest.
 * @param applyBoundaryDigest - Complete or committed-prefix apply root digest.
 * @param terminalAt - Canonical terminal publication time.
 * @param appliedOperationCount - Complete or committed-prefix marker count.
 * @returns Frozen exact terminal identity.
 */
function createManagedReconciliationTerminalBinding(
  graph: ManagedReconciliationExecutionGraph,
  kind: 'rolled-back' | 'verified',
  version: 1 | 2,
  rootDigest: string,
  applyBoundaryDigest: string,
  terminalAt: string,
  appliedOperationCount: number,
): WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding {
  const sealedPlanOperationCount =
    graph.sealedPlanningAuthority.planOperationCount
  if (
    !isHexDigest(rootDigest) ||
    !isHexDigest(applyBoundaryDigest) ||
    !isCanonicalTimestamp(terminalAt) ||
    !Number.isSafeInteger(sealedPlanOperationCount) ||
    sealedPlanOperationCount <= 0 ||
    !Number.isSafeInteger(appliedOperationCount) ||
    appliedOperationCount <= 0 ||
    appliedOperationCount > sealedPlanOperationCount ||
    (kind === 'verified' && version !== 1) ||
    (kind === 'verified' &&
      appliedOperationCount !== sealedPlanOperationCount)
  ) return failManagedReconciliationSession()
  return Object.freeze({
    configurationBindingDigest: graph.authority.configurationHash,
    sealedPlanningAuthorityDigest:
      graph.sealedPlanningAuthority.authorityDigest,
    executionRunDigest: graph.executionRun.executionRunDigest,
    planDigest: graph.sealedPlanningAuthority.planDigest,
    applyBoundaryDigest,
    terminalRootKind: kind,
    terminalRootVersion: version,
    terminalRootDigest: rootDigest,
    sealedPlanOperationCount,
    appliedOperationCount,
    terminalAt,
  })
}

/**
 * Projects the exact replayed plan prefix into marker expectations.
 *
 * @param replay - Strict complete immutable plan replay.
 * @param markerCount - Complete or committed-prefix marker count.
 * @returns Frozen ordered exact marker expectation.
 */
function createManagedReconciliationExpectedMarkers(
  replay: WorkspaceSearchMigrationPlanArtifactReplayResult,
  markerCount: number,
): readonly WorkspaceSearchMigrationRehearsalExpectedMarker[] {
  if (
    !Number.isSafeInteger(markerCount) ||
    markerCount <= 0 ||
    markerCount > replay.operations.length
  ) return failManagedReconciliationSession()
  const markers: WorkspaceSearchMigrationRehearsalExpectedMarker[] = []
  for (let index = 0; index < markerCount; index += 1) {
    const planned = replay.operations[index]
    if (
      planned === undefined ||
      planned.planSequence !== index + 1 ||
      !isHexDigest(planned.operationDigest)
    ) return failManagedReconciliationSession()
    markers.push(Object.freeze({
      operationId: planned.operation.operationId,
      planSequence: planned.planSequence,
      planOperationDigest: planned.operationDigest,
    }))
  }
  return Object.freeze(markers)
}

/**
 * Creates the exact finalizer context after every strong read completes.
 *
 * @param request - Detached scenario and stage-derived run locator.
 * @param terminal - Exact measured authoritative terminal.
 * @param policyVersion - Permit-authenticated reviewed rate-policy digest.
 * @param integrityResourceIdentityDigest - Permit-authenticated #163 identity.
 * @param checkedAt - Trusted completion sampled after collection.
 * @returns Frozen complete reconciliation core context.
 */
function createManagedReconciliationCoreContext(
  request: PreparedManagedReconciliationSessionInput,
  terminal:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
  policyVersion: string,
  integrityResourceIdentityDigest: string,
  checkedAt: string,
): WorkspaceSearchMigrationRehearsalReconciliationCoreContext {
  if (
    !isHexDigest(policyVersion) ||
    !isHexDigest(integrityResourceIdentityDigest) ||
    !isCanonicalTimestamp(checkedAt) ||
    Date.parse(terminal.terminalAt) >= Date.parse(checkedAt)
  ) return failManagedReconciliationSession()
  return Object.freeze({
    scenario: request.scenario,
    runLocatorDigest: request.runLocatorDigest,
    configurationBindingDigest: terminal.configurationBindingDigest,
    policyVersion,
    integrityResourceIdentityDigest,
    sealedPlanningAuthorityDigest:
      terminal.sealedPlanningAuthorityDigest,
    executionRunDigest: terminal.executionRunDigest,
    planDigest: terminal.planDigest,
    applyBoundaryDigest: terminal.applyBoundaryDigest,
    terminalRootKind: terminal.terminalRootKind,
    terminalRootVersion: terminal.terminalRootVersion,
    terminalRootDigest: terminal.terminalRootDigest,
    sealedPlanOperationCount: terminal.sealedPlanOperationCount,
    appliedOperationCount: terminal.appliedOperationCount,
    terminalAt: terminal.terminalAt,
    checkedAt,
  })
}

/**
 * Derives source/target comparison arithmetic from authenticated terminal data.
 *
 * @param verified - Passing full-verification result for verified scenarios.
 * @param target - Equal target-audit pair for rollback scenarios.
 * @returns Conservative finalizer-ready source/target summary.
 */
function createManagedReconciliationSourceTargetSummary(
  verified: WorkspaceSearchMigrationFullVerificationResult | undefined,
  target: ManagedReconciliationAuthenticatedTargetPair | undefined,
): WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult {
  if (verified !== undefined && target === undefined) {
    return createManagedReconciliationAggregateSummary(
      verified.expectedTargetPresentBindings.count,
      verified.expectedTargetPresentBindings.digest,
      verified.observedTargetPresentBindings.count,
      verified.observedTargetPresentBindings.digest,
    )
  }
  if (verified === undefined && target !== undefined) {
    return createManagedReconciliationAggregateSummary(
      target.preimage.aggregate.scanned,
      target.preimage.aggregateDigest,
      target.restored.aggregate.scanned,
      target.restored.aggregateDigest,
    )
  }
  return failManagedReconciliationSession()
}

/**
 * Creates exact arithmetic without claiming item-level matches on divergence.
 *
 * @param expectedCount - Expected aggregate item count.
 * @param expectedDigest - Expected aggregate digest.
 * @param observedCount - Observed aggregate item count.
 * @param observedDigest - Observed aggregate digest.
 * @returns Frozen exact-match or conservative total-mismatch summary.
 */
function createManagedReconciliationAggregateSummary(
  expectedCount: number,
  expectedDigest: string,
  observedCount: number,
  observedDigest: string,
): WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    !Number.isSafeInteger(observedCount) ||
    observedCount < 0 ||
    !isHexDigest(expectedDigest) ||
    !isHexDigest(observedDigest)
  ) return failManagedReconciliationSession()
  const equal = expectedCount === observedCount &&
    expectedDigest === observedDigest
  return Object.freeze({
    expectedAggregateDigest: expectedDigest,
    observedAggregateDigest: observedDigest,
    expectedCount,
    observedCount,
    matchedCount: equal ? expectedCount : 0,
    lostCount: equal ? 0 : expectedCount,
    unexpectedCount: equal ? 0 : observedCount,
  })
}

/**
 * Hashes one detached managed-planning configuration behind input validation.
 *
 * @param configuration - Detached caller-supplied measured configuration.
 * @returns Reviewed configuration hash or a fixed invalid-input failure.
 */
function createManagedPlanningConfigurationHash(
  configuration: WorkspaceSearchMigrationConfiguration,
): string {
  try {
    return createWorkspaceSearchConfigurationHash(configuration)
  } catch {
    return failSourceScanAws('INVALID_ARGUMENT')
  }
}

/**
 * Runs one five-chain planning join behind a fixed redaction boundary.
 *
 * @param operation - Complete same-generation material composition.
 * @returns Fully revalidated pure planning-join result.
 */
async function runManagedPlanningJoinAwsBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    const code = readManagedMigrationStateFailureCode(error)
    throw new WorkspaceSearchMigrationFailure(
      code,
      `Workspace Search planning material join stopped safely (${code}).`,
    )
  }
}

/**
 * Copies one private remaining budget into an immutable adapter request.
 *
 * @param budget - Current private five-chain material budget.
 * @returns Scalar remaining limits safe to retain across adapter awaits.
 */
function createManagedPlanningMaterialReadLimits(
  budget: ManagedPlanningMaterialBudget,
): WorkspaceSearchMigrationPlanningMaterialReadLimits {
  return {
    maxRows: budget.rows,
    maxCanonicalItemBytes: budget.canonicalItemBytes,
  }
}

/**
 * Requires one evidence-head counter to be a nonnegative safe integer.
 *
 * @param value - Counter parsed from one durable progress head.
 * @returns Validated exact count.
 */
function requireManagedPlanningHeadCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    return failManagedPlanningJoin('INVALID_STATE')
  }
  return value
}

/**
 * Adds one evidence-head counter without permitting integer overflow.
 *
 * @param current - Accumulated validated count.
 * @param additional - Next durable head count.
 * @returns Exact safe sum.
 */
function addManagedPlanningHeadCount(
  current: number,
  additional: number,
): number {
  const sum = current + requireManagedPlanningHeadCount(additional)
  if (!Number.isSafeInteger(sum)) {
    return failManagedPlanningJoin('INVALID_STATE')
  }
  return sum
}

/**
 * Raises one trusted secret-free managed planning-join failure.
 *
 * @param code - Stable failure selected by managed composition logic.
 * @returns Never returns.
 */
function failManagedPlanningJoin(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search planning material join stopped safely (${code}).`,
  )
}

/**
 * Raises one stable managed planning storage lifecycle failure.
 *
 * @returns Never returns.
 */
function failManagedPlanningArtifact(): never {
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_STATE',
    'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
  )
}

/**
 * Raises one stable measured artifact-preflight failure.
 *
 * @param code - Invalid artifact time, deadline, or measurement state.
 * @returns Never returns.
 */
function failManagedPlanningArtifactPreflight(
  code:
    | 'DRY_RUN_INVALID_ROWS'
    | 'INVALID_ARGUMENT'
    | 'INVALID_STATE',
): never {
  throw new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search planning artifact preflight stopped safely (${code}).`,
  )
}

/**
 * Raises one stable managed sealed-publication lifecycle failure.
 *
 * @returns Never returns.
 */
function failManagedSealedPlanningAuthority(): never {
  throw createManagedSealedPlanningAuthorityFailure('INVALID_STATE')
}

/**
 * Creates one stable managed sealed-publication failure.
 *
 * @param code - Stable operator-safe lifecycle or drift classification.
 * @returns Secret-free publication failure.
 */
function createManagedSealedPlanningAuthorityFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search sealed planning authority publication failed.',
  )
}

/**
 * Raises one stable managed application writer-fence lifecycle failure.
 *
 * @returns Never returns.
 */
function failManagedApplicationWriterFence(): never {
  throw createManagedApplicationWriterFenceFailure('INVALID_STATE')
}

/**
 * Creates one stable managed application writer-fence failure.
 *
 * @param code - Stable operator-safe lifecycle or drift classification.
 * @returns Secret-free writer-fence failure.
 */
function createManagedApplicationWriterFenceFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search application writer fence operation failed.',
  )
}

/**
 * Raises one stable managed execution-boundary lifecycle failure.
 *
 * @returns Never returns.
 */
function failManagedExecutionBoundary(): never {
  throw createManagedExecutionBoundaryFailure('INVALID_STATE')
}

/**
 * Creates one stable managed execution-boundary failure.
 *
 * @param code - Stable operator-safe lifecycle or drift classification.
 * @returns Secret-free execution-boundary failure.
 */
function createManagedExecutionBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration execution boundary operation failed.',
  )
}

/**
 * Raises one stable managed execution-run lifecycle failure.
 *
 * @returns Never returns.
 */
function failManagedExecutionRun(): never {
  throw createManagedExecutionRunFailure('INVALID_STATE')
}

/**
 * Creates one stable managed execution-run failure.
 *
 * @param code - Stable operator-safe lifecycle or drift classification.
 * @returns Secret-free execution-run failure.
 */
function createManagedExecutionRunFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration execution run operation failed.',
  )
}

/**
 * Raises one stable managed apply-operation lifecycle failure.
 *
 * @returns Never returns.
 */
function failManagedApplyOperation(): never {
  throw createManagedApplyOperationFailure('INVALID_STATE')
}

/**
 * Creates one stable managed apply-operation failure.
 *
 * @param code - Stable operator-safe lifecycle, drift, or ambiguity code.
 * @returns Secret-free apply-operation failure.
 */
function createManagedApplyOperationFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration apply operation failed.',
  )
}

/**
 * Raises one stable managed full-verification lifecycle failure.
 *
 * @returns Never returns.
 */
function failManagedFullVerification(): never {
  throw createManagedFullVerificationFailure('INVALID_STATE')
}

/**
 * Creates one stable managed full-verification failure.
 *
 * @param code - Stable operator-safe lifecycle, drift, or ambiguity code.
 * @returns Secret-free full-verification failure.
 */
function createManagedFullVerificationFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration full verification failed.',
  )
}

/**
 * Raises one stable managed rollback-operation lifecycle failure.
 *
 * @returns Never returns.
 */
function failManagedRollbackOperation(): never {
  throw createManagedRollbackOperationFailure('INVALID_STATE')
}

/**
 * Raises one stable high-level rehearsal reconciliation failure.
 *
 * @returns Never returns.
 */
function failManagedReconciliationSession(): never {
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_STATE',
    'Workspace Search migration rehearsal reconciliation failed.',
  )
}

/**
 * Creates one stable managed rollback-operation failure.
 *
 * @param code - Stable operator-safe lifecycle, drift, or ambiguity code.
 * @returns Secret-free rollback-operation failure.
 */
function createManagedRollbackOperationFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration rollback operation failed.',
  )
}

/**
 * Best-effort releases an unconsumed stale GetObject body.
 *
 * @param output - Raw GetObject output rejected by lifecycle authority.
 */
function cancelManagedPlanningArtifactGetBody(
  output: GetObjectCommandOutput,
): void {
  const body = readManagedPlanningArtifactGetBody(output)
  invokeManagedPlanningArtifactBodyCancellation(body, 'destroy')
  invokeManagedPlanningArtifactBodyCancellation(body, 'cancel')
}

/**
 * Reads only an own data-valued GetObject body without invoking accessors.
 *
 * @param output - Raw potentially hostile GetObject output.
 * @returns Untrusted body value or undefined when it cannot be read safely.
 */
function readManagedPlanningArtifactGetBody(
  output: GetObjectCommandOutput,
): unknown {
  try {
    if (nodeUtilTypes.isProxy(output)) return undefined
    const descriptor = Reflect.getOwnPropertyDescriptor(output, 'Body')
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return undefined
    }
    return descriptor.value
  } catch {
    return undefined
  }
}

/**
 * Invokes one safe optional cancellation method without replacing the failure.
 *
 * @param body - Candidate stale S3 response body.
 * @param methodName - Allowlisted body cancellation method.
 */
function invokeManagedPlanningArtifactBodyCancellation(
  body: unknown,
  methodName: 'cancel' | 'destroy',
): void {
  try {
    if (
      (
        typeof body !== 'object' &&
        typeof body !== 'function'
      ) ||
      body === null ||
      nodeUtilTypes.isProxy(body)
    ) {
      return
    }
    const method = readManagedPlanningArtifactBodyMethod(
      body,
      methodName,
    )
    if (method === undefined) return
    const result: unknown = Reflect.apply(method, body, [])
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // Lifecycle invalidation remains authoritative over cleanup failures.
  }
}

/**
 * Finds one non-proxy cancellation method through data descriptors only.
 *
 * @param body - Validated non-proxy cancellation receiver.
 * @param methodName - Allowlisted method name.
 * @returns Callable data method or undefined.
 */
function readManagedPlanningArtifactBodyMethod(
  body: object | Function,
  methodName: 'cancel' | 'destroy',
): Function | undefined {
  let current: object | null = body
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) return undefined
    const descriptor =
      Reflect.getOwnPropertyDescriptor(current, methodName)
    if (descriptor !== undefined) {
      return Object.prototype.hasOwnProperty.call(
          descriptor,
          'value',
        ) &&
          typeof descriptor.value === 'function' &&
          !nodeUtilTypes.isProxy(descriptor.value)
        ? descriptor.value
        : undefined
    }
    current = Reflect.getPrototypeOf(current)
  }
  return undefined
}

/**
 * Runs one managed evidence call behind a fixed raw-error replacement boundary.
 *
 * @param operation - Captured-authority validation and adapter operation.
 * @returns Detached progress from the managed evidence adapter.
 */
async function runManagedSourceEvidenceAwsBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    const code = readManagedMigrationStateFailureCode(error)
    throw new WorkspaceSearchMigrationFailure(
      code,
      `Workspace Search source evidence stopped safely (${code}).`,
    )
  }
}

/**
 * Runs one managed target-evidence call behind a raw-error replacement boundary.
 *
 * @param operation - Captured-authority validation and adapter operation.
 * @returns Detached progress or replay output from the measured adapter.
 */
async function runManagedTargetEvidenceAwsBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    const code = readManagedMigrationStateFailureCode(error)
    throw createManagedTargetEvidenceFailure(code)
  }
}

/**
 * Creates one fixed public failure for managed target-evidence operations.
 *
 * @param code - Trusted target, artifact, or migration-state classification.
 * @returns Secret-free target-evidence failure accepted by adapter boundaries.
 */
function createManagedTargetEvidenceFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search target evidence stopped safely (${code}).`,
  )
}

/**
 * Creates one public role-aware failure for final evidence-write preparation.
 *
 * @param code - Trusted source or migration-state failure classification.
 * @returns Fixed source-evidence failure accepted by the inner AWS boundary.
 */
function createManagedSourceEvidencePreparationFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search source evidence stopped safely (${code}).`,
  )
}

/** Creates one stable invalid pre-plan input failure before rate admission. */
function createManagedPrePlanSnapshotFailure():
  WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    'INVALID_ARGUMENT',
    'Workspace Search pre-plan authority input is invalid.',
  )
}

/**
 * Detaches caller input before an asynchronous rate-gate admission wait.
 *
 * @param input - Caller-owned value that must not remain live while queued.
 * @param createFailure - Stable phase-specific invalid-input failure factory.
 * @returns Deep detached snapshot used after admission.
 */
function snapshotManagedRateGateInput<Input>(
  input: Input,
  createFailure: () => WorkspaceSearchMigrationFailure,
): Input {
  return snapshotManagedRateGateOperation(
    () => structuredClone(input),
    createFailure,
  )
}

/**
 * Runs synchronous input preparation behind a raw-value-free failure boundary.
 *
 * @param operation - Synchronous snapshot or validation operation.
 * @param createFailure - Stable phase-specific invalid-input failure factory.
 * @returns Exact synchronously prepared value.
 */
function snapshotManagedRateGateOperation<Result>(
  operation: () => Result,
  createFailure: () => WorkspaceSearchMigrationFailure,
): Result {
  try {
    return operation()
  } catch {
    throw createFailure()
  }
}

/**
 * Runs one managed pre-plan authority call behind a raw-error replacement boundary.
 *
 * @param operation - Captured-authority validation and adapter operation.
 * @returns Detached authority result from the measured adapter.
 */
async function runManagedPrePlanAuthorityAwsBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    const code = readManagedMigrationStateFailureCode(error)
    throw new WorkspaceSearchMigrationFailure(
      code,
      `Workspace Search pre-plan authority stopped safely (${code}).`,
    )
  }
}

/**
 * Reads only an allowlisted code from a managed migration-state failure.
 *
 * @param error - Arbitrary value raised during state authority or AWS I/O.
 * @returns Operator-safe code or the fail-closed default.
 */
function readManagedMigrationStateFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : 'INVALID_STATE'
    }
    if (error instanceof TargetScanAwsFailure) return error.code
  } catch {
    return 'INVALID_STATE'
  }
  return readSourceScanAwsFailureCode(error)
}

/**
 * Reads only a privately constructed managed source Scan failure code.
 *
 * @param error - Arbitrary value raised during authority checks or SDK I/O.
 * @returns Trusted private code or the fail-closed default.
 */
function readSourceScanAwsFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof SourceScanAwsFailure) return error.code
    if (error instanceof ResourceNotFoundException) return 'SOURCE_DRIFT'
    if (!(error instanceof Error)) return 'INVALID_STATE'
    const classificationInput =
      createSourceScanAwsErrorClassificationInput(error)
    if (
      isThrottlingError(classificationInput) ||
      isTransientError(classificationInput)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Reads only trusted target Scan failure codes and redacts raw transport data.
 *
 * @param error - Arbitrary value raised during target checks or SDK I/O.
 * @returns Trusted private code or the fail-closed default.
 */
function readTargetScanAwsFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof TargetScanAwsFailure) return error.code
    if (error instanceof SourceScanAwsFailure) {
      switch (error.code) {
        case 'CONFIGURATION_HASH_MISMATCH':
        case 'IDENTITY_MISMATCH':
        case 'INVALID_ARGUMENT':
        case 'INVALID_STATE':
        case 'TABLE_SCHEMA_MISMATCH':
        case 'TRANSIENT_INFRASTRUCTURE_FAILURE':
          return error.code
        default:
          return 'INVALID_STATE'
      }
    }
    if (error instanceof ResourceNotFoundException) return 'TARGET_DRIFT'
    if (!(error instanceof Error)) return 'INVALID_STATE'
    const classificationInput =
      createSourceScanAwsErrorClassificationInput(error)
    if (
      isThrottlingError(classificationInput) ||
      isTransientError(classificationInput)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Copies only fields required by Smithy's retry classifiers.
 *
 * @param error - Raw SDK or Node.js transport error.
 * @param depth - Bounded wrapped-cause depth copied so far.
 * @returns Detached secret-free classifier input.
 */
function createSourceScanAwsErrorClassificationInput(
  error: Error,
  depth = 0,
): SourceScanAwsErrorClassificationInput {
  const nameValue: unknown = Reflect.get(error, 'name')
  const codeValue: unknown = Reflect.get(error, 'code')
  const metadataValue: unknown = Reflect.get(error, '$metadata')
  const retryableValue: unknown = Reflect.get(error, '$retryable')
  const causeValue: unknown =
    depth <= 10 ? Reflect.get(error, 'cause') : undefined
  const httpStatusCode = readOptionalNumericProperty(
    metadataValue,
    'httpStatusCode',
  )
  const throttling = readOptionalBooleanProperty(
    retryableValue,
    'throttling',
  )
  const hasRetryableTrait =
    typeof retryableValue === 'object' && retryableValue !== null
  return {
    name: typeof nameValue === 'string' ? nameValue : '',
    message: '',
    ...(typeof codeValue === 'string' ? { code: codeValue } : {}),
    ...(httpStatusCode === undefined
      ? {}
      : { $metadata: { httpStatusCode } }),
    ...(hasRetryableTrait
      ? {
          $retryable:
            throttling === undefined ? {} : { throttling },
        }
      : {}),
    ...(causeValue instanceof Error
      ? {
          cause: createSourceScanAwsErrorClassificationInput(
            causeValue,
            depth + 1,
          ),
        }
      : {}),
  }
}

/**
 * Reads one optional numeric classifier property without trusting its shape.
 *
 * @param value - Candidate object containing the property.
 * @param property - Exact property name to read.
 * @returns Finite number or undefined.
 */
function readOptionalNumericProperty(
  value: unknown,
  property: string,
): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'number' && Number.isFinite(propertyValue)
    ? propertyValue
    : undefined
}

/**
 * Reads one optional boolean classifier property without trusting its shape.
 *
 * @param value - Candidate object containing the property.
 * @param property - Exact property name to read.
 * @returns Boolean or undefined.
 */
function readOptionalBooleanProperty(
  value: unknown,
  property: string,
): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'boolean' ? propertyValue : undefined
}

/**
 * Raises one privately branded managed source Scan failure.
 *
 * @param code - Stable trusted adapter failure code.
 * @returns Never returns.
 */
function failSourceScanAws(code: SourceScanAwsFailureCode): never {
  throw new SourceScanAwsFailure(code)
}

/**
 * Raises one privately branded managed target Scan failure.
 *
 * @param code - Stable trusted adapter failure code.
 * @returns Never returns.
 */
function failTargetScanAws(code: TargetScanAwsFailureCode): never {
  throw new TargetScanAwsFailure(code)
}

/**
 * Creates one public fixed-error source Scan boundary failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Secret-free source Scan failure.
 */
function createSourceScanAwsBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search source Scan read stopped safely (${code}).`,
  )
}

/**
 * Creates one public fixed-error target Scan boundary failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Secret-free target Scan failure.
 */
function createTargetScanAwsBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search target Scan read stopped safely (${code}).`,
  )
}

/**
 * Creates a stable failure after close or generation invalidation.
 *
 * @returns Secret-free invalid-state failure.
 */
function inactiveManagedIdentityPort(): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    'INVALID_STATE',
    'Workspace Search migration AWS session is no longer active.',
  )
}

/**
 * Creates a stable failure for a control-plane read outside reviewed resources.
 *
 * @returns Secret-free invalid-argument failure.
 */
function invalidIdentityLookup(): WorkspaceSearchMigrationFailure {
  return createWorkspaceSearchMigrationIdentityAdapterFailure(
    'OUT_OF_SCOPE_LOOKUP',
  )
}

/**
 * Checks one explicit shared-profile name.
 *
 * @param value - Candidate profile name.
 * @returns Whether the profile name is bounded and path-free.
 */
function isSafeProfileName(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
}

/**
 * Checks an IAM role ARN accepted for one explicit assume-role hop.
 *
 * @param value - Candidate role ARN.
 * @returns Whether the value is a bounded AWS-partition IAM role ARN.
 */
function isIamRoleArn(value: unknown): value is string {
  return typeof value === 'string' &&
    /^arn:aws(?:-[a-z0-9-]+)?:iam::[0-9]{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]{1,64}$/.test(
      value,
    )
}

/**
 * Checks an explicit STS role-session name.
 *
 * @param value - Candidate role-session name.
 * @returns Whether the value satisfies STS length and character rules.
 */
function isRoleSessionName(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9_+=,.@-]{2,64}$/.test(value)
}

/**
 * Checks non-empty text without normalizing the AWS response.
 *
 * @param value - Candidate response field.
 * @returns Whether the field contains non-whitespace text.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
