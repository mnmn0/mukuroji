import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
} from './migration-describe-table-rate-policy'
import type {
  WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'
import {
  commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  validateWorkspaceSearchMigrationRequestedResources,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  verifyWorkspaceSearchMigrationRehearsalPermit,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  type WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  type WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead,
} from './migration-rehearsal-stage-commit-evidence'
import {
  createWorkspaceSearchMigrationRehearsalStageCommitIntent,
  parseWorkspaceSearchMigrationRehearsalStageCommitIntentDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION,
  type WorkspaceSearchMigrationRehearsalStageCommitGate,
  type WorkspaceSearchMigrationRehearsalStageCommitIntent,
} from './migration-rehearsal-stage-commit-intent'
import {
  verifyWorkspaceSearchMigrationRehearsalStageChildMaterial,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
import {
  verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES,
} from './migration-rehearsal-stage-fault-material'
import {
  snapshotWorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultPlan,
} from './migration-rehearsal-faults'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
  WorkspaceSearchMigrationRehearsalPrivateInputError,
} from './migration-rehearsal-private-input'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
} from './migration-rehearsal-rate-evidence'
import {
  finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence,
  readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding,
  snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence,
  type WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
} from './migration-rehearsal-reconciliation-audit'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint,
  readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  parseWorkspaceSearchMigrationRehearsalStageManifestDocument,
  parseWorkspaceSearchMigrationRehearsalStageReceiptDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  verifyWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
  WorkspaceSearchMigrationRehearsalStageReservationCommitResult,
} from './migration-rehearsal-stage-reservation-aws'
import {
  createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest,
} from './migration-rehearsal-stage-reservation-aws'
import {
  authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization,
  readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  type WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput,
  type WorkspaceSearchMigrationRehearsalStageParentAuthorization,
  type WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
} from './migration-rehearsal-stage-finalizer'
import {
  writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_LIFECYCLE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome,
} from './migration-rehearsal-stage-finalizer-cli'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence,
  readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
  type WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
} from './migration-rehearsal-target-audit'

/** Stable discriminator for secret-free stage-commit CLI result lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-commit-result'

/** Maximum exact canonical bytes accepted for one authenticated permit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_PERMIT_MAX_BYTES =
  64 * 1_024

/** Maximum exact canonical bytes accepted for one reviewed fault plan. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_FAULT_PLAN_MAX_BYTES =
  64 * 1_024

/** Maximum canonical bytes accepted for abandonment artifact pairs. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_ABANDONMENTS_MAX_BYTES =
  2 * 1_024 * 1_024

/** Exact raw key length required by permit and stage authentication. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_KEY_BYTES = 32

/** Conditional private inputs required to verify stopped fault material. */
export type WorkspaceSearchMigrationRehearsalStageCommitBoundaryInputs = {
  /** Exact private reviewed canonical fault-plan path. */
  readonly faultPlanFile: string
  /** Exact private durable boundary rate-segment path. */
  readonly boundaryRateSegmentFile: string
}

/** Additional private inputs required for response-loss completion material. */
export type WorkspaceSearchMigrationRehearsalStageCommitCompletionInputs =
  WorkspaceSearchMigrationRehearsalStageCommitBoundaryInputs & {
    /** Exact private persisted fault-boundary material wrapper path. */
    readonly boundaryMaterialFile: string
    /** Exact private durable final rate-segment path. */
    readonly finalRateSegmentFile: string
  }

/** Strictly parsed explicit standalone stage-commit command. */
export type WorkspaceSearchMigrationRehearsalStageCommitCliArguments = {
  /** Complete explicit validated physical resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Exact private canonical reviewed rate-policy path. */
  readonly ratePolicyFile: string
  /** Exact private canonical authenticated permit path. */
  readonly permitFile: string
  /** Exact private operator master key used for local purpose derivation. */
  readonly rehearsalAuthenticationKeyFile: string
  /** Exact private canonical authenticated stage-manifest path. */
  readonly stageManifestFile: string
  /** Exact private predecessor receipt path, absent only for stage one. */
  readonly previousReceiptFile?: string
  /** Exact private persisted stage-material wrapper path. */
  readonly materialFile: string
  /** Exact parent-persisted process lifecycle wrapper path. */
  readonly lifecycleEvidenceFile: string
  /** Exact parent-only authentication record path. */
  readonly parentAuthenticationFile: string
  /** Exact private canonical authenticated stage-receipt path. */
  readonly stageReceiptFile: string
  /** Owner-only directory containing durable runtime-key cleanup artifacts. */
  readonly runtimeKeyEvidenceDirectory: string
  /** Raw rollback-preimage audit required only for rollback planning commit. */
  readonly targetPreimageAuditFile?: string
  /** Raw reconciliation audit required only for terminal-stage commit. */
  readonly terminalReconciliationAuditFile?: string
  /** Ordered abandonment pairs since the predecessor commit, when required. */
  readonly reservationAbandonmentsFile?: string
  /** New private authenticated commit-evidence output path. */
  readonly outputFile: string
  /** Deterministic same-directory pre-transaction commit-intent path. */
  readonly intentFile: string
  /** Optional fault-boundary verification inputs. */
  readonly faultInputs?:
    | WorkspaceSearchMigrationRehearsalStageCommitBoundaryInputs
    | WorkspaceSearchMigrationRehearsalStageCommitCompletionInputs
}

/** Callable standalone commit boundary injected into CLI tests. */
export type WorkspaceSearchMigrationRehearsalStageCommitCliCommit = (
  input: Parameters<
    typeof commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation
  >[0],
) => Promise<WorkspaceSearchMigrationRehearsalStageReservationCommitResult>

