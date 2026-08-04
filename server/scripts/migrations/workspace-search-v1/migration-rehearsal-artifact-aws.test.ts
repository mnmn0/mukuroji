import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type {
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { serializeCanonicalJson } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalArtifactAwsPublisher,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_CONTENT_TYPE,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_MAX_BYTES,
  type CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput,
  type PublishWorkspaceSearchMigrationRehearsalArtifactInput,
  type WorkspaceSearchMigrationRehearsalArtifactAwsTransport,
} from './migration-rehearsal-artifact-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS,
} from './migration-rehearsal-evidence'

const account = '123456789012'
const region = 'ap-northeast-1'
const bucketName = 'mukuroji-nonproduction-migration-evidence'
const kmsKeyArn =
  'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001'
const now = new Date('2026-08-02T00:00:00.000Z')
const completedAt = '2026-08-01T12:00:00.000Z'
const retainedUntil = '2027-08-01T18:00:00.000Z'
const versionId = 'artifact-version-0001'
const accountDigestDomain =
  'mukuroji-workspace-search-migration-rehearsal-artifact/v1/account\0'

/** Narrow recording transport with permit and S3 behavior under test control. */
class RecordingArtifactTransport
  implements WorkspaceSearchMigrationRehearsalArtifactAwsTransport {
  /** Recorded conditional artifact uploads. */
  readonly putCommands: PutObjectCommand[] = []

  /** Recorded current and exact-version reconciliation reads. */
  readonly headCommands: HeadObjectCommand[] = []

  /** Whether the synthetic non-production permit remains active. */
  permitActive = true

  /** Number of synchronous fresh-publication admission checks. */
  admissionCount = 0

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
    throw new Error('Unexpected HeadObject request.')
  }

  /** Requires the synthetic permit to remain active for a fresh upload. */
  admitNewArtifactPublication(): void {
    this.admissionCount += 1
    if (!this.permitActive) {
      throw new Error('raw expired permit and role details')
    }
  }

  /**
   * Records and delegates one conditional artifact upload.
   *
   * @param command - Adapter-owned PutObject command.
   * @param abortSignal - Finite adapter request signal.
   * @returns Test-controlled transport response.
   */
  putArtifact(
    command: PutObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    this.putCommands.push(command)
    return this.putHandler(command, abortSignal)
  }

  /**
   * Records and delegates one reconciliation metadata read.
   *
   * @param command - Adapter-owned HeadObject command.
   * @param abortSignal - Finite adapter request signal.
   * @returns Test-controlled transport response.
   */
  headArtifact(
    command: HeadObjectCommand,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    this.headCommands.push(command)
    return this.headHandler(command, abortSignal)
  }

  /** Records release of the underlying transport. */
  close(): void {
    this.closeCount += 1
  }
}

/** S3 exclusive-create failure fixture. */
class PreconditionError extends Error {
  /** Smithy-like HTTP response metadata. */
  readonly $metadata = { httpStatusCode: 412 }

  /** Creates one secret-bearing precondition fixture. */
  constructor() {
    super('raw preexisting object locator')
    this.name = 'PreconditionFailed'
  }
}

/** Timeout-like transport failure after an uncertain S3 acceptance. */
class ResponseLossError extends Error {
  /** Node transport code recognized as an ambiguous write result. */
  readonly code = 'ETIMEDOUT'

  /** Creates one secret-bearing response-loss fixture. */
  constructor() {
    super('raw response loss containing bucket and object key')
    this.name = 'TimeoutError'
  }
}

/** Computes a deterministic lowercase SHA-256 fixture digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Creates strict canonical child-artifact bytes. */
function createArtifactBytes(label = 'scenario-results'): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson({
    kind: label,
    artifactVersion: 1,
    resultDigest: digest(`result:${label}`),
  }))
}

