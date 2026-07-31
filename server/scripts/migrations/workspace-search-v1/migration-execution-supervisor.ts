import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isHexDigest,
  requireMigrationIdentifier,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  runWithWorkspaceSearchMigrationHeartbeat,
  type WorkspaceSearchMigrationHeartbeatClock,
  type WorkspaceSearchMigrationHeartbeatScheduler,
  type WorkspaceSearchMigrationHeartbeatTaskContext,
  WorkspaceSearchMigrationHeartbeatInterruptedError,
} from './migration-heartbeat-supervisor'
import type {
  WorkspaceSearchMigrationManagedAwsSession,
  WorkspaceSearchMigrationManagedPartialRollbackAwsPort,
} from './migration-identity-aws'
import type {
  WorkspaceSearchMigrationPlanArtifactReplayResult,
} from './migration-plan-artifact'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanAuthorityClaim,
  WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationCheckpointLocation,
} from './migration-state-machine'
import {
  parseMaintenanceEvidence,
} from './maintenance-evidence'
import type {
  WorkspaceSearchMigrationMaintenanceEvidenceProvider,
} from './migration-post-close-planning-supervisor'
import type {
  WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import type {
  WorkspaceSearchMigrationApplyOperationAwsPort,
} from './migration-apply-operation-aws'
import type {
  WorkspaceSearchMigrationFullVerificationAwsPort,
} from './migration-full-verification-aws'
import type {
  WorkspaceSearchMigrationRollbackOperationAwsPort,
} from './migration-rollback-operation-aws'
import type {
  WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'

const checkpointLocations: readonly WorkspaceSearchMigrationCheckpointLocation[] = [
  'project-directory',
  'work-items',
  'collaboration',
  'documents',
  'target',
]

/**
 * Public durable execution phase reconstructed without acquiring a lease.
 */
export type WorkspaceSearchMigrationExecutionPhase =
  | 'ready'
  | 'applying'
  | 'applied'
  | 'verifying'
  | 'verified'
  | 'rolling-back'
  | 'rolled-back'

/**
 * Secret-free operator action derived from the authoritative durable graph.
 */
export type WorkspaceSearchMigrationExecutionNextAction =
  | {
      /** Continues admission or forward apply work. */
      readonly kind: 'apply'
    }
  | {
      /** Requires an explicit operator branch decision. */
      readonly kind: 'choose'
      /** Exact legal branch choices in the current durable phase. */
      readonly options:
        | readonly ['apply', 'partial-rollback']
        | readonly ['verify', 'complete-rollback']
    }
  | {
      /** Continues full independent verification. */
      readonly kind: 'verify'
    }
  | {
      /** Continues an already selected rollback branch. */
      readonly kind: 'rollback'
      /** Durable rollback scope fixed when the branch started. */
      readonly scope: 'committed-prefix' | 'complete-plan'
    }
  | {
      /** No further execution mutation is legal for this terminal root. */
      readonly kind: 'none'
    }

/**
 * Secret-free read-only projection of the durable execution graph.
 */
export type WorkspaceSearchMigrationExecutionStatus = {
  /** Authoritative execution phase. */
  readonly phase: WorkspaceSearchMigrationExecutionPhase
  /** Deterministic next operator action. */
  readonly nextAction: WorkspaceSearchMigrationExecutionNextAction
}

/**
 * Managed session surface needed by read-only execution status.
 */
export type WorkspaceSearchMigrationExecutionStatusSession = Pick<
  WorkspaceSearchMigrationManagedAwsSession,
  | 'createApplicationWriterFencePort'
  | 'createApplyOperationPort'
  | 'createExecutionBoundaryPort'
  | 'createExecutionRunPort'
  | 'createFullVerificationPort'
  | 'createPartialRollbackOperationPort'
  | 'createPlanningArtifactGateway'
  | 'createRollbackOperationPort'
  | 'createSealedPlanningAuthorityPort'
  | 'measureConfiguration'
>

/**
 * Managed session surface needed by mutating execution supervision.
 */
export type WorkspaceSearchMigrationExecutionSupervisorSession =
  WorkspaceSearchMigrationExecutionStatusSession &
  Pick<
    WorkspaceSearchMigrationManagedAwsSession,
    | 'acquireLease'
    | 'heartbeatLease'
    | 'readAuthority'
    | 'readMaintenanceEvidenceReceipt'
    | 'readMaintenanceEvidencePointer'
    | 'renewMaintenanceEvidence'
  >

/**
 * Input for one secret-free read-only execution status reconstruction.
 */
export type ReadWorkspaceSearchMigrationExecutionStatusInput = {
  /** Fresh managed measured AWS session. */
  readonly session: WorkspaceSearchMigrationExecutionStatusSession
  /** Operator-selected migration run to inspect. */
  readonly runId: string
  /** Reviewed configuration digest expected from fresh measurement. */
  readonly expectedConfigurationHash: string
}

/**
 * Explicit branch selected for one supervised execution run.
 */
export type WorkspaceSearchMigrationExecutionSupervisorMode =
  | 'apply'
  | 'verify'
  | 'partial-rollback'
  | 'complete-rollback'

/**
 * Input for one heartbeat-supervised execution run.
 */
export type SuperviseWorkspaceSearchMigrationExecutionInput = {
  /** Fresh managed measured AWS session. */
  readonly session: WorkspaceSearchMigrationExecutionSupervisorSession
  /** Trusted provider for fresh post-close maintenance evidence. */
  readonly maintenanceEvidenceProvider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  /** Operator-selected migration run shared by every durable command. */
  readonly runId: string
  /** Process-unique lease owner used for acquisition or takeover. */
  readonly ownerId: string
  /** Reviewed configuration digest expected from fresh measurement. */
  readonly expectedConfigurationHash: string
  /** Explicit forward, verify, or rollback branch. */
  readonly mode: WorkspaceSearchMigrationExecutionSupervisorMode
  /** Optional operator-interruption signal. */
  readonly signal?: AbortSignal
  /** Optional deterministic heartbeat scheduler used by tests. */
  readonly heartbeatScheduler?:
    WorkspaceSearchMigrationHeartbeatScheduler
  /** Optional trusted clock shared by evidence and heartbeat checks. */
  readonly clock?: WorkspaceSearchMigrationHeartbeatClock
}

/**
 * Minimal operation guard shared by status and supervised paths.
 */
type ExecutionOperationGuard = {
  /** Fails before another external operation may begin. */
  readonly assertActive: () => void
}

/**
 * Static execution roots and exact replayed plan for one measured generation.
 */
type LoadedExecutionContext = {
  /** Fresh measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the measured configuration. */
  readonly configurationHash: string
  /** Exact revision-two planning admission. */
  readonly boundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable version-two sealed planning root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact closed application-writer fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact-version replayed plan artifacts and operations. */
  readonly replay: WorkspaceSearchMigrationPlanArtifactReplayResult
  /** Existing immutable execution admission, when created. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun | undefined
}

/**
 * Ports bound to one immutable execution admission.
 */
type ExecutionPhasePorts = {
  /** Forward apply and apply-state reader. */
  readonly apply: WorkspaceSearchMigrationApplyOperationAwsPort
  /** Independent full verification. */
  readonly verification: WorkspaceSearchMigrationFullVerificationAwsPort
  /** Committed-prefix partial rollback. */
  readonly partialRollback:
    WorkspaceSearchMigrationManagedPartialRollbackAwsPort
  /** Complete applied-root rollback. */
  readonly completeRollback:
    WorkspaceSearchMigrationRollbackOperationAwsPort
}

/**
 * Private phase snapshot paired with the public secret-free projection.
 */
type DurableExecutionSnapshot =
  | {
      /** No immutable execution admission exists yet. */
      readonly kind: 'ready'
      /** Public secret-free status. */
      readonly status: WorkspaceSearchMigrationExecutionStatus
    }
  | {
      /** Forward applying state without a started rollback branch. */
      readonly kind: 'applying'
      /** Current reconstructed applying run state. */
      readonly runState: Awaited<
        ReturnType<WorkspaceSearchMigrationApplyOperationAwsPort['readRunState']>
      >
      /** Public secret-free status. */
      readonly status: WorkspaceSearchMigrationExecutionStatus
    }
  | {
      /** Applied root awaits an explicit verify or rollback decision. */
      readonly kind: 'applied'
      /** Current reconstructed applied run state. */
      readonly runState: Awaited<
        ReturnType<WorkspaceSearchMigrationApplyOperationAwsPort['readRunState']>
      >
      /** Public secret-free status. */
      readonly status: WorkspaceSearchMigrationExecutionStatus
    }
  | {
      /** Full verification is durably in progress. */
      readonly kind: 'verifying'
      /** Current reconstructed applied run state. */
      readonly runState: Awaited<
        ReturnType<WorkspaceSearchMigrationApplyOperationAwsPort['readRunState']>
      >
      /** Current durable verification progress. */
      readonly progress: NonNullable<
        Awaited<
          ReturnType<
            WorkspaceSearchMigrationFullVerificationAwsPort['readProgress']
          >
        >
      >
      /** Public secret-free status. */
      readonly status: WorkspaceSearchMigrationExecutionStatus
    }
  | {
      /** Immutable verified root is authoritative. */
      readonly kind: 'verified'
      /** Public secret-free status. */
      readonly status: WorkspaceSearchMigrationExecutionStatus
    }
  | {
      /** Committed-prefix rollback is durably in progress. */
      readonly kind: 'partial-rollback'
      /** Current durable partial rollback lifecycle. */
      readonly lifecycle: NonNullable<
        Awaited<
          ReturnType<
            WorkspaceSearchMigrationManagedPartialRollbackAwsPort[
              'readRollbackLifecycle'
            ]
          >
        >
      >
      /** Public secret-free status. */
      readonly status: WorkspaceSearchMigrationExecutionStatus
    }
  | {
      /** Complete-plan rollback is durably in progress. */
      readonly kind: 'complete-rollback'
      /** Current durable complete rollback state. */
      readonly rollbackState: NonNullable<
        Awaited<
          ReturnType<
            WorkspaceSearchMigrationRollbackOperationAwsPort[
              'readRollbackState'
            ]
          >
        >
      >
      /** Public secret-free status. */
      readonly status: WorkspaceSearchMigrationExecutionStatus
    }
  | {
      /** An immutable partial or complete rollback root is authoritative. */
      readonly kind: 'rolled-back'
      /** Durable terminal rollback scope. */
      readonly scope: 'committed-prefix' | 'complete-plan'
      /** Public secret-free status. */
      readonly status: WorkspaceSearchMigrationExecutionStatus
    }

/**
 * Reads the durable execution graph without acquiring or renewing a lease.
 *
 * @param input - Managed session, run identity, and reviewed configuration.
 * @returns Secret-free deterministic phase and next operator action.
 */
export async function readWorkspaceSearchMigrationExecutionStatus(
  input: ReadWorkspaceSearchMigrationExecutionStatusInput,
): Promise<WorkspaceSearchMigrationExecutionStatus> {
  const request = snapshotExecutionStatusInput(input)
  const runId = requireMigrationIdentifier(request.runId, 'Run ID')
  requireExpectedConfigurationHash(request.expectedConfigurationHash)
  const guard = createSignalGuard()
  const loaded = await loadExecutionContext(
    request.session,
    runId,
    request.expectedConfigurationHash,
    guard,
  )
  if (loaded.executionRun === undefined) {
    return readyStatus()
  }
  const ports = createExecutionPhasePorts(
    request.session,
    loaded,
    loaded.executionRun,
  )
  return (
    await readDurableExecutionSnapshot(ports, guard)
  ).status
}

/**
 * Drives the explicit execution branch to its next durable phase boundary.
 *
 * Every adapter invocation is bracketed by heartbeat activity checks. Lower
 * adapters finish in-flight response-loss reconciliation before returning;
 * the post-call assertion then prevents any later mutation after interruption
 * or lease loss.
 *
 * @param input - Managed session, evidence provider, run identity, and mode.
 * @returns Secret-free durable status reached by the explicit branch.
 */
export async function superviseWorkspaceSearchMigrationExecution(
  input: SuperviseWorkspaceSearchMigrationExecutionInput,
): Promise<WorkspaceSearchMigrationExecutionStatus> {
  const request = snapshotExecutionSupervisorInput(input)
  const runId = requireMigrationIdentifier(request.runId, 'Run ID')
  const ownerId = requireMigrationIdentifier(request.ownerId, 'Owner ID')
  requireExpectedConfigurationHash(request.expectedConfigurationHash)
  const mode = readSupervisorMode(request.mode)
  const clock = request.clock ?? defaultExecutionClock
  const initialGuard = createSignalGuard(request.signal)
  const loaded = await loadExecutionContext(
    request.session,
    runId,
    request.expectedConfigurationHash,
    initialGuard,
  )
  if (loaded.executionRun === undefined) {
    if (mode !== 'apply') {
      return failExecutionSupervisor('INVALID_STATE')
    }
  } else {
    const preflightPorts = createExecutionPhasePorts(
      request.session,
      loaded,
      loaded.executionRun,
    )
    const preflightSnapshot =
      await readDurableExecutionSnapshot(
        preflightPorts,
        initialGuard,
      )
    const completed = requireExecutionModeSnapshot(
      preflightSnapshot,
      mode,
    )
    if (completed !== undefined) return completed
  }
  const lease = await runGuardedOperation(
    initialGuard,
    () => request.session.acquireLease({ runId, ownerId }),
  )
  return runWithWorkspaceSearchMigrationHeartbeat({
    lease,
    port: request.session,
    signal: request.signal,
    scheduler: request.heartbeatScheduler,
    clock,
    task: async (context) => {
      const authority = new ExecutionAuthorityController({
        session: request.session,
        provider: request.maintenanceEvidenceProvider,
        context,
        configurationHash: loaded.configurationHash,
        tableIds: loaded.sealedPlanningAuthority.tableIds,
        closedAt: loaded.closedWriterFenceRecord.closedAt,
        clock,
      })
      await authority.initialize()
      return runExecutionMode(
        request.session,
        loaded,
        authority,
        context,
        mode,
      )
    },
  })
}

/**
 * Mutable authority controller scoped to one heartbeat-owned lease.
 */
class ExecutionAuthorityController {
  /** Managed current-authority operations. */
  private readonly session:
    WorkspaceSearchMigrationExecutionSupervisorSession
  /** Trusted post-close evidence collector. */
  private readonly provider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  /** Heartbeat-owned lease, signal, and activity assertion. */
  private readonly context: WorkspaceSearchMigrationHeartbeatTaskContext
  /** Reviewed measured configuration digest. */
  private readonly configurationHash: string
  /** Exact measured six-table incarnation binding. */
  private readonly tableIds:
    WorkspaceSearchMigrationSealedPlanningTableIds
  /** Exact durable writer-fence close time. */
  private readonly closedAt: string
  /** Trusted wall clock. */
  private readonly clock: WorkspaceSearchMigrationHeartbeatClock
  /** Current durable pointer, or null after an unbound takeover. */
  private pointer:
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null | undefined
  /** Latest resolved or renewed authority. */
  private authority: WorkspaceSearchMigrationPrePlanAuthority | undefined

  /**
   * Creates one heartbeat-scoped execution authority controller.
   *
   * @param input - Session, provider, context, bindings, close time, and clock.
   */
  constructor(input: {
    /** Managed execution session. */
    readonly session:
      WorkspaceSearchMigrationExecutionSupervisorSession
    /** Trusted maintenance evidence provider. */
    readonly provider:
      WorkspaceSearchMigrationMaintenanceEvidenceProvider
    /** Stable heartbeat task context. */
    readonly context: WorkspaceSearchMigrationHeartbeatTaskContext
    /** Reviewed measured configuration digest. */
    readonly configurationHash: string
    /** Exact measured table identifiers. */
    readonly tableIds:
      WorkspaceSearchMigrationSealedPlanningTableIds
    /** Exact durable writer-fence close time. */
    readonly closedAt: string
    /** Trusted wall clock. */
    readonly clock: WorkspaceSearchMigrationHeartbeatClock
  }) {
    this.session = input.session
    this.provider = input.provider
    this.context = input.context
    this.configurationHash = input.configurationHash
    this.tableIds = input.tableIds
    this.closedAt = input.closedAt
    this.clock = input.clock
  }

  /**
   * Restores the exact current pointer before the first authority operation.
   */
  async initialize(): Promise<void> {
    if (this.pointer !== undefined) {
      return failExecutionSupervisor('INVALID_STATE')
    }
    this.pointer = await runGuardedOperation(
      this.context,
      () => this.session.readMaintenanceEvidencePointer(
        this.context.lease,
      ),
    )
  }

  /**
   * Resolves current authority or renews post-close evidence near expiry.
   *
   * @returns Exact fresh authority with minimum commit headroom.
   */
  async resolve(): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    const current = this.authority
    if (current !== undefined) {
      let refreshed: WorkspaceSearchMigrationPrePlanAuthority
      try {
        refreshed = await runGuardedOperation(
          this.context,
          () => this.session.readAuthority(
            createAuthorityClaim(current),
          ),
        )
      } catch (error: unknown) {
        return this.renewAfterExpiredAuthorityFailure(
          error,
          {
            fenceToken: current.lease.fenceToken,
            revision:
              current.maintenanceEvidencePointerRevision,
            receiptDigest:
              current.maintenanceEvidenceReceiptDigest,
          },
        )
      }
      this.requireAuthorityBinding(refreshed)
      this.authority = refreshed
      if (hasAuthorityCommitHeadroom(refreshed, this.clock)) {
        return refreshed
      }
    }
    const pointer = this.pointer
    if (current === undefined && pointer !== undefined && pointer !== null) {
      let restored: WorkspaceSearchMigrationPrePlanAuthority
      try {
        restored = await runGuardedOperation(
          this.context,
          () => this.session.readAuthority({
            lease: this.context.lease,
            maintenanceEvidenceReceiptDigest: pointer.receiptDigest,
            maintenanceEvidencePointerRevision: pointer.revision,
          }),
        )
      } catch (error: unknown) {
        return this.renewAfterExpiredAuthorityFailure(
          error,
          pointer,
        )
      }
      this.requireAuthorityBinding(restored)
      this.authority = restored
      if (hasAuthorityCommitHeadroom(restored, this.clock)) {
        return restored
      }
    }
    return this.renew()
  }

  /**
   * Renews only when a selected immutable receipt still exists and expired.
   *
   * Missing or still-fresh receipt failures remain fail-closed because they
   * indicate authority corruption rather than an ordinary restart boundary.
   *
   * @param error - Failure raised while resolving the selected pointer.
   * @param pointer - Exact durable pointer selected by the failed read.
   * @returns Fresh renewed authority after proving ordinary expiry.
   */
  private async renewAfterExpiredAuthorityFailure(
    error: unknown,
    pointer: WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    this.context.assertActive()
    if (
      !(error instanceof WorkspaceSearchMigrationFailure) ||
      error.code !== 'INVALID_MAINTENANCE_EVIDENCE'
    ) {
      throw error
    }
    const receipt = await runGuardedOperation(
      this.context,
      () => this.session.readMaintenanceEvidenceReceipt(
        this.context.lease.runId,
        pointer.receiptDigest,
      ),
    )
    if (
      receipt === undefined ||
      receipt.runId !== this.context.lease.runId ||
      receipt.fenceToken !== pointer.fenceToken ||
      createMigrationDigest(receipt) !== pointer.receiptDigest ||
      Date.parse(receipt.validUntil) -
          readExecutionClock(this.clock).getTime() >
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
    ) {
      throw error
    }
    return this.renew()
  }

  /**
   * Collects and durably selects one fresh post-close evidence receipt.
   *
   * @returns Exact renewed pre-plan authority.
   */
  private async renew():
    Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    let collected: Awaited<
      ReturnType<
        WorkspaceSearchMigrationMaintenanceEvidenceProvider['collect']
      >
    >
    try {
      collected = await runGuardedOperation(
        this.context,
        () => this.provider.collect({
          phase: 'post-close',
          runId: this.context.lease.runId,
          configurationHash: this.configurationHash,
          tableIds: structuredClone(this.tableIds),
          closedAt: this.closedAt,
          signal: this.context.signal,
        }),
      )
    } catch {
      this.context.assertActive()
      return failExecutionSupervisor(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
      )
    }
    let evidenceBytes: Uint8Array
    try {
      if (
        collected.configurationHash !== this.configurationHash ||
        !sameTableIds(collected.tableIds, this.tableIds) ||
        !(collected.evidenceBytes instanceof Uint8Array)
      ) {
        return failExecutionSupervisor(
          'INVALID_MAINTENANCE_EVIDENCE',
        )
      }
      evidenceBytes = Uint8Array.from(collected.evidenceBytes)
    } catch {
      return failExecutionSupervisor(
        'INVALID_MAINTENANCE_EVIDENCE',
      )
    }
    let drainStartedAt: string
    try {
      drainStartedAt = parseMaintenanceEvidence(evidenceBytes, {
        now: readExecutionClock(this.clock),
      }).evidence.drainStartedAt
    } catch {
      return failExecutionSupervisor(
        'INVALID_MAINTENANCE_EVIDENCE',
      )
    }
    if (Date.parse(drainStartedAt) < Date.parse(this.closedAt)) {
      return failExecutionSupervisor(
        'INVALID_MAINTENANCE_EVIDENCE',
      )
    }
    const authority = await runGuardedOperation(
      this.context,
      () => this.session.renewMaintenanceEvidence({
        lease: this.context.lease,
        expectedPointer: this.pointer ?? null,
        evidenceBytes,
      }),
    )
    this.requireAuthorityBinding(authority)
    this.pointer = {
      fenceToken: authority.lease.fenceToken,
      revision: authority.maintenanceEvidencePointerRevision,
      receiptDigest: authority.maintenanceEvidenceReceiptDigest,
    }
    this.authority = authority
    return authority
  }

  /**
   * Requires one returned authority to remain inside this lease generation.
   *
   * @param authority - Candidate resolved or renewed current authority.
   */
  private requireAuthorityBinding(
    authority: WorkspaceSearchMigrationPrePlanAuthority,
  ): void {
    if (
      authority.configurationHash !== this.configurationHash ||
      authority.stateTableId !== this.tableIds['migration-state'] ||
      authority.lease.runId !== this.context.lease.runId ||
      authority.lease.ownerId !== this.context.lease.ownerId ||
      authority.lease.fenceToken !== this.context.lease.fenceToken
    ) {
      return failExecutionSupervisor('LEASE_LOST')
    }
  }
}

/**
 * Runs the explicit branch until its durable phase boundary or terminal root.
 *
 * @param session - Measured managed execution session.
 * @param loaded - Static execution roots and exact plan.
 * @param authority - Heartbeat-scoped current-authority controller.
 * @param guard - Heartbeat operation guard.
 * @param mode - Explicit operator branch.
 * @returns Secret-free durable phase reached by the branch.
 */
async function runExecutionMode(
  session: WorkspaceSearchMigrationExecutionSupervisorSession,
  loaded: LoadedExecutionContext,
  authority: ExecutionAuthorityController,
  guard: WorkspaceSearchMigrationHeartbeatTaskContext,
  mode: WorkspaceSearchMigrationExecutionSupervisorMode,
): Promise<WorkspaceSearchMigrationExecutionStatus> {
  let executionRun = loaded.executionRun
  if (executionRun === undefined) {
    if (mode !== 'apply') {
      return failExecutionSupervisor('INVALID_STATE')
    }
    const currentAuthority = await authority.resolve()
    const port = session.createExecutionRunPort(
      loaded.boundary,
      loaded.sealedPlanningAuthority,
      loaded.replay.planSeal,
      loaded.closedWriterFenceRecord,
    )
    executionRun = await runGuardedOperation(
      guard,
      () => port.create(currentAuthority),
    )
  }
  const ports = createExecutionPhasePorts(
    session,
    loaded,
    executionRun,
  )
  while (true) {
    const snapshot = await readDurableExecutionSnapshot(
      ports,
      guard,
    )
    const completed = requireExecutionModeSnapshot(
      snapshot,
      mode,
    )
    if (completed !== undefined) return completed
    if (mode === 'apply') {
      if (snapshot.kind !== 'applying') {
        return failExecutionSupervisor('INVALID_STATE')
      }
      await advanceApply(
        loaded,
        ports.apply,
        snapshot.runState,
        authority,
        guard,
      )
      continue
    }
    if (mode === 'verify') {
      if (snapshot.kind !== 'applied' && snapshot.kind !== 'verifying') {
        return failExecutionSupervisor('INVALID_STATE')
      }
      await advanceVerification(
        ports.verification,
        snapshot.kind === 'verifying'
          ? snapshot.progress
          : undefined,
        authority,
        guard,
      )
      continue
    }
    if (mode === 'partial-rollback') {
      if (
        snapshot.kind !== 'applying' &&
        snapshot.kind !== 'partial-rollback'
      ) {
        return failExecutionSupervisor('INVALID_STATE')
      }
      await advanceRollback(
        ports,
        snapshot,
        authority,
        guard,
      )
      continue
    }
    if (
      snapshot.kind !== 'applied' &&
      snapshot.kind !== 'complete-rollback'
    ) {
      return failExecutionSupervisor('INVALID_STATE')
    }
    await advanceRollback(
      ports,
      snapshot,
      authority,
      guard,
    )
  }
}

/**
 * Requires an explicit branch to match the current durable phase.
 *
 * @param snapshot - Current coherent phase projection.
 * @param mode - Operator-selected exact branch.
 * @returns Completed boundary status, or undefined when work may advance.
 */
function requireExecutionModeSnapshot(
  snapshot: DurableExecutionSnapshot,
  mode: WorkspaceSearchMigrationExecutionSupervisorMode,
): WorkspaceSearchMigrationExecutionStatus | undefined {
  if (mode === 'apply') {
    if (snapshot.kind === 'applying') return undefined
    if (snapshot.kind === 'applied') return snapshot.status
    return failExecutionSupervisor('INVALID_STATE')
  }
  if (mode === 'verify') {
    if (
      snapshot.kind === 'applied' ||
      snapshot.kind === 'verifying'
    ) {
      return undefined
    }
    if (snapshot.kind === 'verified') return snapshot.status
    return failExecutionSupervisor('INVALID_STATE')
  }
  if (mode === 'partial-rollback') {
    if (
      snapshot.kind === 'applying' ||
      snapshot.kind === 'partial-rollback'
    ) {
      return undefined
    }
    if (
      snapshot.kind === 'rolled-back' &&
      snapshot.scope === 'committed-prefix'
    ) {
      return snapshot.status
    }
    return failExecutionSupervisor('INVALID_STATE')
  }
  if (
    snapshot.kind === 'applied' ||
    snapshot.kind === 'complete-rollback'
  ) {
    return undefined
  }
  if (
    snapshot.kind === 'rolled-back' &&
    snapshot.scope === 'complete-plan'
  ) {
    return snapshot.status
  }
  return failExecutionSupervisor('INVALID_STATE')
}

/**
 * Performs exactly one restart-safe forward apply mutation.
 *
 * @param loaded - Static execution roots and exact replayed plan.
 * @param port - Apply persistence capability.
 * @param state - Current authoritative applying run state.
 * @param authority - Current-authority controller.
 * @param guard - Heartbeat activity guard.
 */
async function advanceApply(
  loaded: LoadedExecutionContext,
  port: WorkspaceSearchMigrationApplyOperationAwsPort,
  state: Awaited<
    ReturnType<WorkspaceSearchMigrationApplyOperationAwsPort['readRunState']>
  >,
  authority: ExecutionAuthorityController,
  guard: ExecutionOperationGuard,
): Promise<void> {
  const currentAuthority = await authority.resolve()
  const adopted = await runGuardedOperation(
    guard,
    () => port.adoptExecutionAuthority({
      expectedRevision: state.revision,
      authority: createAuthorityClaim(currentAuthority),
    }),
  )
  if (adopted.status !== 'applying') {
    if (adopted.status === 'applied') return
    return failExecutionSupervisor('INVALID_STATE')
  }
  if (adopted.revision !== state.revision) {
    return
  }
  if (adopted.appliedOperationCount < adopted.planOperationCount) {
    const plannedOperation =
      loaded.replay.operations[adopted.appliedOperationCount]
    if (
      plannedOperation === undefined ||
      plannedOperation.planSequence !==
        adopted.appliedOperationCount + 1
    ) {
      return failExecutionSupervisor('INVALID_STATE')
    }
    await runGuardedOperation(
      guard,
      () => port.commitApplyOperation({
        expectedRevision: adopted.revision,
        lease: createAuthorityClaim(currentAuthority).lease,
        event: {
          kind: 'apply-operation-requested',
          plannedOperation,
        },
      }),
    )
    return
  }
  const location = nextApplyCheckpointLocation(adopted)
  if (location !== undefined) {
    await runGuardedOperation(
      guard,
      () => port.saveApplyCheckpoint({
        expectedRevision: adopted.revision,
        lease: createAuthorityClaim(currentAuthority).lease,
        location,
      }),
    )
    return
  }
  await runGuardedOperation(
    guard,
    () => port.sealApply({
      expectedRevision: adopted.revision,
      lease: createAuthorityClaim(currentAuthority).lease,
    }),
  )
}

/**
 * Performs exactly one restart-safe full-verification mutation.
 *
 * @param port - Full verification persistence capability.
 * @param progress - Current progress, absent before the first page.
 * @param authority - Current-authority controller.
 * @param guard - Heartbeat activity guard.
 */
async function advanceVerification(
  port: WorkspaceSearchMigrationFullVerificationAwsPort,
  progress: Awaited<
    ReturnType<
      WorkspaceSearchMigrationFullVerificationAwsPort['readProgress']
    >
  >,
  authority: ExecutionAuthorityController,
  guard: ExecutionOperationGuard,
): Promise<void> {
  const currentAuthority = await authority.resolve()
  const claim = createAuthorityClaim(currentAuthority)
  const location = nextVerificationLocation(progress)
  if (location !== undefined) {
    await runGuardedOperation(
      guard,
      () => port.saveVerificationPage({
        expectedRevision: progress?.revision ?? 0,
        authority: claim,
        location,
      }),
    )
    return
  }
  if (progress === undefined) {
    return failExecutionSupervisor('INVALID_STATE')
  }
  await runGuardedOperation(
    guard,
    () => port.publishVerified({
      expectedRevision: progress.revision,
      authority: claim,
    }),
  )
}

/**
 * Performs exactly one restart-safe partial or complete rollback mutation.
 *
 * @param ports - Admission-bound phase ports.
 * @param snapshot - Current authoritative durable graph.
 * @param authority - Current-authority controller.
 * @param guard - Heartbeat activity guard.
 */
async function advanceRollback(
  ports: ExecutionPhasePorts,
  snapshot: DurableExecutionSnapshot,
  authority: ExecutionAuthorityController,
  guard: ExecutionOperationGuard,
): Promise<void> {
  const claim = createAuthorityClaim(await authority.resolve())
  if (snapshot.kind === 'applying') {
    await runGuardedOperation(
      guard,
      () => ports.partialRollback.beginRollback({
        expectedRevision: snapshot.runState.revision,
        authority: claim,
      }),
    )
    return
  }
  if (snapshot.kind === 'partial-rollback') {
    const state = snapshot.lifecycle.state
    if (state.status === 'rolled-back') {
      return failExecutionSupervisor('INVALID_STATE')
    }
    if (state.nextSequence > 0) {
      await runGuardedOperation(
        guard,
        () => ports.partialRollback.commitRollbackOperation({
          expectedRevision: state.revision,
          authority: claim,
        }),
      )
      return
    }
    await runGuardedOperation(
      guard,
      () => ports.partialRollback.finishRollback({
        expectedRevision: state.revision,
        authority: claim,
      }),
    )
    return
  }
  if (snapshot.kind === 'applied') {
    await runGuardedOperation(
      guard,
      () => ports.completeRollback.beginRollback({
        expectedRevision: snapshot.runState.revision,
        authority: claim,
      }),
    )
    return
  }
  if (snapshot.kind === 'complete-rollback') {
    const state = snapshot.rollbackState
    if (state.status === 'rolled-back') {
      return failExecutionSupervisor('INVALID_STATE')
    }
    if (state.nextSequence > 0) {
      await runGuardedOperation(
        guard,
        () => ports.completeRollback.commitRollbackOperation({
          expectedRevision: state.revision,
          authority: claim,
        }),
      )
      return
    }
    await runGuardedOperation(
      guard,
      () => ports.completeRollback.finishRollback({
        expectedRevision: state.revision,
        authority: claim,
      }),
    )
    return
  }
  return failExecutionSupervisor('INVALID_STATE')
}

/**
 * Loads and cross-validates immutable execution prerequisites.
 *
 * @param session - Read-only managed measured session.
 * @param runId - Exact operator-selected run.
 * @param expectedConfigurationHash - Reviewed configuration digest.
 * @param guard - Read activity guard.
 * @returns Static execution roots, exact plan, and optional admission.
 */
async function loadExecutionContext(
  session: WorkspaceSearchMigrationExecutionStatusSession,
  runId: string,
  expectedConfigurationHash: string,
  guard: ExecutionOperationGuard,
): Promise<LoadedExecutionContext> {
  const configuration = await runGuardedOperation(
    guard,
    () => session.measureConfiguration(),
  )
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  if (configurationHash !== expectedConfigurationHash) {
    return failExecutionSupervisor(
      'CONFIGURATION_HASH_MISMATCH',
    )
  }
  const boundaryPort = session.createExecutionBoundaryPort()
  const sealedPort = session.createSealedPlanningAuthorityPort()
  const fencePort = session.createApplicationWriterFencePort()
  const [boundaryValue, sealedPlanningAuthority, fence] =
    await Promise.all([
      runGuardedOperation(
        guard,
        () => boundaryPort.read(runId),
      ),
      runGuardedOperation(
        guard,
        () => sealedPort.read(runId),
      ),
      runGuardedOperation(
        guard,
        () => fencePort.read(),
      ),
    ])
  if (
    boundaryValue?.phase !== 'planning-admitted' ||
    sealedPlanningAuthority === undefined ||
    fence.status !== 'present' ||
    fence.record.mode !== 'closed' ||
    boundaryValue.runId !== runId ||
    sealedPlanningAuthority.runId !== runId ||
    boundaryValue.configurationHash !== configurationHash ||
    sealedPlanningAuthority.configurationHash !== configurationHash ||
    boundaryValue.closedWriterFenceRecordDigest !==
      fence.record.recordDigest
  ) {
    return failExecutionSupervisor('INVALID_STATE')
  }
  const planning = session.createPlanningArtifactGateway(runId)
  const replay = await runGuardedOperation(
    guard,
    () => planning.replayPlanArtifact({
      planSealReference:
        sealedPlanningAuthority.planSealReference,
      manifestHeadReference:
        sealedPlanningAuthority.planManifestHeadReference,
    }),
  )
  if (
    replay.operations.length !==
      sealedPlanningAuthority.planOperationCount ||
    replay.planSeal.planDigest !==
      sealedPlanningAuthority.planDigest
  ) {
    return failExecutionSupervisor('INVALID_STATE')
  }
  const executionRunPort = session.createExecutionRunPort(
    boundaryValue,
    sealedPlanningAuthority,
    replay.planSeal,
    fence.record,
  )
  const executionRun = await runGuardedOperation(
    guard,
    () => executionRunPort.read(runId),
  )
  return {
    configuration,
    configurationHash,
    boundary: boundaryValue,
    sealedPlanningAuthority,
    closedWriterFenceRecord: fence.record,
    replay,
    executionRun,
  }
}

/**
 * Creates every phase port from one immutable execution admission.
 *
 * @param session - Managed measured session.
 * @param loaded - Static execution roots.
 * @param executionRun - Exact immutable execution admission.
 * @returns Admission-bound forward, verify, and rollback ports.
 */
function createExecutionPhasePorts(
  session: WorkspaceSearchMigrationExecutionStatusSession,
  loaded: LoadedExecutionContext,
  executionRun: WorkspaceSearchMigrationExecutionRun,
): ExecutionPhasePorts {
  return {
    apply: session.createApplyOperationPort(
      loaded.boundary,
      loaded.sealedPlanningAuthority,
      loaded.closedWriterFenceRecord,
      executionRun,
    ),
    verification: session.createFullVerificationPort(
      loaded.boundary,
      loaded.sealedPlanningAuthority,
      loaded.closedWriterFenceRecord,
      executionRun,
    ),
    partialRollback: session.createPartialRollbackOperationPort(
      loaded.boundary,
      loaded.sealedPlanningAuthority,
      loaded.closedWriterFenceRecord,
      executionRun,
    ),
    completeRollback: session.createRollbackOperationPort(
      loaded.boundary,
      loaded.sealedPlanningAuthority,
      loaded.closedWriterFenceRecord,
      executionRun,
    ),
  }
}

/**
 * Folds every durable phase graph into one authoritative snapshot.
 *
 * @param ports - Admission-bound phase ports.
 * @param guard - Read activity guard.
 * @returns Private durable snapshot and secret-free public status.
 */
async function readDurableExecutionSnapshot(
  ports: ExecutionPhasePorts,
  guard: ExecutionOperationGuard,
): Promise<DurableExecutionSnapshot> {
  const runState = await runGuardedOperation(
    guard,
    () => ports.apply.readRunState(),
  )
  if (runState.status === 'applying') {
    const lifecycle = await runGuardedOperation(
      guard,
      () => ports.partialRollback.readRollbackLifecycle(),
    )
    if (lifecycle === undefined) {
      return {
        kind: 'applying',
        runState,
        status: applyingStatus(),
      }
    }
    if (lifecycle.state.status === 'rolled-back') {
      if (lifecycle.rolledBackRoot === undefined) {
        return failExecutionSupervisor('INVALID_STATE')
      }
      return {
        kind: 'rolled-back',
        scope: 'committed-prefix',
        status: rolledBackStatus(),
      }
    }
    if (lifecycle.rolledBackRoot !== undefined) {
      return failExecutionSupervisor('INVALID_STATE')
    }
    return {
      kind: 'partial-rollback',
      lifecycle,
      status: rollingBackStatus('committed-prefix'),
    }
  }
  if (runState.status !== 'applied') {
    return failExecutionSupervisor('INVALID_STATE')
  }
  const [
    verificationProgress,
    verifiedRoot,
    rollbackState,
  ] = await Promise.all([
    runGuardedOperation(
      guard,
      () => ports.verification.readProgress(),
    ),
    runGuardedOperation(
      guard,
      () => ports.verification.readVerifiedRoot(),
    ),
    runGuardedOperation(
      guard,
      () => ports.completeRollback.readRollbackState(),
    ),
  ])
  const hasVerification =
    verificationProgress !== undefined ||
    verifiedRoot !== undefined
  const hasRollback =
    rollbackState !== undefined
  if (hasVerification && hasRollback) {
    return failExecutionSupervisor('INVALID_STATE')
  }
  if (verifiedRoot !== undefined) {
    return {
      kind: 'verified',
      status: verifiedStatus(),
    }
  }
  if (verificationProgress !== undefined) {
    return {
      kind: 'verifying',
      runState,
      progress: verificationProgress,
      status: verifyingStatus(),
    }
  }
  if (rollbackState?.status === 'rolled-back') {
    return {
      kind: 'rolled-back',
      scope: 'complete-plan',
      status: rolledBackStatus(),
    }
  }
  if (rollbackState !== undefined) {
    return {
      kind: 'complete-rollback',
      rollbackState,
      status: rollingBackStatus('complete-plan'),
    }
  }
  return {
    kind: 'applied',
    runState,
    status: appliedStatus(),
  }
}

/**
 * Selects the first incomplete clean apply checkpoint in canonical order.
 *
 * @param state - Current authoritative applying run state.
 * @returns First incomplete location, or undefined when all are complete.
 */
function nextApplyCheckpointLocation(
  state: Awaited<
    ReturnType<WorkspaceSearchMigrationApplyOperationAwsPort['readRunState']>
  >,
): WorkspaceSearchMigrationCheckpointLocation | undefined {
  for (const location of checkpointLocations) {
    const checkpoint = readApplyCheckpoint(state.apply, location)
    if (checkpoint.aggregate.invalid !== 0) {
      return failExecutionSupervisor('INVALID_STATE')
    }
    if (!checkpoint.completed) return location
    if (checkpoint.cursor !== undefined) {
      return failExecutionSupervisor('INVALID_STATE')
    }
  }
  return undefined
}

/**
 * Selects the first incomplete clean verification checkpoint.
 *
 * @param progress - Current durable progress, absent before the first page.
 * @returns First incomplete location, or undefined when terminal.
 */
function nextVerificationLocation(
  progress: Awaited<
    ReturnType<
      WorkspaceSearchMigrationFullVerificationAwsPort['readProgress']
    >
  >,
): WorkspaceSearchMigrationCheckpointLocation | undefined {
  if (progress === undefined) return checkpointLocations[0]
  for (const location of checkpointLocations) {
    const checkpoint = location === 'target'
      ? progress.progress.traversal.target
      : progress.progress.traversal.sources[location]
    if (checkpoint.aggregate.invalid !== 0) {
      return failExecutionSupervisor('VERIFY_FAILED')
    }
    if (!checkpoint.completed) return location
    if (checkpoint.cursor !== undefined) {
      return failExecutionSupervisor('INVALID_STATE')
    }
  }
  return undefined
}

/**
 * Reads one source or target checkpoint from apply traversal.
 *
 * @param apply - Complete apply traversal.
 * @param location - Source or target location.
 * @returns Exact selected cumulative checkpoint.
 */
function readApplyCheckpoint(
  apply: Awaited<
    ReturnType<WorkspaceSearchMigrationApplyOperationAwsPort['readRunState']>
  >['apply'],
  location: WorkspaceSearchMigrationCheckpointLocation,
): MigrationSourceCheckpoint {
  return location === 'target'
    ? apply.target
    : apply.sources[location]
}

/**
 * Projects one rich authority into the exact caller claim.
 *
 * @param authority - Fresh current pre-plan authority.
 * @returns Exact lease, pointer, and receipt claim.
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
 * Checks whether current evidence retains the fixed commit headroom.
 *
 * @param authority - Current resolved authority.
 * @param clock - Trusted supervisor clock.
 * @returns Whether a new mutation may safely begin.
 */
function hasAuthorityCommitHeadroom(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  clock: WorkspaceSearchMigrationHeartbeatClock,
): boolean {
  const threshold = readExecutionClock(clock).getTime() +
    WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  return Date.parse(authority.lease.expiresAt) > threshold &&
    Date.parse(authority.maintenanceEvidenceReceipt.validUntil) >
      threshold
}

/**
 * Compares exact six-table identifiers without exposing them.
 *
 * @param left - First role-indexed table binding.
 * @param right - Second role-indexed table binding.
 * @returns Whether every fixed role selects the same TableId.
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
 * Brackets one external operation with the current activity assertion.
 *
 * @param guard - Signal or heartbeat activity guard.
 * @param operation - One external read, write, or reconciliation operation.
 * @returns Exact completed operation result.
 */
async function runGuardedOperation<Result>(
  guard: ExecutionOperationGuard,
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
 * Detaches read-only status scalars before the first external operation.
 *
 * The managed session remains a live collaborator, while run identity and the
 * reviewed digest are copied so caller mutation cannot redirect later reads.
 *
 * @param input - Caller-owned read-only status request.
 * @returns Stable top-level request snapshot.
 */
function snapshotExecutionStatusInput(
  input: ReadWorkspaceSearchMigrationExecutionStatusInput,
): ReadWorkspaceSearchMigrationExecutionStatusInput {
  let session: WorkspaceSearchMigrationExecutionStatusSession
  let runId: string
  let expectedConfigurationHash: string
  try {
    session = input.session
    runId = input.runId
    expectedConfigurationHash = input.expectedConfigurationHash
  } catch {
    return failExecutionSupervisor('INVALID_ARGUMENT')
  }
  return {
    session,
    runId,
    expectedConfigurationHash,
  }
}

/**
 * Detaches supervisor scalars before the first external operation.
 *
 * Session, provider, scheduler, clock, and signal retain collaborator identity;
 * scalar authority and branch selections are copied once for the whole run.
 *
 * @param input - Caller-owned mutating supervision request.
 * @returns Stable top-level request snapshot.
 */
function snapshotExecutionSupervisorInput(
  input: SuperviseWorkspaceSearchMigrationExecutionInput,
): SuperviseWorkspaceSearchMigrationExecutionInput {
  let session: WorkspaceSearchMigrationExecutionSupervisorSession
  let maintenanceEvidenceProvider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  let runId: string
  let ownerId: string
  let expectedConfigurationHash: string
  let mode: WorkspaceSearchMigrationExecutionSupervisorMode
  let signal: AbortSignal | undefined
  let heartbeatScheduler:
    WorkspaceSearchMigrationHeartbeatScheduler | undefined
  let clock: WorkspaceSearchMigrationHeartbeatClock | undefined
  try {
    session = input.session
    maintenanceEvidenceProvider = input.maintenanceEvidenceProvider
    runId = input.runId
    ownerId = input.ownerId
    expectedConfigurationHash = input.expectedConfigurationHash
    mode = input.mode
    signal = input.signal
    heartbeatScheduler = input.heartbeatScheduler
    clock = input.clock
  } catch {
    return failExecutionSupervisor('INVALID_ARGUMENT')
  }
  return {
    session,
    maintenanceEvidenceProvider,
    runId,
    ownerId,
    expectedConfigurationHash,
    mode,
    ...(signal === undefined ? {} : { signal }),
    ...(heartbeatScheduler === undefined
      ? {}
      : { heartbeatScheduler }),
    ...(clock === undefined ? {} : { clock }),
  }
}

/**
 * Creates one read-only signal activity guard.
 *
 * @param signal - Optional operator interruption signal.
 * @returns Minimal guard that never acquires or mutates a lease.
 */
function createSignalGuard(
  signal?: AbortSignal,
): ExecutionOperationGuard {
  return {
    assertActive: () => {
      if (signal?.aborted === true) {
        throw new WorkspaceSearchMigrationHeartbeatInterruptedError()
      }
    },
  }
}

/**
 * Reads the explicit execution supervisor mode.
 *
 * @param value - Candidate mode.
 * @returns Exact supported mode.
 */
function readSupervisorMode(
  value: unknown,
): WorkspaceSearchMigrationExecutionSupervisorMode {
  if (
    value !== 'apply' &&
    value !== 'verify' &&
    value !== 'partial-rollback' &&
    value !== 'complete-rollback'
  ) {
    return failExecutionSupervisor('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires one reviewed configuration digest.
 *
 * @param value - Candidate lowercase digest.
 */
function requireExpectedConfigurationHash(value: unknown): void {
  if (!isHexDigest(value)) {
    return failExecutionSupervisor('INVALID_ARGUMENT')
  }
}

/**
 * Reads one safe trusted clock sample.
 *
 * @param clock - Candidate trusted clock.
 * @returns Detached valid Date.
 */
function readExecutionClock(
  clock: WorkspaceSearchMigrationHeartbeatClock,
): Date {
  let value: unknown
  try {
    value = clock()
  } catch {
    return failExecutionSupervisor('INVALID_ARGUMENT')
  }
  if (!(value instanceof Date)) {
    return failExecutionSupervisor('INVALID_ARGUMENT')
  }
  const milliseconds = value.getTime()
  if (!Number.isFinite(milliseconds)) {
    return failExecutionSupervisor('INVALID_ARGUMENT')
  }
  return new Date(milliseconds)
}

/**
 * Default trusted wall clock.
 *
 * @returns Current detached Date.
 */
function defaultExecutionClock(): Date {
  return new Date()
}

/**
 * Creates the ready status projection.
 *
 * @returns Secret-free ready status.
 */
function readyStatus(): WorkspaceSearchMigrationExecutionStatus {
  return { phase: 'ready', nextAction: { kind: 'apply' } }
}

/**
 * Creates the applying branch-decision status projection.
 *
 * @returns Secret-free applying status.
 */
function applyingStatus(): WorkspaceSearchMigrationExecutionStatus {
  return {
    phase: 'applying',
    nextAction: {
      kind: 'choose',
      options: ['apply', 'partial-rollback'],
    },
  }
}

/**
 * Creates the applied branch-decision status projection.
 *
 * @returns Secret-free applied status.
 */
function appliedStatus(): WorkspaceSearchMigrationExecutionStatus {
  return {
    phase: 'applied',
    nextAction: {
      kind: 'choose',
      options: ['verify', 'complete-rollback'],
    },
  }
}

/**
 * Creates the verifying status projection.
 *
 * @returns Secret-free verifying status.
 */
function verifyingStatus(): WorkspaceSearchMigrationExecutionStatus {
  return { phase: 'verifying', nextAction: { kind: 'verify' } }
}

/**
 * Creates the immutable verified status projection.
 *
 * @returns Secret-free terminal verified status.
 */
function verifiedStatus(): WorkspaceSearchMigrationExecutionStatus {
  return { phase: 'verified', nextAction: { kind: 'none' } }
}

/**
 * Creates one rolling-back status projection.
 *
 * @param scope - Durable committed-prefix or complete-plan scope.
 * @returns Secret-free rolling-back status.
 */
function rollingBackStatus(
  scope: 'committed-prefix' | 'complete-plan',
): WorkspaceSearchMigrationExecutionStatus {
  return {
    phase: 'rolling-back',
    nextAction: { kind: 'rollback', scope },
  }
}

/**
 * Creates the immutable rolled-back status projection.
 *
 * @returns Secret-free terminal rolled-back status.
 */
function rolledBackStatus(): WorkspaceSearchMigrationExecutionStatus {
  return { phase: 'rolled-back', nextAction: { kind: 'none' } }
}

/**
 * Throws one stable raw-value-free public execution-supervisor failure.
 *
 * @param code - Stable public migration failure code.
 */
function failExecutionSupervisor(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new WorkspaceSearchMigrationFailure(code, code)
}
