import { createHash } from 'node:crypto'
import {
  isDeepStrictEqual,
  types as nodeUtilTypes,
} from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  serializeCanonicalJson,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationRehearsalFaultReceipt,
  snapshotWorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  verifyWorkspaceSearchMigrationRehearsalStageChildMaterial,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalStageChildMaterial,
} from './migration-rehearsal-stage-child-material'
import type {
  WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  parseWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialDocument,
  parseWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
} from './migration-rehearsal-stage-fault-material'
import type {
  WorkspaceSearchMigrationRehearsalSelectedStage,
  WorkspaceSearchMigrationRehearsalStageCommand,
  WorkspaceSearchMigrationRehearsalStageOutcome,
} from './migration-rehearsal-stage-receipt'

/** Maximum child stdout retained through an incremental SHA-256 digest. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES =
  256 * 1024

/** Maximum child stderr accepted while locating the single fault receipt. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDERR_BYTES =
  16 * 1024

/** Maximum wall-clock time allowed for one isolated rehearsal child run. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_RUNTIME_MILLISECONDS =
  6 * 60 * 60 * 1_000

/** Maximum wall-clock time allowed for each containment settlement step. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS =
  30_000

/** Fixed discriminator for the child process's only rehearsal stderr line. */
const faultReceiptLineKind =
  'mukuroji-workspace-search-migration-rehearsal-fault-receipt'

/** Canonical placeholder used only to validate an expected receipt snapshot. */
const expectedReceiptReachedAt = '2000-01-01T00:00:00.000Z'

/** Exact keys accepted for a receipt expectation known before runtime. */
const expectedReceiptKeys = Object.freeze([
  'action',
  'failpoint',
  'occurrence',
  'receiptVersion',
  'stage',
  'target',
])

/** Exact keys accepted for the child process's stderr envelope. */
const faultReceiptLineKeys = Object.freeze(['kind', 'receipt'])

/** Exact keys accepted for an ordinary child exit. */
const exitCodeKeys = Object.freeze(['exitCode', 'kind'])

/** Exact keys accepted for a signal-terminated child exit. */
const signalExitKeys = Object.freeze(['kind', 'signal'])

/** Stable raw-value-free process-runner failures. */
export type WorkspaceSearchMigrationRehearsalProcessRunnerErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CLOCK'
  | 'STDOUT_LIMIT_EXCEEDED'
  | 'STDERR_LIMIT_EXCEEDED'
  | 'PROCESS_OUTPUT_FAILED'
  | 'INVALID_FAULT_RECEIPT_LINE'
  | 'EXTRA_STDERR_OUTPUT'
  | 'MISSING_FAULT_RECEIPT'
  | 'DUPLICATE_FAULT_RECEIPT'
  | 'UNEXPECTED_FAULT_RECEIPT'
  | 'FAULT_RECEIPT_PERSIST_FAILED'
  | 'PREMATURE_PROCESS_EXIT'
  | 'PROCESS_KILL_FAILED'
  | 'PROCESS_ACKNOWLEDGEMENT_FAILED'
  | 'PROCESS_EXIT_FAILED'
  | 'PROCESS_RUNTIME_TIMEOUT'
  | 'PROCESS_CONTAINMENT_TIMEOUT'
  | 'UNCONFIRMED_SIGKILL_EXIT'
  | 'UNEXPECTED_RESPONSE_LOSS_EXIT'
  | 'INVALID_SUCCESS_MATERIAL_LINE'
  | 'MISSING_SUCCESS_MATERIAL'
  | 'DUPLICATE_SUCCESS_MATERIAL'
  | 'UNEXPECTED_SUCCESS_MATERIAL'
  | 'INVALID_SUCCESS_STDOUT'
  | 'SUCCESS_MATERIAL_PERSIST_FAILED'
  | 'UNEXPECTED_SUCCESS_EXIT'
  | 'INVALID_AUTHENTICATED_FAULT_MATERIAL_LINE'
  | 'MISSING_AUTHENTICATED_FAULT_MATERIAL'
  | 'DUPLICATE_AUTHENTICATED_FAULT_MATERIAL'
  | 'UNEXPECTED_AUTHENTICATED_FAULT_MATERIAL'
  | 'AUTHENTICATED_FAULT_RATE_READ_FAILED'
  | 'AUTHENTICATED_FAULT_MATERIAL_PERSIST_FAILED'
  | 'INVALID_AUTHENTICATED_FAULT_STDOUT'
  | 'UNEXPECTED_AUTHENTICATED_FAULT_EXIT'

