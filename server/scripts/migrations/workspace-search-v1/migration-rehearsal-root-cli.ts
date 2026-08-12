import { timingSafeEqual } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import {
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
  parseCrossDomainIntegrityResourceAttestation,
  serializeCrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import { serializeCanonicalJson } from './migration-contract'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
} from './migration-describe-table-rate-policy'
import {
  createAwsWorkspaceSearchMigrationRehearsalPrePermitRootSession,
} from './migration-identity-aws'
import {
  finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootBytes,
  serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
  WorkspaceSearchMigrationRehearsalPrivateInputError,
} from './migration-rehearsal-private-input'
import {
  createWorkspaceSearchMigrationRehearsalRateRuntime,
  type CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  type WorkspaceSearchMigrationRehearsalRateRuntime,
} from './migration-rehearsal-rate-runtime'
import {
  parseWorkspaceSearchMigrationRehearsalRootPlanDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalRootPlan,
} from './migration-rehearsal-root-plan'
import {
  measureWorkspaceSearchMigrationRehearsalRootConfiguration,
} from './migration-rehearsal-root-measurement'
import type {
  WorkspaceSearchMigrationRehearsalPrePermitRootSession,
} from './migration-rehearsal-pre-permit-root-session'

/** Stable result discriminator for the owner-only root executable. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-root-cli-result'

/** Exact byte length of the distinct private resource-identity key. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_INTEGRITY_KEY_BYTES = 32

/** Strict ordered operator inputs admitted by the root executable. */
export type WorkspaceSearchMigrationRehearsalRootCliArguments = {
  /** Exact canonical owner-only root-plan input path. */
  readonly rootPlanFile: string
  /** Exact canonical reviewed rate-policy input path. */
  readonly ratePolicyFile: string
  /** Exact raw owner-only rehearsal master-key input path. */
  readonly rehearsalAuthenticationKeyFile: string
  /** Exact raw distinct integrity-digest-key input path. */
  readonly integrityDigestKeyFile: string
  /** Fresh exclusive ordinal-zero rate-segment output path. */
  readonly rootRateSegmentFile: string
  /** Fresh exclusive private resource-attestation output path. */
  readonly resourceAttestationOutputFile: string
  /** Fresh exclusive owner-only integrity-root output path. */
  readonly integrityRootOutputFile: string
  /** Exact reviewed acknowledgement for root bootstrap. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL
}

/** Supported exact private artifact formats at the durable output boundary. */
export type WorkspaceSearchMigrationRehearsalRootCliPrivateOutputFormat =
  | 'integrity-root'
  | 'resource-attestation'

/** One exact immutable publication request for the private output boundary. */
export type WorkspaceSearchMigrationRehearsalRootCliPrivateOutputInput = {
  /** Absolute fresh final output path. */
  readonly path: string
  /** Exact canonical private artifact bytes. */
  readonly bytes: Uint8Array
  /** Exact serializer contract applied to the bytes. */
  readonly format:
    WorkspaceSearchMigrationRehearsalRootCliPrivateOutputFormat
}

/** Injectable trusted boundaries used by focused root CLI tests. */
export type WorkspaceSearchMigrationRehearsalRootCliDependencies = {
  /** Reads one stable owner-only single-link private input. */
  readonly readPrivateInputFile:
    typeof readWorkspaceSearchMigrationRehearsalPrivateInputFile
  /** Strictly parses exact canonical root-plan bytes. */
  readonly parseRootPlan:
    typeof parseWorkspaceSearchMigrationRehearsalRootPlanDocument
  /** Strictly parses exact canonical reviewed rate-policy bytes. */
  readonly parseRatePolicy:
    typeof parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument
  /** Derives purpose-separated runtime and publication keys. */
  readonly deriveKeys: typeof deriveWorkspaceSearchMigrationRehearsalKeys
  /** Creates the fresh ordinal-zero durable rate runtime. */
  readonly createRateRuntime: (
    input: CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalRateRuntime>
  /** Creates the dedicated owner-only AWS root session. */
  readonly createRootSession:
    typeof createAwsWorkspaceSearchMigrationRehearsalPrePermitRootSession
  /** Performs the causal first six-call configuration measurement. */
  readonly measureRootConfiguration: (
    input: unknown,
  ) => Promise<{
    /** Exact measured configuration reference. */
    readonly configuration: unknown
    /** One-shot causal measurement capability. */
    readonly capability: unknown
  }>
  /** Authenticates the exact ordinal-zero integrity interval. */
  readonly verifyIntegrityRateInterval: (input: unknown) => unknown
  /** Consumes all causal capabilities into the complete private root. */
  readonly finalizeIntegrityRoot: (input: unknown) => unknown
  /** Serializes the exact existing private attestation format. */
  readonly serializeResourceAttestation:
    typeof serializeCrossDomainIntegrityResourceAttestation
  /** Serializes canonical compact root JSON followed by one LF. */
  readonly serializeIntegrityRoot:
    typeof serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot
  /** Requires one final private path to remain absent before remote work. */
  readonly assertPrivateOutputAbsent: (path: string) => Promise<void>
  /** Durably creates one private output without replacement. */
  readonly publishPrivateOutput: (
    input: WorkspaceSearchMigrationRehearsalRootCliPrivateOutputInput,
  ) => Promise<void>
  /** Emits one canonical secret-free success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Emits one canonical raw-value-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable root CLI failure categories containing no raw operator values. */
export type WorkspaceSearchMigrationRehearsalRootCliFailureCode =
  | 'AUTHENTICATION_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INTERRUPTED'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'
  | 'OUTPUT_FAILED'

/** Stable process statuses returned by the root executable. */
export type WorkspaceSearchMigrationRehearsalRootCliExitCode =
  | 0
  | 1
  | 2
  | 130

/** Stable raw-value-free root CLI error. */
export class WorkspaceSearchMigrationRehearsalRootCliError extends Error {
  /** Stable machine-readable failure category. */
  readonly code: WorkspaceSearchMigrationRehearsalRootCliFailureCode

  /** Exact process status paired with the failure category. */
  readonly exitCode: WorkspaceSearchMigrationRehearsalRootCliExitCode

  /**
   * Creates one secret-free executable failure.
   *
   * @param code - Stable machine-readable category.
   * @param exitCode - Exact shell status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalRootCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalRootCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalRootCliError'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Detached exact identity of one newly opened private output inode. */
type RootCliPrivateOutputIdentity = {
  /** Device identifier. */
  readonly device: bigint
  /** Inode identifier. */
  readonly inode: bigint
  /** Complete native permission and file-type mode. */
  readonly mode: bigint
  /** Effective owning user identifier. */
  readonly userId: bigint
  /** Exact hard-link count. */
  readonly linkCount: bigint
}

/** Stable identity of one owner-only private output directory. */
type RootCliPrivateOutputDirectoryIdentity = {
  /** Device identifier. */
  readonly device: bigint
  /** Inode identifier. */
  readonly inode: bigint
  /** Complete native permission and file-type mode. */
  readonly mode: bigint
  /** Effective owning user identifier. */
  readonly userId: bigint
  /** Effective owning group identifier. */
  readonly groupId: bigint
}

/** Detached validated private-output request. */
type RootCliPrivateOutputSnapshot = {
  /** Absolute fresh final path. */
  readonly path: string
  /** Owned exact canonical bytes. */
  readonly bytes: Uint8Array
  /** Exact artifact format. */
  readonly format:
    WorkspaceSearchMigrationRehearsalRootCliPrivateOutputFormat
}

const privateOutputMode = 0o600
const privateOutputDirectoryMode = 0o700
const maximumRootCliPathLength = 4_096

/** Exact own callable surface accepted from injected dependencies. */
const rootCliDependencyKeys = Object.freeze([
  'assertPrivateOutputAbsent',
  'createRateRuntime',
  'createRootSession',
  'deriveKeys',
  'finalizeIntegrityRoot',
  'measureRootConfiguration',
  'parseRatePolicy',
  'parseRootPlan',
  'publishPrivateOutput',
  'readPrivateInputFile',
  'serializeIntegrityRoot',
  'serializeResourceAttestation',
  'verifyIntegrityRateInterval',
  'writeStderrLine',
  'writeStdoutLine',
])

/** Default production root CLI boundaries. */
const defaultRootCliDependencies:
  WorkspaceSearchMigrationRehearsalRootCliDependencies = Object.freeze({
    readPrivateInputFile:
      readWorkspaceSearchMigrationRehearsalPrivateInputFile,
    parseRootPlan:
      parseWorkspaceSearchMigrationRehearsalRootPlanDocument,
    parseRatePolicy:
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
    deriveKeys: deriveWorkspaceSearchMigrationRehearsalKeys,
    createRateRuntime:
      createWorkspaceSearchMigrationRehearsalRateRuntime,
    createRootSession:
      createAwsWorkspaceSearchMigrationRehearsalPrePermitRootSession,
    measureRootConfiguration:
      measureWorkspaceSearchMigrationRehearsalRootConfiguration,
    verifyIntegrityRateInterval:
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval,
    finalizeIntegrityRoot:
      finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
    serializeResourceAttestation:
      serializeCrossDomainIntegrityResourceAttestation,
    serializeIntegrityRoot:
      serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
    assertPrivateOutputAbsent:
      assertWorkspaceSearchMigrationRehearsalRootCliPrivateOutputAbsent,
    publishPrivateOutput:
      publishWorkspaceSearchMigrationRehearsalRootCliPrivateOutput,
    writeStdoutLine: (line): void => console.log(line),
    writeStderrLine: (line): void => console.error(line),
  })

/**
 * Parses the sole exact ordered root command without recovery vocabulary.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Frozen absolute distinct paths and exact approval.
 */
export function parseWorkspaceSearchMigrationRehearsalRootCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalRootCliArguments {
  let values: string[]
  try {
    if (
      !Array.isArray(arguments_) ||
      nodeUtilTypes.isProxy(arguments_) ||
      Object.getPrototypeOf(arguments_) !== Array.prototype ||
      arguments_.length !== 16
    ) return failRootCli('INVALID_USAGE', 2)
    const expectedKeys = Array.from(
      { length: arguments_.length },
      (_value, index) => String(index),
    )
    if (!sameRootCliKeys(Object.keys(arguments_), expectedKeys)) {
      return failRootCli('INVALID_USAGE', 2)
    }
    values = []
    for (let index = 0; index < arguments_.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        arguments_,
        String(index),
      )
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string'
      ) return failRootCli('INVALID_USAGE', 2)
      values.push(descriptor.value)
    }
  } catch {
    return failRootCli('INVALID_USAGE', 2)
  }
  if (
    values.some((value) =>
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > maximumRootCliPathLength ||
      value.includes('\0')
    ) ||
    values[0] !== '--root-plan-file' ||
    values[2] !== '--rate-policy-file' ||
    values[4] !== '--rehearsal-authentication-key-file' ||
    values[6] !== '--integrity-digest-key-file' ||
    values[8] !== '--root-rate-segment-file' ||
    values[10] !== '--resource-attestation-output-file' ||
    values[12] !== '--integrity-root-output-file' ||
    values[14] !== '--approval' ||
    values[15] !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL
  ) return failRootCli('INVALID_USAGE', 2)
  const rootPlanFile = readAbsoluteRootCliPath(values[1])
  const ratePolicyFile = readAbsoluteRootCliPath(values[3])
  const rehearsalAuthenticationKeyFile = readAbsoluteRootCliPath(values[5])
  const integrityDigestKeyFile = readAbsoluteRootCliPath(values[7])
  const rootRateSegmentFile = readAbsoluteRootCliPath(values[9])
  const resourceAttestationOutputFile = readAbsoluteRootCliPath(values[11])
  const integrityRootOutputFile = readAbsoluteRootCliPath(values[13])
  const paths = [
    rootPlanFile,
    ratePolicyFile,
    rehearsalAuthenticationKeyFile,
    integrityDigestKeyFile,
    rootRateSegmentFile,
    resourceAttestationOutputFile,
    integrityRootOutputFile,
  ]
  if (new Set(paths).size !== paths.length) {
    return failRootCli('INVALID_USAGE', 2)
  }
  return Object.freeze({
    rootPlanFile,
    ratePolicyFile,
    rehearsalAuthenticationKeyFile,
    integrityDigestKeyFile,
    rootRateSegmentFile,
    resourceAttestationOutputFile,
    integrityRootOutputFile,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL,
  })
}

/**
 * Executes the complete owner-only ordinal-zero pre-permit root.
 *
 * @param arguments_ - Exact ordered root command.
 * @param dependencies - Injectable trusted boundaries.
 * @param signal - Optional cooperative interruption signal.
 * @returns Stable process status after drainage and zeroization.
 */
export async function runWorkspaceSearchMigrationRehearsalRootCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalRootCliDependencies =
      defaultRootCliDependencies,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationRehearsalRootCliExitCode> {
  let runtime: WorkspaceSearchMigrationRehearsalRateRuntime | undefined
  let session:
    WorkspaceSearchMigrationRehearsalPrePermitRootSession | undefined
  let failed = false
  let primaryFailure: unknown
  let removeAbortListener: (() => void) | undefined
  const ownedBuffers: Uint8Array[] = []
  let output: Pick<
    WorkspaceSearchMigrationRehearsalRootCliDependencies,
    'writeStderrLine' | 'writeStdoutLine'
  > = defaultRootCliDependencies
  let capturedSignal: AbortSignal | undefined

  try {
    output = captureRootCliOutputDependencies(dependencies)
    const captured = captureRootCliDependencies(dependencies)
    capturedSignal = readRootCliSignal(signal)
    const configuration =
      parseWorkspaceSearchMigrationRehearsalRootCliArguments(arguments_)
    requireRootCliActive(capturedSignal)

    const planBytes = await readOwnedRootCliInput(
      captured,
      configuration.rootPlanFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_BYTES,
      ownedBuffers,
    )
    const plan = parseRootCliPlan(captured, planBytes)
    zeroizeRootCliBuffer(planBytes)

    const policyBytes = await readOwnedRootCliInput(
      captured,
      configuration.ratePolicyFile,
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES,
      ownedBuffers,
    )
    const ratePolicy = parseRootCliPolicy(captured, policyBytes)
    zeroizeRootCliBuffer(policyBytes)

    const masterKey = await readOwnedRootCliInput(
      captured,
      configuration.rehearsalAuthenticationKeyFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
      ownedBuffers,
    )
    const integrityKey = await readOwnedRootCliInput(
      captured,
      configuration.integrityDigestKeyFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_INTEGRITY_KEY_BYTES,
      ownedBuffers,
    )
    if (
      masterKey.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES ||
      integrityKey.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_INTEGRITY_KEY_BYTES
    ) return failRootCli('AUTHENTICATION_FAILED', 1)
    let derivedKeys: ReturnType<
      typeof deriveWorkspaceSearchMigrationRehearsalKeys
    >
    try {
      derivedKeys = captured.deriveKeys(masterKey)
    } catch {
      return failRootCli('AUTHENTICATION_FAILED', 1)
    }
    ownedBuffers.push(derivedKeys.runtimeKey, derivedKeys.publicationKey)
    requireRootCliKeySeparation([
      masterKey,
      integrityKey,
      derivedKeys.runtimeKey,
      derivedKeys.publicationKey,
    ])
    zeroizeRootCliBuffer(masterKey)
    requireRootCliActive(capturedSignal)

    await assertRootCliOutputAbsent(
      captured,
      configuration.resourceAttestationOutputFile,
    )
    await assertRootCliOutputAbsent(
      captured,
      configuration.integrityRootOutputFile,
    )
    requireRootCliActive(capturedSignal)

    try {
      runtime = await captured.createRateRuntime({
        segmentFile: configuration.rootRateSegmentFile,
        expectedPolicyVersion: ratePolicy.policyVersion,
        expectedConfigurationBindingDigest:
          plan.configurationBindingDigest,
        authenticationKey: derivedKeys.runtimeKey,
      })
    } catch {
      return failRootCli('OUTPUT_FAILED', 1)
    }
    requireRootCliActive(capturedSignal)
    session = await captured.createRootSession({
      rootPlan: plan.document,
      ratePolicy,
      rateRecorder: runtime.recorder,
      ...(capturedSignal === undefined ? {} : { signal: capturedSignal }),
    })
    const activeSession = session
    const abortListener = (): void => {
      try {
        activeSession.interrupt()
      } catch {
        // The common failure path still awaits complete session closure.
      }
    }
    if (capturedSignal !== undefined) {
      capturedSignal.addEventListener('abort', abortListener, { once: true })
      removeAbortListener = (): void =>
        capturedSignal?.removeEventListener('abort', abortListener)
    }

    requireRootCliActive(capturedSignal)
    const measurement = await captured.measureRootConfiguration({
      port: activeSession.takeMeasurementPort(),
      expectedConfigurationBindingDigest:
        plan.configurationBindingDigest,
    })
    requireRootCliActive(capturedSignal)
    const attestation = await activeSession.attestResources()
    requireRootCliActive(capturedSignal)
    const seal = await activeSession.seal()
    if (attestation !== seal.resourceAttestation) {
      return failRootCli('OPERATION_FAILED', 1)
    }
    requireRootCliActive(capturedSignal)
    const committedSegment = await runtime.flush()
    ownedBuffers.push(committedSegment.canonicalBytes)
    await runtime.close()
    runtime = undefined
    requireRootCliActive(capturedSignal)

    const rateBinding = captured.verifyIntegrityRateInterval({
      canonicalSegmentBytes: committedSegment.canonicalBytes,
      authenticationKey: derivedKeys.runtimeKey,
      predecessorSegmentBytes: null,
      expectedPolicyVersion: ratePolicy.policyVersion,
      expectedConfigurationBindingDigest:
        plan.configurationBindingDigest,
      expectedStartedAt: seal.startedAt,
      expectedCompletedAt: seal.completedAt,
      sequence: seal.sequence,
      taskResult: seal.resourceAttestation,
    })
    const attestationBytes = new TextEncoder().encode(
      captured.serializeResourceAttestation(attestation),
    )
    ownedBuffers.push(attestationBytes)
    await publishRootCliOutput(captured, {
      path: configuration.resourceAttestationOutputFile,
      bytes: attestationBytes,
      format: 'resource-attestation',
    })
    requireRootCliActive(capturedSignal)

    const root = captured.finalizeIntegrityRoot({
      rateBinding,
      measurementCapability: measurement.capability,
      measuredConfiguration: measurement.configuration,
      resourceAttestation: attestation,
      resourceAttestationBytes: attestationBytes,
      integrityDigestKey: integrityKey,
      rateAuthenticationKey: derivedKeys.runtimeKey,
      deploymentTargetId: plan.document.deploymentTargetId,
      deploymentTrustRootDigest: plan.deploymentTrustRootDigest,
      productionAccountDigest: plan.productionAccountDigest,
      account: plan.document.requestedResources.account,
      region: plan.document.requestedResources.region,
      callerArn: plan.document.expectedCallerArn,
      commit: plan.document.requestedResources.commit,
      requestedResourcesBinding: plan.requestedResourcesBinding,
      evidenceKeyDigest: derivedKeys.runtimeKeyDigest,
      publicationKeyDigest: derivedKeys.publicationKeyDigest,
      durableEvidence: seal.durableEvidence,
    })
    const rootBytes = new TextEncoder().encode(
      captured.serializeIntegrityRoot(root),
    )
    ownedBuffers.push(rootBytes)
    await publishRootCliOutput(captured, {
      path: configuration.integrityRootOutputFile,
      bytes: rootBytes,
      format: 'integrity-root',
    })
  } catch (error: unknown) {
    failed = true
    primaryFailure = error
  }

  try {
    removeAbortListener?.()
  } catch {
    // Listener cleanup cannot expose or replace the stable operation result.
  }
  if (failed) await drainRootCliCapabilities(session, runtime)
  for (const bytes of ownedBuffers) zeroizeRootCliBuffer(bytes)

  if (failed) {
    const failure = normalizeRootCliFailure(primaryFailure, capturedSignal)
    safelyWriteRootCliLine(output.writeStderrLine, serializeCanonicalJson({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_CLI_RESULT_KIND,
      status: 'error',
      code: failure.code,
    }))
    return failure.exitCode
  }
  safelyWriteRootCliLine(output.writeStdoutLine, serializeCanonicalJson({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_CLI_RESULT_KIND,
    status: 'succeeded',
  }))
  return 0
}

/** Snapshots only the two redacted result sinks without reading other fields. */
function captureRootCliOutputDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalRootCliDependencies,
): Pick<
  WorkspaceSearchMigrationRehearsalRootCliDependencies,
  'writeStderrLine' | 'writeStdoutLine'
> {
  try {
    if (
      nodeUtilTypes.isProxy(dependencies) ||
      Object.getPrototypeOf(dependencies) !== Object.prototype
    ) return defaultRootCliDependencies
    requireRootCliDependencyFunction(dependencies, 'writeStderrLine')
    requireRootCliDependencyFunction(dependencies, 'writeStdoutLine')
    const writeStderrLine = dependencies.writeStderrLine
    const writeStdoutLine = dependencies.writeStdoutLine
    return Object.freeze({
      writeStderrLine: (line) => writeStderrLine(line),
      writeStdoutLine: (line) => writeStdoutLine(line),
    })
  } catch {
    return defaultRootCliDependencies
  }
}

/**
 * Exclusively publishes one canonical private artifact and fsyncs its parent.
 *
 * @param input - Untrusted exact private-output request.
 */
export async function publishWorkspaceSearchMigrationRehearsalRootCliPrivateOutput(
  input: unknown,
): Promise<void> {
  const snapshot = readRootCliPrivateOutput(input)
  try {
    validateRootCliPrivateOutput(snapshot)
    await writeRootCliPrivateOutput(snapshot)
  } finally {
    zeroizeRootCliBuffer(snapshot.bytes)
  }
}

/**
 * Verifies one secure mode-0700 parent and absent final path before remote work.
 *
 * The check is intentionally read-only. Exclusive no-follow creation remains
 * the authoritative race-safe check at publication time.
 *
 * @param path - Absolute intended private final output path.
 */
export async function assertWorkspaceSearchMigrationRehearsalRootCliPrivateOutputAbsent(
  path: string,
): Promise<void> {
  const safePath = readAbsolutePrivateOutputPath(path)
  const userId = readRootCliUserId()
  await inspectRootCliPrivateOutputDirectory(dirname(safePath), userId, false)
  try {
    await lstat(safePath, { bigint: true })
  } catch (error: unknown) {
    if (readRootCliSystemErrorCode(error) === 'ENOENT') return
    return failRootCli('OUTPUT_FAILED', 1)
  }
  return failRootCli('OUTPUT_FAILED', 1)
}

/** Reads one absolute output path without changing its locator. */
function readAbsolutePrivateOutputPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumRootCliPathLength ||
    value.includes('\0')
  ) return failRootCli('OUTPUT_FAILED', 1)
  try {
    if (resolve(value) !== value) return failRootCli('OUTPUT_FAILED', 1)
  } catch {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  return value
}

