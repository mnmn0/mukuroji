import { types as nodeUtilTypes } from 'node:util'
import {
  DescribeContinuousBackupsCommand,
  type DescribeContinuousBackupsCommandOutput,
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  DescribeTimeToLiveCommand,
  type DescribeTimeToLiveCommandOutput,
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandOutput,
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
  createWorkspaceSearchConfigurationHash,
  isWorkspaceSearchMigrationFailureCode,
  requireMigrationIdentifier,
  type DynamoAttributeMap,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
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
  type WorkspaceSearchMigrationSharedProfiles,
  loadWorkspaceSearchMigrationSharedProfiles,
} from './migration-shared-profile-loader'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
} from './maintenance-evidence'
import {
  createAwsWorkspaceSearchMigrationApplicationWriterFencePort,
  type WorkspaceSearchMigrationApplicationWriterFenceAwsPort,
} from './migration-application-writer-fence-aws'
import {
  createAwsWorkspaceSearchMigrationPrePlanAuthorityPort,
  type RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
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
import {
  createWorkspaceSearchMigrationSourceEvidenceProgressDigest,
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
  type WorkspaceSearchMigrationImmutableArtifactAwsPort,
  type WorkspaceSearchMigrationImmutableArtifactAwsTransport,
} from './migration-immutable-artifact-aws'
import type {
  WorkspaceSearchMigrationPlanningJoinLimits,
  WorkspaceSearchMigrationPlanningMaterialReadLimits,
  WorkspaceSearchMigrationPlanningSourceChainMaterial,
  WorkspaceSearchMigrationPlanningTargetChainMaterial,
} from './migration-planning-material'
import {
  createAwsWorkspaceSearchMigrationPlanningArtifactGateway,
  type WorkspaceSearchMigrationPlanningArtifactAwsGateway,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_ARTIFACT_MAX_OBJECT_BYTES,
} from './migration-planning-artifact-aws'
import {
  createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsTransport,
} from './migration-sealed-planning-authority-aws'
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

/** Hard deadline for one immutable migration-artifact S3 SDK request. */
const MIGRATION_ARTIFACT_TIMEOUT_MILLISECONDS = 10_000

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
 * Composite measured AWS session for identity, source/target reads, authority
 * I/O, and immutable planning artifact storage.
 */
export interface WorkspaceSearchMigrationManagedAwsSession
  extends
    WorkspaceSearchMigrationManagedIdentityPort,
    WorkspaceSearchMigrationPrePlanAuthorityAwsPort {
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
   * @returns Bound cumulative checkpoint and detached row evidence.
   */
  scanTargetPage(
    input: WorkspaceSearchMigrationTargetScanReadInput,
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
   * Creates one generation-bound application writer-fence operator port.
   *
   * @returns Writer-fence operator port bound to the latest measurement.
   */
  createApplicationWriterFencePort():
    WorkspaceSearchMigrationApplicationWriterFenceAwsPort
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
   * @returns DynamoDB table metadata response.
   */
  describeTable(command: DescribeTableCommand): Promise<DescribeTableCommandOutput>
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

/** AWS SDK transport exposing only allowlisted measured migration operations. */
class AwsSdkWorkspaceSearchMigrationIdentityTransport
  implements WorkspaceSearchMigrationManagedAwsTransport {
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
   * @returns DynamoDB table metadata response.
   */
  describeTable(command: DescribeTableCommand): Promise<DescribeTableCommandOutput> {
    return this.dynamodbClient.send(command)
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
   * @returns Raw low-level DynamoDB page.
   */
  scanTarget(command: ScanCommand): Promise<ScanCommandOutput> {
    return this.dynamodbClient.send(command)
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
      MIGRATION_ARTIFACT_TIMEOUT_MILLISECONDS,
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
   * @returns STS caller response.
   */
  getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    return this.stsClient.send(command)
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

  /** Adapter-owned trusted clock for pre-plan authority transitions. */
  private readonly prePlanAuthorityClock:
    WorkspaceSearchMigrationPrePlanAuthorityClock

  /** Whether this managed session has permanently released its clients. */
  private closed = false

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
   * Whether an uncertain writer-fence commit quarantined this measurement.
   */
  private measuredApplicationWriterFenceQuarantined = false

  /**
   * Creates a port bound to immutable copies of the reviewed resources.
   *
   * @param requested - Validated operator-selected resources.
   * @param transport - Allowlisted AWS command transport.
   * @param prePlanAuthorityClock - Trusted clock captured by authority commits.
   */
  constructor(
    requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
    transport: WorkspaceSearchMigrationManagedAwsTransport,
    prePlanAuthorityClock:
      WorkspaceSearchMigrationPrePlanAuthorityClock,
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
  }

  /**
   * Releases every AWS SDK client owned by the transport.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.generation += 1
    this.measuredConfigurationHash = undefined
    this.measuredConfiguration = undefined
    this.invalidateManagedPlanningArtifactPort()
    this.measuredMigrationStateTable = undefined
    this.measuredApplicationWriterFenceQuarantined = false
    try {
      this.transport.close()
    } catch {
      // The session remains closed even if an injected transport cannot clean up.
    }
  }

  /**
   * Measures identity against the same snapshot that configured every client
   * and lookup allowlist.
   *
   * @returns Exact measured migration configuration.
   */
  async measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration> {
    this.requireOpen()
    this.generation += 1
    const measurementGeneration = this.generation
    this.measuredConfigurationHash = undefined
    this.measuredConfiguration = undefined
    this.invalidateManagedPlanningArtifactPort()
    this.measuredMigrationStateTable = undefined
    this.measuredApplicationWriterFenceQuarantined = false
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
          this.runManagedPlanningArtifactOperation(
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
          this.runManagedPlanningArtifactOperation(
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
          this.runManagedPlanningArtifactOperation(
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
          this.runManagedPlanningArtifactOperation(
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
   * Creates one application writer-fence operator port bound to the current
   * measured generation and all six physical table incarnations.
   *
   * @returns Generation-guarded application writer-fence operator port.
   */
  createApplicationWriterFencePort():
    WorkspaceSearchMigrationApplicationWriterFenceAwsPort {
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
          delegate.bootstrapOpen(currentAuthority),
        ),
      read: () =>
        this.runManagedApplicationWriterFenceOperation(
          authority,
          delegate.read(),
        ),
      close: (
        currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
      ) =>
        this.runManagedApplicationWriterFenceOperation(
          authority,
          delegate.close(currentAuthority),
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
    const prepared = await runSourceScanAwsBoundary(async () => {
      this.requireOpen()
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
    return {
      page: prepared.reductionInput.page,
      pageResult: reduceWorkspaceSearchMigrationSourceScanPage(
        prepared.reductionInput,
      ),
    }
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
   * @returns Bound cumulative checkpoint and detached row evidence.
   */
  async scanTargetPage(
    input: WorkspaceSearchMigrationTargetScanReadInput,
  ): Promise<WorkspaceSearchMigrationTargetScanPageResult> {
    const captured = await this.captureTargetPage(input)
    return captured.pageResult
  }

  /**
   * Captures one normalized raw target page and reduces those exact same items.
   *
   * The private primitive keeps the raw page inside the managed session so a
   * later durable artifact gateway can reuse it without issuing a second Scan.
   *
   * @param input - Measured target context and durable predecessor checkpoint.
   * @returns Detached raw page paired with its exact digest-only reduction.
   */
  private async captureTargetPage(
    input: WorkspaceSearchMigrationTargetScanReadInput,
  ): Promise<CapturedManagedTargetScanPage> {
    const prepared = await runTargetScanAwsBoundary(async () => {
      this.requireOpen()
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
      )
      this.requireMeasurementGeneration(
        scanGeneration,
        authorizedConfigurationHash,
      )
      let output: ScanCommandOutput
      try {
        output = await this.transport.scanTarget(new ScanCommand({
          TableName: this.requested.tables['workspace-search'],
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
      await this.requireCurrentTargetTableIncarnation(
        context.table,
        scanGeneration,
        authorizedConfigurationHash,
      )
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
    return {
      page: prepared.reductionInput.page,
      pageResult: reduceWorkspaceSearchMigrationTargetScanPage(
        prepared.reductionInput,
      ),
    }
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
    return runManagedPrePlanAuthorityAwsBoundary(async () => {
      const request: AcquireWorkspaceSearchMigrationLeaseInput = {
        runId: input.runId,
        ownerId: input.ownerId,
      }
      return this.runPrePlanAuthorityOperation(
        (adapter) => adapter.acquireLease(request),
      )
    })
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
    return runManagedPrePlanAuthorityAwsBoundary(async () => {
      const request: HeartbeatWorkspaceSearchMigrationLeaseInput = {
        lease: this.snapshotPrePlanLeaseClaim(input.lease),
      }
      return this.runPrePlanAuthorityOperation(
        (adapter) => adapter.heartbeatLease(request),
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
   * @returns Detached authority result while measurement remains current.
   */
  private async runPrePlanAuthorityOperation<Result>(
    operation: (
      adapter: WorkspaceSearchMigrationPrePlanAuthorityAwsPort,
    ) => Promise<Result>,
  ): Promise<Result> {
    const authority = this.captureManagedMigrationStateAuthority()
    await this.requireCurrentMigrationStateTableIncarnation(authority)
    const adapter = this.createManagedPrePlanAuthorityAdapter(authority)
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
  }

  /**
   * Creates an ephemeral authority adapter on the measured DynamoDB client.
   *
   * @param authority - Current generation, configuration, and state identity.
   * @returns Pre-plan authority adapter guarded around every state operation.
   */
  private createManagedPrePlanAuthorityAdapter(
    authority: ManagedMigrationStateAuthority,
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
    return this.runSourceEvidenceOperation(
      input,
      (adapter, request) => adapter.commitNextPage(request),
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
    return runManagedSourceEvidenceAwsBoundary(async () => {
      const authority = this.captureSourceEvidenceAuthority(input)
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      const adapter = this.createManagedSourceEvidenceAdapter(authority)
      let result: Result
      try {
        result = await operation(adapter, authority.request)
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
   * Captures the migration-state authority installed by the latest measurement.
   *
   * @returns Detached generation, configuration hash, and state incarnation.
   */
  private captureManagedMigrationStateAuthority():
    ManagedMigrationStateAuthority {
    this.requireOpen()
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
    this.requireOpen()
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
   * @returns Adapter composed from this session's scanner and DynamoDB client.
   */
  private createManagedSourceEvidenceAdapter(
    authority: ManagedSourceEvidenceAuthority,
  ): WorkspaceSearchMigrationSourceEvidenceAwsPort {
    let writePrepared = false
    const sourceArtifactTransport:
      WorkspaceSearchMigrationSourceArtifactAwsTransport = {
        putSourceArtifact: (command) =>
          this.runManagedMigrationStateIo(
            authority,
            () => this.transport.putSourceArtifact(command),
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
        return this.runManagedPreparedMigrationStateWrite(
          authority,
          () => this.transport.transactWriteSourceEvidence(command),
        )
      },
    }
    return createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTable: authority.stateTable,
      scanner,
      planningArtifactGateway,
      transport,
      clock: this.prePlanAuthorityClock,
    })
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
    return this.runTargetEvidenceOperation(
      input,
      (adapter, request) => adapter.commitNextPage(request),
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
    return runManagedTargetEvidenceAwsBoundary(async () => {
      const authority = this.captureTargetEvidenceAuthority(input)
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      const adapter = this.createManagedTargetEvidenceAdapter(authority)
      let result: Result
      try {
        result = await operation(adapter, authority.request)
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
    this.requireOpen()
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
   * @returns Adapter composed from one private raw-page gateway and AWS clients.
   */
  private createManagedTargetEvidenceAdapter(
    authority: ManagedTargetEvidenceAuthority,
  ): WorkspaceSearchMigrationTargetEvidenceAwsPort {
    let writePrepared = false
    const targetArtifactTransport:
      WorkspaceSearchMigrationTargetArtifactAwsTransport = {
        putTargetArtifact: (command) =>
          this.runManagedMigrationStateIo(
            authority,
            () => this.transport.putTargetArtifact(command),
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
        return this.runManagedPreparedMigrationStateWrite(
          authority,
          () => this.transport.transactWriteTargetEvidence(command),
        )
      },
    }
    return createAwsWorkspaceSearchMigrationTargetEvidencePort({
      stateTable: authority.stateTable,
      planningArtifactGateway,
      transport,
      clock: this.prePlanAuthorityClock,
    })
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
    return runManagedPlanningJoinAwsBoundary(async () => {
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
        return result
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
    const adapter = this.createManagedSourceEvidenceAdapter({
      generation: authority.generation,
      configurationHash: authority.configurationHash,
      stateTable: authority.stateTable,
      request,
    })
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
    const adapter = this.createManagedTargetEvidenceAdapter({
      generation: authority.generation,
      configurationHash: authority.configurationHash,
      stateTable: authority.stateTable,
      request,
    })
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
          () => this.transport.putImmutableArtifact(
            command,
            abortSignal,
          ),
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
        MIGRATION_ARTIFACT_TIMEOUT_MILLISECONDS,
      bodyTimeoutMilliseconds:
        MIGRATION_ARTIFACT_TIMEOUT_MILLISECONDS,
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
    this.requireManagedSealedPlanningAuthority(authority)
    try {
      const result = await operation()
      this.requireManagedSealedPlanningAuthority(authority)
      return result
    } catch (error: unknown) {
      this.requireManagedSealedPlanningAuthority(authority)
      throw error
    }
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
   */
  private async requireCurrentSealedPlanningAuthorityTableIncarnations(
    authority: ManagedSealedPlanningAuthority,
  ): Promise<void> {
    try {
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      for (const source of workspaceSearchMigrationSourceNames) {
        await this.requireCurrentSourceTableIncarnation(
          authority.configuration.tables[source],
          authority.generation,
          authority.configurationHash,
        )
      }
      await this.requireCurrentTargetTableIncarnation(
        authority.configuration.tables['workspace-search'],
        authority.generation,
        authority.configurationHash,
      )
    } catch (error: unknown) {
      throw createManagedSealedPlanningAuthorityFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
    this.requireManagedSealedPlanningAuthority(authority)
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
    let result: Result
    try {
      result = await this.runManagedMigrationStateIo(
        authority,
        operation,
      )
    } catch (error: unknown) {
      this.requireManagedSealedPlanningAuthority(authority)
      await this.requireCurrentSealedPlanningAuthorityTableIncarnations(
        authority,
      )
      throw error
    }
    await this.requireCurrentSealedPlanningAuthorityTableIncarnations(
      authority,
    )
    return result
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
      this.measuredApplicationWriterFenceQuarantined
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
   * The operation promise is created before this asynchronous wrapper is
   * entered. That preserves the adapter's synchronous input detachment before
   * its first guarded transport await.
   *
   * @param authority - Captured measured writer-fence authority.
   * @param operation - Already-started adapter operation over detached input.
   * @returns Result only while the captured measurement remains authoritative.
   */
  private async runManagedApplicationWriterFenceOperation<Result>(
    authority: ManagedApplicationWriterFenceAuthority,
    operation: Promise<Result>,
  ): Promise<Result> {
    try {
      const result = await operation
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
      this.measuredApplicationWriterFenceQuarantined
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
   */
  private async requireCurrentApplicationWriterFenceTableIncarnations(
    authority: ManagedApplicationWriterFenceAuthority,
  ): Promise<void> {
    this.requireManagedApplicationWriterFenceAuthority(authority)
    try {
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      for (const source of workspaceSearchMigrationSourceNames) {
        await this.requireCurrentSourceTableIncarnation(
          authority.configuration.tables[source],
          authority.generation,
          authority.configurationHash,
        )
      }
      await this.requireCurrentTargetTableIncarnation(
        authority.configuration.tables['workspace-search'],
        authority.generation,
        authority.configurationHash,
      )
    } catch (error: unknown) {
      throw createManagedApplicationWriterFenceFailure(
        readManagedMigrationStateFailureCode(error),
      )
    }
    this.requireManagedApplicationWriterFenceAuthority(authority)
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
    this.requireManagedApplicationWriterFenceAuthority(authority)
    let result: Result
    try {
      result = await this.runManagedMigrationStateIo(authority, operation)
    } catch (error: unknown) {
      try {
        await this.requireCurrentApplicationWriterFenceTableIncarnations(
          authority,
        )
      } catch (guardError: unknown) {
        this.quarantineManagedApplicationWriterFence(authority)
        throw guardError
      }
      throw error
    }
    try {
      await this.requireCurrentApplicationWriterFenceTableIncarnations(
        authority,
      )
    } catch (error: unknown) {
      this.quarantineManagedApplicationWriterFence(authority)
      throw error
    }
    return result
  }

  /**
   * Permanently quarantines one still-current measured writer-fence generation.
   *
   * @param authority - Generation whose commit outcome became uncertain.
   */
  private quarantineManagedApplicationWriterFence(
    authority: ManagedApplicationWriterFenceAuthority,
  ): void {
    if (
      this.isMeasurementGenerationCurrent(
        authority.generation,
        authority.configurationHash,
      )
    ) {
      this.measuredApplicationWriterFenceQuarantined = true
    }
  }

  /**
   * Captures the private immutable port installed by current measurement.
   *
   * @returns Current generation, configuration hash, and private object port.
   */
  private captureManagedPlanningArtifactAuthority():
    ManagedPlanningArtifactAuthority {
    this.requireOpen()
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
    try {
      const result = await this.runManagedMigrationStateIo(
        authority,
        operation,
      )
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      return result
    } catch (error: unknown) {
      this.requireMeasurementGeneration(
        authority.generation,
        authority.configurationHash,
      )
      await this.requireCurrentMigrationStateTableIncarnation(authority)
      throw error
    }
  }

  /**
   * Revalidates the measured migration-state table around managed state I/O.
   *
   * @param authority - Captured generation, hash, and state-table incarnation.
   */
  private async requireCurrentMigrationStateTableIncarnation(
    authority: ManagedMigrationStateAuthority,
  ): Promise<void> {
    this.requireMeasurementGeneration(
      authority.generation,
      authority.configurationHash,
    )
    let output: DescribeTableCommandOutput
    try {
      output = await this.transport.describeTable(
        new DescribeTableCommand({
          TableName: authority.stateTable.tableName,
        }),
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
   */
  private async requireCurrentSourceTableIncarnation(
    table: MigrationTableIdentity,
    generation: number,
    configurationHash: string,
  ): Promise<void> {
    this.requireMeasurementGeneration(generation, configurationHash)
    let output: DescribeTableCommandOutput
    try {
      output = await this.transport.describeTable(
        new DescribeTableCommand({ TableName: table.tableName }),
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
   */
  private async requireCurrentTargetTableIncarnation(
    table: MigrationTableIdentity,
    generation: number,
    configurationHash: string,
  ): Promise<void> {
    this.requireMeasurementGeneration(generation, configurationHash)
    let output: DescribeTableCommandOutput
    try {
      output = await this.transport.describeTable(
        new DescribeTableCommand({ TableName: table.tableName }),
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
    this.requireOpen()
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
    this.requireOpen()
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
   * Reads the exact selected table's physical metadata.
   *
   * @param tableName - Operator-selected physical table name.
   * @returns DynamoDB table metadata response.
   */
  async describeTable(tableName: string): Promise<DescribeTableCommandOutput> {
    this.requireOpen()
    this.validateTableName(tableName)
    return this.transport.describeTable(
      new DescribeTableCommand({ TableName: tableName }),
    )
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
    this.requireOpen()
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
    this.requireOpen()
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
    this.requireOpen()
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
    this.requireOpen()
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
    this.requireOpen()
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
    this.requireOpen()
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
   * Requires an asynchronous measurement to remain the current generation.
   *
   * @param generation - Generation captured before identity I/O.
   */
  private requireGeneration(generation: number): void {
    if (this.closed || this.generation !== generation) {
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
  /**
   * Creates one official-endpoint SDK client configuration.
   *
   * @param service - Allowlisted AWS service.
   * @returns Client configuration bound to the resource snapshot.
   */
  const createConfiguration = (
    service: WorkspaceSearchMigrationIdentityAwsService,
  ): WorkspaceSearchMigrationIdentityAwsSdkClientConfiguration => ({
    credentials,
    endpoint: resolveOfficialAwsRegionalEndpoint(service, resources.region),
    profile: resources.profile,
    region: resources.region,
  })
  const configurations: WorkspaceSearchMigrationIdentityAwsSdkConfigurations = {
    dynamodb: createConfiguration('dynamodb'),
    kms: createConfiguration('kms'),
    s3: {
      ...createConfiguration('s3'),
      followRegionRedirects: false,
    },
    sts: createConfiguration('sts'),
  }
  return new AwsWorkspaceSearchMigrationIdentityPort(
    resources,
    transportConstructor(configurations),
    prePlanAuthorityClock,
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
 * @returns Lazy shared-profile credentials provider.
 */
function createPinnedProfileCredentials(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): ReturnType<typeof fromIni> {
  const configuration: WorkspaceSearchMigrationRoleAssumptionConfiguration = {
    endpoint: resolveOfficialAwsRegionalEndpoint('sts', requested.region),
    profile: requested.profile,
    region: requested.region,
  }
  const roleAssumer = createPinnedRoleAssumer(configuration)
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
 * @returns AWS SDK shared-profile role-assumption callback.
 */
function createPinnedRoleAssumer(
  configuration: WorkspaceSearchMigrationRoleAssumptionConfiguration,
): WorkspaceSearchMigrationProfileRoleAssumer {
  return async (sourceCredentials, parameters) => {
    const client = new STSClient({
      ...configuration,
      credentials: sourceCredentials,
    })
    try {
      const output = await client.send(new AssumeRoleCommand(parameters))
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
): WorkspaceSearchMigrationManagedAwsTransport {
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
