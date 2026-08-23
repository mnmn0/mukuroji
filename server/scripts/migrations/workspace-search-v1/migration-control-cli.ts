import {
  constants as fileSystemConstants,
  type BigIntStats,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { types as nodeUtilTypes } from 'node:util'
import {
  advanceWorkspaceSearchMigrationControlStage,
  readWorkspaceSearchMigrationControlExecutionStatus,
  workspaceSearchMigrationControlApprovalLiterals,
  type WorkspaceSearchMigrationControlCoordinatorInput,
  type WorkspaceSearchMigrationControlCoordinatorSummary,
} from './migration-control-coordinator'
import {
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationDescribeTableRateEvidence,
  WorkspaceSearchMigrationDescribeTableRateObservation,
  WorkspaceSearchMigrationDescribeTableRatePolicy,
  WorkspaceSearchMigrationDescribeTableRateRecorder,
} from './migration-describe-table-rate-budget'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
  WorkspaceSearchMigrationDescribeTableRatePolicyError,
} from './migration-describe-table-rate-policy'
import {
  createAwsWorkspaceSearchMigrationRateManagedSession,
  type CreateAwsWorkspaceSearchMigrationRateManagedSessionInput,
  type WorkspaceSearchMigrationRateManagedAwsSession,
} from './migration-identity-aws'
import {
  validateWorkspaceSearchMigrationRequestedResources,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  createWorkspaceSearchMigrationFileEvidenceProvider,
  WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
} from './migration-maintenance-evidence-provider'
import {
  runWithWorkspaceSearchMigrationHeartbeat,
  WorkspaceSearchMigrationHeartbeatInterruptedError,
  type WorkspaceSearchMigrationHeartbeatPort,
} from './migration-heartbeat-supervisor'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
} from './maintenance-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES,
} from './migration-artifacts'
import type {
  WorkspaceSearchMigrationExecutionStatus,
} from './migration-execution-supervisor'
import type {
  WorkspaceSearchMigrationMaintenanceEvidenceProvider,
} from './migration-post-close-planning-supervisor'
import type {
  WorkspaceSearchMigrationPlanningJoinLimits,
} from './migration-planning-material'
import type {
  RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanAuthorityClaim,
} from './migration-pre-plan-authority-aws'
import type {
  AcquireWorkspaceSearchMigrationLeaseInput,
} from './migration-state-machine'
import type {
  WorkspaceSearchWriterFenceObservation,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
  type WorkspaceSearchMigrationTelemetryContext,
  type WorkspaceSearchMigrationTelemetryFinalOutcome,
  type WorkspaceSearchMigrationTelemetryOperation,
  type WorkspaceSearchMigrationTelemetryPhase,
  type WorkspaceSearchMigrationTelemetryRecorder,
  type WorkspaceSearchMigrationTelemetrySink,
  type WorkspaceSearchMigrationTelemetryTerminalFailureReason,
} from './migration-telemetry'

const initialBootstrapApproval = 'initial-writer-fence-bootstrap'

const resourceFlagNames = [
  '--account',
  '--region',
  '--profile',
  '--commit',
  '--project-directory-table',
  '--work-items-table',
  '--collaboration-table',
  '--documents-table',
  '--workspace-search-table',
  '--migration-state-table',
  '--journal-bucket',
  '--journal-key-arn',
]

const commonReadFlagNames = [
  ...resourceFlagNames,
  '--rate-policy-file',
  '--rate-bootstrap',
  '--rate-recover-interrupted-cleanup',
  '--rate-recover-interrupted-attempt',
]
const measureFlagNames = new Set<string>(commonReadFlagNames)
const statusFlagNames = new Set<string>([
  ...commonReadFlagNames,
  '--expected-configuration-hash',
])
const executionStatusFlagNames = new Set<string>([
  ...statusFlagNames,
  '--run-id',
])
const commonMutationFlagNames = [
  ...statusFlagNames,
  '--run-id',
  '--owner-id',
  '--maintenance-evidence-file',
  '--approval',
]
const bootstrapFlagNames = new Set<string>(commonMutationFlagNames)
const stageFlagNames = new Set<string>(commonMutationFlagNames)
const closeReplanFlagNames = new Set<string>([
  ...commonMutationFlagNames,
  '--reviewed-dry-run-file',
  '--retain-until',
  '--max-total-rows',
  '--max-total-canonical-item-bytes',
  '--max-plan-operations',
])

const helpPayload = {
  schemaVersion: 1,
  status: 'help',
  commands: [
    'measure',
    'status',
    'execution-status',
    'bootstrap-open',
    'close-replan',
    'apply',
    'verify',
    'rollback-partial',
    'rollback-complete',
    'release',
  ],
  requiredForEveryNonHelpCommand: [
    ...resourceFlagNames,
    '--rate-policy-file',
  ],
  requiredForExpectedStateReads: [
    '--expected-configuration-hash',
  ],
  requiredForExecutionStatus: [
    '--expected-configuration-hash',
    '--run-id',
  ],
  requiredForMutations: [
    '--expected-configuration-hash',
    '--run-id',
    '--owner-id',
    '--maintenance-evidence-file',
    '--approval',
  ],
  requiredForCloseReplan: [
    '--reviewed-dry-run-file',
    '--retain-until',
    '--max-total-rows',
    '--max-total-canonical-item-bytes',
    '--max-plan-operations',
  ],
  optionalExactRateLifecycleFlags: {
    '--rate-bootstrap': 'true',
    '--rate-recover-interrupted-cleanup': 'true',
    '--rate-recover-interrupted-attempt': 'true',
  },
  rateLifecycleRule:
    'bootstrap is exclusive; cleanup and attempt recovery may be combined',
  mutationApprovals: {
    'bootstrap-open': initialBootstrapApproval,
    ...workspaceSearchMigrationControlApprovalLiterals,
  },
}

/** Stable operation labels that never contain untrusted argument text. */
type WorkspaceSearchMigrationControlCliOperation =
  | 'apply'
  | 'bootstrap-open'
  | 'close-replan'
  | 'execution-status'
  | 'help'
  | 'measure'
  | 'release'
  | 'rollback-complete'
  | 'rollback-partial'
  | 'status'
  | 'unknown'
  | 'verify'

/** Stable CLI-only failures safe to emit as one JSON line. */
type WorkspaceSearchMigrationControlCliFailureCode =
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INTERRUPTED'
  | 'INVALID_DESCRIBE_TABLE_RATE_POLICY'
  | 'INVALID_USAGE'
  | 'MAINTENANCE_EVIDENCE_PROVIDER_FAILED'
  | 'OPERATION_FAILED'

/** Process exit statuses used by the migration control CLI. */
export type WorkspaceSearchMigrationControlCliExitCode = 0 | 1 | 2 | 130

/** Classified raw-value-free top-level failure. */
type ClassifiedControlCliFailure = {
  /** Stable CLI or migration failure code. */
  readonly code:
    | WorkspaceSearchMigrationControlCliFailureCode
    | WorkspaceSearchMigrationFailureCode
  /** Process exit status for the failure. */
  readonly exitCode: WorkspaceSearchMigrationControlCliExitCode
}

/** Common explicit resource and rate-policy selection. */
type WorkspaceSearchMigrationControlCliCommonArguments = {
  /** Complete explicit physical resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Exact reviewed DescribeTable rate-policy file path. */
  readonly ratePolicyFile: string
  /** Whether this invocation may explicitly create an absent rate ledger. */
  readonly rateBootstrap: boolean
  /** Whether this invocation may recover an interrupted cleanup boundary. */
  readonly rateRecoverInterruptedCleanup: boolean
  /** Whether this invocation may recover an interrupted physical attempt. */
  readonly rateRecoverInterruptedAttempt: boolean
}

/** Read-only identity-measurement command. */
export type WorkspaceSearchMigrationMeasureCliArguments =
  WorkspaceSearchMigrationControlCliCommonArguments & {
    /** Selected command. */
    readonly command: 'measure'
  }

/** Read-only writer-fence status command. */
export type WorkspaceSearchMigrationStatusCliArguments =
  WorkspaceSearchMigrationControlCliCommonArguments & {
    /** Selected command. */
    readonly command: 'status'
    /** Reviewed digest of the exact measured resource incarnation. */
    readonly expectedConfigurationHash: string
  }

/** Read-only durable execution-status command. */
export type WorkspaceSearchMigrationExecutionStatusCliArguments =
  WorkspaceSearchMigrationControlCliCommonArguments & {
    /** Selected command. */
    readonly command: 'execution-status'
    /** Reviewed digest of the exact measured resource incarnation. */
    readonly expectedConfigurationHash: string
    /** Exact durable migration run to inspect. */
    readonly runId: string
  }

/** Common explicit authorization for every mutating command. */
type WorkspaceSearchMigrationControlCliMutationArguments =
  WorkspaceSearchMigrationControlCliCommonArguments & {
    /** Reviewed digest of the exact measured resource incarnation. */
    readonly expectedConfigurationHash: string
    /** Exact maintenance-evidence file reread by the operation. */
    readonly maintenanceEvidenceFile: string
    /** Process-unique lease owner identifier. */
    readonly ownerId: string
    /** Operator-selected durable migration run identifier. */
    readonly runId: string
  }

/** Explicit initial writer-fence and rate-ledger bootstrap command. */
export type WorkspaceSearchMigrationBootstrapOpenCliArguments =
  WorkspaceSearchMigrationControlCliMutationArguments & {
    /** Exact approval phrase for this initial-only capability. */
    readonly approval: typeof initialBootstrapApproval
    /** Selected command. */
    readonly command: 'bootstrap-open'
  }

/** Explicit close, drain, and post-close replan command. */
export type WorkspaceSearchMigrationCloseReplanCliArguments =
  WorkspaceSearchMigrationControlCliMutationArguments & {
    /** Exact stage-specific approval phrase. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals['close-replan']
    /** Selected command. */
    readonly command: 'close-replan'
    /** Positive safe in-memory planning join limits. */
    readonly planningJoinLimits: WorkspaceSearchMigrationPlanningJoinLimits
    /** Exact canonical reviewed dry-run artifact file path. */
    readonly reviewedDryRunFile: string
    /** Canonical immutable artifact retention deadline. */
    readonly retainUntil: string
  }

/** Explicit apply command. */
export type WorkspaceSearchMigrationApplyCliArguments =
  WorkspaceSearchMigrationControlCliMutationArguments & {
    /** Exact stage-specific approval phrase. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals.apply
    /** Selected command. */
    readonly command: 'apply'
  }

/** Explicit verification command. */
export type WorkspaceSearchMigrationVerifyCliArguments =
  WorkspaceSearchMigrationControlCliMutationArguments & {
    /** Exact stage-specific approval phrase. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals.verify
    /** Selected command. */
    readonly command: 'verify'
  }

/** Explicit committed-prefix rollback command. */
export type WorkspaceSearchMigrationPartialRollbackCliArguments =
  WorkspaceSearchMigrationControlCliMutationArguments & {
    /** Exact stage-specific approval phrase. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals[
        'rollback-partial'
      ]
    /** Selected command. */
    readonly command: 'rollback-partial'
  }

/** Explicit complete-root rollback command. */
export type WorkspaceSearchMigrationCompleteRollbackCliArguments =
  WorkspaceSearchMigrationControlCliMutationArguments & {
    /** Exact stage-specific approval phrase. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals[
        'rollback-complete'
      ]
    /** Selected command. */
    readonly command: 'rollback-complete'
  }

/** Explicit terminal writer-fence release command. */
export type WorkspaceSearchMigrationReleaseCliArguments =
  WorkspaceSearchMigrationControlCliMutationArguments & {
    /** Exact stage-specific approval phrase. */
    readonly approval:
      typeof workspaceSearchMigrationControlApprovalLiterals.release
    /** Selected command. */
    readonly command: 'release'
  }

/** Machine-readable help command. */
export type WorkspaceSearchMigrationControlHelpCliArguments = {
  /** Selected command. */
  readonly command: 'help'
}

/** Every explicit coordinator-backed mutation. */
type WorkspaceSearchMigrationCoordinatorCliArguments =
  | WorkspaceSearchMigrationApplyCliArguments
  | WorkspaceSearchMigrationCloseReplanCliArguments
  | WorkspaceSearchMigrationCompleteRollbackCliArguments
  | WorkspaceSearchMigrationPartialRollbackCliArguments
  | WorkspaceSearchMigrationReleaseCliArguments
  | WorkspaceSearchMigrationVerifyCliArguments

