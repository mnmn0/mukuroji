import { writeSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationControlCliDependencies,
  readBoundedInputFile,
  runWorkspaceSearchMigrationControlCli,
  type WorkspaceSearchMigrationControlCliDependencies,
  type WorkspaceSearchMigrationControlCliExitCode,
  type WorkspaceSearchMigrationControlCliMutationResultObservation,
  type WorkspaceSearchMigrationControlCliRateManagedSessionConstructor,
} from './migration-control-cli'
import {
  createAwsWorkspaceSearchMigrationNonProductionRehearsalSession,
  type CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
  type WorkspaceSearchMigrationNonProductionRehearsalAwsSession,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
} from './migration-identity'
import {
  parseWorkspaceSearchMigrationRehearsalFaultReceipt,
  snapshotWorkspaceSearchMigrationRehearsalFaultPlan,
  type CreateWorkspaceSearchMigrationRehearsalFaultControllerInput,
  type WorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
} from './migration-rehearsal-permit-cli'
import {
  createDefaultWorkspaceSearchMigrationRehearsalParentLivenessMonitor,
  type WorkspaceSearchMigrationRehearsalParentLivenessMonitor,
} from './migration-rehearsal-parent-liveness'
import type {
  WorkspaceSearchMigrationRehearsalRateCommittedSegment,
} from './migration-rehearsal-rate-evidence'
import type {
  WorkspaceSearchMigrationRehearsalExpectedAuthority,
} from './migration-rehearsal-reconciliation-aws'
import {
  createWorkspaceSearchMigrationRehearsalRateRuntime,
  type CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  type WorkspaceSearchMigrationRehearsalRateRuntime,
} from './migration-rehearsal-rate-runtime'
import {
  captureWorkspaceSearchMigrationRehearsalChildMutationObservation,
  createWorkspaceSearchMigrationRehearsalStageChildMaterial,
  type WorkspaceSearchMigrationRehearsalCapturedMutationObservation,
  type WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
import {
  createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  type WorkspaceSearchMigrationRehearsalFaultObservation,
  type WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
} from './migration-rehearsal-stage-fault-material'
import {
  parseWorkspaceSearchMigrationRehearsalStageManifestDocument,
  parseWorkspaceSearchMigrationRehearsalStageReceiptDocument,
  selectWorkspaceSearchMigrationRehearsalStage,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
} from './migration-rehearsal-stage-receipt'
import {
  parseWorkspaceSearchMigrationRehearsalStageReservationDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'

/** Maximum accepted UTF-8 bytes for one restricted rehearsal permit file. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_FILE_MAX_BYTES =
  64 * 1_024

/** Exact raw byte length of the dedicated rehearsal permit key. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KEY_BYTES = 32

/** Maximum canonical UTF-8 bytes for one optional rehearsal fault plan. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_PLAN_FILE_MAX_BYTES =
  64 * 1_024

/** Stable discriminator for one child-process fault receipt line. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_FAULT_RECEIPT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-fault-receipt'

/** Stable discriminator for the digest-bound parent response-loss ACK. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_KIND =
  'mukuroji-workspace-search-migration-rehearsal-response-loss-ack'

/** Fixed child file descriptor reserved for the fault-receipt protocol. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FD = 3

/** Maximum accepted UTF-8 bytes for one response-loss acknowledgement. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_MAX_BYTES =
  512

/** Stable discriminator for one rehearsal-wrapper failure line. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-control-result'

/** Stable discriminator for one successful no-fault child lifecycle receipt. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-no-fault-lifecycle-receipt'

/** Exact version marker enabling authenticated generic-success material. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION =
  'v1'

/** Private abort reason distinguishing parent disappearance from user signals. */
const parentLivenessAbortReason = Symbol(
  'workspace-search-migration-rehearsal-parent-liveness-lost',
)

/** Exact parent-supported no-fault rehearsal scenario labels. */
export type WorkspaceSearchMigrationRehearsalNoFaultScenario =
  | 'happy-path-verified'
  | 'complete-apply-rollback'

/** Scenario-bound terminal outcome admitted by the no-fault parent protocol. */
export type WorkspaceSearchMigrationRehearsalNoFaultOutcome =
  | {
    /** Uninterrupted verification scenario. */
    readonly scenario: 'happy-path-verified'
    /** Purpose preventing replay as rollback evidence. */
    readonly purpose: 'verified'
    /** Exact existing control command that must have succeeded. */
    readonly terminalCommand: 'verify'
    /** Authoritative terminal state required by the scenario. */
    readonly terminalKind: 'verified'
  }
  | {
    /** Complete-apply then complete-rollback scenario. */
    readonly scenario: 'complete-apply-rollback'
    /** Purpose preventing replay as verification evidence. */
    readonly purpose: 'complete-rollback'
    /** Exact existing control command that must have succeeded. */
    readonly terminalCommand: 'rollback-complete'
    /** Authoritative terminal state required by the scenario. */
    readonly terminalKind: 'rolled-back'
  }

/** Secret-free durable rate segment projection bound into no-fault success. */
export type WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt = {
  /** Domain-separated fingerprint of the segment authentication key. */
  readonly authenticationKeyFingerprint: string
  /** Opaque unique process-local segment locator. */
  readonly segmentLocatorDigest: string
  /** Strict zero-based process segment ordinal. */
  readonly segmentOrdinal: number
  /** Number of durable rate events in this segment. */
  readonly eventCount: number
  /** First global event sequence, or null for an empty segment. */
  readonly firstCommittedEventSequence: number | null
  /** Last global event sequence, or null for an empty segment. */
  readonly lastCommittedEventSequence: number | null
  /** Terminal authenticated record MAC. */
  readonly terminalRecordMac: string
  /** Digest of the exact complete durable segment prefix. */
  readonly segmentDigest: string
}

/** Canonical FD3 receipt emitted only after no-fault runtime cleanup succeeds. */
export type WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt =
  WorkspaceSearchMigrationRehearsalNoFaultOutcome & {
    /** Fixed no-fault lifecycle receipt discriminator. */
    readonly kind:
      typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_KIND
    /** First strict no-fault lifecycle receipt contract. */
    readonly lifecycleVersion: 1
    /** Digest of the exact canonical authenticated permit document. */
    readonly permitDigest: string
    /** Digest of the exact forwarded existing control argument vector. */
    readonly controlArgumentsDigest: string
    /** Binding of account, region, commit, and requested resources. */
    readonly requestedResourcesBinding: string
    /** Reviewed DescribeTable rate-policy digest used by the session. */
    readonly policyVersion: string
    /** Reviewed measured non-production configuration digest. */
    readonly configurationBindingDigest: string
    /** Confirmed durable segment metadata after runtime flush and close. */
    readonly rateSegment:
      WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt
  }

/** Strictly parsed dedicated rehearsal wrapper arguments. */
export type WorkspaceSearchMigrationRehearsalControlCliArguments = {
  /** Restricted authenticated permit document path. */
  readonly permitFile: string
  /** Restricted raw 32-byte permit-key path. */
  readonly permitKeyFile: string
  /** Fresh mode-0600 append-only rate-segment output path. */
  readonly rateSegmentFile: string
  /** Reviewed measured non-production configuration digest. */
  readonly rateConfigurationHash: string
  /** Optional read-only authenticated predecessor rate-segment path. */
  readonly ratePreviousSegmentFile?: string
  /** Optional reviewed canonical one-shot fault-plan path. */
  readonly faultPlanFile?: string
  /** Optional authenticated reviewed stage-manifest path. */
  readonly stageManifestFile?: string
  /** Optional authenticated immediate predecessor stage-receipt path. */
  readonly previousStageReceiptFile?: string
  /** Optional raw 32-byte stage-manifest and receipt key path. */
  readonly stageKeyFile?: string
  /** Parent-created authenticated durable stage-reservation path. */
  readonly stageReservationFile?: string
  /** Optional authenticated generic-success protocol version. */
  readonly successProtocol?:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION
  /** Optional explicit no-fault scenario requiring a completion receipt. */
  readonly noFaultScenario?: WorkspaceSearchMigrationRehearsalNoFaultScenario
  /** Existing control-CLI arguments following the exact separator. */
  readonly controlArguments: readonly string[]
}

/** One strict stderr envelope carrying only a validated secret-free receipt. */
export type WorkspaceSearchMigrationRehearsalControlFaultReceiptLine = {
  /** Fixed line discriminator used by the external parent harness. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_FAULT_RECEIPT_KIND
  /** Exact detached receipt accepted by the runtime receipt parser. */
  readonly receipt: WorkspaceSearchMigrationRehearsalFaultReceipt
}

/** One exact parent acknowledgement releasing synthetic response loss. */
export type WorkspaceSearchMigrationRehearsalResponseLossAcknowledgement = {
  /** Fixed acknowledgement discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_KIND
  /** Digest of the exact receipt durably persisted by the parent. */
  readonly receiptSha256: string
}

/**
 * Dedicated non-production session constructor injectable by unit tests.
 *
 * @param input - Production session input plus permit and optional fault.
 * @returns Fresh authenticated non-production managed session.
 */
export type WorkspaceSearchMigrationRehearsalSessionConstructor = (
  input: CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
) => Promise<WorkspaceSearchMigrationNonProductionRehearsalAwsSession>

/** Injectable side-effect boundary for one dedicated rehearsal CLI process. */
export type WorkspaceSearchMigrationRehearsalControlCliDependencies = {
  /** Reads one finite stable regular file through an inclusive byte ceiling. */
  readonly readInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one exact owner-only raw key through the secure no-follow reader. */
  readonly readPermitKeyFile: (path: string) => Promise<Uint8Array>
  /** Reads one exact owner-only stage key through the secure no-follow reader. */
  readonly readStageKeyFile?: (path: string) => Promise<Uint8Array>
  /** Constructs only the authenticated non-production rehearsal session. */
  readonly createRehearsalSession:
    WorkspaceSearchMigrationRehearsalSessionConstructor
  /** Creates one durable process-local actual-rate recorder runtime. */
  readonly createRateRuntime: (
    input: CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalRateRuntime>
  /** Trusted wall clock captured before the wrapper's first await. */
  readonly clock?: () => Date
  /** Executes the existing capability-minimized control CLI. */
  readonly runControlCli: (
    arguments_: readonly string[],
    dependencies: WorkspaceSearchMigrationControlCliDependencies,
    signal?: AbortSignal,
  ) => Promise<WorkspaceSearchMigrationControlCliExitCode>
  /** Writes one already canonical secret-free stderr line. */
  readonly writeStderrLine: (serializedLine: string) => void
  /** Writes one canonical receipt on the dedicated parent protocol channel. */
  readonly writeFaultReceiptLine: (serializedLine: string) => void
  /** Never resolves in production while the parent prepares SIGKILL. */
  readonly waitForParentKill: () => Promise<void>
  /** Waits for the parent's digest-bound durable-persistence acknowledgement. */
  readonly waitForParentResponseLossAcknowledgement: (
    receiptSha256: string,
    finalAcknowledgement?: boolean,
  ) => Promise<void>
}

/** Boundary state retained only across one response-loss reconciliation. */
type WorkspaceSearchMigrationRehearsalControlFaultBoundaryState = {
  /** Exact authenticated material emitted before synthetic response loss. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Exact durable rate-prefix bytes authenticated by the material. */
  readonly rateSegmentBytes: Uint8Array
}

/** Fresh authenticated stage claim shared by every child material phase. */
type WorkspaceSearchMigrationRehearsalControlClaimedStageContext = {
  /** Authenticated reservation passed to the non-production session. */
  readonly stageReservation:
    WorkspaceSearchMigrationRehearsalStageReservation
  /** Durable head returned immediately after the reservation CAS. */
  readonly claimedStageHead:
    WorkspaceSearchMigrationRehearsalStageHead
}

/** Authenticated fault callbacks plus response-loss boundary state. */
type WorkspaceSearchMigrationRehearsalControlFaultProtocol = {
  /** Exact fault-controller callbacks installed into the managed session. */
  readonly fault: CreateWorkspaceSearchMigrationRehearsalFaultControllerInput
  /** Reads the sole response-loss boundary after its first ACK. */
  readonly readResponseLossBoundary: () =>
    WorkspaceSearchMigrationRehearsalControlFaultBoundaryState | undefined
}

/** Stable wrapper failures that never include paths, permits, or AWS values. */
type WorkspaceSearchMigrationRehearsalControlCliFailureCode =
  | 'INTERRUPTED'
  | 'INVALID_FAULT_RECEIPT'
  | 'INVALID_REHEARSAL_INPUT'
  | 'INVALID_STAGE_SELECTION'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'
  | 'PARENT_CHANNEL_LOST'

/** Internal inputs for one strict no-fault completion receipt. */
type CreateRehearsalControlNoFaultReceiptInput = {
  /** Scenario-specific terminal contract. */
  readonly outcome: WorkspaceSearchMigrationRehearsalNoFaultOutcome
  /** Digest of the canonical permit document. */
  readonly permitDigest: string
  /** Digest of the exact forwarded control arguments. */
  readonly controlArgumentsDigest: string
  /** Bound account, region, commit, and requested resources. */
  readonly requestedResourcesBinding: string
  /** Reviewed rate-policy digest used by the session. */
  readonly policyVersion: string
  /** Reviewed measured non-production configuration digest. */
  readonly configurationBindingDigest: string
  /** Confirmed durable rate segment returned before runtime close. */
  readonly committedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
}

/** Stable internal wrapper failure with its exact process exit status. */
class WorkspaceSearchMigrationRehearsalControlCliFailure extends Error {
  /** Raw-value-free machine-readable classification. */
  readonly code: WorkspaceSearchMigrationRehearsalControlCliFailureCode

  /** Exact wrapper process exit status. */
  readonly exitCode: WorkspaceSearchMigrationControlCliExitCode

  /**
   * Creates one private raw-value-free wrapper failure.
   *
   * @param code - Stable failure classification.
   * @param exitCode - Exact process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalControlCliFailureCode,
    exitCode: WorkspaceSearchMigrationControlCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalControlCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Production-only monitor installed before the child reads any input. */
let defaultParentLivenessMonitor:
  WorkspaceSearchMigrationRehearsalParentLivenessMonitor | undefined

/** Rejects when the fixed parent-owned liveness descriptor is lost. */
async function rejectAfterDefaultParentLivenessLoss(): Promise<never> {
  const monitor = defaultParentLivenessMonitor
  if (monitor === undefined) throw parentChannelLost()
  await monitor.waitForLoss()
  throw parentChannelLost()
}

/** Keeps a hard-kill barrier pending only while the parent remains alive. */
async function waitForDefaultParentKill(): Promise<never> {
  return rejectAfterDefaultParentLivenessLoss()
}

/** Races one stdin acknowledgement against independent parent liveness. */
async function waitForDefaultParentResponseLossAcknowledgement(
  receiptSha256: string,
  finalAcknowledgement = true,
): Promise<void> {
  await Promise.race([
    waitForDefaultResponseLossAcknowledgement(
      receiptSha256,
      finalAcknowledgement,
    ),
    rejectAfterDefaultParentLivenessLoss(),
  ])
}

/** Default process effects used only by an explicitly executed child CLI. */
const defaultRehearsalControlCliDependencies:
  WorkspaceSearchMigrationRehearsalControlCliDependencies = Object.freeze({
    readInputFile: readBoundedInputFile,
    readPermitKeyFile: (path): Promise<Uint8Array> =>
      readWorkspaceSearchMigrationRehearsalPermitSigningKey(path),
    readStageKeyFile: (path): Promise<Uint8Array> =>
      readWorkspaceSearchMigrationRehearsalPermitSigningKey(path),
    createRehearsalSession:
      createAwsWorkspaceSearchMigrationNonProductionRehearsalSession,
    createRateRuntime: (input) =>
      createWorkspaceSearchMigrationRehearsalRateRuntime(input),
    clock: () => new Date(),
    runControlCli: runWorkspaceSearchMigrationControlCli,
    writeStderrLine: (serializedLine: string): void => {
      console.error(serializedLine)
    },
    writeFaultReceiptLine: (serializedLine: string): void => {
      writeSync(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FD,
        `${serializedLine}\n`,
      )
    },
    waitForParentKill: waitForDefaultParentKill,
    waitForParentResponseLossAcknowledgement:
      waitForDefaultParentResponseLossAcknowledgement,
  })

/**
 * Parses the strict dedicated preamble without resolving or logging paths.
 *
 * Accepted order is permit, key, rate output, reviewed configuration, optional
 * predecessor, optional fault plan, separator, then control-CLI arguments.
 *
 * @param arguments_ - Arguments following the child script path.
 * @returns Frozen detached preamble and existing control arguments.
 */
export function parseWorkspaceSearchMigrationRehearsalControlCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalControlCliArguments {
  const snapshot = snapshotRehearsalControlArguments(arguments_)
  if (
    snapshot[0] !== '--rehearsal-permit-file' ||
    snapshot[2] !== '--rehearsal-permit-key-file' ||
    snapshot[4] !== '--rehearsal-rate-segment-file' ||
    snapshot[6] !== '--rehearsal-rate-configuration-hash'
  ) {
    throw invalidRehearsalControlUsage()
  }
  const permitFile = requireRehearsalControlPath(snapshot[1])
  const permitKeyFile = requireRehearsalControlPath(snapshot[3])
  const rateSegmentFile = requireRehearsalControlPath(snapshot[5])
  const rateConfigurationHash = snapshot[7]
  if (!isHexDigest(rateConfigurationHash)) {
    throw invalidRehearsalControlUsage()
  }
  let cursor = 8
  let ratePreviousSegmentFile: string | undefined
  let faultPlanFile: string | undefined
  let stageManifestFile: string | undefined
  let previousStageReceiptFile: string | undefined
  let stageKeyFile: string | undefined
  let stageReservationFile: string | undefined
  let successProtocol:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION |
    undefined
  if (snapshot[cursor] === '--rehearsal-rate-previous-segment-file') {
    ratePreviousSegmentFile = requireRehearsalControlPath(
      snapshot[cursor + 1],
    )
    cursor += 2
  }
  if (snapshot[cursor] === '--rehearsal-stage-manifest-file') {
    stageManifestFile = requireRehearsalControlPath(snapshot[cursor + 1])
    cursor += 2
    if (snapshot[cursor] === '--rehearsal-previous-stage-receipt-file') {
      previousStageReceiptFile = requireRehearsalControlPath(
        snapshot[cursor + 1],
      )
      cursor += 2
    }
    if (snapshot[cursor] !== '--rehearsal-stage-key-file') {
      throw invalidRehearsalControlUsage()
    }
    stageKeyFile = requireRehearsalControlPath(snapshot[cursor + 1])
    cursor += 2
    if (snapshot[cursor] !== '--rehearsal-stage-reservation-file') {
      throw invalidRehearsalControlUsage()
    }
    stageReservationFile = requireRehearsalControlPath(
      snapshot[cursor + 1],
    )
    cursor += 2
  }
  if (snapshot[cursor] === '--rehearsal-fault-plan-file') {
    faultPlanFile = requireRehearsalControlPath(snapshot[cursor + 1])
    cursor += 2
  } else if (snapshot[cursor] === '--rehearsal-success-protocol') {
    if (
      snapshot[cursor + 1] !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION ||
      stageManifestFile === undefined ||
      stageKeyFile === undefined ||
      stageReservationFile === undefined
    ) {
      throw invalidRehearsalControlUsage()
    }
    successProtocol =
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION
    cursor += 2
  }
  if (
    faultPlanFile !== undefined &&
    (stageManifestFile === undefined || stageKeyFile === undefined)
  ) {
    throw invalidRehearsalControlUsage()
  }
  if (
    stageManifestFile === undefined ||
    stageKeyFile === undefined ||
    stageReservationFile === undefined ||
    (faultPlanFile === undefined && successProtocol === undefined)
  ) {
    throw invalidRehearsalControlUsage()
  }
  if (snapshot[cursor] !== '--') {
    throw invalidRehearsalControlUsage()
  }
  const controlArguments = snapshot.slice(cursor + 1)
  if (controlArguments.length === 0) {
    throw invalidRehearsalControlUsage()
  }
  return Object.freeze({
    permitFile,
    permitKeyFile,
    rateSegmentFile,
    rateConfigurationHash,
    ...(ratePreviousSegmentFile === undefined
      ? {}
      : { ratePreviousSegmentFile }),
    ...(faultPlanFile === undefined ? {} : { faultPlanFile }),
    ...(stageManifestFile === undefined ? {} : { stageManifestFile }),
    ...(previousStageReceiptFile === undefined
      ? {}
      : { previousStageReceiptFile }),
    ...(stageKeyFile === undefined ? {} : { stageKeyFile }),
    ...(stageReservationFile === undefined
      ? {}
      : { stageReservationFile }),
    ...(successProtocol === undefined ? {} : { successProtocol }),
    controlArguments: Object.freeze(controlArguments),
  })
}

/**
 * Parses one external child-process fault line through the runtime receipt parser.
 *
 * @param candidate - Untrusted decoded JSON line.
 * @returns Frozen exact envelope and detached secret-free receipt.
 */
export function parseWorkspaceSearchMigrationRehearsalControlFaultReceiptLine(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalControlFaultReceiptLine {
  try {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      nodeUtilTypes.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      throw invalidRehearsalControlFaultReceipt()
    }
    const keys = Reflect.ownKeys(candidate)
    if (
      keys.length !== 2 ||
      !keys.includes('kind') ||
      !keys.includes('receipt')
    ) {
      throw invalidRehearsalControlFaultReceipt()
    }
    const kind = readOwnRehearsalControlDataProperty(candidate, 'kind')
    if (
      kind !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_FAULT_RECEIPT_KIND
    ) {
      throw invalidRehearsalControlFaultReceipt()
    }
    const receipt = parseWorkspaceSearchMigrationRehearsalFaultReceipt(
      readOwnRehearsalControlDataProperty(candidate, 'receipt'),
    )
    return Object.freeze({ kind, receipt })
  } catch {
    throw invalidRehearsalControlFaultReceipt()
  }
}

/**
 * Parses the exact digest-bound acknowledgement sent by the parent harness.
 *
 * @param candidate - Untrusted decoded acknowledgement value.
 * @param expectedReceiptSha256 - Digest of the emitted fault receipt.
 * @returns Frozen exact acknowledgement after digest equality is checked.
 */
export function parseWorkspaceSearchMigrationRehearsalResponseLossAcknowledgement(
  candidate: unknown,
  expectedReceiptSha256: string,
): WorkspaceSearchMigrationRehearsalResponseLossAcknowledgement {
  try {
    if (
      !isHexDigest(expectedReceiptSha256) ||
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      nodeUtilTypes.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      throw invalidRehearsalControlInput()
    }
    const keys = Reflect.ownKeys(candidate)
    if (
      keys.length !== 2 ||
      !keys.includes('kind') ||
      !keys.includes('receiptSha256')
    ) {
      throw invalidRehearsalControlInput()
    }
    const kind = readOwnRehearsalControlAcknowledgementDataProperty(
      candidate,
      'kind',
    )
    const receiptSha256 =
      readOwnRehearsalControlAcknowledgementDataProperty(
      candidate,
      'receiptSha256',
    )
    if (
      kind !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_KIND ||
      receiptSha256 !== expectedReceiptSha256
    ) {
      throw invalidRehearsalControlInput()
    }
    return Object.freeze({ kind, receiptSha256 })
  } catch {
    throw invalidRehearsalControlInput()
  }
}

/**
 * Strictly parses one canonical no-fault completion receipt from FD3.
 *
 * @param candidate - Untrusted decoded child receipt value.
 * @returns Frozen scenario-bound receipt with detached rate metadata.
 */
export function parseWorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt {
  try {
    const record = requireRehearsalControlExactDataRecord(candidate, [
      'configurationBindingDigest',
      'controlArgumentsDigest',
      'kind',
      'lifecycleVersion',
      'permitDigest',
      'policyVersion',
      'purpose',
      'rateSegment',
      'requestedResourcesBinding',
      'scenario',
      'terminalCommand',
      'terminalKind',
    ])
    const kind = readOwnRehearsalControlPlainDataProperty(record, 'kind')
    const lifecycleVersion = readOwnRehearsalControlPlainDataProperty(
      record,
      'lifecycleVersion',
    )
    const outcome = readRehearsalControlNoFaultOutcome(
      readOwnRehearsalControlPlainDataProperty(record, 'scenario'),
    )
    if (
      kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_KIND ||
      lifecycleVersion !== 1 ||
      readOwnRehearsalControlPlainDataProperty(record, 'purpose') !==
        outcome.purpose ||
      readOwnRehearsalControlPlainDataProperty(record, 'terminalCommand') !==
        outcome.terminalCommand ||
      readOwnRehearsalControlPlainDataProperty(record, 'terminalKind') !==
        outcome.terminalKind
    ) {
      throw invalidRehearsalControlFaultReceipt()
    }
    const permitDigest = readRehearsalControlDigestProperty(
      record,
      'permitDigest',
    )
    const controlArgumentsDigest = readRehearsalControlDigestProperty(
      record,
      'controlArgumentsDigest',
    )
    const requestedResourcesBinding = readRehearsalControlDigestProperty(
      record,
      'requestedResourcesBinding',
    )
    const policyVersion = readRehearsalControlDigestProperty(
      record,
      'policyVersion',
    )
    const configurationBindingDigest = readRehearsalControlDigestProperty(
      record,
      'configurationBindingDigest',
    )
    const rateRecord = requireRehearsalControlExactDataRecord(
      readOwnRehearsalControlPlainDataProperty(record, 'rateSegment'),
      [
        'authenticationKeyFingerprint',
        'eventCount',
        'firstCommittedEventSequence',
        'lastCommittedEventSequence',
        'segmentDigest',
        'segmentLocatorDigest',
        'segmentOrdinal',
        'terminalRecordMac',
      ],
    )
    const eventCount = readRehearsalControlPositiveInteger(
      readOwnRehearsalControlPlainDataProperty(rateRecord, 'eventCount'),
    )
    const firstCommittedEventSequence =
      readRehearsalControlPositiveInteger(
        readOwnRehearsalControlPlainDataProperty(
          rateRecord,
          'firstCommittedEventSequence',
        ),
      )
    const lastCommittedEventSequence = readRehearsalControlPositiveInteger(
      readOwnRehearsalControlPlainDataProperty(
        rateRecord,
        'lastCommittedEventSequence',
      ),
    )
    if (
      lastCommittedEventSequence - firstCommittedEventSequence + 1 !==
        eventCount
    ) {
      throw invalidRehearsalControlFaultReceipt()
    }
    const rateSegment = Object.freeze({
      authenticationKeyFingerprint: readRehearsalControlDigestProperty(
        rateRecord,
        'authenticationKeyFingerprint',
      ),
      segmentLocatorDigest: readRehearsalControlDigestProperty(
        rateRecord,
        'segmentLocatorDigest',
      ),
      segmentOrdinal: readRehearsalControlNonNegativeInteger(
        readOwnRehearsalControlPlainDataProperty(
          rateRecord,
          'segmentOrdinal',
        ),
      ),
      eventCount,
      firstCommittedEventSequence,
      lastCommittedEventSequence,
      terminalRecordMac: readRehearsalControlDigestProperty(
        rateRecord,
        'terminalRecordMac',
      ),
      segmentDigest: readRehearsalControlDigestProperty(
        rateRecord,
        'segmentDigest',
      ),
    })
    return Object.freeze({
      kind,
      lifecycleVersion,
      ...outcome,
      permitDigest,
      controlArgumentsDigest,
      requestedResourcesBinding,
      policyVersion,
      configurationBindingDigest,
      rateSegment,
    })
  } catch {
    throw invalidRehearsalControlFaultReceipt()
  }
}

/**
 * Runs one authenticated non-production control-CLI child invocation.
 *
 * Restricted inputs are read through finite regular-file bounds. The raw key
 * is retained only until the existing control CLI finishes and is zeroized on
 * every normal, failure, or cooperative-interruption return path.
 *
 * @param arguments_ - Strict rehearsal preamble and existing control arguments.
 * @param dependencies - Injectable file, session, control, and process effects.
 * @param signal - Optional cooperative cancellation outside a kill barrier.
 * @returns Existing control status or a stable wrapper failure status.
 */
export async function runWorkspaceSearchMigrationRehearsalControlCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalControlCliDependencies =
      defaultRehearsalControlCliDependencies,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationControlCliExitCode> {
  let writeStderrLine = defaultRehearsalControlCliDependencies.writeStderrLine
  let permitKey: Uint8Array | undefined
  let stageKey: Uint8Array | undefined
  let rateRuntime: WorkspaceSearchMigrationRehearsalRateRuntime | undefined
  try {
    const capturedDependencies =
      snapshotRehearsalControlDependencies(dependencies)
    writeStderrLine = capturedDependencies.writeStderrLine
    const configuration =
      parseWorkspaceSearchMigrationRehearsalControlCliArguments(arguments_)
    const noFaultOutcome = configuration.noFaultScenario === undefined
      ? undefined
      : readRehearsalControlNoFaultOutcome(configuration.noFaultScenario)
    requireRehearsalControlActive(signal)
    const permitBytes = await readRehearsalControlInputFile(
      configuration.permitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_FILE_MAX_BYTES,
      capturedDependencies,
      signal,
    )
    requireRehearsalControlActive(signal)
    const permit = parseRehearsalControlJson(permitBytes)
    const canonicalPermitBytes = new TextEncoder().encode(
      serializeCanonicalJson(permit),
    )
    if (!equalRehearsalControlBytes(permitBytes, canonicalPermitBytes)) {
      throw invalidRehearsalControlInput()
    }
    permitKey = await readRehearsalControlPermitKeyFile(
      configuration.permitKeyFile,
      capturedDependencies,
      signal,
    )
    requireRehearsalControlActive(signal)
    const sessionPermitKey = requireExactRehearsalPermitKey(permitKey)
    const faultPlan = configuration.faultPlanFile === undefined
      ? undefined
      : await readRehearsalControlFaultPlan(
        configuration.faultPlanFile,
        capturedDependencies,
        signal,
      )
    requireRehearsalControlActive(signal)
    let selectedStage:
      WorkspaceSearchMigrationRehearsalSelectedStage | undefined
    let selectedStageReservation:
      WorkspaceSearchMigrationRehearsalStageReservation | undefined
    if (configuration.stageManifestFile !== undefined) {
      if (configuration.stageKeyFile === undefined) {
        throw invalidRehearsalControlStageSelection()
      }
      stageKey = await readRehearsalControlStageKeyFile(
        configuration.stageKeyFile,
        capturedDependencies,
        signal,
      )
      requireMatchingRehearsalControlEvidenceKey(
        permit,
        sessionPermitKey,
        stageKey,
      )
      selectedStage = await readRehearsalControlStageSelection(
        configuration,
        faultPlan === undefined ? null : createMigrationDigest(faultPlan),
        stageKey,
        capturedDependencies,
        signal,
      )
      if (
        selectedStage.manifest.permitDigest !==
          createMigrationDigest(permit) ||
        selectedStage.manifest.configurationBindingDigest !==
          configuration.rateConfigurationHash
      ) {
        throw invalidRehearsalControlStageSelection()
      }
      if (configuration.stageReservationFile === undefined) {
        throw invalidRehearsalControlStageSelection()
      }
      selectedStageReservation =
        await readRehearsalControlStageReservation(
          configuration.stageReservationFile,
          selectedStage,
          stageKey,
          capturedDependencies,
          signal,
        )
    }
    if (
      configuration.successProtocol !== undefined &&
      selectedStage === undefined
    ) {
      throw invalidRehearsalControlStageSelection()
    }
    if (
      faultPlan !== undefined &&
      (selectedStage === undefined || stageKey === undefined)
    ) {
      throw invalidRehearsalControlStageSelection()
    }
    /** Flushes the active rate runtime through the stable control failure. */
    const flushRateEvidence = async ():
      Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment> => {
      const activeRateRuntime = rateRuntime
      if (activeRateRuntime === undefined) throw operationFailed()
      try {
        return await activeRateRuntime.flush()
      } catch {
        throw operationFailed()
      }
    }
    let claimedStageContext:
      WorkspaceSearchMigrationRehearsalControlClaimedStageContext |
      undefined
    /** Returns the claimed stage context after session construction. */
    const readClaimedStageContext = ():
      WorkspaceSearchMigrationRehearsalControlClaimedStageContext => {
      if (claimedStageContext === undefined) throw operationFailed()
      return claimedStageContext
    }
    let rehearsalSession:
      WorkspaceSearchMigrationNonProductionRehearsalAwsSession | undefined
    /** Consumes the exact lease-acquisition observation from the session. */
    const takeLeaseAcquisitionObservation = ():
      WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation => {
      const activeSession = rehearsalSession
      if (activeSession === undefined) throw operationFailed()
      let observation:
        WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation |
        undefined
      try {
        observation =
          activeSession.takeRehearsalLeaseAcquisitionObservation()
      } catch {
        throw operationFailed()
      }
      if (observation === undefined) throw operationFailed()
      return observation
    }
    /** Consumes the exact injected-fault observation from the session. */
    const takeFaultObservation = ():
      WorkspaceSearchMigrationRehearsalFaultObservation => {
      const activeSession = rehearsalSession
      if (activeSession === undefined) throw operationFailed()
      let observation:
        WorkspaceSearchMigrationRehearsalFaultObservation | undefined
      try {
        observation = activeSession.takeRehearsalFaultObservation()
      } catch {
        throw operationFailed()
      }
      if (observation === undefined) throw operationFailed()
      return observation
    }
    /** Drains every authority-adoption observation from the session. */
    const takeAuthorityAdoptionObservations = ():
      readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[] => {
      const activeSession = rehearsalSession
      if (activeSession === undefined) throw operationFailed()
      const observations: WorkspaceSearchMigrationRehearsalExpectedAuthority[] = []
      try {
        while (true) {
          const observation =
            activeSession.takeRehearsalAuthorityAdoptionObservation()
          if (observation === undefined) break
          observations.push(observation)
        }
      } catch {
        throw operationFailed()
      }
      return Object.freeze(observations)
    }
    let faultProtocol:
      WorkspaceSearchMigrationRehearsalControlFaultProtocol | undefined
    if (faultPlan !== undefined) {
      if (selectedStage === undefined || stageKey === undefined) {
        throw invalidRehearsalControlStageSelection()
      }
      faultProtocol = createRehearsalControlFaultInput(
        faultPlan,
        selectedStage,
        stageKey,
        capturedDependencies,
        flushRateEvidence,
        readClaimedStageContext,
        takeLeaseAcquisitionObservation,
        takeAuthorityAdoptionObservations,
        takeFaultObservation,
      )
    }
    let sessionConstructionStarted = false
    let requestedResourcesBinding: string | undefined
    let sessionPolicyVersion: string | undefined
    /** Creates the sole rate-managed session for this control invocation. */
    const createRateManagedSession:
      WorkspaceSearchMigrationControlCliRateManagedSessionConstructor =
        async (input) => {
          if (sessionConstructionStarted) throw operationFailed()
          sessionConstructionStarted = true
          try {
            requestedResourcesBinding =
              createWorkspaceSearchMigrationRequestedResourcesBinding(
                input.requested,
              )
            sessionPolicyVersion = input.ratePolicy.policyVersion
          } catch {
            throw operationFailed()
          }
          if (
            selectedStage !== undefined &&
            (
              requestedResourcesBinding !==
                selectedStage.manifest.requestedResourcesBinding ||
              sessionPolicyVersion !== selectedStage.manifest.policyVersion
            )
          ) {
            throw invalidRehearsalControlStageSelection()
          }
          let createdRuntime: WorkspaceSearchMigrationRehearsalRateRuntime
          try {
            createdRuntime = await capturedDependencies.createRateRuntime({
              segmentFile: configuration.rateSegmentFile,
              ...(configuration.ratePreviousSegmentFile === undefined
                ? {}
                : {
                    previousSegmentFile:
                      configuration.ratePreviousSegmentFile,
                  }),
              expectedPolicyVersion: input.ratePolicy.policyVersion,
              expectedConfigurationBindingDigest:
                configuration.rateConfigurationHash,
              authenticationKey: sessionPermitKey,
            })
          } catch {
            throw operationFailed()
          }
          rateRuntime = requireRehearsalControlRateRuntime(createdRuntime)
          const stageReservation = selectedStageReservation
          const session =
            await capturedDependencies.createRehearsalSession({
            ...input,
            rateRecorder: rateRuntime.recorder,
            permit,
            permitVerificationKey: sessionPermitKey,
            ...(faultProtocol === undefined
              ? {}
              : { fault: faultProtocol.fault }),
            ...(stageReservation === undefined ||
                selectedStage === undefined ||
                stageKey === undefined
              ? {}
              : {
                  stageReservationClaim: {
                    reservation: stageReservation,
                    selection: selectedStage,
                    previousReceipt: null,
                    stageKey,
                    publicationKey: null,
                  },
                }),
          })
          rehearsalSession = session
          if (stageReservation !== undefined) {
            let claimedStageHead:
              WorkspaceSearchMigrationRehearsalStageHead | undefined
            try {
              claimedStageHead = session.readRehearsalClaimedStageHead()
            } catch {
              throw operationFailed()
            }
            if (claimedStageHead === undefined) throw operationFailed()
            claimedStageContext = Object.freeze({
              stageReservation,
              claimedStageHead,
            })
          }
          return session
        }
    const baseControlDependencies =
      createWorkspaceSearchMigrationControlCliDependencies({
        createRateManagedSession,
      })
    let capturedMutationObservation:
      WorkspaceSearchMigrationRehearsalCapturedMutationObservation |
      undefined
    let capturedLeaseAcquisitionObservation:
      WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation |
      undefined
    let capturedAuthorityAdoptionObservations:
      readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[] |
      undefined
    const capturesMutationObservation =
      configuration.successProtocol !== undefined ||
      faultPlan?.failpoint ===
        'planning-page-transaction-response-lost'
    const controlDependencies = !capturesMutationObservation
      ? baseControlDependencies
      : Object.freeze({
          ...baseControlDependencies,
          observeMutationResult: (
            observation:
              WorkspaceSearchMigrationControlCliMutationResultObservation,
          ): void => {
            const activeStageKey = stageKey
            if (
              capturedMutationObservation !== undefined ||
              selectedStage === undefined ||
              activeStageKey === undefined
            ) {
              throw operationFailed()
            }
            capturedMutationObservation =
              captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
                selection: selectedStage,
                authenticationKey: activeStageKey,
                observation,
              })
            if (configuration.successProtocol !== undefined) {
              capturedLeaseAcquisitionObservation =
                takeLeaseAcquisitionObservation()
            }
            capturedAuthorityAdoptionObservations =
              takeAuthorityAdoptionObservations()
          },
        })
    const exitCode = await capturedDependencies.runControlCli(
      configuration.controlArguments,
      controlDependencies,
      signal,
    )
    requireRehearsalControlActive(signal)
    if (!isRehearsalControlExitCode(exitCode)) {
      throw operationFailed()
    }
    let committedRateSegment:
      WorkspaceSearchMigrationRehearsalRateCommittedSegment | undefined
    if (rateRuntime !== undefined) {
      const activeRateRuntime = rateRuntime
      rateRuntime = undefined
      committedRateSegment =
        await closeRehearsalControlRateRuntime(activeRateRuntime)
    }
    if (noFaultOutcome !== undefined) {
      if (
        exitCode !== 0 ||
        committedRateSegment === undefined ||
        requestedResourcesBinding === undefined ||
        sessionPolicyVersion === undefined
      ) {
        throw operationFailed()
      }
      const noFaultReceipt = createRehearsalControlNoFaultReceipt({
        outcome: noFaultOutcome,
        permitDigest: createMigrationDigest(permit),
        controlArgumentsDigest: createMigrationDigest(
          configuration.controlArguments,
        ),
        requestedResourcesBinding,
        policyVersion: sessionPolicyVersion,
        configurationBindingDigest:
          configuration.rateConfigurationHash,
        committedRateSegment,
      })
      writeRehearsalControlNoFaultReceiptLine(
        capturedDependencies.writeFaultReceiptLine,
        noFaultReceipt,
      )
      await capturedDependencies.waitForParentResponseLossAcknowledgement(
        createMigrationDigest(noFaultReceipt),
        true,
      )
    }
    if (configuration.successProtocol !== undefined) {
      if (
        exitCode !== 0 ||
        selectedStage === undefined ||
        stageKey === undefined ||
        committedRateSegment === undefined ||
        capturedMutationObservation === undefined ||
        capturedLeaseAcquisitionObservation === undefined ||
        capturedAuthorityAdoptionObservations === undefined
      ) {
        throw operationFailed()
      }
      const material =
        createWorkspaceSearchMigrationRehearsalStageChildMaterial({
          selection: selectedStage,
          observation: capturedMutationObservation,
          committedRateSegment,
          ...readClaimedStageContext(),
          leaseAcquisitionObservation:
            capturedLeaseAcquisitionObservation,
          authorityAdoptionObservations:
            capturedAuthorityAdoptionObservations,
          authenticationKey: stageKey,
        })
      capturedDependencies.writeFaultReceiptLine(
        serializeCanonicalJson(material),
      )
      await capturedDependencies.waitForParentResponseLossAcknowledgement(
        createMigrationDigest(material),
        true,
      )
    }
    if (faultPlan !== undefined) {
      if (
        faultPlan.failpoint !==
          'planning-page-transaction-response-lost' ||
        exitCode !== 0 ||
        faultProtocol === undefined ||
        selectedStage === undefined ||
        stageKey === undefined ||
        committedRateSegment === undefined ||
        capturedMutationObservation === undefined ||
        capturedAuthorityAdoptionObservations === undefined
      ) {
        throw operationFailed()
      }
      const boundary = faultProtocol.readResponseLossBoundary()
      if (boundary === undefined) throw operationFailed()
      const material =
        createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
          selection: selectedStage,
          faultPlan,
          boundaryMaterial: boundary.material,
          boundaryRateSegmentBytes: boundary.rateSegmentBytes,
          observation: capturedMutationObservation,
          authorityAdoptionObservations: Object.freeze([
            ...boundary.material.authorityAdoptionObservations,
            ...(capturedAuthorityAdoptionObservations ?? []),
          ]),
          committedRateSegment,
          authenticationKey: stageKey,
        })
      capturedDependencies.writeFaultReceiptLine(
        serializeCanonicalJson(material),
      )
      await capturedDependencies.waitForParentResponseLossAcknowledgement(
        createMigrationDigest(material),
        true,
      )
    }
    return exitCode
  } catch (error: unknown) {
    if (rateRuntime !== undefined) {
      const activeRateRuntime = rateRuntime
      rateRuntime = undefined
      try {
        await closeRehearsalControlRateRuntime(activeRateRuntime)
      } catch {
        // Preserve the primary wrapper or control failure.
      }
    }
    const failure = classifyRehearsalControlFailure(error)
    writeRehearsalControlFailureLine(writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    zeroizeRehearsalPermitKey(permitKey)
    zeroizeRehearsalPermitKey(stageKey)
  }
}

/**
 * Captures every test-injectable effect before the first file-system await.
 *
 * @param dependencies - Potentially accessor-backed injected dependencies.
 * @returns Frozen wrappers over exact direct function identities.
 */
function snapshotRehearsalControlDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalControlCliDependencies,
): WorkspaceSearchMigrationRehearsalControlCliDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) {
    throw operationFailed()
  }
  let readInputFile:
    WorkspaceSearchMigrationRehearsalControlCliDependencies['readInputFile']
  let readPermitKeyFile:
    WorkspaceSearchMigrationRehearsalControlCliDependencies[
      'readPermitKeyFile'
    ]
  let readStageKeyFile: (path: string) => Promise<Uint8Array>
  let createRehearsalSession:
    WorkspaceSearchMigrationRehearsalControlCliDependencies[
      'createRehearsalSession'
    ]
  let createRateRuntime:
    WorkspaceSearchMigrationRehearsalControlCliDependencies[
      'createRateRuntime'
    ]
  let clock: () => Date
  let runControlCli:
    WorkspaceSearchMigrationRehearsalControlCliDependencies['runControlCli']
  let writeStderrLine:
    WorkspaceSearchMigrationRehearsalControlCliDependencies[
      'writeStderrLine'
    ]
  let writeFaultReceiptLine:
    WorkspaceSearchMigrationRehearsalControlCliDependencies[
      'writeFaultReceiptLine'
    ]
  let waitForParentKill:
    WorkspaceSearchMigrationRehearsalControlCliDependencies[
      'waitForParentKill'
    ]
  let waitForParentResponseLossAcknowledgement:
    WorkspaceSearchMigrationRehearsalControlCliDependencies[
      'waitForParentResponseLossAcknowledgement'
    ]
  try {
    readInputFile = dependencies.readInputFile
    readPermitKeyFile = dependencies.readPermitKeyFile
    readStageKeyFile = dependencies.readStageKeyFile ?? readPermitKeyFile
    createRehearsalSession = dependencies.createRehearsalSession
    createRateRuntime = dependencies.createRateRuntime
    clock = dependencies.clock ?? (() => new Date())
    runControlCli = dependencies.runControlCli
    writeStderrLine = dependencies.writeStderrLine
    writeFaultReceiptLine = dependencies.writeFaultReceiptLine
    waitForParentKill = dependencies.waitForParentKill
    waitForParentResponseLossAcknowledgement =
      dependencies.waitForParentResponseLossAcknowledgement
  } catch {
    throw operationFailed()
  }
  if (
    !isDirectRehearsalControlFunction(readInputFile) ||
    !isDirectRehearsalControlFunction(readPermitKeyFile) ||
    !isDirectRehearsalControlFunction(readStageKeyFile) ||
    !isDirectRehearsalControlFunction(createRehearsalSession) ||
    !isDirectRehearsalControlFunction(createRateRuntime) ||
    !isDirectRehearsalControlFunction(clock) ||
    !isDirectRehearsalControlFunction(runControlCli) ||
    !isDirectRehearsalControlFunction(writeStderrLine) ||
    !isDirectRehearsalControlFunction(writeFaultReceiptLine) ||
    !isDirectRehearsalControlFunction(waitForParentKill) ||
    !isDirectRehearsalControlFunction(
      waitForParentResponseLossAcknowledgement,
    )
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    readInputFile: (path, maximumBytes) =>
      readInputFile(path, maximumBytes),
    readPermitKeyFile: (path) => readPermitKeyFile(path),
    readStageKeyFile: (path) => readStageKeyFile(path),
    createRehearsalSession: (input) =>
      createRehearsalSession(input),
    createRateRuntime: (input) => createRateRuntime(input),
    clock: () => clock(),
    runControlCli: (controlArguments, controlDependencies, signal) =>
      runControlCli(controlArguments, controlDependencies, signal),
    writeStderrLine: (serializedLine) =>
      writeStderrLine(serializedLine),
    writeFaultReceiptLine: (serializedLine) =>
      writeFaultReceiptLine(serializedLine),
    waitForParentKill: () => waitForParentKill(),
    waitForParentResponseLossAcknowledgement: (
      receiptSha256,
      finalAcknowledgement,
    ) => waitForParentResponseLossAcknowledgement(
      receiptSha256,
      finalAcknowledgement,
    ),
  })
}

