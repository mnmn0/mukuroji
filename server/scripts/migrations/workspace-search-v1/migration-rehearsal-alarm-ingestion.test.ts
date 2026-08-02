import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalAlarmPlanBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION,
  type WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  type WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims,
} from './migration-rehearsal-alarm-evidence-cli'
import {
  parseWorkspaceSearchMigrationRehearsalAlarmIngestionCliArguments,
  runWorkspaceSearchMigrationRehearsalAlarmIngestionCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_APPROVAL,
  WorkspaceSearchMigrationRehearsalCloudWatchLogsIngestionPort,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies,
  type WorkspaceSearchMigrationRehearsalCloudWatchLogsClient,
} from './migration-rehearsal-alarm-ingestion-cli'
import {
  createWorkspaceSearchMigrationRehearsalAlarmIngestionTargetDigest,
  ingestWorkspaceSearchMigrationRehearsalAlarmSignal,
  serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  verifyWorkspaceSearchMigrationRehearsalAlarmIngestionBinding,
  WorkspaceSearchMigrationRehearsalAlarmIngestionError,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionTarget,
  type WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort,
  type WorkspaceSearchMigrationRehearsalAlarmLogWriteInput,
} from './migration-rehearsal-alarm-ingestion'
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
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
} from './migration-telemetry'
import {
  createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  runWorkspaceSearchMigrationTelemetryRehearsal,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationTelemetryRehearsalSignal,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
} from './migration-telemetry-rehearsal'

/** Exact isolated non-production account used by ingestion fixtures. */
const account = '111122223333'

/** Exact distinct production account denied by every fixture. */
const productionAccount = '999900001111'

/** Exact source-controlled deployment target for ingestion fixtures. */
const deploymentTargetId = 'test-rehearsal'

/** Canonical keyed resource vector required by the permit fixture. */
const integrityResourceIdentities = Object.freeze(
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
    Object.freeze({
      target,
      identityDigest: createMigrationDigest({
        label: `alarm-ingestion-integrity:${index}:${target}`,
      }),
    })
  ),
)

/** Exact authenticated assumed-role session. */
const callerArn =
  `arn:aws:sts::${account}:assumed-role/MigrationRehearsal/alarm-ingestion`

/** Fixed alarm-purpose key shared by permit and receipt fixtures. */
const masterKey = new Uint8Array(32).fill(23)

/** Purpose-separated runtime and publication keys derived from the master. */
const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(masterKey)

/** Exact runtime key authenticating the permit and receipt chains. */
const key = derivedKeys.runtimeKey

/** Canonical beginning of the alarm plan. */
const startedAt = '2026-08-02T00:00:00.000Z'

/** Canonical completion of the alarm plan. */
const completedAt = '2026-08-02T00:10:00.000Z'

/** Exact reviewed resource configuration digest. */
const configurationHash = 'b'.repeat(64)

/** Exact reviewed DescribeTable rate policy digest. */
const policyVersion = 'c'.repeat(64)

/**
 * Creates one parser-validated ordinal-zero root projection.
 *
 * @returns Structurally strict projection matching the ingestion permit.
 */
function createIntegrityAttestationRootProjection() {
  const rootStartedAt = '2026-08-01T23:54:58.000Z'
  const rootCompletedAt = '2026-08-01T23:54:59.999Z'
  const aggregate = {
    version: 1,
    policyVersion,
    attemptCount: 12,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
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
      contentMac: createMigrationDigest('alarm-ingestion-root-attestation'),
      byteLength: 1_024,
    },
    segment: {
      authenticationKeyFingerprint:
        createMigrationDigest('alarm-ingestion-root-rate-key'),
      segmentLocatorDigest:
        createMigrationDigest('alarm-ingestion-root-segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac:
        createMigrationDigest('alarm-ingestion-root-terminal-record'),
      segmentDigest:
        createMigrationDigest('alarm-ingestion-root-segment'),
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
      createMigrationDigest('alarm-ingestion-root-table-order'),
    rootMac: createMigrationDigest('alarm-ingestion-root'),
    startedAt: rootStartedAt,
    completedAt: rootCompletedAt,
  })
}

