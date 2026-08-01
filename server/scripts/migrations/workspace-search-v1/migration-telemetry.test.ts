import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRateRecorder,
  type WorkspaceSearchMigrationDescribeTableRateStopReason,
} from './migration-describe-table-rate-budget'
import {
  createWorkspaceSearchMigrationCheckpointStallWatchdog,
  createWorkspaceSearchMigrationTelemetryRecorder,
  WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
  type WorkspaceSearchMigrationTelemetryOperation,
} from './migration-telemetry'

const configurationHash = 'a'.repeat(64)
const alternateConfigurationHash = 'c'.repeat(64)
const policyVersion = 'b'.repeat(64)
const correlationBytes = '0123456789abcdef0123456789abcdef'
const observedAtMilliseconds = 1_785_590_400_000

/** Complete ordered metric definitions expected in every finalized EMF line. */
const expectedMetricDefinitions = [
  { Name: 'CheckpointProgressCount', Unit: 'Count' },
  { Name: 'CheckpointProgressUnits', Unit: 'None' },
  { Name: 'CheckpointStallCount', Unit: 'Count' },
  { Name: 'CheckpointStallMilliseconds', Unit: 'Milliseconds' },
  { Name: 'DescribeTableAttemptCount', Unit: 'Count' },
  { Name: 'DescribeTableBudgetExhaustionCount', Unit: 'Count' },
  { Name: 'DescribeTableBudgetStopCount', Unit: 'Count' },
  { Name: 'DescribeTableCadenceWaitCount', Unit: 'Count' },
  { Name: 'DescribeTableCadenceWaitMilliseconds', Unit: 'Milliseconds' },
  {
    Name: 'DescribeTableThrottleBackoffMilliseconds',
    Unit: 'Milliseconds',
  },
  { Name: 'DescribeTableThrottleCount', Unit: 'Count' },
  { Name: 'OperationCount', Unit: 'Count' },
  { Name: 'QuarantineCount', Unit: 'Count' },
  { Name: 'TerminalFailureCount', Unit: 'Count' },
]

/**
 * Creates one recorder with deterministic clock, sequence, correlation, and sink.
 *
 * @param lines - Captured serialized output lines.
 * @param operation - Finite operation bound to the recorder.
 * @param selectedPolicyVersion - Reviewed policy digest.
 * @param selectedCorrelationBytes - Deterministic opaque correlation bytes.
 * @param liveLines - Optional captured immediate checkpoint-stall lines.
 * @returns Fresh best-effort recorder.
 */
function createDeterministicRecorder(
  lines: string[],
  operation: WorkspaceSearchMigrationTelemetryOperation = 'apply',
  selectedPolicyVersion = policyVersion,
  selectedCorrelationBytes = correlationBytes,
  liveLines: string[] | undefined = undefined,
) {
  let sequence = 40
  return createWorkspaceSearchMigrationTelemetryRecorder({
    version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
    operation,
    policyVersion: selectedPolicyVersion,
  }, {
    clock: () => observedAtMilliseconds,
    sequence: () => {
      sequence += 1
      return sequence
    },
    correlationSource: () => selectedCorrelationBytes,
    sink: (line: string) => {
      lines.push(line)
    },
    ...(liveLines === undefined
      ? {}
      : {
        liveSink: (line: string) => {
          liveLines.push(line)
        },
      }),
  })
}

/**
 * Reads one required captured line.
 *
 * @param lines - Captured serialized lines.
 * @param index - Required zero-based index.
 * @returns Exact serialized line.
 */
function requireLine(lines: readonly string[], index: number): string {
  const line = lines[index]
  if (line === undefined) throw new Error('Expected telemetry line.')
  return line
}

/**
 * Invokes one required scheduled callback.
 *
 * @param callback - Candidate pending callback.
 */
function invokeScheduledCallback(callback: (() => void) | undefined): void {
  if (callback === undefined) throw new Error('Expected scheduled callback.')
  callback()
}

