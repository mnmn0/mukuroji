import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  ensureStageCommitEvidenceOutputAbsent,
  promoteStageCommitEvidenceIntentExclusive,
  runWorkspaceSearchMigrationRehearsalStageCommitCli,
  writeStageCommitEvidenceFileExclusive,
  type WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
} from './migration-rehearsal-stage-commit-cli'
import {
  createWorkspaceSearchMigrationRehearsalStageCommitEvidence,
  parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_MAX_BYTES,
} from './migration-rehearsal-stage-commit-evidence'
import {
  parseWorkspaceSearchMigrationRehearsalStageCommitIntentDocument,
  verifyWorkspaceSearchMigrationRehearsalStageCommitIntent,
} from './migration-rehearsal-stage-commit-intent'
import {
  captureWorkspaceSearchMigrationRehearsalChildMutationObservation,
  createWorkspaceSearchMigrationRehearsalStageChildMaterial,
  type WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
} from './migration-rehearsal-stage-fault-material'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
} from './migration-rehearsal-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalFaultStageEvidence,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
  type WorkspaceSearchMigrationRehearsalStageReceiptClaims,
} from './migration-rehearsal-stage-receipt'
import type {
  WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  createWorkspaceSearchMigrationRehearsalStageParentAuthentication,
} from './migration-rehearsal-stage-finalizer'

/** Explicit resources bound into the permit, manifest, and stage material. */
const requested: WorkspaceSearchMigrationRequestedResources = {
  account: '111111111111',
  region: 'us-east-1',
  profile: 'stage-commit-cli-test',
  commit: 'a'.repeat(40),
  tables: {
    'project-directory': 'commit-cli-project-directory',
    'work-items': 'commit-cli-work-items',
    collaboration: 'commit-cli-collaboration',
    documents: 'commit-cli-documents',
    'workspace-search': 'commit-cli-workspace-search',
    'migration-state': 'commit-cli-migration-state',
  },
  journalBucket: 'commit-cli-journal-bucket',
  journalKeyArn:
    'arn:aws:kms:us-east-1:111111111111:key/' +
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}

/** Exact canonical version-one reviewed rate-policy document. */
const ratePolicyDocument = Object.freeze({
  schemaVersion: 1,
  maximumAttemptsPerWindow: 1_000,
  maximumAttemptsPerLifecycle: 2_000,
  checkpointPageAttemptCapacity: 182,
  windowMilliseconds: 1_000,
  minimumAttemptIntervalMilliseconds: 1,
  minimumPageIntervalMilliseconds: 1,
  maximumAdmissionWaitMilliseconds: 5_000,
  throttleBackoffInitialMilliseconds: 1,
  throttleBackoffMaximumMilliseconds: 1,
})

/** Exact canonical rate-policy bytes used by every success fixture. */
const ratePolicyBytes = new TextEncoder().encode(
  serializeCanonicalJson(ratePolicyDocument),
)

/** Digest-bound reviewed policy version derived from the exact file. */
const policyVersion = createHash('sha256')
  .update(ratePolicyBytes)
  .digest('hex')

/** Complete private files and authenticated success material for one CLI run. */
type StageCommitCliSuccessFixture = {
  /** Owner-only temporary evidence directory. */
  readonly directory: string
  /** Exact ordered or unordered strict flag vector. */
  readonly arguments: readonly string[]
  /** Final evidence path that starts absent. */
  readonly outputFile: string
  /** Exact permit path used for unsafe-input tests. */
  readonly permitFile: string
  /** Parent-only key authenticating final committed evidence. */
  readonly publicationKey: Uint8Array
  /** Authenticated current stage receipt. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Exact independently authenticated reservation extracted from material. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Reusable authenticated stage fixture. */
  readonly materialFixture:
    WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture
}

/** Complete private files for one stopped-fault or response-loss commit. */
type StageCommitCliFaultFixture = {
  /** Owner-only temporary evidence directory. */
  readonly directory: string
  /** Exact strict flag vector including conditional fault files. */
  readonly arguments: readonly string[]
  /** Final evidence path that starts absent. */
  readonly outputFile: string
  /** Parent-only key authenticating final committed evidence. */
  readonly publicationKey: Uint8Array
  /** Authenticated current fault-stage receipt. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Exact reservation authenticated by the persisted material. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
}

/** Returns one deterministic lowercase SHA-256 digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Returns the durable lease identity represented by one fixture observation. */
function readFixtureLeaseIdentityDigest(
  observation: WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
): string {
  return observation.kind === 'acquired'
    ? observation.successorLeaseIdentityDigest
    : observation.currentLeaseIdentityDigest
}

/**
 * Creates one authentic receipt bound to the fixture's active claim.
 *
 * @param fixture - Authenticated selected-stage material fixture.
 * @param reservation - Exact active reservation committed by the receipt.
 * @param completedAt - Latest authenticated completion evidence timestamp.
 * @returns Frozen HMAC-authenticated stage receipt.
 */
function createStageCommitCliReceipt(
  fixture: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  processLifecycle:
    WorkspaceSearchMigrationRehearsalStageReceipt['processLifecycle'],
  completedAt = '2026-08-02T00:20:00.000Z',
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const entry = fixture.selection.entry
  const closedWriterFenceRecordDigest = digest('cli-closed-writer-fence')
  return createWorkspaceSearchMigrationRehearsalStageReceipt({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
      receiptVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
      stage: 'non-production',
      scenario: entry.scenario,
      stageOrdinal: entry.ordinal,
      scenarioStageOrdinal: entry.scenarioStageOrdinal,
      command: entry.command,
      controlArgumentsDigest: entry.controlArgumentsDigest,
      serializedOutputLineDigest: digest('cli-output-line'),
      manifestDigest: fixture.selection.manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
      permitDigest: fixture.manifest.permitDigest,
      commit: fixture.manifest.commit,
      requestedResourcesBinding: fixture.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        fixture.manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities:
        fixture.manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        fixture.manifest.integrityResourceIdentityDigest,
      configurationBindingDigest: fixture.configurationBindingDigest,
      policyVersion: fixture.policyVersion,
      runLocatorDigest: digest('cli-run-locator'),
      attemptOrdinal: entry.attemptOrdinal,
      attemptLocatorDigest: digest('cli-attempt-locator'),
      ownerLocatorDigest: digest('cli-owner-locator'),
      leaseIdentityDigest: readFixtureLeaseIdentityDigest(
        fixture.leaseAcquisitionObservation,
      ),
      leaseObservation: fixture.leaseAcquisitionObservation,
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest: closedWriterFenceRecordDigest,
      previousStageReceiptDigest: null,
      stageReservationDigest: createMigrationDigest(reservation),
      stageReservationClaimRevision: fixture.claimedStageHead.revision,
      stageReservationCommitRevision:
        fixture.claimedStageHead.revision + 1,
      stageReservationAbandonmentCount:
        fixture.claimedStageHead.abandonmentCount,
      stageReservationAbandonmentRootDigest:
        fixture.claimedStageHead.abandonmentRootDigest,
      startedAt: '2026-08-02T00:10:00.000Z',
      completedAt,
      processLifecycle,
      outcome: entry.expectedOutcome,
      faultReceiptDigest: null,
      faultBoundary: null,
      predecessorLeaseExpiresAt: null,
      takeoverAcquiredAt: null,
      reconciledAt: null,
      evidence: Object.freeze({
        kind: 'planning-sealed',
        executionBoundaryDigest: digest('cli-execution-boundary'),
        closedWriterFenceRecordDigest,
        sealedPlanningAuthorityDigest: digest('cli-sealed-authority'),
        planDigest: digest('cli-plan'),
        sealedPlanOperationCount: 2,
        sourceOperationCount: 1,
        orphanOperationCount: 1,
        closedAt: '2026-08-02T00:11:00.000Z',
        drainStartedAt: '2026-08-02T00:12:00.000Z',
        drainCompletedAt: '2026-08-02T00:13:00.000Z',
        admittedAt: '2026-08-02T00:14:00.000Z',
        planCreatedAt: '2026-08-02T00:15:00.000Z',
        sealedAt: '2026-08-02T00:16:00.000Z',
      }),
      rateSegment: Object.freeze({
        authenticationKeyFingerprint:
          createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
            fixture.authenticationKey,
          ),
        segmentLocatorDigest: digest('cli-segment-locator'),
        segmentOrdinal: 0,
        firstEventSequence: 1,
        eventCount: 0,
        firstCommittedEventSequence: null,
        lastCommittedEventSequence: null,
        terminalRecordMac: digest('cli-segment-terminal-mac'),
        segmentDigest: digest('cli-segment'),
      }),
    },
    signingKey: fixture.authenticationKey,
  })
}

