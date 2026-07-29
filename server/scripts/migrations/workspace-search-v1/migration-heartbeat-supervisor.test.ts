import { describe, expect, test } from 'bun:test'
import {
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationLease,
} from './migration-contract'
import {
  runWithWorkspaceSearchMigrationHeartbeat,
  WORKSPACE_SEARCH_MIGRATION_HEARTBEAT_INTERVAL_MILLISECONDS,
  WorkspaceSearchMigrationHeartbeatInterruptedError,
  type WorkspaceSearchMigrationHeartbeatPort,
  type WorkspaceSearchMigrationHeartbeatScheduler,
  type WorkspaceSearchMigrationHeartbeatTimerHandle,
} from './migration-heartbeat-supervisor'
import type {
  HeartbeatWorkspaceSearchMigrationLeaseInput,
} from './migration-state-machine'

const fixtureNow = Date.parse('2026-07-29T04:00:00.000Z')

/**
 * One manually scheduled heartbeat callback.
 */
type ManualHeartbeat = {
  /** One-shot callback supplied by the supervisor. */
  readonly callback: () => void
  /** Requested delay in milliseconds. */
  readonly delayMilliseconds: number
  /** Whether cancellation happened before callback execution. */
  canceled: boolean
  /** Whether the callback already started. */
  started: boolean
}

/**
 * Deterministic scheduler that never advances without an explicit test call.
 */
class ManualHeartbeatScheduler
  implements WorkspaceSearchMigrationHeartbeatScheduler {
  /** Every one-shot heartbeat scheduled by the supervisor. */
  readonly heartbeats: ManualHeartbeat[] = []

  /**
   * Records one scheduled heartbeat.
   *
   * @param callback - One-shot callback.
   * @param delayMilliseconds - Requested delay.
   * @returns Cancelable handle for the recorded callback.
   */
  schedule(
    callback: () => void,
    delayMilliseconds: number,
  ): WorkspaceSearchMigrationHeartbeatTimerHandle {
    const heartbeat: ManualHeartbeat = {
      callback,
      delayMilliseconds,
      canceled: false,
      started: false,
    }
    this.heartbeats.push(heartbeat)
    return {
      cancel: (): void => {
        heartbeat.canceled = true
      },
    }
  }

  /**
   * Starts the oldest active scheduled heartbeat.
   */
  runNext(): void {
    const heartbeat = this.heartbeats.find(
      (candidate) => !candidate.canceled && !candidate.started,
    )
    if (heartbeat === undefined) {
      throw new Error('No active heartbeat is scheduled.')
    }
    heartbeat.started = true
    heartbeat.callback()
  }

  /**
   * Returns active callbacks that have not started.
   *
   * @returns Number of pending active callbacks.
   */
  countPending(): number {
    return this.heartbeats.filter(
      (heartbeat) => !heartbeat.canceled && !heartbeat.started,
    ).length
  }
}

/**
 * Injectable heartbeat implementation used by the recording port.
 */
type HeartbeatImplementation = (
  input: HeartbeatWorkspaceSearchMigrationLeaseInput,
) => Promise<WorkspaceSearchMigrationLease>

/**
 * Narrow port that records every stable heartbeat claim.
 */
class RecordingHeartbeatPort implements WorkspaceSearchMigrationHeartbeatPort {
  /** Detached heartbeat claims received by the port. */
  readonly claims: HeartbeatWorkspaceSearchMigrationLeaseInput[] = []

  /** Test-owned heartbeat behavior. */
  private readonly implementation: HeartbeatImplementation

  /**
   * Creates one recording port.
   *
   * @param implementation - Behavior executed after recording each claim.
   */
  constructor(implementation: HeartbeatImplementation) {
    this.implementation = implementation
  }

  /**
   * Records and delegates one heartbeat.
   *
   * @param input - Stable lease claim.
   * @returns Test-owned durable successor.
   */
  async heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    this.claims.push({
      lease: {
        runId: input.lease.runId,
        ownerId: input.lease.ownerId,
        fenceToken: input.lease.fenceToken,
      },
    })
    return await this.implementation(input)
  }
}

/**
 * Externally resolved promise used to hold one task or heartbeat in flight.
 */
type Deferred<Value> = {
  /** Pending promise. */
  readonly promise: Promise<Value>
  /** Resolves the promise once. */
  readonly resolve: (value: Value) => void
}

/**
 * Creates one externally resolved promise.
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
 * Creates one valid durable lease around the fixture clock.
 *
 * @param heartbeatOffsetMilliseconds - Offset from the fixture clock.
 * @param expiryOffsetMilliseconds - Offset from the fixture clock.
 * @returns Valid detached lease.
 */
function createLease(
  heartbeatOffsetMilliseconds = 0,
  expiryOffsetMilliseconds = 60_000,
): WorkspaceSearchMigrationLease {
  return {
    runId: 'run-2026-07-29-01',
    ownerId: 'owner-process-01',
    fenceToken: 7,
    heartbeatAt: new Date(
      fixtureNow + heartbeatOffsetMilliseconds,
    ).toISOString(),
    expiresAt: new Date(
      fixtureNow + expiryOffsetMilliseconds,
    ).toISOString(),
  }
}

