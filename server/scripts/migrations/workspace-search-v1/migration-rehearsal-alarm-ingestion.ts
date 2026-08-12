import { createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  serializeCanonicalJson,
} from './migration-contract'
import {
  verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  type WorkspaceSearchMigrationTelemetryRehearsalSignal,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
} from './migration-telemetry-rehearsal'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable discriminator for authenticated CloudWatch Logs ingestion receipts. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_KIND =
  'mukuroji-workspace-search-migration-rehearsal-alarm-ingestion-receipts'

/** Exact alarm ingestion receipt contract version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_VERSION = 1

/** Maximum canonical bytes accepted for one complete ingestion receipt chain. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_MAX_BYTES =
  64 * 1_024

/** Stable raw-value-free alarm ingestion failure. */
export class WorkspaceSearchMigrationRehearsalAlarmIngestionError
  extends Error {
  /** Creates one stable failure without retaining raw target or log values. */
  constructor() {
    super('INVALID_MIGRATION_REHEARSAL_ALARM_INGESTION')
    this.name = 'WorkspaceSearchMigrationRehearsalAlarmIngestionError'
  }
}

/** Exact target claims reduced to a public-safe digest before persistence. */
export type WorkspaceSearchMigrationRehearsalAlarmIngestionTarget = {
  /** Exact isolated non-production AWS account. */
  readonly account: string
  /** Exact AWS Region containing the precreated log stream. */
  readonly region: string
  /** Exact precreated CloudWatch Logs group name. */
  readonly logGroupName: string
  /** Exact fixed CloudWatch Logs stream name. */
  readonly logStreamName: string
  /** Exact same-environment ARN restricted by the ingestion policy. */
  readonly logStreamArn: string
}

/** One finite exact CloudWatch Logs request. */
export type WorkspaceSearchMigrationRehearsalAlarmLogWriteInput = {
  /** Abort signal enforcing the request deadline. */
  readonly abortSignal: AbortSignal
  /** Exact precreated log group selected by the authenticated plan. */
  readonly logGroupName: string
  /** Exact fixed log stream selected by the authenticated plan. */
  readonly logStreamName: string
  /** Exact authenticated one-line EMF message. */
  readonly message: string
  /** Exact timestamp already authenticated inside the EMF line. */
  readonly timestampMilliseconds: number
}

/** Capability-minimized CloudWatch Logs boundary exposing only PutLogEvents. */
export interface WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort {
  /**
   * Appends exactly one authenticated EMF event to the fixed stream.
   *
   * @param input Exact target, message, timestamp, and finite abort boundary.
   * @returns Nothing after CloudWatch Logs accepts the request.
   */
  putLogEvent(
    input: WorkspaceSearchMigrationRehearsalAlarmLogWriteInput,
  ): Promise<void>
}

/** One digest-only authenticated successful CloudWatch Logs ingestion. */
export type WorkspaceSearchMigrationRehearsalAlarmIngestionReceipt = {
  /** Fixed semantic signal copied from the authenticated signal chain. */
  readonly signal: WorkspaceSearchMigrationTelemetryRehearsalSignal
  /** One-based ordinal in the fixed six-signal chain. */
  readonly signalOrdinal: number
  /** Digest of the exact authenticated signal receipt used for this request. */
  readonly signalReceiptDigest: string
  /** SHA-256 digest of the exact EMF UTF-8 bytes accepted by Logs. */
  readonly serializedEmfDigest: string
  /** Exact EMF UTF-8 byte length accepted by Logs. */
  readonly serializedEmfByteLength: number
  /** Canonical timestamp authenticated by the exact EMF line. */
  readonly observedAt: string
  /** Exact CloudWatch log-event timestamp authenticated by the signal receipt. */
  readonly timestampMilliseconds: number
  /** Digest of the exact account, region, group, stream, and stream ARN. */
  readonly targetDigest: string
  /** Digest binding the exact PutLogEvents request without retaining log bytes. */
  readonly requestDigest: string
  /** Canonical local time sampled only after PutLogEvents returned success. */
  readonly ingestedAt: string
  /** Digest of the preceding ingestion receipt, or null for the first. */
  readonly previousReceiptDigest: string | null
  /** Digest of every preceding digest-only ingestion claim. */
  readonly receiptDigest: string
  /** Domain-separated HMAC over the complete receipt claims. */
  readonly authenticationTag: string
}

