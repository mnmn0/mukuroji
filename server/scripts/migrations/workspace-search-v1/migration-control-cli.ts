import {
  constants as fileSystemConstants,
  type BigIntStats,
} from 'node:fs'
import { open } from 'node:fs/promises'
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
  WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
  WorkspaceSearchMigrationDescribeTableRatePolicyError,
} from './migration-describe-table-rate-policy'
import {
  createAwsWorkspaceSearchMigrationRateManagedSession,
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
}

/** Capability-minimized dependencies retained by a read-only command. */
type WorkspaceSearchMigrationControlCliReadDependencies = Pick<
  WorkspaceSearchMigrationControlCliDependencies,
  'createReadSession'
>

/** Capability-minimized dependencies retained by a mutating command. */
type WorkspaceSearchMigrationControlCliMutationDependencies = Pick<
  WorkspaceSearchMigrationControlCliDependencies,
  'createMutationSession' | 'readInputFile'
>

/** File and read-session capabilities captured before the first CLI await. */
type WorkspaceSearchMigrationControlCliCapturedReadDependencies =
  WorkspaceSearchMigrationControlCliReadDependencies &
  Pick<WorkspaceSearchMigrationControlCliDependencies, 'readInputFile'>

/** File and mutation-session capabilities captured before the first CLI await. */
type WorkspaceSearchMigrationControlCliCapturedMutationDependencies =
  WorkspaceSearchMigrationControlCliMutationDependencies

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

