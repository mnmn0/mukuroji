import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  calculateCrossDomainIntegrityResourceBindingDigest,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityInvocationDeadline,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  runCrossDomainIntegrityCheck,
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
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
} from './migration-describe-table-rate-policy'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
} from './migration-rehearsal-key-derivation'
import {
  authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult,
  type WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability,
} from './migration-rehearsal-integrity-evidence'
import {
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
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
  type WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
} from './migration-rehearsal-reconciliation-audit'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_ITEMS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_PAGES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_REQUEST_TIMEOUT_MILLISECONDS,
} from './migration-rehearsal-reconciliation-aws'
import {
  parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments,
  runWorkspaceSearchMigrationRehearsalReconciliationCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
  type WorkspaceSearchMigrationRehearsalReconciliationCliDependencies,
  type WorkspaceSearchMigrationRehearsalReconciliationCliMode,
  type WorkspaceSearchMigrationRehearsalReconciliationCliSession,
  type WorkspaceSearchMigrationRehearsalAuthenticatedCollection,
} from './migration-rehearsal-reconciliation-cli'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor,
} from './migration-rehearsal-rate-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_PAGES,
} from './migration-rehearsal-target-audit'
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

/** Valid canonical reviewed rate policy used by AWS-free CLI tests. */
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

/** Dedicated #163 HMAC key used only to mint opaque CLI-test capabilities. */
const cliIntegrityDigestKey = new Uint8Array(32).fill(73)

/** Fixed physical-resource identities used by CLI live-preimage fixtures. */
const cliIntegrityResourceIdentities:
  readonly CrossDomainIntegrityResourceIdentity[] =
    CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target) => Object.freeze({
      target,
      identityDigest: digest(`cli-integrity-resource:${target}`),
    }))

/** Keyed identity digest accepted by CLI live-preimage fixture authentication. */
const cliIntegrityResourceIdentityDigest =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    cliIntegrityResourceIdentities,
    cliIntegrityDigestKey,
  )

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
  '/restricted/rate-reconcile.ndjson',
]

/** Exact source-controlled deployment target used by permit stubs. */
const permitDeploymentTargetId = 'test-rehearsal'

/** Exact distinct production account used by permit stubs. */
const permitProductionAccount = '210987654321'

/**
 * Creates one parser-validated ordinal-zero root projection.
 *
 * @param configurationBindingDigest - Exact measured configuration digest.
 * @param policyVersion - Exact reviewed DescribeTable policy digest.
 * @returns Structurally strict projection matching one permit stub.
 */
function createIntegrityAttestationRootProjection(
  configurationBindingDigest: string,
  policyVersion: string,
) {
  const rootStartedAt = '2026-08-01T23:59:58.000Z'
  const rootCompletedAt = '2026-08-01T23:59:59.999Z'
  const aggregate = {
    version: 1,
    policyVersion,
    attemptCount: 12,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  }
  return parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId: permitDeploymentTargetId,
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        permitProductionAccount,
      ),
    configurationBindingDigest,
    policyVersion,
    attestation: {
      contentMac: digest('reconciliation-root-attestation'),
      byteLength: 1_024,
    },
    segment: {
      authenticationKeyFingerprint: digest('reconciliation-root-rate-key'),
      segmentLocatorDigest: digest('reconciliation-root-segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac: digest('reconciliation-root-terminal-record'),
      segmentDigest: digest('reconciliation-root-segment'),
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
      startedAt: rootStartedAt,
      completedAt: rootCompletedAt,
    },
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac: digest('reconciliation-root-table-order'),
    rootMac: digest('reconciliation-root'),
    startedAt: rootStartedAt,
    completedAt: rootCompletedAt,
  })
}