/** Fixed-prefix authenticated digest-only ingestion receipt artifact. */
export type WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact = {
  /** Stable artifact discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_KIND
  /** Exact artifact contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_VERSION
  /** Alarm-purpose plan binding shared with the exact signal artifact. */
  readonly authorizationBindingDigest: string
  /** Reviewed configuration digest shared with every signal. */
  readonly configurationHash: string
  /** Reviewed rate policy digest shared with every signal. */
  readonly policyVersion: string
  /** Digest-only exact CloudWatch Logs target binding. */
  readonly targetDigest: string
  /** Canonical completion time of the first accepted PutLogEvents request. */
  readonly startedAt: string
  /** Canonical completion time of the latest accepted PutLogEvents request. */
  readonly completedAt: string
  /** Fixed ordered prefix containing no raw account, target, profile, or log. */
  readonly receipts:
    readonly WorkspaceSearchMigrationRehearsalAlarmIngestionReceipt[]
  /** Digest of every preceding artifact field. */
  readonly artifactDigest: string
  /** Domain-separated HMAC over the complete artifact claims. */
  readonly authenticationTag: string
}

/** Input for one finite authenticated EMF ingestion. */
export type IngestWorkspaceSearchMigrationRehearsalAlarmSignalInput = {
  /** Current authenticated signal artifact containing exactly one new signal. */
  readonly signalArtifact: unknown
  /** Optional preceding authenticated ingestion artifact. */
  readonly previousArtifact?: unknown
  /** Exact target selected by the authenticated alarm-purpose plan. */
  readonly target: WorkspaceSearchMigrationRehearsalAlarmIngestionTarget
  /** Exact expected alarm-purpose requested-resource binding. */
  readonly authorizationBindingDigest: string
  /** Raw owner-only exact 32-byte key authenticating both artifact chains. */
  readonly verificationKey: Uint8Array
  /** Finite inclusive request timeout in milliseconds. */
  readonly requestTimeoutMilliseconds: number
}

/** Trusted process boundaries for one alarm signal ingestion. */
export type WorkspaceSearchMigrationRehearsalAlarmIngestionDependencies = {
  /** Restricted CloudWatch Logs PutLogEvents capability. */
  readonly port: WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort
  /** Trusted local clock sampled only after the remote request succeeds. */
  readonly clock: () => Date
}

/** Input used to bind a complete ingestion chain to an exact signal chain. */
export type VerifyWorkspaceSearchMigrationRehearsalAlarmIngestionBindingInput = {
  /** Candidate complete ingestion artifact. */
  readonly ingestionArtifact: unknown
  /** Candidate complete exact signal receipt artifact. */
  readonly signalArtifact: unknown
  /** Raw exact 32-byte alarm-purpose verification key. */
  readonly verificationKey: Uint8Array
  /** Expected digest of the plan-selected CloudWatch Logs target. */
  readonly targetDigest: string
}

/** Strict guards mapping every malformed artifact to one stable failure. */
const ingestionGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failIngestion,
)

/** Exact HMAC key length shared with alarm-purpose signal receipts. */
const ingestionKeyByteLength = 32

/** Domain separator for receipt authentication. */
const receiptAuthenticationDomain =
  'mukuroji-workspace-search-migration-rehearsal-alarm-ingestion/receipt/v1\0'

/** Domain separator for artifact authentication. */
const artifactAuthenticationDomain =
  'mukuroji-workspace-search-migration-rehearsal-alarm-ingestion/artifact/v1\0'

/** Exact self-authenticated ingestion artifact field order. */
const ingestionArtifactKeys = Object.freeze([
  'artifactDigest',
  'authenticationTag',
  'authorizationBindingDigest',
  'completedAt',
  'configurationHash',
  'kind',
  'policyVersion',
  'receipts',
  'startedAt',
  'targetDigest',
  'version',
])

