import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { serializeCanonicalJson } from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
} from './migration-rehearsal-evidence-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS,
  type WorkspaceSearchMigrationRehearsalArtifactEvidence,
  type WorkspaceSearchMigrationRehearsalArtifactKind,
} from './migration-rehearsal-evidence'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Media type used for every canonical rehearsal child artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_CONTENT_TYPE =
  'application/json'

/** Maximum exact canonical byte length of one rehearsal child artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_MAX_BYTES =
  64 * 1_024 * 1_024

const artifactObjectKeyPrefix =
  'workspace-search/v1/rehearsal/evidence-artifact'
const maximumRequestTimeoutMilliseconds = 30_000
const minimumRetentionAfterCompletionMilliseconds =
  365 * 24 * 60 * 60 * 1_000
const maximumRetentionAfterCompletionMilliseconds =
  366 * 24 * 60 * 60 * 1_000
const minimumRetentionHeadroomMilliseconds = 60_000
const artifactContractVersion = '1'
const versionDigestDomain =
  'mukuroji-workspace-search-migration-rehearsal-artifact/v1/version\0'
const sessionDigestDomain =
  'mukuroji-workspace-search-migration-rehearsal-artifact/v1/session\0'
const accountDigestDomain =
  'mukuroji-workspace-search-migration-rehearsal-artifact/v1/account\0'

/** Stable redacted failure categories for child-artifact publication. */
export type WorkspaceSearchMigrationRehearsalArtifactAwsFailureCode =
  | 'ARTIFACT_IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'PERMIT_INACTIVE'
  | 'PREEXISTING_ARTIFACT_MISMATCH'
  | 'PUBLICATION_FAILED'
  | 'PUBLICATION_UNRESOLVED'
  | 'PUBLISHER_CLOSED'
  | 'TRANSPORT_CLOSE_FAILED'

/** Raw-value-free failure raised by the child-artifact AWS boundary. */
export class WorkspaceSearchMigrationRehearsalArtifactAwsError
  extends Error {
  /** Stable secret-free failure category. */
  readonly code: WorkspaceSearchMigrationRehearsalArtifactAwsFailureCode

  /**
   * Creates one redacted child-artifact publication failure.
   *
   * @param code - Stable failure category containing no resource value.
   */
  constructor(code: WorkspaceSearchMigrationRehearsalArtifactAwsFailureCode) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalArtifactAwsError'
    this.code = code
  }
}

/**
 * Narrow session-owned S3 capability used by the artifact publisher.
 *
 * The admission method must synchronously revalidate the owning measured
 * non-production session and its authenticated permit. Request methods may
 * additionally guard the exact SDK send boundary. Reconciliation requests do
 * not invoke admission again after an uncertain write has already started.
 */
export interface WorkspaceSearchMigrationRehearsalArtifactAwsTransport {
  /** Requires one new artifact publication to remain permit-authorized. */
  admitNewArtifactPublication(): void

