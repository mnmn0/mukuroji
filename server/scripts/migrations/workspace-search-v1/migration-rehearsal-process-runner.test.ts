import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { describe, expect, test } from 'bun:test'
import {
  runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess,
  runWorkspaceSearchMigrationRehearsalProcess,
  runWorkspaceSearchMigrationRehearsalSuccessfulProcess,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDERR_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES,
  WorkspaceSearchMigrationRehearsalProcessRunnerError,
  type WorkspaceSearchMigrationRehearsalDurableFaultReceiptInput,
  type WorkspaceSearchMigrationRehearsalDurableSuccessMaterialInput,
  type WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialInput,
  type WorkspaceSearchMigrationRehearsalDurableFaultCompletionMaterialInput,
  type WorkspaceSearchMigrationRehearsalExpectedFaultReceipt,
  type WorkspaceSearchMigrationRehearsalProcessExitResult,
  type WorkspaceSearchMigrationRehearsalProcessPort,
  type WorkspaceSearchMigrationRehearsalProcessRunnerErrorCode,
} from './migration-rehearsal-process-runner'
import type {
  WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  captureWorkspaceSearchMigrationRehearsalChildMutationObservation,
  createWorkspaceSearchMigrationRehearsalStageChildMaterial,
} from './migration-rehearsal-stage-child-material'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
} from './migration-rehearsal-stage-fault-material'

/** Fixed discriminator emitted by the independently implemented child CLI. */
const faultReceiptLineKind =
  'mukuroji-workspace-search-migration-rehearsal-fault-receipt'

/** Canonical child reach time used by deterministic receipt fixtures. */
const reachedAt = '2026-08-02T00:00:00.000Z'

/** Private stdout canary that lifecycle evidence must never reproduce. */
const rawStdoutCanary = 'private-run-id-must-not-escape'

/** Promise paired with one explicit single-settlement resolver. */
type Deferred<Value> = {
  /** Pending Promise controlled by the resolver. */
  readonly promise: Promise<Value>
  /** Resolves the Promise with one value. */
  readonly resolve: (value: Value) => void
}

/** Test process port paired with its captured parent kill signals. */
type ProcessHarness = {
  /** Injected already-started child port. */
  readonly port: WorkspaceSearchMigrationRehearsalProcessPort
  /** Ordered signals sent through the parent-owned kill method. */
  readonly killSignals: string[]
  /** Ordered response-loss receipt digests acknowledged by the parent. */
  readonly acknowledgements: string[]
}

/**
 * Creates one deterministic externally resolved Promise.
 *
 * @returns Promise and idempotent explicit resolver.
 */
function createDeferred<Value>(): Deferred<Value> {
  let resolver: ((value: Value) => void) | undefined
  let settled = false
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve
  })
  return {
    promise,
    resolve: (value: Value): void => {
      if (settled) return
      settled = true
      if (resolver === undefined) {
        throw new Error('Deferred resolver was not initialized.')
      }
      resolver(value)
    },
  }
}

/**
 * Creates a canonical monotonically increasing test clock.
 *
 * @returns Clock advancing by one millisecond on every read.
 */
function createClock(): () => string {
  let offset = 0
  return (): string => {
    const timestamp = new Date(
      Date.UTC(2026, 7, 2, 1, 0, 0, offset),
    ).toISOString()
    offset += 1
    return timestamp
  }
}

/**
 * Creates one valid barrier or response-loss receipt.
 *
 * @param failpoint - Selected planning-page fault boundary.
 * @param pageSequence - Exact selected successor page sequence.
 * @returns Canonical secret-free receipt fixture.
 */
function createReceipt(
  failpoint:
    | 'planning-page-artifact-uploaded-before-checkpoint-commit'
    | 'planning-page-transaction-response-lost' =
      'planning-page-artifact-uploaded-before-checkpoint-commit',
  pageSequence = 2,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  return {
    receiptVersion: 1,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    failpoint,
    action: failpoint === 'planning-page-transaction-response-lost'
      ? 'response-loss'
      : 'barrier',
    target: {
      kind: 'source',
      source: 'documents',
      pageSequence,
      cursorState: 'present',
    },
    occurrence: 1,
    reachedAt,
  }
}

/**
 * Removes the runtime timestamp from one canonical receipt expectation.
 *
 * @param receipt - Canonical runtime receipt fixture.
 * @returns Exact pre-runtime expectation.
 */
function createExpectedReceipt(
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
): WorkspaceSearchMigrationRehearsalExpectedFaultReceipt {
  return {
    receiptVersion: receipt.receiptVersion,
    stage: receipt.stage,
    failpoint: receipt.failpoint,
    action: receipt.action,
    target: receipt.target,
    occurrence: receipt.occurrence,
  }
}

/**
 * Encodes one receipt in the child CLI's exact compact stderr envelope.
 *
 * @param receipt - Canonical secret-free receipt.
 * @returns LF-terminated UTF-8 bytes.
 */
function encodeReceiptLine(
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
): Uint8Array {
  return new TextEncoder().encode(`${serializeCanonicalJson({
    kind: faultReceiptLineKind,
    receipt,
  })}\n`)
}

/**
 * Splits bytes at two positions to exercise incremental line decoding.
 *
 * @param bytes - Complete encoded line.
 * @returns Three ordered detached byte chunks.
 */
function splitReceiptBytes(bytes: Uint8Array): readonly Uint8Array[] {
  const firstEnd = Math.max(1, Math.floor(bytes.byteLength / 3))
  const secondEnd = Math.max(
    firstEnd + 1,
    Math.floor((bytes.byteLength * 2) / 3),
  )
  return [
    bytes.slice(0, firstEnd),
    bytes.slice(firstEnd, secondEnd),
    bytes.slice(secondEnd),
  ]
}

/**
 * Yields fixed byte chunks and optionally remains open until completion.
 *
 * @param chunks - Ordered chunks to yield.
 * @param completion - Optional Promise holding the stream open.
 * @returns Incremental asynchronous byte stream.
 */
async function* createChunkStream(
  chunks: readonly Uint8Array[],
  completion?: Promise<void>,
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk
  if (completion !== undefined) await completion
}

