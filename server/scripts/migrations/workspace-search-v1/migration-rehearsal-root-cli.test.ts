import { Buffer } from 'node:buffer'
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'
import type {
  WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  WorkspaceSearchMigrationRehearsalRateRecorder,
} from './migration-rehearsal-rate-evidence'
import type {
  CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  WorkspaceSearchMigrationRehearsalRateRuntime,
} from './migration-rehearsal-rate-runtime'
import {
  parseWorkspaceSearchMigrationRehearsalRootCliArguments,
  publishWorkspaceSearchMigrationRehearsalRootCliPrivateOutput,
  runWorkspaceSearchMigrationRehearsalRootCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_CLI_RESULT_KIND,
  type WorkspaceSearchMigrationRehearsalRootCliDependencies,
  type WorkspaceSearchMigrationRehearsalRootCliPrivateOutputFormat,
} from './migration-rehearsal-root-cli'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL,
  type WorkspaceSearchMigrationRehearsalRootPlan,
} from './migration-rehearsal-root-plan'
import type {
  WorkspaceSearchMigrationRehearsalPrePermitRootSession,
} from './migration-rehearsal-pre-permit-root-session'

const account = '123456789012'
const region = 'ap-northeast-1'
const policyVersion = 'a'.repeat(64)
const configurationBindingDigest = 'b'.repeat(64)
const runtimeKeyDigest = 'c'.repeat(64)
const publicationKeyDigest = 'd'.repeat(64)

/** Failure stage selected by one AWS-free root CLI harness. */
type RootCliHarnessFailure =
  | 'attestation'
  | 'attestation-output'
  | 'existing-output'
  | 'finalizer'
  | 'flush'
  | 'plan'
  | 'policy'
  | 'root-output'

/** One detached private output captured before CLI zeroization. */
type RootCliHarnessOutput = {
  /** Exact requested final path. */
  readonly path: string
  /** Exact requested artifact format. */
  readonly format:
    WorkspaceSearchMigrationRehearsalRootCliPrivateOutputFormat
  /** Detached requested bytes. */
  readonly bytes: Uint8Array
}

/** Mutable observable state of one focused root CLI harness. */
type RootCliHarnessState = {
  /** Exact causal boundary invocation order. */
  readonly order: string[]
  /** Every raw and derived key/input buffer returned to the CLI. */
  readonly ownedBuffers: Uint8Array[]
  /** Fresh runtime construction inputs. */
  readonly runtimeInputs:
    CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput[]
  /** Root-session construction inputs retained as untrusted evidence. */
  readonly sessionInputs: unknown[]
  /** Interval-verifier inputs retained as untrusted evidence. */
  readonly intervalInputs: unknown[]
  /** Finalizer inputs retained as untrusted evidence. */
  readonly finalizerInputs: unknown[]
  /** Detached private publication requests. */
  readonly outputs: RootCliHarnessOutput[]
  /** Canonical success lines. */
  readonly stdout: string[]
  /** Canonical failure lines. */
  readonly stderr: string[]
  /** Number of root-session interruptions. */
  sessionInterruptCount: number
  /** Number of root-session explicit closes. */
  sessionCloseCount: number
  /** Number of rate-runtime closes. */
  runtimeCloseCount: number
}

/** Complete dependencies and observable state for one focused run. */
type RootCliHarness = {
  /** Injectable AWS-free root CLI boundaries. */
  readonly dependencies:
    WorkspaceSearchMigrationRehearsalRootCliDependencies
  /** Mutable observable harness state. */
  readonly state: RootCliHarnessState
}

/** Creates the sole exact ordered valid root command used by tests. */
function createRootCliArguments(): string[] {
  return [
    '--root-plan-file',
    '/private/root-plan.json',
    '--rate-policy-file',
    '/private/rate-policy.json',
    '--rehearsal-authentication-key-file',
    '/private/master.key',
    '--integrity-digest-key-file',
    '/private/integrity.key',
    '--root-rate-segment-file',
    '/private/root-rate.ndjson',
    '--resource-attestation-output-file',
    '/private/root-attestation.json',
    '--integrity-root-output-file',
    '/private/root.json',
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL,
  ]
}