/** Stable secret-free failure raised by the parent process runner. */
export class WorkspaceSearchMigrationRehearsalProcessRunnerError
  extends Error {
  /** Stable machine-readable failure without child output or identifiers. */
  readonly code: WorkspaceSearchMigrationRehearsalProcessRunnerErrorCode

  /**
   * Creates one raw-value-free process-runner failure.
   *
   * @param code - Stable failure classification.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalProcessRunnerErrorCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalProcessRunnerError'
    this.code = code
  }
}

/** Expected secret-free receipt fields known before the child is started. */
export type WorkspaceSearchMigrationRehearsalExpectedFaultReceipt = {
  /** Expected canonical receipt schema version. */
  readonly receiptVersion:
    WorkspaceSearchMigrationRehearsalFaultReceipt['receiptVersion']
  /** Expected fixed non-production stage. */
  readonly stage: WorkspaceSearchMigrationRehearsalFaultReceipt['stage']
  /** Exact selected failpoint. */
  readonly failpoint:
    WorkspaceSearchMigrationRehearsalFaultReceipt['failpoint']
  /** Exact external action selected for the failpoint. */
  readonly action: WorkspaceSearchMigrationRehearsalFaultReceipt['action']
  /** Exact semantic target selected before execution. */
  readonly target: WorkspaceSearchMigrationRehearsalFaultReceipt['target']
  /** Expected one-shot occurrence. */
  readonly occurrence:
    WorkspaceSearchMigrationRehearsalFaultReceipt['occurrence']
}

/** One ordinary child-process exit observed without a signal. */
export type WorkspaceSearchMigrationRehearsalExitCodeResult = {
  /** Selects ordinary exit-code termination. */
  readonly kind: 'exit-code'
  /** Exact conventional child exit status. */
  readonly exitCode: number
}

/** One child-process exit confirmed by its terminating signal. */
export type WorkspaceSearchMigrationRehearsalSignalExitResult = {
  /** Selects signal-confirmed termination. */
  readonly kind: 'signal'
  /** Exact platform signal name reported by the process adapter. */
  readonly signal: string
}

/** Strict process termination result supplied by the injected adapter. */
export type WorkspaceSearchMigrationRehearsalProcessExitResult =
  | WorkspaceSearchMigrationRehearsalExitCodeResult
  | WorkspaceSearchMigrationRehearsalSignalExitResult

/** Injectable port for one already-started isolated rehearsal child. */
export interface WorkspaceSearchMigrationRehearsalProcessPort {
  /** Incremental child stdout bytes; the runner never retains their text. */
  readonly stdout: AsyncIterable<Uint8Array>
  /** Incremental child stderr bytes containing exactly one receipt line. */
  readonly stderr: AsyncIterable<Uint8Array>
  /** Strict final exit result, including a confirmed signal when applicable. */
  readonly exited: Promise<WorkspaceSearchMigrationRehearsalProcessExitResult>

  /**
   * Sends the non-catchable kill signal owned exclusively by the parent.
   *
   * @param signal - Exact required process-kill signal.
   * @returns Completion after the process adapter accepts the signal.
   */
  kill(signal: 'SIGKILL'): void | Promise<void>

  /**
   * Releases the response-loss child only after its receipt is durable.
   *
   * @param receiptSha256 - Digest binding the one-shot acknowledgement.
   * @param closeAfterAcknowledgement - Whether this is the final protocol ACK.
   * @returns Completion after the acknowledgement is accepted for delivery.
   */
  acknowledgeResponseLoss(
    receiptSha256: string,
    closeAfterAcknowledgement?: boolean,
  ): void | Promise<void>
}

/** Secret-free receipt input passed to the durable persistence boundary. */
export type WorkspaceSearchMigrationRehearsalDurableFaultReceiptInput = {
  /** Canonical frozen runtime receipt. */
  readonly receipt: WorkspaceSearchMigrationRehearsalFaultReceipt
  /** Canonical SHA-256 digest of the receipt. */
  readonly receiptSha256: string
  /** Parent-clock time at which the complete line was observed. */
  readonly observedAt: string
}

/** Durable receipt writer that resolves only after its persistence barrier. */
export type WorkspaceSearchMigrationRehearsalDurableFaultReceiptWriter = (
  input: WorkspaceSearchMigrationRehearsalDurableFaultReceiptInput,
  signal: AbortSignal,
) => Promise<void>

/** Trusted canonical UTC clock used to timestamp parent lifecycle events. */
export type WorkspaceSearchMigrationRehearsalProcessRunnerClock = () => string

/** Inputs for one fail-closed parent-side process run. */
export type RunWorkspaceSearchMigrationRehearsalProcessInput = {
  /** One already-started child whose hard-kill capability stays in the parent. */
  readonly process: WorkspaceSearchMigrationRehearsalProcessPort
  /** Exact receipt fields selected before child execution. */
  readonly expectedReceipt:
    WorkspaceSearchMigrationRehearsalExpectedFaultReceipt
  /** Writer that must complete durable persistence before the fault action. */
  readonly persistFaultReceiptDurably:
    WorkspaceSearchMigrationRehearsalDurableFaultReceiptWriter
  /** Optional trusted clock, primarily for deterministic tests. */
  readonly now?: WorkspaceSearchMigrationRehearsalProcessRunnerClock
  /** Optional shorter runtime timeout used by deterministic tests. */
  readonly runtimeTimeoutMilliseconds?: number
  /** Optional shorter containment timeout used by deterministic tests. */
  readonly containmentTimeoutMilliseconds?: number
}

/** Successful secret-free termination classification. */
export type WorkspaceSearchMigrationRehearsalProcessExitClass =
  | 'confirmed-sigkill'
  | 'successful-response-loss'

/** Secret-free lifecycle evidence returned after a fully verified child exit. */
export type WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence = {
  /** Lifecycle evidence schema version. */
  readonly lifecycleVersion: 1
  /** Canonical digest of the exact validated fault receipt. */
  readonly receiptSha256: string
  /** Digest of bounded raw child stdout, never the underlying text. */
  readonly stdoutSha256: string
  /** Digest of bounded raw child stderr, never the underlying text. */
  readonly stderrSha256: string
  /** Parent-clock time at which lifecycle observation began. */
  readonly runnerStartedAt: string
  /** Parent-clock time at which the complete receipt line was observed. */
  readonly receiptObservedAt: string
  /** Parent-clock time after the durable writer completed. */
  readonly receiptPersistedAt: string
  /**
   * Parent-clock time recording the post-persistence parent decision.
   *
   * For a barrier this immediately precedes `SIGKILL`. For response loss this
   * immediately precedes the digest-bound acknowledgement that releases the
   * child to inject the synthetic transport response loss.
   */
  readonly parentDecisionRecordedAt: string
  /** Parent-clock time at which the process adapter reported final exit. */
  readonly processExitedAt: string
  /** Verified successful child termination class. */
  readonly exitClass:
    WorkspaceSearchMigrationRehearsalProcessExitClass
}

/** Durable authenticated child material passed to the parent fsync boundary. */
export type WorkspaceSearchMigrationRehearsalDurableSuccessMaterialInput = {
  /** Exact selection-bound HMAC-authenticated child material. */
  readonly material: WorkspaceSearchMigrationRehearsalStageChildMaterial
  /** Digest of the exact canonical child material. */
  readonly materialDigest: string
  /** Parent-clock time at which the complete FD3 line was observed. */
  readonly observedAt: string
}

/** Durable writer for one authenticated generic-success child material. */
export type WorkspaceSearchMigrationRehearsalDurableSuccessMaterialWriter = (
  input: WorkspaceSearchMigrationRehearsalDurableSuccessMaterialInput,
  signal: AbortSignal,
) => Promise<void>

/** Input for one bounded authenticated generic-success process lifecycle. */
export type RunWorkspaceSearchMigrationRehearsalSuccessfulProcessInput = {
  /** One already-started child whose containment stays parent-owned. */
  readonly process: WorkspaceSearchMigrationRehearsalProcessPort
  /** Stage independently authenticated by the parent before spawn. */
  readonly expectedSelection:
    WorkspaceSearchMigrationRehearsalSelectedStage
  /** Shared 32-byte stage verification key. */
  readonly verificationKey: Uint8Array
  /** Writer that resolves only after mode-0600 persistence and fsync. */
  readonly persistSuccessMaterialDurably:
    WorkspaceSearchMigrationRehearsalDurableSuccessMaterialWriter
  /** Optional trusted clock, primarily for deterministic tests. */
  readonly now?: WorkspaceSearchMigrationRehearsalProcessRunnerClock
  /** Optional shorter test-only runtime timeout. */
  readonly runtimeTimeoutMilliseconds?: number
  /** Optional shorter test-only containment timeout. */
  readonly containmentTimeoutMilliseconds?: number
}

/** Successful identifier-free lifecycle for one authenticated normal child. */
export type WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence = {
  /** First generic-success parent lifecycle contract. */
  readonly lifecycleVersion: 1
  /** Digest of the authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the exact selected manifest entry. */
  readonly manifestEntryDigest: string
  /** Digest of the exact predecessor receipt, or null at global stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Global selected stage ordinal. */
  readonly stageOrdinal: number
  /** Canonical scenario owning the selected stage. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Exact existing mutating control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** One-based process-attempt ordinal within the scenario. */
  readonly attemptOrdinal: number
  /** Exact manifest-selected finite outcome. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Digest of the exact authenticated child material. */
  readonly materialDigest: string
  /** Digest of bounded raw child stdout without retaining its body. */
  readonly stdoutSha256: string
  /** Parent-clock beginning of lifecycle supervision. */
  readonly runnerStartedAt: string
  /** Parent-clock observation of the complete authenticated FD3 line. */
  readonly materialObservedAt: string
  /** Parent-clock completion of exclusive persistence and fsync. */
  readonly materialPersistedAt: string
  /** Parent-clock observation of the final ordinary zero exit. */
  readonly processExitedAt: string
  /** Fixed successful ordinary no-fault termination class. */
  readonly exitClass: 'successful-no-fault'
}

/** Finite authenticated fault-material persistence phases. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedFaultMaterialPhase =
  | 'boundary'
  | 'completion'

/** Durable parent input for one authenticated stopped-fault boundary. */
export type WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialInput = {
  /** Exact selection-bound HMAC-authenticated boundary material. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Digest of the exact canonical boundary material. */
  readonly materialDigest: string
  /** Parent time when the complete first FD3 line was observed. */
  readonly observedAt: string
}

/** Durable parent input for response-loss completion material. */
export type WorkspaceSearchMigrationRehearsalDurableFaultCompletionMaterialInput = {
  /** Exact selection- and boundary-bound completion material. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial
  /** Digest of the exact canonical completion material. */
  readonly materialDigest: string
  /** Parent time when the complete second FD3 line was observed. */
  readonly observedAt: string
}

/** Durable writer for one authenticated stopped-fault boundary. */
export type WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialWriter = (
  input: WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialInput,
  signal: AbortSignal,
) => Promise<void>

/** Durable writer for one authenticated response-loss completion. */
export type WorkspaceSearchMigrationRehearsalDurableFaultCompletionMaterialWriter = (
  input: WorkspaceSearchMigrationRehearsalDurableFaultCompletionMaterialInput,
  signal: AbortSignal,
) => Promise<void>

/** Reader for one stable durable rate prefix while the child awaits an ACK. */
export type WorkspaceSearchMigrationRehearsalFaultRateSegmentReader = (
  phase: WorkspaceSearchMigrationRehearsalAuthenticatedFaultMaterialPhase,
  signal: AbortSignal,
) => Promise<Uint8Array>

/** Input for one authenticated one- or two-phase fault child lifecycle. */
export type RunWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessInput = {
  /** One already-started fixed child kept under parent containment. */
  readonly process: WorkspaceSearchMigrationRehearsalProcessPort
  /** Stage independently authenticated by the parent before spawn. */
  readonly expectedSelection:
    WorkspaceSearchMigrationRehearsalSelectedStage
  /** Reviewed exact fault plan independently read by the parent. */
  readonly expectedFaultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Shared 32-byte stage evidence verification key. */
  readonly verificationKey: Uint8Array
  /** Reads the stable rate prefix while the child is blocked at each phase. */
  readonly readRateSegmentBytes:
    WorkspaceSearchMigrationRehearsalFaultRateSegmentReader
  /** Persists and fsyncs boundary material before ACK or SIGKILL. */
  readonly persistBoundaryMaterialDurably:
    WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialWriter
  /** Persists and fsyncs response-loss completion before the final ACK. */
  readonly persistCompletionMaterialDurably:
    WorkspaceSearchMigrationRehearsalDurableFaultCompletionMaterialWriter
  /** Optional trusted clock, primarily for deterministic tests. */
  readonly now?: WorkspaceSearchMigrationRehearsalProcessRunnerClock
  /** Optional shorter test-only runtime timeout. */
  readonly runtimeTimeoutMilliseconds?: number
  /** Optional shorter test-only containment timeout. */
  readonly containmentTimeoutMilliseconds?: number
}

/** Successful authenticated fault lifecycle consumed by stage finalization. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence = {
  /** First authenticated fault parent lifecycle contract. */
  readonly lifecycleVersion: 1
  /** Digest of the authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the exact selected manifest entry. */
  readonly manifestEntryDigest: string
  /** Digest of the exact predecessor receipt, or null at global stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Global selected stage ordinal. */
  readonly stageOrdinal: number
  /** Canonical scenario owning the selected stage. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Exact existing mutating control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** One-based process-attempt ordinal within the scenario. */
  readonly attemptOrdinal: number
  /** Exact manifest-selected fault outcome. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Digest of the exact reviewed fault plan. */
  readonly faultPlanDigest: string
  /** Digest of the exact validated secret-free fault receipt. */
  readonly faultReceiptDigest: string
  /** Digest of the exact authenticated boundary material. */
  readonly boundaryMaterialDigest: string
  /** Completion material digest for response loss, otherwise null. */
  readonly completionMaterialDigest: string | null
  /** Digest of bounded raw child stdout without retaining its body. */
  readonly stdoutSha256: string
  /** Digest of exact bounded one- or two-line FD3 bytes. */
  readonly materialStreamSha256: string
  /** Parent-clock beginning of lifecycle supervision. */
  readonly runnerStartedAt: string
  /** Parent-clock observation of the complete boundary line. */
  readonly boundaryMaterialObservedAt: string
  /** Parent-clock completion of boundary persistence and fsync. */
  readonly boundaryMaterialPersistedAt: string
  /** Parent decision immediately before first ACK or SIGKILL. */
  readonly boundaryDecisionRecordedAt: string
  /** Completion observation time for response loss, otherwise null. */
  readonly completionMaterialObservedAt: string | null
  /** Completion persistence time for response loss, otherwise null. */
  readonly completionMaterialPersistedAt: string | null
  /** Parent decision immediately before the final ACK, otherwise null. */
  readonly completionDecisionRecordedAt: string | null
  /** Parent-clock observation of the final contained child exit. */
  readonly processExitedAt: string
  /** Exact verified external termination class. */
  readonly exitClass:
    | 'confirmed-sigkill'
    | 'successful-response-loss'
}

/** Incremental output digest and byte count retained without raw text. */
type ProcessOutputDigest = {
  /** Exact number of bytes accepted within the fixed bound. */
  readonly byteLength: number
  /** SHA-256 digest of the exact accepted bytes. */
  readonly sha256: string
}

/** Process exit paired with its parent-clock observation time. */
type ProcessExitObservation = {
  /** Strict detached process exit result. */
  readonly exit: WorkspaceSearchMigrationRehearsalProcessExitResult
  /** Canonical parent time at which exit was observed. */
  readonly observedAt: string
}

/** Mutable state private to one process-runner invocation. */
type ProcessRunnerState = {
  /** Trusted clock captured before asynchronous work begins. */
  readonly now: WorkspaceSearchMigrationRehearsalProcessRunnerClock
  /** Latest timestamp emitted by the trusted clock. */
  lastTimestamp: string | undefined
  /** Validated receipt after the first and only stderr line. */
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt | undefined
  /** Canonical digest of the validated receipt. */
  receiptSha256: string | undefined
  /** Parent time at which the complete receipt was observed. */
  receiptObservedAt: string | undefined
  /** Parent time after the durable persistence callback resolved. */
  receiptPersistedAt: string | undefined
  /** Parent time recording its post-persistence kill or no-kill decision. */
  parentDecisionRecordedAt: string | undefined
  /** Whether the process adapter accepted a hard-kill request. */
  killAccepted: boolean
  /** Whether the process adapter has reported final exit. */
  exitObserved: boolean
  /** Whether a concurrent lifecycle failure permanently stopped normal action. */
  protocolStopped: boolean
  /** Settlement barrier for a receipt persistence attempt already in flight. */
  receiptPersistenceSettled: Promise<void> | undefined
  /** Cancellation owned by the parent for an in-flight durable writer. */
  receiptPersistenceAbortController: AbortController | undefined
}

/** Signal name accepted at the parent-owned hard-kill boundary. */
const requiredKillSignal = 'SIGKILL'

/**
 * Runs one isolated rehearsal child and verifies its selected fault lifecycle.
 *
 * The runner incrementally bounds and digests both output streams. Stderr must
 * contain exactly one compact JSON fault-receipt envelope. A barrier receipt is
 * durably persisted before this parent sends `SIGKILL`, and success requires a
 * signal-confirmed exit. A response-loss receipt is durably persisted without a
 * kill. The response-loss child is released through a digest-bound parent
 * acknowledgement only after durable persistence and succeeds only after an
 * ordinary zero exit.
 *
 * @param input - Process port, exact expected receipt, and durable writer.
 * @returns Frozen secret-free lifecycle evidence after verified termination.
 * @throws {WorkspaceSearchMigrationRehearsalProcessRunnerError} On any invalid
 * output, ordering violation, persistence failure, or unexpected exit.
 */