/** Exact self-authenticated ingestion receipt field order. */
const ingestionReceiptKeys = Object.freeze([
  'authenticationTag',
  'ingestedAt',
  'observedAt',
  'previousReceiptDigest',
  'receiptDigest',
  'requestDigest',
  'serializedEmfByteLength',
  'serializedEmfDigest',
  'signal',
  'signalOrdinal',
  'signalReceiptDigest',
  'targetDigest',
  'timestampMilliseconds',
])

/**
 * Derives the public-safe digest of an exact authenticated Logs target.
 *
 * @param target Exact account, region, group, stream, and ARN selection.
 * @returns Domain-separated target digest containing no raw locator.
 */
export function createWorkspaceSearchMigrationRehearsalAlarmIngestionTargetDigest(
  target: WorkspaceSearchMigrationRehearsalAlarmIngestionTarget,
): string {
  const record = ingestionGuards.requireRecord(target)
  ingestionGuards.requireExactKeys(record, [
    'account',
    'logGroupName',
    'logStreamArn',
    'logStreamName',
    'region',
  ])
  const account = readAccount(ingestionGuards.readOwn(record, 'account'))
  const region = readRegion(ingestionGuards.readOwn(record, 'region'))
  const logGroupName = readLogGroupName(
    ingestionGuards.readOwn(record, 'logGroupName'),
  )
  const logStreamName = readLogStreamName(
    ingestionGuards.readOwn(record, 'logStreamName'),
  )
  const logStreamArn = ingestionGuards.readOwn(record, 'logStreamArn')
  if (
    typeof logStreamArn !== 'string' ||
    logStreamArn.length > 2_048 ||
    !logStreamArn.includes(`:${region}:${account}:log-group:`) ||
    !logStreamArn.endsWith(
      `:${logGroupName}:log-stream:${logStreamName}`,
    )
  ) return failIngestion()
  return createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-alarm-log-target',
    version: 1,
    account,
    region,
    logGroupName,
    logStreamName,
    logStreamArn,
  })
}

/**
 * Sends one authenticated exact EMF line and creates a digest-only receipt.
 *
 * The current signal artifact must extend the preceding ingestion artifact by
 * exactly one fixed-order signal. PutLogEvents is attempted once through a
 * finite abort boundary. No automatic retry or sequence-token discovery is
 * performed, so an uncertain result remains fail-closed and is never replayed.
 *
 * @param input Authenticated signal, previous chain, target, key, and timeout.
 * @param dependencies Restricted Logs capability and trusted completion clock.
 * @returns Fresh authenticated fixed-prefix digest-only ingestion artifact.
 */
export async function ingestWorkspaceSearchMigrationRehearsalAlarmSignal(
  input: IngestWorkspaceSearchMigrationRehearsalAlarmSignalInput,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmIngestionDependencies,
): Promise<WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact> {
  const key = copyKey(input.verificationKey)
  try {
    const signalArtifact =
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        input.signalArtifact,
        key,
      )
    const target = readTarget(input.target)
    const targetDigest =
      createWorkspaceSearchMigrationRehearsalAlarmIngestionTargetDigest(
        target,
      )
    const authorizationBindingDigest = ingestionGuards.readDigest(
      input.authorizationBindingDigest,
    )
    if (
      signalArtifact.authorizationBindingDigest !==
        authorizationBindingDigest ||
      !Number.isSafeInteger(input.requestTimeoutMilliseconds) ||
      input.requestTimeoutMilliseconds < 100 ||
      input.requestTimeoutMilliseconds > 30_000
    ) return failIngestion()
    const previousArtifact = input.previousArtifact === undefined
      ? undefined
      : verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
          input.previousArtifact,
          key,
        )
    requireSignalPrefix(
      signalArtifact,
      previousArtifact,
      targetDigest,
    )
    const signalReceipt = signalArtifact.receipts.at(-1)
    if (signalReceipt === undefined) return failIngestion()
    await runBoundedPut(
      dependencies.port,
      target,
      signalReceipt,
      input.requestTimeoutMilliseconds,
    )
    const ingestedAt = readClock(dependencies.clock)
    if (
      Date.parse(ingestedAt) < signalReceipt.timestampMilliseconds ||
      (previousArtifact !== undefined &&
        Date.parse(ingestedAt) < Date.parse(previousArtifact.completedAt))
    ) return failIngestion()
    return createIngestionArtifact({
      signalArtifact,
      signalReceipt,
      previousArtifact,
      targetDigest,
      ingestedAt,
      key,
    })
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmIngestionError) {
      throw error
    }
    return failIngestion()
  } finally {
    key.fill(0)
  }
}

