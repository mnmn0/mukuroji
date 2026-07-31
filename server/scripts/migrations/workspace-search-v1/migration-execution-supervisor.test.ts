import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  type WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type MigrationDigestState,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationApplyCheckpointSnapshot,
  decodeWorkspaceSearchMigrationApplyCheckpointSnapshot,
} from './migration-apply-checkpoint-receipt'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import type {
  WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  readWorkspaceSearchMigrationExecutionStatus,
  superviseWorkspaceSearchMigrationExecution,
  type WorkspaceSearchMigrationExecutionStatus,
  type WorkspaceSearchMigrationExecutionSupervisorMode,
  type WorkspaceSearchMigrationExecutionSupervisorSession,
} from './migration-execution-supervisor'
import type {
  WorkspaceSearchMigrationFullVerificationPersistenceState,
  WorkspaceSearchMigrationFullVerificationResultArtifactReference,
  WorkspaceSearchMigrationFullVerificationTraversalSnapshot,
  WorkspaceSearchMigrationFullVerificationVerifiedRoot,
} from './migration-full-verification-persistence'
import {
  WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
} from './migration-full-verification-persistence'
import {
  WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
} from './migration-full-verification'
import type {
  WorkspaceSearchMigrationHeartbeatScheduler,
  WorkspaceSearchMigrationHeartbeatTimerHandle,
} from './migration-heartbeat-supervisor'
import type {
  WorkspaceSearchMigrationManagedPartialRollbackAwsPort,
} from './migration-identity-aws'
import type {
  WorkspaceSearchMigrationPlanArtifactReplayResult,
} from './migration-plan-artifact'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  createWorkspaceSearchMigrationPlanningProvenanceObjectKey,
} from './migration-planning-provenance-manifest'
import type {
  WorkspaceSearchMigrationMaintenanceEvidenceProvider,
} from './migration-post-close-planning-supervisor'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationRollbackPersistenceState,
  WorkspaceSearchMigrationRolledBackRoot,
} from './migration-rollback-persistence'
import {
  WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION,
} from './migration-rollback-persistence'
import type {
  WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot,
} from './migration-partial-rollback-start-aws'
import type {
  WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  WorkspaceSearchMigrationRollbackPersistenceStateV2,
  WorkspaceSearchMigrationRollbackStartRootV2,
  WorkspaceSearchMigrationRolledBackRootV2,
} from './migration-rollback-persistence-v2'
import {
  WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
} from './migration-rollback-persistence-v2'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchMigrationTraversal,
  type WorkspaceSearchMigrationCheckpointLocation,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'
import {
  createWorkspaceSearchMigrationAbsentSnapshot,
} from './migration-target-snapshot'
import {
  maintenanceRuntimeControlSurfaces,
  type WorkspaceSearchMaintenanceEvidence,
} from './maintenance-evidence'

const runId = 'execution-supervisor-test'
const ownerId = 'execution-supervisor-owner'
const closedAt = '2026-07-29T01:00:00.000Z'
const admittedAt = '2026-07-29T01:16:00.000Z'
const planCreatedAt = '2026-07-29T01:17:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const evaluatedAt = '2026-07-29T01:19:30.000Z'
const retainUntil = '2026-08-29T00:00:00.000Z'
const fixedNow = new Date('2026-07-29T01:19:30.000Z')

/**
 * Durable graph selected by one focused supervisor harness.
 */
type SupervisorScenario =
  | 'ready'
  | 'applying'
  | 'applied'
  | 'verifying'
  | 'verified'
  | 'partial-rollback'
  | 'partial-rolled-back'
  | 'complete-rollback'
  | 'complete-rolled-back'

/**
 * Static roots shared by every fake managed port.
 */
type SupervisorFixture = {
  /** Fresh measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the measured configuration. */
  readonly configurationHash: string
  /** Exact closed application-writer fence. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact planning-admitted execution boundary. */
  readonly boundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact one-operation plan replay. */
  readonly replay: WorkspaceSearchMigrationPlanArtifactReplayResult
  /** Exact immutable initial execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Fresh authority matching the initial lease generation. */
  readonly initialAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
}

/**
 * One manually scheduled heartbeat callback.
 */
type ScheduledHeartbeat = {
  /** Deferred one-shot callback. */
  readonly callback: () => void
  /** Whether cancellation prevents the callback from starting. */
  canceled: boolean
  /** Whether the callback already started. */
  started: boolean
}

/**
 * Deterministic scheduler used to trigger a heartbeat race from a test.
 */
class ManualHeartbeatScheduler
  implements WorkspaceSearchMigrationHeartbeatScheduler {
  /** Every scheduled one-shot heartbeat. */
  private readonly heartbeats: ScheduledHeartbeat[] = []

  /**
   * Records one callback without starting it.
   *
   * @param callback - One-shot heartbeat callback.
   * @param _delayMilliseconds - Production-selected delay.
   * @returns Cancelable recorded callback.
   */
  schedule(
    callback: () => void,
    _delayMilliseconds: number,
  ): WorkspaceSearchMigrationHeartbeatTimerHandle {
    const heartbeat: ScheduledHeartbeat = {
      callback,
      canceled: false,
      started: false,
    }
    this.heartbeats.push(heartbeat)
    return {
      cancel: (): void => {
        heartbeat.canceled = true
      },
    }
  }

  /**
   * Starts the oldest pending heartbeat.
   */
  runNext(): void {
    const heartbeat = this.heartbeats.find(
      (candidate) =>
        !candidate.canceled && !candidate.started,
    )
    if (heartbeat === undefined) {
      throw new Error('Expected one pending heartbeat.')
    }
    heartbeat.started = true
    heartbeat.callback()
  }
}

/**
 * Externally released promise used to hold one adapter reconciliation in flight.
 */
type DeferredRunState = {
  /** Promise returned by the fake adapter. */
  readonly promise: Promise<WorkspaceSearchMigrationRunState>
  /** Resolves the in-flight adapter with its reconciled durable state. */
  readonly resolve: (
    state: WorkspaceSearchMigrationRunState,
  ) => void
}

/**
 * Creates one externally controlled run-state promise.
 *
 * @returns Promise and its exact resolver.
 */
function createDeferredRunState(): DeferredRunState {
  let resolvePromise:
    | ((state: WorkspaceSearchMigrationRunState) => void)
    | undefined
  const promise = new Promise<WorkspaceSearchMigrationRunState>(
    (resolve) => {
      resolvePromise = resolve
    },
  )
  return {
    promise,
    resolve: (state): void => {
      if (resolvePromise === undefined) {
        throw new Error('Expected one deferred resolver.')
      }
      resolvePromise(state)
    },
  }
}

/**
 * Stateful fake managed session spanning status and supervised mutations.
 */
class ExecutionSupervisorHarness {
  /** Static correlated roots used by every fake port. */
  readonly fixture = createSupervisorFixture()

  /** Ordered read, authority, and mutation events. */
  readonly events: string[] = []

  /** Deterministic heartbeat scheduler. */
  readonly scheduler = new ManualHeartbeatScheduler()

  /** Fully typed managed session consumed by the supervisor. */
  readonly session: WorkspaceSearchMigrationExecutionSupervisorSession

  /** Trusted post-close evidence provider. */
  readonly maintenanceEvidenceProvider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider

  /** Current immutable execution admission, absent only in ready. */
  private executionRun:
    WorkspaceSearchMigrationExecutionRun | undefined

  /** Current reconstructed apply run state. */
  private runState: WorkspaceSearchMigrationRunState

  /** Current verification progress, when started. */
  private verificationProgress:
    WorkspaceSearchMigrationFullVerificationPersistenceState | undefined

  /** Immutable verified root, when published. */
  private verifiedRoot:
    WorkspaceSearchMigrationFullVerificationVerifiedRoot | undefined

  /** Current committed-prefix rollback lifecycle, when started. */
  private partialRollbackLifecycle:
    WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot | undefined

  /** Current complete-plan rollback state, when started. */
  private completeRollbackState:
    WorkspaceSearchMigrationRollbackPersistenceState | undefined

  /** Immutable complete-plan rollback root, when published. */
  private completeRolledBackRoot:
    WorkspaceSearchMigrationRolledBackRoot | undefined

  /** Current lease generation acquired by the supervisor. */
  private acquiredFenceToken = 7

  /** Current fresh authority returned by strong reads or renewal. */
  private currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority

  /** Current durable pointer read at supervisor initialization. */
  private pointer:
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null

  /** Fence already adopted by the mutable execution state. */
  private adoptedFenceToken: number

  /** Whether the old pointer must fail and force evidence renewal. */
  private rejectNextAuthorityRead = false

  /** Immutable expired receipt selected by one rejected pointer read. */
  private rejectedAuthorityReceipt:
    WorkspaceSearchMaintenanceEvidenceReceipt | undefined

  /** Whether post-adoption reads expose the heartbeat-extended lease. */
  private exposeHeartbeatExtendedAuthority = false

  /** Optional operator signal aborted during authority adoption. */
  private abortDuringAdoption: AbortController | undefined

  /** Whether the first scheduled heartbeat loses the lease. */
  private failHeartbeatAfterInitial = false

  /** Number of heartbeats already attempted. */
  private heartbeatCount = 0

  /** Optional operator signal aborted during operation reconciliation. */
  private abortDuringOperation: AbortController | undefined

  /** Optional deferred operation result held across a heartbeat race. */
  private deferredOperation: DeferredRunState | undefined

  /**
   * Creates one durable scenario and all fake managed ports.
   *
   * @param scenario - Durable graph exposed by strong reads.
   */
  constructor(scenario: SupervisorScenario) {
    this.currentAuthority =
      structuredClone(this.fixture.initialAuthority)
    this.pointer = {
      fenceToken:
        this.fixture.initialAuthority.lease.fenceToken,
      revision:
        this.fixture.initialAuthority
          .maintenanceEvidencePointerRevision,
      receiptDigest:
        this.fixture.initialAuthority
          .maintenanceEvidenceReceiptDigest,
    }
    this.executionRun = scenario === 'ready'
      ? undefined
      : structuredClone(this.fixture.executionRun)
    this.adoptedFenceToken =
      this.fixture.executionRun.binding.currentAuthority.fenceToken
    this.runState = createScenarioRunState(
      this.fixture.executionRun.runState,
      scenario,
    )
    this.verificationProgress =
      scenario === 'verifying'
        ? createVerificationState(this.fixture, 1)
        : undefined
    this.verifiedRoot = scenario === 'verified'
      ? createVerifiedRoot(
          this.fixture,
          createVerificationState(this.fixture, 5, true),
        )
      : undefined
    this.partialRollbackLifecycle =
      scenario === 'partial-rollback'
        ? createPartialRollbackLifecycle(
            this.fixture,
            this.runState,
            false,
          )
        : scenario === 'partial-rolled-back'
          ? createPartialRollbackLifecycle(
              this.fixture,
              this.runState,
              true,
            )
          : undefined
    this.completeRollbackState =
      scenario === 'complete-rollback' ||
          scenario === 'complete-rolled-back'
        ? createCompleteRollbackState(
            this.fixture,
            this.runState,
            scenario === 'complete-rolled-back'
              ? 'rolled-back'
              : 'rolling-back',
            scenario === 'complete-rolled-back' ? 0 : 1,
            scenario === 'complete-rolled-back' ? 3 : 1,
          )
        : undefined
    this.completeRolledBackRoot = undefined

    this.maintenanceEvidenceProvider = {
      collect: async () => {
        this.events.push('evidence:collect')
        return {
          configurationHash: this.fixture.configurationHash,
          tableIds:
            structuredClone(
              this.fixture.sealedPlanningAuthority.tableIds,
            ),
          evidenceBytes: createMaintenanceEvidenceBytes(),
        }
      },
    }
    this.session = this.createSession()
  }

