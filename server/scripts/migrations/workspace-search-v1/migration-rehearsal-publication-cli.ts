import { constants, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationControlCliArguments,
  type WorkspaceSearchMigrationMeasureCliArguments,
} from './migration-control-cli'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
} from './migration-describe-table-rate-policy'
import {
  createAwsWorkspaceSearchMigrationNonProductionRehearsalSession,
  type CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
  type WorkspaceSearchMigrationNonProductionRehearsalAwsSession,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
} from './migration-identity'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
} from './migration-rehearsal-key-derivation'
import {
  verifyWorkspaceSearchMigrationRehearsalPermit,
  type VerifyWorkspaceSearchMigrationRehearsalPermitInput,
} from './migration-rehearsal-permit'
import {
  publishWorkspaceSearchMigrationRehearsalSuite,
  type PublishWorkspaceSearchMigrationRehearsalSuiteInput,
  type WorkspaceSearchMigrationRehearsalPublicationResult,
  type WorkspaceSearchMigrationRehearsalPublicationSession,
} from './migration-rehearsal-publication'
import {
  finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS,
  type FinalizeWorkspaceSearchMigrationRehearsalReconciliationEvidenceInput,
  type WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence,
  type WorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  type WorkspaceSearchMigrationRehearsalReconciliationArtifactExpectation,
} from './migration-rehearsal-reconciliation-audit'
import {
  finalizeWorkspaceSearchMigrationRehearsalRateEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENTS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_TOTAL_BYTES,
  type FinalizeWorkspaceSearchMigrationRehearsalRateEvidenceInput,
  type WorkspaceSearchMigrationRehearsalFinalizedRateEvidence,
} from './migration-rehearsal-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalRateRuntime,
  type CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  type WorkspaceSearchMigrationRehearsalRateRuntime,
} from './migration-rehearsal-rate-runtime'
import {
  deriveWorkspaceSearchMigrationRehearsalStageChainEvidence,
  parseWorkspaceSearchMigrationRehearsalStageManifestDocument,
  parseWorkspaceSearchMigrationRehearsalStageReceiptDocument,
  readWorkspaceSearchMigrationRehearsalFinalizedStageChainReconciliationContexts,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence,
} from './migration-rehearsal-stage-receipt'
import {
  assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
  type AssembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
  type WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
} from './migration-rehearsal-suite-finalizer'

/** Exact review acknowledgement required for final immutable publication. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_APPROVAL =
  'publish-reviewed-non-production-migration-rehearsal'

/** Maximum exact canonical bytes accepted for the suite prestage document. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRESTAGE_MAX_BYTES =
  64 * 1_024 * 1_024

/** Maximum exact canonical bytes accepted for the combined alarm artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ARTIFACT_MAX_BYTES =
  64 * 1_024 * 1_024

/** Maximum canonical bytes accepted for the authenticated main permit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAIN_PERMIT_MAX_BYTES =
  64 * 1_024

/** Largest bounded restricted artifact accepted by this executable. */
const maximumRestrictedPublicationInputBytes =
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRESTAGE_MAX_BYTES

/** Stable discriminator used by the canonical CLI failure line. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-publication-cli-result'

/** Maximum per-request publication deadline accepted from the operator. */
const maximumPublicationRequestTimeoutMilliseconds = 30_000

/** Exact owner-only permission bits required for every restricted input. */
const restrictedInputMode = 0o600

/** Maximum accepted local path length at the CLI boundary. */
const maximumPublicationPathLength = 4_096

/** Raw authenticated stage documents transferred into chain derivation. */
export type WorkspaceSearchMigrationRehearsalPublicationStageChainInput = {
  /** Exact canonical reviewed full-suite manifest bytes. */
  readonly manifestBytes: Uint8Array
  /** Exact canonical stage receipt bytes in global ordinal order. */
  readonly receiptBytes: readonly Uint8Array[]
  /** Owned child-runtime manifest and receipt key consumed by derivation. */
  readonly verificationKey: Uint8Array
  /** Owned parent-only lifecycle verification key consumed by derivation. */
  readonly publicationVerificationKey: Uint8Array
  /** Digest of the exact locally authenticated rehearsal permit document. */
  readonly expectedPermitDigest: string
}

/** Authenticated purpose-separated key bindings retained from the permit. */
export type WorkspaceSearchMigrationRehearsalPublicationPermitKeyBindings = {
  /** Authenticated digest of the child-visible runtime evidence key. */
  readonly evidenceKeyDigest: string
  /** Authenticated digest of the parent-only publication key. */
  readonly publicationKeyDigest: string
}

/** Stable raw-value-free final publication CLI failure categories. */
export type WorkspaceSearchMigrationRehearsalPublicationCliFailureCode =
  | 'CAPABILITY_CLOSE_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INTERRUPTED'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'

/** Exact process exit statuses emitted by the final publication CLI. */
export type WorkspaceSearchMigrationRehearsalPublicationCliExitCode =
  | 0
  | 1
  | 2
  | 130

/** Strictly parsed final publication wrapper configuration. */
export type WorkspaceSearchMigrationRehearsalPublicationCliArguments = {
  /** Canonical prestage suite document that omits rate and completion time. */
  readonly suiteInputFile: string
  /** Canonical complete alarm artifact bytes referenced by the prestage data. */
  readonly alarmArtifactFile: string
  /** Canonical authenticated main rehearsal permit. */
  readonly permitFile: string
  /** Raw owner-only 32-byte rehearsal master authentication key. */
  readonly authenticationKeyFile: string
  /** Authenticated stage-receipt chain used to derive #163 time windows. */
  readonly stageReceiptManifestFile: string
  /** Explicit globally ordered authenticated stage receipt files. */
  readonly stageReceiptFiles: readonly string[]
  /** Eight reconciliation audits in canonical scenario order. */
  readonly reconciliationAuditFiles: readonly string[]
  /** Reviewed measured configuration digest used by every rate segment. */
  readonly configurationHash: string
  /** Ordered existing durable rate segment files. */
  readonly rateSegmentFiles: readonly string[]
  /** Fresh exclusive continuation segment created for final measurement. */
  readonly finalRateSegmentFile: string
  /** Positive finite deadline for every immutable S3 request. */
  readonly requestTimeoutMilliseconds: number
  /** Exact reviewed publication acknowledgement. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_APPROVAL
  /** Existing strict measure command selecting all physical resources. */
  readonly measure: WorkspaceSearchMigrationMeasureCliArguments
}

