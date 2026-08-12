import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
} from '@aws-sdk/client-cloudwatch'
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  createMigrationDigest,
} from './migration-contract'
import {
  collectWorkspaceSearchMigrationRehearsalAlarmHistory,
  collectWorkspaceSearchMigrationRehearsalAlarmEvidence,
  finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence,
  verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact,
  verifyWorkspaceSearchMigrationRehearsalAlarmReceiptCollection,
  WorkspaceSearchMigrationRehearsalAlarmCloudWatchHistoryPort,
  WorkspaceSearchMigrationRehearsalAlarmEvidenceError,
  WorkspaceSearchMigrationRehearsalAlarmSqsQueuePort,
  type CollectWorkspaceSearchMigrationRehearsalAlarmEvidenceInput,
  type CollectWorkspaceSearchMigrationRehearsalAlarmHistoryInput,
  type WorkspaceSearchMigrationRehearsalAlarmCloudWatchClient,
  type WorkspaceSearchMigrationRehearsalAlarmAuthorization,
  type WorkspaceSearchMigrationRehearsalAlarmCollectorDependencies,
  type WorkspaceSearchMigrationRehearsalAlarmDeleteInput,
  type WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt,
  type WorkspaceSearchMigrationRehearsalAlarmHistoryPage,
  type WorkspaceSearchMigrationRehearsalAlarmHistoryPageInput,
  type WorkspaceSearchMigrationRehearsalAlarmHistoryPort,
  type WorkspaceSearchMigrationRehearsalAlarmQueuePort,
  type WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmReceiveInput,
  type WorkspaceSearchMigrationRehearsalAlarmRoute,
  type WorkspaceSearchMigrationRehearsalAlarmSqsClient,
  type WorkspaceSearchMigrationRehearsalRawAlarmMessage,
  type WorkspaceSearchMigrationRehearsalRawAlarmHistoryItem,
} from './migration-rehearsal-alarm-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS,
} from './migration-rehearsal-evidence'
import {
  ingestWorkspaceSearchMigrationRehearsalAlarmSignal,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionTarget,
  type WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort,
} from './migration-rehearsal-alarm-ingestion'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
} from './migration-telemetry'
import {
  createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  runWorkspaceSearchMigrationTelemetryRehearsal,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  type WorkspaceSearchMigrationTelemetryRehearsalSignal,
} from './migration-telemetry-rehearsal'

/** Canonical real rehearsal start. */
const rehearsalStartedAt = '2026-08-02T00:00:00.000Z'

/** Canonical collector completion clock. */
const collectionNow = Date.parse('2026-08-02T00:02:00.000Z')

/** Canonical inclusive CloudWatch history completion. */
const historyCompletedAt = '2026-08-02T00:01:30.000Z'

/** Reviewed configuration binding in all exact signal lines. */
const signalConfigurationHash = 'a'.repeat(64)

/** Reviewed rate policy binding in all exact signal lines. */
const signalPolicyVersion = 'b'.repeat(64)

/** Restricted deterministic alarm-purpose signal HMAC key. */
const signalVerificationKey = new Uint8Array(32).fill(0x5a)

/** Distinct parent-only key authenticating the combined alarm artifact. */
const publicationSigningKey = new Uint8Array(32).fill(0x6b)

/** Permit-authenticated digest of the exact alarm collection plan. */
const alarmCollectionBindingDigest = createMigrationDigest('alarm-plan')

/** Exact digest-only fixed target used by ingestion receipt fixtures. */
const ingestionTarget: WorkspaceSearchMigrationRehearsalAlarmIngestionTarget = {
  account: '111122223333',
  region: 'ap-northeast-1',
  logGroupName: '/mukuroji/test/workspace-search-migration/rehearsal',
  logStreamName: 'alarm-signals-v1',
  logStreamArn:
    'arn:aws:logs:ap-northeast-1:111122223333:log-group:' +
    '/mukuroji/test/workspace-search-migration/rehearsal:' +
    'log-stream:alarm-signals-v1',
}

/** Primary topic used by every CloudWatch alarm action. */
const primaryTopicArn =
  'arn:aws:sns:ap-northeast-1:111122223333:alarm-primary'

/** Secondary topic used by every CloudWatch alarm action. */
const secondaryTopicArn =
  'arn:aws:sns:ap-northeast-1:111122223333:alarm-secondary'

/** Primary evidence queue URL. */
const primaryQueueUrl =
  'https://sqs.ap-northeast-1.amazonaws.com/111122223333/alarm-primary-evidence'

/** Secondary evidence queue URL. */
const secondaryQueueUrl =
  'https://sqs.ap-northeast-1.amazonaws.com/111122223333/alarm-secondary-evidence'

/** Concrete alarm physical names in canonical evidence order. */
const alarmPhysicalNames = Object.freeze([
  'test-WorkspaceSearchMigrationDescribeTableThrottleAlarm',
  'test-WorkspaceSearchMigrationDescribeTableBudgetStopAlarm',
  'test-WorkspaceSearchMigrationRateBudgetExhaustionAlarm',
  'test-WorkspaceSearchMigrationCheckpointStallAlarm',
  'test-WorkspaceSearchMigrationQuarantineAlarm',
  'test-WorkspaceSearchMigrationTerminalFailureAlarm',
])

/** Concrete alarm ARNs in canonical evidence order. */
const alarmArns = alarmPhysicalNames.map((alarmName) =>
  `arn:aws:cloudwatch:ap-northeast-1:111122223333:alarm:${alarmName}`)

/** Captured deletion made by the fake queue port. */
type CapturedDelete = {
  /** Deleted route. */
  readonly route: WorkspaceSearchMigrationRehearsalAlarmRoute
  /** Deleted opaque receipt handle. */
  readonly receiptHandle: string
}

/** In-memory queue port that preserves raw values only for test assertions. */
class AlarmQueueFake implements WorkspaceSearchMigrationRehearsalAlarmQueuePort {
  /** Pending primary receive batches. */
  readonly primaryBatches:
    WorkspaceSearchMigrationRehearsalRawAlarmMessage[][]

  /** Pending secondary receive batches. */
  readonly secondaryBatches:
    WorkspaceSearchMigrationRehearsalRawAlarmMessage[][]

  /** Captured receive requests. */
  readonly receives: WorkspaceSearchMigrationRehearsalAlarmReceiveInput[] = []

  /** Captured accepted-message deletions. */
  readonly deletes: CapturedDelete[] = []

  /** Number of upcoming delete requests forced to fail. */
  deleteFailuresRemaining: number

  /**
   * Creates one fake with route-specific receive batches.
   *
   * @param primaryBatches Batches returned from the primary queue.
   * @param secondaryBatches Batches returned from the secondary queue.
   * @param deleteFailuresRemaining Initial forced delete failure count.
   */
  constructor(
    primaryBatches:
      WorkspaceSearchMigrationRehearsalRawAlarmMessage[][],
    secondaryBatches:
      WorkspaceSearchMigrationRehearsalRawAlarmMessage[][],
    deleteFailuresRemaining = 0,
  ) {
    this.primaryBatches = primaryBatches
    this.secondaryBatches = secondaryBatches
    this.deleteFailuresRemaining = deleteFailuresRemaining
  }