/** Projects one exact cursor-free fault boundary from authenticated material. */
function createStageCommitCliFaultEvidence(
  boundary: WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence {
  return Object.freeze({
    kind: 'fault-boundary',
    failpoint: boundary.faultReceipt.failpoint,
    targetDigest: createMigrationDigest(boundary.faultReceipt.target),
    faultReceiptDigest: boundary.faultReceiptDigest,
    faultObservationDigest: createMigrationDigest(boundary.faultObservation),
    faultObservation: boundary.faultObservation,
    leaseIdentityDigest: readFixtureLeaseIdentityDigest(
      boundary.leaseAcquisitionObservation,
    ),
    appliedOperationCount: 0,
    sealedPlanOperationCount: null,
    targetPreimageArtifactContentDigest: null,
    reachedAt: boundary.faultReceipt.reachedAt,
  })
}

/** Builds valid fault-reached or response-loss receipt claims. */
function createStageCommitCliFaultReceipt(
  fixture: WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
  boundary: WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  completion:
    WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial | null,
  processLifecycle:
    WorkspaceSearchMigrationRehearsalStageReceipt['processLifecycle'],
  completedAt: string,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const entry = fixture.selection.entry
  const faultEvidence = createStageCommitCliFaultEvidence(boundary)
  const responseLoss = completion !== null
  let evidence: WorkspaceSearchMigrationRehearsalStageReceiptClaims['evidence']
  let writerFenceDigest: string
  let serializedOutputLineDigest: string
  if (completion === null) {
    evidence = faultEvidence
    writerFenceDigest = digest('fault-cli-writer-fence')
    serializedOutputLineDigest = digest('fault-cli-output-line')
  } else {
    const coordinator = completion.mutationResult.coordinator
    const planning = coordinator.mode === 'close-replan'
      ? coordinator.planning
      : undefined
    if (planning === undefined) throw new Error('missing planning fixture')
    evidence = Object.freeze({
      kind: 'planning-sealed',
      executionBoundaryDigest: planning.executionBoundaryDigest,
      closedWriterFenceRecordDigest:
        planning.closedWriterFenceRecordDigest,
      sealedPlanningAuthorityDigest:
        planning.sealedPlanningAuthorityDigest,
      planDigest: planning.planDigest,
      sealedPlanOperationCount: planning.planOperationCount,
      sourceOperationCount: planning.sourceOperationCount,
      orphanOperationCount: planning.orphanOperationCount,
      closedAt: planning.closedAt,
      drainStartedAt: planning.drainStartedAt,
      drainCompletedAt: planning.drainCompletedAt,
      admittedAt: planning.admittedAt,
      planCreatedAt: planning.planCreatedAt,
      sealedAt: planning.sealedAt,
    })
    writerFenceDigest = planning.closedWriterFenceRecordDigest
    serializedOutputLineDigest = completion.serializedOutputLineDigest
  }
  const rawRateSegment = completion?.rateSegment ?? boundary.rateSegment
  const rateSegment = Object.freeze({
    authenticationKeyFingerprint:
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        fixture.authenticationKey,
      ),
    segmentLocatorDigest: rawRateSegment.segmentLocatorDigest,
    segmentOrdinal: rawRateSegment.segmentOrdinal,
    firstEventSequence: rawRateSegment.firstEventSequence,
    eventCount: rawRateSegment.eventCount,
    firstCommittedEventSequence:
      rawRateSegment.firstCommittedEventSequence,
    lastCommittedEventSequence:
      rawRateSegment.lastCommittedEventSequence,
    terminalRecordMac: rawRateSegment.terminalRecordMac,
    segmentDigest: rawRateSegment.segmentDigest,
  })
  return createWorkspaceSearchMigrationRehearsalStageReceipt({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
      receiptVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
      stage: 'non-production',
      scenario: entry.scenario,
      stageOrdinal: entry.ordinal,
      scenarioStageOrdinal: entry.scenarioStageOrdinal,
      command: entry.command,
      controlArgumentsDigest: entry.controlArgumentsDigest,
      serializedOutputLineDigest,
      manifestDigest: fixture.selection.manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
      permitDigest: fixture.manifest.permitDigest,
      commit: fixture.manifest.commit,
      requestedResourcesBinding:
        fixture.manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        fixture.manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities:
        fixture.manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        fixture.manifest.integrityResourceIdentityDigest,
      configurationBindingDigest:
        fixture.manifest.configurationBindingDigest,
      policyVersion: fixture.manifest.policyVersion,
      runLocatorDigest: digest(`fault-cli-run:${entry.scenario}`),
      attemptOrdinal: entry.attemptOrdinal,
      attemptLocatorDigest:
        digest(`fault-cli-attempt:${entry.scenario}`),
      ownerLocatorDigest: digest(`fault-cli-owner:${entry.scenario}`),
      leaseIdentityDigest: readFixtureLeaseIdentityDigest(
        fixture.leaseAcquisitionObservation,
      ),
      leaseObservation: fixture.leaseAcquisitionObservation,
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest,
      previousStageReceiptDigest:
        createMigrationDigest(fixture.previousReceipt),
      stageReservationDigest:
        createMigrationDigest(fixture.stageReservation),
      stageReservationClaimRevision: fixture.claimedStageHead.revision,
      stageReservationCommitRevision:
        fixture.claimedStageHead.revision + 1,
      stageReservationAbandonmentCount:
        fixture.claimedStageHead.abandonmentCount,
      stageReservationAbandonmentRootDigest:
        fixture.claimedStageHead.abandonmentRootDigest,
      startedAt: '2026-08-02T00:09:00.000Z',
      completedAt,
      processLifecycle,
      outcome: entry.expectedOutcome,
      faultReceiptDigest: boundary.faultReceiptDigest,
      faultBoundary: faultEvidence,
      predecessorLeaseExpiresAt: null,
      takeoverAcquiredAt: null,
      reconciledAt: responseLoss
        ? '2026-08-02T00:10:20.000Z'
        : null,
      evidence,
      rateSegment,
    },
    signingKey: fixture.authenticationKey,
  })
}

