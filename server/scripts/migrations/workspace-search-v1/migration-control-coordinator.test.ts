import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceReleasedOpenSuccessor,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  type WorkspaceSearchWriterFenceObservation,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  advanceWorkspaceSearchMigrationControlStage,
  readWorkspaceSearchMigrationControlExecutionStatus,
  workspaceSearchMigrationControlApprovalLiterals,
  type WorkspaceSearchMigrationControlCoordinatorDependencies,
  type WorkspaceSearchMigrationControlExecutionStatusDependencies,
} from './migration-control-coordinator'
import {
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationExecutionStatus,
} from './migration-execution-supervisor'
import {
  superviseWorkspaceSearchMigrationExecution,
} from './migration-execution-supervisor'
import {
  WorkspaceSearchMigrationHeartbeatInterruptedError,
} from './migration-heartbeat-supervisor'
import {
  maintenanceRuntimeControlSurfaces,
  type WorkspaceSearchMaintenanceEvidence,
} from './maintenance-evidence'

const runId = 'control-coordinator-run'
const ownerId = 'control-coordinator-owner'
const differentOwnerId = 'control-coordinator-owner-restarted'
const retainedUntil = '2026-09-01T00:00:00.000Z'

/** Combined test-only dependency surface for mutation and status recording. */
type RecordingCoordinatorDependencies =
  WorkspaceSearchMigrationControlCoordinatorDependencies &
  WorkspaceSearchMigrationControlExecutionStatusDependencies

/** Terminal writer-fence identity emitted by the real coordinator harness. */
type RealCoordinatorTerminalOutcome =
  | {
      /** Verified terminal branch fixed by the immutable execution graph. */
      readonly kind: 'verified'
      /** Verified-root persistence generation. */
      readonly persistenceVersion: 1
      /** Exact verified root digest. */
      readonly rootDigest: string
    }
  | {
      /** Rolled-back terminal branch fixed by the immutable execution graph. */
      readonly kind: 'rolled-back'
      /** Complete-plan or committed-prefix persistence generation. */
      readonly persistenceVersion: 1 | 2
      /** Exact rolled-back root digest. */
      readonly rootDigest: string
    }

/**
 * Creates injectable existing-supervisor boundaries that record dispatch only.
 *
 * @param events - Shared ordered event recorder.
 * @returns Fully typed coordinator dependencies.
 */
function createRecordingDependencies(
  events: string[],
): RecordingCoordinatorDependencies {
  return {
    supervisePostClosePlanning: async (input) => {
      events.push(
        `planning:${input.runId}:${input.ownerId}`,
      )
    },
    readExecutionStatus: async (input) => {
      events.push(`status:${input.runId}`)
      return {
        phase: 'applying',
        nextAction: {
          kind: 'choose',
          options: ['apply', 'partial-rollback'],
        },
      }
    },
    superviseExecution: async (input) => {
      events.push(
        `execution:${input.mode}:${input.runId}:${input.ownerId}`,
      )
      if (input.mode === 'apply') {
        return {
          phase: 'applied',
          nextAction: {
            kind: 'choose',
            options: ['verify', 'complete-rollback'],
          },
        }
      }
      if (input.mode === 'verify') {
        return {
          phase: 'verified',
          nextAction: { kind: 'none' },
        }
      }
      return {
        phase: 'rolled-back',
        nextAction: { kind: 'none' },
      }
    },
    releaseTerminal: async (input) => {
      events.push(`release:${input.runId}:${input.ownerId}`)
    },
  }
}

/**
 * Invokes the runtime coordinator with an intentionally untrusted input shape.
 *
 * @param input - Candidate JavaScript boundary value.
 * @param dependencies - Typed injected existing-supervisor boundaries.
 * @returns Unknown runtime result for structural assertions.
 */
async function invokeCoordinator(
  input: unknown,
  dependencies?: WorkspaceSearchMigrationControlCoordinatorDependencies,
): Promise<unknown> {
  const arguments_: readonly unknown[] = dependencies === undefined
    ? [input]
    : [input, dependencies]
  const result: unknown = Reflect.apply(
    advanceWorkspaceSearchMigrationControlStage,
    undefined,
    arguments_,
  )
  return Promise.resolve(result)
}

/**
 * Invokes the read-only status boundary with an untrusted session placeholder.
 *
 * @param input - Candidate JavaScript status request.
 * @param dependencies - Typed injected existing-supervisor boundaries.
 * @returns Unknown runtime status result.
 */
async function invokeExecutionStatus(
  input: unknown,
  dependencies?:
    WorkspaceSearchMigrationControlExecutionStatusDependencies,
): Promise<unknown> {
  const arguments_: readonly unknown[] = dependencies === undefined
    ? [input]
    : [input, dependencies]
  const result: unknown = Reflect.apply(
    readWorkspaceSearchMigrationControlExecutionStatus,
    undefined,
    arguments_,
  )
  return Promise.resolve(result)
}

/**
 * Captures one rejected async coordinator invocation.
 *
 * @param operation - Invocation expected to reject.
 * @returns Exact thrown Error.
 */
async function captureError(
  operation: () => Promise<unknown>,
): Promise<Error> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof Error) return error
  }
  throw new Error('Expected coordinator failure.')
}

/**
 * Durable phase retained across independently invoked coordinator processes.
 */
type RestartHarnessPhase =
  | 'open'
  | 'planning-admitted'
  | 'applying'
  | 'applied'
  | 'verified'
  | 'partial-rolled-back'
  | 'released'

/**
 * Injected durable supervisor harness for restart-oriented coordinator tests.
 */
