import { DescribeAlarmHistoryCommand } from '@aws-sdk/client-cloudwatch'
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  serializeCanonicalJson,
} from './migration-contract'
import {
  verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  verifyWorkspaceSearchMigrationRehearsalAlarmIngestionBinding,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
} from './migration-rehearsal-alarm-ingestion'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import { hasOnlyPairedSurrogates } from './migration-value-guards'
import {
  createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings,
  verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  type WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricName,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalBinding,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
} from './migration-telemetry-rehearsal'

/** Exact migration alarm labels required by the non-production rehearsal. */
export type WorkspaceSearchMigrationRehearsalAlarmName =
  | 'throttle'
  | 'budget-stop'
  | 'budget-exhaustion'
  | 'checkpoint-stall'
  | 'quarantine'
  | 'terminal-failure'

/** Canonical complete alarm set required by the delivery rehearsal. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS:
  readonly WorkspaceSearchMigrationRehearsalAlarmName[] = Object.freeze([
    'throttle',
    'budget-stop',
    'budget-exhaustion',
    'checkpoint-stall',
    'quarantine',
    'terminal-failure',
  ])

/** One real CloudWatch alarm transition and dual-route delivery result. */
export type WorkspaceSearchMigrationRehearsalAlarmEvidence = {
  /** Canonical alarm label. */
  readonly name: WorkspaceSearchMigrationRehearsalAlarmName
  /** Mandatory successful delivery rehearsal outcome. */
  readonly status: 'pass'
  /** State observed before the controlled EMF signal. */
  readonly initialState: 'OK'
  /** State observed after the alarm evaluation. */
  readonly alarmState: 'ALARM'
  /** State observed after the later recovery evaluation window. */
  readonly recoveredState: 'OK'
  /** Canonical UTC time of the OK-to-ALARM history event. */
  readonly alarmObservedAt: string
  /** Canonical UTC time of the later ALARM-to-OK history event. */
  readonly recoveredAt: string
  /** Digest of the identifier-free EMF signal record. */
  readonly signalDigest: string
  /** Digest of the normalized OK-to-ALARM-to-OK history. */
  readonly historyDigest: string
  /** Digest of the normalized primary subscription receipt. */
  readonly primaryReceiptDigest: string
  /** Canonical UTC time at which the primary subscriber received ALARM. */
  readonly primaryReceivedAt: string
  /** Digest of the normalized secondary subscription receipt. */
  readonly secondaryReceiptDigest: string
  /** Canonical UTC time at which the secondary subscriber received ALARM. */
  readonly secondaryReceivedAt: string
}

/** Stable discriminator for a digest-only alarm delivery receipt artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_KIND =
  'mukuroji-workspace-search-migration-rehearsal-alarm-receipts'

/** Exact alarm-delivery receipt artifact contract version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_VERSION = 2

/** Stable discriminator for collector-authenticated CloudWatch alarm history. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_KIND =
  'mukuroji-workspace-search-migration-rehearsal-alarm-history'

/** Exact collector-authenticated CloudWatch alarm history contract version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_VERSION = 2

/** Stable discriminator for the complete immutable alarm-delivery artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_KIND =
  'mukuroji-workspace-search-migration-rehearsal-alarm-delivery'

/** Exact combined alarm-delivery artifact contract version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_VERSION = 3

/** Primary or secondary SNS delivery route. */
export type WorkspaceSearchMigrationRehearsalAlarmRoute =
  | 'primary'
  | 'secondary'

/** Canonical route order within each alarm's receipt pair. */
const workspaceSearchMigrationRehearsalAlarmRoutes:
  readonly WorkspaceSearchMigrationRehearsalAlarmRoute[] = Object.freeze([
    'primary',
    'secondary',
  ])

/** Stable raw-value-free failure classifications for alarm evidence collection. */
export type WorkspaceSearchMigrationRehearsalAlarmEvidenceFailureCode =
  | 'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE'
  | 'MIGRATION_REHEARSAL_ALARM_EVIDENCE_TIMEOUT'
  | 'MIGRATION_REHEARSAL_ALARM_EVIDENCE_UPSTREAM_FAILURE'

/** Raw-value-free failure raised by the collector and finalizer. */
export class WorkspaceSearchMigrationRehearsalAlarmEvidenceError
  extends Error {
  /** Stable machine-readable failure classification. */
  readonly code: WorkspaceSearchMigrationRehearsalAlarmEvidenceFailureCode

  /**
   * Creates one alarm evidence failure without embedding AWS payloads.
   *
   * @param code Stable failure classification.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalAlarmEvidenceFailureCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalAlarmEvidenceError'
    this.code = code
  }
}

/** One route-specific queue and its expected SNS topic. */
export type WorkspaceSearchMigrationRehearsalAlarmRouteInput = {
  /** Concrete HTTPS SQS queue URL emitted by the non-production stack. */
  readonly queueUrl: string
  /** Concrete same-environment SNS topic ARN for this route. */
  readonly topicArn: string
}

/** One prior OK-to-ALARM transition explicitly authorized for stale cleanup. */
export type WorkspaceSearchMigrationRehearsalAuthorizedStaleTransition = {
  /** Canonical identifier-free alarm label. */
  readonly name: WorkspaceSearchMigrationRehearsalAlarmName
  /** Canonical UTC time of the prior CloudWatch state transition. */
  readonly alarmObservedAt: string
}

/** Strict collector input bound to one rehearsal window and alarm set. */
export type CollectWorkspaceSearchMigrationRehearsalAlarmEvidenceInput = {
  /** Six concrete alarm ARNs in canonical evidence order. */
  readonly alarmArns: readonly string[]
  /** Finite prior transitions whose exact dual-route messages may be removed. */
  readonly authorizedStaleTransitions:
    readonly WorkspaceSearchMigrationRehearsalAuthorizedStaleTransition[]
  /** Permit-authenticated digest of the exact collection plan. */
  readonly collectionBindingDigest: string
  /** Restricted runtime key authenticating the secret-free artifact. */
  readonly collectionSigningKey: Uint8Array
  /** Exact non-production account already authenticated by the session. */
  readonly expectedAccountId: string
  /** Exact non-production region already authenticated by the session. */
  readonly expectedRegion: string
  /** Maximum total collection duration in milliseconds. */
  readonly maximumWaitMilliseconds: number
  /** Maximum duration of each SQS request in milliseconds. */
  readonly requestTimeoutMilliseconds: number
  /** Primary notification route and dedicated queue. */
  readonly primary: WorkspaceSearchMigrationRehearsalAlarmRouteInput
  /** Secondary notification route and dedicated queue. */
  readonly secondary: WorkspaceSearchMigrationRehearsalAlarmRouteInput
  /** Canonical UTC start of the real alarm rehearsal. */
  readonly startedAt: string
}

/** One untrusted SQS message exposed only inside the restricted collector. */
export type WorkspaceSearchMigrationRehearsalRawAlarmMessage = {
  /** Raw SNS envelope body. */
  readonly body: unknown
  /** Opaque receipt handle used only to delete an accepted message. */
  readonly receiptHandle: unknown
  /** SQS `SentTimestamp` system attribute. */
  readonly sentTimestamp: unknown
}

/** Bounded receive request issued by the collector. */
export type WorkspaceSearchMigrationRehearsalAlarmReceiveInput = {
  /** Abort signal enforcing the request deadline. */
  readonly abortSignal: AbortSignal
  /** Concrete restricted SQS queue URL. */
  readonly queueUrl: string
  /** Route whose topic identity is expected in every envelope. */
  readonly route: WorkspaceSearchMigrationRehearsalAlarmRoute
  /** SQS long-poll duration from zero through twenty seconds. */
  readonly waitTimeSeconds: number
}

/** Bounded accepted-message deletion request. */
export type WorkspaceSearchMigrationRehearsalAlarmDeleteInput = {
  /** Abort signal enforcing the request deadline. */
  readonly abortSignal: AbortSignal
  /** Concrete restricted SQS queue URL. */
  readonly queueUrl: string
  /** Opaque validated SQS receipt handle. */
  readonly receiptHandle: string
  /** Route used only for finite operation attribution. */
  readonly route: WorkspaceSearchMigrationRehearsalAlarmRoute
}

/** Restricted queue boundary used by the alarm evidence collector. */
export interface WorkspaceSearchMigrationRehearsalAlarmQueuePort {
  /**
   * Receives at most ten messages using one bounded long poll.
   *
   * @param input Queue, route, wait, and abort boundary.
   * @returns Untrusted queue messages for strict validation.
   */
  receive(
    input: WorkspaceSearchMigrationRehearsalAlarmReceiveInput,
  ): Promise<readonly WorkspaceSearchMigrationRehearsalRawAlarmMessage[]>

  /**
   * Deletes exactly one already-validated receipt from its route queue.
   *
   * @param input Queue, route, receipt handle, and abort boundary.
   * @returns Nothing.
   */
  delete(
    input: WorkspaceSearchMigrationRehearsalAlarmDeleteInput,
  ): Promise<void>
}

/** Minimal SQS client shape accepted by the concrete queue adapter. */
export interface WorkspaceSearchMigrationRehearsalAlarmSqsClient {
  /**
   * Sends one receive or delete command with an abort signal.
   *
   * @param command Exact SQS command.
   * @param options Per-request abort boundary.
   * @returns Untrusted SDK response.
   */
  send(
    command: ReceiveMessageCommand | DeleteMessageCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown>
}

/** One accepted receipt containing only timestamps and domain-separated digests. */
export type WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt = {
  /** Canonical identifier-free alarm label. */
  readonly name: WorkspaceSearchMigrationRehearsalAlarmName
  /** Digest of the exact expected physical alarm ARN. */
  readonly alarmIdentityDigest: string
  /** Primary or secondary real delivery route. */
  readonly route: WorkspaceSearchMigrationRehearsalAlarmRoute
  /** Canonical SQS enqueue time proving actual delivery. */
  readonly receivedAt: string
  /** Canonical CloudWatch OK-to-ALARM time carried by the notification. */
  readonly alarmObservedAt: string
  /** Domain-separated digest of the actual SNS message identifier. */
  readonly messageIdDigest: string
  /** Digest binding alarm, route, topic, message, transition, and timestamp. */
  readonly receiptDigest: string
}

/** Complete digest-only child artifact produced by the collector. */
export type WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact = {
  /** Stable artifact discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_KIND
  /** Exact receipt artifact contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_VERSION
  /** Digest of the exact permit-authenticated collection plan. */
  readonly collectionBindingDigest: string
  /** Canonical collection start time. */
  readonly startedAt: string
  /** Canonical collection completion time. */
  readonly completedAt: string
  /** Twelve receipts ordered by alarm and then primary/secondary route. */
  readonly receipts:
    readonly WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt[]
  /** Digest of every preceding artifact field. */
  readonly artifactDigest: string
  /** Runtime-key HMAC binding the complete artifact to its collection plan. */
  readonly collectionAuthentication: string
}

/** Strict claims used to create one plan-authenticated receipt artifact. */
export type CreateWorkspaceSearchMigrationRehearsalAlarmReceiptArtifactInput = {
  /** Digest of the exact permit-authenticated collection plan. */
  readonly collectionBindingDigest: string
  /** Canonical collection start time. */
  readonly startedAt: string
  /** Canonical collection completion time. */
  readonly completedAt: string
  /** Twelve receipts ordered by alarm and then primary/secondary route. */
  readonly receipts:
    readonly WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt[]
}

/**
 * Process-local two-phase receipt collection awaiting durable acknowledgement.
 */
export interface WorkspaceSearchMigrationRehearsalPendingAlarmReceiptCollection {
  /** Complete secret-free artifact safe to serialize before acknowledgement. */
  readonly artifact: WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact

  /**
   * Deletes all twelve validated messages only after durable publication.
   *
   * Failed opaque handles remain pending so the same capability can be retried.
   *
   * @returns Nothing after every validated message is acknowledged.
   */
  acknowledge(): Promise<void>
}

/** One real OK-to-ALARM-to-OK transition collected from CloudWatch history. */
export type WorkspaceSearchMigrationRehearsalAlarmTransition = {
  /** Canonical identifier-free alarm label. */
  readonly name: WorkspaceSearchMigrationRehearsalAlarmName
  /** Digest of the exact expected physical alarm ARN. */
  readonly alarmIdentityDigest: string
  /** State observed before the signal. */
  readonly initialState: 'OK'
  /** State observed after the signal. */
  readonly alarmState: 'ALARM'
  /** State observed after the recovery window. */
  readonly recoveredState: 'OK'
  /** Canonical UTC OK-to-ALARM history time. */
  readonly alarmObservedAt: string
  /** Canonical UTC ALARM-to-OK history time. */
  readonly recoveredAt: string
  /** Digest of the exact identifier-free signal record. */
  readonly signalDigest: string
  /** Canonical UTC time carried by the authenticated exact signal line. */
  readonly signalObservedAt: string
  /** Exact alarm metric set to one by the authenticated signal line. */
  readonly signalMetricName:
    WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricName
  /** Digest binding sanitized metric evaluations to the expected signal. */
  readonly metricEvaluationDigest: string
  /** Digest of the normalized CloudWatch history. */
  readonly historyDigest: string
}

/** Collector-authenticated six-alarm CloudWatch history artifact. */
export type WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact = {
  /** Stable collector artifact discriminator. */
  readonly kind: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_KIND
  /** Exact collector artifact contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_VERSION
  /** Canonical inclusive history window start. */
  readonly startedAt: string
  /** Canonical inclusive history window completion. */
  readonly completedAt: string
  /** Six collected transitions in canonical alarm order. */
  readonly transitions:
    readonly WorkspaceSearchMigrationRehearsalAlarmTransition[]
  /** Digest binding every preceding history artifact claim. */
  readonly artifactDigest: string
}

/** Complete immutable alarm-delivery artifact published by the finalizer. */
export type WorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact = {
  /** Stable complete alarm-delivery discriminator. */
  readonly kind: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_KIND
  /** Exact complete alarm-delivery contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_VERSION
  /** Purpose-specific permit and shared session authorization binding. */
  readonly authorization:
    WorkspaceSearchMigrationRehearsalAlarmAuthorization
  /** Actual twelve-receipt SQS/SNS collector artifact. */
  readonly receiptArtifact:
    WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact
  /** HMAC-authenticated exact five-positive-plus-recovery EMF evidence. */
  readonly signalArtifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact
  /** Digest-only HMAC-authenticated receipt for each actual Logs ingestion. */
  readonly ingestionArtifact:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact
  /** Actual six-transition CloudWatch history collector artifact. */
  readonly transitionArtifact:
    WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact
  /** Digest binding both complete nested collector artifacts. */
  readonly artifactDigest: string
  /** Parent-only publication authorization over every complete artifact claim. */
  readonly parentPublicationAuthentication:
    WorkspaceSearchMigrationRehearsalAlarmPublicationAuthentication
}

/** Parent-only authentication attached to the final alarm artifact. */
export type WorkspaceSearchMigrationRehearsalAlarmPublicationAuthentication = {
  /** Fixed parent authentication algorithm. */
  readonly algorithm: 'HMAC-SHA-256'
  /** Domain-separated fingerprint of the parent publication key. */
  readonly keyFingerprint: string
  /** Parent HMAC over every artifact claim and the key fingerprint. */
  readonly artifactMac: string
}

/** Purpose-specific authorization bound into the complete alarm artifact. */
export type WorkspaceSearchMigrationRehearsalAlarmAuthorization = {
  /** Digest of the exact authenticated alarm-purpose permit document. */
  readonly permitDigest: string
  /** Exact alarm collection-plan requested-resource binding. */
  readonly requestedResourcesBinding: string
  /** Digest shared with main caller, isolation, resource, and commit claims. */
  readonly sharedSessionBindingDigest: string
}

/** Main-session claims used to bind a purpose-specific alarm permit. */
export type WorkspaceSearchMigrationRehearsalAlarmSharedSessionBindingInput = {
  /** Exact reviewed commit shared by the main and alarm permits. */
  readonly commit: string
  /** Digest authenticating the exact non-production caller identity. */
  readonly callerAttestationDigest: string
  /** Digest proving separation from the production AWS account. */
  readonly productionIsolationDigest: string
  /** Digest authenticating the main migration resource inventory. */
  readonly resourceAttestationDigest: string
}

/**
 * Creates the binding shared by the main rehearsal and alarm-only permit.
 *
 * Purpose-specific permit timestamps and requested alarm resources are
 * intentionally excluded. The combined alarm artifact carries those values
 * separately while this digest proves that both permits authorize the same
 * commit, caller, isolation boundary, and main migration resources.
 *
 * @param input Authenticated main-session claims shared by both permits.
 * @returns Domain-separated digest embedded in alarm authorization evidence.
 */
export function createWorkspaceSearchMigrationRehearsalAlarmSharedClaimsBinding(
  input: WorkspaceSearchMigrationRehearsalAlarmSharedSessionBindingInput,
): string {
  const record = alarmGuards.requireRecord(input)
  alarmGuards.requireExactKeys(record, [
    'callerAttestationDigest',
    'commit',
    'productionIsolationDigest',
    'resourceAttestationDigest',
  ])
  const commit = alarmGuards.readOwn(record, 'commit')
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) {
    return failInvalid()
  }
  return createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-shared-session-binding',
    version: 1,
    commit,
    callerAttestationDigest: alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'callerAttestationDigest'),
    ),
    productionIsolationDigest: alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'productionIsolationDigest'),
    ),
    resourceAttestationDigest: alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'resourceAttestationDigest'),
    ),
  })
}

