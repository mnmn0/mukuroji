import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  DescribeTableCommand,
  type DescribeTableCommandOutput,
} from '@aws-sdk/client-dynamodb'
import type {
  CrossDomainIntegrityAwsTransport,
} from '../../data-integrity/verify-cross-domain-integrity'
import {
  calculateCrossDomainIntegrityResourceBindingDigest,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  createCrossDomainIntegrityInvocationDeadline,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS,
  runCrossDomainIntegrityCheck,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResult,
} from '../../data-integrity/cross-domain-integrity'
import {
  createWorkspaceSearchConfigurationHash,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
} from './migration-identity'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTablePhase,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'
import {
  createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
  type WorkspaceSearchMigrationRehearsalIntegrityRateSequence,
} from './migration-rehearsal-integrity-rate-adapter'
import {
  authorizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  consumeWorkspaceSearchMigrationRehearsalIntegrityRootInventoryAuthorization,
  consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization,
  consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootBytes,
  serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval,
  verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  consumeWorkspaceSearchMigrationRehearsalRootMeasurement,
  measureWorkspaceSearchMigrationRehearsalRootConfiguration,
  type WorkspaceSearchMigrationRehearsalRootMeasurement,
} from './migration-rehearsal-root-measurement'
import {
  createWorkspaceSearchMigrationRehearsalRateRecorder,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalRateRecorder,
} from './migration-rehearsal-rate-evidence'

/** Exact test authentication key retained outside production artifacts. */
const authenticationKey = new Uint8Array(32).fill(41)

/** Dedicated #163 result key distinct from the runtime rate key. */
const integrityDigestKey = new Uint8Array(32).fill(83)

/** Reviewed policy digest shared by every deterministic fixture. */
const policyVersion = digest('integrity-rate-policy')

/** Measured configuration digest shared by every deterministic fixture. */
const configurationBindingDigest = createWorkspaceSearchConfigurationHash(
  createMeasuredConfiguration(),
)

/** Canonical physical names used only inside the private adapter fixture. */
const orderedTableNames = Object.freeze([
  'audit-events-table',
  'file-proofing-table',
  'project-directory-table',
  'work-item-configuration-table',
  'work-items-table',
  'workspace-access-table',
])

/** Options controlling one authenticated current-segment fixture. */
type CreateIntervalFixtureOptions = {
  /** Raw predecessor and its committed chain metadata for a successor. */
  readonly predecessor?: WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Optional phase persisted instead of the adapter-requested phase. */
  readonly recordedPhase?: WorkspaceSearchMigrationDescribeTablePhase
  /** Whether to persist one valid cadence wait before every call. */
  readonly includeCadence?: boolean
  /** One root pass or two live checker passes. */
  readonly tablePassCount?: 1 | 2
  /** Exact object to return causally from the adapter-owned task. */
  readonly taskResult?: object
  /** Whether to append one unclaimed integrity attempt after adapter success. */
  readonly appendExtraIntegrityAttempt?: boolean
  /** Whether the root begins with its exact six migration measurements. */
  readonly includeInitialMeasurement?: boolean
}

/** Complete exact segment, sequence capability, and trusted time fixture. */
type IntegrityIntervalFixture = {
  /** Raw predecessor bytes, or null for the root segment. */
  readonly predecessorSegmentBytes: Uint8Array | null
  /** Exact authenticated current segment bytes. */
  readonly canonicalSegmentBytes: Uint8Array
  /** Fresh one-shot exact adapter sequence capability. */
  readonly sequence: WorkspaceSearchMigrationRehearsalIntegrityRateSequence
  /** Exact immutable object returned by the adapter-owned task. */
  readonly taskResult: object
  /** Trusted operation start preceding all selected events. */
  readonly expectedStartedAt: string
  /** Trusted operation completion following all selected events. */
  readonly expectedCompletedAt: string
}

/** Creates one conventional lowercase SHA-256 fixture digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Creates one complete configuration causally returned by measurement. */
function createMeasuredConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'rehearsal-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/MigrationOperator/rehearsal',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createMeasuredTable('project-directory'),
      'work-items': createMeasuredTable('work-items'),
      collaboration: createMeasuredTable('collaboration'),
      documents: createMeasuredTable('documents'),
      'workspace-search': createMeasuredTable('workspace-search'),
      'migration-state': createMeasuredTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-rehearsal-journal',
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
      accessLogBucket: 'mukuroji-rehearsal-access-logs',
      accessLogPrefix: 'workspace-search/v1/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one complete table identity for the measured configuration.
 *
 * @param role - Exact logical migration table role.
 * @returns Deterministic immutable table identity.
 */
function createMeasuredTable(
  role: MigrationTableIdentity['role'],
): MigrationTableIdentity {
  const key: readonly MigrationKeyAttribute[] = Object.freeze([
    Object.freeze({
      name: `${role}Id`,
      role: 'HASH',
      type: 'S',
    }),
  ])
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: role === 'workspace-search' ||
      role === 'migration-state',
    encryption: 'KMS',
    kmsKeyDigest: digest(`${role}-kms-key`),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-31T00:00:00.000Z',
    },
  }
}

/** Creates one strict current-rate aggregate from a deterministic count. */
function rateEvidence(
  attemptCount: number,
  cadenceWaitCount: number,
  selectedPolicyVersion = policyVersion,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion: selectedPolicyVersion,
    attemptCount,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    awsServiceThrottleCount: 0,
    rehearsalInjectedThrottleCount: 0,
    budgetStopCount: 0,
    operationalBudgetStopCount: 0,
    awsServiceThrottleBudgetStopCount: 0,
    rehearsalInjectedBudgetStopCount: 0,
    cadenceWaitCount,
    cadenceWaitMilliseconds: cadenceWaitCount * 5,
    maximumInFlight: attemptCount === 0 ? 0 : 1,
  }
}

