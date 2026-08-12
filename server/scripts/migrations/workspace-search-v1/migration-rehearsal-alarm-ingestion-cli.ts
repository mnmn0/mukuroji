import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import {
  GetCallerIdentityCommand,
  STSClient,
} from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-provider-ini'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import { serializeCanonicalJson } from './migration-contract'
import {
  verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  type WorkspaceSearchMigrationRehearsalAlarmAwsPartition,
  type WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
} from './migration-rehearsal-alarm-evidence-cli'
import {
  ingestWorkspaceSearchMigrationRehearsalAlarmSignal,
  serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_MAX_BYTES,
  WorkspaceSearchMigrationRehearsalAlarmIngestionError,
  type WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort,
  type WorkspaceSearchMigrationRehearsalAlarmLogWriteInput,
} from './migration-rehearsal-alarm-ingestion'
import {
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
  writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
  type WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome,
} from './migration-rehearsal-permit-cli'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  verifyWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'
import {
  verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_MAX_BYTES,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
} from './migration-telemetry-rehearsal'

/** Explicit approval required for each authenticated PutLogEvents operation. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_APPROVAL =
  'acknowledge-non-production-alarm-log-ingestion'

/** Stable discriminator for public-safe ingestion CLI result lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-alarm-ingestion-result'

/** Maximum canonical plan or permit bytes admitted by the ingestion CLI. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_INPUT_MAX_BYTES =
  64 * 1_024

/** Strict arguments for one fixed-order authenticated signal ingestion. */
export type WorkspaceSearchMigrationRehearsalAlarmIngestionCliArguments = {
  /** Exact non-production operation acknowledgement. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_APPROVAL
  /** Exact owner-only alarm-purpose plan path. */
  readonly planFile: string
  /** Exact owner-only alarm-purpose permit path. */
  readonly permitFile: string
  /** Exact owner-only raw 32-byte alarm-purpose master key path. */
  readonly permitKeyFile: string
  /** Exact owner-only authenticated signal receipt prefix path. */
  readonly signalReceiptFile: string
  /** Optional preceding owner-only ingestion receipt prefix path. */
  readonly previousIngestionReceiptFile?: string
  /** New exclusive durable mode-0600 ingestion receipt path. */
  readonly outputFile: string
}

/** Capability-minimized authenticated CloudWatch Logs runtime. */
export interface WorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntime {
  /** Restricted PutLogEvents-only capability. */
  readonly port: WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort
  /** Releases the Logs and STS clients exactly once. */
  close(): void
}

/** Input for official-endpoint AWS runtime composition. */
export type CreateWorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntimeInput = {
  /** Strict plan fixing account, region, profile, commit, and Logs target. */
  readonly plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan
  /** Already authenticated alarm-purpose permit claims. */
  readonly permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>
  /** Finite STS request timeout. */
  readonly requestTimeoutMilliseconds: number
}

