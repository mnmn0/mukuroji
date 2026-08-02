import { createHash, timingSafeEqual } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, open, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  snapshotWorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultPlan,
} from './migration-rehearsal-faults'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES,
} from './migration-rehearsal-reconciliation-audit'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
} from './migration-rehearsal-key-derivation'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
  WorkspaceSearchMigrationRehearsalPrivateInputError,
} from './migration-rehearsal-private-input'
import {
  finalizeWorkspaceSearchMigrationRehearsalStageReceipt,
  WorkspaceSearchMigrationRehearsalStageFinalizerError,
  type FinalizeWorkspaceSearchMigrationRehearsalStageReceiptInput,
  type WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageFinalizationProof,
} from './migration-rehearsal-stage-finalizer'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES,
} from './migration-rehearsal-stage-child-material'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES,
} from './migration-rehearsal-stage-fault-material'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
} from './migration-rehearsal-rate-evidence'
import {
  selectWorkspaceSearchMigrationRehearsalStage,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
  WorkspaceSearchMigrationRehearsalStageReceiptError,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
} from './migration-rehearsal-target-audit'

/** Exact operator approval required for one offline stage finalization. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_APPROVAL =
  'finalize-reviewed-non-production-migration-rehearsal-stage-receipt'

/** Stable discriminator for secret-free finalizer CLI result lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-finalization-result'

/** Maximum private bytes accepted for one persisted lifecycle wrapper. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_LIFECYCLE_MAX_BYTES =
  256 * 1_024

/** Maximum private bytes accepted for one parent-authentication document. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_MAX_BYTES =
  64 * 1_024

/** Maximum canonical bytes accepted for one reviewed control argument vector. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CONTROL_ARGUMENTS_MAX_BYTES =
  8 * 1_024 * 1_024

/** Exact byte length required for every finalizer authentication key. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_KEY_BYTES = 32

/** No additional raw proof files for planning, release, or happy-path apply. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerNoProofFiles = {
  /** Selects the empty proof-file suffix. */
  readonly kind: 'none'
}

/** Files selecting ordinary or takeover-completed child material. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerSuccessMaterialFiles = {
  /** Selects one successful child-material wrapper. */
  readonly materialKind: 'success'
  /** Exact private persisted child-material wrapper path. */
  readonly materialFile: string
}

/** Files selecting one stopped SIGKILL fault-boundary protocol. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerFaultBoundaryMaterialFiles = {
  /** Selects one authenticated stopped-fault boundary. */
  readonly materialKind: 'fault-boundary'
  /** Exact private persisted boundary-material wrapper path. */
  readonly materialFile: string
  /** Exact private canonical reviewed fault-plan path. */
  readonly faultPlanFile: string
  /** Exact private durable boundary rate-segment path. */
  readonly boundaryRateSegmentFile: string
}

/** Files selecting the complete two-phase response-loss protocol. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerFaultCompletionMaterialFiles = {
  /** Selects one authenticated response-loss completion. */
  readonly materialKind: 'fault-completion'
  /** Exact private persisted completion-material wrapper path. */
  readonly materialFile: string
  /** Exact private persisted first boundary-material wrapper path. */
  readonly boundaryMaterialFile: string
  /** Exact private canonical reviewed fault-plan path. */
  readonly faultPlanFile: string
  /** Exact private durable boundary rate-segment path. */
  readonly boundaryRateSegmentFile: string
  /** Exact private durable reconciled final rate-segment path. */
  readonly finalRateSegmentFile: string
}

/** Strict material-file protocol admitted by the ordered command. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerMaterialFiles =
  | WorkspaceSearchMigrationRehearsalStageFinalizerFaultBoundaryMaterialFiles
  | WorkspaceSearchMigrationRehearsalStageFinalizerFaultCompletionMaterialFiles
  | WorkspaceSearchMigrationRehearsalStageFinalizerSuccessMaterialFiles

/** Raw target preimage material required by complete-rollback apply. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerApplyProofFiles = {
  /** Selects complete-rollback apply proof files. */
  readonly kind: 'complete-apply'
  /** Exact private canonical pre-apply target audit path. */
  readonly targetPreimageAuditFile: string
  /** Exact private raw target-audit authentication key path. */
  readonly targetAuditKeyFile: string
}

/** Historical planning receipt needed without integrity or target audits. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerPlanningReceiptProofFiles = {
  /** Selects the planning-receipt-only proof suffix. */
  readonly kind: 'planning-receipt'
  /** Exact private authenticated planning receipt path. */
  readonly planningReceiptFile: string
}

/** Actual authenticated artifact required by every terminal finalization. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerTerminalProofFiles = {
  /** Selects actual-artifact-first terminal proof files. */
  readonly kind: 'terminal'
  /** Exact private authenticated planning receipt path. */
  readonly planningReceiptFile: string
  /** Exact canonical dual-key-authenticated reconciliation artifact path. */
  readonly reconciliationArtifactFile: string
}

