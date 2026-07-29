import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AttributeValue,
  type AttributeDefinition,
  DescribeContinuousBackupsCommand,
  type DescribeContinuousBackupsCommandOutput,
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  DescribeTimeToLiveCommand,
  type DescribeTimeToLiveCommandOutput,
  GetItemCommand,
  type GetItemCommandOutput,
  type GlobalSecondaryIndexDescription,
  type KeySchemaElement,
  ResourceNotFoundException,
  ScanCommand,
  type ScanCommandOutput,
  type TableDescription,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  DescribeKeyCommand,
  type DescribeKeyCommandOutput,
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
} from '@aws-sdk/client-s3'
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  type GetCallerIdentityCommandOutput,
  STSClient,
} from '@aws-sdk/client-sts'
import {
  createTeamWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchPlanSeal,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTableRole,
  workspaceSearchMigrationSourceNames,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationIdentityPort,
  type JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput,
  type WorkspaceSearchMigrationIdentityAwsSdkConfigurations,
  type WorkspaceSearchMigrationManagedAwsTransport,
  type WorkspaceSearchMigrationManagedAwsSession,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_CANONICAL_BYTES,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_OPERATIONS,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_TOTAL_ROWS,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  type WorkspaceSearchMigrationJournalLookup,
  type WorkspaceSearchMigrationRequestedResources,
  validateWorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import type {
  WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
} from './migration-source-evidence-aws'
import {
  parseWorkspaceSearchMigrationPlanningSourceArtifactSegment,
} from './migration-source-artifact'
import type {
  WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  WorkspaceSearchMigrationTargetEvidenceAwsRequest,
} from './migration-target-evidence-aws'
import {
  parseWorkspaceSearchMigrationTargetEvidencePage,
} from './migration-target-evidence'
import {
  parseWorkspaceSearchMigrationPlanningTargetArtifactSegment,
} from './migration-target-artifact'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  workspaceSearchMigrationExecutionRunTransactionIndex,
} from './migration-execution-run-aws'
import type {
  WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  type WorkspaceSearchMigrationApplyOperationAwsPort,
  workspaceSearchMigrationApplyCheckpointTransactionIndex,
} from './migration-apply-operation-aws'
import type {
  PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
} from './migration-sealed-planning-authority-aws'
import {
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import type {
  WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import type {
  WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import type {
  WorkspaceSearchMigrationTargetScanReadInput,
} from './migration-target-scan-aws'
import {
  createEmptyWorkspaceSearchMigrationTargetScanCheckpoint,
  type WorkspaceSearchMigrationTargetScanCheckpoint,
} from './migration-target-scan-context'
import {
  reduceWorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'
import {
  createEmptyWorkspaceSearchMigrationCheckpoint,
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchPlanLeafDigest,
  type WorkspaceSearchApplyOperationCommandEvent,
  type WorkspaceSearchMigrationCheckpointCommandInput,
  type WorkspaceSearchMigrationCommandInput,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
  maintenanceRuntimeControlSurfaces,
} from './maintenance-evidence'

const TEST_ACCOUNT = '123456789012'
const TEST_REGION = 'ap-northeast-1'
const TEST_PROFILE = 'production-operations'
const TEST_BUCKET = 'mukuroji-migration-journal-production'
const TEST_KEY_ID = '12345678-abcd-4321-abcd-1234567890ab'
const TEST_ROLE_ID = 'AROA1234567890ABCDEFG'
const TEST_SESSION_NAME = 'migration-session'

/** Partition-specific endpoint expectation used by one construction test. */
type EndpointCase = {
  /** Explicit AWS region. */
  readonly region: string
  /** Expected official DNS suffix. */
  readonly suffix: string
}

/** AWS endpoint override variables that must not redirect migration clients. */
type EndpointVariableName =
  | 'AWS_ENDPOINT_URL'
  | 'AWS_ENDPOINT_URL_DYNAMODB'
  | 'AWS_ENDPOINT_URL_KMS'
  | 'AWS_ENDPOINT_URL_S3'
  | 'AWS_ENDPOINT_URL_STS'

/** Unsupported shared-profile fixture that must fail before side effects. */
type UnsupportedProfileCase = {
  /** Human-readable mechanism label. */
  readonly name: string
  /** One unsupported INI entry placed under an otherwise valid profile. */
  readonly entry: string
}

/** Schema and safety settings used by one valid measurement fixture table. */
type MeasurementTableSchemaFixture = {
  /** DynamoDB scalar attribute definitions. */
  readonly attributeDefinitions: readonly AttributeDefinition[]
  /** Base-table key schema. */
  readonly keySchema: readonly KeySchemaElement[]
  /** Exact global secondary indexes. */
  readonly globalSecondaryIndexes: readonly GlobalSecondaryIndexDescription[]
  /** TTL attribute, or undefined when TTL is disabled. */
  readonly ttlAttribute: string | undefined
  /** Whether the table uses a customer-managed KMS key. */
  readonly kmsEncrypted: boolean
  /** Whether deletion protection is enabled. */
  readonly deletionProtection: boolean
}

/** Deferred Scan response controlled by one managed-session lifecycle test. */
type DeferredScanOutput = {
  /** Promise returned by the recording transport. */
  readonly promise: Promise<ScanCommandOutput>
  /**
   * Resolves the pending Scan.
   *
   * @param output - Raw response supplied to the managed session.
   */
  readonly resolve: (output: ScanCommandOutput) => void
}

/**
 * One immutable object retained by the recording generic S3 transport.
 */
type RecordedImmutableArtifactObject = {
  /** Exact PutObject command whose body and metadata were stored. */
  readonly command: PutObjectCommand
  /** Stable fake immutable version assigned to the upload. */
  readonly versionId: string
}

/**
 * Cancellable fake streaming body used to detect lifecycle cleanup.
 */
class CancellableImmutableArtifactBody {
  /** Resolves when body consumption first asks for a chunk. */
  readonly nextStarted: Promise<void>

  /** Number of best-effort cancel calls. */
  cancelCount = 0

  /** Number of best-effort destroy calls. */
  destroyCount = 0

  /** Whether the deliberately stalled read has been released. */
  private released = false

  /** Resolves the body-consumption start notification once. */
  private resolveNextStarted: (() => void) | undefined

  /** Resolves the current deliberately stalled iterator read. */
  private resolvePendingRead:
    ((result: IteratorResult<Uint8Array, undefined>) => void) | undefined

  /**
   * Creates one controllable streaming body.
   */
  constructor() {
    this.nextStarted = new Promise((resolve) => {
      this.resolveNextStarted = resolve
    })
  }

  /**
   * Returns this controlled body as its async iterator.
   *
   * @returns This async iterator.
   */
  [Symbol.asyncIterator](): CancellableImmutableArtifactBody {
    return this
  }

  /**
   * Starts one deliberately stalled body read.
   *
   * @returns Pending iterator result until cancellation or explicit release.
   */
  next(): Promise<IteratorResult<Uint8Array, undefined>> {
    this.resolveNextStarted?.()
    this.resolveNextStarted = undefined
    if (this.released) {
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve) => {
      this.resolvePendingRead = resolve
    })
  }

  /** Releases the pending body read without wall-clock timing. */
  releasePendingRead(): void {
    this.released = true
    const resolve = this.resolvePendingRead
    this.resolvePendingRead = undefined
    resolve?.({ done: true, value: undefined })
  }

  /** Records one body cancellation. */
  cancel(): void {
    this.cancelCount += 1
    this.releasePendingRead()
  }

  /** Records one body destruction. */
  destroy(): void {
    this.destroyCount += 1
    this.releasePendingRead()
  }
}

/**
 * Complete terminal five-chain fixture for one managed planning join test.
 */
type ManagedCommittedPlanningFixture = {
  /** Operator-requested physical resources measured by the session. */
  readonly requested: WorkspaceSearchMigrationRequestedResources
  /** Measured managed session owning all five evidence chains. */
  readonly port: WorkspaceSearchMigrationManagedAwsSession
  /** In-memory allowlisted transport recording exact managed I/O. */
  readonly transport: RecordingIdentityAwsTransport
  /** Fresh durable authority owning the committed planning evidence. */
  readonly authority: WorkspaceSearchMigrationPrePlanAuthority
  /** Detached public read-only join input. */
  readonly input:
    JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput
}

/**
 * Complete immutable planning graph ready for managed sealed publication.
 */
type ManagedSealedPublicationFixture = {
  /** Operator-requested physical resources measured by the session. */
  readonly requested: WorkspaceSearchMigrationRequestedResources
  /** Measured managed session owning the immutable graph. */
  readonly port: WorkspaceSearchMigrationManagedAwsSession
  /** In-memory allowlisted transport recording exact managed I/O. */
  readonly transport: RecordingIdentityAwsTransport
  /** Strict publication input assembled from real committed evidence. */
  readonly publishInput:
    PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input
  /** Optional single planned operation stored by an apply fixture. */
  readonly plannedOperation:
    WorkspaceSearchPlannedOperation | undefined
}

/**
 * Material exposed before managed planning evidence is committed.
 */
type ManagedPlanningAuthorityPreparationContext = {
  /** Measured managed session owning planning and execution control. */
  readonly port: WorkspaceSearchMigrationManagedAwsSession
  /** Recording transport shared by the complete managed session. */
  readonly transport: RecordingIdentityAwsTransport
  /** Exact measured configuration used by later planning evidence. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Initial fresh authority created before planning begins. */
  readonly authority: WorkspaceSearchMigrationPrePlanAuthority
}

/**
 * Optional execution-control preparation before planning evidence writes.
 */
type ManagedPlanningAuthorityPreparation = (
  context: ManagedPlanningAuthorityPreparationContext,
) => Promise<WorkspaceSearchMigrationPrePlanAuthority>

/**
 * Complete managed execution-run admission fixture.
 */
type ManagedExecutionRunFixture = {
  /** Operator-requested physical resources measured by the session. */
  readonly requested: WorkspaceSearchMigrationRequestedResources
  /** Measured managed session owning execution admission. */
  readonly port: WorkspaceSearchMigrationManagedAwsSession
  /** Recording transport shared by every execution-control operation. */
  readonly transport: RecordingIdentityAwsTransport
  /** Fresh current authority used by execution-run creation. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Exact revision-two planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning-authority root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact plan seal referenced by the sealed root. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Exact closed writer-fence row fixed by the boundary. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Optional single operation admitted for managed apply tests. */
  readonly plannedOperation:
    WorkspaceSearchPlannedOperation | undefined
}

/**
 * Complete managed apply-operation fixture with one admitted operation.
 */
type ManagedApplyOperationFixture = ManagedExecutionRunFixture & {
  /** Exact immutable execution admission consumed by the apply port. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact single planned operation admitted by the sealed plan. */
  readonly plannedOperation: WorkspaceSearchPlannedOperation
}

/** Allowlisted command recorder used without AWS credentials or network access. */
class RecordingIdentityAwsTransport
  implements WorkspaceSearchMigrationManagedAwsTransport {
  /** Recorded DynamoDB recovery-state commands. */
  readonly continuousBackupsCommands: DescribeContinuousBackupsCommand[] = []

  /** Opt-in DynamoDB recovery-state outputs keyed by physical table name. */
  readonly continuousBackupsOutputs =
    new Map<string, DescribeContinuousBackupsCommandOutput>()

  /** Recorded KMS key metadata commands. */
  readonly describeKeyCommands: DescribeKeyCommand[] = []

  /** Recorded DynamoDB table metadata commands. */
  readonly describeTableCommands: DescribeTableCommand[] = []

  /** Opt-in DynamoDB table outputs keyed by physical table name. */
  readonly describeTableOutputs = new Map<string, DescribeTableCommandOutput>()

  /** Optional raw table-description failures keyed by physical table name. */
  readonly describeTableFailures = new Map<string, unknown>()

  /** Optional synchronous effect after recording one table description. */
  describeTableEffect: ((tableName: string) => void) | undefined

  /** Recorded DynamoDB TTL commands. */
  readonly describeTimeToLiveCommands: DescribeTimeToLiveCommand[] = []

  /** Opt-in DynamoDB TTL outputs keyed by physical table name. */
  readonly describeTimeToLiveOutputs =
    new Map<string, DescribeTimeToLiveCommandOutput>()

  /** Recorded DynamoDB source Scan commands. */
  readonly scanSourceCommands: ScanCommand[] = []

  /** Recorded DynamoDB target Scan commands. */
  readonly scanTargetCommands: ScanCommand[] = []

  /** Recorded strongly consistent source-evidence point reads. */
  readonly getSourceEvidenceCommands: GetItemCommand[] = []

  /** Recorded atomic source-evidence page/head transactions. */
  readonly transactWriteSourceEvidenceCommands:
    TransactWriteItemsCommand[] = []

  /** Recorded strongly consistent target-evidence point reads. */
  readonly getTargetEvidenceCommands: GetItemCommand[] = []

  /** Recorded atomic target-evidence page/head transactions. */
  readonly transactWriteTargetEvidenceCommands:
    TransactWriteItemsCommand[] = []

  /** Recorded strongly consistent pre-plan authority point reads. */
  readonly getPrePlanAuthorityCommands: GetItemCommand[] = []

  /** Recorded atomic pre-plan authority transactions. */
  readonly transactWritePrePlanAuthorityCommands:
    TransactWriteItemsCommand[] = []

  /** Number of low-level authority write preparations. */
  preparePrePlanAuthorityWriteCount = 0

  /** Number of low-level source-evidence write preparations. */
  prepareSourceEvidenceWriteCount = 0

  /** Number of low-level target-evidence write preparations. */
  prepareTargetEvidenceWriteCount = 0

  /** Durable fake source-evidence items keyed by recordKey. */
  private readonly sourceEvidenceItems =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Durable fake target-evidence items keyed by recordKey. */
  private readonly targetEvidenceItems =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Durable fake pre-plan authority items keyed by recordKey. */
  private readonly prePlanAuthorityItems =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Optional synchronous effect after recording an evidence point read. */
  getSourceEvidenceEffect: (() => void) | undefined

  /** Optional synchronous effect after recording an evidence transaction. */
  transactWriteSourceEvidenceEffect: (() => void) | undefined

  /** Optional synchronous effect during evidence write preparation. */
  prepareSourceEvidenceWriteEffect: (() => void) | undefined

  /** Optional synchronous effect after one target-evidence point read. */
  getTargetEvidenceEffect: (() => void) | undefined

  /** Optional synchronous effect after one target-evidence transaction. */
  transactWriteTargetEvidenceEffect: (() => void) | undefined

  /** Optional synchronous effect during target-evidence write preparation. */
  prepareTargetEvidenceWriteEffect: (() => void) | undefined

  /** Optional synchronous effect during authority write preparation. */
  preparePrePlanAuthorityWriteEffect: (() => void) | undefined

  /** Optional synchronous effect after recording an authority point read. */
  getPrePlanAuthorityEffect: (() => void) | undefined

  /** Optional apply-specific output selected before record-key lookup. */
  getPrePlanAuthorityApplyOutput:
    ((command: GetItemCommand) =>
      GetItemCommandOutput | undefined) | undefined

  /** Optional synchronous effect after recording an authority transaction. */
  transactWritePrePlanAuthorityEffect: (() => void) | undefined

  /** Optional synchronous effect after durable authority Put installation. */
  transactWritePrePlanAuthorityPostCommitEffect:
    (() => void) | undefined

  /** Recorded S3 bucket-encryption commands. */
  readonly getBucketEncryptionCommands: GetBucketEncryptionCommand[] = []

  /** Recorded S3 bucket-logging commands. */
  readonly getBucketLoggingCommands: GetBucketLoggingCommand[] = []

  /** Recorded S3 bucket-versioning commands. */
  readonly getBucketVersioningCommands: GetBucketVersioningCommand[] = []

  /** Recorded STS caller-identity commands. */
  readonly getCallerIdentityCommands: GetCallerIdentityCommand[] = []

  /** Recorded S3 Object Lock commands. */
  readonly getObjectLockConfigurationCommands:
    GetObjectLockConfigurationCommand[] = []

  /** Recorded immutable source-artifact uploads. */
  readonly putSourceArtifactCommands: PutObjectCommand[] = []

  /** Recorded source-artifact reconciliation metadata reads. */
  readonly headSourceArtifactCommands: HeadObjectCommand[] = []

  /** Recorded exact-version source-artifact object reads. */
  readonly getSourceArtifactCommands: GetObjectCommand[] = []

  /** Uploaded source-artifact commands keyed by immutable object key. */
  private readonly sourceArtifactPutCommandsByKey =
    new Map<string, PutObjectCommand>()

  /** Recorded codec-agnostic immutable object uploads. */
  readonly putImmutableArtifactCommands: PutObjectCommand[] = []

  /** Core-owned abort signals received by immutable object uploads. */
  readonly putImmutableArtifactAbortSignals: AbortSignal[] = []

  /** Recorded codec-agnostic immutable object metadata reads. */
  readonly headImmutableArtifactCommands: HeadObjectCommand[] = []

  /** Core-owned abort signals received by immutable metadata reads. */
  readonly headImmutableArtifactAbortSignals: AbortSignal[] = []

  /** Recorded exact-version codec-agnostic immutable object reads. */
  readonly getImmutableArtifactCommands: GetObjectCommand[] = []

  /** Core-owned abort signals received by immutable object reads. */
  readonly getImmutableArtifactAbortSignals: AbortSignal[] = []

  /** Generic immutable objects keyed by exact content-addressed object key. */
  private readonly immutableArtifactObjectsByKey =
    new Map<string, RecordedImmutableArtifactObject>()

  /** Recorded immutable target-artifact uploads. */
  readonly putTargetArtifactCommands: PutObjectCommand[] = []

  /** Recorded target-artifact reconciliation metadata reads. */
  readonly headTargetArtifactCommands: HeadObjectCommand[] = []

  /** Recorded exact-version target-artifact object reads. */
  readonly getTargetArtifactCommands: GetObjectCommand[] = []

  /** Uploaded target-artifact commands keyed by immutable object key. */
  private readonly targetArtifactPutCommandsByKey =
    new Map<string, PutObjectCommand>()

  /** Immutable target-artifact version IDs keyed by object key. */
  private readonly targetArtifactVersionIdsByKey =
    new Map<string, string>()

  /** Number of transport close calls. */
  closeCount = 0

  /** STS response returned by the recording transport. */
  callerIdentityOutput: GetCallerIdentityCommandOutput = {
    $metadata: {},
    Account: TEST_ACCOUNT,
    Arn:
      `arn:aws:sts::${TEST_ACCOUNT}:assumed-role/MigrationOperator/${TEST_SESSION_NAME}`,
    UserId: `${TEST_ROLE_ID}:${TEST_SESSION_NAME}`,
  }

  /** KMS response returned by the recording transport. */
  keyOutput: DescribeKeyCommandOutput = {
    $metadata: {},
    KeyMetadata: {
      Arn: createJournalKeyArn(TEST_REGION),
      AWSAccountId: TEST_ACCOUNT,
      CreationDate: new Date('2026-07-01T00:00:00.000Z'),
      Enabled: true,
      KeyId: TEST_KEY_ID,
      KeyManager: 'CUSTOMER',
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyState: 'Enabled',
      KeyUsage: 'ENCRYPT_DECRYPT',
      MultiRegion: false,
      Origin: 'AWS_KMS',
    },
  }

  /** Optional Object Lock failure returned without adapter wrapping. */
  objectLockFailure?: Error

  /** S3 bucket-encryption response returned by the recording transport. */
  bucketEncryptionOutput: GetBucketEncryptionOutput = {}

  /** S3 server-access-logging response returned by the recording transport. */
  bucketLoggingOutput: GetBucketLoggingOutput = {}

  /** S3 bucket-versioning response returned by the recording transport. */
  bucketVersioningOutput: GetBucketVersioningOutput = {}

  /** S3 Object Lock response returned by the recording transport. */
  objectLockOutput: GetObjectLockConfigurationOutput = {}

  /** Optional synchronous effect after recording a source-artifact upload. */
  putSourceArtifactEffect: (() => void) | undefined

  /** Optional synchronous effect after recording a source-artifact metadata read. */
  headSourceArtifactEffect: (() => void) | undefined

  /** Optional synchronous effect after recording an exact artifact read. */
  getSourceArtifactEffect: (() => void) | undefined

  /** Optional synchronous effect after recording an immutable upload. */
  putImmutableArtifactEffect: (() => void) | undefined

  /** Optional synchronous effect after recording immutable object metadata. */
  headImmutableArtifactEffect: (() => void) | undefined

  /** Optional synchronous effect after recording an exact immutable read. */
  getImmutableArtifactEffect: (() => void) | undefined

  /** Optional fake streaming body returned by generic immutable GetObject. */
  immutableArtifactGetBody: unknown

  /** Optional stored modification time for generic immutable objects. */
  immutableArtifactLastModified: Date | undefined

  /** Optional synchronous effect after recording a target-artifact upload. */
  putTargetArtifactEffect: (() => void) | undefined

  /** Optional synchronous effect after recording target-artifact metadata. */
  headTargetArtifactEffect: (() => void) | undefined

  /** Optional synchronous effect after recording an exact target-artifact read. */
  getTargetArtifactEffect: (() => void) | undefined

  /** Source Scan response returned by the recording transport. */
  scanSourceOutput: ScanCommandOutput = {
    $metadata: {},
    Count: 0,
    Items: [],
    ScannedCount: 0,
  }

  /** Optional raw failure raised by the source Scan transport. */
  scanSourceFailure: unknown

  /** Optional pending Scan response used by lifecycle race tests. */
  scanSourceDeferred: Promise<ScanCommandOutput> | undefined

  /** Optional synchronous effect triggered immediately after recording a Scan. */
  scanSourceEffect: (() => void) | undefined

  /** Target Scan response returned by the recording transport. */
  scanTargetOutput: ScanCommandOutput = {
    $metadata: {},
    Count: 0,
    Items: [],
    ScannedCount: 0,
  }

  /** Optional raw failure raised by the target Scan transport. */
  scanTargetFailure: unknown

  /** Optional pending target Scan response used by lifecycle race tests. */
  scanTargetDeferred: Promise<ScanCommandOutput> | undefined

  /** Optional synchronous effect triggered after recording a target Scan. */
  scanTargetEffect: (() => void) | undefined

  /**
   * Records transport closure.
   */
  close(): void {
    this.closeCount += 1
  }

  /**
   * Records one DynamoDB recovery-state command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response or the legacy empty fallback.
   */
  async describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    this.continuousBackupsCommands.push(command)
    return this.continuousBackupsOutputs.get(command.input.TableName ?? '') ??
      { $metadata: {} }
  }

  /**
   * Records one KMS key metadata command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response.
   */
  async describeKey(command: DescribeKeyCommand): Promise<DescribeKeyCommandOutput> {
    this.describeKeyCommands.push(command)
    return this.keyOutput
  }

  /**
   * Records one DynamoDB table metadata command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response or the legacy empty fallback.
   */
  async describeTable(
    command: DescribeTableCommand,
  ): Promise<DescribeTableCommandOutput> {
    this.describeTableCommands.push(command)
    const tableName = command.input.TableName ?? ''
    this.describeTableEffect?.(tableName)
    const failure = this.describeTableFailures.get(tableName)
    if (failure !== undefined) throw failure
    return this.describeTableOutputs.get(tableName) ??
      { $metadata: {} }
  }

  /**
   * Records one DynamoDB TTL command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response or the legacy empty fallback.
   */
  async describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    this.describeTimeToLiveCommands.push(command)
    return this.describeTimeToLiveOutputs.get(command.input.TableName ?? '') ??
      { $metadata: {} }
  }

  /**
   * Records one source Scan command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response.
   */
  async scanSource(command: ScanCommand): Promise<ScanCommandOutput> {
    this.scanSourceCommands.push(command)
    this.scanSourceEffect?.()
    if (this.scanSourceFailure !== undefined) {
      throw this.scanSourceFailure
    }
    if (this.scanSourceDeferred !== undefined) {
      return await this.scanSourceDeferred
    }
    return this.scanSourceOutput
  }

  /**
   * Records one target Scan command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response.
   */
  async scanTarget(command: ScanCommand): Promise<ScanCommandOutput> {
    this.scanTargetCommands.push(command)
    this.scanTargetEffect?.()
    if (this.scanTargetFailure !== undefined) {
      throw this.scanTargetFailure
    }
    if (this.scanTargetDeferred !== undefined) {
      return await this.scanTargetDeferred
    }
    return this.scanTargetOutput
  }

  /**
   * Records and serves one exact source-evidence point read.
   *
   * @param command - Exact adapter-owned GetItem command.
   * @returns Detached durable item when one exists.
   */
  async getSourceEvidence(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.getSourceEvidenceCommands.push(command)
    this.getSourceEvidenceEffect?.()
    const recordKey = command.input.Key?.recordKey?.S
    if (recordKey === undefined) {
      throw new Error('Expected exact source-evidence record key.')
    }
    const item = this.sourceEvidenceItems.get(recordKey)
    return {
      $metadata: {},
      ...(item === undefined ? {} : { Item: structuredClone(item) }),
    }
  }

  /**
   * Records the low-level no-op preparation owned by the managed wrapper.
   *
   * @returns Completed preparation.
   */
  prepareSourceEvidenceWrite(): Promise<void> {
    this.prepareSourceEvidenceWriteCount += 1
    this.prepareSourceEvidenceWriteEffect?.()
    return Promise.resolve()
  }

  /**
   * Records and atomically installs one immutable page and successor head.
   *
   * This fake intentionally ignores condition expressions and writes both
   * items. CAS behavior is covered by the condition-aware adapter test fake.
   *
   * @param command - Exact adapter-owned TransactWriteItems command.
   * @returns Empty successful transaction response.
   */
  async transactWriteSourceEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.transactWriteSourceEvidenceCommands.push(command)
    this.transactWriteSourceEvidenceEffect?.()
    const entries = command.input.TransactItems
    if (entries?.length !== 2 && entries?.length !== 5) {
      throw new Error(
        'Expected one dry-run or authority-bound source-evidence transaction.',
      )
    }
    if (
      entries.length === 5 &&
      entries.slice(0, 3).some((entry) => entry.ConditionCheck === undefined)
    ) {
      throw new Error('Expected three planning authority condition checks.')
    }
    const pending: {
      /** Exact deterministic evidence record key. */
      readonly recordKey: string
      /** Detached low-level evidence item. */
      readonly item: Readonly<Record<string, AttributeValue>>
    }[] = []
    for (const entry of entries.slice(-2)) {
      const item = entry.Put?.Item
      const recordKey = item?.recordKey?.S
      if (item === undefined || recordKey === undefined) {
        throw new Error('Expected one exact source-evidence Put item.')
      }
      pending.push({
        recordKey,
        item: structuredClone(item),
      })
    }
    for (const entry of pending) {
      this.sourceEvidenceItems.set(entry.recordKey, entry.item)
    }
    return { $metadata: {} }
  }

  /**
   * Deletes the first committed source head to simulate an out-of-band race.
   */
  deleteFirstSourceEvidenceHead(): void {
    for (const recordKey of this.sourceEvidenceItems.keys()) {
      if (recordKey.endsWith('/head')) {
        this.sourceEvidenceItems.delete(recordKey)
        return
      }
    }
    throw new Error('Expected one committed source evidence head.')
  }

  /**
   * Records and serves one exact target-evidence point read.
   *
   * @param command - Exact adapter-owned GetItem command.
   * @returns Detached durable item when one exists.
   */
  async getTargetEvidence(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.getTargetEvidenceCommands.push(command)
    this.getTargetEvidenceEffect?.()
    const recordKey = command.input.Key?.recordKey?.S
    if (recordKey === undefined) {
      throw new Error('Expected exact target-evidence record key.')
    }
    const item = this.targetEvidenceItems.get(recordKey)
    return {
      $metadata: {},
      ...(item === undefined ? {} : { Item: structuredClone(item) }),
    }
  }

  /**
   * Records the target-evidence preparation owned by the managed wrapper.
   *
   * @returns Completed low-level preparation.
   */
  prepareTargetEvidenceWrite(): Promise<void> {
    this.prepareTargetEvidenceWriteCount += 1
    this.prepareTargetEvidenceWriteEffect?.()
    return Promise.resolve()
  }

  /**
   * Records and atomically installs one target evidence page and successor head.
   *
   * The fake checks the fixed planning layout while leaving condition
   * evaluation to the target-evidence adapter tests.
   *
   * @param command - Exact adapter-owned TransactWriteItems command.
   * @returns Empty successful transaction response.
   */
  async transactWriteTargetEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.transactWriteTargetEvidenceCommands.push(command)
    this.transactWriteTargetEvidenceEffect?.()
    const entries = command.input.TransactItems
    if (entries?.length !== 5) {
      throw new Error(
        'Expected one authority-bound target-evidence transaction.',
      )
    }
    if (
      entries.slice(0, 3).some(
        (entry) => entry.ConditionCheck === undefined,
      )
    ) {
      throw new Error('Expected three target planning authority checks.')
    }
    const pending: {
      /** Exact deterministic target-evidence record key. */
      readonly recordKey: string
      /** Detached low-level target-evidence item. */
      readonly item: Readonly<Record<string, AttributeValue>>
    }[] = []
    for (const entry of entries.slice(3)) {
      const item = entry.Put?.Item
      const recordKey = item?.recordKey?.S
      if (item === undefined || recordKey === undefined) {
        throw new Error('Expected one exact target-evidence Put item.')
      }
      pending.push({
        recordKey,
        item: structuredClone(item),
      })
    }
    for (const entry of pending) {
      this.targetEvidenceItems.set(entry.recordKey, entry.item)
    }
    return { $metadata: {} }
  }

  /**
   * Records and serves one exact pre-plan authority point read.
   *
   * @param command - Exact adapter-owned GetItem command.
   * @returns Detached durable item when one exists.
   */
  async getPrePlanAuthority(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.getPrePlanAuthorityCommands.push(command)
    this.getPrePlanAuthorityEffect?.()
    const applyOutput =
      this.getPrePlanAuthorityApplyOutput?.(command)
    if (applyOutput !== undefined) {
      return structuredClone(applyOutput)
    }
    const recordKey = command.input.Key?.recordKey?.S
    if (recordKey === undefined) {
      throw new Error('Expected exact pre-plan authority record key.')
    }
    const item = this.prePlanAuthorityItems.get(recordKey)
    return {
      $metadata: {},
      ...(item === undefined ? {} : { Item: structuredClone(item) }),
    }
  }

  /**
   * Records the low-level no-op preparation owned by the managed wrapper.
   *
   * @returns Completed preparation.
   */
  preparePrePlanAuthorityWrite(): Promise<void> {
    this.preparePrePlanAuthorityWriteCount += 1
    this.preparePrePlanAuthorityWriteEffect?.()
    return Promise.resolve()
  }

  /**
   * Records and atomically installs every pre-plan authority Put item.
   *
   * The condition-aware authority adapter tests own condition semantics. This
   * managed-session fake only proves command routing and atomic item exposure.
   *
   * @param command - Exact adapter-owned transaction command.
   * @returns Empty successful transaction response.
   */
  async transactWritePrePlanAuthority(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.transactWritePrePlanAuthorityCommands.push(command)
    this.transactWritePrePlanAuthorityEffect?.()
    const pending: {
      /** Exact deterministic authority record key. */
      readonly recordKey: string
      /** Detached low-level authority item. */
      readonly item: Readonly<Record<string, AttributeValue>>
    }[] = []
    for (const entry of command.input.TransactItems ?? []) {
      if (entry.Put === undefined) continue
      const item = entry.Put.Item
      const recordKey = item?.recordKey?.S
      if (item === undefined || recordKey === undefined) {
        throw new Error('Expected one exact pre-plan authority Put item.')
      }
      pending.push({
        recordKey,
        item: structuredClone(item),
      })
    }
    if (pending.length === 0) {
      throw new Error('Expected at least one pre-plan authority Put item.')
    }
    for (const entry of pending) {
      this.prePlanAuthorityItems.set(entry.recordKey, entry.item)
    }
    this.transactWritePrePlanAuthorityPostCommitEffect?.()
    return { $metadata: {} }
  }

  /**
   * Records one S3 encryption command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response.
   */
  async getBucketEncryption(
    command: GetBucketEncryptionCommand,
  ): Promise<GetBucketEncryptionOutput> {
    this.getBucketEncryptionCommands.push(command)
    return this.bucketEncryptionOutput
  }

  /**
   * Records one S3 logging command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response.
   */
  async getBucketLogging(
    command: GetBucketLoggingCommand,
  ): Promise<GetBucketLoggingOutput> {
    this.getBucketLoggingCommands.push(command)
    return this.bucketLoggingOutput
  }

  /**
   * Records one S3 versioning command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response.
   */
  async getBucketVersioning(
    command: GetBucketVersioningCommand,
  ): Promise<GetBucketVersioningOutput> {
    this.getBucketVersioningCommands.push(command)
    return this.bucketVersioningOutput
  }

  /**
   * Records one STS caller-identity command.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response.
   */
  async getCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    this.getCallerIdentityCommands.push(command)
    return this.callerIdentityOutput
  }

  /**
   * Records one S3 Object Lock command or raises the configured failure.
   *
   * @param command - Exact command under test.
   * @returns Configured fake response.
   */
  async getObjectLockConfiguration(
    command: GetObjectLockConfigurationCommand,
  ): Promise<GetObjectLockConfigurationOutput> {
    this.getObjectLockConfigurationCommands.push(command)
    if (this.objectLockFailure) {
      throw this.objectLockFailure
    }
    return this.objectLockOutput
  }

  /**
   * Records one codec-agnostic immutable object upload.
   *
   * @param command - Exact adapter-owned PutObject command.
   * @param abortSignal - Core-owned request deadline signal.
   * @returns Configured fake immutable-version response.
   */
  async putImmutableArtifact(
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<PutObjectCommandOutput> {
    this.putImmutableArtifactCommands.push(command)
    this.putImmutableArtifactAbortSignals.push(abortSignal)
    const key = command.input.Key
    if (key === undefined) {
      throw new Error('Expected one immutable artifact object key.')
    }
    const versionId =
      `immutable-artifact-version-${this.putImmutableArtifactCommands.length}`
    this.immutableArtifactObjectsByKey.set(key, {
      command,
      versionId,
    })
    this.putImmutableArtifactEffect?.()
    return {
      $metadata: {},
      VersionId: versionId,
      ChecksumSHA256: command.input.ChecksumSHA256,
      ChecksumType: 'FULL_OBJECT',
      ServerSideEncryption: command.input.ServerSideEncryption,
      SSEKMSKeyId: command.input.SSEKMSKeyId,
      BucketKeyEnabled: command.input.BucketKeyEnabled,
      Size: command.input.ContentLength,
    }
  }

  /**
   * Records one codec-agnostic immutable object metadata read.
   *
   * @param command - Exact adapter-owned HeadObject command.
   * @param abortSignal - Core-owned request deadline signal.
   * @returns Complete metadata for the previously recorded object.
   */
  async headImmutableArtifact(
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<HeadObjectCommandOutput> {
    this.headImmutableArtifactCommands.push(command)
    this.headImmutableArtifactAbortSignals.push(abortSignal)
    this.headImmutableArtifactEffect?.()
    const stored = this.readImmutableArtifactObject(
      command.input.Key,
      command.input.VersionId,
    )
    return this.createImmutableArtifactObjectOutput(stored)
  }

  /**
   * Records one exact codec-agnostic immutable object version read.
   *
   * @param command - Exact adapter-owned GetObject command.
   * @param abortSignal - Core-owned request deadline signal.
   * @returns Complete metadata and detached bytes for the stored version.
   */
  async getImmutableArtifact(
    command: GetObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<GetObjectCommandOutput> {
    this.getImmutableArtifactCommands.push(command)
    this.getImmutableArtifactAbortSignals.push(abortSignal)
    this.getImmutableArtifactEffect?.()
    const stored = this.readImmutableArtifactObject(
      command.input.Key,
      command.input.VersionId,
    )
    const output: GetObjectCommandOutput =
      this.createImmutableArtifactObjectOutput(stored)
    const body = stored.command.input.Body
    if (!(body instanceof Uint8Array)) {
      throw new Error('Expected Uint8Array immutable artifact body bytes.')
    }
    Reflect.set(
      output,
      'Body',
      this.immutableArtifactGetBody ?? new Uint8Array(body),
    )
    return output
  }

  /**
   * Records one conditional immutable source-artifact upload.
   *
   * @param command - Exact adapter-owned PutObject command.
   * @returns Configured fake immutable-version response.
   */
  async putSourceArtifact(
    command: PutObjectCommand,
  ): Promise<PutObjectCommandOutput> {
    this.putSourceArtifactCommands.push(command)
    const key = command.input.Key
    if (key === undefined) {
      throw new Error('Expected one source-artifact object key.')
    }
    this.sourceArtifactPutCommandsByKey.set(key, command)
    this.putSourceArtifactEffect?.()
    return {
      $metadata: {},
      VersionId: 'source-artifact-version-1',
      ChecksumSHA256: command.input.ChecksumSHA256,
      ChecksumType: 'FULL_OBJECT',
      ServerSideEncryption: command.input.ServerSideEncryption,
      SSEKMSKeyId: command.input.SSEKMSKeyId,
      BucketKeyEnabled: command.input.BucketKeyEnabled,
      Size: command.input.ContentLength,
    }
  }

  /**
   * Records one exact source-artifact metadata reconciliation read.
   *
   * @param command - Exact adapter-owned HeadObject command.
   * @returns Configured fake metadata response.
   */
  async headSourceArtifact(
    command: HeadObjectCommand,
  ): Promise<HeadObjectCommandOutput> {
    this.headSourceArtifactCommands.push(command)
    this.headSourceArtifactEffect?.()
    const putCommand = this.readSourceArtifactPutCommand(
      command.input.Key,
    )
    return this.createSourceArtifactObjectOutput(putCommand)
  }

  /**
   * Records one exact immutable source-artifact version read.
   *
   * @param command - Exact adapter-owned GetObject command.
   * @returns Configured fake object response.
   */
  async getSourceArtifact(
    command: GetObjectCommand,
  ): Promise<GetObjectCommandOutput> {
    this.getSourceArtifactCommands.push(command)
    this.getSourceArtifactEffect?.()
    const putCommand = this.readSourceArtifactPutCommand(
      command.input.Key,
    )
    const output: GetObjectCommandOutput =
      this.createSourceArtifactObjectOutput(putCommand)
    const body = putCommand.input.Body
    if (!(body instanceof Uint8Array)) {
      throw new Error('Expected Uint8Array source-artifact body bytes.')
    }
    Reflect.set(output, 'Body', new Uint8Array(body))
    return output
  }

  /**
   * Records one conditional immutable target-artifact upload.
   *
   * @param command - Exact adapter-owned PutObject command.
   * @returns Configured fake immutable-version response.
   */
  async putTargetArtifact(
    command: PutObjectCommand,
  ): Promise<PutObjectCommandOutput> {
    this.putTargetArtifactCommands.push(command)
    const key = command.input.Key
    if (key === undefined) {
      throw new Error('Expected one target-artifact object key.')
    }
    const versionId =
      `target-artifact-version-${this.putTargetArtifactCommands.length}`
    this.targetArtifactPutCommandsByKey.set(key, command)
    this.targetArtifactVersionIdsByKey.set(key, versionId)
    this.putTargetArtifactEffect?.()
    return {
      $metadata: {},
      VersionId: versionId,
      ChecksumSHA256: command.input.ChecksumSHA256,
      ChecksumType: 'FULL_OBJECT',
      ServerSideEncryption: command.input.ServerSideEncryption,
      SSEKMSKeyId: command.input.SSEKMSKeyId,
      BucketKeyEnabled: command.input.BucketKeyEnabled,
      Size: command.input.ContentLength,
    }
  }

  /**
   * Records one exact target-artifact metadata reconciliation read.
   *
   * @param command - Exact adapter-owned HeadObject command.
   * @returns Configured fake immutable metadata response.
   */
  async headTargetArtifact(
    command: HeadObjectCommand,
  ): Promise<HeadObjectCommandOutput> {
    this.headTargetArtifactCommands.push(command)
    this.headTargetArtifactEffect?.()
    const putCommand = this.readTargetArtifactPutCommand(
      command.input.Key,
      command.input.VersionId,
    )
    const versionId = this.readTargetArtifactVersionId(command.input.Key)
    return this.createTargetArtifactObjectOutput(putCommand, versionId)
  }

  /**
   * Records one exact immutable target-artifact version read.
   *
   * @param command - Exact adapter-owned GetObject command.
   * @returns Configured fake object response.
   */
  async getTargetArtifact(
    command: GetObjectCommand,
  ): Promise<GetObjectCommandOutput> {
    this.getTargetArtifactCommands.push(command)
    this.getTargetArtifactEffect?.()
    const putCommand = this.readTargetArtifactPutCommand(
      command.input.Key,
      command.input.VersionId,
    )
    const versionId = this.readTargetArtifactVersionId(command.input.Key)
    const output: GetObjectCommandOutput =
      this.createTargetArtifactObjectOutput(putCommand, versionId)
    const body = putCommand.input.Body
    if (!(body instanceof Uint8Array)) {
      throw new Error('Expected Uint8Array target-artifact body bytes.')
    }
    Reflect.set(output, 'Body', new Uint8Array(body))
    return output
  }

  /**
   * Reads one previously uploaded generic immutable object.
   *
   * @param key - Exact content-addressed S3 object key.
   * @param versionId - Optional exact immutable object version.
   * @returns Recorded immutable object and its assigned version.
   */
  private readImmutableArtifactObject(
    key: string | undefined,
    versionId?: string,
  ): RecordedImmutableArtifactObject {
    const stored = key === undefined
      ? undefined
      : this.immutableArtifactObjectsByKey.get(key)
    if (
      stored === undefined ||
      (
        versionId !== undefined &&
        versionId !== stored.versionId
      )
    ) {
      throw new Error('Expected one exact recorded immutable artifact.')
    }
    return stored
  }

  /**
   * Creates one valid immutable Object Lock response for a generic object.
   *
   * @param stored - Exact preceding upload and assigned version.
   * @returns Complete safe HeadObject-compatible response.
   */
  private createImmutableArtifactObjectOutput(
    stored: RecordedImmutableArtifactObject,
  ): HeadObjectCommandOutput {
    const command = stored.command
    return {
      $metadata: {},
      VersionId: stored.versionId,
      ContentLength: command.input.ContentLength,
      ContentType: command.input.ContentType,
      ChecksumSHA256: command.input.ChecksumSHA256,
      ChecksumType: 'FULL_OBJECT',
      ServerSideEncryption: command.input.ServerSideEncryption,
      SSEKMSKeyId: command.input.SSEKMSKeyId,
      BucketKeyEnabled: command.input.BucketKeyEnabled,
      LastModified:
        this.immutableArtifactLastModified ??
        new Date('2026-07-28T00:00:00.000Z'),
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate:
        command.input.ObjectLockRetainUntilDate,
      Metadata: command.input.Metadata,
    }
  }

  /**
   * Reads one previously uploaded source-artifact command.
   *
   * @param key - Exact immutable S3 object key.
   * @returns Recorded source-artifact upload.
   */
  private readSourceArtifactPutCommand(
    key: string | undefined,
  ): PutObjectCommand {
    const command = key === undefined
      ? undefined
      : this.sourceArtifactPutCommandsByKey.get(key)
    if (command === undefined) {
      throw new Error('Expected a previously uploaded source artifact.')
    }
    return command
  }

  /**
   * Creates one valid immutable Object Lock response for a recorded upload.
   *
   * @param command - Exact preceding source-artifact upload.
   * @returns Complete safe HeadObject-compatible response.
   */
  private createSourceArtifactObjectOutput(
    command: PutObjectCommand,
  ): HeadObjectCommandOutput {
    const lastModified =
      new Date('2026-07-28T00:00:00.000Z')
    const retainUntil =
      new Date('2026-08-28T00:00:00.000Z')
    return {
      $metadata: {},
      VersionId: 'source-artifact-version-1',
      ContentLength: command.input.ContentLength,
      ContentType: command.input.ContentType,
      ChecksumSHA256: command.input.ChecksumSHA256,
      ChecksumType: 'FULL_OBJECT',
      ServerSideEncryption: command.input.ServerSideEncryption,
      SSEKMSKeyId: command.input.SSEKMSKeyId,
      BucketKeyEnabled: command.input.BucketKeyEnabled,
      LastModified: lastModified,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil,
      Metadata: command.input.Metadata,
    }
  }

  /**
   * Reads one previously uploaded target-artifact command.
   *
   * @param key - Exact immutable S3 object key.
   * @param versionId - Optional exact immutable object version.
   * @returns Recorded target-artifact upload.
   */
  private readTargetArtifactPutCommand(
    key: string | undefined,
    versionId?: string,
  ): PutObjectCommand {
    const command = key === undefined
      ? undefined
      : this.targetArtifactPutCommandsByKey.get(key)
    const storedVersionId = key === undefined
      ? undefined
      : this.targetArtifactVersionIdsByKey.get(key)
    if (
      command === undefined ||
      storedVersionId === undefined ||
      (
        versionId !== undefined &&
        versionId !== storedVersionId
      )
    ) {
      throw new Error('Expected one exact uploaded target artifact version.')
    }
    return command
  }

  /**
   * Reads the immutable version assigned to one target-artifact upload.
   *
   * @param key - Exact content-addressed target-artifact object key.
   * @returns Stable fake immutable version identifier.
   */
  private readTargetArtifactVersionId(key: string | undefined): string {
    const versionId = key === undefined
      ? undefined
      : this.targetArtifactVersionIdsByKey.get(key)
    if (versionId === undefined) {
      throw new Error('Expected one recorded target-artifact version.')
    }
    return versionId
  }

  /**
   * Creates one valid immutable target Object Lock response.
   *
   * @param command - Exact preceding target-artifact upload.
   * @param versionId - Exact immutable object version.
   * @returns Complete safe HeadObject-compatible response.
   */
  private createTargetArtifactObjectOutput(
    command: PutObjectCommand,
    versionId: string,
  ): HeadObjectCommandOutput {
    return {
      $metadata: {},
      VersionId: versionId,
      ContentLength: command.input.ContentLength,
      ContentType: command.input.ContentType,
      ChecksumSHA256: command.input.ChecksumSHA256,
      ChecksumType: 'FULL_OBJECT',
      ServerSideEncryption: command.input.ServerSideEncryption,
      SSEKMSKeyId: command.input.SSEKMSKeyId,
      BucketKeyEnabled: command.input.BucketKeyEnabled,
      LastModified: new Date('2026-07-28T00:00:00.000Z'),
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate:
        new Date('2026-08-28T00:00:00.000Z'),
      Metadata: command.input.Metadata,
    }
  }
}

describe('Workspace Search migration AWS identity adapter', () => {
  test('constructs only exact allowlisted reads and closes its transport', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    let configurations:
      WorkspaceSearchMigrationIdentityAwsSdkConfigurations | undefined
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      (createdConfigurations) => {
        configurations = createdConfigurations
        return transport
      },
    )
    const tableName = requested.tables['project-directory']
    const journalLookup = createJournalLookup(requested)
    const originalCreationDate = transport.keyOutput.KeyMetadata?.CreationDate

    const caller = await port.readCallerIdentity()
    await port.describeTable(tableName)
    await port.describeContinuousBackups(tableName)
    await port.describeTimeToLive(tableName)
    const keyMetadata = await port.describeJournalKey(requested.journalKeyArn)
    await port.getBucketVersioning(journalLookup)
    await port.getObjectLockConfiguration(journalLookup)
    await port.getBucketEncryption(journalLookup)
    await port.getBucketLogging(journalLookup)
    port.close()

    expect(caller).toEqual({
      account: TEST_ACCOUNT,
      arn:
        `arn:aws:sts::${TEST_ACCOUNT}:assumed-role/MigrationOperator/${TEST_SESSION_NAME}`,
      userId: `${TEST_ROLE_ID}:${TEST_SESSION_NAME}`,
    })
    expect(transport.getCallerIdentityCommands).toHaveLength(1)
    expect(transport.getCallerIdentityCommands[0]).toBeInstanceOf(
      GetCallerIdentityCommand,
    )
    expect(transport.getCallerIdentityCommands[0]?.input).toEqual({})
    expect(transport.describeTableCommands[0]).toBeInstanceOf(DescribeTableCommand)
    expect(transport.describeTableCommands[0]?.input).toEqual({
      TableName: tableName,
    })
    expect(transport.continuousBackupsCommands[0]).toBeInstanceOf(
      DescribeContinuousBackupsCommand,
    )
    expect(transport.continuousBackupsCommands[0]?.input).toEqual({
      TableName: tableName,
    })
    expect(transport.describeTimeToLiveCommands[0]).toBeInstanceOf(
      DescribeTimeToLiveCommand,
    )
    expect(transport.describeTimeToLiveCommands[0]?.input).toEqual({
      TableName: tableName,
    })
    expect(transport.describeKeyCommands[0]).toBeInstanceOf(DescribeKeyCommand)
    expect(transport.describeKeyCommands[0]?.input).toEqual({
      KeyId: requested.journalKeyArn,
    })
    expect(keyMetadata).toEqual({
      arn: requested.journalKeyArn,
      awsAccountId: TEST_ACCOUNT,
      creationDate: new Date('2026-07-01T00:00:00.000Z'),
      enabled: true,
      keyId: TEST_KEY_ID,
      keyManager: 'CUSTOMER',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyState: 'Enabled',
      keyUsage: 'ENCRYPT_DECRYPT',
      multiRegion: false,
      origin: 'AWS_KMS',
    })
    expect(keyMetadata.creationDate).not.toBe(originalCreationDate)
    expectBucketCommand(
      transport.getBucketVersioningCommands[0],
      GetBucketVersioningCommand,
    )
    expectBucketCommand(
      transport.getObjectLockConfigurationCommands[0],
      GetObjectLockConfigurationCommand,
    )
    expectBucketCommand(
      transport.getBucketEncryptionCommands[0],
      GetBucketEncryptionCommand,
    )
    expectBucketCommand(
      transport.getBucketLoggingCommands[0],
      GetBucketLoggingCommand,
    )
    expect(configurations?.s3.followRegionRedirects).toBe(false)
    expect(transport.closeCount).toBe(1)
  })

  test('requires measured Scan authority and closes the managed session once', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const scanSourcePage: unknown = Reflect.get(port, 'scanSourcePage')
    if (typeof scanSourcePage !== 'function') {
      throw new Error('Expected managed source Scan method.')
    }
    const unmeasuredRead: unknown = Reflect.apply(scanSourcePage, port, [{}])
    if (!(unmeasuredRead instanceof Promise)) {
      throw new Error('Expected asynchronous source Scan result.')
    }

    await expect(unmeasuredRead).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })
    expect(transport.scanSourceCommands).toHaveLength(0)

    port.close()
    port.close()
    await expect(
      port.describeTable(requested.tables['project-directory']),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'Workspace Search migration AWS session is no longer active.',
    })
    expect(transport.describeTableCommands).toHaveLength(0)
    expect(transport.closeCount).toBe(1)
  })

  test('rejects unmeasured source evidence before DynamoDB data I/O', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    for (const methodName of [
      'readSourceEvidenceProgress',
      'readCommittedSourceEvidence',
      'commitNextSourceEvidencePage',
    ]) {
      const method: unknown = Reflect.get(port, methodName)
      if (typeof method !== 'function') {
        throw new Error('Expected managed source-evidence method.')
      }
      const pending: unknown = Reflect.apply(method, port, [{}])
      if (!(pending instanceof Promise)) {
        throw new Error('Expected asynchronous source-evidence result.')
      }
      await expect(pending).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message:
          'Workspace Search source evidence stopped safely (INVALID_STATE).',
      })
    }
    expect(transport.getSourceEvidenceCommands).toHaveLength(0)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(transport.scanSourceCommands).toHaveLength(0)
    port.close()
  })

  test('rejects every unmeasured pre-plan authority operation before data I/O', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const leaseClaim = {
      runId: 'unmeasured-authority-run',
      ownerId: 'unmeasured-authority-owner',
      fenceToken: 1,
    }
    const receiptDigest = '0'.repeat(64)
    const operations: (() => Promise<unknown>)[] = [
      () => port.acquireLease({
        runId: leaseClaim.runId,
        ownerId: leaseClaim.ownerId,
      }),
      () => port.heartbeatLease({ lease: leaseClaim }),
      () => port.renewMaintenanceEvidence({
        lease: leaseClaim,
        expectedPointer: null,
        evidenceBytes: new Uint8Array([1]),
      }),
      () => port.readAuthority({
        lease: leaseClaim,
        maintenanceEvidenceReceiptDigest: receiptDigest,
        maintenanceEvidencePointerRevision: 1,
      }),
      () => port.readMaintenanceEvidenceReceipt(
        leaseClaim.runId,
        receiptDigest,
      ),
      () => port.readHistoricalMaintenanceEvidenceBinding(
        leaseClaim.runId,
        receiptDigest,
      ),
    ]

    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message:
          'Workspace Search pre-plan authority stopped safely (INVALID_STATE).',
      })
    }
    expect(transport.getPrePlanAuthorityCommands).toHaveLength(0)
    expect(transport.transactWritePrePlanAuthorityCommands).toHaveLength(0)
    expect(transport.describeTableCommands).toHaveLength(0)
    port.close()
  })

  test('routes snapshotted lease acquire and heartbeat through the measured session', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    let clock = '2026-07-28T03:00:00.000Z'
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => new Date(clock),
    )
    await port.measureConfiguration()
    let selectedRunId = 'managed-authority-run'
    let selectedOwnerId = 'managed-authority-owner'
    const acquireInput = {
      get runId() {
        return selectedRunId
      },
      get ownerId() {
        return selectedOwnerId
      },
    }

    const pendingAcquire = port.acquireLease(acquireInput)
    selectedRunId = 'mutated-run'
    selectedOwnerId = 'mutated-owner'
    const acquired = await pendingAcquire
    clock = '2026-07-28T03:00:59.999Z'
    const heartbeated = await port.heartbeatLease({
      lease: {
        runId: acquired.runId,
        ownerId: acquired.ownerId,
        fenceToken: acquired.fenceToken,
      },
    })

    expect(acquired).toEqual({
      runId: 'managed-authority-run',
      ownerId: 'managed-authority-owner',
      fenceToken: 1,
      heartbeatAt: '2026-07-28T03:00:00.000Z',
      expiresAt: '2026-07-28T03:01:00.000Z',
    })
    expect(heartbeated).toEqual({
      ...acquired,
      heartbeatAt: '2026-07-28T03:00:59.999Z',
      expiresAt: '2026-07-28T03:01:59.999Z',
    })
    expect(transport.getPrePlanAuthorityCommands).toHaveLength(2)
    for (const command of transport.getPrePlanAuthorityCommands) {
      expect(command.input).toMatchObject({
        TableName: requested.tables['migration-state'],
        ConsistentRead: true,
      })
    }
    expect(transport.transactWritePrePlanAuthorityCommands).toHaveLength(2)
    const acquireItem =
      transport.transactWritePrePlanAuthorityCommands[0]
        ?.input.TransactItems?.[0]?.Put?.Item
    const heartbeatItem =
      transport.transactWritePrePlanAuthorityCommands[1]
        ?.input.TransactItems?.[0]?.Put?.Item
    expect(acquireItem?.recordKey?.S).toBe(heartbeatItem?.recordKey?.S)
    expect(acquireItem).toMatchObject({
      runId: { S: 'managed-authority-run' },
      ownerId: { S: 'managed-authority-owner' },
      fenceToken: { N: '1' },
    })
    expect(heartbeatItem).toMatchObject({
      heartbeatAt: { S: '2026-07-28T03:00:59.999Z' },
      expiresAt: { S: '2026-07-28T03:01:59.999Z' },
    })

    const authorityReadCount =
      transport.getPrePlanAuthorityCommands.length
    const authorityWriteCount =
      transport.transactWritePrePlanAuthorityCommands.length
    const stateDescribeCount = transport.describeTableCommands.length
    await expect(port.renewMaintenanceEvidence({
      lease: {
        runId: heartbeated.runId,
        ownerId: heartbeated.ownerId,
        fenceToken: heartbeated.fenceToken,
      },
      expectedPointer: null,
      evidenceBytes:
        new Uint8Array(MAINTENANCE_EVIDENCE_MAX_BYTES + 1),
    })).rejects.toMatchObject({
      code: 'INVALID_MAINTENANCE_EVIDENCE',
      message:
        'Workspace Search pre-plan authority stopped safely (INVALID_MAINTENANCE_EVIDENCE).',
    })
    expect(transport.getPrePlanAuthorityCommands)
      .toHaveLength(authorityReadCount)
    expect(transport.transactWritePrePlanAuthorityCommands)
      .toHaveLength(authorityWriteCount)
    expect(transport.describeTableCommands).toHaveLength(stateDescribeCount)
    port.close()
  })

  test('passes through exact expired historical maintenance bindings', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    let clockAt = '2026-07-28T03:30:00.000Z'
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => new Date(clockAt),
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'managed-historical-binding',
    )
    clockAt = authority.maintenanceEvidenceReceipt.validUntil
    const readCount = transport.getPrePlanAuthorityCommands.length

    const historical =
      await port.readHistoricalMaintenanceEvidenceBinding(
        authority.lease.runId,
        authority.maintenanceEvidenceReceiptDigest,
      )

    expect(historical).toEqual({
      configurationHash:
        createWorkspaceSearchConfigurationHash(configuration),
      stateTableId:
        configuration.tables['migration-state'].tableId,
      ownerId: authority.lease.ownerId,
      receiptDigest: authority.maintenanceEvidenceReceiptDigest,
      receipt: authority.maintenanceEvidenceReceipt,
    })
    expect(transport.getPrePlanAuthorityCommands)
      .toHaveLength(readCount + 1)
    port.close()
  })

  test('fails closed when the migration-state table is replaced during authority commit', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => new Date('2026-07-28T04:00:00.000Z'),
    )
    await port.measureConfiguration()
    const stateTableName = requested.tables['migration-state']
    const replacement = createReplacementDescribeTableOutput(
      'migration-state',
      stateTableName,
      requested,
    )
    transport.transactWritePrePlanAuthorityEffect = () => {
      transport.describeTableOutputs.set(stateTableName, replacement)
    }

    await expect(
      port.acquireLease({
        runId: 'replacement-authority-run',
        ownerId: 'replacement-authority-owner',
      }),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search pre-plan authority stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(transport.getPrePlanAuthorityCommands).toHaveLength(2)
    expect(transport.transactWritePrePlanAuthorityCommands).toHaveLength(1)
    port.close()
  })

  test('invalidates an authority read when the managed session closes', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => new Date('2026-07-28T05:00:00.000Z'),
    )
    await port.measureConfiguration()
    transport.getPrePlanAuthorityEffect = () => port.close()

    await expect(
      port.acquireLease({
        runId: 'close-authority-run',
        ownerId: 'close-authority-owner',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search pre-plan authority stopped safely (INVALID_STATE).',
    })
    expect(transport.getPrePlanAuthorityCommands).toHaveLength(1)
    expect(transport.transactWritePrePlanAuthorityCommands).toHaveLength(0)
    expect(transport.closeCount).toBe(1)
  })

  test('guards historical maintenance binding reads against session and state changes', async () => {
    const closeRequested = createRequestedResources()
    const closeTransport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(closeTransport, closeRequested)
    const closeClockAt = '2026-07-28T05:10:00.000Z'
    const closePort = createAwsWorkspaceSearchMigrationIdentityPort(
      closeRequested,
      () => closeTransport,
      () => new Date(closeClockAt),
    )
    await closePort.measureConfiguration()
    const closeAuthority = await createManagedPlanningAuthority(
      closePort,
      closeClockAt,
      'close-historical-binding',
    )
    closeTransport.getPrePlanAuthorityEffect = () => closePort.close()

    await expect(
      closePort.readHistoricalMaintenanceEvidenceBinding(
        closeAuthority.lease.runId,
        closeAuthority.maintenanceEvidenceReceiptDigest,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search pre-plan authority stopped safely (INVALID_STATE).',
    })
    expect(closeTransport.closeCount).toBe(1)

    const replacementRequested = createRequestedResources()
    const replacementTransport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(
      replacementTransport,
      replacementRequested,
    )
    const replacementClockAt = '2026-07-28T05:20:00.000Z'
    const replacementPort =
      createAwsWorkspaceSearchMigrationIdentityPort(
        replacementRequested,
        () => replacementTransport,
        () => new Date(replacementClockAt),
      )
    await replacementPort.measureConfiguration()
    const replacementAuthority = await createManagedPlanningAuthority(
      replacementPort,
      replacementClockAt,
      'replacement-historical-binding',
    )
    const stateTableName =
      replacementRequested.tables['migration-state']
    const replacement = createReplacementDescribeTableOutput(
      'migration-state',
      stateTableName,
      replacementRequested,
    )
    const replacementReadCount =
      replacementTransport.getPrePlanAuthorityCommands.length
    replacementTransport.getPrePlanAuthorityEffect = () => {
      replacementTransport.describeTableOutputs.set(
        stateTableName,
        replacement,
      )
    }

    await expect(
      replacementPort.readHistoricalMaintenanceEvidenceBinding(
        replacementAuthority.lease.runId,
        replacementAuthority.maintenanceEvidenceReceiptDigest,
      ),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search pre-plan authority stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(replacementTransport.getPrePlanAuthorityCommands)
      .toHaveLength(replacementReadCount + 1)
    replacementPort.close()
  })

  test('redacts forged managed evidence failure codes before data I/O', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const request = createSourceEvidenceRequest(configuration)
    const forgedCodeCanary = 'RAW-MANAGED-EVIDENCE-CODE-CANARY'
    const forgedFailure = new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      'fixed test failure',
    )
    Object.defineProperty(forgedFailure, 'code', {
      value: forgedCodeCanary,
    })
    Object.defineProperty(request, 'configurationHash', {
      get() {
        throw forgedFailure
      },
    })

    let failure: unknown
    try {
      await port.readSourceEvidenceProgress(request)
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(failure instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(failure).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source evidence stopped safely (INVALID_STATE).',
    })
    expect(failure.message).not.toContain(forgedCodeCanary)
    expect(transport.getSourceEvidenceCommands).toHaveLength(0)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(transport.scanSourceCommands).toHaveLength(0)
    port.close()
  })

  test('snapshots a managed evidence request before state identity I/O', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const request = createSourceEvidenceRequest(configuration)
    let selectedRunId = request.runId
    Object.defineProperty(request, 'runId', {
      get() {
        return selectedRunId
      },
    })

    const pending = port.readSourceEvidenceProgress(request)
    selectedRunId = 'mutated-after-authority-capture'
    const progress = await pending

    expect(progress.runId).toBe('managed-source-evidence-run')
    expect(transport.getSourceEvidenceCommands).toHaveLength(1)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    port.close()
  })

  test('invalidates evidence reads on close and replacement measurement races', async () => {
    const closeRequested = createRequestedResources()
    const closeTransport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(closeTransport, closeRequested)
    const closePort = createAwsWorkspaceSearchMigrationIdentityPort(
      closeRequested,
      () => closeTransport,
    )
    const closeConfiguration = await closePort.measureConfiguration()
    closeTransport.getSourceEvidenceEffect = () => closePort.close()

    await expect(
      closePort.readSourceEvidenceProgress(
        createSourceEvidenceRequest(closeConfiguration),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source evidence stopped safely (INVALID_STATE).',
    })
    expect(closeTransport.getSourceEvidenceCommands).toHaveLength(1)
    expect(closeTransport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(closeTransport.closeCount).toBe(1)

    const replacementRequested = createRequestedResources()
    const replacementTransport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(replacementTransport, replacementRequested)
    const replacementPort = createAwsWorkspaceSearchMigrationIdentityPort(
      replacementRequested,
      () => replacementTransport,
    )
    const replacementConfiguration =
      await replacementPort.measureConfiguration()
    let replacementMeasurement:
      Promise<WorkspaceSearchMigrationConfiguration> | undefined
    replacementTransport.getSourceEvidenceEffect = () => {
      replacementMeasurement = replacementPort.measureConfiguration()
    }

    await expect(
      replacementPort.readSourceEvidenceProgress(
        createSourceEvidenceRequest(replacementConfiguration),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source evidence stopped safely (INVALID_STATE).',
    })
    if (replacementMeasurement === undefined) {
      throw new Error('Expected replacement measurement to start.')
    }
    await replacementMeasurement
    expect(replacementTransport.getSourceEvidenceCommands).toHaveLength(1)
    expect(replacementTransport.transactWriteSourceEvidenceCommands)
      .toHaveLength(0)
    replacementPort.close()
  })

  test('rejects every migration-state incarnation mismatch before evidence reads', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const stateTableName = requested.tables['migration-state']
    const expected = createValidDescribeTableOutput(
      'migration-state',
      stateTableName,
      requested,
    )
    const replacementId = structuredClone(expected)
    const replacementArn = structuredClone(expected)
    const replacementCreation = structuredClone(expected)
    if (
      replacementId.Table === undefined ||
      replacementArn.Table === undefined ||
      replacementCreation.Table === undefined
    ) {
      throw new Error('Expected complete migration-state table fixtures.')
    }
    replacementId.Table.TableId = 'replacement-migration-state-table-id'
    replacementArn.Table.TableArn =
      `${replacementArn.Table.TableArn ?? ''}-replacement`
    replacementCreation.Table.CreationDateTime =
      new Date('2026-07-27T00:00:00.000Z')

    for (const replacement of [
      replacementId,
      replacementArn,
      replacementCreation,
    ]) {
      transport.describeTableOutputs.set(stateTableName, replacement)
      await expect(
        port.readSourceEvidenceProgress(
          createSourceEvidenceRequest(configuration),
        ),
      ).rejects.toMatchObject({
        code: 'CONFIGURATION_DRIFT',
        message:
          'Workspace Search source evidence stopped safely (CONFIGURATION_DRIFT).',
      })
    }
    expect(transport.getSourceEvidenceCommands).toHaveLength(0)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    port.close()
  })

  test('rejects migration-state replacement during an evidence read', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const stateTableName = requested.tables['migration-state']
    const replacement = createReplacementDescribeTableOutput(
      'migration-state',
      stateTableName,
      requested,
    )
    transport.getSourceEvidenceEffect = () => {
      transport.describeTableOutputs.set(stateTableName, replacement)
    }

    await expect(
      port.readSourceEvidenceProgress(
        createSourceEvidenceRequest(configuration),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(transport.getSourceEvidenceCommands).toHaveLength(1)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    port.close()
  })

  test('redacts migration-state deletion before evidence reads', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const stateTableName = requested.tables['migration-state']
    const canary = 'DELETED-MIGRATION-STATE-CANARY-DO-NOT-LEAK'
    transport.describeTableFailures.set(
      stateTableName,
      new ResourceNotFoundException({
        $metadata: {},
        message: canary,
      }),
    )

    let failure: unknown
    try {
      await port.readSourceEvidenceProgress(
        createSourceEvidenceRequest(configuration),
      )
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(failure instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(failure).toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(failure.message).not.toContain(canary)
    expect(transport.getSourceEvidenceCommands).toHaveLength(0)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    port.close()
  })

  test('preserves retryable classification for state incarnation reads', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const stateTableName = requested.tables['migration-state']
    const canary = 'STATE-DESCRIBE-THROTTLE-CANARY-DO-NOT-LEAK'
    const retryable = new Error(canary)
    retryable.name = 'ThrottlingException'
    Reflect.set(retryable, '$retryable', { throttling: true })
    transport.describeTableFailures.set(stateTableName, retryable)

    let failure: unknown
    try {
      await port.readSourceEvidenceProgress(
        createSourceEvidenceRequest(configuration),
      )
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(failure instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(failure).toMatchObject({
      code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      message:
        'Workspace Search source evidence stopped safely (TRANSIENT_INFRASTRUCTURE_FAILURE).',
    })
    expect(failure.message).not.toContain(canary)
    expect(transport.getSourceEvidenceCommands).toHaveLength(0)
    port.close()
  })

  test('rejects migration-state replacement during an evidence transaction', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const stateTableName = requested.tables['migration-state']
    const replacement = createReplacementDescribeTableOutput(
      'migration-state',
      stateTableName,
      requested,
    )
    transport.transactWriteSourceEvidenceEffect = () => {
      transport.describeTableOutputs.set(stateTableName, replacement)
    }

    await expect(
      port.commitNextSourceEvidencePage(
        createSourceEvidenceRequest(configuration),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(transport.getSourceEvidenceCommands.length).toBeGreaterThan(0)
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(1)
    port.close()
  })

  test('measures identity before issuing and reducing one exact source Scan', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    transport.scanSourceOutput = {
      $metadata: { requestId: 'not-migration-evidence' },
      Count: 1,
      Items: [createIgnoredSourceItem('measured')],
      ScannedCount: 1,
    }
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )

    const configuration = await port.measureConfiguration()
    const result = await port.scanSourcePage(
      createSourceScanInput(configuration),
    )

    expect(transport.describeTableCommands).toHaveLength(8)
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.scanSourceCommands[0]).toBeInstanceOf(ScanCommand)
    expect(transport.scanSourceCommands[0]?.input).toEqual({
      TableName: requested.tables['project-directory'],
      ConsistentRead: true,
      Limit: 100,
    })
    expect(result.checkpoint).toMatchObject({
      completed: true,
      aggregate: {
        ignored: 1,
        mapped: 0,
        pageCount: 1,
        scanned: 1,
      },
    })
    expect(result.sourceRows).toHaveLength(1)
    expect(result.sourceRows[0]?.classification).toBe('ignored')
    expect(result.invalidRows).toHaveLength(0)
    expect(Reflect.has(result, 'items')).toBe(false)
    expect(Reflect.has(result, 'page')).toBe(false)
    const serializedResult = JSON.stringify(result)
    expect(serializedResult).not.toContain('WORKSPACE_MEMBER#measured')
    expect(serializedResult).not.toContain('fixture')
    expect(transport.putSourceArtifactCommands).toHaveLength(0)
    expect(transport.headSourceArtifactCommands).toHaveLength(0)
    expect(transport.getSourceArtifactCommands).toHaveLength(0)
    port.close()
  })

  test('issues and reduces one exact target Scan without exposing raw rows', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    transport.scanTargetOutput = {
      $metadata: { requestId: 'not-migration-evidence' },
      Count: 1,
      Items: [createIgnoredTargetItem('measured')],
      ScannedCount: 1,
    }
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )

    const configuration = await port.measureConfiguration()
    const result = await port.scanTargetPage(
      createTargetScanInput(configuration),
    )

    expect(transport.describeTableCommands).toHaveLength(8)
    expect(transport.scanTargetCommands).toHaveLength(1)
    expect(transport.scanTargetCommands[0]).toBeInstanceOf(ScanCommand)
    expect(transport.scanTargetCommands[0]?.input).toEqual({
      TableName: requested.tables['workspace-search'],
      ConsistentRead: true,
      Limit: 100,
    })
    expect(result.checkpoint).toMatchObject({
      completed: true,
      aggregate: {
        ignored: 1,
        invalid: 0,
        owned: 0,
        pageCount: 1,
        scanned: 1,
      },
    })
    expect(result.targetRows).toHaveLength(1)
    expect(result.targetRows[0]?.classification).toBe('ignored')
    expect(result.invalidRows).toHaveLength(0)
    expect(result.observedTargetBindings).toHaveLength(0)
    expect(Reflect.has(result, 'items')).toBe(false)
    expect(Reflect.has(result, 'page')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('VIEW#measured')
    port.close()
  })

  test('uses only the exact target checkpoint cursor for continuation', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const cursor = createTargetCursor('first')
    transport.scanTargetOutput = {
      $metadata: {},
      Count: 1,
      Items: [createIgnoredTargetItem('first')],
      LastEvaluatedKey: cursor,
      ScannedCount: 1,
    }
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()

    const first = await port.scanTargetPage(
      createTargetScanInput(configuration),
    )
    transport.scanTargetOutput = createEmptyScanOutput()
    const terminal = await port.scanTargetPage(
      createTargetScanInput(configuration, first.checkpoint),
    )

    expect(first.checkpoint.completed).toBe(false)
    expect(terminal.checkpoint.completed).toBe(true)
    expect(transport.scanTargetCommands).toHaveLength(2)
    expect(transport.scanTargetCommands[1]?.input).toEqual({
      TableName: requested.tables['workspace-search'],
      ConsistentRead: true,
      ExclusiveStartKey: cursor,
      Limit: 100,
    })
    port.close()
  })

  test('rejects a target checkpoint from an earlier measured incarnation', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const firstItem = createIgnoredTargetItem('first-incarnation')
    transport.scanTargetOutput = {
      $metadata: {},
      Count: 1,
      Items: [firstItem],
      LastEvaluatedKey: createTargetCursor('first-incarnation'),
      ScannedCount: 1,
    }
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const firstConfiguration = await port.measureConfiguration()
    const first = await port.scanTargetPage(
      createTargetScanInput(firstConfiguration),
    )
    const targetTableName = requested.tables['workspace-search']
    transport.describeTableOutputs.set(
      targetTableName,
      createReplacementDescribeTableOutput(
        'workspace-search',
        targetTableName,
        requested,
      ),
    )
    const replacementConfiguration = await port.measureConfiguration()
    transport.scanTargetOutput = createEmptyScanOutput()

    await expect(
      port.scanTargetPage(
        createTargetScanInput(
          replacementConfiguration,
          first.checkpoint,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_HASH_MISMATCH',
      message:
        'Workspace Search target Scan read stopped safely (CONFIGURATION_HASH_MISMATCH).',
    })
    expect(transport.scanTargetCommands).toHaveLength(1)
    port.close()
  })

  test('rejects target replacement before and after the Scan', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const tableName = requested.tables['workspace-search']
    const currentTable = createValidDescribeTableOutput(
      'workspace-search',
      tableName,
      requested,
    )
    const replacementTable = createReplacementDescribeTableOutput(
      'workspace-search',
      tableName,
      requested,
    )

    transport.describeTableOutputs.set(tableName, replacementTable)
    await expect(
      port.scanTargetPage(createTargetScanInput(configuration)),
    ).rejects.toMatchObject({
      code: 'TARGET_DRIFT',
      message:
        'Workspace Search target Scan read stopped safely (TARGET_DRIFT).',
    })
    expect(transport.scanTargetCommands).toHaveLength(0)

    transport.describeTableOutputs.set(tableName, currentTable)
    transport.scanTargetEffect = () => {
      transport.describeTableOutputs.set(tableName, replacementTable)
    }
    await expect(
      port.scanTargetPage(createTargetScanInput(configuration)),
    ).rejects.toMatchObject({
      code: 'TARGET_DRIFT',
      message:
        'Workspace Search target Scan read stopped safely (TARGET_DRIFT).',
    })
    expect(transport.scanTargetCommands).toHaveLength(1)
    port.close()
  })

  test('redacts retryable target Scan transport failures', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const canary = 'TARGET-RETRYABLE-CANARY-DO-NOT-LEAK'
    const failure = new Error(canary)
    failure.name = 'TimeoutError'
    transport.scanTargetFailure = failure

    let caught: unknown
    try {
      await port.scanTargetPage(createTargetScanInput(configuration))
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(caught instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(caught).toMatchObject({
      code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      message:
        'Workspace Search target Scan read stopped safely (TRANSIENT_INFRASTRUCTURE_FAILURE).',
    })
    expect(caught.message).not.toContain(canary)
    port.close()
  })

  test('classifies target deletion and redacts non-retryable Scan failures', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    transport.scanTargetFailure = new ResourceNotFoundException({
      $metadata: {},
      message: 'RAW-DELETED-TARGET-DO-NOT-LEAK',
    })

    await expect(
      port.scanTargetPage(createTargetScanInput(configuration)),
    ).rejects.toMatchObject({
      code: 'TARGET_DRIFT',
      message:
        'Workspace Search target Scan read stopped safely (TARGET_DRIFT).',
    })

    const canary = 'RAW-TARGET-FAILURE-DO-NOT-LEAK'
    transport.scanTargetFailure = new Error(canary)
    let caught: unknown
    try {
      await port.scanTargetPage(createTargetScanInput(configuration))
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(caught instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(caught).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search target Scan read stopped safely (INVALID_STATE).',
    })
    expect(caught.message).not.toContain(canary)
    port.close()
  })

  test('rejects target Scans after close and replacement measurement', async () => {
    const requested = createRequestedResources()
    const closedTransport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(closedTransport, requested)
    const closedPort = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => closedTransport,
    )
    const closedConfiguration = await closedPort.measureConfiguration()
    closedPort.close()

    await expect(
      closedPort.scanTargetPage(
        createTargetScanInput(closedConfiguration),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search target Scan read stopped safely (INVALID_STATE).',
    })
    expect(closedTransport.scanTargetCommands).toHaveLength(0)

    const measuredTransport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(measuredTransport, requested)
    const measuredPort = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => measuredTransport,
    )
    const measuredConfiguration =
      await measuredPort.measureConfiguration()
    const deferred = createDeferredScanOutput()
    measuredTransport.scanTargetDeferred = deferred.promise
    const pending = measuredPort.scanTargetPage(
      createTargetScanInput(measuredConfiguration),
    )
    await waitForRecordedTargetScanCount(measuredTransport, 1)
    await measuredPort.measureConfiguration()
    measuredTransport.scanTargetDeferred = undefined
    deferred.resolve(createEmptyScanOutput())

    await expect(pending).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search target Scan read stopped safely (INVALID_STATE).',
    })
    expect(measuredTransport.scanTargetCommands).toHaveLength(1)
    measuredPort.close()
  })

  test('commits and replays two evidence pages through one measured session', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    let authorityClockReads = 0
    const firstItem = createIgnoredSourceItem('evidence-page-1')
    transport.scanSourceOutput = {
      $metadata: {},
      Count: 1,
      Items: [firstItem],
      LastEvaluatedKey:
        createProjectDirectoryCursor('evidence-page-1'),
      ScannedCount: 1,
    }
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        authorityClockReads += 1
        return new Date('2026-07-28T05:50:00.000Z')
      },
    )
    const configuration = await port.measureConfiguration()
    const evidenceRequest = createSourceEvidenceRequest(configuration)

    const first = await port.commitNextSourceEvidencePage(evidenceRequest)
    transport.scanSourceOutput = {
      $metadata: {},
      Count: 1,
      Items: [createIgnoredSourceItem('evidence-page-2')],
      ScannedCount: 1,
    }
    const second = await port.commitNextSourceEvidencePage(evidenceRequest)
    const durable = await port.readSourceEvidenceProgress(evidenceRequest)
    const replay =
      await port.readCommittedSourceEvidence(evidenceRequest)

    expect(first).toMatchObject({
      pageSequence: 1,
      checkpoint: {
        completed: false,
        aggregate: {
          ignored: 1,
          pageCount: 1,
          scanned: 1,
        },
      },
    })
    expect(second).toMatchObject({
      pageSequence: 2,
      checkpoint: {
        completed: true,
        aggregate: {
          ignored: 2,
          pageCount: 2,
          scanned: 2,
        },
      },
    })
    expect(durable).toEqual(second)
    expect(replay.progress).toEqual(second)
    expect(replay.sourceRows).toHaveLength(2)
    expect(replay.invalidRows).toHaveLength(0)
    expect(replay.sourceBindings).toHaveLength(0)
    expect(transport.scanSourceCommands).toHaveLength(2)
    expect(transport.scanSourceCommands[1]?.input.ExclusiveStartKey)
      .toEqual(createProjectDirectoryCursor('evidence-page-1'))
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(2)
    expect(transport.transactWriteSourceEvidenceCommands[0])
      .toBeInstanceOf(TransactWriteItemsCommand)
    expect(transport.transactWriteSourceEvidenceCommands[1])
      .toBeInstanceOf(TransactWriteItemsCommand)
    expect(authorityClockReads).toBe(0)
    // GetItem calls: first commit 1, terminal commit 3, progress 2, replay 4.
    expect(transport.getSourceEvidenceCommands).toHaveLength(10)
    expect(transport.getSourceEvidenceCommands.every(
      (command) => command instanceof GetItemCommand &&
        command.input.ConsistentRead === true,
    )).toBe(true)
    expect(transport.putSourceArtifactCommands).toHaveLength(0)
    expect(transport.headSourceArtifactCommands).toHaveLength(0)
    expect(transport.getSourceArtifactCommands).toHaveLength(0)
    port.close()
  })

  test('commits detached planning authority with a guarded five-item transaction', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const exactScanItem: DynamoAttributeMap = {
      ...createIgnoredSourceItem('planning-lossless'),
      exactNumber: { N: '1.2300' },
      nativeBinary: { B: new Uint8Array([0, 255, 17]) },
      nestedValues: {
        L: [
          { NULL: true },
          { M: { enabled: { BOOL: false } } },
        ],
      },
    }
    transport.scanSourceOutput = {
      $metadata: {},
      Count: 1,
      Items: [exactScanItem],
      ScannedCount: 1,
    }
    const clockAt = '2026-07-28T06:00:00.000Z'
    let writeTrace: string[] | undefined
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        writeTrace?.push('clock')
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const lease = await port.acquireLease({
      runId: 'managed-planning-evidence-run',
      ownerId: 'managed-planning-evidence-owner',
    })
    const authority = await port.renewMaintenanceEvidence({
      lease: {
        runId: lease.runId,
        ownerId: lease.ownerId,
        fenceToken: lease.fenceToken,
      },
      expectedPointer: null,
      evidenceBytes: createManagedMaintenanceEvidenceBytes(clockAt),
    })
    const detachedAuthority = structuredClone(authority)
    const sourceTableName = requested.tables['project-directory']
    const stateTableName = requested.tables['migration-state']
    writeTrace = []
    transport.scanSourceEffect = () => {
      writeTrace?.push('scan')
    }
    transport.putSourceArtifactEffect = () => {
      writeTrace?.push('artifact-put')
    }
    transport.headSourceArtifactEffect = () => {
      writeTrace?.push('artifact-head')
    }
    transport.describeTableEffect = (tableName) => {
      if (tableName === sourceTableName) {
        writeTrace?.push('source-incarnation')
      }
      if (tableName === stateTableName) {
        writeTrace?.push('state-incarnation')
      }
    }
    transport.transactWriteSourceEvidenceEffect = () => {
      writeTrace?.push('transaction')
    }

    const progress = await port.commitNextSourceEvidencePage(
      createPlanningSourceEvidenceRequest(
        configuration,
        detachedAuthority,
      ),
    )

    expect(detachedAuthority).not.toBe(authority)
    expect(detachedAuthority.lease).not.toBe(authority.lease)
    expect(progress).toMatchObject({
      purpose: 'planning',
      runId: 'managed-planning-evidence-run',
      pageSequence: 1,
    })
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.putSourceArtifactCommands).toHaveLength(1)
    expect(transport.headSourceArtifactCommands).toHaveLength(1)
    expect(transport.getSourceArtifactCommands).toHaveLength(0)
    const putCommand = transport.putSourceArtifactCommands[0]
    const artifactBytes = putCommand?.input.Body
    const metadata = putCommand?.input.Metadata
    const contentDigest =
      metadata?.['mukuroji-content-sha256']
    if (
      !(artifactBytes instanceof Uint8Array) ||
      metadata === undefined ||
      contentDigest === undefined
    ) {
      throw new Error('Expected exact planning source-artifact upload.')
    }
    const artifactSegment =
      parseWorkspaceSearchMigrationPlanningSourceArtifactSegment(
        artifactBytes,
      )
    expect(artifactSegment.items).toEqual([exactScanItem])
    expect(artifactSegment).toMatchObject({
      pageSequence: 1,
      segmentIndex: 0,
      segmentCount: 1,
      itemStartIndex: 0,
      itemCount: 1,
      pageItemCount: 1,
    })
    expect(putCommand.input).toEqual({
      Bucket: requested.journalBucket,
      Key:
        `workspace-search/v1/source-artifacts/v1/${contentDigest}.json`,
      Body: artifactBytes,
      ContentLength: artifactBytes.byteLength,
      ContentType: 'application/json',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: putCommand.input.ChecksumSHA256,
      IfNoneMatch: '*',
      ExpectedBucketOwner: requested.account,
      Metadata: {
        'mukuroji-kind':
          'workspace-search-planning-source-artifact-segment',
        'mukuroji-version': '1',
        'mukuroji-content-sha256': contentDigest,
        'mukuroji-byte-length':
          artifactBytes.byteLength.toString(),
        'mukuroji-segment-index': '0',
        'mukuroji-segment-count': '1',
      },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: requested.journalKeyArn,
      BucketKeyEnabled: true,
    })
    expect(transport.headSourceArtifactCommands[0]?.input).toEqual({
      Bucket: requested.journalBucket,
      Key: putCommand.input.Key,
      ExpectedBucketOwner: requested.account,
      ChecksumMode: 'ENABLED',
      VersionId: 'source-artifact-version-1',
    })
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(1)
    const transaction =
      transport.transactWriteSourceEvidenceCommands[0]?.input.TransactItems
    expect(transaction).toHaveLength(5)
    expect(transaction?.slice(0, 3).every(
      (entry) =>
        entry.ConditionCheck?.TableName === stateTableName,
    )).toBe(true)
    expect(transaction?.slice(3).every(
      (entry) => entry.Put?.TableName === stateTableName,
    )).toBe(true)
    expect(
      transaction?.[0]?.ConditionCheck
        ?.ExpressionAttributeValues?.[':ownerId'],
    ).toEqual({ S: authority.lease.ownerId })
    const pagePayload = transaction?.[3]?.Put?.Item?.payload?.B
    if (!(pagePayload instanceof Uint8Array)) {
      throw new Error('Expected canonical planning evidence page bytes.')
    }
    const decodedPage: unknown = JSON.parse(
      new TextDecoder().decode(pagePayload),
    )
    if (typeof decodedPage !== 'object' || decodedPage === null) {
      throw new Error('Expected one decoded planning evidence page.')
    }
    expect(readOwnObject(decodedPage, 'planningAuthority')).toEqual({
      ownerId: authority.lease.ownerId,
      fenceToken: authority.lease.fenceToken,
      maintenanceEvidencePointerRevision:
        authority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceReceiptDigest:
        authority.maintenanceEvidenceReceiptDigest,
    })
    expect(Reflect.get(decodedPage, 'sourceArtifacts')).toEqual([{
      objectKey: putCommand.input.Key,
      versionId: 'source-artifact-version-1',
      contentDigest,
    }])
    expect(writeTrace.indexOf('scan'))
      .toBeLessThan(writeTrace.indexOf('artifact-put'))
    expect(writeTrace.indexOf('artifact-put'))
      .toBeLessThan(writeTrace.indexOf('artifact-head'))
    expect(writeTrace.indexOf('artifact-head'))
      .toBeLessThan(writeTrace.indexOf('transaction'))
    const clockIndex = writeTrace.indexOf('clock')
    expect(clockIndex).toBeGreaterThan(1)
    expect(writeTrace.slice(clockIndex - 2, clockIndex + 2)).toEqual([
      'source-incarnation',
      'state-incarnation',
      'clock',
      'transaction',
    ])
    port.close()
  })

  test('rejects state-table replacement in evidence write preparation', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:10:00.000Z'
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const lease = await port.acquireLease({
      runId: 'replaced-planning-evidence-run',
      ownerId: 'replaced-planning-evidence-owner',
    })
    const authority = await port.renewMaintenanceEvidence({
      lease: {
        runId: lease.runId,
        ownerId: lease.ownerId,
        fenceToken: lease.fenceToken,
      },
      expectedPointer: null,
      evidenceBytes: createManagedMaintenanceEvidenceBytes(clockAt),
    })
    const clockReadsBeforeCommit = clockReads
    const stateTableName = requested.tables['migration-state']
    const replacement = createReplacementDescribeTableOutput(
      'migration-state',
      stateTableName,
      requested,
    )
    transport.scanSourceEffect = () => {
      transport.describeTableOutputs.set(stateTableName, replacement)
    }

    await expect(
      port.commitNextSourceEvidencePage(
        createPlanningSourceEvidenceRequest(
          configuration,
          structuredClone(authority),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(clockReads).toBe(clockReadsBeforeCommit)
    port.close()
  })

  test('rejects source replacement during planning artifact upload before commit time', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:12:00.000Z'
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'artifact-source-replacement',
    )
    const clockReadsBeforeCommit = clockReads
    const sourceTableName = requested.tables['project-directory']
    const replacement = createReplacementDescribeTableOutput(
      'project-directory',
      sourceTableName,
      requested,
    )
    const canary =
      'REPLACED-SOURCE-AFTER-ARTIFACT-CANARY-DO-NOT-LEAK'
    if (replacement.Table === undefined) {
      throw new Error('Expected one replacement source table.')
    }
    replacement.Table.TableId = canary
    transport.putSourceArtifactEffect = () => {
      transport.describeTableOutputs.set(sourceTableName, replacement)
    }

    const failure = await captureWorkspaceSearchMigrationFailure(
      port.commitNextSourceEvidencePage(
        createPlanningSourceEvidenceRequest(
          configuration,
          structuredClone(authority),
        ),
      ),
    )
    expect(failure).toMatchObject({
      code: 'SOURCE_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (SOURCE_DRIFT).',
    })
    expect(failure.message).not.toContain(canary)
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.putSourceArtifactCommands).toHaveLength(1)
    expect(transport.headSourceArtifactCommands).toHaveLength(1)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(clockReads).toBe(clockReadsBeforeCommit)
    port.close()
  })

  test('classifies source deletion after planning artifact upload as source drift', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:13:00.000Z'
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'artifact-source-deletion',
    )
    const clockReadsBeforeCommit = clockReads
    const sourceTableName = requested.tables['project-directory']
    const canary =
      'DELETED-SOURCE-AFTER-ARTIFACT-CANARY-DO-NOT-LEAK'
    transport.putSourceArtifactEffect = () => {
      transport.describeTableFailures.set(
        sourceTableName,
        new ResourceNotFoundException({
          $metadata: {},
          message: canary,
        }),
      )
    }

    const failure = await captureWorkspaceSearchMigrationFailure(
      port.commitNextSourceEvidencePage(
        createPlanningSourceEvidenceRequest(
          configuration,
          structuredClone(authority),
        ),
      ),
    )

    expect(failure).toMatchObject({
      code: 'SOURCE_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (SOURCE_DRIFT).',
    })
    expect(failure.message).not.toContain(canary)
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.putSourceArtifactCommands).toHaveLength(1)
    expect(transport.headSourceArtifactCommands).toHaveLength(1)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(clockReads).toBe(clockReadsBeforeCommit)
    port.close()
  })

  test('classifies state replacement after planning artifact upload as configuration drift', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:13:20.000Z'
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'artifact-state-replacement',
    )
    const clockReadsBeforeCommit = clockReads
    const stateTableName = requested.tables['migration-state']
    const replacement = createReplacementDescribeTableOutput(
      'migration-state',
      stateTableName,
      requested,
    )
    const canary =
      'REPLACED-STATE-AFTER-ARTIFACT-CANARY-DO-NOT-LEAK'
    if (replacement.Table === undefined) {
      throw new Error('Expected one replacement state table.')
    }
    replacement.Table.TableId = canary
    transport.putSourceArtifactEffect = () => {
      transport.describeTableOutputs.set(stateTableName, replacement)
    }

    const failure = await captureWorkspaceSearchMigrationFailure(
      port.commitNextSourceEvidencePage(
        createPlanningSourceEvidenceRequest(
          configuration,
          structuredClone(authority),
        ),
      ),
    )

    expect(failure).toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(failure.message).not.toContain(canary)
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.putSourceArtifactCommands).toHaveLength(1)
    expect(transport.headSourceArtifactCommands).toHaveLength(1)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(clockReads).toBe(clockReadsBeforeCommit)
    port.close()
  })

  test('classifies state deletion after planning artifact upload as configuration drift', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:13:40.000Z'
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'artifact-state-deletion',
    )
    const clockReadsBeforeCommit = clockReads
    const stateTableName = requested.tables['migration-state']
    const canary =
      'DELETED-STATE-AFTER-ARTIFACT-CANARY-DO-NOT-LEAK'
    transport.putSourceArtifactEffect = () => {
      transport.describeTableFailures.set(
        stateTableName,
        new ResourceNotFoundException({
          $metadata: {},
          message: canary,
        }),
      )
    }

    const failure = await captureWorkspaceSearchMigrationFailure(
      port.commitNextSourceEvidencePage(
        createPlanningSourceEvidenceRequest(
          configuration,
          structuredClone(authority),
        ),
      ),
    )

    expect(failure).toMatchObject({
      code: 'CONFIGURATION_DRIFT',
      message:
        'Workspace Search source evidence stopped safely (CONFIGURATION_DRIFT).',
    })
    expect(failure.message).not.toContain(canary)
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.putSourceArtifactCommands).toHaveLength(1)
    expect(transport.headSourceArtifactCommands).toHaveLength(1)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(clockReads).toBe(clockReadsBeforeCommit)
    port.close()
  })

  test('rejects session close during planning artifact upload', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:14:00.000Z'
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'artifact-session-close',
    )
    const clockReadsBeforeCommit = clockReads
    transport.putSourceArtifactEffect = () => {
      port.close()
    }

    await expect(
      port.commitNextSourceEvidencePage(
        createPlanningSourceEvidenceRequest(
          configuration,
          structuredClone(authority),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source evidence stopped safely (INVALID_STATE).',
    })
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.putSourceArtifactCommands).toHaveLength(1)
    expect(transport.headSourceArtifactCommands).toHaveLength(0)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(clockReads).toBe(clockReadsBeforeCommit)
    expect(transport.closeCount).toBe(1)
  })

  test('rejects replacement measurement during planning artifact upload', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:16:00.000Z'
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'artifact-remeasurement',
    )
    const clockReadsBeforeCommit = clockReads
    let replacementMeasurement:
      Promise<WorkspaceSearchMigrationConfiguration> | undefined
    transport.putSourceArtifactEffect = () => {
      replacementMeasurement = port.measureConfiguration()
    }

    await expect(
      port.commitNextSourceEvidencePage(
        createPlanningSourceEvidenceRequest(
          configuration,
          structuredClone(authority),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source evidence stopped safely (INVALID_STATE).',
    })
    if (replacementMeasurement === undefined) {
      throw new Error('Expected replacement measurement to start.')
    }
    await expect(replacementMeasurement).resolves.toBeDefined()
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(transport.putSourceArtifactCommands).toHaveLength(1)
    expect(transport.headSourceArtifactCommands).toHaveLength(0)
    expect(transport.transactWriteSourceEvidenceCommands).toHaveLength(0)
    expect(clockReads).toBe(clockReadsBeforeCommit)
    port.close()
  })

  test('captures planning authority before managed-session guard I/O', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:20:00.000Z'
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => new Date(clockAt),
    )
    const configuration = await port.measureConfiguration()
    const lease = await port.acquireLease({
      runId: 'captured-planning-evidence-run',
      ownerId: 'captured-planning-evidence-owner',
    })
    const authority = await port.renewMaintenanceEvidence({
      lease: {
        runId: lease.runId,
        ownerId: lease.ownerId,
        fenceToken: lease.fenceToken,
      },
      expectedPointer: null,
      evidenceBytes: createManagedMaintenanceEvidenceBytes(clockAt),
    })
    const mutableAuthority = structuredClone(authority)
    let selectedOwnerId = mutableAuthority.lease.ownerId
    Object.defineProperty(mutableAuthority.lease, 'ownerId', {
      configurable: true,
      enumerable: true,
      get() {
        return selectedOwnerId
      },
    })
    const pending = port.commitNextSourceEvidencePage(
      createPlanningSourceEvidenceRequest(
        configuration,
        mutableAuthority,
      ),
    )
    selectedOwnerId = 'mutated-after-authority-capture'

    await expect(pending).resolves.toMatchObject({
      purpose: 'planning',
      pageSequence: 1,
    })
    const transaction =
      transport.transactWriteSourceEvidenceCommands[0]?.input.TransactItems
    expect(
      transaction?.[0]?.ConditionCheck
        ?.ExpressionAttributeValues?.[':ownerId'],
    ).toEqual({ S: 'captured-planning-evidence-owner' })
    const pagePayload = transaction?.[3]?.Put?.Item?.payload?.B
    if (!(pagePayload instanceof Uint8Array)) {
      throw new Error('Expected captured planning page bytes.')
    }
    const decodedPage: unknown = JSON.parse(
      new TextDecoder().decode(pagePayload),
    )
    if (typeof decodedPage !== 'object' || decodedPage === null) {
      throw new Error('Expected one decoded captured planning page.')
    }
    expect(readOwnObject(decodedPage, 'planningAuthority')).toMatchObject({
      ownerId: 'captured-planning-evidence-owner',
    })
    port.close()
  })

  test('captures one raw target page and commits its exact lossless artifact', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const exactTargetItem: DynamoAttributeMap = {
      ...createIgnoredTargetItem('planning-lossless'),
      exactNumber: { N: '1.2300' },
      nativeBinary: { B: new Uint8Array([0, 255, 17]) },
      nestedValues: {
        L: [
          { NULL: true },
          { M: { enabled: { BOOL: false } } },
        ],
      },
    }
    transport.scanTargetOutput = {
      $metadata: {},
      Count: 1,
      Items: [exactTargetItem],
      ScannedCount: 1,
    }
    const clockAt = '2026-07-28T06:25:00.000Z'
    let writeTrace: string[] | undefined
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        writeTrace?.push('clock')
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const configurationHash =
      createWorkspaceSearchConfigurationHash(configuration)
    const expectedPageResult =
      reduceWorkspaceSearchMigrationTargetScanPage({
        configuration,
        configurationHash,
        previousCheckpoint:
          createEmptyWorkspaceSearchMigrationTargetScanCheckpoint(
            configurationHash,
          ),
        page: {
          items: [exactTargetItem],
        },
      })
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'target-lossless',
    )
    const targetTableName = requested.tables['workspace-search']
    const stateTableName = requested.tables['migration-state']
    const clockReadsBeforeCommit = clockReads
    writeTrace = []
    transport.describeTableEffect = (tableName) => {
      if (tableName === targetTableName) {
        writeTrace?.push('target-incarnation')
      }
      if (tableName === stateTableName) {
        writeTrace?.push('state-incarnation')
      }
    }
    transport.scanTargetEffect = () => {
      writeTrace?.push('scan')
      if (transport.scanTargetCommands.length !== 1) {
        throw new Error('Target planning must never issue a second Scan.')
      }
    }
    transport.putTargetArtifactEffect = () => {
      writeTrace?.push('artifact-put')
    }
    transport.headTargetArtifactEffect = () => {
      writeTrace?.push('artifact-head')
    }
    transport.transactWriteTargetEvidenceEffect = () => {
      writeTrace?.push('transaction')
    }

    const progress = await port.commitNextTargetEvidencePage(
      createPlanningTargetEvidenceRequest(
        configuration,
        structuredClone(authority),
      ),
    )

    expect(progress).toMatchObject({
      purpose: 'planning',
      runId: authority.lease.runId,
      pageSequence: 1,
      checkpoint: {
        completed: true,
        aggregate: {
          scanned: 1,
          ignored: 1,
          invalid: 0,
          owned: 0,
          pageCount: 1,
        },
      },
    })
    expect(transport.scanTargetCommands).toHaveLength(1)
    expect(transport.scanTargetCommands[0]?.input).toEqual({
      TableName: targetTableName,
      ConsistentRead: true,
      Limit: 100,
    })
    expect(transport.putTargetArtifactCommands).toHaveLength(1)
    expect(transport.headTargetArtifactCommands).toHaveLength(1)
    expect(transport.getTargetArtifactCommands).toHaveLength(0)
    const artifactPut = transport.putTargetArtifactCommands[0]
    if (artifactPut === undefined) {
      throw new Error('Expected one planning target-artifact upload.')
    }
    const artifactBytes = artifactPut.input.Body
    const artifactObjectKey = artifactPut.input.Key
    const artifactContentDigest =
      artifactPut.input.Metadata?.['mukuroji-content-sha256']
    if (
      !(artifactBytes instanceof Uint8Array) ||
      artifactObjectKey === undefined ||
      artifactContentDigest === undefined
    ) {
      throw new Error('Expected exact planning target-artifact bytes.')
    }
    const artifactSegment =
      parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        artifactBytes,
      )
    expect(artifactSegment.items).toEqual([exactTargetItem])
    expect(artifactSegment).toMatchObject({
      runId: authority.lease.runId,
      pageSequence: 1,
      segmentIndex: 0,
      segmentCount: 1,
      itemStartIndex: 0,
      itemCount: 1,
      pageItemCount: 1,
      planningAuthority: {
        ownerId: authority.lease.ownerId,
        fenceToken: authority.lease.fenceToken,
      },
    })
    expect(artifactObjectKey)
      .toMatch(/^workspace-search\/v1\/target-artifacts\/v1\/[0-9a-f]{64}\.json$/u)
    expect(transport.headTargetArtifactCommands[0]?.input).toMatchObject({
      Bucket: requested.journalBucket,
      Key: artifactObjectKey,
      ExpectedBucketOwner: requested.account,
      ChecksumMode: 'ENABLED',
      VersionId: 'target-artifact-version-1',
    })
    expect(transport.transactWriteTargetEvidenceCommands).toHaveLength(1)
    const transaction =
      transport.transactWriteTargetEvidenceCommands[0]?.input.TransactItems
    expect(transaction).toHaveLength(5)
    expect(transaction?.slice(0, 3).every(
      (entry) => entry.ConditionCheck?.TableName === stateTableName,
    )).toBe(true)
    expect(transaction?.slice(3).every(
      (entry) => entry.Put?.TableName === stateTableName,
    )).toBe(true)
    const evidencePayload = transaction?.[3]?.Put?.Item?.payload?.B
    if (!(evidencePayload instanceof Uint8Array)) {
      throw new Error('Expected canonical target-evidence page bytes.')
    }
    const evidencePage =
      parseWorkspaceSearchMigrationTargetEvidencePage(evidencePayload)
    expect({
      checkpoint: evidencePage.checkpoint,
      targetRows: evidencePage.targetRows,
      invalidRows: evidencePage.invalidRows,
      observedTargetBindings: evidencePage.observedTargetBindings,
    }).toEqual(expectedPageResult)
    expect(progress.checkpoint).toEqual(expectedPageResult.checkpoint)
    expect(evidencePage.targetArtifacts).toEqual([{
      objectKey: artifactObjectKey,
      versionId: 'target-artifact-version-1',
      contentDigest: artifactContentDigest,
    }])
    const completedWriteTrace = writeTrace
    if (completedWriteTrace === undefined) {
      throw new Error('Expected one target-evidence write trace.')
    }
    const clockIndex = completedWriteTrace.indexOf('clock')
    expect(
      completedWriteTrace.slice(clockIndex - 4, clockIndex + 2),
    ).toEqual([
      'artifact-put',
      'artifact-head',
      'target-incarnation',
      'state-incarnation',
      'clock',
      'transaction',
    ])
    expect(clockReads).toBe(clockReadsBeforeCommit + 1)
    port.close()
  })

  test('revalidates target and state incarnations after target artifact upload', async () => {
    const tableRoles:
      readonly ('workspace-search' | 'migration-state')[] = [
        'workspace-search',
        'migration-state',
      ]
    const driftKinds: readonly ('replacement' | 'deletion')[] = [
      'replacement',
      'deletion',
    ]
    for (const tableRole of tableRoles) {
      for (const drift of driftKinds) {
        const requested = createRequestedResources()
        const transport = new RecordingIdentityAwsTransport()
        seedValidMeasurementOutputs(transport, requested)
        const clockAt = '2026-07-28T06:30:00.000Z'
        let clockReads = 0
        const port = createAwsWorkspaceSearchMigrationIdentityPort(
          requested,
          () => transport,
          () => {
            clockReads += 1
            return new Date(clockAt)
          },
        )
        const configuration = await port.measureConfiguration()
        const identifier =
          `target-post-upload-${tableRole}-${drift}`
        const authority = await createManagedPlanningAuthority(
          port,
          clockAt,
          identifier,
        )
        const clockReadsBeforeCommit = clockReads
        const tableName = requested.tables[tableRole]
        const canary =
          `RAW-${tableRole}-${drift}-AFTER-TARGET-ARTIFACT`
        transport.headTargetArtifactEffect = () => {
          if (drift === 'replacement') {
            const replacement = createReplacementDescribeTableOutput(
              tableRole,
              tableName,
              requested,
            )
            if (replacement.Table === undefined) {
              throw new Error('Expected one replacement table fixture.')
            }
            replacement.Table.TableId = canary
            transport.describeTableOutputs.set(tableName, replacement)
            return
          }
          transport.describeTableFailures.set(
            tableName,
            new ResourceNotFoundException({
              $metadata: {},
              message: canary,
            }),
          )
        }

        const failure = await captureWorkspaceSearchMigrationFailure(
          port.commitNextTargetEvidencePage(
            createPlanningTargetEvidenceRequest(
              configuration,
              structuredClone(authority),
            ),
          ),
        )

        const expectedCode = tableRole === 'workspace-search'
          ? 'TARGET_DRIFT'
          : 'CONFIGURATION_DRIFT'
        expect(failure).toMatchObject({
          code: expectedCode,
          message:
            `Workspace Search target evidence stopped safely (${expectedCode}).`,
        })
        expect(failure.message).not.toContain(canary)
        expect(transport.scanTargetCommands).toHaveLength(1)
        expect(transport.putTargetArtifactCommands).toHaveLength(1)
        expect(transport.headTargetArtifactCommands).toHaveLength(1)
        expect(transport.prepareTargetEvidenceWriteCount).toBe(0)
        expect(transport.transactWriteTargetEvidenceCommands)
          .toHaveLength(0)
        expect(clockReads).toBe(clockReadsBeforeCommit)
        port.close()
      }
    }
  })

  test('resumes and replays exact target versions without rescanning a terminal head', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:35:00.000Z'
    let clockReads = 0
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => {
        clockReads += 1
        return new Date(clockAt)
      },
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'target-resume-replay',
    )
    const firstItem = createIgnoredTargetItem('target-page-one')
    transport.scanTargetOutput = {
      $metadata: {},
      Count: 1,
      Items: [firstItem],
      LastEvaluatedKey: createTargetCursor('target-page-one'),
      ScannedCount: 1,
    }
    const request = createPlanningTargetEvidenceRequest(
      configuration,
      structuredClone(authority),
    )

    const first = await port.commitNextTargetEvidencePage(request)
    transport.scanTargetOutput = {
      $metadata: {},
      Count: 1,
      Items: [createInvalidTargetItem('target-page-two')],
      ScannedCount: 1,
    }
    const completed = await port.commitNextTargetEvidencePage(request)

    expect(first).toMatchObject({
      pageSequence: 1,
      checkpoint: {
        completed: false,
        aggregate: {
          scanned: 1,
          ignored: 1,
          invalid: 0,
          pageCount: 1,
        },
      },
    })
    expect(completed).toMatchObject({
      pageSequence: 2,
      checkpoint: {
        completed: true,
        aggregate: {
          scanned: 2,
          ignored: 1,
          invalid: 1,
          pageCount: 2,
        },
      },
    })
    expect(transport.scanTargetCommands).toHaveLength(2)
    expect(
      transport.scanTargetCommands[1]?.input.ExclusiveStartKey,
    ).toEqual(createTargetCursor('target-page-one'))
    expect(transport.putTargetArtifactCommands).toHaveLength(2)
    expect(transport.headTargetArtifactCommands).toHaveLength(2)
    expect(transport.getTargetArtifactCommands).toHaveLength(1)
    const scanCountBeforeReplay = transport.scanTargetCommands.length
    transport.scanTargetFailure =
      new Error('RAW-TARGET-REPLAY-MUST-NOT-SCAN')
    const replay = await port.readCommittedTargetEvidence(
      createTargetEvidenceReadRequest(
        configuration,
        authority.lease.runId,
      ),
    )

    expect(replay.progress).toEqual(completed)
    expect(replay.targetRows).toHaveLength(1)
    expect(replay.targetRows[0]?.classification).toBe('ignored')
    expect(replay.invalidRows).toHaveLength(1)
    expect(replay.observedTargetBindings).toHaveLength(0)
    expect(transport.scanTargetCommands).toHaveLength(
      scanCountBeforeReplay,
    )
    expect(transport.getTargetArtifactCommands).toHaveLength(3)
    for (const command of transport.getTargetArtifactCommands) {
      expect(command.input).toMatchObject({
        Bucket: requested.journalBucket,
        ExpectedBucketOwner: requested.account,
        ChecksumMode: 'ENABLED',
      })
      expect(command.input.Key)
        .toMatch(/^workspace-search\/v1\/target-artifacts\/v1\/[0-9a-f]{64}\.json$/u)
      expect(command.input.VersionId)
        .toMatch(/^target-artifact-version-[12]$/u)
    }

    const terminalCounts = {
      scans: transport.scanTargetCommands.length,
      puts: transport.putTargetArtifactCommands.length,
      heads: transport.headTargetArtifactCommands.length,
      gets: transport.getTargetArtifactCommands.length,
      preparations: transport.prepareTargetEvidenceWriteCount,
      transactions:
        transport.transactWriteTargetEvidenceCommands.length,
      clockReads,
    }
    const repeated = await port.commitNextTargetEvidencePage(request)

    expect(repeated).toEqual(completed)
    expect(transport.scanTargetCommands).toHaveLength(terminalCounts.scans)
    expect(transport.putTargetArtifactCommands)
      .toHaveLength(terminalCounts.puts)
    expect(transport.headTargetArtifactCommands)
      .toHaveLength(terminalCounts.heads)
    expect(transport.getTargetArtifactCommands)
      .toHaveLength(terminalCounts.gets)
    expect(transport.prepareTargetEvidenceWriteCount)
      .toBe(terminalCounts.preparations)
    expect(transport.transactWriteTargetEvidenceCommands)
      .toHaveLength(terminalCounts.transactions)
    expect(clockReads).toBe(terminalCounts.clockReads)
    port.close()
  })

  test('invalidates target artifact Put and Get work on close or remeasurement', async () => {
    const phases: readonly ('put' | 'get')[] = ['put', 'get']
    const lifecycleChanges: readonly ('close' | 'remeasure')[] = [
      'close',
      'remeasure',
    ]
    for (const phase of phases) {
      for (const lifecycle of lifecycleChanges) {
        const requested = createRequestedResources()
        const transport = new RecordingIdentityAwsTransport()
        seedValidMeasurementOutputs(transport, requested)
        const clockAt = '2026-07-28T06:40:00.000Z'
        let clockReads = 0
        const port = createAwsWorkspaceSearchMigrationIdentityPort(
          requested,
          () => transport,
          () => {
            clockReads += 1
            return new Date(clockAt)
          },
        )
        const configuration = await port.measureConfiguration()
        const authority = await createManagedPlanningAuthority(
          port,
          clockAt,
          `target-${phase}-${lifecycle}`,
        )
        transport.scanTargetOutput = {
          $metadata: {},
          Count: 1,
          Items: [
            createIgnoredTargetItem(`target-${phase}-${lifecycle}`),
          ],
          ScannedCount: 1,
        }
        const commitRequest = createPlanningTargetEvidenceRequest(
          configuration,
          structuredClone(authority),
        )
        if (phase === 'get') {
          await port.commitNextTargetEvidencePage(commitRequest)
        }
        const countsBeforeLifecycle = {
          scans: transport.scanTargetCommands.length,
          puts: transport.putTargetArtifactCommands.length,
          heads: transport.headTargetArtifactCommands.length,
          gets: transport.getTargetArtifactCommands.length,
          preparations: transport.prepareTargetEvidenceWriteCount,
          transactions:
            transport.transactWriteTargetEvidenceCommands.length,
          clockReads,
        }
        let replacementMeasurement:
          Promise<WorkspaceSearchMigrationConfiguration> | undefined
        const lifecycleEffect = () => {
          if (lifecycle === 'close') {
            port.close()
            return
          }
          replacementMeasurement = port.measureConfiguration()
        }
        if (phase === 'put') {
          transport.putTargetArtifactEffect = lifecycleEffect
        } else {
          transport.getTargetArtifactEffect = lifecycleEffect
        }

        const failure = await captureWorkspaceSearchMigrationFailure(
          phase === 'put'
            ? port.commitNextTargetEvidencePage(commitRequest)
            : port.readCommittedTargetEvidence(
                createTargetEvidenceReadRequest(
                  configuration,
                  authority.lease.runId,
                ),
              ),
        )

        expect(failure).toMatchObject({
          code: 'INVALID_STATE',
          message:
            'Workspace Search target evidence stopped safely (INVALID_STATE).',
        })
        if (replacementMeasurement !== undefined) {
          await expect(replacementMeasurement).resolves.toBeDefined()
        }
        expect(transport.scanTargetCommands).toHaveLength(
          phase === 'put'
            ? countsBeforeLifecycle.scans + 1
            : countsBeforeLifecycle.scans,
        )
        expect(transport.putTargetArtifactCommands).toHaveLength(
          phase === 'put'
            ? countsBeforeLifecycle.puts + 1
            : countsBeforeLifecycle.puts,
        )
        expect(transport.headTargetArtifactCommands)
          .toHaveLength(countsBeforeLifecycle.heads)
        expect(transport.getTargetArtifactCommands).toHaveLength(
          phase === 'get'
            ? countsBeforeLifecycle.gets + 1
            : countsBeforeLifecycle.gets,
        )
        expect(transport.prepareTargetEvidenceWriteCount)
          .toBe(countsBeforeLifecycle.preparations)
        expect(transport.transactWriteTargetEvidenceCommands)
          .toHaveLength(countsBeforeLifecycle.transactions)
        expect(clockReads).toBe(countsBeforeLifecycle.clockReads)
        if (lifecycle === 'close') {
          expect(transport.closeCount).toBe(1)
        } else {
          port.close()
        }
      }
    }
  })

  test('snapshots target evidence request and authority before state guard I/O', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T06:45:00.000Z'
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => new Date(clockAt),
    )
    const configuration = await port.measureConfiguration()
    const authority = await createManagedPlanningAuthority(
      port,
      clockAt,
      'target-snapshot',
    )
    const mutableAuthority = structuredClone(authority)
    let selectedOwnerId = mutableAuthority.lease.ownerId
    Object.defineProperty(mutableAuthority.lease, 'ownerId', {
      configurable: true,
      enumerable: true,
      get() {
        return selectedOwnerId
      },
    })
    const request = createPlanningTargetEvidenceRequest(
      configuration,
      mutableAuthority,
    )
    let selectedRunId = request.runId
    Object.defineProperty(request, 'runId', {
      configurable: true,
      enumerable: true,
      get() {
        return selectedRunId
      },
    })
    transport.scanTargetOutput = {
      $metadata: {},
      Count: 1,
      Items: [createIgnoredTargetItem('target-snapshot')],
      ScannedCount: 1,
    }

    const pending = port.commitNextTargetEvidencePage(request)
    selectedOwnerId = 'mutated-owner-after-target-authority-capture'
    selectedRunId = 'mutated-run-after-target-authority-capture'
    const progress = await pending

    expect(progress).toMatchObject({
      runId: authority.lease.runId,
      pageSequence: 1,
    })
    const artifactBytes =
      transport.putTargetArtifactCommands[0]?.input.Body
    if (!(artifactBytes instanceof Uint8Array)) {
      throw new Error('Expected snapshotted target artifact bytes.')
    }
    const artifactSegment =
      parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        artifactBytes,
      )
    expect(artifactSegment).toMatchObject({
      runId: authority.lease.runId,
      planningAuthority: {
        ownerId: authority.lease.ownerId,
      },
    })
    const transaction =
      transport.transactWriteTargetEvidenceCommands[0]?.input.TransactItems
    expect(
      transaction?.[0]?.ConditionCheck
        ?.ExpressionAttributeValues?.[':ownerId'],
    ).toEqual({ S: authority.lease.ownerId })
    const evidencePayload = transaction?.[3]?.Put?.Item?.payload?.B
    if (!(evidencePayload instanceof Uint8Array)) {
      throw new Error('Expected snapshotted target evidence bytes.')
    }
    expect(
      parseWorkspaceSearchMigrationTargetEvidencePage(evidencePayload),
    ).toMatchObject({
      runId: authority.lease.runId,
      planningAuthority: {
        ownerId: authority.lease.ownerId,
      },
    })
    port.close()
  })

  test('joins five fixed terminal heads from exact artifact versions', async () => {
    const fixture = await createManagedCommittedPlanningFixture('happy')
    const scansBefore = {
      source: fixture.transport.scanSourceCommands.length,
      target: fixture.transport.scanTargetCommands.length,
    }
    const sourceEvidenceReadsBefore =
      fixture.transport.getSourceEvidenceCommands.length
    const targetEvidenceReadsBefore =
      fixture.transport.getTargetEvidenceCommands.length

    const result = await fixture.port.joinCommittedPlanningEvidence(
      fixture.input,
    )

    expect(result.candidates).toEqual([])
    expect(result.targetProgress).toMatchObject({
      pageSequence: 1,
      checkpoint: {
        completed: true,
        aggregate: {
          scanned: 2,
          ignored: 2,
          invalid: 0,
        },
      },
    })
    expect(result.planningAuthorityProvenance.chainRoots).toHaveLength(5)
    expect(result.targetOwnershipEvidence.targetRows).toHaveLength(2)
    expect(
      result.sourceProgress['project-directory']
        .checkpoint.aggregate,
    ).toMatchObject({
      scanned: 1,
      ignored: 1,
      invalid: 0,
    })
    expect(JSON.stringify(result)).not.toContain('happy-source')
    expect(JSON.stringify(result)).not.toContain('happy-one')
    expect(JSON.stringify(result)).not.toContain('happy-two')
    expect(fixture.transport.scanSourceCommands).toHaveLength(
      scansBefore.source,
    )
    expect(fixture.transport.scanTargetCommands).toHaveLength(
      scansBefore.target,
    )
    expect(
      fixture.transport.getSourceEvidenceCommands.length -
        sourceEvidenceReadsBefore,
    ).toBe(20)
    expect(
      fixture.transport.getTargetEvidenceCommands.length -
        targetEvidenceReadsBefore,
    ).toBe(5)
    expect(fixture.transport.getSourceArtifactCommands).toHaveLength(4)
    expect(fixture.transport.getTargetArtifactCommands).toHaveLength(1)
    for (const command of [
      ...fixture.transport.getSourceArtifactCommands,
      ...fixture.transport.getTargetArtifactCommands,
    ]) {
      expect(command.input).toMatchObject({
        Bucket: TEST_BUCKET,
        ChecksumMode: 'ENABLED',
        ExpectedBucketOwner: TEST_ACCOUNT,
      })
      expect(typeof command.input.VersionId).toBe('string')
    }
    fixture.port.close()
  })

  test('rejects changed evidence heads after the pure planning join', async () => {
    const fixture = await createManagedCommittedPlanningFixture(
      'head-race',
    )
    let deleted = false
    fixture.transport.getTargetArtifactEffect = () => {
      if (deleted) return
      deleted = true
      fixture.transport.deleteFirstSourceEvidenceHead()
    }

    const failure = await captureWorkspaceSearchMigrationFailure(
      fixture.port.joinCommittedPlanningEvidence(fixture.input),
    )

    expect(deleted).toBe(true)
    expect(failure).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search planning material join stopped safely (INVALID_STATE).',
    })
    expect(fixture.transport.getSourceArtifactCommands).toHaveLength(4)
    expect(fixture.transport.getTargetArtifactCommands).toHaveLength(1)
    fixture.port.close()
  })

  test('enforces managed and captured-head limits before artifact GET', async () => {
    const fixture = await createManagedCommittedPlanningFixture('limits')
    const evidenceReadsBefore =
      fixture.transport.getSourceEvidenceCommands.length +
      fixture.transport.getTargetEvidenceCommands.length
    const overHardLimits = [
      {
        ...fixture.input.limits,
        maxTotalRows:
          WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_TOTAL_ROWS + 1,
      },
      {
        ...fixture.input.limits,
        maxTotalCanonicalItemBytes:
          WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_CANONICAL_BYTES + 1,
      },
      {
        ...fixture.input.limits,
        maxPlanOperations:
          WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_OPERATIONS + 1,
      },
    ]
    for (const limits of overHardLimits) {
      const hardCapFailure = await captureWorkspaceSearchMigrationFailure(
        fixture.port.joinCommittedPlanningEvidence({
          ...fixture.input,
          limits,
        }),
      )
      expect(hardCapFailure.code).toBe('INVALID_ARGUMENT')
    }
    expect(
      fixture.transport.getSourceEvidenceCommands.length +
        fixture.transport.getTargetEvidenceCommands.length,
    ).toBe(evidenceReadsBefore)

    const headLimitFailure =
      await captureWorkspaceSearchMigrationFailure(
        fixture.port.joinCommittedPlanningEvidence({
          ...fixture.input,
          limits: {
            ...fixture.input.limits,
            maxTotalRows: 1,
          },
        }),
      )
    expect(headLimitFailure).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message:
        'Workspace Search planning material join stopped safely (INVALID_ARGUMENT).',
    })
    expect(fixture.transport.getSourceArtifactCommands).toHaveLength(0)
    expect(fixture.transport.getTargetArtifactCommands).toHaveLength(0)
    fixture.port.close()
  })

  test('prioritizes target incarnation drift found after material reads', async () => {
    const fixture = await createManagedCommittedPlanningFixture(
      'target-drift',
    )
    const requested = createRequestedResources()
    const tableName =
      fixture.input.configuration.tables['workspace-search'].tableName
    const replacement = createReplacementDescribeTableOutput(
      'workspace-search',
      tableName,
      requested,
    )
    fixture.transport.getTargetArtifactEffect = () => {
      fixture.transport.describeTableOutputs.set(
        tableName,
        replacement,
      )
    }

    const failure = await captureWorkspaceSearchMigrationFailure(
      fixture.port.joinCommittedPlanningEvidence(fixture.input),
    )

    expect(failure).toMatchObject({
      code: 'TARGET_DRIFT',
      message:
        'Workspace Search planning material join stopped safely (TARGET_DRIFT).',
    })
    expect(fixture.transport.getTargetArtifactCommands).toHaveLength(1)
    fixture.port.close()
  })

  test('invalidates exact material reads when the managed session closes', async () => {
    const fixture = await createManagedCommittedPlanningFixture(
      'close-race',
    )
    fixture.transport.getSourceArtifactEffect = () => fixture.port.close()

    const failure = await captureWorkspaceSearchMigrationFailure(
      fixture.port.joinCommittedPlanningEvidence(fixture.input),
    )

    expect(failure).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search planning material join stopped safely (INVALID_STATE).',
    })
    expect(fixture.transport.getSourceArtifactCommands).toHaveLength(1)
    expect(fixture.transport.getTargetArtifactCommands).toHaveLength(0)
    expect(fixture.transport.closeCount).toBe(1)
  })

  test('requires measurement before creating a planning artifact gateway', () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )

    expect(
      () => port.createPlanningArtifactGateway('unmeasured-artifact-run'),
    ).toThrow(
      new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
      ),
    )
    expect(transport.putImmutableArtifactCommands).toHaveLength(0)
    expect(transport.headImmutableArtifactCommands).toHaveLength(0)
    expect(transport.getImmutableArtifactCommands).toHaveLength(0)
    port.close()
  })

  test(
    'binds sealed publication reads to one successful measurement generation',
    async () => {
      const requested = createRequestedResources()
      const transport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(transport, requested)
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        requested,
        () => transport,
      )
      const expectedFailure = new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Workspace Search sealed planning authority publication failed.',
      )

      expect(
        () => port.createSealedPlanningAuthorityPort(),
      ).toThrow(expectedFailure)

      const configuration = await port.measureConfiguration()
      configuration.tables['migration-state'].tableName =
        'caller-mutated-state-table'
      const stalePublicationPort =
        port.createSealedPlanningAuthorityPort()
      await expect(
        stalePublicationPort.read('measured-sealed-authority-run'),
      ).resolves.toBeUndefined()
      expect(transport.getPrePlanAuthorityCommands).toHaveLength(1)
      expect(
        transport.getPrePlanAuthorityCommands[0]?.input,
      ).toMatchObject({
        TableName: requested.tables['migration-state'],
        ConsistentRead: true,
      })

      await port.measureConfiguration()
      await expect(
        stalePublicationPort.read('stale-sealed-authority-run'),
      ).rejects.toEqual(expectedFailure)
      expect(transport.getPrePlanAuthorityCommands).toHaveLength(1)

      const currentPublicationPort =
        port.createSealedPlanningAuthorityPort()
      port.close()
      expect(
        () => port.createSealedPlanningAuthorityPort(),
      ).toThrow(expectedFailure)
      await expect(
        currentPublicationPort.read('closed-sealed-authority-run'),
      ).rejects.toEqual(expectedFailure)
      expect(transport.getPrePlanAuthorityCommands).toHaveLength(1)
    },
  )

  test(
    'rejects a same-name state replacement during a sealed publication read',
    async () => {
      const requested = createRequestedResources()
      const transport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(transport, requested)
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        requested,
        () => transport,
      )
      await port.measureConfiguration()
      const publicationPort = port.createSealedPlanningAuthorityPort()
      const stateTableName = requested.tables['migration-state']
      const replacement = createReplacementDescribeTableOutput(
        'migration-state',
        stateTableName,
        requested,
      )
      transport.getPrePlanAuthorityEffect = () => {
        transport.describeTableOutputs.set(
          stateTableName,
          replacement,
        )
      }

      await expect(
        publicationPort.read('replaced-state-sealed-authority-run'),
      ).rejects.toMatchObject({
        code: 'CONFIGURATION_DRIFT',
        message:
          'Workspace Search sealed planning authority publication failed.',
      })
      expect(transport.getPrePlanAuthorityCommands).toHaveLength(1)
      port.close()
    },
  )

  test(
    'publishes a real managed planning graph after ordered incarnation preparation',
    async () => {
      const fixture =
        await createManagedSealedPublicationFixture('publish-success')
      const publicationPort =
        fixture.port.createSealedPlanningAuthorityPort()
      const transactionCount =
        fixture.transport.transactWritePrePlanAuthorityCommands.length
      const trace: string[] = []
      fixture.transport.describeTableEffect = (tableName) => {
        trace.push(tableName)
      }
      fixture.transport.transactWritePrePlanAuthorityEffect = () => {
        trace.push('transact')
      }

      const published = await publicationPort.publish(
        fixture.publishInput,
      )

      expect(trace).toEqual([
        fixture.requested.tables['migration-state'],
        fixture.requested.tables['migration-state'],
        fixture.requested.tables['migration-state'],
        fixture.requested.tables['project-directory'],
        fixture.requested.tables['work-items'],
        fixture.requested.tables.collaboration,
        fixture.requested.tables.documents,
        fixture.requested.tables['workspace-search'],
        'transact',
        fixture.requested.tables['migration-state'],
        fixture.requested.tables['project-directory'],
        fixture.requested.tables['work-items'],
        fixture.requested.tables.collaboration,
        fixture.requested.tables.documents,
        fixture.requested.tables['workspace-search'],
      ])
      expect(
        fixture.transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      const transaction =
        fixture.transport.transactWritePrePlanAuthorityCommands[
          transactionCount
        ]?.input.TransactItems
      expect(transaction).toHaveLength(9)
      for (const condition of transaction?.slice(0, 8) ?? []) {
        expect(condition.ConditionCheck).toBeDefined()
        expect(condition.Put).toBeUndefined()
      }
      expect(transaction?.[8]?.Put).toBeDefined()
      expect(transaction?.[8]?.ConditionCheck).toBeUndefined()
      expect(published).toMatchObject({
        runId: fixture.publishInput.runId,
        configurationHash: fixture.publishInput.configurationHash,
      })
      fixture.port.close()
    },
  )

  test(
    'recovers the first managed publication identity on a new port after response loss',
    async () => {
      const setupClockAt = '2026-07-28T07:00:00.000Z'
      let publicationClockTimes: string[] | undefined
      /**
       * Returns the stable setup time until the publication sequence is armed.
       *
       * @returns Exact trusted managed-session time.
       */
      const clock = (): Date => {
        if (publicationClockTimes === undefined) {
          return new Date(setupClockAt)
        }
        const timestamp = publicationClockTimes.shift()
        if (timestamp === undefined) {
          throw new Error('Managed publication clock fixture exhausted.')
        }
        return new Date(timestamp)
      }
      const fixture = await createManagedSealedPublicationFixture(
        'publish-response-loss-retry',
        clock,
      )
      publicationClockTimes = [
        '2026-07-28T07:00:05.000Z',
        '2026-07-28T07:00:10.000Z',
      ]
      const firstPublicationPort =
        fixture.port.createSealedPlanningAuthorityPort()
      const transactionCount =
        fixture.transport.transactWritePrePlanAuthorityCommands.length
      const readCount =
        fixture.transport.getPrePlanAuthorityCommands.length
      const transactionResponseLoss =
        new Error('redacted transaction response loss')
      transactionResponseLoss.name = 'TimeoutError'
      const reconciliationReadLoss =
        new Error('redacted reconciliation read loss')
      reconciliationReadLoss.name = 'TimeoutError'
      let responseLossInjected = false
      fixture.transport.transactWritePrePlanAuthorityPostCommitEffect =
        () => {
          if (responseLossInjected) return
          responseLossInjected = true
          fixture.transport.getPrePlanAuthorityEffect = () => {
            fixture.transport.getPrePlanAuthorityEffect = undefined
            throw reconciliationReadLoss
          }
          throw transactionResponseLoss
        }

      const firstFailure =
        await captureWorkspaceSearchMigrationFailure(
          firstPublicationPort.publish(fixture.publishInput),
        )

      expect(firstFailure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
      expect(firstFailure.message).toBe(
        'Workspace Search sealed planning authority publication failed.',
      )
      expect(responseLossInjected).toBe(true)
      expect(
        fixture.transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      const firstRootItem =
        fixture.transport.transactWritePrePlanAuthorityCommands[
          transactionCount
        ]?.input.TransactItems?.[8]?.Put?.Item
      const firstRootBytes = firstRootItem?.rootBytes?.B
      const firstSealedAt = firstRootItem?.sealedAt?.S
      const firstAuthorityDigest =
        firstRootItem?.authorityDigest?.S
      if (
        !(firstRootBytes instanceof Uint8Array) ||
        firstSealedAt === undefined ||
        firstAuthorityDigest === undefined
      ) {
        throw new Error('Expected the first durable publication root.')
      }
      const firstCanonicalRootBytes = Uint8Array.from(firstRootBytes)
      expect(firstSealedAt).toBe('2026-07-28T07:00:10.000Z')
      expect(publicationClockTimes).toEqual([])
      publicationClockTimes = ['2026-07-28T07:00:20.000Z']
      fixture.transport.transactWritePrePlanAuthorityPostCommitEffect =
        undefined

      const retryPublicationPort =
        fixture.port.createSealedPlanningAuthorityPort()
      const recovered = await retryPublicationPort.publish(
        fixture.publishInput,
      )

      expect(recovered.sealedAt).toBe(firstSealedAt)
      expect(recovered.authorityDigest).toBe(firstAuthorityDigest)
      expect(
        serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          recovered,
        ),
      ).toEqual(firstCanonicalRootBytes)
      expect(
        fixture.transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      const publicationReads =
        fixture.transport.getPrePlanAuthorityCommands.slice(readCount)
      expect(publicationReads).toHaveLength(3)
      for (const command of publicationReads) {
        expect(command.input.ConsistentRead).toBe(true)
      }
      expect(publicationClockTimes).toEqual([
        '2026-07-28T07:00:20.000Z',
      ])
      fixture.port.close()
    },
  )

  const sealedPublicationReplacementCases: readonly {
    readonly role: WorkspaceSearchMigrationTableRole
    readonly expectedCode:
      | 'CONFIGURATION_DRIFT'
      | 'SOURCE_DRIFT'
      | 'TARGET_DRIFT'
  }[] = [
    {
      role: 'migration-state',
      expectedCode: 'CONFIGURATION_DRIFT',
    },
    {
      role: 'project-directory',
      expectedCode: 'SOURCE_DRIFT',
    },
    {
      role: 'workspace-search',
      expectedCode: 'TARGET_DRIFT',
    },
  ]
  for (const candidate of sealedPublicationReplacementCases) {
    test(
      `rejects a same-name ${candidate.role} replacement committed during sealed publication`,
      async () => {
        const fixture =
          await createManagedSealedPublicationFixture(
            `publish-${candidate.role}-race`,
          )
        const publicationPort =
          fixture.port.createSealedPlanningAuthorityPort()
        const transactionCount =
          fixture.transport.transactWritePrePlanAuthorityCommands.length
        const tableName = fixture.requested.tables[candidate.role]
        const replacement = createReplacementDescribeTableOutput(
          candidate.role,
          tableName,
          fixture.requested,
        )
        const observedTableIds: (string | undefined)[] = []
        fixture.transport.describeTableEffect = (observedTableName) => {
          if (observedTableName === tableName) {
            observedTableIds.push(
              fixture.transport.describeTableOutputs
                .get(observedTableName)?.Table?.TableId,
            )
          }
        }
        fixture.transport.transactWritePrePlanAuthorityEffect = () => {
          fixture.transport.describeTableOutputs.set(
            tableName,
            replacement,
          )
        }

        let failure: unknown
        try {
          await publicationPort.publish(fixture.publishInput)
        } catch (error: unknown) {
          failure = error
        }

        expect({
          failure: failure instanceof WorkspaceSearchMigrationFailure
            ? failure.code
            : undefined,
          observedTableIds,
        }).toMatchObject({
          failure: candidate.expectedCode,
          observedTableIds: candidate.role === 'migration-state'
            ? [
                'table-id-migration-state-v1',
                'table-id-migration-state-v1',
                'table-id-migration-state-v1',
                'replacement-table-id-migration-state-v2',
              ]
            : [
                `table-id-${candidate.role}-v1`,
                `replacement-table-id-${candidate.role}-v2`,
              ],
        })
        expect(
          fixture.transport.transactWritePrePlanAuthorityCommands,
        ).toHaveLength(transactionCount + 1)
        expect(
          fixture.transport.transactWritePrePlanAuthorityCommands[
            transactionCount
          ]?.input.TransactItems,
        ).toHaveLength(9)
        fixture.port.close()
      },
    )
  }

  for (const lifecycle of ['close', 'remeasure']) {
    test(
      `fails closed when the managed session ${lifecycle}s during sealed publication`,
      async () => {
        const fixture =
          await createManagedSealedPublicationFixture(
            `publish-${lifecycle}-race`,
          )
        const publicationPort =
          fixture.port.createSealedPlanningAuthorityPort()
        const transactionCount =
          fixture.transport.transactWritePrePlanAuthorityCommands.length
        let replacementMeasurement:
          Promise<WorkspaceSearchMigrationConfiguration> | undefined
        fixture.transport.transactWritePrePlanAuthorityEffect = () => {
          if (lifecycle === 'close') {
            fixture.port.close()
            return
          }
          replacementMeasurement = fixture.port.measureConfiguration()
        }

        const failure = await captureWorkspaceSearchMigrationFailure(
          publicationPort.publish(fixture.publishInput),
        )

        expect(failure).toMatchObject({
          code: 'INVALID_STATE',
          message:
            'Workspace Search sealed planning authority publication failed.',
        })
        expect(
          fixture.transport.transactWritePrePlanAuthorityCommands,
        ).toHaveLength(transactionCount + 1)
        if (lifecycle === 'remeasure') {
          if (replacementMeasurement === undefined) {
            throw new Error('Expected replacement measurement to start.')
          }
          await replacementMeasurement
          fixture.port.close()
        }
      },
    )
  }

  test(
    'retries sealed publication on the same port after preparation recovers',
    async () => {
      const fixture =
        await createManagedSealedPublicationFixture('publish-retry')
      const publicationPort =
        fixture.port.createSealedPlanningAuthorityPort()
      const transactionCount =
        fixture.transport.transactWritePrePlanAuthorityCommands.length
      const sourceTableName =
        fixture.requested.tables['project-directory']
      const original =
        fixture.transport.describeTableOutputs.get(sourceTableName)
      if (original === undefined) {
        throw new Error('Expected original source table identity.')
      }
      fixture.transport.describeTableOutputs.set(
        sourceTableName,
        createReplacementDescribeTableOutput(
          'project-directory',
          sourceTableName,
          fixture.requested,
        ),
      )

      const failure = await captureWorkspaceSearchMigrationFailure(
        publicationPort.publish(fixture.publishInput),
      )

      expect(failure).toMatchObject({
        code: 'SOURCE_DRIFT',
        message:
          'Workspace Search sealed planning authority publication failed.',
      })
      expect(
        fixture.transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount)

      fixture.transport.describeTableOutputs.set(
        sourceTableName,
        original,
      )
      const published = await publicationPort.publish(
        fixture.publishInput,
      )

      expect(published.runId).toBe(fixture.publishInput.runId)
      expect(
        fixture.transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      expect(
        fixture.transport.transactWritePrePlanAuthorityCommands[
          transactionCount
        ]?.input.TransactItems,
      ).toHaveLength(9)
      fixture.port.close()
    },
  )

  test(
    'bootstraps the managed writer fence and closes through a fixed boundary',
    async () => {
      const requested = createRequestedResources()
      const transport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(transport, requested)
      const clockAt = '2026-07-29T01:00:00.000Z'
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        requested,
        () => transport,
        () => new Date(clockAt),
      )
      const expectedWriterFenceFailure =
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search application writer fence operation failed.',
        )
      const expectedExecutionBoundaryFailure =
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search migration execution boundary operation failed.',
        )

      expect(
        () => port.createApplicationWriterFencePort(),
      ).toThrow(expectedWriterFenceFailure)
      expect(
        () => port.createExecutionBoundaryPort(),
      ).toThrow(expectedExecutionBoundaryFailure)

      const configuration = await port.measureConfiguration()
      configuration.tables['project-directory'].tableId =
        'caller-mutated-project-directory-table-id'
      const authority = await createManagedPlanningAuthority(
        port,
        clockAt,
        'managed-writer-fence',
      )
      const writerFence = port.createApplicationWriterFencePort()
      const executionBoundary = port.createExecutionBoundaryPort()
      expect(Reflect.get(writerFence, 'close')).toBeUndefined()
      const transactionCount =
        transport.transactWritePrePlanAuthorityCommands.length
      const guardTrace: string[] = []
      transport.describeTableEffect = (tableName) => {
        guardTrace.push(tableName)
      }

      const bootstrapped = await writerFence.bootstrapOpen(authority)
      const read = await writerFence.read()
      const bootstrappedAgain =
        await writerFence.bootstrapOpen(authority)
      const closedBoundary =
        await executionBoundary.close(authority)
      const closedBoundaryAgain =
        await executionBoundary.close(authority)
      const closedFence = await writerFence.read()

      expect(bootstrapped).toMatchObject({
        status: 'present',
        record: {
          mode: 'open',
          writerEpoch: 1,
          controlRevision: 1,
          binding: {
            stateTableName: requested.tables['migration-state'],
            tableIds: {
              'project-directory': 'table-id-project-directory-v1',
            },
          },
        },
      })
      expect(read).toEqual(bootstrapped)
      expect(bootstrappedAgain).toEqual(bootstrapped)
      expect(closedBoundary).toMatchObject({
        runId: authority.lease.runId,
        phase: 'closed',
        revision: 1,
        closeAuthority: {
          runId: authority.lease.runId,
          ownerId: authority.lease.ownerId,
          leaseFenceToken: authority.lease.fenceToken,
          maintenanceEvidenceReceiptDigest:
            authority.maintenanceEvidenceReceiptDigest,
          maintenanceEvidencePointerRevision:
            authority.maintenanceEvidencePointerRevision,
        },
      })
      expect(closedBoundaryAgain).toEqual(closedBoundary)
      expect(closedFence).toMatchObject({
        status: 'present',
        record: {
          mode: 'closed',
          writerEpoch: 2,
          controlRevision: 2,
          authority: {
            runId: authority.lease.runId,
            ownerId: authority.lease.ownerId,
            leaseFenceToken: authority.lease.fenceToken,
            maintenanceEvidenceReceiptDigest:
              authority.maintenanceEvidenceReceiptDigest,
            maintenanceEvidencePointerRevision:
              authority.maintenanceEvidencePointerRevision,
          },
        },
      })
      await expect(
        executionBoundary.read(authority.lease.runId),
      ).resolves.toEqual(closedBoundary)
      expect(Reflect.get(writerFence, 'release')).toBeUndefined()
      expect(
        transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 2)
      const closeItems =
        transport.transactWritePrePlanAuthorityCommands[
          transactionCount + 1
        ]?.input.TransactItems
      expect(closeItems).toHaveLength(10)
      expect(closeItems?.[9]?.Put?.Item).toMatchObject({
        kind: {
          S: 'workspace-search-migration-execution-boundary-publication',
        },
        runId: { S: authority.lease.runId },
        phase: { S: 'closed' },
        revision: { N: '1' },
      })
      const expectedGuardOrder = [
        requested.tables['migration-state'],
        requested.tables['project-directory'],
        requested.tables['work-items'],
        requested.tables.collaboration,
        requested.tables.documents,
        requested.tables['workspace-search'],
      ]
      expect(guardTrace.length).toBeGreaterThan(0)
      expect(guardTrace.length % expectedGuardOrder.length).toBe(0)
      for (
        let offset = 0;
        offset < guardTrace.length;
        offset += expectedGuardOrder.length
      ) {
        expect(
          guardTrace.slice(offset, offset + expectedGuardOrder.length),
        ).toEqual(expectedGuardOrder)
      }
      port.close()
    },
  )

  test(
    'recovers managed planning admission after a post-commit response loss',
    async () => {
      const requested = createRequestedResources()
      const transport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(transport, requested)
      let clockAt = '2026-07-29T03:00:00.000Z'
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        requested,
        () => transport,
        () => new Date(clockAt),
      )
      await port.measureConfiguration()
      const closeAuthority = await createManagedPlanningAuthority(
        port,
        clockAt,
        'managed-execution-admission',
      )
      const writerFence = port.createApplicationWriterFencePort()
      await writerFence.bootstrapOpen(closeAuthority)
      const executionBoundary = port.createExecutionBoundaryPort()
      const closed = await executionBoundary.close(closeAuthority)

      expect(closed).toMatchObject({
        phase: 'closed',
        revision: 1,
        closedAt: clockAt,
      })

      clockAt = '2026-07-29T03:16:00.000Z'
      const admissionLease = await port.acquireLease({
        runId: closeAuthority.lease.runId,
        ownerId: 'managed-execution-admission-recovery-owner',
      })
      const maintenanceEvidenceBytes =
        createManagedMaintenanceEvidenceBytes(clockAt)
      const admissionAuthority =
        await port.renewMaintenanceEvidence({
          lease: {
            runId: admissionLease.runId,
            ownerId: admissionLease.ownerId,
            fenceToken: admissionLease.fenceToken,
          },
          expectedPointer: null,
          evidenceBytes: maintenanceEvidenceBytes,
        })
      const transactionCount =
        transport.transactWritePrePlanAuthorityCommands.length
      let responseLost = false
      transport.transactWritePrePlanAuthorityPostCommitEffect = () => {
        responseLost = true
        transport.transactWritePrePlanAuthorityPostCommitEffect =
          undefined
        throw new Error('redacted managed admission response loss')
      }

      const admitted = await executionBoundary.admitPlanning({
        currentAuthority: admissionAuthority,
        maintenanceEvidenceBytes,
      })

      expect(responseLost).toBe(true)
      expect(admitted).toMatchObject({
        runId: closeAuthority.lease.runId,
        phase: 'planning-admitted',
        revision: 2,
        planningAdmission: {
          ownerId: admissionAuthority.lease.ownerId,
          leaseFenceToken: admissionAuthority.lease.fenceToken,
          admittedAt: clockAt,
          drainStartedAt: closed.closedAt,
        },
      })
      expect(
        transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      const admissionItems =
        transport.transactWritePrePlanAuthorityCommands[
          transactionCount
        ]?.input.TransactItems
      expect(admissionItems).toHaveLength(10)
      expect(admissionItems?.[3]?.ConditionCheck).toBeDefined()
      expect(admissionItems?.[9]?.Put?.Item).toMatchObject({
        kind: {
          S: 'workspace-search-migration-execution-boundary-publication',
        },
        runId: { S: closeAuthority.lease.runId },
        phase: { S: 'planning-admitted' },
        revision: { N: '2' },
      })
      await expect(
        executionBoundary.read(closeAuthority.lease.runId),
      ).resolves.toEqual(admitted)
      port.close()
    },
  )

  const writerFenceReplacementCases: readonly {
    readonly role: WorkspaceSearchMigrationTableRole
    readonly expectedCode:
      | 'CONFIGURATION_DRIFT'
      | 'SOURCE_DRIFT'
      | 'TARGET_DRIFT'
  }[] = [
    {
      role: 'migration-state',
      expectedCode: 'CONFIGURATION_DRIFT',
    },
    {
      role: 'project-directory',
      expectedCode: 'SOURCE_DRIFT',
    },
    {
      role: 'work-items',
      expectedCode: 'SOURCE_DRIFT',
    },
    {
      role: 'collaboration',
      expectedCode: 'SOURCE_DRIFT',
    },
    {
      role: 'documents',
      expectedCode: 'SOURCE_DRIFT',
    },
    {
      role: 'workspace-search',
      expectedCode: 'TARGET_DRIFT',
    },
  ]
  for (const candidate of writerFenceReplacementCases) {
    test(
      `rejects a same-name ${candidate.role} replacement before a writer-fence read`,
      async () => {
        const requested = createRequestedResources()
        const transport = new RecordingIdentityAwsTransport()
        seedValidMeasurementOutputs(transport, requested)
        const clockAt = '2026-07-29T01:10:00.000Z'
        const port = createAwsWorkspaceSearchMigrationIdentityPort(
          requested,
          () => transport,
          () => new Date(clockAt),
        )
        await port.measureConfiguration()
        const authority = await createManagedPlanningAuthority(
          port,
          clockAt,
          `managed-writer-fence-drift-${candidate.role}`,
        )
        const writerFence = port.createApplicationWriterFencePort()
        await writerFence.bootstrapOpen(authority)
        const readCount = transport.getPrePlanAuthorityCommands.length
        const transactionCount =
          transport.transactWritePrePlanAuthorityCommands.length
        const tableName = requested.tables[candidate.role]
        transport.describeTableOutputs.set(
          tableName,
          createReplacementDescribeTableOutput(
            candidate.role,
            tableName,
            requested,
          ),
        )

        await expect(writerFence.read()).rejects.toMatchObject({
          code: candidate.expectedCode,
          message:
            'Workspace Search application writer fence operation failed.',
        })
        expect(transport.getPrePlanAuthorityCommands)
          .toHaveLength(readCount)
        expect(transport.transactWritePrePlanAuthorityCommands)
          .toHaveLength(transactionCount)
        port.close()
      },
    )
  }

  test(
    'detaches execution-boundary close input before managed guard I/O',
    async () => {
      const requested = createRequestedResources()
      const transport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(transport, requested)
      const clockAt = '2026-07-29T01:20:00.000Z'
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        requested,
        () => transport,
        () => new Date(clockAt),
      )
      await port.measureConfiguration()
      const authority = await createManagedPlanningAuthority(
        port,
        clockAt,
        'managed-writer-fence-detach',
      )
      const writerFence = port.createApplicationWriterFencePort()
      await writerFence.bootstrapOpen(authority)
      const executionBoundary = port.createExecutionBoundaryPort()
      const mutableAuthority = structuredClone(authority)
      const expectedRunId = mutableAuthority.lease.runId
      const expectedOwnerId = mutableAuthority.lease.ownerId
      let authorityMutated = false
      transport.describeTableEffect = () => {
        if (authorityMutated) return
        authorityMutated = true
        Object.defineProperty(mutableAuthority.lease, 'runId', {
          value: 'caller-mutated-execution-boundary-run',
        })
        Object.defineProperty(mutableAuthority.lease, 'ownerId', {
          value: 'caller-mutated-execution-boundary-owner',
        })
      }

      const closed =
        await executionBoundary.close(mutableAuthority)

      expect(closed).toMatchObject({
        runId: expectedRunId,
        phase: 'closed',
        revision: 1,
      })
      expect(closed.closeAuthority).toMatchObject({
        runId: expectedRunId,
        ownerId: expectedOwnerId,
      })
      await expect(
        executionBoundary.read(expectedRunId),
      ).resolves.toEqual(closed)
      expect(authorityMutated).toBe(true)
      port.close()
    },
  )

  test(
    'invalidates execution-boundary ports across lifecycle races',
    async () => {
      const closeRequested = createRequestedResources()
      const closeTransport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(closeTransport, closeRequested)
      const closeClockAt = '2026-07-29T01:30:00.000Z'
      const closePort = createAwsWorkspaceSearchMigrationIdentityPort(
        closeRequested,
        () => closeTransport,
        () => new Date(closeClockAt),
      )
      await closePort.measureConfiguration()
      const closeAuthority = await createManagedPlanningAuthority(
        closePort,
        closeClockAt,
        'managed-writer-fence-close-race',
      )
      const closingWriterFence =
        closePort.createApplicationWriterFencePort()
      await closingWriterFence.bootstrapOpen(closeAuthority)
      const closingExecutionBoundary =
        closePort.createExecutionBoundaryPort()
      closeTransport.getPrePlanAuthorityEffect = () => closePort.close()

      await expect(
        closingExecutionBoundary.read(closeAuthority.lease.runId),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message:
          'Workspace Search migration execution boundary operation failed.',
      })
      expect(closeTransport.closeCount).toBe(1)

      const remeasureRequested = createRequestedResources()
      const remeasureTransport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(remeasureTransport, remeasureRequested)
      const remeasureClockAt = '2026-07-29T01:40:00.000Z'
      const remeasurePort = createAwsWorkspaceSearchMigrationIdentityPort(
        remeasureRequested,
        () => remeasureTransport,
        () => new Date(remeasureClockAt),
      )
      await remeasurePort.measureConfiguration()
      const remeasureAuthority = await createManagedPlanningAuthority(
        remeasurePort,
        remeasureClockAt,
        'managed-writer-fence-remeasure-race',
      )
      const bootstrapWriterFence =
        remeasurePort.createApplicationWriterFencePort()
      await bootstrapWriterFence.bootstrapOpen(remeasureAuthority)
      const staleExecutionBoundary =
        remeasurePort.createExecutionBoundaryPort()
      let replacementMeasurement:
        Promise<WorkspaceSearchMigrationConfiguration> | undefined
      remeasureTransport.getPrePlanAuthorityEffect = () => {
        remeasureTransport.getPrePlanAuthorityEffect = undefined
        replacementMeasurement = remeasurePort.measureConfiguration()
      }

      await expect(
        staleExecutionBoundary.read(remeasureAuthority.lease.runId),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message:
          'Workspace Search migration execution boundary operation failed.',
      })
      if (replacementMeasurement === undefined) {
        throw new Error(
          'Expected replacement execution-boundary measurement.',
        )
      }
      await replacementMeasurement
      const readCount =
        remeasureTransport.getPrePlanAuthorityCommands.length
      await expect(
        staleExecutionBoundary.read(remeasureAuthority.lease.runId),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message:
          'Workspace Search migration execution boundary operation failed.',
      })
      expect(remeasureTransport.getPrePlanAuthorityCommands)
        .toHaveLength(readCount)
      const replacementExecutionBoundary =
        remeasurePort.createExecutionBoundaryPort()
      await expect(
        replacementExecutionBoundary.read(
          remeasureAuthority.lease.runId,
        ),
      ).resolves.toBeUndefined()
      remeasurePort.close()
    },
  )

  test(
    'quarantines execution control after post-commit identity drift',
    async () => {
      const requested = createRequestedResources()
      const transport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(transport, requested)
      const clockAt = '2026-07-29T01:50:00.000Z'
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        requested,
        () => transport,
        () => new Date(clockAt),
      )
      await port.measureConfiguration()
      const authority = await createManagedPlanningAuthority(
        port,
        clockAt,
        'managed-writer-fence-quarantine',
      )
      const writerFence = port.createApplicationWriterFencePort()
      await writerFence.bootstrapOpen(authority)
      const executionBoundary = port.createExecutionBoundaryPort()
      const transactionCount =
        transport.transactWritePrePlanAuthorityCommands.length
      const targetTableName = requested.tables['workspace-search']
      const originalTarget =
        transport.describeTableOutputs.get(targetTableName)
      if (originalTarget === undefined) {
        throw new Error('Expected measured writer-fence target identity.')
      }
      let postCommitDriftInjected = false
      transport.transactWritePrePlanAuthorityPostCommitEffect = () => {
        if (postCommitDriftInjected) return
        postCommitDriftInjected = true
        transport.describeTableOutputs.set(
          targetTableName,
          createReplacementDescribeTableOutput(
            'workspace-search',
            targetTableName,
            requested,
          ),
        )
      }

      const failure = await captureWorkspaceSearchMigrationFailure(
        executionBoundary.close(authority),
      )

      expect(failure).toMatchObject({
        code: 'TARGET_DRIFT',
        message:
          'Workspace Search migration execution boundary operation failed.',
      })
      expect(postCommitDriftInjected).toBe(true)
      expect(
        transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      transport.transactWritePrePlanAuthorityPostCommitEffect = undefined
      transport.describeTableOutputs.set(targetTableName, originalTarget)
      const readCount = transport.getPrePlanAuthorityCommands.length
      expect(
        () => port.createApplicationWriterFencePort(),
      ).toThrow(
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search application writer fence operation failed.',
        ),
      )
      expect(
        () => port.createExecutionBoundaryPort(),
      ).toThrow(
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search migration execution boundary operation failed.',
        ),
      )
      await expect(writerFence.read()).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message:
          'Workspace Search application writer fence operation failed.',
      })
      await expect(
        executionBoundary.read(authority.lease.runId),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message:
          'Workspace Search migration execution boundary operation failed.',
      })
      expect(transport.getPrePlanAuthorityCommands).toHaveLength(readCount)

      await port.measureConfiguration()
      const recoveredExecutionBoundary =
        port.createExecutionBoundaryPort()
      await expect(
        recoveredExecutionBoundary.read(authority.lease.runId),
      ).resolves.toMatchObject({
        runId: authority.lease.runId,
        phase: 'closed',
        revision: 1,
      })
      const recoveredWriterFence =
        port.createApplicationWriterFencePort()
      await expect(recoveredWriterFence.read()).resolves.toMatchObject({
        status: 'present',
        record: {
          mode: 'closed',
          authority: {
            runId: authority.lease.runId,
          },
        },
      })
      port.close()
    },
  )

  test(
    'revalidates all six tables before an execution-boundary transition',
    async () => {
      const requested = createRequestedResources()
      const transport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(transport, requested)
      const clockAt = '2026-07-29T02:00:00.000Z'
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        requested,
        () => transport,
        () => new Date(clockAt),
      )
      await port.measureConfiguration()
      const authority = await createManagedPlanningAuthority(
        port,
        clockAt,
        'managed-writer-fence-pre-send',
      )
      const writerFence = port.createApplicationWriterFencePort()
      await writerFence.bootstrapOpen(authority)
      const executionBoundary = port.createExecutionBoundaryPort()
      const transactionCount =
        transport.transactWritePrePlanAuthorityCommands.length
      const sourceTableName = requested.tables['project-directory']
      const originalSource =
        transport.describeTableOutputs.get(sourceTableName)
      if (originalSource === undefined) {
        throw new Error('Expected measured writer-fence source identity.')
      }
      let describeCount = 0
      // Close guards three stabilizing reads before and after I/O (36 checks).
      // Check 37 starts the pre-send guard; check 38 is project-directory.
      transport.describeTableEffect = (tableName) => {
        describeCount += 1
        if (
          describeCount === 37 &&
          tableName === requested.tables['migration-state']
        ) {
          transport.describeTableOutputs.set(
            sourceTableName,
            createReplacementDescribeTableOutput(
              'project-directory',
              sourceTableName,
              requested,
            ),
          )
        }
      }

      await expect(
        executionBoundary.close(authority),
      ).rejects.toMatchObject({
        code: 'SOURCE_DRIFT',
        message:
          'Workspace Search migration execution boundary operation failed.',
      })
      expect(describeCount).toBe(38)
      expect(
        transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount)

      transport.describeTableEffect = undefined
      transport.describeTableOutputs.set(sourceTableName, originalSource)
      await expect(
        executionBoundary.close(authority),
      ).resolves.toMatchObject({
        runId: authority.lease.runId,
        phase: 'closed',
        revision: 1,
      })
      expect(
        transport.transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      expect(
        transport.transactWritePrePlanAuthorityCommands[
          transactionCount
        ]?.input.TransactItems,
      ).toHaveLength(10)
      port.close()
    },
  )

  test(
    'routes one fixed execution-run admission through the managed transport',
    async () => {
      const fixture =
        await createManagedExecutionRunFixture('managed-success')
      const executionRun = fixture.port.createExecutionRunPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.planSeal,
        fixture.closedWriterFenceRecord,
      )
      const transactionCount =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length
      const guardTrace: string[] = []
      fixture.transport.describeTableEffect = (tableName) => {
        guardTrace.push(tableName)
      }

      const created = await executionRun.create(
        fixture.currentAuthority,
      )

      expect(created).toMatchObject({
        runId: fixture.currentAuthority.lease.runId,
        revision: 1,
        status: 'applying',
        binding: {
          executionBoundaryDigest:
            fixture.executionBoundary.boundaryDigest,
          sealedPlanningAuthorityDigest:
            fixture.sealedPlanningAuthority.authorityDigest,
          closedWriterFenceRecordDigest:
            fixture.closedWriterFenceRecord.recordDigest,
        },
      })
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      const command =
        fixture.transport
          .transactWritePrePlanAuthorityCommands[transactionCount]
      const items = command?.input.TransactItems
      expect(items).toHaveLength(7)
      expect(
        items?.slice(0, 6).every(
          (item) => item.ConditionCheck !== undefined,
        ),
      ).toBe(true)
      expect(items?.[6]?.Put?.Item).toMatchObject({
        kind: {
          S: 'workspace-search-migration-execution-run-state',
        },
        runId: { S: fixture.currentAuthority.lease.runId },
        revision: { N: '1' },
        status: { S: 'applying' },
      })
      const expectedGuardOrder = [
        fixture.requested.tables['migration-state'],
        fixture.requested.tables['project-directory'],
        fixture.requested.tables['work-items'],
        fixture.requested.tables.collaboration,
        fixture.requested.tables.documents,
        fixture.requested.tables['workspace-search'],
      ]
      expect(guardTrace.length).toBeGreaterThan(0)
      expect(guardTrace.length % expectedGuardOrder.length).toBe(0)
      for (
        let offset = 0;
        offset < guardTrace.length;
        offset += expectedGuardOrder.length
      ) {
        expect(
          guardTrace.slice(
            offset,
            offset + expectedGuardOrder.length,
          ),
        ).toEqual(expectedGuardOrder)
      }
      await expect(
        executionRun.read(fixture.currentAuthority.lease.runId),
      ).resolves.toEqual(created)
      fixture.port.close()
    },
  )

  test(
    'preserves managed execution-run reconciliation and cancellation mapping',
    async () => {
      const responseLoss =
        await createManagedExecutionRunFixture(
          'managed-response-loss',
        )
      const responseLossPort =
        responseLoss.port.createExecutionRunPort(
          responseLoss.executionBoundary,
          responseLoss.sealedPlanningAuthority,
          responseLoss.planSeal,
          responseLoss.closedWriterFenceRecord,
        )
      const responseLossReads =
        responseLoss.transport.getPrePlanAuthorityCommands.length
      const responseLossTransactions =
        responseLoss.transport
          .transactWritePrePlanAuthorityCommands.length
      responseLoss.transport
        .transactWritePrePlanAuthorityPostCommitEffect = () => {
          throw new Error(
            'MANAGED-EXECUTION-RUN-RESPONSE-LOSS-DO-NOT-LEAK',
          )
        }

      const recovered = await responseLossPort.create(
        responseLoss.currentAuthority,
      )

      expect(recovered).toMatchObject({
        runId: responseLoss.currentAuthority.lease.runId,
        revision: 1,
        status: 'applying',
      })
      expect(
        responseLoss.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(responseLossReads + 2)
      expect(
        responseLoss.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(responseLossTransactions + 1)
      responseLoss.port.close()

      const cancellation =
        await createManagedExecutionRunFixture(
          'managed-cancellation',
        )
      const cancellationPort =
        cancellation.port.createExecutionRunPort(
          cancellation.executionBoundary,
          cancellation.sealedPlanningAuthority,
          cancellation.planSeal,
          cancellation.closedWriterFenceRecord,
        )
      const cancellationReads =
        cancellation.transport.getPrePlanAuthorityCommands.length
      const cancellationTransactions =
        cancellation.transport
          .transactWritePrePlanAuthorityCommands.length
      const canary =
        'MANAGED-EXECUTION-RUN-CANCELLATION-DO-NOT-LEAK'
      cancellation.transport.transactWritePrePlanAuthorityEffect =
        () => {
          throw new TransactionCanceledException({
            $metadata: {},
            message: canary,
            CancellationReasons: Array.from(
              {
                length:
                  workspaceSearchMigrationExecutionRunTransactionIndex
                    .count,
              },
              (_, index) => ({
                Code: index ===
                    workspaceSearchMigrationExecutionRunTransactionIndex
                      .lease
                  ? 'ConditionalCheckFailed'
                  : 'None',
              }),
            ),
          })
        }

      const failure =
        await captureWorkspaceSearchMigrationFailure(
          cancellationPort.create(cancellation.currentAuthority),
        )

      expect(failure).toMatchObject({
        code: 'LEASE_LOST',
        message:
          'Workspace Search migration execution run operation failed.',
      })
      expect(failure.message).not.toContain(canary)
      expect(
        cancellation.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(cancellationReads + 2)
      expect(
        cancellation.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(cancellationTransactions + 1)
      cancellation.port.close()
    },
  )

  test(
    'classifies a missing managed execution-run state table safely',
    async () => {
      const fixture =
        await createManagedExecutionRunFixture(
          'managed-state-missing',
        )
      const executionRun = fixture.port.createExecutionRunPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.planSeal,
        fixture.closedWriterFenceRecord,
      )
      const reads =
        fixture.transport.getPrePlanAuthorityCommands.length
      const canary =
        'MANAGED-EXECUTION-RUN-STATE-MISSING-DO-NOT-LEAK'
      fixture.transport.getPrePlanAuthorityEffect = () => {
        throw new ResourceNotFoundException({
          $metadata: {},
          message: canary,
        })
      }

      const failure =
        await captureWorkspaceSearchMigrationFailure(
          executionRun.read(fixture.currentAuthority.lease.runId),
        )

      expect(failure).toMatchObject({
        code: 'CONFIGURATION_DRIFT',
        message:
          'Workspace Search migration execution run operation failed.',
      })
      expect(failure.message).not.toContain(canary)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(reads + 1)
      fixture.port.close()
    },
  )

  test(
    'preserves a raw transient managed execution-run read failure',
    async () => {
      const fixture =
        await createManagedExecutionRunFixture(
          'managed-read-transient',
        )
      const executionRun = fixture.port.createExecutionRunPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.planSeal,
        fixture.closedWriterFenceRecord,
      )
      const reads =
        fixture.transport.getPrePlanAuthorityCommands.length
      const canary =
        'MANAGED-EXECUTION-RUN-READ-TRANSIENT-DO-NOT-LEAK'
      const retryable = new Error(canary)
      retryable.name = 'ThrottlingException'
      fixture.transport.getPrePlanAuthorityEffect = () => {
        throw retryable
      }

      const failure =
        await captureWorkspaceSearchMigrationFailure(
          executionRun.read(fixture.currentAuthority.lease.runId),
        )

      expect(failure).toMatchObject({
        code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
        message:
          'Workspace Search migration execution run operation failed.',
      })
      expect(failure.message).not.toContain(canary)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(reads + 1)
      fixture.port.close()
    },
  )

  test(
    'preserves a transient managed execution-run table guard failure',
    async () => {
      const fixture =
        await createManagedExecutionRunFixture(
          'managed-guard-transient',
        )
      const executionRun = fixture.port.createExecutionRunPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.planSeal,
        fixture.closedWriterFenceRecord,
      )
      const reads =
        fixture.transport.getPrePlanAuthorityCommands.length
      const canary =
        'MANAGED-EXECUTION-RUN-GUARD-TRANSIENT-DO-NOT-LEAK'
      const retryable = new Error(canary)
      retryable.name = 'TimeoutError'
      fixture.transport.describeTableFailures.set(
        fixture.requested.tables['migration-state'],
        retryable,
      )

      const failure =
        await captureWorkspaceSearchMigrationFailure(
          executionRun.read(fixture.currentAuthority.lease.runId),
        )

      expect(failure).toMatchObject({
        code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
        message:
          'Workspace Search migration execution run operation failed.',
      })
      expect(failure.message).not.toContain(canary)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(reads)
      fixture.port.close()
    },
  )

  test(
    'gates execution-run factories and ports across managed lifecycle changes',
    async () => {
      const fixture =
        await createManagedExecutionRunFixture('managed-lifecycle')
      const unmeasuredTransport =
        new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(
        unmeasuredTransport,
        fixture.requested,
      )
      const unmeasured =
        createAwsWorkspaceSearchMigrationIdentityPort(
          fixture.requested,
          () => unmeasuredTransport,
          () => new Date('2026-07-28T07:16:30.000Z'),
        )
      const expectedFailure =
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search migration execution run operation failed.',
        )

      expect(() =>
        unmeasured.createExecutionRunPort(
          fixture.executionBoundary,
          fixture.sealedPlanningAuthority,
          fixture.planSeal,
          fixture.closedWriterFenceRecord,
        ),
      ).toThrow(expectedFailure)
      unmeasured.close()

      const stale = fixture.port.createExecutionRunPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.planSeal,
        fixture.closedWriterFenceRecord,
      )
      await fixture.port.measureConfiguration()
      const readsAfterMeasurement =
        fixture.transport.getPrePlanAuthorityCommands.length
      await expect(
        stale.read(fixture.currentAuthority.lease.runId),
      ).rejects.toEqual(expectedFailure)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(readsAfterMeasurement)

      const replacement = fixture.port.createExecutionRunPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.planSeal,
        fixture.closedWriterFenceRecord,
      )
      await expect(
        replacement.read(fixture.currentAuthority.lease.runId),
      ).resolves.toBeUndefined()
      const readsBeforeClose =
        fixture.transport.getPrePlanAuthorityCommands.length
      fixture.port.close()
      await expect(
        replacement.read(fixture.currentAuthority.lease.runId),
      ).rejects.toEqual(expectedFailure)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(readsBeforeClose)
    },
  )

  test(
    'quarantines execution-run admission after post-commit identity drift',
    async () => {
      const fixture =
        await createManagedExecutionRunFixture('managed-quarantine')
      const executionRun = fixture.port.createExecutionRunPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.planSeal,
        fixture.closedWriterFenceRecord,
      )
      const transactionCount =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length
      const targetTableName =
        fixture.requested.tables['workspace-search']
      const originalTarget =
        fixture.transport.describeTableOutputs.get(targetTableName)
      if (originalTarget === undefined) {
        throw new Error('Expected measured execution-run target identity.')
      }
      let driftInjected = false
      const readsBeforeCreate =
        fixture.transport.getPrePlanAuthorityCommands.length
      fixture.transport
        .transactWritePrePlanAuthorityPostCommitEffect = () => {
          driftInjected = true
          fixture.transport.describeTableOutputs.set(
            targetTableName,
            createReplacementDescribeTableOutput(
              'workspace-search',
              targetTableName,
              fixture.requested,
            ),
          )
        }

      const failure =
        await captureWorkspaceSearchMigrationFailure(
          executionRun.create(fixture.currentAuthority),
        )

      expect(failure).toMatchObject({
        code: 'TARGET_DRIFT',
        message:
          'Workspace Search migration execution run operation failed.',
      })
      expect(driftInjected).toBe(true)
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactionCount + 1)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(readsBeforeCreate + 1)
      fixture.transport
        .transactWritePrePlanAuthorityPostCommitEffect = undefined
      fixture.transport.describeTableOutputs.set(
        targetTableName,
        originalTarget,
      )
      const expectedQuarantineFailure =
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search migration execution run operation failed.',
        )
      expect(() =>
        fixture.port.createExecutionRunPort(
          fixture.executionBoundary,
          fixture.sealedPlanningAuthority,
          fixture.planSeal,
          fixture.closedWriterFenceRecord,
        ),
      ).toThrow(expectedQuarantineFailure)
      const readsWhileQuarantined =
        fixture.transport.getPrePlanAuthorityCommands.length
      await expect(
        executionRun.read(fixture.currentAuthority.lease.runId),
      ).rejects.toEqual(expectedQuarantineFailure)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(readsWhileQuarantined)

      await fixture.port.measureConfiguration()
      const recovered = fixture.port.createExecutionRunPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.planSeal,
        fixture.closedWriterFenceRecord,
      )
      await expect(
        recovered.read(fixture.currentAuthority.lease.runId),
      ).resolves.toMatchObject({
        runId: fixture.currentAuthority.lease.runId,
        revision: 1,
        status: 'applying',
      })
      fixture.port.close()
    },
  )

  test(
    'commits one managed mutation through journal storage and twelve-item send',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture(
          'apply-mutation-success',
          true,
        )
      const apply = fixture.port.createApplyOperationPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.closedWriterFenceRecord,
        fixture.executionRun,
      )
      const journalPuts =
        fixture.transport.putImmutableArtifactCommands.length
      const journalHeads =
        fixture.transport.headImmutableArtifactCommands.length
      const journalGets =
        fixture.transport.getImmutableArtifactCommands.length
      const transactions =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length

      const next = await apply.commitApplyOperation(
        createManagedApplyOperationCommand(fixture),
      )

      expect(next).toMatchObject({
        runId: fixture.currentAuthority.lease.runId,
        revision: 2,
        appliedOperationCount: 1,
        journalSequence: 1,
        status: 'applying',
      })
      expect(
        fixture.transport.putImmutableArtifactCommands,
      ).toHaveLength(journalPuts + 1)
      expect(
        fixture.transport.headImmutableArtifactCommands,
      ).toHaveLength(journalHeads + 1)
      expect(
        fixture.transport.getImmutableArtifactCommands,
      ).toHaveLength(journalGets + 1)
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactions + 1)
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands[
            transactions
          ]?.input.TransactItems,
      ).toHaveLength(12)
      fixture.port.close()
    },
  )

  test(
    'scans and commits one managed source apply checkpoint with all-six guards',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture(
          'apply-source-checkpoint',
        )
      const apply =
        await createManagedApplyCheckpointPort(fixture)
      fixture.transport.scanSourceOutput = {
        $metadata: {},
        Count: 1,
        Items: [createManagedApplySourceItem()],
        ScannedCount: 1,
      }
      const sourceScans =
        fixture.transport.scanSourceCommands.length
      const targetScans =
        fixture.transport.scanTargetCommands.length
      const transactions =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length
      const trace: string[] = []
      fixture.transport.describeTableEffect = (tableName) => {
        trace.push(tableName)
      }
      fixture.transport.scanSourceEffect = () => {
        trace.push('source-checkpoint-scan')
      }
      fixture.transport.transactWritePrePlanAuthorityEffect = () => {
        trace.push('checkpoint-transaction')
      }

      const next = await apply.saveApplyCheckpoint(
        createManagedApplyCheckpointCommand(
          fixture,
          'project-directory',
          2,
        ),
      )

      expect(next).toMatchObject({
        revision: 3,
        appliedOperationCount: 1,
        status: 'applying',
        apply: {
          sources: {
            'project-directory': {
              completed: true,
              aggregate: {
                scanned: 1,
                mapped: 1,
                projected: 1,
                deleted: 0,
                pageCount: 1,
              },
            },
          },
        },
      })
      expect(fixture.transport.scanSourceCommands)
        .toHaveLength(sourceScans + 1)
      expect(fixture.transport.scanTargetCommands)
        .toHaveLength(targetScans)
      expect(
        fixture.transport.scanSourceCommands[sourceScans]?.input,
      ).toEqual({
        TableName:
          fixture.requested.tables['project-directory'],
        ConsistentRead: true,
        Limit: 100,
      })
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactions + 1)
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands[
            transactions
          ]?.input.TransactItems,
      ).toHaveLength(
        workspaceSearchMigrationApplyCheckpointTransactionIndex.count,
      )
      expect(
        workspaceSearchMigrationApplyCheckpointTransactionIndex.count,
      ).toBe(9)

      const scanIndex = trace.indexOf('source-checkpoint-scan')
      const transactionIndex =
        trace.indexOf('checkpoint-transaction')
      expect(scanIndex).toBeGreaterThan(0)
      expect(transactionIndex).toBeGreaterThan(scanIndex)
      const guardsBeforeScan = trace.slice(0, scanIndex)
      const guardsAfterScan =
        trace.slice(scanIndex + 1, transactionIndex)
      const expectedTables = [
        fixture.requested.tables['migration-state'],
        fixture.requested.tables['project-directory'],
        fixture.requested.tables['work-items'],
        fixture.requested.tables.collaboration,
        fixture.requested.tables.documents,
        fixture.requested.tables['workspace-search'],
      ]
      for (const tableName of expectedTables) {
        expect(guardsBeforeScan).toContain(tableName)
        expect(guardsAfterScan).toContain(tableName)
      }
      fixture.port.close()
    },
  )

  test(
    'converts one managed target Scan page into projected apply progress',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture(
          'apply-target-checkpoint',
        )
      const apply =
        await createManagedApplyCheckpointPort(fixture)
      fixture.transport.scanTargetOutput = {
        $metadata: {},
        Count: 1,
        Items: [createManagedApplyTargetItem(false)],
        ScannedCount: 1,
      }
      const sourceScans =
        fixture.transport.scanSourceCommands.length
      const targetScans =
        fixture.transport.scanTargetCommands.length
      const transactions =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length

      const next = await apply.saveApplyCheckpoint(
        createManagedApplyCheckpointCommand(
          fixture,
          'target',
          2,
        ),
      )

      expect(next).toMatchObject({
        revision: 3,
        apply: {
          target: {
            completed: true,
            aggregate: {
              scanned: 1,
              mapped: 1,
              ignored: 0,
              invalid: 0,
              projected: 1,
              deleted: 0,
              pageCount: 1,
            },
          },
        },
      })
      expect(fixture.transport.scanSourceCommands)
        .toHaveLength(sourceScans)
      expect(fixture.transport.scanTargetCommands)
        .toHaveLength(targetScans + 1)
      expect(
        fixture.transport.scanTargetCommands[targetScans]?.input,
      ).toEqual({
        TableName: fixture.requested.tables['workspace-search'],
        ConsistentRead: true,
        Limit: 100,
      })
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands[
            transactions
          ]?.input.TransactItems,
      ).toHaveLength(
        workspaceSearchMigrationApplyCheckpointTransactionIndex.count,
      )
      fixture.port.close()
    },
  )

  test(
    'invalidates pending managed checkpoint scans on close and remeasurement',
    async () => {
      const lifecycles:
        readonly ('close' | 'remeasure')[] =
          ['close', 'remeasure']
      for (const lifecycle of lifecycles) {
        const fixture =
          await createManagedApplyOperationFixture(
            `apply-checkpoint-${lifecycle}`,
          )
        const apply =
          await createManagedApplyCheckpointPort(fixture)
        const deferred = createDeferredScanOutput()
        fixture.transport.scanSourceDeferred = deferred.promise
        const sourceScans =
          fixture.transport.scanSourceCommands.length
        const transactions =
          fixture.transport
            .transactWritePrePlanAuthorityCommands.length
        const pending = apply.saveApplyCheckpoint(
          createManagedApplyCheckpointCommand(
            fixture,
            'project-directory',
            2,
          ),
        )
        await waitForRecordedScanCount(
          fixture.transport,
          sourceScans + 1,
        )
        let replacement:
          Promise<WorkspaceSearchMigrationConfiguration> | undefined
        if (lifecycle === 'close') {
          fixture.port.close()
        } else {
          replacement = fixture.port.measureConfiguration()
        }
        fixture.transport.scanSourceDeferred = undefined
        deferred.resolve(createEmptyScanOutput())

        await expect(pending).rejects.toEqual(
          new WorkspaceSearchMigrationFailure(
            'INVALID_STATE',
            'Workspace Search migration apply operation failed.',
          ),
        )
        expect(
          fixture.transport
            .transactWritePrePlanAuthorityCommands,
        ).toHaveLength(transactions)
        expect(fixture.transport.scanSourceCommands)
          .toHaveLength(sourceScans + 1)
        if (replacement !== undefined) {
          await replacement
          fixture.port.close()
        }
      }
    },
  )

  test(
    'quarantines response-loss after a checkpoint send observes table drift',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture(
          'apply-checkpoint-post-send-drift',
        )
      const apply =
        await createManagedApplyCheckpointPort(fixture)
      fixture.transport.scanSourceOutput = createEmptyScanOutput()
      const targetTableName =
        fixture.requested.tables['workspace-search']
      const originalTarget =
        fixture.transport.describeTableOutputs.get(targetTableName)
      if (originalTarget === undefined) {
        throw new Error('Expected measured apply target identity.')
      }
      const transactions =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length
      const sourceScans =
        fixture.transport.scanSourceCommands.length
      fixture.transport
        .transactWritePrePlanAuthorityPostCommitEffect = () => {
          fixture.transport.describeTableOutputs.set(
            targetTableName,
            createReplacementDescribeTableOutput(
              'workspace-search',
              targetTableName,
              fixture.requested,
            ),
          )
        }

      const failure =
        await captureWorkspaceSearchMigrationFailure(
          apply.saveApplyCheckpoint(
            createManagedApplyCheckpointCommand(
              fixture,
              'project-directory',
              2,
            ),
          ),
        )

      expect(failure).toEqual(
        new WorkspaceSearchMigrationFailure(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
          'Workspace Search migration apply operation failed.',
        ),
      )
      expect(fixture.transport.scanSourceCommands)
        .toHaveLength(sourceScans + 1)
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactions + 1)
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands[
            transactions
          ]?.input.TransactItems,
      ).toHaveLength(
        workspaceSearchMigrationApplyCheckpointTransactionIndex.count,
      )

      fixture.transport
        .transactWritePrePlanAuthorityPostCommitEffect = undefined
      fixture.transport.describeTableOutputs.set(
        targetTableName,
        originalTarget,
      )
      const scans = fixture.transport.scanSourceCommands.length
      const reads =
        fixture.transport.getPrePlanAuthorityCommands.length
      const expectedQuarantineFailure =
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search migration apply operation failed.',
        )
      await expect(apply.readRunState())
        .rejects.toEqual(expectedQuarantineFailure)
      expect(() =>
        fixture.port.createApplyOperationPort(
          fixture.executionBoundary,
          fixture.sealedPlanningAuthority,
          fixture.closedWriterFenceRecord,
          fixture.executionRun,
        ),
      ).toThrow(expectedQuarantineFailure)
      expect(fixture.transport.scanSourceCommands).toHaveLength(scans)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(reads)

      await fixture.port.measureConfiguration()
      const recovered = fixture.port.createApplyOperationPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.closedWriterFenceRecord,
        fixture.executionRun,
      )
      await expect(recovered.readRunState()).resolves.toMatchObject({
        revision: 3,
        apply: {
          sources: {
            'project-directory': {
              completed: true,
              aggregate: { pageCount: 1, scanned: 0 },
            },
          },
        },
      })
      fixture.port.close()
    },
  )

  test(
    'returns terminal checkpoint state without another Scan or transaction',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture(
          'apply-terminal-checkpoint',
        )
      const apply =
        await createManagedApplyCheckpointPort(fixture)
      fixture.transport.scanSourceOutput = createEmptyScanOutput()
      const command = createManagedApplyCheckpointCommand(
        fixture,
        'project-directory',
        2,
      )
      const terminal = await apply.saveApplyCheckpoint(command)
      const scans = fixture.transport.scanSourceCommands.length
      const transactions =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length

      const exactRetry = await apply.saveApplyCheckpoint(command)
      const laterRevision = await apply.saveApplyCheckpoint(
        createManagedApplyCheckpointCommand(
          fixture,
          'project-directory',
          3,
        ),
      )

      expect(terminal).toMatchObject({
        revision: 3,
        apply: {
          sources: {
            'project-directory': {
              completed: true,
              aggregate: { pageCount: 1, scanned: 0 },
            },
          },
        },
      })
      expect(exactRetry).toEqual(terminal)
      expect(laterRevision).toEqual(terminal)
      expect(fixture.transport.scanSourceCommands).toHaveLength(scans)
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactions)
      fixture.port.close()
    },
  )

  test(
    'routes managed apply reads through all six pinned table guards',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture('apply-read-guards')
      const apply = fixture.port.createApplyOperationPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.closedWriterFenceRecord,
        fixture.executionRun,
      )
      const reads =
        fixture.transport.getPrePlanAuthorityCommands.length
      const guardTrace: string[] = []
      fixture.transport.describeTableEffect = (tableName) => {
        guardTrace.push(tableName)
      }

      await expect(apply.readRunState()).resolves.toMatchObject({
        runId: fixture.currentAuthority.lease.runId,
        revision: 1,
        status: 'applying',
      })

      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(reads + 2)
      const expectedTables = [
        fixture.requested.tables['migration-state'],
        fixture.requested.tables['project-directory'],
        fixture.requested.tables['work-items'],
        fixture.requested.tables.collaboration,
        fixture.requested.tables.documents,
        fixture.requested.tables['workspace-search'],
      ]
      for (const tableName of expectedTables) {
        expect(
          guardTrace.filter((candidate) => candidate === tableName),
        ).toHaveLength(4)
      }
      expect(new Set(guardTrace)).toEqual(new Set(expectedTables))
      fixture.port.close()
    },
  )

  test(
    'stops managed apply before send when any measured table is replaced',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture('apply-pre-send-drift')
      const apply = fixture.port.createApplyOperationPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.closedWriterFenceRecord,
        fixture.executionRun,
      )
      const sourceTableName =
        fixture.requested.tables['work-items']
      const originalSource =
        fixture.transport.describeTableOutputs.get(sourceTableName)
      if (originalSource === undefined) {
        throw new Error('Expected measured apply source identity.')
      }
      const transactions =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length
      const journalWrites =
        fixture.transport.putImmutableArtifactCommands.length
      const applyOutput =
        fixture.transport.getPrePlanAuthorityApplyOutput
      fixture.transport.getPrePlanAuthorityApplyOutput = (command) => {
        const output = applyOutput?.(command)
        if (
          command.input.TableName ===
            fixture.requested.tables['workspace-search']
        ) {
          fixture.transport.describeTableOutputs.set(
            sourceTableName,
            createReplacementDescribeTableOutput(
              'work-items',
              sourceTableName,
              fixture.requested,
            ),
          )
        }
        return output
      }

      const failure =
        await captureWorkspaceSearchMigrationFailure(
          apply.commitApplyOperation(
            createManagedApplyOperationCommand(fixture),
          ),
        )

      expect(failure.code).toBe('SOURCE_DRIFT')
      expect(failure.message).toBe(
        'Workspace Search migration apply operation failed.',
      )
      expect(
        fixture.transport.putImmutableArtifactCommands,
      ).toHaveLength(journalWrites)
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactions)
      fixture.transport.getPrePlanAuthorityApplyOutput = applyOutput
      fixture.transport.describeTableOutputs.set(
        sourceTableName,
        originalSource,
      )
      await expect(apply.readRunState()).resolves.toMatchObject({
        revision: 1,
        status: 'applying',
      })
      fixture.port.close()
    },
  )

  test(
    'quarantines every managed execution port after post-send apply drift',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture('apply-post-send-drift')
      const apply = fixture.port.createApplyOperationPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.closedWriterFenceRecord,
        fixture.executionRun,
      )
      const existingExecutionRun =
        fixture.port.createExecutionRunPort(
          fixture.executionBoundary,
          fixture.sealedPlanningAuthority,
          fixture.planSeal,
          fixture.closedWriterFenceRecord,
        )
      const targetTableName =
        fixture.requested.tables['workspace-search']
      const originalTarget =
        fixture.transport.describeTableOutputs.get(targetTableName)
      if (originalTarget === undefined) {
        throw new Error('Expected measured apply target identity.')
      }
      const transactions =
        fixture.transport
          .transactWritePrePlanAuthorityCommands.length
      const expectedGuardOrder = [
        fixture.requested.tables['migration-state'],
        fixture.requested.tables['project-directory'],
        fixture.requested.tables['work-items'],
        fixture.requested.tables.collaboration,
        fixture.requested.tables.documents,
        fixture.requested.tables['workspace-search'],
      ]
      const guardTrace: string[] = []
      let guardCountAtSend = 0
      fixture.transport.describeTableEffect = (tableName) => {
        guardTrace.push(tableName)
      }
      fixture.transport.transactWritePrePlanAuthorityEffect = () => {
        guardCountAtSend = guardTrace.length
        expect(
          guardTrace.slice(-expectedGuardOrder.length),
        ).toEqual(expectedGuardOrder)
      }
      fixture.transport
        .transactWritePrePlanAuthorityPostCommitEffect = () => {
          fixture.transport.describeTableOutputs.set(
            targetTableName,
            createReplacementDescribeTableOutput(
              'workspace-search',
              targetTableName,
              fixture.requested,
            ),
          )
        }

      const failure =
        await captureWorkspaceSearchMigrationFailure(
          apply.commitApplyOperation(
            createManagedApplyOperationCommand(fixture),
          ),
        )

      expect(failure.code)
        .toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
      expect(failure.message).toBe(
        'Workspace Search migration apply operation failed.',
      )
      expect(
        fixture.transport
          .transactWritePrePlanAuthorityCommands,
      ).toHaveLength(transactions + 1)
      expect(guardCountAtSend).toBeGreaterThan(0)
      expect(guardTrace.slice(guardCountAtSend))
        .toEqual(expectedGuardOrder)
      fixture.transport.transactWritePrePlanAuthorityEffect =
        undefined
      fixture.transport
        .transactWritePrePlanAuthorityPostCommitEffect = undefined
      fixture.transport.describeTableOutputs.set(
        targetTableName,
        originalTarget,
      )
      const journalWrites =
        fixture.transport.putImmutableArtifactCommands.length
      const reads =
        fixture.transport.getPrePlanAuthorityCommands.length
      const expectedApplyFailure =
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search migration apply operation failed.',
        )
      const expectedExecutionRunFailure =
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search migration execution run operation failed.',
        )
      await expect(
        apply.commitApplyOperation(
          createManagedApplyOperationCommand(fixture),
        ),
      ).rejects.toEqual(expectedApplyFailure)
      await expect(apply.readRunState())
        .rejects.toEqual(expectedApplyFailure)
      await expect(
        existingExecutionRun.read(
          fixture.currentAuthority.lease.runId,
        ),
      ).rejects.toEqual(expectedExecutionRunFailure)
      expect(() =>
        fixture.port.createApplyOperationPort(
          fixture.executionBoundary,
          fixture.sealedPlanningAuthority,
          fixture.closedWriterFenceRecord,
          fixture.executionRun,
        ),
      ).toThrow(expectedApplyFailure)
      expect(
        fixture.transport.putImmutableArtifactCommands,
      ).toHaveLength(journalWrites)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(reads)

      await fixture.port.measureConfiguration()
      const recovered = fixture.port.createApplyOperationPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.closedWriterFenceRecord,
        fixture.executionRun,
      )
      await expect(recovered.readRunState()).resolves.toMatchObject({
        runId: fixture.currentAuthority.lease.runId,
        revision: 2,
        status: 'applying',
      })
      fixture.port.close()
    },
  )

  test(
    'invalidates stale apply ports across remeasurement and close',
    async () => {
      const fixture =
        await createManagedApplyOperationFixture('apply-lifecycle')
      const stale = fixture.port.createApplyOperationPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.closedWriterFenceRecord,
        fixture.executionRun,
      )
      const expectedFailure =
        new WorkspaceSearchMigrationFailure(
          'INVALID_STATE',
          'Workspace Search migration apply operation failed.',
        )

      await fixture.port.measureConfiguration()
      const readsAfterMeasurement =
        fixture.transport.getPrePlanAuthorityCommands.length
      await expect(stale.readRunState())
        .rejects.toEqual(expectedFailure)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(readsAfterMeasurement)

      const current = fixture.port.createApplyOperationPort(
        fixture.executionBoundary,
        fixture.sealedPlanningAuthority,
        fixture.closedWriterFenceRecord,
        fixture.executionRun,
      )
      await expect(current.readRunState()).resolves.toMatchObject({
        runId: fixture.currentAuthority.lease.runId,
        revision: 1,
        status: 'applying',
      })
      const readsBeforeClose =
        fixture.transport.getPrePlanAuthorityCommands.length
      fixture.port.close()
      await expect(current.readRunState())
        .rejects.toEqual(expectedFailure)
      expect(
        fixture.transport.getPrePlanAuthorityCommands,
      ).toHaveLength(readsBeforeClose)
      expect(() =>
        fixture.port.createApplyOperationPort(
          fixture.executionBoundary,
          fixture.sealedPlanningAuthority,
          fixture.closedWriterFenceRecord,
          fixture.executionRun,
        ),
      ).toThrow(expectedFailure)
    },
  )

  test('stores and replays an empty plan through measured immutable S3', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T00:00:00.000Z'
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => new Date(clockAt),
    )
    const configuration = await port.measureConfiguration()
    const configurationHash =
      createWorkspaceSearchConfigurationHash(configuration)
    const runId = 'measured-artifact-run'
    configuration.journal.bucketName = 'caller-mutated-bucket'
    const gateway = port.createPlanningArtifactGateway(runId)

    const stored = await gateway.writePlanArtifact({
      planSeal: createManagedPlanningArtifactEmptyPlanSeal(
        runId,
        configurationHash,
      ),
      operations: [],
      retainUntil: '2026-08-27T00:01:00.000Z',
    })
    expect(stored.manifestHead).toMatchObject({
      runId,
      configurationHash,
      planOperationCount: 0,
    })
    const replayed = await gateway.replayPlanArtifact({
      planSealReference: stored.planSealReference,
      manifestHeadReference: stored.manifestHeadReference,
    })

    expect(replayed.operations).toEqual([])
    expect(replayed.planSeal).toMatchObject({
      runId,
      configurationHash,
      planOperationCount: 0,
    })
    expect(transport.putImmutableArtifactCommands).toHaveLength(2)
    expect(transport.headImmutableArtifactCommands).toHaveLength(2)
    expect(transport.getImmutableArtifactCommands).toHaveLength(2)
    for (const command of transport.putImmutableArtifactCommands) {
      expect(command.input).toMatchObject({
        Bucket: TEST_BUCKET,
        ExpectedBucketOwner: TEST_ACCOUNT,
        IfNoneMatch: '*',
        ObjectLockMode: 'COMPLIANCE',
      })
    }
    expect(
      transport.headImmutableArtifactCommands.map(
        (command) => command.input.VersionId,
      ),
    ).toEqual([
      stored.planSealReference.versionId,
      stored.manifestHeadReference.versionId,
    ])
    expect(
      transport.getImmutableArtifactCommands.map(
        (command) => command.input.VersionId,
      ),
    ).toEqual([
      stored.planSealReference.versionId,
      stored.manifestHeadReference.versionId,
    ])
    expect(
      transport.putImmutableArtifactAbortSignals.every(
        (signal) => signal instanceof AbortSignal,
      ),
    ).toBe(true)
    expect(
      transport.headImmutableArtifactAbortSignals.every(
        (signal) => signal instanceof AbortSignal,
      ),
    ).toBe(true)
    expect(
      transport.getImmutableArtifactAbortSignals.every(
        (signal) => signal instanceof AbortSignal,
      ),
    ).toBe(true)
    port.close()
  })

  test('invalidates stale planning gateways and replacement-time factories', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const clockAt = '2026-07-28T00:00:00.000Z'
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
      () => new Date(clockAt),
    )
    const firstConfiguration = await port.measureConfiguration()
    const firstHash =
      createWorkspaceSearchConfigurationHash(firstConfiguration)
    const runId = 'stale-artifact-run'
    const staleGateway = port.createPlanningArtifactGateway(runId)

    const replacementMeasurement = port.measureConfiguration()
    expect(
      () => port.createPlanningArtifactGateway(runId),
    ).toThrow(
      new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
      ),
    )
    const replacementConfiguration = await replacementMeasurement
    expect(
      createWorkspaceSearchConfigurationHash(replacementConfiguration),
    ).toBe(firstHash)
    await expect(
      staleGateway.writePlanArtifact({
        planSeal: createManagedPlanningArtifactEmptyPlanSeal(
          runId,
          firstHash,
        ),
        operations: [],
        retainUntil: '2026-08-27T00:01:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
    })
    expect(transport.putImmutableArtifactCommands).toHaveLength(0)
    expect(transport.headImmutableArtifactCommands).toHaveLength(0)
    expect(transport.getImmutableArtifactCommands).toHaveLength(0)

    const currentGateway =
      port.createPlanningArtifactGateway('closed-artifact-run')
    port.close()
    expect(
      () => port.createPlanningArtifactGateway('closed-factory-run'),
    ).toThrow(
      new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Workspace Search migration AWS session is no longer active.',
      ),
    )
    await expect(
      currentGateway.writePlanArtifact({
        planSeal: createManagedPlanningArtifactEmptyPlanSeal(
          'closed-artifact-run',
          firstHash,
        ),
        operations: [],
        retainUntil: '2026-08-27T00:01:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
    })
    expect(transport.putImmutableArtifactCommands).toHaveLength(0)
    expect(transport.closeCount).toBe(1)
  })

  test('invalidates every immutable S3 phase on close or remeasurement', async () => {
    const phases = ['put', 'head', 'get'] as const
    const lifecycles = ['close', 'remeasure'] as const

    for (const phase of phases) {
      for (const lifecycle of lifecycles) {
        const requested = createRequestedResources()
        const transport = new RecordingIdentityAwsTransport()
        seedValidMeasurementOutputs(transport, requested)
        const clockAt = '2026-07-28T00:00:00.000Z'
        const port = createAwsWorkspaceSearchMigrationIdentityPort(
          requested,
          () => transport,
          () => new Date(clockAt),
        )
        const configuration = await port.measureConfiguration()
        const configurationHash =
          createWorkspaceSearchConfigurationHash(configuration)
        const runId = `artifact-${phase}-${lifecycle}`
        const gateway = port.createPlanningArtifactGateway(runId)
        const cancellableBody = phase === 'get'
          ? new CancellableImmutableArtifactBody()
          : undefined
        transport.immutableArtifactGetBody = cancellableBody
        const writeInput = {
          planSeal: createManagedPlanningArtifactEmptyPlanSeal(
            runId,
            configurationHash,
          ),
          operations: [],
          retainUntil: '2026-08-27T00:01:00.000Z',
        }
        let replacementMeasurement:
          Promise<WorkspaceSearchMigrationConfiguration> | undefined
        const invalidate = (): void => {
          if (lifecycle === 'close') {
            port.close()
            return
          }
          replacementMeasurement = port.measureConfiguration()
        }

        if (phase === 'put') {
          transport.putImmutableArtifactEffect = invalidate
          await expect(
            gateway.writePlanArtifact(writeInput),
          ).rejects.toMatchObject({
            code: 'INVALID_STATE',
            message:
              'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
          })
          expect(transport.putImmutableArtifactCommands).toHaveLength(1)
          expect(transport.headImmutableArtifactCommands).toHaveLength(0)
          expect(transport.getImmutableArtifactCommands).toHaveLength(0)
        } else if (phase === 'head') {
          transport.headImmutableArtifactEffect = () => {
            if (transport.headImmutableArtifactCommands.length === 2) {
              invalidate()
            }
          }
          await expect(
            gateway.writePlanArtifact(writeInput),
          ).rejects.toMatchObject({
            code: 'INVALID_STATE',
            message:
              'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
          })
          expect(transport.putImmutableArtifactCommands).toHaveLength(2)
          expect(transport.headImmutableArtifactCommands).toHaveLength(2)
          expect(transport.getImmutableArtifactCommands).toHaveLength(0)
        } else {
          const stored = await gateway.writePlanArtifact(writeInput)
          transport.getImmutableArtifactEffect = invalidate
          await expect(
            gateway.replayPlanArtifact({
              planSealReference: stored.planSealReference,
              manifestHeadReference: stored.manifestHeadReference,
            }),
          ).rejects.toMatchObject({
            code: 'INVALID_STATE',
            message:
              'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
          })
          expect(transport.putImmutableArtifactCommands).toHaveLength(2)
          expect(transport.headImmutableArtifactCommands).toHaveLength(2)
          expect(transport.getImmutableArtifactCommands).toHaveLength(1)
          if (cancellableBody === undefined) {
            throw new Error('Expected one cancellable GetObject body.')
          }
          expect(cancellableBody.destroyCount).toBe(1)
          expect(cancellableBody.cancelCount).toBe(1)
        }
        if (lifecycle === 'remeasure') {
          if (replacementMeasurement === undefined) {
            throw new Error('Expected replacement measurement to start.')
          }
          await replacementMeasurement
          port.close()
        }
      }
    }
  })

  test('cancels active immutable bodies when the session lifecycle changes', async () => {
    const lifecycles = ['close', 'remeasure'] as const

    for (const lifecycle of lifecycles) {
      const requested = createRequestedResources()
      const transport = new RecordingIdentityAwsTransport()
      seedValidMeasurementOutputs(transport, requested)
      const clockAt = '2026-07-28T00:00:00.000Z'
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        requested,
        () => transport,
        () => new Date(clockAt),
      )
      const configuration = await port.measureConfiguration()
      const configurationHash =
        createWorkspaceSearchConfigurationHash(configuration)
      const runId = `active-body-${lifecycle}`
      const gateway = port.createPlanningArtifactGateway(runId)
      const stored = await gateway.writePlanArtifact({
        planSeal: createManagedPlanningArtifactEmptyPlanSeal(
          runId,
          configurationHash,
        ),
        operations: [],
        retainUntil: '2026-08-27T00:01:00.000Z',
      })
      const body = new CancellableImmutableArtifactBody()
      transport.immutableArtifactGetBody = body
      const replay = gateway.replayPlanArtifact({
        planSealReference: stored.planSealReference,
        manifestHeadReference: stored.manifestHeadReference,
      })
      let replaySettled = false
      void replay.then(
        () => {
          replaySettled = true
        },
        () => {
          replaySettled = true
        },
      )
      await body.nextStarted
      let replacementMeasurement:
        Promise<WorkspaceSearchMigrationConfiguration> | undefined

      if (lifecycle === 'close') {
        port.close()
      } else {
        replacementMeasurement = port.measureConfiguration()
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (replaySettled) break
        await Promise.resolve()
      }
      const settledBeforeManualRelease = replaySettled
      const cancellationBeforeManualRelease = {
        cancelCount: body.cancelCount,
        destroyCount: body.destroyCount,
      }
      body.releasePendingRead()

      await expect(replay).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message:
          'Workspace Search planning artifact storage stopped safely (INVALID_STATE).',
      })
      expect(settledBeforeManualRelease).toBe(true)
      expect(cancellationBeforeManualRelease).toEqual({
        cancelCount: 1,
        destroyCount: 1,
      })
      expect(transport.getImmutableArtifactCommands).toHaveLength(1)
      if (replacementMeasurement !== undefined) {
        await replacementMeasurement
        port.close()
      }
    }
  })

  test('redacts hostile join accessors before managed data I/O', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const input: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput = {
      runId: 'hostile-managed-join',
      configuration,
      configurationHash:
        createWorkspaceSearchConfigurationHash(configuration),
      limits: {
        maxTotalRows: 100,
        maxTotalCanonicalItemBytes: 1024 * 1024,
        maxPlanOperations: 100,
      },
    }
    let getterCalled = false
    Object.defineProperty(input, 'runId', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalled = true
        throw new WorkspaceSearchMigrationFailure(
          'TARGET_DRIFT',
          'RAW-FORGED-MANAGED-JOIN-CODE',
        )
      },
    })

    const failure = await captureWorkspaceSearchMigrationFailure(
      port.joinCommittedPlanningEvidence(input),
    )

    expect(getterCalled).toBe(false)
    expect(failure).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message:
        'Workspace Search planning material join stopped safely (INVALID_ARGUMENT).',
    })
    expect(failure.message).not.toContain('RAW-FORGED')
    expect(transport.getSourceEvidenceCommands).toHaveLength(0)
    expect(transport.getTargetEvidenceCommands).toHaveLength(0)

    const nonStringRunIdInput: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput = {
      runId: 'non-string-run',
      configuration,
      configurationHash:
        createWorkspaceSearchConfigurationHash(configuration),
      limits: {
        maxTotalRows: 100,
        maxTotalCanonicalItemBytes: 1024 * 1024,
        maxPlanOperations: 100,
      },
    }
    expect(Reflect.set(nonStringRunIdInput, 'runId', 123)).toBe(true)
    const nonStringRunIdFailure =
      await captureWorkspaceSearchMigrationFailure(
        port.joinCommittedPlanningEvidence(nonStringRunIdInput),
      )
    expect(nonStringRunIdFailure.code).toBe('INVALID_ARGUMENT')

    const nonStringHashInput: JoinWorkspaceSearchMigrationCommittedPlanningEvidenceInput = {
      runId: 'non-string-hash',
      configuration,
      configurationHash:
        createWorkspaceSearchConfigurationHash(configuration),
      limits: {
        maxTotalRows: 100,
        maxTotalCanonicalItemBytes: 1024 * 1024,
        maxPlanOperations: 100,
      },
    }
    expect(
      Reflect.set(nonStringHashInput, 'configurationHash', false),
    ).toBe(true)
    const nonStringHashFailure =
      await captureWorkspaceSearchMigrationFailure(
        port.joinCommittedPlanningEvidence(nonStringHashInput),
      )
    expect(nonStringHashFailure.code).toBe('INVALID_ARGUMENT')
    expect(transport.getSourceEvidenceCommands).toHaveLength(0)
    expect(transport.getTargetEvidenceCommands).toHaveLength(0)

    const malformedConfiguration = structuredClone(configuration)
    expect(
      Reflect.deleteProperty(
        malformedConfiguration.tables,
        'documents',
      ),
    ).toBe(true)
    const malformedFailure =
      await captureWorkspaceSearchMigrationFailure(
        port.joinCommittedPlanningEvidence({
          runId: 'malformed-managed-join',
          configuration: malformedConfiguration,
          configurationHash:
            createWorkspaceSearchConfigurationHash(configuration),
          limits: {
            maxTotalRows: 100,
            maxTotalCanonicalItemBytes: 1024 * 1024,
            maxPlanOperations: 100,
          },
        }),
      )
    expect(malformedFailure).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message:
        'Workspace Search planning material join stopped safely (INVALID_ARGUMENT).',
    })
    expect(transport.getSourceEvidenceCommands).toHaveLength(0)
    expect(transport.getTargetEvidenceCommands).toHaveLength(0)
    port.close()
  })

  test('rejects another valid configuration hash before source I/O', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const measured = await port.measureConfiguration()
    const differentConfiguration = structuredClone(measured)
    differentConfiguration.callerRoleId = 'AROA0987654321ZYXWVUT'
    expect(
      createWorkspaceSearchConfigurationHash(differentConfiguration),
    ).not.toBe(createWorkspaceSearchConfigurationHash(measured))

    await expect(
      port.scanSourcePage(
        createSourceScanInput(differentConfiguration),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_HASH_MISMATCH',
      message:
        'Workspace Search source Scan read stopped safely (CONFIGURATION_HASH_MISMATCH).',
    })
    expect(transport.scanSourceCommands).toHaveLength(0)
    port.close()
  })

  test('redacts raw and hostile source Scan transport failures', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const canary = 'RAW-SCAN-CANARY-DO-NOT-LEAK'
    transport.scanSourceFailure = new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      canary,
    )

    let rawFailure: unknown
    try {
      await port.scanSourcePage(createSourceScanInput(configuration))
    } catch (error: unknown) {
      rawFailure = error
    }
    expect(rawFailure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(rawFailure instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(rawFailure).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })
    expect(rawFailure.message).not.toContain(canary)

    transport.scanSourceFailure = new Proxy({}, {
      getPrototypeOf() {
        throw new Error(canary)
      },
    })
    await expect(
      port.scanSourcePage(createSourceScanInput(configuration)),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })
    expect(transport.scanSourceCommands).toHaveLength(2)
    port.close()
  })

  test('classifies retryable source Scan failures without raw details', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const canary = 'RETRYABLE-SCAN-CANARY-DO-NOT-LEAK'
    const retryableFailures = [
      { name: 'TimeoutError' },
      { name: 'ThrottlingException' },
      { name: 'InternalServerError', status: 500 },
      { causeCode: 'ETIMEDOUT', name: 'Error' },
      { name: 'ReplicatedWriteConflictException', retryable: true },
    ] as const

    for (const retryableFailure of retryableFailures) {
      const error = new Error(canary)
      error.name = retryableFailure.name
      if ('status' in retryableFailure) {
        Reflect.set(error, '$metadata', {
          httpStatusCode: retryableFailure.status,
        })
      }
      if ('causeCode' in retryableFailure) {
        const cause = new Error(canary)
        Reflect.set(cause, 'code', retryableFailure.causeCode)
        Reflect.set(error, 'cause', cause)
      }
      if ('retryable' in retryableFailure) {
        Reflect.set(error, '$retryable', {})
      }
      transport.scanSourceFailure = error
      let failure: unknown
      try {
        await port.scanSourcePage(createSourceScanInput(configuration))
      } catch (caught: unknown) {
        failure = caught
      }
      expect(failure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
      if (!(failure instanceof WorkspaceSearchMigrationFailure)) {
        throw new Error('Expected a Workspace Search migration failure.')
      }
      expect(failure).toMatchObject({
        code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
        message:
          'Workspace Search source Scan read stopped safely (TRANSIENT_INFRASTRUCTURE_FAILURE).',
      })
      expect(failure.message).not.toContain(canary)
    }

    transport.scanSourceFailure = undefined
    const recovered = await port.scanSourcePage(
      createSourceScanInput(configuration),
    )
    expect(recovered.checkpoint).toMatchObject({
      completed: true,
      aggregate: {
        pageCount: 1,
        scanned: 0,
      },
    })
    expect(transport.scanSourceCommands).toHaveLength(6)
    port.close()
  })

  test('rejects source table replacement before and during a Scan', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const source = 'project-directory'
    const tableName = requested.tables[source]
    const currentTable = createValidDescribeTableOutput(
      source,
      tableName,
      requested,
    )
    const replacementTable = createReplacementDescribeTableOutput(
      source,
      tableName,
      requested,
    )

    transport.describeTableOutputs.set(tableName, replacementTable)
    await expect(
      port.scanSourcePage(createSourceScanInput(configuration)),
    ).rejects.toMatchObject({
      code: 'SOURCE_DRIFT',
      message:
        'Workspace Search source Scan read stopped safely (SOURCE_DRIFT).',
    })
    expect(transport.scanSourceCommands).toHaveLength(0)

    transport.describeTableOutputs.set(tableName, currentTable)
    transport.scanSourceEffect = () => {
      transport.describeTableOutputs.set(tableName, replacementTable)
    }
    await expect(
      port.scanSourcePage(createSourceScanInput(configuration)),
    ).rejects.toMatchObject({
      code: 'SOURCE_DRIFT',
      message:
        'Workspace Search source Scan read stopped safely (SOURCE_DRIFT).',
    })
    expect(transport.scanSourceCommands).toHaveLength(1)
    expect(
      transport.describeTableCommands
        .slice(-3)
        .map((command) => command.input),
    ).toEqual([
      { TableName: tableName },
      { TableName: tableName },
      { TableName: tableName },
    ])
    port.close()
  })

  test('classifies a deleted source table as source drift', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const canary = 'DELETED-SOURCE-CANARY-DO-NOT-LEAK'
    transport.scanSourceFailure = new ResourceNotFoundException({
      $metadata: {},
      message: canary,
    })

    let failure: unknown
    try {
      await port.scanSourcePage(createSourceScanInput(configuration))
    } catch (caught: unknown) {
      failure = caught
    }
    expect(failure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(failure instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(failure).toMatchObject({
      code: 'SOURCE_DRIFT',
      message:
        'Workspace Search source Scan read stopped safely (SOURCE_DRIFT).',
    })
    expect(failure.message).not.toContain(canary)
    port.close()
  })

  test('rechecks generation after source incarnation inspection', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const tableName = requested.tables['project-directory']
    const output = transport.describeTableOutputs.get(tableName)
    const table = output?.Table
    const tableId = table?.TableId
    if (table === undefined || tableId === undefined) {
      throw new Error('Expected a complete source table fixture.')
    }
    Object.defineProperty(table, 'TableId', {
      configurable: true,
      enumerable: true,
      get() {
        queueMicrotask(() => port.close())
        return tableId
      },
    })

    await expect(
      port.scanSourcePage(createSourceScanInput(configuration)),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })
    expect(transport.scanSourceCommands).toHaveLength(0)
    expect(transport.closeCount).toBe(1)
  })

  test('selects only the four measured source tables with fixed commands', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const sources: readonly WorkspaceSearchMigrationSourceName[] = [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
    ]

    for (const source of sources) {
      await port.scanSourcePage(
        createSourceScanInput(configuration, source),
      )
    }

    expect(transport.scanSourceCommands).toHaveLength(4)
    expect(
      transport.scanSourceCommands.map((command) => command.input),
    ).toEqual(
      sources.map((source) => ({
        TableName: requested.tables[source],
        ConsistentRead: true,
        Limit: 100,
      })),
    )
    expect(
      transport.scanSourceCommands.some(
        (command) =>
          command.input.TableName === requested.tables['workspace-search'] ||
          command.input.TableName === requested.tables['migration-state'],
      ),
    ).toBe(false)
    expect(
      transport.describeTableCommands
        .slice(6)
        .map((command) => command.input),
    ).toEqual(
      sources.flatMap((source) => [
        { TableName: requested.tables[source] },
        { TableName: requested.tables[source] },
      ]),
    )
    port.close()
  })

  test('binds a pending Scan and reduction to one detached predecessor', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const firstCursor = createProjectDirectoryCursor('first')
    transport.scanSourceOutput = {
      $metadata: {},
      Count: 1,
      Items: [createIgnoredSourceItem('first')],
      LastEvaluatedKey: firstCursor,
      ScannedCount: 1,
    }
    const first = await port.scanSourcePage(
      createSourceScanInput(configuration),
    )

    transport.scanSourceOutput = {
      $metadata: {},
      Count: 2,
      Items: [
        createIgnoredSourceItem('replacement-1'),
        createIgnoredSourceItem('replacement-2'),
      ],
      LastEvaluatedKey: createProjectDirectoryCursor('replacement-2'),
      ScannedCount: 2,
    }
    const replacement = await port.scanSourcePage(
      createSourceScanInput(configuration),
    )
    const pendingInput = createSourceScanInput(
      configuration,
      'project-directory',
      first.checkpoint,
    )
    const deferred = createDeferredScanOutput()
    transport.scanSourceDeferred = deferred.promise

    const pending = port.scanSourcePage(pendingInput)
    await waitForRecordedScanCount(transport, 3)
    expect(transport.scanSourceCommands).toHaveLength(3)
    Reflect.set(
      pendingInput,
      'previousCheckpoint',
      replacement.checkpoint,
    )
    deferred.resolve(createEmptyScanOutput())
    const result = await pending

    expect(transport.scanSourceCommands[2]?.input).toEqual({
      TableName: requested.tables['project-directory'],
      ConsistentRead: true,
      ExclusiveStartKey: firstCursor,
      Limit: 100,
    })
    expect(result.checkpoint).toMatchObject({
      completed: true,
      aggregate: {
        ignored: 1,
        mapped: 0,
        pageCount: 2,
        scanned: 1,
      },
    })
    expect(result.checkpoint.keyDigestState)
      .toEqual(first.checkpoint.keyDigestState)
    expect(result.checkpoint.contentDigestState)
      .toEqual(first.checkpoint.contentDigestState)
    expect(replacement.checkpoint.aggregate).toMatchObject({
      ignored: 2,
      pageCount: 1,
      scanned: 2,
    })
    port.close()
  })

  test('keeps the reducer predecessor isolated from command mutation', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const repeatedCursor = createProjectDirectoryCursor('repeated')
    transport.scanSourceOutput = {
      $metadata: {},
      Count: 1,
      Items: [createIgnoredSourceItem('repeated')],
      LastEvaluatedKey: repeatedCursor,
      ScannedCount: 1,
    }
    const first = await port.scanSourcePage(
      createSourceScanInput(configuration),
    )
    const deferred = createDeferredScanOutput()
    transport.scanSourceDeferred = deferred.promise

    const pending = port.scanSourcePage(
      createSourceScanInput(
        configuration,
        'project-directory',
        first.checkpoint,
      ),
    )
    await waitForRecordedScanCount(transport, 2)
    const commandCursor =
      transport.scanSourceCommands[1]?.input.ExclusiveStartKey
    if (commandCursor === undefined) {
      throw new Error('Expected a detached command cursor.')
    }
    commandCursor.directoryId = { S: 'workspace-command-mutated' }
    deferred.resolve({
      $metadata: {},
      Count: 1,
      Items: [createIgnoredSourceItem('repeated')],
      LastEvaluatedKey: repeatedCursor,
      ScannedCount: 1,
    })

    await expect(pending).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source scan page stopped safely (INVALID_STATE).',
    })
    expect(first.checkpoint.cursor).toEqual(repeatedCursor)
    port.close()
  })

  test('always returns rejected Promises for source Scans after close', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const input = createSourceScanInput(configuration)
    port.close()
    port.close()

    const firstRead = port.scanSourcePage(input)
    expect(firstRead).toBeInstanceOf(Promise)
    await expect(firstRead).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })

    const secondRead = port.scanSourcePage(input)
    expect(secondRead).toBeInstanceOf(Promise)
    await expect(secondRead).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })
    expect(transport.scanSourceCommands).toHaveLength(0)
    expect(transport.closeCount).toBe(1)
  })

  test('invalidates a pending source Scan when the managed session closes', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const deferred = createDeferredScanOutput()
    transport.scanSourceDeferred = deferred.promise

    const pendingRead = port.scanSourcePage(
      createSourceScanInput(configuration),
    )
    await waitForRecordedScanCount(transport, 1)
    expect(transport.scanSourceCommands).toHaveLength(1)
    port.close()
    deferred.resolve(createEmptyScanOutput())

    await expect(pendingRead).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })
    expect(transport.closeCount).toBe(1)
  })

  test('invalidates a pending source Scan after replacement measurement', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const configurationHash =
      createWorkspaceSearchConfigurationHash(configuration)
    const deferred = createDeferredScanOutput()
    transport.scanSourceDeferred = deferred.promise

    const pendingRead = port.scanSourcePage(
      createSourceScanInput(configuration),
    )
    await waitForRecordedScanCount(transport, 1)
    expect(transport.scanSourceCommands).toHaveLength(1)
    const replacement = await port.measureConfiguration()
    expect(createWorkspaceSearchConfigurationHash(replacement))
      .toBe(configurationHash)
    transport.scanSourceDeferred = undefined
    deferred.resolve(createEmptyScanOutput())

    await expect(pendingRead).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })
    expect(transport.scanSourceCommands).toHaveLength(1)
    port.close()
  })

  test('rechecks generation after the asynchronous Scan boundary', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const configuration = await port.measureConfiguration()
    const output = createEmptyScanOutput()
    Object.defineProperty(output, 'LastEvaluatedKey', {
      configurable: true,
      enumerable: true,
      get() {
        queueMicrotask(() => port.close())
        return undefined
      },
    })
    transport.scanSourceOutput = output

    await expect(
      port.scanSourcePage(createSourceScanInput(configuration)),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source Scan read stopped safely (INVALID_STATE).',
    })
    expect(transport.closeCount).toBe(1)
  })

  test('pins every client to explicit-profile official partition endpoints', () => {
    const endpointCases: readonly EndpointCase[] = [
      { region: 'ap-northeast-1', suffix: 'amazonaws.com' },
      { region: 'cn-north-1', suffix: 'amazonaws.com.cn' },
      { region: 'eusc-de-east-1', suffix: 'amazonaws.eu' },
      { region: 'us-iso-east-1', suffix: 'c2s.ic.gov' },
      { region: 'us-isob-east-1', suffix: 'sc2s.sgov.gov' },
      { region: 'eu-isoe-west-1', suffix: 'cloud.adc-e.uk' },
      { region: 'us-isof-south-1', suffix: 'csp.hci.ic.gov' },
      { region: 'us-gov-west-1', suffix: 'amazonaws.com' },
    ]
    const endpointVariableNames: readonly EndpointVariableName[] = [
      'AWS_ENDPOINT_URL',
      'AWS_ENDPOINT_URL_DYNAMODB',
      'AWS_ENDPOINT_URL_KMS',
      'AWS_ENDPOINT_URL_S3',
      'AWS_ENDPOINT_URL_STS',
    ]
    const previousValues = endpointVariableNames.map((name) => process.env[name])
    try {
      for (const name of endpointVariableNames) {
        process.env[name] = `https://attacker.invalid/${name.toLowerCase()}`
      }

      for (const endpointCase of endpointCases) {
        let configurations:
          WorkspaceSearchMigrationIdentityAwsSdkConfigurations | undefined
        const port = createAwsWorkspaceSearchMigrationIdentityPort(
          createRequestedResources(endpointCase.region),
          (createdConfigurations) => {
            configurations = createdConfigurations
            return new RecordingIdentityAwsTransport()
          },
        )

        expect(configurations?.dynamodb).toMatchObject({
          endpoint:
            `https://dynamodb.${endpointCase.region}.${endpointCase.suffix}/`,
          profile: TEST_PROFILE,
          region: endpointCase.region,
        })
        expect(configurations?.kms).toMatchObject({
          endpoint: `https://kms.${endpointCase.region}.${endpointCase.suffix}/`,
          profile: TEST_PROFILE,
          region: endpointCase.region,
        })
        expect(configurations?.s3).toMatchObject({
          endpoint: `https://s3.${endpointCase.region}.${endpointCase.suffix}/`,
          followRegionRedirects: false,
          profile: TEST_PROFILE,
          region: endpointCase.region,
        })
        expect(configurations?.sts).toMatchObject({
          endpoint: `https://sts.${endpointCase.region}.${endpointCase.suffix}/`,
          profile: TEST_PROFILE,
          region: endpointCase.region,
        })
        expect(configurations?.dynamodb.credentials).toBe(
          configurations?.kms.credentials,
        )
        expect(configurations?.dynamodb.credentials).toBe(
          configurations?.s3.credentials,
        )
        expect(configurations?.dynamodb.credentials).toBe(
          configurations?.sts.credentials,
        )
        port.close()
      }
    } finally {
      endpointVariableNames.forEach((name, index) => {
        restoreEnvironmentVariable(name, previousValues[index])
      })
    }
  })

  test('applies endpoint and S3 redirect policy to concrete SDK clients', async () => {
    const endpointVariables: readonly EndpointVariableName[] = [
      'AWS_ENDPOINT_URL',
      'AWS_ENDPOINT_URL_DYNAMODB',
      'AWS_ENDPOINT_URL_KMS',
      'AWS_ENDPOINT_URL_S3',
      'AWS_ENDPOINT_URL_STS',
    ]
    const previousValues = endpointVariables.map((name) => process.env[name])
    let port:
      ReturnType<typeof createAwsWorkspaceSearchMigrationIdentityPort> |
      undefined
    try {
      for (const name of endpointVariables) {
        process.env[name] = `https://attacker.invalid/${name.toLowerCase()}`
      }
      port = createAwsWorkspaceSearchMigrationIdentityPort(
        createRequestedResources(),
      )
      const transport = readOwnObject(port, 'transport')
      const dynamodbClient = readOwnObject(transport, 'dynamodbClient')
      const kmsClient = readOwnObject(transport, 'kmsClient')
      const s3Client = readOwnObject(transport, 's3Client')
      const stsClient = readOwnObject(transport, 'stsClient')

      await expect(readSdkClientEndpoint(dynamodbClient)).resolves.toBe(
        `https://dynamodb.${TEST_REGION}.amazonaws.com/`,
      )
      await expect(readSdkClientEndpoint(kmsClient)).resolves.toBe(
        `https://kms.${TEST_REGION}.amazonaws.com/`,
      )
      await expect(readSdkClientEndpoint(s3Client)).resolves.toBe(
        `https://s3.${TEST_REGION}.amazonaws.com/`,
      )
      await expect(readSdkClientEndpoint(stsClient)).resolves.toBe(
        `https://sts.${TEST_REGION}.amazonaws.com/`,
      )
      const s3Configuration = readOwnObject(s3Client, 'config')
      const followRegionRedirects: unknown = Reflect.get(
        s3Configuration,
        'followRegionRedirects',
      )
      expect(followRegionRedirects).toBe(false)
    } finally {
      port?.close()
      endpointVariables.forEach((name, index) => {
        restoreEnvironmentVariable(name, previousValues[index])
      })
    }
  })

  test('bounds concrete state transactions and normalizes only local aborts', async () => {
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      createRequestedResources(),
    )
    const transport = readOwnObject(port, 'transport')
    const dynamodbClient = readOwnObject(transport, 'dynamodbClient')
    const send: unknown = Reflect.get(dynamodbClient, 'send')
    const originalSetTimeout: unknown = Reflect.get(
      globalThis,
      'setTimeout',
    )
    if (
      typeof send !== 'function' ||
      typeof originalSetTimeout !== 'function'
    ) {
      throw new Error('Expected concrete state transport functions.')
    }
    const command = new TransactWriteItemsCommand({
      TransactItems: [],
    })
    const transactionMethods = [
      'transactWritePrePlanAuthority',
      'transactWriteSourceEvidence',
      'transactWriteTargetEvidence',
    ]

    try {
      for (const methodName of transactionMethods) {
        const transact: unknown = Reflect.get(transport, methodName)
        if (typeof transact !== 'function') {
          throw new Error(`Expected concrete transaction: ${methodName}`)
        }
        const rawCanary = `RAW-LOCAL-ABORT-CANARY-${methodName}`
        const rawAbort = new Error(rawCanary)
        rawAbort.name = 'AbortError'
        const observedDeadlines: number[] = []
        Reflect.set(
          dynamodbClient,
          'send',
          (_command: unknown, options: unknown): Promise<never> => {
            const signal = readAbortSignal(options)
            if (!signal.aborted) {
              throw new Error('Expected the local deadline to abort first.')
            }
            return Promise.reject(rawAbort)
          },
        )
        Reflect.set(
          globalThis,
          'setTimeout',
          (callback: unknown, delay: unknown): number => {
            if (
              typeof callback !== 'function' ||
              typeof delay !== 'number'
            ) {
              throw new Error('Expected one numeric timeout callback.')
            }
            observedDeadlines.push(delay)
            Reflect.apply(callback, undefined, [])
            return 0
          },
        )

        let normalized: unknown
        try {
          await Reflect.apply(transact, transport, [command])
        } catch (error: unknown) {
          normalized = error
        }
        expect(observedDeadlines).toEqual([5_000])
        expect(normalized).toBeInstanceOf(Error)
        if (!(normalized instanceof Error)) {
          throw new Error('Expected normalized timeout error.')
        }
        expect(normalized).toMatchObject({
          name: 'TimeoutError',
          code: 'ETIMEDOUT',
        })
        expect(normalized.message).not.toContain(rawCanary)

        const preDeadlineAbort =
          new Error(`PRE-DEADLINE-ABORT-${methodName}`)
        preDeadlineAbort.name = 'AbortError'
        Reflect.set(
          dynamodbClient,
          'send',
          (_command: unknown, options: unknown): Promise<never> => {
            const signal = readAbortSignal(options)
            if (signal.aborted) {
              throw new Error('Expected an active pre-deadline signal.')
            }
            return Promise.reject(preDeadlineAbort)
          },
        )
        Reflect.set(
          globalThis,
          'setTimeout',
          (_callback: unknown, delay: unknown): number => {
            if (typeof delay !== 'number') {
              throw new Error('Expected one numeric timeout delay.')
            }
            observedDeadlines.push(delay)
            return 0
          },
        )
        let preserved: unknown
        try {
          await Reflect.apply(transact, transport, [command])
        } catch (error: unknown) {
          preserved = error
        }
        expect(observedDeadlines).toEqual([5_000, 5_000])
        expect(preserved).toBe(preDeadlineAbort)
      }
    } finally {
      Reflect.set(globalThis, 'setTimeout', originalSetTimeout)
      Reflect.set(dynamodbClient, 'send', send)
      port.close()
    }
  })

  test('bounds concrete artifact S3 requests and normalizes only local aborts', async () => {
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      createRequestedResources(),
    )
    const transport = readOwnObject(port, 'transport')
    const s3Client = readOwnObject(transport, 's3Client')
    const send: unknown = Reflect.get(s3Client, 'send')
    const originalSetTimeout: unknown = Reflect.get(
      globalThis,
      'setTimeout',
    )
    if (
      typeof send !== 'function' ||
      typeof originalSetTimeout !== 'function'
    ) {
      throw new Error('Expected concrete source-artifact transport functions.')
    }
    const requests = [
      {
        methodName: 'putSourceArtifact',
        command: new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/source-artifacts/v1/put.json',
          Body: new Uint8Array([1]),
        }),
      },
      {
        methodName: 'headSourceArtifact',
        command: new HeadObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/source-artifacts/v1/head.json',
        }),
      },
      {
        methodName: 'getSourceArtifact',
        command: new GetObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/source-artifacts/v1/get.json',
          VersionId: 'exact-source-artifact-version',
        }),
      },
      {
        methodName: 'putTargetArtifact',
        command: new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/target-artifacts/v1/put.json',
          Body: new Uint8Array([1]),
        }),
      },
      {
        methodName: 'headTargetArtifact',
        command: new HeadObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/target-artifacts/v1/head.json',
        }),
      },
      {
        methodName: 'getTargetArtifact',
        command: new GetObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/target-artifacts/v1/get.json',
          VersionId: 'exact-target-artifact-version',
        }),
      },
    ]

    try {
      for (const request of requests) {
        const operation: unknown = Reflect.get(
          transport,
          request.methodName,
        )
        if (typeof operation !== 'function') {
          throw new Error(
            `Expected concrete artifact operation: ${request.methodName}`,
          )
        }
        const rawCanary =
          `RAW-SOURCE-ARTIFACT-ABORT-${request.methodName}`
        const rawAbort = new Error(rawCanary)
        rawAbort.name = 'AbortError'
        const observedDeadlines: number[] = []
        Reflect.set(
          s3Client,
          'send',
          (command: unknown, options: unknown): Promise<never> => {
            expect(command).toBe(request.command)
            const signal = readAbortSignal(options)
            if (!signal.aborted) {
              throw new Error('Expected the artifact deadline to abort first.')
            }
            return Promise.reject(rawAbort)
          },
        )
        Reflect.set(
          globalThis,
          'setTimeout',
          (callback: unknown, delay: unknown): number => {
            if (
              typeof callback !== 'function' ||
              typeof delay !== 'number'
            ) {
              throw new Error('Expected one numeric artifact timeout.')
            }
            observedDeadlines.push(delay)
            Reflect.apply(callback, undefined, [])
            return 0
          },
        )

        let normalized: unknown
        try {
          await Reflect.apply(operation, transport, [request.command])
        } catch (error: unknown) {
          normalized = error
        }
        expect(observedDeadlines).toEqual([10_000])
        expect(normalized).toBeInstanceOf(Error)
        if (!(normalized instanceof Error)) {
          throw new Error('Expected normalized artifact timeout error.')
        }
        expect(normalized).toMatchObject({
          name: 'TimeoutError',
          code: 'ETIMEDOUT',
        })
        expect(normalized.message).not.toContain(rawCanary)

        const preDeadlineAbort =
          new Error(`PRE-DEADLINE-${request.methodName}`)
        preDeadlineAbort.name = 'AbortError'
        Reflect.set(
          s3Client,
          'send',
          (command: unknown, options: unknown): Promise<never> => {
            expect(command).toBe(request.command)
            const signal = readAbortSignal(options)
            if (signal.aborted) {
              throw new Error(
                'Expected an active artifact pre-deadline signal.',
              )
            }
            return Promise.reject(preDeadlineAbort)
          },
        )
        Reflect.set(
          globalThis,
          'setTimeout',
          (_callback: unknown, delay: unknown): number => {
            if (typeof delay !== 'number') {
              throw new Error('Expected one numeric artifact delay.')
            }
            observedDeadlines.push(delay)
            return 0
          },
        )
        let preserved: unknown
        try {
          await Reflect.apply(operation, transport, [request.command])
        } catch (error: unknown) {
          preserved = error
        }
        expect(observedDeadlines).toEqual([10_000, 10_000])
        expect(preserved).toBe(preDeadlineAbort)
      }
    } finally {
      Reflect.set(globalThis, 'setTimeout', originalSetTimeout)
      Reflect.set(s3Client, 'send', send)
      port.close()
    }
  })

  test('forwards immutable core signals without adding a transport timer', async () => {
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      createRequestedResources(),
    )
    const transport = readOwnObject(port, 'transport')
    const s3Client = readOwnObject(transport, 's3Client')
    const send: unknown = Reflect.get(s3Client, 'send')
    const originalSetTimeout: unknown = Reflect.get(
      globalThis,
      'setTimeout',
    )
    if (
      typeof send !== 'function' ||
      typeof originalSetTimeout !== 'function'
    ) {
      throw new Error('Expected concrete immutable transport functions.')
    }
    const requests = [
      {
        methodName: 'putImmutableArtifact',
        command: new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/planning/put.artifact',
          Body: new Uint8Array([1]),
        }),
      },
      {
        methodName: 'headImmutableArtifact',
        command: new HeadObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/planning/head.artifact',
        }),
      },
      {
        methodName: 'getImmutableArtifact',
        command: new GetObjectCommand({
          Bucket: TEST_BUCKET,
          Key: 'workspace-search/v1/planning/get.artifact',
          VersionId: 'exact-immutable-version',
        }),
      },
    ]
    let timeoutCount = 0

    try {
      Reflect.set(
        globalThis,
        'setTimeout',
        (): number => {
          timeoutCount += 1
          return 0
        },
      )
      for (const request of requests) {
        const operation: unknown = Reflect.get(
          transport,
          request.methodName,
        )
        if (typeof operation !== 'function') {
          throw new Error(
            `Expected concrete immutable operation: ${request.methodName}`,
          )
        }
        const abortController = new AbortController()
        const rawFailure =
          new Error(`RAW-IMMUTABLE-SEND-${request.methodName}`)
        Reflect.set(
          s3Client,
          'send',
          (command: unknown, options: unknown): Promise<never> => {
            expect(command).toBe(request.command)
            expect(readAbortSignal(options)).toBe(
              abortController.signal,
            )
            return Promise.reject(rawFailure)
          },
        )

        let observed: unknown
        try {
          await Reflect.apply(operation, transport, [
            request.command,
            abortController.signal,
          ])
        } catch (error: unknown) {
          observed = error
        }
        expect(observed).toBe(rawFailure)
      }
      expect(timeoutCount).toBe(0)
    } finally {
      Reflect.set(globalThis, 'setTimeout', originalSetTimeout)
      Reflect.set(s3Client, 'send', send)
      port.close()
    }
  })

  test('closes every concrete SDK client when one destroy call fails', () => {
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      createRequestedResources(),
    )
    const transport = readOwnObject(port, 'transport')
    const clients = [
      ['dynamodb', readOwnObject(transport, 'dynamodbClient')],
      ['kms', readOwnObject(transport, 'kmsClient')],
      ['s3', readOwnObject(transport, 's3Client')],
      ['sts', readOwnObject(transport, 'stsClient')],
    ] satisfies readonly (readonly [string, object])[]
    const closeOrder: string[] = []
    for (const [name, client] of clients) {
      const destroy: unknown = Reflect.get(client, 'destroy')
      if (typeof destroy !== 'function') {
        throw new Error(`Expected ${name} destroy function.`)
      }
      Reflect.set(client, 'destroy', () => {
        closeOrder.push(name)
        Reflect.apply(destroy, client, [])
        if (name === 'dynamodb') {
          throw new Error('simulated destroy failure')
        }
      })
    }

    expect(() => port.close()).not.toThrow()
    expect(closeOrder).toEqual(['dynamodb', 'kms', 's3', 'sts'])
  })

  test('pins nested assume-role STS traffic and releases its client', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'mukuroji-migration-identity-'),
    )
    const credentialsPath = join(temporaryDirectory, 'credentials')
    const configPath = join(temporaryDirectory, 'config')
    await writeFile(
      credentialsPath,
      [
        '[migration-source]',
        'aws_access_key_id = AKIA1234567890EXAMPLE',
        'aws_secret_access_key = migration-source-secret',
        '',
      ].join('\n'),
    )
    await writeFile(
      configPath,
      [
        `[profile ${TEST_PROFILE}]`,
        `role_arn = arn:aws:iam::${TEST_ACCOUNT}:role/MigrationOperator`,
        'source_profile = migration-source',
        `role_session_name = ${TEST_SESSION_NAME}`,
        `region = ${TEST_REGION}`,
        '',
      ].join('\n'),
    )
    const environmentNames: readonly string[] = [
      'AWS_CONFIG_FILE',
      'AWS_ENDPOINT_URL',
      'AWS_ENDPOINT_URL_STS',
      'AWS_SHARED_CREDENTIALS_FILE',
    ]
    const previousValues = environmentNames.map((name) => process.env[name])
    const priorSendDescriptor = Object.getOwnPropertyDescriptor(
      STSClient.prototype,
      'send',
    )
    const priorDestroyDescriptor = Object.getOwnPropertyDescriptor(
      STSClient.prototype,
      'destroy',
    )
    const pollutedProfileFields: readonly (readonly [string, string])[] = [
      ['aws_session_token', 'attacker-inherited-session-token'],
      ['duration_seconds', '43200'],
      ['external_id', 'attacker-inherited-external-id'],
    ]
    const priorPollutedProfileFieldDescriptors = pollutedProfileFields.map(
      ([key]) => Object.getOwnPropertyDescriptor(Object.prototype, key),
    )
    const inheritedDestroy: unknown = Reflect.get(STSClient.prototype, 'destroy')
    let nestedClientDestroyCount = 0
    let nestedClientSendCount = 0
    let observedEndpoint: string | undefined
    const observedCommands: AssumeRoleCommand[] = []
    const observedSourceCredentials: {
      /** Source access key selected from the named source profile. */
      accessKeyId: string
      /** Source secret selected from the named source profile. */
      secretAccessKey: string
      /** Optional source session token selected from the named source profile. */
      sessionToken: string | undefined
    }[] = []
    const hostileExpiration = new Date(Date.now() + 60_000)
    const hostileExpirationTimestamp =
      Date.prototype.getTime.call(hostileExpiration)
    const refreshedExpiration = new Date('2099-07-27T00:00:00.000Z')
    let expirationOverrideCalls = 0
    Object.defineProperty(hostileExpiration, 'getTime', {
      configurable: true,
      value() {
        expirationOverrideCalls += 1
        throw new Error('Hostile expiration override must not run.')
      },
      writable: true,
    })
    try {
      process.env.AWS_CONFIG_FILE = configPath
      process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath
      process.env.AWS_ENDPOINT_URL = 'https://attacker.invalid/global'
      process.env.AWS_ENDPOINT_URL_STS = 'https://attacker.invalid/sts'
      for (const [key, value] of pollutedProfileFields) {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          enumerable: false,
          value,
          writable: true,
        })
      }
      Object.defineProperty(STSClient.prototype, 'send', {
        configurable: true,
        async value(this: STSClient, command: unknown) {
          nestedClientSendCount += 1
          observedEndpoint = await readSdkClientEndpoint(this)
          const sourceCredentials = await this.config.credentials()
          observedSourceCredentials.push({
            accessKeyId: sourceCredentials.accessKeyId,
            secretAccessKey: sourceCredentials.secretAccessKey,
            sessionToken: sourceCredentials.sessionToken,
          })
          if (!(command instanceof AssumeRoleCommand)) {
            throw new Error('Expected an AssumeRole command.')
          }
          observedCommands.push(command)
          if (nestedClientSendCount === 2) {
            return {
              $metadata: {},
              Credentials: {
                AccessKeyId: 'ASIA-INCOMPLETE',
              },
            }
          }
          const isInitialResolution = nestedClientSendCount === 1
          return {
            $metadata: {},
            Credentials: {
              AccessKeyId: isInitialResolution
                ? 'ASIA1234567890EXAMPLE'
                : 'ASIA0987654321EXAMPLE',
              SecretAccessKey: isInitialResolution
                ? 'assumed-role-secret'
                : 'refreshed-role-secret',
              SessionToken: isInitialResolution
                ? 'assumed-role-session-token'
                : 'refreshed-role-session-token',
              Expiration: isInitialResolution
                ? hostileExpiration
                : refreshedExpiration,
            },
          }
        },
        writable: true,
      })
      Object.defineProperty(STSClient.prototype, 'destroy', {
        configurable: true,
        value(this: STSClient) {
          nestedClientDestroyCount += 1
          if (typeof inheritedDestroy === 'function') {
            Reflect.apply(inheritedDestroy, this, [])
          }
        },
        writable: true,
      })

      let configurations:
        WorkspaceSearchMigrationIdentityAwsSdkConfigurations | undefined
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        createRequestedResources(),
        (createdConfigurations) => {
          configurations = createdConfigurations
          return new RecordingIdentityAwsTransport()
        },
      )
      try {
        if (!configurations) {
          throw new Error('Expected captured SDK configurations.')
        }
        const credentials = await Promise.all([
          configurations.dynamodb.credentials(),
          configurations.kms.credentials(),
          configurations.s3.credentials(),
          configurations.sts.credentials(),
        ])
        for (const identity of credentials) {
          expect(identity).toMatchObject({
            accessKeyId: 'ASIA1234567890EXAMPLE',
            secretAccessKey: 'assumed-role-secret',
            sessionToken: 'assumed-role-session-token',
            expiration: new Date(hostileExpirationTimestamp),
          })
        }

        await writeFile(
          credentialsPath,
          [
            '[attacker-source]',
            'aws_access_key_id = AKIA0987654321EXAMPLE',
            'aws_secret_access_key = attacker-source-secret',
            '',
          ].join('\n'),
        )
        await writeFile(
          configPath,
          [
            `[profile ${TEST_PROFILE}]`,
            `role_arn = arn:aws:iam::${TEST_ACCOUNT}:role/Attacker`,
            'source_profile = attacker-source',
            'role_session_name = attacker-session',
            '',
          ].join('\n'),
        )
        await expect(configurations.sts.credentials()).rejects.toThrow(
          'STS role assumption response is incomplete.',
        )
        await expect(configurations.sts.credentials()).resolves.toMatchObject({
          accessKeyId: 'ASIA0987654321EXAMPLE',
          secretAccessKey: 'refreshed-role-secret',
          sessionToken: 'refreshed-role-session-token',
          expiration: refreshedExpiration,
        })
      } finally {
        port.close()
      }

      expect(observedEndpoint).toBe(
        `https://sts.${TEST_REGION}.amazonaws.com/`,
      )
      expect(observedCommands).toHaveLength(3)
      for (const command of observedCommands) {
        expect(command.input).toEqual({
          RoleArn: `arn:aws:iam::${TEST_ACCOUNT}:role/MigrationOperator`,
          RoleSessionName: TEST_SESSION_NAME,
          ExternalId: undefined,
          DurationSeconds: 3_600,
        })
      }
      expect(observedSourceCredentials).toEqual([
        {
          accessKeyId: 'AKIA1234567890EXAMPLE',
          secretAccessKey: 'migration-source-secret',
          sessionToken: undefined,
        },
        {
          accessKeyId: 'AKIA1234567890EXAMPLE',
          secretAccessKey: 'migration-source-secret',
          sessionToken: undefined,
        },
        {
          accessKeyId: 'AKIA1234567890EXAMPLE',
          secretAccessKey: 'migration-source-secret',
          sessionToken: undefined,
        },
      ])
      expect(nestedClientSendCount).toBe(3)
      expect(nestedClientDestroyCount).toBe(3)
      expect(expirationOverrideCalls).toBe(0)
    } finally {
      restoreOwnProperty(
        STSClient.prototype,
        'send',
        priorSendDescriptor,
      )
      restoreOwnProperty(
        STSClient.prototype,
        'destroy',
        priorDestroyDescriptor,
      )
      pollutedProfileFields.forEach(([key], index) => {
        restoreOwnProperty(
          Object.prototype,
          key,
          priorPollutedProfileFieldDescriptors[index],
        )
      })
      environmentNames.forEach((name, index) => {
        restoreEnvironmentVariable(name, previousValues[index])
      })
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  })

  test('rejects unmanaged shared-profile credential mechanisms', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'mukuroji-migration-profile-'),
    )
    const credentialsPath = join(temporaryDirectory, 'credentials')
    const configPath = join(temporaryDirectory, 'config')
    const processSentinelPath = join(temporaryDirectory, 'process-executed')
    const webIdentityTokenPath = join(temporaryDirectory, 'web-token')
    await writeFile(
      credentialsPath,
      [
        `[${TEST_PROFILE}]`,
        'aws_access_key_id = AKIA1234567890EXAMPLE',
        'aws_secret_access_key = migration-static-secret',
        '',
      ].join('\n'),
    )
    await writeFile(webIdentityTokenPath, 'sensitive-web-token')
    const profileCases: readonly UnsupportedProfileCase[] = [
      {
        name: 'credential_process',
        entry: `credential_process = touch ${processSentinelPath}`,
      },
      {
        name: 'credential_source',
        entry: 'credential_source = Environment',
      },
      {
        name: 'login_session',
        entry: 'login_session = production-login',
      },
      {
        name: 'mfa_serial',
        entry: `mfa_serial = arn:aws:iam::${TEST_ACCOUNT}:mfa/operator`,
      },
      {
        name: 'sso_account_id',
        entry: `sso_account_id = ${TEST_ACCOUNT}`,
      },
      {
        name: 'sso_region',
        entry: 'sso_region = ap-northeast-1',
      },
      {
        name: 'sso_role_name',
        entry: 'sso_role_name = MigrationOperator',
      },
      {
        name: 'sso_session',
        entry: 'sso_session = production-sso',
      },
      {
        name: 'sso_start_url',
        entry: 'sso_start_url = https://example.awsapps.com/start',
      },
      {
        name: 'web_identity_token_file',
        entry: `web_identity_token_file = ${webIdentityTokenPath}`,
      },
    ]
    const environmentNames: readonly string[] = [
      'AWS_CONFIG_FILE',
      'AWS_ENDPOINT_URL_SIGNIN',
      'AWS_ENDPOINT_URL_SSO',
      'AWS_SHARED_CREDENTIALS_FILE',
    ]
    const previousValues = environmentNames.map((name) => process.env[name])
    try {
      process.env.AWS_CONFIG_FILE = configPath
      process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath
      process.env.AWS_ENDPOINT_URL_SIGNIN = 'http://127.0.0.1:1'
      process.env.AWS_ENDPOINT_URL_SSO = 'http://127.0.0.1:1'

      for (const profileCase of profileCases) {
        await writeFile(
          configPath,
          [
            `[profile ${TEST_PROFILE}]`,
            profileCase.entry,
            '',
          ].join('\n'),
        )
        let configurations:
          WorkspaceSearchMigrationIdentityAwsSdkConfigurations | undefined
        const port = createAwsWorkspaceSearchMigrationIdentityPort(
          createRequestedResources(),
          (createdConfigurations) => {
            configurations = createdConfigurations
            return new RecordingIdentityAwsTransport()
          },
        )
        try {
          if (!configurations) {
            throw new Error('Expected captured SDK configurations.')
          }
          await expect(configurations.sts.credentials()).rejects.toThrow(
            'Selected AWS profile credentials are unsupported or invalid.',
          )
        } finally {
          port.close()
        }
      }

      expect(await Bun.file(processSentinelPath).exists()).toBe(false)
    } finally {
      environmentNames.forEach((name, index) => {
        restoreEnvironmentVariable(name, previousValues[index])
      })
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  })

  test('retries an unestablished credential plan and pins the first success', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'mukuroji-migration-profile-retry-'),
    )
    const credentialsPath = join(temporaryDirectory, 'credentials')
    const configPath = join(temporaryDirectory, 'config')
    await writeFile(credentialsPath, '')
    await writeFile(configPath, '')
    const environmentNames: readonly string[] = [
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
    ]
    const previousValues = environmentNames.map((name) => process.env[name])
    let port:
      ReturnType<typeof createAwsWorkspaceSearchMigrationIdentityPort> |
      undefined
    try {
      process.env.AWS_CONFIG_FILE = configPath
      process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath
      let configurations:
        WorkspaceSearchMigrationIdentityAwsSdkConfigurations | undefined
      port = createAwsWorkspaceSearchMigrationIdentityPort(
        createRequestedResources(),
        (createdConfigurations) => {
          configurations = createdConfigurations
          return new RecordingIdentityAwsTransport()
        },
      )
      if (!configurations) {
        throw new Error('Expected captured SDK configurations.')
      }
      const credentials = configurations.sts.credentials
      await expect(credentials()).rejects.toThrow(
        'Selected AWS profile credentials are unsupported or invalid.',
      )

      await writeFile(
        credentialsPath,
        [
          `[${TEST_PROFILE}]`,
          'aws_access_key_id = AKIA1234567890EXAMPLE',
          'aws_secret_access_key = migration-recovered-secret',
          '',
        ].join('\n'),
      )
      await expect(credentials()).resolves.toMatchObject({
        accessKeyId: 'AKIA1234567890EXAMPLE',
        secretAccessKey: 'migration-recovered-secret',
      })

      await writeFile(
        credentialsPath,
        [
          `[${TEST_PROFILE}]`,
          'aws_access_key_id = AKIA0987654321EXAMPLE',
          'aws_secret_access_key = attacker-replacement-secret',
          '',
        ].join('\n'),
      )
      await expect(credentials()).resolves.toMatchObject({
        accessKeyId: 'AKIA1234567890EXAMPLE',
        secretAccessKey: 'migration-recovered-secret',
      })
    } finally {
      port?.close()
      environmentNames.forEach((name, index) => {
        restoreEnvironmentVariable(name, previousValues[index])
      })
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  })

  test('rejects an inherited profile map entry', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'mukuroji-migration-inherited-profile-'),
    )
    const credentialsPath = join(temporaryDirectory, 'credentials')
    const configPath = join(temporaryDirectory, 'config')
    await writeFile(credentialsPath, '')
    await writeFile(configPath, '')
    const environmentNames: readonly string[] = [
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
    ]
    const previousValues = environmentNames.map((name) => process.env[name])
    const priorProfileDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      TEST_PROFILE,
    )
    try {
      process.env.AWS_CONFIG_FILE = configPath
      process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath
      let configurations:
        WorkspaceSearchMigrationIdentityAwsSdkConfigurations | undefined
      const port = createAwsWorkspaceSearchMigrationIdentityPort(
        createRequestedResources(),
        (createdConfigurations) => {
          configurations = createdConfigurations
          return new RecordingIdentityAwsTransport()
        },
      )
      try {
        Object.defineProperty(Object.prototype, TEST_PROFILE, {
          configurable: true,
          enumerable: false,
          value: {
            aws_access_key_id: 'AKIA0987654321EXAMPLE',
            aws_secret_access_key: 'attacker-inherited-secret',
          },
          writable: true,
        })
        if (!configurations) {
          throw new Error('Expected captured SDK configurations.')
        }
        await expect(configurations.sts.credentials()).rejects.toThrow(
          'Selected AWS profile credentials are unsupported or invalid.',
        )
      } finally {
        port.close()
      }
    } finally {
      restoreOwnProperty(
        Object.prototype,
        TEST_PROFILE,
        priorProfileDescriptor,
      )
      environmentNames.forEach((name, index) => {
        restoreEnvironmentVariable(name, previousValues[index])
      })
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  })

  test('rejects invalid construction and out-of-scope lookups before transport reads', async () => {
    const invalidRegion = createRequestedResources()
    invalidRegion.region = 'ap-northeast-1.attacker.invalid'
    let transportConstructionCount = 0
    expect(() =>
      createAwsWorkspaceSearchMigrationIdentityPort(
        invalidRegion,
        () => {
          transportConstructionCount += 1
          return new RecordingIdentityAwsTransport()
        },
      )
    ).toThrow(
      'Migration account, region, profile, commit, or journal configuration is invalid.',
    )
    expect(transportConstructionCount).toBe(0)

    const invalidTableRoles = createRequestedResources()
    Reflect.deleteProperty(invalidTableRoles.tables, 'documents')
    Object.defineProperty(invalidTableRoles.tables, 'unexpected-role', {
      configurable: true,
      enumerable: true,
      value: 'mukuroji-unexpected-production-sensitive',
      writable: true,
    })
    expect(() =>
      validateWorkspaceSearchMigrationRequestedResources(invalidTableRoles)
    ).toThrow('Migration table names must be valid and physically distinct.')
    expect(() =>
      createAwsWorkspaceSearchMigrationIdentityPort(
        invalidTableRoles,
        () => {
          transportConstructionCount += 1
          return new RecordingIdentityAwsTransport()
        },
      )
    ).toThrow('Migration table names must be valid and physically distinct.')
    expect(transportConstructionCount).toBe(0)

    const extraTableRoles = createRequestedResources()
    Object.defineProperty(extraTableRoles.tables, 'unexpected-role', {
      configurable: true,
      enumerable: true,
      value: 'mukuroji-unexpected-production-sensitive',
      writable: true,
    })
    Object.defineProperty(extraTableRoles.tables, Symbol('raw-secret-role'), {
      configurable: true,
      enumerable: true,
      value: 'mukuroji-symbol-production-sensitive',
      writable: true,
    })
    expect(() =>
      createAwsWorkspaceSearchMigrationIdentityPort(
        extraTableRoles,
        () => {
          transportConstructionCount += 1
          return new RecordingIdentityAwsTransport()
        },
      )
    ).toThrow('Migration table names must be valid and physically distinct.')
    expect(transportConstructionCount).toBe(0)

    const rawCanary = 'RAW-REQUEST-CANARY-DO-NOT-LEAK'
    const unreadableResources = createRequestedResources()
    Object.defineProperty(unreadableResources, 'account', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error(rawCanary)
      },
    })
    let unreadableFailure: unknown
    try {
      createAwsWorkspaceSearchMigrationIdentityPort(
        unreadableResources,
        () => {
          transportConstructionCount += 1
          return new RecordingIdentityAwsTransport()
        },
      )
    } catch (error: unknown) {
      unreadableFailure = error
    }
    expect(unreadableFailure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(unreadableFailure instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(unreadableFailure.message).toBe(
      'Migration requested resources are invalid or unreadable.',
    )
    expect(unreadableFailure.message).not.toContain(rawCanary)
    expect(transportConstructionCount).toBe(0)

    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const wrongLookup: WorkspaceSearchMigrationJournalLookup = {
      bucketName: 'other-migration-journal',
      expectedBucketOwner: requested.account,
    }

    await expect(port.describeTable('other-production-table')).rejects.toThrow(
      'Migration identity lookup is outside the requested resource set.',
    )
    await expect(
      port.describeContinuousBackups('other-production-table'),
    ).rejects.toThrow(
      'Migration identity lookup is outside the requested resource set.',
    )
    await expect(
      port.describeTimeToLive('other-production-table'),
    ).rejects.toThrow(
      'Migration identity lookup is outside the requested resource set.',
    )
    await expect(
      port.describeJournalKey(
        `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/other-key`,
      ),
    ).rejects.toThrow(
      'Migration identity lookup is outside the requested resource set.',
    )
    await expect(port.getBucketVersioning(wrongLookup)).rejects.toThrow(
      'Migration identity lookup is outside the requested resource set.',
    )
    await expect(
      port.getObjectLockConfiguration(wrongLookup),
    ).rejects.toThrow(
      'Migration identity lookup is outside the requested resource set.',
    )
    await expect(port.getBucketEncryption(wrongLookup)).rejects.toThrow(
      'Migration identity lookup is outside the requested resource set.',
    )
    await expect(port.getBucketLogging(wrongLookup)).rejects.toThrow(
      'Migration identity lookup is outside the requested resource set.',
    )
    expect(transport.describeTableCommands).toHaveLength(0)
    expect(transport.continuousBackupsCommands).toHaveLength(0)
    expect(transport.describeTimeToLiveCommands).toHaveLength(0)
    expect(transport.describeKeyCommands).toHaveLength(0)
    expect(transport.getBucketVersioningCommands).toHaveLength(0)
    expect(transport.getObjectLockConfigurationCommands).toHaveLength(0)
    expect(transport.getBucketEncryptionCommands).toHaveLength(0)
    expect(transport.getBucketLoggingCommands).toHaveLength(0)
    port.close()
  })

  test('binds one resource snapshot before validation and construction', async () => {
    const requested = createRequestedResources()
    let journalBucketReads = 0
    Object.defineProperty(requested, 'journalBucket', {
      configurable: true,
      enumerable: true,
      get() {
        journalBucketReads += 1
        return journalBucketReads === 1
          ? TEST_BUCKET
          : 'different-valid-migration-journal'
      },
    })
    const transport = new RecordingIdentityAwsTransport()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )

    await port.getBucketVersioning({
      bucketName: TEST_BUCKET,
      expectedBucketOwner: TEST_ACCOUNT,
    })

    expect(journalBucketReads).toBe(1)
    expect(transport.getBucketVersioningCommands[0]?.input).toEqual({
      Bucket: TEST_BUCKET,
      ExpectedBucketOwner: TEST_ACCOUNT,
    })
    port.close()
  })

  test('snapshots each journal lookup before allowlist validation', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    const lookup = createJournalLookup(requested)
    let bucketReads = 0
    let ownerReads = 0
    Object.defineProperty(lookup, 'bucketName', {
      configurable: true,
      enumerable: true,
      get() {
        bucketReads += 1
        return bucketReads === 1 ? TEST_BUCKET : 'attacker-controlled-bucket'
      },
    })
    Object.defineProperty(lookup, 'expectedBucketOwner', {
      configurable: true,
      enumerable: true,
      get() {
        ownerReads += 1
        return ownerReads === 1 ? TEST_ACCOUNT : '999999999999'
      },
    })

    await port.getBucketVersioning(lookup)

    expect(bucketReads).toBe(1)
    expect(ownerReads).toBe(1)
    expect(transport.getBucketVersioningCommands[0]?.input).toEqual({
      Bucket: TEST_BUCKET,
      ExpectedBucketOwner: TEST_ACCOUNT,
    })
    port.close()
  })

  test('measures with the same resource snapshot that configured the port', async () => {
    const requested = createRequestedResources()
    const originalTableName = requested.tables['project-directory']
    const originalBinding =
      createWorkspaceSearchMigrationRequestedResourcesBinding(requested)
    const transport = new RecordingIdentityAwsTransport()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )
    requested.account = '999999999999'
    requested.region = 'us-east-1'
    requested.profile = 'different-production-profile'
    requested.commit = 'b'.repeat(40)
    Reflect.set(
      requested.tables,
      'project-directory',
      'attacker-controlled-table',
    )

    expect(port.readRequestedResourcesBinding()).toBe(originalBinding)
    let failure: unknown
    try {
      await port.measureConfiguration()
    } catch (error: unknown) {
      failure = error
    }

    expect(failure).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(failure instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(failure.message).toContain('table identity is unavailable.')
    expect(failure.message).not.toContain(
      'STS caller identity does not match the requested migration account.',
    )
    expect(transport.describeTableCommands).toHaveLength(6)
    expect(
      transport.describeTableCommands.some(
        (command) => command.input.TableName === originalTableName,
      ),
    ).toBe(true)
    expect(
      transport.describeTableCommands.some(
        (command) => command.input.TableName === 'attacker-controlled-table',
      ),
    ).toBe(false)
    port.close()
  })

  test('snapshots STS and KMS response fields before returning them', async () => {
    const transport = new RecordingIdentityAwsTransport()
    let accountReads = 0
    Object.defineProperty(transport.callerIdentityOutput, 'Account', {
      configurable: true,
      enumerable: true,
      get() {
        accountReads += 1
        return accountReads === 1 ? TEST_ACCOUNT : '999999999999'
      },
    })
    const metadata = transport.keyOutput.KeyMetadata
    if (!metadata) {
      throw new Error('Expected KMS key metadata.')
    }
    let creationDateReads = 0
    Object.defineProperty(metadata, 'CreationDate', {
      configurable: true,
      enumerable: true,
      get() {
        creationDateReads += 1
        const creationDate = creationDateReads === 1
          ? new Date('2026-07-01T00:00:00.000Z')
          : new Date('2030-01-01T00:00:00.000Z')
        Object.defineProperty(creationDate, 'getTime', {
          configurable: true,
          value() {
            throw new Error('RAW-HOSTILE-KMS-GET-TIME')
          },
        })
        return creationDate
      },
    })
    const requested = createRequestedResources()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )

    const caller = await port.readCallerIdentity()
    const keyMetadata = await port.describeJournalKey(requested.journalKeyArn)

    expect(accountReads).toBe(1)
    expect(caller.account).toBe(TEST_ACCOUNT)
    expect(creationDateReads).toBe(1)
    expect(keyMetadata.creationDate).toEqual(
      new Date('2026-07-01T00:00:00.000Z'),
    )
    port.close()
  })

  test('emits a stable failure for incomplete STS output without leaking fields', async () => {
    const rawCanary = 'RAW-STS-CANARY-DO-NOT-LEAK'
    const transport = new RecordingIdentityAwsTransport()
    transport.callerIdentityOutput = {
      $metadata: {},
      Account: TEST_ACCOUNT,
      Arn: rawCanary,
    }
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      createRequestedResources(),
      () => transport,
    )

    let caught: unknown
    try {
      await port.readCallerIdentity()
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (!(caught instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a Workspace Search migration failure.')
    }
    expect(caught.code).toBe('IDENTITY_MISMATCH')
    expect(caught.message).toBe('STS caller identity response is incomplete.')
    expect(caught.message).not.toContain(rawCanary)
    await expect(port.measureConfiguration()).rejects.toThrow(
      'STS caller identity response is incomplete.',
    )
    port.close()
  })

  test('returns absent KMS metadata for existing strict validation', async () => {
    const transport = new RecordingIdentityAwsTransport()
    transport.keyOutput = { $metadata: {} }
    const requested = createRequestedResources()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )

    await expect(
      port.describeJournalKey(requested.journalKeyArn),
    ).resolves.toEqual({
      arn: undefined,
      awsAccountId: undefined,
      creationDate: undefined,
      enabled: undefined,
      keyId: undefined,
      keyManager: undefined,
      keySpec: undefined,
      keyState: undefined,
      keyUsage: undefined,
      multiRegion: undefined,
      origin: undefined,
    })
    port.close()
  })

  test('preserves modeled S3 failures for the identity classifier', async () => {
    const transport = new RecordingIdentityAwsTransport()
    const failure = new Error('raw details')
    failure.name = 'ObjectLockConfigurationNotFoundError'
    transport.objectLockFailure = failure
    const requested = createRequestedResources()
    const port = createAwsWorkspaceSearchMigrationIdentityPort(
      requested,
      () => transport,
    )

    await expect(
      port.getObjectLockConfiguration(createJournalLookup(requested)),
    ).rejects.toBe(failure)
    port.close()
  })
})