class RestartCoordinatorHarness
implements WorkspaceSearchMigrationControlCoordinatorDependencies,
  WorkspaceSearchMigrationControlExecutionStatusDependencies {
  /** Ordered top-level stages entered by independently restarted invocations. */
  readonly events: string[] = []

  /** Current durable phase reconstructed by every new invocation. */
  private phase: RestartHarnessPhase = 'open'

  /** Whether the next apply persists partial progress then interrupts. */
  private interruptApply = false

  /**
   * Makes the next explicit apply invocation stop after durable partial work.
   */
  interruptNextApply(): void {
    this.interruptApply = true
  }

  /**
   * Reads the current durable harness phase.
   *
   * @returns Current phase retained across restarts.
   */
  readPhase(): RestartHarnessPhase {
    return this.phase
  }

  /**
   * Simulates the existing restart-safe close/replan supervisor.
   *
   * @param _input - Exact planning supervisor request.
   */
  async supervisePostClosePlanning(
    _input: Parameters<
      WorkspaceSearchMigrationControlCoordinatorDependencies[
        'supervisePostClosePlanning'
      ]
    >[0],
  ): Promise<void> {
    this.events.push('close-replan')
    if (this.phase !== 'open') {
      throw new Error('Unexpected planning phase.')
    }
    this.phase = 'planning-admitted'
  }

  /**
   * Reconstructs the secret-free durable execution phase.
   *
   * @param _input - Exact read-only status request.
   * @returns Current deterministic execution status.
   */
  async readExecutionStatus(
    _input: Parameters<
      WorkspaceSearchMigrationControlExecutionStatusDependencies[
        'readExecutionStatus'
      ]
    >[0],
  ): Promise<WorkspaceSearchMigrationExecutionStatus> {
    this.events.push('execution-status')
    return this.createExecutionStatus()
  }

  /**
   * Simulates one existing explicit execution supervisor branch.
   *
   * @param input - Exact explicit execution branch request.
   * @returns Secret-free durable status reached by that branch.
   */
  async superviseExecution(
    input: Parameters<
      WorkspaceSearchMigrationControlCoordinatorDependencies[
        'superviseExecution'
      ]
    >[0],
  ): Promise<WorkspaceSearchMigrationExecutionStatus> {
    this.events.push(input.mode)
    if (input.mode === 'apply') {
      if (
        this.phase !== 'planning-admitted' &&
        this.phase !== 'applying'
      ) {
        throw new Error('Unexpected apply phase.')
      }
      if (this.interruptApply) {
        this.interruptApply = false
        this.phase = 'applying'
        throw new WorkspaceSearchMigrationHeartbeatInterruptedError()
      }
      this.phase = 'applied'
      return this.createExecutionStatus()
    }
    if (input.mode === 'verify') {
      if (this.phase !== 'applied') {
        throw new Error('Unexpected verification phase.')
      }
      this.phase = 'verified'
      return this.createExecutionStatus()
    }
    if (input.mode === 'partial-rollback') {
      if (this.phase !== 'applying') {
        throw new Error('Unexpected partial rollback phase.')
      }
      this.phase = 'partial-rolled-back'
      return this.createExecutionStatus()
    }
    throw new Error('Unexpected complete rollback branch.')
  }

  /**
   * Simulates the existing terminal-bound release adapter and recovery.
   *
   * @param _input - Exact fresh-evidence release request.
   */
  async releaseTerminal(
    _input: Parameters<
      WorkspaceSearchMigrationControlCoordinatorDependencies[
        'releaseTerminal'
      ]
    >[0],
  ): Promise<void> {
    this.events.push('release')
    if (
      this.phase !== 'verified' &&
      this.phase !== 'partial-rolled-back' &&
      this.phase !== 'released'
    ) {
      throw new Error('Unexpected release phase.')
    }
    this.phase = 'released'
  }

  /**
   * Projects the current durable harness phase without identifiers.
   *
   * @returns Secret-free execution status.
   */
  private createExecutionStatus(): WorkspaceSearchMigrationExecutionStatus {
    if (this.phase === 'planning-admitted') {
      return { phase: 'ready', nextAction: { kind: 'apply' } }
    }
    if (this.phase === 'applying') {
      return {
        phase: 'applying',
        nextAction: {
          kind: 'choose',
          options: ['apply', 'partial-rollback'],
        },
      }
    }
    if (this.phase === 'applied') {
      return {
        phase: 'applied',
        nextAction: {
          kind: 'choose',
          options: ['verify', 'complete-rollback'],
        },
      }
    }
    if (this.phase === 'verified') {
      return { phase: 'verified', nextAction: { kind: 'none' } }
    }
    if (this.phase === 'partial-rolled-back') {
      return { phase: 'rolled-back', nextAction: { kind: 'none' } }
    }
    throw new Error('Execution status is unavailable in this phase.')
  }
}

/**
 * Durable fake backing fresh process-local sessions through real supervisors.
 *
 * The graph begins at the already applied boundary so the coordinator's apply
 * stage exercises idempotent default-supervisor recovery. Verification then
 * advances every durable checkpoint through the real execution supervisor,
 * and release uses the real heartbeat, evidence, authority, terminal-reread,
 * and writer-fence path. A final fresh session recovers the released row.
 */
class RealCoordinatorDurableHarness {
  /** Complete resource measurement shared by every restarted session. */
  readonly configuration = createConfiguration()

  /** Digest reviewed by every independently restarted invocation. */
  readonly configurationHash =
    createWorkspaceSearchConfigurationHash(this.configuration)

  /** Ordered process-tagged reads and mutations across all invocations. */
  readonly events: string[] = []

  /** Whether close/replan published the durable planning-admitted graph. */
  private planningAdmitted = false

  /** Whether the real execution supervisor created immutable admission. */
  private executionRunCreated = false

  /** Current durable forward-apply lifecycle. */
  private applyPhase: 'applied' | 'applying' = 'applying'

  /** Current optimistic revision of the fake durable apply state. */
  private applyRevision = 1

  /** Apply evidence checkpoints durably committed by the real supervisor. */
  private readonly applyLocations = new Set<string>()

  /** Current committed-prefix rollback lifecycle, when explicitly selected. */
  private partialRollbackLifecycle: object | undefined

  /** Signal aborted after the next reconciled apply checkpoint, when set. */
  private interruptAfterApplyCheckpoint: AbortController | undefined

  /** Canonical closed fence retained until the explicit release transaction. */
  private readonly closedFence = createClosedWriterFence(
    this.configuration,
    this.configurationHash,
  )

  /** Verification checkpoints durably committed by the real supervisor. */
  private readonly verifiedLocations = new Set<string>()

  /** Whether the immutable verified root has been durably published. */
  private verified = false

  /** Released-open fence retained for response-loss and restart recovery. */
  private releasedFence:
    ReturnType<typeof createWorkspaceSearchWriterFenceReleasedOpenSuccessor>
      | undefined

  /** Whether the next release commits but loses its process response. */
  private loseNextReleaseResponse = false

  /** Current lease owner selected by the latest mutating process. */
  private activeOwnerId = ownerId

  /** Monotonic durable lease fence selected across process restarts. */
  private activeFenceToken = 10

  /** Current selected maintenance-evidence pointer revision. */
  private maintenancePointerRevision = 3

  /** Number of provider collections, used to prove restart short-circuiting. */
  private evidenceCollectionCount = 0

  /** Optional non-finite boundary close time exposed by a focused test. */
  private executionBoundaryClosedAtOverride: string | undefined

  /**
   * Publishes the close/replan prerequisites consumed by real execution.
   *
   * @param processId - Fresh coordinator process performing close/replan.
   */
  admitPlanning(processId: number): void {
    if (this.planningAdmitted) {
      throw new Error('Planning was already admitted.')
    }
    this.planningAdmitted = true
    this.record(processId, 'close-replan:planning-admitted')
  }

  /**
   * Interrupts the next apply process after one durable checkpoint commit.
   *
   * @param controller - Operator signal owned by that fresh process.
   */
  interruptNextApplyAfterCheckpoint(
    controller: AbortController,
  ): void {
    this.interruptAfterApplyCheckpoint = controller
  }

  /**
   * Makes the next terminal release commit before its response is lost.
   */
  loseNextTerminalReleaseResponse(): void {
    this.loseNextReleaseResponse = true
  }

  /** Prepares the exact already-verified durable graph for a release-only test. */
  prepareVerifiedTerminal(): void {
    this.planningAdmitted = true
    this.executionRunCreated = true
    this.applyPhase = 'applied'
    for (const location of [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
    ]) {
      this.applyLocations.add(location)
      this.verifiedLocations.add(location)
    }
    this.verified = true
  }

  /** Makes the terminal boundary expose a non-finite close time. */
  exposeInvalidExecutionBoundaryClosedAt(): void {
    this.executionBoundaryClosedAtOverride = 'invalid-closed-at'
  }