describe('migration rehearsal reconciliation CLI', () => {
  test('parses the verified profile without operator terminal or count fields', () => {
    const configuration =
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        createVerifiedArguments(),
      )

    expect(configuration.mode).toBe('reconcile')
    if (configuration.mode !== 'reconcile') {
      throw new Error('Expected reconciliation configuration.')
    }
    expect(configuration.integrityFiles).toEqual({
      kind: 'verified-result',
      resultFile: '/restricted/integrity-after.json',
      integrityKeyFile: '/restricted/integrity.key',
    })
    expect(configuration.limits).toEqual({
      maximumPages: 32,
      maximumItems: 4_096,
      maximumBytes: 8_388_608,
      requestTimeoutMilliseconds: 5_000,
      maximumDurationMilliseconds: 60_000,
    })
    expect(configuration.measure.command).toBe('measure')
    expect(Object.isFrozen(configuration)).toBe(true)

    const injectedTerminal = createVerifiedArguments()
    injectedTerminal.splice(
      injectedTerminal.indexOf('--maximum-query-pages'),
      0,
      '--terminal-root-digest',
      'f'.repeat(64),
    )
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        injectedTerminal,
      )).toThrow('INVALID_USAGE')
  })

  test('parses the rollback profile with scenario-specific target artifacts', () => {
    const configuration =
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        createRollbackArguments(),
      )

    expect(configuration.mode).toBe('reconcile')
    if (configuration.mode !== 'reconcile') {
      throw new Error('Expected reconciliation configuration.')
    }
    expect(configuration.integrityFiles).toEqual({
      kind: 'rollback-comparison',
      beforeResultFile: '/restricted/integrity-before.json',
      afterResultFile: '/restricted/integrity-after.json',
      integrityKeyFile: '/restricted/integrity.key',
      targetPreimageAuditFile: '/restricted/target-before.json',
      targetRestoredAuditFile: '/restricted/target-after.json',
    })
    expect(Reflect.has(configuration, 'scenario')).toBe(false)
    expect(Reflect.has(configuration, 'expectedAuthorities')).toBe(false)
  })

  test('parses both target modes and rejects path aliasing or invalid limits', () => {
    const targetModes: readonly (
      'target-preimage' | 'target-restored'
    )[] = ['target-preimage', 'target-restored']
    for (const mode of targetModes) {
      const configuration =
        parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
          createTargetArguments(mode),
        )
      expect(configuration.mode).toBe(mode)
      if (configuration.mode === 'reconcile') {
        throw new Error('Expected target configuration.')
      }
      expect(configuration.maximumTargetPages).toBe(1_024)
      expect(configuration.maximumDurationMilliseconds).toBe(60_000)
      if (configuration.mode === 'target-preimage') {
        expect(configuration.integrityBeforeResultFile).toBe(
          '/restricted/integrity-before.json',
        )
        expect(configuration.integrityKeyFile).toBe(
          '/restricted/integrity.key',
        )
      } else {
        expect(Reflect.has(configuration, 'integrityBeforeResultFile')).toBe(
          false,
        )
        expect(Reflect.has(configuration, 'integrityKeyFile')).toBe(false)
      }
    }

    const duplicate = createTargetArguments('target-preimage')
    duplicate[duplicate.indexOf('/restricted/output.json')] =
      '/restricted/material.json'
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        duplicate,
      )).toThrow('INVALID_USAGE')

    const duplicateIntegrity = createTargetArguments('target-preimage')
    duplicateIntegrity[
      duplicateIntegrity.indexOf('/restricted/integrity-before.json')
    ] = '/restricted/output.json'
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        duplicateIntegrity,
      )).toThrow('INVALID_USAGE')

    const restoredWithIntegrity = createTargetArguments('target-restored')
    restoredWithIntegrity.splice(
      restoredWithIntegrity.indexOf('--output-file'),
      0,
      '--integrity-before-result-file',
      '/restricted/integrity-before.json',
      '--integrity-key-file',
      '/restricted/integrity.key',
    )
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        restoredWithIntegrity,
      )).toThrow('INVALID_USAGE')

    const invalidLimit = createTargetArguments('target-restored')
    invalidLimit[invalidLimit.indexOf('1024')] = '0'
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        invalidLimit,
      )).toThrow('INVALID_USAGE')

    const excessivePages = createTargetArguments('target-preimage')
    excessivePages[excessivePages.indexOf('1024')] = String(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_PAGES + 1,
    )
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        excessivePages,
      )).toThrow('INVALID_USAGE')

    const excessiveDuration = createTargetArguments('target-restored')
    excessiveDuration[excessiveDuration.indexOf('60000')] = String(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS +
        1,
    )
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
        excessiveDuration,
      )).toThrow('INVALID_USAGE')
  })

  test('rejects every reconciliation budget one above the collector ceiling', () => {
    const boundaries: readonly {
      readonly flag: string
      readonly maximum: number
    }[] = [
      {
        flag: '--maximum-query-pages',
        maximum:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_PAGES,
      },
      {
        flag: '--maximum-query-items',
        maximum:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_ITEMS,
      },
      {
        flag: '--maximum-query-bytes',
        maximum:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_BYTES,
      },
      {
        flag: '--request-timeout-milliseconds',
        maximum:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_REQUEST_TIMEOUT_MILLISECONDS,
      },
      {
        flag: '--maximum-duration-milliseconds',
        maximum:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS,
      },
    ]
    for (const boundary of boundaries) {
      const arguments_ = createVerifiedArguments()
      const flagIndex = arguments_.indexOf(boundary.flag)
      if (flagIndex < 0) throw new Error('Missing expected test flag.')
      arguments_[flagIndex + 1] = String(boundary.maximum + 1)
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalReconciliationCliArguments(
          arguments_,
        )).toThrow('INVALID_USAGE')
    }
  })

  test('fails closed before AWS when parent material authentication fails and zeroizes every raw file', async () => {
    const masterKey = new Uint8Array(32).fill(17)
    const integrityKey = new Uint8Array(32).fill(91)
    const sourceFiles = createInputFiles(masterKey, integrityKey)
    const returnedBuffers: Uint8Array[] = []
    const contextRuntimeKeys: Uint8Array[] = []
    const contextPublicationKeys: Uint8Array[] = []
    const stdout: string[] = []
    const stderr: string[] = []
    let createRuntimeCount = 0
    let createSessionCount = 0
    const derived = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
    const policy =
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
        ratePolicyBytes,
      )
    const dependencies = createFailingContextDependencies({
      sourceFiles,
      returnedBuffers,
      contextRuntimeKeys,
      contextPublicationKeys,
      stdout,
      stderr,
      runtimeKeyDigest: derived.runtimeKeyDigest,
      publicationKeyDigest: derived.publicationKeyDigest,
      configurationBindingDigest:
        createWorkspaceSearchConfigurationHash(createMeasuredConfiguration()),
      policyVersion: policy.policyVersion,
      incrementRuntime: () => {
        createRuntimeCount += 1
      },
      incrementSession: () => {
        createSessionCount += 1
      },
    })
    derived.runtimeKey.fill(0)
    derived.publicationKey.fill(0)

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalReconciliationCli(
        createVerifiedArguments(),
        dependencies,
      )

    expect(exitCode).toBe(1)
    expect(createRuntimeCount).toBe(0)
    expect(createSessionCount).toBe(0)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([
      serializeCanonicalJson({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
        status: 'error',
        code: 'AUTHENTICATION_FAILED',
      }),
    ])
    expect(returnedBuffers.length).toBeGreaterThan(8)
    for (const buffer of returnedBuffers) {
      expect(buffer.every((value) => value === 0)).toBe(true)
    }
    expect(contextRuntimeKeys).toHaveLength(1)
    expect(contextPublicationKeys).toHaveLength(1)
    expect(contextRuntimeKeys[0]?.every((value) => value === 0)).toBe(true)
    expect(contextPublicationKeys[0]?.every((value) => value === 0)).toBe(true)
    expect(stderr[0]).not.toContain('/restricted/')
    expect(stderr[0]).not.toContain('run-secret-canary')
  })

  test('seals rate ownership, verifies successor bytes, publishes, and closes', async () => {
    const masterKey = new Uint8Array(32).fill(17)
    const integrityKey = new Uint8Array(32).fill(91)
    const predecessorBytes = encodeCanonical({ segment: 'predecessor' })
    const successorBytes = encodeCanonical({ segment: 'successor' })
    const sourceFiles = new Map(createInputFiles(masterKey, integrityKey))
    sourceFiles.set('/restricted/rate-before.ndjson', predecessorBytes)
    sourceFiles.set('/restricted/rate-reconcile.ndjson', successorBytes)
    const returnedBuffers: Uint8Array[] = []
    const events: string[] = []
    const stdout: string[] = []
    const stderr: string[] = []
    const finalizerRuntimeKeys: Uint8Array[] = []
    const finalizerPublicationKeys: Uint8Array[] = []
    const contextRuntimeKeys: Uint8Array[] = []
    const contextPublicationKeys: Uint8Array[] = []
    const sessionStageKeys: Uint8Array[] = []
    const rateVerificationKeys: Uint8Array[] = []
    const integrityVerificationKeys: Uint8Array[] = []
    const writtenArtifacts: Uint8Array[] = []
    const measuredConfiguration = createMeasuredConfiguration()
    const configurationBindingDigest =
      createWorkspaceSearchConfigurationHash(measuredConfiguration)
    const policy =
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
        ratePolicyBytes,
      )
    const derived = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
    const rateAuthenticationKeyFingerprint =
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        derived.runtimeKey,
      )
    const committedSegment = createCommittedRateSegment(
      successorBytes,
      rateAuthenticationKeyFingerprint,
    )
    const successorProof = createVerifiedRateSuccessor(
      committedSegment,
      policy.policyVersion,
      configurationBindingDigest,
      rateAuthenticationKeyFingerprint,
    )
    const durableEvidence = Object.freeze({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      policyVersion: policy.policyVersion,
      attemptCount: 3,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 1,
    })
    const wallClockSamples = [
      '2026-08-02T00:08:00.000Z',
      '2026-08-02T00:09:30.000Z',
      '2026-08-02T00:09:30.000Z',
      '2026-08-02T00:09:59.999Z',
    ]
    const collectorResult = createSuccessfulCollectorResult(
      configurationBindingDigest,
    )
    if (collectorResult.integrity.kind !== 'verified-result') {
      throw new Error('Expected verified collector result.')
    }
    const finalArtifactContext = Object.freeze({
      ...collectorResult.context,
      integrity: Object.freeze({
        ...collectorResult.integrity,
        resultContextDigest: digest('integrity-result-context'),
        migrationContextDigest: digest('integrity-migration-context'),
      }),
      targetAudits: null,
    })
    const finalArtifactBytes = encodeCanonical({
      kind: 'final-reconciliation-audit',
    })
    const finalArtifactDigest = digest('final-reconciliation-audit')
    let requestedResourcesBinding: string | undefined
    let claimedStageHead: WorkspaceSearchMigrationRehearsalStageHead |
      undefined
    let collectedMaximumDurationMilliseconds: number | undefined
    let collectedIntegrityCompletedAt: string | undefined
    let finalizerInput: Parameters<
      WorkspaceSearchMigrationRehearsalReconciliationCliDependencies[
        'finalizeReconciliation'
      ]
    >[0] | undefined
    const session:
      WorkspaceSearchMigrationRehearsalReconciliationCliSession =
      Object.freeze({
        readRehearsalClaimedStageHead: () => claimedStageHead,
        scanTargetPage: () => Promise.reject(
          new Error('unexpected-target-page'),
        ),
        readRequestedResourcesBinding: () => {
          const binding = requestedResourcesBinding
          if (binding === undefined) {
            throw new Error('missing-requested-resources-binding')
          }
          return binding
        },
        readRehearsalEvidenceSessionBinding: () => {
          throw new Error('unexpected-session-binding-read')
        },
        measureConfiguration: () => {
          events.push('measure-configuration')
          return Promise.resolve(measuredConfiguration)
        },
        collectRehearsalReconciliation: (
          input: Parameters<
            WorkspaceSearchMigrationRehearsalReconciliationCliSession[
              'collectRehearsalReconciliation'
            ]
          >[0],
        ) => {
          events.push('collect-reconciliation')
          integrityVerificationKeys.push(input.integrity.digestKey)
          collectedIntegrityCompletedAt = input.clock().toISOString()
          collectedMaximumDurationMilliseconds =
            input.limits.maximumDurationMilliseconds
          return Promise.resolve(collectorResult)
        },
        interruptDescribeTableRate: () => {
          events.push('interrupt-session')
        },
        close: () => {
          events.push('final-session-close')
          return Promise.resolve()
        },
        sealAndReadDescribeTableRateEvidence: () => {
          events.push('session-seal-and-read-rate')
          return Promise.resolve(durableEvidence)
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
          }
          if (path === '/restricted/rate-reconcile.ndjson') {
            events.push('read-rate-successor')
          }
          const bytes = source.slice()
          returnedBuffers.push(bytes)
          return bytes
        },
        authenticateCollectionContext: (input) => {
          events.push('authenticate-context')
          contextRuntimeKeys.push(input.runtimeVerificationKey)
          contextPublicationKeys.push(input.publicationVerificationKey)
          const binding = requestedResourcesBinding
          if (binding === undefined) {
            throw new Error('missing-requested-resources-binding')
          }
          const fixture = createAuthenticatedCollectionFixture(
            binding,
            configurationBindingDigest,
            policy.policyVersion,
            derived.runtimeKeyDigest,
            derived.publicationKeyDigest,
            collectorResult,
          )
          claimedStageHead = fixture.claimedHead
          return fixture.authentication
        },
        verifyPermit: (input) => {
          events.push('verify-permit')
          requestedResourcesBinding = input.requestedResourcesBinding
          return Object.freeze({
            kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
            permitVersion:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
            stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
            approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
            account: input.account,
            productionAccount: permitProductionAccount,
            region: input.region,
            callerArn:
              'arn:aws:sts::123456789012:assumed-role/rehearsal/operator',
            commit: input.commit,
            deploymentTargetId: permitDeploymentTargetId,
            deploymentTrustRootDigest: digest('deployment-trust-root'),
            requestedResourcesBinding: input.requestedResourcesBinding,
            configurationBindingDigest,
            policyVersion: policy.policyVersion,
            integrityResourceIdentityScheme:
              CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
            integrityResourceIdentities: cliIntegrityResourceIdentities,
            integrityResourceIdentityDigest: digest('integrity-resources'),
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
        authenticateIntegrityPreimage: () => {
          throw new Error('unexpected-integrity-preimage-authentication')
        },
        createRateRuntime: () => {
          events.push('create-rate-runtime')
          return Promise.resolve(Object.freeze({
            recorder: Object.freeze({
              record: () => undefined,
              appendForfeitedAttempt: () => Promise.resolve(),
              appendForfeitedReservation: () => Promise.resolve(),
              flush: () => Promise.resolve(committedSegment),
              close: () => Promise.resolve(),
            }),
            flush: () => {
              events.push('flush-rate-runtime')
              return Promise.resolve(committedSegment)
            },
            close: () => {
              events.push('close-rate-runtime')
              return Promise.resolve()
            },
          }))
        },
        createSession: (input) => {
          events.push('create-session')
          const stageReservationClaim = input.stageReservationClaim
          if (stageReservationClaim === undefined) {
            throw new Error('missing-stage-reservation-claim')
          }
          sessionStageKeys.push(stageReservationClaim.stageKey)
          return Promise.resolve(session)
        },
        verifyRateSegmentSuccessor: (input) => {
          events.push('verify-rate-successor')
          rateVerificationKeys.push(input.authenticationKey)
          return successorProof
        },
        collectTargetAudit: () => Promise.reject(
          new Error('unexpected-target-audit'),
        ),
        finalizeTargetAudit: () => {
          throw new Error('unexpected-target-finalizer')
        },
        finalizeReconciliation: (
          input,
          runtimeSigningKey,
          publicationSigningKey,
        ) => {
          events.push('finalize-reconciliation')
          finalizerInput = input
          finalizerRuntimeKeys.push(runtimeSigningKey)
          finalizerPublicationKeys.push(publicationSigningKey)
          return Object.freeze({
            canonicalBytes: finalArtifactBytes.slice(),
            byteLength: finalArtifactBytes.byteLength,
            contentDigest: finalArtifactDigest,
            context: finalArtifactContext,
          })
        },
        ensureOutputAbsent: () => {
          events.push('ensure-output-absent')
          return Promise.resolve()
        },
        writeOutputExclusive: (_path, bytes) => {
          events.push('write-output')
          writtenArtifacts.push(bytes.slice())
          return Promise.resolve('created')
        },
        clock: () => new Date(
          wallClockSamples.shift() ?? '2026-08-02T00:09:59.999Z',
        ),
        monotonicClock: () => 1_000,
        writeStdoutLine: (line) => {
          stdout.push(line)
        },
        writeStderrLine: (line) => {
          stderr.push(line)
        },
      })
    derived.runtimeKey.fill(0)
    derived.publicationKey.fill(0)

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalReconciliationCli(
        createVerifiedArguments(),
        dependencies,
      )

    expect(exitCode).toBe(0)
    expect(events).toEqual([
      'ensure-output-absent',
      'verify-permit',
      'authenticate-context',
      'create-rate-runtime',
      'create-session',
      'measure-configuration',
      'collect-reconciliation',
      'session-seal-and-read-rate',
      'flush-rate-runtime',
      'close-rate-runtime',
      'read-rate-predecessor',
      'read-rate-successor',
      'verify-rate-successor',
      'finalize-reconciliation',
      'final-session-close',
      'write-output',
    ])
    expect(finalizerInput?.rate).toEqual({
      verifiedSuccessor: successorProof,
      durableEvidence,
      completedAt: '2026-08-02T00:09:59.999Z',
    })
    expect(collectedMaximumDurationMilliseconds).toBe(30_000)
    expect(collectedIntegrityCompletedAt).toBe(
      '2026-08-02T00:09:30.000Z',
    )
    expect(writtenArtifacts).toEqual([finalArtifactBytes])
    expect(stdout).toEqual([
      serializeCanonicalJson({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
        status: 'succeeded',
        operation: 'reconcile',
        contentDigest: finalArtifactDigest,
        byteLength: finalArtifactBytes.byteLength,
        rateSegmentDigest: successorProof.successor.segmentDigest,
      }),
    ])
    expect(stderr).toEqual([])
    for (const buffer of returnedBuffers) {
      expect(buffer.every((value) => value === 0)).toBe(true)
    }
    for (const key of [
      ...contextRuntimeKeys,
      ...contextPublicationKeys,
      ...sessionStageKeys,
      ...rateVerificationKeys,
      ...integrityVerificationKeys,
      ...finalizerRuntimeKeys,
      ...finalizerPublicationKeys,
    ]) {
      expect(key.every((value) => value === 0)).toBe(true)
    }
  })

  test('admits no collector after the reservation-capped deadline expires', async () => {
    const masterKey = new Uint8Array(32).fill(17)
    const integrityKey = new Uint8Array(32).fill(91)
    const sourceFiles = createInputFiles(masterKey, integrityKey)
    const policy =
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
        ratePolicyBytes,
      )
    const measuredConfiguration = createMeasuredConfiguration()
    const configurationBindingDigest =
      createWorkspaceSearchConfigurationHash(measuredConfiguration)
    const collectorResult = createSuccessfulCollectorResult(
      configurationBindingDigest,
    )
    const derived = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
    const runtimeKeyDigest = derived.runtimeKeyDigest
    const publicationKeyDigest = derived.publicationKeyDigest
    derived.runtimeKey.fill(0)
    derived.publicationKey.fill(0)
    const stderr: string[] = []
    const sessionStageKeys: Uint8Array[] = []
    let requestedResourcesBinding: string | undefined
    let claimedHead: WorkspaceSearchMigrationRehearsalStageHead | undefined
    let measureCount = 0
    let collectorCount = 0
    let outputCount = 0
    let sessionCloseCount = 0
    let runtimeCloseCount = 0
    const monotonicSamples = [100, 100, 101]
    const session:
      WorkspaceSearchMigrationRehearsalReconciliationCliSession =
      Object.freeze({
        readRehearsalClaimedStageHead: () => claimedHead,
        scanTargetPage: () => Promise.reject(
          new Error('unexpected-target-page'),
        ),
        readRequestedResourcesBinding: () => {
          const value = requestedResourcesBinding
          if (value === undefined) throw new Error('missing-binding')
          return value
        },
        readRehearsalEvidenceSessionBinding: () => {
          throw new Error('unexpected-session-binding')
        },
        measureConfiguration: () => {
          measureCount += 1
          return Promise.resolve(measuredConfiguration)
        },
        collectRehearsalReconciliation: () => {
          collectorCount += 1
          return Promise.resolve(collectorResult)
        },
        interruptDescribeTableRate: () => undefined,
        close: () => {
          sessionCloseCount += 1
          return Promise.resolve()
        },
        sealAndReadDescribeTableRateEvidence: () => Promise.reject(
          new Error('unexpected-rate-seal'),
        ),
      })
    const dependencies:
      WorkspaceSearchMigrationRehearsalReconciliationCliDependencies =
      Object.freeze({
        readRestrictedFile: async (path) => {
          const source = sourceFiles.get(path)
          if (source === undefined) throw new Error('missing-test-file')
          return source.slice()
        },
        authenticateCollectionContext: (input) => {
          const binding = requestedResourcesBinding
          if (binding === undefined) throw new Error('missing-binding')
          const fixture = createAuthenticatedCollectionFixture(
            binding,
            configurationBindingDigest,
            policy.policyVersion,
            runtimeKeyDigest,
            publicationKeyDigest,
            collectorResult,
          )
          claimedHead = fixture.claimedHead
          input.runtimeVerificationKey.fill(0)
          input.publicationVerificationKey.fill(0)
          return fixture.authentication
        },
        verifyPermit: (input) => {
          requestedResourcesBinding = input.requestedResourcesBinding
          return Object.freeze({
            kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
            permitVersion:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
            stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
            approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
            account: input.account,
            productionAccount: permitProductionAccount,
            region: input.region,
            callerArn:
              'arn:aws:sts::123456789012:assumed-role/rehearsal/operator',
            commit: input.commit,
            deploymentTargetId: permitDeploymentTargetId,
            deploymentTrustRootDigest: digest('deployment-trust-root'),
            requestedResourcesBinding: input.requestedResourcesBinding,
            configurationBindingDigest,
            policyVersion: policy.policyVersion,
            integrityResourceIdentityScheme:
              CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
            integrityResourceIdentities: cliIntegrityResourceIdentities,
            integrityResourceIdentityDigest: digest('integrity-resources'),
            evidenceKeyDigest: runtimeKeyDigest,
            publicationKeyDigest,
            integrityAttestationRoot:
              createIntegrityAttestationRootProjection(
                configurationBindingDigest,
                policy.policyVersion,
              ),
            issuedAt: '2026-08-02T00:00:00.000Z',
            expiresAt: '2026-08-02T01:00:00.000Z',
          })
        },
        authenticateIntegrityPreimage: () => {
          throw new Error('unexpected-integrity-preimage-authentication')
        },
        createRateRuntime: () => Promise.resolve(Object.freeze({
          recorder: Object.freeze({
            record: () => undefined,
            appendForfeitedAttempt: () => Promise.resolve(),
            appendForfeitedReservation: () => Promise.resolve(),
            flush: () => Promise.reject(new Error('unexpected-flush')),
            close: () => Promise.resolve(),
          }),
          flush: () => Promise.reject(new Error('unexpected-flush')),
          close: () => {
            runtimeCloseCount += 1
            return Promise.resolve()
          },
        })),
        createSession: (input) => {
          const stageReservationClaim = input.stageReservationClaim
          if (stageReservationClaim === undefined) {
            throw new Error('missing-stage-reservation-claim')
          }
          sessionStageKeys.push(stageReservationClaim.stageKey)
          return Promise.resolve(session)
        },
        verifyRateSegmentSuccessor: () => {
          throw new Error('unexpected-rate-verification')
        },
        collectTargetAudit: () => Promise.reject(
          new Error('unexpected-target-audit'),
        ),
        finalizeTargetAudit: () => {
          throw new Error('unexpected-target-finalizer')
        },
        finalizeReconciliation: () => {
          throw new Error('unexpected-reconciliation-finalizer')
        },
        ensureOutputAbsent: () => Promise.resolve(),
        writeOutputExclusive: async (): Promise<'created'> => {
          outputCount += 1
          return 'created'
        },
        clock: () => new Date('2026-08-02T00:09:59.999Z'),
        monotonicClock: () => monotonicSamples.shift() ?? 101,
        writeStdoutLine: () => {
          throw new Error('unexpected-stdout')
        },
        writeStderrLine: (line) => {
          stderr.push(line)
        },
      })

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalReconciliationCli(
        createVerifiedArguments(),
        dependencies,
      )

    expect(exitCode).toBe(1)
    expect(measureCount).toBe(1)
    expect(collectorCount).toBe(0)
    expect(outputCount).toBe(0)
    expect(sessionCloseCount).toBe(1)
    expect(runtimeCloseCount).toBe(1)
    expect(sessionStageKeys).toHaveLength(1)
    expect(sessionStageKeys[0]?.every((value) => value === 0)).toBe(true)
    expect(stderr).toEqual([
      serializeCanonicalJson({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
        status: 'error',
        code: 'OPERATION_FAILED',
      }),
    ])
  })

  test('rejects invalid actual integrity completion and adapter time substitution', async () => {
    const cases = [
      Object.freeze({
        actualCompletedAt: '2026-08-02T00:10:00.000Z',
        adapterCompletedAt: '2026-08-02T00:10:00.000Z',
        expectedCode: 'OPERATION_FAILED',
        expectedCollectorCount: 1,
      }),
      Object.freeze({
        actualCompletedAt: '2026-08-02T00:10:00.001Z',
        adapterCompletedAt: '2026-08-02T00:10:00.001Z',
        expectedCode: 'OPERATION_FAILED',
        expectedCollectorCount: 1,
      }),
      Object.freeze({
        actualCompletedAt: '2026-08-02T00:09:29.999Z',
        adapterCompletedAt: '2026-08-02T00:09:29.999Z',
        expectedCode: 'OPERATION_FAILED',
        expectedCollectorCount: 1,
      }),
      Object.freeze({
        actualCompletedAt: '2026-08-02T00:09:30.000Z',
        adapterCompletedAt: '2026-08-02T00:09:29.999Z',
        expectedCode: 'AUTHENTICATION_FAILED',
        expectedCollectorCount: 1,
      }),
    ]
    for (const testCase of cases) {
      const result = await runIntegrityCompletionBoundaryCase(
        testCase.actualCompletedAt,
        testCase.adapterCompletedAt,
      )
      expect(result.exitCode).toBe(1)
      expect(result.collectorCount).toBe(testCase.expectedCollectorCount)
      expect(result.finalizerCount).toBe(0)
      expect(result.outputCount).toBe(0)
      expect(result.sessionCloseCount).toBe(1)
      expect(result.runtimeCloseCount).toBe(1)
      expect(result.allReturnedBuffersZeroized).toBe(true)
      expect(result.allStageKeysZeroized).toBe(true)
      expect(result.stderr).toEqual([
        serializeCanonicalJson({
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
          status: 'error',
          code: testCase.expectedCode,
        }),
      ])
    }
  })

  test('rejects final rate completion at cutoff, after cutoff, or after clock regression', async () => {
    const finalCompletedAtCases = [
      '2026-08-02T00:10:00.000Z',
      '2026-08-02T00:10:00.001Z',
      '2026-08-02T00:09:29.999Z',
    ]
    for (const finalCompletedAt of finalCompletedAtCases) {
      const result = await runIntegrityCompletionBoundaryCase(
        '2026-08-02T00:09:30.000Z',
        '2026-08-02T00:09:30.000Z',
        finalCompletedAt,
      )
      expect(result.exitCode).toBe(1)
      expect(result.collectorCount).toBe(1)
      expect(result.finalizerCount).toBe(0)
      expect(result.outputCount).toBe(0)
      expect(result.sessionCloseCount).toBe(1)
      expect(result.runtimeCloseCount).toBe(1)
      expect(result.allReturnedBuffersZeroized).toBe(true)
      expect(result.allStageKeysZeroized).toBe(true)
      expect(result.stderr).toEqual([
        serializeCanonicalJson({
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
          status: 'error',
          code: 'OPERATION_FAILED',
        }),
      ])
    }
  })

  test('reserves mode-specific post-collection runway before any AWS collection', async () => {
    const cases = [
      Object.freeze({
        mode: 'reconcile',
        reservationExpiresAt: '2026-08-02T00:20:00.000Z',
        cutoffAt: '2026-08-02T00:10:00.000Z',
      }),
      Object.freeze({
        mode: 'target-preimage',
        reservationExpiresAt: '2026-08-02T00:20:00.000Z',
        cutoffAt: '2026-08-02T00:10:00.000Z',
      }),
      Object.freeze({
        mode: 'target-restored',
        reservationExpiresAt: '2026-08-02T00:40:00.000Z',
        cutoffAt: '2026-08-02T00:15:00.000Z',
      }),
    ] satisfies readonly {
      readonly mode: WorkspaceSearchMigrationRehearsalReconciliationCliMode
      readonly reservationExpiresAt: string
      readonly cutoffAt: string
    }[]
    for (const testCase of cases) {
      const result = await runIntegrityCompletionBoundaryCase(
        testCase.cutoffAt,
        testCase.cutoffAt,
        undefined,
        testCase.mode,
        testCase.reservationExpiresAt,
        testCase.cutoffAt,
      )
      expect(result.exitCode).toBe(1)
      expect(result.measureCount).toBe(0)
      expect(result.collectorCount).toBe(0)
      expect(result.targetAuditCount).toBe(0)
      expect(result.finalizerCount).toBe(0)
      expect(result.outputCount).toBe(0)
      expect(result.sessionCloseCount).toBe(1)
      expect(result.runtimeCloseCount).toBe(1)
      expect(result.allReturnedBuffersZeroized).toBe(true)
      expect(result.allStageKeysZeroized).toBe(true)
      expect(result.stderr).toEqual([
        serializeCanonicalJson({
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_CLI_RESULT_KIND,
          status: 'error',
          code: 'OPERATION_FAILED',
        }),
      ])
    }
  })

  test('authenticates and zeroizes the target preimage before opening AWS capabilities', async () => {
    const result = await runIntegrityCompletionBoundaryCase(
      '2026-08-02T00:10:00.000Z',
      '2026-08-02T00:10:00.000Z',
      undefined,
      'target-preimage',
      '2026-08-02T00:20:00.000Z',
      '2026-08-02T00:10:00.000Z',
    )

    expect(result.exitCode).toBe(1)
    expect(result.preAwsEvents).toEqual([
      'authenticate-integrity-preimage',
      'create-rate-runtime',
      'create-session',
    ])
    expect(result.targetAuditCount).toBe(0)
    expect(result.allIntegrityPreimageKeysZeroized).toBe(true)
  })

  test('rejects an existing output before reading secrets or creating AWS capabilities', async () => {
    let readCount = 0
    let sessionCount = 0
    const stderr: string[] = []
    const dependencies = createRejectingOutputDependencies(
      () => {
        readCount += 1
      },
      () => {
        sessionCount += 1
      },
      stderr,
    )

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalReconciliationCli(
        createTargetArguments('target-preimage'),
        dependencies,
      )

    expect(exitCode).toBe(1)
    expect(readCount).toBe(0)
    expect(sessionCount).toBe(0)
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).not.toContain('/restricted/output.json')
  })
})