  /**
   * Returns the next route-specific batch without waiting.
   *
   * @param input Captured bounded receive request.
   * @returns Next batch or an empty batch.
   */
  async receive(
    input: WorkspaceSearchMigrationRehearsalAlarmReceiveInput,
  ): Promise<readonly WorkspaceSearchMigrationRehearsalRawAlarmMessage[]> {
    this.receives.push(input)
    return input.route === 'primary'
      ? this.primaryBatches.shift() ?? []
      : this.secondaryBatches.shift() ?? []
  }

  /**
   * Captures one accepted-message deletion.
   *
   * @param input Bounded deletion request.
   * @returns Nothing.
   */
  async delete(
    input: WorkspaceSearchMigrationRehearsalAlarmDeleteInput,
  ): Promise<void> {
    this.deletes.push({
      route: input.route,
      receiptHandle: input.receiptHandle,
    })
    if (this.deleteFailuresRemaining > 0) {
      this.deleteFailuresRemaining -= 1
      throw new Error('injected-delete-failure')
    }
  }
}

/** SQS client fake used to verify concrete adapter command construction. */
class RecordingSqsClient
implements WorkspaceSearchMigrationRehearsalAlarmSqsClient {
  /** Commands captured in call order. */
  readonly commands:
    (ReceiveMessageCommand | DeleteMessageCommand)[] = []

  /** Whether each command received a live abort signal. */
  readonly signalStates: boolean[] = []

  /**
   * Records one command and returns a deterministic SDK-shaped response.
   *
   * @param command SQS receive or delete command.
   * @param options Per-request abort boundary.
   * @returns Untrusted deterministic response.
   */
  async send(
    command: ReceiveMessageCommand | DeleteMessageCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown> {
    this.commands.push(command)
    this.signalStates.push(options.abortSignal.aborted)
    if (command instanceof ReceiveMessageCommand) {
      return {
        Messages: [{
          Attributes: { SentTimestamp: '1785628812000' },
          Body: 'body',
          ReceiptHandle: 'receipt',
        }],
        $metadata: { httpStatusCode: 200 },
      }
    }
    return { $metadata: { httpStatusCode: 200 } }
  }
}

/** In-memory read-only CloudWatch history port with alarm-specific pages. */
class AlarmHistoryFake
implements WorkspaceSearchMigrationRehearsalAlarmHistoryPort {
  /** Remaining pages keyed by exact physical alarm name. */
  readonly pages:
    Map<string, WorkspaceSearchMigrationRehearsalAlarmHistoryPage[]>

  /** Captured bounded history requests. */
  readonly requests:
    WorkspaceSearchMigrationRehearsalAlarmHistoryPageInput[] = []

  /**
   * Creates one fake from alarm-specific page vectors.
   *
   * @param pages Remaining pages keyed by exact physical alarm name.
   */
  constructor(
    pages: ReadonlyMap<
      string,
      readonly WorkspaceSearchMigrationRehearsalAlarmHistoryPage[]
    >,
  ) {
    this.pages = new Map([...pages].map(([alarmName, alarmPages]) => [
      alarmName,
      [...alarmPages],
    ]))
  }

  /**
   * Returns the next projected page for one expected alarm.
   *
   * @param input Captured exact history request.
   * @returns Next page or an empty terminal page.
   */
  async readPage(
    input: WorkspaceSearchMigrationRehearsalAlarmHistoryPageInput,
  ): Promise<WorkspaceSearchMigrationRehearsalAlarmHistoryPage> {
    this.requests.push(input)
    return this.pages.get(input.alarmName)?.shift() ?? {
      items: [],
      nextToken: undefined,
    }
  }
}

/** CloudWatch client fake used to verify the exact read-only command. */
class RecordingCloudWatchClient
implements WorkspaceSearchMigrationRehearsalAlarmCloudWatchClient {
  /** Commands captured in call order. */
  readonly commands: DescribeAlarmHistoryCommand[] = []

  /** Whether each command received a live abort signal. */
  readonly signalStates: boolean[] = []

  /**
   * Records one command and returns a restricted SDK-shaped response.
   *
   * @param command Exact CloudWatch history read command.
   * @param options Per-request abort boundary.
   * @returns Untrusted deterministic response.
   */
  async send(
    command: DescribeAlarmHistoryCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown> {
    this.commands.push(command)
    this.signalStates.push(options.abortSignal.aborted)
    return {
      AlarmHistoryItems: [{
        AlarmName: alarmPhysicalNames[0],
        AlarmType: 'MetricAlarm',
        HistoryData: JSON.stringify({
          version: '1.0',
          oldState: { stateValue: 'OK' },
          newState: { stateValue: 'ALARM' },
        }),
        HistoryItemType: 'StateUpdate',
        Timestamp: new Date('2026-08-02T00:00:10.000Z'),
      }],
      NextToken: 'next-token',
      $metadata: { httpStatusCode: 200 },
    }
  }
}

/** Creates a complete strict collector input. */
function createCollectorInput():
CollectWorkspaceSearchMigrationRehearsalAlarmEvidenceInput {
  return {
    alarmArns,
    authorizedStaleTransitions: [],
    collectionBindingDigest: alarmCollectionBindingDigest,
    collectionSigningKey: signalVerificationKey,
    expectedAccountId: '111122223333',
    expectedRegion: 'ap-northeast-1',
    maximumWaitMilliseconds: 5 * 60 * 1_000,
    requestTimeoutMilliseconds: 5_000,
    primary: {
      queueUrl: primaryQueueUrl,
      topicArn: primaryTopicArn,
    },
    secondary: {
      queueUrl: secondaryQueueUrl,
      topicArn: secondaryTopicArn,
    },
    startedAt: rehearsalStartedAt,
  }
}

/** Creates deterministic collector dependencies. */
function createDependencies(
  now: () => number = () => collectionNow,
  sleep: (milliseconds: number) => Promise<void> = async () => undefined,
): WorkspaceSearchMigrationRehearsalAlarmCollectorDependencies {
  return { now, sleep }
}

/** Creates one UUID-like actual SNS message identifier. */
function createMessageId(routeOrdinal: number, alarmIndex: number): string {
  const suffix = String((routeOrdinal * 100) + alarmIndex).padStart(12, '0')
  return `00000000-0000-4000-8000-${suffix}`
}

/** Creates one exact route-bound SNS/CloudWatch message. */
function createRawMessage(
  route: WorkspaceSearchMigrationRehearsalAlarmRoute,
  alarmIndex: number,
  overrides: {
    /** Optional replacement CloudWatch alarm ARN. */
    readonly alarmArn?: string
    /** Optional replacement CloudWatch alarm name. */
    readonly alarmName?: string
    /** Optional replacement CloudWatch alarm-action vector. */
    readonly alarmActions?: readonly string[]
    /** Optional replacement transition timestamp. */
    readonly alarmObservedAt?: string
    /** Optional replacement SNS message identifier. */
    readonly messageId?: string
    /** Optional replacement resulting CloudWatch state. */
    readonly newState?: 'ALARM' | 'OK'
    /** Optional replacement preceding CloudWatch state. */
    readonly oldState?: 'ALARM' | 'OK'
    /** Optional raw body replacing the valid envelope. */
    readonly rawBody?: string
    /** Optional replacement SQS receipt handle. */
    readonly receiptHandle?: string
    /** Optional replacement SNS topic ARN. */
    readonly topicArn?: string
  } = {},
): WorkspaceSearchMigrationRehearsalRawAlarmMessage {
  const alarmName = overrides.alarmName ?? alarmPhysicalNames[alarmIndex]
  const alarmArn = overrides.alarmArn ?? alarmArns[alarmIndex]
  if (alarmName === undefined || alarmArn === undefined) {
    throw new Error('Alarm fixture index is invalid.')
  }
  const routeOrdinal = route === 'primary' ? 1 : 2
  const topicArn = overrides.topicArn ??
    (route === 'primary' ? primaryTopicArn : secondaryTopicArn)
  const stateChangeMilliseconds = overrides.alarmObservedAt === undefined
    ? Date.parse(rehearsalStartedAt) + 10_000 + (alarmIndex * 1_000)
    : Date.parse(overrides.alarmObservedAt)
  const publishedMilliseconds = stateChangeMilliseconds + 1_000
  const sentMilliseconds = publishedMilliseconds + 1_000
  const cloudWatchMessage = {
    AWSAccountId: '111122223333',
    AlarmActions: overrides.alarmActions ??
      [primaryTopicArn, secondaryTopicArn],
    AlarmArn: alarmArn,
    AlarmConfigurationUpdatedTimestamp:
      '2026-08-01T23:59:00.000+0000',
    AlarmDescription: 'Identifier-free migration rehearsal alarm.',
    AlarmName: alarmName,
    InsufficientDataActions: [],
    NewStateReason: 'Threshold crossed in the reviewed rehearsal.',
    NewStateValue: overrides.newState ?? 'ALARM',
    OKActions: [],
    OldStateValue: overrides.oldState ?? 'OK',
    Region: 'Asia Pacific (Tokyo)',
    StateChangeTime: new Date(stateChangeMilliseconds)
      .toISOString().replace('Z', '+0000'),
    Trigger: { MetricName: 'RehearsalCount' },
  }
  const body = overrides.rawBody ?? JSON.stringify({
    Message: JSON.stringify(cloudWatchMessage),
    MessageId: overrides.messageId ??
      createMessageId(routeOrdinal, alarmIndex),
    Signature: 'QQ==',
    SignatureVersion: '1',
    SigningCertURL:
      'https://sns.ap-northeast-1.amazonaws.com/certificate.pem',
    Subject: `ALARM: ${alarmName}`,
    Timestamp: new Date(publishedMilliseconds).toISOString(),
    TopicArn: topicArn,
    Type: 'Notification',
    UnsubscribeURL:
      'https://sns.ap-northeast-1.amazonaws.com/unsubscribe',
  })
  return {
    body,
    receiptHandle: overrides.receiptHandle ??
      `restricted-${route}-${alarmIndex}`,
    sentTimestamp: String(sentMilliseconds),
  }
}

/**
 * Creates complete route batches and empty duplicate-confirmation batches.
 *
 * @param deleteFailuresRemaining Initial forced acknowledgement failures.
 * @returns Complete deterministic queue port.
 */
function createCompletePort(deleteFailuresRemaining = 0): AlarmQueueFake {
  return new AlarmQueueFake(
    [
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
        createRawMessage('primary', index)),
      [],
    ],
    [
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
        createRawMessage('secondary', index)),
      [],
    ],
    deleteFailuresRemaining,
  )
}

