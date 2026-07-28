import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type {
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadObjectCommand,
  HeadObjectCommandOutput,
  PutObjectCommand,
  PutObjectCommandOutput,
} from '@aws-sdk/client-s3'
import {
  createWorkspaceSearchConfigurationHash,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationTableRole,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationImmutableArtifactPort,
  type WorkspaceSearchMigrationImmutableArtifactAwsPort,
  type WorkspaceSearchMigrationImmutableArtifactClock,
  type WorkspaceSearchMigrationImmutableArtifactAwsTransport,
  type WorkspaceSearchMigrationImmutableArtifactReference,
  WORKSPACE_SEARCH_MIGRATION_IMMUTABLE_ARTIFACT_CONTENT_TYPE,
} from './migration-immutable-artifact-aws'

const testAccount = '123456789012'
const testRegion = 'ap-northeast-1'
const testNow = new Date('2026-07-01T00:00:00.000Z')
const testRetainUntil = '2026-08-01T00:00:00.000Z'
const testObjectKeyPrefix =
  'workspace-search/v1/planning/run-20260728'
const testRole = 'planning-plan-segment'
const testVersionId = 'version-0001'
const testCallerMetadata = {
  'mukuroji-kind': 'planning-plan-segment',
  'mukuroji-version': '1',
}

/**
 * Complete exact object material used by adapter tests.
 */
