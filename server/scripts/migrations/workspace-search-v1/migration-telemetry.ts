import { createHash, randomBytes } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import { isHexDigest } from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableBudgetStopProvenance,
  type WorkspaceSearchMigrationDescribeTablePhase,
  type WorkspaceSearchMigrationDescribeTableRateObservation,
  type WorkspaceSearchMigrationDescribeTableRateRecorder,
  type WorkspaceSearchMigrationDescribeTableRateStopReason,
  type WorkspaceSearchMigrationDescribeTableThrottleProvenance,
} from './migration-describe-table-rate-budget'

/** Version of the strict Workspace Search migration telemetry contract. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION = 1

/** Fixed CloudWatch namespace owned by the migration telemetry contract. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE =
  'Mukuroji/WorkspaceSearchMigration'

/** Fixed low-cardinality service dimension used by every migration metric. */
export const WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE =
  'mukuroji-workspace-search-migration'

/** Default live-operation checkpoint stall threshold: five minutes. */
export const WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS =
  300_000

/** Maximum safe numeric value accepted from a telemetry observation. */
const maximumTelemetryNumericValue = Number.MAX_SAFE_INTEGER

/** Exact lowercase hexadecimal bytes accepted from a correlation source. */
const opaqueCorrelationPattern = /^[0-9a-f]{32}$/

/** Stable prefix distinguishing generated correlation values from raw IDs. */
const correlationPrefix = 'wsm-correlation-v1:'

/** Stable prefix distinguishing evidence locators from physical paths. */
const evidenceLocatorPrefix = 'wsm-evidence-v1:'

/** Stable prefix for policy-and-correlation-only unbound evidence lookup. */
const unboundEvidenceLocatorPrefix = 'wsm-evidence-unbound-v1:'

/**
 * Finite operator operations admitted to migration telemetry.
 */
export type WorkspaceSearchMigrationTelemetryOperation =
  | 'apply'
  | 'bootstrap-open'
  | 'close-replan'
  | 'execution-status'
  | 'measure'
  | 'release'
  | 'rollback-complete'
  | 'rollback-partial'
  | 'status'
  | 'telemetry-rehearsal'
  | 'verify'

/**
 * Finite execution and rate phases admitted to migration telemetry.
 */
export type WorkspaceSearchMigrationTelemetryPhase =
  | 'admission'
  | 'apply'
  | 'checkpoint-page'
  | 'close'
  | 'drain'
  | 'integrity-check'
  | 'measurement'
  | 'planning'
  | 'post-send-guard'
  | 'pre-send-guard'
  | 'reconciliation'
  | 'release'
  | 'rollback'
  | 'terminal'
  | 'verification'
  | 'writer-fence'

/**
 * Finite outcomes admitted as secret-free structured-log attributes.
 */
export type WorkspaceSearchMigrationTelemetryOutcome =
  | 'failed'
  | 'interrupted'
  | 'progress'
  | 'quarantined'
  | 'stalled'
  | 'started'
  | 'stopped'
  | 'succeeded'
  | 'throttled'
  | 'waiting'

/**
 * Terminal invocation outcomes admitted by the one-line finalizer.
 */
export type WorkspaceSearchMigrationTelemetryFinalOutcome =
  | 'failed'
  | 'interrupted'
  | 'succeeded'

/**
 * Fixed quarantine classifications that cannot contain raw state or errors.
 */
export type WorkspaceSearchMigrationTelemetryQuarantineReason =
  | 'attempt-recovery-required'
  | 'checkpoint-corrupt'
  | 'cleanup-recovery-required'
  | 'configuration-mismatch'
  | 'rate-state-corrupt'
  | 'terminal-state-corrupt'

/**
 * Fixed terminal failure classifications that cannot contain raw errors.
 */
export type WorkspaceSearchMigrationTelemetryTerminalFailureReason =
  | 'authority-lost'
  | 'configuration-mismatch'
  | 'data-integrity'
  | 'interrupted'
  | 'lease-lost'
  | 'operation-failed'
  | 'rate-budget-exhausted'
  | 'verification-failed'

/**
 * Safe reviewed bindings for one process-local telemetry recorder.
 */
export type WorkspaceSearchMigrationTelemetryContext = {
  /** Exact telemetry schema version. */
  readonly version: typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
  /** Finite operator operation bound to this recorder. */
  readonly operation: WorkspaceSearchMigrationTelemetryOperation
  /** Reviewed SHA-256 digest of the active DescribeTable rate policy. */
  readonly policyVersion: string
}

/**
 * Secret-free migration observations accepted by the general recorder.
 */
export type WorkspaceSearchMigrationTelemetryObservation =
  | {
    /** Exact telemetry schema version. */
    readonly version: typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    /** One durable checkpoint advanced by a positive bounded unit count. */
    readonly kind: 'checkpoint-progress'
    /** Finite phase that owns the checkpoint. */
    readonly phase: WorkspaceSearchMigrationTelemetryPhase
    /** Positive progress units completed by this observation. */
    readonly progressUnits: number
  }
  | {
    /** Exact telemetry schema version. */
    readonly version: typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    /** One durable checkpoint exceeded its reviewed progress interval. */
    readonly kind: 'checkpoint-stall'
    /** Finite phase that owns the stalled checkpoint. */
    readonly phase: WorkspaceSearchMigrationTelemetryPhase
    /** Positive bounded interval without checkpoint progress. */
    readonly stalledForMilliseconds: number
  }
  | {
    /** Exact telemetry schema version. */
    readonly version: typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    /** One migration boundary entered a fail-closed quarantine. */
    readonly kind: 'quarantine'
    /** Finite phase that entered quarantine. */
    readonly phase: WorkspaceSearchMigrationTelemetryPhase
    /** Fixed raw-value-free quarantine classification. */
    readonly reason: WorkspaceSearchMigrationTelemetryQuarantineReason
  }
  | {
    /** Exact telemetry schema version. */
    readonly version: typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    /** One operator invocation reached a terminal failure boundary. */
    readonly kind: 'terminal-failure'
    /** Finite phase that failed. */
    readonly phase: WorkspaceSearchMigrationTelemetryPhase
    /** Fixed raw-error-free failure classification. */
    readonly reason: WorkspaceSearchMigrationTelemetryTerminalFailureReason
  }

/**
 * Exact terminal metadata accepted by the one-line telemetry finalizer.
 */
export type WorkspaceSearchMigrationTelemetryFinalization = {
  /** Exact telemetry schema version. */
  readonly version: typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
  /** Finite phase reached when the invocation returned. */
  readonly phase: WorkspaceSearchMigrationTelemetryPhase
  /** Finite top-level invocation outcome. */
  readonly outcome: WorkspaceSearchMigrationTelemetryFinalOutcome
}

/**
 * Trusted synchronous destination for one serialized secret-free EMF record.
 *
 * @param serializedRecord - Strict single-line JSON record.
 * @returns Undefined after synchronous delivery.
 */
export type WorkspaceSearchMigrationTelemetrySink = (
  serializedRecord: string,
) => void

/**
 * Injectable Unix-epoch millisecond clock used by deterministic tests.
 *
 * @returns Non-negative safe integer timestamp.
 */
export type WorkspaceSearchMigrationTelemetryClock = () => number

/**
 * Injectable strictly increasing process-local sequence used by tests.
 *
 * @returns Positive safe integer sequence.
 */
export type WorkspaceSearchMigrationTelemetrySequence = () => number

/**
 * Injectable process-local opaque correlation source used by tests.
 *
 * @returns Exactly sixteen lowercase hexadecimal random bytes.
 */
export type WorkspaceSearchMigrationTelemetryCorrelationSource = () => string

/**
 * Optional trusted runtime dependencies for a telemetry recorder.
 */
export type WorkspaceSearchMigrationTelemetryDependencies = {
  /** Optional deterministic Unix-epoch clock. */
  readonly clock?: WorkspaceSearchMigrationTelemetryClock
  /** Optional deterministic strictly increasing sequence source. */
  readonly sequence?: WorkspaceSearchMigrationTelemetrySequence
  /** Optional deterministic opaque correlation source. */
  readonly correlationSource?:
    WorkspaceSearchMigrationTelemetryCorrelationSource
  /** Optional trusted synchronous sink that returns exactly undefined. */
  readonly sink?: WorkspaceSearchMigrationTelemetrySink
  /** Optional trusted synchronous live sink that returns exactly undefined. */
  readonly liveSink?: WorkspaceSearchMigrationTelemetrySink
}

/**
 * Explicit checkpoint-watchdog modes separating live work from planned drain.
 */
export type WorkspaceSearchMigrationCheckpointStallWatchdogMode =
  | 'intentional-drain'
  | 'monitor-progress'

/**
 * Cancels one scheduled checkpoint-stall callback.
 */
export type WorkspaceSearchMigrationCheckpointStallCancellation = () => void

/**
 * Trusted synchronous one-shot scheduler used by the checkpoint watchdog.
 *
 * @param delayMilliseconds - Positive bounded delay until reevaluation.
 * @param callback - Process-local callback invoked at most once by the scheduler.
 * @returns Synchronous best-effort cancellation callback.
 */
export type WorkspaceSearchMigrationCheckpointStallSchedule = (
  delayMilliseconds: number,
  callback: () => void,
) => WorkspaceSearchMigrationCheckpointStallCancellation

/**
 * Strict construction input for one checkpoint-stall watchdog.
 */
export type WorkspaceSearchMigrationCheckpointStallWatchdogInput = {
  /** Exact telemetry schema version. */
  readonly version: typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
  /** Live monitoring or explicit no-arm intentional drain. */
  readonly mode: WorkspaceSearchMigrationCheckpointStallWatchdogMode
  /** Finite checkpoint-owning phase. */
  readonly phase: WorkspaceSearchMigrationTelemetryPhase
  /** Recorder receiving progress and deterministic stall observations. */
  readonly recorder: WorkspaceSearchMigrationTelemetryRecorder
  /** Optional positive stall threshold, defaulting to five minutes. */
  readonly stallAfterMilliseconds?: number
  /** Optional deterministic monotonic millisecond clock. */
  readonly clock?: WorkspaceSearchMigrationTelemetryClock
  /** Optional deterministic one-shot scheduler. */
  readonly schedule?: WorkspaceSearchMigrationCheckpointStallSchedule
}