/**
 * Returns one canonical prior transition time for an alarm index.
 *
 * @param alarmIndex Canonical alarm ordinal.
 * @returns Canonical transition time preceding the new collection.
 */
function createStaleAlarmObservedAt(alarmIndex: number): string {
  return new Date(
    Date.parse(rehearsalStartedAt) - 60_000 + (alarmIndex * 1_000),
  ).toISOString()
}

/**
 * Creates all six prior transitions in canonical alarm order.
 *
 * @returns Complete bounded stale-transition allowlist.
 */
function createAuthorizedStaleTransitions() {
  return WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((name, index) => ({
    name,
    alarmObservedAt: createStaleAlarmObservedAt(index),
  }))
}

/**
 * Creates route batches containing stale deliveries before current receipts.
 *
 * @param deleteFailuresRemaining Initial forced stale-delete failures.
 * @returns Queue exposing twelve stale and then twelve current messages.
 */
function createStaleThenCurrentPort(
  deleteFailuresRemaining = 0,
): AlarmQueueFake {
  return new AlarmQueueFake(
    [
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
        createRawMessage('primary', index, {
          alarmObservedAt: createStaleAlarmObservedAt(index),
          messageId: createMessageId(3, index),
          receiptHandle: `stale-primary-${index}`,
        })),
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
        createRawMessage('primary', index)),
      [],
    ],
    [
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
        createRawMessage('secondary', index, {
          alarmObservedAt: createStaleAlarmObservedAt(index),
          messageId: createMessageId(4, index),
          receiptHandle: `stale-secondary-${index}`,
        })),
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map((_name, index) =>
        createRawMessage('secondary', index)),
      [],
    ],
    deleteFailuresRemaining,
  )
}

/**
 * Collects one complete secret-free receipt artifact without acknowledging it.
 *
 * @returns Complete twelve-receipt artifact for finalizer tests.
 */
async function createCompleteReceiptArtifact():
Promise<WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact> {
  const collection =
    await collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
      createCollectorInput(),
      createCompletePort(),
      createDependencies(),
    )
  return collection.artifact
}

/**
 * Creates a strict purpose-specific alarm authorization fixture.
 *
 * @returns Complete digest-only authorization binding.
 */
function createAlarmAuthorization():
WorkspaceSearchMigrationRehearsalAlarmAuthorization {
  return {
    permitDigest: createMigrationDigest('alarm-permit'),
    requestedResourcesBinding: alarmCollectionBindingDigest,
    sharedSessionBindingDigest: createMigrationDigest('shared-session'),
  }
}

/** Creates one deterministic exact existing-recorder signal EMF line. */
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
    signalConfigurationHash,
    '--policy-version',
    signalPolicyVersion,
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
  if (exitCode !== 0 || output.length !== 1 || errors.length !== 0) {
    throw new Error('Exact signal line fixture failed.')
  }
  const line = output[0]
  if (line === undefined) throw new Error('Signal line fixture is missing.')
  return line
}

/**
 * Creates the complete authenticated five-positive-plus-recovery fixture.
 *
 * @param recoveryOffsetMilliseconds Exact recovery offset from plan start.
 * @returns Complete authenticated exact signal receipt chain.
 */