/**
 * Checks one injected effect without permitting callable Proxy traps.
 *
 * @param value - Candidate dependency function.
 * @returns Whether the candidate is a direct callable.
 */
function isDirectRehearsalControlFunction(
  value: unknown,
): value is (...arguments_: readonly never[]) => unknown {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Reads and time-validates the exact parent-created reservation.
 *
 * @param path - Restricted canonical reservation document path.
 * @param selection - Independently authenticated selected stage.
 * @param verificationKey - Runtime verification key for the reservation MAC.
 * @param dependencies - Captured bounded reader and trusted wall clock.
 * @param signal - Optional cooperative cancellation signal.
 * @returns Authenticated reservation active at the captured current time.
 */
async function readRehearsalControlStageReservation(
  path: string,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  verificationKey: Uint8Array,
  dependencies: WorkspaceSearchMigrationRehearsalControlCliDependencies,
  signal: AbortSignal | undefined,
): Promise<WorkspaceSearchMigrationRehearsalStageReservation> {
  try {
    const bytes = await readRehearsalControlInputFile(
      path,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES,
      dependencies,
      signal,
    )
    const reservation =
      parseWorkspaceSearchMigrationRehearsalStageReservationDocument(
      bytes,
      selection,
      verificationKey,
    )
    const now = dependencies.clock?.()
    if (
      !(now instanceof Date) ||
      nodeUtilTypes.isProxy(now)
    ) {
      throw invalidRehearsalControlStageSelection()
    }
    const nowMilliseconds = Date.prototype.getTime.call(now)
    if (
      !Number.isFinite(nowMilliseconds) ||
      nowMilliseconds < Date.parse(reservation.reservedAt) ||
      nowMilliseconds >= Date.parse(reservation.expiresAt)
    ) {
      throw invalidRehearsalControlStageSelection()
    }
    return reservation
  } catch {
    throw invalidRehearsalControlStageSelection()
  }
}

/**
 * Validates and snapshots one injected runtime without retaining accessors.
 *
 * @param candidate - Candidate runtime returned by the captured constructor.
 * @returns Frozen direct-method wrapper around the exact recorder runtime.
 */
function requireRehearsalControlRateRuntime(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalRateRuntime {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    throw operationFailed()
  }
  let recorder: WorkspaceSearchMigrationRehearsalRateRuntime['recorder']
  let flush: WorkspaceSearchMigrationRehearsalRateRuntime['flush']
  let close: WorkspaceSearchMigrationRehearsalRateRuntime['close']
  try {
    const runtime = candidate
    const recorderDescriptor = Object.getOwnPropertyDescriptor(
      runtime,
      'recorder',
    )
    const prototype = Object.getPrototypeOf(runtime)
    if (prototype !== null && nodeUtilTypes.isProxy(prototype)) {
      throw operationFailed()
    }
    const flushDescriptor = Object.getOwnPropertyDescriptor(runtime, 'flush') ??
      (prototype === null
        ? undefined
        : Object.getOwnPropertyDescriptor(prototype, 'flush'))
    const closeDescriptor = Object.getOwnPropertyDescriptor(runtime, 'close') ??
      (prototype === null
        ? undefined
        : Object.getOwnPropertyDescriptor(prototype, 'close'))
    if (
      recorderDescriptor === undefined ||
      !Object.hasOwn(recorderDescriptor, 'value') ||
      flushDescriptor === undefined ||
      !Object.hasOwn(flushDescriptor, 'value') ||
      closeDescriptor === undefined ||
      !Object.hasOwn(closeDescriptor, 'value')
    ) {
      throw operationFailed()
    }
    recorder = recorderDescriptor.value
    flush = flushDescriptor.value
    close = closeDescriptor.value
  } catch {
    throw operationFailed()
  }
  if (
    typeof recorder !== 'object' ||
    recorder === null ||
    nodeUtilTypes.isProxy(recorder) ||
    !isDirectRehearsalControlFunction(flush) ||
    !isDirectRehearsalControlFunction(close)
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    recorder,
    flush: () => flush.call(candidate),
    close: () => close.call(candidate),
  })
}