/** Writes one exact private file, forcing owner-only permissions. */
async function writePrivateFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await writeFile(path, bytes, { mode: 0o600 })
  await chmod(path, 0o600)
}

/** Writes one canonical private JSON document. */
async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(
    path,
    new TextEncoder().encode(serializeCanonicalJson(value)),
  )
}

/**
 * Creates one complete authentic global-stage-one CLI filesystem fixture.
 *
 * @param completedAt - Latest authenticated receipt completion timestamp.
 * @returns Owner-only private files and independently authenticated material.
 */
async function createStageCommitCliSuccessFixture(
  completedAt = '2026-08-02T00:20:00.000Z',
): Promise<StageCommitCliSuccessFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mukuroji-stage-commit-'))
  await chmod(directory, 0o700)
  const requestedResourcesBinding =
    createWorkspaceSearchMigrationRequestedResourcesBinding(requested)
  const materialFixture =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
      requestedResourcesBinding,
      configurationBindingDigest: 'c'.repeat(64),
      policyVersion,
    })
  const captured =
    captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
      selection: materialFixture.selection,
      authenticationKey: materialFixture.authenticationKey,
      observation: materialFixture.observation,
    })
  const material = createWorkspaceSearchMigrationRehearsalStageChildMaterial({
    selection: materialFixture.selection,
    observation: captured,
    committedRateSegment: materialFixture.committedRateSegment,
    stageReservation: materialFixture.stageReservation,
    claimedStageHead: materialFixture.claimedStageHead,
    leaseAcquisitionObservation:
      materialFixture.leaseAcquisitionObservation,
    authenticationKey: materialFixture.authenticationKey,
  })
  const materialWrapper = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-child-material-evidence',
    evidenceVersion: 1,
    material,
    materialDigest: createMigrationDigest(material),
    observedAt: completedAt,
  })
  const lifecycle = Object.freeze({
    lifecycleVersion: 1,
    manifestDigest: materialFixture.selection.manifestDigest,
    manifestEntryDigest:
      createMigrationDigest(materialFixture.selection.entry),
    previousStageReceiptDigest:
      materialFixture.selection.previousStageReceiptDigest,
    stageOrdinal: materialFixture.selection.entry.ordinal,
    scenario: materialFixture.selection.entry.scenario,
    command: materialFixture.selection.entry.command,
    attemptOrdinal: materialFixture.selection.entry.attemptOrdinal,
    expectedOutcome: materialFixture.selection.entry.expectedOutcome,
    materialDigest: createMigrationDigest(material),
    stdoutSha256: digest('cli-stdout'),
    runnerStartedAt: '2026-08-02T00:09:00.000Z',
    materialObservedAt: completedAt,
    materialPersistedAt:
      new Date(Math.max(
        Date.parse(completedAt) + 1_000,
        Date.parse('2026-08-02T00:21:00.000Z'),
      )).toISOString(),
    processExitedAt:
      new Date(Math.max(
        Date.parse(completedAt) + 2_000,
        Date.parse('2026-08-02T00:22:00.000Z'),
      )).toISOString(),
    exitClass: 'successful-no-fault',
  })
  const lifecycleDigest = createMigrationDigest(lifecycle)
  const lifecycleWrapper = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
    lifecycle,
    lifecycleSha256: lifecycleDigest,
  })
  await writeFile(
    join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    ),
    materialFixture.authenticationKey,
    { mode: 0o600 },
  )
  let cleanupClockIndex = 0
  const cleanupTimes = Object.freeze([
    new Date(Date.parse(lifecycle.processExitedAt) + 1_000),
    new Date(Date.parse(lifecycle.processExitedAt) + 2_000),
  ])
  const runtimeKeyCleanupAuthorization =
    await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
      evidenceDirectory: directory,
      reservation: materialFixture.stageReservation,
      selection: materialFixture.selection,
      expectedRuntimeKey: materialFixture.authenticationKey,
      publicationAuthenticationKey:
        materialFixture.publicationAuthenticationKey,
      now: (): Date => {
        const value = cleanupTimes[cleanupClockIndex]
        cleanupClockIndex += 1
        if (value === undefined) {
          throw new Error('Unexpected cleanup clock read.')
        }
        return value
      },
    })
  const parentAuthentication =
    createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
      selection: materialFixture.selection,
      materialKind: 'success',
      persistedMaterialEvidence: materialWrapper,
      persistedLifecycleEvidence: lifecycleWrapper,
      runtimeAuthenticationKey:
        new Uint8Array(materialFixture.authenticationKey),
      publicationAuthenticationKey:
        new Uint8Array(materialFixture.publicationAuthenticationKey),
      runtimeKeyCleanupAuthorization,
    })
  const receipt = createStageCommitCliReceipt(
    materialFixture,
    materialFixture.stageReservation,
    Object.freeze({
      lifecycleDigest,
      runnerStartedAt: lifecycle.runnerStartedAt,
      receiptObservedAt: lifecycle.materialObservedAt,
      receiptPersistedAt: lifecycle.materialPersistedAt,
      parentDecisionRecordedAt: null,
      processExitedAt: lifecycle.processExitedAt,
      exitClass: 'successful-no-fault',
    }),
    completedAt,
  )
  const paths = Object.freeze({
    ratePolicyFile: join(directory, 'rate-policy.json'),
    permitFile: join(directory, 'permit.json'),
    rehearsalAuthenticationKeyFile: join(directory, 'rehearsal.key'),
    stageManifestFile: join(directory, 'stage-manifest.json'),
    materialFile: join(directory, 'material.json'),
    lifecycleEvidenceFile: join(directory, 'lifecycle.json'),
    parentAuthenticationFile: join(directory, 'parent-authentication.json'),
    stageReceiptFile: join(directory, 'stage-receipt.json'),
    outputFile: join(directory, 'commit-evidence.json'),
  })
  await Promise.all([
    writePrivateFile(paths.ratePolicyFile, ratePolicyBytes),
    writePrivateJson(paths.permitFile, materialFixture.permit),
    writePrivateFile(
      paths.rehearsalAuthenticationKeyFile,
      materialFixture.masterAuthenticationKey,
    ),
    writePrivateJson(paths.stageManifestFile, materialFixture.manifest),
    writePrivateJson(paths.materialFile, materialWrapper),
    writePrivateJson(paths.lifecycleEvidenceFile, lifecycleWrapper),
    writePrivateJson(paths.parentAuthenticationFile, parentAuthentication),
    writePrivateJson(paths.stageReceiptFile, receipt),
  ])
  return Object.freeze({
    directory,
    arguments: Object.freeze([
      '--account', requested.account,
      '--region', requested.region,
      '--profile', requested.profile,
      '--commit', requested.commit,
      '--project-directory-table', requested.tables['project-directory'],
      '--work-items-table', requested.tables['work-items'],
      '--collaboration-table', requested.tables.collaboration,
      '--documents-table', requested.tables.documents,
      '--workspace-search-table', requested.tables['workspace-search'],
      '--migration-state-table', requested.tables['migration-state'],
      '--journal-bucket', requested.journalBucket,
      '--journal-key-arn', requested.journalKeyArn,
      '--rate-policy-file', paths.ratePolicyFile,
      '--permit-file', paths.permitFile,
      '--rehearsal-authentication-key-file',
      paths.rehearsalAuthenticationKeyFile,
      '--stage-manifest-file', paths.stageManifestFile,
      '--material-file', paths.materialFile,
      '--lifecycle-evidence-file', paths.lifecycleEvidenceFile,
      '--parent-authentication-file', paths.parentAuthenticationFile,
      '--stage-receipt-file', paths.stageReceiptFile,
      '--runtime-key-evidence-directory', directory,
      '--output-file', paths.outputFile,
    ]),
    outputFile: paths.outputFile,
    permitFile: paths.permitFile,
    publicationKey:
      new Uint8Array(materialFixture.publicationAuthenticationKey),
    receipt,
    reservation: materialFixture.stageReservation,
    materialFixture,
  })
}

