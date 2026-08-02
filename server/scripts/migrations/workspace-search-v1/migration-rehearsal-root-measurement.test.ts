import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import {
  consumeWorkspaceSearchMigrationRehearsalRootMeasurement,
  measureWorkspaceSearchMigrationRehearsalRootConfiguration,
  WorkspaceSearchMigrationRehearsalRootMeasurementError,
  type WorkspaceSearchMigrationRehearsalRootMeasurementPort,
} from './migration-rehearsal-root-measurement'

/** Stable reviewed policy used by the root measurement fixture. */
const policyVersion = createMigrationDigest('root-measurement-policy')

/** Optional cumulative rate values used by one fixture snapshot. */
type RateEvidenceOptions = {
  /** Stable policy digest override. */
  readonly policyVersion?: string
  /** Interrupted-attempt forfeiture count. */
  readonly forfeitedAttemptCount?: number
  /** Throttled attempt count. */
  readonly throttleCount?: number
  /** Fail-closed budget stop count. */
  readonly budgetStopCount?: number
  /** Cadence wait count. */
  readonly cadenceWaitCount?: number
  /** Total cadence wait milliseconds. */
  readonly cadenceWaitMilliseconds?: number
  /** Maximum charged in-flight count. */
  readonly maximumInFlight?: 0 | 1
}

/** Optional behavior supplied to one recording root port. */
type RootPortFixtureOptions = {
  /** Exact object returned by configuration measurement. */
  readonly configuration?: WorkspaceSearchMigrationConfiguration
  /** Initial cumulative rate snapshot. */
  readonly before?: WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Post-measurement cumulative rate snapshot. */
  readonly after?: WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Raw private failure raised by the measurement method. */
  readonly measurementError?: Error
}

/** Recording narrow port plus its exact call counters. */
type RootPortFixture = {
  /** Exact trusted two-method port. */
  readonly port: WorkspaceSearchMigrationRehearsalRootMeasurementPort
  /** Exact object returned by the port. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reads the number of configuration measurements. */
  readonly readMeasurementCalls: () => number
  /** Reads the number of durable aggregate snapshots. */
  readonly readRateCalls: () => number
}

