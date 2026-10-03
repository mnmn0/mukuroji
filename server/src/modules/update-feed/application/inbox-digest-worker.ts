import { deliverInboxDigest, inboxDigestTerminalReason, type InboxDigestDependencies, type InboxDigestRecipient } from './inbox-digest'

/** Bounded retry, including failures before a delivery claim exists. */
export type InboxDigestPending = {
  /** Reauthorized destination. */ recipient: InboxDigestRecipient
  /** Prior worker failures, zero through two. */ attempts: number
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
  /** Claims an idle or expired shard; locked/backing-off shards return undefined. */
  claim(shard: number, now: number): Promise<InboxDigestCheckpoint | undefined>
  /** Saves only the current unexpired token/revision, incrementing revision. */
  save(state: InboxDigestCheckpoint, now: number, release: boolean, failure?: InboxDigestRecipient): Promise<InboxDigestCheckpoint>
}

/** Current candidate source with bounded opaque continuation. */
export type InboxDigestWorkerDependencies = {
  /** Durable shard leases and pending pages. */ checkpoints: InboxDigestCheckpointStore
  /** Strongly rechecked due candidates, at most twenty per call. */
  listDue(shard: number, cursor: string | undefined, limit: number): Promise<{ /** Due recipients. */ recipients: InboxDigestRecipient[]; /** Explicit continuation. */ cursor?: string }>
  /** Current recipient authorization and atomic delivery. */ delivery: InboxDigestDependencies
  /** Trusted clock. */ now(): number
}

/** Processes one bounded shard with crash-safe page ownership and retry preservation.
 * @param dependencies - Current authorization, candidate reads and durable checkpoints.
 * @param shard - Fixed shard selected by the scheduler.
 * @returns Safe counts; failures remain durably pending for the next invocation.
 */
export async function runInboxDigestWorker(dependencies: InboxDigestWorkerDependencies, shard: number) {
  let state = await dependencies.checkpoints.claim(shard, dependencies.now())
  if (!state) return { processed: 0, delivered: 0, failed: 0 }
  const result = { processed: 0, delivered: 0, failed: 0 }
  if (state.pending.length < 20) {
    const limit = 20 - state.pending.length
    const page = await dependencies.listDue(shard, state.cursor, limit)
    if (page.recipients.length > limit || (page.cursor !== undefined && page.cursor === state.cursor)) throw new Error('Invalid digest continuation')
    const unique = new Map(state.pending.map((item) => [JSON.stringify(item.recipient), item]))
    for (const recipient of page.recipients) if (!unique.has(JSON.stringify(recipient))) unique.set(JSON.stringify(recipient), { recipient, attempts: 0 })
    state = await dependencies.checkpoints.save({ ...state, pending: [...unique.values()], cursor: page.cursor }, dependencies.now(), false)
  }
  // Never repeat failed recipients within the same invocation.
  const batch = [...state.pending]
  for (const item of batch) {
    const { recipient } = item
    if (dependencies.now() + 5_000 >= state.leaseUntil) break
    let retry = false
    let permanent = false
    try {
      if (await deliverInboxDigest(dependencies.delivery, recipient, dependencies.now()) === 'delivered') result.delivered++
    } catch (error) {
      // Exhausted intervals advance through the due index. Permanent storage or
      // identity failures require durable inspection evidence without more retries.
      const terminal = inboxDigestTerminalReason(error)
      retry = terminal === undefined
      permanent = terminal !== undefined && terminal !== 'exhausted'
      result.failed++
    }
    result.processed++
    const remaining = state.pending.filter((item) => item.recipient.workspaceId !== recipient.workspaceId || item.recipient.memberKey !== recipient.memberKey)
    const exhausted = retry && item.attempts >= 2
    state = await dependencies.checkpoints.save({ ...state, pending: retry && !exhausted ? [...remaining, { recipient, attempts: item.attempts + 1 }] : remaining }, dependencies.now(), false, exhausted || permanent ? recipient : undefined)
  }
  await dependencies.checkpoints.save({ ...state, retryAt: result.failed ? dependencies.now() + 60_000 : 0 }, dependencies.now(), true)
  return result
}