/** Creates one fully authenticated conditional fault-material CLI fixture. */
async function createStageCommitCliFaultFixture(
  responseLoss: boolean,
): Promise<StageCommitCliFaultFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mukuroji-stage-fault-commit-'))
  await chmod(directory, 0o700)
  const requestedResourcesBinding =
    createWorkspaceSearchMigrationRequestedResourcesBinding(requested)
  const fixture =
    createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
      responseLoss,
      {
        requestedResourcesBinding,
        configurationBindingDigest: 'c'.repeat(64),
        policyVersion,
      },
    )
  const boundary =
    createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
      selection: fixture.selection,
      faultPlan: fixture.faultPlan,
      faultReceipt: Object.freeze({
        receiptVersion: 1,
        stage: 'non-production',
        failpoint: fixture.faultPlan.failpoint,
        action: responseLoss ? 'response-loss' : 'barrier',
        target: fixture.faultPlan.target,
        occurrence: 1,
        reachedAt: '2026-08-02T00:10:00.000Z',
      }),
      committedRateSegment: fixture.committedRateSegment,
      stageReservation: fixture.stageReservation,
      claimedStageHead: fixture.claimedStageHead,
      leaseAcquisitionObservation:
        fixture.leaseAcquisitionObservation,
      faultObservation: Object.freeze({
        observationVersion: 1,
        kind: 'planning-page',
        failpoint: fixture.faultPlan.failpoint,
        leaseIdentityDigest: readFixtureLeaseIdentityDigest(
          fixture.leaseAcquisitionObservation,
        ),
        durableAppliedOperationCount: 0,
        sealedPlanOperationCount: null,
        closedWriterFenceRecordDigest:
          digest(`fault-cli-closed-fence:${fixture.selection.entry.scenario}`),
        durableHeadPosition: responseLoss
          ? 'committed-successor'
          : 'predecessor',
        durableHeadPageSequence: responseLoss ? 2 : 1,
        durableHeadEvidenceDigest:
          digest(`fault-cli-head-evidence:${fixture.selection.entry.scenario}`),
        durableHeadCheckpointDigest:
          digest(`fault-cli-head-checkpoint:${fixture.selection.entry.scenario}`),
        durableHeadProgressDigest:
          digest(`fault-cli-head-progress:${fixture.selection.entry.scenario}`),
        durableHeadCursorState: responseLoss ? 'present' : 'absent',
        durableHeadCompleted: false,
        planningTarget: fixture.faultPlan.target,
      }),
      authenticationKey: fixture.authenticationKey,
    })
  const completion = responseLoss
    ? createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes:
          fixture.committedRateSegment.canonicalBytes,
        observation:
          captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
            selection: fixture.selection,
            authenticationKey: fixture.authenticationKey,
            observation: fixture.observation,
          }),
        committedRateSegment: fixture.committedRateSegment,
        authenticationKey: fixture.authenticationKey,
      })
    : null
  const primaryMaterial = completion ?? boundary
  const primaryWrapper = Object.freeze({
    kind: responseLoss
      ? 'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence'
      : 'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence',
    evidenceVersion: 1,
    material: primaryMaterial,
    materialDigest: createMigrationDigest(primaryMaterial),
    observedAt: responseLoss
      ? '2026-08-02T00:10:30.000Z'
      : '2026-08-02T00:10:10.000Z',
  })
  const boundaryWrapper = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence',
    evidenceVersion: 1,
    material: boundary,
    materialDigest: createMigrationDigest(boundary),
    observedAt: '2026-08-02T00:10:10.000Z',
  })
  const lifecycle = Object.freeze({
    lifecycleVersion: 1,
    manifestDigest: fixture.selection.manifestDigest,
    manifestEntryDigest: createMigrationDigest(fixture.selection.entry),
    previousStageReceiptDigest:
      fixture.selection.previousStageReceiptDigest,
    stageOrdinal: fixture.selection.entry.ordinal,
    scenario: fixture.selection.entry.scenario,
    command: fixture.selection.entry.command,
    attemptOrdinal: fixture.selection.entry.attemptOrdinal,
    expectedOutcome: fixture.selection.entry.expectedOutcome,
    faultPlanDigest: createMigrationDigest(fixture.faultPlan),
    faultReceiptDigest: boundary.faultReceiptDigest,
    boundaryMaterialDigest: createMigrationDigest(boundary),
    completionMaterialDigest:
      completion === null ? null : createMigrationDigest(completion),
    stdoutSha256: digest(`fault-cli-stdout:${fixture.selection.entry.scenario}`),
    materialStreamSha256:
      digest(`fault-cli-material-stream:${fixture.selection.entry.scenario}`),
    runnerStartedAt: '2026-08-02T00:09:00.000Z',
    boundaryMaterialObservedAt: boundaryWrapper.observedAt,
    boundaryMaterialPersistedAt: '2026-08-02T00:10:15.000Z',
    boundaryDecisionRecordedAt: '2026-08-02T00:10:20.000Z',
    completionMaterialObservedAt:
      completion === null ? null : primaryWrapper.observedAt,
    completionMaterialPersistedAt:
      completion === null ? null : '2026-08-02T00:10:40.000Z',
    completionDecisionRecordedAt:
      completion === null ? null : '2026-08-02T00:10:50.000Z',
    processExitedAt: '2026-08-02T00:11:00.000Z',
    exitClass: responseLoss
      ? 'successful-response-loss'
      : 'confirmed-sigkill',
  })
  const lifecycleDigest = createMigrationDigest(lifecycle)
  const lifecycleWrapper = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
    lifecycle,
    lifecycleSha256: lifecycleDigest,
  })
  await writeFile(
    join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    ),
    fixture.authenticationKey,
    { mode: 0o600 },
  )
  let cleanupClockIndex = 0
  const cleanupTimes = Object.freeze([
    new Date(Date.parse(lifecycle.processExitedAt) + 1_000),
    new Date(Date.parse(lifecycle.processExitedAt) + 2_000),
  ])
  const runtimeKeyCleanupAuthorization =
    await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
      evidenceDirectory: directory,
      reservation: fixture.stageReservation,
      selection: fixture.selection,
      expectedRuntimeKey: fixture.authenticationKey,
      publicationAuthenticationKey:
        fixture.publicationAuthenticationKey,
      now: (): Date => {
        const value = cleanupTimes[cleanupClockIndex]
        cleanupClockIndex += 1
        if (value === undefined) {
          throw new Error('Unexpected cleanup clock read.')
        }
        return value
      },
    })
  const parentAuthenticationInput = completion === null
    ? Object.freeze({
        selection: fixture.selection,
        materialKind: 'fault-boundary',
        persistedMaterialEvidence: primaryWrapper,
        faultPlan: fixture.faultPlan,
        boundaryRateSegmentBytes:
          fixture.committedRateSegment.canonicalBytes,
        persistedLifecycleEvidence: lifecycleWrapper,
        runtimeAuthenticationKey:
          new Uint8Array(fixture.authenticationKey),
        publicationAuthenticationKey:
          new Uint8Array(fixture.publicationAuthenticationKey),
        runtimeKeyCleanupAuthorization,
      })
    : Object.freeze({
        selection: fixture.selection,
        materialKind: 'fault-completion',
        persistedMaterialEvidence: primaryWrapper,
        persistedBoundaryMaterialEvidence: boundaryWrapper,
        faultPlan: fixture.faultPlan,
        boundaryRateSegmentBytes:
          fixture.committedRateSegment.canonicalBytes,
        finalRateSegmentBytes:
          fixture.committedRateSegment.canonicalBytes,
        persistedLifecycleEvidence: lifecycleWrapper,
        runtimeAuthenticationKey:
          new Uint8Array(fixture.authenticationKey),
        publicationAuthenticationKey:
          new Uint8Array(fixture.publicationAuthenticationKey),
        runtimeKeyCleanupAuthorization,
      })
  const parentAuthentication =
    createWorkspaceSearchMigrationRehearsalStageParentAuthentication(
      parentAuthenticationInput,
    )
  const primaryObservedAt = completion === null
    ? lifecycle.boundaryMaterialObservedAt
    : lifecycle.completionMaterialObservedAt
  const primaryPersistedAt = completion === null
    ? lifecycle.boundaryMaterialPersistedAt
    : lifecycle.completionMaterialPersistedAt
  const primaryDecisionAt = completion === null
    ? lifecycle.boundaryDecisionRecordedAt
    : lifecycle.completionDecisionRecordedAt
  if (
    primaryObservedAt === null ||
    primaryPersistedAt === null ||
    primaryDecisionAt === null
  ) throw new Error('Missing primary fault lifecycle time.')
  const receipt = createStageCommitCliFaultReceipt(
    fixture,
    boundary,
    completion,
    Object.freeze({
      lifecycleDigest,
      runnerStartedAt: lifecycle.runnerStartedAt,
      receiptObservedAt: primaryObservedAt,
      receiptPersistedAt: primaryPersistedAt,
      parentDecisionRecordedAt: primaryDecisionAt,
      processExitedAt: lifecycle.processExitedAt,
      exitClass: lifecycle.exitClass,
    }),
    primaryObservedAt,
  )
  const paths = Object.freeze({
    ratePolicyFile: join(directory, 'rate-policy.json'),
    permitFile: join(directory, 'permit.json'),
    rehearsalAuthenticationKeyFile: join(directory, 'rehearsal.key'),
    stageManifestFile: join(directory, 'stage-manifest.json'),
    previousReceiptFile: join(directory, 'previous-receipt.json'),
    materialFile: join(directory, 'material.json'),
    lifecycleEvidenceFile: join(directory, 'lifecycle.json'),
    parentAuthenticationFile: join(directory, 'parent-authentication.json'),
    boundaryMaterialFile: join(directory, 'boundary-material.json'),
    stageReceiptFile: join(directory, 'stage-receipt.json'),
    faultPlanFile: join(directory, 'fault-plan.json'),
    boundaryRateSegmentFile: join(directory, 'boundary-rate.ndjson'),
    finalRateSegmentFile: join(directory, 'final-rate.ndjson'),
    outputFile: join(directory, 'commit-evidence.json'),
  })
  const writes: Promise<void>[] = [
    writePrivateFile(paths.ratePolicyFile, ratePolicyBytes),
    writePrivateJson(paths.permitFile, fixture.permit),
    writePrivateFile(
      paths.rehearsalAuthenticationKeyFile,
      fixture.masterAuthenticationKey,
    ),
    writePrivateJson(paths.stageManifestFile, fixture.manifest),
    writePrivateJson(paths.previousReceiptFile, fixture.previousReceipt),
    writePrivateJson(paths.materialFile, primaryWrapper),
    writePrivateJson(paths.lifecycleEvidenceFile, lifecycleWrapper),
    writePrivateJson(paths.parentAuthenticationFile, parentAuthentication),
    writePrivateJson(paths.stageReceiptFile, receipt),
    writePrivateJson(paths.faultPlanFile, fixture.faultPlan),
    writePrivateFile(
      paths.boundaryRateSegmentFile,
      fixture.committedRateSegment.canonicalBytes,
    ),
  ]
  if (responseLoss) {
    writes.push(
      writePrivateJson(paths.boundaryMaterialFile, boundaryWrapper),
      writePrivateFile(
        paths.finalRateSegmentFile,
        fixture.committedRateSegment.canonicalBytes,
      ),
    )
  }
  await Promise.all(writes)
  const faultFlags = responseLoss
    ? [
        '--fault-plan-file', paths.faultPlanFile,
        '--boundary-rate-segment-file', paths.boundaryRateSegmentFile,
        '--boundary-material-file', paths.boundaryMaterialFile,
        '--final-rate-segment-file', paths.finalRateSegmentFile,
      ]
    : [
        '--fault-plan-file', paths.faultPlanFile,
        '--boundary-rate-segment-file', paths.boundaryRateSegmentFile,
      ]
  return Object.freeze({
    directory,
    arguments: Object.freeze([
      '--account', requested.account,
      '--region', requested.region,
      '--profile', requested.profile,
      '--commit', requested.commit,
      '--project-directory-table', requested.tables['project-directory'],
      '--work-items-table', requested.tables['work-items'],
      '--collaboration-table', requested.tables.collaboration,
      '--documents-table', requested.tables.documents,
      '--workspace-search-table', requested.tables['workspace-search'],
      '--migration-state-table', requested.tables['migration-state'],
      '--journal-bucket', requested.journalBucket,
      '--journal-key-arn', requested.journalKeyArn,
      '--rate-policy-file', paths.ratePolicyFile,
      '--permit-file', paths.permitFile,
      '--rehearsal-authentication-key-file',
      paths.rehearsalAuthenticationKeyFile,
      '--stage-manifest-file', paths.stageManifestFile,
      '--previous-receipt-file', paths.previousReceiptFile,
      '--material-file', paths.materialFile,
      '--lifecycle-evidence-file', paths.lifecycleEvidenceFile,
      '--parent-authentication-file', paths.parentAuthenticationFile,
      '--stage-receipt-file', paths.stageReceiptFile,
      '--runtime-key-evidence-directory', directory,
      ...faultFlags,
      '--output-file', paths.outputFile,
    ]),
    outputFile: paths.outputFile,
    publicationKey:
      new Uint8Array(fixture.publicationAuthenticationKey),
    receipt,
    reservation: fixture.stageReservation,
  })
}