/** Injectable private filesystem, AWS, clock, and public output boundaries. */
export type WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies = {
  /** Reads one stable owner-only single-link input through a byte ceiling. */
  readonly readPrivateInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one stable owner-only exact 32-byte alarm-purpose master key. */
  readonly readPermitKeyFile: (path: string) => Promise<Uint8Array>
  /** Rejects an existing output inode before any AWS request. */
  readonly ensureOutputAbsent: (path: string) => Promise<void>
  /** Creates an STS-authenticated PutLogEvents-only runtime. */
  readonly createAwsRuntime: (
    input: CreateWorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntimeInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntime>
  /** Exclusively writes and fsyncs one canonical mode-0600 output. */
  readonly writeOutputFileExclusive: (
    path: string,
    bytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome>
  /** Trusted wall clock used for permit checks and post-ingestion evidence. */
  readonly clock: () => Date
  /** Writes one canonical digest-only success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Writes one canonical raw-value-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable success, failure, or invalid-usage process status. */
export type WorkspaceSearchMigrationRehearsalAlarmIngestionCliExitCode =
  0 | 1 | 2

/** Stable raw-value-free CLI failure classifications. */
type WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailureCode =
  | 'AUTHENTICATION_FAILED'
  | 'INGESTION_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INVALID_USAGE'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'

/** Private stable CLI failure. */
class WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailure
  extends Error {
  /** Stable failure classification. */
  readonly code:
    WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailureCode

  /** Stable process status. */
  readonly exitCode:
    WorkspaceSearchMigrationRehearsalAlarmIngestionCliExitCode

  /**
   * Creates one raw-value-free CLI failure.
   *
   * @param code Stable failure classification.
   * @param exitCode Stable process status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalAlarmIngestionCliExitCode,
  ) {
    super(code)
    this.name =
      'WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Minimal Logs client shape admitted by the restricted adapter. */
export interface WorkspaceSearchMigrationRehearsalCloudWatchLogsClient {
  /**
   * Sends exactly one PutLogEvents command.
   *
   * @param command Exact one-event command without a sequence token.
   * @param options Finite abort boundary.
   * @returns Untrusted SDK response checked for rejected events.
   */
  send(
    command: PutLogEventsCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown>
  /** Releases the underlying client. */
  destroy(): void
}

/** Minimal STS client shape used only for caller authentication. */
interface WorkspaceSearchMigrationRehearsalAlarmIngestionStsClient {
  /** Sends the sole allowed empty GetCallerIdentity command. */
  send(
    command: GetCallerIdentityCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown>
  /** Releases the underlying client. */
  destroy(): void
}

/** Default private and official-endpoint runtime dependencies. */
const defaultDependencies:
WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies = {
  readPrivateInputFile:
    readWorkspaceSearchMigrationRehearsalPrivateInputFile,
  readPermitKeyFile:
    readWorkspaceSearchMigrationRehearsalPermitSigningKey,
  ensureOutputAbsent:
    ensureWorkspaceSearchMigrationRehearsalAlarmIngestionOutputAbsent,
  createAwsRuntime:
    createWorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntime,
  writeOutputFileExclusive:
    writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
  clock: () => new Date(),
  writeStdoutLine: (line) => console.log(line),
  writeStderrLine: (line) => console.error(line),
}

/** Exact strict flag set accepted by the ingestion CLI. */
const ingestionFlagNames = new Set<string>([
  '--approval',
  '--output-file',
  '--permit-file',
  '--permit-key-file',
  '--plan-file',
  '--previous-ingestion-receipt-file',
  '--signal-receipt-file',
])

/**
 * Parses one explicit one-signal ingestion invocation.
 *
 * @param arguments_ Raw process arguments after the executable name.
 * @returns Detached strict paths and acknowledgement.
 */
export function parseWorkspaceSearchMigrationRehearsalAlarmIngestionCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalAlarmIngestionCliArguments {
  if (
    !Array.isArray(arguments_) ||
    nodeUtilTypes.isProxy(arguments_) ||
    arguments_.length < 12 ||
    arguments_.length > 14 ||
    arguments_.length % 2 !== 0
  ) return failCli('INVALID_USAGE', 2)
  const flags = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (
      name === undefined ||
      value === undefined ||
      !ingestionFlagNames.has(name) ||
      flags.has(name) ||
      value.length === 0 ||
      value.startsWith('--')
    ) return failCli('INVALID_USAGE', 2)
    flags.set(name, value)
  }
  if (
    flags.get('--approval') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_APPROVAL
  ) return failCli('INVALID_USAGE', 2)
  const planFile = readPath(flags.get('--plan-file'))
  const permitFile = readPath(flags.get('--permit-file'))
  const permitKeyFile = readPath(flags.get('--permit-key-file'))
  const signalReceiptFile = readPath(flags.get('--signal-receipt-file'))
  const outputFile = readPath(flags.get('--output-file'))
  const previousValue = flags.get('--previous-ingestion-receipt-file')
  const previousIngestionReceiptFile = previousValue === undefined
    ? undefined
    : readPath(previousValue)
  const paths = [
    planFile,
    permitFile,
    permitKeyFile,
    signalReceiptFile,
    outputFile,
    ...(previousIngestionReceiptFile === undefined
      ? []
      : [previousIngestionReceiptFile]),
  ]
  if (new Set(paths).size !== paths.length) {
    return failCli('INVALID_USAGE', 2)
  }
  return Object.freeze({
    approval:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_APPROVAL,
    planFile,
    permitFile,
    permitKeyFile,
    signalReceiptFile,
    outputFile,
    ...(previousIngestionReceiptFile === undefined
      ? {}
      : { previousIngestionReceiptFile }),
  })
}

/**
 * Executes one authenticated fixed-order CloudWatch Logs signal ingestion.
 *
 * Output absence, all private inputs, plan/permit identity, and the exact
 * signal chain are checked before STS. The signal is authenticated again after
 * STS and immediately before the one-attempt PutLogEvents request. A confirmed
 * remote success followed by a local write failure remains fail-closed and is
 * never automatically replayed.
 *
 * @param arguments_ Exact explicit operator invocation.
 * @param dependencies Injectable private I/O, AWS, clock, and output boundary.
 * @returns Stable process status.
 */
export async function runWorkspaceSearchMigrationRehearsalAlarmIngestionCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies =
      defaultDependencies,
): Promise<WorkspaceSearchMigrationRehearsalAlarmIngestionCliExitCode> {
  let runtime:
    WorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntime | undefined
  let masterKey: Uint8Array | undefined
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  const ownedBytes: Uint8Array[] = []
  let writeStdoutLine = defaultDependencies.writeStdoutLine
  let writeStderrLine = defaultDependencies.writeStderrLine
  try {
    const captured = snapshotDependencies(dependencies)
    writeStdoutLine = captured.writeStdoutLine
    writeStderrLine = captured.writeStderrLine
    const configuration =
      parseWorkspaceSearchMigrationRehearsalAlarmIngestionCliArguments(
        arguments_,
      )
    await captured.ensureOutputAbsent(configuration.outputFile)
    const plan = verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan(
      parseCanonicalJson(await readOwned(
        configuration.planFile,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_INPUT_MAX_BYTES,
        captured,
        ownedBytes,
      )),
    )
    const permitValue = parseCanonicalJson(await readOwned(
      configuration.permitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_INPUT_MAX_BYTES,
      captured,
      ownedBytes,
    ))
    masterKey = await captured.readPermitKeyFile(configuration.permitKeyFile)
    if (
      !(masterKey instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(masterKey) ||
      masterKey.byteLength !== 32
    ) return failCli('AUTHENTICATION_FAILED', 1)
    const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
    runtimeKey = derivedKeys.runtimeKey
    publicationKey = derivedKeys.publicationKey
    zeroize(masterKey)
    masterKey = undefined
    const currentTime = readClock(captured.clock)
    const permit = verifyWorkspaceSearchMigrationRehearsalPermit({
      permit: permitValue,
      verificationKey: runtimeKey,
      account: plan.account,
      region: plan.region,
      commit: plan.commit,
      requestedResourcesBinding: plan.requestedResourcesBinding,
      currentTime,
    })
    if (
      permit.evidenceKeyDigest !== derivedKeys.runtimeKeyDigest ||
      permit.publicationKeyDigest !== derivedKeys.publicationKeyDigest ||
      permit.productionAccount !== plan.productionAccount ||
      permit.callerArn.length === 0 ||
      permit.stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
    ) return failCli('AUTHENTICATION_FAILED', 1)
    const signalValue = parseCanonicalJson(await readOwned(
      configuration.signalReceiptFile,
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPTS_MAX_BYTES,
      captured,
      ownedBytes,
    ))
    const signalArtifact =
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        signalValue,
        runtimeKey,
      )
    requireSignalAndPlan(signalArtifact, plan, currentTime)
    const previousValue = configuration.previousIngestionReceiptFile ===
      undefined
      ? undefined
      : parseCanonicalJson(await readOwned(
          configuration.previousIngestionReceiptFile,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_MAX_BYTES,
          captured,
          ownedBytes,
        ))
    if (previousValue !== undefined) {
      verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
        previousValue,
        runtimeKey,
      )
    }
    requirePreviousPath(signalArtifact, previousValue)
    runtime = await captured.createAwsRuntime({
      plan,
      permit,
      requestTimeoutMilliseconds: plan.requestTimeoutMilliseconds,
    })
    const artifact = await ingestWorkspaceSearchMigrationRehearsalAlarmSignal(
      {
        signalArtifact,
        ...(previousValue === undefined
          ? {}
          : { previousArtifact: previousValue }),
        target: {
          account: plan.account,
          region: plan.region,
          logGroupName: plan.signalLogGroupName,
          logStreamName: plan.signalLogStreamName,
          logStreamArn: plan.signalLogStreamArn,
        },
        authorizationBindingDigest: plan.requestedResourcesBinding,
        verificationKey: runtimeKey,
        requestTimeoutMilliseconds: plan.requestTimeoutMilliseconds,
      },
      { port: runtime.port, clock: captured.clock },
    )
    const outputBytes =
      serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
        artifact,
        runtimeKey,
      )
    ownedBytes.push(outputBytes)
    const outcome = await captured.writeOutputFileExclusive(
      configuration.outputFile,
      outputBytes,
    )
    if (outcome === 'exists') return failCli('OUTPUT_FILE_EXISTS', 1)
    if (outcome !== 'created' && outcome !== 'reconciled') {
      return failCli('OUTPUT_FILE_WRITE_FAILED', 1)
    }
    writeStdoutLine(serializeCanonicalJson({
      artifactDigest: createHash('sha256').update(outputBytes).digest('hex'),
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_RESULT_KIND,
      signalOrdinal: artifact.receipts.length,
      status: 'succeeded',
    }))
    return 0
  } catch (error: unknown) {
    const failure = classifyFailure(error)
    writeFailureLine(writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    if (runtime !== undefined) {
      try {
        runtime.close()
      } catch {
        // A bounded close failure does not reveal or replay an AWS request.
      }
    }
    zeroize(masterKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(publicationKey)
    for (const bytes of ownedBytes) zeroize(bytes)
  }
}

/** PutLogEvents adapter that rejects every partial event acceptance. */
export class WorkspaceSearchMigrationRehearsalCloudWatchLogsIngestionPort
implements WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort {
  /** Exact SDK client exposing no other capability through this adapter. */
  readonly #client: WorkspaceSearchMigrationRehearsalCloudWatchLogsClient

  /**
   * Creates one restricted adapter over an official CloudWatch Logs client.
   *
   * @param client SDK client fixed by the authenticated composition.
   */
  constructor(client: WorkspaceSearchMigrationRehearsalCloudWatchLogsClient) {
    this.#client = client
  }

  /**
   * Sends one event without a sequence token or DescribeLogStreams request.
   *
   * Current PutLogEvents ignores sequence tokens. The client is configured for
   * one attempt; any rejected-event projection fails the operation.
   *
   * @param input Exact one-event request and finite abort signal.
   * @returns Nothing after the service accepts the complete event.
   */
  async putLogEvent(
    input: WorkspaceSearchMigrationRehearsalAlarmLogWriteInput,
  ): Promise<void> {
    const response = await this.#client.send(
      new PutLogEventsCommand({
        logGroupName: input.logGroupName,
        logStreamName: input.logStreamName,
        logEvents: [{
          message: input.message,
          timestamp: input.timestampMilliseconds,
        }],
      }),
      { abortSignal: input.abortSignal },
    )
    if (
      typeof response !== 'object' ||
      response === null ||
      nodeUtilTypes.isProxy(response)
    ) return failCli('INGESTION_FAILED', 1)
    const rejection = readOwn(response, 'rejectedLogEventsInfo')
    if (rejection !== undefined) return failCli('INGESTION_FAILED', 1)
  }
}

/** Official-endpoint runtime owning exactly one Logs and one STS client. */
class DefaultAlarmIngestionAwsRuntime
implements WorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntime {
  /** Restricted PutLogEvents-only projection. */
  readonly port: WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort

  /** Underlying Logs client released on close. */
  readonly #logsClient: WorkspaceSearchMigrationRehearsalCloudWatchLogsClient

  /** Underlying STS client released on close. */
  readonly #stsClient: WorkspaceSearchMigrationRehearsalAlarmIngestionStsClient

  /** Whether both clients were already released. */
  #closed = false

  /**
   * Creates one already-authenticated restricted runtime.
   *
   * @param logsClient Official Logs client with one finite attempt.
   * @param stsClient Official STS client used for identity preflight.
   */
  constructor(
    logsClient: WorkspaceSearchMigrationRehearsalCloudWatchLogsClient,
    stsClient: WorkspaceSearchMigrationRehearsalAlarmIngestionStsClient,
  ) {
    this.#logsClient = logsClient
    this.#stsClient = stsClient
    this.port =
      new WorkspaceSearchMigrationRehearsalCloudWatchLogsIngestionPort(
        logsClient,
      )
  }

  /** Releases both clients exactly once. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#logsClient.destroy()
    this.#stsClient.destroy()
  }
}

/**
 * Authenticates the exact caller through official STS before exposing Logs.
 *
 * No DescribeLogStreams capability is created. PutLogEvents ignores sequence
 * tokens in the current API, and both SDK clients have `maxAttempts: 1`.
 *
 * @param input Strict plan, authenticated permit, and finite STS timeout.
 * @returns Restricted one-attempt PutLogEvents runtime.
 */
export async function createWorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntime(
  input: CreateWorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntimeInput,
): Promise<WorkspaceSearchMigrationRehearsalAlarmIngestionAwsRuntime> {
  const plan = verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan(
    input.plan,
  )
  const permit = input.permit
  if (
    permit.account !== plan.account ||
    permit.productionAccount !== plan.productionAccount ||
    permit.region !== plan.region ||
    permit.commit !== plan.commit ||
    permit.requestedResourcesBinding !== plan.requestedResourcesBinding ||
    permit.stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE ||
    plan.account === plan.productionAccount
  ) return failCli('AUTHENTICATION_FAILED', 1)
  const timeoutMilliseconds = readTimeout(input.requestTimeoutMilliseconds)
  const credentials = fromIni({
    profile: plan.profile,
    clientConfig: {
      endpoint: createOfficialEndpoint('sts', plan.partition, plan.region),
      region: plan.region,
    },
  })
  const commonConfiguration = {
    credentials,
    maxAttempts: 1,
    region: plan.region,
  }
  const stsClient = new STSClient({
    ...commonConfiguration,
    endpoint: createOfficialEndpoint('sts', plan.partition, plan.region),
  })
  const logsClient = new CloudWatchLogsClient({
    ...commonConfiguration,
    endpoint: createOfficialEndpoint('logs', plan.partition, plan.region),
  })
  try {
    const response = await runBoundedIdentityRequest(
      (abortSignal) => stsClient.send(
        new GetCallerIdentityCommand({}),
        { abortSignal },
      ),
      timeoutMilliseconds,
    )
    requireCallerIdentity(response, plan, permit)
    return new DefaultAlarmIngestionAwsRuntime(logsClient, stsClient)
  } catch {
    logsClient.destroy()
    stsClient.destroy()
    return failCli('AUTHENTICATION_FAILED', 1)
  }
}

/** Creates one exact official regional AWS service endpoint. */
function createOfficialEndpoint(
  service: 'logs' | 'sts',
  partition: WorkspaceSearchMigrationRehearsalAlarmAwsPartition,
  region: string,
): string {
  const suffix = partition === 'aws-cn'
    ? 'amazonaws.com.cn'
    : 'amazonaws.com'
  return `https://${service}.${region}.${suffix}`
}

/** Requires exact account and assumed-role session identity from STS. */
function requireCallerIdentity(
  value: unknown,
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failCli('AUTHENTICATION_FAILED', 1)
  const account = readOwn(value, 'Account')
  const arn = readOwn(value, 'Arn')
  const userId = readOwn(value, 'UserId')
  if (
    account !== plan.account ||
    arn !== permit.callerArn ||
    typeof arn !== 'string' ||
    typeof userId !== 'string' ||
    plan.account === plan.productionAccount
  ) return failCli('AUTHENTICATION_FAILED', 1)
  const prefix = `arn:${plan.partition}:sts::${plan.account}:assumed-role/`
  const resource = arn.startsWith(prefix) ? arn.slice(prefix.length) : ''
  const parts = resource.split('/')
  const sessionName = parts[1]
  const userIdParts = userId.split(':')
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9+=,.@_-]{1,64}$/u.test(parts[0] ?? '') ||
    !/^[A-Za-z0-9+=,.@_-]{1,64}$/u.test(sessionName ?? '') ||
    userIdParts.length !== 2 ||
    !/^AROA[A-Z0-9]{17}$/u.test(userIdParts[0] ?? '') ||
    userIdParts[1] !== sessionName
  ) return failCli('AUTHENTICATION_FAILED', 1)
}

/** Runs the sole STS preflight through a finite abort boundary. */
async function runBoundedIdentityRequest<Result>(
  operation: (abortSignal: AbortSignal) => Promise<Result>,
  timeoutMilliseconds: number,
): Promise<Result> {
  const controller = new AbortController()
  let timeoutIdentifier: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutIdentifier = setTimeout(() => {
      controller.abort()
      reject(new Error('MIGRATION_REHEARSAL_ALARM_INGESTION_STS_TIMEOUT'))
    }, timeoutMilliseconds)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ])
  } finally {
    if (timeoutIdentifier !== undefined) clearTimeout(timeoutIdentifier)
  }
}