/**
 * Flushes and closes one runtime while attempting both cleanup boundaries.
 *
 * @param runtime - Process-local runtime that will no longer be exposed.
 */
async function closeRehearsalControlRateRuntime(
  runtime: WorkspaceSearchMigrationRehearsalRateRuntime,
): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment> {
  let failed = false
  let committed:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment | undefined
  try {
    committed = await runtime.flush()
  } catch {
    failed = true
  }
  try {
    await runtime.close()
  } catch {
    failed = true
  }
  if (failed) throw operationFailed()
  if (committed === undefined) throw operationFailed()
  return committed
}

/**
 * Reads one file and rechecks the injected reader's finite detached result.
 *
 * @param path - Private validated operator path.
 * @param maximumBytes - Positive inclusive byte ceiling.
 * @param dependencies - Captured finite file reader.
 * @param signal - Optional cooperative cancellation.
 * @returns Exact non-empty non-Proxy bytes.
 */
async function readRehearsalControlInputFile(
  path: string,
  maximumBytes: number,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalControlCliDependencies,
    'readInputFile'
  >,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  requireRehearsalControlActive(signal)
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readInputFile(path, maximumBytes)
  } catch {
    requireRehearsalControlActive(signal)
    throw invalidRehearsalControlInput()
  }
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    throw invalidRehearsalControlInput()
  }
  return bytes
}