/** Strictly parsed migration control CLI arguments. */
export type WorkspaceSearchMigrationControlCliArguments =
  | WorkspaceSearchMigrationBootstrapOpenCliArguments
  | WorkspaceSearchMigrationControlHelpCliArguments
  | WorkspaceSearchMigrationExecutionStatusCliArguments
  | WorkspaceSearchMigrationMeasureCliArguments
  | WorkspaceSearchMigrationCoordinatorCliArguments
  | WorkspaceSearchMigrationStatusCliArguments

/** Safe writer-fence state emitted without physical resource identifiers. */
export type WorkspaceSearchMigrationWriterFenceSummary =
  | {
      /** No row exists for the measured state and dataset incarnation. */
      readonly status: 'missing'
    }
  | {
      /** A strict durable writer-fence row exists. */
      readonly status: 'present'
      /** Whether guarded application mutations are admitted. */
      readonly mode: 'closed' | 'open'
      /** Monotonic writer epoch. */
      readonly writerEpoch: number
      /** Monotonic control-row revision. */
      readonly controlRevision: number
      /** Digest of the exact canonical durable record. */
      readonly recordDigest: string
    }

/** Successful initial writer-fence bootstrap payload. */
export type WorkspaceSearchMigrationControlCliBootstrapMutationResult = {
  /** Stable output schema version. */
  readonly schemaVersion: 1
  /** Exact bootstrap operation. */
  readonly operation: 'bootstrap-open'
  /** Mandatory successful result. */
  readonly status: 'pass'
  /** Fresh measured configuration digest. */
  readonly configurationHash: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly policyVersion: string
  /** Safe durable writer-fence projection. */
  readonly writerFence: WorkspaceSearchMigrationWriterFenceSummary
  /** Identifier-free actual DescribeTable aggregate. */
  readonly rateAggregate: WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Successful explicitly selected coordinator-stage payload. */
export type WorkspaceSearchMigrationControlCliCoordinatorMutationResult = {
  /** Stable output schema version. */
  readonly schemaVersion: 1
  /** Exact explicitly selected coordinator operation. */
  readonly operation: WorkspaceSearchMigrationCoordinatorCliArguments['command']
  /** Mandatory successful result. */
  readonly status: 'pass'
  /** Reviewed measured configuration digest. */
  readonly configurationHash: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly policyVersion: string
  /** Trusted in-memory exact coordinator result. */
  readonly coordinator: WorkspaceSearchMigrationControlCoordinatorSummary
  /** Identifier-free actual DescribeTable aggregate. */
  readonly rateAggregate: WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Every successful mutating control result returned by the CLI boundary. */
type WorkspaceSearchMigrationControlCliMutationResult =
  | WorkspaceSearchMigrationControlCliBootstrapMutationResult
  | WorkspaceSearchMigrationControlCliCoordinatorMutationResult

/** Capability-minimized read-only session used by three status commands. */
export interface WorkspaceSearchMigrationControlCliReadSession {
  /**
   * Measures the complete resource identity.
   *
   * @returns Reviewed configuration hash.
   */
  measureConfigurationHash(): Promise<string>

  /**
   * Strongly reads the measured writer-fence state.
   *
   * @returns Safe detached writer-fence summary.
   */
  readWriterFence(): Promise<WorkspaceSearchMigrationWriterFenceSummary>

  /**
   * Reconstructs one durable execution status without a lease.
   *
   * @param runId - Exact durable run identifier.
   * @param expectedConfigurationHash - Reviewed configuration binding.
   * @returns Secret-free durable execution status.
   */
  readExecutionStatus(
    runId: string,
    expectedConfigurationHash: string,
  ): Promise<WorkspaceSearchMigrationExecutionStatus>

  /**
   * Reads the identifier-free durable DescribeTable rate aggregate.
   *
   * @returns Current conservative rate evidence.
   */
  readRateAggregate(): WorkspaceSearchMigrationDescribeTableRateEvidence

  /** Immediately stops every not-yet-started rate-managed operation. */
  interrupt(): void

  /**
   * Releases every resource retained by this read-only session.
   *
   * @returns Optional asynchronous drainage completion.
   */
  close(): Promise<void> | void
}

/** Coordinator request with its concrete managed session withheld. */
type WorkspaceSearchMigrationControlCliStageRequest =
  WorkspaceSearchMigrationControlCoordinatorInput extends infer Input
    ? Input extends { readonly session: unknown }
      ? Omit<Input, 'session'>
      : never
    : never

/** Capability-minimized session used only by explicitly mutating commands. */
export interface WorkspaceSearchMigrationControlCliMutationSession
  extends WorkspaceSearchMigrationHeartbeatPort {
  /**
   * Measures the complete resource identity.
   *
   * @returns Reviewed configuration hash.
   */
  measureConfigurationHash(): Promise<string>

  /**
   * Acquires or recovers one exact global lease.
   *
   * @param input - Operator-selected run and process owner.
   * @returns Exact durable lease.
   */
  acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease>

  /**
   * Renews one immutable maintenance receipt under an active lease.
   *
   * @param input - Exact lease, pointer predecessor, and evidence bytes.
   * @returns Current durable pre-plan authority.
   */
  renewMaintenanceEvidence(
    input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>

  /**
   * Strongly refreshes one exact lease, pointer, and receipt tuple.
   *
   * @param claim - Exact current authority claim.
   * @returns Fresh current authority.
   */
  readAuthority(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>

  /**
   * Performs the initial missing-to-open transition.
   *
   * @param authority - Fresh lease and maintenance evidence authority.
   * @returns Exact durable open-row summary.
   */
  bootstrapWriterFence(
    authority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchMigrationWriterFenceSummary>

  /**
   * Advances exactly one explicitly selected coordinator stage.
   *
   * @param input - Stage request without a caller-accessible managed session.
   * @returns Secret-free coordinator summary.
   */
  advanceStage(
    input: WorkspaceSearchMigrationControlCliStageRequest,
  ): Promise<WorkspaceSearchMigrationControlCoordinatorSummary>

  /**
   * Creates a fresh file-backed provider sharing this session's rate gate.
   *
   * @param maintenanceEvidenceFile - Private evidence file path.
   * @returns Repeated fresh evidence provider with subordinate measurements.
   */
  createMaintenanceEvidenceProvider(
    maintenanceEvidenceFile: string,
  ): WorkspaceSearchMigrationMaintenanceEvidenceProvider

  /**
   * Reads the identifier-free durable DescribeTable rate aggregate.
   *
   * @returns Current conservative rate evidence.
   */
  readRateAggregate(): WorkspaceSearchMigrationDescribeTableRateEvidence

  /**
   * Installs one synchronous heartbeat assertion for nested data mutations.
   *
   * @param guard - Exact lease and commit-headroom assertion.
   * @param task - Supervised coordinator operation.
   * @returns Exact coordinator result.
   */
  runWithMutationAdmissionGuard<Result>(
    guard: () => void,
    task: () => Promise<Result>,
  ): Promise<Result>

  /** Stops admission of every not-yet-started AWS data mutation. */
  interruptMutationAdmission(): void

  /** Immediately stops every not-yet-started rate-managed operation. */
  interrupt(): void

  /**
   * Releases every resource retained by this mutating session.
   *
   * @returns Optional asynchronous drainage completion.
   */
  close(): Promise<void> | void
}

/** Input to one read-only rate-managed session factory. */
export type CreateWorkspaceSearchMigrationControlCliReadSessionInput = {
  /** Complete explicit physical resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Strict reviewed DescribeTable policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Whether this invocation may explicitly create an absent rate ledger. */
  readonly rateBootstrap: boolean
  /** Whether this invocation may recover an interrupted cleanup boundary. */
  readonly rateRecoverInterruptedCleanup: boolean
  /** Whether this invocation may recover an interrupted physical attempt. */
  readonly rateRecoverInterruptedAttempt: boolean
  /** Optional #158 rate events collected by migration telemetry. */
  readonly rateRecorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
  /** Optional best-effort migration telemetry observer. */
  readonly telemetryRecorder?: WorkspaceSearchMigrationTelemetryRecorder
  /** Optional cooperative cancellation propagated through initial rate claim. */
  readonly signal?: AbortSignal
}

/** Input to one explicitly mutating rate-managed session factory. */
export type CreateWorkspaceSearchMigrationControlCliMutationSessionInput =
  CreateWorkspaceSearchMigrationControlCliReadSessionInput

/** Injectable factories used by the top-level CLI boundary. */
export type WorkspaceSearchMigrationControlCliDependencies = {
  /** Creates a capability-minimized read-only rate-managed session. */
  readonly createReadSession: (
    input: CreateWorkspaceSearchMigrationControlCliReadSessionInput,
  ) => Promise<WorkspaceSearchMigrationControlCliReadSession>
  /** Creates a capability-minimized explicitly mutating rate-managed session. */
  readonly createMutationSession: (
    input: CreateWorkspaceSearchMigrationControlCliMutationSessionInput,
  ) => Promise<WorkspaceSearchMigrationControlCliMutationSession>
  /** Reads one finite regular input file without following content into logs. */
  readonly readInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Creates an optional trusted recorder with synchronous method returns. */
  readonly createTelemetryRecorder?: (
    context: WorkspaceSearchMigrationTelemetryContext,
    sink: WorkspaceSearchMigrationTelemetrySink,
  ) => WorkspaceSearchMigrationTelemetryRecorder
}

/**
 * Constructor for one production-equivalent rate-managed AWS session.
 *
 * @param input - Existing production session-construction input.
 * @returns Fresh complete managed session for private projection.
 */
export type WorkspaceSearchMigrationControlCliRateManagedSessionConstructor = (
  input: CreateAwsWorkspaceSearchMigrationRateManagedSessionInput,
) => Promise<WorkspaceSearchMigrationRateManagedAwsSession>

/** Input for the bounded control-CLI dependency factory. */
export type CreateWorkspaceSearchMigrationControlCliDependenciesInput = {
  /** Exact trusted managed-session constructor captured by the factory. */
  readonly createRateManagedSession:
    WorkspaceSearchMigrationControlCliRateManagedSessionConstructor
}

/** Capability-minimized dependencies retained by a read-only command. */
type WorkspaceSearchMigrationControlCliReadDependencies = Pick<
  WorkspaceSearchMigrationControlCliDependencies,
  'createReadSession' | 'createTelemetryRecorder'
>

/** Capability-minimized dependencies retained by a mutating command. */
type WorkspaceSearchMigrationControlCliMutationDependencies = Pick<
  WorkspaceSearchMigrationControlCliDependencies,
  | 'createMutationSession'
  | 'createTelemetryRecorder'
  | 'readInputFile'
>

/** File and read-session capabilities captured before the first CLI await. */
type WorkspaceSearchMigrationControlCliCapturedReadDependencies =
  WorkspaceSearchMigrationControlCliReadDependencies &
  Pick<WorkspaceSearchMigrationControlCliDependencies, 'readInputFile'>

/** File and mutation-session capabilities captured before the first CLI await. */
type WorkspaceSearchMigrationControlCliCapturedMutationDependencies =
  WorkspaceSearchMigrationControlCliMutationDependencies

/** One invocation-local recorder and its captured serialized EMF output. */
type WorkspaceSearchMigrationControlCliTelemetryInvocation = {
  /** Best-effort recorder shared with rate and migration boundaries. */
  readonly recorder: WorkspaceSearchMigrationTelemetryRecorder
  /** Reads the only valid serialized EMF record produced at finalization. */
  readonly readSerializedRecord: () => string | undefined
}

/** Result of one initial writer-fence bootstrap. */
type BootstrapOpenResult = {
  /** Exact durable open writer-fence state. */
  readonly writerFence: WorkspaceSearchMigrationWriterFenceSummary
}

/** Safe CLI failure with a stable code and process status. */
class WorkspaceSearchMigrationControlCliFailure extends Error {
  /** Stable raw-value-free failure code. */
  readonly code: WorkspaceSearchMigrationControlCliFailureCode

  /** Process exit status for the failure. */
  readonly exitCode: WorkspaceSearchMigrationControlCliExitCode

  /**
   * Creates one safe CLI failure.
   *
   * @param code - Stable CLI category.
   * @param exitCode - Process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationControlCliFailureCode,
    exitCode: WorkspaceSearchMigrationControlCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationControlCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/**
 * Creates the standard control-CLI dependencies over one captured session constructor.
 *
 * The constructor is accepted only as an own data property on a plain input
 * object. Proxy and accessor-backed inputs are rejected without invoking their
 * traps. Returned dependencies preserve the production file, telemetry, and
 * capability projections; no managed session or transport is exposed.
 *
 * @param input - Trusted constructor selected before CLI execution begins.
 * @returns Frozen dependencies with isolated read and mutation factories.
 */
export function createWorkspaceSearchMigrationControlCliDependencies(
  input: CreateWorkspaceSearchMigrationControlCliDependenciesInput,
): WorkspaceSearchMigrationControlCliDependencies {
  const createRateManagedSession =
    captureControlCliRateManagedSessionConstructor(input)
  return Object.freeze({
    /** Creates the existing read-only projection over one fresh session. */
    createReadSession: async (sessionInput) =>
      await createProjectedControlCliReadSession(
        sessionInput,
        createRateManagedSession,
      ),
    /** Creates the existing mutation projection over one fresh session. */
    createMutationSession: async (sessionInput) =>
      await createProjectedControlCliMutationSession(
        sessionInput,
        createRateManagedSession,
      ),
    /** Retains the existing strict bounded regular-file reader. */
    readInputFile: readBoundedInputFile,
    /** Retains production telemetry serialization and live stall output. */
    createTelemetryRecorder: (context, sink) =>
      createWorkspaceSearchMigrationTelemetryRecorder(
        context,
        {
          /** Captures finalized telemetry for the CLI's terminal stdout/stderr line. */
          sink,
          /** Writes only an immediate checkpoint-stall line while work is hung. */
          liveSink: (serializedRecord: string) =>
            console.error(serializedRecord),
        },
      ),
  })
}

const defaultControlCliDependencies:
  WorkspaceSearchMigrationControlCliDependencies =
    createWorkspaceSearchMigrationControlCliDependencies({
      createRateManagedSession:
        createAwsWorkspaceSearchMigrationRateManagedSession,
    })

/**
 * Captures one exact constructor without invoking input accessors or Proxy traps.
 *
 * @param input - Potentially hostile programmatic factory input.
 * @returns Trusted constructor detached from its input object.
 */
function captureControlCliRateManagedSessionConstructor(
  input: CreateWorkspaceSearchMigrationControlCliDependenciesInput,
): WorkspaceSearchMigrationControlCliRateManagedSessionConstructor {
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeUtilTypes.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 1
  ) {
    throw invalidControlCliSessionConstructor()
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    input,
    'createRateManagedSession',
  )
  const candidate: unknown = descriptor?.value
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    !isControlCliRateManagedSessionConstructor(candidate)
  ) {
    throw invalidControlCliSessionConstructor()
  }
  return candidate
}

/**
 * Narrows one value to a direct non-Proxy managed-session constructor.
 *
 * @param value - Candidate own data-property value.
 * @returns Whether the value is callable without a Proxy apply trap.
 */
function isControlCliRateManagedSessionConstructor(
  value: unknown,
): value is WorkspaceSearchMigrationControlCliRateManagedSessionConstructor {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/** Creates one stable programmatic factory-input failure. */
function invalidControlCliSessionConstructor(): TypeError {
  return new TypeError(
    'Workspace Search migration control CLI session constructor is invalid.',
  )
}

/**
 * Parses strict subcommands and explicit flags without ambient defaults.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Validated command configuration.
 */
export function parseWorkspaceSearchMigrationControlCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationControlCliArguments {
  const command = arguments_[0]
  if (command === 'help' || command === '--help') {
    if (arguments_.length !== 1) throw invalidUsage()
    return { command: 'help' }
  }
  if (command === 'measure') {
    const flags = parseFlagPairs(arguments_.slice(1), measureFlagNames)
    return {
      command,
      ...parseCommonArguments(flags),
    }
  }
  if (command === 'status') {
    const flags = parseFlagPairs(arguments_.slice(1), statusFlagNames)
    return {
      command,
      ...parseCommonArguments(flags),
      expectedConfigurationHash: requireConfigurationHash(flags),
    }
  }
  if (command === 'execution-status') {
    const flags = parseFlagPairs(
      arguments_.slice(1),
      executionStatusFlagNames,
    )
    return {
      command,
      ...parseCommonArguments(flags),
      expectedConfigurationHash: requireConfigurationHash(flags),
      runId: requireMigrationIdentifier(flags, '--run-id'),
    }
  }
  if (command === 'bootstrap-open') {
    const flags = parseFlagPairs(arguments_.slice(1), bootstrapFlagNames)
    return {
      command,
      ...parseMutationArguments(flags),
      approval: requireExactApproval(flags, initialBootstrapApproval),
    }
  }
  if (command === 'close-replan') {
    const flags = parseFlagPairs(arguments_.slice(1), closeReplanFlagNames)
    return {
      command,
      ...parseMutationArguments(flags),
      approval: requireExactApproval(
        flags,
        workspaceSearchMigrationControlApprovalLiterals['close-replan'],
      ),
      planningJoinLimits: {
        maxTotalRows: requirePositiveSafeInteger(
          flags,
          '--max-total-rows',
        ),
        maxTotalCanonicalItemBytes: requirePositiveSafeInteger(
          flags,
          '--max-total-canonical-item-bytes',
        ),
        maxPlanOperations: requirePositiveSafeInteger(
          flags,
          '--max-plan-operations',
        ),
      },
      reviewedDryRunFile: requireSafePath(
        flags,
        '--reviewed-dry-run-file',
      ),
      retainUntil: requireCanonicalTimestamp(flags, '--retain-until'),
    }
  }
  if (isCoordinatorStageCommand(command)) {
    const flags = parseFlagPairs(arguments_.slice(1), stageFlagNames)
    return parseCoordinatorStageArguments(command, flags)
  }
  throw invalidUsage()
}

/**
 * Executes the operator CLI and emits exactly one deterministic JSON line.
 *
 * @param arguments_ - Arguments following the script path.
 * @param dependencies - Injectable file and capability-minimized factories.
 * @param signal - Optional cooperative operator-interruption signal.
 * @returns Stable process exit status.
 */
export async function runWorkspaceSearchMigrationControlCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationControlCliDependencies =
      defaultControlCliDependencies,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationControlCliExitCode> {
  let operation: WorkspaceSearchMigrationControlCliOperation = 'unknown'
  let telemetry:
    WorkspaceSearchMigrationControlCliTelemetryInvocation | undefined
  try {
    const argumentsSnapshot = snapshotControlCliArguments(arguments_)
    operation = identifyOperation(argumentsSnapshot[0])
    const configuration =
      parseWorkspaceSearchMigrationControlCliArguments(argumentsSnapshot)
    if (configuration.command === 'help') {
      writeJsonLine(console.log, helpPayload)
      return 0
    }
    requireNotInterrupted(signal)
    let result: unknown
    if (isReadOnlyCommand(configuration)) {
      const capturedDependencies =
        snapshotControlCliReadDependencies(dependencies)
      const ratePolicy = await readControlCliRatePolicy(
        configuration.ratePolicyFile,
        capturedDependencies,
        signal,
      )
      telemetry = createControlCliTelemetryInvocation(
        configuration.command,
        ratePolicy.policyVersion,
        capturedDependencies,
      )
      bindKnownControlCliTelemetryConfiguration(
        configuration,
        telemetry?.recorder,
      )
      result = await runReadOnlyCommand(
        configuration,
        ratePolicy,
        capturedDependencies,
        telemetry?.recorder,
        signal,
      )
    } else {
      const capturedDependencies =
        snapshotControlCliMutationDependencies(dependencies)
      const ratePolicy = await readControlCliRatePolicy(
        configuration.ratePolicyFile,
        capturedDependencies,
        signal,
      )
      telemetry = createControlCliTelemetryInvocation(
        configuration.command,
        ratePolicy.policyVersion,
        capturedDependencies,
      )
      bindKnownControlCliTelemetryConfiguration(
        configuration,
        telemetry?.recorder,
      )
      result = await runMutatingCommand(
        configuration,
        ratePolicy,
        capturedDependencies,
        telemetry?.recorder,
        signal,
      )
    }
    finalizeControlCliTelemetry(
      telemetry?.recorder,
      telemetryPhaseForOperation(operation),
      'succeeded',
    )
    const serializedOutputLine = serializeJsonLine(
      result,
      telemetry?.readSerializedRecord(),
    )
    console.log(serializedOutputLine)
    return 0
  } catch (error: unknown) {
    const failure = classifyControlCliFailure(error)
    recordControlCliTerminalFailure(
      telemetry?.recorder,
      operation,
      failure,
    )
    finalizeControlCliTelemetry(
      telemetry?.recorder,
      telemetryPhaseForOperation(operation),
      failure.code === 'INTERRUPTED' ? 'interrupted' : 'failed',
    )
    writeJsonLine(
      console.error,
      {
        schemaVersion: 1,
        operation,
        status: 'error',
        code: failure.code,
      },
      telemetry?.readSerializedRecord(),
    )
    return failure.exitCode
  }
}

/**
 * Copies and bounds every CLI argument before any parser or asynchronous read.
 *
 * @param arguments_ - Potentially accessor-backed argument collection.
 * @returns Frozen plain strings read exactly once by numeric index.
 */
function snapshotControlCliArguments(
  arguments_: readonly string[],
): readonly string[] {
  let length: number
  try {
    length = arguments_.length
  } catch {
    throw invalidUsage()
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
    throw invalidUsage()
  }
  const snapshot: string[] = []
  try {
    for (let index = 0; index < length; index += 1) {
      const value = arguments_[index]
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 8_192 ||
        value.includes('\0')
      ) {
        throw invalidUsage()
      }
      snapshot.push(value)
    }
  } catch {
    throw invalidUsage()
  }
  return Object.freeze(snapshot)
}

/**
 * Captures only read-path capabilities before the first external await.
 *
 * @param dependencies - Potentially accessor-backed injected dependencies.
 * @returns Frozen wrappers over the exact captured function identities.
 */
function snapshotControlCliReadDependencies(
  dependencies: WorkspaceSearchMigrationControlCliDependencies,
): WorkspaceSearchMigrationControlCliCapturedReadDependencies {
  let createReadSession:
    WorkspaceSearchMigrationControlCliDependencies['createReadSession']
  let createTelemetryRecorder:
    WorkspaceSearchMigrationControlCliDependencies[
      'createTelemetryRecorder'
    ]
  let readInputFile:
    WorkspaceSearchMigrationControlCliDependencies['readInputFile']
  try {
    createReadSession = dependencies.createReadSession
    createTelemetryRecorder = dependencies.createTelemetryRecorder
    readInputFile = dependencies.readInputFile
  } catch {
    throw operationFailed()
  }
  if (
    typeof createReadSession !== 'function' ||
    (
      createTelemetryRecorder !== undefined &&
      typeof createTelemetryRecorder !== 'function'
    ) ||
    typeof readInputFile !== 'function'
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    /** Invokes the captured read-session factory without retaining its owner. */
    createReadSession: (input) => createReadSession(input),
    ...(createTelemetryRecorder === undefined
      ? {}
      : {
          /** Creates one recorder through the captured trusted factory. */
          createTelemetryRecorder: (
            context: WorkspaceSearchMigrationTelemetryContext,
            sink: WorkspaceSearchMigrationTelemetrySink,
          ) =>
            createTelemetryRecorder(context, sink),
        }),
    /** Invokes the captured file reader without retaining its owner. */
    readInputFile: (path, maximumBytes) =>
      readInputFile(path, maximumBytes),
  })
}

/**
 * Captures only mutation-path capabilities before the first external await.
 *
 * @param dependencies - Potentially accessor-backed injected dependencies.
 * @returns Frozen wrappers over the exact captured function identities.
 */
function snapshotControlCliMutationDependencies(
  dependencies: WorkspaceSearchMigrationControlCliDependencies,
): WorkspaceSearchMigrationControlCliCapturedMutationDependencies {
  let createMutationSession:
    WorkspaceSearchMigrationControlCliDependencies['createMutationSession']
  let createTelemetryRecorder:
    WorkspaceSearchMigrationControlCliDependencies[
      'createTelemetryRecorder'
    ]
  let readInputFile:
    WorkspaceSearchMigrationControlCliDependencies['readInputFile']
  try {
    createMutationSession = dependencies.createMutationSession
    createTelemetryRecorder = dependencies.createTelemetryRecorder
    readInputFile = dependencies.readInputFile
  } catch {
    throw operationFailed()
  }
  if (
    typeof createMutationSession !== 'function' ||
    (
      createTelemetryRecorder !== undefined &&
      typeof createTelemetryRecorder !== 'function'
    ) ||
    typeof readInputFile !== 'function'
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    /** Invokes the captured mutation factory without retaining its owner. */
    createMutationSession: (input) => createMutationSession(input),
    ...(createTelemetryRecorder === undefined
      ? {}
      : {
          /** Creates one recorder through the captured trusted factory. */
          createTelemetryRecorder: (
            context: WorkspaceSearchMigrationTelemetryContext,
            sink: WorkspaceSearchMigrationTelemetrySink,
          ) =>
            createTelemetryRecorder(context, sink),
        }),
    /** Invokes the captured file reader without retaining its owner. */
    readInputFile: (path, maximumBytes) =>
      readInputFile(path, maximumBytes),
  })
}

/**
 * Creates one optional recorder and captures its single serialized final line.
 * Factory, recorder, and sink failures disable telemetry without changing the
 * migration command.
 *
 * @param operation - Finite non-help migration operation.
 * @param policyVersion - Reviewed DescribeTable policy digest.
 * @param dependencies - Already captured optional telemetry factory.
 * @returns Invocation-local recorder and output reader, or undefined.
 */
function createControlCliTelemetryInvocation(
  operation: WorkspaceSearchMigrationTelemetryOperation,
  policyVersion: string,
  dependencies: Pick<
    WorkspaceSearchMigrationControlCliDependencies,
    'createTelemetryRecorder'
  >,
): WorkspaceSearchMigrationControlCliTelemetryInvocation | undefined {
  const factory = dependencies.createTelemetryRecorder
  if (factory === undefined) return undefined
  const serializedRecords: string[] = []
  const sink = (serializedRecord: string): void => {
    if (
      typeof serializedRecord !== 'string' ||
      serializedRecord.length === 0 ||
      serializedRecord.length > 65_536 ||
      serializedRecord.includes('\n') ||
      serializedRecord.includes('\r')
    ) {
      serializedRecords.push('')
      return
    }
    serializedRecords.push(serializedRecord)
  }
  try {
    const candidate = factory({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      operation,
      policyVersion,
    }, sink)
    if (consumeControlCliNativePromise(candidate)) return undefined
    const recorder = createSafeControlCliTelemetryRecorder(candidate)
    if (recorder === undefined) return undefined
    return Object.freeze({
      recorder,
      readSerializedRecord: (): string | undefined =>
        serializedRecords.length === 1 && serializedRecords[0] !== ''
          ? serializedRecords[0]
          : undefined,
    })
  } catch {
    return undefined
  }
}

/**
 * Captures a failure-isolated recorder facade before retaining an observer.
 *
 * @param candidate - Recorder returned by the optional factory.
 * @returns Safe best-effort facade, or undefined for an unreadable surface.
 */
function createSafeControlCliTelemetryRecorder(
  candidate: WorkspaceSearchMigrationTelemetryRecorder,
): WorkspaceSearchMigrationTelemetryRecorder | undefined {
  if (nodeUtilTypes.isProxy(candidate)) return undefined
  let correlationId: string | undefined
  let rateRecorder: WorkspaceSearchMigrationDescribeTableRateRecorder
  let rateRecord:
    WorkspaceSearchMigrationDescribeTableRateRecorder['record']
  let bindConfigurationHash:
    WorkspaceSearchMigrationTelemetryRecorder['bindConfigurationHash']
  let finalize: WorkspaceSearchMigrationTelemetryRecorder['finalize']
  let readEvidenceLocator:
    WorkspaceSearchMigrationTelemetryRecorder['readEvidenceLocator']
  let record: WorkspaceSearchMigrationTelemetryRecorder['record']
  let snapshot: WorkspaceSearchMigrationTelemetryRecorder['snapshot']
  try {
    correlationId = candidate.correlationId
    rateRecorder = candidate.describeTableRateRecorder
    rateRecord = rateRecorder.record
    bindConfigurationHash = candidate.bindConfigurationHash
    finalize = candidate.finalize
    readEvidenceLocator = candidate.readEvidenceLocator
    record = candidate.record
    snapshot = candidate.snapshot
  } catch {
    return undefined
  }
  if (
    (
      correlationId !== undefined &&
      typeof correlationId !== 'string'
    ) ||
    typeof rateRecorder !== 'object' ||
    rateRecorder === null ||
    typeof rateRecord !== 'function' ||
    typeof bindConfigurationHash !== 'function' ||
    typeof finalize !== 'function' ||
    typeof readEvidenceLocator !== 'function' ||
    typeof record !== 'function' ||
    typeof snapshot !== 'function'
  ) {
    return undefined
  }
  const safeRateRecorder:
    WorkspaceSearchMigrationDescribeTableRateRecorder = Object.freeze({
      /**
       * Forwards one rate observation through the isolated recorder method.
       *
       * @param observation - Sanitized #158 rate observation.
       */
      record(
        observation: WorkspaceSearchMigrationDescribeTableRateObservation,
      ): void {
        try {
          const result: unknown = Reflect.apply(
            rateRecord,
            rateRecorder,
            [observation],
          )
          if (result !== undefined) {
            consumeControlCliNativePromise(result)
          }
        } catch {
          // Optional rate observation must not affect migration work.
        }
      },
    })
  return Object.freeze({
    correlationId,
    describeTableRateRecorder: safeRateRecorder,
    /**
     * Forwards one migration observation without exposing observer failures.
     *
     * @param observation - Candidate migration telemetry observation.
     */
    record(observation: unknown): void {
      try {
        const result: unknown = Reflect.apply(
          record,
          candidate,
          [observation],
        )
        if (result !== undefined) {
          consumeControlCliNativePromise(result)
        }
      } catch {
        // Optional telemetry must not affect migration work.
      }
    },
    /**
     * Forwards one reviewed configuration binding.
     *
     * @param configurationHash - Candidate reviewed digest.
     * @returns Whether the wrapped recorder accepted the binding.
     */
    bindConfigurationHash(configurationHash: unknown): boolean {
      try {
        const result: unknown = Reflect.apply(
          bindConfigurationHash,
          candidate,
          [configurationHash],
        )
        if (result === true) return true
        if (result !== false) consumeControlCliNativePromise(result)
        return false
      } catch {
        return false
      }
    },
    /** @returns Safe evidence locator from the wrapped recorder. */
    readEvidenceLocator(): string | undefined {
      try {
        const locator: unknown = Reflect.apply(
          readEvidenceLocator,
          candidate,
          [],
        )
        if (typeof locator !== 'string' && locator !== undefined) {
          consumeControlCliNativePromise(locator)
        }
        return typeof locator === 'string' ? locator : undefined
      } catch {
        return undefined
      }
    },
    /** @returns Validated detached aggregate from the wrapped recorder. */
    snapshot() {
      try {
        const result = Reflect.apply(snapshot, candidate, [])
        if (
          result !== undefined &&
          !isSafeControlCliTelemetrySnapshot(result)
        ) {
          consumeControlCliNativePromise(result)
          return undefined
        }
        return result
      } catch {
        return undefined
      }
    },
    /**
     * Forwards terminal metadata without exposing observer failures.
     *
     * @param finalization - Candidate terminal metadata.
     */
    finalize(finalization: unknown): void {
      try {
        const result: unknown = Reflect.apply(
          finalize,
          candidate,
          [finalization],
        )
        if (result !== undefined) {
          consumeControlCliNativePromise(result)
        }
      } catch {
        // Optional finalization must not affect migration work.
      }
    },
  })
}

/**
 * Validates the detached snapshot shape needed by terminal classification
 * without invoking accessors or Proxy traps.
 *
 * @param value - Runtime return from an injected snapshot method.
 * @returns Whether the value is a strict plain secret-free snapshot.
 */
function isSafeControlCliTelemetrySnapshot(value: unknown): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const snapshot = new Map<string, unknown>()
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return false
      }
      snapshot.set(key, descriptor.value)
    }
    const configurationBinding = snapshot.get('configurationBinding')
    const observationCount = snapshot.get('observationCount')
    const expectedKeys = configurationBinding === 'bound'
      ? [
        'configurationBinding',
        'configurationHash',
        'correlationId',
        'evidenceLocator',
        'lastReason',
        'lastTrigger',
        'metrics',
        'observationCount',
        'version',
      ]
      : [
        'configurationBinding',
        'correlationId',
        'evidenceLocator',
        'lastReason',
        'lastTrigger',
        'metrics',
        'observationCount',
        'version',
      ]
    if (
      (configurationBinding !== 'bound' &&
        configurationBinding !== 'unbound') ||
      snapshot.size !== expectedKeys.length ||
      !expectedKeys.every((key) => snapshot.has(key)) ||
      snapshot.get('version') !==
        WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION ||
      typeof snapshot.get('correlationId') !== 'string' ||
      typeof snapshot.get('evidenceLocator') !== 'string' ||
      typeof snapshot.get('lastTrigger') !== 'string' ||
      (
        snapshot.get('lastReason') !== undefined &&
        typeof snapshot.get('lastReason') !== 'string'
      ) ||
      typeof observationCount !== 'number' ||
      !Number.isSafeInteger(observationCount) ||
      observationCount < 0 ||
      (
        configurationBinding === 'bound' &&
        typeof snapshot.get('configurationHash') !== 'string'
      )
    ) {
      return false
    }
    const metrics = snapshot.get('metrics')
    if (
      typeof metrics !== 'object' ||
      metrics === null ||
      Array.isArray(metrics) ||
      nodeUtilTypes.isProxy(metrics)
    ) {
      return false
    }
    const metricNames = [
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
      'TerminalFailureCount',
    ]
    const metricKeys = Reflect.ownKeys(metrics)
    if (
      metricKeys.length !== metricNames.length ||
      metricKeys.some((key) =>
        typeof key !== 'string' || !metricNames.includes(key)
      )
    ) {
      return false
    }
    for (const metricName of metricNames) {
      const descriptor = Object.getOwnPropertyDescriptor(metrics, metricName)
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'number' ||
        !Number.isFinite(descriptor.value) ||
        descriptor.value < 0 ||
        descriptor.value > Number.MAX_SAFE_INTEGER
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Consumes an exact native Promise returned across a synchronous telemetry port.
 * Opaque objects, Proxies, and thenables are never inspected; callers reject
 * them according to the exact synchronous method contract.
 *
 * @param value - Runtime return from an injected synchronous method.
 * @returns Whether the value was an exact native Promise.
 */
function consumeControlCliNativePromise(value: unknown): boolean {
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
 * Binds commands that already carry a separately reviewed expected digest.
 * This correlation binding does not prove fresh measurement or a matching
 * runtime configuration. Measure remains deferred until measurement succeeds.
 *
 * @param configuration - Strict non-help command configuration.
 * @param recorder - Optional best-effort telemetry recorder.
 */
function bindKnownControlCliTelemetryConfiguration(
  configuration: Exclude<
    WorkspaceSearchMigrationControlCliArguments,
    WorkspaceSearchMigrationControlHelpCliArguments
  >,
  recorder?: WorkspaceSearchMigrationTelemetryRecorder,
): void {
  if (recorder === undefined || configuration.command === 'measure') return
  try {
    recorder.bindConfigurationHash(
      configuration.expectedConfigurationHash,
    )
  } catch {
    // Telemetry binding never changes the migration command.
  }
}

/**
 * Emits one terminal telemetry record without letting observer failures escape.
 *
 * @param recorder - Optional best-effort telemetry recorder.
 * @param phase - Finite phase reached by the command.
 * @param outcome - Finite successful, interrupted, or failed outcome.
 */
function finalizeControlCliTelemetry(
  recorder: WorkspaceSearchMigrationTelemetryRecorder | undefined,
  phase: WorkspaceSearchMigrationTelemetryPhase,
  outcome: WorkspaceSearchMigrationTelemetryFinalOutcome,
): void {
  try {
    recorder?.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase,
      outcome,
    })
  } catch {
    // Telemetry finalization is intentionally best-effort.
  }
}

