import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isHexDigest,
  MINIMUM_MAINTENANCE_DRAIN_SECONDS,
  requireMigrationIdentifier,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  workspaceSearchMigrationSourceNames,
} from './migration-contract'
import {
  parseWorkspaceSearchDryRunEvidence,
} from './migration-artifacts'
import {
  type WorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import type {
  WorkspaceSearchMigrationExecutionBoundaryAwsPort,
} from './migration-execution-boundary-aws'
import {
  runWithWorkspaceSearchMigrationHeartbeat,
  type WorkspaceSearchMigrationHeartbeatClock,
  type WorkspaceSearchMigrationHeartbeatScheduler,
  type WorkspaceSearchMigrationHeartbeatTaskContext,
  WorkspaceSearchMigrationHeartbeatInterruptedError,
} from './migration-heartbeat-supervisor'
import {
  type WorkspaceSearchMigrationManagedAwsSession,
  type WorkspaceSearchMigrationPreparedCommittedPlanningEvidence,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_CANONICAL_BYTES,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_EVIDENCE_PAGES,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_OPERATIONS,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_TOTAL_ROWS,
} from './migration-identity-aws'
import type {
  WorkspaceSearchMigrationPlanningArtifactAwsGateway,
} from './migration-planning-artifact-aws'
import type {
  WorkspaceSearchMigrationPlanningJoinLimits,
} from './migration-planning-material'
import {
  sealWorkspaceSearchMigrationPlan,
} from './migration-planner'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationPlanningProvenanceArtifact,
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort,
} from './migration-sealed-planning-authority-aws'
import type {
  WorkspaceSearchMigrationPlanningSourceEvidenceAwsRequest,
} from './migration-source-evidence-aws'
import type {
  WorkspaceSearchMigrationSourceEvidenceProgress,
} from './migration-source-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'
import type {
  WorkspaceSearchMigrationTargetEvidenceProgress,
} from './migration-target-evidence'
import type {
  WorkspaceSearchMigrationTargetEvidenceAwsRequest,
} from './migration-target-evidence-aws'
import {
  parseMaintenanceEvidence,
} from './maintenance-evidence'

/** Mandatory post-close drain reserved before the irreversible close. */
const postCloseMinimumDrainMilliseconds =
  MINIMUM_MAINTENANCE_DRAIN_SECONDS * 1_000

/**
 * Managed session surface required by the post-close planning supervisor.
 */
export type WorkspaceSearchMigrationPostClosePlanningSession = Pick<
  WorkspaceSearchMigrationManagedAwsSession,
  | 'acquireLease'
  | 'commitNextSourceEvidencePage'
  | 'commitNextTargetEvidencePage'
  | 'createExecutionBoundaryPort'
  | 'createPlanningArtifactGateway'
  | 'createSealedPlanningAuthorityPort'
  | 'heartbeatLease'
  | 'measureConfiguration'
  | 'prepareCommittedPlanningEvidence'
  | 'readAuthority'
  | 'readMaintenanceEvidencePointer'
  | 'readSourceEvidenceProgress'
  | 'readTargetEvidenceProgress'
  | 'renewMaintenanceEvidence'
  | 'validatePlanningArtifactPreflight'
>

/**
 * Fields shared by every maintenance-evidence collection request.
 */
type WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequestBase = {
  /** Operator-selected run that owns the evidence receipt. */
  readonly runId: string
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Exact six measured TableIds that the collector must observe. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Signal aborted after lease supervision or operator interruption fails. */
  readonly signal: AbortSignal
}

/**
 * Request for evidence used to obtain authority before writer-fence close.
 */
export type WorkspaceSearchMigrationCloseEvidenceCollectionRequest =
  WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequestBase & {
    /** Collection phase before the writer fence has been closed. */
    readonly phase: 'close'
  }

/**
 * Request for evidence whose zero-mutation interval starts after close.
 */
export type WorkspaceSearchMigrationPostCloseEvidenceCollectionRequest =
  WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequestBase & {
    /** Collection phase after the writer fence has been closed. */
    readonly phase: 'post-close'
    /** Canonical writer-fence close time bounding the new drain interval. */
    readonly closedAt: string
  }

/**
 * Exact request accepted by the trusted maintenance-evidence collector.
 */
export type WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest =
  | WorkspaceSearchMigrationCloseEvidenceCollectionRequest
  | WorkspaceSearchMigrationPostCloseEvidenceCollectionRequest

/**
 * Trusted collection result bound to the exact measured table incarnations.
 */
export type WorkspaceSearchMigrationCollectedMaintenanceEvidence = {
  /** Reviewed measured-configuration digest observed by the collector. */
  readonly configurationHash: string
  /** All six immutable physical TableIds observed by the collector. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Exact canonical maintenance-evidence bytes produced by the collector. */
  readonly evidenceBytes: Uint8Array
}

/**
 * Trusted boundary that obtains fresh zero-writer maintenance evidence.
 */
export interface WorkspaceSearchMigrationMaintenanceEvidenceProvider {
  /**
   * Collects fresh evidence for the exact requested phase and TableIds.
   *
   * A post-close implementation must remain cancelable while waiting for the
   * complete fifteen-minute drain.
   *
   * @param request - Exact phase, measured identity, and cancellation signal.
   * @returns Evidence bytes and their independently observed TableId binding.
   */
  collect(
    request: WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest,
  ): Promise<WorkspaceSearchMigrationCollectedMaintenanceEvidence>
}

/**
 * Complete input for one restart-safe close and replanning supervision run.
 */
export type SuperviseWorkspaceSearchMigrationPostClosePlanningInput = {
  /** Fresh managed AWS session owned by the invoking coordinator. */
  readonly session: WorkspaceSearchMigrationPostClosePlanningSession
  /** Trusted collector for close and post-close zero-writer evidence. */
  readonly maintenanceEvidenceProvider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  /** Operator-selected migration run shared by every durable artifact. */
  readonly runId: string
  /** Process-unique lease owner used for acquisition and takeover. */
  readonly ownerId: string
  /** Exact reviewed digest expected from the fresh configuration measurement. */
  readonly expectedConfigurationHash: string
  /** Exact canonical operator-reviewed dry-run evidence bytes. */
  readonly reviewedDryRunEvidenceBytes: Uint8Array
  /** Explicit bounded-process limits for joining all five evidence chains. */
  readonly planningJoinLimits: WorkspaceSearchMigrationPlanningJoinLimits
  /** Shared canonical COMPLIANCE retention deadline for planning artifacts. */
  readonly retainUntil: string
  /** Optional operator-interruption signal. */
  readonly signal?: AbortSignal
  /** Optional deterministic scheduler used by supervisor tests. */
  readonly heartbeatScheduler?:
    WorkspaceSearchMigrationHeartbeatScheduler
  /** Optional trusted clock shared by evidence checks and heartbeat scheduling. */
  readonly clock?: WorkspaceSearchMigrationHeartbeatClock
}

/**
 * Durable terminal result of one post-close replanning supervision run.
 */
export type WorkspaceSearchMigrationPostClosePlanningResult = {
  /** Exact durable revision-two planning admission. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning-authority version-two root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact canonical plan seal referenced by the sealed root. */
  readonly planSeal: WorkspaceSearchPlanSeal
}

/**
 * Strongly read boundary and root pair for one deterministic run.
 */
