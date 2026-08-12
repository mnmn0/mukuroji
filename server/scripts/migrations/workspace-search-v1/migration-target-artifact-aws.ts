import { createHash } from 'node:crypto'
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
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactContentDigest,
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
  parseWorkspaceSearchMigrationPlanningTargetArtifactPage,
  parseWorkspaceSearchMigrationPlanningTargetArtifactSegment,
  serializeWorkspaceSearchMigrationPlanningTargetArtifactPage,
  serializeWorkspaceSearchMigrationPlanningTargetArtifactSegment,
  type WorkspaceSearchMigrationPlanningTargetArtifactAuthority,
  type WorkspaceSearchMigrationPlanningTargetArtifactEncodedSegment,
  type WorkspaceSearchMigrationPlanningTargetArtifactPage,
  type WorkspaceSearchMigrationPlanningTargetArtifactReference,
  type WorkspaceSearchMigrationPlanningTargetArtifactSegment,
  type WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation,
  WorkspaceSearchMigrationTargetArtifactError,
  WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
} from './migration-target-artifact'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

export {
  WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-target-artifact'

const targetArtifactContentType = 'application/json'
const targetArtifactKind =
  'workspace-search-planning-target-artifact-segment'
const targetArtifactMaximumRetryCount = 1
/**
 * Body-consumption deadline after the SDK request has returned its response.
 *
 * A version-pinned GET can therefore spend about ten seconds acquiring the
 * response and another ten seconds consuming one segment body.
 */
const targetArtifactBodyTimeoutMilliseconds = 10_000

/**
 * Narrow S3 command transport used by the immutable target-artifact adapter.
 */
export interface WorkspaceSearchMigrationTargetArtifactAwsTransport {
  /**
   * Sends one exclusive immutable object upload.
   *
   * @param command - Adapter-owned conditional PutObject command.
   * @returns Raw low-level S3 response.
   */
  putTargetArtifact(
    command: PutObjectCommand,
  ): Promise<PutObjectCommandOutput>

  /**
   * Reads exact metadata for one current or version-pinned object.
   *
   * @param command - Adapter-owned HeadObject command.
   * @returns Raw low-level S3 metadata response.
   */
  headTargetArtifact(
    command: HeadObjectCommand,
  ): Promise<HeadObjectCommandOutput>

  /**
   * Reads one exact immutable object version.
   *
   * @param command - Adapter-owned version-pinned GetObject command.
   * @returns Raw low-level S3 object response.
   */
  getTargetArtifact(
    command: GetObjectCommand,
  ): Promise<GetObjectCommandOutput>
}

/**
 * Dependencies that bind one target-artifact port to measured AWS resources.
 */
export type CreateWorkspaceSearchMigrationTargetArtifactAwsPortInput = {
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Narrow S3 transport sharing the measured AWS session. */
  readonly transport: WorkspaceSearchMigrationTargetArtifactAwsTransport
}

/**
 * Common page identity required to verify stored target-artifact segments.
 */
export type WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext = {
  /** Operator-selected migration run identifier. */
  readonly runId: string
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Exact measured physical Workspace Search target-table incarnation. */
  readonly targetTable:
    WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
  /** Exact measured physical migration-state table incarnation. */
  readonly stateTable:
    WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
  /** One-based position in the durable planning evidence chain. */
  readonly pageSequence: number
  /** Digest of the preceding planning evidence page. */
  readonly previousEvidenceDigest: string
  /** Digest of the exact predecessor checkpoint. */
  readonly previousCheckpointDigest: string
  /** Exact compact planning authority authorizing this page. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningTargetArtifactAuthority
}

/**
 * Input for storing one complete lossless planning target page.
 */
export type WriteWorkspaceSearchMigrationPlanningTargetArtifactPageInput = {
  /** Complete validated page whose canonical segments must be stored. */
  readonly expectedPage:
    WorkspaceSearchMigrationPlanningTargetArtifactPage
}

/**
 * Input for reading and reconstructing one stored planning target page.
 */
export type ReadWorkspaceSearchMigrationPlanningTargetArtifactPageInput = {
  /** Exact expected page identity without raw target items or a cursor. */
  readonly expectedPage:
    WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext
  /** Ordered exact immutable S3 versions committed by planning evidence. */
  readonly references:
    readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[]
}

/**
 * Immutable lossless planning-target storage operations.
 */
export interface WorkspaceSearchMigrationTargetArtifactAwsPort {
  /**
   * Stores every deterministic segment of one complete target page.
   *
   * @param input - Complete expected page including exact raw target items.
   * @returns Ordered exact S3 object-version references.
   */
  writePlanningTargetArtifactPage(
    input: WriteWorkspaceSearchMigrationPlanningTargetArtifactPageInput,
  ): Promise<
    readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[]
  >

  /**
   * Reads exact versions and reconstructs one complete target page.
   *
   * @param input - Expected common page identity and ordered S3 references.
   * @returns Strictly parsed complete lossless target page.
   */
  readPlanningTargetArtifactPage(
    input: ReadWorkspaceSearchMigrationPlanningTargetArtifactPageInput,
  ): Promise<WorkspaceSearchMigrationPlanningTargetArtifactPage>
}

/**
 * Failure codes deliberately emitted by the private S3 adapter.
 */
type TargetArtifactAwsFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_TARGET_ARTIFACT'
  | 'INVALID_STATE'
  | 'TARGET_ARTIFACT_WRITE_FAILED'
  | 'TRANSIENT_INFRASTRUCTURE_FAILURE'

/**
 * Secret-free structural AWS error supplied only to Smithy's classifiers.
 */
type TargetArtifactAwsErrorClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout error code. */
    readonly code?: string
  }

/**
 * Private fixed-code failure that cannot be forged by hostile input.
 */
class TargetArtifactAwsFailure extends Error {
  /** Stable secret-free code chosen inside the trusted adapter. */
  readonly code: TargetArtifactAwsFailureCode

  /**
   * Creates one privately branded adapter failure.
   *
   * @param code - Stable secret-free failure code.
   */
  constructor(code: TargetArtifactAwsFailureCode) {
    super(code)
    this.name = 'TargetArtifactAwsFailure'
    this.code = code
  }
}

/**
 * Fixed secret-free timeout raised when an S3 body stops making progress.
 */
class TargetArtifactBodyTimeout extends Error {
  /** Node.js timeout code recognized by Smithy's transient classifier. */
  readonly code = 'ETIMEDOUT'

  /**
   * Creates one classifier-compatible bounded-body timeout.
   */
  constructor() {
    super('Target artifact body timed out.')
    this.name = 'TimeoutError'
  }
}

/**
 * Detached configuration and transport retained by one adapter instance.
 */
type PreparedTargetArtifactAwsPortInput = {
  /** Detached exact measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Exact measured configuration digest. */
  readonly configurationHash: string
  /** Validated narrow S3 transport. */
  readonly transport: WorkspaceSearchMigrationTargetArtifactAwsTransport
}

/**
 * Detached canonical segment ready for an exact S3 request.
 */
type PreparedTargetArtifactSegment = {
  /** Strict parsed canonical segment. */
  readonly segment: WorkspaceSearchMigrationPlanningTargetArtifactSegment
  /** Detached exact canonical bytes. */
  readonly bytes: Uint8Array
  /** Lowercase SHA-256 digest of the exact bytes. */
  readonly contentDigest: string
  /** Base64 SHA-256 checksum sent to and read from S3. */
  readonly checksumSha256: string
  /** Exact canonical byte length. */
  readonly byteLength: number
  /** Deterministic secret-free content-addressed key. */
  readonly objectKey: string
  /** Exact safe metadata owned by this adapter. */
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Result of a current-object reconciliation read.
 */
type TargetArtifactHeadResult =
  | {
      /** Indicates that the current object is absent. */
      readonly exists: false
    }
  | {
      /** Indicates that an exact immutable object exists. */
      readonly exists: true
      /** Exact immutable S3 reference recovered from metadata. */
      readonly reference:
        WorkspaceSearchMigrationPlanningTargetArtifactReference
    }

/**
 * Safe subset of S3 object response metadata.
 */
type TargetArtifactObjectSnapshot = {
  /** Exact returned object version, when present. */
  readonly versionId: string | undefined
  /** Exact object byte length, when present. */
  readonly contentLength: number | undefined
  /** Exact media type, when present. */
  readonly contentType: string | undefined
  /** Stored SHA-256 checksum, when requested. */
  readonly checksumSha256: string | undefined
  /** Stored checksum composition type, when present. */
  readonly checksumType: string | undefined
  /** Server-side encryption family, when present. */
  readonly serverSideEncryption: string | undefined
  /** Exact KMS key locator, when present. */
  readonly sseKmsKeyId: string | undefined
  /** Whether S3 Bucket Keys were used, when present. */
  readonly bucketKeyEnabled: boolean | undefined
  /** Whether the response represents a delete marker. */
  readonly deleteMarker: boolean | undefined
  /** Exact object modification epoch milliseconds, when present. */
  readonly lastModifiedEpochMilliseconds: number | undefined
  /** Exact S3 Object Lock retention mode, when present. */
  readonly objectLockMode: string | undefined
  /** Exact Object Lock retention deadline epoch milliseconds, when present. */
  readonly objectLockRetainUntilEpochMilliseconds:
    number | undefined
  /** Detached user-defined metadata, when present. */
  readonly metadata: Readonly<Record<string, string>> | undefined
  /** Streaming object body, when present. */
  readonly body: unknown
}

/**
 * Creates a target-artifact adapter bound to one measured configuration.
 *
 * @param input - Exact measured configuration and narrow S3 transport.
 * @returns Immutable target-artifact port.
 */
export function createAwsWorkspaceSearchMigrationTargetArtifactPort(
  input: CreateWorkspaceSearchMigrationTargetArtifactAwsPortInput,
): WorkspaceSearchMigrationTargetArtifactAwsPort {
  try {
    const prepared = prepareTargetArtifactAwsPortInput(input)
    return new AwsWorkspaceSearchMigrationTargetArtifactPort(prepared)
  } catch (error: unknown) {
    throw createTargetArtifactAwsBoundaryFailure(
      readTargetArtifactAwsFailureCode(error, 'INVALID_ARGUMENT'),
    )
  }
}

/**
 * S3 adapter for immutable lossless planning-target segments.
 */
class AwsWorkspaceSearchMigrationTargetArtifactPort
  implements WorkspaceSearchMigrationTargetArtifactAwsPort {
  /** Detached exact measured configuration. */
  private readonly configuration: WorkspaceSearchMigrationConfiguration

  /** Digest of the detached measured configuration. */
  private readonly configurationHash: string

  /** Narrow S3 transport sharing the measured AWS session. */
  private readonly transport: WorkspaceSearchMigrationTargetArtifactAwsTransport

  /**
   * Creates an already validated target-artifact adapter.
   *
   * @param input - Detached exact configuration and transport.
   */
  constructor(input: PreparedTargetArtifactAwsPortInput) {
    this.configuration = input.configuration
    this.configurationHash = input.configurationHash
    this.transport = input.transport
  }

  /**
   * Stores every deterministic segment of one complete target page.
   *
   * @param input - Complete expected page including raw target items.
   * @returns Ordered exact immutable S3 version references.
   */
  async writePlanningTargetArtifactPage(
    input: WriteWorkspaceSearchMigrationPlanningTargetArtifactPageInput,
  ): Promise<
    readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[]
  > {
    return runTargetArtifactAwsBoundary(async () => {
      const segments = prepareTargetArtifactWriteInput(
        input,
        this.configuration,
        this.configurationHash,
      )
      const references:
        WorkspaceSearchMigrationPlanningTargetArtifactReference[] = []
      for (const segment of segments) {
        references.push(await this.putImmutableSegment(segment))
      }
      return references
    })
  }

  /**
   * Reads exact versions and reconstructs one complete target page.
   *
   * @param input - Expected common page identity and exact S3 references.
   * @returns Strictly parsed complete lossless target page.
   */
  async readPlanningTargetArtifactPage(
    input: ReadWorkspaceSearchMigrationPlanningTargetArtifactPageInput,
  ): Promise<WorkspaceSearchMigrationPlanningTargetArtifactPage> {
    return runTargetArtifactAwsBoundary(async () => {
      const prepared = prepareTargetArtifactReadInput(
        input,
        this.configuration,
        this.configurationHash,
      )
      const bytes: Uint8Array[] = []
      for (
        let segmentIndex = 0;
        segmentIndex < prepared.references.length;
        segmentIndex += 1
      ) {
        const reference = prepared.references[segmentIndex]
        if (reference === undefined) {
          return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
        }
        bytes.push(await this.readVerifiedSegment(
          reference,
          segmentIndex,
          prepared.references.length,
        ))
      }
      const page =
        parseWorkspaceSearchMigrationPlanningTargetArtifactPage(bytes)
      requirePageMatchesExpected(
        page,
        prepared.expectedPage,
        this.configuration,
        this.configurationHash,
      )
      return page
    })
  }

  /**
   * Uploads or reconciles one deterministic immutable segment.
   *
   * @param segment - Detached canonical segment and request material.
   * @param retryCount - Number of conditional retry uploads already made.
   * @returns Exact immutable S3 version reference.
   */
  private async putImmutableSegment(
    segment: PreparedTargetArtifactSegment,
    retryCount = 0,
  ): Promise<WorkspaceSearchMigrationPlanningTargetArtifactReference> {
    let output: PutObjectCommandOutput
    try {
      output = await this.transport.putTargetArtifact(
        createTargetArtifactPutCommand(
          this.configuration,
          segment,
        ),
      )
    } catch (error: unknown) {
      if (isTargetArtifactPreconditionFailure(error)) {
        const existing = await this.reconcileCurrentSegment(segment)
        if (existing.exists) return existing.reference
        return failTargetArtifactAws('AMBIGUOUS_OPERATION_UNRESOLVED')
      }
      if (isTargetArtifactAmbiguousWriteFailure(error)) {
        const existing = await this.reconcileCurrentSegment(segment)
        if (existing.exists) return existing.reference
        if (retryCount < targetArtifactMaximumRetryCount) {
          return this.putImmutableSegment(segment, retryCount + 1)
        }
        return failTargetArtifactAws(
          'TRANSIENT_INFRASTRUCTURE_FAILURE',
        )
      }
      return failTargetArtifactAws('TARGET_ARTIFACT_WRITE_FAILED')
    }

    const versionId = validateTargetArtifactPutOutput(
      output,
      segment,
      this.configuration,
    )
    let head: TargetArtifactHeadResult
    try {
      head = await this.headSegment(segment, versionId)
    } catch (error: unknown) {
      if (error instanceof TargetArtifactAwsFailure) throw error
      return failTargetArtifactAws(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
    if (!head.exists) {
      return failTargetArtifactAws(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
    return head.reference
  }

  /**
   * Reconciles one uncertain write through a strongly consistent current Head.
   *
   * @param segment - Exact expected canonical segment.
   * @returns Absence or an exact recovered immutable reference.
   */
  private async reconcileCurrentSegment(
    segment: PreparedTargetArtifactSegment,
  ): Promise<TargetArtifactHeadResult> {
    try {
      return await this.headSegment(segment)
    } catch (error: unknown) {
      if (error instanceof TargetArtifactAwsFailure) throw error
      return failTargetArtifactAws(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
  }

  /**
   * Reads and validates metadata for one current or exact object version.
   *
   * @param segment - Exact expected canonical segment.
   * @param versionId - Optional exact version returned by PutObject.
   * @returns Absence or an exact immutable reference.
   */
  private async headSegment(
    segment: PreparedTargetArtifactSegment,
    versionId?: string,
  ): Promise<TargetArtifactHeadResult> {
    let output: HeadObjectCommandOutput
    try {
      output = await this.transport.headTargetArtifact(
        new HeadObjectCommand({
          Bucket: this.configuration.journal.bucketName,
          Key: segment.objectKey,
          ExpectedBucketOwner: this.configuration.account,
          ChecksumMode: 'ENABLED',
          ...(versionId === undefined ? {} : { VersionId: versionId }),
        }),
      )
    } catch (error: unknown) {
      if (isTargetArtifactNotFound(error)) return { exists: false }
      throw error
    }
    const snapshot = snapshotTargetArtifactObjectOutput(output, false)
    const resolvedVersionId = validateStoredTargetArtifactObject(
      snapshot,
      segment,
      this.configuration,
      versionId,
    )
    return {
      exists: true,
      reference: createTargetArtifactReference(
        segment,
        resolvedVersionId,
      ),
    }
  }

  /**
   * Reads, bounds, and validates one exact object version.
   *
   * @param reference - Exact immutable S3 version committed in evidence.
   * @param segmentIndex - Expected zero-based ordered segment position.
   * @param segmentCount - Expected total ordered segment count.
   * @returns Exact canonical segment bytes.
   */
  private async readVerifiedSegment(
    reference: WorkspaceSearchMigrationPlanningTargetArtifactReference,
    segmentIndex: number,
    segmentCount: number,
  ): Promise<Uint8Array> {
    let output: GetObjectCommandOutput
    try {
      output = await this.transport.getTargetArtifact(
        new GetObjectCommand({
          Bucket: this.configuration.journal.bucketName,
          Key: reference.objectKey,
          VersionId: reference.versionId,
          ExpectedBucketOwner: this.configuration.account,
          ChecksumMode: 'ENABLED',
        }),
      )
    } catch (error: unknown) {
      if (isTargetArtifactRetryableFailure(error)) {
        return failTargetArtifactAws(
          'TRANSIENT_INFRASTRUCTURE_FAILURE',
        )
      }
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const snapshot = snapshotTargetArtifactObjectOutput(output, true)
    const byteLength = validateReferencedTargetArtifactObject(
      snapshot,
      reference,
      segmentIndex,
      segmentCount,
      this.configuration,
    )
    const bytes = await readBoundedTargetArtifactBody(
      snapshot.body,
      byteLength,
    )
    if (
      digestTargetArtifactBytes(bytes) !== reference.contentDigest
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const segment =
      parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(bytes)
    if (
      segment.segmentIndex !== segmentIndex ||
      segment.segmentCount !== segmentCount
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    return bytes
  }
}

/**
 * Detached read request safe to retain across asynchronous S3 reads.
 */
type PreparedTargetArtifactReadInput = {
  /** Exact expected common page identity. */
  readonly expectedPage:
    WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext
  /** Detached ordered exact immutable S3 references. */
  readonly references:
    readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[]
}

/**
 * Validates and snapshots one port construction request.
 *
 * @param input - Candidate measured configuration and transport.
 * @returns Detached exact adapter dependencies.
 */
function prepareTargetArtifactAwsPortInput(
  input: CreateWorkspaceSearchMigrationTargetArtifactAwsPortInput,
): PreparedTargetArtifactAwsPortInput {
  const record = requireTargetArtifactInputRecord(
    input,
    'INVALID_ARGUMENT',
  )
  requireExactTargetArtifactInputKeys(
    record,
    ['configuration', 'configurationHash', 'transport'],
    'INVALID_ARGUMENT',
  )
  const configuration = structuredClone(input.configuration)
  const configurationHash = input.configurationHash
  if (
    !isHexDigest(configurationHash) ||
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failTargetArtifactAws('CONFIGURATION_HASH_MISMATCH')
  }
  requireTargetArtifactConfiguration(configuration)
  requireTargetArtifactTransport(input.transport)
  return {
    configuration,
    configurationHash,
    transport: input.transport,
  }
}

/**
 * Validates and serializes one complete write request before S3 I/O.
 *
 * @param input - Candidate complete page.
 * @param configuration - Adapter-bound measured configuration.
 * @param configurationHash - Adapter-bound configuration digest.
 * @returns Ordered detached canonical segments.
 */
function prepareTargetArtifactWriteInput(
  input: WriteWorkspaceSearchMigrationPlanningTargetArtifactPageInput,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): readonly PreparedTargetArtifactSegment[] {
  const record = requireTargetArtifactInputRecord(
    input,
    'INVALID_ARGUMENT',
  )
  requireExactTargetArtifactInputKeys(
    record,
    ['expectedPage'],
    'INVALID_ARGUMENT',
  )
  let encoded:
    readonly WorkspaceSearchMigrationPlanningTargetArtifactEncodedSegment[]
  try {
    encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        structuredClone(input.expectedPage),
      )
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationTargetArtifactError) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    throw error
  }
  if (
    encoded.length === 0 ||
    encoded.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  const canonicalBytes = encoded.map((candidate) =>
    new Uint8Array(candidate.bytes)
  )
  const page =
    parseWorkspaceSearchMigrationPlanningTargetArtifactPage(
      canonicalBytes,
    )
  requirePageConfigurationBinding(
    page,
    configuration,
    configurationHash,
  )
  return encoded.map(prepareTargetArtifactSegment)
}

/**
 * Validates and snapshots one complete read request before S3 I/O.
 *
 * @param input - Candidate expected page context and references.
 * @param configuration - Adapter-bound measured configuration.
 * @param configurationHash - Adapter-bound configuration digest.
 * @returns Detached expected context and ordered references.
 */
function prepareTargetArtifactReadInput(
  input: ReadWorkspaceSearchMigrationPlanningTargetArtifactPageInput,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): PreparedTargetArtifactReadInput {
  const record = requireTargetArtifactInputRecord(
    input,
    'INVALID_ARGUMENT',
  )
  requireExactTargetArtifactInputKeys(
    record,
    ['expectedPage', 'references'],
    'INVALID_ARGUMENT',
  )
  const expectedPage = snapshotExpectedTargetArtifactPageContext(
    structuredClone(input.expectedPage),
  )
  requireExpectedPageConfigurationBinding(
    expectedPage,
    configuration,
    configurationHash,
  )
  const referenceValues = readDenseTargetArtifactArray(
    input.references,
    'INVALID_TARGET_ARTIFACT',
  )
  if (
    referenceValues.length === 0 ||
    referenceValues.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  const objectKeys = new Set<string>()
  const references = referenceValues.map((candidate) => {
    const reference = snapshotTargetArtifactReference(candidate)
    if (objectKeys.has(reference.objectKey)) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    objectKeys.add(reference.objectKey)
    return reference
  })
  return { expectedPage, references }
}

/**
 * Detaches and revalidates one canonical encoded segment.
 *
 * @param encoded - Candidate canonical encoded segment.
 * @returns Exact request material for one S3 object.
 */
function prepareTargetArtifactSegment(
  encoded: WorkspaceSearchMigrationPlanningTargetArtifactEncodedSegment,
): PreparedTargetArtifactSegment {
  try {
    const bytes = new Uint8Array(encoded.bytes)
    const segment =
      parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(bytes)
    const serialized =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encoded.segment,
      )
    const contentDigest =
      createWorkspaceSearchMigrationPlanningTargetArtifactContentDigest(
        bytes,
      )
    if (
      !targetArtifactBytesEqual(bytes, serialized) ||
      encoded.byteLength !== bytes.byteLength ||
      encoded.contentDigest !== contentDigest ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const objectKey =
      createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
        contentDigest,
      )
    const metadata = createTargetArtifactMetadata(
      contentDigest,
      bytes.byteLength,
      segment.segmentIndex,
      segment.segmentCount,
    )
    return {
      segment,
      bytes,
      contentDigest,
      checksumSha256:
        createTargetArtifactChecksumSha256(bytes),
      byteLength: bytes.byteLength,
      objectKey,
      metadata,
    }
  } catch (error: unknown) {
    if (error instanceof TargetArtifactAwsFailure) throw error
    if (error instanceof WorkspaceSearchMigrationTargetArtifactError) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
}

/**
 * Creates the exact exclusive immutable S3 upload command.
 *
 * @param configuration - Adapter-bound measured configuration.
 * @param segment - Detached canonical segment material.
 * @returns Adapter-owned PutObject command.
 */
function createTargetArtifactPutCommand(
  configuration: WorkspaceSearchMigrationConfiguration,
  segment: PreparedTargetArtifactSegment,
): PutObjectCommand {
  return new PutObjectCommand({
    Bucket: configuration.journal.bucketName,
    Key: segment.objectKey,
    Body: segment.bytes,
    ContentLength: segment.byteLength,
    ContentType: targetArtifactContentType,
    ChecksumAlgorithm: 'SHA256',
    ChecksumSHA256: segment.checksumSha256,
    IfNoneMatch: '*',
    ExpectedBucketOwner: configuration.account,
    Metadata: { ...segment.metadata },
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: configuration.journal.keyArn,
    BucketKeyEnabled: true,
  })
}

/**
 * Creates exact secret-free S3 user metadata for one segment.
 *
 * @param contentDigest - Exact lowercase SHA-256 content digest.
 * @param byteLength - Exact canonical byte length.
 * @param segmentIndex - Zero-based segment position.
 * @param segmentCount - Complete page segment count.
 * @returns Exact adapter-owned metadata map.
 */
function createTargetArtifactMetadata(
  contentDigest: string,
  byteLength: number,
  segmentIndex: number,
  segmentCount: number,
): Readonly<Record<string, string>> {
  return {
    'mukuroji-kind': targetArtifactKind,
    'mukuroji-version': String(
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
    ),
    'mukuroji-content-sha256': contentDigest,
    'mukuroji-byte-length': String(byteLength),
    'mukuroji-segment-index': String(segmentIndex),
    'mukuroji-segment-count': String(segmentCount),
  }
}

/**
 * Requires one non-array input object without trusting its prototype.
 *
 * @param value - Candidate runtime input.
 * @param code - Private failure code used for invalid input.
 * @returns Object suitable for bounded reflection.
 */
function requireTargetArtifactInputRecord(
  value: unknown,
  code: TargetArtifactAwsFailureCode,
): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return failTargetArtifactAws(code)
  }
  return value
}

/**
 * Requires exactly the declared enumerable own string keys.
 *
 * @param value - Candidate input object.
 * @param expected - Exact accepted key names.
 * @param code - Private failure code used for invalid input.
 */
function requireExactTargetArtifactInputKeys(
  value: object,
  expected: readonly string[],
  code: TargetArtifactAwsFailureCode,
): void {
  let keys: string[]
  try {
    if (
      Reflect.ownKeys(value).some((key) => typeof key !== 'string')
    ) {
      return failTargetArtifactAws(code)
    }
    keys = Object.keys(value).sort()
  } catch {
    return failTargetArtifactAws(code)
  }
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failTargetArtifactAws(code)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failTargetArtifactAws(code)
    }
  }
}

/**
 * Validates every measured configuration field consumed by S3 artifact I/O.
 *
 * @param configuration - Detached candidate measured configuration.
 */
function requireTargetArtifactConfiguration(
  configuration: WorkspaceSearchMigrationConfiguration,
): void {
  if (
    configuration.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    configuration.migrationVersion !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    configuration.journalPrefix !== 'workspace-search/v1' ||
    !/^\d{12}$/u.test(configuration.account) ||
    !isValidTargetArtifactRegion(configuration.region)
  ) {
    return failTargetArtifactAws('INVALID_ARGUMENT')
  }
  const journal = requireTargetArtifactInputRecord(
    configuration.journal,
    'INVALID_ARGUMENT',
  )
  const bucketName = Reflect.get(journal, 'bucketName')
  const keyArn = Reflect.get(journal, 'keyArn')
  const defaultRetentionDays = Reflect.get(
    journal,
    'defaultRetentionDays',
  )
  if (
    !isValidTargetArtifactBucketName(bucketName) ||
    !isMeasuredTargetArtifactKmsKeyArn(
      keyArn,
      configuration.region,
      configuration.account,
    ) ||
    !isCanonicalTimestamp(Reflect.get(journal, 'keyCreationTime')) ||
    Reflect.get(journal, 'keyManager') !== 'CUSTOMER' ||
    Reflect.get(journal, 'keyState') !== 'Enabled' ||
    Reflect.get(journal, 'keySpec') !== 'SYMMETRIC_DEFAULT' ||
    Reflect.get(journal, 'keyUsage') !== 'ENCRYPT_DECRYPT' ||
    Reflect.get(journal, 'keyOrigin') !== 'AWS_KMS' ||
    Reflect.get(journal, 'keyMultiRegion') !== false ||
    Reflect.get(journal, 'versioning') !== 'Enabled' ||
    Reflect.get(journal, 'objectLockMode') !== 'COMPLIANCE' ||
    typeof defaultRetentionDays !== 'number' ||
    !Number.isSafeInteger(defaultRetentionDays) ||
    defaultRetentionDays <= 0 ||
    Reflect.get(journal, 'encryption') !== 'aws:kms' ||
    Reflect.get(journal, 'bucketKeyEnabled') !== true
  ) {
    return failTargetArtifactAws('INVALID_ARGUMENT')
  }
  const partition = readTargetArtifactArnPartition(keyArn)
  const tables = requireTargetArtifactInputRecord(
    configuration.tables,
    'INVALID_ARGUMENT',
  )
  requireTargetArtifactTableIdentity(
    Reflect.get(tables, 'workspace-search'),
    'workspace-search',
    configuration,
    partition,
  )
  requireTargetArtifactTableIdentity(
    Reflect.get(tables, 'migration-state'),
    'migration-state',
    configuration,
    partition,
  )
}

/**
 * Checks a bounded official AWS region identifier.
 *
 * @param value - Candidate measured AWS region.
 * @returns Whether the value has the same supported shape as identity discovery.
 */
function isValidTargetArtifactRegion(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 32 &&
    /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/u.test(value)
}

/**
 * Checks an official AWS ARN partition identifier.
 *
 * @param value - Candidate partition component.
 * @returns Whether the value is an official AWS partition shape.
 */
function isTargetArtifactAwsPartition(value: unknown): value is string {
  return typeof value === 'string' &&
    /^aws(?:-[a-z0-9]+)*$/u.test(value)
}

/**
 * Reads the already validated partition from one measured resource ARN.
 *
 * @param value - Exact measured KMS key ARN.
 * @returns Exact official AWS partition.
 */
function readTargetArtifactArnPartition(value: string): string {
  const partition = value.split(':')[1]
  if (!isTargetArtifactAwsPartition(partition)) {
    return failTargetArtifactAws('INVALID_ARGUMENT')
  }
  return partition
}

/**
 * Checks an exact measured KMS key ARN across supported AWS partitions.
 *
 * @param value - Candidate measured KMS key ARN.
 * @param region - Exact configured AWS region.
 * @param account - Exact configured AWS account.
 * @returns Whether the value is one exact physical KMS key ARN.
 */
function isMeasuredTargetArtifactKmsKeyArn(
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
    isTargetArtifactAwsPartition(partition) &&
    parts[2] === 'kms' &&
    parts[3] === region &&
    parts[4] === account &&
    typeof resource === 'string' &&
    /^key\/[A-Za-z0-9][A-Za-z0-9/_-]{0,255}$/u.test(resource)
}

/**
 * Checks one S3 bucket name without allowing aliases or endpoint-like input.
 *
 * @param value - Candidate measured bucket name.
 * @returns Whether the name is a canonical general-purpose bucket name.
 */
function isValidTargetArtifactBucketName(value: unknown): value is string {
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
  const reservedPrefixes = ['xn--', 'sthree-', 'amzn_s3_demo_']
  const reservedSuffixes = [
    '-s3alias',
    '--ol-s3',
    '.mrap',
    '--x-s3',
    '--table-s3',
  ]
  return value.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ) &&
    !reservedPrefixes.some((prefix) => value.startsWith(prefix)) &&
    !reservedSuffixes.some((suffix) => value.endsWith(suffix))
}

/**
 * Checks an exact measured DynamoDB table ARN in the selected AWS partition.
 *
 * @param value - Candidate measured table ARN.
 * @param tableName - Exact measured physical table name.
 * @param region - Exact configured AWS region.
 * @param account - Exact configured AWS account.
 * @param partition - AWS partition selected by the measured journal key.
 * @returns Whether the ARN identifies the exact table in the same partition.
 */
function isMeasuredTargetArtifactTableArn(
  value: unknown,
  tableName: string,
  region: string,
  account: string,
  partition: string,
): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split(':')
  return parts.length === 6 &&
    parts[0] === 'arn' &&
    parts[1] === partition &&
    isTargetArtifactAwsPartition(parts[1]) &&
    parts[2] === 'dynamodb' &&
    parts[3] === region &&
    parts[4] === account &&
    parts[5] === `table/${tableName}`
}

/**
 * Validates immutable physical table fields used for artifact binding.
 *
 * @param value - Candidate measured table identity.
 * @param role - Exact configured table role.
 * @param configuration - Adapter-bound measured configuration.
 * @param partition - Exact official partition shared by measured resources.
 */
function requireTargetArtifactTableIdentity(
  value: unknown,
  role: MigrationTableIdentity['role'],
  configuration: WorkspaceSearchMigrationConfiguration,
  partition: string,
): void {
  const record = requireTargetArtifactInputRecord(
    value,
    'INVALID_ARGUMENT',
  )
  const tableName = Reflect.get(record, 'tableName')
  const tableArn = Reflect.get(record, 'tableArn')
  const tableId = Reflect.get(record, 'tableId')
  if (
    Reflect.get(record, 'role') !== role ||
    typeof tableName !== 'string' ||
    tableName.length < 3 ||
    tableName.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(tableName) ||
    !isMeasuredTargetArtifactTableArn(
      tableArn,
      tableName,
      configuration.region,
      configuration.account,
      partition,
    ) ||
    typeof tableId !== 'string' ||
    tableId.length === 0 ||
    tableId.length > 1_024 ||
    !hasOnlyPairedSurrogates(tableId) ||
    !isCanonicalTimestamp(Reflect.get(record, 'creationTime')) ||
    Reflect.get(record, 'account') !== configuration.account ||
    Reflect.get(record, 'region') !== configuration.region
  ) {
    return failTargetArtifactAws('INVALID_ARGUMENT')
  }
}

/**
 * Validates the narrow S3 transport without invoking caller methods.
 *
 * @param transport - Candidate transport dependency.
 */
function requireTargetArtifactTransport(transport: unknown): void {
  if (
    typeof transport !== 'object' ||
    transport === null ||
    typeof Reflect.get(transport, 'putTargetArtifact') !== 'function' ||
    typeof Reflect.get(transport, 'headTargetArtifact') !== 'function' ||
    typeof Reflect.get(transport, 'getTargetArtifact') !== 'function'
  ) {
    return failTargetArtifactAws('INVALID_ARGUMENT')
  }
}

/**
 * Detaches and validates one expected page identity without target items.
 *
 * @param value - Candidate caller-owned page identity.
 * @returns Exact detached expected page identity.
 */
function snapshotExpectedTargetArtifactPageContext(
  value: unknown,
): WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext {
  const record = requireTargetArtifactInputRecord(
    value,
    'INVALID_ARGUMENT',
  )
  requireExactTargetArtifactInputKeys(
    record,
    [
      'configurationHash',
      'pageSequence',
      'planningAuthority',
      'previousCheckpointDigest',
      'previousEvidenceDigest',
      'runId',
      'stateTable',
      'targetTable',
    ],
    'INVALID_ARGUMENT',
  )
  const expected: WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext = {
    runId: readTargetArtifactIdentifier(
      Reflect.get(record, 'runId'),
    ),
    configurationHash: readTargetArtifactDigest(
      Reflect.get(record, 'configurationHash'),
      'INVALID_ARGUMENT',
    ),
    targetTable: snapshotTargetArtifactTableIncarnation(
      Reflect.get(record, 'targetTable'),
      'INVALID_ARGUMENT',
    ),
    stateTable: snapshotTargetArtifactTableIncarnation(
      Reflect.get(record, 'stateTable'),
      'INVALID_ARGUMENT',
    ),
    pageSequence: readTargetArtifactPositiveSafeInteger(
      Reflect.get(record, 'pageSequence'),
      'INVALID_ARGUMENT',
    ),
    previousEvidenceDigest: readTargetArtifactDigest(
      Reflect.get(record, 'previousEvidenceDigest'),
      'INVALID_ARGUMENT',
    ),
    previousCheckpointDigest: readTargetArtifactDigest(
      Reflect.get(record, 'previousCheckpointDigest'),
      'INVALID_ARGUMENT',
    ),
    planningAuthority: snapshotTargetArtifactPlanningAuthority(
      Reflect.get(record, 'planningAuthority'),
      'INVALID_ARGUMENT',
    ),
  }
  try {
    serializeWorkspaceSearchMigrationPlanningTargetArtifactPage({
      kind: 'workspace-search-planning-target-artifact-page',
      artifactVersion:
        WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      purpose: 'planning',
      ...expected,
      items: [],
    })
  } catch {
    return failTargetArtifactAws('INVALID_ARGUMENT')
  }
  return expected
}

/**
 * Detaches immutable table-incarnation fields from untrusted input.
 *
 * @param value - Candidate physical table incarnation.
 * @param code - Private failure code used for invalid input.
 * @returns Exact detached table incarnation.
 */
function snapshotTargetArtifactTableIncarnation(
  value: unknown,
  code: TargetArtifactAwsFailureCode,
): WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation {
  const record = requireTargetArtifactInputRecord(value, code)
  requireExactTargetArtifactInputKeys(
    record,
    ['creationTime', 'tableArn', 'tableId', 'tableName'],
    code,
  )
  return {
    tableName: readTargetArtifactBoundedText(
      Reflect.get(record, 'tableName'),
      255,
      code,
    ),
    tableArn: readTargetArtifactBoundedText(
      Reflect.get(record, 'tableArn'),
      2_048,
      code,
    ),
    tableId: readTargetArtifactBoundedText(
      Reflect.get(record, 'tableId'),
      1_024,
      code,
    ),
    creationTime: readTargetArtifactCanonicalTime(
      Reflect.get(record, 'creationTime'),
      code,
    ),
  }
}

/**
 * Detaches one complete artifact planning-authority binding.
 *
 * @param value - Candidate planning authority.
 * @param code - Private failure code used for invalid input.
 * @returns Exact detached planning authority.
 */
function snapshotTargetArtifactPlanningAuthority(
  value: unknown,
  code: TargetArtifactAwsFailureCode,
): WorkspaceSearchMigrationPlanningTargetArtifactAuthority {
  const record = requireTargetArtifactInputRecord(value, code)
  requireExactTargetArtifactInputKeys(
    record,
    [
      'fenceToken',
      'maintenanceEvidencePointerRevision',
      'maintenanceEvidenceReceiptDigest',
      'ownerId',
    ],
    code,
  )
  return {
    ownerId: readTargetArtifactIdentifier(
      Reflect.get(record, 'ownerId'),
      code,
    ),
    fenceToken: readTargetArtifactPositiveSafeInteger(
      Reflect.get(record, 'fenceToken'),
      code,
    ),
    maintenanceEvidencePointerRevision:
      readTargetArtifactPositiveSafeInteger(
        Reflect.get(
          record,
          'maintenanceEvidencePointerRevision',
        ),
        code,
      ),
    maintenanceEvidenceReceiptDigest: readTargetArtifactDigest(
      Reflect.get(record, 'maintenanceEvidenceReceiptDigest'),
      code,
    ),
  }
}

/**
 * Reads one bounded migration identifier.
 *
 * @param value - Candidate identifier.
 * @param code - Private failure code used for invalid input.
 * @returns Exact validated identifier.
 */
function readTargetArtifactIdentifier(
  value: unknown,
  code: TargetArtifactAwsFailureCode = 'INVALID_ARGUMENT',
): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failTargetArtifactAws(code)
  }
  return value
}

/**
 * Reads one exact lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param code - Private failure code used for invalid input.
 * @returns Exact validated digest.
 */
function readTargetArtifactDigest(
  value: unknown,
  code: TargetArtifactAwsFailureCode,
): string {
  if (!isHexDigest(value)) return failTargetArtifactAws(code)
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @param code - Private failure code used for invalid input.
 * @returns Exact positive safe integer.
 */
function readTargetArtifactPositiveSafeInteger(
  value: unknown,
  code: TargetArtifactAwsFailureCode,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return failTargetArtifactAws(code)
  }
  return value
}

/**
 * Reads one nonempty bounded well-formed string.
 *
 * @param value - Candidate text.
 * @param maximumLength - Maximum UTF-16 code-unit length.
 * @param code - Private failure code used for invalid input.
 * @returns Exact validated text.
 */
function readTargetArtifactBoundedText(
  value: unknown,
  maximumLength: number,
  code: TargetArtifactAwsFailureCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failTargetArtifactAws(code)
  }
  return value
}

/**
 * Reads one canonical nonnegative UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @param code - Private failure code used for invalid input.
 * @returns Exact canonical timestamp.
 */
function readTargetArtifactCanonicalTime(
  value: unknown,
  code: TargetArtifactAwsFailureCode,
): string {
  if (!isCanonicalTimestamp(value)) return failTargetArtifactAws(code)
  const epochMilliseconds = Date.parse(value)
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failTargetArtifactAws(code)
  }
  return value
}

/**
 * Reads every value from one canonical dense data-property array.
 *
 * @param value - Candidate array.
 * @param code - Private failure code used for invalid input.
 * @returns Detached ordered values.
 */
function readDenseTargetArtifactArray(
  value: unknown,
  code: TargetArtifactAwsFailureCode,
): readonly unknown[] {
  try {
    if (!hasCanonicalDenseArrayShape(value)) {
      return failTargetArtifactAws(code)
    }
    const values: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        value,
        String(index),
      )
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        return failTargetArtifactAws(code)
      }
      values.push(descriptor.value)
    }
    return values
  } catch {
    return failTargetArtifactAws(code)
  }
}