/** Creates the non-DescribeTable transport retained behind the adapter. */
function createBaseTransport(): CrossDomainIntegrityAwsTransport {
  return {
    /** Fails if the forbidden SDK DescribeTable fallback becomes reachable. */
    async describeTable(): Promise<DescribeTableCommandOutput> {
      throw new Error('Forbidden base DescribeTable fallback.')
    },
    /** No-op fixture close. */
    close(): void {},
    /** Returns empty S3 versioning metadata. */
    async getBucketVersioning() {
      return { $metadata: {} }
    },
    /** Returns empty exact-object metadata. */
    async getObjectAttributes() {
      return { $metadata: {} }
    },
    /** Returns empty exact-object tags. */
    async getObjectTagging() {
      return { $metadata: {}, TagSet: [] }
    },
    /** Returns empty exact-object headers. */
    async headObject() {
      return { $metadata: {} }
    },
    /** Returns empty caller identity metadata. */
    async readCallerIdentity() {
      return { $metadata: {} }
    },
    /** Returns an empty bounded Scan page. */
    async scan() {
      return { $metadata: {} }
    },
  }
}

/** Creates one deterministic authenticated process-segment recorder. */
async function createRecorder(
  predecessor: WorkspaceSearchMigrationRehearsalRateCommittedSegment | undefined,
): Promise<WorkspaceSearchMigrationRehearsalRateRecorder> {
  const segmentOrdinal = predecessor === undefined ? 0 : 1
  return await createWorkspaceSearchMigrationRehearsalRateRecorder({
    segmentLocatorDigest: digest(`integrity-segment-${segmentOrdinal}`),
    segmentOrdinal,
    previousSegmentDigest: predecessor?.segmentDigest ?? null,
    previousRecordMac: predecessor?.terminalRecordMac ?? null,
    firstEventSequence: predecessor === undefined
      ? 1
      : predecessor.firstEventSequence + predecessor.eventCount,
    anchorUtc: segmentOrdinal === 0
      ? '2026-08-02T00:00:00.000Z'
      : '2026-08-02T00:00:01.000Z',
    monotonicAnchorMilliseconds: segmentOrdinal === 0 ? 1_000 : 2_000,
    policyVersion,
    configurationBindingDigest,
    authenticationKey,
    /** Accepts each exact canonical append in memory for deterministic tests. */
    async appendDurably(): Promise<void> {},
  })
}

/** Creates a single measurement predecessor with one complete attempt. */
async function createPredecessor(): Promise<
  WorkspaceSearchMigrationRehearsalRateCommittedSegment
> {
  const recorder = await createRecorder(undefined)
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
  return await recorder.flush()
}