type DurablePlanningState = {
  /** Current durable execution boundary, when one has been published. */
  readonly boundary: WorkspaceSearchMigrationExecutionBoundary | undefined
  /** Current durable sealed planning root, when publication completed. */
  readonly root: WorkspaceSearchMigrationSealedPlanningAuthorityV2 | undefined
}

/**
 * Minimal operation guard shared by heartbeat-supervised and read-only paths.
 */
type PlanningOperationGuard = {
  /** Fails when another external operation may no longer begin. */
  readonly assertActive: () => void
}

/**
 * Fresh authority and exact evidence bytes used for one admission.
 */
type RenewedPostCloseAuthority = {
  /** Exact fresh lease, pointer, and receipt authority. */
  readonly authority: WorkspaceSearchMigrationPrePlanAuthority
  /** Exact post-close evidence bytes committed by the receipt. */
  readonly evidenceBytes: Uint8Array
}

/**
 * Five durable planning heads captured before any new evidence page commit.
 */
type PlanningEvidenceProgressHeads = {
  /** Four source heads indexed by the fixed source roles. */
  readonly sources: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationSourceEvidenceProgress
    >
  >
  /** Exact Workspace Search target evidence head. */
  readonly target: WorkspaceSearchMigrationTargetEvidenceProgress
}

/**
 * Mutable combined durable-page budget shared by all five evidence chains.
 */
type PlanningEvidencePageBudget = {
  /** Current total committed page sequences across the five durable heads. */
  totalPages: number
}

/**
 * Mutable current-authority controller scoped to one heartbeat lease.
 */
class PostClosePlanningAuthorityController {
  /** Managed authority operations bound to the current measurement. */
  private readonly session: WorkspaceSearchMigrationPostClosePlanningSession
  /** Trusted zero-writer evidence collection boundary. */
  private readonly provider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  /** Heartbeat-owned lease identity, signal, and activity assertion. */
  private readonly context: WorkspaceSearchMigrationHeartbeatTaskContext
  /** Reviewed digest of the exact measured configuration. */
  private readonly configurationHash: string
  /** Exact six TableIds derived from the measured configuration. */
  private readonly tableIds:
    WorkspaceSearchMigrationSealedPlanningTableIds
  /** Trusted clock used for evidence and commit-headroom checks. */
  private readonly clock: WorkspaceSearchMigrationHeartbeatClock
  /** Canonical close time required by every post-close refresh. */
  private closedAt: string | undefined
  /** Latest exact authority owned by the stable heartbeat lease. */
  private currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority | undefined
  /** Exact durable pointer predecessor, or null after acquire/takeover. */
  private currentPointer:
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null | undefined

  /**
   * Creates one authority controller for a stable supervised lease.
   *
   * @param input - Session, collector, context, measured binding, and clock.
   */
  constructor(input: {
    /** Managed authority operations. */
    readonly session: WorkspaceSearchMigrationPostClosePlanningSession
    /** Trusted evidence collector. */
    readonly provider:
      WorkspaceSearchMigrationMaintenanceEvidenceProvider
    /** Stable heartbeat task context. */
    readonly context: WorkspaceSearchMigrationHeartbeatTaskContext
    /** Reviewed measured-configuration digest. */
    readonly configurationHash: string
    /** Exact measured TableIds. */
    readonly tableIds:
      WorkspaceSearchMigrationSealedPlanningTableIds
    /** Trusted supervisor clock. */
    readonly clock: WorkspaceSearchMigrationHeartbeatClock
    /** Optional already durable close time. */
    readonly closedAt: string | undefined
  }) {
    this.session = input.session
    this.provider = input.provider
    this.context = input.context
    this.configurationHash = input.configurationHash
    this.tableIds = input.tableIds
    this.clock = input.clock
    this.closedAt = input.closedAt
  }

  /**
   * Fixes the canonical close time for all later evidence refreshes.
   *
   * @param closedAt - Exact durable writer-fence close time.
   */
  bindClosedAt(closedAt: string): void {
    if (
      this.closedAt !== undefined &&
      this.closedAt !== closedAt
    ) {
      return failPlanningSupervisor(
        'INVALID_STATE',
        'The durable writer-fence close time changed.',
      )
    }
    this.closedAt = closedAt
  }

  /**
   * Restores the exact durable predecessor before the first renewal.
   */
  async initialize(): Promise<void> {
    if (this.currentPointer !== undefined) {
      return failPlanningSupervisor(
        'INVALID_STATE',
        'Planning authority controller was initialized more than once.',
      )
    }
    this.currentPointer = await runGuardedOperation(
      this.context,
      () => this.session.readMaintenanceEvidencePointer(
        this.context.lease,
      ),
    )
  }

