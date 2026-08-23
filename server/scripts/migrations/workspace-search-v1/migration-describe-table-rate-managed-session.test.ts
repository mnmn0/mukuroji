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
  createWorkspaceSearchMigrationManagedDescribeTableRate,
  type CreateWorkspaceSearchMigrationManagedDescribeTableRateInput,
  type WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'
import {
  runWithWorkspaceSearchMigrationHeartbeat,
} from './migration-heartbeat-supervisor'
import type {
  WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  WorkspaceSearchMigrationDescribeTableRateCheckpointStore,
  WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  WorkspaceSearchMigrationDescribeTableRatePolicy,
  WorkspaceSearchMigrationDescribeTablePhase,
} from './migration-describe-table-rate-budget'

const fixtureAccount = '123456789012'
const fixtureRegion = 'ap-northeast-1'
const fixtureTableNames = Object.freeze([
  'rate-managed-test-project-directory',
  'rate-managed-test-work-items',
  'rate-managed-test-collaboration',
  'rate-managed-test-documents',
  'rate-managed-test-workspace-search',
  'rate-managed-test-migration-state',
])
const fixtureAdditionalTableNames = Object.freeze([
  'rate-managed-test-audit-events',
  'rate-managed-test-file-proofing',
  'rate-managed-test-work-item-configuration',
  'rate-managed-test-workspace-access',
])
const fixtureCredentials = {
  accessKeyId: 'rate-managed-test-access-key',
  secretAccessKey: 'rate-managed-test-secret-key',
  accountId: fixtureAccount,
}
const fixturePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy = {
  policyVersion: 'a'.repeat(64),
  maximumAttemptsPerWindow: 1_000,
  maximumAttemptsPerLifecycle: 2_000,
  checkpointPageAttemptCapacity: 182,
  windowMilliseconds: 1,
  minimumAttemptIntervalMilliseconds: 1,
  minimumPageIntervalMilliseconds: 1,
  maximumAdmissionWaitMilliseconds: 5_000,
  throttleBackoffInitialMilliseconds: 1,
  throttleBackoffMaximumMilliseconds: 1,
}

/** Original SDK send method restored after this module completes. */
const originalDynamoDbSend = DynamoDBClient.prototype.send

/** Test-owned physical DescribeTable callbacks selected by exact table name. */
const describeTableCallbacks = new Map<
  string,
  (signal: AbortSignal) => Promise<DescribeTableCommandOutput>
>()

/** Physical table names observed by the intercepted dedicated transports. */
const observedDescribeTableNames: string[] = []

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
        if (typeof tableName === 'string') {
          observedDescribeTableNames.push(tableName)
          const callback = describeTableCallbacks.get(tableName)
          return callback === undefined
            ? Promise.resolve({ $metadata: { attempts: 1 } })
            : callback(readAbortSignal(callArguments[1]))
        }
      }
      return Reflect.apply(originalDynamoDbSend, this, callArguments)
    },
  )
})

afterAll(() => {
  Reflect.set(DynamoDBClient.prototype, 'send', originalDynamoDbSend)
  describeTableCallbacks.clear()
  observedDescribeTableNames.length = 0
})

/** Reads the controller-owned cancellation signal from SDK send options. */
function readAbortSignal(value: unknown): AbortSignal {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected DescribeTable send options.')
  }
  const signal = Reflect.get(value, 'abortSignal')
  if (!(signal instanceof AbortSignal)) {
    throw new Error('Expected a DescribeTable abort signal.')
  }
  return signal
}

/** Externally controlled promise used by deterministic concurrency tests. */
type Deferred<Value> = {
  /** Pending promise. */
  readonly promise: Promise<Value>
  /** Settles the promise with one exact value. */
  readonly resolve: (value: Value) => void
}

/** Pending interception of one durable checkpoint-page reservation. */
type PageReservationBlock = {
  /** Notification settled when the reservation CAS is attempted. */
  readonly observed: Deferred<void>
  /** Permission allowing the intercepted reservation CAS to finish. */
  readonly release: Deferred<void>
}

/** Public controls for one intercepted checkpoint-page reservation. */
type PageReservationBlockHandle = {
  /** Settles when the reservation CAS has started but not completed. */
  readonly observed: Promise<void>
  /** Allows the reservation CAS to store its successor checkpoint. */
  readonly release: () => void
}

