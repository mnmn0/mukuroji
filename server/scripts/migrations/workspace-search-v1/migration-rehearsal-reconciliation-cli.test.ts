import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
} from './migration-identity'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
} from './migration-describe-table-rate-policy'
import type {
  CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
  CompleteWorkspaceSearchMigrationRehearsalReconciliationInput,
  FinalizeAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
  RunAwsWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
  WorkspaceSearchMigrationRehearsalCollectedReconciliationBase,
  WorkspaceSearchMigrationRehearsalIntegrityAwsPending,
  WorkspaceSearchMigrationRehearsalIntegrityAwsSession,
} from './migration-identity-aws'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
} from './migration-rehearsal-key-derivation'
import {
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
  type WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
} from './migration-rehearsal-parent-liveness'
import {
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  type FinalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput,
  type WorkspaceSearchMigrationRehearsalFinalizedReconciliationAuditArtifact,
  type WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
} from './migration-rehearsal-reconciliation-audit'
import {
  parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments,
  runWorkspaceSearchMigrationRehearsalReconciliationCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_APPROVAL,
  type WorkspaceSearchMigrationRehearsalAuthenticatedCollection,
  type WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  type WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
  type WorkspaceSearchMigrationRehearsalReconciliationCliSession,
} from './migration-rehearsal-reconciliation-cli'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor,
} from './migration-rehearsal-rate-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
} from './migration-rehearsal-stage-receipt'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_VERSION,
} from './migration-rehearsal-stage-reservation'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'
import type {
  WorkspaceSearchMigrationRehearsalTargetAuditContext,
} from './migration-rehearsal-target-audit'

/** Valid reviewed policy used by every AWS-free CLI fixture. */
const ratePolicyBytes = encodeCanonical({
  schemaVersion: 1,
  maximumAttemptsPerWindow: 400,
  maximumAttemptsPerLifecycle: 400,
  checkpointPageAttemptCapacity:
    WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
  windowMilliseconds: 1_000,
  minimumAttemptIntervalMilliseconds: 20,
  minimumPageIntervalMilliseconds: 1_000,
  maximumAdmissionWaitMilliseconds: 30_000,
  throttleBackoffInitialMilliseconds: 100,
  throttleBackoffMaximumMilliseconds: 2_000,
})

/** Fixed immutable resource identities retained by permit fixtures. */
const integrityResourceIdentities:
  readonly CrossDomainIntegrityResourceIdentity[] =
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target) => Object.freeze({
    target,
    identityDigest: digest(`integrity-resource:${target}`),
  }))

/** Exact permit-pinned resource identity digest. */
const integrityResourceIdentityDigest = digest('integrity-resources')

/** Explicit resources accepted by the existing strict measure parser. */
const measureResourceArguments: readonly string[] = [
  '--account',
  '123456789012',
  '--region',
  'ap-northeast-1',
  '--profile',
  'migration-operator',
  '--commit',
  'a'.repeat(40),
  '--project-directory-table',
  'project-directory-table',
  '--work-items-table',
  'work-items-table',
  '--collaboration-table',
  'collaboration-table',
  '--documents-table',
  'documents-table',
  '--workspace-search-table',
  'workspace-search-table',
  '--migration-state-table',
  'migration-state-table',
  '--journal-bucket',
  'mukuroji-migration-journal',
  '--journal-key-arn',
  'arn:aws:kms:ap-northeast-1:123456789012:key/12345678-1234-1234-1234-123456789012',
]

/** Shared exact parent-authenticated material and rate prefix. */
const commonArguments: readonly string[] = [
  '--manifest-file',
  '/restricted/manifest.json',
  '--previous-receipt-file',
  '/restricted/previous-receipt.json',
  '--material-file',
  '/restricted/material.json',
  '--lifecycle-file',
  '/restricted/lifecycle.json',
  '--parent-authentication-file',
  '/restricted/parent-authentication.json',
  '--control-arguments-file',
  '/restricted/control-arguments.json',
  '--permit-file',
  '/restricted/permit.json',
  '--authentication-key-file',
  '/restricted/master.key',
  '--previous-rate-segment-file',
  '/restricted/rate-before.ndjson',
  '--rate-segment-file',
  '/restricted/rate-current.ndjson',
]

