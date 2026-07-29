import { describe, expect, spyOn, test } from 'bun:test'
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationLease,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationControlCliArguments,
  readMaintenanceEvidenceFile,
  runWorkspaceSearchMigrationControlCli,
  type WorkspaceSearchMigrationControlCliDependencies,
  type WorkspaceSearchMigrationControlCliExitCode,
  type WorkspaceSearchMigrationControlCliSession,
  type WorkspaceSearchMigrationWriterFenceSummary,
} from './migration-control-cli'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
} from './maintenance-evidence'
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

/**
 * Optional behavior installed on one recording CLI session.
 */
type RecordingControlCliSessionOptions = {
  /** Failure raised by resource measurement, when supplied. */
  readonly measureFailure?: unknown
  /** Configuration hash returned by resource measurement. */
  readonly measuredConfigurationHash?: string
  /** Optional gate that holds maintenance evidence renewal in flight. */
  readonly renewalGate?: Promise<void>
  /** Summary returned by a writer-fence status read. */
  readonly writerFence?: WorkspaceSearchMigrationWriterFenceSummary
  /** Summary returned by initial writer-fence bootstrap. */
  readonly bootstrapWriterFence?: WorkspaceSearchMigrationWriterFenceSummary
  /** Authority returned by immutable evidence renewal. */
  readonly renewedAuthority?: WorkspaceSearchMigrationPrePlanAuthority
  /** Authority returned by the mandatory current-authority reread. */
  readonly refreshedAuthority?: WorkspaceSearchMigrationPrePlanAuthority
}

/**
 * Narrow fake that records every externally visible CLI session operation.
 */
class RecordingControlCliSession
implements WorkspaceSearchMigrationControlCliSession {
  /** Ordered session calls shared with dependency-level events. */
  readonly events: string[]

  /** Number of lifecycle close calls. */
  closeCount = 0

  /** Last immutable evidence renewal input. */
  renewalInput:
    RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput | undefined

  /** Last exact current-authority claim. */
  authorityClaim:
    WorkspaceSearchMigrationPrePlanAuthorityClaim | undefined

  /** Authority passed to the initial writer-fence transition. */
  bootstrapAuthority:
    WorkspaceSearchMigrationPrePlanAuthority | undefined

  /** Failure raised by measurement, when configured. */
  private readonly measureFailure: unknown

  /** Configuration hash returned by measurement. */
  private readonly measuredConfigurationHash: string

  /** Writer-fence status returned by the read operation. */
  private readonly writerFence:
    WorkspaceSearchMigrationWriterFenceSummary

  /** Writer-fence summary returned by bootstrap. */
  private readonly bootstrapWriterFenceSummary:
    WorkspaceSearchMigrationWriterFenceSummary

  /** Authority returned by evidence renewal. */
  private readonly renewedAuthority:
    WorkspaceSearchMigrationPrePlanAuthority

  /** Optional gate that holds evidence renewal in flight. */
  private readonly renewalGate: Promise<void> | undefined

  /** Authority returned after a strong refresh. */
  private readonly refreshedAuthority:
    WorkspaceSearchMigrationPrePlanAuthority

  /**
   * Creates one deterministic recording session.
   *
   * @param events - Ordered shared event recorder.
   * @param options - Optional method results and failure behavior.
   */
  constructor(
    events: string[],
    options: RecordingControlCliSessionOptions = {},
  ) {
    this.events = events
    this.measureFailure = options.measureFailure
    this.measuredConfigurationHash =
      options.measuredConfigurationHash ?? expectedConfigurationHash
    this.writerFence = options.writerFence ?? { status: 'missing' }
    this.bootstrapWriterFenceSummary =
      options.bootstrapWriterFence ?? createOpenWriterFenceSummary()
    this.renewedAuthority =
      options.renewedAuthority ??
      createAuthority(evidenceReceiptDigest, 7)
    this.renewalGate = options.renewalGate
    this.refreshedAuthority =
      options.refreshedAuthority ??
      createAuthority(refreshedEvidenceReceiptDigest, 8)
  }

  /**
   * Records measured identity resolution.
   *
   * @returns Configured reviewed configuration hash.
   */
  async measureConfigurationHash(): Promise<string> {
    this.events.push('measure')
    if (this.measureFailure !== undefined) {
      throw this.measureFailure
    }
    return this.measuredConfigurationHash
  }

  /**
   * Records lease acquisition.
   *
   * @param input - Exact requested run and owner.
   * @returns Fresh fixed-duration lease.
   */
  async acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    this.events.push('acquire')
    return createLease(input.runId, input.ownerId, 7)
  }

  /**
   * Records the supervisor's exact initial or periodic heartbeat.
   *
   * @param input - Stable lease identity.
   * @returns Fresh fixed-duration successor.
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
   * Records immutable maintenance-evidence renewal.
   *
   * @param input - Exact claim, predecessor, and evidence bytes.
   * @returns Configured renewed authority.
   */
  async renewMaintenanceEvidence(
    input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    this.events.push('renew')
    this.renewalInput = input
    if (this.renewalGate !== undefined) {
      await this.renewalGate
    }
    return this.renewedAuthority
  }

  /**
   * Records the mandatory current-authority reread.
   *
   * @param claim - Exact lease and receipt pointer claim.
   * @returns Configured refreshed authority.
   */
  async readAuthority(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    this.events.push('read-authority')
    this.authorityClaim = claim
    return this.refreshedAuthority
  }

  /**
   * Records a writer-fence status read.
   *
   * @returns Configured safe summary.
   */
  async readWriterFence():
    Promise<WorkspaceSearchMigrationWriterFenceSummary> {
    this.events.push('read-writer-fence')
    return this.writerFence
  }

  /**
   * Records initial writer-fence bootstrap.
   *
   * @param authority - Fresh authority supplied by CLI orchestration.
   * @returns Configured bootstrap summary.
   */
  async bootstrapWriterFence(
    authority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchMigrationWriterFenceSummary> {
    this.events.push('bootstrap-writer-fence')
    this.bootstrapAuthority = authority
    return this.bootstrapWriterFenceSummary
  }

  /**
   * Records exact session cleanup.
   */
  close(): void {
    this.events.push('close')
    this.closeCount += 1
  }
}

