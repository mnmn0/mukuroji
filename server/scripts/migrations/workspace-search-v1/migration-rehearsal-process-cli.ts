import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants as fileSystemConstants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { types as nodeUtilTypes } from 'node:util'
import type {
  CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  MINIMUM_MAINTENANCE_DRAIN_SECONDS,
  serializeCanonicalJson,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationControlCliArguments,
  readBoundedInputFile,
  type WorkspaceSearchMigrationControlCliArguments,
} from './migration-control-cli'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
} from './migration-describe-table-rate-policy'
import {
  parseWorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FD,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_FILE_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt,
  type WorkspaceSearchMigrationRehearsalNoFaultScenario,
} from './migration-rehearsal-control-cli'
import {
  claimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation,
  type ClaimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
} from './migration-identity-aws'
import {
  snapshotWorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultPlan,
} from './migration-rehearsal-faults'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
} from './migration-rehearsal-key-derivation'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
  type CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
} from './migration-rehearsal-permit-cli'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_FD,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
} from './migration-rehearsal-parent-liveness'
import {
  runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess,
  runWorkspaceSearchMigrationRehearsalProcess,
  runWorkspaceSearchMigrationRehearsalSuccessfulProcess,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_RUNTIME_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES,
  WorkspaceSearchMigrationRehearsalProcessRunnerError,
  type RunWorkspaceSearchMigrationRehearsalProcessInput,
  type RunWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessInput,
  type WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence,
  type WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialInput,
  type WorkspaceSearchMigrationRehearsalDurableFaultCompletionMaterialInput,
  type WorkspaceSearchMigrationRehearsalExpectedFaultReceipt,
  type WorkspaceSearchMigrationRehearsalProcessExitResult,
  type WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence,
  type WorkspaceSearchMigrationRehearsalProcessPort,
  type RunWorkspaceSearchMigrationRehearsalSuccessfulProcessInput,
  type WorkspaceSearchMigrationRehearsalDurableSuccessMaterialInput,
  type WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence,
} from './migration-rehearsal-process-runner'
import {
  verifyWorkspaceSearchMigrationRehearsalRateSegment,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import {
  authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
} from './migration-rehearsal-target-audit'
import type {
  WorkspaceSearchMigrationRehearsalStageChildMaterial,
} from './migration-rehearsal-stage-child-material'
import {
  verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
} from './migration-rehearsal-stage-fault-material'
import {
  createWorkspaceSearchMigrationRehearsalStageParentAuthentication,
} from './migration-rehearsal-stage-finalizer'
import {
  parseWorkspaceSearchMigrationRehearsalStageManifestDocument,
  parseWorkspaceSearchMigrationRehearsalStageReceiptDocument,
  selectWorkspaceSearchMigrationRehearsalStage,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  parseWorkspaceSearchMigrationRehearsalStageReservationDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_NONCE_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'

/** Exact operator acknowledgement required before a parent fault run. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL =
  'run-reviewed-non-production-migration-rehearsal-fault'

/** Exact operator acknowledgement required before an unfaulted terminal run. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_PROCESS_APPROVAL =
  'run-reviewed-non-production-migration-rehearsal-no-fault'

/** Exact operator acknowledgement for authenticated generic success. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROCESS_APPROVAL =
  'run-reviewed-non-production-migration-rehearsal-success'

/** Stable discriminator for parent-harness result lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-process-result'

/** Maximum canonical UTF-8 bytes accepted for one reviewed fault plan. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_FAULT_PLAN_MAX_BYTES =
  64 * 1_024

/** Maximum canonical bytes accepted by either immutable evidence file. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_EVIDENCE_MAX_BYTES =
  256 * 1_024

/** Maximum total time reserved for the post-terminal target audit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_BUDGET_MILLISECONDS =
  15 * 60 * 1_000

/** Maximum total time reserved for the post-terminal #163 integrity check. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_CHECK_BUDGET_MILLISECONDS =
  15 * 60 * 1_000

/** Time reserved for stage finalization and strong-read AWS commit recovery. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_BUDGET_MILLISECONDS =
  10 * 60 * 1_000

/** Explicit post-child audit, check, finalization, and commit budget. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZATION_SAFETY_MARGIN_MILLISECONDS =
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_BUDGET_MILLISECONDS +
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_CHECK_BUDGET_MILLISECONDS +
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_BUDGET_MILLISECONDS

/** Minimum useful runtime admitted for a non-draining rehearsal stage. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MINIMUM_CHILD_RUNTIME_MILLISECONDS =
  60 * 1_000

/** Fixed receipt evidence filename under the freshly created directory. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FILENAME =
  'fault-receipt.json'

/** Fixed lifecycle evidence filename under the freshly created directory. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME =
  'lifecycle.json'

/** Fresh child-owned append-only actual-rate segment filename. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME =
  'rate-segment.ndjson'

/** Parent-owned canonical no-fault receipt evidence filename. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_FILENAME =
  'no-fault-receipt.json'

/** Parent-owned authenticated generic-success child-material filename. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME =
  'stage-child-material.json'

/** Parent-owned authenticated stopped-fault boundary material filename. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME =
  'stage-fault-boundary-material.json'

/** Parent-owned authenticated response-loss completion material filename. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME =
  'stage-fault-completion-material.json'

/** Parent-owned immutable rate prefix captured before fault release. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME =
  'rate-segment-boundary.ndjson'

/** Parent-owned HMAC binding the persisted material and lifecycle wrappers. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME =
  'stage-parent-authentication.json'

/** Parent-owned immutable reservation persisted before remote claim. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME =
  'stage-reservation.json'

/** Fixed short-lived runtime-key filename never retained as evidence. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME =
  '.stage-runtime.key'

/** Maximum canonical FD3 bytes accepted for one no-fault receipt line. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_MAX_BYTES =
  64 * 1_024

/** Fixed sibling child script selected by the production spawn boundary. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_CHILD_SCRIPT =
  fileURLToPath(new URL('./migration-rehearsal-control-cli.ts', import.meta.url))

/** Strictly parsed parent-harness command. */
type WorkspaceSearchMigrationRehearsalProcessCliCommonArguments = {
  /** Restricted authenticated permit document read before generic-success spawn. */
  readonly permitFile: string
  /** Sole raw 32-byte master authentication-key path held by the parent. */
  readonly authenticationKeyFile: string
  /** New evidence directory that must not already exist. */
  readonly evidenceDirectory: string
  /** Reviewed measured non-production configuration digest. */
  readonly rateConfigurationHash: string
  /** Optional authenticated predecessor rate segment read-only path. */
  readonly ratePreviousSegmentFile?: string
  /** Required authenticated reviewed stage-manifest path. */
  readonly stageManifestFile: string
  /** Optional authenticated immediate predecessor stage-receipt path. */
  readonly previousStageReceiptFile?: string
  /** Required dual-key target preimage for a rollback apply stage. */
  readonly targetPreimageAuditFile?: string
  /** Existing control CLI arguments after the exact separator. */
  readonly controlArguments: readonly string[]
}

/** Strictly parsed parent-harness command with an explicit lifecycle mode. */
export type WorkspaceSearchMigrationRehearsalProcessCliArguments =
  WorkspaceSearchMigrationRehearsalProcessCliCommonArguments & (
    | {
      /** Selects the existing fault-plan-required parent protocol. */
      readonly executionMode: 'fault'
      /** Reviewed canonical one-shot fault-plan path. */
      readonly faultPlanFile: string
      /** No no-fault scenario may coexist with a fault plan. */
      readonly noFaultScenario?: never
      /** Exact reviewed fault-run acknowledgement. */
      readonly approval:
        typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL
    }
    | {
      /** Selects authenticated generic-success material and zero exit. */
      readonly executionMode: 'success'
      /** No fault-plan path may coexist with generic success. */
      readonly faultPlanFile?: never
      /** No legacy terminal scenario may coexist with generic success. */
      readonly noFaultScenario?: never
      /** Exact generic-success protocol contract. */
      readonly successProtocol:
        typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION
      /** Exact reviewed generic-success acknowledgement. */
      readonly approval:
        typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROCESS_APPROVAL
    }
  )

/** Result of one exclusive durable filesystem creation attempt. */
export type WorkspaceSearchMigrationRehearsalExclusiveCreateOutcome =
  | 'created'
  | 'exists'

/** Fixed evidence filenames accepted by the immutable writer boundary. */
export type WorkspaceSearchMigrationRehearsalEvidenceFilename =
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FILENAME
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_FILENAME
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME
  | typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME

/** Parent publications whose fixed temporary inode can be crash-normalized. */
const processCliRecoverablePublicationFilenames:
  readonly WorkspaceSearchMigrationRehearsalEvidenceFilename[] =
    Object.freeze([
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    ])

/** Publications required before material kind can be inferred safely. */
const processCliRecoveryFoundationPublicationFilenames:
  readonly WorkspaceSearchMigrationRehearsalEvidenceFilename[] =
    Object.freeze([
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    ])

/** Durable checkpoints exposed only for immutable-publication crash tests. */
export type WorkspaceSearchMigrationRehearsalEvidencePublicationCheckpoint =
  | 'temporary-file-durable'
  | 'final-link-created'
  | 'final-link-durable'
  | 'temporary-link-removed'

/** Optional deterministic crash control for one immutable file publication. */
export type WorkspaceSearchMigrationRehearsalEvidencePublicationDependencies = {
  /** Synchronous callback invoked at each durability transition. */
  readonly onCheckpoint?: (
    checkpoint:
      WorkspaceSearchMigrationRehearsalEvidencePublicationCheckpoint,
  ) => void
}

/** Durable checkpoints exposed for runtime-key crash recovery tests. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyPublicationCheckpoint =
  | 'runtime-file-created'
  | 'runtime-key-write-progress'
  | 'runtime-key-durable'

/** Optional deterministic runtime-key publication crash controls. */
export type WorkspaceSearchMigrationRehearsalRuntimeKeyPublicationDependencies = {
  /** Maximum bytes offered to each positioned runtime-key write. */
  readonly maximumWriteBytes?: number
  /** Synchronous callback invoked after each observable transition. */
  readonly onCheckpoint?: (
    checkpoint:
      WorkspaceSearchMigrationRehearsalRuntimeKeyPublicationCheckpoint,
  ) => void
}

/** One parent signal that triggers child-process containment. */
export type WorkspaceSearchMigrationRehearsalParentSignal =
  | 'SIGINT'
  | 'SIGTERM'

/** Removes one previously installed parent interruption listener. */
export type WorkspaceSearchMigrationRehearsalRemoveSignalHandler = () => void

/** Installs the two finite parent interruption listeners. */
export type WorkspaceSearchMigrationRehearsalInstallSignalHandler = (
  handler: (signal: WorkspaceSearchMigrationRehearsalParentSignal) => void,
) => WorkspaceSearchMigrationRehearsalRemoveSignalHandler

/** Spawn specification proving the executable and script are not operator-selected. */
export type WorkspaceSearchMigrationRehearsalChildSpawnSpecification = {
  /** Current trusted runtime executable. */
  readonly executable: string
  /** Fixed sibling script followed by the restricted child arguments. */
  readonly arguments: readonly string[]
  /** Child stdin is reserved for the one-way response-loss acknowledgement. */
  readonly stdin: 'pipe'
  /** Child stdout is bounded and digested by the lifecycle runner. */
  readonly stdout: 'pipe'
  /** Ordinary child diagnostics are discarded rather than parsed or exposed. */
  readonly stderr: 'ignore'
  /** Dedicated receipt protocol descriptor isolated from ordinary stderr. */
  readonly faultReceiptDescriptor: 3
  /** Dedicated receipt protocol descriptor is exposed as a pipe. */
  readonly faultReceipt: 'pipe'
  /** Silent descriptor whose EOF proves that the parent disappeared. */
  readonly parentLivenessDescriptor:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_FD
  /** Parent-owned liveness endpoint is exposed as a dedicated pipe. */
  readonly parentLiveness: 'pipe'
  /** Versioned semantics required by later abandonment validation. */
  readonly parentLivenessProtocol:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL
}

/** Injectable finite I/O and process boundary for the parent CLI. */
export type WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
  /** Reads one stable regular file through an inclusive byte ceiling. */
  readonly readInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one owner-only stage key through the secure no-follow reader. */
  readonly readStageKeyFile?: (path: string) => Promise<Uint8Array>
  /** Exclusively creates and durably syncs one mode-0700 directory. */
  readonly createEvidenceDirectoryExclusive: (
    directoryPath: string,
  ) => Promise<WorkspaceSearchMigrationRehearsalExclusiveCreateOutcome>
  /** Exclusively writes and durably syncs one fixed mode-0600 evidence file. */
  readonly writeEvidenceFileExclusive: (
    directoryPath: string,
    filename: WorkspaceSearchMigrationRehearsalEvidenceFilename,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<WorkspaceSearchMigrationRehearsalExclusiveCreateOutcome>
  /** Claims or revision-neutrally resumes the reservation before spawn. */
  readonly claimStageReservation?: (
    input:
      ClaimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalStageHead>
  /** Writes the fixed owner-only ephemeral runtime key before spawn. */
  readonly writeRuntimeKeyFileExclusive?: (
    directoryPath: string,
    key: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalExclusiveCreateOutcome>
  /** Durably zeroes and unlinks the fixed key through authenticated evidence. */
  readonly cleanupRuntimeKeyFile?: (
    input: CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization>
  /** Validates an existing owner-only directory contains only a reservation. */
  readonly validateReservationOnlyDirectory?: (
    directoryPath: string,
  ) => Promise<void>
  /** Trusted parent clock used for reservation and spawn admission. */
  readonly now?: () => Date
  /** Cryptographic parent entropy used only for a fresh reservation. */
  readonly randomBytes?: (size: number) => Uint8Array
  /** Starts only the fixed sibling rehearsal control child. */
  readonly spawnControlChild: (
    arguments_: readonly string[],
  ) => WorkspaceSearchMigrationRehearsalProcessPort
  /** Runs the fail-closed lifecycle protocol over the started child. */
  readonly runProcess: (
    input: RunWorkspaceSearchMigrationRehearsalProcessInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence>
  /** Runs the selection-bound authenticated one- or two-phase fault protocol. */
  readonly runAuthenticatedFaultProcess?: (
    input: RunWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence>
  /** Runs the distinct bounded no-fault completion protocol. */
  readonly runNoFaultProcess: (
    input: RunWorkspaceSearchMigrationRehearsalNoFaultProcessInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence>
  /** Runs the authenticated generic-success material protocol. */
  readonly runSuccessfulProcess?: (
    input: RunWorkspaceSearchMigrationRehearsalSuccessfulProcessInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence>
  /** Installs process-level containment listeners before the first await. */
  readonly installSignalHandler:
    WorkspaceSearchMigrationRehearsalInstallSignalHandler
  /** Emits one already canonical digest-only success line. */
  readonly writeStdoutLine: (serializedLine: string) => void
  /** Emits one already canonical stable-code failure line. */
  readonly writeStderrLine: (serializedLine: string) => void
}

/** Process dependencies after optional secure defaults are captured. */
type CapturedProcessCliDependencies =
  WorkspaceSearchMigrationRehearsalProcessCliDependencies & {
    /** Required standalone parent claim boundary. */
    readonly claimStageReservation: NonNullable<
      WorkspaceSearchMigrationRehearsalProcessCliDependencies[
        'claimStageReservation'
      ]
    >
    /** Required ephemeral runtime-key writer. */
    readonly writeRuntimeKeyFileExclusive: NonNullable<
      WorkspaceSearchMigrationRehearsalProcessCliDependencies[
        'writeRuntimeKeyFileExclusive'
      ]
    >
    /** Required durable ephemeral runtime-key cleanup boundary. */
    readonly cleanupRuntimeKeyFile: NonNullable<
      WorkspaceSearchMigrationRehearsalProcessCliDependencies[
        'cleanupRuntimeKeyFile'
      ]
    >
    /** Required resume-directory validator. */
    readonly validateReservationOnlyDirectory: NonNullable<
      WorkspaceSearchMigrationRehearsalProcessCliDependencies[
        'validateReservationOnlyDirectory'
      ]
    >
    /** Required trusted parent clock. */
    readonly now: NonNullable<
      WorkspaceSearchMigrationRehearsalProcessCliDependencies['now']
    >
    /** Required cryptographic parent entropy source. */
    readonly randomBytes: NonNullable<
      WorkspaceSearchMigrationRehearsalProcessCliDependencies['randomBytes']
    >
  }

/** Stable process statuses used by the parent harness. */
export type WorkspaceSearchMigrationRehearsalProcessCliExitCode =
  | 0
  | 1
  | 2
  | 130
  | 143

/** Stable raw-value-free parent-harness failures. */
type WorkspaceSearchMigrationRehearsalProcessCliFailureCode =
  | 'EVIDENCE_DIRECTORY_CREATE_FAILED'
  | 'EVIDENCE_DIRECTORY_EXISTS'
  | 'FAULT_RECEIPT_WRITE_FAILED'
  | 'FAULT_MATERIAL_WRITE_FAILED'
  | 'INTERRUPTED'
  | 'INVALID_FAULT_PLAN'
  | 'INVALID_USAGE'
  | 'LIFECYCLE_WRITE_FAILED'
  | 'NO_FAULT_RECEIPT_WRITE_FAILED'
  | 'PARENT_AUTHENTICATION_WRITE_FAILED'
  | 'SUCCESS_MATERIAL_WRITE_FAILED'
  | 'INVALID_STAGE_SELECTION'
  | 'OPERATION_FAILED'
  | 'PROCESS_FAILED'
  | 'SPAWN_FAILED'

/** Private stable parent-harness failure. */
class WorkspaceSearchMigrationRehearsalProcessCliFailure extends Error {
  /** Stable machine-readable raw-value-free classification. */
  readonly code: WorkspaceSearchMigrationRehearsalProcessCliFailureCode

  /** Exact process status paired with the classification. */
  readonly exitCode: WorkspaceSearchMigrationRehearsalProcessCliExitCode

  /**
   * Creates one stable parent-harness failure.
   *
   * @param code - Raw-value-free failure classification.
   * @param exitCode - Exact process status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalProcessCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalProcessCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalProcessCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Parent-persisted authenticated generic-success child material evidence. */
type WorkspaceSearchMigrationRehearsalChildMaterialEvidence = {
  /** Evidence schema discriminator. */
  readonly kind:
    'mukuroji-workspace-search-migration-rehearsal-child-material-evidence'
  /** First exact child-material evidence schema. */
  readonly evidenceVersion: 1
  /** Exact selection-bound HMAC-authenticated child material. */
  readonly material: WorkspaceSearchMigrationRehearsalStageChildMaterial
  /** Digest of the exact canonical child material. */
  readonly materialDigest: string
  /** Parent time when the complete canonical FD3 line was observed. */
  readonly observedAt: string
}

/** Parent-persisted authenticated stopped-fault boundary evidence. */
export type WorkspaceSearchMigrationRehearsalFaultBoundaryMaterialEvidence = {
  /** Fixed boundary-material evidence discriminator. */
  readonly kind:
    'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence'
  /** First exact boundary-material evidence schema. */
  readonly evidenceVersion: 1
  /** Exact selection-bound HMAC-authenticated boundary material. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Digest of the exact canonical boundary material. */
  readonly materialDigest: string
  /** Parent time when the complete first FD3 line was observed. */
  readonly observedAt: string
}

/** Parent-persisted authenticated response-loss completion evidence. */
export type WorkspaceSearchMigrationRehearsalFaultCompletionMaterialEvidence = {
  /** Fixed completion-material evidence discriminator. */
  readonly kind:
    'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence'
  /** First exact completion-material evidence schema. */
  readonly evidenceVersion: 1
  /** Exact boundary-bound HMAC-authenticated completion material. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial
  /** Digest of the exact canonical completion material. */
  readonly materialDigest: string
  /** Parent time when the complete second FD3 line was observed. */
  readonly observedAt: string
}

/** Durable no-fault receipt input passed across the parent fsync barrier. */
export type WorkspaceSearchMigrationRehearsalDurableNoFaultReceiptInput = {
  /** Exact validated scenario-bound child receipt. */
  readonly receipt: WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt
  /** Canonical digest of the exact child receipt. */
  readonly receiptSha256: string
  /** Parent time when the complete canonical line was observed. */
  readonly observedAt: string
}

/** Strict no-fault process lifecycle returned only after an ordinary zero exit. */
export type WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence = {
  /** First no-fault parent lifecycle contract. */
  readonly lifecycleVersion: 1
  /** Exact fixed scenario proven by the child receipt. */
  readonly scenario: WorkspaceSearchMigrationRehearsalNoFaultScenario
  /** Purpose preventing verification and rollback replay. */
  readonly purpose: 'verified' | 'complete-rollback'
  /** Exact terminal command admitted for the scenario. */
  readonly terminalCommand: 'verify' | 'rollback-complete'
  /** Exact authoritative terminal kind admitted for the scenario. */
  readonly terminalKind: 'verified' | 'rolled-back'
  /** Digest of the exact validated no-fault receipt. */
  readonly receiptSha256: string
  /** Parent time at which lifecycle supervision began. */
  readonly runnerStartedAt: string
  /** Parent time at which the complete FD3 receipt was observed. */
  readonly receiptObservedAt: string
  /** Parent time after the receipt evidence fsync completed. */
  readonly receiptPersistedAt: string
  /** Parent time at which an ordinary zero child exit was observed. */
  readonly processExitedAt: string
  /** Fixed successful no-fault process exit classification. */
  readonly exitClass: 'successful-no-fault'
}

/** Input for one bounded no-fault parent process runner invocation. */
export type RunWorkspaceSearchMigrationRehearsalNoFaultProcessInput = {
  /** Already-started fixed sibling child process. */
  readonly process: WorkspaceSearchMigrationRehearsalProcessPort
  /** Exact no-fault scenario selected before child execution. */
  readonly expectedScenario: WorkspaceSearchMigrationRehearsalNoFaultScenario
  /** Digest of the exact expected forwarded control arguments. */
  readonly expectedControlArgumentsDigest: string
  /** Reviewed configuration digest required from the child receipt. */
  readonly expectedConfigurationBindingDigest: string
  /** Whether the fresh segment must continue an authenticated predecessor. */
  readonly expectsPreviousRateSegment: boolean
  /** Receipt writer that must fsync before a run can succeed. */
  readonly persistNoFaultReceiptDurably: (
    input: WorkspaceSearchMigrationRehearsalDurableNoFaultReceiptInput,
    signal: AbortSignal,
  ) => Promise<void>
  /** Optional trusted clock for deterministic tests. */
  readonly now?: () => string
  /** Optional shorter test-only runtime timeout. */
  readonly runtimeTimeoutMilliseconds?: number
  /** Optional shorter test-only containment timeout. */
  readonly containmentTimeoutMilliseconds?: number
}

/** Canonical safe lifecycle document persisted after verified termination. */
type WorkspaceSearchMigrationRehearsalLifecycleEvidenceFile = {
  /** Evidence schema discriminator. */
  readonly kind: 'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence'
  /** Exact validated lifecycle returned by the parent runner. */
  readonly lifecycle:
    | WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence
  /** Canonical digest of the exact lifecycle value. */
  readonly lifecycleSha256: string
}

/** Mutable ordering state for one no-fault process runner invocation. */
type NoFaultProcessRunnerState = {
  /** Trusted canonical parent clock. */
  readonly now: () => string
  /** Most recent accepted parent timestamp. */
  lastTimestamp: string | undefined
  /** Whether durable receipt persistence authorized ordinary child exit. */
  releaseAuthorized: boolean
  /** Whether the child process adapter has reported an exit. */
  exitObserved: boolean
}

/** Validated and durably persisted no-fault receipt observation. */
type NoFaultReceiptObservation = {
  /** Exact strict child completion receipt. */
  readonly receipt: WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt
  /** Canonical digest of the exact child receipt. */
  readonly receiptSha256: string
  /** Parent time at which the complete receipt line was observed. */
  readonly observedAt: string
  /** Parent time after the receipt evidence fsync completed. */
  readonly persistedAt: string
}

/** Strict successful no-fault child exit observation. */
type NoFaultExitObservation = {
  /** Parent time at which the zero exit was observed. */
  readonly observedAt: string
}

/** Canonical permit retained only through parent claim preflight. */
type ProcessCliPermitBinding = {
  /** Exact parsed canonical permit document. */
  readonly permit: unknown
  /** Digest of the exact canonical permit document. */
  readonly permitDigest: string
}

/** Authenticated stage selection and its exact immediate receipt. */
type ProcessCliStageSelectionBinding = {
  /** Exact manifest entry selected for this process invocation. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Runtime-authenticated immediate predecessor, or null at stage one. */
  readonly previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null
}

/** Production-parsed mutating control command bound to one authenticated stage. */
type ProcessCliAuthenticatedControl = Exclude<
  WorkspaceSearchMigrationControlCliArguments,
  { readonly command: 'help' }
>

/** Reservation-derived child execution boundary captured before key release. */
type ProcessCliStageRunnerBoundary = {
  /** Trusted canonical clock that rejects the reservation-derived deadline. */
  readonly now: () => string
  /** Exact wall-clock timeout passed to the selected bounded child runner. */
  readonly runtimeTimeoutMilliseconds: number
}

/** Result of creating, resuming, or completing a parent process phase. */
type ProcessCliStagePreparation =
  | {
    /** Fresh or reservation-only work may proceed to the child boundary. */
    readonly phase: 'execute-child'
    /** Exact active reservation persisted before remote claim. */
    readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  }
  | {
    /** Completed child evidence was recovered without another child spawn. */
    readonly phase: 'parent-authentication-recovered'
    /** Exact reservation whose completed child evidence was recovered. */
    readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
    /** Parent-observed final child exit classification. */
    readonly exitClass:
      | 'successful-no-fault'
      | 'confirmed-sigkill'
      | 'successful-response-loss'
    /** Digest of the exact persisted parent lifecycle value. */
    readonly lifecycleSha256: string
    /** Authenticated child protocol digest exposed by the original run. */
    readonly receiptSha256: string
  }

/** Strict digest-only result recovered from one lifecycle wrapper. */
type ProcessCliRecoveredLifecycleResult = {
  /** Detached exact persisted lifecycle wrapper. */
  readonly persistedLifecycleEvidence: unknown
  /** Exact persisted lifecycle value retained for finalizer validation. */
  readonly lifecycle: object
  /** Parent-observed final child exit classification. */
  readonly exitClass:
    | 'successful-no-fault'
    | 'confirmed-sigkill'
    | 'successful-response-loss'
  /** Digest of the exact lifecycle value. */
  readonly lifecycleSha256: string
  /** Authenticated child protocol digest exposed by the original run. */
  readonly receiptSha256: string
}

/** Exact material shape inferred from an authenticated lifecycle exit. */
type ProcessCliRecoveryMaterialKind =
  | 'success'
  | 'fault-boundary'
  | 'fault-completion'

/** Default finite process, filesystem, and output boundary. */
const defaultProcessCliDependencies:
  WorkspaceSearchMigrationRehearsalProcessCliDependencies = Object.freeze({
    readInputFile: readBoundedInputFile,
    readStageKeyFile: (path): Promise<Uint8Array> =>
      readWorkspaceSearchMigrationRehearsalPermitSigningKey(path),
    createEvidenceDirectoryExclusive:
      createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive,
    writeEvidenceFileExclusive:
      writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive,
    claimStageReservation:
      claimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation,
    writeRuntimeKeyFileExclusive:
      writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive,
    cleanupRuntimeKeyFile:
      cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
    validateReservationOnlyDirectory:
      validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory,
    now: (): Date => new Date(),
    randomBytes: (size): Uint8Array => randomBytes(size),
    spawnControlChild:
      spawnWorkspaceSearchMigrationRehearsalControlChild,
    runProcess: runWorkspaceSearchMigrationRehearsalProcess,
    runAuthenticatedFaultProcess:
      runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess,
    runNoFaultProcess:
      runWorkspaceSearchMigrationRehearsalNoFaultProcess,
    runSuccessfulProcess:
      runWorkspaceSearchMigrationRehearsalSuccessfulProcess,
    installSignalHandler:
      installWorkspaceSearchMigrationRehearsalParentSignalHandler,
    writeStdoutLine: (serializedLine: string): void => {
      console.log(serializedLine)
    },
    writeStderrLine: (serializedLine: string): void => {
      console.error(serializedLine)
    },
  })

/**
 * Parses only the exact ordered reviewed parent-harness command.
 *
 * @param arguments_ - Arguments following the parent script path.
 * @returns Frozen detached paths, acknowledgement, and control arguments.
 */
export function parseWorkspaceSearchMigrationRehearsalProcessCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalProcessCliArguments {
  const snapshot = snapshotProcessCliArguments(arguments_)
  if (
    snapshot[0] !== '--rehearsal-permit-file' ||
    snapshot[2] !== '--rehearsal-authentication-key-file' ||
    snapshot[6] !== '--rehearsal-evidence-directory' ||
    snapshot[8] !== '--rehearsal-rate-configuration-hash'
  ) {
    throw invalidProcessCliUsage()
  }
  const permitFile = requireProcessCliPath(snapshot[1])
  const authenticationKeyFile = requireProcessCliPath(snapshot[3])
  const evidenceDirectory = requireProcessCliPath(snapshot[7])
  const rateConfigurationHash = snapshot[9]
  if (!isHexDigest(rateConfigurationHash)) throw invalidProcessCliUsage()
  let faultPlanFile: string | undefined
  let successProtocol:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION |
    undefined
  let expectedApproval: string
  if (snapshot[4] === '--rehearsal-fault-plan-file') {
    faultPlanFile = requireProcessCliPath(snapshot[5])
    expectedApproval = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL
  } else if (snapshot[4] === '--rehearsal-success-protocol') {
    if (
      snapshot[5] !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION
    ) {
      throw invalidProcessCliUsage()
    }
    successProtocol =
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION
    expectedApproval =
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROCESS_APPROVAL
  } else {
    throw invalidProcessCliUsage()
  }
  let cursor = 10
  let ratePreviousSegmentFile: string | undefined
  let stageManifestFile: string | undefined
  let previousStageReceiptFile: string | undefined
  let targetPreimageAuditFile: string | undefined
  if (snapshot[cursor] === '--rehearsal-rate-previous-segment-file') {
    ratePreviousSegmentFile = requireProcessCliPath(snapshot[cursor + 1])
    cursor += 2
  }
  if (snapshot[cursor] !== '--rehearsal-stage-manifest-file') {
    throw invalidProcessCliUsage()
  }
  stageManifestFile = requireProcessCliPath(snapshot[cursor + 1])
  cursor += 2
  if (snapshot[cursor] === '--rehearsal-previous-stage-receipt-file') {
    previousStageReceiptFile = requireProcessCliPath(snapshot[cursor + 1])
    cursor += 2
  }
  if (snapshot[cursor] === '--target-preimage-audit-file') {
    targetPreimageAuditFile = requireProcessCliPath(snapshot[cursor + 1])
    cursor += 2
  }
  if (
    snapshot[cursor] !== '--approval' ||
    snapshot[cursor + 1] !== expectedApproval ||
    snapshot[cursor + 2] !== '--'
  ) {
    throw invalidProcessCliUsage()
  }
  const controlArguments = snapshot.slice(cursor + 3)
  if (controlArguments.length === 0) throw invalidProcessCliUsage()
  const common = {
    permitFile,
    authenticationKeyFile,
    evidenceDirectory,
    rateConfigurationHash,
    ...(ratePreviousSegmentFile === undefined
      ? {}
      : { ratePreviousSegmentFile }),
    stageManifestFile,
    ...(previousStageReceiptFile === undefined
      ? {}
      : { previousStageReceiptFile }),
    ...(targetPreimageAuditFile === undefined
      ? {}
      : { targetPreimageAuditFile }),
    controlArguments: Object.freeze(controlArguments),
  }
  if (faultPlanFile !== undefined) {
    return Object.freeze({
      ...common,
      executionMode: 'fault',
      faultPlanFile,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL,
    })
  }
  if (successProtocol !== undefined) {
    return Object.freeze({
      ...common,
      executionMode: 'success',
      successProtocol,
      approval:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROCESS_APPROVAL,
    })
  }
  throw invalidProcessCliUsage()
}

/**
 * Parses one bounded exact canonical fault-plan document through strict guards.
 *
 * @param bytes - Untrusted finite file bytes.
 * @returns Frozen detached exact one-shot fault plan.
 */
export function parseWorkspaceSearchMigrationRehearsalCanonicalFaultPlan(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRehearsalFaultPlan {
  try {
    const snapshot = copyFaultPlanBytes(bytes)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot)
    const candidate: unknown = JSON.parse(text)
    const plan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(candidate)
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(plan),
    )
    if (!equalProcessCliBytes(snapshot, canonicalBytes)) {
      throw invalidFaultPlan()
    }
    return plan
  } catch {
    throw invalidFaultPlan()
  }
}

/**
 * Derives the exact pre-runtime receipt expectation from a strict fault plan.
 *
 * @param candidate - Already parsed or otherwise untrusted plan value.
 * @returns Frozen expected receipt with no runtime timestamp.
 */
export function createWorkspaceSearchMigrationRehearsalExpectedFaultReceipt(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalExpectedFaultReceipt {
  const plan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(candidate)
  return Object.freeze({
    receiptVersion: 1,
    stage: plan.stage,
    failpoint: plan.failpoint,
    action: plan.failpoint === 'planning-page-transaction-response-lost'
      ? 'response-loss'
      : 'barrier',
    target: plan.target,
    occurrence: 1,
  })
}

/**
 * Builds the fixed child script invocation passed to the trusted runtime.
 *
 * @param childArguments - Restricted child wrapper arguments.
 * @returns Frozen executable and argument specification.
 */
export function createWorkspaceSearchMigrationRehearsalChildSpawnSpecification(
  childArguments: readonly string[],
): WorkspaceSearchMigrationRehearsalChildSpawnSpecification {
  const argumentsSnapshot = snapshotChildArguments(childArguments)
  return Object.freeze({
    executable: process.execPath,
    arguments: Object.freeze([
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_CHILD_SCRIPT,
      ...argumentsSnapshot,
    ]),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    faultReceiptDescriptor:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FD,
    faultReceipt: 'pipe',
    parentLivenessDescriptor:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_FD,
    parentLiveness: 'pipe',
    parentLivenessProtocol:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL,
  })
}

/**
 * Starts only the fixed sibling control child with four isolated pipes.
 *
 * @param childArguments - Strict wrapper arguments selected by this parent.
 * @returns Parent-owned process port.
 */
export function spawnWorkspaceSearchMigrationRehearsalControlChild(
  childArguments: readonly string[],
): WorkspaceSearchMigrationRehearsalProcessPort {
  const specification =
    createWorkspaceSearchMigrationRehearsalChildSpawnSpecification(
      childArguments,
    )
  let child: ChildProcess
  try {
    child = spawn(
      specification.executable,
      specification.arguments,
      {
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
  } catch {
    throw spawnFailed()
  }
  const stdin = child.stdin
  const stdout = child.stdout
  const receiptStream = child.stdio[3]
  const parentLivenessStream = child.stdio[
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_FD
  ]
  if (
    !(stdin instanceof Writable) ||
    !(stdout instanceof Readable) ||
    !(receiptStream instanceof Readable) ||
    !(parentLivenessStream instanceof Writable)
  ) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Invalid spawn surfaces are contained before the stable failure.
    }
    throw spawnFailed()
  }
  return createWorkspaceSearchMigrationRehearsalNodeProcessPort(
    child,
    stdin,
    stdout,
    receiptStream,
    parentLivenessStream,
  )
}

/**
 * Runs one reviewed parent fault process and persists both evidence documents.
 *
 * Generic success authenticates the canonical permit, shared key binding, and
 * exact stage selection before creating the one-shot evidence directory or
 * spawning. Raw key and permit contents never enter outward evidence; all
 * outward lines contain only a stable code or verified digests and exit class.
 *
 * @param arguments_ - Exact ordered reviewed command.
 * @param dependencies - Injectable finite process and durability boundary.
 * @returns Stable parent-harness process status.
 */
export async function runWorkspaceSearchMigrationRehearsalProcessCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalProcessCliDependencies =
      defaultProcessCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalProcessCliExitCode> {
  let writeStdoutLine = defaultProcessCliDependencies.writeStdoutLine
  let writeStderrLine = defaultProcessCliDependencies.writeStderrLine
  /** Removes the exact parent signal handlers installed for this invocation. */
  let removeSignalHandler: WorkspaceSearchMigrationRehearsalRemoveSignalHandler =
    (): void => {}
  let cleanupRuntimeKeyFile =
    cleanupWorkspaceSearchMigrationRehearsalRuntimeKey
  /** Trusted clock retained for bounded runtime-key cleanup in `finally`. */
  let cleanupNow = (): Date => new Date()
  let runtimeKeyDirectory: string | undefined
  let interruptedSignal: WorkspaceSearchMigrationRehearsalParentSignal | undefined
  let child: WorkspaceSearchMigrationRehearsalProcessPort | undefined
  let stageMasterKey: Uint8Array | undefined
  let stageKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  let stageReservation:
    WorkspaceSearchMigrationRehearsalStageReservation | undefined
  let selectedStage:
    WorkspaceSearchMigrationRehearsalSelectedStage | undefined
  let runtimeKeyFileCreated = false
  let persistedSuccessMaterialEvidence: unknown = undefined
  let persistedFaultBoundaryMaterialEvidence: unknown = undefined
  let persistedFaultCompletionMaterialEvidence: unknown = undefined
  let faultBoundaryMaterial:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial | undefined
  let faultBoundaryRateSegmentBytes: Uint8Array | undefined
  let faultFinalRateSegmentBytes: Uint8Array | undefined
  let completed = false
  try {
    const captured = snapshotProcessCliDependencies(dependencies)
    writeStdoutLine = captured.writeStdoutLine
    writeStderrLine = captured.writeStderrLine
    cleanupRuntimeKeyFile = captured.cleanupRuntimeKeyFile
    cleanupNow = captured.now
    removeSignalHandler = captured.installSignalHandler((signal): void => {
      if (interruptedSignal !== undefined) return
      interruptedSignal = signal
      if (child !== undefined) void bestEffortContainChild(child)
    })
    if (!isDirectProcessCliFunction(removeSignalHandler)) {
      throw operationFailed()
    }

    const configuration =
      parseWorkspaceSearchMigrationRehearsalProcessCliArguments(arguments_)
    requireProcessCliNotInterrupted(interruptedSignal)
    const faultPlan = configuration.executionMode === 'fault'
      ? parseWorkspaceSearchMigrationRehearsalCanonicalFaultPlan(
          await readProcessCliFaultPlan(
            configuration.faultPlanFile,
            captured,
          ),
        )
      : undefined
    stageMasterKey = await readProcessCliStageKey(
      configuration.authenticationKeyFile,
      captured,
    )
    const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(
      stageMasterKey,
    )
    stageKey = derivedKeys.runtimeKey
    publicationKey = derivedKeys.publicationKey
    const permitBinding = await readProcessCliPermitKeyBinding(
      configuration,
      stageKey,
      publicationKey,
      captured,
    )
    zeroizeProcessCliKey(stageMasterKey)
    stageMasterKey = undefined
    const stageSelection = await readProcessCliStageSelection(
      configuration,
      faultPlan === undefined ? null : createMigrationDigest(faultPlan),
      stageKey,
      captured,
    )
    selectedStage = stageSelection.selection
    if (
      selectedStage.manifest.permitDigest !== permitBinding.permitDigest ||
      selectedStage.manifest.configurationBindingDigest !==
        configuration.rateConfigurationHash
    ) {
      throw invalidProcessCliStageSelection()
    }
    const actualControl = parseProcessCliAuthenticatedControl(
      configuration.controlArguments,
      selectedStage,
    )
    const expectedPreviousRateSegment =
      await readProcessCliExpectedPreviousRateSegment(
        configuration,
        selectedStage,
        stageSelection.previousReceipt,
        stageKey,
        captured,
      )
    const expectedTargetPreimageArtifactContentDigest =
      await readProcessCliExpectedTargetPreimageArtifactContentDigest(
        configuration,
        selectedStage,
        stageSelection.previousReceipt,
        stageKey,
        publicationKey,
        captured,
      )
    const stagePreparation = await prepareProcessCliStageReservation(
      configuration,
      selectedStage,
      expectedPreviousRateSegment,
      expectedTargetPreimageArtifactContentDigest,
      permitBinding.permit,
      stageKey,
      publicationKey,
      faultPlan,
      captured,
    )
    stageReservation = stagePreparation.reservation
    if (stagePreparation.phase === 'parent-authentication-recovered') {
      requireProcessCliNotInterrupted(interruptedSignal)
      writeStdoutLine(serializeCanonicalJson({
        exitClass: stagePreparation.exitClass,
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
        lifecycleSha256: stagePreparation.lifecycleSha256,
        receiptSha256: stagePreparation.receiptSha256,
        status: 'succeeded',
      }))
      completed = true
      return 0
    }
    await claimProcessCliStageReservation(
      actualControl,
      selectedStage,
      permitBinding.permit,
      stageReservation,
      stageSelection.previousReceipt,
      stageKey,
      publicationKey,
      captured,
    )
    requireProcessCliNotInterrupted(interruptedSignal)

    const runnerBoundary = createProcessCliStageRunnerBoundary(
      stageReservation,
      selectedStage.entry.command,
      captured.now,
    )
    const runtimeKeyOutcome = await captured.writeRuntimeKeyFileExclusive(
      configuration.evidenceDirectory,
      stageKey,
    )
    if (runtimeKeyOutcome !== 'created') {
      throw invalidProcessCliStageSelection()
    }
    runtimeKeyFileCreated = true
    runtimeKeyDirectory = configuration.evidenceDirectory
    requireProcessCliNotInterrupted(interruptedSignal)

    const runtimeKeyPath = join(
      configuration.evidenceDirectory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    )
    const childArguments = createRehearsalControlChildArguments(
      configuration,
      runtimeKeyPath,
    )
    try {
      child = captured.spawnControlChild(childArguments)
    } catch {
      throw spawnFailed()
    }
    requireProcessCliNotInterrupted(interruptedSignal)
    const activeChild = child
    let lifecycle:
      | WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence
      | WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence
      | WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence
      | WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence
    if (configuration.executionMode === 'fault') {
      const runAuthenticatedFaultProcess =
        captured.runAuthenticatedFaultProcess
      if (
        runAuthenticatedFaultProcess === undefined ||
        faultPlan === undefined ||
        selectedStage === undefined ||
        stageKey === undefined
      ) throw operationFailed()
      const authenticatedStageKey = stageKey
      const authenticatedSelectedStage = selectedStage
      lifecycle = await runAuthenticatedFaultProcess({
        process: activeChild,
        expectedSelection: selectedStage,
        expectedFaultPlan: faultPlan,
        verificationKey: stageKey,
        now: runnerBoundary.now,
        runtimeTimeoutMilliseconds:
          runnerBoundary.runtimeTimeoutMilliseconds,
        containmentTimeoutMilliseconds:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
        readRateSegmentBytes: async (_phase, _signal): Promise<Uint8Array> =>
          await readProcessCliRateSegment(
            configuration.evidenceDirectory,
            captured,
          ),
        persistBoundaryMaterialDurably: async (
          input,
          signal,
        ): Promise<void> => {
          if (
            persistedFaultBoundaryMaterialEvidence !== undefined ||
            faultBoundaryMaterial !== undefined ||
            faultBoundaryRateSegmentBytes !== undefined
          ) throw faultMaterialWriteFailed()
          const rateSegmentBytes = await readProcessCliRateSegment(
            configuration.evidenceDirectory,
            captured,
          )
          let material:
            WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
          try {
            material =
              verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
                material: input.material,
                selection: authenticatedSelectedStage,
                faultPlan,
                rateSegmentBytes,
                verificationKey: authenticatedStageKey,
              })
          } catch {
            throw faultMaterialWriteFailed()
          }
          if (createMigrationDigest(material) !== input.materialDigest) {
            throw faultMaterialWriteFailed()
          }
          await persistFaultBoundaryRateSegment(
            configuration.evidenceDirectory,
            rateSegmentBytes,
            material.rateSegment.segmentDigest,
            signal,
            captured,
          )
          const evidence = await persistFaultBoundaryMaterialEvidence(
            configuration.evidenceDirectory,
            Object.freeze({
              material,
              materialDigest: input.materialDigest,
              observedAt: input.observedAt,
            }),
            signal,
            captured,
          )
          persistedFaultBoundaryMaterialEvidence = evidence
          faultBoundaryMaterial = material
          faultBoundaryRateSegmentBytes = new Uint8Array(rateSegmentBytes)
        },
        persistCompletionMaterialDurably: async (
          input,
          signal,
        ): Promise<void> => {
          if (
            persistedFaultCompletionMaterialEvidence !== undefined ||
            faultFinalRateSegmentBytes !== undefined ||
            persistedFaultBoundaryMaterialEvidence === undefined ||
            faultBoundaryMaterial === undefined ||
            faultBoundaryRateSegmentBytes === undefined
          ) throw faultMaterialWriteFailed()
          const finalRateSegmentBytes = await readProcessCliRateSegment(
            configuration.evidenceDirectory,
            captured,
          )
          let material:
            WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial
          try {
            material =
              verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
                material: input.material,
                selection: authenticatedSelectedStage,
                faultPlan,
                boundaryMaterial: faultBoundaryMaterial,
                boundaryRateSegmentBytes: faultBoundaryRateSegmentBytes,
                finalRateSegmentBytes,
                verificationKey: authenticatedStageKey,
              })
          } catch {
            throw faultMaterialWriteFailed()
          }
          if (createMigrationDigest(material) !== input.materialDigest) {
            throw faultMaterialWriteFailed()
          }
          const evidence = await persistFaultCompletionMaterialEvidence(
            configuration.evidenceDirectory,
            Object.freeze({
              material,
              materialDigest: input.materialDigest,
              observedAt: input.observedAt,
            }),
            signal,
            captured,
          )
          persistedFaultCompletionMaterialEvidence = evidence
          faultFinalRateSegmentBytes = new Uint8Array(finalRateSegmentBytes)
        },
      })
    } else if (configuration.executionMode === 'success') {
      const runSuccessfulProcess = captured.runSuccessfulProcess
      if (
        runSuccessfulProcess === undefined ||
        selectedStage === undefined ||
        stageKey === undefined
      ) {
        throw operationFailed()
      }
      lifecycle = await runSuccessfulProcess({
        process: activeChild,
        expectedSelection: selectedStage,
        verificationKey: stageKey,
        now: runnerBoundary.now,
        runtimeTimeoutMilliseconds:
          runnerBoundary.runtimeTimeoutMilliseconds,
        containmentTimeoutMilliseconds:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
        persistSuccessMaterialDurably: async (
          input,
          signal,
        ): Promise<void> => {
          if (persistedSuccessMaterialEvidence !== undefined) {
            throw successMaterialWriteFailed()
          }
          persistedSuccessMaterialEvidence =
            await persistSuccessMaterialEvidence(
            configuration.evidenceDirectory,
            input,
            signal,
            captured,
          )
        },
      })
    } else {
      throw operationFailed()
    }
    requireProcessCliFinalizationWindow(
      stageReservation,
      readProcessCliTrustedDate(captured.now),
    )
    requireProcessCliNotInterrupted(interruptedSignal)
    const lifecycleSha256 = createMigrationDigest(lifecycle)
    const persistedLifecycleEvidence = await persistLifecycleEvidence(
      configuration.evidenceDirectory,
      lifecycle,
      lifecycleSha256,
      captured,
    )
    requireProcessCliNotInterrupted(interruptedSignal)
    let runtimeKeyCleanupAuthorization:
      WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization |
      undefined
    if (
      configuration.executionMode === 'fault' ||
      configuration.executionMode === 'success'
    ) {
      if (
        selectedStage === undefined ||
        stageKey === undefined ||
        publicationKey === undefined
      ) {
        throw operationFailed()
      }
      try {
        runtimeKeyCleanupAuthorization =
          await captured.cleanupRuntimeKeyFile({
            evidenceDirectory: configuration.evidenceDirectory,
            reservation: stageReservation,
            selection: selectedStage,
            expectedRuntimeKey: stageKey,
            publicationAuthenticationKey: publicationKey,
            now: captured.now,
          })
        runtimeKeyFileCreated = false
      } catch {
        throw operationFailed()
      }
      let parentAuthentication: unknown
      if (configuration.executionMode === 'success') {
        if (
          persistedSuccessMaterialEvidence === undefined ||
          persistedFaultBoundaryMaterialEvidence !== undefined ||
          persistedFaultCompletionMaterialEvidence !== undefined ||
          faultBoundaryRateSegmentBytes !== undefined ||
          faultFinalRateSegmentBytes !== undefined
        ) throw operationFailed()
        parentAuthentication =
          createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
            materialKind: 'success',
            selection: selectedStage,
            persistedMaterialEvidence: persistedSuccessMaterialEvidence,
            persistedLifecycleEvidence,
            runtimeKeyCleanupAuthorization,
            runtimeAuthenticationKey: stageKey,
            publicationAuthenticationKey: publicationKey,
          })
      } else if (lifecycle.exitClass === 'confirmed-sigkill') {
        if (
          faultPlan === undefined ||
          persistedFaultBoundaryMaterialEvidence === undefined ||
          persistedFaultCompletionMaterialEvidence !== undefined ||
          faultBoundaryRateSegmentBytes === undefined ||
          faultFinalRateSegmentBytes !== undefined ||
          persistedSuccessMaterialEvidence !== undefined
        ) throw operationFailed()
        parentAuthentication =
          createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
            materialKind: 'fault-boundary',
            selection: selectedStage,
            persistedMaterialEvidence:
              persistedFaultBoundaryMaterialEvidence,
            persistedLifecycleEvidence,
            faultPlan,
            boundaryRateSegmentBytes: faultBoundaryRateSegmentBytes,
            runtimeKeyCleanupAuthorization,
            runtimeAuthenticationKey: stageKey,
            publicationAuthenticationKey: publicationKey,
          })
      } else if (lifecycle.exitClass === 'successful-response-loss') {
        if (
          faultPlan === undefined ||
          persistedFaultBoundaryMaterialEvidence === undefined ||
          persistedFaultCompletionMaterialEvidence === undefined ||
          faultBoundaryRateSegmentBytes === undefined ||
          faultFinalRateSegmentBytes === undefined ||
          persistedSuccessMaterialEvidence !== undefined
        ) throw operationFailed()
        parentAuthentication =
          createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
            materialKind: 'fault-completion',
            selection: selectedStage,
            persistedMaterialEvidence:
              persistedFaultCompletionMaterialEvidence,
            persistedBoundaryMaterialEvidence:
              persistedFaultBoundaryMaterialEvidence,
            persistedLifecycleEvidence,
            faultPlan,
            boundaryRateSegmentBytes: faultBoundaryRateSegmentBytes,
            finalRateSegmentBytes: faultFinalRateSegmentBytes,
            runtimeKeyCleanupAuthorization,
            runtimeAuthenticationKey: stageKey,
            publicationAuthenticationKey: publicationKey,
          })
      } else {
        throw operationFailed()
      }
      await persistStageParentAuthentication(
        configuration.evidenceDirectory,
        parentAuthentication,
        captured,
      )
      requireProcessCliFinalizationWindow(
        stageReservation,
        readProcessCliTrustedDate(captured.now),
      )
      requireProcessCliNotInterrupted(interruptedSignal)
    }
    if (runtimeKeyCleanupAuthorization === undefined) {
      throw operationFailed()
    }
    writeStdoutLine(serializeCanonicalJson({
      exitClass: lifecycle.exitClass,
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
      lifecycleSha256,
      receiptSha256: readProcessCliLifecycleProtocolDigest(lifecycle),
      status: 'succeeded',
    }))
    completed = true
    return 0
  } catch (error: unknown) {
    const failure = classifyProcessCliFailure(error, interruptedSignal)
    writeProcessCliFailureLine(writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    try {
      removeSignalHandler()
    } catch {
      // Listener cleanup cannot replace the authoritative process outcome.
    }
    if (!completed && child !== undefined) {
      await bestEffortContainChild(child)
    }
    if (
      runtimeKeyFileCreated &&
      runtimeKeyDirectory !== undefined &&
      stageReservation !== undefined &&
      selectedStage !== undefined &&
      stageKey !== undefined &&
      publicationKey !== undefined
    ) {
      try {
        await cleanupRuntimeKeyFile({
          evidenceDirectory: runtimeKeyDirectory,
          reservation: stageReservation,
          selection: selectedStage,
          expectedRuntimeKey: stageKey,
          publicationAuthenticationKey: publicationKey,
          now: cleanupNow,
        })
        runtimeKeyFileCreated = false
      } catch {
        // Cleanup failure cannot authorize success or another child spawn.
      }
    }
    zeroizeProcessCliKey(stageMasterKey)
    zeroizeProcessCliKey(stageKey)
    zeroizeProcessCliKey(publicationKey)
  }
}

/**
 * Runs one bounded no-fault child protocol without admitting arbitrary success.
 *
 * The child must emit exactly one canonical scenario-bound FD3 receipt after
 * its durable rate runtime is closed. This parent fsyncs that receipt, sends a
 * digest-bound acknowledgement, and then requires an ordinary zero exit.
 * Stdout is bounded and discarded; ordinary child stderr is never connected.
 *
 * @param input - Fixed child, scenario bindings, durable writer, and bounds.
 * @returns Frozen lifecycle evidence after persistence and zero exit.
 */
export async function runWorkspaceSearchMigrationRehearsalNoFaultProcess(
  input: RunWorkspaceSearchMigrationRehearsalNoFaultProcessInput,
): Promise<WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence> {
  const outcome = readProcessCliNoFaultOutcome(input.expectedScenario)
  if (
    !isHexDigest(input.expectedControlArgumentsDigest) ||
    !isHexDigest(input.expectedConfigurationBindingDigest) ||
    typeof input.expectsPreviousRateSegment !== 'boolean' ||
    !isDirectProcessCliFunction(input.persistNoFaultReceiptDurably)
  ) {
    throw processFailed()
  }
  requireNoFaultProcessPort(input.process)
  const now = input.now ?? defaultNoFaultProcessClock
  if (!isDirectProcessCliFunction(now)) throw processFailed()
  const runtimeTimeoutMilliseconds = readNoFaultProcessTimeout(
    input.runtimeTimeoutMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_RUNTIME_MILLISECONDS,
  )
  const containmentTimeoutMilliseconds = readNoFaultProcessTimeout(
    input.containmentTimeoutMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
  )
  const state: NoFaultProcessRunnerState = {
    now,
    lastTimestamp: undefined,
    releaseAuthorized: false,
    exitObserved: false,
  }
  const runnerStartedAt = readNoFaultProcessTimestamp(state)
  const persistenceController = new AbortController()
  const stdoutPromise = consumeBoundedNoFaultProcessOutput(
    input.process.stdout,
  )
  const receiptPromise = readNoFaultProcessReceipt(
    input.process.stderr,
    input,
    state,
    persistenceController.signal,
  )
  const exitPromise = observeNoFaultProcessExit(input.process, state)
  let receiptObservation: NoFaultReceiptObservation
  let exitObservation: NoFaultExitObservation
  try {
    const completion = await runNoFaultProcessWithTimeout(
      Promise.all([stdoutPromise, receiptPromise, exitPromise]),
      runtimeTimeoutMilliseconds,
    )
    receiptObservation = completion[1]
    exitObservation = completion[2]
  } catch (error: unknown) {
    persistenceController.abort()
    await containNoFaultProcess(
      input.process,
      containmentTimeoutMilliseconds,
    )
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
      throw error
    }
    throw processFailed()
  }
  if (exitObservation.observedAt < receiptObservation.persistedAt) {
    throw processFailed()
  }
  return Object.freeze({
    lifecycleVersion: 1,
    scenario: outcome.scenario,
    purpose: outcome.purpose,
    terminalCommand: outcome.terminalCommand,
    terminalKind: outcome.terminalKind,
    receiptSha256: receiptObservation.receiptSha256,
    runnerStartedAt,
    receiptObservedAt: receiptObservation.observedAt,
    receiptPersistedAt: receiptObservation.persistedAt,
    processExitedAt: exitObservation.observedAt,
    exitClass: 'successful-no-fault',
  })
}

