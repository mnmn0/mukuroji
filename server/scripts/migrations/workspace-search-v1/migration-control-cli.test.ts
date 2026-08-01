import { createHash } from 'node:crypto'
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  serializeCanonicalJson,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationLease,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import {
  parseWorkspaceSearchMigrationControlCliArguments,
  readBoundedInputFile,
  runWorkspaceSearchMigrationControlCli,
  type CreateWorkspaceSearchMigrationControlCliMutationSessionInput,
  type CreateWorkspaceSearchMigrationControlCliReadSessionInput,
  type WorkspaceSearchMigrationControlCliDependencies,
  type WorkspaceSearchMigrationControlCliExitCode,
  type WorkspaceSearchMigrationControlCliMutationSession,
  type WorkspaceSearchMigrationControlCliReadSession,
  type WorkspaceSearchMigrationWriterFenceSummary,
} from './migration-control-cli'
import type {
  WorkspaceSearchMigrationControlCoordinatorSummary,
} from './migration-control-coordinator'
import type {
  WorkspaceSearchMigrationExecutionStatus,
} from './migration-execution-supervisor'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
} from './maintenance-evidence'
import type {
  WorkspaceSearchMigrationMaintenanceEvidenceProvider,
} from './migration-post-close-planning-supervisor'
import type {
  RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanAuthorityClaim,
} from './migration-pre-plan-authority-aws'
import type {
  AcquireWorkspaceSearchMigrationLeaseInput,
  HeartbeatWorkspaceSearchMigrationLeaseInput,
} from './migration-state-machine'

const expectedConfigurationHash = '1'.repeat(64)
const differentConfigurationHash = '2'.repeat(64)
const evidenceReceiptDigest = '3'.repeat(64)
const refreshedEvidenceReceiptDigest = '4'.repeat(64)
const writerFenceRecordDigest = '5'.repeat(64)
const rootDirectory = resolve(import.meta.dir, '../../../..')
const ratePolicyPath = '/operator/rate-policy.json'
const maintenanceEvidencePath = '/operator/maintenance-evidence.json'
const reviewedDryRunPath = '/operator/reviewed-dry-run.json'

const resourceFlagArguments: readonly string[] = [
  '--account',
  '123456789012',
  '--region',
  'ap-northeast-1',
  '--profile',
  'migration-operator',
  '--commit',
  'a'.repeat(40),
  '--project-directory-table',
  'project-directory-table',
  '--work-items-table',
  'work-items-table',
  '--collaboration-table',
  'collaboration-table',
  '--documents-table',
  'documents-table',
  '--workspace-search-table',
  'workspace-search-table',
  '--migration-state-table',
  'migration-state-table',
  '--journal-bucket',
  'mukuroji-migration-journal',
  '--journal-key-arn',
  'arn:aws:kms:ap-northeast-1:123456789012:key/12345678-1234-1234-1234-123456789012',
]

const ratePolicyDocument = {
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
}
const ratePolicyBytes = new TextEncoder().encode(
  serializeCanonicalJson(ratePolicyDocument),
)
const policyVersion = createHash('sha256')
  .update(ratePolicyBytes)
  .digest('hex')

/** Options installed on recording CLI sessions. */
type RecordingSessionOptions = {
  /** Optional asynchronous close failure. */
  readonly closeFailure?: unknown
  /** Optional gate holding session close in flight. */
  readonly closeGate?: Promise<void>
  /** Optional gate holding one session factory in flight. */
  readonly factoryGate?: Promise<void>
  /** Optional failure raised by measurement or stage dispatch. */
  readonly failure?: unknown
  /** Configuration hash returned by measurement. */
  readonly measuredConfigurationHash?: string
  /** Writer-fence summary returned by read status. */
  readonly writerFence?: WorkspaceSearchMigrationWriterFenceSummary
  /** Optional gate holding one coordinator stage in flight. */
  readonly stageGate?: Promise<void>
}

/** Shared exact-close and identifier-free rate recording behavior. */
class RecordingSessionBase {
  /** Ordered externally visible operations. */
  readonly events: string[]

  /** Number of lifecycle close calls. */
  closeCount = 0

  /** Optional configured failure. */
  protected readonly failure: unknown

  /** Optional asynchronous close failure. */
  protected readonly closeFailure: unknown

  /** Optional gate holding session close in flight. */
  protected readonly closeGate: Promise<void> | undefined

  /** Configuration hash returned by measurement. */
  protected readonly measuredConfigurationHash: string

  /** Writer-fence status returned by read operations. */
  protected readonly writerFence: WorkspaceSearchMigrationWriterFenceSummary

  /** Optional gate holding one coordinator stage in flight. */
  protected readonly stageGate: Promise<void> | undefined

