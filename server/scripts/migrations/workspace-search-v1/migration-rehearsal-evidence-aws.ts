import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import {
  verifyWorkspaceSearchMigrationRehearsalEvidenceIndex,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalAttestationEvidence,
} from './migration-rehearsal-evidence'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import { isHexDigest } from './migration-contract'

/** Media type of the canonical rehearsal evidence index. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_CONTENT_TYPE =
  'application/json'

const evidenceObjectKeyPrefix =
  'workspace-search/v1/rehearsal/evidence-index'
const maximumRequestTimeoutMilliseconds = 30_000
const minimumRetentionAfterCompletionMilliseconds =
  365 * 24 * 60 * 60 * 1_000
const maximumRetentionAfterCompletionMilliseconds =
  366 * 24 * 60 * 60 * 1_000
const minimumRetentionHeadroomMilliseconds = 60_000
const verificationKeyByteLength = 32
const versionDigestDomain =
  'mukuroji-workspace-search-migration-rehearsal-evidence/v1/version\0'
const locatorDigestDomain =
  'mukuroji-workspace-search-migration-rehearsal-evidence/v1/locator\0'

/** Stable redacted failure categories for immutable evidence publication. */
export type WorkspaceSearchMigrationRehearsalEvidenceAwsFailureCode =
  | 'EVIDENCE_IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'PREEXISTING_EVIDENCE_MISMATCH'
  | 'PUBLICATION_FAILED'
  | 'PUBLICATION_UNRESOLVED'
  | 'PUBLISHER_CLOSED'
  | 'TRANSPORT_CLOSE_FAILED'