/** Exact fixed precreated CloudWatch Logs target. */
const target: WorkspaceSearchMigrationRehearsalAlarmIngestionTarget = {
  account,
  region: 'ap-northeast-1',
  logGroupName: '/mukuroji/test/workspace-search-migration/rehearsal',
  logStreamName: 'alarm-signals-v1',
  logStreamArn:
    `arn:aws:logs:ap-northeast-1:${account}:log-group:` +
    '/mukuroji/test/workspace-search-migration/rehearsal:' +
    'log-stream:alarm-signals-v1',
}

/** Creates exact alarm-purpose plan claims including the Logs target. */
function createPlanClaims():
WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims {
  return {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND,
    planVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    partition: 'aws',
    account,
    productionAccount,
    region: target.region,
    profile: 'migration-rehearsal',
    commit: 'a'.repeat(40),
    migrationResourceAttestationDigest: createMigrationDigest('resources'),
    configurationHash,
    policyVersion,
    signalEvidenceLocatorDigest:
      createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
        configurationHash,
        policyVersion,
      ),
    signalLogGroupName: target.logGroupName,
    signalLogStreamName: target.logStreamName,
    signalLogStreamArn: target.logStreamArn,
    alarmArns: [
      'throttle',
      'budget-stop',
      'budget-exhaustion',
      'checkpoint-stall',
      'quarantine',
      'terminal-failure',
    ].map((name) =>
      `arn:aws:cloudwatch:ap-northeast-1:${account}:alarm:${name}`),
    primary: {
      queueUrl:
        `https://sqs.ap-northeast-1.amazonaws.com/${account}/alarm-primary`,
      topicArn: `arn:aws:sns:ap-northeast-1:${account}:alarm-primary`,
    },
    secondary: {
      queueUrl:
        `https://sqs.ap-northeast-1.amazonaws.com/${account}/alarm-secondary`,
      topicArn: `arn:aws:sns:ap-northeast-1:${account}:alarm-secondary`,
    },
    authorizedStaleTransitions: [],
    startedAt,
    completedAt,
    receiptMaximumWaitMilliseconds: 60_000,
    historyMaximumWaitMilliseconds: 60_000,
    requestTimeoutMilliseconds: 1_000,
    maximumHistoryPagesPerAlarm: 2,
  }
}

/** Creates one complete plan whose digest covers every exact target claim. */
function createPlan(): WorkspaceSearchMigrationRehearsalAlarmCollectionPlan {
  const claims = createPlanClaims()
  return {
    ...claims,
    requestedResourcesBinding:
      createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(claims),
  }
}

/** Creates one exact existing-recorder EMF line. */
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
  ) throw new Error('Signal fixture failed.')
  return line
}

/** Creates every authenticated fixed-prefix signal artifact. */
function createSignalPrefixes(
  plan: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
): readonly WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact[] {
  const artifacts:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact[] = []
  let previous:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact |
    undefined
  for (const [index, signal] of
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER.entries()) {
    const artifact =
      createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact({
        serializedEmfLine: createSignalLine(
          signal,
          Date.parse(startedAt) + (index * 10_000),
          String(index + 1).repeat(32),
        ),
        authorizationBindingDigest: plan.requestedResourcesBinding,
        evidenceLocatorDigest: plan.signalEvidenceLocatorDigest,
        ...(previous === undefined ? {} : { previousArtifact: previous }),
      }, key)
    artifacts.push(artifact)
    previous = artifact
  }
  return artifacts
}

/** Recording PutLogEvents-only port. */
class RecordingPort
implements WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort {
  /** Every exact accepted request in order. */
  readonly requests: WorkspaceSearchMigrationRehearsalAlarmLogWriteInput[] = []

  /** Records one request without retaining it outside the test. */
  async putLogEvent(
    input: WorkspaceSearchMigrationRehearsalAlarmLogWriteInput,
  ): Promise<void> {
    this.requests.push(input)
  }
}