/**
 * Opts one recording transport into a complete valid identity measurement.
 *
 * Empty responses remain the transport default so existing negative tests keep
 * exercising the same fail-closed behavior.
 *
 * @param transport - Recording transport to seed.
 * @param requested - Exact resources whose identity will be measured.
 */
function seedValidMeasurementOutputs(
  transport: RecordingIdentityAwsTransport,
  requested: WorkspaceSearchMigrationRequestedResources,
): void {
  const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
    'project-directory',
    'work-items',
    'collaboration',
    'documents',
    'workspace-search',
    'migration-state',
  ]
  for (const role of tableRoles) {
    const tableName = requested.tables[role]
    transport.describeTableOutputs.set(
      tableName,
      createValidDescribeTableOutput(role, tableName, requested),
    )
    transport.continuousBackupsOutputs.set(
      tableName,
      createValidContinuousBackupsOutput(),
    )
    transport.describeTimeToLiveOutputs.set(
      tableName,
      createValidTimeToLiveOutput(role),
    )
  }
  transport.callerIdentityOutput = {
    $metadata: {},
    Account: requested.account,
    Arn:
      `arn:aws:sts::${requested.account}:assumed-role/MigrationOperator/${TEST_SESSION_NAME}`,
    UserId: `${TEST_ROLE_ID}:${TEST_SESSION_NAME}`,
  }
  transport.keyOutput = {
    $metadata: {},
    KeyMetadata: {
      Arn: requested.journalKeyArn,
      AWSAccountId: requested.account,
      CreationDate: new Date('2026-07-01T00:00:00.000Z'),
      Enabled: true,
      KeyId: TEST_KEY_ID,
      KeyManager: 'CUSTOMER',
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyState: 'Enabled',
      KeyUsage: 'ENCRYPT_DECRYPT',
      MultiRegion: false,
      Origin: 'AWS_KMS',
    },
  }
  transport.bucketVersioningOutput = {
    Status: 'Enabled',
  }
  transport.objectLockOutput = {
    ObjectLockConfiguration: {
      ObjectLockEnabled: 'Enabled',
      Rule: {
        DefaultRetention: {
          Mode: 'COMPLIANCE',
          Days: 30,
        },
      },
    },
  }
  transport.bucketEncryptionOutput = {
    ServerSideEncryptionConfiguration: {
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: 'aws:kms',
            KMSMasterKeyID: requested.journalKeyArn,
          },
          BucketKeyEnabled: true,
        },
      ],
    },
  }
  transport.bucketLoggingOutput = {
    LoggingEnabled: {
      TargetBucket: `${requested.journalBucket}-access-logs`,
      TargetPrefix: 'workspace-search-migration/',
    },
  }
}

