import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { SQSClient } from '@aws-sdk/client-sqs'
import {
  GetCallerIdentityCommand,
  STSClient,
} from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-provider-ini'
import { createHash } from 'node:crypto'
import { constants as fileSystemConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  serializeCanonicalJson,
} from './migration-contract'
import {
  collectWorkspaceSearchMigrationRehearsalAlarmEvidence,
  collectWorkspaceSearchMigrationRehearsalAlarmHistory,
  createWorkspaceSearchMigrationRehearsalAlarmSharedClaimsBinding,
  finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence,
  serializeWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  verifyWorkspaceSearchMigrationRehearsalAuthorizedStaleTransitions,
  verifyWorkspaceSearchMigrationRehearsalAlarmReceiptCollection,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ACKNOWLEDGEMENT_ATTEMPTS,
  WorkspaceSearchMigrationRehearsalAlarmCloudWatchHistoryPort,
  WorkspaceSearchMigrationRehearsalAlarmEvidenceError,
  WorkspaceSearchMigrationRehearsalAlarmSqsQueuePort,
  type WorkspaceSearchMigrationRehearsalAlarmHistoryPort,
  type WorkspaceSearchMigrationRehearsalAlarmAuthorization,
  type WorkspaceSearchMigrationRehearsalAuthorizedStaleTransition,
  type WorkspaceSearchMigrationRehearsalAlarmQueuePort,
  type WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmRouteInput,
  type WorkspaceSearchMigrationRehearsalAlarmSignalBinding,
} from './migration-rehearsal-alarm-evidence'
import {
  createWorkspaceSearchMigrationRehearsalAlarmIngestionTargetDigest,
  verifyWorkspaceSearchMigrationRehearsalAlarmIngestionBinding,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
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
  WorkspaceSearchMigrationRehearsalPermitError,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import { readBoundedInputFile } from './migration-control-cli'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings,
  verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptError,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
} from './migration-telemetry-rehearsal'

/** Stable discriminator for one exact alarm evidence collection plan. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND =
  'mukuroji-workspace-search-migration-rehearsal-alarm-plan'

/** Exact alarm evidence collection plan contract version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION = 4

/** Explicit acknowledgement required by both alarm evidence operations. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_APPROVAL =
  'acknowledge-non-production-alarm-evidence-collection'

/** Stable discriminator for secret-free CLI result lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-alarm-cli-result'

/** Maximum exact canonical bytes accepted for plans, permits, and artifacts. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_MAX_BYTES =
  64 * 1_024

/** AWS partitions supported by the official-endpoint composition. */
export type WorkspaceSearchMigrationRehearsalAlarmAwsPartition =
  | 'aws'
  | 'aws-cn'
  | 'aws-us-gov'

/** Exact collection plan fields covered by the requested-resources binding. */
export type WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims = {
  /** Stable plan discriminator. */
  readonly kind: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND
  /** Exact plan contract version. */
  readonly planVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION
  /** Mandatory isolated rehearsal stage. */
  readonly stage: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  /** Exact AWS partition shared by every selected resource. */
  readonly partition: WorkspaceSearchMigrationRehearsalAlarmAwsPartition
  /** Exact isolated non-production AWS account. */
  readonly account: string
  /** Exact distinct production account that must remain unreachable. */
  readonly productionAccount: string
  /** Exact AWS Region shared by all selected resources and clients. */
  readonly region: string
  /** Explicit shared-credentials profile selected by the operator. */
  readonly profile: string
  /** Exact reviewed Git commit authorized by the permit. */
  readonly commit: string
  /** Main measured-session resource attestation bound to this alarm plan. */
  readonly migrationResourceAttestationDigest: string
  /** Reviewed configuration digest required in every exact signal line. */
  readonly configurationHash: string
  /** Reviewed rate policy digest required in every exact signal line. */
  readonly policyVersion: string
  /** Plan-declared digest of the stable exact signal evidence locator. */
  readonly signalEvidenceLocatorDigest: string
  /** Exact precreated CloudWatch Logs group receiving signal EMF lines. */
  readonly signalLogGroupName: string
  /** Exact fixed CloudWatch Logs stream receiving ordered signal EMF lines. */
  readonly signalLogStreamName: string
  /** Exact same-environment ARN of the fixed signal log stream. */
  readonly signalLogStreamArn: string
  /** Six concrete alarm ARNs in canonical evidence order. */
  readonly alarmArns: readonly string[]
  /** Finite prior transitions authorized for exact stale-message cleanup. */
  readonly authorizedStaleTransitions:
    readonly WorkspaceSearchMigrationRehearsalAuthorizedStaleTransition[]
  /** Primary topic and dedicated receipt queue. */
  readonly primary: WorkspaceSearchMigrationRehearsalAlarmRouteInput
  /** Secondary topic and dedicated receipt queue. */
  readonly secondary: WorkspaceSearchMigrationRehearsalAlarmRouteInput
  /** Canonical beginning of receipt and history collection. */
  readonly startedAt: string
  /** Canonical completion of the recovery history window. */
  readonly completedAt: string
  /** Maximum finite receipt collection duration. */
  readonly receiptMaximumWaitMilliseconds: number
  /** Maximum finite history collection duration. */
  readonly historyMaximumWaitMilliseconds: number
  /** Maximum finite duration of each AWS request. */
  readonly requestTimeoutMilliseconds: number
  /** Maximum finite CloudWatch page count per alarm. */
  readonly maximumHistoryPagesPerAlarm: number
}

/** Complete canonical alarm evidence plan authenticated by a permit. */
export type WorkspaceSearchMigrationRehearsalAlarmCollectionPlan =
  WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims & {
    /** Digest of every exact operator-selected plan claim. */
    readonly requestedResourcesBinding: string
  }

