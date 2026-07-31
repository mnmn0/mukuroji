import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  DescribeTableCommand,
  DynamoDBClient,
  type DescribeTableCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  createWorkspaceSearchMigrationDescribeTableScopeBindingDigest,
} from './migration-describe-table-binding'
import {
  createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
  type WorkspaceSearchMigrationDescribeTableSingleAttempt,
  type WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
} from './migration-describe-table-single-attempt-aws'
import {
  createWorkspaceSearchMigrationDescribeTableRateRegistry,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
  type ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  WorkspaceSearchMigrationDescribeTableRateError,
  type WorkspaceSearchMigrationDescribeTableRateClock,
  type WorkspaceSearchMigrationDescribeTableRateDeadlineHandle,
  type WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler,
  type WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointStore,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  type WorkspaceSearchMigrationDescribeTableCheckpointPage,
  type WorkspaceSearchMigrationDescribeTableRateObservation,
  type WorkspaceSearchMigrationDescribeTableRatePolicy,
  type WorkspaceSearchMigrationDescribeTableRateRecorder,
  type WorkspaceSearchMigrationDescribeTableRateWaiter,
} from './migration-describe-table-rate-budget'

const fixtureAccount = '123456789012'
const fixtureRegion = 'ap-northeast-1'
const fixtureScopeBindingDigest =
  createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
    fixtureAccount,
    fixtureRegion,
  )
const fixtureMaximumLifecycleAttempts = 500
const fixtureCredentials = {
  accessKeyId: 'test-access-key',
  accountId: fixtureAccount,
  secretAccessKey: 'test-secret-key',
}

/** Original SDK method restored after this test module completes. */
const originalDynamoDbSend = DynamoDBClient.prototype.send

/**
 * Test-local callbacks keyed by table names that production never receives.
 */
const deterministicAttemptCallbacks =
  new Map<string, (signal: AbortSignal) => Promise<unknown>>()

/** Production transports closed after their deterministic attempts complete. */
const deterministicAttemptTransports:
  WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport[] = []

/** Monotonic table-name suffix unique within this test module. */
let deterministicAttemptSequence = 0

beforeAll(() => {
  Reflect.set(
    DynamoDBClient.prototype,
    'send',
    function (
      this: DynamoDBClient,
      ...callArguments: unknown[]
    ): unknown {
      const command = callArguments[0]
      if (command instanceof DescribeTableCommand) {
        const tableName = command.input.TableName
        const callback = tableName === undefined
          ? undefined
          : deterministicAttemptCallbacks.get(tableName)
        if (callback !== undefined && tableName !== undefined) {
          deterministicAttemptCallbacks.delete(tableName)
          return callback(
            readDeterministicAttemptAbortSignal(callArguments[1]),
          ).then(() => ({ $metadata: { attempts: 1 } }))
        }
      }
      return Reflect.apply(
        originalDynamoDbSend,
        this,
        callArguments,
      )
    },
  )
})

afterAll(() => {
  Reflect.set(
    DynamoDBClient.prototype,
    'send',
    originalDynamoDbSend,
  )
  for (const transport of deterministicAttemptTransports) {
    transport.close()
  }
  deterministicAttemptCallbacks.clear()
})

/**
 * Reads the controller-owned signal from the SDK send option.
 *
 * @param value - Untrusted second argument received by the test interceptor.
 * @returns Exact linked signal supplied by the production transport.
 */
function readDeterministicAttemptAbortSignal(
  value: unknown,
): AbortSignal {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected DescribeTable send options.')
  }
  const signal = Reflect.get(value, 'abortSignal')
  if (!(signal instanceof AbortSignal)) {
    throw new Error('Expected a DescribeTable abort signal.')
  }
  return signal
}

/**
 * Externally controlled promise used to hold one physical attempt in flight.
 */
type Deferred<Value> = {
  /** Pending promise. */
  readonly promise: Promise<Value>
  /** Resolves the pending promise. */
  readonly resolve: (value: Value) => void
}

/**
 * Externally controlled response boundary for one stored checkpoint CAS.
 */
type CheckpointWriteResponseBlock = {
  /** Settles after the selected checkpoint has been stored. */
  readonly stored: Promise<void>
  /** Releases the selected CAS response to its caller. */
  readonly release: () => void
}

/**
 * Internal deferred pair for one blocked successful checkpoint response.
 */
type PendingCheckpointWriteResponseBlock = {
  /** Notifies the test after durable storage. */
  readonly stored: Deferred<void>
  /** Holds the successful response until explicitly released. */
  readonly response: Deferred<void>
}

/**
 * Creates one externally controlled promise.
 *
 * @returns Pending promise and guarded resolver.
 */
function createDeferred<Value>(): Deferred<Value> {
  let resolver: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve
  })
  return {
    promise,
    resolve: (value: Value): void => {
      if (resolver === undefined) {
        throw new Error('Deferred resolver is unavailable.')
      }
      resolver(value)
    },
  }
}

/**
 * Deterministic monotonic clock, waiter, and observation sink.
 */
class DeterministicRateHarness
  implements
    WorkspaceSearchMigrationDescribeTableRateWaiter,
    WorkspaceSearchMigrationDescribeTableRateRecorder,
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore {
  /** Current fake monotonic time. */
  private nowMilliseconds = 0

  /** Exact waits requested by the rate ledger. */
  readonly waits: number[] = []

  /** Exact sanitized observations emitted by the rate ledger. */
  readonly observations: WorkspaceSearchMigrationDescribeTableRateObservation[] =
    []

  /** Durable checkpoints keyed only by an opaque scope binding. */
  private readonly checkpoints =
    new Map<string, WorkspaceSearchMigrationDescribeTableRateCheckpoint>()

  /** Whether the next successful CAS loses its response after storing. */
  private loseNextSuccessfulWriteResponse = false

  /** Whether the next CAS rejects before changing durable state. */
  private rejectNextWriteBeforeStore = false

  /** Whether the next checkpoint timestamp read rejects. */
  private rejectNextEpochRead = false

  /** Optional response block consumed by the next successful CAS. */
  private nextWriteResponseBlock:
    PendingCheckpointWriteResponseBlock | undefined

  /** Fake elapsed time applied by the next successful CAS. */
  private nextWriteElapsedMilliseconds = 0

  /** Fake monotonic clock injected into the registry. */
  readonly clock: WorkspaceSearchMigrationDescribeTableRateClock = () =>
    this.nowMilliseconds

  /** Fake epoch clock with an optional one-shot deterministic failure. */
  readonly epochClock: WorkspaceSearchMigrationDescribeTableRateClock =
    () => {
      if (this.rejectNextEpochRead) {
        this.rejectNextEpochRead = false
        throw new Error('RAW-EPOCH-CLOCK-FAILURE-CANARY')
      }
      return this.nowMilliseconds
    }

  /**
   * Advances fake time by the requested delay without using a real timer.
   *
   * @param delayMilliseconds - Exact bounded admission delay.
   * @param signal - Cancellation signal for work that has not started.
   */
  async wait(
    delayMilliseconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new Error('The deterministic wait was interrupted.')
    }
    this.waits.push(delayMilliseconds)
    this.nowMilliseconds += delayMilliseconds
  }

  /**
   * Records one already sanitized observation.
   *
   * @param observation - Fixed-shape rate observation.
   */
  record(
    observation: WorkspaceSearchMigrationDescribeTableRateObservation,
  ): void {
    this.observations.push(observation)
  }

  /**
   * Reads one current deterministic durable checkpoint.
   *
   * @param scopeBindingDigest - Opaque scope binding.
   * @returns Current checkpoint, or undefined when absent.
   */
  load(scopeBindingDigest: string): Promise<unknown | undefined> {
    return Promise.resolve(this.checkpoints.get(scopeBindingDigest))
  }

  /**
   * Applies one exact-predecessor deterministic checkpoint CAS.
   *
   * @param write - Expected revision and successor checkpoint.
   * @returns Stored on an exact match, otherwise conflict.
   */
  async compareAndSwap(
    write: WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  ): Promise<'stored' | 'conflict'> {
    if (this.rejectNextWriteBeforeStore) {
      this.rejectNextWriteBeforeStore = false
      throw new Error('RAW-CHECKPOINT-WRITE-FAILURE-CANARY')
    }
    const current = this.checkpoints.get(write.scopeBindingDigest)
    const currentRevision = current?.revision ?? null
    if (
      currentRevision !== write.expectedRevision ||
      (
        current !== undefined &&
        write.checkpoint.fenceToken < current.fenceToken
      )
    ) {
      return 'conflict'
    }
    this.checkpoints.set(
      write.scopeBindingDigest,
      write.checkpoint,
    )
    if (this.nextWriteElapsedMilliseconds > 0) {
      this.advance(this.nextWriteElapsedMilliseconds)
      this.nextWriteElapsedMilliseconds = 0
    }
    const responseBlock = this.nextWriteResponseBlock
    if (responseBlock !== undefined) {
      this.nextWriteResponseBlock = undefined
      responseBlock.stored.resolve(undefined)
      await responseBlock.response.promise
    }
    if (this.loseNextSuccessfulWriteResponse) {
      this.loseNextSuccessfulWriteResponse = false
      throw new Error('RAW-CHECKPOINT-RESPONSE-LOSS-CANARY')
    }
    return 'stored'
  }

  /**
   * Reads one typed checkpoint for write-ahead assertions.
   *
   * @param scopeBindingDigest - Opaque deterministic scope binding.
   * @returns Current typed checkpoint, when present.
   */
  readCheckpoint(
    scopeBindingDigest = fixtureScopeBindingDigest,
  ): WorkspaceSearchMigrationDescribeTableRateCheckpoint | undefined {
    return this.checkpoints.get(scopeBindingDigest)
  }

  /**
   * Makes the next stored CAS reject to simulate response loss.
   */
  loseNextWriteResponse(): void {
    this.loseNextSuccessfulWriteResponse = true
  }

  /**
   * Makes the next checkpoint CAS reject before storing its successor.
   */
  rejectNextWrite(): void {
    this.rejectNextWriteBeforeStore = true
  }

  /**
   * Makes the next checkpoint timestamp read reject once.
   */
  rejectNextEpochClockRead(): void {
    this.rejectNextEpochRead = true
  }

  /**
   * Blocks the response from the next successful CAS after it is stored.
   *
   * @returns Durable-storage notification and explicit response release.
   */
  blockNextWriteResponse(): CheckpointWriteResponseBlock {
    if (this.nextWriteResponseBlock !== undefined) {
      throw new Error('A checkpoint response is already blocked.')
    }
    const stored = createDeferred<void>()
    const response = createDeferred<void>()
    this.nextWriteResponseBlock = { stored, response }
    return {
      stored: stored.promise,
      release: (): void => response.resolve(undefined),
    }
  }

  /**
   * Advances the fake clock inside the next successful checkpoint CAS.
   *
   * @param elapsedMilliseconds - Exact simulated durable-store latency.
   */
  elapseDuringNextWrite(elapsedMilliseconds: number): void {
    this.nextWriteElapsedMilliseconds = elapsedMilliseconds
  }

  /**
   * Reads current fake time.
   *
   * @returns Current monotonic milliseconds.
   */
  readNow(): number {
    return this.nowMilliseconds
  }

  /**
   * Advances fake time for a separately controlled admission deadline.
   *
   * @param delayMilliseconds - Exact scheduled deadline duration.
   */
  advance(delayMilliseconds: number): void {
    this.nowMilliseconds += delayMilliseconds
  }
}