  /**
   * Creates fresh current authority suitable for the close transaction.
   *
   * @returns Exact authority derived from current close-phase evidence.
   */
  async renewForClose():
    Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    const evidenceBytes = await this.collectEvidence({ phase: 'close' })
    return this.renew(evidenceBytes)
  }

  /**
   * Forces a new post-close receipt and returns its exact evidence bytes.
   *
   * @returns Fresh authority and evidence eligible for planning admission.
   */
  async renewForPostClose(): Promise<RenewedPostCloseAuthority> {
    const closedAt = this.requireClosedAt()
    const evidenceBytes = await this.collectEvidence({
      phase: 'post-close',
      closedAt,
    })
    const authority = await this.renew(evidenceBytes)
    return { authority, evidenceBytes }
  }

  /**
   * Resolves current authority or refreshes post-close evidence near expiry.
   *
   * @returns Exact authority with commit headroom under the stable lease.
   */
  async resolveForPlanning():
    Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    const current = this.currentAuthority
    if (
      current !== undefined &&
      hasAuthorityCommitHeadroom(current, this.clock)
    ) {
      const refreshed = await runGuardedOperation(
        this.context,
        () => this.session.readAuthority({
          lease: this.context.lease,
          maintenanceEvidenceReceiptDigest:
            current.maintenanceEvidenceReceiptDigest,
          maintenanceEvidencePointerRevision:
            current.maintenanceEvidencePointerRevision,
        }),
      )
      this.requireAuthorityBinding(refreshed)
      this.currentAuthority = refreshed
      if (hasAuthorityCommitHeadroom(refreshed, this.clock)) {
        return refreshed
      }
    }
    return (await this.renewForPostClose()).authority
  }

  /**
   * Collects and validates phase-specific evidence without leaking provider data.
   *
   * @param phase - Close or exact post-close collection request.
   * @returns Detached exact canonical evidence bytes.
   */
  private async collectEvidence(
    phase:
      | { readonly phase: 'close' }
      | { readonly phase: 'post-close'; readonly closedAt: string },
  ): Promise<Uint8Array> {
    let collected: WorkspaceSearchMigrationCollectedMaintenanceEvidence
    try {
      collected = await runGuardedOperation(
        this.context,
        () => this.provider.collect(
          phase.phase === 'close'
            ? {
                phase: 'close',
                runId: this.context.lease.runId,
                configurationHash: this.configurationHash,
                tableIds: structuredClone(this.tableIds),
                signal: this.context.signal,
              }
            : {
                phase: 'post-close',
                runId: this.context.lease.runId,
                configurationHash: this.configurationHash,
                tableIds: structuredClone(this.tableIds),
                closedAt: phase.closedAt,
                signal: this.context.signal,
              },
        ),
      )
    } catch {
      this.context.assertActive()
      return failPlanningSupervisor(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
        'Maintenance evidence collection did not complete.',
      )
    }
    let evidenceBytes: Uint8Array
    try {
      if (
        collected.configurationHash !== this.configurationHash ||
        !samePlanningTableIds(collected.tableIds, this.tableIds) ||
        !(collected.evidenceBytes instanceof Uint8Array)
      ) {
        return failPlanningSupervisor(
          'INVALID_MAINTENANCE_EVIDENCE',
          'Maintenance evidence is not bound to the measured configuration.',
        )
      }
      evidenceBytes = Uint8Array.from(collected.evidenceBytes)
    } catch {
      return failPlanningSupervisor(
        'INVALID_MAINTENANCE_EVIDENCE',
        'Maintenance evidence is not bound to the measured configuration.',
      )
    }
    let parsed: ReturnType<typeof parseMaintenanceEvidence>
    try {
      parsed = parseMaintenanceEvidence(evidenceBytes, {
        now: readPlanningClock(this.clock),
      })
    } catch {
      return failPlanningSupervisor(
        'INVALID_MAINTENANCE_EVIDENCE',
        'Maintenance evidence is not current and canonical.',
      )
    }
    if (
      phase.phase === 'post-close' &&
      Date.parse(parsed.evidence.drainStartedAt) <
        Date.parse(phase.closedAt)
    ) {
      return failPlanningSupervisor(
        'INVALID_MAINTENANCE_EVIDENCE',
        'Post-close drain evidence starts before writer-fence close.',
      )
    }
    return evidenceBytes
  }

  /**
   * Persists one receipt and advances the current pointer exactly once.
   *
   * @param evidenceBytes - Exact validated maintenance-evidence bytes.
   * @returns Exact fresh authority selected by the durable pointer.
   */
  private async renew(
    evidenceBytes: Uint8Array,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    const authority = await runGuardedOperation(
      this.context,
      () => this.session.renewMaintenanceEvidence({
        lease: this.context.lease,
        expectedPointer: this.createExpectedPointer(),
        evidenceBytes,
      }),
    )
    this.requireAuthorityBinding(authority)
    this.currentAuthority = authority
    this.currentPointer = {
      fenceToken: authority.lease.fenceToken,
      revision: authority.maintenanceEvidencePointerRevision,
      receiptDigest: authority.maintenanceEvidenceReceiptDigest,
    }
    return authority
  }

  /**
   * Projects the exact same-fence predecessor for one pointer renewal.
   *
   * @returns Current pointer claim, or null after a lease takeover.
   */
  private createExpectedPointer():
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null {
    const current = this.currentPointer
    if (current === undefined) {
      return failPlanningSupervisor(
        'INVALID_STATE',
        'Maintenance pointer was not restored before renewal.',
      )
    }
    return current
  }

  /**
   * Requires one authority to remain bound to the measurement and lease.
   *
   * @param authority - Candidate current authority returned by the session.
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
      return failPlanningSupervisor(
        'LEASE_LOST',
        'Current planning authority changed identity.',
      )
    }
  }

  /**
   * Reads the durable close time required for post-close evidence.
   *
   * @returns Exact canonical writer-fence close time.
   */
  private requireClosedAt(): string {
    if (this.closedAt === undefined) {
      return failPlanningSupervisor(
        'INVALID_STATE',
        'Post-close evidence was requested before writer-fence close.',
      )
    }
    return this.closedAt
  }
}

/**
 * Supervises writer-fence close, drain admission, complete replanning, and seal.
 *
 * Durable revision records, five planning heads, and the sealed root are the
 * only resume checkpoints. Every new external operation is bracketed by the
 * heartbeat activity assertion, while lower-level adapters reconcile an
 * already-started page or transaction before control returns.
 *
 * @param input - Managed session, reviewed artifacts, limits, and evidence source.
 * @returns Exact durable revision-two boundary, root, and referenced plan seal.
 */
export async function superviseWorkspaceSearchMigrationPostClosePlanning(
  input: SuperviseWorkspaceSearchMigrationPostClosePlanningInput,
): Promise<WorkspaceSearchMigrationPostClosePlanningResult> {
  const request = snapshotPostClosePlanningInput(input)
  const runId = requireMigrationIdentifier(request.runId, 'Run ID')
  const ownerId = requireMigrationIdentifier(request.ownerId, 'Owner ID')
  if (!isHexDigest(request.expectedConfigurationHash)) {
    return failPlanningSupervisor(
      'INVALID_ARGUMENT',
      'Expected configuration hash is invalid.',
    )
  }
  const reviewedDryRunEvidenceBytes =
    request.reviewedDryRunEvidenceBytes
  const reviewedDryRunEvidence =
    readReviewedDryRunEvidence(reviewedDryRunEvidenceBytes)
  if (
    reviewedDryRunEvidence.configurationHash !==
      request.expectedConfigurationHash
  ) {
    return failPlanningSupervisor(
      'CONFIGURATION_HASH_MISMATCH',
      'Reviewed dry-run evidence uses a different configuration hash.',
    )
  }
  const dryRunEvidenceDigest = createMigrationDigest(
    reviewedDryRunEvidence,
  )
  const clock = request.clock ?? defaultPlanningClock
  const planningJoinLimits = request.planningJoinLimits
  const initialGuard = createSignalGuard(request.signal)
  const configuration = await runGuardedOperation(
    initialGuard,
    () => request.session.measureConfiguration(),
  )
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  if (configurationHash !== request.expectedConfigurationHash) {
    return failPlanningSupervisor(
      'CONFIGURATION_HASH_MISMATCH',
      'Fresh measurement differs from the reviewed configuration hash.',
    )
  }
  const tableIds = createPlanningTableIds(configuration)
  const boundaryPort = request.session.createExecutionBoundaryPort()
  const rootPort = request.session.createSealedPlanningAuthorityPort()
  const planningGateway =
    request.session.createPlanningArtifactGateway(runId)
  const initialState = await readDurablePlanningState(
    initialGuard,
    boundaryPort,
    rootPort,
    runId,
  )
  const completed = await recoverCompletedPlanning(
    initialGuard,
    planningGateway,
    initialState,
    runId,
    configurationHash,
    tableIds,
    dryRunEvidenceDigest,
  )
  if (completed !== undefined) return completed

  const retainUntil = readPlanningArtifactPreflight(
    request.session,
    request.retainUntil,
    reviewedDryRunEvidence.completedAt,
    initialState.boundary === undefined
      ? postCloseMinimumDrainMilliseconds
      : 0,
  )
  const lease = await runGuardedOperation(
    initialGuard,
    () => request.session.acquireLease({ runId, ownerId }),
  )
  initialGuard.assertActive()
  return runWithWorkspaceSearchMigrationHeartbeat({
    lease,
    port: request.session,
    signal: request.signal,
    scheduler: request.heartbeatScheduler,
    clock,
    task: (context) => runPostClosePlanning({
      session: request.session,
      provider: request.maintenanceEvidenceProvider,
      context,
      configuration,
      configurationHash,
      tableIds,
      boundaryPort,
      rootPort,
      planningGateway,
      reviewedDryRunEvidenceBytes,
      reviewedDryRunCompletedAt:
        reviewedDryRunEvidence.completedAt,
      dryRunEvidenceDigest,
      planningJoinLimits,
      retainUntil,
      clock,
    }),
  })
}

/**
 * Fixed supervised input after measurement and lease acquisition.
 */
