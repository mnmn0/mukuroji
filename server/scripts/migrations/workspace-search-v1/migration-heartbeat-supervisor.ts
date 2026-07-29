import {
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationLease,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
  validateWorkspaceSearchMigrationLease,
  type HeartbeatWorkspaceSearchMigrationLeaseInput,
  type WorkspaceSearchMigrationLeaseClaim,
} from './migration-state-machine'

/**
 * Fixed heartbeat cadence for the sixty-second migration lease.
 *
 * A successful heartbeat restores the full lease duration. Scheduling the next
 * heartbeat only after the previous one finishes prevents overlap while keeping
 * substantially more than the ten-second atomic commit window.
 */
export const WORKSPACE_SEARCH_MIGRATION_HEARTBEAT_INTERVAL_MILLISECONDS =
  20_000

/**
 * Narrow lease port required by the heartbeat supervisor.
 */
export interface WorkspaceSearchMigrationHeartbeatPort {
  /**
   * Extends one exact active lease.
   *
   * @param input - Stable run, owner, and fence identity.
   * @returns Exact durable successor lease.
   */
  heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease>
}

/**
 * Cancelable handle returned by an injected heartbeat scheduler.
 */
export interface WorkspaceSearchMigrationHeartbeatTimerHandle {
  /**
   * Prevents the scheduled callback from starting.
   */
  cancel(): void
}

/**
 * Injectable one-shot scheduler used to test heartbeat races deterministically.
 */
export interface WorkspaceSearchMigrationHeartbeatScheduler {
  /**
   * Schedules one callback after the fixed delay.
   *
   * @param callback - One-shot callback that starts a heartbeat.
   * @param delayMilliseconds - Safe delay derived from the durable lease.
   * @returns Cancelable one-shot timer.
   */
  schedule(
    callback: () => void,
    delayMilliseconds: number,
  ): WorkspaceSearchMigrationHeartbeatTimerHandle
}

/**
 * Injectable wall clock used to schedule from durable heartbeat timestamps.
 */
export type WorkspaceSearchMigrationHeartbeatClock = () => Date

/**
 * Immutable lease identity exposed to one supervised task.
 */
export type WorkspaceSearchMigrationHeartbeatLeaseClaim = {
  /** Run that must retain the durable lease. */
  readonly runId: string
  /** Process owner that must retain the durable lease. */
  readonly ownerId: string
  /** Exact takeover fence retained across every heartbeat. */
  readonly fenceToken: number
}

/**
 * Stable context supplied to one supervised migration operation.
 */
export type WorkspaceSearchMigrationHeartbeatTaskContext = {
  /** Stable lease identity retained across heartbeat successors. */
  readonly lease: WorkspaceSearchMigrationHeartbeatLeaseClaim
  /** Signal aborted by operator interruption or heartbeat failure. */
  readonly signal: AbortSignal
  /**
   * Fails before the next operation when supervision is no longer active.
   */
  readonly assertActive: () => void
}

/**
 * Complete input for one heartbeat-supervised migration operation.
 */
export type RunWithWorkspaceSearchMigrationHeartbeatInput<Result> = {
  /** Initial durable lease acquired by the same measured session. */
  readonly lease: WorkspaceSearchMigrationLease
  /** Narrow port used only for exact lease heartbeats. */
  readonly port: WorkspaceSearchMigrationHeartbeatPort
  /** Operation that must remain under the stable lease identity. */
  readonly task: (
    context: WorkspaceSearchMigrationHeartbeatTaskContext,
  ) => Promise<Result>
  /** Optional operator-interruption signal. */
  readonly signal?: AbortSignal
  /** Optional deterministic scheduler used by tests. */
  readonly scheduler?: WorkspaceSearchMigrationHeartbeatScheduler
  /** Optional deterministic wall clock used by tests. */
  readonly clock?: WorkspaceSearchMigrationHeartbeatClock
}

/**
 * Stable interruption raised without exposing an OS signal or caller input.
 */
export class WorkspaceSearchMigrationHeartbeatInterruptedError extends Error {
  /** Stable machine-readable interruption code. */
  readonly code = 'INTERRUPTED'