describe('migration rehearsal reconciliation CLI v3', () => {
  test('parses exact live profiles for verified and both target modes', () => {
    const verified =
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        createVerifiedArguments(),
      )
    expect(verified.mode).toBe('reconcile')
    if (verified.mode !== 'reconcile') throw new Error('Expected reconcile.')
    expect(verified.integrityFiles).toEqual({
      kind: 'verified-live',
      resourceAttestationFile: '/restricted/resource-attestation.json',
      integrityDigestKeyFile: '/restricted/integrity.key',
      auditPseudonymKeyFile: '/restricted/audit.key',
      pageSize: 100,
      maxPages: 10,
      maxItems: 1_000,
      integrityMaximumDurationMilliseconds: 30_000,
    })

    const targetModes: readonly (
      'target-preimage' | 'target-restored'
    )[] = ['target-preimage', 'target-restored']
    for (const mode of targetModes) {
      const target =
        parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
          createTargetArguments(mode),
        )
      expect(target.mode).toBe(mode)
      if (target.mode === 'reconcile') throw new Error('Expected target.')
      expect(target.resourceAttestationFile).toBe(
        '/restricted/resource-attestation.json',
      )
      expect(target.integrityDigestKeyFile).toBe(
        '/restricted/integrity.key',
      )
      expect(target.auditPseudonymKeyFile).toBe('/restricted/audit.key')
      expect(target.pageSize).toBe(100)
      expect(target.maxPages).toBe(10)
      expect(target.maxItems).toBe(1_000)
      expect(target.integrityMaximumDurationMilliseconds).toBe(30_000)
    }
  })

  test('rollback accepts only the target v4 pair before reconciliation limits', () => {
    const configuration =
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        createRollbackArguments(),
      )
    expect(configuration.mode).toBe('reconcile')
    if (configuration.mode !== 'reconcile') throw new Error('Expected reconcile.')
    expect(configuration.integrityFiles).toEqual({
      kind: 'rollback-target-pair',
      targetPreimageAuditFile: '/restricted/target-before.json',
      targetRestoredAuditFile: '/restricted/target-after.json',
    })
    expect(Reflect.has(configuration.integrityFiles, 'integrityKeyFile')).toBe(
      false,
    )
  })

  test('rejects reordered live flags and every legacy result/key flag', () => {
    const reordered = createVerifiedArguments()
    const keyFlag = reordered.indexOf('--integrity-digest-key-file')
    reordered[keyFlag] = '--audit-pseudonym-key-file'
    reordered[keyFlag + 2] = '--integrity-digest-key-file'
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        reordered,
      )).toThrow('INVALID_USAGE')

    const legacyProfiles: readonly string[][] = [
      [
        'reconcile',
        ...commonArguments,
        '--integrity-result-file',
        '/restricted/integrity.json',
        '--integrity-key-file',
        '/restricted/integrity.key',
        ...reconciliationLimitArguments(),
        ...outputAndMeasureArguments(),
      ],
      [
        'reconcile',
        ...commonArguments,
        '--integrity-before-result-file',
        '/restricted/integrity-before.json',
        '--integrity-after-result-file',
        '/restricted/integrity-after.json',
        '--integrity-key-file',
        '/restricted/integrity.key',
        '--target-preimage-audit-file',
        '/restricted/target-before.json',
        '--target-restored-audit-file',
        '/restricted/target-after.json',
        ...reconciliationLimitArguments(),
        ...outputAndMeasureArguments(),
      ],
      [
        'target-preimage',
        ...commonArguments,
        '--maximum-target-pages',
        '1024',
        '--maximum-duration-milliseconds',
        '60000',
        '--integrity-before-result-file',
        '/restricted/integrity-before.json',
        '--integrity-key-file',
        '/restricted/integrity.key',
        ...outputAndMeasureArguments(),
      ],
    ]
    for (const legacy of legacyProfiles) {
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
          legacy,
        )).toThrow('INVALID_USAGE')
    }
  })

  test('rejects invalid coupled live limits and aliased private paths', () => {
    const excessiveCapacity = createVerifiedArguments()
    replaceFlagValue(excessiveCapacity, '--page-size', '1000')
    replaceFlagValue(excessiveCapacity, '--max-pages', '10000')
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        excessiveCapacity,
      )).toThrow('INVALID_USAGE')

    const excessiveItems = createTargetArguments('target-restored')
    replaceFlagValue(excessiveItems, '--max-items', '1001')
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        excessiveItems,
      )).toThrow('INVALID_USAGE')

    const aliased = createTargetArguments('target-preimage')
    aliased[aliased.indexOf('/restricted/audit.key')] =
      '/restricted/integrity.key'
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        aliased,
      )).toThrow('INVALID_USAGE')
  })

  test('rejects every live key collision before AWS and zeroizes every read', async () => {
    const masterKey = new Uint8Array(32).fill(11)
    const runtimeKey = deriveWorkspaceSearchMigrationRehearsalKeys(
      masterKey,
    ).runtimeKey
    const cases = [
      { integrityKey: masterKey, auditKey: new Uint8Array(32).fill(31) },
      { integrityKey: new Uint8Array(32).fill(32), auditKey: masterKey },
      { integrityKey: runtimeKey, auditKey: new Uint8Array(32).fill(33) },
      { integrityKey: new Uint8Array(32).fill(34), auditKey: runtimeKey },
      {
        integrityKey: new Uint8Array(32).fill(35),
        auditKey: new Uint8Array(32).fill(35),
      },
    ]
    for (const testCase of cases) {
      const harness = createHarness('verified', {
        masterKey,
        integrityKey: testCase.integrityKey,
        auditKey: testCase.auditKey,
      })
      const exitCode =
        await runWorkspaceSearchMigrationRehearsalReconciliationCli(
          createVerifiedArguments(),
          harness.dependencies,
        )
      expect(exitCode).toBe(1)
      expect(harness.events).toEqual(['ensure-output'])
      expect(harness.returnedBuffers.length).toBeGreaterThan(0)
      expect(harness.returnedBuffers.every(isZeroized)).toBe(true)
    }
    runtimeKey.fill(0)
  })

  test('runs config6, live12, collection, finalize-before-seal, verify, and v3 finalization in order', async () => {
    const harness = createHarness('verified')
    const exitCode =
      await runWorkspaceSearchMigrationRehearsalReconciliationCli(
        createVerifiedArguments(),
        harness.dependencies,
      )

    expect(exitCode).toBe(0)
    expect(harness.events).toEqual([
      'ensure-output',
      'verify-permit',
      'authenticate-context',
      'create-rate-runtime',
      'create-live-session',
      'read-claimed-head',
      'measure-config6',
      'run-live12',
      'collect-reconciliation',
      'runtime-flush',
      'read-rate-predecessor',
      'read-rate-current',
      'finalize-live',
      'seal-session',
      'runtime-flush',
      'close-session',
      'close-runtime',
      'read-rate-predecessor',
      'read-rate-current',
      'verify-rate',
      'complete-reconciliation',
      'finalize-reconciliation',
      'write-output',
    ])
    expect(harness.completeInputs).toHaveLength(1)
    expect(harness.completeInputs[0]?.collectedBase).toBe(
      harness.collectedBase,
    )
    expect(harness.completeInputs[0]?.verifiedIntegrity).toBe(
      harness.rateBoundIntegrity,
    )
    expect(harness.finalizeInputs[0]?.verifiedIntegrity).toBe(
      harness.rateBoundIntegrity,
    )
    expect(harness.disposedPendings).toHaveLength(0)
    expect(harness.transferredSecrets.every(isZeroized)).toBe(true)
    expect(harness.returnedBuffers.every(isZeroized)).toBe(true)
    expect(harness.stderr).toEqual([])
    expect(harness.stdout).toHaveLength(1)
  })

  test('disposes the exact live pending when collection fails before a flush', async () => {
    const harness = createHarness('verified', { collectorFailure: true })
    const exitCode =
      await runWorkspaceSearchMigrationRehearsalReconciliationCli(
        createVerifiedArguments(),
        harness.dependencies,
      )

    expect(exitCode).toBe(1)
    expect(harness.disposedPendings).toEqual([harness.returnedPending])
    expect(harness.events).toContain('dispose-live')
    expect(harness.events).not.toContain('runtime-flush')
    expect(harness.events.indexOf('dispose-live')).toBeLessThan(
      harness.events.indexOf('close-session'),
    )
    expect(harness.transferredSecrets.every(isZeroized)).toBe(true)
    expect(harness.returnedBuffers.every(isZeroized)).toBe(true)
  })

  test('burns foreign or failed finalization handles and never seals afterward', async () => {
    for (const options of [
      { foreignPending: true },
      { finalizationFailure: true },
    ]) {
      const harness = createHarness('verified', options)
      const exitCode =
        await runWorkspaceSearchMigrationRehearsalReconciliationCli(
          createVerifiedArguments(),
          harness.dependencies,
        )
      expect(exitCode).toBe(1)
      expect(harness.events).toContain('finalize-live')
      expect(harness.disposedPendings).toEqual([harness.returnedPending])
      expect(harness.events).not.toContain('seal-session')
      expect(harness.events).not.toContain('verify-rate')
      expect(harness.returnedBuffers.every(isZeroized)).toBe(true)
    }
  })

  test('rejects flush metadata that disagrees with either raw bytes or the final flush', async () => {
    for (const options of [
      { everyFlushMutation: 'first-event-sequence' },
      { finalFlushMutation: 'authentication-key-fingerprint' },
    ] satisfies readonly HarnessOptions[]) {
      const harness = createHarness('verified', options)
      const exitCode =
        await runWorkspaceSearchMigrationRehearsalReconciliationCli(
          createVerifiedArguments(),
          harness.dependencies,
        )
      expect(exitCode).toBe(1)
      expect(harness.events).not.toContain('complete-reconciliation')
      expect(harness.events).not.toContain('write-output')
      expect(harness.returnedBuffers.every(isZeroized)).toBe(true)
    }
  })

  test('rollback uses only the generic claimed session and completes from target v4 pair with null live authority', async () => {
    const harness = createHarness('rollback')
    const exitCode =
      await runWorkspaceSearchMigrationRehearsalReconciliationCli(
        createRollbackArguments(),
        harness.dependencies,
      )

    expect(exitCode).toBe(0)
    expect(harness.events).toContain('create-rollback-session')
    expect(harness.events).not.toContain('create-live-session')
    expect(harness.events).not.toContain('run-live12')
    expect(harness.events).not.toContain('finalize-live')
    expect(harness.events).not.toContain('dispose-live')
    expect(harness.completeInputs[0]?.verifiedIntegrity).toBeNull()
    expect(harness.finalizeInputs[0]?.verifiedIntegrity).toBeNull()
    expect(harness.rollbackVerificationKeys).toHaveLength(2)
    expect(harness.rollbackVerificationKeys.every(isZeroized)).toBe(true)
    expect(harness.returnedBuffers.every(isZeroized)).toBe(true)
    expect(harness.events.indexOf('collect-reconciliation')).toBeLessThan(
      harness.events.indexOf('runtime-flush'),
    )
  })
})