/**
 * Records one fixed terminal failure classification at the CLI boundary.
 *
 * @param recorder - Optional best-effort telemetry recorder.
 * @param operation - Stable operation selected before asynchronous work.
 * @param failure - Raw-value-free classified failure.
 */
function recordControlCliTerminalFailure(
  recorder: WorkspaceSearchMigrationTelemetryRecorder | undefined,
  operation: WorkspaceSearchMigrationControlCliOperation,
  failure: ClassifiedControlCliFailure,
): void {
  if (recorder === undefined) return
  try {
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'terminal-failure',
      phase: telemetryPhaseForOperation(operation),
      reason: classifyControlCliTelemetryFailureReason(
        recorder,
        operation,
        failure,
      ),
    })
  } catch {
    // Failure reporting never replaces the command's primary failure.
  }
}

/**
 * Maps one safe command failure to a finite telemetry classification.
 *
 * @param recorder - Recorder whose rate aggregate may prove exhaustion.
 * @param operation - Stable operation label.
 * @param failure - Stable CLI or migration failure.
 * @returns Fixed raw-error-free terminal failure reason.
 */
function classifyControlCliTelemetryFailureReason(
  recorder: WorkspaceSearchMigrationTelemetryRecorder,
  operation: WorkspaceSearchMigrationControlCliOperation,
  failure: ClassifiedControlCliFailure,
): WorkspaceSearchMigrationTelemetryTerminalFailureReason {
  try {
    if (
      (recorder.snapshot()?.metrics
        .DescribeTableBudgetExhaustionCount ?? 0) > 0
    ) {
      return 'rate-budget-exhausted'
    }
  } catch {
    // Fall through to the stable failure-code mapping.
  }
  if (failure.code === 'INTERRUPTED') return 'interrupted'
  if (failure.code === 'LEASE_LOST') return 'lease-lost'
  if (
    failure.code === 'LEASE_CONFLICT' ||
    failure.code === 'INVALID_MAINTENANCE_EVIDENCE'
  ) {
    return 'authority-lost'
  }
  if (
    failure.code === 'CONFIGURATION_DRIFT' ||
    failure.code === 'CONFIGURATION_HASH_MISMATCH' ||
    failure.code === 'IDENTITY_MISMATCH' ||
    failure.code === 'TABLE_SCHEMA_MISMATCH'
  ) {
    return 'configuration-mismatch'
  }
  if (
    failure.code === 'DRY_RUN_INVALID_ROWS' ||
    failure.code === 'INVALID_JOURNAL' ||
    failure.code === 'INVALID_SOURCE_ARTIFACT' ||
    failure.code === 'INVALID_TARGET_ARTIFACT' ||
    failure.code === 'PITR_NOT_READY' ||
    failure.code === 'ROLLBACK_TARGET_DRIFT' ||
    failure.code === 'SOURCE_DRIFT' ||
    failure.code === 'TARGET_DRIFT'
  ) {
    return 'data-integrity'
  }
  if (failure.code === 'VERIFY_FAILED' || operation === 'verify') {
    return 'verification-failed'
  }
  return 'operation-failed'
}