/** Strictly parsed capture or finalize command arguments. */
export type WorkspaceSearchMigrationRehearsalAlarmCliArguments = {
  /** Exact two-phase operation. */
  readonly operation: 'capture' | 'finalize'
  /** Exact canonical secret-free collection plan path. */
  readonly planFile: string
  /** Exact authenticated short-lived permit path. */
  readonly permitFile: string
  /** Exact restricted raw master key used to derive alarm runtime authority. */
  readonly permitKeyFile: string
  /** New exclusive mode-0600 output path. */
  readonly outputFile: string
  /** Capture receipt path required only by finalize. */
  readonly receiptFile?: string
  /** Complete authenticated signal receipt path required only by finalize. */
  readonly signalReceiptFile?: string
  /** Complete authenticated Logs ingestion receipt path required by finalize. */
  readonly ingestionReceiptFile?: string
  /** Exact explicit non-production operation acknowledgement. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_APPROVAL
}

/** Authenticated bounded AWS ports owned by one CLI operation. */
export interface WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime {
  /** Restricted actual SQS receipt capability. */
  readonly queuePort: WorkspaceSearchMigrationRehearsalAlarmQueuePort
  /** Restricted read-only CloudWatch history capability. */
  readonly historyPort: WorkspaceSearchMigrationRehearsalAlarmHistoryPort
  /** Releases all three official AWS clients exactly once. */
  close(): void
}

/** Input for authenticated official-endpoint AWS runtime composition. */
export type CreateWorkspaceSearchMigrationRehearsalAlarmCliAwsRuntimeInput = {
  /** Strict canonical plan whose exact identity was permit-authorized. */
  readonly plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan
  /** Already authenticated permit claims retained only in process memory. */
  readonly permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>
  /** Finite timeout for the STS caller identity request. */
  readonly requestTimeoutMilliseconds: number
}

/** Injectable finite I/O and AWS composition boundary for CLI tests. */
export type WorkspaceSearchMigrationRehearsalAlarmCliDependencies = {
  /** Reads one stable non-empty file through an inclusive byte ceiling. */
  readonly readInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one exact owner-only mode-0600 master key. */
  readonly readPermitKeyFile: (path: string) => Promise<Uint8Array>
  /** Reads an existing output, returning undefined only when it is absent. */
  readonly readOutputFileIfExists: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array | undefined>
  /** Exclusively creates one durable canonical mode-0600 output. */
  readonly writeOutputFileExclusive: (
    path: string,
    bytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome>
  /** Authenticates STS and creates only SQS/CloudWatch read capabilities. */
  readonly createAwsRuntime: (
    input: CreateWorkspaceSearchMigrationRehearsalAlarmCliAwsRuntimeInput,
  ) => Promise<WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime>
  /** Trusted process wall clock used for permit and operation deadlines. */
  readonly clock: () => Date
  /** Emits one already canonical secret-free success line. */
  readonly writeStdoutLine: (line: string) => void
  /** Emits one already canonical secret-free failure line. */
  readonly writeStderrLine: (line: string) => void
}

/** Stable process statuses used by the alarm evidence CLI. */
export type WorkspaceSearchMigrationRehearsalAlarmCliExitCode = 0 | 1 | 2

/** Stable raw-value-free alarm evidence CLI failure classes. */
type WorkspaceSearchMigrationRehearsalAlarmCliFailureCode =
  | 'AUTHENTICATION_FAILED'
  | 'COLLECTION_FAILED'
  | 'INPUT_FILE_INVALID'
  | 'INVALID_PLAN'
  | 'INVALID_USAGE'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'

/** Private raw-value-free alarm evidence CLI failure. */
class WorkspaceSearchMigrationRehearsalAlarmCliFailure extends Error {
  /** Stable machine-readable failure classification. */
  readonly code: WorkspaceSearchMigrationRehearsalAlarmCliFailureCode

  /** Exact process status paired with the failure. */
  readonly exitCode: WorkspaceSearchMigrationRehearsalAlarmCliExitCode

  /**
   * Creates one stable alarm evidence CLI failure.
   *
   * @param code Raw-value-free failure classification.
   * @param exitCode Exact process status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalAlarmCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalAlarmCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalAlarmCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Minimal STS client shape used by the authenticated composition. */
interface WorkspaceSearchMigrationRehearsalAlarmStsClient {
  /**
   * Sends the sole allowed STS identity request.
   *
   * @param command Exact empty GetCallerIdentity command.
   * @param options Per-request abort boundary.
   * @returns Untrusted STS response.
   */
  send(
    command: GetCallerIdentityCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown>
  /** Releases the underlying SDK client. */
  destroy(): void
}

/** Exact detached STS identity admitted by the runtime boundary. */
type WorkspaceSearchMigrationRehearsalAlarmCallerIdentity = {
  /** Exact non-production AWS account. */
  readonly account: string
  /** Exact permit-authorized assumed-role ARN. */
  readonly arn: string
  /** Exact STS assumed-role user identity. */
  readonly userId: string
}

/** Exact plan keys including its authenticated binding. */
const alarmPlanKeys = Object.freeze([
  'account',
  'alarmArns',
  'authorizedStaleTransitions',
  'commit',
  'completedAt',
  'configurationHash',
  'historyMaximumWaitMilliseconds',
  'kind',
  'maximumHistoryPagesPerAlarm',
  'migrationResourceAttestationDigest',
  'partition',
  'planVersion',
  'primary',
  'productionAccount',
  'profile',
  'policyVersion',
  'receiptMaximumWaitMilliseconds',
  'region',
  'requestTimeoutMilliseconds',
  'requestedResourcesBinding',
  'secondary',
  'signalEvidenceLocatorDigest',
  'signalLogGroupName',
  'signalLogStreamArn',
  'signalLogStreamName',
  'stage',
  'startedAt',
])

/** Strict guards bound to the stable invalid-plan failure. */
const alarmCliGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failInvalidPlan,
)

/**
 * Creates the domain-separated permit binding for exact plan claims.
 *
 * @param value Candidate plan claims without their binding.
 * @returns Lowercase SHA-256 digest of the detached strict claims.
 */
export function createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(
  value: WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims,
): string {
  const claims = readAlarmPlanClaims(value)
  return createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-alarm-plan-binding',
    version: 1,
    plan: claims,
  })
}

/**
 * Creates the caller, isolation, resource, and commit binding shared by permits.
 *
 * Purpose-specific requested-resource bindings and permit timestamps are
 * intentionally excluded so two separate permits can prove the same session.
 *
 * @param permit Already authenticated rehearsal permit claims.
 * @param migrationResourceAttestationDigest Existing main session resource attestation.
 * @returns Domain-separated digest shared with the main suite attestation.
 */
export function createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
  permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
  migrationResourceAttestationDigest: string,
): string {
  const callerAttestationDigest = createMigrationDigest({
    account: permit.account,
    callerArn: permit.callerArn,
    stage: permit.stage,
  })
  const productionIsolationDigest = createMigrationDigest({
    accountsSeparated: true,
    productionAccount: permit.productionAccount,
    rehearsalAccount: permit.account,
    stage: permit.stage,
  })
  return createWorkspaceSearchMigrationRehearsalAlarmSharedClaimsBinding({
    commit: permit.commit,
    callerAttestationDigest,
    productionIsolationDigest,
    resourceAttestationDigest: migrationResourceAttestationDigest,
  })
}

/**
 * Creates the purpose-specific authorization embedded in final alarm evidence.
 *
 * @param permitDocument Exact canonical authenticated alarm permit document.
 * @param permit Verified alarm permit claims.
 * @param plan Exact alarm resource collection plan.
 * @returns Secret-free authorization bound into the combined artifact.
 */
function createAlarmAuthorization(
  permitDocument: unknown,
  permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
): WorkspaceSearchMigrationRehearsalAlarmAuthorization {
  return Object.freeze({
    permitDigest: createMigrationDigest(permitDocument),
    requestedResourcesBinding: plan.requestedResourcesBinding,
    sharedSessionBindingDigest:
      createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
        permit,
        plan.migrationResourceAttestationDigest,
      ),
  })
}

/**
 * Verifies one exact canonical collection plan at the process boundary.
 *
 * @param value Candidate parsed plan document.
 * @returns Detached plan after full environment and digest validation.
 */
