import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  CreateWorkspaceSearchMigrationControlCliReadSessionInput,
  WorkspaceSearchMigrationControlCliDependencies,
} from './migration-control-cli'
import type {
  CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
  WorkspaceSearchMigrationNonProductionRehearsalAwsSession,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
} from './migration-identity'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
  type WorkspaceSearchMigrationRehearsalPermitFileStatus,
  type WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies,
} from './migration-rehearsal-permit-cli'
import {
  parseWorkspaceSearchMigrationRehearsalFaultReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS,
  type WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  parseWorkspaceSearchMigrationRehearsalControlCliArguments,
  parseWorkspaceSearchMigrationRehearsalControlFaultReceiptLine,
  parseWorkspaceSearchMigrationRehearsalResponseLossAcknowledgement,
  runWorkspaceSearchMigrationRehearsalControlCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_FAULT_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_FILE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KEY_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION,
  type WorkspaceSearchMigrationRehearsalControlCliDependencies,
  type WorkspaceSearchMigrationRehearsalControlFaultReceiptLine,
  type WorkspaceSearchMigrationRehearsalNoFaultScenario,
  type WorkspaceSearchMigrationRehearsalResponseLossAcknowledgement,
} from './migration-rehearsal-control-cli'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  verifyWorkspaceSearchMigrationRehearsalStageChildMaterial,
  type WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