/** Minimal measured session retained through final immutable publication. */
export interface WorkspaceSearchMigrationRehearsalFinalPublicationSession
  extends WorkspaceSearchMigrationRehearsalPublicationSession {
  /**
   * Measures all configured resources.
   *
   * @returns Reviewed digest of the exact measured configuration.
   */
  measureConfigurationHash(): Promise<string>

  /** Stops every not-yet-started rate-managed measurement operation. */
  interruptDescribeTableRate(): void
}

/** Injectable boundaries used by the final publication executable. */
export type WorkspaceSearchMigrationRehearsalPublicationCliDependencies = {
  /** Reads one stable owner-only regular file without following symlinks. */
  readonly readRestrictedFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Creates the fresh durable continuation rate runtime. */
  readonly createRateRuntime: (
    input: CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalRateRuntime>
  /** Creates the authenticated real non-production measured AWS session. */
  readonly createSession: (
    input: CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalFinalPublicationSession>
  /** Authenticates and joins every exact durable rate segment. */
  readonly finalizeRate: (
    input: FinalizeWorkspaceSearchMigrationRehearsalRateEvidenceInput,
  ) => WorkspaceSearchMigrationRehearsalFinalizedRateEvidence
  /** Authenticates the reviewed manifest and complete global receipt chain. */
  readonly deriveStageChain: (
    input: WorkspaceSearchMigrationRehearsalPublicationStageChainInput,
  ) => WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence
  /** Locally authenticates the permit before any derived key is routed. */
  readonly verifyPermit: (
    input: VerifyWorkspaceSearchMigrationRehearsalPermitInput,
  ) => WorkspaceSearchMigrationRehearsalPublicationPermitKeyBindings
  /** Reads eight trusted terminal contexts without consuming the stage chain. */
  readonly readStageReconciliationContexts: (
    value: WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence,
  ) => readonly WorkspaceSearchMigrationRehearsalReconciliationAuditContext[]
  /** Authenticates all eight terminal audits into one suite capability. */
  readonly finalizeReconciliation: (
    input: FinalizeWorkspaceSearchMigrationRehearsalReconciliationEvidenceInput,
    runtimeVerificationKey: Uint8Array,
    publicationVerificationKey: Uint8Array,
  ) => WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence
  /** Assembles and semantically validates the final suite preparation input. */
  readonly assembleSuite: (
    input: AssembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
  ) => WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation
  /** Publishes all ten children and the final HMAC index in one session. */
  readonly publishSuite: (
    input: PublishWorkspaceSearchMigrationRehearsalSuiteInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalPublicationResult>
  /** Returns one trusted native wall-clock value. */
  readonly clock: () => Date
  /** Writes one already canonical secret-free success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Writes one already canonical raw-value-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable final publication CLI failure without paths or lower-level text. */
export class WorkspaceSearchMigrationRehearsalPublicationCliError
  extends Error {
  /** Machine-readable failure category containing no operator value. */
  readonly code: WorkspaceSearchMigrationRehearsalPublicationCliFailureCode

  /** Exact process exit status paired with this stable failure. */
  readonly exitCode: WorkspaceSearchMigrationRehearsalPublicationCliExitCode

  /**
   * Creates one raw-value-free CLI failure.
   *
   * @param code - Stable secret-free failure category.
   * @param exitCode - Exact process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalPublicationCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalPublicationCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalPublicationCliError'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Stable descriptor identity compared before and after every secure read. */
type RestrictedInputIdentity = {
  /** Device identifier. */
  readonly device: bigint
  /** Inode identifier. */
  readonly inode: bigint
  /** Exact regular-file size. */
  readonly size: bigint
  /** Complete native permission and file-type mode. */
  readonly mode: bigint
  /** Owning user identifier. */
  readonly userId: bigint
  /** Exact hard-link count. */
  readonly linkCount: bigint
  /** Nanosecond modification time. */
  readonly modifiedAtNanoseconds: bigint
  /** Nanosecond metadata-change time. */
  readonly changedAtNanoseconds: bigint
}

/** Default executable effects using only local files and real AWS factories. */
const defaultPublicationCliDependencies:
  WorkspaceSearchMigrationRehearsalPublicationCliDependencies =
  Object.freeze({
    readRestrictedFile:
      readWorkspaceSearchMigrationRehearsalRestrictedInputFile,
    createRateRuntime: (input) =>
      createWorkspaceSearchMigrationRehearsalRateRuntime(input),
    createSession: (input) => createFinalPublicationSession(input),
    finalizeRate: (input) =>
      finalizeWorkspaceSearchMigrationRehearsalRateEvidence(input),
    deriveStageChain: (input) =>
      derivePublicationStageChainEvidence(input),
    verifyPermit: (input) =>
      verifyWorkspaceSearchMigrationRehearsalPermit(input),
    readStageReconciliationContexts: (value) =>
      readWorkspaceSearchMigrationRehearsalFinalizedStageChainReconciliationContexts(
        value,
      ),
    finalizeReconciliation: (
      input,
      runtimeVerificationKey,
      publicationVerificationKey,
    ) =>
      finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence(
        input,
        runtimeVerificationKey,
        publicationVerificationKey,
      ),
    assembleSuite: (input) =>
      assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(input),
    publishSuite: (input) =>
      publishWorkspaceSearchMigrationRehearsalSuite(input),
    clock: (): Date => new Date(),
    writeStdoutLine: (line: string): void => console.log(line),
    writeStderrLine: (line: string): void => console.error(line),
  })

/**
 * Parses the exact ordered final publication command.
 *
 * One or more existing segment flags occur between the configuration digest
 * and the fresh output path. The suffix after `--` must be the existing
 * read-only `measure` command, so a dry-run or mutation command cannot be
 * reclassified as final measurement.
 *
 * @param arguments_ - Arguments following the executable script path.
 * @returns Frozen detached publication configuration.
 */
export function parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalPublicationCliArguments {
  const snapshot = snapshotArguments(arguments_)
  if (
    snapshot[0] !== '--rehearsal-suite-input-file' ||
    snapshot[2] !== '--rehearsal-alarm-artifact-file' ||
    snapshot[4] !== '--rehearsal-permit-file' ||
    snapshot[6] !== '--rehearsal-authentication-key-file' ||
    snapshot[8] !== '--rehearsal-stage-receipt-manifest-file'
  ) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  const suiteInputFile = readPath(snapshot[1])
  const alarmArtifactFile = readPath(snapshot[3])
  const permitFile = readPath(snapshot[5])
  const authenticationKeyFile = readPath(snapshot[7])
  const stageReceiptManifestFile = readPath(snapshot[9])
  let cursor = 10
  const stageReceiptFiles: string[] = []
  while (snapshot[cursor] === '--rehearsal-stage-receipt-file') {
    if (
      stageReceiptFiles.length >=
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES
    ) {
      return failPublicationCli('INVALID_USAGE', 2)
    }
    stageReceiptFiles.push(readPath(snapshot[cursor + 1]))
    cursor += 2
  }
  if (stageReceiptFiles.length === 0) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  const reconciliationAuditFiles: string[] = []
  for (
    let index = 0;
    index <
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS.length;
    index += 1
  ) {
    if (snapshot[cursor] !== '--rehearsal-reconciliation-audit-file') {
      return failPublicationCli('INVALID_USAGE', 2)
    }
    reconciliationAuditFiles.push(readPath(snapshot[cursor + 1]))
    cursor += 2
  }
  requireUniqueReconciliationInputPaths(reconciliationAuditFiles)
  if (snapshot[cursor] !== '--rehearsal-rate-configuration-hash') {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  const configurationHash = snapshot[cursor + 1]
  if (!isHexDigest(configurationHash)) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  cursor += 2
  const rateSegmentFiles: string[] = []
  while (snapshot[cursor] === '--rehearsal-rate-segment-file') {
    if (
      rateSegmentFiles.length >=
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENTS - 1
    ) {
      return failPublicationCli('INVALID_USAGE', 2)
    }
    rateSegmentFiles.push(readPath(snapshot[cursor + 1]))
    cursor += 2
  }
  if (
    rateSegmentFiles.length === 0 ||
    snapshot[cursor] !== '--rehearsal-final-rate-segment-file'
  ) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  const finalRateSegmentFile = readPath(snapshot[cursor + 1])
  cursor += 2
  if (
    snapshot[cursor] !== '--request-timeout-milliseconds' ||
    snapshot[cursor + 2] !== '--approval' ||
    snapshot[cursor + 3] !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_APPROVAL ||
    snapshot[cursor + 4] !== '--'
  ) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  const requestTimeoutMilliseconds = readPositiveInteger(
    snapshot[cursor + 1],
    maximumPublicationRequestTimeoutMilliseconds,
  )
  const controlArguments = snapshot.slice(cursor + 5)
  let parsedControl: ReturnType<
    typeof parseWorkspaceSearchMigrationControlCliArguments
  >
  try {
    parsedControl = parseWorkspaceSearchMigrationControlCliArguments(
      controlArguments,
    )
  } catch {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  if (parsedControl.command !== 'measure') {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  return Object.freeze({
    suiteInputFile,
    alarmArtifactFile,
    permitFile,
    authenticationKeyFile,
    stageReceiptManifestFile,
    stageReceiptFiles: Object.freeze(stageReceiptFiles),
    reconciliationAuditFiles: Object.freeze(reconciliationAuditFiles),
    configurationHash,
    rateSegmentFiles: Object.freeze(rateSegmentFiles),
    finalRateSegmentFile,
    requestTimeoutMilliseconds,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_APPROVAL,
    measure: parsedControl,
  })
}

/**
 * Runs final measurement, rate finalization, and immutable publication.
 *
 * Every restricted input is fully read and checked before the first AWS
 * session is created. The new continuation segment is closed before its bytes
 * are finalized. The suite completion clock is captured only after that final
 * measurement evidence is durable. Success is emitted only after the
 * publication orchestrator has closed all borrowed capabilities.
 *
 * @param arguments_ - Exact ordered final publication command.
 * @param dependencies - Injectable secure file, AWS, and publication effects.
 * @param signal - Optional cooperative interruption signal.
 * @returns Stable process exit status after cleanup and output.
 */
export async function runWorkspaceSearchMigrationRehearsalPublicationCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalPublicationCliDependencies =
      defaultPublicationCliDependencies,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationRehearsalPublicationCliExitCode> {
  let runtime: WorkspaceSearchMigrationRehearsalRateRuntime | undefined
  let session:
    WorkspaceSearchMigrationRehearsalFinalPublicationSession | undefined
  let masterKey: Uint8Array | undefined
  let runtimeAuthenticationKey: Uint8Array | undefined
  let publicationAuthenticationKey: Uint8Array | undefined
  let restrictedInputs: RestrictedPublicationInputs | undefined
  let result: WorkspaceSearchMigrationRehearsalPublicationResult | undefined
  let primaryFailure: unknown
  let failed = false
  let removeAbortListener: (() => void) | undefined
  let output:
    Pick<
      WorkspaceSearchMigrationRehearsalPublicationCliDependencies,
      'writeStderrLine' | 'writeStdoutLine'
    > | undefined

  try {
    const captured = captureDependencies(dependencies)
    output = captured
    const configuration =
      parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        arguments_,
      )
    requireActive(signal)
    const inputs = await readAllRestrictedInputs(configuration, captured)
    restrictedInputs = inputs
    masterKey = inputs.authenticationKey
    const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(
      masterKey,
    )
    runtimeAuthenticationKey = derivedKeys.runtimeKey
    publicationAuthenticationKey = derivedKeys.publicationKey
    zeroize(masterKey)
    masterKey = undefined
    const localPermitVerificationKey = copyAuthenticationKey(
      runtimeAuthenticationKey,
    )
    let permitKeyBindings:
      WorkspaceSearchMigrationRehearsalPublicationPermitKeyBindings
    try {
      permitKeyBindings = readPermitKeyBindings(
        captured.verifyPermit({
          permit: inputs.permit,
          verificationKey: localPermitVerificationKey,
          account: configuration.measure.resources.account,
          region: configuration.measure.resources.region,
          commit: configuration.measure.resources.commit,
          requestedResourcesBinding:
            createWorkspaceSearchMigrationRequestedResourcesBinding(
              configuration.measure.resources,
            ),
          currentTime: readTrustedDate(captured.clock),
        }),
      )
    } finally {
      zeroize(localPermitVerificationKey)
    }
    if (
      permitKeyBindings.evidenceKeyDigest !==
        derivedKeys.runtimeKeyDigest ||
      permitKeyBindings.publicationKeyDigest !==
        derivedKeys.publicationKeyDigest
    ) {
      return failPublicationCli('OPERATION_FAILED', 1)
    }
    const authenticatedPermitDigest = createMigrationDigest(inputs.permit)
    requireActive(signal)

    const stageVerificationKey = copyAuthenticationKey(
      runtimeAuthenticationKey,
    )
    const stagePublicationVerificationKey = copyAuthenticationKey(
      publicationAuthenticationKey,
    )
    let stageChain: WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence
    try {
      stageChain = captured.deriveStageChain({
        manifestBytes: inputs.stageReceiptManifestBytes,
        receiptBytes: inputs.stageReceiptBytes,
        verificationKey: stageVerificationKey,
        publicationVerificationKey: stagePublicationVerificationKey,
        expectedPermitDigest: authenticatedPermitDigest,
      })
    } finally {
      zeroize(stageVerificationKey)
      zeroize(stagePublicationVerificationKey)
    }
    const reconciliationContexts =
      captured.readStageReconciliationContexts(stageChain)
    const reconciliationVerificationKey = copyAuthenticationKey(
      runtimeAuthenticationKey,
    )
    const reconciliationPublicationVerificationKey = copyAuthenticationKey(
      publicationAuthenticationKey,
    )
    let reconciliation:
      WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence
    try {
      reconciliation = captured.finalizeReconciliation(
        createReconciliationEvidenceInput(
          reconciliationContexts,
          inputs.reconciliationAudits,
        ),
        reconciliationVerificationKey,
        reconciliationPublicationVerificationKey,
      )
    } finally {
      zeroize(reconciliationVerificationKey)
      zeroize(reconciliationPublicationVerificationKey)
    }
    requireActive(signal)

    const runtimeKey = copyAuthenticationKey(runtimeAuthenticationKey)
    try {
      runtime = await captured.createRateRuntime({
        segmentFile: configuration.finalRateSegmentFile,
        previousSegmentFile: requireLastValue(
          configuration.rateSegmentFiles,
        ),
        expectedPolicyVersion: inputs.ratePolicy.policyVersion,
        expectedConfigurationBindingDigest: configuration.configurationHash,
        authenticationKey: runtimeKey,
      })
    } finally {
      zeroize(runtimeKey)
    }
    requireActive(signal)

    const permitKey = copyAuthenticationKey(runtimeAuthenticationKey)
    try {
      session = await captured.createSession({
        requested: configuration.measure.resources,
        ratePolicy: inputs.ratePolicy,
        bootstrapRateCheckpoint: configuration.measure.rateBootstrap,
        recoverInterruptedCleanup:
          configuration.measure.rateRecoverInterruptedCleanup,
        recoverInterruptedAttempt:
          configuration.measure.rateRecoverInterruptedAttempt,
        rateRecorder: runtime.recorder,
        permit: inputs.permit,
        permitVerificationKey: permitKey,
        permitClock: captured.clock,
        ...(signal === undefined ? {} : { signal }),
      })
    } finally {
      zeroize(permitKey)
    }
    const activeSession = session
    /** Interrupts new rate admission when the caller aborts. */
    const abortListener = (): void => {
      try {
        activeSession.interruptDescribeTableRate()
      } catch {
        // Cleanup still closes the session through the stable failure path.
      }
    }
    if (signal !== undefined) {
      signal.addEventListener('abort', abortListener, { once: true })
      removeAbortListener = (): void =>
        signal.removeEventListener('abort', abortListener)
    }
    requireActive(signal)

    const measuredConfigurationHash =
      await activeSession.measureConfigurationHash()
    if (measuredConfigurationHash !== configuration.configurationHash) {
      return failPublicationCli('OPERATION_FAILED', 1)
    }
    requireActive(signal)
    await runtime.flush()
    await runtime.close()
    runtime = undefined
    requireActive(signal)

    const finalSegmentBytes = await captured.readRestrictedFile(
      configuration.finalRateSegmentFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
    )
    let rate: WorkspaceSearchMigrationRehearsalFinalizedRateEvidence
    try {
      const segmentBytes = Object.freeze([
        ...inputs.rateSegments,
        finalSegmentBytes,
      ])
      requireRateTotalBytes(segmentBytes)
      const finalizerKey = copyAuthenticationKey(runtimeAuthenticationKey)
      try {
        rate = captured.finalizeRate({
          segments: segmentBytes,
          authenticationKey: finalizerKey,
          expectedPolicyVersion: inputs.ratePolicy.policyVersion,
          expectedConfigurationBindingDigest: configuration.configurationHash,
          durableEvidence: activeSession.readDescribeTableRateEvidence(),
        })
      } finally {
        zeroize(finalizerKey)
      }
    } finally {
      zeroize(finalSegmentBytes)
    }
    const completedAt = readTrustedTimestamp(captured.clock)
    requireActive(signal)
    const alarmSignalVerificationKey = copyAuthenticationKey(
      runtimeAuthenticationKey,
    )
    const alarmPublicationVerificationKey = copyAuthenticationKey(
      publicationAuthenticationKey,
    )
    let suite: WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation
    try {
      suite = captured.assembleSuite({
        document: inputs.suiteDocument,
        alarmArtifactBytes: inputs.alarmArtifactBytes,
        alarmPublicationVerificationKey,
        alarmSignalVerificationKey,
        stageChain,
        reconciliation,
        rate,
        completedAt,
      })
    } finally {
      zeroize(alarmSignalVerificationKey)
      zeroize(alarmPublicationVerificationKey)
    }
    const signingKey = copyAuthenticationKey(publicationAuthenticationKey)
    session = undefined
    try {
      result = await captured.publishSuite({
        suite,
        session: activeSession,
        evidenceSigningKey: signingKey,
        clock: captured.clock,
        requestTimeoutMilliseconds: configuration.requestTimeoutMilliseconds,
      })
    } finally {
      zeroize(signingKey)
    }
  } catch (error: unknown) {
    failed = true
    primaryFailure = error
  }

  removeAbortListener?.()
  const closeFailed = await closeOwnedCapabilities(runtime, session)
  zeroize(masterKey)
  zeroize(runtimeAuthenticationKey)
  zeroize(publicationAuthenticationKey)
  zeroizeRestrictedPublicationInputs(restrictedInputs)
  if (output === undefined) {
    output = captureOutputDependencies(dependencies)
  }

  if (failed) {
    const failure = normalizePublicationCliFailure(primaryFailure, signal)
    output.writeStderrLine(serializeCanonicalJson({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_CLI_RESULT_KIND,
      status: 'error',
      code: failure.code,
    }))
    return failure.exitCode
  }
  if (closeFailed) {
    output.writeStderrLine(serializeCanonicalJson({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_CLI_RESULT_KIND,
      status: 'error',
      code: 'CAPABILITY_CLOSE_FAILED',
    }))
    return 1
  }
  if (result === undefined) {
    output.writeStderrLine(serializeCanonicalJson({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_CLI_RESULT_KIND,
      status: 'error',
      code: 'OPERATION_FAILED',
    }))
    return 1
  }
  output.writeStdoutLine(serializeCanonicalJson(result))
  return 0
}

/** Complete secure input snapshot read before AWS composition. */
type RestrictedPublicationInputs = {
  /** Canonical untrusted suite prestage document. */
  readonly suiteDocument: unknown
  /** Exact complete canonical alarm artifact bytes. */
  readonly alarmArtifactBytes: Uint8Array
  /** Canonical authenticated main permit document. */
  readonly permit: unknown
  /** Owned 32-byte rehearsal master key retained only through derivation. */
  readonly authenticationKey: Uint8Array
  /** Exact canonical authenticated stage receipt manifest bytes. */
  readonly stageReceiptManifestBytes: Uint8Array
  /** Exact canonical authenticated stage receipt bytes in global order. */
  readonly stageReceiptBytes: readonly Uint8Array[]
  /** Eight untrusted reconciliation artifacts in canonical scenario order. */
  readonly reconciliationAudits: readonly Uint8Array[]
  /** Strict digest-bound DescribeTable policy. */
  readonly ratePolicy: ReturnType<
    typeof parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument
  >
  /** Ordered exact existing segment bytes. */
  readonly rateSegments: readonly Uint8Array[]
}

/** Pairs eight trusted stage contexts with exact ordered restricted files. */
function createReconciliationEvidenceInput(
  contexts:
    readonly WorkspaceSearchMigrationRehearsalReconciliationAuditContext[],
  artifactBytes: readonly Uint8Array[],
): FinalizeWorkspaceSearchMigrationRehearsalReconciliationEvidenceInput {
  if (
    contexts.length !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS.length ||
    artifactBytes.length !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS.length
  ) {
    return failPublicationCli('OPERATION_FAILED', 1)
  }
  const artifacts:
    WorkspaceSearchMigrationRehearsalReconciliationArtifactExpectation[] = []
  for (let index = 0; index < contexts.length; index += 1) {
    const expectedContext = contexts[index]
    const bytes = artifactBytes[index]
    const scenario =
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS[index]
    if (
      expectedContext === undefined ||
      bytes === undefined ||
      scenario === undefined ||
      expectedContext.scenario !== scenario
    ) {
      return failPublicationCli('OPERATION_FAILED', 1)
    }
    artifacts.push(Object.freeze({
      artifactBytes: bytes,
      expectedContext,
    }))
  }
  return Object.freeze({ artifacts: Object.freeze(artifacts) })
}

/** Overwrites every retained restricted byte buffer after final cleanup. */
function zeroizeRestrictedPublicationInputs(
  value: RestrictedPublicationInputs | undefined,
): void {
  if (value === undefined) return
  zeroize(value.alarmArtifactBytes)
  zeroize(value.authenticationKey)
  zeroize(value.stageReceiptManifestBytes)
  for (const bytes of value.stageReceiptBytes) zeroize(bytes)
  for (const bytes of value.reconciliationAudits) zeroize(bytes)
  for (const bytes of value.rateSegments) zeroize(bytes)
}

/** Reads and validates every restricted input before creating AWS capability. */
async function readAllRestrictedInputs(
  configuration: WorkspaceSearchMigrationRehearsalPublicationCliArguments,
  dependencies: WorkspaceSearchMigrationRehearsalPublicationCliDependencies,
): Promise<RestrictedPublicationInputs> {
  const ownedBuffers: Uint8Array[] = []
  let completed = false
  /** Reads and records one buffer so every exceptional path overwrites it. */
  const readOwned = async (
    path: string,
    maximumBytes: number,
  ): Promise<Uint8Array> => {
    const bytes = await dependencies.readRestrictedFile(path, maximumBytes)
    ownedBuffers.push(bytes)
    return bytes
  }
  try {
    const suiteBytes = await readOwned(
      configuration.suiteInputFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRESTAGE_MAX_BYTES,
    )
    let suiteDocument: unknown
    try {
      suiteDocument = parseCanonicalJson(suiteBytes)
    } finally {
      zeroize(suiteBytes)
    }
    const alarmArtifactBytes = await readOwned(
      configuration.alarmArtifactFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ARTIFACT_MAX_BYTES,
    )
    const permitBytes = await readOwned(
      configuration.permitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAIN_PERMIT_MAX_BYTES,
    )
    let permit: unknown
    try {
      permit = parseCanonicalJson(permitBytes)
    } finally {
      zeroize(permitBytes)
    }
    const authenticationKeyBytes = await readOwned(
      configuration.authenticationKeyFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
    )
    const authenticationKey = copyAuthenticationKey(authenticationKeyBytes)
    ownedBuffers.push(authenticationKey)
    zeroize(authenticationKeyBytes)
    const stageReceiptManifestBytes = await readOwned(
      configuration.stageReceiptManifestFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
    )
    const stageReceiptBytes: Uint8Array[] = []
    for (const path of configuration.stageReceiptFiles) {
      stageReceiptBytes.push(await readOwned(
        path,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
      ))
    }
    const reconciliationAudits: Uint8Array[] = []
    for (const path of configuration.reconciliationAuditFiles) {
      reconciliationAudits.push(await readOwned(
        path,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES,
      ))
    }
    const ratePolicyBytes = await readOwned(
      configuration.measure.ratePolicyFile,
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
    )
    let ratePolicy: ReturnType<
      typeof parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument
    >
    try {
      ratePolicy =
        parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
          ratePolicyBytes,
        )
    } finally {
      zeroize(ratePolicyBytes)
    }
    const rateSegments: Uint8Array[] = []
    let totalBytes = 0
    for (const path of configuration.rateSegmentFiles) {
      const bytes = await readOwned(
        path,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
      )
      totalBytes += bytes.byteLength
      if (
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_TOTAL_BYTES
      ) {
        return failPublicationCli('INPUT_FILE_INVALID', 2)
      }
      rateSegments.push(bytes)
    }
    const inputs = Object.freeze({
      suiteDocument,
      alarmArtifactBytes,
      permit,
      authenticationKey,
      stageReceiptManifestBytes,
      stageReceiptBytes: Object.freeze(stageReceiptBytes),
      reconciliationAudits: Object.freeze(reconciliationAudits),
      ratePolicy,
      rateSegments: Object.freeze(rateSegments),
    })
    completed = true
    return inputs
  } finally {
    if (!completed) {
      for (const bytes of ownedBuffers) zeroize(bytes)
    }
  }
}

/**
 * Reads one finite stable mode-0600 current-owner regular file.
 *
 * The descriptor is opened with `O_NOFOLLOW`; device, inode, size, mode,
 * owner, hard-link count, mtime, and ctime must remain unchanged through the
 * complete read. A close failure also rejects the input.
 *
 * @param path - Exact local restricted input path.
 * @param maximumBytes - Inclusive positive byte ceiling.
 * @returns Detached exact file bytes.
 */
export async function readWorkspaceSearchMigrationRehearsalRestrictedInputFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const safePath = readPath(path)
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > maximumRestrictedPublicationInputBytes
  ) {
    return failPublicationCli('INPUT_FILE_INVALID', 2)
  }
  const getUserId = process.getuid
  if (typeof getUserId !== 'function' || nodeUtilTypes.isProxy(getUserId)) {
    return failPublicationCli('INPUT_FILE_INVALID', 2)
  }
  let userId: number
  try {
    userId = Reflect.apply(getUserId, process, [])
  } catch {
    return failPublicationCli('INPUT_FILE_INVALID', 2)
  }
  if (!Number.isSafeInteger(userId) || userId < 0) {
    return failPublicationCli('INPUT_FILE_INVALID', 2)
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      safePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    )
  } catch {
    return failPublicationCli('INPUT_FILE_UNREADABLE', 2)
  }
  let bytes: Uint8Array | undefined
  let readFailure: unknown
  try {
    const initial = await handle.stat({ bigint: true })
    const identity = readRestrictedInputIdentity(initial, userId, maximumBytes)
    const byteLength = Number(identity.size)
    const buffer = Buffer.alloc(byteLength)
    let offset = 0
    while (offset < byteLength) {
      const read = await handle.read(
        buffer,
        offset,
        byteLength - offset,
        offset,
      )
      if (read.bytesRead <= 0) {
        return failPublicationCli('INPUT_FILE_INVALID', 2)
      }
      offset += read.bytesRead
    }
    const final = await handle.stat({ bigint: true })
    if (!sameRestrictedInputIdentity(identity, final, offset)) {
      return failPublicationCli('INPUT_FILE_INVALID', 2)
    }
    bytes = new Uint8Array(buffer)
  } catch (error: unknown) {
    readFailure = error
  }
  let closeFailed = false
  try {
    await handle.close()
  } catch {
    closeFailed = true
  }
  if (readFailure instanceof WorkspaceSearchMigrationRehearsalPublicationCliError) {
    throw readFailure
  }
  if (readFailure !== undefined || closeFailed || bytes === undefined) {
    return failPublicationCli('INPUT_FILE_UNREADABLE', 2)
  }
  return bytes
}

/** Reads and validates one descriptor's initial restricted identity. */
function readRestrictedInputIdentity(
  value: BigIntStats,
  expectedUserId: number,
  maximumBytes: number,
): RestrictedInputIdentity {
  if (
    !value.isFile() ||
    value.size <= 0n ||
    value.size > BigInt(maximumBytes) ||
    (value.mode & 0o7777n) !== BigInt(restrictedInputMode) ||
    value.uid !== BigInt(expectedUserId) ||
    value.nlink !== 1n
  ) {
    return failPublicationCli('INPUT_FILE_INVALID', 2)
  }
  return Object.freeze({
    device: value.dev,
    inode: value.ino,
    size: value.size,
    mode: value.mode,
    userId: value.uid,
    linkCount: value.nlink,
    modifiedAtNanoseconds: value.mtimeNs,
    changedAtNanoseconds: value.ctimeNs,
  })
}

/** Requires the descriptor identity and exact length to remain unchanged. */
function sameRestrictedInputIdentity(
  expected: RestrictedInputIdentity,
  value: BigIntStats,
  bytesRead: number,
): boolean {
  return value.isFile() &&
    value.dev === expected.device &&
    value.ino === expected.inode &&
    value.size === expected.size &&
    value.mode === expected.mode &&
    value.uid === expected.userId &&
    value.nlink === expected.linkCount &&
    value.mtimeNs === expected.modifiedAtNanoseconds &&
    value.ctimeNs === expected.changedAtNanoseconds &&
    value.size === BigInt(bytesRead)
}

/** Creates a capability-minimized receiver-preserving real session. */
async function createFinalPublicationSession(
  input: CreateAwsWorkspaceSearchMigrationNonProductionRehearsalSessionInput,
): Promise<WorkspaceSearchMigrationRehearsalFinalPublicationSession> {
  const session =
    await createAwsWorkspaceSearchMigrationNonProductionRehearsalSession(input)
  return projectFinalPublicationSession(session)
}

/** Projects the full migration session onto final measurement/publication only. */
function projectFinalPublicationSession(
  session: WorkspaceSearchMigrationNonProductionRehearsalAwsSession,
): WorkspaceSearchMigrationRehearsalFinalPublicationSession {
  return Object.freeze({
    measureConfigurationHash: async (): Promise<string> =>
      createWorkspaceSearchConfigurationHash(
        await session.measureConfiguration(),
      ),
    interruptDescribeTableRate: (): void =>
      session.interruptDescribeTableRate(),
    createRehearsalArtifactPublisher: (
      input: Parameters<
        WorkspaceSearchMigrationRehearsalPublicationSession[
          'createRehearsalArtifactPublisher'
        ]
      >[0],
    ) =>
      session.createRehearsalArtifactPublisher(input),
    createRehearsalEvidencePublisher: (
      input: Parameters<
        WorkspaceSearchMigrationRehearsalPublicationSession[
          'createRehearsalEvidencePublisher'
        ]
      >[0],
    ) =>
      session.createRehearsalEvidencePublisher(input),
    readRehearsalEvidenceSessionBinding: () =>
      session.readRehearsalEvidenceSessionBinding(),
    readDescribeTableRateEvidence: () =>
      session.readDescribeTableRateEvidence(),
    readRehearsalPermitValidity: () =>
      session.readRehearsalPermitValidity(),
    close: async (): Promise<void> => await session.close(),
  })
}

/**
 * Authenticates exact raw stage documents and derives the complete chain.
 *
 * The transferred key is overwritten before the function settles. Parsers
 * require exact canonical JSON bytes and authenticate every document before
 * the chain verifier correlates the reviewed entries and receipts.
 *
 * @param input - Raw manifest, globally ordered receipts, and owned key.
 * @returns Complete authenticated eight-scenario stage-chain evidence.
 */
function derivePublicationStageChainEvidence(
  input: WorkspaceSearchMigrationRehearsalPublicationStageChainInput,
): WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence {
  let workingKey: Uint8Array | undefined
  let publicationWorkingKey: Uint8Array | undefined
  try {
    workingKey = copyAuthenticationKey(input.verificationKey)
    publicationWorkingKey = copyAuthenticationKey(
      input.publicationVerificationKey,
    )
    const receiptVerificationKey = workingKey
    const lifecycleVerificationKey = publicationWorkingKey
    zeroize(input.verificationKey)
    zeroize(input.publicationVerificationKey)
    const manifest =
      parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
        input.manifestBytes,
        receiptVerificationKey,
      )
    if (
      manifest.evidenceKeyDigest !== createHash('sha256')
        .update(receiptVerificationKey)
        .digest('hex') ||
      manifest.publicationKeyDigest !== createHash('sha256')
        .update(lifecycleVerificationKey)
        .digest('hex') ||
      manifest.permitDigest !== input.expectedPermitDigest
    ) {
      return failPublicationCli('OPERATION_FAILED', 1)
    }
    const receipts = input.receiptBytes.map((bytes) =>
      parseWorkspaceSearchMigrationRehearsalStageReceiptDocument(
        bytes,
        receiptVerificationKey,
      ))
    return deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
      manifest,
      receipts,
      verificationKey: receiptVerificationKey,
      publicationVerificationKey: lifecycleVerificationKey,
    })
  } finally {
    zeroize(workingKey)
    zeroize(publicationWorkingKey)
    zeroize(input.verificationKey)
    zeroize(input.publicationVerificationKey)
  }
}