  /**
   * Creates one raw-value-free interruption.
   */
  constructor() {
    super('INTERRUPTED')
    this.name = 'WorkspaceSearchMigrationHeartbeatInterruptedError'
  }
}

/**
 * Runs one operation while renewing its exact fenced lease every twenty seconds.
 *
 * Heartbeats never overlap. Completion waits for an already-started heartbeat,
 * cancels every pending timer, and suppresses a task result when a concurrent
 * heartbeat failed or the operator interrupted the operation. The task must call
 * `assertActive` between external operations and should pass `signal` to any
 * boundary that supports cancellation.
 *
 * @param input - Initial lease, narrow heartbeat port, task, and optional signal.
 * @returns The task result only when supervision remained healthy through cleanup.
 * @throws {WorkspaceSearchMigrationFailure} When a heartbeat fails or changes identity.
 * @throws {WorkspaceSearchMigrationHeartbeatInterruptedError} When interrupted.
 */
export async function runWithWorkspaceSearchMigrationHeartbeat<Result>(
  input: RunWithWorkspaceSearchMigrationHeartbeatInput<Result>,
): Promise<Result> {
  const lease = createLeaseClaim(input.lease)
  const scheduler = input.scheduler ?? defaultHeartbeatScheduler
  const clock = input.clock ?? defaultHeartbeatClock
  const taskAbortController = new AbortController()
  let latestLease = detachLease(input.lease)
  let scheduledHeartbeat:
    WorkspaceSearchMigrationHeartbeatTimerHandle | undefined
  let inFlightHeartbeat: Promise<void> | undefined
  let heartbeatFailure: WorkspaceSearchMigrationFailure | undefined
  let interrupted = input.signal?.aborted === true
  let heartbeatEstablished = false
  let stopped = false

  /**
   * Cancels the currently pending one-shot timer.
   */
  const cancelScheduledHeartbeat = (): void => {
    const handle = scheduledHeartbeat
    scheduledHeartbeat = undefined
    if (handle === undefined) return
    try {
      handle.cancel()
    } catch {
      heartbeatFailure ??= createHeartbeatFailure()
      abortTask()
    }
  }

  /**
   * Aborts the task signal exactly once.
   */
  const abortTask = (): void => {
    if (!taskAbortController.signal.aborted) {
      taskAbortController.abort()
    }
  }

  /**
   * Records operator interruption and stops future timer callbacks.
   */
  const handleInterruption = (): void => {
    interrupted = true
    abortTask()
    cancelScheduledHeartbeat()
  }

  /**
   * Throws the highest-priority supervision failure observed so far.
   */
  const assertActive = (): void => {
    if (heartbeatFailure !== undefined) {
      throw heartbeatFailure
    }
    if (interrupted || taskAbortController.signal.aborted) {
      throw new WorkspaceSearchMigrationHeartbeatInterruptedError()
    }
    if (heartbeatEstablished) {
      try {
        requireLeaseCommitHeadroom(latestLease, clock)
      } catch (error: unknown) {
        heartbeatFailure ??= classifyHeartbeatFailure(error)
        abortTask()
        throw heartbeatFailure
      }
    }
  }

  /**
   * Schedules the next heartbeat only after the previous one completed.
   */
  const scheduleNextHeartbeat = (): void => {
    if (stopped || interrupted || heartbeatFailure !== undefined) return
    try {
      const delayMilliseconds = createNextHeartbeatDelay(
        latestLease,
        clock,
      )
      scheduledHeartbeat = scheduler.schedule(
        () => {
          scheduledHeartbeat = undefined
          if (stopped || interrupted || heartbeatFailure !== undefined) {
            return
          }
          const heartbeat = runHeartbeat()
          inFlightHeartbeat = heartbeat
          void heartbeat.finally(() => {
            if (inFlightHeartbeat === heartbeat) {
              inFlightHeartbeat = undefined
            }
          })
        },
        delayMilliseconds,
      )
    } catch {
      heartbeatFailure ??= createHeartbeatFailure()
      abortTask()
    }
  }

  /**
   * Runs one exact heartbeat and starts the following one on success.
   */
  const runHeartbeat = async (
    scheduleFollowingHeartbeat = true,
  ): Promise<void> => {
    try {
      const successor = await input.port.heartbeatLease({
        lease: detachLeaseClaim(lease),
      })
      const validatedSuccessor =
        requireHeartbeatSuccess(successor, lease)
      requireLeaseCommitHeadroom(validatedSuccessor, clock)
      latestLease = validatedSuccessor
      heartbeatEstablished = true
    } catch (error: unknown) {
      heartbeatFailure ??= classifyHeartbeatFailure(error)
      abortTask()
    } finally {
      if (scheduleFollowingHeartbeat) {
        scheduleNextHeartbeat()
      }
    }
  }

  if (input.signal !== undefined) {
    input.signal.addEventListener('abort', handleInterruption, {
      once: true,
    })
  }

  let outcome:
    | { readonly status: 'success'; readonly value: Result }
    | { readonly status: 'failure'; readonly error: unknown }
  try {
    assertActive()
    const initialHeartbeat = runHeartbeat(false)
    inFlightHeartbeat = initialHeartbeat
    await initialHeartbeat
    if (inFlightHeartbeat === initialHeartbeat) {
      inFlightHeartbeat = undefined
    }
    assertActive()
    scheduleNextHeartbeat()
    assertActive()
    try {
      outcome = {
        status: 'success',
        value: await input.task({
          lease,
          signal: taskAbortController.signal,
          assertActive,
        }),
      }
    } catch (error: unknown) {
      outcome = { status: 'failure', error }
    }
  } finally {
    stopped = true
    cancelScheduledHeartbeat()
    const heartbeat = inFlightHeartbeat
    if (heartbeat !== undefined) {
      await heartbeat
    }
    input.signal?.removeEventListener('abort', handleInterruption)
  }

  if (heartbeatFailure !== undefined) {
    throw heartbeatFailure
  }
  if (interrupted) {
    throw new WorkspaceSearchMigrationHeartbeatInterruptedError()
  }
  if (outcome.status === 'failure') {
    throw outcome.error
  }
  return outcome.value
}