/** Best-effort hard-kills and finitely reaps a failed no-fault child. */
async function containNoFaultProcess(
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
  timeoutMilliseconds: number,
): Promise<void> {
  try {
    await settleNoFaultContainmentStep(
      Promise.resolve(processPort.kill('SIGKILL')),
      timeoutMilliseconds,
    )
    await settleNoFaultContainmentStep(
      Promise.resolve(processPort.exited),
      timeoutMilliseconds,
    )
  } catch {
    // The already selected no-fault failure remains authoritative.
  }
}

/** Bounds one no-fault containment operation without exposing its failure. */
async function settleNoFaultContainmentStep(
  operation: Promise<unknown>,
  timeoutMilliseconds: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMilliseconds)
  })
  try {
    await Promise.race([
      operation.then((): void => {}, (): void => {}),
      deadline,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/** Bounds and discards child stdout without retaining or evidencing its body. */
async function consumeBoundedNoFaultProcessOutput(
  output: AsyncIterable<Uint8Array>,
): Promise<void> {
  let byteLength = 0
  try {
    for await (const chunk of output) {
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        throw processFailed()
      }
      if (
        chunk.byteLength >
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_STDOUT_BYTES - byteLength
      ) {
        throw processFailed()
      }
      byteLength += chunk.byteLength
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
      throw error
    }
    throw processFailed()
  }
}

/** Reads, validates, persists, and acknowledges one exact FD3 receipt line. */
async function readNoFaultProcessReceipt(
  output: AsyncIterable<Uint8Array>,
  input: RunWorkspaceSearchMigrationRehearsalNoFaultProcessInput,
  state: NoFaultProcessRunnerState,
  persistenceSignal: AbortSignal,
): Promise<NoFaultReceiptObservation> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let byteLength = 0
  let pending = ''
  let observation: NoFaultReceiptObservation | undefined
  try {
    for await (const chunk of output) {
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        throw processFailed()
      }
      if (
        chunk.byteLength >
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_MAX_BYTES -
            byteLength
      ) {
        throw processFailed()
      }
      byteLength += chunk.byteLength
      pending += decoder.decode(chunk, { stream: true })
      let newlineIndex = pending.indexOf('\n')
      while (newlineIndex >= 0) {
        if (observation !== undefined) throw processFailed()
        const line = pending.slice(0, newlineIndex)
        pending = pending.slice(newlineIndex + 1)
        observation = await acceptNoFaultProcessReceiptLine(
          line,
          input,
          state,
          persistenceSignal,
        )
        newlineIndex = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
      throw error
    }
    throw processFailed()
  }
  if (
    byteLength === 0 ||
    pending.length !== 0 ||
    observation === undefined
  ) {
    throw processFailed()
  }
  return observation
}

/** Validates and durably authorizes one complete no-fault receipt line. */
async function acceptNoFaultProcessReceiptLine(
  line: string,
  input: RunWorkspaceSearchMigrationRehearsalNoFaultProcessInput,
  state: NoFaultProcessRunnerState,
  persistenceSignal: AbortSignal,
): Promise<NoFaultReceiptObservation> {
  if (line.length === 0 || line.includes('\r')) throw processFailed()
  let candidate: unknown
  try {
    candidate = JSON.parse(line)
  } catch {
    throw processFailed()
  }
  if (serializeCanonicalJson(candidate) !== line) throw processFailed()
  let receipt: WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt
  try {
    receipt =
      parseWorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt(candidate)
  } catch {
    throw processFailed()
  }
  const outcome = readProcessCliNoFaultOutcome(input.expectedScenario)
  if (
    receipt.kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_KIND ||
    receipt.scenario !== outcome.scenario ||
    receipt.purpose !== outcome.purpose ||
    receipt.terminalCommand !== outcome.terminalCommand ||
    receipt.terminalKind !== outcome.terminalKind ||
    receipt.controlArgumentsDigest !== input.expectedControlArgumentsDigest ||
    receipt.configurationBindingDigest !==
      input.expectedConfigurationBindingDigest ||
    (input.expectsPreviousRateSegment
      ? receipt.rateSegment.segmentOrdinal < 1
      : receipt.rateSegment.segmentOrdinal !== 0) ||
    state.exitObserved
  ) {
    throw processFailed()
  }
  const observedAt = readNoFaultProcessTimestamp(state)
  const receiptSha256 = createMigrationDigest(receipt)
  try {
    await input.persistNoFaultReceiptDurably(
      Object.freeze({ receipt, receiptSha256, observedAt }),
      persistenceSignal,
    )
  } catch {
    throw noFaultReceiptWriteFailed()
  }
  if (state.exitObserved) throw processFailed()
  const persistedAt = readNoFaultProcessTimestamp(state)
  state.releaseAuthorized = true
  try {
    await input.process.acknowledgeResponseLoss(receiptSha256)
  } catch {
    throw processFailed()
  }
  return Object.freeze({
    receipt,
    receiptSha256,
    observedAt,
    persistedAt,
  })
}

/** Observes only an acknowledgement-authorized ordinary zero child exit. */
async function observeNoFaultProcessExit(
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
  state: NoFaultProcessRunnerState,
): Promise<NoFaultExitObservation> {
  let exit: WorkspaceSearchMigrationRehearsalProcessExitResult
  try {
    exit = await processPort.exited
  } catch {
    throw processFailed()
  }
  state.exitObserved = true
  if (
    !state.releaseAuthorized ||
    exit.kind !== 'exit-code' ||
    exit.exitCode !== 0
  ) {
    throw processFailed()
  }
  return Object.freeze({ observedAt: readNoFaultProcessTimestamp(state) })
}

/** Requires a minimally complete direct no-fault process adapter. */
function requireNoFaultProcessPort(
  processPort: WorkspaceSearchMigrationRehearsalProcessPort,
): void {
  if (
    typeof processPort !== 'object' ||
    processPort === null ||
    nodeUtilTypes.isProxy(processPort) ||
    typeof processPort.stdout?.[Symbol.asyncIterator] !== 'function' ||
    typeof processPort.stderr?.[Symbol.asyncIterator] !== 'function' ||
    !(processPort.exited instanceof Promise) ||
    !isDirectProcessCliFunction(processPort.kill) ||
    !isDirectProcessCliFunction(processPort.acknowledgeResponseLoss)
  ) {
    throw processFailed()
  }
}

/** Races one no-fault lifecycle against its finite runtime deadline. */
async function runNoFaultProcessWithTimeout<Result>(
  operation: Promise<Result>,
  timeoutMilliseconds: number,
): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Result>((_resolve, reject) => {
    timeout = setTimeout(() => reject(processFailed()), timeoutMilliseconds)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/** Reads one bounded positive timeout or its fixed production default. */
function readNoFaultProcessTimeout(
  value: number | undefined,
  defaultValue: number,
): number {
  const timeout = value ?? defaultValue
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > defaultValue
  ) {
    throw processFailed()
  }
  return timeout
}

/** Reads one non-regressing canonical timestamp from the trusted parent clock. */
function readNoFaultProcessTimestamp(
  state: NoFaultProcessRunnerState,
): string {
  let timestamp: string
  try {
    timestamp = state.now()
  } catch {
    throw processFailed()
  }
  if (
    !isCanonicalTimestamp(timestamp) ||
    (state.lastTimestamp !== undefined && timestamp < state.lastTimestamp)
  ) {
    throw processFailed()
  }
  state.lastTimestamp = timestamp
  return timestamp
}

/** Returns the system UTC clock used by the production no-fault runner. */
function defaultNoFaultProcessClock(): string {
  return new Date().toISOString()
}

/**
 * Exclusively creates and durably syncs one exact mode-0700 evidence directory.
 *
 * @param directoryPath - Explicit new evidence directory path.
 * @returns Whether this invocation created it or found an existing path.
 */
export async function createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive(
  directoryPath: string,
): Promise<WorkspaceSearchMigrationRehearsalExclusiveCreateOutcome> {
  const path = requireProcessCliPath(directoryPath)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error: unknown) {
    if (isProcessCliFileExistsError(error)) return 'exists'
    throw outputBoundaryFailed()
  }
  let directoryHandle: Awaited<ReturnType<typeof open>>
  try {
    directoryHandle = await open(
      path,
      fileSystemConstants.O_RDONLY |
        fileSystemConstants.O_DIRECTORY |
        fileSystemConstants.O_NOFOLLOW,
    )
  } catch {
    throw outputBoundaryFailed()
  }
  let failed = false
  try {
    await directoryHandle.chmod(0o700)
    const metadata = await directoryHandle.stat()
    const getuid = process.getuid
    if (
      !metadata.isDirectory() ||
      (metadata.mode & 0o7777) !== 0o700 ||
      (typeof getuid === 'function' && metadata.uid !== getuid.call(process))
    ) {
      failed = true
    }
    await directoryHandle.sync()
  } catch {
    failed = true
  }
  try {
    await directoryHandle.close()
  } catch {
    failed = true
  }
  if (failed) throw outputBoundaryFailed()
  await syncProcessCliDirectory(dirname(resolve(path)))
  return 'created'
}

/**
 * Exclusively creates and durably syncs one fixed mode-0600 evidence file.
 *
 * @param directoryPath - Fresh evidence directory selected by this run.
 * @param filename - One allowlisted immutable evidence filename.
 * @param bytes - Exact non-empty canonical safe evidence bytes.
 * @param signal - Optional parent-owned cancellation for a timed-out writer.
 * @param publicationDependencies - Optional deterministic crash-test control.
 * @returns Whether this invocation created the file or found it existing.
 */
export async function writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
  directoryPath: string,
  filename: WorkspaceSearchMigrationRehearsalEvidenceFilename,
  bytes: Uint8Array,
  signal?: AbortSignal,
  publicationDependencies?:
    WorkspaceSearchMigrationRehearsalEvidencePublicationDependencies,
): Promise<WorkspaceSearchMigrationRehearsalExclusiveCreateOutcome> {
  const directory = requireProcessCliPath(directoryPath)
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw outputBoundaryFailed()
  }
  const onCheckpoint = readProcessCliEvidencePublicationCheckpoint(
    publicationDependencies,
  )
  if (
    filename !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FILENAME &&
    filename !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_FILENAME &&
    filename !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME &&
    filename !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME &&
    filename !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME &&
    filename !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME &&
    filename !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME &&
    filename !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME &&
    filename !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME
  ) {
    throw outputBoundaryFailed()
  }
  const maximumBytes = filename ===
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME
      ? WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
      : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_EVIDENCE_MAX_BYTES
  const content = copyEvidenceBytes(bytes, maximumBytes)
  const finalPath = join(directory, filename)
  const temporaryPath = processCliEvidencePublicationTemporaryPath(
    directory,
    filename,
  )
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    directoryHandle = await openProcessCliEvidenceDirectory(directory)
    const recovery = await recoverProcessCliEvidenceFilePublication(
      finalPath,
      temporaryPath,
      directoryHandle,
      undefined,
      maximumBytes,
    )
    if (recovery === 'final-present') return 'exists'
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
    } catch (error: unknown) {
      if (isProcessCliFileExistsError(error)) throw outputBoundaryFailed()
      throw outputBoundaryFailed()
    }
    await handle.chmod(0o600)
    const emptyMetadata = await handle.stat()
    requireProcessCliEvidencePublicationMetadata(
      emptyMetadata,
      0,
      1,
      maximumBytes,
    )
    await handle.writeFile(content, signal === undefined ? {} : { signal })
    const completeMetadata = await handle.stat()
    requireProcessCliEvidencePublicationMetadata(
      completeMetadata,
      content.byteLength,
      1,
      maximumBytes,
    )
    await handle.sync()
    await handle.close()
    handle = undefined
    runProcessCliEvidencePublicationCheckpoint(
      onCheckpoint,
      'temporary-file-durable',
    )
    try {
      await link(temporaryPath, finalPath)
    } catch (error: unknown) {
      if (!isProcessCliFileExistsError(error)) throw outputBoundaryFailed()
      await unlink(temporaryPath)
      await directoryHandle.sync()
      const finalMetadata = await lstat(finalPath)
      requireProcessCliEvidencePublicationMetadata(
        finalMetadata,
        undefined,
        1,
        maximumBytes,
      )
      return 'exists'
    }
    runProcessCliEvidencePublicationCheckpoint(
      onCheckpoint,
      'final-link-created',
    )
    await directoryHandle.sync()
    runProcessCliEvidencePublicationCheckpoint(
      onCheckpoint,
      'final-link-durable',
    )
    await unlink(temporaryPath)
    runProcessCliEvidencePublicationCheckpoint(
      onCheckpoint,
      'temporary-link-removed',
    )
    await directoryHandle.sync()
    return 'created'
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
      throw error
    }
    throw outputBoundaryFailed()
  } finally {
    zeroizeProcessCliKey(content)
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The immutable publication outcome remains authoritative.
      }
    }
    if (directoryHandle !== undefined) {
      try {
        await directoryHandle.close()
      } catch {
        // The immutable publication outcome remains authoritative.
      }
    }
  }
}