/**
 * Creates one complete active table response for identity measurement.
 *
 * @param role - Logical migration table role.
 * @param tableName - Exact physical table name.
 * @param requested - Account, region, and KMS identity constraints.
 * @returns Valid DynamoDB table response.
 */
function createValidDescribeTableOutput(
  role: WorkspaceSearchMigrationTableRole,
  tableName: string,
  requested: WorkspaceSearchMigrationRequestedResources,
): DescribeTableCommandOutput {
  const schema = readMeasurementTableSchema(role)
  const table: TableDescription = {
    AttributeDefinitions: [...schema.attributeDefinitions],
    TableName: tableName,
    KeySchema: [...schema.keySchema],
    TableStatus: 'ACTIVE',
    CreationDateTime: new Date('2026-07-01T00:00:00.000Z'),
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    TableArn:
      `arn:${readPartition(requested.region)}:dynamodb:${requested.region}:${requested.account}:table/${tableName}`,
    TableId: `table-id-${role}-v1`,
    GlobalSecondaryIndexes: [...schema.globalSecondaryIndexes],
    DeletionProtectionEnabled: schema.deletionProtection,
  }
  if (schema.kmsEncrypted) {
    table.SSEDescription = {
      Status: 'ENABLED',
      SSEType: 'KMS',
      KMSMasterKeyArn: requested.journalKeyArn,
    }
  }
  return {
    $metadata: {},
    Table: table,
  }
}