/** Creates a full dependency harness around one exact commit result. */
function createStageCommitCliDependencies(
  fixture: Pick<
    StageCommitCliSuccessFixture,
    'receipt' | 'reservation'
  >,
  outcome:
    | 'committed'
    | 'reconciled-after-transport-uncertain' = 'committed',
  stdout: string[] = [],
  stderr: string[] = [],
): WorkspaceSearchMigrationRehearsalStageCommitCliDependencies {
  let clockIndex = 0
  const clockValues = Object.freeze([
    '2026-08-02T00:23:00.000Z',
    '2026-08-02T00:23:10.000Z',
    '2026-08-02T00:23:20.000Z',
    '2026-08-02T00:23:30.000Z',
    '2026-08-02T00:24:00.000Z',
  ])
  return Object.freeze({
    readPrivateInputFile:
      readWorkspaceSearchMigrationRehearsalPrivateInputFile,
    ensureEvidenceOutputAbsent:
      ensureStageCommitEvidenceOutputAbsent,
    readEvidenceIntentFile: async (path) => {
      try {
        await lstat(path)
      } catch {
        return undefined
      }
      return await readWorkspaceSearchMigrationRehearsalPrivateInputFile(
        path,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_MAX_BYTES,
      )
    },
    now: (): Date => {
      const value = clockValues[Math.min(clockIndex, clockValues.length - 1)]
      clockIndex += 1
      if (value === undefined) throw new Error('missing clock fixture')
      return new Date(value)
    },
    commitStageReservation: async (input) => {
      expect(input.requested).toEqual(requested)
      expect(input.ratePolicy.policyVersion).toBe(policyVersion)
      expect(input.stageReservationCommit.reservation).toEqual(
        fixture.reservation,
      )
      expect(input.stageReservationCommit.receipt).toEqual(fixture.receipt)
      input.permitClock()
      const commitAdmittedAt = input.permitClock().toISOString()
      const receiptDigest = createMigrationDigest(fixture.receipt)
      const intent = verifyWorkspaceSearchMigrationRehearsalStageCommitIntent(
        input.stageReservationCommit.commitIntent,
        input.stageReservationCommit.publicationKey,
      )
      const commitEvidence =
        createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
          claims: Object.freeze({
            kind:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
            evidenceVersion: 1,
            stage: 'non-production',
            manifestDigest: intent.manifestDigest,
            permitDigest: intent.permitDigest,
            requestedResourcesBinding: intent.requestedResourcesBinding,
            stateTableLocationBindingDigest:
              intent.stateTableLocationBindingDigest,
            publicationKeyDigest: intent.publicationKeyDigest,
            parentAuthenticationDigest: intent.parentAuthenticationDigest,
            parentAuthorizationBindingDigest:
              intent.parentAuthorizationBindingDigest,
            stageOrdinal: intent.stageOrdinal,
            stageReservationDigest: intent.stageReservationDigest,
            stageReservationClaimRevision:
              intent.stageReservationClaimRevision,
            receiptDigest: intent.receiptDigest,
            commitRevision: intent.commitRevision,
            head: intent.expectedHead,
            commitGate: intent.commitGate,
            recoveryAuthorization: intent.recoveryAuthorization,
            admissionMode: Date.parse(commitAdmittedAt) <
                Date.parse(intent.recoveryAuthorization.reservationExpiresAt)
              ? 'ordinary'
              : 'bounded-recovery',
            commitAdmittedAt,
            durableStatus: 'committed',
          }),
          signingKey: input.stageReservationCommit.publicationKey,
        })
      return Object.freeze({
        transportObservation: outcome === 'committed'
          ? 'transaction-returned'
          : 'exact-strong-read-reconciled',
        head: Object.freeze({
          manifestDigest: fixture.receipt.manifestDigest,
          completedStageOrdinal: fixture.receipt.stageOrdinal,
          headReceiptDigest: receiptDigest,
          activeReservationDigest: null,
          activeStageOrdinal: null,
          activeExpiresAt: null,
          abandonmentCount:
            fixture.receipt.stageReservationAbandonmentCount,
          abandonmentRootDigest:
            fixture.receipt.stageReservationAbandonmentRootDigest,
          revision: fixture.receipt.stageReservationCommitRevision,
        }),
        commitEvidence,
      })
    },
    writeEvidenceFileExclusive:
      writeStageCommitEvidenceFileExclusive,
    promoteEvidenceIntentExclusive:
      promoteStageCommitEvidenceIntentExclusive,
    writeStdoutLine: (line): void => {
      stdout.push(line)
    },
    writeStderrLine: (line): void => {
      stderr.push(line)
    },
  })
}

