import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchConfigurationHash,
  type MigrationTableIdentity,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationTableRole,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationCommittedPrefixApplySealGateway,
  WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE,
  type WorkspaceSearchMigrationCommittedPrefixApplySealAwsClock,
  type WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway,
  type WriteWorkspaceSearchMigrationCommittedPrefixApplySealInput,
} from './migration-committed-prefix-apply-seal-aws'
import {
  serializeWorkspaceSearchMigrationCommittedPrefixApplySeal,
  type WorkspaceSearchMigrationCommittedPrefixApplySealReference,
} from './migration-committed-prefix-apply-seal'
import type {
  ReadWorkspaceSearchMigrationImmutableArtifactInput,
  WorkspaceSearchMigrationImmutableArtifactAwsPort,
  WorkspaceSearchMigrationImmutableArtifactReference,
  WriteWorkspaceSearchMigrationImmutableArtifactInput,
} from './migration-immutable-artifact-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'

const runId = 'committed-prefix-run-1'
const nowTimestamp = '2026-07-30T00:00:00.000Z'
const sealCreatedAt = nowTimestamp
const retentionDayMilliseconds = 24 * 60 * 60 * 1_000

/**
 * In-memory immutable object dependency with controllable hostile responses.
 */
class ImmutableArtifactHarness
implements WorkspaceSearchMigrationImmutableArtifactAwsPort {
  /** Exact immutable writes observed by the dependency. */
  readonly writes:
    WriteWorkspaceSearchMigrationImmutableArtifactInput[] = []

  /** Exact-version reads observed by the dependency. */
  readonly reads:
    ReadWorkspaceSearchMigrationImmutableArtifactInput[] = []

  /** Last detached bytes accepted by a successful write. */
  storedBytes: Uint8Array | undefined

  /** Optional write response replacing the adapter-owned valid reference. */
  writeReferenceReplacement:
    WorkspaceSearchMigrationImmutableArtifactReference | undefined

  /** Optional read bytes replacing the last successfully written bytes. */
  readBytesReplacement: Uint8Array | undefined

  /** Optional raw write failure used to verify error replacement. */
  writeFailure: unknown

  /** Optional raw read failure used to verify error replacement. */
  readFailure: unknown

  /**
   * Stores detached bytes and returns one content-addressed exact version.
   *
   * @param input - Exact codec-owned immutable write.
   * @returns Exact immutable version reference.
   */
  async writeImmutableArtifact(
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure
    }
    const detached = detachWrite(input)
    this.writes.push(detached)
    this.storedBytes = Uint8Array.from(detached.bytes)
    const valid = createStoredReference(detached)
    return this.writeReferenceReplacement ?? valid
  }

  /**
   * Returns detached exact-version bytes or one selected hostile replacement.
   *
   * @param input - Exact codec-owned immutable read.
   * @returns Detached stored bytes.
   */
  async readImmutableArtifact(
    input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<Uint8Array> {
    if (this.readFailure !== undefined) {
      throw this.readFailure
    }
    this.reads.push(detachRead(input))
    if (this.readBytesReplacement !== undefined) {
      return this.readBytesReplacement
    }
    if (this.storedBytes === undefined) {
      throw new Error('tenant-secret-missing-prefix-seal')
    }
    return Uint8Array.from(this.storedBytes)
  }
}