export function verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmCollectionPlan {
  const record = alarmCliGuards.requireRecord(value)
  alarmCliGuards.requireExactKeys(record, alarmPlanKeys)
  const claims = readAlarmPlanClaims(record)
  const requestedResourcesBinding = alarmCliGuards.readDigest(
    alarmCliGuards.readOwn(record, 'requestedResourcesBinding'),
  )
  if (
    requestedResourcesBinding !==
      createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(claims)
  ) {
    return failInvalidPlan()
  }
  return Object.freeze({ ...claims, requestedResourcesBinding })
}

/** Reads strict plan claims from a complete plan or claims-only object. */
function readAlarmPlanClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims {
  const record = alarmCliGuards.requireRecord(value)
  const keys = Object.keys(record)
  if (keys.includes('requestedResourcesBinding')) {
    alarmCliGuards.requireExactKeys(record, alarmPlanKeys)
  } else {
    alarmCliGuards.requireExactKeys(record, alarmPlanKeys.filter(
      (key) => key !== 'requestedResourcesBinding',
    ))
  }
  if (
    alarmCliGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND ||
    alarmCliGuards.readOwn(record, 'planVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION ||
    alarmCliGuards.readOwn(record, 'stage') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  ) {
    return failInvalidPlan()
  }
  const partition = readPartition(
    alarmCliGuards.readOwn(record, 'partition'),
  )
  const account = readAccount(alarmCliGuards.readOwn(record, 'account'))
  const productionAccount = readAccount(
    alarmCliGuards.readOwn(record, 'productionAccount'),
  )
  if (account === productionAccount) return failInvalidPlan()
  const region = readRegion(alarmCliGuards.readOwn(record, 'region'))
  const profile = readProfile(alarmCliGuards.readOwn(record, 'profile'))
  const commit = readCommit(alarmCliGuards.readOwn(record, 'commit'))
  const migrationResourceAttestationDigest = alarmCliGuards.readDigest(
    alarmCliGuards.readOwn(record, 'migrationResourceAttestationDigest'),
  )
  const configurationHash = alarmCliGuards.readDigest(
    alarmCliGuards.readOwn(record, 'configurationHash'),
  )
  const policyVersion = alarmCliGuards.readDigest(
    alarmCliGuards.readOwn(record, 'policyVersion'),
  )
  const signalEvidenceLocatorDigest = alarmCliGuards.readDigest(
    alarmCliGuards.readOwn(record, 'signalEvidenceLocatorDigest'),
  )
  if (
    signalEvidenceLocatorDigest !==
      createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
        configurationHash,
        policyVersion,
      )
  ) {
    return failInvalidPlan()
  }
  const signalLogGroupName = readLogGroupName(
    alarmCliGuards.readOwn(record, 'signalLogGroupName'),
  )
  const signalLogStreamName = readLogStreamName(
    alarmCliGuards.readOwn(record, 'signalLogStreamName'),
  )
  const signalLogStreamArn = readLogStreamArn(
    alarmCliGuards.readOwn(record, 'signalLogStreamArn'),
    partition,
    region,
    account,
    signalLogGroupName,
    signalLogStreamName,
  )
  const alarmArns = readAlarmArns(
    alarmCliGuards.readOwn(record, 'alarmArns'),
    partition,
    region,
    account,
  )
  const primary = readRouteInput(
    alarmCliGuards.readOwn(record, 'primary'),
    partition,
    region,
    account,
  )
  const secondary = readRouteInput(
    alarmCliGuards.readOwn(record, 'secondary'),
    partition,
    region,
    account,
  )
  if (
    primary.queueUrl === secondary.queueUrl ||
    primary.topicArn === secondary.topicArn
  ) {
    return failInvalidPlan()
  }
  const startedAt = readTimestamp(alarmCliGuards.readOwn(record, 'startedAt'))
  const authorizedStaleTransitions = readAuthorizedStaleTransitions(
    alarmCliGuards.readOwn(record, 'authorizedStaleTransitions'),
    startedAt,
  )
  const completedAt = readTimestamp(
    alarmCliGuards.readOwn(record, 'completedAt'),
  )
  if (Date.parse(startedAt) >= Date.parse(completedAt)) {
    return failInvalidPlan()
  }
  const receiptMaximumWaitMilliseconds = readInteger(
    alarmCliGuards.readOwn(record, 'receiptMaximumWaitMilliseconds'),
    1_000,
    15 * 60 * 1_000,
  )
  const historyMaximumWaitMilliseconds = readInteger(
    alarmCliGuards.readOwn(record, 'historyMaximumWaitMilliseconds'),
    1_000,
    15 * 60 * 1_000,
  )
  const requestTimeoutMilliseconds = readInteger(
    alarmCliGuards.readOwn(record, 'requestTimeoutMilliseconds'),
    100,
    30_000,
  )
  if (
    requestTimeoutMilliseconds > receiptMaximumWaitMilliseconds ||
    requestTimeoutMilliseconds > historyMaximumWaitMilliseconds
  ) {
    return failInvalidPlan()
  }
  const maximumHistoryPagesPerAlarm = readInteger(
    alarmCliGuards.readOwn(record, 'maximumHistoryPagesPerAlarm'),
    1,
    10,
  )
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND,
    planVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    partition,
    account,
    productionAccount,
    region,
    profile,
    commit,
    migrationResourceAttestationDigest,
    configurationHash,
    policyVersion,
    signalEvidenceLocatorDigest,
    signalLogGroupName,
    signalLogStreamName,
    signalLogStreamArn,
    alarmArns,
    authorizedStaleTransitions,
    primary,
    secondary,
    startedAt,
    completedAt,
    receiptMaximumWaitMilliseconds,
    historyMaximumWaitMilliseconds,
    requestTimeoutMilliseconds,
    maximumHistoryPagesPerAlarm,
  })
}

/**
 * Reads a plan's canonical bounded stale-transition allowlist.
 *
 * @param value Candidate plan field.
 * @param startedAt Canonical start of the new collection window.
 * @returns Detached canonical allowlist or an invalid-plan failure.
 */
function readAuthorizedStaleTransitions(
  value: unknown,
  startedAt: string,
): readonly WorkspaceSearchMigrationRehearsalAuthorizedStaleTransition[] {
  try {
    return verifyWorkspaceSearchMigrationRehearsalAuthorizedStaleTransitions(
      value,
      startedAt,
    )
  } catch {
    return failInvalidPlan()
  }
}

/** Reads one exact CloudWatch Logs group name emitted by the rehearsal stack. */
function readLogGroupName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    !/^\/[A-Za-z0-9._/#-]+$/u.test(value) ||
    !value.endsWith('/workspace-search-migration/rehearsal')
  ) {
    return failInvalidPlan()
  }
  return value
}

/** Reads one exact fixed precreated CloudWatch Logs stream name. */
function readLogStreamName(value: unknown): string {
  if (value !== 'alarm-signals-v1') return failInvalidPlan()
  return value
}