const defaultControlCliDependencies:
  WorkspaceSearchMigrationControlCliDependencies = {
    createReadSession: createDefaultControlCliReadSession,
    createMutationSession: createDefaultControlCliMutationSession,
    readInputFile: readBoundedInputFile,
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
      result = await runReadOnlyCommand(
        configuration,
        ratePolicy,
        capturedDependencies,
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
      result = await runMutatingCommand(
        configuration,
        ratePolicy,
        capturedDependencies,
        signal,
      )
    }
    writeJsonLine(console.log, result)
    return 0
  } catch (error: unknown) {
    const failure = classifyControlCliFailure(error)
    writeJsonLine(console.error, {
      schemaVersion: 1,
      operation,
      status: 'error',
      code: failure.code,
    })
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
  let readInputFile:
    WorkspaceSearchMigrationControlCliDependencies['readInputFile']
  try {
    createReadSession = dependencies.createReadSession
    readInputFile = dependencies.readInputFile
  } catch {
    throw operationFailed()
  }
  if (
    typeof createReadSession !== 'function' ||
    typeof readInputFile !== 'function'
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    /** Invokes the captured read-session factory without retaining its owner. */
    createReadSession: (input) => createReadSession(input),
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
  let readInputFile:
    WorkspaceSearchMigrationControlCliDependencies['readInputFile']
  try {
    createMutationSession = dependencies.createMutationSession
    readInputFile = dependencies.readInputFile
  } catch {
    throw operationFailed()
  }
  if (
    typeof createMutationSession !== 'function' ||
    typeof readInputFile !== 'function'
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    /** Invokes the captured mutation factory without retaining its owner. */
    createMutationSession: (input) => createMutationSession(input),
    /** Invokes the captured file reader without retaining its owner. */
    readInputFile: (path, maximumBytes) =>
      readInputFile(path, maximumBytes),
  })
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
 * @param signal - Optional cooperative interruption signal.
 * @returns One secret-free success payload.
 */
async function runMutatingCommand(
  configuration:
    | WorkspaceSearchMigrationBootstrapOpenCliArguments
    | WorkspaceSearchMigrationCoordinatorCliArguments,
  ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy,
  dependencies: WorkspaceSearchMigrationControlCliMutationDependencies,
  signal?: AbortSignal,
): Promise<unknown> {
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
 * Creates the production read-only surface over one rate-managed session.
 *
 * @param input - Explicit resources and reviewed policy.
 * @returns Capability-minimized read session.
 */
async function createDefaultControlCliReadSession(
  input: CreateWorkspaceSearchMigrationControlCliReadSessionInput,
): Promise<WorkspaceSearchMigrationControlCliReadSession> {
  const managed = await createAwsWorkspaceSearchMigrationRateManagedSession({
    requested: input.resources,
    ratePolicy: input.ratePolicy,
    bootstrapRateCheckpoint: input.rateBootstrap,
    recoverInterruptedCleanup: input.rateRecoverInterruptedCleanup,
    recoverInterruptedAttempt: input.rateRecoverInterruptedAttempt,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  return createControlCliReadSession(managed)
}

/**
 * Creates the production mutation surface over one rate-managed session.
 *
 * @param input - Explicit resources, policy, and lifecycle authority.
 * @returns Capability-minimized mutating session.
 */
async function createDefaultControlCliMutationSession(
  input: CreateWorkspaceSearchMigrationControlCliMutationSessionInput,
): Promise<WorkspaceSearchMigrationControlCliMutationSession> {
  const managed = await createAwsWorkspaceSearchMigrationRateManagedSession({
    requested: input.resources,
    ratePolicy: input.ratePolicy,
    bootstrapRateCheckpoint: input.rateBootstrap,
    recoverInterruptedCleanup: input.rateRecoverInterruptedCleanup,
    recoverInterruptedAttempt: input.rateRecoverInterruptedAttempt,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  return createControlCliMutationSession(managed, input.resources)
}

/**
 * Narrows one managed session to read-only CLI operations.
 *
 * @param managed - Complete rate-managed migration session.
 * @returns Read-only control surface without mutation methods.
 */
function createControlCliReadSession(
  managed: WorkspaceSearchMigrationRateManagedAwsSession,
): WorkspaceSearchMigrationControlCliReadSession {
  return {
    measureConfigurationHash: async (): Promise<string> =>
      createWorkspaceSearchConfigurationHash(
        await managed.measureConfiguration(),
      ),
    readWriterFence: async () => summarizeWriterFence(
      await managed.createApplicationWriterFencePort().read(),
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
    readRateAggregate: () => managed.readDescribeTableRateEvidence(),
    interrupt: () => managed.interruptDescribeTableRate(),
    close: async () => await managed.close(),
  }
}

/**
 * Narrows one managed session to explicit CLI mutation operations.
 *
 * @param managed - Complete rate-managed migration session.
 * @param resources - Immutable resources rebound by subordinate measurements.
 * @returns Explicit mutating control surface.
 */
function createControlCliMutationSession(
  managed: WorkspaceSearchMigrationRateManagedAwsSession,
  resources: WorkspaceSearchMigrationRequestedResources,
): WorkspaceSearchMigrationControlCliMutationSession {
  return {
    measureConfigurationHash: async (): Promise<string> =>
      createWorkspaceSearchConfigurationHash(
        await managed.measureConfiguration(),
      ),
    acquireLease: async (input) => await managed.acquireLease(input),
    heartbeatLease: async (input) => await managed.heartbeatLease(input),
    renewMaintenanceEvidence: async (input) =>
      await managed.renewMaintenanceEvidence(input),
    readAuthority: async (claim) => await managed.readAuthority(claim),
    bootstrapWriterFence: async (authority) => summarizeWriterFence(
      await managed
        .createApplicationWriterFencePort()
        .bootstrapOpen(authority),
    ),
    advanceStage: async (input) =>
      await advanceDefaultCoordinatorStage(managed, input),
    createMaintenanceEvidenceProvider: (maintenanceEvidenceFile) =>
      createWorkspaceSearchMigrationFileEvidenceProvider({
        resources,
        evidenceFilePath: maintenanceEvidenceFile,
        readEvidenceFile: readMaintenanceEvidenceFile,
        createMeasurementSession: async () =>
          await managed.createRateManagedMeasurementSession(),
      }),
    readRateAggregate: () => managed.readDescribeTableRateEvidence(),
    runWithMutationAdmissionGuard: async (guard, task) =>
      await managed.runWithMutationAdmissionGuard(guard, task),
    interruptMutationAdmission: () =>
      managed.interruptMutationAdmission(),
    interrupt: () => managed.interruptDescribeTableRate(),
    close: async () => await managed.close(),
  }
}

/**
 * Reattaches the private managed session to one exact coordinator request.
 *
 * @param managed - Rate-managed session retained by the composition closure.
 * @param input - Capability-safe request supplied by CLI orchestration.
 * @returns Secret-free coordinator summary.
 */
async function advanceDefaultCoordinatorStage(
  managed: WorkspaceSearchMigrationRateManagedAwsSession,
  input: WorkspaceSearchMigrationControlCliStageRequest,
): Promise<WorkspaceSearchMigrationControlCoordinatorSummary> {
  if (input.mode === 'close-replan') {
    return await advanceWorkspaceSearchMigrationControlStage({
      ...input,
      session: managed,
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
 */
function writeJsonLine(
  writer: (value: string) => void,
  value: unknown,
): void {
  writer(JSON.stringify(value))
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
