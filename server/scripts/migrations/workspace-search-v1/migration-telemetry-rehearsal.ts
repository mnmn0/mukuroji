import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import { readBoundedInputFile } from './migration-control-cli'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
  WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
  type WorkspaceSearchMigrationTelemetryContext,
  type WorkspaceSearchMigrationTelemetryPhase,
  type WorkspaceSearchMigrationTelemetryRecorder,
  type WorkspaceSearchMigrationTelemetrySink,
} from './migration-telemetry'
import {
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
  writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
  type WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome,
} from './migration-rehearsal-permit-cli'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Exact operator acknowledgement required for non-production alarm delivery. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL =
  'acknowledge-non-production-alarm-delivery-rehearsal'

/** Exact non-production stage required before a rehearsal may emit EMF. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE =
  'non-production'

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

/** Stable discriminator for authenticated rehearsal signal receipts. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_KIND =
  'mukuroji-workspace-search-migration-rehearsal-signal-receipts'

/** Exact authenticated rehearsal signal receipt contract version. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_VERSION =
  1

/** Maximum canonical bytes admitted for one chained signal receipt artifact. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_MAX_BYTES =
  64 * 1_024

/** Exact alarm-purpose signal receipt HMAC key byte length. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPT_KEY_BYTES =
  32

/** Maximum serialized exact EMF line retained in one receipt. */
const maximumSignalReceiptEmfBytes = 16 * 1_024

/** Canonical order enforced across five positive signals and one recovery. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER:
  readonly WorkspaceSearchMigrationTelemetryRehearsalSignal[] = Object.freeze([
    'describe-table-throttle',
    'rate-budget-exhaustion',
    'checkpoint-stall',
    'quarantine',
    'terminal-failure',
    'recovery',
  ])

/** Canonical alarm labels covered by authenticated signal receipts. */
export type WorkspaceSearchMigrationTelemetryRehearsalAlarmName =
  | 'budget-exhaustion'
  | 'budget-stop'
  | 'checkpoint-stall'
  | 'quarantine'
  | 'terminal-failure'
  | 'throttle'

/** Exact CloudWatch metric names evaluated by the six rehearsal alarms. */
export type WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricName =
  | 'CheckpointStallCount'
  | 'DescribeTableBudgetExhaustionCount'
  | 'DescribeTableBudgetStopCount'
  | 'DescribeTableThrottleCount'
  | 'QuarantineCount'
  | 'TerminalFailureCount'

/** One exact zero-or-one alarm metric serialized in an EMF signal line. */
export type WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricEvidence = {
  /** Canonical identifier-free alarm label. */
  readonly name: WorkspaceSearchMigrationTelemetryRehearsalAlarmName
  /** Exact metric name evaluated by that alarm. */
  readonly metricName:
    WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricName
  /** Exact serialized rehearsal value. */
  readonly value: 0 | 1
}

/** One canonical HMAC-authenticated exact telemetry rehearsal signal. */
export type WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt = {
  /** Controlled semantic signal inferred from the exact EMF metric vector. */
  readonly signal: WorkspaceSearchMigrationTelemetryRehearsalSignal
  /** Exact serialized EMF line retained for verified retry and publication. */
  readonly serializedEmfLine: string
  /** SHA-256 digest of the exact UTF-8 EMF bytes. */
  readonly serializedEmfDigest: string
  /** Exact serialized UTF-8 EMF byte length. */
  readonly serializedEmfByteLength: number
  /** Canonical UTC projection of the exact EMF `_aws.Timestamp`. */
  readonly observedAt: string
  /** Exact EMF `_aws.Timestamp` and `observedAtMilliseconds` value. */
  readonly timestampMilliseconds: number
  /** Reviewed configuration digest copied from the exact EMF line. */
  readonly configurationHash: string
  /** Reviewed rate policy digest copied from the exact EMF line. */
  readonly policyVersion: string
  /** Digest of the secret-free process-generated correlation value. */
  readonly correlationDigest: string
  /** Digest of the stable secret-free evidence locator in the EMF line. */
  readonly evidenceLocatorDigest: string
  /** Exact six-alarm zero-or-one metric vector in canonical alarm order. */
  readonly metrics:
    readonly WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricEvidence[]
  /** Digest of the preceding authenticated receipt, or null for the first. */
  readonly previousReceiptDigest: string | null
  /** Digest of all preceding receipt claims, including the exact EMF line. */
  readonly receiptDigest: string
  /** Domain-separated HMAC-SHA256 over the receipt digest and claims. */
  readonly authenticationTag: string
}

/** Chained durable artifact containing a fixed prefix of the six signals. */
export type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact = {
  /** Stable artifact discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_KIND
  /** Exact artifact contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_VERSION
  /** Reviewed configuration digest shared by every receipt. */
  readonly configurationHash: string
  /** Reviewed rate policy digest shared by every receipt. */
  readonly policyVersion: string
  /** Stable evidence locator digest shared by every receipt. */
  readonly evidenceLocatorDigest: string
  /** Alarm plan or authorization binding selected before signal emission. */
  readonly authorizationBindingDigest: string
  /** Canonical first signal observation time. */
  readonly startedAt: string
  /** Canonical latest signal observation time. */
  readonly completedAt: string
  /** Fixed ordered prefix of five positives followed by recovery. */
  readonly receipts:
    readonly WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt[]
  /** Digest of every preceding artifact field and authenticated receipt. */
  readonly artifactDigest: string
  /** Domain-separated HMAC-SHA256 over the complete artifact claims. */
  readonly authenticationTag: string
}

/** Input that appends one exact EMF line to an authenticated receipt chain. */
export type CreateWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptInput = {
  /** Exact identifier-free EMF string that will be written to stdout. */
  readonly serializedEmfLine: string
  /** Alarm plan or permit authorization binding selected before emission. */
  readonly authorizationBindingDigest: string
  /** Expected stable evidence locator digest declared by the plan. */
  readonly evidenceLocatorDigest: string
  /** Optional preceding authenticated artifact for the next fixed signal. */
  readonly previousArtifact?: unknown
}

/** One alarm transition binding derived only from authenticated EMF bytes. */
export type WorkspaceSearchMigrationTelemetryRehearsalSignalBinding = {
  /** Canonical identifier-free alarm label. */
  readonly name: WorkspaceSearchMigrationTelemetryRehearsalAlarmName
  /** Digest of the exact EMF bytes that set this alarm metric to one. */
  readonly signalDigest: string
  /** Canonical exact EMF observation time. */
  readonly observedAt: string
  /** Exact metric name whose value was one. */
  readonly metricName:
    WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricName
  /** Exact positive value required by the alarm threshold. */
  readonly value: 1
}

/** Stable signal receipt verification failure without raw telemetry material. */
export class WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptError
  extends Error {
  /** Creates one raw-value-free invalid signal receipt failure. */
  constructor() {
    super('INVALID_MIGRATION_REHEARSAL_SIGNAL_RECEIPT')
    this.name =
      'WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptError'
  }
}