  /**
   * Sends one adapter-owned conditional PutObject command.
   *
   * @param command - Exact immutable artifact upload command.
   * @param abortSignal - Finite request and publisher-lifecycle signal.
   * @returns Untrusted raw SDK response.
   */
  putArtifact(
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<unknown>

  /**
   * Sends one current or exact-version HeadObject command.
   *
   * @param command - Exact artifact reconciliation command.
   * @param abortSignal - Finite request and publisher-lifecycle signal.
   * @returns Untrusted raw SDK response.
   */
  headArtifact(
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<unknown>

  /** Releases the underlying transport exactly once. */
  close(): void
}

/** Trusted clock used for publication and retention admission. */
export type WorkspaceSearchMigrationRehearsalArtifactAwsClock = () => Date

/** Exact measured non-production resource binding for one publisher. */
export type CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput = {
  /** Expected twelve-digit non-production AWS account. */
  readonly account: string
  /** Exact immutable journal bucket selected by the measured session. */
  readonly bucketName: string
  /** Trusted adapter clock shared with permit validation. */
  readonly clock: WorkspaceSearchMigrationRehearsalArtifactAwsClock
  /** Exact approved customer-managed KMS key ARN. */
  readonly kmsKeyArn: string
  /** Explicit AWS Region shared by the bucket session and KMS key. */
  readonly region: string
  /** Finite deadline for each individual S3 request. */
  readonly requestTimeoutMilliseconds: number
  /** Permit, caller, resource, commit, configuration, and key binding. */
  readonly sessionBinding:
    WorkspaceSearchMigrationRehearsalEvidenceSessionBinding
  /** Narrow session-owned admission and S3 transport capability. */
  readonly transport:
    WorkspaceSearchMigrationRehearsalArtifactAwsTransport
}

/** Canonical bytes and fixed immutable retention for one child artifact. */
export type PublishWorkspaceSearchMigrationRehearsalArtifactInput = {
  /** Exact canonical UTF-8 JSON bytes owned by the requested purpose. */
  readonly artifactBytes: Uint8Array
  /** Canonical completion time of the complete rehearsal suite. */
  readonly completedAt: string
  /** Exact finite child-artifact purpose. */
  readonly kind: WorkspaceSearchMigrationRehearsalArtifactKind
  /** Exact canonical UTC COMPLIANCE retention deadline. */
  readonly retainedUntil: string
}

/** Closeable immutable child-artifact publication capability. */
export interface WorkspaceSearchMigrationRehearsalArtifactAwsPublisher {
  /**
   * Exclusively publishes or exactly reconciles one canonical child artifact.
   *
   * @param input - Exact canonical artifact and retention request.
   * @returns Digest-only immutable evidence reference without any locator.
   */
  publishArtifact(
    input: PublishWorkspaceSearchMigrationRehearsalArtifactInput,
  ): Promise<WorkspaceSearchMigrationRehearsalArtifactEvidence>

  /** Aborts outstanding requests and releases the transport exactly once. */
  close(): void
}

/** Detached narrow transport operations retained by one publisher. */
type PreparedArtifactTransport = {
  /** Detached synchronous permit admission operation. */
  readonly admit: () => void
  /** Detached conditional immutable upload operation. */
  readonly put: (
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ) => Promise<unknown>
  /** Detached current or exact-version metadata read. */
  readonly head: (
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ) => Promise<unknown>
  /** Detached transport release operation. */
  readonly close: () => void
}

/** Validated and detached publisher construction material. */
type PreparedPublisherInput = {
  /** Exact expected non-production bucket owner. */
  readonly account: string
  /** Exact immutable journal bucket. */
  readonly bucketName: string
  /** Detached trusted epoch clock. */
  readonly clock: () => number
  /** Exact customer-managed KMS key ARN. */
  readonly kmsKeyArn: string
  /** Finite per-request deadline. */
  readonly requestTimeoutMilliseconds: number
  /** Detached exact measured rehearsal session facts. */
  readonly sessionBinding:
    WorkspaceSearchMigrationRehearsalEvidenceSessionBinding
  /** Detached session-owned transport operations. */
  readonly transport: PreparedArtifactTransport
}

/** Fully detached immutable child-artifact material. */
type PreparedArtifact = {
  /** Exact copied canonical artifact bytes. */
  readonly bytes: Uint8Array
  /** Exact canonical byte length. */
  readonly byteLength: number
  /** Base64 full-object SHA-256 required by S3. */
  readonly checksumSha256: string
  /** Lowercase SHA-256 digest of the exact bytes. */
  readonly contentDigest: string
  /** Exact finite child-artifact purpose. */
  readonly kind: WorkspaceSearchMigrationRehearsalArtifactKind
  /** Complete exact S3 user metadata. */
  readonly metadata: Readonly<Record<string, string>>
  /** Adapter-owned content-addressed object key. */
  readonly objectKey: string
  /** Canonical Object Lock deadline. */
  readonly retainedUntil: string
  /** Exact Object Lock deadline epoch. */
  readonly retainedUntilEpochMilliseconds: number
}

/** Detached fields required from an exact HeadObject response. */
type ArtifactHeadSnapshot = {
  /** Exact immutable object version. */
  readonly versionId: string
  /** Exact stored body length. */
  readonly contentLength: number | undefined
  /** Exact stored media type. */
  readonly contentType: string | undefined
  /** Exact base64 full-object checksum. */
  readonly checksumSha256: string | undefined
  /** Optional checksum composition classification. */
  readonly checksumType: string | undefined
  /** Stored server-side encryption family. */
  readonly serverSideEncryption: string | undefined
  /** Exact stored KMS key ARN. */
  readonly sseKmsKeyId: string | undefined
  /** Whether S3 Bucket Keys were enabled. */
  readonly bucketKeyEnabled: boolean | undefined
  /** Whether this version is a delete marker. */
  readonly deleteMarker: boolean | undefined
  /** Exact Object Lock mode. */
  readonly objectLockMode: string | undefined
  /** Exact Object Lock deadline epoch. */
  readonly retainedUntilEpochMilliseconds: number | undefined
  /** Complete detached S3 user metadata. */
  readonly metadata: Readonly<Record<string, string>> | undefined
}

/** Internal finite timeout marker containing no resource data. */
class ArtifactRequestTimeout extends Error {
  /** Creates a redacted request timeout. */
  constructor() {
    super('ARTIFACT_REQUEST_TIMEOUT')
    this.name = 'ArtifactRequestTimeout'
  }
}

const artifactGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failArtifactAws('INVALID_ARGUMENT'),
)

/**
 * Creates a publisher bound to one measured non-production journal identity.
 *
 * Construction itself is an admission boundary, preventing a retained stale
 * session capability from creating a publisher after permit expiry.
 *
 * @param input - Exact resource identity, session facts, and narrow transport.
 * @returns Closeable immutable child-artifact publisher.
 */
export function createWorkspaceSearchMigrationRehearsalArtifactAwsPublisher(
  input: CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput,
): WorkspaceSearchMigrationRehearsalArtifactAwsPublisher {
  return runArtifactAwsBoundary(() => {
    const prepared = preparePublisherInput(input)
    requirePermitAdmission(prepared.transport.admit)
    return new AwsWorkspaceSearchMigrationRehearsalArtifactPublisher(prepared)
  })
}

/** Concrete immutable child-artifact publisher with a one-way lifecycle. */
class AwsWorkspaceSearchMigrationRehearsalArtifactPublisher
  implements WorkspaceSearchMigrationRehearsalArtifactAwsPublisher {
  /** Exact expected non-production bucket owner. */
  private readonly account: string

  /** Exact immutable journal bucket. */
  private readonly bucketName: string

  /** Detached trusted epoch clock. */
  private readonly clock: () => number

  /** Exact customer-managed KMS key ARN. */
  private readonly kmsKeyArn: string

  /** Finite per-request deadline. */
  private readonly requestTimeoutMilliseconds: number

  /** Session-derived facts fixed into every artifact's metadata. */
  private readonly sessionBinding:
    WorkspaceSearchMigrationRehearsalEvidenceSessionBinding

  /** Detached session-owned transport. */
  private readonly transport: PreparedArtifactTransport

  /** One-way controller aborting all outstanding requests on close. */
  private readonly lifecycleController = new AbortController()

  /** Whether the transport has already been released. */
  private closed = false

  /**
   * Creates one publisher from detached validated material.
   *
   * @param input - Prepared publisher dependencies.
   */
  constructor(input: PreparedPublisherInput) {
    this.account = input.account
    this.bucketName = input.bucketName
    this.clock = input.clock
    this.kmsKeyArn = input.kmsKeyArn
    this.requestTimeoutMilliseconds = input.requestTimeoutMilliseconds
    this.sessionBinding = input.sessionBinding
    this.transport = input.transport
  }

  /**
   * Exclusively stores or exactly reconciles one canonical child artifact.
   *
   * @param input - Exact canonical artifact and retention request.
   * @returns Digest-only immutable evidence reference.
   */
  async publishArtifact(
    input: PublishWorkspaceSearchMigrationRehearsalArtifactInput,
  ): Promise<WorkspaceSearchMigrationRehearsalArtifactEvidence> {
    return runArtifactAwsAsyncBoundary(async () => {
      this.requireOpen()
      this.requireNewPublicationAdmission()
      const artifact = prepareArtifact(
        input,
        this.clock,
        this.requestTimeoutMilliseconds,
        this.account,
        this.sessionBinding,
      )

      let output: unknown
      try {
        output = await this.runRequest((abortSignal) =>
          this.transport.put(
            this.createPutCommand(artifact),
            abortSignal,
          ))
      } catch (error: unknown) {
        if (readArtifactAwsFailureCode(error) !== undefined) throw error
        if (isPreconditionFailure(error)) {
          return this.reconcileArtifact(artifact, undefined, true)
        }
        if (isAmbiguousWriteFailure(error)) {
          return this.reconcileArtifact(artifact, undefined, false)
        }
        return failArtifactAws('PUBLICATION_FAILED')
      }

      return this.reconcileArtifact(
        artifact,
        tryReadVersionId(output),
        false,
      )
    })
  }

  /** Aborts outstanding work and releases the transport exactly once. */
  close(): void {
    runArtifactAwsBoundary(() => {
      if (this.closed) return
      this.closed = true
      this.lifecycleController.abort()
      try {
        this.transport.close()
      } catch {
        return failArtifactAws('TRANSPORT_CLOSE_FAILED')
      }
    })
  }

  /** Requires this publisher lifecycle to remain open. */
  private requireOpen(): void {
    if (this.closed) return failArtifactAws('PUBLISHER_CLOSED')
  }

  /** Requires one fresh immutable upload to remain permit-authorized. */
  private requireNewPublicationAdmission(): void {
    this.requireOpen()
    requirePermitAdmission(this.transport.admit)
  }

  /**
   * Creates the exact exclusive KMS COMPLIANCE PutObject command.
   *
   * @param artifact - Fully detached canonical artifact material.
   * @returns Adapter-owned immutable upload command.
   */
  private createPutCommand(artifact: PreparedArtifact): PutObjectCommand {
    return new PutObjectCommand({
      Bucket: this.bucketName,
      Key: artifact.objectKey,
      Body: artifact.bytes,
      ContentLength: artifact.byteLength,
      ContentType:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_CONTENT_TYPE,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: artifact.checksumSha256,
      IfNoneMatch: '*',
      ExpectedBucketOwner: this.account,
      Metadata: { ...artifact.metadata },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: this.kmsKeyArn,
      BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate:
        new Date(artifact.retainedUntilEpochMilliseconds),
    })
  }

  /**
   * Reconciles a successful or ambiguous write through an exact-version HEAD.
   *
   * A current HEAD may discover a version identifier, but only a second
   * version-pinned HEAD is authoritative for identity and content. This path
   * intentionally remains available after a previously admitted Put starts.
   *
   * @param artifact - Exact attempted publication.
   * @param requestedVersionId - Version returned by a successful Put.
   * @param preexisting - Whether exclusive creation was explicitly rejected.
   * @returns Digest-only verified artifact reference.
   */
  private async reconcileArtifact(
    artifact: PreparedArtifact,
    requestedVersionId: string | undefined,
    preexisting: boolean,
  ): Promise<WorkspaceSearchMigrationRehearsalArtifactEvidence> {
    let versionId = requestedVersionId
    if (versionId === undefined) {
      const current = await this.readHead(artifact.objectKey)
      versionId = tryReadVersionId(current)
      if (versionId === undefined) {
        return failArtifactAws('PUBLICATION_UNRESOLVED')
      }
    }
    const exact = await this.readHead(artifact.objectKey, versionId)
    const snapshot = readHeadSnapshot(exact)
    requireArtifactHeadIdentity(
      snapshot,
      versionId,
      artifact,
      this.kmsKeyArn,
    )
    requireArtifactHeadContent(snapshot, artifact, preexisting)
    return createArtifactEvidence(
      artifact,
      versionId,
      this.account,
      this.bucketName,
      this.kmsKeyArn,
    )
  }

  /**
   * Reads one current or exact-version object metadata response.
   *
   * @param objectKey - Adapter-owned content-addressed object key.
   * @param versionId - Optional exact immutable object version.
   * @returns Raw untrusted transport output.
   */
  private async readHead(
    objectKey: string,
    versionId?: string,
  ): Promise<unknown> {
    try {
      return await this.runRequest((abortSignal) =>
        this.transport.head(
          new HeadObjectCommand({
            Bucket: this.bucketName,
            Key: objectKey,
            ExpectedBucketOwner: this.account,
            ChecksumMode: 'ENABLED',
            ...(versionId === undefined ? {} : { VersionId: versionId }),
          }),
          abortSignal,
        ))
    } catch (error: unknown) {
      if (readArtifactAwsFailureCode(error) !== undefined) throw error
      return failArtifactAws('PUBLICATION_UNRESOLVED')
    }
  }

  /**
   * Runs one transport operation under request and publisher deadlines.
   *
   * @param operation - Exact transport call receiving the finite signal.
   * @returns Raw transport result.
   */
  private async runRequest(
    operation: (abortSignal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    this.requireOpen()
    const requestController = new AbortController()
    const lifecycleSignal = this.lifecycleController.signal
    let timeoutIdentifier: ReturnType<typeof setTimeout> | undefined
    /** Removes the currently installed publisher-lifecycle listener. */
    let removeLifecycleListener = (): void => undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutIdentifier = setTimeout(() => {
        requestController.abort()
        reject(new ArtifactRequestTimeout())
      }, this.requestTimeoutMilliseconds)
    })
    const lifecycle = new Promise<never>((_resolve, reject) => {
      /** Aborts the request and rejects when the owning publisher closes. */
      const listener = (): void => {
        requestController.abort()
        reject(new WorkspaceSearchMigrationRehearsalArtifactAwsError(
          'PUBLISHER_CLOSED',
        ))
      }
      lifecycleSignal.addEventListener('abort', listener, { once: true })
      removeLifecycleListener = () =>
        lifecycleSignal.removeEventListener('abort', listener)
    })
    try {
      return await Promise.race([
        operation(requestController.signal),
        timeout,
        lifecycle,
      ])
    } finally {
      if (timeoutIdentifier !== undefined) clearTimeout(timeoutIdentifier)
      removeLifecycleListener()
    }
  }
}

