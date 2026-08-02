import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence,
  createWorkspaceSearchMigrationRehearsalLocatorDigest,
  createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest,
  createWorkspaceSearchMigrationRehearsalStageManifest,
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  deriveWorkspaceSearchMigrationRehearsalStageChainEvidence,
  parseWorkspaceSearchMigrationRehearsalStageManifestDocument,
  readWorkspaceSearchMigrationRehearsalFinalizedStageChainIntegrityWindows,
  readWorkspaceSearchMigrationRehearsalFinalizedStageChainReconciliationContexts,
  selectWorkspaceSearchMigrationRehearsalStage,
  verifyWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_STAGE_CHAIN_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  WorkspaceSearchMigrationRehearsalStageReceiptError,
  type WorkspaceSearchMigrationRehearsalFaultStageEvidence,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageEvidence,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestClaims,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
  type WorkspaceSearchMigrationRehearsalStageReceiptClaims,
} from './migration-rehearsal-stage-receipt'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import type {
  WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-fault-observation'
import type {
  WorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding,
  WorkspaceSearchMigrationRehearsalVerifiedIntegrityCollectorResult,
} from './migration-rehearsal-reconciliation-audit'

/** Fault scenarios that require a confirmed SIGKILL and lease takeover. */
const sigkillTakeoverScenarios: readonly WorkspaceSearchMigrationRehearsalScenarioName[] = [
  'cursor-before-commit-kill',
  'cursor-after-commit-kill',
  'artifact-before-checkpoint-kill',
  'lease-expiry-takeover',
  'partial-apply-rollback',
]

/** Creates the canonical #163 physical identity vector for one namespace. */
function fixtureIntegrityResourceIdentities(namespace: string) {
  return CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target) => ({
    target,
    identityDigest: digest(`${namespace}:${target}`),
  }))
}

/** One concise reviewed fixture stage before global ordinals are assigned. */
type FixtureStage = {
  /** Exact existing control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Expected authenticated process result. */
  readonly outcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Whether this entry carries the scenario's reviewed fault plan. */
  readonly fault: boolean
  /** One-based logical process attempt. */
  readonly attemptOrdinal: number
}

/** Complete authenticated fixture returned to focused chain tests. */
type CompleteFixture = {
  /** Dedicated main evidence key. */
  readonly key: Uint8Array
  /** Exact authenticated reviewed manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Every exact authenticated stage receipt in global order. */
  readonly receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[]
}

/** Returns one deterministic conventional digest. */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/** Returns one canonical deterministic UTC timestamp. */
function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString()
}

/** Returns the exact reviewed stage shape for one required scenario. */
function fixtureStages(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): readonly FixtureStage[] {
  const completed = (
    command: WorkspaceSearchMigrationRehearsalStageCommand,
    attemptOrdinal: number,
  ): FixtureStage => ({
    command,
    outcome: 'completed',
    fault: false,
    attemptOrdinal,
  })
  if (scenario === 'happy-path-verified') {
    return [
      completed('close-replan', 1),
      completed('apply', 1),
      completed('verify', 1),
      completed('release', 1),
    ]
  }
  if (scenario === 'complete-apply-rollback') {
    return [
      completed('close-replan', 1),
      completed('apply', 1),
      completed('rollback-complete', 1),
      completed('release', 1),
    ]
  }
  if (scenario === 'partial-apply-rollback') {
    return [
      completed('close-replan', 1),
      {
        command: 'apply',
        outcome: 'fault-reached',
        fault: true,
        attemptOrdinal: 1,
      },
      {
        command: 'rollback-partial',
        outcome: 'takeover-completed',
        fault: false,
        attemptOrdinal: 2,
      },
      completed('release', 2),
    ]
  }
  if (scenario === 'transaction-response-loss') {
    return [
      {
        command: 'close-replan',
        outcome: 'response-loss-reconciled',
        fault: true,
        attemptOrdinal: 1,
      },
      completed('apply', 1),
      completed('verify', 1),
      completed('release', 1),
    ]
  }
  const faultCommand =
    scenario === 'artifact-before-checkpoint-kill' ||
      scenario === 'lease-expiry-takeover'
      ? 'close-replan'
      : 'apply'
  const stages: FixtureStage[] = []
  if (faultCommand === 'apply') stages.push(completed('close-replan', 1))
  stages.push({
    command: faultCommand,
    outcome: 'fault-reached',
    fault: true,
    attemptOrdinal: 1,
  })
  stages.push({
    command: faultCommand,
    outcome: 'takeover-completed',
    fault: false,
    attemptOrdinal: 2,
  })
  if (faultCommand === 'close-replan') stages.push(completed('apply', 2))
  stages.push(completed('verify', 2), completed('release', 2))
  return stages
}

/** Creates the complete explicit reviewed manifest claims. */
function createManifestClaims(): WorkspaceSearchMigrationRehearsalStageManifestClaims {
  const entries: WorkspaceSearchMigrationRehearsalStageManifestEntry[] = []
  let ordinal = 1
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const stages = fixtureStages(scenario)
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]
      if (stage === undefined) throw new Error('fixture stage missing')
      const controlArguments = fixtureControlArguments(
        scenario,
        index + 1,
        stage.command,
      )
      entries.push(Object.freeze({
        ordinal,
        scenario,
        scenarioStageOrdinal: index + 1,
        command: stage.command,
        controlArgumentsDigest: createMigrationDigest(controlArguments),
        attemptOrdinal: stage.attemptOrdinal,
        faultPlanDigest: stage.fault
          ? digest(`fault-plan-${scenario}`)
          : null,
        expectedOutcome: stage.outcome,
      }))
      ordinal += 1
    }
  }
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
    manifestVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
    stage: 'non-production',
    commit: 'a'.repeat(40),
    permitDigest: digest('permit'),
    evidenceKeyDigest: digest('runtime-key'),
    publicationKeyDigest: digest('publication-key'),
    deploymentTrustRootDigest: digest('deployment-trust-root'),
    requestedResourcesBinding: digest('resources'),
    integrityResourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    integrityResourceIdentities:
      fixtureIntegrityResourceIdentities('integrity-resource-vector'),
    integrityResourceIdentityDigest: digest('integrity-resource-identity'),
    configurationBindingDigest: digest('configuration'),
    policyVersion: digest('policy'),
    reviewedAt: timestamp(0),
    entries: Object.freeze(entries),
  })
}

/** Returns exact arguments bound by one reviewed manifest entry. */
function fixtureControlArguments(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  scenarioStageOrdinal: number,
  command: WorkspaceSearchMigrationRehearsalStageCommand,
): readonly string[] {
  return Object.freeze([
    command,
    '--fixture-stage',
    `${scenario}-${scenarioStageOrdinal}`,
  ])
}