describe('Workspace Search committed-prefix apply-seal AWS gateway', () => {
  test('writes and reads exact content-addressed bytes through captured dependency methods', async () => {
    const fixture = createFixture()
    const harness = new ImmutableArtifactHarness()
    const gateway = createGateway(fixture.configuration, harness)
    let replacementCalls = 0
    Object.defineProperty(harness, 'writeImmutableArtifact', {
      configurable: true,
      value: async () => {
        replacementCalls += 1
        throw new Error('tenant-secret-replaced-write')
      },
    })
    Object.defineProperty(harness, 'readImmutableArtifact', {
      configurable: true,
      value: async () => {
        replacementCalls += 1
        throw new Error('tenant-secret-replaced-read')
      },
    })

    const reference =
      await gateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      })
    const bytes =
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        fixture.seal,
      )
    const contentDigest = digestBytes(bytes)
    const expectedPrefix =
      `${fixture.configuration.journalPrefix}/runs/${runId}/${fixture.configurationHash}`

    expect(reference).toEqual({
      scope: 'committed-prefix',
      objectKey:
        `${expectedPrefix}/${WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE}/${contentDigest}.artifact`,
      versionId: 'prefix-seal-version-1',
      contentDigest,
      byteLength: bytes.byteLength,
      retainUntil: fixture.expectedRetainUntil,
    })
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0]).toEqual({
      role:
        WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE,
      objectKeyPrefix: expectedPrefix,
      bytes,
      metadata: {
        'mukuroji-apply-seal-kind':
          'workspace-search-committed-prefix-apply-seal-v1',
        'mukuroji-apply-seal-run-id': runId,
        'mukuroji-apply-seal-configuration-sha256':
          fixture.configurationHash,
      },
      retainUntil: fixture.expectedRetainUntil,
    })
    expect(
      await gateway.readCommittedPrefixApplySeal(reference),
    ).toEqual(fixture.seal)
    expect(harness.reads).toEqual([
      {
        role:
          WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE,
        objectKeyPrefix: expectedPrefix,
        reference: {
          objectKey: reference.objectKey,
          versionId: reference.versionId,
          contentDigest: reference.contentDigest,
          byteLength: reference.byteLength,
          retainUntil: reference.retainUntil,
        },
        metadata: {
          'mukuroji-apply-seal-kind':
            'workspace-search-committed-prefix-apply-seal-v1',
          'mukuroji-apply-seal-run-id': runId,
          'mukuroji-apply-seal-configuration-sha256':
            fixture.configurationHash,
        },
      },
    ])
    expect(replacementCalls).toBe(0)
  })

  test('creates a fresh configured retention horizon for a committed prefix', async () => {
    const fixture = createFixture()
    const harness = new ImmutableArtifactHarness()
    const gateway = createGateway(fixture.configuration, harness)

    await expect(
      gateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      }),
    ).resolves.toMatchObject({
      retainUntil: fixture.expectedRetainUntil,
    })
    expect(
      Date.parse(fixture.expectedRetainUntil) -
        Date.parse(nowTimestamp),
    ).toBe(
      (fixture.configuration.journal.defaultRetentionDays + 1) *
        retentionDayMilliseconds,
    )
    expect(
      Date.parse(fixture.expectedRetainUntil) -
        Date.parse(nowTimestamp),
    ).toBeGreaterThan(
      WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
    )
    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal({
        seal: {
          ...fixture.seal,
          createdAt: '2026-07-30T00:00:00.001Z',
        },
      }),
    )

    const hostileClockGateway = createGateway(
      fixture.configuration,
      new ImmutableArtifactHarness(),
      () => new Proxy(new Date(nowTimestamp), {}),
    )
    await expectStorageFailure(
      hostileClockGateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      }),
    )
  })

  test('recovers the same exact version after clock advance and process restart', async () => {
    const fixture = createFixture()
    const harness = new ImmutableArtifactHarness()
    let clockTimestamp = nowTimestamp
    const clock = () => new Date(clockTimestamp)
    const firstGateway = createGateway(
      fixture.configuration,
      harness,
      clock,
    )
    const firstReference =
      await firstGateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      })

    clockTimestamp = new Date(
      Date.parse(nowTimestamp) + 60 * 60 * 1_000,
    ).toISOString()
    const restartedGateway = createGateway(
      fixture.configuration,
      harness,
      clock,
    )
    const retriedReference =
      await restartedGateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      })

    expect(retriedReference).toEqual(firstReference)
    expect(harness.writes).toHaveLength(2)
    expect(harness.writes[1]?.retainUntil).toBe(
      harness.writes[0]?.retainUntil,
    )

    clockTimestamp = new Date(
      Date.parse(sealCreatedAt) + retentionDayMilliseconds,
    ).toISOString()
    const expiredRestartWindowHarness =
      new ImmutableArtifactHarness()
    const expiredRestartWindowGateway = createGateway(
      fixture.configuration,
      expiredRestartWindowHarness,
      clock,
    )
    await expectStorageFailure(
      expiredRestartWindowGateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      }),
    )
    expect(expiredRestartWindowHarness.writes).toHaveLength(0)
  })

  test('rejects non-strict input, foreign identity, and invalid storage responses without invoking accessors', async () => {
    const fixture = createFixture()
    const harness = new ImmutableArtifactHarness()
    const gateway = createGateway(fixture.configuration, harness)
    let accessorReads = 0
    const accessorInput:
      WriteWorkspaceSearchMigrationCommittedPrefixApplySealInput = {
        seal: fixture.seal,
      }
    Object.defineProperty(accessorInput, 'seal', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1
        return fixture.seal
      },
    })

    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal(accessorInput),
    )
    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal(
        new Proxy(
          {
            seal: fixture.seal,
          },
          {},
        ),
      ),
    )
    const inputWithExtraKey = {
      seal: fixture.seal,
      retainUntil: fixture.expectedRetainUntil,
    }
    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal(inputWithExtraKey),
    )
    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal({
        seal: {
          ...fixture.seal,
          runId: 'foreign-run',
        },
      }),
    )
    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal({
        seal: {
          ...fixture.seal,
          configurationHash: 'f'.repeat(64),
        },
      }),
    )
    expect(accessorReads).toBe(0)
    expect(harness.writes).toHaveLength(0)

    const validReference =
      await gateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      })
    const validStorageReference =
      createGenericReference(validReference)
    const invalidResponses: readonly
      WorkspaceSearchMigrationImmutableArtifactReference[] = [
        {
          ...validStorageReference,
          objectKey:
            `${fixture.configuration.journalPrefix}/wrong/${validReference.contentDigest}.artifact`,
        },
        {
          ...validStorageReference,
          objectKey: 'é'.repeat(513),
        },
        {
          ...validStorageReference,
          versionId: 'null',
        },
        {
          ...validStorageReference,
          contentDigest: 'e'.repeat(64),
        },
        {
          ...validStorageReference,
          byteLength: validReference.byteLength + 1,
        },
        {
          ...validStorageReference,
          retainUntil: new Date(
            Date.parse(validReference.retainUntil) + 1,
          ).toISOString(),
        },
      ]
    for (const response of invalidResponses) {
      harness.writeReferenceReplacement = response
      await expectStorageFailure(
        gateway.writeCommittedPrefixApplySeal({
          seal: fixture.seal,
        }),
      )
    }
    const responseWithExtraKey = {
      ...validStorageReference,
      unexpected: 'tenant-secret-extra-response',
    }
    harness.writeReferenceReplacement = responseWithExtraKey
    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      }),
    )
    harness.writeReferenceReplacement = new Proxy(
      validStorageReference,
      {},
    )
    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      }),
    )
    harness.writeReferenceReplacement = undefined
    harness.writeFailure =
      new Proxy(new Error('tenant-secret-write-failure'), {})
    await expectStorageFailure(
      gateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      }),
    )
  })

  test('rejects substituted paths, versions, bytes, and self-consistent foreign seals on read', async () => {
    const fixture = createFixture()
    const harness = new ImmutableArtifactHarness()
    const gateway = createGateway(fixture.configuration, harness)
    const reference =
      await gateway.writeCommittedPrefixApplySeal({
        seal: fixture.seal,
      })
    const readCount = harness.reads.length

    await expectStorageFailure(
      gateway.readCommittedPrefixApplySeal({
        ...reference,
        objectKey:
          `${fixture.configuration.journalPrefix}/wrong/${reference.contentDigest}.artifact`,
      }),
    )
    expect(harness.reads).toHaveLength(readCount)

    const tampered = Uint8Array.from(
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        fixture.seal,
      ),
    )
    tampered[tampered.byteLength - 1] =
      (tampered[tampered.byteLength - 1] ?? 0) ^ 1
    harness.readBytesReplacement = tampered
    await expectStorageFailure(
      gateway.readCommittedPrefixApplySeal(reference),
    )

    const shared = new Uint8Array(
      new SharedArrayBuffer(reference.byteLength),
    )
    shared.set(
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        fixture.seal,
      ),
    )
    harness.readBytesReplacement = shared
    await expectStorageFailure(
      gateway.readCommittedPrefixApplySeal(reference),
    )

    harness.readBytesReplacement = new Proxy(
      Uint8Array.from(
        serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
          fixture.seal,
        ),
      ),
      {},
    )
    await expectStorageFailure(
      gateway.readCommittedPrefixApplySeal(reference),
    )

    const foreignSeal: WorkspaceSearchApplySeal = {
      ...fixture.seal,
      runId: 'foreign-run',
    }
    const foreignBytes =
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        foreignSeal,
      )
    const foreignDigest = digestBytes(foreignBytes)
    harness.readBytesReplacement = foreignBytes
    const foreignReference:
      WorkspaceSearchMigrationCommittedPrefixApplySealReference = {
        scope: 'committed-prefix',
        objectKey:
          `${fixture.configuration.journalPrefix}/runs/${runId}/${fixture.configurationHash}/${WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE}/${foreignDigest}.artifact`,
        versionId: 'foreign-version',
        contentDigest: foreignDigest,
        byteLength: foreignBytes.byteLength,
        retainUntil: reference.retainUntil,
      }
    await expectStorageFailure(
      gateway.readCommittedPrefixApplySeal(foreignReference),
    )

    harness.readBytesReplacement = undefined
    harness.readFailure =
      new Proxy(new Error('tenant-secret-read-failure'), {})
    await expectStorageFailure(
      gateway.readCommittedPrefixApplySeal(reference),
    )
  })

  test('fails construction for configuration drift and hostile dependency capabilities', () => {
    const fixture = createFixture()
    expect(() =>
      createAwsWorkspaceSearchMigrationCommittedPrefixApplySealGateway({
        configuration: fixture.configuration,
        configurationHash: 'f'.repeat(64),
        runId,
        immutableArtifactPort: new ImmutableArtifactHarness(),
        clock: () => new Date(nowTimestamp),
      })
    ).toThrow('CONFIGURATION_HASH_MISMATCH')
    expect(() =>
      createGateway(
        fixture.configuration,
        new Proxy(new ImmutableArtifactHarness(), {}),
      )
    ).toThrow(
      'INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_STORAGE',
    )
    const clock = () => new Date(nowTimestamp)
    expect(() =>
      createGateway(
        fixture.configuration,
        new ImmutableArtifactHarness(),
        new Proxy(clock, {}),
      )
    ).toThrow(
      'INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_STORAGE',
    )
    let accessorReads = 0
    const accessorPort = new ImmutableArtifactHarness()
    Object.defineProperty(accessorPort, 'writeImmutableArtifact', {
      enumerable: true,
      get: () => {
        accessorReads += 1
        return () => undefined
      },
    })
    Object.defineProperty(accessorPort, 'readImmutableArtifact', {
      enumerable: true,
      value: () => undefined,
    })
    expect(() =>
      createAwsWorkspaceSearchMigrationCommittedPrefixApplySealGateway({
        configuration: fixture.configuration,
        configurationHash: fixture.configurationHash,
        runId,
        immutableArtifactPort: accessorPort,
        clock,
      })
    ).toThrow(
      'INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_STORAGE',
    )
    expect(accessorReads).toBe(0)
  })
})