/** Harness scenario selecting a fresh live result or authenticated target pair. */
type HarnessProfile = 'rollback' | 'verified'

/** Deliberate committed-segment metadata corruption used by fail-closed tests. */
type HarnessCommittedSegmentMutation =
  | 'authentication-key-fingerprint'
  | 'first-event-sequence'

/** Optional failure and key controls for one focused invocation harness. */
type HarnessOptions = {
  /** Raw master key returned by the private reader. */
  readonly masterKey?: Uint8Array
  /** Raw dedicated integrity key returned by the private reader. */
  readonly integrityKey?: Uint8Array
  /** Raw dedicated audit key returned by the private reader. */
  readonly auditKey?: Uint8Array
  /** Makes terminal collection reject after a live pending exists. */
  readonly collectorFailure?: boolean
  /** Makes the dedicated finalizer reject its otherwise genuine handle. */
  readonly finalizationFailure?: boolean
  /** Returns a handle that the fake finalizer treats as foreign. */
  readonly foreignPending?: boolean
  /** Corrupts metadata on both explicit runtime flushes. */
  readonly everyFlushMutation?: HarnessCommittedSegmentMutation
  /** Corrupts metadata only on the post-seal runtime flush. */
  readonly finalFlushMutation?: HarnessCommittedSegmentMutation
}

/** Complete observable AWS-free execution harness. */
type ReconciliationCliHarness = {
  /** Strict injected CLI dependencies. */
  readonly dependencies:
    WorkspaceSearchMigrationRehearsalReconciliationCliDependencies
  /** Ordered security-boundary observations. */
  readonly events: string[]
  /** Every detached restricted reader result owned by the CLI. */
  readonly returnedBuffers: Uint8Array[]
  /** Every invocation-owned secret transferred across a dependency boundary. */
  readonly transferredSecrets: Uint8Array[]
  /** Stderr lines emitted by the CLI. */
  readonly stderr: string[]
  /** Stdout lines emitted by the CLI. */
  readonly stdout: string[]
  /** Exact opaque collected base returned by the fake session. */
  readonly collectedBase:
    WorkspaceSearchMigrationRehearsalCollectedReconciliationBase
  /** Exact pending returned by the fake live session. */
  readonly returnedPending:
    WorkspaceSearchMigrationRehearsalIntegrityAwsPending
  /** Exact completed live authority returned by the dedicated finalizer. */
  readonly rateBoundIntegrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
  /** Handles explicitly disposed by the CLI. */
  readonly disposedPendings:
    WorkspaceSearchMigrationRehearsalIntegrityAwsPending[]
  /** Post-seal completion inputs. */
  readonly completeInputs:
    CompleteWorkspaceSearchMigrationRehearsalReconciliationInput[]
  /** Reconciliation artifact finalizer inputs. */
  readonly finalizeInputs:
    FinalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput[]
  /** Rollback target-pair verification keys transferred to the collector. */
  readonly rollbackVerificationKeys: Uint8Array[]
}

