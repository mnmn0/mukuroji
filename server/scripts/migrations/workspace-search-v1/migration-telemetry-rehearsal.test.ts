import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_NAMESPACE,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_SERVICE,
} from './migration-telemetry'
import {
  createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  parseWorkspaceSearchMigrationTelemetryRehearsalSignalCliArguments,
  parseWorkspaceSearchMigrationTelemetryRehearsalArguments,
  runWorkspaceSearchMigrationTelemetryRehearsal,
  runWorkspaceSearchMigrationTelemetryRehearsalSignalCli,
  serializeWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationTelemetryRehearsalDependencies,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalCliDependencies,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  type WorkspaceSearchMigrationTelemetryRehearsalSignal,
} from './migration-telemetry-rehearsal'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
} from './migration-rehearsal-key-derivation'

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
 * Creates the exact five required flag/value pairs.
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
    '--stage',
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
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
 * Creates one exact deterministic existing-recorder EMF line.
 *
 * @param signal - Controlled signal to serialize.
 * @param timestampMilliseconds - Exact deterministic recorder time.
 * @param correlation - Exact unique lowercase correlation source.
 * @returns Sole exact serialized existing-recorder line.
 */
function createExactRehearsalLine(
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
  timestampMilliseconds: number,
  correlation: string,
): string {
  const standardOutput: string[] = []
  const standardError: string[] = []
  expect(runWorkspaceSearchMigrationTelemetryRehearsal(
    createArguments(signal),
    {
      createRecorder: (context, sink) =>
        createWorkspaceSearchMigrationTelemetryRecorder(context, {
          clock: () => timestampMilliseconds,
          sequence: () => 1,
          correlationSource: () => correlation,
          sink,
        }),
      writeStandardOutput: (line) => standardOutput.push(line),
      writeStandardError: (line) => standardError.push(line),
    },
  )).toBe(0)
  expect(standardError).toEqual([])
  return requireOnlyLine(standardOutput)
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
      '--stage',
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
      '--configuration-hash',
      configurationHash,
      '--signal',
      'recovery',
    ])).toEqual({
      approval: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
      stage: WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
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
        value === WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE
          ? 'production'
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

  test('rejects a production stage before recorder creation or EMF output', () => {
    const standardOutput: string[] = []
    const standardError: string[] = []
    const arguments_ = createArguments('terminal-failure').map((value) =>
      value === WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE
        ? 'production'
        : value
    )
    const dependencies = createDependencies(
      standardOutput,
      standardError,
    )

    expect(runWorkspaceSearchMigrationTelemetryRehearsal(
      arguments_,
      {
        ...dependencies,
        createRecorder: () => {
          throw new Error('production stage must fail before recorder creation')
        },
      },
    )).toBe(2)
    expect(standardOutput).toEqual([])
    expect(standardError).toEqual([invalidUsageLine])
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

describe('Workspace Search migration authenticated signal receipts', () => {
  /** Exact deterministic alarm-purpose HMAC key. */
  const signingKey = new Uint8Array(32).fill(0x5a)
  /** Exact alarm plan authorization binding. */
  const authorizationBindingDigest = 'c'.repeat(64)
  /** Expected stable evidence locator digest. */
  const evidenceLocatorDigest =
    createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
      configurationHash,
      policyVersion,
    )

  /** Creates the complete five-positive-plus-recovery receipt chain. */
  function createCompleteArtifact():
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact {
    let artifact:
      WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact |
      undefined
    for (const [index, signal] of
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER.entries()) {
      const correlationCharacter = (index + 1).toString(16)
      artifact =
        createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
          {
            serializedEmfLine: createExactRehearsalLine(
              signal,
              observedAtMilliseconds + (index * 60_000),
              correlationCharacter.repeat(32),
            ),
            authorizationBindingDigest,
            evidenceLocatorDigest,
            ...(artifact === undefined ? {} : { previousArtifact: artifact }),
          },
          signingKey,
        )
    }
    if (artifact === undefined) throw new Error('Expected signal artifact.')
    return artifact
  }

  test('authenticates exact EMF bytes and maps five positives to six alarms', () => {
    const artifact = createCompleteArtifact()
    expect(artifact.receipts.map((receipt) => receipt.signal)).toEqual(
      [...WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER],
    )
    expect(artifact.receipts.at(-1)?.metrics.map((metric) => metric.value))
      .toEqual([0, 0, 0, 0, 0, 0])

    const bytes =
      serializeWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        artifact,
        signingKey,
      )
    const verified =
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        JSON.parse(new TextDecoder().decode(bytes)),
        signingKey,
      )
    const bindings =
      createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings(
        verified,
        signingKey,
      )
    expect(bindings.map((binding) => binding.name)).toEqual([
      'throttle',
      'budget-stop',
      'budget-exhaustion',
      'checkpoint-stall',
      'quarantine',
      'terminal-failure',
    ])
    expect(bindings[1]?.signalDigest).toBe(bindings[2]?.signalDigest)
    expect(new Set(bindings.map((binding) => binding.signalDigest)).size)
      .toBe(5)
    expect(bindings.every((binding) => binding.value === 1)).toBe(true)
    const serializedArtifact = new TextDecoder().decode(bytes)
    for (const forbiddenKey of [
      'account',
      'cursor',
      'ownerId',
      'resourceArn',
      'tableName',
      'tenant',
    ]) {
      expect(serializedArtifact).not.toContain(`"${forbiddenKey}"`)
    }
  })

  test('rejects wrong keys, exact-line tampering, and unauthenticated clones', () => {
    const artifact = createCompleteArtifact()
    expect(() =>
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        artifact,
        new Uint8Array(32).fill(0x44),
      )).toThrow('INVALID_MIGRATION_REHEARSAL_SIGNAL_RECEIPT')

    const firstReceipt = artifact.receipts[0]
    if (firstReceipt === undefined) throw new Error('Expected first receipt.')
    const tamperedLine = firstReceipt.serializedEmfLine.replace(
      '"DescribeTableThrottleCount":1',
      '"DescribeTableThrottleCount":0',
    )
    const tampered = {
      ...artifact,
      receipts: [{ ...firstReceipt, serializedEmfLine: tamperedLine },
        ...artifact.receipts.slice(1)],
    }
    expect(() =>
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        tampered,
        signingKey,
      )).toThrow('INVALID_MIGRATION_REHEARSAL_SIGNAL_RECEIPT')

    const cloneWithFabricatedLocator = {
      ...artifact,
      evidenceLocatorDigest: 'd'.repeat(64),
    }
    expect(() =>
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        cloneWithFabricatedLocator,
        signingKey,
      )).toThrow('INVALID_MIGRATION_REHEARSAL_SIGNAL_RECEIPT')
  })

  test('rejects replayed signals, reordered time, and premature recovery', () => {
    const firstLine = createExactRehearsalLine(
      'describe-table-throttle',
      observedAtMilliseconds,
      '1'.repeat(32),
    )
    const first =
      createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact({
        serializedEmfLine: firstLine,
        authorizationBindingDigest,
        evidenceLocatorDigest,
      }, signingKey)
    expect(() =>
      createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact({
        serializedEmfLine: firstLine,
        authorizationBindingDigest,
        evidenceLocatorDigest,
        previousArtifact: first,
      }, signingKey)).toThrow(
        'INVALID_MIGRATION_REHEARSAL_SIGNAL_RECEIPT',
      )
    expect(() =>
      createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact({
        serializedEmfLine: createExactRehearsalLine(
          'recovery',
          observedAtMilliseconds + 60_000,
          '2'.repeat(32),
        ),
        authorizationBindingDigest,
        evidenceLocatorDigest,
        previousArtifact: first,
      }, signingKey)).toThrow(
        'INVALID_MIGRATION_REHEARSAL_SIGNAL_RECEIPT',
      )

    const complete = createCompleteArtifact()
    expect(() =>
      createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact({
        serializedEmfLine: createExactRehearsalLine(
          'recovery',
          observedAtMilliseconds + 10 * 60_000,
          '7'.repeat(32),
        ),
        authorizationBindingDigest,
        evidenceLocatorDigest,
        previousArtifact: complete,
      }, signingKey)).toThrow(
        'INVALID_MIGRATION_REHEARSAL_SIGNAL_RECEIPT',
      )
  })
})

