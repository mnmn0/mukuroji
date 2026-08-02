import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
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
  abandonAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation,
  readAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationHead,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  validateWorkspaceSearchMigrationRequestedResources,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  verifyWorkspaceSearchMigrationRehearsalPermit,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
  WorkspaceSearchMigrationRehearsalPrivateInputError,
} from './migration-rehearsal-private-input'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
  type CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  parseWorkspaceSearchMigrationRehearsalStageManifestDocument,
  parseWorkspaceSearchMigrationRehearsalStageReceiptDocument,
  verifyWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  parseWorkspaceSearchMigrationRehearsalStageReservationDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  createWorkspaceSearchMigrationRehearsalStageReservationAbandonment,
} from './migration-rehearsal-stage-reservation-abandonment'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'

/** Explicit acknowledgement required for expired-reservation abandonment. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_APPROVAL =
  'abandon-expired-contained-rehearsal-stage'

/** Stable discriminator for secret-free abandonment result lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-abandon-result'

/** Maximum exact canonical bytes accepted for one authenticated permit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_PERMIT_MAX_BYTES =
  64 * 1_024

/** Exact raw master-key bytes accepted by the abandonment CLI. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_KEY_BYTES = 32

/** Strictly parsed operator inputs; transition and cleanup JSON are absent. */
export type WorkspaceSearchMigrationRehearsalStageAbandonCliArguments = {
  /** Complete explicit validated non-production resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Exact private canonical reviewed rate-policy path. */
  readonly ratePolicyFile: string
  /** Exact private canonical authenticated permit path. */
  readonly permitFile: string
  /** Sole private operator master-key path. */
  readonly rehearsalAuthenticationKeyFile: string
  /** Exact private canonical authenticated stage-manifest path. */
  readonly stageManifestFile: string
  /** Exact private predecessor receipt path, absent only at stage one. */
  readonly previousReceiptFile?: string
  /** Exact private active reservation document path. */
  readonly stageReservationFile: string
  /** Owner-only directory containing the fixed runtime and cleanup paths. */
  readonly evidenceDirectory: string
}

/** Callable strong-read boundary injected into focused CLI tests. */
export type WorkspaceSearchMigrationRehearsalStageAbandonCliReadHead = (
  input: Parameters<
    typeof readAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationHead
  >[0],
) => Promise<WorkspaceSearchMigrationRehearsalStageHead>

/** Callable abandonment CAS boundary injected into focused CLI tests. */
export type WorkspaceSearchMigrationRehearsalStageAbandonCliAbandon = (
  input: Parameters<
    typeof abandonAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation
  >[0],
) => Promise<WorkspaceSearchMigrationRehearsalStageHead>