/** Strict proof-file suffix admitted by the ordered finalizer command. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerProofFiles =
  | WorkspaceSearchMigrationRehearsalStageFinalizerApplyProofFiles
  | WorkspaceSearchMigrationRehearsalStageFinalizerNoProofFiles
  | WorkspaceSearchMigrationRehearsalStageFinalizerPlanningReceiptProofFiles
  | WorkspaceSearchMigrationRehearsalStageFinalizerTerminalProofFiles

/** Strictly parsed ordered offline stage-finalizer command. */
type WorkspaceSearchMigrationRehearsalStageFinalizerCliArgumentsBase = {
  /** Exact private authenticated manifest path. */
  readonly manifestFile: string
  /** Exact private previous-receipt path containing a receipt or canonical null. */
  readonly previousReceiptFile: string
  /** Exact private persisted lifecycle wrapper path. */
  readonly lifecycleFile: string
  /** Exact private parent-origin authentication record path. */
  readonly parentAuthenticationFile: string
  /** Exact private raw stage master-key path. */
  readonly stageKeyFile: string
  /** Exact private canonical reviewed control argument vector path. */
  readonly controlArgumentsFile: string
  /** Strict command-dependent raw proof-file suffix. */
  readonly proofFiles: WorkspaceSearchMigrationRehearsalStageFinalizerProofFiles
  /** New final receipt path that must not contain different data. */
  readonly outputFile: string
  /** Exact offline finalization acknowledgement. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_APPROVAL
}

/** Strictly parsed ordered offline stage-finalizer command. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerCliArguments =
  WorkspaceSearchMigrationRehearsalStageFinalizerCliArgumentsBase &
    WorkspaceSearchMigrationRehearsalStageFinalizerMaterialFiles

/** Proof-file shape derived only from an authenticated selected stage. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement =
  | 'complete-apply'
  | 'planning-receipt'
  | 'none'
  | 'terminal'

/** Result of one durable no-replace receipt publication attempt. */
export type WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome =
  | 'created'
  | 'exists'
  | 'reconciled'

/** Minimal stable identity for one opened receipt publication inode. */
export type WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity = {
  /** Device containing the opened inode. */
  readonly device: bigint
  /** Inode identifier within the device. */
  readonly inode: bigint
  /** Exact byte size. */
  readonly size: bigint
  /** Complete native mode. */
  readonly mode: bigint
  /** Owning user identifier. */
  readonly userId: bigint
  /** Owning group identifier. */
  readonly groupId: bigint
  /** Current hard-link count. */
  readonly linkCount: bigint
  /** Nanosecond content-modification time. */
  readonly modifiedAtNanoseconds: bigint
  /** Nanosecond metadata-change time. */
  readonly changedAtNanoseconds: bigint
}

/** Minimal no-follow readable file used by receipt reconciliation. */
export type WorkspaceSearchMigrationRehearsalStageReceiptReadableFile = {
  /** Captures exact native descriptor metadata. */
  readonly stat: () => Promise<BigIntStats>
  /** Reads at most the requested bytes at one exact position. */
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<number>
  /** Closes the opened descriptor. */
  readonly close: () => Promise<void>
}

/** Minimal exclusive private temporary file used by receipt publication. */
export type WorkspaceSearchMigrationRehearsalStageReceiptTemporaryFile = {
  /** Forces exact private permissions. */
  readonly chmod: (mode: number) => Promise<void>
  /** Captures exact native descriptor metadata. */
  readonly stat: () => Promise<BigIntStats>
  /** Writes the complete exact receipt bytes. */
  readonly write: (bytes: Uint8Array) => Promise<void>
  /** Flushes file data and metadata durably. */
  readonly sync: () => Promise<void>
  /** Closes the temporary descriptor. */
  readonly close: () => Promise<void>
}

/** Opened owner-only containing directory used for durable publication. */
export type WorkspaceSearchMigrationRehearsalStageReceiptDirectory = {
  /** Captures exact native descriptor metadata. */
  readonly stat: () => Promise<BigIntStats>
  /** Flushes directory entry changes durably. */
  readonly sync: () => Promise<void>
  /** Closes the directory descriptor. */
  readonly close: () => Promise<void>
}

/** Injectable finite filesystem boundary for receipt publication. */
export type WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies = {
  /** Opens one path read-only without following its final component. */
  readonly openReadableFileNoFollow: (
    path: string,
  ) => Promise<WorkspaceSearchMigrationRehearsalStageReceiptReadableFile>
  /** Exclusively creates one no-follow same-directory temporary file. */
  readonly createTemporaryFile: (
    path: string,
  ) => Promise<WorkspaceSearchMigrationRehearsalStageReceiptTemporaryFile>
  /** Atomically creates the final hard link without replacing it. */
  readonly linkFile: (
    temporaryPath: string,
    finalPath: string,
  ) => Promise<void>
  /** Removes one exact temporary directory entry. */
  readonly unlinkFile: (path: string) => Promise<void>
  /** Opens the containing directory without following its final component. */
  readonly openDirectoryNoFollow: (
    path: string,
  ) => Promise<WorkspaceSearchMigrationRehearsalStageReceiptDirectory>
  /** Returns the effective current process user identifier. */
  readonly currentUserId: () => number
}

/** Injectable finite I/O and cryptographic boundary for the finalizer CLI. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies = {
  /** Reads one stable private single-link input through an exact byte ceiling. */
  readonly readPrivateInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one exact private single-link raw 32-byte key. */
  readonly readKeyFile: (path: string) => Promise<Uint8Array>
  /** Authenticates the manifest, predecessor, and reviewed arguments. */
  readonly selectStage:
    typeof selectWorkspaceSearchMigrationRehearsalStage
  /** Derives and signs one exact stage receipt from authenticated inputs. */
  readonly finalizeStageReceipt:
    typeof finalizeWorkspaceSearchMigrationRehearsalStageReceipt
  /** Publishes one canonical receipt durably without replacement. */
  readonly writeReceiptFileExclusive: (
    outputPath: string,
    receiptBytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome>
  /** Emits one already canonical secret-free success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Emits one already canonical secret-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable process statuses returned by the finalizer CLI. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerCliExitCode =
  | 0
  | 1
  | 2

/** Stable raw-value-free finalizer CLI failure classifications. */
export type WorkspaceSearchMigrationRehearsalStageFinalizerCliFailureCode =
  | 'FINALIZATION_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INVALID_PROOF'
  | 'INVALID_STAGE_KEY'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'
  | 'UNSUPPORTED_STAGE'

/** Private stable finalizer CLI failure containing no raw values. */
class WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure extends Error {
  /** Stable machine-readable failure classification. */
  readonly code:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliFailureCode

  /** Exact process status paired with the classification. */
  readonly exitCode:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliExitCode

  /**
   * Creates one raw-value-free finalizer CLI failure.
   *
   * @param code - Stable failure classification.
   * @param exitCode - Exact process status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalStageFinalizerCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalStageFinalizerCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Exact owner-only mode required for every finalizer input and output. */
const privateFileMode = 0o600

/** Exact owner-only mode required for the containing evidence directory. */
const privateDirectoryMode = 0o700

/** Maximum accepted path length at local filesystem boundaries. */
const maximumPathLength = 4_096

/** Maximum number of strict CLI arguments. */
const maximumCliArgumentCount = 64

/** Default production filesystem boundary for receipt publication. */
export const workspaceSearchMigrationRehearsalStageReceiptNodePublicationDependencies:
  WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies =
    Object.freeze({
      openReadableFileNoFollow:
        openWorkspaceSearchMigrationRehearsalStageReceiptReadableFile,
      createTemporaryFile:
        createWorkspaceSearchMigrationRehearsalStageReceiptTemporaryFile,
      linkFile: async (temporaryPath, finalPath): Promise<void> => {
        await link(temporaryPath, finalPath)
      },
      unlinkFile: async (path): Promise<void> => {
        await unlink(path)
      },
      openDirectoryNoFollow:
        openWorkspaceSearchMigrationRehearsalStageReceiptDirectory,
      currentUserId: readWorkspaceSearchMigrationRehearsalCurrentUserId,
    })

/** Default production dependencies for the offline finalizer CLI. */
const defaultStageFinalizerCliDependencies:
  WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies =
    Object.freeze({
      readPrivateInputFile:
        readWorkspaceSearchMigrationRehearsalPrivateInputFile,
      readKeyFile:
        readWorkspaceSearchMigrationRehearsalStageFinalizerKeyFile,
      selectStage: selectWorkspaceSearchMigrationRehearsalStage,
      finalizeStageReceipt:
        finalizeWorkspaceSearchMigrationRehearsalStageReceipt,
      writeReceiptFileExclusive:
        writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive,
      writeStdoutLine: (line: string): void => {
        console.log(line)
      },
      writeStderrLine: (line: string): void => {
        console.error(line)
      },
    })

/**
 * Parses only one of the exact ordered finalizer command forms.
 *
 * The proof suffix contains raw file paths only. Receipt claims, locators,
 * writer fences, evidence digests, and reconciliation counters have no CLI
 * representation and therefore cannot be supplied by an operator.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Frozen detached strict file selection and approval.
 */
export function parseWorkspaceSearchMigrationRehearsalStageFinalizerCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalStageFinalizerCliArguments {
  const snapshot = snapshotStageFinalizerCliArguments(arguments_)
  if (
    snapshot[0] !== '--manifest-file' ||
    snapshot[2] !== '--previous-receipt-file' ||
    snapshot[4] !== '--material-file'
  ) throw invalidUsage()
  const materialFiles = parseStageFinalizerMaterialFilePrefix(snapshot)
  const commonOffset = materialFiles.nextOffset
  if (
    snapshot[commonOffset] !== '--lifecycle-file' ||
    snapshot[commonOffset + 2] !== '--parent-authentication-file' ||
    snapshot[commonOffset + 4] !== '--stage-key-file' ||
    snapshot[commonOffset + 6] !== '--control-arguments-file'
  ) throw invalidUsage()
  const suffix = snapshot.slice(commonOffset + 8)
  const proofFiles = parseStageFinalizerProofFileSuffix(suffix)
  const outputOffset = stageFinalizerProofArgumentLength(proofFiles)
  if (
    suffix[outputOffset] !== '--output-file' ||
    suffix[outputOffset + 2] !== '--approval' ||
    suffix[outputOffset + 3] !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_APPROVAL ||
    suffix.length !== outputOffset + 4
  ) throw invalidUsage()
  const configuration = Object.freeze({
    manifestFile: requireStageFinalizerCliPath(snapshot[1]),
    previousReceiptFile: requireStageFinalizerCliPath(snapshot[3]),
    ...materialFiles.files,
    lifecycleFile:
      requireStageFinalizerCliPath(snapshot[commonOffset + 1]),
    parentAuthenticationFile:
      requireStageFinalizerCliPath(snapshot[commonOffset + 3]),
    stageKeyFile:
      requireStageFinalizerCliPath(snapshot[commonOffset + 5]),
    controlArgumentsFile:
      requireStageFinalizerCliPath(snapshot[commonOffset + 7]),
    proofFiles,
    outputFile: requireStageFinalizerCliPath(suffix[outputOffset + 1]),
    approval:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_APPROVAL,
  })
  requireDistinctStageFinalizerCliPaths(configuration)
  return configuration
}

/** Parsed strict material prefix plus the next common-flag position. */
type ParsedStageFinalizerMaterialFilePrefix = {
  /** Exact selected material-file protocol. */
  readonly files: WorkspaceSearchMigrationRehearsalStageFinalizerMaterialFiles
  /** Zero-based lifecycle flag position following the protocol. */
  readonly nextOffset: number
}

/** Parses one of the three exact ordered material-file prefixes. */
function parseStageFinalizerMaterialFilePrefix(
  snapshot: readonly string[],
): ParsedStageFinalizerMaterialFilePrefix {
  const materialFile = requireStageFinalizerCliPath(snapshot[5])
  if (snapshot[6] === '--lifecycle-file') {
    return Object.freeze({
      files: Object.freeze({ materialKind: 'success', materialFile }),
      nextOffset: 6,
    })
  }
  if (
    snapshot[6] === '--fault-plan-file' &&
    snapshot[8] === '--boundary-rate-segment-file'
  ) {
    return Object.freeze({
      files: Object.freeze({
        materialKind: 'fault-boundary',
        materialFile,
        faultPlanFile: requireStageFinalizerCliPath(snapshot[7]),
        boundaryRateSegmentFile:
          requireStageFinalizerCliPath(snapshot[9]),
      }),
      nextOffset: 10,
    })
  }
  if (
    snapshot[6] === '--boundary-material-file' &&
    snapshot[8] === '--fault-plan-file' &&
    snapshot[10] === '--boundary-rate-segment-file' &&
    snapshot[12] === '--final-rate-segment-file'
  ) {
    return Object.freeze({
      files: Object.freeze({
        materialKind: 'fault-completion',
        materialFile,
        boundaryMaterialFile:
          requireStageFinalizerCliPath(snapshot[7]),
        faultPlanFile: requireStageFinalizerCliPath(snapshot[9]),
        boundaryRateSegmentFile:
          requireStageFinalizerCliPath(snapshot[11]),
        finalRateSegmentFile:
          requireStageFinalizerCliPath(snapshot[13]),
      }),
      nextOffset: 14,
    })
  }
  throw invalidUsage()
}

/**
 * Derives the only proof-file shape accepted for one authenticated stage.
 *
 * @param selection - Main-key-authenticated generic-success selection.
 * @returns Exact proof-file requirement determined by scenario and command.
 */
export function determineWorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
): WorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement {
  if (
    selection.entry.command === 'verify' ||
    selection.entry.command === 'rollback-complete' ||
    selection.entry.command === 'rollback-partial'
  ) {
    return 'terminal'
  }
  if (
    selection.entry.command === 'apply' &&
    selection.entry.expectedOutcome === 'takeover-completed'
  ) return 'planning-receipt'
  if (
    selection.entry.command === 'apply' &&
    (selection.entry.scenario === 'complete-apply-rollback' ||
      selection.entry.scenario === 'partial-apply-rollback')
  ) return 'complete-apply'
  return 'none'
}

/** Parsed and loaded successful material protocol before authenticated selection. */
type ReadStageFinalizerSuccessMaterialInput = {
  /** Selects ordinary or takeover-completed material. */
  readonly materialKind: 'success'
  /** Exact parsed persisted child-material wrapper. */
  readonly persistedMaterialEvidence: unknown
  /** Success material selects no reviewed fault plan. */
  readonly faultPlanDigest: null
}

/** Parsed and loaded stopped-fault material protocol. */
type ReadStageFinalizerFaultBoundaryMaterialInput = {
  /** Selects one stopped SIGKILL boundary. */
  readonly materialKind: 'fault-boundary'
  /** Exact parsed persisted boundary-material wrapper. */
  readonly persistedMaterialEvidence: unknown
  /** Exact normalized reviewed fault plan. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Digest of the exact normalized reviewed fault plan. */
  readonly faultPlanDigest: string
  /** Exact durable boundary rate-segment bytes. */
  readonly boundaryRateSegmentBytes: Uint8Array
}

/** Parsed and loaded response-loss completion material protocol. */
type ReadStageFinalizerFaultCompletionMaterialInput = {
  /** Selects one two-phase response-loss completion. */
  readonly materialKind: 'fault-completion'
  /** Exact parsed persisted completion-material wrapper. */
  readonly persistedMaterialEvidence: unknown
  /** Exact parsed persisted first boundary-material wrapper. */
  readonly persistedBoundaryMaterialEvidence: unknown
  /** Exact normalized reviewed fault plan. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Digest of the exact normalized reviewed fault plan. */
  readonly faultPlanDigest: string
  /** Exact durable boundary rate-segment bytes. */
  readonly boundaryRateSegmentBytes: Uint8Array
  /** Exact durable reconciled final rate-segment bytes. */
  readonly finalRateSegmentBytes: Uint8Array
}

/** Every loaded material protocol used for selection and finalization. */
type ReadStageFinalizerMaterialInput =
  | ReadStageFinalizerFaultBoundaryMaterialInput
  | ReadStageFinalizerFaultCompletionMaterialInput
  | ReadStageFinalizerSuccessMaterialInput

/** Reads the exact configured material protocol and derives its plan digest. */
async function readStageFinalizerMaterialInput(
  configuration: WorkspaceSearchMigrationRehearsalStageFinalizerCliArguments,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<ReadStageFinalizerMaterialInput> {
  const materialMaximumBytes = configuration.materialKind === 'success'
    ? WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CHILD_MATERIAL_MAX_BYTES * 2
    : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES * 2
  const persistedMaterialEvidence =
    await readCanonicalStageFinalizerDocument(
      configuration.materialFile,
      materialMaximumBytes,
      dependencies,
      ownedBuffers,
    )
  if (configuration.materialKind === 'success') {
    return Object.freeze({
      materialKind: 'success',
      persistedMaterialEvidence,
      faultPlanDigest: null,
    })
  }
  const faultPlanValue = await readCanonicalStageFinalizerDocument(
    configuration.faultPlanFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  let faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  try {
    faultPlan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
      faultPlanValue,
    )
  } catch {
    throw inputInvalid()
  }
  const faultPlanDigest = createMigrationDigest(faultPlan)
  const boundaryRateSegmentBytes = await readStageFinalizerRawFile(
    configuration.boundaryRateSegmentFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
    dependencies,
    ownedBuffers,
  )
  if (configuration.materialKind === 'fault-boundary') {
    return Object.freeze({
      materialKind: 'fault-boundary',
      persistedMaterialEvidence,
      faultPlan,
      faultPlanDigest,
      boundaryRateSegmentBytes,
    })
  }
  const persistedBoundaryMaterialEvidence =
    await readCanonicalStageFinalizerDocument(
      configuration.boundaryMaterialFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FAULT_MATERIAL_MAX_BYTES * 2,
      dependencies,
      ownedBuffers,
    )
  const finalRateSegmentBytes = await readStageFinalizerRawFile(
    configuration.finalRateSegmentFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
    dependencies,
    ownedBuffers,
  )
  return Object.freeze({
    materialKind: 'fault-completion',
    persistedMaterialEvidence,
    persistedBoundaryMaterialEvidence,
    faultPlan,
    faultPlanDigest,
    boundaryRateSegmentBytes,
    finalRateSegmentBytes,
  })
}

/** Requires the selected manifest outcome to match the strict material arm. */
function requireStageFinalizerMaterialMatchesSelection(
  material: ReadStageFinalizerMaterialInput,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
): void {
  const expectedKind = selection.entry.expectedOutcome === 'fault-reached'
    ? 'fault-boundary'
    : selection.entry.expectedOutcome === 'response-loss-reconciled'
    ? 'fault-completion'
    : 'success'
  if (
    material.materialKind !== expectedKind ||
    selection.entry.faultPlanDigest !== material.faultPlanDigest
  ) throw unsupportedStage()
}

/** Calls the finalizer with the exact loaded material union arm. */
function finalizeStageFinalizerMaterialInput(
  material: ReadStageFinalizerMaterialInput,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: unknown,
  controlArguments: readonly string[],
  persistedLifecycleEvidence: unknown,
  parentAuthentication: unknown,
  proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof,
  runtimeAuthenticationKey: Uint8Array,
  publicationAuthenticationKey: Uint8Array,
  finalizeStageReceipt:
    typeof finalizeWorkspaceSearchMigrationRehearsalStageReceipt,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const common = {
    selection,
    previousReceipt,
    controlArguments,
    persistedLifecycleEvidence,
    parentAuthentication,
    proof,
    runtimeAuthenticationKey,
    publicationAuthenticationKey,
  }
  if (material.materialKind === 'success') {
    return finalizeStageReceipt({
      ...common,
      materialKind: 'success',
      persistedMaterialEvidence: material.persistedMaterialEvidence,
    })
  }
  if (material.materialKind === 'fault-boundary') {
    return finalizeStageReceipt({
      ...common,
      materialKind: 'fault-boundary',
      persistedMaterialEvidence: material.persistedMaterialEvidence,
      faultPlan: material.faultPlan,
      boundaryRateSegmentBytes: material.boundaryRateSegmentBytes,
    })
  }
  return finalizeStageReceipt({
    ...common,
    materialKind: 'fault-completion',
    persistedMaterialEvidence: material.persistedMaterialEvidence,
    persistedBoundaryMaterialEvidence:
      material.persistedBoundaryMaterialEvidence,
    faultPlan: material.faultPlan,
    boundaryRateSegmentBytes: material.boundaryRateSegmentBytes,
    finalRateSegmentBytes: material.finalRateSegmentBytes,
  })
}

/**
 * Runs one strict offline generic-success stage finalization.
 *
 * Every file input is read through an owner-only mode-0600 no-follow reader.
 * Every key buffer owned by the reader, CLI, proof, or finalizer is overwritten
 * on success and failure. The receipt is emitted only through durable
 * no-replace publication, and stdout contains only its secret-free digest.
 *
 * @param arguments_ - Exact ordered operator command.
 * @param dependencies - Injectable finite filesystem and finalizer boundary.
 * @returns Stable process status.
 */
export async function runWorkspaceSearchMigrationRehearsalStageFinalizerCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies =
      defaultStageFinalizerCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalStageFinalizerCliExitCode> {
  let writeStdoutLine = defaultStageFinalizerCliDependencies.writeStdoutLine
  let writeStderrLine = defaultStageFinalizerCliDependencies.writeStderrLine
  const ownedBuffers: Uint8Array[] = []
  try {
    const capturedDependencies = snapshotStageFinalizerCliDependencies(
      dependencies,
    )
    writeStdoutLine = capturedDependencies.writeStdoutLine
    writeStderrLine = capturedDependencies.writeStderrLine
    const configuration =
      parseWorkspaceSearchMigrationRehearsalStageFinalizerCliArguments(
        arguments_,
      )
    const manifest = await readCanonicalStageFinalizerDocument(
      configuration.manifestFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
      capturedDependencies,
      ownedBuffers,
    )
    const previousReceipt = await readCanonicalStageFinalizerDocument(
      configuration.previousReceiptFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
      capturedDependencies,
      ownedBuffers,
    )
    const controlArgumentsValue = await readCanonicalStageFinalizerDocument(
      configuration.controlArgumentsFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_CONTROL_ARGUMENTS_MAX_BYTES,
      capturedDependencies,
      ownedBuffers,
    )
    const controlArguments = readStageFinalizerControlArguments(
      controlArgumentsValue,
    )
    const stageMasterKey = await readStageFinalizerKey(
      configuration.stageKeyFile,
      capturedDependencies,
      ownedBuffers,
      invalidStageKey,
    )
    const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(
      stageMasterKey,
    )
    const stageKey = derivedKeys.runtimeKey
    const publicationKey = derivedKeys.publicationKey
    ownedBuffers.push(stageKey, publicationKey)
    zeroizeStageFinalizerBytes(stageMasterKey)
    const selectionKey = copyStageFinalizerKey(stageKey)
    ownedBuffers.push(selectionKey)
    const materialInput = await readStageFinalizerMaterialInput(
      configuration,
      capturedDependencies,
      ownedBuffers,
    )
    let selection: WorkspaceSearchMigrationRehearsalSelectedStage
    try {
      selection = capturedDependencies.selectStage({
        manifest,
        verificationKey: selectionKey,
        previousReceipt,
        controlArguments,
        faultPlanDigest: materialInput.faultPlanDigest,
      })
    } catch {
      throw unsupportedStage()
    } finally {
      zeroizeStageFinalizerBytes(selectionKey)
    }
    requireStageFinalizerMaterialMatchesSelection(materialInput, selection)
    const requirement =
      determineWorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement(
        selection,
      )
    if (configuration.proofFiles.kind !== requirement) {
      throw invalidProof()
    }
    const persistedLifecycleEvidence =
      await readCanonicalStageFinalizerDocument(
        configuration.lifecycleFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_LIFECYCLE_MAX_BYTES,
        capturedDependencies,
        ownedBuffers,
      )
    const parentAuthentication =
      await readCanonicalStageFinalizerDocument(
        configuration.parentAuthenticationFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_MAX_BYTES,
        capturedDependencies,
        ownedBuffers,
      )
    const proof = await readStageFinalizerProof(
      configuration.proofFiles,
      selection,
      capturedDependencies,
      ownedBuffers,
    )
    let receipt: WorkspaceSearchMigrationRehearsalStageReceipt
    try {
      receipt = finalizeStageFinalizerMaterialInput(
        materialInput,
        selection,
        previousReceipt,
        controlArguments,
        persistedLifecycleEvidence,
        parentAuthentication,
        proof,
        stageKey,
        publicationKey,
        capturedDependencies.finalizeStageReceipt,
      )
    } catch {
      throw finalizationFailed()
    }
    const receiptBytes = new TextEncoder().encode(
      serializeCanonicalJson(receipt),
    )
    ownedBuffers.push(receiptBytes)
    if (
      receiptBytes.byteLength === 0 ||
      receiptBytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES
    ) throw operationFailed()
    let outcome: WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome
    try {
      outcome = await capturedDependencies.writeReceiptFileExclusive(
        configuration.outputFile,
        receiptBytes,
      )
    } catch {
      throw outputWriteFailed()
    }
    if (outcome === 'exists') throw outputExists()
    if (outcome !== 'created' && outcome !== 'reconciled') {
      throw outputWriteFailed()
    }
    const receiptDigest = createHash('sha256')
      .update(receiptBytes)
      .digest('hex')
    writeStdoutLine(serializeCanonicalJson({
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_RESULT_KIND,
      status: 'succeeded',
      receiptDigest,
    }))
    return 0
  } catch (error: unknown) {
    const failure = classifyStageFinalizerCliFailure(error)
    writeStageFinalizerCliFailureLine(writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    for (const buffer of ownedBuffers) zeroizeStageFinalizerBytes(buffer)
  }
}

/** Reads one proof-file suffix from its exact ordered flag profile. */
function parseStageFinalizerProofFileSuffix(
  suffix: readonly string[],
): WorkspaceSearchMigrationRehearsalStageFinalizerProofFiles {
  if (suffix.length === 4 && suffix[0] === '--output-file') {
    return Object.freeze({ kind: 'none' })
  }
  if (
    suffix.length === 8 &&
    suffix[0] === '--target-preimage-audit-file' &&
    suffix[2] === '--target-audit-key-file'
  ) {
    return Object.freeze({
      kind: 'complete-apply',
      targetPreimageAuditFile: requireStageFinalizerCliPath(suffix[1]),
      targetAuditKeyFile: requireStageFinalizerCliPath(suffix[3]),
    })
  }
  if (
    suffix.length === 6 &&
    suffix[0] === '--planning-receipt-file'
  ) {
    return Object.freeze({
      kind: 'planning-receipt',
      planningReceiptFile: requireStageFinalizerCliPath(suffix[1]),
    })
  }
  if (
    suffix.length === 8 &&
    suffix[0] === '--planning-receipt-file' &&
    suffix[2] === '--reconciliation-artifact-file'
  ) {
    return Object.freeze({
      kind: 'terminal',
      planningReceiptFile: requireStageFinalizerCliPath(suffix[1]),
      reconciliationArtifactFile:
        requireStageFinalizerCliPath(suffix[3]),
    })
  }
  throw invalidUsage()
}

/** Returns the count of proof-specific arguments preceding output flags. */
function stageFinalizerProofArgumentLength(
  proof: WorkspaceSearchMigrationRehearsalStageFinalizerProofFiles,
): 0 | 2 | 4 {
  if (proof.kind === 'none') return 0
  if (proof.kind === 'planning-receipt') return 2
  if (proof.kind === 'complete-apply') return 4
  return 4
}

/** Copies and bounds one exact runtime CLI argument vector. */
function snapshotStageFinalizerCliArguments(
  value: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length === 0 ||
    value.length > maximumCliArgumentCount
  ) throw invalidUsage()
  const snapshot: string[] = []
  for (const argument of value) {
    if (
      typeof argument !== 'string' ||
      argument.length === 0 ||
      argument.length > maximumPathLength ||
      argument.includes('\0')
    ) throw invalidUsage()
    snapshot.push(argument)
  }
  return Object.freeze(snapshot)
}

/** Requires one finite path and normalizes it for uniqueness checks. */
function requireStageFinalizerCliPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumPathLength ||
    value.includes('\0')
  ) throw invalidUsage()
  try {
    return resolve(value)
  } catch {
    throw invalidUsage()
  }
}

/** Rejects path aliasing between every input, key, proof, and output role. */
function requireDistinctStageFinalizerCliPaths(
  configuration: WorkspaceSearchMigrationRehearsalStageFinalizerCliArguments,
): void {
  const paths = [
    configuration.manifestFile,
    configuration.previousReceiptFile,
    configuration.materialFile,
    configuration.lifecycleFile,
    configuration.parentAuthenticationFile,
    configuration.stageKeyFile,
    configuration.controlArgumentsFile,
    configuration.outputFile,
  ]
  if (configuration.materialKind === 'fault-boundary') {
    paths.push(
      configuration.faultPlanFile,
      configuration.boundaryRateSegmentFile,
    )
  } else if (configuration.materialKind === 'fault-completion') {
    paths.push(
      configuration.boundaryMaterialFile,
      configuration.faultPlanFile,
      configuration.boundaryRateSegmentFile,
      configuration.finalRateSegmentFile,
    )
  }
  const proof = configuration.proofFiles
  if (proof.kind === 'complete-apply') {
    paths.push(proof.targetPreimageAuditFile, proof.targetAuditKeyFile)
  } else if (proof.kind === 'planning-receipt') {
    paths.push(proof.planningReceiptFile)
  } else if (proof.kind === 'terminal') {
    paths.push(
      proof.planningReceiptFile,
      proof.reconciliationArtifactFile,
    )
  }
  if (new Set(paths).size !== paths.length) throw invalidUsage()
}

/** Reads one canonical JSON document through the private input boundary. */
async function readCanonicalStageFinalizerDocument(
  path: string,
  maximumBytes: number,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies,
    'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<unknown> {
  const bytes = await readStageFinalizerRawFile(
    path,
    maximumBytes,
    dependencies,
    ownedBuffers,
  )
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsed: unknown = JSON.parse(text)
    const canonical = new TextEncoder().encode(serializeCanonicalJson(parsed))
    ownedBuffers.push(canonical)
    if (!equalStageFinalizerBytes(bytes, canonical)) {
      throw inputInvalid()
    }
    return parsed
  } catch (error: unknown) {
    if (
      error instanceof WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure
    ) throw error
    throw inputInvalid()
  }
}