/** Creates one permit matching the exact alarm-purpose plan. */
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
      deploymentTrustRootDigest: 'e'.repeat(64),
      requestedResourcesBinding: plan.requestedResourcesBinding,
      configurationBindingDigest: configurationHash,
      policyVersion,
      integrityResourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      integrityResourceIdentities,
      integrityResourceIdentityDigest: 'd'.repeat(64),
      evidenceKeyDigest: derivedKeys.runtimeKeyDigest,
      publicationKeyDigest: derivedKeys.publicationKeyDigest,
      integrityAttestationRoot:
        createIntegrityAttestationRootProjection(),
      issuedAt: '2026-08-01T23:55:00.000Z',
      expiresAt: '2026-08-02T01:00:00.000Z',
    },
    signingKey: key,
  })
}

/** Encodes one exact canonical private input fixture. */
function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

describe('alarm log ingestion evidence', () => {
  test('ingests six exact lines once and retains only digest-only target evidence', async () => {
    const plan = createPlan()
    const prefixes = createSignalPrefixes(plan)
    const port = new RecordingPort()
    let previous: WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact |
      undefined
    for (const [index, signalArtifact] of prefixes.entries()) {
      previous = await ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
        signalArtifact,
        ...(previous === undefined ? {} : { previousArtifact: previous }),
        target,
        authorizationBindingDigest: plan.requestedResourcesBinding,
        verificationKey: key,
        requestTimeoutMilliseconds: 1_000,
      }, {
        port,
        clock: () => new Date(
          Date.parse(startedAt) + (index * 10_000) + 1_000,
        ),
      })
    }
    if (previous === undefined) throw new Error('Ingestion fixture is absent.')
    expect(port.requests).toHaveLength(6)
    for (const [index, request] of port.requests.entries()) {
      expect(request.logGroupName).toBe(target.logGroupName)
      expect(request.logStreamName).toBe(target.logStreamName)
      expect(request.message).toBe(
        prefixes[index]?.receipts[index]?.serializedEmfLine,
      )
      expect(request.timestampMilliseconds).toBe(
        prefixes[index]?.receipts[index]?.timestampMilliseconds,
      )
    }
    const bound =
      verifyWorkspaceSearchMigrationRehearsalAlarmIngestionBinding({
        ingestionArtifact: previous,
        signalArtifact: prefixes.at(-1),
        verificationKey: key,
        targetDigest:
          createWorkspaceSearchMigrationRehearsalAlarmIngestionTargetDigest(
            target,
          ),
      })
    expect(bound.receipts).toHaveLength(6)
    const serialized = new TextDecoder().decode(
      serializeWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
        bound,
        key,
      ),
    )
    expect(serialized).not.toContain(account)
    expect(serialized).not.toContain(target.logGroupName)
    expect(serialized).not.toContain(target.logStreamName)
    expect(serialized).not.toContain('CloudWatchMetrics')
  })

  test('rejects replay, skipped prefixes, target drift, and HMAC tampering', async () => {
    const plan = createPlan()
    const prefixes = createSignalPrefixes(plan)
    const port = new RecordingPort()
    const first = await ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
      signalArtifact: prefixes[0],
      target,
      authorizationBindingDigest: plan.requestedResourcesBinding,
      verificationKey: key,
      requestTimeoutMilliseconds: 1_000,
    }, {
      port,
      clock: () => new Date(Date.parse(startedAt) + 1_000),
    })
    await expect(ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
      signalArtifact: prefixes[0],
      previousArtifact: first,
      target,
      authorizationBindingDigest: plan.requestedResourcesBinding,
      verificationKey: key,
      requestTimeoutMilliseconds: 1_000,
    }, { port, clock: () => new Date(Date.parse(startedAt) + 2_000) }))
      .rejects.toBeInstanceOf(
        WorkspaceSearchMigrationRehearsalAlarmIngestionError,
      )
    await expect(ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
      signalArtifact: prefixes[2],
      previousArtifact: first,
      target,
      authorizationBindingDigest: plan.requestedResourcesBinding,
      verificationKey: key,
      requestTimeoutMilliseconds: 1_000,
    }, { port, clock: () => new Date(Date.parse(startedAt) + 21_000) }))
      .rejects.toBeInstanceOf(
        WorkspaceSearchMigrationRehearsalAlarmIngestionError,
      )
    await expect(ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
      signalArtifact: prefixes[1],
      previousArtifact: first,
      target: { ...target, logStreamArn: `${target.logStreamArn}-other` },
      authorizationBindingDigest: plan.requestedResourcesBinding,
      verificationKey: key,
      requestTimeoutMilliseconds: 1_000,
    }, { port, clock: () => new Date(Date.parse(startedAt) + 11_000) }))
      .rejects.toBeInstanceOf(
        WorkspaceSearchMigrationRehearsalAlarmIngestionError,
      )
    expect(() => verifyWorkspaceSearchMigrationRehearsalAlarmIngestionArtifact(
      { ...first, authenticationTag: '0'.repeat(64) },
      key,
    )).toThrow(WorkspaceSearchMigrationRehearsalAlarmIngestionError)
    expect(port.requests).toHaveLength(1)
  })

  test('bounds a stalled PutLogEvents request and never creates a receipt', async () => {
    const plan = createPlan()
    const signalArtifact = createSignalPrefixes(plan)[0]
    const stalled: WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort = {
      putLogEvent: () => new Promise<void>(() => undefined),
    }
    await expect(ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
      signalArtifact,
      target,
      authorizationBindingDigest: plan.requestedResourcesBinding,
      verificationKey: key,
      requestTimeoutMilliseconds: 100,
    }, { port: stalled, clock: () => new Date() }))
      .rejects.toBeInstanceOf(
        WorkspaceSearchMigrationRehearsalAlarmIngestionError,
      )
  })
})