/**
 * Detaches and validates one exact immutable target-artifact reference.
 *
 * @param value - Candidate evidence reference.
 * @returns Exact detached reference.
 */
function snapshotTargetArtifactReference(
  value: unknown,
): WorkspaceSearchMigrationPlanningTargetArtifactReference {
  const record = requireTargetArtifactInputRecord(
    value,
    'INVALID_TARGET_ARTIFACT',
  )
  requireExactTargetArtifactInputKeys(
    record,
    ['contentDigest', 'objectKey', 'versionId'],
    'INVALID_TARGET_ARTIFACT',
  )
  const contentDigest = readTargetArtifactDigest(
    Reflect.get(record, 'contentDigest'),
    'INVALID_TARGET_ARTIFACT',
  )
  const objectKey = readTargetArtifactBoundedText(
    Reflect.get(record, 'objectKey'),
    1_024,
    'INVALID_TARGET_ARTIFACT',
  )
  const versionId = readTargetArtifactBoundedText(
    Reflect.get(record, 'versionId'),
    1_024,
    'INVALID_TARGET_ARTIFACT',
  )
  if (
    objectKey !==
      createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
        contentDigest,
      ) ||
    versionId === 'null'
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return { objectKey, versionId, contentDigest }
}

/**
 * Validates expected identity against the measured adapter configuration.
 *
 * @param expected - Detached expected page identity.
 * @param configuration - Adapter-bound measured configuration.
 * @param configurationHash - Adapter-bound configuration digest.
 */