/** Injectable private I/O, clock, cleanup, and AWS boundaries. */
export type WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies = {
  /** Reads one stable owner-only single-link private file. */
  readonly readPrivateInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Strongly reads the current authenticated rehearsal stage head. */
  readonly readStageHead:
    WorkspaceSearchMigrationRehearsalStageAbandonCliReadHead
  /** Durably zeroes and unlinks the exact fixed runtime key. */
  readonly cleanupRuntimeKey: (
    input: CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization>
  /** Applies the exact cleanup-authorized abandonment CAS. */
  readonly abandonStageReservation:
    WorkspaceSearchMigrationRehearsalStageAbandonCliAbandon
  /** Returns a trusted live wall-clock sample. */
  readonly now: () => Date
  /** Emits one already canonical digest-only success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Emits one already canonical raw-value-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable process statuses returned by the abandonment CLI. */
export type WorkspaceSearchMigrationRehearsalStageAbandonCliExitCode =
  | 0
  | 1
  | 2

/** Stable raw-value-free abandonment CLI failure classifications. */
export type WorkspaceSearchMigrationRehearsalStageAbandonCliFailureCode =
  | 'ABANDON_FAILED'
  | 'AUTHENTICATION_FAILED'
  | 'CLEANUP_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INVALID_USAGE'
  | 'RECOVERY_REQUIRED'

/** Private classified failure carrying no raw argument or artifact value. */
class WorkspaceSearchMigrationRehearsalStageAbandonCliFailure extends Error {
  /** Stable machine-readable failure classification. */
  readonly code: WorkspaceSearchMigrationRehearsalStageAbandonCliFailureCode
  /** Exact process status paired with the classification. */
  readonly exitCode:
    WorkspaceSearchMigrationRehearsalStageAbandonCliExitCode

  /**
   * Creates one raw-value-free abandonment CLI failure.
   *
   * @param code - Stable failure classification.
   * @param exitCode - Exact process status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalStageAbandonCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalStageAbandonCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalStageAbandonCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Maximum accepted abandonment CLI argument count. */
const maximumAbandonCliArgumentCount = 48

/** Maximum accepted scalar or path argument length. */
const maximumAbandonCliArgumentLength = 4_096

/** Every exact flag accepted by the abandonment CLI. */
const abandonCliFlagNames = new Set<string>([
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
  '--stage-reservation-file',
  '--evidence-directory',
  '--approval',
])

/** Default production abandonment CLI dependencies. */
const defaultAbandonCliDependencies:
  WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies =
    Object.freeze({
      readPrivateInputFile:
        readWorkspaceSearchMigrationRehearsalPrivateInputFile,
      readStageHead:
        readAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationHead,
      cleanupRuntimeKey:
        cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
      abandonStageReservation:
        abandonAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation,
      now: (): Date => new Date(),
      writeStdoutLine: (line): void => {
        console.log(line)
      },
      writeStderrLine: (line): void => {
        console.error(line)
      },
    })

/**
 * Parses unique explicit resources and only the reviewed private inputs.
 *
 * No transition, intent, completion, runtime-key, account-derived, or AWS
 * resource path can be supplied outside the fixed reviewed flag vocabulary.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Frozen validated resource and private-path selection.
 */
export function parseWorkspaceSearchMigrationRehearsalStageAbandonCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalStageAbandonCliArguments {
  const flags = parseAbandonCliFlagPairs(
    snapshotAbandonCliArguments(arguments_),
  )
  if (
    requireAbandonCliFlag(flags, '--approval') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_APPROVAL
  ) throw invalidUsage()
  const resources: WorkspaceSearchMigrationRequestedResources = {
    account: requireAbandonCliFlag(flags, '--account'),
    region: requireAbandonCliFlag(flags, '--region'),
    profile: requireAbandonCliFlag(flags, '--profile'),
    commit: requireAbandonCliFlag(flags, '--commit'),
    tables: {
      'project-directory': requireAbandonCliFlag(
        flags,
        '--project-directory-table',
      ),
      'work-items': requireAbandonCliFlag(flags, '--work-items-table'),
      collaboration: requireAbandonCliFlag(
        flags,
        '--collaboration-table',
      ),
      documents: requireAbandonCliFlag(flags, '--documents-table'),
      'workspace-search': requireAbandonCliFlag(
        flags,
        '--workspace-search-table',
      ),
      'migration-state': requireAbandonCliFlag(
        flags,
        '--migration-state-table',
      ),
    },
    journalBucket: requireAbandonCliFlag(flags, '--journal-bucket'),
    journalKeyArn: requireAbandonCliFlag(flags, '--journal-key-arn'),
  }
  try {
    validateWorkspaceSearchMigrationRequestedResources(resources)
  } catch {
    throw invalidUsage()
  }
  const previousReceiptFile = readOptionalAbandonCliPath(
    flags,
    '--previous-receipt-file',
  )
  const configuration = Object.freeze({
    resources: Object.freeze({
      ...resources,
      tables: Object.freeze({ ...resources.tables }),
    }),
    ratePolicyFile: requireResolvedAbandonCliPath(
      flags,
      '--rate-policy-file',
    ),
    permitFile: requireResolvedAbandonCliPath(flags, '--permit-file'),
    rehearsalAuthenticationKeyFile: requireResolvedAbandonCliPath(
      flags,
      '--rehearsal-authentication-key-file',
    ),
    stageManifestFile: requireResolvedAbandonCliPath(
      flags,
      '--stage-manifest-file',
    ),
    ...(previousReceiptFile === undefined
      ? {}
      : { previousReceiptFile }),
    stageReservationFile: requireResolvedAbandonCliPath(
      flags,
      '--stage-reservation-file',
    ),
    evidenceDirectory: requireResolvedAbandonCliPath(
      flags,
      '--evidence-directory',
    ),
  })
  requireDistinctAbandonCliPaths(configuration)
  return configuration
}

/**
 * Runs one cleanup-authorized exact expired-reservation abandonment.
 *
 * Permit, manifest, predecessor, reservation, active strong head, split keys,
 * expiry, and permit window are independently authenticated. The AWS CAS is
 * unreachable until durable runtime-key cleanup returns a genuine capability.
 *
 * @param arguments_ - Exact explicit operator command.
 * @param dependencies - Injectable private I/O, clock, cleanup, and AWS ports.
 * @returns Stable process status.
 */
export async function runWorkspaceSearchMigrationRehearsalStageAbandonCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies =
      defaultAbandonCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalStageAbandonCliExitCode> {
  let writeStdoutLine = defaultAbandonCliDependencies.writeStdoutLine
  let writeStderrLine = defaultAbandonCliDependencies.writeStderrLine
  const ownedBuffers: Uint8Array[] = []
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const captured = snapshotAbandonCliDependencies(dependencies)
    writeStdoutLine = captured.writeStdoutLine
    writeStderrLine = captured.writeStderrLine
    const configuration =
      parseWorkspaceSearchMigrationRehearsalStageAbandonCliArguments(
        arguments_,
      )
    const ratePolicy = readAbandonRatePolicy(await readAbandonPrivateBytes(
      configuration.ratePolicyFile,
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
      captured,
      ownedBuffers,
    ))
    const permitBytes = await readAbandonPrivateBytes(
      configuration.permitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_PERMIT_MAX_BYTES,
      captured,
      ownedBuffers,
    )
    const permit = parseCanonicalAbandonJson(permitBytes)
    const masterKey = await readAbandonPrivateBytes(
      configuration.rehearsalAuthenticationKeyFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_KEY_BYTES,
      captured,
      ownedBuffers,
    )
    if (
      masterKey.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_KEY_BYTES
    ) throw authenticationFailed()
    try {
      const derived = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
      runtimeKey = derived.runtimeKey
      publicationKey = derived.publicationKey
    } catch {
      throw authenticationFailed()
    } finally {
      zeroizeStageAbandonBytes(masterKey)
    }
    const requestedResourcesBinding =
      createWorkspaceSearchMigrationRequestedResourcesBinding(
        configuration.resources,
      )
    const firstObservedAt = readAbandonTrustedTime(captured.now)
    const permitClaims = authenticateAbandonPermit(
      permit,
      runtimeKey,
      configuration.resources,
      requestedResourcesBinding,
      firstObservedAt,
    )
    const manifest = parseAbandonManifest(
      await readAbandonPrivateBytes(
        configuration.stageManifestFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
        captured,
        ownedBuffers,
      ),
      runtimeKey,
    )
    const previousReceipt = await readAbandonPreviousReceipt(
      configuration,
      runtimeKey,
      captured,
      ownedBuffers,
    )
    const selection = deriveAbandonSelection(
      manifest,
      previousReceipt,
      runtimeKey,
    )
    const reservation = parseAbandonReservation(
      await readAbandonPrivateBytes(
        configuration.stageReservationFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_MAX_BYTES,
        captured,
        ownedBuffers,
      ),
      selection,
      runtimeKey,
    )
    requireAbandonTopLevelBindings(
      configuration,
      ratePolicy,
      permit,
      permitClaims,
      manifest,
      reservation,
      runtimeKey,
      publicationKey,
      requestedResourcesBinding,
      firstObservedAt,
    )
    requireAbandonRecoveryWindowElapsed(reservation, firstObservedAt)
    const head = await captured.readStageHead({
      requested: configuration.resources,
      ratePolicy,
      permit,
      permitVerificationKey: runtimeKey,
      permitClock: captured.now,
      manifest,
      manifestVerificationKey: runtimeKey,
    })
    requireAbandonHeadMatchesReservation(head, reservation)
    let cleanupAuthorization:
      WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization
    try {
      cleanupAuthorization = await captured.cleanupRuntimeKey({
        evidenceDirectory: configuration.evidenceDirectory,
        reservation,
        selection,
        expectedRuntimeKey: runtimeKey,
        publicationAuthenticationKey: publicationKey,
        now: captured.now,
      })
    } catch {
      throw cleanupFailed()
    }
    const cleanupBinding =
      readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
        cleanupAuthorization,
      )
    const abandonedAt = readAbandonTrustedTime(captured.now).toISOString()
    if (
      Date.parse(abandonedAt) < readAbandonRecoveryDeadline(reservation) ||
      Date.parse(abandonedAt) < Date.parse(cleanupBinding.completedAt) ||
      Date.parse(abandonedAt) >= Date.parse(permitClaims.expiresAt)
    ) throw authenticationFailed()
    const abandonment =
      createWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
        reservation,
        selection,
        reservationClaimRevision: head.revision,
        previousAbandonmentCount: head.abandonmentCount,
        previousAbandonmentRootDigest: head.abandonmentRootDigest,
        abandonedAt,
        runtimeKeyCleanupCompletionDigest:
          cleanupBinding.cleanupCompletionDigest,
        runtimeVerificationKey: runtimeKey,
        publicationSigningKey: publicationKey,
      })
    const observedAt = readAbandonTrustedTime(captured.now).toISOString()
    if (
      Date.parse(observedAt) < Date.parse(abandonedAt) ||
      Date.parse(observedAt) >= Date.parse(permitClaims.expiresAt)
    ) throw authenticationFailed()
    let successor: WorkspaceSearchMigrationRehearsalStageHead
    try {
      successor = await captured.abandonStageReservation({
        requested: configuration.resources,
        ratePolicy,
        permit,
        permitVerificationKey: runtimeKey,
        permitClock: captured.now,
        manifest,
        manifestVerificationKey: runtimeKey,
        stageReservationAbandonment: {
          selection,
          reservation,
          abandonment,
          runtimeKeyCleanupAuthorization: cleanupAuthorization,
          runtimeVerificationKey: runtimeKey,
          publicationVerificationKey: publicationKey,
          observedAt,
        },
      })
    } catch {
      throw abandonFailed()
    }
    requireAbandonSuccessor(successor, head, reservation, abandonment)
    writeStdoutLine(serializeCanonicalJson({
      abandonmentDigest: createMigrationDigest(abandonment),
      cleanupCompletionDigest: cleanupBinding.cleanupCompletionDigest,
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_RESULT_KIND,
      revision: successor.revision,
      stageOrdinal: reservation.stageOrdinal,
      status: 'succeeded',
    }))
    return 0
  } catch (error: unknown) {
    const failure = classifyAbandonCliFailure(error)
    writeStderrLine(serializeCanonicalJson({
      code: failure.code,
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_RESULT_KIND,
      status: 'error',
    }))
    return failure.exitCode
  } finally {
    for (const buffer of ownedBuffers) zeroizeStageAbandonBytes(buffer)
    zeroizeWorkspaceSearchMigrationRehearsalKey(runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(publicationKey)
  }
}

