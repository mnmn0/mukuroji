import { createHash, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import {
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ACKNOWLEDGEMENT_ATTEMPTS,
} from './migration-rehearsal-alarm-evidence'
import {
  createWorkspaceSearchMigrationRehearsalAlarmPlanBinding,
  createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding,
  verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
} from './migration-rehearsal-alarm-evidence-cli'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
  type WorkspaceSearchMigrationRehearsalDerivedKeys,
} from './migration-rehearsal-key-derivation'
import {
  createWorkspaceSearchMigrationRehearsalPermit,
  createWorkspaceSearchMigrationRehearsalResourceAttestationDigest,
  verifyWorkspaceSearchMigrationRehearsalPermit,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
  writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome,
} from './migration-rehearsal-permit-cli'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'

/** Exact acknowledgement required to issue an alarm-purpose permit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_ISSUANCE_APPROVAL =
  'issue-reviewed-non-production-migration-rehearsal-alarm-permit'

/** Stable discriminator for secret-free alarm-permit CLI results. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-alarm-permit-issuance-result'

/** Strictly parsed alarm-purpose permit issuance command. */
export type WorkspaceSearchMigrationRehearsalAlarmPermitCliArguments = {
  /** Exact reviewed canonical alarm collection plan. */
  readonly alarmPlanFile: string
  /** Exact authenticated main rehearsal permit. */
  readonly mainPermitFile: string
  /** Restricted main rehearsal master-key file. */
  readonly mainAuthenticationKeyFile: string
  /** Restricted distinct alarm-purpose master-key file. */
  readonly alarmAuthenticationKeyFile: string
  /** New alarm-purpose permit path that must not be replaced. */
  readonly outputFile: string
  /** Exact alarm-purpose issuance acknowledgement. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_ISSUANCE_APPROVAL
}

/** Injectable finite local boundaries for alarm-purpose permit issuance. */
export type WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies = {
  /** Reads one stable owner-only canonical input through a finite ceiling. */
  readonly readPrivateInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one stable owner-only exact 32-byte master key. */
  readonly readAuthenticationKeyFile: (path: string) => Promise<Uint8Array>
  /** Publishes one canonical private permit without replacement. */
  readonly writePermitFileExclusive: (
    path: string,
    bytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome>
  /** Supplies the trusted wall clock used to authenticate the main permit. */
  readonly clock: () => Date
  /** Emits one already canonical secret-free success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Emits one already canonical raw-value-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable exit statuses emitted by the alarm-purpose permit CLI. */
export type WorkspaceSearchMigrationRehearsalAlarmPermitCliExitCode =
  | 0
  | 1
  | 2

/** Stable raw-value-free alarm-purpose permit failure classes. */
type WorkspaceSearchMigrationRehearsalAlarmPermitCliFailureCode =
  | 'AUTHENTICATION_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INVALID_PLAN'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'

/** Private stable alarm-purpose permit CLI failure. */
class WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure extends Error {
  /** Stable machine-readable failure classification. */
  readonly code:
    WorkspaceSearchMigrationRehearsalAlarmPermitCliFailureCode

  /** Exact process exit status paired with the classification. */
  readonly exitCode:
    WorkspaceSearchMigrationRehearsalAlarmPermitCliExitCode

  /**
   * Creates one raw-value-free issuance failure.
   *
   * @param code - Stable public failure classification.
   * @param exitCode - Exact process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalAlarmPermitCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalAlarmPermitCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Maximum accepted local CLI path length. */
const maximumAlarmPermitCliPathLength = 4_096

/** Default secure local I/O and process boundaries. */
const defaultAlarmPermitCliDependencies:
  WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies =
    Object.freeze({
      readPrivateInputFile:
        readWorkspaceSearchMigrationRehearsalPrivateInputFile,
      readAuthenticationKeyFile:
        readWorkspaceSearchMigrationRehearsalPermitSigningKey,
      writePermitFileExclusive:
        writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
      clock: (): Date => new Date(),
      writeStdoutLine: (line: string): void => console.log(line),
      writeStderrLine: (line: string): void => console.error(line),
    })

/**
 * Parses the sole exact ordered alarm-purpose permit issuance command.
 *
 * @param arguments_ - Arguments following the executable script path.
 * @returns Frozen distinct absolute paths and exact acknowledgement.
 */
export function parseWorkspaceSearchMigrationRehearsalAlarmPermitCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalAlarmPermitCliArguments {
  const values = snapshotAlarmPermitCliArguments(arguments_)
  if (
    values[0] !== '--alarm-plan-file' ||
    values[2] !== '--main-permit-file' ||
    values[4] !== '--main-authentication-key-file' ||
    values[6] !== '--alarm-authentication-key-file' ||
    values[8] !== '--output-file' ||
    values[10] !== '--approval' ||
    values[11] !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_ISSUANCE_APPROVAL
  ) throw invalidUsage()
  const configuration = Object.freeze({
    alarmPlanFile: readAlarmPermitCliPath(values[1]),
    mainPermitFile: readAlarmPermitCliPath(values[3]),
    mainAuthenticationKeyFile: readAlarmPermitCliPath(values[5]),
    alarmAuthenticationKeyFile: readAlarmPermitCliPath(values[7]),
    outputFile: readAlarmPermitCliPath(values[9]),
    approval:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_ISSUANCE_APPROVAL,
  })
  const paths = [
    configuration.alarmPlanFile,
    configuration.mainPermitFile,
    configuration.mainAuthenticationKeyFile,
    configuration.alarmAuthenticationKeyFile,
    configuration.outputFile,
  ]
  if (new Set(paths).size !== paths.length) throw invalidUsage()
  return configuration
}

/**
 * Issues one alarm-purpose permit rooted in an authenticated main session.
 *
 * The main permit is authenticated with its own derived runtime key. The
 * reviewed alarm plan must reproduce its account, production isolation,
 * Region, commit, measured configuration, policy, root session attestation,
 * and validity envelope. Only the plan resource binding and the distinct
 * alarm key digests differ in the emitted permit.
 *
 * @param arguments_ - Exact explicit operator command.
 * @param dependencies - Injectable finite secure local boundaries.
 * @returns Stable process status after all owned key bytes are erased.
 */
export async function runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies =
      defaultAlarmPermitCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalAlarmPermitCliExitCode> {
  let writeStdoutLine = defaultAlarmPermitCliDependencies.writeStdoutLine
  let writeStderrLine = defaultAlarmPermitCliDependencies.writeStderrLine
  let alarmPlanBytes: Uint8Array | undefined
  let mainPermitBytes: Uint8Array | undefined
  let mainMasterKey: Uint8Array | undefined
  let alarmMasterKey: Uint8Array | undefined
  let mainKeys: WorkspaceSearchMigrationRehearsalDerivedKeys | undefined
  let alarmKeys: WorkspaceSearchMigrationRehearsalDerivedKeys | undefined
  let outputBytes: Uint8Array | undefined
  try {
    const captured = snapshotAlarmPermitCliDependencies(dependencies)
    writeStdoutLine = captured.writeStdoutLine
    writeStderrLine = captured.writeStderrLine
    const configuration =
      parseWorkspaceSearchMigrationRehearsalAlarmPermitCliArguments(
        arguments_,
      )
    alarmPlanBytes = await readAlarmPermitCliPrivateInput(
      configuration.alarmPlanFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_MAX_BYTES,
      captured,
    )
    const plan = readAlarmPermitCliPlan(alarmPlanBytes)
    mainPermitBytes = await readAlarmPermitCliPrivateInput(
      configuration.mainPermitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES,
      captured,
    )
    const mainPermitDocument = readAlarmPermitCliCanonicalDocument(
      mainPermitBytes,
    )
    const mainRequestedResourcesBinding =
      readMainRequestedResourcesBinding(mainPermitDocument)
    mainMasterKey = await readAlarmPermitCliAuthenticationKey(
      configuration.mainAuthenticationKeyFile,
      captured,
    )
    alarmMasterKey = await readAlarmPermitCliAuthenticationKey(
      configuration.alarmAuthenticationKeyFile,
      captured,
    )
    mainKeys = deriveWorkspaceSearchMigrationRehearsalKeys(mainMasterKey)
    alarmKeys = deriveWorkspaceSearchMigrationRehearsalKeys(alarmMasterKey)
    requireAlarmPermitCliKeySeparation(
      mainMasterKey,
      mainKeys,
      alarmMasterKey,
      alarmKeys,
    )
    const currentTime = readAlarmPermitCliClock(captured.clock)
    let mainPermit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>
    try {
      mainPermit = verifyWorkspaceSearchMigrationRehearsalPermit({
        permit: mainPermitDocument,
        verificationKey: mainKeys.runtimeKey,
        account: plan.account,
        region: plan.region,
        commit: plan.commit,
        requestedResourcesBinding: mainRequestedResourcesBinding,
        currentTime,
      })
    } catch {
      throw authenticationFailed()
    }
    if (
      mainPermit.evidenceKeyDigest !== mainKeys.runtimeKeyDigest ||
      mainPermit.publicationKeyDigest !== mainKeys.publicationKeyDigest
    ) throw authenticationFailed()
    requireAlarmPlanMatchesMainPermit(plan, mainPermit, currentTime)
    const alarmClaims:
      WorkspaceSearchMigrationRehearsalPermitClaims = Object.freeze({
        ...mainPermit,
        requestedResourcesBinding: plan.requestedResourcesBinding,
        evidenceKeyDigest: alarmKeys.runtimeKeyDigest,
        publicationKeyDigest: alarmKeys.publicationKeyDigest,
        issuedAt: currentTime.toISOString(),
      })
    const mainSharedSessionBinding =
      createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
        mainPermit,
        plan.migrationResourceAttestationDigest,
      )
    const alarmSharedSessionBinding =
      createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
        alarmClaims,
        plan.migrationResourceAttestationDigest,
      )
    if (mainSharedSessionBinding !== alarmSharedSessionBinding) {
      throw authenticationFailed()
    }
    let alarmPermit: ReturnType<
      typeof createWorkspaceSearchMigrationRehearsalPermit
    >
    let verifiedAlarmPermit:
      Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>
    try {
      alarmPermit = createWorkspaceSearchMigrationRehearsalPermit({
        claims: alarmClaims,
        signingKey: alarmKeys.runtimeKey,
      })
      verifiedAlarmPermit = verifyWorkspaceSearchMigrationRehearsalPermit({
        permit: alarmPermit,
        verificationKey: alarmKeys.runtimeKey,
        account: plan.account,
        region: plan.region,
        commit: plan.commit,
        requestedResourcesBinding: plan.requestedResourcesBinding,
        currentTime,
      })
    } catch {
      throw authenticationFailed()
    }
    if (
      createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
        verifiedAlarmPermit,
        plan.migrationResourceAttestationDigest,
      ) !== mainSharedSessionBinding
    ) throw authenticationFailed()
    outputBytes = new TextEncoder().encode(
      serializeCanonicalJson(alarmPermit),
    )
    if (
      outputBytes.byteLength === 0 ||
      outputBytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES
    ) throw operationFailed()
    let outcome: WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome
    try {
      outcome = await captured.writePermitFileExclusive(
        configuration.outputFile,
        outputBytes,
      )
    } catch {
      throw outputWriteFailed()
    }
    if (outcome === 'exists') throw outputExists()
    if (outcome !== 'created' && outcome !== 'reconciled') {
      throw outputWriteFailed()
    }
    writeStdoutLine(serializeCanonicalJson({
      alarmPlanBinding: plan.requestedResourcesBinding,
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_CLI_RESULT_KIND,
      permitDigest: createHash('sha256').update(outputBytes).digest('hex'),
      sharedSessionBindingDigest: mainSharedSessionBinding,
      status: 'succeeded',
    }))
    return 0
  } catch (error: unknown) {
    const failure = classifyAlarmPermitCliFailure(error)
    writeAlarmPermitCliFailureLine(writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    zeroizeWorkspaceSearchMigrationRehearsalKey(outputBytes)
    zeroizeWorkspaceSearchMigrationRehearsalKey(alarmKeys?.publicationKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(alarmKeys?.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(mainKeys?.publicationKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(mainKeys?.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(alarmMasterKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(mainMasterKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(mainPermitBytes)
    zeroizeWorkspaceSearchMigrationRehearsalKey(alarmPlanBytes)
  }
}

/** Requires the alarm plan to extend exactly one authenticated main session. */
function requireAlarmPlanMatchesMainPermit(
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  mainPermit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
  currentTime: Date,
): void {
  const expectedPlanBinding =
    createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(plan)
  const expectedMainResourceAttestation =
    createWorkspaceSearchMigrationRehearsalResourceAttestationDigest({
      configurationHash: mainPermit.configurationBindingDigest,
      deploymentTrustRootDigest: mainPermit.deploymentTrustRootDigest,
      productionAccount: mainPermit.productionAccount,
      requestedResourcesBinding: mainPermit.requestedResourcesBinding,
    })
  const planStartedAt = Date.parse(plan.startedAt)
  const planCompletedAt = Date.parse(plan.completedAt)
  const permitIssuedAt = Date.parse(mainPermit.issuedAt)
  const alarmPermitIssuedAt = currentTime.getTime()
  const permitExpiresAt = Date.parse(mainPermit.expiresAt)
  const captureDeadline = planStartedAt +
    plan.receiptMaximumWaitMilliseconds +
    (plan.requestTimeoutMilliseconds *
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ACKNOWLEDGEMENT_ATTEMPTS)
  const finalizeDeadline = planCompletedAt +
    plan.historyMaximumWaitMilliseconds +
    plan.requestTimeoutMilliseconds
  if (
    plan.requestedResourcesBinding !== expectedPlanBinding ||
    plan.account !== mainPermit.account ||
    plan.productionAccount !== mainPermit.productionAccount ||
    plan.region !== mainPermit.region ||
    plan.commit !== mainPermit.commit ||
    plan.configurationHash !== mainPermit.configurationBindingDigest ||
    plan.policyVersion !== mainPermit.policyVersion ||
    plan.migrationResourceAttestationDigest !==
      expectedMainResourceAttestation ||
    !mainPermit.callerArn.startsWith(
      `arn:${plan.partition}:sts::${plan.account}:assumed-role/`,
    ) ||
    planStartedAt < permitIssuedAt ||
    alarmPermitIssuedAt > planStartedAt ||
    captureDeadline > planCompletedAt ||
    finalizeDeadline >= permitExpiresAt
  ) throw invalidPlan()
}

/** Reads one exact requested-resource binding before full HMAC verification. */
function readMainRequestedResourcesBinding(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw inputInvalid()
  const descriptor = Object.getOwnPropertyDescriptor(
    value,
    'requestedResourcesBinding',
  )
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    !isHexDigest(descriptor.value)
  ) throw inputInvalid()
  return descriptor.value
}

/** Requires all master and derived keys to remain purpose-separated. */
function requireAlarmPermitCliKeySeparation(
  mainMasterKey: Uint8Array,
  mainKeys: WorkspaceSearchMigrationRehearsalDerivedKeys,
  alarmMasterKey: Uint8Array,
  alarmKeys: WorkspaceSearchMigrationRehearsalDerivedKeys,
): void {
  const keys = [
    mainMasterKey,
    mainKeys.runtimeKey,
    mainKeys.publicationKey,
    alarmMasterKey,
    alarmKeys.runtimeKey,
    alarmKeys.publicationKey,
  ]
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      const leftKey = keys[left]
      const rightKey = keys[right]
      if (
        leftKey === undefined ||
        rightKey === undefined ||
        leftKey.byteLength !== rightKey.byteLength ||
        timingSafeEqual(leftKey, rightKey)
      ) throw authenticationFailed()
    }
  }
}

/** Reads and verifies one exact canonical alarm plan. */
function readAlarmPermitCliPlan(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmCollectionPlan {
  try {
    return verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan(
      readAlarmPermitCliCanonicalDocument(bytes),
    )
  } catch {
    throw invalidPlan()
  }
}

/** Parses one byte-for-byte canonical UTF-8 JSON document. */
function readAlarmPermitCliCanonicalDocument(bytes: Uint8Array): unknown {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      bytes.byteLength === 0
    ) throw inputInvalid()
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    )
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(value),
    )
    if (
      canonicalBytes.byteLength !== bytes.byteLength ||
      !timingSafeEqual(canonicalBytes, bytes)
    ) throw inputInvalid()
    return value
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure
    ) throw error
    throw inputInvalid()
  }
}

/** Reads one bounded owner-only input and rejects malformed buffers. */
async function readAlarmPermitCliPrivateInput(
  path: string,
  maximumBytes: number,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies,
): Promise<Uint8Array> {
  try {
    const bytes = await dependencies.readPrivateInputFile(path, maximumBytes)
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumBytes
    ) throw inputInvalid()
    return bytes
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure
    ) throw error
    throw inputInvalid()
  }
}

