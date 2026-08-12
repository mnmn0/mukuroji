import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
} from '../../data-integrity/cross-domain-integrity'
import { createMigrationDigest, serializeCanonicalJson } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime,
  createWorkspaceSearchMigrationRehearsalAlarmPlanBinding,
  createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding,
  runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli,
  verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION,
  type WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime,
  type WorkspaceSearchMigrationRehearsalAlarmCliDependencies,
  type WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  type WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims,
} from './migration-rehearsal-alarm-evidence-cli'
import {
  verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact,
  verifyWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmDeleteInput,
  type WorkspaceSearchMigrationRehearsalAlarmHistoryPage,
  type WorkspaceSearchMigrationRehearsalAlarmHistoryPageInput,
  type WorkspaceSearchMigrationRehearsalAlarmHistoryPort,
  type WorkspaceSearchMigrationRehearsalAlarmQueuePort,
  type WorkspaceSearchMigrationRehearsalAlarmReceiveInput,
  type WorkspaceSearchMigrationRehearsalAlarmRoute,
  type WorkspaceSearchMigrationRehearsalRawAlarmHistoryItem,
  type WorkspaceSearchMigrationRehearsalRawAlarmMessage,
} from './migration-rehearsal-alarm-evidence'
import {
  ingestWorkspaceSearchMigrationRehearsalAlarmSignal,
  serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort,
} from './migration-rehearsal-alarm-ingestion'
import { WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS } from './migration-rehearsal-evidence'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
} from './migration-telemetry'
import {
  createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  runWorkspaceSearchMigrationTelemetryRehearsal,
  serializeWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  type WorkspaceSearchMigrationTelemetryRehearsalSignal,
} from './migration-telemetry-rehearsal'
import {
  writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
} from './migration-rehearsal-permit-cli'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
} from './migration-rehearsal-key-derivation'
import {
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  createWorkspaceSearchMigrationRehearsalPermit,
  verifyWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'

/** Exact isolated non-production account used by CLI fixtures. */
const account = '111122223333'

/** Exact distinct production account denied by every fixture. */
const productionAccount = '999900001111'

/** Exact source-controlled deployment target for alarm fixtures. */
const deploymentTargetId = 'test-rehearsal'

/** Canonical keyed resource vector required by the permit fixture. */
const integrityResourceIdentities = Object.freeze(
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
    Object.freeze({
      target,
      identityDigest: createMigrationDigest({
        label: `alarm-evidence-integrity:${index}:${target}`,
      }),
    })
  ),
)

/** Exact permit-authorized assumed-role session. */
const callerArn =
  `arn:aws:sts::${account}:assumed-role/MigrationRehearsal/alarm-evidence`

/** Canonical alarm evidence plan start. */
const startedAt = '2026-08-02T00:00:00.000Z'

/** Canonical end of the recovery history window. */
const completedAt = '2026-08-02T00:01:30.000Z'

/** Fixed permit authentication key. */
const permitKey = new Uint8Array(32).fill(7)

/** Alarm-purpose runtime and publication keys derived from the test master. */
const derivedPermitKeys =
  deriveWorkspaceSearchMigrationRehearsalKeys(permitKey)

/** Exact runtime key authenticating permits and alarm artifacts. */
const alarmRuntimeKey = derivedPermitKeys.runtimeKey

/** Reviewed configuration digest carried by all signal lines. */
const configurationHash = 'b'.repeat(64)

/** Reviewed DescribeTable rate policy digest carried by all signal lines. */
const policyVersion = 'c'.repeat(64)

/**
 * Creates one parser-validated ordinal-zero root projection.
 *
 * @returns Structurally strict projection matching the alarm permit claims.
 */
function createIntegrityAttestationRootProjection() {
  const rootStartedAt = '2026-08-01T23:54:58.000Z'
  const rootCompletedAt = '2026-08-01T23:54:59.999Z'
  const aggregate = {
    version: 2,
    policyVersion,
    attemptCount: 12,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    awsServiceThrottleCount: 0,
    rehearsalInjectedThrottleCount: 0,
    budgetStopCount: 0,
    operationalBudgetStopCount: 0,
    awsServiceThrottleBudgetStopCount: 0,
    rehearsalInjectedBudgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  }
  return parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId,
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    configurationBindingDigest: configurationHash,
    policyVersion,
    attestation: {
      contentMac: createMigrationDigest('alarm-evidence-root-attestation'),
      byteLength: 1_024,
    },
    segment: {
      authenticationKeyFingerprint:
        createMigrationDigest('alarm-evidence-root-rate-key'),
      segmentLocatorDigest:
        createMigrationDigest('alarm-evidence-root-segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac:
        createMigrationDigest('alarm-evidence-root-terminal-record'),
      segmentDigest:
        createMigrationDigest('alarm-evidence-root-segment'),
    },
    interval: {
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 1,
      describeTableCallCount: 6,
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      attemptSequences: [7, 8, 9, 10, 11, 12],
      firstEventSequence: 13,
      lastEventSequence: 24,
      eventSequences: Array.from(
        { length: 12 },
        (_value, index) => index + 13,
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: rootStartedAt,
      completedAt: rootCompletedAt,
    },
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac:
      createMigrationDigest('alarm-evidence-root-table-order'),
    rootMac: createMigrationDigest('alarm-evidence-root'),
    startedAt: rootStartedAt,
    completedAt: rootCompletedAt,
  })
}

/** Concrete six alarm names in canonical evidence order. */
const physicalAlarmNames = Object.freeze([
  'test-WorkspaceSearchMigrationDescribeTableThrottleAlarm',
  'test-WorkspaceSearchMigrationDescribeTableBudgetStopAlarm',
  'test-WorkspaceSearchMigrationRateBudgetExhaustionAlarm',
  'test-WorkspaceSearchMigrationCheckpointStallAlarm',
  'test-WorkspaceSearchMigrationQuarantineAlarm',
  'test-WorkspaceSearchMigrationTerminalFailureAlarm',
])

/** Concrete alarm ARNs in canonical evidence order. */
const alarmArns = physicalAlarmNames.map((name) =>
  `arn:aws:cloudwatch:ap-northeast-1:${account}:alarm:${name}`)