/** Captures exact direct dependency functions before the first await. */
function snapshotAbandonCliDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies,
): WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) throw invalidUsage()
  const functions = [
    dependencies.readPrivateInputFile,
    dependencies.readStageHead,
    dependencies.cleanupRuntimeKey,
    dependencies.abandonStageReservation,
    dependencies.now,
    dependencies.writeStdoutLine,
    dependencies.writeStderrLine,
  ]
  if (functions.some((value) =>
    typeof value !== 'function' || nodeUtilTypes.isProxy(value)
  )) throw invalidUsage()
  return Object.freeze({ ...dependencies })
}

/** Reads and owns one bounded private input byte vector. */
async function readAbandonPrivateBytes(
  path: string,
  maximumBytes: number,
  dependencies: WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies,
  ownedBuffers: Uint8Array[],
): Promise<Uint8Array> {
  try {
    const bytes = await dependencies.readPrivateInputFile(path, maximumBytes)
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      nodeUtilTypes.isSharedArrayBuffer(bytes.buffer) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumBytes
    ) throw inputInvalid()
    const copied = new Uint8Array(bytes)
    ownedBuffers.push(bytes, copied)
    return copied
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalStageAbandonCliFailure) {
      throw error
    }
    if (error instanceof WorkspaceSearchMigrationRehearsalPrivateInputError) {
      throw inputUnreadable()
    }
    throw inputUnreadable()
  }
}