/** Injectable finite I/O, clock, and AWS boundary for the commit CLI. */
export type WorkspaceSearchMigrationRehearsalStageCommitCliDependencies = {
  /** Reads one stable owner-only single-link private file. */
  readonly readPrivateInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Runs the capability-minimized authenticated standalone AWS commit. */
  readonly commitStageReservation:
    WorkspaceSearchMigrationRehearsalStageCommitCliCommit
  /** Returns the trusted live wall clock sampled by permit and commit guards. */
  readonly now: () => Date
  /** Rejects a currently existing final output before irreversible AWS I/O. */
  readonly ensureEvidenceOutputAbsent: (outputPath: string) => Promise<void>
  /** Reads an optional stable owner-only pre-transaction intent. */
  readonly readEvidenceIntentFile: (
    intentPath: string,
  ) => Promise<Uint8Array | undefined>
  /** Durably publishes canonical evidence without replacing an existing path. */
  readonly writeEvidenceFileExclusive: (
    outputPath: string,
    evidenceBytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome>
  /** Atomically promotes the fsynced intent inode to the final output path. */
  readonly promoteEvidenceIntentExclusive: (
    intentPath: string,
    outputPath: string,
    evidenceBytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome>
  /** Emits one already canonical secret-free success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Emits one already canonical raw-value-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable process statuses returned by the standalone commit CLI. */
export type WorkspaceSearchMigrationRehearsalStageCommitCliExitCode =
  | 0
  | 1
  | 2

/** Stable raw-value-free standalone commit failure classes. */
export type WorkspaceSearchMigrationRehearsalStageCommitCliFailureCode =
  | 'AUTHENTICATION_FAILED'
  | 'COMMIT_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INVALID_USAGE'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'

/** Private classified failure carrying no argument or artifact value. */
class WorkspaceSearchMigrationRehearsalStageCommitCliFailure extends Error {
  /** Stable machine-readable failure classification. */
  readonly code:
    WorkspaceSearchMigrationRehearsalStageCommitCliFailureCode

  /** Exact process status paired with the classification. */
  readonly exitCode:
    WorkspaceSearchMigrationRehearsalStageCommitCliExitCode

  /**
   * Creates one raw-value-free CLI failure.
   *
   * @param code - Stable failure classification.
   * @param exitCode - Exact process status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalStageCommitCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalStageCommitCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalStageCommitCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Untrusted optional fault paths before authenticated shape selection. */
type StageCommitOptionalFaultPaths = {
  /** Optional reviewed fault-plan path. */
  readonly faultPlanFile?: string
  /** Optional boundary rate-segment path. */
  readonly boundaryRateSegmentFile?: string
  /** Optional persisted boundary-material wrapper path. */
  readonly boundaryMaterialFile?: string
  /** Optional final rate-segment path. */
  readonly finalRateSegmentFile?: string
}

/** Authenticated material context required by the standalone commit. */
type AuthenticatedStageCommitMaterial = {
  /** Independently authenticated exact reservation. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Exact active durable head authenticated by the material verifier. */
  readonly claimedStageHead: WorkspaceSearchMigrationRehearsalStageHead
  /** Exact authenticated lease observation used by the stage mutation. */
  readonly leaseObservation:
    WorkspaceSearchMigrationRehearsalStageReceipt['leaseObservation']
  /** Digest of the current lease identity represented by the observation. */
  readonly leaseIdentityDigest: string
  /** Exact persisted material inputs reverified by parent authorization. */
  readonly authorizationInput:
    WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput
}

/** Durable prepared intent reused across every crash-safe retry. */
type StageCommitPreparedIntent = {
  /** Exact authenticated local prepared intent. */
  readonly intent: WorkspaceSearchMigrationRehearsalStageCommitIntent
  /** Exact canonical prepared-intent bytes fsynced before AWS I/O. */
  readonly intentBytes: Uint8Array
}

/** Command-specific one-shot authorization created from exact raw evidence. */
type StageCommitGateAuthorization =
  | WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence
  | WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence
  | null

/** Full special-cap binding used to derive the compact signed intent gate. */
type StageCommitGateAuthorizationBinding =
  | WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding
  | WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding
  | null

/** Fresh special gate plus its exact compact journal projection. */
type PreparedStageCommitGate = {
  /** Opaque one-shot authorization passed unchanged into the commit adapter. */
  readonly authorization: StageCommitGateAuthorization
  /** Compact secret-free gate authenticated by intent and durable evidence. */
  readonly gate: WorkspaceSearchMigrationRehearsalStageCommitGate
  /** Full binding retained only for local exact validation. */
  readonly binding: StageCommitGateAuthorizationBinding
}

/** Authenticated inputs used to remint one command-specific commit gate. */
type PrepareStageCommitGateInput = {
  /** Strict parsed command paths including optional raw audit files. */
  readonly configuration:
    WorkspaceSearchMigrationRehearsalStageCommitCliArguments
  /** Exact independently authenticated manifest selection. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Exact active reservation bounding every gate timestamp. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Exact authenticated receipt awaiting commit. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Child-visible exact runtime verification key. */
  readonly runtimeKey: Uint8Array
  /** Parent-only exact publication verification key. */
  readonly publicationKey: Uint8Array
  /** Existing durable intent whose target gate time must be reused. */
  readonly existingIntent?: StageCommitPreparedIntent
  /** Trusted monotonic wall clock bounded by the receipt lifecycle. */
  readonly clock: RecordingStageCommitClock
  /** Captured private-input filesystem boundary. */
  readonly dependencies: WorkspaceSearchMigrationRehearsalStageCommitCliDependencies
  /** Owned private byte vectors overwritten on every result. */
  readonly ownedBuffers: Uint8Array[]
}

/** Inputs required to recover or durably create one commit intent. */
type ReadOrCreateStageCommitEvidenceIntentInput = {
  /** Deterministic same-directory owner-only intent path. */
  readonly intentPath: string
  /** Authenticated exact receipt awaiting durable commit. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Authenticated exact reservation consumed by the receipt. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Authenticated short-lived permit claims owning this commit admission. */
  readonly permitClaims: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>
  /** Digest binding the exact physical migration-state location. */
  readonly stateTableLocationBindingDigest: string
  /** Parent-only key authorizing the pre-transaction durable intent bytes. */
  readonly publicationKey: Uint8Array
  /** Secret-free binding proven by the genuine parent capability. */
  readonly parentAuthorizationBinding:
    WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding
  /** Exact command-specific compact gate derived from a fresh capability. */
  readonly commitGate: WorkspaceSearchMigrationRehearsalStageCommitGate
  /** Already authenticated intent and bytes recovered before cap finalization. */
  readonly existingIntent?: StageCommitPreparedIntent
  /** Monotonic trusted clock whose floor is the terminal child lifecycle. */
  readonly clock: RecordingStageCommitClock
  /** Captured finite filesystem dependencies. */
  readonly dependencies: WorkspaceSearchMigrationRehearsalStageCommitCliDependencies
  /** Owned buffers zeroized when the CLI returns. */
  readonly ownedBuffers: Uint8Array[]
}

/** Strict parent-persisted wrapper detached before material verification. */
type PersistedStageMaterialWrapper = {
  /** Exact supported persisted wrapper discriminator. */
  readonly kind:
    | 'mukuroji-workspace-search-migration-rehearsal-child-material-evidence'
    | 'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence'
    | 'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence'
  /** Exact untrusted nested material candidate. */
  readonly material: unknown
  /** Claimed canonical digest of the nested authenticated material. */
  readonly materialDigest: string
  /** Canonical parent observation time for the complete material line. */
  readonly observedAt: string
}

/** Live clock that exposes only its last successfully sampled timestamp. */
type RecordingStageCommitClock = {
  /** Live Date-producing function supplied to all permit checks. */
  readonly clock: () => Date
  /** Sets the latest authenticated receipt time as an exclusive lower bound. */
  readonly setExclusiveFloor: (floor: string) => void
  /** Clears earlier local permit samples before factory construction. */
  readonly resetObservedAt: () => void
}

/** Maximum accepted local CLI argument count. */
const maximumStageCommitCliArgumentCount = 64

/** Maximum accepted local path or scalar argument length. */
const maximumStageCommitCliArgumentLength = 4_096

/** Every exact flag accepted by the standalone CLI parser. */
const stageCommitCliFlagNames = new Set<string>([
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
  '--rate-policy-file',
  '--permit-file',
  '--rehearsal-authentication-key-file',
  '--stage-manifest-file',
  '--previous-receipt-file',
  '--material-file',
  '--lifecycle-evidence-file',
  '--parent-authentication-file',
  '--stage-receipt-file',
  '--runtime-key-evidence-directory',
  '--target-preimage-audit-file',
  '--terminal-reconciliation-audit-file',
  '--reservation-abandonments-file',
  '--fault-plan-file',
  '--boundary-rate-segment-file',
  '--boundary-material-file',
  '--final-rate-segment-file',
  '--output-file',
])

/** Strict wrapper guards mapped to the CLI authentication failure. */
const stageCommitCliGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  authenticationFailed,
)

/** Exact persisted wrapper fields shared by all three material protocols. */
const persistedMaterialWrapperKeys = Object.freeze([
  'evidenceVersion',
  'kind',
  'material',
  'materialDigest',
  'observedAt',
])

/** Default production dependencies for the standalone commit executable. */
const defaultStageCommitCliDependencies:
  WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
    Object.freeze({
      readPrivateInputFile:
        readWorkspaceSearchMigrationRehearsalPrivateInputFile,
      commitStageReservation:
        commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation,
      now: (): Date => new Date(),
      ensureEvidenceOutputAbsent: ensureStageCommitEvidenceOutputAbsent,
      readEvidenceIntentFile: readStageCommitEvidenceIntentFile,
      writeEvidenceFileExclusive:
        writeStageCommitEvidenceFileExclusive,
      promoteEvidenceIntentExclusive:
        promoteStageCommitEvidenceIntentExclusive,
      writeStdoutLine: (line: string): void => {
        console.log(line)
      },
      writeStderrLine: (line: string): void => {
        console.error(line)
      },
    })

/**
 * Parses unique explicit resources and private artifact paths.
 *
 * Fault-specific paths remain optional until the authenticated manifest entry
 * determines the exact material protocol. Every supplied path is normalized
 * and must be distinct from every other input and the output.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Frozen explicit resources and private file selection.
 */
export function parseWorkspaceSearchMigrationRehearsalStageCommitCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalStageCommitCliArguments {
  const flags = parseStageCommitCliFlagPairs(
    snapshotStageCommitCliArguments(arguments_),
  )
  const resources: WorkspaceSearchMigrationRequestedResources = {
    account: requireStageCommitCliFlag(flags, '--account'),
    region: requireStageCommitCliFlag(flags, '--region'),
    profile: requireStageCommitCliFlag(flags, '--profile'),
    commit: requireStageCommitCliFlag(flags, '--commit'),
    tables: {
      'project-directory': requireStageCommitCliFlag(
        flags,
        '--project-directory-table',
      ),
      'work-items': requireStageCommitCliFlag(flags, '--work-items-table'),
      collaboration: requireStageCommitCliFlag(
        flags,
        '--collaboration-table',
      ),
      documents: requireStageCommitCliFlag(flags, '--documents-table'),
      'workspace-search': requireStageCommitCliFlag(
        flags,
        '--workspace-search-table',
      ),
      'migration-state': requireStageCommitCliFlag(
        flags,
        '--migration-state-table',
      ),
    },
    journalBucket: requireStageCommitCliFlag(flags, '--journal-bucket'),
    journalKeyArn: requireStageCommitCliFlag(flags, '--journal-key-arn'),
  }
  try {
    validateWorkspaceSearchMigrationRequestedResources(resources)
  } catch {
    throw invalidUsage()
  }
  const optionalFaultPaths: StageCommitOptionalFaultPaths = Object.freeze({
    ...readOptionalStageCommitCliPath(
      flags,
      '--fault-plan-file',
      'faultPlanFile',
    ),
    ...readOptionalStageCommitCliPath(
      flags,
      '--boundary-rate-segment-file',
      'boundaryRateSegmentFile',
    ),
    ...readOptionalStageCommitCliPath(
      flags,
      '--boundary-material-file',
      'boundaryMaterialFile',
    ),
    ...readOptionalStageCommitCliPath(
      flags,
      '--final-rate-segment-file',
      'finalRateSegmentFile',
    ),
  })
  const previousReceiptFile = readOptionalResolvedStageCommitCliPath(
    flags,
    '--previous-receipt-file',
  )
  const reservationAbandonmentsFile =
    readOptionalResolvedStageCommitCliPath(
      flags,
      '--reservation-abandonments-file',
    )
  const targetPreimageAuditFile = readOptionalResolvedStageCommitCliPath(
    flags,
    '--target-preimage-audit-file',
  )
  const terminalReconciliationAuditFile =
    readOptionalResolvedStageCommitCliPath(
      flags,
      '--terminal-reconciliation-audit-file',
    )
  const outputFile = requireResolvedStageCommitCliPath(
    flags,
    '--output-file',
  )
  const intentFile = resolveStageCommitCliPath(`${outputFile}.intent`)
  const configuration:
    WorkspaceSearchMigrationRehearsalStageCommitCliArguments =
      Object.freeze({
        resources: Object.freeze({
          ...resources,
          tables: Object.freeze({ ...resources.tables }),
        }),
        ratePolicyFile: requireResolvedStageCommitCliPath(
          flags,
          '--rate-policy-file',
        ),
        permitFile: requireResolvedStageCommitCliPath(
          flags,
          '--permit-file',
        ),
        rehearsalAuthenticationKeyFile: requireResolvedStageCommitCliPath(
          flags,
          '--rehearsal-authentication-key-file',
        ),
        stageManifestFile: requireResolvedStageCommitCliPath(
          flags,
          '--stage-manifest-file',
        ),
        ...(previousReceiptFile === undefined
          ? {}
          : { previousReceiptFile }),
        materialFile: requireResolvedStageCommitCliPath(
          flags,
          '--material-file',
        ),
        lifecycleEvidenceFile: requireResolvedStageCommitCliPath(
          flags,
          '--lifecycle-evidence-file',
        ),
        parentAuthenticationFile: requireResolvedStageCommitCliPath(
          flags,
          '--parent-authentication-file',
        ),
        stageReceiptFile: requireResolvedStageCommitCliPath(
          flags,
          '--stage-receipt-file',
        ),
        runtimeKeyEvidenceDirectory: requireResolvedStageCommitCliPath(
          flags,
          '--runtime-key-evidence-directory',
        ),
        ...(targetPreimageAuditFile === undefined
          ? {}
          : { targetPreimageAuditFile }),
        ...(terminalReconciliationAuditFile === undefined
          ? {}
          : { terminalReconciliationAuditFile }),
        ...(reservationAbandonmentsFile === undefined
          ? {}
          : { reservationAbandonmentsFile }),
        outputFile,
        intentFile,
        ...createStageCommitFaultInputs(optionalFaultPaths),
      })
  requireDistinctStageCommitCliPaths(configuration)
  return configuration
}

/**
 * Runs one authenticated capability-minimized non-production stage commit.
 *
 * All inputs are private single-link mode-0600 files. Manifest selection,
 * material, reservation, receipt, permit, resources, and policy are verified
 * independently before AWS I/O. Every owned key and input buffer is
 * overwritten on success and failure. A local durability failure after a
 * confirmed remote commit is reported as `OUTPUT_FILE_WRITE_FAILED` without
 * replaying or reclassifying the normal compare-and-set result.
 *
 * @param arguments_ - Exact explicit operator command.
 * @param dependencies - Injectable finite I/O, clock, and commit boundary.
 * @returns Stable process status.
 */
export async function runWorkspaceSearchMigrationRehearsalStageCommitCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalStageCommitCliDependencies =
      defaultStageCommitCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalStageCommitCliExitCode> {
  let writeStdoutLine = defaultStageCommitCliDependencies.writeStdoutLine
  let writeStderrLine = defaultStageCommitCliDependencies.writeStderrLine
  const ownedBuffers: Uint8Array[] = []
  try {
    const captured = snapshotStageCommitCliDependencies(dependencies)
    writeStdoutLine = captured.writeStdoutLine
    writeStderrLine = captured.writeStderrLine
    const configuration =
      parseWorkspaceSearchMigrationRehearsalStageCommitCliArguments(
        arguments_,
      )
    const ratePolicyBytes = await readStageCommitCliPrivateBytes(
      configuration.ratePolicyFile,
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
      captured,
      ownedBuffers,
    )
    const ratePolicy = readStageCommitRatePolicy(ratePolicyBytes)
    const permitBytes = await readStageCommitCliPrivateBytes(
      configuration.permitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_PERMIT_MAX_BYTES,
      captured,
      ownedBuffers,
    )
    const permit = parseCanonicalStageCommitJson(permitBytes)
    const masterKey = await readStageCommitCliKey(
      configuration.rehearsalAuthenticationKeyFile,
      captured,
      ownedBuffers,
    )
    let runtimeKey: Uint8Array
    let publicationKey: Uint8Array
    try {
      const derived = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
      runtimeKey = derived.runtimeKey
      publicationKey = derived.publicationKey
      ownedBuffers.push(runtimeKey, publicationKey)
    } catch {
      throw authenticationFailed()
    } finally {
      zeroizeWorkspaceSearchMigrationRehearsalKey(masterKey)
    }
    const clock = createRecordingStageCommitClock(captured.now)
    const requestedResourcesBinding =
      createWorkspaceSearchMigrationRequestedResourcesBinding(
        configuration.resources,
      )
    const permitClaims = authenticateStageCommitPermit({
      permit,
      permitKey: runtimeKey,
      resources: configuration.resources,
      requestedResourcesBinding,
      currentTime: clock.clock(),
    })
    const manifestBytes = await readStageCommitCliPrivateBytes(
      configuration.stageManifestFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
      captured,
      ownedBuffers,
    )
    const manifest = parseStageCommitManifest(manifestBytes, runtimeKey)
    const receiptBytes = await readStageCommitCliPrivateBytes(
      configuration.stageReceiptFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
      captured,
      ownedBuffers,
    )
    const receipt = parseStageCommitReceipt(receiptBytes, runtimeKey)
    const previousReceipt = await readStageCommitPreviousReceipt(
      configuration,
      receipt,
      runtimeKey,
      captured,
      ownedBuffers,
    )
    const selection = deriveAuthenticatedStageCommitSelection(
      manifest,
      previousReceipt,
      receipt.stageOrdinal,
    )
    requireStageCommitTopLevelBindings({
      manifest,
      receipt,
      permit,
      permitClaims,
      stageKey: runtimeKey,
      publicationKey,
      requestedResourcesBinding,
      ratePolicy,
    })
    const material = await authenticateStageCommitMaterial(
      configuration,
      selection,
      runtimeKey,
      captured,
      ownedBuffers,
    )
    const reservation =
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: material.reservation,
        selection,
        verificationKey: runtimeKey,
      })
    requireStageCommitReceiptMatchesMaterial(
      receipt,
      reservation,
      material,
      selection,
    )
    const parentAuthorization = await authenticateStageCommitParentAuthorization(
      configuration,
      selection,
      material.authorizationInput,
      runtimeKey,
      publicationKey,
      captured,
      ownedBuffers,
    )
    const parentAuthorizationBinding =
      readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding(
        parentAuthorization,
      )
    const reservationAbandonments =
      await readStageCommitReservationAbandonments(
        configuration,
        previousReceipt,
        receipt,
        captured,
        ownedBuffers,
      )
    clock.setExclusiveFloor(readStageCommitReceiptCommitFloor(receipt))
    clock.resetObservedAt()
    const stateTableLocationBindingDigest =
      createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
        stateTableName:
          configuration.resources.tables['migration-state'],
        requestedResourcesBinding,
      })
    const existingIntent = await readExistingStageCommitEvidenceIntent(
      configuration.intentFile,
      publicationKey,
      captured,
      ownedBuffers,
    )
    let runtimeKeyCleanupAuthorization:
      WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization
    try {
      runtimeKeyCleanupAuthorization =
        await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
          evidenceDirectory: configuration.runtimeKeyEvidenceDirectory,
          reservation,
          selection,
          expectedRuntimeKey: new Uint8Array(runtimeKey),
          publicationAuthenticationKey: new Uint8Array(publicationKey),
          now: clock.clock,
        })
    } catch {
      throw authenticationFailed()
    }
    let runtimeKeyCleanupBinding:
      WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding
    try {
      runtimeKeyCleanupBinding =
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          runtimeKeyCleanupAuthorization,
        )
    } catch {
      throw authenticationFailed()
    }
    requireStageCommitCleanupBinding(
      runtimeKeyCleanupBinding,
      parentAuthorizationBinding,
      reservation,
      runtimeKey,
    )
    const commitGate = await prepareStageCommitGate({
      configuration,
      selection,
      reservation,
      receipt,
      runtimeKey,
      publicationKey,
      existingIntent,
      clock,
      dependencies: captured,
      ownedBuffers,
    })
    const intent = await readOrCreateStageCommitEvidenceIntent({
      intentPath: configuration.intentFile,
      receipt,
      reservation,
      permitClaims,
      stateTableLocationBindingDigest,
      publicationKey,
      parentAuthorizationBinding,
      commitGate: commitGate.gate,
      ...(existingIntent === undefined ? {} : { existingIntent }),
      clock,
      dependencies: captured,
      ownedBuffers,
    })
    let result: WorkspaceSearchMigrationRehearsalStageReservationCommitResult
    try {
      result = await captured.commitStageReservation({
        requested: configuration.resources,
        ratePolicy,
        permit,
        permitVerificationKey: runtimeKey,
        permitClock: clock.clock,
        stageReservationCommit: {
          selection,
          reservation,
          receipt,
          previousReceipt,
          reservationAbandonments,
          parentAuthorization,
          commitIntent: intent.intent,
          runtimeKeyCleanupAuthorization,
          commitGateAuthorization: commitGate.authorization,
          runtimeKey,
          publicationKey,
        },
      })
    } catch {
      throw commitFailed()
    }
    const committedHead = readExactCommittedStageHead(
      result.head,
      receipt,
    )
    if (
      !isCommittedStageEvidenceDerivedFromPreparedIntent(
        result.commitEvidence,
        intent.intent,
        reservation.expiresAt,
      ) ||
      serializeCanonicalJson(committedHead) !==
        serializeCanonicalJson(result.commitEvidence.head)
    ) throw commitFailed()
    const observedAt = clock.clock().toISOString()
    const committedEvidenceBytes = new TextEncoder().encode(
      serializeCanonicalJson(result.commitEvidence),
    )
    ownedBuffers.push(committedEvidenceBytes)
    let writeOutcome: WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome
    try {
      writeOutcome = await captured.writeEvidenceFileExclusive(
        configuration.outputFile,
        committedEvidenceBytes,
      )
    } catch {
      throw outputWriteFailed()
    }
    if (writeOutcome === 'exists') throw outputExists()
    if (writeOutcome !== 'created' && writeOutcome !== 'reconciled') {
      throw outputWriteFailed()
    }
    writeStdoutLine(serializeCanonicalJson({
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CLI_RESULT_KIND,
      status: 'succeeded',
      stageOrdinal: result.commitEvidence.stageOrdinal,
      evidenceDigest: createMigrationDigest(result.commitEvidence),
      durableStatus: result.commitEvidence.durableStatus,
      transportObservation: result.transportObservation,
      observedAt,
    }))
    return 0
  } catch (error: unknown) {
    const failure = classifyStageCommitCliFailure(error)
    writeStageCommitCliFailureLine(writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    for (const buffer of ownedBuffers) zeroizeStageCommitCliBytes(buffer)
  }
}

