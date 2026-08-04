import type {
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  createWorkspaceSearchMigrationRehearsalEvidenceIndex,
  serializeWorkspaceSearchMigrationRehearsalEvidenceIndex,
  type WorkspaceSearchMigrationRehearsalEvidenceClaims,
} from './migration-rehearsal-evidence'
import {
  createWorkspaceSearchMigrationRehearsalEvidenceAwsPublisher,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_CONTENT_TYPE,
  type PublishWorkspaceSearchMigrationRehearsalEvidenceInput,
  type WorkspaceSearchMigrationRehearsalEvidenceAwsClock,
  type WorkspaceSearchMigrationRehearsalEvidenceAwsTransport,
} from './migration-rehearsal-evidence-aws'
import {
  createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims,
} from './migration-rehearsal-evidence.test-fixture'

/** Fixed expected account bound to every S3 command. */
const account = '123456789012'

/** Fixed non-production region bound to every S3 command. */
const region = 'ap-northeast-1'

/** Fixed immutable evidence bucket fixture. */
const bucketName = 'mukuroji-nonproduction-migration-evidence'

/** Fixed customer-managed KMS key required by the fixture. */
const kmsKeyArn =
  'arn:aws:kms:ap-northeast-1:123456789012:key/' +
  '00000000-0000-0000-0000-000000000001'

/** Trusted publisher clock after suite completion. */
const now = new Date('2026-08-03T00:00:00.000Z')

/** Retention inside the publisher's exact 365-to-366-day window. */
const retainedUntil = '2027-08-03T00:00:00.000Z'

/** Deterministic immutable S3 object version fixture. */
const versionId = 'evidence-version-0001'

/** Dedicated evidence-index HMAC key. */
const signingKey = new Uint8Array(32).fill(0x11)

/** Distinct child/runtime HMAC key that must not authorize final publication. */
const runtimeEvidenceKey = new Uint8Array(32).fill(0x72)

/** Complete canonical index material used by one publisher invocation. */
type EvidenceFixture = {
  /** Validated suite-derived claims. */
  readonly claims: WorkspaceSearchMigrationRehearsalEvidenceClaims
  /** Exact canonical authenticated evidence bytes. */
  readonly bytes: Uint8Array
}

/** Narrow recording S3 transport with test-controlled behavior. */
class RecordingEvidenceTransport
  implements WorkspaceSearchMigrationRehearsalEvidenceAwsTransport {
  /** Recorded immutable PutObject commands. */
  readonly putCommands: PutObjectCommand[] = []

  /** Recorded current and exact-version HeadObject commands. */
  readonly headCommands: HeadObjectCommand[] = []

  /** Number of transport release requests. */
  closeCount = 0

  /** Test-controlled PutObject behavior. */
  putHandler: (
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ) => Promise<unknown> = async () => ({ VersionId: versionId })

  /** Test-controlled HeadObject behavior. */
  headHandler: (
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ) => Promise<unknown> = async () => {
    throw new Error('Unexpected HeadObject call.')
  }

  /** Records and delegates one conditional evidence upload. */
  putEvidence(
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    this.putCommands.push(command)
    return this.putHandler(command, abortSignal)
  }

  /** Records and delegates one reconciliation HEAD. */
  headEvidence(
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    this.headCommands.push(command)
    return this.headHandler(command, abortSignal)
  }

  /** Records release of the underlying SDK client. */
  close(): void {
    this.closeCount += 1
  }
}

/** Timeout-shaped error modeling a lost response after S3 accepted a write. */
class ResponseLossError extends Error {
  /** Node.js transport code recognized as ambiguous. */
  readonly code = 'ETIMEDOUT'

  /** Creates one response-loss fixture. */
  constructor() {
    super('raw response was lost after S3 accepted the object')
    this.name = 'TimeoutError'
  }
}

/** S3 exclusive-create failure fixture. */
class PreconditionError extends Error {
  /** Smithy-style HTTP response metadata. */
  readonly $metadata = { httpStatusCode: 412 }

  /** Creates one precondition failure fixture. */
  constructor() {
    super('raw preexisting object details')
    this.name = 'PreconditionFailed'
  }
}

/** Returns one deterministic conventional digest for a fixture label. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Creates fresh suite-derived claims and their authenticated canonical bytes. */
async function createEvidenceFixture(): Promise<EvidenceFixture> {
  const claims =
    await createAuthenticWorkspaceSearchMigrationRehearsalEvidenceClaims()
  const bytes = serializeWorkspaceSearchMigrationRehearsalEvidenceIndex(
    createWorkspaceSearchMigrationRehearsalEvidenceIndex({
      evidence: claims,
      signingKey: new Uint8Array(signingKey),
    }),
  )
  return Object.freeze({ claims, bytes })
}