/**
 * Reads the permit key through the dedicated no-follow owner-only boundary.
 *
 * The secure default reader verifies the opened inode before and after an
 * exact 32-byte read. This wrapper rechecks the injected result and zeroizes
 * every valid byte buffer when cancellation or shape validation rejects it.
 *
 * @param path - Private validated operator key path.
 * @param dependencies - Captured secure key-file reader.
 * @param signal - Optional cooperative cancellation.
 * @returns Exact non-Proxy 32-byte key owned by the wrapper until cleanup.
 */
async function readRehearsalControlPermitKeyFile(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalControlCliDependencies,
    'readPermitKeyFile'
  >,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  requireRehearsalControlActive(signal)
  let candidate: unknown
  try {
    candidate = await dependencies.readPermitKeyFile(path)
  } catch {
    requireRehearsalControlActive(signal)
    throw invalidRehearsalControlInput()
  }
  if (
    !(candidate instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(candidate) ||
    candidate.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KEY_BYTES
  ) {
    zeroizeRehearsalPermitKey(
      candidate instanceof Uint8Array && !nodeUtilTypes.isProxy(candidate)
        ? candidate
        : undefined,
    )
    throw invalidRehearsalControlInput()
  }
  try {
    requireRehearsalControlActive(signal)
  } catch (error: unknown) {
    zeroizeRehearsalPermitKey(candidate)
    throw error
  }
  return candidate
}

/**
 * Reads one exact stage key through the captured owner-only secure reader.
 *
 * @param path - Private validated stage-key path.
 * @param dependencies - Captured secure stage-key reader.
 * @param signal - Optional cooperative cancellation.
 * @returns Exact non-Proxy 32-byte stage key owned until final cleanup.
 */
async function readRehearsalControlStageKeyFile(
  path: string,
  dependencies: WorkspaceSearchMigrationRehearsalControlCliDependencies,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  requireRehearsalControlActive(signal)
  const reader = dependencies.readStageKeyFile
  if (!isDirectRehearsalControlFunction(reader)) {
    throw invalidRehearsalControlStageSelection()
  }
  let candidate: unknown
  try {
    candidate = await reader(path)
  } catch {
    requireRehearsalControlActive(signal)
    throw invalidRehearsalControlStageSelection()
  }
  if (
    !(candidate instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(candidate) ||
    candidate.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KEY_BYTES
  ) {
    zeroizeRehearsalPermitKey(
      candidate instanceof Uint8Array && !nodeUtilTypes.isProxy(candidate)
        ? candidate
        : undefined,
    )
    throw invalidRehearsalControlStageSelection()
  }
  try {
    requireRehearsalControlActive(signal)
  } catch (error: unknown) {
    zeroizeRehearsalPermitKey(candidate)
    throw error
  }
  return candidate
}

/**
 * Reads canonical authenticated stage files and selects the exact successor.
 *
 * @param configuration - Strict child preamble and exact control arguments.
 * @param faultPlanDigest - Exact canonical fault-plan digest or null.
 * @param stageKey - Shared 32-byte stage verification key.
 * @param dependencies - Captured bounded file reader.
 * @param signal - Optional cooperative cancellation.
 * @returns Exact authenticated stage selected before session construction.
 */
async function readRehearsalControlStageSelection(
  configuration: WorkspaceSearchMigrationRehearsalControlCliArguments,
  faultPlanDigest: string | null,
  stageKey: Uint8Array,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalControlCliDependencies,
    'readInputFile'
  >,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationRehearsalSelectedStage> {
  const manifestPath = configuration.stageManifestFile
  if (manifestPath === undefined) {
    throw invalidRehearsalControlStageSelection()
  }
  try {
    const manifestBytes = await readRehearsalControlInputFile(
      manifestPath,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
      dependencies,
      signal,
    )
    requireRehearsalControlActive(signal)
    const manifest =
      parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
        manifestBytes,
        stageKey,
      )
    let previousReceipt: unknown | null = null
    if (configuration.previousStageReceiptFile !== undefined) {
      const previousBytes = await readRehearsalControlInputFile(
        configuration.previousStageReceiptFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
        dependencies,
        signal,
      )
      requireRehearsalControlActive(signal)
      previousReceipt =
        parseWorkspaceSearchMigrationRehearsalStageReceiptDocument(
          previousBytes,
          stageKey,
        )
    }
    return selectWorkspaceSearchMigrationRehearsalStage({
      manifest,
      verificationKey: stageKey,
      previousReceipt,
      controlArguments: configuration.controlArguments,
      faultPlanDigest,
    })
  } catch (error: unknown) {
    requireRehearsalControlActive(signal)
    if (error instanceof WorkspaceSearchMigrationRehearsalControlCliFailure) {
      throw error
    }
    throw invalidRehearsalControlStageSelection()
  }
}

/**
 * Reads and validates one exact canonical fault-plan document.
 *
 * @param path - Private reviewed fault-plan path.
 * @param dependencies - Captured finite file reader.
 * @param signal - Optional cooperative cancellation.
 * @returns Frozen detached exact one-shot fault plan.
 */
async function readRehearsalControlFaultPlan(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalControlCliDependencies,
    'readInputFile'
  >,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationRehearsalFaultPlan> {
  const bytes = await readRehearsalControlInputFile(
    path,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_PLAN_FILE_MAX_BYTES,
    dependencies,
    signal,
  )
  requireRehearsalControlActive(signal)
  try {
    const plan = snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
      parseRehearsalControlJson(bytes),
    )
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(plan),
    )
    if (!equalRehearsalControlBytes(bytes, canonicalBytes)) {
      throw invalidRehearsalControlInput()
    }
    return plan
  } catch {
    throw invalidRehearsalControlInput()
  }
}

/**
 * Parses exact finite UTF-8 bytes as one JSON value.
 *
 * @param bytes - Already bounded non-empty file bytes.
 * @returns Parsed JSON value without retaining the file buffer.
 */
function parseRehearsalControlJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    throw invalidRehearsalControlInput()
  }
}