import {
  verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  type WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-stage-fault-material'
import type {
  WorkspaceSearchMigrationRehearsalSelectedStage,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalRateRecorder,
} from './migration-rehearsal-rate-evidence'
import type {
  CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  WorkspaceSearchMigrationRehearsalRateRuntime,
} from './migration-rehearsal-rate-runtime'

const permitPath = '/restricted/rehearsal-permit.json'
const keyPath = '/restricted/rehearsal-permit.key'
const faultPlanPath = '/restricted/rehearsal-fault-plan.json'
const rateSegmentPath = '/restricted/rate-segment.ndjson'
const previousRateSegmentPath = '/restricted/rate-segment-previous.ndjson'
const stageManifestPath = '/restricted/stage-manifest.json'
const previousStageReceiptPath = '/restricted/previous-stage-receipt.json'
const stageKeyPath = '/restricted/stage.key'
const stageReservationPath = '/restricted/stage-reservation.json'
const rateConfigurationHash = 'c'.repeat(64)
const textEncoder = new TextEncoder()
const permitBytes = textEncoder.encode(
  serializeCanonicalJson({ permit: 'parsed-document' }),
)

/** Builds the legacy direct child preamble that must always be rejected. */
function createRehearsalArguments(
  includeFaultPlan = false,
  includePreviousRateSegment = false,
  noFaultScenario?: WorkspaceSearchMigrationRehearsalNoFaultScenario,
): string[] {
  return [
    '--rehearsal-permit-file',
    permitPath,
    '--rehearsal-permit-key-file',
    keyPath,
    '--rehearsal-rate-segment-file',
    rateSegmentPath,
    '--rehearsal-rate-configuration-hash',
    rateConfigurationHash,
    ...(includePreviousRateSegment
      ? [
          '--rehearsal-rate-previous-segment-file',
          previousRateSegmentPath,
        ]
      : []),
    ...(includeFaultPlan
      ? ['--rehearsal-fault-plan-file', faultPlanPath]
      : []),
    ...(noFaultScenario === undefined
      ? []
      : ['--rehearsal-no-fault-scenario', noFaultScenario]),
    '--',
    noFaultScenario === 'happy-path-verified'
      ? 'verify'
      : noFaultScenario === 'complete-apply-rollback'
        ? 'rollback-complete'
        : 'measure',
  ]
}

/** Builds the exact authenticated generic-success child command. */
function createSuccessfulRehearsalArguments(
  controlArguments: readonly string[],
  configurationBindingDigest: string,
): string[] {
  return [
    '--rehearsal-permit-file',
    permitPath,
    '--rehearsal-permit-key-file',
    keyPath,
    '--rehearsal-rate-segment-file',
    rateSegmentPath,
    '--rehearsal-rate-configuration-hash',
    configurationBindingDigest,
    '--rehearsal-stage-manifest-file',
    stageManifestPath,
    '--rehearsal-stage-key-file',
    stageKeyPath,
    '--rehearsal-stage-reservation-file',
    stageReservationPath,
    '--rehearsal-success-protocol',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION,
    '--',
    ...controlArguments,
  ]
}

/** Builds one exact authenticated fault-stage child command. */
function createAuthenticatedFaultRehearsalArguments(
  fixture: WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
  includePreviousRateSegment = false,
): string[] {
  return [
    '--rehearsal-permit-file',
    permitPath,
    '--rehearsal-permit-key-file',
    keyPath,
    '--rehearsal-rate-segment-file',
    rateSegmentPath,
    '--rehearsal-rate-configuration-hash',
    fixture.configurationBindingDigest,
    ...(includePreviousRateSegment
      ? [
          '--rehearsal-rate-previous-segment-file',
          previousRateSegmentPath,
        ]
      : []),
    '--rehearsal-stage-manifest-file',
    stageManifestPath,
    '--rehearsal-previous-stage-receipt-file',
    previousStageReceiptPath,
    '--rehearsal-stage-key-file',
    stageKeyPath,
    '--rehearsal-stage-reservation-file',
    stageReservationPath,
    '--rehearsal-fault-plan-file',
    faultPlanPath,
    '--',
    ...fixture.controlArguments,
  ]
}

/** Creates one nonzero exact-length raw permit key. */
function createPermitKey(): Uint8Array {
  return Uint8Array.from(
    { length: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KEY_BYTES },
    (_value, index) => index + 1,
  )
}

/** Builds one typed control-session request without performing AWS work. */
function createControlSessionInput():
  CreateWorkspaceSearchMigrationControlCliReadSessionInput {
  return {
    resources: {
      account: '123456789012',
      region: 'ap-northeast-1',
      profile: 'rehearsal-operator',
      commit: 'a'.repeat(40),
      tables: {
        'project-directory': 'project-directory-table',
        'work-items': 'work-items-table',
        collaboration: 'collaboration-table',
        documents: 'documents-table',
        'workspace-search': 'workspace-search-table',
        'migration-state': 'migration-state-table',
      },
      journalBucket: 'rehearsal-journal',
      journalKeyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/rehearsal',
    },
    ratePolicy: {
      policyVersion: 'b'.repeat(64),
      maximumAttemptsPerWindow: 400,
      maximumAttemptsPerLifecycle: 400,
      checkpointPageAttemptCapacity: 182,
      windowMilliseconds: 1_000,
      minimumAttemptIntervalMilliseconds: 20,
      minimumPageIntervalMilliseconds: 1_000,
      maximumAdmissionWaitMilliseconds: 30_000,
      throttleBackoffInitialMilliseconds: 100,
      throttleBackoffMaximumMilliseconds: 2_000,
    },
    rateBootstrap: false,
    rateRecoverInterruptedCleanup: false,
    rateRecoverInterruptedAttempt: false,
  }
}

/**
 * Builds one strict plan for any failpoint currently exported by the runtime.
 *
 * @param failpoint - Current finite runtime failpoint literal.
 * @returns Canonicalizable strict plan candidate.
 */
function createFaultPlan(failpoint: string): unknown {
  const guard = {
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  }
  switch (failpoint) {
    case 'planning-page-artifact-uploaded-before-checkpoint-commit':
    case 'planning-page-transaction-response-lost':
      return {
        ...guard,
        failpoint,
        target: {
          kind: 'source',
          source: 'project-directory',
          pageSequence: 1,
          cursorState: 'present',
        },
      }
    case 'apply-checkpoint-cursor-captured-before-commit':
    case 'apply-checkpoint-cursor-committed-before-return':
      return {
        ...guard,
        failpoint,
        target: {
          kind: 'apply-checkpoint',
          location: 'target',
          pageSequence: 1,
          cursorState: 'present',
        },
      }
    case 'apply-operation-committed-before-return':
      return {
        ...guard,
        failpoint,
        target: {
          kind: 'apply-operation',
          planSequence: 1,
          remainingOperations: 'present',
        },
      }
    case 'lease-acquired-before-first-heartbeat':
      return {
        ...guard,
        failpoint,
        target: { kind: 'planning-lease' },
      }
    default:
      throw new Error('Unhandled rehearsal failpoint fixture.')
  }
}

/** Serializes one current runtime fault plan to exact canonical bytes. */
function createFaultPlanBytes(failpoint: string): Uint8Array {
  return textEncoder.encode(serializeCanonicalJson(createFaultPlan(failpoint)))
}

/** Builds one exact secret-free planning-page runtime receipt. */
function createPlanningReceipt(
  failpoint:
    | 'planning-page-artifact-uploaded-before-checkpoint-commit'
    | 'planning-page-transaction-response-lost',
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  return parseWorkspaceSearchMigrationRehearsalFaultReceipt({
    receiptVersion: 1,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    failpoint,
    action: failpoint === 'planning-page-transaction-response-lost'
      ? 'response-loss'
      : 'barrier',
    target: {
      kind: 'source',
      source: 'project-directory',
      pageSequence: 1,
      cursorState: 'present',
    },
    occurrence: 1,
    reachedAt: '2026-08-02T00:00:00.000Z',
  })
}

/** Creates exact private-file bytes for one authenticated fault invocation. */
function createAuthenticatedFaultFiles(
  fixture: WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
  permitKey: Uint8Array,
  stageKey: Uint8Array = permitKey,
  faultPlanBytes: Uint8Array = textEncoder.encode(
    serializeCanonicalJson(fixture.faultPlan),
  ),
): ReadonlyMap<string, Uint8Array> {
  return new Map([
    [permitPath, textEncoder.encode(serializeCanonicalJson(fixture.permit))],
    [keyPath, permitKey],
    [stageManifestPath, textEncoder.encode(
      serializeCanonicalJson(fixture.manifest),
    )],
    [previousStageReceiptPath, textEncoder.encode(
      serializeCanonicalJson(fixture.previousReceipt),
    )],
    [stageKeyPath, stageKey],
    [stageReservationPath, textEncoder.encode(
      serializeCanonicalJson(fixture.stageReservation),
    )],
    [faultPlanPath, faultPlanBytes],
  ])
}

/** Creates the exact runtime receipt selected by one fault-stage fixture. */
function createFixtureFaultReceipt(
  fixture: WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  return parseWorkspaceSearchMigrationRehearsalFaultReceipt({
    receiptVersion: 1,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    failpoint: fixture.faultPlan.failpoint,
    action: fixture.faultPlan.failpoint ===
        'planning-page-transaction-response-lost'
      ? 'response-loss'
      : 'barrier',
    target: fixture.faultPlan.target,
    occurrence: 1,
    reachedAt: '2026-08-02T00:12:00.000Z',
  })
}

/**
 * Creates the minimal managed read-session surface exercised by this wrapper.
 *
 * @param input - Session input containing the child-created reservation claim.
 * @param selection - Exact authenticated stage expected by the test.
 * @param leaseObservation - Exact adapter-proven lease observation to expose.
 * @param faultObservation - Exact adapter-proven fault observation to expose.
 * @returns Test-only non-production session exposing the matching claimed head.
 */
function createClaimedReadSession(
  input: CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  leaseObservation:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
  faultObservation?: WorkspaceSearchMigrationRehearsalFaultObservation,
): WorkspaceSearchMigrationNonProductionRehearsalAwsSession {
  const claim = input.stageReservationClaim
  if (claim === undefined) throw new Error('Missing stage reservation claim.')
  const reservation = claim.reservation
  if (
    typeof reservation !== 'object' ||
    reservation === null ||
    Array.isArray(reservation)
  ) throw new Error('Invalid stage reservation fixture.')
  const expiresAtDescriptor = Object.getOwnPropertyDescriptor(
    reservation,
    'expiresAt',
  )
  const expiresAt: unknown = expiresAtDescriptor?.value
  if (typeof expiresAt !== 'string') {
    throw new Error('Missing stage reservation expiry.')
  }
  const head = Object.freeze({
    manifestDigest: selection.manifestDigest,
    completedStageOrdinal: selection.entry.ordinal - 1,
    headReceiptDigest: selection.previousStageReceiptDigest,
    activeReservationDigest: createMigrationDigest(reservation),
    activeStageOrdinal: selection.entry.ordinal,
    activeExpiresAt: expiresAt,
    abandonmentCount: 0,
    abandonmentRootDigest:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
    revision: selection.entry.ordinal * 2 - 1,
  })
  let pendingLeaseObservation:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation | undefined =
      leaseObservation
  let pendingFaultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation | undefined =
      faultObservation
  const pendingAuthorityAdoptionObservations = [{
    maintenanceEvidenceRenewalCount: 1,
    receiptDigest: createMigrationDigest({
      purpose: 'authority-adoption-test-observation',
      stageOrdinal: selection.entry.ordinal,
    }),
  }]
  const candidate: unknown = {
    close: async (): Promise<void> => {},
    measureConfiguration: async (): Promise<Readonly<Record<string, never>>> =>
      Object.freeze({}),
    createApplicationWriterFencePort: (): Readonly<Record<string, never>> =>
      Object.freeze({}),
    readDescribeTableRateEvidence: () => Object.freeze({
      version: 1,
      policyVersion: selection.manifest.policyVersion,
      attemptCount: 0,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 0,
    }),
    interruptDescribeTableRate: (): void => {},
    readRehearsalClaimedStageHead: () => head,
    takeRehearsalLeaseAcquisitionObservation: () => {
      const observation = pendingLeaseObservation
      pendingLeaseObservation = undefined
      return observation
    },
    takeRehearsalAuthorityAdoptionObservation: () =>
      pendingAuthorityAdoptionObservations.shift(),
    takeRehearsalFaultObservation: () => {
      const observation = pendingFaultObservation
      pendingFaultObservation = undefined
      return observation
    },
  }
  if (!isClaimedReadSession(candidate)) {
    throw new Error('Invalid claimed read session fixture.')
  }
  return candidate
}

/** Narrows the test-only read projection to the production session contract. */
function isClaimedReadSession(
  value: unknown,
): value is WorkspaceSearchMigrationNonProductionRehearsalAwsSession {
  if (typeof value !== 'object' || value === null) return false
  for (const property of [
    'close',
    'createApplicationWriterFencePort',
    'interruptDescribeTableRate',
    'measureConfiguration',
    'readDescribeTableRateEvidence',
    'readRehearsalClaimedStageHead',
    'takeRehearsalAuthorityAdoptionObservation',
    'takeRehearsalLeaseAcquisitionObservation',
    'takeRehearsalFaultObservation',
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, property)
    if (descriptor === undefined || typeof descriptor.value !== 'function') {
      return false
    }
  }
  return true
}

/**
 * Creates AWS-free child dependencies over exact in-memory file bytes.
 *
 * @param files - Private path-to-byte fixtures.
 * @param runControlCli - Injected existing control runner.
 * @param onSessionInput - Optional inspection before construction rejection.
 * @param waitForParentKill - Injected external kill barrier.
 * @param waitForParentResponseLossAcknowledgement - Injected durable ACK gate.
 * @param committedRateSegment - Optional authentic rate segment fixture.
 * @param claimedStageSelection - Optional stage enabling a successful claim.
 * @param leaseObservation - Adapter-proven lease observation for that claim.
 * @param faultObservation - Adapter-proven fault observation for that claim.
 * @returns Recording dependencies and captured boundary values.
 */
function createTestDependencies(
  files: ReadonlyMap<string, Uint8Array>,
  runControlCli:
    WorkspaceSearchMigrationRehearsalControlCliDependencies['runControlCli'] =
      async () => 0,
  onSessionInput?: (
    input: CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
  ) => Promise<void>,
  waitForParentKill: () => Promise<void> = async () => {},
  waitForParentResponseLossAcknowledgement: (
    receiptSha256: string,
    finalAcknowledgement?: boolean,
  ) => Promise<void> = async () => {},
  committedRateSegment?: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  claimedStageSelection?: WorkspaceSearchMigrationRehearsalSelectedStage,
  leaseObservation?:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
  faultObservation?: WorkspaceSearchMigrationRehearsalFaultObservation,
) {
  const reads: Array<readonly [string, number]> = []
  const keyReads: string[] = []
  const stderrLines: string[] = []
  const faultReceiptLines: string[] = []
  const sessionInputs:
    CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput[] = []
  const keySnapshots: Uint8Array[] = []
  const boundaryEvents: string[] = []
  const rateRuntimeInputs:
    CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput[] = []
  const rateRuntimeKeySnapshots: Uint8Array[] = []
  const rateRecorders: WorkspaceSearchMigrationRehearsalRateRecorder[] = []
  let rateFlushFailure = false
  const constructionFailure = new Error('session construction stopped')
  const dependencies:
    WorkspaceSearchMigrationRehearsalControlCliDependencies = {
      readInputFile: async (path, maximumBytes) => {
        reads.push([path, maximumBytes])
        const bytes = files.get(path)
        if (bytes === undefined) throw new Error('raw private path failure')
        return bytes
      },
      readPermitKeyFile: async (path) => {
        keyReads.push(path)
        const bytes = files.get(path)
        if (bytes === undefined) throw new Error('raw private key failure')
        return bytes
      },
      createRehearsalSession: async (input) => {
        sessionInputs.push(input)
        keySnapshots.push(Uint8Array.from(input.permitVerificationKey))
        if (onSessionInput !== undefined) await onSessionInput(input)
        if (claimedStageSelection !== undefined) {
          if (leaseObservation === undefined) {
            throw new Error('Missing lease observation fixture.')
          }
          return createClaimedReadSession(
            input,
            claimedStageSelection,
            leaseObservation,
            faultObservation,
          )
        }
        throw constructionFailure
      },
      createRateRuntime: async (input) => {
        rateRuntimeInputs.push(input)
        rateRuntimeKeySnapshots.push(Uint8Array.from(input.authenticationKey))
        const recorder: WorkspaceSearchMigrationRehearsalRateRecorder = {
          record: () => {},
          appendForfeitedAttempt: async () => {},
          appendForfeitedReservation: async () => {},
          flush: async () => committedRateSegment ?? ({
              authenticationKeyFingerprint:
                createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
                  input.authenticationKey,
                ),
              segmentLocatorDigest: 'd'.repeat(64),
              segmentOrdinal: 0,
              firstEventSequence: 1,
              eventCount: 2,
              firstCommittedEventSequence: 1,
              lastCommittedEventSequence: 2,
              terminalRecordMac: 'e'.repeat(64),
              segmentDigest: 'f'.repeat(64),
              canonicalBytes: new Uint8Array(),
            }),
          close: async () => {},
        }
        rateRecorders.push(recorder)
        const runtime: WorkspaceSearchMigrationRehearsalRateRuntime = {
          recorder,
          flush: async () => {
            boundaryEvents.push('rate-flush')
            if (rateFlushFailure) throw new Error('raw flush failure')
            return await recorder.flush()
          },
          close: async () => {
            boundaryEvents.push('rate-close')
          },
        }
        return runtime
      },
      clock: () => new Date('2026-08-02T00:10:00.000Z'),
      runControlCli,
      writeStderrLine: (line) => {
        stderrLines.push(line)
      },
      writeFaultReceiptLine: (line) => {
        boundaryEvents.push('fault-receipt')
        faultReceiptLines.push(line)
      },
      waitForParentKill,
      waitForParentResponseLossAcknowledgement,
    }
  return {
    boundaryEvents,
    constructionFailure,
    dependencies,
    faultReceiptLines,
    keySnapshots,
    keyReads,
    rateRecorders,
    rateRuntimeInputs,
    rateRuntimeKeySnapshots,
    reads,
    sessionInputs,
    stderrLines,
    failRateFlush: (): void => {
      rateFlushFailure = true
    },
  }
}