/** Parses exact canonical JSON without accepting whitespace or duplicate shape. */
function parseCanonicalAbandonJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    if (serializeCanonicalJson(candidate) !== text) throw inputInvalid()
    return candidate
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalStageAbandonCliFailure) {
      throw error
    }
    throw inputInvalid()
  }
}

/** Parses one exact canonical reviewed DescribeTable rate policy. */
function readAbandonRatePolicy(
  bytes: Uint8Array,
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  try {
    return parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(bytes)
  } catch {
    throw authenticationFailed()
  }
}

/** Authenticates one permit against explicit resources and trusted time. */
function authenticateAbandonPermit(
  permit: unknown,
  runtimeKey: Uint8Array,
  resources: WorkspaceSearchMigrationRequestedResources,
  requestedResourcesBinding: string,
  currentTime: Date,
): Readonly<WorkspaceSearchMigrationRehearsalPermitClaims> {
  try {
    return verifyWorkspaceSearchMigrationRehearsalPermit({
      permit,
      verificationKey: runtimeKey,
      account: resources.account,
      region: resources.region,
      commit: resources.commit,
      requestedResourcesBinding,
      currentTime,
    })
  } catch {
    throw authenticationFailed()
  }
}

/** Parses and authenticates one exact canonical stage manifest. */
function parseAbandonManifest(
  bytes: Uint8Array,
  runtimeKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageManifest {
  try {
    return parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
      bytes,
      runtimeKey,
    )
  } catch {
    throw authenticationFailed()
  }
}

