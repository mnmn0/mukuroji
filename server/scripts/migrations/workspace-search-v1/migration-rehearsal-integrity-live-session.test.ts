import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type {
  DescribeTableCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import type {
  CrossDomainIntegrityAwsTransport,
} from '../../data-integrity/verify-cross-domain-integrity'
import type {
  WorkspaceSearchMigrationDescribeTablePhase,
  WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'
import {
  createWorkspaceSearchMigrationRehearsalRateRecorder,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalRateRecorder,
} from './migration-rehearsal-rate-evidence'
import {
  disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
  finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
  runWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
  WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError,
  type RunWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
  type WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending,
} from './migration-rehearsal-integrity-live-session'

/** Deterministic reviewed policy digest used by every test segment. */
const policyVersion = createHash('sha256')
  .update('live-session-policy')
  .digest('hex')

/** Deterministic measured configuration digest used by every test segment. */
const configurationBindingDigest = createHash('sha256')
  .update('live-session-configuration')
  .digest('hex')

/** Stable runtime rate-record authentication key seed. */
const rateAuthenticationKeySeed = new Uint8Array(32).fill(0x31)

/** Stable dedicated #163 result key seed. */
const integrityDigestKeySeed = new Uint8Array(32).fill(0x42)

/** Stable Workspace Audit pseudonym key seed. */
const auditPseudonymKeySeed = new Uint8Array(32).fill(0x53)

/** Canonical trusted start of every normal live fixture. */
const liveStartedAt = '2026-08-02T00:00:01.000Z'

/** Canonical trusted completion of every normal live fixture. */
const liveCompletedAt = '2026-08-02T00:00:02.000Z'

/** Canonical trusted finalization time of every normal live fixture. */
const liveFinalizedAt = '2026-08-02T00:00:03.000Z'

/** Mutable observations proving which external surfaces were reached. */
type LiveSessionObservations = {
  /** Number of DescribeTable calls that reached the managed rate owner. */
  rateDescribeTableCount: number
  /** Number of forbidden DescribeTable calls that reached the base transport. */
  baseDescribeTableCount: number
  /** Number of STS account reads. */
  callerIdentityCount: number
  /** Number of caller-owned transport close calls. */
  borrowedTransportCloseCount: number
  /** Ordered trusted wall-clock and STS events. */
  readonly order: string[]
}

/** Options controlling one deterministic actual checker fixture. */
type CreateLiveSessionFixtureOptions = {
  /** Fails the managed rate call after this many successful calls. */
  readonly failRateAfterSuccessfulCalls?: number
  /** STS account returned by the borrowed transport. */
  readonly callerAccount?: string
  /** Unique authenticated successor segment locator seed. */
  readonly segmentTag?: string
  /** Trusted monotonic samples returned in exact deadline-read order. */
  readonly monotonicClockSamples?: readonly number[]
  /** Trusted wall-clock samples returned in exact invocation order. */
  readonly wallClockSamples?: readonly string[]
}

/** One ready actual-checker session with its still-open raw segment recorder. */
type LiveSessionFixture = {
  /** Caller-owned Audit key expected to be overwritten by run. */
  readonly auditPseudonymKey: Uint8Array
  /** Complete strict runner input. */
  readonly input: RunWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput
  /** Caller-owned #163 key expected to be overwritten by run. */
  readonly integrityDigestKey: Uint8Array
  /** External surface observations. */
  readonly observations: LiveSessionObservations
  /** Exact authenticated immediate predecessor segment. */
  readonly predecessor: WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Recorder receiving the actual checker's twelve rate-owned calls. */
  readonly recorder: WorkspaceSearchMigrationRehearsalRateRecorder
  /** Exact immutable attestation used by the actual checker. */
  readonly resourceAttestation: CrossDomainIntegrityResourceAttestation
}

/** One successfully executed pending session plus its closed current segment. */
type CompletedLiveSession = LiveSessionFixture & {
  /** Exact committed segment containing the twelve actual checker calls. */
  readonly current: WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Genuine one-shot pending result authority. */
  readonly pending: WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending
}

/** Creates one conventional lowercase SHA-256 digest. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Creates one canonical private immutable seven-resource attestation. */
function createResourceAttestation(): CrossDomainIntegrityResourceAttestation {
  const account = '123456789012'
  const region = 'ap-northeast-1'
  const tableNames = [
    'audit-events-live-table',
    'file-proofing-live-table',
    'project-directory-live-table',
    'work-item-configuration-live-table',
    'work-items-live-table',
    'workspace-access-live-table',
  ]
  return {
    kind: 'mukuroji-cross-domain-integrity-resource-attestation',
    version: 1,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account,
    region,
    bucket: {
      target: 'bucket:file',
      bucketName: 'mukuroji-live-files',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'file-bucket-marker-version-1',
        checksumSha256: Buffer.alloc(32, 0x61).toString('base64'),
        size: 128,
      },
    },
    tables: CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS.map(
      (target, index) => {
        const tableName = tableNames[index] ?? ''
        return {
          target,
          tableName,
          tableArn:
            `arn:aws:dynamodb:${region}:${account}:table/${tableName}`,
          tableId: `immutable-live-table-id-${index + 1}`,
          creationTime: `2026-01-0${index + 1}T00:00:00.000Z`,
        }
      },
    ),
  }
}

/** Creates a detached canonical owner-only attestation byte vector. */
function resourceAttestationBytes(
  resourceAttestation: CrossDomainIntegrityResourceAttestation,
): Uint8Array {
  return new TextEncoder().encode(
    serializeCrossDomainIntegrityResourceAttestation(resourceAttestation),
  )
}

/** Creates one cumulative clean managed-rate aggregate. */
function rateEvidence(
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

/** Creates one authenticated recorder linked to an optional predecessor. */
async function createRecorder(
  predecessor: WorkspaceSearchMigrationRehearsalRateCommittedSegment | undefined,
  segmentTag: string,
): Promise<WorkspaceSearchMigrationRehearsalRateRecorder> {
  return await createWorkspaceSearchMigrationRehearsalRateRecorder({
    segmentLocatorDigest: digest(`live-session-segment-${segmentTag}`),
    segmentOrdinal: predecessor === undefined ? 0 : 1,
    previousSegmentDigest: predecessor?.segmentDigest ?? null,
    previousRecordMac: predecessor?.terminalRecordMac ?? null,
    firstEventSequence: predecessor === undefined
      ? 1
      : predecessor.firstEventSequence + predecessor.eventCount,
    anchorUtc: predecessor === undefined
      ? '2026-08-02T00:00:00.000Z'
      : liveStartedAt,
    monotonicAnchorMilliseconds: predecessor === undefined ? 1_000 : 2_000,
    policyVersion,
    configurationBindingDigest,
    authenticationKey: rateAuthenticationKeySeed,
    /** Accepts every exact canonical append in memory. */
    async appendDurably(): Promise<void> {},
  })
}

/** Creates one complete predecessor carrying a single measurement attempt. */
async function createPredecessor(
  segmentTag: string,
): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment> {
  const recorder = await createRecorder(undefined, `${segmentTag}-predecessor`)
  recorder.record({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    kind: 'attempt',
    phase: 'measurement',
    sequence: 1,
    observedAtMilliseconds: 1_010,
    remainingNormalAdmissionAttempts: 99,
    remainingWindowAttempts: 9,
    remainingPageAttempts: 5,
    inFlight: 1,
  })
  const committed = await recorder.flush()
  await recorder.close()
  return committed
}

/** Resolves one canonical attested table by its exact physical name. */
function findAttestedTable(
  attestation: CrossDomainIntegrityResourceAttestation,
  tableName: string,
) {
  const table = attestation.tables.find((candidate) =>
    candidate.tableName === tableName)
  if (table === undefined) throw new Error('Unknown test table.')
  return table
}

/** Creates a managed rate owner that durably records every selected call. */
function createManagedRate(
  attestation: CrossDomainIntegrityResourceAttestation,
  recorder: WorkspaceSearchMigrationRehearsalRateRecorder,
  observations: LiveSessionObservations,
  failRateAfterSuccessfulCalls: number | undefined,
): WorkspaceSearchMigrationManagedDescribeTableRate {
  let attemptCount = 1
  return {
    /** Records and answers one exact attested DescribeTable call. */
    async describeTable(
      tableName: string,
      phase: WorkspaceSearchMigrationDescribeTablePhase,
    ): Promise<DescribeTableCommandOutput> {
      if (
        failRateAfterSuccessfulCalls !== undefined &&
        observations.rateDescribeTableCount >= failRateAfterSuccessfulCalls
      ) throw new Error('Injected managed rate failure.')
      if (phase !== 'integrity-check') {
        throw new Error('Unexpected managed rate phase.')
      }
      const table = findAttestedTable(attestation, tableName)
      observations.rateDescribeTableCount += 1
      observations.order.push('describe-table')
      attemptCount += 1
      recorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'attempt',
        phase,
        sequence: attemptCount,
        observedAtMilliseconds:
          2_000 + observations.rateDescribeTableCount * 10,
        remainingNormalAdmissionAttempts: 100 - attemptCount,
        remainingWindowAttempts: 9,
        remainingPageAttempts: 5,
        inFlight: 1,
      })
      return {
        $metadata: {},
        Table: {
          TableName: table.tableName,
          TableArn: table.tableArn,
          TableId: table.tableId,
          TableStatus: 'ACTIVE',
          CreationDateTime: new Date(table.creationTime),
        },
      }
    },
    /** Runs an unused checkpoint-page task. */
    async runCheckpointPage(_input, task) {
      return await task()
    },
    /** Runs an unused mandatory-cleanup task. */
    async runMandatoryCleanup(task) {
      return await task()
    },
    /** Runs the complete live checker under one exclusive non-page gate. */
    async runNonPageOperation(task) {
      return await task()
    },
    /** Runs an unused mutation-guard task. */
    async runWithMutationAdmissionGuard(_guard, task) {
      return await task()
    },
    /** Accepts fixture data I/O. */
    assertNewDataIoAllowed(): void {},
    /** Accepts an unused lease claim. */
    async claimAfterLease(): Promise<void> {},
    /** No-op fixture interruption. */
    interrupt(): void {},
    /** No-op fixture quarantine. */
    quarantine(): void {},
    /** Reads the current exact cumulative aggregate. */
    readEvidence: () => rateEvidence(attemptCount),
    /** Reads the final exact cumulative aggregate. */
    async closeAndReadEvidence() {
      return rateEvidence(attemptCount)
    },
    /** Leaves the outer fixture lifecycle unchanged. */
    async close(): Promise<void> {},
  }
}