function requireExpectedPageConfigurationBinding(
  expected: WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): void {
  if (expected.configurationHash !== configurationHash) {
    return failTargetArtifactAws('CONFIGURATION_HASH_MISMATCH')
  }
  const targetTable = configuration.tables['workspace-search']
  const stateTable = configuration.tables['migration-state']
  if (
    targetTable === undefined ||
    stateTable === undefined ||
    targetTable.role !== 'workspace-search' ||
    stateTable.role !== 'migration-state' ||
    !targetArtifactTableIncarnationMatches(
      expected.targetTable,
      targetTable,
    ) ||
    !targetArtifactTableIncarnationMatches(
      expected.stateTable,
      stateTable,
    )
  ) {
    return failTargetArtifactAws('IDENTITY_MISMATCH')
  }
}

/**
 * Validates a complete page against the measured adapter configuration.
 *
 * @param page - Strict parsed complete page.
 * @param configuration - Adapter-bound measured configuration.
 * @param configurationHash - Adapter-bound configuration digest.
 */
function requirePageConfigurationBinding(
  page: WorkspaceSearchMigrationPlanningTargetArtifactPage,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): void {
  requireExpectedPageConfigurationBinding(
    page,
    configuration,
    configurationHash,
  )
}

/**
 * Requires a reconstructed page to match every expected common field.
 *
 * @param page - Strict parsed reconstructed page.
 * @param expected - Detached expected identity.
 * @param configuration - Adapter-bound measured configuration.
 * @param configurationHash - Adapter-bound configuration digest.
 */