/**
 * Creates a child that exits by a configured signal only after parent kill.
 *
 * @param stderrChunks - Incremental stderr chunks emitted before the barrier.
 * @param signal - Signal reported after the parent requests `SIGKILL`.
 * @param stdoutChunks - Optional bounded stdout chunks.
 * @param events - Optional ordered event sink.
 * @returns Process port and captured kill calls.
 */
function createKillTerminatedProcess(
  stderrChunks: readonly Uint8Array[],
  signal = 'SIGKILL',
  stdoutChunks: readonly Uint8Array[] = [],
  events?: string[],
): ProcessHarness {
  const killed = createDeferred<void>()
  const killSignals: string[] = []
  const acknowledgements: string[] = []
  const port: WorkspaceSearchMigrationRehearsalProcessPort = {
    stdout: createChunkStream(stdoutChunks, killed.promise),
    stderr: createChunkStream(stderrChunks, killed.promise),
    exited: killed.promise.then((): WorkspaceSearchMigrationRehearsalProcessExitResult => ({
      kind: 'signal',
      signal,
    })),
    kill: (requestedSignal): void => {
      killSignals.push(requestedSignal)
      events?.push('kill')
      killed.resolve(undefined)
    },
    acknowledgeResponseLoss: (receiptSha256): void => {
      acknowledgements.push(receiptSha256)
    },
  }
  return { port, killSignals, acknowledgements }
}

/**
 * Creates a response-loss child whose exit follows receipt consumption.
 *
 * @param stderrChunks - Incremental canonical receipt chunks.
 * @param stdoutChunks - Normal completion stdout chunks.
 * @param exitCode - Ordinary exit code reported after stderr is consumed.
 * @param events - Optional ordered event sink.
 * @returns Process port and captured kill calls.
 */
function createResponseLossProcess(
  stderrChunks: readonly Uint8Array[],
  stdoutChunks: readonly Uint8Array[],
  exitCode = 0,
  events?: string[],
): ProcessHarness {
  const acknowledged = createDeferred<void>()
  const killSignals: string[] = []
  const acknowledgements: string[] = []
  /** Yields stderr while the child waits for the parent's durable ACK. */
  async function* stderr(): AsyncIterable<Uint8Array> {
    for (const chunk of stderrChunks) yield chunk
  }
  const port: WorkspaceSearchMigrationRehearsalProcessPort = {
    stdout: createChunkStream(stdoutChunks),
    stderr: stderr(),
    exited: acknowledged.promise.then(
      (): WorkspaceSearchMigrationRehearsalProcessExitResult => {
        events?.push('exit')
        return { kind: 'exit-code', exitCode }
      },
    ),
    kill: (signal): void => {
      killSignals.push(signal)
      events?.push('kill')
    },
    acknowledgeResponseLoss: (receiptSha256): void => {
      acknowledgements.push(receiptSha256)
      events?.push('ack')
      acknowledged.resolve(undefined)
    },
  }
  return { port, killSignals, acknowledgements }
}

/**
 * Creates an already-completed ordinary process for missing-receipt tests.
 *
 * @param stderrChunks - Complete stderr chunks.
 * @param stdoutChunks - Complete stdout chunks.
 * @param exitCode - Ordinary process status.
 * @returns Process port and captured kill calls.
 */
function createCompletedProcess(
  stderrChunks: readonly Uint8Array[] = [],
  stdoutChunks: readonly Uint8Array[] = [],
  exitCode = 0,
): ProcessHarness {
  const killSignals: string[] = []
  const acknowledgements: string[] = []
  return {
    port: {
      stdout: createChunkStream(stdoutChunks),
      stderr: createChunkStream(stderrChunks),
      exited: Promise.resolve({ kind: 'exit-code', exitCode }),
      kill: (signal): void => {
        killSignals.push(signal)
      },
      acknowledgeResponseLoss: (receiptSha256): void => {
        acknowledgements.push(receiptSha256)
      },
    },
    killSignals,
    acknowledgements,
  }
}

/** Creates a success child whose streams remain open until parent ACK. */
function createSuccessfulProcessHarness(
  stdoutChunks: readonly Uint8Array[],
  materialChunks: readonly Uint8Array[],
  exitCode = 0,
  stdoutAfterAcknowledgement: readonly Uint8Array[] = [],
  materialAfterAcknowledgement: readonly Uint8Array[] = [],
): ProcessHarness {
  const acknowledgementGate = createDeferred<void>()
  const stdoutCompleted = createDeferred<void>()
  const materialCompleted = createDeferred<void>()
  const exited = createDeferred<WorkspaceSearchMigrationRehearsalProcessExitResult>()
  const killSignals: string[] = []
  const acknowledgements: string[] = []
  /** Emits one protocol stream and closes only after acknowledgement. */
  async function* output(
    chunks: readonly Uint8Array[],
    afterAcknowledgement: readonly Uint8Array[],
    completed: Deferred<void>,
  ): AsyncIterable<Uint8Array> {
    try {
      for (const chunk of chunks) yield chunk
      if (chunks.length === 0) return
      await acknowledgementGate.promise
      for (const chunk of afterAcknowledgement) yield chunk
    } finally {
      completed.resolve(undefined)
    }
  }
  void Promise.all([
    stdoutCompleted.promise,
    materialCompleted.promise,
  ]).then((): void => {
    exited.resolve({ kind: 'exit-code', exitCode })
  })
  return {
    port: {
      stdout: output(
        stdoutChunks,
        stdoutAfterAcknowledgement,
        stdoutCompleted,
      ),
      stderr: output(
        materialChunks,
        materialAfterAcknowledgement,
        materialCompleted,
      ),
      exited: exited.promise,
      kill: (signal): void => {
        killSignals.push(signal)
        exited.resolve({ kind: 'signal', signal })
        acknowledgementGate.resolve(undefined)
      },
      acknowledgeResponseLoss: (materialDigest): void => {
        acknowledgements.push(materialDigest)
        acknowledgementGate.resolve(undefined)
      },
    },
    killSignals,
    acknowledgements,
  }
}

/** Splits exact protocol bytes into three non-empty chunks. */
function splitProtocolBytes(bytes: Uint8Array): readonly Uint8Array[] {
  return splitReceiptBytes(bytes)
}