type RunPostClosePlanningInput = {
  /** Managed measured session. */
  readonly session: WorkspaceSearchMigrationPostClosePlanningSession
  /** Trusted maintenance-evidence collector. */
  readonly provider: WorkspaceSearchMigrationMaintenanceEvidenceProvider
  /** Stable heartbeat task context. */
  readonly context: WorkspaceSearchMigrationHeartbeatTaskContext
  /** Exact measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Exact six measured TableIds. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Generation-bound execution-boundary port. */
  readonly boundaryPort: WorkspaceSearchMigrationExecutionBoundaryAwsPort
  /** Generation-bound sealed-root port. */
  readonly rootPort:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort
  /** Generation-bound immutable planning gateway. */
  readonly planningGateway:
    WorkspaceSearchMigrationPlanningArtifactAwsGateway
  /** Exact canonical operator-reviewed dry-run bytes. */
  readonly reviewedDryRunEvidenceBytes: Uint8Array
  /** Canonical completion time carried by the reviewed dry-run artifact. */
  readonly reviewedDryRunCompletedAt: string
  /** Digest of the exact reviewed dry-run artifact. */
  readonly dryRunEvidenceDigest: string
  /** Bounded-process planning join limits. */
  readonly planningJoinLimits: WorkspaceSearchMigrationPlanningJoinLimits
  /** Shared immutable artifact retention deadline. */
  readonly retainUntil: string
  /** Trusted supervisor wall clock. */
  readonly clock: WorkspaceSearchMigrationHeartbeatClock
}

/**
 * Runs every close and replanning stage under one stable heartbeat lease.
 *
 * @param input - Fixed measured identity, ports, artifacts, and task context.
 * @returns Exact terminal durable planning result.
 */
async function runPostClosePlanning(
  input: RunPostClosePlanningInput,
): Promise<WorkspaceSearchMigrationPostClosePlanningResult> {
  const runId = input.context.lease.runId
  let state = await readDurablePlanningState(
    input.context,
    input.boundaryPort,
    input.rootPort,
    runId,
  )
  const completed = await recoverCompletedPlanning(
    input.context,
    input.planningGateway,
    state,
    runId,
    input.configurationHash,
    input.tableIds,
    input.dryRunEvidenceDigest,
  )
  if (completed !== undefined) return completed

  if (state.boundary !== undefined) {
    requirePlanningBoundaryBinding(
      state.boundary,
      runId,
      input.configurationHash,
      input.tableIds,
    )
  }
  const authorityController =
    new PostClosePlanningAuthorityController({
      session: input.session,
      provider: input.provider,
      context: input.context,
      configurationHash: input.configurationHash,
      tableIds: input.tableIds,
      clock: input.clock,
      closedAt: state.boundary?.closedAt,
    })
  await authorityController.initialize()
  let boundary = state.boundary
  if (boundary === undefined) {
    const closeAuthority = await authorityController.renewForClose()
    void readPlanningArtifactPreflight(
      input.session,
      input.retainUntil,
      input.reviewedDryRunCompletedAt,
      postCloseMinimumDrainMilliseconds,
    )
    boundary = await runGuardedOperation(
      input.context,
      () => input.boundaryPort.close(closeAuthority),
    )
    requirePlanningBoundaryBinding(
      boundary,
      runId,
      input.configurationHash,
      input.tableIds,
    )
    authorityController.bindClosedAt(boundary.closedAt)
  }
  if (boundary.phase === 'closed') {
    const admission = await authorityController.renewForPostClose()
    boundary = await runGuardedOperation(
      input.context,
      () => input.boundaryPort.admitPlanning({
        currentAuthority: admission.authority,
        maintenanceEvidenceBytes: admission.evidenceBytes,
      }),
    )
    requirePlanningBoundaryBinding(
      boundary,
      runId,
      input.configurationHash,
      input.tableIds,
    )
  }
  const admittedBoundary = requirePlanningAdmittedBoundary(boundary)
  authorityController.bindClosedAt(admittedBoundary.closedAt)

  const capturedHeads = await readPlanningEvidenceHeads(input)
  const pageBudget = createPlanningEvidencePageBudget(capturedHeads)
  await completePlanningSourceEvidence(
    input,
    authorityController,
    capturedHeads.sources,
    pageBudget,
  )
  await completePlanningTargetEvidence(
    input,
    authorityController,
    capturedHeads.target,
    pageBudget,
  )
  const prepared = await runGuardedOperation(
    input.context,
    () => input.session.prepareCommittedPlanningEvidence({
      runId,
      configuration: input.configuration,
      configurationHash: input.configurationHash,
      limits: input.planningJoinLimits,
    }),
  )
  input.context.assertActive()
  const sealedPlan = sealWorkspaceSearchMigrationPlan({
    runId,
    configuration: input.configuration,
    configurationHash: input.configurationHash,
    dryRunEvidenceDigest: input.dryRunEvidenceDigest,
    reviewedDryRunEvidenceBytes:
      input.reviewedDryRunEvidenceBytes,
    scanSnapshot: prepared.result.scanSnapshot,
    targetOwnershipEvidence:
      prepared.result.targetOwnershipEvidence,
    candidates: prepared.result.candidates,
    createdAt: selectPlanningCreatedAt(
      admittedBoundary.planningAdmission.admittedAt,
      input.reviewedDryRunCompletedAt,
    ),
  })
  input.context.assertActive()
  const storedProvenance = await writePreparedPlanningProvenance(
    input.context,
    prepared,
    input.retainUntil,
  )
  const storedPlan = await runGuardedOperation(
    input.context,
    () => input.planningGateway.writePlanArtifact({
      planSeal: sealedPlan.seal,
      operations: sealedPlan.operations,
      retainUntil: input.retainUntil,
    }),
  )
  state = await readDurablePlanningState(
    input.context,
    input.boundaryPort,
    input.rootPort,
    runId,
  )
  const durableBoundary = requirePlanningAdmittedBoundary(
    requireDurableBoundary(state.boundary),
  )
  requireSamePlanningAdmission(admittedBoundary, durableBoundary)
  if (state.root !== undefined) {
    const recovered = await recoverCompletedPlanning(
      input.context,
      input.planningGateway,
      state,
      runId,
      input.configurationHash,
      input.tableIds,
      input.dryRunEvidenceDigest,
    )
    if (recovered !== undefined) return recovered
  }
  const currentAuthority =
    (await authorityController.renewForPostClose()).authority

  const published = await runGuardedOperation(
    input.context,
    () => input.rootPort.publish({
      runId,
      configuration: input.configuration,
      configurationHash: input.configurationHash,
      planSeal: sealedPlan.seal,
      planSealReference: storedPlan.planSealReference,
      planManifestHead: storedPlan.manifestHead,
      planManifestHeadReference:
        storedPlan.manifestHeadReference,
      planningProvenanceManifestHead:
        storedProvenance.manifestHead,
      planningProvenanceManifestHeadReference:
        storedProvenance.manifestHeadReference,
      planningAuthorityProvenance:
        storedProvenance.planningAuthorityProvenance,
      sourceProgress: prepared.result.sourceProgress,
      targetProgress: prepared.result.targetProgress,
      currentAuthority,
    }),
  )
  requirePlanningRootBinding(
    published,
    durableBoundary,
    runId,
    input.configurationHash,
    input.tableIds,
  )
  requireRootCurrentAuthority(published, currentAuthority)
  requirePlanSealBinding(
    sealedPlan.seal,
    published,
    runId,
    input.configurationHash,
    input.dryRunEvidenceDigest,
  )

  const finalState = await readDurablePlanningState(
    input.context,
    input.boundaryPort,
    input.rootPort,
    runId,
  )
  const finalBoundary = requirePlanningAdmittedBoundary(
    requireDurableBoundary(finalState.boundary),
  )
  requireSamePlanningAdmission(durableBoundary, finalBoundary)
  const finalRoot = requireDurableRoot(finalState.root)
  requirePlanningRootBinding(
    finalRoot,
    finalBoundary,
    runId,
    input.configurationHash,
    input.tableIds,
  )
  if (finalRoot.authorityDigest !== published.authorityDigest) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Sealed planning authority changed after publication.',
    )
  }
  return {
    executionBoundary: finalBoundary,
    sealedPlanningAuthority: finalRoot,
    planSeal: sealedPlan.seal,
  }
}