/**
 * Reads and authenticates a durable retry intent before reminting audit caps.
 *
 * @param intentPath - Deterministic owner-only prepared-intent path.
 * @param publicationKey - Parent-only key authenticating an existing intent.
 * @param dependencies - Captured optional-intent filesystem boundary.
 * @param ownedBuffers - Owned buffers zeroized after the CLI completes.
 * @returns Authenticated existing intent or undefined for a first attempt.
 */
async function readExistingStageCommitEvidenceIntent(
  intentPath: string,
  publicationKey: Uint8Array,
  dependencies: WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
  ownedBuffers: Uint8Array[],
): Promise<StageCommitPreparedIntent | undefined> {
  let existingBytes: Uint8Array | undefined
  try {
    existingBytes = await dependencies.readEvidenceIntentFile(intentPath)
  } catch {
    throw outputWriteFailed()
  }
  if (existingBytes === undefined) return undefined
  const copied = copyStageCommitIntentBytes(existingBytes)
  ownedBuffers.push(existingBytes, copied)
  zeroizeStageCommitCliBytes(existingBytes)
  const intent = parseStageCommitPreparedIntent(copied, publicationKey)
  return Object.freeze({ intent, intentBytes: copied })
}

/**
 * Requires a reminted cleanup capability to equal the persisted parent facts.
 *
 * @param binding - Full genuine cleanup authorization binding.
 * @param parentAuthorization - Parent-authenticated persisted cleanup facts.
 * @param reservation - Exact active reservation whose key was erased.
 * @param runtimeKey - Exact runtime key used to authenticate the reservation.
 */
function requireStageCommitCleanupBinding(
  binding:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  parentAuthorization:
    WorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  runtimeKey: Uint8Array,
): void {
  const expected = parentAuthorization.runtimeKeyCleanupAuthorization
  if (
    binding.reservationDigest !== createMigrationDigest(reservation) ||
    binding.manifestDigest !== reservation.manifestDigest ||
    binding.permitDigest !== reservation.permitDigest ||
    binding.requestedResourcesBinding !==
      reservation.requestedResourcesBinding ||
    binding.stageOrdinal !== reservation.stageOrdinal ||
    binding.parentLivenessProtocol !== reservation.parentLivenessProtocol ||
    binding.runtimeKeyFingerprint !==
      createWorkspaceSearchMigrationRehearsalRuntimeKeyFingerprint(
        runtimeKey,
      ) ||
    binding.reservationDigest !== expected.reservationDigest ||
    binding.manifestDigest !== expected.manifestDigest ||
    binding.permitDigest !== expected.permitDigest ||
    binding.requestedResourcesBinding !==
      expected.requestedResourcesBinding ||
    binding.stageOrdinal !== expected.stageOrdinal ||
    binding.parentLivenessProtocol !== expected.parentLivenessProtocol ||
    binding.runtimeKeyFingerprint !== expected.runtimeKeyFingerprint ||
    binding.runtimeFileIdentityDigest !==
      expected.runtimeFileIdentityDigest ||
    binding.cleanupIntentDigest !== expected.cleanupIntentDigest ||
    binding.cleanupCompletionDigest !== expected.cleanupCompletionDigest ||
    binding.preparedAt !== expected.preparedAt ||
    binding.completedAt !== expected.completedAt ||
    createMigrationDigest(binding) !== expected.authorizationBindingDigest ||
    Date.parse(binding.preparedAt) > Date.parse(binding.completedAt) ||
    Date.parse(binding.completedAt) >= Date.parse(reservation.expiresAt)
  ) throw authenticationFailed()
}

/**
 * Remints the sole command-specific audit capability required by this stage.
 *
 * @param input - Authenticated receipt, raw paths, keys, and retry intent.
 * @returns Fresh opaque cap plus its exact compact intent projection.
 */
async function prepareStageCommitGate(
  input: PrepareStageCommitGateInput,
): Promise<PreparedStageCommitGate> {
  const rollbackPlanning =
    input.selection.entry.command === 'close-replan' &&
    input.receipt.evidence.kind === 'planning-sealed' &&
    (input.selection.entry.scenario === 'complete-apply-rollback' ||
      input.selection.entry.scenario === 'partial-apply-rollback')
  if (rollbackPlanning) return await prepareTargetPreimageCommitGate(input)
  if (input.receipt.evidence.kind === 'terminal') {
    return await prepareTerminalReconciliationCommitGate(input)
  }
  if (
    input.configuration.targetPreimageAuditFile !== undefined ||
    input.configuration.terminalReconciliationAuditFile !== undefined ||
    (input.existingIntent !== undefined &&
      input.existingIntent.intent.commitGate.kind !== 'none')
  ) throw authenticationFailed()
  return Object.freeze({
    authorization: null,
    gate: Object.freeze({ kind: 'none' }),
    binding: null,
  })
}

/**
 * Authenticates one raw rollback preimage and remints its one-shot gate.
 *
 * @param input - Exact rollback-planning commit construction.
 * @returns Fresh target-preimage cap and compact binding.
 */
async function prepareTargetPreimageCommitGate(
  input: PrepareStageCommitGateInput,
): Promise<PreparedStageCommitGate> {
  const artifactPath = input.configuration.targetPreimageAuditFile
  if (
    artifactPath === undefined ||
    input.configuration.terminalReconciliationAuditFile !== undefined ||
    input.receipt.evidence.kind !== 'planning-sealed' ||
    (input.existingIntent !== undefined &&
      input.existingIntent.intent.commitGate.kind !== 'target-preimage')
  ) throw authenticationFailed()
  const artifactBytes = await readStageCommitCliPrivateBytes(
    artifactPath,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
    input.dependencies,
    input.ownedBuffers,
  )
  const purpose = input.receipt.scenario === 'complete-apply-rollback'
    ? 'complete-rollback-preimage'
    : input.receipt.scenario === 'partial-apply-rollback'
    ? 'partial-rollback-preimage'
    : authenticationFailed()
  const commitGateObservedAt = input.existingIntent === undefined
    ? input.clock.clock().toISOString()
    : readExistingTargetCommitGateObservedAt(input.existingIntent.intent)
  if (
    Date.parse(commitGateObservedAt) >= Date.parse(input.reservation.expiresAt)
  ) throw authenticationFailed()
  let authorization:
    WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence
  let binding: WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding
  try {
    authorization =
      finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
        {
          artifact: Object.freeze({
            artifactBytes,
            expectedContext: createStageCommitTargetAuditContext(input),
            purpose,
            terminal: null,
          }),
          expectedProspectivePlanningReceiptDigest:
            createMigrationDigest(input.receipt),
          expectedPlanningReceiptCompletedAt: input.receipt.completedAt,
          expectedRatePredecessor: input.receipt.rateSegment,
          commitGateObservedAt,
        },
        new Uint8Array(input.runtimeKey),
        new Uint8Array(input.publicationKey),
      )
    binding =
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        authorization,
      )
  } catch {
    throw authenticationFailed()
  }
  requireCliTargetPreimageCommitGateMatches(binding, input)
  return Object.freeze({
    authorization,
    gate: createCliTargetPreimageCommitGate(binding),
    binding,
  })
}

/**
 * Authenticates one raw terminal reconciliation and remints its one-shot gate.
 *
 * @param input - Exact terminal commit construction.
 * @returns Fresh terminal reconciliation cap and compact binding.
 */
async function prepareTerminalReconciliationCommitGate(
  input: PrepareStageCommitGateInput,
): Promise<PreparedStageCommitGate> {
  const artifactPath = input.configuration.terminalReconciliationAuditFile
  if (
    artifactPath === undefined ||
    input.configuration.targetPreimageAuditFile !== undefined ||
    input.receipt.evidence.kind !== 'terminal' ||
    (input.existingIntent !== undefined &&
      input.existingIntent.intent.commitGate.kind !==
        'terminal-reconciliation')
  ) throw authenticationFailed()
  const artifactBytes = await readStageCommitCliPrivateBytes(
    artifactPath,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES,
    input.dependencies,
    input.ownedBuffers,
  )
  const evidence = input.receipt.evidence
  const expectedRatePredecessor = evidence.command === 'verify'
    ? input.receipt.rateSegment
    : evidence.reconciliationContext.targetAudits?.restored.rate.successor
  if (expectedRatePredecessor === undefined) throw authenticationFailed()
  let authorization:
    WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence
  let binding:
    WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding
  try {
    authorization =
      finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
        {
          artifact: Object.freeze({
            artifactBytes,
            expectedContext: evidence.reconciliationContext,
          }),
          expectedRatePredecessor,
        },
        new Uint8Array(input.runtimeKey),
        new Uint8Array(input.publicationKey),
      )
    binding =
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        authorization,
      )
  } catch {
    throw authenticationFailed()
  }
  requireCliTerminalReconciliationCommitGateMatches(binding, input)
  return Object.freeze({
    authorization,
    gate: createCliTerminalReconciliationCommitGate(binding),
    binding,
  })
}

/** Reads the persisted gate time that an exact target-cap retry must reuse. */
function readExistingTargetCommitGateObservedAt(
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
): string {
  if (intent.commitGate.kind !== 'target-preimage') {
    return authenticationFailed()
  }
  return intent.commitGate.commitGateObservedAt
}