/** Reads the exact same-environment ARN derived from the fixed log target. */
function readLogStreamArn(
  value: unknown,
  partition: WorkspaceSearchMigrationRehearsalAlarmAwsPartition,
  region: string,
  account: string,
  logGroupName: string,
  logStreamName: string,
): string {
  const expected =
    `arn:${partition}:logs:${region}:${account}:log-group:` +
    `${logGroupName}:log-stream:${logStreamName}`
  if (value !== expected) return failInvalidPlan()
  return expected
}

/** Reads one supported literal AWS partition. */
function readPartition(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmAwsPartition {
  if (value === 'aws' || value === 'aws-cn' || value === 'aws-us-gov') {
    return value
  }
  return failInvalidPlan()
}

/** Reads one exact twelve-digit AWS account. */
function readAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{12}$/u.test(value)) {
    return failInvalidPlan()
  }
  return value
}

/** Reads one explicit standard, GovCloud, or China AWS Region. */
function readRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[1-9][0-9]*$/u.test(value)
  ) {
    return failInvalidPlan()
  }
  return value
}

/** Reads one explicit safe shared-credentials profile name. */
function readProfile(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value)
  ) {
    return failInvalidPlan()
  }
  return value
}

/** Reads one exact lowercase reviewed Git commit OID. */
function readCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failInvalidPlan()
  }
  return value
}

/** Reads six exact same-environment CloudWatch alarm ARNs. */
function readAlarmArns(
  value: unknown,
  partition: WorkspaceSearchMigrationRehearsalAlarmAwsPartition,
  region: string,
  account: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length
  ) {
    return failInvalidPlan()
  }
  const entries: readonly unknown[] = value
  const values = new Set<string>()
  return Object.freeze(entries.map((entry) => {
    if (typeof entry !== 'string' || entry.length > 2_048) {
      return failInvalidPlan()
    }
    const prefix = `arn:${partition}:cloudwatch:${region}:${account}:alarm:`
    const alarmName = entry.startsWith(prefix)
      ? entry.slice(prefix.length)
      : ''
    if (
      alarmName.length === 0 ||
      alarmName.length > 255 ||
      alarmName.trim() !== alarmName ||
      values.has(entry)
    ) {
      return failInvalidPlan()
    }
    values.add(entry)
    return entry
  }))
}

/** Reads one exact route topic and queue in the selected environment. */
function readRouteInput(
  value: unknown,
  partition: WorkspaceSearchMigrationRehearsalAlarmAwsPartition,
  region: string,
  account: string,
): WorkspaceSearchMigrationRehearsalAlarmRouteInput {
  const record = alarmCliGuards.requireRecord(value)
  alarmCliGuards.requireExactKeys(record, ['queueUrl', 'topicArn'])
  const topicArn = alarmCliGuards.readOwn(record, 'topicArn')
  const queueUrl = alarmCliGuards.readOwn(record, 'queueUrl')
  if (typeof topicArn !== 'string' || typeof queueUrl !== 'string') {
    return failInvalidPlan()
  }
  const topicPrefix = `arn:${partition}:sns:${region}:${account}:`
  if (
    !topicArn.startsWith(topicPrefix) ||
    topicArn.length <= topicPrefix.length ||
    topicArn.length > 1_024
  ) {
    return failInvalidPlan()
  }
  let url: URL
  try {
    url = new URL(queueUrl)
  } catch {
    return failInvalidPlan()
  }
  const hostname = partition === 'aws-cn'
    ? `sqs.${region}.amazonaws.com.cn`
    : `sqs.${region}.amazonaws.com`
  const pathParts = url.pathname.split('/').filter(
    (part) => part.length > 0,
  )
  if (
    url.protocol !== 'https:' ||
    url.hostname !== hostname ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    pathParts.length !== 2 ||
    pathParts[0] !== account ||
    pathParts[1]?.length === 0
  ) {
    return failInvalidPlan()
  }
  return Object.freeze({ queueUrl, topicArn })
}

/** Reads one canonical UTC timestamp. */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failInvalidPlan()
  return value
}

/** Reads one safe integer inside an inclusive range. */
function readInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return failInvalidPlan()
  }
  return value
}

/** Official-endpoint AWS runtime containing no alarm mutation capability. */
class WorkspaceSearchMigrationRehearsalAlarmDefaultAwsRuntime
implements WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime {
  /** Restricted actual SQS receipt port. */
  readonly queuePort: WorkspaceSearchMigrationRehearsalAlarmQueuePort

  /** Restricted read-only CloudWatch history port. */
  readonly historyPort: WorkspaceSearchMigrationRehearsalAlarmHistoryPort

  /** Underlying SQS client released on close. */
  readonly #sqsClient: SQSClient

  /** Underlying CloudWatch client released on close. */
  readonly #cloudWatchClient: CloudWatchClient

  /** Underlying STS client released on close. */
  readonly #stsClient: WorkspaceSearchMigrationRehearsalAlarmStsClient

  /** Whether all clients were already released. */
  #closed = false

  /**
   * Creates one already-authenticated runtime over exact official clients.
   *
   * @param sqsClient SQS client with only receipt queue permissions.
   * @param cloudWatchClient CloudWatch client with only history permissions.
   * @param stsClient STS client used only for caller authentication.
   */
  constructor(
    sqsClient: SQSClient,
    cloudWatchClient: CloudWatchClient,
    stsClient: WorkspaceSearchMigrationRehearsalAlarmStsClient,
  ) {
    this.#sqsClient = sqsClient
    this.#cloudWatchClient = cloudWatchClient
    this.#stsClient = stsClient
    this.queuePort =
      new WorkspaceSearchMigrationRehearsalAlarmSqsQueuePort(sqsClient)
    this.historyPort =
      new WorkspaceSearchMigrationRehearsalAlarmCloudWatchHistoryPort(
        cloudWatchClient,
      )
  }

  /** Releases all official AWS clients exactly once. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#sqsClient.destroy()
    this.#cloudWatchClient.destroy()
    this.#stsClient.destroy()
  }
}

/**
 * Authenticates STS and creates the exact read-only alarm evidence runtime.
 *
 * Every client has an explicit official endpoint and fixed profile. The
 * composition exposes no `SetAlarmState` or `Publish` method or command.
 *
 * @param input Strict plan, authenticated permit, and finite STS timeout.
 * @returns Actual SQS receipt and CloudWatch history capabilities.
 */
export async function createWorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime(
  input: CreateWorkspaceSearchMigrationRehearsalAlarmCliAwsRuntimeInput,
): Promise<WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime> {
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
  ) {
    return failAuthentication()
  }
  const timeoutMilliseconds = readInteger(
    input.requestTimeoutMilliseconds,
    100,
    30_000,
  )
  const stsEndpoint = createOfficialEndpoint(
    'sts',
    plan.partition,
    plan.region,
  )
  const credentials = fromIni({
    profile: plan.profile,
    clientConfig: {
      endpoint: stsEndpoint,
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
    endpoint: stsEndpoint,
  })
  const sqsClient = new SQSClient({
    ...commonConfiguration,
    endpoint: createOfficialEndpoint('sqs', plan.partition, plan.region),
  })
  const cloudWatchClient = new CloudWatchClient({
    ...commonConfiguration,
    endpoint: createOfficialEndpoint(
      'monitoring',
      plan.partition,
      plan.region,
    ),
  })
  try {
    const response = await runBoundedAlarmCliOperation(
      (abortSignal) => stsClient.send(
        new GetCallerIdentityCommand({}),
        { abortSignal },
      ),
      timeoutMilliseconds,
    )
    readAuthenticatedCallerIdentity(response, plan, permit)
    return new WorkspaceSearchMigrationRehearsalAlarmDefaultAwsRuntime(
      sqsClient,
      cloudWatchClient,
      stsClient,
    )
  } catch {
    sqsClient.destroy()
    cloudWatchClient.destroy()
    stsClient.destroy()
    return failAuthentication()
  }
}

/** Creates one exact official regional AWS service endpoint. */
function createOfficialEndpoint(
  service: 'monitoring' | 'sqs' | 'sts',
  partition: WorkspaceSearchMigrationRehearsalAlarmAwsPartition,
  region: string,
): string {
  const suffix = partition === 'aws-cn'
    ? 'amazonaws.com.cn'
    : 'amazonaws.com'
  return `https://${service}.${region}.${suffix}`
}

/** Reads and verifies the exact permit-authorized assumed-role identity. */
function readAuthenticatedCallerIdentity(
  value: unknown,
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
): WorkspaceSearchMigrationRehearsalAlarmCallerIdentity {
  const record = alarmCliGuards.requireRecord(value)
  const account = readOptionalOwnDataProperty(record, 'Account')
  const arn = readOptionalOwnDataProperty(record, 'Arn')
  const userId = readOptionalOwnDataProperty(record, 'UserId')
  if (
    account !== plan.account ||
    arn !== permit.callerArn ||
    typeof arn !== 'string' ||
    typeof userId !== 'string'
  ) {
    return failAuthentication()
  }
  const prefix =
    `arn:${plan.partition}:sts::${plan.account}:assumed-role/`
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
  ) {
    return failAuthentication()
  }
  return { account, arn, userId }
}