/** Captures direct injectable effects before any untrusted await. */
function captureDependencies(
  value: WorkspaceSearchMigrationRehearsalPublicationCliDependencies,
): WorkspaceSearchMigrationRehearsalPublicationCliDependencies {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  let snapshot: WorkspaceSearchMigrationRehearsalPublicationCliDependencies
  try {
    snapshot = {
      readRestrictedFile: value.readRestrictedFile,
      createRateRuntime: value.createRateRuntime,
      createSession: value.createSession,
      finalizeRate: value.finalizeRate,
      deriveStageChain: value.deriveStageChain,
      verifyPermit: value.verifyPermit,
      readStageReconciliationContexts:
        value.readStageReconciliationContexts,
      finalizeReconciliation: value.finalizeReconciliation,
      assembleSuite: value.assembleSuite,
      publishSuite: value.publishSuite,
      clock: value.clock,
      writeStdoutLine: value.writeStdoutLine,
      writeStderrLine: value.writeStderrLine,
    }
  } catch {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  for (const dependency of Object.values(snapshot)) {
    if (!isDirectFunction(dependency)) {
      return failPublicationCli('INVALID_USAGE', 2)
    }
  }
  return Object.freeze(snapshot)
}

/** Captures only output effects for a dependency-validation failure. */
function captureOutputDependencies(
  value: WorkspaceSearchMigrationRehearsalPublicationCliDependencies,
): Pick<
  WorkspaceSearchMigrationRehearsalPublicationCliDependencies,
  'writeStderrLine' | 'writeStdoutLine'
> {
  try {
    if (
      isDirectFunction(value.writeStdoutLine) &&
      isDirectFunction(value.writeStderrLine)
    ) {
      return Object.freeze({
        writeStdoutLine: value.writeStdoutLine,
        writeStderrLine: value.writeStderrLine,
      })
    }
  } catch {
    // Fall through to process-owned stable output functions.
  }
  return Object.freeze({
    writeStdoutLine: (line: string): void => console.log(line),
    writeStderrLine: (line: string): void => console.error(line),
  })
}

/** Returns whether one dependency is callable without a Proxy apply trap. */
function isDirectFunction(value: unknown): value is (...input: never[]) => unknown {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/** Parses exact canonical JSON bytes without widening the value. */
function parseCanonicalJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    if (serializeCanonicalJson(value) !== text) {
      return failPublicationCli('INPUT_FILE_INVALID', 2)
    }
    return value
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalPublicationCliError) {
      throw error
    }
    return failPublicationCli('INPUT_FILE_INVALID', 2)
  }
}