/**
 * Selects the finite telemetry phase owned by one stable CLI operation.
 *
 * @param operation - Stable operation selected before parser or I/O failure.
 * @returns Finite phase used for finalization and terminal failure records.
 */
function telemetryPhaseForOperation(
  operation: WorkspaceSearchMigrationControlCliOperation,
): WorkspaceSearchMigrationTelemetryPhase {
  switch (operation) {
    case 'apply':
      return 'apply'
    case 'bootstrap-open':
    case 'status':
      return 'writer-fence'
    case 'close-replan':
      return 'planning'
    case 'measure':
    case 'execution-status':
      return 'measurement'
    case 'release':
      return 'release'
    case 'rollback-complete':
    case 'rollback-partial':
      return 'rollback'
    case 'verify':
      return 'verification'
    case 'help':
    case 'unknown':
      return 'admission'
  }
}

/**
 * Reads and parses the exact reviewed rate policy through captured capability.
 *
 * @param path - Private explicit rate-policy file path.
 * @param dependencies - Already captured bounded file reader.
 * @param signal - Optional cooperative operator interruption.
 * @returns Strict digest-bound rate policy.
 */
async function readControlCliRatePolicy(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationControlCliDependencies,
    'readInputFile'
  >,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationDescribeTableRatePolicy> {
  requireNotInterrupted(signal)
  const ratePolicyBytes = await dependencies.readInputFile(
    path,
    WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
  )
  requireNotInterrupted(signal)
  const ratePolicy =
    parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
      ratePolicyBytes,
    )
  requireNotInterrupted(signal)
  return ratePolicy
}