/**
 * Creates an active same-name table response for a different incarnation.
 *
 * @param role - Logical migration table role.
 * @param tableName - Exact physical table name.
 * @param requested - Account, region, and KMS identity constraints.
 * @returns Valid schema with a replacement table ID and creation time.
 */
function createReplacementDescribeTableOutput(
  role: WorkspaceSearchMigrationTableRole,
  tableName: string,
  requested: WorkspaceSearchMigrationRequestedResources,
): DescribeTableCommandOutput {
  const output = createValidDescribeTableOutput(
    role,
    tableName,
    requested,
  )
  if (output.Table === undefined) {
    throw new Error('Expected a complete replacement table fixture.')
  }
  output.Table.TableId = `replacement-table-id-${role}-v2`
  output.Table.CreationDateTime = new Date('2026-07-27T00:00:00.000Z')
  return output
}

/**
 * Returns the exact schema and safety fixture for one measured table role.
 *
 * @param role - Logical migration table role.
 * @returns Valid role-specific descriptor.
 */
function readMeasurementTableSchema(
  role: WorkspaceSearchMigrationTableRole,
): MeasurementTableSchemaFixture {
  if (role === 'project-directory') {
    return {
      attributeDefinitions: [
        stringAttribute('directoryId'),
        stringAttribute('entryKey'),
        stringAttribute('webhookAuthorizationKey'),
        stringAttribute('webhookAuthorizationSortKey'),
      ],
      keySchema: [
        hashKey('directoryId'),
        rangeKey('entryKey'),
      ],
      globalSecondaryIndexes: [
        {
          IndexName: 'WebhookAuthorizationIndex',
          KeySchema: [
            hashKey('webhookAuthorizationKey'),
            rangeKey('webhookAuthorizationSortKey'),
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
          IndexStatus: 'ACTIVE',
        },
      ],
      ttlAttribute: undefined,
      kmsEncrypted: false,
      deletionProtection: false,
    }
  }
  if (role === 'work-items') {
    return {
      attributeDefinitions: [
        stringAttribute('directoryTeamId'),
        stringAttribute('issueId'),
        stringAttribute('directoryProjectId'),
        numberAttribute('sortOrder'),
        stringAttribute('updatedAt'),
      ],
      keySchema: [
        hashKey('directoryTeamId'),
        rangeKey('issueId'),
      ],
      globalSecondaryIndexes: [
        {
          IndexName: 'AssignedProjectIssueIndex',
          KeySchema: [
            hashKey('directoryProjectId'),
            rangeKey('sortOrder'),
          ],
          Projection: { ProjectionType: 'ALL' },
          IndexStatus: 'ACTIVE',
        },
        {
          IndexName: 'TeamIssueSortOrderIndex',
          KeySchema: [
            hashKey('directoryTeamId'),
            rangeKey('sortOrder'),
          ],
          Projection: { ProjectionType: 'ALL' },
          IndexStatus: 'ACTIVE',
        },
        {
          IndexName: 'TeamIssueUpdatedAtIndex',
          KeySchema: [
            hashKey('directoryTeamId'),
            rangeKey('updatedAt'),
          ],
          Projection: { ProjectionType: 'ALL' },
          IndexStatus: 'ACTIVE',
        },
      ],
      ttlAttribute: undefined,
      kmsEncrypted: false,
      deletionProtection: false,
    }
  }
  if (role === 'collaboration') {
    return {
      attributeDefinitions: [
        stringAttribute('entityKey'),
        stringAttribute('recordKey'),
      ],
      keySchema: [
        hashKey('entityKey'),
        rangeKey('recordKey'),
      ],
      globalSecondaryIndexes: [],
      ttlAttribute: 'expiresAt',
      kmsEncrypted: false,
      deletionProtection: false,
    }
  }
  if (role === 'documents') {
    return {
      attributeDefinitions: [
        stringAttribute('workspaceId'),
        stringAttribute('recordKey'),
      ],
      keySchema: [
        hashKey('workspaceId'),
        rangeKey('recordKey'),
      ],
      globalSecondaryIndexes: [],
      ttlAttribute: 'expiresAtEpoch',
      kmsEncrypted: true,
      deletionProtection: false,
    }
  }
  if (role === 'workspace-search') {
    return {
      attributeDefinitions: [
        stringAttribute('workspaceId'),
        stringAttribute('recordKey'),
      ],
      keySchema: [
        hashKey('workspaceId'),
        rangeKey('recordKey'),
      ],
      globalSecondaryIndexes: [],
      ttlAttribute: undefined,
      kmsEncrypted: false,
      deletionProtection: false,
    }
  }
  return {
    attributeDefinitions: [
      stringAttribute('migrationId'),
      stringAttribute('recordKey'),
    ],
    keySchema: [
      hashKey('migrationId'),
      rangeKey('recordKey'),
    ],
    globalSecondaryIndexes: [],
    ttlAttribute: undefined,
    kmsEncrypted: true,
    deletionProtection: true,
  }
}

/**
 * Creates enabled PITR evidence with an ordered restore window.
 *
 * @returns Valid DynamoDB continuous-backup response.
 */
function createValidContinuousBackupsOutput():
  DescribeContinuousBackupsCommandOutput {
  return {
    $metadata: {},
    ContinuousBackupsDescription: {
      ContinuousBackupsStatus: 'ENABLED',
      PointInTimeRecoveryDescription: {
        PointInTimeRecoveryStatus: 'ENABLED',
        EarliestRestorableDateTime:
          new Date('2026-07-01T00:01:00.000Z'),
        LatestRestorableDateTime:
          new Date('2026-07-24T23:59:00.000Z'),
      },
    },
  }
}

/**
 * Creates exact role-specific TTL evidence.
 *
 * @param role - Logical migration table role.
 * @returns Valid DynamoDB TTL response.
 */
function createValidTimeToLiveOutput(
  role: WorkspaceSearchMigrationTableRole,
): DescribeTimeToLiveCommandOutput {
  const ttlAttribute = readMeasurementTableSchema(role).ttlAttribute
  if (ttlAttribute !== undefined) {
    return {
      $metadata: {},
      TimeToLiveDescription: {
        TimeToLiveStatus: 'ENABLED',
        AttributeName: ttlAttribute,
      },
    }
  }
  return {
    $metadata: {},
    TimeToLiveDescription: {
      TimeToLiveStatus: 'DISABLED',
    },
  }
}

/**
 * Creates one complete managed source Scan input.
 *
 * @param configuration - Successfully measured session configuration.
 * @param source - Selected allowlisted logical source.
 * @param previousCheckpoint - Durable predecessor to resume from.
 * @returns Complete measured source read.
 */
function createSourceScanInput(
  configuration: WorkspaceSearchMigrationConfiguration,
  source: WorkspaceSearchMigrationSourceName = 'project-directory',
  previousCheckpoint: MigrationSourceCheckpoint =
    createEmptyWorkspaceSearchMigrationCheckpoint(),
): WorkspaceSearchMigrationSourceScanReadInput {
  return {
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source,
    previousCheckpoint,
  }
}

/**
 * Creates one complete managed target Scan input.
 *
 * @param configuration - Successfully measured session configuration.
 * @param previousCheckpoint - Durable predecessor to resume from.
 * @returns Complete measured target read.
 */
function createTargetScanInput(
  configuration: WorkspaceSearchMigrationConfiguration,
  previousCheckpoint?: WorkspaceSearchMigrationTargetScanCheckpoint,
): WorkspaceSearchMigrationTargetScanReadInput {
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  return {
    configuration,
    configurationHash,
    previousCheckpoint:
      previousCheckpoint ??
        createEmptyWorkspaceSearchMigrationTargetScanCheckpoint(
          configurationHash,
        ),
  }
}

/**
 * Creates one measured dry-run evidence-chain request.
 *
 * @param configuration - Successfully measured session configuration.
 * @returns Exact managed source-evidence request.
 */
function createSourceEvidenceRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest {
  return {
    runId: 'managed-source-evidence-run',
    purpose: 'dry-run',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source: 'project-directory',
  }
}

/**
 * Creates one measured authority-bound planning evidence-chain request.
 *
 * @param configuration - Successfully measured session configuration.
 * @param authority - Detached current durable pre-plan authority.
 * @param source - Fixed source evidence chain to address.
 * @returns Exact managed planning source-evidence commit request.
 */
function createPlanningSourceEvidenceRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  source: WorkspaceSearchMigrationSourceName = 'project-directory',
): WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest {
  return {
    runId: authority.lease.runId,
    purpose: 'planning',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source,
    authority,
  }
}