/**
 * Rejects every existing output inode without following it.
 *
 * @param path - Exact candidate output path.
 * @returns Nothing when the path does not exist.
 */
export async function ensureWorkspaceSearchMigrationRehearsalAlarmIngestionOutputAbsent(
  path: string,
): Promise<void> {
  try {
    await lstat(readPath(path))
  } catch (error: unknown) {
    if (readFileSystemErrorCode(error) === 'ENOENT') return
    return failCli('OUTPUT_FILE_WRITE_FAILED', 1)
  }
  return failCli('OUTPUT_FILE_EXISTS', 1)
}

/** Reads and records one owner-only input for final zeroization. */
async function readOwned(
  path: string,
  maximumBytes: number,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies,
  ownedBytes: Uint8Array[],
): Promise<Uint8Array> {
  try {
    const bytes = await dependencies.readPrivateInputFile(path, maximumBytes)
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumBytes
    ) return failCli('INPUT_FILE_INVALID', 1)
    ownedBytes.push(bytes)
    return bytes
  } catch {
    return failCli('INPUT_FILE_INVALID', 1)
  }
}

/** Parses exact canonical JSON without reflecting input values. */
function parseCanonicalJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    const canonical = new TextEncoder().encode(serializeCanonicalJson(value))
    if (!equalBytes(bytes, canonical)) {
      return failCli('INPUT_FILE_INVALID', 1)
    }
    return value
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailure
    ) throw error
    return failCli('INPUT_FILE_INVALID', 1)
  }
}