/** Creates one complete fake live or rollback execution boundary. */
function createHarness(
  profile: HarnessProfile,
  options: HarnessOptions = {},
): ReconciliationCliHarness {
  const events: string[] = []
  const returnedBuffers: Uint8Array[] = []
  const transferredSecrets: Uint8Array[] = []
  const stderr: string[] = []
  const stdout: string[] = []
  const disposedPendings:
    WorkspaceSearchMigrationRehearsalIntegrityAwsPending[] = []
  const completeInputs:
    CompleteWorkspaceSearchMigrationRehearsalReconciliationInput[] = []
  const finalizeInputs:
    FinalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput[] =
    []
  const rollbackVerificationKeys: Uint8Array[] = []
  const masterKey = options.masterKey?.slice() ?? new Uint8Array(32).fill(11)
  const integrityKey = options.integrityKey?.slice() ??
    new Uint8Array(32).fill(21)
  const auditKey = options.auditKey?.slice() ?? new Uint8Array(32).fill(31)
  const derived = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
  const policy = parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
    ratePolicyBytes,
  )
  const measuredConfiguration = createMeasuredConfiguration()
  const configurationBindingDigest =
    createWorkspaceSearchConfigurationHash(measuredConfiguration)
  const fixture = createAuthenticatedCollectionFixture(
    profile,
    configurationBindingDigest,
    policy.policyVersion,
    derived.runtimeKeyDigest,
    derived.publicationKeyDigest,
  )
  const committedBytes = encodeCanonical({ kind: 'current-rate-segment' })
  const predecessorBytes = encodeCanonical({ kind: 'previous-rate-segment' })
  const committedTemplate = createCommittedRateSegment(
    committedBytes,
    derived.runtimeKey,
  )
  const successorProof = createVerifiedRateSuccessor(
    committedTemplate,
    policy.policyVersion,
    configurationBindingDigest,
  )
  const durableEvidence = createDurableRateEvidence(policy.policyVersion)
  const rateBoundIntegrity = createRateBoundIntegrityResult(
    successorProof,
    configurationBindingDigest,
    policy.policyVersion,
    'verified-live',
  )
  const collectorResult = createCollectorResult(
    profile,
    configurationBindingDigest,
    policy.policyVersion,
    rateBoundIntegrity,
    successorProof,
    durableEvidence,
  )
  const sourceFiles = createInputFiles(
    profile,
    masterKey,
    integrityKey,
    auditKey,
    predecessorBytes,
    committedBytes,
  )
  const acceptedPending:
    WorkspaceSearchMigrationRehearsalIntegrityAwsPending = Object.freeze({})
  const foreignPending:
    WorkspaceSearchMigrationRehearsalIntegrityAwsPending = Object.freeze({})
  const returnedPending = options.foreignPending === true
    ? foreignPending
    : acceptedPending
  const collectedBase:
    WorkspaceSearchMigrationRehearsalCollectedReconciliationBase =
    Object.freeze({})
  let clockIndex = 0
  const clockSamples = [
    '2026-08-02T00:01:00.000Z',
    '2026-08-02T00:01:00.001Z',
    '2026-08-02T00:09:30.000Z',
    '2026-08-02T00:09:45.000Z',
  ]
  const clock = (): Date => {
    const sample = clockSamples[clockIndex] ?? '2026-08-02T00:09:45.000Z'
    clockIndex += 1
    return new Date(sample)
  }
  let monotonicSample = 1_000
  let runtimeFlushCount = 0
  const monotonicClock = (): number => {
    monotonicSample += 1
    return monotonicSample
  }

  const liveSession: WorkspaceSearchMigrationRehearsalIntegrityAwsSession =
    Object.freeze({
      close: async (): Promise<void> => {
        events.push('close-session')
      },
      measureConfiguration: async () => {
        events.push('measure-config6')
        return measuredConfiguration
      },
      scanTargetPage: async () => {
        throw new Error('unexpected-target-page')
      },
      readRequestedResourcesBinding: () => {
        throw new Error('unexpected-resource-binding-read')
      },
      readRehearsalEvidenceSessionBinding: () => {
        throw new Error('unexpected-evidence-session-binding-read')
      },
      readRehearsalClaimedStageHead: () => {
        events.push('read-claimed-head')
        return fixture.claimedHead
      },
      collectRehearsalReconciliation: async (
        input:
          CollectWorkspaceSearchMigrationRehearsalReconciliationSessionInput,
      ) => {
        events.push('collect-reconciliation')
        input.clock()
        if (input.rollbackTarget !== undefined) {
          rollbackVerificationKeys.push(
            input.rollbackTarget.runtimeVerificationKey,
            input.rollbackTarget.publicationVerificationKey,
          )
        }
        if (options.collectorFailure === true) {
          throw new Error('collector-failure')
        }
        return collectedBase
      },
      interruptDescribeTableRate: (): void => {
        events.push('interrupt-rate')
      },
      sealAndReadDescribeTableRateEvidence: async () => {
        events.push('seal-session')
        return durableEvidence
      },
      readDescribeTableRateEvidence: () => durableEvidence,
      runRehearsalIntegrityLiveSession: async (
        input: RunAwsWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
      ) => {
        events.push('run-live12')
        transferredSecrets.push(input.auditPseudonymKey)
        return returnedPending
      },
      finalizeRehearsalIntegrityLiveSession: (
        input:
          FinalizeAwsWorkspaceSearchMigrationRehearsalIntegritySessionInput,
      ) => {
        events.push('finalize-live')
        transferredSecrets.push(input.rateAuthenticationKey)
        if (
          options.finalizationFailure === true ||
          input.pending !== acceptedPending ||
          !sameBytes(input.canonicalSegmentBytes, committedBytes) ||
          !sameBytes(input.predecessorSegmentBytes, predecessorBytes)
        ) throw new Error('live-finalization-failure')
        return rateBoundIntegrity
      },
      disposeRehearsalIntegrityLiveSession: (
        pending: WorkspaceSearchMigrationRehearsalIntegrityAwsPending,
      ): void => {
        events.push('dispose-live')
        disposedPendings.push(pending)
      },
    })

  const rollbackSession: WorkspaceSearchMigrationRehearsalReconciliationCliSession =
    Object.freeze({
      close: async (): Promise<void> => {
        events.push('close-session')
      },
      measureConfiguration: async () => {
        events.push('measure-config6')
        return measuredConfiguration
      },
      scanTargetPage: async () => {
        throw new Error('unexpected-target-page')
      },
      readRequestedResourcesBinding: () => {
        throw new Error('unexpected-resource-binding-read')
      },
      readRehearsalEvidenceSessionBinding: () => {
        throw new Error('unexpected-evidence-session-binding-read')
      },
      readRehearsalClaimedStageHead: () => {
        events.push('read-claimed-head')
        return fixture.claimedHead
      },
      collectRehearsalReconciliation: async (input) => {
        events.push('collect-reconciliation')
        input.clock()
        const rollbackTarget = input.rollbackTarget
        if (rollbackTarget === undefined) {
          throw new Error('missing-rollback-target')
        }
        rollbackVerificationKeys.push(
          rollbackTarget.runtimeVerificationKey,
          rollbackTarget.publicationVerificationKey,
        )
        return collectedBase
      },
      interruptDescribeTableRate: (): void => {
        events.push('interrupt-rate')
      },
      sealAndReadDescribeTableRateEvidence: async () => {
        events.push('seal-session')
        return durableEvidence
      },
    })

  const dependencies:
    WorkspaceSearchMigrationRehearsalReconciliationCliDependencies =
    Object.freeze({
      readRestrictedFile: async (path) => {
        const source = sourceFiles.get(path)
        if (source === undefined) throw new Error('missing-test-file')
        if (path === '/restricted/rate-before.ndjson') {
          events.push('read-rate-predecessor')
        } else if (path === '/restricted/rate-current.ndjson') {
          events.push('read-rate-current')
        }
        const bytes = source.slice()
        returnedBuffers.push(bytes)
        return bytes
      },
      authenticateCollectionContext: (input) => {
        events.push('authenticate-context')
        transferredSecrets.push(
          input.runtimeVerificationKey,
          input.publicationVerificationKey,
        )
        return fixture.authentication
      },
      verifyPermit: (input) => {
        events.push('verify-permit')
        transferredSecrets.push(input.verificationKey)
        return Object.freeze({
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
          permitVersion:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
          stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
          approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
          account: input.account,
          productionAccount: '210987654321',
          region: input.region,
          callerArn:
            'arn:aws:sts::123456789012:assumed-role/rehearsal/operator',
          commit: input.commit,
          deploymentTargetId: 'test-rehearsal',
          deploymentTrustRootDigest: digest('deployment-trust-root'),
          requestedResourcesBinding: input.requestedResourcesBinding,
          configurationBindingDigest,
          policyVersion: policy.policyVersion,
          integrityResourceIdentityScheme:
            CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
          integrityResourceIdentities,
          integrityResourceIdentityDigest,
          evidenceKeyDigest: derived.runtimeKeyDigest,
          publicationKeyDigest: derived.publicationKeyDigest,
          integrityAttestationRoot:
            createIntegrityAttestationRootProjection(
              configurationBindingDigest,
              policy.policyVersion,
            ),
          issuedAt: '2026-08-02T00:00:00.000Z',
          expiresAt: '2026-08-02T01:00:00.000Z',
        })
      },
      createRateRuntime: async (input) => {
        events.push('create-rate-runtime')
        transferredSecrets.push(input.authenticationKey)
        return Object.freeze({
          recorder: Object.freeze({
            record: () => undefined,
            appendForfeitedAttempt: () => Promise.resolve(),
            appendForfeitedReservation: () => Promise.resolve(),
            flush: () => Promise.resolve(
              cloneCommittedRateSegment(committedTemplate),
            ),
            close: () => Promise.resolve(),
          }),
          flush: async () => {
            events.push('runtime-flush')
            runtimeFlushCount += 1
            return cloneCommittedRateSegment(
              committedTemplate,
              runtimeFlushCount === 2
                ? options.finalFlushMutation ?? options.everyFlushMutation
                : options.everyFlushMutation,
            )
          },
          close: async (): Promise<void> => {
            events.push('close-runtime')
          },
        })
      },
      createSession: async (input) => {
        events.push('create-live-session')
        transferredSecrets.push(
          input.permitVerificationKey,
          input.stageReservationClaim.stageKey,
          input.resourceAttestationBytes,
          input.integrityDigestKey,
        )
        return liveSession
      },
      createRollbackSession: async (input) => {
        events.push('create-rollback-session')
        transferredSecrets.push(
          input.permitVerificationKey,
          input.stageReservationClaim?.stageKey ??
            new Uint8Array(32).fill(255),
        )
        return rollbackSession
      },
      completeReconciliationCollection: async (input) => {
        events.push('complete-reconciliation')
        completeInputs.push(input)
        if (input.collectedBase !== collectedBase) {
          throw new Error('foreign-collected-base')
        }
        if (
          profile === 'verified'
            ? input.verifiedIntegrity !== rateBoundIntegrity
            : input.verifiedIntegrity !== null
        ) throw new Error('wrong-live-authority')
        return collectorResult
      },
      verifyRateSegmentSuccessor: (input) => {
        events.push('verify-rate')
        transferredSecrets.push(input.authenticationKey)
        if (
          !sameBytes(input.predecessorSegmentBytes, predecessorBytes) ||
          !sameBytes(input.successorSegmentBytes, committedBytes)
        ) throw new Error('wrong-rate-bytes')
        return successorProof
      },
      collectTargetAudit: async () => {
        throw new Error('unexpected-target-audit')
      },
      finalizeTargetAudit: () => {
        throw new Error('unexpected-target-finalizer')
      },
      finalizeReconciliation: (
        input,
        runtimeSigningKey,
        publicationSigningKey,
      ) => {
        events.push('finalize-reconciliation')
        finalizeInputs.push(input)
        transferredSecrets.push(runtimeSigningKey, publicationSigningKey)
        return createFinalizedReconciliationArtifact(input)
      },
      ensureOutputAbsent: async (): Promise<void> => {
        events.push('ensure-output')
      },
      writeOutputExclusive: async (): Promise<'created'> => {
        events.push('write-output')
        return 'created'
      },
      clock,
      monotonicClock,
      writeStdoutLine: (line): void => {
        stdout.push(line)
      },
      writeStderrLine: (line): void => {
        stderr.push(line)
      },
    })
  derived.runtimeKey.fill(0)
  derived.publicationKey.fill(0)
  masterKey.fill(0)
  integrityKey.fill(0)
  auditKey.fill(0)
  return Object.freeze({
    dependencies,
    events,
    returnedBuffers,
    transferredSecrets,
    stderr,
    stdout,
    collectedBase,
    returnedPending,
    rateBoundIntegrity,
    disposedPendings,
    completeInputs,
    finalizeInputs,
    rollbackVerificationKeys,
  })
}