/** Builds one exact verified-terminal reconciliation invocation. */
function createVerifiedArguments(): string[] {
  return [
    'reconcile',
    ...commonArguments,
    '--integrity-result-file',
    '/restricted/integrity-after.json',
    '--integrity-key-file',
    '/restricted/integrity.key',
    ...reconciliationLimitArguments(),
    ...outputAndMeasureArguments(),
  ]
}

/** Builds one exact rollback-terminal reconciliation invocation. */
function createRollbackArguments(): string[] {
  return [
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
  ]
}

/** Builds one exact target-audit invocation. */
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
    ...(mode === 'target-preimage'
      ? [
          '--integrity-before-result-file',
          '/restricted/integrity-before.json',
          '--integrity-key-file',
          '/restricted/integrity.key',
        ]
      : []),
    ...outputAndMeasureArguments(),
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

/** Complete file map used by the authentication-failure lifecycle test. */
function createInputFiles(
  masterKey: Uint8Array,
  integrityKey: Uint8Array,
): ReadonlyMap<string, Uint8Array> {
  return new Map([
    ['/restricted/manifest.json', encodeCanonical({ kind: 'manifest' })],
    [
      '/restricted/previous-receipt.json',
      encodeCanonical({ kind: 'receipt' }),
    ],
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
    ['/restricted/integrity.key', integrityKey.slice()],
    [
      '/restricted/integrity-before.json',
      encodeCanonical({ kind: 'integrity-before-result' }),
    ],
    [
      '/restricted/integrity-after.json',
      encodeCanonical({ kind: 'integrity-result' }),
    ],
  ])
}