  /**
   * Selects a different acquired lease and current authority generation.
   *
   * @param fenceToken - New takeover fence.
   * @param selectedOwnerId - New process owner.
   */
  selectTakeover(
    fenceToken: number,
    selectedOwnerId: string,
  ): void {
    this.acquiredFenceToken = fenceToken
    this.currentAuthority = createAuthority(
      this.fixture,
      fenceToken,
      selectedOwnerId,
      20,
    )
    this.pointer = {
      fenceToken,
      revision:
        this.currentAuthority
          .maintenanceEvidencePointerRevision,
      receiptDigest:
        this.currentAuthority
          .maintenanceEvidenceReceiptDigest,
    }
  }

  /**
   * Makes the next pointer-bound authority read force renewal.
   */
  rejectPointerAuthorityOnce(): void {
    const expiredReceipt =
      createExpiredMaintenanceReceipt(
        this.acquiredFenceToken,
      )
    this.pointer = {
      fenceToken: this.acquiredFenceToken,
      revision:
        this.currentAuthority
          .maintenanceEvidencePointerRevision,
      receiptDigest: createMigrationDigest(expiredReceipt),
    }
    this.rejectedAuthorityReceipt = expiredReceipt
    this.rejectNextAuthorityRead = true
  }

  /**
   * Makes later authority reads expose a heartbeat-extended lease.
   */
  exposeHeartbeatExtensionAfterAdoption(): void {
    this.exposeHeartbeatExtendedAuthority = true
  }

  /**
   * Reads a clock that advances after the first authority adoption.
   *
   * @returns Fixed pre-adoption time or a later post-heartbeat time.
   */
  readHeartbeatAwareClock(): Date {
    return this.events.some((event) => event.startsWith('adopt:'))
      ? new Date('2026-07-29T01:20:25.000Z')
      : new Date(fixedNow.getTime())
  }

  /**
   * Restores the admitted revision-one apply state.
   */
  resetToInitialApplyingState(): void {
    this.runState =
      structuredClone(this.fixture.executionRun.runState)
    this.adoptedFenceToken =
      this.fixture.executionRun.binding.currentAuthority.fenceToken
  }

  /**
   * Aborts one operator signal after authority adoption reconciles.
   *
   * @param controller - Operator interruption controller.
   */
  abortAfterAdoption(controller: AbortController): void {
    this.abortDuringAdoption = controller
  }

  /**
   * Aborts one operator signal after the operation adapter reconciles.
   *
   * @param controller - Operator interruption controller.
   */
  abortAfterOperation(controller: AbortController): void {
    this.abortDuringOperation = controller
  }

  /**
   * Holds one operation result while a heartbeat fails.
   */
  blockOperationForHeartbeatLoss(): void {
    this.failHeartbeatAfterInitial = true
    this.deferredOperation = createDeferredRunState()
  }

  /**
   * Releases the in-flight operation with its already reconciled state.
   */
  releaseOperation(): void {
    const deferred = this.deferredOperation
    if (deferred === undefined) {
      throw new Error('Expected one blocked operation.')
    }
    this.deferredOperation = undefined
    deferred.resolve(structuredClone(this.runState))
  }

  /**
   * Returns the current durable run state for exact test assertions.
   *
   * @returns Detached current run state.
   */
  readCurrentRunState(): WorkspaceSearchMigrationRunState {
    return structuredClone(this.runState)
  }

  /**
   * Creates the fully typed fake managed session.
   *
   * @returns Session whose factories share this harness state.
   */
  private createSession():
    WorkspaceSearchMigrationExecutionSupervisorSession {
    return {
      measureConfiguration: async () => {
        this.events.push('configuration:read')
        return structuredClone(this.fixture.configuration)
      },
      createExecutionBoundaryPort: () => ({
        read: async () => {
          this.events.push('boundary:read')
          return structuredClone(this.fixture.boundary)
        },
        close: () => unexpectedOperation('boundary close'),
        admitPlanning: () =>
          unexpectedOperation('planning admission'),
      }),
      createSealedPlanningAuthorityPort: () => ({
        read: async () => {
          this.events.push('sealed-authority:read')
          return structuredClone(
            this.fixture.sealedPlanningAuthority,
          )
        },
        publish: () =>
          unexpectedOperation('sealed-authority publish'),
      }),
      createApplicationWriterFencePort: () => ({
        bootstrapOpen: () =>
          unexpectedOperation('writer-fence bootstrap'),
        read: async () => {
          this.events.push('writer-fence:read')
          return {
            status: 'present',
            record: structuredClone(
              this.fixture.closedWriterFenceRecord,
            ),
          }
        },
      }),
      createPlanningArtifactGateway: () => ({
        writePlanArtifact: () =>
          unexpectedOperation('plan write'),
        replayPlanArtifact: async () => {
          this.events.push('plan:replay')
          return structuredClone(this.fixture.replay)
        },
        writePlanningProvenanceArtifact: () =>
          unexpectedOperation('provenance write'),
        replayPlanningProvenanceArtifact: () =>
          unexpectedOperation('provenance replay'),
      }),
      createExecutionRunPort: () => ({
        read: async () => {
          this.events.push('execution-run:read')
          return structuredClone(this.executionRun)
        },
        create: async (authority) => {
          this.events.push(
            `execution-create:${authority.lease.fenceToken}`,
          )
          this.executionRun =
            structuredClone(this.fixture.executionRun)
          this.runState =
            structuredClone(this.fixture.executionRun.runState)
          this.adoptedFenceToken =
            authority.lease.fenceToken
          return structuredClone(this.executionRun)
        },
      }),
      createApplyOperationPort: () => ({
        readRunState: async () => {
          this.events.push('apply:read')
          return structuredClone(this.runState)
        },
        readOperationMarker: async () => undefined,
        readApplyReceipt: async () => undefined,
        adoptExecutionAuthority: async (input) => {
          this.events.push(
            `adopt:${input.expectedRevision}:${input.authority.lease.fenceToken}`,
          )
          if (
            this.exposeHeartbeatExtendedAuthority &&
            this.heartbeatCount === 1
          ) {
            this.scheduler.runNext()
            await Promise.resolve()
          }
          if (
            input.authority.lease.fenceToken !==
              this.adoptedFenceToken
          ) {
            this.adoptedFenceToken =
              input.authority.lease.fenceToken
            this.runState = {
              ...this.runState,
              revision: this.runState.revision + 1,
              maintenanceEvidenceDigest:
                this.currentAuthority
                  .maintenanceEvidenceReceipt.evidenceDigest,
              maintenanceEvidenceLocator:
                this.currentAuthority
                  .maintenanceEvidenceReceipt.evidenceLocator,
              maintenanceEvidenceReceipt:
                structuredClone(
                  this.currentAuthority
                    .maintenanceEvidenceReceipt,
                ),
              updatedAt: evaluatedAt,
            }
          }
          this.abortDuringAdoption?.abort()
          return structuredClone(this.runState)
        },
        commitApplyOperation: async (input) => {
          this.events.push(
            `operation:${input.expectedRevision}:${input.event.plannedOperation.planSequence}`,
          )
          this.runState = createOperationSuccessor(
            this.runState,
          )
          this.abortDuringOperation?.abort()
          const deferred = this.deferredOperation
          return deferred === undefined
            ? structuredClone(this.runState)
            : deferred.promise
        },
        saveApplyCheckpoint: async (input) => {
          this.events.push(
            `checkpoint:${input.expectedRevision}:${input.location}`,
          )
          this.runState = createCheckpointSuccessor(
            this.runState,
            input.location,
          )
          return structuredClone(this.runState)
        },
        sealApply: async (input) => {
          this.events.push(`seal:${input.expectedRevision}`)
          this.runState = createAppliedSuccessor(
            this.runState,
          )
          return structuredClone(this.runState)
        },
      }),
      createFullVerificationPort: () => ({
        readProgress: async () => {
          this.events.push('verification:read-progress')
          return structuredClone(this.verificationProgress)
        },
        readVerifiedRoot: async () => {
          this.events.push('verification:read-root')
          return structuredClone(this.verifiedRoot)
        },
        saveVerificationPage: async (input) => {
          this.events.push(
            `verify-page:${input.expectedRevision}:${input.location}`,
          )
          this.verificationProgress =
            createVerificationSuccessor(
              this.fixture,
              this.verificationProgress,
              input.location,
            )
          return structuredClone(this.verificationProgress)
        },
        publishVerified: async (input) => {
          this.events.push(
            `verify-publish:${input.expectedRevision}`,
          )
          const progress = this.verificationProgress
          if (progress === undefined) {
            throw new Error(
              'Expected terminal verification progress.',
            )
          }
          this.verifiedRoot = createVerifiedRoot(
            this.fixture,
            progress,
          )
          return structuredClone(this.verifiedRoot)
        },
      }),
      createPartialRollbackOperationPort: () =>
        this.createPartialRollbackPort(),
      createRollbackOperationPort: () => ({
        readRollbackState: async () => {
          this.events.push('complete-rollback:read-state')
          return structuredClone(this.completeRollbackState)
        },
        readRollbackReceipt: async () => undefined,
        readRolledBackRoot: async () => {
          this.events.push('complete-rollback:read-root')
          return structuredClone(
            this.completeRolledBackRoot,
          )
        },
        beginRollback: async (input) => {
          this.events.push(
            `complete-rollback:begin:${input.expectedRevision}`,
          )
          this.completeRollbackState =
            createCompleteRollbackState(
              this.fixture,
              this.runState,
              'rolling-back',
              1,
              1,
            )
          return structuredClone(
            this.completeRollbackState,
          )
        },
        commitRollbackOperation: async (input) => {
          this.events.push(
            `complete-rollback:operation:${input.expectedRevision}`,
          )
          this.completeRollbackState =
            createCompleteRollbackState(
              this.fixture,
              this.runState,
              'rolling-back',
              0,
              input.expectedRevision + 1,
            )
          return structuredClone(
            this.completeRollbackState,
          )
        },
        finishRollback: async (input) => {
          this.events.push(
            `complete-rollback:finish:${input.expectedRevision}`,
          )
          this.completeRollbackState =
            createCompleteRollbackState(
              this.fixture,
              this.runState,
              'rolled-back',
              0,
              input.expectedRevision + 1,
            )
          this.completeRolledBackRoot =
            createCompleteRolledBackRoot(
              this.fixture,
              this.completeRollbackState,
            )
          return structuredClone(
            this.completeRolledBackRoot,
          )
        },
      }),
      acquireLease: async (input) => {
        this.events.push(
          `lease:acquire:${input.ownerId}:${this.acquiredFenceToken}`,
        )
        return createLease(
          this.acquiredFenceToken,
          input.ownerId,
        )
      },
      heartbeatLease: async () => {
        this.heartbeatCount += 1
        this.events.push(`lease:heartbeat:${this.heartbeatCount}`)
        if (
          this.failHeartbeatAfterInitial &&
          this.heartbeatCount > 1
        ) {
          throw new WorkspaceSearchMigrationFailure(
            'LEASE_LOST',
            'LEASE_LOST',
          )
        }
        const lease = createLease(
          this.acquiredFenceToken,
          this.currentAuthority.lease.ownerId,
        )
        return (
            this.exposeHeartbeatExtendedAuthority &&
            this.events.some((event) => event.startsWith('adopt:'))
          )
          ? {
              ...lease,
              heartbeatAt: '2026-07-29T01:20:20.000Z',
              expiresAt: '2026-07-29T01:21:20.000Z',
            }
          : lease
      },
      readMaintenanceEvidencePointer: async () => {
        this.events.push('authority:read-pointer')
        return structuredClone(this.pointer)
      },
      readAuthority: async () => {
        this.events.push('authority:read')
        if (this.rejectNextAuthorityRead) {
          this.rejectNextAuthorityRead = false
          throw new WorkspaceSearchMigrationFailure(
            'INVALID_MAINTENANCE_EVIDENCE',
            'INVALID_MAINTENANCE_EVIDENCE',
          )
        }
        const authority = structuredClone(this.currentAuthority)
        if (
          this.exposeHeartbeatExtendedAuthority &&
          this.events.some((event) => event.startsWith('adopt:'))
        ) {
          return {
            ...authority,
            lease: {
              ...authority.lease,
              heartbeatAt: '2026-07-29T01:20:20.000Z',
              expiresAt: '2026-07-29T01:21:20.000Z',
            },
          }
        }
        return authority
      },
      readMaintenanceEvidenceReceipt: async () => {
        this.events.push('authority:read-receipt')
        return structuredClone(
          this.rejectedAuthorityReceipt ??
            this.currentAuthority.maintenanceEvidenceReceipt,
        )
      },
      renewMaintenanceEvidence: async (input) => {
        this.events.push('authority:renew')
        const revision =
          (input.expectedPointer?.revision ?? 0) + 1
        this.currentAuthority = createAuthority(
          this.fixture,
          this.acquiredFenceToken,
          input.lease.ownerId,
          revision,
        )
        this.pointer = {
          fenceToken: this.acquiredFenceToken,
          revision,
          receiptDigest:
            this.currentAuthority
              .maintenanceEvidenceReceiptDigest,
        }
        return structuredClone(this.currentAuthority)
      },
    }
  }