/**
 * Best-effort live checkpoint progress watchdog.
 */
export interface WorkspaceSearchMigrationCheckpointStallWatchdog {
  /**
   * Records positive progress and rearms live monitoring from the new clock.
   * Intentional-drain mode records progress but never arms a timer.
   *
   * @param progressUnits - Positive bounded progress completed.
   */
  recordProgress(progressUnits: number): void

  /** Pauses live timing without reading the clock. */
  pause(): void

  /** Resumes live timing from a newly read clock baseline. */
  resume(): void

  /** Cancels any pending callback and permanently stops this watchdog. */
  stop(): void
}

/**
 * Best-effort telemetry surface bound to one migration invocation.
 */
export interface WorkspaceSearchMigrationTelemetryRecorder {
  /** Process-generated opaque correlation safe for operator lookup. */
  readonly correlationId: string | undefined
  /** #158 DescribeTable rate-observation adapter. */
  readonly describeTableRateRecorder:
    WorkspaceSearchMigrationDescribeTableRateRecorder

  /**
   * Validates and records one strict secret-free observation.
   * Malformed values and observer failures are intentionally dropped.
   *
   * @param observation - Runtime value at the telemetry trust boundary.
   */
  record(observation: unknown): void

  /**
   * Binds one reviewed configuration digest exactly once. For `measure`, the
   * digest follows fresh measurement. Other CLI operations bind their reviewed
   * expected digest before I/O, so binding alone does not prove a fresh match.
   * An idempotent repeat of the same digest succeeds; a different digest is
   * rejected without changing buffered observations.
   *
   * @param configurationHash - Candidate lowercase SHA-256 digest.
   * @returns Whether the recorder is now bound to that exact digest.
   */
  bindConfigurationHash(configurationHash: unknown): boolean

  /**
   * Reads the current safe evidence locator. Before configuration binding the
   * locator derives from reviewed policy and opaque process correlation only;
   * after binding it derives from reviewed configuration and policy digests.
   *
   * @returns Current secret-free locator, or undefined when telemetry is disabled.
   */
  readEvidenceLocator(): string | undefined

  /**
   * Reads one detached aggregate without writing a log line.
   *
   * @returns Current secret-free aggregate, or undefined when disabled.
   */
  snapshot(): WorkspaceSearchMigrationTelemetrySnapshot | undefined

  /**
   * Emits exactly one aggregate EMF line. Repeated calls are ignored.
   * Invalid finalization or observer failures never escape.
   *
   * @param finalization - Exact finite invocation result.
   */
  finalize(finalization: unknown): void
}

/**
 * Fixed metric names emitted by Workspace Search migration telemetry.
 */
export type WorkspaceSearchMigrationTelemetryMetricName =
  | 'CheckpointProgressCount'
  | 'CheckpointProgressUnits'
  | 'CheckpointStallCount'
  | 'CheckpointStallMilliseconds'
  | 'DescribeTableAttemptCount'
  | 'DescribeTableBudgetExhaustionCount'
  | 'DescribeTableBudgetStopCount'
  | 'DescribeTableCadenceWaitCount'
  | 'DescribeTableCadenceWaitMilliseconds'
  | 'DescribeTableThrottleBackoffMilliseconds'
  | 'DescribeTableThrottleCount'
  | 'OperationCount'
  | 'QuarantineCount'
  | 'TerminalFailureCount'

/**
 * Detached aggregate values exposed before one-line finalization.
 */
export type WorkspaceSearchMigrationTelemetryMetricSnapshot = {
  /** Number of checkpoint-progress observations. */
  readonly CheckpointProgressCount: number
  /** Sum of positive checkpoint progress units. */
  readonly CheckpointProgressUnits: number
  /** Number of checkpoint-stall observations. */
  readonly CheckpointStallCount: number
  /** Maximum observed checkpoint-stall interval. */
  readonly CheckpointStallMilliseconds: number
  /** Number of physical DescribeTable attempt observations. */
  readonly DescribeTableAttemptCount: number
  /** Number of capacity-exhaustion budget stops. */
  readonly DescribeTableBudgetExhaustionCount: number
  /** Number of all DescribeTable budget-stop observations. */
  readonly DescribeTableBudgetStopCount: number
  /** Number of DescribeTable cadence waits. */
  readonly DescribeTableCadenceWaitCount: number
  /** Sum of bounded DescribeTable cadence-wait intervals. */
  readonly DescribeTableCadenceWaitMilliseconds: number
  /** Maximum observed DescribeTable throttle backoff. */
  readonly DescribeTableThrottleBackoffMilliseconds: number
  /** Number of DescribeTable throttle observations. */
  readonly DescribeTableThrottleCount: number
  /** One only in the finalized invocation record. */
  readonly OperationCount: number
  /** Number of explicit or rate-derived quarantine observations. */
  readonly QuarantineCount: number
  /** Number of terminal-failure observations. */
  readonly TerminalFailureCount: number
}

/**
 * Fields shared by bound and unbound migration telemetry snapshots.
 */
type WorkspaceSearchMigrationTelemetrySnapshotBase = {
  /** Exact telemetry schema version. */
  readonly version: typeof WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
  /** Process-generated opaque correlation. */
  readonly correlationId: string
  /** Bound or unbound policy-scoped secret-free evidence locator. */
  readonly evidenceLocator: string
  /** Number of accepted observations accumulated so far. */
  readonly observationCount: number
  /** Most recent fixed trigger, or none before any accepted observation. */
  readonly lastTrigger:
    | 'checkpoint-progress'
    | 'checkpoint-stall'
    | 'describe-table-attempt'
    | 'describe-table-budget-stop'
    | 'describe-table-cadence-wait'
    | 'describe-table-throttle'
    | 'none'
    | 'quarantine'
    | 'terminal-failure'
  /** Most recent bounded reason when one was present. */
  readonly lastReason:
    | WorkspaceSearchMigrationDescribeTableRateStopReason
    | WorkspaceSearchMigrationTelemetryQuarantineReason
    | WorkspaceSearchMigrationTelemetryTerminalFailureReason
    | undefined
  /** Every alarm metric, including explicit zero values. */
  readonly metrics: WorkspaceSearchMigrationTelemetryMetricSnapshot
}

/**
 * Safe aggregate available for CLI composition or deterministic tests.
 * The discriminant prevents an unbound snapshot from carrying a fabricated
 * configuration digest and requires the reviewed correlation digest for bound
 * snapshots. A bound snapshot alone does not prove fresh measurement or a
 * matching runtime configuration.
 */
export type WorkspaceSearchMigrationTelemetrySnapshot =
  & WorkspaceSearchMigrationTelemetrySnapshotBase
  & (
    | {
      /** Indicates that the invocation installed a reviewed correlation digest. */
      readonly configurationBinding: 'bound'
      /** Reviewed SHA-256 locator, not proof of a fresh runtime match. */
      readonly configurationHash: string
    }
    | {
      /** Indicates that no reviewed resource digest has been bound yet. */
      readonly configurationBinding: 'unbound'
      /** Prevents unbound snapshots from carrying a configuration digest. */
      readonly configurationHash?: never
    }
  )

/**
 * Fixed units accepted by the strict EMF metric schema.
 */
type WorkspaceSearchMigrationTelemetryMetricUnit =
  | 'Count'
  | 'Milliseconds'
  | 'None'

/**
 * One finite metric datum constructed from a validated observation.
 */
type WorkspaceSearchMigrationTelemetryMetricDatum = {
  /** Fixed CloudWatch metric name. */
  readonly name: WorkspaceSearchMigrationTelemetryMetricName
  /** Fixed CloudWatch metric unit. */
  readonly unit: WorkspaceSearchMigrationTelemetryMetricUnit
  /** Finite non-negative metric value. */
  readonly value: number
}

/**
 * One fixed metric schema entry and its aggregate behavior.
 */
type WorkspaceSearchMigrationTelemetryMetricDefinition = {
  /** Fixed CloudWatch metric name. */
  readonly name: WorkspaceSearchMigrationTelemetryMetricName
  /** Fixed CloudWatch metric unit. */
  readonly unit: WorkspaceSearchMigrationTelemetryMetricUnit
  /** Safe bounded aggregation applied to accepted observations. */
  readonly aggregation: 'maximum' | 'sum'
}

/**
 * Sanitized event ready for EMF construction.
 */
type SanitizedWorkspaceSearchMigrationTelemetryEvent = {
  /** Fixed event trigger. */
  readonly trigger:
    | 'checkpoint-progress'
    | 'checkpoint-stall'
    | 'describe-table-attempt'
    | 'describe-table-budget-stop'
    | 'describe-table-cadence-wait'
    | 'describe-table-throttle'
    | 'quarantine'
    | 'terminal-failure'
  /** Finite phase. */
  readonly phase: WorkspaceSearchMigrationTelemetryPhase
  /** Finite outcome. */
  readonly outcome: WorkspaceSearchMigrationTelemetryOutcome
  /** Optional fixed raw-value-free reason. */
  readonly reason?:
    | WorkspaceSearchMigrationDescribeTableRateStopReason
    | WorkspaceSearchMigrationTelemetryQuarantineReason
    | WorkspaceSearchMigrationTelemetryTerminalFailureReason
  /** Exact finite metrics for this event. */
  readonly metrics: readonly WorkspaceSearchMigrationTelemetryMetricDatum[]
}

/**
 * Validated immutable recorder context.
 */
type ValidatedWorkspaceSearchMigrationTelemetryContext = {
  /** Finite operator operation. */
  readonly operation: WorkspaceSearchMigrationTelemetryOperation
  /** Reviewed rate-policy digest. */
  readonly policyVersion: string
}

/**
 * Validated terminal metadata used by the one-line serializer.
 */
type ValidatedWorkspaceSearchMigrationTelemetryFinalization = {
  /** Finite final phase. */
  readonly phase: WorkspaceSearchMigrationTelemetryPhase
  /** Finite invocation outcome. */
  readonly outcome: WorkspaceSearchMigrationTelemetryFinalOutcome
}

/**
 * Validated immutable recorder dependencies.
 */