/** Opens and validates one fixed owner-only evidence directory. */
async function openProcessCliEvidenceDirectory(
  directory: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      directory,
      fileSystemConstants.O_RDONLY |
        fileSystemConstants.O_DIRECTORY |
        fileSystemConstants.O_NOFOLLOW,
    )
    const metadata = await handle.stat()
    const pathMetadata = await lstat(directory)
    const getuid = process.getuid
    if (
      !metadata.isDirectory() ||
      !pathMetadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      pathMetadata.isSymbolicLink() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      (metadata.mode & 0o7777) !== 0o700 ||
      (typeof getuid === 'function' && metadata.uid !== getuid.call(process))
    ) throw outputBoundaryFailed()
    return handle
  } catch (error: unknown) {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The stable directory validation failure remains authoritative.
      }
    }
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
      throw error
    }
    throw outputBoundaryFailed()
  }
}

/** Normalizes fixed temporary-only and same-inode linked publication states. */
async function recoverProcessCliEvidenceFilePublication(
  finalPath: string,
  temporaryPath: string,
  directoryHandle: Awaited<ReturnType<typeof open>>,
  expectedSize: number | undefined,
  maximumSize: number,
): Promise<'final-absent' | 'final-present'> {
  const finalMetadata = await readProcessCliOptionalMetadata(finalPath)
  const temporaryMetadata = await readProcessCliOptionalMetadata(temporaryPath)
  if (temporaryMetadata === undefined) {
    if (finalMetadata === undefined) return 'final-absent'
    requireProcessCliEvidencePublicationMetadata(
      finalMetadata,
      expectedSize,
      1,
      maximumSize,
    )
    return 'final-present'
  }
  requireProcessCliEvidencePublicationMetadata(
    temporaryMetadata,
    finalMetadata === undefined ? undefined : expectedSize,
    finalMetadata === undefined ? 1 : 2,
    maximumSize,
  )
  if (finalMetadata === undefined) {
    await unlink(temporaryPath)
    await directoryHandle.sync()
    return 'final-absent'
  }
  requireProcessCliEvidencePublicationMetadata(
    finalMetadata,
    expectedSize,
    2,
    maximumSize,
  )
  if (
    finalMetadata.dev !== temporaryMetadata.dev ||
    finalMetadata.ino !== temporaryMetadata.ino ||
    finalMetadata.size !== temporaryMetadata.size
  ) throw outputBoundaryFailed()
  await unlink(temporaryPath)
  await directoryHandle.sync()
  return 'final-present'
}