/** Builds one genuine adapter capability and matching raw durable segment. */
async function createIntervalFixture(
  options: CreateIntervalFixtureOptions = {},
): Promise<IntegrityIntervalFixture> {
  if (
    options.includeInitialMeasurement === true &&
    options.predecessor !== undefined
  ) throw new Error('Initial measurement belongs only to the root segment.')
  const recorder = await createRecorder(options.predecessor)
  const predecessorAttemptCount = options.predecessor === undefined ? 0 : 1
  const monotonicAnchorMilliseconds = options.predecessor === undefined
    ? 1_000
    : 2_000
  let attemptCount = predecessorAttemptCount
  let cadenceWaitCount = 0
  if (options.includeInitialMeasurement === true) {
    for (let index = 1; index <= 6; index += 1) {
      attemptCount += 1
      recorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'attempt',
        phase: 'measurement',
        sequence: attemptCount,
        observedAtMilliseconds:
          monotonicAnchorMilliseconds + attemptCount * 10,
        remainingNormalAdmissionAttempts: 100 - attemptCount,
        remainingWindowAttempts: 9,
        remainingPageAttempts: 5,
        inFlight: 1,
      })
    }
  }
  const rate: WorkspaceSearchMigrationManagedDescribeTableRate = {
    /** Persists the exact physical attempt through the durable recorder. */
    async describeTable(_tableName, phase) {
      attemptCount += 1
      const observedAtMilliseconds =
        monotonicAnchorMilliseconds +
        (attemptCount - predecessorAttemptCount) * 10
      if (options.includeCadence === true) {
        cadenceWaitCount += 1
        recorder.record({
          version:
            WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
          kind: 'cadence-wait',
          phase: options.recordedPhase ?? phase,
          observedAtMilliseconds,
          delayMilliseconds: 5,
        })
      }
      recorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'attempt',
        phase: options.recordedPhase ?? phase,
        sequence: attemptCount,
        observedAtMilliseconds,
        remainingNormalAdmissionAttempts: 100 - attemptCount,
        remainingWindowAttempts: 9,
        remainingPageAttempts: 5,
        inFlight: 1,
      })
      return { $metadata: {} }
    },
    /** Runs an unused checkpoint-page fixture task. */
    async runCheckpointPage(_input, task) {
      return await task()
    },
    /** Runs an unused mandatory-cleanup fixture task. */
    async runMandatoryCleanup(task) {
      return await task()
    },
    /** Runs the exact adapter task under the exclusive non-page boundary. */
    async runNonPageOperation(task) {
      return await task()
    },
    /** Runs an unused mutation-guard fixture task. */
    async runWithMutationAdmissionGuard(_guard, task) {
      return await task()
    },
    /** Accepts fixture data I/O. */
    assertNewDataIoAllowed(): void {},
    /** Accepts an unused fixture lease claim. */
    async claimAfterLease(): Promise<void> {},
    /** No-op fixture interruption. */
    interrupt(): void {},
    /** No-op fixture quarantine. */
    quarantine(): void {},
    /** Returns the exact current fixture aggregate. */
    readEvidence: () => rateEvidence(attemptCount, cadenceWaitCount),
    /** Returns the exact final fixture aggregate. */
    async closeAndReadEvidence() {
      return rateEvidence(attemptCount, cadenceWaitCount)
    },
    /** No-op fixture close. */
    async close(): Promise<void> {},
  }
  const adapter = createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter({
    tableNames: {
      'audit-events': orderedTableNames[0] ?? '',
      'file-proofing': orderedTableNames[1] ?? '',
      'project-directory': orderedTableNames[2] ?? '',
      'work-item-configuration': orderedTableNames[3] ?? '',
      'work-items': orderedTableNames[4] ?? '',
      'workspace-access': orderedTableNames[5] ?? '',
    },
    tablePassCount: options.tablePassCount ?? 1,
    baseTransport: createBaseTransport(),
    rate,
  })
  const taskResult = options.taskResult ??
    Object.freeze({ kind: 'integrity-task-result' })
  await adapter.run(async () => {
    const tablePassCount = options.tablePassCount ?? 1
    for (let pass = 0; pass < tablePassCount; pass += 1) {
      for (const tableName of orderedTableNames) {
        await adapter.describeTable(
          new DescribeTableCommand({ TableName: tableName }),
          AbortSignal.timeout(60_000),
        )
      }
    }
    return taskResult
  })
  if (options.appendExtraIntegrityAttempt === true) {
    attemptCount += 1
    recorder.record({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      kind: 'attempt',
      phase: 'integrity-check',
      sequence: attemptCount,
      observedAtMilliseconds: monotonicAnchorMilliseconds + 500,
      remainingNormalAdmissionAttempts: 50,
      remainingWindowAttempts: 8,
      remainingPageAttempts: 4,
      inFlight: 1,
    })
  }
  const committed = await recorder.flush()
  return {
    predecessorSegmentBytes:
      options.predecessor?.canonicalBytes.slice() ?? null,
    canonicalSegmentBytes: committed.canonicalBytes,
    sequence: adapter.takeCompletedSequence(taskResult),
    taskResult,
    expectedStartedAt: options.predecessor === undefined
      ? '2026-08-02T00:00:00.000Z'
      : '2026-08-02T00:00:01.000Z',
    expectedCompletedAt: options.predecessor === undefined
      ? '2026-08-02T00:00:01.000Z'
      : '2026-08-02T00:00:02.000Z',
  }
}

/** Creates the exact verifier input shared by positive fixtures. */
function verifierInput(fixture: IntegrityIntervalFixture): object {
  return {
    canonicalSegmentBytes: fixture.canonicalSegmentBytes,
    authenticationKey,
    predecessorSegmentBytes: fixture.predecessorSegmentBytes,
    expectedPolicyVersion: policyVersion,
    expectedConfigurationBindingDigest: configurationBindingDigest,
    expectedStartedAt: fixture.expectedStartedAt,
    expectedCompletedAt: fixture.expectedCompletedAt,
    sequence: fixture.sequence,
    taskResult: fixture.taskResult,
  }
}

/** Creates one complete private immutable resource attestation fixture. */
function createResourceAttestation(
  tableNameSuffix = '',
): CrossDomainIntegrityResourceAttestation {
  const account = '123456789012'
  const region = 'ap-northeast-1'
  return {
    kind: 'mukuroji-cross-domain-integrity-resource-attestation',
    version: 1,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account,
    region,
    bucket: {
      target: 'bucket:file',
      bucketName: 'file-integrity-bucket',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'file-bucket-marker-version-1',
        checksumSha256: Buffer.alloc(32, 0x5a).toString('base64'),
        size: 128,
      },
    },
    tables: CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS.map(
      (target, index) => {
        const tableName = `${orderedTableNames[index] ?? ''}${tableNameSuffix}`
        return {
          target,
          tableName,
          tableArn:
            `arn:aws:dynamodb:${region}:${account}:table/${tableName}`,
          tableId: `immutable-table-id-${index + 1}`,
          creationTime: `2026-01-0${index + 1}T00:00:00.000Z`,
        }
      },
    ),
  }
}

/** Serializes one exact canonical owner-only attestation fixture. */
function resourceAttestationBytes(
  resourceAttestation: CrossDomainIntegrityResourceAttestation,
): Uint8Array {
  return new TextEncoder().encode(
    serializeCrossDomainIntegrityResourceAttestation(resourceAttestation),
  )
}