/**
 * Creates one measured authority-bound planning target evidence request.
 *
 * @param configuration - Successfully measured session configuration.
 * @param authority - Detached current durable pre-plan authority.
 * @returns Exact managed planning target-evidence commit request.
 */
function createPlanningTargetEvidenceRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest {
  return {
    runId: authority.lease.runId,
    purpose: 'planning',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    authority,
  }
}

/**
 * Creates one measured target evidence read request without mutable authority.
 *
 * @param configuration - Successfully measured session configuration.
 * @param runId - Exact durable planning run to read.
 * @returns Exact managed target-evidence read request.
 */
function createTargetEvidenceReadRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  runId: string,
): WorkspaceSearchMigrationTargetEvidenceAwsRequest {
  return {
    runId,
    purpose: 'planning',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
  }
}

/**
 * Creates one valid empty plan seal for managed storage composition tests.
 *
 * @param runId - Exact run owning the immutable planning graph.
 * @param configurationHash - Exact measured-configuration digest.
 * @param planningSnapshotDigest - Exact provenance-derived snapshot digest.
 * @param createdAt - Canonical plan-seal creation timestamp.
 * @returns Strict empty plan seal accepted by the planning gateway.
 */
function createManagedPlanningArtifactEmptyPlanSeal(
  runId: string,
  configurationHash: string,
  planningSnapshotDigest =
    createMigrationDigest('managed-planning-snapshot'),
  createdAt = '2026-07-28T00:00:00.000Z',
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    runId,
    configurationHash,
    dryRunEvidenceDigest: createMigrationDigest('managed-dry-run'),
    planningSnapshotDigest,
    planDigest: createEmptyWorkspaceSearchPlanDigest(),
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt,
  }
}