/** Creates one complete trusted parsed-plan fixture. */
function createRootPlan(): WorkspaceSearchMigrationRehearsalRootPlan {
  return {
    document: {
      kind: 'mukuroji-workspace-search-migration-rehearsal-root-plan',
      version: 1,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL,
      deploymentTargetId: 'root-cli-test',
      expectedCallerArn:
        `arn:aws:sts::${account}:assumed-role/MigrationRehearsal/root-cli-test`,
      expectedConfigurationBindingDigest: configurationBindingDigest,
      requestedResources: {
        account,
        region,
        profile: 'root-cli-test',
        commit: 'e'.repeat(40),
        tables: {
          'project-directory': 'root-project-directory',
          'work-items': 'root-work-items',
          collaboration: 'root-collaboration',
          documents: 'root-documents',
          'workspace-search': 'root-workspace-search',
          'migration-state': 'root-migration-state',
        },
        journalBucket: 'root-journal-bucket',
        journalKeyArn:
          `arn:aws:kms:${region}:${account}:key/11111111-2222-4333-8444-555555555555`,
      },
      integrityResources: {
        tables: {
          'audit-events': 'root-audit-events',
          'file-proofing': 'root-file-proofing',
          'project-directory': 'root-project-directory',
          'work-item-configuration': 'root-work-item-configuration',
          'work-items': 'root-work-items',
          'workspace-access': 'root-workspace-access',
        },
        fileBucket: 'root-file-bucket',
        marker: {
          key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
          versionId: 'root-marker-version',
          checksumSha256: Buffer.alloc(32, 9).toString('base64'),
          size: 128,
        },
      },
      maximumDurationMilliseconds: 60_000,
    },
    deploymentTrustRootDigest: 'f'.repeat(64),
    productionAccountDigest: '1'.repeat(64),
    requestedResourcesBinding: '2'.repeat(64),
    configurationBindingDigest,
    allowedDescribeTableNames: Object.freeze([
      'root-project-directory',
      'root-work-items',
      'root-collaboration',
      'root-documents',
      'root-workspace-search',
      'root-migration-state',
      'root-audit-events',
      'root-file-proofing',
      'root-work-item-configuration',
      'root-workspace-access',
    ]),
  }
}

/** Creates one structurally complete reviewed rate policy. */
function createRatePolicy(): WorkspaceSearchMigrationDescribeTableRatePolicy {
  return {
    policyVersion,
    maximumAttemptsPerWindow: 100,
    maximumAttemptsPerLifecycle: 200,
    checkpointPageAttemptCapacity: 6,
    windowMilliseconds: 60_000,
    minimumAttemptIntervalMilliseconds: 100,
    minimumPageIntervalMilliseconds: 1_000,
    maximumAdmissionWaitMilliseconds: 120_000,
    throttleBackoffInitialMilliseconds: 1_000,
    throttleBackoffMaximumMilliseconds: 10_000,
  }
}

/** Creates one complete private immutable-resource attestation. */
function createResourceAttestation(): CrossDomainIntegrityResourceAttestation {
  return {
    kind: CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND,
    version: CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account,
    region,
    bucket: {
      target: 'bucket:file',
      bucketName: 'root-file-bucket',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'root-marker-version',
        checksumSha256: Buffer.alloc(32, 9).toString('base64'),
        size: 128,
      },
    },
    tables: [
      createTableAttestation('table:audit-events', 'root-audit-events'),
      createTableAttestation('table:file-proofing', 'root-file-proofing'),
      createTableAttestation(
        'table:project-directory',
        'root-project-directory',
      ),
      createTableAttestation(
        'table:work-item-configuration',
        'root-work-item-configuration',
      ),
      createTableAttestation('table:work-items', 'root-work-items'),
      createTableAttestation(
        'table:workspace-access',
        'root-workspace-access',
      ),
    ],
  }
}