type ValidatedWorkspaceSearchMigrationTelemetryDependencies = {
  /** Unix-epoch clock. */
  readonly clock: WorkspaceSearchMigrationTelemetryClock
  /** Strict sequence source. */
  readonly sequence: WorkspaceSearchMigrationTelemetrySequence
  /** Opaque correlation source. */
  readonly correlationSource:
    WorkspaceSearchMigrationTelemetryCorrelationSource
  /** Synchronous output sink. */
  readonly sink: WorkspaceSearchMigrationTelemetrySink
  /** Optional immediate bound checkpoint-stall sink. */
  readonly liveSink: WorkspaceSearchMigrationTelemetrySink | undefined
}

/**
 * Validated process-local ordering metadata for one emitted record.
 */
type WorkspaceSearchMigrationTelemetryProcessMetadata = {
  /** Non-decreasing Unix-epoch millisecond timestamp. */
  readonly observedAtMilliseconds: number
  /** Strictly increasing process-local sequence. */
  readonly sequence: number
}

/** Fixed allowed operation values. */
const telemetryOperations = new Set<string>([
  'apply',
  'bootstrap-open',
  'close-replan',
  'execution-status',
  'measure',
  'release',
  'rollback-complete',
  'rollback-partial',
  'status',
  'telemetry-rehearsal',
  'verify',
])

/** Fixed allowed phase values. */
const telemetryPhases = new Set<string>([
  'admission',
  'apply',
  'checkpoint-page',
  'close',
  'drain',
  'integrity-check',
  'measurement',
  'planning',
  'post-send-guard',
  'pre-send-guard',
  'reconciliation',
  'release',
  'rollback',
  'terminal',
  'verification',
  'writer-fence',
])

/** Fixed allowed one-line final outcomes. */
const telemetryFinalOutcomes = new Set<string>([
  'failed',
  'interrupted',
  'succeeded',
])

/** Fixed allowed quarantine classifications. */
const quarantineReasons = new Set<string>([
  'attempt-recovery-required',
  'checkpoint-corrupt',
  'cleanup-recovery-required',
  'configuration-mismatch',
  'rate-state-corrupt',
  'terminal-state-corrupt',
])

/** Fixed allowed terminal failure classifications. */
const terminalFailureReasons = new Set<string>([
  'authority-lost',
  'configuration-mismatch',
  'data-integrity',
  'interrupted',
  'lease-lost',
  'operation-failed',
  'rate-budget-exhausted',
  'verification-failed',
])

/** Exhaustive runtime catalog synchronized by typecheck with #158 phases. */
const describeTablePhaseCatalog: Readonly<
  Record<WorkspaceSearchMigrationDescribeTablePhase, true>
> = Object.freeze({
  'checkpoint-page': true,
  'integrity-check': true,
  measurement: true,
  'post-send-guard': true,
  'pre-send-guard': true,
  reconciliation: true,
})

/** Exhaustive runtime catalog synchronized by typecheck with #158 reasons. */
const describeTableStopReasonCatalog: Readonly<
  Record<WorkspaceSearchMigrationDescribeTableRateStopReason, true>
> = Object.freeze({
  'budget-capacity': true,
  'cadence-bound': true,
  interrupted: true,
  'invalid-lifecycle': true,
  'page-capacity': true,
  quarantined: true,
  throttled: true,
  'taken-over': true,
})