  /**
   * Creates a fresh process-local session over the shared durable graph.
   *
   * @param processId - Stable test-only process number for event attribution.
   * @returns Runtime session implementing the real supervisors' port surface.
   */
  createSession(processId: number): object {
    return {
      measureConfiguration: async () => {
        this.record(processId, 'configuration:read')
        return structuredClone(this.configuration)
      },
      createExecutionBoundaryPort: () => ({
        read: async () => {
          this.record(processId, 'boundary:read')
          return this.planningAdmitted
            ? this.createExecutionBoundary()
            : undefined
        },
      }),
      createSealedPlanningAuthorityPort: () => ({
        read: async () => {
          this.record(processId, 'sealed-authority:read')
          return this.planningAdmitted
            ? this.createSealedPlanningAuthority()
            : undefined
        },
      }),
      createApplicationWriterFencePort: () => ({
        read: async (): Promise<WorkspaceSearchWriterFenceObservation> => {
          this.record(processId, 'writer-fence:read')
          return {
            status: 'present',
            record: structuredClone(
              this.releasedFence ?? this.closedFence,
            ),
          }
        },
        release: async (
          release: unknown,
        ): Promise<WorkspaceSearchWriterFenceObservation> => {
          this.record(processId, 'writer-fence:release')
          const terminal = this.readExactReleaseGraph(release)
          this.releasedFence =
            createWorkspaceSearchWriterFenceReleasedOpenSuccessor(
              this.closedFence,
              {
                releaseVersion: 1,
                configurationHash: this.configurationHash,
                runId,
                executionBoundaryDigest: digest('real-boundary'),
                sealedPlanningAuthorityDigest: digest('real-sealed'),
                executionRunDigest: digest('real-execution'),
                terminal,
              },
              new Date('2026-08-01T00:19:30.000Z'),
            )
          if (this.loseNextReleaseResponse) {
            this.loseNextReleaseResponse = false
            throw new Error('Simulated terminal release response loss.')
          }
          return {
            status: 'present',
            record: structuredClone(this.releasedFence),
          }
        },
      }),
      createPlanningArtifactGateway: () => ({
        replayPlanArtifact: async () => {
          this.record(processId, 'plan:replay')
          return {
            operations: [],
            planSeal: { planDigest: digest('real-plan') },
          }
        },
      }),
      createExecutionRunPort: () => ({
        read: async () => {
          this.record(processId, 'execution-run:read')
          return this.executionRunCreated
            ? { executionRunDigest: digest('real-execution') }
            : undefined
        },
        create: async () => {
          this.record(processId, 'execution-run:create')
          this.executionRunCreated = true
          return { executionRunDigest: digest('real-execution') }
        },
      }),
      createApplyOperationPort: () => ({
        readRunState: async () => {
          this.record(processId, 'apply:read')
          return this.createApplyRunState()
        },
        adoptExecutionAuthority: async () => {
          this.record(processId, 'apply:adopt-authority')
          return this.createApplyRunState()
        },
        commitApplyOperation: () =>
          unexpectedOperation('zero-plan apply operation'),
        saveApplyCheckpoint: async (input: unknown) => {
          const location = readStringProperty(input, 'location')
          this.record(processId, `apply:checkpoint:${location}`)
          this.applyLocations.add(location)
          this.applyRevision += 1
          const controller = this.interruptAfterApplyCheckpoint
          this.interruptAfterApplyCheckpoint = undefined
          controller?.abort()
          return this.createApplyRunState()
        },
        sealApply: async () => {
          this.record(processId, 'apply:seal')
          this.applyPhase = 'applied'
          this.applyRevision += 1
          return this.createApplyRunState()
        },
      }),
      createFullVerificationPort: () => ({
        readProgress: async () => {
          this.record(processId, 'verification:read-progress')
          return this.createVerificationProgress()
        },
        readVerifiedRoot: async () => {
          this.record(processId, 'verification:read-root')
          return this.verified
            ? { verifiedRootDigest: digest('real-verified') }
            : undefined
        },
        saveVerificationPage: async (input: unknown) => {
          const location = readStringProperty(input, 'location')
          this.record(processId, `verification:save:${location}`)
          this.verifiedLocations.add(location)
          return this.createVerificationProgress()
        },
        publishVerified: async () => {
          this.record(processId, 'verification:publish')
          this.verified = true
          return { verifiedRootDigest: digest('real-verified') }
        },
      }),
      createPartialRollbackOperationPort: () => ({
        readRollbackLifecycle: async () => {
          this.record(processId, 'partial-rollback:read')
          return structuredClone(this.partialRollbackLifecycle)
        },
        beginRollback: async () => {
          this.record(processId, 'partial-rollback:begin')
          this.partialRollbackLifecycle = {
            startRoot: { startRootDigest: digest('real-partial-start') },
            state: {
              status: 'rolling-back',
              revision: 1,
              nextSequence: 0,
            },
          }
          return readUnknownProperty(
            this.partialRollbackLifecycle,
            'state',
          )
        },
        commitRollbackOperation: () =>
          unexpectedOperation('zero-prefix rollback operation'),
        finishRollback: async () => {
          this.record(processId, 'partial-rollback:finish')
          const root = {
            rootDigest: digest('real-partial-rolled-back'),
          }
          this.partialRollbackLifecycle = {
            startRoot: { startRootDigest: digest('real-partial-start') },
            state: {
              status: 'rolled-back',
              revision: 2,
              nextSequence: 0,
            },
            rolledBackRoot: root,
          }
          return root
        },
      }),
      createRollbackOperationPort: () => ({
        readRollbackState: async () => {
          this.record(processId, 'complete-rollback:read-state')
          return undefined
        },
        readRolledBackRoot: async () => {
          this.record(processId, 'complete-rollback:read-root')
          return undefined
        },
      }),
      acquireLease: async (input: unknown) => {
        this.activeOwnerId = readStringProperty(input, 'ownerId')
        this.activeFenceToken += 1
        this.record(
          processId,
          `lease:acquire:${this.activeOwnerId}:${this.activeFenceToken}`,
        )
        return this.createLease()
      },
      heartbeatLease: async () => {
        this.record(processId, 'lease:heartbeat')
        return this.createLease()
      },
      /** Installs the process-local heartbeat mutation assertion. */
      runWithMutationAdmissionGuard: async <Result>(
        guard: () => void,
        task: () => Promise<Result>,
      ): Promise<Result> => {
        this.record(processId, 'mutation-admission:guard')
        guard()
        return await task()
      },
      /** Records one process-local mutation-admission interruption. */
      interruptMutationAdmission: (): void => {
        this.record(processId, 'mutation-admission:interrupt')
      },
      readMaintenanceEvidencePointer: async () => {
        this.record(processId, 'authority:read-pointer')
        return {
          fenceToken: this.activeFenceToken,
          revision: this.maintenancePointerRevision,
          receiptDigest: digest(
            `real-receipt-${this.maintenancePointerRevision}`,
          ),
        }
      },
      readAuthority: async () => {
        this.record(processId, 'authority:read')
        return this.createAuthority()
      },
      readMaintenanceEvidenceReceipt: async () => {
        this.record(processId, 'authority:read-receipt')
        return structuredClone(
          this.createAuthority().maintenanceEvidenceReceipt,
        )
      },
      renewMaintenanceEvidence: async () => {
        this.maintenancePointerRevision += 1
        this.record(processId, 'authority:renew')
        return this.createAuthority()
      },
    }
  }

  /**
   * Creates the trusted provider consumed by execution and release attempts.
   *
   * @param processId - Stable test-only process number for event attribution.
   * @returns Fresh exact-configuration post-close evidence provider.
   */
  createMaintenanceEvidenceProvider(processId: number): object {
    return {
      collect: async () => {
        this.evidenceCollectionCount += 1
        this.record(processId, 'evidence:collect')
        return {
          configurationHash: this.configurationHash,
          tableIds: this.createTableIds(),
          evidenceBytes: createCoordinatorMaintenanceEvidenceBytes(),
        }
      },
    }
  }

  /**
   * Creates a deterministic scheduler that never starts a pending heartbeat.
   *
   * @param processId - Stable test-only process number for event attribution.
   * @returns Cancelable one-shot scheduler used after the initial heartbeat.
   */
  createHeartbeatScheduler(processId: number): object {
    return {
      schedule: () => {
        this.record(processId, 'heartbeat:schedule')
        return {
          cancel: (): void => {
            this.record(processId, 'heartbeat:cancel')
          },
        }
      },
    }
  }