/**
 * Strictly authenticates one digest-only ingestion artifact.
 *
 * @param value Candidate artifact crossing a file or process boundary.
 * @param verificationKey Raw exact 32-byte alarm-purpose key.
 * @returns Detached authenticated artifact with a strict ordered chain.
 */
export function verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
  value: unknown,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact {
  const key = copyKey(verificationKey)
  try {
    const record = ingestionGuards.requireRecord(value)
    ingestionGuards.requireExactKeys(record, ingestionArtifactKeys)
    if (
      ingestionGuards.readOwn(record, 'kind') !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_KIND ||
      ingestionGuards.readOwn(record, 'version') !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_VERSION
    ) return failIngestion()
    const authorizationBindingDigest = ingestionGuards.readDigest(
      ingestionGuards.readOwn(record, 'authorizationBindingDigest'),
    )
    const configurationHash = ingestionGuards.readDigest(
      ingestionGuards.readOwn(record, 'configurationHash'),
    )
    const policyVersion = ingestionGuards.readDigest(
      ingestionGuards.readOwn(record, 'policyVersion'),
    )
    const targetDigest = ingestionGuards.readDigest(
      ingestionGuards.readOwn(record, 'targetDigest'),
    )
    const receiptValues = ingestionGuards.readOwn(record, 'receipts')
    if (
      !Array.isArray(receiptValues) ||
      nodeUtilTypes.isProxy(receiptValues) ||
      receiptValues.length === 0 ||
      receiptValues.length > 6
    ) return failIngestion()
    const values: readonly unknown[] = receiptValues
    const receipts = values.map((entry, index) =>
      readReceipt(entry, index, targetDigest, key))
    for (const [index, receipt] of receipts.entries()) {
      const previous = receipts[index - 1]
      if (
        receipt.previousReceiptDigest !==
          (previous?.receiptDigest ?? null) ||
        (previous !== undefined &&
          (Date.parse(receipt.observedAt) <= Date.parse(previous.observedAt) ||
            Date.parse(receipt.ingestedAt) < Date.parse(previous.ingestedAt)))
      ) return failIngestion()
    }
    const first = receipts[0]
    const last = receipts.at(-1)
    if (first === undefined || last === undefined) return failIngestion()
    const startedAt = readTimestamp(
      ingestionGuards.readOwn(record, 'startedAt'),
    )
    const completedAt = readTimestamp(
      ingestionGuards.readOwn(record, 'completedAt'),
    )
    if (startedAt !== first.ingestedAt || completedAt !== last.ingestedAt) {
      return failIngestion()
    }
    const claims: Omit<
      WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
      'artifactDigest' | 'authenticationTag'
    > = {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_KIND,
      version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_VERSION,
      authorizationBindingDigest,
      configurationHash,
      policyVersion,
      targetDigest,
      startedAt,
      completedAt,
      receipts: Object.freeze(receipts),
    }
    const artifactDigest = ingestionGuards.readDigest(
      ingestionGuards.readOwn(record, 'artifactDigest'),
    )
    if (artifactDigest !== createMigrationDigest(claims)) {
      return failIngestion()
    }
    const authenticationTag = ingestionGuards.readDigest(
      ingestionGuards.readOwn(record, 'authenticationTag'),
    )
    const withoutTag = { ...claims, artifactDigest }
    if (!matchesAuthenticationTag(
      authenticationTag,
      artifactAuthenticationDomain,
      withoutTag,
      key,
    )) return failIngestion()
    return Object.freeze({ ...withoutTag, authenticationTag })
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmIngestionError) {
      throw error
    }
    return failIngestion()
  } finally {
    key.fill(0)
  }
}