/** Creates one publish request with a fresh invocation-owned key buffer. */
function createPublishInput(
  evidenceBytes: Uint8Array,
): PublishWorkspaceSearchMigrationRehearsalEvidenceInput {
  return {
    evidenceBytes,
    retainedUntil,
    verificationKey: new Uint8Array(signingKey),
  }
}

/** Creates a publisher bound to one suite-derived session and transport. */
function createPublisher(
  transport: RecordingEvidenceTransport,
  claims: WorkspaceSearchMigrationRehearsalEvidenceClaims,
) {
  const clock: WorkspaceSearchMigrationRehearsalEvidenceAwsClock =
    () => new Date(now)
  return createWorkspaceSearchMigrationRehearsalEvidenceAwsPublisher({
    account,
    bucketName,
    clock,
    kmsKeyArn,
    region,
    requestTimeoutMilliseconds: 1_000,
    sessionBinding: {
      commit: claims.commit,
      configurationHash: claims.configurationHash,
      evidenceKeyDigest: createHash('sha256')
        .update(runtimeEvidenceKey)
        .digest('hex'),
      publicationKeyDigest: createHash('sha256')
        .update(signingKey)
        .digest('hex'),
      attestation: claims.attestation,
    },
    transport,
  })
}

/** Creates an exact successful HEAD response from the recorded PUT. */
function createExactHead(
  transport: RecordingEvidenceTransport,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const put = transport.putCommands[0]
  if (put === undefined) throw new Error('Expected a recorded PUT.')
  return {
    VersionId: versionId,
    ContentLength: put.input.ContentLength,
    ContentType: put.input.ContentType,
    ChecksumSHA256: put.input.ChecksumSHA256,
    ChecksumType: 'FULL_OBJECT',
    ServerSideEncryption: put.input.ServerSideEncryption,
    SSEKMSKeyId: put.input.SSEKMSKeyId,
    BucketKeyEnabled: put.input.BucketKeyEnabled,
    DeleteMarker: false,
    ObjectLockMode: put.input.ObjectLockMode,
    ObjectLockRetainUntilDate: put.input.ObjectLockRetainUntilDate,
    Metadata: put.input.Metadata,
    ...overrides,
  }
}