/** Maps one fault scenario to its exact runtime failpoint. */
function fixtureFailpoint(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence['failpoint'] {
  switch (scenario) {
    case 'cursor-before-commit-kill':
      return 'apply-checkpoint-cursor-captured-before-commit'
    case 'cursor-after-commit-kill':
      return 'apply-checkpoint-cursor-committed-before-return'
    case 'artifact-before-checkpoint-kill':
      return 'planning-page-artifact-uploaded-before-checkpoint-commit'
    case 'transaction-response-loss':
      return 'planning-page-transaction-response-lost'
    case 'lease-expiry-takeover':
      return 'lease-acquired-before-first-heartbeat'
    case 'partial-apply-rollback':
      return 'apply-operation-committed-before-return'
    case 'complete-apply-rollback':
    case 'happy-path-verified':
      throw new Error('unfaulted fixture scenario')
  }
}

/**
 * Creates a complete secret-free durable observation for one fault fixture.
 *
 * @param scenario - Canonical fault scenario.
 * @param leaseIdentityDigest - Lease generation authorizing the observation.
 * @returns Exact failpoint-specific normalized adapter observation.
 */
function createFaultObservation(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  leaseIdentityDigest: string,
): WorkspaceSearchMigrationRehearsalFaultObservation {
  const failpoint = fixtureFailpoint(scenario)
  const common = {
    leaseIdentityDigest,
  }
  if (
    failpoint ===
      'planning-page-artifact-uploaded-before-checkpoint-commit' ||
    failpoint === 'planning-page-transaction-response-lost'
  ) {
    const committed =
      failpoint === 'planning-page-transaction-response-lost'
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'planning-page',
      failpoint,
      durableAppliedOperationCount: 0,
      sealedPlanOperationCount: null,
      closedWriterFenceRecordDigest: digest(`closed-fence-${scenario}`),
      durableHeadPosition: committed ? 'committed-successor' : 'predecessor',
      durableHeadPageSequence: committed ? 2 : 1,
      durableHeadEvidenceDigest: digest(`fault-head-evidence-${scenario}`),
      durableHeadCheckpointDigest:
        digest(`fault-head-checkpoint-${scenario}`),
      durableHeadProgressDigest: digest(`fault-head-progress-${scenario}`),
      durableHeadCursorState: 'present',
      durableHeadCompleted: false,
      planningTarget: Object.freeze({
        kind: 'source',
        source: 'documents',
        pageSequence: 2,
        cursorState: 'present',
      }),
    })
  }
  if (
    failpoint === 'apply-checkpoint-cursor-captured-before-commit' ||
    failpoint === 'apply-checkpoint-cursor-committed-before-return'
  ) {
    const committed =
      failpoint === 'apply-checkpoint-cursor-committed-before-return'
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'apply-checkpoint',
      failpoint,
      durableAppliedOperationCount: 3,
      sealedPlanOperationCount: 3,
      closedWriterFenceRecordDigest: digest(`closed-fence-${scenario}`),
      checkpointLocation: 'documents',
      durableStatePosition: committed ? 'committed-successor' : 'predecessor',
      durableStateRevision: 7,
      durableStateStatus: 'applying',
      durableRunStateDigest: digest(`fault-run-state-${scenario}`),
      durableCheckpointDigest: digest(`fault-checkpoint-${scenario}`),
      durableCheckpointPageSequence: committed ? 2 : 1,
      durableCheckpointCursorState: 'present',
      durableCheckpointCompleted: false,
    })
  }
  if (failpoint === 'apply-operation-committed-before-return') {
    const runStateDigest = digest(`fault-run-state-${scenario}`)
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'apply-operation',
      failpoint,
      durableAppliedOperationCount: 1,
      sealedPlanOperationCount: 3,
      closedWriterFenceRecordDigest: digest(`closed-fence-${scenario}`),
      returnedStateRevision: 7,
      returnedRunStateDigest: runStateDigest,
      returnedAppliedOperationCount: 1,
      returnedSealedPlanOperationCount: 3,
      durableStateRevision: 7,
      durableStateStatus: 'applying',
      durableRunStateDigest: runStateDigest,
    })
  }
  if (failpoint !== 'lease-acquired-before-first-heartbeat') {
    throw new Error('Expected a fault observation fixture.')
  }
  return Object.freeze({
    ...common,
    observationVersion: 1,
    kind: 'lease',
    failpoint,
    durableAppliedOperationCount: 0,
    sealedPlanOperationCount: null,
    closedWriterFenceRecordDigest: null,
  })
}

/**
 * Creates exact cursor-free fault evidence for one scenario.
 *
 * @param scenario - Canonical fault scenario.
 * @param baseSecond - Deterministic fixture time origin.
 * @param leaseIdentityDigest - Current lease identity at the boundary.
 * @returns Frozen safe fault evidence.
 */