/** Runs one full CLI boundary around an actual integrity-completion sample. */
async function runIntegrityCompletionBoundaryCase(
  actualCompletedAt: string,
  adapterCompletedAt: string,
  finalCompletedAt?: string,
  mode: WorkspaceSearchMigrationRehearsalReconciliationCliMode = 'reconcile',
  reservationExpiresAt = '2026-08-02T00:20:00.000Z',
  deadlineObservedAt = '2026-08-02T00:09:30.000Z',
) {
  const masterKey = new Uint8Array(32).fill(17)
  const integrityKey = new Uint8Array(32).fill(91)
  const predecessorBytes = encodeCanonical({ segment: 'predecessor' })
  const successorBytes = encodeCanonical({ segment: 'successor' })
  const sourceFiles = new Map(createInputFiles(masterKey, integrityKey))
  sourceFiles.set('/restricted/rate-before.ndjson', predecessorBytes)
  sourceFiles.set('/restricted/rate-reconcile.ndjson', successorBytes)
  const targetIntegrityBefore = mode === 'target-preimage'
    ? await createCliIntegrityPreimageCapability()
    : undefined
  const returnedBuffers: Uint8Array[] = []
  const stageKeys: Uint8Array[] = []
  const integrityPreimageKeys: Uint8Array[] = []
  const preAwsEvents: string[] = []
  const stderr: string[] = []
  const measuredConfiguration = createMeasuredConfiguration()
  const configurationBindingDigest =
    createWorkspaceSearchConfigurationHash(measuredConfiguration)
  const policy =
    parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
      ratePolicyBytes,
    )
  const baselineCollector = createSuccessfulCollectorResult(
    configurationBindingDigest,
  )
  if (baselineCollector.integrity.kind !== 'verified-result') {
    throw new Error('Expected verified collector fixture.')
  }
  const collectorResult = Object.freeze({
    ...baselineCollector,
    integrity: Object.freeze({
      ...baselineCollector.integrity,
      completedAt: adapterCompletedAt,
    }),
  })
  const derived = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
  const runtimeKeyDigest = derived.runtimeKeyDigest
  const publicationKeyDigest = derived.publicationKeyDigest
  const rateAuthenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      derived.runtimeKey,
    )
  const committedSegment = createCommittedRateSegment(
    successorBytes,
    rateAuthenticationKeyFingerprint,
  )
  const successorProof = createVerifiedRateSuccessor(
    committedSegment,
    policy.policyVersion,
    configurationBindingDigest,
    rateAuthenticationKeyFingerprint,
  )
  const durableEvidence = Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion: policy.policyVersion,
    attemptCount: 3,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  })
  derived.runtimeKey.fill(0)
  derived.publicationKey.fill(0)
  let requestedResourcesBinding: string | undefined
  let claimedStageHead: WorkspaceSearchMigrationRehearsalStageHead |
    undefined
  let measureCount = 0
  let collectorCount = 0
  let targetAuditCount = 0
  let finalizerCount = 0
  let outputCount = 0
  let sessionCloseCount = 0
  let runtimeCloseCount = 0
  let monotonicSample = 100
  const deadlineObservedAtMilliseconds = Date.parse(deadlineObservedAt)
  if (!Number.isSafeInteger(deadlineObservedAtMilliseconds)) {
    throw new Error('Expected canonical deadline fixture timestamp.')
  }
  const clockSamples = [
    new Date(deadlineObservedAtMilliseconds - 60_000).toISOString(),
    deadlineObservedAt,
    actualCompletedAt,
    ...(finalCompletedAt === undefined ? [] : [finalCompletedAt]),
  ]
  const session:
    WorkspaceSearchMigrationRehearsalReconciliationCliSession =
    Object.freeze({
      readRehearsalClaimedStageHead: () => claimedStageHead,
      scanTargetPage: () => Promise.reject(
        new Error('unexpected-target-page'),
      ),
      readRequestedResourcesBinding: () => {
        const binding = requestedResourcesBinding
        if (binding === undefined) throw new Error('missing-binding')
        return binding
      },
      readRehearsalEvidenceSessionBinding: () => {
        throw new Error('unexpected-session-binding')
      },
      measureConfiguration: () => {
        measureCount += 1
        return Promise.resolve(measuredConfiguration)
      },
      collectRehearsalReconciliation: (
        input: Parameters<
          WorkspaceSearchMigrationRehearsalReconciliationCliSession[
            'collectRehearsalReconciliation'
          ]
        >[0],
      ) => {
        collectorCount += 1
        input.clock()
        return Promise.resolve(collectorResult)
      },
      interruptDescribeTableRate: () => undefined,
      close: () => {
        sessionCloseCount += 1
        return Promise.resolve()
      },
      sealAndReadDescribeTableRateEvidence: () =>
        Promise.resolve(durableEvidence),
    })
  const dependencies:
    WorkspaceSearchMigrationRehearsalReconciliationCliDependencies =
    Object.freeze({
      readRestrictedFile: async (path) => {
        const source = sourceFiles.get(path)
        if (source === undefined) throw new Error('missing-test-file')
        const bytes = source.slice()
        returnedBuffers.push(bytes)
        return bytes
      },
      authenticateCollectionContext: (input) => {
        const binding = requestedResourcesBinding
        if (binding === undefined) throw new Error('missing-binding')
        const fixture = createAuthenticatedCollectionFixture(
          binding,
          configurationBindingDigest,
          policy.policyVersion,
          runtimeKeyDigest,
          publicationKeyDigest,
          collectorResult,
          mode,
          reservationExpiresAt,
        )
        claimedStageHead = fixture.claimedHead
        input.runtimeVerificationKey.fill(0)
        input.publicationVerificationKey.fill(0)
        return fixture.authentication
      },
      verifyPermit: (input) => {
        requestedResourcesBinding = input.requestedResourcesBinding
        return Object.freeze({
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
          permitVersion:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
          stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
          approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
          account: input.account,
          productionAccount: permitProductionAccount,
          region: input.region,
          callerArn:
            'arn:aws:sts::123456789012:assumed-role/rehearsal/operator',
          commit: input.commit,
          deploymentTargetId: permitDeploymentTargetId,
          deploymentTrustRootDigest: digest('deployment-trust-root'),
          requestedResourcesBinding: input.requestedResourcesBinding,
          configurationBindingDigest,
          policyVersion: policy.policyVersion,
          integrityResourceIdentityScheme:
            CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
          integrityResourceIdentities: cliIntegrityResourceIdentities,
          integrityResourceIdentityDigest: digest('integrity-resources'),
          evidenceKeyDigest: runtimeKeyDigest,
          publicationKeyDigest,
          integrityAttestationRoot:
            createIntegrityAttestationRootProjection(
              configurationBindingDigest,
              policy.policyVersion,
            ),
          issuedAt: '2026-08-02T00:00:00.000Z',
          expiresAt: '2026-08-02T01:00:00.000Z',
        })
      },
      authenticateIntegrityPreimage: (_input, key) => {
        preAwsEvents.push('authenticate-integrity-preimage')
        integrityPreimageKeys.push(key)
        if (targetIntegrityBefore === undefined) {
          throw new Error('unexpected-integrity-preimage-authentication')
        }
        return targetIntegrityBefore
      },
      createRateRuntime: () => {
        preAwsEvents.push('create-rate-runtime')
        return Promise.resolve(Object.freeze({
          recorder: Object.freeze({
            record: () => undefined,
            appendForfeitedAttempt: () => Promise.resolve(),
            appendForfeitedReservation: () => Promise.resolve(),
            flush: () => Promise.resolve(committedSegment),
            close: () => Promise.resolve(),
          }),
          flush: () => Promise.resolve(committedSegment),
          close: () => {
            runtimeCloseCount += 1
            return Promise.resolve()
          },
        }))
      },
      createSession: (input) => {
        preAwsEvents.push('create-session')
        const stageReservationClaim = input.stageReservationClaim
        if (stageReservationClaim === undefined) {
          throw new Error('missing-stage-reservation-claim')
        }
        stageKeys.push(stageReservationClaim.stageKey)
        return Promise.resolve(session)
      },
      verifyRateSegmentSuccessor: () => successorProof,
      collectTargetAudit: () => {
        preAwsEvents.push('collect-target-audit')
        targetAuditCount += 1
        return Promise.reject(new Error('unexpected-target-audit'))
      },
      finalizeTargetAudit: () => {
        throw new Error('unexpected-target-finalizer')
      },
      finalizeReconciliation: () => {
        finalizerCount += 1
        throw new Error('unexpected-reconciliation-finalizer')
      },
      ensureOutputAbsent: () => Promise.resolve(),
      writeOutputExclusive: async (): Promise<'created'> => {
        outputCount += 1
        return 'created'
      },
      clock: () => new Date(
        clockSamples.shift() ?? actualCompletedAt,
      ),
      monotonicClock: () => {
        const value = monotonicSample
        monotonicSample += 1
        return value
      },
      writeStdoutLine: () => {
        throw new Error('unexpected-stdout')
      },
      writeStderrLine: (line) => {
        stderr.push(line)
      },
    })

  const exitCode =
    await runWorkspaceSearchMigrationRehearsalReconciliationCli(
      mode === 'reconcile'
        ? createVerifiedArguments()
        : createTargetArguments(mode),
      dependencies,
    )
  return Object.freeze({
    exitCode,
    measureCount,
    collectorCount,
    targetAuditCount,
    finalizerCount,
    outputCount,
    sessionCloseCount,
    runtimeCloseCount,
    allReturnedBuffersZeroized: returnedBuffers.every((buffer) =>
      buffer.every((value) => value === 0)
    ),
    allStageKeysZeroized: stageKeys.length === 1 &&
      stageKeys.every((stageKey) =>
        stageKey.every((value) => value === 0)
      ),
    allIntegrityPreimageKeysZeroized:
      integrityPreimageKeys.length === (mode === 'target-preimage' ? 1 : 0) &&
      integrityPreimageKeys.every((key) =>
        key.every((value) => value === 0)
      ),
    preAwsEvents: Object.freeze([...preAwsEvents]),
    stderr: Object.freeze([...stderr]),
  })
}