/**
 * Waits for one canonical digest-bound acknowledgement on standard input.
 *
 * A response-loss boundary consumes one line without waiting for EOF, leaving
 * stdin open for the completion ACK. Every other caller requests a final ACK;
 * the reader then also requires exact EOF after that sole line.
 *
 * @param expectedReceiptSha256 - Digest of the already emitted receipt.
 * @param finalAcknowledgement - Whether EOF is required after this ACK.
 */
async function waitForDefaultResponseLossAcknowledgement(
  expectedReceiptSha256: string,
  finalAcknowledgement = true,
): Promise<void> {
  if (
    defaultAcknowledgementReaderActive ||
    defaultAcknowledgementReaderCompleted
  ) throw invalidRehearsalControlInput()
  defaultAcknowledgementReaderActive = true
  let byteLength = 0
  try {
    const iterator = readDefaultAcknowledgementIterator()
    let lineBytes: Uint8Array | undefined
    while (lineBytes === undefined) {
      const newlineIndex = defaultAcknowledgementPendingBytes.indexOf(0x0a)
      if (newlineIndex >= 0) {
        lineBytes = defaultAcknowledgementPendingBytes.slice(0, newlineIndex)
        defaultAcknowledgementPendingBytes =
          defaultAcknowledgementPendingBytes.slice(newlineIndex + 1)
        break
      }
      const next = await iterator.next()
      if (next.done === true) throw invalidRehearsalControlInput()
      const chunk = next.value
      if (!(chunk instanceof Uint8Array) || nodeUtilTypes.isProxy(chunk)) {
        throw invalidRehearsalControlInput()
      }
      if (
        chunk.byteLength >
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RESPONSE_LOSS_ACK_MAX_BYTES -
            byteLength
      ) {
        throw invalidRehearsalControlInput()
      }
      byteLength += chunk.byteLength
      defaultAcknowledgementPendingBytes = appendRehearsalControlBytes(
        defaultAcknowledgementPendingBytes,
        chunk,
      )
    }
    if (
      lineBytes.byteLength === 0 ||
      lineBytes.includes(0x0d) ||
      defaultAcknowledgementPendingBytes.byteLength !== 0
    ) {
      throw invalidRehearsalControlInput()
    }
    const line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes)
    let candidate: unknown
    try {
      candidate = JSON.parse(line)
    } catch {
      throw invalidRehearsalControlInput()
    }
    const acknowledgement =
      parseWorkspaceSearchMigrationRehearsalResponseLossAcknowledgement(
        candidate,
        expectedReceiptSha256,
      )
    if (serializeCanonicalJson(acknowledgement) !== line) {
      throw invalidRehearsalControlInput()
    }
    if (finalAcknowledgement) {
      const next = await iterator.next()
      if (next.done !== true) throw invalidRehearsalControlInput()
      defaultAcknowledgementReaderCompleted = true
    }
  } catch {
    defaultAcknowledgementReaderCompleted = true
    throw invalidRehearsalControlInput()
  } finally {
    defaultAcknowledgementReaderActive = false
  }
}