/** Complete zero-emitting alarm metric schema. */
const telemetryMetricDefinitions: readonly WorkspaceSearchMigrationTelemetryMetricDefinition[] =
  Object.freeze([
    Object.freeze({
      name: 'CheckpointProgressCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'CheckpointProgressUnits',
      unit: 'None',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'CheckpointStallCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'CheckpointStallMilliseconds',
      unit: 'Milliseconds',
      aggregation: 'maximum',
    }),
    Object.freeze({
      name: 'DescribeTableAttemptCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'DescribeTableBudgetExhaustionCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'DescribeTableBudgetStopCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'DescribeTableCadenceWaitCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'DescribeTableCadenceWaitMilliseconds',
      unit: 'Milliseconds',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'DescribeTableThrottleBackoffMilliseconds',
      unit: 'Milliseconds',
      aggregation: 'maximum',
    }),
    Object.freeze({
      name: 'DescribeTableThrottleCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'OperationCount',
      unit: 'Count',
      aggregation: 'maximum',
    }),
    Object.freeze({
      name: 'QuarantineCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
    Object.freeze({
      name: 'TerminalFailureCount',
      unit: 'Count',
      aggregation: 'sum',
    }),
  ])

/** Frozen no-op rate adapter used when telemetry initialization is invalid. */
const noOpDescribeTableRateRecorder:
  WorkspaceSearchMigrationDescribeTableRateRecorder = Object.freeze({
    /**
     * Drops one rate observation while telemetry is disabled.
     *
     * @param _observation - Ignored sanitized rate observation.
     */
    record(_observation: WorkspaceSearchMigrationDescribeTableRateObservation): void {
      // A disabled best-effort observer intentionally performs no work.
    },
  })

/** Frozen no-op recorder used when telemetry initialization is invalid. */
const noOpTelemetryRecorder: WorkspaceSearchMigrationTelemetryRecorder =
  Object.freeze({
    correlationId: undefined,
    describeTableRateRecorder: noOpDescribeTableRateRecorder,
    /**
     * Drops one migration observation while telemetry is disabled.
     *
     * @param _observation - Ignored runtime observation.
     */
    record(_observation: unknown): void {
      // A disabled best-effort observer intentionally performs no work.
    },
    /**
     * Rejects configuration binding while telemetry is disabled.
     *
     * @param _configurationHash - Ignored candidate digest.
     * @returns Always false.
     */
    bindConfigurationHash(_configurationHash: unknown): false {
      return false
    },
    /** @returns No evidence locator while telemetry is disabled. */
    readEvidenceLocator(): undefined {
      return undefined
    },
    /** @returns No snapshot while telemetry is disabled. */
    snapshot(): undefined {
      return undefined
    },
    /**
     * Drops terminal metadata while telemetry is disabled.
     *
     * @param _finalization - Ignored terminal metadata.
     */
    finalize(_finalization: unknown): void {
      // A disabled best-effort observer intentionally performs no work.
    },
  })

/** Frozen no-op checkpoint watchdog used for invalid construction input. */
const noOpCheckpointStallWatchdog:
  WorkspaceSearchMigrationCheckpointStallWatchdog = Object.freeze({
    /**
     * Drops progress while checkpoint monitoring is disabled.
     *
     * @param _progressUnits - Ignored positive progress units.
     */
    recordProgress(_progressUnits: number): void {
      // A disabled best-effort watchdog intentionally performs no work.
    },
    /** Leaves the disabled watchdog unchanged. */
    pause(): void {
      // A disabled best-effort watchdog intentionally performs no work.
    },
    /** Leaves the disabled watchdog unchanged. */
    resume(): void {
      // A disabled best-effort watchdog intentionally performs no work.
    },
    /** Leaves the disabled watchdog unchanged. */
    stop(): void {
      // A disabled best-effort watchdog intentionally performs no work.
    },
  })

/**
 * Creates one best-effort recorder over a strict secret-free EMF schema.
 * Invalid context, dependency, observation, clock, sequence, correlation, or
 * sink behavior disables or drops telemetry and never changes migration work.
 *
 * @param context - Exact reviewed invocation bindings.
 * @param dependencies - Optional deterministic test and structured-log ports.
 * @returns Bound general recorder and #158 rate-recorder adapter.
 */
export function createWorkspaceSearchMigrationTelemetryRecorder(
  context: unknown,
  dependencies: unknown = undefined,
): WorkspaceSearchMigrationTelemetryRecorder {
  try {
    const validatedContext = validateTelemetryContext(context)
    const validatedDependencies = validateTelemetryDependencies(dependencies)
    if (
      validatedContext === undefined ||
      validatedDependencies === undefined
    ) {
      return noOpTelemetryRecorder
    }

    const randomCorrelation = validatedDependencies.correlationSource()
    if (!opaqueCorrelationPattern.test(randomCorrelation)) {
      return noOpTelemetryRecorder
    }
    const correlationId = `${correlationPrefix}${randomCorrelation}`
    const totalAggregate = createZeroMetricAggregate()
    const pendingAggregate = createZeroMetricAggregate()
    let configurationHash: string | undefined
    let evidenceLocator = createUnboundEvidenceLocator(
      validatedContext.policyVersion,
      correlationId,
    )
    let observationCount = 0
    let lastTrigger:
      WorkspaceSearchMigrationTelemetrySnapshot['lastTrigger'] = 'none'
    let lastReason:
      WorkspaceSearchMigrationTelemetrySnapshot['lastReason'] = undefined
    let finalized = false
    let lastObservedAtMilliseconds = -1
    let lastSequence = 0

    /**
     * Reads one valid ordered process metadata tuple.
     *
     * @returns Fresh metadata, or undefined for an invalid dependency value.
     */
    const readProcessMetadata = ():
      WorkspaceSearchMigrationTelemetryProcessMetadata | undefined => {
      try {
        const observedAtMilliseconds = validatedDependencies.clock()
        const sequence = validatedDependencies.sequence()
        if (
          !isNonNegativeSafeInteger(observedAtMilliseconds) ||
          observedAtMilliseconds < lastObservedAtMilliseconds ||
          !isPositiveSafeInteger(sequence) ||
          sequence <= lastSequence
        ) {
          return undefined
        }
        lastObservedAtMilliseconds = observedAtMilliseconds
        lastSequence = sequence
        return Object.freeze({ observedAtMilliseconds, sequence })
      } catch {
        return undefined
      }
    }

    /**
     * Emits one bound live checkpoint-stall event immediately when possible.
     *
     * @param event - Sanitized checkpoint-stall event.
     * @returns Whether the live sink accepted the event synchronously.
     */
    const emitLiveCheckpointStall = (
      event: SanitizedWorkspaceSearchMigrationTelemetryEvent,
    ): boolean => {
      const liveSink = validatedDependencies.liveSink
      if (
        liveSink === undefined ||
        configurationHash === undefined ||
        event.trigger !== 'checkpoint-stall'
      ) {
        return false
      }
      const metadata = readProcessMetadata()
      if (metadata === undefined) return false
      try {
        liveSink(serializeLiveCheckpointStall({
          context: validatedContext,
          event,
          configurationHash,
          correlationId,
          evidenceLocator,
          metadata,
        }))
        return true
      } catch {
        return false
      }
    }

    /**
     * Accumulates one sanitized event into total and pending aggregates.
     *
     * @param event - Fixed event and metrics.
     */
    const accumulate = (
      event: SanitizedWorkspaceSearchMigrationTelemetryEvent,
    ): void => {
      try {
        if (finalized) return
        for (const metric of event.metrics) {
          accumulateMetric(totalAggregate, metric)
        }
        if (!emitLiveCheckpointStall(event)) {
          for (const metric of event.metrics) {
            accumulateMetric(pendingAggregate, metric)
          }
        }
        observationCount = boundedAdd(observationCount, 1)
        lastTrigger = event.trigger
        lastReason = event.reason
      } catch {
        // Telemetry must never change migration progress or failure handling.
      }
    }

    /**
     * Creates one snapshot with a configuration binding that matches runtime
     * recorder state.
     *
     * @param aggregate - Total or not-yet-emitted metric aggregate.
     * @returns Frozen bound or unbound secret-free snapshot.
     */
    const createCurrentSnapshot = (
      aggregate: ReadonlyMap<
        WorkspaceSearchMigrationTelemetryMetricName,
        number
      >,
    ): WorkspaceSearchMigrationTelemetrySnapshot => {
      const sharedInput = {
        aggregate,
        correlationId,
        evidenceLocator,
        observationCount,
        lastTrigger,
        lastReason,
      }
      if (configurationHash === undefined) {
        return createTelemetrySnapshot({
          ...sharedInput,
          configurationBinding: 'unbound',
        })
      }
      return createTelemetrySnapshot({
        ...sharedInput,
        configurationBinding: 'bound',
        configurationHash,
      })
    }

    /**
     * Reads the current detached aggregate without output.
     *
     * @returns Frozen secret-free total aggregate.
     */
    const snapshot = ():
      WorkspaceSearchMigrationTelemetrySnapshot | undefined => {
      return createCurrentSnapshot(totalAggregate)
    }

    /**
     * Binds one reviewed correlation digest without replaying buffered events.
     * This recorder state alone does not prove fresh measurement or a match.
     *
     * @param candidate - Candidate reviewed configuration digest.
     * @returns Whether the recorder is bound to that exact digest.
     */
    const bindConfigurationHash = (candidate: unknown): boolean => {
      try {
        if (!isHexDigest(candidate) || finalized) return false
        if (configurationHash !== undefined) {
          return configurationHash === candidate
        }
        configurationHash = candidate
        evidenceLocator = createEvidenceLocator(
          candidate,
          validatedContext.policyVersion,
        )
        return true
      } catch {
        return false
      }
    }

    /**
     * Emits exactly one aggregate EMF line.
     *
     * @param finalization - Runtime finalization value.
     */
    const finalize = (finalization: unknown): void => {
      try {
        if (finalized) return
        const validatedFinalization = validateTelemetryFinalization(
          finalization,
        )
        if (validatedFinalization === undefined) return
        const configurationBinding = configurationHash === undefined
          ? 'unbound'
          : 'bound'
        if (
          configurationBinding === 'unbound' &&
          (
            validatedContext.operation !== 'measure' ||
            validatedFinalization.outcome === 'succeeded'
          )
        ) {
          return
        }
        const metadata = readProcessMetadata()
        if (metadata === undefined) return
        totalAggregate.set('OperationCount', 1)
        pendingAggregate.set('OperationCount', 1)
        if (
          validatedFinalization.outcome === 'failed' &&
          readMetricAggregate(totalAggregate, 'TerminalFailureCount') === 0
        ) {
          totalAggregate.set('TerminalFailureCount', 1)
          pendingAggregate.set('TerminalFailureCount', 1)
        }
        const aggregateSnapshot = createCurrentSnapshot(pendingAggregate)
        finalized = true
        validatedDependencies.sink(serializeTelemetryAggregate({
          context: validatedContext,
          finalization: validatedFinalization,
          snapshot: aggregateSnapshot,
          correlationId,
          evidenceLocator,
          observedAtMilliseconds: metadata.observedAtMilliseconds,
          sequence: metadata.sequence,
        }))
      } catch {
        // Telemetry must never change migration progress or failure handling.
      }
    }

    const describeTableRateRecorder:
      WorkspaceSearchMigrationDescribeTableRateRecorder = Object.freeze({
        /**
         * Sanitizes and aggregates one #158 rate observation.
         *
         * @param observation - Candidate sanitized rate observation.
         */
        record(
          observation: WorkspaceSearchMigrationDescribeTableRateObservation,
        ): void {
          try {
            const event = sanitizeDescribeTableRateObservation(observation)
            if (event !== undefined) accumulate(event)
          } catch {
            // Hostile or malformed observations are dropped without effects.
          }
        },
      })

    return Object.freeze({
      correlationId,
      describeTableRateRecorder,
      /**
       * Sanitizes and aggregates one migration observation.
       *
       * @param observation - Candidate runtime observation.
       */
      record(observation: unknown): void {
        try {
          const event = sanitizeTelemetryObservation(observation)
          if (event !== undefined) accumulate(event)
        } catch {
          // Hostile or malformed observations are dropped without effects.
        }
      },
      bindConfigurationHash,
      /** @returns Current secret-free evidence locator. */
      readEvidenceLocator(): string | undefined {
        return evidenceLocator
      },
      snapshot,
      finalize,
    })
  } catch {
    return noOpTelemetryRecorder
  }
}

/**
 * Creates a deterministic live checkpoint-stall watchdog. The explicit
 * intentional-drain mode never reads the clock and never schedules a timer,
 * preventing planned drain intervals from producing false stall alarms.
 * Invalid inputs and dependency failures return or behave as a no-op.
 *
 * @param input - Strict watchdog construction value.
 * @returns Best-effort progress and stop surface.
 */
export function createWorkspaceSearchMigrationCheckpointStallWatchdog(
  input: unknown,
): WorkspaceSearchMigrationCheckpointStallWatchdog {
  try {
    const record = snapshotStrictDataRecord(input)
    if (
      record === undefined ||
      !hasOnlyAllowedKeys(record, [
        'clock',
        'mode',
        'phase',
        'recorder',
        'schedule',
        'stallAfterMilliseconds',
        'version',
      ]) ||
      !record.has('mode') ||
      !record.has('phase') ||
      !record.has('recorder') ||
      !record.has('version') ||
      record.get('version') !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    ) {
      return noOpCheckpointStallWatchdog
    }
    const mode = record.get('mode')
    const phase = record.get('phase')
    const recorder = readTelemetryRecordFunction(record.get('recorder'))
    const clock = readOptionalNumberSource(record, 'clock', Date.now)
    const schedule = readOptionalCheckpointStallSchedule(
      record,
      'schedule',
      scheduleDefaultCheckpointStall,
    )
    const configuredThreshold = record.get('stallAfterMilliseconds')
    const stallAfterMilliseconds = configuredThreshold === undefined
      ? WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS
      : configuredThreshold
    if (
      !isCheckpointStallWatchdogMode(mode) ||
      !isTelemetryPhase(phase) ||
      recorder === undefined ||
      clock === undefined ||
      schedule === undefined ||
      !isPositiveSafeInteger(stallAfterMilliseconds) ||
      stallAfterMilliseconds > 86_400_000
    ) {
      return noOpCheckpointStallWatchdog
    }
    const validatedMode = mode
    const validatedPhase = phase
    const validatedRecorder = recorder
    const validatedClock = clock
    const validatedSchedule = schedule
    const validatedStallAfterMilliseconds = stallAfterMilliseconds

    let cancellation:
      WorkspaceSearchMigrationCheckpointStallCancellation | undefined
    let lastProgressAtMilliseconds: number | undefined
    let stopped = false
    let stalled = false
    let paused = false
    let scheduleGeneration = 0
    let admittedScheduleGeneration: number | undefined

    /** Cancels the currently armed one-shot callback. */
    const cancelCurrent = (): void => {
      const selectedCancellation = cancellation
      cancellation = undefined
      admittedScheduleGeneration = undefined
      scheduleGeneration += 1
      if (selectedCancellation === undefined) return
      try {
        selectedCancellation()
      } catch {
        // Watchdog cancellation is best-effort telemetry work.
      }
    }

    /** Arms one bounded live-monitoring callback. */
    const arm = (delayMilliseconds: number): void => {
      if (
        validatedMode !== 'monitor-progress' ||
        stopped ||
        stalled ||
        paused
      ) return
      cancelCurrent()
      const selectedGeneration = scheduleGeneration
      try {
        const candidate = validatedSchedule(
          delayMilliseconds,
          () => onElapsed(selectedGeneration),
        )
        if (
          typeof candidate === 'function' &&
          !nodeUtilTypes.isProxy(candidate)
        ) {
          cancellation = candidate
          admittedScheduleGeneration = selectedGeneration
        }
      } catch {
        cancellation = undefined
        admittedScheduleGeneration = undefined
      }
    }

    /**
     * Evaluates one admitted scheduled stall boundary against the clock.
     *
     * @param selectedGeneration - Generation captured by this callback.
     */
    function onElapsed(selectedGeneration: number): void {
      if (admittedScheduleGeneration !== selectedGeneration) return
      cancellation = undefined
      admittedScheduleGeneration = undefined
      if (
        validatedMode !== 'monitor-progress' ||
        stopped ||
        stalled ||
        paused ||
        lastProgressAtMilliseconds === undefined
      ) {
        return
      }
      try {
        const now = validatedClock()
        if (
          !isNonNegativeSafeInteger(now) ||
          now < lastProgressAtMilliseconds
        ) {
          return
        }
        const elapsed = now - lastProgressAtMilliseconds
        if (elapsed < validatedStallAfterMilliseconds) {
          arm(validatedStallAfterMilliseconds - elapsed)
          return
        }
        stalled = true
        validatedRecorder({
          version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
          kind: 'checkpoint-stall',
          phase: validatedPhase,
          stalledForMilliseconds: elapsed,
        })
      } catch {
        // A watchdog observer must never alter migration work.
      }
    }

    if (validatedMode === 'monitor-progress') {
      try {
        const initialNow = validatedClock()
        if (isNonNegativeSafeInteger(initialNow)) {
          lastProgressAtMilliseconds = initialNow
          arm(validatedStallAfterMilliseconds)
        }
      } catch {
        // A failed telemetry clock leaves the watchdog safely unarmed.
      }
    }

    return Object.freeze({
      /**
       * Records durable progress and rearms live checkpoint monitoring.
       *
       * @param progressUnits - Positive bounded progress units.
       */
      recordProgress(progressUnits: number): void {
        try {
          if (stopped || !isPositiveTelemetryNumber(progressUnits)) return
          validatedRecorder({
            version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
            kind: 'checkpoint-progress',
            phase: validatedPhase,
            progressUnits,
          })
          if (validatedMode !== 'monitor-progress' || paused) return
          const now = validatedClock()
          if (
            !isNonNegativeSafeInteger(now) ||
            (
              lastProgressAtMilliseconds !== undefined &&
              now < lastProgressAtMilliseconds
            )
          ) {
            return
          }
          lastProgressAtMilliseconds = now
          stalled = false
          arm(validatedStallAfterMilliseconds)
        } catch {
          // Watchdog telemetry must never alter checkpoint progress.
        }
      },
      /** Pauses live checkpoint timing. */
      pause(): void {
        if (
          validatedMode !== 'monitor-progress' ||
          stopped ||
          paused
        ) return
        paused = true
        cancelCurrent()
      },
      /** Resumes live checkpoint timing from a fresh baseline. */
      resume(): void {
        if (
          validatedMode !== 'monitor-progress' ||
          stopped ||
          !paused
        ) return
        try {
          const now = validatedClock()
          if (!isNonNegativeSafeInteger(now)) return
          lastProgressAtMilliseconds = now
          paused = false
          stalled = false
          arm(validatedStallAfterMilliseconds)
        } catch {
          // A failed resume clock leaves the watchdog safely paused.
        }
      },
      /** Permanently stops live checkpoint timing. */
      stop(): void {
        if (stopped) return
        stopped = true
        cancelCurrent()
      },
    })
  } catch {
    return noOpCheckpointStallWatchdog
  }
}

/**
 * Reads one recorder's own data method without invoking an accessor.
 *
 * @param value - Candidate telemetry recorder.
 * @returns Detached record function or undefined.
 */
function readTelemetryRecordFunction(
  value: unknown,
): ((observation: unknown) => void) | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'record')
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'function' ||
      nodeUtilTypes.isProxy(descriptor.value)
    ) {
      return undefined
    }
    const candidate = descriptor.value
    return (observation) => {
      const result: unknown = Reflect.apply(
        candidate,
        undefined,
        [observation],
      )
      if (result !== undefined) consumeTelemetryNativePromise(result)
    }
  } catch {
    return undefined
  }
}