/** Requires signal plan bindings and the active plan window. */
function requireSignalAndPlan(
  signalArtifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  currentTime: Date,
): void {
  const latest = signalArtifact.receipts.at(-1)
  if (
    latest === undefined ||
    signalArtifact.authorizationBindingDigest !==
      plan.requestedResourcesBinding ||
    signalArtifact.configurationHash !== plan.configurationHash ||
    signalArtifact.policyVersion !== plan.policyVersion ||
    signalArtifact.evidenceLocatorDigest !==
      plan.signalEvidenceLocatorDigest ||
    signalArtifact.startedAt < plan.startedAt ||
    signalArtifact.completedAt >= plan.completedAt ||
    latest.timestampMilliseconds > currentTime.getTime() ||
    currentTime.getTime() >= Date.parse(plan.completedAt)
  ) return failCli('AUTHENTICATION_FAILED', 1)
}

/** Requires the previous ingestion path exactly after the first signal. */
function requirePreviousPath(
  signalArtifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  previousValue: unknown,
): void {
  const isFirst = signalArtifact.receipts.length === 1
  if (
    (isFirst && previousValue !== undefined) ||
    (!isFirst && previousValue === undefined)
  ) return failCli('INGESTION_FAILED', 1)
}

/** Captures every injected capability before the first await. */
function snapshotDependencies(
  dependencies:
    WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies,
): WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) return failCli('INGESTION_FAILED', 1)
  const functions = [
    dependencies.readPrivateInputFile,
    dependencies.readPermitKeyFile,
    dependencies.ensureOutputAbsent,
    dependencies.createAwsRuntime,
    dependencies.writeOutputFileExclusive,
    dependencies.clock,
    dependencies.writeStdoutLine,
    dependencies.writeStderrLine,
  ]
  if (functions.some((value) =>
    typeof value !== 'function' || nodeUtilTypes.isProxy(value))) {
    return failCli('INGESTION_FAILED', 1)
  }
  return Object.freeze({ ...dependencies })
}