/** Strict semantic projection parsed from one exact existing EMF line. */
type ParsedWorkspaceSearchMigrationTelemetryRehearsalSignal = {
  /** Controlled signal inferred from the exact metric vector. */
  readonly signal: WorkspaceSearchMigrationTelemetryRehearsalSignal
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Reviewed rate policy digest. */
  readonly policyVersion: string
  /** Canonical UTC observation time. */
  readonly observedAt: string
  /** Exact EMF Unix timestamp. */
  readonly timestampMilliseconds: number
  /** Digest of the secret-free correlation value. */
  readonly correlationDigest: string
  /** Digest of the stable secret-free evidence locator. */
  readonly evidenceLocatorDigest: string
  /** Canonical six-alarm metric vector. */
  readonly metrics:
    readonly WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricEvidence[]
}

/**
 * Strict parsed input for one non-production alarm-delivery rehearsal.
 */
export type WorkspaceSearchMigrationTelemetryRehearsalInput = {
  /** Exact acknowledgement preventing accidental execution. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL
  /** Exact stage guard that rejects production rehearsal invocations. */
  readonly stage:
    typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE
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

/** Strict authenticated signal-emission CLI arguments. */
export type WorkspaceSearchMigrationTelemetryRehearsalSignalCliArguments = {
  /** Exact acknowledgement preventing accidental non-production emission. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL
  /** Exact non-production stage guard. */
  readonly stage:
    typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE
  /** Fixed next signal in the authenticated chain. */
  readonly signal: WorkspaceSearchMigrationTelemetryRehearsalSignal
  /** Reviewed resource configuration digest. */
  readonly configurationHash: string
  /** Reviewed DescribeTable rate policy digest. */
  readonly policyVersion: string
  /** Plan-declared digest of the stable exact evidence locator. */
  readonly evidenceLocatorDigest: string
  /** Exact alarm plan or authorization binding digest. */
  readonly authorizationBindingDigest: string
  /** Restricted owner-only exact 32-byte alarm-purpose master key path. */
  readonly permitKeyFile: string
  /** New exclusive durable signal receipt artifact path. */
  readonly outputFile: string
  /** Required preceding receipt artifact path after the first signal. */
  readonly previousReceiptFile?: string
}

/** Injectable secure filesystem and exact-output boundaries for signal CLI. */
export type WorkspaceSearchMigrationTelemetryRehearsalSignalCliDependencies = {
  /** Creates the existing bounded telemetry recorder. */
  readonly createRecorder:
    WorkspaceSearchMigrationTelemetryRehearsalRecorderFactory
  /** Reads one stable non-empty file through an inclusive byte ceiling. */
  readonly readInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one exact owner-only mode-0600 alarm-purpose master key. */
  readonly readPermitKeyFile: (path: string) => Promise<Uint8Array>
  /** Exclusively creates and fsyncs one exact mode-0600 artifact. */
  readonly writeOutputFileExclusive: (
    path: string,
    bytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome>
  /** Writes the sole exact EMF line only after durable publication. */
  readonly writeStandardOutput: (line: string) => void
  /** Writes one stable raw-value-free failure line. */
  readonly writeStandardError: (line: string) => void
}

/** Stable authenticated signal-emission process exit codes. */
export type WorkspaceSearchMigrationTelemetryRehearsalSignalCliExitCode =
  0 | 1 | 2

/** Stable raw-value-free authenticated signal CLI failure classes. */
type WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailureCode =
  | 'AUTHENTICATION_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INVALID_USAGE'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'
  | 'REHEARSAL_FAILED'

/** Private stable failure carrying only a code and process status. */
class WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailure
  extends Error {
  /** Stable raw-value-free failure code. */
  readonly code:
    WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailureCode

  /** Stable process exit status. */
  readonly exitCode:
    WorkspaceSearchMigrationTelemetryRehearsalSignalCliExitCode

  /**
   * Creates one stable authenticated signal CLI failure.
   *
   * @param code - Raw-value-free failure classification.
   * @param exitCode - Stable process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailureCode,
    exitCode: WorkspaceSearchMigrationTelemetryRehearsalSignalCliExitCode,
  ) {
    super(code)
    this.name =
      'WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Allowed exact flag names for the strict rehearsal parser. */
const rehearsalFlagNames = new Set<string>([
  '--approval',
  '--configuration-hash',
  '--policy-version',
  '--signal',
  '--stage',
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

/** Six alarm metrics in canonical alarm evidence order. */
const signalAlarmMetrics:
  readonly Omit<
    WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricEvidence,
    'value'
  >[] = Object.freeze([
    { name: 'throttle', metricName: 'DescribeTableThrottleCount' },
    { name: 'budget-stop', metricName: 'DescribeTableBudgetStopCount' },
    {
      name: 'budget-exhaustion',
      metricName: 'DescribeTableBudgetExhaustionCount',
    },
    { name: 'checkpoint-stall', metricName: 'CheckpointStallCount' },
    { name: 'quarantine', metricName: 'QuarantineCount' },
    { name: 'terminal-failure', metricName: 'TerminalFailureCount' },
  ])

/** Exact recorder metric definition order required in every rehearsal line. */
const signalEmfMetricDefinitions = Object.freeze([
  { name: 'CheckpointProgressCount', unit: 'Count' },
  { name: 'CheckpointProgressUnits', unit: 'None' },
  { name: 'CheckpointStallCount', unit: 'Count' },
  { name: 'CheckpointStallMilliseconds', unit: 'Milliseconds' },
  { name: 'DescribeTableAttemptCount', unit: 'Count' },
  { name: 'DescribeTableBudgetExhaustionCount', unit: 'Count' },
  { name: 'DescribeTableBudgetStopCount', unit: 'Count' },
  { name: 'DescribeTableCadenceWaitCount', unit: 'Count' },
  { name: 'DescribeTableCadenceWaitMilliseconds', unit: 'Milliseconds' },
  {
    name: 'DescribeTableThrottleBackoffMilliseconds',
    unit: 'Milliseconds',
  },
  { name: 'DescribeTableThrottleCount', unit: 'Count' },
  { name: 'OperationCount', unit: 'Count' },
  { name: 'QuarantineCount', unit: 'Count' },
  { name: 'TerminalFailureCount', unit: 'Count' },
])

/** Strict guards bound to the stable signal receipt validation failure. */
const signalReceiptGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failSignalReceipt,
)

/** Maximum number of CLI arguments accepted before parsing. */
const maximumRehearsalArgumentCount = 24

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

/** Default secure local boundaries for authenticated signal emission. */
const defaultSignalCliDependencies:
  WorkspaceSearchMigrationTelemetryRehearsalSignalCliDependencies =
    Object.freeze({
      createRecorder: defaultRehearsalDependencies.createRecorder,
      readInputFile: readBoundedInputFile,
      readPermitKeyFile:
        readWorkspaceSearchMigrationRehearsalPermitSigningKey,
      writeOutputFileExclusive:
        writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
      writeStandardOutput: (line: string): void => console.log(line),
      writeStandardError: (line: string): void => console.error(line),
    })

/**
 * Parses exactly five required flag/value pairs for a controlled rehearsal.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Strict reviewed digest bindings and finite signal.
 */
export function parseWorkspaceSearchMigrationTelemetryRehearsalArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationTelemetryRehearsalInput {
  const snapshot = snapshotRehearsalArguments(arguments_)
  if (snapshot.length !== 10) throw invalidUsage()
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
  const stage = flags.get('--stage')
  const signal = flags.get('--signal')
  const configurationHash = flags.get('--configuration-hash')
  const policyVersion = flags.get('--policy-version')
  if (
    approval !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL ||
    stage !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE ||
    !isRehearsalSignal(signal) ||
    !isHexDigest(configurationHash) ||
    !isHexDigest(policyVersion)
  ) {
    throw invalidUsage()
  }
  return Object.freeze({
    approval,
    stage,
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
 * Parses one exact authenticated signal-emission command.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Strict signal, digest bindings, and distinct local paths.
 */
export function parseWorkspaceSearchMigrationTelemetryRehearsalSignalCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationTelemetryRehearsalSignalCliArguments {
  try {
    const snapshot = snapshotRehearsalArguments(arguments_)
    if (snapshot.length !== 18 && snapshot.length !== 20) {
      return failSignalCli('INVALID_USAGE', 2)
    }
    const allowedFlags = new Set([
      '--approval',
      '--authorization-binding-digest',
      '--configuration-hash',
      '--evidence-locator-digest',
      '--output-file',
      '--permit-key-file',
      '--policy-version',
      '--previous-receipt-file',
      '--signal',
      '--stage',
    ])
    const flags = new Map<string, string>()
    for (let index = 0; index < snapshot.length; index += 2) {
      const name = snapshot[index]
      const value = snapshot[index + 1]
      if (
        name === undefined ||
        value === undefined ||
        !allowedFlags.has(name) ||
        flags.has(name) ||
        value.length === 0 ||
        value.startsWith('--')
      ) {
        return failSignalCli('INVALID_USAGE', 2)
      }
      flags.set(name, value)
    }
    const baseInput = parseWorkspaceSearchMigrationTelemetryRehearsalArguments([
      '--approval',
      flags.get('--approval') ?? '',
      '--stage',
      flags.get('--stage') ?? '',
      '--signal',
      flags.get('--signal') ?? '',
      '--configuration-hash',
      flags.get('--configuration-hash') ?? '',
      '--policy-version',
      flags.get('--policy-version') ?? '',
    ])
    const evidenceLocatorDigest = flags.get('--evidence-locator-digest')
    const authorizationBindingDigest = flags.get(
      '--authorization-binding-digest',
    )
    const permitKeyFile = flags.get('--permit-key-file')
    const outputFile = flags.get('--output-file')
    const previousReceiptFile = flags.get('--previous-receipt-file')
    const isFirstSignal = baseInput.signal ===
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER[0]
    if (
      !isHexDigest(evidenceLocatorDigest) ||
      evidenceLocatorDigest !==
        createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
          baseInput.configurationHash,
          baseInput.policyVersion,
        ) ||
      !isHexDigest(authorizationBindingDigest) ||
      permitKeyFile === undefined ||
      outputFile === undefined ||
      (isFirstSignal && previousReceiptFile !== undefined) ||
      (!isFirstSignal && previousReceiptFile === undefined)
    ) {
      return failSignalCli('INVALID_USAGE', 2)
    }
    const paths = [
      permitKeyFile,
      outputFile,
      ...(previousReceiptFile === undefined ? [] : [previousReceiptFile]),
    ]
    if (new Set(paths).size !== paths.length) {
      return failSignalCli('INVALID_USAGE', 2)
    }
    return Object.freeze({
      ...baseInput,
      evidenceLocatorDigest,
      authorizationBindingDigest,
      permitKeyFile,
      outputFile,
      ...(previousReceiptFile === undefined
        ? {}
        : { previousReceiptFile }),
    })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailure
    ) {
      throw error
    }
    return failSignalCli('INVALID_USAGE', 2)
  }
}

/**
 * Emits one authenticated exact telemetry rehearsal signal.
 *
 * The existing recorder's exact EMF string is captured before output, strictly
 * parsed and HMAC-authenticated, then published through an exclusive mode-0600
 * file-and-directory fsync boundary. Only after that durable write succeeds is
 * the same string passed to stdout for the existing CloudWatch Logs ingestion
 * path. A stdout failure is never reported as success; the durable artifact
 * remains available for a separately approved verified retry.
 *
 * @param arguments_ - Strict authenticated signal CLI arguments.
 * @param dependencies - Secure filesystem, recorder, and output boundaries.
 * @returns Stable success, failure, or invalid-usage process status.
 */
export async function runWorkspaceSearchMigrationTelemetryRehearsalSignalCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationTelemetryRehearsalSignalCliDependencies =
      defaultSignalCliDependencies,
): Promise<WorkspaceSearchMigrationTelemetryRehearsalSignalCliExitCode> {
  let masterKey: Uint8Array | undefined
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const input =
      parseWorkspaceSearchMigrationTelemetryRehearsalSignalCliArguments(
        arguments_,
      )
    try {
      masterKey = await dependencies.readPermitKeyFile(input.permitKeyFile)
      requireSignalReceiptKey(masterKey)
      const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(
        masterKey,
      )
      runtimeKey = derivedKeys.runtimeKey
      publicationKey = derivedKeys.publicationKey
      zeroizeSignalReceiptKey(masterKey)
      masterKey = undefined
    } catch {
      return failSignalCli('AUTHENTICATION_FAILED', 1)
    }
    let previousArtifact: unknown
    if (input.previousReceiptFile !== undefined) {
      try {
        previousArtifact =
          verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
            await readCanonicalSignalReceiptInput(
              input.previousReceiptFile,
              dependencies,
            ),
            runtimeKey,
          )
      } catch {
        return failSignalCli('INPUT_FILE_INVALID', 1)
      }
    }
    const capturedOutput: string[] = []
    const capturedError: string[] = []
    const rehearsalExitCode = runWorkspaceSearchMigrationTelemetryRehearsal([
      '--approval',
      input.approval,
      '--stage',
      input.stage,
      '--signal',
      input.signal,
      '--configuration-hash',
      input.configurationHash,
      '--policy-version',
      input.policyVersion,
    ], {
      createRecorder: dependencies.createRecorder,
      writeStandardOutput: (line) => capturedOutput.push(line),
      writeStandardError: (line) => capturedError.push(line),
    })
    const serializedEmfLine = capturedOutput[0]
    if (
      rehearsalExitCode !== 0 ||
      capturedOutput.length !== 1 ||
      capturedError.length !== 0 ||
      serializedEmfLine === undefined
    ) {
      return failSignalCli('REHEARSAL_FAILED', 1)
    }
    const artifact =
      createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        {
          serializedEmfLine,
          authorizationBindingDigest: input.authorizationBindingDigest,
          evidenceLocatorDigest: input.evidenceLocatorDigest,
          ...(previousArtifact === undefined ? {} : { previousArtifact }),
        },
        runtimeKey,
      )
    const artifactBytes =
      serializeWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        artifact,
        runtimeKey,
      )
    let outcome: WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome
    try {
      outcome = await dependencies.writeOutputFileExclusive(
        input.outputFile,
        artifactBytes,
      )
    } catch {
      return failSignalCli('OUTPUT_FILE_WRITE_FAILED', 1)
    }
    if (outcome === 'exists') {
      return failSignalCli('OUTPUT_FILE_EXISTS', 1)
    }
    if (outcome !== 'created' && outcome !== 'reconciled') {
      return failSignalCli('OUTPUT_FILE_WRITE_FAILED', 1)
    }
    dependencies.writeStandardOutput(serializedEmfLine)
    return 0
  } catch (error: unknown) {
    const failure = error instanceof
        WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailure
      ? error
      : new WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailure(
          'REHEARSAL_FAILED',
          1,
        )
    writeSignalCliFailureLine(dependencies.writeStandardError, failure.code)
    return failure.exitCode
  } finally {
    zeroizeSignalReceiptKey(masterKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(publicationKey)
  }
}

/**
 * Derives the plan-declared digest of the stable bound evidence locator.
 *
 * @param configurationHash - Reviewed resource configuration digest.
 * @param policyVersion - Reviewed DescribeTable rate policy digest.
 * @returns Domain-separated digest of the exact identifier-free locator.
 */
export function createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
  configurationHash: string,
  policyVersion: string,
): string {
  if (!isHexDigest(configurationHash) || !isHexDigest(policyVersion)) {
    return failSignalReceipt()
  }
  const locatorDigest = createHash('sha256')
    .update('workspace-search-migration-evidence-v1\0')
    .update(configurationHash)
    .update('\0')
    .update(policyVersion)
    .digest('hex')
  return createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-evidence-locator',
    version: 1,
    evidenceLocator: `wsm-evidence-v1:${locatorDigest}`,
  })
}