/** Reads one optional own enumerable data property without accessors. */
function readOptionalOwnDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    return failAuthentication()
  }
  return descriptor.value
}

/** Runs one AWS request through a real finite timer and abort signal. */
async function runBoundedAlarmCliOperation<Result>(
  operation: (abortSignal: AbortSignal) => Promise<Result>,
  timeoutMilliseconds: number,
): Promise<Result> {
  const controller = new AbortController()
  let timeoutIdentifier: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutIdentifier = setTimeout(() => {
      controller.abort()
      reject(new Error('ALARM_CLI_REQUEST_TIMEOUT'))
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
 * Executes one exact two-phase alarm evidence CLI operation.
 *
 * Capture must run before the external metric signals are emitted. Finalize
 * runs only after the plan's recovery window and binds the immutable receipt
 * intermediate to actual CloudWatch metric-evaluation history.
 *
 * @param rawArguments Raw process arguments after the executable name.
 * @param dependencies Optional finite filesystem, clock, output, and AWS ports.
 * @returns Stable process exit code.
 */
export async function runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
  rawArguments: readonly string[],
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies =
    defaultAlarmCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalAlarmCliExitCode> {
  let runtime: WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime | undefined
  let masterKey: Uint8Array | undefined
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const argumentsValue = parseAlarmCliArguments(rawArguments)
    const plan = await readCanonicalPlan(
      argumentsValue.planFile,
      dependencies,
    )
    const permitValue = await readCanonicalInputDocument(
      argumentsValue.permitFile,
      dependencies,
    )
    masterKey = await dependencies.readPermitKeyFile(
      argumentsValue.permitKeyFile,
    )
    if (
      !(masterKey instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(masterKey) ||
      masterKey.byteLength !== 32
    ) {
      return failAuthentication()
    }
    const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)
    runtimeKey = derivedKeys.runtimeKey
    publicationKey = derivedKeys.publicationKey
    zeroizeBytes(masterKey)
    masterKey = undefined
    const currentTime = readAlarmCliClock(dependencies.clock)
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
      permit.publicationKeyDigest !== derivedKeys.publicationKeyDigest
    ) return failAuthentication()
    requirePermitAndPlanAuthorization(
      permit,
      plan,
    )
    if (argumentsValue.operation === 'capture') {
      const existingCapture = await readExistingAlarmCapture(
        argumentsValue.outputFile,
        plan,
        runtimeKey,
        dependencies,
      )
      if (existingCapture !== undefined) {
        writeAlarmCliSuccessLine(
          dependencies.writeStdoutLine,
          'capture',
          existingCapture,
          'recovered-existing',
        )
        return 0
      }
    }
    requirePermitAndPlanOperationWindow(
      permit,
      plan,
      currentTime,
      argumentsValue.operation,
    )
    const finalizeLocalEvidence = argumentsValue.operation === 'finalize'
      ? await readAlarmFinalizeLocalEvidence(
          plan,
          argumentsValue,
          runtimeKey,
          dependencies,
        )
      : undefined
    runtime = await dependencies.createAwsRuntime({
      plan,
      permit,
      requestTimeoutMilliseconds: plan.requestTimeoutMilliseconds,
    })
    const authorization = createAlarmAuthorization(
      permitValue,
      permit,
      plan,
    )
    let output: AlarmCliPhaseOutput
    if (argumentsValue.operation === 'capture') {
      output = await captureAlarmReceipts(
        plan,
        runtimeKey,
        runtime,
        dependencies,
      )
    } else {
      if (finalizeLocalEvidence === undefined) return failCollection()
      output = await finalizeAlarmDelivery(
        plan,
        authorization,
        finalizeLocalEvidence,
        runtimeKey,
        publicationKey,
        runtime,
        dependencies,
      )
    }
    const outcome = await dependencies.writeOutputFileExclusive(
      argumentsValue.outputFile,
      output.bytes,
    )
    if (outcome === 'exists') return failOutputExists()
    let receiptAcknowledgement:
      WorkspaceSearchMigrationRehearsalAlarmReceiptAcknowledgement |
      undefined
    if (output.acknowledge !== undefined) {
      try {
        await output.acknowledge()
        receiptAcknowledgement = 'complete'
      } catch {
        receiptAcknowledgement = 'incomplete'
      }
    }
    writeAlarmCliSuccessLine(
      dependencies.writeStdoutLine,
      argumentsValue.operation,
      output.bytes,
      receiptAcknowledgement,
    )
    return 0
  } catch (error: unknown) {
    const failure = classifyAlarmCliFailure(error)
    writeAlarmCliFailureLine(dependencies.writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    if (runtime !== undefined) {
      try {
        runtime.close()
      } catch {
        // Raw close failures never replace a stable operation result.
      }
    }
    zeroizeBytes(masterKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(publicationKey)
  }
}

/** Canonical bytes produced by one successful CLI phase. */
type AlarmCliPhaseOutput = {
  /** Exact canonical artifact bytes for exclusive publication. */
  readonly bytes: Uint8Array
  /** Optional process-local acknowledgement run only after durable publication. */
  readonly acknowledge?: () => Promise<void>
}

/** Secret-free capture acknowledgement outcome reported after durable write. */
type WorkspaceSearchMigrationRehearsalAlarmReceiptAcknowledgement =
  | 'complete'
  | 'incomplete'
  | 'recovered-existing'

/**
 * Emits one stable canonical success result for a completed CLI phase.
 *
 * @param writeLine Restricted canonical stdout writer.
 * @param operation Completed capture or finalize operation.
 * @param bytes Exact canonical artifact bytes accepted as durable evidence.
 * @param receiptAcknowledgement Capture-only bounded cleanup outcome.
 */
function writeAlarmCliSuccessLine(
  writeLine: (line: string) => void,
  operation: 'capture' | 'finalize',
  bytes: Uint8Array,
  receiptAcknowledgement?:
    WorkspaceSearchMigrationRehearsalAlarmReceiptAcknowledgement,
): void {
  if (
    (operation === 'capture' && receiptAcknowledgement === undefined) ||
    (operation === 'finalize' && receiptAcknowledgement !== undefined)
  ) {
    return failCollection()
  }
  writeLine(serializeCanonicalJson({
    artifactByteLength: bytes.byteLength,
    artifactDigest: createHash('sha256').update(bytes).digest('hex'),
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_RESULT_KIND,
    operation,
    receiptCount: 12,
    ...(receiptAcknowledgement === undefined
      ? {}
      : { receiptAcknowledgement }),
    status: 'succeeded',
  }))
}

/**
 * Authenticates a durable capture output before any AWS runtime is opened.
 *
 * @param path Exact exclusive capture output path.
 * @param plan Permit-authenticated exact collection plan.
 * @param verificationKey Restricted alarm runtime verification key.
 * @param dependencies Injectable bounded filesystem boundary.
 * @returns Canonical existing bytes, or undefined only when no output exists.
 */
async function readExistingAlarmCapture(
  path: string,
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  verificationKey: Uint8Array,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies,
): Promise<Uint8Array | undefined> {
  let bytes: Uint8Array | undefined
  try {
    bytes = await dependencies.readOutputFileIfExists(
      path,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_MAX_BYTES,
    )
    if (bytes === undefined) return undefined
    const value = readCanonicalDocumentBytes(bytes)
    const artifact =
      verifyWorkspaceSearchMigrationRehearsalAlarmReceiptCollection(
        value,
        plan.requestedResourcesBinding,
        verificationKey,
      )
    if (
      artifact.startedAt !== plan.startedAt ||
      artifact.completedAt > plan.completedAt
    ) {
      return failCollection()
    }
    return serializeWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact(
      artifact,
    )
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmCliFailure) {
      throw error
    }
    return failCollection()
  } finally {
    zeroizeBytes(bytes)
  }
}

/** Authenticated bounded local inputs read before any finalize AWS runtime. */
type AlarmFinalizeLocalEvidence = {
  /** Complete validated digest-only dual-route receipt artifact. */
  readonly receiptArtifact:
    WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact
  /** Complete HMAC-authenticated exact signal and recovery chain. */
  readonly signalArtifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact
  /** Six digest-only authenticated actual Logs ingestion receipts. */
  readonly ingestionArtifact:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact
  /** Six positive alarm bindings derived only from authenticated exact EMF. */
  readonly signals:
    readonly WorkspaceSearchMigrationRehearsalAlarmSignalBinding[]
}

/**
 * Collects the actual twelve receipt intermediate before signal recovery.
 *
 * @param plan Permit-authenticated exact collection plan.
 * @param collectionSigningKey Restricted alarm runtime signing key.
 * @param runtime Authenticated bounded AWS runtime.
 * @param dependencies Injectable trusted clock boundary.
 * @returns Canonical authenticated receipt bytes and deferred cleanup.
 */
async function captureAlarmReceipts(
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  collectionSigningKey: Uint8Array,
  runtime: WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies,
): Promise<AlarmCliPhaseOutput> {
  const collection = await collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
    {
      alarmArns: plan.alarmArns,
      authorizedStaleTransitions: plan.authorizedStaleTransitions,
      collectionBindingDigest: plan.requestedResourcesBinding,
      collectionSigningKey,
      expectedAccountId: plan.account,
      expectedRegion: plan.region,
      maximumWaitMilliseconds: plan.receiptMaximumWaitMilliseconds,
      requestTimeoutMilliseconds: plan.requestTimeoutMilliseconds,
      primary: plan.primary,
      secondary: plan.secondary,
      startedAt: plan.startedAt,
    },
    runtime.queuePort,
    {
      now: () => readAlarmCliClock(dependencies.clock).getTime(),
      sleep: (milliseconds) => new Promise((resolve) => {
        setTimeout(resolve, milliseconds)
      }),
    },
  )
  return {
    bytes: serializeWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact(
      collection.artifact,
    ),
    acknowledge: () => collection.acknowledge(),
  }
}

/** Reads and authenticates every finalize file before composing AWS clients. */
async function readAlarmFinalizeLocalEvidence(
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  argumentsValue: WorkspaceSearchMigrationRehearsalAlarmCliArguments,
  signalVerificationKey: Uint8Array,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies,
): Promise<AlarmFinalizeLocalEvidence> {
  if (
    argumentsValue.receiptFile === undefined ||
    argumentsValue.signalReceiptFile === undefined ||
    argumentsValue.ingestionReceiptFile === undefined
  ) {
    return failInvalidUsage()
  }
  const receiptValue = await readCanonicalInputDocument(
    argumentsValue.receiptFile,
    dependencies,
  )
  const receiptArtifact =
    verifyWorkspaceSearchMigrationRehearsalAlarmReceiptCollection(
      receiptValue,
      plan.requestedResourcesBinding,
      signalVerificationKey,
    )
  if (
    receiptArtifact.startedAt !== plan.startedAt ||
    receiptArtifact.completedAt > plan.completedAt
  ) {
    return failCollection()
  }
  const signalArtifactValue = await readCanonicalInputDocument(
    argumentsValue.signalReceiptFile,
    dependencies,
  )
  const signalArtifact =
    verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
      signalArtifactValue,
      signalVerificationKey,
    )
  if (
    signalArtifact.authorizationBindingDigest !==
      plan.requestedResourcesBinding ||
    signalArtifact.configurationHash !== plan.configurationHash ||
    signalArtifact.policyVersion !== plan.policyVersion ||
    signalArtifact.evidenceLocatorDigest !==
      plan.signalEvidenceLocatorDigest ||
    signalArtifact.startedAt < plan.startedAt ||
    signalArtifact.completedAt >= plan.completedAt
  ) {
    return failCollection()
  }
  const signals =
    createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings(
      signalArtifact,
      signalVerificationKey,
    )
  const ingestionArtifactValue = await readCanonicalInputDocument(
    argumentsValue.ingestionReceiptFile,
    dependencies,
  )
  const ingestionArtifact =
    verifyWorkspaceSearchMigrationRehearsalAlarmIngestionBinding({
      ingestionArtifact: ingestionArtifactValue,
      signalArtifact,
      verificationKey: signalVerificationKey,
      targetDigest:
        createWorkspaceSearchMigrationRehearsalAlarmIngestionTargetDigest({
          account: plan.account,
          region: plan.region,
          logGroupName: plan.signalLogGroupName,
          logStreamName: plan.signalLogStreamName,
          logStreamArn: plan.signalLogStreamArn,
        }),
    })
  return { receiptArtifact, signalArtifact, ingestionArtifact, signals }
}