/**
 * Schedules one default one-shot watchdog callback.
 *
 * @param delayMilliseconds - Positive bounded delay.
 * @param callback - Watchdog reevaluation callback.
 * @returns Best-effort timeout cancellation.
 */
function scheduleDefaultCheckpointStall(
  delayMilliseconds: number,
  callback: () => void,
): WorkspaceSearchMigrationCheckpointStallCancellation {
  const timeout = setTimeout(callback, delayMilliseconds)
  timeout.unref?.()
  return () => clearTimeout(timeout)
}

/**
 * Creates the default monotonically increasing process-local sequence source.
 *
 * @returns Fresh sequence closure starting at one.
 */
function createDefaultSequence(): WorkspaceSearchMigrationTelemetrySequence {
  let current = 0
  return () => {
    if (current >= Number.MAX_SAFE_INTEGER) return 0
    current += 1
    return current
  }
}

/**
 * Creates exactly sixteen process-random bytes as lowercase hexadecimal text.
 *
 * @returns Opaque process-generated correlation material.
 */
function createDefaultCorrelation(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Writes one serialized telemetry record to standard output.
 *
 * @param serializedRecord - Secret-free single-line JSON.
 */
function writeStandardOutput(serializedRecord: string): void {
  console.log(serializedRecord)
}

/**
 * Validates and snapshots one strict telemetry context.
 *
 * @param context - Candidate invocation bindings.
 * @returns Detached validated primitives or undefined.
 */
function validateTelemetryContext(
  context: unknown,
): ValidatedWorkspaceSearchMigrationTelemetryContext | undefined {
  const record = snapshotStrictDataRecord(context)
  if (
    record === undefined ||
    !hasExactKeys(record, [
      'operation',
      'policyVersion',
      'version',
    ]) ||
    record.get('version') !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
  ) {
    return undefined
  }
  const operation = record.get('operation')
  const policyVersion = record.get('policyVersion')
  if (
    !isTelemetryOperation(operation) ||
    !isHexDigest(policyVersion)
  ) {
    return undefined
  }
  return Object.freeze({
    operation,
    policyVersion,
  })
}

/**
 * Validates one exact terminal finalization record.
 *
 * @param finalization - Candidate final invocation metadata.
 * @returns Detached validated primitives or undefined.
 */
function validateTelemetryFinalization(
  finalization: unknown,
): ValidatedWorkspaceSearchMigrationTelemetryFinalization | undefined {
  const record = snapshotStrictDataRecord(finalization)
  if (
    record === undefined ||
    !hasExactKeys(record, ['outcome', 'phase', 'version']) ||
    record.get('version') !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
  ) {
    return undefined
  }
  const phase = record.get('phase')
  const outcome = record.get('outcome')
  if (!isTelemetryPhase(phase) || !isTelemetryFinalOutcome(outcome)) {
    return undefined
  }
  return Object.freeze({ phase, outcome })
}

/**
 * Validates and snapshots optional recorder dependencies without accessors.
 *
 * @param dependencies - Candidate trusted test/runtime ports.
 * @returns Detached callable ports or undefined.
 */
function validateTelemetryDependencies(
  dependencies: unknown,
): ValidatedWorkspaceSearchMigrationTelemetryDependencies | undefined {
  const sequence = createDefaultSequence()
  if (dependencies === undefined) {
    return Object.freeze({
      clock: Date.now,
      sequence,
      correlationSource: createDefaultCorrelation,
      sink: writeStandardOutput,
      liveSink: undefined,
    })
  }
  const record = snapshotStrictDataRecord(dependencies)
  if (
    record === undefined ||
    !hasOnlyAllowedKeys(record, [
      'clock',
      'correlationSource',
      'liveSink',
      'sequence',
      'sink',
    ])
  ) {
    return undefined
  }
  const clock = readOptionalNumberSource(record, 'clock', Date.now)
  const selectedSequence = readOptionalNumberSource(
    record,
    'sequence',
    sequence,
  )
  const correlationSource = readOptionalStringSource(
    record,
    'correlationSource',
    createDefaultCorrelation,
  )
  const sink = readOptionalTelemetrySink(
    record,
    'sink',
    writeStandardOutput,
  )
  const liveSink = record.has('liveSink')
    ? readOptionalTelemetrySink(record, 'liveSink', writeStandardOutput)
    : undefined
  if (
    clock === undefined ||
    selectedSequence === undefined ||
    correlationSource === undefined ||
    sink === undefined ||
    (record.has('liveSink') && liveSink === undefined)
  ) {
    return undefined
  }
  return Object.freeze({
    clock,
    sequence: selectedSequence,
    correlationSource,
    sink,
    liveSink,
  })
}

/**
 * Reads one optional zero-argument numeric source without an assertion.
 *
 * @param record - Descriptor-snapshotted record.
 * @param key - Optional dependency key.
 * @param fallback - Trusted default when the key is absent.
 * @returns Validated wrapper or undefined for a hostile callable.
 */
function readOptionalNumberSource(
  record: ReadonlyMap<string, unknown>,
  key: string,
  fallback: WorkspaceSearchMigrationTelemetryClock,
): WorkspaceSearchMigrationTelemetryClock | undefined {
  if (!record.has(key)) return fallback
  const candidate = record.get(key)
  if (
    typeof candidate !== 'function' ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    return undefined
  }
  return () => {
    const result: unknown = Reflect.apply(candidate, undefined, [])
    if (consumeTelemetryNativePromise(result)) return Number.NaN
    return typeof result === 'number' ? result : Number.NaN
  }
}

/**
 * Reads one optional zero-argument string source without an assertion.
 *
 * @param record - Descriptor-snapshotted record.
 * @param key - Optional dependency key.
 * @param fallback - Trusted default when the key is absent.
 * @returns Validated wrapper or undefined for a hostile callable.
 */
function readOptionalStringSource(
  record: ReadonlyMap<string, unknown>,
  key: string,
  fallback: WorkspaceSearchMigrationTelemetryCorrelationSource,
): WorkspaceSearchMigrationTelemetryCorrelationSource | undefined {
  if (!record.has(key)) return fallback
  const candidate = record.get(key)
  if (
    typeof candidate !== 'function' ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    return undefined
  }
  return () => {
    const result: unknown = Reflect.apply(candidate, undefined, [])
    if (consumeTelemetryNativePromise(result)) return ''
    return typeof result === 'string' ? result : ''
  }
}

/**
 * Reads one optional synchronous telemetry sink without an assertion.
 *
 * @param record - Descriptor-snapshotted record.
 * @param key - Optional dependency key.
 * @param fallback - Trusted default when the key is absent.
 * @returns Validated wrapper or undefined for a hostile callable.
 */
function readOptionalTelemetrySink(
  record: ReadonlyMap<string, unknown>,
  key: string,
  fallback: WorkspaceSearchMigrationTelemetrySink,
): WorkspaceSearchMigrationTelemetrySink | undefined {
  if (!record.has(key)) return fallback
  const candidate = record.get(key)
  if (
    typeof candidate !== 'function' ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    return undefined
  }
  return (serializedRecord) => {
    const result: unknown = Reflect.apply(
      candidate,
      undefined,
      [serializedRecord],
    )
    if (result !== undefined) {
      consumeTelemetryNativePromise(result)
      throw new Error('Telemetry sinks must complete synchronously.')
    }
  }
}

/**
 * Reads one optional checkpoint scheduler without an assertion.
 *
 * @param record - Descriptor-snapshotted record.
 * @param key - Optional dependency key.
 * @param fallback - Trusted default when the key is absent.
 * @returns Validated wrapper or undefined for a hostile callable.
 */
function readOptionalCheckpointStallSchedule(
  record: ReadonlyMap<string, unknown>,
  key: string,
  fallback: WorkspaceSearchMigrationCheckpointStallSchedule,
): WorkspaceSearchMigrationCheckpointStallSchedule | undefined {
  if (!record.has(key)) return fallback
  const candidate = record.get(key)
  if (
    typeof candidate !== 'function' ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    return undefined
  }
  return (delayMilliseconds, callback) => {
    const result: unknown = Reflect.apply(candidate, undefined, [
      delayMilliseconds,
      callback,
    ])
    if (consumeTelemetryNativePromise(result)) {
      throw new Error('Invalid checkpoint-stall scheduler.')
    }
    if (
      typeof result !== 'function' ||
      nodeUtilTypes.isProxy(result)
    ) {
      throw new Error('Invalid checkpoint-stall scheduler.')
    }
    return () => {
      const cancellationResult: unknown = Reflect.apply(
        result,
        undefined,
        [],
      )
      if (cancellationResult !== undefined) {
        consumeTelemetryNativePromise(cancellationResult)
        throw new Error('Invalid checkpoint-stall cancellation.')
      }
    }
  }
}

/**
 * Consumes an exact native Promise returned across a synchronous telemetry port.
 * Opaque objects, Proxies, and thenables are never inspected; callers reject
 * them according to the exact synchronous dependency contract.
 *
 * @param value - Runtime return from an injected synchronous dependency.
 * @returns Whether the value was an exact native Promise.
 */
function consumeTelemetryNativePromise(value: unknown): boolean {
  if (
    !nodeUtilTypes.isPromise(value) ||
    Object.getPrototypeOf(value) !== Promise.prototype ||
    Object.hasOwn(value, 'constructor')
  ) {
    return false
  }
  void Reflect.apply(Promise.prototype.then, value, [
    undefined,
    () => undefined,
  ])
  return true
}

/**
 * Sanitizes one general migration telemetry observation.
 *
 * @param observation - Runtime value at the telemetry boundary.
 * @returns Fixed safe event or undefined for invalid input.
 */
function sanitizeTelemetryObservation(
  observation: unknown,
): SanitizedWorkspaceSearchMigrationTelemetryEvent | undefined {
  const record = snapshotStrictDataRecord(observation)
  if (record === undefined) return undefined
  const kind = record.get('kind')
  if (kind === 'checkpoint-progress') {
    if (
      !hasExactKeys(record, [
        'kind',
        'phase',
        'progressUnits',
        'version',
      ]) ||
      record.get('version') !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    ) {
      return undefined
    }
    const phase = record.get('phase')
    const progressUnits = record.get('progressUnits')
    if (
      !isTelemetryPhase(phase) ||
      !isPositiveTelemetryNumber(progressUnits)
    ) {
      return undefined
    }
    return Object.freeze({
      trigger: 'checkpoint-progress',
      phase,
      outcome: 'progress',
      metrics: Object.freeze([
        createMetric('CheckpointProgressCount', 'Count', 1),
        createMetric('CheckpointProgressUnits', 'None', progressUnits),
      ]),
    })
  }
  if (kind === 'checkpoint-stall') {
    if (
      !hasExactKeys(record, [
        'kind',
        'phase',
        'stalledForMilliseconds',
        'version',
      ]) ||
      record.get('version') !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    ) {
      return undefined
    }
    const phase = record.get('phase')
    const stalledForMilliseconds = record.get('stalledForMilliseconds')
    if (
      !isTelemetryPhase(phase) ||
      !isPositiveTelemetryNumber(stalledForMilliseconds)
    ) {
      return undefined
    }
    return Object.freeze({
      trigger: 'checkpoint-stall',
      phase,
      outcome: 'stalled',
      metrics: Object.freeze([
        createMetric('CheckpointStallCount', 'Count', 1),
        createMetric(
          'CheckpointStallMilliseconds',
          'Milliseconds',
          stalledForMilliseconds,
        ),
      ]),
    })
  }
  if (kind === 'quarantine') {
    if (
      !hasExactKeys(record, [
        'kind',
        'phase',
        'reason',
        'version',
      ]) ||
      record.get('version') !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    ) {
      return undefined
    }
    const phase = record.get('phase')
    const reason = record.get('reason')
    if (!isTelemetryPhase(phase) || !isQuarantineReason(reason)) {
      return undefined
    }
    return Object.freeze({
      trigger: 'quarantine',
      phase,
      outcome: 'quarantined',
      reason,
      metrics: Object.freeze([
        createMetric('QuarantineCount', 'Count', 1),
      ]),
    })
  }
  if (kind === 'terminal-failure') {
    if (
      !hasExactKeys(record, [
        'kind',
        'phase',
        'reason',
        'version',
      ]) ||
      record.get('version') !== WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION
    ) {
      return undefined
    }
    const phase = record.get('phase')
    const reason = record.get('reason')
    if (
      !isTelemetryPhase(phase) ||
      !isTerminalFailureReason(reason)
    ) {
      return undefined
    }
    return Object.freeze({
      trigger: 'terminal-failure',
      phase,
      outcome: 'failed',
      reason,
      metrics: Object.freeze([
        createMetric('TerminalFailureCount', 'Count', 1),
      ]),
    })
  }
  return undefined
}

/**
 * Sanitizes one #158 DescribeTable rate observation.
 *
 * @param observation - Runtime rate observation.
 * @returns Fixed safe event or undefined for invalid input.
 */
function sanitizeDescribeTableRateObservation(
  observation: unknown,
): SanitizedWorkspaceSearchMigrationTelemetryEvent | undefined {
  const record = snapshotStrictDataRecord(observation)
  if (record === undefined) return undefined
  const kind = record.get('kind')
  if (kind === 'attempt') return sanitizeDescribeTableAttempt(record)
  if (kind === 'throttle') return sanitizeDescribeTableThrottle(record)
  if (kind === 'budget-stop') {
    return sanitizeDescribeTableBudgetStop(record)
  }
  if (kind === 'cadence-wait') {
    return sanitizeDescribeTableCadenceWait(record)
  }
  return undefined
}

/**
 * Sanitizes one #158 physical-attempt observation.
 *
 * @param record - Descriptor-snapshotted rate observation.
 * @returns Fixed attempt event or undefined.
 */
function sanitizeDescribeTableAttempt(
  record: ReadonlyMap<string, unknown>,
): SanitizedWorkspaceSearchMigrationTelemetryEvent | undefined {
  if (
    !hasExactKeys(record, [
      'inFlight',
      'kind',
      'observedAtMilliseconds',
      'phase',
      'remainingNormalAdmissionAttempts',
      'remainingPageAttempts',
      'remainingWindowAttempts',
      'sequence',
      'version',
    ]) ||
    record.get('version') !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION ||
    record.get('inFlight') !== 1 ||
    !isPositiveSafeInteger(record.get('sequence')) ||
    !isNonNegativeSafeInteger(record.get('observedAtMilliseconds')) ||
    !isNonNegativeSafeInteger(
      record.get('remainingNormalAdmissionAttempts'),
    ) ||
    !isNonNegativeSafeInteger(record.get('remainingPageAttempts')) ||
    !isNonNegativeSafeInteger(record.get('remainingWindowAttempts'))
  ) {
    return undefined
  }
  const phase = record.get('phase')
  if (!isDescribeTablePhase(phase)) return undefined
  return Object.freeze({
    trigger: 'describe-table-attempt',
    phase,
    outcome: 'started',
    metrics: Object.freeze([
      createMetric('DescribeTableAttemptCount', 'Count', 1),
    ]),
  })
}

/**
 * Sanitizes one #158 throttle observation.
 *
 * @param record - Descriptor-snapshotted rate observation.
 * @returns Fixed throttle event or undefined.
 */
function sanitizeDescribeTableThrottle(
  record: ReadonlyMap<string, unknown>,
): SanitizedWorkspaceSearchMigrationTelemetryEvent | undefined {
  if (
    !hasExactKeys(record, [
      'backoffMilliseconds',
      'kind',
      'observedAtMilliseconds',
      'phase',
      'provenance',
      'sequence',
      'version',
    ]) ||
    record.get('version') !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION ||
    !isPositiveSafeInteger(record.get('sequence')) ||
    !isNonNegativeSafeInteger(record.get('observedAtMilliseconds')) ||
    !isNonNegativeSafeInteger(record.get('backoffMilliseconds')) ||
    !isDescribeTableThrottleProvenance(record.get('provenance'))
  ) {
    return undefined
  }
  const phase = record.get('phase')
  const backoffMilliseconds = record.get('backoffMilliseconds')
  if (
    !isDescribeTablePhase(phase) ||
    !isNonNegativeSafeInteger(backoffMilliseconds)
  ) {
    return undefined
  }
  return Object.freeze({
    trigger: 'describe-table-throttle',
    phase,
    outcome: 'throttled',
    metrics: Object.freeze([
      createMetric('DescribeTableThrottleCount', 'Count', 1),
      createMetric(
        'DescribeTableThrottleBackoffMilliseconds',
        'Milliseconds',
        backoffMilliseconds,
      ),
    ]),
  })
}

/**
 * Sanitizes one #158 budget-stop observation.
 *
 * @param record - Descriptor-snapshotted rate observation.
 * @returns Fixed budget-stop event or undefined.
 */
function sanitizeDescribeTableBudgetStop(
  record: ReadonlyMap<string, unknown>,
): SanitizedWorkspaceSearchMigrationTelemetryEvent | undefined {
  if (
    !hasExactKeys(record, [
      'kind',
      'observedAtMilliseconds',
      'phase',
      'provenance',
      'reason',
      'remainingNormalAdmissionAttempts',
      'remainingWindowAttempts',
      'requiredAttempts',
      'retryAfterMilliseconds',
      'version',
    ]) ||
    record.get('version') !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION ||
    !isNonNegativeSafeInteger(record.get('observedAtMilliseconds')) ||
    !isNonNegativeSafeInteger(record.get('requiredAttempts')) ||
    !isNonNegativeSafeInteger(
      record.get('remainingNormalAdmissionAttempts'),
    ) ||
    !isNonNegativeSafeInteger(record.get('remainingWindowAttempts')) ||
    !isNonNegativeSafeInteger(record.get('retryAfterMilliseconds'))
  ) {
    return undefined
  }
  const phase = record.get('phase')
  const reason = record.get('reason')
  const provenance = record.get('provenance')
  if (
    !isDescribeTablePhase(phase) ||
    !isDescribeTableStopReason(reason) ||
    !isDescribeTableBudgetStopProvenance(reason, provenance)
  ) {
    return undefined
  }
  const metrics: WorkspaceSearchMigrationTelemetryMetricDatum[] = [
    createMetric('DescribeTableBudgetStopCount', 'Count', 1),
  ]
  if (reason === 'budget-capacity' || reason === 'page-capacity') {
    metrics.push(
      createMetric('DescribeTableBudgetExhaustionCount', 'Count', 1),
    )
  }
  if (reason === 'quarantined') {
    metrics.push(createMetric('QuarantineCount', 'Count', 1))
  }
  return Object.freeze({
    trigger: 'describe-table-budget-stop',
    phase,
    outcome: 'stopped',
    reason,
    metrics: Object.freeze(metrics),
  })
}

/**
 * Sanitizes one #158 cadence-wait observation.
 *
 * @param record - Descriptor-snapshotted rate observation.
 * @returns Fixed wait event or undefined.
 */
function sanitizeDescribeTableCadenceWait(
  record: ReadonlyMap<string, unknown>,
): SanitizedWorkspaceSearchMigrationTelemetryEvent | undefined {
  if (
    !hasExactKeys(record, [
      'delayMilliseconds',
      'kind',
      'observedAtMilliseconds',
      'phase',
      'version',
    ]) ||
    record.get('version') !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION ||
    !isNonNegativeSafeInteger(record.get('observedAtMilliseconds')) ||
    !isPositiveSafeInteger(record.get('delayMilliseconds'))
  ) {
    return undefined
  }
  const phase = record.get('phase')
  const delayMilliseconds = record.get('delayMilliseconds')
  if (
    !isDescribeTablePhase(phase) ||
    !isPositiveSafeInteger(delayMilliseconds)
  ) {
    return undefined
  }
  return Object.freeze({
    trigger: 'describe-table-cadence-wait',
    phase,
    outcome: 'waiting',
    metrics: Object.freeze([
      createMetric('DescribeTableCadenceWaitCount', 'Count', 1),
      createMetric(
        'DescribeTableCadenceWaitMilliseconds',
        'Milliseconds',
        delayMilliseconds,
      ),
    ]),
  })
}

/**
 * Creates one frozen finite metric datum.
 *
 * @param name - Fixed metric name.
 * @param unit - Fixed metric unit.
 * @param value - Validated non-negative value.
 * @returns Immutable metric datum.
 */
function createMetric(
  name: WorkspaceSearchMigrationTelemetryMetricName,
  unit: WorkspaceSearchMigrationTelemetryMetricUnit,
  value: number,
): WorkspaceSearchMigrationTelemetryMetricDatum {
  return Object.freeze({ name, unit, value })
}

/**
 * Inputs shared by bound and unbound detached aggregate snapshots.
 */
type CreateTelemetrySnapshotInputBase = {
  /** Mutable internal aggregate copied into a frozen snapshot. */
  readonly aggregate: ReadonlyMap<
    WorkspaceSearchMigrationTelemetryMetricName,
    number
  >
  /** Process-generated opaque correlation. */
  readonly correlationId: string
  /** Bound or unbound policy-scoped secret-free evidence locator. */
  readonly evidenceLocator: string
  /** Number of accepted observations. */
  readonly observationCount: number
  /** Most recent accepted trigger. */
  readonly lastTrigger: WorkspaceSearchMigrationTelemetrySnapshot['lastTrigger']
  /** Most recent accepted bounded reason. */
  readonly lastReason: WorkspaceSearchMigrationTelemetrySnapshot['lastReason']
}

/**
 * Configuration-consistent input for one detached aggregate snapshot.
 */
type CreateTelemetrySnapshotInput = CreateTelemetrySnapshotInputBase & (
  | {
    /** Indicates that the invocation installed a reviewed correlation digest. */
    readonly configurationBinding: 'bound'
    /** Reviewed locator digest, not proof of a fresh runtime match. */
    readonly configurationHash: string
  }
  | {
    /** Indicates that no reviewed resource digest has been bound yet. */
    readonly configurationBinding: 'unbound'
    /** Prevents unbound inputs from carrying a configuration digest. */
    readonly configurationHash?: never
  }
)

/**
 * Creates one frozen detached aggregate with every alarm metric present.
 *
 * @param input - Current safe recorder state.
 * @returns Frozen aggregate snapshot.
 */
function createTelemetrySnapshot(
  input: CreateTelemetrySnapshotInput,
): WorkspaceSearchMigrationTelemetrySnapshot {
  const metrics = Object.freeze({
    CheckpointProgressCount:
      readMetricAggregate(input.aggregate, 'CheckpointProgressCount'),
    CheckpointProgressUnits:
      readMetricAggregate(input.aggregate, 'CheckpointProgressUnits'),
    CheckpointStallCount:
      readMetricAggregate(input.aggregate, 'CheckpointStallCount'),
    CheckpointStallMilliseconds:
      readMetricAggregate(input.aggregate, 'CheckpointStallMilliseconds'),
    DescribeTableAttemptCount:
      readMetricAggregate(input.aggregate, 'DescribeTableAttemptCount'),
    DescribeTableBudgetExhaustionCount: readMetricAggregate(
      input.aggregate,
      'DescribeTableBudgetExhaustionCount',
    ),
    DescribeTableBudgetStopCount:
      readMetricAggregate(input.aggregate, 'DescribeTableBudgetStopCount'),
    DescribeTableCadenceWaitCount:
      readMetricAggregate(input.aggregate, 'DescribeTableCadenceWaitCount'),
    DescribeTableCadenceWaitMilliseconds: readMetricAggregate(
      input.aggregate,
      'DescribeTableCadenceWaitMilliseconds',
    ),
    DescribeTableThrottleBackoffMilliseconds: readMetricAggregate(
      input.aggregate,
      'DescribeTableThrottleBackoffMilliseconds',
    ),
    DescribeTableThrottleCount:
      readMetricAggregate(input.aggregate, 'DescribeTableThrottleCount'),
    OperationCount:
      readMetricAggregate(input.aggregate, 'OperationCount'),
    QuarantineCount:
      readMetricAggregate(input.aggregate, 'QuarantineCount'),
    TerminalFailureCount:
      readMetricAggregate(input.aggregate, 'TerminalFailureCount'),
  })
  const sharedSnapshot: WorkspaceSearchMigrationTelemetrySnapshotBase = {
    version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
    correlationId: input.correlationId,
    evidenceLocator: input.evidenceLocator,
    observationCount: input.observationCount,
    lastTrigger: input.lastTrigger,
    lastReason: input.lastReason,
    metrics,
  }
  if (input.configurationBinding === 'unbound') {
    return Object.freeze({
      ...sharedSnapshot,
      configurationBinding: 'unbound',
    })
  }
  return Object.freeze({
    ...sharedSnapshot,
    configurationBinding: 'bound',
    configurationHash: input.configurationHash,
  })
}

/**
 * Creates one zero-initialized aggregate over the complete metric schema.
 *
 * @returns Mutable recorder-private aggregate.
 */
function createZeroMetricAggregate(): Map<
  WorkspaceSearchMigrationTelemetryMetricName,
  number
> {
  const aggregate = new Map<
    WorkspaceSearchMigrationTelemetryMetricName,
    number
  >()
  for (const definition of telemetryMetricDefinitions) {
    aggregate.set(definition.name, 0)
  }
  return aggregate
}

/**
 * Accumulates one validated metric using its fixed schema behavior.
 *
 * @param aggregate - Recorder-private metric aggregate.
 * @param metric - Validated event metric.
 */
function accumulateMetric(
  aggregate: Map<WorkspaceSearchMigrationTelemetryMetricName, number>,
  metric: WorkspaceSearchMigrationTelemetryMetricDatum,
): void {
  const current = readMetricAggregate(aggregate, metric.name)
  const definition = telemetryMetricDefinitions.find(
    (candidate) => candidate.name === metric.name,
  )
  if (definition === undefined) return
  aggregate.set(
    metric.name,
    definition.aggregation === 'maximum'
      ? Math.max(current, metric.value)
      : boundedAdd(current, metric.value),
  )
}

/**
 * Reads one initialized aggregate value.
 *
 * @param aggregate - Current aggregate.
 * @param name - Fixed metric name.
 * @returns Non-negative bounded value.
 */
function readMetricAggregate(
  aggregate: ReadonlyMap<
    WorkspaceSearchMigrationTelemetryMetricName,
    number
  >,
  name: WorkspaceSearchMigrationTelemetryMetricName,
): number {
  return aggregate.get(name) ?? 0
}

/**
 * Adds two non-negative values without exceeding the safe integer bound.
 *
 * @param left - Current aggregate.
 * @param right - Positive increment.
 * @returns Saturating safe aggregate.
 */
function boundedAdd(left: number, right: number): number {
  return Math.min(maximumTelemetryNumericValue, left + right)
}

/**
 * Inputs required to serialize one immediate bound checkpoint-stall event.
 */
type SerializeLiveCheckpointStallInput = {
  /** Validated recorder context. */
  readonly context: ValidatedWorkspaceSearchMigrationTelemetryContext
  /** Sanitized checkpoint-stall event. */
  readonly event: SanitizedWorkspaceSearchMigrationTelemetryEvent
  /** Reviewed bound resource-configuration digest. */
  readonly configurationHash: string
  /** Process-generated opaque correlation. */
  readonly correlationId: string
  /** Bound configuration-and-policy evidence locator. */
  readonly evidenceLocator: string
  /** Validated process-local timestamp and sequence. */
  readonly metadata: WorkspaceSearchMigrationTelemetryProcessMetadata
}

/**
 * Serializes one immediate bound checkpoint-stall EMF event.
 *
 * @param input - Bound context, fixed stall event, and process metadata.
 * @returns Strict secret-free Service-only EMF JSON.
 */
function serializeLiveCheckpointStall(
  input: SerializeLiveCheckpointStallInput,
): string {
  const stallCount = input.event.metrics.find(
    (metric) => metric.name === 'CheckpointStallCount',
  )?.value ?? 0
  const stalledForMilliseconds = input.event.metrics.find(
    (metric) => metric.name === 'CheckpointStallMilliseconds',
  )?.value ?? 0
  return JSON.stringify({
    _aws: {
      Timestamp: input.metadata.observedAtMilliseconds,
      CloudWatchMetrics: [{
        Namespace: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
        Dimensions: [['Service']],
        Metrics: [
          { Name: 'CheckpointStallCount', Unit: 'Count' },
          {
            Name: 'CheckpointStallMilliseconds',
            Unit: 'Milliseconds',
          },
        ],
      }],
    },
    schemaVersion: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
    event: 'workspace-search-migration.checkpoint-stall',
    service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
    Service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
    operation: input.context.operation,
    phase: input.event.phase,
    outcome: 'stalled',
    configurationBinding: 'bound',
    configurationHash: input.configurationHash,
    policyVersion: input.context.policyVersion,
    correlationId: input.correlationId,
    evidenceLocator: input.evidenceLocator,
    observedAtMilliseconds: input.metadata.observedAtMilliseconds,
    sequence: input.metadata.sequence,
    CheckpointStallCount: stallCount,
    CheckpointStallMilliseconds: stalledForMilliseconds,
  })
}

/**
 * Inputs required to serialize one finalized telemetry aggregate.
 */
type SerializeTelemetryAggregateInput = {
  /** Validated recorder context. */
  readonly context: ValidatedWorkspaceSearchMigrationTelemetryContext
  /** Validated terminal phase and outcome. */
  readonly finalization: ValidatedWorkspaceSearchMigrationTelemetryFinalization
  /** Detached zero-complete metric aggregate. */
  readonly snapshot: WorkspaceSearchMigrationTelemetrySnapshot
  /** Process-generated opaque correlation. */
  readonly correlationId: string
  /** Configuration-and-policy-only evidence locator. */
  readonly evidenceLocator: string
  /** Validated Unix-epoch millisecond timestamp. */
  readonly observedAtMilliseconds: number
  /** Strictly increasing process-local event sequence. */
  readonly sequence: number
}

/**
 * Serializes one strict zero-complete CloudWatch EMF aggregate.
 *
 * @param input - Validated context, finalization, aggregate, and metadata.
 * @returns Deterministic single-line JSON.
 */
function serializeTelemetryAggregate(
  input: SerializeTelemetryAggregateInput,
): string {
  const metricDefinitions = telemetryMetricDefinitions.map((metric) => ({
    Name: metric.name,
    Unit: metric.unit,
  }))
  return JSON.stringify({
    _aws: {
      Timestamp: input.observedAtMilliseconds,
      CloudWatchMetrics: [{
        Namespace: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
        Dimensions: [['Service']],
        Metrics: metricDefinitions,
      }],
    },
    schemaVersion: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
    event: 'workspace-search-migration.finalized',
    service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
    Service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
    operation: input.context.operation,
    phase: input.finalization.phase,
    outcome: input.finalization.outcome,
    lastTrigger: input.snapshot.lastTrigger,
    ...(input.snapshot.lastReason === undefined
      ? {}
      : { lastReason: input.snapshot.lastReason }),
    configurationBinding: input.snapshot.configurationBinding,
    ...(input.snapshot.configurationHash === undefined
      ? {}
      : { configurationHash: input.snapshot.configurationHash }),
    policyVersion: input.context.policyVersion,
    correlationId: input.correlationId,
    evidenceLocator: input.evidenceLocator,
    observedAtMilliseconds: input.observedAtMilliseconds,
    sequence: input.sequence,
    observationCount: input.snapshot.observationCount,
    ...input.snapshot.metrics,
  })
}

/**
 * Derives a non-path evidence locator from only reviewed digest bindings.
 *
 * @param configurationHash - Reviewed resource-configuration digest.
 * @param policyVersion - Reviewed rate-policy digest.
 * @returns Stable opaque evidence locator.
 */
function createEvidenceLocator(
  configurationHash: string,
  policyVersion: string,
): string {
  const digest = createHash('sha256')
    .update('workspace-search-migration-evidence-v1\0')
    .update(configurationHash)
    .update('\0')
    .update(policyVersion)
    .digest('hex')
  return `${evidenceLocatorPrefix}${digest}`
}

/**
 * Derives an unbound locator from only reviewed policy and opaque correlation.
 *
 * @param policyVersion - Reviewed rate-policy digest.
 * @param correlationId - Process-generated opaque correlation.
 * @returns Secret-free locator without a fabricated configuration digest.
 */
function createUnboundEvidenceLocator(
  policyVersion: string,
  correlationId: string,
): string {
  const digest = createHash('sha256')
    .update('workspace-search-migration-unbound-evidence-v1\0')
    .update(policyVersion)
    .update('\0')
    .update(correlationId)
    .digest('hex')
  return `${unboundEvidenceLocatorPrefix}${digest}`
}

/**
 * Snapshots an exact plain own-data record without invoking accessors.
 *
 * @param value - Candidate runtime record.
 * @returns Detached key/value map or undefined for hostile data.
 */
function snapshotStrictDataRecord(
  value: unknown,
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return undefined
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined
    }
    const keys = Reflect.ownKeys(value)
    const snapshot = new Map<string, unknown>()
    for (const key of keys) {
      if (typeof key !== 'string') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return undefined
      }
      snapshot.set(key, descriptor.value)
    }
    return snapshot
  } catch {
    return undefined
  }
}