/** Authenticated collection fixture plus its exact remote claimed head. */
type AuthenticatedCollectionFixture = {
  /** Parent-authenticated context and stage claim. */
  readonly authentication:
    WorkspaceSearchMigrationRehearsalAuthenticatedCollection
  /** Exact active head returned by the idempotent strong claim read. */
  readonly claimedHead: WorkspaceSearchMigrationRehearsalStageHead
}

/** Creates mutually bound context, reservation, selection, and claimed head. */
function createAuthenticatedCollectionFixture(
  profile: HarnessProfile,
  configurationBindingDigest: string,
  policyVersion: string,
  runtimeKeyDigest: string,
  publicationKeyDigest: string,
): AuthenticatedCollectionFixture {
  const permitDigest = createMigrationDigest({ kind: 'permit' })
  const manifestDigest = digest('manifest')
  const previousStageReceiptDigest = digest('previous-stage-receipt')
  const scenario = profile === 'verified'
    ? 'happy-path-verified'
    : 'partial-apply-rollback'
  const command = profile === 'verified' ? 'verify' : 'rollback-partial'
  const entry = Object.freeze({
    ordinal: 2,
    scenario,
    scenarioStageOrdinal: 2,
    command,
    controlArgumentsDigest: digest('control-arguments'),
    attemptOrdinal: 1,
    faultPlanDigest: null,
    expectedOutcome: 'completed',
  })
  const manifest = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
    manifestVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    commit: 'a'.repeat(40),
    deploymentTrustRootDigest: digest('deployment-trust-root'),
    permitDigest,
    evidenceKeyDigest: runtimeKeyDigest,
    publicationKeyDigest,
    requestedResourcesBinding: digest('requested-resources-placeholder'),
    integrityResourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    integrityResourceIdentities,
    integrityResourceIdentityDigest,
    configurationBindingDigest,
    policyVersion,
    integrityAttestationRoot:
      createIntegrityAttestationRootProjection(
        configurationBindingDigest,
        policyVersion,
      ),
    reviewedAt: '2026-08-02T00:00:00.000Z',
    entries: Object.freeze([entry]),
    manifestMac: digest('manifest-mac'),
  })
  const requestedResourcesBinding =
    createRequestedResourcesBindingForFixture()
  const boundManifest = Object.freeze({
    ...manifest,
    requestedResourcesBinding,
  })
  const selection = Object.freeze({
    manifest: boundManifest,
    manifestDigest,
    entry,
    previousStageReceiptDigest,
  })
  const reservation = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_KIND,
    reservationVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_VERSION,
    manifestDigest,
    manifestEntryDigest: createMigrationDigest(entry),
    previousStageReceiptDigest,
    expectedPreviousRateSegment: Object.freeze({
      authenticationKeyFingerprint: digest('claim-rate-fingerprint'),
      segmentLocatorDigest: digest('claim-rate-predecessor-locator'),
      segmentOrdinal: 1,
      firstEventSequence: 25,
      eventCount: 0,
      firstCommittedEventSequence: null,
      lastCommittedEventSequence: null,
      terminalRecordMac: digest('claim-rate-predecessor-mac'),
      segmentDigest: digest('claim-rate-predecessor-segment'),
    }),
    expectedCurrentRateSegmentOrdinal: 2,
    expectedTargetPreimageArtifactContentDigest: null,
    stageOrdinal: entry.ordinal,
    scenario: entry.scenario,
    scenarioStageOrdinal: entry.scenarioStageOrdinal,
    command: entry.command,
    attemptOrdinal: entry.attemptOrdinal,
    expectedOutcome: entry.expectedOutcome,
    controlArgumentsDigest: entry.controlArgumentsDigest,
    permitDigest,
    evidenceKeyDigest: runtimeKeyDigest,
    publicationKeyDigest,
    parentLivenessProtocol:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
    commit: boundManifest.commit,
    requestedResourcesBinding,
    configurationBindingDigest,
    policyVersion,
    nonceDigest: digest('reservation-nonce'),
    reservedAt: '2026-08-02T00:00:00.000Z',
    expiresAt: '2026-08-02T00:20:00.000Z',
    reservationMac: digest('reservation-mac'),
  })
  const terminal = profile === 'rollback'
    ? Object.freeze({
      scenario: 'partial-apply-rollback',
      kind: 'rolled-back',
      version: 2,
      rootDigest: digest('partial-rollback-root'),
      applyStartedAt: '2026-08-02T00:02:00.000Z',
      terminalAt: '2026-08-02T00:05:00.000Z',
    } satisfies NonNullable<
      WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext[
        'terminal'
      ]
    >)
    : null
  const context = Object.freeze({
    runId: 'run-secret-canary',
    runLocatorDigest: digest('run-locator'),
    scenario: entry.scenario,
    command: entry.command,
    permitDigest,
    requestedResourcesBinding,
    configurationBindingDigest,
    policyVersion,
    integrityResourceIdentityDigest,
    manifestDigest,
    planningReceiptDigest: digest('planning-receipt'),
    executionBoundaryDigest: digest('execution-boundary'),
    sealedPlanningAuthorityDigest: digest('sealed-planning-authority'),
    planDigest: digest('plan'),
    writerFenceDigest: digest('writer-fence'),
    expectedAuthorities: Object.freeze([]),
    integrityWindow: Object.freeze({
      startedAt: '2026-08-02T00:00:00.000Z',
      completedAt: reservation.expiresAt,
    }),
    terminal,
  })
  const claimedHead = Object.freeze({
    manifestDigest,
    completedStageOrdinal: entry.ordinal - 1,
    headReceiptDigest: previousStageReceiptDigest,
    activeReservationDigest: createMigrationDigest(reservation),
    activeStageOrdinal: entry.ordinal,
    activeExpiresAt: reservation.expiresAt,
    abandonmentCount: 0,
    abandonmentRootDigest: digest('abandonment-root'),
    revision: 3,
  })
  return Object.freeze({
    authentication: Object.freeze({
      context,
      stageClaim: Object.freeze({ reservation, selection }),
    }),
    claimedHead,
  })
}

