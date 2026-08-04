import { createHash } from 'node:crypto'
import {
  DescribeTableCommand,
  type DescribeTableCommandOutput,
} from '@aws-sdk/client-dynamodb'
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
  type CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import type {
  CrossDomainIntegrityAwsTransport,
  CrossDomainIntegrityTableNames,
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
  createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
} from './migration-rehearsal-integrity-rate-adapter'
import {
  finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval,
  type WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalRateRecorder,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
  type FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalRateRecorder,
} from './migration-rehearsal-rate-evidence'
import type {
  WorkspaceSearchMigrationRehearsalTargetAuditContext,
} from './migration-rehearsal-target-audit'

/** Dedicated #163 result-key seed used only by target-audit tests. */
const targetAuditIntegrityDigestKeySeed = new Uint8Array(32).fill(73)

/** Canonical private resource attestation used by target-audit tests. */
export const targetAuditIntegrityResourceAttestation =
  createTargetAuditIntegrityResourceAttestation()

/** Reviewed policy digest shared by every target-audit test segment. */
export const targetAuditPolicyVersion = digestTargetAuditFixture(
  'target-audit-policy',
)

/** Permit-facing resource identity derived from the canonical attestation. */
export const targetAuditIntegrityResourceIdentityDigest =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    createCrossDomainIntegrityImmutableResourceIdentities(
      targetAuditIntegrityResourceAttestation,
      targetAuditIntegrityDigestKeySeed,
    ),
    targetAuditIntegrityDigestKeySeed,
  )

/** Genuine integrity capability paired with its shared enclosing rate proof. */
export type TargetAuditIntegrityRateFixture = {
  /** Genuine same-process rate-bound #163 result awaiting one consumer. */
  readonly integrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
  /** Fresh rate evidence over the same predecessor and current segment. */
  readonly rate:
    FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput
}

/** Optional adversarial controls for one genuine target-audit fixture. */
export type CreateTargetAuditIntegrityRateFixtureOptions = {
  /** Overrides the trusted live checker start. */
  readonly integrityStartedAt?: string
  /** Overrides the trusted live checker completion. */
  readonly integrityCompletedAt?: string
  /** Overrides the runtime rate key for wrong-key tests. */
  readonly rateAuthenticationKey?: Uint8Array
}

/**
 * Creates one genuine two-pass live result and a rate proof over its segment.
 *
 * @param context - Parent target context supplying policy and configuration.
 * @param label - Unique secret-free segment locator seed.
 * @param observedAt - Completion of the enclosing target observation.
 * @param options - Optional controlled time or key substitutions.
 * @returns One-shot live result and fresh shared-segment rate proof.
 */