  /**
   * Creates one deterministic recording base.
   *
   * @param events - Shared ordered event list.
   * @param options - Optional failure and result behavior.
   */
  constructor(events: string[], options: RecordingSessionOptions = {}) {
    this.events = events
    this.closeFailure = options.closeFailure
    this.closeGate = options.closeGate
    this.failure = options.failure
    this.measuredConfigurationHash =
      options.measuredConfigurationHash ?? expectedConfigurationHash
    this.writerFence = options.writerFence ?? { status: 'missing' }
    this.stageGate = options.stageGate
  }

  /**
   * Returns one identifier-free rate aggregate.
   *
   * @returns Fixed policy-bound aggregate.
   */
  readRateAggregate(): WorkspaceSearchMigrationDescribeTableRateEvidence {
    this.events.push('read-rate')
    return {
      version: 1,
      policyVersion,
      attemptCount: 6,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
      cadenceWaitCount: 5,
      cadenceWaitMilliseconds: 100,
      maximumInFlight: 0,
    }
  }

  /** Records immediate cancellation of every unsent rate-managed operation. */
  interrupt(): void {
    this.events.push('interrupt-rate')
  }

  /**
   * Records exact asynchronous lifecycle cleanup.
   *
   * @returns Completion or the configured close failure.
   */
  async close(): Promise<void> {
    this.events.push('close')
    this.closeCount += 1
    if (this.closeGate !== undefined) await this.closeGate
    if (this.closeFailure !== undefined) throw this.closeFailure
  }
}

/** Read-only fake that deliberately has no mutation methods. */
class RecordingReadSession
  extends RecordingSessionBase
  implements WorkspaceSearchMigrationControlCliReadSession {
  /**
   * Records configuration measurement.
   *
   * @returns Configured hash.
   */
  async measureConfigurationHash(): Promise<string> {
    this.events.push('measure')
    if (this.failure !== undefined) throw this.failure
    return this.measuredConfigurationHash
  }

  /**
   * Records writer-fence status.
   *
   * @returns Configured safe summary.
   */
  async readWriterFence(): Promise<WorkspaceSearchMigrationWriterFenceSummary> {
    this.events.push('read-writer-fence')
    return this.writerFence
  }

  /**
   * Records durable execution-status reconstruction.
   *
   * @param _runId - Exact durable run.
   * @param _expectedConfigurationHash - Reviewed digest.
   * @returns Fixed safe execution projection.
   */
  async readExecutionStatus(
    _runId: string,
    _expectedConfigurationHash: string,
  ): Promise<WorkspaceSearchMigrationExecutionStatus> {
    this.events.push('read-execution-status')
    if (this.failure !== undefined) throw this.failure
    return { phase: 'ready', nextAction: { kind: 'apply' } }
  }
}

/** Explicit mutating fake used only after mutation-factory selection. */
class RecordingMutationSession
  extends RecordingSessionBase
  implements WorkspaceSearchMigrationControlCliMutationSession {
  /** Last stage mode requested by the CLI. */
  stageMode: string | undefined

  /** Last maintenance renewal input. */
  renewalInput:
    RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput | undefined

  /** Last current-authority claim. */
  authorityClaim:
    WorkspaceSearchMigrationPrePlanAuthorityClaim | undefined

  /**
   * Records installation of one nested mutation guard.
   *
   * @param guard - Supervisor assertion inherited by the task.
   * @param task - Exact task to execute.
   * @returns Exact task result.
   */
  async runWithMutationAdmissionGuard<Result>(
    guard: () => void,
    task: () => Promise<Result>,
  ): Promise<Result> {
    this.events.push('install-mutation-admission-guard')
    guard()
    return await task()
  }

  /** Records fail-closed admission interruption from lease supervision. */
  interruptMutationAdmission(): void {
    this.events.push('interrupt-mutation-admission')
  }

  /**
   * Records configuration measurement.
   *
   * @returns Configured hash.
   */
  async measureConfigurationHash(): Promise<string> {
    this.events.push('measure')
    if (this.failure !== undefined) throw this.failure
    return this.measuredConfigurationHash
  }

  /**
   * Records lease acquisition.
   *
   * @param input - Exact run and owner.
   * @returns Fixed fresh lease.
   */
  async acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    this.events.push('acquire')
    return createLease(input.runId, input.ownerId)
  }

  /**
   * Records heartbeat renewal.
   *
   * @param input - Current exact lease.
   * @returns Fixed fresh successor.
   */
  async heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    this.events.push('heartbeat')
    return createLease(
      input.lease.runId,
      input.lease.ownerId,
      input.lease.fenceToken,
    )
  }

  /**
   * Records evidence renewal.
   *
   * @param input - Exact authority request.
   * @returns Fixed renewed authority.
   */
  async renewMaintenanceEvidence(
    input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    this.events.push('renew')
    this.renewalInput = input
    return createAuthority(evidenceReceiptDigest, 7)
  }

  /**
   * Records strong authority refresh.
   *
   * @param claim - Exact renewed claim.
   * @returns Fixed refreshed authority.
   */
  async readAuthority(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    this.events.push('read-authority')
    this.authorityClaim = claim
    return createAuthority(refreshedEvidenceReceiptDigest, 8)
  }

  /**
   * Records initial writer-fence bootstrap.
   *
   * @param _authority - Fresh current authority.
   * @returns Open writer-fence summary.
   */
  async bootstrapWriterFence(
    _authority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchMigrationWriterFenceSummary> {
    this.events.push('bootstrap-writer-fence')
    return createOpenWriterFenceSummary()
  }

  /**
   * Records exactly one coordinator stage.
   *
   * @param input - Exact stage request.
   * @returns Matching secret-free summary.
   */
  async advanceStage(
    input: Parameters<
      WorkspaceSearchMigrationControlCliMutationSession['advanceStage']
    >[0],
  ): Promise<WorkspaceSearchMigrationControlCoordinatorSummary> {
    this.events.push(`advance:${input.mode}`)
    this.stageMode = input.mode
    if (this.stageGate !== undefined) await this.stageGate
    if (this.failure !== undefined) throw this.failure
    if (input.mode === 'close-replan') {
      return { mode: input.mode, phase: 'planning-admitted' }
    }
    if (input.mode === 'release') {
      return { mode: input.mode, phase: 'released' }
    }
    return {
      mode: input.mode,
      execution: {
        phase: 'applying',
        nextAction: {
          kind: 'choose',
          options: ['apply', 'partial-rollback'],
        },
      },
    }
  }

  /**
   * Records construction of one same-rate-gate evidence provider.
   *
   * @param _maintenanceEvidenceFile - Private evidence path.
   * @returns Provider retained only by the stage request.
   */
  createMaintenanceEvidenceProvider(
    _maintenanceEvidenceFile: string,
  ): WorkspaceSearchMigrationMaintenanceEvidenceProvider {
    this.events.push('create-evidence-provider')
    return {
      collect: async () => {
        throw new Error('Provider use belongs to coordinator tests.')
      },
    }
  }
}

