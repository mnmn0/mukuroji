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
  GetBucketEncryptionCommand,
  type GetBucketEncryptionOutput,
  GetBucketLoggingCommand,
  type GetBucketLoggingOutput,
  GetBucketVersioningCommand,
  type GetBucketVersioningOutput,
  GetObjectLockConfigurationCommand,
  type GetObjectLockConfigurationOutput,
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
  type DynamoAttributeMap,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
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
  createAwsWorkspaceSearchMigrationPrePlanAuthorityPort,
  type RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsPort,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
  type WorkspaceSearchMigrationPrePlanAuthorityClaim,
  type WorkspaceSearchMigrationPrePlanAuthorityClock,
  type WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
} from './migration-pre-plan-authority-aws'
import {
  createAwsWorkspaceSearchMigrationSourceEvidencePort,
  type WorkspaceSearchMigrationSourceEvidenceAwsPort,
  type WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  type WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  type WorkspaceSearchMigrationSourceEvidenceAwsTransport,
  type WorkspaceSearchMigrationSourceEvidenceScanner,
} from './migration-source-evidence-aws'
import type {
  WorkspaceSearchMigrationSourceEvidenceProgress,
  WorkspaceSearchMigrationSourceEvidenceReplayResult,
} from './migration-source-evidence'
import {
  normalizeWorkspaceSearchMigrationSourceScanOutput,
  type WorkspaceSearchMigrationSourceScanAwsTransport,
  type WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
  type ReduceWorkspaceSearchMigrationSourceScanPageInput,
  type WorkspaceSearchMigrationSourceScanPageResult,
} from './migration-source-scan-page'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
  prepareWorkspaceSearchMigrationSourceScanContext,
} from './migration-source-scan-context'
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
 * Measurement authority captured for one complete source-evidence operation.
 */
type ManagedSourceEvidenceAuthority<
  Request extends WorkspaceSearchMigrationSourceEvidenceAwsRequest =
    WorkspaceSearchMigrationSourceEvidenceAwsRequest,
> = ManagedMigrationStateAuthority & {
  /** Detached complete request that cannot change after authority capture. */
  readonly request: Request
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
 * Composite measured AWS session for identity, source reads, and authority I/O.
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
    WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
    WorkspaceSearchMigrationSourceScanAwsTransport,
    WorkspaceSearchMigrationSourceEvidenceAwsTransport {}

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

  /** Migration-state table incarnation authorized by the current measurement. */
  private measuredMigrationStateTable: MigrationTableIdentity | undefined

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
    this.measuredMigrationStateTable = undefined
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
    this.measuredMigrationStateTable = undefined
    const configuration = await measureWorkspaceSearchMigrationConfiguration({
      requested: this.requested,
      port: this,
    })
    this.requireGeneration(measurementGeneration)
    const configurationHash =
      createWorkspaceSearchConfigurationHash(configuration)
    const stateTable = structuredClone(
      configuration.tables['migration-state'],
    )
    this.requireGeneration(measurementGeneration)
    this.measuredMigrationStateTable = stateTable
    this.measuredConfigurationHash = configurationHash
    return configuration
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
    return reduceWorkspaceSearchMigrationSourceScanPage(
      prepared.reductionInput,
    )
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
        await this.requireCurrentMigrationStateTableIncarnation(authority)
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
      transport,
      clock: this.prePlanAuthorityClock,
    })
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
 * @returns AWS SDK transport exposing only managed migration reads.
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