  /**
   * Creates the managed committed-prefix rollback fake.
   *
   * @returns Shared lifecycle reader and mutation port.
   */
  private createPartialRollbackPort():
    WorkspaceSearchMigrationManagedPartialRollbackAwsPort {
    return {
      readRollbackLifecycle: async () => {
        this.events.push('partial-rollback:read')
        return structuredClone(
          this.partialRollbackLifecycle,
        )
      },
      readRollbackState: async () =>
        structuredClone(
          this.partialRollbackLifecycle?.state,
        ),
      beginRollback: async (input) => {
        this.events.push(
          `partial-rollback:begin:${input.expectedRevision}`,
        )
        this.partialRollbackLifecycle =
          createPartialRollbackLifecycle(
            this.fixture,
            this.runState,
            false,
          )
        return structuredClone(
          this.partialRollbackLifecycle.state,
        )
      },
      readRollbackReceipt: async () => undefined,
      commitRollbackOperation: async (input) => {
        this.events.push(
          `partial-rollback:operation:${input.expectedRevision}`,
        )
        const current = this.partialRollbackLifecycle
        if (current === undefined) {
          throw new Error(
            'Expected partial rollback lifecycle.',
          )
        }
        const state = createPartialRollbackState(
          this.fixture,
          this.runState,
          'rolling-back',
          0,
          input.expectedRevision + 1,
        )
        this.partialRollbackLifecycle = {
          startRoot: current.startRoot,
          state,
        }
        return structuredClone(state)
      },
      finishRollback: async (input) => {
        this.events.push(
          `partial-rollback:finish:${input.expectedRevision}`,
        )
        const current = this.partialRollbackLifecycle
        if (current === undefined) {
          throw new Error(
            'Expected partial rollback lifecycle.',
          )
        }
        const state = createPartialRollbackState(
          this.fixture,
          this.runState,
          'rolled-back',
          0,
          input.expectedRevision + 1,
        )
        const rolledBackRoot =
          createPartialRolledBackRoot(
            this.fixture,
            state,
          )
        this.partialRollbackLifecycle = {
          startRoot: current.startRoot,
          state,
          rolledBackRoot,
        }
        return structuredClone(rolledBackRoot)
      },
    }
  }
}

