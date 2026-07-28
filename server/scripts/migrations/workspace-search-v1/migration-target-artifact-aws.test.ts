import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  type GetObjectCommand,
  type GetObjectCommandOutput,
  type HeadObjectCommand,
  type HeadObjectCommandOutput,
  type PutObjectCommand,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationTableRole,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationTargetArtifactPort,
  type WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext,
  type WorkspaceSearchMigrationTargetArtifactAwsTransport,
  WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-target-artifact-aws'
import {
  serializeWorkspaceSearchMigrationPlanningTargetArtifactPage,
  type WorkspaceSearchMigrationPlanningTargetArtifactEncodedSegment,
  type WorkspaceSearchMigrationPlanningTargetArtifactPage,
  type WorkspaceSearchMigrationPlanningTargetArtifactReference,
} from './migration-target-artifact'

const testAccount = '123456789012'
const testRegion = 'ap-northeast-1'
const testLastModified = new Date('2026-07-01T00:00:00.000Z')
const testRetainUntil = new Date('2026-08-01T00:00:00.000Z')

/**
 * S3 response fields required to prove one exact immutable object version.
 */
type ValidTargetArtifactObjectFields = {
  /** Minimal Smithy response metadata required by the output type. */
  readonly $metadata: Readonly<Record<string, never>>
  /** Exact immutable object version identifier. */
  readonly VersionId: string
  /** Exact canonical object byte length. */
  readonly ContentLength: number
  /** Exact canonical object media type. */
  readonly ContentType: 'application/json'
  /** Exact base64 SHA-256 object checksum. */
  readonly ChecksumSHA256: string
  /** Exact checksum composition kind. */
  readonly ChecksumType: 'FULL_OBJECT'
  /** Exact configured server-side encryption family. */
  readonly ServerSideEncryption: 'aws:kms'
  /** Exact measured customer-managed KMS key ARN. */
  readonly SSEKMSKeyId: string
  /** Whether the measured S3 Bucket Key was used. */
  readonly BucketKeyEnabled: true
  /** Exact adapter-owned S3 user metadata. */
  readonly Metadata: Readonly<Record<string, string>>
  /** S3 creation boundary used to measure the retention interval. */
  readonly LastModified: Date
  /** Exact immutable Object Lock retention mode. */
  readonly ObjectLockMode: 'COMPLIANCE'
  /** Exact object-version retention deadline. */
  readonly ObjectLockRetainUntilDate: Date
}

/**
 * Canonical encoded segment paired with its exact durable evidence reference.
 */
type TargetArtifactFixture = {
  /** Complete canonical encoded segment. */
  readonly encoded:
    WorkspaceSearchMigrationPlanningTargetArtifactEncodedSegment
  /** Exact immutable object-version reference. */
  readonly reference:
    WorkspaceSearchMigrationPlanningTargetArtifactReference
}

/**
 * Named reconstructed-page tamper case.
 */
type PageTamperCase = {
  /** Human-readable identity field changed in stored bytes. */
  readonly name: string
  /** Complete page whose common identity differs from expectation. */
  readonly page:
    WorkspaceSearchMigrationPlanningTargetArtifactPage
  /** Exact fail-closed code expected for this tamper class. */
  readonly expectedCode:
    'IDENTITY_MISMATCH' | 'INVALID_TARGET_ARTIFACT'
}

/**
 * Narrow recording S3 transport with test-controlled responses.
 */