/**
 * Strongly captures all five durable heads before the next page mutation.
 *
 * @param input - Fixed supervised planning input.
 * @returns Exact four source heads and one target head.
 */
async function readPlanningEvidenceHeads(
  input: RunPostClosePlanningInput,
): Promise<PlanningEvidenceProgressHeads> {
  const projectDirectory = await readPlanningSourceEvidenceHead(
    input,
    'project-directory',
  )
  const workItems = await readPlanningSourceEvidenceHead(
    input,
    'work-items',
  )
  const collaboration = await readPlanningSourceEvidenceHead(
    input,
    'collaboration',
  )
  const documents = await readPlanningSourceEvidenceHead(
    input,
    'documents',
  )
  const targetRequest: WorkspaceSearchMigrationTargetEvidenceAwsRequest = {
    runId: input.context.lease.runId,
    purpose: 'planning',
    configuration: input.configuration,
    configurationHash: input.configurationHash,
  }
  const target = await runGuardedOperation(
    input.context,
    () => input.session.readTargetEvidenceProgress(targetRequest),
  )
  requireTargetProgressBinding(
    target,
    input.context.lease.runId,
    input.configurationHash,
    input.tableIds['workspace-search'],
    input.tableIds['migration-state'],
  )
  return {
    sources: {
      'project-directory': projectDirectory,
      'work-items': workItems,
      collaboration,
      documents,
    },
    target,
  }
}

/**
 * Reads one fixed source head and validates its complete durable identity.
 *
 * @param input - Fixed supervised planning input.
 * @param source - Canonical source role to read.
 * @returns Exact current source evidence progress.
 */
async function readPlanningSourceEvidenceHead(
  input: RunPostClosePlanningInput,
  source: WorkspaceSearchMigrationSourceName,
): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
  const request:
    WorkspaceSearchMigrationPlanningSourceEvidenceAwsRequest = {
      runId: input.context.lease.runId,
      purpose: 'planning',
      configuration: input.configuration,
      configurationHash: input.configurationHash,
      source,
    }
  const progress = await runGuardedOperation(
    input.context,
    () => input.session.readSourceEvidenceProgress(request),
  )
  requireSourceProgressBinding(
    progress,
    source,
    input.context.lease.runId,
    input.configurationHash,
    input.tableIds[source],
    input.tableIds['migration-state'],
  )
  return progress
}

/**
 * Creates the shared combined evidence-page budget from five captured heads.
 *
 * @param heads - Five exact durable planning heads.
 * @returns Mutable total-page budget initialized from durable sequences.
 */
function createPlanningEvidencePageBudget(
  heads: PlanningEvidenceProgressHeads,
): PlanningEvidencePageBudget {
  const totalPages =
    heads.sources['project-directory'].pageSequence +
    heads.sources['work-items'].pageSequence +
    heads.sources.collaboration.pageSequence +
    heads.sources.documents.pageSequence +
    heads.target.pageSequence
  if (
    !Number.isSafeInteger(totalPages) ||
    totalPages >
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_EVIDENCE_PAGES
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Planning evidence exceeds the combined durable page bound.',
    )
  }
  return { totalPages }
}

/**
 * Advances all four source chains from their captured durable heads.
 *
 * @param input - Fixed supervised planning input.
 * @param authorityController - Fresh post-close authority controller.
 * @param captured - Four source heads fixed before any new page commit.
 * @param budget - Shared combined durable-page budget.
 */
async function completePlanningSourceEvidence(
  input: RunPostClosePlanningInput,
  authorityController: PostClosePlanningAuthorityController,
  captured: PlanningEvidenceProgressHeads['sources'],
  budget: PlanningEvidencePageBudget,
): Promise<void> {
  for (const source of workspaceSearchMigrationSourceNames) {
    const request:
      WorkspaceSearchMigrationPlanningSourceEvidenceAwsRequest = {
        runId: input.context.lease.runId,
        purpose: 'planning',
        configuration: input.configuration,
        configurationHash: input.configurationHash,
        source,
      }
    let progress = captured[source]
    while (!progress.checkpoint.completed) {
      requirePlanningEvidencePageCapacity(budget)
      const previousPageSequence = progress.pageSequence
      const authority =
        await authorityController.resolveForPlanning()
      progress = await runGuardedOperation(
        input.context,
        () => input.session.commitNextSourceEvidencePage({
          ...request,
          authority,
        }),
      )
      requireSourceProgressBinding(
        progress,
        source,
        input.context.lease.runId,
        input.configurationHash,
        input.tableIds[source],
        input.tableIds['migration-state'],
      )
      consumePlanningEvidencePageProgress(
        budget,
        previousPageSequence,
        progress.pageSequence,
      )
    }
  }
}

/**
 * Advances the target chain from its captured durable head until terminal.
 *
 * @param input - Fixed supervised planning input.
 * @param authorityController - Fresh post-close authority controller.
 * @param captured - Target head fixed before any new page commit.
 * @param budget - Shared combined durable-page budget.
 */
async function completePlanningTargetEvidence(
  input: RunPostClosePlanningInput,
  authorityController: PostClosePlanningAuthorityController,
  captured: WorkspaceSearchMigrationTargetEvidenceProgress,
  budget: PlanningEvidencePageBudget,
): Promise<void> {
  const request: WorkspaceSearchMigrationTargetEvidenceAwsRequest = {
    runId: input.context.lease.runId,
    purpose: 'planning',
    configuration: input.configuration,
    configurationHash: input.configurationHash,
  }
  let progress = captured
  while (!progress.checkpoint.completed) {
    requirePlanningEvidencePageCapacity(budget)
    const previousPageSequence = progress.pageSequence
    const authority =
      await authorityController.resolveForPlanning()
    progress = await runGuardedOperation(
      input.context,
      () => input.session.commitNextTargetEvidencePage({
        ...request,
        authority,
      }),
    )
    requireTargetProgressBinding(
      progress,
      input.context.lease.runId,
      input.configurationHash,
      input.tableIds['workspace-search'],
      input.tableIds['migration-state'],
    )
    consumePlanningEvidencePageProgress(
      budget,
      previousPageSequence,
      progress.pageSequence,
    )
  }
}

/**
 * Requires room for at least one additional durable evidence page.
 *
 * @param budget - Shared combined durable-page budget.
 */
function requirePlanningEvidencePageCapacity(
  budget: PlanningEvidencePageBudget,
): void {
  if (
    budget.totalPages >=
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_EVIDENCE_PAGES
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Planning evidence reached the combined durable page bound.',
    )
  }
}