export async function runWorkspaceSearchMigrationRehearsalProcess(
  input: RunWorkspaceSearchMigrationRehearsalProcessInput,
): Promise<WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence> {
  const expectedReceipt = snapshotExpectedReceipt(input.expectedReceipt)
  if (typeof input.persistFaultReceiptDurably !== 'function') {
    return failProcessRunner('INVALID_INPUT')
  }
  const now = input.now ?? defaultProcessRunnerClock
  if (typeof now !== 'function') return failProcessRunner('INVALID_INPUT')
  const runtimeTimeoutMilliseconds = requireProcessRunnerTimeout(
    input.runtimeTimeoutMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_RUNTIME_MILLISECONDS,
  )
  const containmentTimeoutMilliseconds = requireProcessRunnerTimeout(
    input.containmentTimeoutMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
  )
  requireProcessPort(input.process)

  const state: ProcessRunnerState = {
    now,
    lastTimestamp: undefined,
    receipt: undefined,
    receiptSha256: undefined,
    receiptObservedAt: undefined,
    receiptPersistedAt: undefined,
    parentDecisionRecordedAt: undefined,
    killAccepted: false,
    exitObserved: false,
    protocolStopped: false,
    receiptPersistenceSettled: undefined,
    receiptPersistenceAbortController: undefined,
  }
  const runnerStartedAt = readLifecycleTimestamp(state)

  const stdoutPromise = digestBoundedOutput(
    input.process.stdout,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES,
    'STDOUT_LIMIT_EXCEEDED',
  )
  const stderrPromise = readFaultReceiptOutput(
    input.process.stderr,
    state,
    expectedReceipt,
    input.persistFaultReceiptDurably,
    input.process,
  )
  const exitPromise = observeProcessExit(input.process.exited, state)

  let stdoutDigest: ProcessOutputDigest
  let stderrDigest: ProcessOutputDigest
  let exitObservation: ProcessExitObservation
  try {
    [stdoutDigest, stderrDigest, exitObservation] =
      await runWithProcessRunnerTimeout(
        Promise.all([
          stdoutPromise,
          stderrPromise,
          exitPromise,
        ]),
        runtimeTimeoutMilliseconds,
        'PROCESS_RUNTIME_TIMEOUT',
      )
  } catch (error: unknown) {
    const failure = classifyProcessRunnerFailure(error)
    state.protocolStopped = true
    abortReceiptPersistence(state)
    let containmentFailure:
      WorkspaceSearchMigrationRehearsalProcessRunnerError | undefined
    containmentFailure = await captureProcessRunnerContainmentFailure(
      waitForReceiptPersistenceSettlement(state),
      containmentTimeoutMilliseconds,
      containmentFailure,
    )
    containmentFailure = await captureProcessRunnerContainmentFailure(
      hardKillAfterProtocolFailure(input.process, state),
      containmentTimeoutMilliseconds,
      containmentFailure,
    )
    containmentFailure = await captureProcessRunnerContainmentFailure(
      confirmProtocolFailureContainment(exitPromise, state),
      containmentTimeoutMilliseconds,
      containmentFailure,
    )
    if (containmentFailure !== undefined) throw containmentFailure
    throw failure
  }

  if (state.receipt === undefined) {
    return failProcessRunner('MISSING_FAULT_RECEIPT')
  }
  const receiptSha256 = requireLifecycleValue(state.receiptSha256)
  const receiptObservedAt = requireLifecycleValue(
    state.receiptObservedAt,
  )
  const receiptPersistedAt = requireLifecycleValue(
    state.receiptPersistedAt,
  )
  const parentDecisionRecordedAt = requireLifecycleValue(
    state.parentDecisionRecordedAt,
  )
  const exitClass = classifySuccessfulExit(
    state.receipt.action,
    state.killAccepted,
    exitObservation.exit,
  )
  const evidence: WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence = {
    lifecycleVersion: 1,
    receiptSha256,
    stdoutSha256: stdoutDigest.sha256,
    stderrSha256: stderrDigest.sha256,
    runnerStartedAt,
    receiptObservedAt,
    receiptPersistedAt,
    parentDecisionRecordedAt,
    processExitedAt: exitObservation.observedAt,
    exitClass,
  }
  return Object.freeze(evidence)
}

/** Incremental bounded one- or two-line authenticated fault-material stream. */
type AuthenticatedFaultMaterialStream = {
  /** Reads the next complete LF-delimited line body without waiting for EOF. */
  readonly readLine: () => Promise<Uint8Array>
  /** Requires no bytes already buffered beyond the most recent line. */
  readonly requireNoBufferedBytes: () => void
  /** Requires exact EOF with no additional complete or partial line. */
  readonly complete: () => Promise<ProcessOutputDigest>
}

/** Parent observation of one durable authenticated boundary. */
type AuthenticatedFaultBoundaryObservation = {
  /** Exact authenticated boundary material. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Digest of the exact canonical boundary material. */
  readonly materialDigest: string
  /** Stable rate-prefix bytes independently authenticated by the parent. */
  readonly rateSegmentBytes: Uint8Array
  /** Parent-clock observation of the complete boundary line. */
  readonly observedAt: string
  /** Parent-clock completion of boundary persistence. */
  readonly persistedAt: string
}

/** Parent observation of durable response-loss completion material. */
type AuthenticatedFaultCompletionObservation = {
  /** Exact authenticated completion material. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial
  /** Digest of the exact canonical completion material. */
  readonly materialDigest: string
  /** Parent-clock observation of the complete completion line. */
  readonly observedAt: string
  /** Parent-clock completion of completion persistence. */
  readonly persistedAt: string
}

/** Strict exit plus trusted parent observation time. */
type AuthenticatedFaultExitObservation = {
  /** Strict detached child termination result. */
  readonly exit: WorkspaceSearchMigrationRehearsalProcessExitResult
  /** Parent time when the process adapter reported the exit. */
  readonly observedAt: string
}

/**
 * Runs one selection-bound authenticated fault protocol to contained exit.
 *
 * A barrier child emits one authenticated material line, remains stopped, and
 * is killed only after the parent independently authenticates the durable rate
 * prefix and fsyncs the material. A response-loss child emits boundary
 * material, receives a non-final digest ACK, reconciles, then emits a second
 * stdout-bound completion material line. The parent fsyncs the completion and
 * sends a final digest ACK that closes stdin before requiring zero exit.
 *
 * @param input - Fixed child, independent trust inputs, and durable writers.
 * @returns Frozen identifier-free lifecycle after the exact selected exit.
 */
export async function runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess(
  input: RunWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessInput,
): Promise<WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence> {
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeUtilTypes.isProxy(input) ||
    typeof input.readRateSegmentBytes !== 'function' ||
    nodeUtilTypes.isProxy(input.readRateSegmentBytes) ||
    typeof input.persistBoundaryMaterialDurably !== 'function' ||
    nodeUtilTypes.isProxy(input.persistBoundaryMaterialDurably) ||
    typeof input.persistCompletionMaterialDurably !== 'function' ||
    nodeUtilTypes.isProxy(input.persistCompletionMaterialDurably)
  ) return failProcessRunner('INVALID_INPUT')
  requireProcessPort(input.process)
  const verificationKey = copySuccessfulProcessKey(input.verificationKey)
  let faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  try {
    faultPlan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
      input.expectedFaultPlan,
    )
  } catch {
    verificationKey.fill(0)
    return failProcessRunner('INVALID_INPUT')
  }
  const now = input.now ?? defaultProcessRunnerClock
  if (typeof now !== 'function' || nodeUtilTypes.isProxy(now)) {
    verificationKey.fill(0)
    return failProcessRunner('INVALID_INPUT')
  }
  const runtimeTimeoutMilliseconds = requireProcessRunnerTimeout(
    input.runtimeTimeoutMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_RUNTIME_MILLISECONDS,
  )
  const containmentTimeoutMilliseconds = requireProcessRunnerTimeout(
    input.containmentTimeoutMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
  )
  const state: SuccessfulProcessRunnerState = {
    now,
    lastTimestamp: undefined,
    materialObserved: false,
    releaseAuthorized: false,
    exitObserved: false,
    protocolAborted: false,
    persistenceSettled: undefined,
    persistenceAbortController: undefined,
  }
  try {
    const runnerStartedAt = readSuccessfulLifecycleTimestamp(state)
    const materialStream = beginAuthenticatedFaultMaterialStream(
      input.process.stderr,
    )
    const exitPromise = observeAuthenticatedFaultProcessExit(
      input.process,
      state,
    )
    const responseLoss =
      faultPlan.failpoint === 'planning-page-transaction-response-lost'
    const stdoutPromise = responseLoss
      ? beginSuccessfulStdoutOutput(input.process.stdout)
      : undefined
    const barrierStdoutPromise = responseLoss
      ? undefined
      : digestBoundedOutput(
          input.process.stdout,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES,
          'STDOUT_LIMIT_EXCEEDED',
        )
    try {
      return await runWithProcessRunnerTimeout(
        completeAuthenticatedFaultProcessProtocol(
          input,
          faultPlan,
          verificationKey,
          materialStream,
          exitPromise,
          stdoutPromise,
          barrierStdoutPromise,
          state,
          runnerStartedAt,
        ),
        runtimeTimeoutMilliseconds,
        'PROCESS_RUNTIME_TIMEOUT',
      )
    } catch (error: unknown) {
      abortSuccessfulMaterialPersistence(state)
      await containSuccessfulProcess(
        input.process,
        exitPromise,
        state,
        containmentTimeoutMilliseconds,
      )
      throw classifyProcessRunnerFailure(error)
    }
  } finally {
    verificationKey.fill(0)
  }
}