/**
 * Captured JSON lines and status from one in-process CLI invocation.
 */
type CapturedCliRun = {
  /** Stable process exit status. */
  readonly exitCode: WorkspaceSearchMigrationControlCliExitCode
  /** Complete standard-output lines. */
  readonly stdout: readonly string[]
  /** Complete standard-error lines. */
  readonly stderr: readonly string[]
}

/**
 * Captured result from the documented root-package command.
 */
type RootCliRun = {
  /** Process exit status. */
  readonly exitCode: number
  /** Complete standard-error text. */
  readonly stderr: string
  /** Complete standard-output text. */
  readonly stdout: string
}

/**
 * Externally resolved promise used to hold one CLI operation in flight.
 */
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
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve
  })
  return {
    promise,
    resolve: (value: Value): void => {
      if (resolver === undefined) {
        throw new Error('Deferred resolver is unavailable.')
      }
      resolver(value)
    },
  }
}

/**
 * Waits for one deterministic fake-session event.
 *
 * @param events - Ordered fake-session events.
 * @param expected - Event that must be reached.
 */
async function waitForRecordedEvent(
  events: readonly string[],
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (events.includes(expected)) return
    await Promise.resolve()
  }
  throw new Error('Expected CLI event was not reached.')
}

/**
 * Runs the exact documented silent root-package command.
 *
 * @param arguments_ - CLI arguments after the script separator.
 * @returns Captured process result.
 */