/** Creates exact authentic stdout and FD3 success protocol bytes. */
function createSuccessfulProtocolFixture() {
  const fixture =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
  const captured =
    captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
      selection: fixture.selection,
      authenticationKey: fixture.authenticationKey,
      observation: fixture.observation,
    })
  const material =
    createWorkspaceSearchMigrationRehearsalStageChildMaterial({
      selection: fixture.selection,
      observation: captured,
      committedRateSegment: fixture.committedRateSegment,
      stageReservation: fixture.stageReservation,
      claimedStageHead: fixture.claimedStageHead,
      leaseAcquisitionObservation:
        fixture.leaseAcquisitionObservation,
      authenticationKey: fixture.authenticationKey,
    })
  return Object.freeze({
    fixture,
    material,
    stdoutBytes: new TextEncoder().encode(
      `${fixture.observation.serializedOutputLine}\n`,
    ),
    materialBytes: new TextEncoder().encode(
      `${serializeCanonicalJson(material)}\n`,
    ),
  })
}

/**
 * Requires one runner Promise to reject with an exact stable code.
 *
 * @param operation - Pending runner operation.
 * @param code - Expected raw-value-free failure code.
 */
async function expectRunnerError(
  operation: Promise<unknown>,
  code: WorkspaceSearchMigrationRehearsalProcessRunnerErrorCode,
): Promise<void> {
  try {
    await operation
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalProcessRunnerError,
    )
    if (
      !(error instanceof
        WorkspaceSearchMigrationRehearsalProcessRunnerError)
    ) {
      throw error
    }
    expect(error.code).toBe(code)
    expect(error.message).toBe(code)
    expect(JSON.stringify(error)).not.toContain(rawStdoutCanary)
    return
  }
  throw new Error('Expected the rehearsal process runner to fail.')
}