/**
 * Checks an exact key set in a descriptor-snapshotted record.
 *
 * @param record - Snapshotted data record.
 * @param expected - Exact allowed and required keys.
 * @returns Whether every and only expected key is present.
 */
function hasExactKeys(
  record: ReadonlyMap<string, unknown>,
  expected: readonly string[],
): boolean {
  if (record.size !== expected.length) return false
  return expected.every((key) => record.has(key))
}

/**
 * Checks a subset of allowed keys in a descriptor-snapshotted record.
 *
 * @param record - Snapshotted data record.
 * @param allowed - Complete allowed key set.
 * @returns Whether every present key is allowed.
 */
function hasOnlyAllowedKeys(
  record: ReadonlyMap<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed)
  return [...record.keys()].every((key) => allowedKeys.has(key))
}

/**
 * Checks one finite telemetry operation.
 *
 * @param value - Candidate operation.
 * @returns Whether the operation is admitted.
 */
function isTelemetryOperation(
  value: unknown,
): value is WorkspaceSearchMigrationTelemetryOperation {
  return typeof value === 'string' && telemetryOperations.has(value)
}

/**
 * Checks one finite telemetry phase.
 *
 * @param value - Candidate phase.
 * @returns Whether the phase is admitted.
 */
function isTelemetryPhase(
  value: unknown,
): value is WorkspaceSearchMigrationTelemetryPhase {
  return typeof value === 'string' && telemetryPhases.has(value)
}