/** Detaches and validates one publisher construction input. */
function preparePublisherInput(
  input: CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput,
): PreparedPublisherInput {
  const record = artifactGuards.requireRecord(input)
  artifactGuards.requireExactKeys(record, [
    'account',
    'bucketName',
    'clock',
    'kmsKeyArn',
    'region',
    'requestTimeoutMilliseconds',
    'sessionBinding',
    'transport',
  ])
  const account = readAccount(artifactGuards.readOwn(record, 'account'))
  const region = readRegion(artifactGuards.readOwn(record, 'region'))
  return {
    account,
    bucketName: readBucketName(
      artifactGuards.readOwn(record, 'bucketName'),
    ),
    clock: snapshotClock(artifactGuards.readOwn(record, 'clock')),
    kmsKeyArn: readKmsKeyArn(
      artifactGuards.readOwn(record, 'kmsKeyArn'),
      account,
      region,
    ),
    requestTimeoutMilliseconds: readPositiveInteger(
      artifactGuards.readOwn(record, 'requestTimeoutMilliseconds'),
      maximumRequestTimeoutMilliseconds,
    ),
    sessionBinding: readSessionBinding(
      artifactGuards.readOwn(record, 'sessionBinding'),
    ),
    transport: snapshotTransport(
      artifactGuards.readOwn(record, 'transport'),
    ),
  }
}