/** Creates one finalizer-ready verified or rollback collector result. */
function createCollectorResult(
  profile: HarnessProfile,
  configurationBindingDigest: string,
  policyVersion: string,
  integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  successor: WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor,
  aggregate: WorkspaceSearchMigrationDescribeTableRateEvidence,
): WorkspaceSearchMigrationRehearsalReconciliationCollectorResult {
  const commonContext = {
    scenario: profile === 'verified'
      ? 'happy-path-verified'
      : 'partial-apply-rollback',
    runLocatorDigest: digest('run-locator'),
    configurationBindingDigest,
    policyVersion,
    integrityResourceIdentityDigest,
    sealedPlanningAuthorityDigest: digest('sealed-planning-authority'),
    executionRunDigest: digest('execution-run'),
    planDigest: digest('plan'),
    applyBoundaryDigest: digest('apply-boundary'),
    terminalRootKind: profile === 'verified'
      ? 'verified'
      : 'rolled-back',
    terminalRootVersion: profile === 'verified' ? 1 : 2,
    terminalRootDigest: profile === 'verified'
      ? digest('verified-root')
      : digest('partial-rollback-root'),
    sealedPlanOperationCount: 1,
    appliedOperationCount: 1,
    terminalAt: '2026-08-02T00:05:00.000Z',
    checkedAt: '2026-08-02T00:09:30.000Z',
  } satisfies WorkspaceSearchMigrationRehearsalReconciliationCollectorResult[
    'context'
  ]
  const markerSummary = Object.freeze({
    expectedCount: 1,
    expectedAggregateDigest: digest('marker-aggregate'),
    observedCount: 1,
    observedAggregateDigest: digest('marker-aggregate'),
    matchedCount: 1,
    duplicateCount: 0,
    missingCount: 0,
    unexpectedCount: 0,
  })
  const authoritySummary = Object.freeze({
    expectedChainDigest: digest('authority-chain'),
    observedChainDigest: digest('authority-chain'),
    expectedCount: 0,
    observedCount: 0,
    matchedCount: 0,
    missingCount: 0,
    orphanCount: 0,
  })
  const sourceTargetSummary = Object.freeze({
    expectedAggregateDigest: digest('target-aggregate'),
    observedAggregateDigest: digest('target-aggregate'),
    expectedCount: 0,
    observedCount: 0,
    matchedCount: 0,
    lostCount: 0,
    unexpectedCount: 0,
  })
  if (profile === 'verified') {
    return Object.freeze({
      context: Object.freeze(commonContext),
      integrity: Object.freeze({
        kind: 'verified-result',
        status: 'pass',
        failureCount: 0,
        completedAt: commonContext.checkedAt,
        result: integrity.result,
        terminalRootDigest: commonContext.terminalRootDigest,
        integrityAggregateDigest:
          integrity.result.integrityAggregateDigest,
      }),
      targetAudits: null,
      markerSummary,
      authoritySummary,
      sourceTargetSummary,
    })
  }
  const beforeIntegrity = createRateBoundIntegrityResult(
    successor,
    configurationBindingDigest,
    policyVersion,
    'rollback-before',
  )
  const afterIntegrity = createRateBoundIntegrityResult(
    successor,
    configurationBindingDigest,
    policyVersion,
    'rollback-after',
  )
  const terminal = Object.freeze({
    scenario: 'partial-apply-rollback',
    kind: 'rolled-back',
    version: 2,
    rootDigest: commonContext.terminalRootDigest,
    applyStartedAt: '2026-08-02T00:02:00.000Z',
    terminalAt: commonContext.terminalAt,
  } satisfies NonNullable<
    WorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext[
      'terminal'
    ]
  >)
  const targetContext = Object.freeze({
    scenario: 'partial-apply-rollback',
    runLocatorDigest: commonContext.runLocatorDigest,
    manifestDigest: digest('manifest'),
    permitDigest: createMigrationDigest({ kind: 'permit' }),
    requestedResourcesBinding: createRequestedResourcesBindingForFixture(),
    configurationBindingDigest,
    policyVersion,
    integrityResourceIdentityDigest,
    planningReceiptDigest: digest('planning-receipt'),
    executionBoundaryDigest: digest('execution-boundary'),
    sealedPlanningAuthorityDigest:
      commonContext.sealedPlanningAuthorityDigest,
    planDigest: commonContext.planDigest,
    writerFenceDigest: digest('writer-fence'),
  } satisfies WorkspaceSearchMigrationRehearsalTargetAuditContext)
  const rate = createRateSegmentEvidence(successor, aggregate)
  const targetAudits = Object.freeze({
    preimage: Object.freeze({
      purpose: 'partial-rollback-preimage',
      startedAt: '2026-08-02T00:00:20.000Z',
      contentDigest: digest('target-preimage-content'),
      byteLength: 256,
      observedAt: '2026-08-02T00:01:00.000Z',
      observationDigest: digest('target-preimage-observation'),
      aggregateDigest: digest('target-aggregate'),
      contextDigest: createMigrationDigest(targetContext),
      context: targetContext,
      terminal: null,
      integrity: beforeIntegrity,
      rate,
    } satisfies NonNullable<
      WorkspaceSearchMigrationRehearsalReconciliationCollectorResult[
        'targetAudits'
      ]
    >['preimage']),
    restored: Object.freeze({
      purpose: 'partial-rollback-restored',
      startedAt: '2026-08-02T00:05:10.000Z',
      contentDigest: digest('target-restored-content'),
      byteLength: 256,
      observedAt: '2026-08-02T00:06:00.000Z',
      observationDigest: digest('target-restored-observation'),
      aggregateDigest: digest('target-aggregate'),
      contextDigest: createMigrationDigest(targetContext),
      context: targetContext,
      terminal,
      integrity: afterIntegrity,
      rate,
    } satisfies NonNullable<
      WorkspaceSearchMigrationRehearsalReconciliationCollectorResult[
        'targetAudits'
      ]
    >['restored']),
  })
  return Object.freeze({
    context: Object.freeze(commonContext),
    integrity: Object.freeze({
      kind: 'rollback-comparison',
      purpose: 'partial-rollback',
      status: 'pass',
      failureCount: 0,
      startedAt: '2026-08-02T00:00:30.000Z',
      applyStartedAt: terminal.applyStartedAt,
      terminalAt: terminal.terminalAt,
      completedAt: '2026-08-02T00:06:00.000Z',
      before: beforeIntegrity.result,
      after: afterIntegrity.result,
      comparisonDigest: digest('rollback-comparison'),
      comparisonContextDigest: digest('rollback-comparison-context'),
      terminalRootDigest: terminal.rootDigest,
      targetPreimageAggregateDigest: digest('target-aggregate'),
      targetRestoredAggregateDigest: digest('target-aggregate'),
      targetPreimageStatus: 'equal',
    }),
    targetAudits,
    markerSummary,
    authoritySummary,
    sourceTargetSummary,
  })
}