/**
 * Checks one finite final invocation outcome.
 *
 * @param value - Candidate outcome.
 * @returns Whether the outcome is admitted by the finalizer.
 */
function isTelemetryFinalOutcome(
  value: unknown,
): value is WorkspaceSearchMigrationTelemetryFinalOutcome {
  return typeof value === 'string' && telemetryFinalOutcomes.has(value)
}

/**
 * Checks one explicit checkpoint-watchdog mode.
 *
 * @param value - Candidate mode.
 * @returns Whether live monitoring or intentional drain was selected.
 */
function isCheckpointStallWatchdogMode(
  value: unknown,
): value is WorkspaceSearchMigrationCheckpointStallWatchdogMode {
  return value === 'intentional-drain' || value === 'monitor-progress'
}

/**
 * Checks one finite #158 DescribeTable phase.
 *
 * @param value - Candidate phase.
 * @returns Whether the phase is admitted by both contracts.
 */
function isDescribeTablePhase(
  value: unknown,
): value is WorkspaceSearchMigrationDescribeTablePhase {
  return typeof value === 'string' &&
    Object.hasOwn(describeTablePhaseCatalog, value)
}

/**
 * Checks one finite #158 budget-stop reason.
 *
 * @param value - Candidate reason.
 * @returns Whether the reason is admitted.
 */