/** Creates one valid canonical child-artifact publication request. */
function createPublishInput(
  artifactBytes = createArtifactBytes(),
): PublishWorkspaceSearchMigrationRehearsalArtifactInput {
  return {
    artifactBytes,
    completedAt,
    kind: 'scenario-results',
    retainedUntil,
  }
}

/** Creates exact measured non-production session binding fixtures. */
function createSessionBinding():
  CreateWorkspaceSearchMigrationRehearsalArtifactAwsPublisherInput[
    'sessionBinding'
  ] {
  return {
    commit: 'a'.repeat(40),
    configurationHash: digest('configuration'),
    evidenceKeyDigest: digest('evidence-key'),
    publicationKeyDigest: digest('publication-key'),
    attestation: {
      stage: 'non-production',
      permitDigest: digest('permit'),
      callerAttestationDigest: digest('caller-role'),
      resourceAttestationDigest: digest('resources'),
      productionIsolationDigest: digest('production-isolation'),
    },
  }
}

/** Creates one publisher bound to the supplied recording transport. */
function createPublisher(
  transport: RecordingArtifactTransport,
  clock: () => Date = () => new Date(now),
  sessionBinding = createSessionBinding(),
) {
  return createWorkspaceSearchMigrationRehearsalArtifactAwsPublisher({
    account,
    bucketName,
    clock,
    kmsKeyArn,
    region,
    requestTimeoutMilliseconds: 1_000,
    sessionBinding,
    transport,
  })
}