/** Completes the exact one- or two-phase authenticated fault protocol. */
async function completeAuthenticatedFaultProcessProtocol(
  input: RunWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessInput,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan,
  verificationKey: Uint8Array,
  materialStream: AuthenticatedFaultMaterialStream,
  exitPromise: Promise<AuthenticatedFaultExitObservation>,
  stdoutPromise: Promise<SuccessfulStdoutMonitor> | undefined,
  barrierStdoutPromise: Promise<ProcessOutputDigest> | undefined,
  state: SuccessfulProcessRunnerState,
  runnerStartedAt: string,
): Promise<WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence> {
  const boundaryLine = await materialStream.readLine()
  materialStream.requireNoBufferedBytes()
  const boundary = await acceptAuthenticatedFaultBoundary(
    boundaryLine,
    input,
    faultPlan,
    verificationKey,
    state,
  )
  state.materialObserved = true
  const boundaryDecisionRecordedAt =
    readSuccessfulLifecycleTimestamp(state)
  if (boundary.material.faultReceipt.action === 'barrier') {
    if (stdoutPromise !== undefined || barrierStdoutPromise === undefined) {
      return failProcessRunner('UNEXPECTED_AUTHENTICATED_FAULT_MATERIAL')
    }
    state.releaseAuthorized = true
    try {
      await input.process.kill(requiredKillSignal)
    } catch {
      state.releaseAuthorized = false
      return failProcessRunner('PROCESS_KILL_FAILED')
    }
    const [exit, stdout, materialDigest] = await Promise.all([
      exitPromise,
      barrierStdoutPromise,
      materialStream.complete(),
    ])
    if (
      exit.exit.kind !== 'signal' ||
      exit.exit.signal !== requiredKillSignal
    ) return failProcessRunner('UNEXPECTED_AUTHENTICATED_FAULT_EXIT')
    return createAuthenticatedFaultLifecycle({
      boundary,
      completion: undefined,
      stdoutSha256: stdout.sha256,
      materialStreamSha256: materialDigest.sha256,
      runnerStartedAt,
      boundaryDecisionRecordedAt,
      completionDecisionRecordedAt: undefined,
      processExitedAt: exit.observedAt,
      exitClass: 'confirmed-sigkill',
    })
  }
  if (stdoutPromise === undefined || barrierStdoutPromise !== undefined) {
    return failProcessRunner('UNEXPECTED_AUTHENTICATED_FAULT_MATERIAL')
  }
  try {
    await input.process.acknowledgeResponseLoss(
      boundary.materialDigest,
      false,
    )
  } catch {
    return failProcessRunner('PROCESS_ACKNOWLEDGEMENT_FAILED')
  }
  const [stdoutMonitor, completionLine] = await Promise.all([
    stdoutPromise,
    materialStream.readLine(),
  ])
  materialStream.requireNoBufferedBytes()
  const completion = await acceptAuthenticatedFaultCompletion(
    completionLine,
    boundary,
    input,
    faultPlan,
    verificationKey,
    stdoutMonitor.serializedOutputLineDigest,
    state,
  )
  const completionDecisionRecordedAt =
    readSuccessfulLifecycleTimestamp(state)
  state.releaseAuthorized = true
  try {
    await input.process.acknowledgeResponseLoss(
      completion.materialDigest,
      true,
    )
  } catch {
    state.releaseAuthorized = false
    return failProcessRunner('PROCESS_ACKNOWLEDGEMENT_FAILED')
  }
  const [stdout, materialDigest, exit] = await Promise.all([
    stdoutMonitor.completion,
    materialStream.complete(),
    exitPromise,
  ])
  if (exit.exit.kind !== 'exit-code' || exit.exit.exitCode !== 0) {
    return failProcessRunner('UNEXPECTED_AUTHENTICATED_FAULT_EXIT')
  }
  return createAuthenticatedFaultLifecycle({
    boundary,
    completion,
    stdoutSha256: stdout.sha256,
    materialStreamSha256: materialDigest.sha256,
    runnerStartedAt,
    boundaryDecisionRecordedAt,
    completionDecisionRecordedAt,
    processExitedAt: exit.observedAt,
    exitClass: 'successful-response-loss',
  })
}

/** Accepts, independently authenticates, and persists the first material. */
async function acceptAuthenticatedFaultBoundary(
  line: Uint8Array,
  input: RunWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessInput,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan,
  verificationKey: Uint8Array,
  state: SuccessfulProcessRunnerState,
): Promise<AuthenticatedFaultBoundaryObservation> {
  if (state.exitObserved) return failProcessRunner('PREMATURE_PROCESS_EXIT')
  const observedAt = readSuccessfulLifecycleTimestamp(state)
  const controller = new AbortController()
  state.persistenceAbortController = controller
  let operation: Promise<AuthenticatedFaultBoundaryObservation>
  try {
    operation = (async () => {
      let rateSegmentBytes: Uint8Array
      try {
        rateSegmentBytes = await input.readRateSegmentBytes(
          'boundary',
          controller.signal,
        )
      } catch {
        return failProcessRunner('AUTHENTICATED_FAULT_RATE_READ_FAILED')
      }
      let material: WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
      try {
        material =
          parseWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialDocument(
            line,
            {
              selection: input.expectedSelection,
              faultPlan,
              rateSegmentBytes,
              verificationKey,
            },
          )
      } catch {
        return failProcessRunner('UNEXPECTED_AUTHENTICATED_FAULT_MATERIAL')
      }
      const materialDigest = createMigrationDigest(material)
      try {
        await input.persistBoundaryMaterialDurably(
          Object.freeze({ material, materialDigest, observedAt }),
          controller.signal,
        )
      } catch {
        return failProcessRunner(
          'AUTHENTICATED_FAULT_MATERIAL_PERSIST_FAILED',
        )
      }
      if (state.protocolAborted || state.exitObserved) {
        return failProcessRunner('PREMATURE_PROCESS_EXIT')
      }
      return Object.freeze({
        material,
        materialDigest,
        rateSegmentBytes: new Uint8Array(rateSegmentBytes),
        observedAt,
        persistedAt: readSuccessfulLifecycleTimestamp(state),
      })
    })()
  } catch {
    return failProcessRunner('AUTHENTICATED_FAULT_MATERIAL_PERSIST_FAILED')
  }
  state.persistenceSettled = operation.then(
    (): void => {},
    (): void => {},
  )
  try {
    return await operation
  } finally {
    state.persistenceAbortController = undefined
  }
}

/** Accepts and persists the response-loss completion before its final ACK. */
async function acceptAuthenticatedFaultCompletion(
  line: Uint8Array,
  boundary: AuthenticatedFaultBoundaryObservation,
  input: RunWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessInput,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan,
  verificationKey: Uint8Array,
  stdoutLineDigest: string,
  state: SuccessfulProcessRunnerState,
): Promise<AuthenticatedFaultCompletionObservation> {
  if (state.exitObserved) return failProcessRunner('PREMATURE_PROCESS_EXIT')
  const observedAt = readSuccessfulLifecycleTimestamp(state)
  const controller = new AbortController()
  state.persistenceAbortController = controller
  let operation: Promise<AuthenticatedFaultCompletionObservation>
  try {
    operation = (async () => {
      let finalRateSegmentBytes: Uint8Array
      try {
        finalRateSegmentBytes = await input.readRateSegmentBytes(
          'completion',
          controller.signal,
        )
      } catch {
        return failProcessRunner('AUTHENTICATED_FAULT_RATE_READ_FAILED')
      }
      let material:
        WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial
      try {
        material =
          parseWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterialDocument(
            line,
            {
              selection: input.expectedSelection,
              faultPlan,
              boundaryMaterial: boundary.material,
              boundaryRateSegmentBytes: boundary.rateSegmentBytes,
              finalRateSegmentBytes,
              verificationKey,
            },
          )
      } catch {
        return failProcessRunner('UNEXPECTED_AUTHENTICATED_FAULT_MATERIAL')
      }
      if (material.serializedOutputLineDigest !== stdoutLineDigest) {
        return failProcessRunner('INVALID_AUTHENTICATED_FAULT_STDOUT')
      }
      const materialDigest = createMigrationDigest(material)
      try {
        await input.persistCompletionMaterialDurably(
          Object.freeze({ material, materialDigest, observedAt }),
          controller.signal,
        )
      } catch {
        return failProcessRunner(
          'AUTHENTICATED_FAULT_MATERIAL_PERSIST_FAILED',
        )
      }
      if (state.protocolAborted || state.exitObserved) {
        return failProcessRunner('PREMATURE_PROCESS_EXIT')
      }
      return Object.freeze({
        material,
        materialDigest,
        observedAt,
        persistedAt: readSuccessfulLifecycleTimestamp(state),
      })
    })()
  } catch {
    return failProcessRunner('AUTHENTICATED_FAULT_MATERIAL_PERSIST_FAILED')
  }
  state.persistenceSettled = operation.then(
    (): void => {},
    (): void => {},
  )
  try {
    return await operation
  } finally {
    state.persistenceAbortController = undefined
  }
}

/** Creates the final strict identifier-free authenticated fault lifecycle. */
function createAuthenticatedFaultLifecycle(input: {
  /** Persisted first-phase material observation. */
  readonly boundary: AuthenticatedFaultBoundaryObservation
  /** Persisted completion observation, only for response loss. */
  readonly completion: AuthenticatedFaultCompletionObservation | undefined
  /** Digest of exact bounded stdout bytes. */
  readonly stdoutSha256: string
  /** Digest of exact one- or two-line FD3 bytes. */
  readonly materialStreamSha256: string
  /** Parent lifecycle start time. */
  readonly runnerStartedAt: string
  /** Parent decision before first ACK or kill. */
  readonly boundaryDecisionRecordedAt: string
  /** Parent decision before final ACK, only for response loss. */
  readonly completionDecisionRecordedAt: string | undefined
  /** Parent process exit observation time. */
  readonly processExitedAt: string
  /** Exact verified child termination class. */
  readonly exitClass: 'confirmed-sigkill' | 'successful-response-loss'
}): WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence {
  const material = input.boundary.material
  return Object.freeze({
    lifecycleVersion: 1,
    manifestDigest: material.manifestDigest,
    manifestEntryDigest: material.manifestEntryDigest,
    previousStageReceiptDigest: material.previousStageReceiptDigest,
    stageOrdinal: material.stageOrdinal,
    scenario: material.scenario,
    command: material.command,
    attemptOrdinal: material.attemptOrdinal,
    expectedOutcome: material.expectedOutcome,
    faultPlanDigest: material.faultPlanDigest,
    faultReceiptDigest: material.faultReceiptDigest,
    boundaryMaterialDigest: input.boundary.materialDigest,
    completionMaterialDigest:
      input.completion?.materialDigest ?? null,
    stdoutSha256: input.stdoutSha256,
    materialStreamSha256: input.materialStreamSha256,
    runnerStartedAt: input.runnerStartedAt,
    boundaryMaterialObservedAt: input.boundary.observedAt,
    boundaryMaterialPersistedAt: input.boundary.persistedAt,
    boundaryDecisionRecordedAt: input.boundaryDecisionRecordedAt,
    completionMaterialObservedAt:
      input.completion?.observedAt ?? null,
    completionMaterialPersistedAt:
      input.completion?.persistedAt ?? null,
    completionDecisionRecordedAt:
      input.completionDecisionRecordedAt ?? null,
    processExitedAt: input.processExitedAt,
    exitClass: input.exitClass,
  })
}