function isDescribeTableStopReason(
  value: unknown,
): value is WorkspaceSearchMigrationDescribeTableRateStopReason {
  return typeof value === 'string' &&
    Object.hasOwn(describeTableStopReasonCatalog, value)
}

/**
 * Checks one finite source of a classified DescribeTable throttle.
 *
 * @param value - Candidate source value.
 * @returns Whether the source is one of the two controller-owned values.
 */
function isDescribeTableThrottleProvenance(
  value: unknown,
): value is WorkspaceSearchMigrationDescribeTableThrottleProvenance {
  return value === 'aws-service' ||
    value === 'rehearsal-after-success-injection'
}

/**
 * Checks that one budget-stop source agrees with its classified reason.
 *
 * @param reason - Already validated budget-stop reason.
 * @param provenance - Candidate source value.
 * @returns Whether the reason and source form one admitted pair.
 */
function isDescribeTableBudgetStopProvenance(
  reason: WorkspaceSearchMigrationDescribeTableRateStopReason,
  provenance: unknown,
): provenance is WorkspaceSearchMigrationDescribeTableBudgetStopProvenance {
  if (reason !== 'throttled') return provenance === 'operational'
  return provenance === 'aws-service-throttle' ||
    provenance === 'rehearsal-after-success-injection'
}

/**
 * Checks one finite quarantine classification.
 *
 * @param value - Candidate reason.
 * @returns Whether the reason is admitted.
 */
function isQuarantineReason(
  value: unknown,
): value is WorkspaceSearchMigrationTelemetryQuarantineReason {
  return typeof value === 'string' && quarantineReasons.has(value)
}

/**
 * Checks one finite terminal failure classification.
 *
 * @param value - Candidate reason.
 * @returns Whether the reason is admitted.
 */
function isTerminalFailureReason(
  value: unknown,
): value is WorkspaceSearchMigrationTelemetryTerminalFailureReason {
  return typeof value === 'string' && terminalFailureReasons.has(value)
}

/**
 * Checks one positive safe integer.
 *
 * @param value - Candidate number.
 * @returns Whether the number is positive and safe.
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

/**
 * Checks one non-negative safe integer.
 *
 * @param value - Candidate number.
 * @returns Whether the number is non-negative and safe.
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

/**
 * Checks one positive bounded telemetry number.
 *
 * @param value - Candidate number.
 * @returns Whether the value is finite, positive, and bounded.
 */
function isPositiveTelemetryNumber(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= maximumTelemetryNumericValue
}