/** Creates an exact successful HEAD response from the recorded PUT. */
function createExactHead(
  transport: RecordingArtifactTransport,
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

describe('Workspace Search migration rehearsal artifact AWS publisher', () => {
  test('publishes exact canonical bytes with session-bound immutable storage and returns only the digest reference', async () => {
    const transport = new RecordingArtifactTransport()
    transport.headHandler = async () => createExactHead(transport)
    const publisher = createPublisher(transport)
    const artifactBytes = createArtifactBytes()

    const result = await publisher.publishArtifact(
      createPublishInput(artifactBytes),
    )

    expect(transport.putCommands).toHaveLength(1)
    const put = transport.putCommands[0]
    if (put === undefined) throw new Error('Expected a PutObject command.')
    const contentDigest = createHash('sha256')
      .update(artifactBytes)
      .digest('hex')
    expect(put.input).toMatchObject({
      Bucket: bucketName,
      ContentLength: artifactBytes.byteLength,
      ContentType:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_CONTENT_TYPE,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: createHash('sha256')
        .update(artifactBytes)
        .digest('base64'),
      IfNoneMatch: '*',
      ExpectedBucketOwner: account,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: kmsKeyArn,
      BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: new Date(retainedUntil),
    })
    expect(put.input.Key).toMatch(
      new RegExp(
        `^workspace-search/v1/rehearsal/evidence-artifact/[0-9a-f]{64}/scenario-results/${contentDigest}\\.json$`,
      ),
    )
    const sessionDigest = put.input.Key?.split('/')[4]
    if (sessionDigest === undefined) {
      throw new Error('Expected an opaque session digest in the object key.')
    }
    expect(put.input.Metadata).toEqual({
      'mukuroji-rehearsal-account-sha256': createHash('sha256')
        .update(`${accountDigestDomain}${account}`)
        .digest('hex'),
      'mukuroji-rehearsal-artifact-kind': 'scenario-results',
      'mukuroji-rehearsal-artifact-version': '1',
      'mukuroji-rehearsal-byte-length': String(artifactBytes.byteLength),
      'mukuroji-rehearsal-caller-sha256': digest('caller-role'),
      'mukuroji-rehearsal-commit': 'a'.repeat(40),
      'mukuroji-rehearsal-configuration-sha256': digest('configuration'),
      'mukuroji-rehearsal-content-sha256': contentDigest,
      'mukuroji-rehearsal-evidence-key-sha256': digest('evidence-key'),
      'mukuroji-rehearsal-publication-key-sha256':
        digest('publication-key'),
      'mukuroji-rehearsal-permit-sha256': digest('permit'),
      'mukuroji-rehearsal-production-isolation-sha256':
        digest('production-isolation'),
      'mukuroji-rehearsal-resource-sha256': digest('resources'),
      'mukuroji-rehearsal-retain-until': retainedUntil,
      'mukuroji-rehearsal-session-sha256': sessionDigest,
    })
    expect(transport.headCommands).toHaveLength(1)
    expect(transport.headCommands[0]?.input).toEqual({
      Bucket: bucketName,
      Key: put.input.Key,
      ExpectedBucketOwner: account,
      ChecksumMode: 'ENABLED',
      VersionId: versionId,
    })
    expect(Object.keys(result).sort()).toEqual([
      'byteLength',
      'contentDigest',
      'immutableVersionDigest',
      'kind',
      'retainedUntil',
    ])
    expect(result).toMatchObject({
      kind: 'scenario-results',
      contentDigest,
      byteLength: artifactBytes.byteLength,
      retainedUntil,
    })
    expect(result.immutableVersionDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(result)).not.toContain(bucketName)
    expect(JSON.stringify(result)).not.toContain(versionId)
  })

  test('isolates identical canonical bytes from a different authenticated session namespace', async () => {
    const bytes = createArtifactBytes()
    const firstTransport = new RecordingArtifactTransport()
    firstTransport.headHandler = async () => createExactHead(firstTransport)
    const firstPublisher = createPublisher(firstTransport)
    const firstResult = await firstPublisher.publishArtifact(
      createPublishInput(bytes),
    )

    const secondTransport = new RecordingArtifactTransport()
    secondTransport.headHandler = async () => createExactHead(secondTransport)
    const binding = createSessionBinding()
    const secondPublisher = createPublisher(secondTransport, () => new Date(now), {
      ...binding,
      attestation: {
        ...binding.attestation,
        permitDigest: digest('different-permit'),
      },
    })
    const secondResult = await secondPublisher.publishArtifact(
      createPublishInput(bytes),
    )

    expect(firstTransport.putCommands[0]?.input.Key).not.toBe(
      secondTransport.putCommands[0]?.input.Key,
    )
    expect(firstTransport.putCommands[0]?.input.Metadata?.[
      'mukuroji-rehearsal-session-sha256'
    ]).not.toBe(secondTransport.putCommands[0]?.input.Metadata?.[
      'mukuroji-rehearsal-session-sha256'
    ])
    expect(firstResult.contentDigest).toBe(secondResult.contentDigest)
    expect(firstResult.immutableVersionDigest).not.toBe(
      secondResult.immutableVersionDigest,
    )
  })

  test('accepts every finite artifact purpose without interpreting purpose-owned canonical payload fields', async () => {
    for (const kind of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS) {
      const transport = new RecordingArtifactTransport()
      transport.headHandler = async () => createExactHead(transport)
      const publisher = createPublisher(transport)
      const bytes = createArtifactBytes(`inner-${kind}`)

      const result = await publisher.publishArtifact({
        artifactBytes: bytes,
        completedAt,
        kind,
        retainedUntil,
      })

      expect(result.kind).toBe(kind)
      expect(transport.putCommands[0]?.input.Key).toContain(`/${kind}/`)
    }
  })

  test('allows exact reconciliation to drain when the permit expires during the admitted Put', async () => {
    const transport = new RecordingArtifactTransport()
    transport.putHandler = async () => {
      transport.permitActive = false
      return { VersionId: versionId }
    }
    transport.headHandler = async () => createExactHead(transport)
    const publisher = createPublisher(transport)

    const result = await publisher.publishArtifact(createPublishInput())

    expect(result.kind).toBe('scenario-results')
    expect(transport.putCommands).toHaveLength(1)
    expect(transport.headCommands).toHaveLength(1)
    expect(transport.admissionCount).toBe(2)
  })

  test('rejects a new publication after permit expiry before any S3 I/O', async () => {
    const transport = new RecordingArtifactTransport()
    const publisher = createPublisher(transport)
    transport.permitActive = false

    await expect(
      publisher.publishArtifact(createPublishInput()),
    ).rejects.toMatchObject({
      code: 'PERMIT_INACTIVE',
      message: 'PERMIT_INACTIVE',
    })
    expect(transport.putCommands).toHaveLength(0)
    expect(transport.headCommands).toHaveLength(0)
  })

  test('reconciles an uncertain response loss after permit expiry through current then exact HEAD', async () => {
    const transport = new RecordingArtifactTransport()
    transport.putHandler = async () => {
      transport.permitActive = false
      throw new ResponseLossError()
    }
    transport.headHandler = async (command) =>
      command.input.VersionId === undefined
        ? { VersionId: versionId }
        : createExactHead(transport)
    const publisher = createPublisher(transport)

    const result = await publisher.publishArtifact(createPublishInput())

    expect(result.kind).toBe('scenario-results')
    expect(transport.headCommands.map((command) => command.input.VersionId))
      .toEqual([undefined, versionId])
    expect(transport.admissionCount).toBe(2)
  })

  test('makes an exact preexisting artifact retry idempotent and rejects conflicting bytes', async () => {
    const matchingTransport = new RecordingArtifactTransport()
    matchingTransport.putHandler = async () => {
      throw new PreconditionError()
    }
    matchingTransport.headHandler = async (command) =>
      command.input.VersionId === undefined
        ? { VersionId: versionId }
        : createExactHead(matchingTransport)
    const matchingPublisher = createPublisher(matchingTransport)

    await expect(
      matchingPublisher.publishArtifact(createPublishInput()),
    ).resolves.toMatchObject({ kind: 'scenario-results' })

    const conflictingTransport = new RecordingArtifactTransport()
    conflictingTransport.putHandler = async () => {
      throw new PreconditionError()
    }
    conflictingTransport.headHandler = async (command) =>
      command.input.VersionId === undefined
        ? { VersionId: versionId }
        : createExactHead(conflictingTransport, {
            ContentLength: 999,
          })
    const conflictingPublisher = createPublisher(conflictingTransport)
    await expect(
      conflictingPublisher.publishArtifact(createPublishInput()),
    ).rejects.toMatchObject({
      code: 'PREEXISTING_ARTIFACT_MISMATCH',
    })
  })

  test('fails closed when exact HEAD changes KMS, retention, checksum, metadata, or version identity', async () => {
    const tamperCases: readonly Readonly<Record<string, unknown>>[] = [
      { SSEKMSKeyId: `${kmsKeyArn}-wrong` },
      { ObjectLockMode: 'GOVERNANCE' },
      { ObjectLockRetainUntilDate: new Date('2027-08-01T17:59:59.999Z') },
      { ChecksumSHA256: digest('wrong-checksum') },
      { Metadata: { unexpected: 'metadata' } },
      { VersionId: 'different-version' },
    ]
    for (const overrides of tamperCases) {
      const transport = new RecordingArtifactTransport()
      transport.headHandler = async () =>
        createExactHead(transport, overrides)
      const publisher = createPublisher(transport)

      await expect(
        publisher.publishArtifact(createPublishInput()),
      ).rejects.toMatchObject({
        code: 'ARTIFACT_IDENTITY_MISMATCH',
      })
    }
  })

  test('rejects noncanonical, malformed, empty, and oversized bytes before S3 I/O', async () => {
    const invalidBytes = [
      new Uint8Array(),
      new TextEncoder().encode('{"z":1, "a":2}'),
      new TextEncoder().encode('[]'),
      new Uint8Array([0xff]),
      new Uint8Array(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACT_MAX_BYTES + 1,
      ),
    ]
    for (const bytes of invalidBytes) {
      const transport = new RecordingArtifactTransport()
      const publisher = createPublisher(transport)
      await expect(
        publisher.publishArtifact(createPublishInput(bytes)),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(transport.putCommands).toHaveLength(0)
      expect(transport.headCommands).toHaveLength(0)
    }
  })

  test('enforces a completed suite and a 365-to-366-day finite retention interval', async () => {
    const cases = [
      {
        completedAt,
        retainedUntil:
          new Date(Date.parse(completedAt) + 365 * 86_400_000 - 1)
            .toISOString(),
      },
      {
        completedAt,
        retainedUntil:
          new Date(Date.parse(completedAt) + 366 * 86_400_000 + 1)
            .toISOString(),
      },
      {
        completedAt: '2026-08-02T00:00:00.001Z',
        retainedUntil,
      },
    ]
    for (const timestamps of cases) {
      const transport = new RecordingArtifactTransport()
      const publisher = createPublisher(transport)
      await expect(publisher.publishArtifact({
        artifactBytes: createArtifactBytes(),
        kind: 'scenario-results',
        ...timestamps,
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(transport.putCommands).toHaveLength(0)
    }
  })

  test('rejects invalid measured session/KMS binding and inactive construction without leaking values', () => {
    const inactiveTransport = new RecordingArtifactTransport()
    inactiveTransport.permitActive = false
    expect(() => createPublisher(inactiveTransport)).toThrow(
      'PERMIT_INACTIVE',
    )

    const transport = new RecordingArtifactTransport()
    const invalidInput: unknown = {
      account,
      bucketName,
      clock: () => new Date(now),
      kmsKeyArn: kmsKeyArn.replace(account, '999999999999'),
      region,
      requestTimeoutMilliseconds: 1_000,
      sessionBinding: {
        ...createSessionBinding(),
        attestation: {
          ...createSessionBinding().attestation,
          stage: 'production',
        },
      },
      transport,
    }
    expect(() => Reflect.apply(
      createWorkspaceSearchMigrationRehearsalArtifactAwsPublisher,
      undefined,
      [invalidInput],
    )).toThrow('INVALID_ARGUMENT')
    const reusedKeyBinding = createSessionBinding()
    expect(() => createPublisher(
      new RecordingArtifactTransport(),
      () => new Date(now),
      {
        ...reusedKeyBinding,
        publicationKeyDigest: reusedKeyBinding.evidenceKeyDigest,
      },
    )).toThrow('INVALID_ARGUMENT')
    expect(transport.putCommands).toHaveLength(0)
  })

  test('redacts terminal transport errors, unresolved versions, and post-close use', async () => {
    const failedTransport = new RecordingArtifactTransport()
    failedTransport.putHandler = async () => {
      throw new Error(`raw ${bucketName} secret payload`)
    }
    const failedPublisher = createPublisher(failedTransport)
    await expect(
      failedPublisher.publishArtifact(createPublishInput()),
    ).rejects.toMatchObject({
      code: 'PUBLICATION_FAILED',
      message: 'PUBLICATION_FAILED',
    })

    const unresolvedTransport = new RecordingArtifactTransport()
    unresolvedTransport.putHandler = async () => ({})
    unresolvedTransport.headHandler = async () => ({})
    const unresolvedPublisher = createPublisher(unresolvedTransport)
    await expect(
      unresolvedPublisher.publishArtifact(createPublishInput()),
    ).rejects.toMatchObject({ code: 'PUBLICATION_UNRESOLVED' })

    const closedTransport = new RecordingArtifactTransport()
    const closedPublisher = createPublisher(closedTransport)
    closedPublisher.close()
    closedPublisher.close()
    expect(closedTransport.closeCount).toBe(1)
    await expect(
      closedPublisher.publishArtifact(createPublishInput()),
    ).rejects.toMatchObject({ code: 'PUBLISHER_CLOSED' })
  })
})