function createFaultEvidence(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  baseSecond: number,
  leaseIdentityDigest: string,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence {
  const failpoint = fixtureFailpoint(scenario)
  const planningFault =
    failpoint ===
      'planning-page-artifact-uploaded-before-checkpoint-commit' ||
    failpoint === 'planning-page-transaction-response-lost' ||
    failpoint === 'lease-acquired-before-first-heartbeat'
  const faultObservation = createFaultObservation(
    scenario,
    leaseIdentityDigest,
  )
  return Object.freeze({
    kind: 'fault-boundary',
    failpoint,
    targetDigest: digest(`target-${scenario}`),
    faultReceiptDigest: digest(`fault-receipt-${scenario}`),
    faultObservationDigest: createMigrationDigest(faultObservation),
    faultObservation,
    leaseIdentityDigest,
    appliedOperationCount: planningFault
      ? 0
      : failpoint === 'apply-operation-committed-before-return'
      ? 1
      : 3,
    sealedPlanOperationCount: planningFault ? null : 3,
    targetPreimageArtifactContentDigest:
      failpoint === 'apply-operation-committed-before-return'
        ? digest(`target-preimage-${scenario}`)
        : null,
    reachedAt: timestamp(baseSecond + 4),
  })
}

/** Creates one exact digest-only #163 result binding for a terminal fixture. */
function createReconciliationIntegrityResult(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  label: 'after' | 'before' | 'verified',
  checkedAt: string,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding {
  return Object.freeze({
    checkedAt,
    contentDigest: digest(`integrity-content-${scenario}-${label}`),
    byteLength: 128,
    resultDigest: digest(`integrity-result-${scenario}-${label}`),
    resultMac: digest(`integrity-mac-${scenario}-${label}`),
    runtimeProvenance: Object.freeze({
      kind:
        'mukuroji-cross-domain-integrity-rehearsal-live-provenance',
      version: 1,
      mode: 'migration-rehearsal-live',
      startedAt: checkedAt,
      completedAt: checkedAt,
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    }),
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    resourceIdentities:
      fixtureIntegrityResourceIdentities('integrity-resource-vector'),
    integrityAggregateDigest: digest(`integrity-aggregate-${scenario}`),
    resourceIdentityDigest: digest('integrity-resource-identity'),
  })
}

/** Creates one deterministic verified rate summary for an auxiliary link. */
function createVerifiedRateSegment(
  template: WorkspaceSearchMigrationRehearsalStageReceiptClaims['rateSegment'],
  segmentOrdinal: number,
  label: string,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const firstSequence = template.firstEventSequence + template.eventCount
  return Object.freeze({
    authenticationKeyFingerprint: template.authenticationKeyFingerprint,
    segmentLocatorDigest: digest(`aux-rate-locator-${label}`),
    segmentOrdinal,
    firstEventSequence: firstSequence,
    eventCount: 1,
    firstCommittedEventSequence: firstSequence,
    lastCommittedEventSequence: firstSequence,
    terminalRecordMac: digest(`aux-rate-mac-${label}`),
    segmentDigest: digest(`aux-rate-segment-${label}`),
  })
}

/** Creates one strict auxiliary rate binding from an immediate predecessor. */
function createAuxiliaryRateEvidence(
  predecessor: WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
  successorOrdinal: number,
  label: string,
  completedAt: string,
): WorkspaceSearchMigrationRehearsalRateSegmentEvidence {
  const successor = createVerifiedRateSegment(
    predecessor,
    successorOrdinal,
    label,
  )
  const aggregate = Object.freeze({
    version: 1,
    policyVersion: digest('policy'),
    attemptCount: 1,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  })
  return Object.freeze({
    authenticationKeyFingerprint: predecessor.authenticationKeyFingerprint,
    predecessor,
    successor,
    link: Object.freeze({
      previousSegmentDigest: predecessor.segmentDigest,
      previousRecordMac: predecessor.terminalRecordMac,
      firstEventSequence: successor.firstCommittedEventSequence ?? 1,
      policyVersion: digest('policy'),
      configurationBindingDigest: digest('configuration'),
    }),
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    completedAt,
  })
}

/**
 * Creates one strict parent-authenticated reconciliation expectation.
 *
 * @param scenario - Canonical fixture scenario.
 * @param baseSecond - Terminal stage deterministic time origin.
 * @param applyBoundaryDigest - Exact admitted applied root or prefix origin.
 * @returns Complete context accepted by the shared strict snapshot boundary.
 */
function createReconciliationContext(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  baseSecond: number,
  applyBoundaryDigest: string,
  terminalRate:
    WorkspaceSearchMigrationRehearsalStageReceiptClaims['rateSegment'],
): WorkspaceSearchMigrationRehearsalReconciliationAuditContext {
  const rollback = scenario === 'partial-apply-rollback' ||
    scenario === 'complete-apply-rollback'
  const partial = scenario === 'partial-apply-rollback'
  const core: WorkspaceSearchMigrationRehearsalReconciliationCoreContext =
    Object.freeze({
      scenario,
      runLocatorDigest: digest(`run-${scenario}`),
      configurationBindingDigest: digest('configuration'),
      sealedPlanningAuthorityDigest: digest(`authority-${scenario}`),
      executionRunDigest: digest(`execution-${scenario}`),
      planDigest: digest(`plan-${scenario}`),
      applyBoundaryDigest,
      terminalRootKind: rollback ? 'rolled-back' : 'verified',
      terminalRootVersion: partial ? 2 : 1,
      terminalRootDigest: digest(`terminal-${scenario}`),
      sealedPlanOperationCount: 3,
      appliedOperationCount: partial ? 1 : 3,
      terminalAt: timestamp(baseSecond + 6),
      checkedAt: timestamp(baseSecond + 8),
    })
  const migrationContextDigest = createMigrationDigest({
    kind:
      'workspace-search-migration-rehearsal-terminal-integrity-migration-context',
    version: 1,
    ...core,
  })
  if (!rollback) {
    const result = createReconciliationIntegrityResult(
      scenario,
      'verified',
      timestamp(baseSecond + 7),
    )
    const fields:
      WorkspaceSearchMigrationRehearsalVerifiedIntegrityCollectorResult =
        Object.freeze({
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt: timestamp(baseSecond + 8),
      result,
      terminalRootDigest: core.terminalRootDigest,
      integrityAggregateDigest: digest(`integrity-aggregate-${scenario}`),
        })
    return Object.freeze({
      ...core,
      integrity: Object.freeze({
        ...fields,
        resultContextDigest: createMigrationDigest({
          domain:
            'workspace-search-migration-rehearsal-terminal-integrity-result-context',
          version: 1,
          scenario,
          migrationContextDigest,
          ...fields,
        }),
        migrationContextDigest,
      }),
      targetAudits: null,
    })
  }
  const purpose = partial ? 'partial-rollback' : 'complete-rollback'
  const before = createReconciliationIntegrityResult(
    scenario,
    'before',
    timestamp(baseSecond - 152),
  )
  const after = createReconciliationIntegrityResult(
    scenario,
    'after',
    timestamp(baseSecond + 7),
  )
  const startedAt = timestamp(baseSecond - 153)
  const applyStartedAt = timestamp(baseSecond - 148)
  const terminalAt = timestamp(baseSecond + 6)
  const completedAt = timestamp(baseSecond + 8)
  const comparisonDigest = createMigrationDigest({
    purpose,
    beforeResultDigest: before.resultDigest,
    afterResultDigest: after.resultDigest,
    comparison: {
      kind:
        'mukuroji-cross-domain-integrity-migration-rehearsal-comparison',
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      status: 'pass',
    },
  })
  const targetAggregateDigest = digest(`target-aggregate-${scenario}`)
  const preimagePredecessor = createVerifiedRateSegment(
    terminalRate,
    terminalRate.segmentOrdinal - 2,
    `${scenario}-preimage-predecessor`,
  )
  const preimageRate = createAuxiliaryRateEvidence(
    preimagePredecessor,
    terminalRate.segmentOrdinal - 1,
    `${scenario}-preimage`,
    timestamp(baseSecond - 149),
  )
  const restoredRate = createAuxiliaryRateEvidence(
    terminalRate,
    terminalRate.segmentOrdinal + 1,
    `${scenario}-restored`,
    timestamp(baseSecond + 8),
  )
  const targetContextDigest = digest(`target-context-${scenario}`)
  return Object.freeze({
    ...core,
    integrity: Object.freeze({
      kind: 'rollback-comparison',
      purpose,
      status: 'pass',
      failureCount: 0,
      startedAt,
      applyStartedAt,
      terminalAt,
      completedAt,
      before,
      after,
      comparisonDigest,
      comparisonContextDigest: createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-integrity-context',
        version: 1,
        purpose,
        startedAt,
        applyStartedAt,
        terminalAt,
        completedAt,
        before,
        after,
        comparisonDigest,
      }),
      terminalRootDigest: core.terminalRootDigest,
      targetPreimageAggregateDigest: targetAggregateDigest,
      targetRestoredAggregateDigest: targetAggregateDigest,
      targetPreimageStatus: 'equal',
      migrationContextDigest,
    }),
    targetAudits: Object.freeze({
      preimage: Object.freeze({
        purpose: `${purpose}-preimage`,
        contentDigest: digest(`target-preimage-${scenario}`),
        byteLength: 256,
        startedAt: timestamp(baseSecond - 151),
        observedAt: timestamp(baseSecond - 150),
        observationDigest: digest(`target-preimage-observation-${scenario}`),
        aggregateDigest: targetAggregateDigest,
        integrityBefore: before,
        contextDigest: targetContextDigest,
        rate: preimageRate,
      }),
      restored: Object.freeze({
        purpose: `${purpose}-restored`,
        contentDigest: digest(`target-rollback-${scenario}`),
        byteLength: 257,
        startedAt: timestamp(baseSecond + 7),
        observedAt: timestamp(baseSecond + 7),
        observationDigest: digest(`target-observation-${scenario}`),
        aggregateDigest: targetAggregateDigest,
        integrityBefore: null,
        contextDigest: targetContextDigest,
        rate: restoredRate,
      }),
    }),
  })
}

/**
 * Creates one exact trusted durable stage evidence projection.
 *
 * @param entry - Reviewed manifest entry owning the evidence.
 * @param baseSecond - Deterministic stage time origin.
 * @param previousReceipt - Immediate predecessor supplying apply evidence.
 * @returns Frozen stage evidence matching the reviewed command.
 */