/**
 * Pending deterministic admission deadline.
 */
type ScheduledDeadline = {
  /** Exact requested duration. */
  readonly delayMilliseconds: number
  /** Deadline callback supplied by the registry. */
  readonly callback: () => void
  /** Whether the operation already canceled this deadline. */
  canceled: boolean
}

/**
 * Manually fired deadline scheduler for unresolved barrier and FIFO tests.
 */
class DeterministicDeadlineScheduler
  implements WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler {
  /** Deadlines retained in creation order. */
  private readonly deadlines: ScheduledDeadline[] = []

  /** Harness advanced when one active deadline fires. */
  private readonly harness: DeterministicRateHarness

  /**
   * Creates a scheduler attached to the fake clock.
   *
   * @param harness - Deterministic clock advanced on manual expiry.
   */
  constructor(harness: DeterministicRateHarness) {
    this.harness = harness
  }

  /**
   * Retains one callback until a test fires it.
   *
   * @param delayMilliseconds - Exact total admission bound.
   * @param callback - Deadline callback owned by the registry.
   * @returns Handle that marks the retained deadline canceled.
   */
  schedule(
    delayMilliseconds: number,
    callback: () => void,
  ): WorkspaceSearchMigrationDescribeTableRateDeadlineHandle {
    const deadline: ScheduledDeadline = {
      delayMilliseconds,
      callback,
      canceled: false,
    }
    this.deadlines.push(deadline)
    return {
      cancel: (): void => {
        deadline.canceled = true
      },
    }
  }

  /**
   * Fires the oldest deadline that has not been canceled.
   */
  fireNextActive(): void {
    const deadline = this.deadlines.find(
      (candidate) => !candidate.canceled,
    )
    if (deadline === undefined) {
      throw new Error('No active deterministic deadline is available.')
    }
    deadline.canceled = true
    this.harness.advance(deadline.delayMilliseconds)
    deadline.callback()
  }
}

/**
 * Read-only untrusted checkpoint store used by parser rejection tests.
 */
class StaticCheckpointStore
  implements WorkspaceSearchMigrationDescribeTableRateCheckpointStore {
  /** Untrusted value returned for every load. */
  private readonly value: unknown

  /**
   * Creates a store returning one fixed untrusted value.
   *
   * @param value - Value supplied to the production checkpoint parser.
   */
  constructor(value: unknown) {
    this.value = value
  }

  /**
   * Returns the fixed untrusted value.
   *
   * @returns Fixed parser input.
   */
  load(): Promise<unknown> {
    return Promise.resolve(this.value)
  }

  /**
   * Rejects writes because invalid inputs must fail before CAS.
   *
   * @returns Conflict if an unexpected write reaches this store.
   */
  compareAndSwap(): Promise<'conflict'> {
    return Promise.resolve('conflict')
  }
}

/**
 * Checkpoint store that stalls one scope load while delegating all other work.
 */
class SelectivelyStalledCheckpointStore
  implements WorkspaceSearchMigrationDescribeTableRateCheckpointStore {
  /** Opaque scope whose durable load never settles. */
  private readonly stalledScopeBindingDigest: string

  /** Deterministic durable store used by every non-stalled operation. */
  private readonly delegate: DeterministicRateHarness

  /**
   * Creates one scope-selective stalled load.
   *
   * @param stalledScopeBindingDigest - Exact opaque key to stall.
   * @param delegate - Store used for other loads and every CAS.
   */
  constructor(
    stalledScopeBindingDigest: string,
    delegate: DeterministicRateHarness,
  ) {
    this.stalledScopeBindingDigest = stalledScopeBindingDigest
    this.delegate = delegate
  }

  /**
   * Loads a checkpoint unless the selected scope must remain pending.
   *
   * @param scopeBindingDigest - Opaque requested scope.
   * @returns Current checkpoint or a deliberately unsettled promise.
   */
  load(scopeBindingDigest: string): Promise<unknown | undefined> {
    if (scopeBindingDigest === this.stalledScopeBindingDigest) {
      return new Promise<unknown>(() => {})
    }
    return this.delegate.load(scopeBindingDigest)
  }

  /**
   * Delegates one exact checkpoint CAS.
   *
   * @param write - Exact predecessor and immutable successor.
   * @returns Stored or conflict from the deterministic store.
   */
  compareAndSwap(
    write: WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  ): Promise<'stored' | 'conflict'> {
    return this.delegate.compareAndSwap(write)
  }
}

/**
 * Creates one valid explicit policy with optional test-specific values.
 *
 * @param overrides - Policy fields replaced for one test.
 * @returns Detached valid rate policy.
 */
function createPolicy(
  overrides: Partial<WorkspaceSearchMigrationDescribeTableRatePolicy> = {},
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  return {
    policyVersion: 'a'.repeat(64),
    maximumAttemptsPerWindow:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
    maximumAttemptsPerLifecycle: fixtureMaximumLifecycleAttempts,
    checkpointPageAttemptCapacity:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
    windowMilliseconds: 1_000,
    minimumAttemptIntervalMilliseconds: 1,
    minimumPageIntervalMilliseconds: 10,
    maximumAdmissionWaitMilliseconds: 2_000,
    throttleBackoffInitialMilliseconds: 100,
    throttleBackoffMaximumMilliseconds: 400,
    ...overrides,
  }
}

/**
 * Creates one explicit deterministic scope claim.
 *
 * @param overrides - Claim fields replaced for one test.
 * @returns Complete bootstrap claim by default.
 */
function createClaim(
  overrides:
    Partial<ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput> = {},
): ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput {
  return {
    account: fixtureAccount,
    region: fixtureRegion,
    fenceToken: 1,
    bootstrap: true,
    recoverInterruptedCleanup: false,
    recoverInterruptedAttempt: false,
    ...overrides,
  }
}

/**
 * Wraps one deterministic callback in the nominal single-attempt capability.
 *
 * @param attempt - Exact callback invoked at most once by the controller.
 * @param account - Test account bound to the attempt.
 * @param region - Test region bound to the attempt.
 * @returns One-shot attempt accepted only by the matching ledger.
 */
function createAttempt(
  attempt: (signal: AbortSignal) => Promise<unknown>,
  account = fixtureAccount,
  region = fixtureRegion,
): WorkspaceSearchMigrationDescribeTableSingleAttempt<
  DescribeTableCommandOutput
> {
  deterministicAttemptSequence += 1
  const tableName =
    `codex-rate-test-${deterministicAttemptSequence}`
  deterministicAttemptCallbacks.set(tableName, attempt)
  const transport =
    createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport(
      {
        account,
        credentials: fixtureCredentials,
        region,
      },
    )
  deterministicAttemptTransports.push(transport)
  return transport.createAttempt(tableName)
}

/**
 * Captures one stable asynchronous rate error without matching raw messages.
 *
 * @param operation - Operation expected to stop fail closed.
 * @returns Stable rate error raised by the operation.
 */
async function captureRateError(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationDescribeTableRateError> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationDescribeTableRateError) {
      return error
    }
    throw error
  }
  throw new Error('Expected the rate operation to stop.')
}

/**
 * Captures one stable synchronous rate error.
 *
 * @param operation - Operation expected to fail before returning.
 * @returns Stable rate error raised by the operation.
 */
function captureSynchronousRateError(
  operation: () => unknown,
): WorkspaceSearchMigrationDescribeTableRateError {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationDescribeTableRateError) {
      return error
    }
    throw error
  }
  throw new Error('Expected the rate operation to stop synchronously.')
}

/**
 * Allows already queued promise continuations to run without a real timer.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Verifies one public capability exposes no mutable instance state.
 *
 * @param capability - Lifecycle, page, or cleanup capability under test.
 */
function expectOpaqueFrozenCapability(capability: object): void {
  expect(Reflect.ownKeys(capability)).toEqual([])
  expect(Object.isFrozen(capability)).toBeTrue()
  expect(
    Reflect.defineProperty(capability, 'injectedState', {
      configurable: true,
      enumerable: true,
      value: 'must-not-stick',
      writable: true,
    }),
  ).toBeFalse()
  const prototype = Reflect.getPrototypeOf(capability)
  if (prototype === null) {
    throw new Error('Expected one frozen capability prototype.')
  }
  expect(Object.isFrozen(prototype)).toBeTrue()
  expect(
    Reflect.defineProperty(prototype, 'injectedMethod', {
      configurable: true,
      enumerable: false,
      value: (): void => {},
      writable: true,
    }),
  ).toBeFalse()
  const constructorDescriptor =
    Reflect.getOwnPropertyDescriptor(prototype, 'constructor')
  const capabilityConstructor = constructorDescriptor?.value
  if (typeof capabilityConstructor !== 'function') {
    throw new Error('Expected one capability constructor.')
  }
  expect(Object.isFrozen(capabilityConstructor)).toBeTrue()
  expect(() =>
    Reflect.construct(capabilityConstructor, []),
  ).toThrow('Invalid DescribeTable capability construction.')
}