/** Reads one own native system-error code without invoking an accessor. */
function readRootCliSystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || nodeUtilTypes.isProxy(error)) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'string'
  ) return undefined
  return descriptor.value
}

/** Reads one bounded path and normalizes it to an absolute locator. */
function readAbsoluteRootCliPath(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumRootCliPathLength ||
    value.includes('\0')
  ) return failRootCli('INVALID_USAGE', 2)
  let path: string
  try {
    path = resolve(value)
  } catch {
    return failRootCli('INVALID_USAGE', 2)
  }
  if (path.length === 0 || path.length > maximumRootCliPathLength) {
    return failRootCli('INVALID_USAGE', 2)
  }
  return path
}

/** Snapshots every callable dependency before processing private material. */
function captureRootCliDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalRootCliDependencies,
): WorkspaceSearchMigrationRehearsalRootCliDependencies {
  try {
    if (
      nodeUtilTypes.isProxy(dependencies) ||
      Object.getPrototypeOf(dependencies) !== Object.prototype ||
      !sameRootCliKeys(Object.keys(dependencies), rootCliDependencyKeys)
    ) {
      return failRootCli('OPERATION_FAILED', 1)
    }
    for (const key of rootCliDependencyKeys) {
      requireRootCliDependencyFunction(dependencies, key)
    }
    const readPrivateInputFile = dependencies.readPrivateInputFile
    const parseRootPlan = dependencies.parseRootPlan
    const parseRatePolicy = dependencies.parseRatePolicy
    const deriveKeys = dependencies.deriveKeys
    const createRateRuntime = dependencies.createRateRuntime
    const createRootSession = dependencies.createRootSession
    const measureRootConfiguration = dependencies.measureRootConfiguration
    const verifyIntegrityRateInterval =
      dependencies.verifyIntegrityRateInterval
    const finalizeIntegrityRoot = dependencies.finalizeIntegrityRoot
    const serializeResourceAttestation =
      dependencies.serializeResourceAttestation
    const serializeIntegrityRoot = dependencies.serializeIntegrityRoot
    const assertPrivateOutputAbsent =
      dependencies.assertPrivateOutputAbsent
    const publishPrivateOutput = dependencies.publishPrivateOutput
    const writeStdoutLine = dependencies.writeStdoutLine
    const writeStderrLine = dependencies.writeStderrLine
    return Object.freeze({
      readPrivateInputFile: (path, maximumBytes) =>
        readPrivateInputFile(path, maximumBytes),
      parseRootPlan: (bytes) => parseRootPlan(bytes),
      parseRatePolicy: (bytes) => parseRatePolicy(bytes),
      deriveKeys: (masterKey) => deriveKeys(masterKey),
      createRateRuntime: (input) => createRateRuntime(input),
      createRootSession: (input) => createRootSession(input),
      measureRootConfiguration: (input) =>
        measureRootConfiguration(input),
      verifyIntegrityRateInterval: (input) =>
        verifyIntegrityRateInterval(input),
      finalizeIntegrityRoot: (input) => finalizeIntegrityRoot(input),
      serializeResourceAttestation: (value) =>
        serializeResourceAttestation(value),
      serializeIntegrityRoot: (value) => serializeIntegrityRoot(value),
      assertPrivateOutputAbsent: (path) =>
        assertPrivateOutputAbsent(path),
      publishPrivateOutput: (input) => publishPrivateOutput(input),
      writeStdoutLine: (line) => writeStdoutLine(line),
      writeStderrLine: (line) => writeStderrLine(line),
    })
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalRootCliError) {
      throw error
    }
    return failRootCli('OPERATION_FAILED', 1)
  }
}