/** Copies one exact owned authentication key. */
function copyAuthenticationKey(value: Uint8Array): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPublicationCli('INPUT_FILE_INVALID', 2)
  }
  try {
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
    const bufferGetter = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'buffer',
    )?.get
    const byteLengthGetter = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'byteLength',
    )?.get
    if (
      typeof bufferGetter !== 'function' ||
      typeof byteLengthGetter !== 'function' ||
      nodeUtilTypes.isProxy(bufferGetter) ||
      nodeUtilTypes.isProxy(byteLengthGetter)
    ) {
      return failPublicationCli('INPUT_FILE_INVALID', 2)
    }
    const buffer: unknown = Reflect.apply(bufferGetter, value, [])
    const byteLength: unknown = Reflect.apply(byteLengthGetter, value, [])
    if (
      nodeUtilTypes.isSharedArrayBuffer(buffer) ||
      byteLength !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES
    ) {
      return failPublicationCli('INPUT_FILE_INVALID', 2)
    }
    const copied = new Uint8Array(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
    )
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
    return copied
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalPublicationCliError) {
      throw error
    }
    return failPublicationCli('INPUT_FILE_INVALID', 2)
  }
}

/** Requires all existing and fresh segment bytes to fit the global ceiling. */
function requireRateTotalBytes(segments: readonly Uint8Array[]): void {
  let total = 0
  for (const segment of segments) {
    total += segment.byteLength
    if (
      !Number.isSafeInteger(total) ||
      total > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_TOTAL_BYTES
    ) {
      return failPublicationCli('INPUT_FILE_INVALID', 2)
    }
  }
}