function createStageEvidence(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  baseSecond: number,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
  terminalRate:
    WorkspaceSearchMigrationRehearsalStageReceiptClaims['rateSegment'],
): WorkspaceSearchMigrationRehearsalStageEvidence {
  const scenario = entry.scenario
  const commonPlan = {
    planDigest: digest(`plan-${scenario}`),
    sealedPlanOperationCount: 3,
  }
  if (entry.command === 'close-replan') {
    return Object.freeze({
      kind: 'planning-sealed',
      executionBoundaryDigest: digest(`boundary-${scenario}`),
      closedWriterFenceRecordDigest: digest(`closed-fence-${scenario}`),
      sealedPlanningAuthorityDigest: digest(`authority-${scenario}`),
      ...commonPlan,
      sourceOperationCount: 2,
      orphanOperationCount: 1,
      closedAt: timestamp(baseSecond + 2),
      drainStartedAt: timestamp(baseSecond + 3),
      drainCompletedAt: timestamp(baseSecond + 4),
      admittedAt: timestamp(baseSecond + 5),
      planCreatedAt: timestamp(baseSecond + 6),
      sealedAt: timestamp(baseSecond + 7),
    })
  }
  if (entry.command === 'apply') {
    return Object.freeze({
      kind: 'apply-complete',
      executionRunDigest: digest(`execution-${scenario}`),
      ...commonPlan,
      appliedOperationCount: 3,
      appliedRootDigest: digest(`applied-${scenario}`),
      targetPreimageArtifactContentDigest:
        scenario === 'complete-apply-rollback'
          ? digest(`target-preimage-${scenario}`)
          : null,
      appliedAt: timestamp(baseSecond + 6),
    })
  }
  if (entry.command === 'release') {
    return Object.freeze({
      kind: 'released',
      terminalKind: scenario === 'happy-path-verified' ||
          !scenario.includes('rollback')
        ? 'verified'
        : 'rolled-back',
      terminalPersistenceVersion:
        scenario === 'partial-apply-rollback' ? 2 : 1,
      terminalRootDigest: digest(`terminal-${scenario}`),
      releasedWriterFenceRecordDigest: digest(`released-fence-${scenario}`),
      releasedAt: timestamp(baseSecond + 6),
    })
  }
  const integrityPurpose = scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : scenario === 'complete-apply-rollback'
    ? 'complete-rollback'
    : 'verified'
  const rollback = entry.command !== 'verify'
  const targetPreimageArtifactContentDigest = rollback
    ? digest(`target-preimage-${scenario}`)
    : null
  const targetRollbackArtifactContentDigest = rollback
    ? digest(`target-rollback-${scenario}`)
    : null
  const targetRollbackObservationDigest = rollback
    ? digest(`target-observation-${scenario}`)
    : null
  const terminalRootDigest = digest(`terminal-${scenario}`)
  if (previousReceipt === undefined) {
    throw new Error('Expected terminal predecessor fixture.')
  }
  const applyBoundaryDigest = entry.command === 'rollback-partial'
    ? digest(`partial-origin-${scenario}`)
    : previousReceipt.evidence.kind === 'apply-complete'
    ? previousReceipt.evidence.appliedRootDigest
    : (() => {
        throw new Error('Expected complete applied-root evidence fixture.')
      })()
  const reconciliationContext = createReconciliationContext(
    scenario,
    baseSecond,
    applyBoundaryDigest,
    terminalRate,
  )
  const integrityBeforeResultDigest =
    reconciliationContext.integrity.kind === 'rollback-comparison'
      ? reconciliationContext.integrity.before.resultDigest
      : null
  const integrityAfterResultDigest =
    reconciliationContext.integrity.kind === 'rollback-comparison'
      ? reconciliationContext.integrity.after.resultDigest
      : reconciliationContext.integrity.result.resultDigest
  const integrityComparisonDigest =
    reconciliationContext.integrity.kind === 'rollback-comparison'
      ? reconciliationContext.integrity.comparisonDigest
      : null
  const integrityContextDigest =
    reconciliationContext.integrity.kind === 'rollback-comparison'
      ? reconciliationContext.integrity.comparisonContextDigest
      : reconciliationContext.integrity.resultContextDigest
  const reconciliationPredecessor = reconciliationContext.targetAudits === null
    ? terminalRate
    : reconciliationContext.targetAudits.restored.rate.successor
  const reconciliationRate = createAuxiliaryRateEvidence(
    reconciliationPredecessor,
    reconciliationPredecessor.segmentOrdinal + 1,
    `${scenario}-reconciliation`,
    timestamp(baseSecond + 9),
  )
  return Object.freeze({
    kind: 'terminal',
    command: entry.command,
    terminalKind: rollback ? 'rolled-back' : 'verified',
    terminalPersistenceVersion:
      entry.command === 'rollback-partial' ? 2 : 1,
    terminalRootDigest,
    executionBoundaryDigest: digest(`boundary-${scenario}`),
    sealedPlanningAuthorityDigest: digest(`authority-${scenario}`),
    executionRunDigest: digest(`execution-${scenario}`),
    ...commonPlan,
    appliedOperationCount:
      entry.command === 'rollback-partial' ? 1 : 3,
    integrityPurpose,
    integrityBeforeResultDigest,
    integrityAfterResultDigest,
    integrityComparisonDigest,
    integrityContextDigest,
    targetRollbackArtifactContentDigest,
    targetRollbackObservationDigest,
    duplicateApplyCount: 0,
    lostItemCount: 0,
    orphanAuthorityCount: 0,
    reconciliationContext,
    reconciliationArtifactBindingDigest:
      digest(`reconciliation-binding-${scenario}`),
    reconciliationArtifactContentDigest:
      digest(`reconciliation-content-${scenario}`),
    reconciliationArtifactByteLength: 4_096,
    reconciliationArtifactAuditDigest:
      digest(`reconciliation-audit-${scenario}`),
    reconciliationRate,
    reconciliationAuditDigest:
      createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest({
        scenario,
        terminalRootDigest,
        integrityContextDigest,
        targetPreimageArtifactContentDigest,
        targetRollbackArtifactContentDigest,
        targetRollbackObservationDigest,
        duplicateApplyCount: 0,
        lostItemCount: 0,
        orphanAuthorityCount: 0,
      }),
    terminalAt: timestamp(baseSecond + 6),
  })
}

/** Creates one exact trusted parent lifecycle for a stage. */
function createProcessLifecycle(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  baseSecond: number,
): WorkspaceSearchMigrationRehearsalStageReceiptClaims['processLifecycle'] {
  const responseLoss = entry.expectedOutcome === 'response-loss-reconciled'
  const killed = entry.expectedOutcome === 'fault-reached'
  return Object.freeze({
    lifecycleDigest: digest(`lifecycle-${entry.ordinal}`),
    runnerStartedAt: timestamp(baseSecond),
    receiptObservedAt: timestamp(baseSecond + (responseLoss ? 5 : 10)),
    receiptPersistedAt: timestamp(baseSecond + (responseLoss ? 6 : 11)),
    parentDecisionRecordedAt: killed || responseLoss
      ? timestamp(baseSecond + (responseLoss ? 7 : 12))
      : null,
    processExitedAt: timestamp(baseSecond + (killed ? 13 : 14)),
    exitClass: killed
      ? 'confirmed-sigkill'
      : responseLoss
      ? 'successful-response-loss'
      : 'successful-no-fault',
  })
}

/**
 * Returns the current lease expiry carried by one fixture receipt.
 *
 * @param receipt - Authenticated fixture receipt.
 * @returns Current observed lease expiry.
 */
function fixtureLeaseExpiresAt(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): string {
  return receipt.leaseObservation.kind === 'acquired'
    ? receipt.leaseObservation.successorLeaseExpiresAt
    : receipt.leaseObservation.currentLeaseExpiresAt
}

/** Creates a complete valid manifest and receipt chain. */
function createCompleteFixture(): CompleteFixture {
  const key = new Uint8Array(32).fill(7)
  const manifest = createWorkspaceSearchMigrationRehearsalStageManifest({
    claims: createManifestClaims(),
    signingKey: key,
  })
  const manifestDigest = createMigrationDigest(manifest)
  const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
  let previousStageReceiptDigest: string | null = null
  for (const entry of manifest.entries) {
    const baseSecond = entry.ordinal * 100
    const previousReceipt = receipts.at(-1)
    const startsAttempt =
      previousReceipt === undefined ||
      previousReceipt.scenario !== entry.scenario ||
      previousReceipt.attemptOrdinal !== entry.attemptOrdinal
    const leaseIdentityDigest = digest(
      `lease-identity-${entry.scenario}-${entry.attemptOrdinal}`,
    )
    let leaseObservation:
      WorkspaceSearchMigrationRehearsalStageReceiptClaims['leaseObservation']
    if (startsAttempt) {
      const takeover = entry.attemptOrdinal > 1
      if (
        takeover &&
        (previousReceipt === undefined ||
          previousReceipt.faultBoundary === null)
      ) throw new Error('fixture predecessor lease missing')
      leaseObservation = Object.freeze({
        kind: 'acquired',
        predecessorLeaseIdentityDigest: previousReceipt === undefined
          ? null
          : takeover
          ? previousReceipt.faultBoundary?.leaseIdentityDigest ?? null
          : previousReceipt.leaseIdentityDigest,
        predecessorLeaseExpiresAt: previousReceipt === undefined
          ? null
          : takeover
          ? timestamp(baseSecond)
          : fixtureLeaseExpiresAt(previousReceipt),
        acquiredAt: timestamp(baseSecond + (takeover ? 3 : 2)),
        successorLeaseIdentityDigest: leaseIdentityDigest,
        successorLeaseExpiresAt: timestamp(baseSecond + 50),
      })
    } else {
      leaseObservation = Object.freeze({
        kind: 'reused-active',
        currentLeaseIdentityDigest: leaseIdentityDigest,
        evaluatedAt: timestamp(baseSecond + 2),
        currentLeaseExpiresAt: timestamp(baseSecond + 50),
      })
    }
    const reviewedStage = fixtureStages(entry.scenario)[
      entry.scenarioStageOrdinal - 1
    ]
    if (reviewedStage === undefined) throw new Error('fixture stage missing')
    const rateSegment = Object.freeze({
      authenticationKeyFingerprint:
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          key,
        ),
      segmentLocatorDigest: digest(`segment-locator-${entry.ordinal}`),
      segmentOrdinal: entry.ordinal - 1,
      firstEventSequence: entry.ordinal,
      eventCount: 1,
      firstCommittedEventSequence: entry.ordinal,
      lastCommittedEventSequence: entry.ordinal,
      terminalRecordMac: digest(`segment-mac-${entry.ordinal}`),
      segmentDigest: digest(`segment-${entry.ordinal}`),
    })
    const faultBoundary = entry.faultPlanDigest === null
      ? null
      : createFaultEvidence(
        entry.scenario,
        baseSecond,
        leaseIdentityDigest,
      )
    const evidence = entry.expectedOutcome === 'fault-reached'
      ? faultBoundary ?? (() => {
          throw new Error('fixture fault missing')
        })()
      : createStageEvidence(
          entry,
          baseSecond,
          previousReceipt,
          rateSegment,
        )
    const faultReceiptDigest = faultBoundary?.faultReceiptDigest ??
      (entry.expectedOutcome === 'takeover-completed'
        ? digest(`fault-receipt-${entry.scenario}`)
        : null)
    const claims: WorkspaceSearchMigrationRehearsalStageReceiptClaims = {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
      receiptVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
      stage: 'non-production',
      scenario: entry.scenario,
      stageOrdinal: entry.ordinal,
      scenarioStageOrdinal: entry.scenarioStageOrdinal,
      command: entry.command,
      controlArgumentsDigest: entry.controlArgumentsDigest,
      serializedOutputLineDigest: digest(`output-line-${entry.ordinal}`),
      manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
      permitDigest: manifest.permitDigest,
      commit: manifest.commit,
      requestedResourcesBinding: manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities: manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        manifest.integrityResourceIdentityDigest,
      configurationBindingDigest: manifest.configurationBindingDigest,
      policyVersion: manifest.policyVersion,
      runLocatorDigest: digest(`run-${entry.scenario}`),
      attemptOrdinal: entry.attemptOrdinal,
      attemptLocatorDigest:
        digest(`attempt-${entry.scenario}-${entry.attemptOrdinal}`),
      ownerLocatorDigest:
        digest(`owner-${entry.scenario}-${entry.attemptOrdinal}`),
      leaseIdentityDigest,
      leaseObservation,
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest: entry.command === 'release'
        ? digest(`released-fence-${entry.scenario}`)
        : digest(`closed-fence-${entry.scenario}`),
      previousStageReceiptDigest,
      stageReservationDigest: digest(`stage-reservation-${entry.ordinal}`),
      stageReservationClaimRevision: entry.ordinal * 2 - 1,
      stageReservationCommitRevision: entry.ordinal * 2,
      stageReservationAbandonmentCount: 0,
      stageReservationAbandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      startedAt: timestamp(baseSecond + 1),
      completedAt: timestamp(baseSecond + 9),
      processLifecycle: createProcessLifecycle(entry, baseSecond),
      outcome: entry.expectedOutcome,
      faultReceiptDigest,
      faultBoundary,
      predecessorLeaseExpiresAt:
        entry.expectedOutcome === 'takeover-completed'
          ? timestamp(baseSecond)
          : null,
      takeoverAcquiredAt: entry.expectedOutcome === 'takeover-completed'
        ? timestamp(baseSecond + 3)
        : null,
      reconciledAt: entry.expectedOutcome === 'response-loss-reconciled'
        ? timestamp(baseSecond + 8)
        : null,
      evidence,
      rateSegment,
    }
    const receipt = createWorkspaceSearchMigrationRehearsalStageReceipt({
      claims,
      signingKey: key,
    })
    receipts.push(receipt)
    previousStageReceiptDigest = createMigrationDigest(receipt)
  }
  return Object.freeze({ key, manifest, receipts: Object.freeze(receipts) })
}