  /**
   * Reads the number of fresh provider collections across all restarts.
   *
   * @returns Durable collection count.
   */
  readEvidenceCollectionCount(): number {
    return this.evidenceCollectionCount
  }

  /**
   * Reports whether the durable writer fence reached released-open.
   *
   * @returns Whether exactly one real release path committed.
   */
  isReleased(): boolean {
    return this.releasedFence !== undefined
  }

  /**
   * Reads the durable released-open terminal identity.
   *
   * @returns Detached verified or rollback terminal, when released.
   */
  readReleasedTerminalOutcome():
    RealCoordinatorTerminalOutcome | undefined {
    return structuredClone(
      this.releasedFence?.release.terminal,
    )
  }

  /**
   * Creates the exact planning-admitted boundary read by execution stages.
   *
   * @returns Minimal correlated durable execution boundary.
   */
  private createExecutionBoundary(): object {
    return {
      phase: 'planning-admitted',
      runId,
      configurationHash: this.configurationHash,
      tableIds: this.createTableIds(),
      closedWriterFenceRecordDigest: this.closedFence.recordDigest,
      boundaryDigest: digest('real-boundary'),
      closedAt: this.executionBoundaryClosedAtOverride ??
        this.closedFence.closedAt,
      closeAuthority: structuredClone(this.closedFence.authority),
    }
  }

  /**
   * Creates the exact immutable sealed root read by execution stages.
   *
   * @returns Minimal correlated sealed planning authority.
   */
  private createSealedPlanningAuthority(): object {
    return {
      runId,
      configurationHash: this.configurationHash,
      tableIds: this.createTableIds(),
      planOperationCount: 0,
      planDigest: digest('real-plan'),
      planSealReference: { versionId: 'real-plan-seal-version' },
      planManifestHeadReference: {
        versionId: 'real-plan-manifest-version',
      },
      authorityDigest: digest('real-sealed'),
    }
  }

  /**
   * Creates the exact six-role TableId binding fixed by the sealed root.
   *
   * @returns Detached role-indexed TableIds.
   */
  private createTableIds(): object {
    return {
      'project-directory':
        this.configuration.tables['project-directory'].tableId,
      'work-items': this.configuration.tables['work-items'].tableId,
      collaboration: this.configuration.tables.collaboration.tableId,
      documents: this.configuration.tables.documents.tableId,
      'workspace-search':
        this.configuration.tables['workspace-search'].tableId,
      'migration-state':
        this.configuration.tables['migration-state'].tableId,
    }
  }

  /**
   * Creates the current zero-operation applying or applied run state.
   *
   * @returns Minimal state consumed by the real execution supervisor loop.
   */
  private createApplyRunState(): object {
    return {
      status: this.applyPhase,
      revision: this.applyRevision,
      planOperationCount: 0,
      appliedOperationCount: 0,
      apply: {
        sources: {
          'project-directory':
            this.createApplyCheckpoint('project-directory'),
          'work-items': this.createApplyCheckpoint('work-items'),
          collaboration: this.createApplyCheckpoint('collaboration'),
          documents: this.createApplyCheckpoint('documents'),
        },
        target: this.createApplyCheckpoint('target'),
      },
    }
  }

  /**
   * Creates one current forward-apply evidence checkpoint.
   *
   * @param location - Stable source or target traversal location.
   * @returns Minimal complete or incomplete clean checkpoint.
   */
  private createApplyCheckpoint(location: string): object {
    return {
      completed: this.applyLocations.has(location),
      aggregate: { invalid: 0 },
    }
  }

  /**
   * Creates current verification progress from durable completed locations.
   *
   * @returns Minimal progress consumed by the real supervisor, or undefined.
   */
  private createVerificationProgress(): object | undefined {
    if (this.verifiedLocations.size === 0) return undefined
    return {
      revision: this.verifiedLocations.size,
      progress: {
        traversal: {
          sources: {
            'project-directory':
              this.createVerificationCheckpoint('project-directory'),
            'work-items':
              this.createVerificationCheckpoint('work-items'),
            collaboration:
              this.createVerificationCheckpoint('collaboration'),
            documents:
              this.createVerificationCheckpoint('documents'),
          },
          target: this.createVerificationCheckpoint('target'),
        },
      },
    }
  }

  /**
   * Creates one checkpoint projection consumed by next-location selection.
   *
   * @param location - Stable source or target checkpoint location.
   * @returns Minimal cumulative zero-invalid checkpoint.
   */
  private createVerificationCheckpoint(location: string): object {
    return {
      completed: this.verifiedLocations.has(location),
      aggregate: { invalid: 0 },
    }
  }

  /**
   * Creates the current exact sixty-second fenced lease.
   *
   * @returns Stable lease retained by heartbeat identity checks.
   */
  private createLease(): object {
    return {
      runId,
      ownerId: this.activeOwnerId,
      fenceToken: this.activeFenceToken,
      heartbeatAt: '2026-08-01T00:19:00.000Z',
      expiresAt: '2026-08-01T00:20:00.000Z',
    }
  }

  /**
   * Creates current fresh pre-plan authority for the active lease.
   *
   * @returns Exact measurement, table, lease, pointer, and receipt binding.
   */
  private createAuthority(): {
    readonly configurationHash: string
    readonly stateTableId: string
    readonly lease: object
    readonly maintenanceEvidenceReceiptDigest: string
    readonly maintenanceEvidencePointerRevision: number
    readonly maintenanceEvidenceReceipt: object
    readonly evaluatedAt: string
  } {
    return {
      configurationHash: this.configurationHash,
      stateTableId:
        this.configuration.tables['migration-state'].tableId,
      lease: this.createLease(),
      maintenanceEvidenceReceiptDigest: digest(
        `real-receipt-${this.maintenancePointerRevision}`,
      ),
      maintenanceEvidencePointerRevision:
        this.maintenancePointerRevision,
      maintenanceEvidenceReceipt: {
        runId,
        evidenceDigest: digest('real-evidence'),
        evidenceLocator: 'change:OPS-164',
        runtimeRevision: 91,
        fenceToken: this.activeFenceToken,
        validatedAt: '2026-08-01T00:19:00.000Z',
        oldestObservationAt: '2026-08-01T00:18:50.000Z',
        validUntil: '2026-08-01T00:20:30.000Z',
      },
      evaluatedAt: '2026-08-01T00:19:00.000Z',
    }
  }

  /**
   * Requires and projects every exact immutable release graph root.
   *
   * @param release - Candidate graph passed by the real coordinator.
   * @returns Exact verified or committed-prefix rollback terminal identity.
   */
  private readExactReleaseGraph(
    release: unknown,
  ): RealCoordinatorTerminalOutcome {
    const boundary = readUnknownProperty(release, 'executionBoundary')
    const sealed = readUnknownProperty(
      release,
      'sealedPlanningAuthority',
    )
    const execution = readUnknownProperty(release, 'executionRun')
    const terminal = readUnknownProperty(release, 'terminal')
    const root = readUnknownProperty(terminal, 'root')
    if (
      readStringProperty(boundary, 'boundaryDigest') !==
        digest('real-boundary') ||
      readStringProperty(sealed, 'authorityDigest') !==
        digest('real-sealed') ||
      readStringProperty(execution, 'executionRunDigest') !==
        digest('real-execution')
    ) {
      throw new Error('Expected exact terminal release graph.')
    }
    const kind = readStringProperty(terminal, 'kind')
    if (kind === 'verified') {
      const rootDigest = readStringProperty(
        root,
        'verifiedRootDigest',
      )
      if (!this.verified || rootDigest !== digest('real-verified')) {
        throw new Error('Expected exact verified terminal root.')
      }
      return {
        kind: 'verified',
        persistenceVersion: 1,
        rootDigest,
      }
    }
    if (kind === 'rolled-back-v2') {
      const rootDigest = readStringProperty(root, 'rootDigest')
      if (
        rootDigest !== digest('real-partial-rolled-back') ||
        this.partialRollbackLifecycle === undefined
      ) {
        throw new Error('Expected exact partial rollback terminal root.')
      }
      return {
        kind: 'rolled-back',
        persistenceVersion: 2,
        rootDigest,
      }
    }
    throw new Error('Expected one supported terminal release branch.')
  }