/**
 * Accounts for one exact durable successor in the shared page budget.
 *
 * @param budget - Shared combined durable-page budget.
 * @param previousPageSequence - Exact predecessor chain sequence.
 * @param currentPageSequence - Exact returned durable successor sequence.
 */
function consumePlanningEvidencePageProgress(
  budget: PlanningEvidencePageBudget,
  previousPageSequence: number,
  currentPageSequence: number,
): void {
  if (
    currentPageSequence <= previousPageSequence ||
    !Number.isSafeInteger(currentPageSequence)
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Planning evidence did not advance to a durable successor.',
    )
  }
  const additionalPages = currentPageSequence - previousPageSequence
  const totalPages = budget.totalPages + additionalPages
  if (
    !Number.isSafeInteger(totalPages) ||
    totalPages >
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_EVIDENCE_PAGES
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Planning evidence exceeded the combined durable page bound.',
    )
  }
  budget.totalPages = totalPages
}

/**
 * Writes exact private provenance only after heartbeat supervision is active.
 *
 * @param guard - Heartbeat activity guard.
 * @param prepared - Opaque joined evidence and provenance writer.
 * @param retainUntil - Shared immutable retention deadline.
 * @returns Exact stored provenance roots.
 */
async function writePreparedPlanningProvenance(
  guard: PlanningOperationGuard,
  prepared: WorkspaceSearchMigrationPreparedCommittedPlanningEvidence,
  retainUntil: string,
): ReturnType<
  WorkspaceSearchMigrationPreparedCommittedPlanningEvidence[
    'writePlanningProvenanceArtifact'
  ]
> {
  return runGuardedOperation(
    guard,
    () => prepared.writePlanningProvenanceArtifact({ retainUntil }),
  )
}

/**
 * Strongly reads the boundary followed by the sealed root under one guard.
 *
 * @param guard - Current operation activity guard.
 * @param boundaryPort - Generation-bound boundary reader.
 * @param rootPort - Generation-bound sealed-root reader.
 * @param runId - Operator-selected deterministic run.
 * @returns Current durable boundary and root observations.
 */
async function readDurablePlanningState(
  guard: PlanningOperationGuard,
  boundaryPort: WorkspaceSearchMigrationExecutionBoundaryAwsPort,
  rootPort: WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort,
  runId: string,
): Promise<DurablePlanningState> {
  const boundary = await runGuardedOperation(
    guard,
    () => boundaryPort.read(runId),
  )
  const root = await runGuardedOperation(
    guard,
    () => rootPort.read(runId),
  )
  return { boundary, root }
}

/**
 * Replays and returns an already durable sealed plan when publication exists.
 *
 * @param guard - Current operation activity guard.
 * @param planningGateway - Generation-bound exact-version artifact gateway.
 * @param state - Strongly observed boundary and root pair.
 * @param runId - Operator-selected deterministic run.
 * @param configurationHash - Reviewed measured-configuration digest.
 * @param tableIds - Exact measured six TableIds.
 * @param dryRunEvidenceDigest - Exact reviewed dry-run artifact digest.
 * @returns Completed result, or undefined when no root exists.
 */
async function recoverCompletedPlanning(
  guard: PlanningOperationGuard,
  planningGateway: WorkspaceSearchMigrationPlanningArtifactAwsGateway,
  state: DurablePlanningState,
  runId: string,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  dryRunEvidenceDigest: string,
): Promise<WorkspaceSearchMigrationPostClosePlanningResult | undefined> {
  const root = state.root
  if (root === undefined) {
    if (state.boundary !== undefined) {
      requirePlanningBoundaryBinding(
        state.boundary,
        runId,
        configurationHash,
        tableIds,
      )
    }
    return undefined
  }
  const boundary = requirePlanningAdmittedBoundary(
    requireDurableBoundary(state.boundary),
  )
  requirePlanningBoundaryBinding(
    boundary,
    runId,
    configurationHash,
    tableIds,
  )
  requirePlanningRootBinding(
    root,
    boundary,
    runId,
    configurationHash,
    tableIds,
  )
  const replay = await runGuardedOperation(
    guard,
    () => planningGateway.replayPlanArtifact({
      planSealReference: root.planSealReference,
      manifestHeadReference:
        root.planManifestHeadReference,
    }),
  )
  const provenance = await runGuardedOperation(
    guard,
    () => planningGateway.replayPlanningProvenanceArtifact({
      manifestHeadReference:
        root.planningProvenanceManifestHeadReference,
    }),
  )
  requirePlanSealBinding(
    replay.planSeal,
    root,
    runId,
    configurationHash,
    dryRunEvidenceDigest,
  )
  requirePlanningProvenanceBinding(
    provenance,
    root,
    runId,
    configurationHash,
    tableIds,
  )
  return {
    executionBoundary: boundary,
    sealedPlanningAuthority: root,
    planSeal: replay.planSeal,
  }
}

/**
 * Runs one external operation only while the supplied guard remains active.
 *
 * @param guard - Signal or heartbeat activity guard.
 * @param operation - One complete external operation or composite adapter call.
 * @returns Exact operation result after a second activity assertion.
 */
async function runGuardedOperation<Result>(
  guard: PlanningOperationGuard,
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
 * Creates a read-only guard from an optional operator signal.
 *
 * @param signal - Optional external interruption signal.
 * @returns Guard that raises the stable heartbeat interruption.
 */
function createSignalGuard(
  signal: AbortSignal | undefined,
): PlanningOperationGuard {
  return {
    assertActive: () => {
      if (signal?.aborted === true) {
        throw new WorkspaceSearchMigrationHeartbeatInterruptedError()
      }
    },
  }
}

/**
 * Reads canonical dry-run evidence through a stable migration failure.
 *
 * @param bytes - Exact caller-selected reviewed bytes.
 * @returns Strict detached reviewed dry-run evidence.
 */
function readReviewedDryRunEvidence(
  bytes: Uint8Array,
): ReturnType<typeof parseWorkspaceSearchDryRunEvidence> {
  try {
    return parseWorkspaceSearchDryRunEvidence(bytes)
  } catch {
    return failPlanningSupervisor(
      'DRY_RUN_INVALID_ROWS',
      'Reviewed dry-run evidence is not a canonical passing artifact.',
    )
  }
}

/**
 * Detaches reviewed dry-run bytes before any external operation begins.
 *
 * @param bytes - Caller-owned candidate byte array.
 * @returns Detached exact bytes.
 */
function snapshotReviewedDryRunEvidence(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    return failPlanningSupervisor(
      'DRY_RUN_INVALID_ROWS',
      'Reviewed dry-run evidence is not a byte artifact.',
    )
  }
  try {
    return Uint8Array.from(bytes)
  } catch {
    return failPlanningSupervisor(
      'DRY_RUN_INVALID_ROWS',
      'Reviewed dry-run evidence is not a readable byte artifact.',
    )
  }
}

/**
 * Detaches every top-level caller value before the first asynchronous read.
 *
 * Collaborator objects and the live AbortSignal retain identity, while scalar
 * values, bounded limits, and reviewed bytes are copied so later caller
 * mutation cannot redirect an in-progress supervision run.
 *
 * @param input - Caller-owned supervision request.
 * @returns Stable request snapshot safe to retain across awaits.
 */
