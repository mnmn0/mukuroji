import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'bun:test'
import {
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION,
  type CrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityTableResourceTarget,
} from '../../data-integrity/cross-domain-integrity'
import {
  createWorkspaceSearchConfigurationHash,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationTableRole,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'
import {
  createWorkspaceSearchMigrationRehearsalPrePermitRootSession,
  createWorkspaceSearchMigrationRehearsalRootTimeline,
  type WorkspaceSearchMigrationRehearsalRootAttestationOperation,
} from './migration-rehearsal-pre-permit-root-session'
import {
  measureWorkspaceSearchMigrationRehearsalRootConfiguration,
} from './migration-rehearsal-root-measurement'

/** Fixed test policy digest shared by every fake aggregate. */
const policyVersion = 'a'.repeat(64)

/** Fixed isolated test account. */
const account = '123456789012'

/** Fixed isolated test Region. */
const region = 'ap-northeast-1'

/** Canonical migration table roles. */
const migrationTableRoles = Object.freeze([
  'project-directory',
  'work-items',
  'collaboration',
  'documents',
  'workspace-search',
  'migration-state',
] satisfies readonly WorkspaceSearchMigrationTableRole[])

/** Canonical integrity table targets. */
const integrityTableTargets = Object.freeze([
  'table:audit-events',
  'table:file-proofing',
  'table:project-directory',
  'table:work-item-configuration',
  'table:work-items',
  'table:workspace-access',
] satisfies readonly CrossDomainIntegrityTableResourceTarget[])

/** Creates one structurally complete measured migration table identity. */
function createMigrationTableIdentity(
  role: WorkspaceSearchMigrationTableRole,
): MigrationTableIdentity {
  const tableName = `root-${role}`
  return {
    role,
    tableName,
    tableArn: `arn:aws:dynamodb:${region}:${account}:table/${tableName}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-08-01T00:00:00.000Z',
    account,
    region,
    key: [],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-08-01T00:00:00.000Z',
    },
  }
}

/** Creates one exact measured configuration object for causal root tests. */
function createMeasuredConfiguration(): WorkspaceSearchMigrationConfiguration {
  const tables: Partial<
    Record<WorkspaceSearchMigrationTableRole, MigrationTableIdentity>
  > = {}
  for (const role of migrationTableRoles) {
    Object.defineProperty(tables, role, {
      configurable: true,
      enumerable: true,
      value: createMigrationTableIdentity(role),
      writable: true,
    })
  }
  const projectDirectory = tables['project-directory']
  const workItems = tables['work-items']
  const collaboration = tables.collaboration
  const documents = tables.documents
  const workspaceSearch = tables['workspace-search']
  const migrationState = tables['migration-state']
  if (
    projectDirectory === undefined ||
    workItems === undefined ||
    collaboration === undefined ||
    documents === undefined ||
    workspaceSearch === undefined ||
    migrationState === undefined
  ) throw new Error('Invalid test table fixture.')
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account,
    region,
    profile: 'root-session-test',
    commit: 'b'.repeat(40),
    callerArn:
      `arn:aws:sts::${account}:assumed-role/MigrationRehearsal/root-test`,
    callerRoleId: 'AROA12345678901234567',
    tables: {
      'project-directory': projectDirectory,
      'work-items': workItems,
      collaboration,
      documents,
      'workspace-search': workspaceSearch,
      'migration-state': migrationState,
    },
    journal: {
      bucketName: 'root-journal-bucket',
      keyArn:
        `arn:aws:kms:${region}:${account}:key/11111111-2222-4333-8444-555555555555`,
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
      accessLogBucket: 'root-journal-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/** Creates one complete immutable-resource attestation fixture. */
function createResourceAttestation(): CrossDomainIntegrityResourceAttestation {
  return {
    kind: CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND,
    version: CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account,
    region,
    bucket: {
      target: 'bucket:file',
      bucketName: 'root-file-bucket',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'root-marker-version',
        checksumSha256: Buffer.alloc(32, 7).toString('base64'),
        size: 128,
      },
    },
    tables: integrityTableTargets.map((target, index) => ({
      target,
      tableName: `root-integrity-${index}`,
      tableArn:
        `arn:aws:dynamodb:${region}:${account}:table/root-integrity-${index}`,
      tableId: `root-integrity-table-id-${index}`,
      creationTime: '2026-08-01T00:00:00.000Z',
    })),
  }
}

/** Creates one detached aggregate with the requested attempt count. */
function createRateEvidence(
  attemptCount: number,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion,
    attemptCount,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    awsServiceThrottleCount: 0,
    rehearsalInjectedThrottleCount: 0,
    budgetStopCount: 0,
    operationalBudgetStopCount: 0,
    awsServiceThrottleBudgetStopCount: 0,
    rehearsalInjectedBudgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: attemptCount === 0 ? 0 : 1,
  }
}

/** Creates one controllable fake managed rate owner. */
function createRateHarness(closeOrder: string[]) {
  let evidence = createRateEvidence(0)
  let interrupted = false
  let closed = false
  let closeFailure = false
  const rate: WorkspaceSearchMigrationManagedDescribeTableRate = {
    describeTable: async () => {
      throw new Error('Unexpected direct DescribeTable call.')
    },
    runCheckpointPage: async (_input, task) => await task(),
    runMandatoryCleanup: async (task) => await task(),
    runNonPageOperation: async (task) => await task(),
    runWithMutationAdmissionGuard: async (guard, task) => {
      guard()
      return await task()
    },
    assertNewDataIoAllowed: () => {
      if (interrupted || closed) throw new Error('Rate owner inactive.')
    },
    claimAfterLease: async () => undefined,
    interrupt: () => {
      interrupted = true
    },
    quarantine: () => {
      interrupted = true
    },
    readEvidence: () => Object.freeze({ ...evidence }),
    closeAndReadEvidence: async () => {
      if (!closed) closeOrder.push('rate')
      closed = true
      if (closeFailure) throw new Error('raw rate close failure')
      return Object.freeze({ ...evidence })
    },
    close: async () => {
      await rate.closeAndReadEvidence()
    },
  }
  return {
    rate,
    advance: (attemptCount: number): void => {
      evidence = createRateEvidence(attemptCount)
    },
    failClose: (): void => {
      closeFailure = true
    },
    readInterrupted: (): boolean => interrupted,
  }
}

/** Creates one valid exact-six attestation operation. */
function createAttestationOperation(
  advance: (attemptCount: number) => void,
  closeOrder: string[],
  options: {
    /** Optional invalid first sequence selected by an adversarial test. */
    readonly firstAttemptSequence?: number
    /** Optional raw operation failure. */
    readonly fail?: boolean
  } = {},
): WorkspaceSearchMigrationRehearsalRootAttestationOperation {
  const resourceAttestation = createResourceAttestation()
  let closed = false
  return {
    run: async () => {
      if (options.fail === true) throw new Error('raw attestation failure')
      advance(12)
      return {
        resourceAttestation,
        sequence: {
          kind:
            'mukuroji-workspace-search-migration-rehearsal-integrity-rate-sequence',
          version: 1,
          phase: 'integrity-check',
          tablePassCount: 1,
          describeTableCallCount: 6,
          firstAttemptSequence: options.firstAttemptSequence ?? 7,
          lastAttemptSequence: 12,
          tableOrderBindingDigest: 'c'.repeat(64),
        },
      }
    },
    close: () => {
      if (closed) return
      closed = true
      closeOrder.push('attestation')
    },
  }
}

/** Creates one complete core session and its controllable dependencies. */
function createSessionFixture(
  options: {
    /** Attempt count installed after the measurement call. */
    readonly measurementAttemptCount?: number
    /** Whether the measurement must remain pending until root cancellation. */
    readonly measurementNeverSettles?: boolean
    /** Optional reviewed configuration digest override. */
    readonly expectedConfigurationBindingDigest?: string
    /** Optional invalid first attestation sequence. */
    readonly firstAttemptSequence?: number
    /** Optional raw attestation operation failure. */
    readonly attestationFailure?: boolean
    /** Optional caller cancellation combined with the root deadline. */
    readonly signal?: AbortSignal
  } = {},
) {
  const closeOrder: string[] = []
  const rateHarness = createRateHarness(closeOrder)
  const configuration = createMeasuredConfiguration()
  let measurementCloseCount = 0
  let completionClockSampledAfterAllCloses = false
  const timeline = createWorkspaceSearchMigrationRehearsalRootTimeline({
    maximumDurationMilliseconds: 60_000,
    monotonicClock: () => 100,
    wallClock: () => {
      if (closeOrder.at(-1) === 'attestation') {
        completionClockSampledAfterAllCloses = true
      }
      return new Date('2026-08-01T00:00:00.000Z')
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const session =
    createWorkspaceSearchMigrationRehearsalPrePermitRootSession({
      measurementPort: {
        measureConfiguration: async () => {
          if (options.measurementNeverSettles === true) {
            return await new Promise<WorkspaceSearchMigrationConfiguration>(
              () => undefined,
            )
          }
          rateHarness.advance(options.measurementAttemptCount ?? 6)
          return configuration
        },
        readDescribeTableRateEvidence: () =>
          rateHarness.rate.readEvidence(),
      },
      closeMeasurementPort: async () => {
        measurementCloseCount += 1
        if (measurementCloseCount === 1) closeOrder.push('measurement')
      },
      rate: rateHarness.rate,
      attestationOperation: createAttestationOperation(
        rateHarness.advance,
        closeOrder,
        {
          ...(options.firstAttemptSequence === undefined
            ? {}
            : { firstAttemptSequence: options.firstAttemptSequence }),
          ...(options.attestationFailure === undefined
            ? {}
            : { fail: options.attestationFailure }),
        },
      ),
      expectedConfigurationBindingDigest:
        options.expectedConfigurationBindingDigest ??
        createWorkspaceSearchConfigurationHash(configuration),
      expectedPolicyVersion: policyVersion,
      timeline,
    })
  return {
    closeOrder,
    configuration,
    rateHarness,
    session,
    readMeasurementCloseCount: () => measurementCloseCount,
    readCompletionClockSampledAfterAllCloses: () =>
      completionClockSampledAfterAllCloses,
  }
}

/** Requires one promise to fail only at the stable root-session boundary. */
async function expectRootFailure(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: 'WorkspaceSearchMigrationRehearsalPrePermitRootSessionError',
    code: 'INVALID_REHEARSAL_PRE_PERMIT_ROOT_SESSION',
  })
}

describe('pre-permit root core session', () => {
  test('exposes only ordered root operations and seals exact clean evidence', async () => {
    const fixture = createSessionFixture()
    expect(Object.keys(fixture.session).sort()).toEqual([])
    for (const forbidden of [
      'describeTable',
      'rate',
      'scan',
      'transport',
      'createRateManagedMeasurementSession',
    ]) {
      expect(Reflect.get(fixture.session, forbidden)).toBeUndefined()
    }

    const port = fixture.session.takeMeasurementPort()
    expect(Object.keys(port).sort()).toEqual([
      'measureConfiguration',
      'readDescribeTableRateEvidence',
    ])
    const measurement =
      await measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port,
        expectedConfigurationBindingDigest:
          createWorkspaceSearchConfigurationHash(fixture.configuration),
      })
    expect(measurement.configuration).toBe(fixture.configuration)
    const attestation = await fixture.session.attestResources()
    const seal = await fixture.session.seal()

    expect(seal.resourceAttestation).toBe(attestation)
    expect(seal.sequence).toMatchObject({
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      describeTableCallCount: 6,
    })
    expect(seal.durableEvidence).toMatchObject({
      attemptCount: 12,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
    })
    expect(seal.startedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(seal.completedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(fixture.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
    expect(fixture.readCompletionClockSampledAfterAllCloses()).toBeTrue()
    await fixture.session.close()
    expect(fixture.readMeasurementCloseCount()).toBe(1)
  })

  test('rejects reordering and drains every owned dependency', async () => {
    const fixture = createSessionFixture()
    await expectRootFailure(fixture.session.attestResources())
    expect(fixture.rateHarness.readInterrupted()).toBeTrue()
    expect(fixture.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
  })

  test('rejects measurement replay and closes before further root work', async () => {
    const fixture = createSessionFixture()
    const port = fixture.session.takeMeasurementPort()
    await expect(port.measureConfiguration()).resolves.toBe(
      fixture.configuration,
    )
    await expectRootFailure(port.measureConfiguration())
    await expectRootFailure(fixture.session.attestResources())
    expect(fixture.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
  })

  test('rejects an invalid six-call measurement delta and closes', async () => {
    const fixture = createSessionFixture({ measurementAttemptCount: 5 })
    const port = fixture.session.takeMeasurementPort()
    await expectRootFailure(port.measureConfiguration())
    expect(fixture.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
  })

  test('rejects a measurement outside the root-plan configuration binding', async () => {
    const fixture = createSessionFixture({
      expectedConfigurationBindingDigest: 'f'.repeat(64),
    })
    const port = fixture.session.takeMeasurementPort()
    await expectRootFailure(port.measureConfiguration())
    expect(fixture.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
  })

  test('rejects substituted sequence claims and attestation replay', async () => {
    const invalid = createSessionFixture({ firstAttemptSequence: 8 })
    const invalidPort = invalid.session.takeMeasurementPort()
    await invalidPort.measureConfiguration()
    await expectRootFailure(invalid.session.attestResources())
    expect(invalid.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])

    const replay = createSessionFixture()
    const replayPort = replay.session.takeMeasurementPort()
    await replayPort.measureConfiguration()
    await replay.session.attestResources()
    await expectRootFailure(replay.session.attestResources())
    await expectRootFailure(replay.session.seal())
    expect(replay.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
  })

  test('drains all transports even when rate close itself fails', async () => {
    const fixture = createSessionFixture()
    fixture.rateHarness.failClose()
    await expectRootFailure(fixture.session.close())
    expect(fixture.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
  })

  test('propagates explicit interruption into exact-once drainage', async () => {
    const fixture = createSessionFixture()
    fixture.session.interrupt()
    await fixture.session.close()
    expect(fixture.rateHarness.readInterrupted()).toBeTrue()
    expect(fixture.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
  })

  test('cancels a pending measurement through the complete root signal', async () => {
    const callerCancellation = new AbortController()
    const fixture = createSessionFixture({
      measurementNeverSettles: true,
      signal: callerCancellation.signal,
    })
    const port = fixture.session.takeMeasurementPort()
    const pendingMeasurement = port.measureConfiguration()
    callerCancellation.abort()
    await expectRootFailure(pendingMeasurement)
    expect(fixture.rateHarness.readInterrupted()).toBeTrue()
    expect(fixture.closeOrder).toEqual([
      'rate',
      'measurement',
      'attestation',
    ])
  })

  test('rejects construction accessors without invoking their traps', () => {
    const closeOrder: string[] = []
    const rateHarness = createRateHarness(closeOrder)
    const timeline = createWorkspaceSearchMigrationRehearsalRootTimeline({
      maximumDurationMilliseconds: 60_000,
      monotonicClock: () => 0,
      wallClock: () => new Date('2026-08-01T00:00:00.000Z'),
    })
    let measurementGetterRead = false
    const maliciousSessionInput = {
      get measurementPort(): never {
        measurementGetterRead = true
        throw new Error('raw measurement getter trap')
      },
      closeMeasurementPort: async () => undefined,
      rate: rateHarness.rate,
      attestationOperation: createAttestationOperation(
        rateHarness.advance,
        closeOrder,
      ),
      expectedConfigurationBindingDigest:
        createWorkspaceSearchConfigurationHash(
          createMeasuredConfiguration(),
        ),
      expectedPolicyVersion: policyVersion,
      timeline,
    }
    expect(() =>
      createWorkspaceSearchMigrationRehearsalPrePermitRootSession(
        maliciousSessionInput,
      )
    ).toThrow('INVALID_REHEARSAL_PRE_PERMIT_ROOT_SESSION')
    expect(measurementGetterRead).toBeFalse()

    let durationGetterRead = false
    const maliciousTimelineInput = {
      get maximumDurationMilliseconds(): never {
        durationGetterRead = true
        throw new Error('raw duration getter trap')
      },
      monotonicClock: () => 0,
      wallClock: () => new Date('2026-08-01T00:00:00.000Z'),
    }
    expect(() =>
      createWorkspaceSearchMigrationRehearsalRootTimeline(
        maliciousTimelineInput,
      )
    ).toThrow('INVALID_REHEARSAL_PRE_PERMIT_ROOT_SESSION')
    expect(durationGetterRead).toBeFalse()

    let prototypeSignalGetterRead = false
    const maliciousTimelinePrototype = {}
    Object.defineProperty(maliciousTimelinePrototype, 'signal', {
      get: () => {
        prototypeSignalGetterRead = true
        throw new Error('raw prototype signal getter trap')
      },
    })
    const maliciousPrototypeTimelineInput = Object.create(
      maliciousTimelinePrototype,
    )
    Object.defineProperties(maliciousPrototypeTimelineInput, {
      maximumDurationMilliseconds: {
        enumerable: true,
        value: 60_000,
      },
      monotonicClock: {
        enumerable: true,
        value: () => 0,
      },
      wallClock: {
        enumerable: true,
        value: () => new Date('2026-08-01T00:00:00.000Z'),
      },
    })
    expect(() =>
      createWorkspaceSearchMigrationRehearsalRootTimeline(
        maliciousPrototypeTimelineInput,
      )
    ).toThrow('INVALID_REHEARSAL_PRE_PERMIT_ROOT_SESSION')
    expect(prototypeSignalGetterRead).toBeFalse()
  })
})