/**
 * Runs one read-only command through a session with no mutation methods.
 *
 * @param configuration - Strict read-only command.
 * @param ratePolicy - Reviewed strict rate policy.
 * @param dependencies - Capability-minimized session factory.
 * @param telemetryRecorder - Optional best-effort invocation telemetry.
 * @param signal - Optional cooperative interruption signal.
 * @returns One secret-free success payload.
 */
async function runReadOnlyCommand(
  configuration:
    | WorkspaceSearchMigrationExecutionStatusCliArguments
    | WorkspaceSearchMigrationMeasureCliArguments
    | WorkspaceSearchMigrationStatusCliArguments,
  ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy,
  dependencies: WorkspaceSearchMigrationControlCliReadDependencies,
  telemetryRecorder?: WorkspaceSearchMigrationTelemetryRecorder,
  signal?: AbortSignal,
): Promise<unknown> {
  requireNotInterrupted(signal)
  let session: WorkspaceSearchMigrationControlCliReadSession
  try {
    session = await dependencies.createReadSession({
      resources: configuration.resources,
      ratePolicy,
      rateBootstrap: configuration.rateBootstrap,
      rateRecoverInterruptedCleanup:
        configuration.rateRecoverInterruptedCleanup,
      rateRecoverInterruptedAttempt:
        configuration.rateRecoverInterruptedAttempt,
      ...(telemetryRecorder === undefined
        ? {}
        : {
            rateRecorder: telemetryRecorder.describeTableRateRecorder,
            telemetryRecorder,
          }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error: unknown) {
    requireNotInterrupted(signal)
    throw error
  }
  return await runWithControlCliSession(session, async () => {
    requireNotInterrupted(signal)
    if (configuration.command === 'execution-status') {
      const execution = await session.readExecutionStatus(
        configuration.runId,
        configuration.expectedConfigurationHash,
      )
      requireNotInterrupted(signal)
      const rateAggregate = readBoundRateAggregate(session, ratePolicy)
      return {
        schemaVersion: 1,
        operation: configuration.command,
        status: 'pass',
        configurationHash: configuration.expectedConfigurationHash,
        policyVersion: ratePolicy.policyVersion,
        execution,
        rateAggregate,
      }
    }

    const configurationHash = await session.measureConfigurationHash()
    requireNotInterrupted(signal)
    if (configuration.command === 'measure') {
      telemetryRecorder?.bindConfigurationHash(configurationHash)
    }
    if (configuration.command === 'measure') {
      return {
        schemaVersion: 1,
        operation: configuration.command,
        status: 'pass',
        configurationHash,
        policyVersion: ratePolicy.policyVersion,
        rateAggregate: readBoundRateAggregate(session, ratePolicy),
      }
    }

    requireExpectedConfigurationHash(
      configurationHash,
      configuration.expectedConfigurationHash,
    )
    const writerFence = await session.readWriterFence()
    requireNotInterrupted(signal)
    return {
      schemaVersion: 1,
      operation: configuration.command,
      status: 'pass',
      configurationHash,
      policyVersion: ratePolicy.policyVersion,
      writerFence,
      rateAggregate: readBoundRateAggregate(session, ratePolicy),
    }
  }, signal)
}

/**
 * Runs one explicit mutation through the isolated mutating session factory.
 *
 * @param configuration - Strict mutating command and approval.
 * @param ratePolicy - Reviewed strict rate policy.
 * @param dependencies - File, evidence-provider, and mutating factories.
 * @param telemetryRecorder - Optional best-effort invocation telemetry.
 * @param signal - Optional cooperative interruption signal.
 * @returns One secret-free success payload.
 */
async function runMutatingCommand(
  configuration:
    | WorkspaceSearchMigrationBootstrapOpenCliArguments
    | WorkspaceSearchMigrationCoordinatorCliArguments,
  ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy,
  dependencies: WorkspaceSearchMigrationControlCliMutationDependencies,
  telemetryRecorder?: WorkspaceSearchMigrationTelemetryRecorder,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationControlCliMutationResult> {
  const bootstrapEvidence = configuration.command === 'bootstrap-open'
    ? await dependencies.readInputFile(
        configuration.maintenanceEvidenceFile,
        MAINTENANCE_EVIDENCE_MAX_BYTES,
      )
    : undefined
  const reviewedDryRunEvidenceBytes =
    configuration.command === 'close-replan'
      ? await dependencies.readInputFile(
          configuration.reviewedDryRunFile,
          WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES,
        )
      : undefined
  requireNotInterrupted(signal)

  let session: WorkspaceSearchMigrationControlCliMutationSession
  try {
    session = await dependencies.createMutationSession({
      resources: configuration.resources,
      ratePolicy,
      rateBootstrap: configuration.rateBootstrap,
      rateRecoverInterruptedCleanup:
        configuration.rateRecoverInterruptedCleanup,
      rateRecoverInterruptedAttempt:
        configuration.rateRecoverInterruptedAttempt,
      ...(telemetryRecorder === undefined
        ? {}
        : {
            rateRecorder: telemetryRecorder.describeTableRateRecorder,
            telemetryRecorder,
          }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error: unknown) {
    requireNotInterrupted(signal)
    throw error
  }
  return await runWithControlCliSession(session, async () => {
    requireNotInterrupted(signal)
    if (configuration.command === 'bootstrap-open') {
      if (bootstrapEvidence === undefined) throw operationFailed()
      const configurationHash =
        await session.measureConfigurationHash()
      requireExpectedConfigurationHash(
        configurationHash,
        configuration.expectedConfigurationHash,
      )
      const bootstrap = await runBootstrapOpen(
        configuration,
        bootstrapEvidence,
        session,
        signal,
      )
      requireNotInterrupted(signal)
      return {
        schemaVersion: 1,
        operation: configuration.command,
        status: 'pass',
        configurationHash,
        policyVersion: ratePolicy.policyVersion,
        writerFence: bootstrap.writerFence,
        rateAggregate: readBoundRateAggregate(session, ratePolicy),
      }
    }
    const maintenanceEvidenceProvider =
      session.createMaintenanceEvidenceProvider(
        configuration.maintenanceEvidenceFile,
      )
    requireNotInterrupted(signal)
    const coordinator = await session.advanceStage(
      createCoordinatorStageRequest(
        configuration,
        maintenanceEvidenceProvider,
        reviewedDryRunEvidenceBytes,
        signal,
      ),
    )
    requireNotInterrupted(signal)
    return {
      schemaVersion: 1,
      operation: configuration.command,
      status: 'pass',
      configurationHash: configuration.expectedConfigurationHash,
      policyVersion: ratePolicy.policyVersion,
      coordinator,
      rateAggregate: readBoundRateAggregate(session, ratePolicy),
    }
  }, signal)
}

/**
 * Creates one exact coordinator request without exposing its managed session.
 *
 * @param configuration - Strict stage-specific CLI arguments.
 * @param maintenanceEvidenceProvider - Fresh file-backed evidence provider.
 * @param reviewedDryRunEvidenceBytes - Bounded close-replan artifact bytes.
 * @param signal - Optional cooperative interruption signal.
 * @returns Exact single-stage coordinator request.
 */
function createCoordinatorStageRequest(
  configuration: WorkspaceSearchMigrationCoordinatorCliArguments,
  maintenanceEvidenceProvider:
    WorkspaceSearchMigrationMaintenanceEvidenceProvider,
  reviewedDryRunEvidenceBytes: Uint8Array | undefined,
  signal?: AbortSignal,
): WorkspaceSearchMigrationControlCliStageRequest {
  const common = {
    maintenanceEvidenceProvider,
    runId: configuration.runId,
    ownerId: configuration.ownerId,
    expectedConfigurationHash: configuration.expectedConfigurationHash,
    ...(signal === undefined ? {} : { signal }),
  }
  if (configuration.command === 'close-replan') {
    if (reviewedDryRunEvidenceBytes === undefined) {
      throw operationFailed()
    }
    return {
      ...common,
      mode: configuration.command,
      approval: configuration.approval,
      reviewedDryRunEvidenceBytes,
      planningJoinLimits: configuration.planningJoinLimits,
      retainUntil: configuration.retainUntil,
    }
  }
  if (configuration.command === 'apply') {
    return {
      ...common,
      mode: configuration.command,
      approval: configuration.approval,
    }
  }
  if (configuration.command === 'verify') {
    return {
      ...common,
      mode: configuration.command,
      approval: configuration.approval,
    }
  }
  if (configuration.command === 'rollback-partial') {
    return {
      ...common,
      mode: configuration.command,
      approval: configuration.approval,
    }
  }
  if (configuration.command === 'rollback-complete') {
    return {
      ...common,
      mode: configuration.command,
      approval: configuration.approval,
    }
  }
  return {
    ...common,
    mode: configuration.command,
    approval: configuration.approval,
  }
}

/**
 * Runs the explicit initial bootstrap under a single-flight heartbeat.
 *
 * @param configuration - Strict initial-bootstrap command.
 * @param evidenceBytes - Exact bounded maintenance evidence bytes.
 * @param session - Current mutating session.
 * @param signal - Optional operator-interruption signal.
 * @returns Safe durable fence summary.
 */
async function runBootstrapOpen(
  configuration: WorkspaceSearchMigrationBootstrapOpenCliArguments,
  evidenceBytes: Uint8Array,
  session: WorkspaceSearchMigrationControlCliMutationSession,
  signal?: AbortSignal,
): Promise<BootstrapOpenResult> {
  requireNotInterrupted(signal)
  const lease = await session.acquireLease({
    runId: configuration.runId,
    ownerId: configuration.ownerId,
  })
  requireNotInterrupted(signal)
  return await runWithWorkspaceSearchMigrationHeartbeat({
    lease,
    port: session,
    signal,
    task: async (context): Promise<BootstrapOpenResult> => {
      context.assertActive()
      const authority = await session.renewMaintenanceEvidence({
        lease: context.lease,
        expectedPointer: null,
        evidenceBytes,
      })
      context.assertActive()
      const refreshedAuthority = await session.readAuthority({
        lease: context.lease,
        maintenanceEvidenceReceiptDigest:
          authority.maintenanceEvidenceReceiptDigest,
        maintenanceEvidencePointerRevision:
          authority.maintenanceEvidencePointerRevision,
      })
      context.assertActive()
      const writerFence =
        await session.bootstrapWriterFence(refreshedAuthority)
      context.assertActive()
      requireOpenWriterFence(writerFence)
      return { writerFence }
    },
  })
}

/**
 * Runs one task and closes its session exactly once afterward.
 *
 * @param session - Closeable capability-minimized session.
 * @param task - Session-bound operation.
 * @param signal - Optional cancellation wired to the private rate controller.
 * @returns Task result after successful cleanup.
 */
async function runWithControlCliSession<
  Session extends {
    close(): Promise<void> | void
    interrupt(): void
  },
  Result,
>(
  session: Session,
  task: (session: Session) => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  /** Stops unsent rate work without letting cleanup errors escape the boundary. */
  const interrupt = (): void => {
    try {
      session.interrupt()
    } catch {
      // Cleanup and the task's primary outcome remain authoritative.
    }
  }
  signal?.addEventListener('abort', interrupt, { once: true })
  if (signal?.aborted === true) interrupt()
  let outcome:
    | { readonly status: 'success'; readonly value: Result }
    | { readonly status: 'failure'; readonly error: unknown }
  try {
    outcome = { status: 'success', value: await task(session) }
  } catch (error: unknown) {
    outcome = { status: 'failure', error }
  }
  let closeFailed = false
  try {
    await session.close()
  } catch {
    closeFailed = true
  }
  signal?.removeEventListener('abort', interrupt)
  if (outcome.status === 'failure') throw outcome.error
  requireNotInterrupted(signal)
  if (closeFailed) throw operationFailed()
  return outcome.value
}

/**
 * Creates one read-only CLI projection through a captured session constructor.
 *
 * @param input - Explicit resources and reviewed policy.
 * @param createRateManagedSession - Captured production-equivalent constructor.
 * @returns Capability-minimized read session.
 */
async function createProjectedControlCliReadSession(
  input: CreateWorkspaceSearchMigrationControlCliReadSessionInput,
  createRateManagedSession:
    WorkspaceSearchMigrationControlCliRateManagedSessionConstructor,
): Promise<WorkspaceSearchMigrationControlCliReadSession> {
  const managed = await createRateManagedSession(
    createControlCliRateManagedSessionInput(input),
  )
  let close:
    WorkspaceSearchMigrationRateManagedAwsSession['close'] | undefined
  try {
    close = captureControlCliManagedSessionClose(managed)
    return createControlCliReadSession(managed, close)
  } catch (error: unknown) {
    await closeControlCliManagedSessionAfterProjectionFailure(
      managed,
      close,
    )
    throw error
  }
}

/**
 * Creates one mutation CLI projection through a captured session constructor.
 *
 * @param input - Explicit resources, policy, and lifecycle authority.
 * @param createRateManagedSession - Captured production-equivalent constructor.
 * @returns Capability-minimized mutating session.
 */
async function createProjectedControlCliMutationSession(
  input: CreateWorkspaceSearchMigrationControlCliMutationSessionInput,
  createRateManagedSession:
    WorkspaceSearchMigrationControlCliRateManagedSessionConstructor,
): Promise<WorkspaceSearchMigrationControlCliMutationSession> {
  const managed = await createRateManagedSession(
    createControlCliRateManagedSessionInput(input),
  )
  let close:
    WorkspaceSearchMigrationRateManagedAwsSession['close'] | undefined
  try {
    close = captureControlCliManagedSessionClose(managed)
    return createControlCliMutationSession(
      managed,
      close,
      input.resources,
      input.telemetryRecorder,
    )
  } catch (error: unknown) {
    await closeControlCliManagedSessionAfterProjectionFailure(
      managed,
      close,
    )
    throw error
  }
}

/**
 * Converts one CLI factory input to the existing AWS composition contract.
 *
 * @param input - Detached control-CLI session request.
 * @returns Exact rate-managed AWS session-construction input.
 */
function createControlCliRateManagedSessionInput(
  input: CreateWorkspaceSearchMigrationControlCliReadSessionInput,
): CreateAwsWorkspaceSearchMigrationRateManagedSessionInput {
  return {
    requested: input.resources,
    ratePolicy: input.ratePolicy,
    bootstrapRateCheckpoint: input.rateBootstrap,
    recoverInterruptedCleanup: input.rateRecoverInterruptedCleanup,
    recoverInterruptedAttempt: input.rateRecoverInterruptedAttempt,
    ...(input.rateRecorder === undefined
      ? {}
      : { rateRecorder: input.rateRecorder }),
    ...(input.telemetryRecorder === undefined
      ? {}
      : { telemetryRecorder: input.telemetryRecorder }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
}

/**
 * Captures the close capability before any other managed-session projection.
 *
 * @param managed - Newly constructed managed session.
 * @returns Exact close method retained for normal or failure cleanup.
 */
function captureControlCliManagedSessionClose(
  managed: WorkspaceSearchMigrationRateManagedAwsSession,
): WorkspaceSearchMigrationRateManagedAwsSession['close'] {
  const close = managed.close
  if (typeof close !== 'function') throw invalidControlCliSessionProjection()
  return close
}

/**
 * Closes a newly constructed session after its capability projection fails.
 *
 * Cleanup failure never replaces the original projection failure.
 *
 * @param managed - Session whose projection did not complete.
 * @param close - Close method captured before projection began.
 */
async function closeControlCliManagedSessionAfterProjectionFailure(
  managed: WorkspaceSearchMigrationRateManagedAwsSession,
  close: WorkspaceSearchMigrationRateManagedAwsSession['close'] | undefined,
): Promise<void> {
  if (close === undefined) return
  try {
    await close.call(managed)
  } catch {
    // Preserve the capability-projection failure after best-effort drainage.
  }
}

/** Creates one stable managed-session projection failure. */
function invalidControlCliSessionProjection(): TypeError {
  return new TypeError(
    'Workspace Search migration control CLI session projection is invalid.',
  )
}

/**
 * Narrows one managed session to read-only CLI operations.
 *
 * @param managed - Complete rate-managed migration session.
 * @param close - Captured session cleanup capability.
 * @returns Read-only control surface without mutation methods.
 */
function createControlCliReadSession(
  managed: WorkspaceSearchMigrationRateManagedAwsSession,
  close: WorkspaceSearchMigrationRateManagedAwsSession['close'],
): WorkspaceSearchMigrationControlCliReadSession {
  const measureConfiguration = managed.measureConfiguration
  const createApplicationWriterFencePort =
    managed.createApplicationWriterFencePort
  const readDescribeTableRateEvidence =
    managed.readDescribeTableRateEvidence
  const interruptDescribeTableRate =
    managed.interruptDescribeTableRate
  if (
    typeof measureConfiguration !== 'function' ||
    typeof createApplicationWriterFencePort !== 'function' ||
    typeof readDescribeTableRateEvidence !== 'function' ||
    typeof interruptDescribeTableRate !== 'function'
  ) {
    throw invalidControlCliSessionProjection()
  }
  return Object.freeze({
    measureConfigurationHash: async (): Promise<string> =>
      createWorkspaceSearchConfigurationHash(
        await measureConfiguration.call(managed),
      ),
    readWriterFence: async () => summarizeWriterFence(
      await createApplicationWriterFencePort.call(managed).read(),
    ),
    readExecutionStatus: async (
      runId: string,
      expectedConfigurationHash: string,
    ): Promise<WorkspaceSearchMigrationExecutionStatus> =>
      await readWorkspaceSearchMigrationControlExecutionStatus({
        session: managed,
        runId,
        expectedConfigurationHash,
      }),
    readRateAggregate: () =>
      readDescribeTableRateEvidence.call(managed),
    interrupt: () => interruptDescribeTableRate.call(managed),
    close: async () => await close.call(managed),
  })
}

/**
 * Narrows one managed session to explicit CLI mutation operations.
 *
 * @param managed - Complete rate-managed migration session.
 * @param close - Captured session cleanup capability.
 * @param resources - Immutable resources rebound by subordinate measurements.
 * @param telemetryRecorder - Optional best-effort invocation telemetry.
 * @returns Explicit mutating control surface.
 */
function createControlCliMutationSession(
  managed: WorkspaceSearchMigrationRateManagedAwsSession,
  close: WorkspaceSearchMigrationRateManagedAwsSession['close'],
  resources: WorkspaceSearchMigrationRequestedResources,
  telemetryRecorder?: WorkspaceSearchMigrationTelemetryRecorder,
): WorkspaceSearchMigrationControlCliMutationSession {
  const measureConfiguration = managed.measureConfiguration
  const acquireLease = managed.acquireLease
  const heartbeatLease = managed.heartbeatLease
  const renewMaintenanceEvidence = managed.renewMaintenanceEvidence
  const readAuthority = managed.readAuthority
  const createApplicationWriterFencePort =
    managed.createApplicationWriterFencePort
  const createRateManagedMeasurementSession =
    managed.createRateManagedMeasurementSession
  const readDescribeTableRateEvidence =
    managed.readDescribeTableRateEvidence
  const runWithMutationAdmissionGuardMethod =
    managed.runWithMutationAdmissionGuard
  const interruptMutationAdmission =
    managed.interruptMutationAdmission
  const interruptDescribeTableRate =
    managed.interruptDescribeTableRate
  if (
    typeof measureConfiguration !== 'function' ||
    typeof acquireLease !== 'function' ||
    typeof heartbeatLease !== 'function' ||
    typeof renewMaintenanceEvidence !== 'function' ||
    typeof readAuthority !== 'function' ||
    typeof createApplicationWriterFencePort !== 'function' ||
    typeof createRateManagedMeasurementSession !== 'function' ||
    typeof readDescribeTableRateEvidence !== 'function' ||
    typeof runWithMutationAdmissionGuardMethod !== 'function' ||
    typeof interruptMutationAdmission !== 'function' ||
    typeof interruptDescribeTableRate !== 'function'
  ) {
    throw invalidControlCliSessionProjection()
  }
  const runWithMutationAdmissionGuard =
    runWithMutationAdmissionGuardMethod.bind(managed)
  const projected: WorkspaceSearchMigrationControlCliMutationSession = {
    measureConfigurationHash: async (): Promise<string> =>
      createWorkspaceSearchConfigurationHash(
        await measureConfiguration.call(managed),
      ),
    acquireLease: async (input) =>
      await acquireLease.call(managed, input),
    heartbeatLease: async (input) =>
      await heartbeatLease.call(managed, input),
    renewMaintenanceEvidence: async (input) =>
      await renewMaintenanceEvidence.call(managed, input),
    readAuthority: async (claim) =>
      await readAuthority.call(managed, claim),
    bootstrapWriterFence: async (authority) => summarizeWriterFence(
      await createApplicationWriterFencePort
        .call(managed)
        .bootstrapOpen(authority),
    ),
    advanceStage: async (input) =>
      await advanceDefaultCoordinatorStage(
        managed,
        input,
        telemetryRecorder,
      ),
    createMaintenanceEvidenceProvider: (maintenanceEvidenceFile) =>
      createWorkspaceSearchMigrationFileEvidenceProvider({
        resources,
        evidenceFilePath: maintenanceEvidenceFile,
        readEvidenceFile: readMaintenanceEvidenceFile,
        createMeasurementSession: async () =>
          await createRateManagedMeasurementSession.call(managed),
      }),
    readRateAggregate: () =>
      readDescribeTableRateEvidence.call(managed),
    runWithMutationAdmissionGuard: async <Result>(
      guard: () => void,
      task: () => Promise<Result>,
    ): Promise<Result> =>
      await runWithMutationAdmissionGuard<Result>(guard, task),
    interruptMutationAdmission: () =>
      interruptMutationAdmission.call(managed),
    interrupt: () => interruptDescribeTableRate.call(managed),
    close: async () => await close.call(managed),
  }
  return Object.freeze(projected)
}

/**
 * Reattaches the private managed session to one exact coordinator request.
 *
 * @param managed - Rate-managed session retained by the composition closure.
 * @param input - Capability-safe request supplied by CLI orchestration.
 * @param telemetryRecorder - Optional best-effort invocation telemetry.
 * @returns Secret-free coordinator summary.
 */
async function advanceDefaultCoordinatorStage(
  managed: WorkspaceSearchMigrationRateManagedAwsSession,
  input: WorkspaceSearchMigrationControlCliStageRequest,
  telemetryRecorder?: WorkspaceSearchMigrationTelemetryRecorder,
): Promise<WorkspaceSearchMigrationControlCoordinatorSummary> {
  if (input.mode === 'close-replan') {
    return await advanceWorkspaceSearchMigrationControlStage({
      ...input,
      session: managed,
      ...(telemetryRecorder === undefined ? {} : { telemetryRecorder }),
    })
  }
  if (input.mode === 'release') {
    return await advanceWorkspaceSearchMigrationControlStage({
      ...input,
      session: managed,
    })
  }
  return await advanceWorkspaceSearchMigrationControlStage({
    ...input,
    session: managed,
    ...(telemetryRecorder === undefined ? {} : { telemetryRecorder }),
  })
}

/**
 * Removes physical names and authority identifiers from a fence read.
 *
 * @param observation - Strict measured writer-fence observation.
 * @returns Operator-safe status and canonical record digest.
 */
function summarizeWriterFence(
  observation: WorkspaceSearchWriterFenceObservation,
): WorkspaceSearchMigrationWriterFenceSummary {
  if (observation.status === 'missing') return { status: 'missing' }
  return {
    status: 'present',
    mode: observation.record.mode,
    writerEpoch: observation.record.writerEpoch,
    controlRevision: observation.record.controlRevision,
    recordDigest: observation.record.recordDigest,
  }
}

/**
 * Requires the bootstrap transition to return an exact open row.
 *
 * @param summary - Safe writer-fence summary.
 */
function requireOpenWriterFence(
  summary: WorkspaceSearchMigrationWriterFenceSummary,
): void {
  if (summary.status !== 'present' || summary.mode !== 'open') {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Initial writer-fence bootstrap did not produce an open row.',
    )
  }
}

/**
 * Reads one regular maintenance evidence file through its contract byte limit.
 *
 * @param path - Explicit operator-supplied path.
 * @returns Exact detached file bytes.
 */
export async function readMaintenanceEvidenceFile(
  path: string,
): Promise<Uint8Array> {
  return await readBoundedInputFile(path, MAINTENANCE_EVIDENCE_MAX_BYTES)
}

/**
 * Reads one non-empty regular file through an explicit finite byte limit.
 *
 * @param path - Exact private operator-supplied path.
 * @param maximumBytes - Positive safe inclusive byte ceiling.
 * @returns Exact detached bytes.
 */
export async function readBoundedInputFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES
  ) {
    throw new WorkspaceSearchMigrationControlCliFailure(
      'INPUT_FILE_INVALID',
      2,
    )
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      path,
      fileSystemConstants.O_RDONLY | fileSystemConstants.O_NONBLOCK,
    )
  } catch {
    throw new WorkspaceSearchMigrationControlCliFailure(
      'INPUT_FILE_UNREADABLE',
      2,
    )
  }
  try {
    const file = await handle.stat({ bigint: true })
    if (
      !file.isFile() ||
      file.size === 0n ||
      file.size > BigInt(maximumBytes)
    ) {
      throw new WorkspaceSearchMigrationControlCliFailure(
        'INPUT_FILE_INVALID',
        2,
      )
    }
    const buffer = Buffer.alloc(maximumBytes + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      )
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset === 0 || offset > maximumBytes) {
      throw new WorkspaceSearchMigrationControlCliFailure(
        'INPUT_FILE_INVALID',
        2,
      )
    }
    const finalFile = await handle.stat({ bigint: true })
    if (!sameBoundedInputFileObservation(file, finalFile, offset)) {
      throw new WorkspaceSearchMigrationControlCliFailure(
        'INPUT_FILE_INVALID',
        2,
      )
    }
    return new Uint8Array(buffer.subarray(0, offset))
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationControlCliFailure) {
      throw error
    }
    throw new WorkspaceSearchMigrationControlCliFailure(
      'INPUT_FILE_UNREADABLE',
      2,
    )
  } finally {
    try {
      await handle.close()
    } catch {
      // The raw filesystem error must not cross the CLI boundary.
    }
  }
}

/**
 * Requires one descriptor to remain the same finite regular file during read.
 *
 * Device, inode, link count, size, and mutation timestamps close same-path and
 * same-inode replacement races. Access time is intentionally ignored because
 * the read itself may update it.
 *
 * @param initial - Descriptor metadata captured before the first byte read.
 * @param final - Descriptor metadata captured after the final byte read.
 * @param bytesRead - Exact number of bytes copied from the descriptor.
 * @returns Whether the complete stable file was read exactly once.
 */
function sameBoundedInputFileObservation(
  initial: BigIntStats,
  final: BigIntStats,
  bytesRead: number,
): boolean {
  return final.isFile() &&
    initial.dev === final.dev &&
    initial.ino === final.ino &&
    initial.mode === final.mode &&
    initial.nlink === final.nlink &&
    initial.size === final.size &&
    initial.mtimeNs === final.mtimeNs &&
    initial.ctimeNs === final.ctimeNs &&
    initial.size === BigInt(bytesRead)
}

/**
 * Parses common resources and the mandatory reviewed rate-policy path.
 *
 * @param flags - Strict flag/value map.
 * @returns Detached common arguments.
 */
function parseCommonArguments(
  flags: ReadonlyMap<string, string>,
): WorkspaceSearchMigrationControlCliCommonArguments {
  const rateBootstrap = readExactTrueFlag(flags, '--rate-bootstrap')
  const rateRecoverInterruptedCleanup = readExactTrueFlag(
    flags,
    '--rate-recover-interrupted-cleanup',
  )
  const rateRecoverInterruptedAttempt = readExactTrueFlag(
    flags,
    '--rate-recover-interrupted-attempt',
  )
  if (
    rateBootstrap &&
    (rateRecoverInterruptedCleanup || rateRecoverInterruptedAttempt)
  ) {
    throw invalidUsage()
  }
  return {
    resources: parseRequestedResources(flags),
    ratePolicyFile: requireSafePath(flags, '--rate-policy-file'),
    rateBootstrap,
    rateRecoverInterruptedCleanup,
    rateRecoverInterruptedAttempt,
  }
}

/**
 * Parses fields required by every mutating command.
 *
 * @param flags - Strict flag/value map.
 * @returns Detached common mutation arguments.
 */
function parseMutationArguments(
  flags: ReadonlyMap<string, string>,
): WorkspaceSearchMigrationControlCliMutationArguments {
  return {
    ...parseCommonArguments(flags),
    expectedConfigurationHash: requireConfigurationHash(flags),
    maintenanceEvidenceFile: requireSafePath(
      flags,
      '--maintenance-evidence-file',
    ),
    ownerId: requireMigrationIdentifier(flags, '--owner-id'),
    runId: requireMigrationIdentifier(flags, '--run-id'),
  }
}

/**
 * Parses one non-planning coordinator stage with its exact approval.
 *
 * @param command - Valid stage command.
 * @param flags - Strict command flags.
 * @returns Exact stage arguments.
 */
function parseCoordinatorStageArguments(
  command: Exclude<
    WorkspaceSearchMigrationControlCliOperation,
    | 'bootstrap-open'
    | 'close-replan'
    | 'execution-status'
    | 'help'
    | 'measure'
    | 'status'
    | 'unknown'
  >,
  flags: ReadonlyMap<string, string>,
): WorkspaceSearchMigrationCoordinatorCliArguments {
  const common = parseMutationArguments(flags)
  if (command === 'apply') {
    return {
      ...common,
      command,
      approval: requireExactApproval(
        flags,
        workspaceSearchMigrationControlApprovalLiterals.apply,
      ),
    }
  }
  if (command === 'verify') {
    return {
      ...common,
      command,
      approval: requireExactApproval(
        flags,
        workspaceSearchMigrationControlApprovalLiterals.verify,
      ),
    }
  }
  if (command === 'rollback-partial') {
    return {
      ...common,
      command,
      approval: requireExactApproval(
        flags,
        workspaceSearchMigrationControlApprovalLiterals[
          'rollback-partial'
        ],
      ),
    }
  }
  if (command === 'rollback-complete') {
    return {
      ...common,
      command,
      approval: requireExactApproval(
        flags,
        workspaceSearchMigrationControlApprovalLiterals[
          'rollback-complete'
        ],
      ),
    }
  }
  return {
    ...common,
    command,
    approval: requireExactApproval(
      flags,
      workspaceSearchMigrationControlApprovalLiterals.release,
    ),
  }
}

/**
 * Parses and validates the complete explicit resource selection.
 *
 * @param flags - Strict flag/value map.
 * @returns Validated requested resources.
 */
function parseRequestedResources(
  flags: ReadonlyMap<string, string>,
): WorkspaceSearchMigrationRequestedResources {
  const resources: WorkspaceSearchMigrationRequestedResources = {
    account: requireFlag(flags, '--account'),
    region: requireFlag(flags, '--region'),
    profile: requireFlag(flags, '--profile'),
    commit: requireFlag(flags, '--commit'),
    tables: {
      'project-directory': requireFlag(
        flags,
        '--project-directory-table',
      ),
      'work-items': requireFlag(flags, '--work-items-table'),
      collaboration: requireFlag(flags, '--collaboration-table'),
      documents: requireFlag(flags, '--documents-table'),
      'workspace-search': requireFlag(
        flags,
        '--workspace-search-table',
      ),
      'migration-state': requireFlag(flags, '--migration-state-table'),
    },
    journalBucket: requireFlag(flags, '--journal-bucket'),
    journalKeyArn: requireFlag(flags, '--journal-key-arn'),
  }
  try {
    validateWorkspaceSearchMigrationRequestedResources(resources)
  } catch {
    throw invalidUsage()
  }
  return resources
}

/**
 * Parses unique explicit flag/value pairs.
 *
 * @param arguments_ - Arguments after the subcommand.
 * @param allowedNames - Exact command-specific flag allowlist.
 * @returns Unique flag/value map.
 */
function parseFlagPairs(
  arguments_: readonly string[],
  allowedNames: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  if (arguments_.length % 2 !== 0) throw invalidUsage()
  const flags = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (
      name === undefined ||
      value === undefined ||
      !allowedNames.has(name) ||
      flags.has(name) ||
      value.startsWith('--') ||
      value.length === 0
    ) {
      throw invalidUsage()
    }
    flags.set(name, value)
  }
  return flags
}

/**
 * Reads one required flag.
 *
 * @param flags - Strict flag map.
 * @param name - Required allowlisted flag.
 * @returns Non-empty flag value.
 */
function requireFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = flags.get(name)
  if (value === undefined) throw invalidUsage()
  return value
}

/**
 * Reads one optional exact-true rate-lifecycle authority flag.
 *
 * @param flags - Strict flag map.
 * @param name - Explicit bootstrap or recovery authority flag.
 * @returns False when absent and true only for the exact value `true`.
 */
function readExactTrueFlag(
  flags: ReadonlyMap<string, string>,
  name:
    | '--rate-bootstrap'
    | '--rate-recover-interrupted-attempt'
    | '--rate-recover-interrupted-cleanup',
): boolean {
  const value = flags.get(name)
  if (value === undefined) return false
  if (value !== 'true') throw invalidUsage()
  return true
}

/**
 * Reads one lowercase SHA-256 configuration hash.
 *
 * @param flags - Strict flag map.
 * @returns Validated expected configuration hash.
 */
function requireConfigurationHash(
  flags: ReadonlyMap<string, string>,
): string {
  const value = requireFlag(flags, '--expected-configuration-hash')
  if (!/^[0-9a-f]{64}$/u.test(value)) throw invalidUsage()
  return value
}

/**
 * Reads one safe operator-selected migration identifier.
 *
 * @param flags - Strict flag map.
 * @param name - Identifier flag.
 * @returns Validated identifier.
 */
function requireMigrationIdentifier(
  flags: ReadonlyMap<string, string>,
  name: '--owner-id' | '--run-id',
): string {
  const value = requireFlag(flags, name)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw invalidUsage()
  }
  return value
}