function snapshotPostClosePlanningInput(
  input: SuperviseWorkspaceSearchMigrationPostClosePlanningInput,
): SuperviseWorkspaceSearchMigrationPostClosePlanningInput {
  let session: WorkspaceSearchMigrationPostClosePlanningSession
  let maintenanceEvidenceProvider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider
  let runId: string
  let ownerId: string
  let expectedConfigurationHash: string
  let reviewedDryRunEvidenceBytes: Uint8Array
  let planningJoinLimits: WorkspaceSearchMigrationPlanningJoinLimits
  let retainUntil: string
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
    reviewedDryRunEvidenceBytes = input.reviewedDryRunEvidenceBytes
    planningJoinLimits = input.planningJoinLimits
    retainUntil = input.retainUntil
    signal = input.signal
    heartbeatScheduler = input.heartbeatScheduler
    clock = input.clock
  } catch {
    return failPlanningSupervisor(
      'INVALID_ARGUMENT',
      'Planning supervision input is not readable.',
    )
  }
  const reviewedDryRunEvidenceSnapshot =
    snapshotReviewedDryRunEvidence(reviewedDryRunEvidenceBytes)
  const planningJoinLimitsSnapshot =
    readPlanningJoinLimits(planningJoinLimits)
  return {
    session,
    maintenanceEvidenceProvider,
    runId,
    ownerId,
    expectedConfigurationHash,
    reviewedDryRunEvidenceBytes: reviewedDryRunEvidenceSnapshot,
    planningJoinLimits: planningJoinLimitsSnapshot,
    retainUntil,
    ...(signal === undefined ? {} : { signal }),
    ...(heartbeatScheduler === undefined
      ? {}
      : { heartbeatScheduler }),
    ...(clock === undefined ? {} : { clock }),
  }
}

/**
 * Validates and detaches bounded planning join limits before writer close.
 *
 * @param limits - Caller-selected row, byte, and operation ceilings.
 * @returns Exact detached bounded-process limits.
 */
function readPlanningJoinLimits(
  limits: WorkspaceSearchMigrationPlanningJoinLimits,
): WorkspaceSearchMigrationPlanningJoinLimits {
  let maxTotalRows: number
  let maxTotalCanonicalItemBytes: number
  let maxPlanOperations: number
  try {
    maxTotalRows = limits.maxTotalRows
    maxTotalCanonicalItemBytes = limits.maxTotalCanonicalItemBytes
    maxPlanOperations = limits.maxPlanOperations
  } catch {
    return failPlanningSupervisor(
      'INVALID_ARGUMENT',
      'Planning join limits are not readable.',
    )
  }
  if (
    !Number.isSafeInteger(maxTotalRows) ||
    maxTotalRows <= 0 ||
    maxTotalRows >
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_TOTAL_ROWS ||
    !Number.isSafeInteger(maxTotalCanonicalItemBytes) ||
    maxTotalCanonicalItemBytes <= 0 ||
    maxTotalCanonicalItemBytes >
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_CANONICAL_BYTES ||
    !Number.isSafeInteger(maxPlanOperations) ||
    maxPlanOperations <= 0 ||
    maxPlanOperations >
      WORKSPACE_SEARCH_MIGRATION_MANAGED_PLANNING_MAX_OPERATIONS
  ) {
    return failPlanningSupervisor(
      'INVALID_ARGUMENT',
      'Planning join limits exceed the managed process bounds.',
    )
  }
  return {
    maxTotalRows,
    maxTotalCanonicalItemBytes,
    maxPlanOperations,
  }
}

/**
 * Validates reviewed time and retention before writer-fence close.
 *
 * @param session - Current measured managed-session capability.
 * @param retainUntil - Caller-selected canonical retention timestamp.
 * @param reviewedDryRunCompletedAt - Reviewed dry-run completion time.
 * @param minimumAdditionalHeadroomMilliseconds - Required pre-write runway.
 * @returns Exact deadline with the complete immutable-write headroom.
 */
function readPlanningArtifactPreflight(
  session: WorkspaceSearchMigrationPostClosePlanningSession,
  retainUntil: string,
  reviewedDryRunCompletedAt: string,
  minimumAdditionalHeadroomMilliseconds: number,
): string {
  return session.validatePlanningArtifactPreflight({
    retainUntil,
    minimumAdditionalHeadroomMilliseconds,
    reviewedDryRunCompletedAt,
  })
}

/**
 * Selects one restart-stable plan epoch from durable and reviewed timestamps.
 *
 * @param admittedAt - Canonical durable revision-two admission time.
 * @param dryRunCompletedAt - Canonical reviewed dry-run completion time.
 * @returns The later original canonical timestamp.
 */
function selectPlanningCreatedAt(
  admittedAt: string,
  dryRunCompletedAt: string,
): string {
  return Date.parse(admittedAt) >= Date.parse(dryRunCompletedAt)
    ? admittedAt
    : dryRunCompletedAt
}

/**
 * Reads and detaches one finite trusted clock value.
 *
 * @param clock - Injected or default wall clock.
 * @returns Detached valid Date.
 */
function readPlanningClock(
  clock: WorkspaceSearchMigrationHeartbeatClock,
): Date {
  const current = clock()
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
    return failPlanningSupervisor(
      'INVALID_ARGUMENT',
      'Planning supervisor clock is invalid.',
    )
  }
  return new Date(current.getTime())
}

/**
 * Reports whether lease and receipt both retain one atomic commit window.
 *
 * @param authority - Latest locally retained current authority.
 * @param clock - Trusted supervisor clock.
 * @returns Whether a strong current-authority reread may safely be attempted.
 */
function hasAuthorityCommitHeadroom(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  clock: WorkspaceSearchMigrationHeartbeatClock,
): boolean {
  const threshold = readPlanningClock(clock).getTime() +
    WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  return Date.parse(authority.lease.expiresAt) > threshold &&
    Date.parse(authority.maintenanceEvidenceReceipt.validUntil) >
      threshold
}

/**
 * Derives the exact all-six TableId binding from one measured configuration.
 *
 * @param configuration - Exact measured migration configuration.
 * @returns Fixed source, target, and state TableIds.
 */
function createPlanningTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    collaboration: configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Compares every fixed source, target, and state TableId.
 *
 * @param left - First exact TableId set.
 * @param right - Second exact TableId set.
 * @returns Whether all six immutable incarnations match.
 */
function samePlanningTableIds(
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
 * Requires one durable boundary to match the same run, hash, and TableIds.
 *
 * @param boundary - Candidate durable revision one or two.
 * @param runId - Expected operator run.
 * @param configurationHash - Expected reviewed configuration digest.
 * @param tableIds - Expected six measured TableIds.
 */
function requirePlanningBoundaryBinding(
  boundary: WorkspaceSearchMigrationExecutionBoundary,
  runId: string,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
): void {
  if (
    boundary.runId !== runId ||
    boundary.configurationHash !== configurationHash ||
    !samePlanningTableIds(boundary.tableIds, tableIds)
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Execution boundary differs from the supervised run.',
    )
  }
}

/**
 * Requires one boundary to be the durable revision-two admission.
 *
 * @param boundary - Candidate durable execution boundary.
 * @returns Exact planning-admitted revision-two boundary.
 */
function requirePlanningAdmittedBoundary(
  boundary: WorkspaceSearchMigrationExecutionBoundary,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  if (boundary.phase !== 'planning-admitted') {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Planning authority exists before revision-two admission.',
    )
  }
  return boundary
}