function createSignalPrefixes(
  recoveryOffsetMilliseconds = 40_000,
): readonly WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact[] {
  const offsets = [
    0,
    1_000,
    3_000,
    4_000,
    5_000,
    recoveryOffsetMilliseconds,
  ]
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
          Date.parse(rehearsalStartedAt) + offset,
          String(index + 1).repeat(32),
        ),
        authorizationBindingDigest:
          createAlarmAuthorization().requestedResourcesBinding,
        evidenceLocatorDigest:
          createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
            signalConfigurationHash,
            signalPolicyVersion,
          ),
        ...(artifact === undefined ? {} : { previousArtifact: artifact }),
      }, signalVerificationKey)
    artifacts.push(artifact)
  }
  if (artifact === undefined) throw new Error('Signal artifact is missing.')
  return artifacts
}

/** Creates the complete authenticated five-positive-plus-recovery fixture. */
function createSignalArtifact(
  recoveryOffsetMilliseconds = 40_000,
): WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact {
  const artifact = createSignalPrefixes(recoveryOffsetMilliseconds).at(-1)
  if (artifact === undefined) throw new Error('Signal artifact is missing.')
  return artifact
}

/** Creates one complete six-entry digest-only Logs ingestion fixture. */
async function createIngestionArtifact(
  recoveryOffsetMilliseconds = 40_000,
): Promise<WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact> {
  const port: WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort = {
    putLogEvent: async () => undefined,
  }
  let artifact:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact | undefined
  for (const signalArtifact of
    createSignalPrefixes(recoveryOffsetMilliseconds)) {
    const latest = signalArtifact.receipts.at(-1)
    if (latest === undefined) throw new Error('Signal receipt is missing.')
    artifact = await ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
      signalArtifact,
      ...(artifact === undefined ? {} : { previousArtifact: artifact }),
      target: ingestionTarget,
      authorizationBindingDigest:
        createAlarmAuthorization().requestedResourcesBinding,
      verificationKey: signalVerificationKey,
      requestTimeoutMilliseconds: 1_000,
    }, {
      port,
      clock: () => new Date(latest.timestampMilliseconds + 100),
    })
  }
  if (artifact === undefined) throw new Error('Ingestion artifact is missing.')
  return artifact
}

/** Creates the complete strict alarm history collector input. */
function createHistoryCollectorInput():
CollectWorkspaceSearchMigrationRehearsalAlarmHistoryInput {
  const signalArtifact = createSignalArtifact()
  return {
    alarmArns,
    completedAt: historyCompletedAt,
    expectedAccountId: '111122223333',
    expectedRegion: 'ap-northeast-1',
    maximumPagesPerAlarm: 2,
    maximumWaitMilliseconds: 60_000,
    requestTimeoutMilliseconds: 5_000,
    signals: createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings(
      signalArtifact,
      signalVerificationKey,
    ),
    startedAt: rehearsalStartedAt,
  }
}

