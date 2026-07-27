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
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  DescribeKeyCommand,
  type DescribeKeyCommandOutput,
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
} from '@aws-sdk/client-s3'
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  type GetCallerIdentityCommandOutput,
  STSClient,
} from '@aws-sdk/client-sts'
import {
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTableRole,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationIdentityPort,
  type WorkspaceSearchMigrationIdentityAwsSdkConfigurations,
  type WorkspaceSearchMigrationManagedAwsTransport,
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
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import {
  createEmptyWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'
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

  /** Recorded strongly consistent source-evidence point reads. */
  readonly getSourceEvidenceCommands: GetItemCommand[] = []

  /** Recorded atomic source-evidence page/head transactions. */
  readonly transactWriteSourceEvidenceCommands:
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

  /** Durable fake source-evidence items keyed by recordKey. */
  private readonly sourceEvidenceItems =
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

  /** Optional synchronous effect during authority write preparation. */
  preparePrePlanAuthorityWriteEffect: (() => void) | undefined

  /** Optional synchronous effect after recording an authority point read. */
  getPrePlanAuthorityEffect: (() => void) | undefined

  /** Optional synchronous effect after recording an authority transaction. */
  transactWritePrePlanAuthorityEffect: (() => void) | undefined

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
    port.close()
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
    port.close()
  })

  test('commits detached planning authority with a guarded five-item transaction', async () => {
    const requested = createRequestedResources()
    const transport = new RecordingIdentityAwsTransport()
    seedValidMeasurementOutputs(transport, requested)
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
    const stateTableName = requested.tables['migration-state']
    writeTrace = []
    transport.describeTableEffect = (tableName) => {
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
    const clockIndex = writeTrace.indexOf('clock')
    expect(clockIndex).toBeGreaterThan(0)
    expect(writeTrace[clockIndex - 1]).toBe('state-incarnation')
    expect(writeTrace[clockIndex + 1]).toBe('transaction')
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
 * @returns Exact managed planning source-evidence commit request.
 */
function createPlanningSourceEvidenceRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest {
  return {
    runId: authority.lease.runId,
    purpose: 'planning',
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source: 'project-directory',
    authority,
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.scanSourceCommands.length >= expectedCount) return
    await Promise.resolve()
  }
  throw new Error(
    `Expected ${expectedCount} recorded source Scan commands.`,
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