describe('Workspace Search migration telemetry', () => {
  test('buffers general triggers and finalizes exactly one zero-complete EMF line', () => {
    const lines: string[] = []
    const recorder = createDeterministicRecorder(lines)
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)

    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'checkpoint-progress',
      phase: 'apply',
      progressUnits: 3,
    })
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'checkpoint-progress',
      phase: 'apply',
      progressUnits: 2,
    })
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'checkpoint-stall',
      phase: 'apply',
      stalledForMilliseconds: 300_000,
    })
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'checkpoint-stall',
      phase: 'apply',
      stalledForMilliseconds: 600_000,
    })
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'quarantine',
      phase: 'reconciliation',
      reason: 'checkpoint-corrupt',
    })
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'terminal-failure',
      phase: 'terminal',
      reason: 'data-integrity',
    })

    expect(lines).toEqual([])
    expect(recorder.snapshot()).toEqual({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      correlationId: `wsm-correlation-v1:${correlationBytes}`,
      configurationBinding: 'bound',
      configurationHash,
      evidenceLocator: expectedEvidenceLocator(
        configurationHash,
        policyVersion,
      ),
      observationCount: 6,
      lastTrigger: 'terminal-failure',
      lastReason: 'data-integrity',
      metrics: {
        CheckpointProgressCount: 2,
        CheckpointProgressUnits: 5,
        CheckpointStallCount: 2,
        CheckpointStallMilliseconds: 600_000,
        DescribeTableAttemptCount: 0,
        DescribeTableBudgetExhaustionCount: 0,
        DescribeTableBudgetStopCount: 0,
        DescribeTableCadenceWaitCount: 0,
        DescribeTableCadenceWaitMilliseconds: 0,
        DescribeTableThrottleBackoffMilliseconds: 0,
        DescribeTableThrottleCount: 0,
        OperationCount: 0,
        QuarantineCount: 1,
        TerminalFailureCount: 1,
      },
    })

    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'terminal',
      outcome: 'failed',
    })
    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'terminal',
      outcome: 'failed',
    })

    expect(lines).toHaveLength(1)
    expect(JSON.parse(requireLine(lines, 0))).toEqual({
      _aws: {
        Timestamp: observedAtMilliseconds,
        CloudWatchMetrics: [{
          Namespace: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
          Dimensions: [['Service']],
          Metrics: expectedMetricDefinitions,
        }],
      },
      schemaVersion: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      event: 'workspace-search-migration.finalized',
      service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
      Service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
      operation: 'apply',
      phase: 'terminal',
      outcome: 'failed',
      lastTrigger: 'terminal-failure',
      lastReason: 'data-integrity',
      configurationBinding: 'bound',
      configurationHash,
      policyVersion,
      correlationId: `wsm-correlation-v1:${correlationBytes}`,
      evidenceLocator: expectedEvidenceLocator(
        configurationHash,
        policyVersion,
      ),
      observedAtMilliseconds,
      sequence: 41,
      observationCount: 6,
      CheckpointProgressCount: 2,
      CheckpointProgressUnits: 5,
      CheckpointStallCount: 2,
      CheckpointStallMilliseconds: 600_000,
      DescribeTableAttemptCount: 0,
      DescribeTableBudgetExhaustionCount: 0,
      DescribeTableBudgetStopCount: 0,
      DescribeTableCadenceWaitCount: 0,
      DescribeTableCadenceWaitMilliseconds: 0,
      DescribeTableThrottleBackoffMilliseconds: 0,
      DescribeTableThrottleCount: 0,
      OperationCount: 1,
      QuarantineCount: 1,
      TerminalFailureCount: 1,
    })
  })

  test('adapts every #158 rate observation into bounded aggregates', () => {
    const lines: string[] = []
    const recorder = createDeterministicRecorder(lines, 'close-replan')
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    const rateRecorder: WorkspaceSearchMigrationDescribeTableRateRecorder =
      recorder.describeTableRateRecorder

    rateRecorder.record({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      kind: 'attempt',
      phase: 'measurement',
      sequence: 1,
      observedAtMilliseconds: 10,
      remainingNormalAdmissionAttempts: 200,
      remainingWindowAttempts: 10,
      remainingPageAttempts: 0,
      inFlight: 1,
    })
    for (const backoffMilliseconds of [100, 300]) {
      rateRecorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'throttle',
        phase: 'measurement',
        sequence: backoffMilliseconds,
        observedAtMilliseconds: backoffMilliseconds,
        backoffMilliseconds,
      })
    }
    const stopReasons: readonly WorkspaceSearchMigrationDescribeTableRateStopReason[] = [
      'budget-capacity',
      'throttled',
      'quarantined',
    ]
    for (const reason of stopReasons) {
      rateRecorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'budget-stop',
        phase: 'checkpoint-page',
        reason,
        observedAtMilliseconds: 500,
        requiredAttempts: 1,
        remainingNormalAdmissionAttempts: 0,
        remainingWindowAttempts: 0,
        retryAfterMilliseconds: 1_000,
      })
    }
    for (const delayMilliseconds of [20, 30]) {
      rateRecorder.record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'cadence-wait',
        phase: 'reconciliation',
        observedAtMilliseconds: 600,
        delayMilliseconds,
      })
    }

    expect(recorder.snapshot()?.metrics).toEqual({
      CheckpointProgressCount: 0,
      CheckpointProgressUnits: 0,
      CheckpointStallCount: 0,
      CheckpointStallMilliseconds: 0,
      DescribeTableAttemptCount: 1,
      DescribeTableBudgetExhaustionCount: 1,
      DescribeTableBudgetStopCount: 3,
      DescribeTableCadenceWaitCount: 2,
      DescribeTableCadenceWaitMilliseconds: 50,
      DescribeTableThrottleBackoffMilliseconds: 300,
      DescribeTableThrottleCount: 2,
      OperationCount: 0,
      QuarantineCount: 1,
      TerminalFailureCount: 0,
    })
    expect(lines).toEqual([])

    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'reconciliation',
      outcome: 'failed',
    })

    expect(lines).toHaveLength(1)
    expect(JSON.parse(requireLine(lines, 0))).toMatchObject({
      operation: 'close-replan',
      phase: 'reconciliation',
      outcome: 'failed',
      lastTrigger: 'describe-table-cadence-wait',
      DescribeTableAttemptCount: 1,
      DescribeTableBudgetExhaustionCount: 1,
      DescribeTableBudgetStopCount: 3,
      DescribeTableCadenceWaitCount: 2,
      DescribeTableCadenceWaitMilliseconds: 50,
      DescribeTableThrottleBackoffMilliseconds: 300,
      DescribeTableThrottleCount: 2,
      OperationCount: 1,
      QuarantineCount: 1,
    })
  })

  test('emits a bound watchdog stall immediately and excludes it from final pending metrics', () => {
    const finalLines: string[] = []
    const liveLines: string[] = []
    const recorder = createDeterministicRecorder(
      finalLines,
      'apply',
      policyVersion,
      correlationBytes,
      liveLines,
    )
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    let now = 1_000
    let pending: (() => void) | undefined
    const watchdog = createWorkspaceSearchMigrationCheckpointStallWatchdog({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      mode: 'monitor-progress',
      phase: 'apply',
      recorder,
      clock: () => now,
      schedule: (_delayMilliseconds: number, callback: () => void) => {
        pending = callback
        return () => undefined
      },
    })

    expect(liveLines).toEqual([])
    expect(finalLines).toEqual([])
    now += WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS
    invokeScheduledCallback(pending)

    expect(finalLines).toEqual([])
    expect(liveLines).toHaveLength(1)
    expect(JSON.parse(requireLine(liveLines, 0))).toEqual({
      _aws: {
        Timestamp: observedAtMilliseconds,
        CloudWatchMetrics: [{
          Namespace: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
          Dimensions: [['Service']],
          Metrics: [
            { Name: 'CheckpointStallCount', Unit: 'Count' },
            {
              Name: 'CheckpointStallMilliseconds',
              Unit: 'Milliseconds',
            },
          ],
        }],
      },
      schemaVersion: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      event: 'workspace-search-migration.checkpoint-stall',
      service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
      Service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
      operation: 'apply',
      phase: 'apply',
      outcome: 'stalled',
      configurationBinding: 'bound',
      configurationHash,
      policyVersion,
      correlationId: `wsm-correlation-v1:${correlationBytes}`,
      evidenceLocator: expectedEvidenceLocator(
        configurationHash,
        policyVersion,
      ),
      observedAtMilliseconds,
      sequence: 41,
      CheckpointStallCount: 1,
      CheckpointStallMilliseconds:
        WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS,
    })
    expect(recorder.snapshot()).toMatchObject({
      observationCount: 1,
      metrics: {
        CheckpointStallCount: 1,
        CheckpointStallMilliseconds:
          WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS,
      },
    })

    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'terminal',
      outcome: 'succeeded',
    })

    expect(finalLines).toHaveLength(1)
    expect(JSON.parse(requireLine(finalLines, 0))).toMatchObject({
      event: 'workspace-search-migration.finalized',
      sequence: 42,
      observationCount: 1,
      CheckpointStallCount: 0,
      CheckpointStallMilliseconds: 0,
      OperationCount: 1,
    })
    watchdog.stop()
  })

  test('retains a live stall for final output when a sink throws or rejects', async () => {
    const failingSinks = [
      () => {
        throw new Error('synchronous live sink failure')
      },
      () => Promise.reject(new Error('asynchronous live sink failure')),
      () => createRejectingThenable(),
      () => createHandledRejectingProxyPromise('proxy live sink failure'),
      () => 1,
    ]

    for (const liveSink of failingSinks) {
      const finalLines: string[] = []
      let sequence = 0
      const recorder = createWorkspaceSearchMigrationTelemetryRecorder({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        operation: 'apply',
        policyVersion,
      }, {
        clock: () => observedAtMilliseconds,
        sequence: () => {
          sequence += 1
          return sequence
        },
        correlationSource: () => correlationBytes,
        sink: (line: string) => finalLines.push(line),
        liveSink,
      })
      expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)

      expect(() => recorder.record({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        kind: 'checkpoint-stall',
        phase: 'apply',
        stalledForMilliseconds: 300_000,
      })).not.toThrow()
      expect(recorder.snapshot()?.metrics).toMatchObject({
        CheckpointStallCount: 1,
        CheckpointStallMilliseconds: 300_000,
      })

      recorder.finalize({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        phase: 'terminal',
        outcome: 'failed',
      })

      expect(finalLines).toHaveLength(1)
      expect(JSON.parse(requireLine(finalLines, 0))).toMatchObject({
        CheckpointStallCount: 1,
        CheckpointStallMilliseconds: 300_000,
        OperationCount: 1,
        TerminalFailureCount: 1,
      })
      await Promise.resolve()
    }
  })

  test('buffers before deferred configuration binding and rejects rebinding', () => {
    const lines: string[] = []
    const recorder = createDeterministicRecorder(lines, 'measure')

    recorder.describeTableRateRecorder.record({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      kind: 'attempt',
      phase: 'measurement',
      sequence: 1,
      observedAtMilliseconds: 0,
      remainingNormalAdmissionAttempts: 1,
      remainingWindowAttempts: 1,
      remainingPageAttempts: 0,
      inFlight: 1,
    })
    const unboundSnapshot = recorder.snapshot()
    expect(unboundSnapshot).toMatchObject({
      configurationBinding: 'unbound',
      correlationId: `wsm-correlation-v1:${correlationBytes}`,
      evidenceLocator: expectedUnboundEvidenceLocator(
        policyVersion,
        `wsm-correlation-v1:${correlationBytes}`,
      ),
      observationCount: 1,
      lastTrigger: 'describe-table-attempt',
      metrics: {
        DescribeTableAttemptCount: 1,
        OperationCount: 0,
      },
    })
    expect(
      unboundSnapshot === undefined
        ? false
        : Object.hasOwn(unboundSnapshot, 'configurationHash'),
    ).toBe(false)
    expect(recorder.readEvidenceLocator()).toBe(
      expectedUnboundEvidenceLocator(
        policyVersion,
        `wsm-correlation-v1:${correlationBytes}`,
      ),
    )
    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'measurement',
      outcome: 'succeeded',
    })
    expect(lines).toEqual([])

    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    expect(recorder.bindConfigurationHash(alternateConfigurationHash)).toBe(
      false,
    )
    expect(recorder.snapshot()?.metrics.DescribeTableAttemptCount).toBe(1)
    expect(recorder.snapshot()).toMatchObject({
      configurationBinding: 'bound',
      configurationHash,
    })
    expect(recorder.readEvidenceLocator()).toBe(
      expectedEvidenceLocator(configurationHash, policyVersion),
    )

    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'measurement',
      outcome: 'succeeded',
    })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(requireLine(lines, 0))).toMatchObject({
      configurationBinding: 'bound',
      configurationHash,
    })
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(false)
  })

  test('finalizes failed measure telemetry before configuration binding', () => {
    const lines: string[] = []
    const recorder = createDeterministicRecorder(lines, 'measure')
    const correlationId = `wsm-correlation-v1:${correlationBytes}`
    const evidenceLocator = expectedUnboundEvidenceLocator(
      policyVersion,
      correlationId,
    )

    recorder.describeTableRateRecorder.record({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      kind: 'throttle',
      phase: 'measurement',
      sequence: 1,
      observedAtMilliseconds: 10,
      backoffMilliseconds: 250,
    })
    recorder.describeTableRateRecorder.record({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      kind: 'budget-stop',
      phase: 'measurement',
      reason: 'budget-capacity',
      observedAtMilliseconds: 20,
      requiredAttempts: 1,
      remainingNormalAdmissionAttempts: 0,
      remainingWindowAttempts: 0,
      retryAfterMilliseconds: 1_000,
    })
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'terminal-failure',
      phase: 'measurement',
      reason: 'rate-budget-exhausted',
    })

    const snapshot = recorder.snapshot()
    expect(snapshot).toMatchObject({
      configurationBinding: 'unbound',
      correlationId,
      evidenceLocator,
      observationCount: 3,
      metrics: {
        DescribeTableBudgetExhaustionCount: 1,
        DescribeTableBudgetStopCount: 1,
        DescribeTableThrottleBackoffMilliseconds: 250,
        DescribeTableThrottleCount: 1,
        OperationCount: 0,
        TerminalFailureCount: 1,
      },
    })
    expect(
      snapshot === undefined
        ? false
        : Object.hasOwn(snapshot, 'configurationHash'),
    ).toBe(false)

    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'measurement',
      outcome: 'failed',
    })

    expect(lines).toHaveLength(1)
    const finalized = JSON.parse(requireLine(lines, 0))
    expect(finalized).toMatchObject({
      operation: 'measure',
      phase: 'measurement',
      outcome: 'failed',
      configurationBinding: 'unbound',
      policyVersion,
      correlationId,
      evidenceLocator,
      DescribeTableBudgetExhaustionCount: 1,
      DescribeTableBudgetStopCount: 1,
      DescribeTableThrottleBackoffMilliseconds: 250,
      DescribeTableThrottleCount: 1,
      OperationCount: 1,
      TerminalFailureCount: 1,
    })
    expect(Object.hasOwn(finalized, 'configurationHash')).toBe(false)
  })

  test('does not finalize any other unbound operation', () => {
    const lines: string[] = []
    const recorder = createDeterministicRecorder(lines, 'apply')
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'terminal-failure',
      phase: 'apply',
      reason: 'operation-failed',
    })

    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'apply',
      outcome: 'failed',
    })

    expect(lines).toEqual([])
    expect(recorder.snapshot()).toMatchObject({
      configurationBinding: 'unbound',
      metrics: {
        OperationCount: 0,
        TerminalFailureCount: 1,
      },
    })
  })

  test('emits failure then all-zero success on the same Service metric series', () => {
    const failureLines: string[] = []
    const failure = createDeterministicRecorder(failureLines, 'verify')
    expect(failure.bindConfigurationHash(configurationHash)).toBe(true)
    failure.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'terminal-failure',
      phase: 'verification',
      reason: 'verification-failed',
    })
    failure.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'verification',
      outcome: 'failed',
    })

    const successLines: string[] = []
    const success = createDeterministicRecorder(
      successLines,
      'verify',
      policyVersion,
      'fedcba9876543210fedcba9876543210',
    )
    expect(success.bindConfigurationHash(configurationHash)).toBe(true)
    success.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'verification',
      outcome: 'succeeded',
    })

    expect(JSON.parse(requireLine(failureLines, 0))).toMatchObject({
      Service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
      outcome: 'failed',
      OperationCount: 1,
      TerminalFailureCount: 1,
    })
    expect(JSON.parse(requireLine(successLines, 0))).toMatchObject({
      Service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
      outcome: 'succeeded',
      CheckpointProgressCount: 0,
      CheckpointStallCount: 0,
      DescribeTableBudgetExhaustionCount: 0,
      DescribeTableBudgetStopCount: 0,
      DescribeTableThrottleCount: 0,
      OperationCount: 1,
      QuarantineCount: 0,
      TerminalFailureCount: 0,
    })
    expect(
      JSON.parse(requireLine(successLines, 0))._aws.CloudWatchMetrics[0]
        .Dimensions,
    ).toEqual([['Service']])
  })

  test('never emits high-cardinality identities, raw errors, or paths', () => {
    const invalidLines: string[] = []
    const invalidContextRecorder =
      createWorkspaceSearchMigrationTelemetryRecorder({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        operation: 'apply',
        policyVersion,
        runId: 'tenant-run-canary',
      }, {
        sink: (line: string) => invalidLines.push(line),
      })
    expect(invalidContextRecorder.bindConfigurationHash(configurationHash))
      .toBe(false)

    const lines: string[] = []
    const recorder = createDeterministicRecorder(lines)
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'checkpoint-progress',
      phase: 'apply',
      progressUnits: 1,
      ownerId: 'tenant-owner-canary',
    })
    recorder.record({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'terminal-failure',
      phase: 'terminal',
      reason: 'operation-failed',
    })
    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'terminal',
      outcome: 'failed',
    })

    expect(invalidLines).toEqual([])
    const serialized = requireLine(lines, 0)
    for (const forbiddenKey of [
      'runId',
      'ownerId',
      'account',
      'region',
      'table',
      'profile',
      'cursor',
      'tenant',
      'error',
      'path',
    ]) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`)
    }
    expect(serialized).not.toContain('tenant-run-canary')
    expect(serialized).not.toContain('tenant-owner-canary')
    expect(JSON.parse(serialized)).toMatchObject({
      observationCount: 1,
      CheckpointProgressCount: 0,
      TerminalFailureCount: 1,
    })
  })

  test('rejects accessors, Proxies, symbols, and non-enumerable extras without reading them', () => {
    const lines: string[] = []
    let accessorReads = 0
    const accessorContext = {
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      policyVersion,
    }
    Object.defineProperty(accessorContext, 'operation', {
      enumerable: true,
      get() {
        accessorReads += 1
        return 'apply'
      },
    })
    const accessorRecorder =
      createWorkspaceSearchMigrationTelemetryRecorder(accessorContext, {
        sink: (line: string) => lines.push(line),
      })
    expect(accessorRecorder.bindConfigurationHash(configurationHash)).toBe(
      false,
    )

    const recorder = createDeterministicRecorder(lines)
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    const accessorObservation = {
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'apply',
      progressUnits: 1,
    }
    Object.defineProperty(accessorObservation, 'kind', {
      enumerable: true,
      get() {
        accessorReads += 1
        return 'checkpoint-progress'
      },
    })
    recorder.record(accessorObservation)

    let proxyTrapReads = 0
    const hostileProxy = new Proxy({}, {
      ownKeys() {
        proxyTrapReads += 1
        throw new Error('tenant-proxy-canary')
      },
    })
    recorder.record(hostileProxy)
    Reflect.apply(
      recorder.describeTableRateRecorder.record,
      recorder.describeTableRateRecorder,
      [hostileProxy],
    )

    const accessorRateObservation = {
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      phase: 'measurement',
      sequence: 1,
      observedAtMilliseconds: 0,
      remainingNormalAdmissionAttempts: 1,
      remainingWindowAttempts: 1,
      remainingPageAttempts: 0,
      inFlight: 1,
    }
    Object.defineProperty(accessorRateObservation, 'kind', {
      enumerable: true,
      get() {
        accessorReads += 1
        return 'attempt'
      },
    })
    Reflect.apply(
      recorder.describeTableRateRecorder.record,
      recorder.describeTableRateRecorder,
      [accessorRateObservation],
    )

    const symbolExtra = {
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'checkpoint-progress',
      phase: 'apply',
      progressUnits: 1,
    }
    Object.defineProperty(symbolExtra, Symbol('tenant-canary'), {
      enumerable: true,
      value: 'secret',
    })
    recorder.record(symbolExtra)

    const hiddenExtra = {
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      kind: 'checkpoint-progress',
      phase: 'apply',
      progressUnits: 1,
    }
    Object.defineProperty(hiddenExtra, 'runId', {
      enumerable: false,
      value: 'tenant-hidden-canary',
    })
    recorder.record(hiddenExtra)

    expect(accessorReads).toBe(0)
    expect(proxyTrapReads).toBe(0)
    expect(recorder.snapshot()?.observationCount).toBe(0)
  })

  test('drops malformed finalization accessors and allows one later valid finalize', () => {
    const lines: string[] = []
    const recorder = createDeterministicRecorder(lines)
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    let accessorReads = 0
    const accessorFinalization = {
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'terminal',
    }
    Object.defineProperty(accessorFinalization, 'outcome', {
      enumerable: true,
      get() {
        accessorReads += 1
        return 'succeeded'
      },
    })

    recorder.finalize(accessorFinalization)
    expect(accessorReads).toBe(0)
    expect(lines).toEqual([])
    recorder.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'terminal',
      outcome: 'succeeded',
    })
    expect(lines).toHaveLength(1)
  })

  test('observer failures never alter the wrapped migration outcome', () => {
    let sequenceCalls = 0
    const recorder = createWorkspaceSearchMigrationTelemetryRecorder({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      operation: 'release',
      policyVersion,
    }, {
      clock: () => observedAtMilliseconds,
      sequence: () => {
        sequenceCalls += 1
        return sequenceCalls
      },
      correlationSource: () => correlationBytes,
      sink: () => {
        throw new Error('tenant-sink-secret')
      },
    })

    const migration = () => {
      recorder.record({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        kind: 'checkpoint-progress',
        phase: 'release',
        progressUnits: 1,
      })
      recorder.bindConfigurationHash(configurationHash)
      recorder.finalize({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        phase: 'release',
        outcome: 'succeeded',
      })
      return 'migration-result'
    }

    expect(migration()).toBe('migration-result')
    expect(() => migration()).not.toThrow()
    expect(sequenceCalls).toBe(1)

    const invalidClock = createWorkspaceSearchMigrationTelemetryRecorder({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      operation: 'apply',
      policyVersion,
    }, {
      clock: () => {
        throw new Error('clock unavailable')
      },
      correlationSource: () => correlationBytes,
      sink: () => {
        throw new Error('must not be reached')
      },
    })
    expect(invalidClock.bindConfigurationHash(configurationHash)).toBe(true)
    expect(() => invalidClock.finalize({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      phase: 'apply',
      outcome: 'failed',
    })).not.toThrow()
  })

  test('derives evidence only from configuration and policy, not correlation', () => {
    const first = createDeterministicRecorder(
      [],
      'status',
      policyVersion,
      correlationBytes,
    )
    const second = createDeterministicRecorder(
      [],
      'status',
      policyVersion,
      'fedcba9876543210fedcba9876543210',
    )
    const third = createDeterministicRecorder(
      [],
      'status',
      'd'.repeat(64),
      correlationBytes,
    )
    for (const recorder of [first, second, third]) {
      expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    }

    expect(first.correlationId).not.toBe(second.correlationId)
    expect(first.readEvidenceLocator()).toBe(second.readEvidenceLocator())
    expect(first.readEvidenceLocator()).not.toBe(
      third.readEvidenceLocator(),
    )
  })
})

describe('Workspace Search migration checkpoint stall watchdog', () => {
  test('uses the explicit five-minute default threshold', () => {
    expect(
      WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS,
    ).toBe(300_000)
  })

  test('rearms on progress and deterministically records one live stall', () => {
    const recorder = createDeterministicRecorder([])
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    let now = 1_000
    let pending: (() => void) | undefined
    let cancellationCount = 0
    const delays: number[] = []
    const watchdog = createWorkspaceSearchMigrationCheckpointStallWatchdog({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      mode: 'monitor-progress',
      phase: 'apply',
      recorder,
      clock: () => now,
      schedule: (delayMilliseconds: number, callback: () => void) => {
        delays.push(delayMilliseconds)
        pending = callback
        return () => {
          cancellationCount += 1
        }
      },
    })

    expect(delays).toEqual([300_000])
    now += 120_000
    watchdog.recordProgress(5)
    expect(delays).toEqual([300_000, 300_000])
    expect(cancellationCount).toBe(1)

    now += 299_999
    invokeScheduledCallback(pending)
    expect(delays).toEqual([300_000, 300_000, 1])
    expect(recorder.snapshot()?.metrics.CheckpointStallCount).toBe(0)

    now += 1
    invokeScheduledCallback(pending)
    expect(recorder.snapshot()?.metrics).toMatchObject({
      CheckpointProgressCount: 1,
      CheckpointProgressUnits: 5,
      CheckpointStallCount: 1,
      CheckpointStallMilliseconds: 300_000,
    })

    watchdog.recordProgress(2)
    expect(delays.at(-1)).toBe(300_000)
    watchdog.stop()
    expect(cancellationCount).toBe(2)
  })

  test('pauses without clock access and resumes from a fresh baseline', () => {
    const recorder = createDeterministicRecorder([])
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    let now = 1_000
    let clockReads = 0
    let pending: (() => void) | undefined
    let cancellationCount = 0
    const delays: number[] = []
    const watchdog = createWorkspaceSearchMigrationCheckpointStallWatchdog({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      mode: 'monitor-progress',
      phase: 'apply',
      recorder,
      clock: () => {
        clockReads += 1
        return now
      },
      schedule: (delayMilliseconds: number, callback: () => void) => {
        delays.push(delayMilliseconds)
        pending = callback
        return () => {
          cancellationCount += 1
        }
      },
    })

    expect(clockReads).toBe(1)
    expect(delays).toEqual([300_000])
    watchdog.pause()
    watchdog.pause()
    expect(clockReads).toBe(1)
    expect(cancellationCount).toBe(1)

    now += 900_000
    watchdog.recordProgress(4)
    expect(clockReads).toBe(1)
    expect(delays).toEqual([300_000])
    expect(recorder.snapshot()?.metrics).toMatchObject({
      CheckpointProgressCount: 1,
      CheckpointProgressUnits: 4,
      CheckpointStallCount: 0,
    })

    watchdog.resume()
    watchdog.resume()
    expect(clockReads).toBe(2)
    expect(delays).toEqual([300_000, 300_000])

    now += 299_999
    invokeScheduledCallback(pending)
    expect(clockReads).toBe(3)
    expect(delays).toEqual([300_000, 300_000, 1])
    expect(recorder.snapshot()?.metrics.CheckpointStallCount).toBe(0)

    now += 1
    invokeScheduledCallback(pending)
    expect(clockReads).toBe(4)
    expect(recorder.snapshot()?.metrics).toMatchObject({
      CheckpointProgressCount: 1,
      CheckpointStallCount: 1,
      CheckpointStallMilliseconds: 300_000,
    })

    watchdog.stop()
    const metricsAfterStop = recorder.snapshot()?.metrics
    watchdog.resume()
    watchdog.recordProgress(2)
    watchdog.pause()
    expect(clockReads).toBe(4)
    expect(delays).toEqual([300_000, 300_000, 1])
    expect(recorder.snapshot()?.metrics).toEqual(metricsAfterStop)
  })

  test('intentional drain records progress without clock reads or timer arms', () => {
    const recorder = createDeterministicRecorder([])
    expect(recorder.bindConfigurationHash(configurationHash)).toBe(true)
    let clockReads = 0
    let scheduleCalls = 0
    const watchdog = createWorkspaceSearchMigrationCheckpointStallWatchdog({
      version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
      mode: 'intentional-drain',
      phase: 'drain',
      recorder,
      clock: () => {
        clockReads += 1
        throw new Error('drain clock must remain unused')
      },
      schedule: () => {
        scheduleCalls += 1
        throw new Error('drain scheduler must remain unused')
      },
    })

    watchdog.pause()
    watchdog.resume()
    watchdog.recordProgress(4)
    watchdog.pause()
    watchdog.resume()
    watchdog.stop()
    watchdog.resume()
    watchdog.recordProgress(2)
    expect(clockReads).toBe(0)
    expect(scheduleCalls).toBe(0)
    expect(recorder.snapshot()?.metrics).toMatchObject({
      CheckpointProgressCount: 1,
      CheckpointProgressUnits: 4,
      CheckpointStallCount: 0,
    })
  })

  test('consumes asynchronous scheduler and cancellation failures', async () => {
    const schedulerRecorder = createDeterministicRecorder([])
    expect(schedulerRecorder.bindConfigurationHash(configurationHash)).toBe(
      true,
    )
    let schedulerNow = 1_000
    const invalidSchedulerCallbacks: Array<() => void> = []
    const schedulerWatchdog =
      createWorkspaceSearchMigrationCheckpointStallWatchdog({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        mode: 'monitor-progress',
        phase: 'apply',
        recorder: schedulerRecorder,
        clock: () => schedulerNow,
        schedule: (_delayMilliseconds: number, callback: () => void) => {
          invalidSchedulerCallbacks.push(callback)
          return Promise.reject(
            new Error('raw-async-scheduler-canary'),
          )
        },
      })
    schedulerWatchdog.recordProgress(1)
    schedulerNow +=
      WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS
    invalidSchedulerCallbacks.at(-1)?.()
    schedulerWatchdog.stop()

    const cancellationRecorder = createDeterministicRecorder([])
    expect(cancellationRecorder.bindConfigurationHash(configurationHash)).toBe(
      true,
    )
    const cancellationWatchdog =
      createWorkspaceSearchMigrationCheckpointStallWatchdog({
        version: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_VERSION,
        mode: 'monitor-progress',
        phase: 'apply',
        recorder: cancellationRecorder,
        clock: () => 1_000,
        schedule: () => async () => {
          throw new Error('raw-async-cancellation-canary')
        },
      })
    cancellationWatchdog.stop()

    await Promise.resolve()
    await Promise.resolve()
    expect(schedulerRecorder.snapshot()?.metrics).toMatchObject({
      CheckpointProgressCount: 1,
      CheckpointStallCount: 0,
    })
    expect(cancellationRecorder.snapshot()?.metrics.CheckpointStallCount).toBe(
      0,
    )
  })
})

/**
 * Creates an opaque custom thenable that rejects if a consumer assimilates it.
 *
 * @returns Invalid synchronous sink result with no eager side effects.
 */
function createRejectingThenable(): object {
  const candidate = {}
  const thenProperty = String.fromCodePoint(116, 104, 101, 110)
  Object.defineProperty(candidate, thenProperty, {
    enumerable: true,
    value: (
      _resolve: (value: unknown) => void,
      reject: (reason: unknown) => void,
    ): void => reject(new Error('thenable live sink failure')),
  })
  return candidate
}

/**
 * Creates an opaque Proxy-wrapped rejected Promise with a prehandled target.
 * Standard JavaScript cannot safely unwrap this boundary value, so the test
 * verifies only that the Proxy return is rejected as a synchronous sink result.
 *
 * @param message - Private rejection canary installed on the handled target.
 * @returns Opaque Proxy Promise used to exercise the invalid-result boundary.
 */
function createHandledRejectingProxyPromise(message: string): Promise<never> {
  const target = Promise.reject(new Error(message))
  void Reflect.apply(Promise.prototype.then, target, [
    undefined,
    () => undefined,
  ])
  return new Proxy(target, {})
}

/**
 * Reproduces the locator derivation from only reviewed digest bindings.
 *
 * @param selectedConfigurationHash - Reviewed resource digest.
 * @param selectedPolicyVersion - Reviewed rate-policy digest.
 * @returns Expected non-path evidence locator.
 */
function expectedEvidenceLocator(
  selectedConfigurationHash: string,
  selectedPolicyVersion: string,
): string {
  const digest = createHash('sha256')
    .update('workspace-search-migration-evidence-v1\0')
    .update(selectedConfigurationHash)
    .update('\0')
    .update(selectedPolicyVersion)
    .digest('hex')
  return `wsm-evidence-v1:${digest}`
}

/**
 * Reproduces the locator derivation before a configuration digest is known.
 *
 * @param selectedPolicyVersion - Reviewed rate-policy digest.
 * @param selectedCorrelationId - Opaque process correlation identifier.
 * @returns Expected policy-and-correlation-only evidence locator.
 */
function expectedUnboundEvidenceLocator(
  selectedPolicyVersion: string,
  selectedCorrelationId: string,
): string {
  const digest = createHash('sha256')
    .update('workspace-search-migration-unbound-evidence-v1\0')
    .update(selectedPolicyVersion)
    .update('\0')
    .update(selectedCorrelationId)
    .digest('hex')
  return `wsm-evidence-unbound-v1:${digest}`
}