describe('Workspace Search migration DescribeTable rate budget', () => {
  test('rejects invalid policy and scope before callbacks', async () => {
    const invalidHarness = new DeterministicRateHarness()
    const invalidPolicyError = captureSynchronousRateError(() =>
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({
          maximumAttemptsPerLifecycle:
            WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
            1,
        }),
        checkpointStore: invalidHarness,
      }))
    expect(invalidPolicyError.reason).toBe('invalid-lifecycle')
    const missingRecoveryHeadroom = captureSynchronousRateError(() =>
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({
          maximumAttemptsPerLifecycle:
            WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
        }),
        checkpointStore: invalidHarness,
      }))
    expect(missingRecoveryHeadroom.reason).toBe('invalid-lifecycle')

    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    for (const invalidClaim of [
      createClaim({ account: '123' }),
      createClaim({ region: 'INVALID_REGION' }),
      createClaim({ fenceToken: -1 }),
    ]) {
      const error = await captureRateError(() =>
        registry.claim(invalidClaim))
      expect(error.reason).toBe('invalid-lifecycle')
    }

  })

  test('requires explicit bootstrap and persists write-ahead reservations before callbacks', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const missingCheckpointError = await captureRateError(() =>
      registry.claim(createClaim({ bootstrap: false })))
    expect(missingCheckpointError.reason).toBe('invalid-lifecycle')

    const lifecycle = await registry.claim(createClaim())
    expect(lifecycle.readCheckpoint()).toMatchObject({
      revision: 0,
      attemptCount: 0,
      forfeitedAttemptCount: 0,
      reservedAttempts: 0,
      reservationKind: 'none',
    })
    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        expect(harness.readCheckpoint()).toMatchObject({
          attemptCount: 1,
          reservedAttempts: 0,
          reservationKind: 'none',
        })
      }),
    )
    await lifecycle.runCheckpointPage(
      {},
      async () => {
        expect(harness.readCheckpoint()).toMatchObject({
          attemptCount: 1,
          reservedAttempts:
            WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
          reservationKind: 'checkpoint-page',
        })
      },
    )
    expect(lifecycle.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      forfeitedAttemptCount: 0,
      reservedAttempts: 0,
      reservationKind: 'none',
    })
    const serialized = JSON.stringify(lifecycle.readCheckpoint())
    expect(serialized).not.toContain(fixtureAccount)
    expect(serialized).not.toContain(fixtureRegion)
  })

  test('binds nominal one-shot attempts to the canonical account and region ledger', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    let callbacks = 0
    const wrongRegion = await captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(
          async () => {
            callbacks += 1
          },
          fixtureAccount,
          'us-east-1',
        ),
      ))
    expect(wrongRegion.reason).toBe('invalid-lifecycle')
    expect(callbacks).toBe(0)
    expect(lifecycle.readEvidence().attemptCount).toBe(0)

    const oneShot = createAttempt(async () => {
      callbacks += 1
      return 'once'
    })
    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      oneShot,
    )
    const reused = await captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        oneShot,
      ))
    expect(reused.reason).toBe('invalid-lifecycle')
    expect(callbacks).toBe(1)
    expect(lifecycle.readEvidence().attemptCount).toBe(1)
  })

  test('recovers an exact checkpoint after a stored CAS response is lost', async () => {
    const harness = new DeterministicRateHarness()
    harness.loseNextWriteResponse()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    expect(lifecycle.readCheckpoint().revision).toBe(0)

    harness.loseNextWriteResponse()
    let callbacks = 0
    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        callbacks += 1
      }),
    )
    expect(callbacks).toBe(1)
    expect(lifecycle.readCheckpoint()).toMatchObject({
      revision: 2,
      attemptCount: 1,
    })
    expect(JSON.stringify({
      checkpoint: lifecycle.readCheckpoint(),
      observations: harness.observations,
    })).not.toContain('RAW-CHECKPOINT-RESPONSE-LOSS-CANARY')
  })

  test('rejects mismatched, stale, accessor, and extra-field checkpoints', async () => {
    const sourceHarness = new DeterministicRateHarness()
    const policy = createPolicy()
    const source = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: sourceHarness,
        clock: sourceHarness.clock,
        epochClock: sourceHarness.clock,
        waiter: sourceHarness,
        recorder: sourceHarness,
        random: () => 0,
      }).claim(createClaim())
    const checkpoint = source.readCheckpoint()
    let accessorReads = 0
    const accessorCheckpoint = { ...checkpoint }
    Object.defineProperty(accessorCheckpoint, 'attemptCount', {
      enumerable: true,
      get: (): number => {
        accessorReads += 1
        return 0
      },
    })
    const nonEnumerableExtraCheckpoint = { ...checkpoint }
    Object.defineProperty(
      nonEnumerableExtraCheckpoint,
      'hiddenState',
      {
        enumerable: false,
        value: 'must-be-rejected',
      },
    )
    const symbolExtraCheckpoint = { ...checkpoint }
    Object.defineProperty(
      symbolExtraCheckpoint,
      Symbol('hidden-state'),
      {
        enumerable: false,
        value: 'must-be-rejected',
      },
    )
    const invalidCases: ReadonlyArray<{
      readonly value: unknown
      readonly claim:
        ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput
    }> = [
      {
        value: { ...checkpoint, unexpected: true },
        claim: createClaim({ fenceToken: 2, bootstrap: false }),
      },
      {
        value: {
          ...checkpoint,
          policy: createPolicy({
            minimumAttemptIntervalMilliseconds: 2,
          }),
        },
        claim: createClaim({ fenceToken: 2, bootstrap: false }),
      },
      {
        value: {
          ...checkpoint,
          scopeBindingDigest: 'd'.repeat(64),
        },
        claim: createClaim({ fenceToken: 2, bootstrap: false }),
      },
      {
        value: checkpoint,
        claim: createClaim({ fenceToken: 1, bootstrap: false }),
      },
      {
        value: accessorCheckpoint,
        claim: createClaim({ fenceToken: 2, bootstrap: false }),
      },
      {
        value: nonEnumerableExtraCheckpoint,
        claim: createClaim({ fenceToken: 2, bootstrap: false }),
      },
      {
        value: symbolExtraCheckpoint,
        claim: createClaim({ fenceToken: 2, bootstrap: false }),
      },
    ]

    for (const invalidCase of invalidCases) {
      const harness = new DeterministicRateHarness()
      const registry =
        createWorkspaceSearchMigrationDescribeTableRateRegistry({
          policy,
          checkpointStore: new StaticCheckpointStore(
            invalidCase.value,
          ),
          clock: harness.clock,
          epochClock: harness.clock,
          waiter: harness,
          recorder: harness,
          random: () => 0,
        })
      const error = await captureRateError(() =>
        registry.claim(invalidCase.claim))
      expect(error.reason).toBe('invalid-lifecycle')
    }
    expect(accessorReads).toBe(0)

    let proxyGetReads = 0
    const descriptorCheckpoint = new Proxy(
      { ...checkpoint },
      {
        get: (target, property): unknown => {
          if (property === 'then') return undefined
          proxyGetReads += 1
          if (property === 'attemptCount') return -1
          return Reflect.get(target, property)
        },
      },
    )
    const descriptorHarness = new DeterministicRateHarness()
    const descriptorError = await captureRateError(() =>
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: new StaticCheckpointStore(
          descriptorCheckpoint,
        ),
        clock: descriptorHarness.clock,
        epochClock: descriptorHarness.clock,
        waiter: descriptorHarness,
        recorder: descriptorHarness,
        random: () => 0,
      }).claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
      })))
    expect(descriptorError.reason).toBe('taken-over')
    expect(proxyGetReads).toBe(0)
  })

  test('forfeits a crashed page reservation and applies a full cold-start horizon on restart', async () => {
    const harness = new DeterministicRateHarness()
    const policy = createPolicy()
    const original = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const pageStarted = createDeferred<void>()
    const releaseCrashedPage = createDeferred<void>()
    const originalPage = captureRateError(() =>
      original.runCheckpointPage(
        {},
        async () => {
          pageStarted.resolve(undefined)
          await releaseCrashedPage.promise
        },
      ))
    await pageStarted.promise
    expect(harness.readCheckpoint()).toMatchObject({
      attemptCount: 0,
      forfeitedAttemptCount: 0,
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservationKind: 'checkpoint-page',
    })

    const recovered = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
      }))
    expect(recovered.readCheckpoint()).toMatchObject({
      attemptCount: 0,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservedAttempts: 0,
      reservationKind: 'none',
    })
    let recoveredCallbacks = 0
    await recovered.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        recoveredCallbacks += 1
      }),
    )
    expect(recoveredCallbacks).toBe(1)
    expect(harness.waits).toEqual([1_000])
    expect(recovered.readEvidence()).toMatchObject({
      attemptCount: 1,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
    })

    releaseCrashedPage.resolve(undefined)
    expect((await originalPage).reason).toBe('taken-over')
  })

  test('fails closed with a finite retry when the restart horizon exceeds admission time', async () => {
    const harness = new DeterministicRateHarness()
    const policy = createPolicy({
      maximumAdmissionWaitMilliseconds: 500,
    })
    await createWorkspaceSearchMigrationDescribeTableRateRegistry({
      policy,
      checkpointStore: harness,
      clock: harness.clock,
      epochClock: harness.clock,
      waiter: harness,
      recorder: harness,
      random: () => 0,
    }).claim(createClaim())
    const recovered = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
      }))
    let callbacks = 0

    const error = await captureRateError(() =>
      recovered.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          callbacks += 1
        }),
      ))
    expect(error.reason).toBe('cadence-bound')
    expect(callbacks).toBe(0)
    expect(harness.observations.at(-1)).toMatchObject({
      kind: 'budget-stop',
      reason: 'cadence-bound',
      retryAfterMilliseconds: 1_000,
    })
  })

  test('rejects CAS latency beyond the absolute attempt and page deadline', async () => {
    const attemptHarness = new DeterministicRateHarness()
    const attemptLifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({
          maximumAdmissionWaitMilliseconds: 20,
        }),
        checkpointStore: attemptHarness,
        clock: attemptHarness.clock,
        epochClock: attemptHarness.clock,
        waiter: attemptHarness,
        recorder: attemptHarness,
        random: () => 0,
      }).claim(createClaim())
    attemptHarness.elapseDuringNextWrite(100)
    let attemptCallbacks = 0
    const attemptError = await captureRateError(() =>
      attemptLifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          attemptCallbacks += 1
        }),
      ))
    expect(attemptError.reason).toBe('cadence-bound')
    expect(attemptCallbacks).toBe(0)
    expect(attemptHarness.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: true,
    })
    expect(
      attemptHarness.observations.filter(
        (observation) => observation.kind === 'attempt',
      ),
    ).toHaveLength(0)
    expect(attemptLifecycle.readEvidence()).toMatchObject({
      attemptCount: 1,
      maximumInFlight: 1,
    })

    const pageHarness = new DeterministicRateHarness()
    const pageRegistry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({
          maximumAdmissionWaitMilliseconds: 20,
        }),
        checkpointStore: pageHarness,
        clock: pageHarness.clock,
        epochClock: pageHarness.clock,
        waiter: pageHarness,
        recorder: pageHarness,
        random: () => 0,
      })
    const pageLifecycle = await pageRegistry.claim(createClaim())
    pageHarness.elapseDuringNextWrite(100)
    let pageCallbacks = 0
    const pageError = await captureRateError(() =>
      pageLifecycle.runCheckpointPage(
        {},
        async () => {
          pageCallbacks += 1
        },
      ))
    expect(pageError.reason).toBe('cadence-bound')
    expect(pageCallbacks).toBe(0)
    expect(pageHarness.readCheckpoint()).toMatchObject({
      attemptCount: 0,
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservationKind: 'checkpoint-page',
    })
    const recoveredPageLifecycle = await pageRegistry.claim(
      createClaim({
        fenceToken: 2,
        bootstrap: false,
      }),
    )
    expect(recoveredPageLifecycle.readCheckpoint()).toMatchObject({
      fenceToken: 2,
      attemptCount: 0,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservedAttempts: 0,
      reservationKind: 'none',
    })
  })

  test('measures attempt and page cadence from their post-CAS physical start', async () => {
    const attemptHarness = new DeterministicRateHarness()
    const attemptLifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({
          maximumAdmissionWaitMilliseconds: 500,
          minimumAttemptIntervalMilliseconds: 100,
        }),
        checkpointStore: attemptHarness,
        clock: attemptHarness.clock,
        epochClock: attemptHarness.clock,
        waiter: attemptHarness,
        recorder: attemptHarness,
        random: () => 0,
      }).claim(createClaim())
    const attemptStarts: number[] = []
    attemptHarness.elapseDuringNextWrite(90)
    await attemptLifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        attemptStarts.push(attemptHarness.readNow())
      }),
    )
    await attemptLifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        attemptStarts.push(attemptHarness.readNow())
      }),
    )
    expect(attemptStarts).toEqual([90, 190])
    expect(attemptHarness.waits).toEqual([100])
    expect(
      attemptHarness.observations
        .filter((observation) => observation.kind === 'attempt')
        .map((observation) => observation.observedAtMilliseconds),
    ).toEqual([90, 190])

    const pageHarness = new DeterministicRateHarness()
    const pageLifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({
          maximumAdmissionWaitMilliseconds: 500,
          minimumPageIntervalMilliseconds: 100,
        }),
        checkpointStore: pageHarness,
        clock: pageHarness.clock,
        epochClock: pageHarness.clock,
        waiter: pageHarness,
        recorder: pageHarness,
        random: () => 0,
      }).claim(createClaim())
    const pageStarts: number[] = []
    pageHarness.elapseDuringNextWrite(90)
    await pageLifecycle.runCheckpointPage(
      {},
      async () => {
        pageStarts.push(pageHarness.readNow())
      },
    )
    await pageLifecycle.runCheckpointPage(
      {},
      async () => {
        pageStarts.push(pageHarness.readNow())
      },
    )
    expect(pageStarts).toEqual([90, 190])
    expect(pageHarness.waits).toEqual([100])
  })

  test('accepts an equal integer clock sample after a valid cadence wait', async () => {
    const harness = new DeterministicRateHarness()
    const waits: number[] = []
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: {
          /**
           * Keeps the first completed timer within the same integer clock tick.
           *
           * @param delayMilliseconds - Requested cadence delay.
           * @param signal - Cancellation signal for pending admission.
           */
          async wait(
            delayMilliseconds: number,
            signal: AbortSignal,
          ): Promise<void> {
            waits.push(delayMilliseconds)
            if (waits.length > 1) {
              await harness.wait(delayMilliseconds, signal)
            }
          },
        },
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    let attemptCallbacks = 0
    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        attemptCallbacks += 1
      }),
    )
    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        attemptCallbacks += 1
      }),
    )

    expect(attemptCallbacks).toBe(2)
    expect(waits).toEqual([1, 1])
  })

  test('bounds a waiter that repeatedly completes within one integer clock tick', async () => {
    const harness = new DeterministicRateHarness()
    const waits: number[] = []
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: {
          /**
           * Completes without advancing the injected integer clock.
           *
           * @param delayMilliseconds - Requested cadence delay.
           */
          async wait(delayMilliseconds: number): Promise<void> {
            waits.push(delayMilliseconds)
          },
        },
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    let attemptCallbacks = 0
    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        attemptCallbacks += 1
      }),
    )
    const sameTickError = await captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          attemptCallbacks += 1
        }),
      ))

    expect(sameTickError.reason).toBe('invalid-lifecycle')
    expect(attemptCallbacks).toBe(1)
    expect(waits).toEqual([1, 1])
    expect(lifecycle.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: false,
    })
  })

  test('bounds the extra integer-clock wait by the admission deadline', async () => {
    const harness = new DeterministicRateHarness()
    const deadlineScheduler =
      new DeterministicDeadlineScheduler(harness)
    const extraWaitStarted = createDeferred<void>()
    const waits: number[] = []
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: {
          /**
           * Leaves the extra clock-quantum wait unresolved for deadline expiry.
           *
           * @param delayMilliseconds - Requested cadence delay.
           */
          async wait(delayMilliseconds: number): Promise<void> {
            waits.push(delayMilliseconds)
            if (waits.length > 1) {
              extraWaitStarted.resolve(undefined)
              await new Promise<never>(() => {})
            }
          },
        },
        deadlineScheduler,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    let attemptCallbacks = 0
    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        attemptCallbacks += 1
      }),
    )
    const boundedAttempt = captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          attemptCallbacks += 1
        }),
      ))
    await extraWaitStarted.promise
    deadlineScheduler.fireNextActive()
    const deadlineError = await boundedAttempt

    expect(deadlineError.reason).toBe('cadence-bound')
    expect(attemptCallbacks).toBe(1)
    expect(waits).toEqual([1, 1])
    expect(lifecycle.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: false,
    })
  })

  test('records a charged physical attempt before a synchronous transport failure', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const transportFailure =
      new Error('DETERMINISTIC-SYNCHRONOUS-TRANSPORT-FAILURE')

    await expect(
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(() => {
          throw transportFailure
        }),
      ),
    ).rejects.toBe(transportFailure)
    expect(
      harness.observations.filter(
        (observation) => observation.kind === 'attempt',
      ),
    ).toHaveLength(1)
    expect(lifecycle.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: false,
    })
  })

  test('invokes transport before a reentrant attempt observer can interrupt it', async () => {
    const harness = new DeterministicRateHarness()
    const events: string[] = []
    let interruptAfterObservation = (): void => {}
    const recorder: WorkspaceSearchMigrationDescribeTableRateRecorder = {
      /** Records the event and interrupts only after an actual start event. */
      record(
        observation:
          WorkspaceSearchMigrationDescribeTableRateObservation,
      ): void {
        harness.record(observation)
        if (observation.kind !== 'attempt') return
        events.push('observer')
        interruptAfterObservation()
      },
    }
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder,
        random: () => 0,
      }).claim(createClaim())
    interruptAfterObservation = (): void => lifecycle.interrupt()

    const error = await captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          events.push('transport')
        }),
      ))
    expect(events).toEqual(['transport', 'observer'])
    expect(error.reason).toBe('interrupted')
  })

  test('rechecks page state after external deadline cancellation', async () => {
    const harness = new DeterministicRateHarness()
    let cancelEffect = (): void => {}
    const deadlineScheduler:
      WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler = {
        /** Creates a deterministic handle whose cancellation is observable. */
        schedule(): WorkspaceSearchMigrationDescribeTableRateDeadlineHandle {
          return {
            /** Applies the configured synchronous cancellation effect. */
            cancel(): void {
              cancelEffect()
            },
          }
        },
      }
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        deadlineScheduler,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    cancelEffect = (): void => lifecycle.quarantine()
    let pageCallbacks = 0

    const error = await captureRateError(() =>
      lifecycle.runCheckpointPage(
        {},
        async () => {
          pageCallbacks += 1
        },
      ))
    expect(error.reason).toBe('quarantined')
    expect(pageCallbacks).toBe(0)
    expect(harness.readCheckpoint()).toMatchObject({
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservationKind: 'checkpoint-page',
    })
  })

  test('serializes concurrent attempts in one account and region with exact consumption', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const firstStarted = createDeferred<void>()
    const releaseFirst = createDeferred<void>()
    let callbacksInFlight = 0
    let maximumCallbacksInFlight = 0
    let secondStarted = false

    const first = lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        callbacksInFlight += 1
        maximumCallbacksInFlight = Math.max(
          maximumCallbacksInFlight,
          callbacksInFlight,
        )
        firstStarted.resolve(undefined)
        await releaseFirst.promise
        callbacksInFlight -= 1
        return 'first'
      }),
    )
    await firstStarted.promise
    const second = lifecycle.runDescribeTableAttempt(
      { phase: 'pre-send-guard' },
      createAttempt(async () => {
        secondStarted = true
        callbacksInFlight += 1
        maximumCallbacksInFlight = Math.max(
          maximumCallbacksInFlight,
          callbacksInFlight,
        )
        callbacksInFlight -= 1
        return 'second'
      }),
    )

    await flushMicrotasks()
    expect(secondStarted).toBeFalse()
    expect(lifecycle.readEvidence().attemptCount).toBe(1)
    releaseFirst.resolve(undefined)

    await Promise.all([first, second])
    expect(maximumCallbacksInFlight).toBe(1)
    expect(lifecycle.readEvidence()).toMatchObject({
      attemptCount: 2,
      maximumInFlight: 1,
    })
    expect(
      harness.observations.filter(
        (observation) => observation.kind === 'attempt',
      ),
    ).toHaveLength(2)
  })

  test('bounds FIFO admission by deadline and keeps an expired slot chained to its predecessor', async () => {
    const harness = new DeterministicRateHarness()
    const deadlineScheduler =
      new DeterministicDeadlineScheduler(harness)
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({
          maximumAdmissionWaitMilliseconds: 25,
        }),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        deadlineScheduler,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const firstStarted = createDeferred<void>()
    const releaseFirst = createDeferred<void>()
    let expiredCallbacks = 0
    let successorCallbacks = 0

    const first = lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        firstStarted.resolve(undefined)
        await releaseFirst.promise
      }),
    )
    await firstStarted.promise
    const expired = captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          expiredCallbacks += 1
        }),
      ))
    await flushMicrotasks()
    deadlineScheduler.fireNextActive()

    expect((await expired).reason).toBe('cadence-bound')
    expect(expiredCallbacks).toBe(0)
    const successor = lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        successorCallbacks += 1
      }),
    )
    await flushMicrotasks()
    expect(successorCallbacks).toBe(0)

    releaseFirst.resolve(undefined)
    await Promise.all([first, successor])
    expect(successorCallbacks).toBe(1)
    expect(lifecycle.readEvidence()).toMatchObject({
      attemptCount: 2,
      budgetStopCount: 1,
    })
  })

  test('bounds a successor behind a page barrier without allowing a stale fence write', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const pageStarted = createDeferred<void>()
    const releasePage = createDeferred<void>()
    const originalPage = captureRateError(() =>
      original.runCheckpointPage(
        {},
        async () => {
          pageStarted.resolve(undefined)
          await releasePage.promise
        },
      ))
    await pageStarted.promise
    let successorSettled = false
    const successorClaim = registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
    })).then((successor) => {
      successorSettled = true
      return successor
    })
    await flushMicrotasks()
    expect(successorSettled).toBeFalse()
    expect(harness.readCheckpoint()).toMatchObject({
      fenceToken: 1,
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
    })

    releasePage.resolve(undefined)
    expect((await originalPage).reason).toBe('taken-over')
    const successor = await successorClaim
    expect(successorSettled).toBeTrue()
    expect(successor.readCheckpoint()).toMatchObject({
      fenceToken: 2,
      attemptCount: 0,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservedAttempts: 0,
      reservationKind: 'none',
    })

    let successorCallbacks = 0
    await successor.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        successorCallbacks += 1
      }),
    )
    expect(successorCallbacks).toBe(1)
    expect(successor.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservedAttempts: 0,
    })
  })

  test('atomically excludes a non-page admission racing the page reservation CAS', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const reservationResponse = harness.blockNextWriteResponse()
    const pageStarted = createDeferred<void>()
    const releasePage = createDeferred<void>()
    let pageCallbacks = 0
    let attemptCallbacks = 0

    const pageResult = lifecycle.runCheckpointPage(
      {},
      async () => {
        pageCallbacks += 1
        pageStarted.resolve(undefined)
        await releasePage.promise
      },
    )
    const attemptResult = captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          attemptCallbacks += 1
        }),
      ))

    await reservationResponse.stored
    expect(harness.readCheckpoint()).toMatchObject({
      attemptCount: 0,
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservationKind: 'checkpoint-page',
    })
    expect(pageCallbacks).toBe(0)
    expect(attemptCallbacks).toBe(0)

    reservationResponse.release()
    await pageStarted.promise
    await flushMicrotasks()
    expect(pageCallbacks).toBe(1)
    expect(attemptCallbacks).toBe(0)

    releasePage.resolve(undefined)
    await pageResult
    expect((await attemptResult).reason).toBe('invalid-lifecycle')
    expect(attemptCallbacks).toBe(0)
    expect(lifecycle.readCheckpoint()).toMatchObject({
      attemptCount: 0,
      reservedAttempts: 0,
      reservationKind: 'none',
    })
  })

  test('settles an externally aborted FIFO admission before its predecessor releases', async () => {
    const harness = new DeterministicRateHarness()
    const deadlineScheduler =
      new DeterministicDeadlineScheduler(harness)
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        deadlineScheduler,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const firstStarted = createDeferred<void>()
    const releaseFirst = createDeferred<void>()
    const controller = new AbortController()
    let queuedCallbacks = 0

    const first = lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        firstStarted.resolve(undefined)
        await releaseFirst.promise
      }),
    )
    await firstStarted.promise
    const queued = captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement', signal: controller.signal },
        createAttempt(async () => {
          queuedCallbacks += 1
        }),
      ))
    await flushMicrotasks()
    controller.abort()

    expect((await queued).reason).toBe('interrupted')
    expect(queuedCallbacks).toBe(0)
    releaseFirst.resolve(undefined)
    await first
    expect(lifecycle.readEvidence().attemptCount).toBe(1)
  })

  test('bounds admission behind mandatory cleanup without canceling the cleanup', async () => {
    const harness = new DeterministicRateHarness()
    const deadlineScheduler =
      new DeterministicDeadlineScheduler(harness)
    const policy = createPolicy({
      maximumAdmissionWaitMilliseconds: 25,
    })
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        deadlineScheduler,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const cleanupStarted = createDeferred<void>()
    const releaseCleanup = createDeferred<void>()
    let successorCallbacks = 0

    const originalPage = captureRateError(() =>
      original.runCheckpointPage(
        {},
        async (page) =>
          await page.runMandatoryCleanup(async () => {
            cleanupStarted.resolve(undefined)
            await releaseCleanup.promise
          }),
      ))
    await cleanupStarted.promise
    const successorClaim = registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
    }))
    await flushMicrotasks()
    expect(successorCallbacks).toBe(0)
    releaseCleanup.resolve(undefined)
    expect((await originalPage).reason).toBe('taken-over')
    const successor = await successorClaim
    harness.advance(policy.windowMilliseconds)
    await successor.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        successorCallbacks += 1
      }),
    )
    expect(successorCallbacks).toBe(1)
  })

  test('keeps different regions independent', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const tokyo = await registry.claim(createClaim())
    const virginia = await registry.claim(createClaim({
      region: 'us-east-1',
    }))
    const tokyoStarted = createDeferred<void>()
    const virginiaStarted = createDeferred<void>()
    const release = createDeferred<void>()
    let callbacksInFlight = 0
    let maximumCallbacksInFlight = 0

    const runAttempt = async (
      started: Deferred<void>,
      lifecycle: typeof tokyo,
      region: string,
    ): Promise<DescribeTableCommandOutput> =>
      await lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          callbacksInFlight += 1
          maximumCallbacksInFlight = Math.max(
            maximumCallbacksInFlight,
            callbacksInFlight,
          )
          started.resolve(undefined)
          await release.promise
          callbacksInFlight -= 1
          return 'done'
        }, fixtureAccount, region),
      )

    const tokyoAttempt = runAttempt(
      tokyoStarted,
      tokyo,
      fixtureRegion,
    )
    const virginiaAttempt = runAttempt(
      virginiaStarted,
      virginia,
      'us-east-1',
    )
    await Promise.all([tokyoStarted.promise, virginiaStarted.promise])

    expect(maximumCallbacksInFlight).toBe(2)
    expect(tokyo.readEvidence().attemptCount).toBe(1)
    expect(virginia.readEvidence().attemptCount).toBe(1)
    release.resolve(undefined)
    await Promise.all([tokyoAttempt, virginiaAttempt])
  })

  test('bounds a stalled durable load without blocking another region', async () => {
    const harness = new DeterministicRateHarness()
    const scheduler = new DeterministicDeadlineScheduler(harness)
    const checkpointStore = new SelectivelyStalledCheckpointStore(
      fixtureScopeBindingDigest,
      harness,
    )
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        deadlineScheduler: scheduler,
        recorder: harness,
        random: () => 0,
      })
    const stalledClaim = captureRateError(() =>
      registry.claim(createClaim()))
    await flushMicrotasks()

    const independentRegion = 'us-east-1'
    const independent = await registry.claim(createClaim({
      region: independentRegion,
    }))
    expect(
      harness.readCheckpoint(
        createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
          fixtureAccount,
          independentRegion,
        ),
      ),
    ).toMatchObject({
      revision: 0,
      fenceToken: 1,
    })

    scheduler.fireNextActive()
    expect((await stalledClaim).reason).toBe('cadence-bound')
    expect(independent.readCheckpoint()).toMatchObject({
      attemptCount: 0,
    })
  })

  test('reserves all 182 page permits before callback and stops a short page before callback', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({ maximumAdmissionWaitMilliseconds: 10 }),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())

    await lifecycle.runCheckpointPage(
      {},
      async (page) => {
        await page.runDescribeTableAttempt(
          { phase: 'checkpoint-page' },
          createAttempt(async () => 'page-attempt'),
        )
      },
    )
    const firstAttempt = harness.observations.find(
      (observation) => observation.kind === 'attempt',
    )
    expect(firstAttempt).toMatchObject({
      kind: 'attempt',
      remainingNormalAdmissionAttempts:
        fixtureMaximumLifecycleAttempts -
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
      remainingWindowAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
      remainingPageAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
    })

    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => 'after-release'),
    )

    const constrainedHarness = new DeterministicRateHarness()
    const constrainedLifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy({
          maximumAttemptsPerLifecycle:
            WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS +
            WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
        }),
        checkpointStore: constrainedHarness,
        clock: constrainedHarness.clock,
        epochClock: constrainedHarness.clock,
        waiter: constrainedHarness,
        recorder: constrainedHarness,
        random: () => 0,
      }).claim(createClaim())
    await constrainedLifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => 'consumed'),
    )
    let shortPageCallbacks = 0
    const capacityError = await captureRateError(() =>
      constrainedLifecycle.runCheckpointPage(
        {},
        async () => {
          shortPageCallbacks += 1
        },
      ))
    expect(capacityError.reason).toBe('budget-capacity')
    expect(shortPageCallbacks).toBe(0)
    expect(constrainedLifecycle.readEvidence()).toMatchObject({
      attemptCount: 1,
      budgetStopCount: 1,
    })
    expect(constrainedHarness.observations.at(-1)).toMatchObject({
      kind: 'budget-stop',
      phase: 'checkpoint-page',
      reason: 'budget-capacity',
      requiredAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      remainingNormalAdmissionAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
      remainingWindowAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
      retryAfterMilliseconds: 0,
    })
  })

  test('does not start a page callback until rolling-window capacity returns', async () => {
    const harness = new DeterministicRateHarness()
    const waitStarted = createDeferred<number>()
    const releaseWait = createDeferred<void>()
    let holdWait = false
    const waiter: WorkspaceSearchMigrationDescribeTableRateWaiter = {
      wait: async (
        delayMilliseconds: number,
        signal: AbortSignal,
      ): Promise<void> => {
        if (!holdWait) {
          await harness.wait(delayMilliseconds, signal)
          return
        }
        waitStarted.resolve(delayMilliseconds)
        await releaseWait.promise
        if (signal.aborted) {
          throw new Error('The controlled wait was interrupted.')
        }
        harness.advance(delayMilliseconds)
      },
    }
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())

    for (
      let index = 0;
      index <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS;
      index += 1
    ) {
      await lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => undefined),
      )
    }
    holdWait = true
    let pageCallbacks = 0
    const pageResult = lifecycle.runCheckpointPage(
      {},
      async () => {
        pageCallbacks += 1
      },
    )

    expect(await waitStarted.promise).toBe(1_000)
    expect(pageCallbacks).toBe(0)
    releaseWait.resolve(undefined)
    await pageResult
    expect(pageCallbacks).toBe(1)
    expect(harness.readNow()).toBe(1_181)
  })

  test('uses the injected clock and waiter for page cadence and rolling-window refill', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())

    await lifecycle.runCheckpointPage(
      {},
      async () => undefined,
    )
    await lifecycle.runCheckpointPage(
      {},
      async () => undefined,
    )
    expect(harness.waits).toEqual([10])
    expect(harness.readNow()).toBe(10)

    for (
      let index = 0;
      index <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS;
      index += 1
    ) {
      await lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => undefined),
      )
    }
    await lifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => undefined),
    )

    expect(harness.waits.at(-1)).toBe(819)
    expect(harness.readNow()).toBe(1_010)
    expect(lifecycle.readEvidence()).toMatchObject({
      attemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS +
        1,
      cadenceWaitCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS +
        1,
      cadenceWaitMilliseconds: 1_010,
      maximumInFlight: 1,
    })
  })

  test('sanitizes throttle failures and applies bounded jitter cooldown before explicit retry', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const rawCanary = 'RAW-THROTTLE-CANARY-DO-NOT-EXPOSE'
    const throttlingError = new Error(rawCanary)
    throttlingError.name = 'ThrottlingException'
    const errors: WorkspaceSearchMigrationDescribeTableRateError[] = []

    for (let index = 0; index < 3; index += 1) {
      errors.push(
        await captureRateError(() =>
          lifecycle.runDescribeTableAttempt(
            { phase: 'reconciliation' },
            createAttempt(async () => {
              throw throttlingError
            }),
          )),
      )
    }
    await lifecycle.runDescribeTableAttempt(
      { phase: 'reconciliation' },
      createAttempt(async () => 'resumed'),
    )

    expect(errors.map((error) => error.reason)).toEqual([
      'throttled',
      'throttled',
      'throttled',
    ])
    expect(errors.every((error) => !error.message.includes(rawCanary)))
      .toBeTrue()
    expect(
      harness.observations
        .filter((observation) => observation.kind === 'throttle')
        .map((observation) => observation.backoffMilliseconds),
    ).toEqual([50, 100, 200])
    expect(harness.waits).toEqual([50, 100, 200])
    expect(lifecycle.readEvidence()).toMatchObject({
      attemptCount: 4,
      throttleCount: 3,
      budgetStopCount: 3,
    })
    expect(JSON.stringify({ errors, observations: harness.observations }))
      .not.toContain(rawCanary)
  })

  test('interrupts a queued callback without consumption but retains the in-flight attempt', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const inFlightSignal = createDeferred<AbortSignal>()
    const releaseInFlight = createDeferred<void>()
    let inFlightCallbacks = 0
    let queuedCallbacks = 0

    const inFlightResult = captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async (signal) => {
          inFlightCallbacks += 1
          inFlightSignal.resolve(signal)
          await releaseInFlight.promise
          if (signal.aborted) {
            throw new Error('RAW-ABORT-CANARY')
          }
          return 'sent'
        }),
      ))
    const signal = await inFlightSignal.promise
    const queuedResult = captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'pre-send-guard' },
        createAttempt(async () => {
          queuedCallbacks += 1
          return 'not-sent'
        }),
      ))
    await flushMicrotasks()

    lifecycle.interrupt()
    expect(signal.aborted).toBeTrue()
    releaseInFlight.resolve(undefined)

    const [inFlightError, queuedError] = await Promise.all([
      inFlightResult,
      queuedResult,
    ])
    expect(inFlightError.reason).toBe('interrupted')
    expect(inFlightError.message).not.toContain('RAW-ABORT-CANARY')
    expect(queuedError.reason).toBe('interrupted')
    expect(inFlightCallbacks).toBe(1)
    expect(queuedCallbacks).toBe(0)
    expect(lifecycle.readEvidence()).toMatchObject({
      attemptCount: 1,
      maximumInFlight: 1,
    })
  })

  test('retains counters across same-fence resume and invalidates an old handle on takeover', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim({
      fenceToken: 7,
    }))

    await original.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => 'first'),
    )
    original.interrupt()
    let interruptedCallbacks = 0
    const interruptedError = await captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          interruptedCallbacks += 1
        }),
      ))
    expect(interruptedError.reason).toBe('interrupted')
    expect(interruptedCallbacks).toBe(0)

    original.resume()
    await original.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => 'resumed'),
    )
    const duplicateFenceError = await captureRateError(() =>
      registry.claim(createClaim({
        fenceToken: 7,
        bootstrap: false,
      })))
    expect(duplicateFenceError.reason).toBe('invalid-lifecycle')

    const successor = await registry.claim(createClaim({
      fenceToken: 8,
      bootstrap: false,
    }))
    let oldCallbacks = 0
    const oldError = await captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          oldCallbacks += 1
        }),
      ))
    expect(oldError.reason).toBe('taken-over')
    expect(oldCallbacks).toBe(0)
    expect(() => original.resume()).toThrow(
      WorkspaceSearchMigrationDescribeTableRateError,
    )

    await successor.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => 'successor'),
    )
    expect(original.readEvidence()).toEqual(successor.readEvidence())
    expect(successor.readEvidence()).toMatchObject({
      attemptCount: 3,
      budgetStopCount: 2,
      maximumInFlight: 1,
    })
  })

  test('keeps quarantine terminal for the quarantined handle', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const quarantined = await registry.claim(createClaim())
    quarantined.quarantine()
    expect(() => quarantined.resume()).toThrow(
      WorkspaceSearchMigrationDescribeTableRateError,
    )
    let callbacks = 0
    const firstError = await captureRateError(() =>
      quarantined.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          callbacks += 1
        }),
      ))
    expect(firstError.reason).toBe('quarantined')

    const successor = await registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
    }))
    await successor.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => 'successor'),
    )
    const secondError = await captureRateError(() =>
      quarantined.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          callbacks += 1
        }),
      ))
    expect(secondError.reason).toBe('quarantined')
    expect(callbacks).toBe(0)
  })

  test('finishes already-started mandatory cleanup before a FIFO successor starts', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const firstCleanupStarted = createDeferred<void>()
    const releaseFirstCleanupAttempt = createDeferred<void>()
    const events: string[] = []
    const cleanupSignals: AbortSignal[] = []

    const originalPage = captureRateError(() =>
      original.runCheckpointPage(
        {},
        async (page) =>
          await page.runMandatoryCleanup(async (cleanup) => {
            events.push('cleanup-start')
            await cleanup.runDescribeTableAttempt(
              { phase: 'post-send-guard' },
              createAttempt(async (signal) => {
                cleanupSignals.push(signal)
                events.push('cleanup-attempt-1-start')
                firstCleanupStarted.resolve(undefined)
                await releaseFirstCleanupAttempt.promise
                events.push('cleanup-attempt-1-end')
              }),
            )
            await cleanup.runDescribeTableAttempt(
              { phase: 'reconciliation' },
              createAttempt(async (signal) => {
                cleanupSignals.push(signal)
                events.push('cleanup-attempt-2')
              }),
            )
            events.push('cleanup-end')
          }),
      ))
    await firstCleanupStarted.promise

    original.interrupt()
    const successorClaim = registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
    }))
    let successorCallbacks = 0
    await flushMicrotasks()
    expect(successorCallbacks).toBe(0)

    releaseFirstCleanupAttempt.resolve(undefined)
    const pageError = await originalPage
    const successor = await successorClaim
    await successor.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        successorCallbacks += 1
        events.push('successor-attempt')
      }),
    )

    expect(pageError.reason).toBe('taken-over')
    expect(cleanupSignals.every((signal) => !signal.aborted)).toBeTrue()
    expect(events).toEqual([
      'cleanup-start',
      'cleanup-attempt-1-start',
      'cleanup-attempt-1-end',
      'cleanup-attempt-2',
      'cleanup-end',
      'successor-attempt',
    ])
    expect(original.readEvidence()).toEqual(successor.readEvidence())
    expect(successor.readEvidence().attemptCount).toBe(3)
    const oldError = await captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'post-send-guard' },
        createAttempt(async () => undefined),
      ))
    expect(oldError.reason).toBe('taken-over')
  })

  test('requires explicit authority to recover cross-process mandatory cleanup', async () => {
    const harness = new DeterministicRateHarness()
    const policy = createPolicy()
    const original = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const cleanupStarted = createDeferred<void>()
    const releaseCleanup = createDeferred<void>()
    const originalPage = captureRateError(() =>
      original.runCheckpointPage(
        {},
        async (page) =>
          await page.runMandatoryCleanup(async () => {
            cleanupStarted.resolve(undefined)
            await releaseCleanup.promise
          }),
      ))
    await cleanupStarted.promise
    expect(harness.readCheckpoint()).toMatchObject({
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservationKind: 'checkpoint-page',
      mandatoryCleanupRequired: true,
    })
    const recoveryRegistry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })

    const unauthorized = await captureRateError(() =>
      recoveryRegistry.claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
      })))
    expect(unauthorized.reason).toBe('invalid-lifecycle')
    const recovered = await recoveryRegistry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedCleanup: true,
    }))
    expect(recovered.readCheckpoint()).toMatchObject({
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservedAttempts: 0,
      reservationKind: 'none',
      mandatoryCleanupRequired: true,
    })
    const nextRegistry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const stillUnauthorized = await captureRateError(() =>
      nextRegistry.claim(createClaim({
        fenceToken: 3,
        bootstrap: false,
      })))
    expect(stillUnauthorized.reason).toBe('invalid-lifecycle')

    await recovered.recoverInterruptedCleanup(
      async () => 'reconciled',
    )
    expect(recovered.readCheckpoint()).toMatchObject({
      mandatoryCleanupRequired: false,
      reservationKind: 'none',
    })

    releaseCleanup.resolve(undefined)
    expect((await originalPage).reason).toBe('taken-over')
  })

  test('rejects concurrent same-owner cleanup and an escaped page capability', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const cleanupStarted = createDeferred<void>()
    const releaseCleanup = createDeferred<void>()
    let rejectedCleanupCallbacks = 0

    const escapedPage = await lifecycle.runCheckpointPage(
      {},
      async (page) => {
        const firstCleanup = page.runMandatoryCleanup(async () => {
          cleanupStarted.resolve(undefined)
          await releaseCleanup.promise
        })
        await cleanupStarted.promise
        const concurrentError = await captureRateError(() =>
          page.runMandatoryCleanup(async () => {
            rejectedCleanupCallbacks += 1
          }))
        expect(concurrentError.reason).toBe('invalid-lifecycle')
        expect(rejectedCleanupCallbacks).toBe(0)
        releaseCleanup.resolve(undefined)
        await firstCleanup
        return page
      },
    )

    const escapedAttemptError = await captureRateError(() =>
      escapedPage.runDescribeTableAttempt(
        { phase: 'checkpoint-page' },
        createAttempt(async () => 'must-not-run'),
      ))
    const escapedCleanupError = await captureRateError(() =>
      escapedPage.runMandatoryCleanup(async () => 'must-not-run'))
    expect(escapedAttemptError.reason).toBe('invalid-lifecycle')
    expect(escapedCleanupError.reason).toBe('invalid-lifecycle')
    expect(lifecycle.readEvidence().attemptCount).toBe(0)
  })

  test('keeps lifecycle, page, and cleanup capabilities opaque, frozen, and bounded', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    expectOpaqueFrozenCapability(lifecycle)
    let cleanupCallbacks = 0
    let seventhCallbacks = 0

    await lifecycle.runCheckpointPage(
      {},
      async (page) => {
        expectOpaqueFrozenCapability(page)
        await page.runMandatoryCleanup(async (cleanup) => {
          expectOpaqueFrozenCapability(cleanup)
          for (
            let index = 0;
            index <
              WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS;
            index += 1
          ) {
            await cleanup.runDescribeTableAttempt(
              { phase: 'post-send-guard' },
              createAttempt(async () => {
                cleanupCallbacks += 1
              }),
            )
          }
          const seventhError = await captureRateError(() =>
            cleanup.runDescribeTableAttempt(
              { phase: 'post-send-guard' },
              createAttempt(async () => {
                seventhCallbacks += 1
              }),
            ))
          expect(seventhError.reason).toBe('budget-capacity')
        })
      },
    )

    expect(cleanupCallbacks).toBe(
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
    )
    expect(seventhCallbacks).toBe(0)
    expect(lifecycle.readEvidence().attemptCount).toBe(
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
    )
  })

  test('does not let interruption downgrade quarantine requested during cleanup', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    let cleanupAttempts = 0

    const pageError = await captureRateError(() =>
      lifecycle.runCheckpointPage(
        {},
        async (page) =>
          await page.runMandatoryCleanup(async (cleanup) => {
            lifecycle.quarantine()
            lifecycle.interrupt()
            await cleanup.runDescribeTableAttempt(
              { phase: 'post-send-guard' },
              createAttempt(async () => {
                cleanupAttempts += 1
              }),
            )
          }),
      ))

    expect(pageError.reason).toBe('quarantined')
    expect(cleanupAttempts).toBe(1)
    expect(() => lifecycle.resume()).toThrow(
      WorkspaceSearchMigrationDescribeTableRateError,
    )
    const laterError = await captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => undefined),
      ))
    expect(laterError.reason).toBe('quarantined')
  })

  test('does not recover another writer byte-identical CAS as response loss', async () => {
    const harness = new DeterministicRateHarness()
    const createRegistry = () =>
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const outcomes = await Promise.allSettled([
      createRegistry().claim(createClaim()),
      createRegistry().claim(createClaim()),
    ])
    const successful = outcomes.find(
      (outcome) => outcome.status === 'fulfilled',
    )
    const rejected = outcomes.find(
      (outcome) => outcome.status === 'rejected',
    )
    if (
      successful === undefined ||
      successful.status !== 'fulfilled' ||
      rejected === undefined ||
      rejected.status !== 'rejected'
    ) {
      throw new Error('Expected one exact bootstrap CAS winner.')
    }
    expect(rejected.reason).toBeInstanceOf(
      WorkspaceSearchMigrationDescribeTableRateError,
    )
    let callbacks = 0
    await successful.value.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        callbacks += 1
      }),
    )
    expect(callbacks).toBe(1)
    expect(harness.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: false,
    })
  })

  test('serializes a fence claim behind an older completion checkpoint', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const attemptStarted = createDeferred<void>()
    const releaseAttempt = createDeferred<void>()
    const originalResult = captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          attemptStarted.resolve(undefined)
          await releaseAttempt.promise
        }),
      ))
    await attemptStarted.promise
    const completionResponse = harness.blockNextWriteResponse()
    releaseAttempt.resolve(undefined)
    await completionResponse.stored

    let successorSettled = false
    const successorClaim = registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
    }))
    void successorClaim.then(
      () => {
        successorSettled = true
      },
      () => {
        successorSettled = true
      },
    )
    await flushMicrotasks()
    expect(successorSettled).toBe(false)

    completionResponse.release()
    const successor = await successorClaim
    expect((await originalResult).reason).toBe('taken-over')
    let successorCallbacks = 0
    await successor.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        successorCallbacks += 1
      }),
    )
    expect(successorCallbacks).toBe(1)
    expect(successor.readCheckpoint()).toMatchObject({
      fenceToken: 2,
      attemptCount: 2,
      attemptInFlight: false,
    })
  })

  test('retains and quarantines a failed mandatory-cleanup marker', async () => {
    const harness = new DeterministicRateHarness()
    const policy = createPolicy()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const cleanupFailure = new Error('DETERMINISTIC-CLEANUP-FAILURE')

    await expect(
      lifecycle.runCheckpointPage(
        {},
        async (page) =>
          await page.runMandatoryCleanup(async () => {
            throw cleanupFailure
          }),
      ),
    ).rejects.toBe(cleanupFailure)
    expect(harness.readCheckpoint()).toMatchObject({
      mandatoryCleanupRequired: true,
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservationKind: 'checkpoint-page',
    })
    const quarantinedError = await captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => 'must-not-run'),
      ))
    expect(quarantinedError.reason).toBe('quarantined')
    const unauthorized = await captureRateError(() =>
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
      })))
    expect(unauthorized.reason).toBe('invalid-lifecycle')
  })

  test('reserves all-six recovery headroom and retries a pre-send cold horizon', async () => {
    const harness = new DeterministicRateHarness()
    const policy = createPolicy({
      maximumAttemptsPerLifecycle:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS +
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
      windowMilliseconds: 3_000,
      maximumAdmissionWaitMilliseconds: 2_000,
    })
    const original = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const cleanupFailure = new Error('DETERMINISTIC-CLEANUP-CRASH')
    await expect(
      original.runCheckpointPage(
        {},
        async (page) =>
          await page.runMandatoryCleanup(async () => {
            throw cleanupFailure
          }),
      ),
    ).rejects.toBe(cleanupFailure)

    const recovered = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
        recoverInterruptedCleanup: true,
      }))
    let physicalAttempts = 0
    const coldStartError = await captureRateError(() =>
      recovered.recoverInterruptedCleanup(
        async (cleanup) =>
          await cleanup.runDescribeTableAttempt(
            { phase: 'reconciliation' },
            createAttempt(async () => {
              physicalAttempts += 1
            }),
          ),
      ))
    expect(coldStartError.reason).toBe('cadence-bound')
    expect(physicalAttempts).toBe(0)
    expect(harness.readCheckpoint()).toMatchObject({
      mandatoryCleanupRequired: true,
      attemptCount: 0,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
    })

    harness.advance(policy.windowMilliseconds)
    await recovered.recoverInterruptedCleanup(async (cleanup) => {
      for (
        let attemptIndex = 0;
        attemptIndex <
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS;
        attemptIndex += 1
      ) {
        await cleanup.runDescribeTableAttempt(
          { phase: 'reconciliation' },
          createAttempt(async () => {
            physicalAttempts += 1
          }),
        )
      }
    })
    expect(physicalAttempts).toBe(
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
    )
    expect(recovered.readCheckpoint()).toMatchObject({
      mandatoryCleanupRequired: false,
      attemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservedAttempts: 0,
    })
    let laterCallbacks = 0
    const exhausted = await captureRateError(() =>
      recovered.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          laterCallbacks += 1
        }),
      ))
    expect(exhausted.reason).toBe('budget-capacity')
    expect(laterCallbacks).toBe(0)
  })

  test('keeps an interrupted physical attempt quarantined until explicit recovery', async () => {
    const harness = new DeterministicRateHarness()
    const policy = createPolicy()
    const original = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const attemptStarted = createDeferred<void>()
    const releaseAttempt = createDeferred<void>()
    const originalResult = captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          attemptStarted.resolve(undefined)
          await releaseAttempt.promise
        }),
      ))
    await attemptStarted.promise
    expect(harness.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: true,
    })
    const recoveryRegistry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const unauthorized = await captureRateError(() =>
      recoveryRegistry.claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
      })))
    expect(unauthorized.reason).toBe('invalid-lifecycle')
    const recovered = await recoveryRegistry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedAttempt: true,
    }))
    expect(harness.readCheckpoint()).toMatchObject({
      attemptInFlight: true,
    })
    let overlappingCallbacks = 0
    const blockedAttempt = await captureRateError(() =>
      recovered.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          overlappingCallbacks += 1
        }),
      ))
    expect(blockedAttempt.reason).toBe('invalid-lifecycle')
    expect(overlappingCallbacks).toBe(0)

    releaseAttempt.resolve(undefined)
    expect((await originalResult).reason).toBe('taken-over')
    const recoveryStarted = createDeferred<void>()
    const finishRecovery = createDeferred<void>()
    const firstRecovery = recovered.recoverInterruptedAttempt(
      async () => {
        recoveryStarted.resolve(undefined)
        await finishRecovery.promise
        return 'old-owner-confirmed-stopped'
      },
    )
    await recoveryStarted.promise
    const concurrentRecovery = await captureRateError(() =>
      recovered.recoverInterruptedAttempt(
        async () => 'must-not-run',
      ))
    expect(concurrentRecovery.reason).toBe('invalid-lifecycle')
    expect(harness.readCheckpoint()).toMatchObject({
      attemptInFlight: true,
    })
    finishRecovery.resolve(undefined)
    await firstRecovery
    expect(recovered.readCheckpoint()).toMatchObject({
      attemptInFlight: false,
    })
    await recovered.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        overlappingCallbacks += 1
      }),
    )
    expect(overlappingCallbacks).toBe(1)
  })

  test('detaches an obsolete single-flight tail after authorized attempt recovery', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const attemptStarted = createDeferred<void>()
    const releaseObsoleteAttempt = createDeferred<void>()
    const throttlingError = new Error(
      'RAW-OBSOLETE-THROTTLE-CANARY',
    )
    throttlingError.name = 'ThrottlingException'
    const obsoleteAttempt = captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          attemptStarted.resolve(undefined)
          await releaseObsoleteAttempt.promise
          throw throttlingError
        }),
      ))
    await attemptStarted.promise

    const recovered = await registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedAttempt: true,
    }))
    await recovered.recoverInterruptedAttempt(
      async () => 'old-owner-confirmed-stopped',
    )
    let recoveredCallbacks = 0
    await recovered.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        recoveredCallbacks += 1
      }),
    )
    releaseObsoleteAttempt.resolve(undefined)
    expect((await obsoleteAttempt).reason).toBe('taken-over')

    expect(recoveredCallbacks).toBe(1)
    expect(harness.waits).toEqual([1_000])
    expect(recovered.readEvidence()).toMatchObject({
      attemptCount: 2,
      throttleCount: 0,
      maximumInFlight: 1,
    })
    expect(recovered.readCheckpoint()).toMatchObject({
      attemptCount: 2,
      attemptInFlight: false,
      throttleCount: 0,
    })
  })

  test('rejects normal work until an interrupted-attempt clear CAS is confirmed', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const attemptStarted = createDeferred<void>()
    const releaseAttempt = createDeferred<void>()
    const originalResult = captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          attemptStarted.resolve(undefined)
          await releaseAttempt.promise
        }),
      ))
    await attemptStarted.promise
    const recovered = await registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedAttempt: true,
    }))
    releaseAttempt.resolve(undefined)
    expect((await originalResult).reason).toBe('taken-over')

    const recoveryStarted = createDeferred<void>()
    const finishRecovery = createDeferred<void>()
    const recovery = recovered.recoverInterruptedAttempt(async () => {
      recoveryStarted.resolve(undefined)
      await finishRecovery.promise
    })
    await recoveryStarted.promise
    const clearResponse = harness.blockNextWriteResponse()
    finishRecovery.resolve(undefined)
    await clearResponse.stored

    let callbacks = 0
    const attemptError = await captureRateError(() =>
      recovered.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          callbacks += 1
        }),
      ))
    const pageError = await captureRateError(() =>
      recovered.runCheckpointPage(
        {},
        async () => {
          callbacks += 1
        },
      ))
    const snapshotError = captureSynchronousRateError(() =>
      recovered.readCheckpoint())
    expect(attemptError.reason).toBe('invalid-lifecycle')
    expect(pageError.reason).toBe('invalid-lifecycle')
    expect(snapshotError.reason).toBe('invalid-lifecycle')
    expect(callbacks).toBe(0)

    clearResponse.release()
    await recovery
    await recovered.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        callbacks += 1
      }),
    )
    expect(callbacks).toBe(1)
  })

  test('retains recovery markers when completion persistence cannot be confirmed', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const completionError = await captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          harness.rejectNextWrite()
        }),
      ))
    expect(completionError.reason).toBe('quarantined')
    expect(completionError.message).not.toContain(
      'RAW-CHECKPOINT-WRITE-FAILURE-CANARY',
    )
    expect(harness.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: true,
    })

    const unauthorizedAfterCompletion = await captureRateError(() =>
      registry.claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
      })))
    expect(unauthorizedAfterCompletion.reason).toBe(
      'invalid-lifecycle',
    )
    const firstRecoveryOwner = await registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedAttempt: true,
    }))
    harness.rejectNextWrite()
    const recoveryClearError = await captureRateError(() =>
      firstRecoveryOwner.recoverInterruptedAttempt(
        async () => 'physical-owner-confirmed-stopped',
      ))
    expect(recoveryClearError.reason).toBe('quarantined')
    expect(harness.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: true,
    })

    const unauthorizedAfterRecovery = await captureRateError(() =>
      registry.claim(createClaim({
        fenceToken: 3,
        bootstrap: false,
      })))
    expect(unauthorizedAfterRecovery.reason).toBe(
      'invalid-lifecycle',
    )
    const finalRecoveryOwner = await registry.claim(createClaim({
      fenceToken: 3,
      bootstrap: false,
      recoverInterruptedAttempt: true,
    }))
    await finalRecoveryOwner.recoverInterruptedAttempt(
      async () => 'physical-owner-confirmed-stopped',
    )
    let laterCallbacks = 0
    await finalRecoveryOwner.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => {
        laterCallbacks += 1
      }),
    )
    expect(laterCallbacks).toBe(1)
    expect(finalRecoveryOwner.readCheckpoint()).toMatchObject({
      attemptCount: 2,
      attemptInFlight: false,
    })
  })

  test('forfeits unused page permits after their release checkpoint fails', async () => {
    const harness = new DeterministicRateHarness()
    const policy = createPolicy({
      maximumAttemptsPerLifecycle:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS +
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
    })
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy,
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())

    const releaseError = await captureRateError(() =>
      original.runCheckpointPage(
        {},
        async () => {
          harness.rejectNextWrite()
        },
      ))
    expect(releaseError.reason).toBe('quarantined')
    expect(harness.readCheckpoint()).toMatchObject({
      attemptCount: 0,
      forfeitedAttemptCount: 0,
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservationKind: 'checkpoint-page',
    })

    const recovered = await registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
    }))
    expect(recovered.readCheckpoint()).toMatchObject({
      attemptCount: 0,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
      reservedAttempts: 0,
      reservationKind: 'none',
    })
    let pageCallbacks = 0
    const pageError = await captureRateError(() =>
      recovered.runCheckpointPage(
        {},
        async () => {
          pageCallbacks += 1
        },
      ))
    expect(pageError.reason).toBe('budget-capacity')
    expect(pageCallbacks).toBe(0)
  })

  test('blocks a queued attempt when predecessor completion staging fails', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.epochClock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const firstStarted = createDeferred<void>()
    const releaseFirst = createDeferred<void>()
    const firstResult = captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          firstStarted.resolve(undefined)
          await releaseFirst.promise
          harness.rejectNextEpochClockRead()
        }),
      ))
    await firstStarted.promise

    let secondCallbacks = 0
    const secondResult = captureRateError(() =>
      original.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          secondCallbacks += 1
        }),
      ))
    await flushMicrotasks()
    expect(secondCallbacks).toBe(0)
    releaseFirst.resolve(undefined)
    const [firstError, secondError] = await Promise.all([
      firstResult,
      secondResult,
    ])
    expect(firstError.reason).toBe('invalid-lifecycle')
    expect(firstError.message).not.toContain(
      'RAW-EPOCH-CLOCK-FAILURE-CANARY',
    )
    expect(secondError.reason).toBe('invalid-lifecycle')
    expect(secondCallbacks).toBe(0)
    expect(harness.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: true,
    })

    const unauthorized = await captureRateError(() =>
      registry.claim(createClaim({
        fenceToken: 2,
        bootstrap: false,
      })))
    expect(unauthorized.reason).toBe('invalid-lifecycle')
    const recovered = await registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedAttempt: true,
    }))
    await recovered.recoverInterruptedAttempt(
      async () => 'physical-owner-confirmed-stopped',
    )
    expect(recovered.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: false,
    })
  })

  test('does not let a transferred page owner refund forfeited permits', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const attemptStarted = createDeferred<void>()
    const releaseAttempt = createDeferred<void>()
    const originalPage = captureRateError(() =>
      original.runCheckpointPage(
        {},
        async (page) =>
          await page.runDescribeTableAttempt(
            { phase: 'checkpoint-page' },
            createAttempt(async () => {
              attemptStarted.resolve(undefined)
              await releaseAttempt.promise
            }),
          ),
      ))
    await attemptStarted.promise

    let successorSettled = false
    const successorClaim = registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedAttempt: true,
    })).then((successor) => {
      successorSettled = true
      return successor
    })
    await flushMicrotasks()
    expect(successorSettled).toBeFalse()
    releaseAttempt.resolve(undefined)
    expect((await originalPage).reason).toBe('taken-over')
    const successor = await successorClaim
    expect(successorSettled).toBeTrue()
    expect(successor.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: true,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
      reservedAttempts: 0,
      reservationKind: 'none',
    })

    await successor.recoverInterruptedAttempt(
      async () => 'old-owner-confirmed-stopped',
    )
    await successor.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => 'successor'),
    )
    expect(successor.readCheckpoint()).toMatchObject({
      attemptCount: 2,
      attemptInFlight: false,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
      reservedAttempts: 0,
      reservationKind: 'none',
    })
  })

  test('quarantines cleanup that returns with an unsettled attempt', async () => {
    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    let pendingAttempt: Promise<DescribeTableCommandOutput> | undefined
    let callbacks = 0
    const attemptStarted = createDeferred<void>()
    const releaseAttempt = createDeferred<void>()

    const cleanupResult = captureRateError(() =>
      lifecycle.runCheckpointPage(
        {},
        async (page) =>
          await page.runMandatoryCleanup(async (cleanup) => {
            pendingAttempt = cleanup.runDescribeTableAttempt(
              { phase: 'post-send-guard' },
              createAttempt(async () => {
                callbacks += 1
                attemptStarted.resolve(undefined)
                await releaseAttempt.promise
              }),
            )
          }),
      ))
    await attemptStarted.promise
    releaseAttempt.resolve(undefined)
    const cleanupError = await cleanupResult
    expect(cleanupError.reason).toBe('invalid-lifecycle')
    if (pendingAttempt === undefined) {
      throw new Error('Expected one pending cleanup attempt.')
    }
    await expect(pendingAttempt).resolves.toMatchObject({
      $metadata: { attempts: 1 },
    })
    expect(callbacks).toBe(1)
    expect(harness.readCheckpoint()).toMatchObject({
      mandatoryCleanupRequired: true,
      attemptCount: 1,
      attemptInFlight: false,
      reservedAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
    })
  })

  test('joins a pending cleanup attempt before propagating callback rejection', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const attemptStarted = createDeferred<void>()
    const releaseAttempt = createDeferred<void>()
    const cleanupFailure =
      new Error('DETERMINISTIC-CLEANUP-REJECTION')
    let pendingAttempt: Promise<DescribeTableCommandOutput> | undefined
    const cleanupResult = original.runCheckpointPage(
      {},
      async (page) =>
        await page.runMandatoryCleanup(async (cleanup) => {
          pendingAttempt = cleanup.runDescribeTableAttempt(
            { phase: 'post-send-guard' },
            createAttempt(async () => {
              attemptStarted.resolve(undefined)
              await releaseAttempt.promise
            }),
          )
          throw cleanupFailure
        }),
    )
    const cleanupOutcome = cleanupResult.then(
      () => undefined,
      (error: unknown) => error,
    )
    await attemptStarted.promise

    let successorSettled = false
    const successorResult = registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedCleanup: true,
    })).then((successor) => {
      successorSettled = true
      return successor
    })
    await flushMicrotasks()
    expect(successorSettled).toBeFalse()

    releaseAttempt.resolve(undefined)
    expect(await cleanupOutcome).toBe(cleanupFailure)
    if (pendingAttempt === undefined) {
      throw new Error('Expected one pending cleanup attempt.')
    }
    await expect(pendingAttempt).resolves.toMatchObject({
      $metadata: { attempts: 1 },
    })
    const successor = await successorResult
    expect(successorSettled).toBeTrue()
    expect(successor.readCheckpoint()).toMatchObject({
      mandatoryCleanupRequired: true,
      attemptCount: 1,
      attemptInFlight: false,
      reservedAttempts: 0,
    })
  })

  test('joins a pending page attempt before propagating callback rejection and takeover', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const attemptStarted = createDeferred<void>()
    const releaseAttempt = createDeferred<void>()
    const pageFailure = new Error('DETERMINISTIC-PAGE-REJECTION')
    let pendingAttempt: Promise<DescribeTableCommandOutput> | undefined
    const pageResult = original.runCheckpointPage(
      {},
      async (page) => {
        pendingAttempt = page.runDescribeTableAttempt(
          { phase: 'checkpoint-page' },
          createAttempt(async () => {
            attemptStarted.resolve(undefined)
            await releaseAttempt.promise
          }),
        )
        throw pageFailure
      },
    )
    const pageOutcome = pageResult.then(
      () => undefined,
      (error: unknown) => error,
    )
    await attemptStarted.promise

    let successorSettled = false
    const successorClaim = registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
      recoverInterruptedAttempt: true,
    })).then((successor) => {
      successorSettled = true
      return successor
    })
    await flushMicrotasks()
    expect(successorSettled).toBeFalse()

    releaseAttempt.resolve(undefined)
    expect(await pageOutcome).toBe(pageFailure)
    if (pendingAttempt === undefined) {
      throw new Error('Expected one pending page attempt.')
    }
    await Promise.allSettled([pendingAttempt])
    const successor = await successorClaim
    expect(successorSettled).toBeTrue()
    expect(successor.readCheckpoint()).toMatchObject({
      fenceToken: 2,
      attemptCount: 1,
      attemptInFlight: true,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
      reservedAttempts: 0,
      reservationKind: 'none',
    })
    await successor.recoverInterruptedAttempt(
      async () => 'old-page-attempt-confirmed-stopped',
    )
    expect(successor.readCheckpoint()).toMatchObject({
      attemptCount: 1,
      attemptInFlight: false,
      forfeitedAttemptCount:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS -
        1,
      reservedAttempts: 0,
    })
  })

  test('limits takeover immunity to the cleanup-only capability', async () => {
    const harness = new DeterministicRateHarness()
    const registry =
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      })
    const original = await registry.claim(createClaim())
    const cleanupStarted = createDeferred<void>()
    const continueCleanup = createDeferred<void>()
    const pageReady =
      createDeferred<WorkspaceSearchMigrationDescribeTableCheckpointPage>()
    let cleanupCallbacks = 0
    const originalPage = captureRateError(() =>
      original.runCheckpointPage(
        {},
        async (page) => {
          pageReady.resolve(page)
          return await page.runMandatoryCleanup(async (cleanup) => {
            cleanupStarted.resolve(undefined)
            await continueCleanup.promise
            await cleanup.runDescribeTableAttempt(
              { phase: 'post-send-guard' },
              createAttempt(async () => {
                cleanupCallbacks += 1
              }),
            )
          })
        },
      ))
    const page = await pageReady.promise
    await cleanupStarted.promise
    const successorClaim = registry.claim(createClaim({
      fenceToken: 2,
      bootstrap: false,
    }))
    await flushMicrotasks()

    let unrelatedCallbacks = 0
    const unrelated = await captureRateError(() =>
      page.runDescribeTableAttempt(
        { phase: 'measurement' },
        createAttempt(async () => {
          unrelatedCallbacks += 1
        }),
      ))
    expect(unrelated.reason).toBe('invalid-lifecycle')
    expect(unrelatedCallbacks).toBe(0)

    continueCleanup.resolve(undefined)
    expect((await originalPage).reason).toBe('taken-over')
    await successorClaim
    expect(cleanupCallbacks).toBe(1)
  })

  test('ignores observer failures and emits only allowlisted event and evidence JSON', async () => {
    const throwingHarness = new DeterministicRateHarness()
    const throwingRecorder: WorkspaceSearchMigrationDescribeTableRateRecorder = {
      record: (
        observation: WorkspaceSearchMigrationDescribeTableRateObservation,
      ): void => {
        throwingHarness.record(observation)
        throw new Error('RAW-OBSERVER-CANARY')
      },
    }
    const observerLifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: throwingHarness,
        clock: throwingHarness.clock,
        epochClock: throwingHarness.clock,
        waiter: throwingHarness,
        recorder: throwingRecorder,
        random: () => 0,
      }).claim(createClaim())
    await observerLifecycle.runDescribeTableAttempt(
      { phase: 'measurement' },
      createAttempt(async () => 'observer-independent'),
    )
    expect(observerLifecycle.readEvidence().attemptCount).toBe(1)

    const harness = new DeterministicRateHarness()
    const lifecycle = await
      createWorkspaceSearchMigrationDescribeTableRateRegistry({
        policy: createPolicy(),
        checkpointStore: harness,
        clock: harness.clock,
        epochClock: harness.clock,
        waiter: harness,
        recorder: harness,
        random: () => 0,
      }).claim(createClaim())
    const rawCanary = 'RAW-EVENT-CANARY'
    const throttlingError = new Error(rawCanary)
    throttlingError.name = 'ThrottlingException'
    await captureRateError(() =>
      lifecycle.runDescribeTableAttempt(
        { phase: 'reconciliation' },
        createAttempt(async () => {
          throw throttlingError
        }),
      ))
    await lifecycle.runDescribeTableAttempt(
      { phase: 'reconciliation' },
      createAttempt(async () => 'resumed'),
    )

    const keySets = harness.observations.map((observation) =>
      Object.keys(observation).sort())
    expect(keySets).toEqual([
      [
        'inFlight',
        'kind',
        'observedAtMilliseconds',
        'phase',
        'remainingNormalAdmissionAttempts',
        'remainingPageAttempts',
        'remainingWindowAttempts',
        'sequence',
        'version',
      ],
      [
        'backoffMilliseconds',
        'kind',
        'observedAtMilliseconds',
        'phase',
        'sequence',
        'version',
      ],
      [
        'kind',
        'observedAtMilliseconds',
        'phase',
        'reason',
        'remainingNormalAdmissionAttempts',
        'remainingWindowAttempts',
        'requiredAttempts',
        'retryAfterMilliseconds',
        'version',
      ],
      [
        'delayMilliseconds',
        'kind',
        'observedAtMilliseconds',
        'phase',
        'version',
      ],
      [
        'inFlight',
        'kind',
        'observedAtMilliseconds',
        'phase',
        'remainingNormalAdmissionAttempts',
        'remainingPageAttempts',
        'remainingWindowAttempts',
        'sequence',
        'version',
      ],
    ])
    const evidence = lifecycle.readEvidence()
    expect(Object.keys(evidence).sort()).toEqual([
      'attemptCount',
      'budgetStopCount',
      'cadenceWaitCount',
      'cadenceWaitMilliseconds',
      'forfeitedAttemptCount',
      'maximumInFlight',
      'policyVersion',
      'throttleCount',
      'version',
    ])
    expect(evidence.version).toBe(
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    )
    const serialized = JSON.stringify({
      observations: harness.observations,
      evidence,
    })
    expect(serialized).not.toContain(rawCanary)
    expect(serialized).not.toContain(fixtureAccount)
    expect(serialized).not.toContain(fixtureRegion)
  })
})