type ImmutableArtifactFixture = {
  /** Exact body bytes. */
  readonly bytes: Uint8Array
  /** Exact caller-selected semantic role. */
  readonly role: string
  /** Exact lower-case content digest. */
  readonly contentDigest: string
  /** Exact base64 S3 checksum. */
  readonly checksumSha256: string
  /** Exact immutable object reference. */
  readonly reference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Complete S3 user metadata. */
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Narrow recording transport with test-controlled responses.
 */
class RecordingImmutableArtifactTransport
  implements WorkspaceSearchMigrationImmutableArtifactAwsTransport {
  /** Recorded conditional PutObject commands. */
  readonly putCommands: PutObjectCommand[] = []

  /** Deadline signals paired with recorded PutObject commands. */
  readonly putAbortSignals: AbortSignal[] = []

  /** Recorded current or exact-version HeadObject commands. */
  readonly headCommands: HeadObjectCommand[] = []

  /** Deadline signals paired with recorded HeadObject commands. */
  readonly headAbortSignals: AbortSignal[] = []

  /** Recorded exact-version GetObject commands. */
  readonly getCommands: GetObjectCommand[] = []

  /** Deadline signals paired with recorded GetObject commands. */
  readonly getAbortSignals: AbortSignal[] = []

  /** Test-controlled PutObject behavior. */
  putHandler:
    (
      command: PutObjectCommand,
      abortSignal: AbortSignal,
    ) => Promise<PutObjectCommandOutput> =
      async () => {
        throw new Error('Unexpected PutObject call.')
      }

  /** Test-controlled HeadObject behavior. */
  headHandler:
    (
      command: HeadObjectCommand,
      abortSignal: AbortSignal,
    ) => Promise<HeadObjectCommandOutput> =
      async () => {
        throw new Error('Unexpected HeadObject call.')
      }

  /** Test-controlled GetObject behavior. */
  getHandler:
    (
      command: GetObjectCommand,
      abortSignal: AbortSignal,
    ) => Promise<GetObjectCommandOutput> =
      async () => {
        throw new Error('Unexpected GetObject call.')
      }

  /**
   * Records and delegates one immutable upload.
   *
   * @param command - Adapter-owned PutObject command.
   * @param abortSignal - Deadline signal for the underlying request.
   * @returns Test-controlled output.
   */
  putImmutableArtifact(
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<PutObjectCommandOutput> {
    this.putCommands.push(command)
    this.putAbortSignals.push(abortSignal)
    return this.putHandler(command, abortSignal)
  }

  /**
   * Records and delegates one metadata read.
   *
   * @param command - Adapter-owned HeadObject command.
   * @param abortSignal - Deadline signal for the underlying request.
   * @returns Test-controlled output.
   */
  headImmutableArtifact(
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<HeadObjectCommandOutput> {
    this.headCommands.push(command)
    this.headAbortSignals.push(abortSignal)
    return this.headHandler(command, abortSignal)
  }

  /**
   * Records and delegates one exact-version object read.
   *
   * @param command - Adapter-owned GetObject command.
   * @param abortSignal - Deadline signal for the underlying request.
   * @returns Test-controlled output.
   */
  getImmutableArtifact(
    command: GetObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<GetObjectCommandOutput> {
    this.getCommands.push(command)
    this.getAbortSignals.push(abortSignal)
    return this.getHandler(command, abortSignal)
  }
}

/**
 * Never-settling body used to prove finite body consumption.
 */
class StalledImmutableArtifactBody {
  /** Whether iterator cleanup was requested. */
  returned = false;

  /** Number of iterator cleanup requests. */
  returnCalls = 0;

  /** Whether underlying stream destruction was requested. */
  destroyed = false;

  /** Number of underlying stream destruction requests. */
  destroyCalls = 0;

  /**
   * Returns this deliberately stalled iterator.
   *
   * @returns This async iterator.
   */
  [Symbol.asyncIterator](): StalledImmutableArtifactBody {
    return this
  }

  /**
   * Simulates a stream whose next chunk never settles.
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
    /** Indicates completed iteration. */
    readonly done: true
    /** Empty return value. */
    readonly value: undefined
  }> {
    this.returned = true
    this.returnCalls += 1
    return Promise.resolve({ done: true, value: undefined })
  }

  /**
   * Records best-effort underlying stream destruction.
   */
  destroy(): void {
    this.destroyed = true
    this.destroyCalls += 1
  }
}

/**
 * Body whose async-iterator initialization fails before consumption.
 */
class InvalidIteratorImmutableArtifactBody
  extends StalledImmutableArtifactBody {
  /**
   * Simulates an invalid streaming body without exposing raw error text.
   *
   * @returns Never returns.
   */
  override [Symbol.asyncIterator](): StalledImmutableArtifactBody {
    throw new Error('raw-secret iterator initialization failure')
  }
}

/**
 * Creates a complete measured migration configuration.
 *
 * @returns Exact measured configuration bound to the adapter.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: testAccount,
    region: testRegion,
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createTable('project-directory'),
      'work-items': createTable('work-items'),
      collaboration: createTable('collaboration'),
      documents: createTable('documents'),
      'workspace-search': createTable('workspace-search'),
      'migration-state': createTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
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
 * @returns Complete measured table identity.
 */
function createTable(
  role: WorkspaceSearchMigrationTableRole,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:${testRegion}:${testAccount}:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: testAccount,
    region: testRegion,
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
 * Creates an adapter bound to one recording transport.
 *
 * @param configuration - Exact measured configuration.
 * @param transport - Recording transport.
 * @param bodyTimeoutMilliseconds - Optional focused body deadline.
 * @param requestTimeoutMilliseconds - Optional focused request deadline.
 * @param clock - Optional test-controlled trusted clock.
 * @returns Ready immutable object port.
 */
function createPort(
  configuration: WorkspaceSearchMigrationConfiguration,
  transport: RecordingImmutableArtifactTransport,
  bodyTimeoutMilliseconds = 1_000,
  requestTimeoutMilliseconds = 1_000,
  clock: WorkspaceSearchMigrationImmutableArtifactClock =
    () => new Date(testNow),
): WorkspaceSearchMigrationImmutableArtifactAwsPort {
  return createAwsWorkspaceSearchMigrationImmutableArtifactPort({
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    maximumObjectBytes: 1_024,
    requestTimeoutMilliseconds,
    bodyTimeoutMilliseconds,
    clock,
    transport,
  })
}

/**
 * Creates exact content-addressed object material.
 *
 * @param configuration - Exact measured configuration.
 * @param role - Semantic role separated in the object key.
 * @param versionId - Exact object version.
 * @param bytes - Exact body bytes.
 * @param retainUntil - Exact caller-fixed retention deadline.
 * @returns Complete object fixture.
 */
function createArtifactFixture(
  configuration: WorkspaceSearchMigrationConfiguration,
  role = testRole,
  versionId = testVersionId,
  bytes = new Uint8Array([0, 1, 2, 3, 255]),
  retainUntil = testRetainUntil,
): ImmutableArtifactFixture {
  const contentDigest =
    createHash('sha256').update(bytes).digest('hex')
  const checksumSha256 =
    createHash('sha256').update(bytes).digest('base64')
  const reference = {
    objectKey:
      `${testObjectKeyPrefix}/${role}/${contentDigest}.artifact`,
    versionId,
    contentDigest,
    byteLength: bytes.byteLength,
    retainUntil,
  }
  return {
    bytes: new Uint8Array(bytes),
    role,
    contentDigest,
    checksumSha256,
    reference,
    metadata: {
      ...testCallerMetadata,
      'mukuroji-immutable-role': role,
      'mukuroji-immutable-configuration-sha256':
        createWorkspaceSearchConfigurationHash(configuration),
      'mukuroji-immutable-content-sha256': contentDigest,
      'mukuroji-immutable-byte-length': String(bytes.byteLength),
      'mukuroji-immutable-retain-until': retainUntil,
    },
  }
}

/**
 * Creates exact successful HeadObject fields.
 *
 * @param configuration - Exact measured configuration.
 * @param fixture - Exact object fixture.
 * @returns Complete response accepted by reconciliation.
 */
function createValidHeadOutput(
  configuration: WorkspaceSearchMigrationConfiguration,
  fixture: ImmutableArtifactFixture,
): HeadObjectCommandOutput {
  return {
    $metadata: {},
    VersionId: fixture.reference.versionId,
    ContentLength: fixture.reference.byteLength,
    ContentType:
      WORKSPACE_SEARCH_MIGRATION_IMMUTABLE_ARTIFACT_CONTENT_TYPE,
    ChecksumSHA256: fixture.checksumSha256,
    ChecksumType: 'FULL_OBJECT',
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: configuration.journal.keyArn,
    BucketKeyEnabled: true,
    Metadata: fixture.metadata,
    LastModified: new Date(testNow),
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(fixture.reference.retainUntil),
  }
}

/**
 * Creates exact successful GetObject fields and a controlled body.
 *
 * @param configuration - Exact measured configuration.
 * @param fixture - Exact object fixture.
 * @param body - Exact or deliberately tampered body.
 * @returns Complete response accepted before body verification.
 */
function createValidGetOutput(
  configuration: WorkspaceSearchMigrationConfiguration,
  fixture: ImmutableArtifactFixture,
  body: unknown = fixture.bytes,
): GetObjectCommandOutput {
  const output: GetObjectCommandOutput = {
    ...createValidHeadOutput(configuration, fixture),
  }
  Object.defineProperty(output, 'Body', {
    configurable: true,
    enumerable: true,
    value: body,
  })
  return output
}

/**
 * Creates a minimal async iterable over detached byte chunks.
 *
 * @param chunks - Ordered byte chunks.
 * @returns Async iterable yielding the exact sequence.
 */
function createAsyncBody(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  return {
    /**
     * Yields each exact chunk.
     *
     * @returns Async byte iterator.
     */
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      for (const chunk of chunks) {
        yield new Uint8Array(chunk)
      }
    },
  }
}

/**
 * Creates a raw AWS-style error with secret-bearing text.
 *
 * @param name - Stable AWS error name.
 * @param status - HTTP response status.
 * @returns Raw transport error.
 */
function createAwsError(name: string, status: number): Error {
  const error = new Error('raw-secret-credential-material')
  error.name = name
  Object.defineProperty(error, '$metadata', {
    configurable: true,
    enumerable: true,
    value: { httpStatusCode: status },
  })
  return error
}

/**
 * Requires one public failure with no raw error leakage.
 *
 * @param promise - Operation expected to fail.
 * @param code - Stable expected migration failure code.
 * @returns Captured public failure.
 */
async function captureFailure(
  promise: Promise<unknown>,
  code: WorkspaceSearchMigrationFailure['code'],
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await promise
  } catch (error: unknown) {
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw error
    }
    expect(error.code).toBe(code)
    expect(error.message).not.toContain('raw-secret')
    return error
  }
  throw new Error('Expected immutable artifact operation to fail.')
}

/**
 * Requires one synchronous public failure.
 *
 * @param operation - Construction operation expected to fail.
 * @param code - Stable expected migration failure code.
 * @returns Captured public failure.
 */
function captureSynchronousFailure(
  operation: () => unknown,
  code: WorkspaceSearchMigrationFailure['code'],
): WorkspaceSearchMigrationFailure {
  try {
    operation()
  } catch (error: unknown) {
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw error
    }
    expect(error.code).toBe(code)
    expect(error.message).not.toContain('raw-secret')
    return error
  }
  throw new Error('Expected immutable artifact construction to fail.')
}

