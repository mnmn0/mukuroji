import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3'
import {
  isThrottlingError,
  isTransientError,
} from '@smithy/core/retry'
import {
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isHexDigest,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Fixed media type used by the codec-agnostic immutable object core. */
export const WORKSPACE_SEARCH_MIGRATION_IMMUTABLE_ARTIFACT_CONTENT_TYPE =
  'application/octet-stream'

/**
 * Absolute safety ceiling for one immutable object handled by this core.
 *
 * Higher-level codecs should normally choose a smaller semantic segment size.
 */
export const WORKSPACE_SEARCH_MIGRATION_IMMUTABLE_ARTIFACT_MAX_BYTES =
  64 * 1024 * 1024

const maximumTimeoutMilliseconds = 30_000
const maximumMetadataBytes = 2_048
const immutableMetadataPrefix = 'mukuroji-immutable-'
const immutableArtifactMaximumRetryCount = 1
const retentionDayMilliseconds = 24 * 60 * 60 * 1_000
const maximumAdditionalRetentionDays = 1

/**
 * Narrow S3 transport exposed to the codec-agnostic immutable object core.
 */
export interface WorkspaceSearchMigrationImmutableArtifactAwsTransport {
  /**
   * Sends one exclusive immutable object upload.
   *
   * The transport must bind the signal to the underlying S3 request so the
   * caller-fixed retention headroom remains bounded by the request deadline.
   *
   * @param command - Adapter-owned conditional PutObject command.
   * @param abortSignal - Deadline signal for the underlying S3 request.
   * @returns Raw low-level S3 response.
   */
  putImmutableArtifact(
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<PutObjectCommandOutput>

  /**
   * Reads exact object metadata for reconciliation.
   *
   * @param command - Adapter-owned current or version-pinned HeadObject.
   * @param abortSignal - Deadline signal for the underlying S3 request.
   * @returns Raw low-level S3 response.
   */
  headImmutableArtifact(
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<HeadObjectCommandOutput>

  /**
   * Reads one exact immutable object version.
   *
   * @param command - Adapter-owned version-pinned GetObject.
   * @param abortSignal - Deadline signal for the underlying S3 request.
   * @returns Raw low-level S3 response.
   */
  getImmutableArtifact(
    command: GetObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<GetObjectCommandOutput>
}

/**
 * Trusted clock used only to validate caller-fixed retention deadlines.
 *
 * @returns Current adapter time.
 */
export type WorkspaceSearchMigrationImmutableArtifactClock = () => Date

/**
 * Dependencies and finite limits for one immutable object port.
 */
export type CreateWorkspaceSearchMigrationImmutableArtifactAwsPortInput = {
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Maximum nonempty object bytes accepted by this port. */
  readonly maximumObjectBytes: number
  /** Finite deadline for each Put, Head, or Get transport request. */
  readonly requestTimeoutMilliseconds: number
  /** Finite deadline for consuming one returned GetObject body. */
  readonly bodyTimeoutMilliseconds: number
  /** One-way signal that invalidates every request and body owned by this port. */
  readonly lifecycleSignal: AbortSignal
  /** Trusted adapter clock used to prove retention headroom. */
  readonly clock: WorkspaceSearchMigrationImmutableArtifactClock
  /** Narrow S3 transport sharing the measured credential session. */
  readonly transport: WorkspaceSearchMigrationImmutableArtifactAwsTransport
}

/**
 * Exact immutable version returned by a successful write and required by reads.
 */
export type WorkspaceSearchMigrationImmutableArtifactReference = {
  /** Content-addressed role-separated S3 object key. */
  readonly objectKey: string
  /** Exact immutable S3 object version. */
  readonly versionId: string
  /** Lowercase SHA-256 digest of the exact stored bytes. */
  readonly contentDigest: string
  /** Exact stored body length. */
  readonly byteLength: number
  /** Exact canonical UTC Object Lock deadline. */
  readonly retainUntil: string
}

/**
 * Input for one exclusive immutable object upload.
 */
export type WriteWorkspaceSearchMigrationImmutableArtifactInput = {
  /** Safe semantic role separated in both the key and metadata. */
  readonly role: string
  /** Canonical codec-owned prefix below the measured journal prefix. */
  readonly objectKeyPrefix: string
  /** Exact nonempty codec-owned bytes to store. */
  readonly bytes: Uint8Array
  /** Exact caller-owned nonsecret metadata bound to the object. */
  readonly metadata: Readonly<Record<string, string>>
  /** Caller-fixed canonical UTC COMPLIANCE retention deadline. */
  readonly retainUntil: string
}

/**
 * Input for one exact-version immutable object read.
 */
export type ReadWorkspaceSearchMigrationImmutableArtifactInput = {
  /** Expected safe semantic role. */
  readonly role: string
  /** Expected canonical codec-owned key prefix. */
  readonly objectKeyPrefix: string
  /** Exact version, digest, length, and retention selected by the caller. */
  readonly reference: WorkspaceSearchMigrationImmutableArtifactReference
  /** Exact caller-owned metadata expected on the stored version. */
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Codec-agnostic immutable single-object storage operations.
 */
export interface WorkspaceSearchMigrationImmutableArtifactAwsPort {
  /**
   * Stores or exactly reconciles one content-addressed object.
   *
   * @param input - Role, prefix, exact bytes, metadata, and retention.
   * @returns Exact immutable version reference.
   */
  writeImmutableArtifact(
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference>

  /**
   * Reads and verifies one exact immutable object version.
   *
   * @param input - Exact expected reference, role, prefix, and metadata.
   * @returns Detached exact object bytes.
   */
  readImmutableArtifact(
    input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<Uint8Array>
}

/**
 * Private fixed failure codes emitted by the immutable object core.
 */
type ImmutableArtifactFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_JOURNAL'
  | 'INVALID_STATE'
  | 'JOURNAL_WRITE_FAILED'
  | 'TRANSIENT_INFRASTRUCTURE_FAILURE'

/**
 * Secret-free structural error supplied only to Smithy classifiers.
 */
type ImmutableArtifactAwsErrorClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js transport error code. */
    readonly code?: string
  }

/**
 * Privately branded immutable-object failure.
 */
class ImmutableArtifactFailure extends Error {
  /** Stable secret-free failure code. */
  readonly code: ImmutableArtifactFailureCode

  /**
   * Creates one privately branded boundary failure.
   *
   * @param code - Stable failure code.
   */
  constructor(code: ImmutableArtifactFailureCode) {
    super(code)
    this.name = 'ImmutableArtifactFailure'
    this.code = code
  }
}

/**
 * Fixed request or body timeout recognized as transient.
 */
class ImmutableArtifactTimeout extends Error {
  /** Node.js timeout code recognized by Smithy. */
  readonly code = 'ETIMEDOUT'

  /**
   * Creates one secret-free timeout.
   */
  constructor() {
    super('Immutable artifact operation timed out.')
    this.name = 'TimeoutError'
  }
}

/**
 * Detached transport methods retained without later property reads.
 */
type PreparedImmutableArtifactTransport = {
  /** Detached PutObject invocation. */
  readonly put:
    (
      command: PutObjectCommand,
      abortSignal: AbortSignal,
    ) => Promise<PutObjectCommandOutput>
  /** Detached HeadObject invocation. */
  readonly head:
    (
      command: HeadObjectCommand,
      abortSignal: AbortSignal,
    ) => Promise<HeadObjectCommandOutput>
  /** Detached GetObject invocation. */
  readonly get:
    (
      command: GetObjectCommand,
      abortSignal: AbortSignal,
    ) => Promise<GetObjectCommandOutput>
}

/**
 * Validated dependencies retained by one immutable object port.
 */
type PreparedImmutableArtifactPortInput = {
  /** Detached measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Exact measured configuration digest. */
  readonly configurationHash: string
  /** Maximum accepted object size. */
  readonly maximumObjectBytes: number
  /** Per-request timeout. */
  readonly requestTimeoutMilliseconds: number
  /** Body-consumption timeout. */
  readonly bodyTimeoutMilliseconds: number
  /** One-way lifecycle cancellation shared by requests and body reads. */
  readonly lifecycleSignal: AbortSignal
  /** Detached trusted clock invocation. */
  readonly clock: WorkspaceSearchMigrationImmutableArtifactClock
  /** Detached narrow S3 operations. */
  readonly transport: PreparedImmutableArtifactTransport
}

/**
 * Fully detached write material prepared before the first await.
 */
type PreparedImmutableArtifact = {
  /** Safe semantic object role. */
  readonly role: string
  /** Canonical caller-selected prefix. */
  readonly objectKeyPrefix: string
  /** Detached exact bytes. */
  readonly bytes: Uint8Array
  /** Lowercase SHA-256 content digest. */
  readonly contentDigest: string
  /** Base64 SHA-256 S3 checksum. */
  readonly checksumSha256: string
  /** Exact byte length. */
  readonly byteLength: number
  /** Content-addressed role-separated object key. */
  readonly objectKey: string
  /** Exact canonical retention deadline. */
  readonly retainUntil: string
  /** Exact retention deadline as epoch milliseconds. */
  readonly retainUntilEpochMilliseconds: number
  /** Complete adapter and caller metadata. */
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Fully detached exact-version read expectation.
 */
type PreparedImmutableArtifactRead = {
  /** Safe semantic object role. */
  readonly role: string
  /** Canonical caller-selected prefix. */
  readonly objectKeyPrefix: string
  /** Strict exact immutable reference. */
  readonly reference: WorkspaceSearchMigrationImmutableArtifactReference
  /** Base64 checksum derived from the exact content digest. */
  readonly checksumSha256: string
  /** Exact retention deadline as epoch milliseconds. */
  readonly retainUntilEpochMilliseconds: number
  /** Complete adapter and caller metadata. */
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Safe detached subset of a HeadObject or GetObject response.
 */
type ImmutableArtifactObjectSnapshot = {
  /** Exact object version, when returned. */
  readonly versionId: string | undefined
  /** Exact object byte length, when returned. */
  readonly contentLength: number | undefined
  /** Stored media type, when returned. */
  readonly contentType: string | undefined
  /** Stored base64 SHA-256 checksum, when returned. */
  readonly checksumSha256: string | undefined
  /** Stored checksum composition type, when returned. */
  readonly checksumType: string | undefined
  /** Server-side encryption family, when returned. */
  readonly serverSideEncryption: string | undefined
  /** Exact KMS key locator, when returned. */
  readonly sseKmsKeyId: string | undefined
  /** Whether S3 Bucket Keys were used, when returned. */
  readonly bucketKeyEnabled: boolean | undefined
  /** Whether this response represents a delete marker. */
  readonly deleteMarker: boolean | undefined
  /** Exact S3 object-version creation time, when returned. */
  readonly lastModifiedEpochMilliseconds: number | undefined
  /** Exact Object Lock mode, when returned. */
  readonly objectLockMode: string | undefined
  /** Exact retention deadline epoch milliseconds, when returned. */
  readonly retainUntilEpochMilliseconds: number | undefined
  /** Detached exact user metadata, when returned. */
  readonly metadata: Readonly<Record<string, string>> | undefined
  /** Untrusted streaming body retained only for GetObject. */
  readonly body: unknown
}

/**
 * Creates an immutable object adapter bound to measured resources.
 *
 * @param input - Measured configuration, limits, time, and narrow transport.
 * @returns Codec-agnostic immutable object port.
 */
export function createAwsWorkspaceSearchMigrationImmutableArtifactPort(
  input: CreateWorkspaceSearchMigrationImmutableArtifactAwsPortInput,
): WorkspaceSearchMigrationImmutableArtifactAwsPort {
  try {
    const prepared = prepareImmutableArtifactPortInput(input)
    return new AwsWorkspaceSearchMigrationImmutableArtifactPort(prepared)
  } catch (error: unknown) {
    throw createImmutableArtifactBoundaryFailure(
      readImmutableArtifactFailureCode(error, 'INVALID_ARGUMENT'),
    )
  }
}

/**
 * Concrete codec-agnostic immutable S3 object adapter.
 */
class AwsWorkspaceSearchMigrationImmutableArtifactPort
  implements WorkspaceSearchMigrationImmutableArtifactAwsPort {
  /** Detached measured configuration. */
  private readonly configuration: WorkspaceSearchMigrationConfiguration

  /** Exact measured configuration digest. */
  private readonly configurationHash: string

  /** Maximum accepted object bytes. */
  private readonly maximumObjectBytes: number

  /** Finite S3 request deadline. */
  private readonly requestTimeoutMilliseconds: number

  /** Finite body-consumption deadline. */
  private readonly bodyTimeoutMilliseconds: number

  /** One-way lifecycle cancellation for every request and body read. */
  private readonly lifecycleSignal: AbortSignal

  /** Detached trusted clock invocation. */
  private readonly clock: WorkspaceSearchMigrationImmutableArtifactClock

  /** Detached narrow S3 operations. */
  private readonly transport: PreparedImmutableArtifactTransport

  /**
   * Creates one adapter from already validated dependencies.
   *
   * @param input - Detached measured resources and limits.
   */
  constructor(input: PreparedImmutableArtifactPortInput) {
    this.configuration = input.configuration
    this.configurationHash = input.configurationHash
    this.maximumObjectBytes = input.maximumObjectBytes
    this.requestTimeoutMilliseconds =
      input.requestTimeoutMilliseconds
    this.bodyTimeoutMilliseconds = input.bodyTimeoutMilliseconds
    this.lifecycleSignal = input.lifecycleSignal
    this.clock = input.clock
    this.transport = input.transport
  }

  /**
   * Stores or exactly reconciles one content-addressed object.
   *
   * @param input - Exact bytes and immutable storage identity.
   * @returns Exact immutable object-version reference.
   */
  async writeImmutableArtifact(
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    return runImmutableArtifactBoundary(async () => {
      const prepared = prepareImmutableArtifactWrite(
        input,
        this.configuration,
        this.configurationHash,
        this.maximumObjectBytes,
        this.requestTimeoutMilliseconds,
        this.clock,
      )
      return this.putPreparedImmutableArtifact(prepared)
    })
  }

  /**
   * Uploads or reconciles one prepared immutable object.
   *
   * @param artifact - Fully detached immutable object material.
   * @param retryCount - Conditional retries already attempted.
   * @returns Exact immutable object-version reference.
   */
  private async putPreparedImmutableArtifact(
    artifact: PreparedImmutableArtifact,
    retryCount = 0,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    requireImmutableArtifactRetentionHeadroom(
      artifact.retainUntilEpochMilliseconds,
      this.configuration,
      this.requestTimeoutMilliseconds,
      this.clock,
      retryCount === 0
        ? 'INVALID_ARGUMENT'
        : 'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
    let output: PutObjectCommandOutput
    try {
      output = await runWithImmutableArtifactDeadline(
        (abortSignal) => this.transport.put(
          createImmutableArtifactPutCommand(
            this.configuration,
            artifact,
          ),
          abortSignal,
        ),
        this.requestTimeoutMilliseconds,
        this.lifecycleSignal,
      )
    } catch (error: unknown) {
      if (
        !nodeUtilTypes.isProxy(error) &&
        error instanceof ImmutableArtifactFailure
      ) {
        throw error
      }
      if (isImmutableArtifactPreconditionFailure(error)) {
        const existing =
          await this.reconcileImmutableArtifact(artifact)
        if (existing !== undefined) return existing
        return failImmutableArtifact(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
        )
      }
      if (isImmutableArtifactAmbiguousWriteFailure(error)) {
        const existing =
          await this.reconcileImmutableArtifact(artifact)
        if (existing !== undefined) return existing
        if (retryCount < immutableArtifactMaximumRetryCount) {
          return this.putPreparedImmutableArtifact(
            artifact,
            retryCount + 1,
          )
        }
        return failImmutableArtifact(
          'TRANSIENT_INFRASTRUCTURE_FAILURE',
        )
      }
      return failImmutableArtifact('JOURNAL_WRITE_FAILED')
    }
    const versionId =
      snapshotImmutableArtifactPutVersion(output)
    const stored = await this.reconcileImmutableArtifact(
      artifact,
      versionId,
    )
    if (stored === undefined) {
      return failImmutableArtifact(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
    return stored
  }

  /**
   * Reads and verifies one exact immutable object version.
   *
   * @param input - Exact expected reference and metadata.
   * @returns Detached exact object bytes.
   */
  async readImmutableArtifact(
    input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<Uint8Array> {
    return runImmutableArtifactBoundary(async () => {
      const prepared = prepareImmutableArtifactRead(
        input,
        this.configuration,
        this.configurationHash,
        this.maximumObjectBytes,
        this.clock,
      )
      let output: GetObjectCommandOutput
      try {
        output = await runWithImmutableArtifactDeadline(
          (abortSignal) => this.transport.get(
            new GetObjectCommand({
              Bucket: this.configuration.journal.bucketName,
              Key: prepared.reference.objectKey,
              VersionId: prepared.reference.versionId,
              ExpectedBucketOwner: this.configuration.account,
              ChecksumMode: 'ENABLED',
            }),
            abortSignal,
          ),
          this.requestTimeoutMilliseconds,
          this.lifecycleSignal,
        )
      } catch (error: unknown) {
        if (
          !nodeUtilTypes.isProxy(error) &&
          error instanceof ImmutableArtifactFailure
        ) {
          throw error
        }
        if (isImmutableArtifactRetryableFailure(error)) {
          return failImmutableArtifact(
            'TRANSIENT_INFRASTRUCTURE_FAILURE',
          )
        }
        return failImmutableArtifact('INVALID_JOURNAL')
      }
      const snapshot =
        snapshotImmutableArtifactObjectOutput(output, true)
      try {
        requireImmutableArtifactObjectMatches(
          snapshot,
          prepared.reference,
          prepared.checksumSha256,
          prepared.retainUntilEpochMilliseconds,
          prepared.metadata,
          this.configuration,
        )
      } catch (error: unknown) {
        cancelImmutableArtifactBody(snapshot.body, snapshot.body)
        throw error
      }
      const bytes = await readBoundedImmutableArtifactBody(
        snapshot.body,
        prepared.reference.byteLength,
        this.maximumObjectBytes,
        this.bodyTimeoutMilliseconds,
        this.lifecycleSignal,
      )
      if (
        digestImmutableArtifactBytes(bytes) !==
          prepared.reference.contentDigest
      ) {
        return failImmutableArtifact('INVALID_JOURNAL')
      }
      return bytes
    })
  }

  /**
   * Reconciles one successful or ambiguous Put using only exact Head metadata.
   *
   * @param artifact - Exact prepared object identity.
   * @param requestedVersionId - Version returned by a successful Put.
   * @returns Exact immutable reference proven by HeadObject.
   */
  private async reconcileImmutableArtifact(
    artifact: PreparedImmutableArtifact,
    requestedVersionId?: string,
  ): Promise<
    WorkspaceSearchMigrationImmutableArtifactReference | undefined
  > {
    let output: HeadObjectCommandOutput
    try {
      output = await runWithImmutableArtifactDeadline(
        (abortSignal) => this.transport.head(
          new HeadObjectCommand({
            Bucket: this.configuration.journal.bucketName,
            Key: artifact.objectKey,
            ExpectedBucketOwner: this.configuration.account,
            ChecksumMode: 'ENABLED',
            ...(requestedVersionId === undefined
              ? {}
              : { VersionId: requestedVersionId }),
          }),
          abortSignal,
        ),
        this.requestTimeoutMilliseconds,
        this.lifecycleSignal,
      )
    } catch (error: unknown) {
      if (
        !nodeUtilTypes.isProxy(error) &&
        error instanceof ImmutableArtifactFailure
      ) {
        throw error
      }
      if (isImmutableArtifactNotFound(error)) return undefined
      if (
        !nodeUtilTypes.isProxy(error) &&
        error instanceof ImmutableArtifactFailure
      ) {
        throw error
      }
      return failImmutableArtifact(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
    const snapshot =
      snapshotImmutableArtifactObjectOutput(output, false)
    const versionId = requestedVersionId ??
      readRequiredImmutableArtifactVersion(snapshot.versionId)
    requireImmutableArtifactObjectMatches(
      snapshot,
      {
        objectKey: artifact.objectKey,
        versionId,
        contentDigest: artifact.contentDigest,
        byteLength: artifact.byteLength,
        retainUntil: artifact.retainUntil,
      },
      artifact.checksumSha256,
      artifact.retainUntilEpochMilliseconds,
      artifact.metadata,
      this.configuration,
    )
    return {
      objectKey: artifact.objectKey,
      versionId,
      contentDigest: artifact.contentDigest,
      byteLength: artifact.byteLength,
      retainUntil: artifact.retainUntil,
    }
  }
}

/**
 * Detaches and validates port construction input.
 *
 * @param input - Candidate runtime dependencies.
 * @returns Detached validated dependencies.
 */
function prepareImmutableArtifactPortInput(
  input: CreateWorkspaceSearchMigrationImmutableArtifactAwsPortInput,
): PreparedImmutableArtifactPortInput {
  const record = requireImmutableArtifactRecord(
    input,
    'INVALID_ARGUMENT',
  )
  requireExactImmutableArtifactKeys(record, [
    'bodyTimeoutMilliseconds',
    'clock',
    'configuration',
    'configurationHash',
    'lifecycleSignal',
    'maximumObjectBytes',
    'requestTimeoutMilliseconds',
    'transport',
  ], 'INVALID_ARGUMENT')
  const configurationCandidate =
    readRequiredOwnData(record, 'configuration', 'INVALID_ARGUMENT')
  requireBoundedPlainDataGraph(configurationCandidate)
  const configuration = structuredClone(input.configuration)
  requireImmutableArtifactConfiguration(configuration)
  const configurationHash = readDigest(
    readRequiredOwnData(
      record,
      'configurationHash',
      'INVALID_ARGUMENT',
    ),
    'CONFIGURATION_HASH_MISMATCH',
  )
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failImmutableArtifact('CONFIGURATION_HASH_MISMATCH')
  }
  const maximumObjectBytes = readPositiveInteger(
    readRequiredOwnData(
      record,
      'maximumObjectBytes',
      'INVALID_ARGUMENT',
    ),
    WORKSPACE_SEARCH_MIGRATION_IMMUTABLE_ARTIFACT_MAX_BYTES,
  )
  const requestTimeoutMilliseconds = readPositiveInteger(
    readRequiredOwnData(
      record,
      'requestTimeoutMilliseconds',
      'INVALID_ARGUMENT',
    ),
    maximumTimeoutMilliseconds,
  )
  const bodyTimeoutMilliseconds = readPositiveInteger(
    readRequiredOwnData(
      record,
      'bodyTimeoutMilliseconds',
      'INVALID_ARGUMENT',
    ),
    maximumTimeoutMilliseconds,
  )
  const lifecycleSignal = snapshotImmutableArtifactLifecycleSignal(
    readRequiredOwnData(
      record,
      'lifecycleSignal',
      'INVALID_ARGUMENT',
    ),
  )
  const clock = snapshotImmutableArtifactClock(
    readRequiredOwnData(record, 'clock', 'INVALID_ARGUMENT'),
  )
  const transport = snapshotImmutableArtifactTransport(
    readRequiredOwnData(record, 'transport', 'INVALID_ARGUMENT'),
  )
  return {
    configuration,
    configurationHash,
    maximumObjectBytes,
    requestTimeoutMilliseconds,
    bodyTimeoutMilliseconds,
    lifecycleSignal,
    clock,
    transport,
  }
}

/**
 * Prepares one write without retaining caller-owned mutable state.
 *
 * @param input - Candidate write input.
 * @param configuration - Adapter-bound measured configuration.
 * @param configurationHash - Exact configuration digest.
 * @param maximumObjectBytes - Port object ceiling.
 * @param requestTimeoutMilliseconds - Maximum time one Put may consume.
 * @param clock - Trusted clock.
 * @returns Fully detached immutable object request.
 */
function prepareImmutableArtifactWrite(
  input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  maximumObjectBytes: number,
  requestTimeoutMilliseconds: number,
  clock: WorkspaceSearchMigrationImmutableArtifactClock,
): PreparedImmutableArtifact {
  const record = requireImmutableArtifactRecord(
    input,
    'INVALID_ARGUMENT',
  )
  requireExactImmutableArtifactKeys(record, [
    'bytes',
    'metadata',
    'objectKeyPrefix',
    'retainUntil',
    'role',
  ], 'INVALID_ARGUMENT')
  const role = readArtifactRole(
    readRequiredOwnData(record, 'role', 'INVALID_ARGUMENT'),
  )
  const objectKeyPrefix = readObjectKeyPrefix(
    readRequiredOwnData(
      record,
      'objectKeyPrefix',
      'INVALID_ARGUMENT',
    ),
    configuration.journalPrefix,
  )
  const bytes = snapshotImmutableArtifactBytes(
    readRequiredOwnData(record, 'bytes', 'INVALID_ARGUMENT'),
    maximumObjectBytes,
    'INVALID_ARGUMENT',
  )
  const retainUntil = readRetentionDeadline(
    readRequiredOwnData(
      record,
      'retainUntil',
      'INVALID_ARGUMENT',
    ),
  )
  const retainUntilEpochMilliseconds = Date.parse(retainUntil)
  requireImmutableArtifactRetentionHeadroom(
    retainUntilEpochMilliseconds,
    configuration,
    requestTimeoutMilliseconds,
    clock,
    'INVALID_ARGUMENT',
  )
  const contentDigest = digestImmutableArtifactBytes(bytes)
  const objectKey =
    `${objectKeyPrefix}/${role}/${contentDigest}.artifact`
  if (Buffer.byteLength(objectKey, 'utf8') > 1_024) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  const callerMetadata = snapshotCallerMetadata(
    readRequiredOwnData(record, 'metadata', 'INVALID_ARGUMENT'),
  )
  const metadata = createImmutableArtifactMetadata(
    callerMetadata,
    role,
    configurationHash,
    contentDigest,
    bytes.byteLength,
    retainUntil,
  )
  return {
    role,
    objectKeyPrefix,
    bytes,
    contentDigest,
    checksumSha256:
      createImmutableArtifactChecksumSha256(bytes),
    byteLength: bytes.byteLength,
    objectKey,
    retainUntil,
    retainUntilEpochMilliseconds,
    metadata,
  }
}

/**
 * Requires enough caller-fixed retention headroom for one complete S3 request.
 *
 * Rechecking immediately before every conditional Put prevents an accepted
 * lower-bound deadline from becoming shorter than the measured 30-day contract
 * solely because the request takes time to reach S3.
 *
 * @param retainUntilEpochMilliseconds - Exact caller-fixed retention deadline.
 * @param configuration - Adapter-bound measured journal configuration.
 * @param requestTimeoutMilliseconds - Maximum time one Put may consume.
 * @param clock - Trusted adapter clock.
 * @param failureCode - Failure emitted when safe headroom is unavailable.
 */
function requireImmutableArtifactRetentionHeadroom(
  retainUntilEpochMilliseconds: number,
  configuration: WorkspaceSearchMigrationConfiguration,
  requestTimeoutMilliseconds: number,
  clock: WorkspaceSearchMigrationImmutableArtifactClock,
  failureCode: ImmutableArtifactFailureCode,
): void {
  const nowEpochMilliseconds = readImmutableArtifactClock(clock)
  const minimumRetentionMilliseconds =
    configuration.journal.defaultRetentionDays *
    retentionDayMilliseconds
  const maximumRetentionMilliseconds =
    (configuration.journal.defaultRetentionDays +
      maximumAdditionalRetentionDays) *
    retentionDayMilliseconds
  const minimumHeadroomMilliseconds =
    minimumRetentionMilliseconds + requestTimeoutMilliseconds
  const retentionHeadroomMilliseconds =
    retainUntilEpochMilliseconds - nowEpochMilliseconds
  if (
    !Number.isSafeInteger(minimumRetentionMilliseconds) ||
    minimumRetentionMilliseconds <= 0 ||
    !Number.isSafeInteger(maximumRetentionMilliseconds) ||
    maximumRetentionMilliseconds <= minimumRetentionMilliseconds ||
    !Number.isSafeInteger(minimumHeadroomMilliseconds) ||
    minimumHeadroomMilliseconds > maximumRetentionMilliseconds ||
    retentionHeadroomMilliseconds < minimumHeadroomMilliseconds ||
    retentionHeadroomMilliseconds > maximumRetentionMilliseconds
  ) {
    return failImmutableArtifact(failureCode)
  }
}

/**
 * Prepares one exact-version read without retaining caller state.
 *
 * @param input - Candidate read input.
 * @param configuration - Adapter-bound measured configuration.
 * @param configurationHash - Exact configuration digest.
 * @param maximumObjectBytes - Port object ceiling.
 * @param clock - Trusted clock.
 * @returns Fully detached exact-version expectation.
 */
function prepareImmutableArtifactRead(
  input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  maximumObjectBytes: number,
  clock: WorkspaceSearchMigrationImmutableArtifactClock,
): PreparedImmutableArtifactRead {
  const record = requireImmutableArtifactRecord(
    input,
    'INVALID_ARGUMENT',
  )
  requireExactImmutableArtifactKeys(record, [
    'metadata',
    'objectKeyPrefix',
    'reference',
    'role',
  ], 'INVALID_ARGUMENT')
  const role = readArtifactRole(
    readRequiredOwnData(record, 'role', 'INVALID_ARGUMENT'),
  )
  const objectKeyPrefix = readObjectKeyPrefix(
    readRequiredOwnData(
      record,
      'objectKeyPrefix',
      'INVALID_ARGUMENT',
    ),
    configuration.journalPrefix,
  )
  const reference = snapshotImmutableArtifactReference(
    readRequiredOwnData(record, 'reference', 'INVALID_ARGUMENT'),
    maximumObjectBytes,
  )
  const expectedObjectKey =
    `${objectKeyPrefix}/${role}/${reference.contentDigest}.artifact`
  if (reference.objectKey !== expectedObjectKey) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  const retainUntilEpochMilliseconds =
    Date.parse(reference.retainUntil)
  if (
    retainUntilEpochMilliseconds <=
      readImmutableArtifactClock(clock)
  ) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  const callerMetadata = snapshotCallerMetadata(
    readRequiredOwnData(record, 'metadata', 'INVALID_ARGUMENT'),
  )
  return {
    role,
    objectKeyPrefix,
    reference,
    checksumSha256:
      createChecksumFromDigest(reference.contentDigest),
    retainUntilEpochMilliseconds,
    metadata: createImmutableArtifactMetadata(
      callerMetadata,
      role,
      configurationHash,
      reference.contentDigest,
      reference.byteLength,
      reference.retainUntil,
    ),
  }
}

/**
 * Creates the exact exclusive S3 PutObject request.
 *
 * @param configuration - Measured journal identity.
 * @param artifact - Detached immutable object material.
 * @returns Adapter-owned PutObject command.
 */
function createImmutableArtifactPutCommand(
  configuration: WorkspaceSearchMigrationConfiguration,
  artifact: PreparedImmutableArtifact,
): PutObjectCommand {
  return new PutObjectCommand({
    Bucket: configuration.journal.bucketName,
    Key: artifact.objectKey,
    Body: artifact.bytes,
    ContentLength: artifact.byteLength,
    ContentType:
      WORKSPACE_SEARCH_MIGRATION_IMMUTABLE_ARTIFACT_CONTENT_TYPE,
    ChecksumAlgorithm: 'SHA256',
    ChecksumSHA256: artifact.checksumSha256,
    IfNoneMatch: '*',
    ExpectedBucketOwner: configuration.account,
    Metadata: { ...artifact.metadata },
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: configuration.journal.keyArn,
    BucketKeyEnabled: true,
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate:
      new Date(artifact.retainUntilEpochMilliseconds),
  })
}

/**
 * Creates complete exact adapter-owned S3 user metadata.
 *
 * @param callerMetadata - Detached caller metadata.
 * @param role - Safe semantic object role.
 * @param configurationHash - Measured configuration digest.
 * @param contentDigest - Exact byte digest.
 * @param byteLength - Exact object length.
 * @param retainUntil - Exact retention deadline.
 * @returns Exact metadata expected on Head and Get.
 */
function createImmutableArtifactMetadata(
  callerMetadata: Readonly<Record<string, string>>,
  role: string,
  configurationHash: string,
  contentDigest: string,
  byteLength: number,
  retainUntil: string,
): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {
    ...callerMetadata,
    [`${immutableMetadataPrefix}role`]: role,
    [`${immutableMetadataPrefix}configuration-sha256`]:
      configurationHash,
    [`${immutableMetadataPrefix}content-sha256`]: contentDigest,
    [`${immutableMetadataPrefix}byte-length`]: String(byteLength),
    [`${immutableMetadataPrefix}retain-until`]: retainUntil,
  }
  requireMetadataBudget(metadata)
  return metadata
}

/**
 * Snapshots and validates one exact immutable reference.
 *
 * @param value - Candidate caller-owned reference.
 * @param maximumObjectBytes - Port object ceiling.
 * @returns Detached strict reference.
 */
function snapshotImmutableArtifactReference(
  value: unknown,
  maximumObjectBytes: number,
): WorkspaceSearchMigrationImmutableArtifactReference {
  const record = requireImmutableArtifactRecord(
    value,
    'INVALID_ARGUMENT',
  )
  requireExactImmutableArtifactKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ], 'INVALID_ARGUMENT')
  const objectKey = readBoundedString(
    readRequiredOwnData(record, 'objectKey', 'INVALID_ARGUMENT'),
    1,
    1_024,
    'INVALID_ARGUMENT',
  )
  const versionId = readVersionId(
    readRequiredOwnData(record, 'versionId', 'INVALID_ARGUMENT'),
    'INVALID_ARGUMENT',
  )
  const contentDigest = readDigest(
    readRequiredOwnData(
      record,
      'contentDigest',
      'INVALID_ARGUMENT',
    ),
    'INVALID_ARGUMENT',
  )
  const byteLength = readPositiveInteger(
    readRequiredOwnData(
      record,
      'byteLength',
      'INVALID_ARGUMENT',
    ),
    maximumObjectBytes,
  )
  const retainUntil = readRetentionDeadline(
    readRequiredOwnData(
      record,
      'retainUntil',
      'INVALID_ARGUMENT',
    ),
  )
  return {
    objectKey,
    versionId,
    contentDigest,
    byteLength,
    retainUntil,
  }
}

/**
 * Validates the measured configuration fields consumed by this core.
 *
 * @param configuration - Detached candidate configuration.
 */
function requireImmutableArtifactConfiguration(
  configuration: WorkspaceSearchMigrationConfiguration,
): void {
  if (
    configuration.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    configuration.migrationVersion !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    configuration.journalPrefix !== 'workspace-search/v1' ||
    !/^\d{12}$/u.test(configuration.account) ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u.test(configuration.region)
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  const journal = requireImmutableArtifactRecord(
    configuration.journal,
    'INVALID_ARGUMENT',
  )
  const bucketName = readOptionalDataProperty(journal, 'bucketName')
  const keyArn = readOptionalDataProperty(journal, 'keyArn')
  const retentionDays =
    readOptionalDataProperty(journal, 'defaultRetentionDays')
  if (
    !isValidBucketName(bucketName) ||
    !isMeasuredKmsKeyArn(
      keyArn,
      configuration.region,
      configuration.account,
    ) ||
    readOptionalDataProperty(journal, 'versioning') !== 'Enabled' ||
    readOptionalDataProperty(journal, 'objectLockMode') !==
      'COMPLIANCE' ||
    readOptionalDataProperty(journal, 'encryption') !== 'aws:kms' ||
    readOptionalDataProperty(journal, 'bucketKeyEnabled') !== true ||
    typeof retentionDays !== 'number' ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays !== 30
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
}

/**
 * Snapshots the narrow transport without invoking getters or proxy traps.
 *
 * @param value - Candidate transport.
 * @returns Detached method closures.
 */
function snapshotImmutableArtifactTransport(
  value: unknown,
): PreparedImmutableArtifactTransport {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  const put = readDataMethod(value, 'putImmutableArtifact')
  const head = readDataMethod(value, 'headImmutableArtifact')
  const get = readDataMethod(value, 'getImmutableArtifact')
  return {
    put: (command, abortSignal) =>
      Promise.resolve(Reflect.apply(
        put,
        value,
        [command, abortSignal],
      )),
    head: (command, abortSignal) =>
      Promise.resolve(Reflect.apply(
        head,
        value,
        [command, abortSignal],
      )),
    get: (command, abortSignal) =>
      Promise.resolve(Reflect.apply(
        get,
        value,
        [command, abortSignal],
      )),
  }
}

/**
 * Snapshots one trusted clock function without proxy indirection.
 *
 * @param value - Candidate clock.
 * @returns Detached invocation.
 */
function snapshotImmutableArtifactClock(
  value: unknown,
): WorkspaceSearchMigrationImmutableArtifactClock {
  if (
    typeof value !== 'function' ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  return () => Reflect.apply(value, undefined, [])
}

/**
 * Validates one native non-proxy lifecycle signal.
 *
 * @param value - Candidate one-way port lifecycle signal.
 * @returns Native AbortSignal with intact internal slots.
 */
function snapshotImmutableArtifactLifecycleSignal(
  value: unknown,
): AbortSignal {
  if (!isNativeImmutableArtifactLifecycleSignal(value)) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Recognizes AbortSignal internal slots without prototype traversal.
 *
 * @param value - Candidate lifecycle signal.
 * @returns Whether native AbortSignal intrinsics accept the value.
 */
function isNativeImmutableArtifactLifecycleSignal(
  value: unknown,
): value is AbortSignal {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  try {
    readImmutableArtifactLifecycleSignalAborted(value)
  } catch {
    return false
  }
  return true
}

/**
 * Reads one method from data descriptors along a non-proxy prototype chain.
 *
 * @param receiver - Validated method receiver.
 * @param methodName - Required method name.
 * @param code - Failure code for the current trust boundary.
 * @returns Exact callable method value.
 */
function readDataMethod(
  receiver: object | Function,
  methodName: PropertyKey,
  code: ImmutableArtifactFailureCode = 'INVALID_ARGUMENT',
): Function {
  let current: object | null = receiver
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      return failImmutableArtifact(code)
    }
    const descriptor =
      Object.getOwnPropertyDescriptor(current, methodName)
    if (descriptor !== undefined) {
      if (
        !Object.prototype.hasOwnProperty.call(
          descriptor,
          'value',
        ) ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failImmutableArtifact(code)
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
  }
  return failImmutableArtifact(code)
}

/**
 * Reads the clock through intrinsic Date operations.
 *
 * @param clock - Detached trusted clock.
 * @returns Finite nonnegative epoch milliseconds.
 */
function readImmutableArtifactClock(
  clock: WorkspaceSearchMigrationImmutableArtifactClock,
): number {
  let value: unknown
  try {
    value = clock()
  } catch {
    return failImmutableArtifact('INVALID_STATE')
  }
  if (
    nodeUtilTypes.isProxy(value) ||
    !(value instanceof Date)
  ) {
    return failImmutableArtifact('INVALID_STATE')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failImmutableArtifact('INVALID_STATE')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failImmutableArtifact('INVALID_STATE')
  }
  return epochMilliseconds
}

/**
 * Snapshots caller metadata with data properties only.
 *
 * @param value - Candidate caller metadata.
 * @returns Detached exact metadata.
 */
function snapshotCallerMetadata(
  value: unknown,
): Readonly<Record<string, string>> {
  const record = requireImmutableArtifactRecord(
    value,
    'INVALID_ARGUMENT',
  )
  const keys = readEnumerableOwnStringKeys(
    record,
    'INVALID_ARGUMENT',
  )
  const metadata: Record<string, string> = {}
  for (const key of keys) {
    if (
      key.length === 0 ||
      key.length > 128 ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(key) ||
      key.startsWith(immutableMetadataPrefix)
    ) {
      return failImmutableArtifact('INVALID_ARGUMENT')
    }
    const entry = readRequiredOwnData(
      record,
      key,
      'INVALID_ARGUMENT',
    )
    if (
      typeof entry !== 'string' ||
      entry.length > 1_024 ||
      !hasOnlyPairedSurrogates(entry)
    ) {
      return failImmutableArtifact('INVALID_ARGUMENT')
    }
    metadata[key] = entry
  }
  requireMetadataBudget(metadata)
  return metadata
}

/**
 * Requires all user metadata to fit S3's finite user-metadata budget.
 *
 * @param metadata - Exact metadata map.
 * @param code - Failure code for the current trust boundary.
 */
function requireMetadataBudget(
  metadata: Readonly<Record<string, string>>,
  code: ImmutableArtifactFailureCode = 'INVALID_ARGUMENT',
): void {
  let total = 0
  for (const [key, value] of Object.entries(metadata)) {
    total += Buffer.byteLength(key, 'utf8')
    total += Buffer.byteLength(value, 'utf8')
    if (total > maximumMetadataBytes) {
      return failImmutableArtifact(code)
    }
  }
}

/**
 * Validates one safe semantic artifact role.
 *
 * @param value - Candidate role.
 * @returns Safe role.
 */
function readArtifactRole(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Validates one codec-owned prefix below the measured journal namespace.
 *
 * @param value - Candidate prefix.
 * @param journalPrefix - Exact measured root prefix.
 * @returns Canonical safe prefix.
 */
function readObjectKeyPrefix(
  value: unknown,
  journalPrefix: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 700 ||
    !value.startsWith(`${journalPrefix}/`) ||
    value.endsWith('/')
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  const segments = value.split('/')
  if (
    segments.some((segment) =>
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment) ||
      segment === '.' ||
      segment === '..'
    )
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one canonical UTC retention deadline.
 *
 * @param value - Candidate timestamp.
 * @returns Canonical timestamp.
 */
function readRetentionDeadline(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Snapshots exact bytes using intrinsic TypedArray state.
 *
 * Proxy values, SharedArrayBuffer-backed views, and spoofed accessors are
 * rejected or ignored before any caller-controlled code can run.
 *
 * @param value - Candidate bytes.
 * @param maximumBytes - Finite operation ceiling.
 * @param code - Failure code for invalid input.
 * @returns Detached ordinary ArrayBuffer-backed bytes.
 */
function snapshotImmutableArtifactBytes(
  value: unknown,
  maximumBytes: number,
  code: ImmutableArtifactFailureCode,
): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !(value instanceof Uint8Array)
  ) {
    return failImmutableArtifact(code)
  }
  const byteLength = readIntrinsicUint8ArrayByteLength(value, code)
  const buffer = readIntrinsicUint8ArrayBuffer(value, code)
  if (
    isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength > maximumBytes
  ) {
    return failImmutableArtifact(code)
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failImmutableArtifact(code)
  }
  return copy
}

/**
 * Reads a Uint8Array's intrinsic backing buffer without own accessors.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @param code - Failure code for invalid intrinsic state.
 * @returns Intrinsic backing buffer.
 */
function readIntrinsicUint8ArrayBuffer(
  value: Uint8Array,
  code: ImmutableArtifactFailureCode,
): ArrayBufferLike {
  const typedArrayPrototype =
    Object.getPrototypeOf(Uint8Array.prototype)
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'buffer',
    )
  if (descriptor?.get === undefined) {
    return failImmutableArtifact(code)
  }
  try {
    const buffer: unknown = Reflect.apply(
      descriptor.get,
      value,
      [],
    )
    if (
      !(buffer instanceof ArrayBuffer) &&
      !isSharedArrayBuffer(buffer)
    ) {
      return failImmutableArtifact(code)
    }
    return buffer
  } catch {
    return failImmutableArtifact(code)
  }
}

/**
 * Reads a Uint8Array's intrinsic byte length without own accessors.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @param code - Failure code for invalid intrinsic state.
 * @returns Intrinsic finite byte length.
 */
function readIntrinsicUint8ArrayByteLength(
  value: Uint8Array,
  code: ImmutableArtifactFailureCode,
): number {
  const typedArrayPrototype =
    Object.getPrototypeOf(Uint8Array.prototype)
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'byteLength',
    )
  if (descriptor?.get === undefined) {
    return failImmutableArtifact(code)
  }
  try {
    const byteLength: unknown = Reflect.apply(
      descriptor.get,
      value,
      [],
    )
    if (
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength)
    ) {
      return failImmutableArtifact(code)
    }
    return byteLength
  } catch {
    return failImmutableArtifact(code)
  }
}

/**
 * Checks whether a value is a real SharedArrayBuffer.
 *
 * @param value - Candidate backing buffer.
 * @returns Whether shared mutable memory backs the view.
 */
function isSharedArrayBuffer(
  value: unknown,
): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== 'undefined' &&
    value instanceof SharedArrayBuffer
}

/**
 * Creates a lowercase SHA-256 digest of exact bytes.
 *
 * @param bytes - Detached object bytes.
 * @returns Lowercase hexadecimal digest.
 */
function digestImmutableArtifactBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Creates S3's base64 SHA-256 checksum from exact bytes.
 *
 * @param bytes - Detached object bytes.
 * @returns Base64 checksum.
 */
function createImmutableArtifactChecksumSha256(
  bytes: Uint8Array,
): string {
  return createHash('sha256').update(bytes).digest('base64')
}

/**
 * Creates S3's base64 checksum from one hexadecimal SHA-256 digest.
 *
 * @param digest - Lowercase hexadecimal digest.
 * @returns Base64 checksum.
 */
function createChecksumFromDigest(digest: string): string {
  if (!isHexDigest(digest)) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  return Buffer.from(digest, 'hex').toString('base64')
}

/**
 * Snapshots a successful PutObject version identifier.
 *
 * @param output - Raw PutObject response.
 * @returns Exact version when present.
 */
function snapshotImmutableArtifactPutVersion(
  output: PutObjectCommandOutput,
): string | undefined {
  const record = requireImmutableArtifactRecord(
    output,
    'INVALID_JOURNAL',
  )
  const value = readOptionalDataProperty(record, 'VersionId')
  return value === undefined
    ? undefined
    : readVersionId(value, 'INVALID_JOURNAL')
}

/**
 * Snapshots safe fields shared by HeadObject and GetObject.
 *
 * @param output - Raw low-level S3 output.
 * @param includeBody - Whether to retain the body value.
 * @returns Detached safe response fields.
 */
function snapshotImmutableArtifactObjectOutput(
  output: HeadObjectCommandOutput | GetObjectCommandOutput,
  includeBody: boolean,
): ImmutableArtifactObjectSnapshot {
  const record = requireImmutableArtifactRecord(
    output,
    'INVALID_JOURNAL',
  )
  const body = includeBody
    ? readOptionalDataProperty(record, 'Body')
    : undefined
  try {
    return {
      versionId: readOptionalOutputString(
        readOptionalDataProperty(record, 'VersionId'),
      ),
      contentLength: readOptionalOutputInteger(
        readOptionalDataProperty(record, 'ContentLength'),
      ),
      contentType: readOptionalOutputString(
        readOptionalDataProperty(record, 'ContentType'),
      ),
      checksumSha256: readOptionalOutputString(
        readOptionalDataProperty(record, 'ChecksumSHA256'),
      ),
      checksumType: readOptionalOutputString(
        readOptionalDataProperty(record, 'ChecksumType'),
      ),
      serverSideEncryption: readOptionalOutputString(
        readOptionalDataProperty(record, 'ServerSideEncryption'),
      ),
      sseKmsKeyId: readOptionalOutputString(
        readOptionalDataProperty(record, 'SSEKMSKeyId'),
      ),
      bucketKeyEnabled: readOptionalOutputBoolean(
        readOptionalDataProperty(record, 'BucketKeyEnabled'),
      ),
      deleteMarker: readOptionalOutputBoolean(
        readOptionalDataProperty(record, 'DeleteMarker'),
      ),
      lastModifiedEpochMilliseconds: readOptionalOutputDate(
        readOptionalDataProperty(record, 'LastModified'),
      ),
      objectLockMode: readOptionalOutputString(
        readOptionalDataProperty(record, 'ObjectLockMode'),
      ),
      retainUntilEpochMilliseconds: readOptionalOutputDate(
        readOptionalDataProperty(
          record,
          'ObjectLockRetainUntilDate',
        ),
      ),
      metadata: snapshotResponseMetadata(
        readOptionalDataProperty(record, 'Metadata'),
      ),
      body,
    }
  } catch (error: unknown) {
    if (includeBody) {
      cancelImmutableArtifactBody(body, body)
    }
    throw error
  }
}

/**
 * Requires every stored object field to match the exact expectation.
 *
 * @param snapshot - Detached Head/Get response.
 * @param reference - Exact expected immutable reference.
 * @param checksumSha256 - Expected base64 checksum.
 * @param retainUntilEpochMilliseconds - Exact expected retention time.
 * @param metadata - Exact expected metadata.
 * @param configuration - Measured journal identity.
 */
function requireImmutableArtifactObjectMatches(
  snapshot: ImmutableArtifactObjectSnapshot,
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
  checksumSha256: string,
  retainUntilEpochMilliseconds: number,
  metadata: Readonly<Record<string, string>>,
  configuration: WorkspaceSearchMigrationConfiguration,
): void {
  const minimumRetentionMilliseconds =
    configuration.journal.defaultRetentionDays *
    retentionDayMilliseconds
  const maximumRetentionMilliseconds =
    (configuration.journal.defaultRetentionDays +
      maximumAdditionalRetentionDays) *
    retentionDayMilliseconds
  const storedRetentionMilliseconds =
    snapshot.lastModifiedEpochMilliseconds === undefined
      ? Number.NaN
      : retainUntilEpochMilliseconds -
        snapshot.lastModifiedEpochMilliseconds
  if (
    snapshot.versionId !== reference.versionId ||
    snapshot.contentLength !== reference.byteLength ||
    snapshot.contentType !==
      WORKSPACE_SEARCH_MIGRATION_IMMUTABLE_ARTIFACT_CONTENT_TYPE ||
    snapshot.checksumSha256 !== checksumSha256 ||
    (snapshot.checksumType !== undefined &&
      snapshot.checksumType !== 'FULL_OBJECT') ||
    snapshot.serverSideEncryption !== 'aws:kms' ||
    snapshot.sseKmsKeyId !== configuration.journal.keyArn ||
    snapshot.bucketKeyEnabled !== true ||
    snapshot.deleteMarker === true ||
    !Number.isSafeInteger(storedRetentionMilliseconds) ||
    storedRetentionMilliseconds < minimumRetentionMilliseconds ||
    storedRetentionMilliseconds > maximumRetentionMilliseconds ||
    snapshot.objectLockMode !== 'COMPLIANCE' ||
    snapshot.retainUntilEpochMilliseconds !==
      retainUntilEpochMilliseconds ||
    !metadataMapsEqual(snapshot.metadata, metadata)
  ) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
}

/**
 * Reads and validates an exact required version identifier.
 *
 * @param value - Candidate version.
 * @returns Valid exact version.
 */
function readRequiredImmutableArtifactVersion(
  value: string | undefined,
): string {
  return readVersionId(value, 'INVALID_JOURNAL')
}

/**
 * Reads one valid non-null S3 version identifier.
 *
 * @param value - Candidate version.
 * @param code - Failure code.
 * @returns Valid version.
 */
function readVersionId(
  value: unknown,
  code: ImmutableArtifactFailureCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value === 'null' ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failImmutableArtifact(code)
  }
  return value
}

/**
 * Reads one optional output string.
 *
 * @param value - Candidate field.
 * @returns String or undefined.
 */
function readOptionalOutputString(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  return value
}

/**
 * Reads one optional output Boolean.
 *
 * @param value - Candidate field.
 * @returns Boolean or undefined.
 */
function readOptionalOutputBoolean(
  value: unknown,
): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  return value
}

/**
 * Reads one optional nonnegative safe output integer.
 *
 * @param value - Candidate field.
 * @returns Integer or undefined.
 */
function readOptionalOutputInteger(
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  return value
}

/**
 * Reads one optional non-proxy Date using its intrinsic slot.
 *
 * @param value - Candidate field.
 * @returns Epoch milliseconds or undefined.
 */
function readOptionalOutputDate(
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined
  if (nodeUtilTypes.isProxy(value) || !(value instanceof Date)) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  return epochMilliseconds
}

/**
 * Snapshots exact S3 response metadata with data properties only.
 *
 * @param value - Candidate metadata response.
 * @returns Detached metadata or undefined.
 */
function snapshotResponseMetadata(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const record = requireImmutableArtifactRecord(
    value,
    'INVALID_JOURNAL',
  )
  const keys = readEnumerableOwnStringKeys(
    record,
    'INVALID_JOURNAL',
  )
  const metadata: Record<string, string> = {}
  for (const key of keys) {
    if (
      key.length === 0 ||
      key.length > 128 ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(key)
    ) {
      return failImmutableArtifact('INVALID_JOURNAL')
    }
    const entry = readRequiredOwnData(
      record,
      key,
      'INVALID_JOURNAL',
    )
    if (
      typeof entry !== 'string' ||
      entry.length > 1_024 ||
      !hasOnlyPairedSurrogates(entry)
    ) {
      return failImmutableArtifact('INVALID_JOURNAL')
    }
    metadata[key] = entry
  }
  requireMetadataBudget(metadata, 'INVALID_JOURNAL')
  return metadata
}

/**
 * Checks exact equality of two metadata maps.
 *
 * @param actual - Stored response metadata.
 * @param expected - Exact adapter expectation.
 * @returns Whether both maps contain exactly the same entries.
 */
function metadataMapsEqual(
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (actual === undefined) return false
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) =>
      key === expectedKeys[index] &&
      actual[key] === expected[key]
    )
}

/**
 * Reads one exact bounded S3 body.
 *
 * @param body - Candidate Uint8Array or async iterable body.
 * @param expectedLength - Exact expected byte length.
 * @param maximumBytes - Port object ceiling.
 * @param timeoutMilliseconds - Body deadline.
 * @param lifecycleSignal - One-way port lifecycle cancellation.
 * @returns Detached exact bytes.
 */
async function readBoundedImmutableArtifactBody(
  body: unknown,
  expectedLength: number,
  maximumBytes: number,
  timeoutMilliseconds: number,
  lifecycleSignal: AbortSignal,
): Promise<Uint8Array> {
  let iterator: ImmutableArtifactAsyncIterator | undefined
  try {
    if (readImmutableArtifactLifecycleSignalAborted(lifecycleSignal)) {
      throw new ImmutableArtifactFailure('INVALID_STATE')
    }
    if (
      !Number.isSafeInteger(expectedLength) ||
      expectedLength <= 0 ||
      expectedLength > maximumBytes
    ) {
      return failImmutableArtifact('INVALID_JOURNAL')
    }
    if (
      !nodeUtilTypes.isProxy(body) &&
      body instanceof Uint8Array
    ) {
      const bytes = snapshotImmutableArtifactBytes(
        body,
        maximumBytes,
        'INVALID_JOURNAL',
      )
      if (bytes.byteLength !== expectedLength) {
        return failImmutableArtifact('INVALID_JOURNAL')
      }
      return bytes
    }
    const preparedIterator = snapshotAsyncByteIterator(body)
    iterator = preparedIterator
    return await runWithImmutableArtifactDeadline(
      () => readBoundedImmutableArtifactIterator(
        preparedIterator.receiver,
        preparedIterator.next,
        expectedLength,
        maximumBytes,
      ),
      timeoutMilliseconds,
      lifecycleSignal,
    )
  } catch (error: unknown) {
    cancelImmutableArtifactBody(
      iterator?.receiver ?? body,
      body,
    )
    if (
      !nodeUtilTypes.isProxy(error) &&
      error instanceof ImmutableArtifactFailure
    ) {
      throw error
    }
    if (isImmutableArtifactRetryableFailure(error)) {
      return failImmutableArtifact(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
      )
    }
    return failImmutableArtifact('INVALID_JOURNAL')
  }
}

/**
 * Detached async iterator receiver and next method.
 */
type ImmutableArtifactAsyncIterator = {
  /** Iterator receiver. */
  readonly receiver: object | Function
  /** Detached next method. */
  readonly next: Function
}

/**
 * Snapshots an async iterator without invoking accessors or proxies.
 *
 * @param body - Candidate async iterable.
 * @returns Detached iterator receiver and method.
 */
function snapshotAsyncByteIterator(
  body: unknown,
): ImmutableArtifactAsyncIterator {
  if (
    (typeof body !== 'object' && typeof body !== 'function') ||
    body === null ||
    nodeUtilTypes.isProxy(body)
  ) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  const iteratorMethod = readDataMethod(
    body,
    Symbol.asyncIterator,
    'INVALID_JOURNAL',
  )
  let iterator: unknown
  try {
    iterator = Reflect.apply(iteratorMethod, body, [])
  } catch {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  if (
    (typeof iterator !== 'object' &&
      typeof iterator !== 'function') ||
    iterator === null ||
    nodeUtilTypes.isProxy(iterator)
  ) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  let next: Function
  try {
    next = readDataMethod(iterator, 'next', 'INVALID_JOURNAL')
  } catch (error: unknown) {
    if (iterator !== body) {
      invokeCancellationMethod(iterator, 'return')
    }
    throw error
  }
  return {
    receiver: iterator,
    next,
  }
}

/**
 * Consumes one validated async iterator into one exact allocation.
 *
 * @param iterator - Detached iterator receiver.
 * @param next - Detached next method.
 * @param expectedLength - Exact expected body length.
 * @param maximumBytes - Port object ceiling.
 * @returns Detached exact bytes.
 */
async function readBoundedImmutableArtifactIterator(
  iterator: object | Function,
  next: Function,
  expectedLength: number,
  maximumBytes: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(expectedLength)
  let offset = 0
  while (true) {
    const result: unknown = await Reflect.apply(next, iterator, [])
    const record = requireImmutableArtifactRecord(
      result,
      'INVALID_JOURNAL',
    )
    const done = readOptionalDataProperty(record, 'done')
    if (done === true) break
    if (done !== false && done !== undefined) {
      return failImmutableArtifact('INVALID_JOURNAL')
    }
    const chunk = snapshotImmutableArtifactBytes(
      readRequiredOwnData(record, 'value', 'INVALID_JOURNAL'),
      maximumBytes,
      'INVALID_JOURNAL',
    )
    if (
      offset + chunk.byteLength > expectedLength ||
      offset + chunk.byteLength > maximumBytes
    ) {
      return failImmutableArtifact('INVALID_JOURNAL')
    }
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (offset !== expectedLength) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  return bytes
}

/**
 * Best-effort cancels an iterator and underlying body.
 *
 * @param iterator - Iterator receiver.
 * @param body - Underlying body.
 */
function cancelImmutableArtifactBody(
  iterator: unknown,
  body: unknown,
): void {
  invokeCancellationMethod(iterator, 'return')
  invokeCancellationMethod(body, 'destroy')
  invokeCancellationMethod(body, 'cancel')
}

/**
 * Invokes one optional data-method cancellation hook.
 *
 * @param target - Candidate cleanup receiver.
 * @param name - Allowlisted cleanup method.
 */
function invokeCancellationMethod(
  target: unknown,
  name: 'cancel' | 'destroy' | 'return',
): void {
  try {
    if (
      (typeof target !== 'object' &&
        typeof target !== 'function') ||
      target === null ||
      nodeUtilTypes.isProxy(target)
    ) {
      return
    }
    const method = readOptionalDataMethod(target, name)
    if (method === undefined) return
    const result: unknown = Reflect.apply(method, target, [])
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // The original validation or timeout failure remains authoritative.
  }
}

/**
 * Runs one asynchronous operation behind a finite deadline.
 *
 * @param operation - Operation started immediately with its deadline signal.
 * @param timeoutMilliseconds - Validated finite deadline.
 * @param lifecycleSignal - One-way port lifecycle cancellation.
 * @returns Operation result before the deadline.
 */
async function runWithImmutableArtifactDeadline<Result>(
  operation: (abortSignal: AbortSignal) => Promise<Result>,
  timeoutMilliseconds: number,
  lifecycleSignal: AbortSignal,
): Promise<Result> {
  if (readImmutableArtifactLifecycleSignalAborted(lifecycleSignal)) {
    throw new ImmutableArtifactFailure('INVALID_STATE')
  }
  const abortController = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutResult = new Promise<Result>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new ImmutableArtifactTimeout())
      abortController.abort()
    }, timeoutMilliseconds)
  })
  let lifecycleAbortHandler: (() => void) | undefined
  let lifecycleAborted = false
  const lifecycleAbortResult = new Promise<Result>((_resolve, reject) => {
    lifecycleAbortHandler = () => {
      if (lifecycleAborted) return
      lifecycleAborted = true
      reject(new ImmutableArtifactFailure('INVALID_STATE'))
      abortController.abort()
    }
    addImmutableArtifactLifecycleAbortListener(
      lifecycleSignal,
      lifecycleAbortHandler,
    )
    if (readImmutableArtifactLifecycleSignalAborted(lifecycleSignal)) {
      lifecycleAbortHandler()
    }
  })
  try {
    return await Promise.race([
      Promise.resolve().then(
        () => operation(abortController.signal),
      ),
      timeoutResult,
      lifecycleAbortResult,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (lifecycleAbortHandler !== undefined) {
      removeImmutableArtifactLifecycleAbortListener(
        lifecycleSignal,
        lifecycleAbortHandler,
      )
    }
  }
}

/**
 * Reads native AbortSignal state without invoking caller-owned accessors.
 *
 * @param signal - Validated native lifecycle signal.
 * @returns Whether the signal has permanently aborted.
 */
function readImmutableArtifactLifecycleSignalAborted(
  signal: object | Function,
): boolean {
  const descriptor = Reflect.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  )
  const getter = descriptor?.get
  if (getter === undefined) {
    throw new Error('AbortSignal aborted getter is unavailable.')
  }
  return Reflect.apply(getter, signal, []) === true
}

/**
 * Registers one abort listener through the native EventTarget method.
 *
 * @param signal - Validated native lifecycle signal.
 * @param listener - Fixed lifecycle callback.
 */
function addImmutableArtifactLifecycleAbortListener(
  signal: AbortSignal,
  listener: () => void,
): void {
  Reflect.apply(
    EventTarget.prototype.addEventListener,
    signal,
    ['abort', listener, { once: true }],
  )
}

/**
 * Removes one abort listener through the native EventTarget method.
 *
 * @param signal - Validated native lifecycle signal.
 * @param listener - Previously registered lifecycle callback.
 */
function removeImmutableArtifactLifecycleAbortListener(
  signal: AbortSignal,
  listener: () => void,
): void {
  Reflect.apply(
    EventTarget.prototype.removeEventListener,
    signal,
    ['abort', listener],
  )
}

/**
 * Detects one exclusive-create precondition failure.
 *
 * @param error - Candidate raw transport error.
 * @returns Whether S3 proved a current object exists.
 */
function isImmutableArtifactPreconditionFailure(
  error: unknown,
): boolean {
  try {
    return readErrorName(error) === 'PreconditionFailed' ||
      readErrorHttpStatus(error) === 412
  } catch {
    return false
  }
}

/**
 * Detects a write whose success is ambiguous.
 *
 * @param error - Candidate raw transport error.
 * @returns Whether exact Head reconciliation is required.
 */
function isImmutableArtifactAmbiguousWriteFailure(
  error: unknown,
): boolean {
  try {
    const status = readErrorHttpStatus(error)
    return status === 409 ||
      (status !== undefined && status >= 500) ||
      isImmutableArtifactRetryableFailure(error)
  } catch {
    return false
  }
}

/**
 * Detects a HeadObject response that proves the selected object is absent.
 *
 * @param error - Candidate raw S3 error.
 * @returns Whether S3 returned a recognized absence response.
 */
function isImmutableArtifactNotFound(error: unknown): boolean {
  try {
    const name = readErrorName(error)
    return readErrorHttpStatus(error) === 404 ||
      name === 'NoSuchKey' ||
      name === 'NotFound' ||
      name === 'NoSuchVersion'
  } catch {
    return false
  }
}

/**
 * Classifies a raw error through a detached secret-free Smithy input.
 *
 * @param error - Candidate raw error.
 * @returns Whether the failure is retryable.
 */
function isImmutableArtifactRetryableFailure(
  error: unknown,
): boolean {
  try {
    if (
      nodeUtilTypes.isProxy(error) ||
      !(error instanceof Error)
    ) {
      return false
    }
    const input = createAwsErrorClassificationInput(error)
    return isThrottlingError(input) || isTransientError(input)
  } catch {
    return false
  }
}

/**
 * Reads one stable error name through data descriptors only.
 *
 * @param error - Candidate raw error.
 * @returns Stable name or undefined.
 */
function readErrorName(error: unknown): string | undefined {
  const value = readOptionalPropertyWithoutAccessors(error, 'name')
  return typeof value === 'string' ? value : undefined
}

/**
 * Reads one numeric HTTP status through data descriptors only.
 *
 * @param error - Candidate raw error.
 * @returns Finite status or undefined.
 */
function readErrorHttpStatus(error: unknown): number | undefined {
  const metadata =
    readOptionalPropertyWithoutAccessors(error, '$metadata')
  const value = readOptionalPropertyWithoutAccessors(
    metadata,
    'httpStatusCode',
  )
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

/**
 * Creates a secret-free Smithy classifier input.
 *
 * @param error - Raw error.
 * @param depth - Bounded cause depth.
 * @returns Detached classifier input.
 */
function createAwsErrorClassificationInput(
  error: Error,
  depth = 0,
): ImmutableArtifactAwsErrorClassificationInput {
  const name = readOptionalPropertyWithoutAccessors(error, 'name')
  const code = readOptionalPropertyWithoutAccessors(error, 'code')
  const retryable =
    readOptionalPropertyWithoutAccessors(error, '$retryable')
  const cause = depth <= 10
    ? readOptionalPropertyWithoutAccessors(error, 'cause')
    : undefined
  const status = readErrorHttpStatus(error)
  const throttling = readOptionalPropertyWithoutAccessors(
    retryable,
    'throttling',
  )
  const hasRetryable =
    typeof retryable === 'object' && retryable !== null
  return {
    name: typeof name === 'string' ? name : '',
    message: '',
    ...(typeof code === 'string' ? { code } : {}),
    ...(status === undefined
      ? {}
      : { $metadata: { httpStatusCode: status } }),
    ...(hasRetryable
      ? {
          $retryable:
            typeof throttling === 'boolean'
              ? { throttling }
              : {},
        }
      : {}),
    ...(!nodeUtilTypes.isProxy(cause) && cause instanceof Error
      ? {
          cause: createAwsErrorClassificationInput(
            cause,
            depth + 1,
          ),
        }
      : {}),
  }
}

/**
 * Reads a property without invoking getters or proxy traps.
 *
 * @param value - Candidate receiver.
 * @param property - Property key.
 * @returns Data value or undefined.
 */
function readOptionalPropertyWithoutAccessors(
  value: unknown,
  property: PropertyKey,
): unknown {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return undefined
  }
  let current: object | null = value
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) return undefined
    const descriptor =
      Object.getOwnPropertyDescriptor(current, property)
    if (descriptor !== undefined) {
      return Object.prototype.hasOwnProperty.call(
          descriptor,
          'value',
        )
        ? descriptor.value
        : undefined
    }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

/**
 * Requires one non-array, non-proxy record.
 *
 * @param value - Candidate record.
 * @param code - Failure code.
 * @returns Safe object for descriptor reads.
 */
function requireImmutableArtifactRecord(
  value: unknown,
  code: ImmutableArtifactFailureCode,
): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failImmutableArtifact(code)
  }
  return value
}

/**
 * Requires exactly the declared enumerable own string data properties.
 *
 * @param value - Validated record.
 * @param expected - Exact accepted keys.
 * @param code - Failure code.
 */
function requireExactImmutableArtifactKeys(
  value: object,
  expected: readonly string[],
  code: ImmutableArtifactFailureCode,
): void {
  const keys = readEnumerableOwnStringKeys(value, code).sort()
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failImmutableArtifact(code)
  }
}

/**
 * Reads enumerable own string keys while rejecting symbols and hidden fields.
 *
 * @param value - Validated non-proxy object.
 * @param code - Failure code.
 * @returns Enumerable own keys.
 */
function readEnumerableOwnStringKeys(
  value: object,
  code: ImmutableArtifactFailureCode,
): string[] {
  const ownKeys = Reflect.ownKeys(value)
  const keys = Object.keys(value)
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length
  ) {
    return failImmutableArtifact(code)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failImmutableArtifact(code)
    }
  }
  return keys
}