describe('Workspace Search migration execution supervisor', () => {
  test('folds every durable phase into a minimal read-only status without lease or authority writes', async () => {
    const cases: readonly {
      /** Durable graph exposed by the fake session. */
      readonly scenario: SupervisorScenario
      /** Expected secret-free public status. */
      readonly expected: WorkspaceSearchMigrationExecutionStatus
    }[] = [
      {
        scenario: 'ready',
        expected: {
          phase: 'ready',
          nextAction: { kind: 'apply' },
        },
      },
      {
        scenario: 'applying',
        expected: {
          phase: 'applying',
          nextAction: {
            kind: 'choose',
            options: ['apply', 'partial-rollback'],
          },
        },
      },
      {
        scenario: 'applied',
        expected: {
          phase: 'applied',
          nextAction: {
            kind: 'choose',
            options: ['verify', 'complete-rollback'],
          },
        },
      },
      {
        scenario: 'verifying',
        expected: {
          phase: 'verifying',
          nextAction: { kind: 'verify' },
        },
      },
      {
        scenario: 'verified',
        expected: {
          phase: 'verified',
          nextAction: { kind: 'none' },
        },
      },
      {
        scenario: 'partial-rollback',
        expected: {
          phase: 'rolling-back',
          nextAction: {
            kind: 'rollback',
            scope: 'committed-prefix',
          },
        },
      },
      {
        scenario: 'complete-rollback',
        expected: {
          phase: 'rolling-back',
          nextAction: {
            kind: 'rollback',
            scope: 'complete-plan',
          },
        },
      },
      {
        scenario: 'partial-rolled-back',
        expected: {
          phase: 'rolled-back',
          nextAction: { kind: 'none' },
        },
      },
      {
        scenario: 'complete-rolled-back',
        expected: {
          phase: 'rolled-back',
          nextAction: { kind: 'none' },
        },
      },
    ]

    for (const entry of cases) {
      const harness =
        new ExecutionSupervisorHarness(entry.scenario)

      const status =
        await readWorkspaceSearchMigrationExecutionStatus({
          session: harness.session,
          runId,
          expectedConfigurationHash:
            harness.fixture.configurationHash,
        })

      expect(status).toEqual(entry.expected)
      expect(Object.keys(status).sort()).toEqual([
        'nextAction',
        'phase',
      ])
      expect(
        harness.events.some(isLeaseOrAuthorityMutation),
      ).toBe(false)
    }
  })

  test('creates admission then applies one operation, five checkpoints, and the seal at exact revisions', async () => {
    const harness = new ExecutionSupervisorHarness('ready')

    const status =
      await superviseWorkspaceSearchMigrationExecution({
        session: harness.session,
        maintenanceEvidenceProvider:
          harness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          harness.fixture.configurationHash,
        mode: 'apply',
        heartbeatScheduler: harness.scheduler,
        clock: fixedClock,
      })

    expect(status).toEqual({
      phase: 'applied',
      nextAction: {
        kind: 'choose',
        options: ['verify', 'complete-rollback'],
      },
    })
    expect(harness.events.filter(isApplyMutationEvent)).toEqual([
      'execution-create:7',
      'adopt:1:7',
      'operation:1:1',
      'adopt:2:7',
      'checkpoint:2:project-directory',
      'adopt:3:7',
      'checkpoint:3:work-items',
      'adopt:4:7',
      'checkpoint:4:collaboration',
      'adopt:5:7',
      'checkpoint:5:documents',
      'adopt:6:7',
      'checkpoint:6:target',
      'adopt:7:7',
      'seal:7',
    ])
    expect(harness.readCurrentRunState()).toMatchObject({
      revision: 8,
      status: 'applied',
      appliedOperationCount: 1,
    })
  })

  test('advances legal verify and scope-specific rollback branches while rejecting drift before lease acquisition', async () => {
    const verifyHarness =
      new ExecutionSupervisorHarness('applied')
    const verified =
      await superviseWorkspaceSearchMigrationExecution({
        session: verifyHarness.session,
        maintenanceEvidenceProvider:
          verifyHarness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          verifyHarness.fixture.configurationHash,
        mode: 'verify',
        heartbeatScheduler: verifyHarness.scheduler,
        clock: fixedClock,
      })
    expect(verified).toEqual({
      phase: 'verified',
      nextAction: { kind: 'none' },
    })
    expect(
      verifyHarness.events.filter((event) =>
        event.startsWith('verify-')
      ),
    ).toEqual([
      'verify-page:0:project-directory',
      'verify-page:1:work-items',
      'verify-page:2:collaboration',
      'verify-page:3:documents',
      'verify-page:4:target',
      'verify-publish:5',
    ])

    const partialHarness =
      new ExecutionSupervisorHarness('applying')
    const partial =
      await superviseWorkspaceSearchMigrationExecution({
        session: partialHarness.session,
        maintenanceEvidenceProvider:
          partialHarness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          partialHarness.fixture.configurationHash,
        mode: 'partial-rollback',
        heartbeatScheduler: partialHarness.scheduler,
        clock: fixedClock,
      })
    expect(partial).toEqual({
      phase: 'rolled-back',
      nextAction: { kind: 'none' },
    })
    expect(
      partialHarness.events.filter((event) =>
        event.startsWith('partial-rollback:') &&
        !event.endsWith(':read')
      ),
    ).toEqual([
      'partial-rollback:begin:2',
      'partial-rollback:operation:1',
      'partial-rollback:finish:2',
    ])

    const completeHarness =
      new ExecutionSupervisorHarness('applied')
    const complete =
      await superviseWorkspaceSearchMigrationExecution({
        session: completeHarness.session,
        maintenanceEvidenceProvider:
          completeHarness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          completeHarness.fixture.configurationHash,
        mode: 'complete-rollback',
        heartbeatScheduler: completeHarness.scheduler,
        clock: fixedClock,
      })
    expect(complete).toEqual({
      phase: 'rolled-back',
      nextAction: { kind: 'none' },
    })
    expect(
      completeHarness.events.filter((event) =>
        event.startsWith('complete-rollback:') &&
        !event.includes(':read-')
      ),
    ).toEqual([
      'complete-rollback:begin:8',
      'complete-rollback:operation:1',
      'complete-rollback:finish:2',
    ])

    const illegalCases: readonly {
      /** Durable graph whose branch must reject. */
      readonly scenario: SupervisorScenario
      /** Explicit mismatched supervisor mode. */
      readonly mode:
        WorkspaceSearchMigrationExecutionSupervisorMode
    }[] = [
      { scenario: 'applying', mode: 'verify' },
      { scenario: 'applied', mode: 'partial-rollback' },
      {
        scenario: 'partial-rollback',
        mode: 'complete-rollback',
      },
      {
        scenario: 'complete-rollback',
        mode: 'partial-rollback',
      },
      { scenario: 'verified', mode: 'apply' },
      {
        scenario: 'partial-rolled-back',
        mode: 'complete-rollback',
      },
      {
        scenario: 'complete-rolled-back',
        mode: 'partial-rollback',
      },
    ]
    for (const entry of illegalCases) {
      const harness =
        new ExecutionSupervisorHarness(entry.scenario)
      const failure = await captureMigrationFailure(() =>
        superviseWorkspaceSearchMigrationExecution({
          session: harness.session,
          maintenanceEvidenceProvider:
            harness.maintenanceEvidenceProvider,
          runId,
          ownerId,
          expectedConfigurationHash:
            harness.fixture.configurationHash,
          mode: entry.mode,
          heartbeatScheduler: harness.scheduler,
          clock: fixedClock,
        })
      )
      expect(failure.code).toBe('INVALID_STATE')
      expect(
        harness.events.some(isLeaseOrAuthorityMutation),
      ).toBe(false)
    }

    const completedCases: readonly {
      /** Durable graph already at the requested terminal boundary. */
      readonly scenario: SupervisorScenario
      /** Matching mode that must return without mutation authority. */
      readonly mode:
        WorkspaceSearchMigrationExecutionSupervisorMode
    }[] = [
      {
        scenario: 'partial-rolled-back',
        mode: 'partial-rollback',
      },
      {
        scenario: 'complete-rolled-back',
        mode: 'complete-rollback',
      },
      { scenario: 'applied', mode: 'apply' },
      { scenario: 'verified', mode: 'verify' },
    ]
    for (const entry of completedCases) {
      const harness =
        new ExecutionSupervisorHarness(entry.scenario)
      await superviseWorkspaceSearchMigrationExecution({
        session: harness.session,
        maintenanceEvidenceProvider:
          harness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          harness.fixture.configurationHash,
        mode: entry.mode,
        heartbeatScheduler: harness.scheduler,
        clock: fixedClock,
      })
      expect(
        harness.events.some(isLeaseOrAuthorityMutation),
      ).toBe(false)
    }
  })

  test('does not start another mutation after operator abort once the in-flight operation reconciles', async () => {
    const harness = new ExecutionSupervisorHarness('ready')
    const controller = new AbortController()
    harness.abortAfterOperation(controller)

    const error = await captureError(() =>
      superviseWorkspaceSearchMigrationExecution({
        session: harness.session,
        maintenanceEvidenceProvider:
          harness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          harness.fixture.configurationHash,
        mode: 'apply',
        signal: controller.signal,
        heartbeatScheduler: harness.scheduler,
        clock: fixedClock,
      })
    )

    expect(error.name).toBe(
      'WorkspaceSearchMigrationHeartbeatInterruptedError',
    )
    expect(harness.events.filter(isApplyMutationEvent)).toEqual([
      'execution-create:7',
      'adopt:1:7',
      'operation:1:1',
    ])
    expect(harness.readCurrentRunState().revision).toBe(2)
  })

  test('does not start another mutation after heartbeat loss while operation reconciliation is in flight', async () => {
    const harness = new ExecutionSupervisorHarness('ready')
    harness.blockOperationForHeartbeatLoss()
    const supervised =
      superviseWorkspaceSearchMigrationExecution({
        session: harness.session,
        maintenanceEvidenceProvider:
          harness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          harness.fixture.configurationHash,
        mode: 'apply',
        heartbeatScheduler: harness.scheduler,
        clock: fixedClock,
      })
    await waitForEvent(harness.events, 'operation:1:1')

    harness.scheduler.runNext()
    await Promise.resolve()
    harness.releaseOperation()
    const failure = await captureMigrationFailure(
      () => supervised,
    )

    expect(failure.code).toBe('LEASE_LOST')
    expect(harness.events.filter(isApplyMutationEvent)).toEqual([
      'execution-create:7',
      'adopt:1:7',
      'operation:1:1',
    ])
    expect(harness.readCurrentRunState().revision).toBe(2)
  })

  test('adopts a higher-fence takeover before continuing apply', async () => {
    const harness =
      new ExecutionSupervisorHarness('applying')
    harness.resetToInitialApplyingState()
    harness.selectTakeover(8, 'execution-supervisor-takeover')

    const status =
      await superviseWorkspaceSearchMigrationExecution({
        session: harness.session,
        maintenanceEvidenceProvider:
          harness.maintenanceEvidenceProvider,
        runId,
        ownerId: 'execution-supervisor-takeover',
        expectedConfigurationHash:
          harness.fixture.configurationHash,
        mode: 'apply',
        heartbeatScheduler: harness.scheduler,
        clock: fixedClock,
      })

    expect(status.phase).toBe('applied')
    const mutations =
      harness.events.filter(isApplyMutationEvent)
    expect(mutations.slice(0, 3)).toEqual([
      'adopt:1:8',
      'adopt:2:8',
      'operation:2:1',
    ])
    const firstAdoptionIndex =
      harness.events.indexOf('adopt:1:8')
    const reconciledAdoptionIndex =
      harness.events.indexOf('adopt:2:8')
    expect(
      harness.events.slice(
        firstAdoptionIndex + 1,
        reconciledAdoptionIndex,
      ),
    ).toContain('apply:read')
    expect(harness.readCurrentRunState()).toMatchObject({
      revision: 9,
      status: 'applied',
      maintenanceEvidenceReceipt: {
        fenceToken: 8,
      },
    })
  })

  test('does not start a mutation after higher-fence adoption reconciles an operator abort', async () => {
    const harness =
      new ExecutionSupervisorHarness('applying')
    const controller = new AbortController()
    harness.resetToInitialApplyingState()
    harness.selectTakeover(8, 'execution-supervisor-takeover')
    harness.abortAfterAdoption(controller)

    const error = await captureError(() =>
      superviseWorkspaceSearchMigrationExecution({
        session: harness.session,
        maintenanceEvidenceProvider:
          harness.maintenanceEvidenceProvider,
        runId,
        ownerId: 'execution-supervisor-takeover',
        expectedConfigurationHash:
          harness.fixture.configurationHash,
        mode: 'apply',
        signal: controller.signal,
        heartbeatScheduler: harness.scheduler,
        clock: fixedClock,
      })
    )

    expect(error.name).toBe(
      'WorkspaceSearchMigrationHeartbeatInterruptedError',
    )
    expect(harness.events.filter(isApplyMutationEvent)).toEqual([
      'adopt:1:8',
    ])
    expect(harness.readCurrentRunState()).toMatchObject({
      revision: 2,
      status: 'applying',
      maintenanceEvidenceReceipt: {
        fenceToken: 8,
      },
    })
  })

  test('refreshes a heartbeat-extended lease before deciding to renew evidence', async () => {
    const harness =
      new ExecutionSupervisorHarness('applying')
    harness.exposeHeartbeatExtensionAfterAdoption()

    const status =
      await superviseWorkspaceSearchMigrationExecution({
        session: harness.session,
        maintenanceEvidenceProvider:
          harness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          harness.fixture.configurationHash,
        mode: 'apply',
        heartbeatScheduler: harness.scheduler,
        clock: () => harness.readHeartbeatAwareClock(),
      })

    expect(status.phase).toBe('applied')
    const firstAdoptionIndex =
      harness.events.indexOf('adopt:2:7')
    expect(
      harness.events
        .slice(firstAdoptionIndex)
        .filter((event) =>
          event.startsWith('adopt:') ||
          event === 'lease:heartbeat:2' ||
          event === 'checkpoint:2:project-directory' ||
          event === 'authority:read' ||
          event === 'evidence:collect' ||
          event === 'authority:renew'
        )
        .slice(0, 5),
    ).toEqual([
      'adopt:2:7',
      'lease:heartbeat:2',
      'checkpoint:2:project-directory',
      'authority:read',
      'adopt:3:7',
    ])
    expect(
      harness.events.filter((event) => event === 'authority:read')
        .length,
    ).toBeGreaterThan(1)
    expect(harness.events).not.toContain('evidence:collect')
    expect(harness.events).not.toContain('authority:renew')
  })

  test('renews after an expired pointer receipt fails closed, then continues', async () => {
    const harness = new ExecutionSupervisorHarness('ready')
    harness.rejectPointerAuthorityOnce()

    const status =
      await superviseWorkspaceSearchMigrationExecution({
        session: harness.session,
        maintenanceEvidenceProvider:
          harness.maintenanceEvidenceProvider,
        runId,
        ownerId,
        expectedConfigurationHash:
          harness.fixture.configurationHash,
        mode: 'apply',
        heartbeatScheduler: harness.scheduler,
        clock: fixedClock,
      })

    expect(status.phase).toBe('applied')
    expect(
      harness.events.filter((event) =>
        event === 'authority:read-pointer' ||
        event === 'authority:read' ||
        event === 'authority:read-receipt' ||
        event === 'evidence:collect' ||
        event === 'authority:renew' ||
        event.startsWith('execution-create:')
      ).slice(0, 6),
    ).toEqual([
      'authority:read-pointer',
      'authority:read',
      'authority:read-receipt',
      'evidence:collect',
      'authority:renew',
      'execution-create:7',
    ])
  })
})

