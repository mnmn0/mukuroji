import { types as nodeUtilTypes } from 'node:util'
import { isHexDigest } from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
  WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
  type WorkspaceSearchMigrationTelemetryContext,
  type WorkspaceSearchMigrationTelemetryPhase,
  type WorkspaceSearchMigrationTelemetryRecorder,
  type WorkspaceSearchMigrationTelemetrySink,
} from './migration-telemetry'

/** Exact operator acknowledgement required for non-production alarm delivery. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL =
  'acknowledge-non-production-alarm-delivery-rehearsal'

/**
 * Controlled aggregate signals available to a non-production rehearsal.
 */
export type WorkspaceSearchMigrationTelemetryRehearsalSignal =
  | 'checkpoint-stall'
  | 'describe-table-throttle'
  | 'quarantine'
  | 'rate-budget-exhaustion'
  | 'recovery'
  | 'terminal-failure'

/**
 * Strict parsed input for one non-production alarm-delivery rehearsal.
 */
export type WorkspaceSearchMigrationTelemetryRehearsalInput = {
  /** Exact acknowledgement preventing accidental execution. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL
  /** Controlled alarm or recovery signal to emit. */
  readonly signal: WorkspaceSearchMigrationTelemetryRehearsalSignal
  /** Reviewed resource-configuration digest used only as safe evidence binding. */
  readonly configurationHash: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly policyVersion: string
}

/** Stable process exit statuses used by the rehearsal CLI. */
export type WorkspaceSearchMigrationTelemetryRehearsalExitCode = 0 | 1 | 2

/**
 * Factory for one existing Workspace Search migration telemetry recorder.
 *
 * @param context - Finite operation and reviewed policy binding.
 * @param sink - Invocation-local one-line capture sink.
 * @returns Best-effort migration telemetry recorder.
 */
export type WorkspaceSearchMigrationTelemetryRehearsalRecorderFactory = (
  context: WorkspaceSearchMigrationTelemetryContext,
  sink: WorkspaceSearchMigrationTelemetrySink,
) => WorkspaceSearchMigrationTelemetryRecorder

/**
 * Injectable process and recorder boundaries for deterministic tests.
 */
export type WorkspaceSearchMigrationTelemetryRehearsalDependencies = {
  /** Creates the existing bounded telemetry recorder. */
  readonly createRecorder:
    WorkspaceSearchMigrationTelemetryRehearsalRecorderFactory
  /** Writes the sole successful EMF line to standard output. */
  readonly writeStandardOutput: (line: string) => void
  /** Writes one stable failure line to standard error. */
  readonly writeStandardError: (line: string) => void
}

/** Allowed exact flag names for the strict rehearsal parser. */
const rehearsalFlagNames = new Set<string>([
  '--approval',
  '--configuration-hash',
  '--policy-version',
  '--signal',
])

/** Allowed finite rehearsal signal values. */
const rehearsalSignals = new Set<string>([
  'checkpoint-stall',
  'describe-table-throttle',
  'quarantine',
  'rate-budget-exhaustion',
  'recovery',
  'terminal-failure',
])

/** Maximum number of CLI arguments accepted before parsing. */
const maximumRehearsalArgumentCount = 16

/** Maximum length of any copied CLI argument. */
const maximumRehearsalArgumentLength = 8_192

/** Maximum serialized EMF line retained before standard output. */
const maximumRehearsalOutputLength = 65_536

/** Stable raw-argument-free invalid-usage result. */
const invalidUsageLine = JSON.stringify({
  schemaVersion: 1,
  operation: 'telemetry-rehearsal',
  status: 'error',
  code: 'INVALID_USAGE',
})

/** Stable raw-error-free internal failure result. */
const rehearsalFailedLine = JSON.stringify({
  schemaVersion: 1,
  operation: 'telemetry-rehearsal',
  status: 'error',
  code: 'REHEARSAL_FAILED',
})

/**
 * Stable parser error without raw argument material.
 */
class WorkspaceSearchMigrationTelemetryRehearsalUsageError extends Error {
  /** Creates the stable invalid-usage error. */
  constructor() {
    super('INVALID_USAGE')
    this.name = 'WorkspaceSearchMigrationTelemetryRehearsalUsageError'
  }
}

/** Default process and existing-recorder boundaries. */
const defaultRehearsalDependencies:
  WorkspaceSearchMigrationTelemetryRehearsalDependencies = Object.freeze({
    createRecorder: (context, sink) =>
      createWorkspaceSearchMigrationTelemetryRecorder(context, { sink }),
    writeStandardOutput: (line: string) => console.log(line),
    writeStandardError: (line: string) => console.error(line),
  })

/**
 * Parses exactly four required flag/value pairs for a controlled rehearsal.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Strict reviewed digest bindings and finite signal.
 */