/** Options for the authentication-failure dependency harness. */
type FailingContextDependencyOptions = {
  /** Stable source files copied on each read. */
  readonly sourceFiles: ReadonlyMap<string, Uint8Array>
  /** Every fresh buffer returned by the reader. */
  readonly returnedBuffers: Uint8Array[]
  /** Runtime keys transferred to the context verifier. */
  readonly contextRuntimeKeys: Uint8Array[]
  /** Publication keys transferred to the context verifier. */
  readonly contextPublicationKeys: Uint8Array[]
  /** Captured success lines. */
  readonly stdout: string[]
  /** Captured failure lines. */
  readonly stderr: string[]
  /** Digest of the master-derived runtime key. */
  readonly runtimeKeyDigest: string
  /** Digest of the master-derived publication key. */
  readonly publicationKeyDigest: string
  /** Exact measured configuration binding retained by the permit stub. */
  readonly configurationBindingDigest: string
  /** Exact parsed rate-policy digest. */
  readonly policyVersion: string
  /** Records an unexpected rate-runtime construction. */
  readonly incrementRuntime: () => void
  /** Records an unexpected AWS session construction. */
  readonly incrementSession: () => void
}

/** Creates dependencies that fail only at parent material authentication. */
function createFailingContextDependencies(
  options: FailingContextDependencyOptions,
): WorkspaceSearchMigrationRehearsalReconciliationCliDependencies {
  return Object.freeze({
    readRestrictedFile: async (path) => {
      const source = options.sourceFiles.get(path)
      if (source === undefined) throw new Error('missing-test-file')
      const bytes = source.slice()
      options.returnedBuffers.push(bytes)
      return bytes
    },
    authenticateCollectionContext: (input) => {
      options.contextRuntimeKeys.push(input.runtimeVerificationKey)
      options.contextPublicationKeys.push(input.publicationVerificationKey)
      throw new Error('raw-parent-authentication-canary')
    },
    verifyPermit: (input) => Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
      permitVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
      account: input.account,
      productionAccount: permitProductionAccount,
      region: input.region,
      callerArn:
        'arn:aws:sts::123456789012:assumed-role/rehearsal/operator',
      commit: input.commit,
      deploymentTargetId: permitDeploymentTargetId,
      deploymentTrustRootDigest: digest('deployment-trust-root'),
      requestedResourcesBinding: input.requestedResourcesBinding,
      configurationBindingDigest: options.configurationBindingDigest,
      policyVersion: options.policyVersion,
      integrityResourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      integrityResourceIdentities: cliIntegrityResourceIdentities,
      integrityResourceIdentityDigest: digest('integrity-resources'),
      evidenceKeyDigest: options.runtimeKeyDigest,
      publicationKeyDigest: options.publicationKeyDigest,
      integrityAttestationRoot:
        createIntegrityAttestationRootProjection(
          options.configurationBindingDigest,
          options.policyVersion,
        ),
      issuedAt: '2026-08-02T00:00:00.000Z',
      expiresAt: '2026-08-02T01:00:00.000Z',
    }),
    authenticateIntegrityPreimage: () => {
      throw new Error('unexpected-integrity-preimage-authentication')
    },
    createRateRuntime: async () => {
      options.incrementRuntime()
      throw new Error('unexpected-rate-runtime')
    },
    createSession: async () => {
      options.incrementSession()
      throw new Error('unexpected-session')
    },
    verifyRateSegmentSuccessor: () => {
      throw new Error('unexpected-rate-verification')
    },
    collectTargetAudit: async () => {
      throw new Error('unexpected-target-audit')
    },
    finalizeTargetAudit: () => {
      throw new Error('unexpected-target-finalizer')
    },
    finalizeReconciliation: () => {
      throw new Error('unexpected-reconciliation-finalizer')
    },
    ensureOutputAbsent: () => Promise.resolve(),
    writeOutputExclusive: () => Promise.reject(
      new Error('unexpected-output-write'),
    ),
    clock: () => new Date('2026-08-02T00:30:00.000Z'),
    monotonicClock: () => 1_000,
    writeStdoutLine: (line) => {
      options.stdout.push(line)
    },
    writeStderrLine: (line) => {
      options.stderr.push(line)
    },
  })
}