/**
 * Returns whether one event is a lease or authority mutation.
 *
 * @param event - Recorded fake-session event.
 * @returns Whether read-only status must exclude the event.
 */
function isLeaseOrAuthorityMutation(event: string): boolean {
  return event.startsWith('lease:') ||
    event === 'authority:renew'
}

/**
 * Returns whether one event is part of forward apply mutation ordering.
 *
 * @param event - Recorded fake-session event.
 * @returns Whether the event belongs in the exact mutation trace.
 */
function isApplyMutationEvent(event: string): boolean {
  return event.startsWith('execution-create:') ||
    event.startsWith('adopt:') ||
    event.startsWith('operation:') ||
    event.startsWith('checkpoint:') ||
    event.startsWith('seal:')
}

/**
 * Stable test clock shared by heartbeat and evidence checks.
 *
 * @returns Detached fixed current time.
 */
function fixedClock(): Date {
  return new Date(fixedNow.getTime())
}

/**
 * Fails when a fake method outside supervisor scope is invoked.
 *
 * @param operation - Secret-free method label.
 * @returns Never-resolving typed promise.
 */
async function unexpectedOperation<Result>(
  operation: string,
): Promise<Result> {
  throw new Error(`Unexpected fake operation: ${operation}.`)
}

/**
 * Captures one stable migration failure.
 *
 * @param operation - Operation expected to fail.
 * @returns Exact migration failure.
 */
async function captureMigrationFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  const error = await captureError(operation)
  if (error instanceof WorkspaceSearchMigrationFailure) {
    return error
  }
  throw error
}

/**
 * Captures one arbitrary Error without trusting thrown values.
 *
 * @param operation - Operation expected to reject.
 * @returns Exact Error instance.
 */
async function captureError(
  operation: () => Promise<unknown>,
): Promise<Error> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof Error) return error
    throw new Error('Expected an Error rejection.')
  }
  throw new Error('Expected operation to reject.')
}

/**
 * Waits for one synchronous fake adapter event without using timers.
 *
 * @param events - Shared ordered event list.
 * @param expected - Event awaited by the test.
 */
async function waitForEvent(
  events: readonly string[],
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (events.includes(expected)) return
    await Promise.resolve()
  }
  throw new Error('Expected fake adapter event.')
}

/**
 * Creates the scenario-specific apply run state.
 *
 * @param initial - Immutable admission run state.
 * @param scenario - Durable graph selected by the test.
 * @returns Detached applying or applied state.
 */
function createScenarioRunState(
  initial: WorkspaceSearchMigrationRunState,
  scenario: SupervisorScenario,
): WorkspaceSearchMigrationRunState {
  if (
    scenario === 'applied' ||
    scenario === 'verifying' ||
    scenario === 'verified' ||
    scenario === 'complete-rollback' ||
    scenario === 'complete-rolled-back'
  ) {
    return createAppliedFixtureState(initial)
  }
  if (
    scenario === 'partial-rollback' ||
    scenario === 'partial-rolled-back' ||
    scenario === 'applying'
  ) {
    return createCommittedPrefixFixtureState(initial)
  }
  return structuredClone(initial)
}

/**
 * Creates an applying state after its one planned mutation committed.
 *
 * @param initial - Immutable admission state.
 * @returns Applying committed-prefix state at revision two.
 */
function createCommittedPrefixFixtureState(
  initial: WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationRunState {
  return {
    ...structuredClone(initial),
    revision: 2,
    appliedOperationCount: 1,
    applyMarkerDigestState: {
      count: 1,
      sumHex: digest('marker-sum'),
      xorHex: digest('marker-xor'),
    },
    journalSequence: 1,
    journalHeadDigest: digest('journal-head'),
    updatedAt: evaluatedAt,
  }
}

/**
 * Creates a complete applied state for verify and complete rollback.
 *
 * @param initial - Immutable admission state.
 * @returns Complete applied state at revision eight.
 */
function createAppliedFixtureState(
  initial: WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationRunState {
  const committed = createCommittedPrefixFixtureState(initial)
  return {
    ...committed,
    revision: 8,
    status: 'applied',
    apply: completeTraversal(committed.apply),
    applySeal: {
      scope: 'complete-plan',
      objectKey: 'workspace-search/v1/apply-seal.artifact',
      versionId: 'apply-seal-version-1',
      contentDigest: digest('apply-seal'),
    },
  }
}

/**
 * Records the one planned operation in fake apply state.
 *
 * @param current - Current applying state.
 * @returns Direct revision successor.
 */
function createOperationSuccessor(
  current: WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationRunState {
  return {
    ...structuredClone(current),
    revision: current.revision + 1,
    appliedOperationCount:
      current.appliedOperationCount + 1,
    applyMarkerDigestState: {
      count: current.applyMarkerDigestState.count + 1,
      sumHex: digest('operation-marker-sum'),
      xorHex: digest('operation-marker-xor'),
    },
    journalSequence: current.journalSequence + 1,
    journalHeadDigest: digest('operation-journal-head'),
    updatedAt: evaluatedAt,
  }
}

/**
 * Completes one apply checkpoint at the exact requested location.
 *
 * @param current - Current applying state.
 * @param location - Canonical source or target location.
 * @returns Direct revision successor.
 */
function createCheckpointSuccessor(
  current: WorkspaceSearchMigrationRunState,
  location: WorkspaceSearchMigrationCheckpointLocation,
): WorkspaceSearchMigrationRunState {
  const apply = structuredClone(current.apply)
  if (location === 'target') {
    apply.target = completeCheckpoint(apply.target)
  } else {
    apply.sources = {
      ...apply.sources,
      [location]: completeCheckpoint(
        apply.sources[location],
      ),
    }
  }
  return {
    ...structuredClone(current),
    revision: current.revision + 1,
    apply,
    updatedAt: evaluatedAt,
  }
}

/**
 * Publishes the complete apply boundary in fake state.
 *
 * @param current - Terminal applying state.
 * @returns Applied revision successor.
 */
function createAppliedSuccessor(
  current: WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationRunState {
  return {
    ...structuredClone(current),
    revision: current.revision + 1,
    status: 'applied',
    applySeal: {
      scope: 'complete-plan',
      objectKey: 'workspace-search/v1/apply-seal.artifact',
      versionId: 'apply-seal-version-1',
      contentDigest: digest('apply-seal'),
    },
    updatedAt: evaluatedAt,
  }
}

/**
 * Marks every checkpoint complete.
 *
 * @param traversal - Current five-location traversal.
 * @returns Detached terminal traversal.
 */
function completeTraversal(
  traversal: WorkspaceSearchMigrationRunState['apply'],
): WorkspaceSearchMigrationRunState['apply'] {
  return {
    sources: {
      'project-directory': completeCheckpoint(
        traversal.sources['project-directory'],
      ),
      'work-items': completeCheckpoint(
        traversal.sources['work-items'],
      ),
      collaboration: completeCheckpoint(
        traversal.sources.collaboration,
      ),
      documents: completeCheckpoint(
        traversal.sources.documents,
      ),
    },
    target: completeCheckpoint(traversal.target),
  }
}

/**
 * Marks one cumulative checkpoint complete and cursor-free.
 *
 * @param checkpoint - Current checkpoint.
 * @returns Detached terminal checkpoint.
 */
function completeCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
): MigrationSourceCheckpoint {
  return {
    completed: true,
    aggregate: {
      ...checkpoint.aggregate,
      pageCount: Math.max(1, checkpoint.aggregate.pageCount),
    },
    keyDigestState:
      structuredClone(checkpoint.keyDigestState),
    contentDigestState:
      structuredClone(checkpoint.contentDigestState),
  }
}

/**
 * Creates or advances one fake verification state.
 *
 * @param fixture - Static supervisor fixture.
 * @param current - Existing progress, absent before the first page.
 * @param location - Location completed by the page.
 * @returns Direct verification revision successor.
 */
function createVerificationSuccessor(
  fixture: SupervisorFixture,
  current:
    WorkspaceSearchMigrationFullVerificationPersistenceState | undefined,
  location: WorkspaceSearchMigrationCheckpointLocation,
): WorkspaceSearchMigrationFullVerificationPersistenceState {
  const revision = (current?.revision ?? 0) + 1
  const traversal = current === undefined
    ? createEmptyWorkspaceSearchMigrationTraversal()
    : decodeVerificationTraversal(current)
  if (location === 'target') {
    traversal.target = completeCheckpoint(traversal.target)
  } else {
    traversal.sources = {
      ...traversal.sources,
      [location]: completeCheckpoint(
        traversal.sources[location],
      ),
    }
  }
  return createVerificationState(
    fixture,
    revision,
    false,
    traversal,
  )
}

/**
 * Creates one complete typed verification persistence state.
 *
 * @param fixture - Static supervisor fixture.
 * @param revision - Positive verification revision.
 * @param terminal - Whether every location is complete.
 * @param traversalOverride - Optional already-advanced traversal.
 * @returns Fake state containing every public persistence property.
 */
function createVerificationState(
  fixture: SupervisorFixture,
  revision: number,
  terminal = false,
  traversalOverride?:
    WorkspaceSearchMigrationRunState['apply'],
): WorkspaceSearchMigrationFullVerificationPersistenceState {
  const rawTraversal = terminal
    ? completeTraversal(
        createEmptyWorkspaceSearchMigrationTraversal(),
      )
    : structuredClone(
        traversalOverride ??
          createEmptyWorkspaceSearchMigrationTraversal(),
      )
  const traversal = encodeVerificationTraversal(rawTraversal)
  const progress = {
    kind: 'workspace-search-migration-full-verification-progress',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    planDigest: fixture.replay.planSeal.planDigest,
    verificationPlanDigest: digest('verification-plan'),
    traversal,
    sourceBindings: createSourceDigestStates(),
    targetPresentBindings: emptyDigestState(),
  } satisfies WorkspaceSearchMigrationFullVerificationPersistenceState[
    'progress'
  ]
  return {
    kind: 'workspace-search-migration-full-verification-state',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    tableIds:
      structuredClone(
        fixture.sealedPlanningAuthority.tableIds,
      ),
    planDigest: fixture.replay.planSeal.planDigest,
    planArtifactBindingDigest: digest('verification-binding'),
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
    appliedRootDigest: digest('applied-root'),
    verificationPlanDigest: digest('verification-plan'),
    revision,
    predecessorKind:
      revision === 1 ? 'applied-root' : 'verification-state',
    predecessorDigest: digest(`verification-predecessor:${revision}`),
    lastCommandDigest: digest(`verification-command:${revision}`),
    progress,
    progressDigest: createMigrationDigest(progress),
    stateDigest: digest(`verification-state:${revision}`),
  }
}

/**
 * Restores a mutable traversal from the JSON-safe fake snapshot.
 *
 * @param state - Current fake verification state.
 * @returns Detached traversal without checkpoint cursors.
 */
function decodeVerificationTraversal(
  state: WorkspaceSearchMigrationFullVerificationPersistenceState,
): WorkspaceSearchMigrationRunState['apply'] {
  return {
    sources: {
      'project-directory':
        decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
        state.progress.traversal.sources['project-directory'],
      ),
      'work-items':
        decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
        state.progress.traversal.sources['work-items'],
      ),
      collaboration:
        decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
        state.progress.traversal.sources.collaboration,
      ),
      documents:
        decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
        state.progress.traversal.sources.documents,
      ),
    },
    target:
      decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
      state.progress.traversal.target,
    ),
  }
}