/**
 * Complete gateway fixture with one strict pure committed-prefix seal.
 */
type GatewayFixture = {
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Strict pure committed-prefix seal. */
  readonly seal: WorkspaceSearchApplySeal
  /** Deterministic Object Lock horizon anchored to seal creation. */
  readonly expectedRetainUntil: string
}

/**
 * Creates one compact measured gateway fixture.
 *
 * @returns Exact configuration, pure seal, and retention horizon.
 */
function createFixture(): GatewayFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  return {
    configuration,
    configurationHash,
    seal: {
      kind: 'workspace-search-apply-seal',
      sealVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId,
      configurationHash,
      scope: 'committed-prefix',
      planDigest: '1'.repeat(64),
      planOperationCount: 3,
      journalSequence: 1,
      journalHeadDigest: '2'.repeat(64),
      markerCount: 2,
      applyMarkerAggregateDigest: '3'.repeat(64),
      createdAt: sealCreatedAt,
    },
    expectedRetainUntil: new Date(
      Date.parse(sealCreatedAt) +
        (configuration.journal.defaultRetentionDays + 1) *
          retentionDayMilliseconds,
    ).toISOString(),
  }
}

/**
 * Creates one gateway over a controllable immutable dependency.
 *
 * @param configuration - Exact measured configuration.
 * @param immutableArtifactPort - Controllable immutable object port.
 * @param clock - Optional trusted gateway clock.
 * @returns Run/configuration-bound committed-prefix gateway.
 */