/** Captured JSON lines and status from one in-process invocation. */
type CapturedCliRun = {
  /** Stable process exit status. */
  readonly exitCode: WorkspaceSearchMigrationControlCliExitCode
  /** Complete standard-output lines. */
  readonly stdout: readonly string[]
  /** Complete standard-error lines. */
  readonly stderr: readonly string[]
}

/** Captured result from the documented root-package command. */
type RootCliRun = {
  /** Process exit status. */
  readonly exitCode: number
  /** Complete standard-error text. */
  readonly stderr: string
  /** Complete standard-output text. */
  readonly stdout: string
}

/** Externally resolved promise used to hold one operation in flight. */
type Deferred<Value> = {
  /** Pending promise. */
  readonly promise: Promise<Value>
  /** Resolves the promise once. */
  readonly resolve: (value: Value) => void
}

/**
 * Creates one externally resolved promise.
 *
 * @returns Pending promise and guarded resolver.
 */
function createDeferred<Value>(): Deferred<Value> {
  let resolver: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolvePromise) => {
    resolver = resolvePromise
  })
  return {
    promise,
    resolve: (value: Value): void => {
      if (resolver === undefined) throw new Error('Missing resolver.')
      resolver(value)
    },
  }
}

/**
 * Waits until a recording event has occurred.
 *
 * @param events - Ordered event list.
 * @param expected - Exact event to await.
 */
async function waitForEvent(
  events: readonly string[],
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (events.includes(expected)) return
    await Promise.resolve()
  }
  throw new Error('Expected event was not reached.')
}

/** Recorded factories and files for one isolated CLI invocation. */
type RecordingDependencyHarness = {
  /** Injectable CLI dependencies. */
  readonly dependencies: WorkspaceSearchMigrationControlCliDependencies
  /** Ordered dependency and session events. */
  readonly events: string[]
  /** Explicit mutation factory inputs. */
  readonly mutationInputs:
    CreateWorkspaceSearchMigrationControlCliMutationSessionInput[]
  /** Explicit read-only factory inputs. */
  readonly readInputs: CreateWorkspaceSearchMigrationControlCliReadSessionInput[]
}

/**
 * Creates strict CLI dependencies with separately typed factories.
 *
 * @param options - Optional session behavior.
 * @returns Recording dependency harness.
 */
function createDependencies(
  options: RecordingSessionOptions = {},
): RecordingDependencyHarness {
  const events: string[] = []
  const mutationInputs:
    CreateWorkspaceSearchMigrationControlCliMutationSessionInput[] = []
  const readInputs: CreateWorkspaceSearchMigrationControlCliReadSessionInput[] = []
  return {
    events,
    mutationInputs,
    readInputs,
    dependencies: {
      createReadSession: async (input) => {
        events.push('create-read-session')
        readInputs.push(input)
        if (options.factoryGate !== undefined) await options.factoryGate
        return new RecordingReadSession(events, options)
      },
      createMutationSession: async (input) => {
        events.push('create-mutation-session')
        mutationInputs.push(input)
        if (options.factoryGate !== undefined) await options.factoryGate
        return new RecordingMutationSession(events, options)
      },
      readInputFile: async (path) => {
        events.push(`read-file:${classifyPath(path)}`)
        if (path === ratePolicyPath) return Uint8Array.from(ratePolicyBytes)
        return Uint8Array.of(1, 2, 3)
      },
    },
  }
}