/** One authenticated exact EMF signal bound to its expected alarm. */
export type WorkspaceSearchMigrationRehearsalAlarmSignalBinding =
  WorkspaceSearchMigrationTelemetryRehearsalSignalBinding

/** Strict bounded input for real CloudWatch alarm history collection. */
export type CollectWorkspaceSearchMigrationRehearsalAlarmHistoryInput = {
  /** Six concrete alarm ARNs in canonical evidence order. */
  readonly alarmArns: readonly string[]
  /** Exact non-production account authenticated by the rehearsal session. */
  readonly expectedAccountId: string
  /** Exact non-production region authenticated by the rehearsal session. */
  readonly expectedRegion: string
  /** Maximum total history collection duration in milliseconds. */
  readonly maximumWaitMilliseconds: number
  /** Maximum accepted page count for each physical alarm. */
  readonly maximumPagesPerAlarm: number
  /** Maximum duration of each CloudWatch request in milliseconds. */
  readonly requestTimeoutMilliseconds: number
  /** Canonical signal digest vector in alarm order. */
  readonly signals:
    readonly WorkspaceSearchMigrationRehearsalAlarmSignalBinding[]
  /** Canonical inclusive rehearsal history start. */
  readonly startedAt: string
  /** Canonical inclusive rehearsal history completion. */
  readonly completedAt: string
}

/** One untrusted projected CloudWatch alarm history item. */
export type WorkspaceSearchMigrationRehearsalRawAlarmHistoryItem = {
  /** Physical alarm name returned by CloudWatch. */
  readonly alarmName: unknown
  /** Metric or composite alarm classification. */
  readonly alarmType: unknown
  /** JSON state transition document returned by CloudWatch. */
  readonly historyData: unknown
  /** CloudWatch history event classification. */
  readonly historyItemType: unknown
  /** SDK timestamp value returned by CloudWatch. */
  readonly timestamp: unknown
}

/** One bounded page request issued by the alarm history collector. */
export type WorkspaceSearchMigrationRehearsalAlarmHistoryPageInput = {
  /** Abort signal enforcing the request deadline. */
  readonly abortSignal: AbortSignal
  /** Exact expected alarm ARN, retained only inside the restricted boundary. */
  readonly alarmArn: string
  /** Exact physical alarm name extracted from the expected ARN. */
  readonly alarmName: string
  /** Canonical inclusive history end time. */
  readonly endDate: Date
  /** Optional opaque CloudWatch pagination token. */
  readonly nextToken?: string
  /** Exact authenticated non-production account. */
  readonly expectedAccountId: string
  /** Exact authenticated non-production region. */
  readonly expectedRegion: string
  /** Canonical inclusive history start time. */
  readonly startDate: Date
}

/** Restricted projection returned from one CloudWatch history page. */
export type WorkspaceSearchMigrationRehearsalAlarmHistoryPage = {
  /** Projected untrusted history items. */
  readonly items:
    readonly WorkspaceSearchMigrationRehearsalRawAlarmHistoryItem[]
  /** Optional untrusted pagination token. */
  readonly nextToken: unknown
}

/** Restricted CloudWatch boundary used by the alarm history collector. */
export interface WorkspaceSearchMigrationRehearsalAlarmHistoryPort {
  /**
   * Reads one bounded ascending state-update page for one expected alarm.
   *
   * @param input Exact alarm, history window, pagination, and abort boundary.
   * @returns Restricted untrusted history projection.
   */
  readPage(
    input: WorkspaceSearchMigrationRehearsalAlarmHistoryPageInput,
  ): Promise<WorkspaceSearchMigrationRehearsalAlarmHistoryPage>
}

/** Minimal CloudWatch client shape accepted by the concrete history adapter. */
export interface WorkspaceSearchMigrationRehearsalAlarmCloudWatchClient {
  /**
   * Sends one DescribeAlarmHistory request with an abort signal.
   *
   * @param command Exact read-only CloudWatch command.
   * @param options Per-request abort boundary.
   * @returns Untrusted SDK response.
   */
  send(
    command: DescribeAlarmHistoryCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown>
}

/** Finalized alarm evidence and exact immutable combined artifact bytes. */
export type WorkspaceSearchMigrationRehearsalFinalizedAlarmEvidence = {
  /** Six strict history-and-delivery evidence records. */
  readonly evidence: readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[]
  /** Purpose-specific permit and shared session binding retained for the suite. */
  readonly authorization:
    WorkspaceSearchMigrationRehearsalAlarmAuthorization
  /** Detached exact canonical authorization, receipt, and history bytes. */
  readonly canonicalArtifactBytes: Uint8Array
  /** SHA-256 digest of the exact canonical artifact bytes. */
  readonly artifactDigest: string
  /** Exact canonical artifact byte length. */
  readonly artifactByteLength: number
  /** Exact count of actual primary and secondary receipts. */
  readonly receiptCount: 12
}

/** Input that binds collected real transitions to actual dual-route receipts. */
export type FinalizeWorkspaceSearchMigrationRehearsalAlarmEvidenceInput = {
  /** Purpose-specific permit and shared session authorization binding. */
  readonly authorization:
    WorkspaceSearchMigrationRehearsalAlarmAuthorization
  /** Complete validated digest-only receipt artifact. */
  readonly receiptArtifact:
    WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact
  /** Complete HMAC-authenticated exact signal and recovery receipt chain. */
  readonly signalArtifact: unknown
  /** Complete digest-only actual CloudWatch Logs ingestion receipt chain. */
  readonly ingestionArtifact: unknown
  /** Restricted exact 32-byte alarm-purpose signal verification key. */
  readonly signalVerificationKey: Uint8Array
  /** Distinct parent-only 32-byte publication signing key. */
  readonly publicationSigningKey: Uint8Array
  /** Collector-authenticated six-alarm CloudWatch history artifact. */
  readonly transitionArtifact:
    WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact
}

/** Internal concrete identity parsed from one expected alarm ARN. */
type AlarmExpectation = {
  /** Canonical identifier-free alarm label. */
  readonly name: WorkspaceSearchMigrationRehearsalAlarmName
  /** Exact concrete CloudWatch alarm ARN. */
  readonly alarmArn: string
  /** Exact physical alarm name extracted from the ARN. */
  readonly alarmName: string
}

/** Internal route configuration after same-environment validation. */
type RouteExpectation = {
  /** Primary or secondary route. */
  readonly route: WorkspaceSearchMigrationRehearsalAlarmRoute
  /** Exact restricted queue URL. */
  readonly queueUrl: string
  /** Exact route topic ARN. */
  readonly topicArn: string
}

/** Parsed concrete ARN identity shared across expected resources. */
type ArnIdentity = {
  /** AWS partition. */
  readonly partition: 'aws' | 'aws-cn' | 'aws-us-gov'
  /** AWS region. */
  readonly region: string
  /** Twelve-digit AWS account. */
  readonly accountId: string
  /** Concrete resource name. */
  readonly resourceName: string
}

/** Parsed trusted fields from one actual SNS/CloudWatch notification. */
type ParsedNotification = {
  /** Exact physical alarm ARN matched to the expectation. */
  readonly alarmArn: string
  /** Exact SNS message identifier, retained only until it is digested. */
  readonly messageId: string
  /** Canonical SNS publication time. */
  readonly publishedAt: string
  /** Canonical CloudWatch OK-to-ALARM transition time. */
  readonly stateChangeAt: string
}

/** Opaque process-local deletion capability for one validated queue message. */
type PendingAlarmReceiptDeletion = {
  /** Stable identifier-free pending-map key. */
  readonly key: string
  /** Exact restricted queue URL retained only in process memory. */
  readonly queueUrl: string
  /** Raw opaque SQS receipt handle retained only in process memory. */
  readonly receiptHandle: string
  /** Route used only to construct the restricted delete request. */
  readonly route: WorkspaceSearchMigrationRehearsalAlarmRoute
}

/** Validated configuration for bounded CloudWatch history collection. */
type AlarmHistoryCollectorConfiguration = {
  /** Six expected physical alarms in canonical order. */
  readonly alarms: readonly AlarmExpectation[]
  /** Canonical inclusive history completion. */
  readonly completedAt: string
  /** Exact authenticated non-production account. */
  readonly expectedAccountId: string
  /** Exact authenticated non-production region. */
  readonly expectedRegion: string
  /** Maximum accepted pages for each alarm. */
  readonly maximumPagesPerAlarm: number
  /** Maximum total collection duration. */
  readonly maximumWaitMilliseconds: number
  /** Maximum duration of each CloudWatch request. */
  readonly requestTimeoutMilliseconds: number
  /** Six canonical signal digest bindings. */
  readonly signals:
    readonly WorkspaceSearchMigrationRehearsalAlarmSignalBinding[]
  /** Canonical inclusive history start. */
  readonly startedAt: string
}

/** Normalized state update retained after strict CloudWatch history parsing. */
type ParsedAlarmHistoryStateUpdate = {
  /** Exact old CloudWatch alarm state. */
  readonly oldState: 'OK' | 'ALARM'
  /** Exact new CloudWatch alarm state. */
  readonly newState: 'OK' | 'ALARM'
  /** Canonical UTC CloudWatch history timestamp. */
  readonly observedAt: string
  /** Sanitized metric evaluation that produced the new state. */
  readonly evaluation: ParsedAlarmMetricEvaluation
}

/** One sanitized CloudWatch datapoint used in a metric-alarm evaluation. */
type ParsedAlarmEvaluatedDatapoint = {
  /** Canonical metric period timestamp. */
  readonly timestamp: string
  /** Finite positive CloudWatch sample count. */
  readonly sampleCount: number
  /** Finite evaluated metric value. */
  readonly value: number
}

/** Sanitized single-metric evaluation facts admitted from stateReasonData. */
type ParsedAlarmMetricEvaluation = {
  /** Canonical time at which CloudWatch queried the metric. */
  readonly queryDate: string
  /** Canonical beginning of the evaluated metric range. */
  readonly startDate: string
  /** Exact expected alarm statistic. */
  readonly statistic: 'Sum'
  /** Exact expected alarm period in seconds. */
  readonly period: 300
  /** Finite recent metric values returned by CloudWatch. */
  readonly recentDatapoints: readonly number[]
  /** Exact expected alarm threshold. */
  readonly threshold: 1
  /** Structured datapoints CloudWatch actually evaluated. */
  readonly evaluatedDatapoints: readonly ParsedAlarmEvaluatedDatapoint[]
}

/** Collector dependencies allowing deterministic time tests. */
export type WorkspaceSearchMigrationRehearsalAlarmCollectorDependencies = {
  /** Monotonic-enough wall-clock milliseconds used for all deadlines. */
  readonly now: () => number
  /** Waits before retrying a terminal but incomplete CloudWatch history page. */
  readonly sleep: (milliseconds: number) => Promise<void>
}

/** Maximum raw SQS body admitted by the restricted collector. */
const maximumRawBodyBytes = 64 * 1_024

/** Maximum canonical bytes accepted for the digest-only receipt artifact. */
const maximumReceiptArtifactBytes = 64 * 1_024

/** Maximum canonical bytes accepted for the complete alarm-delivery artifact. */
const maximumAlarmDeliveryArtifactBytes = 64 * 1_024

/** Domain separating parent alarm-artifact key fingerprints. */
const alarmPublicationKeyFingerprintDomain =
  'mukuroji-workspace-search-migration-rehearsal-alarm-publication-key/v1\n'

/** Domain separating final parent alarm-artifact authorization HMACs. */
const alarmPublicationMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-alarm-publication-mac/v1\n'

/** Domain separating plan-bound receipt collection authentication. */
const alarmReceiptCollectionAuthenticationDomain =
  'mukuroji-workspace-search-migration-rehearsal-alarm-receipt-collection/v1\n'

/** Maximum total collection window. */
const maximumCollectionWaitMilliseconds = 15 * 60 * 1_000

/** Minimum total collection window. */
const minimumCollectionWaitMilliseconds = 1_000

/** Maximum individual SQS request timeout. */
const maximumRequestTimeoutMilliseconds = 30_000

/** Minimum individual SQS request timeout. */
const minimumRequestTimeoutMilliseconds = 100

/** Maximum number of SQS messages accepted from one receive response. */
const maximumReceiveBatchSize = 10

/** Maximum prior transitions admitted by one canonical six-alarm plan. */
const maximumAuthorizedStaleTransitions =
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length

/** Maximum SQS retention interval covered by stale-transition cleanup. */
const maximumAuthorizedStaleTransitionAgeMilliseconds =
  14 * 24 * 60 * 60 * 1_000

/** Maximum accepted CloudWatch history items in one projected page. */
const maximumAlarmHistoryPageSize = 100

/** Maximum accepted page count for one alarm. */
const maximumAlarmHistoryPagesPerAlarm = 10

/** Delay between terminal CloudWatch history polls while transitions propagate. */
const alarmHistoryPollIntervalMilliseconds = 1_000

/** Maximum bounded delete rounds before acknowledgement fails closed. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ACKNOWLEDGEMENT_ATTEMPTS =
  3

/** Small bound permitting service-clock ordering without accepting stale runs. */
const serviceClockSkewMilliseconds = 5_000

/** Exact UUID representation used by SNS message identifiers. */
const snsMessageIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Exact supported ARN partitions. */
const arnPattern = /^arn:(aws|aws-cn|aws-us-gov):/

/** Strict guards bound to the stable invalid-evidence failure. */
const alarmGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failInvalid,
)