/** Reads the mandatory predecessor only after global stage one. */
async function readAbandonPreviousReceipt(
  configuration: WorkspaceSearchMigrationRehearsalStageAbandonCliArguments,
  runtimeKey: Uint8Array,
  dependencies: WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies,
  ownedBuffers: Uint8Array[],
): Promise<WorkspaceSearchMigrationRehearsalStageReceipt | null> {
  if (configuration.previousReceiptFile === undefined) return null
  const bytes = await readAbandonPrivateBytes(
    configuration.previousReceiptFile,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
    dependencies,
    ownedBuffers,
  )
  try {
    return parseWorkspaceSearchMigrationRehearsalStageReceiptDocument(
      bytes,
      runtimeKey,
    )
  } catch {
    throw authenticationFailed()
  }
}

/** Derives the exact immediate manifest successor for reservation verification. */
function deriveAbandonSelection(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  runtimeKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalSelectedStage {
  const manifestDigest = createMigrationDigest(manifest)
  let ordinal = 1
  let previousStageReceiptDigest: string | null = null
  if (previousReceipt !== null) {
    let verified: WorkspaceSearchMigrationRehearsalStageReceipt
    try {
      verified = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        previousReceipt,
        runtimeKey,
      )
    } catch {
      throw authenticationFailed()
    }
    const previousEntry = manifest.entries[verified.stageOrdinal - 1]
    if (
      previousEntry === undefined ||
      verified.manifestDigest !== manifestDigest ||
      verified.manifestEntryDigest !== createMigrationDigest(previousEntry) ||
      verified.stageOrdinal >= manifest.entries.length
    ) throw authenticationFailed()
    ordinal = verified.stageOrdinal + 1
    previousStageReceiptDigest = createMigrationDigest(verified)
  }
  const entry = manifest.entries[ordinal - 1]
  if (entry === undefined) throw authenticationFailed()
  return Object.freeze({
    manifest,
    manifestDigest,
    entry,
    previousStageReceiptDigest,
  })
}