/** Reads and detaches one exact measured rehearsal session binding. */
function readSessionBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalEvidenceSessionBinding {
  const record = artifactGuards.requireRecord(value)
  artifactGuards.requireExactKeys(record, [
    'attestation',
    'commit',
    'configurationHash',
    'evidenceKeyDigest',
    'publicationKeyDigest',
  ])
  const commit = artifactGuards.readOwn(record, 'commit')
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  const attestationRecord = artifactGuards.requireRecord(
    artifactGuards.readOwn(record, 'attestation'),
  )
  artifactGuards.requireExactKeys(attestationRecord, [
    'callerAttestationDigest',
    'permitDigest',
    'productionIsolationDigest',
    'resourceAttestationDigest',
    'stage',
  ])
  if (artifactGuards.readOwn(attestationRecord, 'stage') !== 'non-production') {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  const evidenceKeyDigest = artifactGuards.readDigest(
    artifactGuards.readOwn(record, 'evidenceKeyDigest'),
  )
  const publicationKeyDigest = artifactGuards.readDigest(
    artifactGuards.readOwn(record, 'publicationKeyDigest'),
  )
  if (evidenceKeyDigest === publicationKeyDigest) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  return Object.freeze({
    commit,
    configurationHash: artifactGuards.readDigest(
      artifactGuards.readOwn(record, 'configurationHash'),
    ),
    evidenceKeyDigest,
    publicationKeyDigest,
    attestation: Object.freeze({
      stage: 'non-production',
      permitDigest: artifactGuards.readDigest(
        artifactGuards.readOwn(attestationRecord, 'permitDigest'),
      ),
      callerAttestationDigest: artifactGuards.readDigest(
        artifactGuards.readOwn(attestationRecord, 'callerAttestationDigest'),
      ),
      resourceAttestationDigest: artifactGuards.readDigest(
        artifactGuards.readOwn(attestationRecord, 'resourceAttestationDigest'),
      ),
      productionIsolationDigest: artifactGuards.readDigest(
        artifactGuards.readOwn(
          attestationRecord,
          'productionIsolationDigest',
        ),
      ),
    }),
  })
}

/** Detaches and strictly validates one artifact publication request. */
function prepareArtifact(
  input: PublishWorkspaceSearchMigrationRehearsalArtifactInput,
  clock: () => number,
  requestTimeoutMilliseconds: number,
  account: string,
  sessionBinding: WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
): PreparedArtifact {
  const record = artifactGuards.requireRecord(input)
  artifactGuards.requireExactKeys(record, [
    'artifactBytes',
    'completedAt',
    'kind',
    'retainedUntil',
  ])
  const kind = readArtifactKind(artifactGuards.readOwn(record, 'kind'))
  const bytes = copyCanonicalArtifactBytes(
    artifactGuards.readOwn(record, 'artifactBytes'),
  )
  const completedAt = artifactGuards.readTimestamp(
    artifactGuards.readOwn(record, 'completedAt'),
  )
  const retainedUntil = artifactGuards.readTimestamp(
    artifactGuards.readOwn(record, 'retainedUntil'),
  )
  const completedAtEpochMilliseconds = Date.parse(completedAt)
  const retainedUntilEpochMilliseconds = Date.parse(retainedUntil)
  const now = clock()
  const retentionAfterCompletion =
    retainedUntilEpochMilliseconds - completedAtEpochMilliseconds
  const headroom = retainedUntilEpochMilliseconds - now
  if (
    !Number.isSafeInteger(completedAtEpochMilliseconds) ||
    !Number.isSafeInteger(retainedUntilEpochMilliseconds) ||
    completedAtEpochMilliseconds > now ||
    !Number.isSafeInteger(retentionAfterCompletion) ||
    retentionAfterCompletion < minimumRetentionAfterCompletionMilliseconds ||
    retentionAfterCompletion > maximumRetentionAfterCompletionMilliseconds ||
    !Number.isSafeInteger(headroom) ||
    headroom <
      minimumRetentionHeadroomMilliseconds + requestTimeoutMilliseconds
  ) {
    return failArtifactAws('INVALID_ARGUMENT')
  }

  const contentDigest = digestBytes(bytes)
  const byteLength = bytes.byteLength
  const sessionDigest = createArtifactSessionDigest(account, sessionBinding)
  return {
    bytes,
    byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('base64'),
    contentDigest,
    kind,
    metadata: Object.freeze({
      'mukuroji-rehearsal-account-sha256':
        digestText(`${accountDigestDomain}${account}`),
      'mukuroji-rehearsal-artifact-kind': kind,
      'mukuroji-rehearsal-artifact-version': artifactContractVersion,
      'mukuroji-rehearsal-byte-length': String(byteLength),
      'mukuroji-rehearsal-caller-sha256':
        sessionBinding.attestation.callerAttestationDigest,
      'mukuroji-rehearsal-commit': sessionBinding.commit,
      'mukuroji-rehearsal-configuration-sha256':
        sessionBinding.configurationHash,
      'mukuroji-rehearsal-content-sha256': contentDigest,
      'mukuroji-rehearsal-evidence-key-sha256':
        sessionBinding.evidenceKeyDigest,
      'mukuroji-rehearsal-publication-key-sha256':
        sessionBinding.publicationKeyDigest,
      'mukuroji-rehearsal-permit-sha256':
        sessionBinding.attestation.permitDigest,
      'mukuroji-rehearsal-production-isolation-sha256':
        sessionBinding.attestation.productionIsolationDigest,
      'mukuroji-rehearsal-resource-sha256':
        sessionBinding.attestation.resourceAttestationDigest,
      'mukuroji-rehearsal-retain-until': retainedUntil,
      'mukuroji-rehearsal-session-sha256': sessionDigest,
    }),
    objectKey:
      `${artifactObjectKeyPrefix}/${sessionDigest}/${kind}/${contentDigest}.json`,
    retainedUntil,
    retainedUntilEpochMilliseconds,
  }
}

/** Creates the opaque storage namespace for one exact measured session. */
function createArtifactSessionDigest(
  account: string,
  sessionBinding: WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
): string {
  return digestText(
    `${sessionDigestDomain}${serializeCanonicalJson({
      account,
      commit: sessionBinding.commit,
      configurationHash: sessionBinding.configurationHash,
      evidenceKeyDigest: sessionBinding.evidenceKeyDigest,
      publicationKeyDigest: sessionBinding.publicationKeyDigest,
      attestation: sessionBinding.attestation,
    })}`,
  )
}

/** Copies and requires strict canonical UTF-8 JSON artifact bytes. */
function copyCanonicalArtifactBytes(value: unknown): Uint8Array {
  if (nodeUtilTypes.isProxy(value) || !nodeUtilTypes.isUint8Array(value)) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  const buffer = artifactGuards.readIntrinsicBuffer(value)
  const byteLength = artifactGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_MAX_BYTES
  ) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(copy)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failArtifactAws('INVALID_ARGUMENT')
    }
    artifactGuards.requireRecord(parsed)
    if (serializeCanonicalJson(parsed) !== text) {
      return failArtifactAws('INVALID_ARGUMENT')
    }
  } catch {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  return copy
}