/** Waits for one bounded CloudWatch history propagation interval. */
function waitForAlarmHistoryRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/** Process-local acknowledgement barrier hiding every raw receipt handle. */
class PendingAlarmReceiptCollection
implements WorkspaceSearchMigrationRehearsalPendingAlarmReceiptCollection {
  /** Complete secret-free receipt artifact. */
  readonly artifact: WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact

  /** Restricted queue capability retained behind hard private state. */
  readonly #port: WorkspaceSearchMigrationRehearsalAlarmQueuePort

  /** Per-delete finite timeout. */
  readonly #requestTimeoutMilliseconds: number

  /** Opaque deletion capabilities still requiring acknowledgement. */
  readonly #pendingDeletions = new Map<string, PendingAlarmReceiptDeletion>()

  /** Shared in-flight acknowledgement preventing concurrent duplicate rounds. */
  #acknowledgement: Promise<void> | undefined

  /**
   * Creates a process-local durable-publication barrier.
   *
   * @param artifact Complete secret-free receipt artifact.
   * @param deletions Exact twelve validated opaque deletion capabilities.
   * @param port Restricted queue port.
   * @param requestTimeoutMilliseconds Finite timeout for every delete request.
   */
  constructor(
    artifact: WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
    deletions: readonly PendingAlarmReceiptDeletion[],
    port: WorkspaceSearchMigrationRehearsalAlarmQueuePort,
    requestTimeoutMilliseconds: number,
  ) {
    this.artifact = artifact
    this.#port = port
    this.#requestTimeoutMilliseconds = requestTimeoutMilliseconds
    if (
      deletions.length !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length * 2
    ) {
      failInvalid()
    }
    for (const deletion of deletions) {
      if (this.#pendingDeletions.has(deletion.key)) failInvalid()
      this.#pendingDeletions.set(deletion.key, deletion)
    }
  }

  /**
   * Acknowledges every message through bounded retryable delete rounds.
   *
   * @returns Nothing after every opaque deletion capability succeeds.
   */
  async acknowledge(): Promise<void> {
    if (this.#pendingDeletions.size === 0) return
    if (this.#acknowledgement !== undefined) return this.#acknowledgement
    const operation = this.#acknowledgePendingDeletions()
    this.#acknowledgement = operation
    try {
      await operation
    } finally {
      this.#acknowledgement = undefined
    }
  }

  /**
   * Runs finite concurrent rounds while retaining only failed capabilities.
   *
   * @returns Nothing after all pending handles are deleted.
   */
  async #acknowledgePendingDeletions(): Promise<void> {
    for (
      let attempt = 0;
      attempt <
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ACKNOWLEDGEMENT_ATTEMPTS;
      attempt += 1
    ) {
      const pending = [...this.#pendingDeletions.values()]
      if (pending.length === 0) return
      const results = await Promise.allSettled(pending.map((deletion) =>
        runBoundedQueueOperation(
          (abortSignal) => this.#port.delete({
            abortSignal,
            queueUrl: deletion.queueUrl,
            receiptHandle: deletion.receiptHandle,
            route: deletion.route,
          }),
          this.#requestTimeoutMilliseconds,
        )))
      for (const [index, result] of results.entries()) {
        const deletion = pending[index]
        if (result.status === 'fulfilled' && deletion !== undefined) {
          this.#pendingDeletions.delete(deletion.key)
        }
      }
    }
    throw new WorkspaceSearchMigrationRehearsalAlarmEvidenceError(
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_UPSTREAM_FAILURE',
    )
  }
}

/** Concrete SQS adapter that never logs or returns a raw AWS response. */
export class WorkspaceSearchMigrationRehearsalAlarmSqsQueuePort
implements WorkspaceSearchMigrationRehearsalAlarmQueuePort {
  /** Restricted SQS client used for receive and delete requests. */
  readonly #client:
    WorkspaceSearchMigrationRehearsalAlarmSqsClient

  /**
   * Creates a queue adapter over an already authorized non-production client.
   *
   * @param client SQS client bound to the approved rehearsal session.
   */
  constructor(client: WorkspaceSearchMigrationRehearsalAlarmSqsClient) {
    this.#client = client
  }

  /**
   * Receives one bounded batch while retaining only fields needed for validation.
   *
   * @param input Queue, route, wait, and abort boundary.
   * @returns Restricted untrusted message projections.
   */
  async receive(
    input: WorkspaceSearchMigrationRehearsalAlarmReceiveInput,
  ): Promise<readonly WorkspaceSearchMigrationRehearsalRawAlarmMessage[]> {
    const response = await this.#client.send(new ReceiveMessageCommand({
      MaxNumberOfMessages: maximumReceiveBatchSize,
      MessageSystemAttributeNames: ['SentTimestamp'],
      QueueUrl: input.queueUrl,
      WaitTimeSeconds: input.waitTimeSeconds,
    }), { abortSignal: input.abortSignal })
    const responseRecord = alarmGuards.requireRecord(response)
    const messages = readOptionalOwn(responseRecord, 'Messages')
    if (messages === undefined) return []
    if (
      !Array.isArray(messages) ||
      nodeUtilTypes.isProxy(messages) ||
      messages.length > maximumReceiveBatchSize
    ) {
      return failInvalid()
    }
    const messageValues: readonly unknown[] = messages
    return messageValues.map((message) => {
      const record = alarmGuards.requireRecord(message)
      const attributes = readOptionalOwn(record, 'Attributes')
      const attributeRecord = attributes === undefined
        ? undefined
        : alarmGuards.requireRecord(attributes)
      return {
        body: readOptionalOwn(record, 'Body'),
        receiptHandle: readOptionalOwn(record, 'ReceiptHandle'),
        sentTimestamp: attributeRecord === undefined
          ? undefined
          : readOptionalOwn(attributeRecord, 'SentTimestamp'),
      }
    })
  }

  /**
   * Deletes one accepted queue receipt without retaining the SDK response.
   *
   * @param input Queue, route, receipt handle, and abort boundary.
   * @returns Nothing.
   */
  async delete(
    input: WorkspaceSearchMigrationRehearsalAlarmDeleteInput,
  ): Promise<void> {
    await this.#client.send(new DeleteMessageCommand({
      QueueUrl: input.queueUrl,
      ReceiptHandle: input.receiptHandle,
    }), { abortSignal: input.abortSignal })
  }
}

/** Concrete read-only CloudWatch adapter that projects only transition fields. */
export class WorkspaceSearchMigrationRehearsalAlarmCloudWatchHistoryPort
implements WorkspaceSearchMigrationRehearsalAlarmHistoryPort {
  /** Restricted CloudWatch client used only for alarm history reads. */
  readonly #client:
    WorkspaceSearchMigrationRehearsalAlarmCloudWatchClient

  /**
   * Creates a history adapter over an authorized non-production client.
   *
   * @param client CloudWatch client bound to the approved rehearsal session.
   */
  constructor(client: WorkspaceSearchMigrationRehearsalAlarmCloudWatchClient) {
    this.#client = client
  }

  /**
   * Reads one ascending metric-alarm state-update page.
   *
   * @param input Exact expected alarm, time window, token, and abort boundary.
   * @returns Restricted history item and pagination projection.
   */
  async readPage(
    input: WorkspaceSearchMigrationRehearsalAlarmHistoryPageInput,
  ): Promise<WorkspaceSearchMigrationRehearsalAlarmHistoryPage> {
    const response = await this.#client.send(new DescribeAlarmHistoryCommand({
      AlarmName: input.alarmName,
      AlarmTypes: ['MetricAlarm'],
      EndDate: input.endDate,
      HistoryItemType: 'StateUpdate',
      MaxRecords: maximumAlarmHistoryPageSize,
      NextToken: input.nextToken,
      ScanBy: 'TimestampAscending',
      StartDate: input.startDate,
    }), { abortSignal: input.abortSignal })
    const responseRecord = alarmGuards.requireRecord(response)
    const historyItems = readOptionalOwn(responseRecord, 'AlarmHistoryItems')
    if (historyItems === undefined) {
      return {
        items: [],
        nextToken: readOptionalOwn(responseRecord, 'NextToken'),
      }
    }
    if (
      !Array.isArray(historyItems) ||
      nodeUtilTypes.isProxy(historyItems) ||
      historyItems.length > maximumAlarmHistoryPageSize
    ) {
      return failInvalid()
    }
    const entries: readonly unknown[] = historyItems
    const items = entries.map((entry) => {
      const record = alarmGuards.requireRecord(entry)
      return {
        alarmName: readOptionalOwn(record, 'AlarmName'),
        alarmType: readOptionalOwn(record, 'AlarmType'),
        historyData: readOptionalOwn(record, 'HistoryData'),
        historyItemType: readOptionalOwn(record, 'HistoryItemType'),
        timestamp: readOptionalOwn(record, 'Timestamp'),
      }
    })
    return {
      items,
      nextToken: readOptionalOwn(responseRecord, 'NextToken'),
    }
  }
}

/**
 * Collects exactly six primary and six secondary real alarm deliveries.
 *
 * Raw SNS envelopes, CloudWatch messages, topic ARNs, alarm ARNs, message IDs,
 * and SQS receipt handles remain local to this call. The returned artifact
 * contains only canonical timestamps and domain-separated SHA-256 digests.
 * Every receive/delete request and the total polling loop are finite.
 *
 * @param input Expected non-production resources and finite collection bounds.
 * @param port Restricted queue port.
 * @param dependencies Optional deterministic wall clock.
 * @returns Secret-free artifact and process-local post-publication acknowledgement.
 */
export async function collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
  input: CollectWorkspaceSearchMigrationRehearsalAlarmEvidenceInput,
  port: WorkspaceSearchMigrationRehearsalAlarmQueuePort,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCollectorDependencies = {
    now: Date.now,
    sleep: waitForAlarmHistoryRetry,
  },
): Promise<WorkspaceSearchMigrationRehearsalPendingAlarmReceiptCollection> {
  try {
    const configuration = readCollectorConfiguration(input)
    const startedAtMilliseconds = Date.parse(configuration.startedAt)
    const collectionStartedMilliseconds = dependencies.now()
    if (
      !Number.isSafeInteger(collectionStartedMilliseconds) ||
      collectionStartedMilliseconds + serviceClockSkewMilliseconds <
        startedAtMilliseconds
    ) {
      return failInvalid()
    }
    const deadlineMilliseconds = collectionStartedMilliseconds +
      configuration.maximumWaitMilliseconds
    const maximumPollCycles = Math.ceil(
      configuration.maximumWaitMilliseconds / 1_000,
    ) + 2
    const receipts = new Map<
      string,
      WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt
    >()
    const messageIdDigests = new Set<string>()
    const deletions = new Map<string, PendingAlarmReceiptDeletion>()
    const staleDeletionKeys = new Set<string>()
    const routes = [configuration.primary, configuration.secondary]

    for (let cycle = 0; cycle < maximumPollCycles; cycle += 1) {
      for (const route of routes) {
        const remainingMilliseconds = deadlineMilliseconds - dependencies.now()
        if (remainingMilliseconds <= 0) return failTimeout()
        const waitTimeSeconds = Math.min(
          20,
          Math.max(0, Math.floor(remainingMilliseconds / 1_000)),
        )
        const messages = await runBoundedQueueOperation(
          (abortSignal) => port.receive({
            abortSignal,
            queueUrl: route.queueUrl,
            route: route.route,
            waitTimeSeconds,
          }),
          Math.min(
            configuration.requestTimeoutMilliseconds,
            remainingMilliseconds,
          ),
        )
        await consumeMessages(
          messages,
          route,
          configuration,
          receipts,
          messageIdDigests,
          deletions,
          staleDeletionKeys,
          port,
          dependencies,
          deadlineMilliseconds,
        )
      }

      if (receipts.size === WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length * 2) {
        await confirmNoImmediateDuplicate(
          routes,
          configuration,
          receipts,
          messageIdDigests,
          deletions,
          staleDeletionKeys,
          port,
          dependencies,
          deadlineMilliseconds,
        )
        const completedAtMilliseconds = dependencies.now()
        if (
          !Number.isSafeInteger(completedAtMilliseconds) ||
          completedAtMilliseconds > deadlineMilliseconds
        ) {
          return failTimeout()
        }
        const artifact = createReceiptArtifact(
          configuration.startedAt,
          completedAtMilliseconds,
          receipts,
          configuration.collectionBindingDigest,
          configuration.collectionSigningKey,
        )
        return new PendingAlarmReceiptCollection(
          artifact,
          [...deletions.values()],
          port,
          configuration.requestTimeoutMilliseconds,
        )
      }
    }
    return failTimeout()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    throw new WorkspaceSearchMigrationRehearsalAlarmEvidenceError(
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_UPSTREAM_FAILURE',
    )
  }
}

/**
 * Collects exactly one real OK-to-ALARM-to-OK history for each expected alarm.
 *
 * Only `DescribeAlarmHistory` is issued. Each request, per-alarm pagination,
 * and the complete six-alarm collection have explicit finite boundaries. Raw
 * CloudWatch history data and physical alarm identifiers never escape.
 *
 * @param input Exact non-production alarms, signal digests, and finite bounds.
 * @param port Restricted read-only CloudWatch history port.
 * @param dependencies Optional deterministic wall clock.
 * @returns Collector-authenticated canonical transition artifact.
 */
export async function collectWorkspaceSearchMigrationRehearsalAlarmHistory(
  input: CollectWorkspaceSearchMigrationRehearsalAlarmHistoryInput,
  port: WorkspaceSearchMigrationRehearsalAlarmHistoryPort,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCollectorDependencies = {
    now: Date.now,
    sleep: waitForAlarmHistoryRetry,
  },
): Promise<WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact> {
  try {
    const configuration = readHistoryCollectorConfiguration(input)
    const collectionStartedMilliseconds = dependencies.now()
    if (
      !Number.isSafeInteger(collectionStartedMilliseconds) ||
      collectionStartedMilliseconds + serviceClockSkewMilliseconds <
        Date.parse(configuration.completedAt)
    ) {
      return failInvalid()
    }
    const deadlineMilliseconds = collectionStartedMilliseconds +
      configuration.maximumWaitMilliseconds
    if (!Number.isSafeInteger(deadlineMilliseconds)) return failInvalid()
    const transitions: WorkspaceSearchMigrationRehearsalAlarmTransition[] = []

    for (const [alarmIndex, alarm] of configuration.alarms.entries()) {
      const signal = configuration.signals[alarmIndex]
      if (signal === undefined || signal.name !== alarm.name) {
        return failInvalid()
      }
      const maximumPollAttempts = Math.ceil(
        configuration.maximumWaitMilliseconds /
          alarmHistoryPollIntervalMilliseconds,
      ) + 1
      let transition: WorkspaceSearchMigrationRehearsalAlarmTransition |
        undefined
      for (let pollAttempt = 0; pollAttempt < maximumPollAttempts; pollAttempt += 1) {
        const rawItems:
          WorkspaceSearchMigrationRehearsalRawAlarmHistoryItem[] = []
        const seenTokens = new Set<string>()
        let nextToken: string | undefined
        let completedPagination = false

        for (
          let pageIndex = 0;
          pageIndex < configuration.maximumPagesPerAlarm;
          pageIndex += 1
        ) {
          const remainingMilliseconds = deadlineMilliseconds - dependencies.now()
          if (remainingMilliseconds <= 0) return failTimeout()
          const page = await runBoundedQueueOperation(
            (abortSignal) => port.readPage({
              abortSignal,
              alarmArn: alarm.alarmArn,
              alarmName: alarm.alarmName,
              endDate: new Date(configuration.completedAt),
              nextToken,
              expectedAccountId: configuration.expectedAccountId,
              expectedRegion: configuration.expectedRegion,
              startDate: new Date(configuration.startedAt),
            }),
            Math.min(
              configuration.requestTimeoutMilliseconds,
              remainingMilliseconds,
            ),
          )
          const parsedPage = readAlarmHistoryPage(page)
          rawItems.push(...parsedPage.items)
          if (rawItems.length > 2) return failInvalid()
          nextToken = parsedPage.nextToken
          if (nextToken === undefined) {
            completedPagination = true
            break
          }
          if (seenTokens.has(nextToken)) return failInvalid()
          seenTokens.add(nextToken)
        }
        if (!completedPagination || nextToken !== undefined) {
          return failInvalid()
        }
        if (rawItems.length === 2) {
          transition = readAlarmTransitionFromHistory(
            rawItems,
            alarm,
            signal,
            configuration.startedAt,
            configuration.completedAt,
          )
          break
        }
        const remainingMilliseconds = deadlineMilliseconds - dependencies.now()
        if (remainingMilliseconds <= 0 || pollAttempt + 1 >= maximumPollAttempts) {
          return failTimeout()
        }
        await dependencies.sleep(Math.min(
          alarmHistoryPollIntervalMilliseconds,
          remainingMilliseconds,
        ))
      }
      if (transition === undefined) return failTimeout()
      transitions.push(transition)
    }
    return createTransitionArtifact(
      configuration.startedAt,
      configuration.completedAt,
      transitions,
    )
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    throw new WorkspaceSearchMigrationRehearsalAlarmEvidenceError(
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_UPSTREAM_FAILURE',
    )
  }
}