/**
 * Requires a durable execution boundary to exist.
 *
 * @param boundary - Strongly read optional boundary.
 * @returns Exact durable boundary.
 */
function requireDurableBoundary(
  boundary: WorkspaceSearchMigrationExecutionBoundary | undefined,
): WorkspaceSearchMigrationExecutionBoundary {
  if (boundary === undefined) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Sealed planning authority has no execution boundary.',
    )
  }
  return boundary
}

/**
 * Requires a durable sealed planning root to exist.
 *
 * @param root - Strongly read optional sealed root.
 * @returns Exact immutable version-two root.
 */
function requireDurableRoot(
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2 | undefined,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (root === undefined) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Sealed planning authority disappeared after publication.',
    )
  }
  return root
}

/**
 * Requires two observations to identify the exact same revision-two admission.
 *
 * @param expected - Previously accepted durable admission.
 * @param current - Newly reread durable admission.
 */
function requireSamePlanningAdmission(
  expected: WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
  current: WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
): void {
  if (expected.boundaryDigest !== current.boundaryDigest) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Planning admission changed during supervision.',
    )
  }
}

/**
 * Requires a sealed root to match its revision two and measured identity.
 *
 * @param root - Candidate immutable version-two root.
 * @param boundary - Exact durable revision-two admission.
 * @param runId - Expected operator run.
 * @param configurationHash - Expected reviewed configuration digest.
 * @param tableIds - Expected six measured TableIds.
 */
function requirePlanningRootBinding(
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  boundary: WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
  runId: string,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
): void {
  if (
    root.runId !== runId ||
    root.configurationHash !== configurationHash ||
    !samePlanningTableIds(root.tableIds, tableIds) ||
    Date.parse(root.sealedAt) < Date.parse(boundary.planningAdmission.admittedAt)
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Sealed planning authority is not bound to revision two.',
    )
  }
}

/**
 * Requires a plan seal to match the root and reviewed dry-run artifact.
 *
 * @param planSeal - Exact replayed or newly created plan seal.
 * @param root - Exact sealed planning root.
 * @param runId - Expected operator run.
 * @param configurationHash - Expected reviewed configuration digest.
 * @param dryRunEvidenceDigest - Expected reviewed dry-run digest.
 */
function requirePlanSealBinding(
  planSeal: WorkspaceSearchPlanSeal,
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  runId: string,
  configurationHash: string,
  dryRunEvidenceDigest: string,
): void {
  if (
    planSeal.runId !== runId ||
    planSeal.configurationHash !== configurationHash ||
    planSeal.dryRunEvidenceDigest !== dryRunEvidenceDigest ||
    planSeal.planDigest !== root.planDigest ||
    planSeal.planningSnapshotDigest !== root.planningSnapshotDigest ||
    planSeal.sourceOperationCount !== root.sourceOperationCount ||
    planSeal.orphanOperationCount !== root.orphanOperationCount ||
    planSeal.planOperationCount !== root.planOperationCount
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Stored plan seal differs from the supervised planning root.',
    )
  }
}

/**
 * Requires replayed provenance to match every compact sealed-root commitment.
 *
 * @param provenance - Exact replayed full provenance artifact.
 * @param root - Exact sealed planning root.
 * @param runId - Expected operator run.
 * @param configurationHash - Expected reviewed configuration digest.
 * @param tableIds - Expected six measured TableIds.
 */
function requirePlanningProvenanceBinding(
  provenance: WorkspaceSearchMigrationPlanningProvenanceArtifact,
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  runId: string,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
): void {
  if (
    provenance.runId !== runId ||
    provenance.configurationHash !== configurationHash ||
    provenance.stateTableId !== tableIds['migration-state'] ||
    !samePlanningTableIds(provenance.tableIds, tableIds) ||
    provenance.provenance.provenanceDigest !==
      root.planningAuthorityProvenanceDigest ||
    provenance.planningSnapshotDigest !==
      root.planningSnapshotDigest ||
    provenance.sourceOperationCount !== root.sourceOperationCount ||
    provenance.orphanOperationCount !== root.orphanOperationCount ||
    provenance.planOperationCount !== root.planOperationCount ||
    provenance.historicalReceiptBindingDigest !==
      root.historicalReceiptBindingDigest ||
    provenance.historicalReceipts.length !==
      root.historicalReceiptCount
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Stored planning provenance differs from the sealed root.',
    )
  }
}

/**
 * Requires a newly published root to retain the exact current authority.
 *
 * @param root - Exact newly published root.
 * @param authority - Exact authority condition-checked at publication.
 */
function requireRootCurrentAuthority(
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): void {
  if (
    root.currentAuthority.ownerId !== authority.lease.ownerId ||
    root.currentAuthority.fenceToken !== authority.lease.fenceToken ||
    root.currentAuthority.maintenanceEvidencePointerRevision !==
      authority.maintenanceEvidencePointerRevision ||
    root.currentAuthority.maintenanceEvidenceReceiptDigest !==
      authority.maintenanceEvidenceReceiptDigest
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Published root differs from the current planning authority.',
    )
  }
}

/**
 * Requires one source progress observation to remain in the supervised chain.
 *
 * @param progress - Candidate durable source progress.
 * @param source - Expected fixed source role.
 * @param runId - Expected operator run.
 * @param configurationHash - Expected reviewed configuration digest.
 * @param sourceTableId - Expected immutable source TableId.
 * @param stateTableId - Expected immutable migration-state TableId.
 */
function requireSourceProgressBinding(
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
  source: WorkspaceSearchMigrationSourceName,
  runId: string,
  configurationHash: string,
  sourceTableId: string,
  stateTableId: string,
): void {
  if (
    progress.runId !== runId ||
    progress.purpose !== 'planning' ||
    progress.source !== source ||
    progress.configurationHash !== configurationHash ||
    progress.sourceTableId !== sourceTableId ||
    progress.stateTableId !== stateTableId
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Source planning head changed identity.',
    )
  }
}

/**
 * Requires one target progress observation to remain in the supervised chain.
 *
 * @param progress - Candidate durable target progress.
 * @param runId - Expected operator run.
 * @param configurationHash - Expected reviewed configuration digest.
 * @param targetTableId - Expected immutable target TableId.
 * @param stateTableId - Expected immutable migration-state TableId.
 */
function requireTargetProgressBinding(
  progress: WorkspaceSearchMigrationTargetEvidenceProgress,
  runId: string,
  configurationHash: string,
  targetTableId: string,
  stateTableId: string,
): void {
  if (
    progress.runId !== runId ||
    progress.purpose !== 'planning' ||
    progress.configurationHash !== configurationHash ||
    progress.targetTableId !== targetTableId ||
    progress.stateTableId !== stateTableId
  ) {
    return failPlanningSupervisor(
      'INVALID_STATE',
      'Target planning head changed identity.',
    )
  }
}

/**
 * Creates one stable operator-safe supervisor failure.
 *
 * @param code - Existing migration failure taxonomy entry.
 * @param message - Secret-free operator guidance.
 * @returns Never; the function always throws.
 */
function failPlanningSupervisor(
  code: ConstructorParameters<typeof WorkspaceSearchMigrationFailure>[0],
  message: string,
): never {
  throw new WorkspaceSearchMigrationFailure(code, message)
}

/**
 * Returns the current wall-clock time for production supervision.
 *
 * @returns Fresh current Date.
 */
function defaultPlanningClock(): Date {
  return new Date()
}