/** Reads optional no-follow metadata and rejects every non-absence failure. */
async function readProcessCliOptionalMetadata(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (isProcessCliFileSystemErrorCode(error, 'ENOENT')) return undefined
    throw outputBoundaryFailed()
  }
}

/** Requires one secure fixed-size immutable publication inode. */
function requireProcessCliEvidencePublicationMetadata(
  metadata: Awaited<ReturnType<typeof lstat>>,
  expectedSize: number | undefined,
  expectedLinkCount: 1 | 2,
  maximumSize: number,
): void {
  const getuid = process.getuid
  const mode = Number(metadata.mode)
  const linkCount = Number(metadata.nlink)
  const size = Number(metadata.size)
  const userId = Number(metadata.uid)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !Number.isSafeInteger(mode) ||
    (mode & 0o7777) !== 0o600 ||
    linkCount !== expectedLinkCount ||
    (expectedSize !== undefined && size !== expectedSize) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > maximumSize ||
    (typeof getuid === 'function' && userId !== getuid.call(process))
  ) throw outputBoundaryFailed()
}

/** Returns the fixed sibling temporary name for one immutable artifact. */
function processCliEvidencePublicationTemporaryPath(
  directory: string,
  filename: WorkspaceSearchMigrationRehearsalEvidenceFilename,
): string {
  return join(directory, processCliEvidencePublicationTemporaryFilename(
    filename,
  ))
}

/** Returns one fixed sibling temporary filename without its directory. */
function processCliEvidencePublicationTemporaryFilename(
  filename: WorkspaceSearchMigrationRehearsalEvidenceFilename,
): string {
  return `.${filename}.publication.tmp`
}

/** Returns the immutable writer byte ceiling for one publication filename. */
function readProcessCliEvidencePublicationMaximumBytes(
  filename: WorkspaceSearchMigrationRehearsalEvidenceFilename,
): number {
  return filename ===
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME
    ? WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
    : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_EVIDENCE_MAX_BYTES
}

/** Resolves one exact recoverable final publication filename. */
function readProcessCliRecoverablePublicationFilename(
  entry: string,
): WorkspaceSearchMigrationRehearsalEvidenceFilename | undefined {
  for (const filename of processCliRecoverablePublicationFilenames) {
    if (entry === filename) return filename
  }
  return undefined
}

/** Resolves one fixed recoverable temporary entry to its final filename. */
function readProcessCliRecoverablePublicationTemporaryFilename(
  entry: string,
): WorkspaceSearchMigrationRehearsalEvidenceFilename | undefined {
  for (const filename of processCliRecoverablePublicationFilenames) {
    if (entry === processCliEvidencePublicationTemporaryFilename(filename)) {
      return filename
    }
  }
  return undefined
}

/** Captures one direct optional immutable-publication crash callback. */
function readProcessCliEvidencePublicationCheckpoint(
  dependencies:
    WorkspaceSearchMigrationRehearsalEvidencePublicationDependencies |
    undefined,
): ((
  checkpoint: WorkspaceSearchMigrationRehearsalEvidencePublicationCheckpoint,
) => void) | undefined {
  if (dependencies === undefined) return undefined
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies) ||
    Object.keys(dependencies).length > 1 ||
    (Object.keys(dependencies).length === 1 &&
      Object.keys(dependencies)[0] !== 'onCheckpoint')
  ) throw outputBoundaryFailed()
  const callback = dependencies.onCheckpoint
  if (
    callback !== undefined &&
    (typeof callback !== 'function' || nodeUtilTypes.isProxy(callback))
  ) throw outputBoundaryFailed()
  return callback
}

/** Invokes one captured deterministic publication crash checkpoint. */
function runProcessCliEvidencePublicationCheckpoint(
  callback: ((
    checkpoint:
      WorkspaceSearchMigrationRehearsalEvidencePublicationCheckpoint,
  ) => void) | undefined,
  checkpoint: WorkspaceSearchMigrationRehearsalEvidencePublicationCheckpoint,
): void {
  if (callback !== undefined) Reflect.apply(callback, undefined, [checkpoint])
}

/**
 * Exclusively writes and durably syncs the fixed owner-only runtime key file.
 *
 * @param directoryPath - Already validated reservation evidence directory.
 * @param key - Exact ordinary 32-byte derived runtime key.
 * @param publicationDependencies - Optional deterministic crash controls.
 * @returns Whether the runtime file was created or already existed.
 */
export async function writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive(
  directoryPath: string,
  key: Uint8Array,
  publicationDependencies?:
    WorkspaceSearchMigrationRehearsalRuntimeKeyPublicationDependencies,
): Promise<WorkspaceSearchMigrationRehearsalExclusiveCreateOutcome> {
  const directory = requireProcessCliPath(directoryPath)
  const content = copyProcessCliRuntimeKey(key)
  const controls = readProcessCliRuntimeKeyPublicationControls(
    publicationDependencies,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    try {
      handle = await open(
        join(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
        ),
        'wx',
        0o600,
      )
    } catch (error: unknown) {
      if (isProcessCliFileExistsError(error)) return 'exists'
      throw outputBoundaryFailed()
    }
    runProcessCliRuntimeKeyPublicationCheckpoint(
      controls.onCheckpoint,
      'runtime-file-created',
    )
    let failed = false
    try {
      await handle.chmod(0o600)
      let offset = 0
      while (offset < content.byteLength) {
        const writeLength = Math.min(
          controls.maximumWriteBytes,
          content.byteLength - offset,
        )
        const write = await handle.write(
          content,
          offset,
          writeLength,
          offset,
        )
        if (write.bytesWritten <= 0 || write.bytesWritten > writeLength) {
          throw outputBoundaryFailed()
        }
        offset += write.bytesWritten
        runProcessCliRuntimeKeyPublicationCheckpoint(
          controls.onCheckpoint,
          'runtime-key-write-progress',
        )
      }
      await handle.sync()
      runProcessCliRuntimeKeyPublicationCheckpoint(
        controls.onCheckpoint,
        'runtime-key-durable',
      )
    } catch {
      failed = true
    }
    try {
      await handle.close()
      handle = undefined
    } catch {
      failed = true
    }
    if (failed) throw outputBoundaryFailed()
    await syncProcessCliDirectory(resolve(directory))
    return 'created'
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
      throw error
    }
    throw outputBoundaryFailed()
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The primary private filesystem failure remains authoritative.
      }
    }
    zeroizeProcessCliKey(content)
  }
}

/** Captures exact deterministic runtime-key publication controls. */
function readProcessCliRuntimeKeyPublicationControls(
  value:
    WorkspaceSearchMigrationRehearsalRuntimeKeyPublicationDependencies |
    undefined,
): Readonly<{
  /** Maximum bytes passed to one positioned write. */
  maximumWriteBytes: number
  /** Optional direct crash checkpoint callback. */
  onCheckpoint?: (
    checkpoint:
      WorkspaceSearchMigrationRehearsalRuntimeKeyPublicationCheckpoint,
  ) => void
}> {
  if (value === undefined) {
    return Object.freeze({ maximumWriteBytes: 32 })
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    Object.keys(value).some((key) =>
      key !== 'maximumWriteBytes' && key !== 'onCheckpoint'
    )
  ) throw outputBoundaryFailed()
  const maximumWriteBytes = value.maximumWriteBytes ?? 32
  const onCheckpoint = value.onCheckpoint
  if (
    !Number.isSafeInteger(maximumWriteBytes) ||
    maximumWriteBytes <= 0 ||
    maximumWriteBytes > 32 ||
    (onCheckpoint !== undefined &&
      (typeof onCheckpoint !== 'function' ||
        nodeUtilTypes.isProxy(onCheckpoint)))
  ) throw outputBoundaryFailed()
  return Object.freeze({
    maximumWriteBytes,
    ...(onCheckpoint === undefined ? {} : { onCheckpoint }),
  })
}

/** Invokes one captured runtime-key crash checkpoint. */
function runProcessCliRuntimeKeyPublicationCheckpoint(
  callback: ((
    checkpoint:
      WorkspaceSearchMigrationRehearsalRuntimeKeyPublicationCheckpoint,
  ) => void) | undefined,
  checkpoint: WorkspaceSearchMigrationRehearsalRuntimeKeyPublicationCheckpoint,
): void {
  if (callback !== undefined) Reflect.apply(callback, undefined, [checkpoint])
}

/**
 * Removes the fixed runtime key and durably records the directory mutation.
 *
 * @param directoryPath - Exact evidence directory owning the ephemeral key.
 */
export async function removeWorkspaceSearchMigrationRehearsalRuntimeKeyFile(
  directoryPath: string,
): Promise<void> {
  const directory = requireProcessCliPath(directoryPath)
  try {
    await unlink(join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    ))
    await syncProcessCliDirectory(resolve(directory))
  } catch {
    throw outputBoundaryFailed()
  }
}

/**
 * Validates that an owner-only resume directory contains only one reservation.
 *
 * @param directoryPath - Exact pre-existing evidence directory to inspect.
 */
export async function validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory(
  directoryPath: string,
): Promise<void> {
  const directory = requireProcessCliPath(directoryPath)
  try {
    const metadata = await lstat(directory)
    const getuid = process.getuid
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o7777) !== 0o700 ||
      (typeof getuid === 'function' && metadata.uid !== getuid.call(process))
    ) {
      throw outputBoundaryFailed()
    }
    const entries = await readdir(directory)
    if (
      entries.length !== 1 ||
      entries[0] !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME
    ) {
      throw outputBoundaryFailed()
    }
    const reservationMetadata = await lstat(join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    ))
    if (
      !reservationMetadata.isFile() ||
      reservationMetadata.isSymbolicLink() ||
      (reservationMetadata.mode & 0o7777) !== 0o600 ||
      (typeof getuid === 'function' &&
        reservationMetadata.uid !== getuid.call(process))
    ) {
      throw outputBoundaryFailed()
    }
  } catch {
    throw outputBoundaryFailed()
  }
}

/**
 * Converts an interrupted pre-spawn runtime publication into cleanup evidence.
 *
 * The branch is reachable only for an exact reservation plus one owner-only
 * runtime inode. Its bounded bytes must equal the expected runtime-key prefix.
 * The partial inode is durably zeroed and removed before a complete replacement
 * is created solely so the ordinary authenticated cleanup protocol can publish
 * durable intent and completion artifacts for later abandonment.
 *
 * @param directoryPath - Pre-existing owner-only evidence directory.
 * @param selection - Independently authenticated manifest selection.
 * @param expectedPreviousRateSegment - Pre-spawn authenticated predecessor.
 * @param expectedTargetPreimageArtifactContentDigest - Authenticated preimage bytes.
 * @param permit - Authenticated permit owning the reservation runway.
 * @param runtimeKey - Exact derived runtime key whose prefix may be present.
 * @param publicationKey - Parent-only cleanup publication key.
 * @param now - Captured trusted cleanup clock.
 * @returns Whether the exact interrupted pre-spawn state was normalized.
 */