/**
 * Captures one expected fixed-message migration failure.
 *
 * @param operation - Managed operation expected to stop safely.
 * @returns Exact public migration failure.
 */
async function captureWorkspaceSearchMigrationFailure(
  operation: Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) return error
    throw error
  }
  throw new Error('Expected a Workspace Search migration failure.')
}

/**
 * Acquires one lease and installs fresh maintenance evidence for planning.
 *
 * @param port - Measured managed identity session.
 * @param clockAt - Trusted authority clock fixture.
 * @param identifier - Unique lease identity suffix.
 * @returns Current durable planning authority.
 */
async function createManagedPlanningAuthority(
  port: WorkspaceSearchMigrationManagedAwsSession,
  clockAt: string,
  identifier: string,
): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
  const lease = await port.acquireLease({
    runId: `${identifier}-run`,
    ownerId: `${identifier}-owner`,
  })
  return port.renewMaintenanceEvidence({
    lease: {
      runId: lease.runId,
      ownerId: lease.ownerId,
      fenceToken: lease.fenceToken,
    },
    expectedPointer: null,
    evidenceBytes: createManagedMaintenanceEvidenceBytes(clockAt),
  })
}

/**
 * Commits one ignored source row, three empty source pages, and two target rows.
 *
 * @param identifier - Unique run and authority fixture suffix.
 * @param clock - Optional controllable clock shared by the managed session.
 * @param prepareAuthority - Optional execution-control preparation before planning.
 * @param includeApplyOperation - Whether to commit one mapped source mutation.
 * @param mutateApplyTarget - Whether the mapped target differs from its source.
 * @returns Measured session, recording transport, and bounded join input.
 */
