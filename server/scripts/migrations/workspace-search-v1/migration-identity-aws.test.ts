import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AttributeDefinition,
  DescribeContinuousBackupsCommand,
  type DescribeContinuousBackupsCommandOutput,
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  DescribeTimeToLiveCommand,
  type DescribeTimeToLiveCommandOutput,
  type GlobalSecondaryIndexDescription,
  type KeySchemaElement,
  ScanCommand,
  type ScanCommandOutput,
  type TableDescription,
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
  WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import {
  createEmptyWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'

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

  /** Recorded DynamoDB TTL commands. */
  readonly describeTimeToLiveCommands: DescribeTimeToLiveCommand[] = []

  /** Opt-in DynamoDB TTL outputs keyed by physical table name. */
  readonly describeTimeToLiveOutputs =
    new Map<string, DescribeTimeToLiveCommandOutput>()

  /** Recorded DynamoDB source Scan commands. */
  readonly scanSourceCommands: ScanCommand[] = []

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
    return this.describeTableOutputs.get(command.input.TableName ?? '') ??
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
    if (this.scanSourceFailure !== undefined) {
      throw this.scanSourceFailure
    }
    if (this.scanSourceDeferred !== undefined) {
      return await this.scanSourceDeferred
    }
    return this.scanSourceOutput
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

    expect(transport.describeTableCommands).toHaveLength(6)
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
      LastEvaluatedKey: createProjectDirectoryCursor('replacement'),
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
      Items: [createIgnoredSourceItem('first')],
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
    const commandCursor =
      transport.scanSourceCommands[1]?.input.ExclusiveStartKey
    if (commandCursor === undefined) {
      throw new Error('Expected a detached command cursor.')
    }
    commandCursor.directoryId = { S: 'workspace-command-mutated' }
    deferred.resolve({
      $metadata: {},
      Count: 0,
      Items: [],
      LastEvaluatedKey: repeatedCursor,
      ScannedCount: 0,
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
    directoryId: { S: `workspace-${identifier}` },
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