/**
 * Encodes a pure traversal into the durable JSON-safe checkpoint form.
 *
 * @param traversal - Pure in-memory source and target traversal.
 * @returns Tagged persistence traversal snapshot.
 */
function encodeVerificationTraversal(
  traversal: WorkspaceSearchMigrationRunState['apply'],
): WorkspaceSearchMigrationFullVerificationTraversalSnapshot {
  return {
    sources: {
      'project-directory':
        createWorkspaceSearchMigrationApplyCheckpointSnapshot(
          traversal.sources['project-directory'],
        ),
      'work-items':
        createWorkspaceSearchMigrationApplyCheckpointSnapshot(
          traversal.sources['work-items'],
        ),
      collaboration:
        createWorkspaceSearchMigrationApplyCheckpointSnapshot(
          traversal.sources.collaboration,
        ),
      documents:
        createWorkspaceSearchMigrationApplyCheckpointSnapshot(
          traversal.sources.documents,
        ),
    },
    target:
      createWorkspaceSearchMigrationApplyCheckpointSnapshot(
        traversal.target,
      ),
  }
}

/**
 * Creates one fake immutable verified root.
 *
 * @param fixture - Static supervisor fixture.
 * @param terminalState - Terminal verification state.
 * @returns Complete typed root used only for phase presence.
 */
function createVerifiedRoot(
  fixture: SupervisorFixture,
  terminalState: WorkspaceSearchMigrationFullVerificationPersistenceState,
): WorkspaceSearchMigrationFullVerificationVerifiedRoot {
  const reference:
    WorkspaceSearchMigrationFullVerificationResultArtifactReference = {
    kind:
      'workspace-search-migration-verification-result-artifact-reference',
    artifactVersion: 1,
    runId,
    configurationHash: fixture.configurationHash,
    appliedRootDigest: digest('applied-root'),
    verificationResultDigest: digest('verification-result'),
    envelopeDigest: digest('verification-result-envelope'),
    objectKey: 'workspace-search/v1/verification-result.artifact',
    versionId: 'verification-result-version-1',
    contentDigest: digest('verification-result-content'),
    byteLength: 1,
    retainUntil,
  }
  return {
    kind:
      'workspace-search-migration-full-verification-verified-root',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    tableIds:
      structuredClone(
        fixture.sealedPlanningAuthority.tableIds,
      ),
    planDigest: fixture.replay.planSeal.planDigest,
    verificationPlanDigest: digest('verification-plan'),
    appliedRootDigest: digest('applied-root'),
    verificationResultDigest: digest('verification-result'),
    verificationResultReference: reference,
    terminalStateDigest: terminalState.stateDigest,
    terminalReceiptDigest: digest('verification-terminal-receipt'),
    terminalReceiptCommittedAt: evaluatedAt,
    planArtifactBinding: {
      kind:
        'workspace-search-migration-full-verification-plan-artifact-binding',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId,
      configurationHash: fixture.configurationHash,
      planDigest: fixture.replay.planSeal.planDigest,
      verificationPlanDigest: digest('verification-plan'),
      sealedPlanningAuthorityDigest:
        fixture.sealedPlanningAuthority.authorityDigest,
      planSealReference:
        structuredClone(
          fixture.sealedPlanningAuthority.planSealReference,
        ),
      planManifestHeadReference:
        structuredClone(
          fixture.sealedPlanningAuthority
            .planManifestHeadReference,
        ),
      bindingDigest: digest('verification-binding'),
    },
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
    publicationAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 13,
      maintenanceEvidenceReceiptDigest:
        fixture.initialAuthority
          .maintenanceEvidenceReceiptDigest,
      evaluatedAt,
    },
    verifiedAt: evaluatedAt,
    verifiedRootDigest: digest('verified-root'),
  }
}

/**
 * Creates source-indexed empty digest accumulators.
 *
 * @returns Exact four-source digest state record.
 */
function createSourceDigestStates(): Readonly<
  Record<WorkspaceSearchMigrationSourceName, MigrationDigestState>
> {
  return {
    'project-directory': emptyDigestState(),
    'work-items': emptyDigestState(),
    collaboration: emptyDigestState(),
    documents: emptyDigestState(),
  }
}

/**
 * Creates one empty order-independent digest accumulator.
 *
 * @returns Zero-count digest state.
 */
function emptyDigestState(): MigrationDigestState {
  return {
    count: 0,
    sumHex: '0'.repeat(64),
    xorHex: '0'.repeat(64),
  }
}

/**
 * Creates one committed-prefix rollback lifecycle.
 *
 * @param fixture - Static supervisor fixture.
 * @param runState - Applying committed-prefix state.
 * @param terminal - Whether terminal state and root are present.
 * @returns Complete lifecycle snapshot.
 */
function createPartialRollbackLifecycle(
  fixture: SupervisorFixture,
  runState: WorkspaceSearchMigrationRunState,
  terminal: boolean,
): WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot {
  const state = createPartialRollbackState(
    fixture,
    runState,
    terminal ? 'rolled-back' : 'rolling-back',
    terminal ? 0 : 1,
    terminal ? 3 : 1,
  )
  const startRoot = createPartialRollbackStartRoot(
    fixture,
    state,
  )
  return {
    startRoot,
    state,
    ...(terminal
      ? {
          rolledBackRoot: createPartialRolledBackRoot(
            fixture,
            state,
          ),
        }
      : {}),
  }
}

/**
 * Creates one complete typed committed-prefix rollback state.
 *
 * @param fixture - Static supervisor fixture.
 * @param runState - Applying predecessor state.
 * @param status - Rolling or terminal status.
 * @param nextSequence - Next reverse journal sequence.
 * @param revision - Exact rollback revision.
 * @returns Complete fake v2 rollback state.
 */
function createPartialRollbackState(
  fixture: SupervisorFixture,
  runState: WorkspaceSearchMigrationRunState,
  status: 'rolled-back' | 'rolling-back',
  nextSequence: number,
  revision: number,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  const terminalRunState: WorkspaceSearchMigrationRunState =
    status === 'rolled-back'
    ? {
        ...structuredClone(runState),
        status: 'rolled-back',
        rollback: {
          upperBoundSequence: 1,
          nextSequence: 0,
          expectedHeadDigest: '0'.repeat(64),
          restored: 1,
        },
      }
    : {
        ...structuredClone(runState),
        status: 'rolling-back',
        rollback: {
          upperBoundSequence: 1,
          nextSequence,
          expectedHeadDigest: nextSequence === 0
            ? '0'.repeat(64)
            : digest('journal-head'),
          restored: nextSequence === 0 ? 1 : 0,
        },
      }
  return {
    kind: 'workspace-search-migration-rollback-state',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    tableIds:
      structuredClone(
        fixture.sealedPlanningAuthority.tableIds,
      ),
    executionRunDigest:
      fixture.executionRun.executionRunDigest,
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
    originDigest: digest('partial-origin'),
    startRootDigest: digest('partial-start-root'),
    currentAuthority: createRollbackAuthority(
      fixture.initialAuthority,
    ),
    status,
    revision,
    predecessorKind:
      revision === 1
        ? 'committed-prefix-origin'
        : 'rollback-state',
    predecessorDigest: digest(
      `partial-predecessor:${revision}`,
    ),
    upperBoundSequence: 1,
    nextSequence,
    expectedHeadDigest: nextSequence === 0
      ? '0'.repeat(64)
      : digest('journal-head'),
    restored: nextSequence === 0 ? 1 : 0,
    lastRollbackReceiptDigest:
      nextSequence === 0 ? digest('partial-receipt') : null,
    runState: terminalRunState,
    runStateDigest: createMigrationDigest(terminalRunState),
    stateDigest: digest(`partial-state:${revision}:${status}`),
  }
}

/**
 * Creates the immutable start root carried by a partial lifecycle.
 *
 * @param fixture - Static supervisor fixture.
 * @param initialState - Initial or later fake lifecycle state.
 * @returns Complete typed v2 start root.
 */
function createPartialRollbackStartRoot(
  fixture: SupervisorFixture,
  initialState: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  const origin = createPartialRollbackOrigin(fixture)
  return {
    kind: 'workspace-search-migration-rollback-start-root',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    tableIds:
      structuredClone(
        fixture.sealedPlanningAuthority.tableIds,
      ),
    executionRunDigest:
      fixture.executionRun.executionRunDigest,
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
    origin,
    originDigest: origin.originDigest,
    predecessorRevision: 2,
    predecessorDigest: digest('partial-predecessor'),
    predecessorRunStateDigest:
      createMigrationDigest(initialState.runState),
    originalJournalSequence: 1,
    originalJournalHeadDigest: digest('journal-head'),
    currentAuthority: createRollbackAuthority(
      fixture.initialAuthority,
    ),
    startedAt: evaluatedAt,
    initialState,
    initialStateDigest: initialState.stateDigest,
    initialRunStateDigest: initialState.runStateDigest,
    startRootDigest: digest('partial-start-root'),
  }
}

/**
 * Creates one committed-prefix rollback origin.
 *
 * @param fixture - Static supervisor fixture.
 * @returns Complete typed nested origin.
 */