async function recoverProcessCliInterruptedRuntimeKeyPublication(
  directoryPath: string,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null,
  expectedTargetPreimageArtifactContentDigest: string | null,
  permit: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  now: () => Date,
): Promise<boolean> {
  const directory = requireProcessCliPath(directoryPath)
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
  let reservationHandle: Awaited<ReturnType<typeof open>> | undefined
  let runtimeHandle: Awaited<ReturnType<typeof open>> | undefined
  let reservationBytes: Uint8Array | undefined
  let partialBytes: Uint8Array | undefined
  let failed = false
  let recovered = false
  try {
    directoryHandle = await openProcessCliEvidenceDirectory(directory)
    const entries = [...await readdir(directory)].sort()
    const expectedEntries = [
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    ].sort()
    if (
      entries.length !== expectedEntries.length ||
      entries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      await directoryHandle.close()
      directoryHandle = undefined
      return false
    }

    const reservationPath = join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    )
    reservationHandle = await open(
      reservationPath,
      fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW,
    )
    const reservationMetadata = await reservationHandle.stat()
    const reservationPathMetadata = await lstat(reservationPath)
    requireProcessCliEvidencePublicationMetadata(
      reservationMetadata,
      undefined,
      1,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES,
    )
    if (
      reservationMetadata.dev !== reservationPathMetadata.dev ||
      reservationMetadata.ino !== reservationPathMetadata.ino ||
      reservationMetadata.size !== reservationPathMetadata.size
    ) throw outputBoundaryFailed()
    reservationBytes = new Uint8Array(await reservationHandle.readFile())
    if (
      reservationBytes.byteLength === 0 ||
      reservationBytes.byteLength !== reservationMetadata.size
    ) throw outputBoundaryFailed()
    const reservation =
      parseWorkspaceSearchMigrationRehearsalStageReservationDocument(
        reservationBytes,
        selection,
        runtimeKey,
      )
    requireProcessCliReservationRateBinding(
      reservation,
      expectedPreviousRateSegment,
      expectedTargetPreimageArtifactContentDigest,
    )
    if (
      Date.parse(reservation.expiresAt) +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS >
      readProcessCliPermitExpiry(permit)
    ) throw outputBoundaryFailed()

    const runtimePath = join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    )
    runtimeHandle = await open(
      runtimePath,
      fileSystemConstants.O_RDWR | fileSystemConstants.O_NOFOLLOW,
    )
    const runtimeMetadata = await runtimeHandle.stat()
    const runtimePathMetadata = await lstat(runtimePath)
    requireProcessCliEvidencePublicationMetadata(
      runtimeMetadata,
      undefined,
      1,
      32,
    )
    if (
      runtimeMetadata.dev !== runtimePathMetadata.dev ||
      runtimeMetadata.ino !== runtimePathMetadata.ino ||
      runtimeMetadata.size !== runtimePathMetadata.size
    ) throw outputBoundaryFailed()
    partialBytes = new Uint8Array(runtimeMetadata.size)
    await readExactProcessCliRuntimeBytes(runtimeHandle, partialBytes)
    if (
      partialBytes.byteLength > 0 &&
      !timingSafeEqual(
        partialBytes,
        runtimeKey.subarray(0, partialBytes.byteLength),
      )
    ) throw outputBoundaryFailed()
    await zeroProcessCliRuntimeFile(runtimeHandle, partialBytes.byteLength)
    await runtimeHandle.close()
    runtimeHandle = undefined
    const stableRuntimeMetadata = await lstat(runtimePath)
    if (
      stableRuntimeMetadata.dev !== runtimeMetadata.dev ||
      stableRuntimeMetadata.ino !== runtimeMetadata.ino ||
      stableRuntimeMetadata.size !== runtimeMetadata.size ||
      stableRuntimeMetadata.nlink !== 1
    ) throw outputBoundaryFailed()
    await unlink(runtimePath)
    await directoryHandle.sync()
    if (
      await writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive(
        directory,
        runtimeKey,
      ) !== 'created'
    ) throw outputBoundaryFailed()
    await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
      evidenceDirectory: directory,
      reservation,
      selection,
      expectedRuntimeKey: runtimeKey,
      publicationAuthenticationKey: publicationKey,
      now,
    })
    recovered = true
  } catch {
    failed = true
  } finally {
    zeroizeProcessCliKey(reservationBytes)
    zeroizeProcessCliKey(partialBytes)
    for (const handle of [runtimeHandle, reservationHandle, directoryHandle]) {
      if (handle === undefined) continue
      try {
        await handle.close()
      } catch {
        failed = true
      }
    }
  }
  if (failed) throw outputBoundaryFailed()
  return recovered
}

/** Reads one exact fixed-length runtime prefix without accepting truncation. */
async function readExactProcessCliRuntimeBytes(
  handle: Awaited<ReturnType<typeof open>>,
  output: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < output.byteLength) {
    const read = await handle.read(
      output,
      offset,
      output.byteLength - offset,
      offset,
    )
    if (read.bytesRead <= 0) throw outputBoundaryFailed()
    offset += read.bytesRead
  }
  const metadata = await handle.stat()
  if (metadata.size !== output.byteLength) throw outputBoundaryFailed()
}

/** Durably overwrites one already authenticated bounded runtime inode. */
async function zeroProcessCliRuntimeFile(
  handle: Awaited<ReturnType<typeof open>>,
  byteLength: number,
): Promise<void> {
  const zeros = new Uint8Array(byteLength)
  const verification = new Uint8Array(byteLength)
  try {
    let offset = 0
    while (offset < zeros.byteLength) {
      const write = await handle.write(
        zeros,
        offset,
        zeros.byteLength - offset,
        offset,
      )
      if (write.bytesWritten <= 0) throw outputBoundaryFailed()
      offset += write.bytesWritten
    }
    await handle.sync()
    await readExactProcessCliRuntimeBytes(handle, verification)
    if (verification.some((byte) => byte !== 0)) throw outputBoundaryFailed()
  } finally {
    zeroizeProcessCliKey(zeros)
    zeroizeProcessCliKey(verification)
  }
}

/**
 * Inspects one completed-process directory without following any entry.
 *
 * @param directoryPath - Exact evidence directory left by an interrupted parent.
 * @returns Frozen allowed owner-only regular filenames for phase validation.
 */
async function inspectProcessCliParentAuthenticationRecoveryDirectory(
  directoryPath: string,
): Promise<readonly string[]> {
  const directory = requireProcessCliPath(directoryPath)
  await recoverProcessCliParentAuthenticationPublication(directory)
  const allowed = new Set<string>([
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
    `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME}.tmp`,
    `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME}.tmp`,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
  ])
  for (const filename of processCliRecoverablePublicationFilenames) {
    allowed.add(processCliEvidencePublicationTemporaryFilename(filename))
  }
  try {
    const directoryMetadata = await lstat(directory)
    const getuid = process.getuid
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      (directoryMetadata.mode & 0o7777) !== 0o700 ||
      (typeof getuid === 'function' &&
        directoryMetadata.uid !== getuid.call(process))
    ) throw outputBoundaryFailed()
    const entries = await readdir(directory)
    if (entries.length === 0) throw outputBoundaryFailed()
    for (const entry of entries) {
      if (!allowed.has(entry)) throw outputBoundaryFailed()
      const metadata = await lstat(join(directory, entry))
      const cleanupPublicationEntry =
        entry ===
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME ||
        entry ===
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME ||
        entry ===
          `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME}.tmp` ||
        entry ===
          `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME}.tmp`
      const recoverableFinalFilename =
        readProcessCliRecoverablePublicationFilename(entry)
      const recoverableTemporaryFilename =
        readProcessCliRecoverablePublicationTemporaryFilename(entry)
      const recoverableFilename = recoverableFinalFilename ??
        recoverableTemporaryFilename
      if (recoverableFilename !== undefined) {
        const siblingEntry = recoverableFinalFilename === undefined
          ? recoverableFilename
          : processCliEvidencePublicationTemporaryFilename(
              recoverableFilename,
            )
        requireProcessCliEvidencePublicationMetadata(
          metadata,
          undefined,
          entries.includes(siblingEntry) ? 2 : 1,
          readProcessCliEvidencePublicationMaximumBytes(recoverableFilename),
        )
        continue
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o7777) !== 0o600 ||
        (cleanupPublicationEntry
          ? metadata.nlink !== 1 && metadata.nlink !== 2
          : metadata.nlink !== 1) ||
        (entry === WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME &&
          metadata.size !== 32) ||
        (typeof getuid === 'function' && metadata.uid !== getuid.call(process))
      ) throw outputBoundaryFailed()
    }
    return Object.freeze([...entries])
  } catch {
    throw outputBoundaryFailed()
  }
}

/** Normalizes the publications needed before recovery material can be inferred. */
async function recoverProcessCliParentAuthenticationPublication(
  directory: string,
): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
  let failed = false
  try {
    directoryHandle = await openProcessCliEvidenceDirectory(directory)
    for (const filename of processCliRecoveryFoundationPublicationFilenames) {
      await recoverProcessCliEvidenceFilePublication(
        join(directory, filename),
        processCliEvidencePublicationTemporaryPath(directory, filename),
        directoryHandle,
        undefined,
        readProcessCliEvidencePublicationMaximumBytes(filename),
      )
    }
  } catch {
    failed = true
  }
  if (directoryHandle !== undefined) {
    try {
      await directoryHandle.close()
    } catch {
      failed = true
    }
  }
  if (failed) throw outputBoundaryFailed()
}

/**
 * Normalizes every required parent-owned evidence publication for one phase.
 *
 * @param directory - Already inspected owner-only evidence directory.
 * @param entries - Exact directory entries observed before normalization.
 * @param materialKind - Authenticated material shape inferred from lifecycle.
 */
async function recoverProcessCliRequiredEvidencePublications(
  directory: string,
  entries: readonly string[],
  materialKind: ProcessCliRecoveryMaterialKind,
): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
  let failed = false
  try {
    directoryHandle = await openProcessCliEvidenceDirectory(directory)
    for (
      const entry of createProcessCliRecoveryEvidenceEntries(
        entries,
        materialKind,
      )
    ) {
      const filename = readProcessCliRecoverablePublicationFilename(entry)
      if (filename === undefined) continue
      await recoverProcessCliEvidenceFilePublication(
        join(directory, filename),
        processCliEvidencePublicationTemporaryPath(directory, filename),
        directoryHandle,
        undefined,
        readProcessCliEvidencePublicationMaximumBytes(filename),
      )
    }
  } catch {
    failed = true
  }
  if (directoryHandle !== undefined) {
    try {
      await directoryHandle.close()
    } catch {
      failed = true
    }
  }
  if (failed) throw outputBoundaryFailed()
}

/**
 * Requires exact completed evidence while admitting only cleanup subphases.
 *
 * The cleanup implementation owns normalization of its two fixed temporary
 * names and authenticates every destructive runtime-key transition. This check
 * merely proves no unrelated file can be smuggled into that recovery call.
 */
function requireProcessCliRecoveryBaseEntries(
  entries: readonly string[],
  materialKind: ProcessCliRecoveryMaterialKind,
): void {
  const cleanupEntries = new Set<string>([
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
    `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME}.tmp`,
    `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME}.tmp`,
  ])
  const evidenceEntries = entries.filter((entry) =>
    !cleanupEntries.has(entry)
  )
  const expected = createProcessCliRecoveryEvidenceEntries(
    evidenceEntries,
    materialKind,
  )
  const actual = [...evidenceEntries].sort()
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) throw outputBoundaryFailed()
  const hasRuntimeKey = entries.includes(
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
  )
  const hasCompletion = entries.includes(
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
  ) || entries.includes(
    `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME}.tmp`,
  )
  if (!hasRuntimeKey && !hasCompletion) throw outputBoundaryFailed()
}

/** Requires the exact immutable files for one completed material phase. */
function requireExactProcessCliRecoveryEntries(
  entries: readonly string[],
  materialKind: ProcessCliRecoveryMaterialKind,
): void {
  const expected = [
    ...createProcessCliRecoveryEvidenceEntries(entries, materialKind),
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
  ].sort()
  const actual = [...entries].sort()
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) throw outputBoundaryFailed()
}

/** Returns the exact non-cleanup evidence filenames for one material shape. */
function createProcessCliRecoveryEvidenceEntries(
  entries: readonly string[],
  materialKind: ProcessCliRecoveryMaterialKind,
): string[] {
  return [
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
    ...(materialKind === 'success'
      ? [WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME]
      : [
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
          ...(materialKind === 'fault-completion'
            ? [WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME]
            : []),
        ]),
    ...(entries.includes(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
    )
      ? [WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME]
      : []),
  ].sort()
}

/** Copies one exact ordinary non-shared derived runtime key. */
function copyProcessCliRuntimeKey(key: Uint8Array): Uint8Array {
  if (
    !(key instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(key) ||
    key.byteLength !== 32 ||
    isProcessCliSharedArrayBuffer(key.buffer)
  ) {
    throw outputBoundaryFailed()
  }
  return new Uint8Array(key)
}

/** Creates a strict process port over one Node child with isolated pipes. */
function createWorkspaceSearchMigrationRehearsalNodeProcessPort(
  child: ChildProcess,
  stdin: Writable,
  stdout: Readable,
  receiptStream: Readable,
  parentLivenessStream: Writable,
): WorkspaceSearchMigrationRehearsalProcessPort {
  const exited = observeNodeChildExit(child)
  /** Closes the parent endpoint only after the child is already contained. */
  const closeParentLivenessStream = (): void => {
    if (!parentLivenessStream.destroyed) parentLivenessStream.destroy()
  }
  void exited.then(
    closeParentLivenessStream,
    closeParentLivenessStream,
  )
  let acknowledgementCount = 0
  let expectsFinalAcknowledgement = false
  let acknowledgementStreamClosed = false
  return Object.freeze({
    stdout: readNodeChildBytes(stdout),
    stderr: readNodeChildBytes(receiptStream),
    exited,
    kill: (signal: 'SIGKILL'): void => {
      let accepted = false
      try {
        accepted = child.kill(signal)
      } catch {
        throw operationFailed()
      }
      if (!accepted) throw operationFailed()
    },
    acknowledgeResponseLoss: async (
      receiptSha256: string,
      closeAfterAcknowledgement = true,
    ): Promise<void> => {
      if (
        acknowledgementStreamClosed ||
        !isHexDigest(receiptSha256) ||
        acknowledgementCount > 1 ||
        (acknowledgementCount === 0 && expectsFinalAcknowledgement) ||
        (acknowledgementCount === 1 &&
          (!expectsFinalAcknowledgement || !closeAfterAcknowledgement))
      ) {
        throw operationFailed()
      }
      acknowledgementCount += 1
      const acknowledgement = `${serializeCanonicalJson({
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_KIND,
        receiptSha256,
      })}\n`
      if (closeAfterAcknowledgement) {
        acknowledgementStreamClosed = true
        await writeAndCloseNodeChildStdin(stdin, acknowledgement)
        return
      }
      if (acknowledgementCount !== 1) throw operationFailed()
      expectsFinalAcknowledgement = true
      await writeNodeChildStdin(stdin, acknowledgement)
    },
  })
}

/** Writes and flushes one non-final acknowledgement without closing stdin. */
async function writeNodeChildStdin(
  stdin: Writable,
  acknowledgement: string,
): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    let settled = false
    /** Removes the temporary non-final write error listener. */
    const cleanup = (): void => {
      stdin.off('error', handleError)
    }
    /** Rejects one failed acknowledgement write through the stable boundary. */
    const handleError = (): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectWrite(operationFailed())
    }
    /** Resolves after Node flushes the complete acknowledgement bytes. */
    const handleWritten = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveWrite()
    }
    stdin.once('error', handleError)
    try {
      stdin.write(acknowledgement, 'utf8', handleWritten)
    } catch {
      handleError()
    }
  })
}

/** Writes one complete fixed acknowledgement and closes the child stdin pipe. */
async function writeAndCloseNodeChildStdin(
  stdin: Writable,
  acknowledgement: string,
): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    let settled = false
    let finished = false
    /** Removes all temporary acknowledgement lifecycle listeners. */
    const cleanup = (): void => {
      stdin.off('error', handleError)
      stdin.off('finish', handleFinish)
      stdin.off('close', handleClose)
    }
    /** Rejects the acknowledgement without retaining a raw stream error. */
    const handleError = (): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectWrite(operationFailed())
    }
    /** Records that Node flushed all acknowledgement bytes. */
    const handleFinish = (): void => {
      if (settled) return
      finished = true
    }
    /** Resolves only after the flushed writable descriptor is fully closed. */
    const handleClose = (): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!finished) {
        rejectWrite(operationFailed())
        return
      }
      resolveWrite()
    }
    stdin.once('error', handleError)
    stdin.once('finish', handleFinish)
    stdin.once('close', handleClose)
    try {
      stdin.end(acknowledgement, 'utf8')
    } catch {
      handleError()
    }
  })
}

/** Converts one Node readable into strict Uint8Array chunks. */
async function* readNodeChildBytes(
  stream: Readable,
): AsyncIterable<Uint8Array> {
  for await (const candidate of stream) {
    if (!(candidate instanceof Uint8Array)) throw operationFailed()
    yield candidate
  }
}

/** Resolves one exact exit code or signal from the Node child. */
function observeNodeChildExit(
  child: ChildProcess,
): Promise<WorkspaceSearchMigrationRehearsalProcessExitResult> {
  return new Promise((resolveExit, rejectExit) => {
    let settled = false
    /** Rejects one pre-exit child-process error without retaining it. */
    const handleError = (): void => {
      if (settled) return
      settled = true
      rejectExit(operationFailed())
    }
    /** Resolves one strict final exit event. */
    const handleExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return
      settled = true
      if (signal !== null) {
        resolveExit(Object.freeze({ kind: 'signal', signal }))
        return
      }
      if (
        code === null ||
        !Number.isSafeInteger(code) ||
        code < 0 ||
        code > 255
      ) {
        rejectExit(operationFailed())
        return
      }
      resolveExit(Object.freeze({ kind: 'exit-code', exitCode: code }))
    }
    child.once('error', handleError)
    child.once('exit', handleExit)
  })
}

/** Installs finite SIGINT and SIGTERM listeners for child containment. */
function installWorkspaceSearchMigrationRehearsalParentSignalHandler(
  handler: (signal: WorkspaceSearchMigrationRehearsalParentSignal) => void,
): WorkspaceSearchMigrationRehearsalRemoveSignalHandler {
  /** Forwards one interactive interruption without reading ambient data. */
  const handleSigint = (): void => handler('SIGINT')
  /** Forwards one termination request without reading ambient data. */
  const handleSigterm = (): void => handler('SIGTERM')
  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)
  return (): void => {
    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)
  }
}

/** Reads one bounded plan file and normalizes every reader failure. */
async function readProcessCliFaultPlan(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile'
  >,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readInputFile(
      path,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_FAULT_PLAN_MAX_BYTES,
    )
  } catch {
    throw invalidFaultPlan()
  }
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_FAULT_PLAN_MAX_BYTES
  ) {
    throw invalidFaultPlan()
  }
  return bytes
}

/** Reads one stable durable rate prefix while the child awaits parent action. */
async function readProcessCliRateSegment(
  directory: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile'
  >,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readInputFile(
      join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
      ),
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
    )
  } catch {
    throw operationFailed()
  }
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
  ) throw operationFailed()
  return new Uint8Array(bytes)
}

/** Reads one exact owner-only 32-byte stage key for parent verification. */
async function readProcessCliStageKey(
  path: string,
  dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies,
): Promise<Uint8Array> {
  const reader = dependencies.readStageKeyFile
  if (!isDirectProcessCliFunction(reader)) {
    throw invalidProcessCliStageSelection()
  }
  let candidate: unknown
  try {
    candidate = await reader(path)
  } catch {
    throw invalidProcessCliStageSelection()
  }
  if (
    !(candidate instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(candidate) ||
    candidate.byteLength !== 32
  ) {
    zeroizeProcessCliKey(
      candidate instanceof Uint8Array && !nodeUtilTypes.isProxy(candidate)
        ? candidate
        : undefined,
    )
    throw invalidProcessCliStageSelection()
  }
  return candidate
}

/** Authenticates that the parent forwards one permit-approved stage key. */
async function readProcessCliPermitKeyBinding(
  configuration: WorkspaceSearchMigrationRehearsalProcessCliArguments,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies,
): Promise<ProcessCliPermitBinding> {
  try {
    const permitBytes = await readProcessCliStageFile(
      configuration.permitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_FILE_MAX_BYTES,
      dependencies,
    )
    const permitText = new TextDecoder('utf-8', { fatal: true }).decode(
      permitBytes,
    )
    const permit: unknown = JSON.parse(permitText)
    if (
      serializeCanonicalJson(permit) !== permitText ||
      typeof permit !== 'object' ||
      permit === null ||
      Array.isArray(permit) ||
      nodeUtilTypes.isProxy(permit) ||
      Object.getPrototypeOf(permit) !== Object.prototype
    ) throw invalidProcessCliStageSelection()
    const runtimeDescriptor = Object.getOwnPropertyDescriptor(
      permit,
      'evidenceKeyDigest',
    )
    const publicationDescriptor = Object.getOwnPropertyDescriptor(
      permit,
      'publicationKeyDigest',
    )
    const expectedRuntimeDigest = runtimeDescriptor?.value
    const expectedPublicationDigest = publicationDescriptor?.value
    const observedRuntimeDigest = createHash('sha256')
      .update(runtimeKey)
      .digest('hex')
    const observedPublicationDigest = createHash('sha256')
      .update(publicationKey)
      .digest('hex')
    if (
      runtimeDescriptor === undefined ||
      !runtimeDescriptor.enumerable ||
      !Object.hasOwn(runtimeDescriptor, 'value') ||
      publicationDescriptor === undefined ||
      !publicationDescriptor.enumerable ||
      !Object.hasOwn(publicationDescriptor, 'value') ||
      !isHexDigest(expectedRuntimeDigest) ||
      !isHexDigest(expectedPublicationDigest) ||
      expectedRuntimeDigest !== observedRuntimeDigest ||
      expectedPublicationDigest !== observedPublicationDigest
    ) throw invalidProcessCliStageSelection()
    return Object.freeze({
      permit,
      permitDigest: createMigrationDigest(permit),
    })
  } catch {
    throw invalidProcessCliStageSelection()
  }
}

/** Reads canonical stage files and selects the exact immediate successor. */
async function readProcessCliStageSelection(
  configuration: WorkspaceSearchMigrationRehearsalProcessCliArguments,
  faultPlanDigest: string | null,
  stageKey: Uint8Array,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile'
  >,
): Promise<ProcessCliStageSelectionBinding> {
  const manifestPath = configuration.stageManifestFile
  if (manifestPath === undefined) throw invalidProcessCliStageSelection()
  try {
    const manifestBytes = await readProcessCliStageFile(
      manifestPath,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
      dependencies,
    )
    const manifest =
      parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
        manifestBytes,
        stageKey,
      )
    let previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null =
      null
    if (configuration.previousStageReceiptFile !== undefined) {
      const previousBytes = await readProcessCliStageFile(
        configuration.previousStageReceiptFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
        dependencies,
      )
      previousReceipt =
        parseWorkspaceSearchMigrationRehearsalStageReceiptDocument(
          previousBytes,
          stageKey,
        )
    }
    const selection = selectWorkspaceSearchMigrationRehearsalStage({
      manifest,
      verificationKey: stageKey,
      previousReceipt,
      controlArguments: configuration.controlArguments,
      faultPlanDigest,
    })
    return Object.freeze({ selection, previousReceipt })
  } catch {
    throw invalidProcessCliStageSelection()
  }
}