class RecordingTargetArtifactTransport
  implements WorkspaceSearchMigrationTargetArtifactAwsTransport {
  /** Recorded conditional immutable PutObject commands. */
  readonly putCommands: PutObjectCommand[] = []

  /** Recorded metadata-only HeadObject commands. */
  readonly headCommands: HeadObjectCommand[] = []

  /** Recorded exact-version GetObject commands. */
  readonly getCommands: GetObjectCommand[] = []

  /** Test-controlled PutObject behavior. */
  putHandler:
    (command: PutObjectCommand) => Promise<PutObjectCommandOutput> =
      async () => {
        throw new Error('Unexpected PutObject call.')
      }

  /** Test-controlled HeadObject behavior. */
  headHandler:
    (command: HeadObjectCommand) => Promise<HeadObjectCommandOutput> =
      async () => {
        throw new Error('Unexpected HeadObject call.')
      }

  /** Test-controlled GetObject behavior. */
  getHandler:
    (command: GetObjectCommand) => Promise<GetObjectCommandOutput> =
      async () => {
        throw new Error('Unexpected GetObject call.')
      }

  /**
   * Records and delegates one conditional immutable upload.
   *
   * @param command - Adapter-owned PutObject command.
   * @returns Test-controlled low-level response.
   */
  putTargetArtifact(
    command: PutObjectCommand,
  ): Promise<PutObjectCommandOutput> {
    this.putCommands.push(command)
    return this.putHandler(command)
  }

  /**
   * Records and delegates one metadata read.
   *
   * @param command - Adapter-owned HeadObject command.
   * @returns Test-controlled low-level response.
   */
  headTargetArtifact(
    command: HeadObjectCommand,
  ): Promise<HeadObjectCommandOutput> {
    this.headCommands.push(command)
    return this.headHandler(command)
  }

  /**
   * Records and delegates one exact-version object read.
   *
   * @param command - Adapter-owned GetObject command.
   * @returns Test-controlled low-level response.
   */
  getTargetArtifact(
    command: GetObjectCommand,
  ): Promise<GetObjectCommandOutput> {
    this.getCommands.push(command)
    return this.getHandler(command)
  }
}

/**
 * Never-resolving async body used to prove the adapter's total read deadline.
 */
class StalledTargetArtifactBody {
  /** Whether iterator cleanup was requested after the deadline. */
  returned = false

  /** Whether underlying stream destruction was requested after the deadline. */
  destroyed = false;

  /**
   * Returns this deliberately stalled iterator.
   *
   * @returns This async iterator.
   */
  [Symbol.asyncIterator](): StalledTargetArtifactBody {
    return this
  }

  /**
   * Simulates an S3 body whose next chunk never settles.
   *
   * @returns Permanently pending result.
   */
  next(): Promise<never> {
    return new Promise(() => undefined)
  }

  /**
   * Records best-effort iterator cancellation.
   *
   * @returns Completed iterator result.
   */
  return(): Promise<{
    /** Indicates that cancellation completed the iterator. */
    readonly done: true
    /** Empty iterator return value. */
    readonly value: undefined
  }> {
    this.returned = true
    return Promise.resolve({ done: true, value: undefined })
  }

  /**
   * Records best-effort underlying stream destruction.
   */
  destroy(): void {
    this.destroyed = true
  }
}

/**
 * Creates a complete measured migration configuration.
 *
 * @param region - Exact AWS region selected by the operator.
 * @param partition - Matching official AWS ARN partition.
 * @param bucketName - Exact measured general-purpose journal bucket.
 * @returns Exact measured configuration bound to an adapter.
 */
function createConfiguration(
  region = testRegion,
  partition = 'aws',
  bucketName = 'mukuroji-workspace-search-migration-journal',
): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: testAccount,
    region,
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      `arn:${partition}:sts::123456789012:assumed-role/migration-operator/session`,
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createTable(
        'project-directory',
        region,
        partition,
      ),
      'work-items': createTable('work-items', region, partition),
      collaboration: createTable('collaboration', region, partition),
      documents: createTable('documents', region, partition),
      'workspace-search': createTable(
        'workspace-search',
        region,
        partition,
      ),
      'migration-state': createTable(
        'migration-state',
        region,
        partition,
      ),
    },
    journal: {
      bucketName,
      keyArn:
        `arn:${partition}:kms:${region}:123456789012:key/00000000-0000-0000-0000-000000000001`,
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one complete physical table identity fixture.
 *
 * @param role - Exact logical table role.
 * @param region - Exact measured AWS region.
 * @param partition - Matching official AWS ARN partition.
 * @returns Complete measured table identity.
 */
function createTable(
  role: WorkspaceSearchMigrationTableRole,
  region = testRegion,
  partition = 'aws',
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:${partition}:dynamodb:${region}:${testAccount}:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: testAccount,
    region,
    key: [
      { name: 'pk', role: 'HASH', type: 'S' },
    ],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: role === 'migration-state',
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-06-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-01T00:00:00.000Z',
    },
  }
}

