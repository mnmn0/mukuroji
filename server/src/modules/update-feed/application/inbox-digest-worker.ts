import { deliverInboxDigest, inboxDigestTerminalReason, type InboxDigestCandidate, type InboxDigestDependencies, type InboxDigestRecipient, type InboxDigestRetry } from './inbox-digest'
import { PlanningError } from '../../planning'

/** Bounded retry, including failures before a delivery claim exists. */
export type InboxDigestPending = {
  /** Reauthorized destination. */ recipient: InboxDigestRecipient
  /** Prior worker failures, zero through two. */ attempts: number
  /** Original trusted scheduling time; absent only on legacy checkpoint rows. */ scheduledAt?: number
  /** Discovery cadence; legacy work without it is cancelled, never backdated. */ frequency?: InboxDigestCandidate['frequency']
  /** Page-local conflict deferrals, independent of infrastructure attempts. */ conflicts?: number
}

/** Atomic movement between a page and durable per-recipient deferred work. */
export type InboxDigestSettlement = {
  /** Park a blocked interval or remove its parked record after acknowledgment. */ kind: 'park' | 'finish'
  /** Owner and original logical attempt metadata. */ item: InboxDigestPending
}

/** One durable shard checkpoint; pending recipients are written before any delivery. */
export type InboxDigestCheckpoint = {
  /** Fixed queue shard, zero through fifteen. */ shard: number
  /** Compare-and-swap version. */ revision: number
  /** Current worker fencing token. */ token: string
  /** Exclusive worker lease deadline. */ leaseUntil: number
  /** Earliest next claim, used for bounded retry backoff. */ retryAt: number
  /** Candidate-source continuation, advanced only with persisted pending work. */ cursor?: string
  /** Current page's not-yet-acknowledged recipients, at most twenty. */ pending: InboxDigestPending[]
}

/** Durable checkpoint operations fence duplicate batches and stale workers. */
export interface InboxDigestCheckpointStore {
  /** Durably advances the first shard before work, independent of invocation cadence. */
  reserveStartShard(): Promise<number>
  /** Claims an idle or expired shard; locked/backing-off shards return undefined. */
  claim(shard: number, now: number): Promise<InboxDigestCheckpoint | undefined>
  /** Reads a parked interval consistently before re-admitting its due recipient. */
  readDeferred(recipient: InboxDigestRecipient): Promise<InboxDigestPending | undefined>
  /** Saves only the current unexpired token/revision, incrementing revision. */
  save(state: InboxDigestCheckpoint, now: number, release: boolean, failure?: InboxDigestRecipient, settlement?: InboxDigestSettlement): Promise<InboxDigestCheckpoint>
}

/** Current candidate source with bounded opaque continuation. */
export type InboxDigestWorkerDependencies = {
  /** Durable shard leases and pending pages. */ checkpoints: InboxDigestCheckpointStore
  /** Strongly rechecked due candidates, at most twenty per call. */
  listDue(shard: number, cursor: string | undefined, limit: number): Promise<{ /** Due recipients with strongly checked cadence and any unfinished interval. */ recipients: (InboxDigestCandidate | InboxDigestRetry)[]; /** Explicit continuation. */ cursor?: string }>
  /** Current recipient authorization and atomic delivery. */ delivery: InboxDigestDependencies
  /** Trusted clock. */ now(): number
}

/** Processes one bounded shard with crash-safe page ownership and retry preservation.
 * @param dependencies - Current authorization, candidate reads and durable checkpoints.
 * @param shard - Fixed shard selected by the scheduler.
 * @param deadline - Invocation admission deadline, also bounding recipient starts.
 * @returns Safe counts; failures remain durably pending for the next invocation.
 */