/**
 * Reads one bounded positive safe integer.
 *
 * @param flags - Strict flag map.
 * @param name - Planning-limit flag.
 * @returns Positive safe integer.
 */
function requirePositiveSafeInteger(
  flags: ReadonlyMap<string, string>,
  name:
    | '--max-plan-operations'
    | '--max-total-canonical-item-bytes'
    | '--max-total-rows',
): number {
  const value = requireFlag(flags, name)
  if (!/^[1-9][0-9]*$/u.test(value)) throw invalidUsage()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw invalidUsage()
  return parsed
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param flags - Strict flag map.
 * @param name - Timestamp flag.
 * @returns Canonical timestamp.
 */
function requireCanonicalTimestamp(
  flags: ReadonlyMap<string, string>,
  name: '--retain-until',
): string {
  const value = requireFlag(flags, name)
  if (!isCanonicalTimestamp(value)) throw invalidUsage()
  return value
}

/**
 * Reads one bounded path without logging or resolving it.
 *
 * @param flags - Strict flag map.
 * @param name - Required path flag.
 * @returns Exact caller path.
 */
function requireSafePath(
  flags: ReadonlyMap<string, string>,
  name:
    | '--maintenance-evidence-file'
    | '--rate-policy-file'
    | '--reviewed-dry-run-file',
): string {
  const value = requireFlag(flags, name)
  if (
    value.includes('\0') ||
    value.trim().length === 0 ||
    value.length > 4_096
  ) {
    throw invalidUsage()
  }
  return value
}

/**
 * Requires one exact stage-specific approval phrase.
 *
 * @param flags - Strict flag map.
 * @param expected - Exact compile-time approval literal.
 * @returns The validated approval literal.
 */
function requireExactApproval<Approval extends string>(
  flags: ReadonlyMap<string, string>,
  expected: Approval,
): Approval {
  if (requireFlag(flags, '--approval') !== expected) throw invalidUsage()
  return expected
}

/**
 * Compares the measured configuration against the separately reviewed digest.
 *
 * @param measured - Digest derived from the current AWS measurement.
 * @param expected - Operator-reviewed digest.
 */
function requireExpectedConfigurationHash(
  measured: string,
  expected: string,
): void {
  if (measured !== expected) {
    throw new WorkspaceSearchMigrationFailure(
      'CONFIGURATION_HASH_MISMATCH',
      'Measured migration configuration does not match the reviewed digest.',
    )
  }
}

/**
 * Reads a rate aggregate only when it remains bound to the reviewed policy.
 *
 * @param session - Current read-only or mutating control session.
 * @param policy - Strict reviewed policy used to create the session.
 * @returns Identifier-free aggregate evidence.
 */
function readBoundRateAggregate(
  session:
    | WorkspaceSearchMigrationControlCliMutationSession
    | WorkspaceSearchMigrationControlCliReadSession,
  policy: WorkspaceSearchMigrationDescribeTableRatePolicy,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  const evidence = session.readRateAggregate()
  if (evidence.policyVersion !== policy.policyVersion) {
    throw operationFailed()
  }
  return evidence
}

/**
 * Identifies commands that cannot acquire mutation capabilities.
 *
 * @param configuration - Strict non-help command.
 * @returns Whether only the read-session factory may be called.
 */
function isReadOnlyCommand(
  configuration: Exclude<
    WorkspaceSearchMigrationControlCliArguments,
    WorkspaceSearchMigrationControlHelpCliArguments
  >,
): configuration is
  | WorkspaceSearchMigrationExecutionStatusCliArguments
  | WorkspaceSearchMigrationMeasureCliArguments
  | WorkspaceSearchMigrationStatusCliArguments {
  return configuration.command === 'measure' ||
    configuration.command === 'status' ||
    configuration.command === 'execution-status'
}

/**
 * Identifies a coordinator-backed non-planning stage command.
 *
 * @param command - Untrusted first positional argument.
 * @returns Whether the command is a supported exact stage.
 */
function isCoordinatorStageCommand(
  command: string | undefined,
): command is
  | 'apply'
  | 'release'
  | 'rollback-complete'
  | 'rollback-partial'
  | 'verify' {
  return command === 'apply' ||
    command === 'verify' ||
    command === 'rollback-partial' ||
    command === 'rollback-complete' ||
    command === 'release'
}

/**
 * Fails cooperatively when the operator already requested interruption.
 *
 * @param signal - Optional interruption signal.
 */
function requireNotInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new WorkspaceSearchMigrationHeartbeatInterruptedError()
  }
}