/**
 * Creates one complete lossless target page bound to a configuration.
 *
 * @param configuration - Exact measured configuration.
 * @param items - Optional exact raw Scan items.
 * @returns Complete planning target-artifact page.
 */
function createPage(
  configuration: WorkspaceSearchMigrationConfiguration,
  items: readonly DynamoAttributeMap[] = [
    {
      pk: { S: 'row-1' },
      payload: { S: 'retained losslessly' },
    },
  ],
): WorkspaceSearchMigrationPlanningTargetArtifactPage {
  const targetTable = configuration.tables['workspace-search']
  const stateTable = configuration.tables['migration-state']
  return {
    kind: 'workspace-search-planning-target-artifact-page',
    artifactVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    purpose: 'planning',
    runId: 'run-20260728',
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
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
    pageSequence: 3,
    previousEvidenceDigest: 'b'.repeat(64),
    previousCheckpointDigest: 'c'.repeat(64),
    planningAuthority: {
      ownerId: 'owner-01',
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 4,
      maintenanceEvidenceReceiptDigest: 'd'.repeat(64),
    },
    items,
  }
}

/**
 * Extracts the common page identity used by exact-version reads.
 *
 * @param page - Complete canonical page.
 * @returns Detached expected page context.
 */
function createExpectedPageContext(
  page: WorkspaceSearchMigrationPlanningTargetArtifactPage,
): WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext {
  return {
    runId: page.runId,
    configurationHash: page.configurationHash,
    targetTable: { ...page.targetTable },
    stateTable: { ...page.stateTable },
    pageSequence: page.pageSequence,
    previousEvidenceDigest: page.previousEvidenceDigest,
    previousCheckpointDigest: page.previousCheckpointDigest,
    planningAuthority: { ...page.planningAuthority },
  }
}

/**
 * Creates one canonical single-segment storage fixture.
 *
 * @param page - Complete canonical page.
 * @param versionId - Exact immutable S3 version identifier.
 * @returns Encoded segment and durable exact-version reference.
 */