/**
 * Reads one required enumerable own data property.
 *
 * @param value - Validated record.
 * @param key - Required key.
 * @param code - Failure code.
 * @returns Exact data value.
 */
function readRequiredOwnData(
  value: object,
  key: string,
  code: ImmutableArtifactFailureCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failImmutableArtifact(code)
  }
  return descriptor.value
}

/**
 * Reads one optional own data property, rejecting accessors.
 *
 * @param value - Validated record.
 * @param key - Optional key.
 * @returns Exact data value or undefined.
 */
function readOptionalDataProperty(
  value: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return failImmutableArtifact('INVALID_JOURNAL')
  }
  return descriptor.value
}

/**
 * Reads one optional method through data descriptors.
 *
 * @param value - Candidate receiver.
 * @param name - Method name.
 * @returns Callable method or undefined.
 */
function readOptionalDataMethod(
  value: object | Function,
  name: string,
): Function | undefined {
  let current: object | null = value
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
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
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

/**
 * Requires a bounded graph of plain data properties before cloning config.
 *
 * @param value - Candidate configuration graph.
 * @param depth - Current recursion depth.
 * @param seen - Objects already inspected.
 */
function requireBoundedPlainDataGraph(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set<object>(),
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === undefined
  ) {
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    depth > 32 ||
    seen.size > 10_000
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  if (seen.has(value)) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    if (
      !hasCanonicalDenseArrayShape(value) ||
      value.length > 10_000
    ) {
      return failImmutableArtifact('INVALID_ARGUMENT')
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor =
        Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(
          descriptor,
          'value',
        )
      ) {
        return failImmutableArtifact('INVALID_ARGUMENT')
      }
      requireBoundedPlainDataGraph(
        descriptor.value,
        depth + 1,
        seen,
      )
    }
    seen.delete(value)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  const keys = readEnumerableOwnStringKeys(
    value,
    'INVALID_ARGUMENT',
  )
  if (keys.length > 1_000) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  for (const key of keys) {
    requireBoundedPlainDataGraph(
      readRequiredOwnData(value, key, 'INVALID_ARGUMENT'),
      depth + 1,
      seen,
    )
  }
  seen.delete(value)
}