  /**
   * Records one process-local operation in the shared durable event stream.
   *
   * @param processId - Restarted process that performed the operation.
   * @param event - Stable secret-free operation label.
   */
  private record(processId: number, event: string): void {
    this.events.push(`process-${processId}:${event}`)
  }
}

/**
 * Creates dependencies that fake only close/replan graph publication.
 *
 * Execution uses the production supervisor directly. Terminal release calls a
 * fresh default coordinator invocation so its production release path remains
 * under test rather than being represented by a phase assignment.
 *
 * @param harness - Shared durable backing for independently created sessions.
 * @param closeProcessId - Fresh process attributed to close/replan.
 * @returns Coordinator dependencies with real execution and release behavior.
 */
function createRealExecutionCoordinatorDependencies(
  harness: RealCoordinatorDurableHarness,
  closeProcessId: number,
): WorkspaceSearchMigrationControlCoordinatorDependencies {
  return {
    supervisePostClosePlanning: async () => {
      harness.admitPlanning(closeProcessId)
    },
    superviseExecution:
      superviseWorkspaceSearchMigrationExecution,
    releaseTerminal: async (input) => {
      await advanceWorkspaceSearchMigrationControlStage(input)
    },
  }
}

describe('Workspace Search migration control coordinator', () => {
  test('snapshots a Proxy discriminant once so apply approval cannot dispatch release', async () => {
    const events: string[] = []
    const dependencies = createRecordingDependencies(events)
    let modeReads = 0
    const unstableInput = new Proxy({
      session: { capability: 'execution-only' },
      maintenanceEvidenceProvider: { capability: 'fresh-evidence' },
      runId,
      ownerId,
      expectedConfigurationHash: '0'.repeat(64),
      mode: 'apply',
      approval: workspaceSearchMigrationControlApprovalLiterals.apply,
    }, {
      get: (target, property, receiver): unknown => {
        if (property === 'mode') {
          modeReads += 1
          return modeReads === 1 ? 'apply' : 'release'
        }
        return Reflect.get(target, property, receiver)
      },
    })

    expect(
      await invokeCoordinator(unstableInput, dependencies),
    ).toEqual({
      mode: 'apply',
      execution: {
        phase: 'applied',
        nextAction: {
          kind: 'choose',
          options: ['verify', 'complete-rollback'],
        },
      },
    })
    expect(modeReads).toBe(1)
    expect(events).toEqual([
      `execution:apply:${runId}:${ownerId}`,
    ])
  })

  test('status accepts a dedicated read dependency without touching mutation capabilities', async () => {
    let mutationGetterReads = 0
    const dependencies = {
      readExecutionStatus: async (): Promise<
        WorkspaceSearchMigrationExecutionStatus
      > => ({
        phase: 'ready',
        nextAction: { kind: 'apply' },
      }),
      get superviseExecution(): never {
        mutationGetterReads += 1
        throw new Error('Mutation dependency must stay unreachable.')
      },
    }

    expect(await invokeExecutionStatus({
      session: { capability: 'read-only' },
      runId,
      expectedConfigurationHash: '1'.repeat(64),
    }, dependencies)).toEqual({
      phase: 'ready',
      nextAction: { kind: 'apply' },
    })
    expect(mutationGetterReads).toBe(0)
  })

  test('keeps status read-only and advances only the one explicitly selected stage', async () => {
    const events: string[] = []
    const dependencies = createRecordingDependencies(events)
    const expectedConfigurationHash = '1'.repeat(64)
    const commonExecution = {
      session: { capability: 'execution-only' },
      maintenanceEvidenceProvider: { capability: 'fresh-evidence' },
      runId,
      ownerId,
      expectedConfigurationHash,
    }

    expect(
      await invokeExecutionStatus(
        {
          session: { capability: 'read-only' },
          runId,
          expectedConfigurationHash,
        },
        dependencies,
      ),
    ).toEqual({
      phase: 'applying',
      nextAction: {
        kind: 'choose',
        options: ['apply', 'partial-rollback'],
      },
    })
    expect(events).toEqual([`status:${runId}`])

    events.length = 0
    expect(
      await invokeCoordinator(
        {
          session: { capability: 'planning-only' },
          maintenanceEvidenceProvider: {
            capability: 'fresh-evidence',
          },
          runId,
          ownerId,
          expectedConfigurationHash,
          reviewedDryRunEvidenceBytes: new Uint8Array([1]),
          planningJoinLimits: {
            maxTotalRows: 100,
            maxTotalCanonicalItemBytes: 1_024,
            maxPlanOperations: 100,
          },
          retainUntil: retainedUntil,
          mode: 'close-replan',
          approval:
            workspaceSearchMigrationControlApprovalLiterals[
              'close-replan'
            ],
        },
        dependencies,
      ),
    ).toEqual({
      mode: 'close-replan',
      phase: 'planning-admitted',
    })
    expect(events).toEqual([
      `planning:${runId}:${ownerId}`,
    ])

    const cases: readonly {
      /** Public coordinator mode selected by the operator. */
      readonly mode:
        | 'apply'
        | 'rollback-complete'
        | 'rollback-partial'
        | 'verify'
      /** Exact approval phrase assigned to the public mode. */
      readonly approval: string
      /** Existing supervisor mode expected after mapping. */
      readonly supervisorMode:
        | 'apply'
        | 'complete-rollback'
        | 'partial-rollback'
        | 'verify'
    }[] = [
      {
        mode: 'apply',
        approval:
          workspaceSearchMigrationControlApprovalLiterals.apply,
        supervisorMode: 'apply',
      },
      {
        mode: 'verify',
        approval:
          workspaceSearchMigrationControlApprovalLiterals.verify,
        supervisorMode: 'verify',
      },
      {
        mode: 'rollback-partial',
        approval:
          workspaceSearchMigrationControlApprovalLiterals[
            'rollback-partial'
          ],
        supervisorMode: 'partial-rollback',
      },
      {
        mode: 'rollback-complete',
        approval:
          workspaceSearchMigrationControlApprovalLiterals[
            'rollback-complete'
          ],
        supervisorMode: 'complete-rollback',
      },
    ]
    for (const entry of cases) {
      events.length = 0
      const summary = await invokeCoordinator(
        {
          ...commonExecution,
          mode: entry.mode,
          approval: entry.approval,
        },
        dependencies,
      )
      expect(summary).toMatchObject({ mode: entry.mode })
      expect(events).toEqual([
        `execution:${entry.supervisorMode}:${runId}:${ownerId}`,
      ])
    }
  })

  test('rejects a wrong stage approval and an already-aborted signal before any supervisor call', async () => {
    const events: string[] = []
    const dependencies = createRecordingDependencies(events)
    const common = {
      session: { capability: 'execution-only' },
      maintenanceEvidenceProvider: { capability: 'fresh-evidence' },
      runId,
      ownerId,
      expectedConfigurationHash: '2'.repeat(64),
      mode: 'rollback-partial',
    }
    const approvalError = await captureError(() =>
      invokeCoordinator(
        {
          ...common,
          approval:
            workspaceSearchMigrationControlApprovalLiterals.release,
        },
        dependencies,
      )
    )
    expect(approvalError).toMatchObject({
      name: 'WorkspaceSearchMigrationFailure',
      code: 'INVALID_ARGUMENT',
      message: 'INVALID_ARGUMENT',
    })
    expect(events).toEqual([])

    const controller = new AbortController()
    controller.abort()
    const interruption = await captureError(() =>
      invokeCoordinator(
        {
          ...common,
          approval:
            workspaceSearchMigrationControlApprovalLiterals[
              'rollback-partial'
            ],
          signal: controller.signal,
        },
        dependencies,
      )
    )
    expect(interruption).toMatchObject({
      name: 'WorkspaceSearchMigrationHeartbeatInterruptedError',
      code: 'INTERRUPTED',
      message: 'INTERRUPTED',
    })
    expect(events).toEqual([])
  })

  test('restarts between close, apply, verify, and release without automatically entering another stage', async () => {
    const harness = new RestartCoordinatorHarness()
    const expectedConfigurationHash = '3'.repeat(64)
    const provider = { capability: 'fresh-evidence' }
    const summaries: unknown[] = []

    summaries.push(await invokeCoordinator({
      session: { process: 1, capability: 'planning' },
      maintenanceEvidenceProvider: provider,
      runId,
      ownerId: `${ownerId}-1`,
      expectedConfigurationHash,
      reviewedDryRunEvidenceBytes: new Uint8Array([1]),
      planningJoinLimits: {
        maxTotalRows: 100,
        maxTotalCanonicalItemBytes: 1_024,
        maxPlanOperations: 100,
      },
      retainUntil: retainedUntil,
      mode: 'close-replan',
      approval:
        workspaceSearchMigrationControlApprovalLiterals[
          'close-replan'
        ],
    }, harness))
    expect(harness.events).toEqual(['close-replan'])
    expect(harness.readPhase()).toBe('planning-admitted')

    summaries.push(await invokeCoordinator({
      session: { process: 2, capability: 'execution' },
      maintenanceEvidenceProvider: provider,
      runId,
      ownerId: `${ownerId}-2`,
      expectedConfigurationHash,
      mode: 'apply',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.apply,
    }, harness))
    expect(harness.events).toEqual(['close-replan', 'apply'])
    expect(harness.readPhase()).toBe('applied')

    summaries.push(await invokeCoordinator({
      session: { process: 3, capability: 'execution' },
      maintenanceEvidenceProvider: provider,
      runId,
      ownerId: `${ownerId}-3`,
      expectedConfigurationHash,
      mode: 'verify',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.verify,
    }, harness))
    expect(harness.events).toEqual([
      'close-replan',
      'apply',
      'verify',
    ])
    expect(harness.readPhase()).toBe('verified')

    summaries.push(await invokeCoordinator({
      session: { process: 4, capability: 'release' },
      maintenanceEvidenceProvider: provider,
      runId,
      ownerId: `${ownerId}-4`,
      expectedConfigurationHash,
      mode: 'release',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.release,
    }, harness))
    expect(harness.events).toEqual([
      'close-replan',
      'apply',
      'verify',
      'release',
    ])
    expect(harness.readPhase()).toBe('released')
    const serialized = JSON.stringify(summaries)
    expect(serialized).not.toContain(runId)
    expect(serialized).not.toContain(ownerId)
    expect(serialized).not.toContain('capability')
  })

  test('restarts after interrupted apply and requires explicit partial rollback before release', async () => {
    const harness = new RestartCoordinatorHarness()
    const expectedConfigurationHash = '4'.repeat(64)
    const provider = { capability: 'fresh-evidence' }
    await invokeCoordinator({
      session: { process: 1, capability: 'planning' },
      maintenanceEvidenceProvider: provider,
      runId,
      ownerId: `${ownerId}-1`,
      expectedConfigurationHash,
      reviewedDryRunEvidenceBytes: new Uint8Array([1]),
      planningJoinLimits: {
        maxTotalRows: 100,
        maxTotalCanonicalItemBytes: 1_024,
        maxPlanOperations: 100,
      },
      retainUntil: retainedUntil,
      mode: 'close-replan',
      approval:
        workspaceSearchMigrationControlApprovalLiterals[
          'close-replan'
        ],
    }, harness)
    harness.interruptNextApply()
    const interrupted = await captureError(() =>
      invokeCoordinator({
        session: { process: 2, capability: 'execution' },
        maintenanceEvidenceProvider: provider,
        runId,
        ownerId: `${ownerId}-2`,
        expectedConfigurationHash,
        mode: 'apply',
        approval:
          workspaceSearchMigrationControlApprovalLiterals.apply,
      }, harness)
    )
    expect(interrupted).toMatchObject({
      name: 'WorkspaceSearchMigrationHeartbeatInterruptedError',
      code: 'INTERRUPTED',
    })
    expect(harness.events).toEqual(['close-replan', 'apply'])
    expect(harness.readPhase()).toBe('applying')

    expect(await invokeExecutionStatus({
      session: { process: 3, capability: 'read-only' },
      runId,
      expectedConfigurationHash,
    }, harness)).toEqual({
      phase: 'applying',
      nextAction: {
        kind: 'choose',
        options: ['apply', 'partial-rollback'],
      },
    })
    expect(harness.events).toEqual([
      'close-replan',
      'apply',
      'execution-status',
    ])

    const rollback = await invokeCoordinator({
      session: { process: 4, capability: 'execution' },
      maintenanceEvidenceProvider: provider,
      runId,
      ownerId: `${differentOwnerId}-4`,
      expectedConfigurationHash,
      mode: 'rollback-partial',
      approval:
        workspaceSearchMigrationControlApprovalLiterals[
          'rollback-partial'
        ],
    }, harness)
    expect(rollback).toEqual({
      mode: 'rollback-partial',
      execution: {
        phase: 'rolled-back',
        nextAction: { kind: 'none' },
      },
    })
    expect(harness.readPhase()).toBe('partial-rolled-back')

    expect(await invokeCoordinator({
      session: { process: 5, capability: 'release' },
      maintenanceEvidenceProvider: provider,
      runId,
      ownerId: `${differentOwnerId}-5`,
      expectedConfigurationHash,
      mode: 'release',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.release,
    }, harness)).toEqual({ mode: 'release', phase: 'released' })
    expect(harness.events).toEqual([
      'close-replan',
      'apply',
      'execution-status',
      'partial-rollback',
      'release',
    ])
    expect(harness.readPhase()).toBe('released')
  })

  test('rejects a non-finite terminal close time before release evidence renewal', async () => {
    const harness = new RealCoordinatorDurableHarness()
    harness.prepareVerifiedTerminal()
    harness.exposeInvalidExecutionBoundaryClosedAt()

    const failure = await captureError(() => invokeCoordinator({
      session: harness.createSession(1),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(1),
      runId,
      ownerId: `${ownerId}-invalid-close`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'release',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.release,
      heartbeatScheduler: harness.createHeartbeatScheduler(1),
      clock: readCoordinatorHarnessClock,
    }))

    expect(failure).toMatchObject({
      code: 'INVALID_MAINTENANCE_EVIDENCE',
    })
    expect(harness.events).toContain('process-1:evidence:collect')
    expect(harness.events).not.toContain('process-1:authority:renew')
    expect(harness.events).not.toContain('process-1:writer-fence:release')
    expect(harness.events).toContain(
      'process-1:mutation-admission:guard',
    )
    expect(harness.events).not.toContain(
      'process-1:mutation-admission:interrupt',
    )
  })

  test('uses real default execution and release supervisors across fresh durable sessions', async () => {
    const harness = new RealCoordinatorDurableHarness()
    const dependencies =
      createRealExecutionCoordinatorDependencies(harness, 1)

    expect(await invokeCoordinator({
      session: harness.createSession(1),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(1),
      runId,
      ownerId: `${ownerId}-real-close`,
      expectedConfigurationHash: harness.configurationHash,
      reviewedDryRunEvidenceBytes: new Uint8Array([1]),
      planningJoinLimits: {
        maxTotalRows: 1,
        maxTotalCanonicalItemBytes: 1,
        maxPlanOperations: 1,
      },
      retainUntil: retainedUntil,
      mode: 'close-replan',
      approval:
        workspaceSearchMigrationControlApprovalLiterals[
          'close-replan'
        ],
    }, dependencies)).toEqual({
      mode: 'close-replan',
      phase: 'planning-admitted',
    })
    expect(harness.events).toEqual([
      'process-1:close-replan:planning-admitted',
    ])

    expect(await invokeCoordinator({
      session: harness.createSession(2),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(2),
      runId,
      ownerId: `${ownerId}-real-apply`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'apply',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.apply,
      heartbeatScheduler: harness.createHeartbeatScheduler(2),
      clock: readCoordinatorHarnessClock,
    }, dependencies)).toEqual({
      mode: 'apply',
      execution: {
        phase: 'applied',
        nextAction: {
          kind: 'choose',
          options: ['verify', 'complete-rollback'],
        },
      },
    })
    expect(
      harness.events.some((event) =>
        event.startsWith('process-2:lease:acquire:')
      ),
    ).toBe(true)
    expect(harness.events).toContain(
      'process-2:execution-run:create',
    )
    expect(
      harness.events.filter((event) =>
        event.startsWith('process-2:apply:checkpoint:')
      ),
    ).toEqual([
      'process-2:apply:checkpoint:project-directory',
      'process-2:apply:checkpoint:work-items',
      'process-2:apply:checkpoint:collaboration',
      'process-2:apply:checkpoint:documents',
      'process-2:apply:checkpoint:target',
    ])
    expect(harness.events).toContain('process-2:apply:seal')

    expect(await invokeExecutionStatus({
      session: harness.createSession(3),
      runId,
      expectedConfigurationHash: harness.configurationHash,
    })).toEqual({
      phase: 'applied',
      nextAction: {
        kind: 'choose',
        options: ['verify', 'complete-rollback'],
      },
    })
    expect(
      harness.events.some((event) =>
        event.startsWith('process-3:lease:') ||
        event.startsWith('process-3:authority:')
      ),
    ).toBe(false)

    expect(await invokeCoordinator({
      session: harness.createSession(4),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(4),
      runId,
      ownerId: `${ownerId}-real-verify`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'verify',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.verify,
      heartbeatScheduler: harness.createHeartbeatScheduler(4),
      clock: readCoordinatorHarnessClock,
    }, dependencies)).toEqual({
      mode: 'verify',
      execution: {
        phase: 'verified',
        nextAction: { kind: 'none' },
      },
    })
    expect(
      harness.events.filter((event) =>
        event.startsWith('process-4:verification:save:')
      ),
    ).toEqual([
      'process-4:verification:save:project-directory',
      'process-4:verification:save:work-items',
      'process-4:verification:save:collaboration',
      'process-4:verification:save:documents',
      'process-4:verification:save:target',
    ])
    expect(harness.events).toContain(
      'process-4:verification:publish',
    )

    const releaseSummary = await invokeCoordinator({
      session: harness.createSession(5),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(5),
      runId,
      ownerId: `${ownerId}-real-release`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'release',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.release,
      heartbeatScheduler: harness.createHeartbeatScheduler(5),
      clock: readCoordinatorHarnessClock,
    }, dependencies)
    expect(releaseSummary).toEqual({
      mode: 'release',
      phase: 'released',
    })
    expect(harness.isReleased()).toBe(true)
    expect(harness.events).toContain('process-5:evidence:collect')
    expect(harness.events).toContain('process-5:authority:renew')
    expect(
      harness.events.filter(
        (event) => event === 'process-5:authority:read',
      ),
    ).toHaveLength(2)
    expect(harness.events).toContain(
      'process-5:writer-fence:release',
    )
    expect(
      harness.events.filter(
        (event) => event === 'process-5:configuration:read',
      ),
    ).toHaveLength(1)
    expect(harness.readEvidenceCollectionCount()).toBe(1)
    expect(harness.events).toContain(
      'process-5:mutation-admission:guard',
    )
    expect(harness.events).not.toContain(
      'process-5:mutation-admission:interrupt',
    )

    const eventsBeforeRecovery = harness.events.length
    expect(await invokeCoordinator({
      session: harness.createSession(6),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(6),
      runId,
      ownerId: `${differentOwnerId}-real-release`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'release',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.release,
      heartbeatScheduler: harness.createHeartbeatScheduler(6),
      clock: readCoordinatorHarnessClock,
    }, dependencies)).toEqual({ mode: 'release', phase: 'released' })
    expect(harness.events.slice(eventsBeforeRecovery)).toEqual([
      'process-6:configuration:read',
      'process-6:writer-fence:read',
      'process-6:boundary:read',
      'process-6:sealed-authority:read',
      'process-6:writer-fence:read',
      'process-6:plan:replay',
      'process-6:execution-run:read',
      'process-6:apply:read',
      'process-6:verification:read-progress',
      'process-6:verification:read-root',
      'process-6:complete-rollback:read-state',
      'process-6:complete-rollback:read-root',
      'process-6:complete-rollback:read-state',
      'process-6:complete-rollback:read-root',
    ])
    expect(harness.readEvidenceCollectionCount()).toBe(1)
    const serialized = JSON.stringify(releaseSummary)
    expect(serialized).not.toContain(runId)
    expect(serialized).not.toContain(ownerId)
  })

  test('uses real execution after interrupted apply, resumes partial rollback v2, and recovers release response loss', async () => {
    const harness = new RealCoordinatorDurableHarness()
    const dependencies =
      createRealExecutionCoordinatorDependencies(harness, 1)
    await invokeCoordinator({
      session: harness.createSession(1),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(1),
      runId,
      ownerId: `${ownerId}-partial-close`,
      expectedConfigurationHash: harness.configurationHash,
      reviewedDryRunEvidenceBytes: new Uint8Array([1]),
      planningJoinLimits: {
        maxTotalRows: 1,
        maxTotalCanonicalItemBytes: 1,
        maxPlanOperations: 1,
      },
      retainUntil: retainedUntil,
      mode: 'close-replan',
      approval:
        workspaceSearchMigrationControlApprovalLiterals[
          'close-replan'
        ],
    }, dependencies)

    const controller = new AbortController()
    harness.interruptNextApplyAfterCheckpoint(controller)
    const interrupted = await captureError(() => invokeCoordinator({
      session: harness.createSession(2),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(2),
      runId,
      ownerId: `${ownerId}-partial-apply`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'apply',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.apply,
      signal: controller.signal,
      heartbeatScheduler: harness.createHeartbeatScheduler(2),
      clock: readCoordinatorHarnessClock,
    }, dependencies))
    expect(interrupted).toMatchObject({
      name: 'WorkspaceSearchMigrationHeartbeatInterruptedError',
      code: 'INTERRUPTED',
    })
    expect(harness.events).toContain(
      'process-2:apply:checkpoint:project-directory',
    )
    expect(harness.events).not.toContain('process-2:apply:seal')

    expect(await invokeExecutionStatus({
      session: harness.createSession(3),
      runId,
      expectedConfigurationHash: harness.configurationHash,
    })).toEqual({
      phase: 'applying',
      nextAction: {
        kind: 'choose',
        options: ['apply', 'partial-rollback'],
      },
    })

    expect(await invokeCoordinator({
      session: harness.createSession(4),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(4),
      runId,
      ownerId: `${differentOwnerId}-partial-rollback`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'rollback-partial',
      approval:
        workspaceSearchMigrationControlApprovalLiterals[
          'rollback-partial'
        ],
      heartbeatScheduler: harness.createHeartbeatScheduler(4),
      clock: readCoordinatorHarnessClock,
    }, dependencies)).toEqual({
      mode: 'rollback-partial',
      execution: {
        phase: 'rolled-back',
        nextAction: { kind: 'none' },
      },
    })
    expect(harness.events).toContain('process-4:partial-rollback:begin')
    expect(harness.events).toContain('process-4:partial-rollback:finish')
    expect(harness.events).toContain('process-4:lease:heartbeat')

    harness.loseNextTerminalReleaseResponse()
    const lostResponse = await captureError(() => invokeCoordinator({
      session: harness.createSession(5),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(5),
      runId,
      ownerId: `${differentOwnerId}-partial-release`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'release',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.release,
      heartbeatScheduler: harness.createHeartbeatScheduler(5),
      clock: readCoordinatorHarnessClock,
    }, dependencies))
    expect(lostResponse.message).toBe(
      'Simulated terminal release response loss.',
    )
    expect(harness.events).toContain('process-5:evidence:collect')
    expect(harness.isReleased()).toBe(true)
    expect(harness.readReleasedTerminalOutcome()).toEqual({
      kind: 'rolled-back',
      persistenceVersion: 2,
      rootDigest: digest('real-partial-rolled-back'),
    })

    const eventsBeforeRecovery = harness.events.length
    expect(await invokeCoordinator({
      session: harness.createSession(6),
      maintenanceEvidenceProvider:
        harness.createMaintenanceEvidenceProvider(6),
      runId,
      ownerId: `${differentOwnerId}-partial-recovery`,
      expectedConfigurationHash: harness.configurationHash,
      mode: 'release',
      approval:
        workspaceSearchMigrationControlApprovalLiterals.release,
      heartbeatScheduler: harness.createHeartbeatScheduler(6),
      clock: readCoordinatorHarnessClock,
    }, dependencies)).toEqual({ mode: 'release', phase: 'released' })
    expect(harness.events.slice(eventsBeforeRecovery)).toEqual([
      'process-6:configuration:read',
      'process-6:writer-fence:read',
      'process-6:boundary:read',
      'process-6:sealed-authority:read',
      'process-6:writer-fence:read',
      'process-6:plan:replay',
      'process-6:execution-run:read',
      'process-6:apply:read',
      'process-6:partial-rollback:read',
    ])
  })

})

