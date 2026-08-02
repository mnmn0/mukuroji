import {
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isHexDigest,
  requireMigrationIdentifier,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  readMeasuredWorkspaceSearchMigrationExecutionStatus,
  readMeasuredWorkspaceSearchMigrationExecutionTerminalRelease,
  readWorkspaceSearchMigrationExecutionAppliedRoot,
  readWorkspaceSearchMigrationExecutionStatus,
  readWorkspaceSearchMigrationExecutionTerminalRelease,
  superviseWorkspaceSearchMigrationExecution,
  type ReadWorkspaceSearchMigrationExecutionStatusInput,
  type SuperviseWorkspaceSearchMigrationExecutionInput,
  type WorkspaceSearchMigrationExecutionSupervisorSession,
  type WorkspaceSearchMigrationExecutionAppliedRootProjection,
  type WorkspaceSearchMigrationExecutionStatusSession,
  type WorkspaceSearchMigrationExecutionStatus,
  type WorkspaceSearchMigrationExecutionTerminalRelease,
} from './migration-execution-supervisor'
import {
  runWithWorkspaceSearchMigrationHeartbeat,
  type WorkspaceSearchMigrationHeartbeatClock,
  type WorkspaceSearchMigrationHeartbeatScheduler,
  type WorkspaceSearchMigrationHeartbeatTaskContext,
  WorkspaceSearchMigrationHeartbeatInterruptedError,
} from './migration-heartbeat-supervisor'
import {
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_CANONICAL_BYTES,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_OPERATIONS,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_TOTAL_ROWS,
} from './migration-identity-aws'
import {
  superviseWorkspaceSearchMigrationPostClosePlanning,
  type SuperviseWorkspaceSearchMigrationPostClosePlanningInput,
  type WorkspaceSearchMigrationMaintenanceEvidenceProvider,
  type WorkspaceSearchMigrationPostClosePlanningResult,
} from './migration-post-close-planning-supervisor'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanAuthorityClaim,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'
import { parseMaintenanceEvidence } from './maintenance-evidence'
import type {
  WorkspaceSearchWriterFenceObservation,
  WorkspaceSearchWriterFenceTerminalOutcome,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'

/**
 * Exact operator approval phrases accepted by mutating coordinator stages.
 */
export const workspaceSearchMigrationControlApprovalLiterals = Object.freeze({
  /** Closes application writers and publishes the post-close sealed plan. */
  'close-replan': 'close-writers-and-replan',
  /** Applies the already sealed immutable migration plan. */
  apply: 'apply-sealed-migration-plan',
  /** Independently verifies the complete applied root. */
  verify: 'verify-complete-applied-root',
  /** Reverses only the durably committed apply prefix. */
  'rollback-partial': 'rollback-committed-apply-prefix',
  /** Reverses the complete immutable applied root. */
  'rollback-complete': 'rollback-complete-applied-root',
  /** Reopens application writers from an exact immutable terminal root. */
  release: 'release-application-writers',
})

/**
 * Explicit mutation stage selected by one operator invocation.
 */
export type WorkspaceSearchMigrationControlCoordinatorMode =
  | 'close-replan'
  | 'apply'
  | 'verify'
  | 'rollback-partial'
  | 'rollback-complete'
  | 'release'

/**
 * Exact close-and-replan stage input over the planning-only session surface.
 */
export type WorkspaceSearchMigrationControlCloseReplanInput =
  SuperviseWorkspaceSearchMigrationPostClosePlanningInput & {
    /** Explicit stage that may close application writers. */
    readonly mode: 'close-replan'
    /** Exact operator approval phrase for close and replanning. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals['close-replan']
  }

/**
 * Supervisor input shared by the four explicit execution branches.
 */
type WorkspaceSearchMigrationControlExecutionInputBase = Omit<
  SuperviseWorkspaceSearchMigrationExecutionInput,
  'mode'
>

/**
 * Exact forward-apply stage input over the execution-only session surface.
 */
export type WorkspaceSearchMigrationControlApplyInput =
  WorkspaceSearchMigrationControlExecutionInputBase & {
    /** Explicit forward apply stage. */
    readonly mode: 'apply'
    /** Exact operator approval phrase for sealed-plan apply. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals.apply
  }

/**
 * Exact full-verification stage input over the execution-only session surface.
 */
export type WorkspaceSearchMigrationControlVerifyInput =
  WorkspaceSearchMigrationControlExecutionInputBase & {
    /** Explicit independent verification stage. */
    readonly mode: 'verify'
    /** Exact operator approval phrase for full verification. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals.verify
  }

/**
 * Exact committed-prefix rollback input over the execution-only session surface.
 */
export type WorkspaceSearchMigrationControlPartialRollbackInput =
  WorkspaceSearchMigrationControlExecutionInputBase & {
    /** Explicit committed-prefix rollback branch. */
    readonly mode: 'rollback-partial'
    /** Exact operator approval phrase for committed-prefix rollback. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals[
        'rollback-partial'
      ]
  }

/**
 * Exact complete-plan rollback input over the execution-only session surface.
 */
export type WorkspaceSearchMigrationControlCompleteRollbackInput =
  WorkspaceSearchMigrationControlExecutionInputBase & {
    /** Explicit complete-plan rollback branch. */
    readonly mode: 'rollback-complete'
    /** Exact operator approval phrase for complete-plan rollback. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals[
        'rollback-complete'
      ]
  }

/**
 * Exact terminal writer-fence release input over read and release capabilities.
 */
export type WorkspaceSearchMigrationControlReleaseInput = {
  /** Measured terminal-read, lease, evidence, and release capability. */
  readonly session: WorkspaceSearchMigrationControlReleaseSession
  /** Trusted provider for fresh post-close zero-writer evidence. */
  readonly maintenanceEvidenceProvider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  /** Operator-selected run that owns the immutable terminal graph. */
  readonly runId: string
  /** Process-unique lease owner used only for a new release attempt. */
  readonly ownerId: string
  /** Reviewed digest required to match a fresh resource measurement. */
  readonly expectedConfigurationHash: string
  /** Explicit terminal writer-fence release stage. */
  readonly mode: 'release'
  /** Exact operator approval phrase for reopening application writers. */
  readonly approval:
    typeof workspaceSearchMigrationControlApprovalLiterals.release
  /** Optional cooperative operator-interruption signal. */
  readonly signal?: AbortSignal
  /** Optional deterministic heartbeat scheduler used by tests. */
  readonly heartbeatScheduler?:
    WorkspaceSearchMigrationHeartbeatScheduler
  /** Optional trusted clock shared by evidence and heartbeat checks. */
  readonly clock?: WorkspaceSearchMigrationHeartbeatClock
}

/**
 * Capability-minimized session used only by terminal writer-fence release.
 *
 * Execution mutation methods such as apply, verify, and rollback are absent;
 * phase factories expose only the read methods needed to reconstruct the exact
 * immutable terminal graph.
 */
export type WorkspaceSearchMigrationControlReleaseSession = Omit<
  WorkspaceSearchMigrationExecutionStatusSession,
  'createApplicationWriterFencePort'
> & Pick<
  WorkspaceSearchMigrationExecutionSupervisorSession,
  | 'acquireLease'
  | 'heartbeatLease'
  | 'interruptMutationAdmission'
  | 'readAuthority'
  | 'readMaintenanceEvidencePointer'
  | 'renewMaintenanceEvidence'
  | 'runWithMutationAdmissionGuard'
> & {
  /**
   * Creates the only mutation capability available to terminal release.
   *
   * @returns Writer-fence read and exact terminal-release methods only.
   */
  createApplicationWriterFencePort(): Pick<
    ReturnType<
      WorkspaceSearchMigrationExecutionSupervisorSession[
        'createApplicationWriterFencePort'
      ]
    >,
    'read' | 'release'
  >
}

/**
 * Every explicit mutation accepted by the control coordinator.
 */
export type WorkspaceSearchMigrationControlCoordinatorInput =
  | WorkspaceSearchMigrationControlApplyInput
  | WorkspaceSearchMigrationControlCloseReplanInput
  | WorkspaceSearchMigrationControlCompleteRollbackInput
  | WorkspaceSearchMigrationControlPartialRollbackInput
  | WorkspaceSearchMigrationControlReleaseInput
  | WorkspaceSearchMigrationControlVerifyInput

/**
 * Secret-free result after close and replanning reach the sealed boundary.
 */
export type WorkspaceSearchMigrationControlPlanningSummary = {
  /** Explicit stage that completed. */
  readonly mode: 'close-replan'
  /** Durable planning boundary reached by the existing supervisor. */
  readonly phase: 'planning-admitted'
  /** Identifier-free exact durable planning graph, when provided. */
  readonly planning?: WorkspaceSearchMigrationControlPlanningEvidence
}

/** Identifier-free exact durable close, drain, and sealed-plan graph. */
export type WorkspaceSearchMigrationControlPlanningEvidence = {
  /** Digest of the revision-two planning-admitted boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the exact canonical closed writer-fence record. */
  readonly closedWriterFenceRecordDigest: string
  /** Canonical durable writer-fence close time. */
  readonly closedAt: string
  /** Canonical beginning of the observed zero-writer drain. */
  readonly drainStartedAt: string
  /** Canonical completion of the observed zero-writer drain. */
  readonly drainCompletedAt: string
  /** Canonical planning-admission commit time. */
  readonly admittedAt: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Merkle root of the exact ordered immutable plan. */
  readonly planDigest: string
  /** Exact non-zero or zero sealed plan operation count. */
  readonly planOperationCount: number
  /** Exact source-derived operation count. */
  readonly sourceOperationCount: number
  /** Exact target-orphan operation count. */
  readonly orphanOperationCount: number
  /** Canonical immutable plan creation time. */
  readonly planCreatedAt: string
  /** Canonical sealed-authority publication time. */
  readonly sealedAt: string
}

/**
 * Secret-free result after one explicit execution branch reaches its boundary.
 */
export type WorkspaceSearchMigrationControlExecutionSummary =
  | {
      /** Explicit forward-apply stage that completed. */
      readonly mode: 'apply'
      /** Read-only durable applied phase and next explicit operator action. */
      readonly execution: WorkspaceSearchMigrationExecutionStatus
      /** Exact durable applied-root projection from a post-apply strong read. */
      readonly application: WorkspaceSearchMigrationControlApplicationEvidence
    }
  | {
      /** Explicit verification or rollback stage that completed. */
      readonly mode: 'rollback-complete' | 'rollback-partial' | 'verify'
      /** Read-only durable phase and next explicit operator action. */
      readonly execution: WorkspaceSearchMigrationExecutionStatus
      /** Exact terminal graph projection after verify or rollback, when present. */
      readonly terminal?: WorkspaceSearchMigrationControlExecutionTerminalEvidence
    }

/** Identifier-free exact immutable applied-root evidence. */
export type WorkspaceSearchMigrationControlApplicationEvidence = {
  /** Digest of the immutable execution admission consumed by apply. */
  readonly executionRunDigest: string
  /** Merkle root of the exact ordered immutable plan. */
  readonly planDigest: string
  /** Exact plan operation count sealed by complete apply. */
  readonly sealedPlanOperationCount: number
  /** Exact durable operation-marker count fixed by the applied root. */
  readonly appliedOperationCount: number
  /** Digest of the immutable applied phase root. */
  readonly appliedRootDigest: string
  /** Canonical transaction time committed in the applied root. */
  readonly appliedAt: string
}

/** Identifier-free exact immutable terminal graph projected after execution. */
export type WorkspaceSearchMigrationControlExecutionTerminalEvidence = {
  /** Authoritative verified or rolled-back terminal outcome. */
  readonly terminalKind: WorkspaceSearchWriterFenceTerminalOutcome['kind']
  /** Persistence schema version of the authoritative terminal root. */
  readonly terminalPersistenceVersion:
    WorkspaceSearchWriterFenceTerminalOutcome['persistenceVersion']
  /** Digest of the authoritative terminal root. */
  readonly terminalRootDigest: string
  /** Canonical terminal-root publication time. */
  readonly terminalAt: string
  /** Digest of the admitted execution boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the exact closed writer-fence record. */
  readonly closedWriterFenceRecordDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Merkle root of the exact ordered immutable plan. */
  readonly planDigest: string
  /** Exact sealed plan operation count. */
  readonly planOperationCount: number
  /** Exact forward-applied count consumed by the terminal branch. */
  readonly appliedOperationCount: number
  /** Complete applied-root or committed-prefix origin digest. */
  readonly applyBoundaryDigest: string
}

/**
 * Secret-free result after terminal-bound writer-fence release or recovery.
 */
export type WorkspaceSearchMigrationControlReleaseSummary = {
  /** Explicit terminal release stage. */
  readonly mode: 'release'
  /** Durable released-open writer-fence boundary. */
  readonly phase: 'released'
  /** Verified or rolled-back terminal outcome authorizing release. */
  readonly terminalKind: WorkspaceSearchWriterFenceTerminalOutcome['kind']
  /** Persistence schema version of the immutable terminal root. */
  readonly terminalPersistenceVersion:
    WorkspaceSearchWriterFenceTerminalOutcome['persistenceVersion']
  /** Digest of the exact immutable terminal root. */
  readonly terminalRootDigest: string
  /** Digest of the exact canonical released writer-fence record. */
  readonly writerFenceRecordDigest: string
  /** Canonical durable release time fixed by the opened fence record. */
  readonly releasedAt: string
}

/** Secret-free durable evidence returned by the terminal release boundary. */
export type WorkspaceSearchMigrationControlReleaseEvidence = Omit<
  WorkspaceSearchMigrationControlReleaseSummary,
  'mode' | 'phase'
>

/**
 * Secret-free result of exactly one explicit coordinator stage.
 */
export type WorkspaceSearchMigrationControlCoordinatorSummary =
  | WorkspaceSearchMigrationControlExecutionSummary
  | WorkspaceSearchMigrationControlPlanningSummary
  | WorkspaceSearchMigrationControlReleaseSummary

/**
 * Injectable supervisor boundaries used by coordinator tests and composition.
 */
export interface WorkspaceSearchMigrationControlCoordinatorDependencies {
  /**
   * Runs the existing close, drain, and replanning supervisor.
   *
   * @param input - Exact provider-injected planning supervisor request.
   * @returns Completion after the durable admitted planning graph is reached.
   */
  supervisePostClosePlanning(
    input: SuperviseWorkspaceSearchMigrationPostClosePlanningInput,
  ): Promise<WorkspaceSearchMigrationPostClosePlanningResult | void>

  /**
   * Runs one existing explicit apply, verify, or rollback supervisor branch.
   *
   * @param input - Exact provider-injected execution supervisor request.
   * @returns Secret-free durable phase reached by the selected branch.
   */
  superviseExecution(
    input: SuperviseWorkspaceSearchMigrationExecutionInput,
  ): ReturnType<typeof superviseWorkspaceSearchMigrationExecution>

  /**
   * Reconstructs the exact immutable terminal graph after a terminal branch.
   *
   * @param input - Same measured session, run, and configuration binding.
   * @returns Exact terminal release graph, or undefined outside terminal state.
   */
  readonly readExecutionTerminal?: (
    input: ReadWorkspaceSearchMigrationExecutionStatusInput,
  ) => ReturnType<
    typeof readWorkspaceSearchMigrationExecutionTerminalRelease
  >

  /**
   * Strongly reconstructs the exact immutable applied root after apply.
   *
   * @param input - Same measured session, run, and configuration binding.
   * @returns Exact applied root, or undefined outside applied state.
   */
  readonly readExecutionApplication?: (
    input: ReadWorkspaceSearchMigrationExecutionStatusInput,
  ) => ReturnType<
    typeof readWorkspaceSearchMigrationExecutionAppliedRoot
  >

  /**
   * Runs one fresh-authority terminal writer-fence release or read-only recovery.
   *
   * @param input - Exact release session, evidence provider, owner, and signal.
   * @returns Secret-free terminal and released-fence digest evidence.
   */
  releaseTerminal(
    input: WorkspaceSearchMigrationControlReleaseInput,
  ): Promise<WorkspaceSearchMigrationControlReleaseEvidence>
}

/**
 * Read-only dependency surface for the public execution-status boundary.
 */
export interface WorkspaceSearchMigrationControlExecutionStatusDependencies {
  /**
   * Reads the existing secret-free durable execution projection.
   *
   * @param input - Read-only run and configuration binding.
   * @returns Current durable execution phase and next action.
   */
  readExecutionStatus(
    input: ReadWorkspaceSearchMigrationExecutionStatusInput,
  ): ReturnType<typeof readWorkspaceSearchMigrationExecutionStatus>
}

/** Default mutating supervisors used by the production coordinator. */
const defaultCoordinatorDependencies:
  WorkspaceSearchMigrationControlCoordinatorDependencies = {
    supervisePostClosePlanning:
      superviseWorkspaceSearchMigrationPostClosePlanning,
    superviseExecution:
      superviseWorkspaceSearchMigrationExecution,
    readExecutionApplication:
      readWorkspaceSearchMigrationExecutionAppliedRoot,
    readExecutionTerminal:
      readWorkspaceSearchMigrationExecutionTerminalRelease,
    releaseTerminal: releaseTerminalWriterFence,
  }

/** Default read-only supervisor used by the status boundary. */
const defaultCoordinatorExecutionStatusDependencies:
  WorkspaceSearchMigrationControlExecutionStatusDependencies = {
    readExecutionStatus:
      readWorkspaceSearchMigrationExecutionStatus,
  }

/**
 * Reads execution status without acquiring a lease or exposing mutation ports.
 *
 * @param input - Read-only measured session, run, and reviewed digest.
 * @param dependencies - Optional injectable supervisor boundaries.
 * @returns Existing secret-free durable execution status.
 */
export function readWorkspaceSearchMigrationControlExecutionStatus(
  input: ReadWorkspaceSearchMigrationExecutionStatusInput,
  dependencies:
    WorkspaceSearchMigrationControlExecutionStatusDependencies =
      defaultCoordinatorExecutionStatusDependencies,
): Promise<WorkspaceSearchMigrationExecutionStatus> {
  return dependencies.readExecutionStatus(input)
}

/**
 * Advances exactly one explicitly selected durable migration stage.
 *
 * The selected existing supervisor may use its own bounded internal cadence to
 * reach that stage boundary. This coordinator never selects rollback or
 * release from durable status, never invokes a second stage automatically, and
 * validates the exact stage-specific approval before any external operation.
 *
 * @param input - One capability-minimized explicit stage request.
 * @param dependencies - Optional injectable existing supervisor boundaries.
 * @returns Secret-free summary of the single completed stage.
 */
export async function advanceWorkspaceSearchMigrationControlStage(
  input: WorkspaceSearchMigrationControlCoordinatorInput,
  dependencies:
    WorkspaceSearchMigrationControlCoordinatorDependencies =
      defaultCoordinatorDependencies,
): Promise<WorkspaceSearchMigrationControlCoordinatorSummary> {
  const request = snapshotCoordinatorInput(input)
  assertCoordinatorActive(request.signal)

  if (request.mode === 'close-replan') {
    const planningResult = await dependencies.supervisePostClosePlanning({
      session: request.session,
      maintenanceEvidenceProvider: request.maintenanceEvidenceProvider,
      runId: request.runId,
      ownerId: request.ownerId,
      expectedConfigurationHash: request.expectedConfigurationHash,
      reviewedDryRunEvidenceBytes: request.reviewedDryRunEvidenceBytes,
      planningJoinLimits: request.planningJoinLimits,
      retainUntil: request.retainUntil,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.heartbeatScheduler === undefined
        ? {}
        : { heartbeatScheduler: request.heartbeatScheduler }),
      ...(request.clock === undefined ? {} : { clock: request.clock }),
      ...(request.telemetryRecorder === undefined
        ? {}
        : { telemetryRecorder: request.telemetryRecorder }),
      ...(request.checkpointStallClock === undefined
        ? {}
        : { checkpointStallClock: request.checkpointStallClock }),
      ...(request.checkpointStallSchedule === undefined
        ? {}
        : { checkpointStallSchedule: request.checkpointStallSchedule }),
    })
    return {
      mode: 'close-replan',
      phase: 'planning-admitted',
      ...(planningResult === undefined
        ? {}
        : { planning: createControlPlanningEvidence(planningResult) }),
    }
  }

  if (request.mode === 'release') {
    const evidence = await dependencies.releaseTerminal(request)
    return {
      mode: 'release',
      phase: 'released',
      ...evidence,
    }
  }

  const execution = await dependencies.superviseExecution({
    session: request.session,
    maintenanceEvidenceProvider: request.maintenanceEvidenceProvider,
    runId: request.runId,
    ownerId: request.ownerId,
    expectedConfigurationHash: request.expectedConfigurationHash,
    mode: mapExecutionSupervisorMode(request.mode),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.heartbeatScheduler === undefined
      ? {}
      : { heartbeatScheduler: request.heartbeatScheduler }),
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    ...(request.telemetryRecorder === undefined
      ? {}
      : { telemetryRecorder: request.telemetryRecorder }),
    ...(request.checkpointStallClock === undefined
      ? {}
      : { checkpointStallClock: request.checkpointStallClock }),
    ...(request.checkpointStallSchedule === undefined
      ? {}
      : { checkpointStallSchedule: request.checkpointStallSchedule }),
  })
  if (request.mode === 'apply') {
    if (
      execution.phase !== 'applied' ||
      dependencies.readExecutionApplication === undefined
    ) {
      return failCoordinator('INVALID_STATE')
    }
    const appliedRoot = await dependencies.readExecutionApplication({
      session: request.session,
      runId: request.runId,
      expectedConfigurationHash: request.expectedConfigurationHash,
    })
    if (appliedRoot === undefined) {
      return failCoordinator('INVALID_STATE')
    }
    return {
      mode: 'apply',
      execution,
      application: createControlApplicationEvidence(appliedRoot),
    }
  }
  if (
    (execution.phase === 'verified' || execution.phase === 'rolled-back') &&
    dependencies.readExecutionTerminal !== undefined
  ) {
    const terminal = await dependencies.readExecutionTerminal({
      session: request.session,
      runId: request.runId,
      expectedConfigurationHash: request.expectedConfigurationHash,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    if (terminal === undefined) return failCoordinator('INVALID_STATE')
    return {
      mode: request.mode,
      execution,
      terminal: createControlExecutionTerminalEvidence(terminal),
    }
  }
  return { mode: request.mode, execution }
}

/**
 * Projects one exact durable applied root without raw identifiers.
 *
 * @param root - Strongly reread and execution-bound immutable applied root.
 * @returns Identifier-free digests, counts, and durable apply time.
 */
function createControlApplicationEvidence(
  root: WorkspaceSearchMigrationExecutionAppliedRootProjection,
): WorkspaceSearchMigrationControlApplicationEvidence {
  return Object.freeze({
    executionRunDigest: root.executionRunDigest,
    planDigest: root.seal.planDigest,
    sealedPlanOperationCount: root.seal.planOperationCount,
    appliedOperationCount: root.seal.markerCount,
    appliedRootDigest: root.rootDigest,
    appliedAt: root.committedAt,
  })
}

/**
 * Projects the exact planning supervisor result without raw identifiers.
 *
 * @param result - Exact durable planning boundary, authority, and plan seal.
 * @returns Identifier-free digest, count, and timestamp evidence.
 */
function createControlPlanningEvidence(
  result: WorkspaceSearchMigrationPostClosePlanningResult,
): WorkspaceSearchMigrationControlPlanningEvidence {
  return Object.freeze({
    executionBoundaryDigest: result.executionBoundary.boundaryDigest,
    closedWriterFenceRecordDigest:
      result.executionBoundary.closedWriterFenceRecordDigest,
    closedAt: result.executionBoundary.closedAt,
    drainStartedAt:
      result.executionBoundary.planningAdmission.drainStartedAt,
    drainCompletedAt:
      result.executionBoundary.planningAdmission.drainCompletedAt,
    admittedAt: result.executionBoundary.planningAdmission.admittedAt,
    sealedPlanningAuthorityDigest:
      result.sealedPlanningAuthority.authorityDigest,
    planDigest: result.sealedPlanningAuthority.planDigest,
    planOperationCount:
      result.sealedPlanningAuthority.planOperationCount,
    sourceOperationCount:
      result.sealedPlanningAuthority.sourceOperationCount,
    orphanOperationCount:
      result.sealedPlanningAuthority.orphanOperationCount,
    planCreatedAt: result.planSeal.createdAt,
    sealedAt: result.sealedPlanningAuthority.sealedAt,
  })
}

/**
 * Projects an exact terminal release graph without raw identifiers.
 *
 * @param release - Exact immutable verified or rolled-back release graph.
 * @returns Identifier-free root, count, digest, and timestamp evidence.
 */
function createControlExecutionTerminalEvidence(
  release: WorkspaceSearchMigrationExecutionTerminalRelease,
): WorkspaceSearchMigrationControlExecutionTerminalEvidence {
  const terminal = createWriterFenceTerminalOutcome(release)
  if (release.terminal.kind === 'verified') {
    return Object.freeze({
      terminalKind: terminal.kind,
      terminalPersistenceVersion: terminal.persistenceVersion,
      terminalRootDigest: terminal.rootDigest,
      terminalAt: release.terminal.root.verifiedAt,
      executionBoundaryDigest: release.executionBoundary.boundaryDigest,
      closedWriterFenceRecordDigest:
        release.executionBoundary.closedWriterFenceRecordDigest,
      sealedPlanningAuthorityDigest:
        release.sealedPlanningAuthority.authorityDigest,
      executionRunDigest: release.executionRun.executionRunDigest,
      planDigest: release.sealedPlanningAuthority.planDigest,
      planOperationCount:
        release.sealedPlanningAuthority.planOperationCount,
      appliedOperationCount:
        release.sealedPlanningAuthority.planOperationCount,
      applyBoundaryDigest: release.terminal.root.appliedRootDigest,
    })
  }
  return Object.freeze({
    terminalKind: terminal.kind,
    terminalPersistenceVersion: terminal.persistenceVersion,
    terminalRootDigest: terminal.rootDigest,
    terminalAt: release.terminal.root.finishedAt,
    executionBoundaryDigest: release.executionBoundary.boundaryDigest,
    closedWriterFenceRecordDigest:
      release.executionBoundary.closedWriterFenceRecordDigest,
    sealedPlanningAuthorityDigest:
      release.sealedPlanningAuthority.authorityDigest,
    executionRunDigest: release.executionRun.executionRunDigest,
    planDigest: release.sealedPlanningAuthority.planDigest,
    planOperationCount:
      release.sealedPlanningAuthority.planOperationCount,
    appliedOperationCount:
      release.terminal.root.terminalState.upperBoundSequence,
    applyBoundaryDigest: release.terminal.kind === 'rolled-back-v1'
      ? release.terminal.root.appliedRootDigest
      : release.terminal.root.originDigest,
  })
}

/** Coordinator input union for the four execution-supervisor branches. */
type WorkspaceSearchMigrationControlExecutionInput =
  | WorkspaceSearchMigrationControlApplyInput
  | WorkspaceSearchMigrationControlCompleteRollbackInput
  | WorkspaceSearchMigrationControlPartialRollbackInput
  | WorkspaceSearchMigrationControlVerifyInput

/**
 * Detaches and validates one stage request before any external operation.
 *
 * The discriminant and approval are read exactly once. A captured discriminant
 * selects a stage-specific reader, so a Proxy or accessor cannot change an
 * approved apply request into terminal release between validation and dispatch.
 * Collaborator references remain live by design, while all scalar authority
 * bindings, byte arrays, and nested planning limits are detached synchronously.
 *
 * @param input - Caller-owned explicit coordinator stage request.
 * @returns Stable stage-specific request retained across every await.
 */
function snapshotCoordinatorInput(
  input: WorkspaceSearchMigrationControlCoordinatorInput,
): WorkspaceSearchMigrationControlCoordinatorInput {
  let modeValue: unknown
  let approvalValue: unknown
  try {
    modeValue = input.mode
    approvalValue = input.approval
  } catch {
    return failCoordinator('INVALID_ARGUMENT')
  }
  const mode = readCoordinatorMode(modeValue)
  requireCoordinatorApproval(mode, approvalValue)
  if (isCloseReplanInputForMode(input, mode)) {
    return snapshotCloseReplanInput(input)
  }
  if (isReleaseInputForMode(input, mode)) {
    return snapshotReleaseInput(input)
  }
  if (isExecutionInputForMode(input, mode)) {
    return snapshotExecutionInput(
      input,
      readCoordinatorExecutionMode(mode),
    )
  }
  return failCoordinator('INVALID_ARGUMENT')
}

/**
 * Narrows an input using only the already captured close/replan mode.
 *
 * @param _input - Original caller-owned union, deliberately not reread.
 * @param mode - Previously validated one-time discriminant snapshot.
 * @returns Whether the captured mode selects close and replanning.
 */
function isCloseReplanInputForMode(
  _input: WorkspaceSearchMigrationControlCoordinatorInput,
  mode: WorkspaceSearchMigrationControlCoordinatorMode,
): _input is WorkspaceSearchMigrationControlCloseReplanInput {
  return mode === 'close-replan'
}

/**
 * Narrows an input using only the already captured terminal-release mode.
 *
 * @param _input - Original caller-owned union, deliberately not reread.
 * @param mode - Previously validated one-time discriminant snapshot.
 * @returns Whether the captured mode selects terminal release.
 */
function isReleaseInputForMode(
  _input: WorkspaceSearchMigrationControlCoordinatorInput,
  mode: WorkspaceSearchMigrationControlCoordinatorMode,
): _input is WorkspaceSearchMigrationControlReleaseInput {
  return mode === 'release'
}

/**
 * Narrows an input using only a captured execution-stage mode.
 *
 * @param _input - Original caller-owned union, deliberately not reread.
 * @param mode - Previously validated one-time discriminant snapshot.
 * @returns Whether the captured mode selects an execution branch.
 */
function isExecutionInputForMode(
  _input: WorkspaceSearchMigrationControlCoordinatorInput,
  mode: WorkspaceSearchMigrationControlCoordinatorMode,
): _input is WorkspaceSearchMigrationControlExecutionInput {
  return mode !== 'close-replan' && mode !== 'release'
}

/**
 * Snapshots the complete close/replan request and nested planning limits.
 *
 * @param input - Close/replan input selected by the captured mode.
 * @returns Detached and synchronously validated close/replan request.
 */
function snapshotCloseReplanInput(
  input: WorkspaceSearchMigrationControlCloseReplanInput,
): WorkspaceSearchMigrationControlCloseReplanInput {
  let session: WorkspaceSearchMigrationControlCloseReplanInput['session']
  let provider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  let runIdValue: unknown
  let ownerIdValue: unknown
  let configurationHashValue: unknown
  let evidenceValue: unknown
  let limitsValue:
    WorkspaceSearchMigrationControlCloseReplanInput[
      'planningJoinLimits'
    ]
  let retainUntilValue: unknown
  let signal: AbortSignal | undefined
  let scheduler:
    WorkspaceSearchMigrationHeartbeatScheduler | undefined
  let clock: WorkspaceSearchMigrationHeartbeatClock | undefined
  let telemetryRecorder:
    WorkspaceSearchMigrationControlCloseReplanInput['telemetryRecorder']
  let checkpointStallClock:
    WorkspaceSearchMigrationControlCloseReplanInput[
      'checkpointStallClock'
    ]
  let checkpointStallSchedule:
    WorkspaceSearchMigrationControlCloseReplanInput[
      'checkpointStallSchedule'
    ]
  try {
    session = input.session
    provider = input.maintenanceEvidenceProvider
    runIdValue = input.runId
    ownerIdValue = input.ownerId
    configurationHashValue = input.expectedConfigurationHash
    evidenceValue = input.reviewedDryRunEvidenceBytes
    limitsValue = input.planningJoinLimits
    retainUntilValue = input.retainUntil
    signal = input.signal
    scheduler = input.heartbeatScheduler
    clock = input.clock
    telemetryRecorder = input.telemetryRecorder
    checkpointStallClock = input.checkpointStallClock
    checkpointStallSchedule = input.checkpointStallSchedule
  } catch {
    return failCoordinator('INVALID_ARGUMENT')
  }
  const runId = readCoordinatorIdentifier(runIdValue, 'Run ID')
  const ownerId = readCoordinatorIdentifier(ownerIdValue, 'Owner ID')
  const expectedConfigurationHash =
    readCoordinatorConfigurationHash(configurationHashValue)
  const reviewedDryRunEvidenceBytes =
    snapshotCoordinatorBytes(evidenceValue)
  const planningJoinLimits = snapshotCoordinatorPlanningLimits(
    limitsValue,
  )
  const retainUntil = readCoordinatorTimestamp(retainUntilValue)
  return {
    session,
    maintenanceEvidenceProvider: provider,
    runId,
    ownerId,
    expectedConfigurationHash,
    reviewedDryRunEvidenceBytes,
    planningJoinLimits,
    retainUntil,
    mode: 'close-replan',
    approval:
      workspaceSearchMigrationControlApprovalLiterals['close-replan'],
    ...(signal === undefined ? {} : { signal }),
    ...(scheduler === undefined
      ? {}
      : { heartbeatScheduler: scheduler }),
    ...(clock === undefined ? {} : { clock }),
    ...(telemetryRecorder === undefined ? {} : { telemetryRecorder }),
    ...(checkpointStallClock === undefined
      ? {}
      : { checkpointStallClock }),
    ...(checkpointStallSchedule === undefined
      ? {}
      : { checkpointStallSchedule }),
  }
}

/**
 * Snapshots one apply, verify, or rollback request.
 *
 * @param input - Execution input selected by the captured mode.
 * @param mode - Captured execution discriminant.
 * @returns Detached and synchronously validated execution request.
 */
function snapshotExecutionInput(
  input: WorkspaceSearchMigrationControlExecutionInput,
  mode: Exclude<
    WorkspaceSearchMigrationControlCoordinatorMode,
    'close-replan' | 'release'
  >,
): WorkspaceSearchMigrationControlExecutionInput {
  let session: WorkspaceSearchMigrationExecutionSupervisorSession
  let provider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  let runIdValue: unknown
  let ownerIdValue: unknown
  let configurationHashValue: unknown
  let signal: AbortSignal | undefined
  let scheduler:
    WorkspaceSearchMigrationHeartbeatScheduler | undefined
  let clock: WorkspaceSearchMigrationHeartbeatClock | undefined
  let telemetryRecorder:
    WorkspaceSearchMigrationControlExecutionInput['telemetryRecorder']
  let checkpointStallClock:
    WorkspaceSearchMigrationControlExecutionInput[
      'checkpointStallClock'
    ]
  let checkpointStallSchedule:
    WorkspaceSearchMigrationControlExecutionInput[
      'checkpointStallSchedule'
    ]
  try {
    session = input.session
    provider = input.maintenanceEvidenceProvider
    runIdValue = input.runId
    ownerIdValue = input.ownerId
    configurationHashValue = input.expectedConfigurationHash
    signal = input.signal
    scheduler = input.heartbeatScheduler
    clock = input.clock
    telemetryRecorder = input.telemetryRecorder
    checkpointStallClock = input.checkpointStallClock
    checkpointStallSchedule = input.checkpointStallSchedule
  } catch {
    return failCoordinator('INVALID_ARGUMENT')
  }
  const common = {
    session,
    maintenanceEvidenceProvider: provider,
    runId: readCoordinatorIdentifier(runIdValue, 'Run ID'),
    ownerId: readCoordinatorIdentifier(ownerIdValue, 'Owner ID'),
    expectedConfigurationHash:
      readCoordinatorConfigurationHash(configurationHashValue),
    ...(signal === undefined ? {} : { signal }),
    ...(scheduler === undefined
      ? {}
      : { heartbeatScheduler: scheduler }),
    ...(clock === undefined ? {} : { clock }),
    ...(telemetryRecorder === undefined ? {} : { telemetryRecorder }),
    ...(checkpointStallClock === undefined
      ? {}
      : { checkpointStallClock }),
    ...(checkpointStallSchedule === undefined
      ? {}
      : { checkpointStallSchedule }),
  }
  if (mode === 'apply') {
    return {
      ...common,
      mode,
      approval: workspaceSearchMigrationControlApprovalLiterals.apply,
    }
  }
  if (mode === 'verify') {
    return {
      ...common,
      mode,
      approval: workspaceSearchMigrationControlApprovalLiterals.verify,
    }
  }
  if (mode === 'rollback-partial') {
    return {
      ...common,
      mode,
      approval:
        workspaceSearchMigrationControlApprovalLiterals[
          'rollback-partial'
        ],
    }
  }
  return {
    ...common,
    mode: 'rollback-complete',
    approval:
      workspaceSearchMigrationControlApprovalLiterals[
        'rollback-complete'
      ],
  }
}

/**
 * Snapshots one terminal release request before configuration measurement.
 *
 * @param input - Release input selected by the captured mode.
 * @returns Detached and synchronously validated release request.
 */
function snapshotReleaseInput(
  input: WorkspaceSearchMigrationControlReleaseInput,
): WorkspaceSearchMigrationControlReleaseInput {
  let session: WorkspaceSearchMigrationControlReleaseSession
  let provider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  let runIdValue: unknown
  let ownerIdValue: unknown
  let configurationHashValue: unknown
  let signal: AbortSignal | undefined
  let scheduler:
    WorkspaceSearchMigrationHeartbeatScheduler | undefined
  let clock: WorkspaceSearchMigrationHeartbeatClock | undefined
  try {
    session = input.session
    provider = input.maintenanceEvidenceProvider
    runIdValue = input.runId
    ownerIdValue = input.ownerId
    configurationHashValue = input.expectedConfigurationHash
    signal = input.signal
    scheduler = input.heartbeatScheduler
    clock = input.clock
  } catch {
    return failCoordinator('INVALID_ARGUMENT')
  }
  return {
    session,
    maintenanceEvidenceProvider: provider,
    runId: readCoordinatorIdentifier(runIdValue, 'Run ID'),
    ownerId: readCoordinatorIdentifier(ownerIdValue, 'Owner ID'),
    expectedConfigurationHash:
      readCoordinatorConfigurationHash(configurationHashValue),
    mode: 'release',
    approval: workspaceSearchMigrationControlApprovalLiterals.release,
    ...(signal === undefined ? {} : { signal }),
    ...(scheduler === undefined
      ? {}
      : { heartbeatScheduler: scheduler }),
    ...(clock === undefined ? {} : { clock }),
  }
}

/**
 * Reads one bounded migration identifier without coercing arbitrary values.
 *
 * @param value - Candidate untrusted identifier.
 * @param label - Stable secret-free field label.
 * @returns Exact validated identifier.
 */
function readCoordinatorIdentifier(
  value: unknown,
  label: string,
): string {
  return typeof value === 'string'
    ? requireMigrationIdentifier(value, label)
    : failCoordinator('INVALID_ARGUMENT')
}

/**
 * Reads one exact reviewed lowercase SHA-256 configuration digest.
 *
 * @param value - Candidate untrusted digest.
 * @returns Exact validated digest.
 */
function readCoordinatorConfigurationHash(value: unknown): string {
  if (!isHexDigest(value)) return failCoordinator('INVALID_ARGUMENT')
  return value
}

/**
 * Detaches one canonical timestamp scalar.
 *
 * @param value - Candidate untrusted canonical timestamp.
 * @returns Exact validated timestamp.
 */
function readCoordinatorTimestamp(value: unknown): string {
  return isCanonicalTimestamp(value)
    ? value
    : failCoordinator('INVALID_ARGUMENT')
}

/**
 * Detaches reviewed evidence bytes before the close supervisor may retain them.
 *
 * @param value - Candidate byte array.
 * @returns Independent byte-for-byte snapshot.
 */
function snapshotCoordinatorBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    return failCoordinator('INVALID_ARGUMENT')
  }
  try {
    return Uint8Array.from(value)
  } catch {
    return failCoordinator('INVALID_ARGUMENT')
  }
}

/**
 * Reads and detaches positive safe planning limits before writer close.
 *
 * @param limits - Caller-owned nested limit object.
 * @returns Stable row, byte, and operation ceilings.
 */
function snapshotCoordinatorPlanningLimits(
  limits:
    WorkspaceSearchMigrationControlCloseReplanInput[
      'planningJoinLimits'
    ],
): WorkspaceSearchMigrationControlCloseReplanInput[
  'planningJoinLimits'
] {
  let maxTotalRows: unknown
  let maxTotalCanonicalItemBytes: unknown
  let maxPlanOperations: unknown
  try {
    maxTotalRows = limits.maxTotalRows
    maxTotalCanonicalItemBytes = limits.maxTotalCanonicalItemBytes
    maxPlanOperations = limits.maxPlanOperations
  } catch {
    return failCoordinator('INVALID_ARGUMENT')
  }
  if (
    typeof maxTotalRows !== 'number' ||
    !Number.isSafeInteger(maxTotalRows) ||
    maxTotalRows <= 0 ||
    maxTotalRows >
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_TOTAL_ROWS ||
    typeof maxTotalCanonicalItemBytes !== 'number' ||
    !Number.isSafeInteger(maxTotalCanonicalItemBytes) ||
    maxTotalCanonicalItemBytes <= 0 ||
    maxTotalCanonicalItemBytes >
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_CANONICAL_BYTES ||
    typeof maxPlanOperations !== 'number' ||
    !Number.isSafeInteger(maxPlanOperations) ||
    maxPlanOperations <= 0 ||
    maxPlanOperations >
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_OPERATIONS
  ) {
    return failCoordinator('INVALID_ARGUMENT')
  }
  return {
    maxTotalRows,
    maxTotalCanonicalItemBytes,
    maxPlanOperations,
  }
}

/**
 * Releases the writer fence from one exact immutable terminal graph.
 *
 * A previously committed matching release is recovered by a read before any
 * lease or evidence operation. A new release is performed only under a stable
 * heartbeat lease after fresh post-close evidence is renewed and strongly
 * reread. Terminal material is reread from the same measured generation before
 * the release adapter's atomic response-loss-reconciling transaction.
 *
 * @param input - Explicit release request and cooperative signal.
 */
async function releaseTerminalWriterFence(
  input: WorkspaceSearchMigrationControlReleaseInput,
): Promise<WorkspaceSearchMigrationControlReleaseEvidence> {
  const runId = requireMigrationIdentifier(input.runId, 'Run ID')
  const ownerId = requireMigrationIdentifier(input.ownerId, 'Owner ID')
  requireExpectedConfigurationHash(input.expectedConfigurationHash)
  const clock = input.clock ?? defaultCoordinatorClock
  const guard = createCoordinatorSignalGuard(input.signal)
  const configuration = await runCoordinatorOperation(
    guard,
    () => input.session.measureConfiguration(),
  )
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  if (configurationHash !== input.expectedConfigurationHash) {
    return failCoordinator('CONFIGURATION_HASH_MISMATCH')
  }
  const preflightFence = await runCoordinatorOperation(
    guard,
    () => input.session.createApplicationWriterFencePort().read(),
  )
  if (
    isReleasedFenceRecoveryCandidate(
      preflightFence,
      runId,
      configurationHash,
    )
  ) {
    const releasedStatus = await runCoordinatorOperation(
      guard,
      () => readMeasuredWorkspaceSearchMigrationExecutionStatus({
        session: input.session,
        configuration,
        runId,
        expectedConfigurationHash: configurationHash,
        ...(input.signal === undefined
          ? {}
          : { signal: input.signal }),
      }),
    )
    if (
      (releasedStatus.phase !== 'verified' &&
        releasedStatus.phase !== 'rolled-back') ||
      releasedStatus.nextAction.kind !== 'none'
    ) {
      return failCoordinator('INVALID_STATE')
    }
    return createControlReleaseEvidence(preflightFence)
  }

  const terminal = await runCoordinatorOperation(
    guard,
    () => readMeasuredWorkspaceSearchMigrationExecutionTerminalRelease({
      session: input.session,
      configuration,
      runId,
      expectedConfigurationHash: configurationHash,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  )
  if (terminal === undefined) {
    return failCoordinator('INVALID_STATE')
  }
  const lease = await runCoordinatorOperation(
    guard,
    () => input.session.acquireLease({ runId, ownerId }),
  )
  return await runWithWorkspaceSearchMigrationHeartbeat({
    lease,
    port: input.session,
    signal: input.signal,
    scheduler: input.heartbeatScheduler,
    clock,
    task: async (context) => {
      const authority = await renewReleaseAuthority({
        session: input.session,
        provider: input.maintenanceEvidenceProvider,
        context,
        configurationHash,
        tableIds:
          terminal.sealedPlanningAuthority.tableIds,
        closedAt: terminal.executionBoundary.closedAt,
        clock,
      })
      await requireCurrentReleaseAuthority(
        input.session,
        authority,
        context,
        configurationHash,
        terminal.sealedPlanningAuthority.tableIds,
        clock,
      )
      const currentTerminal = await runCoordinatorOperation(
        context,
        () => readMeasuredWorkspaceSearchMigrationExecutionTerminalRelease({
          session: input.session,
          configuration,
          runId,
          expectedConfigurationHash: configurationHash,
          signal: context.signal,
        }),
      )
      if (
        currentTerminal === undefined ||
        !sameTerminalReleaseGraph(terminal, currentTerminal)
      ) {
        return failCoordinator('INVALID_STATE')
      }
      await requireCurrentReleaseAuthority(
        input.session,
        authority,
        context,
        configurationHash,
        terminal.sealedPlanningAuthority.tableIds,
        clock,
      )
      const released = await runCoordinatorOperation(
        context,
        () => input.session
          .createApplicationWriterFencePort()
          .release(currentTerminal),
      )
      requireMatchingReleasedFence(
        released,
        runId,
        configurationHash,
        currentTerminal,
      )
      return createControlReleaseEvidence(released)
    },
  })
}

/**
 * Projects one strict released writer-fence observation into external evidence.
 *
 * @param observation - Exact durable release response or recovery observation.
 * @returns Identifier-free terminal and released-record digests.
 */
function createControlReleaseEvidence(
  observation: WorkspaceSearchWriterFenceObservation,
): WorkspaceSearchMigrationControlReleaseEvidence {
  if (
    observation.status !== 'present' ||
    observation.record.mode !== 'open' ||
    observation.record.version !== 2
  ) {
    return failCoordinator('INVALID_STATE')
  }
  const record = observation.record
  return {
    terminalKind: record.release.terminal.kind,
    terminalPersistenceVersion:
      record.release.terminal.persistenceVersion,
    terminalRootDigest: record.release.terminal.rootDigest,
    writerFenceRecordDigest: record.recordDigest,
    releasedAt: record.openedAt,
  }
}

/**
 * Fixed material used to renew fresh release evidence under one heartbeat.
 */
type RenewReleaseAuthorityInput = {
  /** Measured mutating execution session. */
  readonly session: WorkspaceSearchMigrationControlReleaseSession
  /** Trusted post-close evidence provider. */
  readonly provider: WorkspaceSearchMigrationMaintenanceEvidenceProvider
  /** Stable heartbeat lease and cancellation context. */
  readonly context: WorkspaceSearchMigrationHeartbeatTaskContext
  /** Reviewed current measured configuration digest. */
  readonly configurationHash: string
  /** Exact six TableIds fixed by the sealed planning root. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Exact canonical writer-fence close time. */
  readonly closedAt: string
  /** Trusted clock shared with heartbeat supervision. */
  readonly clock: WorkspaceSearchMigrationHeartbeatClock
}

/**
 * Collects, validates, and durably selects fresh post-close release evidence.
 *
 * @param input - Stable heartbeat, exact terminal bindings, provider, and clock.
 * @returns Exact newly selected current authority.
 */
async function renewReleaseAuthority(
  input: RenewReleaseAuthorityInput,
): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
  const pointer = await runCoordinatorOperation(
    input.context,
    () => input.session.readMaintenanceEvidencePointer(
      input.context.lease,
    ),
  )
  let collected: Awaited<
    ReturnType<WorkspaceSearchMigrationMaintenanceEvidenceProvider['collect']>
  >
  try {
    collected = await runCoordinatorOperation(
      input.context,
      () => input.provider.collect({
        phase: 'post-close',
        runId: input.context.lease.runId,
        configurationHash: input.configurationHash,
        tableIds: structuredClone(input.tableIds),
        closedAt: input.closedAt,
        signal: input.context.signal,
      }),
    )
  } catch {
    input.context.assertActive()
    return failCoordinator('TRANSIENT_INFRASTRUCTURE_FAILURE')
  }
  let evidenceBytes: Uint8Array
  try {
    if (
      collected.configurationHash !== input.configurationHash ||
      !sameTableIds(collected.tableIds, input.tableIds) ||
      !(collected.evidenceBytes instanceof Uint8Array)
    ) {
      return failCoordinator('INVALID_MAINTENANCE_EVIDENCE')
    }
    evidenceBytes = Uint8Array.from(collected.evidenceBytes)
  } catch {
    return failCoordinator('INVALID_MAINTENANCE_EVIDENCE')
  }
  let drainStartedAt: string
  try {
    drainStartedAt = parseMaintenanceEvidence(evidenceBytes, {
      now: readCoordinatorClock(input.clock),
    }).evidence.drainStartedAt
  } catch {
    return failCoordinator('INVALID_MAINTENANCE_EVIDENCE')
  }
  const drainStartedMilliseconds = Date.parse(drainStartedAt)
  const closedMilliseconds = Date.parse(input.closedAt)
  if (
    !Number.isFinite(drainStartedMilliseconds) ||
    !Number.isFinite(closedMilliseconds) ||
    drainStartedMilliseconds < closedMilliseconds
  ) {
    return failCoordinator('INVALID_MAINTENANCE_EVIDENCE')
  }
  const authority = await runCoordinatorOperation(
    input.context,
    () => input.session.renewMaintenanceEvidence({
      lease: input.context.lease,
      expectedPointer: pointer,
      evidenceBytes,
    }),
  )
  requireReleaseAuthorityBinding(
    authority,
    input.context,
    input.configurationHash,
    input.tableIds,
    input.clock,
  )
  return authority
}

/**
 * Strongly rereads one exact release authority and requires commit headroom.
 *
 * @param session - Measured authority read capability.
 * @param authority - Latest renewed authority identity.
 * @param context - Stable heartbeat lease and activity guard.
 * @param configurationHash - Reviewed measured configuration digest.
 * @param tableIds - Exact six sealed TableIds.
 * @param clock - Trusted release clock.
 */
async function requireCurrentReleaseAuthority(
  session: WorkspaceSearchMigrationControlReleaseSession,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  context: WorkspaceSearchMigrationHeartbeatTaskContext,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  clock: WorkspaceSearchMigrationHeartbeatClock,
): Promise<void> {
  const refreshed = await runCoordinatorOperation(
    context,
    () => session.readAuthority(createAuthorityClaim(authority)),
  )
  requireReleaseAuthorityBinding(
    refreshed,
    context,
    configurationHash,
    tableIds,
    clock,
  )
}

/**
 * Requires current authority to remain bound to the exact release generation.
 *
 * @param authority - Candidate fresh authority.
 * @param context - Stable heartbeat lease identity.
 * @param configurationHash - Reviewed measured configuration digest.
 * @param tableIds - Exact six sealed TableIds.
 * @param clock - Trusted release clock.
 */
function requireReleaseAuthorityBinding(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  context: WorkspaceSearchMigrationHeartbeatTaskContext,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  clock: WorkspaceSearchMigrationHeartbeatClock,
): void {
  const threshold = readCoordinatorClock(clock).getTime() +
    WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  const leaseExpiresAt = Date.parse(authority.lease.expiresAt)
  const evidenceValidUntil = Date.parse(
    authority.maintenanceEvidenceReceipt.validUntil,
  )
  if (
    authority.configurationHash !== configurationHash ||
    authority.stateTableId !== tableIds['migration-state'] ||
    authority.lease.runId !== context.lease.runId ||
    authority.lease.ownerId !== context.lease.ownerId ||
    authority.lease.fenceToken !== context.lease.fenceToken ||
    authority.maintenanceEvidenceReceipt.runId !==
      context.lease.runId ||
    authority.maintenanceEvidenceReceipt.fenceToken !==
      context.lease.fenceToken ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= threshold ||
    !Number.isFinite(evidenceValidUntil) ||
    evidenceValidUntil <= threshold
  ) {
    return failCoordinator('LEASE_LOST')
  }
}

/**
 * Projects one rich authority into its exact durable read claim.
 *
 * @param authority - Fresh renewed release authority.
 * @returns Exact lease, pointer revision, and receipt digest claim.
 */
function createAuthorityClaim(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationPrePlanAuthorityClaim {
  return {
    lease: {
      runId: authority.lease.runId,
      ownerId: authority.lease.ownerId,
      fenceToken: authority.lease.fenceToken,
    },
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
  }
}

/**
 * Minimal activity guard used before each release read or mutation.
 */
type CoordinatorOperationGuard = {
  /** Throws the stable interruption before another external operation. */
  readonly assertActive: () => void
}

/**
 * Creates one signal-only release guard.
 *
 * @param signal - Optional cooperative operator signal.
 * @returns Minimal pre-operation activity assertion.
 */
function createCoordinatorSignalGuard(
  signal: AbortSignal | undefined,
): CoordinatorOperationGuard {
  return {
    assertActive: () => assertCoordinatorActive(signal),
  }
}

/**
 * Brackets one release read, mutation, or response-loss reconciliation.
 *
 * @param guard - Current signal activity guard.
 * @param operation - One complete external operation.
 * @returns Exact completed result while the signal remains active.
 */
async function runCoordinatorOperation<Result>(
  guard: CoordinatorOperationGuard,
  operation: () => Promise<Result>,
): Promise<Result> {
  guard.assertActive()
  try {
    const result = await operation()
    guard.assertActive()
    return result
  } catch (error: unknown) {
    guard.assertActive()
    throw error
  }
}

/**
 * Identifies a canonical released row that requires full read-only recovery.
 *
 * @param observation - Fresh strongly read writer-fence observation.
 * @param runId - Exact operator-selected run.
 * @param configurationHash - Freshly measured configuration digest.
 * @returns Whether released-graph reconstruction must run before success.
 */
function isReleasedFenceRecoveryCandidate(
  observation: WorkspaceSearchWriterFenceObservation,
  runId: string,
  configurationHash: string,
): boolean {
  if (observation.status !== 'present') {
    return failCoordinator('INVALID_STATE')
  }
  const record = observation.record
  if (record.mode === 'closed') return false
  if (
    record.version !== 2 ||
    record.release.runId !== runId ||
    record.release.configurationHash !== configurationHash
  ) {
    return failCoordinator('INVALID_STATE')
  }
  return true
}

/**
 * Requires a release response to match the exact supplied terminal graph.
 *
 * @param observation - Strongly reread release response.
 * @param runId - Exact operator-selected run.
 * @param configurationHash - Freshly measured configuration digest.
 * @param terminal - Exact immutable graph passed to the release adapter.
 */
function requireMatchingReleasedFence(
  observation: WorkspaceSearchWriterFenceObservation,
  runId: string,
  configurationHash: string,
  terminal: WorkspaceSearchMigrationExecutionTerminalRelease,
): void {
  if (
    observation.status !== 'present' ||
    observation.record.mode !== 'open' ||
    observation.record.version !== 2
  ) {
    return failCoordinator('INVALID_STATE')
  }
  const record = observation.record
  const expectedTerminal = createWriterFenceTerminalOutcome(
    terminal,
  )
  if (
    record.release.runId !== runId ||
    record.release.configurationHash !== configurationHash ||
    record.release.executionBoundaryDigest !==
      terminal.executionBoundary.boundaryDigest ||
    record.release.sealedPlanningAuthorityDigest !==
      terminal.sealedPlanningAuthority.authorityDigest ||
    record.release.executionRunDigest !==
      terminal.executionRun.executionRunDigest ||
    !sameWriterFenceTerminalOutcome(
      record.release.terminal,
      expectedTerminal,
    )
  ) {
    return failCoordinator('INVALID_STATE')
  }
}

/**
 * Projects an exact release terminal into the writer-fence identity tuple.
 *
 * @param release - Exact immutable release graph.
 * @returns Stable terminal kind, schema version, and root digest.
 */
function createWriterFenceTerminalOutcome(
  release: WorkspaceSearchMigrationExecutionTerminalRelease,
): WorkspaceSearchWriterFenceTerminalOutcome {
  if (release.terminal.kind === 'verified') {
    return {
      kind: 'verified',
      persistenceVersion: 1,
      rootDigest: release.terminal.root.verifiedRootDigest,
    }
  }
  return {
    kind: 'rolled-back',
    persistenceVersion:
      release.terminal.kind === 'rolled-back-v1' ? 1 : 2,
    rootDigest: release.terminal.root.rootDigest,
  }
}

/**
 * Compares two strict terminal release identities.
 *
 * @param left - Durable released writer-fence terminal identity.
 * @param right - Identity reconstructed from the exact terminal graph.
 * @returns Whether all stable terminal fields match exactly.
 */
function sameWriterFenceTerminalOutcome(
  left: WorkspaceSearchWriterFenceTerminalOutcome,
  right: WorkspaceSearchWriterFenceTerminalOutcome,
): boolean {
  return left.kind === right.kind &&
    left.persistenceVersion === right.persistenceVersion &&
    left.rootDigest === right.rootDigest
}

/**
 * Compares two immutable terminal graphs by every release-fixed digest.
 *
 * @param left - Terminal graph observed before lease acquisition.
 * @param right - Terminal graph strongly reread under the heartbeat.
 * @returns Whether both observations describe the exact same release.
 */
function sameTerminalReleaseGraph(
  left: WorkspaceSearchMigrationExecutionTerminalRelease,
  right: WorkspaceSearchMigrationExecutionTerminalRelease,
): boolean {
  return left.executionBoundary.boundaryDigest ===
      right.executionBoundary.boundaryDigest &&
    left.sealedPlanningAuthority.authorityDigest ===
      right.sealedPlanningAuthority.authorityDigest &&
    left.executionRun.executionRunDigest ===
      right.executionRun.executionRunDigest &&
    sameWriterFenceTerminalOutcome(
      createWriterFenceTerminalOutcome(left),
      createWriterFenceTerminalOutcome(right),
    )
}

/**
 * Compares every fixed TableId role without exposing physical identifiers.
 *
 * @param left - Provider-observed six-table binding.
 * @param right - Sealed planning six-table binding.
 * @returns Whether all exact immutable TableIds match.
 */
function sameTableIds(
  left: WorkspaceSearchMigrationSealedPlanningTableIds,
  right: WorkspaceSearchMigrationSealedPlanningTableIds,
): boolean {
  return left['project-directory'] === right['project-directory'] &&
    left['work-items'] === right['work-items'] &&
    left.collaboration === right.collaboration &&
    left.documents === right.documents &&
    left['workspace-search'] === right['workspace-search'] &&
    left['migration-state'] === right['migration-state']
}

/**
 * Reads and detaches one valid trusted coordinator clock sample.
 *
 * @param clock - Candidate trusted release clock.
 * @returns Detached finite Date.
 */
function readCoordinatorClock(
  clock: WorkspaceSearchMigrationHeartbeatClock,
): Date {
  let value: unknown
  try {
    value = clock()
  } catch {
    return failCoordinator('INVALID_ARGUMENT')
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return failCoordinator('INVALID_ARGUMENT')
  }
  return new Date(value.getTime())
}

/**
 * Returns the current system time for production coordinator supervision.
 *
 * @returns Current detached Date.
 */
function defaultCoordinatorClock(): Date {
  return new Date()
}

/**
 * Maps public coordinator branch names to the existing execution supervisor.
 *
 * @param mode - Explicit non-release coordinator execution stage.
 * @returns Existing supervisor's exact branch name.
 */
function mapExecutionSupervisorMode(
  mode:
    | 'apply'
    | 'rollback-complete'
    | 'rollback-partial'
    | 'verify',
): SuperviseWorkspaceSearchMigrationExecutionInput['mode'] {
  if (mode === 'rollback-partial') return 'partial-rollback'
  if (mode === 'rollback-complete') return 'complete-rollback'
  return mode
}

/**
 * Requires a captured coordinator mode to select an execution branch.
 *
 * @param mode - Previously validated coordinator mode.
 * @returns Exact non-planning, non-release execution mode.
 */
function readCoordinatorExecutionMode(
  mode: WorkspaceSearchMigrationControlCoordinatorMode,
): Exclude<
  WorkspaceSearchMigrationControlCoordinatorMode,
  'close-replan' | 'release'
> {
  if (mode === 'close-replan' || mode === 'release') {
    return failCoordinator('INVALID_ARGUMENT')
  }
  return mode
}

/**
 * Reads one supported coordinator mode through a raw-value-free failure.
 *
 * @param value - Candidate untrusted stage name.
 * @returns Exact supported stage name.
 */
function readCoordinatorMode(
  value: unknown,
): WorkspaceSearchMigrationControlCoordinatorMode {
  if (
    value !== 'close-replan' &&
    value !== 'apply' &&
    value !== 'verify' &&
    value !== 'rollback-partial' &&
    value !== 'rollback-complete' &&
    value !== 'release'
  ) {
    return failCoordinator('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires the exact literal assigned to the selected mutation stage.
 *
 * @param mode - Validated explicit coordinator stage.
 * @param approval - Candidate exact operator approval phrase.
 */
function requireCoordinatorApproval(
  mode: WorkspaceSearchMigrationControlCoordinatorMode,
  approval: unknown,
): void {
  if (approval !== workspaceSearchMigrationControlApprovalLiterals[mode]) {
    return failCoordinator('INVALID_ARGUMENT')
  }
}

/**
 * Requires one expected reviewed configuration digest.
 *
 * @param value - Candidate lowercase SHA-256 digest.
 */
function requireExpectedConfigurationHash(value: unknown): void {
  if (!isHexDigest(value)) {
    return failCoordinator('INVALID_ARGUMENT')
  }
}

/**
 * Throws before another coordinator operation after interruption.
 *
 * @param signal - Optional cooperative operator signal.
 */
function assertCoordinatorActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new WorkspaceSearchMigrationHeartbeatInterruptedError()
  }
}

/**
 * Throws one stable raw-value-free coordinator failure.
 *
 * @param code - Stable public migration failure code.
 */
function failCoordinator(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new WorkspaceSearchMigrationFailure(code, code)
}