/** Creates one exact DynamoDB incarnation in the private test vector. */
function createTableAttestation(
  target:
    | 'table:audit-events'
    | 'table:file-proofing'
    | 'table:project-directory'
    | 'table:work-item-configuration'
    | 'table:work-items'
    | 'table:workspace-access',
  tableName: string,
) {
  return {
    target,
    tableName,
    tableArn: `arn:aws:dynamodb:${region}:${account}:table/${tableName}`,
    tableId: `${tableName}-id`,
    creationTime: '2026-08-02T00:00:00.000Z',
  }
}

/** Creates one complete flushed ordinal-zero segment fixture. */
function createCommittedSegment(
  canonicalBytes: Uint8Array,
): WorkspaceSearchMigrationRehearsalRateCommittedSegment {
  return {
    authenticationKeyFingerprint: '3'.repeat(64),
    segmentLocatorDigest: '4'.repeat(64),
    segmentOrdinal: 0,
    firstEventSequence: 1,
    eventCount: 25,
    firstCommittedEventSequence: 1,
    lastCommittedEventSequence: 25,
    terminalRecordMac: '5'.repeat(64),
    segmentDigest: '6'.repeat(64),
    canonicalBytes,
  }
}

/** Creates one recorder-compatible no-op surface for the fake runtime. */
function createRateRecorder(
  committedSegment: WorkspaceSearchMigrationRehearsalRateCommittedSegment,
): WorkspaceSearchMigrationRehearsalRateRecorder {
  return {
    record: () => undefined,
    appendForfeitedAttempt: async () => undefined,
    appendForfeitedReservation: async () => undefined,
    flush: async () => committedSegment,
    close: async () => undefined,
  }
}