/**
 * Classifies a private test path without recording it.
 *
 * @param path - Exact private path.
 * @returns Stable file role.
 */
function classifyPath(path: string): string {
  if (path === ratePolicyPath) return 'rate-policy'
  if (path === maintenanceEvidencePath) return 'maintenance-evidence'
  if (path === reviewedDryRunPath) return 'reviewed-dry-run'
  return 'unknown'
}

/**
 * Runs one CLI invocation while capturing both JSON output channels.
 *
 * @param arguments_ - Strict or deliberately malformed arguments.
 * @param dependencies - Injected capability factories.
 * @param signal - Optional cooperative interruption signal.
 * @returns Exit status and complete emitted lines.
 */
async function captureCliRun(
  arguments_: readonly string[],
  dependencies: WorkspaceSearchMigrationControlCliDependencies,
  signal?: AbortSignal,
): Promise<CapturedCliRun> {
  const stdout: string[] = []
  const stderr: string[] = []
  const outputWriter = spyOn(console, 'log').mockImplementation(
    (...values: unknown[]): void => {
      stdout.push(values.map((value) => String(value)).join(' '))
    },
  )
  const errorWriter = spyOn(console, 'error').mockImplementation(
    (...values: unknown[]): void => {
      stderr.push(values.map((value) => String(value)).join(' '))
    },
  )
  try {
    const exitCode = await runWorkspaceSearchMigrationControlCli(
      arguments_,
      dependencies,
      signal,
    )
    return { exitCode, stdout, stderr }
  } finally {
    outputWriter.mockRestore()
    errorWriter.mockRestore()
  }
}

/**
 * Runs the exact documented silent root-package command.
 *
 * @param arguments_ - CLI arguments after the script separator.
 * @returns Captured process result.
 */
async function runRootCli(arguments_: readonly string[]): Promise<RootCliRun> {
  const process_ = Bun.spawn({
    cmd: [
      process.execPath,
      'run',
      '--silent',
      'search:migration:control',
      '--',
      ...arguments_,
    ],
    cwd: rootDirectory,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ])
  return { exitCode, stderr, stdout }
}

/** Builds common resources and the required rate-policy file. */
function createCommonArguments(): string[] {
  return [
    ...resourceFlagArguments,
    '--rate-policy-file',
    ratePolicyPath,
  ]
}

/** Builds one strict measure command. */
function createMeasureArguments(): string[] {
  return ['measure', ...createCommonArguments()]
}

/** Builds one strict writer-fence status command. */
function createStatusArguments(): string[] {
  return [
    'status',
    ...createCommonArguments(),
    '--expected-configuration-hash',
    expectedConfigurationHash,
  ]
}

/** Builds one strict execution-status command. */
function createExecutionStatusArguments(): string[] {
  return [
    'execution-status',
    ...createCommonArguments(),
    '--expected-configuration-hash',
    expectedConfigurationHash,
    '--run-id',
    'run-2026-08-01-01',
  ]
}

/**
 * Builds one strict mutation command.
 *
 * @param command - Explicit mutation stage.
 * @param approval - Exact stage approval.
 * @returns Complete strict arguments.
 */
function createMutationArguments(command: string, approval: string): string[] {
  const common = [
    command,
    ...createCommonArguments(),
    '--expected-configuration-hash',
    expectedConfigurationHash,
    '--run-id',
    'run-2026-08-01-01',
    '--owner-id',
    'owner-process-01',
    '--maintenance-evidence-file',
    maintenanceEvidencePath,
    '--approval',
    approval,
  ]
  if (command !== 'close-replan') return common
  return [
    ...common,
    '--reviewed-dry-run-file',
    reviewedDryRunPath,
    '--retain-until',
    '2027-08-01T00:00:00.000Z',
    '--max-total-rows',
    '100000',
    '--max-total-canonical-item-bytes',
    '100000000',
    '--max-plan-operations',
    '100000',
  ]
}

/**
 * Creates one fresh fixed-duration lease.
 *
 * @param runId - Stable run identity.
 * @param ownerId - Stable process owner.
 * @param fenceToken - Exact takeover fence.
 * @returns Valid sixty-second lease.
 */
function createLease(
  runId = 'run-2026-08-01-01',
  ownerId = 'owner-process-01',
  fenceToken = 7,
): WorkspaceSearchMigrationLease {
  const heartbeatAt = new Date()
  return {
    runId,
    ownerId,
    fenceToken,
    heartbeatAt: heartbeatAt.toISOString(),
    expiresAt: new Date(heartbeatAt.getTime() + 60_000).toISOString(),
  }
}

/**
 * Creates one complete current pre-plan authority fixture.
 *
 * @param receiptDigest - Current immutable receipt digest.
 * @param pointerRevision - Current optimistic pointer revision.
 * @returns Fresh authority bound to the standard test lease.
 */