/**
 * Authenticates and binds one complete ingestion chain to exact signal bytes.
 *
 * @param input Ingestion, signal, key, and expected target binding.
 * @returns Detached complete ingestion artifact after one-to-one correlation.
 */
export function verifyWorkspaceSearchMigrationRehearsalAlarmIngestionBinding(
  input: VerifyWorkspaceSearchMigrationRehearsalAlarmIngestionBindingInput,
): WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact {
  const key = copyKey(input.verificationKey)
  try {
    const ingestionArtifact =
      verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
        input.ingestionArtifact,
        key,
      )
    const signalArtifact =
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        input.signalArtifact,
        key,
      )
    const targetDigest = ingestionGuards.readDigest(input.targetDigest)
    if (
      ingestionArtifact.targetDigest !== targetDigest ||
      ingestionArtifact.authorizationBindingDigest !==
        signalArtifact.authorizationBindingDigest ||
      ingestionArtifact.configurationHash !== signalArtifact.configurationHash ||
      ingestionArtifact.policyVersion !== signalArtifact.policyVersion ||
      ingestionArtifact.receipts.length !== signalArtifact.receipts.length ||
      ingestionArtifact.receipts.length !== 6
    ) return failIngestion()
    for (const [index, receipt] of ingestionArtifact.receipts.entries()) {
      const signalReceipt = signalArtifact.receipts[index]
      if (!receiptMatchesSignal(receipt, signalReceipt, index)) {
        return failIngestion()
      }
    }
    return ingestionArtifact
  } finally {
    key.fill(0)
  }
}

/**
 * Serializes one authenticated ingestion artifact as canonical bytes.
 *
 * @param value Candidate ingestion artifact.
 * @param verificationKey Raw exact 32-byte alarm-purpose verification key.
 * @returns Bounded canonical UTF-8 bytes containing digest-only evidence.
 */
export function serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
  value: unknown,
  verificationKey: Uint8Array,
): Uint8Array {
  const artifact =
    verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
      value,
      verificationKey,
    )
  const bytes = new TextEncoder().encode(serializeCanonicalJson(artifact))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_MAX_BYTES
  ) return failIngestion()
  return bytes
}

/** Arguments retained only while constructing one new receipt. */
type CreateIngestionArtifactInput = {
  /** Exact authenticated signal prefix. */
  readonly signalArtifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact
  /** Exact latest authenticated signal receipt. */
  readonly signalReceipt: WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt
  /** Optional preceding authenticated ingestion prefix. */
  readonly previousArtifact?:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact
  /** Exact digest-only Logs target binding. */
  readonly targetDigest: string
  /** Canonical time sampled after remote acceptance. */
  readonly ingestedAt: string
  /** Exact working HMAC key. */
  readonly key: Uint8Array
}