/** Security mutation exercised against the reused no-follow key reader. */
type SecurePermitKeyFailureScenario =
  | 'final-symlink'
  | 'wrong-owner'
  | 'wrong-mode'
  | 'wrong-size'
  | 'not-regular'
  | 'inode-change'
  | 'mtime-change'
  | 'extra-byte'
  | 'read-failure'

/** Complete secure key-boundary failure matrix required by the child CLI. */
const securePermitKeyFailureScenarios:
  SecurePermitKeyFailureScenario[] = [
    'final-symlink',
    'wrong-owner',
    'wrong-mode',
    'wrong-size',
    'not-regular',
    'inode-change',
    'mtime-change',
    'extra-byte',
    'read-failure',
  ]

/** Injectable secure-reader fixture and its exposed bounded work buffers. */
type SecurePermitKeyReaderHarness = {
  /** Exact no-follow reader dependencies passed to the reused implementation. */
  readonly dependencies:
    WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies
  /** Bounded internal buffers observed only by the fake file read boundary. */
  readonly workingBuffers: Uint8Array[]
}

/**
 * Builds one deterministic filesystem failure around the production secure
 * signing-key reader reused by the child control CLI.
 *
 * @param scenario - Exact symlink, metadata, stability, or read failure.
 * @returns Injectable boundary plus buffers available for zeroization checks.
 */