/** Raw-value-free failure raised by the immutable evidence AWS boundary. */
export class WorkspaceSearchMigrationRehearsalEvidenceAwsError
  extends Error {
  /** Stable secret-free failure category. */
  readonly code: WorkspaceSearchMigrationRehearsalEvidenceAwsFailureCode

  /**
   * Creates one redacted evidence publication failure.
   *
   * @param code - Stable failure category containing no resource identifier.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalEvidenceAwsFailureCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalEvidenceAwsError'
    this.code = code
  }
}

/**
 * Narrow closeable S3 transport used by the evidence publisher.
 *
 * Implementations must bind each AbortSignal to the underlying SDK request.
 */
export interface WorkspaceSearchMigrationRehearsalEvidenceAwsTransport {
  /**
   * Sends one adapter-owned conditional PutObject command.
   *
   * @param command - Exact immutable publication command.
   * @param abortSignal - Finite request and publisher-lifecycle signal.
   * @returns Untrusted raw SDK response.
   */
  putEvidence(
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<unknown>

  /**
   * Sends one adapter-owned current or version-pinned HeadObject command.
   *
   * @param command - Exact reconciliation command.
   * @param abortSignal - Finite request and publisher-lifecycle signal.
   * @returns Untrusted raw SDK response.
   */
  headEvidence(
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<unknown>

  /** Releases the underlying SDK client exactly once. */
  close(): void
}

/**
 * Trusted clock used to reject expired or unbounded retention requests.
 *
 * @returns Current trusted adapter time.
 */
export type WorkspaceSearchMigrationRehearsalEvidenceAwsClock = () => Date

/** Exact resource binding and dependencies for one evidence publisher. */
export type CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput = {
  /** Expected twelve-digit AWS account owning the journal bucket. */
  readonly account: string
  /** Exact immutable journal bucket selected by the non-production session. */
  readonly bucketName: string
  /** Trusted adapter clock. */
  readonly clock: WorkspaceSearchMigrationRehearsalEvidenceAwsClock
  /** Exact customer-managed KMS key ARN required on every stored version. */
  readonly kmsKeyArn: string
  /** Explicit AWS region shared by the session and KMS key. */
  readonly region: string
  /** Finite deadline for each individual S3 request. */
  readonly requestTimeoutMilliseconds: number
  /** Session-derived commit, measurement, and authenticated AWS attestations. */
  readonly sessionBinding:
    WorkspaceSearchMigrationRehearsalEvidenceSessionBinding
  /** Narrow closeable transport sharing the authenticated non-production session. */
  readonly transport: WorkspaceSearchMigrationRehearsalEvidenceAwsTransport
}

/** Trusted session facts that every published evidence index must reproduce. */
export type WorkspaceSearchMigrationRehearsalEvidenceSessionBinding = {
  /** Exact reviewed commit authenticated by the non-production permit. */
  readonly commit: string
  /** Exact measured configuration hash owned by the publishing session. */
  readonly configurationHash: string
  /** SHA-256 digest of the permit-approved child/runtime evidence HMAC key. */
  readonly evidenceKeyDigest: string
  /** SHA-256 digest of the parent-only final-publication HMAC key. */
  readonly publicationKeyDigest: string
  /** Digests derived from the authenticated permit, STS caller, and tags. */
  readonly attestation:
    WorkspaceSearchMigrationRehearsalAttestationEvidence
}

/** Canonical evidence bytes and fixed immutable retention horizon. */
export type PublishWorkspaceSearchMigrationRehearsalEvidenceInput = {
  /** Exact canonical, structurally validated authenticated evidence bytes. */
  readonly evidenceBytes: Uint8Array
  /** Exact canonical UTC COMPLIANCE retention deadline. */
  readonly retainedUntil: string
  /**
   * Dedicated 32-byte HMAC key whose ownership transfers to this invocation.
   *
   * The caller-owned buffer is overwritten before any AWS request and the
   * publisher's detached copy is overwritten immediately after verification.
   */
  readonly verificationKey: Uint8Array
}

/** Identifier-free immutable publication projection safe for external evidence. */
export type WorkspaceSearchMigrationRehearsalEvidencePublication = {
  /** Exact canonical evidence byte length. */
  readonly byteLength: number
  /** SHA-256 digest of the exact canonical evidence bytes. */
  readonly contentDigest: string
  /** Domain-separated digest of the exact immutable S3 version identifier. */
  readonly immutableVersionDigest: string
  /** Domain-separated digest binding bucket, object, version, and KMS identity. */
  readonly storageLocatorDigest: string
  /** Exact canonical UTC Object Lock deadline. */
  readonly retainedUntil: string
}

/** Closeable immutable evidence publication capability. */
export interface WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher {
  /**
   * Exclusively publishes or exactly reconciles one canonical evidence index.
   *
   * @param input - Canonical bytes and fixed COMPLIANCE retention deadline.
   * @returns Identifier-free exact-version publication projection.
   */
  publishEvidence(
    input: PublishWorkspaceSearchMigrationRehearsalEvidenceInput,
  ): Promise<WorkspaceSearchMigrationRehearsalEvidencePublication>

  /** Aborts outstanding requests and releases the transport exactly once. */
  close(): void
}

/** Detached narrow transport operations retained by one publisher. */
type PreparedEvidenceTransport = {
  /** Detached conditional upload operation. */
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
  /** Exact expected bucket owner. */
  readonly account: string
  /** Exact journal bucket. */
  readonly bucketName: string
  /** Detached trusted epoch clock. */
  readonly clock: () => number
  /** Exact customer-managed KMS key ARN. */
  readonly kmsKeyArn: string
  /** Finite request deadline. */
  readonly requestTimeoutMilliseconds: number
  /** Detached exact session facts required from the index. */
  readonly sessionBinding:
    WorkspaceSearchMigrationRehearsalEvidenceSessionBinding
  /** Detached transport operations. */
  readonly transport: PreparedEvidenceTransport
}

/** Fully detached immutable evidence material. */
type PreparedEvidence = {
  /** Exact canonical evidence bytes. */
  readonly bytes: Uint8Array
  /** Exact canonical byte length. */
  readonly byteLength: number
  /** Lowercase SHA-256 content digest. */
  readonly contentDigest: string
  /** Base64 SHA-256 required by S3. */
  readonly checksumSha256: string
  /** Content-addressed adapter-owned object key. */
  readonly objectKey: string
  /** Complete safe exact S3 user metadata. */
  readonly metadata: Readonly<Record<string, string>>
  /** Canonical Object Lock deadline. */
  readonly retainedUntil: string
  /** Exact Object Lock deadline epoch. */
  readonly retainedUntilEpochMilliseconds: number
}

/** Detached fields required from an exact HeadObject response. */
type EvidenceHeadSnapshot = {
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
class EvidenceRequestTimeout extends Error {
  /** Creates a redacted request timeout. */
  constructor() {
    super('EVIDENCE_REQUEST_TIMEOUT')
    this.name = 'EvidenceRequestTimeout'
  }
}

const inputGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failEvidenceAws('INVALID_ARGUMENT'),
)

/**
 * Creates a publisher bound to one measured non-production journal identity.
 *
 * @param input - Exact resource identity, limits, clock, and narrow transport.
 * @returns Closeable immutable evidence publisher.
 */
export function createWorkspaceSearchMigrationRehearsalEvidenceAwsPublisher(
  input: CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput,
): WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher {
  return runEvidenceAwsBoundary(() => {
    const prepared = preparePublisherInput(input)
    return new AwsWorkspaceSearchMigrationRehearsalEvidencePublisher(
      prepared,
    )
  })
}

/** Concrete immutable evidence publisher with a one-way lifecycle. */
class AwsWorkspaceSearchMigrationRehearsalEvidencePublisher
  implements WorkspaceSearchMigrationRehearsalEvidenceAwsPublisher {
  /** Exact expected bucket owner. */
  private readonly account: string

  /** Exact journal bucket. */
  private readonly bucketName: string

  /** Detached trusted epoch clock. */
  private readonly clock: () => number

  /** Exact customer-managed KMS key ARN. */
  private readonly kmsKeyArn: string

  /** Finite request deadline. */
  private readonly requestTimeoutMilliseconds: number

  /** Session-derived evidence facts fixed before publication. */
  private readonly sessionBinding:
    WorkspaceSearchMigrationRehearsalEvidenceSessionBinding

  /** Detached narrow transport. */
  private readonly transport: PreparedEvidenceTransport

  /** One-way controller aborting all outstanding requests on close. */
  private readonly lifecycleController = new AbortController()

  /** Whether the transport has already been released. */
  private closed = false

  /**
   * Creates one publisher from already detached validated material.
   *
   * @param input - Prepared publisher dependencies.
   */
  constructor(input: PreparedPublisherInput) {
    this.account = input.account
    this.bucketName = input.bucketName
    this.clock = input.clock
    this.kmsKeyArn = input.kmsKeyArn
    this.requestTimeoutMilliseconds =
      input.requestTimeoutMilliseconds
    this.sessionBinding = input.sessionBinding
    this.transport = input.transport
  }

  /**
   * Exclusively stores or reconciles one canonical evidence index.
   *
   * @param input - Exact canonical bytes and retention deadline.
   * @returns Identifier-free immutable publication projection.
   */
  async publishEvidence(
    input: PublishWorkspaceSearchMigrationRehearsalEvidenceInput,
  ): Promise<WorkspaceSearchMigrationRehearsalEvidencePublication> {
    return runEvidenceAwsAsyncBoundary(async () => {
      this.requireOpen()
      const prepared = prepareEvidence(
        input,
        this.clock,
        this.requestTimeoutMilliseconds,
        this.sessionBinding,
      )
      let output: unknown
      try {
        output = await this.runRequest((abortSignal) =>
          this.transport.put(
            this.createPutCommand(prepared),
            abortSignal,
          ))
      } catch (error: unknown) {
        if (readEvidenceAwsFailureCode(error) !== undefined) throw error
        if (isPreconditionFailure(error)) {
          return this.reconcileEvidence(prepared, undefined, true)
        }
        if (isAmbiguousWriteFailure(error)) {
          return this.reconcileEvidence(prepared, undefined, false)
        }
        return failEvidenceAws('PUBLICATION_FAILED')
      }

      const versionId = tryReadVersionId(output)
      return this.reconcileEvidence(prepared, versionId, false)
    })
  }

  /** Aborts outstanding work and releases the transport exactly once. */
  close(): void {
    runEvidenceAwsBoundary(() => {
      if (this.closed) return
      this.closed = true
      this.lifecycleController.abort()
      try {
        this.transport.close()
      } catch {
        return failEvidenceAws('TRANSPORT_CLOSE_FAILED')
      }
    })
  }

  /** Requires this publisher lifecycle to remain open. */
  private requireOpen(): void {
    if (this.closed) return failEvidenceAws('PUBLISHER_CLOSED')
  }

  /**
   * Creates the exact exclusive COMPLIANCE PutObject command.
   *
   * @param evidence - Fully detached evidence material.
   * @returns Adapter-owned immutable upload command.
   */
  private createPutCommand(evidence: PreparedEvidence): PutObjectCommand {
    return new PutObjectCommand({
      Bucket: this.bucketName,
      Key: evidence.objectKey,
      Body: evidence.bytes,
      ContentLength: evidence.byteLength,
      ContentType:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_CONTENT_TYPE,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: evidence.checksumSha256,
      IfNoneMatch: '*',
      ExpectedBucketOwner: this.account,
      Metadata: { ...evidence.metadata },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: this.kmsKeyArn,
      BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate:
        new Date(evidence.retainedUntilEpochMilliseconds),
    })
  }

  /**
   * Reconciles a successful or ambiguous write through an exact version HEAD.
   *
   * When the Put response has no trustworthy version, a current HEAD is used
   * only to discover the version. A second version-pinned HEAD is always the
   * authority used for identity and content verification.
   *
   * @param evidence - Exact attempted publication.
   * @param requestedVersionId - Version returned by a successful Put.
   * @param preexisting - Whether S3 explicitly rejected exclusive creation.
   * @returns Identifier-free verified publication projection.
   */
  private async reconcileEvidence(
    evidence: PreparedEvidence,
    requestedVersionId: string | undefined,
    preexisting: boolean,
  ): Promise<WorkspaceSearchMigrationRehearsalEvidencePublication> {
    let versionId = requestedVersionId
    if (versionId === undefined) {
      const current = await this.readHead(evidence.objectKey)
      versionId = tryReadVersionId(current)
      if (versionId === undefined) {
        return failEvidenceAws('PUBLICATION_UNRESOLVED')
      }
    }
    const exact = await this.readHead(evidence.objectKey, versionId)
    const snapshot = readHeadSnapshot(exact)
    requireEvidenceHeadIdentity(
      snapshot,
      versionId,
      evidence,
      this.kmsKeyArn,
    )
    requireEvidenceHeadContent(snapshot, evidence, preexisting)
    return createPublicationProjection(
      evidence,
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
   * @param versionId - Optional exact immutable version.
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
      if (readEvidenceAwsFailureCode(error) !== undefined) throw error
      return failEvidenceAws('PUBLICATION_UNRESOLVED')
    }
  }

  /**
   * Runs one transport operation under request and publisher deadlines.
   *
   * @param operation - Exact transport call receiving the combined signal.
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
        reject(new EvidenceRequestTimeout())
      }, this.requestTimeoutMilliseconds)
    })
    const lifecycle = new Promise<never>((_resolve, reject) => {
      /** Aborts the request and rejects when the owning publisher closes. */
      const listener = (): void => {
        requestController.abort()
        reject(new WorkspaceSearchMigrationRehearsalEvidenceAwsError(
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
      if (timeoutIdentifier !== undefined) {
        clearTimeout(timeoutIdentifier)
      }
      removeLifecycleListener()
    }
  }
}

/** Detaches and validates one publisher construction input. */
function preparePublisherInput(
  input: CreateWorkspaceSearchMigrationRehearsalEvidenceAwsPublisherInput,
): PreparedPublisherInput {
  const record = inputGuards.requireRecord(input)
  inputGuards.requireExactKeys(record, [
    'account',
    'bucketName',
    'clock',
    'kmsKeyArn',
    'region',
    'requestTimeoutMilliseconds',
    'sessionBinding',
    'transport',
  ])
  const account = readAccount(inputGuards.readOwn(record, 'account'))
  const region = readRegion(inputGuards.readOwn(record, 'region'))
  const bucketName = readBucketName(
    inputGuards.readOwn(record, 'bucketName'),
  )
  const kmsKeyArn = readKmsKeyArn(
    inputGuards.readOwn(record, 'kmsKeyArn'),
    account,
    region,
  )
  const requestTimeoutMilliseconds = readPositiveInteger(
    inputGuards.readOwn(record, 'requestTimeoutMilliseconds'),
    maximumRequestTimeoutMilliseconds,
  )
  return {
    account,
    bucketName,
    clock: snapshotClock(inputGuards.readOwn(record, 'clock')),
    kmsKeyArn,
    requestTimeoutMilliseconds,
    sessionBinding: readSessionBinding(
      inputGuards.readOwn(record, 'sessionBinding'),
    ),
    transport: snapshotTransport(
      inputGuards.readOwn(record, 'transport'),
    ),
  }
}

/** Reads one exact session-derived evidence binding. */
function readSessionBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalEvidenceSessionBinding {
  const record = inputGuards.requireRecord(value)
  inputGuards.requireExactKeys(record, [
    'attestation',
    'commit',
    'configurationHash',
    'evidenceKeyDigest',
    'publicationKeyDigest',
  ])
  const commit = inputGuards.readOwn(record, 'commit')
  const configurationHash = inputGuards.readOwn(
    record,
    'configurationHash',
  )
  const evidenceKeyDigest = inputGuards.readOwn(
    record,
    'evidenceKeyDigest',
  )
  const publicationKeyDigest = inputGuards.readOwn(
    record,
    'publicationKeyDigest',
  )
  if (
    typeof commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(commit) ||
    !isHexDigest(configurationHash) ||
    !isHexDigest(evidenceKeyDigest) ||
    !isHexDigest(publicationKeyDigest) ||
    evidenceKeyDigest === publicationKeyDigest
  ) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  const attestationRecord = inputGuards.requireRecord(
    inputGuards.readOwn(record, 'attestation'),
  )
  inputGuards.requireExactKeys(attestationRecord, [
    'callerAttestationDigest',
    'permitDigest',
    'productionIsolationDigest',
    'resourceAttestationDigest',
    'stage',
  ])
  const stage = inputGuards.readOwn(attestationRecord, 'stage')
  const permitDigest = inputGuards.readOwn(
    attestationRecord,
    'permitDigest',
  )
  const callerAttestationDigest = inputGuards.readOwn(
    attestationRecord,
    'callerAttestationDigest',
  )
  const resourceAttestationDigest = inputGuards.readOwn(
    attestationRecord,
    'resourceAttestationDigest',
  )
  const productionIsolationDigest = inputGuards.readOwn(
    attestationRecord,
    'productionIsolationDigest',
  )
  if (
    stage !== 'non-production' ||
    !isHexDigest(permitDigest) ||
    !isHexDigest(callerAttestationDigest) ||
    !isHexDigest(resourceAttestationDigest) ||
    !isHexDigest(productionIsolationDigest)
  ) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  return Object.freeze({
    commit,
    configurationHash,
    evidenceKeyDigest,
    publicationKeyDigest,
    attestation: Object.freeze({
      stage,
      permitDigest,
      callerAttestationDigest,
      resourceAttestationDigest,
      productionIsolationDigest,
    }),
  })
}

/** Requires an authenticated index to reproduce its owning session facts. */
function requireEvidenceSessionBinding(
  index: ReturnType<
    typeof verifyWorkspaceSearchMigrationRehearsalEvidenceIndex
  >,
  expected: WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
): void {
  const actual = index.attestation
  const attestation = expected.attestation
  if (
    index.commit !== expected.commit ||
    index.configurationHash !== expected.configurationHash ||
    actual.stage !== attestation.stage ||
    actual.permitDigest !== attestation.permitDigest ||
    actual.callerAttestationDigest !==
      attestation.callerAttestationDigest ||
    actual.resourceAttestationDigest !==
      attestation.resourceAttestationDigest ||
    actual.productionIsolationDigest !==
      attestation.productionIsolationDigest
  ) {
    return failEvidenceAws('EVIDENCE_IDENTITY_MISMATCH')
  }
}

/** Detaches and strictly validates one publication request. */
function prepareEvidence(
  input: PublishWorkspaceSearchMigrationRehearsalEvidenceInput,
  clock: () => number,
  requestTimeoutMilliseconds: number,
  sessionBinding: WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
): PreparedEvidence {
  const record = inputGuards.requireRecord(input)
  inputGuards.requireExactKeys(record, [
    'evidenceBytes',
    'retainedUntil',
    'verificationKey',
  ])
  const verificationKey = consumeVerificationKey(
    inputGuards.readOwn(record, 'verificationKey'),
  )
  try {
    if (
      digestBytes(verificationKey) !==
        sessionBinding.publicationKeyDigest
    ) {
      return failEvidenceAws('EVIDENCE_IDENTITY_MISMATCH')
    }
    const bytes = copyEvidenceBytes(
      inputGuards.readOwn(record, 'evidenceBytes'),
    )
    const index = verifyWorkspaceSearchMigrationRehearsalEvidenceIndex(
      bytes,
      verificationKey,
    )
    requireEvidenceSessionBinding(index, sessionBinding)
    const retainedUntil = inputGuards.readTimestamp(
      inputGuards.readOwn(record, 'retainedUntil'),
    )
    const retainedUntilEpochMilliseconds = Date.parse(retainedUntil)
    const completedAtEpochMilliseconds = Date.parse(index.completedAt)
    const now = clock()
    const headroom = retainedUntilEpochMilliseconds - now
    const retentionAfterCompletion =
      retainedUntilEpochMilliseconds - completedAtEpochMilliseconds
    if (
      !Number.isSafeInteger(retainedUntilEpochMilliseconds) ||
      !Number.isSafeInteger(completedAtEpochMilliseconds) ||
      !Number.isSafeInteger(headroom) ||
      !Number.isSafeInteger(retentionAfterCompletion) ||
      headroom <
        minimumRetentionHeadroomMilliseconds + requestTimeoutMilliseconds ||
      retentionAfterCompletion <
        minimumRetentionAfterCompletionMilliseconds ||
      retentionAfterCompletion >
        maximumRetentionAfterCompletionMilliseconds
    ) {
      return failEvidenceAws('INVALID_ARGUMENT')
    }
    const contentDigest = digestBytes(bytes)
    const byteLength = bytes.byteLength
    const objectKey =
      `${evidenceObjectKeyPrefix}/${contentDigest}.json`
    const metadata = Object.freeze({
      'mukuroji-evidence-kind': index.kind,
      'mukuroji-evidence-contract-version': String(index.contractVersion),
      'mukuroji-evidence-content-sha256': contentDigest,
      'mukuroji-evidence-byte-length': String(byteLength),
      'mukuroji-evidence-configuration-sha256': index.configurationHash,
      'mukuroji-evidence-key-fingerprint':
        index.authentication.keyFingerprint,
      'mukuroji-evidence-retain-until': retainedUntil,
    })
    return {
      bytes,
      byteLength,
      contentDigest,
      checksumSha256: createHash('sha256').update(bytes).digest('base64'),
      objectKey,
      metadata,
      retainedUntil,
      retainedUntilEpochMilliseconds,
    }
  } finally {
    Uint8Array.prototype.fill.call(verificationKey, 0)
  }
}

/**
 * Detaches and consumes one exact evidence verification key.
 *
 * Ownership transfer prevents an invocation key from lingering in the caller
 * after the authenticated bytes become eligible for immutable publication.
 */
function consumeVerificationKey(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  const buffer = inputGuards.readIntrinsicBuffer(value)
  const byteLength = inputGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength !== verificationKeyByteLength
  ) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
    Uint8Array.prototype.fill.call(value, 0)
  } catch {
    Uint8Array.prototype.fill.call(copy, 0)
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  return copy
}

/** Copies a bounded non-shared Uint8Array. */
function copyEvidenceBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  const buffer = inputGuards.readIntrinsicBuffer(value)
  const byteLength = inputGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_MAX_BYTES
  ) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  return copy
}

/** Snapshots one trusted native Date-returning clock. */
function snapshotClock(value: unknown): () => number {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  return () => {
    const candidate: unknown = Reflect.apply(value, undefined, [])
    if (
      nodeUtilTypes.isProxy(candidate) ||
      !nodeUtilTypes.isDate(candidate)
    ) {
      return failEvidenceAws('INVALID_ARGUMENT')
    }
    const epoch = Date.prototype.getTime.call(candidate)
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      return failEvidenceAws('INVALID_ARGUMENT')
    }
    return epoch
  }
}