/** Builds the exact rollback planning context expected inside a target audit. */
function createStageCommitTargetAuditContext(
  input: PrepareStageCommitGateInput,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  if (input.receipt.evidence.kind !== 'planning-sealed') {
    return authenticationFailed()
  }
  const scenario = input.receipt.scenario
  if (
    scenario !== 'complete-apply-rollback' &&
    scenario !== 'partial-apply-rollback'
  ) return authenticationFailed()
  return Object.freeze({
    scenario,
    runLocatorDigest: input.receipt.runLocatorDigest,
    manifestDigest: input.selection.manifestDigest,
    permitDigest: input.receipt.permitDigest,
    requestedResourcesBinding: input.receipt.requestedResourcesBinding,
    configurationBindingDigest: input.receipt.configurationBindingDigest,
    planningReceiptDigest: createMigrationDigest(input.receipt),
    executionBoundaryDigest:
      input.receipt.evidence.executionBoundaryDigest,
    sealedPlanningAuthorityDigest:
      input.receipt.evidence.sealedPlanningAuthorityDigest,
    planDigest: input.receipt.evidence.planDigest,
    writerFenceDigest: input.receipt.writerFenceDigest,
  })
}

/** Requires a fresh target cap to bind the exact receipt and reservation. */
function requireCliTargetPreimageCommitGateMatches(
  binding: WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
  input: PrepareStageCommitGateInput,
): void {
  if (input.receipt.evidence.kind !== 'planning-sealed') {
    return authenticationFailed()
  }
  const expectedPurpose = input.receipt.scenario ===
      'complete-apply-rollback'
    ? 'complete-rollback-preimage'
    : input.receipt.scenario === 'partial-apply-rollback'
    ? 'partial-rollback-preimage'
    : authenticationFailed()
  if (
    binding.purpose !== expectedPurpose ||
    binding.commit !== input.receipt.commit ||
    binding.configurationHash !==
      input.receipt.configurationBindingDigest ||
    binding.sourceResourceBindingDigest !==
      input.receipt.requestedResourcesBinding ||
    serializeCanonicalJson(binding.context) !==
      serializeCanonicalJson(createStageCommitTargetAuditContext(input)) ||
    binding.prospectivePlanningReceiptDigest !==
      createMigrationDigest(input.receipt) ||
    binding.expectedPlanningReceiptCompletedAt !==
      input.receipt.completedAt ||
    serializeCanonicalJson(binding.rate.predecessor) !==
      serializeCanonicalJson(input.receipt.rateSegment) ||
    Date.parse(binding.commitGateObservedAt) >=
      Date.parse(input.reservation.expiresAt) ||
    Date.parse(binding.rate.completedAt) >=
      Date.parse(input.reservation.expiresAt)
  ) throw authenticationFailed()
}

/** Requires a fresh terminal cap to bind the exact terminal receipt. */
function requireCliTerminalReconciliationCommitGateMatches(
  binding:
    WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
  input: PrepareStageCommitGateInput,
): void {
  if (input.receipt.evidence.kind !== 'terminal') {
    return authenticationFailed()
  }
  const evidence = input.receipt.evidence
  const context =
    snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext(
      binding,
    )
  if (
    createMigrationDigest(binding) !==
      evidence.reconciliationArtifactBindingDigest ||
    binding.contentDigest !==
      evidence.reconciliationArtifactContentDigest ||
    binding.byteLength !== evidence.reconciliationArtifactByteLength ||
    binding.auditDigest !== evidence.reconciliationArtifactAuditDigest ||
    serializeCanonicalJson(context) !==
      serializeCanonicalJson(evidence.reconciliationContext) ||
    serializeCanonicalJson(binding.rate) !==
      serializeCanonicalJson(evidence.reconciliationRate) ||
    binding.scenario !== input.receipt.scenario ||
    Date.parse(binding.rate.completedAt) >=
      Date.parse(input.reservation.expiresAt)
  ) throw authenticationFailed()
}

/** Creates the compact target-preimage gate authenticated by the intent. */
function createCliTargetPreimageCommitGate(
  binding: WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
): Extract<
  WorkspaceSearchMigrationRehearsalStageCommitGate,
  { readonly kind: 'target-preimage' }
> {
  return Object.freeze({
    kind: 'target-preimage',
    artifactBindingDigest: binding.bindingDigest,
    contentDigest: binding.contentDigest,
    byteLength: binding.byteLength,
    purpose: binding.purpose,
    contextDigest: binding.contextDigest,
    commitGateObservedAt: binding.commitGateObservedAt,
    observationDigest: binding.observationDigest,
    aggregateDigest: binding.aggregateDigest,
    rateSuccessor: binding.rate.successor,
    rateAggregateDigest: binding.rate.aggregateDigest,
    rateCompletedAt: binding.rate.completedAt,
  })
}

/** Creates the compact terminal-reconciliation gate authenticated by intent. */
function createCliTerminalReconciliationCommitGate(
  binding:
    WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
): Extract<
  WorkspaceSearchMigrationRehearsalStageCommitGate,
  { readonly kind: 'terminal-reconciliation' }
> {
  const context =
    snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext(
      binding,
    )
  return Object.freeze({
    kind: 'terminal-reconciliation',
    artifactBindingDigest: createMigrationDigest(binding),
    contentDigest: binding.contentDigest,
    byteLength: binding.byteLength,
    scenario: binding.scenario,
    contextDigest: createMigrationDigest(context),
    auditDigest: binding.auditDigest,
    rateSuccessor: binding.rate.successor,
    rateAggregateDigest: binding.rate.aggregateDigest,
    rateCompletedAt: binding.rate.completedAt,
  })
}

/**
 * Reuses an exact durable intent or fsyncs a new one before remote I/O.
 *
 * @param input - Authenticated commit material, trusted clock, and filesystem.
 * @returns Frozen exact evidence and canonical bytes backed by the intent.
 */
async function readOrCreateStageCommitEvidenceIntent(
  input: ReadOrCreateStageCommitEvidenceIntentInput,
): Promise<StageCommitPreparedIntent> {
  if (input.existingIntent !== undefined) {
    requireStageCommitPreparedIntentBindings(
      input.existingIntent.intent,
      input,
    )
    return input.existingIntent
  }
  const preparedAt = input.clock.clock().toISOString()
  const receiptDigest = createMigrationDigest(input.receipt)
  const intent =
    createWorkspaceSearchMigrationRehearsalStageCommitIntent({
      claims: Object.freeze({
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND,
        intentVersion:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION,
        stage: 'non-production',
        manifestDigest: input.receipt.manifestDigest,
        permitDigest: input.receipt.permitDigest,
        requestedResourcesBinding:
          input.receipt.requestedResourcesBinding,
        stateTableLocationBindingDigest:
          input.stateTableLocationBindingDigest,
        publicationKeyDigest:
          input.parentAuthorizationBinding.publicationKeyDigest,
        parentAuthenticationDigest:
          input.parentAuthorizationBinding.parentAuthenticationDigest,
        parentAuthorizationBindingDigest:
          createMigrationDigest(input.parentAuthorizationBinding),
        stageOrdinal: input.receipt.stageOrdinal,
        stageReservationDigest:
          createMigrationDigest(input.reservation),
        stageReservationClaimRevision:
          input.receipt.stageReservationClaimRevision,
        receiptDigest,
        commitRevision:
          input.receipt.stageReservationCommitRevision,
        expectedHead: createExpectedStageCommitEvidenceHead(input.receipt),
        commitGate: input.commitGate,
        recoveryAuthorization:
          createStageCommitRecoveryAuthorization(input),
        preparedAt,
        intentStatus: 'prepared',
      }),
      signingKey: input.publicationKey,
    })
  requireStageCommitPreparedIntentBindings(intent, input)
  const intentBytes = new TextEncoder().encode(
    serializeCanonicalJson(intent),
  )
  input.ownedBuffers.push(intentBytes)
  let writeOutcome: WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome
  try {
    writeOutcome = await input.dependencies.writeEvidenceFileExclusive(
      input.intentPath,
      intentBytes,
    )
  } catch {
    throw outputWriteFailed()
  }
  if (writeOutcome !== 'created' && writeOutcome !== 'reconciled') {
    throw outputWriteFailed()
  }
  return Object.freeze({ intent, intentBytes })
}

/** Copies one ordinary bounded canonical intent byte vector. */
function copyStageCommitIntentBytes(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength === 0 ||
    value.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_MAX_BYTES
  ) throw outputWriteFailed()
  try {
    return new Uint8Array(value)
  } catch {
    throw outputWriteFailed()
  }
}