describe('AWS immutable migration artifact core', () => {
  test('writes, fully reconciles, and reads one exact immutable version', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    transport.putHandler = async () => ({
      $metadata: {},
      VersionId: fixture.reference.versionId,
    })
    transport.headHandler = async () =>
      createValidHeadOutput(configuration, fixture)
    transport.getHandler = async () =>
      createValidGetOutput(configuration, fixture)
    const port = createPort(configuration, transport)

    const callerBytes = new Uint8Array(fixture.bytes)
    const callerMetadata: Record<string, string> = {
      ...testCallerMetadata,
    }
    const referencePromise = port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: callerBytes,
      metadata: callerMetadata,
      retainUntil: testRetainUntil,
    })
    callerBytes.fill(99)
    callerMetadata['mukuroji-kind'] = 'mutated-after-call'
    callerMetadata['late-entry'] = 'must-not-be-observed'
    const reference = await referencePromise

    expect(reference).toEqual(fixture.reference)
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
    const putInput = transport.putCommands[0]?.input
    expect(putInput).toMatchObject({
      Bucket: configuration.journal.bucketName,
      Key: fixture.reference.objectKey,
      ContentLength: fixture.reference.byteLength,
      ContentType:
        WORKSPACE_SEARCH_MIGRATION_IMMUTABLE_ARTIFACT_CONTENT_TYPE,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: fixture.checksumSha256,
      IfNoneMatch: '*',
      ExpectedBucketOwner: configuration.account,
      Metadata: fixture.metadata,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: configuration.journal.keyArn,
      BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE',
    })
    expect(putInput?.ObjectLockRetainUntilDate?.toISOString())
      .toBe(testRetainUntil)
    if (!(putInput?.Body instanceof Uint8Array)) {
      throw new Error('Expected detached Uint8Array PutObject body.')
    }
    expect(putInput.Body).toEqual(fixture.bytes)
    expect(transport.headCommands[0]?.input).toEqual({
      Bucket: configuration.journal.bucketName,
      Key: fixture.reference.objectKey,
      ExpectedBucketOwner: configuration.account,
      ChecksumMode: 'ENABLED',
      VersionId: fixture.reference.versionId,
    })

    const readBytes = await port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference,
      metadata: { ...testCallerMetadata },
    })

    expect(readBytes).toEqual(fixture.bytes)
    expect(readBytes).not.toBe(fixture.bytes)
    expect(transport.getCommands).toHaveLength(1)
    expect(transport.getCommands[0]?.input).toEqual({
      Bucket: configuration.journal.bucketName,
      Key: fixture.reference.objectKey,
      VersionId: fixture.reference.versionId,
      ExpectedBucketOwner: configuration.account,
      ChecksumMode: 'ENABLED',
    })
  })

  test('reconciles a 412 only through current HeadObject', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    transport.putHandler = async () => {
      throw createAwsError('PreconditionFailed', 412)
    }
    transport.headHandler = async () =>
      createValidHeadOutput(configuration, fixture)
    const port = createPort(configuration, transport)

    const reference = await port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    })

    expect(reference).toEqual(fixture.reference)
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
    expect(transport.headCommands[0]?.input.VersionId).toBeUndefined()
  })

  test('reconciles an ambiguous Put when the exact current object exists', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    transport.putHandler = async () => {
      throw createAwsError('InternalError', 500)
    }
    transport.headHandler = async () =>
      createValidHeadOutput(configuration, fixture)
    const port = createPort(configuration, transport)

    const reference = await port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    })

    expect(reference).toEqual(fixture.reference)
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
  })

  test('retries one conditional Put only after ambiguous absence', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    let putCount = 0
    let headCount = 0
    transport.putHandler = async () => {
      putCount += 1
      if (putCount === 1) {
        throw createAwsError('InternalError', 500)
      }
      return {
        $metadata: {},
        VersionId: fixture.reference.versionId,
      }
    }
    transport.headHandler = async () => {
      headCount += 1
      if (headCount === 1) {
        throw createAwsError('NoSuchKey', 404)
      }
      return createValidHeadOutput(configuration, fixture)
    }
    const port = createPort(configuration, transport)

    const reference = await port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    })

    expect(reference).toEqual(fixture.reference)
    expect(transport.putCommands).toHaveLength(2)
    expect(transport.headCommands).toHaveLength(2)
    expect(transport.putCommands[0]?.input).toEqual(
      transport.putCommands[1]?.input,
    )
    expect(transport.headCommands[0]?.input.VersionId).toBeUndefined()
    expect(transport.headCommands[1]?.input.VersionId)
      .toBe(fixture.reference.versionId)
  })

  test('bounds ambiguous retries and request deadlines', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    transport.putHandler = (_command, abortSignal) =>
      new Promise<PutObjectCommandOutput>((_resolve, reject) => {
        abortSignal.addEventListener(
          'abort',
          () => reject(new Error('Underlying Put aborted.')),
          { once: true },
        )
      })
    transport.headHandler = async () => {
      throw createAwsError('NotFound', 404)
    }
    const port = createPort(configuration, transport, 1_000, 10)

    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    }), 'TRANSIENT_INFRASTRUCTURE_FAILURE')

    expect(transport.putCommands).toHaveLength(2)
    expect(transport.headCommands).toHaveLength(2)
    expect(transport.putAbortSignals).toHaveLength(2)
    expect(transport.putAbortSignals.every(
      (abortSignal) => abortSignal.aborted,
    )).toBe(true)
  })

  test('aborts stalled HeadObject and GetObject transport requests', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    let headAbortObserved = false
    let getAbortObserved = false
    transport.putHandler = async () => ({
      $metadata: {},
      VersionId: fixture.reference.versionId,
    })
    transport.headHandler = (_command, abortSignal) =>
      new Promise<HeadObjectCommandOutput>(() => {
        abortSignal.addEventListener('abort', () => {
          headAbortObserved = true
        }, { once: true })
      })
    const port = createPort(configuration, transport, 1_000, 10)

    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    }), 'AMBIGUOUS_OPERATION_UNRESOLVED')

    expect(transport.headAbortSignals).toHaveLength(1)
    expect(transport.headAbortSignals[0]?.aborted).toBe(true)
    expect(headAbortObserved).toBe(true)

    transport.getHandler = (_command, abortSignal) =>
      new Promise<GetObjectCommandOutput>(() => {
        abortSignal.addEventListener('abort', () => {
          getAbortObserved = true
        }, { once: true })
      })
    await captureFailure(port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    }), 'TRANSIENT_INFRASTRUCTURE_FAILURE')

    expect(transport.getAbortSignals).toHaveLength(1)
    expect(transport.getAbortSignals[0]?.aborted).toBe(true)
    expect(getAbortObserved).toBe(true)
  })

  test('does not reclassify exhausted retry headroom as invalid input', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const retainUntil = '2026-07-31T00:00:01.000Z'
    const fixture = createArtifactFixture(
      configuration,
      testRole,
      testVersionId,
      new Uint8Array([0, 1, 2, 3, 255]),
      retainUntil,
    )
    let nowEpochMilliseconds = testNow.getTime()
    transport.putHandler = async () => {
      throw createAwsError('InternalError', 500)
    }
    transport.headHandler = async () => {
      nowEpochMilliseconds += 1
      throw createAwsError('NoSuchKey', 404)
    }
    const port = createPort(
      configuration,
      transport,
      1_000,
      1_000,
      () => new Date(nowEpochMilliseconds),
    )

    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil,
    }), 'AMBIGUOUS_OPERATION_UNRESOLVED')

    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
  })

  test('does not retry a 412 whose current Head proves absence', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    transport.putHandler = async () => {
      throw createAwsError('PreconditionFailed', 412)
    }
    transport.headHandler = async () => {
      throw createAwsError('NoSuchKey', 404)
    }
    const port = createPort(configuration, transport)

    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    }), 'AMBIGUOUS_OPERATION_UNRESOLVED')

    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
  })

  test('redacts a non-ambiguous raw Put failure without Head or retry', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    transport.putHandler = async () => {
      throw createAwsError('AccessDenied', 403)
    }
    const port = createPort(configuration, transport)

    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    }), 'JOURNAL_WRITE_FAILED')

    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(0)
  })

  test('fails closed when Head does not exactly match immutable fields', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    transport.putHandler = async () => ({
      $metadata: {},
      VersionId: fixture.reference.versionId,
    })
    transport.headHandler = async () => ({
      ...createValidHeadOutput(configuration, fixture),
      SSEKMSKeyId:
        'arn:aws:kms:ap-northeast-1:123456789012:key/wrong',
    })
    const port = createPort(configuration, transport)

    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    }), 'INVALID_JOURNAL')

    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
  })

  test('rejects retention shortened at the observed S3 creation time', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    transport.putHandler = async () => ({
      $metadata: {},
      VersionId: fixture.reference.versionId,
    })
    transport.headHandler = async () => ({
      ...createValidHeadOutput(configuration, fixture),
      LastModified: new Date('2026-07-03T00:00:00.000Z'),
    })
    const port = createPort(configuration, transport)

    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    }), 'INVALID_JOURNAL')

    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
  })

  test('accepts bounded async chunks and rejects a body digest mismatch', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    const port = createPort(configuration, transport)
    transport.getHandler = async () =>
      createValidGetOutput(
        configuration,
        fixture,
        createAsyncBody([
          fixture.bytes.slice(0, 2),
          fixture.bytes.slice(2),
        ]),
      )

    const bytes = await port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    })

    expect(bytes).toEqual(fixture.bytes)
    transport.getHandler = async () =>
      createValidGetOutput(
        configuration,
        fixture,
        new Uint8Array([0, 1, 2, 3, 254]),
      )

    await captureFailure(port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    }), 'INVALID_JOURNAL')
  })

  test('rejects mismatched exact-version GetObject fields', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    const body = new StalledImmutableArtifactBody()
    transport.getHandler = async () => ({
      ...createValidGetOutput(configuration, fixture, body),
      ChecksumSHA256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    })
    const port = createPort(configuration, transport)

    await captureFailure(port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    }), 'INVALID_JOURNAL')

    expect(transport.getCommands).toHaveLength(1)
    expect(body.returned).toBe(true)
    expect(body.destroyed).toBe(true)
  })

  test('rejects proxied and accessor-backed GetObject state without traps', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    const port = createPort(configuration, transport)
    let bodyTrapCalled = false
    const proxyBody = new Proxy(fixture.bytes, {
      get() {
        bodyTrapCalled = true
        throw new Error('raw-secret body trap')
      },
      getPrototypeOf() {
        bodyTrapCalled = true
        throw new Error('raw-secret prototype trap')
      },
    })
    transport.getHandler = async () =>
      createValidGetOutput(configuration, fixture, proxyBody)

    await captureFailure(port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    }), 'INVALID_JOURNAL')
    expect(bodyTrapCalled).toBe(false)

    let metadataAccessorCalled = false
    const accessorBody = new StalledImmutableArtifactBody()
    transport.getHandler = async () => {
      const output =
        createValidGetOutput(
          configuration,
          fixture,
          accessorBody,
        )
      Object.defineProperty(output, 'Metadata', {
        configurable: true,
        enumerable: true,
        get() {
          metadataAccessorCalled = true
          throw new Error('raw-secret response getter')
        },
      })
      return output
    }
    await captureFailure(port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    }), 'INVALID_JOURNAL')
    expect(metadataAccessorCalled).toBe(false)
    expect(accessorBody.returned).toBe(true)
    expect(accessorBody.destroyed).toBe(true)
  })

  test('cleans a body when async-iterator snapshotting fails', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    const body = new InvalidIteratorImmutableArtifactBody()
    transport.getHandler = async () =>
      createValidGetOutput(configuration, fixture, body)
    const port = createPort(configuration, transport)

    await captureFailure(port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    }), 'INVALID_JOURNAL')

    expect(body.returned).toBe(true)
    expect(body.destroyed).toBe(true)
  })

  test('cleans a distinct iterator when its next method is invalid', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    const body = new StalledImmutableArtifactBody()
    const iterator = new StalledImmutableArtifactBody()
    let nextAccessorCalled = false
    Object.defineProperty(iterator, 'next', {
      configurable: true,
      get() {
        nextAccessorCalled = true
        throw new Error('raw-secret next accessor')
      },
    })
    Object.defineProperty(body, Symbol.asyncIterator, {
      configurable: true,
      value: () => iterator,
    })
    transport.getHandler = async () =>
      createValidGetOutput(configuration, fixture, body)
    const port = createPort(configuration, transport)

    await captureFailure(port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    }), 'INVALID_JOURNAL')

    expect(nextAccessorCalled).toBe(false)
    expect(iterator.returned).toBe(true)
    expect(iterator.returnCalls).toBe(1)
    expect(body.returnCalls).toBe(1)
    expect(body.destroyed).toBe(true)
    expect(body.destroyCalls).toBe(1)
  })

  test('bounds stalled bodies and requests best-effort cleanup', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    const body = new StalledImmutableArtifactBody()
    transport.getHandler = async () =>
      createValidGetOutput(configuration, fixture, body)
    const port = createPort(configuration, transport, 10)

    await captureFailure(port.readImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      reference: fixture.reference,
      metadata: testCallerMetadata,
    }), 'TRANSIENT_INFRASTRUCTURE_FAILURE')

    expect(body.returned).toBe(true)
    expect(body.destroyed).toBe(true)
  })

  test('separates identical content by semantic role', async () => {
    const configuration = createConfiguration()
    const bytes = new Uint8Array([4, 5, 6])
    const roles = ['planning-plan', 'planning-provenance']
    const references:
      WorkspaceSearchMigrationImmutableArtifactReference[] = []
    for (const [index, role] of roles.entries()) {
      const transport = new RecordingImmutableArtifactTransport()
      const fixture = createArtifactFixture(
        configuration,
        role,
        `version-${index}`,
        bytes,
      )
      transport.putHandler = async () => ({
        $metadata: {},
        VersionId: fixture.reference.versionId,
      })
      transport.headHandler = async () =>
        createValidHeadOutput(configuration, fixture)
      references.push(await createPort(
        configuration,
        transport,
      ).writeImmutableArtifact({
        role,
        objectKeyPrefix: testObjectKeyPrefix,
        bytes,
        metadata: testCallerMetadata,
        retainUntil: testRetainUntil,
      }))
    }

    expect(references[0]?.contentDigest)
      .toBe(references[1]?.contentDigest)
    expect(references[0]?.objectKey)
      .not.toBe(references[1]?.objectKey)
    expect(references[0]?.objectKey).toContain('/planning-plan/')
    expect(references[1]?.objectKey)
      .toContain('/planning-provenance/')
  })

  test('rejects Proxy, SharedArrayBuffer, and accessor metadata inputs without traps', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    const port = createPort(configuration, transport)
    let proxyTrapCalled = false
    const proxyBytes = new Proxy(fixture.bytes, {
      get() {
        proxyTrapCalled = true
        throw new Error('raw-secret proxy trap')
      },
    })

    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: proxyBytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    }), 'INVALID_ARGUMENT')
    expect(proxyTrapCalled).toBe(false)

    const sharedBytes =
      new Uint8Array(new SharedArrayBuffer(fixture.bytes.byteLength))
    sharedBytes.set(fixture.bytes)
    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: sharedBytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    }), 'INVALID_ARGUMENT')

    let metadataAccessorCalled = false
    const accessorMetadata: Record<string, string> = {}
    Object.defineProperty(accessorMetadata, 'mukuroji-kind', {
      configurable: true,
      enumerable: true,
      get() {
        metadataAccessorCalled = true
        throw new Error('raw-secret metadata getter')
      },
    })
    await captureFailure(port.writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: accessorMetadata,
      retainUntil: testRetainUntil,
    }), 'INVALID_ARGUMENT')

    expect(metadataAccessorCalled).toBe(false)
    expect(transport.putCommands).toHaveLength(0)
  })

  test('uses intrinsic Uint8Array state without invoking a spoofed byteLength', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)
    let byteLengthAccessorCalled = false
    const bytes = new Uint8Array(fixture.bytes)
    Object.defineProperty(bytes, 'byteLength', {
      configurable: true,
      enumerable: false,
      get() {
        byteLengthAccessorCalled = true
        throw new Error('raw-secret byteLength getter')
      },
    })
    transport.putHandler = async () => ({
      $metadata: {},
      VersionId: fixture.reference.versionId,
    })
    transport.headHandler = async () =>
      createValidHeadOutput(configuration, fixture)

    const reference = await createPort(
      configuration,
      transport,
    ).writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes,
      metadata: testCallerMetadata,
      retainUntil: testRetainUntil,
    })

    expect(reference).toEqual(fixture.reference)
    expect(byteLengthAccessorCalled).toBe(false)
  })

  test('rejects proxied transport and reserved metadata before I/O', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    let transportTrapCalled = false
    const proxyTransport = new Proxy(transport, {
      get() {
        transportTrapCalled = true
        throw new Error('raw-secret transport trap')
      },
    })
    captureSynchronousFailure(
      () => createPort(configuration, proxyTransport),
      'INVALID_ARGUMENT',
    )
    expect(transportTrapCalled).toBe(false)

    const fixture = createArtifactFixture(configuration)
    await captureFailure(createPort(
      configuration,
      transport,
    ).writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: {
        'mukuroji-immutable-role': 'spoofed',
      },
      retainUntil: testRetainUntil,
    }), 'INVALID_ARGUMENT')
    expect(transport.putCommands).toHaveLength(0)
  })

  test('rejects retention outside the configured bounded window', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const fixture = createArtifactFixture(configuration)

    await captureFailure(createPort(
      configuration,
      transport,
    ).writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: '2026-07-30T00:00:00.000Z',
    }), 'INVALID_ARGUMENT')
    await captureFailure(createPort(
      configuration,
      transport,
    ).writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: '2026-08-02T00:00:00.000Z',
    }), 'INVALID_ARGUMENT')
    await captureFailure(createPort(
      configuration,
      transport,
    ).writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil: '2026-07-31T00:00:00.000Z',
    }), 'INVALID_ARGUMENT')

    expect(transport.putCommands).toHaveLength(0)
  })

  test('reserves one request deadline above the retention floor', async () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()
    const retainUntil = '2026-07-31T00:00:01.000Z'
    const fixture = createArtifactFixture(
      configuration,
      testRole,
      testVersionId,
      new Uint8Array([0, 1, 2, 3, 255]),
      retainUntil,
    )
    transport.putHandler = async () => ({
      $metadata: {},
      VersionId: fixture.reference.versionId,
    })
    transport.headHandler = async () =>
      createValidHeadOutput(configuration, fixture)

    const reference = await createPort(
      configuration,
      transport,
    ).writeImmutableArtifact({
      role: fixture.role,
      objectKeyPrefix: testObjectKeyPrefix,
      bytes: fixture.bytes,
      metadata: testCallerMetadata,
      retainUntil,
    })

    expect(reference).toEqual(fixture.reference)
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
  })

  test('rejects a configuration hash mismatch before transport use', () => {
    const configuration = createConfiguration()
    const transport = new RecordingImmutableArtifactTransport()

    captureSynchronousFailure(
      () => createAwsWorkspaceSearchMigrationImmutableArtifactPort({
        configuration,
        configurationHash: 'b'.repeat(64),
        maximumObjectBytes: 1_024,
        requestTimeoutMilliseconds: 1_000,
        bodyTimeoutMilliseconds: 1_000,
        clock: () => new Date(testNow),
        transport,
      }),
      'CONFIGURATION_HASH_MISMATCH',
    )

    expect(transport.putCommands).toHaveLength(0)
    expect(transport.headCommands).toHaveLength(0)
    expect(transport.getCommands).toHaveLength(0)
  })

  test('rejects migration-journal retention configuration drift', () => {
    const configuration = createConfiguration()
    const driftedConfiguration: WorkspaceSearchMigrationConfiguration = {
      ...configuration,
      journal: {
        ...configuration.journal,
        defaultRetentionDays: 31,
      },
    }
    const transport = new RecordingImmutableArtifactTransport()

    captureSynchronousFailure(
      () => createPort(driftedConfiguration, transport),
      'INVALID_ARGUMENT',
    )

    expect(transport.putCommands).toHaveLength(0)
    expect(transport.headCommands).toHaveLength(0)
    expect(transport.getCommands).toHaveLength(0)
  })
})