/** Removes one exact flag and its value from a strict pair vector. */
function removeStageCommitCliFlag(
  arguments_: readonly string[],
  flag: string,
): readonly string[] {
  const result: string[] = []
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (name === undefined || value === undefined) {
      throw new Error('invalid fixture argument pairs')
    }
    if (name !== flag) result.push(name, value)
  }
  return Object.freeze(result)
}

describe('standalone authenticated rehearsal stage commit CLI', () => {
  test('publishes exact canonical mode-0600 inactive-head evidence', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    const stdout: string[] = []
    const stderr: string[] = []
    try {
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        createStageCommitCliDependencies(
          fixture,
          'committed',
          stdout,
          stderr,
        ),
      )).toBe(0)

      const outputBytes = new Uint8Array(await readFile(fixture.outputFile))
      const evidence =
        parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument(
          outputBytes,
          fixture.publicationKey,
        )
      const status = await stat(fixture.outputFile)
      expect(status.mode & 0o7777).toBe(0o600)
      expect(status.nlink).toBe(1)
      expect(evidence).toMatchObject({
        manifestDigest: fixture.receipt.manifestDigest,
        stageOrdinal: fixture.receipt.stageOrdinal,
        receiptDigest: createMigrationDigest(fixture.receipt),
        commitRevision: fixture.receipt.stageReservationCommitRevision,
        commitAdmittedAt: '2026-08-02T00:23:30.000Z',
        durableStatus: 'committed',
        head: {
          activeReservationDigest: null,
          activeStageOrdinal: null,
          activeExpiresAt: null,
        },
      })
      expect(stdout).toHaveLength(1)
      expect(stderr).toEqual([])
      const emitted = `${stdout.join('\n')}\n${stderr.join('\n')}`
      for (const secret of [
        requested.account,
        requested.profile,
        requested.journalBucket,
        requested.tables['migration-state'],
        fixture.outputFile,
      ]) expect(emitted).not.toContain(secret)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('keeps response-loss transport observation outside durable evidence', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    const stdout: string[] = []
    try {
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        createStageCommitCliDependencies(
          fixture,
          'reconciled-after-transport-uncertain',
          stdout,
        ),
      )).toBe(0)
      const evidence =
        parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument(
          new Uint8Array(await readFile(fixture.outputFile)),
          fixture.publicationKey,
        )
      expect(evidence.durableStatus).toBe('committed')
      expect(evidence.commitAdmittedAt).toBe('2026-08-02T00:23:30.000Z')
      expect(stdout.join('\n')).toContain('exact-strong-read-reconciled')
      expect(evidence.head.revision).toBe(
        fixture.receipt.stageReservationCommitRevision,
      )
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('fully verifies stopped-boundary and response-loss material protocols', async () => {
    for (const responseLoss of [false, true]) {
      const fixture = await createStageCommitCliFaultFixture(responseLoss)
      try {
        expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
          fixture.arguments,
          createStageCommitCliDependencies(fixture),
        )).toBe(0)
        const evidence =
          parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument(
            new Uint8Array(await readFile(fixture.outputFile)),
            fixture.publicationKey,
          )
        expect(evidence.stageOrdinal).toBe(fixture.receipt.stageOrdinal)
        expect(evidence.receiptDigest).toBe(
          createMigrationDigest(fixture.receipt),
        )
      } finally {
        await rm(fixture.directory, { recursive: true, force: true })
      }
    }
  })

  test('derives required predecessor and fault files from authenticated selection', async () => {
    const missingPrevious = await createStageCommitCliFaultFixture(false)
    const missingCompletion = await createStageCommitCliFaultFixture(true)
    let commitCalls = 0
    try {
      const previousDependencies =
        createStageCommitCliDependencies(missingPrevious)
      const guardedPrevious:
        WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
          Object.freeze({
            ...previousDependencies,
            commitStageReservation: async (input) => {
              commitCalls += 1
              return await previousDependencies.commitStageReservation(input)
            },
          })
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        removeStageCommitCliFlag(
          missingPrevious.arguments,
          '--previous-receipt-file',
        ),
        guardedPrevious,
      )).toBe(2)

      const completionDependencies =
        createStageCommitCliDependencies(missingCompletion)
      const guardedCompletion:
        WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
          Object.freeze({
            ...completionDependencies,
            commitStageReservation: async (input) => {
              commitCalls += 1
              return await completionDependencies.commitStageReservation(
                input,
              )
            },
          })
      const withoutBoundaryWrapper = removeStageCommitCliFlag(
        missingCompletion.arguments,
        '--boundary-material-file',
      )
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        removeStageCommitCliFlag(
          withoutBoundaryWrapper,
          '--final-rate-segment-file',
        ),
        guardedCompletion,
      )).toBe(2)
      expect(commitCalls).toBe(0)
    } finally {
      await rm(missingPrevious.directory, { recursive: true, force: true })
      await rm(missingCompletion.directory, { recursive: true, force: true })
    }
  })

  test('rejects factory clock regression below the authenticated process exit', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    const stderr: string[] = []
    let clockIndex = 0
    const clockValues = Object.freeze([
      '2026-08-02T00:23:00.000Z',
      '2026-08-02T00:21:59.999Z',
    ])
    try {
      const base = createStageCommitCliDependencies(fixture)
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
          Object.freeze({
            ...base,
            now: (): Date => {
              const value = clockValues[
                Math.min(clockIndex, clockValues.length - 1)
              ]
              clockIndex += 1
              if (value === undefined) throw new Error('missing clock')
              return new Date(value)
            },
            writeStderrLine: (line): void => {
              stderr.push(line)
            },
          })
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        dependencies,
      )).toBe(1)
      expect(stderr.join('\n')).toContain('AUTHENTICATION_FAILED')
      await expect(lstat(fixture.outputFile)).rejects.toThrow()
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('rejects a commit clock behind future authenticated completion evidence', async () => {
    const fixture = await createStageCommitCliSuccessFixture(
      '2026-08-02T00:24:00.000Z',
    )
    const stderr: string[] = []
    let clockIndex = 0
    const clockValues = Object.freeze([
      '2026-08-02T00:23:00.000Z',
      '2026-08-02T00:23:59.999Z',
    ])
    try {
      const base = createStageCommitCliDependencies(fixture)
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
          Object.freeze({
            ...base,
            now: (): Date => {
              const value = clockValues[
                Math.min(clockIndex, clockValues.length - 1)
              ]
              clockIndex += 1
              if (value === undefined) throw new Error('missing clock')
              return new Date(value)
            },
            writeStderrLine: (line): void => {
              stderr.push(line)
            },
          })
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        dependencies,
      )).toBe(1)
      expect(stderr.join('\n')).toContain('AUTHENTICATION_FAILED')
      await expect(lstat(fixture.outputFile)).rejects.toThrow()
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('rejects a returned head that is not the exact inactive successor', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    let promotionCalls = 0
    try {
      const base = createStageCommitCliDependencies(fixture)
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
          Object.freeze({
            ...base,
            commitStageReservation: async (input) => {
              const committed = await base.commitStageReservation(input)
              return Object.freeze({
                transportObservation: committed.transportObservation,
                head: Object.freeze({
                  manifestDigest: fixture.receipt.manifestDigest,
                  completedStageOrdinal: fixture.receipt.stageOrdinal,
                  headReceiptDigest: createMigrationDigest(fixture.receipt),
                  activeReservationDigest: null,
                  activeStageOrdinal: null,
                  activeExpiresAt: null,
                  abandonmentCount:
                    fixture.receipt.stageReservationAbandonmentCount,
                  abandonmentRootDigest:
                    fixture.receipt.stageReservationAbandonmentRootDigest,
                  revision:
                    fixture.receipt.stageReservationCommitRevision + 1,
                }),
                commitEvidence: committed.commitEvidence,
              })
            },
            writeEvidenceFileExclusive: async (output, bytes) => {
              if (output === fixture.outputFile) promotionCalls += 1
              return await base.writeEvidenceFileExclusive(
                output,
                bytes,
              )
            },
          })
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        dependencies,
      )).toBe(1)
      expect(promotionCalls).toBe(0)
      await expect(lstat(fixture.outputFile)).rejects.toThrow()
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('does not replay a confirmed commit after local publication failure', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    let commitCalls = 0
    const stderr: string[] = []
    try {
      const base = createStageCommitCliDependencies(fixture)
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
          Object.freeze({
            ...base,
            commitStageReservation: async (input) => {
              commitCalls += 1
              return await base.commitStageReservation(input)
            },
            writeEvidenceFileExclusive: async (path, bytes) => {
              if (path === fixture.outputFile) {
                throw new Error('local fsync failure')
              }
              return await base.writeEvidenceFileExclusive(path, bytes)
            },
            writeStderrLine: (line): void => {
              stderr.push(line)
            },
          })
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        dependencies,
      )).toBe(1)
      expect(commitCalls).toBe(1)
      expect(stderr.join('\n')).toContain('OUTPUT_FILE_WRITE_FAILED')
      await expect(lstat(fixture.outputFile)).rejects.toThrow()
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('never publishes a never-dispatched prepared intent as committed evidence', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    try {
      const base = createStageCommitCliDependencies(fixture)
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        Object.freeze({
          ...base,
          commitStageReservation: async () => {
            throw new Error('never dispatched')
          },
        }),
      )).toBe(1)
      const intentBytes = new Uint8Array(
        await readFile(`${fixture.outputFile}.intent`),
      )
      const intent =
        parseWorkspaceSearchMigrationRehearsalStageCommitIntentDocument(
          intentBytes,
          fixture.publicationKey,
        )
      expect(intent.intentStatus).toBe('prepared')
      expect(intent.preparedAt).toBe('2026-08-02T00:23:10.000Z')
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument(
          intentBytes,
          fixture.publicationKey,
        )
      ).toThrow('INVALID_REHEARSAL_STAGE_COMMIT_EVIDENCE')
      await expect(lstat(fixture.outputFile)).rejects.toThrow()
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('rejects mismatched existing, symlink, or hardlink output', async () => {
    const kinds: readonly ('existing' | 'hardlink' | 'symlink')[] =
      Object.freeze(['existing', 'hardlink', 'symlink'])
    for (const kind of kinds) {
      const fixture = await createStageCommitCliSuccessFixture()
      let commitCalls = 0
      const stderr: string[] = []
      try {
        if (kind === 'existing') {
          await writePrivateJson(fixture.outputFile, { occupied: true })
        } else if (kind === 'symlink') {
          const target = join(fixture.directory, 'target.json')
          await writePrivateJson(target, { occupied: true })
          await symlink(target, fixture.outputFile)
        } else {
          const target = join(fixture.directory, 'target.json')
          await writePrivateJson(target, { occupied: true })
          await link(target, fixture.outputFile)
        }
        const dependencies = createStageCommitCliDependencies(fixture)
        const guarded:
          WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
            Object.freeze({
              ...dependencies,
              commitStageReservation: async (input) => {
                commitCalls += 1
                return await dependencies.commitStageReservation(input)
              },
              writeStderrLine: (line): void => {
                stderr.push(line)
              },
            })
        expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
          fixture.arguments,
          guarded,
        )).toBe(1)
        expect(commitCalls).toBe(1)
        expect(stderr.join('\n')).toContain('OUTPUT_FILE_EXISTS')
        expect(stderr.join('\n')).not.toContain(fixture.outputFile)
      } finally {
        await rm(fixture.directory, { recursive: true, force: true })
      }
    }
  })

  test('exactly reconciles an already published committed output', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    const stderr: string[] = []
    try {
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        createStageCommitCliDependencies(fixture),
      )).toBe(0)
      const firstBytes = new Uint8Array(await readFile(fixture.outputFile))
      const committedEvidence =
        parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument(
          firstBytes,
          fixture.publicationKey,
        )
      const dependencies = createStageCommitCliDependencies(fixture)
      const retryResult =
        await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        Object.freeze({
          ...dependencies,
          commitStageReservation: async (input) => {
            input.permitClock()
            input.permitClock()
            return Object.freeze({
              transportObservation: 'exact-strong-read-reconciled',
              head: Object.freeze({ ...committedEvidence.head }),
              commitEvidence: committedEvidence,
            })
          },
          writeStderrLine: (line): void => {
            stderr.push(line)
          },
        }),
      )
      expect({ retryResult, stderr }).toEqual({ retryResult: 0, stderr: [] })
      expect(new Uint8Array(await readFile(fixture.outputFile))).toEqual(
        firstBytes,
      )
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('rejects a non-private input without invoking the commit', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    let commitCalls = 0
    const stderr: string[] = []
    try {
      await chmod(fixture.permitFile, 0o640)
      const dependencies = createStageCommitCliDependencies(fixture)
      const guarded:
        WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
          Object.freeze({
            ...dependencies,
            commitStageReservation: async (input) => {
              commitCalls += 1
              return await dependencies.commitStageReservation(input)
            },
            writeStderrLine: (line): void => {
              stderr.push(line)
            },
          })
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        guarded,
      )).toBe(1)
      expect(commitCalls).toBe(0)
      expect(stderr.join('\n')).toContain('INPUT_FILE_INVALID')
      expect(stderr.join('\n')).not.toContain(fixture.permitFile)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('zeroizes every reader and commit-owned key buffer after failure', async () => {
    const fixture = await createStageCommitCliSuccessFixture()
    const returnedBuffers: Uint8Array[] = []
    let forwardedRuntimeKey: Uint8Array | undefined
    let forwardedPublicationKey: Uint8Array | undefined
    try {
      const base = createStageCommitCliDependencies(fixture)
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
          Object.freeze({
            ...base,
            readPrivateInputFile: async (path, maximumBytes) => {
              const bytes =
                await readWorkspaceSearchMigrationRehearsalPrivateInputFile(
                  path,
                  maximumBytes,
                )
              returnedBuffers.push(bytes)
              return bytes
            },
            commitStageReservation: async (input) => {
              forwardedRuntimeKey = input.stageReservationCommit.runtimeKey
              forwardedPublicationKey =
                input.stageReservationCommit.publicationKey
              input.permitClock()
              throw new Error('remote failure')
            },
          })
      expect(await runWorkspaceSearchMigrationRehearsalStageCommitCli(
        fixture.arguments,
        dependencies,
      )).toBe(1)
      expect(returnedBuffers.length).toBeGreaterThan(0)
      for (const bytes of returnedBuffers) {
        expect(bytes.every((value) => value === 0)).toBe(true)
      }
      expect(forwardedRuntimeKey).toBeDefined()
      expect(forwardedRuntimeKey?.every((value) => value === 0)).toBe(true)
      expect(forwardedPublicationKey).toBeDefined()
      expect(
        forwardedPublicationKey?.every((value) => value === 0),
      ).toBe(true)
      await expect(lstat(fixture.outputFile)).rejects.toThrow()
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })
})