/** Creates one new HMAC-authenticated digest-only ingestion prefix. */
function createIngestionArtifact(
  input: CreateIngestionArtifactInput,
): WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact {
  const signalOrdinal = input.signalArtifact.receipts.length
  const requestDigest = createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-put-log-event',
    version: 1,
    targetDigest: input.targetDigest,
    signalOrdinal,
    signalReceiptDigest: input.signalReceipt.receiptDigest,
    serializedEmfDigest: input.signalReceipt.serializedEmfDigest,
    serializedEmfByteLength: input.signalReceipt.serializedEmfByteLength,
    timestampMilliseconds: input.signalReceipt.timestampMilliseconds,
  })
  const receiptClaims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmIngestionReceipt,
    'authenticationTag' | 'receiptDigest'
  > = {
    signal: input.signalReceipt.signal,
    signalOrdinal,
    signalReceiptDigest: input.signalReceipt.receiptDigest,
    serializedEmfDigest: input.signalReceipt.serializedEmfDigest,
    serializedEmfByteLength: input.signalReceipt.serializedEmfByteLength,
    observedAt: input.signalReceipt.observedAt,
    timestampMilliseconds: input.signalReceipt.timestampMilliseconds,
    targetDigest: input.targetDigest,
    requestDigest,
    ingestedAt: input.ingestedAt,
    previousReceiptDigest:
      input.previousArtifact?.receipts.at(-1)?.receiptDigest ?? null,
  }
  const receiptDigest = createMigrationDigest(receiptClaims)
  const receiptWithoutTag = { ...receiptClaims, receiptDigest }
  const receipt: WorkspaceSearchMigrationRehearsalAlarmIngestionReceipt =
    Object.freeze({
      ...receiptWithoutTag,
      authenticationTag: createAuthenticationTag(
        receiptAuthenticationDomain,
        receiptWithoutTag,
        input.key,
      ),
    })
  const receipts = Object.freeze([
    ...(input.previousArtifact?.receipts ?? []),
    receipt,
  ])
  const claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
    'artifactDigest' | 'authenticationTag'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_VERSION,
    authorizationBindingDigest:
      input.signalArtifact.authorizationBindingDigest,
    configurationHash: input.signalArtifact.configurationHash,
    policyVersion: input.signalArtifact.policyVersion,
    targetDigest: input.targetDigest,
    startedAt: input.previousArtifact?.startedAt ?? input.ingestedAt,
    completedAt: input.ingestedAt,
    receipts,
  }
  const artifactDigest = createMigrationDigest(claims)
  const withoutTag = { ...claims, artifactDigest }
  return Object.freeze({
    ...withoutTag,
    authenticationTag: createAuthenticationTag(
      artifactAuthenticationDomain,
      withoutTag,
      input.key,
    ),
  })
}

/** Requires the exact signal artifact to extend the ingestion prefix once. */
function requireSignalPrefix(
  signalArtifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  previousArtifact:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact | undefined,
  targetDigest: string,
): void {
  const previousLength = previousArtifact?.receipts.length ?? 0
  if (
    signalArtifact.receipts.length !== previousLength + 1 ||
    (previousArtifact === undefined && previousLength !== 0) ||
    (previousArtifact !== undefined &&
      (previousArtifact.authorizationBindingDigest !==
          signalArtifact.authorizationBindingDigest ||
        previousArtifact.configurationHash !== signalArtifact.configurationHash ||
        previousArtifact.policyVersion !== signalArtifact.policyVersion ||
        previousArtifact.targetDigest !== targetDigest))
  ) return failIngestion()
  for (const [index, receipt] of
    (previousArtifact?.receipts ?? []).entries()) {
    if (!receiptMatchesSignal(receipt, signalArtifact.receipts[index], index)) {
      return failIngestion()
    }
  }
}

/** Returns whether one digest-only receipt exactly matches its signal source. */
function receiptMatchesSignal(
  receipt: WorkspaceSearchMigrationRehearsalAlarmIngestionReceipt,
  signalReceipt: WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt |
    undefined,
  index: number,
): boolean {
  return signalReceipt !== undefined &&
    receipt.signalOrdinal === index + 1 &&
    receipt.signal === signalReceipt.signal &&
    receipt.signalReceiptDigest === signalReceipt.receiptDigest &&
    receipt.serializedEmfDigest === signalReceipt.serializedEmfDigest &&
    receipt.serializedEmfByteLength === signalReceipt.serializedEmfByteLength &&
    receipt.observedAt === signalReceipt.observedAt &&
    receipt.timestampMilliseconds === signalReceipt.timestampMilliseconds
}

/** Sends one request through a finite abort boundary without automatic retry. */
async function runBoundedPut(
  port: WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort,
  target: WorkspaceSearchMigrationRehearsalAlarmIngestionTarget,
  signalReceipt: WorkspaceSearchMigrationTelemetryRehearsalSignalReceipt,
  timeoutMilliseconds: number,
): Promise<void> {
  const controller = new AbortController()
  let timeoutIdentifier: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutIdentifier = setTimeout(() => {
      controller.abort()
      reject(new Error('MIGRATION_REHEARSAL_LOG_INGESTION_TIMEOUT'))
    }, timeoutMilliseconds)
  })
  try {
    await Promise.race([
      Promise.resolve().then(() => port.putLogEvent({
        abortSignal: controller.signal,
        logGroupName: target.logGroupName,
        logStreamName: target.logStreamName,
        message: signalReceipt.serializedEmfLine,
        timestampMilliseconds: signalReceipt.timestampMilliseconds,
      })),
      timeout,
    ])
  } catch {
    return failIngestion()
  } finally {
    if (timeoutIdentifier !== undefined) clearTimeout(timeoutIdentifier)
  }
}