function createPartialRollbackOrigin(
  fixture: SupervisorFixture,
): WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2 {
  const seal = createApplySeal(
    fixture,
    'committed-prefix',
  )
  return {
    kind:
      'workspace-search-migration-committed-prefix-rollback-origin',
    originVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    executionRunDigest:
      fixture.executionRun.executionRunDigest,
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
    planDigest: fixture.replay.planSeal.planDigest,
    planOperationCount: 1,
    planSealReference:
      structuredClone(
        fixture.executionRun.binding.planSealReference,
      ),
    minimumJournalRetainUntil: retainUntil,
    predecessor: {
      kind: 'execution-run-admission',
      revision: 1,
      predecessorDigest:
        fixture.executionRun.executionRunDigest,
      predecessorRunStateDigest:
        fixture.executionRun.stateDigest,
    },
    seal,
    sealReference: {
      scope: 'committed-prefix',
      objectKey:
        'workspace-search/v1/partial-apply-seal.artifact',
      versionId: 'partial-apply-seal-version-1',
      contentDigest: createMigrationDigest(seal),
      byteLength: 1,
      retainUntil,
    },
    originDigest: digest('partial-origin'),
  }
}

/**
 * Creates one immutable committed-prefix rollback terminal root.
 *
 * @param fixture - Static supervisor fixture.
 * @param state - Terminal v2 rollback state.
 * @returns Complete typed v2 terminal root.
 */
function createPartialRolledBackRoot(
  fixture: SupervisorFixture,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): WorkspaceSearchMigrationRolledBackRootV2 {
  return {
    kind: 'workspace-search-migration-rolled-back-root',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    tableIds:
      structuredClone(
        fixture.sealedPlanningAuthority.tableIds,
      ),
    executionRunDigest:
      fixture.executionRun.executionRunDigest,
    originDigest: digest('partial-origin'),
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
    startRootDigest: digest('partial-start-root'),
    terminalState: state,
    terminalStateDigest: state.stateDigest,
    terminalReceipt: null,
    terminalReceiptDigest: null,
    finalRunStateDigest: state.runStateDigest,
    finalAuthority: createRollbackAuthority(
      fixture.initialAuthority,
    ),
    rollbackStartedAt: evaluatedAt,
    finishedAt: evaluatedAt,
    rootDigest: digest('partial-rolled-back-root'),
  }
}

/**
 * Creates one complete-plan rollback state.
 *
 * @param fixture - Static supervisor fixture.
 * @param runState - Applied predecessor state.
 * @param status - Rolling or terminal status.
 * @param nextSequence - Next reverse journal sequence.
 * @param revision - Exact rollback revision.
 * @returns Complete typed rollback state.
 */
function createCompleteRollbackState(
  fixture: SupervisorFixture,
  runState: WorkspaceSearchMigrationRunState,
  status: 'rolled-back' | 'rolling-back',
  nextSequence: number,
  revision: number,
): WorkspaceSearchMigrationRollbackPersistenceState {
  const terminalRunState = {
    ...structuredClone(runState),
    status,
    rollback: {
      upperBoundSequence: 1,
      nextSequence,
      expectedHeadDigest: nextSequence === 0
        ? '0'.repeat(64)
        : digest('journal-head'),
      restored: nextSequence === 0 ? 1 : 0,
    },
  } satisfies WorkspaceSearchMigrationRunState
  return {
    kind: 'workspace-search-migration-rollback-state',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    tableIds:
      structuredClone(
        fixture.sealedPlanningAuthority.tableIds,
      ),
    executionRunDigest:
      fixture.executionRun.executionRunDigest,
    appliedRootDigest: digest('applied-root'),
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
    startRootDigest: digest('complete-start-root'),
    currentAuthority: createRollbackAuthority(
      fixture.initialAuthority,
    ),
    status,
    revision,
    predecessorKind:
      revision === 1 ? 'applied-root' : 'rollback-state',
    predecessorDigest: digest(
      `complete-predecessor:${revision}`,
    ),
    upperBoundSequence: 1,
    nextSequence,
    expectedHeadDigest: nextSequence === 0
      ? '0'.repeat(64)
      : digest('journal-head'),
    restored: nextSequence === 0 ? 1 : 0,
    lastRollbackReceiptDigest:
      nextSequence === 0 ? digest('complete-receipt') : null,
    runState: terminalRunState,
    runStateDigest: createMigrationDigest(terminalRunState),
    stateDigest: digest(`complete-state:${revision}:${status}`),
  }
}

/**
 * Creates one immutable complete-plan rollback terminal root.
 *
 * @param fixture - Static supervisor fixture.
 * @param state - Terminal rollback state.
 * @returns Complete typed terminal root.
 */
function createCompleteRolledBackRoot(
  fixture: SupervisorFixture,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
): WorkspaceSearchMigrationRolledBackRoot {
  return {
    kind: 'workspace-search-migration-rolled-back-root',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    tableIds:
      structuredClone(
        fixture.sealedPlanningAuthority.tableIds,
      ),
    executionRunDigest:
      fixture.executionRun.executionRunDigest,
    appliedRootDigest: digest('applied-root'),
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
    startRootDigest: digest('complete-start-root'),
    terminalState: state,
    terminalStateDigest: state.stateDigest,
    terminalReceipt: null,
    terminalReceiptDigest: null,
    finalRunStateDigest: state.runStateDigest,
    finalAuthority: createRollbackAuthority(
      fixture.initialAuthority,
    ),
    rollbackStartedAt: evaluatedAt,
    finishedAt: evaluatedAt,
    rootDigest: digest('complete-rolled-back-root'),
  }
}

/**
 * Projects fresh authority into rollback persistence authority.
 *
 * @param authority - Fresh exact authority.
 * @returns Compact rollback authority binding.
 */
function createRollbackAuthority(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
) {
  return {
    ownerId: authority.lease.ownerId,
    fenceToken: authority.lease.fenceToken,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
    evaluatedAt: authority.evaluatedAt,
  }
}

/**
 * Creates a pure apply seal for fake rollback roots.
 *
 * @param fixture - Static supervisor fixture.
 * @param scope - Complete plan or committed prefix.
 * @returns Complete typed pure seal.
 */
function createApplySeal(
  fixture: SupervisorFixture,
  scope: 'committed-prefix' | 'complete-plan',
): WorkspaceSearchApplySeal {
  return {
    kind: 'workspace-search-apply-seal',
    sealVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: fixture.configurationHash,
    scope,
    planDigest: fixture.replay.planSeal.planDigest,
    planOperationCount: 1,
    journalSequence: 1,
    journalHeadDigest: digest('journal-head'),
    markerCount: 1,
    applyMarkerAggregateDigest: digest('marker-aggregate'),
    createdAt: evaluatedAt,
  }
}

/**
 * Creates one compact internally correlated supervisor fixture.
 *
 * @returns Measured roots, one-operation replay, and admission.
 */
function createSupervisorFixture(): SupervisorFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const tableIds = createTableIds(configuration)
  const writerFence =
    createWorkspaceSearchWriterFenceBinding({
      stateTableName:
        configuration.tables['migration-state'].tableName,
      stateTableId:
        configuration.tables['migration-state'].tableId,
      stateIncarnationDigest:
        createWorkspaceSearchWriterFenceStateIncarnationDigest({
          role: 'migration-state',
          tableName:
            configuration.tables['migration-state'].tableName,
          tableArn:
            configuration.tables['migration-state'].tableArn,
          tableId:
            configuration.tables['migration-state'].tableId,
          creationTime:
            configuration.tables['migration-state'].creationTime,
          account:
            configuration.tables['migration-state'].account,
          region:
            configuration.tables['migration-state'].region,
        }),
      tableIds,
    })
  const open =
    createWorkspaceSearchWriterFenceInitialOpenRecord(
      writerFence,
      new Date('2026-07-29T00:30:00.000Z'),
    )
  const closedWriterFenceRecord =
    createWorkspaceSearchWriterFenceClosedSuccessor(
      open,
      {
        configurationHash,
        runId,
        ownerId,
        leaseFenceToken: 7,
        maintenanceEvidenceReceiptDigest:
          digest('close-maintenance-receipt'),
        maintenanceEvidencePointerRevision: 11,
      },
      new Date(closedAt),
    )
  const planningReceipt =
    createMaintenanceReceipt(7, 12)
  const boundary = createBoundary(
    configurationHash,
    tableIds,
    closedWriterFenceRecord,
    createMigrationDigest(planningReceipt),
  )
  const plannedOperation = createPlannedOperation(
    configuration,
    configurationHash,
  )
  const planSeal = createPlanSeal(
    configurationHash,
    plannedOperation.planDigest,
  )
  const sealedPlanningAuthority = createSealedAuthority(
    configurationHash,
    tableIds,
    planSeal,
    createMigrationDigest(planningReceipt),
  )
  const initialAuthority = createAuthorityFromParts(
    configuration,
    configurationHash,
    7,
    ownerId,
    13,
  )
  const executionRun =
    createWorkspaceSearchMigrationExecutionRun({
      executionBoundary: boundary,
      sealedPlanningAuthority,
      planSeal,
      configuration,
      configurationHash,
      currentAuthority: initialAuthority,
      createdAt: evaluatedAt,
    })
  return {
    configuration,
    configurationHash,
    closedWriterFenceRecord,
    boundary,
    sealedPlanningAuthority,
    replay: {
      planSeal,
      manifestHead: {
        kind:
          'workspace-search-migration-plan-manifest-head',
        artifactVersion: 1,
        migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
        migrationVersion:
          WORKSPACE_SEARCH_MIGRATION_VERSION,
        runId,
        configurationHash,
        planDigest: planSeal.planDigest,
        planSealContentDigest: digest('plan-seal-content'),
        planOperationCount: 1,
        planSegmentCount: 1,
        manifestPageCount: 1,
        terminalSegmentReference: {
          objectKey:
            'workspace-search/v1/plan-segment.artifact',
          versionId: 'plan-segment-version-1',
          contentDigest: digest('plan-segment'),
          byteLength: 1,
          retainUntil,
        },
        terminalManifestPageReference: {
          objectKey:
            'workspace-search/v1/plan-manifest.artifact',
          versionId: 'plan-manifest-version-1',
          contentDigest: digest('plan-manifest-page'),
          byteLength: 1,
          retainUntil,
        },
      },
      operations: [plannedOperation],
    },
    executionRun,
    initialAuthority,
  }
}

/**
 * Creates one exact planning-admitted execution boundary.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - Exact six-table incarnations.
 * @param closedWriterFenceRecord - Exact closed writer fence.
 * @param receiptDigest - Planning admission receipt digest.
 * @returns Revision-two planning boundary.
 */