/**
 * Appends one exact existing telemetry rehearsal EMF line to a HMAC chain.
 *
 * The line is strictly parsed before authentication. The first five entries
 * must be the fixed positive signals and the sixth must be a zero-complete
 * recovery. A previous artifact is authenticated before any of its claims are
 * reused, and observation time must advance strictly.
 *
 * @param input - Exact EMF, authorization, locator, and optional prior chain.
 * @param signingKey - Restricted exact 32-byte alarm-purpose HMAC key.
 * @returns Fresh authenticated fixed-prefix receipt artifact.
 */
export function createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
  input: CreateWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptInput,
  signingKey: Uint8Array,
): WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact {
  try {
    requireSignalReceiptKey(signingKey)
    const record = signalReceiptGuards.requireRecord(input)
    const inputKeys = Object.keys(record)
    const hasPreviousArtifact = inputKeys.includes('previousArtifact')
    signalReceiptGuards.requireExactKeys(record, [
      'authorizationBindingDigest',
      'evidenceLocatorDigest',
      ...(hasPreviousArtifact ? ['previousArtifact'] : []),
      'serializedEmfLine',
    ])
    const serializedEmfLine = signalReceiptGuards.readOwn(
      record,
      'serializedEmfLine',
    )
    if (typeof serializedEmfLine !== 'string') return failSignalReceipt()
    const authorizationBindingDigest = signalReceiptGuards.readDigest(
      signalReceiptGuards.readOwn(record, 'authorizationBindingDigest'),
    )
    const expectedEvidenceLocatorDigest = signalReceiptGuards.readDigest(
      signalReceiptGuards.readOwn(record, 'evidenceLocatorDigest'),
    )
    const parsed = readExactTelemetryRehearsalSignal(serializedEmfLine)
    if (parsed.evidenceLocatorDigest !== expectedEvidenceLocatorDigest) {
      return failSignalReceipt()
    }
    const previousValue = hasPreviousArtifact
      ? signalReceiptGuards.readOwn(record, 'previousArtifact')
      : undefined
    const previousArtifact = previousValue === undefined
      ? undefined
      : verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
          previousValue,
          signingKey,
        )
    const expectedSignal =
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER[
        previousArtifact?.receipts.length ?? 0
      ]
    if (
      expectedSignal === undefined ||
      parsed.signal !== expectedSignal ||
      (expectedSignal ===
          WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER[0] &&
        previousArtifact !== undefined) ||
      (expectedSignal !==
          WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER[0] &&
        previousArtifact === undefined)
    ) {
      return failSignalReceipt()
    }
    if (previousArtifact !== undefined) {
      const previousReceipt = previousArtifact.receipts.at(-1)
      if (
        previousArtifact.authorizationBindingDigest !==
          authorizationBindingDigest ||
        previousArtifact.configurationHash !== parsed.configurationHash ||
        previousArtifact.policyVersion !== parsed.policyVersion ||
        previousArtifact.evidenceLocatorDigest !==
          parsed.evidenceLocatorDigest ||
        previousReceipt === undefined ||
        parsed.timestampMilliseconds <= previousReceipt.timestampMilliseconds
      ) {
        return failSignalReceipt()
      }
    }
    const serializedEmfBytes = new TextEncoder().encode(serializedEmfLine)
    const previousReceiptDigest = previousArtifact?.receipts.at(-1)
      ?.receiptDigest ?? null
    const receiptClaims: Omit<
      WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt,
      'authenticationTag' | 'receiptDigest'
    > = {
      signal: parsed.signal,
      serializedEmfLine,
      serializedEmfDigest: createHash('sha256')
        .update(serializedEmfBytes)
        .digest('hex'),
      serializedEmfByteLength: serializedEmfBytes.byteLength,
      observedAt: parsed.observedAt,
      timestampMilliseconds: parsed.timestampMilliseconds,
      configurationHash: parsed.configurationHash,
      policyVersion: parsed.policyVersion,
      correlationDigest: parsed.correlationDigest,
      evidenceLocatorDigest: parsed.evidenceLocatorDigest,
      metrics: parsed.metrics,
      previousReceiptDigest,
    }
    const receiptDigest = createMigrationDigest(receiptClaims)
    const receiptWithoutTag = { ...receiptClaims, receiptDigest }
    const receipt: WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt = {
      ...receiptWithoutTag,
      authenticationTag: createSignalReceiptAuthenticationTag(
        'receipt',
        receiptWithoutTag,
        signingKey,
      ),
    }
    const receipts = Object.freeze([
      ...(previousArtifact?.receipts ?? []),
      Object.freeze(receipt),
    ])
    const artifactClaims: Omit<
      WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
      'artifactDigest' | 'authenticationTag'
    > = {
      kind:
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_KIND,
      version:
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_VERSION,
      configurationHash: parsed.configurationHash,
      policyVersion: parsed.policyVersion,
      evidenceLocatorDigest: parsed.evidenceLocatorDigest,
      authorizationBindingDigest,
      startedAt: previousArtifact?.startedAt ?? parsed.observedAt,
      completedAt: parsed.observedAt,
      receipts,
    }
    const artifactDigest = createMigrationDigest(artifactClaims)
    const artifactWithoutTag = { ...artifactClaims, artifactDigest }
    return Object.freeze({
      ...artifactWithoutTag,
      authenticationTag: createSignalReceiptAuthenticationTag(
        'artifact',
        artifactWithoutTag,
        signingKey,
      ),
    })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptError
    ) {
      throw error
    }
    return failSignalReceipt()
  }
}

