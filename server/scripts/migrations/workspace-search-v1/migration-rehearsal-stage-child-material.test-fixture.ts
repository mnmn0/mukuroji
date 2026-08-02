import { createHash, createHmac } from 'node:crypto'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationControlCliCoordinatorMutationResult,
  WorkspaceSearchMigrationControlCliMutationResultObservation,
} from './migration-control-cli'
import {
  workspaceSearchMigrationControlApprovalLiterals,
} from './migration-control-coordinator'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
} from './migration-describe-table-rate-budget'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  createWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  type WorkspaceSearchMigrationRehearsalPermit,
} from './migration-rehearsal-permit'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
} from './migration-rehearsal-rate-evidence'
import type {
  WorkspaceSearchMigrationRehearsalFaultPlan,
} from './migration-rehearsal-faults'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
} from './migration-rehearsal-key-derivation'
import {
  createWorkspaceSearchMigrationRehearsalStageManifest,
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  selectWorkspaceSearchMigrationRehearsalStage,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestClaims,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
  type WorkspaceSearchMigrationRehearsalStageRateSegment,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
  type WorkspaceSearchMigrationRehearsalStageReceiptClaims,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'
import type {
  WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
import type {
  WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-stage-fault-material'

/** Canonical keyed immutable resource identities shared by child fixtures. */
const fixtureIntegrityResourceIdentities = Object.freeze(
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
    Object.freeze({
      target,
      identityDigest: createMigrationDigest({
        label: `fixture-integrity-resource:${index}:${target}`,
      }),
    })
  ),
)

/** Complete authentic stage-one material test fixture. */
export type WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture = {
  /** Parent-held master key used only to derive the two fixture keys. */
  readonly masterAuthenticationKey: Uint8Array
  /** Fresh shared permit, manifest, and child-material key. */
  readonly authenticationKey: Uint8Array
  /** Parent-only lifecycle and publication authentication key. */
  readonly publicationAuthenticationKey: Uint8Array
  /** Canonical authenticated permit used by parent key-binding tests. */
  readonly permit: WorkspaceSearchMigrationRehearsalPermit
  /** Canonical authenticated full-suite manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Authenticated global stage-one selection. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Fresh authenticated reservation for this selected stage. */
  readonly stageReservation:
    WorkspaceSearchMigrationRehearsalStageReservation
  /** Durable head returned by the fixture reservation claim. */
  readonly claimedStageHead:
    WorkspaceSearchMigrationRehearsalStageHead
  /** Adapter-proven initial lease acquisition used by the mutation. */
  readonly leaseAcquisitionObservation:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation
  /** Exact selected control argument vector. */
  readonly controlArguments: readonly string[]
  /** Trusted pre-stdout close-replan mutation observation. */
  readonly observation:
    WorkspaceSearchMigrationControlCliMutationResultObservation & {
      /** Exact close-replan coordinator result. */
      readonly result:
        WorkspaceSearchMigrationControlCliCoordinatorMutationResult
    }
  /** Closed committed segment whose digest matches its exact bytes. */
  readonly committedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Reviewed measured configuration digest. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly policyVersion: string
  /** Exact canonical reviewed rate-policy bytes referenced by control args. */
  readonly ratePolicyBytes: Uint8Array
  /** Exact reviewed rate-policy path referenced by control args. */
  readonly ratePolicyFile: string
  /** Authenticated requested-resource binding. */
  readonly requestedResourcesBinding: string
}

/** Optional reviewed bindings for composing CLI-specific fixtures. */
export type WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixtureOptions = {
  /** Requested-resource binding expected from the injected session. */
  readonly requestedResourcesBinding?: string
  /** Measured configuration binding expected from the wrapper CLI. */
  readonly configurationBindingDigest?: string
  /** Reviewed DescribeTable policy binding expected from the session. */
  readonly policyVersion?: string
}

/** Complete authentic fault-stage fixture with its immediate predecessor. */
export type WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture = {
  /** Parent-held master key used only to derive the two fixture keys. */
  readonly masterAuthenticationKey: Uint8Array
  /** Fresh shared permit, manifest, receipt, and material key. */
  readonly authenticationKey: Uint8Array
  /** Parent-only lifecycle and publication authentication key. */
  readonly publicationAuthenticationKey: Uint8Array
  /** Canonical authenticated permit bound to the stage key. */
  readonly permit: WorkspaceSearchMigrationRehearsalPermit
  /** Canonical authenticated full-suite manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Exact authenticated immediate predecessor receipt. */
  readonly previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Canonical authenticated rate segment summarized by the predecessor. */
  readonly previousCommittedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Authenticated selected fault stage. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Fresh authenticated reservation for this selected fault stage. */
  readonly stageReservation:
    WorkspaceSearchMigrationRehearsalStageReservation
  /** Durable head returned by the fixture reservation claim. */
  readonly claimedStageHead:
    WorkspaceSearchMigrationRehearsalStageHead
  /** Adapter-proven lease acquisition used by the faulting mutation. */
  readonly leaseAcquisitionObservation:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation
  /** Adapter-proven durable planning head at the selected failpoint. */
  readonly faultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation
  /** Exact selected control argument vector. */
  readonly controlArguments: readonly string[]
  /** Exact canonical fault plan selected by the manifest entry. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Trusted pre-stdout close-replan mutation observation fixture. */
  readonly observation:
    WorkspaceSearchMigrationControlCliMutationResultObservation & {
      /** Exact close-replan coordinator result. */
      readonly result:
        WorkspaceSearchMigrationControlCliCoordinatorMutationResult
    }
  /** Authenticated empty durable rate segment at the selected ordinal. */
  readonly committedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Reviewed measured configuration digest. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly policyVersion: string
  /** Exact canonical reviewed rate-policy bytes referenced by control args. */
  readonly ratePolicyBytes: Uint8Array
  /** Exact reviewed rate-policy path referenced by control args. */
  readonly ratePolicyFile: string
}

/** One reviewed stage before its global ordinal is assigned. */
type FixtureStage = {
  /** Existing mutating control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Authenticated finite process outcome. */
  readonly outcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Whether the stage owns its scenario fault plan. */
  readonly fault: boolean
  /** One-based process-attempt ordinal. */
  readonly attemptOrdinal: number
}

/** Returns one deterministic lowercase SHA-256 digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Fixed reviewed policy path used by every strict fixture control command. */
const fixtureRatePolicyFile = '/private/fixture-rate-policy.json'

/** Complete explicit non-production resource selection used by fixtures. */
const fixtureRequestedResources:
  WorkspaceSearchMigrationRequestedResources = Object.freeze({
    account: '111111111111',
    region: 'us-east-1',
    profile: 'migration-rehearsal-fixture',
    commit: 'a'.repeat(40),
    tables: Object.freeze({
      'project-directory': 'fixture-project-directory',
      'work-items': 'fixture-work-items',
      collaboration: 'fixture-collaboration',
      documents: 'fixture-documents',
      'workspace-search': 'fixture-workspace-search',
      'migration-state': 'fixture-migration-state',
    }),
    journalBucket: 'fixture-migration-journal',
    journalKeyArn:
      'arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012',
  })

/** Exact canonical policy bytes accepted by the strict control parser. */
const fixtureRatePolicyBytes = new TextEncoder().encode(
  serializeCanonicalJson({
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
  }),
)

/**
 * Builds one complete strict control command for an authenticated stage.
 *
 * @param command - Exact existing migration mutation command.
 * @param scenario - Canonical owning rehearsal scenario.
 * @param scenarioStageOrdinal - One-based stage ordinal inside the scenario.
 * @param configurationBindingDigest - Reviewed measured configuration digest.
 * @returns Complete explicit control argument vector accepted by the parser.
 */
function createFixtureControlArguments(
  command: WorkspaceSearchMigrationRehearsalStageCommand,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  scenarioStageOrdinal: number,
  configurationBindingDigest: string,
): readonly string[] {
  const common = [
    command,
    '--account',
    fixtureRequestedResources.account,
    '--region',
    fixtureRequestedResources.region,
    '--profile',
    fixtureRequestedResources.profile,
    '--commit',
    fixtureRequestedResources.commit,
    '--project-directory-table',
    fixtureRequestedResources.tables['project-directory'],
    '--work-items-table',
    fixtureRequestedResources.tables['work-items'],
    '--collaboration-table',
    fixtureRequestedResources.tables.collaboration,
    '--documents-table',
    fixtureRequestedResources.tables.documents,
    '--workspace-search-table',
    fixtureRequestedResources.tables['workspace-search'],
    '--migration-state-table',
    fixtureRequestedResources.tables['migration-state'],
    '--journal-bucket',
    fixtureRequestedResources.journalBucket,
    '--journal-key-arn',
    fixtureRequestedResources.journalKeyArn,
    '--rate-policy-file',
    fixtureRatePolicyFile,
    '--expected-configuration-hash',
    configurationBindingDigest,
    '--run-id',
    `run-${scenario}-${scenarioStageOrdinal}`,
    '--owner-id',
    `owner-${scenario}-${scenarioStageOrdinal}`,
    '--maintenance-evidence-file',
    '/private/fixture-maintenance-evidence.json',
    '--approval',
    workspaceSearchMigrationControlApprovalLiterals[command],
  ]
  if (command !== 'close-replan') return Object.freeze(common)
  return Object.freeze([
    ...common,
    '--reviewed-dry-run-file',
    '/private/fixture-reviewed-dry-run.json',
    '--retain-until',
    '2027-08-02T00:00:00.000Z',
    '--max-total-rows',
    '100000',
    '--max-total-canonical-item-bytes',
    '100000000',
    '--max-plan-operations',
    '100000',
  ])
}

/**
 * Creates one authentic reservation and matching secret-free claimed head.
 *
 * @param selection - Authenticated stage selected by the fixture.
 * @param authenticationKey - Shared 32-byte stage key.
 * @param label - Deterministic nonce label unique to this fixture context.
 * @returns Fresh reservation and exactly matching claimed durable head.
 */
function createFixtureClaimedStageContext(
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalStageRateSegment | null,
  authenticationKey: Uint8Array,
  label: string,
): {
  readonly stageReservation:
    WorkspaceSearchMigrationRehearsalStageReservation
  readonly claimedStageHead:
    WorkspaceSearchMigrationRehearsalStageHead
} {
  const stageReservation =
    createWorkspaceSearchMigrationRehearsalStageReservation({
      selection,
      nonce: createHash('sha256').update(label, 'utf8').digest(),
      reservedAt: '2026-08-02T00:10:00.000Z',
      expiresAt: '2026-08-02T01:40:00.000Z',
      expectedPreviousRateSegment,
      expectedCurrentRateSegmentOrdinal:
        expectedPreviousRateSegment === null
          ? 0
          : expectedPreviousRateSegment.segmentOrdinal + 1,
      expectedTargetPreimageArtifactContentDigest:
        selection.entry.command === 'apply' &&
          (selection.entry.scenario === 'complete-apply-rollback' ||
            selection.entry.scenario === 'partial-apply-rollback')
          ? digest(`target-preimage:${selection.entry.scenario}`)
          : null,
      signingKey: authenticationKey,
    })
  return Object.freeze({
    stageReservation,
    claimedStageHead: Object.freeze({
      manifestDigest: selection.manifestDigest,
      completedStageOrdinal: selection.entry.ordinal - 1,
      headReceiptDigest: selection.previousStageReceiptDigest,
      activeReservationDigest: createMigrationDigest(stageReservation),
      activeStageOrdinal: selection.entry.ordinal,
      activeExpiresAt: stageReservation.expiresAt,
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      revision: selection.entry.ordinal * 2 - 1,
    }),
  })
}

/** Creates one deterministic adapter-proven initial lease observation. */
function createFixtureLeaseAcquisitionObservation(
  label: string,
): WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation {
  return Object.freeze({
    kind: 'acquired',
    predecessorLeaseIdentityDigest: null,
    predecessorLeaseExpiresAt: null,
    acquiredAt: '2026-08-02T00:11:00.000Z',
    successorLeaseIdentityDigest: digest(`lease-identity:${label}`),
    successorLeaseExpiresAt: '2026-08-02T01:45:00.000Z',
  })
}

/** Returns the reviewed exact stage sequence for one scenario. */
function readFixtureStages(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): readonly FixtureStage[] {
  const completed = (
    command: WorkspaceSearchMigrationRehearsalStageCommand,
    attemptOrdinal: number,
  ): FixtureStage => Object.freeze({
    command,
    outcome: 'completed',
    fault: false,
    attemptOrdinal,
  })
  if (scenario === 'happy-path-verified') {
    return Object.freeze([
      completed('close-replan', 1),
      completed('apply', 1),
      completed('verify', 1),
      completed('release', 1),
    ])
  }
  if (scenario === 'complete-apply-rollback') {
    return Object.freeze([
      completed('close-replan', 1),
      completed('apply', 1),
      completed('rollback-complete', 1),
      completed('release', 1),
    ])
  }
  if (scenario === 'partial-apply-rollback') {
    return Object.freeze([
      completed('close-replan', 1),
      Object.freeze({
        command: 'apply',
        outcome: 'fault-reached',
        fault: true,
        attemptOrdinal: 1,
      }),
      Object.freeze({
        command: 'rollback-partial',
        outcome: 'takeover-completed',
        fault: false,
        attemptOrdinal: 2,
      }),
      completed('release', 2),
    ])
  }
  if (scenario === 'transaction-response-loss') {
    return Object.freeze([
      Object.freeze({
        command: 'close-replan',
        outcome: 'response-loss-reconciled',
        fault: true,
        attemptOrdinal: 1,
      }),
      completed('apply', 1),
      completed('verify', 1),
      completed('release', 1),
    ])
  }
  const faultCommand: 'apply' | 'close-replan' =
    scenario === 'artifact-before-checkpoint-kill' ||
      scenario === 'lease-expiry-takeover'
      ? 'close-replan'
      : 'apply'
  const stages: FixtureStage[] = []
  if (faultCommand === 'apply') {
    stages.push(completed('close-replan', 1))
  }
  stages.push(Object.freeze({
    command: faultCommand,
    outcome: 'fault-reached',
    fault: true,
    attemptOrdinal: 1,
  }))
  stages.push(Object.freeze({
    command: faultCommand,
    outcome: 'takeover-completed',
    fault: false,
    attemptOrdinal: 2,
  }))
  if (faultCommand === 'close-replan') {
    stages.push(completed('apply', 2))
  }
  stages.push(completed('verify', 2), completed('release', 2))
  return Object.freeze(stages)
}

/** Creates complete valid reviewed manifest claims for all scenarios. */
function createFixtureManifestClaims(
  permitDigest: string,
  evidenceKeyDigest: string,
  publicationKeyDigest: string,
  requestedResourcesBinding: string,
  configurationBindingDigest: string,
  policyVersion: string,
): WorkspaceSearchMigrationRehearsalStageManifestClaims {
  const entries: WorkspaceSearchMigrationRehearsalStageManifestEntry[] = []
  let ordinal = 1
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const stages = readFixtureStages(scenario)
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]
      if (stage === undefined) throw new Error('Invalid fixture stage.')
      const controlArguments = createFixtureControlArguments(
        stage.command,
        scenario,
        index + 1,
        configurationBindingDigest,
      )
      entries.push(Object.freeze({
        ordinal,
        scenario,
        scenarioStageOrdinal: index + 1,
        command: stage.command,
        controlArgumentsDigest: createMigrationDigest(controlArguments),
        attemptOrdinal: stage.attemptOrdinal,
        faultPlanDigest: stage.fault
          ? digest(`fault-plan:${scenario}`)
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
    permitDigest,
    evidenceKeyDigest,
    publicationKeyDigest,
    deploymentTrustRootDigest: digest('deployment-trust-root'),
    requestedResourcesBinding,
    integrityResourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    integrityResourceIdentities: fixtureIntegrityResourceIdentities,
    integrityResourceIdentityDigest:
      digest('integrity-resource-identity'),
    configurationBindingDigest,
    policyVersion,
    reviewedAt: '2026-08-02T00:00:00.000Z',
    entries: Object.freeze(entries),
  })
}

/**
 * Creates a fresh authentic generic-success global-stage-one fixture.
 *
 * @param options - Optional exact resource and stage overrides.
 * @returns Fresh authenticated child material and owned key fixtures.
 */
export function createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture(
  options: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixtureOptions =
    Object.freeze({}),
): WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture {
  const masterAuthenticationKey = new Uint8Array(32).fill(0x37)
  const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(
    masterAuthenticationKey,
  )
  const authenticationKey = derivedKeys.runtimeKey
  const publicationAuthenticationKey = derivedKeys.publicationKey
  const evidenceKeyDigest = createHash('sha256')
    .update(authenticationKey)
    .digest('hex')
  const publicationKeyDigest = createHash('sha256')
    .update(publicationAuthenticationKey)
    .digest('hex')
  const requestedResourcesBinding =
    options.requestedResourcesBinding ??
      createWorkspaceSearchMigrationRequestedResourcesBinding(
        fixtureRequestedResources,
      )
  const configurationBindingDigest =
    options.configurationBindingDigest ?? digest('configuration')
  const policyVersion = options.policyVersion ?? createHash('sha256')
    .update(fixtureRatePolicyBytes)
    .digest('hex')
  const permit = createWorkspaceSearchMigrationRehearsalPermit({
    claims: Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
      permitVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
      stage: 'non-production',
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
      account: '111111111111',
      productionAccount: '999999999999',
      region: 'us-east-1',
      callerArn:
        'arn:aws:sts::111111111111:assumed-role/Rehearsal/session',
      commit: 'a'.repeat(40),
      requestedResourcesBinding,
      integrityResourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      integrityResourceIdentities: fixtureIntegrityResourceIdentities,
      integrityResourceIdentityDigest:
        digest('integrity-resource-identity'),
      evidenceKeyDigest:
        evidenceKeyDigest,
      publicationKeyDigest,
      deploymentTrustRootDigest: digest('deployment-trust-root'),
      issuedAt: '2026-08-02T00:00:00.000Z',
      expiresAt: '2026-08-02T02:30:00.000Z',
    }),
    signingKey: authenticationKey,
  })
  const manifest = createWorkspaceSearchMigrationRehearsalStageManifest({
    claims: createFixtureManifestClaims(
      createMigrationDigest(permit),
      evidenceKeyDigest,
      publicationKeyDigest,
      requestedResourcesBinding,
      configurationBindingDigest,
      policyVersion,
    ),
    signingKey: authenticationKey,
  })
  const controlArguments = createFixtureControlArguments(
    'close-replan',
    'happy-path-verified',
    1,
    configurationBindingDigest,
  )
  const selection = selectWorkspaceSearchMigrationRehearsalStage({
    manifest,
    verificationKey: authenticationKey,
    previousReceipt: null,
    controlArguments,
    faultPlanDigest: null,
  })
  const claimedStageContext = createFixtureClaimedStageContext(
    selection,
    null,
    authenticationKey,
    'generic-success-stage-reservation',
  )
  const result: WorkspaceSearchMigrationControlCliCoordinatorMutationResult =
    Object.freeze({
      schemaVersion: 1,
      operation: 'close-replan',
      status: 'pass',
      configurationHash: configurationBindingDigest,
      policyVersion,
      coordinator: Object.freeze({
        mode: 'close-replan',
        phase: 'planning-admitted',
        planning: Object.freeze({
          executionBoundaryDigest: digest('execution-boundary'),
          closedWriterFenceRecordDigest: digest('closed-fence'),
          closedAt: '2026-08-02T00:01:00.000Z',
          drainStartedAt: '2026-08-02T00:02:00.000Z',
          drainCompletedAt: '2026-08-02T00:03:00.000Z',
          admittedAt: '2026-08-02T00:04:00.000Z',
          sealedPlanningAuthorityDigest: digest('sealed-authority'),
          planDigest: digest('plan'),
          planOperationCount: 2,
          sourceOperationCount: 1,
          orphanOperationCount: 1,
          planCreatedAt: '2026-08-02T00:05:00.000Z',
          sealedAt: '2026-08-02T00:06:00.000Z',
        }),
      }),
      rateAggregate: Object.freeze({
        version: 1,
        policyVersion,
        attemptCount: 0,
        forfeitedAttemptCount: 0,
        throttleCount: 0,
        budgetStopCount: 0,
        cadenceWaitCount: 0,
        cadenceWaitMilliseconds: 0,
        maximumInFlight: 0,
      }),
    })
  const serializedOutputLine = serializeCanonicalJson(result)
  const observation = Object.freeze({
    result,
    serializedOutputLine,
    serializedOutputLineDigest: createMigrationDigest(serializedOutputLine),
  })
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      authenticationKey,
    )
  const rateHeaderClaims = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 1,
    segmentLocatorDigest: digest('segment-locator'),
    segmentOrdinal: 0,
    previousSegmentDigest: null,
    previousRecordMac: null,
    firstEventSequence: 1,
    anchorUtc: '2026-08-02T00:00:00.000Z',
    authenticationKeyFingerprint,
    policyVersion,
    configurationBindingDigest,
  })
  const headerMac = createHmac('sha256', authenticationKey)
    .update(
      'mukuroji:workspace-search-migration:rehearsal-rate-record:v1',
      'utf8',
    )
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(rateHeaderClaims), 'utf8')
    .digest('hex')
  const canonicalBytes = new TextEncoder().encode(
    `${serializeCanonicalJson({ ...rateHeaderClaims, mac: headerMac })}\n`,
  )
  const committedRateSegment = Object.freeze({
    authenticationKeyFingerprint,
    segmentLocatorDigest: rateHeaderClaims.segmentLocatorDigest,
    segmentOrdinal: 0,
    firstEventSequence: rateHeaderClaims.firstEventSequence,
    eventCount: 0,
    firstCommittedEventSequence: null,
    lastCommittedEventSequence: null,
    terminalRecordMac: headerMac,
    segmentDigest: createHash('sha256').update(canonicalBytes).digest('hex'),
    canonicalBytes,
  })
  return Object.freeze({
    masterAuthenticationKey: new Uint8Array(masterAuthenticationKey),
    authenticationKey: new Uint8Array(authenticationKey),
    publicationAuthenticationKey:
      new Uint8Array(publicationAuthenticationKey),
    permit,
    manifest,
    selection,
    ...claimedStageContext,
    leaseAcquisitionObservation:
      createFixtureLeaseAcquisitionObservation('generic-success'),
    controlArguments,
    observation,
    committedRateSegment,
    configurationBindingDigest,
    policyVersion,
    ratePolicyBytes: new Uint8Array(fixtureRatePolicyBytes),
    ratePolicyFile: fixtureRatePolicyFile,
    requestedResourcesBinding,
  })
}