/**
 * Authenticates the exact durable rate predecessor before reservation or spawn.
 *
 * @param configuration - Strict process invocation containing the prior file.
 * @param selection - Authenticated next manifest entry.
 * @param previousReceipt - Runtime-authenticated immediate receipt, or null.
 * @param runtimeKey - Runtime-only rate-record authentication key.
 * @param dependencies - Captured bounded file reader.
 * @returns Exact verified predecessor summary, or null at stage one.
 */
async function readProcessCliExpectedPreviousRateSegment(
  configuration: WorkspaceSearchMigrationRehearsalProcessCliArguments,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  runtimeKey: Uint8Array,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile'
  >,
): Promise<WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null> {
  const previousRateSegmentFile = configuration.ratePreviousSegmentFile
  if (previousReceipt === null) {
    if (previousRateSegmentFile !== undefined) {
      throw invalidProcessCliStageSelection()
    }
    return null
  }
  if (previousRateSegmentFile === undefined) {
    throw invalidProcessCliStageSelection()
  }
  const derivesFromCommitJournal =
    selection.entry.command === 'release' ||
    (selection.entry.command === 'apply' &&
      (selection.entry.scenario === 'complete-apply-rollback' ||
        selection.entry.scenario === 'partial-apply-rollback'))
  const expectedSegmentOrdinal = previousReceipt.rateSegment.segmentOrdinal +
    (derivesFromCommitJournal ? 1 : 0)
  try {
    const canonicalBytes = await readProcessCliStageFile(
      previousRateSegmentFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
      dependencies,
    )
    const verified = verifyWorkspaceSearchMigrationRehearsalRateSegment({
      canonicalBytes,
      authenticationKey: runtimeKey,
      expectedSegmentOrdinal,
      expectedPolicyVersion: selection.manifest.policyVersion,
      expectedConfigurationBindingDigest:
        selection.manifest.configurationBindingDigest,
    })
    if (
      !derivesFromCommitJournal &&
      serializeCanonicalJson(verified) !==
        serializeCanonicalJson(previousReceipt.rateSegment)
    ) throw invalidProcessCliStageSelection()
    return verified
  } catch {
    throw invalidProcessCliStageSelection()
  }
}

/**
 * Authenticates the planning-pinned rollback preimage before reservation or spawn.
 *
 * @param configuration - Strict process invocation containing the audit path.
 * @param selection - Authenticated rollback apply selection.
 * @param previousReceipt - Exact planning receipt immediately preceding apply.
 * @param runtimeKey - Runtime target-audit authentication key.
 * @param publicationKey - Parent-only target-audit authentication key.
 * @param dependencies - Captured bounded file reader.
 * @returns SHA-256 of the exact canonical audit bytes, or null otherwise.
 */
async function readProcessCliExpectedTargetPreimageArtifactContentDigest(
  configuration: WorkspaceSearchMigrationRehearsalProcessCliArguments,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile'
  >,
): Promise<string | null> {
  const rollbackApply = selection.entry.command === 'apply' &&
    (selection.entry.scenario === 'complete-apply-rollback' ||
      selection.entry.scenario === 'partial-apply-rollback')
  const artifactPath = configuration.targetPreimageAuditFile
  if (!rollbackApply) {
    if (artifactPath !== undefined) throw invalidProcessCliStageSelection()
    return null
  }
  if (
    artifactPath === undefined ||
    previousReceipt === null ||
    previousReceipt.evidence.kind !== 'planning-sealed' ||
    previousReceipt.scenario !== selection.entry.scenario ||
    previousReceipt.manifestDigest !== selection.manifestDigest
  ) throw invalidProcessCliStageSelection()
  const context: WorkspaceSearchMigrationRehearsalTargetAuditContext =
    Object.freeze({
      scenario: selection.entry.scenario,
      runLocatorDigest: previousReceipt.runLocatorDigest,
      manifestDigest: selection.manifestDigest,
      permitDigest: selection.manifest.permitDigest,
      requestedResourcesBinding:
        selection.manifest.requestedResourcesBinding,
      configurationBindingDigest:
        selection.manifest.configurationBindingDigest,
      planningReceiptDigest: createMigrationDigest(previousReceipt),
      executionBoundaryDigest:
        previousReceipt.evidence.executionBoundaryDigest,
      sealedPlanningAuthorityDigest:
        previousReceipt.evidence.sealedPlanningAuthorityDigest,
      planDigest: previousReceipt.evidence.planDigest,
      writerFenceDigest: previousReceipt.writerFenceDigest,
    })
  try {
    const artifactBytes = await readProcessCliStageFile(
      artifactPath,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
      dependencies,
    )
    const binding = selection.entry.scenario === 'complete-apply-rollback'
      ? authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
          artifactBytes,
          expectedContext: context,
          purpose: 'complete-rollback-preimage',
          terminal: null,
        }, new Uint8Array(runtimeKey), new Uint8Array(publicationKey))
      : authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
          artifactBytes,
          expectedContext: context,
          purpose: 'partial-rollback-preimage',
          terminal: null,
        }, new Uint8Array(runtimeKey), new Uint8Array(publicationKey))
    const integrityBefore = binding.integrityBefore
    if (
      integrityBefore === null ||
      integrityBefore.resourceIdentityScheme !==
        selection.manifest.integrityResourceIdentityScheme ||
      !sameProcessCliIntegrityResourceIdentities(
        integrityBefore.resourceIdentities,
        selection.manifest.integrityResourceIdentities,
      ) ||
      integrityBefore.resourceIdentityDigest !==
        selection.manifest.integrityResourceIdentityDigest ||
      binding.commit !== selection.manifest.commit ||
      binding.configurationHash !==
        selection.manifest.configurationBindingDigest ||
      binding.sourceResourceBindingDigest !==
        selection.manifest.requestedResourcesBinding ||
      Date.parse(binding.observedAt) < Date.parse(previousReceipt.completedAt)
    ) throw invalidProcessCliStageSelection()
    return binding.contentDigest
  } catch {
    throw invalidProcessCliStageSelection()
  }
}

/** Compares two canonical keyed resource vectors before an apply spawn. */
function sameProcessCliIntegrityResourceIdentities(
  left: readonly CrossDomainIntegrityResourceIdentity[],
  right: readonly CrossDomainIntegrityResourceIdentity[],
): boolean {
  return left.length === right.length && left.every((identity, index) => {
    const other = right[index]
    return other !== undefined &&
      identity.target === other.target &&
      identity.identityDigest === other.identityDigest
  })
}

/**
 * Creates or securely resumes the sole parent-owned stage reservation file.
 *
 * @param configuration - Strict process invocation and evidence directory.
 * @param selection - Independently authenticated exact manifest selection.
 * @param expectedPreviousRateSegment - Pre-spawn authenticated predecessor.
 * @param permit - Authenticated permit whose remaining lifetime bounds recovery.
 * @param runtimeKey - Runtime-only reservation authentication key.
 * @param publicationKey - Parent-only durable artifact authentication key.
 * @param faultPlan - Exact reviewed fault plan for a fault-mode recovery.
 * @param dependencies - Captured clock, entropy, filesystem, and reader effects.
 * @returns Child-execution reservation or completed parent-auth recovery.
 */
async function prepareProcessCliStageReservation(
  configuration: WorkspaceSearchMigrationRehearsalProcessCliArguments,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null,
  expectedTargetPreimageArtifactContentDigest: string | null,
  permit: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan | undefined,
  dependencies: CapturedProcessCliDependencies,
): Promise<ProcessCliStagePreparation> {
  let directoryOutcome:
    WorkspaceSearchMigrationRehearsalExclusiveCreateOutcome
  try {
    directoryOutcome =
      await dependencies.createEvidenceDirectoryExclusive(
        configuration.evidenceDirectory,
      )
  } catch {
    throw evidenceDirectoryCreateFailed()
  }
  if (directoryOutcome === 'created') {
    const now = readProcessCliTrustedDate(dependencies.now)
    const permitExpiresAt = readProcessCliPermitExpiry(permit)
    const expiresAtMilliseconds = now.getTime() +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS
    if (
      expiresAtMilliseconds +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS >
      permitExpiresAt
    ) {
      throw invalidProcessCliStageSelection()
    }
    let nonce: Uint8Array | undefined
    try {
      nonce = copyProcessCliReservationNonce(
        dependencies.randomBytes(
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_NONCE_BYTES,
        ),
      )
      const reservation =
        createWorkspaceSearchMigrationRehearsalStageReservation({
          selection,
          nonce,
          reservedAt: now.toISOString(),
          expiresAt: new Date(expiresAtMilliseconds).toISOString(),
          expectedPreviousRateSegment,
          expectedCurrentRateSegmentOrdinal:
            expectedPreviousRateSegment === null
              ? 0
              : expectedPreviousRateSegment.segmentOrdinal + 1,
          expectedTargetPreimageArtifactContentDigest,
          signingKey: runtimeKey,
        })
      const outcome = await dependencies.writeEvidenceFileExclusive(
        configuration.evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
        new TextEncoder().encode(serializeCanonicalJson(reservation)),
      )
      if (outcome !== 'created') {
        throw invalidProcessCliStageSelection()
      }
      return Object.freeze({
        phase: 'execute-child',
        reservation,
      })
    } catch (error: unknown) {
      if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
        throw error
      }
      throw invalidProcessCliStageSelection()
    } finally {
      zeroizeProcessCliKey(nonce)
    }
  }
  if (directoryOutcome !== 'exists') {
    throw evidenceDirectoryCreateFailed()
  }
  let reservationOnly = false
  try {
    await dependencies.validateReservationOnlyDirectory(
      configuration.evidenceDirectory,
    )
    reservationOnly = true
  } catch {
    // A completed evidence phase is authenticated below without a child spawn.
  }
  if (!reservationOnly) {
    try {
      const interruptedRuntimePublicationRecovered =
        await recoverProcessCliInterruptedRuntimeKeyPublication(
          configuration.evidenceDirectory,
          selection,
          expectedPreviousRateSegment,
          expectedTargetPreimageArtifactContentDigest,
          permit,
          runtimeKey,
          publicationKey,
          dependencies.now,
        )
      if (interruptedRuntimePublicationRecovered) {
        throw evidenceDirectoryExists()
      }
      return await recoverProcessCliStageParentAuthentication(
        configuration,
        selection,
        expectedPreviousRateSegment,
        expectedTargetPreimageArtifactContentDigest,
        permit,
        runtimeKey,
        publicationKey,
        faultPlan,
        dependencies,
      )
    } catch (error: unknown) {
      if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
        throw error
      }
      throw evidenceDirectoryExists()
    }
  }
  try {
    const reservationBytes = await dependencies.readInputFile(
      join(
        configuration.evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      ),
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES,
    )
    const reservation =
      parseWorkspaceSearchMigrationRehearsalStageReservationDocument(
        reservationBytes,
        selection,
        runtimeKey,
      )
    requireProcessCliReservationRateBinding(
      reservation,
      expectedPreviousRateSegment,
      expectedTargetPreimageArtifactContentDigest,
    )
    const now = readProcessCliTrustedDate(dependencies.now)
    requireProcessCliReservationActive(reservation, now)
    if (
      Date.parse(reservation.expiresAt) +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS >
      readProcessCliPermitExpiry(permit)
    ) {
      throw invalidProcessCliStageSelection()
    }
    return Object.freeze({
      phase: 'execute-child',
      reservation,
    })
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
      throw error
    }
    throw evidenceDirectoryExists()
  }
}

/**
 * Requires a persisted reservation to retain the pre-spawn rate binding.
 *
 * @param reservation - Authenticated fresh or recovered reservation.
 * @param expectedPreviousRateSegment - Independently verified predecessor.
 * @param expectedTargetPreimageArtifactContentDigest - Authenticated preimage bytes.
 */
function requireProcessCliReservationRateBinding(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null,
  expectedTargetPreimageArtifactContentDigest: string | null,
): void {
  const expectedCurrentRateSegmentOrdinal =
    expectedPreviousRateSegment === null
      ? 0
      : expectedPreviousRateSegment.segmentOrdinal + 1
  if (
    serializeCanonicalJson(reservation.expectedPreviousRateSegment) !==
      serializeCanonicalJson(expectedPreviousRateSegment) ||
    reservation.expectedCurrentRateSegmentOrdinal !==
      expectedCurrentRateSegmentOrdinal ||
    reservation.expectedTargetPreimageArtifactContentDigest !==
      expectedTargetPreimageArtifactContentDigest
  ) throw invalidProcessCliStageSelection()
}

/**
 * Reconstructs parent authentication from a completed pre-expiry child phase.
 *
 * This path never claims, releases a runtime key, or spawns a child. It accepts
 * only the exact immutable material, lifecycle, reservation, and authenticated
 * cleanup pair left by the interrupted parent, remints the genuine cleanup
 * capability, and idempotently publishes the deterministic parent record.
 *
 * @param configuration - Strict process invocation and evidence directory.
 * @param selection - Independently authenticated exact manifest selection.
 * @param expectedPreviousRateSegment - Pre-spawn authenticated predecessor.
 * @param permit - Authenticated permit bounding recovery time.
 * @param runtimeKey - Runtime-only material verification key.
 * @param publicationKey - Parent-only authentication publication key.
 * @param faultPlan - Optional exact reviewed fault plan.
 * @param dependencies - Captured finite filesystem and clock effects.
 * @returns Recovered parent-authentication completion result.
 */
async function recoverProcessCliStageParentAuthentication(
  configuration: WorkspaceSearchMigrationRehearsalProcessCliArguments,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null,
  expectedTargetPreimageArtifactContentDigest: string | null,
  permit: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan | undefined,
  dependencies: CapturedProcessCliDependencies,
): Promise<ProcessCliStagePreparation> {
  const directory = configuration.evidenceDirectory
  const initialEntries =
    await inspectProcessCliParentAuthenticationRecoveryDirectory(directory)
  const reservationBytes = await dependencies.readInputFile(
    join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    ),
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES,
  )
  const reservation =
    parseWorkspaceSearchMigrationRehearsalStageReservationDocument(
      reservationBytes,
      selection,
      runtimeKey,
    )
  requireProcessCliReservationRateBinding(
    reservation,
    expectedPreviousRateSegment,
    expectedTargetPreimageArtifactContentDigest,
  )
  requireProcessCliReservationRecoveryWindow(
    reservation,
    permit,
    readProcessCliTrustedDate(dependencies.now),
  )

  const recoveredLifecycle = await readProcessCliRecoveredLifecycle(
    directory,
    dependencies,
  )
  const materialKind = readProcessCliRecoveryMaterialKind(
    configuration,
    faultPlan,
    recoveredLifecycle.exitClass,
  )
  await recoverProcessCliRequiredEvidencePublications(
    directory,
    initialEntries,
    materialKind,
  )
  const entries = await inspectProcessCliParentAuthenticationRecoveryDirectory(
    directory,
  )
  requireProcessCliRecoveryBaseEntries(entries, materialKind)

  const persistedMaterialEvidence =
    await readProcessCliCanonicalRecoveryEvidence(
      directory,
      materialKind === 'success'
        ? WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME
        : materialKind === 'fault-boundary'
          ? WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME
          : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME,
      dependencies,
    )
  const persistedBoundaryMaterialEvidence =
    materialKind === 'fault-completion'
      ? await readProcessCliCanonicalRecoveryEvidence(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
          dependencies,
        )
      : undefined
  const boundaryRateSegmentBytes = materialKind === 'success'
    ? undefined
    : await dependencies.readInputFile(
        join(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
        ),
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
      )
  const finalRateSegmentBytes = materialKind === 'fault-completion'
    ? await dependencies.readInputFile(
        join(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
        ),
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
      )
    : undefined

  let cleanupRuntimeKey: Uint8Array | undefined
  let cleanupPublicationKey: Uint8Array | undefined
  let cleanupAuthorization:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization
  try {
    cleanupRuntimeKey = new Uint8Array(runtimeKey)
    cleanupPublicationKey = new Uint8Array(publicationKey)
    cleanupAuthorization = await dependencies.cleanupRuntimeKeyFile({
      evidenceDirectory: directory,
      reservation,
      selection,
      expectedRuntimeKey: cleanupRuntimeKey,
      publicationAuthenticationKey: cleanupPublicationKey,
      now: dependencies.now,
    })
  } finally {
    zeroizeProcessCliKey(cleanupRuntimeKey)
    zeroizeProcessCliKey(cleanupPublicationKey)
  }
  const normalizedEntries =
    await inspectProcessCliParentAuthenticationRecoveryDirectory(directory)
  requireExactProcessCliRecoveryEntries(normalizedEntries, materialKind)

  let parentAuthentication: unknown
  if (materialKind === 'success') {
    parentAuthentication =
      createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
        materialKind,
        selection,
        persistedMaterialEvidence,
        persistedLifecycleEvidence:
          recoveredLifecycle.persistedLifecycleEvidence,
        runtimeKeyCleanupAuthorization: cleanupAuthorization,
        runtimeAuthenticationKey: new Uint8Array(runtimeKey),
        publicationAuthenticationKey: new Uint8Array(publicationKey),
      })
  } else if (materialKind === 'fault-boundary') {
    if (faultPlan === undefined || boundaryRateSegmentBytes === undefined) {
      throw evidenceDirectoryExists()
    }
    parentAuthentication =
      createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
        materialKind,
        selection,
        persistedMaterialEvidence,
        persistedLifecycleEvidence:
          recoveredLifecycle.persistedLifecycleEvidence,
        faultPlan,
        boundaryRateSegmentBytes,
        runtimeKeyCleanupAuthorization: cleanupAuthorization,
        runtimeAuthenticationKey: new Uint8Array(runtimeKey),
        publicationAuthenticationKey: new Uint8Array(publicationKey),
      })
  } else {
    if (
      faultPlan === undefined ||
      persistedBoundaryMaterialEvidence === undefined ||
      boundaryRateSegmentBytes === undefined ||
      finalRateSegmentBytes === undefined
    ) throw evidenceDirectoryExists()
    parentAuthentication =
      createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
        materialKind,
        selection,
        persistedMaterialEvidence,
        persistedBoundaryMaterialEvidence,
        persistedLifecycleEvidence:
          recoveredLifecycle.persistedLifecycleEvidence,
        faultPlan,
        boundaryRateSegmentBytes,
        finalRateSegmentBytes,
        runtimeKeyCleanupAuthorization: cleanupAuthorization,
        runtimeAuthenticationKey: new Uint8Array(runtimeKey),
        publicationAuthenticationKey: new Uint8Array(publicationKey),
      })
  }
  await persistRecoveredStageParentAuthentication(
    directory,
    parentAuthentication,
    dependencies,
  )
  return Object.freeze({
    phase: 'parent-authentication-recovered',
    reservation,
    exitClass: recoveredLifecycle.exitClass,
    lifecycleSha256: recoveredLifecycle.lifecycleSha256,
    receiptSha256: recoveredLifecycle.receiptSha256,
  })
}

/** Requires recovery to remain within the reservation's fixed permit window. */
function requireProcessCliReservationRecoveryWindow(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  permit: unknown,
  now: Date,
): void {
  const reservedAt = Date.parse(reservation.reservedAt)
  const expiresAt = Date.parse(reservation.expiresAt)
  const recoveryEndsAt = expiresAt +
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS
  if (
    now.getTime() < reservedAt ||
    now.getTime() > recoveryEndsAt ||
    recoveryEndsAt +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS >
      readProcessCliPermitExpiry(permit)
  ) throw invalidProcessCliStageSelection()
}

/** Infers the sole material shape permitted by mode and final exit class. */
function readProcessCliRecoveryMaterialKind(
  configuration: WorkspaceSearchMigrationRehearsalProcessCliArguments,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan | undefined,
  exitClass: ProcessCliRecoveredLifecycleResult['exitClass'],
): ProcessCliRecoveryMaterialKind {
  if (
    configuration.executionMode === 'success' &&
    faultPlan === undefined &&
    exitClass === 'successful-no-fault'
  ) return 'success'
  if (configuration.executionMode !== 'fault' || faultPlan === undefined) {
    throw evidenceDirectoryExists()
  }
  if (exitClass === 'confirmed-sigkill') return 'fault-boundary'
  if (exitClass === 'successful-response-loss') return 'fault-completion'
  throw evidenceDirectoryExists()
}