/** Creates dependencies whose only reachable effect rejects an existing output. */
function createRejectingOutputDependencies(
  recordRead: () => void,
  recordSession: () => void,
  stderr: string[],
): WorkspaceSearchMigrationRehearsalReconciliationCliDependencies {
  return Object.freeze({
    readRestrictedFile: () => {
      recordRead()
      return Promise.reject(new Error('unexpected-read'))
    },
    authenticateCollectionContext: () => {
      throw new Error('unexpected-authentication')
    },
    verifyPermit: () => {
      throw new Error('unexpected-permit')
    },
    authenticateIntegrityPreimage: () => {
      throw new Error('unexpected-integrity-preimage-authentication')
    },
    createRateRuntime: () => Promise.reject(new Error('unexpected-runtime')),
    createSession: () => {
      recordSession()
      return Promise.reject(new Error('unexpected-session'))
    },
    verifyRateSegmentSuccessor: () => {
      throw new Error('unexpected-rate-verification')
    },
    collectTargetAudit: () => Promise.reject(
      new Error('unexpected-target-audit'),
    ),
    finalizeTargetAudit: () => {
      throw new Error('unexpected-target-finalizer')
    },
    finalizeReconciliation: () => {
      throw new Error('unexpected-reconciliation-finalizer')
    },
    ensureOutputAbsent: () => Promise.reject(new Error('already-exists')),
    writeOutputExclusive: () => Promise.reject(
      new Error('unexpected-output-write'),
    ),
    clock: () => new Date('2026-08-02T00:30:00.000Z'),
    monotonicClock: () => 1_000,
    writeStdoutLine: () => {
      throw new Error('unexpected-stdout')
    },
    writeStderrLine: (line) => {
      stderr.push(line)
    },
  })
}