/** Creates one authenticated passing live source #163 result. */
async function createLiveResult(
  attestation: CrossDomainIntegrityResourceAttestation,
  startedAt = '2026-08-02T00:00:01.000Z',
  completedAt = '2026-08-02T00:00:02.000Z',
): Promise<CrossDomainIntegrityResult> {
  const resourceIdentities =
    createCrossDomainIntegrityImmutableResourceIdentities(
      attestation,
      integrityDigestKey,
    )
  return await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    deadline: createCrossDomainIntegrityInvocationDeadline({
      maximumDurationMilliseconds: 60_000,
      monotonicClock: () => 1_000,
    }),
    role: 'source',
    checkedAt: completedAt,
    observationMode: 'migration-rehearsal-live',
    liveRuntimeObservation: { startedAt, completedAt },
    digestKey: integrityDigestKey,
    resourceBindingDigest:
      calculateCrossDomainIntegrityResourceBindingDigest(),
    resourceIdentities,
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    resourceIdentityDigest:
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        integrityDigestKey,
      ),
    limits: {
      pageSize: 100,
      maxPages: 10,
      maxItems: 1_000,
    },
    reader: {
      /** Returns one empty bounded domain page. */
      readPage: async () => ({ items: [] }),
    },
  })
}

/** Creates one fresh private rate capability for an exact live result. */
async function createLiveRateBinding(
  result: CrossDomainIntegrityResult,
) {
  const predecessor = await createPredecessor()
  const fixture = await createIntervalFixture({
    predecessor,
    tablePassCount: 2,
    taskResult: result,
  })
  return verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
    verifierInput(fixture),
  )
}

/** Creates the exact live finalizer input with a fresh transferred key. */
function liveFinalizerInput(
  rateBinding: object,
  result: CrossDomainIntegrityResult,
  resourceAttestation: CrossDomainIntegrityResourceAttestation,
): {
  readonly input: object
  readonly transferredIntegrityKey: Uint8Array
} {
  const transferredIntegrityKey = new Uint8Array(integrityDigestKey)
  const resourceIdentities =
    createCrossDomainIntegrityImmutableResourceIdentities(
      resourceAttestation,
      integrityDigestKey,
    )
  return {
    input: {
      rateBinding,
      result,
      resourceAttestation,
      integrityDigestKey: transferredIntegrityKey,
      rateAuthenticationKey: authenticationKey,
      expectedResourceIdentityDigest:
        calculateCrossDomainIntegrityResourceIdentityDigest(
          resourceIdentities,
          integrityDigestKey,
        ),
      clock: () => new Date('2026-08-02T00:00:03.000Z'),
    },
    transferredIntegrityKey,
  }
}

/** Optional measured and root claims for one finalizer fixture. */
type RootFinalizerInputOptions = {
  /** Final cumulative rate aggregate supplied to root sealing. */
  readonly durableEvidence?: WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Exact configuration returned by the causal measurement port. */
  readonly measuredConfiguration?: WorkspaceSearchMigrationConfiguration
  /** Policy retained by the causal measurement capability. */
  readonly measurementPolicyVersion?: string
  /** Root AWS account claim override. */
  readonly account?: string
  /** Root AWS Region claim override. */
  readonly region?: string
  /** Root STS caller ARN claim override. */
  readonly callerArn?: string
  /** Root reviewed commit claim override. */
  readonly commit?: string
  /** Root operator-selected resource binding override. */
  readonly requestedResourcesBinding?: string
}

/**
 * Creates one genuine clean first-six-attempt measurement capability.
 *
 * @param configuration - Exact object returned by the narrow measurement port.
 * @param selectedPolicyVersion - Durable policy retained by both snapshots.
 * @returns Exact measured object paired with fresh one-shot authority.
 */
async function createRootMeasurement(
  configuration: WorkspaceSearchMigrationConfiguration,
  selectedPolicyVersion = policyVersion,
): Promise<WorkspaceSearchMigrationRehearsalRootMeasurement> {
  let rateReadCount = 0
  return await measureWorkspaceSearchMigrationRehearsalRootConfiguration({
    expectedConfigurationBindingDigest:
      createWorkspaceSearchConfigurationHash(configuration),
    port: {
      /** Returns the exact causal configuration object. */
      async measureConfiguration() {
        return configuration
      },
      /** Returns pristine then exact six-attempt cumulative evidence. */
      readDescribeTableRateEvidence() {
        rateReadCount += 1
        return rateEvidence(
          rateReadCount === 1 ? 0 : 6,
          0,
          selectedPolicyVersion,
        )
      },
    },
  })
}

/**
 * Reconstructs the requested-resources binding from measured configuration.
 *
 * @param configuration - Exact complete measured configuration.
 * @returns Digest of all operator-selected resources and identity values.
 */
function measuredRequestedResourcesBinding(
  configuration: WorkspaceSearchMigrationConfiguration,
): string {
  return createWorkspaceSearchMigrationRequestedResourcesBinding({
    account: configuration.account,
    region: configuration.region,
    profile: configuration.profile,
    commit: configuration.commit,
    tables: {
      'project-directory':
        configuration.tables['project-directory'].tableName,
      'work-items': configuration.tables['work-items'].tableName,
      collaboration: configuration.tables.collaboration.tableName,
      documents: configuration.tables.documents.tableName,
      'workspace-search': configuration.tables['workspace-search'].tableName,
      'migration-state': configuration.tables['migration-state'].tableName,
    },
    journalBucket: configuration.journal.bucketName,
    journalKeyArn: configuration.journal.keyArn,
  })
}