/** Reads one exact authentication key without reflecting its path. */
async function readAlarmPermitCliAuthenticationKey(
  path: string,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies,
): Promise<Uint8Array> {
  try {
    const bytes = await dependencies.readAuthenticationKeyFile(path)
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      bytes.byteLength !== 32
    ) throw authenticationFailed()
    return bytes
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure
    ) throw error
    throw authenticationFailed()
  }
}

/** Captures one ordinary finite trusted Date value. */
function readAlarmPermitCliClock(clock: () => Date): Date {
  try {
    const value: unknown = Reflect.apply(clock, undefined, [])
    const milliseconds: unknown = Reflect.apply(
      Date.prototype.getTime,
      value,
      [],
    )
    if (
      typeof milliseconds !== 'number' ||
      !Number.isFinite(milliseconds)
    ) throw authenticationFailed()
    return new Date(milliseconds)
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure
    ) throw error
    throw authenticationFailed()
  }
}

/** Copies one exact ordinary CLI vector without invoking custom accessors. */
function snapshotAlarmPermitCliArguments(
  value: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 12
  ) throw invalidUsage()
  const expectedKeys: (string | symbol)[] = [
    ...Array.from({ length: value.length }, (_entry, index) => String(index)),
    'length',
  ]
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !ownKeys.includes(key))
  ) throw invalidUsage()
  const snapshot: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length === 0 ||
      descriptor.value.length > maximumAlarmPermitCliPathLength ||
      descriptor.value.includes('\0')
    ) throw invalidUsage()
    snapshot.push(descriptor.value)
  }
  return Object.freeze(snapshot)
}