/** Snapshots narrow transport methods without retaining mutable properties. */
function snapshotTransport(value: unknown): PreparedEvidenceTransport {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  const put = readMethod(value, 'putEvidence')
  const head = readMethod(value, 'headEvidence')
  const close = readMethod(value, 'close')
  return {
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
      return failEvidenceAws('INVALID_ARGUMENT')
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failEvidenceAws('INVALID_ARGUMENT')
      }
      const method: unknown = descriptor.value
      if (typeof method !== 'function') {
        return failEvidenceAws('INVALID_ARGUMENT')
      }
      return (argumentsList) =>
        Reflect.apply(method, receiver, argumentsList)
    }
    current = Object.getPrototypeOf(current)
  }
  return failEvidenceAws('INVALID_ARGUMENT')
}

/** Reads a strict AWS account identifier. */
function readAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value)) {
    return failEvidenceAws('INVALID_ARGUMENT')
  }
  return value
}

/** Reads a conservative AWS region identifier. */
function readRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value)
  ) {
    return failEvidenceAws('INVALID_ARGUMENT')
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
    return failEvidenceAws('INVALID_ARGUMENT')
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
    return failEvidenceAws('INVALID_ARGUMENT')
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
    return failEvidenceAws('INVALID_ARGUMENT')
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
function readHeadSnapshot(value: unknown): EvidenceHeadSnapshot {
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
    return failEvidenceAws('EVIDENCE_IDENTITY_MISMATCH')
  }
}