/**
 * Creates one canonical closed writer fence for terminal release tests.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Digest of that exact configuration.
 * @returns Strict closed writer-fence record bound to all six TableIds.
 */
function createClosedWriterFence(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): ReturnType<typeof createWorkspaceSearchWriterFenceClosedSuccessor> {
  const stateTable = configuration.tables['migration-state']
  if (stateTable.role !== 'migration-state') {
    throw new Error('Expected measured migration-state table.')
  }
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTable.tableName,
    stateTableId: stateTable.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(
        {
          role: 'migration-state',
          tableName: stateTable.tableName,
          tableArn: stateTable.tableArn,
          tableId: stateTable.tableId,
          creationTime: stateTable.creationTime,
          account: stateTable.account,
          region: stateTable.region,
        },
      ),
    tableIds: {
      'project-directory':
        configuration.tables['project-directory'].tableId,
      'work-items': configuration.tables['work-items'].tableId,
      collaboration: configuration.tables.collaboration.tableId,
      documents: configuration.tables.documents.tableId,
      'workspace-search':
        configuration.tables['workspace-search'].tableId,
      'migration-state': stateTable.tableId,
    },
  })
  const opened = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-08-01T00:00:00.000Z'),
  )
  return createWorkspaceSearchWriterFenceClosedSuccessor(
    opened,
    {
      configurationHash,
      runId,
      ownerId,
      leaseFenceToken: 7,
      maintenanceEvidenceReceiptDigest: digest('evidence'),
      maintenanceEvidencePointerRevision: 3,
    },
    new Date('2026-08-01T00:01:00.000Z'),
  )
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable measured six-table configuration.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
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
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': createSupportingTable('workspace-search'),
      'migration-state': createSupportingTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-08-01T00:00:00.000Z',
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
  return createTable(role, sourceKeyDescriptors(role))
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
  return createTable(role, [
    {
      name: role === 'migration-state'
        ? 'migrationId'
        : 'workspaceId',
      role: 'HASH',
      type: 'S',
    },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ])
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
  const tableName = `coordinator-${role}`
  return {
    role,
    tableName,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${tableName}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-08-01T00:00:00.000Z',
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
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-08-01T00:00:00.000Z',
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
 * Creates one stable lowercase digest for fixture identities.
 *
 * @param label - Stable test-only label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

/**
 * Reads one own or inherited property from an intentionally unknown fake call.
 *
 * @param value - Candidate object passed through a runtime-only test boundary.
 * @param property - Stable property selected by the fake adapter.
 * @returns Unknown property value after an object-shape check.
 */
function readUnknownProperty(
  value: unknown,
  property: string,
): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected a fake adapter input object.')
  }
  return Reflect.get(value, property)
}