/**
 * Reads one bounded string with paired surrogates.
 *
 * @param value - Candidate string.
 * @param minimumLength - Minimum length.
 * @param maximumLength - Maximum length.
 * @param code - Failure code.
 * @returns Valid string.
 */
function readBoundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  code: ImmutableArtifactFailureCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failImmutableArtifact(code)
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param code - Failure code.
 * @returns Valid digest.
 */
function readDigest(
  value: unknown,
  code: ImmutableArtifactFailureCode,
): string {
  if (!isHexDigest(value)) {
    return failImmutableArtifact(code)
  }
  return value
}

/**
 * Reads one positive safe integer up to a fixed maximum.
 *
 * @param value - Candidate number.
 * @param maximum - Inclusive maximum.
 * @returns Valid positive integer.
 */
function readPositiveInteger(
  value: unknown,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    return failImmutableArtifact('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Checks one canonical general-purpose S3 bucket name.
 *
 * @param value - Candidate bucket name.
 * @returns Whether the value is a safe physical bucket name.
 */
function isValidBucketName(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) ||
    value.includes('..') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)
  ) {
    return false
  }
  return value.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  )
}

/**
 * Checks one exact measured KMS key ARN across official partitions.
 *
 * @param value - Candidate key ARN.
 * @param region - Exact configured region.
 * @param account - Exact configured account.
 * @returns Whether the ARN selects one physical KMS key.
 */