/** Reads one exact finite child-artifact purpose. */
function readArtifactKind(
  value: unknown,
): WorkspaceSearchMigrationRehearsalArtifactKind {
  for (const candidate of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS) {
    if (value === candidate) return candidate
  }
  return failArtifactAws('INVALID_ARGUMENT')
}

/** Snapshots one trusted native Date-returning clock. */
function snapshotClock(value: unknown): () => number {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  return () => {
    const candidate: unknown = Reflect.apply(value, undefined, [])
    if (nodeUtilTypes.isProxy(candidate) || !nodeUtilTypes.isDate(candidate)) {
      return failArtifactAws('INVALID_ARGUMENT')
    }
    const epoch = Date.prototype.getTime.call(candidate)
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      return failArtifactAws('INVALID_ARGUMENT')
    }
    return epoch
  }
}

/** Snapshots narrow transport methods without retaining mutable properties. */
function snapshotTransport(value: unknown): PreparedArtifactTransport {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  const admit = readMethod(value, 'admitNewArtifactPublication')
  const put = readMethod(value, 'putArtifact')
  const head = readMethod(value, 'headArtifact')
  const close = readMethod(value, 'close')
  return {
    admit: () => {
      admit([])
    },
    put: (command, abortSignal) =>
      Promise.resolve(put([command, abortSignal])),
    head: (command, abortSignal) =>
      Promise.resolve(head([command, abortSignal])),
    close: () => {
      close([])
    },
  }
}