/** Requires one exact enumerable own data property to be a direct function. */
function requireRootCliDependencyFunction(
  dependencies: object,
  key: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'function' ||
    nodeUtilTypes.isProxy(descriptor.value)
  ) return failRootCli('OPERATION_FAILED', 1)
}

/** Requires the optional cancellation value to be one genuine native signal. */
function readRootCliSignal(
  signal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (signal === undefined) return undefined
  try {
    if (
      nodeUtilTypes.isProxy(signal) ||
      !(signal instanceof AbortSignal) ||
      Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
      typeof signal.aborted !== 'boolean'
    ) return failRootCli('OPERATION_FAILED', 1)
    return signal
  } catch {
    return failRootCli('OPERATION_FAILED', 1)
  }
}

/** Maps one final-output absence preflight to the stable output failure. */
async function assertRootCliOutputAbsent(
  dependencies: WorkspaceSearchMigrationRehearsalRootCliDependencies,
  path: string,
): Promise<void> {
  try {
    await dependencies.assertPrivateOutputAbsent(path)
  } catch {
    return failRootCli('OUTPUT_FAILED', 1)
  }
}

/** Reads and retains one exact private buffer for guaranteed zeroization. */
async function readOwnedRootCliInput(
  dependencies: WorkspaceSearchMigrationRehearsalRootCliDependencies,
  path: string,
  maximumBytes: number,
  ownedBuffers: Uint8Array[],
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readPrivateInputFile(path, maximumBytes)
  } catch (error: unknown) {
    if (
      error instanceof WorkspaceSearchMigrationRehearsalPrivateInputError &&
      error.code === 'INVALID_PRIVATE_INPUT'
    ) return failRootCli('INPUT_FILE_INVALID', 1)
    return failRootCli('INPUT_FILE_UNREADABLE', 1)
  }
  if (
    nodeUtilTypes.isProxy(bytes) ||
    Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
    nodeUtilTypes.isSharedArrayBuffer(bytes.buffer)
  ) return failRootCli('INPUT_FILE_INVALID', 1)
  ownedBuffers.push(bytes)
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    return failRootCli('INPUT_FILE_INVALID', 1)
  }
  return bytes
}