async function createManagedCommittedPlanningFixture(
  identifier: string,
  clock?: () => Date,
  prepareAuthority?: ManagedPlanningAuthorityPreparation,
  includeApplyOperation = false,
  mutateApplyTarget = false,
): Promise<ManagedCommittedPlanningFixture> {
  const requested = createRequestedResources()
  const transport = new RecordingIdentityAwsTransport()
  seedValidMeasurementOutputs(transport, requested)
  const clockAt = '2026-07-28T07:00:00.000Z'
  const port = createAwsWorkspaceSearchMigrationIdentityPort(
    requested,
    () => transport,
    clock ?? (() => new Date(clockAt)),
  )
  const configuration = await port.measureConfiguration()
  const authority = await createManagedPlanningAuthority(
    port,
    clockAt,
    `managed-join-${identifier}`,
  )
  const planningAuthority = prepareAuthority === undefined
    ? authority
    : await prepareAuthority({
        port,
        transport,
        configuration,
        authority: structuredClone(authority),
      })
  for (const source of workspaceSearchMigrationSourceNames) {
    const sourceItems = source === 'project-directory'
      ? includeApplyOperation
        ? [createManagedApplySourceItem()]
        : [createIgnoredSourceItem(`${identifier}-source`)]
      : []
    transport.scanSourceOutput = {
      $metadata: {},
      Count: sourceItems.length,
      Items: sourceItems,
      ScannedCount: sourceItems.length,
    }
    await port.commitNextSourceEvidencePage(
      createPlanningSourceEvidenceRequest(
        configuration,
        structuredClone(planningAuthority),
        source,
      ),
    )
  }
  const targetItems = includeApplyOperation
    ? [createManagedApplyTargetItem(mutateApplyTarget)]
    : [
        createIgnoredTargetItem(`${identifier}-one`),
        createIgnoredTargetItem(`${identifier}-two`),
      ]
  transport.scanTargetOutput = {
    $metadata: {},
    Count: targetItems.length,
    Items: targetItems,
    ScannedCount: targetItems.length,
  }
  await port.commitNextTargetEvidencePage(
    createPlanningTargetEvidenceRequest(
      configuration,
      structuredClone(planningAuthority),
    ),
  )
  return {
    requested,
    port,
    transport,
    authority: structuredClone(planningAuthority),
    input: {
      runId: planningAuthority.lease.runId,
      configuration,
      configurationHash:
        createWorkspaceSearchConfigurationHash(configuration),
      limits: {
        maxTotalRows: 100,
        maxTotalCanonicalItemBytes: 1024 * 1024,
        maxPlanOperations: 100,
      },
    },
  }
}

