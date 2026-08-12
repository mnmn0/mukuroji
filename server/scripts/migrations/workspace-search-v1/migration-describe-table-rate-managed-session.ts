import { AsyncLocalStorage } from 'node:async_hooks'
import type { DescribeTableCommandOutput } from '@aws-sdk/client-dynamodb'
import {
  createWorkspaceSearchMigrationDescribeTableScopeBindingDigest,
} from './migration-describe-table-binding'
import {
  createWorkspaceSearchMigrationDescribeTableRehearsalThrottleAwsTransport,
  createWorkspaceSearchMigrationDescribeTableRateRegistry,
  createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
  type WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration,
  type WorkspaceSearchMigrationDescribeTableCheckpointPage,
  type WorkspaceSearchMigrationDescribeTableMandatoryCleanup,
  type WorkspaceSearchMigrationDescribeTablePhase,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointStore,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
  type WorkspaceSearchMigrationDescribeTableRateLifecycle,
  type WorkspaceSearchMigrationDescribeTableRateObservation,
  type WorkspaceSearchMigrationDescribeTableRatePolicy,
  type WorkspaceSearchMigrationDescribeTableRateRecorder,
  type WorkspaceSearchMigrationDescribeTableRateRegistry,
  WorkspaceSearchMigrationDescribeTableRateError,
  type WorkspaceSearchMigrationDescribeTableRehearsalThrottleAwsTransport,
  type WorkspaceSearchMigrationDescribeTableSingleAttempt,
  type WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
} from './migration-describe-table-rate-budget'

/** Lifetime invalidated when one public managed callback has settled. */
type ManagedDescribeTableExecutionLifetime = {
  /** Whether descendants may still consume this callback's capability. */
  active: boolean
}

/** Execution surface inherited by one managed asynchronous call chain. */
type ManagedDescribeTableExecutionSurface =
  | {
    /** A normal checkpoint-page reservation owns all attempts. */
    readonly kind: 'page'
    /** Opaque page capability issued by the rate lifecycle. */
    readonly page: WorkspaceSearchMigrationDescribeTableCheckpointPage
    /** Callback lifetime preventing escaped descendants from reusing the page. */
    readonly lifetime: ManagedDescribeTableExecutionLifetime
  }
  | {
    /** Mandatory post-send cleanup owns the protected attempts. */
    readonly kind: 'cleanup'
    /** Cleanup-only capability immune to deferred interruption. */
    readonly cleanup: WorkspaceSearchMigrationDescribeTableMandatoryCleanup
    /** Callback lifetime preventing escaped descendants from reusing cleanup. */
    readonly lifetime: ManagedDescribeTableExecutionLifetime
  }
  | {
    /** A complete non-page operation owns the shared admission gate. */
    readonly kind: 'non-page'
    /** Callback lifetime preventing escaped descendants from bypassing FIFO. */
    readonly lifetime: ManagedDescribeTableExecutionLifetime
  }

/** Heartbeat-owned synchronous guard inherited by one supervised task. */
type ManagedDataMutationAdmissionSurface = {
  /** Exact synchronous lease and commit-headroom assertion. */
  readonly guard: () => void
  /** Lifetime preventing escaped descendants from retaining the guard. */
  readonly lifetime: ManagedDescribeTableExecutionLifetime
}

/** Input used to construct and initially claim one production rate controller. */
export type CreateWorkspaceSearchMigrationManagedDescribeTableRateInput = {
  /** Exact requested AWS account shared by identity measurement and the ledger. */
  readonly account: string
  /** Exact requested AWS region shared by identity measurement and the ledger. */
  readonly region: string
  /** Exact six migration table names used only by cleanup recovery. */
  readonly recoveryTableNames: readonly string[]
  /** Complete exact-six or exact-ten physical DescribeTable allowlist. */
  readonly allowedTableNames: readonly string[]
  /** Explicit reviewed rate policy; no service-quota default is accepted. */
  readonly policy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Durable pre-measurement checkpoint store. */
  readonly checkpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore
  /** Static credentials or refreshable provider from the pinned profile. */
  readonly credentials:
    WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration['credentials']
  /** Explicit authority to create the first absent account/region ledger. */
  readonly bootstrap: boolean
  /** Explicit recovery authority for a retained cleanup marker. */
  readonly recoverInterruptedCleanup?: boolean
  /** Explicit recovery authority for an uncertain physical attempt. */
  readonly recoverInterruptedAttempt?: boolean
  /** Optional secret-free observation sink. */
  readonly recorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
  /** Optional cancellation stopping any not-yet-started initial claim CAS. */
  readonly signal?: AbortSignal
}

/** Construction input for the isolated non-production throttle exercise. */
export type CreateWorkspaceSearchMigrationRehearsalManagedDescribeTableRateInput =
  CreateWorkspaceSearchMigrationManagedDescribeTableRateInput & {
    /** Construction-fixed allowlisted table used by the one-shot exercise. */
    readonly exerciseTableName: string
  }

/** Secret-free exact delta produced by one successful throttle exercise. */
export type WorkspaceSearchMigrationRehearsalDescribeTableRateExerciseReceipt = {
  /** Fixed receipt contract version. */
  readonly version: 1
  /** Proves one genuine AWS request returned before fault replacement. */
  readonly awsSuccessfulAttemptCount: 1
  /** Exact deterministic throttle classification added by the exercise. */
  readonly rehearsalInjectedThrottleCount: 1
  /** Exact deterministic budget stop added by the same throttle handling. */
  readonly rehearsalInjectedBudgetStopCount: 1
}

/** Opaque one-shot capability absent from the production rate projection. */
export interface WorkspaceSearchMigrationRehearsalDescribeTableRateExercise {
  /**
   * Runs the construction-fixed read-only exercise exactly once.
   *
   * @returns Secret-free exact source-specific accounting delta.
   */
  run(): Promise<WorkspaceSearchMigrationRehearsalDescribeTableRateExerciseReceipt>
}