/** Parses and authenticates the exact active reservation document. */
function parseAbandonReservation(
  bytes: Uint8Array,
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
  runtimeKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageReservation {
  try {
    return parseWorkspaceSearchMigrationRehearsalStageReservationDocument(
      bytes,
      selection,
      runtimeKey,
    )
  } catch {
    throw authenticationFailed()
  }
}

/** Requires every local key, permit, manifest, policy, and expiry binding. */
function requireAbandonTopLevelBindings(
  configuration: WorkspaceSearchMigrationRehearsalStageAbandonCliArguments,
  ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy,
  permit: unknown,
  permitClaims: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  requestedResourcesBinding: string,
  observedAt: Date,
): void {
  const runtimeKeyDigest = createHash('sha256')
    .update(runtimeKey)
    .digest('hex')
  const publicationKeyDigest = createHash('sha256')
    .update(publicationKey)
    .digest('hex')
  if (
    permitClaims.evidenceKeyDigest !== runtimeKeyDigest ||
    permitClaims.publicationKeyDigest !== publicationKeyDigest ||
    manifest.evidenceKeyDigest !== runtimeKeyDigest ||
    manifest.publicationKeyDigest !== publicationKeyDigest ||
    manifest.permitDigest !== createMigrationDigest(permit) ||
    manifest.commit !== configuration.resources.commit ||
    manifest.requestedResourcesBinding !== requestedResourcesBinding ||
    manifest.policyVersion !== ratePolicy.policyVersion ||
    reservation.manifestDigest !== createMigrationDigest(manifest) ||
    reservation.permitDigest !== manifest.permitDigest ||
    reservation.requestedResourcesBinding !== requestedResourcesBinding ||
    reservation.commit !== configuration.resources.commit ||
    reservation.policyVersion !== ratePolicy.policyVersion ||
    Date.parse(reservation.reservedAt) < Date.parse(permitClaims.issuedAt) ||
    Date.parse(reservation.expiresAt) +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS >
      Date.parse(permitClaims.expiresAt) ||
    observedAt.getTime() >= Date.parse(permitClaims.expiresAt)
  ) throw authenticationFailed()
}

/** Requires the fixed inclusive recovery deadline before any destructive step. */
function requireAbandonRecoveryWindowElapsed(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  observedAt: Date,
): void {
  if (observedAt.getTime() < readAbandonRecoveryDeadline(reservation)) {
    throw recoveryRequired()
  }
}

/** Returns the fixed inclusive recovery deadline for one active reservation. */
function readAbandonRecoveryDeadline(
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
): number {
  const deadline = Date.parse(reservation.expiresAt) +
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS
  if (!Number.isSafeInteger(deadline)) throw authenticationFailed()
  return deadline
}

/** Requires the strong head to prove this exact reservation is still active. */
function requireAbandonHeadMatchesReservation(
  head: WorkspaceSearchMigrationRehearsalStageHead,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
): void {
  if (
    head.manifestDigest !== reservation.manifestDigest ||
    head.completedStageOrdinal !== reservation.stageOrdinal - 1 ||
    head.headReceiptDigest !== reservation.previousStageReceiptDigest ||
    head.activeReservationDigest !== createMigrationDigest(reservation) ||
    head.activeStageOrdinal !== reservation.stageOrdinal ||
    head.activeExpiresAt !== reservation.expiresAt ||
    !Number.isSafeInteger(head.revision) ||
    head.revision <= 0
  ) throw authenticationFailed()
}

/** Requires the returned durable head to be the exact inactive successor. */
function requireAbandonSuccessor(
  successor: WorkspaceSearchMigrationRehearsalStageHead,
  predecessor: WorkspaceSearchMigrationRehearsalStageHead,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  abandonment: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageReservationAbandonment
  >,
): void {
  if (
    successor.manifestDigest !== predecessor.manifestDigest ||
    successor.completedStageOrdinal !== predecessor.completedStageOrdinal ||
    successor.headReceiptDigest !== predecessor.headReceiptDigest ||
    successor.activeReservationDigest !== null ||
    successor.activeStageOrdinal !== null ||
    successor.activeExpiresAt !== null ||
    successor.abandonmentCount !== abandonment.abandonmentCount ||
    successor.abandonmentRootDigest !==
      abandonment.abandonmentRootDigest ||
    successor.revision !== predecessor.revision + 1 ||
    abandonment.reservationDigest !== createMigrationDigest(reservation)
  ) throw abandonFailed()
}

/** Reads one direct finite trusted Date sample. */
function readAbandonTrustedTime(now: () => Date): Date {
  let value: unknown
  try {
    value = Reflect.apply(now, undefined, [])
  } catch {
    throw authenticationFailed()
  }
  if (
    !(value instanceof Date) ||
    nodeUtilTypes.isProxy(value) ||
    !Number.isFinite(value.getTime())
  ) throw authenticationFailed()
  return new Date(value.getTime())
}

/** Copies and validates the complete argument vector before parsing pairs. */
function snapshotAbandonCliArguments(
  arguments_: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(arguments_) ||
    nodeUtilTypes.isProxy(arguments_) ||
    arguments_.length === 0 ||
    arguments_.length > maximumAbandonCliArgumentCount ||
    arguments_.length % 2 !== 0
  ) throw invalidUsage()
  const snapshot: string[] = []
  for (const value of arguments_) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > maximumAbandonCliArgumentLength ||
      value.includes('\0')
    ) throw invalidUsage()
    snapshot.push(value)
  }
  return Object.freeze(snapshot)
}