export function parseWorkspaceSearchMigrationTelemetryRehearsalArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationTelemetryRehearsalInput {
  const snapshot = snapshotRehearsalArguments(arguments_)
  if (snapshot.length !== 8) throw invalidUsage()
  const flags = new Map<string, string>()
  for (let index = 0; index < snapshot.length; index += 2) {
    const name = snapshot[index]
    const value = snapshot[index + 1]
    if (
      name === undefined ||
      value === undefined ||
      !rehearsalFlagNames.has(name) ||
      flags.has(name) ||
      value.length === 0 ||
      value.startsWith('--')
    ) {
      throw invalidUsage()
    }
    flags.set(name, value)
  }
  const approval = flags.get('--approval')
  const signal = flags.get('--signal')
  const configurationHash = flags.get('--configuration-hash')
  const policyVersion = flags.get('--policy-version')
  if (
    approval !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL ||
    !isRehearsalSignal(signal) ||
    !isHexDigest(configurationHash) ||
    !isHexDigest(policyVersion)
  ) {
    throw invalidUsage()
  }
  return Object.freeze({
    approval,
    signal,
    configurationHash,
    policyVersion,
  })
}

/**
 * Emits one controlled secret-free EMF line for non-production delivery proof.
 * This surface makes no AWS calls; the execution environment's normal
 * CloudWatch Logs ingestion is responsible for producing the real alarm state
 * transition and SNS delivery receipt.
 *
 * @param arguments_ - Arguments following the script path.
 * @param dependencies - Injectable recorder and process output boundaries.
 * @returns Stable success, rehearsal-failure, or invalid-usage exit code.
 */
export function runWorkspaceSearchMigrationTelemetryRehearsal(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationTelemetryRehearsalDependencies =
      defaultRehearsalDependencies,
): WorkspaceSearchMigrationTelemetryRehearsalExitCode {
  let writeStandardOutput: (line: string) => void
  let writeStandardError: (line: string) => void
  let createRecorder:
    WorkspaceSearchMigrationTelemetryRehearsalRecorderFactory
  try {
    writeStandardOutput = dependencies.writeStandardOutput
    writeStandardError = dependencies.writeStandardError
    createRecorder = dependencies.createRecorder
  } catch {
    return 1
  }

  let input: WorkspaceSearchMigrationTelemetryRehearsalInput
  try {
    input = parseWorkspaceSearchMigrationTelemetryRehearsalArguments(
      arguments_,
    )
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationTelemetryRehearsalUsageError) {
      writeFailureLine(writeStandardError, invalidUsageLine)
      return 2
    }
    writeFailureLine(writeStandardError, rehearsalFailedLine)
    return 1
  }

  try {
    if (
      typeof writeStandardOutput !== 'function' ||
      nodeUtilTypes.isProxy(writeStandardOutput) ||
      typeof writeStandardError !== 'function' ||
      nodeUtilTypes.isProxy(writeStandardError) ||
      typeof createRecorder !== 'function' ||
      nodeUtilTypes.isProxy(createRecorder)
    ) {
      writeFailureLine(writeStandardError, rehearsalFailedLine)
      return 1
    }
    const serializedRecords: string[] = []
    const sink = (serializedRecord: string): void => {
      if (
        typeof serializedRecord !== 'string' ||
        serializedRecord.length === 0 ||
        serializedRecord.length > maximumRehearsalOutputLength ||
        serializedRecord.includes('\n') ||
        serializedRecord.includes('\r')
      ) {
        serializedRecords.push('')
        return
      }
      serializedRecords.push(serializedRecord)
    }
    const recorder = createRecorder({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      operation: 'telemetry-rehearsal',
      policyVersion: input.policyVersion,
    }, sink)
    if (!isTelemetryRecorder(recorder)) {
      writeFailureLine(writeStandardError, rehearsalFailedLine)
      return 1
    }
    if (!recorder.bindConfigurationHash(input.configurationHash)) {
      writeFailureLine(writeStandardError, rehearsalFailedLine)
      return 1
    }
    recordRehearsalSignal(recorder, input.signal)
    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: rehearsalFinalPhase(input.signal),
      outcome: input.signal === 'terminal-failure'
        ? 'failed'
        : 'succeeded',
    })
    const serializedRecord = serializedRecords[0]
    if (
      serializedRecords.length !== 1 ||
      serializedRecord === undefined ||
      serializedRecord.length === 0
    ) {
      writeFailureLine(writeStandardError, rehearsalFailedLine)
      return 1
    }
    writeStandardOutput(serializedRecord)
    return 0
  } catch {
    writeFailureLine(writeStandardError, rehearsalFailedLine)
    return 1
  }
}

/**
 * Records one controlled fixed observation, or none for recovery.
 *
 * @param recorder - Existing bounded migration telemetry recorder.
 * @param signal - Selected controlled rehearsal signal.
 */