/** Collects real recovery history and finalizes the combined immutable output. */
async function finalizeAlarmDelivery(
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  authorization: WorkspaceSearchMigrationRehearsalAlarmAuthorization,
  localEvidence: AlarmFinalizeLocalEvidence,
  signalVerificationKey: Uint8Array,
  publicationSigningKey: Uint8Array,
  runtime: WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies,
): Promise<AlarmCliPhaseOutput> {
  const transitionArtifact =
    await collectWorkspaceSearchMigrationRehearsalAlarmHistory(
      {
        alarmArns: plan.alarmArns,
        completedAt: plan.completedAt,
        expectedAccountId: plan.account,
        expectedRegion: plan.region,
        maximumPagesPerAlarm: plan.maximumHistoryPagesPerAlarm,
        maximumWaitMilliseconds: plan.historyMaximumWaitMilliseconds,
        requestTimeoutMilliseconds: plan.requestTimeoutMilliseconds,
        signals: localEvidence.signals,
        startedAt: plan.startedAt,
      },
      runtime.historyPort,
      {
        now: () => readAlarmCliClock(dependencies.clock).getTime(),
        sleep: (milliseconds) => new Promise((resolve) => {
          setTimeout(resolve, milliseconds)
        }),
      },
    )
  const finalized = finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
    authorization,
    ingestionArtifact: localEvidence.ingestionArtifact,
    publicationSigningKey,
    receiptArtifact: localEvidence.receiptArtifact,
    signalArtifact: localEvidence.signalArtifact,
    signalVerificationKey,
    transitionArtifact,
  })
  return { bytes: finalized.canonicalArtifactBytes }
}