/** Creates one projected real CloudWatch metric-alarm state update. */
function createHistoryItem(
  alarmIndex: number,
  oldState: 'OK' | 'ALARM',
  newState: 'OK' | 'ALARM',
  overrides: {
    /** Optional foreign physical alarm name. */
    readonly alarmName?: string
    /** Optional malformed raw history data. */
    readonly historyData?: string
    /** Optional history timestamp replacement. */
    readonly timestamp?: Date
    /** Whether the new state contains real metric-evaluation data. */
    readonly includeMetricEvaluation?: boolean
  } = {},
): WorkspaceSearchMigrationRehearsalRawAlarmHistoryItem {
  const alarmName = overrides.alarmName ?? alarmPhysicalNames[alarmIndex]
  if (alarmName === undefined) {
    throw new Error('Alarm history fixture index is invalid.')
  }
  const defaultOffset = newState === 'ALARM' ? 10_000 : 60_000
  const timestamp = overrides.timestamp ?? new Date(
    Date.parse(rehearsalStartedAt) + defaultOffset +
      (alarmIndex * 1_000),
  )
  const queryDate = new Date(timestamp.getTime() - 1)
    .toISOString().replace('Z', '+0000')
  const startDate = new Date(timestamp.getTime() - 300_000)
    .toISOString().replace('Z', '+0000')
  const metricEvaluation = {
    version: '1.0',
    queryDate,
    startDate,
    statistic: 'Sum',
    period: 300,
    recentDatapoints: newState === 'ALARM' ? [1] : [],
    threshold: 1,
    evaluatedDatapoints: newState === 'ALARM'
      ? [{
          timestamp: new Date(Date.parse(rehearsalStartedAt) +
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
    historyData: overrides.historyData ?? JSON.stringify({
      version: '1.0',
      oldState: {
        stateReason: 'Previous evaluated state.',
        stateValue: oldState,
      },
      newState: {
        stateReason: 'Metric evaluation changed the state.',
        stateValue: newState,
        ...(overrides.includeMetricEvaluation === false
          ? {}
          : { stateReasonData: metricEvaluation }),
      },
    }),
    historyItemType: 'StateUpdate',
    timestamp,
  }
}

/** Creates terminal two-update pages for all six real alarms. */
function createCompleteHistoryPort(): AlarmHistoryFake {
  const pages = new Map<
    string,
    readonly WorkspaceSearchMigrationRehearsalAlarmHistoryPage[]
  >()
  for (const [alarmIndex, alarmName] of alarmPhysicalNames.entries()) {
    pages.set(alarmName, [{
      items: [
        createHistoryItem(alarmIndex, 'OK', 'ALARM'),
        createHistoryItem(alarmIndex, 'ALARM', 'OK'),
      ],
      nextToken: undefined,
    }])
  }
  return new AlarmHistoryFake(pages)
}

/** Creates a fake whose first alarm returns the supplied page vector. */
function createFirstAlarmHistoryPort(
  pages: readonly WorkspaceSearchMigrationRehearsalAlarmHistoryPage[],
): AlarmHistoryFake {
  const alarmName = alarmPhysicalNames[0]
  if (alarmName === undefined) throw new Error('Alarm fixture is missing.')
  return new AlarmHistoryFake(new Map([[alarmName, pages]]))
}

/** Recomputes an artifact after deliberately replacing its receipt vector. */
function replaceArtifactReceipts(
  artifact: WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  receipts: readonly WorkspaceSearchMigrationRehearsalAlarmDeliveryReceipt[],
): WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact {
  const claims = {
    kind: artifact.kind,
    version: artifact.version,
    collectionBindingDigest: artifact.collectionBindingDigest,
    startedAt: artifact.startedAt,
    completedAt: artifact.completedAt,
    receipts,
  }
  return {
    ...claims,
    artifactDigest: createMigrationDigest(claims),
    collectionAuthentication: artifact.collectionAuthentication,
  }
}

/** Reads the failure code without accepting raw error messages. */
function readFailureCode(error: unknown): string | undefined {
  return error instanceof WorkspaceSearchMigrationRehearsalAlarmEvidenceError
    ? error.code
    : undefined
}

/**
 * Awaits one rejected collector operation and checks only its stable code.
 *
 * @param operation Collector promise expected to reject.
 * @param expectedCode Stable raw-value-free failure classification.
 * @returns Nothing.
 */
async function expectFailure(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation
    throw new Error('Expected alarm evidence operation to fail.')
  } catch (error: unknown) {
    expect(readFailureCode(error)).toBe(expectedCode)
  }
}

describe('migration rehearsal alarm evidence collector', () => {
  test('collects exactly six primary and secondary actual digest-only receipts', async () => {
    const port = createCompletePort()
    const collection =
      await collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
      createCollectorInput(),
      port,
      createDependencies(),
    )
    const artifact = collection.artifact

    expect(artifact.receipts).toHaveLength(12)
    expect(artifact.collectionBindingDigest).toBe(
      alarmCollectionBindingDigest,
    )
    expect(verifyWorkspaceSearchMigrationRehearsalAlarmReceiptCollection(
      artifact,
      alarmCollectionBindingDigest,
      signalVerificationKey,
    )).toEqual(artifact)
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalAlarmReceiptCollection(
        artifact,
        createMigrationDigest('foreign-alarm-plan'),
        signalVerificationKey,
      )).toThrow(WorkspaceSearchMigrationRehearsalAlarmEvidenceError)
    expect(artifact.receipts.map(({ name, route }) => `${name}:${route}`))
      .toEqual(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.flatMap(
        (name) => [`${name}:primary`, `${name}:secondary`],
      ))
    expect(new Set(artifact.receipts.map(({ receiptDigest }) => receiptDigest)).size)
      .toBe(12)
    expect(new Set(artifact.receipts.map(({ messageIdDigest }) => messageIdDigest)).size)
      .toBe(12)
    expect(artifact.receipts[0]).toEqual(expect.objectContaining({
      receivedAt: '2026-08-02T00:00:12.000Z',
      messageIdDigest: createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-alarm-message-id',
        version: 1,
        messageId: createMessageId(1, 0),
      }),
    }))
    expect(artifact.receipts.every(
      ({ messageIdDigest, receiptDigest }) =>
        /^[0-9a-f]{64}$/.test(messageIdDigest) &&
        /^[0-9a-f]{64}$/.test(receiptDigest),
    )).toBe(true)
    expect(port.deletes).toEqual([])
    expect(port.receives.map(({ route, waitTimeSeconds }) => ({
      route,
      waitTimeSeconds,
    }))).toEqual([
      { route: 'primary', waitTimeSeconds: 20 },
      { route: 'secondary', waitTimeSeconds: 20 },
      { route: 'primary', waitTimeSeconds: 0 },
      { route: 'secondary', waitTimeSeconds: 0 },
    ])

    const externalText = JSON.stringify(artifact)
    for (const restrictedValue of [
      ...alarmArns,
      ...alarmPhysicalNames,
      primaryTopicArn,
      secondaryTopicArn,
      primaryQueueUrl,
      secondaryQueueUrl,
      createMessageId(1, 0),
      'restricted-primary-0',
    ]) {
      expect(externalText).not.toContain(restrictedValue)
    }
    expect(Object.keys(collection)).toEqual(['artifact'])
    await collection.acknowledge()
    expect(port.deletes).toHaveLength(12)
  })

  test('rejects duplicate deliveries even when the SNS body is otherwise valid', async () => {
    const duplicate = createRawMessage('primary', 0)
    const port = new AlarmQueueFake([[duplicate, duplicate]], [[]])
    const operation = collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
      createCollectorInput(),
      port,
      createDependencies(),
    )
    await expectFailure(
      operation,
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )
    expect(port.deletes).toEqual([])
  })

  test('deletes exact authorized stale dual-route messages before current receipts', async () => {
    const port = createStaleThenCurrentPort()
    const input = {
      ...createCollectorInput(),
      authorizedStaleTransitions: createAuthorizedStaleTransitions(),
    }
    const collection =
      await collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
        input,
        port,
        createDependencies(),
      )

    expect(port.deletes).toHaveLength(12)
    expect(port.deletes.map(({ receiptHandle }) => receiptHandle))
      .toEqual([
        ...Array.from(
          { length: 6 },
          (_value, index) => `stale-primary-${index}`,
        ),
        ...Array.from(
          { length: 6 },
          (_value, index) => `stale-secondary-${index}`,
        ),
      ])
    expect(collection.artifact.receipts).toHaveLength(12)
    expect(collection.artifact.receipts.every(
      ({ alarmObservedAt }) => alarmObservedAt >= rehearsalStartedAt,
    )).toBe(true)
    const serialized = JSON.stringify(collection.artifact)
    expect(serialized).not.toContain(createMessageId(3, 0))
    expect(serialized).not.toContain('stale-primary-0')
    await collection.acknowledge()
    expect(port.deletes).toHaveLength(24)
  })

  test('rejects altered or unauthorized stale messages without deleting them', async () => {
    const allowedTime = createStaleAlarmObservedAt(0)
    const authorizedStaleTransitions = [{
      name: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[0],
      alarmObservedAt: allowedTime,
    }]
    const cases = [{
      candidate: createRawMessage('primary', 0, {
        alarmObservedAt: allowedTime,
        topicArn:
          'arn:aws:sns:ap-northeast-1:111122223333:foreign-topic',
      }),
      transitions: authorizedStaleTransitions,
    }, {
      candidate: createRawMessage('primary', 0, {
        alarmArn:
          'arn:aws:cloudwatch:ap-northeast-1:111122223333:alarm:foreign',
        alarmName: 'foreign',
        alarmObservedAt: allowedTime,
      }),
      transitions: authorizedStaleTransitions,
    }, {
      candidate: createRawMessage('primary', 0, {
        alarmObservedAt: allowedTime,
        alarmActions: [
          primaryTopicArn,
          secondaryTopicArn,
          'arn:aws:sns:ap-northeast-1:111122223333:foreign-topic',
        ],
      }),
      transitions: authorizedStaleTransitions,
    }, {
      candidate: createRawMessage('primary', 0, {
        alarmObservedAt: allowedTime,
        oldState: 'ALARM',
      }),
      transitions: authorizedStaleTransitions,
    }, {
      candidate: createRawMessage('primary', 0, {
        alarmObservedAt: new Date(
          Date.parse(allowedTime) - 1_000,
        ).toISOString(),
      }),
      transitions: authorizedStaleTransitions,
    }, {
      candidate: createRawMessage('primary', 0, {
        alarmObservedAt: allowedTime,
      }),
      transitions: [],
    }]
    for (const candidateCase of cases) {
      const port = new AlarmQueueFake([[candidateCase.candidate]], [[]])
      await expectFailure(
        collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
          {
            ...createCollectorInput(),
            authorizedStaleTransitions: candidateCase.transitions,
          },
          port,
          createDependencies(),
        ),
        'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
      )
      expect(port.deletes).toEqual([])
    }
  })

  test('fails stale cleanup upstream and permits the same plan to retry', async () => {
    const input = {
      ...createCollectorInput(),
      authorizedStaleTransitions: createAuthorizedStaleTransitions(),
    }
    const failingPort = createStaleThenCurrentPort(1)
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
        input,
        failingPort,
        createDependencies(),
      ),
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_UPSTREAM_FAILURE',
    )
    expect(failingPort.deletes).toHaveLength(1)

    const retryPort = createStaleThenCurrentPort()
    const collection =
      await collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
        input,
        retryPort,
        createDependencies(),
      )
    expect(collection.artifact.receipts).toHaveLength(12)
    expect(retryPort.deletes).toHaveLength(12)
  })

  test('rejects a stale-transition allowlist beyond the six-alarm bound', async () => {
    const transitions = [
      ...createAuthorizedStaleTransitions(),
      {
        name: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[0],
        alarmObservedAt: createStaleAlarmObservedAt(0),
      },
    ]
    const port = createCompletePort()
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
        {
          ...createCollectorInput(),
          authorizedStaleTransitions: transitions,
        },
        port,
        createDependencies(),
      ),
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )
    expect(port.receives).toEqual([])
    expect(port.deletes).toEqual([])
  })

  test('retains failed opaque acknowledgements for a bounded safe retry', async () => {
    const port = createCompletePort(36)
    const collection =
      await collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
        createCollectorInput(),
        port,
        createDependencies(),
      )
    await expectFailure(
      collection.acknowledge(),
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_UPSTREAM_FAILURE',
    )
    expect(port.deletes).toHaveLength(36)
    await collection.acknowledge()
    expect(port.deletes).toHaveLength(48)
    const externalText = JSON.stringify(collection)
    expect(externalText).not.toContain('restricted-primary-0')
    expect(externalText).not.toContain(primaryQueueUrl)
  })

  test('rejects foreign alarms before deleting their queue receipt', async () => {
    const port = new AlarmQueueFake([[
      createRawMessage('primary', 0, {
        alarmArn:
          'arn:aws:cloudwatch:ap-northeast-1:111122223333:alarm:foreign',
        alarmName: 'foreign',
      }),
    ]], [[]])
    const operation = collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
      createCollectorInput(),
      port,
      createDependencies(),
    )
    await expectFailure(
      operation,
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )
    expect(port.deletes).toEqual([])
  })

  test('rejects malformed SNS envelopes without exposing or deleting them', async () => {
    const port = new AlarmQueueFake([[
      createRawMessage('primary', 0, { rawBody: '{not-json' }),
    ]], [[]])
    const operation = collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
      createCollectorInput(),
      port,
      createDependencies(),
    )
    await expectFailure(
      operation,
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )
    expect(port.deletes).toEqual([])
  })

  test('terminates with a finite timeout when deliveries stay incomplete', async () => {
    let clockCalls = 0
    const port = new AlarmQueueFake([[]], [[]])
    const input = {
      ...createCollectorInput(),
      maximumWaitMilliseconds: 3_000,
      requestTimeoutMilliseconds: 1_000,
    }
    const operation = collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
      input,
      port,
      createDependencies(() =>
        Date.parse(rehearsalStartedAt) + ((clockCalls += 1) * 2_000)),
    )
    await expectFailure(
      operation,
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_TIMEOUT',
    )
    expect(port.receives.length).toBeLessThanOrEqual(1)
  })

  test('keeps a finite poll-count boundary even when an injected clock stalls', async () => {
    const port = new AlarmQueueFake([], [])
    const input = {
      ...createCollectorInput(),
      maximumWaitMilliseconds: 1_000,
      requestTimeoutMilliseconds: 100,
    }
    const operation = collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
      input,
      port,
      createDependencies(() => Date.parse(rehearsalStartedAt)),
    )
    await expectFailure(
      operation,
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_TIMEOUT',
    )
    expect(port.receives).toHaveLength(6)
  })

  test('aborts an individual receive that never settles', async () => {
    let observedSignal: AbortSignal | undefined
    const hangingPort: WorkspaceSearchMigrationRehearsalAlarmQueuePort = {
      /** Captures the abort signal and deliberately never settles. */
      receive: async (input) => {
        observedSignal = input.abortSignal
        return await new Promise(() => undefined)
      },
      /** A hanging receive can never admit a deletion. */
      delete: async () => undefined,
    }
    const input = {
      ...createCollectorInput(),
      maximumWaitMilliseconds: 1_000,
      requestTimeoutMilliseconds: 100,
    }
    const operation = collectWorkspaceSearchMigrationRehearsalAlarmEvidence(
      input,
      hangingPort,
      createDependencies(() => Date.parse(rehearsalStartedAt)),
    )
    await expectFailure(
      operation,
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_TIMEOUT',
    )
    expect(observedSignal?.aborted).toBe(true)
  })

  test('constructs bounded receive and exact accepted-message delete commands', async () => {
    const client = new RecordingSqsClient()
    const port = new WorkspaceSearchMigrationRehearsalAlarmSqsQueuePort(client)
    const abortController = new AbortController()
    const messages = await port.receive({
      abortSignal: abortController.signal,
      queueUrl: primaryQueueUrl,
      route: 'primary',
      waitTimeSeconds: 20,
    })
    await port.delete({
      abortSignal: abortController.signal,
      queueUrl: primaryQueueUrl,
      receiptHandle: 'receipt',
      route: 'primary',
    })

    expect(messages).toEqual([{
      body: 'body',
      receiptHandle: 'receipt',
      sentTimestamp: '1785628812000',
    }])
    expect(client.commands).toHaveLength(2)
    expect(client.commands[0]).toBeInstanceOf(ReceiveMessageCommand)
    expect(client.commands[0]?.input).toEqual({
      MaxNumberOfMessages: 10,
      MessageSystemAttributeNames: ['SentTimestamp'],
      QueueUrl: primaryQueueUrl,
      WaitTimeSeconds: 20,
    })
    expect(client.commands[1]).toBeInstanceOf(DeleteMessageCommand)
    expect(client.commands[1]?.input).toEqual({
      QueueUrl: primaryQueueUrl,
      ReceiptHandle: 'receipt',
    })
    expect(client.signalStates).toEqual([false, false])
  })

  test('accepts the real SDK client without performing external I/O', () => {
    const client = new SQSClient({
      credentials: {
        accessKeyId: 'test-only-access-key',
        secretAccessKey: 'test-only-secret-key',
      },
      region: 'ap-northeast-1',
    })
    const port = new WorkspaceSearchMigrationRehearsalAlarmSqsQueuePort(client)
    expect(port).toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalAlarmSqsQueuePort,
    )
    client.destroy()
  })
})