export async function runInboxDigestWorker(dependencies: InboxDigestWorkerDependencies, shard: number, deadline = Infinity) {
  let state = await dependencies.checkpoints.claim(shard, dependencies.now())
  if (!state) return { processed: 0, delivered: 0, failed: 0, deferred: 0 }
  const result = { processed: 0, delivered: 0, failed: 0, deferred: 0 }
  if (state.pending.length < 20) {
    const limit = 20 - state.pending.length
    const page = await dependencies.listDue(shard, state.cursor, limit)
    if (page.recipients.length > limit || (page.cursor !== undefined && page.cursor === state.cursor)) throw new Error('Invalid digest continuation')
    const unique = new Map(state.pending.map((item) => [JSON.stringify(item.recipient), item]))
    for (const candidate of page.recipients) {
      const recipient = { workspaceId: candidate.workspaceId, memberKey: candidate.memberKey }
      if (unique.has(JSON.stringify(recipient))) continue
      const parked = await dependencies.checkpoints.readDeferred(recipient)
      unique.set(JSON.stringify(recipient), parked ? { ...parked, conflicts: 0 } : { recipient, attempts: 0, scheduledAt: 'scheduledAt' in candidate ? candidate.scheduledAt : dependencies.now(), frequency: candidate.frequency })
    }
    state = await dependencies.checkpoints.save({ ...state, pending: [...unique.values()], cursor: page.cursor }, dependencies.now(), false)
  }
  // Upgrade legacy pending work once, durably, before its first delivery attempt.
  if (state.pending.some((item) => item.scheduledAt === undefined)) state = await dependencies.checkpoints.save({ ...state, pending: state.pending.map((item) => ({ ...item, scheduledAt: item.scheduledAt ?? dependencies.now() })) }, dependencies.now(), false)
  // Never repeat failed recipients within the same invocation.
  const batch = [...state.pending]
  for (const item of batch) {
    const { recipient } = item
    if (dependencies.now() + 5_000 >= Math.min(state.leaseUntil, deadline)) break
    let retry = false
    let permanent = false
    let conflict = false
    try {
      // Legacy work cannot prove its original cadence. Acknowledge cancellation;
      // subsequent strongly checked discovery may bind current consent afresh.
      if (item.frequency && await deliverInboxDigest(dependencies.delivery, recipient, dependencies.now(), item.scheduledAt, item.frequency) === 'delivered') result.delivered++
    } catch (error) {
      // Exhausted intervals advance through the due index. Permanent storage or
      // identity failures require durable inspection evidence without more retries.
      const terminal = inboxDigestTerminalReason(error)
      conflict = error instanceof PlanningError && error.code === 'UpdateFeedDigestConflict'
      retry = terminal === undefined && !conflict
      permanent = terminal !== undefined && terminal !== 'exhausted'
      if (conflict) result.deferred++
      else result.failed++
    }
    result.processed++
    const remaining = state.pending.filter((item) => item.recipient.workspaceId !== recipient.workspaceId || item.recipient.memberKey !== recipient.memberKey)
    const exhausted = retry && item.attempts >= 2
    const park = conflict && (item.conflicts ?? 0) >= 2
    const pending = conflict && !park ? [...remaining, { ...item, conflicts: (item.conflicts ?? 0) + 1 }] : retry && !exhausted ? [...remaining, { ...item, attempts: item.attempts + 1 }] : remaining
    const settlement: InboxDigestSettlement | undefined = park ? { kind: 'park', item } : !conflict && (!retry || exhausted) ? { kind: 'finish', item } : undefined
    state = await dependencies.checkpoints.save({ ...state, pending }, dependencies.now(), false, exhausted || permanent ? recipient : undefined, settlement)
  }
  await dependencies.checkpoints.save({ ...state, retryAt: result.failed || result.deferred ? dependencies.now() + 60_000 : 0 }, dependencies.now(), true)
  return result
}

/** Starts from a durably rotating shard and admits bounded work for 150 seconds.
 * @param dependencies - Durable scheduling, recipient authorization and trusted clock.
 * @returns Aggregate counts; unfinished pages remain in their shard checkpoints.
 */
export async function runInboxDigestWorkerInvocation(dependencies: InboxDigestWorkerDependencies) {
  const deadline = dependencies.now() + 150_000
  const first = await dependencies.checkpoints.reserveStartShard()
  const result = { processed: 0, delivered: 0, failed: 0, deferred: 0 }
  for (let offset = 0; offset < 16 && dependencies.now() + 5_000 < deadline; offset++) {
    const progress = await runInboxDigestWorker(dependencies, (first + offset) % 16, deadline)
    result.processed += progress.processed
    result.delivered += progress.delivered
    result.failed += progress.failed
    result.deferred += progress.deferred
  }
  return result
}