/** Parses and authenticates one exact canonical commit-intent document. */
function parseStageCommitPreparedIntent(
  bytes: Uint8Array,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageCommitIntent {
  try {
    return parseWorkspaceSearchMigrationRehearsalStageCommitIntentDocument(
      bytes,
      verificationKey,
    )
  } catch {
    throw outputWriteFailed()
  }
}

/** Requires one recovered or new intent to bind every authenticated input. */
function requireStageCommitPreparedIntentBindings(
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
  input: ReadOrCreateStageCommitEvidenceIntentInput,
): void {
  const receiptDigest = createMigrationDigest(input.receipt)
  const reservationDigest = createMigrationDigest(input.reservation)
  const expectedHead = createExpectedStageCommitEvidenceHead(input.receipt)
  const expectedRecoveryAuthorization =
    createStageCommitRecoveryAuthorization(input)
  const preparedMilliseconds = Date.parse(intent.preparedAt)
  if (
    intent.manifestDigest !== input.receipt.manifestDigest ||
    intent.permitDigest !== input.receipt.permitDigest ||
    intent.requestedResourcesBinding !==
      input.receipt.requestedResourcesBinding ||
    intent.stateTableLocationBindingDigest !==
      input.stateTableLocationBindingDigest ||
    intent.publicationKeyDigest !==
      input.parentAuthorizationBinding.publicationKeyDigest ||
    intent.parentAuthenticationDigest !==
      input.parentAuthorizationBinding.parentAuthenticationDigest ||
    intent.parentAuthorizationBindingDigest !==
      createMigrationDigest(input.parentAuthorizationBinding) ||
    intent.stageOrdinal !== input.receipt.stageOrdinal ||
    intent.stageReservationDigest !== reservationDigest ||
    intent.stageReservationDigest !==
      input.receipt.stageReservationDigest ||
    intent.stageReservationClaimRevision !==
      input.receipt.stageReservationClaimRevision ||
    intent.receiptDigest !== receiptDigest ||
    intent.commitRevision !==
      input.receipt.stageReservationCommitRevision ||
    serializeCanonicalJson(intent.expectedHead) !==
      serializeCanonicalJson(expectedHead) ||
    serializeCanonicalJson(intent.commitGate) !==
      serializeCanonicalJson(input.commitGate) ||
    serializeCanonicalJson(intent.recoveryAuthorization) !==
      serializeCanonicalJson(expectedRecoveryAuthorization) ||
    preparedMilliseconds <=
      Date.parse(readStageCommitReceiptCommitFloor(input.receipt)) ||
    preparedMilliseconds < Date.parse(input.permitClaims.issuedAt) ||
    preparedMilliseconds >=
      Date.parse(expectedRecoveryAuthorization.recoveryDeadlineAt) ||
    (intent.commitGate.kind === 'target-preimage' &&
      preparedMilliseconds <=
        Date.parse(intent.commitGate.commitGateObservedAt)) ||
    (intent.commitGate.kind !== 'none' &&
      Date.parse(intent.commitGate.rateCompletedAt) >=
        Date.parse(input.reservation.expiresAt))
  ) throw authenticationFailed()
}

/**
 * Projects genuine parent authorization into proactive recovery authority.
 *
 * @param input - Exact authenticated receipt, reservation, permit, and parent binding.
 * @returns Frozen prerequisites MAC-bound into every prepared intent.
 */
function createStageCommitRecoveryAuthorization(
  input: ReadOrCreateStageCommitEvidenceIntentInput,
): WorkspaceSearchMigrationRehearsalStageCommitIntent[
  'recoveryAuthorization'
] {
  const reservationExpiresMilliseconds = Date.parse(
    input.reservation.expiresAt,
  )
  const recoveryDeadlineMilliseconds =
    reservationExpiresMilliseconds +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS
  let recoveryDeadlineAt: string
  try {
    recoveryDeadlineAt = new Date(recoveryDeadlineMilliseconds).toISOString()
  } catch {
    throw authenticationFailed()
  }
  const cleanup =
    input.parentAuthorizationBinding.runtimeKeyCleanupAuthorization
  return Object.freeze({
    reservationExpiresAt: input.reservation.expiresAt,
    permitExpiresAt: input.permitClaims.expiresAt,
    recoveryDeadlineAt,
    receiptCompletedAt: input.receipt.completedAt,
    processExitedAt: input.receipt.processLifecycle.processExitedAt,
    materialEvidenceDigest:
      input.parentAuthorizationBinding.materialEvidenceDigest,
    boundaryMaterialEvidenceDigest:
      input.parentAuthorizationBinding.boundaryMaterialEvidenceDigest,
    materialDigest: input.parentAuthorizationBinding.materialDigest,
    claimedStageHeadDigest:
      input.parentAuthorizationBinding.claimedStageHeadDigest,
    lifecycleEvidenceDigest:
      input.parentAuthorizationBinding.lifecycleEvidenceDigest,
    lifecycleDigest: input.parentAuthorizationBinding.lifecycleDigest,
    runtimeKeyCleanupAuthorizationBindingDigest:
      cleanup.authorizationBindingDigest,
    cleanupIntentDigest: cleanup.cleanupIntentDigest,
    cleanupCompletionDigest: cleanup.cleanupCompletionDigest,
    cleanupPreparedAt: cleanup.preparedAt,
    cleanupCompletedAt: cleanup.completedAt,
  })
}

/**
 * Checks durable publication bytes against their non-durable prepared intent.
 *
 * @param evidence - Store-returned committed immutable-row evidence.
 * @param intent - Authenticated preflight intent fsynced before remote I/O.
 * @param reservationExpiresAt - Exclusive ordinary-admission ceiling.
 * @returns Whether the evidence is the exact admitted successor of the intent.
 */
function isCommittedStageEvidenceDerivedFromPreparedIntent(
  evidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
  reservationExpiresAt: string,
): boolean {
  const admittedMilliseconds = Date.parse(evidence.commitAdmittedAt)
  const reservationExpiresMilliseconds = Date.parse(reservationExpiresAt)
  const timingMatches = evidence.admissionMode === 'ordinary'
    ? admittedMilliseconds < reservationExpiresMilliseconds
    : evidence.admissionMode === 'bounded-recovery' &&
      admittedMilliseconds >= reservationExpiresMilliseconds &&
      admittedMilliseconds <=
        Date.parse(intent.recoveryAuthorization.recoveryDeadlineAt)
  return evidence.manifestDigest === intent.manifestDigest &&
    evidence.permitDigest === intent.permitDigest &&
    evidence.requestedResourcesBinding ===
      intent.requestedResourcesBinding &&
    evidence.stateTableLocationBindingDigest ===
      intent.stateTableLocationBindingDigest &&
    evidence.publicationKeyDigest === intent.publicationKeyDigest &&
    evidence.parentAuthenticationDigest ===
      intent.parentAuthenticationDigest &&
    evidence.parentAuthorizationBindingDigest ===
      intent.parentAuthorizationBindingDigest &&
    evidence.stageOrdinal === intent.stageOrdinal &&
    evidence.stageReservationDigest === intent.stageReservationDigest &&
    evidence.stageReservationClaimRevision ===
      intent.stageReservationClaimRevision &&
    evidence.receiptDigest === intent.receiptDigest &&
    evidence.commitRevision === intent.commitRevision &&
    serializeCanonicalJson(evidence.commitGate) ===
      serializeCanonicalJson(intent.commitGate) &&
    (intent.commitGate.kind === 'none' ||
      evidence.admissionMode === 'ordinary') &&
    evidence.recoveryAuthorization.reservationExpiresAt ===
      reservationExpiresAt &&
    serializeCanonicalJson(evidence.recoveryAuthorization) ===
      serializeCanonicalJson(intent.recoveryAuthorization) &&
    Date.parse(evidence.commitAdmittedAt) > Date.parse(intent.preparedAt) &&
    timingMatches &&
    serializeCanonicalJson(evidence.head) ===
      serializeCanonicalJson(intent.expectedHead) &&
    evidence.durableStatus === 'committed'
}

/** Creates the sole exact inactive successor known before the transaction. */
function createExpectedStageCommitEvidenceHead(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead {
  const receiptDigest = createMigrationDigest(receipt)
  return Object.freeze({
    manifestDigest: receipt.manifestDigest,
    completedStageOrdinal: receipt.stageOrdinal,
    headReceiptDigest: receiptDigest,
    activeReservationDigest: null,
    activeStageOrdinal: null,
    activeExpiresAt: null,
    abandonmentCount: receipt.stageReservationAbandonmentCount,
    abandonmentRootDigest:
      receipt.stageReservationAbandonmentRootDigest,
    revision: receipt.stageReservationCommitRevision,
  })
}

/**
 * Returns the latest authenticated receipt completion or parent-exit time.
 *
 * @param receipt - Exact authenticated receipt awaiting durable commit.
 * @returns Canonical exclusive lower bound for every commit clock sample.
 */
function readStageCommitReceiptCommitFloor(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): string {
  return Date.parse(receipt.completedAt) >=
      Date.parse(receipt.processLifecycle.processExitedAt)
    ? receipt.completedAt
    : receipt.processLifecycle.processExitedAt
}

/** Detaches and requires the exact inactive successor returned by the commit. */
function readExactCommittedStageHead(
  head: WorkspaceSearchMigrationRehearsalStageHead,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): WorkspaceSearchMigrationRehearsalStageCommitEvidenceHead {
  const receiptDigest = createMigrationDigest(receipt)
  if (
    head.manifestDigest !== receipt.manifestDigest ||
    head.completedStageOrdinal !== receipt.stageOrdinal ||
    head.headReceiptDigest !== receiptDigest ||
    head.activeReservationDigest !== null ||
    head.activeStageOrdinal !== null ||
    head.activeExpiresAt !== null ||
    head.abandonmentCount !==
      receipt.stageReservationAbandonmentCount ||
    head.abandonmentRootDigest !==
      receipt.stageReservationAbandonmentRootDigest ||
    head.revision !== receipt.stageReservationCommitRevision
  ) throw commitFailed()
  return Object.freeze({
    manifestDigest: head.manifestDigest,
    completedStageOrdinal: head.completedStageOrdinal,
    headReceiptDigest: receiptDigest,
    activeReservationDigest: null,
    activeStageOrdinal: null,
    activeExpiresAt: null,
    abandonmentCount: head.abandonmentCount,
    abandonmentRootDigest: head.abandonmentRootDigest,
    revision: head.revision,
  })
}

/** Copies and bounds one exact argument vector. */
function snapshotStageCommitCliArguments(
  value: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length === 0 ||
    value.length > maximumStageCommitCliArgumentCount
  ) throw invalidUsage()
  const snapshot: string[] = []
  for (const argument of value) {
    if (
      typeof argument !== 'string' ||
      argument.length === 0 ||
      argument.length > maximumStageCommitCliArgumentLength ||
      argument.includes('\0')
    ) throw invalidUsage()
    snapshot.push(argument)
  }
  return Object.freeze(snapshot)
}

/** Parses unique exact allowlisted flag/value pairs. */
function parseStageCommitCliFlagPairs(
  arguments_: readonly string[],
): ReadonlyMap<string, string> {
  if (arguments_.length % 2 !== 0) throw invalidUsage()
  const flags = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (
      name === undefined ||
      value === undefined ||
      !stageCommitCliFlagNames.has(name) ||
      flags.has(name) ||
      value.startsWith('--') ||
      value.length === 0
    ) throw invalidUsage()
    flags.set(name, value)
  }
  return flags
}

/** Reads one required non-empty allowlisted scalar flag. */
function requireStageCommitCliFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = flags.get(name)
  if (value === undefined) throw invalidUsage()
  return value
}

/** Reads and resolves one required private path. */
function requireResolvedStageCommitCliPath(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  return resolveStageCommitCliPath(requireStageCommitCliFlag(flags, name))
}

/** Reads and resolves one optional private path. */
function readOptionalResolvedStageCommitCliPath(
  flags: ReadonlyMap<string, string>,
  name: string,
): string | undefined {
  const value = flags.get(name)
  return value === undefined ? undefined : resolveStageCommitCliPath(value)
}

/** Creates one optional named path property without a type assertion. */
function readOptionalStageCommitCliPath(
  flags: ReadonlyMap<string, string>,
  flagName: string,
  propertyName:
    | 'boundaryMaterialFile'
    | 'boundaryRateSegmentFile'
    | 'faultPlanFile'
    | 'finalRateSegmentFile',
): StageCommitOptionalFaultPaths {
  const path = readOptionalResolvedStageCommitCliPath(flags, flagName)
  if (path === undefined) return Object.freeze({})
  if (propertyName === 'faultPlanFile') {
    return Object.freeze({ faultPlanFile: path })
  }
  if (propertyName === 'boundaryRateSegmentFile') {
    return Object.freeze({ boundaryRateSegmentFile: path })
  }
  if (propertyName === 'boundaryMaterialFile') {
    return Object.freeze({ boundaryMaterialFile: path })
  }
  return Object.freeze({ finalRateSegmentFile: path })
}

/** Normalizes the optional fault path set into a CLI property. */
function createStageCommitFaultInputs(
  value: StageCommitOptionalFaultPaths,
): Pick<
  WorkspaceSearchMigrationRehearsalStageCommitCliArguments,
  'faultInputs'
> | Readonly<Record<never, never>> {
  const {
    faultPlanFile,
    boundaryRateSegmentFile,
    boundaryMaterialFile,
    finalRateSegmentFile,
  } = value
  if (
    faultPlanFile === undefined &&
    boundaryRateSegmentFile === undefined &&
    boundaryMaterialFile === undefined &&
    finalRateSegmentFile === undefined
  ) return Object.freeze({})
  if (
    faultPlanFile === undefined ||
    boundaryRateSegmentFile === undefined
  ) throw invalidUsage()
  if (
    boundaryMaterialFile === undefined &&
    finalRateSegmentFile === undefined
  ) {
    return Object.freeze({
      faultInputs: Object.freeze({
        faultPlanFile,
        boundaryRateSegmentFile,
      }),
    })
  }
  if (
    boundaryMaterialFile === undefined ||
    finalRateSegmentFile === undefined
  ) throw invalidUsage()
  return Object.freeze({
    faultInputs: Object.freeze({
      faultPlanFile,
      boundaryRateSegmentFile,
      boundaryMaterialFile,
      finalRateSegmentFile,
    }),
  })
}

/** Resolves one finite local path without reflecting it on failure. */
function resolveStageCommitCliPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumStageCommitCliArgumentLength ||
    value.includes('\0')
  ) throw invalidUsage()
  try {
    return resolve(value)
  } catch {
    throw invalidUsage()
  }
}

/** Rejects path aliasing across every supplied private input and output. */
function requireDistinctStageCommitCliPaths(
  configuration: WorkspaceSearchMigrationRehearsalStageCommitCliArguments,
): void {
  const paths = [
    configuration.ratePolicyFile,
    configuration.permitFile,
    configuration.rehearsalAuthenticationKeyFile,
    configuration.stageManifestFile,
    configuration.materialFile,
    configuration.lifecycleEvidenceFile,
    configuration.parentAuthenticationFile,
    configuration.stageReceiptFile,
    configuration.runtimeKeyEvidenceDirectory,
    configuration.outputFile,
    configuration.intentFile,
  ]
  if (configuration.previousReceiptFile !== undefined) {
    paths.push(configuration.previousReceiptFile)
  }
  if (configuration.reservationAbandonmentsFile !== undefined) {
    paths.push(configuration.reservationAbandonmentsFile)
  }
  if (configuration.targetPreimageAuditFile !== undefined) {
    paths.push(configuration.targetPreimageAuditFile)
  }
  if (configuration.terminalReconciliationAuditFile !== undefined) {
    paths.push(configuration.terminalReconciliationAuditFile)
  }
  if (configuration.faultInputs !== undefined) {
    paths.push(
      configuration.faultInputs.faultPlanFile,
      configuration.faultInputs.boundaryRateSegmentFile,
    )
    if ('boundaryMaterialFile' in configuration.faultInputs) {
      paths.push(
        configuration.faultInputs.boundaryMaterialFile,
        configuration.faultInputs.finalRateSegmentFile,
      )
    }
  }
  if (new Set(paths).size !== paths.length) throw invalidUsage()
}