describe('migration rehearsal alarm history collector', () => {
  test('collects six actual strict OK-to-ALARM-to-OK histories', async () => {
    const port = createCompleteHistoryPort()
    const input = createHistoryCollectorInput()
    const artifact =
      await collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        input,
        port,
        createDependencies(),
      )

    expect(artifact.transitions).toHaveLength(6)
    expect(artifact.transitions.map(({ name }) => name))
      .toEqual([...WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS])
    expect(artifact.transitions[0]).toEqual(expect.objectContaining({
      initialState: 'OK',
      alarmState: 'ALARM',
      recoveredState: 'OK',
      alarmObservedAt: '2026-08-02T00:00:10.000Z',
      recoveredAt: '2026-08-02T00:01:00.000Z',
      signalDigest: input.signals[0]?.signalDigest,
      signalObservedAt: input.signals[0]?.observedAt,
      signalMetricName: 'DescribeTableThrottleCount',
      metricEvaluationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    }))
    expect(new Set(artifact.transitions.map(
      ({ alarmIdentityDigest }) => alarmIdentityDigest,
    )).size).toBe(6)
    expect(port.requests).toHaveLength(6)
    expect(port.requests[0]).toEqual(expect.objectContaining({
      alarmArn: alarmArns[0],
      alarmName: alarmPhysicalNames[0],
      expectedAccountId: '111122223333',
      expectedRegion: 'ap-northeast-1',
      nextToken: undefined,
    }))
    expect(port.requests[0]?.startDate.toISOString()).toBe(rehearsalStartedAt)
    expect(port.requests[0]?.endDate.toISOString()).toBe(historyCompletedAt)

    const externalText = JSON.stringify(artifact)
    for (const restrictedValue of [...alarmArns, ...alarmPhysicalNames]) {
      expect(externalText).not.toContain(restrictedValue)
    }
  })

  test('rejects foreign and malformed CloudWatch history items', async () => {
    const foreignPort = createFirstAlarmHistoryPort([{
      items: [
        createHistoryItem(0, 'OK', 'ALARM', { alarmName: 'foreign' }),
        createHistoryItem(0, 'ALARM', 'OK'),
      ],
      nextToken: undefined,
    }])
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        foreignPort,
        createDependencies(),
      ),
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )

    const malformedPort = createFirstAlarmHistoryPort([{
      items: [
        createHistoryItem(0, 'OK', 'ALARM', { historyData: '{not-json' }),
        createHistoryItem(0, 'ALARM', 'OK'),
      ],
      nextToken: undefined,
    }])
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        malformedPort,
        createDependencies(),
      ),
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )
  })

  test('rejects SetAlarmState-like history without metric evaluation data', async () => {
    const port = createFirstAlarmHistoryPort([{
      items: [
        createHistoryItem(0, 'OK', 'ALARM', {
          includeMetricEvaluation: false,
        }),
        createHistoryItem(0, 'ALARM', 'OK'),
      ],
      nextToken: undefined,
    }])
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        port,
        createDependencies(),
      ),
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )
  })

  test('rejects duplicate, extra, or incomplete state transitions', async () => {
    const extraPort = createFirstAlarmHistoryPort([{
      items: [
        createHistoryItem(0, 'OK', 'ALARM'),
        createHistoryItem(0, 'ALARM', 'OK'),
        createHistoryItem(0, 'OK', 'ALARM'),
      ],
      nextToken: undefined,
    }])
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        extraPort,
        createDependencies(),
      ),
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )

    const incompletePort = createFirstAlarmHistoryPort([{
      items: [createHistoryItem(0, 'OK', 'ALARM')],
      nextToken: undefined,
    }])
    let nowMilliseconds = collectionNow
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        {
          ...createHistoryCollectorInput(),
          maximumWaitMilliseconds: 1_000,
          requestTimeoutMilliseconds: 100,
        },
        incompletePort,
        createDependencies(
          () => nowMilliseconds,
          async (milliseconds) => {
            nowMilliseconds += milliseconds
          },
        ),
      ),
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_TIMEOUT',
    )
  })

  test('re-polls a terminal incomplete history until the recovery record appears', async () => {
    const port = createCompleteHistoryPort()
    const firstAlarmName = alarmPhysicalNames[0]
    if (firstAlarmName === undefined) {
      throw new Error('Alarm fixture is missing.')
    }
    port.pages.set(firstAlarmName, [{
      items: [createHistoryItem(0, 'OK', 'ALARM')],
      nextToken: undefined,
    }, {
      items: [
        createHistoryItem(0, 'OK', 'ALARM'),
        createHistoryItem(0, 'ALARM', 'OK'),
      ],
      nextToken: undefined,
    }])

    const artifact = await collectWorkspaceSearchMigrationRehearsalAlarmHistory(
      createHistoryCollectorInput(),
      port,
      createDependencies(),
    )

    expect(artifact.transitions).toHaveLength(6)
    expect(port.requests).toHaveLength(7)
    expect(port.requests[1]?.nextToken).toBeUndefined()
  })

  test('rejects repeated pagination tokens within the finite page bound', async () => {
    const port = createFirstAlarmHistoryPort([
      {
        items: [createHistoryItem(0, 'OK', 'ALARM')],
        nextToken: 'repeated-token',
      },
      {
        items: [createHistoryItem(0, 'ALARM', 'OK')],
        nextToken: 'repeated-token',
      },
    ])
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        port,
        createDependencies(),
      ),
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )
    expect(port.requests).toHaveLength(2)
  })

  test('aborts a CloudWatch history read that never settles', async () => {
    let observedSignal: AbortSignal | undefined
    const hangingPort: WorkspaceSearchMigrationRehearsalAlarmHistoryPort = {
      /** Captures the abort signal and deliberately never settles. */
      readPage: async (input) => {
        observedSignal = input.abortSignal
        return await new Promise(() => undefined)
      },
    }
    const input = {
      ...createHistoryCollectorInput(),
      maximumWaitMilliseconds: 1_000,
      requestTimeoutMilliseconds: 100,
    }
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        input,
        hangingPort,
        createDependencies(),
      ),
      'MIGRATION_REHEARSAL_ALARM_EVIDENCE_TIMEOUT',
    )
    expect(observedSignal?.aborted).toBe(true)
  })

  test('constructs only a bounded ascending DescribeAlarmHistory command', async () => {
    const client = new RecordingCloudWatchClient()
    const port =
      new WorkspaceSearchMigrationRehearsalAlarmCloudWatchHistoryPort(client)
    const abortController = new AbortController()
    const alarmArn = alarmArns[0]
    const alarmName = alarmPhysicalNames[0]
    if (alarmArn === undefined || alarmName === undefined) {
      throw new Error('Alarm fixture is missing.')
    }
    const page = await port.readPage({
      abortSignal: abortController.signal,
      alarmArn,
      alarmName,
      endDate: new Date(historyCompletedAt),
      expectedAccountId: '111122223333',
      expectedRegion: 'ap-northeast-1',
      nextToken: 'input-token',
      startDate: new Date(rehearsalStartedAt),
    })

    expect(page.items).toHaveLength(1)
    expect(page.nextToken).toBe('next-token')
    expect(client.commands).toHaveLength(1)
    expect(client.commands[0]).toBeInstanceOf(DescribeAlarmHistoryCommand)
    expect(client.commands[0]?.input).toEqual({
      AlarmName: alarmName,
      AlarmTypes: ['MetricAlarm'],
      EndDate: new Date(historyCompletedAt),
      HistoryItemType: 'StateUpdate',
      MaxRecords: 100,
      NextToken: 'input-token',
      ScanBy: 'TimestampAscending',
      StartDate: new Date(rehearsalStartedAt),
    })
    expect(client.signalStates).toEqual([false])
  })

  test('accepts the real CloudWatch SDK client without external I/O', () => {
    const client = new CloudWatchClient({
      credentials: {
        accessKeyId: 'test-only-access-key',
        secretAccessKey: 'test-only-secret-key',
      },
      region: 'ap-northeast-1',
    })
    const port =
      new WorkspaceSearchMigrationRehearsalAlarmCloudWatchHistoryPort(client)
    expect(port).toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalAlarmCloudWatchHistoryPort,
    )
    client.destroy()
  })

  test('rejects an alarm vector outside the explicit session account', async () => {
    const input = {
      ...createHistoryCollectorInput(),
      expectedAccountId: '999900001111',
    }
    const port = createCompleteHistoryPort()
    await expectFailure(
      collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        input,
        port,
        createDependencies(),
      ),
      'INVALID_MIGRATION_REHEARSAL_ALARM_EVIDENCE',
    )
    expect(port.requests).toEqual([])
  })
})