/**
 * Reads one required string property from a runtime-only fake adapter input.
 *
 * @param value - Candidate object passed through a runtime-only test boundary.
 * @param property - Stable string property selected by the fake adapter.
 * @returns Exact non-empty string property.
 */
function readStringProperty(
  value: unknown,
  property: string,
): string {
  const candidate = readUnknownProperty(value, property)
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error('Expected a fake adapter string property.')
  }
  return candidate
}

/**
 * Creates canonical post-close zero-writer evidence for real release wiring.
 *
 * @returns Exact canonical maintenance-evidence bytes.
 */
function createCoordinatorMaintenanceEvidenceBytes(): Uint8Array {
  const evidence: WorkspaceSearchMaintenanceEvidence = {
    schemaVersion: 1,
    locator: 'change:OPS-164',
    runtimeMode: 'disabled',
    runtimeRevision: 91,
    drainStartedAt: '2026-08-01T00:01:30.000Z',
    drainCompletedAt: '2026-08-01T00:17:00.000Z',
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: 91,
      observedAt: '2026-08-01T00:18:50.000Z',
    })),
  }
  return new TextEncoder().encode(serializeCanonicalJson(evidence))
}

/**
 * Returns the deterministic clock shared by real-supervisor coordinator tests.
 *
 * @returns Fixed time with lease and evidence commit headroom.
 */
function readCoordinatorHarnessClock(): Date {
  return new Date('2026-08-01T00:19:00.000Z')
}

/**
 * Raises when a restart-recovery test touches an unexpected capability.
 *
 * @param operation - Stable test-only operation label.
 */
function unexpectedOperation(operation: string): never {
  throw new Error(`Unexpected coordinator operation: ${operation}`)
}