/** Reads one exact finite local path and resolves aliases for comparison. */
function readPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes('\0')
  ) return failCli('INVALID_USAGE', 2)
  return resolve(value)
}

/** Reads one finite request timeout. */
function readTimeout(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 100 ||
    value > 30_000
  ) return failCli('AUTHENTICATION_FAILED', 1)
  return value
}

/** Samples and validates one trustworthy current time. */
function readClock(clock: () => Date): Date {
  if (typeof clock !== 'function' || nodeUtilTypes.isProxy(clock)) {
    return failCli('AUTHENTICATION_FAILED', 1)
  }
  let value: unknown
  try {
    value = clock()
  } catch {
    return failCli('AUTHENTICATION_FAILED', 1)
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return failCli('AUTHENTICATION_FAILED', 1)
  }
  return new Date(value.getTime())
}

/** Reads one own enumerable data property without invoking an accessor. */
function readOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) return undefined
  return descriptor.value
}

/** Reads one own filesystem error code without invoking accessors. */
function readFileSystemErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) return undefined
  const code = readOwn(error, 'code')
  return typeof code === 'string' ? code : undefined
}

/** Compares two exact byte vectors without coercion. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Best-effort overwrites one private owned buffer. */
function zeroize(value: Uint8Array | undefined): void {
  if (value === undefined) return
  try {
    value.fill(0)
  } catch {
    // The private buffer was already detached or otherwise inaccessible.
  }
}