function createAuthority(
  receiptDigest: string,
  pointerRevision: number,
): WorkspaceSearchMigrationPrePlanAuthority {
  const lease = createLease()
  const evaluatedAt = new Date()
  return {
    configurationHash: expectedConfigurationHash,
    stateTableId: 'migration-state-table-id',
    lease,
    maintenanceEvidenceReceiptDigest: receiptDigest,
    maintenanceEvidencePointerRevision: pointerRevision,
    maintenanceEvidenceReceipt: {
      runId: lease.runId,
      evidenceDigest: '6'.repeat(64),
      evidenceLocator: 'change:OPS-2026-08-01',
      runtimeRevision: 42,
      fenceToken: lease.fenceToken,
      validatedAt: evaluatedAt.toISOString(),
      oldestObservationAt: new Date(
        evaluatedAt.getTime() - 60_000,
      ).toISOString(),
      validUntil: new Date(
        evaluatedAt.getTime() + 5 * 60_000,
      ).toISOString(),
    },
    evaluatedAt: evaluatedAt.toISOString(),
  }
}

/** Creates the exact safe open-row summary expected after bootstrap. */
function createOpenWriterFenceSummary(): WorkspaceSearchMigrationWriterFenceSummary {
  return {
    status: 'present',
    mode: 'open',
    writerEpoch: 1,
    controlRevision: 1,
    recordDigest: writerFenceRecordDigest,
  }
}

describe('Workspace Search migration control CLI parser', () => {
  test('requires a strict rate policy for every non-help command', () => {
    const parsed = parseWorkspaceSearchMigrationControlCliArguments(
      createMeasureArguments(),
    )
    expect(parsed).toMatchObject({
      command: 'measure',
      ratePolicyFile: ratePolicyPath,
      rateBootstrap: false,
      rateRecoverInterruptedCleanup: false,
      rateRecoverInterruptedAttempt: false,
    })
    expect(() =>
      parseWorkspaceSearchMigrationControlCliArguments([
        'measure',
        ...resourceFlagArguments,
      ]),
    ).toThrow('INVALID_USAGE')
  })

  test('accepts combined exact recovery and keeps bootstrap exclusive', () => {
    const bootstrap = parseWorkspaceSearchMigrationControlCliArguments([
      ...createMeasureArguments(),
      '--rate-bootstrap',
      'true',
    ])
    expect(bootstrap).toMatchObject({ rateBootstrap: true })

    const combinedRecovery =
      parseWorkspaceSearchMigrationControlCliArguments([
        ...createMeasureArguments(),
        '--rate-recover-interrupted-cleanup',
        'true',
        '--rate-recover-interrupted-attempt',
        'true',
      ])
    expect(combinedRecovery).toMatchObject({
      rateBootstrap: false,
      rateRecoverInterruptedCleanup: true,
      rateRecoverInterruptedAttempt: true,
    })

    for (const invalid of [
      [...createMeasureArguments(), '--rate-bootstrap', 'false'],
      [
        ...createMeasureArguments(),
        '--rate-bootstrap',
        'true',
        '--rate-recover-interrupted-attempt',
        'true',
      ],
    ]) {
      expect(() =>
        parseWorkspaceSearchMigrationControlCliArguments(invalid),
      ).toThrow('INVALID_USAGE')
    }
  })

  test('requires exact stage approvals and all positive planning limits', () => {
    const close = parseWorkspaceSearchMigrationControlCliArguments(
      createMutationArguments(
        'close-replan',
        'close-writers-and-replan',
      ),
    )
    expect(close).toMatchObject({
      command: 'close-replan',
      planningJoinLimits: {
        maxTotalRows: 100_000,
        maxTotalCanonicalItemBytes: 100_000_000,
        maxPlanOperations: 100_000,
      },
    })

    expect(() =>
      parseWorkspaceSearchMigrationControlCliArguments(
        createMutationArguments('apply', 'approve-anything'),
      ),
    ).toThrow('INVALID_USAGE')
    expect(() =>
      parseWorkspaceSearchMigrationControlCliArguments(
        createMutationArguments(
          'close-replan',
          'close-writers-and-replan',
        ).map((value) => value === '100000000' ? '0' : value),
      ),
    ).toThrow('INVALID_USAGE')

    for (const command of [
      'bootstrap-open',
      'close-replan',
      'apply',
      'verify',
      'rollback-partial',
      'rollback-complete',
      'release',
    ]) {
      expect(() =>
        parseWorkspaceSearchMigrationControlCliArguments(
          createMutationArguments(command, 'wrong-stage-approval'),
        ),
      ).toThrow('INVALID_USAGE')
    }
  })
})