/** Resolves one finite path before any private file is opened. */
function readAlarmPermitCliPath(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumAlarmPermitCliPathLength ||
    value.includes('\0')
  ) throw invalidUsage()
  try {
    return resolve(value)
  } catch {
    throw invalidUsage()
  }
}

/** Captures and validates every injected local boundary. */
function snapshotAlarmPermitCliDependencies(
  value: WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies,
): WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) throw operationFailed()
    const expectedKeys = [
      'clock',
      'readAuthenticationKeyFile',
      'readPrivateInputFile',
      'writePermitFileExclusive',
      'writeStderrLine',
      'writeStdoutLine',
    ]
    const ownKeys = Reflect.ownKeys(value)
    if (
      ownKeys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !ownKeys.includes(key))
    ) throw operationFailed()
    const clock = readAlarmPermitCliDependency(value, 'clock')
    const readAuthenticationKeyFile = readAlarmPermitCliDependency(
      value,
      'readAuthenticationKeyFile',
    )
    const readPrivateInputFile = readAlarmPermitCliDependency(
      value,
      'readPrivateInputFile',
    )
    const writePermitFileExclusive = readAlarmPermitCliDependency(
      value,
      'writePermitFileExclusive',
    )
    const writeStderrLine = readAlarmPermitCliDependency(
      value,
      'writeStderrLine',
    )
    const writeStdoutLine = readAlarmPermitCliDependency(
      value,
      'writeStdoutLine',
    )
    const captured = Object.freeze({
      readPrivateInputFile,
      readAuthenticationKeyFile,
      writePermitFileExclusive,
      clock,
      writeStdoutLine,
      writeStderrLine,
    })
    return captured
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure
    ) throw error
    throw operationFailed()
  }
}