/** Creates one incremental exact authenticated material line reader. */
function beginAuthenticatedFaultMaterialStream(
  stream: AsyncIterable<Uint8Array>,
): AuthenticatedFaultMaterialStream {
  const iterator = stream[Symbol.asyncIterator]()
  const digest = createHash('sha256')
  let pending: Uint8Array = new Uint8Array(0)
  let byteLength = 0
  let ended = false
  let lineCount = 0
  /** Reads one complete line body, retaining no decoded text. */
  const readLine = async (): Promise<Uint8Array> => {
    if (ended) return failProcessRunner('MISSING_AUTHENTICATED_FAULT_MATERIAL')
    while (true) {
      const newlineIndex = pending.indexOf(0x0a)
      if (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex)
        pending = pending.slice(newlineIndex + 1)
        lineCount += 1
        if (
          line.byteLength === 0 ||
          line.includes(0x0d) ||
          lineCount > 2
        ) {
          return failProcessRunner(
            lineCount > 2
              ? 'DUPLICATE_AUTHENTICATED_FAULT_MATERIAL'
              : 'INVALID_AUTHENTICATED_FAULT_MATERIAL_LINE',
          )
        }
        return line
      }
      let next: IteratorResult<Uint8Array>
      try {
        next = await iterator.next()
      } catch {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      if (next.done === true) {
        ended = true
        if (pending.byteLength !== 0) {
          return failProcessRunner(
            'INVALID_AUTHENTICATED_FAULT_MATERIAL_LINE',
          )
        }
        return failProcessRunner('MISSING_AUTHENTICATED_FAULT_MATERIAL')
      }
      const chunk = next.value
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      byteLength = addBoundedBytes(
        byteLength,
        chunk.byteLength,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES *
          2 + 2,
        'STDERR_LIMIT_EXCEEDED',
      )
      digest.update(chunk)
      pending = appendProcessBytes(pending, chunk)
    }
  }
  /** Rejects material emitted ahead of the parent's current phase. */
  const requireNoBufferedBytes = (): void => {
    if (pending.byteLength !== 0) {
      return failProcessRunner('DUPLICATE_AUTHENTICATED_FAULT_MATERIAL')
    }
  }
  /** Reads exact EOF and rejects every extra complete or partial line. */
  const complete = async (): Promise<ProcessOutputDigest> => {
    if (pending.byteLength !== 0) {
      return failProcessRunner('DUPLICATE_AUTHENTICATED_FAULT_MATERIAL')
    }
    while (!ended) {
      let next: IteratorResult<Uint8Array>
      try {
        next = await iterator.next()
      } catch {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      if (next.done === true) {
        ended = true
        break
      }
      const chunk = next.value
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      byteLength = addBoundedBytes(
        byteLength,
        chunk.byteLength,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES *
          2 + 2,
        'STDERR_LIMIT_EXCEEDED',
      )
      digest.update(chunk)
      if (chunk.byteLength !== 0) {
        return failProcessRunner('DUPLICATE_AUTHENTICATED_FAULT_MATERIAL')
      }
    }
    return Object.freeze({ byteLength, sha256: digest.digest('hex') })
  }
  return Object.freeze({ readLine, requireNoBufferedBytes, complete })
}

/** Appends two bounded byte vectors without retaining caller-owned buffers. */
function appendProcessBytes(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength)
  combined.set(left, 0)
  combined.set(right, left.byteLength)
  return combined
}

/** Observes one strict child exit without classifying it before protocol end. */
async function observeAuthenticatedFaultProcessExit(
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
  state: SuccessfulProcessRunnerState,
): Promise<AuthenticatedFaultExitObservation> {
  let candidate: unknown
  try {
    candidate = await processPort.exited
  } catch {
    return failProcessRunner('PROCESS_EXIT_FAILED')
  }
  state.exitObserved = true
  const exit = snapshotProcessExit(candidate)
  if (!state.releaseAuthorized) {
    return failProcessRunner('PREMATURE_PROCESS_EXIT')
  }
  return Object.freeze({
    exit,
    observedAt: readSuccessfulLifecycleTimestamp(state),
  })
}

/** Mutable parent ordering state for one generic-success child process. */
type SuccessfulProcessRunnerState = {
  /** Trusted parent lifecycle clock. */
  readonly now: WorkspaceSearchMigrationRehearsalProcessRunnerClock
  /** Latest accepted non-regressing timestamp. */
  lastTimestamp: string | undefined
  /** Whether one authenticated material line has been accepted. */
  materialObserved: boolean
  /** Whether durable persistence and acknowledgement authorized child exit. */
  releaseAuthorized: boolean
  /** Whether the process adapter has already reported final exit. */
  exitObserved: boolean
  /** Whether timeout or protocol failure permanently forbids acknowledgement. */
  protocolAborted: boolean
  /** Settlement barrier for an in-flight durable material write. */
  persistenceSettled: Promise<void> | undefined
  /** Parent-owned cancellation for an in-flight durable material write. */
  persistenceAbortController: AbortController | undefined
}

/** One validated and durably persisted generic-success material observation. */
type SuccessfulMaterialObservation = {
  /** Exact authenticated child material. */
  readonly material: WorkspaceSearchMigrationRehearsalStageChildMaterial
  /** Digest of the exact canonical child material. */
  readonly materialDigest: string
  /** Parent time when the complete line was observed. */
  readonly observedAt: string
  /** Parent time after exclusive persistence and fsync. */
  readonly persistedAt: string
}

/** One ordinary zero exit observed after material acknowledgement. */
type SuccessfulExitObservation = {
  /** Parent time when the ordinary zero exit was observed. */
  readonly observedAt: string
}

/** Digest-only proof of exactly one canonical LF-terminated stdout line. */
type SuccessfulStdoutObservation = {
  /** Digest of the exact line body bound by child material. */
  readonly serializedOutputLineDigest: string
  /** Digest of the exact stdout bytes, including the sole LF delimiter. */
  readonly stdoutSha256: string
}

/** First-line stdout proof plus post-ACK exact-EOF verification. */
type SuccessfulStdoutMonitor = {
  /** Digest of the complete canonical line available before acknowledgement. */
  readonly serializedOutputLineDigest: string
  /** Resolves with whole-stream digest only after exact EOF. */
  readonly completion: Promise<ProcessOutputDigest>
}

/** Persisted FD3 material plus post-ACK exact-EOF verification. */
type SuccessfulMaterialMonitor = {
  /** Authenticated material persisted before acknowledgement. */
  readonly observation: SuccessfulMaterialObservation
  /** Resolves only when FD3 closes without any additional bytes. */
  readonly completion: Promise<void>
}

/**
 * Runs one authenticated generic-success child to an ordinary zero exit.
 *
 * The child may emit only one bounded canonical FD3 material line. The parent
 * verifies its HMAC against the independently selected manifest entry, fsyncs
 * it through the supplied writer, and only then releases the child through a
 * digest-bound acknowledgement. Stdout must be exactly one canonical JSON
 * line terminated by LF; only its digests survive validation.
 *
 * @param input - Child port, parent selection, shared key, and durable writer.
 * @returns Frozen identifier-free lifecycle after an acknowledged zero exit.
 */
export async function runWorkspaceSearchMigrationRehearsalSuccessfulProcess(
  input: RunWorkspaceSearchMigrationRehearsalSuccessfulProcessInput,
): Promise<WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence> {
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeUtilTypes.isProxy(input) ||
    typeof input.persistSuccessMaterialDurably !== 'function' ||
    nodeUtilTypes.isProxy(input.persistSuccessMaterialDurably)
  ) return failProcessRunner('INVALID_INPUT')
  requireProcessPort(input.process)
  const verificationKey = copySuccessfulProcessKey(input.verificationKey)
  const now = input.now ?? defaultProcessRunnerClock
  if (typeof now !== 'function' || nodeUtilTypes.isProxy(now)) {
    verificationKey.fill(0)
    return failProcessRunner('INVALID_INPUT')
  }
  const runtimeTimeoutMilliseconds = requireProcessRunnerTimeout(
    input.runtimeTimeoutMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_RUNTIME_MILLISECONDS,
  )
  const containmentTimeoutMilliseconds = requireProcessRunnerTimeout(
    input.containmentTimeoutMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
  )
  const state: SuccessfulProcessRunnerState = {
    now,
    lastTimestamp: undefined,
    materialObserved: false,
    releaseAuthorized: false,
    exitObserved: false,
    protocolAborted: false,
    persistenceSettled: undefined,
    persistenceAbortController: undefined,
  }
  try {
    const runnerStartedAt = readSuccessfulLifecycleTimestamp(state)
    const stdoutPromise = beginSuccessfulStdoutOutput(
      input.process.stdout,
    )
    const materialPromise = beginSuccessfulMaterialOutput(
      input.process.stderr,
      input,
      verificationKey,
      state,
    )
    const exitPromise = observeSuccessfulProcessExit(input.process, state)
    let stdout: SuccessfulStdoutObservation
    let material: SuccessfulMaterialObservation
    let exit: SuccessfulExitObservation
    try {
      const completed = await runWithProcessRunnerTimeout(
        completeSuccessfulProcessProtocol(
          input.process,
          stdoutPromise,
          materialPromise,
          exitPromise,
          state,
        ),
        runtimeTimeoutMilliseconds,
        'PROCESS_RUNTIME_TIMEOUT',
      )
      stdout = completed[0]
      material = completed[1]
      exit = completed[2]
    } catch (error: unknown) {
      abortSuccessfulMaterialPersistence(state)
      await containSuccessfulProcess(
        input.process,
        exitPromise,
        state,
        containmentTimeoutMilliseconds,
      )
      throw classifyProcessRunnerFailure(error)
    }
    if (exit.observedAt < material.persistedAt) {
      return failProcessRunner('UNEXPECTED_SUCCESS_EXIT')
    }
    return Object.freeze({
      lifecycleVersion: 1,
      manifestDigest: material.material.manifestDigest,
      manifestEntryDigest: material.material.manifestEntryDigest,
      previousStageReceiptDigest:
        material.material.previousStageReceiptDigest,
      stageOrdinal: material.material.stageOrdinal,
      scenario: material.material.scenario,
      command: material.material.command,
      attemptOrdinal: material.material.attemptOrdinal,
      expectedOutcome: material.material.expectedOutcome,
      materialDigest: material.materialDigest,
      stdoutSha256: stdout.stdoutSha256,
      runnerStartedAt,
      materialObservedAt: material.observedAt,
      materialPersistedAt: material.persistedAt,
      processExitedAt: exit.observedAt,
      exitClass: 'successful-no-fault',
    })
  } finally {
    verificationKey.fill(0)
  }
}

/** Completes stdout binding, durable material, acknowledgement, and exit. */
async function completeSuccessfulProcessProtocol(
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
  stdoutPromise: Promise<SuccessfulStdoutMonitor>,
  materialPromise: Promise<SuccessfulMaterialMonitor>,
  exitPromise: Promise<SuccessfulExitObservation>,
  state: SuccessfulProcessRunnerState,
): Promise<readonly [
  SuccessfulStdoutObservation,
  SuccessfulMaterialObservation,
  SuccessfulExitObservation,
]> {
  const [stdoutMonitor, materialMonitor] = await Promise.all([
    stdoutPromise,
    materialPromise,
  ])
  const material = materialMonitor.observation
  if (
    state.protocolAborted ||
    state.exitObserved ||
    stdoutMonitor.serializedOutputLineDigest !==
      material.material.serializedOutputLineDigest
  ) return failProcessRunner('INVALID_SUCCESS_STDOUT')
  state.releaseAuthorized = true
  try {
    await processPort.acknowledgeResponseLoss(material.materialDigest)
  } catch {
    state.releaseAuthorized = false
    return failProcessRunner('PROCESS_ACKNOWLEDGEMENT_FAILED')
  }
  const [stdoutDigest, , exit] = await Promise.all([
    stdoutMonitor.completion,
    materialMonitor.completion,
    exitPromise,
  ])
  const stdout = Object.freeze({
    serializedOutputLineDigest:
      stdoutMonitor.serializedOutputLineDigest,
    stdoutSha256: stdoutDigest.sha256,
  })
  const completed: readonly [
    SuccessfulStdoutObservation,
    SuccessfulMaterialObservation,
    SuccessfulExitObservation,
  ] = [stdout, material, exit]
  return Object.freeze(completed)
}