describe('Workspace Search migration authenticated signal CLI', () => {
  /** Exact alarm plan authorization binding. */
  const authorizationBindingDigest = 'c'.repeat(64)
  /** Deterministic restricted alarm-purpose master key. */
  const cliKey = new Uint8Array(32).fill(0x33)
  /** Runtime HMAC authority derived from the alarm-purpose master key. */
  const cliRuntimeKey =
    deriveWorkspaceSearchMigrationRehearsalKeys(cliKey).runtimeKey
  /** Plan-declared stable exact evidence locator digest. */
  const cliEvidenceLocatorDigest =
    createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
      configurationHash,
      policyVersion,
    )

  /** Creates exact authenticated signal command arguments. */
  function createSignalCliArguments(
    signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
    index: number,
  ): string[] {
    return [
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
      '--evidence-locator-digest',
      cliEvidenceLocatorDigest,
      '--authorization-binding-digest',
      authorizationBindingDigest,
      '--permit-key-file',
      'alarm.key',
      '--output-file',
      `signal-${index}.json`,
      ...(index === 0
        ? []
        : ['--previous-receipt-file', `signal-${index - 1}.json`]),
    ]
  }

  test('requires the fixed first/previous chain and exact locator binding', () => {
    expect(parseWorkspaceSearchMigrationTelemetryRehearsalSignalCliArguments(
      createSignalCliArguments('describe-table-throttle', 0),
    )).toEqual(expect.objectContaining({
      signal: 'describe-table-throttle',
      evidenceLocatorDigest: cliEvidenceLocatorDigest,
      authorizationBindingDigest,
      outputFile: 'signal-0.json',
    }))
    expect(() =>
      parseWorkspaceSearchMigrationTelemetryRehearsalSignalCliArguments(
        createSignalCliArguments('rate-budget-exhaustion', 0),
      )).toThrow('INVALID_USAGE')
    const wrongLocator = createSignalCliArguments(
      'describe-table-throttle',
      0,
    ).map((value) =>
      value === cliEvidenceLocatorDigest ? 'd'.repeat(64) : value)
    expect(() =>
      parseWorkspaceSearchMigrationTelemetryRehearsalSignalCliArguments(
        wrongLocator,
      )).toThrow('INVALID_USAGE')
  })

  test('fsyncs each authenticated bundle before emitting the same exact line', async () => {
    const files = new Map<string, Uint8Array>()
    const events: string[] = []
    let finalArtifact:
      WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact |
      undefined
    for (const [index, signal] of
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER.entries()) {
      const standardError: string[] = []
      let keyCopy: Uint8Array | undefined
      const dependencies:
        WorkspaceSearchMigrationTelemetryRehearsalSignalCliDependencies = {
          createRecorder: (context, sink) =>
            createWorkspaceSearchMigrationTelemetryRecorder(context, {
              clock: () => observedAtMilliseconds + (index * 60_000),
              sequence: () => 1,
              correlationSource: () => String(index + 1).repeat(32),
              sink,
            }),
          readInputFile: async (path) => {
            const bytes = files.get(path)
            if (bytes === undefined) throw new Error('missing-input')
            return bytes.slice()
          },
          readPermitKeyFile: async () => {
            keyCopy = cliKey.slice()
            return keyCopy
          },
          writeOutputFileExclusive: async (path, bytes) => {
            events.push(`write:${index}`)
            files.set(path, bytes.slice())
            return 'created'
          },
          writeStandardOutput: (line) => {
            expect(files.has(`signal-${index}.json`)).toBe(true)
            events.push(`stdout:${index}`)
            expect(line).toBe(JSON.stringify(JSON.parse(line)))
          },
          writeStandardError: (line) => standardError.push(line),
        }
      expect(await runWorkspaceSearchMigrationTelemetryRehearsalSignalCli(
        createSignalCliArguments(signal, index),
        dependencies,
      )).toBe(0)
      expect(standardError).toEqual([])
      expect(keyCopy).toEqual(new Uint8Array(32))
      const bytes = files.get(`signal-${index}.json`)
      if (bytes === undefined) throw new Error('Signal output is missing.')
      finalArtifact =
        verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
          JSON.parse(new TextDecoder().decode(bytes)),
          cliRuntimeKey,
        )
      expect(finalArtifact.receipts).toHaveLength(index + 1)
    }
    expect(events).toEqual(WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER
      .flatMap((_signal, index) => [`write:${index}`, `stdout:${index}`]))
    expect(finalArtifact?.receipts.at(-1)?.signal).toBe('recovery')
  })

  test('keeps the durable bundle and reports failure when stdout ingestion fails', async () => {
    const outputs = new Map<string, Uint8Array>()
    const standardError: string[] = []
    let keyCopy = cliKey.slice()
    const dependencies:
      WorkspaceSearchMigrationTelemetryRehearsalSignalCliDependencies = {
        createRecorder: (context, sink) =>
          createWorkspaceSearchMigrationTelemetryRecorder(context, {
            clock: () => observedAtMilliseconds,
            sequence: () => 1,
            correlationSource: () => '1'.repeat(32),
            sink,
          }),
        readInputFile: async () => {
          throw new Error('unexpected-input')
        },
        readPermitKeyFile: async () => keyCopy,
        writeOutputFileExclusive: async (path, bytes) => {
          outputs.set(path, bytes.slice())
          return 'created'
        },
        writeStandardOutput: () => {
          throw new Error('raw-output-failure-canary')
        },
        writeStandardError: (line) => standardError.push(line),
      }
    expect(await runWorkspaceSearchMigrationTelemetryRehearsalSignalCli(
      createSignalCliArguments('describe-table-throttle', 0),
      dependencies,
    )).toBe(1)
    const bytes = outputs.get('signal-0.json')
    expect(bytes).toBeDefined()
    expect(keyCopy).toEqual(new Uint8Array(32))
    keyCopy = cliKey.slice()
    if (bytes === undefined) throw new Error('Durable output is missing.')
    expect(
      verifyWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact(
        JSON.parse(new TextDecoder().decode(bytes)),
        deriveWorkspaceSearchMigrationRehearsalKeys(keyCopy).runtimeKey,
      ).receipts,
    ).toHaveLength(1)
    expect(standardError).toHaveLength(1)
    expect(standardError[0]).toContain('REHEARSAL_FAILED')
    expect(standardError[0]).not.toContain('raw-output-failure-canary')
  })
})