function createBoundary(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord,
  receiptDigest: string,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  const fields = {
    kind: 'workspace-search-migration-execution-boundary',
    boundaryVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds,
    closedWriterFenceRecordDigest:
      closedWriterFenceRecord.recordDigest,
    closedAt,
    closeAuthority: {
      configurationHash,
      runId,
      ownerId,
      leaseFenceToken: 7,
      maintenanceEvidenceReceiptDigest:
        digest('close-maintenance-receipt'),
      maintenanceEvidencePointerRevision: 11,
    },
    phase: 'planning-admitted',
    revision: 2,
    planningAdmission: {
      ownerId,
      leaseFenceToken: 7,
      maintenanceEvidenceReceiptDigest: receiptDigest,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceDigest:
        digest('planning-maintenance-evidence'),
      maintenanceEvidenceLocator:
        'workspace-search/v1/maintenance/planning.json',
      runtimeRevision: 41,
      drainStartedAt: closedAt,
      drainCompletedAt: admittedAt,
      admittedAt,
    },
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    'boundaryDigest'
  >
  return {
    ...fields,
    boundaryDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates one strict one-operation plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param planDigest - Exact one-leaf plan root.
 * @returns Exact canonical plan seal.
 */
function createPlanSeal(
  configurationHash: string,
  planDigest: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest,
    planOperationCount: 1,
    sourceOperationCount: 0,
    orphanOperationCount: 1,
    createdAt: planCreatedAt,
  }
}

/**
 * Creates one strict compact sealed planning authority.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - Exact six-table incarnation binding.
 * @param planSeal - Exact referenced plan seal.
 * @param receiptDigest - Planning receipt selected by the root.
 * @returns Complete version-two sealed authority.
 */
function createSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const fields = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds,
    planSealReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealDigest}.artifact`,
      versionId: 'plan-seal-version-1',
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${digest('plan-manifest')}.artifact`,
      versionId: 'plan-manifest-version-1',
      contentDigest: digest('plan-manifest'),
      byteLength: 1,
      retainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
          `workspace-search/v1/planning-provenance-artifacts/v1/${runId}/${configurationHash}`,
          'manifest-heads',
          digest('provenance-manifest'),
        ),
      versionId: 'provenance-manifest-version-1',
      contentDigest: digest('provenance-manifest'),
      byteLength: 1,
      retainUntil,
    },
    planDigest: planSeal.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: planSeal.sourceOperationCount,
    orphanOperationCount: planSeal.orphanOperationCount,
    planOperationCount: planSeal.planOperationCount,
    planningAuthorityProvenanceDigest:
      digest('planning-authority-provenance'),
    historicalReceiptBindingDigest:
      digest('historical-receipt-binding'),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createEvidenceHead('project-directory'),
      createEvidenceHead('work-items'),
      createEvidenceHead('collaboration'),
      createEvidenceHead('documents'),
      createEvidenceHead('workspace-search'),
    ],
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest: receiptDigest,
    },
    sealedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    'authorityDigest'
  >
  return {
    ...fields,
    authorityDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates one compact terminal planning evidence head.
 *
 * @param chain - Canonical source or target evidence role.
 * @returns Exact terminal head.
 */
function createEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
) {
  return {
    chain,
    progressDigest: digest(`progress:${chain}`),
    pageCount: 1,
    terminalEvidenceDigest: digest(`evidence:${chain}`),
    terminalCheckpointDigest: digest(`checkpoint:${chain}`),
  }
}

/**
 * Creates one type-complete planned orphan deletion.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @returns One-based sealed plan entry.
 */
function createPlannedOperation(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): WorkspaceSearchPlannedOperation {
  const planDigest = digest('one-operation-plan')
  const operation = {
    operationId: 'execution-supervisor-operation',
    sourceCondition: {
      exists: false,
      source: 'project-directory',
      tableId:
        configuration.tables['project-directory'].tableId,
      tableName:
        configuration.tables['project-directory'].tableName,
      key: {
        directoryId: { S: 'supervisor-directory' },
      },
      keyDigest: digest('source-key'),
    },
    targetKey: {
      workspaceId: { S: 'supervisor-workspace' },
      recordKey: { S: 'project#supervisor-project' },
    },
    targetKeyDigest: digest('target-key'),
    before: {
      exists: true,
      item: {
        workspaceId: { S: 'supervisor-workspace' },
        recordKey: { S: 'project#supervisor-project' },
      },
      digest: digest('target-before'),
    },
    after: createWorkspaceSearchMigrationAbsentSnapshot(),
    entityType: 'project',
  } satisfies WorkspaceSearchPlannedOperation['operation']
  return {
    runId,
    configurationHash,
    planDigest,
    planSequence: 1,
    operationDigest: createMigrationDigest(operation),
    membershipProof: [],
    operation,
  }
}

/**
 * Creates fresh authority for one lease generation.
 *
 * @param fixture - Static fixture whose measured state table is bound.
 * @param fenceToken - Current lease fence.
 * @param selectedOwnerId - Current process owner.
 * @param pointerRevision - Current maintenance pointer revision.
 * @returns Exact fresh authority.
 */
function createAuthority(
  fixture: SupervisorFixture,
  fenceToken: number,
  selectedOwnerId: string,
  pointerRevision: number,
): WorkspaceSearchMigrationPrePlanAuthority {
  return createAuthorityFromParts(
    fixture.configuration,
    fixture.configurationHash,
    fenceToken,
    selectedOwnerId,
    pointerRevision,
  )
}

/**
 * Creates fresh authority from measured configuration parts.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param fenceToken - Current lease fence.
 * @param selectedOwnerId - Current process owner.
 * @param pointerRevision - Current maintenance pointer revision.
 * @returns Exact fresh authority.
 */
function createAuthorityFromParts(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  fenceToken: number,
  selectedOwnerId: string,
  pointerRevision: number,
): WorkspaceSearchMigrationPrePlanAuthority {
  const receipt =
    createMaintenanceReceipt(fenceToken, pointerRevision)
  return {
    configurationHash,
    stateTableId:
      configuration.tables['migration-state'].tableId,
    lease: createLease(fenceToken, selectedOwnerId),
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(receipt),
    maintenanceEvidencePointerRevision: pointerRevision,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt,
  }
}

/**
 * Creates one valid sixty-second supervised lease.
 *
 * @param fenceToken - Current monotonic fence.
 * @param selectedOwnerId - Current process owner.
 * @returns Fresh exact lease.
 */
function createLease(
  fenceToken: number,
  selectedOwnerId: string,
): WorkspaceSearchMigrationLease {
  return {
    runId,
    ownerId: selectedOwnerId,
    fenceToken,
    heartbeatAt: evaluatedAt,
    expiresAt: '2026-07-29T01:20:30.000Z',
  }
}

/**
 * Creates one fresh exact maintenance receipt.
 *
 * @param fenceToken - Lease fence bound to evidence.
 * @param pointerRevision - Pointer revision used to vary evidence identity.
 * @returns Fresh receipt with commit headroom.
 */
function createMaintenanceReceipt(
  fenceToken: number,
  pointerRevision: number,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest(
      `maintenance:${fenceToken}:${pointerRevision}`,
    ),
    evidenceLocator:
      `change:OPS-${fenceToken}${pointerRevision}`,
    runtimeRevision: 41 + pointerRevision,
    fenceToken,
    validatedAt: evaluatedAt,
    oldestObservationAt: evaluatedAt,
    validUntil: '2026-07-29T01:24:30.001Z',
  }
}

/**
 * Creates one immutable receipt whose exact five-minute window expired.
 *
 * @param fenceToken - Lease fence selected by the stale pointer.
 * @returns Strict expired historical receipt.
 */
function createExpiredMaintenanceReceipt(
  fenceToken: number,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest(
      `expired-maintenance:${fenceToken}`,
    ),
    evidenceLocator:
      `change:OPS-expired-${fenceToken}`,
    runtimeRevision: 40,
    fenceToken,
    validatedAt: '2026-07-29T01:18:00.000Z',
    oldestObservationAt: '2026-07-29T01:14:00.000Z',
    validUntil: '2026-07-29T01:19:00.001Z',
  }
}

/**
 * Creates canonical post-close zero-writer evidence.
 *
 * @returns Exact canonical evidence bytes.
 */
function createMaintenanceEvidenceBytes(): Uint8Array {
  const evidence: WorkspaceSearchMaintenanceEvidence = {
    schemaVersion: 1,
    locator: 'change:OPS-155',
    runtimeMode: 'disabled',
    runtimeRevision: 91,
    drainStartedAt: '2026-07-29T01:02:00.000Z',
    drainCompletedAt: '2026-07-29T01:18:00.000Z',
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map(
      (surface) => ({
        surface,
        mode: 'disabled',
        status: 'current',
        revision: 91,
        observedAt: '2026-07-29T01:18:00.000Z',
      }),
    ),
  }
  return new TextEncoder().encode(
    serializeCanonicalJson(evidence),
  )
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable measured six-table configuration.
 */
function createConfiguration():
WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory':
        createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search':
        createSupportingTable('workspace-search'),
      'migration-state':
        createSupportingTable('migration-state'),
    },
    journal: {
      bucketName:
        'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-29T00:00:00.000Z',
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

/**
 * Creates one measured source table.
 *
 * @param role - Logical source role.
 * @returns Complete source table identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(
    role,
    sourceKeyDescriptors(role),
  )
}

/**
 * Creates one measured supporting table.
 *
 * @param role - Workspace Search or migration-state role.
 * @returns Complete supporting table identity.
 */
function createSupportingTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    [
      {
        name: role === 'migration-state'
          ? 'migrationId'
          : 'workspaceId',
        role: 'HASH',
        type: 'S',
      },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ],
  )
}

/**
 * Creates one complete measured table identity.
 *
 * @param role - Stable migration table role.
 * @param key - Exact key schema.
 * @returns Complete measured table.
 */
function createTable(
  role:
    | WorkspaceSearchMigrationSourceName
    | 'migration-state'
    | 'workspace-search',
  key: readonly MigrationKeyAttribute[],
): MigrationTableIdentity {
  const tableName = `supervisor-${role}`
  return {
    role,
    tableName,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${tableName}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-07-29T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: role === 'migration-state'
      ? { status: 'ENABLED', attribute: 'expiresAt' }
      : { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime:
        '2026-07-01T00:00:00.000Z',
      latestRestorableTime:
        '2026-07-29T01:15:00.000Z',
    },
  }
}

/**
 * Returns the exact source key schema for one logical role.
 *
 * @param role - Logical source role.
 * @returns Ordered HASH/RANGE descriptors.
 */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'projectId', role: 'RANGE', type: 'S' },
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

/**
 * Projects measured tables into the immutable role-indexed TableIds.
 *
 * @param configuration - Exact measured configuration.
 * @returns Complete six-role binding.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items':
      configuration.tables['work-items'].tableId,
    collaboration:
      configuration.tables.collaboration.tableId,
    documents:
      configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Creates a deterministic lowercase SHA-256 digest.
 *
 * @param value - Stable fixture label.
 * @returns Hex digest.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Digests exact bytes without text conversion.
 *
 * @param value - Exact byte sequence.
 * @returns Hex digest.
 */
function digestBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