/**
 * Allows queued promise continuations to run.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Captures one rejected promise without relying on assertion-time narrowing.
 *
 * @param promise - Promise expected to reject.
 * @returns Caught unknown failure.
 */
async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error('Expected promise to reject.')
}

describe('Workspace Search migration heartbeat supervisor', () => {
  test('schedules from durable heartbeat time and preserves the exact claim', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const task = createDeferred<string>()
    let heartbeatCount = 0
    const port = new RecordingHeartbeatPort(async () => {
      heartbeatCount += 1
      return heartbeatCount === 1
        ? createLease(-5_000, 55_000)
        : createLease()
    })
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async () => await task.promise,
    })

    await flushMicrotasks()
    expect(scheduler.heartbeats[0]?.delayMilliseconds).toBe(15_000)
    expect(port.claims).toHaveLength(1)
    scheduler.runNext()
    await flushMicrotasks()

    expect(port.claims).toEqual([
      {
        lease: {
          runId: 'run-2026-07-29-01',
          ownerId: 'owner-process-01',
          fenceToken: 7,
        },
      },
      {
        lease: {
          runId: 'run-2026-07-29-01',
          ownerId: 'owner-process-01',
          fenceToken: 7,
        },
      },
    ])
    expect(scheduler.countPending()).toBe(1)
    expect(scheduler.heartbeats[1]?.delayMilliseconds).toBe(
      WORKSPACE_SEARCH_MIGRATION_HEARTBEAT_INTERVAL_MILLISECONDS,
    )

    task.resolve('completed')
    await expect(result).resolves.toBe('completed')
    expect(scheduler.countPending()).toBe(0)
  })

  test('never delays beyond twenty seconds when the clock moves backward', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const task = createDeferred<string>()
    const port = new RecordingHeartbeatPort(
      async () => createLease(5_000, 65_000),
    )
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async () => await task.promise,
    })

    await flushMicrotasks()
    expect(scheduler.heartbeats[0]?.delayMilliseconds).toBe(
      WORKSPACE_SEARCH_MIGRATION_HEARTBEAT_INTERVAL_MILLISECONDS,
    )

    task.resolve('completed')
    await expect(result).resolves.toBe('completed')
  })

  test('keeps the stable claim isolated from task and port mutation', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const task = createDeferred<string>()
    const portMutationResults: boolean[] = []
    const port = new RecordingHeartbeatPort(async (input) => {
      portMutationResults.push(
        Reflect.set(input.lease, 'fenceToken', 8),
      )
      return createLease()
    })
    let taskMutationResult: boolean | undefined
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async (context) => {
        taskMutationResult =
          Reflect.set(context.lease, 'fenceToken', 8)
        return await task.promise
      },
    })

    await flushMicrotasks()
    expect(taskMutationResult).toBe(false)
    expect(portMutationResults).toEqual([true])
    scheduler.runNext()
    await flushMicrotasks()
    expect(portMutationResults).toEqual([true, true])
    expect(port.claims).toEqual([
      {
        lease: {
          runId: 'run-2026-07-29-01',
          ownerId: 'owner-process-01',
          fenceToken: 7,
        },
      },
      {
        lease: {
          runId: 'run-2026-07-29-01',
          ownerId: 'owner-process-01',
          fenceToken: 7,
        },
      },
    ])

    task.resolve('completed')
    await expect(result).resolves.toBe('completed')
  })

  test('never overlaps heartbeats and waits for an in-flight heartbeat', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const task = createDeferred<string>()
    const heartbeat = createDeferred<WorkspaceSearchMigrationLease>()
    let heartbeatCount = 0
    const port = new RecordingHeartbeatPort(async () => {
      heartbeatCount += 1
      return heartbeatCount === 1
        ? createLease()
        : await heartbeat.promise
    })
    let settled = false
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async () => await task.promise,
    }).finally(() => {
      settled = true
    })

    await flushMicrotasks()
    scheduler.runNext()
    await flushMicrotasks()
    expect(port.claims).toHaveLength(2)
    expect(scheduler.countPending()).toBe(0)

    task.resolve('completed')
    await flushMicrotasks()
    expect(settled).toBe(false)

    heartbeat.resolve(createLease())
    await expect(result).resolves.toBe('completed')
    expect(settled).toBe(true)
    expect(scheduler.countPending()).toBe(0)
  })

  test('redacts an unknown heartbeat failure and suppresses task success', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const canary = 'raw-aws-secret-canary'
    let heartbeatCount = 0
    const port = new RecordingHeartbeatPort(async () => {
      heartbeatCount += 1
      if (heartbeatCount === 1) return createLease()
      throw new Error(canary)
    })
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async (context) => {
        await waitForAbort(context.signal)
        context.assertActive()
        return 'must-not-return'
      },
    })

    await flushMicrotasks()
    scheduler.runNext()
    const error = await captureFailure(result)
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a migration failure.')
    }
    expect(error.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
    expect(error.message).not.toContain(canary)
    expect(scheduler.countPending()).toBe(0)
  })

  test('preserves a trusted terminal heartbeat failure', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    let heartbeatCount = 0
    const port = new RecordingHeartbeatPort(async () => {
      heartbeatCount += 1
      if (heartbeatCount === 1) return createLease()
      throw new WorkspaceSearchMigrationFailure(
        'LEASE_LOST',
        'Migration lease is no longer owned by this process.',
      )
    })
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async (context) => {
        await waitForAbort(context.signal)
        context.assertActive()
        return 'must-not-return'
      },
    })

    await flushMicrotasks()
    scheduler.runNext()
    const error = await captureFailure(result)
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a migration failure.')
    }
    expect(error.code).toBe('LEASE_LOST')
  })

  test('rejects a heartbeat successor with a different fence identity', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const port = new RecordingHeartbeatPort(async () => ({
      ...createLease(),
      fenceToken: 8,
    }))
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async (context) => {
        await waitForAbort(context.signal)
        context.assertActive()
        return 'must-not-return'
      },
    })

    const error = await captureFailure(result)
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a migration failure.')
    }
    expect(error.code).toBe('INVALID_STATE')
  })

  test('cancels pending heartbeats and fails when the operator interrupts', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const controller = new AbortController()
    const port = new RecordingHeartbeatPort(async () => createLease())
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      signal: controller.signal,
      clock: () => new Date(fixtureNow),
      task: async (context) => {
        await waitForAbort(context.signal)
        context.assertActive()
        return 'must-not-return'
      },
    })

    await flushMicrotasks()
    expect(scheduler.countPending()).toBe(1)
    controller.abort()
    const error = await captureFailure(result)
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationHeartbeatInterruptedError,
    )
    expect(port.claims).toHaveLength(1)
    expect(scheduler.countPending()).toBe(0)
  })

  test('prioritizes an in-flight heartbeat failure over interruption', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const controller = new AbortController()
    const heartbeat = createDeferred<WorkspaceSearchMigrationLease>()
    let heartbeatCount = 0
    const port = new RecordingHeartbeatPort(async () => {
      heartbeatCount += 1
      if (heartbeatCount === 1) return createLease()
      return await heartbeat.promise
    })
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      signal: controller.signal,
      clock: () => new Date(fixtureNow),
      task: async (context) => {
        await waitForAbort(context.signal)
        context.assertActive()
        return 'must-not-return'
      },
    })

    await flushMicrotasks()
    scheduler.runNext()
    await flushMicrotasks()
    controller.abort()
    heartbeat.resolve({
      ...createLease(),
      fenceToken: 8,
    })

    const error = await captureFailure(result)
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a migration failure.')
    }
    expect(error.code).toBe('INVALID_STATE')
    expect(port.claims).toHaveLength(2)
    expect(scheduler.countPending()).toBe(0)
  })

  test('rejects a periodic successor without commit headroom', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    let heartbeatCount = 0
    const port = new RecordingHeartbeatPort(async () => {
      heartbeatCount += 1
      return heartbeatCount === 1
        ? createLease()
        : createLease(-50_000, 10_000)
    })
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async (context) => {
        await waitForAbort(context.signal)
        context.assertActive()
        return 'must-not-return'
      },
    })

    await flushMicrotasks()
    scheduler.runNext()
    const error = await captureFailure(result)
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a migration failure.')
    }
    expect(error.code).toBe('LEASE_LOST')
    expect(port.claims).toHaveLength(2)
    expect(scheduler.countPending()).toBe(0)
  })

  test('stops new work when the latest known lease loses headroom', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    let now = fixtureNow
    const port = new RecordingHeartbeatPort(async () => createLease())
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(now),
      task: async (context) => {
        now = fixtureNow + 50_000
        context.assertActive()
        return 'must-not-return'
      },
    })

    const error = await captureFailure(result)
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a migration failure.')
    }
    expect(error.code).toBe('LEASE_LOST')
    expect(port.claims).toHaveLength(1)
    expect(scheduler.countPending()).toBe(0)
  })

  test('rejects a lease without more than ten seconds of headroom', async () => {
    const scheduler = new ManualHeartbeatScheduler()
    const port = new RecordingHeartbeatPort(
      async () => createLease(-50_000, 10_000),
    )
    let taskStarted = false
    const result = runWithWorkspaceSearchMigrationHeartbeat({
      lease: createLease(),
      port,
      scheduler,
      clock: () => new Date(fixtureNow),
      task: async () => {
        taskStarted = true
        return 'must-not-return'
      },
    })

    const error = await captureFailure(result)
    if (!(error instanceof WorkspaceSearchMigrationFailure)) {
      throw new Error('Expected a migration failure.')
    }
    expect(error.code).toBe('LEASE_LOST')
    expect(taskStarted).toBe(false)
    expect(port.claims).toHaveLength(1)
    expect(scheduler.heartbeats).toHaveLength(0)
  })
})

/**
 * Resolves when a signal is aborted.
 *
 * @param signal - Supervised task signal.
 */
async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