/** Authenticated collection fixture plus its exact remote claimed head. */
type AuthenticatedCollectionFixture = {
  /** Branded-boundary output injected into the CLI. */
  readonly authentication:
    WorkspaceSearchMigrationRehearsalAuthenticatedCollection
  /** Exact active head returned by the idempotent strong claim read. */
  readonly claimedHead: WorkspaceSearchMigrationRehearsalStageHead
}

/**
 * Creates mutually bound collection context, reservation, selection, and head.
 *
 * @param requestedResourcesBinding - Exact permit-approved resource binding.
 * @param configurationBindingDigest - Exact measured configuration digest.
 * @param policyVersion - Exact reviewed rate policy digest.
 * @param runtimeKeyDigest - Digest of the child-visible authentication key.
 * @param publicationKeyDigest - Digest of the parent-only publication key.
 * @param collectorResult - Matching terminal collector fixture.
 * @param mode - Collection mode selecting its exact stage command and terminal.
 * @param reservationExpiresAt - Exclusive authenticated reservation expiry.
 * @returns Complete authenticated boundary output and active durable head.
 */
function createAuthenticatedCollectionFixture(
  requestedResourcesBinding: string,
  configurationBindingDigest: string,
  policyVersion: string,
  runtimeKeyDigest: string,
  publicationKeyDigest: string,
  collectorResult: WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
  mode: WorkspaceSearchMigrationRehearsalReconciliationCliMode = 'reconcile',
  reservationExpiresAt = '2026-08-02T00:20:00.000Z',
): AuthenticatedCollectionFixture {
  const permitDigest = createMigrationDigest({ kind: 'permit' })
  const manifestDigest = digest('manifest')
  const previousStageReceiptDigest = digest('previous-stage-receipt')
  const scenario = mode === 'reconcile'
    ? 'happy-path-verified'
    : 'partial-apply-rollback'
  const command = mode === 'reconcile'
    ? 'verify'
    : mode === 'target-preimage'
    ? 'close-replan'
    : 'rollback-partial'
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
    requestedResourcesBinding,
    integrityResourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    integrityResourceIdentities: cliIntegrityResourceIdentities,
    integrityResourceIdentityDigest: digest('integrity-resources'),
    configurationBindingDigest,
    policyVersion,
    reviewedAt: '2026-08-02T00:00:00.000Z',
    entries: Object.freeze([entry]),
    manifestMac: digest('manifest-mac'),
  })
  const selection = Object.freeze({
    manifest,
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
      segmentOrdinal: entry.ordinal - 2,
      firstEventSequence: 1,
      eventCount: 0,
      firstCommittedEventSequence: null,
      lastCommittedEventSequence: null,
      terminalRecordMac: digest('claim-rate-predecessor-mac'),
      segmentDigest: digest('claim-rate-predecessor-segment'),
    }),
    expectedCurrentRateSegmentOrdinal: entry.ordinal - 1,
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
    commit: manifest.commit,
    requestedResourcesBinding,
    configurationBindingDigest,
    policyVersion,
    nonceDigest: digest('reservation-nonce'),
    reservedAt: '2026-08-02T00:00:00.000Z',
    expiresAt: reservationExpiresAt,
    reservationMac: digest('reservation-mac'),
  })
  const context = Object.freeze({
    runId: 'run-secret-canary',
    runLocatorDigest: digest('run-locator'),
    scenario: entry.scenario,
    command: entry.command,
    permitDigest,
    requestedResourcesBinding,
    configurationBindingDigest,
    policyVersion,
    manifestDigest,
    planningReceiptDigest: digest('planning-receipt'),
    executionBoundaryDigest: digest('execution-boundary'),
    sealedPlanningAuthorityDigest:
      collectorResult.context.sealedPlanningAuthorityDigest,
    planDigest: collectorResult.context.planDigest,
    writerFenceDigest: digest('writer-fence'),
    expectedAuthorities: Object.freeze([]),
    integrityWindow: Object.freeze({
      startedAt: '2026-08-02T00:00:00.000Z',
      completedAt: reservation.expiresAt,
    }),
    terminal: mode === 'target-restored'
      ? Object.freeze({
        scenario: 'partial-apply-rollback',
        kind: 'rolled-back',
        version: 2,
        rootDigest: digest('partial-rollback-root'),
        applyStartedAt: '2026-08-02T00:02:00.000Z',
        terminalAt: '2026-08-02T00:05:00.000Z',
      })
      : null,
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

/** Creates the exact successful collector result retained until close. */
function createSuccessfulCollectorResult(
  configurationBindingDigest: string,
): WorkspaceSearchMigrationRehearsalReconciliationCollectorResult {
  const terminalRootDigest = digest('verified-terminal-root')
  return Object.freeze({
    context: Object.freeze({
      scenario: 'happy-path-verified',
      runLocatorDigest: digest('run-locator'),
      configurationBindingDigest,
      sealedPlanningAuthorityDigest: digest('sealed-planning-authority'),
      executionRunDigest: digest('execution-run'),
      planDigest: digest('plan'),
      applyBoundaryDigest: digest('apply-boundary'),
      terminalRootKind: 'verified',
      terminalRootVersion: 1,
      terminalRootDigest,
      sealedPlanOperationCount: 1,
      appliedOperationCount: 1,
      terminalAt: '2026-08-02T00:05:00.000Z',
      checkedAt: '2026-08-02T00:09:45.000Z',
    }),
    integrity: Object.freeze({
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt: '2026-08-02T00:09:30.000Z',
      result: Object.freeze({
        checkedAt: '2026-08-02T00:09:29.000Z',
        contentDigest: digest('integrity-content'),
        byteLength: 128,
        resultDigest: digest('integrity-result'),
        resultMac: digest('integrity-mac'),
        runtimeProvenance: Object.freeze({
          kind:
            'mukuroji-cross-domain-integrity-rehearsal-live-provenance',
          version: 1,
          mode: 'migration-rehearsal-live',
          startedAt: '2026-08-02T00:09:28.000Z',
          completedAt: '2026-08-02T00:09:29.000Z',
          checkedAtSource: 'trusted-wall-clock-after-external-reads',
        }),
        integrityAggregateDigest: digest('integrity-aggregate'),
        resourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        resourceIdentities: cliIntegrityResourceIdentities,
        resourceIdentityDigest: digest('integrity-resources'),
      }),
      terminalRootDigest,
      integrityAggregateDigest: digest('integrity-aggregate'),
    }),
    targetAudits: null,
    markerSummary: Object.freeze({
      expectedCount: 1,
      expectedAggregateDigest: digest('expected-marker-aggregate'),
      observedCount: 1,
      observedAggregateDigest: digest('expected-marker-aggregate'),
      matchedCount: 1,
      duplicateCount: 0,
      missingCount: 0,
      unexpectedCount: 0,
    }),
    authoritySummary: Object.freeze({
      expectedChainDigest: digest('expected-authority-chain'),
      observedChainDigest: digest('expected-authority-chain'),
      expectedCount: 0,
      observedCount: 0,
      matchedCount: 0,
      missingCount: 0,
      orphanCount: 0,
    }),
    sourceTargetSummary: Object.freeze({
      expectedAggregateDigest: digest('expected-target-aggregate'),
      observedAggregateDigest: digest('expected-target-aggregate'),
      expectedCount: 1,
      observedCount: 1,
      matchedCount: 1,
      lostCount: 0,
      unexpectedCount: 0,
    }),
  })
}

/** Creates one fake committed successor whose bytes are independently reread. */
function createCommittedRateSegment(
  canonicalBytes: Uint8Array,
  authenticationKeyFingerprint: string,
): WorkspaceSearchMigrationRehearsalRateCommittedSegment {
  return Object.freeze({
    authenticationKeyFingerprint,
    segmentLocatorDigest: digest('successor-segment-locator'),
    segmentOrdinal: 1,
    firstEventSequence: 3,
    eventCount: 1,
    firstCommittedEventSequence: 3,
    lastCommittedEventSequence: 3,
    terminalRecordMac: digest('successor-terminal-mac'),
    segmentDigest: digest('successor-segment'),
    canonicalBytes: canonicalBytes.slice(),
  })
}

/** Creates the structural successor proof returned by the injected verifier. */
function createVerifiedRateSuccessor(
  committed: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  policyVersion: string,
  configurationBindingDigest: string,
  authenticationKeyFingerprint: string,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor {
  const predecessor = Object.freeze({
    authenticationKeyFingerprint,
    segmentLocatorDigest: digest('predecessor-segment-locator'),
    segmentOrdinal: 0,
    firstEventSequence: 1,
    eventCount: 2,
    firstCommittedEventSequence: 1,
    lastCommittedEventSequence: 2,
    terminalRecordMac: digest('predecessor-terminal-mac'),
    segmentDigest: digest('predecessor-segment'),
  })
  return Object.freeze({
    authenticationKeyFingerprint,
    predecessor,
    successor: Object.freeze({
      authenticationKeyFingerprint,
      segmentLocatorDigest: committed.segmentLocatorDigest,
      segmentOrdinal: committed.segmentOrdinal,
      firstEventSequence: committed.firstEventSequence,
      eventCount: committed.eventCount,
      firstCommittedEventSequence: committed.firstCommittedEventSequence,
      lastCommittedEventSequence: committed.lastCommittedEventSequence,
      terminalRecordMac: committed.terminalRecordMac,
      segmentDigest: committed.segmentDigest,
    }),
    link: Object.freeze({
      previousSegmentDigest: predecessor.segmentDigest,
      previousRecordMac: predecessor.terminalRecordMac,
      firstEventSequence: 3,
      policyVersion,
      configurationBindingDigest,
    }),
  })
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

/** Encodes one canonical JSON value into exact UTF-8 bytes. */
function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/** Creates one lowercase SHA-256 fixture digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/**
 * Mints one genuine live #163 capability for a target-preimage CLI test.
 *
 * @param checkedAt - Canonical completion time of the live result.
 * @returns One-shot authenticated preimage authority.
 */
async function createCliIntegrityPreimageCapability(
  checkedAt = '2026-08-02T00:00:00.000Z',
): Promise<WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability> {
  const result = await runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    deadline: createCrossDomainIntegrityInvocationDeadline({
      maximumDurationMilliseconds: 60_000,
      monotonicClock: () => 1_000,
    }),
    role: 'source',
    checkedAt,
    observationMode: 'migration-rehearsal-live',
    liveRuntimeObservation: {
      startedAt: new Date(Date.parse(checkedAt) - 1_000).toISOString(),
      completedAt: checkedAt,
    },
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    digestKey: cliIntegrityDigestKey,
    resourceBindingDigest:
      calculateCrossDomainIntegrityResourceBindingDigest(),
    resourceIdentities: cliIntegrityResourceIdentities,
    resourceIdentityDigest: cliIntegrityResourceIdentityDigest,
    limits: {
      pageSize: 100,
      maxPages: 10,
      maxItems: 1_000,
    },
    reader: {
      readPage: async () => ({ items: [] }),
    },
  })
  return authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
    {
      resultBytes: new TextEncoder().encode(
        `${JSON.stringify(result, undefined, 2)}\n`,
      ),
      expectedResourceIdentityDigest: cliIntegrityResourceIdentityDigest,
      clock: () => new Date(checkedAt),
    },
    new Uint8Array(cliIntegrityDigestKey),
  )
}