/** Separate standard projection and non-production one-shot capability. */
export type WorkspaceSearchMigrationRehearsalManagedDescribeTableRateBundle = {
  /** Frozen production-compatible rate surface without the exercise method. */
  readonly rate: WorkspaceSearchMigrationManagedDescribeTableRate
  /** Opaque one-shot post-success throttle exercise. */
  readonly exercise:
    WorkspaceSearchMigrationRehearsalDescribeTableRateExercise
}

/** Module-owned registrar receiving the hidden rehearsal dispatcher. */
type RegisterWorkspaceSearchMigrationRehearsalDescribeTableRateExercise = (
  dispatch: (
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<never>,
  ) => Promise<WorkspaceSearchMigrationRehearsalDescribeTableRateExerciseReceipt>,
) => void

/** Detached construction snapshot read once before the first async boundary. */
type ManagedDescribeTableRateConstructionSnapshot = {
  /** Exact requested AWS account. */
  readonly account: string
  /** Exact requested AWS region. */
  readonly region: string
  /** Exact six distinct migration table names used by cleanup recovery. */
  readonly recoveryTableNames: readonly string[]
  /** Complete detached exact-six or exact-ten DescribeTable allowlist. */
  readonly allowedTableNames: readonly string[]
  /** Detached reviewed rate policy. */
  readonly policy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Captured durable checkpoint store capability. */
  readonly checkpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore
  /** Captured credentials or provider validated by transport construction. */
  readonly credentials:
    WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration['credentials']
  /** Explicit first-checkpoint bootstrap authority. */
  readonly bootstrap: boolean
  /** Explicit cleanup-marker recovery authority. */
  readonly recoverInterruptedCleanup: boolean
  /** Explicit uncertain-attempt recovery authority. */
  readonly recoverInterruptedAttempt: boolean
  /** Optional captured secret-free observation sink. */
  readonly recorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
  /** Optional captured initial-claim cancellation. */
  readonly signal?: AbortSignal
}

/** Input for one exact policy-sized managed checkpoint page. */
export type RunWorkspaceSearchMigrationManagedDescribeTablePageInput = {
  /** Optional operator or heartbeat-owned cancellation signal. */
  readonly signal?: AbortSignal
}

/**
 * Production lifecycle capability used by the managed AWS session.
 *
 * The implementation owns the only nominal DescribeTable transport available
 * to production composition. Callers can request a page boundary but cannot
 * access its page or mandatory-cleanup capabilities.
 */
export interface WorkspaceSearchMigrationManagedDescribeTableRate {
  /**
   * Runs one non-page or current-page DescribeTable operation.
   *
   * @param tableName - Exact validated physical table name.
   * @param phase - Secret-free semantic accounting phase.
   * @param signal - Optional cancellation for work not yet sent.
   * @returns Raw DescribeTable output retained inside the identity adapter.
   */
  describeTable(
    tableName: string,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    signal?: AbortSignal,
  ): Promise<DescribeTableCommandOutput>

  /**
   * Runs one complete logical checkpoint operation under 182 reserved permits.
   *
   * @param input - Optional cancellation linked to the page admission.
   * @param task - Operation whose internal DescribeTable calls consume the page.
   * @returns Exact operation result.
   */
  runCheckpointPage<Result>(
    input: RunWorkspaceSearchMigrationManagedDescribeTablePageInput,
    task: () => Promise<Result>,
  ): Promise<Result>

  /**
   * Runs an irreversible send and its mandatory post-send guards.
   *
   * @param task - Send and required guard sequence.
   * @returns Exact task result after cleanup accounting is durable.
   */
  runMandatoryCleanup<Result>(task: () => Promise<Result>): Promise<Result>

  /**
   * Runs one complete non-page measurement or all-six guard sequence.
   *
   * This gate is atomic with checkpoint-page admission. Nested DescribeTable
   * calls use normal ledger permits and can never inherit a page capability.
   *
   * @param task - Complete non-page operation sharing exclusive ownership.
   * @returns Exact operation result.
   */
  runNonPageOperation<Result>(task: () => Promise<Result>): Promise<Result>

  /**
   * Installs one synchronous supervision guard for every nested data mutation.
   *
   * @param guard - Current lease and commit-headroom assertion.
   * @param task - Complete heartbeat-supervised operation.
   * @returns Exact task result while the guard lifetime remains active.
   */
  runWithMutationAdmissionGuard<Result>(
    guard: () => void,
    task: () => Promise<Result>,
  ): Promise<Result>

  /** Rejects a new AWS data mutation after interruption or quarantine. */
  assertNewDataIoAllowed(): void

  /** Claims a new durable rate fence after a higher application lease. */
  claimAfterLease(fenceToken: number): Promise<void>

  /** Interrupts unsent work and defers the transition across cleanup. */
  interrupt(): void

  /** Permanently quarantines the active handle. */
  quarantine(): void

  /** Reads the current secret-free aggregate while the scope is quiescent. */
  readEvidence(): WorkspaceSearchMigrationDescribeTableRateEvidence

  /**
   * Stops admission, drains every admitted owner, and returns final evidence.
   *
   * @returns Final aggregate sampled after the serialized gate is quiescent.
   */
  closeAndReadEvidence():
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence>

  /**
   * Permanently closes the lifecycle and drains the dedicated transport.
   *
   * @returns Completion after every admitted owner and cleanup has settled.
   */
  close(): Promise<void>
}