async function runRootCli(
  arguments_: readonly string[],
): Promise<RootCliRun> {
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

/**
 * Builds one strict measure command.
 *
 * @returns Complete explicit measure arguments.
 */
function createMeasureArguments(): string[] {
  return ['measure', ...resourceFlagArguments]
}

/**
 * Builds one strict status command.
 *
 * @param configurationHash - Separately reviewed expected hash.
 * @returns Complete explicit status arguments.
 */
function createStatusArguments(
  configurationHash = expectedConfigurationHash,
): string[] {
  return [
    'status',
    ...resourceFlagArguments,
    '--expected-configuration-hash',
    configurationHash,
  ]
}

/**
 * Builds one strict initial-bootstrap command.
 *
 * @param configurationHash - Separately reviewed expected hash.
 * @param approval - Explicit initial-only approval phrase.
 * @returns Complete explicit bootstrap arguments.
 */
function createBootstrapArguments(
  configurationHash = expectedConfigurationHash,
  approval = 'initial-writer-fence-bootstrap',
): string[] {
  return [
    'bootstrap-open',
    ...resourceFlagArguments,
    '--expected-configuration-hash',
    configurationHash,
    '--run-id',
    'run-2026-07-29-01',
    '--owner-id',
    'owner-process-01',
    '--maintenance-evidence-file',
    '/operator/evidence.json',
    '--approval',
    approval,
  ]
}

/**
 * Creates CLI dependencies over one injected recording session.
 *
 * @param session - Session returned to the CLI.
 * @param events - Ordered dependency-level event recorder.
 * @param evidenceBytes - Exact file bytes returned to bootstrap.
 * @returns Deterministic CLI dependencies.
 */
function createDependencies(
  session: RecordingControlCliSession,
  events: string[],
  evidenceBytes: Uint8Array = Uint8Array.of(1, 2, 3),
): WorkspaceSearchMigrationControlCliDependencies {
  return {
    createSession: () => {
      events.push('create-session')
      return session
    },
    readMaintenanceEvidenceFile: async () => {
      events.push('read-evidence')
      return new Uint8Array(evidenceBytes)
    },
  }
}

/**
 * Runs one CLI invocation while capturing both JSON output channels.
 *
 * @param arguments_ - Strict or deliberately malformed CLI arguments.
 * @param dependencies - Injected session and file dependencies.
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
 * Creates one fresh fixed-duration lease around the process clock.
 *
 * @param runId - Stable run identity.
 * @param ownerId - Stable process owner.
 * @param fenceToken - Exact takeover fence.
 * @returns Valid sixty-second lease.
 */
function createLease(
  runId = 'run-2026-07-29-01',
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
      evidenceLocator: 'change:OPS-2026-07-29',
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

/**
 * Creates the exact safe open-row summary expected after bootstrap.
 *
 * @returns Present open writer-fence summary.
 */
function createOpenWriterFenceSummary():
  WorkspaceSearchMigrationWriterFenceSummary {
  return {
    status: 'present',
    mode: 'open',
    writerEpoch: 1,
    controlRevision: 1,
    recordDigest: writerFenceRecordDigest,
  }
}

describe('Workspace Search migration control CLI parser', () => {
  test('accepts a complete explicit resource selection', () => {
    expect(
      parseWorkspaceSearchMigrationControlCliArguments(
        createMeasureArguments(),
      ),
    ).toEqual({
      command: 'measure',
      resources: {
        account: '123456789012',
        region: 'ap-northeast-1',
        profile: 'migration-operator',
        commit: 'a'.repeat(40),
        tables: {
          'project-directory': 'project-directory-table',
          'work-items': 'work-items-table',
          collaboration: 'collaboration-table',
          documents: 'documents-table',
          'workspace-search': 'workspace-search-table',
          'migration-state': 'migration-state-table',
        },
        journalBucket: 'mukuroji-migration-journal',
        journalKeyArn:
          'arn:aws:kms:ap-northeast-1:123456789012:key/12345678-1234-1234-1234-123456789012',
      },
    })
  })

  test('rejects unknown, duplicate, and missing flags', () => {
    const complete = createMeasureArguments()
    const malformedCases: readonly (readonly string[])[] = [
      [...complete, '--unknown-resource', 'private-value'],
      [...complete, '--account', '123456789012'],
      complete.slice(0, -2),
    ]

    for (const arguments_ of malformedCases) {
      expect(
        () => parseWorkspaceSearchMigrationControlCliArguments(arguments_),
      ).toThrow('INVALID_USAGE')
    }
  })
})

describe('Workspace Search migration control CLI execution', () => {
  test('returns machine-readable help without touching files or AWS', async () => {
    const events: string[] = []
    const session = new RecordingControlCliSession(events)
    const result = await captureCliRun(
      ['help'],
      createDependencies(session, events),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toHaveLength(1)
    expect(result.stdout[0]).toContain('"status":"help"')
    expect(result.stdout[0]).toContain('bootstrap-open')
    expect(events).toEqual([])
    expect(session.closeCount).toBe(0)
  })

  test('measures identity successfully and closes the session exactly once', async () => {
    const events: string[] = []
    const session = new RecordingControlCliSession(events)
    const result = await captureCliRun(
      createMeasureArguments(),
      createDependencies(session, events),
    )

    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        JSON.stringify({
          schemaVersion: 1,
          operation: 'measure',
          status: 'pass',
          configurationHash: expectedConfigurationHash,
        }),
      ],
      stderr: [],
    })
    expect(events).toEqual([
      'create-session',
      'measure',
      'close',
    ])
    expect(session.closeCount).toBe(1)
  })

  test('rejects a hash mismatch before acquiring a lease', async () => {
    const events: string[] = []
    const session = new RecordingControlCliSession(events)
    const result = await captureCliRun(
      createBootstrapArguments(differentConfigurationHash),
      createDependencies(session, events),
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toEqual([
      JSON.stringify({
        schemaVersion: 1,
        operation: 'bootstrap-open',
        status: 'error',
        code: 'CONFIGURATION_HASH_MISMATCH',
      }),
    ])
    expect(events).toEqual([
      'read-evidence',
      'create-session',
      'measure',
      'close',
    ])
    expect(session.closeCount).toBe(1)
  })

  test('reports missing and present writer-fence states without physical identifiers', async () => {
    const missingEvents: string[] = []
    const missingSession = new RecordingControlCliSession(
      missingEvents,
      { writerFence: { status: 'missing' } },
    )
    const missing = await captureCliRun(
      createStatusArguments(),
      createDependencies(missingSession, missingEvents),
    )

    const presentEvents: string[] = []
    const presentSummary:
      WorkspaceSearchMigrationWriterFenceSummary = {
        status: 'present',
        mode: 'closed',
        writerEpoch: 2,
        controlRevision: 2,
        recordDigest: writerFenceRecordDigest,
      }
    const presentSession = new RecordingControlCliSession(
      presentEvents,
      { writerFence: presentSummary },
    )
    const present = await captureCliRun(
      createStatusArguments(),
      createDependencies(presentSession, presentEvents),
    )

    expect(missing.stdout).toEqual([
      JSON.stringify({
        schemaVersion: 1,
        operation: 'status',
        status: 'pass',
        configurationHash: expectedConfigurationHash,
        writerFence: { status: 'missing' },
      }),
    ])
    expect(present.stdout).toEqual([
      JSON.stringify({
        schemaVersion: 1,
        operation: 'status',
        status: 'pass',
        configurationHash: expectedConfigurationHash,
        writerFence: presentSummary,
      }),
    ])
    expect(JSON.stringify([missing, present])).not.toContain(
      'migration-state-table',
    )
    expect(missingEvents).toEqual([
      'create-session',
      'measure',
      'read-writer-fence',
      'close',
    ])
    expect(presentEvents).toEqual([
      'create-session',
      'measure',
      'read-writer-fence',
      'close',
    ])
  })

  test('bootstraps only after initial heartbeat and refreshed authority', async () => {
    const events: string[] = []
    const evidenceBytes = Uint8Array.of(9, 8, 7, 6)
    const renewedAuthority =
      createAuthority(evidenceReceiptDigest, 7)
    const refreshedAuthority =
      createAuthority(refreshedEvidenceReceiptDigest, 8)
    const session = new RecordingControlCliSession(events, {
      renewedAuthority,
      refreshedAuthority,
    })
    const result = await captureCliRun(
      createBootstrapArguments(),
      createDependencies(session, events, evidenceBytes),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toEqual([])
    expect(events).toEqual([
      'read-evidence',
      'create-session',
      'measure',
      'acquire',
      'heartbeat',
      'renew',
      'read-authority',
      'bootstrap-writer-fence',
      'close',
    ])
    expect(session.renewalInput).toEqual({
      lease: {
        runId: 'run-2026-07-29-01',
        ownerId: 'owner-process-01',
        fenceToken: 7,
      },
      expectedPointer: null,
      evidenceBytes,
    })
    expect(session.authorityClaim).toEqual({
      lease: {
        runId: 'run-2026-07-29-01',
        ownerId: 'owner-process-01',
        fenceToken: 7,
      },
      maintenanceEvidenceReceiptDigest: evidenceReceiptDigest,
      maintenanceEvidencePointerRevision: 7,
    })
    expect(session.bootstrapAuthority).toBe(refreshedAuthority)
    expect(result.stdout).toEqual([
      JSON.stringify({
        schemaVersion: 1,
        operation: 'bootstrap-open',
        status: 'pass',
        configurationHash: expectedConfigurationHash,
        authority: {
          fenceToken: 7,
          maintenanceEvidencePointerRevision: 8,
          maintenanceEvidenceReceiptDigest:
            refreshedEvidenceReceiptDigest,
        },
        writerFence: createOpenWriterFenceSummary(),
      }),
    ])
    expect(session.closeCount).toBe(1)
  })

  test('rejects bootstrap without the exact approval phrase', async () => {
    const events: string[] = []
    const session = new RecordingControlCliSession(events)
    const result = await captureCliRun(
      createBootstrapArguments(
        expectedConfigurationHash,
        'approve-any-bootstrap',
      ),
      createDependencies(session, events),
    )

    expect(result).toEqual({
      exitCode: 2,
      stdout: [],
      stderr: [
        JSON.stringify({
          schemaVersion: 1,
          operation: 'bootstrap-open',
          status: 'error',
          code: 'INVALID_USAGE',
        }),
      ],
    })
    expect(events).toEqual([])
    expect(session.closeCount).toBe(0)
  })

  test('stops before creating a session when the signal is already aborted', async () => {
    const events: string[] = []
    const session = new RecordingControlCliSession(events)
    const controller = new AbortController()
    controller.abort()

    const result = await captureCliRun(
      createMeasureArguments(),
      createDependencies(session, events),
      controller.signal,
    )

    expect(result).toEqual({
      exitCode: 130,
      stdout: [],
      stderr: [
        JSON.stringify({
          schemaVersion: 1,
          operation: 'measure',
          status: 'error',
          code: 'INTERRUPTED',
        }),
      ],
    })
    expect(events).toEqual([])
    expect(session.closeCount).toBe(0)
  })

  test('waits for an interrupted operation before closing exactly once', async () => {
    const events: string[] = []
    const renewal = createDeferred<void>()
    const session = new RecordingControlCliSession(events, {
      renewalGate: renewal.promise,
    })
    const controller = new AbortController()
    let settled = false
    const resultPromise = captureCliRun(
      createBootstrapArguments(),
      createDependencies(session, events),
      controller.signal,
    ).finally(() => {
      settled = true
    })

    await waitForRecordedEvent(events, 'renew')
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(session.closeCount).toBe(0)
    expect(events).not.toContain('read-authority')
    expect(events).not.toContain('bootstrap-writer-fence')

    renewal.resolve(undefined)
    const result = await resultPromise
    expect(result).toEqual({
      exitCode: 130,
      stdout: [],
      stderr: [
        JSON.stringify({
          schemaVersion: 1,
          operation: 'bootstrap-open',
          status: 'error',
          code: 'INTERRUPTED',
        }),
      ],
    })
    expect(events).toEqual([
      'read-evidence',
      'create-session',
      'measure',
      'acquire',
      'heartbeat',
      'renew',
      'close',
    ])
    expect(session.closeCount).toBe(1)
  })

  test('redacts an unknown raw failure and still closes exactly once', async () => {
    const canary = 'raw-aws-secret-canary'
    const events: string[] = []
    const session = new RecordingControlCliSession(events, {
      measureFailure: new Error(canary),
    })
    const result = await captureCliRun(
      createMeasureArguments(),
      createDependencies(session, events),
    )

    expect(result).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: [
        JSON.stringify({
          schemaVersion: 1,
          operation: 'measure',
          status: 'error',
          code: 'OPERATION_FAILED',
        }),
      ],
    })
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(events).toEqual([
      'create-session',
      'measure',
      'close',
    ])
    expect(session.closeCount).toBe(1)
  })

  test('preserves a trusted migration failure code without its message', async () => {
    const canary = 'trusted-message-canary'
    const events: string[] = []
    const session = new RecordingControlCliSession(events, {
      measureFailure: new WorkspaceSearchMigrationFailure(
        'PITR_NOT_READY',
        canary,
      ),
    })
    const result = await captureCliRun(
      createMeasureArguments(),
      createDependencies(session, events),
    )

    expect(result).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: [
        JSON.stringify({
          schemaVersion: 1,
          operation: 'measure',
          status: 'error',
          code: 'PITR_NOT_READY',
        }),
      ],
    })
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(session.closeCount).toBe(1)
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

    expect(result).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: `${JSON.stringify({
        schemaVersion: 1,
        operation: 'unknown',
        status: 'error',
        code: 'INVALID_USAGE',
      })}\n`,
    })
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary)
  })
})