/** Reads and verifies one exact canonical plan file. */
async function readCanonicalPlan(
  path: string,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalAlarmCollectionPlan> {
  try {
    return verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan(
      await readCanonicalInputDocument(path, dependencies),
    )
  } catch {
    return failInvalidPlan()
  }
}

/** Reads one bounded file and requires byte-for-byte canonical JSON. */
async function readCanonicalInputDocument(
  path: string,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies,
): Promise<unknown> {
  let bytes: Uint8Array | undefined
  try {
    bytes = await dependencies.readInputFile(
      path,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_MAX_BYTES,
    )
    if (
      !(bytes instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(bytes) ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_MAX_BYTES
    ) {
      return failInputFile()
    }
    return readCanonicalDocumentBytes(bytes)
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmCliFailure) {
      throw error
    }
    return failInputFile()
  } finally {
    zeroizeBytes(bytes)
  }
}

/**
 * Parses exact byte-for-byte canonical JSON without retaining raw text.
 *
 * @param bytes Bounded candidate document bytes.
 * @returns Parsed canonical JSON value.
 */
function readCanonicalDocumentBytes(bytes: Uint8Array): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_MAX_BYTES
  ) {
    return failInputFile()
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(value),
    )
    if (!equalBytes(bytes, canonicalBytes)) return failInputFile()
    return value
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmCliFailure) {
      throw error
    }
    return failInputFile()
  }
}

/**
 * Requires the permit envelope to authenticate the exact plan window.
 *
 * @param permit Already authenticated permit claims.
 * @param plan Exact canonical alarm collection plan.
 */
function requirePermitAndPlanAuthorization(
  permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
): void {
  if (
    permit.productionAccount !== plan.productionAccount ||
    permit.stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE ||
    plan.account === plan.productionAccount ||
    Date.parse(plan.startedAt) < Date.parse(permit.issuedAt) ||
    Date.parse(plan.completedAt) >= Date.parse(permit.expiresAt)
  ) {
    return failAuthentication()
  }
}

/**
 * Requires enough authenticated time to begin a new bounded AWS operation.
 *
 * @param permit Already authenticated permit claims.
 * @param plan Exact canonical alarm collection plan.
 * @param currentTime Trusted operation start time.
 * @param operation New AWS operation requiring its complete finite window.
 */
function requirePermitAndPlanOperationWindow(
  permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  currentTime: Date,
  operation: 'capture' | 'finalize',
): void {
  const maximumDuration = operation === 'capture'
    ? plan.receiptMaximumWaitMilliseconds
    : plan.historyMaximumWaitMilliseconds
  if (
    currentTime.getTime() + maximumDuration +
      plan.requestTimeoutMilliseconds >= Date.parse(permit.expiresAt)
  ) {
    return failAuthentication()
  }
  if (
    operation === 'capture' &&
    currentTime.getTime() + maximumDuration +
      (plan.requestTimeoutMilliseconds *
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ACKNOWLEDGEMENT_ATTEMPTS) >
        Date.parse(plan.completedAt)
  ) {
    return failAuthentication()
  }
  if (
    operation === 'finalize' &&
    currentTime.getTime() + 5_000 < Date.parse(plan.completedAt)
  ) {
    return failAuthentication()
  }
}

/** Reads one detached valid Date from the injected trusted clock. */
function readAlarmCliClock(clock: () => Date): Date {
  if (typeof clock !== 'function' || nodeUtilTypes.isProxy(clock)) {
    return failAuthentication()
  }
  let value: unknown
  let timestamp: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
    timestamp = Date.prototype.getTime.call(value)
  } catch {
    return failAuthentication()
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return failAuthentication()
  }
  return new Date(timestamp)
}