/** Maps all internal failures to stable raw-value-free CLI output. */
function classifyFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailure {
  if (
    error instanceof
      WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailure
  ) return error
  if (error instanceof WorkspaceSearchMigrationRehearsalAlarmIngestionError) {
    return new WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailure(
      'INGESTION_FAILED',
      1,
    )
  }
  return new WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailure(
    'INGESTION_FAILED',
    1,
  )
}

/** Writes one fixed canonical failure line without raw values. */
function writeFailureLine(
  writer: (line: string) => void,
  code: WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailureCode,
): void {
  try {
    writer(serializeCanonicalJson({
      code,
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_RESULT_KIND,
      status: 'failed',
    }))
  } catch {
    // The bounded operation has already failed.
  }
}

/** Throws one stable raw-value-free CLI failure. */
function failCli(
  code: WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailureCode,
  exitCode: WorkspaceSearchMigrationRehearsalAlarmIngestionCliExitCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmIngestionCliFailure(
    code,
    exitCode,
  )
}

/** Returns whether this module is the direct Bun script entrypoint. */
function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  if (entrypoint === undefined) return false
  try {
    return import.meta.path === resolve(entrypoint)
  } catch {
    return false
  }
}

if (isMainModule()) {
  void runWorkspaceSearchMigrationRehearsalAlarmIngestionCli(
    process.argv.slice(2),
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