/** Primary real alarm destination. */
const primaryTopicArn =
  `arn:aws:sns:ap-northeast-1:${account}:alarm-primary`

/** Secondary real alarm destination. */
const secondaryTopicArn =
  `arn:aws:sns:ap-northeast-1:${account}:alarm-secondary`

/**
 * Creates strict claims for one exact two-phase collection.
 *
 * @returns Canonically ordered non-production plan claims.
 */
function createPlanClaims():
WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims {
  return {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND,
    planVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    partition: 'aws',
    account,
    productionAccount,
    region: 'ap-northeast-1',
    profile: 'migration-rehearsal',
    commit: 'a'.repeat(40),
    migrationResourceAttestationDigest:
      createMigrationDigest('main-resource-attestation'),
    configurationHash,
    policyVersion,
    signalEvidenceLocatorDigest:
      createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
        configurationHash,
        policyVersion,
      ),
    signalLogGroupName:
      '/mukuroji/test/workspace-search-migration/rehearsal',
    signalLogStreamName: 'alarm-signals-v1',
    signalLogStreamArn:
      `arn:aws:logs:ap-northeast-1:${account}:log-group:` +
      '/mukuroji/test/workspace-search-migration/rehearsal:' +
      'log-stream:alarm-signals-v1',
    alarmArns,
    authorizedStaleTransitions: [],
    primary: {
      queueUrl:
        `https://sqs.ap-northeast-1.amazonaws.com/${account}/alarm-primary`,
      topicArn: primaryTopicArn,
    },
    secondary: {
      queueUrl:
        `https://sqs.ap-northeast-1.amazonaws.com/${account}/alarm-secondary`,
      topicArn: secondaryTopicArn,
    },
    startedAt,
    completedAt,
    receiptMaximumWaitMilliseconds: 60_000,
    historyMaximumWaitMilliseconds: 10_000,
    requestTimeoutMilliseconds: 1_000,
    maximumHistoryPagesPerAlarm: 2,
  }
}

/**
 * Creates one complete plan whose binding covers every exact claim.
 *
 * @returns Complete canonical collection plan.
 */
function createPlan(): WorkspaceSearchMigrationRehearsalAlarmCollectionPlan {
  const claims = createPlanClaims()
  return {
    ...claims,
    requestedResourcesBinding:
      createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(claims),
  }
}

/** Creates one deterministic exact existing-recorder signal line. */
function createSignalLine(
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
  timestampMilliseconds: number,
  correlation: string,
): string {
  const output: string[] = []
  const errors: string[] = []
  const exitCode = runWorkspaceSearchMigrationTelemetryRehearsal([
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
    '--stage',
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
    '--signal',
    signal,
    '--configuration-hash',
    configurationHash,
    '--policy-version',
    policyVersion,
  ], {
    createRecorder: (context, sink) =>
      createWorkspaceSearchMigrationTelemetryRecorder(context, {
        clock: () => timestampMilliseconds,
        sequence: () => 1,
        correlationSource: () => correlation,
        sink,
      }),
    writeStandardOutput: (line) => output.push(line),
    writeStandardError: (line) => errors.push(line),
  })
  const line = output[0]
  if (
    exitCode !== 0 ||
    line === undefined ||
    output.length !== 1 ||
    errors.length !== 0
  ) {
    throw new Error('Exact signal line fixture failed.')
  }
  return line
}

/** Creates the complete authenticated exact signal and recovery fixture. */
function createSignalPrefixes(
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
): readonly WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact[] {
  const offsets = [0, 1_000, 3_000, 4_000, 5_000, 40_000]
  let artifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact |
    undefined
  const artifacts:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact[] = []
  for (const [index, signal] of
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER.entries()) {
    const offset = offsets[index]
    if (offset === undefined) throw new Error('Signal offset is missing.')
    artifact =
      createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact({
        serializedEmfLine: createSignalLine(
          signal,
          Date.parse(startedAt) + offset,
          String(index + 1).repeat(32),
        ),
        authorizationBindingDigest: plan.requestedResourcesBinding,
        evidenceLocatorDigest: plan.signalEvidenceLocatorDigest,
        ...(artifact === undefined ? {} : { previousArtifact: artifact }),
      }, alarmRuntimeKey)
    artifacts.push(artifact)
  }
  if (artifact === undefined) throw new Error('Signal artifact is missing.')
  return artifacts
}

/** Creates the complete authenticated exact signal and recovery fixture. */
function createSignalArtifact(
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
): WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact {
  const artifact = createSignalPrefixes(plan).at(-1)
  if (artifact === undefined) throw new Error('Signal artifact is missing.')
  return artifact
}

/** Creates the complete digest-only fixed-target ingestion artifact fixture. */
async function createIngestionArtifact(
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
): Promise<WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact> {
  const port: WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort = {
    putLogEvent: async () => undefined,
  }
  let artifact:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact | undefined
  for (const signalArtifact of createSignalPrefixes(plan)) {
    const latest = signalArtifact.receipts.at(-1)
    if (latest === undefined) throw new Error('Signal receipt is missing.')
    artifact = await ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
      signalArtifact,
      ...(artifact === undefined ? {} : { previousArtifact: artifact }),
      target: {
        account: plan.account,
        region: plan.region,
        logGroupName: plan.signalLogGroupName,
        logStreamName: plan.signalLogStreamName,
        logStreamArn: plan.signalLogStreamArn,
      },
      authorizationBindingDigest: plan.requestedResourcesBinding,
      verificationKey: alarmRuntimeKey,
      requestTimeoutMilliseconds: plan.requestTimeoutMilliseconds,
    }, {
      port,
      clock: () => new Date(latest.timestampMilliseconds + 100),
    })
  }
  if (artifact === undefined) throw new Error('Ingestion artifact is missing.')
  return artifact
}

/**
 * Creates the exact authenticated permit matching the plan fixture.
 *
 * @param plan Collection plan whose resource binding is authorized.
 * @returns Authenticated short-lived rehearsal permit.
 */