/** Creates one isolated causal root CLI harness. */
function createRootCliHarness(
  failure?: RootCliHarnessFailure,
  equalRawKeys = false,
): RootCliHarness {
  const planBytes = new Uint8Array([11])
  const policyBytes = new Uint8Array([12])
  const masterKey = new Uint8Array(32).fill(13)
  const integrityKey = new Uint8Array(32).fill(equalRawKeys ? 13 : 14)
  const runtimeKey = new Uint8Array(32).fill(15)
  const publicationKey = new Uint8Array(32).fill(16)
  const canonicalSegmentBytes = new Uint8Array([17, 18, 19])
  const committedSegment = createCommittedSegment(canonicalSegmentBytes)
  const attestation = createResourceAttestation()
  const state: RootCliHarnessState = {
    order: [],
    ownedBuffers: [],
    runtimeInputs: [],
    sessionInputs: [],
    intervalInputs: [],
    finalizerInputs: [],
    outputs: [],
    stdout: [],
    stderr: [],
    sessionInterruptCount: 0,
    sessionCloseCount: 0,
    runtimeCloseCount: 0,
  }
  const recorder = createRateRecorder(committedSegment)
  const runtime: WorkspaceSearchMigrationRehearsalRateRuntime = {
    recorder,
    flush: async () => {
      state.order.push('runtime:flush')
      if (failure === 'flush') throw new Error('raw flush failure')
      state.ownedBuffers.push(canonicalSegmentBytes)
      return committedSegment
    },
    close: async () => {
      state.order.push('runtime:close')
      state.runtimeCloseCount += 1
    },
  }
  const session: WorkspaceSearchMigrationRehearsalPrePermitRootSession = {
    takeMeasurementPort: () => {
      state.order.push('session:take-measurement')
      return Object.freeze({
        measureConfiguration: async () => {
          throw new Error('Injected measurement must own this operation.')
        },
        readDescribeTableRateEvidence: () => {
          throw new Error('Injected measurement must own this operation.')
        },
      })
    },
    attestResources: async () => {
      state.order.push('session:attest')
      if (failure === 'attestation') {
        throw new Error('raw attestation failure')
      }
      return attestation
    },
    seal: async () => {
      state.order.push('session:seal')
      return {
        startedAt: '2026-08-02T00:00:00.000Z',
        completedAt: '2026-08-02T00:00:01.000Z',
        durableEvidence: {
          version:
            WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
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
        },
        resourceAttestation: attestation,
        sequence: {
          kind:
            'mukuroji-workspace-search-migration-rehearsal-integrity-rate-sequence',
          version: 1,
          phase: 'integrity-check',
          tablePassCount: 1,
          describeTableCallCount: 6,
          firstAttemptSequence: 7,
          lastAttemptSequence: 12,
          tableOrderBindingDigest: '7'.repeat(64),
        },
      }
    },
    interrupt: () => {
      state.order.push('session:interrupt')
      state.sessionInterruptCount += 1
    },
    close: async () => {
      state.order.push('session:close')
      state.sessionCloseCount += 1
    },
  }

  const dependencies: WorkspaceSearchMigrationRehearsalRootCliDependencies = {
    readPrivateInputFile: async (path) => {
      state.order.push(`read:${path}`)
      let bytes: Uint8Array
      switch (path) {
        case '/private/root-plan.json': bytes = planBytes; break
        case '/private/rate-policy.json': bytes = policyBytes; break
        case '/private/master.key': bytes = masterKey; break
        case '/private/integrity.key': bytes = integrityKey; break
        default: throw new Error('unexpected private path')
      }
      state.ownedBuffers.push(bytes)
      return bytes
    },
    parseRootPlan: () => {
      state.order.push('plan:parse')
      if (failure === 'plan') throw new Error('raw plan failure')
      return createRootPlan()
    },
    parseRatePolicy: () => {
      state.order.push('policy:parse')
      if (failure === 'policy') throw new Error('raw policy failure')
      return createRatePolicy()
    },
    deriveKeys: () => {
      state.order.push('keys:derive')
      state.ownedBuffers.push(runtimeKey, publicationKey)
      return {
        runtimeKey,
        runtimeKeyDigest,
        publicationKey,
        publicationKeyDigest,
      }
    },
    createRateRuntime: async (input) => {
      state.order.push('runtime:create')
      state.runtimeInputs.push(input)
      return runtime
    },
    createRootSession: async (input) => {
      state.order.push('session:create')
      state.sessionInputs.push(input)
      return session
    },
    measureRootConfiguration: async () => {
      state.order.push('configuration:measure')
      return {
        configuration: Object.freeze({ measured: true }),
        capability: Object.freeze({ measured: true }),
      }
    },
    verifyIntegrityRateInterval: (input) => {
      state.order.push('interval:verify')
      state.intervalInputs.push(input)
      return Object.freeze({ interval: true })
    },
    finalizeIntegrityRoot: (input) => {
      state.order.push('root:finalize')
      state.finalizerInputs.push(input)
      if (failure === 'finalizer') throw new Error('raw finalizer failure')
      return Object.freeze({ root: true })
    },
    serializeResourceAttestation: () => {
      state.order.push('attestation:serialize')
      return '{"attestation":true}\n'
    },
    serializeIntegrityRoot: () => {
      state.order.push('root:serialize')
      return '{"root":true}\n'
    },
    assertPrivateOutputAbsent: async (path) => {
      state.order.push(`preflight:${path}`)
      if (failure === 'existing-output') {
        throw new Error('raw existing output')
      }
    },
    publishPrivateOutput: async (input) => {
      state.order.push(`publish:${input.format}`)
      if (
        (failure === 'attestation-output' &&
          input.format === 'resource-attestation') ||
        (failure === 'root-output' && input.format === 'integrity-root')
      ) throw new Error('raw output collision')
      state.outputs.push({
        path: input.path,
        format: input.format,
        bytes: input.bytes.slice(),
      })
    },
    writeStdoutLine: (line) => {
      state.order.push('stdout')
      state.stdout.push(line)
    },
    writeStderrLine: (line) => {
      state.order.push('stderr')
      state.stderr.push(line)
    },
  }
  return { dependencies, state }
}