/** Pending interception of one mandatory-cleanup marker transition. */
type CleanupMarkerBlock = {
  /** Notification settled when the marker CAS is attempted. */
  readonly observed: Deferred<void>
  /** Permission allowing the intercepted marker CAS to finish. */
  readonly release: Deferred<void>
}

/** Public controls for one intercepted cleanup-marker transition. */
type CleanupMarkerBlockHandle = {
  /** Settles when the marker CAS has started but not completed. */
  readonly observed: Promise<void>
  /** Allows the marker CAS to store its successor checkpoint. */
  readonly release: () => void
}

/** Pending interception of one checkpoint load boundary. */
type CheckpointLoadBlock = {
  /** Number of earlier loads allowed to complete without blocking. */
  remainingUnblockedLoads: number
  /** Notification settled when the selected load begins waiting. */
  readonly observed: Deferred<void>
  /** Permission allowing the selected load to finish. */
  readonly release: Deferred<void>
}

/** Creates one externally controlled pending promise. */
function createDeferred<Value>(): Deferred<Value> {
  let resolve = (_value: Value): void => {}
  const promise = new Promise<Value>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** In-memory exact-predecessor store retaining one durable checkpoint. */
class InMemoryRateCheckpointStore
  implements WorkspaceSearchMigrationDescribeTableRateCheckpointStore {
  /** Most recently stored durable checkpoint. */
  #checkpoint: WorkspaceSearchMigrationDescribeTableRateCheckpoint | undefined

  /** Whether the next physical-attempt completion CAS must fail. */
  #failNextAttemptCompletion = false

  /** Optional one-shot barrier before a page reservation becomes durable. */
  #pageReservationBlock: PageReservationBlock | undefined

  /** Optional one-shot barrier before a cleanup marker becomes durable. */
  #cleanupMarkerBlock: CleanupMarkerBlock | undefined

  /** Number of successfully stored page-reservation transitions. */
  #pageReservationCount = 0

  /** Optional one-shot barrier installed on a selected future load. */
  #checkpointLoadBlock: CheckpointLoadBlock | undefined

  /** Number of checkpoint CAS calls that have already started. */
  #compareAndSwapCallCount = 0

  /** Requests one deterministic simulated crash after a physical attempt. */
  failNextAttemptCompletion(): void {
    this.#failNextAttemptCompletion = true
  }

  /** Blocks the next page reservation until the returned release is called. */
  blockNextPageReservation(): PageReservationBlockHandle {
    const observed = createDeferred<void>()
    const release = createDeferred<void>()
    this.#pageReservationBlock = { observed, release }
    return {
      observed: observed.promise,
      release: () => release.resolve(),
    }
  }

  /** Blocks the next cleanup-marker CAS until release is called. */
  blockNextCleanupMarker(): CleanupMarkerBlockHandle {
    const observed = createDeferred<void>()
    const release = createDeferred<void>()
    this.#cleanupMarkerBlock = { observed, release }
    return {
      observed: observed.promise,
      release: () => release.resolve(),
    }
  }

  /** Returns the number of durably admitted checkpoint pages. */
  readPageReservationCount(): number {
    return this.#pageReservationCount
  }

  /** Blocks one load after the requested number of earlier loads complete. */
  blockLoadAfter(
    unblockedLoadCount: number,
  ): PageReservationBlockHandle {
    const observed = createDeferred<void>()
    const release = createDeferred<void>()
    this.#checkpointLoadBlock = {
      remainingUnblockedLoads: unblockedLoadCount,
      observed,
      release,
    }
    return {
      observed: observed.promise,
      release: () => release.resolve(),
    }
  }

  /** Returns the number of checkpoint CAS calls that have begun. */
  readCompareAndSwapCallCount(): number {
    return this.#compareAndSwapCallCount
  }

  /** Returns a detached current checkpoint for assertions. */
  read(): WorkspaceSearchMigrationDescribeTableRateCheckpoint | undefined {
    return this.#checkpoint === undefined
      ? undefined
      : structuredClone(this.#checkpoint)
  }

  /** Loads one detached checkpoint without interpreting the opaque scope. */
  async load(_scopeBindingDigest: string): Promise<unknown | undefined> {
    const block = this.#checkpointLoadBlock
    if (block !== undefined) {
      if (block.remainingUnblockedLoads > 0) {
        block.remainingUnblockedLoads -= 1
      } else {
        this.#checkpointLoadBlock = undefined
        block.observed.resolve()
        await block.release.promise
      }
    }
    return this.read()
  }

  /** Stores only an exact predecessor and can simulate one lost completion. */
  async compareAndSwap(
    write: WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  ): Promise<'stored' | 'conflict'> {
    this.#compareAndSwapCallCount += 1
    const current = this.#checkpoint
    const currentRevision = current?.revision ?? null
    if (write.expectedRevision !== currentRevision) {
      return 'conflict'
    }
    const startsPageReservation =
      current?.reservationKind !== 'checkpoint-page' &&
      write.checkpoint.reservationKind === 'checkpoint-page'
    if (startsPageReservation) {
      const block = this.#pageReservationBlock
      if (block !== undefined) {
        this.#pageReservationBlock = undefined
        block.observed.resolve()
        await block.release.promise
      }
    }
    const startsCleanupMarker =
      current?.mandatoryCleanupRequired === false &&
      write.checkpoint.mandatoryCleanupRequired
    if (startsCleanupMarker) {
      const block = this.#cleanupMarkerBlock
      if (block !== undefined) {
        this.#cleanupMarkerBlock = undefined
        block.observed.resolve()
        await block.release.promise
      }
    }
    if (
      this.#failNextAttemptCompletion &&
      current?.mandatoryCleanupRequired === true &&
      current.attemptInFlight &&
      !write.checkpoint.attemptInFlight
    ) {
      this.#failNextAttemptCompletion = false
      throw new Error('simulated-checkpoint-response-loss')
    }
    this.#checkpoint = structuredClone(write.checkpoint)
    if (startsPageReservation) this.#pageReservationCount += 1
    return 'stored'
  }
}

/** Creates one controller over the supplied persistent test store. */
async function createManagedRate(
  store: WorkspaceSearchMigrationDescribeTableRateCheckpointStore,
  input: {
    /** Whether the absent checkpoint may be created. */
    readonly bootstrap: boolean
    /** Whether a retained cleanup marker may be reconciled. */
    readonly recoverInterruptedCleanup?: boolean
    /** Whether an uncertain attempt may be reconciled. */
    readonly recoverInterruptedAttempt?: boolean
    /** Optional exact-six full physical table allowlist. */
    readonly allowedTableNames?: readonly string[]
    /** Optional secret-free rate observation recorder. */
    readonly recorder?:
      CreateWorkspaceSearchMigrationManagedDescribeTableRateInput['recorder']
    /** Optional cancellation stopping the initial fence claim. */
    readonly signal?: AbortSignal
  },
) {
  return await createWorkspaceSearchMigrationManagedDescribeTableRate({
    account: fixtureAccount,
    region: fixtureRegion,
    recoveryTableNames: fixtureTableNames,
    allowedTableNames: input.allowedTableNames ?? fixtureTableNames,
    policy: fixturePolicy,
    checkpointStore: store,
    credentials: fixtureCredentials,
    bootstrap: input.bootstrap,
    recoverInterruptedCleanup: input.recoverInterruptedCleanup,
    recoverInterruptedAttempt: input.recoverInterruptedAttempt,
    ...(input.recorder === undefined ? {} : { recorder: input.recorder }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
}

/** Requires one table lookup to fail through the stable managed boundary. */
async function expectManagedTableRejection(
  rate: WorkspaceSearchMigrationManagedDescribeTableRate,
  tableName: string,
  phase: WorkspaceSearchMigrationDescribeTablePhase,
): Promise<void> {
  try {
    await rate.describeTable(tableName, phase)
  } catch (error: unknown) {
    expect(error).toMatchObject({
      code: 'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
    })
    return
  }
  throw new Error('Expected managed table allowlist rejection.')
}

describe('managed DescribeTable rate session', () => {



  test('validates the dedicated transport before any checkpoint CAS', async () => {
    const store = new InMemoryRateCheckpointStore()
    await expect(
      createWorkspaceSearchMigrationManagedDescribeTableRate({
        account: fixtureAccount,
        region: fixtureRegion,
        recoveryTableNames: fixtureTableNames,
        allowedTableNames: fixtureTableNames,
        policy: fixturePolicy,
        checkpointStore: store,
        credentials: {
          ...fixtureCredentials,
          secretAccessKey: '',
        },
        bootstrap: true,
      }),
    ).rejects.toThrow('MANAGED_DESCRIBE_TABLE_RATE_FAILED')
    expect(store.readCompareAndSwapCallCount()).toBe(0)
  })

  test('rejects malformed recovery and allowed table vectors before side effects', async () => {
    const invalidVectors = [
      {
        name: 'recovery-missing',
        recoveryTableNames: fixtureTableNames.slice(0, 5),
        allowedTableNames: fixtureTableNames,
      },
      {
        name: 'recovery-extra',
        recoveryTableNames: [
          ...fixtureTableNames,
          fixtureAdditionalTableNames[0] ?? '',
        ],
        allowedTableNames: fixtureTableNames,
      },
      {
        name: 'recovery-duplicate',
        recoveryTableNames: [
          fixtureTableNames[0] ?? '',
          fixtureTableNames[0] ?? '',
          ...fixtureTableNames.slice(2),
        ],
        allowedTableNames: fixtureTableNames,
      },
      {
        name: 'recovery-invalid',
        recoveryTableNames: ['', ...fixtureTableNames.slice(1)],
        allowedTableNames: fixtureTableNames,
      },
      {
        name: 'allowed-missing-recovery',
        recoveryTableNames: fixtureTableNames,
        allowedTableNames: [
          ...fixtureTableNames.slice(0, 5),
          fixtureAdditionalTableNames[0] ?? '',
        ],
      },
      {
        name: 'allowed-seven',
        recoveryTableNames: fixtureTableNames,
        allowedTableNames: [
          ...fixtureTableNames,
          fixtureAdditionalTableNames[0] ?? '',
        ],
      },
      {
        name: 'allowed-nine',
        recoveryTableNames: fixtureTableNames,
        allowedTableNames: [
          ...fixtureTableNames,
          ...fixtureAdditionalTableNames.slice(0, 3),
        ],
      },
      {
        name: 'allowed-duplicate',
        recoveryTableNames: fixtureTableNames,
        allowedTableNames: [
          ...fixtureTableNames.slice(0, 5),
          fixtureTableNames[0] ?? '',
        ],
      },
      {
        name: 'allowed-invalid',
        recoveryTableNames: fixtureTableNames,
        allowedTableNames: [
          ...fixtureTableNames.slice(0, 5),
          '',
        ],
      },
    ]

    for (const invalid of invalidVectors) {
      const store = new InMemoryRateCheckpointStore()
      const observations: unknown[] = []
      const observedAwsCallCount = observedDescribeTableNames.length
      await expect(
        createWorkspaceSearchMigrationManagedDescribeTableRate({
          account: fixtureAccount,
          region: fixtureRegion,
          recoveryTableNames: invalid.recoveryTableNames,
          allowedTableNames: invalid.allowedTableNames,
          policy: fixturePolicy,
          checkpointStore: store,
          credentials: fixtureCredentials,
          bootstrap: true,
          recorder: {
            record: (observation): void => {
              observations.push(observation)
            },
          },
        }),
        invalid.name,
      ).rejects.toThrow('MANAGED_DESCRIBE_TABLE_RATE_FAILED')
      expect(store.readCompareAndSwapCallCount(), invalid.name).toBe(0)
      expect(observations, invalid.name).toEqual([])
      expect(observedDescribeTableNames, invalid.name).toHaveLength(
        observedAwsCallCount,
      )
    }
  })


  test('rejects a disallowed table before every surface side effect', async () => {
    observedDescribeTableNames.length = 0
    const store = new InMemoryRateCheckpointStore()
    const observations: unknown[] = []
    const rate = await createManagedRate(store, {
      bootstrap: true,
      allowedTableNames: fixtureTableNames,
      recorder: {
        record: (observation): void => {
          observations.push(observation)
        },
      },
    })
    const disallowedTableName = 'rate-managed-test-disallowed'

    /** Verifies one rejection against all externally observable side effects. */
    const expectNoSideEffects = async (
      phase: WorkspaceSearchMigrationDescribeTablePhase,
    ): Promise<void> => {
      const checkpointCasCount = store.readCompareAndSwapCallCount()
      const observationCount = observations.length
      const awsCallCount = observedDescribeTableNames.length
      await expectManagedTableRejection(rate, disallowedTableName, phase)
      expect(store.readCompareAndSwapCallCount()).toBe(checkpointCasCount)
      expect(observations).toHaveLength(observationCount)
      expect(observedDescribeTableNames).toHaveLength(awsCallCount)
    }

    await expectNoSideEffects('measurement')
    await rate.runNonPageOperation(
      async () => await expectNoSideEffects('pre-send-guard'),
    )
    await rate.runCheckpointPage(
      {},
      async () => await expectNoSideEffects('checkpoint-page'),
    )
    await rate.runMandatoryCleanup(
      async () => await expectNoSideEffects('post-send-guard'),
    )
    expect(rate.readEvidence().attemptCount).toBe(0)
    await rate.close()
  })

  test('reads every construction field once before a blocked load', async () => {
    const store = new InMemoryRateCheckpointStore()
    const replacementStore = new InMemoryRateCheckpointStore()
    const blockedLoad = store.blockLoadAfter(0)
    const aborted = new AbortController()
    aborted.abort()
    let changed = false
    let loadMethodReadCount = 0
    let compareAndSwapMethodReadCount = 0
    const checkpointStore:
      WorkspaceSearchMigrationDescribeTableRateCheckpointStore = {
        get load() {
          loadMethodReadCount += 1
          return (scopeBindingDigest: string) =>
            store.load(scopeBindingDigest)
        },
        get compareAndSwap() {
          compareAndSwapMethodReadCount += 1
          return (
            write:
              WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
          ) => store.compareAndSwap(write)
        },
      }
    const readCounts = new Map<string, number>()
    const recordRead = (name: string): void => {
      readCounts.set(name, (readCounts.get(name) ?? 0) + 1)
    }
    const input: CreateWorkspaceSearchMigrationManagedDescribeTableRateInput = {
      get account() {
        recordRead('account')
        return changed ? '999999999999' : fixtureAccount
      },
      get region() {
        recordRead('region')
        return changed ? 'invalid' : fixtureRegion
      },
      get recoveryTableNames() {
        recordRead('recoveryTableNames')
        return changed ? ['invalid'] : fixtureTableNames
      },
      get allowedTableNames() {
        recordRead('allowedTableNames')
        return changed ? ['invalid'] : fixtureTableNames
      },
      get policy() {
        recordRead('policy')
        return changed
          ? { ...fixturePolicy, checkpointPageAttemptCapacity: 1 }
          : fixturePolicy
      },
      get checkpointStore() {
        recordRead('checkpointStore')
        return changed ? replacementStore : checkpointStore
      },
      get credentials() {
        recordRead('credentials')
        return changed
          ? { ...fixtureCredentials, secretAccessKey: '' }
          : fixtureCredentials
      },
      get bootstrap() {
        recordRead('bootstrap')
        return !changed
      },
      get recoverInterruptedCleanup() {
        recordRead('recoverInterruptedCleanup')
        return changed
      },
      get recoverInterruptedAttempt() {
        recordRead('recoverInterruptedAttempt')
        return changed
      },
      get recorder() {
        recordRead('recorder')
        return undefined
      },
      get signal() {
        recordRead('signal')
        return changed ? aborted.signal : undefined
      },
    }
    const creating =
      createWorkspaceSearchMigrationManagedDescribeTableRate(input)

    await blockedLoad.observed
    changed = true
    blockedLoad.release()
    const rate = await creating

    expect(readCounts.size).toBe(12)
    expect([...readCounts.values()]).toEqual(
      Array.from({ length: readCounts.size }, () => 1),
    )
    expect(store.readCompareAndSwapCallCount()).toBeGreaterThan(0)
    expect(replacementStore.readCompareAndSwapCallCount()).toBe(0)
    expect(loadMethodReadCount).toBe(1)
    expect(compareAndSwapMethodReadCount).toBe(1)
    await rate.close()
  })

  test('does not start initial claim CAS after its signal aborts', async () => {
    const store = new InMemoryRateCheckpointStore()
    const blockedLoad = store.blockLoadAfter(1)
    const controller = new AbortController()
    const creating = createManagedRate(store, {
      bootstrap: true,
      signal: controller.signal,
    })

    await blockedLoad.observed
    controller.abort()
    blockedLoad.release()
    await expect(creating).rejects.toThrow(
      'DescribeTable stopped (interrupted)',
    )
    expect(store.readCompareAndSwapCallCount()).toBe(0)
  })

  test('does not start successor claim CAS after load-time interruption', async () => {
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const initialCasCount = store.readCompareAndSwapCallCount()
    const blockedLoad = store.blockLoadAfter(0)
    const claim = rate.claimAfterLease(1)

    await blockedLoad.observed
    rate.interrupt()
    blockedLoad.release()
    await expect(claim).rejects.toThrow(
      'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
    )
    expect(store.readCompareAndSwapCallCount()).toBe(initialCasCount)
    await rate.close()
  })

  test('rejects a non-page descendant after its callback settles', async () => {
    observedDescribeTableNames.length = 0
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const releaseDescendant = createDeferred<void>()
    let escaped:
      Promise<DescribeTableCommandOutput> | undefined

    await rate.runNonPageOperation(async () => {
      escaped = (async () => {
        await releaseDescendant.promise
        return await rate.describeTable(
          fixtureTableNames[0] ?? '',
          'measurement',
        )
      })()
    })
    releaseDescendant.resolve()
    const escapedOperation = escaped
    if (escapedOperation === undefined) {
      throw new Error('Expected escaped descendant operation.')
    }
    await expect(escapedOperation).rejects.toThrow(
      'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
    )
    expect(observedDescribeTableNames).toEqual([])
    await rate.close()
  })

  test('rejects an escaped page mutation after its callback settles', async () => {
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const releaseDescendant = createDeferred<void>()
    let escaped: Promise<void> | undefined
    let mutationCount = 0

    await rate.runCheckpointPage({}, async () => {
      escaped = (async () => {
        await releaseDescendant.promise
        rate.assertNewDataIoAllowed()
        mutationCount += 1
      })()
    })
    releaseDescendant.resolve()
    const escapedMutation = escaped
    if (escapedMutation === undefined) {
      throw new Error('Expected escaped descendant mutation.')
    }
    await expect(escapedMutation).rejects.toThrow(
      'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
    )
    expect(mutationCount).toBe(0)
    await rate.close()
  })

  test('rejects a hostile checkpoint-page signal accessor', async () => {
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const input = {
      get signal(): AbortSignal | undefined {
        throw new Error('raw-signal-accessor')
      },
    }

    await expect(
      rate.runCheckpointPage(input, async () => {}),
    ).rejects.toThrow('MANAGED_DESCRIBE_TABLE_RATE_FAILED')
    await rate.close()
  })

  test('starts a page callback only after reservation and reuses it for cleanup', async () => {
    observedDescribeTableNames.length = 0
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const reservation = store.blockNextPageReservation()
    let callbackStarted = false

    const operation = rate.runCheckpointPage({}, async () => {
      callbackStarted = true
      await rate.runMandatoryCleanup(async () => {
        for (const tableName of fixtureTableNames) {
          await rate.describeTable(tableName, 'post-send-guard')
        }
      })
    })
    await reservation.observed
    expect(callbackStarted).toBe(false)
    expect(observedDescribeTableNames).toEqual([])

    reservation.release()
    await operation
    expect(callbackStarted).toBe(true)
    expect(observedDescribeTableNames).toEqual([...fixtureTableNames])
    expect(store.readPageReservationCount()).toBe(1)
    await rate.close()
  })

  test('serializes page ownership and a complete non-page operation', async () => {
    observedDescribeTableNames.length = 0
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const pageStarted = createDeferred<void>()
    const releasePage = createDeferred<void>()
    describeTableCallbacks.set(
      fixtureTableNames[0] ?? '',
      async () => {
        pageStarted.resolve()
        await releasePage.promise
        return { $metadata: { attempts: 1 } }
      },
    )

    const page = rate.runCheckpointPage({}, async () =>
      await rate.describeTable(
        fixtureTableNames[0] ?? '',
        'checkpoint-page',
      ))
    await pageStarted.promise
    const nonPage = rate.runNonPageOperation(async () =>
      await rate.describeTable(
        fixtureTableNames[1] ?? '',
        'pre-send-guard',
      ))
    await Promise.resolve()
    expect(observedDescribeTableNames).toEqual([fixtureTableNames[0]])

    releasePage.resolve()
    await Promise.all([page, nonPage])
    expect(observedDescribeTableNames).toEqual([
      fixtureTableNames[0],
      fixtureTableNames[1],
    ])
    await rate.close()
    describeTableCallbacks.clear()
  })

  test('uses one page for inside and outside mandatory cleanup', async () => {
    observedDescribeTableNames.length = 0
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const runAllSix = async (): Promise<void> => {
      for (const tableName of fixtureTableNames) {
        await rate.describeTable(tableName, 'post-send-guard')
      }
    }

    await rate.runCheckpointPage({}, async () =>
      await rate.runMandatoryCleanup(runAllSix))
    await rate.runMandatoryCleanup(runAllSix)

    expect(observedDescribeTableNames).toHaveLength(12)
    expect(store.read()?.reservedAttempts).toBe(0)
    expect(store.read()?.mandatoryCleanupRequired).toBe(false)
    expect(rate.readEvidence().attemptCount).toBe(12)
    const firstClose = rate.close()
    expect(rate.close()).toBe(firstClose)
    await firstClose
  })

  test('closes only after admitted work contributes to final evidence', async () => {
    observedDescribeTableNames.length = 0
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const started = createDeferred<void>()
    const release = createDeferred<void>()
    describeTableCallbacks.set(fixtureTableNames[0] ?? '', async () => {
      started.resolve()
      await release.promise
      const error = new Error('test-throttle')
      error.name = 'ThrottlingException'
      throw error
    })

    const operation = rate.describeTable(
      fixtureTableNames[0] ?? '',
      'measurement',
    )
    await started.promise
    expect(rate.readEvidence().throttleCount).toBe(0)

    const finalEvidence = rate.closeAndReadEvidence()
    expect(rate.closeAndReadEvidence()).toBe(finalEvidence)
    expect(() => rate.readEvidence()).toThrow(
      'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
    )
    release.resolve()

    await expect(operation).rejects.toThrow()
    await expect(finalEvidence).resolves.toMatchObject({
      attemptCount: 1,
      throttleCount: 1,
    })
    describeTableCallbacks.clear()
  })

  test('defers interruption until an active all-six cleanup finishes', async () => {
    observedDescribeTableNames.length = 0
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })

    const operation = rate.runMandatoryCleanup(async () => {
      rate.interrupt()
      for (const tableName of fixtureTableNames) {
        await rate.describeTable(tableName, 'post-send-guard')
      }
    })
    await expect(operation).rejects.toThrow()
    expect(observedDescribeTableNames).toEqual([...fixtureTableNames])
    await expect(
      rate.describeTable(fixtureTableNames[0] ?? '', 'measurement'),
    ).rejects.toThrow('MANAGED_DESCRIBE_TABLE_RATE_FAILED')
    await rate.close()
  })

  test('clears cleanup when interruption rejects a pre-send mutation', async () => {
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    let cleanupEntered = false

    await expect(rate.runCheckpointPage({}, async () => {
      await rate.runMandatoryCleanup(async () => {
        cleanupEntered = true
        rate.interrupt()
        rate.assertNewDataIoAllowed()
      })
    })).rejects.toThrow('MANAGED_DESCRIBE_TABLE_RATE_FAILED')

    expect(cleanupEntered).toBeTrue()
    expect(store.read()).toMatchObject({
      attemptInFlight: false,
      mandatoryCleanupRequired: false,
      reservationKind: 'none',
      reservedAttempts: 0,
    })
    await rate.close()
  })

  test('rechecks interruption after cleanup-marker CAS before mutation', async () => {
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const marker = store.blockNextCleanupMarker()
    let cleanupEntered = false
    let mutationCount = 0

    const operation = rate.runCheckpointPage({}, async () => {
      await rate.runMandatoryCleanup(async () => {
        cleanupEntered = true
        rate.assertNewDataIoAllowed()
        mutationCount += 1
      })
    })
    await marker.observed
    expect(cleanupEntered).toBeFalse()
    rate.interrupt()
    marker.release()

    await expect(operation).rejects.toThrow(
      'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
    )
    expect(cleanupEntered).toBeTrue()
    expect(mutationCount).toBe(0)
    expect(store.read()).toMatchObject({
      attemptInFlight: false,
      mandatoryCleanupRequired: false,
      reservationKind: 'none',
      reservedAttempts: 0,
    })
    await rate.close()
  })

  test('runs a lease guard at the exact cleanup mutation boundary', async () => {
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const guardFailure = new Error('lease-headroom-expired')
    let guardCallCount = 0
    let mutationCount = 0

    const operation = rate.runWithMutationAdmissionGuard(
      () => {
        guardCallCount += 1
        rate.interrupt()
        throw guardFailure
      },
      async () => await rate.runCheckpointPage({}, async () => {
        await rate.runMandatoryCleanup(async () => {
          rate.assertNewDataIoAllowed()
          mutationCount += 1
        })
      }),
    )

    await expect(operation).rejects.toBe(guardFailure)
    expect(guardCallCount).toBe(1)
    expect(mutationCount).toBe(0)
    expect(store.read()).toMatchObject({
      attemptInFlight: false,
      mandatoryCleanupRequired: false,
      reservationKind: 'none',
      reservedAttempts: 0,
    })
    await rate.close()
  })

  test('stops a post-read mutation when lease headroom expires', async () => {
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const heartbeatAt = Date.parse('2026-07-29T04:00:00.000Z')
    const lease = {
      runId: 'run-2026-07-29-guard',
      ownerId: 'owner-process-guard',
      fenceToken: 9,
      heartbeatAt: new Date(heartbeatAt).toISOString(),
      expiresAt: new Date(heartbeatAt + 60_000).toISOString(),
    }
    const readStarted = createDeferred<void>()
    const releaseRead = createDeferred<void>()
    let now = heartbeatAt
    let mutationCount = 0

    const operation = runWithWorkspaceSearchMigrationHeartbeat({
      lease,
      port: {
        /** Returns the exact current lease for the initial heartbeat. */
        heartbeatLease: async () => lease,
        /** Installs the supervisor guard on the shared rate controller. */
        runWithMutationAdmissionGuard: async (guard, task) =>
          await rate.runWithMutationAdmissionGuard(guard, task),
        /** Stops every mutation that has not reached its send boundary. */
        interruptMutationAdmission: () => rate.interrupt(),
      },
      clock: () => new Date(now),
      task: async () => {
        readStarted.resolve()
        await releaseRead.promise
        await rate.runMandatoryCleanup(async () => {
          rate.assertNewDataIoAllowed()
          mutationCount += 1
        })
      },
    })

    await readStarted.promise
    now = heartbeatAt + 50_000
    releaseRead.resolve()

    await expect(operation).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(mutationCount).toBe(0)
    expect(store.read()).toMatchObject({
      attemptInFlight: false,
      mandatoryCleanupRequired: false,
      reservationKind: 'none',
      reservedAttempts: 0,
    })
    await rate.close()
  })

  test('rejects a descendant retaining a settled mutation guard', async () => {
    const store = new InMemoryRateCheckpointStore()
    const rate = await createManagedRate(store, { bootstrap: true })
    const releaseDescendant = createDeferred<void>()
    let escaped: Promise<void> | undefined
    let guardCallCount = 0
    let mutationCount = 0

    await rate.runWithMutationAdmissionGuard(
      () => {
        guardCallCount += 1
      },
      async () => {
        escaped = (async () => {
          await releaseDescendant.promise
          rate.assertNewDataIoAllowed()
          mutationCount += 1
        })()
      },
    )
    releaseDescendant.resolve()
    const escapedMutation = escaped
    if (escapedMutation === undefined) {
      throw new Error('Expected escaped guarded mutation.')
    }

    await expect(escapedMutation).rejects.toThrow(
      'MANAGED_DESCRIBE_TABLE_RATE_FAILED',
    )
    expect(guardCallCount).toBe(0)
    expect(mutationCount).toBe(0)
    await rate.close()
  })

  test('claims a strict successor fence after restart', async () => {
    const store = new InMemoryRateCheckpointStore()
    const first = await createManagedRate(store, { bootstrap: true })
    expect(store.read()?.fenceToken).toBe(0)
    await first.close()

    const restarted = await createManagedRate(store, { bootstrap: false })
    expect(store.read()?.fenceToken).toBe(1)
    await restarted.close()
  })

  test('requires and completes both authorized restart recoveries', async () => {
    observedDescribeTableNames.length = 0
    const store = new InMemoryRateCheckpointStore()
    const first = await createManagedRate(store, { bootstrap: true })
    store.failNextAttemptCompletion()
    await expect(
      first.runMandatoryCleanup(async () => {
        await first.describeTable(
          fixtureTableNames[0] ?? '',
          'post-send-guard',
        )
      }),
    ).rejects.toThrow()
    expect(store.read()?.attemptInFlight).toBe(true)
    expect(store.read()?.mandatoryCleanupRequired).toBe(true)
    await first.close()

    await expect(
      createManagedRate(store, {
        bootstrap: false,
        recoverInterruptedCleanup: true,
        recoverInterruptedAttempt: false,
      }),
    ).rejects.toThrow()

    observedDescribeTableNames.length = 0
    const recovered = await createManagedRate(store, {
      bootstrap: false,
      recoverInterruptedCleanup: true,
      recoverInterruptedAttempt: true,
      allowedTableNames: fixtureTableNames,
    })
    expect(observedDescribeTableNames).toEqual([...fixtureTableNames])
    expect(store.read()?.attemptInFlight).toBe(false)
    expect(store.read()?.mandatoryCleanupRequired).toBe(false)
    expect(store.read()?.fenceToken).toBeGreaterThan(0)
    await recovered.close()
  })
})