/** Requires exact immutable storage identity on a version-pinned HEAD. */
function requireEvidenceHeadIdentity(
  snapshot: EvidenceHeadSnapshot,
  versionId: string,
  evidence: PreparedEvidence,
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
      evidence.retainedUntilEpochMilliseconds
  ) {
    return failEvidenceAws('EVIDENCE_IDENTITY_MISMATCH')
  }
}

/** Requires exact content, checksum, media type, and user metadata. */
function requireEvidenceHeadContent(
  snapshot: EvidenceHeadSnapshot,
  evidence: PreparedEvidence,
  preexisting: boolean,
): void {
  if (
    snapshot.contentLength !== evidence.byteLength ||
    snapshot.contentType !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_CONTENT_TYPE ||
    snapshot.checksumSha256 !== evidence.checksumSha256 ||
    (snapshot.checksumType !== undefined &&
      snapshot.checksumType !== 'FULL_OBJECT') ||
    !metadataEqual(snapshot.metadata, evidence.metadata)
  ) {
    return failEvidenceAws(
      preexisting
        ? 'PREEXISTING_EVIDENCE_MISMATCH'
        : 'EVIDENCE_IDENTITY_MISMATCH',
    )
  }
}

/** Builds the only public exact-version result without raw S3 identifiers. */
function createPublicationProjection(
  evidence: PreparedEvidence,
  versionId: string,
  account: string,
  bucketName: string,
  kmsKeyArn: string,
): WorkspaceSearchMigrationRehearsalEvidencePublication {
  const exactVersionIdentity =
    `${account}\0${bucketName}\0${evidence.objectKey}\0` +
    `${versionId}\0${kmsKeyArn}`
  return {
    byteLength: evidence.byteLength,
    contentDigest: evidence.contentDigest,
    immutableVersionDigest: digestText(
      `${versionDigestDomain}${exactVersionIdentity}`,
    ),
    storageLocatorDigest: digestText(
      `${locatorDigestDomain}${exactVersionIdentity}`,
    ),
    retainedUntil: evidence.retainedUntil,
  }
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
function readOptionalResponseData(
  record: object,
  key: string,
): unknown {
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
  if (
    Reflect.ownKeys(record).length !== keys.length ||
    keys.length > 32
  ) {
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
    if (error instanceof EvidenceRequestTimeout) return true
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
  return status === undefined
    ? undefined
    : readOptionalResponseInteger(status)
}

/** Reads one optional inherited string data property from an Error. */
function readOptionalErrorString(
  error: Error,
  key: string,
): string | undefined {
  const value = readOptionalInheritedData(error, key)
  return value === undefined
    ? undefined
    : readOptionalResponseString(value)
}

/** Reads one inherited data property while rejecting accessors and proxies. */
function readOptionalInheritedData(
  receiver: object,
  key: string,
): unknown {
  let current: object | null = receiver
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      throw new Error('INVALID_ERROR')
    }
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
function runEvidenceAwsBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    return replaceEvidenceAwsFailure(error)
  }
}