/**
 * Default one-shot scheduler backed by the runtime timer queue.
 */
const defaultHeartbeatScheduler:
  WorkspaceSearchMigrationHeartbeatScheduler = {
    schedule: (
      callback: () => void,
      delayMilliseconds: number,
    ): WorkspaceSearchMigrationHeartbeatTimerHandle => {
      const timer = setTimeout(callback, delayMilliseconds)
      return {
        cancel: (): void => {
          clearTimeout(timer)
        },
      }
    },
  }

/**
 * Default heartbeat clock backed by the process wall clock.
 *
 * @returns Current detached wall-clock time.
 */
const defaultHeartbeatClock: WorkspaceSearchMigrationHeartbeatClock =
  (): Date => new Date()

/**
 * Validates and detaches one stable lease claim.
 *
 * @param lease - Initial durable lease.
 * @returns Exact run, owner, and fence identity.
 */
function createLeaseClaim(
  lease: WorkspaceSearchMigrationLease,
): WorkspaceSearchMigrationHeartbeatLeaseClaim {
  validateWorkspaceSearchMigrationLease(lease)
  return Object.freeze({
    runId: lease.runId,
    ownerId: lease.ownerId,
    fenceToken: lease.fenceToken,
  })
}

/**
 * Creates a fresh heartbeat-port request without sharing the stable claim.
 *
 * @param claim - Immutable supervisor-owned lease identity.
 * @returns Detached mutable-boundary claim.
 */
function detachLeaseClaim(
  claim: WorkspaceSearchMigrationHeartbeatLeaseClaim,
): WorkspaceSearchMigrationLeaseClaim {
  return {
    runId: claim.runId,
    ownerId: claim.ownerId,
    fenceToken: claim.fenceToken,
  }
}

/**
 * Verifies one heartbeat retained the exact fenced identity.
 *
 * @param successor - Durable heartbeat successor.
 * @param claim - Stable identity owned by the supervisor.
 * @returns Detached successor lease retaining the exact fenced identity.
 */