/** Reads and verifies the digest-only fields of one canonical lifecycle file. */
async function readProcessCliRecoveredLifecycle(
  directory: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile'
  >,
): Promise<ProcessCliRecoveredLifecycleResult> {
  const persistedLifecycleEvidence =
    await readProcessCliCanonicalRecoveryEvidence(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
      dependencies,
    )
  const record = requireProcessCliRecoveryRecord(persistedLifecycleEvidence)
  requireProcessCliRecoveryRecordKeys(record, [
    'kind',
    'lifecycle',
    'lifecycleSha256',
  ])
  if (
    readProcessCliRecoveryProperty(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence'
  ) throw evidenceDirectoryExists()
  const lifecycle = requireProcessCliRecoveryRecord(
    readProcessCliRecoveryProperty(record, 'lifecycle'),
  )
  const lifecycleSha256 = readProcessCliRecoveryDigest(
    readProcessCliRecoveryProperty(record, 'lifecycleSha256'),
  )
  if (createMigrationDigest(lifecycle) !== lifecycleSha256) {
    throw evidenceDirectoryExists()
  }
  const exitClassValue = readProcessCliRecoveryProperty(
    lifecycle,
    'exitClass',
  )
  if (
    exitClassValue !== 'successful-no-fault' &&
    exitClassValue !== 'confirmed-sigkill' &&
    exitClassValue !== 'successful-response-loss'
  ) throw evidenceDirectoryExists()
  let receiptSha256: string
  if (exitClassValue === 'successful-no-fault') {
    receiptSha256 = readProcessCliRecoveryDigest(
      readProcessCliRecoveryProperty(lifecycle, 'materialDigest'),
    )
  } else if (exitClassValue === 'successful-response-loss') {
    receiptSha256 = readProcessCliRecoveryDigest(
      readProcessCliRecoveryProperty(lifecycle, 'completionMaterialDigest'),
    )
  } else {
    receiptSha256 = readProcessCliRecoveryDigest(
      readProcessCliRecoveryProperty(lifecycle, 'boundaryMaterialDigest'),
    )
  }
  return Object.freeze({
    persistedLifecycleEvidence,
    lifecycle,
    exitClass: exitClassValue,
    lifecycleSha256,
    receiptSha256,
  })
}

/** Reads one canonical bounded recovery evidence wrapper. */
async function readProcessCliCanonicalRecoveryEvidence(
  directory: string,
  filename: WorkspaceSearchMigrationRehearsalEvidenceFilename,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile'
  >,
): Promise<unknown> {
  const bytes = await dependencies.readInputFile(
    join(directory, filename),
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_EVIDENCE_MAX_BYTES,
  )
  return detachCanonicalEvidenceDocument(bytes)
}

/** Idempotently persists or exact-compares the recovered parent record. */
async function persistRecoveredStageParentAuthentication(
  directory: string,
  parentAuthentication: unknown,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile' | 'writeEvidenceFileExclusive'
  >,
): Promise<void> {
  const expectedBytes = encodeEvidenceDocument(parentAuthentication)
  const outcome = await dependencies.writeEvidenceFileExclusive(
    directory,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
    expectedBytes,
  )
  if (outcome === 'created') return
  if (outcome !== 'exists') throw parentAuthenticationWriteFailed()
  const existingBytes = await dependencies.readInputFile(
    join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
    ),
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_EVIDENCE_MAX_BYTES,
  )
  if (!equalProcessCliBytes(existingBytes, expectedBytes)) {
    throw parentAuthenticationWriteFailed()
  }
}

/** Narrows one detached JSON value to an ordinary non-proxy record. */
function requireProcessCliRecoveryRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw evidenceDirectoryExists()
  return value
}

/** Requires exact own enumerable keys on one detached recovery record. */
function requireProcessCliRecoveryRecordKeys(
  value: object,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) throw evidenceDirectoryExists()
}

/** Reads one own data property without invoking accessors. */
function readProcessCliRecoveryProperty(
  value: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) throw evidenceDirectoryExists()
  return descriptor.value
}

/** Reads one lowercase digest from a recovered detached wrapper. */
function readProcessCliRecoveryDigest(value: unknown): string {
  if (typeof value !== 'string' || !isHexDigest(value)) {
    throw evidenceDirectoryExists()
  }
  return value
}

/**
 * Parses and pins the production control command authorized by one stage.
 *
 * The production parser result is retained exactly once. A rehearsal stage
 * may neither select another command nor bootstrap the shared rate ledger.
 *
 * @param controlArguments - Detached exact control argument vector.
 * @param selection - Independently authenticated manifest selection.
 * @returns Frozen production parser result used by the reservation claim.
 */
function parseProcessCliAuthenticatedControl(
  controlArguments: readonly string[],
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
): ProcessCliAuthenticatedControl {
  try {
    const control = parseWorkspaceSearchMigrationControlCliArguments(
      controlArguments,
    )
    if (!isProcessCliPlainDataRecord(control)) {
      throw invalidProcessCliStageSelection()
    }
    const command = readProcessCliOwnDataProperty(control, 'command')
    const rateBootstrap = readProcessCliOwnDataProperty(
      control,
      'rateBootstrap',
    )
    if (control.command === 'help') {
      throw invalidProcessCliStageSelection()
    }
    if (
      command !== control.command ||
      rateBootstrap !== control.rateBootstrap ||
      control.command !== selection.entry.command ||
      control.rateBootstrap !== false
    ) {
      throw invalidProcessCliStageSelection()
    }
    return Object.freeze(control)
  } catch {
    throw invalidProcessCliStageSelection()
  }
}

/**
 * Checks that one parser result is a non-Proxy plain own-data record.
 *
 * @param value - Candidate production parser result.
 * @returns Whether every own field is an enumerable direct data property.
 */
function isProcessCliPlainDataRecord(value: unknown): value is object {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return false
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false
      const descriptor = descriptors[key]
      return descriptor !== undefined &&
        descriptor.enumerable &&
        descriptor.get === undefined &&
        descriptor.set === undefined &&
        Object.hasOwn(descriptor, 'value')
    })
  } catch {
    return false
  }
}

/**
 * Reads one required own enumerable data property without invoking accessors.
 *
 * @param value - Already validated plain parser-result record.
 * @param key - Required parser-result property name.
 * @returns Exact direct property value.
 */
function readProcessCliOwnDataProperty(
  value: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !Object.hasOwn(descriptor, 'value')
  ) throw invalidProcessCliStageSelection()
  return descriptor.value
}

/**
 * Runs the standalone AWS preflight and claims the exact parent reservation.
 *
 * @param control - Frozen production-parsed authenticated stage control.
 * @param selection - Independently authenticated exact manifest selection.
 * @param permit - Exact authenticated non-production permit.
 * @param reservation - Parent-persisted exact stage reservation.
 * @param previousReceipt - Runtime-authenticated immediate predecessor.
 * @param runtimeKey - Runtime-only permit and stage verification key.
 * @param publicationKey - Parent-only commit-journal verification key.
 * @param dependencies - Captured bounded reader, clock, and claim effect.
 */
async function claimProcessCliStageReservation(
  control: ProcessCliAuthenticatedControl,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  permit: unknown,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  dependencies: CapturedProcessCliDependencies,
): Promise<void> {
  try {
    const ratePolicyBytes = await dependencies.readInputFile(
      control.ratePolicyFile,
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
    )
    const ratePolicy =
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
        ratePolicyBytes,
      )
    if (ratePolicy.policyVersion !== selection.manifest.policyVersion) {
      throw invalidProcessCliStageSelection()
    }
    requireProcessCliReservationActive(
      reservation,
      readProcessCliTrustedDate(dependencies.now),
    )
    const head = await dependencies.claimStageReservation({
      requested: control.resources,
      ratePolicy,
      permit,
      permitVerificationKey: runtimeKey,
      permitClock: dependencies.now,
      stageReservationClaim: {
        reservation,
        selection,
        previousReceipt,
        stageKey: runtimeKey,
        publicationKey,
      },
    })
    requireProcessCliClaimedStageHead(head, reservation)
    requireProcessCliReservationActive(
      reservation,
      readProcessCliTrustedDate(dependencies.now),
    )
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
      throw error
    }
    throw invalidProcessCliStageSelection()
  }
}

/** Requires an exact active-head projection for the parent-persisted token. */
function requireProcessCliClaimedStageHead(
  head: WorkspaceSearchMigrationRehearsalStageHead,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
): void {
  if (
    typeof head !== 'object' ||
    head === null ||
    nodeUtilTypes.isProxy(head) ||
    head.manifestDigest !== reservation.manifestDigest ||
    head.completedStageOrdinal !== reservation.stageOrdinal - 1 ||
    head.headReceiptDigest !== reservation.previousStageReceiptDigest ||
    head.activeReservationDigest !== createMigrationDigest(reservation) ||
    head.activeStageOrdinal !== reservation.stageOrdinal ||
    head.activeExpiresAt !== reservation.expiresAt ||
    !Number.isSafeInteger(head.abandonmentCount) ||
    head.abandonmentCount < 0 ||
    !isHexDigest(head.abandonmentRootDigest) ||
    !Number.isSafeInteger(head.revision) ||
    head.revision < 1
  ) {
    throw invalidProcessCliStageSelection()
  }
}

/** Reads one direct valid Date from a captured trusted clock. */
function readProcessCliTrustedDate(now: () => Date): Date {
  let candidate: unknown
  try {
    candidate = now()
  } catch {
    throw invalidProcessCliStageSelection()
  }
  if (!(candidate instanceof Date) || nodeUtilTypes.isProxy(candidate)) {
    throw invalidProcessCliStageSelection()
  }
  let milliseconds: number
  try {
    milliseconds = Date.prototype.getTime.call(candidate)
  } catch {
    throw invalidProcessCliStageSelection()
  }
  if (!Number.isFinite(milliseconds)) {
    throw invalidProcessCliStageSelection()
  }
  return new Date(milliseconds)
}

/** Reads the canonical authenticated permit expiry without invoking getters. */
function readProcessCliPermitExpiry(permit: unknown): number {
  if (
    typeof permit !== 'object' ||
    permit === null ||
    nodeUtilTypes.isProxy(permit)
  ) {
    throw invalidProcessCliStageSelection()
  }
  const descriptor = Object.getOwnPropertyDescriptor(permit, 'expiresAt')
  const expiresAt = descriptor?.value
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    !isCanonicalTimestamp(expiresAt)
  ) {
    throw invalidProcessCliStageSelection()
  }
  const milliseconds = Date.parse(expiresAt)
  if (!Number.isFinite(milliseconds)) {
    throw invalidProcessCliStageSelection()
  }
  return milliseconds
}

/** Requires the parent token to be admitted only inside its half-open window. */
function requireProcessCliReservationActive(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  now: Date,
): void {
  if (!isProcessCliReservationActive(reservation, now)) {
    throw invalidProcessCliStageSelection()
  }
}

/**
 * Derives the only child runtime admitted by the active reservation window.
 *
 * @param reservation - Authenticated active parent reservation.
 * @param command - Exact selected stage command whose drain floor is known.
 * @param now - Captured trusted parent clock shared with the child runner.
 * @returns Frozen clock and wall-time timeout bounded before finalization.
 */
function createProcessCliStageRunnerBoundary(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  command: WorkspaceSearchMigrationRehearsalSelectedStage['entry']['command'],
  now: () => Date,
): ProcessCliStageRunnerBoundary {
  const admittedAt = readProcessCliTrustedDate(now)
  requireProcessCliReservationActive(reservation, admittedAt)
  const expiresAtMilliseconds = Date.parse(reservation.expiresAt)
  const runtimeDeadlineMilliseconds =
    expiresAtMilliseconds -
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZATION_SAFETY_MARGIN_MILLISECONDS -
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS
  const availableRuntimeMilliseconds =
    runtimeDeadlineMilliseconds - admittedAt.getTime()
  const minimumRuntimeMilliseconds = command === 'close-replan'
    ? MINIMUM_MAINTENANCE_DRAIN_SECONDS * 1_000 +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MINIMUM_CHILD_RUNTIME_MILLISECONDS
    : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MINIMUM_CHILD_RUNTIME_MILLISECONDS
  if (
    !Number.isSafeInteger(availableRuntimeMilliseconds) ||
    availableRuntimeMilliseconds < minimumRuntimeMilliseconds
  ) {
    throw invalidProcessCliStageSelection()
  }
  const runtimeTimeoutMilliseconds = Math.min(
    availableRuntimeMilliseconds,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_RUNTIME_MILLISECONDS,
  )
  const capturedDeadlineMilliseconds =
    admittedAt.getTime() + runtimeTimeoutMilliseconds
  return Object.freeze({
    now: (): string => {
      const current = readProcessCliTrustedDate(now)
      if (current.getTime() >= capturedDeadlineMilliseconds) {
        throw new WorkspaceSearchMigrationRehearsalProcessRunnerError(
          'PROCESS_RUNTIME_TIMEOUT',
        )
      }
      return current.toISOString()
    },
    runtimeTimeoutMilliseconds,
  })
}

/**
 * Requires successful child completion to leave the parent durability margin.
 *
 * @param reservation - Authenticated reservation owning the completed child.
 * @param now - Trusted parent observation made after child settlement.
 */
function requireProcessCliFinalizationWindow(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  now: Date,
): void {
  const finalizationDeadlineMilliseconds =
    Date.parse(reservation.expiresAt) -
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZATION_SAFETY_MARGIN_MILLISECONDS
  if (
    now.getTime() < Date.parse(reservation.reservedAt) ||
    now.getTime() >= finalizationDeadlineMilliseconds
  ) {
    throw processFailed()
  }
}

/** Tests one authenticated reservation against a trusted parent timestamp. */
function isProcessCliReservationActive(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  now: Date,
): boolean {
  const milliseconds = now.getTime()
  return (
    Date.parse(reservation.reservedAt) <= milliseconds &&
    milliseconds < Date.parse(reservation.expiresAt)
  )
}

/** Copies exact ordinary process-local reservation entropy. */
function copyProcessCliReservationNonce(candidate: unknown): Uint8Array {
  if (
    !(candidate instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(candidate) ||
    candidate.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_NONCE_BYTES ||
    isProcessCliSharedArrayBuffer(candidate.buffer)
  ) {
    throw invalidProcessCliStageSelection()
  }
  const copy = new Uint8Array(candidate)
  zeroizeProcessCliKey(candidate)
  return copy
}

/** Detects a shared backing store without assuming platform availability. */
function isProcessCliSharedArrayBuffer(buffer: ArrayBufferLike): boolean {
  return typeof SharedArrayBuffer !== 'undefined' &&
    buffer instanceof SharedArrayBuffer
}

/** Reads one exact bounded stage document and normalizes reader failures. */
async function readProcessCliStageFile(
  path: string,
  maximumBytes: number,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'readInputFile'
  >,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readInputFile(path, maximumBytes)
  } catch {
    throw invalidProcessCliStageSelection()
  }
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) throw invalidProcessCliStageSelection()
  return bytes
}

/** Builds the only child CLI argument layout authorized by this parent. */
function createRehearsalControlChildArguments(
  configuration: WorkspaceSearchMigrationRehearsalProcessCliArguments,
  runtimeKeyPath: string,
): readonly string[] {
  return Object.freeze([
    '--rehearsal-permit-file',
    configuration.permitFile,
    '--rehearsal-permit-key-file',
    runtimeKeyPath,
    '--rehearsal-rate-segment-file',
    join(
      configuration.evidenceDirectory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
    ),
    '--rehearsal-rate-configuration-hash',
    configuration.rateConfigurationHash,
    ...(configuration.ratePreviousSegmentFile === undefined
      ? []
      : [
          '--rehearsal-rate-previous-segment-file',
          configuration.ratePreviousSegmentFile,
        ]),
    '--rehearsal-stage-manifest-file',
    configuration.stageManifestFile,
    ...(configuration.previousStageReceiptFile === undefined
      ? []
      : [
          '--rehearsal-previous-stage-receipt-file',
          configuration.previousStageReceiptFile,
        ]),
    '--rehearsal-stage-key-file',
    runtimeKeyPath,
    '--rehearsal-stage-reservation-file',
    join(
      configuration.evidenceDirectory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
    ),
    ...(configuration.executionMode === 'fault'
      ? [
          '--rehearsal-fault-plan-file',
          configuration.faultPlanFile,
        ]
      : [
          '--rehearsal-success-protocol',
          configuration.successProtocol,
        ]),
    '--',
    ...configuration.controlArguments,
  ])
}

/** Persists authenticated fault-boundary material before ACK or SIGKILL. */
async function persistFaultBoundaryMaterialEvidence(
  directory: string,
  input: WorkspaceSearchMigrationRehearsalDurableFaultBoundaryMaterialInput,
  signal: AbortSignal,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'writeEvidenceFileExclusive'
  >,
): Promise<unknown> {
  try {
    if (
      !isHexDigest(input.materialDigest) ||
      !isCanonicalTimestamp(input.observedAt) ||
      createMigrationDigest(input.material) !== input.materialDigest
    ) throw faultMaterialWriteFailed()
    const evidence:
      WorkspaceSearchMigrationRehearsalFaultBoundaryMaterialEvidence = {
        kind:
          'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence',
        evidenceVersion: 1,
        material: input.material,
        materialDigest: input.materialDigest,
        observedAt: input.observedAt,
      }
    const bytes = encodeEvidenceDocument(evidence)
    const outcome = await dependencies.writeEvidenceFileExclusive(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
      bytes,
      signal,
    )
    if (outcome !== 'created') throw faultMaterialWriteFailed()
    return detachCanonicalEvidenceDocument(bytes)
  } catch {
    throw faultMaterialWriteFailed()
  }
}

/** Persists authenticated response-loss completion before its final ACK. */
async function persistFaultCompletionMaterialEvidence(
  directory: string,
  input: WorkspaceSearchMigrationRehearsalDurableFaultCompletionMaterialInput,
  signal: AbortSignal,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'writeEvidenceFileExclusive'
  >,
): Promise<unknown> {
  try {
    if (
      !isHexDigest(input.materialDigest) ||
      !isCanonicalTimestamp(input.observedAt) ||
      createMigrationDigest(input.material) !== input.materialDigest
    ) throw faultMaterialWriteFailed()
    const evidence:
      WorkspaceSearchMigrationRehearsalFaultCompletionMaterialEvidence = {
        kind:
          'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence',
        evidenceVersion: 1,
        material: input.material,
        materialDigest: input.materialDigest,
        observedAt: input.observedAt,
      }
    const bytes = encodeEvidenceDocument(evidence)
    const outcome = await dependencies.writeEvidenceFileExclusive(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME,
      bytes,
      signal,
    )
    if (outcome !== 'created') throw faultMaterialWriteFailed()
    return detachCanonicalEvidenceDocument(bytes)
  } catch {
    throw faultMaterialWriteFailed()
  }
}