/** Creates one borrowed transport with a throwing DescribeTable fallback. */
function createBorrowedTransport(
  attestation: CrossDomainIntegrityResourceAttestation,
  observations: LiveSessionObservations,
  callerAccount: string,
): CrossDomainIntegrityAwsTransport {
  return {
    /** Records caller ownership if the live-session wrapper closes by mistake. */
    close(): void {
      observations.borrowedTransportCloseCount += 1
    },
    /** Fails every forbidden fallback outside the managed rate owner. */
    async describeTable(): Promise<DescribeTableCommandOutput> {
      observations.baseDescribeTableCount += 1
      throw new Error('Forbidden base DescribeTable fallback.')
    },
    /** Returns enabled File bucket versioning. */
    async getBucketVersioning() {
      observations.order.push('bucket-versioning')
      return { $metadata: {}, Status: 'Enabled' }
    },
    /** Returns the exact immutable File bucket marker incarnation. */
    async getObjectAttributes() {
      observations.order.push('object-attributes')
      return {
        $metadata: {},
        VersionId: attestation.bucket.marker.versionId,
        Checksum: {
          ChecksumSHA256: attestation.bucket.marker.checksumSha256,
        },
        ObjectSize: attestation.bucket.marker.size,
      }
    },
    /** Returns empty tags for an unused exact object path. */
    async getObjectTagging() {
      return { $metadata: {}, TagSet: [] }
    },
    /** Returns empty headers for an unused exact object path. */
    async headObject() {
      return { $metadata: {} }
    },
    /** Returns the selected STS caller account inside the trusted window. */
    async readCallerIdentity() {
      observations.order.push('sts')
      observations.callerIdentityCount += 1
      return { $metadata: {}, Account: callerAccount }
    },
    /** Returns one empty page for every fixed domain table. */
    async scan() {
      observations.order.push('scan')
      return { $metadata: {}, Items: [] }
    },
  }
}