/** Creates one stable invalid-usage failure. */
function invalidUsage(): WorkspaceSearchMigrationControlCliFailure {
  return new WorkspaceSearchMigrationControlCliFailure('INVALID_USAGE', 2)
}

/** Creates one stable operation failure. */
function operationFailed(): WorkspaceSearchMigrationControlCliFailure {
  return new WorkspaceSearchMigrationControlCliFailure(
    'OPERATION_FAILED',
    1,
  )
}

/**
 * Converts an untrusted exception into a raw-value-free CLI failure.
 *
 * @param error - Caught unknown failure.
 * @returns Stable code and process exit status.
 */
function classifyControlCliFailure(
  error: unknown,
): ClassifiedControlCliFailure {
  if (error instanceof WorkspaceSearchMigrationControlCliFailure) {
    return { code: error.code, exitCode: error.exitCode }
  }
  if (error instanceof WorkspaceSearchMigrationHeartbeatInterruptedError) {
    return { code: 'INTERRUPTED', exitCode: 130 }
  }
  if (error instanceof WorkspaceSearchMigrationDescribeTableRatePolicyError) {
    return { code: error.code, exitCode: 2 }
  }
  if (
    error instanceof WorkspaceSearchMigrationMaintenanceEvidenceProviderError
  ) {
    return { code: error.code, exitCode: 1 }
  }
  if (error instanceof WorkspaceSearchMigrationFailure) {
    return { code: error.code, exitCode: 1 }
  }
  return { code: 'OPERATION_FAILED', exitCode: 1 }
}