/** Reads and binds one inherited callable data property without accessors. */
function readMethod(
  receiver: object,
  name: string,
): (argumentsList: readonly unknown[]) => unknown {
  let current: object | null = receiver
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      return failArtifactAws('INVALID_ARGUMENT')
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failArtifactAws('INVALID_ARGUMENT')
      }
      const method: unknown = descriptor.value
      if (typeof method !== 'function') {
        return failArtifactAws('INVALID_ARGUMENT')
      }
      return (argumentsList) => Reflect.apply(method, receiver, argumentsList)
    }
    current = Object.getPrototypeOf(current)
  }
  return failArtifactAws('INVALID_ARGUMENT')
}

/** Executes one permit admission without retaining or exposing its failure. */
function requirePermitAdmission(admit: () => void): void {
  try {
    admit()
  } catch {
    return failArtifactAws('PERMIT_INACTIVE')
  }
}

/** Reads a strict AWS account identifier. */
function readAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value)) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  return value
}

/** Reads a conservative AWS Region identifier. */
function readRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value)
  ) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  return value
}

/** Reads a strict ordinary S3 bucket name. */
function readBucketName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  return value
}

/** Reads an exact regional customer-managed KMS key ARN. */
function readKmsKeyArn(
  value: unknown,
  account: string,
  region: string,
): string {
  const prefix = `arn:aws:kms:${region}:${account}:key/`
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix) ||
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value.slice(prefix.length),
    )
  ) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  return value
}

/** Reads one positive bounded integer. */
function readPositiveInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    return failArtifactAws('INVALID_ARGUMENT')
  }
  return value
}

/** Reads a valid S3 immutable version identifier when available. */
function tryReadVersionId(value: unknown): string | undefined {
  try {
    const record = requireResponseRecord(value)
    const candidate = readOptionalResponseData(record, 'VersionId')
    return candidate === undefined
      ? undefined
      : readResponseVersionId(candidate)
  } catch {
    return undefined
  }
}

/** Snapshots exact metadata fields from one version-pinned HEAD response. */
function readHeadSnapshot(value: unknown): ArtifactHeadSnapshot {
  try {
    const record = requireResponseRecord(value)
    return {
      versionId: readResponseVersionId(
        readRequiredResponseData(record, 'VersionId'),
      ),
      contentLength: readOptionalResponseInteger(
        readOptionalResponseData(record, 'ContentLength'),
      ),
      contentType: readOptionalResponseString(
        readOptionalResponseData(record, 'ContentType'),
      ),
      checksumSha256: readOptionalResponseString(
        readOptionalResponseData(record, 'ChecksumSHA256'),
      ),
      checksumType: readOptionalResponseString(
        readOptionalResponseData(record, 'ChecksumType'),
      ),
      serverSideEncryption: readOptionalResponseString(
        readOptionalResponseData(record, 'ServerSideEncryption'),
      ),
      sseKmsKeyId: readOptionalResponseString(
        readOptionalResponseData(record, 'SSEKMSKeyId'),
      ),
      bucketKeyEnabled: readOptionalResponseBoolean(
        readOptionalResponseData(record, 'BucketKeyEnabled'),
      ),
      deleteMarker: readOptionalResponseBoolean(
        readOptionalResponseData(record, 'DeleteMarker'),
      ),
      objectLockMode: readOptionalResponseString(
        readOptionalResponseData(record, 'ObjectLockMode'),
      ),
      retainedUntilEpochMilliseconds: readOptionalResponseDate(
        readOptionalResponseData(record, 'ObjectLockRetainUntilDate'),
      ),
      metadata: readOptionalResponseMetadata(
        readOptionalResponseData(record, 'Metadata'),
      ),
    }
  } catch {
    return failArtifactAws('ARTIFACT_IDENTITY_MISMATCH')
  }
}