/** Returns the required final value of one nonempty vector. */
function requireLastValue(values: readonly string[]): string {
  const value = values.at(-1)
  if (value === undefined) return failPublicationCli('INVALID_USAGE', 2)
  return value
}

/** Rejects key/artifact path reuse before any restricted input is opened. */
function requireUniqueReconciliationInputPaths(
  artifactFiles: readonly string[],
): void {
  const paths = new Set<string>(artifactFiles)
  if (paths.size !== artifactFiles.length) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
}

/** Detaches the two exact key digests from locally authenticated claims. */
function readPermitKeyBindings(
  value: unknown,
): WorkspaceSearchMigrationRehearsalPublicationPermitKeyBindings {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPublicationCli('OPERATION_FAILED', 1)
  }
  let keys: string[]
  let evidenceKeyDigest: unknown
  let publicationKeyDigest: unknown
  try {
    keys = Object.keys(value)
    evidenceKeyDigest = Reflect.get(value, 'evidenceKeyDigest')
    publicationKeyDigest = Reflect.get(value, 'publicationKeyDigest')
  } catch {
    return failPublicationCli('OPERATION_FAILED', 1)
  }
  if (
    !keys.includes('evidenceKeyDigest') ||
    !keys.includes('publicationKeyDigest') ||
    !isHexDigest(evidenceKeyDigest) ||
    !isHexDigest(publicationKeyDigest)
  ) {
    return failPublicationCli('OPERATION_FAILED', 1)
  }
  return Object.freeze({ evidenceKeyDigest, publicationKeyDigest })
}