/** Re-signs a fixture chain after replacing selected authenticated claims. */
function resignFixtureReceipts(
  fixture: CompleteFixture,
  replace: (
    receipt: WorkspaceSearchMigrationRehearsalStageReceiptClaims,
    index: number,
  ) => WorkspaceSearchMigrationRehearsalStageReceiptClaims,
): readonly WorkspaceSearchMigrationRehearsalStageReceipt[] {
  const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
  let previousStageReceiptDigest: string | null = null
  for (let index = 0; index < fixture.receipts.length; index += 1) {
    const source = fixture.receipts[index]
    if (source === undefined) throw new Error('fixture receipt missing')
    const { receiptMac: _receiptMac, ...sourceClaims } = source
    const claims = replace({
      ...sourceClaims,
      previousStageReceiptDigest,
    }, index)
    const receipt = createWorkspaceSearchMigrationRehearsalStageReceipt({
      claims,
      signingKey: fixture.key,
    })
    receipts.push(receipt)
    previousStageReceiptDigest = createMigrationDigest(receipt)
  }
  return Object.freeze(receipts)
}

/**
 * Requires receipt creation to reject one invalid failpoint-specific evidence shape.
 *
 * @param fixture - Complete authenticated chain fixture.
 * @param scenario - Fault scenario whose boundary is replaced.
 * @param replace - Builds the invalid boundary from the valid fixture boundary.
 */