/** Reads and detaches one exact bounded private raw file. */
async function readStageFinalizerRawFile(
  path: string,
  maximumBytes: number,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies,
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
    !(callerBytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(callerBytes) ||
    nodeUtilTypes.isSharedArrayBuffer(callerBytes.buffer) ||
    callerBytes.byteLength === 0 ||
    callerBytes.byteLength > maximumBytes
  ) {
    zeroizeStageFinalizerBytes(callerBytes)
    throw inputInvalid()
  }
  ownedBuffers.push(callerBytes)
  let detached: Uint8Array
  try {
    detached = new Uint8Array(callerBytes)
  } catch {
    throw inputInvalid()
  }
  ownedBuffers.push(detached)
  zeroizeStageFinalizerBytes(callerBytes)
  return detached
}

/** Reads one exact key and detaches it from the reader-owned buffer. */
async function readStageFinalizerKey(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies,
    'readKeyFile'
  >,
  ownedBuffers: Uint8Array[],
  fail: () => WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure,
): Promise<Uint8Array> {
  let callerKey: Uint8Array
  try {
    callerKey = await dependencies.readKeyFile(path)
  } catch {
    throw fail()
  }
  if (
    !(callerKey instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(callerKey) ||
    nodeUtilTypes.isSharedArrayBuffer(callerKey.buffer) ||
    callerKey.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_KEY_BYTES
  ) {
    zeroizeStageFinalizerBytes(callerKey)
    throw fail()
  }
  ownedBuffers.push(callerKey)
  let localKey: Uint8Array
  try {
    localKey = copyStageFinalizerKey(callerKey)
  } catch {
    throw fail()
  }
  ownedBuffers.push(localKey)
  zeroizeStageFinalizerBytes(callerKey)
  return localKey
}

/** Reads and freezes one exact bounded reviewed control argument vector. */
function readStageFinalizerControlArguments(
  value: unknown,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length === 0 ||
    value.length > 512
  ) throw inputInvalid()
  const snapshot: string[] = []
  for (const argument of value) {
    if (
      typeof argument !== 'string' ||
      argument.length === 0 ||
      argument.length > 8_192 ||
      argument.includes('\0')
    ) throw inputInvalid()
    snapshot.push(argument)
  }
  return Object.freeze(snapshot)
}