/** Creates one complete owner-only root finalizer input. */
async function rootFinalizerInput(
  rateBinding: object,
  resourceAttestation: CrossDomainIntegrityResourceAttestation,
  options: RootFinalizerInputOptions = {},
): Promise<{
  /** Exact root finalizer record. */
  readonly input: object
  /** Transferred #163 key expected to be zeroized. */
  readonly transferredIntegrityKey: Uint8Array
  /** Exact measurement retained for adversarial reference tests. */
  readonly measurement: WorkspaceSearchMigrationRehearsalRootMeasurement
}> {
  const transferredIntegrityKey = new Uint8Array(integrityDigestKey)
  const measuredConfiguration = options.measuredConfiguration ??
    createMeasuredConfiguration()
  const measurement = await createRootMeasurement(
    measuredConfiguration,
    options.measurementPolicyVersion,
  )
  const account = options.account ?? resourceAttestation.account
  return {
    input: {
      rateBinding,
      measurementCapability: measurement.capability,
      measuredConfiguration: measurement.configuration,
      resourceAttestation,
      resourceAttestationBytes: resourceAttestationBytes(
        resourceAttestation,
      ),
      integrityDigestKey: transferredIntegrityKey,
      rateAuthenticationKey: authenticationKey,
      deploymentTargetId: 'test-rehearsal',
      deploymentTrustRootDigest: digest('deployment-trust-root'),
      productionAccountDigest: digest('production-account'),
      account,
      region: options.region ?? resourceAttestation.region,
      callerArn: options.callerArn ??
        `arn:aws:sts::${account}:assumed-role/MigrationOperator/rehearsal`,
      commit: options.commit ?? 'a'.repeat(40),
      requestedResourcesBinding: options.requestedResourcesBinding ??
        measuredRequestedResourcesBinding(measuredConfiguration),
      evidenceKeyDigest:
        createHash('sha256').update(authenticationKey).digest('hex'),
      publicationKeyDigest: digest('publication-key'),
      durableEvidence: options.durableEvidence ?? rateEvidence(12, 0),
    },
    transferredIntegrityKey,
    measurement,
  }
}

/**
 * Creates one fresh root rate binding and matching measurement finalizer.
 *
 * @param attestation - Exact adapter task result bound to the root interval.
 * @param options - Optional measured configuration and root claim overrides.
 * @returns Fresh one-shot root finalizer inputs for one adversarial attempt.
 */
async function createRootFinalizerFixture(
  attestation: CrossDomainIntegrityResourceAttestation,
  options: RootFinalizerInputOptions = {},
): Promise<Awaited<ReturnType<typeof rootFinalizerInput>>> {
  const fixture = await createIntervalFixture({
    taskResult: attestation,
    includeInitialMeasurement: true,
  })
  const rateBinding =
    verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
      verifierInput(fixture),
    )
  return await rootFinalizerInput(rateBinding, attestation, options)
}

/** Creates trusted top-level permit claims matching one private root. */
function permitExpectedClaims(
  root: ReturnType<
    typeof finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot
  >,
) {
  return {
    deploymentTargetId: root.deploymentTargetId,
    deploymentTrustRootDigest: root.deploymentTrustRootDigest,
    productionAccountDigest: root.productionAccountDigest,
    account: root.account,
    region: root.region,
    callerArn: root.callerArn,
    commit: root.commit,
    requestedResourcesBinding: root.requestedResourcesBinding,
    configurationBindingDigest: root.configurationBindingDigest,
    policyVersion: root.policyVersion,
    evidenceKeyDigest: root.evidenceKeyDigest,
    publicationKeyDigest: root.publicationKeyDigest,
    resourceIdentityScheme: root.attestation.resourceIdentityScheme,
    resourceIdentities: root.attestation.resourceIdentities,
    resourceIdentityDigest: root.attestation.resourceIdentityDigest,
    issuedAt: '2026-08-02T00:00:02.000Z',
  }
}