/** Runs one asynchronous operation behind the stable redacted boundary. */
async function runEvidenceAwsAsyncBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    return replaceEvidenceAwsFailure(error)
  }
}

/** Preserves only this adapter's stable errors and redacts all others. */
function replaceEvidenceAwsFailure(error: unknown): never {
  const code = readEvidenceAwsFailureCode(error)
  if (code !== undefined) {
    throw new WorkspaceSearchMigrationRehearsalEvidenceAwsError(code)
  }
  throw new WorkspaceSearchMigrationRehearsalEvidenceAwsError(
    'INVALID_ARGUMENT',
  )
}

/** Safely reads this adapter's own stable failure code. */
function readEvidenceAwsFailureCode(
  error: unknown,
): WorkspaceSearchMigrationRehearsalEvidenceAwsFailureCode | undefined {
  if (
    nodeUtilTypes.isProxy(error) ||
    !(error instanceof WorkspaceSearchMigrationRehearsalEvidenceAwsError)
  ) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    !isEvidenceAwsFailureCode(descriptor.value)
  ) {
    return undefined
  }
  return descriptor.value
}

/** Checks one value against the finite stable failure-code set. */
function isEvidenceAwsFailureCode(
  value: unknown,
): value is WorkspaceSearchMigrationRehearsalEvidenceAwsFailureCode {
  return value === 'EVIDENCE_IDENTITY_MISMATCH' ||
    value === 'INVALID_ARGUMENT' ||
    value === 'PREEXISTING_EVIDENCE_MISMATCH' ||
    value === 'PUBLICATION_FAILED' ||
    value === 'PUBLICATION_UNRESOLVED' ||
    value === 'PUBLISHER_CLOSED' ||
    value === 'TRANSPORT_CLOSE_FAILED'
}

/** Raises one stable raw-value-free adapter failure. */
function failEvidenceAws(
  code: WorkspaceSearchMigrationRehearsalEvidenceAwsFailureCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalEvidenceAwsError(code)
}