/** Maps a strict root-plan parse failure to the stable input boundary. */
function parseRootCliPlan(
  dependencies: WorkspaceSearchMigrationRehearsalRootCliDependencies,
  bytes: Uint8Array,
): WorkspaceSearchMigrationRehearsalRootPlan {
  try {
    return dependencies.parseRootPlan(bytes)
  } catch {
    return failRootCli('INPUT_FILE_INVALID', 1)
  }
}

/** Maps a strict rate-policy parse failure to the stable input boundary. */
function parseRootCliPolicy(
  dependencies: WorkspaceSearchMigrationRehearsalRootCliDependencies,
  bytes: Uint8Array,
): ReturnType<
  typeof parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument
> {
  try {
    return dependencies.parseRatePolicy(bytes)
  } catch {
    return failRootCli('INPUT_FILE_INVALID', 1)
  }
}

/** Requires every raw and derived root key to be pairwise distinct. */
function requireRootCliKeySeparation(keys: readonly Uint8Array[]): void {
  try {
    for (const key of keys) {
      if (
        key.byteLength !==
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES ||
        nodeUtilTypes.isProxy(key) ||
        nodeUtilTypes.isSharedArrayBuffer(key.buffer)
      ) return failRootCli('AUTHENTICATION_FAILED', 1)
    }
    for (let left = 0; left < keys.length; left += 1) {
      const leftKey = keys[left]
      if (leftKey === undefined) {
        return failRootCli('AUTHENTICATION_FAILED', 1)
      }
      for (let right = left + 1; right < keys.length; right += 1) {
        const rightKey = keys[right]
        if (
          rightKey === undefined ||
          timingSafeEqual(leftKey, rightKey)
        ) return failRootCli('AUTHENTICATION_FAILED', 1)
      }
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalRootCliError) {
      throw error
    }
    return failRootCli('AUTHENTICATION_FAILED', 1)
  }
}

