import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
} from './migration-telemetry'
import {
  parseWorkspaceSearchMigrationTelemetryRehearsalArguments,
  runWorkspaceSearchMigrationTelemetryRehearsal,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
  type WorkspaceSearchMigrationTelemetryRehearsalDependencies,
  type WorkspaceSearchMigrationTelemetryRehearsalSignal,
} from './migration-telemetry-rehearsal'

const configurationHash = 'a'.repeat(64)
const policyVersion = 'b'.repeat(64)
const correlationBytes = '0123456789abcdef0123456789abcdef'
const observedAtMilliseconds = 1_785_590_400_000

/** Stable expected invalid-usage line. */
const invalidUsageLine = JSON.stringify({
  schemaVersion: 1,
  operation: 'telemetry-rehearsal',
  status: 'error',
  code: 'INVALID_USAGE',
})

/** Stable expected internal-failure line. */
const rehearsalFailedLine = JSON.stringify({
  schemaVersion: 1,
  operation: 'telemetry-rehearsal',
  status: 'error',
  code: 'REHEARSAL_FAILED',
})

/** Every finite controlled rehearsal signal. */
const signals: readonly WorkspaceSearchMigrationTelemetryRehearsalSignal[] = [
  'describe-table-throttle',
  'rate-budget-exhaustion',
  'checkpoint-stall',
  'quarantine',
  'terminal-failure',
  'recovery',
]

/**
 * Creates the exact four required flag/value pairs.
 *
 * @param signal - Controlled signal value.
 * @returns Fresh strict argv array.
 */
function createArguments(
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
): string[] {
  return [
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
    '--signal',
    signal,
    '--configuration-hash',
    configurationHash,
    '--policy-version',
    policyVersion,
  ]
}

/**
 * Creates deterministic recorder and output boundaries.
 *
 * @param standardOutput - Captured standard output lines.
 * @param standardError - Captured standard error lines.
 * @returns Deterministic rehearsal dependencies.
 */
function createDependencies(
  standardOutput: string[],
  standardError: string[],
): WorkspaceSearchMigrationTelemetryRehearsalDependencies {
  let sequence = 6
  return {
    createRecorder: (context, sink) =>
      createWorkspaceSearchMigrationTelemetryRecorder(context, {
        clock: () => observedAtMilliseconds,
        sequence: () => {
          sequence += 1
          return sequence
        },
        correlationSource: () => correlationBytes,
        sink,
      }),
    writeStandardOutput: (line: string) => standardOutput.push(line),
    writeStandardError: (line: string) => standardError.push(line),
  }
}

/**
 * Reads one required output line.
 *
 * @param lines - Captured lines.
 * @returns Sole required line.
 */
function requireOnlyLine(lines: readonly string[]): string {
  expect(lines).toHaveLength(1)
  const line = lines[0]
  if (line === undefined) throw new Error('Expected one output line.')
  return line
}

/**
 * Returns the exact alarm-count values for one controlled signal.
 *
 * @param signal - Controlled rehearsal signal.
 * @returns Alarm metric count projection.
 */
function expectedAlarmCounts(
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
) {
  return {
    DescribeTableThrottleCount:
      signal === 'describe-table-throttle' ? 1 : 0,
    DescribeTableBudgetExhaustionCount:
      signal === 'rate-budget-exhaustion' ? 1 : 0,
    DescribeTableBudgetStopCount:
      signal === 'rate-budget-exhaustion' ? 1 : 0,
    CheckpointStallCount: signal === 'checkpoint-stall' ? 1 : 0,
    QuarantineCount: signal === 'quarantine' ? 1 : 0,
    TerminalFailureCount: signal === 'terminal-failure' ? 1 : 0,
  }
}

describe('Workspace Search migration telemetry rehearsal parser', () => {
  test('accepts exactly the required reviewed flags in any order', () => {
    expect(parseWorkspaceSearchMigrationTelemetryRehearsalArguments([
      '--policy-version',
      policyVersion,
      '--approval',
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
      '--configuration-hash',
      configurationHash,
      '--signal',
      'recovery',
    ])).toEqual({
      approval: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
      signal: 'recovery',
      configurationHash,
      policyVersion,
    })
  })

  test('rejects missing, duplicate, unknown, prohibited, and invalid flags', () => {
    const valid = createArguments('recovery')
    const cases: readonly string[][] = [
      valid.slice(0, -2),
      [...valid, '--signal', 'recovery'],
      [...valid.slice(0, -2), '--unknown', 'value'],
      [...valid, '--table', 'tenant-table-canary'],
      valid.map((value) =>
        value === WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL
          ? 'tenant-approval-canary'
          : value
      ),
      valid.map((value) =>
        value === 'recovery' ? 'tenant-signal-canary' : value
      ),
      valid.map((value) =>
        value === configurationHash ? 'A'.repeat(64) : value
      ),
      valid.map((value) =>
        value === policyVersion ? 'not-a-policy-path' : value
      ),
    ]

    for (const arguments_ of cases) {
      expect(() =>
        parseWorkspaceSearchMigrationTelemetryRehearsalArguments(
          arguments_,
        )).toThrow('INVALID_USAGE')
    }
  })

  test('rejects Proxy, accessor, symbol, and sparse argv without invoking traps', () => {
    let accessorReads = 0
    const accessorArguments = createArguments('recovery')
    Object.defineProperty(accessorArguments, '0', {
      enumerable: true,
      get() {
        accessorReads += 1
        return '--approval'
      },
    })
    expect(() =>
      parseWorkspaceSearchMigrationTelemetryRehearsalArguments(
        accessorArguments,
      )).toThrow('INVALID_USAGE')
    expect(accessorReads).toBe(0)

    let proxyTrapReads = 0
    const proxyArguments = new Proxy(createArguments('recovery'), {
      ownKeys() {
        proxyTrapReads += 1
        throw new Error('tenant-proxy-canary')
      },
    })
    expect(() =>
      parseWorkspaceSearchMigrationTelemetryRehearsalArguments(
        proxyArguments,
      )).toThrow('INVALID_USAGE')
    expect(proxyTrapReads).toBe(0)

    const symbolArguments = createArguments('recovery')
    Object.defineProperty(symbolArguments, Symbol('tenant-canary'), {
      enumerable: true,
      value: 'secret',
    })
    expect(() =>
      parseWorkspaceSearchMigrationTelemetryRehearsalArguments(
        symbolArguments,
      )).toThrow('INVALID_USAGE')

    const sparseArguments = createArguments('recovery')
    delete sparseArguments[2]
    expect(() =>
      parseWorkspaceSearchMigrationTelemetryRehearsalArguments(
        sparseArguments,
      )).toThrow('INVALID_USAGE')
  })
})