function requireHeartbeatSuccess(
  successor: WorkspaceSearchMigrationLease,
  claim: WorkspaceSearchMigrationHeartbeatLeaseClaim,
): WorkspaceSearchMigrationLease {
  validateWorkspaceSearchMigrationLease(successor)
  if (
    successor.runId !== claim.runId ||
    successor.ownerId !== claim.ownerId ||
    successor.fenceToken !== claim.fenceToken
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Migration heartbeat returned a different lease identity.',
    )
  }
  return detachLease(successor)
}

/**
 * Computes the next one-shot delay from the durable heartbeat time.
 *
 * Scheduling from the returned durable successor avoids accumulating network
 * latency or event-loop drift across a long-running operation.
 *
 * @param lease - Latest durable lease returned by acquisition or heartbeat.
 * @param clock - Trusted process wall clock.
 * @returns Non-negative delay until the one-third-lease heartbeat point.
 */
function createNextHeartbeatDelay(
  lease: WorkspaceSearchMigrationLease,
  clock: WorkspaceSearchMigrationHeartbeatClock,
): number {
  const now = readHeartbeatClock(clock)
  const dueAt =
    Date.parse(lease.heartbeatAt) +
    WORKSPACE_SEARCH_MIGRATION_HEARTBEAT_INTERVAL_MILLISECONDS
  return Math.min(
    WORKSPACE_SEARCH_MIGRATION_HEARTBEAT_INTERVAL_MILLISECONDS,
    Math.max(0, dueAt - now),
  )
}

/**
 * Requires enough initial headroom to begin a supervised operation.
 *
 * @param lease - Initial durable lease.
 * @param clock - Trusted process wall clock.
 */
function requireLeaseCommitHeadroom(
  lease: WorkspaceSearchMigrationLease,
  clock: WorkspaceSearchMigrationHeartbeatClock,
): void {
  const now = readHeartbeatClock(clock)
  if (
    now + WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS >=
      Date.parse(lease.expiresAt)
  ) {
    throw new WorkspaceSearchMigrationFailure(
      'LEASE_LOST',
      'Migration lease lacks the required supervised work window.',
    )
  }
}

/**
 * Reads one valid wall-clock value.
 *
 * @param clock - Injectable clock.
 * @returns Finite epoch milliseconds.
 */
function readHeartbeatClock(
  clock: WorkspaceSearchMigrationHeartbeatClock,
): number {
  let value: Date
  try {
    value = clock()
  } catch {
    throw createHeartbeatFailure()
  }
  const epochMilliseconds = value.getTime()
  if (!Number.isFinite(epochMilliseconds)) {
    throw createHeartbeatFailure()
  }
  return epochMilliseconds
}

/**
 * Detaches one lease from caller-owned mutable storage.
 *
 * @param lease - Validated durable lease.
 * @returns Explicit detached lease copy.
 */
function detachLease(
  lease: WorkspaceSearchMigrationLease,
): WorkspaceSearchMigrationLease {
  validateWorkspaceSearchMigrationLease(lease)
  return {
    runId: lease.runId,
    ownerId: lease.ownerId,
    fenceToken: lease.fenceToken,
    expiresAt: lease.expiresAt,
    heartbeatAt: lease.heartbeatAt,
  }
}

/**
 * Converts an untrusted heartbeat exception to the closed migration vocabulary.
 *
 * @param error - Caught heartbeat failure.
 * @returns Existing trusted failure or a redacted transient failure.
 */
function classifyHeartbeatFailure(
  error: unknown,
): WorkspaceSearchMigrationFailure {
  if (error instanceof WorkspaceSearchMigrationFailure) {
    return error
  }
  return createHeartbeatFailure()
}

/**
 * Creates one raw-value-free fallback heartbeat failure.
 *
 * @returns Stable transient-infrastructure failure.
 */
function createHeartbeatFailure(): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    'TRANSIENT_INFRASTRUCTURE_FAILURE',
    'Migration lease heartbeat failed.',
  )
}