/** Parses one exact command and rejects unknown, duplicate, or missing flags. */
function parseAlarmCliArguments(
  rawArguments: readonly string[],
): WorkspaceSearchMigrationRehearsalAlarmCliArguments {
  if (
    !Array.isArray(rawArguments) ||
    nodeUtilTypes.isProxy(rawArguments) ||
    (rawArguments[0] !== 'capture' && rawArguments[0] !== 'finalize')
  ) {
    return failInvalidUsage()
  }
  const operation = rawArguments[0]
  const expectedFlags = operation === 'capture'
    ? new Set([
        '--approval',
        '--output-file',
        '--permit-file',
        '--permit-key-file',
        '--plan-file',
      ])
    : new Set([
        '--approval',
        '--ingestion-receipt-file',
        '--output-file',
        '--permit-file',
        '--permit-key-file',
        '--plan-file',
        '--receipt-file',
        '--signal-receipt-file',
      ])
  if (rawArguments.length !== 1 + (expectedFlags.size * 2)) {
    return failInvalidUsage()
  }
  const flags = new Map<string, string>()
  for (let index = 1; index < rawArguments.length; index += 2) {
    const flag = rawArguments[index]
    const value = rawArguments[index + 1]
    if (
      typeof flag !== 'string' ||
      typeof value !== 'string' ||
      !expectedFlags.has(flag) ||
      flags.has(flag) ||
      value.length === 0 ||
      value.length > 4_096
    ) {
      return failInvalidUsage()
    }
    flags.set(flag, value)
  }
  const approval = flags.get('--approval')
  const planFile = flags.get('--plan-file')
  const permitFile = flags.get('--permit-file')
  const permitKeyFile = flags.get('--permit-key-file')
  const outputFile = flags.get('--output-file')
  const receiptFile = flags.get('--receipt-file')
  const signalReceiptFile = flags.get('--signal-receipt-file')
  const ingestionReceiptFile = flags.get('--ingestion-receipt-file')
  if (
    approval !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_APPROVAL ||
    planFile === undefined ||
    permitFile === undefined ||
    permitKeyFile === undefined ||
    outputFile === undefined ||
    (operation === 'capture' &&
      (receiptFile !== undefined ||
        signalReceiptFile !== undefined ||
        ingestionReceiptFile !== undefined)) ||
    (operation === 'finalize' &&
      (receiptFile === undefined ||
        signalReceiptFile === undefined ||
        ingestionReceiptFile === undefined))
  ) {
    return failInvalidUsage()
  }
  const paths = [
    planFile,
    permitFile,
    permitKeyFile,
    outputFile,
    ...(receiptFile === undefined ? [] : [receiptFile]),
    ...(signalReceiptFile === undefined ? [] : [signalReceiptFile]),
    ...(ingestionReceiptFile === undefined ? [] : [ingestionReceiptFile]),
  ]
  if (new Set(paths).size !== paths.length) return failInvalidUsage()
  return Object.freeze({
    operation,
    planFile,
    permitFile,
    permitKeyFile,
    outputFile,
    ...(receiptFile === undefined ? {} : { receiptFile }),
    ...(signalReceiptFile === undefined ? {} : { signalReceiptFile }),
    ...(ingestionReceiptFile === undefined ? {} : { ingestionReceiptFile }),
    approval,
  })
}

/** Compares two bounded byte vectors without string coercion. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Zeroizes one invocation-local sensitive byte vector when possible. */
function zeroizeBytes(value: Uint8Array | undefined): void {
  if (value === undefined || nodeUtilTypes.isProxy(value)) return
  try {
    value.fill(0)
  } catch {
    // Best-effort zeroization must not expose raw key material.
  }
}

/** Classifies arbitrary failures without inspecting raw messages or causes. */
function classifyAlarmCliFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalAlarmCliFailure {
  if (error instanceof WorkspaceSearchMigrationRehearsalAlarmCliFailure) {
    return error
  }
  if (error instanceof WorkspaceSearchMigrationRehearsalPermitError) {
    return new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
      'AUTHENTICATION_FAILED',
      1,
    )
  }
  if (
    error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError ||
    error instanceof
      WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptError
  ) {
    return new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
      'COLLECTION_FAILED',
      1,
    )
  }
  return new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
    'OUTPUT_FILE_WRITE_FAILED',
    1,
  )
}

/** Emits one stable canonical failure line and drops writer failures. */
function writeAlarmCliFailureLine(
  writeStderrLine: (line: string) => void,
  code: WorkspaceSearchMigrationRehearsalAlarmCliFailureCode,
): void {
  try {
    writeStderrLine(serializeCanonicalJson({
      code,
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_RESULT_KIND,
      status: 'error',
    }))
  } catch {
    // Raw writer failures never replace the stable exit code.
  }
}

/**
 * Reads one stable owner-only output when it already exists.
 *
 * Undefined is returned only for a positively observed missing path. Existing
 * unreadable, changing, linked, empty, or oversized files fail closed.
 *
 * @param path Exact capture output path.
 * @param maximumBytes Positive inclusive byte ceiling.
 * @returns Detached stable bytes, or undefined when the path is absent.
 */
async function readAlarmOutputFileIfExists(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array | undefined> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_MAX_BYTES
  ) {
    return failInputFile()
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      path,
      fileSystemConstants.O_RDONLY |
        fileSystemConstants.O_NONBLOCK |
        fileSystemConstants.O_NOFOLLOW,
    )
  } catch (error: unknown) {
    if (isMissingAlarmOutput(error)) return undefined
    return failInputFile()
  }
  try {
    const initial = await handle.stat({ bigint: true })
    if (
      !initial.isFile() ||
      initial.nlink !== 1n ||
      (initial.mode & 0o777n) !== 0o600n ||
      initial.size === 0n ||
      initial.size > BigInt(maximumBytes)
    ) {
      return failInputFile()
    }
    const buffer = new Uint8Array(maximumBytes + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      )
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const final = await handle.stat({ bigint: true })
    if (
      offset === 0 ||
      offset > maximumBytes ||
      !final.isFile() ||
      initial.dev !== final.dev ||
      initial.ino !== final.ino ||
      initial.mode !== final.mode ||
      initial.nlink !== final.nlink ||
      initial.size !== final.size ||
      initial.mtimeNs !== final.mtimeNs ||
      initial.ctimeNs !== final.ctimeNs ||
      initial.size !== BigInt(offset)
    ) {
      return failInputFile()
    }
    return buffer.slice(0, offset)
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmCliFailure) {
      throw error
    }
    return failInputFile()
  } finally {
    try {
      await handle.close()
    } catch {
      // Raw close failures never cross the stable filesystem boundary.
    }
  }
}

/**
 * Detects only a direct own-property ENOENT from the filesystem boundary.
 *
 * @param error Candidate filesystem failure.
 * @returns Whether the output path was positively absent.
 */
function isMissingAlarmOutput(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) {
    return false
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value === 'ENOENT'
}

/** Default finite filesystem, clock, output, and AWS composition boundary. */
const defaultAlarmCliDependencies:
  WorkspaceSearchMigrationRehearsalAlarmCliDependencies = Object.freeze({
    readInputFile: readBoundedInputFile,
    readPermitKeyFile:
      readWorkspaceSearchMigrationRehearsalPermitSigningKey,
    readOutputFileIfExists: readAlarmOutputFileIfExists,
    writeOutputFileExclusive:
      writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
    createAwsRuntime:
      createWorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime,
    clock: () => new Date(),
    writeStdoutLine: (line: string): void => {
      console.log(line)
    },
    writeStderrLine: (line: string): void => {
      console.error(line)
    },
  })

/** Raises one strict invalid-plan failure. */
function failInvalidPlan(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
    'INVALID_PLAN',
    2,
  )
}

/** Raises one invalid process usage failure. */
function failInvalidUsage(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Raises one invalid bounded input failure. */
function failInputFile(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
    'INPUT_FILE_INVALID',
    2,
  )
}

/** Raises one exact caller or permit authentication failure. */
function failAuthentication(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
    'AUTHENTICATION_FAILED',
    1,
  )
}

/** Raises one actual receipt or history collection failure. */
function failCollection(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
    'COLLECTION_FAILED',
    1,
  )
}

/** Raises one exclusive output collision. */
function failOutputExists(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmCliFailure(
    'OUTPUT_FILE_EXISTS',
    1,
  )
}

if (import.meta.main) {
  void runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
    Bun.argv.slice(2),
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