/**
 * Strictly parses and authenticates one signal receipt artifact.
 *
 * @param value - Candidate artifact crossing a file or process boundary.
 * @param verificationKey - Restricted exact 32-byte alarm-purpose HMAC key.
 * @returns Detached artifact after line, chain, digest, and HMAC verification.
 */
export function verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
  value: unknown,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact {
  try {
    requireSignalReceiptKey(verificationKey)
    const record = signalReceiptGuards.requireRecord(value)
    signalReceiptGuards.requireExactKeys(record, [
      'artifactDigest',
      'authenticationTag',
      'authorizationBindingDigest',
      'completedAt',
      'configurationHash',
      'evidenceLocatorDigest',
      'kind',
      'policyVersion',
      'receipts',
      'startedAt',
      'version',
    ])
    if (
      signalReceiptGuards.readOwn(record, 'kind') !==
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_KIND ||
      signalReceiptGuards.readOwn(record, 'version') !==
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_VERSION
    ) {
      return failSignalReceipt()
    }
    const configurationHash = signalReceiptGuards.readDigest(
      signalReceiptGuards.readOwn(record, 'configurationHash'),
    )
    const policyVersion = signalReceiptGuards.readDigest(
      signalReceiptGuards.readOwn(record, 'policyVersion'),
    )
    const evidenceLocatorDigest = signalReceiptGuards.readDigest(
      signalReceiptGuards.readOwn(record, 'evidenceLocatorDigest'),
    )
    const authorizationBindingDigest = signalReceiptGuards.readDigest(
      signalReceiptGuards.readOwn(record, 'authorizationBindingDigest'),
    )
    if (
      evidenceLocatorDigest !==
        createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
          configurationHash,
          policyVersion,
        )
    ) {
      return failSignalReceipt()
    }
    const receiptsValue = signalReceiptGuards.readOwn(record, 'receipts')
    if (
      !Array.isArray(receiptsValue) ||
      nodeUtilTypes.isProxy(receiptsValue) ||
      receiptsValue.length === 0 ||
      receiptsValue.length >
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER.length
    ) {
      return failSignalReceipt()
    }
    const receiptValues: readonly unknown[] = receiptsValue
    const receipts = receiptValues.map((entry, index) =>
      readAuthenticatedSignalReceipt(
        entry,
        index,
        configurationHash,
        policyVersion,
        evidenceLocatorDigest,
        verificationKey,
      ))
    const correlationDigests = new Set<string>()
    for (const [index, receipt] of receipts.entries()) {
      const previousReceipt = receipts[index - 1]
      if (
        correlationDigests.has(receipt.correlationDigest) ||
        receipt.previousReceiptDigest !==
          (previousReceipt?.receiptDigest ?? null) ||
        (previousReceipt !== undefined &&
          receipt.timestampMilliseconds <=
            previousReceipt.timestampMilliseconds)
      ) {
        return failSignalReceipt()
      }
      correlationDigests.add(receipt.correlationDigest)
    }
    const firstReceipt = receipts[0]
    const lastReceipt = receipts.at(-1)
    if (firstReceipt === undefined || lastReceipt === undefined) {
      return failSignalReceipt()
    }
    const startedAt = readSignalReceiptTimestamp(
      signalReceiptGuards.readOwn(record, 'startedAt'),
    )
    const completedAt = readSignalReceiptTimestamp(
      signalReceiptGuards.readOwn(record, 'completedAt'),
    )
    if (
      startedAt !== firstReceipt.observedAt ||
      completedAt !== lastReceipt.observedAt
    ) {
      return failSignalReceipt()
    }
    const artifactClaims: Omit<
      WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
      'artifactDigest' | 'authenticationTag'
    > = {
      kind:
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_KIND,
      version:
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_VERSION,
      configurationHash,
      policyVersion,
      evidenceLocatorDigest,
      authorizationBindingDigest,
      startedAt,
      completedAt,
      receipts,
    }
    const artifactDigest = signalReceiptGuards.readDigest(
      signalReceiptGuards.readOwn(record, 'artifactDigest'),
    )
    if (artifactDigest !== createMigrationDigest(artifactClaims)) {
      return failSignalReceipt()
    }
    const artifactWithoutTag = { ...artifactClaims, artifactDigest }
    const authenticationTag = signalReceiptGuards.readDigest(
      signalReceiptGuards.readOwn(record, 'authenticationTag'),
    )
    if (!matchesSignalReceiptAuthenticationTag(
      authenticationTag,
      'artifact',
      artifactWithoutTag,
      verificationKey,
    )) {
      return failSignalReceipt()
    }
    return Object.freeze({ ...artifactWithoutTag, authenticationTag })
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptError
    ) {
      throw error
    }
    return failSignalReceipt()
  }
}