/** Reads the exact raw proof selected by the authenticated stage. */
async function readStageFinalizerProof(
  files: WorkspaceSearchMigrationRehearsalStageFinalizerProofFiles,
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies,
    'readKeyFile' | 'readPrivateInputFile'
  >,
  ownedBuffers: Uint8Array[],
): Promise<WorkspaceSearchMigrationRehearsalStageFinalizationProof> {
  if (files.kind === 'none') {
    if (selection.entry.command === 'close-replan') {
      return Object.freeze({ kind: 'planning' })
    }
    if (selection.entry.command === 'release') {
      return Object.freeze({ kind: 'release' })
    }
    if (
      selection.entry.command === 'apply'
    ) {
      return Object.freeze({
        kind: 'apply',
        planningReceipt: null,
        targetPreimageAudit: null,
      })
    }
    throw invalidProof()
  }
  if (files.kind === 'planning-receipt') {
    const planningReceipt = await readCanonicalStageFinalizerDocument(
      files.planningReceiptFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
      dependencies,
      ownedBuffers,
    )
    if (selection.entry.command === 'apply') {
      return Object.freeze({
        kind: 'apply',
        planningReceipt,
        targetPreimageAudit: null,
      })
    }
    throw invalidProof()
  }
  if (files.kind === 'complete-apply') {
    const artifactBytes = await readStageFinalizerRawFile(
      files.targetPreimageAuditFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES,
      dependencies,
      ownedBuffers,
    )
    const verificationKey = await readStageFinalizerKey(
      files.targetAuditKeyFile,
      dependencies,
      ownedBuffers,
      invalidProof,
    )
    return Object.freeze({
      kind: 'apply',
      planningReceipt: null,
      targetPreimageAudit: Object.freeze({ artifactBytes, verificationKey }),
    })
  }
  const planningReceipt = await readCanonicalStageFinalizerDocument(
    files.planningReceiptFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  if (
    files.kind !== 'terminal' ||
    (selection.entry.command !== 'verify' &&
    selection.entry.command !== 'rollback-complete' &&
    selection.entry.command !== 'rollback-partial')
  ) throw invalidProof()
  const reconciliationArtifactBytes = await readStageFinalizerRawFile(
    files.reconciliationArtifactFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  return Object.freeze({
    kind: 'terminal',
    planningReceipt,
    reconciliationArtifactBytes,
  })
}

/** Captures every injected CLI effect before the first file await. */
function snapshotStageFinalizerCliDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies,
): WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) throw operationFailed()
  let readPrivateInputFile:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies[
      'readPrivateInputFile'
    ]
  let readKeyFile:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies[
      'readKeyFile'
    ]
  let selectStage:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies[
      'selectStage'
    ]
  let finalizeStageReceipt:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies[
      'finalizeStageReceipt'
    ]
  let writeReceiptFileExclusive:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies[
      'writeReceiptFileExclusive'
    ]
  let writeStdoutLine:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies[
      'writeStdoutLine'
    ]
  let writeStderrLine:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies[
      'writeStderrLine'
    ]
  try {
    readPrivateInputFile = dependencies.readPrivateInputFile
    readKeyFile = dependencies.readKeyFile
    selectStage = dependencies.selectStage
    finalizeStageReceipt = dependencies.finalizeStageReceipt
    writeReceiptFileExclusive = dependencies.writeReceiptFileExclusive
    writeStdoutLine = dependencies.writeStdoutLine
    writeStderrLine = dependencies.writeStderrLine
  } catch {
    throw operationFailed()
  }
  if (
    !isDirectStageFinalizerCliFunction(readPrivateInputFile) ||
    !isDirectStageFinalizerCliFunction(readKeyFile) ||
    !isDirectStageFinalizerCliFunction(selectStage) ||
    !isDirectStageFinalizerCliFunction(finalizeStageReceipt) ||
    !isDirectStageFinalizerCliFunction(writeReceiptFileExclusive) ||
    !isDirectStageFinalizerCliFunction(writeStdoutLine) ||
    !isDirectStageFinalizerCliFunction(writeStderrLine)
  ) throw operationFailed()
  return Object.freeze({
    readPrivateInputFile: (path, maximumBytes) =>
      readPrivateInputFile(path, maximumBytes),
    readKeyFile: (path) => readKeyFile(path),
    selectStage: (input) => selectStage(input),
    finalizeStageReceipt: (
      input: FinalizeWorkspaceSearchMigrationRehearsalStageReceiptInput,
    ) => finalizeStageReceipt(input),
    writeReceiptFileExclusive: (outputPath, receiptBytes) =>
      writeReceiptFileExclusive(outputPath, receiptBytes),
    writeStdoutLine: (line) => writeStdoutLine(line),
    writeStderrLine: (line) => writeStderrLine(line),
  })
}