/** Lazily retained production stdin iterator shared by the two ACK phases. */
let defaultAcknowledgementIterator: AsyncIterator<Uint8Array> | undefined

/** Bytes received beyond the latest complete acknowledgement line. */
let defaultAcknowledgementPendingBytes: Uint8Array = new Uint8Array(0)

/** Prevents concurrent reads from consuming the single stdin iterator. */
let defaultAcknowledgementReaderActive = false

/** Permanently closes the production ACK reader after final EOF or failure. */
let defaultAcknowledgementReaderCompleted = false

/** Returns the one retained production stdin byte iterator. */
function readDefaultAcknowledgementIterator(): AsyncIterator<Uint8Array> {
  if (defaultAcknowledgementIterator === undefined) {
    defaultAcknowledgementIterator = process.stdin[Symbol.asyncIterator]()
  }
  return defaultAcknowledgementIterator
}

/** Appends two bounded acknowledgement byte vectors. */
function appendRehearsalControlBytes(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength)
  combined.set(left, 0)
  combined.set(right, left.byteLength)
  return combined
}

/**
 * Installs receipt reporting and the external parent-kill barrier.
 *
 * @param plan - Detached canonical one-shot fault plan.
 * @param selection - Authenticated exact stage owning the fault plan.
 * @param authenticationKey - Shared 32-byte stage material key.
 * @param dependencies - Captured stderr and barrier effects.
 * @param flushRateEvidence - Fail-closed durable rate-queue barrier.
 * @param readClaimedStageContext - Reads the post-CAS reservation and head.
 * @param takeLeaseAcquisitionObservation - Takes the adapter-proven lease CAS.
 * @param takeAuthorityAdoptionObservations - Drains adapter-proven adoptions.
 * @param takeFaultObservation - Takes the adapter-proven selected fault state.
 * @returns Controller input and one-shot response-loss boundary reader.
 */