/** Requires every expected owned buffer to contain only zeroes. */
function expectHarnessBuffersZeroized(state: RootCliHarnessState): void {
  for (const bytes of state.ownedBuffers) {
    expect(Array.from(bytes).every((byte) => byte === 0)).toBe(true)
  }
}

/** Reads one own data property from a harness-owned untrusted record. */
function readHarnessProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected harness record.')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw new Error('Expected harness data property.')
  }
  return descriptor.value
}

describe('migration rehearsal owner-only root CLI', () => {
  test('executes the exact causal root and publishes attestation before the root last', async () => {
    const harness = createRootCliHarness()
    const exitCode = await runWorkspaceSearchMigrationRehearsalRootCli(
      createRootCliArguments(),
      harness.dependencies,
    )

    expect(exitCode).toBe(0)
    expect(harness.state.order).toEqual([
      'read:/private/root-plan.json',
      'plan:parse',
      'read:/private/rate-policy.json',
      'policy:parse',
      'read:/private/master.key',
      'read:/private/integrity.key',
      'keys:derive',
      'preflight:/private/root-attestation.json',
      'preflight:/private/root.json',
      'runtime:create',
      'session:create',
      'session:take-measurement',
      'configuration:measure',
      'session:attest',
      'session:seal',
      'runtime:flush',
      'runtime:close',
      'interval:verify',
      'attestation:serialize',
      'publish:resource-attestation',
      'root:finalize',
      'root:serialize',
      'publish:integrity-root',
      'stdout',
    ])
    expect(harness.state.outputs.map((output) => output.format)).toEqual([
      'resource-attestation',
      'integrity-root',
    ])
    expect(harness.state.stdout).toEqual([
      JSON.stringify({
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_CLI_RESULT_KIND,
        status: 'succeeded',
      }),
    ])
    const runtimeInput = harness.state.runtimeInputs[0]
    expect(runtimeInput).toBeDefined()
    if (runtimeInput === undefined) throw new Error('Missing runtime input.')
    expect(Object.hasOwn(runtimeInput, 'previousSegmentFile')).toBe(false)
    const sessionInput = harness.state.sessionInputs[0]
    expect(readHarnessProperty(sessionInput, 'rootPlan')).toBeDefined()
    if (typeof sessionInput !== 'object' || sessionInput === null) {
      throw new Error('Missing session input.')
    }
    expect(Object.hasOwn(sessionInput, 'bootstrapRateCheckpoint')).toBe(false)
    expect(Object.hasOwn(sessionInput, 'recoverInterruptedCleanup')).toBe(false)
    expect(Object.hasOwn(sessionInput, 'recoverInterruptedAttempt')).toBe(false)
    const intervalInput = harness.state.intervalInputs[0]
    expect(
      readHarnessProperty(intervalInput, 'predecessorSegmentBytes'),
    ).toBeNull()
    expectHarnessBuffersZeroized(harness.state)
  })

  test('rejects stage, predecessor, recovery, reordered, and duplicate-path substitutions before I/O', async () => {
    for (const replacement of [
      '--previous-rate-segment-file',
      '--recover-interrupted-attempt',
      '--stage-manifest-file',
    ]) {
      const arguments_ = createRootCliArguments()
      arguments_[8] = replacement
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalRootCliArguments(arguments_),
      ).toThrow('INVALID_USAGE')
    }

    const harness = createRootCliHarness()
    const duplicatePathArguments = createRootCliArguments()
    duplicatePathArguments[13] = '/private/root-attestation.json'
    const exitCode = await runWorkspaceSearchMigrationRehearsalRootCli(
      duplicatePathArguments,
      harness.dependencies,
    )
    expect(exitCode).toBe(2)
    expect(harness.state.order).toEqual(['stderr'])
    expect(harness.state.runtimeInputs).toHaveLength(0)
    expect(harness.state.outputs).toHaveLength(0)
  })

  test('rejects plan, policy, and key substitution before runtime, AWS, or output', async () => {
    for (const scenario of ['plan', 'policy'] as const) {
      const harness = createRootCliHarness(scenario)
      const exitCode = await runWorkspaceSearchMigrationRehearsalRootCli(
        createRootCliArguments(),
        harness.dependencies,
      )
      expect(exitCode).toBe(1)
      expect(harness.state.runtimeInputs).toHaveLength(0)
      expect(harness.state.sessionInputs).toHaveLength(0)
      expect(harness.state.outputs).toHaveLength(0)
      expectHarnessBuffersZeroized(harness.state)
    }

    const keyHarness = createRootCliHarness(undefined, true)
    const keyExitCode = await runWorkspaceSearchMigrationRehearsalRootCli(
      createRootCliArguments(),
      keyHarness.dependencies,
    )
    expect(keyExitCode).toBe(1)
    expect(keyHarness.state.runtimeInputs).toHaveLength(0)
    expect(keyHarness.state.sessionInputs).toHaveLength(0)
    expect(keyHarness.state.outputs).toHaveLength(0)
    expectHarnessBuffersZeroized(keyHarness.state)
  })

  test('rejects an existing final output during preflight before runtime or AWS', async () => {
    const harness = createRootCliHarness('existing-output')
    const exitCode = await runWorkspaceSearchMigrationRehearsalRootCli(
      createRootCliArguments(),
      harness.dependencies,
    )
    expect(exitCode).toBe(1)
    expect(harness.state.order).toEqual([
      'read:/private/root-plan.json',
      'plan:parse',
      'read:/private/rate-policy.json',
      'policy:parse',
      'read:/private/master.key',
      'read:/private/integrity.key',
      'keys:derive',
      'preflight:/private/root-attestation.json',
      'stderr',
    ])
    expect(harness.state.runtimeInputs).toHaveLength(0)
    expect(harness.state.sessionInputs).toHaveLength(0)
    expect(harness.state.outputs).toHaveLength(0)
    expectHarnessBuffersZeroized(harness.state)
  })

  test('rejects argv, signal, and dependency traps without invoking accessors', async () => {
    const accessorArguments = createRootCliArguments()
    let argumentGetterCalled = false
    Object.defineProperty(accessorArguments, '1', {
      configurable: true,
      enumerable: true,
      get() {
        argumentGetterCalled = true
        throw new Error('raw argv getter')
      },
    })
    const argumentHarness = createRootCliHarness()
    expect(await runWorkspaceSearchMigrationRehearsalRootCli(
      accessorArguments,
      argumentHarness.dependencies,
    )).toBe(2)
    expect(argumentGetterCalled).toBe(false)
    expect(argumentHarness.state.runtimeInputs).toHaveLength(0)

    const prototypeArguments = createRootCliArguments()
    Object.setPrototypeOf(prototypeArguments, null)
    const prototypeHarness = createRootCliHarness()
    expect(await runWorkspaceSearchMigrationRehearsalRootCli(
      prototypeArguments,
      prototypeHarness.dependencies,
    )).toBe(2)
    expect(prototypeHarness.state.runtimeInputs).toHaveLength(0)

    const signalHarness = createRootCliHarness()
    let signalTrapCalled = false
    const signal = new Proxy(new AbortController().signal, {
      get() {
        signalTrapCalled = true
        throw new Error('raw signal trap')
      },
    })
    expect(await runWorkspaceSearchMigrationRehearsalRootCli(
      createRootCliArguments(),
      signalHarness.dependencies,
      signal,
    )).toBe(1)
    expect(signalTrapCalled).toBe(false)
    expect(signalHarness.state.runtimeInputs).toHaveLength(0)

    const dependencyHarness = createRootCliHarness()
    let dependencyGetterCalled = false
    Object.defineProperty(
      dependencyHarness.dependencies,
      'createRateRuntime',
      {
        configurable: true,
        enumerable: true,
        get() {
          dependencyGetterCalled = true
          throw new Error('raw dependency getter')
        },
      },
    )
    expect(await runWorkspaceSearchMigrationRehearsalRootCli(
      createRootCliArguments(),
      dependencyHarness.dependencies,
    )).toBe(1)
    expect(dependencyGetterCalled).toBe(false)
    expect(dependencyHarness.state.runtimeInputs).toHaveLength(0)
  })

  test('drains session and runtime, zeroizes buffers, and never writes a root after failures', async () => {
    for (const scenario of [
      'attestation',
      'flush',
      'finalizer',
      'attestation-output',
      'root-output',
    ] as const) {
      const harness = createRootCliHarness(scenario)
      const exitCode = await runWorkspaceSearchMigrationRehearsalRootCli(
        createRootCliArguments(),
        harness.dependencies,
      )
      expect(exitCode).toBe(1)
      expect(harness.state.sessionInterruptCount).toBe(1)
      expect(harness.state.sessionCloseCount).toBe(1)
      expect(harness.state.runtimeCloseCount).toBeGreaterThanOrEqual(1)
      expect(
        harness.state.outputs.filter(
          (output) => output.format === 'integrity-root',
        ),
      ).toHaveLength(0)
      expectHarnessBuffersZeroized(harness.state)
    }
  })

  test('secure input symlinks fail before runtime, AWS, and output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-root-cli-input-'))
    try {
      const target = join(directory, 'plan-target.json')
      const linked = join(directory, 'plan-link.json')
      await writeFile(target, new Uint8Array([1]), { mode: 0o600 })
      await chmod(target, 0o600)
      await symlink(target, linked)
      const arguments_ = createRootCliArguments()
      arguments_[1] = linked
      const harness = createRootCliHarness()
      const dependencies = {
        ...harness.dependencies,
        readPrivateInputFile:
          readWorkspaceSearchMigrationRehearsalPrivateInputFile,
      }
      const exitCode = await runWorkspaceSearchMigrationRehearsalRootCli(
        arguments_,
        dependencies,
      )
      expect(exitCode).toBe(1)
      expect(harness.state.runtimeInputs).toHaveLength(0)
      expect(harness.state.sessionInputs).toHaveLength(0)
      expect(harness.state.outputs).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('private output boundary creates mode 0600 without replacement or symlink following', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-root-cli-output-'))
    try {
      const attestation = createResourceAttestation()
      const bytes = new TextEncoder().encode(
        serializeCrossDomainIntegrityResourceAttestation(attestation),
      )
      const outputPath = join(directory, 'attestation.json')
      await publishWorkspaceSearchMigrationRehearsalRootCliPrivateOutput({
        path: outputPath,
        bytes,
        format: 'resource-attestation',
      })
      expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes)
      const status = await Bun.file(outputPath).stat()
      expect(status.mode & 0o7777).toBe(0o600)

      await expect(
        publishWorkspaceSearchMigrationRehearsalRootCliPrivateOutput({
          path: outputPath,
          bytes,
          format: 'resource-attestation',
        }),
      ).rejects.toThrow('OUTPUT_FAILED')
      expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes)

      const symlinkPath = join(directory, 'attestation-link.json')
      await symlink(outputPath, symlinkPath)
      await expect(
        publishWorkspaceSearchMigrationRehearsalRootCliPrivateOutput({
          path: symlinkPath,
          bytes,
          format: 'resource-attestation',
        }),
      ).rejects.toThrow('OUTPUT_FAILED')
      expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes)

      await chmod(directory, 0o755)
      const insecureOutputPath = join(directory, 'insecure-attestation.json')
      await expect(
        publishWorkspaceSearchMigrationRehearsalRootCliPrivateOutput({
          path: insecureOutputPath,
          bytes,
          format: 'resource-attestation',
        }),
      ).rejects.toThrow('OUTPUT_FAILED')
      expect(await Bun.file(insecureOutputPath).exists()).toBe(false)
      await chmod(directory, 0o700)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