/** Stable failure raised by invalid managed rate composition. */
export class WorkspaceSearchMigrationManagedDescribeTableRateError
  extends Error {
  /** Stable raw-value-free failure code. */
  readonly code = 'MANAGED_DESCRIBE_TABLE_RATE_FAILED'

  /** Creates one fixed-message error. */
  constructor() {
    super('MANAGED_DESCRIBE_TABLE_RATE_FAILED')
    this.name = 'WorkspaceSearchMigrationManagedDescribeTableRateError'
  }
}

/** Private concrete controller retaining the current fenced lifecycle. */
class ManagedDescribeTableRate
  implements WorkspaceSearchMigrationManagedDescribeTableRate {
  /** Dedicated nominal one-attempt transport. */
  readonly #transport:
    WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport

  /** Durable store used to derive restart-safe successor fences. */
  readonly #checkpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore

  /** Registry sharing one account/region ledger in this process. */
  readonly #registry: ReturnType<
    typeof createWorkspaceSearchMigrationDescribeTableRateRegistry
  >

  /** Exact requested AWS account. */
  readonly #account: string

  /** Exact requested AWS region. */
  readonly #region: string

  /** Complete immutable physical table allowlist for every attempt surface. */
  readonly #allowedTableNames: ReadonlySet<string>

  /** Asynchronous capability context isolated across concurrent call chains. */
  readonly #surface =
    new AsyncLocalStorage<ManagedDescribeTableExecutionSurface>()

  /** Synchronous heartbeat guard inherited independently of rate surfaces. */
  readonly #mutationAdmissionSurface =
    new AsyncLocalStorage<ManagedDataMutationAdmissionSurface>()

  /** Current durably claimed lifecycle. */
  #lifecycle: WorkspaceSearchMigrationDescribeTableRateLifecycle

  /** Most recently claimed durable rate fence. */
  #rateFenceToken: number

  /** Highest application lease fence adopted by this process. */
  #leaseFenceToken: number | undefined

  /** FIFO tail atomically serializing pages, non-page operations, and claims. */
  #gateTail: Promise<void> = Promise.resolve()

  /** Controller state rejecting every newly requested external operation. */
  #status: 'active' | 'interrupted' | 'quarantined' | 'closed' = 'active'

  /** Cancellation propagated into any successor-fence claim boundary. */
  readonly #claimAbortController = new AbortController()

  /** Exact-once completion for dedicated transport closure. */
  #closeCompletion: Promise<void> | undefined

  /** Exact-once final aggregate sampled immediately before transport closure. */
  #closeEvidenceCompletion:
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence> | undefined

  /**
   * Retains one already constructed and durably claimed controller.
   *
   * @param snapshot - Detached construction dependencies.
   * @param lifecycle - Initial measurement lifecycle.
   * @param rateFenceToken - Durable initial fence.
   * @param registry - Exact process-local registry that issued the lifecycle.
   * @param transport - Already validated dedicated one-attempt transport.
   * @param registerRehearsalExercise - Optional module-owned hidden registrar.
   */
  constructor(
    snapshot: ManagedDescribeTableRateConstructionSnapshot,
    lifecycle: WorkspaceSearchMigrationDescribeTableRateLifecycle,
    rateFenceToken: number,
    registry: WorkspaceSearchMigrationDescribeTableRateRegistry,
    transport: WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
    registerRehearsalExercise?:
      RegisterWorkspaceSearchMigrationRehearsalDescribeTableRateExercise,
  ) {
    this.#account = snapshot.account
    this.#region = snapshot.region
    this.#allowedTableNames = new Set(snapshot.allowedTableNames)
    this.#checkpointStore = snapshot.checkpointStore
    this.#registry = registry
    this.#transport = transport
    this.#lifecycle = lifecycle
    this.#rateFenceToken = rateFenceToken
    registerRehearsalExercise?.(
      (attempt) => this.#runRehearsalExercise(attempt),
    )
  }

  /** Runs one attempt through the inherited page, cleanup, or lifecycle. */
  describeTable(
    tableName: string,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    signal?: AbortSignal,
  ): Promise<DescribeTableCommandOutput> {
    this.#requireAllowedTableName(tableName)
    const surface = this.#surface.getStore()
    requireActiveManagedSurface(surface)
    if (surface?.kind === 'page') {
      const attempt = this.#createAllowedAttempt(tableName)
      return surface.page.runDescribeTableAttempt({ phase, signal }, attempt)
    }
    if (surface?.kind === 'cleanup') {
      const attempt = this.#createAllowedAttempt(tableName)
      return surface.cleanup.runDescribeTableAttempt(
        { phase: 'post-send-guard' },
        attempt,
      )
    }
    if (surface?.kind === 'non-page') {
      this.#requireAccepting()
      const attempt = this.#createAllowedAttempt(tableName)
      return this.#lifecycle.runDescribeTableAttempt(
        { phase, signal },
        attempt,
      )
    }
    return this.runNonPageOperation(
      async () => await this.describeTable(tableName, phase, signal),
    )
  }

  /** Runs one serialized exact-size checkpoint page. */
  async runCheckpointPage<Result>(
    input: RunWorkspaceSearchMigrationManagedDescribeTablePageInput,
    task: () => Promise<Result>,
  ): Promise<Result> {
    this.#requireAccepting()
    if (this.#surface.getStore() !== undefined) return failManagedRate()
    const signal = readCheckpointPageSignal(input)
    const interrupt = (): void => this.interrupt()
    signal?.addEventListener('abort', interrupt, { once: true })
    try {
      if (signal?.aborted === true) this.interrupt()
      return await this.#runExclusive(
        async () => await this.#lifecycle.runCheckpointPage(
          signal === undefined ? {} : { signal },
          async (page) => {
            const lifetime = createManagedSurfaceLifetime()
            try {
              return await this.#surface.run(
                { kind: 'page', page, lifetime },
                task,
              )
            } finally {
              lifetime.active = false
            }
          },
        ),
      )
    } finally {
      signal?.removeEventListener('abort', interrupt)
    }
  }

  /** Runs one mandatory cleanup only from the active page chain. */
  async runMandatoryCleanup<Result>(
    task: () => Promise<Result>,
  ): Promise<Result> {
    const surface = this.#surface.getStore()
    requireActiveManagedSurface(surface)
    if (surface === undefined) {
      return await this.runCheckpointPage(
        {},
        async () => await this.runMandatoryCleanup(task),
      )
    }
    if (surface?.kind !== 'page') return failManagedRate()
    return await surface.page.runMandatoryCleanup(
      async (cleanup) => {
        const lifetime = createManagedSurfaceLifetime()
        try {
          return await this.#surface.run(
            { kind: 'cleanup', cleanup, lifetime },
            task,
          )
        } finally {
          lifetime.active = false
        }
      },
    )
  }

  /** Runs one complete non-page operation under exclusive gate ownership. */
  async runNonPageOperation<Result>(
    task: () => Promise<Result>,
  ): Promise<Result> {
    const surface = this.#surface.getStore()
    requireActiveManagedSurface(surface)
    if (surface !== undefined) return await task()
    this.#requireAccepting()
    return await this.#runExclusive(
      async () => {
        const lifetime = createManagedSurfaceLifetime()
        try {
          return await this.#surface.run(
            { kind: 'non-page', lifetime },
            task,
          )
        } finally {
          lifetime.active = false
        }
      },
    )
  }

  /** Installs one synchronous mutation guard for an exact task lifetime. */
  async runWithMutationAdmissionGuard<Result>(
    guard: () => void,
    task: () => Promise<Result>,
  ): Promise<Result> {
    if (typeof guard !== 'function' || typeof task !== 'function') {
      return failManagedRate()
    }
    const inherited = this.#mutationAdmissionSurface.getStore()
    requireActiveManagedMutationAdmissionSurface(inherited)
    if (inherited !== undefined) return failManagedRate()
    this.#requireAccepting()
    const lifetime = createManagedSurfaceLifetime()
    const surface: ManagedDataMutationAdmissionSurface = Object.freeze({
      guard,
      lifetime,
    })
    try {
      return await this.#mutationAdmissionSurface.run(surface, task)
    } finally {
      lifetime.active = false
    }
  }

  /** Rejects a new AWS data mutation after admission has stopped. */
  assertNewDataIoAllowed(): void {
    const admissionSurface = this.#mutationAdmissionSurface.getStore()
    requireActiveManagedMutationAdmissionSurface(admissionSurface)
    const surface = this.#surface.getStore()
    requireActiveManagedSurface(surface)
    try {
      admissionSurface?.guard()
    } catch (error: unknown) {
      if (surface?.kind === 'cleanup') {
        try {
          surface.cleanup.rejectDataMutationBeforeStart()
        } catch {
          // Marker retention is the safe fallback for an invalid capability.
        }
      }
      throw error
    }
    if (surface?.kind === 'cleanup') {
      try {
        surface.cleanup.beginDataMutation()
      } catch {
        return failManagedRate()
      }
      return
    }
    this.#requireAccepting()
  }

  /** Claims the next durable rate fence after a strictly higher lease. */
  async claimAfterLease(fenceToken: number): Promise<void> {
    this.#requireAccepting()
    if (
      !Number.isSafeInteger(fenceToken) ||
      fenceToken <= 0 ||
      (this.#leaseFenceToken !== undefined &&
        fenceToken <= this.#leaseFenceToken)
    ) {
      return failManagedRate()
    }
    const surface = this.#surface.getStore()
    requireActiveManagedSurface(surface)
    if (surface?.kind === 'non-page') {
      await this.#claimAfterLeaseWithinGate(fenceToken)
      return
    }
    if (surface !== undefined) return failManagedRate()
    await this.#runExclusive(
      async () => await this.#claimAfterLeaseWithinGate(fenceToken),
    )
  }

  /** Interrupts current and queued unsent calls. */
  interrupt(): void {
    if (this.#status !== 'active') return
    this.#status = 'interrupted'
    this.#claimAbortController.abort()
    this.#lifecycle.interrupt()
  }

  /** Quarantines the current rate lifecycle. */
  quarantine(): void {
    if (this.#status === 'closed' || this.#status === 'quarantined') return
    this.#status = 'quarantined'
    this.#claimAbortController.abort()
    this.#lifecycle.quarantine()
  }

  /** Returns the identifier-free aggregate from the current lifecycle. */
  readEvidence(): WorkspaceSearchMigrationDescribeTableRateEvidence {
    if (this.#status === 'closed') return failManagedRate()
    return this.#lifecycle.readEvidence()
  }

  /** Stops admission, drains the gate, and snapshots final rate evidence. */
  closeAndReadEvidence():
    Promise<WorkspaceSearchMigrationDescribeTableRateEvidence> {
    const existing = this.#closeEvidenceCompletion
    if (existing !== undefined) return existing
    this.#status = 'closed'
    this.#claimAbortController.abort()
    this.#lifecycle.close()
    /** Seals this admission controller and returns its final evidence once. */
    const finish = (): WorkspaceSearchMigrationDescribeTableRateEvidence => {
      const evidence = Object.freeze(this.#lifecycle.readEvidence())
      this.#transport.close()
      return evidence
    }
    const completion = this.#gateTail.then(finish, finish)
    this.#closeEvidenceCompletion = completion
    return completion
  }

  /** Closes the lifecycle and transport once, after any active page settles. */
  close(): Promise<void> {
    const existing = this.#closeCompletion
    if (existing !== undefined) return existing
    const completion = this.closeAndReadEvidence().then(() => undefined)
    this.#closeCompletion = completion
    return completion
  }

  /**
   * Reconciles explicitly authorized restart markers before exposure.
   *
   * @param recoverAttempt - Whether one already-fenced uncertain attempt exists.
   * @param recoverCleanup - Whether all six table guards must be rerun.
   * @param recoveryTableNames - Detached exact six migration table names.
   */
  async recoverAuthorizedInterruptedState(
    recoverAttempt: boolean,
    recoverCleanup: boolean,
    recoveryTableNames: readonly string[],
  ): Promise<void> {
    if (recoverAttempt) {
      await this.#lifecycle.recoverInterruptedAttempt(
        async (): Promise<void> => {},
      )
    }
    if (recoverCleanup) {
      await this.#lifecycle.recoverInterruptedCleanup(async (cleanup) => {
        for (const tableName of recoveryTableNames) {
          const attempt = this.#createAllowedAttempt(tableName)
          await cleanup.runDescribeTableAttempt(
            { phase: 'reconciliation' },
            attempt,
          )
        }
      })
    }
  }

  /**
   * Executes one real attempt whose successful response becomes a fault.
   *
   * @param attempt - Construction-fixed post-success throttle attempt.
   * @returns Exact source-specific counter delta after expected stop handling.
   */
  async #runRehearsalExercise(
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<never>,
  ): Promise<WorkspaceSearchMigrationRehearsalDescribeTableRateExerciseReceipt> {
    const before = this.readEvidence()
    try {
      await this.#runExclusive(
        async () => await this.#lifecycle.runDescribeTableAttempt(
          { phase: 'measurement' },
          attempt,
        ),
      )
      return failManagedRate()
    } catch (error: unknown) {
      if (
        !(error instanceof WorkspaceSearchMigrationDescribeTableRateError) ||
        error.reason !== 'throttled'
      ) return failManagedRate()
    }
    const after = this.readEvidence()
    if (
      after.attemptCount !== before.attemptCount + 1 ||
      after.throttleCount !== before.throttleCount + 1 ||
      after.awsServiceThrottleCount !== before.awsServiceThrottleCount ||
      after.rehearsalInjectedThrottleCount !==
        before.rehearsalInjectedThrottleCount + 1 ||
      after.budgetStopCount !== before.budgetStopCount + 1 ||
      after.operationalBudgetStopCount !==
        before.operationalBudgetStopCount ||
      after.awsServiceThrottleBudgetStopCount !==
        before.awsServiceThrottleBudgetStopCount ||
      after.rehearsalInjectedBudgetStopCount !==
        before.rehearsalInjectedBudgetStopCount + 1
    ) return failManagedRate()
    return Object.freeze({
      version: 1,
      awsSuccessfulAttemptCount: 1,
      rehearsalInjectedThrottleCount: 1,
      rehearsalInjectedBudgetStopCount: 1,
    })
  }

  /**
   * Runs one operation after atomically joining the FIFO ownership gate.
   *
   * @param task - Page, non-page operation, or successor-fence claim.
   * @returns Exact task result while later owners remain blocked.
   */
  async #runExclusive<Result>(task: () => Promise<Result>): Promise<Result> {
    this.#requireAccepting()
    const predecessor = this.#gateTail
    let release = (): void => {}
    const completion = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#gateTail = predecessor.then(
      () => completion,
      () => completion,
    )
    await predecessor
    try {
      this.#requireAccepting()
      return await task()
    } finally {
      release()
    }
  }

  /**
   * Claims a successor while the caller already owns the exclusive gate.
   *
   * @param fenceToken - Strictly increasing application lease fence.
   */
  async #claimAfterLeaseWithinGate(fenceToken: number): Promise<void> {
    if (
      this.#leaseFenceToken !== undefined &&
      fenceToken <= this.#leaseFenceToken
    ) {
      return failManagedRate()
    }
    const nextFence = await this.#readNextFenceToken()
    this.#requireAccepting()
    const successor = await this.#registry.claim({
      account: this.#account,
      region: this.#region,
      fenceToken: nextFence,
      bootstrap: false,
      recoverInterruptedCleanup: false,
      recoverInterruptedAttempt: false,
      signal: this.#claimAbortController.signal,
    })
    this.#lifecycle = successor
    this.#rateFenceToken = nextFence
    this.#leaseFenceToken = fenceToken
  }

  /** Reads and validates the next durable monotonically increasing fence. */
  async #readNextFenceToken(): Promise<number> {
    const stored = await this.#checkpointStore.load(
      createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
        this.#account,
        this.#region,
      ),
    )
    if (stored === undefined) return failManagedRate()
    const fence = readStoredFenceToken(stored)
    const next = fence + 1
    if (!Number.isSafeInteger(next) || next <= this.#rateFenceToken) {
      return failManagedRate()
    }
    return next
  }

  /** Fails after interruption, quarantine, or close stopped admission. */
  #requireAccepting(): void {
    if (this.#status !== 'active') return failManagedRate()
  }

  /**
   * Creates one transport attempt only for a construction-pinned table.
   *
   * @param tableName - Candidate physical DynamoDB table name.
   * @returns Nominal one-shot attempt for the exact allowlisted table.
   */
  #createAllowedAttempt(
    tableName: string,
  ): ReturnType<
    WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport[
      'createAttempt'
    ]
  > {
    this.#requireAllowedTableName(tableName)
    return this.#transport.createAttempt(tableName)
  }

  /**
   * Rejects a table before any nominal attempt or rate side effect exists.
   *
   * @param tableName - Candidate physical DynamoDB table name.
   */
  #requireAllowedTableName(tableName: string): void {
    if (!this.#allowedTableNames.has(tableName)) return failManagedRate()
  }
}