/** Requires exact immutable storage identity on a version-pinned HEAD. */
function requireArtifactHeadIdentity(
  snapshot: ArtifactHeadSnapshot,
  versionId: string,
  artifact: PreparedArtifact,
  kmsKeyArn: string,
): void {
  if (
    snapshot.versionId !== versionId ||
    snapshot.serverSideEncryption !== 'aws:kms' ||
    snapshot.sseKmsKeyId !== kmsKeyArn ||
    snapshot.bucketKeyEnabled !== true ||
    snapshot.deleteMarker === true ||
    snapshot.objectLockMode !== 'COMPLIANCE' ||
    snapshot.retainedUntilEpochMilliseconds !==
      artifact.retainedUntilEpochMilliseconds
  ) {
    return failArtifactAws('ARTIFACT_IDENTITY_MISMATCH')
  }
}

/** Requires exact content, checksum, media type, and session metadata. */
function requireArtifactHeadContent(
  snapshot: ArtifactHeadSnapshot,
  artifact: PreparedArtifact,
  preexisting: boolean,
): void {
  if (
    snapshot.contentLength !== artifact.byteLength ||
    snapshot.contentType !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_CONTENT_TYPE ||
    snapshot.checksumSha256 !== artifact.checksumSha256 ||
    (snapshot.checksumType !== undefined &&
      snapshot.checksumType !== 'FULL_OBJECT') ||
    !metadataEqual(snapshot.metadata, artifact.metadata)
  ) {
    return failArtifactAws(
      preexisting
        ? 'PREEXISTING_ARTIFACT_MISMATCH'
        : 'ARTIFACT_IDENTITY_MISMATCH',
    )
  }
}

/** Builds the only public exact-version result without storage identifiers. */
function createArtifactEvidence(
  artifact: PreparedArtifact,
  versionId: string,
  account: string,
  bucketName: string,
  kmsKeyArn: string,
): WorkspaceSearchMigrationRehearsalArtifactEvidence {
  return Object.freeze({
    kind: artifact.kind,
    contentDigest: artifact.contentDigest,
    byteLength: artifact.byteLength,
    immutableVersionDigest: digestText(
      `${versionDigestDomain}${serializeCanonicalJson({
        account,
        bucketName,
        objectKey: artifact.objectKey,
        versionId,
        kmsKeyArn,
        kind: artifact.kind,
        contentDigest: artifact.contentDigest,
      })}`,
    ),
    retainedUntil: artifact.retainedUntil,
  })
}

/** Compares complete exact S3 user metadata without invoking accessors. */
function metadataEqual(
  candidate: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (candidate === undefined) return false
  const candidateKeys = Object.keys(candidate).sort()
  const expectedKeys = Object.keys(expected).sort()
  return candidateKeys.length === expectedKeys.length &&
    candidateKeys.every((key, index) =>
      key === expectedKeys[index] && candidate[key] === expected[key])
}

/** Reads a plain non-proxy response object. */
function requireResponseRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    throw new Error('INVALID_RESPONSE')
  }
  return value
}

/** Reads one optional own response data property. */
function readOptionalResponseData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return undefined
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new Error('INVALID_RESPONSE')
  }
  return descriptor.value
}

/** Reads one required own response data property. */
function readRequiredResponseData(record: object, key: string): unknown {
  const value = readOptionalResponseData(record, key)
  if (value === undefined) throw new Error('INVALID_RESPONSE')
  return value
}

/** Reads one bounded exact S3 version identifier. */
function readResponseVersionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value === 'null' ||
    value !== value.trim()
  ) {
    throw new Error('INVALID_RESPONSE')
  }
  return value
}

/** Reads one optional safe integer response. */
function readOptionalResponseInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('INVALID_RESPONSE')
  }
  return value
}

/** Reads one optional response string. */
function readOptionalResponseString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('INVALID_RESPONSE')
  return value
}

/** Reads one optional response boolean. */
function readOptionalResponseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error('INVALID_RESPONSE')
  return value
}

/** Reads one optional native Date response as epoch milliseconds. */
function readOptionalResponseDate(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (nodeUtilTypes.isProxy(value) || !nodeUtilTypes.isDate(value)) {
    throw new Error('INVALID_RESPONSE')
  }
  const epoch = Date.prototype.getTime.call(value)
  if (!Number.isSafeInteger(epoch)) throw new Error('INVALID_RESPONSE')
  return epoch
}