describe('CloudWatch Logs ingestion adapter', () => {
  test('sends one event without sequence token and rejects partial acceptance', async () => {
    const commands: unknown[] = []
    let response: unknown = {}
    const client: WorkspaceSearchMigrationRehearsalCloudWatchLogsClient = {
      send: async (command) => {
        commands.push(command)
        return response
      },
      destroy: () => undefined,
    }
    const port =
      new WorkspaceSearchMigrationRehearsalCloudWatchLogsIngestionPort(client)
    await port.putLogEvent({
      abortSignal: new AbortController().signal,
      logGroupName: target.logGroupName,
      logStreamName: target.logStreamName,
      message: '{"exact":true}',
      timestampMilliseconds: Date.parse(startedAt),
    })
    expect(commands).toHaveLength(1)
    const command = commands[0]
    if (
      typeof command !== 'object' ||
      command === null ||
      !('input' in command)
    ) throw new Error('PutLogEvents command fixture is absent.')
    expect(command.input).toEqual({
      logGroupName: target.logGroupName,
      logStreamName: target.logStreamName,
      logEvents: [{
        message: '{"exact":true}',
        timestamp: Date.parse(startedAt),
      }],
    })
    expect(JSON.stringify(command.input)).not.toContain('sequenceToken')
    response = { rejectedLogEventsInfo: { tooNewLogEventStartIndex: 0 } }
    await expect(port.putLogEvent({
      abortSignal: new AbortController().signal,
      logGroupName: target.logGroupName,
      logStreamName: target.logStreamName,
      message: '{"exact":true}',
      timestampMilliseconds: Date.parse(startedAt),
    })).rejects.toThrow('INGESTION_FAILED')
  })
})