export async function createTargetAuditIntegrityRateFixture(
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  label: string,
  observedAt: string,
  options: CreateTargetAuditIntegrityRateFixtureOptions = {},
): Promise<TargetAuditIntegrityRateFixture> {
  const observedAtMilliseconds = Date.parse(observedAt)
  const integrityStartedAt = options.integrityStartedAt ??
    new Date(observedAtMilliseconds - 1_000).toISOString()
  const integrityCompletedAt = options.integrityCompletedAt ??
    new Date(observedAtMilliseconds - 500).toISOString()
  const predecessorAnchorAt = new Date(
    Date.parse(integrityStartedAt) - 1_000,
  ).toISOString()
  const authenticationKey = options.rateAuthenticationKey ??
    new Uint8Array(32).fill(91)
  const predecessor = await createTargetAuditPredecessor(
    context,
    label,
    authenticationKey,
    predecessorAnchorAt,
  )
  const recorder = await createTargetAuditRecorder(
    context,
    `${label}:current`,
    authenticationKey,
    integrityStartedAt,
    predecessor,
  )
  const rate = createTargetAuditManagedRate(
    targetAuditIntegrityResourceAttestation,
    recorder,
    context.policyVersion,
  )
  const tableNames = createTargetAuditTableNames(
    targetAuditIntegrityResourceAttestation,
  )
  const adapter = createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter({
    tableNames,
    tablePassCount: 2,
    baseTransport: createUnusedTargetAuditTransport(),
    rate,
  })
  const signal = new AbortController().signal
  const resourceIdentities =
    createCrossDomainIntegrityImmutableResourceIdentities(
      targetAuditIntegrityResourceAttestation,
      targetAuditIntegrityDigestKeySeed,
    )
  const result = await adapter.run(async () => {
    for (let passIndex = 0; passIndex < 2; passIndex += 1) {
      for (const tableName of Object.values(tableNames)) {
        await adapter.describeTable(
          new DescribeTableCommand({ TableName: tableName }),
          signal,
        )
      }
    }
    return await runCrossDomainIntegrityCheck({
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      deadline: createCrossDomainIntegrityInvocationDeadline({
        maximumDurationMilliseconds: 60_000,
        monotonicClock: () => 1_000,
      }),
      role: 'source',
      checkedAt: integrityCompletedAt,
      observationMode: 'migration-rehearsal-live',
      liveRuntimeObservation: {
        startedAt: integrityStartedAt,
        completedAt: integrityCompletedAt,
      },
      resourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      digestKey: targetAuditIntegrityDigestKeySeed,
      resourceBindingDigest:
        calculateCrossDomainIntegrityResourceBindingDigest(),
      resourceIdentities,
      resourceIdentityDigest:
        targetAuditIntegrityResourceIdentityDigest,
      limits: {
        pageSize: 100,
        maxPages: 10,
        maxItems: 1_000,
      },
      reader: {
        /** Returns an empty valid page for every logical domain. */
        async readPage() {
          return { items: [] }
        },
      },
    })
  })
  const sequence = adapter.takeCompletedSequence(result)
  const current = await recorder.flush()
  await recorder.close()
  const verifiedSuccessor =
    verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
      predecessorSegmentBytes: predecessor.canonicalBytes,
      successorSegmentBytes: current.canonicalBytes,
      authenticationKey: new Uint8Array(authenticationKey),
      expectedPolicyVersion: context.policyVersion,
      expectedConfigurationBindingDigest:
        context.configurationBindingDigest,
    })
  const rateBinding =
    verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval({
      canonicalSegmentBytes: current.canonicalBytes,
      authenticationKey: new Uint8Array(authenticationKey),
      predecessorSegmentBytes: predecessor.canonicalBytes,
      expectedPolicyVersion: context.policyVersion,
      expectedConfigurationBindingDigest:
        context.configurationBindingDigest,
      expectedStartedAt: integrityStartedAt,
      expectedCompletedAt: integrityCompletedAt,
      sequence,
      taskResult: result,
    })
  const integrity =
    finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult({
      rateBinding,
      result,
      resourceAttestation: targetAuditIntegrityResourceAttestation,
      integrityDigestKey:
        new Uint8Array(targetAuditIntegrityDigestKeySeed),
      rateAuthenticationKey: new Uint8Array(authenticationKey),
      expectedResourceIdentityDigest:
        targetAuditIntegrityResourceIdentityDigest,
      clock: () => new Date(integrityCompletedAt),
    })
  return Object.freeze({
    integrity,
    rate: Object.freeze({
      verifiedSuccessor,
      durableEvidence: createTargetAuditRateEvidence(
        context.policyVersion,
        13,
      ),
      completedAt: new Date(observedAtMilliseconds + 1_000).toISOString(),
    }),
  })
}

/** Creates one deterministic lowercase SHA-256 fixture digest. */
function digestTargetAuditFixture(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Creates the canonical private immutable seven-resource attestation. */
function createTargetAuditIntegrityResourceAttestation():
  CrossDomainIntegrityResourceAttestation {
  const account = '123456789012'
  const region = 'ap-northeast-1'
  const tableNames = [
    'audit-events-target-audit-table',
    'file-proofing-target-audit-table',
    'project-directory-target-audit-table',
    'work-item-configuration-target-audit-table',
    'work-items-target-audit-table',
    'workspace-access-target-audit-table',
  ]
  return {
    kind: 'mukuroji-cross-domain-integrity-resource-attestation',
    version: 1,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account,
    region,
    bucket: {
      target: 'bucket:file',
      bucketName: 'mukuroji-target-audit-files',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'target-audit-marker-version-1',
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
          tableId: `immutable-target-audit-table-id-${index + 1}`,
          creationTime: `2026-01-0${index + 1}T00:00:00.000Z`,
        }
      },
    ),
  }
}

/** Creates the exact logical-to-physical table allowlist. */
function createTargetAuditTableNames(
  attestation: CrossDomainIntegrityResourceAttestation,
): CrossDomainIntegrityTableNames {
  return {
    'audit-events': attestation.tables[0]?.tableName ?? '',
    'file-proofing': attestation.tables[1]?.tableName ?? '',
    'project-directory': attestation.tables[2]?.tableName ?? '',
    'work-item-configuration': attestation.tables[3]?.tableName ?? '',
    'work-items': attestation.tables[4]?.tableName ?? '',
    'workspace-access': attestation.tables[5]?.tableName ?? '',
  }
}

