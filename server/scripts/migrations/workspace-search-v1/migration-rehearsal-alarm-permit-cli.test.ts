import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
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
  createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION,
  type WorkspaceSearchMigrationRehearsalAlarmCollectionPlan,
  type WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims,
} from './migration-rehearsal-alarm-evidence-cli'
import {
  parseWorkspaceSearchMigrationRehearsalAlarmPermitCliArguments,
  runWorkspaceSearchMigrationRehearsalAlarmPermitCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_CLI_RESULT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_ISSUANCE_APPROVAL,
  type WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies,
} from './migration-rehearsal-alarm-permit-cli'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalPermit,
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  createWorkspaceSearchMigrationRehearsalResourceAttestationDigest,
  verifyWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationRehearsalPermit,
} from './migration-rehearsal-permit'
import {
  createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest,
} from './migration-telemetry-rehearsal'

/** Isolated account used by the alarm-purpose issuer fixture. */
const account = '111122223333'

/** Distinct unreachable production account used by the fixture. */
const productionAccount = '999900001111'

/** Exact reviewed implementation commit. */
const commit = 'a'.repeat(40)

/** Main measured configuration digest. */
const configurationHash = 'b'.repeat(64)

/** Reviewed DescribeTable policy digest. */
const policyVersion = 'c'.repeat(64)

/** Main requested-resource binding inherited from root measurement. */
const mainRequestedResourcesBinding = 'd'.repeat(64)

/** Source-controlled deployment trust-root digest. */
const deploymentTrustRootDigest = 'e'.repeat(64)

/** Exact main permit issue time. */
const mainIssuedAt = '2026-08-01T23:55:00.000Z'

/** Exact alarm permit issuance clock. */
const alarmIssuedAt = '2026-08-01T23:59:59.000Z'

/** Exact alarm evidence window start. */
const planStartedAt = '2026-08-02T00:00:00.000Z'

/** Exact alarm recovery window completion. */
const planCompletedAt = '2026-08-02T00:01:30.000Z'

/** Exact main and alarm permit expiry. */
const permitExpiresAt = '2026-08-02T03:00:00.000Z'

/** Restricted main rehearsal master key. */
const mainMasterKey = new Uint8Array(32).fill(7)

/** Restricted distinct alarm-purpose master key. */
const alarmMasterKey = new Uint8Array(32).fill(8)

/** Exact CLI fixture paths. */
const paths = Object.freeze({
  alarmPlan: '/private/alarm-plan.json',
  mainPermit: '/private/main-permit.json',
  mainKey: '/private/main.key',
  alarmKey: '/private/alarm.key',
  output: '/private/alarm-permit.json',
})

/** Canonical keyed immutable resource identities retained by the main permit. */
const integrityResourceIdentities = Object.freeze(
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
    Object.freeze({
      target,
      identityDigest: createMigrationDigest({ index, target }),
    })
  ),
)

/** Creates one structurally strict authenticated-root projection. */
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
    deploymentTargetId: 'test-rehearsal',
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    configurationBindingDigest: configurationHash,
    policyVersion,
    attestation: {
      contentMac: createMigrationDigest('root-attestation'),
      byteLength: 1_024,
    },
    segment: {
      authenticationKeyFingerprint: createMigrationDigest('root-key'),
      segmentLocatorDigest: createMigrationDigest('root-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac: createMigrationDigest('root-terminal'),
      segmentDigest: createMigrationDigest('root-segment'),
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
        (_entry, index) => index + 13,
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: rootStartedAt,
      completedAt: rootCompletedAt,
    },
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac: createMigrationDigest('root-table-order'),
    rootMac: createMigrationDigest('root'),
    startedAt: rootStartedAt,
    completedAt: rootCompletedAt,
  })
}