/** Publishes one output while replacing lower-level details with one code. */
async function publishRootCliOutput(
  dependencies: WorkspaceSearchMigrationRehearsalRootCliDependencies,
  input: WorkspaceSearchMigrationRehearsalRootCliPrivateOutputInput,
): Promise<void> {
  try {
    await dependencies.publishPrivateOutput(input)
  } catch {
    return failRootCli('OUTPUT_FAILED', 1)
  }
}

/** Requires the optional cooperative cancellation signal to remain active. */
function requireRootCliActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) return failRootCli('INTERRUPTED', 130)
}

/** Interrupts and closes every capability retained by a failed root. */
async function drainRootCliCapabilities(
  session: WorkspaceSearchMigrationRehearsalPrePermitRootSession | undefined,
  runtime: WorkspaceSearchMigrationRehearsalRateRuntime | undefined,
): Promise<void> {
  if (session !== undefined) {
    try {
      session.interrupt()
    } catch {
      // Cleanup failure never replaces the primary stable result.
    }
    try {
      await session.close()
    } catch {
      // Cleanup failure never replaces the primary stable result.
    }
  }
  if (runtime !== undefined) {
    try {
      await runtime.close()
    } catch {
      // The retained exclusive segment remains ambiguous and is not removed.
    }
  }
}