/**
 * Serializes one authenticated signal receipt artifact as canonical bytes.
 *
 * @param value - Candidate artifact.
 * @param verificationKey - Restricted exact 32-byte HMAC key.
 * @returns Exact bounded canonical UTF-8 artifact bytes.
 */
export function serializeWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
  value: unknown,
  verificationKey: Uint8Array,
): Uint8Array {
  const artifact =
    verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
      value,
      verificationKey,
    )
  const bytes = new TextEncoder().encode(serializeCanonicalJson(artifact))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_MAX_BYTES
  ) {
    return failSignalReceipt()
  }
  return bytes
}

/**
 * Derives six alarm bindings from one complete authenticated receipt chain.
 *
 * The single rate-budget line intentionally supplies both budget alarm
 * bindings. The recovery line is excluded because it sets every alarm metric
 * to zero.
 *
 * @param value - Candidate complete signal receipt artifact.
 * @param verificationKey - Restricted exact 32-byte HMAC key.
 * @returns Six canonical positive signal bindings in alarm evidence order.
 */
export function createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings(
  value: unknown,
  verificationKey: Uint8Array,
): readonly WorkspaceSearchMigrationTelemetryRehearsalSignalBinding[] {
  const artifact =
    verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
      value,
      verificationKey,
    )
  if (
    artifact.receipts.length !==
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER.length
  ) {
    return failSignalReceipt()
  }
  const bindings: WorkspaceSearchMigrationTelemetryRehearsalSignalBinding[] =
    []
  for (const receipt of artifact.receipts.slice(0, -1)) {
    for (const metric of receipt.metrics) {
      if (metric.value === 1) {
        bindings.push(Object.freeze({
          name: metric.name,
          signalDigest: receipt.serializedEmfDigest,
          observedAt: receipt.observedAt,
          metricName: metric.metricName,
          value: 1,
        }))
      }
    }
  }
  if (
    bindings.length !== signalAlarmMetrics.length ||
    bindings.some((binding, index) =>
      binding.name !== signalAlarmMetrics[index]?.name ||
      binding.metricName !== signalAlarmMetrics[index]?.metricName)
  ) {
    return failSignalReceipt()
  }
  return Object.freeze(bindings)
}