function requirePageMatchesExpected(
  page: WorkspaceSearchMigrationPlanningTargetArtifactPage,
  expected: WorkspaceSearchMigrationPlanningTargetArtifactExpectedPageContext,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): void {
  requirePageConfigurationBinding(
    page,
    configuration,
    configurationHash,
  )
  if (
    page.runId !== expected.runId ||
    page.configurationHash !== expected.configurationHash ||
    page.pageSequence !== expected.pageSequence ||
    page.previousEvidenceDigest !== expected.previousEvidenceDigest ||
    page.previousCheckpointDigest !==
      expected.previousCheckpointDigest ||
    !targetArtifactTableIncarnationMatches(
      page.targetTable,
      expected.targetTable,
    ) ||
    !targetArtifactTableIncarnationMatches(
      page.stateTable,
      expected.stateTable,
    ) ||
    !targetArtifactPlanningAuthorityMatches(
      page.planningAuthority,
      expected.planningAuthority,
    )
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
}

/**
 * Checks exact equality of immutable table-incarnation fields.
 *
 * @param left - First table incarnation.
 * @param right - Second table incarnation or complete table identity.
 * @returns Whether every immutable binding field matches.
 */
function targetArtifactTableIncarnationMatches(
  left: WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation,
  right:
    | WorkspaceSearchMigrationPlanningTargetArtifactTableIncarnation
    | MigrationTableIdentity,
): boolean {
  return left.tableName === right.tableName &&
    left.tableArn === right.tableArn &&
    left.tableId === right.tableId &&
    left.creationTime === right.creationTime
}

/**
 * Checks exact equality of complete planning-authority bindings.
 *
 * @param left - First planning authority.
 * @param right - Second planning authority.
 * @returns Whether every authority field matches.
 */
function targetArtifactPlanningAuthorityMatches(
  left: WorkspaceSearchMigrationPlanningTargetArtifactAuthority,
  right: WorkspaceSearchMigrationPlanningTargetArtifactAuthority,
): boolean {
  return left.ownerId === right.ownerId &&
    left.fenceToken === right.fenceToken &&
    left.maintenanceEvidencePointerRevision ===
      right.maintenanceEvidencePointerRevision &&
    left.maintenanceEvidenceReceiptDigest ===
      right.maintenanceEvidenceReceiptDigest
}

/**
 * Checks exact equality of two byte sequences without coercion.
 *
 * @param left - First exact byte sequence.
 * @param right - Second exact byte sequence.
 * @returns Whether the sequences contain identical bytes.
 */
function targetArtifactBytesEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Creates the exact base64 SHA-256 value required by S3 checksums.
 *
 * @param bytes - Exact canonical object bytes.
 * @returns Base64 SHA-256 checksum.
 */
function createTargetArtifactChecksumSha256(
  bytes: Uint8Array,
): string {
  return createHash('sha256').update(bytes).digest('base64')
}

/**
 * Validates only S3 PutObject response fields that are safe to consume.
 *
 * @param output - Raw low-level PutObject response.
 * @param segment - Exact expected segment request material.
 * @param configuration - Adapter-bound measured configuration.
 * @returns Exact returned immutable version, when S3 included it.
 */
function validateTargetArtifactPutOutput(
  output: PutObjectCommandOutput,
  segment: PreparedTargetArtifactSegment,
  configuration: WorkspaceSearchMigrationConfiguration,
): string | undefined {
  try {
    const record = requireTargetArtifactInputRecord(
      output,
      'INVALID_TARGET_ARTIFACT',
    )
    const versionId = readOptionalTargetArtifactOutputString(
      Reflect.get(record, 'VersionId'),
    )
    const checksumSha256 = readOptionalTargetArtifactOutputString(
      Reflect.get(record, 'ChecksumSHA256'),
    )
    const checksumType = readOptionalTargetArtifactOutputString(
      Reflect.get(record, 'ChecksumType'),
    )
    const serverSideEncryption =
      readOptionalTargetArtifactOutputString(
        Reflect.get(record, 'ServerSideEncryption'),
      )
    const sseKmsKeyId = readOptionalTargetArtifactOutputString(
      Reflect.get(record, 'SSEKMSKeyId'),
    )
    const bucketKeyEnabled =
      readOptionalTargetArtifactOutputBoolean(
        Reflect.get(record, 'BucketKeyEnabled'),
      )
    const size = readOptionalTargetArtifactOutputNumber(
      Reflect.get(record, 'Size'),
    )
    if (
      versionId === 'null' ||
      (versionId !== undefined &&
        (versionId.length === 0 ||
          versionId.length > 1_024 ||
          !hasOnlyPairedSurrogates(versionId))) ||
      (checksumSha256 !== undefined &&
        checksumSha256 !== segment.checksumSha256) ||
      (checksumType !== undefined &&
        checksumType !== 'FULL_OBJECT') ||
      (serverSideEncryption !== undefined &&
        serverSideEncryption !== 'aws:kms') ||
      (sseKmsKeyId !== undefined &&
        sseKmsKeyId !== configuration.journal.keyArn) ||
      (bucketKeyEnabled !== undefined && !bucketKeyEnabled) ||
      (size !== undefined && size !== segment.byteLength)
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    return versionId
  } catch (error: unknown) {
    if (error instanceof TargetArtifactAwsFailure) throw error
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
}

/**
 * Reads one optional string from an S3 response.
 *
 * @param value - Candidate optional response field.
 * @returns Exact string or undefined.
 */
function readOptionalTargetArtifactOutputString(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return value
}

/**
 * Reads one optional Boolean from an S3 response.
 *
 * @param value - Candidate optional response field.
 * @returns Exact Boolean or undefined.
 */
function readOptionalTargetArtifactOutputBoolean(
  value: unknown,
): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return value
}

/**
 * Reads one optional nonnegative safe integer from an S3 response.
 *
 * @param value - Candidate optional response field.
 * @returns Exact safe integer or undefined.
 */
function readOptionalTargetArtifactOutputNumber(
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return value
}

/**
 * Snapshots the exact safe subset shared by HeadObject and GetObject.
 *
 * @param output - Raw S3 object response.
 * @param includeBody - Whether to retain the untrusted streaming body.
 * @returns Detached safe response subset.
 */
function snapshotTargetArtifactObjectOutput(
  output: HeadObjectCommandOutput | GetObjectCommandOutput,
  includeBody: boolean,
): TargetArtifactObjectSnapshot {
  try {
    const record = requireTargetArtifactInputRecord(
      output,
      'INVALID_TARGET_ARTIFACT',
    )
    return {
      versionId: readOptionalTargetArtifactOutputString(
        Reflect.get(record, 'VersionId'),
      ),
      contentLength: readOptionalTargetArtifactOutputNumber(
        Reflect.get(record, 'ContentLength'),
      ),
      contentType: readOptionalTargetArtifactOutputString(
        Reflect.get(record, 'ContentType'),
      ),
      checksumSha256: readOptionalTargetArtifactOutputString(
        Reflect.get(record, 'ChecksumSHA256'),
      ),
      checksumType: readOptionalTargetArtifactOutputString(
        Reflect.get(record, 'ChecksumType'),
      ),
      serverSideEncryption:
        readOptionalTargetArtifactOutputString(
          Reflect.get(record, 'ServerSideEncryption'),
        ),
      sseKmsKeyId: readOptionalTargetArtifactOutputString(
        Reflect.get(record, 'SSEKMSKeyId'),
      ),
      bucketKeyEnabled:
        readOptionalTargetArtifactOutputBoolean(
          Reflect.get(record, 'BucketKeyEnabled'),
        ),
      deleteMarker: readOptionalTargetArtifactOutputBoolean(
        Reflect.get(record, 'DeleteMarker'),
      ),
      lastModifiedEpochMilliseconds:
        readOptionalTargetArtifactOutputDate(
          Reflect.get(record, 'LastModified'),
        ),
      objectLockMode: readOptionalTargetArtifactOutputString(
        Reflect.get(record, 'ObjectLockMode'),
      ),
      objectLockRetainUntilEpochMilliseconds:
        readOptionalTargetArtifactOutputDate(
          Reflect.get(record, 'ObjectLockRetainUntilDate'),
        ),
      metadata: snapshotTargetArtifactObjectMetadata(
        Reflect.get(record, 'Metadata'),
      ),
      body: includeBody ? Reflect.get(record, 'Body') : undefined,
    }
  } catch (error: unknown) {
    if (error instanceof TargetArtifactAwsFailure) throw error
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
}

/**
 * Reads one optional valid Date from an S3 response as epoch milliseconds.
 *
 * @param value - Candidate optional response date.
 * @returns Exact finite nonnegative epoch milliseconds or undefined.
 */
function readOptionalTargetArtifactOutputDate(
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof Date)) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return epochMilliseconds
}

/**
 * Detaches one optional S3 user-metadata map with data properties only.
 *
 * @param value - Candidate Metadata response field.
 * @returns Detached metadata map or undefined.
 */
function snapshotTargetArtifactObjectMetadata(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const record = requireTargetArtifactInputRecord(
    value,
    'INVALID_TARGET_ARTIFACT',
  )
  const ownKeys = Reflect.ownKeys(record)
  const enumerableKeys = Object.keys(record)
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== enumerableKeys.length
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  const metadata: Record<string, string> = {}
  for (const key of enumerableKeys) {
    if (
      key.length === 0 ||
      key.length > 128 ||
      !/^[a-z0-9-]+$/u.test(key)
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > 2_048 ||
      !hasOnlyPairedSurrogates(descriptor.value)
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    metadata[key] = descriptor.value
  }
  return metadata
}

/**
 * Validates an exact current or version-pinned HeadObject response.
 *
 * @param snapshot - Detached safe HeadObject response subset.
 * @param segment - Exact expected segment request material.
 * @param configuration - Adapter-bound measured configuration.
 * @param requestedVersionId - Optional exact version requested from S3.
 * @returns Exact immutable S3 version identifier.
 */
function validateStoredTargetArtifactObject(
  snapshot: TargetArtifactObjectSnapshot,
  segment: PreparedTargetArtifactSegment,
  configuration: WorkspaceSearchMigrationConfiguration,
  requestedVersionId?: string,
): string {
  const versionId = snapshot.versionId
  if (
    versionId === undefined ||
    versionId.length === 0 ||
    versionId.length > 1_024 ||
    versionId === 'null' ||
    !hasOnlyPairedSurrogates(versionId) ||
    (requestedVersionId !== undefined &&
      versionId !== requestedVersionId) ||
    snapshot.contentLength !== segment.byteLength ||
    snapshot.contentType !== targetArtifactContentType ||
    snapshot.checksumSha256 !== segment.checksumSha256 ||
    (snapshot.checksumType !== undefined &&
      snapshot.checksumType !== 'FULL_OBJECT') ||
    snapshot.serverSideEncryption !== 'aws:kms' ||
    snapshot.sseKmsKeyId !== configuration.journal.keyArn ||
    snapshot.bucketKeyEnabled !== true ||
    snapshot.deleteMarker === true ||
    !targetArtifactObjectHasMeasuredRetention(
      snapshot,
      configuration,
    ) ||
    !targetArtifactMetadataMatches(
      snapshot.metadata,
      segment.metadata,
    )
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return versionId
}

/**
 * Creates the exact evidence reference for one converged immutable object.
 *
 * @param segment - Exact stored segment request material.
 * @param versionId - Exact immutable S3 object version.
 * @returns Durable content-and-version reference.
 */
function createTargetArtifactReference(
  segment: PreparedTargetArtifactSegment,
  versionId: string,
): WorkspaceSearchMigrationPlanningTargetArtifactReference {
  return {
    objectKey: segment.objectKey,
    versionId,
    contentDigest: segment.contentDigest,
  }
}

/**
 * Validates an exact version-pinned GetObject response.
 *
 * @param snapshot - Detached safe GetObject response subset.
 * @param reference - Exact evidence reference requested from S3.
 * @param segmentIndex - Expected zero-based segment position.
 * @param segmentCount - Expected complete segment count.
 * @param configuration - Adapter-bound measured configuration.
 * @returns Exact bounded canonical body length.
 */
function validateReferencedTargetArtifactObject(
  snapshot: TargetArtifactObjectSnapshot,
  reference: WorkspaceSearchMigrationPlanningTargetArtifactReference,
  segmentIndex: number,
  segmentCount: number,
  configuration: WorkspaceSearchMigrationConfiguration,
): number {
  const byteLength = snapshot.contentLength
  if (
    byteLength === undefined ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  const expectedMetadata = createTargetArtifactMetadata(
    reference.contentDigest,
    byteLength,
    segmentIndex,
    segmentCount,
  )
  if (
    snapshot.versionId !== reference.versionId ||
    snapshot.contentType !== targetArtifactContentType ||
    snapshot.checksumSha256 !==
      createTargetArtifactChecksumFromDigest(reference.contentDigest) ||
    (snapshot.checksumType !== undefined &&
      snapshot.checksumType !== 'FULL_OBJECT') ||
    snapshot.serverSideEncryption !== 'aws:kms' ||
    snapshot.sseKmsKeyId !== configuration.journal.keyArn ||
    snapshot.bucketKeyEnabled !== true ||
    snapshot.deleteMarker === true ||
    !targetArtifactObjectHasMeasuredRetention(
      snapshot,
      configuration,
    ) ||
    !targetArtifactMetadataMatches(
      snapshot.metadata,
      expectedMetadata,
    )
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return byteLength
}

/**
 * Verifies that the exact version received the measured bucket retention.
 *
 * The trusted measured bucket supplies default COMPLIANCE retention. The
 * adapter verifies the resulting immutable interval using S3's own
 * LastModified and retain-until timestamps, avoiding local-clock ambiguity.
 *
 * @param snapshot - Detached exact object metadata.
 * @param configuration - Adapter-bound measured configuration.
 * @returns Whether the object has at least the measured retention interval.
 */
function targetArtifactObjectHasMeasuredRetention(
  snapshot: TargetArtifactObjectSnapshot,
  configuration: WorkspaceSearchMigrationConfiguration,
): boolean {
  const lastModified = snapshot.lastModifiedEpochMilliseconds
  const retainUntil =
    snapshot.objectLockRetainUntilEpochMilliseconds
  const minimumRetentionMilliseconds =
    configuration.journal.defaultRetentionDays *
    24 *
    60 *
    60 *
    1_000
  return snapshot.objectLockMode === 'COMPLIANCE' &&
    lastModified !== undefined &&
    retainUntil !== undefined &&
    Number.isSafeInteger(minimumRetentionMilliseconds) &&
    minimumRetentionMilliseconds > 0 &&
    retainUntil >= lastModified &&
    retainUntil - lastModified >= minimumRetentionMilliseconds
}

/**
 * Creates the S3 base64 checksum representation of one hex SHA-256 digest.
 *
 * @param contentDigest - Exact lowercase SHA-256 digest.
 * @returns Exact base64 digest bytes.
 */
function createTargetArtifactChecksumFromDigest(
  contentDigest: string,
): string {
  if (!isHexDigest(contentDigest)) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return Buffer.from(contentDigest, 'hex').toString('base64')
}

/**
 * Checks exact equality of an S3 metadata response and expected map.
 *
 * @param actual - Detached response metadata.
 * @param expected - Exact adapter-owned metadata.
 * @returns Whether both maps have exactly the same entries.
 */
function targetArtifactMetadataMatches(
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
 * Reads one streaming object body into an exact bounded allocation.
 *
 * @param body - Candidate S3 streaming body.
 * @param expectedLength - Exact validated ContentLength.
 * @returns Detached exact object bytes.
 */
async function readBoundedTargetArtifactBody(
  body: unknown,
  expectedLength: number,
): Promise<Uint8Array> {
  try {
    if (
      !Number.isSafeInteger(expectedLength) ||
      expectedLength <= 0 ||
      expectedLength >
        WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    if (body instanceof Uint8Array) {
      if (body.byteLength !== expectedLength) {
        return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
      }
      return new Uint8Array(body)
    }
    if (
      (typeof body !== 'object' && typeof body !== 'function') ||
      body === null
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const iteratorMethod: unknown = Reflect.get(
      body,
      Symbol.asyncIterator,
    )
    if (typeof iteratorMethod !== 'function') {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const iterator: unknown = Reflect.apply(
      iteratorMethod,
      body,
      [],
    )
    if (
      (typeof iterator !== 'object' &&
        typeof iterator !== 'function') ||
      iterator === null
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const nextMethod: unknown = Reflect.get(iterator, 'next')
    if (typeof nextMethod !== 'function') {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutResult = new Promise<Uint8Array>(
      (_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new TargetArtifactBodyTimeout()),
          targetArtifactBodyTimeoutMilliseconds,
        )
      },
    )
    try {
      return await Promise.race([
        readBoundedTargetArtifactIterator(
          iterator,
          nextMethod,
          expectedLength,
        ),
        timeoutResult,
      ])
    } catch (error: unknown) {
      cancelTargetArtifactBody(iterator, body)
      throw error
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  } catch (error: unknown) {
    if (error instanceof TargetArtifactAwsFailure) throw error
    if (isTargetArtifactRetryableFailure(error)) {
      return failTargetArtifactAws(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
      )
    }
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
}

/**
 * Consumes one already validated async iterator into an exact allocation.
 *
 * @param iterator - Candidate iterator retained for method receivers.
 * @param nextMethod - Exact callable next method read from the iterator.
 * @param expectedLength - Exact validated object length.
 * @returns Detached exact object bytes.
 */
async function readBoundedTargetArtifactIterator(
  iterator: unknown,
  nextMethod: unknown,
  expectedLength: number,
): Promise<Uint8Array> {
  if (
    (typeof iterator !== 'object' &&
      typeof iterator !== 'function') ||
    iterator === null ||
    typeof nextMethod !== 'function'
  ) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  const bytes = new Uint8Array(expectedLength)
  let offset = 0
  while (true) {
    const result: unknown = await Reflect.apply(
      nextMethod,
      iterator,
      [],
    )
    if (typeof result !== 'object' || result === null) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const done: unknown = Reflect.get(result, 'done')
    if (done === true) break
    if (done !== false && done !== undefined) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    const chunk: unknown = Reflect.get(result, 'value')
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength === 0 ||
      offset + chunk.byteLength > expectedLength ||
      offset + chunk.byteLength >
        WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES
    ) {
      return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
    }
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (offset !== expectedLength) {
    return failTargetArtifactAws('INVALID_TARGET_ARTIFACT')
  }
  return bytes
}

/**
 * Best-effort cancels both the async iterator and its underlying S3 body.
 *
 * Cancellation failures are deliberately ignored because the original fixed
 * validation or timeout failure remains authoritative.
 *
 * @param iterator - Iterator whose pending next operation must be released.
 * @param body - Underlying S3 body, which may expose destroy or cancel.
 */
function cancelTargetArtifactBody(
  iterator: unknown,
  body: unknown,
): void {
  invokeTargetArtifactCancellationMethod(iterator, 'return')
  invokeTargetArtifactCancellationMethod(body, 'destroy')
  invokeTargetArtifactCancellationMethod(body, 'cancel')
}

/**
 * Invokes one optional cancellation method without awaiting hostile cleanup.
 *
 * @param target - Candidate iterator or streaming body.
 * @param methodName - Exact allowlisted cleanup method.
 */
function invokeTargetArtifactCancellationMethod(
  target: unknown,
  methodName: 'cancel' | 'destroy' | 'return',
): void {
  try {
    if (
      (typeof target !== 'object' &&
        typeof target !== 'function') ||
      target === null
    ) {
      return
    }
    const method: unknown = Reflect.get(target, methodName)
    if (typeof method !== 'function') return
    const result: unknown = Reflect.apply(method, target, [])
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // The fixed original failure remains authoritative.
  }
}

/**
 * Creates the lowercase SHA-256 content identity of exact object bytes.
 *
 * @param bytes - Exact canonical object bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestTargetArtifactBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Detects an S3 exclusive-create precondition failure.
 *
 * @param error - Candidate raw S3 error.
 * @returns Whether S3 proved that a current object already exists.
 */
function isTargetArtifactPreconditionFailure(
  error: unknown,
): boolean {
  try {
    return readTargetArtifactErrorName(error) ===
      'PreconditionFailed' ||
      readTargetArtifactHttpStatusCode(error) === 412
  } catch {
    return false
  }
}

/**
 * Detects a write failure for which S3 may still have committed the object.
 *
 * @param error - Candidate raw S3 or network error.
 * @returns Whether reconciliation is required before any retry.
 */
function isTargetArtifactAmbiguousWriteFailure(
  error: unknown,
): boolean {
  try {
    const status = readTargetArtifactHttpStatusCode(error)
    return status === 409 ||
      (status !== undefined && status >= 500) ||
      isTargetArtifactRetryableFailure(error)
  } catch {
    return false
  }
}

/**
 * Detects a HeadObject absence response.
 *
 * @param error - Candidate raw S3 error.
 * @returns Whether S3 proved that the requested object is absent.
 */
function isTargetArtifactNotFound(error: unknown): boolean {
  try {
    const name = readTargetArtifactErrorName(error)
    return readTargetArtifactHttpStatusCode(error) === 404 ||
      name === 'NoSuchKey' ||
      name === 'NotFound' ||
      name === 'NoSuchVersion'
  } catch {
    return false
  }
}

/**
 * Classifies a raw AWS or Node.js failure through a secret-free copy.
 *
 * @param error - Candidate raw transport failure.
 * @returns Whether the failure is safely retryable at a higher layer.
 */
function isTargetArtifactRetryableFailure(
  error: unknown,
): boolean {
  try {
    if (!(error instanceof Error)) return false
    const classificationInput =
      createTargetArtifactAwsErrorClassificationInput(error)
    return isThrottlingError(classificationInput) ||
      isTransientError(classificationInput)
  } catch {
    return false
  }
}

/**
 * Reads a stable error name without carrying raw messages across boundaries.
 *
 * @param error - Candidate raw SDK error.
 * @returns Stable name or undefined.
 */
function readTargetArtifactErrorName(
  error: unknown,
): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value: unknown = Reflect.get(error, 'name')
  return typeof value === 'string' ? value : undefined
}

/**
 * Reads only the numeric HTTP status used for S3 classification.
 *
 * @param error - Candidate raw SDK error.
 * @returns Finite HTTP status or undefined.
 */
function readTargetArtifactHttpStatusCode(
  error: unknown,
): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const metadata: unknown = Reflect.get(error, '$metadata')
  return readTargetArtifactOptionalNumericProperty(
    metadata,
    'httpStatusCode',
  )
}

/**
 * Copies only fields required by Smithy's retry classifiers.
 *
 * @param error - Raw SDK or Node.js transport error.
 * @param depth - Bounded wrapped-cause depth copied so far.
 * @returns Detached secret-free classifier input.
 */
function createTargetArtifactAwsErrorClassificationInput(
  error: Error,
  depth = 0,
): TargetArtifactAwsErrorClassificationInput {
  const nameValue: unknown = Reflect.get(error, 'name')
  const codeValue: unknown = Reflect.get(error, 'code')
  const metadataValue: unknown = Reflect.get(error, '$metadata')
  const retryableValue: unknown = Reflect.get(error, '$retryable')
  const causeValue: unknown =
    depth <= 10 ? Reflect.get(error, 'cause') : undefined
  const httpStatusCode =
    readTargetArtifactOptionalNumericProperty(
      metadataValue,
      'httpStatusCode',
    )
  const throttling =
    readTargetArtifactOptionalBooleanProperty(
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
          cause:
            createTargetArtifactAwsErrorClassificationInput(
              causeValue,
              depth + 1,
            ),
        }
      : {}),
  }
}

/**
 * Reads one optional finite numeric property without trusting its shape.
 *
 * @param value - Candidate object containing the property.
 * @param property - Exact property name.
 * @returns Finite number or undefined.
 */
function readTargetArtifactOptionalNumericProperty(
  value: unknown,
  property: string,
): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'number' &&
    Number.isFinite(propertyValue)
    ? propertyValue
    : undefined
}

/**
 * Reads one optional Boolean property without trusting its shape.
 *
 * @param value - Candidate object containing the property.
 * @param property - Exact property name.
 * @returns Boolean or undefined.
 */
function readTargetArtifactOptionalBooleanProperty(
  value: unknown,
  property: string,
): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'boolean'
    ? propertyValue
    : undefined
}

/**
 * Runs one adapter operation behind a fixed raw-error replacement boundary.
 *
 * @param operation - Exact validation and bounded S3 operation.
 * @returns Detached successful operation result.
 */
async function runTargetArtifactAwsBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createTargetArtifactAwsBoundaryFailure(
      readTargetArtifactAwsFailureCode(error),
    )
  }
}

/**
 * Reads only a trusted or structurally classified migration failure code.
 *
 * @param error - Arbitrary value raised by validation or S3 I/O.
 * @param fallback - Fail-closed code used for unknown errors.
 * @returns Stable operator-safe failure code.
 */
function readTargetArtifactAwsFailureCode(
  error: unknown,
  fallback:
    WorkspaceSearchMigrationFailureCode = 'INVALID_STATE',
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof TargetArtifactAwsFailure) return error.code
    if (
      error instanceof
        WorkspaceSearchMigrationTargetArtifactError
    ) {
      return 'INVALID_TARGET_ARTIFACT'
    }
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : fallback
    }
    if (isTargetArtifactRetryableFailure(error)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return fallback
  } catch {
    return fallback
  }
}

/**
 * Raises one privately branded adapter failure.
 *
 * @param code - Stable trusted adapter failure code.
 * @returns Never returns.
 */
function failTargetArtifactAws(
  code: TargetArtifactAwsFailureCode,
): never {
  throw new TargetArtifactAwsFailure(code)
}

/**
 * Creates one public fixed-message target-artifact boundary failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Fresh secret-free public failure.
 */
function createTargetArtifactAwsBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search target artifact stopped safely (${code}).`,
  )
}