describe('migration rehearsal authenticated integrity-rate interval', () => {
  test('isolates one exact root pass and all owned cadence events', async () => {
    const fixture = await createIntervalFixture({ includeCadence: true })
    const verified =
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        verifierInput(fixture),
      )

    expect(verified.predecessor).toBeNull()
    expect(verified.segment.segmentOrdinal).toBe(0)
    expect(verified.interval).toMatchObject({
      phase: 'integrity-check',
      describeTableCallCount: 6,
      firstAttemptSequence: 1,
      lastAttemptSequence: 6,
      cadenceWaitCount: 6,
      cadenceWaitMilliseconds: 30,
      startedAt: '2026-08-02T00:00:00.010Z',
      completedAt: '2026-08-02T00:00:00.060Z',
    })
    expect(verified.interval.attemptSequences).toEqual([1, 2, 3, 4, 5, 6])
    expect(verified.interval.eventSequences).toEqual(
      Array.from({ length: 18 }, (_value, index) => index + 1),
    )
  })

  test('authenticates exact raw predecessor and successor bytes', async () => {
    const predecessor = await createPredecessor()
    const fixture = await createIntervalFixture({ predecessor })
    const verified =
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        verifierInput(fixture),
      )

    expect(verified.predecessor?.segmentOrdinal).toBe(0)
    expect(verified.segment.segmentOrdinal).toBe(1)
    expect(verified.interval.firstAttemptSequence).toBe(2)
    expect(verified.interval.lastAttemptSequence).toBe(7)
    expect(verified.interval.firstEventSequence).toBe(3)
    expect(verified.interval.lastEventSequence).toBe(14)
  })

  test('rejects a tampered raw predecessor and wrong phase substitution', async () => {
    const predecessor = await createPredecessor()
    const tampered = await createIntervalFixture({ predecessor })
    const predecessorBytes = tampered.predecessorSegmentBytes?.slice()
    if (predecessorBytes === undefined || predecessorBytes === null) {
      throw new Error('Missing predecessor fixture.')
    }
    predecessorBytes[0] = (predecessorBytes[0] ?? 0) ^ 1
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval({
        ...verifierInput(tampered),
        predecessorSegmentBytes: predecessorBytes,
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const wrongPhase = await createIntervalFixture({
      recordedPhase: 'measurement',
    })
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        verifierInput(wrongPhase),
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('rejects an authenticated interval outside runtime provenance', async () => {
    const fixture = await createIntervalFixture()
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval({
        ...verifierInput(fixture),
        expectedStartedAt: '2026-08-02T00:00:00.050Z',
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('rejects proxies, accessors, shared buffers, and subclasses', async () => {
    const proxyFixture = await createIntervalFixture()
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        new Proxy(verifierInput(proxyFixture), {}),
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const accessorFixture = await createIntervalFixture()
    const accessorInput = verifierInput(accessorFixture)
    Object.defineProperty(accessorInput, 'canonicalSegmentBytes', {
      enumerable: true,
      /** Returns bytes only if an unsafe accessor is invoked. */
      get: () => accessorFixture.canonicalSegmentBytes,
    })
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        accessorInput,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const sharedFixture = await createIntervalFixture()
    const shared = new Uint8Array(
      new SharedArrayBuffer(sharedFixture.canonicalSegmentBytes.byteLength),
    )
    shared.set(sharedFixture.canonicalSegmentBytes)
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval({
        ...verifierInput(sharedFixture),
        canonicalSegmentBytes: shared,
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const subclassFixture = await createIntervalFixture()
    class DerivedBytes extends Uint8Array {}
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval({
        ...verifierInput(subclassFixture),
        authenticationKey: new DerivedBytes(authenticationKey),
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('binds the exact causal live result, raw attestation, and 12 calls', async () => {
    const attestation = createResourceAttestation()
    const result = await createLiveResult(attestation)
    const rateBinding = await createLiveRateBinding(result)
    const finalizer = liveFinalizerInput(rateBinding, result, attestation)
    const finalized =
      finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
        finalizer.input,
      )

    expect(finalizer.transferredIntegrityKey.every((value) => value === 0))
      .toBe(true)
    expect(finalized).toMatchObject({
      version: 1,
      result: {
        resultMac: result.resultMac,
        runtimeProvenance: result.runtimeProvenance,
      },
      interval: {
        tablePassCount: 2,
        describeTableCallCount: 12,
        firstAttemptSequence: 2,
        lastAttemptSequence: 13,
      },
      policyVersion,
      configurationBindingDigest,
    })
    expect(finalized.tableOrderBindingMac).toMatch(/^[0-9a-f]{64}$/u)
    expect(finalized.bindingMac).toMatch(/^[0-9a-f]{64}$/u)
    const serialized = JSON.stringify(finalized)
    expect(serialized).not.toContain(orderedTableNames[0] ?? '')
    expect(serialized).not.toContain('tableOrderBindingDigest')

    const cloned = structuredClone(finalized)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(cloned)
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(
      consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
        finalized,
      ),
    ).toEqual(finalized)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
        finalized,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('rejects a different valid result and post-interval mutation', async () => {
    const attestation = createResourceAttestation()
    const causalResult = await createLiveResult(attestation)
    const substitutedResult = await createLiveResult(
      attestation,
      '2026-08-02T00:00:01.000Z',
      '2026-08-02T00:00:02.500Z',
    )
    const substitutionBinding = await createLiveRateBinding(causalResult)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
        liveFinalizerInput(
          substitutionBinding,
          substitutedResult,
          attestation,
        ).input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const mutableResult = await createLiveResult(attestation)
    const mutationBinding = await createLiveRateBinding(mutableResult)
    mutableResult.checkedAt = '2026-08-02T00:00:02.500Z'
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
        liveFinalizerInput(mutationBinding, mutableResult, attestation).input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('rejects a physical-table substitution and narrower result provenance', async () => {
    const attestation = createResourceAttestation()
    const tableResult = await createLiveResult(attestation)
    const tableBinding = await createLiveRateBinding(tableResult)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
        liveFinalizerInput(
          tableBinding,
          tableResult,
          createResourceAttestation('-different'),
        ).input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const narrowResult = await createLiveResult(
      attestation,
      '2026-08-02T00:00:01.050Z',
      '2026-08-02T00:00:02.000Z',
    )
    const narrowBinding = await createLiveRateBinding(narrowResult)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
        liveFinalizerInput(narrowBinding, narrowResult, attestation).input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('seals the causal ordinal-zero attestation and exact durable aggregate', async () => {
    const attestation = createResourceAttestation()
    const fixture = await createIntervalFixture({
      taskResult: attestation,
      includeInitialMeasurement: true,
    })
    const rateBinding =
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        verifierInput(fixture),
      )
    const finalizer = await rootFinalizerInput(rateBinding, attestation)
    const root =
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        finalizer.input,
      )

    expect(finalizer.transferredIntegrityKey.every((value) => value === 0))
      .toBe(true)
    expect(root).toMatchObject({
      deploymentTargetId: 'test-rehearsal',
      account: attestation.account,
      region: attestation.region,
      commit: 'a'.repeat(40),
      predecessor: null,
      segment: {
        segmentOrdinal: 0,
        firstEventSequence: 1,
      },
      interval: {
        tablePassCount: 1,
        describeTableCallCount: 6,
        firstAttemptSequence: 7,
        lastAttemptSequence: 12,
      },
      aggregate: rateEvidence(12, 0),
      startedAt: fixture.expectedStartedAt,
      completedAt: fixture.expectedCompletedAt,
    })
    expect(root.attestation.resourceIdentities).toHaveLength(7)
    expect(root.attestation.contentMac).toMatch(/^[0-9a-f]{64}$/u)
    expect(root.tableOrderBindingMac).toMatch(/^[0-9a-f]{64}$/u)
    expect(root.rootMac).toMatch(/^[0-9a-f]{64}$/u)
    const serialized = JSON.stringify(root)
    expect(serialized).not.toContain(orderedTableNames[0] ?? '')
    expect(serialized).not.toContain('tableOrderBindingDigest')

    const authorizations =
      authorizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        root,
      )
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootInventoryAuthorization(
        authorizations.permit,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    const projection =
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization(
        {
          authorization: authorizations.permit,
          expected: permitExpectedClaims(root),
        },
      )
    expect(projection).toMatchObject({
      deploymentTargetId: root.deploymentTargetId,
      productionAccountDigest: root.productionAccountDigest,
      configurationBindingDigest: root.configurationBindingDigest,
      policyVersion: root.policyVersion,
      attestation: {
        contentMac: root.attestation.contentMac,
        byteLength: root.attestation.byteLength,
      },
      rootMac: root.rootMac,
    })
    expect(JSON.stringify(projection)).not.toContain(root.account)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization(
        {
          authorization: authorizations.permit,
          expected: permitExpectedClaims(root),
        },
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootInventoryAuthorization(
        authorizations.inventory,
      ),
    ).toEqual(root)
    expect(() =>
      authorizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        structuredClone(root),
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('rejects forged and cloned root measurement authority before one genuine use', async () => {
    const attestation = createResourceAttestation()
    const finalizer = await createRootFinalizerFixture(attestation)
    const forgedCapability = Object.freeze({
      kind: finalizer.measurement.capability.kind,
      version: finalizer.measurement.capability.version,
      firstAttemptSequence:
        finalizer.measurement.capability.firstAttemptSequence,
      lastAttemptSequence:
        finalizer.measurement.capability.lastAttemptSequence,
      configurationBindingDigest:
        finalizer.measurement.capability.configurationBindingDigest,
      policyVersion: finalizer.measurement.capability.policyVersion,
    })

    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...finalizer.input,
        measurementCapability: forgedCapability,
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...finalizer.input,
        measurementCapability: structuredClone(
          finalizer.measurement.capability,
        ),
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const root =
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        finalizer.input,
      )
    expect(root.configurationBindingDigest).toBe(configurationBindingDigest)
    expect(finalizer.transferredIntegrityKey.every((value) => value === 0))
      .toBe(true)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        finalizer.input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('binds genuine root measurement tokens to their exact returned references', async () => {
    const attestation = createResourceAttestation()
    const finalizer = await createRootFinalizerFixture(attestation)
    const otherMeasurement = await createRootMeasurement(
      createMeasuredConfiguration(),
    )

    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...finalizer.input,
        measuredConfiguration: otherMeasurement.configuration,
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        finalizer.measurement.capability,
        finalizer.measurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')

    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...finalizer.input,
        measurementCapability: otherMeasurement.capability,
        measuredConfiguration: finalizer.measurement.configuration,
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        otherMeasurement.capability,
        otherMeasurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
  })

  test('rejects every measured root identity mismatch and burns its token', async () => {
    const attestation = createResourceAttestation()
    const mismatches = [
      {
        account: '210987654321',
        callerArn:
          'arn:aws:sts::210987654321:assumed-role/MigrationOperator/rehearsal',
      },
      { region: 'us-east-1' },
      {
        callerArn:
          'arn:aws:sts::123456789012:assumed-role/OtherMigrationOperator/rehearsal',
      },
      { commit: 'b'.repeat(40) },
    ] satisfies readonly RootFinalizerInputOptions[]

    for (const options of mismatches) {
      const finalizer = await createRootFinalizerFixture(
        attestation,
        options,
      )
      expect(() =>
        finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
          finalizer.input,
        )
      ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
      expect(() =>
        consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
          finalizer.measurement.capability,
          finalizer.measurement.configuration,
        )
      ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
    }
  })

  test('rejects post-measurement mutation outside requested resources and burns the token', async () => {
    const attestation = createResourceAttestation()
    const finalizer = await createRootFinalizerFixture(attestation)
    finalizer.measurement.configuration.callerRoleId =
      'AROA0987654321ZYXWVUT'

    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        finalizer.input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        finalizer.measurement.capability,
        finalizer.measurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
  })

  test('rejects recomputed resource bindings after profile, table, or journal substitution', async () => {
    const attestation = createResourceAttestation()

    const profileFinalizer = await createRootFinalizerFixture(attestation)
    profileFinalizer.measurement.configuration.profile =
      'substituted-operator'
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...profileFinalizer.input,
        requestedResourcesBinding: measuredRequestedResourcesBinding(
          profileFinalizer.measurement.configuration,
        ),
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        profileFinalizer.measurement.capability,
        profileFinalizer.measurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')

    const tableFinalizer = await createRootFinalizerFixture(attestation)
    tableFinalizer.measurement.configuration.tables[
      'workspace-search'
    ].tableName = 'substituted-workspace-search-table'
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...tableFinalizer.input,
        requestedResourcesBinding: measuredRequestedResourcesBinding(
          tableFinalizer.measurement.configuration,
        ),
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        tableFinalizer.measurement.capability,
        tableFinalizer.measurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')

    const journalFinalizer = await createRootFinalizerFixture(attestation)
    journalFinalizer.measurement.configuration.journal.bucketName =
      'substituted-rehearsal-journal'
    journalFinalizer.measurement.configuration.journal.keyArn =
      'arn:aws:kms:ap-northeast-1:123456789012:key/11111111-1111-1111-1111-111111111111'
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...journalFinalizer.input,
        requestedResourcesBinding: measuredRequestedResourcesBinding(
          journalFinalizer.measurement.configuration,
        ),
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        journalFinalizer.measurement.capability,
        journalFinalizer.measurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
  })

  test('rejects genuine measurement configuration or policy drift from the root segment', async () => {
    const attestation = createResourceAttestation()
    const changedConfiguration = createMeasuredConfiguration()
    changedConfiguration.profile = 'other-genuine-operator'
    const configurationFinalizer = await createRootFinalizerFixture(
      attestation,
      { measuredConfiguration: changedConfiguration },
    )
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        configurationFinalizer.input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        configurationFinalizer.measurement.capability,
        configurationFinalizer.measurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')

    const policyFinalizer = await createRootFinalizerFixture(attestation, {
      measurementPolicyVersion: digest('other-root-measurement-policy'),
    })
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        policyFinalizer.input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        policyFinalizer.measurement.capability,
        policyFinalizer.measurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
  })

  test('reauthenticates persisted root bytes and separates fresh purposes', async () => {
    const attestation = createResourceAttestation()
    const fixture = await createIntervalFixture({
      taskResult: attestation,
      includeInitialMeasurement: true,
    })
    const rateBinding =
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        verifierInput(fixture),
      )
    const root =
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        (await rootFinalizerInput(rateBinding, attestation)).input,
      )
    const persistedInput = {
      rootBytes: new TextEncoder().encode(
        serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
          root,
        ),
      ),
      canonicalSegmentBytes: fixture.canonicalSegmentBytes,
      resourceAttestationBytes: resourceAttestationBytes(attestation),
      rateAuthenticationKey: authenticationKey,
    }
    const authorizations =
      verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        persistedInput,
      )

    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization(
        {
          authorization: structuredClone(authorizations.permit),
          expected: permitExpectedClaims(root),
        },
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization(
        {
          authorization: authorizations.permit,
          expected: permitExpectedClaims(root),
        },
      ).rootMac,
    ).toBe(root.rootMac)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization(
        {
          authorization: authorizations.inventory,
          expected: permitExpectedClaims(root),
        },
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootInventoryAuthorization(
        authorizations.inventory,
      ).rootMac,
    ).toBe(root.rootMac)

    const mismatched =
      verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        persistedInput,
      )
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization({
        authorization: mismatched.permit,
        expected: {
          ...permitExpectedClaims(root),
          productionAccountDigest: digest('different-production-account'),
        },
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization({
        authorization: mismatched.permit,
        expected: permitExpectedClaims(root),
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const premature =
      verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        persistedInput,
      )
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization({
        authorization: premature.permit,
        expected: {
          ...permitExpectedClaims(root),
          issuedAt: '2026-08-01T23:59:59.999Z',
        },
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...persistedInput,
        rootBytes: new TextEncoder().encode(
          serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
            ...root,
            rootMac: '0'.repeat(64),
          }),
        ),
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    const tamperedSegment = fixture.canonicalSegmentBytes.slice()
    tamperedSegment[0] = (tamperedSegment[0] ?? 0) ^ 1
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...persistedInput,
        canonicalSegmentBytes: tamperedSegment,
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    const nonCanonicalAttestation = new TextEncoder().encode(
      ` ${serializeCrossDomainIntegrityResourceAttestation(attestation)}`,
    )
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
        ...persistedInput,
        resourceAttestationBytes: nonCanonicalAttestation,
      })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    const canonicalRootText =
      serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(root)
    expect(
      parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootBytes(
        new TextEncoder().encode(canonicalRootText),
      ),
    ).toEqual(root)
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootBytes(
        new TextEncoder().encode(` ${canonicalRootText}`),
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
    const duplicateKeyRootText = canonicalRootText.replace(
      '{',
      `{"kind":${JSON.stringify(root.kind)},`,
    )
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootBytes(
        new TextEncoder().encode(duplicateKeyRootText),
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })

  test('rejects root aggregate drift, attestation substitution, and extra calls', async () => {
    const attestation = createResourceAttestation()
    const aggregateFixture = await createIntervalFixture({
      taskResult: attestation,
      includeInitialMeasurement: true,
    })
    const aggregateBinding =
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        verifierInput(aggregateFixture),
      )
    const aggregateFinalizer = await rootFinalizerInput(
      aggregateBinding,
      attestation,
      { durableEvidence: rateEvidence(13, 0) },
    )
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        aggregateFinalizer.input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const substitutionFixture = await createIntervalFixture({
      taskResult: attestation,
      includeInitialMeasurement: true,
    })
    const substitutionBinding =
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        verifierInput(substitutionFixture),
      )
    const substitutionFinalizer = await rootFinalizerInput(
      substitutionBinding,
      createResourceAttestation(),
    )
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        substitutionFinalizer.input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')

    const extraFixture = await createIntervalFixture({
      taskResult: attestation,
      appendExtraIntegrityAttempt: true,
      includeInitialMeasurement: true,
    })
    const extraBinding =
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
        verifierInput(extraFixture),
      )
    const extraFinalizer = await rootFinalizerInput(
      extraBinding,
      attestation,
      { durableEvidence: rateEvidence(13, 0) },
    )
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
        extraFinalizer.input,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE')
  })
})