/**
 * Finalizes six strict alarm records and one immutable combined artifact.
 *
 * @param input Complete collector-authenticated receipt and history artifacts.
 * @returns Evidence and exact canonical combined artifact publication binding.
 */
export function finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence(
  input: FinalizeWorkspaceSearchMigrationRehearsalAlarmEvidenceInput,
): WorkspaceSearchMigrationRehearsalFinalizedAlarmEvidence {
  try {
    const record = alarmGuards.requireRecord(input)
    alarmGuards.requireExactKeys(record, [
      'authorization',
      'ingestionArtifact',
      'publicationSigningKey',
      'receiptArtifact',
      'signalArtifact',
      'signalVerificationKey',
      'transitionArtifact',
    ])
    const authorization = readAlarmAuthorization(
      alarmGuards.readOwn(record, 'authorization'),
    )
    const signalVerificationKey = alarmGuards.readOwn(
      record,
      'signalVerificationKey',
    )
    const publicationSigningKey = alarmGuards.readOwn(
      record,
      'publicationSigningKey',
    )
    if (
      !(signalVerificationKey instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(signalVerificationKey) ||
      signalVerificationKey.byteLength !== 32 ||
      !(publicationSigningKey instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(publicationSigningKey) ||
      publicationSigningKey.byteLength !== 32 ||
      timingSafeEqual(signalVerificationKey, publicationSigningKey)
    ) {
      return failInvalid()
    }
    const artifact =
      verifyWorkspaceSearchMigrationRehearsalAlarmReceiptCollection(
        alarmGuards.readOwn(record, 'receiptArtifact'),
        authorization.requestedResourcesBinding,
        signalVerificationKey,
      )
    const signalArtifact =
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        alarmGuards.readOwn(record, 'signalArtifact'),
        signalVerificationKey,
      )
    const ingestionCandidate =
      verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
        alarmGuards.readOwn(record, 'ingestionArtifact'),
        signalVerificationKey,
      )
    const ingestionArtifact =
      verifyWorkspaceSearchMigrationRehearsalAlarmIngestionBinding({
        ingestionArtifact: ingestionCandidate,
        signalArtifact,
        verificationKey: signalVerificationKey,
        targetDigest: ingestionCandidate.targetDigest,
      })
    const transitionArtifact = readTransitionArtifact(
      alarmGuards.readOwn(record, 'transitionArtifact'),
    )
    if (
      transitionArtifact.startedAt !== artifact.startedAt ||
      transitionArtifact.completedAt < artifact.completedAt ||
      signalArtifact.authorizationBindingDigest !==
        authorization.requestedResourcesBinding
    ) {
      return failInvalid()
    }
    requireSignalAndTransitionArtifactsBound(
      signalArtifact,
      ingestionArtifact,
      transitionArtifact,
      signalVerificationKey,
    )
    const evidence: readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[] =
      transitionArtifact.transitions.map(
      (transition, alarmIndex) => {
      const primary = artifact.receipts[alarmIndex * 2]
      const secondary = artifact.receipts[(alarmIndex * 2) + 1]
      if (
        primary === undefined ||
        secondary === undefined ||
        primary.name !== transition.name ||
        primary.alarmIdentityDigest !== transition.alarmIdentityDigest ||
        primary.route !== 'primary' ||
        secondary.name !== transition.name ||
        secondary.alarmIdentityDigest !== transition.alarmIdentityDigest ||
        secondary.route !== 'secondary' ||
        primary.alarmObservedAt !== transition.alarmObservedAt ||
        secondary.alarmObservedAt !== transition.alarmObservedAt ||
        Date.parse(transition.alarmObservedAt) <
          Date.parse(artifact.startedAt) ||
        Date.parse(primary.receivedAt) < Date.parse(transition.alarmObservedAt) ||
        Date.parse(secondary.receivedAt) < Date.parse(transition.alarmObservedAt) ||
        Date.parse(primary.receivedAt) >= Date.parse(transition.recoveredAt) ||
        Date.parse(secondary.receivedAt) >= Date.parse(transition.recoveredAt)
      ) {
        return failInvalid()
      }
      return {
        name: transition.name,
        status: 'pass',
        initialState: 'OK',
        alarmState: 'ALARM',
        recoveredState: 'OK',
        alarmObservedAt: transition.alarmObservedAt,
        recoveredAt: transition.recoveredAt,
        signalDigest: transition.signalDigest,
        historyDigest: transition.historyDigest,
        primaryReceiptDigest: primary.receiptDigest,
        primaryReceivedAt: primary.receivedAt,
        secondaryReceiptDigest: secondary.receiptDigest,
        secondaryReceivedAt: secondary.receivedAt,
      }
    })
    const deliveryArtifact = createAlarmDeliveryArtifact(
      authorization,
      artifact,
      signalArtifact,
      ingestionArtifact,
      transitionArtifact,
      publicationSigningKey,
    )
    const canonicalArtifactBytes =
      serializeWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
        deliveryArtifact,
        signalVerificationKey,
        publicationSigningKey,
      )
    return {
      evidence,
      authorization,
      canonicalArtifactBytes,
      artifactDigest: createHash('sha256')
        .update(canonicalArtifactBytes)
        .digest('hex'),
      artifactByteLength: canonicalArtifactBytes.byteLength,
      receiptCount: 12,
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    return failInvalid()
  }
}

/**
 * Strictly verifies and detaches one digest-only alarm receipt artifact.
 *
 * @param value Candidate artifact crossing a process or storage boundary.
 * @returns Complete canonical artifact after digest and uniqueness checks.
 */
export function verifyWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact {
  try {
    return readReceiptArtifact(value)
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    return failInvalid()
  }
}

/**
 * Creates one strictly validated plan-authenticated receipt artifact.
 *
 * @param input Exact binding, time window, and twelve canonical receipts.
 * @param signingKey Restricted alarm runtime signing key.
 * @returns Detached artifact with an ordinary digest and plan-bound HMAC.
 */
export function createWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact(
  input: CreateWorkspaceSearchMigrationRehearsalAlarmReceiptArtifactInput,
  signingKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact {
  try {
    const record = alarmGuards.requireRecord(input)
    alarmGuards.requireExactKeys(record, [
      'collectionBindingDigest',
      'completedAt',
      'receipts',
      'startedAt',
    ])
    const claims = {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_KIND,
      version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_VERSION,
      collectionBindingDigest: alarmGuards.readDigest(
        alarmGuards.readOwn(record, 'collectionBindingDigest'),
      ),
      startedAt: readTimestamp(alarmGuards.readOwn(record, 'startedAt')),
      completedAt: readTimestamp(
        alarmGuards.readOwn(record, 'completedAt'),
      ),
      receipts: alarmGuards.readOwn(record, 'receipts'),
    }
    const artifactDigest = createMigrationDigest(claims)
    const authenticatedClaims = { ...claims, artifactDigest }
    return readReceiptArtifact({
      ...authenticatedClaims,
      collectionAuthentication: createReceiptCollectionAuthentication(
        authenticatedClaims,
        signingKey,
      ),
    })
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    return failInvalid()
  }
}

/**
 * Authenticates one receipt artifact against its exact permitted plan.
 *
 * @param value Candidate receipt artifact crossing a process boundary.
 * @param expectedCollectionBindingDigest Permit-authenticated plan digest.
 * @param verificationKey Restricted alarm runtime verification key.
 * @returns Detached receipt artifact after structural, digest, and HMAC checks.
 */
export function verifyWorkspaceSearchMigrationRehearsalAlarmReceiptCollection(
  value: unknown,
  expectedCollectionBindingDigest: string,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact {
  try {
    const artifact = readReceiptArtifact(value)
    const expectedBinding = alarmGuards.readDigest(
      expectedCollectionBindingDigest,
    )
    if (
      artifact.collectionBindingDigest !== expectedBinding ||
      !(verificationKey instanceof Uint8Array) ||
      nodeUtilTypes.isProxy(verificationKey) ||
      verificationKey.byteLength !== 32
    ) {
      return failInvalid()
    }
    const expectedAuthentication = createReceiptCollectionAuthentication(
      {
        kind: artifact.kind,
        version: artifact.version,
        collectionBindingDigest: artifact.collectionBindingDigest,
        startedAt: artifact.startedAt,
        completedAt: artifact.completedAt,
        receipts: artifact.receipts,
        artifactDigest: artifact.artifactDigest,
      },
      verificationKey,
    )
    if (!equalAlarmAuthentication(
      artifact.collectionAuthentication,
      expectedAuthentication,
    )) {
      return failInvalid()
    }
    return artifact
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    return failInvalid()
  }
}

/**
 * Compares two already normalized authentication digests in constant time.
 *
 * @param actual Authentication supplied by the candidate artifact.
 * @param expected Authentication recomputed from trusted inputs.
 * @returns Whether both fixed-length lowercase digests are identical.
 */
function equalAlarmAuthentication(actual: string, expected: string): boolean {
  const encoder = new TextEncoder()
  return timingSafeEqual(encoder.encode(actual), encoder.encode(expected))
}

/**
 * Strictly verifies one collector-authenticated alarm transition artifact.
 *
 * @param value Candidate artifact crossing a process or storage boundary.
 * @returns Complete canonical history artifact after digest checks.
 */
export function verifyWorkspaceSearchMigrationRehearsalAlarmTransitionArtifact(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact {
  try {
    return readTransitionArtifact(value)
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    return failInvalid()
  }
}

/**
 * Serializes one verified digest-only receipt artifact as canonical UTF-8 bytes.
 *
 * @param value Candidate complete receipt artifact.
 * @returns Exact bounded bytes suitable for immutable publication.
 */
export function serializeWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact(
  value: unknown,
): Uint8Array {
  const artifact = verifyWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact(
    value,
  )
  const bytes = new TextEncoder().encode(serializeCanonicalJson(artifact))
  if (bytes.byteLength === 0 || bytes.byteLength > maximumReceiptArtifactBytes) {
    return failInvalid()
  }
  return bytes
}

/**
 * Strictly verifies a combined immutable alarm-delivery artifact.
 *
 * @param value Candidate complete artifact crossing a process boundary.
 * @param signalVerificationKey Restricted exact signal HMAC key.
 * @param publicationVerificationKey Distinct parent publication HMAC key.
 * @returns Detached receipt and transition artifacts after all digest checks.
 */
export function verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
  value: unknown,
  signalVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact {
  try {
    if (
      signalVerificationKey.byteLength !== 32 ||
      publicationVerificationKey.byteLength !== 32 ||
      timingSafeEqual(signalVerificationKey, publicationVerificationKey)
    ) {
      return failInvalid()
    }
    return readAlarmDeliveryArtifact(
      value,
      signalVerificationKey,
      publicationVerificationKey,
    )
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    return failInvalid()
  }
}

/**
 * Serializes one verified complete alarm-delivery artifact as canonical bytes.
 *
 * @param value Candidate complete alarm-delivery artifact.
 * @param signalVerificationKey Restricted exact signal HMAC key.
 * @param publicationVerificationKey Distinct parent publication HMAC key.
 * @returns Exact bounded bytes suitable for immutable publication.
 */
export function serializeWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
  value: unknown,
  signalVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): Uint8Array {
  const artifact = verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
    value,
    signalVerificationKey,
    publicationVerificationKey,
  )
  const bytes = new TextEncoder().encode(serializeCanonicalJson(artifact))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumAlarmDeliveryArtifactBytes
  ) {
    return failInvalid()
  }
  return bytes
}

/** Reads and validates the complete CloudWatch history collector configuration. */
function readHistoryCollectorConfiguration(
  input: CollectWorkspaceSearchMigrationRehearsalAlarmHistoryInput,
): AlarmHistoryCollectorConfiguration {
  const record = alarmGuards.requireRecord(input)
  alarmGuards.requireExactKeys(record, [
    'alarmArns',
    'completedAt',
    'expectedAccountId',
    'expectedRegion',
    'maximumPagesPerAlarm',
    'maximumWaitMilliseconds',
    'requestTimeoutMilliseconds',
    'signals',
    'startedAt',
  ])
  const expectedAccountId = readExpectedAccountId(
    alarmGuards.readOwn(record, 'expectedAccountId'),
  )
  const expectedRegion = readExpectedRegion(
    alarmGuards.readOwn(record, 'expectedRegion'),
  )
  const startedAt = readTimestamp(alarmGuards.readOwn(record, 'startedAt'))
  const completedAt = readTimestamp(
    alarmGuards.readOwn(record, 'completedAt'),
  )
  if (Date.parse(startedAt) >= Date.parse(completedAt)) return failInvalid()
  const maximumWaitMilliseconds = readIntegerInRange(
    alarmGuards.readOwn(record, 'maximumWaitMilliseconds'),
    minimumCollectionWaitMilliseconds,
    maximumCollectionWaitMilliseconds,
  )
  const requestTimeoutMilliseconds = readIntegerInRange(
    alarmGuards.readOwn(record, 'requestTimeoutMilliseconds'),
    minimumRequestTimeoutMilliseconds,
    maximumRequestTimeoutMilliseconds,
  )
  if (requestTimeoutMilliseconds > maximumWaitMilliseconds) {
    return failInvalid()
  }
  const maximumPagesPerAlarm = readIntegerInRange(
    alarmGuards.readOwn(record, 'maximumPagesPerAlarm'),
    1,
    maximumAlarmHistoryPagesPerAlarm,
  )
  const alarms = readAlarmExpectationsForEnvironment(
    alarmGuards.readOwn(record, 'alarmArns'),
    expectedAccountId,
    expectedRegion,
  )
  const signals = readSignalBindings(alarmGuards.readOwn(record, 'signals'))
  for (const [index, signal] of signals.entries()) {
    const previous = signals[index - 1]
    if (
      Date.parse(signal.observedAt) < Date.parse(startedAt) ||
      Date.parse(signal.observedAt) >= Date.parse(completedAt) ||
      (previous !== undefined &&
        index !== 2 &&
        Date.parse(signal.observedAt) <= Date.parse(previous.observedAt))
    ) {
      return failInvalid()
    }
  }
  return {
    alarms,
    completedAt,
    expectedAccountId,
    expectedRegion,
    maximumPagesPerAlarm,
    maximumWaitMilliseconds,
    requestTimeoutMilliseconds,
    signals,
    startedAt,
  }
}

/** Reads six alarm ARNs bound to the explicit session account and region. */
function readAlarmExpectationsForEnvironment(
  value: unknown,
  expectedAccountId: string,
  expectedRegion: string,
): readonly AlarmExpectation[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length
  ) {
    return failInvalid()
  }
  const firstIdentity = parseAlarmArn(value[0])
  if (
    firstIdentity.accountId !== expectedAccountId ||
    firstIdentity.region !== expectedRegion
  ) {
    return failInvalid()
  }
  return readAlarmExpectations(value, firstIdentity)
}