/** Reads one exact enumerable own data-property function dependency. */
function readAlarmPermitCliDependency<
  Name extends keyof WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies,
>(
  value: WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies,
  name: Name,
): WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies[Name] {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'function' ||
    nodeUtilTypes.isProxy(descriptor.value)
  ) throw operationFailed()
  return descriptor.value
}

/** Classifies arbitrary failures without reading their messages or causes. */
function classifyAlarmPermitCliFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure {
  if (
    error instanceof WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure
  ) return error
  return operationFailed()
}

/** Emits one canonical raw-value-free failure line and drops writer errors. */
function writeAlarmPermitCliFailureLine(
  writeStderrLine: (line: string) => void,
  code: WorkspaceSearchMigrationRehearsalAlarmPermitCliFailureCode,
): void {
  try {
    writeStderrLine(serializeCanonicalJson({
      code,
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_CLI_RESULT_KIND,
      status: 'error',
    }))
  } catch {
    // Output failures never expose raw inputs or replace the stable status.
  }
}

/** Creates one exact authentication failure. */
function authenticationFailed():
WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure(
    'AUTHENTICATION_FAILED',
    1,
  )
}

/** Creates one exact private-input failure. */
function inputInvalid():
WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure(
    'INPUT_FILE_INVALID',
    2,
  )
}

/** Creates one exact reviewed-plan failure. */
function invalidPlan():
WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure(
    'INVALID_PLAN',
    2,
  )
}

/** Creates one exact command-shape failure. */
function invalidUsage():
WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Creates one exact unexpected operation failure. */
function operationFailed():
WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure(
    'OPERATION_FAILED',
    1,
  )
}

/** Creates one exact no-replace collision failure. */
function outputExists():
WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure(
    'OUTPUT_FILE_EXISTS',
    1,
  )
}

/** Creates one exact durable publication failure. */
function outputWriteFailed():
WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalAlarmPermitCliFailure(
    'OUTPUT_FILE_WRITE_FAILED',
    1,
  )
}

if (import.meta.main) {
  void runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
    Bun.argv.slice(2),
    defaultAlarmPermitCliDependencies,
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