describe('Workspace Search migration maintenance evidence file', () => {
  test('accepts a bounded regular file and rejects invalid file kinds or sizes', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mukuroji-migration-control-'),
    )
    const regularPath = join(directory, 'regular.json')
    const emptyPath = join(directory, 'empty.json')
    const oversizedPath = join(directory, 'oversized.json')
    const fifoPath = join(directory, 'evidence.fifo')
    const regularBytes = Uint8Array.of(0x7b, 0x7d, 0x0a)
    try {
      await writeFile(regularPath, regularBytes)
      await writeFile(emptyPath, new Uint8Array())
      await writeFile(
        oversizedPath,
        Buffer.alloc(MAINTENANCE_EVIDENCE_MAX_BYTES + 1, 0x61),
      )

      await expect(
        readMaintenanceEvidenceFile(regularPath),
      ).resolves.toEqual(regularBytes)
      await expect(
        readMaintenanceEvidenceFile(directory),
      ).rejects.toThrow('INPUT_FILE_INVALID')
      await expect(
        readMaintenanceEvidenceFile(emptyPath),
      ).rejects.toThrow('INPUT_FILE_INVALID')
      await expect(
        readMaintenanceEvidenceFile(oversizedPath),
      ).rejects.toThrow('INPUT_FILE_INVALID')

      const mkfifoPath = Bun.which('mkfifo')
      if (mkfifoPath !== null) {
        const fifoProcess = Bun.spawn({
          cmd: [mkfifoPath, fifoPath],
          stderr: 'pipe',
          stdout: 'ignore',
        })
        const [fifoExitCode, fifoError] = await Promise.all([
          fifoProcess.exited,
          new Response(fifoProcess.stderr).text(),
        ])
        if (fifoExitCode !== 0) {
          throw new Error(`mkfifo failed: ${fifoError}`)
        }
        await expect(
          readMaintenanceEvidenceFile(fifoPath),
        ).rejects.toThrow('INPUT_FILE_INVALID')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 2_000)
})