/** Reads one complete canonical stdout line without waiting for process EOF. */
async function beginSuccessfulStdoutOutput(
  stream: AsyncIterable<Uint8Array>,
): Promise<SuccessfulStdoutMonitor> {
  const digest = createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let byteLength = 0
  let pending = ''
  try {
    const iterator = stream[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done === true) {
        decoder.decode()
        return failProcessRunner('INVALID_SUCCESS_STDOUT')
      }
      const chunk = next.value
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      byteLength = addBoundedBytes(
        byteLength,
        chunk.byteLength,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES,
        'STDOUT_LIMIT_EXCEEDED',
      )
      digest.update(chunk)
      pending += decoder.decode(chunk, { stream: true })
      const newlineIndex = pending.indexOf('\n')
      if (newlineIndex < 0) continue
      const line = pending.slice(0, newlineIndex)
      pending = pending.slice(newlineIndex + 1)
      if (line.length === 0 || line.includes('\r') || pending.length !== 0) {
        return failProcessRunner('INVALID_SUCCESS_STDOUT')
      }
      const candidate: unknown = JSON.parse(line)
      if (serializeCanonicalJson(candidate) !== line) {
        return failProcessRunner('INVALID_SUCCESS_STDOUT')
      }
      const completion = completeSuccessfulStdoutOutput(
        iterator,
        decoder,
        digest,
        byteLength,
      )
      void completion.catch((): void => {})
      return Object.freeze({
        serializedOutputLineDigest: createMigrationDigest(line),
        completion,
      })
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessRunnerError) {
      throw error
    }
    return failProcessRunner('INVALID_SUCCESS_STDOUT')
  }
}

/** Requires stdout EOF after its sole LF without accepting another byte. */
async function completeSuccessfulStdoutOutput(
  iterator: AsyncIterator<Uint8Array>,
  decoder: TextDecoder,
  digest: ReturnType<typeof createHash>,
  initialByteLength: number,
): Promise<ProcessOutputDigest> {
  let byteLength = initialByteLength
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done === true) {
        if (decoder.decode().length !== 0) {
          return failProcessRunner('INVALID_SUCCESS_STDOUT')
        }
        return Object.freeze({
          byteLength,
          sha256: digest.digest('hex'),
        })
      }
      const chunk = next.value
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      byteLength = addBoundedBytes(
        byteLength,
        chunk.byteLength,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES,
        'STDOUT_LIMIT_EXCEEDED',
      )
      if (chunk.byteLength !== 0) {
        return failProcessRunner('INVALID_SUCCESS_STDOUT')
      }
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessRunnerError) {
      throw error
    }
    return failProcessRunner('INVALID_SUCCESS_STDOUT')
  }
}

/** Reads and accepts exactly one bounded canonical child-material line. */
async function beginSuccessfulMaterialOutput(
  stream: AsyncIterable<Uint8Array>,
  input: RunWorkspaceSearchMigrationRehearsalSuccessfulProcessInput,
  verificationKey: Uint8Array,
  state: SuccessfulProcessRunnerState,
): Promise<SuccessfulMaterialMonitor> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let byteLength = 0
  let pending = ''
  try {
    const iterator = stream[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done === true) {
        decoder.decode()
        return failProcessRunner('MISSING_SUCCESS_MATERIAL')
      }
      const chunk = next.value
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      byteLength = addBoundedBytes(
        byteLength,
        chunk.byteLength,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES,
        'STDERR_LIMIT_EXCEEDED',
      )
      pending += decoder.decode(chunk, { stream: true })
      const newlineIndex = pending.indexOf('\n')
      if (newlineIndex < 0) continue
      const line = pending.slice(0, newlineIndex)
      pending = pending.slice(newlineIndex + 1)
      if (pending.length !== 0) {
        return failProcessRunner('DUPLICATE_SUCCESS_MATERIAL')
      }
      const observation = await acceptSuccessfulMaterialLine(
        line,
        input,
        verificationKey,
        state,
      )
      const completion = completeSuccessfulMaterialOutput(
        iterator,
        decoder,
        byteLength,
      )
      void completion.catch((): void => {})
      return Object.freeze({ observation, completion })
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessRunnerError) {
      throw error
    }
    return failProcessRunner('PROCESS_OUTPUT_FAILED')
  }
}

/** Requires FD3 EOF after its sole LF without accepting another byte. */
async function completeSuccessfulMaterialOutput(
  iterator: AsyncIterator<Uint8Array>,
  decoder: TextDecoder,
  initialByteLength: number,
): Promise<void> {
  let byteLength = initialByteLength
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done === true) {
        if (decoder.decode().length !== 0) {
          return failProcessRunner('INVALID_SUCCESS_MATERIAL_LINE')
        }
        return
      }
      const chunk = next.value
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      byteLength = addBoundedBytes(
        byteLength,
        chunk.byteLength,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES,
        'STDERR_LIMIT_EXCEEDED',
      )
      if (chunk.byteLength !== 0) {
        return failProcessRunner('DUPLICATE_SUCCESS_MATERIAL')
      }
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessRunnerError) {
      throw error
    }
    return failProcessRunner('PROCESS_OUTPUT_FAILED')
  }
}

/** Validates and persists one exact child-material line before acknowledgement. */
async function acceptSuccessfulMaterialLine(
  line: string,
  input: RunWorkspaceSearchMigrationRehearsalSuccessfulProcessInput,
  verificationKey: Uint8Array,
  state: SuccessfulProcessRunnerState,
): Promise<SuccessfulMaterialObservation> {
  if (state.materialObserved) {
    return failProcessRunner('DUPLICATE_SUCCESS_MATERIAL')
  }
  if (line.length === 0 || line.includes('\r')) {
    return failProcessRunner('INVALID_SUCCESS_MATERIAL_LINE')
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(line)
  } catch {
    return failProcessRunner('INVALID_SUCCESS_MATERIAL_LINE')
  }
  if (serializeCanonicalJson(candidate) !== line) {
    return failProcessRunner('INVALID_SUCCESS_MATERIAL_LINE')
  }
  let material: WorkspaceSearchMigrationRehearsalStageChildMaterial
  try {
    material = verifyWorkspaceSearchMigrationRehearsalStageChildMaterial({
      material: candidate,
      selection: input.expectedSelection,
      verificationKey,
    })
  } catch {
    return failProcessRunner('UNEXPECTED_SUCCESS_MATERIAL')
  }
  if (state.exitObserved) return failProcessRunner('PREMATURE_PROCESS_EXIT')
  state.materialObserved = true
  const materialDigest = createMigrationDigest(material)
  const observedAt = readSuccessfulLifecycleTimestamp(state)
  const controller = new AbortController()
  state.persistenceAbortController = controller
  const durableInput:
    WorkspaceSearchMigrationRehearsalDurableSuccessMaterialInput =
      Object.freeze({ material, materialDigest, observedAt })
  let persistence: Promise<void>
  try {
    persistence = Promise.resolve(input.persistSuccessMaterialDurably(
      durableInput,
      controller.signal,
    ))
  } catch {
    return failProcessRunner('SUCCESS_MATERIAL_PERSIST_FAILED')
  }
  state.persistenceSettled = persistence.then(
    (): void => {},
    (): void => {},
  )
  try {
    await persistence
  } catch {
    return failProcessRunner('SUCCESS_MATERIAL_PERSIST_FAILED')
  }
  state.persistenceAbortController = undefined
  if (state.protocolAborted || state.exitObserved) {
    return failProcessRunner('PREMATURE_PROCESS_EXIT')
  }
  const persistedAt = readSuccessfulLifecycleTimestamp(state)
  return Object.freeze({ material, materialDigest, observedAt, persistedAt })
}

/** Observes only one acknowledgement-authorized ordinary zero exit. */
async function observeSuccessfulProcessExit(
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
  state: SuccessfulProcessRunnerState,
): Promise<SuccessfulExitObservation> {
  let candidate: unknown
  try {
    candidate = await processPort.exited
  } catch {
    return failProcessRunner('PROCESS_EXIT_FAILED')
  }
  state.exitObserved = true
  const exit = snapshotProcessExit(candidate)
  if (
    !state.releaseAuthorized ||
    exit.kind !== 'exit-code' ||
    exit.exitCode !== 0
  ) return failProcessRunner('UNEXPECTED_SUCCESS_EXIT')
  return Object.freeze({
    observedAt: readSuccessfulLifecycleTimestamp(state),
  })
}

/** Aborts one in-flight generic-success persistence operation. */
function abortSuccessfulMaterialPersistence(
  state: SuccessfulProcessRunnerState,
): void {
  state.protocolAborted = true
  state.releaseAuthorized = false
  const controller = state.persistenceAbortController
  if (controller !== undefined && !controller.signal.aborted) {
    controller.abort()
  }
}

/** Finitely settles persistence, kills, and reaps a failed success child. */
async function containSuccessfulProcess(
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
  exitPromise: Promise<SuccessfulExitObservation>,
  state: SuccessfulProcessRunnerState,
  timeoutMilliseconds: number,
): Promise<void> {
  const settlement = state.persistenceSettled
  if (settlement !== undefined) {
    await runWithProcessRunnerTimeout(
      settlement,
      timeoutMilliseconds,
      'PROCESS_CONTAINMENT_TIMEOUT',
    )
  }
  if (!state.exitObserved) {
    try {
      await runWithProcessRunnerTimeout(
        Promise.resolve(processPort.kill(requiredKillSignal)),
        timeoutMilliseconds,
        'PROCESS_CONTAINMENT_TIMEOUT',
      )
    } catch {
      return failProcessRunner('PROCESS_KILL_FAILED')
    }
  }
  try {
    await runWithProcessRunnerTimeout(
      exitPromise.then((): void => {}, (): void => {}),
      timeoutMilliseconds,
      'PROCESS_CONTAINMENT_TIMEOUT',
    )
  } catch {
    return failProcessRunner('PROCESS_CONTAINMENT_TIMEOUT')
  }
}

/** Reads one non-regressing timestamp for generic-success lifecycle state. */
function readSuccessfulLifecycleTimestamp(
  state: SuccessfulProcessRunnerState,
): string {
  let timestamp: unknown
  try {
    timestamp = state.now()
  } catch {
    return failProcessRunner('INVALID_CLOCK')
  }
  if (
    !isCanonicalTimestamp(timestamp) ||
    (state.lastTimestamp !== undefined && timestamp < state.lastTimestamp)
  ) return failProcessRunner('INVALID_CLOCK')
  state.lastTimestamp = timestamp
  return timestamp
}

/** Copies one exact 32-byte successful-process verification key. */
function copySuccessfulProcessKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    value.byteLength !== 32
  ) return failProcessRunner('INVALID_INPUT')
  return new Uint8Array(value)
}

/**
 * Reads one validated receipt line while incrementally bounding stderr.
 *
 * @param stream - Child stderr byte stream.
 * @param state - Invocation-local lifecycle state.
 * @param expected - Exact preselected receipt fields.
 * @param persist - Durable receipt writer.
 * @param processPort - Parent-owned process action port.
 * @returns Digest of the exact bounded stderr bytes.
 */