/** Reads one positive bounded decimal integer. */
function readPositiveInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  return parsed
}

/** Reads one bounded nonempty path without resolving or exposing it. */
function readPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumPublicationPathLength ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  return value
}

/** Copies every argument exactly once before positional parsing. */
function snapshotArguments(arguments_: readonly string[]): readonly string[] {
  if (!Array.isArray(arguments_) || nodeUtilTypes.isProxy(arguments_)) {
    return failPublicationCli('INVALID_USAGE', 2)
  }
  const snapshot: string[] = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index]
    if (typeof value !== 'string') {
      return failPublicationCli('INVALID_USAGE', 2)
    }
    snapshot.push(value)
  }
  return Object.freeze(snapshot)
}

/** Reads one finite native trusted Date into a detached value. */
function readTrustedDate(clock: () => Date): Date {
  let value: unknown
  let epoch: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
    epoch = Date.prototype.getTime.call(value)
  } catch {
    return failPublicationCli('OPERATION_FAILED', 1)
  }
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch)) {
    return failPublicationCli('OPERATION_FAILED', 1)
  }
  return new Date(epoch)
}

/** Reads one native trusted Date as a canonical UTC timestamp. */
function readTrustedTimestamp(clock: () => Date): string {
  return readTrustedDate(clock).toISOString()
}