function expectFaultEvidenceRejection(
  fixture: CompleteFixture,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  replace: (
    evidence: WorkspaceSearchMigrationRehearsalFaultStageEvidence,
  ) => WorkspaceSearchMigrationRehearsalFaultStageEvidence,
): void {
  const receipt = fixture.receipts.find(
    (candidate) =>
      candidate.scenario === scenario &&
      candidate.faultBoundary !== null,
  )
  if (receipt === undefined || receipt.faultBoundary === null) {
    throw new Error('fixture fault boundary missing')
  }
  const invalidEvidence = replace(receipt.faultBoundary)
  const { receiptMac: _receiptMac, ...claims } = receipt
  expect(() =>
    createWorkspaceSearchMigrationRehearsalStageReceipt({
      claims: {
        ...claims,
        evidence: claims.evidence.kind === 'fault-boundary'
          ? invalidEvidence
          : claims.evidence,
        faultBoundary: invalidEvidence,
      },
      signingKey: fixture.key,
    })
  ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
}

describe('Workspace Search migration rehearsal stage receipts', () => {
  test('authenticates, derives, preserves, and consumes the complete chain once', () => {
    const fixture = createCompleteFixture()
    const finalized =
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: fixture.receipts,
        verificationKey: fixture.key,
      })
    expect(finalized.kind).toBe(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_STAGE_CHAIN_KIND,
    )
    const windows =
      readWorkspaceSearchMigrationRehearsalFinalizedStageChainIntegrityWindows(
        finalized,
      )
    expect(windows.map((window) => window.purpose)).toEqual([
      'verified',
      'partial-rollback',
      'complete-rollback',
    ])
    const reconciliationContexts =
      readWorkspaceSearchMigrationRehearsalFinalizedStageChainReconciliationContexts(
        finalized,
      )
    expect(reconciliationContexts).toHaveLength(8)
    expect(reconciliationContexts.map((context) => context.scenario)).toEqual(
      [...WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS],
    )
    expect(reconciliationContexts.map((context) => context.integrity.kind))
      .toEqual([
        'verified-result',
        'verified-result',
        'verified-result',
        'verified-result',
        'verified-result',
        'verified-result',
        'rollback-comparison',
        'rollback-comparison',
      ])
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedStageChainReconciliationContexts(
        structuredClone(finalized),
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
    const projection =
      consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence(
        finalized,
      )
    expect(projection.receiptCount).toBe(fixture.receipts.length)
    expect(projection.receiptCount).toBe(36)
    expect(projection.terminalStageHeadRevision).toBe(72)
    expect(projection.scenarios.map((scenario) => scenario.name)).toEqual(
      [...WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS],
    )
    expect(
      projection.scenarios.flatMap(
        (scenario) => scenario.stageReceiptDigests,
      ),
    ).toHaveLength(fixture.receipts.length)
    expect(
      projection.scenarios.flatMap(
        (scenario) => scenario.stageReservationClaimRevisions,
      ),
    ).toEqual(fixture.receipts.map((_, index) => index * 2 + 1))
    expect(
      projection.scenarios.flatMap(
        (scenario) => scenario.stageReservationCommitRevisions,
      ),
    ).toEqual(fixture.receipts.map((_, index) => index * 2 + 2))
    expect(
      projection.scenarios.flatMap(
        (scenario) => scenario.rateSegmentBindings,
      ).map((segment) => segment.segmentOrdinal),
    ).toEqual(fixture.receipts.map((_, index) => index))
    expect(
      projection.scenarios.find(
        (scenario) => scenario.name === 'transaction-response-loss',
      )?.attempts[0]?.outcome,
    ).toBe('response-loss-reconciled')
    for (const scenarioName of sigkillTakeoverScenarios) {
      const scenario = projection.scenarios.find(
        (candidate) => candidate.name === scenarioName,
      )
      if (scenario === undefined) throw new Error('fixture scenario missing')
      expect(scenario.attempts.map((attempt) => attempt.outcome)).toEqual([
        'killed-at-fault',
        'takeover-completed',
      ])
      const killedAttempt = scenario.attempts[0]
      const successorAttempt = scenario.attempts[1]
      if (
        killedAttempt === undefined ||
        successorAttempt === undefined ||
        scenario.killConfirmedAt === null ||
        scenario.predecessorLeaseExpiresAt === null ||
        scenario.takeoverAcquiredAt === null
      ) throw new Error('fixture takeover evidence missing')
      expect(killedAttempt.completedAt).toBe(scenario.killConfirmedAt)
      expect(successorAttempt.faultReceiptDigest).toBeNull()
      expect(Date.parse(scenario.predecessorLeaseExpiresAt)).toBeGreaterThan(
        Date.parse(scenario.killConfirmedAt),
      )
      expect(Date.parse(successorAttempt.startedAt)).toBeGreaterThanOrEqual(
        Date.parse(scenario.predecessorLeaseExpiresAt),
      )
      expect(Date.parse(scenario.takeoverAcquiredAt)).toBeGreaterThanOrEqual(
        Date.parse(successorAttempt.startedAt),
      )
      expect(Date.parse(scenario.takeoverAcquiredAt)).toBeLessThan(
        Date.parse(successorAttempt.completedAt),
      )
    }
    for (const scenario of projection.scenarios) {
      const finalReceipt = fixture.receipts.findLast(
        (receipt) => receipt.scenario === scenario.name,
      )
      if (finalReceipt === undefined) throw new Error('fixture receipt missing')
      expect(scenario.completedAt).toBe(
        finalReceipt.processLifecycle.processExitedAt,
      )
    }
    const terminalReceipt = fixture.receipts.at(-1)
    if (terminalReceipt === undefined) throw new Error('fixture receipt missing')
    expect(projection.completedAt).toBe(
      terminalReceipt.processLifecycle.processExitedAt,
    )
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence(
        finalized,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence({
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_STAGE_CHAIN_KIND,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('keeps the partial origin independent and requires complete applied roots', () => {
    const fixture = createCompleteFixture()
    const partialFault = fixture.receipts.find(
      (receipt) =>
        receipt.scenario === 'partial-apply-rollback' &&
        receipt.evidence.kind === 'fault-boundary',
    )
    const partialTerminal = fixture.receipts.find(
      (receipt) =>
        receipt.scenario === 'partial-apply-rollback' &&
        receipt.evidence.kind === 'terminal',
    )
    if (
      partialFault?.evidence.kind !== 'fault-boundary' ||
      partialFault.evidence.faultObservation.kind !== 'apply-operation' ||
      partialTerminal?.evidence.kind !== 'terminal'
    ) throw new Error('Expected partial boundary fixtures.')
    expect(
      partialTerminal.evidence.reconciliationContext.applyBoundaryDigest,
    ).not.toBe(
      partialFault.evidence.faultObservation.durableRunStateDigest,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: fixture.receipts,
        verificationKey: fixture.key,
      })
    ).not.toThrow()

    const mismatchedCompleteBoundary = resignFixtureReceipts(
      fixture,
      (receipt) => {
        if (
          receipt.scenario !== 'complete-apply-rollback' ||
          receipt.evidence.kind !== 'terminal'
        ) return receipt
        const reconciliationContext = createReconciliationContext(
          receipt.scenario,
          receipt.stageOrdinal * 100,
          digest('mismatched-complete-applied-root'),
          receipt.rateSegment,
        )
        return {
          ...receipt,
          evidence: {
            ...receipt.evidence,
            reconciliationContext,
          },
        }
      },
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: mismatchedCompleteBoundary,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('rejects receipt substitution, chain gaps, and rate-segment replay', () => {
    const fixture = createCompleteFixture()
    const tampered = fixture.receipts.map((receipt) => ({ ...receipt }))
    const second = tampered[1]
    if (second === undefined) throw new Error('fixture receipt missing')
    tampered[1] = {
      ...second,
      serializedOutputLineDigest: digest('substituted-output'),
    }
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: tampered,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: fixture.receipts.slice(1),
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
    const replayedRate = fixture.receipts.map((receipt, index) =>
      index === 1
        ? createWorkspaceSearchMigrationRehearsalStageReceipt({
            claims: {
              ...receipt,
              rateSegment: fixture.receipts[0]?.rateSegment ??
                receipt.rateSegment,
            },
            signingKey: fixture.key,
          })
        : receipt
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: replayedRate,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const first = fixture.receipts[0]
    if (first === undefined) throw new Error('fixture receipt missing')
    const replayedReservation = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === 1
        ? {
            ...receipt,
            stageReservationDigest: first.stageReservationDigest,
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: replayedReservation,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const staleClaimRevision = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === 1
        ? {
            ...receipt,
            stageReservationClaimRevision:
              first.stageReservationClaimRevision,
            stageReservationCommitRevision:
              first.stageReservationClaimRevision + 1,
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: staleClaimRevision,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('requires exact failpoint-specific operation counts and preimage evidence', () => {
    const fixture = createCompleteFixture()
    const planningScenario = 'artifact-before-checkpoint-kill'
    expectFaultEvidenceRejection(
      fixture,
      planningScenario,
      (evidence) => ({ ...evidence, sealedPlanOperationCount: 3 }),
    )
    expectFaultEvidenceRejection(
      fixture,
      planningScenario,
      (evidence) => ({ ...evidence, appliedOperationCount: 1 }),
    )
    expectFaultEvidenceRejection(
      fixture,
      planningScenario,
      (evidence) => ({ ...evidence, leaseIdentityDigest: 'invalid' }),
    )
    expectFaultEvidenceRejection(
      fixture,
      planningScenario,
      (evidence) => ({
        ...evidence,
        targetPreimageArtifactContentDigest: digest('unexpected-preimage'),
      }),
    )

    const cursorScenario = 'cursor-before-commit-kill'
    expectFaultEvidenceRejection(
      fixture,
      cursorScenario,
      (evidence) => ({ ...evidence, sealedPlanOperationCount: null }),
    )
    expectFaultEvidenceRejection(
      fixture,
      cursorScenario,
      (evidence) => ({ ...evidence, appliedOperationCount: 2 }),
    )
    expectFaultEvidenceRejection(
      fixture,
      cursorScenario,
      (evidence) => ({ ...evidence, appliedOperationCount: 0 }),
    )
    expectFaultEvidenceRejection(
      fixture,
      cursorScenario,
      (evidence) => ({
        ...evidence,
        targetPreimageArtifactContentDigest: digest('unexpected-preimage'),
      }),
    )

    const partialScenario = 'partial-apply-rollback'
    expectFaultEvidenceRejection(
      fixture,
      partialScenario,
      (evidence) => ({ ...evidence, sealedPlanOperationCount: null }),
    )
    expectFaultEvidenceRejection(
      fixture,
      partialScenario,
      (evidence) => ({ ...evidence, appliedOperationCount: 0 }),
    )
    expectFaultEvidenceRejection(
      fixture,
      partialScenario,
      (evidence) => ({ ...evidence, appliedOperationCount: 3 }),
    )
    expectFaultEvidenceRejection(
      fixture,
      partialScenario,
      (evidence) => ({
        ...evidence,
        targetPreimageArtifactContentDigest: null,
      }),
    )

    const mismatchedCursorPlan = resignFixtureReceipts(
      fixture,
      (receipt) => {
        if (
          receipt.scenario !== cursorScenario ||
          receipt.evidence.kind !== 'fault-boundary' ||
          receipt.faultBoundary === null ||
          receipt.faultBoundary.faultObservation.kind !== 'apply-checkpoint'
        ) return receipt
        const faultObservation = {
          ...receipt.faultBoundary.faultObservation,
          durableAppliedOperationCount: 2,
          sealedPlanOperationCount: 2,
        }
        const faultBoundary = {
          ...receipt.faultBoundary,
          appliedOperationCount: 2,
          sealedPlanOperationCount: 2,
          faultObservationDigest: createMigrationDigest(faultObservation),
          faultObservation,
        }
        return {
          ...receipt,
          evidence: faultBoundary,
          faultBoundary,
        }
      },
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: mismatchedCursorPlan,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('requires canonical lease acquisition, reuse, and takeover identity links', () => {
    const fixture = createCompleteFixture()
    const firstReceipt = fixture.receipts[0]
    if (
      firstReceipt === undefined ||
      firstReceipt.leaseObservation.kind !== 'acquired'
    ) throw new Error('fixture initial lease acquisition missing')
    const firstLeaseObservation = firstReceipt.leaseObservation
    const { receiptMac: _firstReceiptMac, ...firstClaims } = firstReceipt
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageReceipt({
        claims: {
          ...firstClaims,
          leaseIdentityDigest: digest('substituted-current-lease'),
        },
        signingKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const globalPredecessor = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === 0
        ? {
            ...receipt,
            leaseObservation: {
              ...firstLeaseObservation,
              predecessorLeaseIdentityDigest:
                digest('preexisting-global-lease'),
              predecessorLeaseExpiresAt:
                firstReceipt.processLifecycle.runnerStartedAt,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: globalPredecessor,
        verificationKey: fixture.key,
      })
    ).not.toThrow()

    const initialReuse = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === 0
        ? {
            ...receipt,
            leaseObservation: {
              kind: 'reused-active',
              currentLeaseIdentityDigest: receipt.leaseIdentityDigest,
              evaluatedAt: receipt.startedAt,
              currentLeaseExpiresAt:
                firstLeaseObservation.successorLeaseExpiresAt,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: initialReuse,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const nextScenarioIndex = fixture.receipts.findIndex(
      (receipt) =>
        receipt.scenario === 'cursor-before-commit-kill' &&
        receipt.scenarioStageOrdinal === 1,
    )
    const nextScenarioReceipt = fixture.receipts[nextScenarioIndex]
    if (
      nextScenarioIndex < 1 ||
      nextScenarioReceipt === undefined ||
      nextScenarioReceipt.leaseObservation.kind !== 'acquired'
    ) throw new Error('fixture next-scenario acquisition missing')
    const nextScenarioLeaseObservation =
      nextScenarioReceipt.leaseObservation
    const nextScenarioPredecessor =
      fixture.receipts[nextScenarioIndex - 1]
    if (nextScenarioPredecessor === undefined) {
      throw new Error('fixture previous-scenario lease missing')
    }
    const missingScenarioPredecessor = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === nextScenarioIndex
        ? {
            ...receipt,
            leaseObservation: {
              ...nextScenarioLeaseObservation,
              predecessorLeaseIdentityDigest: null,
              predecessorLeaseExpiresAt: null,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: missingScenarioPredecessor,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
    const expiredScenarioPredecessor = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === nextScenarioIndex
        ? {
            ...receipt,
            leaseObservation: {
              ...nextScenarioLeaseObservation,
              predecessorLeaseExpiresAt:
                nextScenarioPredecessor.processLifecycle.processExitedAt,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: expiredScenarioPredecessor,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const happyApplyIndex = fixture.receipts.findIndex(
      (receipt) =>
        receipt.scenario === 'happy-path-verified' &&
        receipt.command === 'apply',
    )
    const happyApply = fixture.receipts[happyApplyIndex]
    if (
      happyApplyIndex < 1 ||
      happyApply === undefined ||
      happyApply.leaseObservation.kind !== 'reused-active'
    ) throw new Error('fixture active lease reuse missing')
    const happyApplyLeaseObservation = happyApply.leaseObservation
    const happyApplyPredecessor = fixture.receipts[happyApplyIndex - 1]
    if (happyApplyPredecessor === undefined) {
      throw new Error('fixture same-attempt predecessor missing')
    }
    const validMidAttemptReacquisition = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === happyApplyIndex
        ? {
            ...receipt,
            leaseObservation: {
              kind: 'acquired',
              predecessorLeaseIdentityDigest:
                happyApplyPredecessor.leaseIdentityDigest,
              predecessorLeaseExpiresAt:
                fixtureLeaseExpiresAt(happyApplyPredecessor),
              acquiredAt: receipt.startedAt,
              successorLeaseIdentityDigest: receipt.leaseIdentityDigest,
              successorLeaseExpiresAt:
                happyApplyLeaseObservation.currentLeaseExpiresAt,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: validMidAttemptReacquisition,
        verificationKey: fixture.key,
      })
    ).not.toThrow()
    const expiredMidAttemptReacquisition = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === happyApplyIndex
        ? {
            ...receipt,
            leaseObservation: {
              kind: 'acquired',
              predecessorLeaseIdentityDigest:
                happyApplyPredecessor.leaseIdentityDigest,
              predecessorLeaseExpiresAt:
                happyApplyPredecessor.processLifecycle.processExitedAt,
              acquiredAt: receipt.startedAt,
              successorLeaseIdentityDigest: receipt.leaseIdentityDigest,
              successorLeaseExpiresAt:
                happyApplyLeaseObservation.currentLeaseExpiresAt,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: expiredMidAttemptReacquisition,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
    const reacquiredMidAttempt = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === happyApplyIndex
        ? {
            ...receipt,
            leaseObservation: {
              kind: 'acquired',
              predecessorLeaseIdentityDigest: null,
              predecessorLeaseExpiresAt: null,
              acquiredAt: receipt.startedAt,
              successorLeaseIdentityDigest: receipt.leaseIdentityDigest,
              successorLeaseExpiresAt:
                happyApplyLeaseObservation.currentLeaseExpiresAt,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: reacquiredMidAttempt,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const substitutedReuseIdentity = digest('substituted-reused-lease')
    const wrongReuseIdentity = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === happyApplyIndex
        ? {
            ...receipt,
            leaseIdentityDigest: substitutedReuseIdentity,
            leaseObservation: {
              ...happyApplyLeaseObservation,
              currentLeaseIdentityDigest: substitutedReuseIdentity,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: wrongReuseIdentity,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const takeoverIndex = fixture.receipts.findIndex(
      (receipt) =>
        receipt.scenario === 'cursor-before-commit-kill' &&
        receipt.outcome === 'takeover-completed',
    )
    const takeoverReceipt = fixture.receipts[takeoverIndex]
    if (
      takeoverIndex < 1 ||
      takeoverReceipt === undefined ||
      takeoverReceipt.leaseObservation.kind !== 'acquired'
    ) throw new Error('fixture takeover lease acquisition missing')
    const takeoverLeaseObservation = takeoverReceipt.leaseObservation
    const wrongTakeoverPredecessor = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === takeoverIndex
        ? {
            ...receipt,
            leaseObservation: {
              ...takeoverLeaseObservation,
              predecessorLeaseIdentityDigest:
                digest('substituted-predecessor-lease'),
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: wrongTakeoverPredecessor,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const { receiptMac: _takeoverReceiptMac, ...takeoverClaims } =
      takeoverReceipt
    const invalidPredecessorLeaseExpiresAt =
      takeoverLeaseObservation.successorLeaseExpiresAt
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageReceipt({
        claims: {
          ...takeoverClaims,
          predecessorLeaseExpiresAt: invalidPredecessorLeaseExpiresAt,
          leaseObservation: {
            ...takeoverLeaseObservation,
            predecessorLeaseExpiresAt: invalidPredecessorLeaseExpiresAt,
          },
        },
        signingKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('requires the exact command sequence and exact takeover successor', () => {
    const fixture = createCompleteFixture()
    const claims = createManifestClaims()
    const happyApplyIndex = claims.entries.findIndex(
      (entry) =>
        entry.scenario === 'happy-path-verified' &&
        entry.command === 'apply',
    )
    const happyVerifyIndex = claims.entries.findIndex(
      (entry) =>
        entry.scenario === 'happy-path-verified' &&
        entry.command === 'verify',
    )
    const happyApply = claims.entries[happyApplyIndex]
    const happyVerify = claims.entries[happyVerifyIndex]
    if (happyApply === undefined || happyVerify === undefined) {
      throw new Error('fixture happy-path stages missing')
    }
    const reordered = claims.entries.map((entry, index) =>
      index === happyApplyIndex
        ? { ...entry, command: happyVerify.command }
        : index === happyVerifyIndex
        ? { ...entry, command: happyApply.command }
        : entry
    )
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageManifest({
        claims: { ...claims, entries: reordered },
        signingKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const takeoverIndex = claims.entries.findIndex(
      (entry) =>
        entry.scenario === 'cursor-before-commit-kill' &&
        entry.expectedOutcome === 'takeover-completed',
    )
    const takeoverEntry = claims.entries[takeoverIndex]
    if (takeoverEntry === undefined) {
      throw new Error('fixture takeover stage missing')
    }
    const wrongSuccessor:
      readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[] =
        claims.entries.map((entry, index) =>
          index === takeoverIndex
            ? { ...entry, command: 'close-replan' }
            : entry
        )
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageManifest({
        claims: { ...claims, entries: wrongSuccessor },
        signingKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const happyReleaseIndex = claims.entries.findIndex(
      (entry) =>
        entry.scenario === 'happy-path-verified' &&
        entry.command === 'release',
    )
    const happyRelease = claims.entries[happyReleaseIndex]
    if (happyRelease === undefined) {
      throw new Error('fixture happy-path release missing')
    }
    const withEarlyRelease = [...claims.entries]
    withEarlyRelease.splice(happyApplyIndex, 0, happyRelease)
    const scenarioOrdinals = new Map<
      WorkspaceSearchMigrationRehearsalScenarioName,
      number
    >()
    const reindexed = withEarlyRelease.map((entry, index) => {
      const scenarioStageOrdinal =
        (scenarioOrdinals.get(entry.scenario) ?? 0) + 1
      scenarioOrdinals.set(entry.scenario, scenarioStageOrdinal)
      return {
        ...entry,
        ordinal: index + 1,
        scenarioStageOrdinal,
      }
    })
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageManifest({
        claims: { ...claims, entries: reindexed },
        signingKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('requires every SIGKILL successor and strict process chronology', () => {
    const fixture = createCompleteFixture()
    const manifestClaims = createManifestClaims()
    const invalidSuccessorIndex = manifestClaims.entries.findIndex(
      (entry) =>
        entry.scenario === 'cursor-before-commit-kill' &&
        entry.expectedOutcome === 'takeover-completed',
    )
    const invalidSuccessor = manifestClaims.entries[invalidSuccessorIndex]
    if (invalidSuccessor === undefined) {
      throw new Error('fixture successor missing')
    }
    const invalidEntries:
      WorkspaceSearchMigrationRehearsalStageManifestEntry[] =
        manifestClaims.entries.map((entry, index) =>
          index === invalidSuccessorIndex
            ? { ...entry, expectedOutcome: 'completed' }
            : entry
        )
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageManifest({
        claims: { ...manifestClaims, entries: invalidEntries },
        signingKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const takeoverIndex = fixture.receipts.findIndex(
      (receipt) =>
        receipt.scenario === 'cursor-before-commit-kill' &&
        receipt.outcome === 'takeover-completed',
    )
    const killedReceipt = fixture.receipts[takeoverIndex - 1]
    if (takeoverIndex < 1 || killedReceipt === undefined) {
      throw new Error('fixture takeover predecessor missing')
    }
    const preExpiryTakeover = resignFixtureReceipts(
      fixture,
      (receipt, index) => {
        if (index !== takeoverIndex) return receipt
        if (receipt.leaseObservation.kind !== 'acquired') {
          throw new Error('fixture takeover acquisition missing')
        }
        const predecessorLeaseExpiresAt =
          killedReceipt.processLifecycle.processExitedAt
        return {
          ...receipt,
          predecessorLeaseExpiresAt,
          leaseObservation: {
            ...receipt.leaseObservation,
            predecessorLeaseExpiresAt,
          },
        }
      },
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: preExpiryTakeover,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const firstReceipt = fixture.receipts[0]
    if (firstReceipt === undefined) throw new Error('fixture receipt missing')
    const overlappingStage = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === 1
        ? {
            ...receipt,
            startedAt: firstReceipt.processLifecycle.processExitedAt,
            processLifecycle: {
              ...receipt.processLifecycle,
              runnerStartedAt:
                firstReceipt.processLifecycle.processExitedAt,
            },
          }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: overlappingStage,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const secondReceipt = fixture.receipts[1]
    if (secondReceipt === undefined) throw new Error('fixture receipt missing')
    const overlappingOfflineFinalization = resignFixtureReceipts(
      fixture,
      (receipt, index) => index === 0
        ? { ...receipt, completedAt: secondReceipt.startedAt }
        : receipt,
    )
    expect(() =>
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts: overlappingOfflineFinalization,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('requires exact canonical manifest bytes and immediate reviewed resume', () => {
    const fixture = createCompleteFixture()
    const bytes = new TextEncoder().encode(
      serializeCanonicalJson(fixture.manifest),
    )
    expect(
      parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
        bytes,
        fixture.key,
      ),
    ).toEqual(fixture.manifest)
    const withNewline = new TextEncoder().encode(
      `${serializeCanonicalJson(fixture.manifest)}\n`,
    )
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
        withNewline,
        fixture.key,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
    const firstEntry = fixture.manifest.entries[0]
    if (firstEntry === undefined) throw new Error('fixture entry missing')
    const selection = selectWorkspaceSearchMigrationRehearsalStage({
      manifest: fixture.manifest,
      verificationKey: fixture.key,
      previousReceipt: null,
      controlArguments: fixtureControlArguments(
        firstEntry.scenario,
        firstEntry.scenarioStageOrdinal,
        firstEntry.command,
      ),
      faultPlanDigest: null,
    })
    expect(selection.entry.ordinal).toBe(1)
    expect(() =>
      selectWorkspaceSearchMigrationRehearsalStage({
        manifest: fixture.manifest,
        verificationKey: fixture.key,
        previousReceipt: null,
        controlArguments: ['release'],
        faultPlanDigest: null,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const firstReceipt = fixture.receipts[0]
    const secondEntry = fixture.manifest.entries[1]
    if (firstReceipt === undefined || secondEntry === undefined) {
      throw new Error('fixture predecessor missing')
    }
    const { receiptMac: _receiptMac, ...firstClaims } = firstReceipt
    const substitutedPredecessor =
      createWorkspaceSearchMigrationRehearsalStageReceipt({
        claims: {
          ...firstClaims,
          manifestEntryDigest: createMigrationDigest(secondEntry),
        },
        signingKey: fixture.key,
      })
    expect(() =>
      selectWorkspaceSearchMigrationRehearsalStage({
        manifest: fixture.manifest,
        verificationKey: fixture.key,
        previousReceipt: substitutedPredecessor,
        controlArguments: fixtureControlArguments(
          secondEntry.scenario,
          secondEntry.scenarioStageOrdinal,
          secondEntry.command,
        ),
        faultPlanDigest: secondEntry.faultPlanDigest,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('domain-separates restricted locators and authenticates receipt HMACs', () => {
    const fixture = createCompleteFixture()
    expect(
      createWorkspaceSearchMigrationRehearsalLocatorDigest(
        'run',
        'restricted-value',
        fixture.key,
      ),
    ).not.toBe(
      createWorkspaceSearchMigrationRehearsalLocatorDigest(
        'owner',
        'restricted-value',
        fixture.key,
      ),
    )
    expect(
      verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        fixture.receipts[0],
        fixture.key,
      ),
    ).toEqual(fixture.receipts[0])
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        fixture.receipts[0],
        new Uint8Array(32).fill(8),
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })

  test('rejects a foreign rate key fingerprint even with a valid receipt HMAC', () => {
    const fixture = createCompleteFixture()
    const source = fixture.receipts[0]
    if (source === undefined) throw new Error('fixture receipt missing')
    const { receiptMac: _receiptMac, ...sourceClaims } = source
    const foreignClaims = Object.freeze({
      ...sourceClaims,
      rateSegment: Object.freeze({
        ...sourceClaims.rateSegment,
        authenticationKeyFingerprint:
          createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
            new Uint8Array(32).fill(9),
          ),
      }),
    })

    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageReceipt({
        claims: foreignClaims,
        signingKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)

    const forgedReceipt = Object.freeze({
      ...foreignClaims,
      receiptMac: createHmac('sha256', fixture.key)
        .update(
          'mukuroji-workspace-search-migration-rehearsal-stage-receipt/v1\0',
          'utf8',
        )
        .update(serializeCanonicalJson(foreignClaims), 'utf8')
        .digest('hex'),
    })
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        forgedReceipt,
        fixture.key,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReceiptError)
  })
})