describe('Workspace Search migration telemetry rehearsal execution', () => {
  for (const signal of signals) {
    test(`emits exactly one controlled ${signal} EMF line`, () => {
      const standardOutput: string[] = []
      const standardError: string[] = []

      expect(runWorkspaceSearchMigrationTelemetryRehearsal(
        createArguments(signal),
        createDependencies(standardOutput, standardError),
      )).toBe(0)

      expect(standardError).toEqual([])
      const serialized = requireOnlyLine(standardOutput)
      expect(serialized).not.toContain('\n')
      expect(serialized).not.toContain('\r')
      expect(JSON.parse(serialized)).toMatchObject({
        _aws: {
          Timestamp: observedAtMilliseconds,
          CloudWatchMetrics: [{
            Namespace: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
            Dimensions: [['Service']],
          }],
        },
        Service: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
        operation: 'telemetry-rehearsal',
        outcome: signal === 'terminal-failure' ? 'failed' : 'succeeded',
        configurationHash,
        policyVersion,
        correlationId: `wsm-correlation-v1:${correlationBytes}`,
        sequence: 7,
        OperationCount: 1,
        ...expectedAlarmCounts(signal),
      })

      for (const forbiddenKey of [
        'account',
        'error',
        'ownerId',
        'path',
        'profile',
        'region',
        'runId',
        'table',
        'tenant',
      ]) {
        expect(serialized).not.toContain(`"${forbiddenKey}"`)
      }
    })
  }

  test('recovery writes zero for every alarm trigger metric', () => {
    const standardOutput: string[] = []
    const standardError: string[] = []
    expect(runWorkspaceSearchMigrationTelemetryRehearsal(
      createArguments('recovery'),
      createDependencies(standardOutput, standardError),
    )).toBe(0)

    expect(JSON.parse(requireOnlyLine(standardOutput))).toMatchObject({
      CheckpointStallCount: 0,
      DescribeTableBudgetExhaustionCount: 0,
      DescribeTableBudgetStopCount: 0,
      DescribeTableThrottleCount: 0,
      OperationCount: 1,
      QuarantineCount: 0,
      TerminalFailureCount: 0,
    })
    expect(standardError).toEqual([])
  })

  test('invalid usage emits one stable raw-argument-free stderr line', () => {
    const standardOutput: string[] = []
    const standardError: string[] = []
    const arguments_ = [
      ...createArguments('recovery'),
      '--profile',
      'tenant-profile-secret',
    ]

    expect(runWorkspaceSearchMigrationTelemetryRehearsal(
      arguments_,
      createDependencies(standardOutput, standardError),
    )).toBe(2)
    expect(standardOutput).toEqual([])
    expect(standardError).toEqual([invalidUsageLine])
    expect(requireOnlyLine(standardError)).not.toContain(
      'tenant-profile-secret',
    )
  })

  test('recorder and output failures emit only a stable internal failure', () => {
    const standardOutput: string[] = []
    const standardError: string[] = []
    const dependencies = createDependencies(standardOutput, standardError)

    expect(runWorkspaceSearchMigrationTelemetryRehearsal(
      createArguments('recovery'),
      {
        ...dependencies,
        createRecorder: () => {
          throw new Error('tenant-recorder-secret')
        },
      },
    )).toBe(1)
    expect(standardOutput).toEqual([])
    expect(standardError).toEqual([rehearsalFailedLine])
    expect(requireOnlyLine(standardError)).not.toContain(
      'tenant-recorder-secret',
    )

    standardError.length = 0
    expect(runWorkspaceSearchMigrationTelemetryRehearsal(
      createArguments('recovery'),
      {
        ...dependencies,
        writeStandardOutput: () => {
          throw new Error('tenant-output-secret')
        },
      },
    )).toBe(1)
    expect(standardError).toEqual([rehearsalFailedLine])
    expect(requireOnlyLine(standardError)).not.toContain(
      'tenant-output-secret',
    )
  })
})