/** Creates one authentic main permit under the main derived runtime key. */
function createMainPermit(
  input: {
    /** Optional caller ARN used to exercise partition isolation. */
    readonly callerArn?: string
    /** Optional deployment trust-root digest override. */
    readonly deploymentTrustRootDigest?: string
    /** Optional purpose-specific expiry override. */
    readonly expiresAt?: string
    /** Optional signing master used to create a foreign permit. */
    readonly signingMasterKey?: Uint8Array
  } = {},
): WorkspaceSearchMigrationRehearsalPermit {
  const signingMasterKey = input.signingMasterKey ?? mainMasterKey
  const keys = deriveWorkspaceSearchMigrationRehearsalKeys(signingMasterKey)
  try {
    return createWorkspaceSearchMigrationRehearsalPermit({
      claims: {
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
        permitVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
        stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
        approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
        account,
        productionAccount,
        region: 'ap-northeast-1',
        callerArn: input.callerArn ??
          (`arn:aws:sts::${account}:assumed-role/` +
            'MigrationRehearsal/alarm-evidence'),
        commit,
        deploymentTargetId: 'test-rehearsal',
        deploymentTrustRootDigest:
          input.deploymentTrustRootDigest ?? deploymentTrustRootDigest,
        requestedResourcesBinding: mainRequestedResourcesBinding,
        configurationBindingDigest: configurationHash,
        policyVersion,
        integrityResourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        integrityResourceIdentities,
        integrityResourceIdentityDigest:
          createMigrationDigest(integrityResourceIdentities),
        evidenceKeyDigest: keys.runtimeKeyDigest,
        publicationKeyDigest: keys.publicationKeyDigest,
        integrityAttestationRoot:
          createIntegrityAttestationRootProjection(),
        issuedAt: mainIssuedAt,
        expiresAt: input.expiresAt ?? permitExpiresAt,
      },
      signingKey: keys.runtimeKey,
    })
  } finally {
    zeroizeWorkspaceSearchMigrationRehearsalKey(keys.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(keys.publicationKey)
  }
}

/** Creates strict alarm plan claims tied to the main resource session. */
function createPlanClaims(
  input: {
    /** Optional main-session resource digest override. */
    readonly migrationResourceAttestationDigest?: string
    /** Optional receipt wait used to exercise the capture runway. */
    readonly receiptMaximumWaitMilliseconds?: number
  } = {},
): WorkspaceSearchMigrationRehearsalAlarmCollectionPlanClaims {
  const alarmNames = [
    'test-WorkspaceSearchMigrationDescribeTableThrottleAlarm',
    'test-WorkspaceSearchMigrationDescribeTableBudgetStopAlarm',
    'test-WorkspaceSearchMigrationRateBudgetExhaustionAlarm',
    'test-WorkspaceSearchMigrationCheckpointStallAlarm',
    'test-WorkspaceSearchMigrationQuarantineAlarm',
    'test-WorkspaceSearchMigrationTerminalFailureAlarm',
  ]
  return {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_KIND,
    planVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PLAN_VERSION,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    partition: 'aws',
    account,
    productionAccount,
    region: 'ap-northeast-1',
    profile: 'migration-rehearsal',
    commit,
    migrationResourceAttestationDigest:
      input.migrationResourceAttestationDigest ??
      createWorkspaceSearchMigrationRehearsalResourceAttestationDigest({
        configurationHash,
        deploymentTrustRootDigest,
        productionAccount,
        requestedResourcesBinding: mainRequestedResourcesBinding,
      }),
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
    alarmArns: alarmNames.map((name) =>
      `arn:aws:cloudwatch:ap-northeast-1:${account}:alarm:${name}`),
    authorizedStaleTransitions: [],
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
    startedAt: planStartedAt,
    completedAt: planCompletedAt,
    receiptMaximumWaitMilliseconds:
      input.receiptMaximumWaitMilliseconds ?? 60_000,
    historyMaximumWaitMilliseconds: 10_000,
    requestTimeoutMilliseconds: 1_000,
    maximumHistoryPagesPerAlarm: 2,
  }
}

/** Creates one complete alarm plan with its exact claims binding. */
function createPlan(
  input: {
    /** Optional main-session resource digest override. */
    readonly migrationResourceAttestationDigest?: string
    /** Optional receipt wait used to exercise the capture runway. */
    readonly receiptMaximumWaitMilliseconds?: number
  } = {},
): WorkspaceSearchMigrationRehearsalAlarmCollectionPlan {
  const claims = createPlanClaims(input)
  return Object.freeze({
    ...claims,
    requestedResourcesBinding:
      createWorkspaceSearchMigrationRehearsalAlarmPlanBinding(claims),
  })
}

/** Serializes one exact canonical private input. */
function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/** Creates the sole exact CLI invocation used by the test harness. */
function createArguments(): string[] {
  return [
    '--alarm-plan-file',
    paths.alarmPlan,
    '--main-permit-file',
    paths.mainPermit,
    '--main-authentication-key-file',
    paths.mainKey,
    '--alarm-authentication-key-file',
    paths.alarmKey,
    '--output-file',
    paths.output,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_ISSUANCE_APPROVAL,
  ]
}

/** Creates finite in-memory private I/O for one CLI invocation. */
function createHarness(
  input: {
    /** Optional alarm plan override. */
    readonly plan?: WorkspaceSearchMigrationRehearsalAlarmCollectionPlan
    /** Optional authenticated main permit override. */
    readonly mainPermit?: WorkspaceSearchMigrationRehearsalPermit
    /** Optional alarm master-key override. */
    readonly alarmKey?: Uint8Array
    /** Optional trusted issuance time override. */
    readonly currentTime?: string
    /** Optional durable writer outcome. */
    readonly writeOutcome?:
      | 'created'
      | 'exists'
      | 'reconciled'
  } = {},
) {
  const plan = input.plan ?? createPlan()
  const mainPermit = input.mainPermit ?? createMainPermit()
  const alarmKey = input.alarmKey ?? alarmMasterKey
  const privateInputs = new Map<string, Uint8Array>([
    [paths.alarmPlan, canonicalBytes(plan)],
    [paths.mainPermit, canonicalBytes(mainPermit)],
  ])
  const keys = new Map<string, Uint8Array>([
    [paths.mainKey, mainMasterKey],
    [paths.alarmKey, alarmKey],
  ])
  const stdout: string[] = []
  const stderr: string[] = []
  const writes: Uint8Array[] = []
  const ownedBuffers: Uint8Array[] = []
  const dependencies:
    WorkspaceSearchMigrationRehearsalAlarmPermitCliDependencies = {
      readPrivateInputFile: async (path, maximumBytes) => {
        const bytes = privateInputs.get(path)
        if (bytes === undefined || bytes.byteLength > maximumBytes) {
          throw new Error('INPUT_FILE_INVALID')
        }
        const owned = Uint8Array.from(bytes)
        ownedBuffers.push(owned)
        return owned
      },
      readAuthenticationKeyFile: async (path) => {
        const key = keys.get(path)
        if (key === undefined) throw new Error('AUTHENTICATION_FAILED')
        const owned = Uint8Array.from(key)
        ownedBuffers.push(owned)
        return owned
      },
      writePermitFileExclusive: async (_path, bytes) => {
        ownedBuffers.push(bytes)
        writes.push(Uint8Array.from(bytes))
        return input.writeOutcome ?? 'created'
      },
      clock: () => new Date(input.currentTime ?? alarmIssuedAt),
      writeStdoutLine: (line) => stdout.push(line),
      writeStderrLine: (line) => stderr.push(line),
    }
  return Object.freeze({
    dependencies,
    mainPermit,
    ownedBuffers,
    plan,
    stderr,
    stdout,
    writes,
  })
}

describe('workspace search migration rehearsal alarm permit CLI', () => {
  test('parses only the exact ordered distinct command', () => {
    expect(
      parseWorkspaceSearchMigrationRehearsalAlarmPermitCliArguments(
        createArguments(),
      ),
    ).toEqual({
      alarmPlanFile: paths.alarmPlan,
      mainPermitFile: paths.mainPermit,
      mainAuthenticationKeyFile: paths.mainKey,
      alarmAuthenticationKeyFile: paths.alarmKey,
      outputFile: paths.output,
      approval:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_ISSUANCE_APPROVAL,
    })
    const reordered = createArguments()
    ;[reordered[0], reordered[2]] = [reordered[2], reordered[0]]
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalAlarmPermitCliArguments(
        reordered,
      )
    ).toThrow('INVALID_USAGE')
    const extraKeyArguments = createArguments()
    Object.defineProperty(extraKeyArguments, Symbol('extra'), {
      value: true,
    })
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalAlarmPermitCliArguments(
        extraKeyArguments,
      )
    ).toThrow('INVALID_USAGE')
    const duplicatePathArguments = createArguments()
    duplicatePathArguments[9] = paths.mainPermit
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalAlarmPermitCliArguments(
        duplicatePathArguments,
      )
    ).toThrow('INVALID_USAGE')
  })

  test('issues a distinct alarm permit bound to the main session and plan', async () => {
    const harness = createHarness()
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      harness.dependencies,
    )).toBe(0)
    expect(harness.writes).toHaveLength(1)
    const bytes = harness.writes[0]
    if (bytes === undefined) throw new Error('Missing permit bytes.')
    const alarmKeys = deriveWorkspaceSearchMigrationRehearsalKeys(
      alarmMasterKey,
    )
    try {
      const document: unknown = JSON.parse(new TextDecoder().decode(bytes))
      const permit = verifyWorkspaceSearchMigrationRehearsalPermit({
        permit: document,
        verificationKey: alarmKeys.runtimeKey,
        account,
        region: 'ap-northeast-1',
        commit,
        requestedResourcesBinding: harness.plan.requestedResourcesBinding,
        currentTime: new Date(alarmIssuedAt),
      })
      expect(permit.issuedAt).toBe(alarmIssuedAt)
      expect(permit.expiresAt).toBe(permitExpiresAt)
      expect(permit.requestedResourcesBinding).toBe(
        harness.plan.requestedResourcesBinding,
      )
      expect(permit.evidenceKeyDigest).toBe(alarmKeys.runtimeKeyDigest)
      expect(permit.publicationKeyDigest).toBe(
        alarmKeys.publicationKeyDigest,
      )
      expect(permit.integrityAttestationRoot).toEqual(
        harness.mainPermit.integrityAttestationRoot,
      )
      const expectedShared =
        createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
          harness.mainPermit,
          harness.plan.migrationResourceAttestationDigest,
        )
      expect(
        createWorkspaceSearchMigrationRehearsalAlarmSharedSessionBinding(
          permit,
          harness.plan.migrationResourceAttestationDigest,
        ),
      ).toBe(expectedShared)
      expect(harness.stdout).toEqual([
        serializeCanonicalJson({
          alarmPlanBinding: harness.plan.requestedResourcesBinding,
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_CLI_RESULT_KIND,
          permitDigest: createHash('sha256').update(bytes).digest('hex'),
          sharedSessionBindingDigest: expectedShared,
          status: 'succeeded',
        }),
      ])
      expect(harness.stdout[0]).not.toContain(account)
      expect(harness.stdout[0]).not.toContain(paths.output)
      expect(harness.stderr).toEqual([])
      expect(harness.ownedBuffers.length).toBeGreaterThan(0)
      expect(harness.ownedBuffers.every((bytes) =>
        bytes.every((byte) => byte === 0)
      )).toBe(true)
    } finally {
      zeroizeWorkspaceSearchMigrationRehearsalKey(alarmKeys.runtimeKey)
      zeroizeWorkspaceSearchMigrationRehearsalKey(
        alarmKeys.publicationKey,
      )
    }
  })

  test('classifies a foreign main permit key as authentication failure', async () => {
    const harness = createHarness({
      mainPermit: createMainPermit({
        signingMasterKey: new Uint8Array(32).fill(9),
      }),
    })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      harness.dependencies,
    )).toBe(1)
    expect(harness.stderr).toEqual([serializeCanonicalJson({
      code: 'AUTHENTICATION_FAILED',
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_PERMIT_CLI_RESULT_KIND,
      status: 'error',
    })])
    expect(harness.writes).toEqual([])
  })

  test('rejects reused main and alarm key material before publication', async () => {
    const harness = createHarness({ alarmKey: mainMasterKey })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      harness.dependencies,
    )).toBe(1)
    expect(harness.stderr[0]).toContain('AUTHENTICATION_FAILED')
    expect(harness.writes).toEqual([])
  })

  test('rejects an alarm plan detached from the main resource session', async () => {
    const harness = createHarness({
      plan: createPlan({
        migrationResourceAttestationDigest: 'f'.repeat(64),
      }),
    })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      harness.dependencies,
    )).toBe(2)
    expect(harness.stderr[0]).toContain('INVALID_PLAN')
    expect(harness.writes).toEqual([])
  })

  test('rejects caller partition and deployment trust-root drift', async () => {
    const partitionDrift = createHarness({
      mainPermit: createMainPermit({
        callerArn:
          `arn:aws-us-gov:sts::${account}:assumed-role/` +
          'MigrationRehearsal/alarm-evidence',
      }),
    })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      partitionDrift.dependencies,
    )).toBe(2)
    expect(partitionDrift.stderr[0]).toContain('INVALID_PLAN')

    const trustRootDrift = createHarness({
      mainPermit: createMainPermit({
        deploymentTrustRootDigest: 'f'.repeat(64),
      }),
    })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      trustRootDrift.dependencies,
    )).toBe(2)
    expect(trustRootDrift.stderr[0]).toContain('INVALID_PLAN')
  })

  test('rejects retrospective issuance and insufficient finalize runway', async () => {
    const retrospective = createHarness({
      currentTime: '2026-08-02T00:00:00.001Z',
    })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      retrospective.dependencies,
    )).toBe(2)
    expect(retrospective.stderr[0]).toContain('INVALID_PLAN')

    const shortPermit = createHarness({
      mainPermit: createMainPermit({
        expiresAt: '2026-08-02T00:01:40.000Z',
      }),
    })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      shortPermit.dependencies,
    )).toBe(2)
    expect(shortPermit.stderr[0]).toContain('INVALID_PLAN')

    const insufficientCaptureRunway = createHarness({
      plan: createPlan({ receiptMaximumWaitMilliseconds: 90_000 }),
    })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      insufficientCaptureRunway.dependencies,
    )).toBe(2)
    expect(insufficientCaptureRunway.stderr[0]).toContain('INVALID_PLAN')
  })

  test('rejects accessor and extra dependency surfaces without invoking them', async () => {
    const accessorHarness = createHarness()
    let accessorReadCount = 0
    Object.defineProperty(accessorHarness.dependencies, 'clock', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReadCount += 1
        return (): Date => new Date(alarmIssuedAt)
      },
    })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      accessorHarness.dependencies,
    )).toBe(1)
    expect(accessorReadCount).toBe(0)
    expect(accessorHarness.stderr).toEqual([])

    const extraHarness = createHarness()
    const extraDependencies = {
      ...extraHarness.dependencies,
      extra: (): void => undefined,
    }
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      extraDependencies,
    )).toBe(1)
    expect(extraHarness.stderr).toEqual([])
  })

  test('rejects output collisions without reporting a false success', async () => {
    const harness = createHarness({ writeOutcome: 'exists' })
    expect(await runWorkspaceSearchMigrationRehearsalAlarmPermitCli(
      createArguments(),
      harness.dependencies,
    )).toBe(1)
    expect(harness.stdout).toEqual([])
    expect(harness.stderr[0]).toContain('OUTPUT_FILE_EXISTS')
  })
})

describe('workspace search migration rehearsal resource attestation digest', () => {
  test('rejects accessor, inherited, Proxy, and extra-key inputs', () => {
    const valid = {
      configurationHash,
      deploymentTrustRootDigest,
      productionAccount,
      requestedResourcesBinding: mainRequestedResourcesBinding,
    }
    const accessor = { ...valid }
    let accessorReadCount = 0
    Object.defineProperty(accessor, 'configurationHash', {
      enumerable: true,
      get: () => {
        accessorReadCount += 1
        return configurationHash
      },
    })
    expect(() =>
      createWorkspaceSearchMigrationRehearsalResourceAttestationDigest(
        accessor,
      )
    ).toThrow()
    expect(accessorReadCount).toBe(0)
    expect(() =>
      createWorkspaceSearchMigrationRehearsalResourceAttestationDigest(
        Object.create(valid),
      )
    ).toThrow()
    expect(() =>
      createWorkspaceSearchMigrationRehearsalResourceAttestationDigest(
        new Proxy(valid, {}),
      )
    ).toThrow()
    const extra = { ...valid, extra: true }
    expect(() =>
      createWorkspaceSearchMigrationRehearsalResourceAttestationDigest(
        extra,
      )
    ).toThrow()
  })
})