/** Reads one exact existing zero-complete telemetry rehearsal EMF line. */
function readExactTelemetryRehearsalSignal(
  serializedEmfLine: string,
): ParsedWorkspaceSearchMigrationTelemetryRehearsalSignal {
  const bytes = new TextEncoder().encode(serializedEmfLine)
  if (
    serializedEmfLine.length === 0 ||
    serializedEmfLine.includes('\n') ||
    serializedEmfLine.includes('\r') ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumSignalReceiptEmfBytes
  ) {
    return failSignalReceipt()
  }
  let parsedValue: unknown
  try {
    parsedValue = JSON.parse(serializedEmfLine)
  } catch {
    return failSignalReceipt()
  }
  if (JSON.stringify(parsedValue) !== serializedEmfLine) {
    return failSignalReceipt()
  }
  const record = signalReceiptGuards.requireRecord(parsedValue)
  const metrics = readExactSignalMetricVector(record)
  const signal = inferExactTelemetryRehearsalSignal(metrics)
  const expectation = readSignalSemanticExpectation(signal)
  signalReceiptGuards.requireExactKeys(record, [
    'CheckpointProgressCount',
    'CheckpointProgressUnits',
    'CheckpointStallCount',
    'CheckpointStallMilliseconds',
    'DescribeTableAttemptCount',
    'DescribeTableBudgetExhaustionCount',
    'DescribeTableBudgetStopCount',
    'DescribeTableCadenceWaitCount',
    'DescribeTableCadenceWaitMilliseconds',
    'DescribeTableThrottleBackoffMilliseconds',
    'DescribeTableThrottleCount',
    'OperationCount',
    'QuarantineCount',
    'Service',
    'TerminalFailureCount',
    '_aws',
    'configurationBinding',
    'configurationHash',
    'correlationId',
    'event',
    'evidenceLocator',
    ...(expectation.lastReason === undefined ? [] : ['lastReason']),
    'lastTrigger',
    'observationCount',
    'observedAtMilliseconds',
    'operation',
    'outcome',
    'phase',
    'policyVersion',
    'schemaVersion',
    'sequence',
    'service',
  ])
  if (
    signalReceiptGuards.readOwn(record, 'schemaVersion') !==
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION ||
    signalReceiptGuards.readOwn(record, 'event') !==
      'workspace-search-migration.finalized' ||
    signalReceiptGuards.readOwn(record, 'service') !==
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE ||
    signalReceiptGuards.readOwn(record, 'Service') !==
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE ||
    signalReceiptGuards.readOwn(record, 'operation') !==
      'telemetry-rehearsal' ||
    signalReceiptGuards.readOwn(record, 'phase') !== expectation.phase ||
    signalReceiptGuards.readOwn(record, 'outcome') !== expectation.outcome ||
    signalReceiptGuards.readOwn(record, 'lastTrigger') !==
      expectation.lastTrigger ||
    readOptionalSignalReceiptOwn(record, 'lastReason') !==
      expectation.lastReason ||
    signalReceiptGuards.readOwn(record, 'configurationBinding') !== 'bound' ||
    signalReceiptGuards.readOwn(record, 'observationCount') !==
      expectation.observationCount ||
    signalReceiptGuards.readOwn(record, 'CheckpointProgressCount') !== 0 ||
    signalReceiptGuards.readOwn(record, 'CheckpointProgressUnits') !== 0 ||
    signalReceiptGuards.readOwn(record, 'CheckpointStallMilliseconds') !==
      (signal === 'checkpoint-stall'
        ? WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS
        : 0) ||
    signalReceiptGuards.readOwn(record, 'DescribeTableAttemptCount') !== 0 ||
    signalReceiptGuards.readOwn(record, 'DescribeTableCadenceWaitCount') !==
      0 ||
    signalReceiptGuards.readOwn(
      record,
      'DescribeTableCadenceWaitMilliseconds',
    ) !== 0 ||
    signalReceiptGuards.readOwn(
      record,
      'DescribeTableThrottleBackoffMilliseconds',
    ) !== 0 ||
    signalReceiptGuards.readOwn(record, 'OperationCount') !== 1
  ) {
    return failSignalReceipt()
  }
  const configurationHash = signalReceiptGuards.readOwn(
    record,
    'configurationHash',
  )
  const policyVersion = signalReceiptGuards.readOwn(record, 'policyVersion')
  const correlationId = signalReceiptGuards.readOwn(record, 'correlationId')
  const evidenceLocator = signalReceiptGuards.readOwn(
    record,
    'evidenceLocator',
  )
  const observedAtMilliseconds = signalReceiptGuards.readOwn(
    record,
    'observedAtMilliseconds',
  )
  const sequence = signalReceiptGuards.readOwn(record, 'sequence')
  if (
    !isHexDigest(configurationHash) ||
    !isHexDigest(policyVersion) ||
    typeof correlationId !== 'string' ||
    !/^wsm-correlation-v1:[a-f0-9]{32}$/u.test(correlationId) ||
    typeof evidenceLocator !== 'string' ||
    evidenceLocator !== createBoundTelemetryRehearsalEvidenceLocator(
      configurationHash,
      policyVersion,
    ) ||
    typeof observedAtMilliseconds !== 'number' ||
    !Number.isSafeInteger(observedAtMilliseconds) ||
    observedAtMilliseconds < 0 ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0
  ) {
    return failSignalReceipt()
  }
  readExactEmfMetadata(
    signalReceiptGuards.readOwn(record, '_aws'),
    observedAtMilliseconds,
  )
  return Object.freeze({
    signal,
    configurationHash,
    policyVersion,
    observedAt: new Date(observedAtMilliseconds).toISOString(),
    timestampMilliseconds: observedAtMilliseconds,
    correlationDigest: createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-signal-correlation',
      version: 1,
      correlationId,
    }),
    evidenceLocatorDigest: createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-evidence-locator',
      version: 1,
      evidenceLocator,
    }),
    metrics,
  })
}

/** Reads the exact zero-complete six alarm metric vector. */
function readExactSignalMetricVector(
  record: object,
): readonly WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricEvidence[] {
  return Object.freeze(signalAlarmMetrics.map((metric) => {
    const value = signalReceiptGuards.readOwn(record, metric.metricName)
    if (value !== 0 && value !== 1) return failSignalReceipt()
    return Object.freeze({ ...metric, value })
  }))
}

/** Infers one admitted signal from its exact six-alarm metric vector. */
function inferExactTelemetryRehearsalSignal(
  metrics:
    readonly WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricEvidence[],
): WorkspaceSearchMigrationTelemetryRehearsalSignal {
  const values = metrics.map((metric) => metric.value).join('')
  switch (values) {
    case '100000':
      return 'describe-table-throttle'
    case '011000':
      return 'rate-budget-exhaustion'
    case '000100':
      return 'checkpoint-stall'
    case '000010':
      return 'quarantine'
    case '000001':
      return 'terminal-failure'
    case '000000':
      return 'recovery'
    default:
      return failSignalReceipt()
  }
}