function createPermit(plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan) {
  return createWorkspaceSearchMigrationRehearsalPermit({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
      permitVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
      account,
      productionAccount,
      region: plan.region,
      callerArn,
      commit: plan.commit,
      deploymentTargetId,
      deploymentTrustRootDigest: 'd'.repeat(64),
      requestedResourcesBinding: plan.requestedResourcesBinding,
      configurationBindingDigest: configurationHash,
      policyVersion,
      integrityResourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      integrityResourceIdentities,
      integrityResourceIdentityDigest: 'c'.repeat(64),
      evidenceKeyDigest: derivedPermitKeys.runtimeKeyDigest,
      publicationKeyDigest: derivedPermitKeys.publicationKeyDigest,
      integrityAttestationRoot:
        createIntegrityAttestationRootProjection(),
      issuedAt: '2026-08-01T23:55:00.000Z',
      expiresAt: '2026-08-02T03:00:00.000Z',
    },
    signingKey: alarmRuntimeKey,
  })
}

/**
 * Creates one actual route-bound SNS alarm delivery fixture.
 *
 * @param route Expected primary or secondary delivery route.
 * @param alarmIndex Canonical alarm index.
 * @returns Strict SQS projection containing one SNS notification envelope.
 */
function createRawMessage(
  route: WorkspaceSearchMigrationRehearsalAlarmRoute,
  alarmIndex: number,
  overrides: {
    /** Optional transition time replacing the default current transition. */
    readonly alarmObservedAt?: string
    /** Optional SNS message identifier used to prove semantic redelivery. */
    readonly messageId?: string
    /** Optional process-local SQS receipt handle. */
    readonly receiptHandle?: string
  } = {},
): WorkspaceSearchMigrationRehearsalRawAlarmMessage {
  const alarmName = physicalAlarmNames[alarmIndex]
  const alarmArn = alarmArns[alarmIndex]
  if (alarmName === undefined || alarmArn === undefined) {
    throw new Error('Alarm fixture index is invalid.')
  }
  const topicArn = route === 'primary' ? primaryTopicArn : secondaryTopicArn
  const routeOrdinal = route === 'primary' ? 1 : 2
  const transition = overrides.alarmObservedAt === undefined
    ? Date.parse(startedAt) + 10_000 + (alarmIndex * 1_000)
    : Date.parse(overrides.alarmObservedAt)
  const published = transition + 1_000
  const sent = published + 1_000
  const message = {
    AWSAccountId: account,
    AlarmActions: [primaryTopicArn, secondaryTopicArn],
    AlarmArn: alarmArn,
    AlarmConfigurationUpdatedTimestamp: '2026-08-01T23:59:00.000+0000',
    AlarmDescription: 'Secret-free rehearsal alarm.',
    AlarmName: alarmName,
    InsufficientDataActions: [],
    NewStateReason: 'Threshold crossed.',
    NewStateValue: 'ALARM',
    OKActions: [],
    OldStateValue: 'OK',
    Region: 'Asia Pacific (Tokyo)',
    StateChangeTime: new Date(transition).toISOString().replace('Z', '+0000'),
    Trigger: { MetricName: 'RehearsalCount' },
  }
  return {
    body: JSON.stringify({
      Message: JSON.stringify(message),
      MessageId: overrides.messageId ??
        `00000000-0000-4000-8000-${String((routeOrdinal * 100) + alarmIndex).padStart(12, '0')}`,
      Signature: 'QQ==',
      SignatureVersion: '1',
      SigningCertURL:
        'https://sns.ap-northeast-1.amazonaws.com/certificate.pem',
      Subject: `ALARM: ${alarmName}`,
      Timestamp: new Date(published).toISOString(),
      TopicArn: topicArn,
      Type: 'Notification',
      UnsubscribeURL:
        'https://sns.ap-northeast-1.amazonaws.com/unsubscribe',
    }),
    receiptHandle: overrides.receiptHandle ??
      `receipt-${route}-${alarmIndex}`,
    sentTimestamp: String(sent),
  }
}

/**
 * Creates six current messages for a later collection window.
 *
 * @param route Route whose topic and receipt semantics are produced.
 * @param routeOrdinal Distinct SNS message identifier namespace.
 * @param collectionStartedAt Canonical start of the later capture.
 * @returns Six canonical current messages in alarm order.
 */
function createCurrentMessageBatch(
  route: WorkspaceSearchMigrationRehearsalAlarmRoute,
  routeOrdinal: number,
  collectionStartedAt: string,
): readonly WorkspaceSearchMigrationRehearsalRawAlarmMessage[] {
  return WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
    createRawMessage(route, index, {
      alarmObservedAt: new Date(
        Date.parse(collectionStartedAt) + 10_000 + (index * 1_000),
      ).toISOString(),
      messageId:
        `00000000-0000-4000-8000-${String((routeOrdinal * 100) + index).padStart(12, '0')}`,
    }))
}

/** Route-specific deterministic receive batches for one queue fake. */
type CompleteQueuePortBatches = {
  /** Primary queue batches in receive order. */
  readonly primary:
    readonly (readonly WorkspaceSearchMigrationRehearsalRawAlarmMessage[])[]
  /** Secondary queue batches in receive order. */
  readonly secondary:
    readonly (readonly WorkspaceSearchMigrationRehearsalRawAlarmMessage[])[]
}

/** In-memory queue returning one complete route batch and one empty drain. */
class CompleteQueuePort implements WorkspaceSearchMigrationRehearsalAlarmQueuePort {
  /** Remaining primary batches. */
  private readonly primary:
    WorkspaceSearchMigrationRehearsalRawAlarmMessage[][]

  /** Remaining secondary batches. */
  private readonly secondary:
    WorkspaceSearchMigrationRehearsalRawAlarmMessage[][]

  /** Callback invoked immediately before each delete attempt. */
  readonly #onDelete: (() => void) | undefined

  /** Number of upcoming delete attempts forced to fail. */
  #deleteFailuresRemaining: number

  /** Exact receipt handle whose deletion always fails when configured. */
  readonly #persistentDeleteFailureHandle: string | undefined