/** Creates one authenticated recorder linked to an optional predecessor. */
async function createTargetAuditRecorder(
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  label: string,
  authenticationKey: Uint8Array,
  anchorUtc: string,
  predecessor:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment | undefined,
): Promise<WorkspaceSearchMigrationRehearsalRateRecorder> {
  return await createWorkspaceSearchMigrationRehearsalRateRecorder({
    segmentLocatorDigest: digestTargetAuditFixture(`segment:${label}`),
    segmentOrdinal: predecessor === undefined ? 0 : 1,
    previousSegmentDigest: predecessor?.segmentDigest ?? null,
    previousRecordMac: predecessor?.terminalRecordMac ?? null,
    firstEventSequence: predecessor === undefined
      ? 1
      : predecessor.firstEventSequence + predecessor.eventCount,
    anchorUtc,
    monotonicAnchorMilliseconds: predecessor === undefined ? 1_000 : 2_000,
    policyVersion: context.policyVersion,
    configurationBindingDigest: context.configurationBindingDigest,
    authenticationKey,
    /** Accepts each exact canonical append in memory. */
    async appendDurably(): Promise<void> {},
  })
}

/** Creates one predecessor containing the preceding measurement attempt. */
async function createTargetAuditPredecessor(
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  label: string,
  authenticationKey: Uint8Array,
  anchorUtc: string,
): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment> {
  const recorder = await createTargetAuditRecorder(
    context,
    `${label}:predecessor`,
    authenticationKey,
    anchorUtc,
    undefined,
  )
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
  const predecessor = await recorder.flush()
  await recorder.close()
  return predecessor
}

/** Resolves one exact attested table by physical name. */
function findTargetAuditAttestedTable(
  attestation: CrossDomainIntegrityResourceAttestation,
  tableName: string,
) {
  const table = attestation.tables.find((candidate) =>
    candidate.tableName === tableName)
  if (table === undefined) throw new Error('Unknown target-audit table.')
  return table
}

/** Creates a managed rate owner that records all twelve adapter calls. */
function createTargetAuditManagedRate(
  attestation: CrossDomainIntegrityResourceAttestation,
  recorder: WorkspaceSearchMigrationRehearsalRateRecorder,
  policyVersion: string,
): WorkspaceSearchMigrationManagedDescribeTableRate {
  let attemptCount = 1
  return {
    /** Records and answers one exact attested DescribeTable call. */
    async describeTable(
      tableName: string,
      phase: WorkspaceSearchMigrationDescribeTablePhase,
    ): Promise<DescribeTableCommandOutput> {
      const table = findTargetAuditAttestedTable(attestation, tableName)
      attemptCount += 1
      recorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'attempt',
        phase,
        sequence: attemptCount,
        observedAtMilliseconds: 2_000 + attemptCount * 10,
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
    /** Runs the complete integrity checker under one non-page gate. */
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
    /** Reads the exact current cumulative aggregate. */
    readEvidence: () =>
      createTargetAuditRateEvidence(policyVersion, attemptCount),
    /** Reads the exact final cumulative aggregate. */
    async closeAndReadEvidence() {
      return createTargetAuditRateEvidence(policyVersion, attemptCount)
    },
    /** Leaves the fixture lifecycle unchanged. */
    async close(): Promise<void> {},
  }
}

/** Creates one cumulative clean managed-rate aggregate. */
function createTargetAuditRateEvidence(
  policyVersion: string,
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
    maximumInFlight: 1,
  }
}

/** Creates the unused base transport retained behind the rate adapter. */
function createUnusedTargetAuditTransport():
  CrossDomainIntegrityAwsTransport {
  return {
    /** No-op fixture close. */
    close(): void {},
    /** Rejects every forbidden base DescribeTable fallback. */
    async describeTable(): Promise<DescribeTableCommandOutput> {
      throw new Error('Forbidden target-audit DescribeTable fallback.')
    },
    /** Returns enabled versioning for an unused bucket read. */
    async getBucketVersioning() {
      return { $metadata: {}, Status: 'Enabled' }
    },
    /** Returns an unused object-attributes result. */
    async getObjectAttributes() {
      return { $metadata: {} }
    },
    /** Returns an unused empty tag set. */
    async getObjectTagging() {
      return { $metadata: {}, TagSet: [] }
    },
    /** Returns unused empty object headers. */
    async headObject() {
      return { $metadata: {} }
    },
    /** Returns the fixed fixture account. */
    async readCallerIdentity() {
      return { $metadata: {}, Account: '123456789012' }
    },
    /** Returns an unused empty table page. */
    async scan() {
      return { $metadata: {}, Items: [] }
    },
  }
}