/**
 * Identifies a safe operation label without returning arbitrary arguments.
 *
 * @param command - First CLI argument.
 * @returns Stable operation label.
 */
function identifyOperation(
  command: string | undefined,
): WorkspaceSearchMigrationControlCliOperation {
  if (
    command === 'apply' ||
    command === 'bootstrap-open' ||
    command === 'close-replan' ||
    command === 'execution-status' ||
    command === 'measure' ||
    command === 'release' ||
    command === 'rollback-complete' ||
    command === 'rollback-partial' ||
    command === 'status' ||
    command === 'verify'
  ) {
    return command
  }
  if (command === 'help' || command === '--help') return 'help'
  return 'unknown'
}

/**
 * Writes one compact deterministic JSON line.
 *
 * @param writer - Console writer.
 * @param value - Raw-value-free payload.
 * @param telemetryRecord - Optional serialized EMF fields for the same line.
 */
function writeJsonLine(
  writer: (value: string) => void,
  value: unknown,
  telemetryRecord?: string,
): void {
  writer(serializeJsonLine(value, telemetryRecord))
}

/**
 * Serializes the exact merged control and telemetry output once.
 *
 * @param value - Raw-value-free internal control payload.
 * @param telemetryRecord - Optional serialized EMF fields.
 * @returns Exact string written unchanged to the selected console stream.
 */
function serializeJsonLine(
  value: unknown,
  telemetryRecord?: string,
): string {
  return JSON.stringify(
    mergeControlCliTelemetryRecord(value, telemetryRecord),
  )
}

/**
 * Adds trusted serialized EMF fields without creating a second CLI line.
 * Invalid or non-object telemetry falls back to the original control payload.
 *
 * @param value - Raw-value-free control payload.
 * @param telemetryRecord - Optional serialized aggregate EMF object.
 * @returns One top-level object preserving all control result fields.
 */
function mergeControlCliTelemetryRecord(
  value: unknown,
  telemetryRecord?: string,
): unknown {
  if (telemetryRecord === undefined) return value
  try {
    const telemetryValue: unknown = JSON.parse(telemetryRecord)
    if (
      !isControlCliJsonRecord(value) ||
      !isControlCliJsonRecord(telemetryValue)
    ) {
      return value
    }
    return Object.assign({}, telemetryValue, value)
  } catch {
    return value
  }
}

/**
 * Checks one plain JSON object used only for final line composition.
 *
 * @param value - Candidate parsed telemetry or internal control payload.
 * @returns Whether the candidate is a non-array object.
 */
function isControlCliJsonRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (import.meta.main) {
  const controller = new AbortController()
  let signalExitCode: 130 | 143 | undefined
  /**
   * Records only the first process signal and requests cooperative shutdown.
   *
   * @param exitCode - Conventional process status for the signal.
   */
  const interrupt = (exitCode: 130 | 143): void => {
    if (signalExitCode !== undefined) return
    signalExitCode = exitCode
    controller.abort()
  }
  /** Requests cooperative shutdown for an interactive interrupt. */
  const handleSigint = (): void => interrupt(130)
  /** Requests cooperative shutdown for a termination signal. */
  const handleSigterm = (): void => interrupt(143)
  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)
  void runWorkspaceSearchMigrationControlCli(
    Bun.argv.slice(2),
    defaultControlCliDependencies,
    controller.signal,
  )
    .then((exitCode) => {
      process.off('SIGINT', handleSigint)
      process.off('SIGTERM', handleSigterm)
      process.exitCode =
        exitCode === 130 && signalExitCode !== undefined
          ? signalExitCode
          : exitCode
    })
    .catch(() => {
      process.off('SIGINT', handleSigint)
      process.off('SIGTERM', handleSigterm)
      process.exitCode = 1
    })
}