describe('migration rehearsal causal root measurement', () => {
  test('binds the exact initial six-call measurement and consumes it once', async () => {
    const fixture = createRootPortFixture({
      after: rateEvidence(6, {
        cadenceWaitCount: 6,
        cadenceWaitMilliseconds: 30,
      }),
    })
    const expectedConfigurationBindingDigest =
      createWorkspaceSearchConfigurationHash(fixture.configuration)

    const measured =
      await measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: fixture.port,
        expectedConfigurationBindingDigest,
      })

    expect(measured.configuration).toBe(fixture.configuration)
    expect(fixture.readMeasurementCalls()).toBe(1)
    expect(fixture.readRateCalls()).toBe(2)
    expect(
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        measured.capability,
        measured.configuration,
      ),
    ).toEqual({
      kind: 'mukuroji-workspace-search-migration-rehearsal-root-measurement',
      version: 1,
      firstAttemptSequence: 1,
      lastAttemptSequence: 6,
      configurationBindingDigest: expectedConfigurationBindingDigest,
      policyVersion,
    })
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        measured.capability,
        measured.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
  })

  test('rejects capability clones, result substitution, and result mutation', async () => {
    const cloneFixture = createRootPortFixture()
    const cloneMeasurement =
      await measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: cloneFixture.port,
        expectedConfigurationBindingDigest:
          createWorkspaceSearchConfigurationHash(cloneFixture.configuration),
      })
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        structuredClone(cloneMeasurement.capability),
        cloneMeasurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
    expect(
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        cloneMeasurement.capability,
        cloneMeasurement.configuration,
      ).lastAttemptSequence,
    ).toBe(6)

    const substitutionFixture = createRootPortFixture()
    const substitutionMeasurement =
      await measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: substitutionFixture.port,
        expectedConfigurationBindingDigest:
          createWorkspaceSearchConfigurationHash(
            substitutionFixture.configuration,
          ),
      })
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        substitutionMeasurement.capability,
        structuredClone(substitutionMeasurement.configuration),
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        substitutionMeasurement.capability,
        substitutionMeasurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')

    const mutationFixture = createRootPortFixture()
    const mutationMeasurement =
      await measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: mutationFixture.port,
        expectedConfigurationBindingDigest:
          createWorkspaceSearchConfigurationHash(
            mutationFixture.configuration,
          ),
      })
    mutationMeasurement.configuration.profile = 'mutated-profile'
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        mutationMeasurement.capability,
        mutationMeasurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
    mutationMeasurement.configuration.profile = 'rehearsal-operator'
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        mutationMeasurement.capability,
        mutationMeasurement.configuration,
      )
    ).toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
  })

  test('replaces hostile post-measurement object mutation with the stable error', async () => {
    const fixture = createRootPortFixture()
    const measured =
      await measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: fixture.port,
        expectedConfigurationBindingDigest:
          createWorkspaceSearchConfigurationHash(fixture.configuration),
      })
    Object.defineProperty(measured.configuration, 'cycle', {
      enumerable: true,
      value: measured.configuration,
    })

    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        measured.capability,
        measured.configuration,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalRootMeasurementError)
  })

  test('does not measure unless the root attempt count starts at zero', async () => {
    const fixture = createRootPortFixture({ before: rateEvidence(1) })

    await expect(
      measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: fixture.port,
        expectedConfigurationBindingDigest:
          createWorkspaceSearchConfigurationHash(fixture.configuration),
      }),
    ).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalRootMeasurementError,
    )
    expect(fixture.readMeasurementCalls()).toBe(0)
    expect(fixture.readRateCalls()).toBe(1)
  })

  for (const dirtyBefore of [
    {
      label: 'forfeited attempt',
      evidence: rateEvidence(0, { forfeitedAttemptCount: 1 }),
    },
    {
      label: 'throttled attempt',
      evidence: rateEvidence(0, { throttleCount: 1 }),
    },
    {
      label: 'budget stop',
      evidence: rateEvidence(0, { budgetStopCount: 1 }),
    },
    {
      label: 'cadence wait',
      evidence: rateEvidence(0, {
        cadenceWaitCount: 1,
        cadenceWaitMilliseconds: 1,
      }),
    },
    {
      label: 'in-flight observation',
      evidence: rateEvidence(0, { maximumInFlight: 1 }),
    },
  ]) {
    test(`rejects prior ${dirtyBefore.label} on a zero-attempt root ledger`, async () => {
      const fixture = createRootPortFixture({
        before: dirtyBefore.evidence,
      })

      await expect(
        measureWorkspaceSearchMigrationRehearsalRootConfiguration({
          port: fixture.port,
          expectedConfigurationBindingDigest:
            createWorkspaceSearchConfigurationHash(fixture.configuration),
        }),
      ).rejects.toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
      expect(fixture.readMeasurementCalls()).toBe(0)
      expect(fixture.readRateCalls()).toBe(1)
    })
  }

  for (const drift of [
    {
      label: 'five attempts',
      after: rateEvidence(5),
    },
    {
      label: 'seven attempts',
      after: rateEvidence(7),
    },
    {
      label: 'policy replacement',
      after: rateEvidence(6, {
        policyVersion: createMigrationDigest('replacement-policy'),
      }),
    },
    {
      label: 'forfeited attempt',
      after: rateEvidence(6, { forfeitedAttemptCount: 1 }),
    },
    {
      label: 'throttled attempt',
      after: rateEvidence(6, { throttleCount: 1 }),
    },
    {
      label: 'budget stop',
      after: rateEvidence(6, { budgetStopCount: 1 }),
    },
    {
      label: 'missing in-flight observation',
      after: rateEvidence(6, { maximumInFlight: 0 }),
    },
  ]) {
    test(`rejects ${drift.label} in the measured rate delta`, async () => {
      const fixture = createRootPortFixture({ after: drift.after })

      await expect(
        measureWorkspaceSearchMigrationRehearsalRootConfiguration({
          port: fixture.port,
          expectedConfigurationBindingDigest:
            createWorkspaceSearchConfigurationHash(fixture.configuration),
        }),
      ).rejects.toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
      expect(fixture.readMeasurementCalls()).toBe(1)
      expect(fixture.readRateCalls()).toBe(2)
    })
  }

  test('rejects configuration substitution after the exact six calls', async () => {
    const fixture = createRootPortFixture()

    await expect(
      measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: fixture.port,
        expectedConfigurationBindingDigest:
          createMigrationDigest('different-configuration'),
      }),
    ).rejects.toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
    expect(fixture.readMeasurementCalls()).toBe(1)
    expect(fixture.readRateCalls()).toBe(2)
  })

  test('accepts only exact own-data input and narrow-port fields', async () => {
    const fixture = createRootPortFixture()
    const expectedConfigurationBindingDigest =
      createWorkspaceSearchConfigurationHash(fixture.configuration)
    const accessorInput = Object.create(null)
    Object.defineProperty(accessorInput, 'port', {
      enumerable: true,
      get: () => fixture.port,
    })
    Object.defineProperty(
      accessorInput,
      'expectedConfigurationBindingDigest',
      {
        enumerable: true,
        value: expectedConfigurationBindingDigest,
      },
    )

    await expect(
      measureWorkspaceSearchMigrationRehearsalRootConfiguration(
        accessorInput,
      ),
    ).rejects.toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
    await expect(
      measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: {
          ...fixture.port,
          close: (): void => {},
        },
        expectedConfigurationBindingDigest,
      }),
    ).rejects.toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
    await expect(
      measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: new Proxy(fixture.port, {}),
        expectedConfigurationBindingDigest,
      }),
    ).rejects.toThrow('INVALID_REHEARSAL_ROOT_MEASUREMENT')
    expect(fixture.readMeasurementCalls()).toBe(0)
    expect(fixture.readRateCalls()).toBe(0)
  })

  test('replaces raw port failures with the stable public error', async () => {
    const fixture = createRootPortFixture({
      measurementError: new Error('private-measurement-canary'),
    })

    let failure: unknown
    try {
      await measureWorkspaceSearchMigrationRehearsalRootConfiguration({
        port: fixture.port,
        expectedConfigurationBindingDigest:
          createWorkspaceSearchConfigurationHash(fixture.configuration),
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalRootMeasurementError,
    )
    expect(String(failure)).not.toContain('private-measurement-canary')
  })
})