/** Reads six authenticated positive signal bindings in canonical alarm order. */
function readSignalBindings(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalAlarmSignalBinding[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length
  ) {
    return failInvalid()
  }
  const entries: readonly unknown[] = value
  const bindings = entries.map((entry, index):
    WorkspaceSearchMigrationRehearsalAlarmSignalBinding => {
    const record = alarmGuards.requireRecord(entry)
    alarmGuards.requireExactKeys(record, [
      'metricName',
      'name',
      'observedAt',
      'signalDigest',
      'value',
    ])
    const name = readAlarmName(alarmGuards.readOwn(record, 'name'))
    const signalDigest = alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'signalDigest'),
    )
    const observedAt = readTimestamp(
      alarmGuards.readOwn(record, 'observedAt'),
    )
    const metricName = readSignalMetricName(
      alarmGuards.readOwn(record, 'metricName'),
    )
    if (
      name !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[index] ||
      metricName !== expectedSignalMetricName(name) ||
      alarmGuards.readOwn(record, 'value') !== 1
    ) {
      return failInvalid()
    }
    return { name, signalDigest, observedAt, metricName, value: 1 }
  })
  const digests = new Set<string>()
  for (const [index, binding] of bindings.entries()) {
    const isBudgetPair = index === 2 &&
      binding.signalDigest === bindings[1]?.signalDigest &&
      binding.observedAt === bindings[1]?.observedAt
    if (digests.has(binding.signalDigest) && !isBudgetPair) {
      return failInvalid()
    }
    digests.add(binding.signalDigest)
  }
  return bindings
}

/** Reads one strict projected CloudWatch history page. */
function readAlarmHistoryPage(
  value: unknown,
): {
  /** Detached untrusted projected history items. */
  readonly items:
    readonly WorkspaceSearchMigrationRehearsalRawAlarmHistoryItem[]
  /** Validated opaque pagination token. */
  readonly nextToken: string | undefined
} {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, ['items', 'nextToken'])
  const itemsValue = alarmGuards.readOwn(record, 'items')
  if (
    !Array.isArray(itemsValue) ||
    nodeUtilTypes.isProxy(itemsValue) ||
    itemsValue.length > maximumAlarmHistoryPageSize
  ) {
    return failInvalid()
  }
  const entries: readonly unknown[] = itemsValue
  const items = entries.map((entry) => {
    const item = alarmGuards.requireRecord(entry)
    alarmGuards.requireExactKeys(item, [
      'alarmName',
      'alarmType',
      'historyData',
      'historyItemType',
      'timestamp',
    ])
    return {
      alarmName: alarmGuards.readOwn(item, 'alarmName'),
      alarmType: alarmGuards.readOwn(item, 'alarmType'),
      historyData: alarmGuards.readOwn(item, 'historyData'),
      historyItemType: alarmGuards.readOwn(item, 'historyItemType'),
      timestamp: alarmGuards.readOwn(item, 'timestamp'),
    }
  })
  const nextTokenValue = alarmGuards.readOwn(record, 'nextToken')
  const nextToken = nextTokenValue === undefined
    ? undefined
    : readBoundedText(nextTokenValue, 4_096)
  return { items, nextToken }
}

/** Creates one strict transition from exactly two CloudWatch state updates. */
function readAlarmTransitionFromHistory(
  value: unknown,
  alarm: AlarmExpectation,
  signal: WorkspaceSearchMigrationRehearsalAlarmSignalBinding,
  startedAt: string,
  completedAt: string,
): WorkspaceSearchMigrationRehearsalAlarmTransition {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== 2
  ) {
    return failInvalid()
  }
  const entries: readonly unknown[] = value
  const alarmUpdate = readAlarmHistoryStateUpdate(entries[0], alarm)
  const recoveryUpdate = readAlarmHistoryStateUpdate(entries[1], alarm)
  if (
    alarmUpdate.oldState !== 'OK' ||
    alarmUpdate.newState !== 'ALARM' ||
    recoveryUpdate.oldState !== 'ALARM' ||
    recoveryUpdate.newState !== 'OK' ||
    signal.name !== alarm.name ||
    Date.parse(signal.observedAt) > Date.parse(alarmUpdate.observedAt) ||
    Date.parse(alarmUpdate.observedAt) < Date.parse(startedAt) ||
    Date.parse(recoveryUpdate.observedAt) > Date.parse(completedAt) ||
    Date.parse(alarmUpdate.observedAt) >=
      Date.parse(recoveryUpdate.observedAt)
  ) {
    return failInvalid()
  }
  const alarmIdentityDigest = createAlarmIdentityDigest(alarm.alarmArn)
  requireExpectedMetricEvaluation(alarmUpdate.evaluation, 'ALARM')
  requireExpectedMetricEvaluation(recoveryUpdate.evaluation, 'OK')
  requireSignalInsideAlarmEvaluation(signal, alarmUpdate.evaluation)
  const metricEvaluationDigest = createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-alarm-metric-evaluation',
    version: 1,
    name: alarm.name,
    alarmIdentityDigest,
    signalDigest: signal.signalDigest,
    signalObservedAt: signal.observedAt,
    signalMetricName: signal.metricName,
    signalValue: signal.value,
    alarmEvaluation: alarmUpdate.evaluation,
    recoveryEvaluation: recoveryUpdate.evaluation,
  })
  const normalizedHistory = {
    kind: 'workspace-search-migration-rehearsal-alarm-history-transition',
    version: 1,
    name: alarm.name,
    alarmIdentityDigest,
    signalDigest: signal.signalDigest,
    signalObservedAt: signal.observedAt,
    signalMetricName: signal.metricName,
    metricEvaluationDigest,
    updates: [{
      oldState: alarmUpdate.oldState,
      newState: alarmUpdate.newState,
      observedAt: alarmUpdate.observedAt,
    }, {
      oldState: recoveryUpdate.oldState,
      newState: recoveryUpdate.newState,
      observedAt: recoveryUpdate.observedAt,
    }],
  }
  return {
    name: alarm.name,
    alarmIdentityDigest,
    initialState: 'OK',
    alarmState: 'ALARM',
    recoveredState: 'OK',
    alarmObservedAt: alarmUpdate.observedAt,
    recoveredAt: recoveryUpdate.observedAt,
    signalDigest: signal.signalDigest,
    signalObservedAt: signal.observedAt,
    signalMetricName: signal.metricName,
    metricEvaluationDigest,
    historyDigest: createMigrationDigest(normalizedHistory),
  }
}

/** Reads one exact metric-alarm state update from CloudWatch history. */
function readAlarmHistoryStateUpdate(
  value: unknown,
  alarm: AlarmExpectation,
): ParsedAlarmHistoryStateUpdate {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'alarmName',
    'alarmType',
    'historyData',
    'historyItemType',
    'timestamp',
  ])
  if (
    alarmGuards.readOwn(record, 'alarmName') !== alarm.alarmName ||
    alarmGuards.readOwn(record, 'alarmType') !== 'MetricAlarm' ||
    alarmGuards.readOwn(record, 'historyItemType') !== 'StateUpdate'
  ) {
    return failInvalid()
  }
  const historyDataText = readBoundedText(
    alarmGuards.readOwn(record, 'historyData'),
    maximumRawBodyBytes,
  )
  let historyDataValue: unknown
  try {
    historyDataValue = JSON.parse(historyDataText)
  } catch {
    return failInvalid()
  }
  const historyData = alarmGuards.requireRecord(historyDataValue)
  alarmGuards.requireExactKeys(historyData, [
    'newState',
    'oldState',
    'version',
  ])
  if (alarmGuards.readOwn(historyData, 'version') !== '1.0') {
    return failInvalid()
  }
  const oldState = readAlarmHistoryStateValue(
    alarmGuards.readOwn(historyData, 'oldState'),
  )
  const newStateRecord = alarmGuards.requireRecord(
    alarmGuards.readOwn(historyData, 'newState'),
  )
  alarmGuards.requireExactKeys(newStateRecord, [
    'stateReason',
    'stateReasonData',
    'stateValue',
  ])
  const newState = readAlarmHistoryStateValue(newStateRecord)
  readBoundedText(alarmGuards.readOwn(newStateRecord, 'stateReason'), 2_048)
  const timestamp = alarmGuards.readOwn(record, 'timestamp')
  if (!nodeUtilTypes.isDate(timestamp) || nodeUtilTypes.isProxy(timestamp)) {
    return failInvalid()
  }
  const timestampMilliseconds = Date.prototype.getTime.call(timestamp)
  if (!Number.isFinite(timestampMilliseconds)) return failInvalid()
  const observedAt = new Date(timestampMilliseconds).toISOString()
  const evaluation = readAlarmMetricEvaluation(
    alarmGuards.readOwn(newStateRecord, 'stateReasonData'),
    observedAt,
  )
  return {
    oldState,
    newState,
    observedAt,
    evaluation,
  }
}

/** Reads one supported old or new alarm state from history data. */
function readAlarmHistoryStateValue(value: unknown): 'OK' | 'ALARM' {
  const record = alarmGuards.requireRecord(value)
  const stateValue = alarmGuards.readOwn(record, 'stateValue')
  if (stateValue === 'OK' || stateValue === 'ALARM') return stateValue
  return failInvalid()
}

/** Reads and sanitizes one exact single-metric stateReasonData document. */
function readAlarmMetricEvaluation(
  value: unknown,
  observedAt: string,
): ParsedAlarmMetricEvaluation {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'evaluatedDatapoints',
    'period',
    'queryDate',
    'recentDatapoints',
    'startDate',
    'statistic',
    'threshold',
    'version',
  ])
  if (
    alarmGuards.readOwn(record, 'version') !== '1.0' ||
    alarmGuards.readOwn(record, 'statistic') !== 'Sum' ||
    alarmGuards.readOwn(record, 'period') !== 300 ||
    alarmGuards.readOwn(record, 'threshold') !== 1
  ) {
    return failInvalid()
  }
  const queryDate = readAwsTimestamp(
    alarmGuards.readOwn(record, 'queryDate'),
  )
  const startDate = readAwsTimestamp(
    alarmGuards.readOwn(record, 'startDate'),
  )
  if (
    Date.parse(startDate) > Date.parse(queryDate) ||
    Math.abs(Date.parse(queryDate) - Date.parse(observedAt)) >
      serviceClockSkewMilliseconds
  ) {
    return failInvalid()
  }
  const recentDatapoints = readFiniteMetricValues(
    alarmGuards.readOwn(record, 'recentDatapoints'),
  )
  const evaluatedDatapoints = readEvaluatedMetricDatapoints(
    alarmGuards.readOwn(record, 'evaluatedDatapoints'),
    startDate,
    queryDate,
  )
  return {
    queryDate,
    startDate,
    statistic: 'Sum',
    period: 300,
    recentDatapoints,
    threshold: 1,
    evaluatedDatapoints,
  }
}

/** Reads a finite vector of recent CloudWatch metric values. */
function readFiniteMetricValues(value: unknown): readonly number[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > 10
  ) {
    return failInvalid()
  }
  const entries: readonly unknown[] = value
  return entries.map((entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return failInvalid()
    }
    return entry
  })
}

/** Reads structured metric datapoints and binds them to the evaluation window. */
function readEvaluatedMetricDatapoints(
  value: unknown,
  startDate: string,
  queryDate: string,
): readonly ParsedAlarmEvaluatedDatapoint[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > 10
  ) {
    return failInvalid()
  }
  const entries: readonly unknown[] = value
  const timestamps = new Set<string>()
  return entries.map((entry) => {
    const record = alarmGuards.requireRecord(entry)
    alarmGuards.requireExactKeys(record, [
      'sampleCount',
      'timestamp',
      'value',
    ])
    const timestamp = readAwsTimestamp(
      alarmGuards.readOwn(record, 'timestamp'),
    )
    const sampleCount = alarmGuards.readOwn(record, 'sampleCount')
    const metricValue = alarmGuards.readOwn(record, 'value')
    if (
      typeof sampleCount !== 'number' ||
      !Number.isFinite(sampleCount) ||
      sampleCount <= 0 ||
      typeof metricValue !== 'number' ||
      !Number.isFinite(metricValue) ||
      Date.parse(timestamp) < Date.parse(startDate) ||
      Date.parse(timestamp) > Date.parse(queryDate) ||
      timestamps.has(timestamp)
    ) {
      return failInvalid()
    }
    timestamps.add(timestamp)
    return { timestamp, sampleCount, value: metricValue }
  })
}

/** Requires sanitized datapoints to agree with the fixed threshold transition. */
function requireExpectedMetricEvaluation(
  evaluation: ParsedAlarmMetricEvaluation,
  resultingState: 'ALARM' | 'OK',
): void {
  const evaluatedValues = evaluation.evaluatedDatapoints.map(
    ({ value }) => value,
  )
  if (resultingState === 'ALARM') {
    if (
      evaluation.recentDatapoints.length === 0 ||
      evaluatedValues.length === 0 ||
      !evaluatedValues.some((value) => value >= evaluation.threshold)
    ) {
      return failInvalid()
    }
    return
  }
  if (evaluatedValues.some((value) => value >= evaluation.threshold)) {
    return failInvalid()
  }
}

/** Requires the authenticated signal timestamp inside a positive datapoint. */
function requireSignalInsideAlarmEvaluation(
  signal: WorkspaceSearchMigrationRehearsalAlarmSignalBinding,
  evaluation: ParsedAlarmMetricEvaluation,
): void {
  const signalMilliseconds = Date.parse(signal.observedAt)
  if (
    signal.value !== 1 ||
    signal.metricName !== expectedSignalMetricName(signal.name) ||
    signalMilliseconds < Date.parse(evaluation.startDate) ||
    signalMilliseconds > Date.parse(evaluation.queryDate) ||
    !evaluation.evaluatedDatapoints.some((datapoint) => {
      const datapointMilliseconds = Date.parse(datapoint.timestamp)
      return datapoint.value >= evaluation.threshold &&
        signalMilliseconds >= datapointMilliseconds &&
        signalMilliseconds < datapointMilliseconds +
          (evaluation.period * 1_000)
    })
  ) {
    return failInvalid()
  }
}

/** Creates one authenticated transition artifact after all six histories exist. */
function createTransitionArtifact(
  startedAt: string,
  completedAt: string,
  transitions: readonly WorkspaceSearchMigrationRehearsalAlarmTransition[],
): WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact {
  const claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact,
    'artifactDigest'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_VERSION,
    startedAt,
    completedAt,
    transitions,
  }
  return { ...claims, artifactDigest: createMigrationDigest(claims) }
}