async function readFaultReceiptOutput(
  stream: AsyncIterable<Uint8Array>,
  state: ProcessRunnerState,
  expected: WorkspaceSearchMigrationRehearsalExpectedFaultReceipt,
  persist: WorkspaceSearchMigrationRehearsalDurableFaultReceiptWriter,
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
): Promise<ProcessOutputDigest> {
  const digest = createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let byteLength = 0
  let pending = ''
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      byteLength = addBoundedBytes(
        byteLength,
        chunk.byteLength,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDERR_BYTES,
        'STDERR_LIMIT_EXCEEDED',
      )
      digest.update(chunk)
      pending += decoder.decode(chunk, { stream: true })
      let newlineIndex = pending.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex)
        pending = pending.slice(newlineIndex + 1)
        await acceptFaultReceiptLine(
          line,
          state,
          expected,
          persist,
          processPort,
        )
        newlineIndex = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
  } catch (error: unknown) {
    if (
      error instanceof WorkspaceSearchMigrationRehearsalProcessRunnerError
    ) {
      throw error
    }
    return failProcessRunner('PROCESS_OUTPUT_FAILED')
  }
  if (pending.length !== 0) {
    return failProcessRunner('INVALID_FAULT_RECEIPT_LINE')
  }
  return Object.freeze({ byteLength, sha256: digest.digest('hex') })
}

/**
 * Validates, persists, and then authorizes one exact receipt-line action.
 *
 * @param line - One complete UTF-8 stderr line without its LF terminator.
 * @param state - Invocation-local lifecycle state.
 * @param expected - Exact preselected receipt fields.
 * @param persist - Durable receipt writer.
 * @param processPort - Parent-owned process action port.
 */
async function acceptFaultReceiptLine(
  line: string,
  state: ProcessRunnerState,
  expected: WorkspaceSearchMigrationRehearsalExpectedFaultReceipt,
  persist: WorkspaceSearchMigrationRehearsalDurableFaultReceiptWriter,
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
): Promise<void> {
  if (state.receipt !== undefined) {
    try {
      parseFaultReceiptLine(line)
    } catch {
      return failProcessRunner('EXTRA_STDERR_OUTPUT')
    }
    return failProcessRunner('DUPLICATE_FAULT_RECEIPT')
  }

  const receipt = parseFaultReceiptLine(line)
  if (!receiptMatchesExpected(receipt, expected)) {
    return failProcessRunner('UNEXPECTED_FAULT_RECEIPT')
  }
  const receiptSha256 = createMigrationDigest(receipt)
  const observedAt = readLifecycleTimestamp(state)
  state.receipt = receipt
  state.receiptSha256 = receiptSha256
  state.receiptObservedAt = observedAt

  const durableInput:
    WorkspaceSearchMigrationRehearsalDurableFaultReceiptInput =
      Object.freeze({
        receipt,
        receiptSha256,
        observedAt,
      })
  let persistence: Promise<void>
  const persistenceAbortController = new AbortController()
  state.receiptPersistenceAbortController = persistenceAbortController
  try {
    persistence = Promise.resolve(
      persist(durableInput, persistenceAbortController.signal),
    )
  } catch {
    return failProcessRunner('FAULT_RECEIPT_PERSIST_FAILED')
  }
  state.receiptPersistenceSettled = persistence.then(
    (): void => {},
    (): void => {},
  )
  try {
    await persistence
  } catch {
    return failProcessRunner('FAULT_RECEIPT_PERSIST_FAILED')
  }
  state.receiptPersistenceAbortController = undefined
  if (state.protocolStopped) {
    return failProcessRunner('PROCESS_RUNTIME_TIMEOUT')
  }
  state.receiptPersistedAt = readLifecycleTimestamp(state)
  if (receipt.action === 'barrier' && state.exitObserved) {
    return failProcessRunner('PREMATURE_PROCESS_EXIT')
  }
  state.parentDecisionRecordedAt = readLifecycleTimestamp(state)

  if (receipt.action === 'response-loss') {
    try {
      await processPort.acknowledgeResponseLoss(receiptSha256)
    } catch {
      return failProcessRunner('PROCESS_ACKNOWLEDGEMENT_FAILED')
    }
    return
  }
  try {
    await processPort.kill(requiredKillSignal)
    state.killAccepted = true
  } catch {
    return failProcessRunner('PROCESS_KILL_FAILED')
  }
}

/**
 * Incrementally digests one bounded output stream without decoding its text.
 *
 * @param stream - Untrusted process output chunks.
 * @param maximumBytes - Fixed maximum accepted total byte length.
 * @param limitError - Stable stream-specific limit failure.
 * @returns Exact byte count and SHA-256 digest.
 */
async function digestBoundedOutput(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  limitError:
    | 'STDOUT_LIMIT_EXCEEDED'
    | 'STDERR_LIMIT_EXCEEDED',
): Promise<ProcessOutputDigest> {
  const digest = createHash('sha256')
  let byteLength = 0
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) {
        return failProcessRunner('PROCESS_OUTPUT_FAILED')
      }
      byteLength = addBoundedBytes(
        byteLength,
        chunk.byteLength,
        maximumBytes,
        limitError,
      )
      digest.update(chunk)
    }
  } catch (error: unknown) {
    if (
      error instanceof WorkspaceSearchMigrationRehearsalProcessRunnerError
    ) {
      throw error
    }
    return failProcessRunner('PROCESS_OUTPUT_FAILED')
  }
  return Object.freeze({ byteLength, sha256: digest.digest('hex') })
}

/**
 * Adds one output chunk length without exceeding the fixed byte bound.
 *
 * @param current - Bytes already accepted.
 * @param additional - Bytes in the next chunk.
 * @param maximum - Maximum total bytes.
 * @param code - Stable stream-specific failure code.
 * @returns New safe total byte length.
 */
function addBoundedBytes(
  current: number,
  additional: number,
  maximum: number,
  code: 'STDOUT_LIMIT_EXCEEDED' | 'STDERR_LIMIT_EXCEEDED',
): number {
  if (additional > maximum - current) return failProcessRunner(code)
  return current + additional
}

/**
 * Observes and snapshots the process exit before exposing it to validation.
 *
 * @param exited - Injected final-exit promise.
 * @param state - Invocation-local lifecycle state.
 * @returns Strict exit result and its parent-clock timestamp.
 */
async function observeProcessExit(
  exited: Promise<WorkspaceSearchMigrationRehearsalProcessExitResult>,
  state: ProcessRunnerState,
): Promise<ProcessExitObservation> {
  let candidate: unknown
  try {
    candidate = await exited
  } catch {
    return failProcessRunner('PROCESS_EXIT_FAILED')
  }
  state.exitObserved = true
  const observedAt = readLifecycleTimestamp(state)
  const exit = snapshotProcessExit(candidate)
  return Object.freeze({ exit, observedAt })
}

/**
 * Parses one compact exact child stderr receipt envelope.
 *
 * @param line - Complete line without its LF terminator.
 * @returns Canonical frozen receipt detached by the fault parser.
 */
function parseFaultReceiptLine(
  line: string,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  if (line.length === 0 || line.includes('\r')) {
    return failProcessRunner('INVALID_FAULT_RECEIPT_LINE')
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(line)
  } catch {
    return failProcessRunner('INVALID_FAULT_RECEIPT_LINE')
  }
  if (serializeCanonicalJson(candidate) !== line) {
    return failProcessRunner('INVALID_FAULT_RECEIPT_LINE')
  }
  const record = requireExactDataRecord(
    candidate,
    faultReceiptLineKeys,
    'INVALID_FAULT_RECEIPT_LINE',
  )
  if (readOwnData(record, 'kind') !== faultReceiptLineKind) {
    return failProcessRunner('INVALID_FAULT_RECEIPT_LINE')
  }
  try {
    return parseWorkspaceSearchMigrationRehearsalFaultReceipt(
      readOwnData(record, 'receipt'),
    )
  } catch {
    return failProcessRunner('INVALID_FAULT_RECEIPT_LINE')
  }
}

/**
 * Validates and detaches exact expected receipt fields.
 *
 * @param candidate - Preselected expected receipt fields.
 * @returns Frozen expected receipt snapshot without a runtime timestamp.
 */