describe('Workspace Search migration rehearsal process runner', () => {
  test('persists a split barrier receipt before the parent sends SIGKILL', async () => {
    const receipt = createReceipt()
    const events: string[] = []
    const processHarness = createKillTerminatedProcess(
      splitReceiptBytes(encodeReceiptLine(receipt)),
      'SIGKILL',
      [],
      events,
    )
    const persistEntered = createDeferred<void>()
    const releasePersistence = createDeferred<void>()
    let persistedInput:
      WorkspaceSearchMigrationRehearsalDurableFaultReceiptInput | undefined

    const operation = runWorkspaceSearchMigrationRehearsalProcess({
      process: processHarness.port,
      expectedReceipt: createExpectedReceipt(receipt),
      persistFaultReceiptDurably: async (input): Promise<void> => {
        events.push('persist-start')
        persistedInput = input
        persistEntered.resolve(undefined)
        await releasePersistence.promise
        events.push('persist-end')
      },
      now: createClock(),
    })

    await persistEntered.promise
    expect(processHarness.killSignals).toEqual([])
    expect(events).toEqual(['persist-start'])
    releasePersistence.resolve(undefined)

    const evidence = await operation
    expect(events).toEqual(['persist-start', 'persist-end', 'kill'])
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
    expect(evidence.exitClass).toBe('confirmed-sigkill')
    expect(evidence.receiptSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(evidence.stdoutSha256).toBe(
      createHash('sha256').update(new Uint8Array()).digest('hex'),
    )
    expect(evidence.receiptObservedAt <= evidence.receiptPersistedAt)
      .toBe(true)
    expect(
      evidence.receiptPersistedAt <= evidence.parentDecisionRecordedAt,
    ).toBe(true)
    expect(
      evidence.parentDecisionRecordedAt <= evidence.processExitedAt,
    ).toBe(true)
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Object.isFrozen(persistedInput)).toBe(true)
    expect(persistedInput?.receipt).toEqual(receipt)
    expect(persistedInput?.receiptSha256).toBe(evidence.receiptSha256)
  })

  test('never kills response loss and requires a normal zero exit', async () => {
    const receipt = createReceipt(
      'planning-page-transaction-response-lost',
    )
    const events: string[] = []
    const stdout = new TextEncoder().encode(
      `${JSON.stringify({ status: 'ok', runId: rawStdoutCanary })}\n`,
    )
    const processHarness = createResponseLossProcess(
      splitReceiptBytes(encodeReceiptLine(receipt)),
      [stdout],
      0,
      events,
    )

    const evidence = await runWorkspaceSearchMigrationRehearsalProcess({
      process: processHarness.port,
      expectedReceipt: createExpectedReceipt(receipt),
      persistFaultReceiptDurably: async (): Promise<void> => {
        events.push('persist')
      },
      now: createClock(),
    })

    expect(processHarness.killSignals).toEqual([])
    expect(events).toEqual(['persist', 'ack', 'exit'])
    expect(evidence.exitClass).toBe('successful-response-loss')
    expect(processHarness.acknowledgements).toEqual([
      evidence.receiptSha256,
    ])
    expect(evidence.stdoutSha256).toBe(
      createHash('sha256').update(stdout).digest('hex'),
    )
    expect(JSON.stringify(evidence)).not.toContain(rawStdoutCanary)
  })

  test('holds response-loss acknowledgement until persistence is durable', async () => {
    const receipt = createReceipt(
      'planning-page-transaction-response-lost',
    )
    const persistenceEntered = createDeferred<void>()
    const releasePersistence = createDeferred<void>()
    const events: string[] = []
    const processHarness = createResponseLossProcess(
      [encodeReceiptLine(receipt)],
      [],
      0,
      events,
    )

    let completed = false
    const operation = runWorkspaceSearchMigrationRehearsalProcess({
      process: processHarness.port,
      expectedReceipt: createExpectedReceipt(receipt),
      persistFaultReceiptDurably: async (): Promise<void> => {
        events.push('persist-start')
        persistenceEntered.resolve(undefined)
        await releasePersistence.promise
        events.push('persist-end')
      },
      now: createClock(),
    }).then((evidence) => {
      completed = true
      return evidence
    })

    await persistenceEntered.promise
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(events).toEqual(['persist-start'])
    expect(processHarness.acknowledgements).toEqual([])
    expect(processHarness.killSignals).toEqual([])
    releasePersistence.resolve(undefined)

    const evidence = await operation
    expect(evidence.exitClass).toBe('successful-response-loss')
    expect(events).toEqual([
      'persist-start',
      'persist-end',
      'ack',
      'exit',
    ])
    expect(evidence.receiptPersistedAt <= evidence.processExitedAt).toBe(true)
    expect(processHarness.acknowledgements).toEqual([
      evidence.receiptSha256,
    ])
    expect(processHarness.killSignals).toEqual([])
  })

  test('rejects a receipt for the wrong exact target', async () => {
    const expectedReceipt = createReceipt()
    const wrongReceipt = createReceipt(
      'planning-page-artifact-uploaded-before-checkpoint-commit',
      3,
    )
    const processHarness = createKillTerminatedProcess([
      encodeReceiptLine(wrongReceipt),
    ])

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(expectedReceipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
      }),
      'UNEXPECTED_FAULT_RECEIPT',
    )
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('rejects a barrier exit reported under the wrong signal', async () => {
    const receipt = createReceipt()
    const processHarness = createKillTerminatedProcess(
      [encodeReceiptLine(receipt)],
      'SIGTERM',
    )

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
      }),
      'UNCONFIRMED_SIGKILL_EXIT',
    )
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('rejects normal completion without the expected receipt', async () => {
    const receipt = createReceipt()
    const processHarness = createCompletedProcess()

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
      }),
      'MISSING_FAULT_RECEIPT',
    )
    expect(processHarness.killSignals).toEqual([])
  })

  test('rejects a duplicate receipt after persisting exactly once', async () => {
    const receipt = createReceipt()
    const processHarness = createKillTerminatedProcess([
      encodeReceiptLine(receipt),
      encodeReceiptLine(receipt),
    ])
    let persistenceCount = 0

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {
          persistenceCount += 1
        },
        now: createClock(),
      }),
      'DUPLICATE_FAULT_RECEIPT',
    )
    expect(persistenceCount).toBe(1)
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('rejects extra stderr output after the only receipt', async () => {
    const receipt = createReceipt()
    const processHarness = createKillTerminatedProcess([
      encodeReceiptLine(receipt),
      new TextEncoder().encode('{}\n'),
    ])

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
      }),
      'EXTRA_STDERR_OUTPUT',
    )
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('rejects a compact but noncanonical receipt line', async () => {
    const receipt = createReceipt()
    const noncanonical = new TextEncoder().encode(`${JSON.stringify({
      receipt,
      kind: faultReceiptLineKind,
    })}\n`)
    const processHarness = createKillTerminatedProcess([noncanonical])

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
      }),
      'INVALID_FAULT_RECEIPT_LINE',
    )
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('bounds stderr incrementally before attempting to decode it', async () => {
    const receipt = createReceipt()
    const oversized = new Uint8Array(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDERR_BYTES + 1,
    )
    const processHarness = createKillTerminatedProcess([oversized])

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
      }),
      'STDERR_LIMIT_EXCEEDED',
    )
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('bounds stdout incrementally without retaining its contents', async () => {
    const receipt = createReceipt()
    const oversized = new Uint8Array(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES + 1,
    )
    const processHarness = createKillTerminatedProcess([], 'SIGKILL', [
      oversized,
    ])

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
      }),
      'STDOUT_LIMIT_EXCEEDED',
    )
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('waits for in-flight receipt persistence before failure containment', async () => {
    const receipt = createReceipt()
    const persistenceEntered = createDeferred<void>()
    const releasePersistence = createDeferred<void>()
    const killed = createDeferred<void>()
    const killSignals: string[] = []
    /** Emits an oversized chunk only after the receipt writer has started. */
    async function* failingStdout(): AsyncIterable<Uint8Array> {
      await persistenceEntered.promise
      yield new Uint8Array(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES + 1,
      )
      await killed.promise
    }
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: failingStdout(),
      stderr: createChunkStream([encodeReceiptLine(receipt)], killed.promise),
      exited: killed.promise.then(
        (): WorkspaceSearchMigrationRehearsalProcessExitResult => ({
          kind: 'signal',
          signal: 'SIGKILL',
        }),
      ),
      kill: (signal): void => {
        killSignals.push(signal)
        killed.resolve(undefined)
      },
      acknowledgeResponseLoss: (): void => {},
    }

    const operation = runWorkspaceSearchMigrationRehearsalProcess({
      process: port,
      expectedReceipt: createExpectedReceipt(receipt),
      persistFaultReceiptDurably: async (): Promise<void> => {
        persistenceEntered.resolve(undefined)
        await releasePersistence.promise
      },
      now: createClock(),
    })
    await persistenceEntered.promise
    await Promise.resolve()
    expect(killSignals).toEqual([])
    releasePersistence.resolve(undefined)

    await expectRunnerError(operation, 'STDOUT_LIMIT_EXCEEDED')
    expect(killSignals).toEqual(['SIGKILL'])
  })

  test('rejects exit while durable receipt persistence is pending', async () => {
    const receipt = createReceipt()
    const receiptEmitted = createDeferred<void>()
    const persistenceEntered = createDeferred<void>()
    const releasePersistence = createDeferred<void>()
    const killSignals: string[] = []
    /** Emits one receipt only after making early ordinary exit observable. */
    async function* prematureStderr(): AsyncIterable<Uint8Array> {
      receiptEmitted.resolve(undefined)
      yield encodeReceiptLine(receipt)
    }
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: createChunkStream([]),
      stderr: prematureStderr(),
      exited: receiptEmitted.promise.then(
        (): WorkspaceSearchMigrationRehearsalProcessExitResult => ({
          kind: 'exit-code',
          exitCode: 0,
        }),
      ),
      kill: (signal): void => {
        killSignals.push(signal)
      },
      acknowledgeResponseLoss: (): void => {},
    }

    const operation = runWorkspaceSearchMigrationRehearsalProcess({
      process: port,
      expectedReceipt: createExpectedReceipt(receipt),
      persistFaultReceiptDurably: async (): Promise<void> => {
        persistenceEntered.resolve(undefined)
        await releasePersistence.promise
      },
      now: createClock(),
    })
    await persistenceEntered.promise
    releasePersistence.resolve(undefined)

    await expectRunnerError(operation, 'PREMATURE_PROCESS_EXIT')
    expect(killSignals).toEqual([])
  })

  test('rejects nonzero response-loss completion without killing it', async () => {
    const receipt = createReceipt(
      'planning-page-transaction-response-lost',
    )
    const processHarness = createResponseLossProcess(
      [encodeReceiptLine(receipt)],
      [],
      1,
    )

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
      }),
      'UNEXPECTED_RESPONSE_LOSS_EXIT',
    )
    expect(processHarness.killSignals).toEqual([])
  })

  test('contains a child when the finite runtime deadline expires', async () => {
    const receipt = createReceipt()
    const processHarness = createKillTerminatedProcess([])

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
        runtimeTimeoutMilliseconds: 20,
        containmentTimeoutMilliseconds: 100,
      }),
      'PROCESS_RUNTIME_TIMEOUT',
    )
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('aborts and settles an in-flight writer before timeout containment', async () => {
    const receipt = createReceipt()
    const events: string[] = []
    const processHarness = createKillTerminatedProcess(
      [encodeReceiptLine(receipt)],
      'SIGKILL',
      [],
      events,
    )

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (_input, signal): Promise<void> => {
          events.push('persist-start')
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              events.push('persist-abort')
              resolve()
              return
            }
            signal.addEventListener('abort', (): void => {
              events.push('persist-abort')
              resolve()
            }, { once: true })
          })
        },
        now: createClock(),
        runtimeTimeoutMilliseconds: 20,
        containmentTimeoutMilliseconds: 100,
      }),
      'PROCESS_RUNTIME_TIMEOUT',
    )
    expect(events).toEqual(['persist-start', 'persist-abort', 'kill'])
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('still contains the child when an aborted writer never settles', async () => {
    const receipt = createReceipt()
    const events: string[] = []
    const processHarness = createKillTerminatedProcess(
      [encodeReceiptLine(receipt)],
      'SIGKILL',
      [],
      events,
    )

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: processHarness.port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (_input, signal): Promise<void> => {
          events.push('persist-start')
          signal.addEventListener('abort', (): void => {
            events.push('persist-abort')
          }, { once: true })
          await new Promise<void>(() => {})
        },
        now: createClock(),
        runtimeTimeoutMilliseconds: 20,
        containmentTimeoutMilliseconds: 20,
      }),
      'PROCESS_CONTAINMENT_TIMEOUT',
    )
    expect(events).toEqual(['persist-start', 'persist-abort', 'kill'])
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('fails with a finite containment timeout when exit never settles', async () => {
    const receipt = createReceipt()
    const pendingExit = createDeferred<WorkspaceSearchMigrationRehearsalProcessExitResult>()
    const killSignals: string[] = []
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: createChunkStream([]),
      stderr: createChunkStream([]),
      exited: pendingExit.promise,
      kill: (signal): void => {
        killSignals.push(signal)
      },
      acknowledgeResponseLoss: (): void => {},
    }

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalProcess({
        process: port,
        expectedReceipt: createExpectedReceipt(receipt),
        persistFaultReceiptDurably: async (): Promise<void> => {},
        now: createClock(),
        runtimeTimeoutMilliseconds: 20,
        containmentTimeoutMilliseconds: 20,
      }),
      'PROCESS_CONTAINMENT_TIMEOUT',
    )
    expect(killSignals).toEqual(['SIGKILL'])
  })
})