/** Captures own non-Proxy dependency functions without invoking accessors. */
function snapshotStageCommitCliDependencies(
  value: WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
): WorkspaceSearchMigrationRehearsalStageCommitCliDependencies {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) throw invalidUsage()
  const keys = [
    'commitStageReservation',
    'ensureEvidenceOutputAbsent',
    'now',
    'promoteEvidenceIntentExclusive',
    'readEvidenceIntentFile',
    'readPrivateInputFile',
    'writeEvidenceFileExclusive',
    'writeStderrLine',
    'writeStdoutLine',
  ]
  const functions: ((...arguments_: unknown[]) => unknown)[] = []
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    const candidate = descriptor?.value
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof candidate !== 'function' ||
      nodeUtilTypes.isProxy(candidate)
    ) throw invalidUsage()
    functions.push(candidate)
  }
  const [
    commitStageReservation,
    ensureEvidenceOutputAbsent,
    now,
    promoteEvidenceIntentExclusive,
    readEvidenceIntentFile,
    readPrivateInputFile,
    writeEvidenceFileExclusive,
    writeStderrLine,
    writeStdoutLine,
  ] = functions
  if (
    commitStageReservation === undefined ||
    ensureEvidenceOutputAbsent === undefined ||
    now === undefined ||
    promoteEvidenceIntentExclusive === undefined ||
    readEvidenceIntentFile === undefined ||
    readPrivateInputFile === undefined ||
    writeEvidenceFileExclusive === undefined ||
    writeStderrLine === undefined ||
    writeStdoutLine === undefined
  ) throw invalidUsage()
  return Object.freeze({
    commitStageReservation: async (input) => {
      const result: unknown = Reflect.apply(
        commitStageReservation,
        value,
        [input],
      )
      if (!(result instanceof Promise)) throw commitFailed()
      return await result
    },
    ensureEvidenceOutputAbsent: async (path): Promise<void> => {
      const result: unknown = Reflect.apply(
        ensureEvidenceOutputAbsent,
        value,
        [path],
      )
      if (!(result instanceof Promise)) throw outputWriteFailed()
      await result
    },
    now: (): Date => {
      const result: unknown = Reflect.apply(now, value, [])
      if (!(result instanceof Date)) throw authenticationFailed()
      return result
    },
    promoteEvidenceIntentExclusive: async (
      intentPath,
      outputPath,
      evidenceBytes,
    ) => {
      const result: unknown = Reflect.apply(
        promoteEvidenceIntentExclusive,
        value,
        [intentPath, outputPath, evidenceBytes],
      )
      if (!(result instanceof Promise)) throw outputWriteFailed()
      return await result
    },
    readEvidenceIntentFile: async (intentPath) => {
      const result: unknown = Reflect.apply(
        readEvidenceIntentFile,
        value,
        [intentPath],
      )
      if (!(result instanceof Promise)) throw inputInvalid()
      const bytes: unknown = await result
      if (bytes !== undefined && !(bytes instanceof Uint8Array)) {
        throw inputInvalid()
      }
      return bytes
    },
    readPrivateInputFile: async (path, maximumBytes) => {
      const result: unknown = Reflect.apply(
        readPrivateInputFile,
        value,
        [path, maximumBytes],
      )
      if (!(result instanceof Promise)) throw inputInvalid()
      const bytes: unknown = await result
      if (!(bytes instanceof Uint8Array)) throw inputInvalid()
      return bytes
    },
    writeEvidenceFileExclusive: async (path, bytes) => {
      const result: unknown = Reflect.apply(
        writeEvidenceFileExclusive,
        value,
        [path, bytes],
      )
      if (!(result instanceof Promise)) throw outputWriteFailed()
      return await result
    },
    writeStderrLine: (line): void => {
      Reflect.apply(writeStderrLine, value, [line])
    },
    writeStdoutLine: (line): void => {
      Reflect.apply(writeStdoutLine, value, [line])
    },
  })
}

/** Reads, detaches, and tracks one exact private bounded input. */
async function readStageCommitCliPrivateBytes(
  path: string,
  maximumBytes: number,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<Uint8Array> {
  let callerBytes: Uint8Array
  try {
    callerBytes = await dependencies.readPrivateInputFile(path, maximumBytes)
  } catch (error: unknown) {
    if (
      error instanceof WorkspaceSearchMigrationRehearsalPrivateInputError &&
      error.code === 'PRIVATE_INPUT_UNREADABLE'
    ) throw inputUnreadable()
    throw inputInvalid()
  }
  if (
    nodeUtilTypes.isProxy(callerBytes) ||
    nodeUtilTypes.isSharedArrayBuffer(callerBytes.buffer) ||
    callerBytes.byteLength === 0 ||
    callerBytes.byteLength > maximumBytes
  ) {
    zeroizeStageCommitCliBytes(callerBytes)
    throw inputInvalid()
  }
  ownedBuffers.push(callerBytes)
  let copy: Uint8Array
  try {
    copy = new Uint8Array(callerBytes)
  } catch {
    throw inputInvalid()
  }
  ownedBuffers.push(copy)
  zeroizeStageCommitCliBytes(callerBytes)
  return copy
}

/** Reads one exact private 32-byte key and tracks its owned copy. */
async function readStageCommitCliKey(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<Uint8Array> {
  const key = await readStageCommitCliPrivateBytes(
    path,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_KEY_BYTES,
    dependencies,
    ownedBuffers,
  )
  if (
    key.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_KEY_BYTES
  ) throw authenticationFailed()
  return key
}

/** Parses one exact canonical JSON private document. */
function parseCanonicalStageCommitJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    if (serializeCanonicalJson(value) !== text) throw inputInvalid()
    return value
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalStageCommitCliFailure) {
      throw error
    }
    throw inputInvalid()
  }
}

/** Parses one exact canonical reviewed DescribeTable rate policy. */
function readStageCommitRatePolicy(
  bytes: Uint8Array,
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  try {
    return parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(bytes)
  } catch {
    throw authenticationFailed()
  }
}

/** Input for independently authenticating the non-production permit. */
type AuthenticateStageCommitPermitInput = {
  /** Parsed exact canonical complete permit. */
  readonly permit: unknown
  /** Private permit verification key. */
  readonly permitKey: Uint8Array
  /** Explicit validated resources. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Digest of all explicit requested resources, including profile. */
  readonly requestedResourcesBinding: string
  /** Trusted current live wall-clock sample. */
  readonly currentTime: Date
}

/** Independently authenticates one permit against every explicit resource. */
function authenticateStageCommitPermit(
  input: AuthenticateStageCommitPermitInput,
): Readonly<WorkspaceSearchMigrationRehearsalPermitClaims> {
  try {
    return verifyWorkspaceSearchMigrationRehearsalPermit({
      permit: input.permit,
      verificationKey: input.permitKey,
      account: input.resources.account,
      region: input.resources.region,
      commit: input.resources.commit,
      requestedResourcesBinding: input.requestedResourcesBinding,
      currentTime: input.currentTime,
    })
  } catch {
    throw authenticationFailed()
  }
}

/** Parses and authenticates one exact canonical manifest. */
function parseStageCommitManifest(
  bytes: Uint8Array,
  stageKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageManifest {
  try {
    return parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
      bytes,
      stageKey,
    )
  } catch {
    throw authenticationFailed()
  }
}

/** Parses and authenticates one exact canonical stage receipt. */
function parseStageCommitReceipt(
  bytes: Uint8Array,
  stageKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  try {
    return parseWorkspaceSearchMigrationRehearsalStageReceiptDocument(
      bytes,
      stageKey,
    )
  } catch {
    throw authenticationFailed()
  }
}

/** Reads the mandatory predecessor only when the current ordinal exceeds one. */
async function readStageCommitPreviousReceipt(
  configuration: WorkspaceSearchMigrationRehearsalStageCommitCliArguments,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  stageKey: Uint8Array,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<WorkspaceSearchMigrationRehearsalStageReceipt | null> {
  if (receipt.stageOrdinal === 1) {
    if (configuration.previousReceiptFile !== undefined) {
      throw invalidUsage()
    }
    return null
  }
  if (configuration.previousReceiptFile === undefined) throw invalidUsage()
  const bytes = await readStageCommitCliPrivateBytes(
    configuration.previousReceiptFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  return parseStageCommitReceipt(bytes, stageKey)
}

/** Derives the next exact selection from authenticated manifest and predecessor. */
function deriveAuthenticatedStageCommitSelection(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  expectedOrdinal: number,
): WorkspaceSearchMigrationRehearsalSelectedStage {
  const manifestDigest = createMigrationDigest(manifest)
  let ordinal = 1
  let previousStageReceiptDigest: string | null = null
  if (previousReceipt !== null) {
    const previousEntry = manifest.entries[previousReceipt.stageOrdinal - 1]
    if (previousEntry === undefined) throw authenticationFailed()
    requireReceiptMatchesManifestEntry(
      previousReceipt,
      previousEntry,
      manifest,
      manifestDigest,
    )
    ordinal = previousReceipt.stageOrdinal + 1
    previousStageReceiptDigest = createMigrationDigest(previousReceipt)
  }
  const entry = manifest.entries[ordinal - 1]
  if (entry === undefined || ordinal !== expectedOrdinal) {
    throw authenticationFailed()
  }
  return Object.freeze({
    manifest,
    manifestDigest,
    entry,
    previousStageReceiptDigest,
  })
}

/** Requires one receipt to match its exact authenticated manifest entry. */
function requireReceiptMatchesManifestEntry(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  manifestDigest: string,
): void {
  if (
    receipt.stageOrdinal !== entry.ordinal ||
    receipt.scenario !== entry.scenario ||
    receipt.scenarioStageOrdinal !== entry.scenarioStageOrdinal ||
    receipt.command !== entry.command ||
    receipt.controlArgumentsDigest !== entry.controlArgumentsDigest ||
    receipt.attemptOrdinal !== entry.attemptOrdinal ||
    receipt.outcome !== entry.expectedOutcome ||
    receipt.manifestDigest !== manifestDigest ||
    receipt.manifestEntryDigest !== createMigrationDigest(entry) ||
    receipt.permitDigest !== manifest.permitDigest ||
    receipt.commit !== manifest.commit ||
    receipt.requestedResourcesBinding !==
      manifest.requestedResourcesBinding ||
    receipt.configurationBindingDigest !==
      manifest.configurationBindingDigest ||
    receipt.policyVersion !== manifest.policyVersion ||
    (entry.faultPlanDigest !== null) !==
      (receipt.faultBoundary !== null)
  ) throw authenticationFailed()
}

/** Top-level authenticated bindings independently rechecked before material. */
type RequireStageCommitTopLevelBindingsInput = {
  /** Authenticated reviewed manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Authenticated stage receipt. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Exact parsed complete permit including its MAC. */
  readonly permit: unknown
  /** Independently authenticated permit claims. */
  readonly permitClaims: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>
  /** Shared stage key bound by the permit. */
  readonly stageKey: Uint8Array
  /** Parent-only publication key bound by the permit and manifest. */
  readonly publicationKey: Uint8Array
  /** Digest of every explicit resource, including profile. */
  readonly requestedResourcesBinding: string
  /** Parsed exact reviewed rate policy. */
  readonly ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy
}

/** Requires permit, key, resources, commit, manifest, receipt, and policy equality. */
function requireStageCommitTopLevelBindings(
  input: RequireStageCommitTopLevelBindingsInput,
): void {
  const manifestDigest = createMigrationDigest(input.manifest)
  const permitDigest = createMigrationDigest(input.permit)
  const stageKeyDigest = createHash('sha256')
    .update(input.stageKey)
    .digest('hex')
  const publicationKeyDigest = createHash('sha256')
    .update(input.publicationKey)
    .digest('hex')
  if (
    input.permitClaims.evidenceKeyDigest !== stageKeyDigest ||
    input.permitClaims.publicationKeyDigest !== publicationKeyDigest ||
    input.manifest.evidenceKeyDigest !== stageKeyDigest ||
    input.manifest.publicationKeyDigest !== publicationKeyDigest ||
    input.manifest.permitDigest !== permitDigest ||
    input.manifest.commit !== input.permitClaims.commit ||
    input.manifest.requestedResourcesBinding !==
      input.requestedResourcesBinding ||
    input.manifest.policyVersion !== input.ratePolicy.policyVersion ||
    input.receipt.manifestDigest !== manifestDigest ||
    input.receipt.permitDigest !== permitDigest ||
    input.receipt.commit !== input.permitClaims.commit ||
    input.receipt.requestedResourcesBinding !==
      input.requestedResourcesBinding ||
    input.receipt.configurationBindingDigest !==
      input.manifest.configurationBindingDigest ||
    input.receipt.policyVersion !== input.ratePolicy.policyVersion
  ) throw authenticationFailed()
}

/** Returns the exact durable lease identity represented by either observation. */
function readStageCommitLeaseIdentityDigest(
  observation: WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
): string {
  return observation.kind === 'acquired'
    ? observation.successorLeaseIdentityDigest
    : observation.currentLeaseIdentityDigest
}

/** Authenticates one of the three persisted material protocols. */
async function authenticateStageCommitMaterial(
  configuration: WorkspaceSearchMigrationRehearsalStageCommitCliArguments,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  stageKey: Uint8Array,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<AuthenticatedStageCommitMaterial> {
  const materialBytes = await readStageCommitCliPrivateBytes(
    configuration.materialFile,
    Math.max(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES,
    ),
    dependencies,
    ownedBuffers,
  )
  const persistedMaterialEvidence =
    parseCanonicalStageCommitJson(materialBytes)
  const wrapper = readPersistedStageCommitMaterialWrapper(
    persistedMaterialEvidence,
  )
  if (selection.entry.faultPlanDigest === null) {
    if (
      configuration.faultInputs !== undefined ||
      wrapper.kind !==
        'mukuroji-workspace-search-migration-rehearsal-child-material-evidence'
    ) throw invalidUsage()
    try {
      const material =
        verifyWorkspaceSearchMigrationRehearsalStageChildMaterial({
          material: wrapper.material,
          selection,
          verificationKey: stageKey,
        })
      requirePersistedMaterialDigest(material, wrapper.materialDigest)
      return Object.freeze({
        reservation: material.stageReservation,
        claimedStageHead: material.claimedStageHead,
        leaseObservation: material.leaseAcquisitionObservation,
        leaseIdentityDigest: readStageCommitLeaseIdentityDigest(
          material.leaseAcquisitionObservation,
        ),
        authorizationInput: createSuccessStageCommitAuthorizationInput(
          persistedMaterialEvidence,
        ),
      })
    } catch {
      throw authenticationFailed()
    }
  }
  const faultInputs = configuration.faultInputs
  if (faultInputs === undefined) throw invalidUsage()
  const faultPlan = await readStageCommitFaultPlan(
    faultInputs.faultPlanFile,
    selection,
    dependencies,
    ownedBuffers,
  )
  const boundaryRateSegmentBytes = await readStageCommitCliPrivateBytes(
    faultInputs.boundaryRateSegmentFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
    dependencies,
    ownedBuffers,
  )
  if (selection.entry.expectedOutcome === 'fault-reached') {
    if (
      'boundaryMaterialFile' in faultInputs ||
      wrapper.kind !==
        'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence'
    ) throw invalidUsage()
    try {
      const material =
        verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
          material: wrapper.material,
          selection,
          faultPlan,
          rateSegmentBytes: boundaryRateSegmentBytes,
          verificationKey: stageKey,
        })
      requirePersistedMaterialDigest(material, wrapper.materialDigest)
      return Object.freeze({
        reservation: material.stageReservation,
        claimedStageHead: material.claimedStageHead,
        leaseObservation: material.leaseAcquisitionObservation,
        leaseIdentityDigest: readStageCommitLeaseIdentityDigest(
          material.leaseAcquisitionObservation,
        ),
        authorizationInput: createFaultBoundaryStageCommitAuthorizationInput(
          persistedMaterialEvidence,
          faultPlan,
          boundaryRateSegmentBytes,
        ),
      })
    } catch {
      throw authenticationFailed()
    }
  }
  if (
    selection.entry.expectedOutcome !== 'response-loss-reconciled' ||
    !('boundaryMaterialFile' in faultInputs) ||
    wrapper.kind !==
      'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence'
  ) throw invalidUsage()
  const boundaryWrapperBytes = await readStageCommitCliPrivateBytes(
    faultInputs.boundaryMaterialFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  const persistedBoundaryMaterialEvidence =
    parseCanonicalStageCommitJson(boundaryWrapperBytes)
  const boundaryWrapper = readPersistedStageCommitMaterialWrapper(
    persistedBoundaryMaterialEvidence,
  )
  if (
    boundaryWrapper.kind !==
      'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence'
  ) throw authenticationFailed()
  const finalRateSegmentBytes = await readStageCommitCliPrivateBytes(
    faultInputs.finalRateSegmentFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
    dependencies,
    ownedBuffers,
  )
  try {
    const boundaryMaterial =
      verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        material: boundaryWrapper.material,
        selection,
        faultPlan,
        rateSegmentBytes: boundaryRateSegmentBytes,
        verificationKey: stageKey,
      })
    requirePersistedMaterialDigest(
      boundaryMaterial,
      boundaryWrapper.materialDigest,
    )
    const material =
      verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        material: wrapper.material,
        selection,
        faultPlan,
        boundaryMaterial,
        boundaryRateSegmentBytes,
        finalRateSegmentBytes,
        verificationKey: stageKey,
      })
    requirePersistedMaterialDigest(material, wrapper.materialDigest)
    return Object.freeze({
      reservation: material.stageReservation,
      claimedStageHead: material.claimedStageHead,
      leaseObservation: material.leaseAcquisitionObservation,
      leaseIdentityDigest: readStageCommitLeaseIdentityDigest(
        material.leaseAcquisitionObservation,
      ),
      authorizationInput: createFaultCompletionStageCommitAuthorizationInput(
        persistedMaterialEvidence,
        persistedBoundaryMaterialEvidence,
        faultPlan,
        boundaryRateSegmentBytes,
        finalRateSegmentBytes,
      ),
    })
  } catch {
    throw authenticationFailed()
  }
}