/** Creates one cumulative strict rate snapshot. */
function rateEvidence(
  attemptCount: number,
  options: RateEvidenceOptions = {},
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  return Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion: options.policyVersion ?? policyVersion,
    attemptCount,
    forfeitedAttemptCount: options.forfeitedAttemptCount ?? 0,
    throttleCount: options.throttleCount ?? 0,
    awsServiceThrottleCount: options.throttleCount ?? 0,
    rehearsalInjectedThrottleCount: 0,
    budgetStopCount: options.budgetStopCount ?? 0,
    operationalBudgetStopCount: options.budgetStopCount ?? 0,
    awsServiceThrottleBudgetStopCount: 0,
    rehearsalInjectedBudgetStopCount: 0,
    cadenceWaitCount: options.cadenceWaitCount ?? 0,
    cadenceWaitMilliseconds: options.cadenceWaitMilliseconds ?? 0,
    maximumInFlight: options.maximumInFlight ?? (attemptCount === 0 ? 0 : 1),
  })
}

/** Creates one recording exact two-method root port. */
function createRootPortFixture(
  options: RootPortFixtureOptions = {},
): RootPortFixture {
  const configuration = options.configuration ?? createConfiguration()
  const before = options.before ?? rateEvidence(0)
  const after = options.after ?? rateEvidence(6)
  let measurementCalls = 0
  let rateCalls = 0
  const port = Object.freeze({
    measureConfiguration: async () => {
      measurementCalls += 1
      if (options.measurementError !== undefined) {
        throw options.measurementError
      }
      return configuration
    },
    readDescribeTableRateEvidence: () => {
      rateCalls += 1
      return rateCalls === 1 ? before : after
    },
  }) satisfies WorkspaceSearchMigrationRehearsalRootMeasurementPort
  return Object.freeze({
    port,
    configuration,
    readMeasurementCalls: () => measurementCalls,
    readRateCalls: () => rateCalls,
  })
}

/** Creates one complete configuration for causal-reference tests. */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'rehearsal-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/MigrationOperator/rehearsal',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createTable('project-directory'),
      'work-items': createTable('work-items'),
      collaboration: createTable('collaboration'),
      documents: createTable('documents'),
      'workspace-search': createTable('workspace-search'),
      'migration-state': createTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-rehearsal-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-rehearsal-access-logs',
      accessLogPrefix: 'workspace-search/v1/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/** Creates one complete table identity for the measured configuration. */
function createTable(
  role: MigrationTableIdentity['role'],
): MigrationTableIdentity {
  const key: readonly MigrationKeyAttribute[] = Object.freeze([
    Object.freeze({
      name: `${role}Id`,
      role: 'HASH',
      type: 'S',
    }),
  ])
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: role === 'workspace-search' ||
      role === 'migration-state',
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest(`${role}-kms-key`),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-31T00:00:00.000Z',
    },
  }
}