/**
 * Creates the production managed rate controller and claims measurement first.
 *
 * An absent ledger is created only when `bootstrap` is explicitly true. Every
 * later process loads the durable fence and claims its strict successor, so a
 * restarted measurement never reuses fence zero.
 *
 * @param input - Reviewed policy, pinned credentials, and durable store.
 * @returns Claimed controller ready for the first measured DescribeTable.
 */
export async function createWorkspaceSearchMigrationManagedDescribeTableRate(
  input: CreateWorkspaceSearchMigrationManagedDescribeTableRateInput,
): Promise<WorkspaceSearchMigrationManagedDescribeTableRate> {
  const snapshot = detachManagedRateConstructionInput(input)
  return await createManagedDescribeTableRateFromSnapshot(snapshot)
}

/**
 * Creates one managed controller from an already detached construction input.
 *
 * @param snapshot - Detached standard construction input.
 * @param registerRehearsalExercise - Optional non-production dispatcher sink.
 * @returns Exact hidden controller after claim and authorized recovery.
 */
async function createManagedDescribeTableRateFromSnapshot(
  snapshot: ManagedDescribeTableRateConstructionSnapshot,
  registerRehearsalExercise?:
    RegisterWorkspaceSearchMigrationRehearsalDescribeTableRateExercise,
): Promise<ManagedDescribeTableRate> {
  const signal = snapshot.signal
  requireManagedRateSignalActive(signal)
  let transport:
    WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport
  try {
    transport =
      createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport({
        account: snapshot.account,
        region: snapshot.region,
        credentials: snapshot.credentials,
      })
  } catch {
    return failManagedRate()
  }
  let registry: WorkspaceSearchMigrationDescribeTableRateRegistry
  try {
    if (
      snapshot.policy.checkpointPageAttemptCapacity !==
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS
    ) {
      return failManagedRate()
    }
    registry = createWorkspaceSearchMigrationDescribeTableRateRegistry({
      policy: snapshot.policy,
      checkpointStore: snapshot.checkpointStore,
      ...(snapshot.recorder === undefined
        ? {}
        : { recorder: snapshot.recorder }),
    })
  } catch (error: unknown) {
    closeManagedRateTransport(transport)
    throw error
  }
  let lifecycle: WorkspaceSearchMigrationDescribeTableRateLifecycle
  let fenceToken: number
  try {
    const scope =
      createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
        snapshot.account,
        snapshot.region,
      )
    const stored = await snapshot.checkpointStore.load(scope)
    requireManagedRateSignalActive(signal)
    fenceToken = stored === undefined
      ? 0
      : readStoredFenceToken(stored) + 1
    if (!Number.isSafeInteger(fenceToken)) return failManagedRate()
    lifecycle = await registry.claim({
      account: snapshot.account,
      region: snapshot.region,
      fenceToken,
      bootstrap: snapshot.bootstrap,
      recoverInterruptedCleanup: snapshot.recoverInterruptedCleanup,
      recoverInterruptedAttempt: snapshot.recoverInterruptedAttempt,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error: unknown) {
    closeManagedRateTransport(transport)
    throw error
  }
  const controller = new ManagedDescribeTableRate(
    snapshot,
    lifecycle,
    fenceToken,
    registry,
    transport,
    registerRehearsalExercise,
  )
  /** Stops the newly constructed controller if cancellation races recovery. */
  const interrupt = (): void => controller.interrupt()
  signal?.addEventListener('abort', interrupt, { once: true })
  try {
    if (signal?.aborted === true) controller.interrupt()
    await controller.recoverAuthorizedInterruptedState(
      snapshot.recoverInterruptedAttempt,
      snapshot.recoverInterruptedCleanup,
      snapshot.recoveryTableNames,
    )
    requireManagedRateSignalActive(signal)
  } catch (error: unknown) {
    try {
      await controller.close()
    } catch {
      // Preserve the recovery failure that prevents session exposure.
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', interrupt)
  }
  return controller
}

/**
 * Creates a separately projected non-production post-success fault bundle.
 *
 * The standard rate object contains only production methods. The construction-
 * fixed table name and separate transport remain captured by an opaque one-shot
 * capability, so neither can be selected or reflected at execution time.
 *
 * @param input - Standard rate construction plus one allowlisted fixed table.
 * @returns Frozen standard projection and isolated exactly-once capability.
 */
export async function createWorkspaceSearchMigrationRehearsalManagedDescribeTableRate(
  input:
    CreateWorkspaceSearchMigrationRehearsalManagedDescribeTableRateInput,
): Promise<WorkspaceSearchMigrationRehearsalManagedDescribeTableRateBundle> {
  const snapshot = detachManagedRateConstructionInput(input)
  const exerciseTableName = detachExerciseTableName(
    readExerciseTableNameCandidate(input),
    snapshot.allowedTableNames,
  )
  const dispatchHolder: {
    dispatch?: (
      attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<never>,
    ) => Promise<WorkspaceSearchMigrationRehearsalDescribeTableRateExerciseReceipt>
  } = {}
  const controller = await createManagedDescribeTableRateFromSnapshot(
    snapshot,
    (dispatch) => {
      dispatchHolder.dispatch = dispatch
    },
  )
  const dispatchExercise = dispatchHolder.dispatch
  if (dispatchExercise === undefined) {
    await controller.close()
    return failManagedRate()
  }
  let exerciseTransport:
    WorkspaceSearchMigrationDescribeTableRehearsalThrottleAwsTransport
  try {
    exerciseTransport =
      createWorkspaceSearchMigrationDescribeTableRehearsalThrottleAwsTransport({
        account: snapshot.account,
        region: snapshot.region,
        credentials: snapshot.credentials,
      })
  } catch (error: unknown) {
    await controller.close()
    throw error
  }
  const rate = createRehearsalStandardRateProjection(
    controller,
    exerciseTransport,
  )
  let exercised = false
  const exercise:
    WorkspaceSearchMigrationRehearsalDescribeTableRateExercise =
      Object.freeze({
        run: async () => {
          if (exercised) return failManagedRate()
          exercised = true
          const attempt =
            exerciseTransport.createAfterSuccessThrottleAttempt(
              exerciseTableName,
            )
          return await dispatchExercise(attempt)
        },
      })
  return Object.freeze({ rate, exercise })
}

/**
 * Reads the exercise table only from one own data property.
 *
 * @param input - Candidate rehearsal construction record.
 * @returns Untrusted own data value without invoking an accessor.
 */
function readExerciseTableNameCandidate(
  input: CreateWorkspaceSearchMigrationRehearsalManagedDescribeTableRateInput,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(
    input,
    'exerciseTableName',
  )
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return failManagedRate()
  }
  return descriptor.value
}

/**
 * Projects the controller without exposing its constructor or exercise state.
 *
 * @param controller - Hidden production-compatible controller.
 * @param exerciseTransport - Separately owned rehearsal-only transport.
 * @returns Frozen standard rate surface that closes both owned transports.
 */
function createRehearsalStandardRateProjection(
  controller: ManagedDescribeTableRate,
  exerciseTransport:
    WorkspaceSearchMigrationDescribeTableRehearsalThrottleAwsTransport,
): WorkspaceSearchMigrationManagedDescribeTableRate {
  let exerciseTransportClosed = false
  /** Closes the separate rehearsal transport exactly once. */
  const closeExerciseTransport = (): void => {
    if (exerciseTransportClosed) return
    exerciseTransportClosed = true
    exerciseTransport.close()
  }
  return Object.freeze({
    describeTable: async (
      tableName: string,
      phase: WorkspaceSearchMigrationDescribeTablePhase,
      signal?: AbortSignal,
    ) => await controller.describeTable(tableName, phase, signal),
    runCheckpointPage: async <Result>(
      input: RunWorkspaceSearchMigrationManagedDescribeTablePageInput,
      task: () => Promise<Result>,
    ) => await controller.runCheckpointPage(input, task),
    runMandatoryCleanup: async <Result>(task: () => Promise<Result>) =>
      await controller.runMandatoryCleanup(task),
    runNonPageOperation: async <Result>(task: () => Promise<Result>) =>
      await controller.runNonPageOperation(task),
    runWithMutationAdmissionGuard: async <Result>(
      guard: () => void,
      task: () => Promise<Result>,
    ) => await controller.runWithMutationAdmissionGuard(guard, task),
    assertNewDataIoAllowed: (): void =>
      controller.assertNewDataIoAllowed(),
    claimAfterLease: async (fenceToken: number): Promise<void> =>
      await controller.claimAfterLease(fenceToken),
    interrupt: (): void => controller.interrupt(),
    quarantine: (): void => controller.quarantine(),
    readEvidence: () => controller.readEvidence(),
    closeAndReadEvidence: async () => {
      try {
        return await controller.closeAndReadEvidence()
      } finally {
        closeExerciseTransport()
      }
    },
    close: async (): Promise<void> => {
      try {
        await controller.close()
      } finally {
        closeExerciseTransport()
      }
    },
  })
}

/**
 * Validates the construction-fixed exercise table against the allowlist.
 *
 * @param value - Candidate table name read before capability construction.
 * @param allowedTableNames - Detached standard controller allowlist.
 * @returns Exact fixed table name retained only by the one-shot closure.
 */
function detachExerciseTableName(
  value: unknown,
  allowedTableNames: readonly string[],
): string {
  if (!isManagedRateTableName(value) || !allowedTableNames.includes(value)) {
    return failManagedRate()
  }
  return value
}

/** Reads every construction field once before any asynchronous boundary. */
function detachManagedRateConstructionInput(
  input: CreateWorkspaceSearchMigrationManagedDescribeTableRateInput,
): ManagedDescribeTableRateConstructionSnapshot {
  let account: string
  let region: string
  let recoveryTableNamesInput: readonly string[]
  let allowedTableNamesInput: readonly string[]
  let policy: WorkspaceSearchMigrationDescribeTableRatePolicy
  let checkpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore
  let credentials:
    WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration['credentials']
  let bootstrap: boolean
  let recoverInterruptedCleanup: boolean
  let recoverInterruptedAttempt: boolean
  let recorder: WorkspaceSearchMigrationDescribeTableRateRecorder | undefined
  let signal: AbortSignal | undefined
  try {
    account = input.account
    region = input.region
    recoveryTableNamesInput = input.recoveryTableNames
    allowedTableNamesInput = input.allowedTableNames
    policy = structuredClone(input.policy)
    checkpointStore = input.checkpointStore
    credentials = input.credentials
    bootstrap = input.bootstrap
    recoverInterruptedCleanup = input.recoverInterruptedCleanup ?? false
    recoverInterruptedAttempt = input.recoverInterruptedAttempt ?? false
    recorder = input.recorder
    signal = input.signal
  } catch {
    return failManagedRate()
  }
  if (
    typeof bootstrap !== 'boolean' ||
    typeof recoverInterruptedCleanup !== 'boolean' ||
    typeof recoverInterruptedAttempt !== 'boolean' ||
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    typeof checkpointStore !== 'object' ||
    checkpointStore === null ||
    (
      recorder !== undefined &&
      (typeof recorder !== 'object' || recorder === null)
    )
  ) {
    return failManagedRate()
  }
  let load: WorkspaceSearchMigrationDescribeTableRateCheckpointStore['load']
  let compareAndSwap:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore['compareAndSwap']
  let record:
    WorkspaceSearchMigrationDescribeTableRateRecorder['record'] | undefined
  try {
    load = checkpointStore.load
    compareAndSwap = checkpointStore.compareAndSwap
    record = recorder?.record
  } catch {
    return failManagedRate()
  }
  if (
    typeof load !== 'function' ||
    typeof compareAndSwap !== 'function' ||
    (recorder !== undefined && typeof record !== 'function')
  ) {
    return failManagedRate()
  }
  const capturedCheckpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore =
      Object.freeze({
        load: (scopeBindingDigest: string) =>
          Reflect.apply(load, checkpointStore, [scopeBindingDigest]),
        compareAndSwap: (
          write: WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
        ) =>
          Reflect.apply(compareAndSwap, checkpointStore, [write]),
      })
  const capturedRecorder:
    WorkspaceSearchMigrationDescribeTableRateRecorder | undefined =
      recorder === undefined || record === undefined
        ? undefined
        : Object.freeze({
          record: (
            observation:
              WorkspaceSearchMigrationDescribeTableRateObservation,
          ): void => {
            Reflect.apply(record, recorder, [observation])
          },
        })
  const recoveryTableNames = detachRecoveryTableNames(
    recoveryTableNamesInput,
  )
  const allowedTableNames = detachAllowedTableNames(
    allowedTableNamesInput,
    recoveryTableNames,
  )
  return Object.freeze({
    account,
    region,
    recoveryTableNames,
    allowedTableNames,
    policy: Object.freeze(policy),
    checkpointStore: capturedCheckpointStore,
    credentials,
    bootstrap,
    recoverInterruptedCleanup,
    recoverInterruptedAttempt,
    ...(capturedRecorder === undefined
      ? {}
      : { recorder: capturedRecorder }),
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Stops composition before its next durable checkpoint mutation can start. */
function requireManagedRateSignalActive(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) return failManagedRate()
}

/** Creates one mutable lifetime token owned by an exact callback boundary. */
function createManagedSurfaceLifetime():
  ManagedDescribeTableExecutionLifetime {
  return { active: true }
}

/** Rejects an asynchronous descendant that escaped its callback boundary. */
function requireActiveManagedSurface(
  surface: ManagedDescribeTableExecutionSurface | undefined,
): void {
  if (surface !== undefined && !surface.lifetime.active) {
    return failManagedRate()
  }
}

/** Rejects a descendant retaining a settled heartbeat-guard capability. */
function requireActiveManagedMutationAdmissionSurface(
  surface: ManagedDataMutationAdmissionSurface | undefined,
): void {
  if (surface !== undefined && !surface.lifetime.active) {
    return failManagedRate()
  }
}

/** Snapshots and validates one checkpoint-page cancellation signal. */
function readCheckpointPageSignal(
  input: RunWorkspaceSearchMigrationManagedDescribeTablePageInput,
): AbortSignal | undefined {
  let signal: AbortSignal | undefined
  try {
    signal = input.signal
  } catch {
    return failManagedRate()
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return failManagedRate()
  }
  return signal
}

/** Best-effort closes a pre-claim transport without masking the primary error. */
function closeManagedRateTransport(
  transport: WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
): void {
  try {
    transport.close()
  } catch {
    // The claim or validation failure remains authoritative.
  }
}

/**
 * Detaches and validates the exact six distinct recovery guard table names.
 *
 * @param value - Candidate recovery-only physical table-name vector.
 * @returns Frozen detached exact-six recovery vector.
 */
function detachRecoveryTableNames(value: readonly string[]): readonly string[] {
  let tableNames: string[]
  try {
    tableNames = Array.from(value)
  } catch {
    return failManagedRate()
  }
  if (
    tableNames.length !== 6 ||
    new Set(tableNames).size !== 6 ||
    tableNames.some((tableName) => !isManagedRateTableName(tableName))
  ) {
    return failManagedRate()
  }
  return Object.freeze(tableNames)
}

/**
 * Detaches the complete exact-six or exact-ten physical table allowlist.
 *
 * Every recovery table must remain present. Additional semantic role and
 * shared-name validation belongs to the higher-level identity composition.
 *
 * @param value - Candidate full migration-only or rehearsal union allowlist.
 * @param recoveryTableNames - Validated exact six recovery table names.
 * @returns Frozen detached table-name vector used by every attempt surface.
 */
function detachAllowedTableNames(
  value: readonly string[],
  recoveryTableNames: readonly string[],
): readonly string[] {
  let tableNames: string[]
  try {
    tableNames = Array.from(value)
  } catch {
    return failManagedRate()
  }
  const tableNameSet = new Set(tableNames)
  if (
    (tableNames.length !== 6 && tableNames.length !== 10) ||
    tableNameSet.size !== tableNames.length ||
    tableNames.some((tableName) => !isManagedRateTableName(tableName)) ||
    recoveryTableNames.some((tableName) => !tableNameSet.has(tableName))
  ) {
    return failManagedRate()
  }
  return Object.freeze(tableNames)
}

/**
 * Returns whether one value is a valid physical DynamoDB table name.
 *
 * @param value - Candidate unknown value.
 * @returns Whether the value satisfies DynamoDB table-name syntax and length.
 */
function isManagedRateTableName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 255 &&
    /^[A-Za-z0-9_.-]+$/u.test(value)
}

/** Reads one strict non-negative fence from a trusted store result. */
function readStoredFenceToken(value: unknown): number {
  if (typeof value !== 'object' || value === null) return failManagedRate()
  const descriptor = Object.getOwnPropertyDescriptor(value, 'fenceToken')
  if (descriptor === undefined || !('value' in descriptor)) {
    return failManagedRate()
  }
  const fence = descriptor.value
  if (
    typeof fence !== 'number' ||
    !Number.isSafeInteger(fence) ||
    fence < 0
  ) {
    return failManagedRate()
  }
  return fence
}

/** Raises one stable managed-rate failure. */
function failManagedRate(): never {
  throw new WorkspaceSearchMigrationManagedDescribeTableRateError()
}