/** Persists the exact authenticated rate prefix before releasing a fault. */
async function persistFaultBoundaryRateSegment(
  directory: string,
  rateSegmentBytes: Uint8Array,
  expectedDigest: string,
  signal: AbortSignal,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'writeEvidenceFileExclusive'
  >,
): Promise<void> {
  try {
    if (
      !isHexDigest(expectedDigest) ||
      !(rateSegmentBytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(rateSegmentBytes) ||
      rateSegmentBytes.byteLength === 0 ||
      rateSegmentBytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES ||
      createHash('sha256').update(rateSegmentBytes).digest('hex') !==
        expectedDigest
    ) throw faultMaterialWriteFailed()
    const outcome = await dependencies.writeEvidenceFileExclusive(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
      new Uint8Array(rateSegmentBytes),
      signal,
    )
    if (outcome !== 'created') throw faultMaterialWriteFailed()
  } catch {
    throw faultMaterialWriteFailed()
  }
}

/** Persists authenticated child material behind the parent fsync barrier. */
async function persistSuccessMaterialEvidence(
  directory: string,
  input: WorkspaceSearchMigrationRehearsalDurableSuccessMaterialInput,
  signal: AbortSignal,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'writeEvidenceFileExclusive'
  >,
): Promise<unknown> {
  try {
    if (
      !isHexDigest(input.materialDigest) ||
      !isCanonicalTimestamp(input.observedAt) ||
      createMigrationDigest(input.material) !== input.materialDigest
    ) {
      throw successMaterialWriteFailed()
    }
    const evidence:
      WorkspaceSearchMigrationRehearsalChildMaterialEvidence = {
        kind:
          'mukuroji-workspace-search-migration-rehearsal-child-material-evidence',
        evidenceVersion: 1,
        material: input.material,
        materialDigest: input.materialDigest,
        observedAt: input.observedAt,
      }
    const bytes = encodeEvidenceDocument(evidence)
    const outcome = await dependencies.writeEvidenceFileExclusive(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
      bytes,
      signal,
    )
    if (outcome !== 'created') throw successMaterialWriteFailed()
    return detachCanonicalEvidenceDocument(bytes)
  } catch {
    throw successMaterialWriteFailed()
  }
}

/** Returns the authenticated protocol digest exposed by one lifecycle. */
function readProcessCliLifecycleProtocolDigest(
  lifecycle:
    | WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence,
): string {
  if (lifecycle.exitClass === 'successful-no-fault') {
    const materialDigest = Object.getOwnPropertyDescriptor(
      lifecycle,
      'materialDigest',
    )?.value
    if (typeof materialDigest === 'string' && isHexDigest(materialDigest)) {
      return materialDigest
    }
  }
  if (
    lifecycle.exitClass === 'confirmed-sigkill' ||
    lifecycle.exitClass === 'successful-response-loss'
  ) {
    const completionMaterialDigest = Object.getOwnPropertyDescriptor(
      lifecycle,
      'completionMaterialDigest',
    )?.value
    if (
      typeof completionMaterialDigest === 'string' &&
      isHexDigest(completionMaterialDigest)
    ) return completionMaterialDigest
    const boundaryMaterialDigest = Object.getOwnPropertyDescriptor(
      lifecycle,
      'boundaryMaterialDigest',
    )?.value
    if (
      typeof boundaryMaterialDigest === 'string' &&
      isHexDigest(boundaryMaterialDigest)
    ) return boundaryMaterialDigest
  }
  const receiptDigest = Object.getOwnPropertyDescriptor(
    lifecycle,
    'receiptSha256',
  )?.value
  if (typeof receiptDigest !== 'string' || !isHexDigest(receiptDigest)) {
    throw operationFailed()
  }
  return receiptDigest
}

/** Persists one canonical lifecycle document after verified child termination. */
async function persistLifecycleEvidence(
  directory: string,
  lifecycle:
    | WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalSuccessfulProcessLifecycleEvidence,
  lifecycleSha256: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'writeEvidenceFileExclusive'
  >,
): Promise<unknown> {
  try {
    if (!isHexDigest(lifecycleSha256)) throw lifecycleWriteFailed()
    const evidence: WorkspaceSearchMigrationRehearsalLifecycleEvidenceFile = {
      kind:
        'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
      lifecycle,
      lifecycleSha256,
    }
    const bytes = encodeEvidenceDocument(evidence)
    const outcome = await dependencies.writeEvidenceFileExclusive(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
      bytes,
    )
    if (outcome !== 'created') throw lifecycleWriteFailed()
    return detachCanonicalEvidenceDocument(bytes)
  } catch {
    throw lifecycleWriteFailed()
  }
}

/** Persists one parent-origin evidence authentication record before success. */
async function persistStageParentAuthentication(
  directory: string,
  parentAuthentication: unknown,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies,
    'writeEvidenceFileExclusive'
  >,
): Promise<void> {
  try {
    const bytes = encodeEvidenceDocument(parentAuthentication)
    const outcome = await dependencies.writeEvidenceFileExclusive(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
      bytes,
    )
    if (outcome !== 'created') throw parentAuthenticationWriteFailed()
  } catch {
    throw parentAuthenticationWriteFailed()
  }
}

/** Encodes and bounds one exact canonical safe evidence document. */
function encodeEvidenceDocument(value: unknown): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  } catch {
    throw outputBoundaryFailed()
  }
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_EVIDENCE_MAX_BYTES
  ) {
    throw outputBoundaryFailed()
  }
  return bytes
}

/** Parses exact canonical bytes into a private detached persisted snapshot. */
function detachCanonicalEvidenceDocument(bytes: Uint8Array): unknown {
  try {
    const serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(serialized)
    if (serializeCanonicalJson(value) !== serialized) {
      throw outputBoundaryFailed()
    }
    return value
  } catch {
    throw outputBoundaryFailed()
  }
}

/** Captures every injected effect before the first filesystem await. */
function snapshotProcessCliDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies,
): CapturedProcessCliDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) {
    throw operationFailed()
  }
  let readInputFile: WorkspaceSearchMigrationRehearsalProcessCliDependencies['readInputFile']
  let readStageKeyFile: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies['readStageKeyFile']
  >
  let createEvidenceDirectoryExclusive: WorkspaceSearchMigrationRehearsalProcessCliDependencies['createEvidenceDirectoryExclusive']
  let writeEvidenceFileExclusive: WorkspaceSearchMigrationRehearsalProcessCliDependencies['writeEvidenceFileExclusive']
  let claimStageReservation: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies[
      'claimStageReservation'
    ]
  >
  let writeRuntimeKeyFileExclusive: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies[
      'writeRuntimeKeyFileExclusive'
    ]
  >
  let cleanupRuntimeKeyFile: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies[
      'cleanupRuntimeKeyFile'
    ]
  >
  let validateReservationOnlyDirectory: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies[
      'validateReservationOnlyDirectory'
    ]
  >
  let now: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies['now']
  >
  let randomBytesFunction: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies['randomBytes']
  >
  let spawnControlChild: WorkspaceSearchMigrationRehearsalProcessCliDependencies['spawnControlChild']
  let runProcess: WorkspaceSearchMigrationRehearsalProcessCliDependencies['runProcess']
  let runAuthenticatedFaultProcess: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies[
      'runAuthenticatedFaultProcess'
    ]
  >
  let runNoFaultProcess: WorkspaceSearchMigrationRehearsalProcessCliDependencies['runNoFaultProcess']
  let runSuccessfulProcess: NonNullable<
    WorkspaceSearchMigrationRehearsalProcessCliDependencies['runSuccessfulProcess']
  >
  let installSignalHandler: WorkspaceSearchMigrationRehearsalProcessCliDependencies['installSignalHandler']
  let writeStdoutLine: WorkspaceSearchMigrationRehearsalProcessCliDependencies['writeStdoutLine']
  let writeStderrLine: WorkspaceSearchMigrationRehearsalProcessCliDependencies['writeStderrLine']
  try {
    readInputFile = dependencies.readInputFile
    readStageKeyFile =
      dependencies.readStageKeyFile ??
      readWorkspaceSearchMigrationRehearsalPermitSigningKey
    createEvidenceDirectoryExclusive =
      dependencies.createEvidenceDirectoryExclusive
    writeEvidenceFileExclusive = dependencies.writeEvidenceFileExclusive
    claimStageReservation =
      dependencies.claimStageReservation ??
      claimAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation
    writeRuntimeKeyFileExclusive =
      dependencies.writeRuntimeKeyFileExclusive ??
      writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive
    cleanupRuntimeKeyFile =
      dependencies.cleanupRuntimeKeyFile ??
      cleanupWorkspaceSearchMigrationRehearsalRuntimeKey
    validateReservationOnlyDirectory =
      dependencies.validateReservationOnlyDirectory ??
      validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory
    now = dependencies.now ?? ((): Date => new Date())
    randomBytesFunction = dependencies.randomBytes ??
      ((size): Uint8Array => randomBytes(size))
    spawnControlChild = dependencies.spawnControlChild
    runProcess = dependencies.runProcess
    runAuthenticatedFaultProcess =
      dependencies.runAuthenticatedFaultProcess ??
      runWorkspaceSearchMigrationRehearsalAuthenticatedFaultProcess
    runNoFaultProcess = dependencies.runNoFaultProcess
    runSuccessfulProcess =
      dependencies.runSuccessfulProcess ??
      runWorkspaceSearchMigrationRehearsalSuccessfulProcess
    installSignalHandler = dependencies.installSignalHandler
    writeStdoutLine = dependencies.writeStdoutLine
    writeStderrLine = dependencies.writeStderrLine
  } catch {
    throw operationFailed()
  }
  if (
    !isDirectProcessCliFunction(readInputFile) ||
    !isDirectProcessCliFunction(readStageKeyFile) ||
    !isDirectProcessCliFunction(createEvidenceDirectoryExclusive) ||
    !isDirectProcessCliFunction(writeEvidenceFileExclusive) ||
    !isDirectProcessCliFunction(claimStageReservation) ||
    !isDirectProcessCliFunction(writeRuntimeKeyFileExclusive) ||
    !isDirectProcessCliFunction(cleanupRuntimeKeyFile) ||
    !isDirectProcessCliFunction(validateReservationOnlyDirectory) ||
    !isDirectProcessCliFunction(now) ||
    !isDirectProcessCliFunction(randomBytesFunction) ||
    !isDirectProcessCliFunction(spawnControlChild) ||
    !isDirectProcessCliFunction(runProcess) ||
    !isDirectProcessCliFunction(runAuthenticatedFaultProcess) ||
    !isDirectProcessCliFunction(runNoFaultProcess) ||
    !isDirectProcessCliFunction(runSuccessfulProcess) ||
    !isDirectProcessCliFunction(installSignalHandler) ||
    !isDirectProcessCliFunction(writeStdoutLine) ||
    !isDirectProcessCliFunction(writeStderrLine)
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    readInputFile: (path, maximumBytes) =>
      readInputFile(path, maximumBytes),
    readStageKeyFile: (path) => readStageKeyFile(path),
    createEvidenceDirectoryExclusive: (directoryPath) =>
      createEvidenceDirectoryExclusive(directoryPath),
    writeEvidenceFileExclusive: (directoryPath, filename, bytes, signal) =>
      writeEvidenceFileExclusive(directoryPath, filename, bytes, signal),
    claimStageReservation: (input) => claimStageReservation(input),
    writeRuntimeKeyFileExclusive: (directoryPath, key) =>
      writeRuntimeKeyFileExclusive(directoryPath, key),
    cleanupRuntimeKeyFile: (input) => cleanupRuntimeKeyFile(input),
    validateReservationOnlyDirectory: (directoryPath) =>
      validateReservationOnlyDirectory(directoryPath),
    now: () => now(),
    randomBytes: (size) => randomBytesFunction(size),
    spawnControlChild: (childArguments) =>
      spawnControlChild(childArguments),
    runProcess: (input) => runProcess(input),
    runAuthenticatedFaultProcess: (input) =>
      runAuthenticatedFaultProcess(input),
    runNoFaultProcess: (input) => runNoFaultProcess(input),
    runSuccessfulProcess: (input) => runSuccessfulProcess(input),
    installSignalHandler: (handler) => installSignalHandler(handler),
    writeStdoutLine: (line) => writeStdoutLine(line),
    writeStderrLine: (line) => writeStderrLine(line),
  })
}

/** Checks one injected effect without permitting callable Proxy traps. */
function isDirectProcessCliFunction(
  value: unknown,
): value is (...arguments_: readonly never[]) => unknown {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Detaches only a direct ordinary parent argument vector.
 *
 * @param arguments_ - Candidate process argument array.
 * @returns Frozen primitive snapshot used by every later parse boundary.
 */
function snapshotProcessCliArguments(
  arguments_: readonly string[],
): readonly string[] {
  if (
    nodeUtilTypes.isProxy(arguments_) ||
    !Array.isArray(arguments_)
  ) throw invalidProcessCliUsage()
  let lengthDescriptor: PropertyDescriptor | undefined
  let prototype: object | null
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(arguments_, 'length')
    prototype = Object.getPrototypeOf(arguments_)
  } catch {
    throw invalidProcessCliUsage()
  }
  const length = lengthDescriptor?.value
  if (
    prototype !== Array.prototype ||
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length)
  ) throw invalidProcessCliUsage()
  if (length < 14 || length > 271) throw invalidProcessCliUsage()
  const snapshot: string[] = []
  try {
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        arguments_,
        String(index),
      )
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !Object.hasOwn(descriptor, 'value')
      ) throw invalidProcessCliUsage()
      const value = descriptor.value
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 8_192 ||
        value.includes('\0')
      ) {
        throw invalidProcessCliUsage()
      }
      snapshot.push(value)
    }
  } catch {
    throw invalidProcessCliUsage()
  }
  return Object.freeze(snapshot)
}

/** Copies and bounds the parent-created child argument vector. */
function snapshotChildArguments(arguments_: readonly string[]): readonly string[] {
  let length: number
  try {
    length = arguments_.length
  } catch {
    throw spawnFailed()
  }
  if (length < 12 || length > 267) throw spawnFailed()
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
        throw spawnFailed()
      }
      snapshot.push(value)
    }
  } catch {
    throw spawnFailed()
  }
  return Object.freeze(snapshot)
}

/** Requires one bounded nonblank explicit path without resolving it. */
function requireProcessCliPath(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0') ||
    value.length > 4_096
  ) {
    throw invalidProcessCliUsage()
  }
  return value
}

/**
 * Returns the fixed terminal contract for one admitted no-fault scenario.
 *
 * @param scenario - Candidate no-fault scenario selected before spawn.
 * @returns Scenario-bound purpose, command, and terminal state.
 */
function readProcessCliNoFaultOutcome(
  scenario: unknown,
): {
  /** Exact admitted scenario. */
  readonly scenario: WorkspaceSearchMigrationRehearsalNoFaultScenario
  /** Purpose preventing terminal-evidence replay. */
  readonly purpose: 'verified' | 'complete-rollback'
  /** Only command that can complete this scenario. */
  readonly terminalCommand: 'verify' | 'rollback-complete'
  /** Required authoritative terminal state. */
  readonly terminalKind: 'verified' | 'rolled-back'
} {
  if (scenario === 'happy-path-verified') {
    return Object.freeze({
      scenario,
      purpose: 'verified',
      terminalCommand: 'verify',
      terminalKind: 'verified',
    })
  }
  if (scenario === 'complete-apply-rollback') {
    return Object.freeze({
      scenario,
      purpose: 'complete-rollback',
      terminalCommand: 'rollback-complete',
      terminalKind: 'rolled-back',
    })
  }
  throw invalidProcessCliUsage()
}

/** Zeroizes one raw stage-key buffer without replacing the run outcome. */
function zeroizeProcessCliKey(key: Uint8Array | undefined): void {
  if (key === undefined) return
  try {
    Uint8Array.prototype.fill.call(key, 0)
  } catch {
    // The authoritative process outcome remains unchanged by cleanup failure.
  }
}

/** Requires that no parent interruption was observed before an action. */
function requireProcessCliNotInterrupted(
  signal: WorkspaceSearchMigrationRehearsalParentSignal | undefined,
): void {
  if (signal !== undefined) throw interrupted(signal)
}

/** Best-effort hard-kills and finitely reaps one started child. */
async function bestEffortContainChild(
  child: WorkspaceSearchMigrationRehearsalProcessPort,
): Promise<void> {
  try {
    await settleProcessCliContainmentStep(
      Promise.resolve(child.kill('SIGKILL')),
    )
    await settleProcessCliContainmentStep(Promise.resolve(child.exited))
  } catch {
    // Containment is best effort after the authoritative failure is fixed.
  }
}

/**
 * Bounds one fallback containment step after the primary result is fixed.
 *
 * @param operation - Already-started kill acceptance or exit settlement.
 */
async function settleProcessCliContainmentStep(
  operation: Promise<unknown>,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolveDeadline) => {
    timeout = setTimeout(
      resolveDeadline,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
    )
  })
  try {
    await Promise.race([
      operation.then((): void => {}, (): void => {}),
      deadline,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/** Copies explicitly bounded evidence bytes before the first filesystem await. */
function copyEvidenceBytes(
  bytes: Uint8Array,
  maximumBytes: number,
): Uint8Array {
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    bytes.byteLength > maximumBytes
  ) {
    throw outputBoundaryFailed()
  }
  let copy: unknown
  try {
    copy = Reflect.apply(Uint8Array.prototype.slice, bytes, [])
  } catch {
    throw outputBoundaryFailed()
  }
  if (!(copy instanceof Uint8Array)) throw outputBoundaryFailed()
  return copy
}

/** Copies one bounded fault plan into a detached non-shared snapshot. */
function copyFaultPlanBytes(bytes: Uint8Array): Uint8Array {
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_FAULT_PLAN_MAX_BYTES
  ) {
    throw invalidFaultPlan()
  }
  let copy: unknown
  try {
    copy = Reflect.apply(Uint8Array.prototype.slice, bytes, [])
  } catch {
    throw invalidFaultPlan()
  }
  if (
    !(copy instanceof Uint8Array) ||
    copy.byteLength !== bytes.byteLength
  ) {
    throw invalidFaultPlan()
  }
  return copy
}

/** Compares two public non-secret byte vectors exactly. */
function equalProcessCliBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Durably syncs one directory and closes its handle on every path. */
async function syncProcessCliDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      path,
      fileSystemConstants.O_RDONLY |
        fileSystemConstants.O_DIRECTORY |
        fileSystemConstants.O_NOFOLLOW,
    )
  } catch {
    throw outputBoundaryFailed()
  }
  let failed = false
  try {
    await handle.sync()
  } catch {
    failed = true
  }
  try {
    await handle.close()
  } catch {
    failed = true
  }
  if (failed) throw outputBoundaryFailed()
}

/** Detects only the stable exclusive-create collision code. */
function isProcessCliFileExistsError(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) {
    return false
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor?.value === 'EEXIST'
}

/** Detects one exact ordinary filesystem error code without invoking traps. */
function isProcessCliFileSystemErrorCode(
  error: unknown,
  expectedCode: string,
): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) return false
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor?.value === expectedCode
}

/** Classifies arbitrary failures without inspecting their messages or causes. */
function classifyProcessCliFailure(
  error: unknown,
  interruptedSignal: WorkspaceSearchMigrationRehearsalParentSignal | undefined,
): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  if (interruptedSignal !== undefined) return interrupted(interruptedSignal)
  if (error instanceof WorkspaceSearchMigrationRehearsalProcessCliFailure) {
    return error
  }
  if (error instanceof WorkspaceSearchMigrationRehearsalProcessRunnerError) {
    if (error.code === 'FAULT_RECEIPT_PERSIST_FAILED') {
      return faultReceiptWriteFailed()
    }
    return processFailed()
  }
  return operationFailed()
}

/** Emits one stable canonical failure line and drops writer failures. */
function writeProcessCliFailureLine(
  writeStderrLine: (serializedLine: string) => void,
  code: WorkspaceSearchMigrationRehearsalProcessCliFailureCode,
): void {
  try {
    writeStderrLine(serializeCanonicalJson({
      code,
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
      status: 'error',
    }))
  } catch {
    // Raw output-writer failures never replace the stable exit code.
  }
}

/** Creates one exact strict-command usage failure. */
function invalidProcessCliUsage(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Creates one exact canonical-plan input failure. */
function invalidFaultPlan(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'INVALID_FAULT_PLAN',
    2,
  )
}

/** Creates one exact exclusive-directory collision failure. */
function evidenceDirectoryExists(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'EVIDENCE_DIRECTORY_EXISTS',
    1,
  )
}

/** Creates one exact evidence-directory durability failure. */
function evidenceDirectoryCreateFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'EVIDENCE_DIRECTORY_CREATE_FAILED',
    1,
  )
}

/** Creates one exact receipt-evidence durability failure. */
function faultReceiptWriteFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'FAULT_RECEIPT_WRITE_FAILED',
    1,
  )
}

/** Creates one exact authenticated fault-material persistence failure. */
function faultMaterialWriteFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'FAULT_MATERIAL_WRITE_FAILED',
    1,
  )
}

/** Creates one exact no-fault receipt persistence failure. */
function noFaultReceiptWriteFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'NO_FAULT_RECEIPT_WRITE_FAILED',
    1,
  )
}

/** Creates one exact authenticated stage-selection input failure. */
function invalidProcessCliStageSelection(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'INVALID_STAGE_SELECTION',
    2,
  )
}

/** Creates one exact authenticated child-material persistence failure. */
function successMaterialWriteFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'SUCCESS_MATERIAL_WRITE_FAILED',
    1,
  )
}

/** Creates one exact lifecycle-evidence durability failure. */
function lifecycleWriteFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'LIFECYCLE_WRITE_FAILED',
    1,
  )
}

/** Creates one exact parent-authentication durability failure. */
function parentAuthenticationWriteFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'PARENT_AUTHENTICATION_WRITE_FAILED',
    1,
  )
}

/** Creates one exact fixed-child spawn failure. */
function spawnFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'SPAWN_FAILED',
    1,
  )
}

/** Creates one exact runner protocol failure. */
function processFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'PROCESS_FAILED',
    1,
  )
}

/** Creates one exact parent interruption failure and conventional status. */
function interrupted(
  signal: WorkspaceSearchMigrationRehearsalParentSignal,
): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'INTERRUPTED',
    signal === 'SIGINT' ? 130 : 143,
  )
}

/** Creates one exact unexpected operation failure. */
function operationFailed(): WorkspaceSearchMigrationRehearsalProcessCliFailure {
  return new WorkspaceSearchMigrationRehearsalProcessCliFailure(
    'OPERATION_FAILED',
    1,
  )
}

/** Creates one fixed private filesystem-boundary failure. */
function outputBoundaryFailed(): Error {
  return new Error('OUTPUT_BOUNDARY_FAILED')
}

if (import.meta.main) {
  void runWorkspaceSearchMigrationRehearsalProcessCli(
    Bun.argv.slice(2),
    defaultProcessCliDependencies,
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