function createArtifactFixture(
  page: WorkspaceSearchMigrationPlanningTargetArtifactPage,
  versionId = 'version-0001',
): TargetArtifactFixture {
  const encoded = serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
    page,
  )[0]
  if (encoded === undefined) {
    throw new Error('Expected one encoded target-artifact segment.')
  }
  return {
    encoded,
    reference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_OBJECT_KEY_PREFIX}/${encoded.contentDigest}.json`,
      versionId,
      contentDigest: encoded.contentDigest,
    },
  }
}

/**
 * Creates exact adapter-owned S3 metadata for one encoded segment.
 *
 * @param fixture - Encoded segment and exact reference.
 * @returns Exact S3 user metadata.
 */
function createObjectMetadata(
  fixture: TargetArtifactFixture,
): Readonly<Record<string, string>> {
  return {
    'mukuroji-kind':
      'workspace-search-planning-target-artifact-segment',
    'mukuroji-version': '1',
    'mukuroji-content-sha256': fixture.encoded.contentDigest,
    'mukuroji-byte-length': String(fixture.encoded.byteLength),
    'mukuroji-segment-index': String(
      fixture.encoded.segment.segmentIndex,
    ),
    'mukuroji-segment-count': String(
      fixture.encoded.segment.segmentCount,
    ),
  }
}

/**
 * Creates exact successful Head/Get response fields.
 *
 * @param configuration - Exact measured configuration.
 * @param fixture - Encoded segment and exact reference.
 * @returns Response fields proving content, encryption, and retention.
 */
function createValidObjectFields(
  configuration: WorkspaceSearchMigrationConfiguration,
  fixture: TargetArtifactFixture,
): ValidTargetArtifactObjectFields {
  return {
    $metadata: {},
    VersionId: fixture.reference.versionId,
    ContentLength: fixture.encoded.byteLength,
    ContentType: 'application/json',
    ChecksumSHA256: createHash('sha256')
      .update(fixture.encoded.bytes)
      .digest('base64'),
    ChecksumType: 'FULL_OBJECT',
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: configuration.journal.keyArn,
    BucketKeyEnabled: true,
    Metadata: createObjectMetadata(fixture),
    LastModified: new Date(testLastModified),
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(testRetainUntil),
  }
}

/**
 * Creates one exact successful HeadObject response.
 *
 * @param configuration - Exact measured configuration.
 * @param fixture - Encoded segment and exact reference.
 * @returns Complete response accepted by the adapter.
 */
function createValidHeadOutput(
  configuration: WorkspaceSearchMigrationConfiguration,
  fixture: TargetArtifactFixture,
): HeadObjectCommandOutput {
  return createValidObjectFields(configuration, fixture)
}

/**
 * Creates one exact successful GetObject response with a bounded body.
 *
 * @param configuration - Exact measured configuration.
 * @param fixture - Encoded segment and exact reference.
 * @returns Complete response accepted by the adapter.
 */
function createValidGetOutput(
  configuration: WorkspaceSearchMigrationConfiguration,
  fixture: TargetArtifactFixture,
): GetObjectCommandOutput {
  const output: GetObjectCommandOutput =
    createValidObjectFields(configuration, fixture)
  Object.defineProperty(output, 'Body', {
    configurable: true,
    enumerable: true,
    value: createAsyncBody([fixture.encoded.bytes]),
  })
  return output
}

/**
 * Creates a minimal async-iterable S3 body from exact chunks.
 *
 * @param chunks - Ordered byte chunks returned by the fake stream.
 * @returns Async iterable exposing only the chunks.
 */
function createAsyncBody(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  return {
    /**
     * Yields detached chunks in exact order.
     *
     * @returns Async iterator over exact byte chunks.
     */
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      for (const chunk of chunks) {
        yield new Uint8Array(chunk)
      }
    },
  }
}

/**
 * Creates one raw SDK-like error with a stable HTTP status.
 *
 * @param name - Stable SDK error name.
 * @param status - Stable HTTP response status.
 * @param message - Raw canary that must never escape the adapter.
 * @returns SDK-like error value.
 */
function createS3Error(
  name: string,
  status: number,
  message = 'raw-s3-secret-canary',
): Error {
  const error = new Error(message)
  error.name = name
  Object.defineProperty(error, '$metadata', {
    enumerable: true,
    value: { httpStatusCode: status },
  })
  return error
}

/**
 * Captures one expected public migration failure.
 *
 * @param operation - Async adapter operation expected to fail.
 * @returns Exact fixed-message migration failure.
 */
async function captureMigrationFailure(
  operation: Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) return error
    throw error
  }
  throw new Error('Expected WorkspaceSearchMigrationFailure.')
}

describe('AWS planning target-artifact adapter', () => {
  test('accepts a measured official non-commercial partition', async () => {
    const configuration =
      createConfiguration('eusc-de-east-1', 'aws-eusc')
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const transport = new RecordingTargetArtifactTransport()
    transport.putHandler = async () => ({
      $metadata: {},
      VersionId: fixture.reference.versionId,
    })
    transport.headHandler = async () =>
      createValidHeadOutput(configuration, fixture)
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })

    await expect(port.writePlanningTargetArtifactPage({
      expectedPage: page,
    })).resolves.toEqual([fixture.reference])
    expect(transport.putCommands[0]?.input.SSEKMSKeyId).toBe(
      configuration.journal.keyArn,
    )
  })

  test('rejects reserved S3 alias names before target I/O', async () => {
    const reservedBucketNames = [
      'xn--migration-journal',
      'migration-journal-s3alias',
      'migration-journal.mrap',
      'migration-journal--x-s3',
      'migration-journal--table-s3',
    ]
    for (const bucketName of reservedBucketNames) {
      const configuration = createConfiguration(
        testRegion,
        'aws',
        bucketName,
      )
      const transport = new RecordingTargetArtifactTransport()
      const failure = await captureMigrationFailure(
        Promise.resolve().then(() =>
          createAwsWorkspaceSearchMigrationTargetArtifactPort({
            configuration,
            configurationHash:
              createWorkspaceSearchConfigurationHash(configuration),
            transport,
          })
        ),
      )

      expect(`${bucketName}:${failure.code}`).toBe(
        `${bucketName}:INVALID_ARGUMENT`,
      )
      expect(transport.putCommands).toHaveLength(0)
      expect(transport.headCommands).toHaveLength(0)
      expect(transport.getCommands).toHaveLength(0)
    }
  })

  test('writes exact conditional immutable S3 requests and pins the Head version', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const transport = new RecordingTargetArtifactTransport()
    transport.putHandler = async () => ({
      $metadata: {},
      VersionId: fixture.reference.versionId,
      ChecksumSHA256: createHash('sha256')
        .update(fixture.encoded.bytes)
        .digest('base64'),
      ChecksumType: 'FULL_OBJECT',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: configuration.journal.keyArn,
      BucketKeyEnabled: true,
      Size: fixture.encoded.byteLength,
    })
    transport.headHandler = async () =>
      createValidHeadOutput(configuration, fixture)
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })

    const references = await port.writePlanningTargetArtifactPage({
      expectedPage: page,
    })

    expect(references).toEqual([fixture.reference])
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.putCommands[0]?.input).toEqual({
      Bucket: configuration.journal.bucketName,
      Key: fixture.reference.objectKey,
      Body: fixture.encoded.bytes,
      ContentLength: fixture.encoded.byteLength,
      ContentType: 'application/json',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: createHash('sha256')
        .update(fixture.encoded.bytes)
        .digest('base64'),
      IfNoneMatch: '*',
      ExpectedBucketOwner: testAccount,
      Metadata: createObjectMetadata(fixture),
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: configuration.journal.keyArn,
      BucketKeyEnabled: true,
    })
    expect(transport.headCommands[0]?.input).toEqual({
      Bucket: configuration.journal.bucketName,
      Key: fixture.reference.objectKey,
      VersionId: fixture.reference.versionId,
      ExpectedBucketOwner: testAccount,
      ChecksumMode: 'ENABLED',
    })
    const serializedMetadata = JSON.stringify(
      transport.putCommands[0]?.input.Metadata,
    )
    expect(serializedMetadata).not.toContain(page.runId)
    expect(serializedMetadata).not.toContain(
      page.planningAuthority.ownerId,
    )
    expect(serializedMetadata).not.toContain('row-1')
  })

  test('reconciles 412 without an unconditional overwrite or retry', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const transport = new RecordingTargetArtifactTransport()
    transport.putHandler = async () => {
      throw createS3Error('PreconditionFailed', 412)
    }
    transport.headHandler = async () =>
      createValidHeadOutput(configuration, fixture)
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })

    await expect(port.writePlanningTargetArtifactPage({
      expectedPage: page,
    })).resolves.toEqual([fixture.reference])
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.putCommands[0]?.input.IfNoneMatch).toBe('*')
    expect(transport.headCommands[0]?.input.VersionId).toBeUndefined()
  })

  test('fails a non-ambiguous PutObject error without Head or retry', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const transport = new RecordingTargetArtifactTransport()
    transport.putHandler = async () => {
      throw createS3Error('AccessDenied', 403)
    }
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })

    const failure = await captureMigrationFailure(
      port.writePlanningTargetArtifactPage({
        expectedPage: page,
      }),
    )

    expect(failure.code).toBe('TARGET_ARTIFACT_WRITE_FAILED')
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(0)
  })

  test('reconciles an ambiguous write before one bounded conditional retry', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const transport = new RecordingTargetArtifactTransport()
    transport.putHandler = async () => {
      if (transport.putCommands.length === 1) {
        throw createS3Error('InternalError', 500)
      }
      return {
        $metadata: {},
        VersionId: fixture.reference.versionId,
      }
    }
    transport.headHandler = async () => {
      if (transport.headCommands.length === 1) {
        throw createS3Error('NotFound', 404)
      }
      return createValidHeadOutput(configuration, fixture)
    }
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })

    await expect(port.writePlanningTargetArtifactPage({
      expectedPage: page,
    })).resolves.toEqual([fixture.reference])
    expect(transport.putCommands).toHaveLength(2)
    expect(transport.putCommands.every(
      (command) => command.input.IfNoneMatch === '*',
    )).toBe(true)
    expect(transport.headCommands).toHaveLength(2)
  })

  test('rejects mismatched or insufficient COMPLIANCE retention without leaking raw errors', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const wrongMode =
      createValidHeadOutput(configuration, fixture)
    wrongMode.ObjectLockMode = 'GOVERNANCE'
    const insufficientRetention =
      createValidHeadOutput(configuration, fixture)
    insufficientRetention.ObjectLockRetainUntilDate =
      new Date('2026-07-30T23:59:59.999Z')
    const invalidHeads = [wrongMode, insufficientRetention]
    for (const invalidHead of invalidHeads) {
      const transport = new RecordingTargetArtifactTransport()
      transport.putHandler = async () => {
        throw createS3Error(
          'PreconditionFailed',
          412,
          'tenant-secret-retention-canary',
        )
      }
      transport.headHandler = async () => invalidHead
      const port =
        createAwsWorkspaceSearchMigrationTargetArtifactPort({
          configuration,
          configurationHash:
            createWorkspaceSearchConfigurationHash(configuration),
          transport,
        })

      const failure = await captureMigrationFailure(
        port.writePlanningTargetArtifactPage({
          expectedPage: page,
        }),
      )
      expect(failure.code).toBe('INVALID_TARGET_ARTIFACT')
      expect(failure.message).toBe(
        'Workspace Search target artifact stopped safely (INVALID_TARGET_ARTIFACT).',
      )
      expect(failure.message).not.toContain('tenant-secret')
      expect(transport.putCommands).toHaveLength(1)
    }
  })

  test('reads only exact versions and reconstructs the complete lossless page', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const transport = new RecordingTargetArtifactTransport()
    transport.getHandler = async () =>
      createValidGetOutput(configuration, fixture)
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })

    const reconstructed = await port.readPlanningTargetArtifactPage({
      expectedPage: createExpectedPageContext(page),
      references: [fixture.reference],
    })

    expect(reconstructed).toEqual(page)
    expect(transport.getCommands[0]?.input).toEqual({
      Bucket: configuration.journal.bucketName,
      Key: fixture.reference.objectKey,
      VersionId: fixture.reference.versionId,
      ExpectedBucketOwner: testAccount,
      ChecksumMode: 'ENABLED',
    })
    expect(transport.headCommands).toHaveLength(0)
  })

  test('rejects a source-artifact reference before target S3 I/O', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const transport = new RecordingTargetArtifactTransport()
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })
    const sourceReference = {
      ...fixture.reference,
      objectKey:
        `workspace-search/v1/source-artifacts/v1/${fixture.reference.contentDigest}.json`,
    }

    const failure = await captureMigrationFailure(
      port.readPlanningTargetArtifactPage({
        expectedPage: createExpectedPageContext(page),
        references: [sourceReference],
      }),
    )

    expect(failure.code).toBe('INVALID_TARGET_ARTIFACT')
    expect(transport.getCommands).toHaveLength(0)
    expect(transport.headCommands).toHaveLength(0)
    expect(transport.putCommands).toHaveLength(0)
  })

  test('rejects sparse and duplicate target references before S3 I/O', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const transport = new RecordingTargetArtifactTransport()
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })
    const sparseReferences:
      WorkspaceSearchMigrationPlanningTargetArtifactReference[] = []
    sparseReferences.length = 1

    for (const references of [
      sparseReferences,
      [fixture.reference, fixture.reference],
    ]) {
      const failure = await captureMigrationFailure(
        port.readPlanningTargetArtifactPage({
          expectedPage: createExpectedPageContext(page),
          references,
        }),
      )
      expect(failure.code).toBe('INVALID_TARGET_ARTIFACT')
    }

    expect(transport.getCommands).toHaveLength(0)
    expect(transport.headCommands).toHaveLength(0)
    expect(transport.putCommands).toHaveLength(0)
  })

  test('rejects content, metadata, and bounded-stream response tampering', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const invalidOutputs: GetObjectCommandOutput[] = []
    const checksumTamper =
      createValidGetOutput(configuration, fixture)
    checksumTamper.ChecksumSHA256 =
      createHash('sha256').update('different').digest('base64')
    invalidOutputs.push(checksumTamper)
    const metadataTamper =
      createValidGetOutput(configuration, fixture)
    metadataTamper.Metadata = {
      ...createObjectMetadata(fixture),
      'mukuroji-segment-index': '1',
    }
    invalidOutputs.push(metadataTamper)
    const retentionTamper =
      createValidGetOutput(configuration, fixture)
    retentionTamper.ObjectLockMode = 'GOVERNANCE'
    invalidOutputs.push(retentionTamper)
    const bodyOverrun =
      createValidGetOutput(configuration, fixture)
    Object.defineProperty(bodyOverrun, 'Body', {
      configurable: true,
      enumerable: true,
      value: createAsyncBody([
        fixture.encoded.bytes,
        new Uint8Array([1]),
      ]),
    })
    invalidOutputs.push(bodyOverrun)

    for (const output of invalidOutputs) {
      const transport = new RecordingTargetArtifactTransport()
      transport.getHandler = async () => output
      const port =
        createAwsWorkspaceSearchMigrationTargetArtifactPort({
          configuration,
          configurationHash:
            createWorkspaceSearchConfigurationHash(configuration),
          transport,
        })
      const failure = await captureMigrationFailure(
        port.readPlanningTargetArtifactPage({
          expectedPage: createExpectedPageContext(page),
          references: [fixture.reference],
        }),
      )
      expect(failure.code).toBe('INVALID_TARGET_ARTIFACT')
      expect(transport.getCommands).toHaveLength(1)
    }
  })

  test('times out and cancels a never-resolving object body', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const output = createValidGetOutput(configuration, fixture)
    const stalledBody = new StalledTargetArtifactBody()
    Object.defineProperty(output, 'Body', {
      configurable: true,
      enumerable: true,
      value: stalledBody,
    })
    const transport = new RecordingTargetArtifactTransport()
    transport.getHandler = async () => output
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })
    const originalSetTimeout = globalThis.setTimeout
    const originalSetTimeoutDescriptor =
      Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')
    if (originalSetTimeoutDescriptor === undefined) {
      throw new Error('Expected the global setTimeout descriptor.')
    }
    Object.defineProperty(globalThis, 'setTimeout', {
      ...originalSetTimeoutDescriptor,
      value: (callback: () => void) =>
        originalSetTimeout(callback, 5),
    })
    let failure: WorkspaceSearchMigrationFailure
    try {
      failure = await captureMigrationFailure(
        port.readPlanningTargetArtifactPage({
          expectedPage: createExpectedPageContext(page),
          references: [fixture.reference],
        }),
      )
    } finally {
      Object.defineProperty(
        globalThis,
        'setTimeout',
        originalSetTimeoutDescriptor,
      )
    }

    expect(failure.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
    expect(failure.message).toBe(
      'Workspace Search target artifact stopped safely (TRANSIENT_INFRASTRUCTURE_FAILURE).',
    )
    expect(stalledBody.returned).toBe(true)
    expect(stalledBody.destroyed).toBe(true)
  })

  test('validates target table, predecessor, and authority against expected context', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const tamperCases: readonly PageTamperCase[] = [
      {
        name: 'target table incarnation',
        page: {
          ...page,
          targetTable: {
            ...page.targetTable,
            tableId: 'different-table-incarnation',
          },
        },
        expectedCode: 'IDENTITY_MISMATCH',
      },
      {
        name: 'predecessor checkpoint',
        page: {
          ...page,
          previousCheckpointDigest: 'e'.repeat(64),
        },
        expectedCode: 'INVALID_TARGET_ARTIFACT',
      },
      {
        name: 'planning authority',
        page: {
          ...page,
          planningAuthority: {
            ...page.planningAuthority,
            fenceToken: page.planningAuthority.fenceToken + 1,
          },
        },
        expectedCode: 'INVALID_TARGET_ARTIFACT',
      },
    ]
    for (const tamperCase of tamperCases) {
      const fixture = createArtifactFixture(tamperCase.page)
      const transport = new RecordingTargetArtifactTransport()
      transport.getHandler = async () =>
        createValidGetOutput(configuration, fixture)
      const port =
        createAwsWorkspaceSearchMigrationTargetArtifactPort({
          configuration,
          configurationHash:
            createWorkspaceSearchConfigurationHash(configuration),
          transport,
        })

      const failure = await captureMigrationFailure(
        port.readPlanningTargetArtifactPage({
          expectedPage: createExpectedPageContext(page),
          references: [fixture.reference],
        }),
      )
      expect(
        `${tamperCase.name}:${failure.code}`,
      ).toBe(`${tamperCase.name}:${tamperCase.expectedCode}`)
    }
  })

  test('rejects configuration and expected-incarnation mismatch before S3 I/O', async () => {
    const configuration = createConfiguration()
    const page = createPage(configuration)
    const fixture = createArtifactFixture(page)
    const transport = new RecordingTargetArtifactTransport()
    const invalidHashFailure = captureMigrationFailure(
      Promise.resolve().then(() =>
        createAwsWorkspaceSearchMigrationTargetArtifactPort({
          configuration,
          configurationHash: createMigrationDigest('wrong-config'),
          transport,
        })
      ),
    )
    expect((await invalidHashFailure).code).toBe(
      'CONFIGURATION_HASH_MISMATCH',
    )
    const partitionedConfiguration =
      createConfiguration('cn-north-1', 'aws-cn')
    const partitionedTargetTable =
      partitionedConfiguration.tables['workspace-search']
    const crossPartitionConfiguration:
      WorkspaceSearchMigrationConfiguration = {
        ...partitionedConfiguration,
        tables: {
          ...partitionedConfiguration.tables,
          'workspace-search': {
            ...partitionedTargetTable,
            tableArn:
              `arn:aws:dynamodb:${partitionedConfiguration.region}:${testAccount}:table/${partitionedTargetTable.tableName}`,
          },
        },
      }
    const partitionFailure = await captureMigrationFailure(
      Promise.resolve().then(() =>
        createAwsWorkspaceSearchMigrationTargetArtifactPort({
          configuration: crossPartitionConfiguration,
          configurationHash:
            createWorkspaceSearchConfigurationHash(
              crossPartitionConfiguration,
            ),
          transport,
        })
      ),
    )
    expect(partitionFailure.code).toBe('INVALID_ARGUMENT')
    const port =
      createAwsWorkspaceSearchMigrationTargetArtifactPort({
        configuration,
        configurationHash:
          createWorkspaceSearchConfigurationHash(configuration),
        transport,
      })
    const expected = createExpectedPageContext(page)
    const failure = await captureMigrationFailure(
      port.readPlanningTargetArtifactPage({
        expectedPage: {
          ...expected,
          stateTable: {
            ...expected.stateTable,
            tableId: 'different-state-incarnation',
          },
        },
        references: [fixture.reference],
      }),
    )
    expect(failure.code).toBe('IDENTITY_MISMATCH')
    expect(transport.getCommands).toHaveLength(0)
    expect(transport.putCommands).toHaveLength(0)
  })
})