/** Checks one injected effect without permitting callable Proxy traps. */
function isDirectStageFinalizerCliFunction(
  value: unknown,
): value is (...arguments_: readonly never[]) => unknown {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/** Copies one exact key without sharing its backing memory. */
function copyStageFinalizerKey(value: Uint8Array): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_KEY_BYTES
  ) throw invalidStageKey()
  return new Uint8Array(value)
}

/** Compares equal-length byte strings without content-dependent early exit. */
function equalStageFinalizerBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** Best-effort overwrite of one ordinary non-shared byte buffer. */
function zeroizeStageFinalizerBytes(value: unknown): void {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer)
  ) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // Best effort only; exotic buffers are rejected at the input boundary.
  }
}

/** Classifies only stable public failures and hides every lower-level error. */
function classifyStageFinalizerCliFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  if (
    error instanceof WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure
  ) return error
  if (error instanceof WorkspaceSearchMigrationRehearsalPrivateInputError) {
    return error.code === 'PRIVATE_INPUT_UNREADABLE'
      ? inputUnreadable()
      : inputInvalid()
  }
  if (error instanceof WorkspaceSearchMigrationRehearsalStageFinalizerError) {
    return finalizationFailed()
  }
  if (error instanceof WorkspaceSearchMigrationRehearsalStageReceiptError) {
    return unsupportedStage()
  }
  return operationFailed()
}

/** Emits one canonical raw-value-free failure line without changing status. */
function writeStageFinalizerCliFailureLine(
  writer: (line: string) => void,
  code: WorkspaceSearchMigrationRehearsalStageFinalizerCliFailureCode,
): void {
  try {
    writer(serializeCanonicalJson({
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_RESULT_KIND,
      status: 'error',
      code,
    }))
  } catch {
    // A diagnostic writer failure never leaks or replaces the stable status.
  }
}

/** Creates one strict-command usage failure. */
function invalidUsage():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Creates one malformed or unsafe private-input failure. */
function inputInvalid():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'INPUT_FILE_INVALID',
    2,
  )
}

/** Creates one unreadable private-input failure. */
function inputUnreadable():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'INPUT_FILE_UNREADABLE',
    2,
  )
}

/** Creates one invalid main stage-key failure. */
function invalidStageKey():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'INVALID_STAGE_KEY',
    2,
  )
}

/** Creates one proof-profile or proof-file failure. */
function invalidProof():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'INVALID_PROOF',
    2,
  )
}

/** Creates one unsupported or unauthenticated selected-stage failure. */
function unsupportedStage():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'UNSUPPORTED_STAGE',
    2,
  )
}

/** Creates one authenticated finalization failure. */
function finalizationFailed():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'FINALIZATION_FAILED',
    1,
  )
}

/** Creates one durable output collision failure. */
function outputExists():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'OUTPUT_FILE_EXISTS',
    1,
  )
}

/** Creates one durable output publication failure. */
function outputWriteFailed():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'OUTPUT_FILE_WRITE_FAILED',
    1,
  )
}

/** Creates one unexpected stable operation failure. */
function operationFailed():
  WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageFinalizerCliFailure(
    'OPERATION_FAILED',
    1,
  )
}

/** Creates one internal raw-value-free key-reader failure. */
function keyBoundaryFailed(): Error {
  return new Error('INVALID_STAGE_KEY')
}