/** Creates the exact ordinary-success parent authorization material input. */
function createSuccessStageCommitAuthorizationInput(
  persistedMaterialEvidence: unknown,
): WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput {
  return Object.freeze({
    materialKind: 'success',
    persistedMaterialEvidence,
  })
}

/** Creates the exact stopped-boundary parent authorization material input. */
function createFaultBoundaryStageCommitAuthorizationInput(
  persistedMaterialEvidence: unknown,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan,
  boundaryRateSegmentBytes: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput {
  return Object.freeze({
    materialKind: 'fault-boundary',
    persistedMaterialEvidence,
    faultPlan,
    boundaryRateSegmentBytes,
  })
}

/** Creates the exact response-loss parent authorization material input. */
function createFaultCompletionStageCommitAuthorizationInput(
  persistedMaterialEvidence: unknown,
  persistedBoundaryMaterialEvidence: unknown,
  faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan,
  boundaryRateSegmentBytes: Uint8Array,
  finalRateSegmentBytes: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput {
  return Object.freeze({
    materialKind: 'fault-completion',
    persistedMaterialEvidence,
    persistedBoundaryMaterialEvidence,
    faultPlan,
    boundaryRateSegmentBytes,
    finalRateSegmentBytes,
  })
}

/** Reauthenticates parent-persisted lifecycle and material under both keys. */
async function authenticateStageCommitParentAuthorization(
  configuration: WorkspaceSearchMigrationRehearsalStageCommitCliArguments,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  materialInput:
    WorkspaceSearchMigrationRehearsalStageMaterialAuthenticationInput,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<WorkspaceSearchMigrationRehearsalStageParentAuthorization> {
  const lifecycleBytes = await readStageCommitCliPrivateBytes(
    configuration.lifecycleEvidenceFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_LIFECYCLE_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  const parentAuthenticationBytes = await readStageCommitCliPrivateBytes(
    configuration.parentAuthenticationFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  const persistedLifecycleEvidence =
    parseCanonicalStageCommitJson(lifecycleBytes)
  const parentAuthentication =
    parseCanonicalStageCommitJson(parentAuthenticationBytes)
  try {
    return authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization({
      ...materialInput,
      selection,
      persistedLifecycleEvidence,
      parentAuthentication,
      runtimeAuthenticationKey: new Uint8Array(runtimeKey),
      publicationAuthenticationKey: new Uint8Array(publicationKey),
    })
  } catch {
    throw authenticationFailed()
  }
}

/** Reads the exact abandonment subset required by the current receipt. */
async function readStageCommitReservationAbandonments(
  configuration: WorkspaceSearchMigrationRehearsalStageCommitCliArguments,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<readonly unknown[]> {
  const previousCount =
    previousReceipt?.stageReservationAbandonmentCount ?? 0
  const expectedLength =
    receipt.stageReservationAbandonmentCount - previousCount
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 0 ||
    expectedLength > 36
  ) throw authenticationFailed()
  const path = configuration.reservationAbandonmentsFile
  if (expectedLength === 0) {
    if (path !== undefined) throw invalidUsage()
    return Object.freeze([])
  }
  if (path === undefined) throw invalidUsage()
  const bytes = await readStageCommitCliPrivateBytes(
    path,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_ABANDONMENTS_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  const candidate = parseCanonicalStageCommitJson(bytes)
  if (
    !Array.isArray(candidate) ||
    nodeUtilTypes.isProxy(candidate) ||
    candidate.length !== expectedLength ||
    Object.getOwnPropertySymbols(candidate).length !== 0 ||
    Object.getOwnPropertyNames(candidate).length !== expectedLength + 1
  ) throw authenticationFailed()
  const pairs: unknown[] = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      candidate,
      String(index),
    )
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) throw authenticationFailed()
    pairs.push(descriptor.value)
  }
  return Object.freeze(pairs)
}

/** Strictly reads one canonical parent-persisted material wrapper. */
function readPersistedStageCommitMaterialWrapper(
  value: unknown,
): PersistedStageMaterialWrapper {
  const record = stageCommitCliGuards.requireRecord(value)
  stageCommitCliGuards.requireExactKeys(record, persistedMaterialWrapperKeys)
  const kind = stageCommitCliGuards.readOwn(record, 'kind')
  if (
    kind !==
      'mukuroji-workspace-search-migration-rehearsal-child-material-evidence' &&
    kind !==
      'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence' &&
    kind !==
      'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence'
  ) throw authenticationFailed()
  if (stageCommitCliGuards.readOwn(record, 'evidenceVersion') !== 1) {
    throw authenticationFailed()
  }
  const observedAt = stageCommitCliGuards.readOwn(record, 'observedAt')
  if (!isCanonicalTimestamp(observedAt)) throw authenticationFailed()
  return Object.freeze({
    kind,
    material: stageCommitCliGuards.readOwn(record, 'material'),
    materialDigest: stageCommitCliGuards.readDigest(
      stageCommitCliGuards.readOwn(record, 'materialDigest'),
    ),
    observedAt,
  })
}

/** Reads and verifies one canonical reviewed fault plan. */
async function readStageCommitFaultPlan(
  path: string,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageCommitCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<WorkspaceSearchMigrationRehearsalFaultPlan> {
  const bytes = await readStageCommitCliPrivateBytes(
    path,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_FAULT_PLAN_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  const value = parseCanonicalStageCommitJson(bytes)
  try {
    const plan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(value)
    if (
      selection.entry.faultPlanDigest === null ||
      createMigrationDigest(plan) !== selection.entry.faultPlanDigest
    ) throw authenticationFailed()
    return plan
  } catch {
    throw authenticationFailed()
  }
}

/** Requires one wrapper digest to equal its verified nested material. */
function requirePersistedMaterialDigest(
  material: unknown,
  expectedDigest: string,
): void {
  if (!isHexDigest(expectedDigest) ||
    createMigrationDigest(material) !== expectedDigest) {
    throw authenticationFailed()
  }
}

/** Requires receipt, reservation, selection, and claimed revision equality. */
function requireStageCommitReceiptMatchesMaterial(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  material: AuthenticatedStageCommitMaterial,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
): void {
  requireReceiptMatchesManifestEntry(
    receipt,
    selection.entry,
    selection.manifest,
    selection.manifestDigest,
  )
  const claimedStageHead = material.claimedStageHead
  if (
    receipt.previousStageReceiptDigest !==
      selection.previousStageReceiptDigest ||
    receipt.stageReservationDigest !== createMigrationDigest(reservation) ||
    receipt.manifestDigest !== reservation.manifestDigest ||
    receipt.manifestEntryDigest !== reservation.manifestEntryDigest ||
    receipt.stageOrdinal !== reservation.stageOrdinal ||
    receipt.scenario !== reservation.scenario ||
    receipt.scenarioStageOrdinal !== reservation.scenarioStageOrdinal ||
    receipt.command !== reservation.command ||
    receipt.attemptOrdinal !== reservation.attemptOrdinal ||
    receipt.outcome !== reservation.expectedOutcome ||
    receipt.controlArgumentsDigest !== reservation.controlArgumentsDigest ||
    receipt.permitDigest !== reservation.permitDigest ||
    receipt.commit !== reservation.commit ||
    receipt.requestedResourcesBinding !==
      reservation.requestedResourcesBinding ||
    receipt.configurationBindingDigest !==
      reservation.configurationBindingDigest ||
    receipt.policyVersion !== reservation.policyVersion ||
    receipt.leaseIdentityDigest !== material.leaseIdentityDigest ||
    createMigrationDigest(receipt.leaseObservation) !==
      createMigrationDigest(material.leaseObservation) ||
    claimedStageHead.activeReservationDigest !==
      receipt.stageReservationDigest ||
    claimedStageHead.activeStageOrdinal !== receipt.stageOrdinal ||
    claimedStageHead.revision !== receipt.stageReservationClaimRevision ||
    receipt.stageReservationCommitRevision !==
      claimedStageHead.revision + 1
  ) throw authenticationFailed()
}

/** Creates one live clock while recording the exact last canonical sample. */
function createRecordingStageCommitClock(
  now: () => Date,
): RecordingStageCommitClock {
  let lastObservedMilliseconds: number | undefined
  let exclusiveFloorMilliseconds: number | undefined
  return Object.freeze({
    clock: (): Date => {
      let candidate: unknown
      try {
        candidate = now()
      } catch {
        throw authenticationFailed()
      }
      if (
        !(candidate instanceof Date) ||
        !Number.isFinite(candidate.getTime())
      ) throw authenticationFailed()
      const observedAt = candidate.toISOString()
      if (!isCanonicalTimestamp(observedAt)) throw authenticationFailed()
      const observedMilliseconds = candidate.getTime()
      if (
        (exclusiveFloorMilliseconds !== undefined &&
          observedMilliseconds <= exclusiveFloorMilliseconds) ||
        (lastObservedMilliseconds !== undefined &&
          observedMilliseconds < lastObservedMilliseconds)
      ) throw authenticationFailed()
      lastObservedMilliseconds = observedMilliseconds
      return new Date(observedMilliseconds)
    },
    resetObservedAt: (): void => {
      lastObservedMilliseconds = undefined
    },
    setExclusiveFloor: (floor): void => {
      if (
        exclusiveFloorMilliseconds !== undefined ||
        !isCanonicalTimestamp(floor)
      ) throw authenticationFailed()
      exclusiveFloorMilliseconds = Date.parse(floor)
    },
  })
}

/** Classifies every error into one stable raw-value-free result. */
function classifyStageCommitCliFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalStageCommitCliFailure {
  if (error instanceof WorkspaceSearchMigrationRehearsalStageCommitCliFailure) {
    return error
  }
  return commitFailed()
}

/** Emits one fixed canonical failure line without reflecting raw values. */
function writeStageCommitCliFailureLine(
  writer: (line: string) => void,
  code: WorkspaceSearchMigrationRehearsalStageCommitCliFailureCode,
): void {
  try {
    writer(serializeCanonicalJson({
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_CLI_RESULT_KIND,
      status: 'failed',
      code,
    }))
  } catch {
    // The requested operation has already failed and output remains bounded.
  }
}

/**
 * Rejects every currently existing output inode without following symlinks.
 *
 * @param outputPath - Exact normalized final evidence path.
 * @returns Resolution only while the final component is absent.
 */
export async function ensureStageCommitEvidenceOutputAbsent(
  outputPath: string,
): Promise<void> {
  try {
    await lstat(outputPath)
  } catch (error: unknown) {
    if (isStageCommitFileSystemErrorCode(error, 'ENOENT')) return
    throw outputWriteFailed()
  }
  throw outputExists()
}

/**
 * Publishes committed evidence or reconciles an exact secure existing file.
 *
 * @param outputPath - Exact normalized final evidence path.
 * @param evidenceBytes - Exact canonical committed evidence bytes.
 * @returns Created, exactly reconciled, or mismatched collision outcome.
 */
export async function writeStageCommitEvidenceFileExclusive(
  outputPath: string,
  evidenceBytes: Uint8Array,
): Promise<WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome> {
  const expected = copyStageCommitIntentBytes(evidenceBytes)
  try {
    const outcome =
      await writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        outputPath,
        expected,
      )
    if (outcome !== 'exists') return outcome
    const inspection = await inspectStageCommitEvidenceFile(
      resolveStageCommitCliPath(outputPath),
      expected,
      readStageCommitCurrentUserId(),
      Object.freeze([1n]),
    )
    return inspection.kind === 'match' ? 'reconciled' : 'exists'
  } finally {
    zeroizeStageCommitCliBytes(expected)
  }
}

/** Reads an optional stable owner-only commit intent without following links. */
async function readStageCommitEvidenceIntentFile(
  intentPath: string,
): Promise<Uint8Array | undefined> {
  try {
    await lstat(intentPath)
  } catch (error: unknown) {
    if (isStageCommitFileSystemErrorCode(error, 'ENOENT')) return undefined
    throw outputWriteFailed()
  }
  return await readWorkspaceSearchMigrationRehearsalPrivateInputFile(
    intentPath,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_MAX_BYTES,
  )
}

/** One stable secure-file inspection used by intent promotion. */
type StageCommitEvidenceFileInspection =
  | {
      /** Exact missing final component. */
      readonly kind: 'absent'
    }
  | {
      /** Exact expected bytes and secure inode metadata. */
      readonly kind: 'match'
      /** Filesystem device identity. */
      readonly device: bigint
      /** Filesystem inode identity. */
      readonly inode: bigint
      /** Current hard-link count. */
      readonly linkCount: bigint
    }
  | {
      /** Existing unsafe or byte-mismatched final component. */
      readonly kind: 'rejected'
    }

/**
 * Atomically hard-links one fsynced intent to its final no-replace name.
 *
 * The function reconciles a lost `link(2)` response, fsyncs the owner-only
 * directory after publication, removes only the verified same inode intent,
 * fsyncs again, and finally requires a single-link mode-0600 output.
 *
 * @param intentPath - Deterministic fsynced same-directory intent path.
 * @param outputPath - Final evidence path that must never be replaced.
 * @param evidenceBytes - Exact canonical authenticated evidence bytes.
 * @returns Created, reconciled, or collision outcome.
 */
export async function promoteStageCommitEvidenceIntentExclusive(
  intentPath: string,
  outputPath: string,
  evidenceBytes: Uint8Array,
): Promise<WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome> {
  const resolvedIntentPath = resolveStageCommitCliPath(intentPath)
  const resolvedOutputPath = resolveStageCommitCliPath(outputPath)
  if (
    resolvedIntentPath === resolvedOutputPath ||
    dirname(resolvedIntentPath) !== dirname(resolvedOutputPath)
  ) throw outputWriteFailed()
  const expected = copyStageCommitIntentBytes(evidenceBytes)
  const currentUserId = readStageCommitCurrentUserId()
  const noFollow = readStageCommitFileSystemFlag(constants.O_NOFOLLOW)
  const directoryFlag = readStageCommitFileSystemFlag(constants.O_DIRECTORY)
  const directory = await open(
    dirname(resolvedOutputPath),
    constants.O_RDONLY | noFollow | directoryFlag,
  )
  try {
    const directoryBefore = await directory.stat({ bigint: true })
    if (
      !directoryBefore.isDirectory() ||
      directoryBefore.uid !== BigInt(currentUserId) ||
      (directoryBefore.mode & 0o077n) !== 0n
    ) throw outputWriteFailed()
    let intent = await inspectStageCommitEvidenceFile(
      resolvedIntentPath,
      expected,
      currentUserId,
      Object.freeze([1n, 2n]),
    )
    let output = await inspectStageCommitEvidenceFile(
      resolvedOutputPath,
      expected,
      currentUserId,
      Object.freeze([1n, 2n]),
    )
    let outcome: WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome =
      'created'
    if (output.kind === 'match') {
      if (intent.kind === 'absent' && output.linkCount === 1n) {
        return 'reconciled'
      }
      if (
        intent.kind !== 'match' ||
        !sameStageCommitEvidenceInode(intent, output) ||
        intent.linkCount !== 2n ||
        output.linkCount !== 2n
      ) return 'exists'
      outcome = 'reconciled'
    } else if (output.kind === 'rejected' || intent.kind !== 'match' ||
      intent.linkCount !== 1n) {
      return output.kind === 'rejected' ? 'exists' : failOutputPromotion()
    } else {
      try {
        await link(resolvedIntentPath, resolvedOutputPath)
      } catch {
        // The following exact inode comparison reconciles a lost response.
      }
      intent = await inspectStageCommitEvidenceFile(
        resolvedIntentPath,
        expected,
        currentUserId,
        Object.freeze([2n]),
      )
      output = await inspectStageCommitEvidenceFile(
        resolvedOutputPath,
        expected,
        currentUserId,
        Object.freeze([2n]),
      )
      if (
        intent.kind !== 'match' ||
        output.kind !== 'match' ||
        !sameStageCommitEvidenceInode(intent, output)
      ) throw outputWriteFailed()
    }
    await directory.sync()
    try {
      await unlink(resolvedIntentPath)
    } catch {
      const after = await inspectStageCommitEvidenceFile(
        resolvedIntentPath,
        expected,
        currentUserId,
        Object.freeze([1n, 2n]),
      )
      if (after.kind !== 'absent') throw outputWriteFailed()
    }
    await directory.sync()
    const final = await inspectStageCommitEvidenceFile(
      resolvedOutputPath,
      expected,
      currentUserId,
      Object.freeze([1n]),
    )
    const directoryAfter = await directory.stat({ bigint: true })
    if (
      final.kind !== 'match' ||
      directoryAfter.dev !== directoryBefore.dev ||
      directoryAfter.ino !== directoryBefore.ino ||
      directoryAfter.uid !== directoryBefore.uid ||
      directoryAfter.mode !== directoryBefore.mode
    ) throw outputWriteFailed()
    return outcome
  } finally {
    zeroizeStageCommitCliBytes(expected)
    try {
      await directory.close()
    } catch {
      // Directory durability was established before close was attempted.
    }
  }
}

/** Inspects one exact file through a no-follow descriptor and stable metadata. */
async function inspectStageCommitEvidenceFile(
  path: string,
  expected: Uint8Array,
  currentUserId: number,
  acceptedLinkCounts: readonly bigint[],
): Promise<StageCommitEvidenceFileInspection> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  let observed: Uint8Array | undefined
  try {
    try {
      file = await open(
        path,
        constants.O_RDONLY |
          constants.O_NONBLOCK |
          readStageCommitFileSystemFlag(constants.O_NOFOLLOW),
      )
    } catch (error: unknown) {
      return isStageCommitFileSystemErrorCode(error, 'ENOENT')
        ? Object.freeze({ kind: 'absent' })
        : Object.freeze({ kind: 'rejected' })
    }
    const before = await file.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.uid !== BigInt(currentUserId) ||
      (before.mode & 0o7777n) !== 0o600n ||
      before.size !== BigInt(expected.byteLength) ||
      !acceptedLinkCounts.includes(before.nlink)
    ) return Object.freeze({ kind: 'rejected' })
    observed = new Uint8Array(await file.readFile())
    const after = await file.stat({ bigint: true })
    if (
      !equalStageCommitEvidenceBytes(observed, expected) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.size !== after.size ||
      before.nlink !== after.nlink
    ) return Object.freeze({ kind: 'rejected' })
    return Object.freeze({
      kind: 'match',
      device: before.dev,
      inode: before.ino,
      linkCount: before.nlink,
    })
  } catch {
    return Object.freeze({ kind: 'rejected' })
  } finally {
    zeroizeStageCommitCliBytes(observed)
    if (file !== undefined) {
      try {
        await file.close()
      } catch {
        // A close failure makes no secret data observable to the caller.
      }
    }
  }
}

/** Compares two ordinary owned byte vectors without string conversion. */
function equalStageCommitEvidenceBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

/** Checks whether two successful inspections identify the same inode. */
function sameStageCommitEvidenceInode(
  left: Extract<StageCommitEvidenceFileInspection, { readonly kind: 'match' }>,
  right: Extract<StageCommitEvidenceFileInspection, { readonly kind: 'match' }>,
): boolean {
  return left.device === right.device && left.inode === right.inode
}

/** Reads the exact effective process user identifier. */
function readStageCommitCurrentUserId(): number {
  const value = process.getuid?.()
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) throw outputWriteFailed()
  return value
}

/** Reads one required positive native filesystem flag. */
function readStageCommitFileSystemFlag(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) throw outputWriteFailed()
  return value
}