function recordRehearsalSignal(
  recorder: WorkspaceSearchMigrationTelemetryRecorder,
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
): void {
  switch (signal) {
    case 'describe-table-throttle':
      recorder.describeTableRateRecorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'throttle',
        phase: 'measurement',
        sequence: 1,
        observedAtMilliseconds: 0,
        backoffMilliseconds: 0,
      })
      return
    case 'rate-budget-exhaustion':
      recorder.describeTableRateRecorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'budget-stop',
        phase: 'checkpoint-page',
        reason: 'budget-capacity',
        observedAtMilliseconds: 0,
        requiredAttempts: 1,
        remainingNormalAdmissionAttempts: 0,
        remainingWindowAttempts: 0,
        retryAfterMilliseconds: 0,
      })
      return
    case 'checkpoint-stall':
      recorder.record({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        kind: 'checkpoint-stall',
        phase: 'checkpoint-page',
        stalledForMilliseconds:
          WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS,
      })
      return
    case 'quarantine':
      recorder.record({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        kind: 'quarantine',
        phase: 'reconciliation',
        reason: 'rate-state-corrupt',
      })
      return
    case 'terminal-failure':
      recorder.record({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        kind: 'terminal-failure',
        phase: 'terminal',
        reason: 'operation-failed',
      })
      return
    case 'recovery':
      return
  }
}

/**
 * Selects the finite final log phase for one controlled signal.
 *
 * @param signal - Selected controlled rehearsal signal.
 * @returns Fixed secret-free phase.
 */
function rehearsalFinalPhase(
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
): WorkspaceSearchMigrationTelemetryPhase {
  switch (signal) {
    case 'describe-table-throttle':
      return 'measurement'
    case 'rate-budget-exhaustion':
    case 'checkpoint-stall':
      return 'checkpoint-page'
    case 'quarantine':
      return 'reconciliation'
    case 'terminal-failure':
    case 'recovery':
      return 'terminal'
  }
}

/**
 * Checks the exact existing recorder surface required by the rehearsal.
 *
 * @param value - Candidate factory output.
 * @returns Whether every required method is a direct callable data property.
 */
function isTelemetryRecorder(
  value: unknown,
): value is WorkspaceSearchMigrationTelemetryRecorder {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  try {
    for (const key of [
      'bindConfigurationHash',
      'finalize',
      'record',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return false
      }
    }
    const rateDescriptor = Object.getOwnPropertyDescriptor(
      value,
      'describeTableRateRecorder',
    )
    if (
      rateDescriptor === undefined ||
      !rateDescriptor.enumerable ||
      !Object.hasOwn(rateDescriptor, 'value') ||
      typeof rateDescriptor.value !== 'object' ||
      rateDescriptor.value === null ||
      nodeUtilTypes.isProxy(rateDescriptor.value)
    ) {
      return false
    }
    const rateRecordDescriptor = Object.getOwnPropertyDescriptor(
      rateDescriptor.value,
      'record',
    )
    return rateRecordDescriptor !== undefined &&
      rateRecordDescriptor.enumerable === true &&
      Object.hasOwn(rateRecordDescriptor, 'value') &&
      typeof rateRecordDescriptor.value === 'function' &&
      !nodeUtilTypes.isProxy(rateRecordDescriptor.value)
  } catch {
    return false
  }
}

/**
 * Copies one strict dense plain argv array without invoking element accessors.
 *
 * @param arguments_ - Potentially hostile argument collection.
 * @returns Detached frozen argument strings.
 */
function snapshotRehearsalArguments(
  arguments_: readonly string[],
): readonly string[] {
  if (
    nodeUtilTypes.isProxy(arguments_) ||
    !Array.isArray(arguments_) ||
    Object.getPrototypeOf(arguments_) !== Array.prototype
  ) {
    throw invalidUsage()
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(
    arguments_,
    'length',
  )
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    typeof lengthDescriptor.value !== 'number' ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumRehearsalArgumentCount
  ) {
    throw invalidUsage()
  }
  const length = lengthDescriptor.value
  const ownKeys = Reflect.ownKeys(arguments_)
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== length + 1
  ) {
    throw invalidUsage()
  }
  const snapshot: string[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      arguments_,
      String(index),
    )
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length === 0 ||
      descriptor.value.length > maximumRehearsalArgumentLength
    ) {
      throw invalidUsage()
    }
    snapshot.push(descriptor.value)
  }
  return Object.freeze(snapshot)
}

/**
 * Checks one finite rehearsal signal.
 *
 * @param value - Candidate signal.
 * @returns Whether the signal is admitted.
 */
function isRehearsalSignal(
  value: unknown,
): value is WorkspaceSearchMigrationTelemetryRehearsalSignal {
  return typeof value === 'string' && rehearsalSignals.has(value)
}

/** Creates the stable invalid-usage error. */
function invalidUsage(): WorkspaceSearchMigrationTelemetryRehearsalUsageError {
  return new WorkspaceSearchMigrationTelemetryRehearsalUsageError()
}

/**
 * Writes one stable failure line without allowing a writer failure to escape.
 *
 * @param writer - Captured standard-error writer.
 * @param line - Stable raw-value-free JSON line.
 */
function writeFailureLine(
  writer: (line: string) => void,
  line: string,
): void {
  try {
    writer(line)
  } catch {
    // Process reporting cannot recover from a failed injected stderr writer.
  }
}

if (import.meta.main) {
  process.exitCode = runWorkspaceSearchMigrationTelemetryRehearsal(
    process.argv.slice(2),
  )
}