function isMeasuredKmsKeyArn(
  value: unknown,
  region: string,
  account: string,
): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split(':')
  const partition = parts[1]
  const resource = parts[5]
  return parts.length === 6 &&
    parts[0] === 'arn' &&
    typeof partition === 'string' &&
    /^aws(?:-[a-z0-9]+)*$/u.test(partition) &&
    parts[2] === 'kms' &&
    parts[3] === region &&
    parts[4] === account &&
    typeof resource === 'string' &&
    /^key\/[A-Za-z0-9][A-Za-z0-9/_-]{0,255}$/u.test(resource)
}

/**
 * Runs one public operation behind a raw-error replacement boundary.
 *
 * @param operation - Validation and bounded S3 operation.
 * @returns Successful detached result.
 */
async function runImmutableArtifactBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createImmutableArtifactBoundaryFailure(
      readImmutableArtifactFailureCode(error),
    )
  }
}

/**
 * Reads one trusted or safely classified failure code.
 *
 * @param error - Arbitrary thrown value.
 * @param fallback - Fail-closed fallback.
 * @returns Stable public migration failure code.
 */
function readImmutableArtifactFailureCode(
  error: unknown,
  fallback: WorkspaceSearchMigrationFailureCode = 'INVALID_STATE',
): WorkspaceSearchMigrationFailureCode {
  try {
    if (
      !nodeUtilTypes.isProxy(error) &&
      error instanceof ImmutableArtifactFailure
    ) {
      return error.code
    }
    if (isImmutableArtifactRetryableFailure(error)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return fallback
  } catch {
    return fallback
  }
}

/**
 * Raises one private immutable-object failure.
 *
 * @param code - Stable private code.
 * @returns Never returns.
 */
function failImmutableArtifact(
  code: ImmutableArtifactFailureCode,
): never {
  throw new ImmutableArtifactFailure(code)
}

/**
 * Creates one fixed-message public failure without raw values.
 *
 * @param code - Stable public code.
 * @returns Fresh secret-free migration failure.
 */
function createImmutableArtifactBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search immutable artifact stopped safely (${code}).`,
  )
}