/** Creates one internal raw-value-free publication failure. */
function publicationBoundaryFailed(): Error {
  return new Error('OUTPUT_FILE_WRITE_FAILED')
}

/**
 * Reads one exact stable owner-only single-link raw finalizer key.
 *
 * The descriptor is opened with `O_NOFOLLOW`; mode, owner, hard-link count,
 * inode identity, exact size, timestamps, and close success are required to
 * remain stable. Internal read buffers are overwritten before return.
 *
 * @param path - Exact restricted raw key path.
 * @returns Fresh caller-owned exact 32-byte key.
 */
export async function readWorkspaceSearchMigrationRehearsalStageFinalizerKeyFile(
  path: string,
): Promise<Uint8Array> {
  const safePath = requirePublicationPath(path, keyBoundaryFailed)
  const currentUserId = readWorkspaceSearchMigrationRehearsalCurrentUserId()
  const noFollow = readPositiveFileSystemFlag(
    constants.O_NOFOLLOW,
    keyBoundaryFailed,
  )
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      safePath,
      constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
    )
  } catch {
    throw keyBoundaryFailed()
  }
  let working: Uint8Array | undefined
  let result: Uint8Array | undefined
  let failed = false
  try {
    const before = readStageReceiptFileIdentity(
      await handle.stat({ bigint: true }),
      currentUserId,
      BigInt(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_KEY_BYTES),
      1n,
    )
    working = Buffer.alloc(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_KEY_BYTES,
    )
    let offset = 0
    while (offset < working.byteLength) {
      const read = await handle.read(
        working,
        offset,
        working.byteLength - offset,
        offset,
      )
      if (read.bytesRead <= 0) throw keyBoundaryFailed()
      offset += read.bytesRead
    }
    const after = readStageReceiptFileIdentity(
      await handle.stat({ bigint: true }),
      currentUserId,
      BigInt(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_KEY_BYTES),
      1n,
    )
    if (
      offset !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_KEY_BYTES ||
      !sameStageReceiptFileIdentity(before, after)
    ) throw keyBoundaryFailed()
    result = new Uint8Array(working)
  } catch {
    failed = true
  } finally {
    try {
      await handle.close()
    } catch {
      failed = true
    }
    zeroizeStageFinalizerBytes(working)
    if (failed) zeroizeStageFinalizerBytes(result)
  }
  if (failed || result === undefined) throw keyBoundaryFailed()
  return result
}

/** Matching secure inspection for one receipt publication path. */
type StageReceiptFileMatchInspection = {
  /** Selects a safe exact canonical content match. */
  readonly kind: 'match'
  /** Stable identity of the exact opened inode. */
  readonly identity:
    WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity
}

/** Absent receipt publication path inspection. */
type StageReceiptFileAbsentInspection = {
  /** Selects a path absent at the no-follow open boundary. */
  readonly kind: 'absent'
}

/** Unsafe or byte-different receipt publication path inspection. */
type StageReceiptFileRejectedInspection = {
  /** Selects an unsafe inode or different content. */
  readonly kind: 'mismatch' | 'unsafe'
}

/** Finite no-follow receipt path inspection result. */
type StageReceiptFileInspection =
  | StageReceiptFileAbsentInspection
  | StageReceiptFileMatchInspection
  | StageReceiptFileRejectedInspection

/**
 * Publishes one canonical receipt with durable atomic no-replace semantics.
 *
 * A deterministic same-directory mode-0600 temporary file is exclusively
 * created, fsynced, and independently reread before `link(2)` publishes the
 * final name. The owner-only containing directory is fsynced after the link
 * and again after temporary cleanup. Ambiguous successful link responses and
 * byte-identical prior outputs are reconciled. A final reread requires exactly
 * one hard link before success is returned.
 *
 * @param outputPath - New final receipt path.
 * @param receiptBytes - Exact canonical authenticated receipt bytes.
 * @param dependencies - Injectable finite no-follow filesystem boundary.
 * @returns Whether output was newly created, reconciled, or collided.
 */
export async function writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
  outputPath: string,
  receiptBytes: Uint8Array,
  dependencies:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies =
      workspaceSearchMigrationRehearsalStageReceiptNodePublicationDependencies,
): Promise<WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome> {
  let content: Uint8Array | undefined
  let directory:
    WorkspaceSearchMigrationRehearsalStageReceiptDirectory | undefined
  try {
    const finalPath = requirePublicationPath(
      outputPath,
      publicationBoundaryFailed,
    )
    content = copyCanonicalStageReceiptBytes(receiptBytes)
    const captured = snapshotStageReceiptPublicationDependencies(dependencies)
    const currentUserId = requireCurrentUserId(
      captured.currentUserId,
      publicationBoundaryFailed,
    )
    const directoryPath = dirname(finalPath)
    directory = await captured.openDirectoryNoFollow(directoryPath)
    const directoryIdentity = readStageReceiptDirectoryIdentity(
      await directory.stat(),
      currentUserId,
    )
    const temporaryPath = createStageReceiptTemporaryPath(
      directoryPath,
      finalPath,
      content,
    )
    let temporaryInspection = await createOrRecoverStageReceiptTemporaryFile({
      temporaryPath,
      finalPath,
      content,
      currentUserId,
      dependencies: captured,
    })
    let outcome: WorkspaceSearchMigrationRehearsalStageReceiptWriteOutcome =
      'created'
    let linkAlreadyObserved = false
    if (temporaryInspection.identity.linkCount === 2n) {
      const recoveredFinal = await inspectStageReceiptFile({
        path: finalPath,
        expectedBytes: content,
        expectedOwnerUserId: currentUserId,
        acceptedLinkCounts: Object.freeze([2n]),
        dependencies: captured,
      })
      if (
        recoveredFinal.kind !== 'match' ||
        !sameStageReceiptInode(
          temporaryInspection.identity,
          recoveredFinal.identity,
        )
      ) throw publicationBoundaryFailed()
      linkAlreadyObserved = true
      outcome = 'reconciled'
    }
    if (!linkAlreadyObserved) {
      try {
        await captured.linkFile(temporaryPath, finalPath)
      } catch (error: unknown) {
        const refreshedTemporaryInspection = await inspectStageReceiptFile({
          path: temporaryPath,
          expectedBytes: content,
          expectedOwnerUserId: currentUserId,
          acceptedLinkCounts: Object.freeze([1n, 2n]),
          dependencies: captured,
        })
        const finalInspection = await inspectStageReceiptFile({
          path: finalPath,
          expectedBytes: content,
          expectedOwnerUserId: currentUserId,
          acceptedLinkCounts: Object.freeze([1n, 2n]),
          dependencies: captured,
        })
        if (
          finalInspection.kind === 'match' &&
          refreshedTemporaryInspection.kind === 'match' &&
          refreshedTemporaryInspection.identity.linkCount === 2n &&
          sameStageReceiptInode(
            refreshedTemporaryInspection.identity,
            finalInspection.identity,
          )
        ) {
          outcome = 'reconciled'
        } else {
          await removeStageReceiptTemporaryFile({
            temporaryPath,
            finalPath,
            content,
            currentUserId,
            directory,
            dependencies: captured,
          })
          if (
            isFileSystemErrorCode(error, 'EEXIST') ||
            finalInspection.kind === 'match' ||
            finalInspection.kind === 'mismatch' ||
            finalInspection.kind === 'unsafe'
          ) return 'exists'
          throw publicationBoundaryFailed()
        }
      }
    }
    await directory.sync()
    await removeStageReceiptTemporaryFile({
      temporaryPath,
      finalPath,
      content,
      currentUserId,
      directory,
      dependencies: captured,
    })
    const finalInspection = await inspectStageReceiptFile({
      path: finalPath,
      expectedBytes: content,
      expectedOwnerUserId: currentUserId,
      acceptedLinkCounts: Object.freeze([1n]),
      dependencies: captured,
    })
    if (finalInspection.kind !== 'match') {
      throw publicationBoundaryFailed()
    }
    const finalDirectoryIdentity = readStageReceiptDirectoryIdentity(
      await directory.stat(),
      currentUserId,
    )
    if (!sameStageReceiptDirectoryIdentity(
      directoryIdentity,
      finalDirectoryIdentity,
    )) throw publicationBoundaryFailed()
    return outcome
  } catch {
    throw publicationBoundaryFailed()
  } finally {
    if (directory !== undefined) {
      try {
        await directory.close()
      } catch {
        // Publication durability was already established by directory fsync.
      }
    }
    zeroizeStageFinalizerBytes(content)
  }
}

/** Input for creating or recovering one deterministic temporary receipt file. */
type CreateOrRecoverStageReceiptTemporaryFileInput = {
  /** Deterministic same-directory temporary path. */
  readonly temporaryPath: string
  /** Exact final receipt path. */
  readonly finalPath: string
  /** Exact canonical receipt bytes. */
  readonly content: Uint8Array
  /** Required current owner user identifier. */
  readonly currentUserId: number
  /** Captured finite publication boundary. */
  readonly dependencies:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies
}