describe('Workspace Search migration control CLI capabilities', () => {
  test('snapshots accessor-backed argv before identifying and parsing it', async () => {
    const harness = createDependencies()
    let firstArgumentReads = 0
    const arguments_ = new Proxy(createMeasureArguments(), {
      get: (target, property) => {
        if (property === '0') {
          firstArgumentReads += 1
          return firstArgumentReads === 1 ? 'measure' : 'apply'
        }
        return Reflect.get(target, property)
      },
    })

    const result = await captureCliRun(arguments_, harness.dependencies)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toEqual([])
    expect(firstArgumentReads).toBe(1)
    expect(harness.events).toContain('create-read-session')
    expect(harness.events).not.toContain('create-mutation-session')
  })

  test('captures read dependencies before the policy file await', async () => {
    const harness = createDependencies()
    let policyRead = false
    let redirectedFactories = 0
    let readFactoryGetterCalls = 0
    let fileReaderGetterCalls = 0
    const dependencies: WorkspaceSearchMigrationControlCliDependencies = {
      get createReadSession() {
        readFactoryGetterCalls += 1
        if (!policyRead) return harness.dependencies.createReadSession
        return async () => {
          redirectedFactories += 1
          return new RecordingReadSession(harness.events)
        }
      },
      createMutationSession: harness.dependencies.createMutationSession,
      get readInputFile() {
        fileReaderGetterCalls += 1
        return async (): Promise<Uint8Array> => {
          policyRead = true
          return Uint8Array.from(ratePolicyBytes)
        }
      },
    }

    const result = await captureCliRun(
      createMeasureArguments(),
      dependencies,
    )

    expect(result.exitCode).toBe(0)
    expect(redirectedFactories).toBe(0)
    expect(readFactoryGetterCalls).toBe(1)
    expect(fileReaderGetterCalls).toBe(1)
    expect(harness.events).toContain('create-read-session')
  })

  test('does not retain the mutation factory on a read-only path', async () => {
    const harness = createDependencies()
    let mutationFactoryReadCount = 0
    const dependencies: WorkspaceSearchMigrationControlCliDependencies = {
      createReadSession: harness.dependencies.createReadSession,
      get createMutationSession() {
        mutationFactoryReadCount += 1
        return harness.dependencies.createMutationSession
      },
      readInputFile: harness.dependencies.readInputFile,
    }

    const result = await captureCliRun(
      createMeasureArguments(),
      dependencies,
    )

    expect(result.exitCode).toBe(0)
    expect(mutationFactoryReadCount).toBe(0)
  })

  test('help touches neither files nor session factories', async () => {
    const harness = createDependencies()
    const result = await captureCliRun(['help'], harness.dependencies)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toHaveLength(1)
    expect(result.stdout[0]).toContain('execution-status')
    expect(result.stdout[0]).toContain('rollback-partial')
    expect(result.stdout[0]).toContain('--rate-bootstrap')
    expect(harness.events).toEqual([])
  })

  test('measure, status, and execution-status never request a mutation session', async () => {
    for (const arguments_ of [
      createMeasureArguments(),
      createStatusArguments(),
      createExecutionStatusArguments(),
    ]) {
      const harness = createDependencies()
      const result = await captureCliRun(arguments_, harness.dependencies)

      expect(result.exitCode).toBe(0)
      expect(harness.events).toContain('create-read-session')
      expect(harness.events).not.toContain('create-mutation-session')
      expect(harness.mutationInputs).toEqual([])
      expect(harness.readInputs).toHaveLength(1)
    }
  })

  test('every mutation requires only the explicit mutation factory', async () => {
    const stages: readonly [string, string][] = [
      ['bootstrap-open', 'initial-writer-fence-bootstrap'],
      ['close-replan', 'close-writers-and-replan'],
      ['apply', 'apply-sealed-migration-plan'],
      ['verify', 'verify-complete-applied-root'],
      ['rollback-partial', 'rollback-committed-apply-prefix'],
      ['rollback-complete', 'rollback-complete-applied-root'],
      ['release', 'release-application-writers'],
    ]
    for (const [command, approval] of stages) {
      const harness = createDependencies()
      const result = await captureCliRun(
        createMutationArguments(command, approval),
        harness.dependencies,
      )

      expect(result.exitCode).toBe(0)
      expect(harness.events).toContain('create-mutation-session')
      expect(harness.events).not.toContain('create-read-session')
      expect(harness.readInputs).toEqual([])
      expect(harness.mutationInputs).toHaveLength(1)
      if (command === 'bootstrap-open') {
        expect(harness.events).toContain('heartbeat')
      } else {
        expect(harness.events).toContain(`advance:${command}`)
        expect(harness.events).toContain('create-evidence-provider')
      }
      expect(harness.events.filter((event) => event === 'close')).toHaveLength(1)
    }
  })

  test('forwards only one explicit rate recovery authority', async () => {
    const harness = createDependencies()
    const result = await captureCliRun(
      [
        ...createStatusArguments(),
        '--rate-recover-interrupted-cleanup',
        'true',
      ],
      harness.dependencies,
    )

    expect(result.exitCode).toBe(0)
    expect(harness.readInputs[0]).toMatchObject({
      rateBootstrap: false,
      rateRecoverInterruptedCleanup: true,
      rateRecoverInterruptedAttempt: false,
    })
  })
})