/** Reads and validates the complete collector configuration. */
function readCollectorConfiguration(
  input: CollectWorkspaceSearchMigrationRehearsalAlarmEvidenceInput,
): {
  /** Six expected alarms. */
  readonly alarms: readonly AlarmExpectation[]
  /** Canonical finite transitions authorized for stale dual-route cleanup. */
  readonly authorizedStaleTransitions:
    readonly WorkspaceSearchMigrationRehearsalAuthorizedStaleTransition[]
  /** Permit-authenticated exact collection-plan digest. */
  readonly collectionBindingDigest: string
  /** Restricted key authenticating the completed collection. */
  readonly collectionSigningKey: Uint8Array
  /** Maximum total wait. */
  readonly maximumWaitMilliseconds: number
  /** Request timeout. */
  readonly requestTimeoutMilliseconds: number
  /** Primary route. */
  readonly primary: RouteExpectation
  /** Secondary route. */
  readonly secondary: RouteExpectation
  /** Canonical rehearsal start. */
  readonly startedAt: string
} {
  const record = alarmGuards.requireRecord(input)
  alarmGuards.requireExactKeys(record, [
    'alarmArns',
    'authorizedStaleTransitions',
    'collectionBindingDigest',
    'collectionSigningKey',
    'expectedAccountId',
    'expectedRegion',
    'maximumWaitMilliseconds',
    'primary',
    'requestTimeoutMilliseconds',
    'secondary',
    'startedAt',
  ])
  const expectedAccountId = readExpectedAccountId(
    alarmGuards.readOwn(record, 'expectedAccountId'),
  )
  const expectedRegion = readExpectedRegion(
    alarmGuards.readOwn(record, 'expectedRegion'),
  )
  const collectionBindingDigest = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'collectionBindingDigest'),
  )
  const collectionSigningKey = alarmGuards.readOwn(
    record,
    'collectionSigningKey',
  )
  if (
    !(collectionSigningKey instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(collectionSigningKey) ||
    collectionSigningKey.byteLength !== 32
  ) {
    return failInvalid()
  }
  const primaryInput = readRouteInput(
    alarmGuards.readOwn(record, 'primary'),
  )
  const secondaryInput = readRouteInput(
    alarmGuards.readOwn(record, 'secondary'),
  )
  const startedAt = readTimestamp(
    alarmGuards.readOwn(record, 'startedAt'),
  )
  const authorizedStaleTransitions =
    verifyWorkspaceSearchMigrationRehearsalAuthorizedStaleTransitions(
      alarmGuards.readOwn(record, 'authorizedStaleTransitions'),
      startedAt,
    )
  const maximumWaitMilliseconds = readIntegerInRange(
    alarmGuards.readOwn(record, 'maximumWaitMilliseconds'),
    minimumCollectionWaitMilliseconds,
    maximumCollectionWaitMilliseconds,
  )
  const requestTimeoutMilliseconds = readIntegerInRange(
    alarmGuards.readOwn(record, 'requestTimeoutMilliseconds'),
    minimumRequestTimeoutMilliseconds,
    maximumRequestTimeoutMilliseconds,
  )
  if (requestTimeoutMilliseconds > maximumWaitMilliseconds) {
    return failInvalid()
  }
  const primaryIdentity = parseTopicArn(primaryInput.topicArn)
  const secondaryIdentity = parseTopicArn(secondaryInput.topicArn)
  if (
    primaryInput.topicArn === secondaryInput.topicArn ||
    primaryIdentity.accountId !== expectedAccountId ||
    primaryIdentity.region !== expectedRegion ||
    primaryIdentity.partition !== secondaryIdentity.partition ||
    primaryIdentity.region !== secondaryIdentity.region ||
    primaryIdentity.accountId !== secondaryIdentity.accountId
  ) {
    return failInvalid()
  }
  const primary: RouteExpectation = {
    route: 'primary',
    queueUrl: readQueueUrl(
      primaryInput.queueUrl,
      primaryIdentity.partition,
      primaryIdentity.region,
      primaryIdentity.accountId,
    ),
    topicArn: primaryInput.topicArn,
  }
  const secondary: RouteExpectation = {
    route: 'secondary',
    queueUrl: readQueueUrl(
      secondaryInput.queueUrl,
      secondaryIdentity.partition,
      secondaryIdentity.region,
      secondaryIdentity.accountId,
    ),
    topicArn: secondaryInput.topicArn,
  }
  if (primary.queueUrl === secondary.queueUrl) return failInvalid()
  const alarms = readAlarmExpectations(
    alarmGuards.readOwn(record, 'alarmArns'),
    primaryIdentity,
  )
  return {
    alarms,
    authorizedStaleTransitions,
    collectionBindingDigest,
    collectionSigningKey,
    maximumWaitMilliseconds,
    requestTimeoutMilliseconds,
    primary,
    secondary,
    startedAt,
  }
}

/**
 * Verifies a finite canonical allowlist of prior alarm transitions.
 *
 * Each alarm may appear at most once and entries must retain the repository's
 * canonical alarm order. Only transitions inside the preceding SQS retention
 * interval are admitted.
 *
 * @param value Candidate detached transition allowlist.
 * @param startedAt Canonical start of the new collection window.
 * @returns Detached canonical stale-transition allowlist.
 */
export function verifyWorkspaceSearchMigrationRehearsalAuthorizedStaleTransitions(
  value: unknown,
  startedAt: string,
): readonly WorkspaceSearchMigrationRehearsalAuthorizedStaleTransition[] {
  try {
    const canonicalStartedAt = readTimestamp(startedAt)
    if (
      !Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      value.length > maximumAuthorizedStaleTransitions
    ) {
      return failInvalid()
    }
    const entries: readonly unknown[] = value
    let previousAlarmIndex = -1
    return Object.freeze(entries.map((entry) => {
      const record = alarmGuards.requireRecord(entry)
      alarmGuards.requireExactKeys(record, ['alarmObservedAt', 'name'])
      const name = readAlarmName(alarmGuards.readOwn(record, 'name'))
      const alarmObservedAt = readTimestamp(
        alarmGuards.readOwn(record, 'alarmObservedAt'),
      )
      const alarmIndex = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS
        .indexOf(name)
      const ageMilliseconds = Date.parse(canonicalStartedAt) -
        Date.parse(alarmObservedAt)
      if (
        alarmIndex <= previousAlarmIndex ||
        ageMilliseconds <= 0 ||
        ageMilliseconds > maximumAuthorizedStaleTransitionAgeMilliseconds
      ) {
        return failInvalid()
      }
      previousAlarmIndex = alarmIndex
      return Object.freeze({ name, alarmObservedAt })
    }))
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    return failInvalid()
  }
}

/** Reads the exact authenticated non-production account identifier. */
function readExpectedAccountId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{12}$/.test(value)) {
    return failInvalid()
  }
  return value
}

/** Reads the exact authenticated non-production AWS region. */
function readExpectedRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/.test(value)
  ) {
    return failInvalid()
  }
  return value
}

/** Reads one exact route input without invoking accessors. */
function readRouteInput(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmRouteInput {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, ['queueUrl', 'topicArn'])
  const queueUrl = alarmGuards.readOwn(record, 'queueUrl')
  const topicArn = alarmGuards.readOwn(record, 'topicArn')
  if (typeof queueUrl !== 'string' || typeof topicArn !== 'string') {
    return failInvalid()
  }
  return { queueUrl, topicArn }
}

/** Reads six concrete alarm identities in canonical order. */
function readAlarmExpectations(
  alarmArns: unknown,
  environment: ArnIdentity,
): readonly AlarmExpectation[] {
  if (
    !Array.isArray(alarmArns) ||
    nodeUtilTypes.isProxy(alarmArns) ||
    alarmArns.length !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length
  ) {
    return failInvalid()
  }
  const candidates: readonly unknown[] = alarmArns
  const uniqueArns = new Set<string>()
  const uniqueNames = new Set<string>()
  return candidates.map((alarmArn, index) => {
    const name = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[index]
    if (name === undefined) return failInvalid()
    const identity = parseAlarmArn(alarmArn)
    if (typeof alarmArn !== 'string') return failInvalid()
    if (
      identity.partition !== environment.partition ||
      identity.region !== environment.region ||
      identity.accountId !== environment.accountId ||
      uniqueArns.has(alarmArn) ||
      uniqueNames.has(identity.resourceName)
    ) {
      return failInvalid()
    }
    uniqueArns.add(alarmArn)
    uniqueNames.add(identity.resourceName)
    return {
      name,
      alarmArn,
      alarmName: identity.resourceName,
    }
  })
}

/** Parses one exact same-environment SNS topic ARN. */
function parseTopicArn(value: unknown): ArnIdentity {
  const text = readBoundedText(value, 1_024)
  const match = /^arn:(aws|aws-cn|aws-us-gov):sns:([a-z0-9-]+):([0-9]{12}):([A-Za-z0-9_-]{1,256})$/
    .exec(text)
  if (match === null) return failInvalid()
  const partition = readPartition(match[1])
  const region = match[2]
  const accountId = match[3]
  const resourceName = match[4]
  if (
    region === undefined ||
    accountId === undefined ||
    resourceName === undefined
  ) {
    return failInvalid()
  }
  return { partition, region, accountId, resourceName }
}

/** Parses one exact same-environment CloudWatch alarm ARN. */
function parseAlarmArn(value: unknown): ArnIdentity {
  const text = readBoundedText(value, 2_048)
  const match = /^arn:(aws|aws-cn|aws-us-gov):cloudwatch:([a-z0-9-]+):([0-9]{12}):alarm:(.{1,255})$/u
    .exec(text)
  if (match === null) return failInvalid()
  const partition = readPartition(match[1])
  const region = match[2]
  const accountId = match[3]
  const resourceName = match[4]
  if (
    region === undefined ||
    accountId === undefined ||
    resourceName === undefined ||
    resourceName.trim() !== resourceName ||
    containsControlCharacter(resourceName)
  ) {
    return failInvalid()
  }
  return { partition, region, accountId, resourceName }
}

/** Reads one supported literal AWS partition. */
function readPartition(value: unknown): ArnIdentity['partition'] {
  if (value === 'aws' || value === 'aws-cn' || value === 'aws-us-gov') {
    return value
  }
  return failInvalid()
}

/** Reads an HTTPS queue URL bound to the expected account and region. */
function readQueueUrl(
  value: unknown,
  partition: ArnIdentity['partition'],
  region: string,
  accountId: string,
): string {
  const text = readBoundedText(value, 2_048)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return failInvalid()
  }
  const pathParts = url.pathname.split('/').filter((part) => part.length > 0)
  const expectedHostname = partition === 'aws-cn'
    ? `sqs.${region}.amazonaws.com.cn`
    : `sqs.${region}.amazonaws.com`
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname !== expectedHostname ||
    pathParts.length !== 2 ||
    pathParts[0] !== accountId ||
    pathParts[1]?.length === 0
  ) {
    return failInvalid()
  }
  return text
}

/** Validates one receive batch and retains opaque deletion capabilities. */
async function consumeMessages(
  value: unknown,
  route: RouteExpectation,
  configuration: ReturnType<typeof readCollectorConfiguration>,
  receipts: Map<
    string,
    WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt
  >,
  messageIdDigests: Set<string>,
  deletions: Map<string, PendingAlarmReceiptDeletion>,
  staleDeletionKeys: Set<string>,
  port: WorkspaceSearchMigrationRehearsalAlarmQueuePort,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCollectorDependencies,
  deadlineMilliseconds: number,
): Promise<void> {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > maximumReceiveBatchSize
  ) {
    return failInvalid()
  }
  const candidates: readonly unknown[] = value
  for (const candidate of candidates) {
    const raw = readRawQueueMessage(candidate)
    const notification = parseNotification(
      raw.body,
      route,
      configuration,
    )
    const receivedAt = readSentTimestamp(raw.sentTimestamp)
    const receivedAtMilliseconds = Date.parse(receivedAt)
    const publishedAtMilliseconds = Date.parse(notification.publishedAt)
    const stateChangeAtMilliseconds = Date.parse(notification.stateChangeAt)
    const observedNowMilliseconds = dependencies.now()
    if (
      !Number.isSafeInteger(observedNowMilliseconds) ||
      publishedAtMilliseconds + serviceClockSkewMilliseconds <
        stateChangeAtMilliseconds ||
      receivedAtMilliseconds + serviceClockSkewMilliseconds <
        publishedAtMilliseconds ||
      receivedAtMilliseconds > deadlineMilliseconds +
        serviceClockSkewMilliseconds ||
      receivedAtMilliseconds > observedNowMilliseconds +
        serviceClockSkewMilliseconds
    ) {
      return failInvalid()
    }
    const expectation = configuration.alarms.find(
      ({ alarmArn }) => alarmArn === notification.alarmArn,
    )
    if (expectation === undefined) return failInvalid()
    if (stateChangeAtMilliseconds < Date.parse(configuration.startedAt)) {
      const authorizedTransition =
        configuration.authorizedStaleTransitions.find(
          ({ name, alarmObservedAt }) =>
            name === expectation.name &&
            alarmObservedAt === notification.stateChangeAt,
        )
      const staleDeletionKey = `${expectation.name}:${route.route}`
      if (
        authorizedTransition === undefined ||
        staleDeletionKeys.has(staleDeletionKey) ||
        staleDeletionKeys.size >=
          configuration.authorizedStaleTransitions.length * 2
      ) {
        return failInvalid()
      }
      try {
        await runBoundedQueueOperation(
          (abortSignal) => port.delete({
            abortSignal,
            queueUrl: route.queueUrl,
            receiptHandle: raw.receiptHandle,
            route: route.route,
          }),
          configuration.requestTimeoutMilliseconds,
        )
      } catch {
        throw new WorkspaceSearchMigrationRehearsalAlarmEvidenceError(
          'MIGRATION_REHEARSAL_ALARM_EVIDENCE_UPSTREAM_FAILURE',
        )
      }
      staleDeletionKeys.add(staleDeletionKey)
      continue
    }
    const messageIdDigest = createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-alarm-message-id',
      version: 1,
      messageId: notification.messageId,
    })
    const alarmIdentityDigest = createAlarmIdentityDigest(
      notification.alarmArn,
    )
    const receiptDigest = createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-alarm-delivery-receipt',
      version: 1,
      name: expectation.name,
      route: route.route,
      alarmArnDigest: alarmIdentityDigest,
      topicArnDigest: createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-alarm-topic-arn',
        version: 1,
        topicArn: route.topicArn,
      }),
      messageIdDigest,
      publishedAt: notification.publishedAt,
      receivedAt,
      stateChangeAt: notification.stateChangeAt,
    })
    const receiptKey = `${expectation.name}:${route.route}`
    if (
      receipts.has(receiptKey) ||
      deletions.has(receiptKey) ||
      messageIdDigests.has(messageIdDigest) ||
      [...receipts.values()].some(
        (receipt) => receipt.receiptDigest === receiptDigest,
      )
    ) {
      return failInvalid()
    }
    messageIdDigests.add(messageIdDigest)
    receipts.set(receiptKey, {
      name: expectation.name,
      alarmIdentityDigest,
      route: route.route,
      receivedAt,
      alarmObservedAt: notification.stateChangeAt,
      messageIdDigest,
      receiptDigest,
    })
    deletions.set(receiptKey, {
      key: receiptKey,
      queueUrl: route.queueUrl,
      receiptHandle: raw.receiptHandle,
      route: route.route,
    })
  }
}

/** Performs one final zero-wait receive on each route to reject immediate duplicates. */
async function confirmNoImmediateDuplicate(
  routes: readonly RouteExpectation[],
  configuration: ReturnType<typeof readCollectorConfiguration>,
  receipts: Map<
    string,
    WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt
  >,
  messageIdDigests: Set<string>,
  deletions: Map<string, PendingAlarmReceiptDeletion>,
  staleDeletionKeys: Set<string>,
  port: WorkspaceSearchMigrationRehearsalAlarmQueuePort,
  dependencies: WorkspaceSearchMigrationRehearsalAlarmCollectorDependencies,
  deadlineMilliseconds: number,
): Promise<void> {
  for (const route of routes) {
    const remainingMilliseconds = deadlineMilliseconds - dependencies.now()
    if (remainingMilliseconds <= 0) return failTimeout()
    const messages = await runBoundedQueueOperation(
      (abortSignal) => port.receive({
        abortSignal,
        queueUrl: route.queueUrl,
        route: route.route,
        waitTimeSeconds: 0,
      }),
      Math.min(
        configuration.requestTimeoutMilliseconds,
        remainingMilliseconds,
      ),
    )
    await consumeMessages(
      messages,
      route,
      configuration,
      receipts,
      messageIdDigests,
      deletions,
      staleDeletionKeys,
      port,
      dependencies,
      deadlineMilliseconds,
    )
  }
}

/** Parses one exact raw queue projection. */
function readRawQueueMessage(
  value: unknown,
): {
  /** Exact raw body. */
  readonly body: string
  /** Opaque receipt handle. */
  readonly receiptHandle: string
  /** Raw SQS sent timestamp. */
  readonly sentTimestamp: string
} {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'body',
    'receiptHandle',
    'sentTimestamp',
  ])
  const body = alarmGuards.readOwn(record, 'body')
  const receiptHandle = alarmGuards.readOwn(record, 'receiptHandle')
  const sentTimestamp = alarmGuards.readOwn(record, 'sentTimestamp')
  if (
    typeof body !== 'string' ||
    body.length === 0 ||
    new TextEncoder().encode(body).byteLength > maximumRawBodyBytes ||
    typeof receiptHandle !== 'string' ||
    receiptHandle.length === 0 ||
    receiptHandle.length > 8_192 ||
    typeof sentTimestamp !== 'string'
  ) {
    return failInvalid()
  }
  return { body, receiptHandle, sentTimestamp }
}