/** Parses unique known flag/value pairs and rejects every unknown flag. */
function parseAbandonCliFlagPairs(
  arguments_: readonly string[],
): ReadonlyMap<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    if (
      flag === undefined ||
      value === undefined ||
      !abandonCliFlagNames.has(flag) ||
      flags.has(flag)
    ) throw invalidUsage()
    flags.set(flag, value)
  }
  return flags
}

/** Reads one required nonblank scalar flag. */
function requireAbandonCliFlag(
  flags: ReadonlyMap<string, string>,
  flag: string,
): string {
  const value = flags.get(flag)
  if (value === undefined || value.trim().length === 0) throw invalidUsage()
  return value
}

/** Reads and resolves one required private path flag. */
function requireResolvedAbandonCliPath(
  flags: ReadonlyMap<string, string>,
  flag: string,
): string {
  return resolve(requireAbandonCliFlag(flags, flag))
}

/** Reads and resolves one optional predecessor path. */
function readOptionalAbandonCliPath(
  flags: ReadonlyMap<string, string>,
  flag: string,
): string | undefined {
  const value = flags.get(flag)
  if (value === undefined) return undefined
  if (value.trim().length === 0) throw invalidUsage()
  return resolve(value)
}

/** Requires every private file and fixed cleanup path to be distinct. */
function requireDistinctAbandonCliPaths(
  configuration: WorkspaceSearchMigrationRehearsalStageAbandonCliArguments,
): void {
  const paths = [
    configuration.ratePolicyFile,
    configuration.permitFile,
    configuration.rehearsalAuthenticationKeyFile,
    configuration.stageManifestFile,
    ...(configuration.previousReceiptFile === undefined
      ? []
      : [configuration.previousReceiptFile]),
    configuration.stageReservationFile,
    join(
      configuration.evidenceDirectory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    ),
    join(
      configuration.evidenceDirectory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
    ),
    join(
      configuration.evidenceDirectory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
    ),
  ]
  if (new Set(paths).size !== paths.length) throw invalidUsage()
}

/** Best-effort zeroizes one owned private input buffer. */
function zeroizeStageAbandonBytes(value: Uint8Array): void {
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // Cleanup must not replace the primary abandonment outcome.
  }
}

/** Maps only deliberate classified failures to stable process output. */
function classifyAbandonCliFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalStageAbandonCliFailure {
  if (error instanceof WorkspaceSearchMigrationRehearsalStageAbandonCliFailure) {
    return error
  }
  return abandonFailed()
}

/** Creates one invalid-usage failure. */
function invalidUsage(): WorkspaceSearchMigrationRehearsalStageAbandonCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageAbandonCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Creates one unreadable-private-input failure. */
function inputUnreadable(): WorkspaceSearchMigrationRehearsalStageAbandonCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageAbandonCliFailure(
    'INPUT_FILE_UNREADABLE',
    1,
  )
}

/** Creates one malformed-private-input failure. */
function inputInvalid(): WorkspaceSearchMigrationRehearsalStageAbandonCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageAbandonCliFailure(
    'INPUT_FILE_INVALID',
    1,
  )
}

/** Creates one local authentication failure. */
function authenticationFailed(): WorkspaceSearchMigrationRehearsalStageAbandonCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageAbandonCliFailure(
    'AUTHENTICATION_FAILED',
    1,
  )
}

/** Creates one durable cleanup failure. */
function cleanupFailed(): WorkspaceSearchMigrationRehearsalStageAbandonCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageAbandonCliFailure(
    'CLEANUP_FAILED',
    1,
  )
}

/** Creates one pre-deadline recovery-required outcome. */
function recoveryRequired(): WorkspaceSearchMigrationRehearsalStageAbandonCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageAbandonCliFailure(
    'RECOVERY_REQUIRED',
    1,
  )
}

/** Creates one remote abandonment failure. */
function abandonFailed(): WorkspaceSearchMigrationRehearsalStageAbandonCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageAbandonCliFailure(
    'ABANDON_FAILED',
    1,
  )
}

/** Runs the standalone executable only when invoked as the entry script. */
if (import.meta.main) {
  void runWorkspaceSearchMigrationRehearsalStageAbandonCli(
    process.argv.slice(2),
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