/**
 * Creates an authentic artifact-kill or response-loss selected-stage fixture.
 *
 * @param responseLoss - Whether to select the two-phase response-loss stage.
 * @param options - Optional resource, configuration, and policy bindings.
 * @returns Manifest, immediate predecessor, plan, observation, and rate bytes.
 */
export function createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
  responseLoss = false,
  options: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixtureOptions =
    Object.freeze({}),
): WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture {
  const base =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture(
      options,
    )
  const key = new Uint8Array(base.authenticationKey)
  const scenario: WorkspaceSearchMigrationRehearsalScenarioName = responseLoss
    ? 'transaction-response-loss'
    : 'artifact-before-checkpoint-kill'
  const faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan = responseLoss
    ? Object.freeze({
        stage: 'non-production',
        approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
        failpoint: 'planning-page-transaction-response-lost',
        target: Object.freeze({
          kind: 'target',
          pageSequence: 2,
          cursorState: 'present',
        }),
      })
    : Object.freeze({
        stage: 'non-production',
        approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
        failpoint:
          'planning-page-artifact-uploaded-before-checkpoint-commit',
        target: Object.freeze({
          kind: 'target',
          pageSequence: 2,
          cursorState: 'present',
        }),
      })
  const entries = base.manifest.entries.map((entry) =>
    entry.scenario === scenario && entry.scenarioStageOrdinal === 1
      ? Object.freeze({
          ...entry,
          faultPlanDigest: createMigrationDigest(faultPlan),
        })
      : entry
  )
  const manifest = createWorkspaceSearchMigrationRehearsalStageManifest({
    claims: Object.freeze({
      kind: base.manifest.kind,
      manifestVersion: base.manifest.manifestVersion,
      stage: base.manifest.stage,
      commit: base.manifest.commit,
      permitDigest: base.manifest.permitDigest,
      evidenceKeyDigest: base.manifest.evidenceKeyDigest,
      publicationKeyDigest: base.manifest.publicationKeyDigest,
      deploymentTrustRootDigest:
        base.manifest.deploymentTrustRootDigest,
      requestedResourcesBinding: base.manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        base.manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities:
        base.manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        base.manifest.integrityResourceIdentityDigest,
      configurationBindingDigest:
        base.manifest.configurationBindingDigest,
      policyVersion: base.manifest.policyVersion,
      reviewedAt: base.manifest.reviewedAt,
      entries: Object.freeze(entries),
    }),
    signingKey: key,
  })
  const entry = manifest.entries.find((candidate) =>
    candidate.scenario === scenario &&
      candidate.scenarioStageOrdinal === 1
  )
  if (entry === undefined) throw new Error('Missing selected fault entry.')
  const previousEntry = manifest.entries[entry.ordinal - 2]
  if (
    previousEntry === undefined ||
    previousEntry.command !== 'release' ||
    previousEntry.expectedOutcome !== 'completed'
  ) throw new Error('Missing predecessor release entry.')
  const manifestDigest = createMigrationDigest(manifest)
  const releasedFenceDigest = digest(`released-fence:${scenario}`)
  const releasedLeaseIdentityDigest =
    digest(`released-lease:${previousEntry.scenario}`)
  const previousRateHeaderClaims = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 1,
    segmentLocatorDigest: digest(`segment:${previousEntry.ordinal}`),
    segmentOrdinal: previousEntry.ordinal - 1,
    previousSegmentDigest: digest(`segment:${previousEntry.ordinal - 1}`),
    previousRecordMac: digest(`segment-mac:${previousEntry.ordinal - 1}`),
    firstEventSequence: 1,
    anchorUtc: '2026-08-02T00:19:00.000Z',
    authenticationKeyFingerprint:
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        key,
      ),
    policyVersion: manifest.policyVersion,
    configurationBindingDigest: manifest.configurationBindingDigest,
  })
  const previousRateHeaderMac = createHmac('sha256', key)
    .update(
      'mukuroji:workspace-search-migration:rehearsal-rate-record:v1',
      'utf8',
    )
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(previousRateHeaderClaims), 'utf8')
    .digest('hex')
  const previousRateCanonicalBytes = new TextEncoder().encode(
    `${serializeCanonicalJson({
      ...previousRateHeaderClaims,
      mac: previousRateHeaderMac,
    })}\n`,
  )
  const previousCommittedRateSegment = Object.freeze({
    authenticationKeyFingerprint:
      previousRateHeaderClaims.authenticationKeyFingerprint,
    segmentLocatorDigest: previousRateHeaderClaims.segmentLocatorDigest,
    segmentOrdinal: previousRateHeaderClaims.segmentOrdinal,
    firstEventSequence: previousRateHeaderClaims.firstEventSequence,
    eventCount: 0,
    firstCommittedEventSequence: null,
    lastCommittedEventSequence: null,
    terminalRecordMac: previousRateHeaderMac,
    segmentDigest: createHash('sha256')
      .update(previousRateCanonicalBytes)
      .digest('hex'),
    canonicalBytes: previousRateCanonicalBytes,
  })
  const {
    canonicalBytes: _previousRateCanonicalBytes,
    ...previousRateSegment
  } = previousCommittedRateSegment
  const previousClaims: WorkspaceSearchMigrationRehearsalStageReceiptClaims = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
    receiptVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
    stage: 'non-production',
    scenario: previousEntry.scenario,
    stageOrdinal: previousEntry.ordinal,
    scenarioStageOrdinal: previousEntry.scenarioStageOrdinal,
    command: 'release',
    controlArgumentsDigest: previousEntry.controlArgumentsDigest,
    serializedOutputLineDigest: digest(`output:${previousEntry.ordinal}`),
    manifestDigest,
    manifestEntryDigest: createMigrationDigest(previousEntry),
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
    runLocatorDigest: digest(`run:${previousEntry.scenario}`),
    attemptOrdinal: previousEntry.attemptOrdinal,
    attemptLocatorDigest:
      digest(`attempt:${previousEntry.scenario}:${previousEntry.attemptOrdinal}`),
    ownerLocatorDigest:
      digest(`owner:${previousEntry.scenario}:${previousEntry.attemptOrdinal}`),
    leaseIdentityDigest: releasedLeaseIdentityDigest,
    leaseObservation: Object.freeze({
      kind: 'reused-active',
      currentLeaseIdentityDigest: releasedLeaseIdentityDigest,
      evaluatedAt: '2026-08-02T00:20:00.000Z',
      currentLeaseExpiresAt: '2026-08-02T00:21:00.000Z',
    }),
    expectedAuthorities: Object.freeze([]),
    writerFenceDigest: releasedFenceDigest,
    previousStageReceiptDigest:
      previousEntry.ordinal === 1 ? null : digest('earlier-stage-receipt'),
    stageReservationDigest:
      digest(`stage-reservation:${previousEntry.ordinal}`),
    stageReservationClaimRevision: previousEntry.ordinal * 2 - 1,
    stageReservationCommitRevision: previousEntry.ordinal * 2,
    stageReservationAbandonmentCount: 0,
    stageReservationAbandonmentRootDigest:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
    startedAt: '2026-08-02T00:20:00.000Z',
    completedAt: '2026-08-02T00:20:08.000Z',
    processLifecycle: Object.freeze({
      lifecycleDigest: digest(`lifecycle:${previousEntry.ordinal}`),
      runnerStartedAt: '2026-08-02T00:20:00.000Z',
      receiptObservedAt: '2026-08-02T00:20:08.000Z',
      receiptPersistedAt: '2026-08-02T00:20:09.000Z',
      parentDecisionRecordedAt: null,
      processExitedAt: '2026-08-02T00:20:10.000Z',
      exitClass: 'successful-no-fault',
    }),
    outcome: 'completed',
    faultReceiptDigest: null,
    faultBoundary: null,
    predecessorLeaseExpiresAt: null,
    takeoverAcquiredAt: null,
    reconciledAt: null,
    evidence: Object.freeze({
      kind: 'released',
      terminalKind: 'verified',
      terminalPersistenceVersion: 1,
      terminalRootDigest: digest(`terminal:${previousEntry.scenario}`),
      releasedWriterFenceRecordDigest: releasedFenceDigest,
      releasedAt: '2026-08-02T00:20:08.000Z',
    }),
    rateSegment: Object.freeze(previousRateSegment),
  }
  const previousReceipt = createWorkspaceSearchMigrationRehearsalStageReceipt({
    claims: previousClaims,
    signingKey: key,
  })
  const controlArguments = createFixtureControlArguments(
    entry.command,
    scenario,
    1,
    manifest.configurationBindingDigest,
  )
  const selection = selectWorkspaceSearchMigrationRehearsalStage({
    manifest,
    verificationKey: key,
    previousReceipt,
    controlArguments,
    faultPlanDigest: createMigrationDigest(faultPlan),
  })
  const expectedPreviousRateSegment = previousReceipt.rateSegment
  const claimedStageContext = createFixtureClaimedStageContext(
    selection,
    expectedPreviousRateSegment,
    key,
    `fault-stage-reservation:${scenario}`,
  )
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      key,
    )
  const rateHeaderClaims = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 1,
    segmentLocatorDigest: digest(`fault-segment:${scenario}`),
    segmentOrdinal: expectedPreviousRateSegment.segmentOrdinal + 1,
    previousSegmentDigest: expectedPreviousRateSegment.segmentDigest,
    previousRecordMac: expectedPreviousRateSegment.terminalRecordMac,
    firstEventSequence:
      expectedPreviousRateSegment.firstEventSequence +
      expectedPreviousRateSegment.eventCount,
    anchorUtc: '2026-08-02T00:21:00.000Z',
    authenticationKeyFingerprint,
    policyVersion: manifest.policyVersion,
    configurationBindingDigest: manifest.configurationBindingDigest,
  })
  const headerMac = createHmac('sha256', key)
    .update(
      'mukuroji:workspace-search-migration:rehearsal-rate-record:v1',
      'utf8',
    )
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(rateHeaderClaims), 'utf8')
    .digest('hex')
  const canonicalBytes = new TextEncoder().encode(
    `${serializeCanonicalJson({ ...rateHeaderClaims, mac: headerMac })}\n`,
  )
  const leaseAcquisitionObservation:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation =
      Object.freeze({
        kind: 'acquired',
        predecessorLeaseIdentityDigest: releasedLeaseIdentityDigest,
        predecessorLeaseExpiresAt: '2026-08-02T00:21:00.000Z',
        acquiredAt: '2026-08-02T00:21:00.000Z',
        successorLeaseIdentityDigest: digest(`lease-identity:${scenario}`),
        successorLeaseExpiresAt: '2026-08-02T00:36:00.000Z',
      })
  const durableHeadPageSequence = responseLoss ? 2 : 1
  const faultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation = Object.freeze({
      observationVersion: 1,
      kind: 'planning-page',
      failpoint: faultPlan.failpoint,
      leaseIdentityDigest:
        leaseAcquisitionObservation.successorLeaseIdentityDigest,
      closedWriterFenceRecordDigest: digest('closed-fence'),
      durableAppliedOperationCount: 0,
      sealedPlanOperationCount: null,
      durableHeadPosition: responseLoss
        ? 'committed-successor'
        : 'predecessor',
      durableHeadPageSequence,
      durableHeadEvidenceDigest:
        digest(`planning-head-evidence:${scenario}:${durableHeadPageSequence}`),
      durableHeadCheckpointDigest:
        digest(`planning-head-checkpoint:${scenario}:${durableHeadPageSequence}`),
      durableHeadProgressDigest:
        digest(`planning-head-progress:${scenario}:${durableHeadPageSequence}`),
      durableHeadCursorState: 'present',
      durableHeadCompleted: false,
      planningTarget: faultPlan.target,
    })
  return Object.freeze({
    masterAuthenticationKey:
      new Uint8Array(base.masterAuthenticationKey),
    authenticationKey: key,
    publicationAuthenticationKey:
      new Uint8Array(base.publicationAuthenticationKey),
    permit: base.permit,
    manifest,
    previousReceipt,
    previousCommittedRateSegment,
    selection,
    ...claimedStageContext,
    leaseAcquisitionObservation,
    faultObservation,
    controlArguments,
    faultPlan,
    observation: base.observation,
    committedRateSegment: Object.freeze({
      authenticationKeyFingerprint,
      segmentLocatorDigest: rateHeaderClaims.segmentLocatorDigest,
      segmentOrdinal: rateHeaderClaims.segmentOrdinal,
      firstEventSequence: rateHeaderClaims.firstEventSequence,
      eventCount: 0,
      firstCommittedEventSequence: null,
      lastCommittedEventSequence: null,
      terminalRecordMac: headerMac,
      segmentDigest:
        createHash('sha256').update(canonicalBytes).digest('hex'),
      canonicalBytes,
    }),
    configurationBindingDigest: manifest.configurationBindingDigest,
    policyVersion: manifest.policyVersion,
    ratePolicyBytes: new Uint8Array(base.ratePolicyBytes),
    ratePolicyFile: base.ratePolicyFile,
  })
}