/** Parses and validates one route-bound SNS CloudWatch notification. */
function parseNotification(
  body: string,
  route: RouteExpectation,
  configuration: ReturnType<typeof readCollectorConfiguration>,
): ParsedNotification {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return failInvalid()
  }
  const envelope = alarmGuards.requireRecord(parsed)
  alarmGuards.requireExactKeys(envelope, [
    'Message',
    'MessageId',
    'Signature',
    'SignatureVersion',
    'SigningCertURL',
    'Subject',
    'Timestamp',
    'TopicArn',
    'Type',
    'UnsubscribeURL',
  ])
  if (
    alarmGuards.readOwn(envelope, 'Type') !== 'Notification' ||
    alarmGuards.readOwn(envelope, 'TopicArn') !== route.topicArn ||
    alarmGuards.readOwn(envelope, 'SignatureVersion') !== '1'
  ) {
    return failInvalid()
  }
  const messageId = alarmGuards.readOwn(envelope, 'MessageId')
  const message = alarmGuards.readOwn(envelope, 'Message')
  const signature = alarmGuards.readOwn(envelope, 'Signature')
  const subject = alarmGuards.readOwn(envelope, 'Subject')
  if (
    typeof messageId !== 'string' ||
    !snsMessageIdPattern.test(messageId) ||
    typeof message !== 'string' ||
    message.length === 0 ||
    new TextEncoder().encode(message).byteLength > maximumRawBodyBytes ||
    typeof signature !== 'string' ||
    signature.length === 0 ||
    signature.length > 4_096 ||
    !/^[A-Za-z0-9+/=]+$/.test(signature) ||
    typeof subject !== 'string' ||
    subject.length === 0 ||
    subject.length > 512 ||
    !hasOnlyPairedSurrogates(subject) ||
    containsControlCharacter(subject)
  ) {
    return failInvalid()
  }
  readAmazonHttpsUrl(alarmGuards.readOwn(envelope, 'SigningCertURL'))
  readAmazonHttpsUrl(alarmGuards.readOwn(envelope, 'UnsubscribeURL'))
  const publishedAt = readAwsTimestamp(
    alarmGuards.readOwn(envelope, 'Timestamp'),
  )

  let cloudWatchValue: unknown
  try {
    cloudWatchValue = JSON.parse(message)
  } catch {
    return failInvalid()
  }
  const cloudWatch = alarmGuards.requireRecord(cloudWatchValue)
  alarmGuards.requireExactKeys(cloudWatch, [
    'AWSAccountId',
    'AlarmActions',
    'AlarmArn',
    'AlarmConfigurationUpdatedTimestamp',
    'AlarmDescription',
    'AlarmName',
    'InsufficientDataActions',
    'NewStateReason',
    'NewStateValue',
    'OKActions',
    'OldStateValue',
    'Region',
    'StateChangeTime',
    'Trigger',
  ])
  const alarmArn = alarmGuards.readOwn(cloudWatch, 'AlarmArn')
  const alarmName = alarmGuards.readOwn(cloudWatch, 'AlarmName')
  const expectation = configuration.alarms.find(
    (candidate) => candidate.alarmArn === alarmArn,
  )
  if (
    expectation === undefined ||
    alarmName !== expectation.alarmName ||
    alarmGuards.readOwn(cloudWatch, 'NewStateValue') !== 'ALARM' ||
    alarmGuards.readOwn(cloudWatch, 'OldStateValue') !== 'OK'
  ) {
    return failInvalid()
  }
  const topicIdentity = parseTopicArn(route.topicArn)
  if (
    alarmGuards.readOwn(cloudWatch, 'AWSAccountId') !==
      topicIdentity.accountId ||
    typeof alarmGuards.readOwn(cloudWatch, 'AlarmDescription') !== 'string' ||
    typeof alarmGuards.readOwn(cloudWatch, 'NewStateReason') !== 'string' ||
    typeof alarmGuards.readOwn(cloudWatch, 'Region') !== 'string'
  ) {
    return failInvalid()
  }
  readAwsTimestamp(
    alarmGuards.readOwn(cloudWatch, 'AlarmConfigurationUpdatedTimestamp'),
  )
  const stateChangeAt = readAwsTimestamp(
    alarmGuards.readOwn(cloudWatch, 'StateChangeTime'),
  )
  const okActions = readArnArray(alarmGuards.readOwn(cloudWatch, 'OKActions'))
  const insufficientDataActions = readArnArray(
    alarmGuards.readOwn(cloudWatch, 'InsufficientDataActions'),
  )
  const alarmActions = readArnArray(
    alarmGuards.readOwn(cloudWatch, 'AlarmActions'),
  )
  if (
    okActions.length !== 0 ||
    insufficientDataActions.length !== 0 ||
    alarmActions.length !== 2 ||
    new Set(alarmActions).size !== 2 ||
    !alarmActions.includes(configuration.primary.topicArn) ||
    !alarmActions.includes(configuration.secondary.topicArn)
  ) {
    return failInvalid()
  }
  alarmGuards.requireRecord(alarmGuards.readOwn(cloudWatch, 'Trigger'))
  return { alarmArn: expectation.alarmArn, messageId, publishedAt, stateChangeAt }
}

/** Reads one finite array of concrete action ARNs. */
function readArnArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > 5
  ) {
    return failInvalid()
  }
  const entries: readonly unknown[] = value
  return entries.map((entry) => {
    const text = readBoundedText(entry, 2_048)
    if (!arnPattern.test(text)) return failInvalid()
    return text
  })
}

/** Reads one supported SNS service URL. */
function readAmazonHttpsUrl(value: unknown): string {
  const text = readBoundedText(value, 2_048)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return failInvalid()
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !(
      url.hostname.endsWith('.amazonaws.com') ||
      url.hostname.endsWith('.amazonaws.com.cn')
    )
  ) {
    return failInvalid()
  }
  return text
}

/** Reads and canonicalizes an SNS or CloudWatch UTC timestamp. */
function readAwsTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|\+0000)$/.test(value)
  ) {
    return failInvalid()
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return failInvalid()
  const canonical = new Date(milliseconds).toISOString()
  const normalized = value.endsWith('+0000')
    ? `${value.slice(0, -5)}Z`
    : value
  if (canonical !== normalized) return failInvalid()
  return canonical
}

/** Reads one SQS millisecond epoch as a canonical timestamp. */
function readSentTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{13}$/.test(value)) {
    return failInvalid()
  }
  const milliseconds = Number(value)
  if (
    !Number.isSafeInteger(milliseconds) ||
    !Number.isFinite(new Date(milliseconds).getTime())
  ) {
    return failInvalid()
  }
  return new Date(milliseconds).toISOString()
}

/** Creates the domain-separated digest for one exact physical alarm ARN. */
function createAlarmIdentityDigest(alarmArn: string): string {
  return createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-alarm-arn',
    version: 1,
    alarmArn,
  })
}

/**
 * Creates the runtime-key HMAC over one complete plan-bound receipt artifact.
 *
 * @param artifact Complete receipt claims excluding their authentication tag.
 * @param collectionKey Restricted alarm runtime signing key.
 * @returns Lowercase HMAC-SHA-256 authentication digest.
 */
function createReceiptCollectionAuthentication(
  artifact: unknown,
  collectionKey: Uint8Array,
): string {
  if (
    !(collectionKey instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(collectionKey) ||
    collectionKey.byteLength !== 32
  ) {
    return failInvalid()
  }
  return createHmac('sha256', collectionKey)
    .update(alarmReceiptCollectionAuthenticationDomain)
    .update(serializeCanonicalJson(artifact))
    .digest('hex')
}

/** Creates a canonical artifact after all twelve receipts are present. */
function createReceiptArtifact(
  startedAt: string,
  observedCompletionMilliseconds: number,
  receipts: ReadonlyMap<
    string,
    WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt
  >,
  collectionBindingDigest: string,
  collectionSigningKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact {
  if (!Number.isSafeInteger(observedCompletionMilliseconds)) {
    return failInvalid()
  }
  const orderedReceipts:
    WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt[] = []
  for (const name of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS) {
    for (const route of workspaceSearchMigrationRehearsalAlarmRoutes) {
      const receipt = receipts.get(`${name}:${route}`)
      if (receipt === undefined) return failInvalid()
      orderedReceipts.push(receipt)
    }
  }
  const lastReceivedAtMilliseconds = Math.max(...orderedReceipts.map(
    ({ receivedAt }) => Date.parse(receivedAt),
  ))
  if (
    !Number.isFinite(lastReceivedAtMilliseconds) ||
    lastReceivedAtMilliseconds < Date.parse(startedAt) ||
    lastReceivedAtMilliseconds > observedCompletionMilliseconds +
      serviceClockSkewMilliseconds
  ) {
    return failInvalid()
  }
  const completedAt = new Date(lastReceivedAtMilliseconds).toISOString()
  return createWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact({
    collectionBindingDigest,
    startedAt,
    completedAt,
    receipts: orderedReceipts,
  }, collectionSigningKey)
}

/** Reads and authenticates the digest-only receipt artifact structure. */
function readReceiptArtifact(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'artifactDigest',
    'collectionAuthentication',
    'collectionBindingDigest',
    'completedAt',
    'kind',
    'receipts',
    'startedAt',
    'version',
  ])
  if (
    alarmGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_KIND ||
    alarmGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_VERSION
  ) {
    return failInvalid()
  }
  const startedAt = readTimestamp(alarmGuards.readOwn(record, 'startedAt'))
  const collectionBindingDigest = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'collectionBindingDigest'),
  )
  const completedAt = readTimestamp(
    alarmGuards.readOwn(record, 'completedAt'),
  )
  if (Date.parse(startedAt) > Date.parse(completedAt)) return failInvalid()
  const receiptsValue = alarmGuards.readOwn(record, 'receipts')
  if (
    !Array.isArray(receiptsValue) ||
    nodeUtilTypes.isProxy(receiptsValue) ||
    receiptsValue.length !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length * 2
  ) {
    return failInvalid()
  }
  const receiptEntries: readonly unknown[] = receiptsValue
  const messageIdDigests = new Set<string>()
  const receiptDigests = new Set<string>()
  const receipts = receiptEntries.map((entry, index) => {
    const receipt = readDeliveryReceipt(entry)
    const expectedName = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[
      Math.floor(index / 2)
    ]
    const expectedRoute = index % 2 === 0 ? 'primary' : 'secondary'
    if (
      receipt.name !== expectedName ||
      receipt.route !== expectedRoute ||
      Date.parse(receipt.alarmObservedAt) < Date.parse(startedAt) ||
      Date.parse(receipt.alarmObservedAt) > Date.parse(receipt.receivedAt) ||
      Date.parse(receipt.receivedAt) < Date.parse(startedAt) ||
      Date.parse(receipt.receivedAt) > Date.parse(completedAt) ||
      messageIdDigests.has(receipt.messageIdDigest) ||
      receiptDigests.has(receipt.receiptDigest)
    ) {
      return failInvalid()
    }
    messageIdDigests.add(receipt.messageIdDigest)
    receiptDigests.add(receipt.receiptDigest)
    return receipt
  })
  const alarmIdentityDigests = new Set<string>()
  for (
    let receiptIndex = 0;
    receiptIndex < receipts.length;
    receiptIndex += 2
  ) {
    const primary = receipts[receiptIndex]
    const secondary = receipts[receiptIndex + 1]
    if (
      primary === undefined ||
      secondary === undefined ||
      primary.alarmIdentityDigest !== secondary.alarmIdentityDigest ||
      primary.alarmObservedAt !== secondary.alarmObservedAt ||
      alarmIdentityDigests.has(primary.alarmIdentityDigest)
    ) {
      return failInvalid()
    }
    alarmIdentityDigests.add(primary.alarmIdentityDigest)
  }
  const artifactDigest = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'artifactDigest'),
  )
  const claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
    'artifactDigest' | 'collectionAuthentication'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_RECEIPTS_VERSION,
    collectionBindingDigest,
    startedAt,
    completedAt,
    receipts,
  }
  if (artifactDigest !== createMigrationDigest(claims)) return failInvalid()
  const collectionAuthentication = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'collectionAuthentication'),
  )
  return { ...claims, artifactDigest, collectionAuthentication }
}

/** Reads one exact digest-only delivery receipt. */
function readDeliveryReceipt(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'alarmIdentityDigest',
    'alarmObservedAt',
    'messageIdDigest',
    'name',
    'receiptDigest',
    'receivedAt',
    'route',
  ])
  const name = readAlarmName(alarmGuards.readOwn(record, 'name'))
  const alarmIdentityDigest = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'alarmIdentityDigest'),
  )
  const route = readRoute(alarmGuards.readOwn(record, 'route'))
  const receivedAt = readTimestamp(alarmGuards.readOwn(record, 'receivedAt'))
  const alarmObservedAt = readTimestamp(
    alarmGuards.readOwn(record, 'alarmObservedAt'),
  )
  const messageIdDigest = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'messageIdDigest'),
  )
  const receiptDigest = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'receiptDigest'),
  )
  return {
    name,
    alarmIdentityDigest,
    route,
    receivedAt,
    alarmObservedAt,
    messageIdDigest,
    receiptDigest,
  }
}

/** Creates the combined artifact that immutably binds both AWS collectors. */
function createAlarmDeliveryArtifact(
  authorization: WorkspaceSearchMigrationRehearsalAlarmAuthorization,
  receiptArtifact: WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  signalArtifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  ingestionArtifact:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  transitionArtifact: WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact,
  publicationSigningKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact {
  const claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact,
    'artifactDigest' | 'parentPublicationAuthentication'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_VERSION,
    authorization,
    receiptArtifact,
    signalArtifact,
    ingestionArtifact,
    transitionArtifact,
  }
  const artifactDigest = createMigrationDigest(claims)
  const keyFingerprint = createAlarmPublicationKeyFingerprint(
    publicationSigningKey,
  )
  const parentPublicationAuthentication:
    WorkspaceSearchMigrationRehearsalAlarmPublicationAuthentication =
    Object.freeze({
    algorithm: 'HMAC-SHA-256',
    keyFingerprint,
    artifactMac: createAlarmPublicationMac(
      { ...claims, artifactDigest },
      keyFingerprint,
      publicationSigningKey,
    ),
    })
  return {
    ...claims,
    artifactDigest,
    parentPublicationAuthentication,
  }
}

/** Reads and authenticates a combined alarm-delivery artifact. */
function readAlarmDeliveryArtifact(
  value: unknown,
  signalVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'artifactDigest',
    'authorization',
    'ingestionArtifact',
    'kind',
    'parentPublicationAuthentication',
    'receiptArtifact',
    'signalArtifact',
    'transitionArtifact',
    'version',
  ])
  if (
    alarmGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_KIND ||
    alarmGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_VERSION
  ) {
    return failInvalid()
  }
  const authorization = readAlarmAuthorization(
    alarmGuards.readOwn(record, 'authorization'),
  )
  const receiptArtifact = readReceiptArtifact(
    alarmGuards.readOwn(record, 'receiptArtifact'),
  )
  const signalArtifact =
    verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
      alarmGuards.readOwn(record, 'signalArtifact'),
      signalVerificationKey,
    )
  const ingestionCandidate =
    verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
      alarmGuards.readOwn(record, 'ingestionArtifact'),
      signalVerificationKey,
    )
  const ingestionArtifact =
    verifyWorkspaceSearchMigrationRehearsalAlarmIngestionBinding({
      ingestionArtifact: ingestionCandidate,
      signalArtifact,
      verificationKey: signalVerificationKey,
      targetDigest: ingestionCandidate.targetDigest,
    })
  const transitionArtifact = readTransitionArtifact(
    alarmGuards.readOwn(record, 'transitionArtifact'),
  )
  requireReceiptAndTransitionArtifactsBound(
    receiptArtifact,
    transitionArtifact,
  )
  requireSignalAndTransitionArtifactsBound(
    signalArtifact,
    ingestionArtifact,
    transitionArtifact,
    signalVerificationKey,
  )
  const artifactDigest = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'artifactDigest'),
  )
  const claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact,
    'artifactDigest' | 'parentPublicationAuthentication'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_DELIVERY_VERSION,
    authorization,
    receiptArtifact,
    signalArtifact,
    ingestionArtifact,
    transitionArtifact,
  }
  if (artifactDigest !== createMigrationDigest(claims)) return failInvalid()
  const authentication = readAlarmPublicationAuthentication(
    alarmGuards.readOwn(record, 'parentPublicationAuthentication'),
  )
  const expectedKeyFingerprint = createAlarmPublicationKeyFingerprint(
    publicationVerificationKey,
  )
  const expectedMac = createAlarmPublicationMac(
    { ...claims, artifactDigest },
    expectedKeyFingerprint,
    publicationVerificationKey,
  )
  if (
    authentication.keyFingerprint !== expectedKeyFingerprint ||
    !safeAlarmDigestEqual(authentication.artifactMac, expectedMac)
  ) {
    return failInvalid()
  }
  return {
    ...claims,
    artifactDigest,
    parentPublicationAuthentication: authentication,
  }
}