describe('alarm ingestion CLI', () => {
  /** Creates canonical arguments using harmless distinct fixture paths. */
  function createArguments(previousFile?: string): readonly string[] {
    return [
      '--approval',
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_INGESTION_APPROVAL,
      '--plan-file',
      '/private/plan.json',
      '--permit-file',
      '/private/permit.json',
      '--permit-key-file',
      '/private/key.bin',
      '--signal-receipt-file',
      '/private/signal.json',
      ...(previousFile === undefined
        ? []
        : ['--previous-ingestion-receipt-file', previousFile]),
      '--output-file',
      '/private/output.json',
    ]
  }

  test('parses only explicit distinct paths and the exact approval', () => {
    const parsed =
      parseWorkspaceSearchMigrationRehearsalAlarmIngestionCliArguments(
        createArguments(),
      )
    expect(parsed.outputFile).toBe('/private/output.json')
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalAlarmIngestionCliArguments([
        ...createArguments().slice(0, -2),
        '--output-file',
        '/private/plan.json',
      ])).toThrow('INVALID_USAGE')
  })

  test('authenticates plan and permit before one exact ingest and emits digests only', async () => {
    const plan = createPlan()
    const signalArtifact = createSignalPrefixes(plan)[0]
    const permit = createPermit(plan)
    const files = new Map<string, Uint8Array>([
      [resolve('/private/plan.json'), encode(plan)],
      [resolve('/private/permit.json'), encode(permit)],
      [resolve('/private/signal.json'), encode(signalArtifact)],
    ])
    const output: Uint8Array[] = []
    const stdout: string[] = []
    const stderr: string[] = []
    let runtimeCreated = 0
    const dependencies:
      WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies = {
        readPrivateInputFile: async (path) => {
          const bytes = files.get(path)
          if (bytes === undefined) throw new Error('MISSING')
          return new Uint8Array(bytes)
        },
        readPermitKeyFile: async () => new Uint8Array(masterKey),
        ensureOutputAbsent: async () => undefined,
        createAwsRuntime: async (input) => {
          runtimeCreated += 1
          expect(input.plan.signalLogStreamArn).toBe(target.logStreamArn)
          expect(input.permit.commit).toBe(plan.commit)
          return {
            port: new RecordingPort(),
            close: () => undefined,
          }
        },
        writeOutputFileExclusive: async (_path, bytes) => {
          output.push(new Uint8Array(bytes))
          return 'created'
        },
        clock: () => new Date('2026-08-02T00:01:00.000Z'),
        writeStdoutLine: (line) => stdout.push(line),
        writeStderrLine: (line) => stderr.push(line),
      }
    expect(await runWorkspaceSearchMigrationRehearsalAlarmIngestionCli(
      createArguments(),
      dependencies,
    )).toBe(0)
    expect(runtimeCreated).toBe(1)
    expect(output).toHaveLength(1)
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual([])
    expect(stdout[0]).not.toContain(account)
    expect(stdout[0]).not.toContain(target.logGroupName)
    expect(stdout[0]).not.toContain('CloudWatchMetrics')
  })

  test('rejects an existing output before STS or PutLogEvents', async () => {
    let runtimeCreated = 0
    const stderr: string[] = []
    const dependencies:
      WorkspaceSearchMigrationRehearsalAlarmIngestionCliDependencies = {
        readPrivateInputFile: async () => new Uint8Array([1]),
        readPermitKeyFile: async () => new Uint8Array(masterKey),
        ensureOutputAbsent: async () => {
          throw new Error('EXISTS')
        },
        createAwsRuntime: async () => {
          runtimeCreated += 1
          throw new Error('UNREACHABLE')
        },
        writeOutputFileExclusive: async () => 'created',
        clock: () => new Date(),
        writeStdoutLine: () => undefined,
        writeStderrLine: (line) => stderr.push(line),
      }
    expect(await runWorkspaceSearchMigrationRehearsalAlarmIngestionCli(
      createArguments(),
      dependencies,
    )).toBe(1)
    expect(runtimeCreated).toBe(0)
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).not.toContain('/private/output.json')
  })

  test('writes canonical ingestion receipts with exclusive mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alarm-ingestion-'))
    const outputPath = join(directory, 'receipt.json')
    try {
      const outcome =
        await writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
          outputPath,
          encode({ digest: 'a'.repeat(64), status: 'succeeded' }),
        )
      expect(outcome).toBe('created')
      expect((await stat(outputPath)).mode & 0o7777).toBe(0o600)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