/** Creates one deterministic actual live-session composition. */
async function createLiveSessionFixture(
  options: CreateLiveSessionFixtureOptions = {},
): Promise<LiveSessionFixture> {
  const segmentTag = options.segmentTag ?? 'primary'
  const resourceAttestation = createResourceAttestation()
  const predecessor = await createPredecessor(segmentTag)
  const recorder = await createRecorder(predecessor, segmentTag)
  const observations: LiveSessionObservations = {
    rateDescribeTableCount: 0,
    baseDescribeTableCount: 0,
    callerIdentityCount: 0,
    borrowedTransportCloseCount: 0,
    order: [],
  }
  const wallClockSamples = options.wallClockSamples ?? [
    liveStartedAt,
    liveCompletedAt,
    liveFinalizedAt,
  ]
  let wallClockIndex = 0
  let monotonicMilliseconds = 2_000
  let monotonicClockIndex = 0
  const integrityDigestKey = new Uint8Array(integrityDigestKeySeed)
  const auditPseudonymKey = new Uint8Array(auditPseudonymKeySeed)
  const resourceIdentities =
    createCrossDomainIntegrityImmutableResourceIdentities(
      resourceAttestation,
      integrityDigestKeySeed,
    )
  const tables = {
    'audit-events': resourceAttestation.tables[0]?.tableName ?? '',
    'file-proofing': resourceAttestation.tables[1]?.tableName ?? '',
    'project-directory': resourceAttestation.tables[2]?.tableName ?? '',
    'work-item-configuration':
      resourceAttestation.tables[3]?.tableName ?? '',
    'work-items': resourceAttestation.tables[4]?.tableName ?? '',
    'workspace-access': resourceAttestation.tables[5]?.tableName ?? '',
  }
  const input: RunWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput = {
    account: resourceAttestation.account,
    auditPseudonymKey,
    buckets: { file: resourceAttestation.bucket.bucketName },
    expectedResourceIdentityDigest:
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        integrityDigestKeySeed,
      ),
    integrityDigestKey,
    maxItems: 100,
    maxPages: 10,
    maximumDurationMilliseconds: 60_000,
    monotonicClock: (): number => {
      const selectedSample =
        options.monotonicClockSamples?.[monotonicClockIndex]
      if (options.monotonicClockSamples !== undefined) {
        if (selectedSample === undefined) {
          throw new Error('Unexpected monotonic-clock sample.')
        }
        monotonicClockIndex += 1
        return selectedSample
      }
      monotonicMilliseconds += 1
      return monotonicMilliseconds
    },
    pageSize: 100,
    profile: 'nonproduction-rehearsal',
    rate: createManagedRate(
      resourceAttestation,
      recorder,
      observations,
      options.failRateAfterSuccessfulCalls,
    ),
    region: resourceAttestation.region,
    resourceAttestationBytes: resourceAttestationBytes(resourceAttestation),
    role: 'source',
    tables,
    transport: createBorrowedTransport(
      resourceAttestation,
      observations,
      options.callerAccount ?? resourceAttestation.account,
    ),
    wallClock: (): Date => {
      const sample = wallClockSamples[wallClockIndex]
      if (sample === undefined) throw new Error('Unexpected wall-clock sample.')
      observations.order.push(`wall:${wallClockIndex}`)
      wallClockIndex += 1
      return new Date(sample)
    },
  }
  return {
    auditPseudonymKey,
    input,
    integrityDigestKey,
    observations,
    predecessor,
    recorder,
    resourceAttestation,
  }
}