/** Creates a structural same-process live authority for dependency tests. */
function createRateBoundIntegrityResult(
  successor: WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor,
  configurationBindingDigest: string,
  policyVersion: string,
  label: string,
): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
  const startedAt = label === 'rollback-before'
    ? '2026-08-02T00:00:30.000Z'
    : label === 'rollback-after'
    ? '2026-08-02T00:05:10.000Z'
    : '2026-08-02T00:05:10.000Z'
  const checkedAt = label === 'rollback-before'
    ? '2026-08-02T00:01:00.000Z'
    : '2026-08-02T00:06:00.000Z'
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result',
    version: 1,
    result: Object.freeze({
      checkedAt,
      contentDigest: digest(`integrity-content:${label}`),
      byteLength: 512,
      resultDigest: digest(`integrity-result:${label}`),
      resultMac: digest(`integrity-mac:${label}`),
      runtimeProvenance: Object.freeze({
        kind:
          'mukuroji-cross-domain-integrity-rehearsal-live-provenance',
        version: 1,
        mode: 'migration-rehearsal-live',
        startedAt,
        completedAt: checkedAt,
        checkedAtSource: 'trusted-wall-clock-after-external-reads',
      }),
      resourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      resourceIdentities: integrityResourceIdentities,
      integrityAggregateDigest: digest('target-aggregate'),
      resourceIdentityDigest: integrityResourceIdentityDigest,
    }),
    predecessor: successor.predecessor,
    segment: successor.successor,
    interval: Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 2,
      describeTableCallCount: 12,
      firstAttemptSequence: 7,
      lastAttemptSequence: 18,
      attemptSequences: Object.freeze(
        Array.from({ length: 12 }, (_value, index) => index + 7),
      ),
      firstEventSequence: 13,
      lastEventSequence: 36,
      eventSequences: Object.freeze(
        Array.from({ length: 24 }, (_value, index) => index + 13),
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt,
      completedAt: checkedAt,
    }),
    policyVersion,
    configurationBindingDigest,
    tableOrderBindingMac: digest(`table-order:${label}`),
    bindingMac: digest(`binding:${label}`),
  })
}

/** Creates a strict finalized artifact without exercising the audited codec. */
function createFinalizedReconciliationArtifact(
  input: FinalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput,
): WorkspaceSearchMigrationRehearsalFinalizedReconciliationAuditArtifact {
  const collector = input.collectorResult
  const integrity = collector.integrity.kind === 'verified-result'
    ? Object.freeze({
      ...collector.integrity,
      result: input.verifiedIntegrity ?? failMissingVerifiedIntegrity(),
      resultContextDigest: digest('result-context'),
      migrationContextDigest: digest('migration-context'),
    })
    : Object.freeze({
      ...collector.integrity,
      migrationContextDigest: digest('migration-context'),
    })
  const canonicalBytes = encodeCanonical({ kind: 'reconciliation-artifact' })
  return Object.freeze({
    canonicalBytes,
    byteLength: canonicalBytes.byteLength,
    contentDigest: digest('reconciliation-artifact'),
    context: Object.freeze({
      ...collector.context,
      integrity,
      targetAudits: collector.targetAudits,
    }),
  })
}

/** Fails a malformed verified artifact fixture without using an assertion. */
function failMissingVerifiedIntegrity(): never {
  throw new Error('missing-verified-integrity')
}

/** Creates one exact committed current rate segment. */
function createCommittedRateSegment(
  canonicalBytes: Uint8Array,
  runtimeKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalRateCommittedSegment {
  return Object.freeze({
    authenticationKeyFingerprint:
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        runtimeKey,
      ),
    segmentLocatorDigest: digest('current-segment-locator'),
    segmentOrdinal: 2,
    firstEventSequence: 25,
    eventCount: 36,
    firstCommittedEventSequence: 25,
    lastCommittedEventSequence: 60,
    terminalRecordMac: digest('current-terminal-record'),
    segmentDigest: digest('current-segment'),
    canonicalBytes: canonicalBytes.slice(),
  })
}

/** Clones one committed segment without retaining its runtime signing key. */
function cloneCommittedRateSegment(
  committed: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  mutation?: HarnessCommittedSegmentMutation,
): WorkspaceSearchMigrationRehearsalRateCommittedSegment {
  return Object.freeze({
    authenticationKeyFingerprint:
      mutation === 'authentication-key-fingerprint'
        ? digest('mutated-authentication-key-fingerprint')
        : committed.authenticationKeyFingerprint,
    segmentLocatorDigest: committed.segmentLocatorDigest,
    segmentOrdinal: committed.segmentOrdinal,
    firstEventSequence: mutation === 'first-event-sequence'
      ? committed.firstEventSequence + 1
      : committed.firstEventSequence,
    eventCount: committed.eventCount,
    firstCommittedEventSequence: committed.firstCommittedEventSequence,
    lastCommittedEventSequence: committed.lastCommittedEventSequence,
    terminalRecordMac: committed.terminalRecordMac,
    segmentDigest: committed.segmentDigest,
    canonicalBytes: committed.canonicalBytes.slice(),
  })
}

/** Creates one exact authenticated predecessor/current successor proof. */
function createVerifiedRateSuccessor(
  committed: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  policyVersion: string,
  configurationBindingDigest: string,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor {
  const predecessor = Object.freeze({
    authenticationKeyFingerprint: committed.authenticationKeyFingerprint,
    segmentLocatorDigest: digest('previous-segment-locator'),
    segmentOrdinal: 1,
    firstEventSequence: 1,
    eventCount: 24,
    firstCommittedEventSequence: 1,
    lastCommittedEventSequence: 24,
    terminalRecordMac: digest('previous-terminal-record'),
    segmentDigest: digest('previous-segment'),
  })
  const successor = Object.freeze({
    authenticationKeyFingerprint: committed.authenticationKeyFingerprint,
    segmentLocatorDigest: committed.segmentLocatorDigest,
    segmentOrdinal: committed.segmentOrdinal,
    firstEventSequence: committed.firstEventSequence,
    eventCount: committed.eventCount,
    firstCommittedEventSequence: committed.firstCommittedEventSequence,
    lastCommittedEventSequence: committed.lastCommittedEventSequence,
    terminalRecordMac: committed.terminalRecordMac,
    segmentDigest: committed.segmentDigest,
  })
  return Object.freeze({
    authenticationKeyFingerprint: committed.authenticationKeyFingerprint,
    predecessor,
    successor,
    link: Object.freeze({
      previousSegmentDigest: predecessor.segmentDigest,
      previousRecordMac: predecessor.terminalRecordMac,
      firstEventSequence: successor.firstEventSequence,
      policyVersion,
      configurationBindingDigest,
    }),
  })
}

/** Creates one final durable DescribeTable aggregate. */
function createDurableRateEvidence(
  policyVersion: string,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  return Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion,
    attemptCount: 18,
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
  })
}

/** Creates embedded rate evidence for rollback target summaries. */
function createRateSegmentEvidence(
  successor: WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor,
  aggregate: WorkspaceSearchMigrationDescribeTableRateEvidence,
): WorkspaceSearchMigrationRehearsalRateSegmentEvidence {
  return Object.freeze({
    authenticationKeyFingerprint: successor.authenticationKeyFingerprint,
    predecessor: successor.predecessor,
    successor: successor.successor,
    link: successor.link,
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    completedAt: '2026-08-02T00:06:00.000Z',
  })
}

/** Creates exact restricted files for one live or rollback profile. */
function createInputFiles(
  profile: HarnessProfile,
  masterKey: Uint8Array,
  integrityKey: Uint8Array,
  auditKey: Uint8Array,
  predecessorBytes: Uint8Array,
  committedBytes: Uint8Array,
): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ['/restricted/manifest.json', encodeCanonical({ kind: 'manifest' })],
    ['/restricted/previous-receipt.json', encodeCanonical({ kind: 'receipt' })],
    ['/restricted/material.json', encodeCanonical({ kind: 'material' })],
    ['/restricted/lifecycle.json', encodeCanonical({ kind: 'lifecycle' })],
    [
      '/restricted/parent-authentication.json',
      encodeCanonical({ kind: 'parent-authentication' }),
    ],
    [
      '/restricted/control-arguments.json',
      encodeCanonical(['verify', '--run-id', 'run-secret-canary']),
    ],
    ['/restricted/permit.json', encodeCanonical({ kind: 'permit' })],
    ['/restricted/master.key', masterKey.slice()],
    ['/restricted/rate-policy.json', ratePolicyBytes.slice()],
    ['/restricted/rate-before.ndjson', predecessorBytes.slice()],
    ['/restricted/rate-current.ndjson', committedBytes.slice()],
  ])
  if (profile === 'verified') {
    files.set(
      '/restricted/resource-attestation.json',
      encodeCanonical({ kind: 'resource-attestation' }),
    )
    files.set('/restricted/integrity.key', integrityKey.slice())
    files.set('/restricted/audit.key', auditKey.slice())
  } else {
    files.set(
      '/restricted/target-before.json',
      encodeCanonical({ kind: 'target-audit-before-v4' }),
    )
    files.set(
      '/restricted/target-after.json',
      encodeCanonical({ kind: 'target-audit-after-v4' }),
    )
  }
  return files
}