function createSecurePermitKeyReaderHarness(
  scenario: SecurePermitKeyFailureScenario,
): SecurePermitKeyReaderHarness {
  const workingBuffers: Uint8Array[] = []
  const sourceKey = createPermitKey()
  let statCalls = 0
  let readCalls = 0
  const dependencies:
    WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies = {
      currentUserId: () => 501,
      openFileNoFollow: async () => {
        if (scenario === 'final-symlink') {
          throw new Error('raw symlink path failure')
        }
        return {
          stat: async () => {
            statCalls += 1
            const status: WorkspaceSearchMigrationRehearsalPermitFileStatus = {
              device: 1,
              inode: scenario === 'inode-change' && statCalls > 1 ? 11 : 10,
              ownerUserId: scenario === 'wrong-owner' ? 502 : 501,
              mode: scenario === 'wrong-mode' ? 0o100640 : 0o100600,
              size: scenario === 'wrong-size' ? 31 : 32,
              changedAtMilliseconds: 1,
              modifiedAtMilliseconds:
                scenario === 'mtime-change' && statCalls > 1 ? 2 : 1,
              regularFile: scenario !== 'not-regular',
            }
            return status
          },
          read: async (buffer, offset, length) => {
            workingBuffers.push(buffer)
            readCalls += 1
            if (scenario === 'read-failure') {
              throw new Error('raw key read failure')
            }
            if (readCalls > 1) return 0
            if (scenario === 'extra-byte') {
              const bytesToRead = Math.min(length, sourceKey.byteLength + 1)
              buffer.set(sourceKey.slice(0, Math.min(32, bytesToRead)), offset)
              if (bytesToRead > sourceKey.byteLength) {
                buffer[offset + sourceKey.byteLength] = 255
              }
              return bytesToRead
            }
            const bytesToRead = Math.min(length, sourceKey.byteLength)
            buffer.set(sourceKey.slice(0, bytesToRead), offset)
            return bytesToRead
          },
          close: async () => {},
        }
      },
    }
  return { dependencies, workingBuffers }
}

/** Invokes one projected read factory and absorbs its test constructor failure. */
async function invokeRejectedReadFactory(
  dependencies: WorkspaceSearchMigrationControlCliDependencies,
  expectedFailure: Error,
): Promise<void> {
  try {
    await dependencies.createReadSession(createControlSessionInput())
  } catch (error: unknown) {
    expect(error).toBe(expectedFailure)
    return
  }
  throw new Error('Expected rehearsal session construction to fail.')
}

describe('Workspace Search migration rehearsal control CLI parser', () => {
  test('parses only the exact ordered preamble and detached control arguments', () => {
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalControlCliArguments(
        createRehearsalArguments(),
      )
    ).toThrow('INVALID_USAGE')
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalControlCliArguments(
        createRehearsalArguments(
          false,
          false,
          'happy-path-verified',
        ),
      )
    ).toThrow('INVALID_USAGE')
    const faultFixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    expect(
      parseWorkspaceSearchMigrationRehearsalControlCliArguments(
        createAuthenticatedFaultRehearsalArguments(faultFixture),
      ),
    ).toEqual({
      permitFile: permitPath,
      permitKeyFile: keyPath,
      rateSegmentFile: rateSegmentPath,
      rateConfigurationHash: faultFixture.configurationBindingDigest,
      stageManifestFile: stageManifestPath,
      previousStageReceiptFile: previousStageReceiptPath,
      stageKeyFile: stageKeyPath,
      stageReservationFile: stageReservationPath,
      faultPlanFile: faultPlanPath,
      controlArguments: faultFixture.controlArguments,
    })
    expect(
      parseWorkspaceSearchMigrationRehearsalControlCliArguments(
        createAuthenticatedFaultRehearsalArguments(faultFixture, true),
      ),
    ).toEqual({
      permitFile: permitPath,
      permitKeyFile: keyPath,
      rateSegmentFile: rateSegmentPath,
      rateConfigurationHash: faultFixture.configurationBindingDigest,
      ratePreviousSegmentFile: previousRateSegmentPath,
      stageManifestFile: stageManifestPath,
      previousStageReceiptFile: previousStageReceiptPath,
      stageKeyFile: stageKeyPath,
      stageReservationFile: stageReservationPath,
      faultPlanFile: faultPlanPath,
      controlArguments: faultFixture.controlArguments,
    })

    for (const invalid of [
      [],
      ['--rehearsal-permit-file', permitPath],
      createRehearsalArguments(true),
      [
        '--rehearsal-permit-key-file',
        keyPath,
        '--rehearsal-permit-file',
        permitPath,
        '--',
        'measure',
      ],
      [
        ...createRehearsalArguments(
          false,
          false,
          'complete-apply-rollback',
        ).slice(0, -1),
        'verify',
      ],
      [
        '--rehearsal-permit-file',
        permitPath,
        '--rehearsal-permit-key-file',
        keyPath,
        '--',
      ],
      [
        '--rehearsal-permit-file',
        '   ',
        '--rehearsal-permit-key-file',
        keyPath,
        '--',
        'measure',
      ],
    ]) {
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalControlCliArguments(invalid)
      ).toThrow('INVALID_USAGE')
    }
  })

  test('snapshots accessor-backed arguments once before positional parsing', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    let reads = 0
    const arguments_ = new Proxy(
      createAuthenticatedFaultRehearsalArguments(fixture),
      {
      get: (target, property, receiver) => {
        if (property === '0') reads += 1
        return Reflect.get(target, property, receiver)
      },
      },
    )

    const parsed =
      parseWorkspaceSearchMigrationRehearsalControlCliArguments(arguments_)

    expect(parsed.controlArguments).toEqual(fixture.controlArguments)
    expect(reads).toBe(1)
  })
})