function createRehearsalControlFaultInput(
  plan: WorkspaceSearchMigrationRehearsalFaultPlan,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  authenticationKey: Uint8Array,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalControlCliDependencies,
    | 'waitForParentKill'
    | 'waitForParentResponseLossAcknowledgement'
      | 'writeFaultReceiptLine'
  >,
  flushRateEvidence: () =>
    Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment>,
  readClaimedStageContext: () =>
    WorkspaceSearchMigrationRehearsalControlClaimedStageContext,
  takeLeaseAcquisitionObservation: () =>
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
  takeAuthorityAdoptionObservations: () =>
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[],
  takeFaultObservation: () =>
    WorkspaceSearchMigrationRehearsalFaultObservation,
): WorkspaceSearchMigrationRehearsalControlFaultProtocol {
  let responseLossBoundary:
    WorkspaceSearchMigrationRehearsalControlFaultBoundaryState | undefined
  const fault:
    CreateWorkspaceSearchMigrationRehearsalFaultControllerInput = {
    plan,
    waitAtBarrier: async (
      receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
    ): Promise<void> => {
      const committedRateSegment = await flushRateEvidence()
      const claimedStageContext = readClaimedStageContext()
      const leaseAcquisitionObservation =
        takeLeaseAcquisitionObservation()
      const authorityAdoptionObservations =
        takeAuthorityAdoptionObservations()
      const faultObservation = takeFaultObservation()
      const material =
        createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
          selection,
          faultPlan: plan,
          faultReceipt: receipt,
          committedRateSegment,
          ...claimedStageContext,
          leaseAcquisitionObservation,
          authorityAdoptionObservations,
          faultObservation,
          authenticationKey,
        })
      dependencies.writeFaultReceiptLine(serializeCanonicalJson(material))
      await dependencies.waitForParentKill()
    },
    reportResponseLoss: async (
      receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
    ): Promise<void> => {
      if (responseLossBoundary !== undefined) throw operationFailed()
      const committedRateSegment = await flushRateEvidence()
      const claimedStageContext = readClaimedStageContext()
      const leaseAcquisitionObservation =
        takeLeaseAcquisitionObservation()
      const authorityAdoptionObservations =
        takeAuthorityAdoptionObservations()
      const faultObservation = takeFaultObservation()
      const material =
        createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
          selection,
          faultPlan: plan,
          faultReceipt: receipt,
          committedRateSegment,
          ...claimedStageContext,
          leaseAcquisitionObservation,
          authorityAdoptionObservations,
          faultObservation,
          authenticationKey,
        })
      responseLossBoundary = Object.freeze({
        material,
        rateSegmentBytes: new Uint8Array(
          committedRateSegment.canonicalBytes,
        ),
      })
      dependencies.writeFaultReceiptLine(serializeCanonicalJson(material))
      await dependencies.waitForParentResponseLossAcknowledgement(
        createMigrationDigest(material),
        false,
      )
    },
  }
  return Object.freeze({
    fault: Object.freeze(fault),
    readResponseLossBoundary: () => responseLossBoundary,
  })
}

/**
 * Creates one strict scenario contract from its only admitted label.
 *
 * @param value - Candidate no-fault scenario value.
 * @returns Frozen purpose, command, and terminal-kind contract.
 */
function readRehearsalControlNoFaultOutcome(
  value: unknown,
): WorkspaceSearchMigrationRehearsalNoFaultOutcome {
  if (value === 'happy-path-verified') {
    return Object.freeze({
      scenario: value,
      purpose: 'verified',
      terminalCommand: 'verify',
      terminalKind: 'verified',
    })
  }
  if (value === 'complete-apply-rollback') {
    return Object.freeze({
      scenario: value,
      purpose: 'complete-rollback',
      terminalCommand: 'rollback-complete',
      terminalKind: 'rolled-back',
    })
  }
  throw invalidRehearsalControlUsage()
}

/**
 * Creates and revalidates one no-fault completion receipt.
 *
 * @param input - Bound terminal outcome and confirmed durable segment.
 * @returns Frozen canonicalizable no-fault lifecycle receipt.
 */
function createRehearsalControlNoFaultReceipt(
  input: CreateRehearsalControlNoFaultReceiptInput,
): WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt {
  return parseWorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_KIND,
    lifecycleVersion: 1,
    ...input.outcome,
    permitDigest: input.permitDigest,
    controlArgumentsDigest: input.controlArgumentsDigest,
    requestedResourcesBinding: input.requestedResourcesBinding,
    policyVersion: input.policyVersion,
    configurationBindingDigest: input.configurationBindingDigest,
    rateSegment: {
      authenticationKeyFingerprint:
        input.committedRateSegment.authenticationKeyFingerprint,
      segmentLocatorDigest:
        input.committedRateSegment.segmentLocatorDigest,
      segmentOrdinal: input.committedRateSegment.segmentOrdinal,
      eventCount: input.committedRateSegment.eventCount,
      firstCommittedEventSequence:
        input.committedRateSegment.firstCommittedEventSequence,
      lastCommittedEventSequence:
        input.committedRateSegment.lastCommittedEventSequence,
      terminalRecordMac: input.committedRateSegment.terminalRecordMac,
      segmentDigest: input.committedRateSegment.segmentDigest,
    },
  })
}

/**
 * Emits one canonical no-fault lifecycle receipt on the dedicated FD3 writer.
 *
 * @param writeReceiptLine - Captured dedicated protocol writer.
 * @param receipt - Strict receipt emitted only after runtime cleanup.
 */
function writeRehearsalControlNoFaultReceiptLine(
  writeReceiptLine: (serializedLine: string) => void,
  receipt: WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt,
): void {
  writeReceiptLine(serializeCanonicalJson(
    parseWorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt(receipt),
  ))
}

/**
 * Reads one enumerable own data property without invoking an accessor.
 *
 * @param record - Already validated ordinary record.
 * @param property - Exact required property.
 * @returns Own data-property value.
 */
function readOwnRehearsalControlDataProperty(
  record: object,
  property: 'kind' | 'receipt',
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, property)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw invalidRehearsalControlFaultReceipt()
  }
  return descriptor.value
}

/**
 * Reads one acknowledgement data property without invoking an accessor.
 *
 * @param record - Already validated ordinary acknowledgement record.
 * @param property - Exact required acknowledgement property.
 * @returns Own data-property value.
 */