/** Creates one parser-validated ordinal-zero root projection. */
function createIntegrityAttestationRootProjection(
  configurationBindingDigest: string,
  policyVersion: string,
) {
  const aggregate = Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion,
    attemptCount: 12,
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
  })
  return parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId: 'test-rehearsal',
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        '210987654321',
      ),
    configurationBindingDigest,
    policyVersion,
    attestation: {
      contentMac: digest('root-attestation'),
      byteLength: 1_024,
    },
    segment: {
      authenticationKeyFingerprint:
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          new Uint8Array(32).fill(44),
        ),
      segmentLocatorDigest: digest('root-segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac: digest('root-terminal-record'),
      segmentDigest: digest('root-segment'),
    },
    interval: {
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 1,
      describeTableCallCount: 6,
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      attemptSequences: [7, 8, 9, 10, 11, 12],
      firstEventSequence: 13,
      lastEventSequence: 24,
      eventSequences: Array.from(
        { length: 12 },
        (_value, index) => index + 13,
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: '2026-08-01T23:59:58.000Z',
      completedAt: '2026-08-01T23:59:59.999Z',
    },
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac: digest('root-table-order'),
    rootMac: digest('root'),
    startedAt: '2026-08-01T23:59:58.000Z',
    completedAt: '2026-08-01T23:59:59.999Z',
  })
}

/** Builds one exact verified-terminal reconciliation invocation. */
function createVerifiedArguments(): string[] {
  return [
    'reconcile',
    ...commonArguments,
    ...liveIntegrityArguments(),
    ...reconciliationLimitArguments(),
    ...outputAndMeasureArguments(),
  ]
}

/** Builds one exact rollback-terminal reconciliation invocation. */
function createRollbackArguments(): string[] {
  return [
    'reconcile',
    ...commonArguments,
    '--target-preimage-audit-file',
    '/restricted/target-before.json',
    '--target-restored-audit-file',
    '/restricted/target-after.json',
    ...reconciliationLimitArguments(),
    ...outputAndMeasureArguments(),
  ]
}

/** Builds one exact live target-audit invocation. */
function createTargetArguments(
  mode: 'target-preimage' | 'target-restored',
): string[] {
  return [
    mode,
    ...commonArguments,
    '--maximum-target-pages',
    '1024',
    '--maximum-duration-milliseconds',
    '60000',
    ...liveIntegrityArguments(),
    ...outputAndMeasureArguments(),
  ]
}

/** Returns the exact ordered actual live-integrity profile. */
function liveIntegrityArguments(): readonly string[] {
  return [
    '--resource-attestation-file',
    '/restricted/resource-attestation.json',
    '--integrity-digest-key-file',
    '/restricted/integrity.key',
    '--audit-pseudonym-key-file',
    '/restricted/audit.key',
    '--page-size',
    '100',
    '--max-pages',
    '10',
    '--max-items',
    '1000',
    '--integrity-maximum-duration-milliseconds',
    '30000',
  ]
}

/** Returns the exact finite terminal Query limits. */
function reconciliationLimitArguments(): readonly string[] {
  return [
    '--maximum-query-pages',
    '32',
    '--maximum-query-items',
    '4096',
    '--maximum-query-bytes',
    '8388608',
    '--request-timeout-milliseconds',
    '5000',
    '--maximum-duration-milliseconds',
    '60000',
  ]
}

/** Returns the common output, approval, and existing measure suffix. */
function outputAndMeasureArguments(): readonly string[] {
  return [
    '--output-file',
    '/restricted/output.json',
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_APPROVAL,
    '--',
    'measure',
    ...measureResourceArguments,
    '--rate-policy-file',
    '/restricted/rate-policy.json',
  ]
}

/** Replaces one exact flag value in a mutable argument fixture. */
function replaceFlagValue(
  arguments_: string[],
  flag: string,
  value: string,
): void {
  const index = arguments_.indexOf(flag)
  if (index < 0) throw new Error('Missing fixture flag.')
  arguments_[index + 1] = value
}

/** Creates one complete measured configuration matching CLI resources. */
function createMeasuredConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'migration-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createMeasuredSourceTable(
        'project-directory',
        'project-directory-table',
      ),
      'work-items': createMeasuredSourceTable(
        'work-items',
        'work-items-table',
      ),
      collaboration: createMeasuredSourceTable(
        'collaboration',
        'collaboration-table',
      ),
      documents: createMeasuredSourceTable(
        'documents',
        'documents-table',
      ),
      'workspace-search': createMeasuredSupportTable(
        'workspace-search',
        'workspace-search-table',
      ),
      'migration-state': createMeasuredSupportTable(
        'migration-state',
        'migration-state-table',
      ),
    },
    journal: {
      bucketName: 'mukuroji-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/12345678-1234-1234-1234-123456789012',
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

/** Creates one measured source-table identity with its exact CLI name. */
function createMeasuredSourceTable(
  role: WorkspaceSearchMigrationSourceName,
  tableName: string,
): MigrationTableIdentity {
  return createMeasuredTable(role, tableName, sourceKeyDescriptors(role))
}

/** Creates one measured target or state table with its exact CLI name. */
function createMeasuredSupportTable(
  role: 'migration-state' | 'workspace-search',
  tableName: string,
): MigrationTableIdentity {
  return createMeasuredTable(
    role,
    tableName,
    role === 'workspace-search'
      ? [
        { name: 'workspaceId', role: 'HASH', type: 'S' },
        { name: 'recordKey', role: 'RANGE', type: 'S' },
      ]
      : [
        { name: 'migrationId', role: 'HASH', type: 'S' },
        { name: 'recordKey', role: 'RANGE', type: 'S' },
      ],
  )
}

/** Creates one complete stable measured table identity. */
function createMeasuredTable(
  role: MigrationTableIdentity['role'],
  tableName: string,
  key: readonly MigrationKeyAttribute[],
): MigrationTableIdentity {
  return {
    role,
    tableName,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${tableName}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/** Returns the measured primary-key schema for one source role. */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}

/** Recomputes the exact fixture resource binding through the production helper. */
function createRequestedResourcesBindingForFixture(): string {
  const parsed =
    parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
      createVerifiedArguments(),
    )
  return createWorkspaceSearchMigrationRequestedResourcesBinding(
    parsed.measure.resources,
  )
}

/** Encodes one canonical JSON value into exact UTF-8 bytes. */
function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/** Creates one lowercase SHA-256 fixture digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Compares exact test bytes without reflecting their contents. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every(
    (value, index) => value === right[index],
  )
}

/** Returns whether deterministic cleanup overwrote an entire test buffer. */
function isZeroized(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0)
}