/** Strictly parses and authenticates one digest-only receipt. */
function readReceipt(
  value: unknown,
  index: number,
  targetDigest: string,
  key: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmIngestionReceipt {
  const record = ingestionGuards.requireRecord(value)
  ingestionGuards.requireExactKeys(record, ingestionReceiptKeys)
  const signal = readSignal(ingestionGuards.readOwn(record, 'signal'))
  const signalOrdinal = readPositiveInteger(
    ingestionGuards.readOwn(record, 'signalOrdinal'),
    6,
  )
  if (signalOrdinal !== index + 1) return failIngestion()
  const signalReceiptDigest = ingestionGuards.readDigest(
    ingestionGuards.readOwn(record, 'signalReceiptDigest'),
  )
  const serializedEmfDigest = ingestionGuards.readDigest(
    ingestionGuards.readOwn(record, 'serializedEmfDigest'),
  )
  const serializedEmfByteLength = readPositiveInteger(
    ingestionGuards.readOwn(record, 'serializedEmfByteLength'),
    16 * 1_024,
  )
  const observedAt = readTimestamp(
    ingestionGuards.readOwn(record, 'observedAt'),
  )
  const timestampMilliseconds =
    readTimestampMilliseconds(
      ingestionGuards.readOwn(record, 'timestampMilliseconds'),
    )
  if (new Date(timestampMilliseconds).toISOString() !== observedAt) {
    return failIngestion()
  }
  const receiptTargetDigest = ingestionGuards.readDigest(
    ingestionGuards.readOwn(record, 'targetDigest'),
  )
  if (receiptTargetDigest !== targetDigest) return failIngestion()
  const requestDigest = ingestionGuards.readDigest(
    ingestionGuards.readOwn(record, 'requestDigest'),
  )
  const ingestedAt = readTimestamp(
    ingestionGuards.readOwn(record, 'ingestedAt'),
  )
  if (Date.parse(ingestedAt) < timestampMilliseconds) return failIngestion()
  const previousValue = ingestionGuards.readOwn(
    record,
    'previousReceiptDigest',
  )
  const previousReceiptDigest = previousValue === null
    ? null
    : ingestionGuards.readDigest(previousValue)
  const expectedRequestDigest = createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-put-log-event',
    version: 1,
    targetDigest,
    signalOrdinal,
    signalReceiptDigest,
    serializedEmfDigest,
    serializedEmfByteLength,
    timestampMilliseconds,
  })
  if (requestDigest !== expectedRequestDigest) return failIngestion()
  const claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmIngestionReceipt,
    'authenticationTag' | 'receiptDigest'
  > = {
    signal,
    signalOrdinal,
    signalReceiptDigest,
    serializedEmfDigest,
    serializedEmfByteLength,
    observedAt,
    timestampMilliseconds,
    targetDigest,
    requestDigest,
    ingestedAt,
    previousReceiptDigest,
  }
  const receiptDigest = ingestionGuards.readDigest(
    ingestionGuards.readOwn(record, 'receiptDigest'),
  )
  if (receiptDigest !== createMigrationDigest(claims)) return failIngestion()
  const authenticationTag = ingestionGuards.readDigest(
    ingestionGuards.readOwn(record, 'authenticationTag'),
  )
  const withoutTag = { ...claims, receiptDigest }
  if (!matchesAuthenticationTag(
    authenticationTag,
    receiptAuthenticationDomain,
    withoutTag,
    key,
  )) return failIngestion()
  return Object.freeze({ ...withoutTag, authenticationTag })
}