/** Converts one impossible non-collision promotion state into a stable error. */
function failOutputPromotion(): never {
  throw outputWriteFailed()
}

/** Reads one own raw filesystem error code without invoking accessors. */
function isStageCommitFileSystemErrorCode(
  error: unknown,
  expected: string,
): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) return false
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value === expected
}

/** Best-effort overwrite for every private owned input and key buffer. */
function zeroizeStageCommitCliBytes(value: Uint8Array | undefined): void {
  if (value === undefined) return
  try {
    value.fill(0)
  } catch {
    // The buffer was already detached or otherwise inaccessible.
  }
}

/** Creates one invalid-usage failure. */
function invalidUsage(): WorkspaceSearchMigrationRehearsalStageCommitCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageCommitCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Creates one invalid private-input failure. */
function inputInvalid(): WorkspaceSearchMigrationRehearsalStageCommitCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageCommitCliFailure(
    'INPUT_FILE_INVALID',
    1,
  )
}

/** Creates one unreadable private-input failure. */
function inputUnreadable(): WorkspaceSearchMigrationRehearsalStageCommitCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageCommitCliFailure(
    'INPUT_FILE_UNREADABLE',
    1,
  )
}

/** Creates one authentication or exact-binding failure. */
function authenticationFailed(): never {
  throw new WorkspaceSearchMigrationRehearsalStageCommitCliFailure(
    'AUTHENTICATION_FAILED',
    1,
  )
}

/** Creates one remote commit failure. */
function commitFailed(): WorkspaceSearchMigrationRehearsalStageCommitCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageCommitCliFailure(
    'COMMIT_FAILED',
    1,
  )
}

/** Creates one exclusive output collision failure. */
function outputExists(): WorkspaceSearchMigrationRehearsalStageCommitCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageCommitCliFailure(
    'OUTPUT_FILE_EXISTS',
    1,
  )
}

/** Creates one durable output publication failure. */
function outputWriteFailed(): WorkspaceSearchMigrationRehearsalStageCommitCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageCommitCliFailure(
    'OUTPUT_FILE_WRITE_FAILED',
    1,
  )
}

if (import.meta.main) {
  void runWorkspaceSearchMigrationRehearsalStageCommitCli(
    Bun.argv.slice(2),
    defaultStageCommitCliDependencies,
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