/** Runs one complete actual checker and flushes its exact raw segment. */
async function completeLiveSession(
  options: CreateLiveSessionFixtureOptions = {},
): Promise<CompletedLiveSession> {
  const fixture = await createLiveSessionFixture(options)
  const pending =
    await runWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
      fixture.input,
    )
  const current = await fixture.recorder.flush()
  await fixture.recorder.close()
  return { ...fixture, current, pending }
}

/** Creates one fresh strict finalizer input for a completed session. */
function createFinalizerInput(
  session: CompletedLiveSession,
  pending: WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending =
    session.pending,
) {
  const rateAuthenticationKey = new Uint8Array(rateAuthenticationKeySeed)
  return {
    rateAuthenticationKey,
    input: {
      canonicalSegmentBytes: session.current.canonicalBytes,
      expectedConfigurationBindingDigest: configurationBindingDigest,
      expectedPolicyVersion: policyVersion,
      pending,
      predecessorSegmentBytes: session.predecessor.canonicalBytes,
      rateAuthenticationKey,
    },
  }
}

/** Requires every byte of one transferred key to have been overwritten. */
function expectZeroized(key: Uint8Array): void {
  expect([...key]).toEqual(Array.from({ length: 32 }, () => 0))
}

/** Creates a valid linked segment whose attempt range cannot match the pending run. */
async function createDifferentIntegritySegment(
  predecessor: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment> {
  const recorder = await createRecorder(predecessor, 'different-valid-segment')
  for (let index = 0; index < 12; index += 1) {
    recorder.record({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      kind: 'attempt',
      phase: 'integrity-check',
      sequence: index + 14,
      observedAtMilliseconds: 2_010 + index * 10,
      remainingNormalAdmissionAttempts: 70 - index,
      remainingWindowAttempts: 9,
      remainingPageAttempts: 5,
      inFlight: 1,
    })
  }
  const committed = await recorder.flush()
  await recorder.close()
  return committed
}

describe('migration rehearsal actual integrity live session', () => {
  test('runs the production checker once with STS inside the trusted window and no DescribeTable fallback', async () => {
    const session = await completeLiveSession()
    expect(Object.isFrozen(session.pending)).toBe(true)
    expect(Object.keys(session.pending)).toEqual([])
    expect(Reflect.set(session.pending, 'result', {})).toBe(false)
    expect(session.observations.order.slice(0, 2)).toEqual([
      'wall:0',
      'sts',
    ])
    expect(session.observations.order.at(-1)).toBe('wall:1')
    expect(session.observations.callerIdentityCount).toBe(1)
    expect(session.observations.rateDescribeTableCount).toBe(12)
    expect(session.observations.baseDescribeTableCount).toBe(0)
    expect(session.observations.borrowedTransportCloseCount).toBe(0)
    expectZeroized(session.integrityDigestKey)
    expectZeroized(session.auditPseudonymKey)

    const finalizer = createFinalizerInput(session)
    const finalized =
      finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
        finalizer.input,
      )
    expectZeroized(finalizer.rateAuthenticationKey)
    expect(finalized.kind).toBe(
      'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result',
    )
    expect(finalized.interval.describeTableCallCount).toBe(12)
    expect(finalized.interval.tablePassCount).toBe(2)
    expect(finalized.result.runtimeProvenance).toEqual({
      kind: 'mukuroji-cross-domain-integrity-rehearsal-live-provenance',
      version: 1,
      mode: 'migration-rehearsal-live',
      startedAt: liveStartedAt,
      completedAt: liveCompletedAt,
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    })
  })

  test('rejects a structural clone without consuming the genuine pending capability and rejects replay', async () => {
    const session = await completeLiveSession({ segmentTag: 'clone-replay' })
    const clone = { ...session.pending }
    const cloneRateKey = new Uint8Array(rateAuthenticationKeySeed)
    expect(() =>
      Reflect.apply(
        finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
        undefined,
        [{
          canonicalSegmentBytes: session.current.canonicalBytes,
          expectedConfigurationBindingDigest: configurationBindingDigest,
          expectedPolicyVersion: policyVersion,
          pending: clone,
          predecessorSegmentBytes: session.predecessor.canonicalBytes,
          rateAuthenticationKey: cloneRateKey,
        }],
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError)
    expectZeroized(cloneRateKey)

    const genuineFinalizer = createFinalizerInput(session)
    finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
      genuineFinalizer.input,
    )
    expectZeroized(genuineFinalizer.rateAuthenticationKey)
    const replayRateKey = new Uint8Array(rateAuthenticationKeySeed)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession({
        ...genuineFinalizer.input,
        rateAuthenticationKey: replayRateKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError)
    expectZeroized(replayRateKey)
  })

  test('burns pending authority when a different valid segment is supplied', async () => {
    const session = await completeLiveSession({ segmentTag: 'wrong-segment' })
    const different = await createDifferentIntegritySegment(
      session.predecessor,
    )
    const wrongRateKey = new Uint8Array(rateAuthenticationKeySeed)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession({
        canonicalSegmentBytes: different.canonicalBytes,
        expectedConfigurationBindingDigest: configurationBindingDigest,
        expectedPolicyVersion: policyVersion,
        pending: session.pending,
        predecessorSegmentBytes: session.predecessor.canonicalBytes,
        rateAuthenticationKey: wrongRateKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError)
    expectZeroized(wrongRateKey)

    const retryRateKey = new Uint8Array(rateAuthenticationKeySeed)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession({
        canonicalSegmentBytes: session.current.canonicalBytes,
        expectedConfigurationBindingDigest: configurationBindingDigest,
        expectedPolicyVersion: policyVersion,
        pending: session.pending,
        predecessorSegmentBytes: session.predecessor.canonicalBytes,
        rateAuthenticationKey: retryRateKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError)
    expectZeroized(retryRateKey)
  })

  test('disposes an unsealed pending capability exactly once', async () => {
    const session = await completeLiveSession({ segmentTag: 'dispose' })
    disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
      session.pending,
    )
    expect(() =>
      disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
        session.pending,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError)
    const finalizer = createFinalizerInput(session)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
        finalizer.input,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError)
    expectZeroized(finalizer.rateAuthenticationKey)
  })

  test('rejects a trusted wall-clock regression during finalization and burns the pending authority', async () => {
    const session = await completeLiveSession({
      segmentTag: 'clock-regression',
      wallClockSamples: [
        liveStartedAt,
        liveCompletedAt,
        '2026-08-02T00:00:01.500Z',
      ],
    })
    const finalizer = createFinalizerInput(session)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
        finalizer.input,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError)
    expectZeroized(finalizer.rateAuthenticationKey)
    const replay = createFinalizerInput(session)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
        replay.input,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError)
    expectZeroized(replay.rateAuthenticationKey)
  })

  test('mints no pending authority when the twelfth managed DescribeTable call is missing', async () => {
    const fixture = await createLiveSessionFixture({
      failRateAfterSuccessfulCalls: 11,
      segmentTag: 'missing-call',
    })
    await expect(
      runWorkspaceSearchMigrationRehearsalIntegrityLiveSession(fixture.input),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError,
    )
    expect(fixture.observations.rateDescribeTableCount).toBe(11)
    expect(fixture.observations.baseDescribeTableCount).toBe(0)
    expect(fixture.observations.borrowedTransportCloseCount).toBe(0)
    expectZeroized(fixture.integrityDigestKey)
    expectZeroized(fixture.auditPseudonymKey)
    await fixture.recorder.close()
  })

  test('rejects a mismatched STS account before entering the rate-owned checker', async () => {
    const fixture = await createLiveSessionFixture({
      callerAccount: '999999999999',
      segmentTag: 'account-mismatch',
    })
    await expect(
      runWorkspaceSearchMigrationRehearsalIntegrityLiveSession(fixture.input),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError,
    )
    expect(fixture.observations.order).toEqual(['wall:0', 'sts'])
    expect(fixture.observations.rateDescribeTableCount).toBe(0)
    expect(fixture.observations.baseDescribeTableCount).toBe(0)
    expect(fixture.observations.borrowedTransportCloseCount).toBe(0)
    expectZeroized(fixture.integrityDigestKey)
    expectZeroized(fixture.auditPseudonymKey)
    await fixture.recorder.close()
  })

  test('rejects correlated checker limits before the first AWS read', async () => {
    for (const limits of [
      { maxItems: 2, maxPages: 1, pageSize: 1 },
      { maxItems: 1, maxPages: 1_001, pageSize: 1_000 },
    ]) {
      const fixture = await createLiveSessionFixture({
        segmentTag: `invalid-correlated-limits-${limits.maxItems}`,
      })
      await expect(
        runWorkspaceSearchMigrationRehearsalIntegrityLiveSession({
          ...fixture.input,
          ...limits,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError,
      )
      expect(fixture.observations.callerIdentityCount).toBe(0)
      expect(fixture.observations.rateDescribeTableCount).toBe(0)
      expect(fixture.observations.baseDescribeTableCount).toBe(0)
      expectZeroized(fixture.integrityDigestKey)
      expectZeroized(fixture.auditPseudonymKey)
      await fixture.recorder.close()
    }
  })

  test('rejects monotonic-clock regression after STS without entering the checker', async () => {
    const fixture = await createLiveSessionFixture({
      monotonicClockSamples: [2_000, 2_001, 1_999],
      segmentTag: 'monotonic-regression',
    })
    await expect(
      runWorkspaceSearchMigrationRehearsalIntegrityLiveSession(fixture.input),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError,
    )
    expect(fixture.observations.order).toEqual(['wall:0', 'sts'])
    expect(fixture.observations.rateDescribeTableCount).toBe(0)
    expect(fixture.observations.baseDescribeTableCount).toBe(0)
    expectZeroized(fixture.integrityDigestKey)
    expectZeroized(fixture.auditPseudonymKey)
    await fixture.recorder.close()
  })

  test('detaches strict resource input before the first asynchronous boundary', async () => {
    const fixture = await createLiveSessionFixture({
      segmentTag: 'input-mutation',
    })
    const mutableTables = {
      'audit-events': fixture.input.tables['audit-events'],
      'file-proofing': fixture.input.tables['file-proofing'],
      'project-directory': fixture.input.tables['project-directory'],
      'work-item-configuration':
        fixture.input.tables['work-item-configuration'],
      'work-items': fixture.input.tables['work-items'],
      'workspace-access': fixture.input.tables['workspace-access'],
    }
    const promise =
      runWorkspaceSearchMigrationRehearsalIntegrityLiveSession({
        ...fixture.input,
        tables: mutableTables,
      })
    mutableTables['audit-events'] = 'mutated-after-detachment'
    const pending = await promise
    const current = await fixture.recorder.flush()
    await fixture.recorder.close()
    const session = { ...fixture, current, pending }
    expect(session.observations.rateDescribeTableCount).toBe(12)
    const finalizer = createFinalizerInput(session)
    const finalized =
      finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
        finalizer.input,
      )
    expect(finalized.interval.describeTableCallCount).toBe(12)
    expectZeroized(finalizer.rateAuthenticationKey)
  })

  test('rejects accessor-bearing top-level input without invoking the getter', async () => {
    const fixture = await createLiveSessionFixture({
      segmentTag: 'accessor-input',
    })
    const candidate = { ...fixture.input }
    let getterCount = 0
    Object.defineProperty(candidate, 'tables', {
      enumerable: true,
      configurable: true,
      get(): unknown {
        getterCount += 1
        return fixture.input.tables
      },
    })
    await expect(
      Reflect.apply(
        runWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
        undefined,
        [candidate],
      ),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError,
    )
    expect(getterCount).toBe(0)
    expect(fixture.observations.callerIdentityCount).toBe(0)
    expect(fixture.observations.rateDescribeTableCount).toBe(0)
    expectZeroized(fixture.integrityDigestKey)
    expectZeroized(fixture.auditPseudonymKey)
    await fixture.recorder.close()
  })

  test('rejects a Proxy in the transport prototype chain without invoking traps', async () => {
    const fixture = await createLiveSessionFixture({
      segmentTag: 'transport-prototype-proxy',
    })
    let descriptorTrapCount = 0
    const prototype = new Proxy({}, {
      getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
        descriptorTrapCount += 1
        return undefined
      },
    })
    const transportCandidate: unknown = Object.create(prototype)
    await expect(
      Reflect.apply(
        runWorkspaceSearchMigrationRehearsalIntegrityLiveSession,
        undefined,
        [{ ...fixture.input, transport: transportCandidate }],
      ),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError,
    )
    expect(descriptorTrapCount).toBe(0)
    expect(fixture.observations.callerIdentityCount).toBe(0)
    expect(fixture.observations.rateDescribeTableCount).toBe(0)
    expectZeroized(fixture.integrityDigestKey)
    expectZeroized(fixture.auditPseudonymKey)
    await fixture.recorder.close()
  })
})