  /**
   * Creates one deterministic queue with optional delete failure injection.
   *
   * @param onDelete Optional delete-attempt observer.
   * @param deleteFailuresRemaining Initial forced delete failure count.
   * @param persistentDeleteFailureHandle Handle whose every delete fails.
   * @param batches Optional route-specific receive batches.
   */
  constructor(
    onDelete?: () => void,
    deleteFailuresRemaining = 0,
    persistentDeleteFailureHandle?: string,
    batches?: CompleteQueuePortBatches,
  ) {
    this.#onDelete = onDelete
    this.#deleteFailuresRemaining = deleteFailuresRemaining
    this.#persistentDeleteFailureHandle = persistentDeleteFailureHandle
    this.primary = (batches?.primary ?? [
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
        createRawMessage('primary', index)),
      [],
    ]).map((batch) => [...batch])
    this.secondary = (batches?.secondary ?? [
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
        createRawMessage('secondary', index)),
      [],
    ]).map((batch) => [...batch])
  }

  /**
   * Returns the next complete route-specific batch.
   *
   * @param input Expected route and bounded receive request.
   * @returns Next deterministic message batch.
   */
  async receive(
    input: WorkspaceSearchMigrationRehearsalAlarmReceiveInput,
  ): Promise<readonly WorkspaceSearchMigrationRehearsalRawAlarmMessage[]> {
    return input.route === 'primary'
      ? this.primary.shift() ?? []
      : this.secondary.shift() ?? []
  }

  /**
   * Accepts deletion only after the collector validated the message.
   *
   * @param input Validated delete request.
   * @returns Nothing.
   */
  async delete(
    input: WorkspaceSearchMigrationRehearsalAlarmDeleteInput,
  ): Promise<void> {
    this.#onDelete?.()
    if (
      this.#deleteFailuresRemaining > 0 ||
      input.receiptHandle === this.#persistentDeleteFailureHandle
    ) {
      if (this.#deleteFailuresRemaining > 0) {
        this.#deleteFailuresRemaining -= 1
      }
      throw new Error('injected-delete-failure')
    }
  }
}

/**
 * Creates one strict metric-evaluated CloudWatch state update.
 *
 * @param alarmIndex Canonical alarm index.
 * @param oldState Exact previous alarm state.
 * @param newState Exact resulting alarm state.
 * @param includeEvaluation Whether to retain metric-evaluation data.
 * @returns Projected raw CloudWatch history item.
 */
function createHistoryItem(
  alarmIndex: number,
  oldState: 'OK' | 'ALARM',
  newState: 'OK' | 'ALARM',
  includeEvaluation = true,
): WorkspaceSearchMigrationRehearsalRawAlarmHistoryItem {
  const alarmName = physicalAlarmNames[alarmIndex]
  if (alarmName === undefined) throw new Error('Alarm fixture is missing.')
  const offset = newState === 'ALARM' ? 10_000 : 60_000
  const timestamp = new Date(Date.parse(startedAt) + offset + (alarmIndex * 1_000))
  const stateReasonData = {
    version: '1.0',
    queryDate: new Date(timestamp.getTime() - 1)
      .toISOString().replace('Z', '+0000'),
    startDate: new Date(timestamp.getTime() - 300_000)
      .toISOString().replace('Z', '+0000'),
    statistic: 'Sum',
    period: 300,
    recentDatapoints: newState === 'ALARM' ? [1] : [],
    threshold: 1,
    evaluatedDatapoints: newState === 'ALARM'
      ? [{
          timestamp: new Date(Date.parse(startedAt) +
            ([0, 1_000, 1_000, 3_000, 4_000, 5_000][alarmIndex] ?? 0))
            .toISOString().replace('Z', '+0000'),
          sampleCount: 1,
          value: 1,
        }]
      : [],
  }
  return {
    alarmName,
    alarmType: 'MetricAlarm',
    historyData: JSON.stringify({
      version: '1.0',
      oldState: { stateValue: oldState },
      newState: {
        stateReason: 'Threshold Crossed: evaluated metric datapoints.',
        stateValue: newState,
        ...(includeEvaluation ? { stateReasonData } : {}),
      },
    }),
    historyItemType: 'StateUpdate',
    timestamp,
  }
}

/** In-memory CloudWatch history returning two actual updates for each alarm. */
class CompleteHistoryPort
implements WorkspaceSearchMigrationRehearsalAlarmHistoryPort {
  /** Whether ALARM history retains its metric-evaluation facts. */
  private readonly includeEvaluation: boolean

  /**
   * Creates one complete history fake.
   *
   * @param includeEvaluation Whether ALARM stateReasonData is present.
   */
  constructor(includeEvaluation = true) {
    this.includeEvaluation = includeEvaluation
  }

  /**
   * Returns the exact alarm's terminal two-update history page.
   *
   * @param input Exact alarm and history request bounds.
   * @returns One terminal deterministic history page.
   */
  async readPage(
    input: WorkspaceSearchMigrationRehearsalAlarmHistoryPageInput,
  ): Promise<WorkspaceSearchMigrationRehearsalAlarmHistoryPage> {
    const alarmIndex = physicalAlarmNames.indexOf(input.alarmName)
    if (alarmIndex < 0) return { items: [], nextToken: undefined }
    return {
      items: [
        createHistoryItem(
          alarmIndex,
          'OK',
          'ALARM',
          this.includeEvaluation,
        ),
        createHistoryItem(alarmIndex, 'ALARM', 'OK'),
      ],
      nextToken: undefined,
    }
  }
}

/** Mutable observations retained by one CLI dependency harness. */
type AlarmCliHarnessObservations = {
  /** Exact bytes written by output path. */
  readonly outputs: Map<string, Uint8Array>
  /** Canonical secret-free stdout lines. */
  readonly stdout: string[]
  /** Canonical secret-free stderr lines. */
  readonly stderr: string[]
  /** Ordered durable-write and queue-delete effects. */
  readonly events: string[]
  /** Number of runtime close calls. */
  closeCount: number
  /** Number of authenticated AWS runtime compositions. */
  runtimeCreateCount: number
}