/** Maps every lower-level error to the raw-value-free root CLI surface. */
function normalizeRootCliFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): WorkspaceSearchMigrationRehearsalRootCliError {
  if (signal?.aborted === true) {
    return new WorkspaceSearchMigrationRehearsalRootCliError(
      'INTERRUPTED',
      130,
    )
  }
  if (error instanceof WorkspaceSearchMigrationRehearsalRootCliError) {
    return error
  }
  return new WorkspaceSearchMigrationRehearsalRootCliError(
    'OPERATION_FAILED',
    1,
  )
}

/** Best-effort erases one owned exact byte buffer. */
function zeroizeRootCliBuffer(value: Uint8Array | undefined): void {
  zeroizeWorkspaceSearchMigrationRehearsalKey(value)
}

/** Emits one already-redacted line without altering root publication state. */
function safelyWriteRootCliLine(
  writeLine: (line: string) => void,
  line: string,
): void {
  try {
    writeLine(line)
  } catch {
    // Diagnostic output cannot roll back a durably published private root.
  }
}

/** Reads and copies one strict exact-shape private-output request. */
function readRootCliPrivateOutput(input: unknown): RootCliPrivateOutputSnapshot {
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeUtilTypes.isProxy(input) ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    !sameRootCliKeys(Object.keys(input), ['bytes', 'format', 'path'])
  ) return failRootCli('OUTPUT_FAILED', 1)
  const pathValue = readRootCliOwnValue(input, 'path')
  const formatValue = readRootCliOwnValue(input, 'format')
  const bytesValue = readRootCliOwnValue(input, 'bytes')
  if (
    typeof pathValue !== 'string' ||
    pathValue.length === 0 ||
    pathValue.length > maximumRootCliPathLength ||
    pathValue.includes('\0') ||
    resolve(pathValue) !== pathValue ||
    (formatValue !== 'integrity-root' &&
      formatValue !== 'resource-attestation') ||
    !(bytesValue instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytesValue) ||
    Object.getPrototypeOf(bytesValue) !== Uint8Array.prototype ||
    nodeUtilTypes.isSharedArrayBuffer(bytesValue.buffer)
  ) return failRootCli('OUTPUT_FAILED', 1)
  const maximumBytes = formatValue === 'integrity-root'
    ? WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES
    : CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES
  if (bytesValue.byteLength === 0 || bytesValue.byteLength > maximumBytes) {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  const bytes = new Uint8Array(bytesValue.byteLength)
  bytes.set(bytesValue)
  return Object.freeze({ path: pathValue, format: formatValue, bytes })
}