describe('authenticated generic-success process runner', () => {
  test('persists split lines before ACK without waiting for stream EOF', async () => {
    const protocol = createSuccessfulProtocolFixture()
    const processHarness = createSuccessfulProcessHarness(
      splitProtocolBytes(protocol.stdoutBytes),
      splitProtocolBytes(protocol.materialBytes),
    )
    const persistenceEntered = createDeferred<void>()
    const releasePersistence = createDeferred<void>()
    const events: string[] = []
    const operation =
      runWorkspaceSearchMigrationRehearsalSuccessfulProcess({
        process: processHarness.port,
        expectedSelection: protocol.fixture.selection,
        verificationKey: protocol.fixture.authenticationKey,
        persistSuccessMaterialDurably: async (): Promise<void> => {
          events.push('persist-start')
          persistenceEntered.resolve(undefined)
          await releasePersistence.promise
          events.push('persist-end')
        },
        now: createClock(),
        runtimeTimeoutMilliseconds: 1_000,
        containmentTimeoutMilliseconds: 1_000,
      })

    await persistenceEntered.promise
    expect(processHarness.acknowledgements).toEqual([])
    releasePersistence.resolve(undefined)
    const lifecycle = await operation

    expect(events).toEqual(['persist-start', 'persist-end'])
    expect(processHarness.acknowledgements).toEqual([
      createMigrationDigest(protocol.material),
    ])
    expect(processHarness.killSignals).toEqual([])
    expect(lifecycle.stdoutSha256).toBe(
      createHash('sha256').update(protocol.stdoutBytes).digest('hex'),
    )
  })

  test.each([
    ['empty', []],
    [
      'different canonical line',
      [new TextEncoder().encode(`${serializeCanonicalJson({ status: 'other' })}\n`)],
    ],
    [
      'multiple lines',
      [new TextEncoder().encode(`${serializeCanonicalJson({ status: 'one' })}\n${serializeCanonicalJson({ status: 'two' })}\n`)],
    ],
    [
      'noncanonical line',
      [new TextEncoder().encode('{"z":1, "a":2}\n')],
    ],
    [
      'trailing bytes',
      [new TextEncoder().encode(`${serializeCanonicalJson({ status: 'other' })}\ntrailing`)],
    ],
  ])('rejects %s stdout before acknowledgement', async (_label, chunks) => {
    const protocol = createSuccessfulProtocolFixture()
    const processHarness = createSuccessfulProcessHarness(
      chunks,
      [protocol.materialBytes],
    )

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalSuccessfulProcess({
        process: processHarness.port,
        expectedSelection: protocol.fixture.selection,
        verificationKey: protocol.fixture.authenticationKey,
        persistSuccessMaterialDurably: async (): Promise<void> => {},
        now: createClock(),
        runtimeTimeoutMilliseconds: 200,
        containmentTimeoutMilliseconds: 200,
      }),
      'INVALID_SUCCESS_STDOUT',
    )
    expect(processHarness.acknowledgements).toEqual([])
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test.each([
    [
      'duplicate FD3 line',
      (bytes: Uint8Array): Uint8Array => {
        const combined = new Uint8Array(bytes.byteLength * 2)
        combined.set(bytes)
        combined.set(bytes, bytes.byteLength)
        return combined
      },
    ],
    [
      'trailing FD3 bytes',
      (bytes: Uint8Array): Uint8Array => {
        const suffix = new TextEncoder().encode('trailing')
        const combined = new Uint8Array(bytes.byteLength + suffix.byteLength)
        combined.set(bytes)
        combined.set(suffix, bytes.byteLength)
        return combined
      },
    ],
  ])('rejects %s before acknowledgement', async (_label, mutate) => {
    const protocol = createSuccessfulProtocolFixture()
    const processHarness = createSuccessfulProcessHarness(
      [protocol.stdoutBytes],
      [mutate(protocol.materialBytes)],
    )

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalSuccessfulProcess({
        process: processHarness.port,
        expectedSelection: protocol.fixture.selection,
        verificationKey: protocol.fixture.authenticationKey,
        persistSuccessMaterialDurably: async (): Promise<void> => {},
        now: createClock(),
        runtimeTimeoutMilliseconds: 200,
        containmentTimeoutMilliseconds: 200,
      }),
      'DUPLICATE_SUCCESS_MATERIAL',
    )
    expect(processHarness.acknowledgements).toEqual([])
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('contains on persistence failure without acknowledging', async () => {
    const protocol = createSuccessfulProtocolFixture()
    const processHarness = createSuccessfulProcessHarness(
      [protocol.stdoutBytes],
      [protocol.materialBytes],
    )

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalSuccessfulProcess({
        process: processHarness.port,
        expectedSelection: protocol.fixture.selection,
        verificationKey: protocol.fixture.authenticationKey,
        persistSuccessMaterialDurably: async (): Promise<void> => {
          throw new Error('private persistence failure')
        },
        now: createClock(),
        runtimeTimeoutMilliseconds: 200,
        containmentTimeoutMilliseconds: 200,
      }),
      'SUCCESS_MATERIAL_PERSIST_FAILED',
    )
    expect(processHarness.acknowledgements).toEqual([])
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('rejects a nonzero ordinary exit after durable ACK', async () => {
    const protocol = createSuccessfulProtocolFixture()
    const processHarness = createSuccessfulProcessHarness(
      [protocol.stdoutBytes],
      [protocol.materialBytes],
      1,
    )

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalSuccessfulProcess({
        process: processHarness.port,
        expectedSelection: protocol.fixture.selection,
        verificationKey: protocol.fixture.authenticationKey,
        persistSuccessMaterialDurably: async (): Promise<void> => {},
        now: createClock(),
        runtimeTimeoutMilliseconds: 200,
        containmentTimeoutMilliseconds: 200,
      }),
      'UNEXPECTED_SUCCESS_EXIT',
    )
    expect(processHarness.acknowledgements).toEqual([
      createMigrationDigest(protocol.material),
    ])
    expect(processHarness.killSignals).toEqual([])
  })

  test('aborts a pending success-material writer on timeout', async () => {
    const protocol = createSuccessfulProtocolFixture()
    const processHarness = createSuccessfulProcessHarness(
      [protocol.stdoutBytes],
      [protocol.materialBytes],
    )
    const events: string[] = []

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalSuccessfulProcess({
        process: processHarness.port,
        expectedSelection: protocol.fixture.selection,
        verificationKey: protocol.fixture.authenticationKey,
        persistSuccessMaterialDurably: async (_input, signal): Promise<void> => {
          events.push('persist-start')
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', (): void => {
              events.push('persist-abort')
              resolve()
            }, { once: true })
          })
        },
        now: createClock(),
        runtimeTimeoutMilliseconds: 20,
        containmentTimeoutMilliseconds: 200,
      }),
      'PROCESS_RUNTIME_TIMEOUT',
    )
    expect(events).toEqual(['persist-start', 'persist-abort'])
    expect(processHarness.acknowledgements).toEqual([])
    expect(processHarness.killSignals).toEqual(['SIGKILL'])
  })

  test('acknowledges a real child before stdout and FD3 close', async () => {
    const protocol = createSuccessfulProtocolFixture()
    const fixture = protocol.fixture
    const material = protocol.material
    const stdoutBytes = protocol.stdoutBytes
    const materialBytes = protocol.materialBytes
    const childScript = [
      "const fs = require('node:fs')",
      `fs.writeSync(1, Buffer.from('${Buffer.from(stdoutBytes).toString('base64')}', 'base64'))`,
      `fs.writeSync(3, Buffer.from('${Buffer.from(materialBytes).toString('base64')}', 'base64'))`,
      "process.stdin.resume()",
      "process.stdin.once('data', () => process.exit(0))",
    ].join(';')
    const child = spawn(process.execPath, ['-e', childScript], {
      stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
    })
    const childStdin = child.stdin
    const childStdout = child.stdout
    const childMaterial = child.stdio[3]
    if (
      !(childStdin instanceof Writable) ||
      !(childStdout instanceof Readable) ||
      !(childMaterial instanceof Readable)
    ) {
      child.kill('SIGKILL')
      throw new Error('Expected real child protocol pipes.')
    }
    const events: string[] = []
    const acknowledgements: string[] = []
    const exited = new Promise<WorkspaceSearchMigrationRehearsalProcessExitResult>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (exitCode, signal): void => {
          if (signal !== null) {
            resolve({ kind: 'signal', signal })
            return
          }
          resolve({ kind: 'exit-code', exitCode: exitCode ?? 1 })
        })
      },
    )
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: childStdout,
      stderr: childMaterial,
      exited,
      kill: (signal): void => {
        events.push('kill')
        if (signal !== 'SIGKILL') {
          throw new Error('Unexpected integration-test kill signal.')
        }
        child.kill('SIGKILL')
      },
      acknowledgeResponseLoss: (materialDigest): void => {
        events.push('ack')
        acknowledgements.push(materialDigest)
        childStdin.end(`${materialDigest}\n`)
      },
    }
    let persisted:
      WorkspaceSearchMigrationRehearsalDurableSuccessMaterialInput |
      undefined

    const lifecycle =
      await runWorkspaceSearchMigrationRehearsalSuccessfulProcess({
        process: port,
        expectedSelection: fixture.selection,
        verificationKey: fixture.authenticationKey,
        persistSuccessMaterialDurably: async (input): Promise<void> => {
          events.push('persist')
          persisted = input
        },
        now: createClock(),
        runtimeTimeoutMilliseconds: 2_000,
        containmentTimeoutMilliseconds: 2_000,
      })

    expect(events).toEqual(['persist', 'ack'])
    expect(acknowledgements).toEqual([createMigrationDigest(material)])
    expect(persisted?.material).toEqual(material)
    expect(lifecycle.exitClass).toBe('successful-no-fault')
    expect(lifecycle.stdoutSha256).toBe(
      createHash('sha256').update(stdoutBytes).digest('hex'),
    )
  })
})