function createGateway(
  configuration: WorkspaceSearchMigrationConfiguration,
  immutableArtifactPort:
    WorkspaceSearchMigrationImmutableArtifactAwsPort,
  clock:
    WorkspaceSearchMigrationCommittedPrefixApplySealAwsClock =
      () => new Date(nowTimestamp),
): WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway {
  return createAwsWorkspaceSearchMigrationCommittedPrefixApplySealGateway({
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    runId,
    immutableArtifactPort,
    clock,
  })
}

/**
 * Detaches one immutable write for later exact assertions.
 *
 * @param input - Candidate immutable write.
 * @returns Detached immutable write.
 */
function detachWrite(
  input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
): WriteWorkspaceSearchMigrationImmutableArtifactInput {
  return {
    role: input.role,
    objectKeyPrefix: input.objectKeyPrefix,
    bytes: Uint8Array.from(input.bytes),
    metadata: { ...input.metadata },
    retainUntil: input.retainUntil,
  }
}

/**
 * Detaches one immutable read for later exact assertions.
 *
 * @param input - Candidate immutable read.
 * @returns Detached immutable read.
 */
function detachRead(
  input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
): ReadWorkspaceSearchMigrationImmutableArtifactInput {
  return {
    role: input.role,
    objectKeyPrefix: input.objectKeyPrefix,
    reference: { ...input.reference },
    metadata: { ...input.metadata },
  }
}