/** Creates or safely recovers one exact deterministic temporary file. */
async function createOrRecoverStageReceiptTemporaryFile(
  input: CreateOrRecoverStageReceiptTemporaryFileInput,
): Promise<StageReceiptFileMatchInspection> {
  try {
    const temporary = await input.dependencies.createTemporaryFile(
      input.temporaryPath,
    )
    await prepareStageReceiptTemporaryFile(
      temporary,
      input.content,
      input.currentUserId,
    )
  } catch (error: unknown) {
    if (!isFileSystemErrorCode(error, 'EEXIST')) {
      throw publicationBoundaryFailed()
    }
  }
  const inspection = await inspectStageReceiptFile({
    path: input.temporaryPath,
    expectedBytes: input.content,
    expectedOwnerUserId: input.currentUserId,
    acceptedLinkCounts: Object.freeze([1n, 2n]),
    dependencies: input.dependencies,
  })
  if (inspection.kind !== 'match') throw publicationBoundaryFailed()
  if (inspection.identity.linkCount === 2n) {
    const finalInspection = await inspectStageReceiptFile({
      path: input.finalPath,
      expectedBytes: input.content,
      expectedOwnerUserId: input.currentUserId,
      acceptedLinkCounts: Object.freeze([2n]),
      dependencies: input.dependencies,
    })
    if (
      finalInspection.kind !== 'match' ||
      !sameStageReceiptInode(inspection.identity, finalInspection.identity)
    ) throw publicationBoundaryFailed()
  }
  return inspection
}

/** Writes, fsyncs, closes, and validates one new private temporary inode. */
async function prepareStageReceiptTemporaryFile(
  temporary:
    WorkspaceSearchMigrationRehearsalStageReceiptTemporaryFile,
  content: Uint8Array,
  currentUserId: number,
): Promise<void> {
  let failed = false
  try {
    await temporary.chmod(privateFileMode)
    const before = readStageReceiptFileIdentity(
      await temporary.stat(),
      currentUserId,
      0n,
      1n,
    )
    await temporary.write(content)
    await temporary.sync()
    const after = readStageReceiptFileIdentity(
      await temporary.stat(),
      currentUserId,
      BigInt(content.byteLength),
      1n,
    )
    if (!sameStageReceiptWritableInode(before, after)) {
      throw publicationBoundaryFailed()
    }
  } catch {
    failed = true
  }
  try {
    await temporary.close()
  } catch {
    failed = true
  }
  if (failed) throw publicationBoundaryFailed()
}

/** Exact inspection input for one receipt or temporary publication path. */
type InspectStageReceiptFileInput = {
  /** Exact final component inspected without symlink following. */
  readonly path: string
  /** Exact canonical bytes required for a match. */
  readonly expectedBytes: Uint8Array
  /** Required current owner user identifier. */
  readonly expectedOwnerUserId: number
  /** Finite hard-link counts accepted in this publication phase. */
  readonly acceptedLinkCounts: readonly bigint[]
  /** Captured finite readable-file boundary. */
  readonly dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies,
    'openReadableFileNoFollow'
  >
}

/** Inspects one exact path with stable no-follow metadata and byte checks. */
async function inspectStageReceiptFile(
  input: InspectStageReceiptFileInput,
): Promise<StageReceiptFileInspection> {
  let file:
    WorkspaceSearchMigrationRehearsalStageReceiptReadableFile | undefined
  let observed: Uint8Array | undefined
  let result: StageReceiptFileInspection = Object.freeze({ kind: 'unsafe' })
  try {
    try {
      file = await input.dependencies.openReadableFileNoFollow(input.path)
    } catch (error: unknown) {
      return isFileSystemErrorCode(error, 'ENOENT')
        ? Object.freeze({ kind: 'absent' })
        : Object.freeze({ kind: 'unsafe' })
    }
    const before = readStageReceiptFileIdentityForCounts(
      await file.stat(),
      input.expectedOwnerUserId,
      BigInt(input.expectedBytes.byteLength),
      input.acceptedLinkCounts,
    )
    observed = await readStageReceiptOpenedFile(
      file,
      input.expectedBytes.byteLength,
    )
    const after = readStageReceiptFileIdentityForCounts(
      await file.stat(),
      input.expectedOwnerUserId,
      BigInt(input.expectedBytes.byteLength),
      input.acceptedLinkCounts,
    )
    if (!sameStageReceiptFileIdentity(before, after)) {
      return Object.freeze({ kind: 'unsafe' })
    }
    result = equalStageFinalizerBytes(observed, input.expectedBytes) &&
        isCanonicalStageReceiptBytes(observed)
      ? Object.freeze({ kind: 'match', identity: before })
      : Object.freeze({ kind: 'mismatch' })
  } catch {
    result = Object.freeze({ kind: 'unsafe' })
  } finally {
    if (file !== undefined) {
      try {
        await file.close()
      } catch {
        result = Object.freeze({ kind: 'unsafe' })
      }
    }
    zeroizeStageFinalizerBytes(observed)
  }
  return result
}

/** Input for verified durable removal of one deterministic temporary path. */
type RemoveStageReceiptTemporaryFileInput = {
  /** Exact deterministic temporary path. */
  readonly temporaryPath: string
  /** Exact final receipt path. */
  readonly finalPath: string
  /** Exact canonical expected bytes. */
  readonly content: Uint8Array
  /** Required current owner user identifier. */
  readonly currentUserId: number
  /** Already opened verified containing directory. */
  readonly directory:
    WorkspaceSearchMigrationRehearsalStageReceiptDirectory
  /** Captured finite publication boundary. */
  readonly dependencies:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies
}

/** Removes only a verified owned temporary entry and fsyncs its directory. */
async function removeStageReceiptTemporaryFile(
  input: RemoveStageReceiptTemporaryFileInput,
): Promise<void> {
  const temporary = await inspectStageReceiptFile({
    path: input.temporaryPath,
    expectedBytes: input.content,
    expectedOwnerUserId: input.currentUserId,
    acceptedLinkCounts: Object.freeze([1n, 2n]),
    dependencies: input.dependencies,
  })
  if (temporary.kind === 'absent') {
    await input.directory.sync()
    return
  }
  if (temporary.kind !== 'match') throw publicationBoundaryFailed()
  if (temporary.identity.linkCount === 2n) {
    const finalInspection = await inspectStageReceiptFile({
      path: input.finalPath,
      expectedBytes: input.content,
      expectedOwnerUserId: input.currentUserId,
      acceptedLinkCounts: Object.freeze([2n]),
      dependencies: input.dependencies,
    })
    if (
      finalInspection.kind !== 'match' ||
      !sameStageReceiptInode(
        temporary.identity,
        finalInspection.identity,
      )
    ) throw publicationBoundaryFailed()
  }
  try {
    await input.dependencies.unlinkFile(input.temporaryPath)
  } catch {
    const after = await inspectStageReceiptFile({
      path: input.temporaryPath,
      expectedBytes: input.content,
      expectedOwnerUserId: input.currentUserId,
      acceptedLinkCounts: Object.freeze([1n, 2n]),
      dependencies: input.dependencies,
    })
    if (after.kind !== 'absent') {
      throw publicationBoundaryFailed()
    }
  }
  await input.directory.sync()
}

/** Stable identity of one opened private containing directory. */
type StageReceiptDirectoryIdentity = {
  /** Device containing the directory inode. */
  readonly device: bigint
  /** Directory inode identifier. */
  readonly inode: bigint
  /** Complete native mode. */
  readonly mode: bigint
  /** Owning user identifier. */
  readonly userId: bigint
  /** Owning group identifier. */
  readonly groupId: bigint
}

/** Reads one exact secure regular-file identity with one link count. */
function readStageReceiptFileIdentity(
  status: BigIntStats,
  expectedUserId: number,
  expectedSize: bigint,
  expectedLinkCount: bigint,
): WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity {
  return readStageReceiptFileIdentityForCounts(
    status,
    expectedUserId,
    expectedSize,
    Object.freeze([expectedLinkCount]),
  )
}

/** Reads one exact secure regular-file identity for finite link counts. */
function readStageReceiptFileIdentityForCounts(
  status: BigIntStats,
  expectedUserId: number,
  expectedSize: bigint,
  acceptedLinkCounts: readonly bigint[],
): WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity {
  if (
    !status.isFile() ||
    status.size !== expectedSize ||
    (status.mode & 0o7777n) !== BigInt(privateFileMode) ||
    status.uid !== BigInt(expectedUserId) ||
    !acceptedLinkCounts.includes(status.nlink)
  ) throw publicationBoundaryFailed()
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    size: status.size,
    mode: status.mode,
    userId: status.uid,
    groupId: status.gid,
    linkCount: status.nlink,
    modifiedAtNanoseconds: status.mtimeNs,
    changedAtNanoseconds: status.ctimeNs,
  })
}

/** Requires every stable file identity field to remain unchanged. */
function sameStageReceiptFileIdentity(
  left: WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity,
  right: WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity,
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.userId === right.userId &&
    left.groupId === right.groupId &&
    left.linkCount === right.linkCount &&
    left.modifiedAtNanoseconds === right.modifiedAtNanoseconds &&
    left.changedAtNanoseconds === right.changedAtNanoseconds
}

/** Requires one writable inode to retain identity while its content changes. */
function sameStageReceiptWritableInode(
  before: WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity,
  after: WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity,
): boolean {
  return before.device === after.device &&
    before.inode === after.inode &&
    before.mode === after.mode &&
    before.userId === after.userId &&
    before.groupId === after.groupId &&
    before.linkCount === 1n &&
    after.linkCount === 1n
}