describe('migration rehearsal alarm evidence finalizer', () => {
  test('binds real histories to receipts and returns their exact immutable bytes', async () => {
    const receiptArtifact = await createCompleteReceiptArtifact()
    const signalArtifact = createSignalArtifact()
    const ingestionArtifact = await createIngestionArtifact()
    const transitionArtifact =
      await collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        createCompleteHistoryPort(),
        createDependencies(),
      )
    const finalized = finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
      authorization: createAlarmAuthorization(),
      receiptArtifact,
      signalArtifact,
      ingestionArtifact,
      publicationSigningKey,
      signalVerificationKey,
      transitionArtifact,
    })

    expect(finalized.evidence).toHaveLength(6)
    expect(finalized.evidence.map(({ name }) => name))
      .toEqual([...WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS])
    expect(finalized.evidence.every(({ status }) => status === 'pass'))
      .toBe(true)
    expect(finalized.evidence[0]).toEqual(expect.objectContaining({
      initialState: 'OK',
      alarmState: 'ALARM',
      recoveredState: 'OK',
      primaryReceiptDigest: receiptArtifact.receipts[0]?.receiptDigest,
      secondaryReceiptDigest: receiptArtifact.receipts[1]?.receiptDigest,
    }))
    const authenticated =
      verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
        JSON.parse(new TextDecoder().decode(
          finalized.canonicalArtifactBytes,
        )),
        signalVerificationKey,
        publicationSigningKey,
      )
    expect(authenticated.authorization).toEqual(createAlarmAuthorization())
    expect(finalized.artifactDigest).toBe(
      createHash('sha256')
        .update(finalized.canonicalArtifactBytes)
        .digest('hex'),
    )
    expect(finalized.artifactByteLength).toBe(
      finalized.canonicalArtifactBytes.byteLength,
    )
    expect(finalized.receiptCount).toBe(12)
  })

  test('rejects a correctly re-digested duplicate receipt vector', async () => {
    const receiptArtifact = await createCompleteReceiptArtifact()
    const signalArtifact = createSignalArtifact()
    const ingestionArtifact = await createIngestionArtifact()
    const transitionArtifact =
      await collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        createCompleteHistoryPort(),
        createDependencies(),
      )
    const first = receiptArtifact.receipts[0]
    if (first === undefined) throw new Error('Receipt fixture is missing.')
    const duplicate = receiptArtifact.receipts.map((receipt, index) =>
      index === 1
        ? { ...receipt, messageIdDigest: first.messageIdDigest }
        : receipt)
    const operation = () => finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
      authorization: createAlarmAuthorization(),
      receiptArtifact: replaceArtifactReceipts(receiptArtifact, duplicate),
      signalArtifact,
      ingestionArtifact,
      publicationSigningKey,
      signalVerificationKey,
      transitionArtifact,
    })
    expect(operation).toThrow(WorkspaceSearchMigrationRehearsalAlarmEvidenceError)
  })

  test('rejects any receipt or transition artifact digest tampering', async () => {
    const receiptArtifact = await createCompleteReceiptArtifact()
    const signalArtifact = createSignalArtifact()
    const ingestionArtifact = await createIngestionArtifact()
    const transitionArtifact =
      await collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        createCompleteHistoryPort(),
        createDependencies(),
      )
    const tampered = {
      ...receiptArtifact,
      artifactDigest: createMigrationDigest('tampered'),
    }
    expect(() => finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
      authorization: createAlarmAuthorization(),
      receiptArtifact: tampered,
      signalArtifact,
      ingestionArtifact,
      publicationSigningKey,
      signalVerificationKey,
      transitionArtifact,
    })).toThrow(WorkspaceSearchMigrationRehearsalAlarmEvidenceError)
    expect(() => finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
      authorization: createAlarmAuthorization(),
      receiptArtifact,
      signalArtifact,
      ingestionArtifact,
      publicationSigningKey,
      signalVerificationKey,
      transitionArtifact: {
        ...transitionArtifact,
        artifactDigest: createMigrationDigest('tampered-history'),
      },
    })).toThrow(WorkspaceSearchMigrationRehearsalAlarmEvidenceError)
  })

  test('rejects receipt history identity or observed-time disagreement', async () => {
    const receiptArtifact = await createCompleteReceiptArtifact()
    const signalArtifact = createSignalArtifact()
    const ingestionArtifact = await createIngestionArtifact()
    const transitionArtifact =
      await collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        createCompleteHistoryPort(),
        createDependencies(),
      )
    const mismatched = receiptArtifact.receipts.map((receipt, index) =>
      index === 0
        ? {
            ...receipt,
            alarmObservedAt: '2026-08-02T00:00:11.000Z',
          }
        : receipt)
    expect(() => finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
      authorization: createAlarmAuthorization(),
      receiptArtifact: replaceArtifactReceipts(receiptArtifact, mismatched),
      signalArtifact,
      ingestionArtifact,
      publicationSigningKey,
      signalVerificationKey,
      transitionArtifact,
    })).toThrow(WorkspaceSearchMigrationRehearsalAlarmEvidenceError)
  })

  test('rejects wrong signal keys and recovery emitted after natural recovery', async () => {
    const receiptArtifact = await createCompleteReceiptArtifact()
    const transitionArtifact =
      await collectWorkspaceSearchMigrationRehearsalAlarmHistory(
        createHistoryCollectorInput(),
        createCompleteHistoryPort(),
        createDependencies(),
      )
    const ingestionArtifact = await createIngestionArtifact()
    expect(() => finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
      authorization: createAlarmAuthorization(),
      receiptArtifact,
      signalArtifact: createSignalArtifact(),
      ingestionArtifact,
      publicationSigningKey,
      signalVerificationKey: new Uint8Array(32).fill(0x44),
      transitionArtifact,
    })).toThrow(WorkspaceSearchMigrationRehearsalAlarmEvidenceError)
    expect(() => finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
      authorization: createAlarmAuthorization(),
      receiptArtifact,
      signalArtifact: createSignalArtifact(70_000),
      ingestionArtifact,
      publicationSigningKey,
      signalVerificationKey,
      transitionArtifact,
    })).toThrow(WorkspaceSearchMigrationRehearsalAlarmEvidenceError)
  })
})