function snapshotExpectedReceipt(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalExpectedFaultReceipt {
  const record = requireExactDataRecord(
    candidate,
    expectedReceiptKeys,
    'INVALID_INPUT',
  )
  let receipt: WorkspaceSearchMigrationRehearsalFaultReceipt
  try {
    receipt = parseWorkspaceSearchMigrationRehearsalFaultReceipt({
      receiptVersion: readOwnData(record, 'receiptVersion'),
      stage: readOwnData(record, 'stage'),
      failpoint: readOwnData(record, 'failpoint'),
      action: readOwnData(record, 'action'),
      target: readOwnData(record, 'target'),
      occurrence: readOwnData(record, 'occurrence'),
      reachedAt: expectedReceiptReachedAt,
    })
  } catch {
    return failProcessRunner('INVALID_INPUT')
  }
  const snapshot: WorkspaceSearchMigrationRehearsalExpectedFaultReceipt = {
    receiptVersion: receipt.receiptVersion,
    stage: receipt.stage,
    failpoint: receipt.failpoint,
    action: receipt.action,
    target: receipt.target,
    occurrence: receipt.occurrence,
  }
  return Object.freeze(snapshot)
}

/**
 * Compares every preselectable receipt field, including the semantic target.
 *
 * @param receipt - Canonical runtime receipt.
 * @param expected - Detached preselected fields.
 * @returns Whether the runtime receipt is the exact selected occurrence.
 */
function receiptMatchesExpected(
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
  expected: WorkspaceSearchMigrationRehearsalExpectedFaultReceipt,
): boolean {
  return receipt.receiptVersion === expected.receiptVersion &&
    receipt.stage === expected.stage &&
    receipt.failpoint === expected.failpoint &&
    receipt.action === expected.action &&
    receipt.occurrence === expected.occurrence &&
    isDeepStrictEqual(receipt.target, expected.target)
}

/**
 * Snapshots one exact plain process-exit result.
 *
 * @param candidate - Exit value supplied by the process adapter.
 * @returns Frozen validated exit result.
 */
function snapshotProcessExit(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalProcessExitResult {
  const initial = requirePlainDataRecord(
    candidate,
    'PROCESS_EXIT_FAILED',
  )
  const kind = readOwnData(initial, 'kind')
  if (kind === 'exit-code') {
    const record = requireExactDataRecord(
      candidate,
      exitCodeKeys,
      'PROCESS_EXIT_FAILED',
    )
    const exitCode = readOwnData(record, 'exitCode')
    if (
      typeof exitCode !== 'number' ||
      !Number.isSafeInteger(exitCode) ||
      exitCode < 0 ||
      exitCode > 255
    ) {
      return failProcessRunner('PROCESS_EXIT_FAILED')
    }
    return Object.freeze({ kind, exitCode })
  }
  if (kind !== 'signal') return failProcessRunner('PROCESS_EXIT_FAILED')
  const record = requireExactDataRecord(
    candidate,
    signalExitKeys,
    'PROCESS_EXIT_FAILED',
  )
  const signal = readOwnData(record, 'signal')
  if (
    typeof signal !== 'string' ||
    !/^SIG[A-Z0-9]{1,20}$/u.test(signal)
  ) {
    return failProcessRunner('PROCESS_EXIT_FAILED')
  }
  return Object.freeze({ kind, signal })
}

/**
 * Requires the injected process port's minimum callable and iterable surface.
 *
 * @param candidate - Injected process adapter.
 */
function requireProcessPort(candidate: unknown): void {
  if (typeof candidate !== 'object' || candidate === null) {
    return failProcessRunner('INVALID_INPUT')
  }
  let stdout: unknown
  let stderr: unknown
  let exited: unknown
  let kill: unknown
  let acknowledgeResponseLoss: unknown
  try {
    stdout = Reflect.get(candidate, 'stdout')
    stderr = Reflect.get(candidate, 'stderr')
    exited = Reflect.get(candidate, 'exited')
    kill = Reflect.get(candidate, 'kill')
    acknowledgeResponseLoss = Reflect.get(
      candidate,
      'acknowledgeResponseLoss',
    )
  } catch {
    return failProcessRunner('INVALID_INPUT')
  }
  if (
    !isAsyncIterable(stdout) ||
    !isAsyncIterable(stderr) ||
    !isPromiseLike(exited) ||
    typeof kill !== 'function' ||
    typeof acknowledgeResponseLoss !== 'function'
  ) {
    return failProcessRunner('INVALID_INPUT')
  }
}

/**
 * Waits for an already-started durable receipt attempt before containment.
 *
 * A protocol failure may race another output consumer while the receipt
 * writer is still fsyncing. The parent must never send `SIGKILL` across that
 * window; success or failure of the writer is observed before containment.
 *
 * @param state - Invocation-local lifecycle state.
 */
async function waitForReceiptPersistenceSettlement(
  state: ProcessRunnerState,
): Promise<void> {
  const settlement = state.receiptPersistenceSettled
  if (settlement !== undefined) await settlement
}

/**
 * Cancels one in-flight durable receipt writer after the run stops admitting.
 *
 * The runner still waits for settlement before containment, preserving the
 * rule that the parent never injects `SIGKILL` across an active receipt write.
 *
 * @param state - Invocation-local lifecycle state.
 */
function abortReceiptPersistence(state: ProcessRunnerState): void {
  const controller = state.receiptPersistenceAbortController
  if (controller !== undefined && !controller.signal.aborted) {
    controller.abort()
  }
}

/**
 * Requires a finite positive timeout no greater than its production ceiling.
 *
 * @param candidate - Optional caller-supplied shorter timeout.
 * @param maximum - Fixed production maximum and default.
 * @returns Validated timeout in milliseconds.
 */
function requireProcessRunnerTimeout(
  candidate: number | undefined,
  maximum: number,
): number {
  const timeout = candidate ?? maximum
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > maximum
  ) {
    return failProcessRunner('INVALID_INPUT')
  }
  return timeout
}

/**
 * Awaits one lifecycle phase behind a finite wall-clock timeout.
 *
 * The timeout is cleared on every settlement path and never retains child
 * output or injected errors.
 *
 * @param operation - Already-started trusted lifecycle operation.
 * @param timeoutMilliseconds - Validated finite timeout.
 * @param code - Stable timeout classification.
 * @returns Exact operation result before the deadline.
 */
async function runWithProcessRunnerTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
  code:
    | 'PROCESS_RUNTIME_TIMEOUT'
    | 'PROCESS_CONTAINMENT_TIMEOUT',
): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout((): void => {
      reject(new WorkspaceSearchMigrationRehearsalProcessRunnerError(code))
    }, timeoutMilliseconds)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/**
 * Attempts one containment step while preserving the first containment error.
 *
 * Later kill and exit-confirmation steps still run after an earlier writer
 * settlement timeout, so a stuck durability callback cannot leave the child
 * uncontained.
 *
 * @param operation - Already-started containment operation.
 * @param timeoutMilliseconds - Validated finite containment deadline.
 * @param previousFailure - First previously observed containment failure.
 * @returns The first stable containment failure, or undefined on success.
 */
async function captureProcessRunnerContainmentFailure(
  operation: Promise<unknown>,
  timeoutMilliseconds: number,
  previousFailure:
    WorkspaceSearchMigrationRehearsalProcessRunnerError | undefined,
): Promise<
  WorkspaceSearchMigrationRehearsalProcessRunnerError | undefined
> {
  try {
    await runWithProcessRunnerTimeout(
      operation,
      timeoutMilliseconds,
      'PROCESS_CONTAINMENT_TIMEOUT',
    )
    return previousFailure
  } catch (error: unknown) {
    return previousFailure ?? classifyProcessRunnerFailure(error)
  }
}

/**
 * Checks whether a value exposes an asynchronous iterator.
 *
 * @param candidate - Potential output stream.
 * @returns Whether the value has an async iterator function.
 */
function isAsyncIterable(
  candidate: unknown,
): candidate is AsyncIterable<Uint8Array> {
  if (
    (typeof candidate !== 'object' && typeof candidate !== 'function') ||
    candidate === null
  ) {
    return false
  }
  try {
    return typeof Reflect.get(candidate, Symbol.asyncIterator) === 'function'
  } catch {
    return false
  }
}

/**
 * Checks whether a value can be awaited as the final exit result.
 *
 * @param candidate - Potential exit Promise.
 * @returns Whether the value exposes a callable `then` member.
 */
function isPromiseLike(
  candidate: unknown,
): candidate is PromiseLike<unknown> {
  if (
    (typeof candidate !== 'object' && typeof candidate !== 'function') ||
    candidate === null
  ) {
    return false
  }
  try {
    return typeof Reflect.get(candidate, 'then') === 'function'
  } catch {
    return false
  }
}

/**
 * Reads one canonical monotonically non-decreasing lifecycle timestamp.
 *
 * @param state - Invocation-local clock state.
 * @returns Validated canonical timestamp.
 */
function readLifecycleTimestamp(state: ProcessRunnerState): string {
  let timestamp: unknown
  try {
    timestamp = state.now()
  } catch {
    return failProcessRunner('INVALID_CLOCK')
  }
  if (
    !isCanonicalTimestamp(timestamp) ||
    (state.lastTimestamp !== undefined &&
      timestamp < state.lastTimestamp)
  ) {
    return failProcessRunner('INVALID_CLOCK')
  }
  state.lastTimestamp = timestamp
  return timestamp
}

/**
 * Sends a containment kill after a malformed or failed process protocol.
 *
 * @param processPort - Parent-owned process action port.
 * @param state - Invocation-local lifecycle state.
 */
async function hardKillAfterProtocolFailure(
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
  state: ProcessRunnerState,
): Promise<void> {
  if (state.killAccepted || state.exitObserved) return
  try {
    await processPort.kill(requiredKillSignal)
    state.killAccepted = true
  } catch {
    return failProcessRunner('PROCESS_KILL_FAILED')
  }
}

/**
 * Reaps a contained failed child and confirms the accepted hard-kill signal.
 *
 * @param exitPromise - Existing single observer for the child exit.
 * @param state - Invocation-local containment state.
 */
async function confirmProtocolFailureContainment(
  exitPromise: Promise<ProcessExitObservation>,
  state: ProcessRunnerState,
): Promise<void> {
  if (!state.killAccepted) return
  const observation = await exitPromise
  if (
    observation.exit.kind !== 'signal' ||
    observation.exit.signal !== requiredKillSignal
  ) {
    return failProcessRunner('UNCONFIRMED_SIGKILL_EXIT')
  }
}

/**
 * Classifies the exact successful exit required by the receipt action.
 *
 * @param action - Validated receipt action.
 * @param killAccepted - Whether the process adapter accepted the hard kill.
 * @param exit - Strict observed child exit.
 * @returns Verified secret-free exit class.
 */
function classifySuccessfulExit(
  action: WorkspaceSearchMigrationRehearsalFaultReceipt['action'],
  killAccepted: boolean,
  exit: WorkspaceSearchMigrationRehearsalProcessExitResult,
): WorkspaceSearchMigrationRehearsalProcessExitClass {
  if (action === 'barrier') {
    if (
      !killAccepted ||
      exit.kind !== 'signal' ||
      exit.signal !== requiredKillSignal
    ) {
      return failProcessRunner('UNCONFIRMED_SIGKILL_EXIT')
    }
    return 'confirmed-sigkill'
  }
  if (
    killAccepted ||
    exit.kind !== 'exit-code' ||
    exit.exitCode !== 0
  ) {
    return failProcessRunner('UNEXPECTED_RESPONSE_LOSS_EXIT')
  }
  return 'successful-response-loss'
}

/**
 * Requires an internal lifecycle value populated by the receipt path.
 *
 * @param value - Potentially absent internal value.
 * @returns Present value.
 */
function requireLifecycleValue(value: string | undefined): string {
  if (value === undefined) {
    return failProcessRunner('INVALID_FAULT_RECEIPT_LINE')
  }
  return value
}

/**
 * Requires one exact ordinary object with enumerable own data properties.
 *
 * @param candidate - Untrusted candidate value.
 * @param keys - Exact required string keys.
 * @param code - Stable failure classification.
 * @returns Validated ordinary object.
 */
function requireExactDataRecord(
  candidate: unknown,
  keys: readonly string[],
  code: WorkspaceSearchMigrationRehearsalProcessRunnerErrorCode,
): object {
  const record = requirePlainDataRecord(candidate, code)
  let ownKeys: readonly PropertyKey[]
  try {
    ownKeys = Reflect.ownKeys(record)
  } catch {
    return failProcessRunner(code)
  }
  if (ownKeys.length !== keys.length) return failProcessRunner(code)
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      return failProcessRunner(code)
    }
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failProcessRunner(code)
    }
  }
  return record
}

/**
 * Requires a non-Proxy ordinary object before inspecting own descriptors.
 *
 * @param candidate - Untrusted candidate value.
 * @param code - Stable failure classification.
 * @returns Validated plain object.
 */
function requirePlainDataRecord(
  candidate: unknown,
  code: WorkspaceSearchMigrationRehearsalProcessRunnerErrorCode,
): object {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    return failProcessRunner(code)
  }
  const prototype = Object.getPrototypeOf(candidate)
  if (prototype !== Object.prototype && prototype !== null) {
    return failProcessRunner(code)
  }
  return candidate
}

/**
 * Reads one already-validated own data property without invoking accessors.
 *
 * @param record - Validated exact data record.
 * @param key - Required own property name.
 * @returns Stored own property value.
 */
function readOwnData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failProcessRunner('INVALID_INPUT')
  }
  const value: unknown = descriptor.value
  return value
}

/**
 * Converts an unknown asynchronous failure to a stable runner error.
 *
 * @param error - Unknown failure crossing an injected boundary.
 * @returns Existing stable error or a raw-value-free fallback.
 */
function classifyProcessRunnerFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalProcessRunnerError {
  if (
    error instanceof WorkspaceSearchMigrationRehearsalProcessRunnerError
  ) {
    return error
  }
  return new WorkspaceSearchMigrationRehearsalProcessRunnerError(
    'PROCESS_OUTPUT_FAILED',
  )
}

/**
 * Reads the current canonical UTC time for production runner calls.
 *
 * @returns Current timestamp in canonical ISO-8601 form.
 */
function defaultProcessRunnerClock(): string {
  return new Date().toISOString()
}

/**
 * Raises one stable raw-value-free process-runner failure.
 *
 * @param code - Stable failure classification.
 * @returns Never returns.
 */
function failProcessRunner(
  code: WorkspaceSearchMigrationRehearsalProcessRunnerErrorCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalProcessRunnerError(code)
}