/** Reads exact parent-only authentication metadata. */
function readAlarmPublicationAuthentication(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmPublicationAuthentication {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'algorithm',
    'artifactMac',
    'keyFingerprint',
  ])
  if (alarmGuards.readOwn(record, 'algorithm') !== 'HMAC-SHA-256') {
    return failInvalid()
  }
  return Object.freeze({
    algorithm: 'HMAC-SHA-256',
    keyFingerprint: alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'keyFingerprint'),
    ),
    artifactMac: alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'artifactMac'),
    ),
  })
}

/** Creates a domain-separated parent publication-key fingerprint. */
function createAlarmPublicationKeyFingerprint(key: Uint8Array): string {
  return createHmac('sha256', key)
    .update(alarmPublicationKeyFingerprintDomain, 'utf8')
    .digest('hex')
}

/** Creates the parent HMAC over every final alarm-artifact claim. */
function createAlarmPublicationMac(
  claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact,
    'parentPublicationAuthentication'
  >,
  keyFingerprint: string,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(alarmPublicationMacDomain, 'utf8')
    .update(serializeCanonicalJson({
      ...claims,
      parentPublicationAuthentication: {
        algorithm: 'HMAC-SHA-256',
        keyFingerprint,
      },
    }), 'utf8')
    .digest('hex')
}

/** Compares two exact digest values without timing leakage. */
function safeAlarmDigestEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Reads one purpose-specific alarm permit and shared-session binding. */
function readAlarmAuthorization(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmAuthorization {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'permitDigest',
    'requestedResourcesBinding',
    'sharedSessionBindingDigest',
  ])
  return {
    permitDigest: alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'permitDigest'),
    ),
    requestedResourcesBinding: alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    sharedSessionBindingDigest: alarmGuards.readDigest(
      alarmGuards.readOwn(record, 'sharedSessionBindingDigest'),
    ),
  }
}

/** Requires both collector artifacts to describe the exact same six events. */
function requireReceiptAndTransitionArtifactsBound(
  receiptArtifact: WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  transitionArtifact: WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact,
): void {
  if (
    transitionArtifact.startedAt !== receiptArtifact.startedAt ||
    transitionArtifact.completedAt < receiptArtifact.completedAt
  ) {
    return failInvalid()
  }
  for (
    let alarmIndex = 0;
    alarmIndex < transitionArtifact.transitions.length;
    alarmIndex += 1
  ) {
    const transition = transitionArtifact.transitions[alarmIndex]
    const primary = receiptArtifact.receipts[alarmIndex * 2]
    const secondary = receiptArtifact.receipts[(alarmIndex * 2) + 1]
    if (
      transition === undefined ||
      primary === undefined ||
      secondary === undefined ||
      primary.name !== transition.name ||
      secondary.name !== transition.name ||
      primary.alarmIdentityDigest !== transition.alarmIdentityDigest ||
      secondary.alarmIdentityDigest !== transition.alarmIdentityDigest ||
      primary.alarmObservedAt !== transition.alarmObservedAt ||
      secondary.alarmObservedAt !== transition.alarmObservedAt ||
      Date.parse(primary.receivedAt) >= Date.parse(transition.recoveredAt) ||
      Date.parse(secondary.receivedAt) >= Date.parse(transition.recoveredAt)
    ) {
      return failInvalid()
    }
  }
}

/** Requires authenticated exact EMF receipts to match all six transitions. */
function requireSignalAndTransitionArtifactsBound(
  signalArtifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  ingestionArtifact:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  transitionArtifact: WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact,
  signalVerificationKey: Uint8Array,
): void {
  const bindings =
    createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings(
      signalArtifact,
      signalVerificationKey,
    )
  const recoveryReceipt = signalArtifact.receipts.at(-1)
  const recoveryIngestion = ingestionArtifact.receipts.at(-1)
  if (
    recoveryReceipt === undefined ||
    recoveryReceipt.signal !== 'recovery' ||
    recoveryIngestion === undefined ||
    recoveryIngestion.signal !== 'recovery' ||
    ingestionArtifact.authorizationBindingDigest !==
      signalArtifact.authorizationBindingDigest ||
    ingestionArtifact.configurationHash !== signalArtifact.configurationHash ||
    ingestionArtifact.policyVersion !== signalArtifact.policyVersion ||
    ingestionArtifact.receipts.length !== signalArtifact.receipts.length ||
    signalArtifact.startedAt < transitionArtifact.startedAt ||
    signalArtifact.completedAt >= transitionArtifact.completedAt ||
    bindings.length !== transitionArtifact.transitions.length
  ) {
    return failInvalid()
  }
  for (const [index, transition] of
    transitionArtifact.transitions.entries()) {
    const binding = bindings[index]
    const ingestion = binding === undefined
      ? undefined
      : ingestionArtifact.receipts.find((receipt) =>
          receipt.serializedEmfDigest === binding.signalDigest &&
          receipt.observedAt === binding.observedAt)
    if (
      binding === undefined ||
      ingestion === undefined ||
      transition.name !== binding.name ||
      transition.signalDigest !== binding.signalDigest ||
      transition.signalObservedAt !== binding.observedAt ||
      transition.signalMetricName !== binding.metricName ||
      ingestion.serializedEmfDigest !== binding.signalDigest ||
      ingestion.observedAt !== binding.observedAt ||
      Date.parse(ingestion.ingestedAt) >
        Date.parse(transition.alarmObservedAt) ||
      Date.parse(binding.observedAt) > Date.parse(transition.alarmObservedAt) ||
      Date.parse(recoveryReceipt.observedAt) <=
        Date.parse(transition.alarmObservedAt) ||
      Date.parse(recoveryReceipt.observedAt) >=
        Date.parse(transition.recoveredAt) ||
      Date.parse(recoveryIngestion.ingestedAt) >=
        Date.parse(transition.recoveredAt)
    ) {
      return failInvalid()
    }
  }
}

/** Reads and authenticates the collector-created transition artifact. */
function readTransitionArtifact(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact {
  const record = alarmGuards.requireRecord(value)
  alarmGuards.requireExactKeys(record, [
    'artifactDigest',
    'completedAt',
    'kind',
    'startedAt',
    'transitions',
    'version',
  ])
  if (
    alarmGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_KIND ||
    alarmGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_VERSION
  ) {
    return failInvalid()
  }
  const startedAt = readTimestamp(alarmGuards.readOwn(record, 'startedAt'))
  const completedAt = readTimestamp(
    alarmGuards.readOwn(record, 'completedAt'),
  )
  if (Date.parse(startedAt) >= Date.parse(completedAt)) return failInvalid()
  const transitions = readTransitions(
    alarmGuards.readOwn(record, 'transitions'),
  )
  const alarmIdentityDigests = new Set<string>()
  const historyDigests = new Set<string>()
  const metricEvaluationDigests = new Set<string>()
  const signalDigests = new Set<string>()
  for (const [index, transition] of transitions.entries()) {
    const previous = transitions[index - 1]
    const isBudgetPair = index === 2 &&
      previous !== undefined &&
      transition.signalDigest === previous.signalDigest &&
      transition.signalObservedAt === previous.signalObservedAt
    if (
      Date.parse(transition.signalObservedAt) < Date.parse(startedAt) ||
      Date.parse(transition.signalObservedAt) >
        Date.parse(transition.alarmObservedAt) ||
      Date.parse(transition.alarmObservedAt) < Date.parse(startedAt) ||
      Date.parse(transition.recoveredAt) > Date.parse(completedAt) ||
      alarmIdentityDigests.has(transition.alarmIdentityDigest) ||
      historyDigests.has(transition.historyDigest) ||
      metricEvaluationDigests.has(transition.metricEvaluationDigest) ||
      (signalDigests.has(transition.signalDigest) && !isBudgetPair)
    ) {
      return failInvalid()
    }
    alarmIdentityDigests.add(transition.alarmIdentityDigest)
    historyDigests.add(transition.historyDigest)
    metricEvaluationDigests.add(transition.metricEvaluationDigest)
    signalDigests.add(transition.signalDigest)
  }
  const artifactDigest = alarmGuards.readDigest(
    alarmGuards.readOwn(record, 'artifactDigest'),
  )
  const claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact,
    'artifactDigest'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_VERSION,
    startedAt,
    completedAt,
    transitions,
  }
  if (artifactDigest !== createMigrationDigest(claims)) return failInvalid()
  return { ...claims, artifactDigest }
}

/** Reads six real alarm transitions in canonical order. */
function readTransitions(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalAlarmTransition[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length
  ) {
    return failInvalid()
  }
  const entries: readonly unknown[] = value
  return entries.map((entry, index) => {
    const record = alarmGuards.requireRecord(entry)
    alarmGuards.requireExactKeys(record, [
      'alarmIdentityDigest',
      'alarmObservedAt',
      'alarmState',
      'historyDigest',
      'initialState',
      'metricEvaluationDigest',
      'name',
      'recoveredAt',
      'recoveredState',
      'signalDigest',
      'signalMetricName',
      'signalObservedAt',
    ])
    const name = readAlarmName(alarmGuards.readOwn(record, 'name'))
    const alarmObservedAt = readTimestamp(
      alarmGuards.readOwn(record, 'alarmObservedAt'),
    )
    const recoveredAt = readTimestamp(
      alarmGuards.readOwn(record, 'recoveredAt'),
    )
    const signalObservedAt = readTimestamp(
      alarmGuards.readOwn(record, 'signalObservedAt'),
    )
    const signalMetricName = readSignalMetricName(
      alarmGuards.readOwn(record, 'signalMetricName'),
    )
    if (
      name !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[index] ||
      alarmGuards.readOwn(record, 'initialState') !== 'OK' ||
      alarmGuards.readOwn(record, 'alarmState') !== 'ALARM' ||
      alarmGuards.readOwn(record, 'recoveredState') !== 'OK' ||
      signalMetricName !== expectedSignalMetricName(name) ||
      Date.parse(signalObservedAt) > Date.parse(alarmObservedAt) ||
      Date.parse(alarmObservedAt) >= Date.parse(recoveredAt)
    ) {
      return failInvalid()
    }
    return {
      name,
      alarmIdentityDigest: alarmGuards.readDigest(
        alarmGuards.readOwn(record, 'alarmIdentityDigest'),
      ),
      initialState: 'OK',
      alarmState: 'ALARM',
      recoveredState: 'OK',
      alarmObservedAt,
      recoveredAt,
      signalDigest: alarmGuards.readDigest(
        alarmGuards.readOwn(record, 'signalDigest'),
      ),
      signalObservedAt,
      signalMetricName,
      metricEvaluationDigest: alarmGuards.readDigest(
        alarmGuards.readOwn(record, 'metricEvaluationDigest'),
      ),
      historyDigest: alarmGuards.readDigest(
        alarmGuards.readOwn(record, 'historyDigest'),
      ),
    }
  })
}

/** Reads one canonical alarm label. */
function readAlarmName(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmName {
  if (
    typeof value !== 'string' ||
    !WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.includes(
      readAlarmNameCandidate(value),
    )
  ) {
    return failInvalid()
  }
  return readAlarmNameCandidate(value)
}

/** Narrows a string after membership was checked by the caller. */
function readAlarmNameCandidate(
  value: string,
): WorkspaceSearchMigrationRehearsalAlarmName {
  switch (value) {
    case 'throttle':
    case 'budget-stop':
    case 'budget-exhaustion':
    case 'checkpoint-stall':
    case 'quarantine':
    case 'terminal-failure':
      return value
    default:
      return failInvalid()
  }
}

/** Reads one exact rehearsal alarm metric name. */
function readSignalMetricName(
  value: unknown,
): WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricName {
  switch (value) {
    case 'CheckpointStallCount':
    case 'DescribeTableBudgetExhaustionCount':
    case 'DescribeTableBudgetStopCount':
    case 'DescribeTableThrottleCount':
    case 'QuarantineCount':
    case 'TerminalFailureCount':
      return value
    default:
      return failInvalid()
  }
}

/** Returns the exact metric evaluated by one canonical alarm. */
function expectedSignalMetricName(
  name: WorkspaceSearchMigrationRehearsalAlarmName,
): WorkspaceSearchMigrationTelemetryRehearsalAlarmMetricName {
  switch (name) {
    case 'throttle':
      return 'DescribeTableThrottleCount'
    case 'budget-stop':
      return 'DescribeTableBudgetStopCount'
    case 'budget-exhaustion':
      return 'DescribeTableBudgetExhaustionCount'
    case 'checkpoint-stall':
      return 'CheckpointStallCount'
    case 'quarantine':
      return 'QuarantineCount'
    case 'terminal-failure':
      return 'TerminalFailureCount'
  }
}

/** Reads one exact delivery route. */
function readRoute(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmRoute {
  if (value === 'primary' || value === 'secondary') return value
  return failInvalid()
}

/** Reads one canonical UTC timestamp. */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failInvalid()
  return value
}

/** Reads one bounded nonblank string without control characters. */
function readBoundedText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    !hasOnlyPairedSurrogates(value) ||
    containsControlCharacter(value)
  ) {
    return failInvalid()
  }
  return value
}

/** Reads one safe integer inside an inclusive range. */
function readIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return failInvalid()
  }
  return value
}

/** Reads one optional enumerable own data property without invoking accessors. */
function readOptionalOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failInvalid()
  }
  return descriptor.value
}

/** Detects ASCII control characters forbidden in concrete resource text. */
function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127)
  })
}

/** Runs one queue operation with a real timer and abort boundary. */
async function runBoundedQueueOperation<T>(
  operation: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  if (
    !Number.isFinite(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0
  ) {
    return failTimeout()
  }
  const controller = new AbortController()
  let timeoutIdentifier: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutIdentifier = setTimeout(() => {
      controller.abort()
      reject(new WorkspaceSearchMigrationRehearsalAlarmEvidenceError(
        'MIGRATION_REHEARSAL_ALARM_EVIDENCE_TIMEOUT',
      ))
    }, timeoutMilliseconds)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ])
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError) {
      throw error
    }
    throw new WorkspaceSearchMigrationRehearsalAlarmEvidenceError(
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_UPSTREAM_FAILURE',
    )
  } finally {
    if (timeoutIdentifier !== undefined) clearTimeout(timeoutIdentifier)
  }
}

/** Raises the stable invalid-evidence failure. */
function failInvalid(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmEvidenceError(
    'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
  )
}

/** Raises the stable finite-wait failure. */
function failTimeout(): never {
  throw new WorkspaceSearchMigrationRehearsalAlarmEvidenceError(
    'MIGRATION_REHEARSAL_ALARM_EVIDENCE_TIMEOUT',
  )
}