/** Detaches an exact target while rejecting unexpected fields. */
function readTarget(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmIngestionTarget {
  const record = ingestionGuards.requireRecord(value)
  ingestionGuards.requireExactKeys(record, [
    'account',
    'logGroupName',
    'logStreamArn',
    'logStreamName',
    'region',
  ])
  const target = Object.freeze({
    account: readAccount(ingestionGuards.readOwn(record, 'account')),
    region: readRegion(ingestionGuards.readOwn(record, 'region')),
    logGroupName: readLogGroupName(
      ingestionGuards.readOwn(record, 'logGroupName'),
    ),
    logStreamName: readLogStreamName(
      ingestionGuards.readOwn(record, 'logStreamName'),
    ),
    logStreamArn: readString(
      ingestionGuards.readOwn(record, 'logStreamArn'),
      2_048,
    ),
  })
  createWorkspaceSearchMigrationRehearsalAlarmIngestionTargetDigest(target)
  return target
}

/** Copies and validates one exact non-shared 32-byte key. */
function copyKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(value.buffer) ||
    value.byteLength !== ingestionKeyByteLength
  ) return failIngestion()
  return new Uint8Array(value)
}

/** Creates one domain-separated canonical HMAC tag. */
function createAuthenticationTag(
  domain: string,
  value: unknown,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(domain)
    .update(serializeCanonicalJson(value))
    .digest('hex')
}

/** Safely compares a candidate HMAC with the exact expected tag. */
function matchesAuthenticationTag(
  candidate: string,
  domain: string,
  value: unknown,
  key: Uint8Array,
): boolean {
  const expected = createAuthenticationTag(domain, value, key)
  const candidateBytes = Buffer.from(candidate, 'hex')
  const expectedBytes = Buffer.from(expected, 'hex')
  return candidateBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(candidateBytes, expectedBytes)
}

/** Reads one exact twelve-digit AWS account. */
function readAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{12}$/u.test(value)) {
    return failIngestion()
  }
  return value
}

/** Reads one exact standard, GovCloud, or China AWS Region. */
function readRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[1-9][0-9]*$/u.test(value)
  ) return failIngestion()
  return value
}

/** Reads one bounded non-empty string. */
function readString(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes('\0')
  ) return failIngestion()
  return value
}

/** Reads one exact stack-owned CloudWatch Logs group name. */
function readLogGroupName(value: unknown): string {
  const result = readString(value, 512)
  if (
    !/^\/[A-Za-z0-9._/#-]+$/u.test(result) ||
    !result.endsWith('/workspace-search-migration/rehearsal')
  ) return failIngestion()
  return result
}

/** Reads the sole fixed precreated CloudWatch Logs stream name. */
function readLogStreamName(value: unknown): string {
  if (value !== 'alarm-signals-v1') return failIngestion()
  return value
}

/** Reads one fixed semantic signal. */
function readSignal(
  value: unknown,
): WorkspaceSearchMigrationTelemetryRehearsalSignal {
  if (
    value === 'checkpoint-stall' ||
    value === 'describe-table-throttle' ||
    value === 'quarantine' ||
    value === 'rate-budget-exhaustion' ||
    value === 'recovery' ||
    value === 'terminal-failure'
  ) return value
  return failIngestion()
}

/** Reads one canonical UTC timestamp. */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failIngestion()
  return value
}

/** Reads one positive safe integer through an inclusive ceiling. */
function readPositiveInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) return failIngestion()
  return value
}

/** Reads one nonnegative exact millisecond timestamp. */
function readTimestampMilliseconds(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failIngestion()
  return value
}

/** Samples one canonical trustworthy post-request clock value. */
function readClock(clock: () => Date): string {
  if (typeof clock !== 'function' || nodeUtilTypes.isProxy(clock)) {
    return failIngestion()
  }
  let value: unknown
  try {
    value = clock()
  } catch {
    return failIngestion()
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return failIngestion()
  }
  return value.toISOString()
}

/** Throws the sole raw-value-free ingestion failure. */
function failIngestion(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmIngestionError()
}