/** Validates exact serializer bytes before opening the output path. */
function validateRootCliPrivateOutput(
  snapshot: RootCliPrivateOutputSnapshot,
): void {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)
    if (snapshot.format === 'resource-attestation') {
      const parsed: unknown = JSON.parse(text)
      const attestation = parseCrossDomainIntegrityResourceAttestation(parsed)
      if (serializeCrossDomainIntegrityResourceAttestation(attestation) !== text) {
        return failRootCli('OUTPUT_FAILED', 1)
      }
      return
    }
    const root =
      parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootBytes(
        snapshot.bytes,
      )
    if (
      serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(root) !==
        text
    ) return failRootCli('OUTPUT_FAILED', 1)
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalRootCliError) {
      throw error
    }
    return failRootCli('OUTPUT_FAILED', 1)
  }
}

/** Exclusively writes, fsyncs, verifies, and closes one private output. */
async function writeRootCliPrivateOutput(
  snapshot: RootCliPrivateOutputSnapshot,
): Promise<void> {
  const userId = readRootCliUserId()
  const noFollow = readRootCliFileSystemFlag(constants.O_NOFOLLOW)
  await inspectRootCliPrivateOutputDirectory(
    dirname(snapshot.path),
    userId,
    false,
  )
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(
      snapshot.path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        noFollow,
      privateOutputMode,
    )
  } catch {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  let identity: RootCliPrivateOutputIdentity | undefined
  let failed = false
  try {
    await file.chmod(privateOutputMode)
    identity = readRootCliPrivateOutputIdentity(
      await file.stat({ bigint: true }),
      userId,
      0n,
    )
    await writeAllRootCliBytes(file, snapshot.bytes)
    await file.sync()
    requireSameRootCliPrivateOutputIdentity(
      identity,
      await file.stat({ bigint: true }),
      userId,
      BigInt(snapshot.bytes.byteLength),
    )
  } catch {
    failed = true
  }
  try {
    await file.close()
  } catch {
    failed = true
  }
  if (failed || identity === undefined) {
    return failRootCli('OUTPUT_FAILED', 1)
  }

  await inspectRootCliPrivateOutputDirectory(
    dirname(snapshot.path),
    userId,
    true,
  )
  await verifyRootCliPublishedPrivateOutput(
    snapshot,
    identity,
    userId,
    noFollow,
  )
}