describe('Workspace Search migration rehearsal control CLI runner', () => {
  test.each([
    'different-stage-key',
    'permit-evidence-digest-mismatch',
  ])('rejects %s before control or AWS construction', async (scenario) => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const permitKey = new Uint8Array(fixture.authenticationKey)
    const stageKey = scenario === 'different-stage-key'
      ? new Uint8Array(32).fill(0x91)
      : new Uint8Array(fixture.authenticationKey)
    const permit = scenario === 'permit-evidence-digest-mismatch'
      ? Object.freeze({
          ...fixture.permit,
          evidenceKeyDigest: 'f'.repeat(64),
        })
      : fixture.permit
    let controlCalls = 0
    const harness = createTestDependencies(
      new Map([
        [permitPath, textEncoder.encode(serializeCanonicalJson(permit))],
        [keyPath, permitKey],
        [stageManifestPath, textEncoder.encode(
          serializeCanonicalJson(fixture.manifest),
        )],
        [stageKeyPath, stageKey],
        [stageReservationPath, textEncoder.encode(
          serializeCanonicalJson(fixture.stageReservation),
        )],
      ]),
      async (): Promise<0> => {
        controlCalls += 1
        return 0
      },
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createSuccessfulRehearsalArguments(
        fixture.controlArguments,
        fixture.configurationBindingDigest,
      ),
      harness.dependencies,
    )

    expect(exitCode).toBe(2)
    expect(controlCalls).toBe(0)
    expect(harness.sessionInputs).toEqual([])
    expect(harness.rateRuntimeInputs).toEqual([])
    expect(harness.faultReceiptLines).toEqual([])
    expect([...permitKey]).toEqual(Array.from({ length: 32 }, () => 0))
    expect([...stageKey]).toEqual(Array.from({ length: 32 }, () => 0))
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INVALID_STAGE_SELECTION',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
        status: 'error',
      }),
    ])
  })

  test('emits authenticated generic-success material only after rate close', async () => {
    const sessionInput = createControlSessionInput()
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
        requestedResourcesBinding:
          createWorkspaceSearchMigrationRequestedResourcesBinding(
            sessionInput.resources,
          ),
        configurationBindingDigest: rateConfigurationHash,
        policyVersion: sessionInput.ratePolicy.policyVersion,
      })
    const permitKey = new Uint8Array(fixture.authenticationKey)
    const stageKey = new Uint8Array(fixture.authenticationKey)
    const acknowledgements: string[] = []
    let harness: ReturnType<typeof createTestDependencies>
    harness = createTestDependencies(
      new Map([
        [permitPath, textEncoder.encode(
          serializeCanonicalJson(fixture.permit),
        )],
        [keyPath, permitKey],
        [stageManifestPath, textEncoder.encode(
          serializeCanonicalJson(fixture.manifest),
        )],
        [stageKeyPath, stageKey],
        [stageReservationPath, textEncoder.encode(
          serializeCanonicalJson(fixture.stageReservation),
        )],
      ]),
      async (_arguments, controlDependencies): Promise<0> => {
        const session =
          await controlDependencies.createReadSession(sessionInput)
        await session.close()
        const observer = controlDependencies.observeMutationResult
        if (observer === undefined) {
          throw new Error('Expected trusted mutation observer.')
        }
        observer(fixture.observation)
        return 0
      },
      undefined,
      async () => {},
      async (materialDigest): Promise<void> => {
        acknowledgements.push(materialDigest)
      },
      fixture.committedRateSegment,
      fixture.selection,
      fixture.leaseAcquisitionObservation,
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createSuccessfulRehearsalArguments(
        fixture.controlArguments,
        fixture.configurationBindingDigest,
      ),
      harness.dependencies,
    )

    expect(exitCode).toBe(0)
    expect(harness.faultReceiptLines).toHaveLength(1)
    const line = harness.faultReceiptLines[0]
    if (line === undefined) throw new Error('Expected child material line.')
    const material =
      verifyWorkspaceSearchMigrationRehearsalStageChildMaterial({
        material: JSON.parse(line),
        selection: fixture.selection,
        verificationKey: fixture.authenticationKey,
      })
    expect(acknowledgements).toEqual([createMigrationDigest(material)])
    expect(harness.boundaryEvents).toEqual([
      'rate-flush',
      'rate-close',
      'fault-receipt',
    ])
    expect(harness.sessionInputs[0]?.stageReservationClaim).toBeDefined()
    expect(material.stageReservation).toEqual(fixture.stageReservation)
    expect(material.claimedStageHead.activeReservationDigest).toBe(
      createMigrationDigest(material.stageReservation),
    )
    expect([...permitKey]).toEqual(Array.from({ length: 32 }, () => 0))
    expect([...stageKey]).toEqual(Array.from({ length: 32 }, () => 0))
  })

  test.each([
    'expired-clock',
    'tampered-reservation',
  ] satisfies readonly (
    | 'expired-clock'
    | 'tampered-reservation'
  )[])(
    'rejects reservation %s before session construction',
    async (scenario) => {
      const sessionInput = createControlSessionInput()
      const fixture =
        createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
          requestedResourcesBinding:
            createWorkspaceSearchMigrationRequestedResourcesBinding(
              sessionInput.resources,
            ),
          configurationBindingDigest: rateConfigurationHash,
          policyVersion: sessionInput.ratePolicy.policyVersion,
        })
      let harness: ReturnType<typeof createTestDependencies>
      harness = createTestDependencies(
        new Map([
          [permitPath, textEncoder.encode(
            serializeCanonicalJson(fixture.permit),
          )],
          [keyPath, new Uint8Array(fixture.authenticationKey)],
          [stageManifestPath, textEncoder.encode(
            serializeCanonicalJson(fixture.manifest),
          )],
          [stageKeyPath, new Uint8Array(fixture.authenticationKey)],
          [stageReservationPath, textEncoder.encode(
            serializeCanonicalJson(
              scenario === 'tampered-reservation'
                ? {
                    ...fixture.stageReservation,
                    nonceDigest: '0'.repeat(64),
                  }
                : fixture.stageReservation,
            ),
          )],
        ]),
        async (_arguments, controlDependencies): Promise<0> => {
          await controlDependencies.createReadSession(sessionInput)
          return 0
        },
      )
      const dependencies:
        WorkspaceSearchMigrationRehearsalControlCliDependencies = {
          ...harness.dependencies,
          clock: () => new Date(
            scenario === 'expired-clock'
              ? fixture.stageReservation.expiresAt
              : '2026-08-02T00:10:00.000Z',
          ),
        }

      const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
        createSuccessfulRehearsalArguments(
          fixture.controlArguments,
          fixture.configurationBindingDigest,
        ),
        dependencies,
      )

      expect(exitCode).toBe(2)
      expect(harness.sessionInputs).toEqual([])
      expect(harness.faultReceiptLines).toEqual([])
    },
  )

  test.each([
    ['empty invocation', []],
    ['direct child bypass', createRehearsalArguments()],
  ] satisfies readonly (readonly [string, readonly string[]])[])(
    'rejects %s before files, rate initialization, control, or AWS mutation',
    async (_label, arguments_) => {
      let controlCalls = 0
      const harness = createTestDependencies(new Map(), async () => {
        controlCalls += 1
        return 0
      })

      const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
        arguments_,
        harness.dependencies,
      )

      expect(exitCode).toBe(2)
      expect(controlCalls).toBe(0)
      expect(harness.reads).toEqual([])
      expect(harness.keyReads).toEqual([])
      expect(harness.rateRuntimeInputs).toEqual([])
      expect(harness.sessionInputs).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_USAGE',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
          status: 'error',
        }),
      ])
    },
  )

  test('maps an authenticated fault stage to the dedicated session and zeroizes both keys', async () => {
    const sessionInput = createControlSessionInput()
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        false,
        {
          requestedResourcesBinding:
            createWorkspaceSearchMigrationRequestedResourcesBinding(
              sessionInput.resources,
            ),
          configurationBindingDigest: rateConfigurationHash,
          policyVersion: sessionInput.ratePolicy.policyVersion,
        },
      )
    const permitKey = new Uint8Array(fixture.authenticationKey)
    const stageKey = new Uint8Array(fixture.authenticationKey)
    let harness: ReturnType<typeof createTestDependencies>
    harness = createTestDependencies(
      createAuthenticatedFaultFiles(fixture, permitKey, stageKey),
      async (arguments_, controlDependencies) => {
        expect(arguments_).toEqual(fixture.controlArguments)
        await invokeRejectedReadFactory(
          controlDependencies,
          harness.constructionFailure,
        )
        return 0
      },
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createAuthenticatedFaultRehearsalArguments(fixture),
      harness.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'OPERATION_FAILED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
        status: 'error',
      }),
    ])
    expect(harness.reads.map(([path]) => path)).toEqual([
      permitPath,
      faultPlanPath,
      stageManifestPath,
      previousStageReceiptPath,
      stageReservationPath,
    ])
    expect(harness.keyReads).toEqual([keyPath, stageKeyPath])
    expect(harness.sessionInputs).toHaveLength(1)
    expect(harness.rateRuntimeInputs).toHaveLength(1)
    expect(harness.rateRuntimeInputs[0]).toMatchObject({
      segmentFile: rateSegmentPath,
      expectedPolicyVersion: 'b'.repeat(64),
      expectedConfigurationBindingDigest: rateConfigurationHash,
    })
    expect(harness.rateRuntimeKeySnapshots[0]).toEqual(
      fixture.authenticationKey,
    )
    expect(harness.sessionInputs[0]?.rateRecorder).toBe(
      harness.rateRecorders[0],
    )
    expect(harness.sessionInputs[0]?.permit).toEqual(fixture.permit)
    expect(Object.hasOwn(harness.sessionInputs[0] ?? {}, 'fault')).toBe(true)
    expect(harness.keySnapshots[0]).toEqual(
      fixture.authenticationKey,
    )
    expect([...permitKey]).toEqual(Array.from({ length: 32 }, () => 0))
    expect([...stageKey]).toEqual(Array.from({ length: 32 }, () => 0))
    expect(harness.boundaryEvents).toEqual(['rate-flush', 'rate-close'])
  })

  test('overrides best-effort telemetry, passes predecessor metadata, and creates only one runtime', async () => {
    const sessionInput = createControlSessionInput()
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        false,
        {
          requestedResourcesBinding:
            createWorkspaceSearchMigrationRequestedResourcesBinding(
              sessionInput.resources,
            ),
          configurationBindingDigest: rateConfigurationHash,
          policyVersion: sessionInput.ratePolicy.policyVersion,
        },
      )
    const bestEffortRecorder = { record: (): void => {} }
    let harness: ReturnType<typeof createTestDependencies>
    harness = createTestDependencies(
      createAuthenticatedFaultFiles(
        fixture,
        new Uint8Array(fixture.authenticationKey),
        new Uint8Array(fixture.authenticationKey),
      ),
      async (_arguments, controlDependencies) => {
        try {
          await controlDependencies.createReadSession({
            ...sessionInput,
            rateRecorder: bestEffortRecorder,
          })
        } catch (error: unknown) {
          expect(error).toBe(harness.constructionFailure)
        }
        await expect(
          controlDependencies.createReadSession(sessionInput),
        ).rejects.toThrow('OPERATION_FAILED')
        return 0
      },
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createAuthenticatedFaultRehearsalArguments(fixture, true),
      harness.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(harness.rateRuntimeInputs).toHaveLength(1)
    expect(harness.rateRuntimeInputs[0]?.previousSegmentFile).toBe(
      previousRateSegmentPath,
    )
    expect(harness.sessionInputs).toHaveLength(1)
    expect(harness.sessionInputs[0]?.rateRecorder).toBe(
      harness.rateRecorders[0],
    )
    expect(harness.sessionInputs[0]?.rateRecorder).not.toBe(
      bestEffortRecorder,
    )
  })

  test('flushes and closes the durable runtime when the control runner fails', async () => {
    const sessionInput = createControlSessionInput()
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        false,
        {
          requestedResourcesBinding:
            createWorkspaceSearchMigrationRequestedResourcesBinding(
              sessionInput.resources,
            ),
          configurationBindingDigest: rateConfigurationHash,
          policyVersion: sessionInput.ratePolicy.policyVersion,
        },
      )
    let harness: ReturnType<typeof createTestDependencies>
    harness = createTestDependencies(
      createAuthenticatedFaultFiles(
        fixture,
        new Uint8Array(fixture.authenticationKey),
        new Uint8Array(fixture.authenticationKey),
      ),
      async (_arguments, controlDependencies) => {
        await invokeRejectedReadFactory(
          controlDependencies,
          harness.constructionFailure,
        )
        throw new Error('raw control failure')
      },
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createAuthenticatedFaultRehearsalArguments(fixture),
      harness.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(harness.boundaryEvents).toEqual(['rate-flush', 'rate-close'])
  })

  test.each([
    'happy-path-verified',
    'complete-apply-rollback',
  ] satisfies readonly WorkspaceSearchMigrationRehearsalNoFaultScenario[])(
    'rejects legacy %s before files, AWS construction, or control execution',
    async (scenario) => {
      let controlCalls = 0
      const harness = createTestDependencies(new Map(), async () => {
        controlCalls += 1
        return 0
      })

      const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
        createRehearsalArguments(false, false, scenario),
        harness.dependencies,
      )

      expect(exitCode).toBe(2)
      expect(controlCalls).toBe(0)
      expect(harness.reads).toEqual([])
      expect(harness.keyReads).toEqual([])
      expect(harness.sessionInputs).toEqual([])
      expect(harness.faultReceiptLines).toEqual([])
    },
  )

  test.each(securePermitKeyFailureScenarios)(
    'rejects secure permit-key boundary failure %s before control or AWS construction',
    async (scenario) => {
      let controlCalls = 0
      const requestedKeyPaths: string[] = []
      const secureReader = createSecurePermitKeyReaderHarness(scenario)
      const harness = createTestDependencies(
        new Map([[permitPath, permitBytes]]),
        async () => {
          controlCalls += 1
          return 0
        },
      )
      const dependencies:
        WorkspaceSearchMigrationRehearsalControlCliDependencies = {
          ...harness.dependencies,
          readPermitKeyFile: async (path) => {
            requestedKeyPaths.push(path)
            return await readWorkspaceSearchMigrationRehearsalPermitSigningKey(
              path,
              secureReader.dependencies,
            )
          },
        }

      const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
        createSuccessfulRehearsalArguments(
          ['measure'],
          rateConfigurationHash,
        ),
        dependencies,
      )

      expect(exitCode).toBe(2)
      expect(controlCalls).toBe(0)
      expect(harness.sessionInputs).toEqual([])
      expect(harness.reads).toEqual([[
        permitPath,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_FILE_MAX_BYTES,
      ]])
      expect(requestedKeyPaths).toEqual([keyPath])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_REHEARSAL_INPUT',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
          status: 'error',
        }),
      ])
      for (const workingBuffer of secureReader.workingBuffers) {
        expect([...workingBuffer]).toEqual(
          Array.from({ length: 33 }, () => 0),
        )
      }
    },
  )

  test('rejects every legacy unauthenticated fault-plan invocation', async () => {
    for (const failpoint of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS) {
      const key = createPermitKey()
      const harness = createTestDependencies(new Map([
        [permitPath, permitBytes],
        [keyPath, key],
        [faultPlanPath, createFaultPlanBytes(failpoint)],
      ]))

      const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
        createRehearsalArguments(true),
        harness.dependencies,
      )

      expect(exitCode).toBe(2)
      expect(harness.reads).toEqual([])
      expect(harness.sessionInputs).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_USAGE',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
          status: 'error',
        }),
      ])
    }
  })

  test('authenticates reservation and head before reporting a barrier', async () => {
    const sessionInput = createControlSessionInput()
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        false,
        {
          requestedResourcesBinding:
            createWorkspaceSearchMigrationRequestedResourcesBinding(
              sessionInput.resources,
            ),
          configurationBindingDigest: rateConfigurationHash,
          policyVersion: sessionInput.ratePolicy.policyVersion,
        },
      )
    const permitKey = new Uint8Array(fixture.authenticationKey)
    const stageKey = new Uint8Array(fixture.authenticationKey)
    const receipt = createFixtureFaultReceipt(fixture)
    let releaseBarrier: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    let harness: ReturnType<typeof createTestDependencies>
    harness = createTestDependencies(
      createAuthenticatedFaultFiles(fixture, permitKey, stageKey),
      async (_arguments, controlDependencies) => {
        const session = await controlDependencies.createReadSession(
          sessionInput,
        )
        const fault = harness.sessionInputs[0]?.fault
        if (fault === undefined) throw new Error('Missing barrier fault.')
        await fault.waitAtBarrier(receipt)
        await session.close()
        return 0
      },
      undefined,
      async () => await barrier,
      async () => {},
      fixture.committedRateSegment,
      fixture.selection,
      fixture.leaseAcquisitionObservation,
      fixture.faultObservation,
    )
    let completed = false
    const run = runWorkspaceSearchMigrationRehearsalControlCli(
      createAuthenticatedFaultRehearsalArguments(fixture),
      harness.dependencies,
    ).then((exitCode) => {
      completed = true
      return exitCode
    })
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if (harness.faultReceiptLines.length > 0) break
      await Promise.resolve()
    }

    expect(harness.stderrLines).toEqual([])
    expect(harness.faultReceiptLines).toHaveLength(1)
    expect(harness.boundaryEvents.slice(0, 2)).toEqual([
      'rate-flush',
      'fault-receipt',
    ])
    expect(completed).toBe(false)
    const material =
      verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        material: JSON.parse(harness.faultReceiptLines[0] ?? ''),
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        rateSegmentBytes: fixture.committedRateSegment.canonicalBytes,
        verificationKey: fixture.authenticationKey,
      })
    expect(material.faultReceipt).toEqual(receipt)
    expect(material.claimedStageHead.activeReservationDigest).toBe(
      createMigrationDigest(material.stageReservation),
    )
    releaseBarrier?.()
    expect(await run).toBe(1)
    expect([...permitKey]).toEqual(Array.from({ length: 32 }, () => 0))
    expect([...stageKey]).toEqual(Array.from({ length: 32 }, () => 0))
  })

  test('emits and acknowledges both authenticated response-loss phases', async () => {
    const sessionInput = createControlSessionInput()
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        true,
        {
          requestedResourcesBinding:
            createWorkspaceSearchMigrationRequestedResourcesBinding(
              sessionInput.resources,
            ),
          configurationBindingDigest: rateConfigurationHash,
          policyVersion: sessionInput.ratePolicy.policyVersion,
        },
      )
    const receipt = createFixtureFaultReceipt(fixture)
    let killWaits = 0
    const acknowledgements: Array<readonly [string, boolean | undefined]> = []
    let harness: ReturnType<typeof createTestDependencies>
    harness = createTestDependencies(
      createAuthenticatedFaultFiles(
        fixture,
        new Uint8Array(fixture.authenticationKey),
        new Uint8Array(fixture.authenticationKey),
      ),
      async (_arguments, controlDependencies) => {
        const session = await controlDependencies.createReadSession(
          sessionInput,
        )
        const fault = harness.sessionInputs[0]?.fault
        if (fault === undefined) throw new Error('Missing response fault.')
        await fault.reportResponseLoss(receipt)
        const observer = controlDependencies.observeMutationResult
        if (observer === undefined) throw new Error('Missing observer.')
        observer(fixture.observation)
        await session.close()
        return 0
      },
      undefined,
      async () => {
        killWaits += 1
      },
      async (materialDigest, finalAcknowledgement) => {
        acknowledgements.push([materialDigest, finalAcknowledgement])
      },
      fixture.committedRateSegment,
      fixture.selection,
      fixture.leaseAcquisitionObservation,
      fixture.faultObservation,
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createAuthenticatedFaultRehearsalArguments(fixture),
      harness.dependencies,
    )

    expect(exitCode).toBe(0)
    expect(killWaits).toBe(0)
    expect(harness.stderrLines).toEqual([])
    expect(harness.faultReceiptLines).toHaveLength(2)
    expect(harness.boundaryEvents.slice(0, 2)).toEqual([
      'rate-flush',
      'fault-receipt',
    ])
    const boundary =
      verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        material: JSON.parse(harness.faultReceiptLines[0] ?? ''),
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        rateSegmentBytes: fixture.committedRateSegment.canonicalBytes,
        verificationKey: fixture.authenticationKey,
      })
    const completion =
      verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        material: JSON.parse(harness.faultReceiptLines[1] ?? ''),
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes:
          fixture.committedRateSegment.canonicalBytes,
        finalRateSegmentBytes: fixture.committedRateSegment.canonicalBytes,
        verificationKey: fixture.authenticationKey,
      })
    expect(completion.stageReservation).toEqual(boundary.stageReservation)
    expect(completion.claimedStageHead).toEqual(boundary.claimedStageHead)
    expect(acknowledgements).toEqual([
      [createMigrationDigest(boundary), false],
      [createMigrationDigest(completion), true],
    ])
  })

  test('does not emit a fault receipt when the durable rate flush fails', async () => {
    const sessionInput = createControlSessionInput()
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        false,
        {
          requestedResourcesBinding:
            createWorkspaceSearchMigrationRequestedResourcesBinding(
              sessionInput.resources,
            ),
          configurationBindingDigest: rateConfigurationHash,
          policyVersion: sessionInput.ratePolicy.policyVersion,
        },
      )
    const receipt = createFixtureFaultReceipt(fixture)
    let harness: ReturnType<typeof createTestDependencies>
    harness = createTestDependencies(
      createAuthenticatedFaultFiles(
        fixture,
        new Uint8Array(fixture.authenticationKey),
        new Uint8Array(fixture.authenticationKey),
      ),
      async (_arguments, controlDependencies) => {
        await controlDependencies.createReadSession(sessionInput)
        const fault = harness.sessionInputs[0]?.fault
        if (fault === undefined) throw new Error('Missing barrier fault.')
        await fault.waitAtBarrier(receipt)
        return 0
      },
      undefined,
      async () => {},
      async () => {},
      fixture.committedRateSegment,
      fixture.selection,
      fixture.leaseAcquisitionObservation,
    )
    harness.failRateFlush()

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createAuthenticatedFaultRehearsalArguments(fixture),
      harness.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(harness.faultReceiptLines).toEqual([])
    expect(harness.boundaryEvents).not.toContain('fault-receipt')
    expect(harness.boundaryEvents.at(-1)).toBe('rate-close')
  })

  test('rejects noncanonical plans and invalid key lengths with stable failures', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    for (const key of [
      new Uint8Array(fixture.authenticationKey),
      Uint8Array.of(1, 2, 3),
    ]) {
      const faultBytes = key.byteLength === 32
        ? textEncoder.encode(JSON.stringify(fixture.faultPlan, null, 2))
        : textEncoder.encode(serializeCanonicalJson(fixture.faultPlan))
      let controlCalls = 0
      const harness = createTestDependencies(createAuthenticatedFaultFiles(
        fixture,
        key,
        new Uint8Array(fixture.authenticationKey),
        faultBytes,
      ), async () => {
        controlCalls += 1
        return 0
      })

      const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
        createAuthenticatedFaultRehearsalArguments(fixture),
        harness.dependencies,
      )

      expect(exitCode).toBe(2)
      expect(controlCalls).toBe(0)
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_REHEARSAL_INPUT',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
          status: 'error',
        }),
      ])
      expect([...key]).toEqual(Array.from({ length: key.byteLength }, () => 0))
    }
  })

  test('redacts unexpected runner failures and zeroizes the key', async () => {
    const rawCanary = 'raw-runner-account-path-secret'
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const permitKey = new Uint8Array(fixture.authenticationKey)
    const stageKey = new Uint8Array(fixture.authenticationKey)
    const harness = createTestDependencies(
      createAuthenticatedFaultFiles(fixture, permitKey, stageKey),
      async () => {
        throw new Error(rawCanary)
      },
    )

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createAuthenticatedFaultRehearsalArguments(fixture),
      harness.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'OPERATION_FAILED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
        status: 'error',
      }),
    ])
    expect(harness.stderrLines[0]).not.toContain(rawCanary)
    expect([...permitKey]).toEqual(Array.from({ length: 32 }, () => 0))
    expect([...stageKey]).toEqual(Array.from({ length: 32 }, () => 0))
  })

  test('zeroizes a key returned concurrently with cooperative interruption', async () => {
    const key = createPermitKey()
    const controller = new AbortController()
    let controlCalls = 0
    const harness = createTestDependencies(new Map([
      [permitPath, permitBytes],
      [keyPath, key],
    ]), async () => {
      controlCalls += 1
      return 0
    })
    const dependencies:
      WorkspaceSearchMigrationRehearsalControlCliDependencies = {
        ...harness.dependencies,
        readPermitKeyFile: async (path) => {
          const bytes = await harness.dependencies.readPermitKeyFile(path)
          controller.abort()
          return bytes
        },
      }

    const exitCode = await runWorkspaceSearchMigrationRehearsalControlCli(
      createSuccessfulRehearsalArguments(
        ['measure'],
        rateConfigurationHash,
      ),
      dependencies,
      controller.signal,
    )

    expect(exitCode).toBe(130)
    expect(controlCalls).toBe(0)
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INTERRUPTED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
        status: 'error',
      }),
    ])
    expect([...key]).toEqual(Array.from({ length: 32 }, () => 0))
  })
})