/** One CLI dependency harness and its observations. */
type AlarmCliHarness = {
  /** Injected finite CLI dependencies. */
  readonly dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies
  /** Mutable externally observable effects. */
  readonly observations: AlarmCliHarnessObservations
}

/**
 * Creates deterministic filesystem, clock, output, and AWS dependencies.
 *
 * @param clock Fixed trusted wall clock.
 * @param historyPort Optional deterministic CloudWatch history port.
 * @param receiptBytes Optional capture intermediate used by finalize.
 * @param deleteFailuresRemaining Optional injected delete failure count.
 * @param signalReceiptBytes Optional authenticated signal artifact override.
 * @param ingestionReceiptBytes Optional authenticated Logs ingestion artifact.
 * @param persistentDeleteFailureHandle Handle whose every delete attempt fails.
 * @param existingOutputBytes Optional durable capture output from a prior process.
 * @param plan Exact plan and matching permit exposed by the harness.
 * @param queueBatches Optional route-specific queue receive batches.
 * @returns Injectable dependency harness and observable effects.
 */
function createHarness(
  clock: Date,
  historyPort: WorkspaceSearchMigrationRehearsalAlarmHistoryPort =
    new CompleteHistoryPort(),
  receiptBytes?: Uint8Array,
  deleteFailuresRemaining = 0,
  signalReceiptBytes?: Uint8Array,
  ingestionReceiptBytes?: Uint8Array,
  persistentDeleteFailureHandle?: string,
  existingOutputBytes?: Uint8Array,
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan = createPlan(),
  queueBatches?: CompleteQueuePortBatches,
): AlarmCliHarness {
  const files = new Map<string, Uint8Array>()
  files.set(
    'plan.json',
    new TextEncoder().encode(serializeCanonicalJson(plan)),
  )
  files.set(
    'permit.json',
    new TextEncoder().encode(serializeCanonicalJson(createPermit(plan))),
  )
  if (receiptBytes !== undefined) {
    files.set('receipt.json', receiptBytes)
    files.set(
      'signal-receipts.json',
      signalReceiptBytes ??
        serializeWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
          createSignalArtifact(plan),
          alarmRuntimeKey,
        ),
    )
    if (ingestionReceiptBytes !== undefined) {
      files.set('ingestion-receipts.json', ingestionReceiptBytes)
    }
  }
  const observations: AlarmCliHarnessObservations = {
    outputs: new Map(),
    stdout: [],
    stderr: [],
    events: [],
    closeCount: 0,
    runtimeCreateCount: 0,
  }
  if (existingOutputBytes !== undefined) {
    observations.outputs.set('capture.json', existingOutputBytes.slice())
  }
  const dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies = {
    /** Returns a detached copy of one deterministic canonical input. */
    readInputFile: async (path) => {
      const bytes = files.get(path)
      if (bytes === undefined) throw new Error('missing-test-input')
      return bytes.slice()
    },
    /** Returns a detached exact permit authentication key. */
    readPermitKeyFile: async () => permitKey.slice(),
    /** Reads a detached durable output only when already present. */
    readOutputFileIfExists: async (path) =>
      observations.outputs.get(path)?.slice(),
    /** Captures one exclusive output path. */
    writeOutputFileExclusive: async (path, bytes) => {
      if (observations.outputs.has(path)) return 'exists'
      observations.outputs.set(path, bytes.slice())
      observations.events.push('durable-write')
      return 'created'
    },
    /** Creates actual collector ports without any AWS I/O. */
    createAwsRuntime: async () => {
      observations.runtimeCreateCount += 1
      return {
        queuePort: new CompleteQueuePort(
          () => observations.events.push('delete'),
          deleteFailuresRemaining,
          persistentDeleteFailureHandle,
          queueBatches,
        ),
        historyPort,
        /** Captures exact runtime release. */
        close: () => {
          observations.closeCount += 1
        },
      }
    },
    clock: () => new Date(clock),
    writeStdoutLine: (line) => {
      observations.stdout.push(line)
    },
    writeStderrLine: (line) => {
      observations.stderr.push(line)
    },
  }
  return { dependencies, observations }
}

/**
 * Creates exact common CLI flags for one operation.
 *
 * @param operation Exact capture or finalize phase.
 * @returns Canonical command-line argument vector.
 */
function createArguments(
  operation: 'capture' | 'finalize',
): readonly string[] {
  return [
    operation,
    '--plan-file',
    'plan.json',
    '--permit-file',
    'permit.json',
    '--permit-key-file',
    'permit.key',
    ...(operation === 'finalize'
      ? [
          '--receipt-file',
          'receipt.json',
          '--signal-receipt-file',
          'signal-receipts.json',
          '--ingestion-receipt-file',
          'ingestion-receipts.json',
        ]
      : []),
    '--output-file',
    `${operation}.json`,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_CLI_APPROVAL,
  ]
}