/** Fixed non-metric semantics emitted for one controlled signal. */
type TelemetryRehearsalSignalSemanticExpectation = {
  /** Exact final phase. */
  readonly phase: WorkspaceSearchMigrationTelemetryPhase
  /** Exact terminal outcome. */
  readonly outcome: 'failed' | 'succeeded'
  /** Exact recorder trigger label. */
  readonly lastTrigger: string
  /** Optional exact raw-value-free recorder reason. */
  readonly lastReason?: string
  /** Exact recorder observation count. */
  readonly observationCount: 0 | 1
}

/** Returns the fixed non-metric semantics for one controlled signal. */
function readSignalSemanticExpectation(
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
): TelemetryRehearsalSignalSemanticExpectation {
  switch (signal) {
    case 'describe-table-throttle':
      return {
        phase: 'measurement',
        outcome: 'succeeded',
        lastTrigger: 'describe-table-throttle',
        observationCount: 1,
      }
    case 'rate-budget-exhaustion':
      return {
        phase: 'checkpoint-page',
        outcome: 'succeeded',
        lastTrigger: 'describe-table-budget-stop',
        lastReason: 'budget-capacity',
        observationCount: 1,
      }
    case 'checkpoint-stall':
      return {
        phase: 'checkpoint-page',
        outcome: 'succeeded',
        lastTrigger: 'checkpoint-stall',
        observationCount: 1,
      }
    case 'quarantine':
      return {
        phase: 'reconciliation',
        outcome: 'succeeded',
        lastTrigger: 'quarantine',
        lastReason: 'rate-state-corrupt',
        observationCount: 1,
      }
    case 'terminal-failure':
      return {
        phase: 'terminal',
        outcome: 'failed',
        lastTrigger: 'terminal-failure',
        lastReason: 'operation-failed',
        observationCount: 1,
      }
    case 'recovery':
      return {
        phase: 'terminal',
        outcome: 'succeeded',
        lastTrigger: 'none',
        observationCount: 0,
      }
  }
}

/** Reads exact CloudWatch EMF metadata and its full metric definitions. */
function readExactEmfMetadata(value: unknown, timestamp: number): void {
  const record = signalReceiptGuards.requireRecord(value)
  signalReceiptGuards.requireExactKeys(record, [
    'CloudWatchMetrics',
    'Timestamp',
  ])
  if (signalReceiptGuards.readOwn(record, 'Timestamp') !== timestamp) {
    return failSignalReceipt()
  }
  const directives = signalReceiptGuards.readOwn(record, 'CloudWatchMetrics')
  if (
    !Array.isArray(directives) ||
    nodeUtilTypes.isProxy(directives) ||
    directives.length !== 1
  ) {
    return failSignalReceipt()
  }
  const directive = signalReceiptGuards.requireRecord(directives[0])
  signalReceiptGuards.requireExactKeys(directive, [
    'Dimensions',
    'Metrics',
    'Namespace',
  ])
  const dimensions = signalReceiptGuards.readOwn(directive, 'Dimensions')
  if (
    signalReceiptGuards.readOwn(directive, 'Namespace') !==
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE ||
    !Array.isArray(dimensions) ||
    nodeUtilTypes.isProxy(dimensions) ||
    dimensions.length !== 1 ||
    !Array.isArray(dimensions[0]) ||
    nodeUtilTypes.isProxy(dimensions[0]) ||
    dimensions[0].length !== 1 ||
    dimensions[0][0] !== 'Service'
  ) {
    return failSignalReceipt()
  }
  const definitions = signalReceiptGuards.readOwn(directive, 'Metrics')
  if (
    !Array.isArray(definitions) ||
    nodeUtilTypes.isProxy(definitions) ||
    definitions.length !== signalEmfMetricDefinitions.length
  ) {
    return failSignalReceipt()
  }
  for (const [index, definitionValue] of definitions.entries()) {
    const definition = signalReceiptGuards.requireRecord(definitionValue)
    signalReceiptGuards.requireExactKeys(definition, ['Name', 'Unit'])
    if (
      signalReceiptGuards.readOwn(definition, 'Name') !==
        signalEmfMetricDefinitions[index]?.name ||
      signalReceiptGuards.readOwn(definition, 'Unit') !==
        signalEmfMetricDefinitions[index]?.unit
    ) {
      return failSignalReceipt()
    }
  }
}