/** Checks whether two path inspections name the same exact inode. */
function sameStageReceiptInode(
  left: WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity,
  right: WorkspaceSearchMigrationRehearsalStageReceiptFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode
}

/** Reads one owner-only mode-0700 directory identity. */
function readStageReceiptDirectoryIdentity(
  status: BigIntStats,
  expectedUserId: number,
): StageReceiptDirectoryIdentity {
  if (
    !status.isDirectory() ||
    (status.mode & 0o7777n) !== BigInt(privateDirectoryMode) ||
    status.uid !== BigInt(expectedUserId)
  ) throw publicationBoundaryFailed()
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    mode: status.mode,
    userId: status.uid,
    groupId: status.gid,
  })
}

/** Requires the opened containing directory identity to stay unchanged. */
function sameStageReceiptDirectoryIdentity(
  left: StageReceiptDirectoryIdentity,
  right: StageReceiptDirectoryIdentity,
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.userId === right.userId &&
    left.groupId === right.groupId
}

/** Reads one already opened file through its exact expected size. */
async function readStageReceiptOpenedFile(
  file: WorkspaceSearchMigrationRehearsalStageReceiptReadableFile,
  expectedSize: number,
): Promise<Uint8Array> {
  const bytes = Buffer.alloc(expectedSize)
  let offset = 0
  while (offset < expectedSize) {
    const count = await file.read(
      bytes,
      offset,
      expectedSize - offset,
      offset,
    )
    if (!Number.isSafeInteger(count) || count <= 0) {
      zeroizeStageFinalizerBytes(bytes)
      throw publicationBoundaryFailed()
    }
    offset += count
  }
  return bytes
}

/** Copies and validates exact canonical bounded receipt bytes. */
function copyCanonicalStageReceiptBytes(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength === 0 ||
    value.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES
  ) throw publicationBoundaryFailed()
  let copy: Uint8Array | undefined
  try {
    copy = new Uint8Array(value)
    if (!isCanonicalStageReceiptBytes(copy)) {
      throw publicationBoundaryFailed()
    }
    return copy
  } catch {
    zeroizeStageFinalizerBytes(copy)
    throw publicationBoundaryFailed()
  }
}

/** Checks whether exact bytes are one compact canonical JSON document. */
function isCanonicalStageReceiptBytes(bytes: Uint8Array): boolean {
  let canonical: Uint8Array | undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsed: unknown = JSON.parse(text)
    canonical = new TextEncoder().encode(serializeCanonicalJson(parsed))
    return equalStageFinalizerBytes(bytes, canonical)
  } catch {
    return false
  } finally {
    zeroizeStageFinalizerBytes(canonical)
  }
}

/** Creates a deterministic same-directory temporary path for exact output. */
function createStageReceiptTemporaryPath(
  directoryPath: string,
  finalPath: string,
  content: Uint8Array,
): string {
  const digest = createHash('sha256')
    .update(
      'mukuroji-workspace-search-migration-rehearsal-stage-receipt-output/v1\0',
      'utf8',
    )
    .update(finalPath, 'utf8')
    .update('\0', 'utf8')
    .update(content)
    .digest('hex')
  return join(directoryPath, `.mukuroji-stage-receipt-${digest}.tmp`)
}

/** Captures every injected publication effect before filesystem mutation. */
function snapshotStageReceiptPublicationDependencies(
  dependencies:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies,
): WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) throw publicationBoundaryFailed()
  let openReadableFileNoFollow:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies[
      'openReadableFileNoFollow'
    ]
  let createTemporaryFile:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies[
      'createTemporaryFile'
    ]
  let linkFile:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies[
      'linkFile'
    ]
  let unlinkFile:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies[
      'unlinkFile'
    ]
  let openDirectoryNoFollow:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies[
      'openDirectoryNoFollow'
    ]
  let currentUserId:
    WorkspaceSearchMigrationRehearsalStageReceiptPublicationDependencies[
      'currentUserId'
    ]
  try {
    openReadableFileNoFollow = dependencies.openReadableFileNoFollow
    createTemporaryFile = dependencies.createTemporaryFile
    linkFile = dependencies.linkFile
    unlinkFile = dependencies.unlinkFile
    openDirectoryNoFollow = dependencies.openDirectoryNoFollow
    currentUserId = dependencies.currentUserId
  } catch {
    throw publicationBoundaryFailed()
  }
  if (
    !isDirectStageFinalizerCliFunction(openReadableFileNoFollow) ||
    !isDirectStageFinalizerCliFunction(createTemporaryFile) ||
    !isDirectStageFinalizerCliFunction(linkFile) ||
    !isDirectStageFinalizerCliFunction(unlinkFile) ||
    !isDirectStageFinalizerCliFunction(openDirectoryNoFollow) ||
    !isDirectStageFinalizerCliFunction(currentUserId)
  ) throw publicationBoundaryFailed()
  return Object.freeze({
    openReadableFileNoFollow: (path) => openReadableFileNoFollow(path),
    createTemporaryFile: (path) => createTemporaryFile(path),
    linkFile: (temporaryPath, finalPath) =>
      linkFile(temporaryPath, finalPath),
    unlinkFile: (path) => unlinkFile(path),
    openDirectoryNoFollow: (path) => openDirectoryNoFollow(path),
    currentUserId: () => currentUserId(),
  })
}

/** Opens one exact path read-only without following its final component. */
async function openWorkspaceSearchMigrationRehearsalStageReceiptReadableFile(
  path: string,
): Promise<WorkspaceSearchMigrationRehearsalStageReceiptReadableFile> {
  const noFollow = readPositiveFileSystemFlag(
    constants.O_NOFOLLOW,
    publicationBoundaryFailed,
  )
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
  )
  return Object.freeze({
    stat: () => handle.stat({ bigint: true }),
    read: async (
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): Promise<number> => {
      const result = await handle.read(buffer, offset, length, position)
      return result.bytesRead
    },
    close: async (): Promise<void> => {
      await handle.close()
    },
  })
}

/** Exclusively opens one no-follow mode-0600 temporary receipt file. */
async function createWorkspaceSearchMigrationRehearsalStageReceiptTemporaryFile(
  path: string,
): Promise<WorkspaceSearchMigrationRehearsalStageReceiptTemporaryFile> {
  const noFollow = readPositiveFileSystemFlag(
    constants.O_NOFOLLOW,
    publicationBoundaryFailed,
  )
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      noFollow,
    privateFileMode,
  )
  return Object.freeze({
    chmod: async (mode: number): Promise<void> => {
      await handle.chmod(mode)
    },
    stat: () => handle.stat({ bigint: true }),
    write: async (bytes: Uint8Array): Promise<void> => {
      await handle.writeFile(bytes)
    },
    sync: async (): Promise<void> => {
      await handle.sync()
    },
    close: async (): Promise<void> => {
      await handle.close()
    },
  })
}

/** Opens one owner-only directory without following its final component. */
async function openWorkspaceSearchMigrationRehearsalStageReceiptDirectory(
  path: string,
): Promise<WorkspaceSearchMigrationRehearsalStageReceiptDirectory> {
  const noFollow = readPositiveFileSystemFlag(
    constants.O_NOFOLLOW,
    publicationBoundaryFailed,
  )
  const directoryFlag = readPositiveFileSystemFlag(
    constants.O_DIRECTORY,
    publicationBoundaryFailed,
  )
  const handle = await open(
    path,
    constants.O_RDONLY | noFollow | directoryFlag,
  )
  return Object.freeze({
    stat: () => handle.stat({ bigint: true }),
    sync: async (): Promise<void> => {
      await handle.sync()
    },
    close: async (): Promise<void> => {
      await handle.close()
    },
  })
}

/** Reads a required positive finite native filesystem flag. */
function readPositiveFileSystemFlag(
  value: unknown,
  fail: () => Error,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) throw fail()
  return value
}

/** Reads the exact finite effective local process user identifier. */
function readWorkspaceSearchMigrationRehearsalCurrentUserId(): number {
  return requireCurrentUserId(process.getuid, publicationBoundaryFailed)
}

/** Invokes and validates one trusted current-user identifier reader. */
function requireCurrentUserId(
  reader: unknown,
  fail: () => Error,
): number {
  if (typeof reader !== 'function' || nodeUtilTypes.isProxy(reader)) {
    throw fail()
  }
  let value: unknown
  try {
    value = Reflect.apply(reader, process, [])
  } catch {
    throw fail()
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) throw fail()
  return value
}

/** Resolves one finite filesystem path without exposing it in failures. */
function requirePublicationPath(
  value: unknown,
  fail: () => Error,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumPathLength ||
    value.includes('\0')
  ) throw fail()
  try {
    return resolve(value)
  } catch {
    throw fail()
  }
}

/** Reads one raw Node filesystem error code without reflecting other values. */
function isFileSystemErrorCode(error: unknown, expected: string): boolean {
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

if (import.meta.main) {
  void runWorkspaceSearchMigrationRehearsalStageFinalizerCli(
    Bun.argv.slice(2),
    defaultStageFinalizerCliDependencies,
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