describe('Workspace Search migration control CLI output and lifecycle', () => {
  test('emits one policy-bound identifier-free line for execution status', async () => {
    const harness = createDependencies()
    const result = await captureCliRun(
      createExecutionStatusArguments(),
      harness.dependencies,
    )

    expect(result.stderr).toEqual([])
    expect(result.stdout).toEqual([
      JSON.stringify({
        schemaVersion: 1,
        operation: 'execution-status',
        status: 'pass',
        configurationHash: expectedConfigurationHash,
        policyVersion,
        execution: { phase: 'ready', nextAction: { kind: 'apply' } },
        rateAggregate: {
          version: 1,
          policyVersion,
          attemptCount: 6,
          forfeitedAttemptCount: 0,
          throttleCount: 0,
          budgetStopCount: 0,
          cadenceWaitCount: 5,
          cadenceWaitMilliseconds: 100,
          maximumInFlight: 0,
        },
      }),
    ])
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      '123456789012',
      'migration-state-table',
      'run-2026-08-01-01',
      'owner-process-01',
      ratePolicyPath,
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test('bootstraps only after measurement, heartbeat, and current authority', async () => {
    const harness = createDependencies()
    const result = await captureCliRun(
      createMutationArguments(
        'bootstrap-open',
        'initial-writer-fence-bootstrap',
      ),
      harness.dependencies,
    )

    expect(result.exitCode).toBe(0)
    expect(harness.events).toEqual([
      'read-file:rate-policy',
      'read-file:maintenance-evidence',
      'create-mutation-session',
      'measure',
      'acquire',
      'heartbeat',
      'install-mutation-admission-guard',
      'renew',
      'read-authority',
      'bootstrap-writer-fence',
      'read-rate',
      'close',
    ])
    expect(result.stdout[0]).toContain('"writerFence"')
    expect(result.stdout[0]).not.toContain('owner-process-01')
    expect(result.stdout[0]).not.toContain('maintenanceEvidenceReceiptDigest')
  })

  test('rejects a hash mismatch before lease acquisition and closes once', async () => {
    const harness = createDependencies({
      measuredConfigurationHash: differentConfigurationHash,
    })
    const result = await captureCliRun(
      createMutationArguments(
        'bootstrap-open',
        'initial-writer-fence-bootstrap',
      ),
      harness.dependencies,
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain('CONFIGURATION_HASH_MISMATCH')
    expect(harness.events).not.toContain('acquire')
    expect(harness.events.filter((event) => event === 'close')).toHaveLength(1)
  })

  test('redacts raw failures, resources, paths, run, and owner', async () => {
    const rawCanary = 'raw-aws-error-secret-canary'
    const harness = createDependencies({ failure: new Error(rawCanary) })
    const arguments_ = createMutationArguments(
      'apply',
      'apply-sealed-migration-plan',
    )
    const result = await captureCliRun(arguments_, harness.dependencies)

    expect(result).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: [JSON.stringify({
        schemaVersion: 1,
        operation: 'apply',
        status: 'error',
        code: 'OPERATION_FAILED',
      })],
    })
    const output = JSON.stringify(result)
    for (const forbidden of [
      rawCanary,
      'migration-state-table',
      'run-2026-08-01-01',
      'owner-process-01',
      maintenanceEvidencePath,
    ]) {
      expect(output).not.toContain(forbidden)
    }
    expect(harness.events.filter((event) => event === 'close')).toHaveLength(1)
  })

  test('preserves trusted failure code without its raw message', async () => {
    const canary = 'trusted-message-canary'
    const harness = createDependencies({
      failure: new WorkspaceSearchMigrationFailure(
        'PITR_NOT_READY',
        canary,
      ),
    })
    const result = await captureCliRun(
      createMeasureArguments(),
      harness.dependencies,
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain('PITR_NOT_READY')
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(harness.events.filter((event) => event === 'close')).toHaveLength(1)
  })

  test('keeps the task failure primary over an asynchronous close failure', async () => {
    const taskCanary = 'primary-task-message-canary'
    const closeCanary = 'secondary-close-message-canary'
    const harness = createDependencies({
      failure: new WorkspaceSearchMigrationFailure(
        'PITR_NOT_READY',
        taskCanary,
      ),
      closeFailure: new Error(closeCanary),
    })
    const result = await captureCliRun(
      createMeasureArguments(),
      harness.dependencies,
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain('PITR_NOT_READY')
    expect(JSON.stringify(result)).not.toContain(taskCanary)
    expect(JSON.stringify(result)).not.toContain(closeCanary)
    expect(harness.events.filter((event) => event === 'close')).toHaveLength(1)
  })

  test('does not create a session when already interrupted', async () => {
    const harness = createDependencies()
    const controller = new AbortController()
    controller.abort()
    const result = await captureCliRun(
      createMeasureArguments(),
      harness.dependencies,
      controller.signal,
    )

    expect(result.exitCode).toBe(130)
    expect(result.stderr[0]).toContain('INTERRUPTED')
    expect(harness.events).toEqual([])
  })

  test('waits for an interrupted stage before closing exactly once', async () => {
    const stage = createDeferred<void>()
    const harness = createDependencies({ stageGate: stage.promise })
    const controller = new AbortController()
    let settled = false
    const resultPromise = captureCliRun(
      createMutationArguments('apply', 'apply-sealed-migration-plan'),
      harness.dependencies,
      controller.signal,
    ).finally(() => {
      settled = true
    })

    await waitForEvent(harness.events, 'advance:apply')
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(harness.events).toContain('interrupt-rate')
    expect(harness.events).not.toContain('close')

    stage.resolve(undefined)
    const result = await resultPromise
    expect(result.exitCode).toBe(130)
    expect(result.stderr[0]).toContain('INTERRUPTED')
    expect(harness.events.filter((event) => event === 'close')).toHaveLength(1)
  })

  test('reports interruption that arrives while session close is draining', async () => {
    const closeGate = createDeferred<void>()
    const controller = new AbortController()
    const harness = createDependencies({ closeGate: closeGate.promise })
    const pending = captureCliRun(
      createMeasureArguments(),
      harness.dependencies,
      controller.signal,
    )
    await waitForEvent(harness.events, 'close')

    controller.abort(new Error('close-interruption-canary'))
    closeGate.resolve()
    const result = await pending

    expect(result.exitCode).toBe(130)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toHaveLength(1)
    expect(result.stderr[0]).toContain('"code":"INTERRUPTED"')
    expect(result.stderr[0]).not.toContain('close-interruption-canary')
    expect(harness.events.filter((event) => event === 'close')).toHaveLength(1)
    expect(harness.events).toContain('interrupt-rate')
  })

  test('starts no coordinator stage after abort during session creation', async () => {
    const factory = createDeferred<void>()
    const harness = createDependencies({ factoryGate: factory.promise })
    const controller = new AbortController()
    const resultPromise = captureCliRun(
      createMutationArguments('apply', 'apply-sealed-migration-plan'),
      harness.dependencies,
      controller.signal,
    )

    await waitForEvent(harness.events, 'create-mutation-session')
    expect(harness.mutationInputs[0]?.signal).toBe(controller.signal)
    controller.abort()
    factory.resolve(undefined)
    const result = await resultPromise

    expect(result.exitCode).toBe(130)
    expect(harness.events).toContain('interrupt-rate')
    expect(harness.events).not.toContain('advance:apply')
    expect(harness.events.filter((event) => event === 'close')).toHaveLength(1)
  })

  test('rejects noncanonical rate policy before any session factory', async () => {
    const harness = createDependencies()
    const dependencies: WorkspaceSearchMigrationControlCliDependencies = {
      ...harness.dependencies,
      readInputFile: async () => new TextEncoder().encode(
        JSON.stringify(ratePolicyDocument, null, 2),
      ),
    }
    const result = await captureCliRun(
      createMeasureArguments(),
      dependencies,
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr[0]).toContain(
      'INVALID_DESCRIBE_TABLE_RATE_POLICY',
    )
    expect(harness.events).toEqual([])
  })
})

describe('Workspace Search migration documented root command', () => {
  test('emits standalone help JSON without Bun wrapper output', async () => {
    const result = await runRootCli(['help'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.startsWith(
      '{"schemaVersion":1,"status":"help"',
    )).toBe(true)
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
  })

  test('does not echo an unknown argument through the Bun wrapper', async () => {
    const canary = 'unknown-secret-argument-canary'
    const result = await runRootCli([canary])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('"operation":"unknown"')
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary)
  })
})

describe('Workspace Search migration bounded input file', () => {
  test('accepts a bounded regular file and rejects invalid kinds or sizes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-control-'))
    const regularPath = join(directory, 'regular.json')
    const emptyPath = join(directory, 'empty.json')
    const oversizedPath = join(directory, 'oversized.json')
    const regularBytes = Uint8Array.of(0x7b, 0x7d)
    try {
      await writeFile(regularPath, regularBytes)
      await writeFile(emptyPath, new Uint8Array())
      await writeFile(oversizedPath, Buffer.alloc(5, 0x61))

      await expect(readBoundedInputFile(regularPath, 4)).resolves.toEqual(
        regularBytes,
      )
      await expect(readBoundedInputFile(directory, 4)).rejects.toThrow(
        'INPUT_FILE_INVALID',
      )
      await expect(readBoundedInputFile(emptyPath, 4)).rejects.toThrow(
        'INPUT_FILE_INVALID',
      )
      await expect(readBoundedInputFile(oversizedPath, 4)).rejects.toThrow(
        'INPUT_FILE_INVALID',
      )
      await expect(
        readBoundedInputFile(regularPath, MAINTENANCE_EVIDENCE_MAX_BYTES),
      ).resolves.toEqual(regularBytes)
      await expect(
        readBoundedInputFile(regularPath, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow('INPUT_FILE_INVALID')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