/** Reads and authenticates one receipt at its fixed chain position. */
function readAuthenticatedSignalReceipt(
  value: unknown,
  index: number,
  configurationHash: string,
  policyVersion: string,
  evidenceLocatorDigest: string,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt {
  const record = signalReceiptGuards.requireRecord(value)
  signalReceiptGuards.requireExactKeys(record, [
    'authenticationTag',
    'configurationHash',
    'correlationDigest',
    'evidenceLocatorDigest',
    'metrics',
    'observedAt',
    'policyVersion',
    'previousReceiptDigest',
    'receiptDigest',
    'serializedEmfByteLength',
    'serializedEmfDigest',
    'serializedEmfLine',
    'signal',
    'timestampMilliseconds',
  ])
  const serializedEmfLine = signalReceiptGuards.readOwn(
    record,
    'serializedEmfLine',
  )
  if (typeof serializedEmfLine !== 'string') return failSignalReceipt()
  const parsed = readExactTelemetryRehearsalSignal(serializedEmfLine)
  const expectedSignal =
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER[index]
  const serializedEmfBytes = new TextEncoder().encode(serializedEmfLine)
  const previousReceiptDigestValue = signalReceiptGuards.readOwn(
    record,
    'previousReceiptDigest',
  )
  const previousReceiptDigest = previousReceiptDigestValue === null
    ? null
    : signalReceiptGuards.readDigest(previousReceiptDigestValue)
  if (
    expectedSignal === undefined ||
    parsed.signal !== expectedSignal ||
    signalReceiptGuards.readOwn(record, 'signal') !== parsed.signal ||
    signalReceiptGuards.readOwn(record, 'configurationHash') !==
      configurationHash ||
    signalReceiptGuards.readOwn(record, 'policyVersion') !== policyVersion ||
    signalReceiptGuards.readOwn(record, 'evidenceLocatorDigest') !==
      evidenceLocatorDigest ||
    signalReceiptGuards.readOwn(record, 'correlationDigest') !==
      parsed.correlationDigest ||
    signalReceiptGuards.readOwn(record, 'observedAt') !== parsed.observedAt ||
    signalReceiptGuards.readOwn(record, 'timestampMilliseconds') !==
      parsed.timestampMilliseconds ||
    signalReceiptGuards.readOwn(record, 'serializedEmfByteLength') !==
      serializedEmfBytes.byteLength ||
    signalReceiptGuards.readOwn(record, 'serializedEmfDigest') !==
      createHash('sha256').update(serializedEmfBytes).digest('hex') ||
    !equalSignalMetrics(
      signalReceiptGuards.readOwn(record, 'metrics'),
      parsed.metrics,
    ) ||
    (index === 0 && previousReceiptDigest !== null) ||
    (index > 0 && previousReceiptDigest === null)
  ) {
    return failSignalReceipt()
  }
  const receiptClaims: Omit<
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt,
    'authenticationTag' | 'receiptDigest'
  > = {
    signal: parsed.signal,
    serializedEmfLine,
    serializedEmfDigest: createHash('sha256')
      .update(serializedEmfBytes)
      .digest('hex'),
    serializedEmfByteLength: serializedEmfBytes.byteLength,
    observedAt: parsed.observedAt,
    timestampMilliseconds: parsed.timestampMilliseconds,
    configurationHash,
    policyVersion,
    correlationDigest: parsed.correlationDigest,
    evidenceLocatorDigest,
    metrics: parsed.metrics,
    previousReceiptDigest,
  }
  const receiptDigest = signalReceiptGuards.readDigest(
    signalReceiptGuards.readOwn(record, 'receiptDigest'),
  )
  if (receiptDigest !== createMigrationDigest(receiptClaims)) {
    return failSignalReceipt()
  }
  const receiptWithoutTag = { ...receiptClaims, receiptDigest }
  const authenticationTag = signalReceiptGuards.readDigest(
    signalReceiptGuards.readOwn(record, 'authenticationTag'),
  )
  if (!matchesSignalReceiptAuthenticationTag(
    authenticationTag,
    'receipt',
    receiptWithoutTag,
    verificationKey,
  )) {
    return failSignalReceipt()
  }
  return Object.freeze({ ...receiptWithoutTag, authenticationTag })
}

/** Compares one untrusted receipt metric vector with parsed exact metrics. */
function equalSignalMetrics(
  value: unknown,
  expected:
    readonly WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricEvidence[],
): boolean {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== expected.length
  ) {
    return false
  }
  const entries: readonly unknown[] = value
  for (const [index, entry] of entries.entries()) {
    const record = signalReceiptGuards.requireRecord(entry)
    signalReceiptGuards.requireExactKeys(record, [
      'metricName',
      'name',
      'value',
    ])
    if (
      signalReceiptGuards.readOwn(record, 'name') !== expected[index]?.name ||
      signalReceiptGuards.readOwn(record, 'metricName') !==
        expected[index]?.metricName ||
      signalReceiptGuards.readOwn(record, 'value') !== expected[index]?.value
    ) {
      return false
    }
  }
  return true
}

/** Derives the exact stable bound evidence locator emitted by the recorder. */
function createBoundTelemetryRehearsalEvidenceLocator(
  configurationHash: string,
  policyVersion: string,
): string {
  const digest = createHash('sha256')
    .update('workspace-search-migration-evidence-v1\0')
    .update(configurationHash)
    .update('\0')
    .update(policyVersion)
    .digest('hex')
  return `wsm-evidence-v1:${digest}`
}

/** Creates one domain-separated canonical signal receipt HMAC tag. */
function createSignalReceiptAuthenticationTag(
  purpose: 'artifact' | 'receipt',
  claims: unknown,
  key: Uint8Array,
): string {
  requireSignalReceiptKey(key)
  return createHmac('sha256', key)
    .update(`workspace-search-migration-rehearsal-signal-${purpose}-v1\0`)
    .update(serializeCanonicalJson(claims))
    .digest('hex')
}

/** Compares one canonical authentication tag without timing leakage. */
function matchesSignalReceiptAuthenticationTag(
  actual: string,
  purpose: 'artifact' | 'receipt',
  claims: unknown,
  key: Uint8Array,
): boolean {
  const expected = createSignalReceiptAuthenticationTag(purpose, claims, key)
  return timingSafeEqual(
    Buffer.from(actual, 'hex'),
    Buffer.from(expected, 'hex'),
  )
}

/** Requires one non-Proxy exact 32-byte alarm-purpose HMAC key. */
function requireSignalReceiptKey(value: Uint8Array): void {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    value.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPT_KEY_BYTES
  ) {
    return failSignalReceipt()
  }
}

/** Reads one canonical UTC signal receipt timestamp. */
function readSignalReceiptTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failSignalReceipt()
  return value
}

/** Reads one optional enumerable own data property without accessors. */
function readOptionalSignalReceiptOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    return failSignalReceipt()
  }
  return descriptor.value
}

/** Raises one stable raw-value-free signal receipt validation failure. */
function failSignalReceipt(): never {
  throw new WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptError()
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
        provenance: 'aws-service',
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
        provenance: 'operational',
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

/** Reads one bounded byte-for-byte canonical previous signal artifact. */
async function readCanonicalSignalReceiptInput(
  path: string,
  dependencies:
    WorkspaceSearchMigrationTelemetryRehearsalSignalCliDependencies,
): Promise<unknown> {
  let bytes: Uint8Array | undefined
  try {
    bytes = await dependencies.readInputFile(
      path,
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_MAX_BYTES,
    )
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_MAX_BYTES
    ) {
      return failSignalCli('INPUT_FILE_INVALID', 1)
    }
    let text: string
    let value: unknown
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      value = JSON.parse(text)
    } catch {
      return failSignalCli('INPUT_FILE_INVALID', 1)
    }
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(value),
    )
    if (!equalSignalCliBytes(bytes, canonicalBytes)) {
      return failSignalCli('INPUT_FILE_INVALID', 1)
    }
    return value
  } finally {
    if (bytes !== undefined && !nodeUtilTypes.isProxy(bytes)) {
      try {
        bytes.fill(0)
      } catch {
        // Previous artifacts are secret-free; zeroization is best effort.
      }
    }
  }
}

/** Compares two bounded byte vectors without coercion. */
function equalSignalCliBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Emits one stable canonical signal CLI failure line. */
function writeSignalCliFailureLine(
  writer: (line: string) => void,
  code: WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailureCode,
): void {
  try {
    writer(serializeCanonicalJson({
      schemaVersion: 1,
      operation: 'telemetry-rehearsal-signal',
      status: 'error',
      code,
    }))
  } catch {
    // Raw writer failures never replace the stable process status.
  }
}

/** Raises one stable authenticated signal CLI failure. */
function failSignalCli(
  code: WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailureCode,
  exitCode: WorkspaceSearchMigrationTelemetryRehearsalSignalCliExitCode,
): never {
  throw new WorkspaceSearchMigrationTelemetryRehearsalSignalCliFailure(
    code,
    exitCode,
  )
}

/** Zeroizes one invocation-local alarm-purpose key when possible. */
function zeroizeSignalReceiptKey(value: Uint8Array | undefined): void {
  if (value === undefined || nodeUtilTypes.isProxy(value)) return
  try {
    value.fill(0)
  } catch {
    // Best-effort zeroization must not expose raw key material.
  }
}

if (import.meta.main) {
  process.exitCode =
    await runWorkspaceSearchMigrationTelemetryRehearsalSignalCli(
      process.argv.slice(2),
    )
}