describe('Workspace Search migration rehearsal fault receipt line', () => {
  test('accepts only the fixed envelope and exact runtime receipt', () => {
    const receipt = createPlanningReceipt(
      'planning-page-transaction-response-lost',
    )
    const line: WorkspaceSearchMigrationRehearsalControlFaultReceiptLine = {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_FAULT_RECEIPT_KIND,
      receipt,
    }
    expect(
      parseWorkspaceSearchMigrationRehearsalControlFaultReceiptLine(line),
    ).toEqual(line)
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalControlFaultReceiptLine({
        ...line,
        rawPath: '/restricted/private-path',
      })
    ).toThrow('INVALID_FAULT_RECEIPT')

    let accessorReads = 0
    const accessorLine = { ...line }
    Object.defineProperty(accessorLine, 'receipt', {
      enumerable: true,
      get: () => {
        accessorReads += 1
        return receipt
      },
    })
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalControlFaultReceiptLine(
        accessorLine,
      )
    ).toThrow('INVALID_FAULT_RECEIPT')
    expect(accessorReads).toBe(0)
  })

  test('binds one response-loss acknowledgement to the exact receipt digest', () => {
    const receiptSha256 = createMigrationDigest(createPlanningReceipt(
      'planning-page-transaction-response-lost',
    ))
    const acknowledgement:
      WorkspaceSearchMigrationRehearsalResponseLossAcknowledgement = {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_KIND,
      receiptSha256,
    }
    expect(
      parseWorkspaceSearchMigrationRehearsalResponseLossAcknowledgement(
        acknowledgement,
        receiptSha256,
      ),
    ).toEqual(acknowledgement)
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalResponseLossAcknowledgement(
        acknowledgement,
        'f'.repeat(64),
      )
    ).toThrow('INVALID_REHEARSAL_INPUT')
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalResponseLossAcknowledgement(
        { ...acknowledgement, rawPath: '/restricted/private-path' },
        receiptSha256,
      )
    ).toThrow('INVALID_REHEARSAL_INPUT')
  })
})