/** Opens, verifies, optionally fsyncs, and re-verifies one private directory. */
async function inspectRootCliPrivateOutputDirectory(
  path: string,
  userId: number,
  synchronize: boolean,
): Promise<RootCliPrivateOutputDirectoryIdentity> {
  let directory: Awaited<ReturnType<typeof open>>
  try {
    directory = await open(
      path,
      constants.O_RDONLY |
        readRootCliFileSystemFlag(constants.O_DIRECTORY) |
        readRootCliFileSystemFlag(constants.O_NOFOLLOW),
    )
  } catch {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  let identity: RootCliPrivateOutputDirectoryIdentity | undefined
  let failed = false
  try {
    identity = readRootCliPrivateOutputDirectoryIdentity(
      await directory.stat({ bigint: true }),
      userId,
    )
    if (synchronize) await directory.sync()
    const finalIdentity = readRootCliPrivateOutputDirectoryIdentity(
      await directory.stat({ bigint: true }),
      userId,
    )
    if (!sameRootCliPrivateOutputDirectoryIdentity(identity, finalIdentity)) {
      failed = true
    }
  } catch {
    failed = true
  }
  try {
    await directory.close()
  } catch {
    failed = true
  }
  if (failed || identity === undefined) {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  return identity
}

/** Reopens the final path and verifies exact inode, metadata, size, and bytes. */
async function verifyRootCliPublishedPrivateOutput(
  snapshot: RootCliPrivateOutputSnapshot,
  expectedIdentity: RootCliPrivateOutputIdentity,
  userId: number,
  noFollow: number,
): Promise<void> {
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(
      snapshot.path,
      constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
    )
  } catch {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  const readBytes = new Uint8Array(snapshot.bytes.byteLength)
  let failed = false
  try {
    requireSameRootCliPrivateOutputIdentity(
      expectedIdentity,
      await file.stat({ bigint: true }),
      userId,
      BigInt(snapshot.bytes.byteLength),
    )
    await readAllRootCliBytes(file, readBytes)
    requireSameRootCliPrivateOutputIdentity(
      expectedIdentity,
      await file.stat({ bigint: true }),
      userId,
      BigInt(snapshot.bytes.byteLength),
    )
    if (!timingSafeEqual(readBytes, snapshot.bytes)) failed = true
  } catch {
    failed = true
  } finally {
    zeroizeRootCliBuffer(readBytes)
  }
  try {
    await file.close()
  } catch {
    failed = true
  }
  if (failed) return failRootCli('OUTPUT_FAILED', 1)
}

/** Writes an exact byte vector without accepting a short write. */
async function writeAllRootCliBytes(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await file.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    )
    if (
      !Number.isSafeInteger(result.bytesWritten) ||
      result.bytesWritten <= 0 ||
      result.bytesWritten > bytes.byteLength - offset
    ) return failRootCli('OUTPUT_FAILED', 1)
    offset += result.bytesWritten
  }
}

/** Reads an exact known-size byte vector without accepting early EOF. */
async function readAllRootCliBytes(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await file.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    )
    if (
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead <= 0 ||
      result.bytesRead > bytes.byteLength - offset
    ) return failRootCli('OUTPUT_FAILED', 1)
    offset += result.bytesRead
  }
}

/** Validates one newly opened owner-only regular output descriptor. */
function readRootCliPrivateOutputIdentity(
  status: BigIntStats,
  userId: number,
  expectedSize: bigint,
): RootCliPrivateOutputIdentity {
  if (
    !status.isFile() ||
    status.uid !== BigInt(userId) ||
    status.nlink !== 1n ||
    (status.mode & 0o7777n) !== BigInt(privateOutputMode) ||
    status.size !== expectedSize
  ) return failRootCli('OUTPUT_FAILED', 1)
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    mode: status.mode,
    userId: status.uid,
    linkCount: status.nlink,
  })
}

/** Requires the opened output inode and security metadata to remain stable. */
function requireSameRootCliPrivateOutputIdentity(
  identity: RootCliPrivateOutputIdentity,
  status: BigIntStats,
  userId: number,
  expectedSize: bigint,
): void {
  const current = readRootCliPrivateOutputIdentity(
    status,
    userId,
    expectedSize,
  )
  if (
    current.device !== identity.device ||
    current.inode !== identity.inode ||
    current.mode !== identity.mode ||
    current.userId !== identity.userId ||
    current.linkCount !== identity.linkCount
  ) return failRootCli('OUTPUT_FAILED', 1)
}

/** Reads one exact owner-only mode-0700 output-directory identity. */
function readRootCliPrivateOutputDirectoryIdentity(
  status: BigIntStats,
  userId: number,
): RootCliPrivateOutputDirectoryIdentity {
  if (
    !status.isDirectory() ||
    status.uid !== BigInt(userId) ||
    (status.mode & 0o7777n) !== BigInt(privateOutputDirectoryMode)
  ) return failRootCli('OUTPUT_FAILED', 1)
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    mode: status.mode,
    userId: status.uid,
    groupId: status.gid,
  })
}

/** Compares stable identity fields across one directory fsync boundary. */
function sameRootCliPrivateOutputDirectoryIdentity(
  left: RootCliPrivateOutputDirectoryIdentity,
  right: RootCliPrivateOutputDirectoryIdentity,
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.userId === right.userId &&
    left.groupId === right.groupId
}

/** Reads the required effective process user identifier. */
function readRootCliUserId(): number {
  if (typeof process.getuid !== 'function') {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  let value: number
  try {
    value = process.getuid()
  } catch {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return failRootCli('OUTPUT_FAILED', 1)
  }
  return value
}

/** Reads one required positive native filesystem flag. */
function readRootCliFileSystemFlag(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failRootCli('OUTPUT_FAILED', 1)
  return value
}

/** Reads one enumerable own data property without invoking an accessor. */
function readRootCliOwnValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) return failRootCli('OUTPUT_FAILED', 1)
  return descriptor.value
}

/** Compares exact sorted property names. */
function sameRootCliKeys(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false
  const sorted = [...actual].sort()
  const sortedExpected = [...expected].sort()
  return sorted.every((key, index) => key === sortedExpected[index])
}

/** Raises one stable root CLI failure. */
function failRootCli(
  code: WorkspaceSearchMigrationRehearsalRootCliFailureCode,
  exitCode: WorkspaceSearchMigrationRehearsalRootCliExitCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalRootCliError(code, exitCode)
}

/** Runs the direct executable with cooperative SIGINT/SIGTERM containment. */
async function runDirectRootCli(): Promise<void> {
  const controller = new AbortController()
  let signalExitCode: 130 | 143 = 130
  /** Records one shell signal status and aborts active work. */
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
    const exitCode = await runWorkspaceSearchMigrationRehearsalRootCli(
      process.argv.slice(2),
      defaultRootCliDependencies,
      controller.signal,
    )
    process.exitCode = exitCode === 130 ? signalExitCode : exitCode
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

if (import.meta.main) await runDirectRootCli()