/** Throws the stable cooperative interruption boundary when aborted. */
function requireActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    return failPublicationCli('INTERRUPTED', 130)
  }
}

/** Attempts runtime and session cleanup while preserving the primary failure. */
async function closeOwnedCapabilities(
  runtime: WorkspaceSearchMigrationRehearsalRateRuntime | undefined,
  session: WorkspaceSearchMigrationRehearsalFinalPublicationSession | undefined,
): Promise<boolean> {
  let failed = false
  if (runtime !== undefined) {
    try {
      await runtime.close()
    } catch {
      failed = true
    }
  }
  if (session !== undefined) {
    try {
      await session.close()
    } catch {
      failed = true
    }
  }
  return failed
}

/** Overwrites one owned authentication key without exposing prior bytes. */
function zeroize(value: Uint8Array | undefined): void {
  if (value === undefined || nodeUtilTypes.isProxy(value)) return
  try {
    Uint8Array.prototype.fill.call(value, 0)
  } catch {
    // Stable failure handling must never reflect secret bytes.
  }
}

/** Maps every lower-level failure to the raw-value-free CLI surface. */
function normalizePublicationCliFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): WorkspaceSearchMigrationRehearsalPublicationCliError {
  if (signal?.aborted === true) {
    return new WorkspaceSearchMigrationRehearsalPublicationCliError(
      'INTERRUPTED',
      130,
    )
  }
  if (error instanceof WorkspaceSearchMigrationRehearsalPublicationCliError) {
    return error
  }
  return new WorkspaceSearchMigrationRehearsalPublicationCliError(
    'OPERATION_FAILED',
    1,
  )
}

/** Raises one stable final-publication CLI failure. */
function failPublicationCli(
  code: WorkspaceSearchMigrationRehearsalPublicationCliFailureCode,
  exitCode: WorkspaceSearchMigrationRehearsalPublicationCliExitCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalPublicationCliError(
    code,
    exitCode,
  )
}

/** Runs the direct executable with cooperative SIGINT/SIGTERM containment. */
async function runDirectPublicationCli(): Promise<void> {
  const controller = new AbortController()
  let signalExitCode: 130 | 143 = 130
  /** Records the shell signal status and aborts the active operation. */
  const interrupt = (exitCode: 130 | 143): void => {
    signalExitCode = exitCode
    controller.abort()
  }
  /** Handles SIGINT through the shared containment path. */
  const onSigint = (): void => interrupt(130)
  /** Handles SIGTERM through the shared containment path. */
  const onSigterm = (): void => interrupt(143)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    const exitCode = await runWorkspaceSearchMigrationRehearsalPublicationCli(
      process.argv.slice(2),
      defaultPublicationCliDependencies,
      controller.signal,
    )
    process.exitCode = exitCode === 130 ? signalExitCode : exitCode
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

if (import.meta.main) {
  await runDirectPublicationCli()
}