describe('migration rehearsal alarm evidence CLI', () => {
  test('captures actual twelve receipts into one exclusive canonical intermediate', async () => {
    const harness = createHarness(new Date('2026-08-02T00:00:20.000Z'))
    const exitCode = await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      harness.dependencies,
    )

    expect(exitCode).toBe(0)
    const bytes = harness.observations.outputs.get('capture.json')
    expect(bytes).toBeDefined()
    const artifact = verifyWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact(
      JSON.parse(new TextDecoder().decode(bytes)),
    )
    expect(artifact.receipts).toHaveLength(12)
    expect(artifact.collectionBindingDigest).toBe(
      createPlan().requestedResourcesBinding,
    )
    expect(harness.observations.stdout).toHaveLength(1)
    expect(harness.observations.stdout[0]).toContain(
      '"receiptAcknowledgement":"complete"',
    )
    expect(harness.observations.stderr).toEqual([])
    expect(harness.observations.closeCount).toBe(1)
    expect(harness.observations.runtimeCreateCount).toBe(1)
    expect(harness.observations.events).toEqual([
      'durable-write',
      ...Array.from({ length: 12 }, () => 'delete'),
    ])
    const serialized = new TextDecoder().decode(bytes)
    for (const restrictedValue of [...alarmArns, ...physicalAlarmNames]) {
      expect(serialized).not.toContain(restrictedValue)
    }
  })

  test('finalizes receipt and metric history into the combined immutable artifact', async () => {
    const captureHarness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      captureHarness.dependencies,
    )).toBe(0)
    const receiptBytes = captureHarness.observations.outputs.get('capture.json')
    if (receiptBytes === undefined) throw new Error('Receipt output is missing.')
    const plan = createPlan()
    const ingestionReceiptBytes =
      serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
        await createIngestionArtifact(plan),
        alarmRuntimeKey,
      )
    const finalizeHarness = createHarness(
      new Date('2026-08-02T00:02:00.000Z'),
      new CompleteHistoryPort(),
      receiptBytes,
      0,
      undefined,
      ingestionReceiptBytes,
    )
    const exitCode = await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('finalize'),
      finalizeHarness.dependencies,
    )

    expect(exitCode).toBe(0)
    const outputBytes = finalizeHarness.observations.outputs.get('finalize.json')
    expect(outputBytes).toBeDefined()
    const artifact = verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
      JSON.parse(new TextDecoder().decode(outputBytes)),
      alarmRuntimeKey,
      derivedPermitKeys.publicationKey,
    )
    expect(artifact.receiptArtifact.receipts).toHaveLength(12)
    expect(artifact.transitionArtifact.transitions).toHaveLength(6)
    const permit = createPermit(plan)
    const permitClaims = verifyWorkspaceSearchMigrationRehearsalPermit({
      permit,
      verificationKey: alarmRuntimeKey,
      account,
      region: plan.region,
      commit: plan.commit,
      requestedResourcesBinding: plan.requestedResourcesBinding,
      currentTime: new Date('2026-08-02T00:02:00.000Z'),
    })
    expect(artifact.authorization).toEqual({
      permitDigest: createMigrationDigest(permit),
      requestedResourcesBinding: plan.requestedResourcesBinding,
      sharedSessionBindingDigest:
        createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
          permitClaims,
          plan.migrationResourceAttestationDigest,
        ),
    })
    expect(artifact.transitionArtifact.transitions.every(
      ({ metricEvaluationDigest }) => /^[0-9a-f]{64}$/u.test(
        metricEvaluationDigest,
      ),
    )).toBe(true)
    expect(finalizeHarness.observations.closeCount).toBe(1)
  })

  test('fails closed on SetAlarmState-like history without evaluated datapoints', async () => {
    const captureHarness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      captureHarness.dependencies,
    )).toBe(0)
    const receiptBytes = captureHarness.observations.outputs.get('capture.json')
    if (receiptBytes === undefined) throw new Error('Receipt output is missing.')
    const ingestionReceiptBytes =
      serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
        await createIngestionArtifact(createPlan()),
        alarmRuntimeKey,
      )
    const finalizeHarness = createHarness(
      new Date('2026-08-02T00:02:00.000Z'),
      new CompleteHistoryPort(false),
      receiptBytes,
      0,
      undefined,
      ingestionReceiptBytes,
    )
    const exitCode = await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('finalize'),
      finalizeHarness.dependencies,
    )

    expect(exitCode).toBe(1)
    expect(finalizeHarness.observations.outputs).toEqual(new Map())
    expect(finalizeHarness.observations.stderr[0]).toContain(
      'COLLECTION_FAILED',
    )
  })

  test('rejects tampered authenticated signal receipts before final output', async () => {
    const captureHarness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      captureHarness.dependencies,
    )).toBe(0)
    const receiptBytes = captureHarness.observations.outputs.get('capture.json')
    if (receiptBytes === undefined) throw new Error('Receipt output is missing.')
    const signalArtifact = createSignalArtifact(createPlan())
    const tamperedSignalBytes = new TextEncoder().encode(serializeCanonicalJson({
      ...signalArtifact,
      authenticationTag: 'd'.repeat(64),
    }))
    const finalizeHarness = createHarness(
      new Date('2026-08-02T00:02:00.000Z'),
      new CompleteHistoryPort(),
      receiptBytes,
      0,
      tamperedSignalBytes,
      serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
        await createIngestionArtifact(createPlan()),
        alarmRuntimeKey,
      ),
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('finalize'),
      finalizeHarness.dependencies,
    )).toBe(1)
    expect(finalizeHarness.observations.outputs).toEqual(new Map())
    expect(finalizeHarness.observations.closeCount).toBe(0)
    expect(finalizeHarness.observations.stderr[0]).toContain(
      'COLLECTION_FAILED',
    )
  })

  test('rejects non-canonical plans and missing explicit approval before AWS', async () => {
    const harness = createHarness(new Date('2026-08-02T00:00:20.000Z'))
    const invalidArguments = [...createArguments('capture')]
    invalidArguments[invalidArguments.length - 1] = 'not-approved'
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      invalidArguments,
      harness.dependencies,
    )).toBe(2)
    expect(harness.observations.closeCount).toBe(0)
  })

  test('binds the main migration resource attestation into the alarm permit plan', () => {
    const plan = createPlan()
    expect(() => verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan({
      ...plan,
      migrationResourceAttestationDigest:
        createMigrationDigest('different-main-resource-attestation'),
    })).toThrow()
    const permit = verifyWorkspaceSearchMigrationRehearsalPermit({
      permit: createPermit(plan),
      verificationKey: alarmRuntimeKey,
      account,
      region: plan.region,
      commit: plan.commit,
      requestedResourcesBinding: plan.requestedResourcesBinding,
      currentTime: new Date('2026-08-02T00:00:20.000Z'),
    })
    expect(
      createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
        permit,
        plan.migrationResourceAttestationDigest,
      ),
    ).toBe(createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-shared-session-binding',
      version: 1,
      commit: plan.commit,
      callerAttestationDigest: createMigrationDigest({
        account,
        callerArn,
        stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      }),
      productionIsolationDigest: createMigrationDigest({
        accountsSeparated: true,
        productionAccount,
        rehearsalAccount: account,
        stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      }),
      resourceAttestationDigest: plan.migrationResourceAttestationDigest,
    }))
  })

  test('rejects operator signal digests and mismatched locator claims in plans', () => {
    const plan = createPlan()
    expect(() => verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan({
      ...plan,
      signals: [{ name: 'throttle', signalDigest: 'd'.repeat(64) }],
    })).toThrow()
    expect(() => verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan({
      ...plan,
      signalEvidenceLocatorDigest: 'd'.repeat(64),
    })).toThrow()
  })

  test('requires v4 canonical bound stale-transition plan claims', () => {
    const plan = createPlan()
    expect(() => verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan({
      ...Object.fromEntries(Object.entries(plan).filter(
        ([key]) => key !== 'authorizedStaleTransitions',
      )),
      planVersion: 3,
    })).toThrow()

    const validTransitions = [{
      name: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[0],
      alarmObservedAt: '2026-08-01T23:59:10.000Z',
    }, {
      name: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[1],
      alarmObservedAt: '2026-08-01T23:59:11.000Z',
    }]
    expect(() => verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan({
      ...plan,
      authorizedStaleTransitions: validTransitions,
    })).toThrow()

    const invalidTransitionVectors: readonly unknown[] = [[
      validTransitions[1],
      validTransitions[0],
    ], [
      validTransitions[0],
      validTransitions[0],
    ], [{
      name: 'foreign-alarm',
      alarmObservedAt: '2026-08-01T23:59:10.000Z',
    }], [{
      name: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[0],
      alarmObservedAt: startedAt,
    }]]
    for (const authorizedStaleTransitions of invalidTransitionVectors) {
      expect(() => Reflect.apply(
        createWorkspaceSearchMigrationRehearsalAlarmPlanBinding,
        undefined,
        [{
          ...createPlanClaims(),
          authorizedStaleTransitions,
        }],
      )).toThrow()
    }

    const claims = {
      ...createPlanClaims(),
      authorizedStaleTransitions: validTransitions,
    }
    const reboundPlan = verifyWorkspaceSearchMigrationRehearsalAlarmCollectionPlan({
      ...claims,
      requestedResourcesBinding:
        createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(claims),
    })
    expect(reboundPlan.authorizedStaleTransitions).toEqual(validTransitions)
  })

  test('rejects capture when its finite wait can cross the recovery boundary', async () => {
    const harness = createHarness(new Date('2026-08-02T00:00:28.001Z'))
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      harness.dependencies,
    )).toBe(1)
    expect(harness.observations.closeCount).toBe(0)
    expect(harness.observations.outputs).toEqual(new Map())
    expect(harness.observations.stderr[0]).toContain(
      'AUTHENTICATION_FAILED',
    )
  })

  test('never acknowledges receipts when durable output publication fails', async () => {
    const harness = createHarness(new Date('2026-08-02T00:00:20.000Z'))
    const dependencies: WorkspaceSearchMigrationRehearsalAlarmCliDependencies = {
      ...harness.dependencies,
      /** Injects a durable-publication failure before acknowledgement. */
      writeOutputFileExclusive: async () => {
        harness.observations.events.push('write-failed')
        throw new Error('injected-output-failure')
      },
    }
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      dependencies,
    )).toBe(1)
    expect(harness.observations.events).toEqual(['write-failed'])
    expect(harness.observations.stdout).toEqual([])
  })

  test('retains durable evidence when every bounded acknowledgement fails', async () => {
    const harness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
      new CompleteHistoryPort(),
      undefined,
      100,
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      harness.dependencies,
    )).toBe(0)
    expect(harness.observations.outputs.has('capture.json')).toBe(true)
    expect(harness.observations.events[0]).toBe('durable-write')
    expect(harness.observations.events.slice(1)).toHaveLength(36)
    expect(harness.observations.stdout[0]).toContain(
      '"receiptAcknowledgement":"incomplete"',
    )
    expect(harness.observations.stderr).toEqual([])
    expect(harness.observations.stderr.join('')).not.toContain('receipt-primary')
  })

  test('bounds retries to the one remaining receipt after partial delete success', async () => {
    const harness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
      new CompleteHistoryPort(),
      undefined,
      0,
      undefined,
      undefined,
      'receipt-primary-0',
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      harness.dependencies,
    )).toBe(0)
    expect(harness.observations.events).toEqual([
      'durable-write',
      ...Array.from({ length: 14 }, () => 'delete'),
    ])
    expect(harness.observations.stdout[0]).toContain(
      '"receiptAcknowledgement":"incomplete"',
    )
    expect(harness.observations.stderr).toEqual([])
  })

  test('recovers authenticated durable capture without AWS or more deletes', async () => {
    const interruptedHarness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
      new CompleteHistoryPort(),
      undefined,
      0,
      undefined,
      undefined,
      'receipt-primary-0',
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      interruptedHarness.dependencies,
    )).toBe(0)
    const durableOutput =
      interruptedHarness.observations.outputs.get('capture.json')
    if (durableOutput === undefined) {
      throw new Error('Interrupted durable output is missing.')
    }
    const recoveryHarness = createHarness(
      new Date('2026-08-02T00:02:00.000Z'),
      new CompleteHistoryPort(),
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      durableOutput,
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      recoveryHarness.dependencies,
    )).toBe(0)
    expect(interruptedHarness.observations.runtimeCreateCount).toBe(1)
    expect(interruptedHarness.observations.events).toHaveLength(15)
    expect(recoveryHarness.observations.runtimeCreateCount).toBe(0)
    expect(recoveryHarness.observations.closeCount).toBe(0)
    expect(recoveryHarness.observations.events).toEqual([])
    expect(recoveryHarness.observations.stdout[0]).toContain(
      '"receiptAcknowledgement":"recovered-existing"',
    )
    expect(recoveryHarness.observations.stderr).toEqual([])
  })

  test('uses a new v4 plan to clean one prior partial acknowledgement', async () => {
    const interruptedHarness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
      new CompleteHistoryPort(),
      undefined,
      0,
      undefined,
      undefined,
      'receipt-primary-0',
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      interruptedHarness.dependencies,
    )).toBe(0)
    expect(interruptedHarness.observations.stdout[0]).toContain(
      '"receiptAcknowledgement":"incomplete"',
    )
    const priorBytes =
      interruptedHarness.observations.outputs.get('capture.json')
    if (priorBytes === undefined) throw new Error('Prior output is missing.')
    const priorArtifact = verifyWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact(
      JSON.parse(new TextDecoder().decode(priorBytes)),
    )
    const priorTransition = priorArtifact.receipts[0]
    if (priorTransition === undefined) {
      throw new Error('Prior transition is missing.')
    }

    const nextStartedAt = '2026-08-02T00:03:00.000Z'
    const nextClaims = {
      ...createPlanClaims(),
      startedAt: nextStartedAt,
      completedAt: '2026-08-02T00:04:30.000Z',
      authorizedStaleTransitions: [{
        name: priorTransition.name,
        alarmObservedAt: priorTransition.alarmObservedAt,
      }],
    }
    const nextPlan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan = {
      ...nextClaims,
      requestedResourcesBinding:
        createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(nextClaims),
    }
    const staleMessageId = '00000000-0000-4000-8000-000000000300'
    const queueBatches: CompleteQueuePortBatches = {
      primary: [[createRawMessage('primary', 0, {
        alarmObservedAt: priorTransition.alarmObservedAt,
        messageId: staleMessageId,
        receiptHandle: 'prior-partial-primary-0',
      })], createCurrentMessageBatch('primary', 5, nextStartedAt), []],
      secondary: [
        createCurrentMessageBatch('secondary', 6, nextStartedAt),
        [],
        [],
      ],
    }
    const nextHarness = createHarness(
      new Date('2026-08-02T00:03:20.000Z'),
      new CompleteHistoryPort(),
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      nextPlan,
      queueBatches,
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      nextHarness.dependencies,
    )).toBe(0)
    expect(nextHarness.observations.events[0]).toBe('delete')
    expect(nextHarness.observations.events[1]).toBe('durable-write')
    expect(nextHarness.observations.events).toHaveLength(14)
    expect(nextHarness.observations.stdout[0]).toContain(
      '"receiptAcknowledgement":"complete"',
    )
    const nextBytes = nextHarness.observations.outputs.get('capture.json')
    if (nextBytes === undefined) throw new Error('Next output is missing.')
    const externalText = new TextDecoder().decode(nextBytes) +
      nextHarness.observations.stdout.join('')
    expect(externalText).not.toContain(staleMessageId)
    expect(externalText).not.toContain('prior-partial-primary-0')
  })

  test('rejects an authenticated foreign-plan output before AWS', async () => {
    const foreignClaims = {
      ...createPlanClaims(),
      migrationResourceAttestationDigest:
        createMigrationDigest('foreign-main-resource-attestation'),
    }
    const foreignPlan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan = {
      ...foreignClaims,
      requestedResourcesBinding:
        createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(foreignClaims),
    }
    const foreignHarness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
      new CompleteHistoryPort(),
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      foreignPlan,
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      foreignHarness.dependencies,
    )).toBe(0)
    const foreignOutput = foreignHarness.observations.outputs.get('capture.json')
    if (foreignOutput === undefined) throw new Error('Foreign output is missing.')
    const harness = createHarness(
      new Date('2026-08-02T00:00:20.000Z'),
      new CompleteHistoryPort(),
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      foreignOutput,
    )
    expect(await runWorkspaceSearchMigrationRehearsalAlarmEvidenceCli(
      createArguments('capture'),
      harness.dependencies,
    )).toBe(1)
    expect(harness.observations.runtimeCreateCount).toBe(0)
    expect(harness.observations.closeCount).toBe(0)
    expect(harness.observations.events).toEqual([])
    expect(harness.observations.stdout).toEqual([])
    expect(harness.observations.stderr[0]).toContain('COLLECTION_FAILED')
  })

  test('authenticates the exact assumed role without exposing raw AWS clients', async () => {
    const plan = createPlan()
    const permit = verifyWorkspaceSearchMigrationRehearsalPermit({
      permit: createPermit(plan),
      verificationKey: alarmRuntimeKey,
      account,
      region: plan.region,
      commit: plan.commit,
      requestedResourcesBinding: plan.requestedResourcesBinding,
      currentTime: new Date('2026-08-02T00:00:20.000Z'),
    })
    const originalSend = Reflect.get(STSClient.prototype, 'send')
    let observedCommand: unknown
    let runtime: WorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime | undefined
    let sendRestored = false
    if (!Reflect.set(
      STSClient.prototype,
      'send',
      async (command: unknown) => {
        observedCommand = command
        return {
          Account: account,
          Arn: callerArn,
          UserId: 'AROA12345678901234567:alarm-evidence',
          $metadata: {},
        }
      },
    )) {
      throw new Error('STS send method could not be isolated.')
    }
    try {
      runtime =
        await createWorkspaceSearchMigrationRehearsalAlarmCliAwsRuntime({
          plan,
          permit,
          requestTimeoutMilliseconds: plan.requestTimeoutMilliseconds,
        })
      expect(observedCommand).toBeInstanceOf(GetCallerIdentityCommand)
      expect(Object.keys(runtime).sort()).toEqual([
        'historyPort',
        'queuePort',
      ])
      expect(Object.keys(runtime.queuePort)).toEqual([])
      expect(Object.keys(runtime.historyPort)).toEqual([])
      expect(Reflect.has(runtime, 'sqsClient')).toBe(false)
      expect(Reflect.has(runtime, 'cloudWatchClient')).toBe(false)
      expect(Reflect.has(runtime, 'stsClient')).toBe(false)
    } finally {
      runtime?.close()
      sendRestored = Reflect.set(STSClient.prototype, 'send', originalSend)
    }
    expect(sendRestored).toBe(true)
  })

  test('writes actual canonical output with exclusive owner-only mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alarm-evidence-cli-'))
    const outputPath = join(directory, 'alarm-output.json')
    try {
      const bytes = new TextEncoder().encode(serializeCanonicalJson({
        kind: 'test-alarm-output',
        status: 'complete',
      }))
      expect(await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
        outputPath,
        bytes,
      )).toBe('created')
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600)
      expect(await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
        outputPath,
        bytes,
      )).toBe('reconciled')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