/**
 * Reads exact canonical planning evidence bytes from one recorded commit.
 *
 * @param command - Recorded source or target evidence transaction.
 * @returns Detached canonical evidence page bytes.
 */
function readManagedEvidencePageBytes(
  command: TransactWriteItemsCommand | undefined,
): Uint8Array {
  const bytes =
    command?.input.TransactItems?.[3]?.Put?.Item?.payload?.B
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Expected canonical managed evidence page bytes.')
  }
  return Uint8Array.from(bytes)
}

/**
 * Builds one real five-chain immutable graph ready for managed publication.
 *
 * @param identifier - Unique run and immutable-object fixture suffix.
 * @param clock - Optional controllable clock shared by the managed session.
 * @param prepareAuthority - Optional execution-control preparation before planning.
 * @param planCreatedAt - Optional canonical plan-seal creation time.
 * @param retainUntil - Optional immutable-artifact retention deadline.
 * @param includeApplyOperation - Whether to seal the one mapped candidate.
 * @param mutateApplyTarget - Whether the mapped target differs from its source.
 * @returns Complete measured publication fixture.
 */
async function createManagedSealedPublicationFixture(
  identifier: string,
  clock?: () => Date,
  prepareAuthority?: ManagedPlanningAuthorityPreparation,
  planCreatedAt = '2026-07-28T00:00:00.000Z',
  retainUntil = '2026-08-27T07:01:00.000Z',
  includeApplyOperation = false,
  mutateApplyTarget = false,
): Promise<ManagedSealedPublicationFixture> {
  const fixture = await createManagedCommittedPlanningFixture(
    identifier,
    clock,
    prepareAuthority,
    includeApplyOperation,
    mutateApplyTarget,
  )
  const joined = await fixture.port.joinCommittedPlanningEvidence(
    fixture.input,
  )
  const historical =
    await fixture.port.readHistoricalMaintenanceEvidenceBinding(
      fixture.authority.lease.runId,
      fixture.authority.maintenanceEvidenceReceiptDigest,
    )
  if (historical === undefined) {
    throw new Error('Expected historical maintenance evidence binding.')
  }
  const sourceCommands =
    fixture.transport.transactWriteSourceEvidenceCommands
  const targetCommand =
    fixture.transport.transactWriteTargetEvidenceCommands[0]
  const gateway = fixture.port.createPlanningArtifactGateway(
    fixture.input.runId,
  )
  const storedProvenance =
    await gateway.writePlanningProvenanceArtifact({
      sourceEvidencePageBytes: {
        'project-directory': [
          readManagedEvidencePageBytes(sourceCommands[0]),
        ],
        'work-items': [
          readManagedEvidencePageBytes(sourceCommands[1]),
        ],
        collaboration: [
          readManagedEvidencePageBytes(sourceCommands[2]),
        ],
        documents: [
          readManagedEvidencePageBytes(sourceCommands[3]),
        ],
      },
      targetEvidencePageBytes: [
        readManagedEvidencePageBytes(targetCommand),
      ],
      historicalReceiptBindings: [historical],
      retainUntil,
    })
  const emptyPlanSeal = createManagedPlanningArtifactEmptyPlanSeal(
    fixture.input.runId,
    fixture.input.configurationHash,
    storedProvenance.manifestHead.summary.planningSnapshotDigest,
    planCreatedAt,
  )
  let plannedOperation: WorkspaceSearchPlannedOperation | undefined
  let planSeal = emptyPlanSeal
  if (includeApplyOperation) {
    const candidate = joined.candidates[0]
    if (candidate === undefined || joined.candidates.length !== 1) {
      throw new Error('Expected one exact managed apply candidate.')
    }
    const planDigest = createWorkspaceSearchPlanLeafDigest({
      planSequence: 1,
      operationDigest: candidate.operationDigest,
    })
    plannedOperation = {
      runId: fixture.input.runId,
      configurationHash: fixture.input.configurationHash,
      planDigest,
      planSequence: 1,
      operationDigest: candidate.operationDigest,
      membershipProof: [],
      operation: candidate.operation,
    }
    planSeal = {
      ...emptyPlanSeal,
      planDigest,
      planOperationCount: 1,
      sourceOperationCount: 1,
      orphanOperationCount: 0,
    }
  }
  const storedPlan = await gateway.writePlanArtifact({
    planSeal,
    operations:
      plannedOperation === undefined ? [] : [plannedOperation],
    retainUntil,
  })
  return {
    requested: fixture.requested,
    port: fixture.port,
    transport: fixture.transport,
    plannedOperation,
    publishInput: {
      runId: fixture.input.runId,
      configuration: fixture.input.configuration,
      configurationHash: fixture.input.configurationHash,
      planSeal,
      planSealReference: storedPlan.planSealReference,
      planManifestHead: storedPlan.manifestHead,
      planManifestHeadReference: storedPlan.manifestHeadReference,
      planningProvenanceManifestHead: storedProvenance.manifestHead,
      planningProvenanceManifestHeadReference:
        storedProvenance.manifestHeadReference,
      planningAuthorityProvenance:
        storedProvenance.planningAuthorityProvenance,
      sourceProgress: joined.sourceProgress,
      targetProgress: joined.targetProgress,
      currentAuthority: fixture.authority,
    },
  }
}

/**
 * Builds one planning-admitted, sealed, and still-fresh execution-run fixture.
 *
 * @param identifier - Unique execution-control fixture suffix.
 * @param includeApplyOperation - Whether to admit one source mutation.
 * @param mutateApplyTarget - Whether the admitted target requires a write.
 * @returns Complete measured execution-run admission material.
 */
async function createManagedExecutionRunFixture(
  identifier: string,
  includeApplyOperation = false,
  mutateApplyTarget = false,
): Promise<ManagedExecutionRunFixture> {
  let clockAt = '2026-07-28T07:00:00.000Z'
  let executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary | undefined
  let closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord | undefined
  const publication =
    await createManagedSealedPublicationFixture(
      identifier,
      () => new Date(clockAt),
      async (context) => {
        const writerFence =
          context.port.createApplicationWriterFencePort()
        await writerFence.bootstrapOpen(context.authority)
        const boundaryPort =
          context.port.createExecutionBoundaryPort()
        await boundaryPort.close(context.authority)
        clockAt = '2026-07-28T07:16:00.000Z'
        const admissionLease = await context.port.acquireLease({
          runId: context.authority.lease.runId,
          ownerId: `managed-execution-run-${identifier}-owner`,
        })
        const maintenanceEvidenceBytes =
          createManagedMaintenanceEvidenceBytes(clockAt)
        const admissionAuthority =
          await context.port.renewMaintenanceEvidence({
            lease: {
              runId: admissionLease.runId,
              ownerId: admissionLease.ownerId,
              fenceToken: admissionLease.fenceToken,
            },
            expectedPointer: null,
            evidenceBytes: maintenanceEvidenceBytes,
          })
        executionBoundary = await boundaryPort.admitPlanning({
          currentAuthority: admissionAuthority,
          maintenanceEvidenceBytes,
        })
        const fence = await writerFence.read()
        if (
          fence.status !== 'present' ||
          fence.record.mode !== 'closed'
        ) {
          throw new Error('Expected one exact managed closed writer fence.')
        }
        closedWriterFenceRecord = fence.record
        return admissionAuthority
      },
      '2026-07-28T07:16:10.000Z',
      '2026-08-27T07:17:00.000Z',
      includeApplyOperation,
      mutateApplyTarget,
    )
  if (
    executionBoundary === undefined ||
    closedWriterFenceRecord === undefined
  ) {
    throw new Error('Expected complete managed execution admission material.')
  }
  clockAt = '2026-07-28T07:16:20.000Z'
  const sealedPlanningAuthority =
    await publication.port
      .createSealedPlanningAuthorityPort()
      .publish(publication.publishInput)
  clockAt = '2026-07-28T07:16:30.000Z'
  const publishedAuthority = publication.publishInput.currentAuthority
  const currentAuthority = await publication.port.readAuthority({
    lease: {
      runId: publishedAuthority.lease.runId,
      ownerId: publishedAuthority.lease.ownerId,
      fenceToken: publishedAuthority.lease.fenceToken,
    },
    maintenanceEvidenceReceiptDigest:
      publishedAuthority.maintenanceEvidenceReceiptDigest,
    maintenanceEvidencePointerRevision:
      publishedAuthority.maintenanceEvidencePointerRevision,
  })
  return {
    requested: publication.requested,
    port: publication.port,
    transport: publication.transport,
    currentAuthority,
    executionBoundary,
    sealedPlanningAuthority,
    planSeal: structuredClone(publication.publishInput.planSeal),
    closedWriterFenceRecord,
    plannedOperation: publication.plannedOperation,
  }
}

/**
 * Builds one measured execution admission with one already-current operation.
 *
 * @param identifier - Unique managed apply fixture suffix.
 * @param mutateApplyTarget - Whether the admitted target requires a write.
 * @returns Complete apply port material and live source/target read outputs.
 */
async function createManagedApplyOperationFixture(
  identifier: string,
  mutateApplyTarget = false,
): Promise<ManagedApplyOperationFixture> {
  const fixture = await createManagedExecutionRunFixture(
    identifier,
    true,
    mutateApplyTarget,
  )
  const plannedOperation = fixture.plannedOperation
  if (plannedOperation === undefined) {
    throw new Error('Expected one admitted managed apply operation.')
  }
  const executionRun = await fixture.port.createExecutionRunPort(
    fixture.executionBoundary,
    fixture.sealedPlanningAuthority,
    fixture.planSeal,
    fixture.closedWriterFenceRecord,
  ).create(fixture.currentAuthority)
  const source = plannedOperation.operation.sourceCondition
  const before = plannedOperation.operation.before
  const after = plannedOperation.operation.after
  if (!source.exists || !before.exists || !after.exists) {
    throw new Error('Expected present managed apply source and target.')
  }
  let applyCommitted = false
  if (mutateApplyTarget) {
    fixture.transport.immutableArtifactLastModified =
      new Date('2026-07-28T07:16:30.000Z')
    fixture.transport
      .transactWritePrePlanAuthorityPostCommitEffect = () => {
        applyCommitted = true
      }
  }
  fixture.transport.getPrePlanAuthorityApplyOutput = (command) => {
    if (command.input.TableName === source.tableName) {
      return {
        $metadata: {},
        Item: structuredClone(source.item),
      }
    }
    if (
      command.input.TableName ===
        fixture.requested.tables['workspace-search']
    ) {
      return {
        $metadata: {},
        Item: structuredClone(
          applyCommitted ? after.item : before.item,
        ),
      }
    }
    return undefined
  }
  return {
    requested: fixture.requested,
    port: fixture.port,
    transport: fixture.transport,
    currentAuthority: fixture.currentAuthority,
    executionBoundary: fixture.executionBoundary,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    planSeal: fixture.planSeal,
    closedWriterFenceRecord: fixture.closedWriterFenceRecord,
    executionRun,
    plannedOperation,
  }
}

/**
 * Creates one managed apply port and durably completes its single plan item.
 *
 * @param fixture - Exact admitted managed apply fixture.
 * @returns Apply port at revision two, ready for checkpoint traversal.
 */
async function createManagedApplyCheckpointPort(
  fixture: ManagedApplyOperationFixture,
): Promise<WorkspaceSearchMigrationApplyOperationAwsPort> {
  const apply = fixture.port.createApplyOperationPort(
    fixture.executionBoundary,
    fixture.sealedPlanningAuthority,
    fixture.closedWriterFenceRecord,
    fixture.executionRun,
  )
  const applied = await apply.commitApplyOperation(
    createManagedApplyOperationCommand(fixture),
  )
  if (
    applied.revision !== 2 ||
    applied.appliedOperationCount !== applied.planOperationCount
  ) {
    throw new Error('Expected complete managed apply operation progress.')
  }
  return apply
}

/**
 * Creates one strict managed apply command for the fixture's first revision.
 *
 * @param fixture - Exact admitted managed apply fixture.
 * @returns Revision-one mutation request under the current lease.
 */
function createManagedApplyOperationCommand(
  fixture: ManagedApplyOperationFixture,
): WorkspaceSearchMigrationCommandInput<
  WorkspaceSearchApplyOperationCommandEvent
> {
  return {
    expectedRevision: 1,
    lease: {
      runId: fixture.currentAuthority.lease.runId,
      ownerId: fixture.currentAuthority.lease.ownerId,
      fenceToken: fixture.currentAuthority.lease.fenceToken,
    },
    event: {
      kind: 'apply-operation-requested',
      plannedOperation: structuredClone(fixture.plannedOperation),
    },
  }
}

/**
 * Creates one strict managed apply checkpoint command.
 *
 * @param fixture - Exact admitted managed apply fixture.
 * @param location - Source or target traversal selected for one page.
 * @param expectedRevision - Exact durable revision before the page.
 * @returns Exact checkpoint command under the current lease.
 */
function createManagedApplyCheckpointCommand(
  fixture: ManagedApplyOperationFixture,
  location: WorkspaceSearchMigrationCheckpointCommandInput['location'],
  expectedRevision: number,
): WorkspaceSearchMigrationCheckpointCommandInput {
  return {
    expectedRevision,
    lease: {
      runId: fixture.currentAuthority.lease.runId,
      ownerId: fixture.currentAuthority.lease.ownerId,
      fenceToken: fixture.currentAuthority.lease.fenceToken,
    },
    location,
  }
}

/**
 * Creates valid fresh maintenance-evidence bytes for one managed-session test.
 *
 * @param at - Trusted authority clock used to validate evidence freshness.
 * @returns Strict UTF-8 JSON maintenance evidence.
 */
function createManagedMaintenanceEvidenceBytes(at: string): Uint8Array {
  const now = Date.parse(at)
  if (!Number.isFinite(now)) {
    throw new Error('Expected one canonical authority fixture time.')
  }
  const drainCompletedAt = new Date(now - 60_000).toISOString()
  const drainStartedAt =
    new Date(now - 16 * 60_000).toISOString()
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    locator: 'change:OPS-2026',
    runtimeMode: 'disabled',
    runtimeRevision: 42,
    drainStartedAt,
    drainCompletedAt,
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: 42,
      observedAt: drainCompletedAt,
    })),
  }))
}

/**
 * Creates the exact mapped Team source row used by managed apply tests.
 *
 * @returns Canonical Project Directory Team item.
 */
function createManagedApplySourceItem(): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: '000001#000000#TEAM#team-1' },
    entryType: { S: 'team' },
    teamId: { S: 'team-1' },
    teamSortOrder: { N: '1' },
    nameJa: { S: '' },
    nameEn: { S: 'After team' },
  }
}

/**
 * Creates the exact pre-migration target row used by managed apply tests.
 *
 * @param mutate - Whether to return the pre-migration rather than current row.
 * @returns Canonical Workspace Search Team document.
 */
function createManagedApplyTargetItem(
  mutate: boolean,
): DynamoAttributeMap {
  return encodeWorkspaceSearchMigrationDocument(
    createTeamWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      title: mutate ? 'Before team' : 'After team',
    }),
  )
}

/**
 * Creates one recognized non-target Project Directory source item.
 *
 * @param identifier - Unique physical key suffix.
 * @returns Exact low-level ignored source item.
 */
function createIgnoredSourceItem(identifier: string): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `WORKSPACE_MEMBER#${identifier}` },
    entryType: { S: 'workspace-member' },
    payload: { S: 'fixture' },
  }
}

/**
 * Creates one exact Project Directory continuation key.
 *
 * @param identifier - Unique cursor suffix.
 * @returns Exact low-level composite table key.
 */
function createProjectDirectoryCursor(
  identifier: string,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `WORKSPACE_MEMBER#${identifier}` },
  }
}

/**
 * Creates one recognized saved-view row outside migration ownership.
 *
 * @param identifier - Unique physical key suffix.
 * @returns Exact low-level ignored target item.
 */
function createIgnoredTargetItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'saved-view' },
  }
}

/**
 * Creates one key-valid target row with a conflicting family discriminator.
 *
 * @param identifier - Unique physical key suffix.
 * @returns Exact low-level invalid target item.
 */
function createInvalidTargetItem(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
    entryType: { S: 'search-document' },
  }
}

/**
 * Creates one exact Workspace Search target continuation key.
 *
 * @param identifier - Unique cursor suffix.
 * @returns Exact low-level composite target key.
 */
function createTargetCursor(identifier: string): DynamoAttributeMap {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `VIEW#${identifier}` },
  }
}

/**
 * Creates a valid empty low-level source Scan response.
 *
 * @returns Empty terminal DynamoDB Scan output.
 */
function createEmptyScanOutput(): ScanCommandOutput {
  return {
    $metadata: {},
    Count: 0,
    Items: [],
    ScannedCount: 0,
  }
}

/**
 * Creates one manually controlled Scan response.
 *
 * @returns Promise and resolver pair.
 */
function createDeferredScanOutput(): DeferredScanOutput {
  let resolvePromise: ((output: ScanCommandOutput) => void) | undefined
  const promise = new Promise<ScanCommandOutput>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(output: ScanCommandOutput): void {
      if (resolvePromise === undefined) {
        throw new Error('Expected deferred Scan resolver.')
      }
      resolvePromise(output)
    },
  }
}

/**
 * Waits for one fake Scan to reach the transport without wall-clock timing.
 *
 * @param transport - Recording transport whose async preflight is in progress.
 * @param expectedCount - Minimum number of recorded Scan commands.
 * @returns Resolves after the expected command count is observed.
 */
async function waitForRecordedScanCount(
  transport: RecordingIdentityAwsTransport,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (transport.scanSourceCommands.length >= expectedCount) return
    await Promise.resolve()
  }
  throw new Error(
    `Expected ${expectedCount} recorded source Scan commands.`,
  )
}

/**
 * Waits for one fake target Scan to reach the transport without timing.
 *
 * @param transport - Recording transport whose async preflight is in progress.
 * @param expectedCount - Minimum number of recorded target Scan commands.
 * @returns Resolves after the expected command count is observed.
 */
async function waitForRecordedTargetScanCount(
  transport: RecordingIdentityAwsTransport,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.scanTargetCommands.length >= expectedCount) return
    await Promise.resolve()
  }
  throw new Error(
    `Expected ${expectedCount} recorded target Scan commands.`,
  )
}

/**
 * Creates one string attribute definition.
 *
 * @param name - Physical attribute name.
 * @returns DynamoDB string attribute definition.
 */
function stringAttribute(name: string): AttributeDefinition {
  return {
    AttributeName: name,
    AttributeType: 'S',
  }
}

/**
 * Creates one number attribute definition.
 *
 * @param name - Physical attribute name.
 * @returns DynamoDB number attribute definition.
 */
function numberAttribute(name: string): AttributeDefinition {
  return {
    AttributeName: name,
    AttributeType: 'N',
  }
}

/**
 * Creates one partition-key schema element.
 *
 * @param name - Physical attribute name.
 * @returns DynamoDB partition-key descriptor.
 */
function hashKey(name: string): KeySchemaElement {
  return {
    AttributeName: name,
    KeyType: 'HASH',
  }
}

/**
 * Creates one sort-key schema element.
 *
 * @param name - Physical attribute name.
 * @returns DynamoDB sort-key descriptor.
 */
function rangeKey(name: string): KeySchemaElement {
  return {
    AttributeName: name,
    KeyType: 'RANGE',
  }
}

/**
 * Creates one valid explicit migration resource selection.
 *
 * @param region - Explicit region used in the request and KMS ARN.
 * @returns Complete operator-selected resources.
 */
function createRequestedResources(
  region = TEST_REGION,
): WorkspaceSearchMigrationRequestedResources {
  return {
    account: TEST_ACCOUNT,
    region,
    profile: TEST_PROFILE,
    commit: 'a'.repeat(40),
    tables: {
      'project-directory': 'mukuroji-project-directory-production-sensitive',
      'work-items': 'mukuroji-work-items-production-sensitive',
      collaboration: 'mukuroji-collaboration-production-sensitive',
      documents: 'mukuroji-documents-production-sensitive',
      'workspace-search': 'mukuroji-workspace-search-production-sensitive',
      'migration-state':
        'mukuroji-workspace-search-migration-state-production-sensitive',
    },
    journalBucket: TEST_BUCKET,
    journalKeyArn: createJournalKeyArn(region),
  }
}

/**
 * Creates the exact owner-bound journal bucket lookup.
 *
 * @param requested - Validated operator-selected resources.
 * @returns Expected S3 lookup.
 */
function createJournalLookup(
  requested: WorkspaceSearchMigrationRequestedResources,
): WorkspaceSearchMigrationJournalLookup {
  return {
    bucketName: requested.journalBucket,
    expectedBucketOwner: requested.account,
  }
}

/**
 * Creates the journal key ARN used by one regional test fixture.
 *
 * @param region - Explicit AWS region.
 * @returns Syntactically valid KMS key ARN.
 */
function createJournalKeyArn(region: string): string {
  return `arn:${readPartition(region)}:kms:${region}:${TEST_ACCOUNT}:key/${TEST_KEY_ID}`
}

/**
 * Maps one test region to its matching ARN partition.
 *
 * @param region - Explicit AWS region.
 * @returns AWS ARN partition.
 */
function readPartition(region: string): string {
  if (region.startsWith('cn-')) return 'aws-cn'
  if (region.startsWith('eusc-')) return 'aws-eusc'
  if (region.startsWith('us-iso-')) return 'aws-iso'
  if (region.startsWith('us-isob-')) return 'aws-iso-b'
  if (region.startsWith('eu-isoe-')) return 'aws-iso-e'
  if (region.startsWith('us-isof-')) return 'aws-iso-f'
  if (region.startsWith('us-gov-')) return 'aws-us-gov'
  return 'aws'
}

/**
 * Verifies one owner-bound S3 command.
 *
 * @param command - Recorded S3 command.
 * @param commandType - Expected command constructor.
 */
function expectBucketCommand(
  command:
    | GetBucketEncryptionCommand
    | GetBucketLoggingCommand
    | GetBucketVersioningCommand
    | GetObjectLockConfigurationCommand
    | undefined,
  commandType:
    | typeof GetBucketEncryptionCommand
    | typeof GetBucketLoggingCommand
    | typeof GetBucketVersioningCommand
    | typeof GetObjectLockConfigurationCommand,
): void {
  expect(command).toBeInstanceOf(commandType)
  expect(command?.input).toEqual({
    Bucket: TEST_BUCKET,
    ExpectedBucketOwner: TEST_ACCOUNT,
  })
}

/**
 * Restores one environment variable to its exact prior state.
 *
 * @param name - Environment variable name.
 * @param value - Prior value or undefined when absent.
 */
function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

/**
 * Reads one required object-valued implementation field without a type
 * assertion.
 *
 * @param owner - Object containing the implementation field.
 * @param key - Own or inherited field name.
 * @returns Required non-null object value.
 */
function readOwnObject(owner: object, key: string): object {
  const value: unknown = Reflect.get(owner, key)
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected object implementation field: ${key}`)
  }
  return value
}

/**
 * Reads one concrete SDK abort signal without a type assertion.
 *
 * @param options - Candidate handler options passed to the SDK client.
 * @returns Exact abort signal installed by the authority transport.
 */
function readAbortSignal(options: unknown): AbortSignal {
  if (typeof options !== 'object' || options === null) {
    throw new Error('Expected concrete SDK handler options.')
  }
  const signal: unknown = Reflect.get(options, 'abortSignal')
  if (!(signal instanceof AbortSignal)) {
    throw new Error('Expected concrete SDK abort signal.')
  }
  return signal
}

/**
 * Resolves the concrete endpoint provider installed on one AWS SDK client.
 *
 * @param client - Concrete AWS SDK client under test.
 * @returns Canonical endpoint URL.
 */
async function readSdkClientEndpoint(client: object): Promise<string> {
  const configuration = readOwnObject(client, 'config')
  const endpointProvider: unknown = Reflect.get(configuration, 'endpoint')
  if (typeof endpointProvider !== 'function') {
    throw new Error('Expected an AWS SDK endpoint provider.')
  }
  const endpoint: unknown = await Reflect.apply(
    endpointProvider,
    undefined,
    [],
  )
  if (typeof endpoint !== 'object' || endpoint === null) {
    throw new Error('Expected a resolved AWS SDK endpoint.')
  }
  const protocol = readRequiredStringProperty(endpoint, 'protocol')
  const hostname = readRequiredStringProperty(endpoint, 'hostname')
  const path = readRequiredStringProperty(endpoint, 'path')
  const port: unknown = Reflect.get(endpoint, 'port')
  if (port !== undefined && typeof port !== 'number') {
    throw new Error('Expected a numeric AWS SDK endpoint port.')
  }
  return `${protocol}//${hostname}${port === undefined ? '' : `:${port}`}${path}`
}

/**
 * Reads one required string from a narrowed object.
 *
 * @param owner - Object containing the string.
 * @param key - Property name.
 * @returns Required string value.
 */
function readRequiredStringProperty(owner: object, key: string): string {
  const value: unknown = Reflect.get(owner, key)
  if (typeof value !== 'string') {
    throw new Error(`Expected string implementation field: ${key}`)
  }
  return value
}

/**
 * Restores an own property after a prototype-level construction test.
 *
 * @param owner - Prototype modified by the test.
 * @param key - Modified property key.
 * @param descriptor - Original own descriptor, if one existed.
 */
function restoreOwnProperty(
  owner: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(owner, key)
    return
  }
  Object.defineProperty(owner, key, descriptor)
}