function readOwnRehearsalControlAcknowledgementDataProperty(
  record: object,
  property: 'kind' | 'receiptSha256',
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, property)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw invalidRehearsalControlInput()
  }
  const value: unknown = descriptor.value
  return value
}

/**
 * Requires one exact ordinary enumerable data record without accessors.
 *
 * @param candidate - Untrusted decoded receipt value.
 * @param expectedKeys - Exact own string keys admitted by the contract.
 * @returns Ordinary record safe for descriptor-only reads.
 */
function requireRehearsalControlExactDataRecord(
  candidate: unknown,
  expectedKeys: readonly string[],
): object {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate) ||
    nodeUtilTypes.isProxy(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw invalidRehearsalControlFaultReceipt()
  }
  const actualKeys = Reflect.ownKeys(candidate)
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) =>
      typeof key !== 'string' || !expectedKeys.includes(key)
    )
  ) {
    throw invalidRehearsalControlFaultReceipt()
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw invalidRehearsalControlFaultReceipt()
    }
  }
  return candidate
}

/**
 * Reads one previously validated receipt data property by descriptor.
 *
 * @param record - Exact ordinary data record.
 * @param property - Required own property name.
 * @returns Untrusted property value for explicit narrowing.
 */
function readOwnRehearsalControlPlainDataProperty(
  record: object,
  property: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, property)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw invalidRehearsalControlFaultReceipt()
  }
  const value: unknown = descriptor.value
  return value
}

/**
 * Reads one required lowercase SHA-256 receipt property.
 *
 * @param record - Exact ordinary data record.
 * @param property - Required digest property name.
 * @returns Validated lowercase digest.
 */
function readRehearsalControlDigestProperty(
  record: object,
  property: string,
): string {
  const value = readOwnRehearsalControlPlainDataProperty(record, property)
  if (!isHexDigest(value)) throw invalidRehearsalControlFaultReceipt()
  return value
}

/** Reads one positive safe integer from no-fault lifecycle evidence. */
function readRehearsalControlPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw invalidRehearsalControlFaultReceipt()
  }
  return value
}

/** Reads one non-negative safe integer from no-fault lifecycle evidence. */
function readRehearsalControlNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidRehearsalControlFaultReceipt()
  }
  return value
}

/**
 * Copies every wrapper argument before parsing any flag position.
 *
 * @param arguments_ - Potentially accessor-backed argument collection.
 * @returns Frozen finite plain string vector.
 */
function snapshotRehearsalControlArguments(
  arguments_: readonly string[],
): readonly string[] {
  let length: number
  try {
    length = arguments_.length
  } catch {
    throw invalidRehearsalControlUsage()
  }
  if (!Number.isSafeInteger(length) || length < 10 || length > 268) {
    throw invalidRehearsalControlUsage()
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
        throw invalidRehearsalControlUsage()
      }
      snapshot.push(value)
    }
  } catch {
    throw invalidRehearsalControlUsage()
  }
  return Object.freeze(snapshot)
}

/**
 * Requires one bounded nonblank path without resolving or retaining metadata.
 *
 * @param value - Candidate exact path position.
 * @returns Validated private caller path.
 */
function requireRehearsalControlPath(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0') ||
    value.length > 4_096
  ) {
    throw invalidRehearsalControlUsage()
  }
  return value
}

/**
 * Requires the raw key file to contain exactly 32 bytes without decoding.
 *
 * @param key - Bounded raw key-file bytes.
 * @returns The same exact-length key retained until final cleanup.
 */
function requireExactRehearsalPermitKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KEY_BYTES) {
    throw invalidRehearsalControlInput()
  }
  return key
}

/**
 * Requires the permit and stage protocols to share one approved evidence key.
 *
 * @param permit - Canonical permit document bound by the selected manifest.
 * @param permitKey - Exact 32-byte permit verification key.
 * @param stageKey - Exact 32-byte manifest and child-material key.
 */
function requireMatchingRehearsalControlEvidenceKey(
  permit: unknown,
  permitKey: Uint8Array,
  stageKey: Uint8Array,
): void {
  try {
    if (
      permitKey.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KEY_BYTES ||
      stageKey.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KEY_BYTES ||
      !timingSafeEqual(permitKey, stageKey) ||
      typeof permit !== 'object' ||
      permit === null ||
      Array.isArray(permit) ||
      nodeUtilTypes.isProxy(permit) ||
      Object.getPrototypeOf(permit) !== Object.prototype
    ) {
      throw invalidRehearsalControlStageSelection()
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      permit,
      'evidenceKeyDigest',
    )
    const expectedDigest = descriptor?.value
    const observedDigest = createHash('sha256').update(stageKey).digest('hex')
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      !isHexDigest(expectedDigest) ||
      expectedDigest !== observedDigest
    ) {
      throw invalidRehearsalControlStageSelection()
    }
  } catch {
    throw invalidRehearsalControlStageSelection()
  }
}

/**
 * Compares two public byte vectors without converting them back to text.
 *
 * @param left - Original bounded file bytes.
 * @param right - Canonical serialized bytes.
 * @returns Whether both vectors contain exactly the same bytes.
 */
function equalRehearsalControlBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Requires an invocation not to have been cooperatively interrupted.
 *
 * @param signal - Optional process signal bridge.
 */
function requireRehearsalControlActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    if (signal.reason === parentLivenessAbortReason) {
      throw parentChannelLost()
    }
    throw new WorkspaceSearchMigrationRehearsalControlCliFailure(
      'INTERRUPTED',
      130,
    )
  }
}

/**
 * Zeroizes raw permit-key bytes without allowing cleanup failure to escape.
 *
 * @param key - Key buffer returned by the bounded file reader.
 */
function zeroizeRehearsalPermitKey(key: Uint8Array | undefined): void {
  if (key === undefined) return
  try {
    Uint8Array.prototype.fill.call(key, 0)
  } catch {
    // The primary control or wrapper outcome remains authoritative.
  }
}

/** Checks one exact existing control-CLI exit status. */
function isRehearsalControlExitCode(
  value: unknown,
): value is WorkspaceSearchMigrationControlCliExitCode {
  return value === 0 || value === 1 || value === 2 || value === 130
}

/** Classifies arbitrary failures without reading caller-controlled fields. */
function classifyRehearsalControlFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalControlCliFailure {
  if (error instanceof WorkspaceSearchMigrationRehearsalControlCliFailure) {
    return error
  }
  return operationFailed()
}

/** Writes one stable wrapper failure and drops writer failures. */
function writeRehearsalControlFailureLine(
  writeStderrLine: (serializedLine: string) => void,
  code: WorkspaceSearchMigrationRehearsalControlCliFailureCode,
): void {
  try {
    writeStderrLine(serializeCanonicalJson({
      code,
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_RESULT_KIND,
      status: 'error',
    }))
  } catch {
    // Raw writer errors must never replace the stable process status.
  }
}

/** Creates one stable strict-preamble usage failure. */
function invalidRehearsalControlUsage():
  WorkspaceSearchMigrationRehearsalControlCliFailure {
  return new WorkspaceSearchMigrationRehearsalControlCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Creates one stable restricted-input failure. */
function invalidRehearsalControlInput():
  WorkspaceSearchMigrationRehearsalControlCliFailure {
  return new WorkspaceSearchMigrationRehearsalControlCliFailure(
    'INVALID_REHEARSAL_INPUT',
    2,
  )
}

/** Creates one stable authenticated stage-selection failure. */
function invalidRehearsalControlStageSelection():
  WorkspaceSearchMigrationRehearsalControlCliFailure {
  return new WorkspaceSearchMigrationRehearsalControlCliFailure(
    'INVALID_STAGE_SELECTION',
    2,
  )
}

/** Creates one stable external receipt failure. */
function invalidRehearsalControlFaultReceipt():
  WorkspaceSearchMigrationRehearsalControlCliFailure {
  return new WorkspaceSearchMigrationRehearsalControlCliFailure(
    'INVALID_FAULT_RECEIPT',
    2,
  )
}

/** Creates one stable injected or wrapper operation failure. */
function operationFailed():
  WorkspaceSearchMigrationRehearsalControlCliFailure {
  return new WorkspaceSearchMigrationRehearsalControlCliFailure(
    'OPERATION_FAILED',
    1,
  )
}

/** Creates one stable failure after the parent containment channel is lost. */
function parentChannelLost():
  WorkspaceSearchMigrationRehearsalControlCliFailure {
  return new WorkspaceSearchMigrationRehearsalControlCliFailure(
    'PARENT_CHANNEL_LOST',
    1,
  )
}

if (import.meta.main) {
  const controller = new AbortController()
  /** Aborts work and releases any concurrent ACK read after parent loss. */
  const handleParentLivenessLoss = (): void => {
    controller.abort(parentLivenessAbortReason)
    try {
      process.stdin.destroy()
    } catch {
      // The shared abort remains authoritative when stdin cleanup fails.
    }
  }
  const parentLivenessMonitor =
    createDefaultWorkspaceSearchMigrationRehearsalParentLivenessMonitor(
      handleParentLivenessLoss,
    )
  defaultParentLivenessMonitor = parentLivenessMonitor
  let signalExitCode: 130 | 143 | undefined
  /** Records only the first cooperative child-process signal. */
  const interrupt = (exitCode: 130 | 143): void => {
    if (signalExitCode !== undefined) return
    signalExitCode = exitCode
    controller.abort()
  }
  /** Requests ordinary interactive cancellation outside a kill barrier. */
  const handleSigint = (): void => interrupt(130)
  /** Requests ordinary termination outside a kill barrier. */
  const handleSigterm = (): void => interrupt(143)
  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)
  void runWorkspaceSearchMigrationRehearsalControlCli(
    Bun.argv.slice(2),
    defaultRehearsalControlCliDependencies,
    controller.signal,
  ).then((exitCode) => {
    parentLivenessMonitor.stop()
    defaultParentLivenessMonitor = undefined
    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)
    process.exitCode =
      exitCode === 130 && signalExitCode !== undefined
        ? signalExitCode
        : exitCode
  })
}