describe('authenticated fault material process runner', () => {
  test('persists authenticated boundary before parent SIGKILL', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const receipt: WorkspaceSearchMigrationRehearsalFaultReceipt = {
      receiptVersion: 1,
      stage: 'non-production',
      failpoint: fixture.faultPlan.failpoint,
      action: 'barrier',
      target: fixture.faultPlan.target,
      occurrence: 1,
      reachedAt: '2026-08-02T00:30:00.000Z',
    }
    const material =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        faultReceipt: receipt,
        committedRateSegment: fixture.committedRateSegment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.authenticationKey,
      })
    const killed = createDeferred<void>()
    const events: string[] = []
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: createChunkStream([], killed.promise),
      stderr: createChunkStream([
        new TextEncoder().encode(`${serializeCanonicalJson(material)}\n`),
      ], killed.promise),
      exited: killed.promise.then(() => ({
        kind: 'signal',
        signal: 'SIGKILL',
      })),
      kill: (): void => {
        events.push('kill')
        killed.resolve(undefined)
      },
      acknowledgeResponseLoss: (): void => {
        events.push('unexpected-ack')
      },
    }
    let persisted:
      WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialInput |
      undefined

    const lifecycle =
      await runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess({
        process: port,
        expectedSelection: fixture.selection,
        expectedFaultPlan: fixture.faultPlan,
        verificationKey: fixture.authenticationKey,
        readRateSegmentBytes: async (): Promise<Uint8Array> => {
          events.push('rate-read')
          return fixture.committedRateSegment.canonicalBytes
        },
        persistBoundaryMaterialDurably: async (input): Promise<void> => {
          events.push('persist-boundary')
          persisted = input
        },
        persistCompletionMaterialDurably: async (): Promise<void> => {
          events.push('unexpected-completion')
        },
        now: createClock(),
      })

    expect(events).toEqual(['rate-read', 'persist-boundary', 'kill'])
    expect(persisted?.material).toEqual(material)
    expect(lifecycle.exitClass).toBe('confirmed-sigkill')
    expect(lifecycle.boundaryMaterialDigest).toBe(
      createMigrationDigest(material),
    )
    expect(lifecycle.completionMaterialDigest).toBeNull()
  })

  test('keeps stdin open through first ACK and closes after final persistence', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        true,
      )
    const receipt: WorkspaceSearchMigrationRehearsalFaultReceipt = {
      receiptVersion: 1,
      stage: 'non-production',
      failpoint: fixture.faultPlan.failpoint,
      action: 'response-loss',
      target: fixture.faultPlan.target,
      occurrence: 1,
      reachedAt: '2026-08-02T00:30:00.000Z',
    }
    const boundary =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        faultReceipt: receipt,
        committedRateSegment: fixture.committedRateSegment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.authenticationKey,
      })
    const observation =
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection: fixture.selection,
        authenticationKey: fixture.authenticationKey,
        observation: fixture.observation,
      })
    const completion =
      createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes:
          fixture.committedRateSegment.canonicalBytes,
        observation,
        committedRateSegment: fixture.committedRateSegment,
        authenticationKey: fixture.authenticationKey,
      })
    const firstAck = createDeferred<void>()
    const finalAck = createDeferred<void>()
    const events: string[] = []
    const acknowledgements: Array<readonly [string, boolean | undefined]> = []
    /** Emits each material only after its preceding durable acknowledgement. */
    async function* materialStream(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode(
        `${serializeCanonicalJson(boundary)}\n`,
      )
      await firstAck.promise
      yield new TextEncoder().encode(
        `${serializeCanonicalJson(completion)}\n`,
      )
      await finalAck.promise
    }
    /** Emits the sole stdout line after synthetic response loss is released. */
    async function* stdoutStream(): AsyncIterable<Uint8Array> {
      await firstAck.promise
      yield new TextEncoder().encode(
        `${fixture.observation.serializedOutputLine}\n`,
      )
      await finalAck.promise
    }
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: stdoutStream(),
      stderr: materialStream(),
      exited: finalAck.promise.then(() => ({
        kind: 'exit-code',
        exitCode: 0,
      })),
      kill: (): void => {
        events.push('kill')
        finalAck.resolve(undefined)
      },
      acknowledgeResponseLoss: (digestValue, final): void => {
        acknowledgements.push([digestValue, final])
        if (final === false) {
          events.push('ack-boundary-open')
          firstAck.resolve(undefined)
          return
        }
        events.push('ack-completion-close')
        finalAck.resolve(undefined)
      },
    }
    let boundaryPersisted:
      WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialInput |
      undefined
    let completionPersisted:
      WorkspaceSearchMigrationRehearsalDurableFaultCompletionMaterialInput |
      undefined

    const lifecycle =
      await runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess({
        process: port,
        expectedSelection: fixture.selection,
        expectedFaultPlan: fixture.faultPlan,
        verificationKey: fixture.authenticationKey,
        readRateSegmentBytes: async (phase): Promise<Uint8Array> => {
          events.push(`rate:${phase}`)
          return fixture.committedRateSegment.canonicalBytes
        },
        persistBoundaryMaterialDurably: async (input): Promise<void> => {
          events.push('persist-boundary')
          boundaryPersisted = input
        },
        persistCompletionMaterialDurably: async (input): Promise<void> => {
          events.push('persist-completion')
          completionPersisted = input
        },
        now: createClock(),
      })

    expect(events).toEqual([
      'rate:boundary',
      'persist-boundary',
      'ack-boundary-open',
      'rate:completion',
      'persist-completion',
      'ack-completion-close',
    ])
    expect(acknowledgements).toEqual([
      [createMigrationDigest(boundary), false],
      [createMigrationDigest(completion), true],
    ])
    expect(boundaryPersisted?.material).toEqual(boundary)
    expect(completionPersisted?.material).toEqual(completion)
    expect(lifecycle.exitClass).toBe('successful-response-loss')
    expect(lifecycle.completionMaterialDigest).toBe(
      createMigrationDigest(completion),
    )
  })

  test('withholds ACK and contains on duplicate material or persistence failure', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const receipt: WorkspaceSearchMigrationRehearsalFaultReceipt = {
      receiptVersion: 1,
      stage: 'non-production',
      failpoint: fixture.faultPlan.failpoint,
      action: 'barrier',
      target: fixture.faultPlan.target,
      occurrence: 1,
      reachedAt: '2026-08-02T00:30:00.000Z',
    }
    const material =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        faultReceipt: receipt,
        committedRateSegment: fixture.committedRateSegment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.authenticationKey,
      })
    const line = `${serializeCanonicalJson(material)}\n`
    for (const duplicate of [false, true]) {
      const killed = createDeferred<void>()
      const acknowledgements: string[] = []
      const port: WorkspaceSearchMigrationRehearsalProcessPort = {
        stdout: createChunkStream([], killed.promise),
        stderr: createChunkStream([
          new TextEncoder().encode(duplicate ? `${line}${line}` : line),
        ], killed.promise),
        exited: killed.promise.then(() => ({
          kind: 'signal',
          signal: 'SIGKILL',
        })),
        kill: (): void => killed.resolve(undefined),
        acknowledgeResponseLoss: (value): void => {
          acknowledgements.push(value)
        },
      }
      await expect(
        runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess({
          process: port,
          expectedSelection: fixture.selection,
          expectedFaultPlan: fixture.faultPlan,
          verificationKey: fixture.authenticationKey,
          readRateSegmentBytes: async () =>
            fixture.committedRateSegment.canonicalBytes,
          persistBoundaryMaterialDurably: async (): Promise<void> => {
            if (!duplicate) throw new Error('persist failed')
          },
          persistCompletionMaterialDurably: async (): Promise<void> => {},
          now: createClock(),
          containmentTimeoutMilliseconds: 100,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationRehearsalProcessRunnerError,
      )
      expect(acknowledgements).toEqual([])
    }
  })

  test('contains an authenticated fault child on a finite runtime timeout', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const killed = createDeferred<void>()
    const killSignals: string[] = []
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: createChunkStream([], killed.promise),
      stderr: createChunkStream([], killed.promise),
      exited: killed.promise.then(() => ({
        kind: 'signal',
        signal: 'SIGKILL',
      })),
      kill: (signal): void => {
        killSignals.push(signal)
        killed.resolve(undefined)
      },
      acknowledgeResponseLoss: (): void => {
        throw new Error('Timeout must not acknowledge the child.')
      },
    }

    await expectRunnerError(
      runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess({
        process: port,
        expectedSelection: fixture.selection,
        expectedFaultPlan: fixture.faultPlan,
        verificationKey: fixture.authenticationKey,
        readRateSegmentBytes: async () =>
          fixture.committedRateSegment.canonicalBytes,
        persistBoundaryMaterialDurably: async (): Promise<void> => {},
        persistCompletionMaterialDurably: async (): Promise<void> => {},
        now: createClock(),
        runtimeTimeoutMilliseconds: 20,
        containmentTimeoutMilliseconds: 200,
      }),
      'PROCESS_RUNTIME_TIMEOUT',
    )
    expect(killSignals).toEqual(['SIGKILL'])
  })

  test('rejects a nonzero response-loss exit after both durable ACKs', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        true,
      )
    const receipt: WorkspaceSearchMigrationRehearsalFaultReceipt = {
      receiptVersion: 1,
      stage: 'non-production',
      failpoint: fixture.faultPlan.failpoint,
      action: 'response-loss',
      target: fixture.faultPlan.target,
      occurrence: 1,
      reachedAt: '2026-08-02T00:30:00.000Z',
    }
    const boundary =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        faultReceipt: receipt,
        committedRateSegment: fixture.committedRateSegment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.authenticationKey,
      })
    const completion =
      createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
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
    const firstAck = createDeferred<void>()
    const finalAck = createDeferred<void>()
    /** Emits completion only after the first durable acknowledgement. */
    async function* materialStream(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode(
        `${serializeCanonicalJson(boundary)}\n`,
      )
      await firstAck.promise
      yield new TextEncoder().encode(
        `${serializeCanonicalJson(completion)}\n`,
      )
      await finalAck.promise
    }
    /** Emits reconciliation stdout only after the first ACK. */
    async function* stdoutStream(): AsyncIterable<Uint8Array> {
      await firstAck.promise
      yield new TextEncoder().encode(
        `${fixture.observation.serializedOutputLine}\n`,
      )
      await finalAck.promise
    }
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: stdoutStream(),
      stderr: materialStream(),
      exited: finalAck.promise.then(() => ({
        kind: 'exit-code',
        exitCode: 7,
      })),
      kill: (): void => {
        finalAck.resolve(undefined)
      },
      acknowledgeResponseLoss: (_digestValue, final): void => {
        if (final === false) firstAck.resolve(undefined)
        else finalAck.resolve(undefined)
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess({
        process: port,
        expectedSelection: fixture.selection,
        expectedFaultPlan: fixture.faultPlan,
        verificationKey: fixture.authenticationKey,
        readRateSegmentBytes: async () =>
          fixture.committedRateSegment.canonicalBytes,
        persistBoundaryMaterialDurably: async (): Promise<void> => {},
        persistCompletionMaterialDurably: async (): Promise<void> => {},
        now: createClock(),
        containmentTimeoutMilliseconds: 100,
      }),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalProcessRunnerError,
    )
  })
})