/** Reads complete exact string-valued S3 user metadata. */
function readOptionalResponseMetadata(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const record = requireResponseRecord(value)
  const keys = Object.keys(record)
  if (Reflect.ownKeys(record).length !== keys.length || keys.length > 32) {
    throw new Error('INVALID_RESPONSE')
  }
  const result: Record<string, string> = {}
  for (const key of keys) {
    if (!/^[a-z0-9-]{1,128}$/.test(key)) {
      throw new Error('INVALID_RESPONSE')
    }
    const candidate = readRequiredResponseData(record, key)
    if (typeof candidate !== 'string' || candidate.length > 8_192) {
      throw new Error('INVALID_RESPONSE')
    }
    result[key] = candidate
  }
  return result
}

/** Classifies an exclusive-create precondition failure without raw messages. */
function isPreconditionFailure(error: unknown): boolean {
  try {
    return readErrorName(error) === 'PreconditionFailed' ||
      readErrorHttpStatus(error) === 412
  } catch {
    return false
  }
}

/** Classifies transport failures whose Put success is ambiguous. */
function isAmbiguousWriteFailure(error: unknown): boolean {
  try {
    if (error instanceof ArtifactRequestTimeout) return true
    const status = readErrorHttpStatus(error)
    const code = readErrorCode(error)
    const name = readErrorName(error)
    return status === 409 ||
      (status !== undefined && status >= 500) ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      name === 'AbortError' ||
      name === 'TimeoutError'
  } catch {
    return false
  }
}

/** Safely reads a candidate Error name. */
function readErrorName(error: unknown): string | undefined {
  if (nodeUtilTypes.isProxy(error) || !(error instanceof Error)) {
    return undefined
  }
  return readOptionalErrorString(error, 'name')
}

/** Safely reads a candidate transport error code. */
function readErrorCode(error: unknown): string | undefined {
  if (nodeUtilTypes.isProxy(error) || !(error instanceof Error)) {
    return undefined
  }
  return readOptionalErrorString(error, 'code')
}

/** Safely reads Smithy HTTP response metadata. */
function readErrorHttpStatus(error: unknown): number | undefined {
  if (nodeUtilTypes.isProxy(error) || !(error instanceof Error)) {
    return undefined
  }
  const metadata = readOptionalInheritedData(error, '$metadata')
  if (metadata === undefined) return undefined
  const record = requireResponseRecord(metadata)
  const status = readOptionalResponseData(record, 'httpStatusCode')
  return status === undefined ? undefined : readOptionalResponseInteger(status)
}

/** Reads one optional inherited string data property from an Error. */
function readOptionalErrorString(
  error: Error,
  key: string,
): string | undefined {
  const value = readOptionalInheritedData(error, key)
  return value === undefined ? undefined : readOptionalResponseString(value)
}

/** Reads one inherited data property while rejecting accessors and proxies. */
function readOptionalInheritedData(receiver: object, key: string): unknown {
  let current: object | null = receiver
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) throw new Error('INVALID_ERROR')
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, 'value')) {
        throw new Error('INVALID_ERROR')
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

/** Computes lowercase SHA-256 over exact bytes. */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Computes lowercase SHA-256 over one domain-separated UTF-8 string. */
function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Runs one synchronous operation behind the stable redacted boundary. */
function runArtifactAwsBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    return replaceArtifactAwsFailure(error)
  }
}

/** Runs one asynchronous operation behind the stable redacted boundary. */
async function runArtifactAwsAsyncBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    return replaceArtifactAwsFailure(error)
  }
}

/** Preserves only this adapter's stable errors and redacts all others. */
function replaceArtifactAwsFailure(error: unknown): never {
  const code = readArtifactAwsFailureCode(error)
  if (code !== undefined) {
    throw new WorkspaceSearchMigrationRehearsalArtifactAwsError(code)
  }
  throw new WorkspaceSearchMigrationRehearsalArtifactAwsError(
    'INVALID_ARGUMENT',
  )
}

/** Safely reads this adapter's own stable failure code. */
function readArtifactAwsFailureCode(
  error: unknown,
): WorkspaceSearchMigrationRehearsalArtifactAwsFailureCode | undefined {
  if (
    nodeUtilTypes.isProxy(error) ||
    !(error instanceof WorkspaceSearchMigrationRehearsalArtifactAwsError)
  ) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    !isArtifactAwsFailureCode(descriptor.value)
  ) {
    return undefined
  }
  return descriptor.value
}

/** Checks one value against the finite stable failure-code set. */
function isArtifactAwsFailureCode(
  value: unknown,
): value is WorkspaceSearchMigrationRehearsalArtifactAwsFailureCode {
  return value === 'ARTIFACT_IDENTITY_MISMATCH' ||
    value === 'INVALID_ARGUMENT' ||
    value === 'PERMIT_INACTIVE' ||
    value === 'PREEXISTING_ARTIFACT_MISMATCH' ||
    value === 'PUBLICATION_FAILED' ||
    value === 'PUBLICATION_UNRESOLVED' ||
    value === 'PUBLISHER_CLOSED' ||
    value === 'TRANSPORT_CLOSE_FAILED'
}

/** Raises one stable raw-value-free adapter failure. */
function failArtifactAws(
  code: WorkspaceSearchMigrationRehearsalArtifactAwsFailureCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalArtifactAwsError(code)
}