/**
 * Creates the exact successful response for one immutable write.
 *
 * @param input - Detached immutable write.
 * @returns Exact content-addressed version reference.
 */
function createStoredReference(
  input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
): WorkspaceSearchMigrationImmutableArtifactReference {
  const contentDigest = digestBytes(input.bytes)
  return {
    objectKey:
      `${input.objectKeyPrefix}/${input.role}/${contentDigest}.artifact`,
    versionId: 'prefix-seal-version-1',
    contentDigest,
    byteLength: input.bytes.byteLength,
    retainUntil: input.retainUntil,
  }
}

/**
 * Projects one rich committed-prefix reference to the generic storage shape.
 *
 * @param reference - Rich exact-version committed-prefix reference.
 * @returns Generic immutable artifact reference without semantic scope.
 */
function createGenericReference(
  reference:
    WorkspaceSearchMigrationCommittedPrefixApplySealReference,
): WorkspaceSearchMigrationImmutableArtifactReference {
  return {
    objectKey: reference.objectKey,
    versionId: reference.versionId,
    contentDigest: reference.contentDigest,
    byteLength: reference.byteLength,
    retainUntil: reference.retainUntil,
  }
}

/**
 * Expects one promise to fail only through the stable storage boundary.
 *
 * @param operation - Candidate asynchronous gateway operation.
 */
async function expectStorageFailure(
  operation: Promise<unknown>,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    code:
      'INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_STORAGE',
    message:
      'INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_STORAGE',
  })
}

/**
 * Computes lowercase SHA-256 over exact bytes.
 *
 * @param bytes - Exact byte sequence.
 * @returns Lowercase hexadecimal digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Creates one measured migration configuration.
 *
 * @returns Complete exact migration configuration.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
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
 * Creates one complete measured table identity.
 *
 * @param role - Exact migration table role.
 * @returns Complete physical table identity.
 */
function createTable(
  role: WorkspaceSearchMigrationTableRole,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key: [{ name: 'pk', role: 'HASH', type: 'S' }],
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