describe('Workspace Search migration rehearsal evidence AWS publisher', () => {
  test('publishes canonical reconciliation-only evidence with exclusive KMS COMPLIANCE shape', async () => {
    const fixture = await createEvidenceFixture()
    const transport = new RecordingEvidenceTransport()
    transport.headHandler = async () => createExactHead(transport)
    const publisher = createPublisher(transport, fixture.claims)
    const input = createPublishInput(fixture.bytes)

    const result = await publisher.publishEvidence(input)

    expect(transport.putCommands).toHaveLength(1)
    const put = transport.putCommands[0]
    if (put === undefined) throw new Error('Expected PutObject command.')
    expect(put.input).toMatchObject({
      Bucket: bucketName,
      ContentLength: fixture.bytes.byteLength,
      ContentType:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_CONTENT_TYPE,
      ChecksumAlgorithm: 'SHA256',
      IfNoneMatch: '*',
      ExpectedBucketOwner: account,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: kmsKeyArn,
      BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: new Date(retainedUntil),
    })
    expect(put.input.Key).toMatch(
      /^workspace-search\/v1\/rehearsal\/evidence-index\/[0-9a-f]{64}\.json$/u,
    )
    expect(put.input.ChecksumSHA256).toBe(
      createHash('sha256').update(fixture.bytes).digest('base64'),
    )
    expect(transport.headCommands).toHaveLength(1)
    expect(transport.headCommands[0]?.input.VersionId).toBe(versionId)
    expect(Object.keys(result).sort()).toEqual([
      'byteLength',
      'contentDigest',
      'immutableVersionDigest',
      'retainedUntil',
      'storageLocatorDigest',
    ])
    expect(JSON.stringify(result)).not.toContain(versionId)
    expect(JSON.stringify(result)).not.toContain(bucketName)
    expect(input.verificationKey.every((value) => value === 0)).toBe(true)
  })

  test('reconciles response loss through current then version-pinned HEAD', async () => {
    const fixture = await createEvidenceFixture()
    const transport = new RecordingEvidenceTransport()
    transport.putHandler = async () => {
      throw new ResponseLossError()
    }
    transport.headHandler = async () => createExactHead(transport)
    const publisher = createPublisher(transport, fixture.claims)

    const result = await publisher.publishEvidence(
      createPublishInput(fixture.bytes),
    )

    expect(result.contentDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(2)
    expect(transport.headCommands[0]?.input.VersionId).toBeUndefined()
    expect(transport.headCommands[1]?.input.VersionId).toBe(versionId)
  })

  test('rejects a preexisting content mismatch without overwriting it', async () => {
    const fixture = await createEvidenceFixture()
    const transport = new RecordingEvidenceTransport()
    transport.putHandler = async () => {
      throw new PreconditionError()
    }
    transport.headHandler = async () => createExactHead(transport, {
      Metadata: {
        'mukuroji-evidence-content-sha256': digest('foreign-content'),
      },
    })
    const publisher = createPublisher(transport, fixture.claims)

    await expect(publisher.publishEvidence(createPublishInput(fixture.bytes)))
      .rejects.toMatchObject({
        code: 'PREEXISTING_EVIDENCE_MISMATCH',
        message: 'PREEXISTING_EVIDENCE_MISMATCH',
      })
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(2)
  })

  test('fails closed when exact-version KMS identity differs', async () => {
    const fixture = await createEvidenceFixture()
    const transport = new RecordingEvidenceTransport()
    transport.headHandler = async () => createExactHead(transport, {
      SSEKMSKeyId:
        'arn:aws:kms:ap-northeast-1:123456789012:key/' +
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
    })
    const publisher = createPublisher(transport, fixture.claims)

    await expect(publisher.publishEvidence(createPublishInput(fixture.bytes)))
      .rejects.toMatchObject({
        code: 'EVIDENCE_IDENTITY_MISMATCH',
        message: 'EVIDENCE_IDENTITY_MISMATCH',
      })
  })

  test('rejects foreign sessions and the distinct runtime key before I/O', async () => {
    const fixture = await createEvidenceFixture()
    const transport = new RecordingEvidenceTransport()
    const publisher = createPublisher(transport, fixture.claims)
    const foreignClaims = Object.freeze({
      ...fixture.claims,
      commit: 'b'.repeat(40),
    })
    const foreignBytes = serializeWorkspaceSearchMigrationRehearsalEvidenceIndex(
      createWorkspaceSearchMigrationRehearsalEvidenceIndex({
        evidence: foreignClaims,
        signingKey: new Uint8Array(signingKey),
      }),
    )
    const foreignKey = new Uint8Array(signingKey)
    await expect(publisher.publishEvidence({
      evidenceBytes: foreignBytes,
      retainedUntil,
      verificationKey: foreignKey,
    })).rejects.toMatchObject({ code: 'EVIDENCE_IDENTITY_MISMATCH' })
    expect(foreignKey.every((value) => value === 0)).toBe(true)

    const wrongKey = new Uint8Array(runtimeEvidenceKey)
    await expect(publisher.publishEvidence({
      evidenceBytes: fixture.bytes,
      retainedUntil,
      verificationKey: wrongKey,
    })).rejects.toMatchObject({ code: 'EVIDENCE_IDENTITY_MISMATCH' })
    expect(wrongKey.every((value) => value === 0)).toBe(true)
    expect(transport.putCommands).toHaveLength(0)
  })

  test('rejects extra raw locator input and insufficient retention before I/O', async () => {
    const fixture = await createEvidenceFixture()
    const transport = new RecordingEvidenceTransport()
    const publisher = createPublisher(transport, fixture.claims)
    const invalidInput = {
      ...createPublishInput(fixture.bytes),
      rawRunId: 'must-not-cross-the-boundary',
    }
    await expect(publisher.publishEvidence(invalidInput)).rejects
      .toMatchObject({ code: 'INVALID_ARGUMENT' })

    const shortKey = new Uint8Array(signingKey)
    await expect(publisher.publishEvidence({
      evidenceBytes: fixture.bytes,
      retainedUntil: '2027-08-02T12:36:59.999Z',
      verificationKey: shortKey,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(shortKey.every((value) => value === 0)).toBe(true)
    expect(transport.putCommands).toHaveLength(0)
  })

  test('closes once, rejects later use, and redacts raw transport failures', async () => {
    const fixture = await createEvidenceFixture()
    const closedTransport = new RecordingEvidenceTransport()
    const closedPublisher = createPublisher(closedTransport, fixture.claims)
    closedPublisher.close()
    closedPublisher.close()
    expect(closedTransport.closeCount).toBe(1)
    await expect(closedPublisher.publishEvidence(
      createPublishInput(fixture.bytes),
    )).rejects.toMatchObject({ code: 'PUBLISHER_CLOSED' })

    const failedTransport = new RecordingEvidenceTransport()
    failedTransport.putHandler = async () => {
      throw new Error('secret bucket and object details')
    }
    const failedPublisher = createPublisher(failedTransport, fixture.claims)
    await expect(failedPublisher.publishEvidence(
      createPublishInput(fixture.bytes),
    )).rejects.toMatchObject({
      code: 'PUBLICATION_FAILED',
      message: 'PUBLICATION_FAILED',
    })
  })
})
